// Effect registry. Each effect declares its parameters (rendered into dialogs and chains)
// and a process(audio, params, ctx) function that returns a new AudioData.
import { AudioData, mapChannels, peakAbs } from '../core/audio-data.js';
import { formatDb, gainToDb } from '../core/format.js';
import * as dyn from './dynamics.js';
import * as mod from './modulation.js';
import * as rest from './restoration.js';
import { design, butterworth, processCascade } from './biquad.js';
import { resample, wsola, pitchShift } from './stretch.js';
import { measureLoudness, truePeak } from './loudness.js';

const num = (id, label, min, max, def, opts = {}) => ({ id, label, type: 'number', min, max, default: def, step: opts.step ?? (max - min > 50 ? 1 : 0.1), ...opts });
const sel = (id, label, options, def, opts = {}) => ({ id, label, type: 'select', options, default: def, ...opts });
const bool = (id, label, def, opts = {}) => ({ id, label, type: 'bool', default: def, ...opts });

const CURVES = [['linear', 'Linear'], ['equalPower', 'Equal power'], ['sCurve', 'S-curve'], ['exponential', 'Exponential (slow start)'], ['logarithmic', 'Logarithmic (fast start)']];
const SLOPES = [['2', '12 dB/oct'], ['4', '24 dB/oct'], ['6', '36 dB/oct'], ['8', '48 dB/oct']];
const LFO = [['sine', 'Sine'], ['triangle', 'Triangle'], ['square', 'Square']];
export const GEQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

const filt = (a, sections) => mapChannels(a, ch => processCascade(ch, sections));
const peakInfo = (a) => { const p = peakAbs(a); return `Current peak ${formatDb(gainToDb(p))} dBFS`; };

export const EFFECT_CATEGORIES = ['Amplitude', 'Dynamics', 'EQ & filters', 'Time & pitch', 'Delay & reverb', 'Modulation', 'Distortion', 'Restoration', 'Stereo'];

