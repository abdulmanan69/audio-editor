// .kerf project files: a ZIP holding project.json plus one 32-bit float WAV per track.
import { AudioData } from '../core/audio-data.js';
import { encodeWav, parseWav } from './wav.js';
import { createZip, readZip } from './zip.js';

export const PROJECT_FORMAT = 'kerf-project';
export const PROJECT_VERSION = 1;

const trackMeta = (t) => ({ id: t.id, name: t.name, colorIndex: t.colorIndex, gain: t.gain, pan: t.pan, mute: t.mute, solo: t.solo, height: t.height, view: t.view });

export async function saveProjectFile(project) {
  const manifest = {
    format: PROJECT_FORMAT, version: PROJECT_VERSION,
    name: project.name, sampleRate: project.sampleRate,
    savedAt: new Date().toISOString(),
    tracks: project.tracks.map(t => ({ ...trackMeta(t), file: `tracks/${t.id}.wav`, channels: t.audio.numberOfChannels, length: t.audio.length })),
    markers: project.markers,
  };
  const entries = [{ name: 'project.json', data: JSON.stringify(manifest, null, 2) }];
  for (const t of project.tracks) entries.push({ name: `tracks/${t.id}.wav`, data: encodeWav(t.audio, { bitDepth: 32 }) });
  return createZip(entries);
}

export async function loadProjectFile(file) {
  const files = await readZip(await file.arrayBuffer());
  const json = files.get('project.json');
  if (!json) throw new Error('This file is not a Kerf project (project.json is missing).');
  const manifest = JSON.parse(new TextDecoder().decode(json));
  if (manifest.format !== PROJECT_FORMAT) throw new Error('This file is not a Kerf project.');
  if (manifest.version > PROJECT_VERSION) throw new Error('This project was saved by a newer version of Kerf. Reload the app to update.');
  const tracks = manifest.tracks.map(t => {
    const bytes = files.get(t.file);
    if (!bytes) throw new Error(`Track audio “${t.file}” is missing from the project.`);
    const copy = bytes.slice().buffer;
    const { sampleRate, channels } = parseWav(copy);
    return { ...t, audio: new AudioData(channels, sampleRate) };
  });
  return { name: manifest.name, sampleRate: manifest.sampleRate, tracks, markers: manifest.markers || [] };
}

// Structured-clone form for IndexedDB autosave.
export function toAutosave(project) {
  return {
    format: PROJECT_FORMAT, version: PROJECT_VERSION,
    name: project.name, sampleRate: project.sampleRate, savedAt: Date.now(),
    tracks: project.tracks.map(t => ({ ...trackMeta(t), channels: t.audio.channels })),
    markers: project.markers,
  };
}

export function fromAutosave(data) {
  if (!data || data.format !== PROJECT_FORMAT || !Array.isArray(data.tracks)) return null;
  return {
    name: data.name, sampleRate: data.sampleRate, savedAt: data.savedAt, markers: data.markers || [],
    tracks: data.tracks.map(t => ({ ...t, audio: new AudioData(t.channels, data.sampleRate) })),
  };
}
