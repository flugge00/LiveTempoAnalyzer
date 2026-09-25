// Full offline analysis of a mono signal. Pure (no DOM) so it runs in a Web
// Worker and in the Node test runner.

import { onsetEnvelope } from '../dsp/onset.js';
import { TempoModel, tempoCurve, resolveOctaves } from '../dsp/tempo.js';
import { trackBeats, attackSpread, beatRuns } from '../dsp/beats.js';
import { segmentSong } from '../dsp/segment.js';

export const ANALYSIS_VERSION = 1;

/**
 * @param {Float32Array} samples mono
 * @param {number} sampleRate
 * @param {{expectedBpm?:number, minBpm?:number, maxBpm?:number, windowSec?:number, sections?:boolean}} opts
 * @param {(stage:string, fraction:number)=>void} [onProgress]
 */
export function analyzeAudio(samples, sampleRate, opts = {}, onProgress = () => {}) {
  const det = onsetEnvelope(samples, sampleRate, { features: opts.sections !== false }, (p) => onProgress('Listening for onsets', p * 0.45));
  const fps = det.fps;
  const env = Float64Array.from(det.envelope);

  // Activity mask: within 35 dB of the loud parts of the recording, and above -65 dBFS.
  const rmsSorted = Float64Array.from(det.rms).sort();
  const loud = rmsSorted[Math.floor(rmsSorted.length * 0.95)] || 0;
  const gate = Math.max(10 ** (-65 / 20), loud * 10 ** (-35 / 20));
  const active = Uint8Array.from(det.rms, (r) => (r > gate ? 1 : 0));
  // bridge short dropouts (< 1.5 s) so breaks inside a song don't cut the curve
  fillShortGaps(active, Math.round(1.5 * fps));

  const model = new TempoModel(fps, {
    expectedBpm: opts.expectedBpm, minBpm: opts.minBpm, maxBpm: opts.maxBpm, windowSec: opts.windowSec ?? 8,
  });
  const curve = tempoCurve(env, model, { active, onProgress: (p) => onProgress('Estimating tempo', 0.45 + p * 0.25) });
  curve.bpm = resolveOctaves(curve.times, curve.bpm, (b) => model.priorAt(b));
  onProgress('Tracking beats', 0.72);
  const beatFrames = trackBeats(env, fps, curve, { active });
  const beats = beatFrames.map((f) => det.timeOf(f));
  const spreadMs = attackSpread(env, fps, beatFrames);

  let sections = [];
  if (opts.sections !== false && beats.length) {
    onProgress('Finding song sections', 0.85);
    sections = sectionsPerTake(det.features(), beatFrames, beats, samples.length / sampleRate);
  }
  onProgress('Done', 1);

  // level trace for drawing (dBFS, 20 per second)
  const step = Math.max(1, Math.round(fps / 20));
  const levels = [];
  for (let i = 0; i < det.rms.length; i += step) {
    let m = 0;
    for (let j = i; j < Math.min(det.rms.length, i + step); j++) m = Math.max(m, det.rms[j]);
    levels.push(Math.round(20 * Math.log10(m + 1e-9) * 10) / 10);
  }

  return {
    version: ANALYSIS_VERSION,
    duration: samples.length / sampleRate,
    fps,
    options: { expectedBpm: opts.expectedBpm ?? null, windowSec: opts.windowSec ?? 8 },
    curve: {
      t: curve.times.map(round3),
      bpm: curve.bpm.map((b) => (b == null ? null : round3(b))),
      conf: curve.confidence.map((c) => Math.round(c * 100) / 100),
    },
    beats: beats.map((t) => Math.round(t * 10000) / 10000),
    spreadMs: spreadMs.map((s) => (s == null ? null : Math.round(s * 10) / 10)),
    sections,
    levels: { dt: step / fps, db: levels },
  };
}

/** A rehearsal recording can hold several songs: segment each continuous take separately. */
function sectionsPerTake(feats, beatFrames, beats, duration) {
  const out = [];
  let offset = 0;
  const runs = beatRuns(beats);
  // merge runs separated by short gaps (< 6 s) into takes
  const takes = [];
  for (const r of runs) {
    const last = takes[takes.length - 1];
    if (last && r[0] - last[last.length - 1] < 6) last.push(...r);
    else takes.push([...r]);
  }
  for (const take of takes) {
    const i0 = beats.indexOf(take[0]);
    offset = i0;
    const frames = beatFrames.slice(i0, i0 + take.length);
    if (take.length < 32) continue;
    const segs = segmentSong(feats, frames);
    for (const s of segs) {
      out.push({
        start: round3(beats[offset + s.startBeat]),
        end: round3(s.endBeat < take.length ? beats[offset + s.endBeat] : Math.min(duration, take[take.length - 1] + (take[1] - take[0]))),
        label: s.label,
        name: s.name,
        take: takes.indexOf(take) + 1,
      });
    }
  }
  return out;
}

function fillShortGaps(mask, maxLen) {
  let i = 0;
  const n = mask.length;
  while (i < n) {
    if (mask[i]) { i++; continue; }
    let j = i;
    while (j < n && !mask[j]) j++;
    if (i > 0 && j < n && j - i < maxLen) mask.fill(1, i, j);
    i = j;
  }
}

const round3 = (x) => Math.round(x * 1000) / 1000;
