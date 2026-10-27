// Feature dialogs: effects, generators, analysis reports, settings and help.
import { h, setupCanvas, clear } from './dom.js';
import { openDialog, buildForm, promptDialog } from './dialog.js';
import { toast, toastError } from './toast.js';
import { displayKey } from '../commands.js';
import { defaultParams, runEffect } from '../dsp/effects.js';
import { responseDb } from '../dsp/biquad.js';
import { channelStats, averageSpectrum } from '../dsp/analysis.js';
import { measureLoudness, truePeak } from '../dsp/loudness.js';
import { slice } from '../core/audio-data.js';
import { local, settings } from '../core/settings.js';
import { formatDb, gainToDb, formatDuration, formatRate, formatBytes, formatHz, downloadBlob, sanitizeFilename } from '../core/format.js';
import { Recorder } from '../audio/recorder.js';

export const RATES = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000];

function scopeNote(app) {
  const n = app.targets.length;
  if (!app.tracks.length) return null;
  const tracks = n > 1 ? `${n} tracks` : `“${app.targets[0].name}”`;
  return app.hasRange
    ? h('div.note', `Applies to ${formatDuration(app.selection.end - app.selection.start)} selected on ${tracks}.`)
    : h('div.note.warn', `Nothing is selected, so this applies to the whole of ${tracks}.`);
}

// Audio used for effect previews and info lines: the selection, or 10 s from the playhead.
function previewSource(app, maxSec = 10) {
  const t = app.targets[0];
  if (!t || !t.audio.length) return null;
  const sr = t.audio.sampleRate, len = t.audio.length;
  let [s, e] = app.hasRange ? app.rangeSamples(t) : [Math.round(app.playhead * sr), len];
  if (s >= len) s = 0;
  e = Math.min(e, s + Math.round(maxSec * sr), len);
  if (e <= s) return null;
  return slice(t.audio, s, e);
}

function previewButton(app, render) {
  const btn = h('button.btn.btn-ghost', { type: 'button', html: '<span>Preview</span>' });
  const label = (l) => { btn.querySelector('span').textContent = l; };
  const off = app.engine.on('preview', (on) => label(on ? 'Stop preview' : 'Preview'));
  btn.addEventListener('click', async () => {
    if (app.engine.preview) { app.engine.stopPreview(); return; }
    label('Rendering…');
    btn.disabled = true;
    try {
      const audio = await render();
      if (audio) app.engine.playPreview(audio); else { toast('Nothing to preview — add or select some audio first.', { type: 'warn' }); label('Preview'); }
    } catch (err) { toastError(err); label('Preview'); }
    finally { btn.disabled = false; }
  });
  btn.cleanup = () => { off(); app.engine.stopPreview(); };
  return btn;
}

