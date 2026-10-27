// AudioWorklet that forwards captured input to the main thread in ~2048-frame chunks.
class KerfRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options.processorOptions?.channels || 1;
    this.chunk = 2048;
    this.buffers = Array.from({ length: this.channels }, () => new Float32Array(this.chunk));
    this.fill = 0;
    this.active = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') { this.flush(); this.active = false; this.port.postMessage({ stopped: true }); }
    };
  }

  flush() {
    if (!this.fill) return;
    const out = this.buffers.map(b => b.slice(0, this.fill));
    this.port.postMessage({ chunk: out }, out.map(b => b.buffer));
    this.fill = 0;
  }

  process(inputs) {
    if (!this.active) return false;
    const input = inputs[0];
    const frames = input && input[0] ? input[0].length : 128;
    let off = 0;
    while (off < frames) {
      const n = Math.min(frames - off, this.chunk - this.fill);
      for (let c = 0; c < this.channels; c++) {
        const src = input && (input[c] || input[0]);
        if (src) this.buffers[c].set(src.subarray(off, off + n), this.fill);
        else this.buffers[c].fill(0, this.fill, this.fill + n);
      }
      this.fill += n;
      off += n;
      if (this.fill === this.chunk) this.flush();
    }
    return true;
  }
}

registerProcessor('kerf-recorder', KerfRecorder);
