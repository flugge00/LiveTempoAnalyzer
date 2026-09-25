// Test runner for the DSP modules. Run with tests/run.ps1 (uses VS Code's bundled
// Node) or with any Node >= 18: `node tests/run.mjs`.

import { writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { crc32, makeZip, readZip } from '../js/store/zip.js';
import { exportSessions, readSessionsFile, importSessions } from '../js/store/share.js';
import { split, joinNext, moveEdge, canSplit, effectiveSections, colorIndexes } from '../js/analysis/sections.js';
import { drumTrack, songWithSections } from '../js/analysis/demo-synth.js';
import { onsetEnvelope } from '../js/dsp/onset.js';
import { TempoModel, tempoCurve } from '../js/dsp/tempo.js';
import { LiveTempo } from '../js/analysis/live-tempo.js';
import { analyzeAudio } from '../js/analysis/analyze.js';
import { buildReport } from '../js/analysis/report.js';
import { barsFromBeats, beatTempo } from '../js/dsp/beats.js';

const log = [];
const print = (...a) => { const s = a.join(' '); log.push(s); console.log(s); };
let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  print(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** The exact live pipeline, fed in 2048-sample blocks like the AudioWorklet does. */
function liveEstimate(samples, sr, opts = {}) {
  const out = [];
  const live = new LiveTempo(sr, opts, {
    onTempo: (p) => out.push({ ...p }),
    // same as the live view: correct what's already plotted for this take
    onRescale: (k, since) => { for (const p of out) if (p.bpm != null && p.t >= since - 0.01) p.bpm *= k; },
  });
  for (let i = 0; i < samples.length; i += 2048) live.push(samples.subarray(i, i + 2048));
  return out;
}

function offlineCurve(samples, sr, opts = {}) {
  const det = onsetEnvelope(samples, sr);
  const model = new TempoModel(det.fps, opts);
  const curve = tempoCurve(Float64Array.from(det.envelope), model);
  return { det, curve };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

async function appTests() {
  // zip + session sharing round trip
  {
    check('crc32 known value', crc32(new TextEncoder().encode('123456789')) === 0xcbf43926);
    const zip = await makeZip([{ name: 'a/ü.txt', data: 'hello' }, { name: 'b.bin', data: new Uint8Array([1, 2, 3]) }]);
    const entries = await readZip(zip);
    const ok = entries.length === 2 && entries[0].name === 'a/ü.txt' && (await entries[0].text()) === 'hello'
      && new Uint8Array(await (await entries[1].blob()).arrayBuffer()).join() === '1,2,3';
    check('zip round trip', ok, entries.map((e) => e.name).join(', '));

    const audio = new Blob([new Uint8Array(5000).map((_, i) => i % 251)], { type: 'audio/webm;codecs=opus' });
    const s1 = { id: 'abc', name: 'Memories / take 2', created: 1000, modified: 2000, kind: 'live', duration: 60, live: { points: [{ t: 1, bpm: 120, c: 1 }], markers: [] }, settings: { beatsPerBar: 4, barPhase: 'auto' }, sections: [{ start: 0, end: 30, label: 'A', name: 'Verse' }], audio };
    const s2 = { id: 'def', name: 'No audio', created: 1500, kind: 'file', analysis: { beats: [], curve: { t: [], bpm: [] } }, settings: {} };
    const back = await readSessionsFile(await exportSessions([s1, s2]));
    const r1 = back.find((s) => s.id === 'abc');
    const sameAudio = r1?.audio && (await r1.audio.arrayBuffer()).byteLength === 5000 && r1.audio.type.startsWith('audio/webm');
    check('session export/import keeps data and audio', back.length === 2 && r1.name === s1.name && r1.sections[0].name === 'Verse' && sameAudio && !back.find((s) => s.id === 'def').audio);

    const store = new Map([['abc', { ...s1, modified: 5000, name: 'edited here' }]]);
    const db = { getSession: async (id) => store.get(id), saveSession: async (s) => { store.set(s.id, s); return s; } };
    const res = await importSessions(back, db);
    check('import keeps the newer copy', res.added === 1 && res.unchanged === 1 && store.get('abc').name === 'edited here', JSON.stringify(res));
    let bad = null;
    try { await readSessionsFile(new Blob(['{"hello": 1}'])); } catch (e) { bad = e; }
    check('import rejects foreign files', !!bad, bad?.message);
  }

  // section editing
  {
    const list = [{ start: 0, end: 20, name: 'Intro' }, { start: 20, end: 50, name: 'Verse' }, { start: 50, end: 80, name: 'Chorus' }];
    const sp = split(list, 35);
    const jn = joinNext(sp, 1);
    const mv = moveEdge(list, { i: 0, side: 'end' }, 25);
    const clamp = moveEdge(list, { i: 0, side: 'end' }, 60);
    check('split / join / move sections',
      sp.length === 4 && sp[1].end === 35 && sp[2].start === 35 && sp[2].name === 'Verse'
      && jn.length === 3 && jn[1].end === 50
      && mv[0].end === 25 && mv[1].start === 25
      && clamp[0].end === 48.5 && clamp[1].start === 48.5 && !canSplit(list, 20.5),
      `clamped to ${clamp[0].end}`);
    const legacy = effectiveSections({ analysis: { sections: [{ start: 0, end: 10, label: 'A', name: 'Intro' }, { start: 10, end: 20, label: 'B', name: 'Part B' }] }, sectionNames: { 1: 'Chorus 1' } });
    const colors = colorIndexes([{ name: 'Verse' }, { name: 'Chorus 1' }, { name: 'Verse 2' }, { name: 'chorus' }]);
    check('older renames and colour groups', legacy[1].name === 'Chorus 1' && colors.join() === '0,1,0,1', colors.join());
  }

  // the service worker must cache every app file, and only files that exist
  {
    const root = new URL('../', import.meta.url);
    const sw = readFileSync(new URL('sw.js', root), 'utf8');
    const listed = new Set([...sw.matchAll(/^\s+'([^']+)',?$/gm)].map((m) => m[1]));
    const walk = (dir) => readdirSync(new URL(dir, root)).flatMap((f) => (statSync(new URL(dir + f, root)).isDirectory() ? walk(`${dir}${f}/`) : [dir + f]));
    const missing = walk('js/').filter((f) => !listed.has(f));
    const absent = [...listed].filter((f) => f !== './' && !existsSync(new URL(f, root)));
    check('service worker caches every app file', !missing.length && !absent.length, [...missing.map((f) => 'not cached: ' + f), ...absent.map((f) => 'no such file: ' + f)].join(', '));
  }
}

async function main() {
  const sr = 44100;
  const t0 = Date.now();
  await appTests();

  // 1. constant 120 BPM
  {
    const { samples } = drumTrack({ sr, duration: 30, bpm: 120, eighths: true });
    const live = liveEstimate(samples, sr);
    const last = live.slice(-20).map((r) => r.bpm);
    const err = Math.max(...last.map((b) => Math.abs(b - 120)));
    check('live 120 BPM steady', err < 0.6, `max err ${err.toFixed(2)}, last ${last.at(-1).toFixed(2)}`);
    const { curve } = offlineCurve(samples, sr);
    const vals = curve.bpm.filter((b) => b);
    check('offline 120 BPM median', Math.abs(median(vals) - 120) < 0.3, `median ${median(vals).toFixed(2)}`);
  }

  // 2. several tempos, kick/snare only
  for (const bpm of [72, 95, 138, 150]) {
    const { samples } = drumTrack({ sr, duration: 25, bpm, seed: bpm });
    const { curve } = offlineCurve(samples, sr);
    const m = median(curve.bpm.filter((b) => b));
    check(`offline ${bpm} BPM`, Math.abs(m - bpm) < 0.5, `median ${m.toFixed(2)}`);
  }
  // 174 is genuinely ambiguous with 87 (half-time feel); the expected-BPM hint resolves it
  {
    const { samples } = drumTrack({ sr, duration: 25, bpm: 174, seed: 174 });
    const { curve } = offlineCurve(samples, sr, { expectedBpm: 170 });
    const m = median(curve.bpm.filter((b) => b));
    check('offline 174 BPM with hint 170', Math.abs(m - 174) < 0.5, `median ${m.toFixed(2)}`);
  }

  // 3. drifting tempo 100 -> 112 over 60 s, with human jitter
  {
    const f = (t) => 100 + (12 * t) / 60;
    const { samples } = drumTrack({ sr, duration: 60, bpm: f, eighths: true, jitterMs: 8, seed: 7 });
    const { curve } = offlineCurve(samples, sr);
    const errs = curve.times.map((t, i) => (curve.bpm[i] && t > 5 && t < 55 ? Math.abs(curve.bpm[i] - f(t)) : 0));
    const maxErr = Math.max(...errs);
    check('offline ramp 100→112 tracks', maxErr < 1.5, `max err ${maxErr.toFixed(2)} BPM`);
    const live = liveEstimate(samples, sr);
    const lerr = live.filter((r) => r.t > 12 && r.bpm).map((r) => Math.abs(r.bpm - f(r.t - 4)));
    check('live ramp 100→112 tracks', Math.max(...lerr) < 2, `max err ${Math.max(...lerr).toFixed(2)} BPM`);
  }

  // 4. silence in the middle -> nulls
  {
    const { samples } = drumTrack({ sr, duration: 40, bpm: 110, seed: 3 });
    samples.fill(0, sr * 15, sr * 27);
    const det = onsetEnvelope(samples, sr);
    const active = Float32Array.from(det.rms, (r) => (r > 0.003 ? 1 : 0));
    const curve = tempoCurve(Float64Array.from(det.envelope), new TempoModel(det.fps), { active });
    const mid = curve.times.map((t, i) => (t > 20 && t < 22 ? curve.bpm[i] : undefined)).filter((b) => b !== undefined);
    check('silence gives gaps', mid.every((b) => b === null), `${mid.length} mid points`);
  }

  // 5. beat tracking + report on a drifting, jittery performance
  {
    const f = (t) => 96 + (6 * t) / 90;
    const { samples, beats: truth } = drumTrack({ sr, duration: 90, bpm: f, eighths: true, jitterMs: 6, seed: 5 });
    const a = analyzeAudio(samples, sr, { sections: false });
    const matched = truth.filter((tb) => a.beats.some((b) => Math.abs(b - tb) < 0.03)).length;
    const recall = matched / truth.length;
    check('beat tracking recall', recall > 0.95, `${(recall * 100).toFixed(1)}% of ${truth.length} beats within 30 ms, ${a.beats.length} detected`);
    const rep = buildReport(a);
    check('report drift ≈ +6 BPM', Math.abs(rep.summary.drift - 6 * (80 / 90)) < 1.5, `drift ${rep.summary.drift.toFixed(2)}, slope ${rep.summary.slopePerMin.toFixed(2)}/min`);
    check('report jitter in plausible range', rep.jitterMs > 1 && rep.jitterMs < 12, `jitter ${rep.jitterMs.toFixed(1)} ms, spread ${rep.spreadMs?.toFixed(1)} ms`);
    print('      insights:', rep.insights.join(' | '));
  }

  // 6. rushing beat 4: every 4th beat 25 ms early
  {
    const { samples } = drumTrack({ sr, duration: 40, bpm: 110, seed: 9 });
    // re-synthesise with a shifted beat 4 by building from scratch
    const period = 60 / 110, out = new Float32Array(samples.length);
    const { samples: click } = drumTrack({ sr, duration: 1, bpm: 60, offset: 0, seed: 2 });
    const one = click.subarray(0, Math.round(0.25 * sr));
    for (let k = 0, t = 0.5; t < 39; k++, t += period) {
      const tt = t - (k % 4 === 3 ? 0.025 : 0);
      out.set(one.subarray(0, Math.min(one.length, out.length - Math.round(tt * sr))), Math.round(tt * sr));
    }
    const a = analyzeAudio(out, sr, { sections: false });
    const best = [0, 1, 2, 3].map((phase) => buildReport(a, { barPhase: phase }).profile)
      .map((p) => Math.min(...p.map((x) => x.meanMs)));
    check('beat-position profile finds the rushed beat', Math.min(...best) < -12, `most-early position mean ${Math.min(...best).toFixed(1)} ms`);
  }

  // 7. structure: A B A B C B
  {
    const C = [261.6, 329.6, 392], F = [349.2, 440, 523.3], Am = [220, 261.6, 329.6], G = [196, 246.9, 293.7];
    const parts = [
      { chord: C, beats: 32 }, { chord: F, beats: 32, bright: true, gain: 0.12 },
      { chord: C, beats: 32 }, { chord: F, beats: 32, bright: true, gain: 0.12 },
      { chord: Am, beats: 16, gain: 0.05 }, { chord: F, beats: 32, bright: true, gain: 0.12 },
      { chord: G, beats: 16 },
    ];
    const { samples, boundaries } = songWithSections({ sr, bpm: 120, parts });
    const a = analyzeAudio(samples, sr);
    const found = a.sections.map((s) => s.start);
    const hits = boundaries.slice(1).filter((b) => found.some((f) => Math.abs(f - b) < 1.1)).length;
    check('section boundaries found', hits >= boundaries.length - 2, `${hits}/${boundaries.length - 1} true boundaries within 2 beats; found ${a.sections.length} sections`);
    const labels = a.sections.map((s) => s.label).join('');
    const names = a.sections.map((s) => s.name).join(', ');
    const repeatsMatch = a.sections.length >= 6 && labels[0] === labels[2] && labels[1] === labels[3] && labels[1] === labels[5];
    check('repeated sections share labels', repeatsMatch, `${labels} → ${names}`);
  }

  // 8. a stray beat at the end of a recording must not create a tempo outlier
  {
    const beats = Array.from({ length: 40 }, (_, i) => 0.5 + i * 0.5);
    beats.push(beats.at(-1) + 0.23); // spurious beat where the recording was cut
    const bars = barsFromBeats(beats);
    const maxBar = Math.max(...bars.map((b) => b.bpm));
    const maxBeat = Math.max(...beatTempo(beats).map((p) => p.bpm));
    check('stray end beat ignored', maxBar < 121 && maxBeat < 121, `max bar ${maxBar.toFixed(1)}, max beat ${maxBeat.toFixed(1)} BPM (true 120)`);
  }

  // 9. half-time feel sections must not flip the tempo to half (the "Memories" problem)
  {
    const half = (t) => (t > 25 && t < 45) || (t > 70 && t < 90);
    const { samples, beats: truth } = drumTrack({ sr, duration: 110, bpm: 128, eighths: true, halfTime: half, seed: 21 });
    const a = analyzeAudio(samples, sr, { sections: false });
    const wrong = a.curve.bpm.filter((b) => b != null && Math.abs(b - 128) > 3).length;
    const n = a.curve.bpm.filter((b) => b != null).length;
    check('offline: half-time sections keep full tempo', wrong === 0, `${wrong}/${n} readings off by >3 BPM`);
    // the backbeat (snare on 2 and 4) must keep the bar count on the right beats
    // even through the half-time parts, where the snare moves to 3
    const down = buildReport(a, { beatsPerBar: 4, barPhase: 'auto' }).downbeats;
    const nearestIdx = (t) => truth.reduce((b, x, i) => (Math.abs(x - t) < Math.abs(truth[b] - t) ? i : b), 0);
    const onOne = down.filter((t) => nearestIdx(t) % 4 === 0).length;
    check('downbeats stay on the 1 through half-time parts', onOne / down.length > 0.9, `${onOne}/${down.length} on beat 1`);
    const live = liveEstimate(samples, sr);
    const lwrong = live.filter((r) => r.bpm != null && r.t > 8 && Math.abs(r.bpm - 128) > 3).length;
    check('live: half-time sections keep full tempo', lwrong === 0, `${lwrong}/${live.length} readings off by >3 BPM`);
  }

  // 10. a real tempo change without a pause (medley) must be followed, not suppressed
  {
    const { samples } = drumTrack({ sr, duration: 70, bpm: (t) => (t < 35 ? 100 : 140), eighths: true, seed: 31 });
    const a = analyzeAudio(samples, sr, { sections: false });
    const at = (lo, hi) => a.curve.bpm.filter((b, i) => b != null && a.curve.t[i] > lo && a.curve.t[i] < hi);
    const before = at(8, 30), after = at(48, 66);
    const ok = before.every((b) => Math.abs(b - 100) < 2) && after.length > 40 && after.every((b) => Math.abs(b - 140) < 2);
    check('offline follows 100 → 140 BPM change', ok, `before ${median(before).toFixed(1)}, after ${after.length ? median(after).toFixed(1) : 'none'} (${after.length} pts)`);
    const live = liveEstimate(samples, sr);
    const lafter = live.filter((p) => p.t > 52 && p.t < 68 && p.bpm != null);
    check('live follows 100 → 140 BPM change', lafter.length > 40 && lafter.every((p) => Math.abs(p.bpm - 140) < 2), `after ${lafter.length ? median(lafter.map((p) => p.bpm)).toFixed(1) : 'none'} (${lafter.length} pts)`);
  }

  // 11. downbeats: song starts with a 2-beat pickup, chords change every bar,
  //     and one odd 2/4 bar in the middle shifts the count
  {
    const C = [261.6, 329.6, 392], F = [349.2, 440, 523.3], Am = [220, 261.6, 329.6], G = [196, 246.9, 293.7];
    const prog = [C, F, Am, G];
    const bars = (n, from = 0) => Array.from({ length: n }, (_, k) => ({ chord: prog[(k + from) % 4], beats: 4, gain: 0.07 }));
    const parts = [{ chord: G, beats: 2, gain: 0.07 }, ...bars(14), { chord: G, beats: 2, gain: 0.07 }, ...bars(14, 1)];
    const { samples, boundaries } = songWithSections({ sr, bpm: 112, parts, jitterMs: 5 });
    const a = analyzeAudio(samples, sr, { sections: false });
    const truth = boundaries.filter((_, i) => parts[i].beats === 4);
    const rep = buildReport(a, { beatsPerBar: 4, barPhase: 'auto' });
    const found = rep.downbeats;
    const hit = truth.filter((t) => found.some((f) => Math.abs(f - t) < 0.06)).length;
    const wrong = found.filter((f) => !truth.some((t) => Math.abs(f - t) < 0.06)).length;
    check('downbeats found automatically', hit / truth.length > 0.85 && wrong <= 3, `${hit}/${truth.length} true downbeats, ${wrong} wrong`);
  }

  print(`\n${failures ? failures + ' FAILED' : 'all passed'} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main()
  .catch((e) => { failures++; print('ERROR', e.stack); })
  .finally(() => {
    writeFileSync(new URL('./last-run.log', import.meta.url), log.join('\n'));
    process.exitCode = failures ? 1 : 0;
  });
