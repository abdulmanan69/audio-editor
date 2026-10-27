// Export: render the mix (or a selection / individual tracks), encode WAV or MP3, download.
import { h } from './dom.js';
import { openDialog, buildForm } from './dialog.js';
import { toast, toastError } from './toast.js';
import { renderMix } from '../audio/engine.js';
import { encodeWav } from '../io/wav.js';
import { encodeMp3, MP3_RATES } from '../io/mp3.js';
import { createZip } from '../io/zip.js';
import { local } from '../core/settings.js';
import { formatBytes, formatRate, sanitizeFilename, downloadBlob, formatDuration } from '../core/format.js';

export const FORMATS = [
  ['wav16', 'WAV · 16-bit PCM (CD quality, dithered)'],
  ['wav24', 'WAV · 24-bit PCM (studio master)'],
  ['wav32', 'WAV · 32-bit float (lossless intermediate)'],
  ['mp3-320', 'MP3 · 320 kbps'],
  ['mp3-256', 'MP3 · 256 kbps'],
  ['mp3-192', 'MP3 · 192 kbps'],
  ['mp3-128', 'MP3 · 128 kbps'],
  ['mp3-64', 'MP3 · 64 kbps (speech)'],
];

const OUT_RATES = [8000, 16000, 22050, 32000, 44100, 48000, 88200, 96000];

export function formatInfo(fmt) {
  if (fmt.startsWith('mp3')) return { kind: 'mp3', ext: 'mp3', kbps: +fmt.split('-')[1] };
  return { kind: 'wav', ext: 'wav', bits: +fmt.slice(3) };
}

export function estimateSize(fmt, seconds, rate, channels) {
  const f = formatInfo(fmt);
  if (f.kind === 'mp3') return (seconds * f.kbps * 1000) / 8;
  return seconds * rate * channels * (f.bits / 8) + 44;
}

export async function encode(audio, fmt, { metadata, cues } = {}, onProgress) {
  const f = formatInfo(fmt);
  if (f.kind === 'mp3') return encodeMp3(audio, { kbps: f.kbps, metadata }, onProgress);
  return encodeWav(audio, { bitDepth: f.bits, metadata, cues });
}

export function mp3SafeRate(rate) {
  if (MP3_RATES.includes(rate)) return rate;
  return rate > 48000 ? 48000 : MP3_RATES.reduce((a, b) => (Math.abs(b - rate) < Math.abs(a - rate) ? b : a));
}

export function openExportDialog(app, scope = 'mix') {
  const meta = local.get('exportMeta', {});
  const scopes = [['mix', 'Whole mix']];
  if (app.hasRange) scopes.push(['selection', `Selection only (${formatDuration(app.selection.end - app.selection.start)})`]);
  if (app.tracks.length > 1) {
    scopes.push(['selectedTracks', `Selected tracks only, mixed (${app.targets.length})`]);
    scopes.push(['tracks', 'Every track as its own file (ZIP)']);
  } else if (scope === 'selectedTracks' || scope === 'tracks') scope = 'mix';
  if (!scopes.some(s => s[0] === scope)) scope = 'mix';
  const v = {
    scope,
    format: local.get('exportFormat', 'wav16'),
    rate: 'project',
    channels: 'auto',
    filename: sanitizeFilename(app.name),
    title: meta.title ?? app.name, artist: meta.artist || '', album: meta.album || '', year: meta.year || String(new Date().getFullYear()), comment: meta.comment || '',
    cues: true,
  };
  const params = [
    { id: 'scope', label: 'What to export', type: 'select', options: scopes, default: scope },
    { id: 'format', label: 'Format', type: 'select', options: FORMATS, default: 'wav16' },
    { id: 'rate', label: 'Sample rate', type: 'select', options: [['project', `Project rate (${formatRate(app.sampleRate)})`], ...OUT_RATES.map(r => [String(r), formatRate(r)])], default: 'project' },
    { id: 'channels', label: 'Channels', type: 'select', options: [['auto', 'As mixed (mono stays mono)'], ['1', 'Mono'], ['2', 'Stereo']], default: 'auto' },
    { id: 'filename', label: 'File name', type: 'text', default: v.filename },
    { id: 'cues', label: `Embed ${app.markers.length} marker${app.markers.length === 1 ? '' : 's'} as WAV cue points`, type: 'bool', default: true, showIf: (x) => x.format.startsWith('wav') && app.markers.length > 0 },
  ];
  const metaParams = [
    { id: 'title', label: 'Title', type: 'text', default: v.title },
    { id: 'artist', label: 'Artist / author', type: 'text', default: '' },
    { id: 'album', label: 'Album / show', type: 'text', default: '' },
    { id: 'year', label: 'Year', type: 'text', default: v.year },
    { id: 'comment', label: 'Comment', type: 'text', default: '' },
  ];
  const estimate = h('div.note');
  const update = () => {
    const rate = v.rate === 'project' ? app.sampleRate : +v.rate;
    const f = formatInfo(v.format);
    const effRate = f.kind === 'mp3' ? mp3SafeRate(rate) : rate;
    const dur = v.scope === 'selection' ? app.selection.end - app.selection.start : app.duration;
    const ch = v.channels === 'auto' ? (app.tracks.some(t => t.audio.numberOfChannels > 1 || Math.abs(t.pan) > 0.001) ? 2 : 1) : +v.channels;
    const count = v.scope === 'tracks' ? app.tracks.length : 1;
    const size = estimateSize(v.format, dur, effRate, ch) * count;
    estimate.textContent = `About ${formatBytes(size)} · ${formatDuration(dur)} · ${ch === 1 ? 'mono' : 'stereo'} · ${formatRate(effRate)}${effRate !== rate ? ' (nearest rate MP3 supports)' : ''}${count > 1 ? ` · ${count} files` : ''}`;
  };
  const form = buildForm(params, v, { onChange: update });
  const metaForm = buildForm(metaParams, v);
  metaForm.el.className = 'grid-2';
  metaForm.el.style.marginTop = '10px';
  const details = h('details', { style: { marginTop: '4px' } }, h('summary', { style: { cursor: 'pointer', color: 'var(--text-dim)', fontWeight: 500, padding: '4px 0' } }, 'Metadata tags'), metaForm.el);
  update();
  openDialog({
    title: 'Export audio',
    subtitle: 'Renders exactly what you hear, including track gain, pan, mute and solo.',
    content: h('div.form', form.el, details, estimate),
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Export', kind: 'accent', icon: 'download', onClick: () => { setTimeout(() => runExport(app, { ...v })); } },
    ],
  });
}

