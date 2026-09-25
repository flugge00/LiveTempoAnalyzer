// Web Worker wrapper around analyzeAudio so the UI stays responsive.
import { analyzeAudio } from './analyze.js';

self.onmessage = (e) => {
  const { id, samples, sampleRate, opts } = e.data;
  try {
    const result = analyzeAudio(samples, sampleRate, opts, (stage, fraction) => {
      self.postMessage({ id, type: 'progress', stage, fraction });
    });
    self.postMessage({ id, type: 'done', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message || String(err) });
  }
};