function drawCurve(canvas, sections, sr) {
  const { ctx, w, h: hgt } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, hgt);
  const fMin = 20, fMax = Math.min(20000, sr / 2), range = 24;
  const xOf = (f) => (Math.log(f / fMin) / Math.log(fMax / fMin)) * w;
  const yOf = (db) => hgt / 2 - (db / range) * (hgt / 2 - 6);
  ctx.strokeStyle = 'rgba(92,242,214,0.1)';
  ctx.fillStyle = 'rgba(92,242,214,0.45)';
  ctx.font = '500 9px "IBM Plex Mono", monospace';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(xOf(f)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hgt); ctx.stroke();
    ctx.fillText(formatHz(f), x + 2, hgt - 3);
  }
  for (const db of [-18, -12, -6, 0, 6, 12, 18]) {
    const y = Math.round(yOf(db)) + 0.5;
    ctx.strokeStyle = db === 0 ? 'rgba(92,242,214,0.3)' : 'rgba(92,242,214,0.08)';
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    if (db) ctx.fillText(`${db > 0 ? '+' : ''}${db}`, 3, y - 2);
  }
  ctx.beginPath();
  for (let x = 0; x <= w; x++) {
    const f = fMin * Math.pow(fMax / fMin, x / w);
    const db = Math.max(-range * 1.5, Math.min(range * 1.5, responseDb(sections, f, sr)));
    if (x === 0) ctx.moveTo(x, yOf(db)); else ctx.lineTo(x, yOf(db));
  }
  ctx.strokeStyle = '#ffb547';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function presetControls(fx, values, form) {
  const builtins = fx.presets || [];
  let user = local.get(`presets.${fx.id}`, []);
  const sel = h('select.select', { 'aria-label': 'Presets' });
  const del = h('button.icon-btn', { type: 'button', title: 'Delete preset', 'aria-label': 'Delete preset', html: '' });
  const rebuild = (selectValue = '') => {
    clear(sel);
    sel.append(h('option', { value: '' }, builtins.length || user.length ? 'Choose a preset…' : 'No presets yet'));
    if (builtins.length) sel.append(h('optgroup', { label: 'Built-in' }, builtins.map((p, i) => h('option', { value: `b${i}` }, p.name))));
    if (user.length) sel.append(h('optgroup', { label: 'Saved' }, user.map((p, i) => h('option', { value: `u${i}` }, p.name))));
    sel.value = selectValue;
    del.disabled = !sel.value.startsWith('u');
  };
  sel.addEventListener('change', () => {
    const v = sel.value;
    del.disabled = !v.startsWith('u');
    if (!v) return;
    const p = v[0] === 'b' ? builtins[+v.slice(1)] : user[+v.slice(1)];
    form.setValues({ ...defaultParams(fx), ...p.values });
  });
  const save = h('button.btn.btn-sm', { type: 'button', onclick: async () => {
    const name = await promptDialog({ title: 'Save preset', label: 'Preset name', value: '', placeholder: `My ${fx.name.toLowerCase()}`, confirmLabel: 'Save preset' });
    if (!name) return;
    user = user.filter(p => p.name !== name.trim()).concat({ name: name.trim(), values: { ...values } });
    local.set(`presets.${fx.id}`, user);
    rebuild(`u${user.length - 1}`);
    toast(`Saved preset “${name.trim()}”`);
  } }, 'Save preset');
  del.innerHTML = '<svg class="ico" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
  del.addEventListener('click', () => {
    if (!sel.value.startsWith('u')) return;
    user.splice(+sel.value.slice(1), 1);
    local.set(`presets.${fx.id}`, user);
    rebuild();
  });
  rebuild();
  return h('div.preset-row', sel, save, del);
}

export function openEffectDialog(app, fx, { values: initial, mode = 'apply', onDone } = {}) {
  const values = { ...defaultParams(fx), ...(mode === 'apply' ? local.get(`fx.${fx.id}`, {}) : {}), ...(initial || {}) };
  const sr = app.sampleRate;
  const curve = fx.sections ? h('canvas.plot-canvas', { style: { height: '130px', marginBottom: '14px', cursor: 'default' } }) : null;
  const redraw = () => { if (curve) requestAnimationFrame(() => drawCurve(curve, fx.sections(values, sr), sr)); };
  const form = buildForm(fx.params, values, { layout: fx.layout, onChange: redraw });
  const info = h('div.note', { hidden: true });
  const src = mode === 'apply' ? previewSource(app, 60) : null;
  if (fx.info && src) {
    try { info.textContent = fx.info(src, app.effectContext()); info.hidden = false; } catch { /* informational only */ }
  } else if (fx.info && fx.id === 'noiseReduction') { info.textContent = fx.info(null, app.effectContext()); info.hidden = false; }
  const preview = app.tracks.length ? previewButton(app, async () => {
    const a = previewSource(app);
    return a ? runEffect(fx, a, values, app.effectContext()) : null;
  }) : null;
  const content = h('div', presetControls(fx, values, form), curve, form.el, h('div', { style: { height: '12px' } }), mode === 'apply' ? scopeNote(app) : null, info.hidden ? null : h('div', { style: { height: '8px' } }), info);
  openDialog({
    title: fx.name, subtitle: fx.description,
    size: fx.layout === 'geq' ? 'wide' : '',
    content,
    footerStart: preview,
    actions: [
      { label: 'Reset', kind: 'ghost', closes: false, onClick: () => form.setValues(defaultParams(fx)) },
      { label: 'Cancel', kind: 'ghost' },
      { label: mode === 'chain' ? (initial ? 'Update step' : 'Add step') : 'Apply', kind: 'accent', id: 'apply', onClick: () => {
        if (mode === 'chain') { onDone?.({ ...values }); return; }
        local.set(`fx.${fx.id}`, values);
        setTimeout(() => app.applyEffect(fx, { ...values }), 0);
      } },
    ],
    onClose: () => preview?.cleanup(),
  });
  redraw();
}

