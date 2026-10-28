// Gain, normalization, fades and dynamics processors. All channel-linked.
import { AudioData, mapChannels, peakAbs } from '../core/audio-data.js';
import { dbToGain, gainToDb } from '../core/format.js';
import { measureLoudness, truePeak } from './loudness.js';

export function amplify(a, gainDb) {
  const g = dbToGain(gainDb);
  return mapChannels(a, ch => { const o = new Float32Array(ch.length); for (let i = 0; i < ch.length; i++) o[i] = ch[i] * g; return o; });
}

export function removeDC(a) {
  return mapChannels(a, ch => {
    let m = 0;
    for (let i = 0; i < ch.length; i++) m += ch[i];
    m /= Math.max(1, ch.length);
    const o = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) o[i] = ch[i] - m;
    return o;
  });
}

export function normalizePeak(a, targetDb = -1, { independent = false, dc = false } = {}) {
  const src = dc ? removeDC(a) : a;
  const target = dbToGain(targetDb);
  if (independent) {
    return mapChannels(src, ch => {
      let p = 0;
      for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > p) p = v; }
      const g = p > 0 ? target / p : 1;
      const o = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) o[i] = ch[i] * g;
      return o;
    });
  }
  const p = peakAbs(src);
  if (p === 0) return src;
  const g = target / p;
  return mapChannels(src, ch => { const o = new Float32Array(ch.length); for (let i = 0; i < ch.length; i++) o[i] = ch[i] * g; return o; });
}

// Limit so the *true* (inter-sample) peak stays under ceilingDb. The limiter caps sample
// peaks, so its ceiling is tightened until the measured true peak fits.
function truePeakLimit(a, ceilingDb) {
  if (truePeak(a) <= dbToGain(ceilingDb)) return a;
  let sampleCeil = ceilingDb - 0.3, out = a;
  for (let i = 0; i < 5; i++) {
    out = limiter(a, { ceilingDb: sampleCeil, releaseMs: 80, lookaheadMs: 5 });
    const over = gainToDb(truePeak(out)) - ceilingDb;
    if (over <= 0) break;
    sampleCeil -= over + 0.05;
  }
  return out;
}

export function loudnessNormalize(a, targetLufs = -16, { limit = true, ceilingDb = -1 } = {}) {
  const { integrated } = measureLoudness(a);
  if (!isFinite(integrated)) return a;
  let pre = targetLufs - integrated;
  if (!limit) return amplify(a, pre);
  // Limiting removes some loudness on peaky material, so re-aim the pre-gain until the
  // result lands on target with the peak ceiling still respected.
  // Once limiting kicks in, each extra dB of gain adds less than 1 dB of loudness, so the
  // step is scaled by the measured slope (secant method).
  let out = a, prev = null;
  const start = pre;
  for (let pass = 0; pass < 6; pass++) {
    out = truePeakLimit(amplify(a, pre), ceilingDb);
    const got = measureLoudness(out).integrated;
    const miss = targetLufs - got;
    if (!isFinite(miss) || Math.abs(miss) < 0.15) break;
    const slope = prev ? Math.min(1, Math.max(0.15, (got - prev.got) / (pre - prev.pre || 1e-6))) : 1;
    prev = { pre, got };
    pre = Math.min(start + 24, pre + miss / slope);
  }
  return out;
}

export const FADE_CURVES = {
  linear: t => t,
  equalPower: t => Math.sin(t * Math.PI / 2),
  exponential: t => t * t * t,
  logarithmic: t => 1 - Math.pow(1 - t, 3),
  sCurve: t => 0.5 - 0.5 * Math.cos(Math.PI * t),
};

export function fade(a, startGain, endGain, curve = 'linear') {
  const f = FADE_CURVES[curve] || FADE_CURVES.linear;
  const n = a.length;
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 1;
    env[i] = startGain + (endGain - startGain) * f(t);
  }
  return mapChannels(a, ch => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = ch[i] * env[i]; return o; });
}

// Fade with a curve applied in the direction of travel (fade-out mirrors the fade-in shape).
export function fadeIn(a, curve) { return fade(a, 0, 1, curve); }
export function fadeOut(a, curve) {
  const f = FADE_CURVES[curve] || FADE_CURVES.linear;
  const n = a.length;
  return mapChannels(a, ch => {
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) o[i] = ch[i] * f(n > 1 ? 1 - i / (n - 1) : 0);
    return o;
  });
}

function linkedLevel(a, i) {
  let m = 0;
  for (const ch of a.channels) { const v = ch[i] < 0 ? -ch[i] : ch[i]; if (v > m) m = v; }
  return m;
}

const coef = (ms, sr) => (ms <= 0 ? 0 : Math.exp(-1 / ((ms / 1000) * sr)));

