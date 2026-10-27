// Track area: headers, waveform/spectrogram lanes, ruler, overview and all pointer
// interaction for selecting, scrubbing and moving markers.
import { getPeaks, PEAK_BLOCK } from '../core/audio-data.js';
import { h, $, setupCanvas, cssVar } from './dom.js';
import { icon } from './icons.js';
import { showMenu } from './menu.js';
import { formatDb, formatDuration, clamp } from '../core/format.js';
import { getFFT, hann } from '../dsp/fft.js';

const TICK_STEPS = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
const SPEC_STOPS = [[0, [6, 16, 19]], [0.22, [18, 48, 78]], [0.45, [26, 128, 132]], [0.65, [92, 230, 200]], [0.82, [255, 181, 71]], [1, [255, 246, 222]]];

const SPEC_LUT = (() => {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < SPEC_STOPS.length - 2 && t > SPEC_STOPS[k + 1][0]) k++;
    const [t0, c0] = SPEC_STOPS[k], [t1, c1] = SPEC_STOPS[k + 1];
    const u = (t - t0) / (t1 - t0);
    for (let j = 0; j < 3; j++) lut[i * 3 + j] = Math.round(c0[j] + (c1[j] - c0[j]) * u);
  }
  return lut;
})();

function hexToRgb(hex) {
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? m.slice(1).map(x => parseInt(x, 16)) : [255, 181, 71];
}
const mix = (a, b, t) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;

function fmtTick(t, step) {
  const neg = t < 0; t = Math.abs(t);
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  let s = ss.toFixed(dec);
  if (ss < 10) s = '0' + s;
  return (neg ? '-' : '') + (hh ? `${hh}:${String(mm).padStart(2, '0')}:${s}` : `${mm}:${s}`);
}

export class Timeline {
  constructor(app) {
    this.app = app;
    this.scrollEl = $('#tracks-scroll');
    this.tracksEl = $('#tracks');
    this.overlay = $('#lane-overlay');
    this.playheadEl = $('#playhead');
    this.cursorEl = $('#cursor-line');
    this.ruler = $('#ruler');
    this.rulerWrap = $('#ruler-wrap');
    this.overview = $('#overview');
    this.rows = new Map();
    this.dirty = new Set(['ruler', 'overview', 'tracks']);
    this.raf = 0;
    this.overviewCache = null;
    this.rulerPlayhead = h('div', { style: { position: 'absolute', top: '0', left: '0', width: '0', height: '0', borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '7px solid var(--vfd)', pointerEvents: 'none', willChange: 'transform', filter: 'drop-shadow(0 0 3px rgba(92,242,214,.6))' } });
    this.rulerWrap.append(this.rulerPlayhead);
    this.refreshTheme();
    new ResizeObserver(() => this.invalidate()).observe(this.rulerWrap);
    new ResizeObserver(() => this.invalidate('overview')).observe(this.overview);
    this.bind();
  }

  // ---------- geometry ----------
  get laneWidth() { return this.rulerWrap.clientWidth || 1; }
  get originX() { return this.rulerWrap.getBoundingClientRect().left; }
  get visibleDuration() { return this.laneWidth / this.app.view.pxPerSec; }
  timeToX(t) { return (t - this.app.view.scroll) * this.app.view.pxPerSec; }
  xToTime(x) { return this.app.view.scroll + x / this.app.view.pxPerSec; }

  refreshTheme() {
    this.colors = {
      tracks: Array.from({ length: 8 }, (_, i) => cssVar(`--track-${i}`)),
      text: cssVar('--text'), dim: cssVar('--text-dim'), faint: cssVar('--text-faint'),
      grid: cssVar('--grid'), center: cssVar('--center'), selBg: cssVar('--sel-bg'), selEdge: cssVar('--sel-edge'),
      vfd: cssVar('--vfd'), signal: cssVar('--signal'), line: cssVar('--line'), lane: cssVar('--lane'), panel: cssVar('--panel'),
    };
    this.textRgb = hexToRgb(this.colors.text);
    this.overviewCache = null;
    this.invalidate();
  }

  invalidate(...what) {
    if (!what.length) what = ['ruler', 'overview', 'tracks'];
    what.forEach(w => this.dirty.add(w));
    if (!this.raf) this.raf = requestAnimationFrame(() => this.render());
  }

  invalidateTrack(id) { this.dirty.add(`t:${id}`); this.invalidate('overview'); }

