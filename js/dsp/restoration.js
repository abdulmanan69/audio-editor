// Restoration: spectral noise reduction, silence truncation, hum, clicks, sibilance.
import { AudioData, mapChannels } from '../core/audio-data.js';
import { dbToGain } from '../core/format.js';
import { getFFT, hann } from './fft.js';
import { design, processCascade, butterworth } from './biquad.js';

const NR_FFT = 2048;

function frameMagnitudes(ch, N, hop, onFrame) {
  const fft = getFFT(N), win = hann(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const bins = N / 2 + 1;
  const mag = new Float64Array(bins);
  for (let pos = 0; pos + N <= ch.length; pos += hop) {
    for (let i = 0; i < N; i++) { re[i] = ch[pos + i] * win[i]; im[i] = 0; }
    fft.forward(re, im);
    let energy = 0;
    for (let k = 0; k < bins; k++) { mag[k] = Math.hypot(re[k], im[k]); energy += mag[k] * mag[k]; }
    onFrame(mag, energy);
  }
}

// Average magnitude spectrum of a noise-only selection.
export function captureNoiseProfile(a, N = NR_FFT) {
  const bins = N / 2 + 1, mean = new Float64Array(bins);
  let frames = 0;
  for (const ch of a.channels) {
    frameMagnitudes(ch, N, N / 4, (mag) => { for (let k = 0; k < bins; k++) mean[k] += mag[k]; frames++; });
  }
  if (!frames) return null;
  for (let k = 0; k < bins; k++) mean[k] /= frames;
  return { fftSize: N, sampleRate: a.sampleRate, mean: Float32Array.from(mean), frames, capturedAt: Date.now() };
}

// Estimate a profile from the quietest 10% of frames when no profile was captured.
export function estimateNoiseProfile(a, N = NR_FFT) {
  const bins = N / 2 + 1;
  const frames = [];
  for (const ch of a.channels) frameMagnitudes(ch, N, N / 2, (mag, e) => frames.push({ e, mag: Float32Array.from(mag) }));
  if (!frames.length) return null;
  frames.sort((x, y) => x.e - y.e);
  const take = frames.slice(0, Math.max(1, Math.round(frames.length * 0.1)));
  const mean = new Float32Array(bins);
  for (const f of take) for (let k = 0; k < bins; k++) mean[k] += f.mag[k] / take.length;
  return { fftSize: N, sampleRate: a.sampleRate, mean, frames: take.length, estimated: true };
}

export function noiseReduce(a, profile, { reductionDb = 12, sensitivityDb = 6, smoothingBands = 3, attackMs = 20, releaseMs = 120 } = {}) {
  const prof = profile && profile.fftSize ? profile : estimateNoiseProfile(a);
  if (!prof) return a;
  const N = prof.fftSize, hop = N / 4, bins = N / 2 + 1;
  const fft = getFFT(N), win = hann(N);
  const sens = dbToGain(sensitivityDb), floor = dbToGain(-reductionDb);
  const thr = new Float64Array(bins);
  for (let k = 0; k < bins; k++) thr[k] = prof.mean[k] * sens;
  const frameSec = hop / a.sampleRate;
  const up = 1 - Math.exp(-frameSec / Math.max(1e-3, attackMs / 1000));
  const down = 1 - Math.exp(-frameSec / Math.max(1e-3, releaseMs / 1000));
  const B = Math.max(0, Math.round(smoothingBands));

  return mapChannels(a, ch => {
    const len = ch.length;
    const padded = new Float32Array(len + 2 * N);
    padded.set(ch, N);
    const out = new Float32Array(padded.length);
    const re = new Float64Array(N), im = new Float64Array(N);
    const g = new Float64Array(bins), gs = new Float64Array(bins), prev = new Float64Array(bins).fill(1);
    for (let pos = 0; pos + N <= padded.length; pos += hop) {
      for (let i = 0; i < N; i++) { re[i] = padded[pos + i] * win[i]; im[i] = 0; }
      fft.forward(re, im);
      for (let k = 0; k < bins; k++) g[k] = Math.hypot(re[k], im[k]) > thr[k] ? 1 : floor;
      for (let k = 0; k < bins; k++) {
        let s = 0, c = 0;
        for (let j = Math.max(0, k - B); j <= Math.min(bins - 1, k + B); j++) { s += g[j]; c++; }
        const target = s / c;
        const v = prev[k] + (target - prev[k]) * (target > prev[k] ? up : down);
        gs[k] = v; prev[k] = v;
      }
      re[0] *= gs[0]; im[0] *= gs[0];
      re[N / 2] *= gs[N / 2]; im[N / 2] *= gs[N / 2];
      for (let k = 1; k < N / 2; k++) {
        re[k] *= gs[k]; im[k] *= gs[k];
        re[N - k] *= gs[k]; im[N - k] *= gs[k];
      }
      fft.inverse(re, im);
      for (let i = 0; i < N; i++) out[pos + i] += re[i] * win[i];
    }
    const res = new Float32Array(len);
    for (let i = 0; i < len; i++) res[i] = out[i + N] / 1.5;
    return res;
  });
}

// Shorten silent stretches longer than `minSec` down to `keepSec`.
export function truncateSilence(a, { thresholdDb = -45, minSec = 0.6, keepSec = 0.25 } = {}) {
  const sr = a.sampleRate, n = a.length;
  const win = Math.max(1, Math.round(sr * 0.01));
  const thr = dbToGain(thresholdDb);
  const nw = Math.ceil(n / win);
  const quiet = new Uint8Array(nw);
  for (let w = 0; w < nw; w++) {
    let sq = 0, cnt = 0;
    for (const ch of a.channels) for (let i = w * win; i < Math.min(n, (w + 1) * win); i++) { sq += ch[i] * ch[i]; cnt++; }
    quiet[w] = Math.sqrt(sq / Math.max(1, cnt)) < thr ? 1 : 0;
  }
  const keep = [];
  let cursor = 0;
  const minW = Math.ceil((minSec * sr) / win);
  const keepN = Math.round(keepSec * sr);
  for (let w = 0; w < nw;) {
    if (!quiet[w]) { w++; continue; }
    let e = w;
    while (e < nw && quiet[e]) e++;
    if (e - w >= minW) {
      const s0 = w * win, s1 = Math.min(n, e * win);
      const half = Math.floor(keepN / 2);
      keep.push([cursor, s0 + half]);
      cursor = Math.max(s0 + half, s1 - (keepN - half));
    }
    w = e;
  }
  keep.push([cursor, n]);
  const total = keep.reduce((s, [x, y]) => s + Math.max(0, y - x), 0);
  if (total === n) return a;
  return new AudioData(a.channels.map(ch => {
    const o = new Float32Array(total);
    let off = 0;
    for (const [x, y] of keep) { if (y > x) { o.set(ch.subarray(x, y), off); off += y - x; } }
    return o;
  }), sr);
}

export function humRemoval(a, { baseHz = 50, harmonics = 5, q = 30 } = {}) {
  const sections = [];
  for (let h = 1; h <= harmonics; h++) {
    const f = baseHz * h;
    if (f < a.sampleRate * 0.45) sections.push(design('notch', f, a.sampleRate, q));
  }
  return mapChannels(a, ch => processCascade(ch, sections));
}

// Detect impulsive clicks via the second-difference residual and patch them with
// Hermite interpolation between clean neighbours.
export function declick(a, { sensitivity = 6, maxWidthMs = 2 } = {}) {
  const sr = a.sampleRate;
  const maxW = Math.max(2, Math.round((maxWidthMs / 1000) * sr));
  const block = 1024;
  return mapChannels(a, ch => {
    const n = ch.length, o = new Float32Array(ch);
    const d = new Float32Array(n);
    for (let i = 2; i < n; i++) d[i] = Math.abs(ch[i] - 2 * ch[i - 1] + ch[i - 2]);
    for (let b = 0; b < n; b += block) {
      const e = Math.min(n, b + block);
      let mean = 0;
      for (let i = b; i < e; i++) mean += d[i];
      mean /= Math.max(1, e - b);
      const thr = mean * sensitivity + 1e-4;
      for (let i = Math.max(2, b); i < e; i++) {
        if (d[i] <= thr) continue;
        let j = i;
        while (j < n && j - i < maxW && d[j] > thr * 0.5) j++;
        const s = Math.max(1, i - 3), t = Math.min(n - 2, j + 3);
        const p0 = o[s - 1], p1 = o[s], p2 = o[t], p3 = o[t + 1];
        const m1 = (p2 - p0) / 2, m2 = (p3 - p1) / 2;
        const span = t - s;
        for (let k = 1; k < span; k++) {
          const u = k / span, u2 = u * u, u3 = u2 * u;
          o[s + k] = (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * m2;
        }
        i = j;
      }
    }
    return o;
  });
}

// Split-band de-esser: compress only the band above `freq` when it exceeds threshold.
export function deEss(a, { freq = 5500, thresholdDb = -28, reductionDb = 8 } = {}) {
  const sr = a.sampleRate;
  const hp = butterworth('highpass', freq, sr, 4);
  const thr = dbToGain(thresholdDb), maxRed = dbToGain(-reductionDb);
  const aa = Math.exp(-1 / (0.001 * sr)), ar = Math.exp(-1 / (0.06 * sr));
  const bands = a.channels.map(ch => processCascade(ch, hp));
  const n = a.length;
  const gains = new Float32Array(n);
  let env = 0;
  for (let i = 0; i < n; i++) {
    let l = 0;
    for (const b of bands) { const v = Math.abs(b[i]); if (v > l) l = v; }
    env = l > env ? aa * env + (1 - aa) * l : ar * env + (1 - ar) * l;
    gains[i] = env > thr ? Math.max(maxRed, thr / env) : 1;
  }
  return mapChannels(a, (ch, c) => {
    const band = bands[c], o = new Float32Array(n);
    for (let i = 0; i < n; i++) o[i] = ch[i] - band[i] * (1 - gains[i]);
    return o;
  });
}

// ---------- Stereo field ----------
export function stereoWidth(a, width = 1.5) {
  if (a.numberOfChannels < 2) return a;
  const [L, R] = a.channels, n = a.length;
  const oL = new Float32Array(n), oR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5 * width;
    oL[i] = m + s; oR[i] = m - s;
  }
  return new AudioData([oL, oR, ...a.channels.slice(2).map(c => new Float32Array(c))], a.sampleRate);
}

export function swapChannels(a) {
  if (a.numberOfChannels < 2) return a;
  const ch = a.channels.map(c => new Float32Array(c));
  [ch[0], ch[1]] = [ch[1], ch[0]];
  return new AudioData(ch, a.sampleRate);
}

// Center-channel cancellation that keeps the low end (bass and kick are usually centred).
export function vocalRemove(a, { keepBassHz = 120 } = {}) {
  if (a.numberOfChannels < 2) return a;
  const [L, R] = a.channels, n = a.length, sr = a.sampleRate;
  const mid = new Float32Array(n), side = new Float32Array(n);
  for (let i = 0; i < n; i++) { mid[i] = (L[i] + R[i]) * 0.5; side[i] = (L[i] - R[i]) * 0.5; }
  const bass = keepBassHz > 0 ? processCascade(mid, butterworth('lowpass', keepBassHz, sr, 4)) : new Float32Array(n);
  const sideHp = keepBassHz > 0 ? processCascade(side, butterworth('highpass', keepBassHz, sr, 4)) : side;
  const oL = new Float32Array(n), oR = new Float32Array(n);
  for (let i = 0; i < n; i++) { oL[i] = bass[i] + sideHp[i]; oR[i] = bass[i] - sideHp[i]; }
  return new AudioData([oL, oR], sr);
}

export function monoMix(a) {
  if (a.numberOfChannels < 2) return a;
  const n = a.length, m = new Float32Array(n), k = 1 / a.numberOfChannels;
  for (const ch of a.channels) for (let i = 0; i < n; i++) m[i] += ch[i] * k;
  return new AudioData(a.channels.map(() => new Float32Array(m)), a.sampleRate);
}
