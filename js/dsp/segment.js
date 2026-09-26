// Song-structure segmentation that runs in the browser (no ML model needed).
//
// Beat-synchronous chroma (harmony) + cepstral timbre features -> self-similarity
// matrix -> Foote novelty curve -> section boundaries -> segments clustered by
// aligned similarity into letters (A, B, C...) -> heuristic names
// (Intro / Verse / Chorus / Bridge / Outro). Names are best guesses; the UI
// lets you rename them.
//
// Boundaries are chosen for the whole song at once (dynamic programming), not
// one peak at a time: a boundary has to be a clear change, sit on a downbeat,
// and leave sections of usual phrase lengths (8, 12, 16, 24, 32 bars) on both
// sides. An odd length (7 or 9 bars, a 4-bar break) still wins when the change
// is clear enough.

/**
 * @param {object} feats {chroma: Float32Array[], timbre: Float32Array[], rms: number[], decim}
 *   per-feature-frame arrays; one feature frame covers `decim` envelope frames
 * @param {number[]} beatFrames beat positions in envelope frames
 * @param {object} o {kernelBeats=16, sensitivity=0.5, beatsPerBar=4,
 *   barPos: position in the bar per beat (0 = downbeat, -1 = unknown), if known}
 * @returns {{startBeat:number, endBeat:number, label:string, name:string, energy:number}[]}
 */
export function segmentSong(feats, beatFrames, o = {}) {
  const L = o.kernelBeats ?? 16;
  const B = beatFrames.length;
  if (B < 2 * L) return B ? [{ startBeat: 0, endBeat: B, label: 'A', name: 'Song', energy: 1 }] : [];

  const { vecs, energy } = beatFeatures(feats, beatFrames);
  const S = selfSimilarity(vecs);
  const nov = novelty(S, L);
  const bounds = phraseBoundaries(nov, o.barPos, o.beatsPerBar ?? 4);
  const found = [];
  for (let i = 0; i < bounds.length - 1; i++) found.push({ startBeat: bounds[i], endBeat: bounds[i + 1] });
  labelSegments(found, S, o.sensitivity ?? 0.5);
  // the same part twice in a row is one longer section (two 8-bar halves of a verse)
  const segs = [];
  for (const s of found) {
    const p = segs[segs.length - 1];
    if (p && p.label === s.label) p.endBeat = s.endBeat;
    else segs.push(s);
  }
  for (const s of segs) {
    let e = 0;
    for (let b = s.startBeat; b < s.endBeat; b++) e += energy[b];
    s.energy = e / (s.endBeat - s.startBeat);
  }
  nameSegments(segs);
  return segs;
}

function beatFeatures({ chroma, timbre, rms, decim = 1 }, envBeatFrames) {
  // features are stored every `decim` envelope frames
  const beatFrames = envBeatFrames.map((f) => f / decim);
  const B = beatFrames.length, nF = chroma.length;
  const ibi = beatFrames.length > 1 ? beatFrames[1] - beatFrames[0] : 50;
  const nb = timbre[0]?.length ?? 36, nc = 12;
  const chromaB = [], ceps = [], energy = new Float64Array(B);
  for (let i = 0; i < B; i++) {
    const a = Math.max(0, Math.floor(beatFrames[i]));
    const b = Math.min(nF, Math.max(a + 1, Math.floor(i + 1 < B ? beatFrames[i + 1] : beatFrames[i] + ibi)));
    const c = new Float64Array(12), t = new Float64Array(nb);
    let e = 0;
    for (let f = a; f < b; f++) {
      for (let k = 0; k < 12; k++) c[k] += chroma[f][k];
      for (let k = 0; k < nb; k++) t[k] += timbre[f][k];
      e += rms[f];
    }
    for (let k = 0; k < 12; k++) c[k] = Math.sqrt(c[k]);
    unit(c);
    chromaB.push(c);
    for (let k = 0; k < nb; k++) t[k] /= b - a;
    ceps.push(dct(t, nc + 1).slice(1)); // drop c0 (overall loudness)
    energy[i] = e / (b - a);
  }
  // z-score cepstra per dimension
  for (let k = 0; k < nc; k++) {
    let m = 0, s = 0;
    for (const v of ceps) m += v[k];
    m /= B;
    for (const v of ceps) s += (v[k] - m) ** 2;
    s = Math.sqrt(s / B) || 1;
    for (const v of ceps) v[k] = (v[k] - m) / s;
  }
  ceps.forEach(unit);
  // concatenate harmony + timbre, then time-delay embed 4 beats (one bar)
  const base = chromaB.map((c, i) => [...c, ...ceps[i]].map((v) => v * Math.SQRT1_2));
  const vecs = base.map((_, i) => {
    const v = [];
    for (let d = 0; d < 4; d++) v.push(...base[Math.min(B - 1, i + d)]);
    return unit(Float64Array.from(v));
  });
  const maxE = Math.max(...energy) || 1;
  for (let i = 0; i < B; i++) energy[i] /= maxE;
  return { vecs, energy };
}

