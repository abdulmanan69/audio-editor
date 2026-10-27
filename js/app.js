// Application controller: project state, edit operations, transport, recording,
// persistence, and the glue between the view components.
import { AudioData, slice, splice, insertAt, processRange, concat, matchChannels } from './core/audio-data.js';
import { History } from './core/history.js';
import { settings, local } from './core/settings.js';
import { store } from './core/store.js';
import { Emitter } from './core/events.js';
import { uid, clamp, formatTime, parseTime, formatDuration, formatRate, debounce, nextFrame, downloadBlob, sanitizeFilename, stripExtension } from './core/format.js';
import { Engine, renderMix, resampleAudio, isAudible } from './audio/engine.js';
import { Recorder } from './audio/recorder.js';
import { EFFECTS, effectById, runEffect } from './dsp/effects.js';
import { GENERATORS, generatorById, bleep as makeBleep, demoTracks } from './dsp/generators.js';
import { captureNoiseProfile } from './dsp/restoration.js';
import { findClipping, findSilence, nearestZeroCrossing } from './dsp/analysis.js';
import { decodeFile, isAudioFile } from './io/importer.js';
import { saveProjectFile, loadProjectFile, toAutosave, fromAutosave } from './io/project.js';
import { toAudacityLabels, toCsv, parseLabels } from './io/labels.js';
import { createCommands } from './commands.js';
import { Timeline } from './ui/timeline.js';
import { SidePanel } from './ui/sidepanel.js';
import { MenuBar, showMenu } from './ui/menu.js';
import { VFD } from './ui/vfd.js';
import { LevelMeter } from './ui/meters.js';
import { openPalette } from './ui/palette.js';
import { toast, toastError } from './ui/toast.js';
import { confirmDialog, promptDialog } from './ui/dialog.js';
import { $, pickFiles } from './ui/dom.js';
import { setIcon } from './ui/icons.js';
import * as dialogs from './ui/dialogs.js';
import { openExportDialog } from './ui/export.js';
import { openBatchDialog, openChainDialog } from './ui/batch.js';

export const VERSION = '1.0.0';

export class App extends Emitter {
  constructor() {
    super();
    this.settings = settings;
    this.sampleRate = settings.get('sampleRate');
    this.name = 'Untitled project';
    this.tracks = [];
    this.markers = [];
    this.selection = { start: 0, end: 0 };
    this.view = { scroll: 0, pxPerSec: 100, vzoom: 1 };
    this.clipboard = null;
    this.noiseProfile = null;
    this.lastEffect = null;
    this.loop = false;
    this.playhead = 0;
    this.colorCounter = 0;
    this.history = new History(settings.get('historyLimit'));
    this.engine = new Engine(this);
    this.recorder = new Recorder(this.engine);
    this.recording = null;
    this.dirty = false;
    this.installPrompt = null;
    this.commands = createCommands(this);
    this.scheduleAutosave = debounce(() => this.autosave(), 1500);
    this.scheduleQuickStats = debounce(() => this.sidepanel?.updateQuickStats(), 350);
  }

  // ---------- startup ----------
  async start() {
    this.timeline = new Timeline(this);
    this.sidepanel = new SidePanel(this);
    this.vfd = new VFD($('#vfd-main'));
    this.meter = new LevelMeter($('#meter-canvas'), $('.meter-readout'));
    this.buildMenus();
    this.bindChrome();
    this.history.on('change', () => { this.sidepanel.renderHistory(); this.updateToolbar(); });
    this.engine.on('state', () => { this.updateToolbar(); this.startLoop(); });
    this.engine.on('preview', () => this.startLoop());
    settings.on('change', ({ key }) => this.onSetting(key));
    this.applyTheme();
    this.history.reset('New project', this.snapshot());
    await this.restoreAutosave();
    this.tracksChanged();
    this.emitSelection();
    this.updateSaveState();
    this.meter.draw();
    this.startLoop();
  }

  // ---------- derived state ----------
  get duration() { return this.tracks.reduce((m, t) => Math.max(m, t.audio.duration + (t.offset || 0)), 0); }
  get hasRange() { return this.tracks.length > 0 && this.selection.end - this.selection.start > 1e-6; }
  get targets() { const s = this.tracks.filter(t => t.selected); return s.length ? s : this.tracks; }
  get playheadTime() { return this.engine.playing ? this.engine.position : this.playhead; }
  get settingsShowRms() { return settings.get('showRms'); }
  trackById(id) { return this.tracks.find(t => t.id === id); }
  isAudible(t) { return isAudible(t, this.tracks); }
  fmt(t) { return formatTime(t, settings.get('timeFormat'), this.sampleRate); }

  rangeSamples(t) {
    const sr = t.audio.sampleRate, len = t.audio.length;
    let s = Math.round(this.selection.start * sr), e = Math.round(this.selection.end * sr);
    if (settings.get('snapZero') && e > s && len) {
      const r = Math.round(sr * 0.01);
      s = nearestZeroCrossing(t.audio, Math.min(s, len - 1), r);
      e = nearestZeroCrossing(t.audio, Math.min(e, len - 1), r);
    }
    return [clamp(s, 0, len), clamp(e, 0, len)];
  }

  makeTrack({ name, audio, colorIndex }) {
    return {
      id: uid('trk'), name, audio, colorIndex: colorIndex ?? (this.colorCounter++ % 8),
      gain: 0, pan: 0, mute: false, solo: false, selected: false,
      height: settings.get('trackHeight'), view: 'waveform',
    };
  }

  // ---------- history ----------
  snapshot() {
    return {
      tracks: this.tracks.map(t => ({ id: t.id, name: t.name, colorIndex: t.colorIndex, audio: t.audio, gain: t.gain, pan: t.pan, mute: t.mute, solo: t.solo, height: t.height, view: t.view })),
      markers: this.markers.map(m => ({ ...m })),
      selection: { ...this.selection },
      sampleRate: this.sampleRate,
    };
  }

  restore(snap) {
    if (this.engine.playing) this.stop();
    const current = new Map(this.tracks.map(t => [t.id, t]));
    // Mixer and view settings are live controls rather than edits, so they survive undo.
    this.tracks = snap.tracks.map(s => {
      const cur = current.get(s.id);
      return cur ? { ...s, gain: cur.gain, pan: cur.pan, mute: cur.mute, solo: cur.solo, height: cur.height, view: cur.view, selected: cur.selected } : { ...s, selected: false };
    });
    this.markers = snap.markers.map(m => ({ ...m }));
    this.selection = { ...snap.selection };
    this.sampleRate = snap.sampleRate;
    this.playhead = this.selection.start;
    this.tracksChanged();
    this.markersChanged();
    this.emitSelection();
    this.markDirty();
  }

  commit(label) {
    this.history.push(label, this.snapshot());
    this.markDirty();
  }

  undo() {
    const r = this.history.undo();
    if (r) { this.restore(r.snapshot); this.status(`Undid ${r.label}`); }
  }

  redo() {
    const r = this.history.redo();
    if (r) { this.restore(r.snapshot); this.status(`Redid ${r.label}`); }
  }

  historyJump(i) {
    const r = this.history.jump(i);
    if (r) { this.restore(r.snapshot); this.status(`Returned to “${r.label}”`); }
  }

  // ---------- change propagation ----------
  tracksChanged() {
    this.timeline.syncTracks();
    this.engine.updateMix();
    $('#empty-state').hidden = this.tracks.length > 0;
    this.updateToolbar();
    this.updateStatus();
    this.scheduleQuickStats();
  }

  trackHeaderChanged() {
    this.timeline.syncTracks();
    this.engine.updateMix();
  }

  markersChanged() {
    this.markers.sort((a, b) => a.time - b.time);
    this.sidepanel.renderMarkers();
    this.timeline.invalidate();
    this.updateToolbar();
  }

  markDirty() {
    this.dirty = true;
    this.updateSaveState();
    this.scheduleAutosave();
  }

  // ---------- selection ----------
  setSelection(start, end, { silent = false } = {}) {
    const s = Math.max(0, Math.min(start, end)), e = Math.max(0, Math.max(start, end));
    this.selection = { start: s, end: e };
    if (!silent) this.emitSelection();
  }

