// Beat tracking (dynamic programming, after Ellis 2007) guided by a time-varying
// tempo curve, plus beat-derived measures: per-beat tempo, bar tempo, micro-timing
// and attack spread.

/**
 * @param {Float64Array} env onset envelope
 * @param {number} fps envelope frame rate
 * @param {{times:number[], bpm:(number|null)[]}} curve tempo curve (seconds)
 * @param {{active?:ArrayLike<number>, tightness?:number}} o
 * @returns {number[]} beat positions in (fractional) envelope frames
 */
export function trackBeats(env, fps, curve, o = {}) {
  const n = env.length;
  const tightness = o.tightness ?? 100;
  const period = periodPerFrame(n, fps, curve);
  if (!period) return [];

  // local score: envelope normalised by its std, lightly smoothed
  let mean = 0, sq = 0;
  for (let i = 0; i < n; i++) { mean += env[i]; sq += env[i] * env[i]; }
  mean /= n;
  const std = Math.sqrt(Math.max(1e-12, sq / n - mean * mean));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = env[i - 1] ?? env[i], b = env[i], c = env[i + 1] ?? env[i];
    local[i] = (0.25 * a + 0.5 * b + 0.25 * c) / std;
  }

  const cum = new Float64Array(n), back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    const P = period[t];
    const lo = Math.max(0, Math.round(t - 2 * P)), hi = Math.round(t - P / 2);
    let best = -Infinity, arg = -1;
    for (let p = lo; p <= hi; p++) {
      const d = Math.log((t - p) / P);
      const v = cum[p] - tightness * d * d;
      if (v > best) { best = v; arg = p; }
    }
    cum[t] = local[t] + (arg >= 0 ? best : 0);
    back[t] = arg;
  }

  // last beat: final local max of cum whose value is > half the median of maxima
  const maxima = [];
  for (let t = 1; t < n - 1; t++) if (cum[t] > cum[t - 1] && cum[t] >= cum[t + 1]) maxima.push(t);
  if (!maxima.length) return [];
  const med = [...maxima.map((t) => cum[t])].sort((a, b) => a - b)[maxima.length >> 1];
  let last = maxima[maxima.length - 1];
  for (let i = maxima.length - 1; i >= 0; i--) if (cum[maxima[i]] > 0.5 * med) { last = maxima[i]; break; }

  const beats = [];
  for (let t = last; t >= 0; t = back[t]) beats.push(t);
  beats.reverse();

  // drop beats in inactive regions and weak beats at the edges
  const active = o.active;
  let kept = active ? beats.filter((b) => active[b]) : beats;
  const strength = kept.map((b) => local[b]);
  const thr = 0.5 * Math.sqrt(strength.reduce((s, v) => s + v * v, 0) / (strength.length || 1));
  let a = 0, z = kept.length;
  while (a < z && strength[a] < thr) a++;
  while (z > a && strength[z - 1] < thr) z--;
  kept = kept.slice(a, z);

  // sub-frame refinement: parabolic peak of the local score near each beat
  return kept.map((b) => {
    let j = b;
    if (local[j + 1] > local[j] && local[j + 1] >= (local[j + 2] ?? 0)) j++;
    else if (local[j - 1] > local[j] && local[j - 1] >= (local[j - 2] ?? 0)) j--;
    const y0 = local[j - 1], y1 = local[j], y2 = local[j + 1];
    if (y0 === undefined || y2 === undefined) return j;
    const d = y0 - 2 * y1 + y2;
    return d < 0 ? j + Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d)) : j;
  });
}

function periodPerFrame(n, fps, curve) {
  const pts = curve.times.map((t, i) => [t * fps, curve.bpm[i]]).filter((p) => p[1]);
  if (!pts.length) return null;
  const period = new Float64Array(n);
  let k = 0;
  for (let t = 0; t < n; t++) {
    while (k < pts.length - 1 && pts[k + 1][0] <= t) k++;
    let bpm;
    if (t <= pts[0][0]) bpm = pts[0][1];
    else if (k >= pts.length - 1) bpm = pts[pts.length - 1][1];
    else {
      const [x0, y0] = pts[k], [x1, y1] = pts[k + 1];
      bpm = y0 + ((y1 - y0) * (t - x0)) / (x1 - x0);
    }
    period[t] = (60 * fps) / bpm;
  }
  return period;
}

/**
 * Split beat times (s) into continuous runs. A new run starts when the next
 * interval differs from the recent typical interval by more than ~35%: real
 * tempo never jumps that much between beats, so it's a gap (silence, a break)
 * or a spurious beat, e.g. where a recording was stopped mid-song.
 */
