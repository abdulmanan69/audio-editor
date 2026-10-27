// Playback engine: per-track gain/pan graph into a metered master bus, plus offline
// rendering (mixdown, resampling) that uses the same per-track chain as live playback.
import { Emitter } from '../core/events.js';
import { AudioData, toAudioBuffer, padEnd } from '../core/audio-data.js';
import { dbToGain } from '../core/format.js';

const Ctx = self.AudioContext || self.webkitAudioContext;
const OfflineCtx = self.OfflineAudioContext || self.webkitOfflineAudioContext;

export const isAudible = (t, tracks) => !t.mute && (!tracks.some(x => x.solo) || t.solo);

// Mono tracks use a balance law (centre = full level on both sides, panning only attenuates
// the opposite side) so a mono recording plays and exports at its true level. Multichannel
// tracks go through a StereoPanner, which passes stereo through untouched at centre.
function trackChain(c, track, dest) {
  const gain = c.createGain();
  if (track.audio.numberOfChannels === 1) {
    const gl = c.createGain(), gr = c.createGain(), merge = c.createChannelMerger(2);
    gain.connect(gl); gain.connect(gr);
    gl.connect(merge, 0, 0); gr.connect(merge, 0, 1);
    merge.connect(dest);
    const setPan = (p, t) => {
      const l = p > 0 ? 1 - p : 1, r = p < 0 ? 1 + p : 1;
      if (t == null) { gl.gain.value = l; gr.gain.value = r; }
      else { gl.gain.setTargetAtTime(l, t, 0.01); gr.gain.setTargetAtTime(r, t, 0.01); }
    };
    return { gain, setPan, nodes: [gain, gl, gr, merge] };
  }
  const pan = c.createStereoPanner();
  gain.connect(pan); pan.connect(dest);
  const setPan = (p, t) => { if (t == null) pan.pan.value = p; else pan.pan.setTargetAtTime(p, t, 0.01); };
  return { gain, setPan, nodes: [gain, pan] };
}

export class Engine extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.ctx = null;
    this.playing = false;
    this.rate = 1;
    this.masterDb = 0;
    this.nodes = new Map();
    this.startPos = 0;
    this.startTime = 0;
    this.loop = null;
    this.stopAt = Infinity;
    this.preview = null;
  }

  ensureContext() {
    const sr = this.app.sampleRate;
    if (!Ctx) throw new Error('This browser does not support the Web Audio API.');
    if (!this.ctx || this.ctx.sampleRate !== sr || this.ctx.state === 'closed') {
      if (this.ctx) this.ctx.close().catch(() => {});
      try { this.ctx = new Ctx({ sampleRate: sr, latencyHint: 'interactive' }); }
      catch { this.ctx = new Ctx({ latencyHint: 'interactive' }); }
      const c = this.ctx;
      this.master = c.createGain();
      this.master.gain.value = dbToGain(this.masterDb);
      this.splitter = c.createChannelSplitter(2);
      this.analysers = [c.createAnalyser(), c.createAnalyser()];
      this.analysers.forEach(a => { a.fftSize = 2048; a.smoothingTimeConstant = 0; });
      this.spectrum = c.createAnalyser();
      this.spectrum.fftSize = 4096;
      this.spectrum.smoothingTimeConstant = 0.6;
      this.spectrum.minDecibels = -110;
      this.spectrum.maxDecibels = 0;
      this.master.connect(c.destination);
      this.master.connect(this.splitter);
      this.master.connect(this.spectrum);
      this.splitter.connect(this.analysers[0], 0);
      this.splitter.connect(this.analysers[1], 1);
      this.timeBuf = new Float32Array(2048);
      this.freqBuf = new Float32Array(this.spectrum.frequencyBinCount);
      this.emit('context', c);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  get position() {
    if (!this.playing) return this.startPos;
    let pos = this.startPos + Math.max(0, this.ctx.currentTime - this.startTime) * this.rate;
    if (this.loop && pos >= this.loop.end) {
      const len = this.loop.end - this.loop.start;
      pos = this.loop.start + ((pos - this.loop.end) % len);
    }
    return pos;
  }

  play(from, { to = Infinity, loop = null } = {}) {
    this.stopSources();
    this.stopPreview();
    const c = this.ensureContext();
    const when = c.currentTime + 0.03;
    if (loop && loop.end - loop.start < 0.01) loop = null;
    for (const t of this.app.tracks) {
      if (!t.audio.length || t.recording) continue;
      let audio = t.audio;
      // Pad short tracks so every source's loop points line up.
      if (loop && audio.duration < loop.end) audio = padEnd(audio, Math.ceil(loop.end * audio.sampleRate) + 1);
      const src = c.createBufferSource();
      src.buffer = toAudioBuffer(audio, c);
      src.playbackRate.value = this.rate;
      if (loop) { src.loop = true; src.loopStart = loop.start; src.loopEnd = loop.end; }
      const chain = trackChain(c, t, this.master);
      src.connect(chain.gain);
      if (from < audio.duration) src.start(when, Math.max(0, from));
      this.nodes.set(t.id, { src, chain });
    }
    this.startPos = from;
    this.startTime = when;
    this.loop = loop;
    this.stopAt = loop ? Infinity : to;
    this.playing = true;
    this.updateMix(true);
    this.emit('state');
  }

  // Called each animation frame by the app; ends playback at the stop point.
  tick() {
    if (!this.playing || this.loop) return;
    const end = Math.min(this.stopAt, this.app.recording ? Infinity : this.app.duration);
    if (this.position >= end) this.stop(end);
  }

  stopSources() {
    for (const { src, chain } of this.nodes.values()) {
      try { src.stop(); } catch { /* not started */ }
      src.disconnect();
      chain.nodes.forEach(n => n.disconnect());
    }
    this.nodes.clear();
  }

  stop(at) {
    const pos = at ?? this.position;
    this.stopSources();
    const was = this.playing;
    this.playing = false;
    this.startPos = pos;
    this.loop = null;
    if (was) this.emit('state');
    return pos;
  }

  updateMix(immediate = false) {
    if (!this.ctx) return;
    const tracks = this.app.tracks;
    const now = immediate ? null : this.ctx.currentTime;
    for (const t of tracks) {
      const n = this.nodes.get(t.id);
      if (!n) continue;
      const g = isAudible(t, tracks) ? dbToGain(t.gain) : 0;
      if (now == null) n.chain.gain.gain.value = g; else n.chain.gain.gain.setTargetAtTime(g, now, 0.01);
      n.chain.setPan(t.pan, now);
    }
  }

  setRate(rate) {
    if (this.playing) {
      this.startPos = this.position;
      this.startTime = this.ctx.currentTime;
    }
    this.rate = rate;
    for (const { src } of this.nodes.values()) src.playbackRate.setValueAtTime(rate, this.ctx.currentTime);
    if (this.preview) this.preview.playbackRate.value = rate;
  }

  setMasterDb(db) {
    this.masterDb = db;
    if (this.master) this.master.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01);
  }

  // Audition processed audio (effect previews) through the master bus.
  playPreview(audio) {
    if (this.playing) this.stop();
    this.stopPreview();
    const c = this.ensureContext();
    const src = c.createBufferSource();
    src.buffer = toAudioBuffer(audio, c);
    src.playbackRate.value = this.rate;
    if (audio.numberOfChannels === 1) {
      const merge = c.createChannelMerger(2);
      src.connect(merge, 0, 0); src.connect(merge, 0, 1); merge.connect(this.master);
    } else src.connect(this.master);
    src.start();
    this.preview = src;
    this.emit('preview', true);
    return new Promise(resolve => {
      src.onended = () => { if (this.preview === src) { this.preview = null; this.emit('preview', false); } resolve(); };
    });
  }

  stopPreview() {
    if (!this.preview) return;
    const p = this.preview;
    this.preview = null;
    try { p.stop(); } catch { /* already ended */ }
    p.disconnect();
    this.emit('preview', false);
  }

  levels() {
    if (!this.ctx || !this.analysers) return null;
    const out = { peak: [0, 0], rms: [0, 0] };
    this.analysers.forEach((a, c) => {
      a.getFloatTimeDomainData(this.timeBuf);
      let p = 0, s = 0;
      for (let i = 0; i < this.timeBuf.length; i++) { const v = this.timeBuf[i]; const av = v < 0 ? -v : v; if (av > p) p = av; s += v * v; }
      out.peak[c] = p; out.rms[c] = Math.sqrt(s / this.timeBuf.length);
    });
    return out;
  }

  spectrumData() {
    if (!this.spectrum) return null;
    this.spectrum.getFloatFrequencyData(this.freqBuf);
    return this.freqBuf;
  }
}

