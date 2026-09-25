// Tempo estimation from an onset-strength envelope.
//
// For a window of envelope we compute its autocorrelation and score every
// candidate tempo on a fine log-spaced grid with a harmonic comb (lags τ, 2τ,
// 3τ, 4τ, linearly interpolated), which gives sub-BPM resolution. Octave
// ambiguity is resolved by an HMM over the grid: a forward filter for live use
// and Viterbi decoding for offline files.

import { FFT } from './fft.js';

const COMB_WEIGHTS = [1, 0.5, 0.33, 0.25];

export class TempoModel {
  /**
   * @param {number} fps  onset envelope frame rate
   * @param {object} o
   *   minBpm, maxBpm   search range
   *   windowSec        analysis window length
   *   expectedBpm      optional hint; narrows the prior to avoid octave errors
   */
  constructor(fps, o = {}) {
    this.fps = fps;
    this.minBpm = o.minBpm ?? 40;
    this.maxBpm = o.maxBpm ?? 240;
    this.windowSec = o.windowSec ?? 8;
    this.winFrames = Math.round(this.windowSec * fps);
    this.maxLag = Math.floor(this.winFrames * 0.75);
    this.stepRatio = 1.0025; // 0.25% between states
    this.n = Math.ceil(Math.log(this.maxBpm / this.minBpm) / Math.log(this.stepRatio)) + 1;
    this.bpms = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) this.bpms[i] = this.minBpm * this.stepRatio ** i;
    this.fft = new FFT(2 ** Math.ceil(Math.log2(this.winFrames * 2)));
    this.setExpected(o.expectedBpm);
  }

  setExpected(expectedBpm) {
    const centre = expectedBpm || 120;
    const sigmaOct = expectedBpm ? 0.3 : 0.8;
    this.expectedBpm = expectedBpm || null;
    this.prior = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const z = Math.log2(this.bpms[i] / centre) / sigmaOct;
      this.prior[i] = Math.exp(-0.5 * z * z);
    }
  }

  bpmAt(fracIndex) { return this.minBpm * this.stepRatio ** fracIndex; }

  /** Tempo prior for any BPM (used to pick between metrical levels). */
  priorAt(bpm) {
    const z = Math.log2(bpm / (this.expectedBpm || 120)) / (this.expectedBpm ? 0.3 : 0.8);
    return Math.exp(-0.5 * z * z);
  }

  /**
   * Comb scores for one window of envelope (array-like, length ~winFrames).
   * Returns {scores, salience} where scores[i] in ~[0,1] per grid state.
   */
  score(env) {
    const len = env.length;
    let mean = 0;
    for (let i = 0; i < len; i++) mean += env[i];
    mean /= len;
    const x = new Float64Array(len);
    for (let i = 0; i < len; i++) x[i] = env[i] - mean;
    const raw = this.fft.autocorrelation(x);
    const maxLag = Math.min(this.maxLag, len - 1);
    const ac = new Float64Array(maxLag + 2);
    const a0 = raw[0] / len || 1;
    for (let l = 0; l <= maxLag + 1 && l < len; l++) ac[l] = raw[l] / (len - l) / a0; // unbiased, normalised

    const scores = new Float64Array(this.n);
    let best = 0;
    for (let i = 0; i < this.n; i++) {
      const tau = (60 * this.fps) / this.bpms[i];
      let s = 0, wsum = 0;
      for (let k = 0; k < COMB_WEIGHTS.length; k++) {
        const lag = tau * (k + 1);
        if (lag > maxLag) break;
        const l0 = Math.floor(lag), f = lag - l0;
        const v = ac[l0] * (1 - f) + ac[l0 + 1] * f;
        s += COMB_WEIGHTS[k] * Math.max(0, v);
        wsum += COMB_WEIGHTS[k];
      }
      scores[i] = wsum ? s / wsum : 0;
      if (scores[i] > best) best = scores[i];
    }
    return { scores, salience: best };
  }

  /**
   * Emission likelihood (prior applied) from comb scores.
   * Deliberately flat near the top: metrical levels (T/2, T, 2T) often score
   * within ~15% of each other and which one "wins" depends on instrumentation,
   * so near-equal candidates are treated as equally plausible and the tempo
   * prior + continuity pick the octave. Precision comes from refine(), which
   * works on the raw scores.
   */
  emission(scores) {
    let max = 0;
    for (let i = 0; i < this.n; i++) if (scores[i] > max) max = scores[i];
    const e = new Float64Array(this.n);
    if (max <= 0) return e.fill(1 / this.n);
    for (let i = 0; i < this.n; i++) {
      const r = Math.max(0, scores[i]) / max;
      e[i] = (r / (1 + Math.exp(-(r - 0.82) / 0.025))) * this.prior[i] + 1e-6;
    }
    return e;
  }

  /** Nearest local maximum of scores to state `i`, with parabolic interpolation → BPM. */
  refine(scores, i) {
    const n = this.n;
    let j = i;
    // climb to the local max (bounded to ±3%)
    const lim = Math.round(Math.log(1.03) / Math.log(this.stepRatio));
    for (let steps = 0; steps < lim; steps++) {
      if (j > 0 && scores[j - 1] > scores[j]) j--;
      else if (j < n - 1 && scores[j + 1] > scores[j]) j++;
      else break;
    }
    let off = 0;
    if (j > 0 && j < n - 1) {
      const a = scores[j - 1], b = scores[j], c = scores[j + 1];
      const d = a - 2 * b + c;
      if (d < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d));
    }
    return this.bpmAt(j + off);
  }

  /** Gaussian transition kernel in state space (sigma as a tempo ratio per step). */
  kernel(sigmaRatio) {
    const s = Math.log(1 + sigmaRatio) / Math.log(this.stepRatio);
    const half = Math.ceil(3 * s);
    const k = new Float64Array(2 * half + 1);
    let sum = 0;
    for (let d = -half; d <= half; d++) sum += k[d + half] = Math.exp(-0.5 * (d / s) ** 2);
    for (let d = 0; d < k.length; d++) k[d] /= sum;
    return { k, half };
  }
}

