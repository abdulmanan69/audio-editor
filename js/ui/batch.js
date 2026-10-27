// Effect chains (saved processing recipes) and the batch processor that runs a chain
// over many files and returns a ZIP.
import { h, clear, pickFiles } from './dom.js';
import { icon } from './icons.js';
import { openDialog, buildForm, confirmDialog } from './dialog.js';
import { toast, toastError } from './toast.js';
import { openEffectDialog } from './dialogs.js';
import { EFFECTS, EFFECT_CATEGORIES, effectById, describeParams, defaultParams, runEffect } from '../dsp/effects.js';
import { matchChannels } from '../core/audio-data.js';
import { decodeFile, isAudioFile } from '../io/importer.js';
import { createZip } from '../io/zip.js';
import { FORMATS, formatInfo, encode, mp3SafeRate } from './export.js';
import { local } from '../core/settings.js';
import { uid, formatBytes, formatRate, sanitizeFilename, stripExtension, downloadBlob, nextFrame } from '../core/format.js';

export const BUILTIN_CHAINS = [
  {
    id: 'builtin-podcast', name: 'Podcast voice master', builtin: true,
    description: 'Rumble filter, de-ess, broadcast compression, −16 LUFS with −1 dBTP ceiling.',
    steps: [
      { effect: 'highpass', params: { freq: 80, order: '4' } },
      { effect: 'deesser', params: {} },
      { effect: 'compressor', params: { thresholdDb: -24, ratio: 4, kneeDb: 6, attackMs: 5, releaseMs: 100, autoMakeup: true } },
      { effect: 'loudness', params: { target: -16, limit: true, ceiling: -1 } },
    ],
  },
  {
    id: 'builtin-ebu', name: 'Broadcast EBU R128', builtin: true,
    description: 'DC removal, subsonic filter and loudness to −23 LUFS / −1 dBTP.',
    steps: [{ effect: 'dc', params: {} }, { effect: 'highpass', params: { freq: 30, order: '4' } }, { effect: 'loudness', params: { target: -23, limit: true, ceiling: -1 } }],
  },
  {
    id: 'builtin-cleanup', name: 'Voice cleanup', builtin: true,
    description: 'High-pass, adaptive noise reduction, gentle gate, then peak normalize.',
    steps: [
      { effect: 'highpass', params: { freq: 80, order: '4' } },
      { effect: 'noiseReduction', params: { reductionDb: 12, sensitivityDb: 6 } },
      { effect: 'gate', params: { thresholdDb: -50, reductionDb: 12 } },
      { effect: 'normalize', params: { targetDb: -1 } },
    ],
  },
  {
    id: 'builtin-acx', name: 'Audiobook (ACX)', builtin: true,
    description: 'Cleanup and levels for ACX: RMS around −20 dB, peaks under −3 dB.',
    steps: [
      { effect: 'highpass', params: { freq: 80, order: '4' } },
      { effect: 'noiseReduction', params: { reductionDb: 10, sensitivityDb: 6 } },
      { effect: 'compressor', params: { thresholdDb: -20, ratio: 2.5, kneeDb: 8, attackMs: 15, releaseMs: 150, autoMakeup: true } },
      { effect: 'loudness', params: { target: -19, limit: true, ceiling: -3.5 } },
    ],
  },
  {
    id: 'builtin-trim', name: 'Tighten pauses & normalize', builtin: true,
    description: 'Shorten silences over 0.6 s, then normalize peaks to −1 dBFS.',
    steps: [{ effect: 'truncateSilence', params: {} }, { effect: 'normalize', params: { targetDb: -1 } }],
  },
];

export const userChains = () => local.get('chains', []);
const saveUserChains = (c) => local.set('chains', c);
export const allChains = () => [...BUILTIN_CHAINS, ...userChains()];

function stepLabel(step) {
  const fx = effectById(step.effect);
  if (!fx) return { name: `Unknown effect “${step.effect}”`, desc: '' };
  return { name: fx.name, desc: describeParams(fx, { ...defaultParams(fx), ...step.params }) || 'Default settings' };
}

