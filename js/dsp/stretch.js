// Resampling and WSOLA time-stretching (tempo change without pitch change).
import { butterworth, processCascade } from './biquad.js';
import { hann } from './fft.js';

// Read `ch` at fractional positions i*ratio with 4-point Hermite interpolation.
// ratio > 1 shortens (speeds up), ratio < 1 lengthens. Low-passes first when decimating.
export function resample(ch, ratio, sampleRate = 48000, outLength) {
  const len = ch.length;
  const n = outLength ?? Math.max(0, Math.round(len / ratio));
  let src = ch;
  if (ratio > 1.02) {
    const cutoff = (sampleRate / 2 / ratio) * 0.92;
    src = processCascade(ch, butterworth('lowpass', cutoff, sampleRate, 8));
  }
  const out = new Float32Array(n);
  const at = (i) => (i < 0 ? src[0] : i >= len ? src[len - 1] : src[i]);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const k = Math.floor(pos);
    const t = pos - k;
    const xm1 = at(k - 1), x0 = at(k), x1 = at(k + 1), x2 = at(k + 2);
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    out[i] = ((c3 * t + c2) * t + c1) * t + x0;
  }
  return out;
}

// tempo > 1 → faster/shorter. Returns new channel arrays, phase-coherent across channels.
export function wsola(channels, tempo, sampleRate) {
  const len = channels[0].length;
  if (Math.abs(tempo - 1) < 1e-4 || len === 0) return channels.map(c => new Float32Array(c));
  let N = Math.round(sampleRate * 0.046);
  N += N % 2;
  const Hs = N / 2;
  const delta = Math.round(sampleRate * 0.012);
  const outLen = Math.max(1, Math.round(len / tempo));
  const win = hann(N);

  // Mono guide signal for similarity search.
  const guide = new Float32Array(len);
  for (const ch of channels) for (let i = 0; i < len; i++) guide[i] += ch[i];

  const outs = channels.map(() => new Float32Array(outLen + N));
  const norm = new Float32Array(outLen + N);
  let prev = 0;
  for (let k = 0; ; k++) {
    const outPos = k * Hs;
    if (outPos >= outLen) break;
    let pos = 0;
    if (k > 0) {
      const nominal = Math.round(k * Hs * tempo);
      pos = bestMatch(guide, prev + Hs, nominal, delta, Hs, len);
    }
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c], dst = outs[c];
      const lim = Math.min(N, len - pos);
      for (let i = 0; i < lim; i++) dst[outPos + i] += src[pos + i] * win[i];
    }
    for (let i = 0; i < N; i++) norm[outPos + i] += win[i];
    prev = pos;
  }
  return outs.map(o => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-3 ? o[i] / norm[i] : o[i];
    return r;
  });
}

function bestMatch(x, natural, nominal, delta, L, len) {
  const lo = Math.max(0, nominal - delta);
  const hi = Math.min(len - 1, nominal + delta);
  if (natural >= len) return Math.min(Math.max(nominal, 0), len - 1);
  let best = -Infinity, bestPos = Math.min(Math.max(nominal, lo), hi);
  const score = (cand, stride) => {
    let s = 0, e = 1e-9;
    for (let i = 0; i < L; i += stride) {
      const a = natural + i, b = cand + i;
      if (a >= len || b >= len) break;
      const xb = x[b];
      s += x[a] * xb;
      e += xb * xb;
    }
    return s / Math.sqrt(e);
  };
  for (let cand = lo; cand <= hi; cand += 3) {
    const s = score(cand, 4);
    if (s > best) { best = s; bestPos = cand; }
  }
  const r0 = Math.max(lo, bestPos - 3), r1 = Math.min(hi, bestPos + 3);
  best = -Infinity;
  for (let cand = r0; cand <= r1; cand++) {
    const s = score(cand, 2);
    if (s > best) { best = s; bestPos = cand; }
  }
  return bestPos;
}

// Shift pitch by `semitones` while keeping duration.
export function pitchShift(channels, semitones, sampleRate) {
  const r = Math.pow(2, semitones / 12);
  if (Math.abs(r - 1) < 1e-5) return channels.map(c => new Float32Array(c));
  const len = channels[0].length;
  const stretched = wsola(channels, 1 / r, sampleRate);
  return stretched.map(ch => resample(ch, r, sampleRate, len));
}
