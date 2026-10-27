// RBJ "Audio EQ Cookbook" biquads, processed in transposed direct form II with doubles.

export function design(type, freq, sampleRate, q = Math.SQRT1_2, gainDb = 0) {
  const f = Math.min(Math.max(freq, 1), sampleRate * 0.4995);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const Q = Math.max(1e-4, q);
  const alpha = sw / (2 * Q);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'highpass':
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'notch':
      b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'allpass':
      b0 = 1 - alpha; b1 = -2 * cw; b2 = 1 + alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
      a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; break;
    }
    default: throw new Error(`Unknown filter type ${type}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function processBiquad(input, c, out = new Float32Array(input.length)) {
  const { b0, b1, b2, a1, a2 } = c;
  let z1 = 0, z2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    out[i] = y;
  }
  return out;
}

export function processCascade(input, sections) {
  if (!sections.length) return new Float32Array(input);
  let buf = processBiquad(input, sections[0]);
  for (let i = 1; i < sections.length; i++) processBiquad(buf, sections[i], buf);
  return buf;
}

// Q values for an even-order Butterworth built from 2nd-order sections.
export function butterworthQs(order) {
  const n = Math.max(2, order - (order % 2));
  const qs = [];
  for (let k = 1; k <= n / 2; k++) qs.push(1 / (2 * Math.cos(((2 * k - 1) * Math.PI) / (2 * n))));
  return qs;
}

export function butterworth(type, freq, sampleRate, order) {
  return butterworthQs(order).map(q => design(type, freq, sampleRate, q));
}

// |H(f)| in dB for a cascade, used for drawing EQ curves.
export function responseDb(sections, freq, sampleRate) {
  const w = (2 * Math.PI * freq) / sampleRate;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  let db = 0;
  for (const { b0, b1, b2, a1, a2 } of sections) {
    const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
    const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
    db += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di) + 1e-30);
  }
  return db;
}