export async function runChain(audio, chain, ctx = {}) {
  let a = audio;
  for (const step of chain.steps) {
    const fx = effectById(step.effect);
    if (!fx) continue;
    a = matchChannels(await runEffect(fx, a, step.params || {}, ctx), audio.numberOfChannels);
    await nextFrame();
  }
  return a;
}

// Edit or create a chain. Resolves with the saved chain (or null).
export function openChainEditor(app, chain) {
  return new Promise(resolve => {
    const draft = chain ? JSON.parse(JSON.stringify(chain)) : { id: uid('chain'), name: 'New chain', steps: [] };
    if (draft.builtin) { draft.id = uid('chain'); draft.name = `${draft.name} (copy)`; delete draft.builtin; }
    const nameIn = h('input.text-input', { value: draft.name, 'aria-label': 'Chain name' });
    const list = h('ol.chain-list');
    const render = () => {
      clear(list);
      if (!draft.steps.length) list.append(h('li.list-empty', 'No steps yet. Add effects below — they run top to bottom.'));
      draft.steps.forEach((s, i) => {
        const { name, desc } = stepLabel(s);
        const btn = (ic, label, fn, dis) => h('button.icon-btn.icon-btn-sm', { type: 'button', title: label, 'aria-label': label, disabled: !!dis, html: icon(ic), onclick: fn });
        list.append(h('li.chain-step', h('span.step-n', String(i + 1)), h('div', h('span.step-name', name), h('span.step-desc', { title: desc }, desc)),
          h('div.step-actions',
            btn('sliders', 'Edit settings', () => { const fx = effectById(s.effect); if (fx) openEffectDialog(app, fx, { mode: 'chain', values: s.params, onDone: (p) => { s.params = p; render(); } }); }),
            btn('arrow-up', 'Move up', () => { [draft.steps[i - 1], draft.steps[i]] = [draft.steps[i], draft.steps[i - 1]]; render(); }, i === 0),
            btn('arrow-down', 'Move down', () => { [draft.steps[i + 1], draft.steps[i]] = [draft.steps[i], draft.steps[i + 1]]; render(); }, i === draft.steps.length - 1),
            btn('trash', 'Remove step', () => { draft.steps.splice(i, 1); render(); }))));
      });
    };
    const add = h('select.select', { 'aria-label': 'Add an effect' },
      h('option', { value: '' }, 'Add an effect…'),
      EFFECT_CATEGORIES.map(cat => h('optgroup', { label: cat }, EFFECTS.filter(e => e.category === cat).map(e => h('option', { value: e.id }, e.name)))));
    add.addEventListener('change', () => {
      const fx = effectById(add.value);
      add.value = '';
      if (!fx) return;
      if (!fx.params.length) { draft.steps.push({ effect: fx.id, params: {} }); render(); return; }
      openEffectDialog(app, fx, { mode: 'chain', onDone: (p) => { draft.steps.push({ effect: fx.id, params: p }); render(); } });
    });
    render();
    let saved = null;
    openDialog({
      title: chain && !chain.builtin ? 'Edit effect chain' : 'New effect chain',
      subtitle: 'A chain is a saved recipe of effects you can apply to a selection or a whole batch of files.',
      size: 'wide',
      content: h('div.form', h('label.field', h('span.field-label', 'Name'), nameIn), h('div.section-title', 'Steps'), list, add),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Save chain', kind: 'accent', onClick: () => {
          if (!draft.steps.length) { toast('Add at least one effect to the chain.', { type: 'warn' }); return false; }
          draft.name = nameIn.value.trim() || 'Untitled chain';
          const all = userChains().filter(c => c.id !== draft.id);
          all.push(draft);
          saveUserChains(all);
          saved = draft;
        } },
      ],
      onClose: () => resolve(saved),
    });
  });
}

