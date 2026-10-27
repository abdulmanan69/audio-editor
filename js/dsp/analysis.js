// Measurement helpers: levels, spectrum, clipping and silence detection, zero crossings.
import { getFFT, hann } from './fft.js';
import { gainToDb } from '../core/format.js';

export function channelStats(a) {
  return a.channels.map(ch => {
    let peak = 0, min = 0, max = 0, sq = 0, sum = 0, clipped = 0;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      if (v > max) max = v;
      if (v < min) min = v;
      const av = v < 0 ? -v : v;
      if (av > peak) peak = av;
      if (av >= 0.999) clipped++;
      sq += v * v;
      sum += v;
    }
    const n = Math.max(1, ch.length);
    const rms = Math.sqrt(sq / n);
    return {
      peak, peakDb: gainToDb(peak), rms, rmsDb: gainToDb(rms),
      min, max, dc: sum / n, clipped,
      crestDb: rms > 0 ? gainToDb(peak / rms) : 0,
    };
  });
}

// Averaged power spectrum (dB) across frames and channels, capped for speed on long input.
export function averageSpectrum(a, N = 4096, maxFrames = 1500) {
  const fft = getFFT(N), win = hann(N);
  const bins = N / 2 + 1;
  const acc = new Float64Array(bins);
  const re = new Float64Array(N), im = new Float64Array(N);
  let frames = 0;
  const totalFrames = Math.max(1, Math.floor((a.length - N) / (N / 2)) + 1);
  const stride = Math.max(N / 2, Math.floor(((totalFrames / maxFrames) * N) / 2));
  let wsum = 0;
  for (let i = 0; i < N; i++) wsum += win[i];
  for (const ch of a.channels) {
    for (let pos = 0; pos + N <= Math.max(N, ch.length); pos += stride) {
      for (let i = 0; i < N; i++) { re[i] = (ch[pos + i] || 0) * win[i]; im[i] = 0; }
      fft.forward(re, im);
      for (let k = 0; k < bins; k++) acc[k] += (re[k] * re[k] + im[k] * im[k]);
      frames++;
    }
  }
  const out = new Float32Array(bins);
  const norm = 1 / (Math.max(1, frames) * (wsum / 2) * (wsum / 2));
  for (let k = 0; k < bins; k++) out[k] = 10 * Math.log10(acc[k] * norm + 1e-20);
  return out;
}

export function findClipping(a, { threshold = 0.999, minRun = 3 } = {}) {
  const regions = [];
  const n = a.length;
  let start = -1;
  for (let i = 0; i <= n; i++) {
    let clip = false;
    if (i < n) for (const ch of a.channels) if (Math.abs(ch[i]) >= threshold) { clip = true; break; }
    if (clip && start < 0) start = i;
    else if (!clip && start >= 0) {
      if (i - start >= minRun) regions.push({ start, end: i });
      start = -1;
    }
  }
  // Merge clusters that sit within 10 ms of each other.
  const gap = Math.round(a.sampleRate * 0.01);
  const merged = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < gap) last.end = r.end; else merged.push({ ...r });
  }
  return merged;
}

export function findSilence(a, { thresholdDb = -50, minSec = 1 } = {}) {
  const sr = a.sampleRate, n = a.length;
  const win = Math.max(1, Math.round(sr * 0.01));
  const thr = Math.pow(10, thresholdDb / 20);
  const regions = [];
  let start = -1;
  for (let w = 0; w * win <= n; w++) {
    const s = w * win, e = Math.min(n, s + win);
    let sq = 0, cnt = 0;
    for (const ch of a.channels) for (let i = s; i < e; i++) { sq += ch[i] * ch[i]; cnt++; }
    const quiet = e > s && Math.sqrt(sq / Math.max(1, cnt)) < thr;
    if (quiet && start < 0) start = s;
    if ((!quiet || e >= n) && start >= 0) {
      const end = quiet ? e : s;
      if ((end - start) / sr >= minSec) regions.push({ start, end });
      start = -1;
    }
  }
  return regions;
}

// Sample index of the zero crossing nearest `at` (within `radius`) on the mono sum.
export function nearestZeroCrossing(a, at, radius) {
  const n = a.length;
  const mono = (i) => { let s = 0; for (const ch of a.channels) s += ch[i]; return s; };
  const pos = Math.max(1, Math.min(n - 1, Math.round(at)));
  for (let d = 0; d <= radius; d++) {
    for (const i of [pos - d, pos + d]) {
      if (i < 1 || i >= n) continue;
      const x0 = mono(i - 1), x1 = mono(i);
      if (x0 === 0 || (x0 < 0) !== (x1 < 0)) return i;
    }
  }
  return pos;
}
