// Signal generators. generate(params, sampleRate, channels) → AudioData.
import { AudioData } from '../core/audio-data.js';
import { dbToGain } from '../core/format.js';

const num = (id, label, min, max, def, opts = {}) => ({ id, label, type: 'number', min, max, default: def, step: opts.step ?? 0.1, ...opts });
const sel = (id, label, options, def) => ({ id, label, type: 'select', options, default: def });
const text = (id, label, def, opts = {}) => ({ id, label, type: 'text', default: def, ...opts });

const WAVES = [['sine', 'Sine'], ['square', 'Square'], ['sawtooth', 'Sawtooth'], ['triangle', 'Triangle']];
const TAU = Math.PI * 2;

// PolyBLEP-corrected oscillators keep square and saw free of harsh aliasing.
function polyBlep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

function oscillate(out, wave, freqAt, amp, sr, offset = 0) {
  let phase = 0, tri = 0;
  for (let i = 0; i < out.length; i++) {
    const f = freqAt(i);
    const dt = f / sr;
    let v;
    switch (wave) {
      case 'square':
        v = (phase < 0.5 ? 1 : -1) + polyBlep(phase, dt) - polyBlep((phase + 0.5) % 1, dt);
        break;
      case 'sawtooth':
        v = 2 * phase - 1 - polyBlep(phase, dt);
        break;
      case 'triangle': {
        const sq = (phase < 0.5 ? 1 : -1) + polyBlep(phase, dt) - polyBlep((phase + 0.5) % 1, dt);
        tri = dt * sq * 4 + (1 - dt * 0.5) * tri;
        v = tri;
        break;
      }
      default:
        v = Math.sin(TAU * phase);
    }
    out[offset + i] += v * (typeof amp === 'function' ? amp(i) : amp);
    phase += dt;
    if (phase >= 1) phase -= Math.floor(phase);
  }
}

function edgeFade(arr, sr, ms = 5) {
  const n = Math.min(Math.floor(arr.length / 2), Math.round((ms / 1000) * sr));
  for (let i = 0; i < n; i++) { const g = i / n; arr[i] *= g; arr[arr.length - 1 - i] *= g; }
}

const multi = (mono, nch, sr) => new AudioData(Array.from({ length: nch }, (_, c) => (c === 0 ? mono : new Float32Array(mono))), sr);

const DTMF = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], 'A': [697, 1633],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], 'B': [770, 1633],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], 'C': [852, 1633],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477], 'D': [941, 1633],
};

const MORSE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--',
  N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '/': '-..-.', '-': '-....-', '@': '.--.-.', '!': '-.-.--',
};