function chainPicker(app, selected, { allowNone = false, onChange } = {}) {
  const sel = h('select.select', { 'aria-label': 'Effect chain' });
  const desc = h('div.field-help');
  const edit = h('button.btn.btn-sm', { type: 'button' }, 'Edit');
  const del = h('button.btn.btn-sm.btn-danger', { type: 'button' }, 'Delete');
  const fresh = h('button.btn.btn-sm', { type: 'button', html: `${icon('plus')}<span>New chain</span>` });
  const fill = (value) => {
    clear(sel);
    if (allowNone) sel.append(h('option', { value: '' }, 'No processing — convert only'));
    sel.append(h('optgroup', { label: 'Built-in' }, BUILTIN_CHAINS.map(c => h('option', { value: c.id }, c.name))));
    const u = userChains();
    if (u.length) sel.append(h('optgroup', { label: 'Saved' }, u.map(c => h('option', { value: c.id }, c.name))));
    sel.value = value ?? sel.value;
    if (!sel.value && !allowNone) sel.value = BUILTIN_CHAINS[0].id;
    sync();
  };
  const current = () => allChains().find(c => c.id === sel.value) || null;
  const sync = () => {
    const c = current();
    desc.textContent = c ? (c.description || c.steps.map(s => stepLabel(s).name).join(' → ')) : 'Files are only decoded and re-encoded.';
    edit.textContent = c?.builtin ? 'Customize' : 'Edit';
    edit.disabled = !c;
    del.hidden = !c || c.builtin;
    onChange?.(c);
  };
  sel.addEventListener('change', sync);
  edit.addEventListener('click', async () => { const c = await openChainEditor(app, current()); if (c) fill(c.id); });
  fresh.addEventListener('click', async () => { const c = await openChainEditor(app, null); if (c) fill(c.id); });
  del.addEventListener('click', async () => {
    const c = current();
    if (!c || !(await confirmDialog({ title: `Delete “${c.name}”?`, message: 'The saved chain is removed from this browser.', confirmLabel: 'Delete chain', danger: true }))) return;
    saveUserChains(userChains().filter(x => x.id !== c.id));
    fill(allowNone ? '' : BUILTIN_CHAINS[0].id);
  });
  fill(selected);
  return { el: h('div.field', h('span.field-label', 'Effect chain'), sel, desc, h('div.panel-actions', edit, fresh, del)), current };
}

export function openChainDialog(app) {
  const picker = chainPicker(app, local.get('lastChain', BUILTIN_CHAINS[0].id));
  openDialog({
    title: 'Apply effect chain',
    subtitle: app.hasRange ? 'Runs every step on the current selection.' : 'Nothing is selected, so the chain runs on the whole of the selected tracks.',
    content: h('div.form', picker.el),
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Apply chain', kind: 'accent', onClick: () => {
        const c = picker.current();
        if (!c) return false;
        local.set('lastChain', c.id);
        setTimeout(() => app.applyChain(c));
      } },
    ],
  });
}

