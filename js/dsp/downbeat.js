// Downbeat detection: which beat is the "1" of each bar.
//
// Per beat we measure three accent cues:
//   harm  - harmonic change: chords tend to change on the downbeat
//   low   - low-frequency (kick drum) attack
//   onset - overall onset strength
// A Viterbi pass over "position in bar" then places the downbeats: positions
// advance by one per beat, and a jump (an odd bar, a missed beat) costs enough
// that it needs several bars of evidence. Which beat counts as "1" is decided
// per continuous run of beats (a take), since a gap resets the count.

import { beatRuns } from './beats.js';

const LOW_BANDS = 9; // log bands 0..8 ≈ 30–150 Hz: kick drum and bass attack

/**
 * @param {Float64Array|number[]} env onset envelope
 * @param {{chroma: Float32Array[], timbre: Float32Array[], decim: number}} feats
 * @param {number[]} beatFrames beat positions in envelope frames
 * @returns {{harm:number[], low:number[], onset:number[]}} one value per beat
 */
export function beatAccents(env, feats, beatFrames) {
  const { chroma, timbre, decim = 1 } = feats;
  const B = beatFrames.length, nF = chroma.length;
  const fr = beatFrames.map((f) => f / decim);
  // beat-synchronous chroma
  const cb = [];
  for (let i = 0; i < B; i++) {
    const a = Math.max(0, Math.floor(fr[i]));
    const b = Math.min(nF, Math.max(a + 1, Math.floor(i + 1 < B ? fr[i + 1] : fr[i] + (fr[i] - (fr[i - 1] ?? fr[i] - 20)))));
    const c = new Float64Array(12);
    for (let f = a; f < b; f++) for (let k = 0; k < 12; k++) c[k] += chroma[f]?.[k] ?? 0;
    for (let k = 0; k < 12; k++) c[k] = Math.sqrt(c[k]);
    cb.push(unit(c));
  }
  const avg = (i0, i1) => {
    const c = new Float64Array(12);
    for (let i = Math.max(0, i0); i < Math.min(B, i1); i++) for (let k = 0; k < 12; k++) c[k] += cb[i][k];
    return unit(c);
  };
  const lowE = (f) => {
    const t = timbre[Math.max(0, Math.min(timbre.length - 1, f))];
    if (!t) return 0;
    let s = 0;
    for (let k = 0; k < LOW_BANDS; k++) s += t[k];
    return s / LOW_BANDS;
  };
  const harm = [], low = [], onset = [];
  for (let i = 0; i < B; i++) {
    // harmony of the two beats from here vs the two beats before
    const before = avg(i - 2, i), after = avg(i, i + 2);
    let d = 0;
    for (let k = 0; k < 12; k++) d += before[k] * after[k];
    harm.push(i >= 1 ? round3(1 - d) : 0);
    const f = Math.round(fr[i]);
    const post = Math.max(lowE(f), lowE(f + 1), lowE(f + 2));
    const pre = (lowE(f - 3) + lowE(f - 2) + lowE(f - 1)) / 3;
    low.push(round3(post - pre));
    const e = Math.round(beatFrames[i]);
    let o = 0;
    for (let j = e - 2; j <= e + 2; j++) if (env[j] > o) o = env[j];
    onset.push(round3(o));
  }
  return { harm, low, onset };
}

// Weights of the z-scored cues. In rock and pop the broadband onset is loudest
// on the snare backbeat (2 and 4), so for even meters it decides which beats
// *can't* be the 1 (see downbeatEvidence); harmony and kick pick between the rest.
const W_HARM = 1, W_LOW = 0.6, W_ONSET_ODD_METER = 0.3, W_BACKBEAT = 1;
const JUMP_COST = 6;

/** Each cue z-scored over the whole recording (clipped to ±3). */
export function cueScores(accent) {
  const out = {};
  for (const key of ['harm', 'low', 'onset']) {
    const v = accent[key] || [], n = v.length;
    let m = 0, s = 0;
    for (const x of v) m += x;
    m /= n || 1;
    for (const x of v) s += (x - m) ** 2;
    s = Math.sqrt(s / (n || 1)) || 1;
    out[key] = Float64Array.from(v, (x) => Math.max(-3, Math.min(3, (x - m) / s)));
  }
  return out;
}

