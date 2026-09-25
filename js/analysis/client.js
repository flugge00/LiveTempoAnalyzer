// Main-thread side of offline analysis: decode an audio file/blob and run the worker.

const ANALYSIS_SR = 22050; // plenty for rhythm and harmony; halves memory on long recordings

/** Decode any browser-supported audio (mp3, wav, m4a, webm...) to mono at ANALYSIS_SR. */
export async function decodeToMono(blob) {
  const buf = await blob.arrayBuffer();
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Offline(1, 1, ANALYSIS_SR); // decodeAudioData resamples to the context rate
  const audio = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(buf, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
  const n = audio.length, ch = audio.numberOfChannels;
  const mono = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / ch;
  }
  return { samples: mono, sampleRate: audio.sampleRate, duration: audio.duration };
}

let worker = null, nextId = 1;

/**
 * @param {Blob} blob
 * @param {object} opts analyzeAudio options
 * @param {(stage:string, fraction:number)=>void} onProgress
 */
export async function analyzeBlob(blob, opts, onProgress = () => {}) {
  onProgress('Decoding audio', 0);
  const { samples, sampleRate } = await decodeToMono(blob);
  worker ||= new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      if (e.data.id !== id) return;
      if (e.data.type === 'progress') onProgress(e.data.stage, e.data.fraction);
      else {
        worker.removeEventListener('message', onMsg);
        if (e.data.type === 'done') resolve(e.data.result);
        else reject(new Error(e.data.message));
      }
    };
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', (e) => reject(new Error(e.message || 'Analysis worker failed')), { once: true });
    worker.postMessage({ id, samples, sampleRate, opts }, [samples.buffer]);
  });
}