export const EFFECTS = [
  // ---------- Amplitude ----------
  {
    id: 'amplify', name: 'Amplify', category: 'Amplitude', icon: 'volume',
    description: 'Raise or lower the level by a fixed amount.',
    params: [num('gainDb', 'Gain', -48, 48, 3, { unit: 'dB', step: 0.1 }), bool('protect', 'Stop at 0 dBFS to prevent clipping', true)],
    info: peakInfo,
    process: (a, p) => {
      let g = p.gainDb;
      if (p.protect) { const pk = peakAbs(a); if (pk > 0) g = Math.min(g, -gainToDb(pk)); }
      return dyn.amplify(a, g);
    },
  },
  {
    id: 'normalize', name: 'Normalize', category: 'Amplitude', icon: 'normalize',
    description: 'Scale so the loudest sample hits a target peak.',
    params: [num('targetDb', 'Target peak', -24, 0, -1, { unit: 'dBFS', step: 0.1 }), bool('dc', 'Remove DC offset first', true), bool('independent', 'Normalize channels independently', false)],
    info: peakInfo,
    process: (a, p) => dyn.normalizePeak(a, p.targetDb, { dc: p.dc, independent: p.independent }),
  },
  {
    id: 'loudness', name: 'Loudness normalize', category: 'Amplitude', icon: 'loudness',
    description: 'Match integrated loudness (ITU-R BS.1770) to a delivery spec.',
    params: [num('target', 'Target loudness', -36, -5, -16, { unit: 'LUFS', step: 0.5 }), bool('limit', 'Limit true peaks', true), num('ceiling', 'True-peak ceiling', -6, 0, -1, { unit: 'dBTP', step: 0.1, showIf: p => p.limit })],
    presets: [
      { name: 'Podcast / Apple (−16 LUFS)', values: { target: -16, limit: true, ceiling: -1 } },
      { name: 'Spotify / YouTube (−14 LUFS)', values: { target: -14, limit: true, ceiling: -1 } },
      { name: 'EBU R128 broadcast (−23 LUFS)', values: { target: -23, limit: true, ceiling: -1 } },
      { name: 'ATSC A/85 (−24 LKFS)', values: { target: -24, limit: true, ceiling: -2 } },
      { name: 'Audiobook ACX (−19 LUFS)', values: { target: -19, limit: true, ceiling: -3 } },
    ],
    info: (a) => { const l = measureLoudness(a); return `Measured ${isFinite(l.integrated) ? l.integrated.toFixed(1) : '−∞'} LUFS · LRA ${l.lra.toFixed(1)} LU`; },
    process: (a, p) => dyn.loudnessNormalize(a, p.target, { limit: p.limit, ceilingDb: p.ceiling }),
  },
  {
    id: 'fadeIn', name: 'Fade in', category: 'Amplitude', icon: 'fade-in', quick: true,
    description: 'Ramp up from silence across the selection.',
    params: [sel('curve', 'Curve', CURVES, 'equalPower')],
    process: (a, p) => dyn.fadeIn(a, p.curve),
  },
  {
    id: 'fadeOut', name: 'Fade out', category: 'Amplitude', icon: 'fade-out', quick: true,
    description: 'Ramp down to silence across the selection.',
    params: [sel('curve', 'Curve', CURVES, 'equalPower')],
    process: (a, p) => dyn.fadeOut(a, p.curve),
  },
  {
    id: 'fade', name: 'Adjustable fade', category: 'Amplitude', icon: 'fade-in',
    description: 'Ramp between any two levels, for ducking or partial fades.',
    params: [num('start', 'Start level', 0, 200, 100, { unit: '%' }), num('end', 'End level', 0, 200, 30, { unit: '%' }), sel('curve', 'Curve', CURVES, 'sCurve')],
    presets: [
      { name: 'Duck under voice (100 → 30%)', values: { start: 100, end: 30, curve: 'sCurve' } },
      { name: 'Un-duck (30 → 100%)', values: { start: 30, end: 100, curve: 'sCurve' } },
    ],
    process: (a, p) => dyn.fade(a, p.start / 100, p.end / 100, p.curve),
  },

  // ---------- Dynamics ----------
  {
    id: 'compressor', name: 'Compressor', category: 'Dynamics', icon: 'compress',
    description: 'Reduce dynamic range so quiet and loud passages sit closer together.',
    params: [
      num('thresholdDb', 'Threshold', -60, 0, -18, { unit: 'dB' }), num('ratio', 'Ratio', 1, 20, 4, { unit: ':1', step: 0.1 }),
      num('kneeDb', 'Knee', 0, 24, 6, { unit: 'dB' }), num('attackMs', 'Attack', 0.1, 200, 10, { unit: 'ms' }),
      num('releaseMs', 'Release', 5, 2000, 120, { unit: 'ms', step: 1 }), num('makeupDb', 'Make-up gain', 0, 24, 0, { unit: 'dB', showIf: p => !p.autoMakeup }),
      bool('autoMakeup', 'Automatic make-up gain (restore original peak)', true),
    ],
    presets: [
      { name: 'Voice — gentle', values: { thresholdDb: -20, ratio: 2.5, kneeDb: 8, attackMs: 15, releaseMs: 150, autoMakeup: true } },
      { name: 'Voice — broadcast', values: { thresholdDb: -24, ratio: 4, kneeDb: 6, attackMs: 5, releaseMs: 100, autoMakeup: true } },
      { name: 'Music bus glue', values: { thresholdDb: -14, ratio: 2, kneeDb: 10, attackMs: 30, releaseMs: 250, autoMakeup: true } },
      { name: 'Heavy squash', values: { thresholdDb: -30, ratio: 10, kneeDb: 2, attackMs: 1, releaseMs: 60, autoMakeup: true } },
    ],
    process: (a, p) => dyn.compressor(a, p),
  },
  {
    id: 'limiter', name: 'Limiter', category: 'Dynamics', icon: 'limit',
    description: 'Brick-wall peak control with look-ahead, for final level.',
    params: [num('inputGainDb', 'Input gain', 0, 24, 0, { unit: 'dB' }), num('ceilingDb', 'Ceiling', -12, 0, -1, { unit: 'dBFS', step: 0.1 }), num('releaseMs', 'Release', 5, 1000, 60, { unit: 'ms', step: 1 }), num('lookaheadMs', 'Look-ahead', 1, 20, 5, { unit: 'ms' })],
    info: peakInfo,
    process: (a, p) => dyn.limiter(a, p),
  },
  {
    id: 'gate', name: 'Noise gate', category: 'Dynamics', icon: 'gate',
    description: 'Turn down audio that falls below a threshold, like room tone between phrases.',
    params: [num('thresholdDb', 'Threshold', -90, 0, -45, { unit: 'dB' }), num('reductionDb', 'Reduction', 0, 100, 30, { unit: 'dB' }), num('attackMs', 'Attack', 0.1, 100, 2, { unit: 'ms' }), num('holdMs', 'Hold', 0, 1000, 60, { unit: 'ms', step: 1 }), num('releaseMs', 'Release', 5, 2000, 150, { unit: 'ms', step: 1 })],
    process: (a, p) => dyn.noiseGate(a, p),
  },
  {
    id: 'deesser', name: 'De-esser', category: 'Dynamics', icon: 'deess',
    description: 'Tame harsh “s” and “t” sounds in speech.',
    params: [num('freq', 'Frequency', 2000, 12000, 5500, { unit: 'Hz', step: 10, scale: 'log' }), num('thresholdDb', 'Threshold', -60, 0, -28, { unit: 'dB' }), num('reductionDb', 'Max reduction', 0, 24, 8, { unit: 'dB' })],
    process: (a, p) => rest.deEss(a, p),
  },

  // ---------- EQ & filters ----------
  {
    id: 'graphicEq', name: 'Graphic EQ', category: 'EQ & filters', icon: 'eq', layout: 'geq',
    description: 'Ten-band equalizer with octave-spaced bands.',
    params: [...GEQ_BANDS.map(f => num(`b${f}`, f >= 1000 ? `${f / 1000}k` : `${f}`, -18, 18, 0, { unit: 'dB', step: 0.5 })), num('outputDb', 'Output', -18, 18, 0, { unit: 'dB', step: 0.5 })],
    presets: [
      { name: 'Flat', values: Object.fromEntries(GEQ_BANDS.map(f => [`b${f}`, 0])) },
      { name: 'Voice clarity', values: { b31: -12, b62: -8, b125: -3, b250: -2, b500: 0, b1000: 1, b2000: 3, b4000: 4, b8000: 2, b16000: 0 } },
      { name: 'Bass boost', values: { b31: 6, b62: 6, b125: 4, b250: 1, b500: 0, b1000: 0, b2000: 0, b4000: 0, b8000: 0, b16000: 0 } },
      { name: 'Treble boost', values: { b31: 0, b62: 0, b125: 0, b250: 0, b500: 0, b1000: 0, b2000: 1, b4000: 3, b8000: 5, b16000: 6 } },
      { name: 'Loudness (smile)', values: { b31: 5, b62: 4, b125: 2, b250: 0, b500: -1, b1000: -1, b2000: 0, b4000: 2, b8000: 4, b16000: 5 } },
      { name: 'Reduce mud', values: { b31: 0, b62: 0, b125: -2, b250: -4, b500: -3, b1000: 0, b2000: 0, b4000: 0, b8000: 0, b16000: 0 } },
    ],
    sections: (p, sr) => GEQ_BANDS.filter(f => f < sr * 0.45 && p[`b${f}`]).map(f => design('peaking', f, sr, 1.41, p[`b${f}`])),
    process(a, p) {
      const out = filt(a, this.sections(p, a.sampleRate));
      return p.outputDb ? dyn.amplify(out, p.outputDb) : out;
    },
  },
  {
    id: 'filter', name: 'Parametric filter', category: 'EQ & filters', icon: 'filter',
    description: 'One precise filter band: shelf, peak, notch, pass or all-pass.',
    params: [
      sel('type', 'Type', [['peaking', 'Peak / bell'], ['lowshelf', 'Low shelf'], ['highshelf', 'High shelf'], ['lowpass', 'Low-pass'], ['highpass', 'High-pass'], ['bandpass', 'Band-pass'], ['notch', 'Notch'], ['allpass', 'All-pass']], 'peaking'),
      num('freq', 'Frequency', 20, 20000, 1000, { unit: 'Hz', step: 1, scale: 'log' }), num('q', 'Q', 0.1, 30, 1, { step: 0.01, scale: 'log' }),
      num('gainDb', 'Gain', -24, 24, 3, { unit: 'dB', showIf: p => ['peaking', 'lowshelf', 'highshelf'].includes(p.type) }),
    ],
    sections: (p, sr) => [design(p.type, p.freq, sr, p.q, p.gainDb)],
    process(a, p) { return filt(a, this.sections(p, a.sampleRate)); },
  },
  {
    id: 'highpass', name: 'High-pass filter', category: 'EQ & filters', icon: 'highpass',
    description: 'Remove rumble and low-frequency handling noise.',
    params: [num('freq', 'Cutoff', 10, 5000, 80, { unit: 'Hz', step: 1, scale: 'log' }), sel('order', 'Slope', SLOPES, '4')],
    sections: (p, sr) => butterworth('highpass', p.freq, sr, +p.order),
    process(a, p) { return filt(a, this.sections(p, a.sampleRate)); },
  },
  {
    id: 'lowpass', name: 'Low-pass filter', category: 'EQ & filters', icon: 'lowpass',
    description: 'Remove hiss and high-frequency content above a cutoff.',
    params: [num('freq', 'Cutoff', 200, 22000, 8000, { unit: 'Hz', step: 1, scale: 'log' }), sel('order', 'Slope', SLOPES, '4')],
    sections: (p, sr) => butterworth('lowpass', p.freq, sr, +p.order),
    process(a, p) { return filt(a, this.sections(p, a.sampleRate)); },
  },
  {
    id: 'bassTreble', name: 'Bass & treble', category: 'EQ & filters', icon: 'tone',
    description: 'Quick tone control with shelving filters.',
    params: [num('bass', 'Bass', -18, 18, 3, { unit: 'dB', step: 0.5 }), num('treble', 'Treble', -18, 18, 0, { unit: 'dB', step: 0.5 }), num('bassFreq', 'Bass corner', 40, 400, 120, { unit: 'Hz', step: 1, scale: 'log' }), num('trebleFreq', 'Treble corner', 2000, 16000, 6000, { unit: 'Hz', step: 10, scale: 'log' })],
    sections: (p, sr) => [design('lowshelf', p.bassFreq, sr, 0.707, p.bass), design('highshelf', p.trebleFreq, sr, 0.707, p.treble)],
    process(a, p) { return filt(a, this.sections(p, a.sampleRate)); },
  },
  {
    id: 'telephone', name: 'Telephone / radio', category: 'EQ & filters', icon: 'phone',
    description: 'Band-limit audio to sound like a phone line or radio.',
    params: [num('low', 'Low cut', 100, 1000, 300, { unit: 'Hz', step: 1, scale: 'log' }), num('high', 'High cut', 1500, 8000, 3400, { unit: 'Hz', step: 10, scale: 'log' }), num('drive', 'Grit', 0, 24, 6, { unit: 'dB', step: 0.5 })],
    presets: [
      { name: 'Telephone', values: { low: 300, high: 3400, drive: 6 } },
      { name: 'AM radio', values: { low: 150, high: 5000, drive: 3 } },
      { name: 'Walkie-talkie', values: { low: 500, high: 2600, drive: 14 } },
    ],
    process: (a, p) => {
      const sr = a.sampleRate;
      let out = filt(a, [...butterworth('highpass', p.low, sr, 4), ...butterworth('lowpass', p.high, sr, 4)]);
      if (p.drive > 0) out = mod.distortion(out, { type: 'soft', driveDb: p.drive, outputDb: -p.drive * 0.4, mix: 1 });
      return out;
    },
  },

  // ---------- Time & pitch ----------
  {
    id: 'speed', name: 'Change speed', category: 'Time & pitch', icon: 'gauge', changesLength: true,
    description: 'Play faster or slower like a tape — pitch moves with speed.',
    params: [num('percent', 'Speed', 25, 400, 125, { unit: '%', step: 1 })],
    process: (a, p) => mapChannels(a, ch => resample(ch, p.percent / 100, a.sampleRate)),
  },
  {
    id: 'tempo', name: 'Change tempo', category: 'Time & pitch', icon: 'tempo', changesLength: true,
    description: 'Make it faster or slower without changing pitch.',
    params: [num('percent', 'Tempo change', -50, 100, 10, { unit: '%', step: 1 })],
    info: (a) => `Current length ${a.duration.toFixed(2)} s`,
    process: (a, p) => new AudioData(wsola(a.channels, 1 + p.percent / 100, a.sampleRate), a.sampleRate),
  },
  {
    id: 'pitch', name: 'Change pitch', category: 'Time & pitch', icon: 'pitch',
    description: 'Shift pitch up or down without changing length.',
    params: [num('semitones', 'Semitones', -24, 24, 2, { step: 1 }), num('cents', 'Fine tune', -100, 100, 0, { unit: 'cents', step: 1 })],
    presets: [
      { name: 'Chipmunk', values: { semitones: 7, cents: 0 } },
      { name: 'Deep voice', values: { semitones: -5, cents: 0 } },
      { name: 'Octave up', values: { semitones: 12, cents: 0 } },
      { name: 'Octave down', values: { semitones: -12, cents: 0 } },
    ],
    process: (a, p) => new AudioData(pitchShift(a.channels, p.semitones + p.cents / 100, a.sampleRate), a.sampleRate),
  },
  {
    id: 'reverse', name: 'Reverse', category: 'Time & pitch', icon: 'reverse', quick: true,
    description: 'Play the selection backwards.', params: [],
    process: (a) => dyn.reverse(a),
  },
  {
    id: 'repeat', name: 'Repeat', category: 'Time & pitch', icon: 'repeat', changesLength: true,
    description: 'Loop the selection a number of extra times.',
    params: [num('times', 'Extra repeats', 1, 64, 1, { step: 1 })],
    process: (a, p) => dyn.repeat(a, Math.round(p.times)),
  },

  // ---------- Delay & reverb ----------
  {
    id: 'echo', name: 'Echo', category: 'Delay & reverb', icon: 'echo',
    description: 'Repeating delay with feedback.',
    params: [num('delayMs', 'Delay', 10, 2000, 350, { unit: 'ms', step: 1 }), num('feedback', 'Feedback', 0, 0.95, 0.4, { step: 0.01 }), num('wet', 'Echo level', 0, 1, 0.5, { step: 0.01 }), num('dry', 'Original level', 0, 1, 1, { step: 0.01 })],
    process: (a, p) => mod.echo(a, p),
  },
  {
    id: 'reverb', name: 'Reverb', category: 'Delay & reverb', icon: 'reverb',
    description: 'Algorithmic room ambience.',
    params: [
      num('roomSize', 'Room size', 0, 100, 70, { unit: '%', step: 1 }), num('damping', 'Damping', 0, 100, 40, { unit: '%', step: 1 }),
      num('width', 'Stereo width', 0, 100, 100, { unit: '%', step: 1 }), num('preDelayMs', 'Pre-delay', 0, 200, 12, { unit: 'ms', step: 1 }),
      num('wetDb', 'Reverb level', -40, 6, -10, { unit: 'dB', step: 0.5 }), num('dryDb', 'Original level', -60, 6, 0, { unit: 'dB', step: 0.5 }),
      num('tailSec', 'Add tail', 0, 10, 0, { unit: 's', step: 0.1, help: 'Extends the audio so the reverb can ring out.' }),
    ],
    changesLength: true,
    presets: [
      { name: 'Small room', values: { roomSize: 40, damping: 60, width: 80, preDelayMs: 5, wetDb: -14, dryDb: 0 } },
      { name: 'Hall', values: { roomSize: 85, damping: 35, width: 100, preDelayMs: 25, wetDb: -9, dryDb: 0 } },
      { name: 'Cathedral', values: { roomSize: 97, damping: 20, width: 100, preDelayMs: 40, wetDb: -6, dryDb: -2, tailSec: 3 } },
      { name: 'Vocal plate', values: { roomSize: 65, damping: 50, width: 100, preDelayMs: 15, wetDb: -12, dryDb: 0 } },
    ],
    process: (a, p) => mod.reverb(a, { ...p, roomSize: p.roomSize / 100, damping: p.damping / 100, width: p.width / 100 }),
  },

  // ---------- Modulation ----------
  {
    id: 'chorus', name: 'Chorus', category: 'Modulation', icon: 'chorus',
    description: 'Thicken a sound with slightly detuned copies.',
    params: [num('rate', 'Rate', 0.05, 5, 0.8, { unit: 'Hz', step: 0.01 }), num('depthMs', 'Depth', 0.1, 10, 3, { unit: 'ms' }), num('delayMs', 'Delay', 5, 40, 18, { unit: 'ms' }), num('mix', 'Mix', 0, 1, 0.5, { step: 0.01 })],
    process: (a, p) => mod.chorus(a, p),
  },
  {
    id: 'flanger', name: 'Flanger', category: 'Modulation', icon: 'flanger',
    description: 'Sweeping comb-filter jet sound.',
    params: [num('rate', 'Rate', 0.02, 5, 0.25, { unit: 'Hz', step: 0.01 }), num('depthMs', 'Depth', 0.1, 8, 2.5, { unit: 'ms' }), num('delayMs', 'Delay', 0.1, 10, 1, { unit: 'ms' }), num('feedback', 'Feedback', -0.95, 0.95, 0.5, { step: 0.01 }), num('mix', 'Mix', 0, 1, 0.5, { step: 0.01 })],
    process: (a, p) => mod.flanger(a, p),
  },
  {
    id: 'phaser', name: 'Phaser', category: 'Modulation', icon: 'phaser',
    description: 'Swirling all-pass notches.',
    params: [num('rate', 'Rate', 0.02, 5, 0.4, { unit: 'Hz', step: 0.01 }), num('stages', 'Stages', 2, 12, 6, { step: 2 }), num('depth', 'Depth', 0, 1, 0.8, { step: 0.01 }), num('minHz', 'Low frequency', 50, 2000, 300, { unit: 'Hz', step: 1, scale: 'log' }), num('maxHz', 'High frequency', 500, 12000, 3000, { unit: 'Hz', step: 10, scale: 'log' }), num('feedback', 'Feedback', 0, 0.95, 0.5, { step: 0.01 }), num('mix', 'Mix', 0, 1, 0.5, { step: 0.01 })],
    process: (a, p) => mod.phaser(a, p),
  },
  {
    id: 'vibrato', name: 'Vibrato', category: 'Modulation', icon: 'vibrato',
    description: 'Periodic pitch wobble.',
    params: [num('rate', 'Rate', 0.5, 14, 5, { unit: 'Hz', step: 0.1 }), num('depthMs', 'Depth', 0.05, 5, 1.5, { unit: 'ms', step: 0.05 })],
    process: (a, p) => mod.vibrato(a, p),
  },
  {
    id: 'tremolo', name: 'Tremolo', category: 'Modulation', icon: 'tremolo',
    description: 'Periodic volume wobble.',
    params: [num('rate', 'Rate', 0.1, 20, 5, { unit: 'Hz', step: 0.1 }), num('depth', 'Depth', 0, 1, 0.5, { step: 0.01 }), sel('shape', 'Shape', LFO, 'sine')],
    process: (a, p) => mod.tremolo(a, p),
  },
  {
    id: 'autopan', name: 'Auto-pan', category: 'Modulation', icon: 'pan', stereo: true,
    description: 'Move the sound between left and right.',
    params: [num('rate', 'Rate', 0.05, 10, 0.5, { unit: 'Hz', step: 0.01 }), num('depth', 'Depth', 0, 1, 0.8, { step: 0.01 }), sel('shape', 'Shape', LFO, 'sine')],
    process: (a, p) => mod.autoPan(a, p),
  },
  {
    id: 'ringmod', name: 'Ring modulator', category: 'Modulation', icon: 'robot',
    description: 'Metallic, robotic tones by multiplying with an oscillator.',
    params: [num('freq', 'Frequency', 1, 2000, 30, { unit: 'Hz', step: 0.1, scale: 'log' }), num('mix', 'Mix', 0, 1, 1, { step: 0.01 }), sel('shape', 'Shape', LFO, 'sine')],
    presets: [{ name: 'Robot voice', values: { freq: 30, mix: 1, shape: 'sine' } }, { name: 'Dalek-style', values: { freq: 50, mix: 1, shape: 'triangle' } }, { name: 'Bell tone', values: { freq: 440, mix: 0.6, shape: 'sine' } }],
    process: (a, p) => mod.ringMod(a, p),
  },

  // ---------- Distortion ----------
  {
    id: 'distortion', name: 'Distortion', category: 'Distortion', icon: 'distort',
    description: 'Saturate or clip for warmth or grit.',
    params: [sel('type', 'Character', [['soft', 'Soft saturation'], ['tube', 'Tube (asymmetric)'], ['hard', 'Hard clip'], ['fuzz', 'Fuzz'], ['foldback', 'Wave folder']], 'soft'), num('driveDb', 'Drive', 0, 48, 12, { unit: 'dB', step: 0.5 }), num('outputDb', 'Output', -36, 6, -6, { unit: 'dB', step: 0.5 }), num('mix', 'Mix', 0, 1, 1, { step: 0.01 })],
    process: (a, p) => mod.distortion(a, p),
  },
  {
    id: 'bitcrush', name: 'Bitcrusher', category: 'Distortion', icon: 'bits',
    description: 'Lo-fi reduction of bit depth and sample rate.',
    params: [num('bits', 'Bit depth', 1, 16, 8, { step: 1 }), num('downsample', 'Downsample', 1, 64, 4, { unit: '×', step: 1 }), num('mix', 'Mix', 0, 1, 1, { step: 0.01 })],
    process: (a, p) => mod.bitcrush(a, p),
  },
  {
    id: 'invert', name: 'Invert polarity', category: 'Distortion', icon: 'invert', quick: true,
    description: 'Flip the waveform upside down.', params: [],
    process: (a) => dyn.invert(a),
  },

  // ---------- Restoration ----------
  {
    id: 'noiseReduction', name: 'Noise reduction', category: 'Restoration', icon: 'denoise',
    description: 'Remove steady background noise like hiss, hum or air conditioning.',
    params: [num('reductionDb', 'Reduction', 0, 48, 12, { unit: 'dB', step: 0.5 }), num('sensitivityDb', 'Sensitivity', 0, 24, 6, { unit: 'dB', step: 0.5 }), num('smoothingBands', 'Frequency smoothing', 0, 12, 3, { unit: 'bands', step: 1 }), num('attackMs', 'Attack', 1, 200, 20, { unit: 'ms', step: 1 }), num('releaseMs', 'Release', 10, 1000, 120, { unit: 'ms', step: 1 })],
    info: (a, ctx) => ctx?.noiseProfile ? `Using the captured noise profile (${ctx.noiseProfile.frames} frames).` : 'No noise profile captured — the quietest 10% of the selection will be used. For best results select pure noise and run Effects › Capture noise profile first.',
    process: (a, p, ctx) => rest.noiseReduce(a, ctx?.noiseProfile && ctx.noiseProfile.sampleRate === a.sampleRate ? ctx.noiseProfile : null, p),
  },
  {
    id: 'declick', name: 'Click removal', category: 'Restoration', icon: 'declick',
    description: 'Repair short clicks and pops from vinyl or bad edits.',
    params: [num('sensitivity', 'Threshold', 2, 20, 6, { step: 0.5, help: 'Lower catches more clicks.' }), num('maxWidthMs', 'Max click width', 0.2, 10, 2, { unit: 'ms', step: 0.1 })],
    process: (a, p) => rest.declick(a, p),
  },
  {
    id: 'hum', name: 'Hum removal', category: 'Restoration', icon: 'hum',
    description: 'Notch out mains hum and its harmonics.',
    params: [sel('baseHz', 'Mains frequency', [['50', '50 Hz (Europe, Asia, Africa)'], ['60', '60 Hz (Americas)']], '50'), num('harmonics', 'Harmonics', 1, 12, 5, { step: 1 }), num('q', 'Notch Q', 5, 100, 30, { step: 1 })],
    process: (a, p) => rest.humRemoval(a, { ...p, baseHz: +p.baseHz }),
  },
  {
    id: 'dc', name: 'Remove DC offset', category: 'Restoration', icon: 'dc', quick: true,
    description: 'Center the waveform on zero.', params: [],
    process: (a) => dyn.removeDC(a),
  },
  {
    id: 'truncateSilence', name: 'Truncate silence', category: 'Restoration', icon: 'silence-cut', changesLength: true,
    description: 'Shorten long pauses automatically.',
    params: [num('thresholdDb', 'Silence below', -80, -10, -45, { unit: 'dB' }), num('minSec', 'Pauses longer than', 0.1, 10, 0.6, { unit: 's', step: 0.05 }), num('keepSec', 'Shorten to', 0, 5, 0.25, { unit: 's', step: 0.05 })],
    process: (a, p) => rest.truncateSilence(a, p),
  },

  // ---------- Stereo ----------
  {
    id: 'widen', name: 'Stereo width', category: 'Stereo', icon: 'widen', stereo: true,
    description: 'Narrow or widen the stereo image with mid/side scaling.',
    params: [num('width', 'Width', 0, 300, 150, { unit: '%', step: 1, help: '0% is mono, 100% unchanged.' })],
    process: (a, p) => rest.stereoWidth(a, p.width / 100),
  },
  {
    id: 'swap', name: 'Swap channels', category: 'Stereo', icon: 'swap', stereo: true, quick: true,
    description: 'Exchange left and right.', params: [],
    process: (a) => rest.swapChannels(a),
  },
  {
    id: 'vocalRemove', name: 'Vocal remover', category: 'Stereo', icon: 'karaoke', stereo: true,
    description: 'Cancel centre-panned vocals for a karaoke-style backing.',
    params: [num('keepBassHz', 'Keep bass below', 0, 400, 120, { unit: 'Hz', step: 1 })],
    process: (a, p) => rest.vocalRemove(a, p),
  },
  {
    id: 'monoMix', name: 'Mix to mono', category: 'Stereo', icon: 'mono', quick: true,
    description: 'Sum channels and put the result on every channel.', params: [],
    process: (a) => rest.monoMix(a),
  },
];

export const effectById = (id) => EFFECTS.find(e => e.id === id);

export function defaultParams(effect) {
  return Object.fromEntries(effect.params.map(p => [p.id, p.default]));
}

export function describeParams(effect, values) {
  return effect.params
    .filter(p => !p.showIf || p.showIf(values))
    .map(p => {
      const v = values[p.id];
      if (p.type === 'bool') return v ? p.label : null;
      if (p.type === 'select') return `${p.label}: ${(p.options.find(o => o[0] === String(v)) || [v, v])[1]}`;
      return `${p.label} ${typeof v === 'number' ? +v.toFixed(2) : v}${p.unit ? ' ' + p.unit : ''}`;
    })
    .filter(Boolean)
    .join(' · ');
}

export async function runEffect(effect, audio, params, ctx) {
  const p = { ...defaultParams(effect), ...params };
  const out = await effect.process(audio, p, ctx);
  return out;
}

export { truePeak, measureLoudness };
