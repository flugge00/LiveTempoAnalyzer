// Splitting one recording into two songs (two songs played straight after each
// other, recorded in one go). Pure: the audio itself is cut by the caller.

const MIN_PART_SEC = 5;
const MIN_SECTION_SEC = 1.5;

/** Can `session` be split at t (seconds)? Both parts need some length. */
export function canSplitAt(session, t) {
  const dur = session.analysis?.duration ?? session.duration ?? 0;
  return t >= MIN_PART_SEC && dur - t >= MIN_PART_SEC;
}

/**
 * The two sessions that replace `session` when it's split at t. Live readings,
 * markers and edited sections are cut at t, and the second part's times start
 * from 0. Neither part has audio or an analysis yet: the caller cuts the audio
 * and analyzes each part.
 * @param {object} session
 * @param {number} t split time (s)
 * @param {{ids:[string,string], names?:[string,string]}} o
 */
export function splitSession(session, t, { ids, names = [] }) {
  const dur = session.analysis?.duration ?? session.duration ?? 0;
  const { audio, analysis, sections, sectionNames, id, name, created, modified, fileName, live, trim, ...rest } = session;
  const base = fileName?.replace(/\.[^.]+$/, '') || name;
  const parts = [[0, t], [t, dur]].map(([a, b], k) => {
    const s = {
      ...structuredClone(rest),
      id: ids[k],
      name: names[k]?.trim() || `${name} (${k + 1})`,
      created: created + Math.round(a * 1000), // keeps the two in playing order
      duration: b - a,
    };
    if (fileName) s.fileName = `${base} (${k + 1}).wav`;
    // the target tempo was set for the song the recording started with
    if (k > 0 && s.settings) s.settings.targetBpm = null;
    if (live) {
      s.live = {
        points: live.points.filter((p) => p.t >= a && p.t < b).map((p) => ({ ...p, t: round2(p.t - a) })),
        markers: (live.markers || []).filter((m) => m.t >= a && m.t < b).map((m) => ({ ...m, t: round2(m.t - a) })),
      };
    }
    // a trimmed-off start stays off the first song, a trimmed-off end off the second
    if (trim) {
      const ts = Math.max(trim.start ?? 0, a) - a, te = Math.min(trim.end ?? b, b) - a;
      if (te - ts >= 1 && (ts > 0.01 || te < b - a - 0.01)) s.trim = { start: round2(ts), end: round2(te) };
    }
    if (sections) {
      const cut = sections
        .map((x) => ({ ...x, start: Math.max(x.start, a) - a, end: Math.min(x.end, b) - a }))
        .filter((x) => x.end - x.start >= MIN_SECTION_SEC);
      if (cut.length) s.sections = cut;
    }
    return s;
  });
  return parts;
}

/**
 * Tempo hint for analyzing the part [a, b) of a split recording: the original
 * analysis's hint, if the tempo there is still near it (it was given for the
 * whole medley, or for its first song only).
 */
export function partHint(analysis, a, b) {
  const hint = analysis?.options?.expectedBpm;
  if (!hint) return undefined;
  const vals = analysis.curve.bpm.filter((v, i) => v != null && analysis.curve.t[i] >= a && analysis.curve.t[i] < b).sort((p, q) => p - q);
  if (!vals.length) return undefined;
  return Math.abs(Math.log(vals[vals.length >> 1] / hint)) < 0.22 ? hint : undefined;
}

/**
 * Where the second song probably starts: the middle of the weakest stretch of
 * rhythm (low tempo confidence, or no reading at all) away from the ends, or
 * the start of a second take if the analysis found one. Null if nothing stands out.
 * @param {object} analysis analyzeAudio result
 */
export function suggestSongBreak(analysis) {
  if (!analysis?.curve?.t?.length) return null;
  const take2 = analysis.sections?.find((s) => s.take > 1);
  if (take2) return take2.start;
  const { t, bpm, conf } = analysis.curve;
  const dur = analysis.duration, edge = Math.min(30, dur / 4);
  const c = t.map((_, i) => (bpm[i] == null ? 0 : conf[i]));
  // mean confidence over ±3 s
  const dt = t.length > 1 ? t[1] - t[0] : 0.25, half = Math.max(1, Math.round(3 / dt));
  const smooth = c.map((_, i) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(c.length - 1, i + half); j++) { s += c[j]; n++; }
    return s / n;
  });
  let arg = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] < edge || t[i] > dur - edge) continue;
    if (arg < 0 || smooth[i] < smooth[arg]) arg = i;
  }
  if (arg < 0 || smooth[arg] >= WEAK) return null;
  // widen to the whole weak stretch and take its middle
  let lo = arg, hi = arg;
  while (lo > 0 && smooth[lo - 1] < WEAK) lo--;
  while (hi < t.length - 1 && smooth[hi + 1] < WEAK) hi++;
  return round2((t[lo] + t[hi]) / 2);
}

const WEAK = 0.2; // tempo confidence of a band playing is ~0.2-0.6 (see OctaveResolver)
const round2 = (x) => Math.round(x * 100) / 100;
