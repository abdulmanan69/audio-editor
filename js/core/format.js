// Formatting, parsing and small numeric helpers shared across the app.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => (g <= 0 ? -Infinity : 20 * Math.log10(g));

let uidCounter = 0;
export const uid = (prefix = 'id') => `${prefix}-${Date.now().toString(36)}-${(uidCounter++).toString(36)}`;

export function formatDb(db, digits = 1) {
  if (!isFinite(db)) return '-∞';
  return (db > 0 ? '+' : '') + db.toFixed(digits);
}

// hh:mm:ss.mmm (hours always shown so the VFD layout stays fixed)
export function formatTime(sec, mode = 'hms', sampleRate = 48000) {
  if (!isFinite(sec)) sec = 0;
  const neg = sec < 0;
  sec = Math.abs(sec);
  if (mode === 'samples') return (neg ? '-' : '') + Math.round(sec * sampleRate).toString();
  if (mode === 'seconds') return (neg ? '-' : '') + sec.toFixed(3);
  const totalMs = Math.round(sec * 1000);
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60000) % 60;
  const h = Math.floor(totalMs / 3600000);
  return `${neg ? '-' : ''}${pad(h)}:${pad(m)}:${pad(s)}.${String(ms).padStart(3, '0')}`;
}

export function formatTimeShort(sec) {
  if (!isFinite(sec)) return '0:00';
  const totalMs = Math.round(sec * 1000);
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60000) % 60;
  const h = Math.floor(totalMs / 3600000);
  const base = h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  return `${base}.${String(ms).padStart(3, '0')}`;
}

export function formatDuration(sec) {
  if (!isFinite(sec) || sec <= 0) return '0 s';
  if (sec < 1) return `${Math.round(sec * 1000)} ms`;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 2 : 1)} s`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  if (m < 60) return `${m}m ${pad(s)}s`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

const pad = (n) => String(n).padStart(2, '0');

// Accepts "hh:mm:ss.mmm", "mm:ss.mmm", "ss.mmm", "1500ms", "12s", "48000smp"
export function parseTime(str, mode = 'hms', sampleRate = 48000) {
  if (str == null) return NaN;
  const t = String(str).trim().toLowerCase();
  if (!t) return NaN;
  if (/^-?\d+(\.\d+)?\s*ms$/.test(t)) return parseFloat(t) / 1000;
  if (/^-?\d+(\.\d+)?\s*s$/.test(t)) return parseFloat(t);
  if (/^-?\d+\s*(smp|samples?)$/.test(t)) return parseInt(t, 10) / sampleRate;
  if (mode === 'samples' && /^-?\d+$/.test(t)) return parseInt(t, 10) / sampleRate;
  const parts = t.split(':');
  if (parts.length > 3 || parts.some(p => p === '' || isNaN(Number(p)))) return NaN;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + Number(p);
  return sec;
}

export function formatBytes(n) {
  if (!isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function formatHz(hz) {
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k`;
  return `${Math.round(hz)}`;
}

export function formatRate(sr) { return `${(sr / 1000).toFixed(sr % 1000 ? 1 : 0)} kHz`; }

export function sanitizeFilename(name) {
  return (name || 'untitled').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'untitled';
}

export function stripExtension(name) { return String(name || '').replace(/\.[a-z0-9]{1,5}$/i, ''); }

export const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

export function debounce(fn, ms) {
  let t = 0;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