function selfSimilarity(vecs) {
  const B = vecs.length, S = new Array(B);
  for (let i = 0; i < B; i++) S[i] = new Float32Array(B);
  for (let i = 0; i < B; i++) {
    S[i][i] = 1;
    for (let j = i + 1; j < B; j++) {
      let d = 0;
      const a = vecs[i], b = vecs[j];
      for (let k = 0; k < a.length; k++) d += a[k] * b[k];
      S[i][j] = S[j][i] = d;
    }
  }
  return S;
}

/** Foote novelty: Gaussian-tapered checkerboard kernel slid along the diagonal. */
function novelty(S, L) {
  const B = S.length, nov = new Float64Array(B), sig = L / 2;
  for (let i = 0; i < B; i++) {
    let v = 0;
    for (let a = -L; a < L; a++) {
      const x = i + a;
      if (x < 0 || x >= B) continue;
      for (let b = -L; b < L; b++) {
        const y = i + b;
        if (y < 0 || y >= B) continue;
        const sign = (a < 0) === (b < 0) ? 1 : -1;
        v += sign * Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * sig * sig)) * S[x][y];
      }
    }
    nov[i] = Math.max(0, v);
  }
  return nov;
}

// Usual section lengths in bars, with what an unusual one costs.
const PHRASES = [[8, 0], [16, 0], [12, 0.2], [24, 0.2], [32, 0.2], [4, 0.7], [20, 0.6], [6, 1], [28, 0.9], [40, 0.8], [48, 0.8]];
const OFF_BY_BAR = 0.6;    // cost per bar away from a usual length (a 7- or 9-bar part)
const ODD_LENGTH = 2.5;    // cost of a length that is no usual one
const BOUNDARY_MIN = 0.75; // novelty (in units of its 90th percentile) a boundary must beat
const NOVELTY_WEIGHT = 2;
const OFF_DOWNBEAT = 0.5;  // cost of a boundary that isn't on a downbeat
const FIRST_WEIGHT = 0.5;  // the intro and the end are counted from wherever the take
const LAST_WEIGHT = 0.25;  // starts and stops, so their length matters less

function phraseCost(bars) {
  let c = ODD_LENGTH;
  for (const [n, base] of PHRASES) {
    const d = Math.abs(bars - n);
    if (d <= 2) c = Math.min(c, base + OFF_BY_BAR * d * (d > 1 ? 1.5 : 1));
  }
  return c;
}

/**
 * Best boundaries for the whole song: maximises the novelty at the boundaries
 * minus the phrase-length cost of the sections between them.
 * @returns {number[]} beat indices, starting with 0 and ending with B
 */
function phraseBoundaries(nov, barPos, bpb) {
  const B = nov.length;
  const sorted = Array.from(nov).sort((a, b) => a - b);
  const scale = sorted[Math.floor(B * 0.9)] || 1;
  // The 4-beat look-ahead in the features makes novelty peak ~1.5 beats before
  // the change, so a boundary at beat j is scored with the novelty just before it.
  const gain = new Float64Array(B);
  for (let j = 2; j < B; j++) {
    const v = Math.max(nov[j], nov[j - 1], nov[j - 2]) / scale;
    gain[j] = NOVELTY_WEIGHT * (v - BOUNDARY_MIN) - (barPos && barPos[j] !== 0 ? OFF_DOWNBEAT : 0);
  }
  const firstDown = barPos ? Math.max(0, Array.prototype.indexOf.call(barPos, 0)) : 0;
  const minLen = 3 * bpb, maxLen = 64 * bpb;
  const best = new Float64Array(B + 1).fill(-Infinity), from = new Int32Array(B + 1);
  best[0] = 0;
  for (let j = minLen; j <= B; j++) {
    if (j < B && j > B - minLen) continue;
    for (let i = Math.max(0, j - maxLen); i <= j - minLen; i++) {
      if (best[i] === -Infinity) continue;
      let cost;
      if (i === 0) cost = FIRST_WEIGHT * phraseCost((j - Math.min(firstDown, j - bpb)) / bpb);
      else cost = (j === B ? LAST_WEIGHT : 1) * phraseCost((j - i) / bpb);
      const s = best[i] - cost + (j < B ? gain[j] : 0);
      if (s > best[j]) { best[j] = s; from[j] = i; }
    }
  }
  const out = [B];
  for (let j = B; j > 0; j = from[j]) out.unshift(from[j]);
  return out;
}

/** Similarity of two segments: mean of the SSM along their aligned diagonal (best of small offsets). */
function segmentSimilarity(S, p, q) {
  const len = Math.min(p.endBeat - p.startBeat, q.endBeat - q.startBeat);
  let best = -Infinity;
  for (let off = -2; off <= 2; off++) {
    let sum = 0, n = 0;
    for (let k = 0; k < len; k++) {
      const x = p.startBeat + k, y = q.startBeat + k + off;
      if (y < q.startBeat || y >= q.endBeat) continue;
      sum += S[x][y];
      n++;
    }
    if (n > len / 2) best = Math.max(best, sum / n);
  }
  // penalise very different lengths a little
  const lp = p.endBeat - p.startBeat, lq = q.endBeat - q.startBeat;
  return best - 0.1 * Math.abs(Math.log(lp / lq));
}

