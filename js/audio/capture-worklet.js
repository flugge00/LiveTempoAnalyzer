// AudioWorklet that forwards mono microphone blocks to the main thread.
// Batches 128-sample render quanta into 2048-sample messages.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.pos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const n = input[0].length, chans = input.length;
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < chans; c++) s += input[c][i];
        this.buf[this.pos++] = s / chans;
        if (this.pos === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(2048);
          this.pos = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