export function beatRuns(beats) {
  const runs = [];
  let cur = [];
  for (let i = 0; i < beats.length; i++) {
    if (cur.length >= 2) {
      const recent = [];
      for (let j = Math.max(1, cur.length - 4); j < cur.length; j++) recent.push(cur[j] - cur[j - 1]);
      recent.sort((a, b) => a - b);
      const ref = recent[recent.length >> 1];
      const ibi = beats[i] - cur[cur.length - 1];
      if (ibi > 1.35 * ref || ibi < 0.7 * ref) { runs.push(cur); cur = []; }
    }
    cur.push(beats[i]);
  }
  if (cur.length) runs.push(cur);
  return runs.filter((r) => r.length >= 4);
}

/**
 * Per-beat local tempo and timing residual from a sliding linear fit
 * (beat time vs index) over ±half beats. The fit slope is the local period;
 * the residual is how early (-) or late (+) the beat is against that grid.
 */
export function beatTempo(beats, half = 4) {
  const out = [];
  for (const run of beatRuns(beats)) {
    for (let i = 0; i < run.length; i++) {
      const a = Math.max(0, i - half), b = Math.min(run.length - 1, i + half);
      const m = b - a + 1;
      if (m < 4) continue;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let j = a; j <= b; j++) { sx += j; sy += run[j]; sxx += j * j; sxy += j * run[j]; }
      const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx);
      const icpt = (sy - slope * sx) / m;
      out.push({ t: run[i], bpm: 60 / slope, residualMs: (run[i] - (icpt + slope * i)) * 1000 });
    }
  }
  return out;
}

/**
 * Group beats into bars. phase = index (0..bpb-1) of the first downbeat within each run.
 * @returns {{t:number, end:number, bpm:number, beats:number[]}[]}
 */
export function barsFromBeats(beats, bpb = 4, phase = 0) {
  const bars = [];
  for (const run of beatRuns(beats)) {
    for (let i = phase % bpb; i + bpb < run.length; i += bpb) {
      const t = run[i], end = run[i + bpb];
      bars.push({ t, end, bpm: (60 * bpb) / (end - t), beats: run.slice(i, i + bpb) });
    }
  }
  return bars;
}

/**
 * Mean timing offset (ms) of each beat position within the bar, relative to
 * an even grid fitted to that bar. Shows e.g. a rushed beat 4.
 */
export function beatPositionProfile(bars, bpb = 4) {
  const sum = new Float64Array(bpb), sumSq = new Float64Array(bpb);
  let count = 0;
  for (const bar of bars) {
    const period = (bar.end - bar.t) / bpb;
    for (let k = 0; k < bpb; k++) {
      const dev = (bar.beats[k] - (bar.t + k * period)) * 1000;
      sum[k] += dev;
      sumSq[k] += dev * dev;
    }
    count++;
  }
  return Array.from(sum, (s, k) => ({
    position: k + 1,
    meanMs: count ? s / count : 0,
    sdMs: count ? Math.sqrt(Math.max(0, sumSq[k] / count - (s / count) ** 2)) : 0,
  }));
}

/**
 * Attack spread per beat (ms): the energy-weighted time spread of the onset
 * envelope within ±60 ms of each beat. When everyone hits together the onset
 * is one sharp spike (small spread); flams and loose playing smear it out.
 * This is a proxy for ensemble tightness from a single mixed recording.
 */
export function attackSpread(env, fps, beatFrames) {
  const w = Math.round(0.06 * fps), ctx = Math.round(0.3 * fps);
  return beatFrames.map((bf) => {
    const c = Math.round(bf);
    const around = [];
    for (let i = Math.max(0, c - ctx); i < Math.min(env.length, c + ctx); i++) around.push(env[i]);
    around.sort((a, b) => a - b);
    const base = around[around.length >> 1] ?? 0;
    let s = 0, m1 = 0, m2 = 0;
    for (let i = Math.max(0, c - w); i <= Math.min(env.length - 1, c + w); i++) {
      const v = Math.max(0, env[i] - base);
      s += v; m1 += v * i;
    }
    if (s <= 0) return null;
    const mu = m1 / s;
    for (let i = Math.max(0, c - w); i <= Math.min(env.length - 1, c + w); i++) {
      const v = Math.max(0, env[i] - base);
      m2 += v * (i - mu) ** 2;
    }
    return (Math.sqrt(m2 / s) / fps) * 1000;
  });
}
