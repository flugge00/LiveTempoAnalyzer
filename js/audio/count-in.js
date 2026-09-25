// Count-in: a bar or two of clicks and/or on-screen flashes at a set tempo,
// then silence, so the band plays free (and the microphone doesn't keep
// hearing a click). Clicks are scheduled on the audio clock; the flashes follow
// the same clock so both line up.

/**
 * @param {{bpm:number, beatsPerBar:number, bars:number, click:boolean, ctx?:AudioContext,
 *          onBeat?:(beat:number, index:number, total:number)=>void, onDone?:()=>void}} o
 *   beat: 0-based position in the bar; ctx: reuse a running context (the live engine's)
 * @returns {{stop:()=>void, endsIn:number}} endsIn = seconds until the band comes in
 */
export function countIn(o) {
  const period = 60 / o.bpm, total = o.beatsPerBar * o.bars;
  let ctx = o.ctx, own = false;
  if (o.click && !ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctx({ latencyHint: 'interactive' });
    own = true;
  }
  ctx?.resume?.();
  const lead = 0.15; // scheduling headroom
  const now = () => (ctx ? ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0) : performance.now() / 1000);
  const t0 = (ctx ? ctx.currentTime : performance.now() / 1000) + lead;
  const nodes = [];

  if (o.click && ctx) {
    for (let k = 0; k < total; k++) {
      const t = t0 + k * period, one = k % o.beatsPerBar === 0;
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = one ? 1760 : 1320;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(one ? 0.9 : 0.6, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.08);
      nodes.push(osc);
    }
  }

  let shown = -1, raf = 0, stopped = false;
  const tick = () => {
    if (stopped) return;
    const k = Math.floor((now() - t0) / period + 1e-3);
    if (k >= total) { finish(); return; }
    if (k >= 0 && k !== shown) { shown = k; o.onBeat?.(k % o.beatsPerBar, k, total); }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  function finish() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    if (own) setTimeout(() => ctx.close().catch(() => {}), 200);
    o.onDone?.();
  }

  return {
    endsIn: lead + total * period,
    stop() {
      for (const n of nodes) { try { n.stop(); } catch { /* already stopped */ } }
      finish();
    },
  };
}
