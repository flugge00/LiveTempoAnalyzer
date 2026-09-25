// The live tempo pipeline without any browser APIs: feed it audio blocks, get
// tempo readings. Used by the microphone engine and by the tests, so the tests
// exercise exactly what runs on stage.

import { OnsetDetector } from '../dsp/onset.js';
import { TempoModel, TempoTracker, OctaveResolver } from '../dsp/tempo.js';

const UPDATE_SEC = 0.25;
const RESET_AFTER_SILENCE_SEC = 4;

export class LiveTempo {
  /**
   * @param {number} sampleRate
   * @param {{windowSec?:number, expectedBpm?:number, gateDb?:number}} o
   * @param {{onTempo:(p:{t,bpm,confidence})=>void, onRescale?:(factor:number, sinceT:number)=>void}} cb
   */
  constructor(sampleRate, o = {}, cb) {
    this.opts = { windowSec: 8, gateDb: -50, ...o };
    this.cb = cb;
    this.sr = sampleRate;
    this.detector = new OnsetDetector(sampleRate);
    this.model = new TempoModel(this.detector.fps, { windowSec: this.opts.windowSec, expectedBpm: this.opts.expectedBpm });
    this.tracker = new TempoTracker(this.model);
    this.resolver = new OctaveResolver({
      priorAt: (b) => this.model.priorAt(b),
      onRescale: (k) => this.cb.onRescale?.(k, this.takeStart),
      onNewTake: (t) => { this.takeStart = t; },
    });
    this.samplesIn = 0;
    this.nextUpdate = UPDATE_SEC;
    this.silentFor = 0;
    this.takeStart = null;
  }

  get time() { return this.samplesIn / this.sr; }

  /** Tempo hint (target tempo field): narrows the prior and starts a fresh take. */
  setExpectedBpm(bpm) {
    this.opts.expectedBpm = bpm || undefined;
    this.model.setExpected(bpm || undefined);
    this.tracker.reset();
    this.resolver.reset();
    this.takeStart = null;
  }

  /** The reading is off by factor f (x2 / ÷2 buttons): fix this take and keep it fixed. */
  forceOctave(f) { this.resolver.force(f); }

  push(block) {
    const det = this.detector;
    det.push(block);
    this.samplesIn += block.length;
    const t = this.time;
    if (t < this.nextUpdate) return;
    this.nextUpdate += UPDATE_SEC;
    const W = this.model.winFrames;
    // readings from less than ~5 s of audio are too unreliable to show
    if (det.envelope.length < Math.min(W, det.fps * 5)) return;

    // Is anyone playing? Use the loud part of the last 2 s.
    const recent = det.rms.slice(-Math.round(det.fps * 2)).sort((a, b) => a - b);
    const loudDb = 20 * Math.log10((recent[Math.floor(recent.length * 0.9)] || 0) + 1e-9);
    let point = { t, bpm: null, confidence: 0 };
    if (loudDb < this.opts.gateDb) {
      this.silentFor += UPDATE_SEC;
      if (this.silentFor >= RESET_AFTER_SILENCE_SEC) {
        // a new song may start with a different tempo
        this.tracker.reset();
        this.resolver.reset();
        this.takeStart = null;
      }
    } else {
      this.silentFor = 0;
      const env = Float64Array.from(det.envelope.slice(-W));
      const r = this.tracker.update(env);
      if (r) {
        this.takeStart ??= t;
        point = { t, bpm: this.resolver.push(t, r.bpm), confidence: r.confidence };
      }
    }
    // keep memory bounded
    if (det.envelope.length > W * 4) {
      det.envelope.splice(0, det.envelope.length - W * 2);
      det.rms.splice(0, det.rms.length - W * 2);
    }
    this.cb.onTempo(point);
  }
}