// Render the mix of `tracks` over [start, end) seconds exactly as the live graph plays it.
export async function renderMix(tracks, { start = 0, end, sampleRate, channels } = {}) {
  if (!OfflineCtx) throw new Error('This browser cannot render audio offline.');
  const live = tracks.filter(t => isAudible(t, tracks) && t.audio.length);
  const srcRate = tracks[0]?.audio.sampleRate || 48000;
  const outRate = sampleRate || srcRate;
  const stop = end ?? Math.max(0, ...tracks.map(t => t.audio.duration));
  const dur = Math.max(1 / outRate, stop - start);
  const length = Math.max(1, Math.round(dur * outRate));
  const stereo = live.some(t => t.audio.numberOfChannels > 1 || Math.abs(t.pan) > 1e-3);
  const nch = channels || (stereo ? 2 : 1);
  const c = new OfflineCtx(Math.max(nch, 2), length, outRate);
  for (const t of live) {
    if (start >= t.audio.duration) continue;
    const src = c.createBufferSource();
    src.buffer = toAudioBuffer(t.audio, c);
    const chain = trackChain(c, t, c.destination);
    chain.gain.gain.value = dbToGain(t.gain);
    chain.setPan(t.pan);
    src.connect(chain.gain);
    src.start(0, start, dur);
  }
  const mixed = AudioData.fromAudioBuffer(await c.startRendering());
  if (nch === 1) {
    // Centred mono material is identical on both sides; keep one channel.
    return new AudioData([stereo ? averageChannels(mixed) : mixed.channels[0]], outRate);
  }
  return mixed;
}

function averageChannels(a) {
  const out = new Float32Array(a.length);
  const [L, R] = a.channels;
  for (let i = 0; i < out.length; i++) out[i] = (L[i] + R[i]) * 0.5;
  return out;
}

export async function resampleAudio(audio, rate) {
  if (audio.sampleRate === rate) return audio;
  if (!OfflineCtx) throw new Error('This browser cannot resample audio.');
  const length = Math.max(1, Math.round(audio.duration * rate));
  const c = new OfflineCtx(audio.numberOfChannels, length, rate);
  const src = c.createBufferSource();
  src.buffer = toAudioBuffer(audio, c);
  src.connect(c.destination);
  src.start();
  return AudioData.fromAudioBuffer(await c.startRendering());
}
