// RIFF/WAVE writer (16/24-bit PCM with TPDF dither, 32-bit float) with LIST/INFO metadata
// and cue markers, plus a reader for PCM/float WAV used by project files.

const INFO_TAGS = { title: 'INAM', artist: 'IART', album: 'IPRD', year: 'ICRD', comment: 'ICMT', genre: 'IGNR', copyright: 'ICOP' };

function strBytes(s) { return new TextEncoder().encode(s); }

function chunk(id, body) {
  const pad = body.length % 2;
  const out = new Uint8Array(8 + body.length + pad);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  dv.setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function zstr(s) { const b = strBytes(s); const o = new Uint8Array(b.length + 1); o.set(b); return o; }

function infoChunk(meta) {
  const parts = [strBytes('INFO')];
  for (const [k, tag] of Object.entries(INFO_TAGS)) if (meta[k]) parts.push(chunk(tag, zstr(String(meta[k]))));
  parts.push(chunk('ISFT', zstr('Kerf Audio Workstation')));
  return chunk('LIST', concatBytes(parts));
}

function cueChunks(cues, sampleRate) {
  if (!cues || !cues.length) return [];
  const body = new Uint8Array(4 + cues.length * 24);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, cues.length, true);
  cues.forEach((c, i) => {
    const o = 4 + i * 24, pos = Math.max(0, Math.round(c.time * sampleRate));
    dv.setUint32(o, i + 1, true);
    dv.setUint32(o + 4, pos, true);
    body.set(strBytes('data'), o + 8);
    dv.setUint32(o + 12, 0, true);
    dv.setUint32(o + 16, 0, true);
    dv.setUint32(o + 20, pos, true);
  });
  const adtl = [strBytes('adtl')];
  cues.forEach((c, i) => {
    const label = zstr(c.label || `Marker ${i + 1}`);
    const b = new Uint8Array(4 + label.length);
    new DataView(b.buffer).setUint32(0, i + 1, true);
    b.set(label, 4);
    adtl.push(chunk('labl', b));
  });
  return [chunk('cue ', body), chunk('LIST', concatBytes(adtl))];
}

export function encodeWav(audio, { bitDepth = 16, dither = true, metadata = {}, cues = [] } = {}) {
  const nch = audio.numberOfChannels, n = audio.length, sr = audio.sampleRate;
  const isFloat = bitDepth === 32;
  const bps = bitDepth / 8;
  const fmt = new Uint8Array(16);
  const fv = new DataView(fmt.buffer);
  fv.setUint16(0, isFloat ? 3 : 1, true);
  fv.setUint16(2, nch, true);
  fv.setUint32(4, sr, true);
  fv.setUint32(8, sr * nch * bps, true);
  fv.setUint16(12, nch * bps, true);
  fv.setUint16(14, bitDepth, true);

  const data = new Uint8Array(n * nch * bps);
  const dv = new DataView(data.buffer);
  const chans = audio.channels;
  let o = 0;
  if (isFloat) {
    for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) { dv.setFloat32(o, chans[c][i], true); o += 4; }
  } else if (bitDepth === 24) {
    const max = 8388607;
    for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
      let v = Math.round(Math.max(-1, Math.min(1, chans[c][i])) * max);
      if (v < 0) v += 0x1000000;
      data[o] = v & 255; data[o + 1] = (v >> 8) & 255; data[o + 2] = (v >> 16) & 255;
      o += 3;
    }
  } else {
    const max = 32767, lsb = 1 / 32768;
    for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
      let x = chans[c][i];
      if (dither) x += (Math.random() - Math.random()) * lsb;
      const v = Math.round(Math.max(-1, Math.min(1, x)) * max);
      dv.setInt16(o, v, true); o += 2;
    }
  }

  const body = concatBytes([strBytes('WAVE'), chunk('fmt ', fmt), infoChunk(metadata), ...cueChunks(cues, sr), chunk('data', data)]);
  return new Blob([chunk('RIFF', body)], { type: 'audio/wav' });
}

export function parseWav(buffer) {
  const dv = new DataView(buffer);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let o = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (o + 8 <= dv.byteLength) {
    const id = tag(o), len = dv.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { format: dv.getUint16(o + 8, true), nch: dv.getUint16(o + 10, true), sr: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
    if (id === 'data') { dataOff = o + 8; dataLen = Math.min(len, dv.byteLength - dataOff); }
    o += 8 + len + (len % 2);
  }
  if (!fmt || dataOff < 0) throw new Error('WAV file is missing fmt or data');
  const format = fmt.format === 0xfffe ? (fmt.bits === 32 ? 3 : 1) : fmt.format;
  const bps = fmt.bits / 8, frames = Math.floor(dataLen / (bps * fmt.nch));
  const chans = Array.from({ length: fmt.nch }, () => new Float32Array(frames));
  let p = dataOff;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.nch; c++) {
      let v;
      if (format === 3 && fmt.bits === 32) v = dv.getFloat32(p, true);
      else if (format === 3 && fmt.bits === 64) v = dv.getFloat64(p, true);
      else if (fmt.bits === 16) v = dv.getInt16(p, true) / 32768;
      else if (fmt.bits === 24) { let x = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16); if (x & 0x800000) x -= 0x1000000; v = x / 8388608; }
      else if (fmt.bits === 32) v = dv.getInt32(p, true) / 2147483648;
      else if (fmt.bits === 8) v = (dv.getUint8(p) - 128) / 128;
      else throw new Error(`Unsupported WAV bit depth ${fmt.bits}`);
      chans[c][i] = v;
      p += bps;
    }
  }
  return { sampleRate: fmt.sr, channels: chans };
}
