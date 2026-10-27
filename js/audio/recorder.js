// Microphone / line-in capture through an AudioWorklet into growable Float32 buffers.
import { Emitter } from '../core/events.js';
import { AudioData, createPeaks, updatePeaks, registerPeaks } from '../core/audio-data.js';

export class Recorder extends Emitter {
  constructor(engine) {
    super();
    this.engine = engine;
    this.active = false;
    this.moduleLoaded = null;
  }

  static async listInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'audioinput');
  }

  async start({ deviceId } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Recording needs a secure (HTTPS) page and a browser with microphone access.');
    const ctx = this.engine.ensureContext();
    if (!ctx.audioWorklet) throw new Error('This browser does not support AudioWorklet recording.');
    if (!this.moduleLoaded || this.moduleCtx !== ctx) {
      this.moduleCtx = ctx;
      this.moduleLoaded = ctx.audioWorklet.addModule(new URL('../worklets/recorder-worklet.js', import.meta.url));
    }
    await this.moduleLoaded;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          channelCount: { ideal: 2 },
        },
      });
    } catch (err) {
      if (err.name === 'NotAllowedError') throw new Error('Microphone access was blocked. Allow it in the browser’s site settings, then press Record again.');
      if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') throw new Error('No microphone was found. Connect an input device or pick another one in Settings.');
      throw err;
    }
    const settings = stream.getAudioTracks()[0]?.getSettings?.() || {};
    const nch = Math.min(2, Math.max(1, settings.channelCount || 1));
    this.stream = stream;
    this.source = ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(ctx, 'kerf-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: nch, channelCountMode: 'explicit', processorOptions: { channels: nch },
    });
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.node);
    this.source.connect(this.analyser);
    this.node.connect(this.sink);
    this.sink.connect(ctx.destination);

    this.nch = nch;
    this.sampleRate = ctx.sampleRate;
    this.capacity = ctx.sampleRate * 30;
    this.buffers = Array.from({ length: nch }, () => new Float32Array(this.capacity));
    this.length = 0;
    this.peaks = Array.from({ length: nch }, () => createPeaks(Math.ceil(this.capacity / 256)));
    this.levelBuf = new Float32Array(2048);
    this.label = stream.getAudioTracks()[0]?.label || 'Microphone';
    this.node.port.onmessage = (e) => { if (e.data.chunk) this.append(e.data.chunk); if (e.data.stopped) this.emit('flushed'); };
    this.active = true;
    this.emit('start');
  }

  append(chunk) {
    const n = chunk[0].length;
    if (this.length + n > this.capacity) {
      this.capacity = Math.max(this.capacity * 2, this.length + n);
      this.buffers = this.buffers.map(b => { const g = new Float32Array(this.capacity); g.set(b.subarray(0, this.length)); return g; });
    }
    for (let c = 0; c < this.nch; c++) this.buffers[c].set(chunk[c] || chunk[0], this.length);
    this.length += n;
  }

  // Snapshot of what's been captured so far, with peaks updated incrementally for drawing.
  current() {
    const chans = this.buffers.map((b, c) => {
      const view = b.subarray(0, this.length);
      updatePeaks(this.peaks[c], view, Math.max(0, this.peaks[c].count - 1) * 256);
      registerPeaks(view, this.peaks[c]);
      return view;
    });
    return new AudioData(chans, this.sampleRate);
  }

  inputLevel() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let p = 0;
    for (let i = 0; i < this.levelBuf.length; i++) { const v = Math.abs(this.levelBuf[i]); if (v > p) p = v; }
    return p;
  }

  async stop() {
    if (!this.active) return null;
    const flushed = new Promise(r => { this.once = this.on('flushed', r); setTimeout(r, 400); });
    this.node.port.postMessage('stop');
    await flushed;
    this.active = false;
    this.stream.getTracks().forEach(t => t.stop());
    this.source.disconnect(); this.node.disconnect(); this.sink.disconnect(); this.analyser.disconnect();
    const out = new AudioData(this.buffers.map(b => b.slice(0, this.length)), this.sampleRate);
    this.buffers = null;
    this.emit('stop');
    return out;
  }
}
