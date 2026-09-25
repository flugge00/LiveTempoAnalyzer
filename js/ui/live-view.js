// Live tab: start/stop, big BPM readout, drift tiles and the moving graph.

import { LiveEngine, listInputs } from '../audio/live.js';
import { TimeChart } from './chart.js';
import { $, esc, toast, fmtBpm, fmtSigned, fmtDuration, driftStatus, statusBadge, prefs } from './dom.js';
import { median, sd, slope } from '../dsp/stats.js';
import { saveSession, newId, requestPersistence } from '../store/db.js';

export function initLive() {
  const engine = new LiveEngine();
  const chart = new TimeChart($('liveChart'), { follow: { windowSec: 120 } });
  let points = [], markers = [], timer = null, t0Wall = 0, lastLevel = -120, meterRaf = null;
  const series = [{ id: 'live', name: 'Tempo', color: '--line-main', points, endDot: true, gapSec: 1.1 }];

  // ---- settings ------------------------------------------------------
  const S = {
    target: $('setTarget'), tol: $('setTol'), win: $('setWindow'), gate: $('setGate'),
    device: $('setDevice'), record: $('setRecord'), view: $('liveWindow'),
  };
  S.target.value = prefs.get('target', '') || '';
  S.tol.value = prefs.get('tol', '2');
  S.win.value = prefs.get('window', '8');
  S.gate.value = prefs.get('gate', -50);
  S.record.checked = prefs.get('record', true);
  S.view.value = prefs.get('view', '120');
  $('setGateVal').textContent = S.gate.value;

  const target = () => parseFloat(S.target.value) || null;
  const persist = () => {
    prefs.set('target', S.target.value); prefs.set('tol', S.tol.value); prefs.set('window', S.win.value);
    prefs.set('gate', +S.gate.value); prefs.set('record', S.record.checked); prefs.set('view', S.view.value);
    prefs.set('device', S.device.value);
  };
  for (const el of Object.values(S)) el.addEventListener('change', () => { persist(); applyReference(); });
  S.gate.addEventListener('input', () => { $('setGateVal').textContent = S.gate.value; engine.gateDb = +S.gate.value; });
  S.target.addEventListener('change', () => { if (engine.running) engine.setExpectedBpm(target()); });
  S.view.addEventListener('change', applyView);

  async function refreshDevices() {
    const devs = await listInputs();
    const cur = prefs.get('device', '');
    S.device.innerHTML = '<option value="">Default input</option>' +
      devs.filter((d) => d.deviceId && d.deviceId !== 'default')
        .map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Microphone ' + (i + 1))}</option>`).join('');
    S.device.value = [...S.device.options].some((o) => o.value === cur) ? cur : '';
  }
  refreshDevices();

  function applyReference() {
    const tg = target();
    chart.setData({ reference: tg ? { value: tg, band: (tg * +S.tol.value) / 100, label: `Target ${tg}` } : null });
    $('tDriftLabel').textContent = tg ? 'Off target' : 'Drift since start';
  }

  function applyView() {
    const w = +S.view.value;
    chart.setFollow(w ? { windowSec: w } : null);
    if (!w) chart.setData({ duration: 0 });
  }

  chart.addEventListener('view', (e) => { $('liveFollow').hidden = !(engine.running && e.detail.zoomed && !e.detail.following); });
  $('liveFollow').onclick = applyView;

  // ---- start / stop --------------------------------------------------
  const btn = $('liveStart');
  btn.onclick = async () => {
    if (engine.running) return stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('Microphone access needs a secure (https) page and a modern browser.');
      return;
    }
    btn.disabled = true;
    try {
      points.length = 0; markers = [];
      chart.setData({ series, markers, duration: 0 });
      applyReference(); applyView();
      await engine.start({
        deviceId: S.device.value || undefined,
        expectedBpm: target() || undefined,
        windowSec: +S.win.value,
        gateDb: +S.gate.value,
        recordAudio: S.record.checked,
      });
      refreshDevices(); // labels become available after permission
      requestPersistence();
    } catch (err) {
      console.error(err);
      toast(err?.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in the browser settings and try again.' : `Could not start the microphone: ${err?.message || err}`, 6000);
    } finally {
      btn.disabled = false;
    }
  };

  engine.addEventListener('state', (e) => {
    const on = e.detail.running;
    btn.classList.toggle('on', on);
    btn.querySelector('.label').textContent = on ? 'Stop' : 'Start';
    for (const id of ['liveMark', 'liveHalf', 'liveDouble']) $(id).disabled = !on;
    if (on) {
      t0Wall = performance.now();
      $('liveSaved').hidden = true;
      $('liveStatus').textContent = 'Listening… the first reading appears after a few seconds of playing.';
      timer = setInterval(() => ($('liveTimer').textContent = fmtDuration((performance.now() - t0Wall) / 1000)), 500);
    } else {
      clearInterval(timer);
      $('liveMeter').style.width = '0';
    }
  });

  engine.addEventListener('level', (e) => {
    lastLevel = e.detail.db;
    if (meterRaf) return;
    meterRaf = requestAnimationFrame(() => {
      meterRaf = null;
      const m = $('liveMeter');
      m.style.width = `${Math.max(0, Math.min(100, ((lastLevel + 60) / 60) * 100))}%`;
      m.classList.toggle('hot', lastLevel > -9);
      m.classList.toggle('clip', lastLevel > -1);
    });
  });

  // The tracker decided the current song's readings were at the wrong metrical
  // level (e.g. half tempo): correct what's already on screen for this take.
  engine.addEventListener('rescale', (e) => {
    const { factor, since } = e.detail;
    for (const p of points) if (p.v != null && p.t >= (since ?? 0) - 0.01) p.v *= factor;
    chart.draw();
    updateStats();
  });

  engine.addEventListener('tempo', (e) => {
    const { t, bpm, confidence } = e.detail;
    points.push({ t, v: bpm, c: confidence });
    chart.draw();
    updateStats();
  });

  function updateStats() {
    const valid = points.filter((p) => p.v != null);
    const last = points[points.length - 1];
    if (!valid.length) {
      $('liveBpm').textContent = '–';
      return;
    }
    const now = median(valid.slice(-4).map((p) => p.v));
    $('liveBpm').textContent = last.v == null ? '–' : fmtBpm(now);

    const tFirst = valid[0].t, tNow = last.t;
    const haveStart = tNow - tFirst >= 15;
    const start = haveStart ? median(valid.filter((p) => p.t <= tFirst + 15).map((p) => p.v)) : null;
    $('tStart').textContent = haveStart ? fmtBpm(start) : '…';

    const tg = target();
    const ref = tg || start;
    if (ref && last.v != null) {
      const d = now - ref, pct = (d / ref) * 100, st = driftStatus(pct);
      $('tDrift').textContent = fmtSigned(d);
      $('tDriftSub').innerHTML = `${statusBadge(st)} ${fmtSigned(pct)}% · ${st.word}`;
      $('liveStatus').innerHTML = `${statusBadge(st)} ${st.word === 'steady' ? 'On tempo' : st.word === 'rushing' ? 'Faster than ' + (tg ? 'target' : 'start') : 'Slower than ' + (tg ? 'target' : 'start')} (${fmtSigned(d)} BPM)`;
    } else if (last.v == null) {
      $('liveStatus').textContent = 'No steady beat detected (quiet, or between songs).';
    } else {
      $('liveStatus').textContent = 'Measuring start tempo…';
    }

    const recent60 = valid.filter((p) => p.t >= tNow - 60);
    const span60 = recent60.length ? tNow - recent60[0].t : 0;
    const tr = span60 >= 20 ? slope(recent60.map((p) => p.t / 60), recent60.map((p) => p.v)) : null;
    $('tTrend').textContent = tr == null ? '…' : fmtSigned(tr, 2);
    const recent30 = valid.filter((p) => p.t >= tNow - 30).map((p) => p.v);
    const s = recent30.length > 8 ? sd(recent30) : null;
    $('tSteady').textContent = s == null ? '…' : `±${s.toFixed(1)}`;
  }

  // ---- markers & octave ---------------------------------------------
  function mark() {
    if (!engine.running) return;
    const t = points.length ? points[points.length - 1].t : 0;
    markers.push({ t, label: `M${markers.length + 1}` });
    chart.setData({ markers });
    toast(`Marker M${markers.length} at ${fmtDuration(t)}`, 1500);
  }
  $('liveMark').onclick = mark;
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'm' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) mark();
  });
  const octave = (f) => {
    const cur = median(points.filter((p) => p.v != null).slice(-8).map((p) => p.v));
    if (!cur) return;
    engine.forceOctave(f);
    toast(`Corrected to ~${Math.round(cur * f)} BPM for this song`, 2000);
  };
  $('liveHalf').onclick = () => octave(0.5);
  $('liveDouble').onclick = () => octave(2);

  async function stop() {
    btn.disabled = true;
    try {
      const blob = await engine.stop();
      const valid = points.filter((p) => p.v != null);
      if (!valid.length && !blob) { toast('Nothing recorded.'); return; }
      const created = Date.now();
      const session = {
        id: newId(),
        name: `Rehearsal ${new Date(created).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`,
        created,
        kind: 'live',
        duration: points.length ? points[points.length - 1].t : 0,
        live: { points: points.map((p) => ({ t: +p.t.toFixed(2), bpm: p.v == null ? null : +p.v.toFixed(2), c: +(p.c || 0).toFixed(2) })), markers },
        settings: { beatsPerBar: 4, barPhase: 0, targetBpm: target() },
        audio: blob || null,
      };
      try {
        await saveSession(session);
        const n = $('liveSaved');
        n.innerHTML = `<span>Session saved (${fmtDuration(session.duration)}).</span><a class="btn btn-primary" href="#/session/${session.id}">Open detailed analysis →</a>`;
        n.hidden = false;
      } catch (err) {
        console.error(err);
        toast(`Could not save the session: ${err.message}`, 6000);
      }
    } finally {
      btn.disabled = false;
    }
  }

  applyReference();
  return { chart };
}
