// Minimal iterative radix-2 FFT. Precomputes twiddles and bit-reversal for a fixed size.

export class FFT {
  constructor(size) {
    if (size & (size - 1)) throw new Error('FFT size must be a power of two');
    this.size = size;
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** Magnitude spectrum (bins 0..size/2) of a real input frame. */
  magnitude(input, out) {
    const n = this.size, re = this.re, im = this.im, rev = this.rev;
    for (let i = 0; i < n; i++) { re[rev[i]] = input[i]; im[rev[i]] = 0; }
    this._butterflies();
    const m = out || new Float32Array(n / 2 + 1);
    for (let i = 0; i <= n / 2; i++) m[i] = Math.hypot(re[i], im[i]);
    return m;
  }

  /**
   * Autocorrelation of a real signal (length <= size/2, zero-padded) via
   * Wiener-Khinchin. Returns this.re, where re[lag] = sum x[t] x[t+lag].
   */
  autocorrelation(x) {
    const n = this.size, re = this.re, im = this.im, rev = this.rev;
    for (let i = 0; i < n; i++) { re[rev[i]] = i < x.length ? x[i] : 0; im[rev[i]] = 0; }
    this._butterflies();
    // power spectrum is real and even -> a forward FFT of it equals n * inverse FFT
    const p = new Float64Array(n);
    for (let i = 0; i < n; i++) p[i] = re[i] * re[i] + im[i] * im[i];
    for (let i = 0; i < n; i++) { re[rev[i]] = p[i]; im[rev[i]] = 0; }
    this._butterflies();
    for (let i = 0; i < n; i++) re[i] /= n;
    return re;
  }

  _butterflies() {
    const n = this.size, re = this.re, im = this.im;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * this.cos[k] - im[b] * this.sin[k];
          const ti = re[b] * this.sin[k] + im[b] * this.cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}