/**
 * Online tempo tracker (HMM forward filter). Call update() with the latest
 * envelope window every hop; returns {bpm, confidence} or null when there is no
 * usable signal.
 */
export class TempoTracker {
  constructor(model, { sigmaRatio = 0.01, jumpProb = 0.002 } = {}) {
    this.model = model;
    this.trans = model.kernel(sigmaRatio);
    this.jump = jumpProb;
    this.reset();
  }

  reset() {
    const m = this.model;
    this.post = Float64Array.from(m.prior);
    normalise(this.post);
  }

  update(envWindow) {
    const m = this.model;
    const { scores, salience } = m.score(envWindow);
    if (salience < 0.02) return null;
    const e = m.emission(scores);
    const pred = convolve(this.post, this.trans);
    const n = m.n, floor = this.jump / n;
    for (let i = 0; i < n; i++) this.post[i] = (pred[i] * (1 - this.jump) + floor) * e[i];
    normalise(this.post);
    let arg = 0;
    for (let i = 1; i < n; i++) if (this.post[i] > this.post[arg]) arg = i;
    return { bpm: m.refine(scores, arg), confidence: Math.min(1, salience) };
  }
}

/**
 * Offline tempo curve: sliding windows + Viterbi.
 * @param {ArrayLike<number>} env onset envelope
 * @param {Float32Array|number[]} active per-frame boolean-ish (1 = signal present)
 * @returns {{times:number[], bpm:(number|null)[], confidence:number[]}}
 *   times are envelope-frame indices converted to seconds by caller via fps.
 */
