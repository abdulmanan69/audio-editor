// Output level meters (segmented LED bars with peak hold) and a live spectrum analyzer.
import { setupCanvas } from './dom.js';

const DB_MIN = -60;
const dbToX = (db, w) => Math.max(0, Math.min(1, (db - DB_MIN) / -DB_MIN)) * w;

export class LevelMeter {
  constructor(canvas, readout) {
    this.canvas = canvas;
    this.readout = readout;
    this.levels = [DB_MIN, DB_MIN];
    this.holds = [DB_MIN, DB_MIN];
    this.holdTimes = [0, 0];
    this.clip = false;
    this.maxPeak = -Infinity;
    this.active = false;
  }

  // peaks: linear peak per channel for the latest frame; rms likewise.
  update(peaks, rms) {
    const now = performance.now();
    for (let c = 0; c < 2; c++) {
      const p = peaks[Math.min(c, peaks.length - 1)] ?? 0;
      const db = p > 0 ? 20 * Math.log10(p) : -Infinity;
      // Fast attack, ~20 dB/s fall-off.
      this.levels[c] = Math.max(db, this.levels[c] - 0.33);
      if (db >= this.holds[c] || now - this.holdTimes[c] > 1500) { this.holds[c] = Math.max(db, DB_MIN); this.holdTimes[c] = now; }
      if (p >= 0.999) this.clip = true;
      if (db > this.maxPeak) this.maxPeak = db;
    }
    this.rms = rms;
    this.draw();
  }

  decay() {
    let live = false;
    for (let c = 0; c < 2; c++) {
      this.levels[c] = Math.max(DB_MIN, this.levels[c] - 0.6);
      if (this.levels[c] > DB_MIN) live = true;
      if (performance.now() - this.holdTimes[c] > 1500) this.holds[c] = Math.max(DB_MIN, this.holds[c] - 0.8);
      if (this.holds[c] > DB_MIN) live = true;
    }
    this.draw();
    return live;
  }

  resetPeak() { this.clip = false; this.maxPeak = -Infinity; this.draw(); }

  draw() {
    if (!this.canvas.offsetParent) return;
    const { ctx, w, h } = setupCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const barH = 9, gap = 4, top = 5, labelY = h - 3;
    const segW = 3, segGap = 1;
    for (let c = 0; c < 2; c++) {
      const y = top + c * (barH + gap);
      const lit = dbToX(this.levels[c], w);
      for (let x = 0; x < w; x += segW + segGap) {
        const db = DB_MIN + (x / w) * -DB_MIN;
        const color = db > -3 ? '#ff4a3d' : db > -12 ? '#ffb547' : '#5cf2d6';
        ctx.globalAlpha = x < lit ? 1 : 0.1;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, segW, barH);
      }
      ctx.globalAlpha = 1;
      const hx = dbToX(this.holds[c], w);
      if (this.holds[c] > DB_MIN) { ctx.fillStyle = '#e6e1d3'; ctx.fillRect(Math.min(w - 2, hx), y, 2, barH); }
    }
    ctx.fillStyle = 'rgba(92,242,214,0.45)';
    ctx.font = '500 7px "IBM Plex Mono", monospace';
    ctx.textBaseline = 'alphabetic';
    for (const db of [-48, -36, -24, -12, -6, -3, 0]) {
      const x = dbToX(db, w);
      ctx.textAlign = db === 0 ? 'right' : 'center';
      ctx.fillText(String(Math.abs(db)), db === 0 ? w - 1 : x, labelY);
    }
    if (this.readout) {
      const v = this.maxPeak;
      this.readout.firstElementChild.textContent = isFinite(v) ? v.toFixed(1) : '-∞';
      this.readout.classList.toggle('clip', this.clip);
    }
  }
}

export class SpectrumView {
  constructor(canvas) {
    this.canvas = canvas;
    this.smoothed = null;
  }

  // data: Float32Array of dB values from AnalyserNode.getFloatFrequencyData
  draw(data, sampleRate) {
    if (!this.canvas.offsetParent) return;
    const { ctx, w, h } = setupCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const fMin = 20, fMax = Math.min(20000, sampleRate / 2);
    const xOf = (f) => (Math.log(f / fMin) / Math.log(fMax / fMin)) * w;
    ctx.strokeStyle = 'rgba(92,242,214,0.08)';
    ctx.fillStyle = 'rgba(92,242,214,0.4)';
    ctx.font = '500 8px "IBM Plex Mono", monospace';
    ctx.lineWidth = 1;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = Math.round(xOf(f)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : f, x + 2, h - 3);
    }
    for (const db of [-20, -40, -60, -80]) {
      const y = Math.round((-db / 100) * h) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    if (!data) return;
    if (!this.smoothed || this.smoothed.length !== data.length) this.smoothed = new Float32Array(data).fill(-120);
    const s = this.smoothed;
    for (let i = 0; i < data.length; i++) s[i] = Math.max(data[i], s[i] - 1.2);
    const binHz = sampleRate / 2 / data.length;
    ctx.beginPath();
    let started = false;
    for (let x = 0; x <= w; x++) {
      const f = fMin * Math.pow(fMax / fMin, x / w);
      const f2 = fMin * Math.pow(fMax / fMin, (x + 1) / w);
      const b0 = Math.floor(f / binHz), b1 = Math.max(b0 + 1, Math.floor(f2 / binHz));
      let m = -140;
      for (let b = b0; b < b1 && b < s.length; b++) if (s[b] > m) m = s[b];
      const y = Math.min(h, Math.max(0, (-m / 100) * h));
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255,181,71,0.55)');
    grad.addColorStop(1, 'rgba(92,242,214,0.05)');
    ctx.strokeStyle = '#5cf2d6';
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }
}
