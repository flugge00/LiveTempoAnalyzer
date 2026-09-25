// Summary statistics over tempo series.

export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(a, q) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return s[lo] + (s[hi] - s[lo]) * (p - lo);
}

export function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; }

export function sd(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

/** Least-squares slope of y against x. */
export function slope(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? num / den : null;
}

/**
 * Drift summary for a series of {t, bpm} points (bpm may be null).
 * edgeSec: how much at the start/end is used for the start/end tempo.
 */
export function tempoSummary(points, { edgeSec = 15 } = {}) {
  const pts = points.filter((p) => p.bpm != null && isFinite(p.bpm));
  if (pts.length < 2) return null;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const edge = Math.min(edgeSec, (t1 - t0) / 3);
  const bpms = pts.map((p) => p.bpm);
  const start = median(pts.filter((p) => p.t <= t0 + edge).map((p) => p.bpm));
  const end = median(pts.filter((p) => p.t >= t1 - edge).map((p) => p.bpm));
  const s = slope(pts.map((p) => p.t / 60), bpms);
  return {
    duration: t1 - t0,
    mean: mean(bpms),
    median: median(bpms),
    start,
    end,
    drift: end - start,
    driftPct: ((end - start) / start) * 100,
    slopePerMin: s,
    sd: sd(bpms),
    p05: quantile(bpms, 0.05),
    p95: quantile(bpms, 0.95),
  };
}

/** Points restricted to [a, b). */
export function within(points, a, b) { return points.filter((p) => p.t >= a && p.t < b); }
