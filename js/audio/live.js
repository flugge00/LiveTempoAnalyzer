// Live microphone engine: capture -> LiveTempo pipeline.
// Emits 'tempo' ({t, bpm|null, confidence}), 'rescale' ({factor, since}),
// 'level' ({db}) and 'state' events.

import { LiveTempo } from '../analysis/live-tempo.js';

export class LiveEngine extends EventTarget {
  constructor() {
    super();
    this.running = false;
  }

  /**
   * @param {{deviceId?:string, expectedBpm?:number, windowSec?:number, gateDb?:number, recordAudio?:boolean}} o
   */
  async start(o = {}) {
    if (this.running) return;
    this.opts = { windowSec: 8, gateDb: -50, ...o };
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: o.deviceId ? { exact: o.deviceId } : undefined,
        // processing meant for speech destroys drum transients
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    await this.ctx.resume();
    await this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;
    this.source.connect(this.node).connect(this.mute).connect(this.ctx.destination);

    const sr = this.ctx.sampleRate;
    this.pipeline = new LiveTempo(sr, this.opts, {
      onTempo: (p) => this._emit('tempo', p),
      onRescale: (factor, since) => this._emit('rescale', { factor, since }),
    });
    this.node.port.onmessage = (e) => this._onBlock(e.data);

    this.chunks = [];
    this.recorder = null;
    if (o.recordAudio && window.MediaRecorder) {
      try {
        const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported?.(t));
        this.recorder = new MediaRecorder(this.stream, type ? { mimeType: type, audioBitsPerSecond: 96000 } : undefined);
        this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
        this.recorder.start(5000);
      } catch (err) {
        console.warn('Audio recording unavailable', err);
        this.recorder = null;
      }
    }

    try { this.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
    this.running = true;
    this.startedAt = Date.now();
    this._emit('state', { running: true, sampleRate: sr, recording: !!this.recorder });
  }

  /** Change the target-tempo hint while running. */
  setExpectedBpm(bpm) {
    this.opts.expectedBpm = bpm || undefined;
    this.pipeline?.setExpectedBpm(bpm);
  }

  /** The reading is off by factor f (×2 / ÷2 buttons). Emits 'rescale' for the current take. */
  forceOctave(f) { this.pipeline?.forceOctave(f); }

  set gateDb(db) { this.opts.gateDb = db; if (this.pipeline) this.pipeline.opts.gateDb = db; }

  _onBlock(block) {
    let e = 0;
    for (let i = 0; i < block.length; i++) e += block[i] * block[i];
    this._emit('level', { db: 10 * Math.log10(e / block.length + 1e-12) });
    this.pipeline.push(block);
  }

  /** Stops capture. Resolves with the recorded audio blob (or null). */
  async stop() {
    if (!this.running) return null;
    this.running = false;
    let blob = null;
    if (this.recorder && this.recorder.state !== 'inactive') {
      blob = await new Promise((resolve) => {
        this.recorder.onstop = () => resolve(new Blob(this.chunks, { type: this.recorder.mimeType || 'audio/webm' }));
        this.recorder.stop();
      });
    }
    this.node.port.onmessage = null;
    this.stream.getTracks().forEach((tr) => tr.stop());
    await this.ctx.close();
    try { await this.wakeLock?.release(); } catch { /* ignore */ }
    this._emit('state', { running: false });
    return blob;
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

export async function listInputs() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}