export function openGeneratorDialog(app, gen) {
  const values = { ...Object.fromEntries(gen.params.map(p => [p.id, p.default])), ...local.get(`gen.${gen.id}`, {}) };
  const hasDur = gen.params.some(p => p.id === 'duration');
  if (hasDur && app.hasRange) values.duration = +(app.selection.end - app.selection.start).toFixed(3);
  const opts = [];
  if (app.tracks.length) {
    if (app.hasRange) opts.push(['replace', 'Replace the selection']);
    opts.push(['insert', `Insert at the cursor (${app.fmt(app.selection.start)})`]);
  }
  opts.push(['new', app.tracks.length ? 'Add as a new track at the cursor' : 'Add as a new track']);
  let mode = opts[0][0];
  if (gen.id !== 'silence' && app.tracks.length && !app.tracks.some(t => t.selected) && !app.hasRange) mode = 'new';
  const modeValues = { mode };
  const modeForm = opts.length > 1 ? buildForm([{ id: 'mode', label: 'Place it', type: 'select', options: opts, default: mode }], modeValues) : null;
  const form = buildForm(gen.params, values);
  const preview = previewButton(app, async () => {
    const p = { ...values };
    if (p.duration) p.duration = Math.min(p.duration, 10);
    return gen.generate(p, app.sampleRate, 1);
  });
  openDialog({
    title: gen.id === 'silence' ? 'Insert silence' : `Generate ${gen.name.toLowerCase()}`,
    subtitle: gen.description,
    content: h('div.form', form.el, modeForm?.el),
    footerStart: gen.id === 'silence' ? null : preview,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: gen.id === 'silence' ? 'Insert silence' : 'Generate', kind: 'accent', onClick: () => {
        local.set(`gen.${gen.id}`, values);
        try { app.generate(gen, { ...values }, modeValues.mode); } catch (err) { toastError(err); }
      } },
    ],
    onClose: () => preview.cleanup(),
  });
}

export function openParamsDialog({ title, subtitle, params, values = {}, applyLabel = 'Apply', onApply }) {
  const v = { ...Object.fromEntries(params.map(p => [p.id, p.default])), ...values };
  const form = buildForm(params, v);
  openDialog({ title, subtitle, content: form.el, actions: [{ label: 'Cancel', kind: 'ghost' }, { label: applyLabel, kind: 'accent', onClick: () => onApply({ ...v }) }] });
}

// ---------- Loudness & level report ----------
const SPECS = {
  none: { name: 'No delivery spec' },
  podcast: { name: 'Podcast (Apple / Spotify): −16 LUFS, −1 dBTP', lufs: -16, tol: 1, tp: -1 },
  streaming: { name: 'Music streaming: −14 LUFS, −1 dBTP', lufs: -14, tol: 1, tp: -1 },
  ebu: { name: 'EBU R128 broadcast: −23 LUFS ±0.5, −1 dBTP', lufs: -23, tol: 0.5, tp: -1 },
  atsc: { name: 'ATSC A/85 (US TV): −24 LKFS ±2, −2 dBTP', lufs: -24, tol: 2, tp: -2 },
  acx: { name: 'ACX audiobook: RMS −23…−18 dB, peak ≤ −3 dB, floor ≤ −60 dB', acx: true },
};

function noiseFloor(audio) {
  const sr = audio.sampleRate, win = Math.round(sr * 0.5), step = Math.round(sr * 0.1);
  if (audio.length < win) return null;
  let best = Infinity;
  for (let s = 0; s + win <= audio.length; s += step) {
    let sq = 0;
    for (const ch of audio.channels) for (let i = s; i < s + win; i++) sq += ch[i] * ch[i];
    const r = Math.sqrt(sq / (win * audio.numberOfChannels));
    if (r < best) best = r;
  }
  return gainToDb(best);
}

function measure(audio) {
  const stats = channelStats(audio);
  const loud = measureLoudness(audio);
  const tp = gainToDb(truePeak(audio));
  const peak = Math.max(...stats.map(s => s.peak));
  const rms = Math.sqrt(stats.reduce((a, s) => a + s.rms * s.rms, 0) / stats.length);
  return { stats, loud, tp, peakDb: gainToDb(peak), rmsDb: gainToDb(rms), floor: noiseFloor(audio), duration: audio.duration };
}