export function compressor(a, { thresholdDb = -18, ratio = 4, kneeDb = 6, attackMs = 10, releaseMs = 120, makeupDb = 0, autoMakeup = false } = {}) {
  const sr = a.sampleRate, n = a.length;
  const aa = coef(attackMs, sr), ar = coef(releaseMs, sr);
  const T = thresholdDb, R = Math.max(1, ratio), W = Math.max(0, kneeDb);
  const curve = (x) => {
    if (2 * (x - T) < -W) return x;
    if (W > 0 && 2 * Math.abs(x - T) <= W) return x + ((1 / R - 1) * Math.pow(x - T + W / 2, 2)) / (2 * W);
    return T + (x - T) / R;
  };
  const gains = new Float32Array(n);
  let env = 0;
  for (let i = 0; i < n; i++) {
    const lvl = linkedLevel(a, i);
    env = lvl > env ? aa * env + (1 - aa) * lvl : ar * env + (1 - ar) * lvl;
    const xdb = 20 * Math.log10(env + 1e-12);
    gains[i] = Math.pow(10, (curve(xdb) - xdb) / 20);
  }
  let mk = dbToGain(makeupDb);
  if (autoMakeup) {
    let pin = 0, pout = 0;
    for (let i = 0; i < n; i++) { const l = linkedLevel(a, i); if (l > pin) pin = l; if (l * gains[i] > pout) pout = l * gains[i]; }
    mk = pout > 0 ? Math.min(dbToGain(-0.1), pin) / pout : 1;
  }
  return mapChannels(a, ch => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = ch[i] * gains[i] * mk; return o; });
}

// Brick-wall look-ahead limiter: sliding-minimum gain, release smoothing, then a box
// filter the length of the look-ahead so gain reduction ramps in before each peak.
export function limiter(a, { ceilingDb = -1, releaseMs = 60, lookaheadMs = 5, inputGainDb = 0 } = {}) {
  const sr = a.sampleRate, n = a.length;
  const ceil = dbToGain(ceilingDb), pre = dbToGain(inputGainDb);
  const L = Math.max(1, Math.round((lookaheadMs / 1000) * sr));
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = linkedLevel(a, i) * pre;
    req[i] = l > ceil ? ceil / l : 1;
  }
  // Sliding minimum over [i, i+L] using a monotonic deque.
  const gmin = new Float32Array(n);
  const dq = new Int32Array(n + L + 1);
  let head = 0, tail = 0;
  for (let j = 0; j < n + L; j++) {
    if (j < n) {
      while (tail > head && req[dq[tail - 1]] >= req[j]) tail--;
      dq[tail++] = j;
    }
    const i = j - L;
    if (i >= 0) {
      while (dq[head] < i) head++;
      gmin[i] = req[dq[head]];
    }
  }
  const ar = coef(releaseMs, sr);
  let env = 1;
  for (let i = 0; i < n; i++) {
    env = gmin[i] < env ? gmin[i] : ar * env + (1 - ar) * gmin[i];
    if (env > gmin[i]) env = gmin[i];
    gmin[i] = env;
  }
  const g = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += gmin[i];
    if (i >= L) acc -= gmin[i - L];
    g[i] = acc / Math.min(i + 1, L);
  }
  return mapChannels(a, ch => {
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = ch[i] * pre * g[i];
      if (v > ceil) v = ceil; else if (v < -ceil) v = -ceil;
      o[i] = v;
    }
    return o;
  });
}

export function noiseGate(a, { thresholdDb = -45, reductionDb = 30, attackMs = 2, holdMs = 60, releaseMs = 150 } = {}) {
  const sr = a.sampleRate, n = a.length;
  const thr = dbToGain(thresholdDb), floor = dbToGain(-reductionDb);
  const aa = 1 - coef(attackMs, sr), ar = 1 - coef(releaseMs, sr);
  const holdN = Math.round((holdMs / 1000) * sr);
  const detRel = coef(8, sr);
  const gains = new Float32Array(n);
  let env = 0, g = floor, hold = 0;
  for (let i = 0; i < n; i++) {
    const l = linkedLevel(a, i);
    env = l > env ? l : detRel * env + (1 - detRel) * l;
    let target;
    if (env >= thr) { target = 1; hold = holdN; }
    else if (hold > 0) { target = 1; hold--; }
    else target = floor;
    g += (target - g) * (target > g ? aa : ar);
    gains[i] = g;
  }
  return mapChannels(a, ch => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = ch[i] * gains[i]; return o; });
}

export function invert(a) {
  return mapChannels(a, ch => { const o = new Float32Array(ch.length); for (let i = 0; i < ch.length; i++) o[i] = -ch[i]; return o; });
}

export function reverse(a) {
  return mapChannels(a, ch => { const o = new Float32Array(ch); o.reverse(); return o; });
}

export function repeat(a, times) {
  const n = a.length * (times + 1);
  return new AudioData(a.channels.map(ch => {
    const o = new Float32Array(n);
    for (let k = 0; k <= times; k++) o.set(ch, k * ch.length);
    return o;
  }), a.sampleRate);
}