  emitSelection() {
    this.timeline.invalidate();
    this.updateSelectionFields();
    this.updateToolbar();
    this.updateVfd();
    this.scheduleQuickStats();
  }

  setCursor(t) {
    this.setSelection(t, t);
    this.seek(t);
  }

  seek(t) {
    t = Math.max(0, t);
    if (this.engine.playing && !this.recording) this.engine.play(t, this.playOptions(t));
    else this.playhead = t;
    this.timeline.invalidate('overview');
    this.timeline.updateOverlay();
    this.updateVfd();
  }

  selectionCommitted() {
    if (!this.engine.playing) this.playhead = this.selection.start;
    this.emitSelection();
  }

  clickTrack(id, { toggle = false, range = false } = {}) {
    const idx = this.tracks.findIndex(t => t.id === id);
    if (range && this.lastClickedTrack != null) {
      this.selectTrackRange(this.lastClickedTrack, idx);
    } else if (toggle) {
      const t = this.tracks[idx];
      t.selected = !t.selected;
    } else {
      this.tracks.forEach((t, i) => { t.selected = i === idx; });
    }
    this.lastClickedTrack = idx;
    this.trackHeaderChanged();
    this.timeline.invalidate();
    this.scheduleQuickStats();
  }

  selectTrackRange(i0, i1) {
    const lo = Math.min(i0, i1), hi = Math.max(i0, i1);
    let changed = false;
    this.tracks.forEach((t, i) => { const v = i >= lo && i <= hi; if (t.selected !== v) { t.selected = v; changed = true; } });
    if (changed) this.trackHeaderChanged();
  }

  selectAllTracks() { this.tracks.forEach(t => { t.selected = true; }); this.trackHeaderChanged(); }

  selectWholeTrack(id) {
    const t = this.trackById(id);
    this.tracks.forEach(x => { x.selected = x.id === id; });
    this.trackHeaderChanged();
    this.setSelection(0, t.audio.duration);
    this.selectionCommitted();
  }

  selectAll() {
    this.selectAllTracks();
    this.setSelection(0, this.duration);
    this.selectionCommitted();
  }

  selectNone() {
    this.tracks.forEach(t => { t.selected = false; });
    this.trackHeaderChanged();
    this.setSelection(this.selection.start, this.selection.start);
  }

  selectToStart() { this.setSelection(0, this.hasRange ? this.selection.end : this.selection.start); this.selectionCommitted(); }
  selectToEnd() { this.setSelection(this.selection.start, this.duration); this.selectionCommitted(); }

  stepTrack(d) {
    if (!this.tracks.length) return;
    const cur = this.tracks.findIndex(t => t.selected);
    const next = clamp((cur < 0 ? (d > 0 ? -1 : this.tracks.length) : cur) + d, 0, this.tracks.length - 1);
    this.clickTrack(this.tracks[next].id, {});
  }

  nudge(dir, extend = false) {
    const step = this.timeline.visibleDuration / 50;
    if (extend) {
      const s = this.selection;
      this.setSelection(s.start, Math.max(s.start, s.end + dir * step));
    } else {
      const t = Math.max(0, (this.hasRange ? (dir < 0 ? this.selection.start : this.selection.end) : this.selection.start) + dir * step);
      this.setCursor(t);
      this.timeline.ensureVisible(t);
    }
  }

  snapSelectionToZero() {
    const t = this.targets[0];
    if (!t) return;
    const sr = t.audio.sampleRate, r = Math.round(sr * 0.02), len = t.audio.length;
    if (!len) return;
    const s = nearestZeroCrossing(t.audio, Math.min(len - 1, Math.round(this.selection.start * sr)), r);
    const e = this.hasRange ? nearestZeroCrossing(t.audio, Math.min(len - 1, Math.round(this.selection.end * sr)), r) : s;
    this.setSelection(s / sr, e / sr);
    this.selectionCommitted();
    this.status('Snapped to the nearest zero crossings');
  }

  // ---------- transport ----------
  playOptions(from) {
    const sel = this.selection;
    if (this.hasRange && from >= sel.start && from < sel.end) {
      return this.loop ? { loop: { start: sel.start, end: sel.end } } : { to: sel.end };
    }
    return this.loop ? { loop: { start: 0, end: this.duration } } : {};
  }

  togglePlay() {
    if (this.recording) return this.stopRecording();
    if (this.engine.playing) { this.playhead = this.engine.stop(); this.updateVfd(); return; }
    this.play();
  }

  play() {
    if (!this.tracks.length) return;
    try {
      const sel = this.selection;
      let from = this.hasRange ? sel.start : this.playhead;
      if (!this.hasRange && from >= this.duration - 0.005) from = 0;
      this.engine.play(from, this.playOptions(from));
      this.meter.resetPeak();
    } catch (err) { toastError(err); }
  }

  stop() {
    if (this.recording) return this.stopRecording();
    this.engine.stop();
    this.engine.stopPreview();
    this.playhead = this.selection.start;
    this.timeline.updateOverlay();
    this.updateVfd();
  }

  stopOrClear() {
    if (this.engine.playing || this.recording || this.engine.preview) this.stop();
    else if (this.hasRange) this.setSelection(this.selection.start, this.selection.start);
  }

  goStart() { this.setCursor(0); this.timeline.ensureVisible(0); }
  goEnd() { const d = this.duration; this.setCursor(d); this.timeline.ensureVisible(d, 0.9); }

  toggleLoop() {
    this.loop = !this.loop;
    if (this.engine.playing) this.engine.play(this.engine.position, this.playOptions(this.engine.position));
    this.updateToolbar();
    this.status(this.loop ? 'Loop on — playback repeats the selection' : 'Loop off');
  }

