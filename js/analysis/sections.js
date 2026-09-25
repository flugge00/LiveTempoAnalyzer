// Song sections as the user sees them: the automatic ones from the analysis,
// or the user's edited copy (session.sections) once they split, join, move or
// rename anything. Edits are stored as times, so they survive a re-analysis.

export const SECTION_NAMES = ['Intro', 'Verse', 'Pre-chorus', 'Chorus', 'Bridge', 'Solo', 'Interlude', 'Break', 'Outro'];
const MIN_LEN = 1.5; // s

/** The sections to show and report on, with user renames applied. */
export function effectiveSections(session) {
  if (session.sections) return session.sections;
  const auto = session.analysis?.sections || [];
  const names = session.sectionNames || {};
  return auto.map((s, i) => ({ start: s.start, end: s.end, label: s.label, name: names[i] ?? s.name, take: s.take }));
}

/** Copy of the list that edits can be made on (first edit switches to the user's copy). */
export const editable = (session) => effectiveSections(session).map((s) => ({ ...s }));

/** Nearest beat to t (or t itself if there are no beats nearby). */
export function snapToBeat(beats, t, maxDist = 1) {
  if (!beats?.length) return t;
  let lo = 0, hi = beats.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (beats[m] < t) lo = m; else hi = m; }
  const b = Math.abs(beats[lo] - t) < Math.abs(beats[hi] - t) ? beats[lo] : beats[hi];
  return Math.abs(b - t) <= maxDist ? b : t;
}

/** Index of the section containing t, or -1. */
export const sectionAt = (list, t) => list.findIndex((s) => t >= s.start && t < s.end);

/** Can the section containing t be split at t? */
export function canSplit(list, t) {
  const i = sectionAt(list, t);
  return i >= 0 && t - list[i].start >= MIN_LEN && list[i].end - t >= MIN_LEN;
}

export function split(list, t) {
  const i = sectionAt(list, t);
  if (!canSplit(list, t)) return list;
  const s = list[i];
  return [...list.slice(0, i), { ...s, end: t }, { ...s, start: t }, ...list.slice(i + 1)];
}

/** Joins section i with the next one (the first one's name wins). */
export function joinNext(list, i) {
  if (i < 0 || i >= list.length - 1) return list;
  return [...list.slice(0, i), { ...list[i], end: list[i + 1].end }, ...list.slice(i + 2)];
}

/**
 * Moves one edge. edge = {i, side: 'start'|'end'}; a boundary shared with the
 * neighbour moves both. Keeps every section at least MIN_LEN long.
 */
export function moveEdge(list, edge, t) {
  const out = list.map((s) => ({ ...s }));
  const { i, side } = edge;
  const s = out[i];
  const shared = side === 'end' ? out[i + 1] && Math.abs(out[i + 1].start - s.end) < 0.05 && out[i + 1]
    : out[i - 1] && Math.abs(out[i - 1].end - s.start) < 0.05 && out[i - 1];
  let lo, hi;
  if (side === 'end') {
    lo = s.start + MIN_LEN;
    hi = shared ? shared.end - MIN_LEN : out[i + 1] ? out[i + 1].start : Infinity;
  } else {
    lo = shared ? shared.start + MIN_LEN : out[i - 1] ? out[i - 1].end : 0;
    hi = s.end - MIN_LEN;
  }
  if (lo > hi) return list;
  const v = Math.max(lo, Math.min(hi, t));
  if (side === 'end') { s.end = v; if (shared) shared.start = v; } else { s.start = v; if (shared) shared.end = v; }
  return out;
}

/** Colour slot per section: the same name (ignoring a trailing number) gets the same colour. */
export function colorIndexes(list) {
  const slots = new Map();
  return list.map((s) => {
    const key = baseName(s.name);
    if (!slots.has(key)) slots.set(key, slots.size);
    return slots.get(key);
  });
}

export const baseName = (name) => String(name || '').replace(/\s+\d+$/, '').trim().toLowerCase();
