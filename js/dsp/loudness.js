// ITU-R BS.1770-4 / EBU R128 loudness: integrated, momentary/short-term max, LRA, true peak.
import { processBiquad } from './biquad.js';

// K-weighting coefficients for any sample rate (bilinear derivation used by libebur128;
// reproduces the BS.1770 48 kHz table exactly).
function kFilters(sr) {
  const shelf = (() => {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    const K = Math.tan(Math.PI * f0 / sr);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;
    return {
      b0: (Vh + Vb * K / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - Vb * K / Q + K * K) / a0,
      a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0,
    };
  })();
  const hp = (() => {
    const f0 = 38.13547087602444, Q = 0.5003270373238773;
    const K = Math.tan(Math.PI * f0 / sr);
    const a0 = 1 + K / Q + K * K;
    return { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  })();
  return [shelf, hp];
}

const toLufs = (z) => (z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity);

export function measureLoudness(audio) {
  const sr = audio.sampleRate, len = audio.length;
  const [shelf, hp] = kFilters(sr);
  const weights = audio.channels.map((_, c) => (c < 3 ? 1 : 1.41));
  // Prefix sums of K-weighted energy, summed across channels with weights.
  const P = new Float64Array(len + 1);
  audio.channels.forEach((ch, c) => {
    const y = processBiquad(processBiquad(ch, shelf), hp);
    const w = weights[c];
    let acc = 0;
    for (let i = 0; i < len; i++) { acc += w * y[i] * y[i]; P[i + 1] += acc; }
  });
  const blockZ = (win, step) => {
    const zs = [];
    if (len < win) { if (len > 0) zs.push((P[len] - P[0]) / len); return zs; }
    for (let s = 0; s + win <= len; s += step) zs.push((P[s + win] - P[s]) / win);
    return zs;
  };
  const mz = blockZ(Math.round(0.4 * sr), Math.round(0.1 * sr));
  const sz = blockZ(Math.round(3 * sr), Math.round(0.1 * sr));

  const gate = (zs, rel) => {
    const abs = zs.filter(z => toLufs(z) > -70);
    if (!abs.length) return { abs, rel: [] , relThresh: -Infinity };
    const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
    const relThresh = toLufs(mean) - rel;
    return { abs, rel: abs.filter(z => toLufs(z) > relThresh), relThresh };
  };

  const gi = gate(mz, 10);
  const integrated = gi.rel.length ? toLufs(gi.rel.reduce((a, b) => a + b, 0) / gi.rel.length) : -Infinity;
  const momentaryMax = mz.length ? toLufs(Math.max(...mz)) : -Infinity;
  const shortTermMax = sz.length ? toLufs(Math.max(...sz)) : momentaryMax;

  const gs = gate(sz, 20);
  let lra = 0;
  if (gs.rel.length > 1) {
    const vals = gs.rel.map(toLufs).sort((a, b) => a - b);
    const pct = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round((p / 100) * (vals.length - 1))))];
    lra = pct(95) - pct(10);
  }
  return { integrated, momentaryMax, shortTermMax, lra };
}

// 4× oversampled peak using a 32-tap Blackman-windowed sinc polyphase interpolator.
const TP_TAPS = 32;
const tpPhases = (() => {
  const phases = [];
  for (let p = 1; p < 4; p++) {
    const t = p / 4, h = new Float64Array(TP_TAPS);
    let sum = 0;
    for (let k = 0; k < TP_TAPS; k++) {
      const x = k - (TP_TAPS / 2 - 1) - t;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const u = (x + TP_TAPS / 2) / TP_TAPS;
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u);
      h[k] = sinc * w; sum += h[k];
    }
    for (let k = 0; k < TP_TAPS; k++) h[k] /= sum;
    phases.push(h);
  }
  return phases;
})();

export function truePeak(audio) {
  let peak = 0;
  const off = TP_TAPS / 2 - 1;
  for (const ch of audio.channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]);
      if (v > peak) peak = v;
    }
  }
  // Inter-sample overs only matter near the loudest samples; skipping stretches where both
  // neighbours sit 6 dB below the sample peak keeps long files fast.
  const near = peak * 0.5;
  for (const ch of audio.channels) {
    const n = ch.length;
    for (let i = off; i < n - TP_TAPS + off; i++) {
      if (Math.abs(ch[i]) < near && Math.abs(ch[i + 1]) < near) continue;
      for (const h of tpPhases) {
        let y = 0;
        const base = i - off;
        for (let k = 0; k < TP_TAPS; k++) y += ch[base + k] * h[k];
        if (y < 0) y = -y;
        if (y > peak) peak = y;
      }
    }
  }
  return peak;
}
