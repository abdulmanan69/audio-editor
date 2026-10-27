// Immutable multichannel PCM container plus the splice primitives every edit is built on.
// Edits never write into an existing AudioData; they build new channel arrays, so undo
// snapshots can share references safely.

export class AudioData {
  constructor(channels, sampleRate) {
    if (!channels.length) throw new Error('AudioData needs at least one channel');
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.length = channels[0].length;
    Object.freeze(this);
  }
  get numberOfChannels() { return this.channels.length; }
  get duration() { return this.length / this.sampleRate; }

  static silence(length, numChannels, sampleRate) {
    const chans = [];
    for (let c = 0; c < numChannels; c++) chans.push(new Float32Array(Math.max(0, Math.round(length))));
    return new AudioData(chans, sampleRate);
  }

  static fromAudioBuffer(ab) {
    const chans = [];
    for (let c = 0; c < ab.numberOfChannels; c++) chans.push(new Float32Array(ab.getChannelData(c)));
    return new AudioData(chans, ab.sampleRate);
  }
}

const clampIndex = (i, len) => Math.max(0, Math.min(len, Math.round(i)));

export function slice(a, start, end) {
  const s = clampIndex(start, a.length), e = clampIndex(end, a.length);
  return new AudioData(a.channels.map(ch => ch.slice(s, Math.max(s, e))), a.sampleRate);
}

export function concat(list, sampleRate) {
  const parts = list.filter(Boolean);
  if (!parts.length) return AudioData.silence(0, 1, sampleRate);
  const nch = Math.max(...parts.map(p => p.numberOfChannels));
  const sr = sampleRate || parts[0].sampleRate;
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = [];
  for (let c = 0; c < nch; c++) {
    const dst = new Float32Array(total);
    let off = 0;
    for (const p of parts) {
      dst.set(p.channels[Math.min(c, p.numberOfChannels - 1)], off);
      off += p.length;
    }
    out.push(dst);
  }
  return new AudioData(out, sr);
}

// Replace [start, end) with `insert` (or remove it when insert is null).
export function splice(a, start, end, insert = null) {
  const s = clampIndex(start, a.length), e = clampIndex(Math.max(start, end), a.length);
  const ins = insert ? matchChannels(insert, a.numberOfChannels) : null;
  const insLen = ins ? ins.length : 0;
  const total = a.length - (e - s) + insLen;
  const out = a.channels.map((ch, c) => {
    const dst = new Float32Array(total);
    dst.set(ch.subarray(0, s), 0);
    if (ins) dst.set(ins.channels[c], s);
    dst.set(ch.subarray(e), s + insLen);
    return dst;
  });
  return new AudioData(out, a.sampleRate);
}

// Insert at sample position; pads with silence if `at` is past the end.
export function insertAt(a, at, insert) {
  const pos = Math.max(0, Math.round(at));
  const base = pos > a.length ? padEnd(a, pos) : a;
  return splice(base, pos, pos, insert);
}

export function padEnd(a, newLength) {
  if (newLength <= a.length) return a;
  return new AudioData(a.channels.map(ch => {
    const d = new Float32Array(newLength);
    d.set(ch);
    return d;
  }), a.sampleRate);
}

// Run `fn(sliceData)` over [start,end) and splice the result back. fn may change length.
export async function processRange(a, start, end, fn) {
  const s = clampIndex(start, a.length), e = clampIndex(end, a.length);
  if (e <= s) return a;
  const part = slice(a, s, e);
  const result = await fn(part);
  if (!result) return a;
  if (s === 0 && e === a.length) return matchChannels(result, a.numberOfChannels);
  return splice(a, s, e, result);
}

// Convert channel layout: mono→N duplicates, N→mono averages, otherwise maps/duplicates.
export function matchChannels(a, n) {
  if (a.numberOfChannels === n) return a;
  if (n === 1) {
    const out = new Float32Array(a.length);
    const k = 1 / a.numberOfChannels;
    for (const ch of a.channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] * k;
    return new AudioData([out], a.sampleRate);
  }
  const chans = [];
  for (let c = 0; c < n; c++) chans.push(new Float32Array(a.channels[Math.min(c, a.numberOfChannels - 1)]));
  return new AudioData(chans, a.sampleRate);
}

export function mapChannels(a, fn) {
  return new AudioData(a.channels.map((ch, c) => fn(ch, c)), a.sampleRate);
}

export function mixInto(base, overlay, at, gain = 1) {
  const pos = Math.max(0, Math.round(at));
  const b = padEnd(base, pos + overlay.length);
  const ov = matchChannels(overlay, b.numberOfChannels);
  return new AudioData(b.channels.map((ch, c) => {
    const d = new Float32Array(ch);
    const src = ov.channels[c];
    for (let i = 0; i < src.length; i++) d[pos + i] += src[i] * gain;
    return d;
  }), b.sampleRate);
}

// ---------- AudioBuffer bridge (cached per context) ----------
const bufferCache = new WeakMap();
export function toAudioBuffer(a, ctx) {
  const hit = bufferCache.get(a);
  if (hit && hit.ctx === ctx) return hit.buffer;
  const buf = ctx.createBuffer(a.numberOfChannels, Math.max(1, a.length), a.sampleRate);
  a.channels.forEach((ch, c) => buf.copyToChannel(ch, c));
  bufferCache.set(a, { ctx, buffer: buf });
  return buf;
}

// ---------- Peak cache for fast waveform drawing ----------
export const PEAK_BLOCK = 256;
const peakCache = new WeakMap();

export function getPeaks(ch) {
  let p = peakCache.get(ch);
  if (!p) {
    p = createPeaks(Math.ceil(ch.length / PEAK_BLOCK) + 1);
    updatePeaks(p, ch, 0);
    peakCache.set(ch, p);
  }
  return p;
}

export function createPeaks(capacity) {
  return { block: PEAK_BLOCK, min: new Float32Array(capacity), max: new Float32Array(capacity), rms: new Float32Array(capacity), count: 0 };
}

// Compute peaks from sample `from` onward (used incrementally while recording).
export function updatePeaks(p, ch, from) {
  const B = p.block;
  const startBlock = Math.floor(from / B);
  const n = Math.ceil(ch.length / B);
  if (n > p.min.length) {
    const grow = (arr) => { const a = new Float32Array(Math.max(n, arr.length * 2)); a.set(arr); return a; };
    p.min = grow(p.min); p.max = grow(p.max); p.rms = grow(p.rms);
  }
  for (let b = startBlock; b < n; b++) {
    const s = b * B, e = Math.min(ch.length, s + B);
    let mn = 1, mx = -1, sq = 0;
    for (let i = s; i < e; i++) {
      const v = ch[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sq += v * v;
    }
    if (e <= s) { mn = 0; mx = 0; }
    p.min[b] = mn; p.max[b] = mx; p.rms[b] = Math.sqrt(sq / Math.max(1, e - s));
  }
  p.count = n;
  return p;
}

export function registerPeaks(ch, peaks) { peakCache.set(ch, peaks); }

export function peakAbs(a) {
  let m = 0;
  for (const ch of a.channels) for (let i = 0; i < ch.length; i++) { const v = ch[i] < 0 ? -ch[i] : ch[i]; if (v > m) m = v; }
  return m;
}
