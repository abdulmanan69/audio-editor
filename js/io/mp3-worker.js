/* global lamejs */
// Classic worker: encodes Float32 PCM to MP3 with lamejs, posting progress as it goes.
importScripts('../vendor/lame.min.js');

self.onmessage = (e) => {
  const { channels, sampleRate, kbps } = e.data;
  try {
    const nch = Math.min(2, channels.length);
    const encoder = new lamejs.Mp3Encoder(nch, sampleRate, kbps);
    const n = channels[0].length;
    const block = 1152 * 8;
    const toInt16 = (src, from, len) => {
      const out = new Int16Array(len);
      for (let i = 0; i < len; i++) {
        const v = Math.max(-1, Math.min(1, src[from + i]));
        out[i] = v < 0 ? v * 32768 : v * 32767;
      }
      return out;
    };
    const chunks = [];
    let lastReport = 0;
    for (let i = 0; i < n; i += block) {
      const len = Math.min(block, n - i);
      const l = toInt16(channels[0], i, len);
      const buf = nch === 2 ? encoder.encodeBuffer(l, toInt16(channels[1], i, len)) : encoder.encodeBuffer(l);
      if (buf.length) chunks.push(new Uint8Array(buf));
      if (i - lastReport > sampleRate * 5) { lastReport = i; self.postMessage({ progress: i / n }); }
    }
    const tail = encoder.flush();
    if (tail.length) chunks.push(new Uint8Array(tail));
    self.postMessage({ done: true, chunks }, chunks.map(c => c.buffer));
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
