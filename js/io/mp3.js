// MP3 export through a worker so long encodes keep the UI responsive. Adds an ID3v2.3 tag.

export const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

function id3Frame(id, payload) {
  const out = new Uint8Array(10 + payload.length);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, payload.length);
  out.set(payload, 10);
  return out;
}

function utf16(str, terminate = false) {
  const out = new Uint8Array(2 + str.length * 2 + (terminate ? 2 : 0));
  out[0] = 0xff; out[1] = 0xfe;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); out[2 + i * 2] = c & 255; out[3 + i * 2] = c >> 8; }
  return out;
}

function textFrame(id, value) {
  const t = utf16(String(value));
  const p = new Uint8Array(1 + t.length);
  p[0] = 1; p.set(t, 1);
  return id3Frame(id, p);
}

export function buildId3(meta = {}) {
  const frames = [];
  if (meta.title) frames.push(textFrame('TIT2', meta.title));
  if (meta.artist) frames.push(textFrame('TPE1', meta.artist));
  if (meta.album) frames.push(textFrame('TALB', meta.album));
  if (meta.year) frames.push(textFrame('TYER', meta.year));
  if (meta.genre) frames.push(textFrame('TCON', meta.genre));
  if (meta.copyright) frames.push(textFrame('TCOP', meta.copyright));
  frames.push(textFrame('TSSE', 'Kerf Audio Workstation'));
  if (meta.comment) {
    const desc = utf16('', true), body = utf16(String(meta.comment));
    const p = new Uint8Array(4 + desc.length + body.length);
    p[0] = 1; p[1] = 0x65; p[2] = 0x6e; p[3] = 0x67;
    p.set(desc, 4); p.set(body, 4 + desc.length);
    frames.push(id3Frame('COMM', p));
  }
  const size = frames.reduce((n, f) => n + f.length, 0);
  const head = new Uint8Array(10);
  head.set([0x49, 0x44, 0x33, 3, 0, 0]);
  head[6] = (size >> 21) & 0x7f; head[7] = (size >> 14) & 0x7f; head[8] = (size >> 7) & 0x7f; head[9] = size & 0x7f;
  return new Blob([head, ...frames]);
}

export function encodeMp3(audio, { kbps = 192, metadata = {} } = {}, onProgress) {
  if (!MP3_RATES.includes(audio.sampleRate)) return Promise.reject(new Error(`MP3 does not support ${audio.sampleRate} Hz`));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./mp3-worker.js', import.meta.url));
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.progress != null) onProgress?.(m.progress);
      else if (m.error) { worker.terminate(); reject(new Error(m.error)); }
      else if (m.done) {
        worker.terminate();
        resolve(new Blob([buildId3(metadata), ...m.chunks], { type: 'audio/mpeg' }));
      }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'MP3 encoder failed to load')); };
    const channels = audio.channels.slice(0, 2).map(c => new Float32Array(c));
    worker.postMessage({ channels, sampleRate: audio.sampleRate, kbps }, channels.map(c => c.buffer));
  });
}