export function openBatchDialog(app) {
  const files = [];
  const rows = new Map();
  const list = h('ul.file-list');
  const drop = h('div.drop-box', { tabindex: 0, role: 'button', 'aria-label': 'Add files' }, h('div', { html: icon('upload') }), h('div', 'Drop audio files here or click to choose'), h('div.field-help', 'Every file is processed on this device.'));
  const v = { format: local.get('batchFormat', 'wav16'), rate: String(local.get('batchRate', 48000)), channels: 'keep', suffix: local.get('batchSuffix', '') };
  const out = buildForm([
    { id: 'format', label: 'Output format', type: 'select', options: FORMATS, default: 'wav16' },
    { id: 'rate', label: 'Sample rate', type: 'select', options: [8000, 16000, 22050, 32000, 44100, 48000, 96000].map(r => [String(r), formatRate(r)]), default: '48000' },
    { id: 'channels', label: 'Channels', type: 'select', options: [['keep', 'Keep original'], ['1', 'Mono'], ['2', 'Stereo']], default: 'keep' },
    { id: 'suffix', label: 'Add to file names', type: 'text', default: '', placeholder: 'e.g. _master' },
  ], v);
  const picker = chainPicker(app, local.get('batchChain', BUILTIN_CHAINS[0].id), { allowNone: true });
  const summary = h('div.field-help');
  const renderFiles = () => {
    clear(list);
    rows.clear();
    if (!files.length) list.append(h('li.list-empty', 'No files added yet.'));
    files.forEach((f, i) => {
      const st = h('span.f-status', 'Queued');
      const rm = h('button.icon-btn.icon-btn-sm', { type: 'button', 'aria-label': `Remove ${f.name}`, html: icon('x'), onclick: () => { files.splice(i, 1); renderFiles(); } });
      list.append(h('li.file-row', h('span.f-name', { title: f.name }, f.name), st, rm));
      rows.set(f, st);
    });
    summary.textContent = files.length ? `${files.length} file${files.length > 1 ? 's' : ''} · ${formatBytes(files.reduce((n, f) => n + f.size, 0))}` : '';
  };
  const addFiles = (fl) => {
    const audio = [...fl].filter(isAudioFile);
    if (audio.length < fl.length) toast(`Skipped ${fl.length - audio.length} file(s) that aren’t audio.`, { type: 'warn' });
    files.push(...audio.filter(f => !files.some(x => x.name === f.name && x.size === f.size)));
    renderFiles();
  };
  drop.addEventListener('click', async () => addFiles(await pickFiles({ accept: 'audio/*,video/*', multiple: true })));
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drop.click(); } });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });
  renderFiles();

  let running = false;
  const d = openDialog({
    title: 'Batch processor',
    subtitle: 'Run an effect chain on many files at once and download the results as a ZIP.',
    size: 'xwide',
    content: h('div.grid-2', { style: { alignItems: 'start' } },
      h('div.form', h('div.section-title', 'Files'), drop, list, summary),
      h('div.form', h('div.section-title', 'Processing'), picker.el, h('div.section-title', 'Output'), out.el)),
    actions: [
      { label: 'Close', kind: 'ghost', onClick: () => { if (running) { toast('The batch is still running.', { type: 'warn' }); return false; } } },
      { label: 'Run batch', kind: 'accent', id: 'run', closes: false, onClick: async () => {
        if (running) return false;
        if (!files.length) { toast('Add some audio files first.', { type: 'warn' }); return false; }
        running = true;
        d.buttons.run.disabled = true;
        try { await runBatch(app, files, picker.current(), v, rows); }
        catch (err) { toastError(err); }
        finally { running = false; d.buttons.run.disabled = false; }
        return false;
      } },
    ],
  });
}

async function runBatch(app, files, chain, v, rows) {
  local.set('batchFormat', v.format); local.set('batchRate', +v.rate); local.set('batchSuffix', v.suffix); local.set('batchChain', chain?.id || '');
  const f = formatInfo(v.format);
  const rate = f.kind === 'mp3' ? mp3SafeRate(+v.rate) : +v.rate;
  const outputs = [];
  let failed = 0;
  const t0 = performance.now();
  for (const file of files) {
    const st = rows.get(file);
    const set = (txt, cls = '') => { if (st) { st.textContent = txt; st.className = `f-status ${cls}`; } };
    try {
      set('Decoding…', 'run');
      await nextFrame();
      let audio = await decodeFile(file, rate);
      if (v.channels !== 'keep') audio = matchChannels(audio, +v.channels);
      if (chain) { set('Processing…', 'run'); audio = await runChain(audio, chain); }
      set(f.kind === 'mp3' ? 'Encoding MP3…' : 'Writing…', 'run');
      const blob = await encode(audio, v.format, { metadata: { title: stripExtension(file.name) } });
      outputs.push({ name: `${sanitizeFilename(stripExtension(file.name))}${v.suffix || ''}.${f.ext}`, data: blob });
      set(`Done · ${formatBytes(blob.size)}`, 'done');
    } catch (err) {
      failed++;
      set('Failed', 'err');
      if (st) st.title = err.message;
      console.error(file.name, err);
    }
  }
  if (!outputs.length) { toast('No files were processed. Hover a failed file to see why.', { type: 'error' }); return; }
  // Avoid duplicate names inside the archive.
  const seen = new Map();
  for (const o of outputs) {
    const n = seen.get(o.name) || 0;
    seen.set(o.name, n + 1);
    if (n) o.name = o.name.replace(/(\.[a-z0-9]+)$/i, ` (${n + 1})$1`);
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (outputs.length === 1) downloadBlob(outputs[0].data, outputs[0].name);
  else downloadBlob(await createZip(outputs), `Kerf batch ${new Date().toLocaleDateString('en-CA')}.zip`);
  toast(`Processed ${outputs.length} file${outputs.length > 1 ? 's' : ''} in ${secs} s${failed ? ` · ${failed} failed` : ''}.`, { type: failed ? 'warn' : 'info', duration: 7000 });
}