function labelSegments(segs, S, sensitivity) {
  const n = segs.length;
  const sim = segs.map((p) => segs.map((q) => segmentSimilarity(S, p, q)));
  const off = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off.push(sim[i][j]);
  const m = off.reduce((s, v) => s + v, 0) / (off.length || 1);
  const sdv = Math.sqrt(off.reduce((s, v) => s + (v - m) ** 2, 0) / (off.length || 1));
  // Must beat the typical pair and come close to the best repeat in this song:
  // adapts to how exactly a band repeats itself.
  const maxOff = Math.max(...off);
  const thr = Math.max(m + (0.9 - sensitivity) * sdv, (0.65 + 0.3 * (1 - sensitivity)) * maxOff);

  // average-linkage agglomerative clustering
  let clusters = segs.map((_, i) => [i]);
  for (;;) {
    let best = -Infinity, bi = -1, bj = -1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        let s = 0;
        for (const a of clusters[i]) for (const b of clusters[j]) s += sim[a][b];
        s /= clusters[i].length * clusters[j].length;
        if (s > best) { best = s; bi = i; bj = j; }
      }
    }
    if (bi < 0 || best < thr) break;
    clusters[bi] = clusters[bi].concat(clusters[bj]);
    clusters.splice(bj, 1);
  }
  clusters.sort((a, b) => Math.min(...a) - Math.min(...b));
  clusters.forEach((c, k) => c.forEach((i) => (segs[i].label = String.fromCharCode(65 + (k % 26)))));
}

function nameSegments(segs) {
  const byLabel = new Map();
  for (const s of segs) {
    if (!byLabel.has(s.label)) byLabel.set(s.label, []);
    byLabel.get(s.label).push(s);
  }
  const groups = [...byLabel.entries()].map(([label, list]) => ({
    label, list,
    count: list.length,
    beats: list.reduce((a, s) => a + s.endBeat - s.startBeat, 0),
    energy: list.reduce((a, s) => a + s.energy * (s.endBeat - s.startBeat), 0) / list.reduce((a, s) => a + s.endBeat - s.startBeat, 0),
  }));
  const repeated = groups.filter((g) => g.count >= 2);
  const names = new Map();
  const next = (s) => segs[segs.indexOf(s) + 1];
  const prev = (s) => segs[segs.indexOf(s) - 1];
  const avgLen = (g) => g.beats / g.count;
  if (repeated.length) {
    const chorus = [...repeated].sort((a, b) => b.energy - a.energy)[0];
    names.set(chorus.label, 'Chorus');
    // the verse is the repeated part that leads into the chorus...
    const others = repeated.filter((g) => g !== chorus);
    const leadsIn = (g) => g.list.filter((s) => next(s)?.label === chorus.label).length;
    const cand = [...others].sort((a, b) => leadsIn(b) - leadsIn(a) || b.beats - a.beats)[0];
    if (cand) {
      // ...unless a longer repeated part usually comes right before it: then that's
      // the verse and the candidate is a pre-chorus
      const before = new Map();
      for (const s of cand.list) { const p = prev(s); if (p && p.label !== chorus.label) before.set(p.label, (before.get(p.label) || 0) + 1); }
      const [vLabel, vCount] = [...before.entries()].sort((a, b) => b[1] - a[1])[0] || [];
      const v = others.find((g) => g.label === vLabel);
      if (v && vCount >= cand.count / 2 && avgLen(v) > avgLen(cand) && leadsIn(cand) > 0) {
        names.set(v.label, 'Verse');
        names.set(cand.label, 'Pre-chorus');
      } else if (leadsIn(cand) > 0 || cand.beats >= chorus.beats / 2) {
        names.set(cand.label, 'Verse');
      }
    }
  }
  // Parts without a role get a positional name
  segs.forEach((s, i) => {
    if (names.has(s.label)) { s.name = names.get(s.label); return; }
    if (i === 0) s.name = 'Intro';
    else if (i === segs.length - 1) s.name = 'Outro';
    else if (segs.slice(0, i).some((p) => names.get(p.label) === 'Chorus')) s.name = 'Bridge';
    else s.name = `Part ${s.label}`;
  });
}

function unit(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s);
  if (s > 0) for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}

function dct(x, nOut) {
  const N = x.length, out = new Float64Array(nOut);
  for (let k = 0; k < nOut; k++) {
    let s = 0;
    for (let n = 0; n < N; n++) s += x[n] * Math.cos((Math.PI / N) * (n + 0.5) * k);
    out[k] = s;
  }
  return out;
}