async function runExport(app, v) {
  local.set('exportFormat', v.format);
  const metadata = { title: v.title, artist: v.artist, album: v.album, year: v.year, comment: v.comment };
  local.set('exportMeta', { artist: v.artist, album: v.album, comment: v.comment });
  const f = formatInfo(v.format);
  let rate = v.rate === 'project' ? app.sampleRate : +v.rate;
  if (f.kind === 'mp3') rate = mp3SafeRate(rate);
  const channels = v.channels === 'auto' ? undefined : +v.channels;
  const range = v.scope === 'selection' ? { start: app.selection.start, end: app.selection.end } : { start: 0, end: app.duration };
  const name = sanitizeFilename(v.filename || app.name);
  const cuesFor = (start, end) => (v.cues && f.kind === 'wav'
    ? app.markers.filter(m => m.time >= start && m.time <= end).map(m => ({ time: m.time - start, label: m.name }))
    : []);
  if (app.engine.playing) app.stop();
  try {
    await app.busy('Rendering…', async (progress, label) => {
      if (v.scope === 'tracks') {
        const files = [];
        for (let i = 0; i < app.tracks.length; i++) {
          const t = app.tracks[i];
          label(`Rendering “${t.name}” (${i + 1} of ${app.tracks.length})…`);
          const audio = await renderMix([{ ...t, mute: false, solo: false }], { start: 0, end: t.audio.duration, sampleRate: rate, channels });
          const blob = await encode(audio, v.format, { metadata: { ...metadata, title: t.name }, cues: cuesFor(0, t.audio.duration) });
          files.push({ name: `${String(i + 1).padStart(2, '0')} ${sanitizeFilename(t.name)}.${f.ext}`, data: blob });
          progress((i + 1) / app.tracks.length);
        }
        label('Packing ZIP…');
        const zip = await createZip(files);
        downloadBlob(zip, `${name}.zip`);
        toast(`Exported ${files.length} tracks to ${name}.zip (${formatBytes(zip.size)})`);
        return;
      }
      const tracks = v.scope === 'selectedTracks' ? app.targets.map(t => ({ ...t, mute: false, solo: false })) : app.tracks;
      const audio = await renderMix(tracks, { ...range, sampleRate: rate, channels });
      label(f.kind === 'mp3' ? 'Encoding MP3…' : 'Writing WAV…');
      const blob = await encode(audio, v.format, { metadata, cues: cuesFor(range.start, range.end) }, (p) => progress(p));
      downloadBlob(blob, `${name}.${f.ext}`);
      toast(`Exported ${name}.${f.ext} (${formatBytes(blob.size)})`);
    });
  } catch (err) { toastError(err); }
}