export function tempoCurve(env, model, { hopSec = 0.25, active, sigmaRatio = 0.01, jumpProb = 0.002, onProgress } = {}) {
  const fps = model.fps, W = model.winFrames, hop = Math.max(1, Math.round(hopSec * fps));
  const centres = [], allScores = [], sal = [];
  for (let c = 0; c < env.length; c += hop) {
    const a = Math.max(0, Math.min(c - (W >> 1), env.length - W));
    const b = Math.min(env.length, a + W);
    centres.push(c);
    if (b - a < fps * 2) { allScores.push(null); sal.push(0); continue; }
    let act = 1;
    if (active) { act = 0; for (let i = a; i < b; i++) act += active[i]; act /= b - a; }
    if (act < 0.5) { allScores.push(null); sal.push(0); continue; }
    const { scores, salience } = model.score(env.subarray ? env.subarray(a, b) : env.slice(a, b));
    allScores.push(salience < 0.02 ? null : scores);
    sal.push(salience);
    if (onProgress && centres.length % 20 === 0) onProgress(c / env.length);
  }

  // Viterbi in log domain. Silent frames get a flat emission.
  const n = model.n, T = centres.length;
  const { k, half } = model.kernel(sigmaRatio);
  const logK = k.map(Math.log), logJump = Math.log(jumpProb / n), logStay = Math.log(1 - jumpProb);
  const back = new Array(T);
  let delta = Float64Array.from(model.prior, (p) => Math.log(p + 1e-12));
  for (let t = 0; t < T; t++) {
    const e = allScores[t] ? model.emission(allScores[t]) : null;
    const nd = new Float64Array(n), bp = new Int32Array(n);
    let gMax = -Infinity, gArg = 0;
    for (let i = 0; i < n; i++) if (delta[i] > gMax) { gMax = delta[i]; gArg = i; }
    for (let j = 0; j < n; j++) {
      let best = gMax + logJump, arg = gArg;
      const lo = Math.max(0, j - half), hi = Math.min(n - 1, j + half);
      for (let i = lo; i <= hi; i++) {
        const v = delta[i] + logStay + logK[j - i + half];
        if (v > best) { best = v; arg = i; }
      }
      nd[j] = best + (e ? Math.log(e[j]) : 0);
      bp[j] = arg;
    }
    back[t] = bp;
    delta = nd;
  }
  const path = new Int32Array(T);
  let arg = 0;
  for (let i = 1; i < n; i++) if (delta[i] > delta[arg]) arg = i;
  for (let t = T - 1; t >= 0; t--) { path[t] = arg; arg = back[t][arg]; }

  return {
    times: centres.map((c) => c / fps),
    bpm: centres.map((_, t) => (allScores[t] ? model.refine(allScores[t], path[t]) : null)),
    confidence: sal.map((s) => Math.min(1, s)),
  };
}

// ---------------------------------------------------------------------------
// Octave consistency.
//
// A band's tempo never jumps by x2, x1/2, x3... within a song, but the strongest
// periodicity in an 8 s window often does: a half-time verse repeats every two
// beats, a sparse intro every three. The resolver keeps one canonical tempo per
// take (a stretch of continuous playing) and folds readings at a related ratio
// back onto it. Which metrical level is canonical is decided by majority vote
// (weighted by the tempo prior), with hysteresis so it changes its mind at most
// rarely, and when it does the caller rescales the take so far.

// ratio -> max |ln deviation| from canon*ratio. Octaves get a wide tolerance
// (endings slow down while still being read at double tempo); a reading within
// 15% of the canonical tempo is simply the band speeding up or slowing down.
// No x1.5 / x2/3: a medley going 100 -> 140 BPM is a real change, not an error.
const RATIOS = [[1, 0.15], [2, 0.12], [0.5, 0.12], [3, 0.07], [1 / 3, 0.07], [4, 0.07], [0.25, 0.07]];
const NEW_TEMPO_SEC = 4;  // unrelated readings this consistent for this long = a real tempo change

export class OctaveResolver {
  /**
   * @param {object} o
   *   priorAt(bpm) -> relative plausibility of a tempo
   *   memorySec: how much recent history defines the canonical tempo
   *   onRescale(factor): called when the canonical level changes; the caller
   *     should multiply everything it has output for this take by factor
   *   onNewTake(t): the tempo really changed (not by a metrical ratio); later
   *     rescales only apply from t on
   */
  constructor({ priorAt = () => 1, memorySec = 12, hysteresis = 1.6, onRescale = () => {}, onNewTake = () => {} } = {}) {
    Object.assign(this, { priorAt, memorySec, hysteresis, onRescale, onNewTake });
    this.reset();
  }