export const GENERATORS = [
  {
    id: 'tone', name: 'Tone', icon: 'wave',
    description: 'Steady test tone in a classic waveform.',
    params: [sel('wave', 'Waveform', WAVES, 'sine'), num('freq', 'Frequency', 1, 20000, 440, { unit: 'Hz', step: 1, scale: 'log' }), num('ampDb', 'Level', -60, 0, -12, { unit: 'dBFS', step: 0.5 }), num('duration', 'Duration', 0.01, 600, 5, { unit: 's', step: 0.01 })],
    presets: [
      { name: 'A4 reference (440 Hz)', values: { wave: 'sine', freq: 440, ampDb: -12, duration: 5 } },
      { name: 'Line-up tone (1 kHz, −18 dBFS)', values: { wave: 'sine', freq: 1000, ampDb: -18, duration: 30 } },
      { name: 'Sub check (40 Hz)', values: { wave: 'sine', freq: 40, ampDb: -12, duration: 10 } },
    ],
    generate(p, sr, nch) {
      const out = new Float32Array(Math.round(p.duration * sr));
      oscillate(out, p.wave, () => p.freq, dbToGain(p.ampDb), sr);
      edgeFade(out, sr, 3);
      return multi(out, nch, sr);
    },
  },
  {
    id: 'beep', name: 'Beep', icon: 'beep',
    description: 'Short sine beep with soft edges — the censor bleep tone.',
    params: [num('freq', 'Frequency', 100, 5000, 1000, { unit: 'Hz', step: 1, scale: 'log' }), num('ampDb', 'Level', -60, 0, -12, { unit: 'dBFS', step: 0.5 }), num('duration', 'Duration', 0.02, 30, 0.5, { unit: 's', step: 0.01 })],
    generate(p, sr, nch) {
      const out = new Float32Array(Math.round(p.duration * sr));
      oscillate(out, 'sine', () => p.freq, dbToGain(p.ampDb), sr);
      edgeFade(out, sr, 6);
      return multi(out, nch, sr);
    },
  },
  {
    id: 'chirp', name: 'Chirp / sweep', icon: 'chirp',
    description: 'Frequency sweep for measuring speakers, rooms and filters.',
    params: [sel('wave', 'Waveform', WAVES, 'sine'), num('f0', 'Start frequency', 1, 20000, 20, { unit: 'Hz', step: 1, scale: 'log' }), num('f1', 'End frequency', 1, 20000, 20000, { unit: 'Hz', step: 1, scale: 'log' }), sel('law', 'Sweep', [['log', 'Logarithmic'], ['linear', 'Linear']], 'log'), num('ampDb', 'Level', -60, 0, -12, { unit: 'dBFS', step: 0.5 }), num('duration', 'Duration', 0.1, 600, 10, { unit: 's', step: 0.1 })],
    generate(p, sr, nch) {
      const n = Math.round(p.duration * sr);
      const out = new Float32Array(n);
      const f0 = p.f0, f1 = p.f1;
      const freqAt = p.law === 'log' ? (i) => f0 * Math.pow(f1 / f0, i / n) : (i) => f0 + (f1 - f0) * (i / n);
      oscillate(out, p.wave, freqAt, dbToGain(p.ampDb), sr);
      edgeFade(out, sr, 5);
      return multi(out, nch, sr);
    },
  },
  {
    id: 'noise', name: 'Noise', icon: 'noise',
    description: 'White, pink or brown noise for masking and testing.',
    params: [sel('color', 'Color', [['white', 'White'], ['pink', 'Pink'], ['brown', 'Brown']], 'pink'), num('ampDb', 'Level', -60, 0, -18, { unit: 'dBFS', step: 0.5 }), num('duration', 'Duration', 0.01, 600, 5, { unit: 's', step: 0.01 })],
    generate(p, sr, nch) {
      const n = Math.round(p.duration * sr);
      const g = dbToGain(p.ampDb);
      const chans = [];
      for (let c = 0; c < nch; c++) {
        const out = new Float32Array(n);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0;
        for (let i = 0; i < n; i++) {
          const w = Math.random() * 2 - 1;
          let v;
          if (p.color === 'pink') {
            b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
            b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
            v = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
          } else if (p.color === 'brown') {
            br = (br + 0.02 * w) / 1.02; v = br * 3.5;
          } else v = w;
          out[i] = v * g;
        }
        edgeFade(out, sr, 3);
        chans.push(out);
      }
      return new AudioData(chans, sr);
    },
  },
  {
    id: 'dtmf', name: 'DTMF tones', icon: 'phone',
    description: 'Telephone keypad tones for a digit sequence.',
    params: [text('digits', 'Digits', '5550123', { help: '0–9, A–D, * and #' }), num('toneMs', 'Tone length', 40, 1000, 120, { unit: 'ms', step: 1 }), num('gapMs', 'Gap', 20, 1000, 80, { unit: 'ms', step: 1 }), num('ampDb', 'Level', -60, 0, -10, { unit: 'dBFS', step: 0.5 })],
    generate(p, sr, nch) {
      const digits = String(p.digits).toUpperCase().split('').filter(d => DTMF[d]);
      const tn = Math.round((p.toneMs / 1000) * sr), gn = Math.round((p.gapMs / 1000) * sr);
      const out = new Float32Array(Math.max(1, digits.length * (tn + gn)));
      const g = dbToGain(p.ampDb) / 2;
      digits.forEach((d, k) => {
        const seg = new Float32Array(tn);
        for (const f of DTMF[d]) oscillate(seg, 'sine', () => f, g, sr);
        edgeFade(seg, sr, 4);
        out.set(seg, k * (tn + gn));
      });
      return multi(out, nch, sr);
    },
  },
  {
    id: 'metronome', name: 'Click track', icon: 'metronome',
    description: 'Metronome clicks with an accented downbeat.',
    params: [num('bpm', 'Tempo', 20, 300, 120, { unit: 'BPM', step: 1 }), num('beats', 'Beats per bar', 1, 16, 4, { step: 1 }), num('bars', 'Bars', 1, 500, 8, { step: 1 }), num('freq', 'Click pitch', 200, 4000, 1000, { unit: 'Hz', step: 1, scale: 'log' }), num('accentFreq', 'Accent pitch', 200, 4000, 1500, { unit: 'Hz', step: 1, scale: 'log' }), num('ampDb', 'Level', -60, 0, -6, { unit: 'dBFS', step: 0.5 })],
    generate(p, sr, nch) {
      const beatN = Math.round((60 / p.bpm) * sr);
      const total = beatN * p.beats * p.bars;
      const out = new Float32Array(total);
      const clickN = Math.round(0.03 * sr);
      for (let b = 0; b < p.beats * p.bars; b++) {
        const accent = b % p.beats === 0;
        const f = accent ? p.accentFreq : p.freq;
        const g = dbToGain(p.ampDb) * (accent ? 1 : 0.7);
        const start = b * beatN;
        for (let i = 0; i < clickN && start + i < total; i++) {
          out[start + i] = Math.sin((TAU * f * i) / sr) * g * Math.exp(-i / (clickN / 5));
        }
      }
      return multi(out, nch, sr);
    },
  },
  {
    id: 'morse', name: 'Morse code', icon: 'morse',
    description: 'Turn text into Morse code tones.',
    params: [text('text', 'Text', 'KERF'), num('wpm', 'Speed', 5, 40, 18, { unit: 'WPM', step: 1 }), num('freq', 'Tone', 300, 1500, 700, { unit: 'Hz', step: 1 }), num('ampDb', 'Level', -60, 0, -12, { unit: 'dBFS', step: 0.5 })],
    generate(p, sr, nch) {
      const unit = Math.round((1.2 / p.wpm) * sr);
      const seq = [];
      for (const word of String(p.text).toUpperCase().split(/\s+/).filter(Boolean)) {
        for (const ch of word) {
          const code = MORSE[ch];
          if (!code) continue;
          for (const sym of code) { seq.push([1, sym === '.' ? 1 : 3]); seq.push([0, 1]); }
          seq.push([0, 2]);
        }
        seq.push([0, 4]);
      }
      const total = seq.reduce((s, [, u]) => s + u * unit, 0);
      const out = new Float32Array(Math.max(1, total));
      let pos = 0;
      for (const [on, u] of seq) {
        const len = u * unit;
        if (on) {
          const seg = new Float32Array(len);
          oscillate(seg, 'sine', () => p.freq, dbToGain(p.ampDb), sr);
          edgeFade(seg, sr, 4);
          out.set(seg, pos);
        }
        pos += len;
      }
      return multi(out, nch, sr);
    },
  },
  {
    id: 'silence', name: 'Silence', icon: 'mute',
    description: 'Digital silence of any length.',
    params: [num('duration', 'Duration', 0.001, 3600, 1, { unit: 's', step: 0.001 })],
    generate: (p, sr, nch) => AudioData.silence(Math.round(p.duration * sr), nch, sr),
  },
];

