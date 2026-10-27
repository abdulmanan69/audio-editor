// Time-based and creative effects: delay, reverb, modulation, distortion.
import { AudioData, mapChannels } from '../core/audio-data.js';
import { dbToGain } from '../core/format.js';

const TAU = Math.PI * 2;

function lfo(shape, phase) {
  const p = phase - Math.floor(phase);
  switch (shape) {
    case 'triangle': return 1 - 4 * Math.abs(p - 0.5);
    case 'square': return p < 0.5 ? 1 : -1;
    case 'saw': return 2 * p - 1;
    default: return Math.sin(TAU * p);
  }
}

// Fractional read from a circular buffer `buf` (size mask+1, power of two).
function readFrac(buf, mask, writeIdx, delaySamples) {
  const pos = writeIdx - delaySamples;
  const i = Math.floor(pos);
  const f = pos - i;
  const a = buf[i & mask], b = buf[(i + 1) & mask];
  return a + (b - a) * f;
}

const pow2Above = (n) => { let s = 1; while (s < n) s <<= 1; return s; };

export function echo(a, { delayMs = 350, feedback = 0.4, wet = 0.5, dry = 1 } = {}) {
  const D = Math.max(1, Math.round((delayMs / 1000) * a.sampleRate));
  return mapChannels(a, ch => {
    const n = ch.length, o = new Float32Array(n), line = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const d = i >= D ? ch[i - D] + feedback * line[i - D] : 0;
      line[i] = d;
      o[i] = dry * ch[i] + wet * d;
    }
    return o;
  });
}

// Freeverb (Jezar) — 8 damped combs + 4 allpasses per channel, stereo spread.
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const SPREAD = 23;

export function reverb(a, { roomSize = 0.7, damping = 0.4, width = 1, wetDb = -10, dryDb = 0, preDelayMs = 12, tailSec = 0 } = {}) {
  const sr = a.sampleRate, scale = sr / 44100;
  const extra = Math.round(tailSec * sr);
  const n = a.length + extra;
  const inL = a.channels[0], inR = a.channels[1] || a.channels[0];
  const pre = Math.round((preDelayMs / 1000) * sr);
  const feedback = roomSize * 0.28 + 0.7;
  const damp1 = damping * 0.4, damp2 = 1 - damp1;
  const wet = dbToGain(wetDb) * 3, dry = dbToGain(dryDb);
  const wet1 = wet * (width / 2 + 0.5), wet2 = wet * ((1 - width) / 2);
  const mk = (len) => ({ buf: new Float32Array(Math.max(1, Math.round(len * scale))), idx: 0, store: 0 });
  const combL = COMBS.map(l => mk(l)), combR = COMBS.map(l => mk(l + SPREAD));
  const apL = ALLPASSES.map(l => mk(l)), apR = ALLPASSES.map(l => mk(l + SPREAD));
  const runComb = (c, x) => {
    const y = c.buf[c.idx];
    c.store = y * damp2 + c.store * damp1;
    c.buf[c.idx] = x + c.store * feedback;
    if (++c.idx >= c.buf.length) c.idx = 0;
    return y;
  };
  const runAp = (p, x) => {
    const b = p.buf[p.idx];
    p.buf[p.idx] = x + b * 0.5;
    if (++p.idx >= p.buf.length) p.idx = 0;
    return b - x;
  };
  const outL = new Float32Array(n), outR = new Float32Array(n);
  const len = a.length;
  for (let i = 0; i < n; i++) {
    const j = i - pre;
    const xl = j >= 0 && j < len ? inL[j] : 0, xr = j >= 0 && j < len ? inR[j] : 0;
    const input = (xl + xr) * 0.015;
    let l = 0, r = 0;
    for (let k = 0; k < 8; k++) { l += runComb(combL[k], input); r += runComb(combR[k], input); }
    for (let k = 0; k < 4; k++) { l = runAp(apL[k], l); r = runAp(apR[k], r); }
    const dl = i < len ? inL[i] : 0, drr = i < len ? inR[i] : 0;
    outL[i] = l * wet1 + r * wet2 + dl * dry;
    outR[i] = r * wet1 + l * wet2 + drr * dry;
  }
  if (a.numberOfChannels === 1) {
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = (outL[i] + outR[i]) * 0.5;
    return new AudioData([m], sr);
  }
  const chans = [outL, outR];
  for (let c = 2; c < a.numberOfChannels; c++) { const p = new Float32Array(n); p.set(a.channels[c]); chans.push(p); }
  return new AudioData(chans, sr);
}

// Shared modulated-delay core for chorus / flanger / vibrato.
function modDelay(a, { baseMs, depthMs, rate, feedback = 0, mix = 0.5, dry = 1, stereoPhase = 0.25, shape = 'sine' }) {
  const sr = a.sampleRate;
  const maxD = Math.ceil(((baseMs + depthMs) / 1000) * sr) + 4;
  const size = pow2Above(maxD + 2), mask = size - 1;
  return mapChannels(a, (ch, c) => {
    const n = ch.length, o = new Float32Array(n), buf = new Float32Array(size);
    const phase0 = c * stereoPhase;
    let fb = 0;
    for (let i = 0; i < n; i++) {
      buf[i & mask] = ch[i] + fb * feedback;
      const m = 0.5 + 0.5 * lfo(shape, phase0 + (rate * i) / sr);
      const d = ((baseMs + depthMs * m) / 1000) * sr;
      const y = readFrac(buf, mask, i, d);
      fb = y;
      o[i] = dry * ch[i] + mix * y;
    }
    return o;
  });
}