  reset() {
    this.canon = null;
    this.recent = [];
    this.pending = [];      // recent readings unrelated to canon
    this.votes = new Map(); // raw level relative to canon (1, 2, 0.5, ...) -> count
    this.locked = false;
  }

  /** User says the reading is off by factor f (e.g. the x2 button): rescale and stop auto-switching. */
  force(f) {
    if (this.canon == null) return;
    this._rescale(f);
    this.votes = new Map([[1, 1e6]]);
    this.locked = true;
  }

  /** Returns the reading at the canonical metrical level, or null for an outlier. */
  push(t, v) {
    if (v == null) return null;
    if (this.canon == null) this.canon = v;
    let r = null, best = Infinity;
    for (const [q, tol] of RATIOS) {
      const d = Math.abs(Math.log((v * q) / this.canon));
      if (d < tol && d < best) { best = d; r = q; }
    }
    if (r == null) {
      // Unrelated to the current tempo: a glitch, unless it persists (a new tempo).
      this.pending = this.pending.filter((p) => p.t > t - NEW_TEMPO_SEC);
      this.pending.push({ t, v });
      const ps = this.pending.map((p) => p.v).sort((a, b) => a - b);
      const covered = this.pending[this.pending.length - 1].t - this.pending[0].t;
      if (covered < NEW_TEMPO_SEC * 0.8 || ps[ps.length - 1] / ps[0] > 1.08) return null;
      const locked = this.locked;
      this.reset();
      this.locked = locked;
      this.canon = ps[ps.length >> 1];
      this.onNewTake(t);
      r = 1;
    }
    let out = v * r;
    const key = keyOf(1 / r);
    this.votes.set(key, (this.votes.get(key) || 0) + 1);
    if (!this.locked) {
      // is another metrical level better supported than the current one?
      const score = (k) => (this.votes.get(k) || 0) * this.priorAt(this.canon * k);
      let bestK = 1;
      for (const k of this.votes.keys()) if (score(k) > score(bestK)) bestK = k;
      if (bestK !== 1 && score(bestK) > this.hysteresis * score(1)) {
        this._rescale(bestK);
        out *= bestK;
      }
    }
    this.recent.push({ t, v: out });
    while (this.recent.length && this.recent[0].t < t - this.memorySec) this.recent.shift();
    const s = this.recent.map((p) => p.v).sort((a, b) => a - b);
    this.canon = s[s.length >> 1];
    return out;
  }

  _rescale(k) {
    this.canon *= k;
    for (const p of this.recent) p.v *= k;
    const nv = new Map();
    for (const [key, c] of this.votes) nv.set(keyOf(key / k), (nv.get(keyOf(key / k)) || 0) + c);
    this.votes = nv;
    this.onRescale(k);
  }
}

const keyOf = (x) => Math.round(x * 1000) / 1000;

/**
 * Offline: resolve octaves over a whole tempo curve. Takes are split at gaps
 * longer than gapSec; within a take the final decision applies to all of it.
 */
export function resolveOctaves(times, bpm, priorAt, { gapSec = 4 } = {}) {
  const out = bpm.slice();
  let takeStart = 0, lastT = -Infinity;
  const res = new OctaveResolver({
    priorAt,
    onRescale: (k) => { for (let j = takeStart; j < i; j++) if (out[j] != null) out[j] *= k; },
    onNewTake: () => { takeStart = i; },
  });
  let i = 0;
  for (; i < times.length; i++) {
    if (bpm[i] == null) continue;
    if (times[i] - lastT > gapSec) { res.reset(); takeStart = i; }
    lastT = times[i];
    out[i] = res.push(times[i], bpm[i]);
  }
  return out;
}

function convolve(p, { k, half }) {
  const n = p.length, out = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let s = 0;
    const lo = Math.max(0, j - half), hi = Math.min(n - 1, j + half);
    for (let i = lo; i <= hi; i++) s += p[i] * k[j - i + half];
    out[j] = s;
  }
  return out;
}

function normalise(p) {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += p[i];
  if (s > 0) for (let i = 0; i < p.length; i++) p[i] /= s;
}