export const generatorById = (id) => GENERATORS.find(g => g.id === id);

// A short two-track sample session: Karplus-Strong plucked arpeggios over a soft pad, and a
// drum track. Synthesised on the fly so the app ships no audio assets.
export function demoTracks(sr) {
  const bpm = 96, beat = 60 / bpm, bars = 4, beatsPerBar = 4;
  const total = Math.round((bars * beatsPerBar * beat + 1.5) * sr);
  const L = new Float32Array(total), R = new Float32Array(total), drums = new Float32Array(total);
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const chords = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 52, 55, 60], [55, 59, 62, 67]];
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
  const pluck = (f, start, dur, gain, pan) => {
    const N = Math.max(2, Math.round(sr / f));
    const buf = new Float32Array(N);
    for (let i = 0; i < N; i++) buf[i] = rand();
    const n = Math.round(dur * sr), s0 = Math.round(start * sr);
    let idx = 0;
    const gl = gain * Math.cos((pan + 1) * Math.PI / 4), gr = gain * Math.sin((pan + 1) * Math.PI / 4);
    for (let i = 0; i < n && s0 + i < total; i++) {
      const next = (idx + 1) % N;
      const v = buf[idx];
      buf[idx] = 0.4985 * (buf[idx] + buf[next]);
      idx = next;
      const env = i < 40 ? i / 40 : 1;
      L[s0 + i] += v * gl * env; R[s0 + i] += v * gr * env;
    }
  };
  chords.forEach((ch, bar) => {
    const t0 = bar * beatsPerBar * beat;
    const pattern = [0, 1, 2, 3, 2, 1, 3, 2];
    pattern.forEach((k, i) => pluck(midi(ch[k] + 12), t0 + i * beat / 2, 1.6, 0.32, i % 2 ? 0.45 : -0.45));
    // Pad: detuned sines with a slow swell.
    const n = Math.round(beatsPerBar * beat * sr), s0 = Math.round(t0 * sr);
    for (const note of ch) {
      const f = midi(note);
      for (let i = 0; i < n + sr * 0.5 && s0 + i < total; i++) {
        const t = i / sr;
        const env = Math.min(1, t / 0.8) * Math.max(0, 1 - Math.max(0, i - n) / (sr * 0.5));
        const v = (Math.sin(2 * Math.PI * f * t) + Math.sin(2 * Math.PI * f * 1.003 * t)) * 0.018 * env;
        L[s0 + i] += v; R[s0 + i] += v;
      }
    }
  });
  for (let b = 0; b < bars * beatsPerBar; b++) {
    const s0 = Math.round(b * beat * sr);
    // Kick on every beat: pitch-swept sine.
    let ph = 0;
    for (let i = 0; i < sr * 0.35 && s0 + i < total; i++) {
      const t = i / sr;
      ph += (2 * Math.PI * (45 + 90 * Math.exp(-t * 30))) / sr;
      drums[s0 + i] += Math.sin(ph) * Math.exp(-t * 9) * 0.7;
    }
    // Hats on the off-beats, snare on 2 and 4.
    const hs = Math.round((b * beat + beat / 2) * sr);
    let prev = 0;
    for (let i = 0; i < sr * 0.05 && hs + i < total; i++) { const w = rand(); drums[hs + i] += (w - prev) * 0.12 * Math.exp(-i / (sr * 0.012)); prev = w; }
    if (b % 2 === 1) {
      for (let i = 0; i < sr * 0.2 && s0 + i < total; i++) {
        const t = i / sr;
        drums[s0 + i] += (rand() * 0.35 + Math.sin(2 * Math.PI * 190 * t) * 0.25) * Math.exp(-t * 18);
      }
    }
  }
  const norm = (arrs, target) => {
    for (const a of arrs) {
      let mean = 0;
      for (let i = 0; i < a.length; i++) mean += a[i];
      mean /= a.length;
      for (let i = 0; i < a.length; i++) a[i] -= mean;
    }
    let p = 0;
    for (const a of arrs) for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i]));
    const g = p ? target / p : 1;
    for (const a of arrs) for (let i = 0; i < a.length; i++) a[i] *= g;
  };
  norm([L, R], 0.7);
  norm([drums], 0.6);
  return [
    { name: 'Arpeggio & pad', audio: new AudioData([L, R], sr) },
    { name: 'Drums', audio: new AudioData([drums], sr) },
  ];
}

// Censor bleep sized to an exact sample length (used by Edit › Bleep).
export function bleep(length, sr, nch, freq = 1000, ampDb = -12) {
  const out = new Float32Array(length);
  oscillate(out, 'sine', () => freq, dbToGain(ampDb), sr);
  edgeFade(out, sr, 4);
  return multi(out, nch, sr);
}
