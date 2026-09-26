// Trimming: the part of a recording the numbers are about. session.trim =
// {start, end} (seconds) leaves out e.g. a false start or a free-time ending
// that waits for a cue. Non-destructive: the audio and the analysis stay whole,
// and every report is computed from what lies inside the trim.

import { buildReport, liveReport } from './report.js';
import { effectiveSections } from './sections.js';

export const MIN_TRIM_SEC = 10;

const durationOf = (s) => s.analysis?.duration ?? s.duration ?? 0;

/** The session's trim clamped to the recording, or null when it keeps everything. */
export function trimOf(session) {
  const tr = session.trim, dur = durationOf(session);
  if (!tr) return null;
  const start = Math.max(0, tr.start || 0), end = Math.min(dur || Infinity, tr.end ?? Infinity);
  if (end - start < 1 || (start <= 0.01 && end >= dur - 0.01)) return null;
  return { start, end };
}

/** A trim to store: null when it covers the whole recording of `duration` s. */
export function normaliseTrim(tr, duration) {
  if (!tr) return null;
  const start = Math.max(0, tr.start), end = Math.min(duration, tr.end);
  if (start <= 0.01 && end >= duration - 0.01) return null;
  return { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
}

const inside = (tr, t) => !tr || (t >= tr.start && t <= tr.end);

/** {t, ...} points inside the trim. */
export const trimPoints = (points, tr) => (tr ? points.filter((p) => inside(tr, p.t)) : points);

/**
 * The analysis as if only the trimmed part had been played: tempo curve and
 * beats (with their per-beat data) inside the trim. Sections stay whole, so
 * edits keep matching; their numbers come from the beats inside.
 */
export function trimAnalysis(a, tr) {
  if (!tr) return a;
  const keep = a.beats.map((t) => inside(tr, t));
  const pick = (arr) => (Array.isArray(arr) && arr.length === keep.length ? arr.filter((_, i) => keep[i]) : arr);
  const accent = a.accent && Object.fromEntries(Object.entries(a.accent).map(([k, v]) => [k, pick(v)]));
  const ci = a.curve.t.map((t) => inside(tr, t));
  return {
    ...a,
    curve: { t: a.curve.t.filter((_, i) => ci[i]), bpm: a.curve.bpm.filter((_, i) => ci[i]), conf: a.curve.conf?.filter((_, i) => ci[i]) },
    beats: pick(a.beats),
    spreadMs: pick(a.spreadMs),
    accent,
  };
}

/** The report for a session, over its trimmed part. */
export function sessionReport(session) {
  const tr = trimOf(session);
  if (session.analysis) return buildReport(trimAnalysis(session.analysis, tr), session.settings || {}, effectiveSections(session));
  return liveReport(trimPoints((session.live?.points || []).map((p) => ({ t: p.t, bpm: p.bpm })), tr));
}
