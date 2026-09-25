// Turns a stored analysis (beats, curve, sections) into the numbers and
// plain-language insights shown on the inspection page. Cheap; re-run whenever
// the user changes time signature or bar offset.

import { beatTempo, beatPositionProfile } from '../dsp/beats.js';
import { beatPositions, barsFromPositions } from '../dsp/downbeat.js';
import { tempoSummary, within, median, mean } from '../dsp/stats.js';

/**
 * @param {object} analysis analyzeAudio result
 * @param {{beatsPerBar?:number, barPhase?:'auto'|number}} settings
 * @param {object[]} [sectionList] sections to report on (default: the automatic ones)
 */
export function buildReport(analysis, { beatsPerBar = 4, barPhase = 'auto' } = {}, sectionList = analysis.sections) {
  const beatPts = beatTempo(analysis.beats);
  const autoBars = barPhase === 'auto' && !!analysis.accent;
  const positions = beatPositions(analysis.beats, beatsPerBar, autoBars ? 'auto' : +barPhase || 0, analysis.accent);
  const bars = barsFromPositions(analysis.beats, positions, beatsPerBar);
  const downbeats = analysis.beats.filter((_, i) => positions.pos[i] === 0);
  const curvePts = analysis.curve.t.map((t, i) => ({ t, bpm: analysis.curve.bpm[i] }));
  const usable = beatPts.length > 16 ? beatPts : curvePts;
  const summary = tempoSummary(usable);
  const spreadAt = new Map(analysis.beats.map((t, i) => [t, analysis.spreadMs[i]]));

  const timing = (pts) => {
    const res = pts.map((p) => p.residualMs).filter((v) => v != null);
    const spr = pts.map((p) => spreadAt.get(p.t)).filter((v) => v != null);
    return {
      jitterMs: res.length ? Math.sqrt(mean(res.map((r) => r * r))) : null,
      spreadMs: spr.length ? median(spr) : null,
    };
  };

  const sections = (sectionList || []).map((s) => {
    const pts = within(beatPts, s.start, s.end);
    const src = pts.length >= 8 ? pts : within(curvePts, s.start, s.end);
    const sum = tempoSummary(src, { edgeSec: 5 });
    return { ...s, summary: sum, ...timing(pts), bars: bars.filter((b) => b.t >= s.start && b.t < s.end).length };
  });

  const profile = beatPositionProfile(bars, beatsPerBar);
  return {
    summary, beatPts, bars, profile, ...timing(beatPts), sections,
    positions, downbeats, autoBars,
    insights: insights(summary, sections, profile),
  };
}

/** Report for a live session that has no audio: only the live curve. */
export function liveReport(points) {
  const summary = tempoSummary(points);
  return { summary, insights: insights(summary, [], []) };
}

function insights(summary, sections, profile) {
  const out = [];
  if (!summary) return ['Not enough steady rhythm was detected to measure tempo.'];
  const d = summary.drift, pct = summary.driftPct;
  if (Math.abs(pct) < 1) out.push(`Very steady overall: you ended within ${Math.abs(d).toFixed(1)} BPM of where you started.`);
  else out.push(`You ${d > 0 ? 'sped up' : 'slowed down'} by ${Math.abs(d).toFixed(1)} BPM (${Math.abs(pct).toFixed(1)}%) from start (${summary.start.toFixed(1)}) to end (${summary.end.toFixed(1)}).`);
  if (summary.slopePerMin != null && summary.duration > 90 && Math.abs(summary.slopePerMin) >= 0.3) {
    out.push(`Overall trend: ${summary.slopePerMin > 0 ? '+' : ''}${summary.slopePerMin.toFixed(2)} BPM per minute.`);
  }
  // compare section types
  const byName = new Map();
  for (const s of sections) {
    if (!s.summary) continue;
    const key = s.name.replace(/ \d+$/, '');
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(s.summary.mean);
  }
  const avg = [...byName.entries()].map(([name, v]) => ({ name, bpm: mean(v), n: v.length }));
  if (avg.length >= 2) {
    avg.sort((a, b) => b.bpm - a.bpm);
    // chorus vs verse is the comparison bands care about; otherwise fastest vs slowest part
    const ch = avg.find((x) => x.name === 'Chorus'), vs = avg.find((x) => x.name === 'Verse');
    const [hi, lo] = ch && vs ? [ch, vs].sort((a, b) => b.bpm - a.bpm) : [avg[0], avg[avg.length - 1]];
    if (hi.bpm - lo.bpm >= 1) out.push(`${plural(hi)} ran ${(hi.bpm - lo.bpm).toFixed(1)} BPM faster than ${plural(lo).toLowerCase()} (${hi.bpm.toFixed(1)} vs ${lo.bpm.toFixed(1)}).`);
    else out.push('Tempo was consistent across song sections (within 1 BPM).');
  }
  const worst = sections.filter((s) => s.summary && s.summary.sd != null).sort((a, b) => b.summary.sd - a.summary.sd)[0];
  if (worst && sections.length > 2 && worst.summary.sd > 1.5) out.push(`Least steady part: ${worst.name} at ${fmtTime(worst.start)} (±${worst.summary.sd.toFixed(1)} BPM).`);
  const off = profile.filter((p) => Math.abs(p.meanMs) >= 5).sort((a, b) => Math.abs(b.meanMs) - Math.abs(a.meanMs))[0];
  if (off) out.push(`Beat ${off.position} tends to land ${Math.abs(off.meanMs).toFixed(0)} ms ${off.meanMs < 0 ? 'early (rushing)' : 'late (dragging)'} within the bar.`);
  return out;
}

const plural = (a) => (a.n > 1 ? a.name + (/s$/.test(a.name) ? 'es' : 's') : a.name);

export function fmtTime(s) {
  if (s == null || !isFinite(s)) return '–';
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}
