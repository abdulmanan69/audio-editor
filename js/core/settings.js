import { Emitter } from './events.js';

const KEY = 'kerf.settings';

export const DEFAULT_SETTINGS = {
  theme: 'system',          // 'system' | 'dark' | 'light'
  timeFormat: 'hms',        // 'hms' | 'seconds' | 'samples'
  sampleRate: 48000,        // new-project rate
  autosave: true,
  followPlayhead: true,
  snapZero: false,
  historyLimit: 100,
  overdub: true,            // play other tracks while recording
  inputDevice: '',
  confirmDeleteTrack: true,
  showRms: true,
  trackHeight: 132,
  bleepFreq: 1000,
  bleepGain: -12,
};

class Settings extends Emitter {
  constructor() {
    super();
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* ignore corrupt settings */ }
    this.values = { ...DEFAULT_SETTINGS, ...saved };
  }
  get(k) { return this.values[k]; }
  set(k, v) {
    if (this.values[k] === v) return;
    this.values[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(this.values)); } catch { /* storage full or blocked */ }
    this.emit('change', { key: k, value: v });
  }
}

export const settings = new Settings();

// Small JSON-in-localStorage helper for presets, chains and recents.
export const local = {
  get(key, fallback) {
    try { const v = localStorage.getItem('kerf.' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('kerf.' + key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};