  startLoop() {
    if (this.raf) return;
    const tick = () => {
      this.raf = 0;
      const active = this.frame();
      if (active) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  // One animation frame of transport, meters and recording display. Returns whether to continue.
  frame() {
    const e = this.engine;
    e.tick();
    const playing = e.playing || !!e.preview;
    if (e.playing) {
      const pos = e.position;
      if (settings.get('followPlayhead')) this.timeline.followPlayhead(pos);
      this.timeline.updateOverlay();
      this.timeline.invalidate('overview');
    }
    if (this.recording) {
      const now = performance.now();
      if (now - (this.lastRecDraw || 0) > 120) {
        this.lastRecDraw = now;
        const t = this.recording.track;
        t.audio = this.recorder.current();
        this.timeline.invalidateTrack(t.id);
        const end = this.recording.at + t.audio.duration;
        if (settings.get('followPlayhead')) this.timeline.followPlayhead(end);
        this.recording.pos = end;
      }
      this.timeline.updateOverlay();
    }
    this.updateVfd();
    let metering = false;
    if (this.recording) {
      const p = this.recorder.inputLevel();
      this.meter.update([p, p], [p, p]);
      metering = true;
    } else if (playing) {
      const l = e.levels();
      if (l) this.meter.update(l.peak, l.rms);
      metering = true;
    } else metering = this.meter.decay();
    if (this.sidepanel.analyzeVisible) {
      this.sidepanel.drawSpectrum(playing ? e.spectrumData() : null, e.ctx?.sampleRate || this.sampleRate);
    }
    return playing || !!this.recording || metering;
  }

  // ---------- recording ----------
  async toggleRecord() {
    if (this.recording) return this.stopRecording();
    if (this.engine.playing) this.engine.stop();
    const at = this.selection.start;
    try {
      await this.recorder.start({ deviceId: settings.get('inputDevice') || undefined });
    } catch (err) { return toastError(err); }
    if (this.recorder.sampleRate !== this.sampleRate) {
      // Browser refused our rate; the context runs at the project rate so this should not happen.
      this.sampleRate = this.recorder.sampleRate;
    }
    const n = this.tracks.filter(t => /^Recording/.test(t.name)).length + 1;
    const track = this.makeTrack({ name: `Recording ${n}`, audio: AudioData.silence(1, this.recorder.nch, this.sampleRate) });
    track.recording = true;
    track.offset = at;
    this.tracks.forEach(t => { t.selected = false; });
    track.selected = true;
    this.tracks.push(track);
    this.recording = { track, at, startedAt: performance.now(), overdub: settings.get('overdub') && this.tracks.length > 1 };
    if (this.recording.overdub) this.engine.play(at, {});
    this.tracksChanged();
    this.updateToolbar();
    this.startLoop();
    this.status(`Recording from ${this.recorder.label}`);
  }

  async stopRecording() {
    const rec = this.recording;
    if (!rec) return;
    if (this.engine.playing) this.engine.stop();
    let audio = await this.recorder.stop();
    this.recording = null;
    const sr = this.sampleRate;
    if (rec.overdub && this.engine.ctx) {
      // Compensate for output + input latency so overdubs line up with what was heard.
      const lat = Math.round(((this.engine.ctx.outputLatency || 0) + (this.engine.ctx.baseLatency || 0)) * sr);
      if (lat > 0 && lat < audio.length) audio = slice(audio, lat, audio.length);
    }
    const t = rec.track;
    delete t.recording;
    delete t.offset;
    const lead = Math.round(rec.at * sr);
    t.audio = lead > 0 ? concat([AudioData.silence(lead, audio.numberOfChannels, sr), audio]) : audio;
    this.setSelection(rec.at, rec.at + audio.duration, { silent: true });
    this.playhead = rec.at;
    this.commit(`Record ${formatDuration(audio.duration)}`);
    this.tracksChanged();
    this.emitSelection();
    this.status(`Recorded ${formatDuration(audio.duration)}`);
  }

  // ---------- busy / status ----------
  async busy(label, fn) {
    const el = $('#busy'), lab = $('#busy-label'), bar = $('#busy-progress');
    lab.textContent = label;
    bar.classList.remove('determinate');
    bar.style.width = '';
    const timer = setTimeout(() => { el.hidden = false; }, 120);
    const progress = (p) => { el.hidden = false; bar.classList.add('determinate'); bar.style.width = `${Math.round(p * 100)}%`; };
    await nextFrame();
    try { return await fn(progress, (l) => { lab.textContent = l; }); }
    finally { clearTimeout(timer); el.hidden = true; }
  }

  status(msg) {
    const el = $('#status-msg');
    el.textContent = msg;
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => { el.textContent = ''; }, 6000);
  }

  requireTracks() {
    if (this.tracks.length) return true;
    toast('Import or record audio first.', { type: 'warn' });
    return false;
  }

  requireRange(verb = 'edit') {
    if (!this.requireTracks()) return false;
    if (this.hasRange) return true;
    toast(`Select audio to ${verb} — drag across a waveform.`, { type: 'warn' });
    return false;
  }

  // Apply fn(track, s, e) → AudioData|null to every target track, then commit.
  editTracks(label, fn) {
    if (this.engine.playing) this.engine.stop();
    let changed = 0;
    for (const t of this.targets) {
      const [s, e] = this.rangeSamples(t);
      const res = fn(t, s, e);
      if (res && res !== t.audio) { t.audio = res; changed++; }
    }
    if (!changed) return false;
    this.commit(label);
    this.tracksChanged();
    return true;
  }

  // ---------- edits ----------
  copy() {
    if (!this.requireRange('copy')) return false;
    const parts = this.targets.map(t => { const [s, e] = this.rangeSamples(t); return slice(t.audio, s, e); }).filter(p => p.length);
    if (!parts.length) { toast('The selection is past the end of the audio.', { type: 'warn' }); return false; }
    this.clipboard = parts;
    this.updateToolbar();
    this.status(`Copied ${formatDuration(parts[0].duration)}${parts.length > 1 ? ` from ${parts.length} tracks` : ''}`);
    return true;
  }

  cut() { if (this.copy()) this.deleteSelection('Cut'); }

  deleteSelection(label = 'Delete') {
    if (!this.requireRange('delete')) return;
    const start = this.selection.start;
    if (this.editTracks(label, (t, s, e) => (e > s ? splice(t.audio, s, e) : null))) {
      this.setCursor(start);
    }
  }

  paste() {
    if (!this.clipboard) return;
    const clip = this.clipboard;
    if (this.engine.playing) this.engine.stop();
    const at = this.selection.start;
    if (!this.tracks.length) {
      clip.forEach((c, i) => this.tracks.push(this.makeTrack({ name: `Pasted ${i + 1}`, audio: c })));
      this.tracks[0].selected = true;
    } else {
      const hadRange = this.hasRange;
      this.targets.forEach((t, i) => {
        const c = clip[i % clip.length];
        const [s, e] = this.rangeSamples(t);
        const pos = Math.round(at * t.audio.sampleRate);
        t.audio = hadRange && s < t.audio.length ? splice(t.audio, s, e, c) : insertAt(t.audio, pos, c);
      });
    }
    this.setSelection(at, at + clip[0].duration, { silent: true });
    this.commit('Paste');
    this.tracksChanged();
    this.selectionCommitted();
  }

  trim() {
    if (!this.requireRange('trim to')) return;
    const all = this.targets.length === this.tracks.length;
    const { start, end } = this.selection;
    const ok = this.editTracks('Trim', (t, s, e) => {
      if (e <= s) return AudioData.silence(0, t.audio.numberOfChannels, t.audio.sampleRate);
      const kept = slice(t.audio, s, e);
      // Keep alignment with untouched tracks by leaving leading silence in place.
      return all ? kept : concat([AudioData.silence(s, kept.numberOfChannels, kept.sampleRate), kept]);
    });
    if (!ok) return;
    if (all) { this.setSelection(0, end - start); this.view.scroll = 0; this.timeline.zoomFit(); }
    this.selectionCommitted();
  }

  silenceSelection() {
    if (!this.requireRange('silence')) return;
    this.editTracks('Silence', (t, s, e) => (e > s ? splice(t.audio, s, e, AudioData.silence(e - s, t.audio.numberOfChannels, t.audio.sampleRate)) : null));
  }

  bleep() {
    if (!this.requireTracks()) return;
    if (!this.hasRange) return this.openGenerator('beep');
    const mode = settings.get('bleepMode') || 'tone';
    const freq = settings.get('bleepFreq'), gain = settings.get('bleepGain');
    const done = this.editTracks('Bleep', (t, s, e) => {
      if (e <= s) return null;
      const n = e - s, ch = t.audio.numberOfChannels, sr = t.audio.sampleRate;
      const fill = mode === 'silence' ? AudioData.silence(n, ch, sr) : makeBleep(n, sr, ch, freq, gain);
      return splice(t.audio, s, e, fill);
    });
    if (done) this.status(`Bleeped ${formatDuration(this.selection.end - this.selection.start)}`);
  }

  duplicateToNewTrack() { this.selectionToNewTrack(false); }
  splitToNewTrack() { this.selectionToNewTrack(true); }

  selectionToNewTrack(removeFromSource) {
    if (!this.requireRange('copy')) return;
    if (this.engine.playing) this.engine.stop();
    const created = [];
    for (const t of this.targets) {
      const [s, e] = this.rangeSamples(t);
      if (e <= s) continue;
      const part = slice(t.audio, s, e);
      const audio = concat([AudioData.silence(s, part.numberOfChannels, part.sampleRate), part]);
      const nt = this.makeTrack({ name: `${t.name} (${removeFromSource ? 'split' : 'copy'})`, audio, colorIndex: t.colorIndex });
      if (removeFromSource) t.audio = splice(t.audio, s, e, AudioData.silence(e - s, t.audio.numberOfChannels, t.audio.sampleRate));
      created.push([t, nt]);
    }
    if (!created.length) return;
    for (const [src, nt] of created) this.tracks.splice(this.tracks.indexOf(src) + 1, 0, nt);
    this.tracks.forEach(t => { t.selected = created.some(([, nt]) => nt === t); });
    this.commit(removeFromSource ? 'Split to new track' : 'Copy to new track');
    this.tracksChanged();
  }

  // ---------- effects & generators ----------
  openEffect(id) {
    const fx = effectById(id);
    if (!fx || !this.requireTracks()) return;
    if (!fx.params.length) return this.applyEffect(fx, {});
    dialogs.openEffectDialog(this, fx);
  }

  effectContext() { return { noiseProfile: this.noiseProfile }; }

  async applyEffect(fx, params) {
    if (!this.requireTracks()) return;
    if (this.engine.playing) this.engine.stop();
    const whole = !this.hasRange;
    const targets = this.targets;
    if (fx.stereo && targets.every(t => t.audio.numberOfChannels < 2)) {
      toast(`${fx.name} needs a stereo track. Use Tracks › Convert to stereo first.`, { type: 'warn' });
      return;
    }
    let firstLen = null;
    try {
      await this.busy(`Applying ${fx.name}…`, async (progress) => {
        let i = 0;
        for (const t of targets) {
          const [s, e] = whole ? [0, t.audio.length] : this.rangeSamples(t);
          if (e > s) {
            const before = t.audio.length;
            t.audio = await processRange(t.audio, s, e, a => runEffect(fx, a, params, this.effectContext()));
            if (firstLen == null) firstLen = (e - s) + (t.audio.length - before);
          }
          progress(++i / targets.length);
          await nextFrame();
        }
      });
    } catch (err) { toastError(err); return; }
    if (firstLen == null) { toast('The selection is past the end of the audio.', { type: 'warn' }); return; }
    if (!whole && fx.changesLength) this.setSelection(this.selection.start, this.selection.start + firstLen / this.sampleRate, { silent: true });
    this.lastEffect = { id: fx.id, params: { ...params } };
    this.rememberRecent(fx.id);
    this.commit(fx.name);
    this.tracksChanged();
    this.emitSelection();
    this.status(whole ? `Applied ${fx.name} to ${targets.length > 1 ? 'all selected tracks' : 'the whole track'}` : `Applied ${fx.name}`);
  }

  async applyChain(chain) {
    for (const step of chain.steps) {
      const fx = effectById(step.effect);
      if (fx) await this.applyEffect(fx, step.params || {});
    }
  }

  repeatLastEffect() {
    const l = this.lastEffect;
    if (!l) return;
    const fx = effectById(l.id);
    if (fx) this.applyEffect(fx, l.params);
  }

  rememberRecent(id) {
    const r = local.get('recentFx', []).filter(x => x !== id);
    r.unshift(id);
    local.set('recentFx', r.slice(0, 5));
    this.sidepanel.renderEffects();
  }

  captureNoiseProfile() {
    if (!this.requireRange('sample as noise')) return;
    const t = this.targets[0];
    const [s, e] = this.rangeSamples(t);
    if (e - s < 2048) { toast('Select at least 50 ms of noise-only audio.', { type: 'warn' }); return; }
    this.noiseProfile = captureNoiseProfile(slice(t.audio, s, e));
    toast(`Noise profile captured from ${formatDuration((e - s) / t.audio.sampleRate)}. Now select the audio to clean and open Noise reduction.`, {
      action: () => this.openEffect('noiseReduction'), actionLabel: 'Open', duration: 8000,
    });
  }

  openGenerator(id) {
    const g = generatorById(id);
    if (g) dialogs.openGeneratorDialog(this, g);
  }

  generate(gen, params, mode) {
    if (this.engine.playing) this.engine.stop();
    const sr = this.sampleRate;
    const at = this.selection.start;
    let len = 0;
    if (mode === 'new' || !this.tracks.length) {
      const audio = gen.generate(params, sr, 1);
      const lead = this.tracks.length ? Math.round(at * sr) : 0;
      const t = this.makeTrack({ name: gen.name, audio: lead ? concat([AudioData.silence(lead, 1, sr), audio]) : audio });
      this.tracks.forEach(x => { x.selected = false; });
      t.selected = true;
      this.tracks.push(t);
      len = audio.duration;
      this.setSelection(lead / sr, lead / sr + len, { silent: true });
    } else {
      const hadRange = this.hasRange;
      for (const t of this.targets) {
        const piece = gen.generate(params, sr, t.audio.numberOfChannels);
        const [s, e] = this.rangeSamples(t);
        t.audio = mode === 'replace' && hadRange && s < t.audio.length ? splice(t.audio, s, e, piece) : insertAt(t.audio, Math.round(at * sr), piece);
        len = piece.duration;
      }
      this.setSelection(at, at + len, { silent: true });
    }
    this.commit(gen.id === 'silence' ? 'Insert silence' : `Generate ${gen.name}`);
    this.tracksChanged();
    this.selectionCommitted();
    if (this.tracks.length === 1 && this.history.entries.length <= 2) this.timeline.zoomFit();
  }

  // ---------- markers ----------
  addMarker(time = this.playheadTime, name) {
    if (!this.requireTracks()) return;
    const n = this.markers.filter(m => m.end == null).length + 1;
    const m = { id: uid('mk'), time: Math.max(0, time), name: name ?? `Marker ${n}` };
    this.markers.push(m);
    this.markersChanged();
    this.commit('Add marker');
    this.status(`Added ${m.name} at ${this.fmt(m.time)}`);
    return m;
  }

  addRegion(name) {
    if (!this.requireRange('label')) return;
    const n = this.markers.filter(m => m.end != null).length + 1;
    this.markers.push({ id: uid('mk'), time: this.selection.start, end: this.selection.end, name: name ?? `Region ${n}` });
    this.markersChanged();
    this.commit('Label selection');
    this.sidepanel.showTab('markers');
  }

  updateMarker(id, patch) {
    const m = this.markers.find(x => x.id === id);
    if (!m) return;
    Object.assign(m, patch);
    this.markersChanged();
    this.commit('Edit marker');
  }

  moveMarker(id, t, { live, commit } = {}) {
    const m = this.markers.find(x => x.id === id);
    if (!m) return;
    if (t != null) {
      const len = m.end != null ? m.end - m.time : 0;
      m.time = Math.max(0, t);
      if (m.end != null) m.end = m.time + len;
    }
    if (live) { this.timeline.invalidate(); return; }
    this.markersChanged();
    if (commit) this.commit('Move marker');
  }

  deleteMarker(id) {
    this.markers = this.markers.filter(m => m.id !== id);
    this.markersChanged();
    this.commit('Delete marker');
  }

  async clearMarkers() {
    if (!(await confirmDialog({ title: 'Remove all markers?', message: `This removes ${this.markers.length} markers and labels. You can undo it.`, confirmLabel: 'Remove markers', danger: true }))) return;
    this.markers = [];
    this.markersChanged();
    this.commit('Remove markers');
  }

  jumpMarker(dir) {
    const t = this.playheadTime;
    const sorted = this.markers.map(m => m.time).sort((a, b) => a - b);
    const target = dir > 0 ? sorted.find(x => x > t + 1e-3) : [...sorted].reverse().find(x => x < t - 1e-3);
    if (target == null) return;
    this.setCursor(target);
    this.timeline.ensureVisible(target, 0.3);
  }

  focusMarker(m) {
    if (m.end != null) { this.setSelection(m.time, m.end); this.selectionCommitted(); this.timeline.ensureVisible(m.time, 0.2); }
    else { this.setCursor(m.time); this.timeline.ensureVisible(m.time, 0.3); }
  }

  exportLabels() {
    const base = sanitizeFilename(this.name);
    const choose = (kind) => {
      const blob = kind === 'csv'
        ? new Blob([toCsv(this.markers, (t) => formatTime(t, 'hms'))], { type: 'text/csv' })
        : new Blob([toAudacityLabels(this.markers)], { type: 'text/plain' });
      downloadBlob(blob, `${base} labels.${kind === 'csv' ? 'csv' : 'txt'}`);
      this.status(`Exported ${this.markers.length} labels`);
    };
    const r = $('#side-tabs').getBoundingClientRect();
    showMenu([
      { heading: 'Export labels as' },
      { label: 'Audacity labels (.txt)', icon: 'file', action: () => choose('txt') },
      { label: 'Spreadsheet (.csv)', icon: 'file', action: () => choose('csv') },
    ], { x: r.left + 10, y: r.bottom + 40 });
  }

  async importLabelsDialog() {
    const [file] = await pickFiles({ accept: '.txt,.csv,text/plain,text/csv' });
    if (file) this.importLabels(file);
  }

  async importLabels(file) {
    const items = parseLabels(await file.text());
    if (!items.length) { toast(`No labels found in “${file.name}”. Expected lines of start, end and label.`, { type: 'warn' }); return; }
    for (const it of items) this.markers.push({ id: uid('mk'), time: it.time, end: it.end, name: it.name });
    this.markersChanged();
    this.commit(`Import ${items.length} labels`);
    this.sidepanel.showTab('markers');
    toast(`Imported ${items.length} labels from ${file.name}`);
  }

  // ---------- tracks ----------
  newEmptyTrack() {
    const t = this.makeTrack({ name: `Track ${this.tracks.length + 1}`, audio: AudioData.silence(0, 2, this.sampleRate) });
    this.tracks.forEach(x => { x.selected = false; });
    t.selected = true;
    this.tracks.push(t);
    this.commit('New track');
    this.tracksChanged();
  }

  async deleteTracks(ids) {
    if (!ids.length) return;
    if (settings.get('confirmDeleteTrack')) {
      const names = ids.map(id => this.trackById(id)?.name).filter(Boolean);
      const ok = await confirmDialog({ title: ids.length > 1 ? `Delete ${ids.length} tracks?` : `Delete “${names[0]}”?`, message: 'The audio is removed from the project. You can undo this.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
    }
    if (this.engine.playing) this.engine.stop();
    this.tracks = this.tracks.filter(t => !ids.includes(t.id));
    this.commit(ids.length > 1 ? 'Delete tracks' : 'Delete track');
    this.tracksChanged();
  }

  duplicateTracks(ids = this.targets.map(t => t.id)) {
    for (const id of ids) {
      const t = this.trackById(id);
      const copy = { ...this.makeTrack({ name: `${t.name} copy`, audio: t.audio, colorIndex: t.colorIndex }), gain: t.gain, pan: t.pan };
      this.tracks.splice(this.tracks.indexOf(t) + 1, 0, copy);
    }
    this.commit('Duplicate track');
    this.tracksChanged();
  }

  moveTrack(id, dir) {
    const i = this.tracks.findIndex(t => t.id === id), j = i + dir;
    if (j < 0 || j >= this.tracks.length) return;
    [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
    this.commit('Move track');
    this.tracksChanged();
  }

  renameTrack(id, name) {
    const t = this.trackById(id);
    if (!t || !name || t.name === name) return;
    t.name = name;
    this.commit('Rename track');
    this.trackHeaderChanged();
  }

  setTrackColor(id, i) { const t = this.trackById(id); t.colorIndex = i; this.trackHeaderChanged(); this.timeline.invalidateTrack(id); this.markDirty(); }
  setTrackHeight(id, hgt) { const t = this.trackById(id); t.height = hgt; this.trackHeaderChanged(); }
  setTrackView(id, v) { const t = this.trackById(id); t.view = v; this.trackHeaderChanged(); this.timeline.invalidateTrack(id); }
  setTrackGain(id, db) { const t = this.trackById(id); t.gain = db; this.trackHeaderChanged(); this.markDirty(); }
  setTrackPan(id, p) { const t = this.trackById(id); t.pan = clamp(p, -1, 1); this.trackHeaderChanged(); this.markDirty(); }

  toggleMute(id) { const t = this.trackById(id); t.mute = !t.mute; this.trackHeaderChanged(); this.timeline.invalidate(); }
  toggleSolo(id, exclusive) {
    const t = this.trackById(id);
    const v = !t.solo;
    if (exclusive) this.tracks.forEach(x => { x.solo = false; });
    t.solo = v;
    this.trackHeaderChanged();
    this.timeline.invalidate();
  }
  toggleMuteSelected() {
    const ts = this.targets;
    const v = !ts.every(t => t.mute);
    ts.forEach(t => { t.mute = v; });
    this.trackHeaderChanged();
    this.timeline.invalidate();
  }

  toggleSpectrogram() {
    const ts = this.targets;
    const v = ts.every(t => t.view === 'spectrogram') ? 'waveform' : 'spectrogram';
    ts.forEach(t => { t.view = v; });
    this.trackHeaderChanged();
    this.timeline.invalidate();
  }

  convertChannels(n) {
    if (this.engine.playing) this.engine.stop();
    let changed = 0;
    for (const t of this.targets) if (t.audio.numberOfChannels !== n) { t.audio = matchChannels(t.audio, n); changed++; }
    if (!changed) { this.status(`Selected tracks are already ${n === 1 ? 'mono' : 'stereo'}`); return; }
    this.commit(n === 1 ? 'Convert to mono' : 'Convert to stereo');
    this.tracksChanged();
  }

  async mixdownToTrack() {
    if (!this.requireTracks()) return;
    if (this.engine.playing) this.engine.stop();
    const audio = await this.busy('Mixing down…', () => renderMix(this.tracks, { sampleRate: this.sampleRate }));
    const t = this.makeTrack({ name: 'Mixdown', audio });
    this.tracks.forEach(x => { x.mute = true; x.selected = false; });
    t.selected = true;
    this.tracks.push(t);
    this.commit('Mix down');
    this.tracksChanged();
    toast('Mixdown added as a new track. The source tracks are muted.');
  }

  async resampleProject(rate) {
    if (rate === this.sampleRate) return;
    if (this.engine.playing) this.engine.stop();
    try {
      await this.busy(`Converting to ${formatRate(rate)}…`, async (progress) => {
        let i = 0;
        for (const t of this.tracks) { t.audio = await resampleAudio(t.audio, rate); progress(++i / this.tracks.length); }
      });
    } catch (err) { toastError(err); return; }
    this.sampleRate = rate;
    this.commit(`Resample to ${formatRate(rate)}`);
    this.tracksChanged();
    this.updateStatus();
  }

  trackMenu(id) {
    const t = this.trackById(id);
    const idx = this.tracks.indexOf(t);
    return [
      { label: 'Rename…', icon: 'file', action: async () => { const n = await promptDialog({ title: 'Rename track', label: 'Track name', value: t.name, confirmLabel: 'Rename' }); if (n) this.renameTrack(id, n.trim()); } },
      { label: 'Select whole track', icon: 'zoom-sel', action: () => this.selectWholeTrack(id) },
      { label: 'Duplicate', icon: 'copy', action: () => this.duplicateTracks([id]) },
      { label: 'Move up', icon: 'arrow-up', disabled: idx === 0, action: () => this.moveTrack(id, -1) },
      { label: 'Move down', icon: 'arrow-down', disabled: idx === this.tracks.length - 1, action: () => this.moveTrack(id, 1) },
      { separator: true },
      { label: t.view === 'spectrogram' ? 'Show waveform' : 'Show spectrogram', icon: 'chart', action: () => this.setTrackView(id, t.view === 'spectrogram' ? 'waveform' : 'spectrogram') },
      { label: 'Color', icon: 'sparkle', submenu: () => ['Amber', 'Sky', 'Violet', 'Rose', 'Lime', 'Sand', 'Teal', 'Coral'].map((n, i) => ({ label: n, checked: t.colorIndex % 8 === i, action: () => this.setTrackColor(id, i) })) },
      { label: 'Height', icon: 'sliders', submenu: () => [['Compact', 84], ['Standard', 132], ['Tall', 220], ['Extra tall', 340]].map(([n, v]) => ({ label: n, checked: t.height === v, action: () => this.setTrackHeight(id, v) })) },
      { separator: true },
      { label: t.audio.numberOfChannels === 1 ? 'Convert to stereo' : 'Convert to mono', icon: t.audio.numberOfChannels === 1 ? 'widen' : 'mono', action: () => { this.tracks.forEach(x => { x.selected = x.id === id; }); this.convertChannels(t.audio.numberOfChannels === 1 ? 2 : 1); } },
      { label: 'Export this track…', icon: 'download', action: () => { this.tracks.forEach(x => { x.selected = x.id === id; }); this.trackHeaderChanged(); this.openExport('selectedTracks'); } },
      { separator: true },
      { label: 'Delete track', icon: 'trash', action: () => this.deleteTracks([id]) },
    ];
  }

  laneMenu() {
    const item = (id) => this.menuItem(id);
    return [
      item('edit.cut'), item('edit.copy'), item('edit.paste'), item('edit.delete'),
      { separator: true },
      item('edit.trim'), item('edit.silence'), item('edit.bleep'),
      { separator: true },
      item('fx.fadeIn'), item('fx.fadeOut'), item('fx.normalize'), item('fx.noiseReduction'),
      { separator: true },
      item('marker.add'), item('marker.addRegion'),
      { separator: true },
      item('edit.selectAll'), item('file.exportSel'),
    ];
  }

  // ---------- project ----------
  loadProject({ name, sampleRate, tracks, markers }, label) {
    if (this.engine.playing) this.engine.stop();
    this.sampleRate = sampleRate;
    this.name = name || 'Untitled project';
    this.colorCounter = 0;
    this.tracks = tracks.map(t => ({ ...this.makeTrack({ name: t.name, audio: t.audio, colorIndex: t.colorIndex }), id: t.id || uid('trk'), gain: t.gain ?? 0, pan: t.pan ?? 0, mute: !!t.mute, solo: !!t.solo, height: t.height || settings.get('trackHeight'), view: t.view || 'waveform' }));
    this.colorCounter = this.tracks.length;
    this.markers = (markers || []).map(m => ({ id: m.id || uid('mk'), time: m.time, end: m.end ?? undefined, name: m.name || '' }));
    this.selection = { start: 0, end: 0 };
    this.playhead = 0;
    $('#project-name').value = this.name;
    document.title = `${this.name} — Kerf`;
    this.history.reset(label, this.snapshot());
    this.tracksChanged();
    this.markersChanged();
    this.timeline.zoomFit();
    this.emitSelection();
  }

  async newProject() {
    if (this.tracks.length) {
      const ok = await confirmDialog({ title: 'Start a new project?', message: 'This clears every track, marker and the undo history. Save the project first if you want to keep it.', confirmLabel: 'Clear and start new', danger: true });
      if (!ok) return;
    }
    this.sampleRate = settings.get('sampleRate');
    this.loadProject({ name: 'Untitled project', sampleRate: this.sampleRate, tracks: [], markers: [] }, 'New project');
    this.dirty = false;
    store.del('autosave').catch(() => {});
    this.updateSaveState();
  }

  async importDialog() {
    const files = await pickFiles({ accept: $('#file-input').accept, multiple: true });
    if (files.length) this.importFiles(files);
  }

  async openProjectDialog() {
    const [file] = await pickFiles({ accept: '.kerf,application/zip' });
    if (file) this.openProject(file);
  }

  async importFiles(files) {
    files = [...files];
    const projects = files.filter(f => /\.kerf$/i.test(f.name));
    if (projects.length) return this.openProject(projects[0]);
    const labels = files.filter(f => /\.(txt|csv)$/i.test(f.name));
    const audio = files.filter(f => isAudioFile(f));
    for (const l of labels) await this.importLabels(l);
    if (!audio.length) {
      if (!labels.length) toast('Those files aren’t audio. Kerf opens WAV, MP3, FLAC, OGG, M4A, WebM and video soundtracks.', { type: 'warn' });
      return;
    }
    if (this.engine.playing) this.engine.stop();
    const wasEmpty = !this.tracks.length;
    const added = [];
    await this.busy('Importing…', async (progress, label) => {
      for (let i = 0; i < audio.length; i++) {
        const f = audio[i];
        label(`Decoding ${f.name}${audio.length > 1 ? ` (${i + 1} of ${audio.length})` : ''}…`);
        try {
          const data = await decodeFile(f, this.sampleRate);
          const t = this.makeTrack({ name: stripExtension(f.name), audio: data });
          this.tracks.push(t);
          added.push(t);
        } catch (err) { toastError(err); }
        progress((i + 1) / audio.length);
      }
    });
    if (!added.length) return;
    this.tracks.forEach(t => { t.selected = added.includes(t); });
    if (wasEmpty && this.name === 'Untitled project') {
      this.name = added[0].name;
      $('#project-name').value = this.name;
      document.title = `${this.name} — Kerf`;
    }
    this.commit(added.length > 1 ? `Import ${added.length} files` : `Import ${added[0].name}`);
    this.tracksChanged();
    if (wasEmpty) this.timeline.zoomFit();
    this.status(`Imported ${added.length} file${added.length > 1 ? 's' : ''} at ${formatRate(this.sampleRate)}`);
  }

  async openProject(file) {
    if (this.tracks.length && !(await confirmDialog({ title: `Open “${file.name}”?`, message: 'The current project will be replaced. Save it first if you want to keep it.', confirmLabel: 'Open project' }))) return;
    try {
      const p = await this.busy(`Opening ${file.name}…`, () => loadProjectFile(file));
      this.loadProject(p, `Open ${p.name}`);
      this.markDirty();
      toast(`Opened ${p.name}`);
    } catch (err) { toastError(err); }
  }

  async saveProject() {
    if (!this.requireTracks()) return;
    try {
      const blob = await this.busy('Packing project…', () => saveProjectFile(this.projectData()));
      downloadBlob(blob, `${sanitizeFilename(this.name)}.kerf`);
      this.status('Project file downloaded');
    } catch (err) { toastError(err); }
  }

  projectData() {
    return { name: this.name, sampleRate: this.sampleRate, tracks: this.tracks.filter(t => !t.recording), markers: this.markers };
  }

  async autosave() {
    if (!settings.get('autosave') || this.recording) return;
    const bytes = this.tracks.reduce((n, t) => n + t.audio.length * t.audio.numberOfChannels * 4, 0);
    if (bytes > 1.5 * 1024 ** 3) {
      this.saveError = 'Too large to autosave — use Save project';
      this.dirty = true;
      this.updateSaveState();
      return;
    }
    try {
      if (!this.tracks.length) await store.del('autosave');
      else await store.set('autosave', toAutosave(this.projectData()));
      this.savedAt = new Date();
      this.dirty = false;
    } catch (err) {
      console.warn('Autosave failed', err);
      this.saveError = err.name === 'QuotaExceededError' ? 'Storage full' : 'Autosave failed';
    }
    this.updateSaveState();
  }

  async restoreAutosave() {
    if (!settings.get('autosave')) return;
    try {
      const data = fromAutosave(await store.get('autosave'));
      if (!data || !data.tracks.length) return;
      this.loadProject(data, 'Restored session');
      this.savedAt = new Date(data.savedAt);
      this.dirty = false;
      toast(`Restored “${data.name}” from your last session.`, { action: () => this.newProject(), actionLabel: 'Start fresh', duration: 6000 });
    } catch (err) { console.warn('Could not restore autosave', err); }
  }

  updateSaveState() {
    const el = $('#save-state');
    if (!settings.get('autosave')) { el.textContent = 'Autosave off'; el.classList.remove('dirty'); return; }
    if (this.saveError) { el.textContent = this.saveError; el.classList.add('dirty'); this.saveError = null; return; }
    if (this.dirty) { el.textContent = 'Saving…'; el.classList.add('dirty'); return; }
    el.classList.remove('dirty');
    el.textContent = this.savedAt ? `Saved ${this.savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
  }

  loadDemo() {
    const tracks = demoTracks(this.sampleRate);
    const apply = () => {
      this.loadProject({ name: 'Sample session', sampleRate: this.sampleRate, tracks, markers: [{ time: 0, name: 'Intro' }, { time: 4, end: 8, name: 'Chorus' }] }, 'Load sample');
      this.markDirty();
      toast('Sample loaded. Press Space to play, drag to select, then try an effect.');
    };
    if (this.tracks.length) {
      confirmDialog({ title: 'Replace the current project?', message: 'Loading the sample clears your tracks. Save first if you want to keep them.', confirmLabel: 'Load sample' }).then(ok => ok && apply());
    } else apply();
  }

  // ---------- view ----------
  zoom(f) {
    const anchor = this.engine.playing ? this.engine.position : this.hasRange ? (this.selection.start + this.selection.end) / 2 : this.selection.start;
    const x = clamp(this.timeline.timeToX(anchor), 0, this.timeline.laneWidth);
    this.timeline.zoomTo(this.view.pxPerSec * f, anchor, x);
  }
  zoomFit() { this.timeline.zoomFit(); }

  setPlayRate(r) {
    const el = $('#play-rate');
    el.value = r;
    el.dispatchEvent(new Event('input'));
  }
  zoomSelection() { if (this.hasRange) this.timeline.zoomToRange(this.selection.start, this.selection.end); }

  togglePanel() {
    const ws = $('#workspace');
    if (matchMedia('(max-width: 980px)').matches) ws.classList.toggle('panel-open');
    else {
      ws.classList.toggle('panel-hidden');
      local.set('panelHidden', ws.classList.contains('panel-hidden'));
    }
    requestAnimationFrame(() => this.timeline.invalidate());
  }

  applyTheme() {
    let t = settings.get('theme');
    if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', t === 'light' ? '#f3f5f3' : '#131d22'));
    this.timeline?.refreshTheme();
  }

  cycleTheme() {
    const cur = document.documentElement.dataset.theme;
    settings.set('theme', cur === 'dark' ? 'light' : 'dark');
  }

  setTimeFormat(f) { settings.set('timeFormat', f); }
  toggleSetting(k) { settings.set(k, !settings.get(k)); }

  onSetting(key) {
    if (key === 'theme') this.applyTheme();
    if (key === 'timeFormat') { this.updateSelectionFields(); this.updateVfd(); this.sidepanel.renderMarkers(); }
    if (key === 'autosave') { this.updateSaveState(); if (settings.get('autosave')) this.autosave(); else store.del('autosave').catch(() => {}); }
    if (key === 'snapZero') $('#snap-zero').checked = settings.get('snapZero');
    if (key === 'showRms') this.timeline.invalidate();
    if (key === 'historyLimit') this.history.limit = settings.get('historyLimit');
    this.updateToolbar();
  }

  // ---------- dialogs ----------
  openPalette() {
    openPalette(() => this.commands.list, (c) => this.run(c.id));
  }
  openExport(scope) { if (this.requireTracks()) openExportDialog(this, scope); }
  openBatch() { openBatchDialog(this); }
  openChainDialog() { if (this.requireTracks()) openChainDialog(this); }
  openSettings() { dialogs.openSettingsDialog(this); }
  openShortcuts() { dialogs.openShortcutsDialog(this); }
  openAbout() { dialogs.openAboutDialog(this); }
  openStats() { if (this.requireTracks()) dialogs.openStatsDialog(this); }
  openSpectrum() { if (this.requireTracks()) dialogs.openSpectrumDialog(this); }
  openBleepOptions() { dialogs.openBleepDialog(this); }
  openResample() { dialogs.openResampleDialog(this); }

  openFindClipping() {
    dialogs.openParamsDialog({
      title: 'Find clipping', subtitle: 'Mark every run of samples at or above full scale.',
      params: [
        { id: 'threshold', label: 'Threshold', type: 'number', min: 90, max: 100, step: 0.1, default: 99.9, unit: '%' },
        { id: 'minRun', label: 'Minimum consecutive samples', type: 'number', min: 1, max: 50, step: 1, default: 3 },
      ],
      applyLabel: 'Find clipping',
      onApply: (v) => this.findClipping(v),
    });
  }

  findClipping({ threshold, minRun }) {
    let found = 0;
    const regions = [];
    for (const t of this.targets) {
      for (const r of findClipping(t.audio, { threshold: threshold / 100, minRun })) {
        regions.push({ time: r.start / t.audio.sampleRate, end: Math.max(r.end, r.start + 1) / t.audio.sampleRate });
      }
    }
    regions.sort((a, b) => a.time - b.time);
    for (const r of regions.slice(0, 500)) {
      this.markers.push({ id: uid('mk'), time: r.time, end: r.end - r.time > 0.002 ? r.end : undefined, name: `Clipping ${++found}` });
    }
    if (!found) { toast('No clipping found. Peaks stay below the threshold.'); return; }
    this.markersChanged();
    this.commit('Find clipping');
    this.sidepanel.showTab('markers');
    toast(`Marked ${found} clipped region${found > 1 ? 's' : ''}${regions.length > 500 ? ' (first 500)' : ''}.`, { type: 'warn' });
  }

  openFindSilence() {
    dialogs.openParamsDialog({
      title: 'Find silence', subtitle: 'Label quiet stretches — useful for splitting long recordings.',
      params: [
        { id: 'thresholdDb', label: 'Quieter than', type: 'number', min: -90, max: -10, step: 1, default: -50, unit: 'dB' },
        { id: 'minSec', label: 'Lasting at least', type: 'number', min: 0.1, max: 30, step: 0.1, default: 1, unit: 's' },
        { id: 'mode', label: 'Then', type: 'select', options: [['label', 'Label each silent stretch'], ['split', 'Add a marker in the middle of each (split points)']], default: 'label' },
      ],
      applyLabel: 'Find silence',
      onApply: (v) => this.findSilence(v),
    });
  }

  findSilence({ thresholdDb, minSec, mode }) {
    const t = this.targets[0];
    if (!t) return;
    const sr = t.audio.sampleRate;
    const regions = findSilence(t.audio, { thresholdDb, minSec });
    if (!regions.length) { toast('No silence found with those settings. Try a higher threshold or shorter duration.'); return; }
    regions.forEach((r, i) => {
      if (mode === 'split') this.markers.push({ id: uid('mk'), time: (r.start + r.end) / 2 / sr, name: `Split ${i + 1}` });
      else this.markers.push({ id: uid('mk'), time: r.start / sr, end: r.end / sr, name: `Silence ${i + 1}` });
    });
    this.markersChanged();
    this.commit('Find silence');
    this.sidepanel.showTab('markers');
    toast(`Found ${regions.length} silent stretch${regions.length > 1 ? 'es' : ''} in ${t.name}.`);
  }

  async install() {
    const p = this.installPrompt;
    if (!p) return;
    p.prompt();
    const { outcome } = await p.userChoice;
    if (outcome === 'accepted') { this.installPrompt = null; $('#btn-install').hidden = true; }
  }

  // ---------- commands & chrome ----------
  menuItem(id) {
    const c = this.commands.byId.get(id);
    if (!c) return null;
    return { label: c.label, icon: c.icon, shortcut: c.shortcut, disabled: c.enabled ? !c.enabled() : false, checked: c.checked?.(), action: () => this.run(id) };
  }

  async run(id) {
    const c = this.commands.byId.get(id);
    if (!c) return;
    if (c.enabled && !c.enabled()) return;
    try { await c.run(); } catch (err) { toastError(err); }
  }

  buildMenus() {
    const m = (id) => this.menuItem(id);
    const sep = { separator: true };
    const fxMenu = () => {
      const groups = this.commands.EFFECT_CATEGORIES.map(cat => ({
        label: cat, icon: EFFECTS.find(e => e.category === cat)?.icon,
        submenu: () => [
          ...(cat === 'Restoration' ? [m('fx.captureNoise'), sep] : []),
          ...EFFECTS.filter(e => e.category === cat).map(e => m(`fx.${e.id}`)),
        ],
      }));
      return [m('fx.again'), m('fx.chain'), sep, ...groups];
    };
    this.menus = [
      { label: 'File', items: () => [m('file.new'), m('file.import'), m('file.openProject'), m('file.saveProject'), sep, m('file.export'), m('file.exportSel'), m('file.exportTracks'), sep, m('file.batch'), sep, m('file.demo'), m('app.settings'), m('app.install')] },
      { label: 'Edit', items: () => [m('edit.undo'), m('edit.redo'), sep, m('edit.cut'), m('edit.copy'), m('edit.paste'), m('edit.delete'), sep, m('edit.trim'), m('edit.silence'), m('edit.bleep'), m('edit.bleepOptions'), m('edit.insertSilence'), sep, m('edit.duplicate'), m('edit.split'), sep, m('edit.selectAll'), m('edit.selectNone'), m('edit.selectToStart'), m('edit.selectToEnd'), m('edit.snapZero')] },
      { label: 'Tracks', items: () => [m('track.new'), m('track.duplicate'), m('track.delete'), sep, m('track.mixdown'), m('track.mono'), m('track.stereo'), sep, m('track.muteSel'), m('track.resample')] },
      { label: 'Effects', items: fxMenu },
      { label: 'Generate', items: () => GENERATORS.map(g => m(`gen.${g.id}`)) },
      { label: 'Analyze', items: () => [m('analyze.stats'), m('analyze.spectrum'), sep, m('analyze.clipping'), m('analyze.silence')] },
      { label: 'Markers', items: () => [m('marker.add'), m('marker.addRegion'), m('marker.next'), m('marker.prev'), sep, m('marker.import'), m('marker.export'), m('marker.clear')] },
      { label: 'View', items: () => [m('view.zoomIn'), m('view.zoomOut'), m('view.zoomSel'), m('view.zoomFit'), sep, m('view.spectrogram'), m('view.follow'), { label: 'Time format', icon: 'clock', submenu: () => [m('view.timeHms'), m('view.timeSec'), m('view.timeSmp')] },
        { label: 'Playback speed', icon: 'gauge', submenu: () => [0.5, 0.75, 1, 1.25, 1.5, 2].map(r => ({ label: `${r.toFixed(2)}×${r === 1 ? ' (normal)' : ''}`, checked: Math.abs(this.engine.rate - r) < 1e-3, action: () => this.setPlayRate(r) })) },
        sep, m('view.panel'), m('view.theme'), m('view.palette')] },
      { label: 'Help', items: () => [m('help.shortcuts'), m('help.about')] },
    ];
    this.menubar = new MenuBar($('#menus'), this.menus);
  }

  openBurger() {
    const r = $('#btn-burger').getBoundingClientRect();
    showMenu(this.menus.map(mn => ({ label: mn.label, submenu: mn.items })), { x: r.left, y: r.bottom + 4, anchor: $('#btn-burger') });
  }

  bindChrome() {
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd]');
      if (b && !b.disabled) this.run(b.dataset.cmd);
    });
    $('#btn-burger').addEventListener('click', () => this.openBurger());
    const pn = $('#project-name');
    pn.addEventListener('change', () => {
      this.name = pn.value.trim() || 'Untitled project';
      pn.value = this.name;
      document.title = `${this.name} — Kerf`;
      this.markDirty();
    });
    pn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') pn.blur(); e.stopPropagation(); });

    const mv = $('#master-volume'), mvo = $('#master-volume-out');
    mv.value = local.get('masterDb', 0);
    const setMv = () => { this.engine.setMasterDb(+mv.value); mvo.textContent = `${(+mv.value).toFixed(1)} dB`; local.set('masterDb', +mv.value); };
    mv.addEventListener('input', setMv);
    mv.addEventListener('dblclick', () => { mv.value = 0; setMv(); });
    setMv();
    const pr = $('#play-rate'), pro = $('#play-rate-out');
    const setPr = () => { this.engine.setRate(+pr.value); pro.textContent = `${(+pr.value).toFixed(2)}×`; $('#vfd-rate').textContent = +pr.value === 1 ? formatRate(this.sampleRate).replace(' kHz', 'k') : `${(+pr.value).toFixed(2)}×`; };
    pr.addEventListener('input', setPr);
    pr.addEventListener('dblclick', () => { pr.value = 1; setPr(); });

    $('#vfd').addEventListener('click', () => {
      const order = ['hms', 'seconds', 'samples'];
      settings.set('timeFormat', order[(order.indexOf(settings.get('timeFormat')) + 1) % 3]);
    });
    $('#vfd').title = 'Click to change the time format';

    const snap = $('#snap-zero');
    snap.checked = settings.get('snapZero');
    snap.addEventListener('change', () => settings.set('snapZero', snap.checked));

    const fields = { start: $('#sel-start'), end: $('#sel-end'), len: $('#sel-len') };
    for (const [k, el] of Object.entries(fields)) {
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); if (e.key === 'Escape') { this.updateSelectionFields(true); el.blur(); } e.stopPropagation(); });
      el.addEventListener('change', () => {
        const v = parseTime(el.value, settings.get('timeFormat'), this.sampleRate);
        el.classList.toggle('invalid', !isFinite(v) || v < 0);
        if (!isFinite(v) || v < 0) return;
        const s = this.selection;
        if (k === 'start') this.setSelection(v, Math.max(v, s.end));
        else if (k === 'end') this.setSelection(Math.min(s.start, v), v);
        else this.setSelection(s.start, s.start + v);
        this.selectionCommitted();
        this.timeline.ensureVisible(this.selection.start, 0.1);
      });
    }

    if (local.get('panelHidden', false)) $('#workspace').classList.add('panel-hidden');
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (settings.get('theme') === 'system') this.applyTheme(); });
  }

  updateSelectionFields(force = false) {
    const s = this.selection;
    const set = (el, v) => { if (force || document.activeElement !== el) { el.value = this.fmt(v); el.classList.remove('invalid'); } };
    set($('#sel-start'), s.start);
    set($('#sel-end'), s.end);
    set($('#sel-len'), s.end - s.start);
    $('#vfd-sel').textContent = this.hasRange ? `SEL ${formatDuration(s.end - s.start).toUpperCase()}` : 'SEL —';
  }

  updateVfd() {
    if (!this.vfd) return;
    const t = this.recording ? (this.recording.pos ?? this.recording.at) : this.playheadTime;
    const f = settings.get('timeFormat');
    let txt = formatTime(t, f, this.sampleRate);
    if (f === 'seconds') txt = txt.padStart(10, ' ');
    if (f === 'samples') txt = txt.padStart(10, ' ');
    this.vfd.set(txt);
    const st = $('#vfd-state');
    const state = this.recording ? 'REC' : this.engine.preview ? 'PREVIEW' : this.engine.playing ? (this.engine.loop ? 'LOOP' : 'PLAY') : 'STOP';
    if (st.textContent !== state) {
      st.textContent = state;
      st.className = `vfd-tag ${state === 'REC' ? 'rec' : state === 'STOP' ? '' : 'live'}`;
    }
  }

  updateToolbar() {
    const enabled = (id) => { const c = this.commands.byId.get(id); return !c?.enabled || c.enabled(); };
    document.querySelectorAll('#toolbar [data-cmd], .ruler-corner [data-cmd]').forEach(b => { b.disabled = !enabled(b.dataset.cmd); });
    const play = $('#btn-play');
    const playing = this.engine.playing && !this.recording;
    play.classList.toggle('playing', playing);
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    play.title = `${playing ? 'Pause' : 'Play'} (Space)`;
    if (play.dataset.icon !== (playing ? 'pause' : 'play')) setIcon(play, playing ? 'pause' : 'play');
    $('#btn-record').classList.toggle('recording', !!this.recording);
    $('#btn-record').setAttribute('aria-label', this.recording ? 'Stop recording' : 'Record');
    $('#btn-loop').setAttribute('aria-pressed', String(this.loop));
    $('#btn-install').hidden = !this.installPrompt;
  }

  updateStatus() {
    const n = this.tracks.length;
    $('#status-info').textContent = n
      ? `${formatRate(this.sampleRate)} · ${n} track${n > 1 ? 's' : ''} · ${formatTime(this.duration, 'hms')}${this.markers.length ? ` · ${this.markers.length} marker${this.markers.length > 1 ? 's' : ''}` : ''}`
      : `${formatRate(this.sampleRate)} · no audio yet`;
    if (+$('#play-rate').value === 1) $('#vfd-rate').textContent = formatRate(this.sampleRate).replace(' kHz', 'k');
  }

  // Quick selection readout for the Analyze tab.
  selectionSummary() {
    const t = this.targets[0];
    if (!t) return null;
    const [s, e] = this.hasRange ? this.rangeSamples(t) : [0, t.audio.length];
    return { track: t, audio: slice(t.audio, s, e), whole: !this.hasRange };
  }
}
