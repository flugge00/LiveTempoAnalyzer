// Synthetic test signals: drum-ish patterns with a known (possibly drifting) tempo.

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/**
 * @param {object} o
 *   sr, duration, bpm: number | (t)=>number, jitterMs (random timing error per hit),
 *   noise (background noise amplitude), eighths (add hi-hat 8ths), seed,
 *   halfTime: (t)=>boolean  play a half-time feel at these times (same tempo, sparser hits)
 *   halfTimeHats: keep the hi-hat eighths going through the half-time parts
 * @returns {{samples: Float32Array, beats: number[]}}
 */
export function drumTrack(o) {
  const sr = o.sr ?? 44100, dur = o.duration ?? 30;
  const bpmAt = typeof o.bpm === 'function' ? o.bpm : () => o.bpm ?? 120;
  const rand = rng(o.seed ?? 1);
  const out = new Float32Array(Math.round(sr * dur));
  const beats = [];
  let t = o.offset ?? 0.3, beat = 0;
  while (t < dur - 0.5) {
    beats.push(t);
    const period = 60 / bpmAt(t);
    const jit = () => ((o.jitterMs ?? 0) / 1000) * rand();
    if (o.halfTime?.(t)) {
      // half-time feel: kick on 1, snare on 3, nothing in between (sounds like half the tempo)
      if (beat % 2 === 0) hit(out, sr, t + jit(), beat % 4 === 0 ? 'kick' : 'snare', rand);
      if (o.halfTimeHats) { hit(out, sr, t + jit(), 'hat', rand); hit(out, sr, t + period / 2 + jit(), 'hat', rand); }
    } else {
      // kick on 1 & 3, snare on 2 & 4
      hit(out, sr, t + jit(), beat % 2 === 0 ? 'kick' : 'snare', rand);
      if (o.eighths) hit(out, sr, t + period / 2 + jit(), 'hat', rand);
      if (o.eighths) hit(out, sr, t + jit(), 'hat', rand);
    }
    t += period;
    beat++;
  }
  const na = o.noise ?? 0.01;
  for (let i = 0; i < out.length; i++) out[i] += na * rand();
  return { samples: out, beats };
}

/**
 * A drum track with sustained chords that change per section, so structure
 * analysis has something to find.
 * @param {{sr, bpm: number|(t)=>number, jitterMs?, parts: {chord:number[], beats:number, bright?:boolean, gain?:number, bpmOffset?:number}[]}} o
 *   bpm is the base tempo (may drift over time); each part may add bpmOffset (e.g. a rushed chorus)
 * @returns {{samples, beats, boundaries: number[]}} boundaries = section start times (s)
 */
export function songWithSections(o) {
  const sr = o.sr ?? 44100, start = 0.3;
  const base = typeof o.bpm === 'function' ? o.bpm : () => o.bpm ?? 120;
  // lay out section start times first so the tempo function can know which part it's in
  const boundaries = [];
  let t = start;
  for (const part of o.parts) {
    boundaries.push(t);
    for (let k = 0; k < part.beats; k++) t += 60 / (base(t) + (part.bpmOffset || 0));
  }
  const end = t;
  const partAt = (x) => { let i = 0; while (i < boundaries.length - 1 && boundaries[i + 1] <= x) i++; return o.parts[i]; };
  const bpm = (x) => base(x) + (partAt(x).bpmOffset || 0);
  const { samples, beats } = drumTrack({ sr, duration: end + 1, bpm, offset: start, eighths: true, seed: 11, jitterMs: o.jitterMs });
  for (const [pi, part] of o.parts.entries()) {
    const t0 = boundaries[pi], t1 = boundaries[pi + 1] ?? end;
    const g = part.gain ?? 0.08;
    for (let i = Math.round(t0 * sr); i < Math.min(samples.length, Math.round(t1 * sr)); i++) {
      const t = i / sr;
      let v = 0;
      for (const f of part.chord) {
        v += Math.sin(2 * Math.PI * f * t);
        if (part.bright) v += 0.5 * Math.sin(4 * Math.PI * f * t) + 0.33 * Math.sin(6 * Math.PI * f * t);
      }
      samples[i] += g * v;
    }
  }
  return { samples, beats, boundaries };
}

function hit(out, sr, t, kind, rand) {
  const start = Math.round(t * sr);
  const len = Math.round(sr * (kind === 'hat' ? 0.05 : 0.25));
  for (let i = 0; i < len && start + i < out.length; i++) {
    if (start + i < 0) continue;
    const s = i / sr;
    let v;
    if (kind === 'kick') v = 0.8 * Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-s * 30)) * s) * Math.exp(-s * 12);
    else if (kind === 'snare') v = 0.5 * rand() * Math.exp(-s * 25) + 0.3 * Math.sin(2 * Math.PI * 190 * s) * Math.exp(-s * 20);
    else v = 0.15 * rand() * Math.exp(-s * 80);
    out[start + i] += v;
  }
}