function checks(m, spec) {
  const out = [];
  if (spec.lufs != null) {
    const ok = isFinite(m.loud.integrated) && Math.abs(m.loud.integrated - spec.lufs) <= spec.tol;
    out.push(['Integrated loudness', `${isFinite(m.loud.integrated) ? m.loud.integrated.toFixed(1) : '−∞'} LUFS (target ${spec.lufs} ±${spec.tol})`, ok]);
    out.push(['True peak', `${formatDb(m.tp)} dBTP (max ${spec.tp})`, m.tp <= spec.tp + 0.05]);
  }
  if (spec.acx) {
    out.push(['RMS level', `${formatDb(m.rmsDb)} dB (−23 to −18)`, m.rmsDb >= -23 && m.rmsDb <= -18]);
    out.push(['Peak level', `${formatDb(m.peakDb)} dBFS (max −3)`, m.peakDb <= -3]);
    out.push(['Noise floor', m.floor == null ? 'Too short to measure' : `${formatDb(m.floor)} dB (max −60)`, m.floor != null && m.floor <= -60]);
  }
  return out;
}

export async function openStatsDialog(app) {
  const targets = app.targets;
  let results;
  try {
    results = await app.busy('Measuring loudness…', async (progress) => {
      const r = [];
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const [s, e] = app.hasRange ? app.rangeSamples(t) : [0, t.audio.length];
        if (e > s) r.push({ track: t, m: measure(slice(t.audio, s, e)) });
        progress((i + 1) / targets.length);
      }
      return r;
    });
  } catch (err) { toastError(err); return; }
  if (!results.length) { toast('Nothing to measure in the selection.', { type: 'warn' }); return; }
  const specSel = h('select.select', { 'aria-label': 'Delivery spec' }, Object.entries(SPECS).map(([k, s]) => h('option', { value: k }, s.name)));
  specSel.value = local.get('statsSpec', 'podcast');
  const body = h('div');
  const chName = (n, i) => (n === 1 ? 'Mono' : n === 2 ? ['Left', 'Right'][i] : `Ch ${i + 1}`);
  const render = () => {
    clear(body);
    const spec = SPECS[specSel.value];
    local.set('statsSpec', specSel.value);
    for (const { track, m } of results) {
      if (results.length > 1) body.append(h('div.section-title', track.name));
      const cell = (v, l) => h('div.loud-cell', h('div.lc-val', v), h('div.lc-label', l));
      body.append(h('div.loud-grid',
        cell(isFinite(m.loud.integrated) ? m.loud.integrated.toFixed(1) : '−∞', 'Integrated LUFS'),
        cell(isFinite(m.loud.shortTermMax) ? m.loud.shortTermMax.toFixed(1) : '−∞', 'Short-term max'),
        cell(m.loud.lra.toFixed(1), 'Loudness range LU'),
        cell(formatDb(m.tp), 'True peak dBTP')));
      const cs = checks(m, spec);
      if (cs.length) {
        body.append(h('table.report-table', { style: { marginBottom: '14px' } }, h('tbody', cs.map(([k, v, ok]) => h('tr', h('td', k), h('td', v), h('td', { class: ok ? 'good' : 'bad' }, ok ? 'PASS' : 'FAIL'))))));
      }
      const n = m.stats.length;
      const row = (label, fn, bad) => h('tr', h('td', label), m.stats.map(s => h('td', { class: bad?.(s) ? 'bad' : '' }, fn(s))));
      body.append(h('div.table-scroll', h('table.report-table',
        h('thead', h('tr', h('th', `${formatDuration(m.duration)}`), m.stats.map((_, i) => h('th', chName(n, i))))),
        h('tbody',
          row('Peak', s => `${formatDb(s.peakDb)} dBFS`, s => s.peakDb > -0.1),
          row('RMS', s => `${formatDb(s.rmsDb)} dB`),
          row('Crest factor', s => `${s.crestDb.toFixed(1)} dB`),
          row('DC offset', s => `${(s.dc * 100).toFixed(3)} %`, s => Math.abs(s.dc) > 0.005),
          row('Min / max sample', s => `${s.min.toFixed(3)} / ${s.max.toFixed(3)}`),
          row('Clipped samples', s => String(s.clipped), s => s.clipped > 0),
          h('tr', h('td', 'Noise floor (quietest 0.5 s)'), h('td', { colSpan: n }, m.floor == null ? '—' : `${formatDb(m.floor)} dB`)),
          h('tr', h('td', 'Momentary max'), h('td', { colSpan: n }, isFinite(m.loud.momentaryMax) ? `${m.loud.momentaryMax.toFixed(1)} LUFS` : '—')),
        ))));
    }
  };
  specSel.addEventListener('change', render);
  render();
  const report = () => results.map(({ track, m }) => {
    const lines = [`${track.name} — ${app.hasRange ? 'selection' : 'whole track'} (${formatDuration(m.duration)})`,
      `Integrated: ${m.loud.integrated.toFixed(1)} LUFS`, `Loudness range: ${m.loud.lra.toFixed(1)} LU`, `Short-term max: ${m.loud.shortTermMax.toFixed(1)} LUFS`, `True peak: ${formatDb(m.tp)} dBTP`,
      `Peak: ${formatDb(m.peakDb)} dBFS`, `RMS: ${formatDb(m.rmsDb)} dB`, `Noise floor: ${m.floor == null ? '—' : formatDb(m.floor) + ' dB'}`];
    for (const [k, v, ok] of checks(m, SPECS[specSel.value])) lines.push(`${ok ? 'PASS' : 'FAIL'} ${k}: ${v}`);
    return lines.join('\n');
  }).join('\n\n');
  openDialog({
    title: 'Loudness & level report',
    subtitle: `${app.hasRange ? 'Selection' : 'Whole track'} · measured to ITU-R BS.1770-4 / EBU R128`,
    size: 'wide',
    content: h('div', h('label.field', { style: { marginBottom: '14px' } }, h('span.field-label', 'Check against'), specSel), body),
    actions: [
      { label: 'Copy report', kind: 'ghost', closes: false, onClick: async () => { try { await navigator.clipboard.writeText(report()); toast('Report copied'); } catch { toast('Clipboard is blocked in this browser.', { type: 'warn' }); } } },
      { label: 'Download CSV', kind: 'ghost', closes: false, onClick: () => {
        const rows = [['Track', 'Duration s', 'Integrated LUFS', 'LRA LU', 'Short-term max LUFS', 'True peak dBTP', 'Peak dBFS', 'RMS dB', 'Noise floor dB']];
        for (const { track, m } of results) rows.push([track.name, m.duration.toFixed(3), m.loud.integrated.toFixed(2), m.loud.lra.toFixed(2), m.loud.shortTermMax.toFixed(2), m.tp.toFixed(2), m.peakDb.toFixed(2), m.rmsDb.toFixed(2), m.floor == null ? '' : m.floor.toFixed(2)]);
        downloadBlob(new Blob([rows.map(r => r.map(c => /[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')).join('\n')], { type: 'text/csv' }), `${sanitizeFilename(app.name)} loudness.csv`);
      } },
      { label: 'Done', kind: 'accent' },
    ],
  });
}

// ---------- Spectrum plot ----------
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const noteOf = (f) => { if (f < 16) return ''; const n = Math.round(12 * Math.log2(f / 440) + 69); const cents = Math.round((12 * Math.log2(f / 440) + 69 - n) * 100); return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1} ${cents >= 0 ? '+' : ''}${cents}¢`; };

export function openSpectrumDialog(app) {
  const sum = app.selectionSummary();
  if (!sum || !sum.audio.length) return;
  const sizeSel = h('select.select', { 'aria-label': 'FFT size' }, [1024, 2048, 4096, 8192, 16384].map(n => h('option', { value: n }, `${n} points (${(sum.audio.sampleRate / n).toFixed(1)} Hz bins)`)));
  sizeSel.value = String(local.get('specSize', 4096));
  const axisSel = h('select.select', { 'aria-label': 'Frequency axis' }, h('option', { value: 'log' }, 'Logarithmic frequency'), h('option', { value: 'lin' }, 'Linear frequency'));
  axisSel.value = local.get('specAxis', 'log');
  const canvas = h('canvas.plot-canvas');
  const readout = h('div.plot-readout', 'Move over the plot to read frequency and level.');
  let spec = null, N = 0, peakInfo = '';
  const sr = sum.audio.sampleRate;
  const compute = () => {
    N = +sizeSel.value;
    local.set('specSize', N);
    spec = averageSpectrum(sum.audio, N);
    let pk = 1;
    for (let k = 2; k < spec.length; k++) if (spec[k] > spec[pk]) pk = k;
    peakInfo = `Peak ${formatHz(pk * sr / N)} Hz (${noteOf(pk * sr / N)}) at ${spec[pk].toFixed(1)} dB`;
    draw();
  };
  const geom = () => {
    const fMin = axisSel.value === 'log' ? 20 : 0, fMax = sr / 2;
    let top = -Infinity;
    for (let k = 1; k < spec.length; k++) top = Math.max(top, spec[k]);
    top = Math.ceil((top + 3) / 10) * 10;
    return { fMin, fMax, top, bottom: top - 100 };
  };
  const draw = () => {
    const { ctx, w, h: hgt } = setupCanvas(canvas);
    ctx.clearRect(0, 0, w, hgt);
    const { fMin, fMax, top, bottom } = geom();
    const log = axisSel.value === 'log';
    const xOf = (f) => (log ? Math.log(Math.max(f, fMin) / fMin) / Math.log(fMax / fMin) : f / fMax) * w;
    const yOf = (db) => ((top - db) / (top - bottom)) * hgt;
    ctx.font = '500 9.5px "IBM Plex Mono", monospace';
    ctx.fillStyle = 'rgba(92,242,214,0.5)';
    const marks = log ? [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000] : [0, 2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000, 22000];
    for (const f of marks) {
      if (f > fMax) continue;
      const x = Math.round(xOf(f)) + 0.5;
      ctx.strokeStyle = 'rgba(92,242,214,0.09)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hgt); ctx.stroke();
      ctx.fillText(formatHz(f), x + 3, hgt - 4);
    }
    for (let db = top; db >= bottom; db -= 10) {
      const y = Math.round(yOf(db)) + 0.5;
      ctx.strokeStyle = 'rgba(92,242,214,0.09)';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillText(`${db} dB`, 4, y + 11);
    }
    ctx.beginPath();
    const binHz = sr / N;
    for (let x = 0; x <= w; x++) {
      const f = log ? fMin * Math.pow(fMax / fMin, x / w) : (x / w) * fMax;
      const f2 = log ? fMin * Math.pow(fMax / fMin, (x + 1) / w) : ((x + 1) / w) * fMax;
      const b0 = Math.max(1, Math.floor(f / binHz)), b1 = Math.max(b0 + 1, Math.ceil(f2 / binHz));
      let m = -200;
      for (let b = b0; b < b1 && b < spec.length; b++) m = Math.max(m, spec[b]);
      const y = Math.min(hgt, yOf(m));
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#5cf2d6';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.lineTo(w, hgt); ctx.lineTo(0, hgt); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, hgt);
    g.addColorStop(0, 'rgba(255,181,71,0.35)'); g.addColorStop(1, 'rgba(92,242,214,0.02)');
    ctx.fillStyle = g;
    ctx.fill();
    readout.textContent = peakInfo;
  };
  canvas.addEventListener('pointermove', (e) => {
    if (!spec) return;
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const { fMin, fMax } = geom();
    const f = axisSel.value === 'log' ? fMin * Math.pow(fMax / fMin, x) : x * fMax;
    const k = Math.min(spec.length - 1, Math.max(1, Math.round(f / (sr / N))));
    readout.textContent = `${f.toFixed(f < 100 ? 1 : 0)} Hz · ${noteOf(f)} · ${spec[k].toFixed(1)} dB`;
  });
  canvas.addEventListener('pointerleave', () => { readout.textContent = peakInfo; });
  sizeSel.addEventListener('change', compute);
  axisSel.addEventListener('change', () => { local.set('specAxis', axisSel.value); draw(); });
  openDialog({
    title: 'Frequency analysis',
    subtitle: `${sum.track.name} · ${sum.whole ? 'whole track' : 'selection'} · ${formatDuration(sum.audio.duration)} · averaged Hann-windowed FFT`,
    size: 'wide',
    content: h('div', h('div.grid-2', { style: { marginBottom: '12px' } }, sizeSel, axisSel), canvas, readout),
    actions: [
      { label: 'Export CSV', kind: 'ghost', closes: false, onClick: () => {
        const lines = ['Frequency (Hz),Level (dB)'];
        for (let k = 0; k < spec.length; k++) lines.push(`${(k * sr / N).toFixed(2)},${spec[k].toFixed(2)}`);
        downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv' }), `${sanitizeFilename(sum.track.name)} spectrum.csv`);
      } },
      { label: 'Done', kind: 'accent' },
    ],
  });
  requestAnimationFrame(compute);
}

// ---------- Bleep options ----------
export function openBleepDialog(app) {
  const params = [
    { id: 'bleepMode', label: 'Replace the selection with', type: 'select', options: [['tone', 'A bleep tone'], ['silence', 'Silence (mute)']], default: 'tone' },
    { id: 'bleepFreq', label: 'Tone frequency', type: 'number', min: 200, max: 4000, step: 1, default: 1000, unit: 'Hz', scale: 'log', showIf: v => v.bleepMode === 'tone' },
    { id: 'bleepGain', label: 'Tone level', type: 'number', min: -40, max: 0, step: 0.5, default: -12, unit: 'dBFS', showIf: v => v.bleepMode === 'tone' },
  ];
  const v = { bleepMode: settings.get('bleepMode') || 'tone', bleepFreq: settings.get('bleepFreq'), bleepGain: settings.get('bleepGain') };
  const form = buildForm(params, v);
  const save = () => Object.entries(v).forEach(([k, val]) => settings.set(k, val));
  openDialog({
    title: 'Bleep options', subtitle: 'Censor words by replacing the selection. Ctrl+B applies these settings instantly.',
    content: h('div.form', form.el, h('div.note', 'Tip: select the word on the waveform (zoom in with Ctrl + scroll), then press Ctrl+B.')),
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Save', kind: app.hasRange ? 'ghost' : 'accent', onClick: save },
      ...(app.hasRange ? [{ label: 'Bleep selection', kind: 'accent', onClick: () => { save(); app.bleep(); } }] : []),
    ],
  });
}

export function openResampleDialog(app) {
  const v = { rate: String(app.sampleRate) };
  const form = buildForm([{ id: 'rate', label: 'New sample rate', type: 'select', options: RATES.map(r => [String(r), formatRate(r)]), default: String(app.sampleRate) }], v);
  openDialog({
    title: 'Change project sample rate',
    subtitle: `Currently ${formatRate(app.sampleRate)}. Every track is resampled; this can be undone.`,
    content: form.el,
    actions: [{ label: 'Cancel', kind: 'ghost' }, { label: 'Resample project', kind: 'accent', onClick: () => app.resampleProject(+v.rate) }],
  });
}

// ---------- Settings ----------
export async function openSettingsDialog(app) {
  let devices = [];
  try { devices = await Recorder.listInputs(); } catch { /* permissions */ }
  const deviceOpts = [['', 'System default'], ...devices.map((d, i) => [d.deviceId, d.label || `Input ${i + 1}`])];
  const params = [
    { id: 'theme', label: 'Theme', type: 'select', options: [['system', 'Match system'], ['dark', 'Dark console'], ['light', 'Light']], default: 'system' },
    { id: 'timeFormat', label: 'Time display', type: 'select', options: [['hms', 'hh:mm:ss.ms'], ['seconds', 'Seconds'], ['samples', 'Samples']], default: 'hms' },
    { id: 'showRms', label: 'Show RMS level inside waveforms', type: 'bool', default: true },
    { id: 'followPlayhead', label: 'Scroll to follow the playhead', type: 'bool', default: true },
    { id: 'snapZero', label: 'Snap edits to zero crossings (avoids clicks)', type: 'bool', default: false },
    { id: 'confirmDeleteTrack', label: 'Ask before deleting tracks', type: 'bool', default: true },
    { id: 'historyLimit', label: 'Undo steps to keep', type: 'number', min: 10, max: 500, step: 10, default: 100 },
    { id: 'inputDevice', label: 'Recording input', type: 'select', options: deviceOpts, default: '' },
    { id: 'overdub', label: 'Play other tracks while recording (overdub)', type: 'bool', default: true },
    { id: 'sampleRate', label: 'Sample rate for new projects', type: 'select', options: RATES.map(r => [String(r), formatRate(r)]), default: '48000' },
    { id: 'autosave', label: 'Autosave the session in this browser', type: 'bool', default: true },
  ];
  const v = Object.fromEntries(params.map(p => [p.id, p.id === 'sampleRate' ? String(settings.get(p.id)) : settings.get(p.id)]));
  const form = buildForm(params, v, {
    onChange: (vals) => {
      for (const p of params) {
        const val = p.id === 'sampleRate' ? +vals[p.id] : vals[p.id];
        if (settings.get(p.id) !== val) settings.set(p.id, val);
      }
    },
  });
  const storageNote = h('div.note', 'Checking storage…');
  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then(async (e) => {
      const persisted = await navigator.storage.persisted?.();
      storageNote.textContent = `Using ${formatBytes(e.usage)} of ${formatBytes(e.quota)} available on this device. ${persisted ? 'Storage is protected from automatic clean-up.' : 'The browser may clear this storage when space runs low.'}`;
    });
  } else storageNote.textContent = 'Storage information is not available in this browser.';
  const fields = [...form.el.children];
  const section = (title, els) => [h('div.section-title', title), ...els];
  const content = h('div.form',
    ...section('Appearance', fields.slice(0, 3)),
    ...section('Editing', fields.slice(3, 7)),
    ...section('Recording', [fields[7], fields[8], devices.some(d => d.label) ? null : h('div.field-help', 'Device names appear after you allow microphone access once.')]),
    ...section('Project', [fields[9], h('div', h('button.btn.btn-sm', { type: 'button', onclick: () => app.openResample() }, `Change this project’s rate (${formatRate(app.sampleRate)})…`))]),
    ...section('Storage', [fields[10], storageNote, h('div.panel-actions',
      h('button.btn.btn-sm', { type: 'button', onclick: async () => { const ok = await navigator.storage?.persist?.(); toast(ok ? 'Storage is now protected.' : 'The browser declined. Installing Kerf as an app usually allows it.'); } }, 'Protect storage'),
      h('button.btn.btn-sm.btn-danger', { type: 'button', onclick: async () => { const { store } = await import('../core/store.js'); await store.del('autosave'); toast('Saved session cleared from this browser.'); } }, 'Clear saved session'))]),
  );
  openDialog({ title: 'Settings', content, actions: [{ label: 'Done', kind: 'accent' }] });
}

// ---------- Help ----------
export function openShortcutsDialog(app) {
  const groups = new Map();
  for (const c of app.commands.list) {
    if (!c.keys?.length) continue;
    if (!groups.has(c.category)) groups.set(c.category, []);
    groups.get(c.category).push(c);
  }
  const mouse = [
    ['Select audio', 'Drag on a waveform'], ['Extend selection', 'Shift + click'], ['Add a track to the selection', 'Ctrl + click'],
    ['Select a whole track', 'Double-click waveform'], ['Zoom', 'Ctrl + scroll'], ['Scroll in time', 'Shift + scroll'],
    ['Add a marker', 'Double-click ruler'], ['Move a marker', 'Drag its flag'], ['Reset a slider', 'Double-click it'],
  ];
  const content = h('div',
    [...groups].map(([cat, cmds]) => [h('div.section-title', cat), h('div.shortcut-grid', cmds.map(c => h('div.shortcut-row', h('span', c.label), h('span', c.keys.map(k => h('kbd', displayKey(k))).flatMap((k, i) => (i ? [' ', k] : [k]))))))]),
    h('div.section-title', 'Mouse & trackpad'),
    h('div.shortcut-grid', mouse.map(([a, b]) => h('div.shortcut-row', h('span', a), h('span', b)))));
  openDialog({ title: 'Keyboard shortcuts', size: 'wide', content, actions: [{ label: 'Done', kind: 'accent' }] });
}

export function openAboutDialog(app) {
  const offline = navigator.serviceWorker?.controller ? 'Ready to work offline.' : 'Offline support activates after the next reload.';
  const content = h('div.form',
    h('p', { style: { margin: 0, color: 'var(--text-dim)', lineHeight: 1.55 } }, 'Kerf is a multitrack audio editor that runs entirely in your browser. Audio is decoded, edited and exported on this device — nothing is uploaded, and there are no accounts or analytics.'),
    h('div.note.ok', offline),
    h('table.report-table', h('tbody',
      h('tr', h('td', 'Version'), h('td', app.constructor.VERSION || '1.0.0')),
      h('tr', h('td', 'Audio engine'), h('td', `Web Audio · ${formatRate(app.sampleRate)} project`)),
      h('tr', h('td', 'Effects'), h('td', `${app.commands.list.filter(c => c.id.startsWith('fx.') && c.group).length} processors`)),
      h('tr', h('td', 'MP3 encoder'), h('td', 'lamejs (LGPL)')),
      h('tr', h('td', 'Typefaces'), h('td', 'Chakra Petch, IBM Plex (SIL OFL)')))),
  );
  openDialog({ title: 'About Kerf', subtitle: 'Audio workstation for the browser', content, actions: [{ label: 'Keyboard shortcuts', kind: 'ghost', onClick: () => setTimeout(() => app.openShortcuts()) }, { label: 'Done', kind: 'accent' }] });
}
