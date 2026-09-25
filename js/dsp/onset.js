// Streaming onset-strength (spectral flux) detector.
// The same class is used for live microphone input and offline file analysis so
// both paths produce identical envelopes.

import { FFT } from './fft.js';

const N_BANDS = 36;
const CHROMA_MIN_HZ = 55;
const CHROMA_MAX_HZ = 2000;

export function frameParams(sampleRate) {
  // ~172 frames/s (5.8 ms hop at 44.1 kHz) and a ~46 ms analysis window.
  const hop = 2 ** Math.round(Math.log2(sampleRate / 172));
  return { hop, fftSize: hop * 8, fps: sampleRate / hop };
}

export class OnsetDetector {
  /**
   * @param {number} sampleRate
   * @param {{features?: boolean}} opts  features=true also collects chroma and
   *   band-energy frames (for section analysis). Leave off for live use.
   */
  constructor(sampleRate, opts = {}) {
    const { hop, fftSize, fps } = frameParams(sampleRate);
    Object.assign(this, { sampleRate, hop, fftSize, fps });
    this.withFeatures = !!opts.features;
    this.fft = new FFT(fftSize);
    this.window = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / fftSize);
    this.ring = new Float32Array(fftSize);
    this.ringPos = 0;
    this.sinceHop = 0;
    this.frame = new Float64Array(fftSize);
    this.mag = new Float32Array(fftSize / 2 + 1);

    // Log-spaced band mapping, 30 Hz .. min(16 kHz, Nyquist)
    const fMin = 30, fMax = Math.min(16000, sampleRate / 2);
    this.bandOf = new Int16Array(fftSize / 2 + 1).fill(-1);
    for (let k = 1; k <= fftSize / 2; k++) {
      const f = (k * sampleRate) / fftSize;
      if (f < fMin || f > fMax) continue;
      this.bandOf[k] = Math.min(N_BANDS - 1, Math.floor((N_BANDS * Math.log(f / fMin)) / Math.log(fMax / fMin)));
    }
    this.chromaOf = new Int8Array(fftSize / 2 + 1).fill(-1);
    for (let k = 1; k <= fftSize / 2; k++) {
      const f = (k * sampleRate) / fftSize;
      if (f < CHROMA_MIN_HZ || f > CHROMA_MAX_HZ) continue;
      this.chromaOf[k] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12; // 0 = C
    }
    this.bands = new Float32Array(N_BANDS);
    this.hist = [new Float32Array(N_BANDS), new Float32Array(N_BANDS)]; // t-1, t-2
    this.norm = 4 / fftSize;

    this.envelope = [];   // onset strength per frame
    this.rms = [];        // frame RMS (linear)
    this.featureDecim = 4;
    this.chroma = [];     // Float32Array(12) per featureDecim frames, if features
    this.timbre = [];     // Float32Array(N_BANDS) mean log band energies, if features
    this.featRms = [];
  }

  get frameCount() { return this.envelope.length; }

  /** Time (s) represented by frame index i: centre of its analysis window. */
  timeOf(i) { return ((i + 1) * this.hop - this.fftSize / 2) / this.sampleRate; }

  /** Feed mono samples. Returns number of new frames produced. */
  push(samples) {
    const n = this.fftSize, ring = this.ring;
    let produced = 0;
    for (let i = 0; i < samples.length; i++) {
      ring[this.ringPos] = samples[i];
      this.ringPos = (this.ringPos + 1) % n;
      if (++this.sinceHop >= this.hop) {
        this.sinceHop = 0;
        this._analyze();
        produced++;
      }
    }
    return produced;
  }

  _analyze() {
    const n = this.fftSize, ring = this.ring, frame = this.frame, w = this.window;
    let energy = 0;
    for (let i = 0, j = this.ringPos; i < n; i++, j = (j + 1) % n) {
      const s = ring[j];
      energy += s * s;
      frame[i] = s * w[i];
    }
    this.rms.push(Math.sqrt(energy / n));
    const mag = this.fft.magnitude(frame, this.mag);

    const bands = this.bands.fill(0);
    for (let k = 1; k < mag.length; k++) {
      const b = this.bandOf[k];
      if (b >= 0) bands[b] += mag[k] * this.norm;
    }
    let flux = 0;
    const prev2 = this.hist[1];
    for (let b = 0; b < N_BANDS; b++) {
      bands[b] = Math.log1p(1000 * bands[b]);
      const d = bands[b] - prev2[b];
      if (d > 0) flux += d;
    }
    // rotate history: t-2 <- t-1 <- t
    const old = this.hist[1];
    this.hist[1] = this.hist[0];
    old.set(bands);
    this.hist[0] = old;
    this.envelope.push(flux);

    if (this.withFeatures) {
      // accumulate over featureDecim frames to keep memory low on long recordings
      const acc = this._acc || (this._acc = { c: new Float32Array(12), t: new Float32Array(N_BANDS), r: 0, n: 0 });
      for (let k = 1; k < mag.length; k++) {
        const pc = this.chromaOf[k];
        if (pc >= 0) acc.c[pc] += mag[k] * mag[k];
      }
      for (let b = 0; b < N_BANDS; b++) acc.t[b] += bands[b];
      acc.r += this.rms[this.rms.length - 1];
      if (++acc.n === this.featureDecim) {
        this.chroma.push(acc.c);
        this.timbre.push(acc.t.map((v) => v / acc.n));
        this.featRms.push(acc.r / acc.n);
        this._acc = null;
      }
    }
  }

  /** Features in the shape segmentSong() expects. */
  features() {
    return { chroma: this.chroma, timbre: this.timbre, rms: this.featRms, decim: this.featureDecim };
  }
}

/** Run the detector over a whole mono buffer, in chunks, reporting progress. */
export function onsetEnvelope(samples, sampleRate, opts = {}, onProgress) {
  const det = new OnsetDetector(sampleRate, opts);
  const chunk = 1 << 16;
  for (let i = 0; i < samples.length; i += chunk) {
    det.push(samples.subarray(i, Math.min(samples.length, i + chunk)));
    if (onProgress) onProgress(Math.min(1, (i + chunk) / samples.length));
  }
  return det;
}