  render() {
    this.raf = 0;
    const d = this.dirty;
    this.dirty = new Set();
    if (d.has('ruler') || d.has('tracks')) this.drawRuler();
    for (const t of this.app.tracks) {
      if (d.has('tracks') || d.has(`t:${t.id}`)) this.drawTrack(this.rows.get(t.id), t);
    }
    if (d.has('overview')) this.drawOverview();
    this.updateOverlay();
  }

  // ---------- rows ----------
  syncTracks() {
    const app = this.app;
    const ids = new Set(app.tracks.map(t => t.id));
    for (const [id, row] of this.rows) if (!ids.has(id)) { row.el.remove(); this.rows.delete(id); }
    let prev = null;
    for (const t of app.tracks) {
      let row = this.rows.get(t.id);
      if (!row) { row = this.makeRow(t); this.rows.set(t.id, row); }
      this.updateHeader(row, t);
      const expected = prev ? prev.nextSibling : this.tracksEl.firstChild;
      if (row.el !== expected) this.tracksEl.insertBefore(row.el, expected);
      prev = row.el;
    }
    this.overlay.style.height = `${this.tracksEl.offsetHeight}px`;
    this.overviewCache = null;
    this.invalidate();
  }

  makeRow(t) {
    const app = this.app;
    const name = h('input.track-name', { value: t.name, spellcheck: false, 'aria-label': 'Track name' });
    const menuBtn = h('button.icon-btn.icon-btn-sm', { 'aria-label': 'Track options', title: 'Track options', html: icon('more') });
    const mute = h('button.chip.chip-mute', { title: 'Mute', 'aria-label': 'Mute track' }, 'M');
    const solo = h('button.chip.chip-solo', { title: 'Solo', 'aria-label': 'Solo track' }, 'S');
    const view = h('button.chip.chip-view', { title: 'Toggle spectrogram view', 'aria-label': 'Spectrogram view' }, 'SPEC');
    const sel = h('button.chip', { title: 'Select whole track', 'aria-label': 'Select whole track' }, 'ALL');
    const gain = h('input', { type: 'range', min: -36, max: 12, step: 0.1, 'aria-label': 'Track gain' });
    const gainOut = h('output');
    const pan = h('input', { type: 'range', min: -100, max: 100, step: 1, 'aria-label': 'Track pan' });
    const panOut = h('output');
    const meta = h('div.track-meta');
    const resize = h('div.track-resize', { title: 'Drag to resize' });
    const header = h('div.track-header',
      h('div.track-title', name, menuBtn),
      meta,
      h('div.track-buttons', mute, solo, view, sel),
      h('div.track-sliders', h('span', 'GAIN'), gain, gainOut, h('span', 'PAN'), pan, panOut),
      resize);
    const canvas = h('canvas');
    const lane = h('div.lane', canvas);
    const el = h('div.track', { dataset: { id: t.id } }, header, lane);
    const row = { el, header, lane, canvas, name, mute, solo, view, gain, gainOut, pan, panOut, meta, spec: null };

    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('input, button, .track-resize')) return;
      app.clickTrack(t.id, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });
    });
    name.addEventListener('change', () => app.renameTrack(t.id, name.value.trim() || app.trackById(t.id)?.name));
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') name.blur();
      if (e.key === 'Escape') { name.value = app.trackById(t.id)?.name || ''; name.blur(); }
      e.stopPropagation();
    });
    mute.addEventListener('click', () => app.toggleMute(t.id));
    solo.addEventListener('click', (e) => app.toggleSolo(t.id, e.ctrlKey || e.metaKey || e.shiftKey));
    view.addEventListener('click', () => app.setTrackView(t.id, app.trackById(t.id).view === 'spectrogram' ? 'waveform' : 'spectrogram'));
    sel.addEventListener('click', () => app.selectWholeTrack(t.id));
    gain.addEventListener('input', () => app.setTrackGain(t.id, +gain.value));
    gain.addEventListener('dblclick', () => app.setTrackGain(t.id, 0));
    pan.addEventListener('input', () => app.setTrackPan(t.id, +pan.value / 100));
    pan.addEventListener('dblclick', () => app.setTrackPan(t.id, 0));
    menuBtn.addEventListener('click', () => {
      const r = menuBtn.getBoundingClientRect();
      showMenu(app.trackMenu(t.id), { x: r.left, y: r.bottom + 2, anchor: menuBtn });
    });
    resize.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      resize.setPointerCapture(e.pointerId);
      const y0 = e.clientY, h0 = app.trackById(t.id).height;
      const move = (ev) => app.setTrackHeight(t.id, clamp(h0 + ev.clientY - y0, 64, 480));
      const up = () => { resize.removeEventListener('pointermove', move); resize.removeEventListener('pointerup', up); };
      resize.addEventListener('pointermove', move);
      resize.addEventListener('pointerup', up);
    });
    lane.addEventListener('pointerdown', (e) => this.onLaneDown(e, t.id));
    lane.addEventListener('pointermove', (e) => { if (!e.buttons) this.onLaneHover(e, t.id); });
    lane.addEventListener('dblclick', () => app.selectWholeTrack(t.id));
    lane.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const tr = app.trackById(t.id);
      if (!tr.selected) app.clickTrack(t.id, {});
      showMenu(app.laneMenu(), { x: e.clientX, y: e.clientY });
    });
    return row;
  }

  updateHeader(row, t) {
    row.el.style.setProperty('--track-color', `var(--track-${t.colorIndex % 8})`);
    row.el.style.height = `${t.height}px`;
    row.el.classList.toggle('selected', !!t.selected);
    row.el.classList.toggle('compact', t.height < 112);
    row.el.classList.toggle('recording', !!t.recording);
    if (document.activeElement !== row.name) row.name.value = t.name;
    row.mute.setAttribute('aria-pressed', String(!!t.mute));
    row.solo.setAttribute('aria-pressed', String(!!t.solo));
    row.view.setAttribute('aria-pressed', String(t.view === 'spectrogram'));
    if (document.activeElement !== row.gain) row.gain.value = t.gain;
    if (document.activeElement !== row.pan) row.pan.value = Math.round(t.pan * 100);
    row.gainOut.textContent = formatDb(t.gain);
    row.panOut.textContent = Math.abs(t.pan) < 0.005 ? 'C' : `${t.pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(t.pan) * 100)}`;
    const a = t.audio;
    row.meta.textContent = `${a.numberOfChannels === 1 ? 'Mono' : a.numberOfChannels === 2 ? 'Stereo' : `${a.numberOfChannels} ch`} · ${formatDuration(a.duration)}`;
    row.lane.setAttribute('aria-label', `${t.name}, ${row.meta.textContent}`);
  }

  // ---------- drawing ----------
  drawRuler() {
    const { ctx, w, h: hgt } = setupCanvas(this.ruler);
    const app = this.app, pps = app.view.pxPerSec;
    ctx.clearRect(0, 0, w, hgt);
    const step = TICK_STEPS.find(s => s * pps >= 90) || TICK_STEPS[TICK_STEPS.length - 1];
    const minor = step / (step === 15 || step === 900 ? 3 : step >= 60 && step % 60 === 0 && step !== 300 && step !== 600 ? 4 : 5);
    this.tickStep = step;
    const t0 = app.view.scroll, t1 = t0 + w / pps;
    // selection band
    const sel = app.selection;
    if (sel.end > sel.start) {
      const x0 = this.timeToX(sel.start), x1 = this.timeToX(sel.end);
      ctx.fillStyle = 'rgba(92,242,214,0.12)';
      ctx.fillRect(x0, 0, x1 - x0, hgt);
      ctx.fillStyle = this.colors.vfd;
      ctx.fillRect(x0, hgt - 3, x1 - x0, 3);
    }
    ctx.strokeStyle = this.colors.faint;
    ctx.fillStyle = this.colors.dim;
    ctx.font = '500 10.5px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(this.timeToX(t)) + 0.5;
      const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.moveTo(x, hgt); ctx.lineTo(x, hgt - (isMajor ? 11 : 5));
      if (isMajor) ctx.fillText(fmtTick(t, step), x + 4, 4);
    }
    ctx.stroke();
    // markers
    for (const m of app.markers) {
      const x = this.timeToX(m.time);
      if (m.end != null) {
        const x2 = this.timeToX(m.end);
        if (x2 < 0 || x > w) continue;
        ctx.fillStyle = 'rgba(255,181,71,0.22)';
        ctx.fillRect(x, hgt - 8, x2 - x, 5);
      }
      if (x < -60 || x > w + 2) continue;
      ctx.fillStyle = m.end != null ? this.colors.signal : this.colors.vfd;
      ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x + 7, 2); ctx.lineTo(x + 7, 9); ctx.lineTo(x, 13); ctx.closePath(); ctx.fill();
      ctx.fillRect(Math.round(x), 2, 1, hgt - 2);
      if (m.name) {
        ctx.font = '600 10px "IBM Plex Sans", system-ui, sans-serif';
        const label = m.name.length > 24 ? m.name.slice(0, 23) + '…' : m.name;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = this.colors.panel;
        ctx.fillRect(x + 9, 3, tw + 6, 12);
        ctx.fillStyle = m.end != null ? this.colors.signal : this.colors.vfd;
        ctx.fillText(label, x + 12, 4);
        ctx.font = '500 10.5px "IBM Plex Mono", ui-monospace, monospace';
      }
    }
  }

  trackColor(t) { return this.colors.tracks[t.colorIndex % 8] || this.colors.signal; }

  drawTrack(row, t) {
    if (!row) return;
    const { ctx, w, h: hgt } = setupCanvas(row.canvas);
    ctx.clearRect(0, 0, w, hgt);
    const app = this.app;
    const sel = app.selection;
    // grid
    if (this.tickStep) {
      ctx.fillStyle = this.colors.grid;
      const step = this.tickStep;
      const t0 = app.view.scroll, t1 = t0 + w / app.view.pxPerSec;
      for (let tt = Math.ceil(t0 / step) * step; tt <= t1; tt += step) ctx.fillRect(Math.round(this.timeToX(tt)), 0, 1, hgt);
    }
    // audio extent (a track being recorded starts at its punch-in offset)
    const offset = t.offset || 0;
    const endX = this.timeToX(t.audio.duration + offset);
    if (endX < w) {
      ctx.fillStyle = 'rgba(0,0,0,0.14)';
      ctx.fillRect(Math.max(0, endX), 0, w - Math.max(0, endX), hgt);
    }
    // regions
    for (const m of app.markers) {
      if (m.end == null) continue;
      const x0 = this.timeToX(m.time), x1 = this.timeToX(m.end);
      if (x1 < 0 || x0 > w) continue;
      ctx.fillStyle = 'rgba(255,181,71,0.06)';
      ctx.fillRect(x0, 0, x1 - x0, hgt);
    }
    // selection
    const hasRange = sel.end > sel.start;
    if (t.selected && hasRange) {
      const x0 = this.timeToX(sel.start), x1 = this.timeToX(sel.end);
      ctx.fillStyle = this.colors.selBg;
      ctx.fillRect(x0, 0, x1 - x0, hgt);
      ctx.fillStyle = this.colors.selEdge;
      ctx.fillRect(Math.round(x0), 0, 1, hgt);
      ctx.fillRect(Math.round(x1), 0, 1, hgt);
    }
    const nch = t.audio.numberOfChannels;
    const chH = hgt / nch;
    ctx.globalAlpha = app.isAudible(t) ? 1 : 0.35;
    for (let c = 0; c < nch; c++) {
      if (t.view === 'spectrogram') this.drawSpectrogram(ctx, row, t, c, c * chH, chH, w);
      else this.drawWave(ctx, t.audio.channels[c], t.audio.sampleRate, c * chH, chH, w, this.trackColor(t), offset);
      if (c > 0) { ctx.fillStyle = this.colors.line; ctx.fillRect(0, Math.round(c * chH), w, 1); }
    }
    ctx.globalAlpha = 1;
    // point markers
    ctx.fillStyle = 'rgba(92,242,214,0.45)';
    for (const m of app.markers) {
      const x = Math.round(this.timeToX(m.time));
      if (x < 0 || x > w) continue;
      for (let y = 0; y < hgt; y += 6) ctx.fillRect(x, y, 1, 3);
    }
    if (t.recording) {
      ctx.fillStyle = 'rgba(255,91,79,0.08)';
      ctx.fillRect(0, 0, w, hgt);
    }
  }

  drawWave(ctx, ch, sr, y0, H, w, color, offset = 0) {
    const app = this.app;
    const mid = y0 + H / 2;
    const amp = (H / 2) * 0.94 * (app.view.vzoom || 1);
    ctx.fillStyle = this.colors.center;
    ctx.fillRect(0, Math.round(mid), w, 1);
    const n = ch.length;
    if (!n) return;
    const spp = sr / app.view.pxPerSec;
    const start = (app.view.scroll - offset) * sr;
    const rgb = hexToRgb(color);
    const rmsColor = mix(rgb, this.textRgb, 0.45);
    const clipColor = '#ff4a3d';
    const clipCols = [];
    if (spp >= 1) {
      const usePeaks = spp >= PEAK_BLOCK * 1.5;
      const p = usePeaks ? getPeaks(ch) : null;
      const B = PEAK_BLOCK;
      const tops = new Float32Array(w), bots = new Float32Array(w), rmss = new Float32Array(w);
      let last = w;
      for (let x = 0; x < w; x++) {
        const s0 = start + x * spp, s1 = s0 + spp;
        if (s0 >= n) { last = x; break; }
        if (s1 <= 0) { tops[x] = bots[x] = rmss[x] = 0; continue; }
        let mn = 1, mx = -1, r = 0;
        if (usePeaks) {
          const b0 = Math.max(0, Math.floor(s0 / B)), b1 = Math.min(p.count, Math.ceil(s1 / B));
          for (let b = b0; b < b1; b++) {
            if (p.min[b] < mn) mn = p.min[b];
            if (p.max[b] > mx) mx = p.max[b];
            if (p.rms[b] > r) r = p.rms[b];
          }
        } else {
          const i0 = Math.max(0, Math.floor(s0)), i1 = Math.min(n, Math.ceil(s1));
          let sq = 0;
          for (let i = i0; i < i1; i++) { const v = ch[i]; if (v < mn) mn = v; if (v > mx) mx = v; sq += v * v; }
          r = Math.sqrt(sq / Math.max(1, i1 - i0));
        }
        if (mx < mn) { mn = mx = 0; }
        tops[x] = mx; bots[x] = mn; rmss[x] = Math.min(r, Math.max(mx, -mn));
        if (mx >= 0.999 || mn <= -0.999) clipCols.push(x);
      }
      ctx.fillStyle = color;
      for (let x = 0; x < last; x++) {
        const y1 = mid - tops[x] * amp, y2 = mid - bots[x] * amp;
        ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
      if (this.app.settingsShowRms !== false) {
        ctx.fillStyle = rmsColor;
        for (let x = 0; x < last; x++) {
          const r = rmss[x] * amp;
          if (r > 0.5) ctx.fillRect(x, mid - r, 1, 2 * r);
        }
      }
    } else {
      // Zoomed past one sample per pixel: draw the sample curve and sample points.
      const i0 = Math.max(0, Math.floor(start) - 1), i1 = Math.min(n - 1, Math.ceil(start + w * spp) + 1);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) {
        const x = (i - start) / spp, y = mid - ch[i] * amp;
        if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        if (Math.abs(ch[i]) >= 0.999) clipCols.push(Math.round(x));
      }
      ctx.stroke();
      if (1 / spp >= 7) {
        ctx.fillStyle = color;
        for (let i = i0; i <= i1; i++) {
          const x = (i - start) / spp, y = mid - ch[i] * amp;
          ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
          if (1 / spp >= 14) { ctx.globalAlpha *= 0.35; ctx.fillRect(x - 0.5, Math.min(mid, y), 1, Math.abs(y - mid)); ctx.globalAlpha /= 0.35; }
        }
      }
    }
    if (clipCols.length) {
      ctx.fillStyle = clipColor;
      for (const x of clipCols) { ctx.fillRect(x, y0, 1, 3); ctx.fillRect(x, y0 + H - 3, 1, 3); }
    }
  }

  drawSpectrogram(ctx, row, t, c, y0, H, w) {
    const app = this.app, ch = t.audio.channels[c], sr = t.audio.sampleRate;
    const key = `${app.view.scroll}|${app.view.pxPerSec}|${w}|${Math.round(H)}|${this.colors.lane}`;
    row.spec ||= [];
    const cache = row.spec[c];
    let off;
    if (cache && cache.key === key && cache.ch === ch) off = cache.canvas;
    else {
      const N = 1024, bins = N / 2;
      const fft = getFFT(N), win = hann(N);
      const re = new Float64Array(N), im = new Float64Array(N);
      const cw = Math.max(1, Math.round(w)), chh = Math.max(1, Math.round(H));
      off = cache?.canvas || document.createElement('canvas');
      off.width = cw; off.height = chh;
      const octx = off.getContext('2d');
      const img = octx.createImageData(cw, chh);
      const data = img.data;
      const fMin = 30, fMax = sr / 2;
      const rowBin = new Float32Array(chh);
      for (let y = 0; y < chh; y++) rowBin[y] = (fMin * Math.pow(fMax / fMin, 1 - y / (chh - 1 || 1))) / (sr / N);
      const ref = (N / 4) * (N / 4);
      const stepX = cw > 1400 ? 2 : 1;
      const mags = new Float32Array(bins + 1);
      const n = ch.length;
      for (let x = 0; x < cw; x += stepX) {
        const center = Math.round((app.view.scroll + x / app.view.pxPerSec) * sr);
        if (center >= n) break;
        const base = center - N / 2;
        for (let i = 0; i < N; i++) { const k = base + i; re[i] = k >= 0 && k < n ? ch[k] * win[i] : 0; im[i] = 0; }
        fft.forward(re, im);
        for (let k = 0; k <= bins; k++) mags[k] = 10 * Math.log10((re[k] * re[k] + im[k] * im[k]) / ref + 1e-12);
        for (let y = 0; y < chh; y++) {
          const fb = rowBin[y];
          const b0 = Math.floor(fb), fr = fb - b0;
          const v = b0 + 1 <= bins ? mags[b0] * (1 - fr) + mags[b0 + 1] * fr : mags[bins];
          const li = Math.max(0, Math.min(255, Math.round(((v + 100) / 100) * 255))) * 3;
          for (let dx = 0; dx < stepX && x + dx < cw; dx++) {
            const o = (y * cw + x + dx) * 4;
            data[o] = SPEC_LUT[li]; data[o + 1] = SPEC_LUT[li + 1]; data[o + 2] = SPEC_LUT[li + 2]; data[o + 3] = 255;
          }
        }
      }
      octx.putImageData(img, 0, 0);
      row.spec[c] = { key, ch, canvas: off };
    }
    ctx.drawImage(off, 0, y0, w, H);
  }

  drawOverview() {
    const { ctx, w, h: hgt } = setupCanvas(this.overview);
    ctx.clearRect(0, 0, w, hgt);
    const app = this.app;
    if (!app.tracks.length) return;
    const dur = Math.max(app.duration, this.visibleDuration, 0.001);
    if (!this.overviewCache || this.overviewCache.w !== w || this.overviewCache.dur !== dur) {
      const cols = new Float32Array(w);
      for (const t of app.tracks) {
        for (const ch of t.audio.channels) {
          const p = getPeaks(ch);
          const sr = t.audio.sampleRate;
          for (let x = 0; x < w; x++) {
            const b0 = Math.floor(((x / w) * dur * sr) / PEAK_BLOCK), b1 = Math.min(p.count, Math.ceil((((x + 1) / w) * dur * sr) / PEAK_BLOCK));
            let m = cols[x];
            for (let b = b0; b < b1; b++) { const v = Math.max(p.max[b], -p.min[b]); if (v > m) m = v; }
            cols[x] = m;
          }
        }
      }
      this.overviewCache = { w, dur, cols };
    }
    const { cols } = this.overviewCache;
    const mid = hgt / 2;
    ctx.fillStyle = this.colors.faint;
    for (let x = 0; x < w; x++) { const a = Math.min(1, cols[x]) * (hgt / 2 - 3); if (a > 0.3) ctx.fillRect(x, mid - a, 1, a * 2); }
    const sel = app.selection;
    if (sel.end > sel.start) {
      ctx.fillStyle = 'rgba(92,242,214,0.18)';
      ctx.fillRect((sel.start / dur) * w, 0, ((sel.end - sel.start) / dur) * w, hgt);
    }
    const vx = (app.view.scroll / dur) * w, vw = Math.max(4, (this.visibleDuration / dur) * w);
    ctx.fillStyle = 'rgba(255,181,71,0.10)';
    ctx.fillRect(vx, 1, vw, hgt - 2);
    ctx.strokeStyle = this.colors.signal;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(vx) + 0.5, 1.5, Math.round(vw) - 1, hgt - 3);
    const px = (app.playheadTime / dur) * w;
    ctx.fillStyle = this.colors.vfd;
    ctx.fillRect(Math.round(px), 0, 1, hgt);
    this.overviewDur = dur;
  }

  updateOverlay() {
    const app = this.app, w = this.laneWidth;
    const px = this.timeToX(app.playheadTime);
    const show = px >= -1 && px <= w + 1 && app.tracks.length > 0;
    this.playheadEl.style.display = show ? '' : 'none';
    this.rulerPlayhead.style.display = show ? '' : 'none';
    if (show) {
      this.playheadEl.style.transform = `translateX(${px}px)`;
      this.rulerPlayhead.style.transform = `translateX(${px - 5}px)`;
    }
    const sel = app.selection;
    const cx = this.timeToX(sel.start);
    const showCursor = sel.end <= sel.start && cx >= 0 && cx <= w && app.tracks.length > 0 && Math.abs(cx - px) > 0.5;
    this.cursorEl.style.display = showCursor ? '' : 'none';
    if (showCursor) this.cursorEl.style.transform = `translateX(${cx}px)`;
  }

  // ---------- view ----------
  zoomTo(pxPerSec, anchorTime, anchorX) {
    const app = this.app;
    const sr = app.sampleRate;
    const fitPps = this.laneWidth / Math.max(0.5, app.duration * 1.02);
    const min = Math.min(fitPps, 1) * 0.5, max = sr * 40;
    const pps = clamp(pxPerSec, Math.max(0.0005, min), max);
    const ax = anchorX ?? this.timeToX(anchorTime ?? app.view.scroll);
    const at = anchorTime ?? this.xToTime(ax);
    app.view.pxPerSec = pps;
    this.setScroll(at - ax / pps);
  }

  setScroll(t) {
    const app = this.app;
    const maxScroll = Math.max(0, Math.max(app.duration, app.playheadTime) - this.visibleDuration * 0.5);
    app.view.scroll = clamp(t, 0, Math.max(maxScroll, 0));
    this.overviewCache && (this.overviewCache.dur !== Math.max(app.duration, this.visibleDuration, 0.001)) && (this.overviewCache = null);
    this.invalidate();
  }

  zoomFit() {
    const d = Math.max(this.app.duration, 1);
    this.app.view.pxPerSec = this.laneWidth / (d * 1.02);
    this.setScroll(0);
  }

  zoomToRange(a, b) {
    if (b - a <= 0) return;
    this.app.view.pxPerSec = clamp(this.laneWidth / ((b - a) * 1.1), 0.0005, this.app.sampleRate * 40);
    this.setScroll(a - (b - a) * 0.05);
  }

  ensureVisible(t, margin = 0.05) {
    const vis = this.visibleDuration, s = this.app.view.scroll;
    if (t < s || t > s + vis) this.setScroll(t - vis * margin);
  }

  followPlayhead(t) {
    const vis = this.visibleDuration, s = this.app.view.scroll;
    if (t > s + vis * 0.98 || t < s) this.setScroll(t - vis * 0.02);
  }

  // ---------- interaction ----------
  rowIndexAt(clientY) {
    const tracks = this.app.tracks;
    for (let i = 0; i < tracks.length; i++) {
      const r = this.rows.get(tracks[i].id)?.el.getBoundingClientRect();
      if (r && clientY < r.bottom) return i;
    }
    return tracks.length - 1;
  }

  edgeAt(x, trackId) {
    const app = this.app, sel = app.selection, t = app.trackById(trackId);
    if (!t?.selected || sel.end <= sel.start) return null;
    if (Math.abs(x - this.timeToX(sel.start)) <= 6) return 'start';
    if (Math.abs(x - this.timeToX(sel.end)) <= 6) return 'end';
    return null;
  }

  onLaneHover(e, trackId) {
    const x = e.clientX - this.originX;
    this.rows.get(trackId)?.lane.classList.toggle('edge', !!this.edgeAt(x, trackId));
  }

  onLaneDown(e, trackId) {
    if (e.button !== 0) return;
    e.preventDefault();
    this.scrollEl.focus({ preventScroll: true });
    const app = this.app;
    const lane = e.currentTarget;
    const x = e.clientX - this.originX;
    const t = Math.max(0, this.xToTime(x));
    const sel = app.selection;
    const edge = this.edgeAt(x, trackId);
    let anchor;
    let multiRows = true;
    if (edge) { anchor = edge === 'start' ? sel.end : sel.start; multiRows = false; }
    else if (e.shiftKey && app.tracks.some(tr => tr.selected)) {
      anchor = t < (sel.start + sel.end) / 2 ? sel.end : sel.start;
      if (!app.trackById(trackId).selected) app.clickTrack(trackId, { toggle: true });
      multiRows = false;
    } else {
      anchor = t;
      if (e.ctrlKey || e.metaKey) { app.clickTrack(trackId, { toggle: true }); multiRows = false; }
      else app.clickTrack(trackId, {});
      app.setSelection(t, t, { silent: true });
    }
    const startIdx = this.rowIndexAt(e.clientY);
    const startX = e.clientX;
    let moved = false, lastX = e.clientX, lastY = e.clientY, timer = 0;
    lane.setPointerCapture(e.pointerId);
    const update = () => {
      const t2 = Math.max(0, this.xToTime(lastX - this.originX));
      app.setSelection(Math.min(anchor, t2), Math.max(anchor, t2), { silent: true });
      if (multiRows) app.selectTrackRange(startIdx, this.rowIndexAt(lastY));
      this.invalidate();
      app.emitSelection();
    };
    const auto = () => {
      const x2 = lastX - this.originX, w = this.laneWidth;
      const edgeDist = x2 < 0 ? x2 : x2 > w ? x2 - w : 0;
      if (edgeDist) { this.setScroll(app.view.scroll + (edgeDist / app.view.pxPerSec) * 0.5); update(); }
      timer = requestAnimationFrame(auto);
    };
    const move = (ev) => {
      lastX = ev.clientX; lastY = ev.clientY;
      if (!moved && Math.abs(ev.clientX - startX) < 3) return;
      if (!moved) { moved = true; timer = requestAnimationFrame(auto); }
      update();
    };
    const up = () => {
      cancelAnimationFrame(timer);
      lane.removeEventListener('pointermove', move);
      lane.removeEventListener('pointerup', up);
      lane.removeEventListener('pointercancel', up);
      if (!moved && !edge && !e.shiftKey) app.setCursor(t);
      else app.selectionCommitted();
    };
    lane.addEventListener('pointermove', move);
    lane.addEventListener('pointerup', up);
    lane.addEventListener('pointercancel', up);
  }

  bind() {
    const app = this.app;
    this.scrollEl.addEventListener('wheel', (e) => {
      if (!app.tracks.length) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const x = e.clientX - this.originX;
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
        this.zoomTo(app.view.pxPerSec * factor, this.xToTime(x), x);
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const d = (e.shiftKey ? e.deltaY || e.deltaX : e.deltaX) * (e.deltaMode === 1 ? 20 : 1);
        this.setScroll(app.view.scroll + d / app.view.pxPerSec);
      }
    }, { passive: false });
    this.ruler.addEventListener('wheel', (e) => {
      if (!app.tracks.length) return;
      e.preventDefault();
      const x = e.clientX - this.originX;
      this.zoomTo(app.view.pxPerSec * Math.exp(-e.deltaY * 0.0025), this.xToTime(x), x);
    }, { passive: false });

    // Ruler: click to place the playhead, drag to select, drag a flag to move a marker.
    this.ruler.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = this.ruler.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const t = Math.max(0, this.xToTime(x));
      const hit = y < 16 ? app.markers.find(m => x >= this.timeToX(m.time) - 3 && x <= this.timeToX(m.time) + 9) : null;
      this.ruler.setPointerCapture(e.pointerId);
      let moved = false;
      const startX = e.clientX;
      const move = (ev) => {
        if (!moved && Math.abs(ev.clientX - startX) < 3) return;
        moved = true;
        const t2 = Math.max(0, this.xToTime(ev.clientX - r.left));
        if (hit) app.moveMarker(hit.id, t2, { live: true });
        else {
          if (!app.tracks.some(tr => tr.selected)) app.selectAllTracks();
          app.setSelection(Math.min(t, t2), Math.max(t, t2));
        }
      };
      const up = () => {
        this.ruler.removeEventListener('pointermove', move);
        this.ruler.removeEventListener('pointerup', up);
        if (hit && moved) app.moveMarker(hit.id, null, { commit: true });
        else if (hit) app.seek(hit.time);
        else if (!moved) app.setCursor(t);
        else app.selectionCommitted();
      };
      this.ruler.addEventListener('pointermove', move);
      this.ruler.addEventListener('pointerup', up);
    });
    this.ruler.addEventListener('dblclick', (e) => {
      const x = e.clientX - this.ruler.getBoundingClientRect().left;
      app.addMarker(Math.max(0, this.xToTime(x)));
    });

    // Overview: drag the viewport.
    this.overview.addEventListener('pointerdown', (e) => {
      if (!app.tracks.length) return;
      e.preventDefault();
      this.overview.setPointerCapture(e.pointerId);
      this.overview.classList.add('dragging');
      const r = this.overview.getBoundingClientRect();
      const toTime = (cx) => ((cx - r.left) / r.width) * (this.overviewDur || app.duration);
      const vis = this.visibleDuration;
      const t0 = toTime(e.clientX);
      const inside = t0 >= app.view.scroll && t0 <= app.view.scroll + vis;
      const grab = inside ? t0 - app.view.scroll : vis / 2;
      this.setScroll(t0 - grab);
      const move = (ev) => this.setScroll(toTime(ev.clientX) - grab);
      const up = () => {
        this.overview.classList.remove('dragging');
        this.overview.removeEventListener('pointermove', move);
        this.overview.removeEventListener('pointerup', up);
      };
      this.overview.addEventListener('pointermove', move);
      this.overview.addEventListener('pointerup', up);
    });

    this.scrollEl.addEventListener('scroll', () => this.updateOverlay(), { passive: true });
  }
}