export function chorus(a, { rate = 0.8, depthMs = 3, delayMs = 18, mix = 0.5 } = {}) {
  return modDelay(a, { baseMs: delayMs, depthMs, rate, mix, dry: 1 - mix * 0.3, stereoPhase: 0.25 });
}

export function flanger(a, { rate = 0.25, depthMs = 2.5, delayMs = 1, feedback = 0.5, mix = 0.5 } = {}) {
  return modDelay(a, { baseMs: delayMs, depthMs, rate, feedback, mix, dry: 1 - mix * 0.4, stereoPhase: 0.15, shape: 'triangle' });
}

export function vibrato(a, { rate = 5, depthMs = 1.5 } = {}) {
  return modDelay(a, { baseMs: 0.5, depthMs, rate, mix: 1, dry: 0, stereoPhase: 0 });
}

export function phaser(a, { rate = 0.4, stages = 6, depth = 0.8, minHz = 300, maxHz = 3000, feedback = 0.5, mix = 0.5 } = {}) {
  const sr = a.sampleRate;
  const st = Math.max(2, Math.round(stages));
  return mapChannels(a, (ch, c) => {
    const n = ch.length, o = new Float32Array(n);
    const x1 = new Float64Array(st), y1 = new Float64Array(st);
    let fb = 0;
    for (let i = 0; i < n; i++) {
      const m = 0.5 + 0.5 * depth * lfo('sine', c * 0.25 + (rate * i) / sr);
      const f = minHz * Math.pow(maxHz / minHz, m);
      const t = Math.tan(Math.PI * Math.min(f, sr * 0.45) / sr);
      const k = (t - 1) / (t + 1);
      let v = ch[i] + fb * feedback;
      for (let s = 0; s < st; s++) {
        const y = k * v + x1[s] - k * y1[s];
        x1[s] = v; y1[s] = y; v = y;
      }
      fb = v;
      o[i] = ch[i] * (1 - mix * 0.5) + v * mix;
    }
    return o;
  });
}

export function tremolo(a, { rate = 5, depth = 0.5, shape = 'sine' } = {}) {
  const sr = a.sampleRate;
  return mapChannels(a, ch => {
    const o = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const m = 0.5 + 0.5 * lfo(shape, (rate * i) / sr);
      o[i] = ch[i] * (1 - depth * m);
    }
    return o;
  });
}

export function autoPan(a, { rate = 0.5, depth = 0.8, shape = 'sine' } = {}) {
  if (a.numberOfChannels < 2) return a;
  const sr = a.sampleRate;
  const L = a.channels[0], R = a.channels[1], n = a.length;
  const oL = new Float32Array(n), oR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = depth * lfo(shape, (rate * i) / sr);
    const th = ((p + 1) * Math.PI) / 4;
    const m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5;
    oL[i] = (m * Math.cos(th) + s * 0.5) * Math.SQRT2;
    oR[i] = (m * Math.sin(th) - s * 0.5) * Math.SQRT2;
  }
  return new AudioData([oL, oR, ...a.channels.slice(2).map(c => new Float32Array(c))], sr);
}

export function ringMod(a, { freq = 30, mix = 1, shape = 'sine' } = {}) {
  const sr = a.sampleRate;
  return mapChannels(a, ch => {
    const o = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) o[i] = ch[i] * (1 - mix) + ch[i] * lfo(shape, (freq * i) / sr) * mix;
    return o;
  });
}

const SHAPERS = {
  soft: (x, k) => Math.tanh(k * x) / Math.tanh(k),
  hard: (x, k) => Math.max(-1, Math.min(1, x * k)),
  // Asymmetric transfer: positive half saturates harder, adding even harmonics.
  tube: (x, k) => { const y = x * k; return y >= 0 ? 1 - Math.exp(-y) : -0.8 * (1 - Math.exp(1.25 * y)); },
  fuzz: (x, k) => Math.sign(x) * (1 - Math.exp(-Math.abs(x) * k * 2)),
  foldback: (x, k) => { let y = x * k; while (Math.abs(y) > 1) y = Math.sign(y) * 2 - y; return y; },
};

export function distortion(a, { type = 'soft', driveDb = 12, outputDb = -6, mix = 1 } = {}) {
  const k = Math.max(1.0001, dbToGain(driveDb));
  const shape = SHAPERS[type] || SHAPERS.soft;
  const og = dbToGain(outputDb);
  return mapChannels(a, ch => {
    const o = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      o[i] = (x * (1 - mix) + shape(x, k) * mix) * og;
    }
    return o;
  });
}

export function bitcrush(a, { bits = 8, downsample = 4, mix = 1 } = {}) {
  const levels = Math.pow(2, Math.max(1, bits) - 1);
  const hold = Math.max(1, Math.round(downsample));
  return mapChannels(a, ch => {
    const o = new Float32Array(ch.length);
    let held = 0;
    for (let i = 0; i < ch.length; i++) {
      if (i % hold === 0) held = Math.round(ch[i] * levels) / levels;
      o[i] = ch[i] * (1 - mix) + held * mix;
    }
    return o;
  });
}
