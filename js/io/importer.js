// Decode any browser-supported audio (or video soundtrack) into AudioData at a target rate.
import { AudioData } from '../core/audio-data.js';

const OfflineCtx = self.OfflineAudioContext || self.webkitOfflineAudioContext;

export const AUDIO_EXT = /\.(wav|wave|mp3|flac|ogg|oga|opus|m4a|aac|mp4|m4v|mov|webm|weba|aif|aiff|caf|3gp|amr)$/i;

export function isAudioFile(file) {
  return /^(audio|video)\//.test(file.type) || AUDIO_EXT.test(file.name);
}

export async function decodeArrayBuffer(buf, sampleRate) {
  if (!OfflineCtx) throw new Error('This browser does not support the Web Audio API');
  // Decoding with an OfflineAudioContext resamples straight to the project rate.
  const ctx = new OfflineCtx(1, 1, sampleRate);
  const ab = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(buf, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
  return AudioData.fromAudioBuffer(ab);
}

export async function decodeFile(file, sampleRate) {
  const buf = await file.arrayBuffer();
  try {
    return await decodeArrayBuffer(buf, sampleRate);
  } catch (err) {
    const ext = (file.name.match(/\.([a-z0-9]+)$/i) || [, 'this'])[1].toUpperCase();
    throw new Error(`Couldn’t decode “${file.name}”. This browser can’t read ${ext} audio, or the file is damaged. Try converting it to WAV or MP3.`);
  }
}