/**
 * Evidence that each beat of one run is a downbeat.
 * @param {object} z cueScores()
 * @param {number[]} idx beat indices of the run, in order
 */
export function downbeatEvidence(z, idx, bpb) {
  const ev = idx.map((i) => W_HARM * z.harm[i] + W_LOW * z.low[i] + (bpb % 2 ? W_ONSET_ODD_METER * z.onset[i] : 0));
  if (bpb % 2 === 0) {
    // backbeat parity for the whole run: which beats (odd or even) hit harder
    let odd = 0, even = 0;
    idx.forEach((i, k) => { if (k % 2) odd += z.onset[i]; else even += z.onset[i]; });
    const d = (odd - even) / (idx.length / 2);
    const downParity = d > 0 ? 0 : 1;
    idx.forEach((_, k) => { if (k % 2 === downParity) ev[k] += W_BACKBEAT * Math.abs(d); });
  }
  return ev;
}

/**
 * Position in the bar (0 = downbeat) for every beat, plus its run number.
 * @param {number[]} beats beat times
 * @param {number} bpb beats per bar
 * @param {number|'auto'} phase 'auto' needs `accent`; a number = which beat of
 *   each run is the first "1" (the manual "bar starts on beat" setting)
 * @param {{harm,low,onset}} [accent]
 * @returns {{pos: Int16Array, run: Int32Array}} pos -1 = beat not in any run
 */
export function beatPositions(beats, bpb, phase, accent) {
  const n = beats.length;
  const pos = new Int16Array(n).fill(-1), run = new Int32Array(n).fill(-1);
  const index = new Map(beats.map((t, i) => [t, i]));
  const z = phase === 'auto' && accent ? cueScores(accent) : null;
  beatRuns(beats).forEach((r, ri) => {
    const idx = r.map((t) => index.get(t));
    const p = z ? viterbi(downbeatEvidence(z, idx, bpb), bpb) : idx.map((_, k) => mod(k - (+phase || 0), bpb));
    idx.forEach((i, k) => { pos[i] = p[k]; run[i] = ri; });
  });
  return { pos, run };
}

function viterbi(a, bpb) {
  const n = a.length;
  let prev = new Float64Array(bpb);
  const back = [];
  for (let k = 0; k < bpb; k++) prev[k] = k === 0 ? a[0] : 0;
  for (let i = 1; i < n; i++) {
    const cur = new Float64Array(bpb), bk = new Int8Array(bpb);
    let bestAll = -Infinity, bestAllK = 0;
    for (let k = 0; k < bpb; k++) if (prev[k] > bestAll) { bestAll = prev[k]; bestAllK = k; }
    for (let k = 0; k < bpb; k++) {
      const stay = prev[mod(k - 1, bpb)], jump = bestAll - JUMP_COST;
      cur[k] = (stay >= jump ? stay : jump) + (k === 0 ? a[i] : 0);
      bk[k] = stay >= jump ? mod(k - 1, bpb) : bestAllK;
    }
    back.push(bk);
    prev = cur;
  }
  const out = new Array(n);
  let k = 0;
  for (let j = 1; j < bpb; j++) if (prev[j] > prev[k]) k = j;
  out[n - 1] = k;
  for (let i = n - 1; i >= 1; i--) { k = back[i - 1][k]; out[i - 1] = k; }
  return out;
}

/**
 * Bars from beat positions: from each downbeat to the next one in the same
 * run. Bars with the wrong number of beats (odd bars, missed beats) are skipped.
 * @returns {{t:number, end:number, bpm:number, beats:number[]}[]}
 */
export function barsFromPositions(beats, { pos, run }, bpb) {
  const bars = [];
  for (let i = 0; i + bpb < beats.length; i++) {
    if (pos[i] !== 0) continue;
    const j = i + bpb;
    if (pos[j] !== 0 || run[j] !== run[i]) continue;
    let ok = true;
    for (let k = i + 1; k < j; k++) if (pos[k] !== k - i || run[k] !== run[i]) { ok = false; break; }
    if (!ok) continue;
    const t = beats[i], end = beats[j];
    bars.push({ t, end, bpm: (60 * bpb) / (end - t), beats: beats.slice(i, j) });
  }
  return bars;
}

const mod = (a, n) => ((a % n) + n) % n;
const round3 = (x) => Math.round(x * 1000) / 1000;

function unit(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s);
  if (s > 0) for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}
