// A synthetic "band" recording for trying the app without a real one:
// 100 BPM song that creeps up over time, with choruses played a little faster.

import { songWithSections } from './demo-synth.js';

export function makeDemoFile() {
  const sr = 22050;
  const C = [261.6, 329.6, 392], F = [349.2, 440, 523.3], Am = [220, 261.6, 329.6], G = [196, 246.9, 293.7];
  const verse = { chord: C, beats: 32 };
  const chorus = { chord: F, beats: 32, bright: true, gain: 0.12, bpmOffset: 2.5 };
  const parts = [
    { chord: G, beats: 16, gain: 0.05 }, verse, chorus, verse, chorus,
    { chord: Am, beats: 32, gain: 0.06, bpmOffset: -1 }, chorus, { chord: G, beats: 16, gain: 0.05 },
  ];
  const { samples } = songWithSections({ sr, bpm: (t) => 100 + (4 * t) / 150, parts, jitterMs: 7 });
  return new File([encodeWav(samples, sr)], 'Demo – drifting band.wav', { type: 'audio/wav' });
}

function encodeWav(samples, sr) {
  const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const g = peak > 0.99 ? 0.99 / peak : 1;
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.round(samples[i] * g * 32767), true);
  return buf;
}
