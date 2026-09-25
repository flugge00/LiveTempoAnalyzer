// Song-structure segmentation that runs in the browser (no ML model needed).
//
// Beat-synchronous chroma (harmony) + cepstral timbre features -> self-similarity
// matrix -> Foote novelty curve -> section boundaries -> segments clustered by
// aligned similarity into letters (A, B, C...) -> heuristic names
// (Intro / Verse / Chorus / Bridge / Outro). Names are best guesses; the UI
// lets you rename them.

/**
 * @param {object} feats {chroma: Float32Array[], timbre: Float32Array[], rms: number[], decim}
 *   per-feature-frame arrays; one feature frame covers `decim` envelope frames
 * @param {number[]} beatFrames beat positions in envelope frames
 * @param {object} o {kernelBeats=16, minBeats=12, sensitivity=0.5}
 * @returns {{startBeat:number, endBeat:number, label:string, name:string, energy:number}[]}
 */
export function segmentSong(feats, beatFrames, o = {}) {
  const L = o.kernelBeats ?? 16;
  const minBeats = o.minBeats ?? 12;
  const B = beatFrames.length;
  if (B < 2 * L) return B ? [{ startBeat: 0, endBeat: B, label: 'A', name: 'Song', energy: 1 }] : [];

  const { vecs, energy } = beatFeatures(feats, beatFrames);
  const S = selfSimilarity(vecs);
  const nov = novelty(S, L);
  const bounds = pickBoundaries(nov, minBeats, o.sensitivity ?? 0.5);
  const segs = [];
  for (let i = 0; i < bounds.length - 1; i++) segs.push({ startBeat: bounds[i], endBeat: bounds[i + 1] });
  for (const s of segs) {
    let e = 0;
    for (let b = s.startBeat; b < s.endBeat; b++) e += energy[b];
    s.energy = e / (s.endBeat - s.startBeat);
  }
  labelSegments(segs, S, o.sensitivity ?? 0.5);
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

function pickBoundaries(nov, minBeats, sensitivity) {
  const B = nov.length;
  const vals = Array.from(nov);
  const m = vals.reduce((s, v) => s + v, 0) / B;
  const s = Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / B);
  const thr = m + (1 - sensitivity) * s;
  const cands = [];
  const w = Math.max(2, minBeats >> 1);
  for (let i = minBeats; i < B - minBeats; i++) {
    if (nov[i] < thr) continue;
    let isMax = true;
    for (let j = Math.max(0, i - w); j <= Math.min(B - 1, i + w); j++) if (nov[j] > nov[i]) { isMax = false; break; }
    if (isMax) cands.push(i);
  }
  // strongest first, enforcing minimum segment length
  cands.sort((a, b) => nov[b] - nov[a]);
  const chosen = [];
  for (const c of cands) if (chosen.every((x) => Math.abs(x - c) >= minBeats)) chosen.push(c);
  return [0, ...chosen.sort((a, b) => a - b), B];
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
