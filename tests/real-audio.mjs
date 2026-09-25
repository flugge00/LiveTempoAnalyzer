// Regression check on real band recordings (not in git). Decode them first:
//   node tools/decode-audio.mjs
// then:
//   node tests/real-audio.mjs
// Checks that tempo never jumps to a different metrical level (x2, x1/2, x3...)
// within a song, offline and live. Skips if there's no decoded audio.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { analyzeAudio } from '../js/analysis/analyze.js';
import { buildReport } from '../js/analysis/report.js';
import { LiveTempo } from '../js/analysis/live-tempo.js';

const cache = new URL('../test_audio/.cache/', import.meta.url);
const files = existsSync(cache) ? readdirSync(cache).filter((f) => f.endsWith('.f32')) : [];
if (!files.length) { console.log('No decoded recordings in test_audio/.cache (run tools/decode-audio.mjs). Skipping.'); process.exit(0); }

let failures = 0;
const octaveErrors = (vals, ref) => vals.filter((v) => v != null && Math.abs(Math.log2(v / ref)) > 0.25).length;

for (const f of files) {
  const b = readFileSync(new URL(f, cache));
  const x = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
  const a = analyzeAudio(x, 22050, {});
  const vals = a.curve.bpm.filter((v) => v != null);
  const med = [...vals].sort((p, q) => p - q)[vals.length >> 1];

  const live = [];
  const lt = new LiveTempo(22050, {}, {
    onTempo: (p) => live.push({ ...p }),
    onRescale: (k, since) => { for (const p of live) if (p.bpm != null && p.t >= since - 0.01) p.bpm *= k; },
  });
  for (let i = 0; i < x.length; i += 2048) lt.push(x.subarray(i, i + 2048));

  const rep = buildReport(a);
  const off = octaveErrors(vals, med), liveOff = octaveErrors(live.map((p) => p.bpm), med);
  const barsOff = rep.bars.filter((bar) => Math.abs(Math.log2(bar.bpm / med)) > 0.25).length;
  const ok = off === 0 && liveOff === 0 && barsOff === 0;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}: median ${med.toFixed(1)} BPM, range ${Math.min(...vals).toFixed(1)}–${Math.max(...vals).toFixed(1)}; ` +
    `octave errors offline ${off}/${vals.length}, live ${liveOff}/${live.filter((p) => p.bpm != null).length}, bars ${barsOff}/${rep.bars.length}`);
  console.log(`      ${rep.insights.join(' | ')}`);
}
process.exitCode = failures ? 1 : 0;
