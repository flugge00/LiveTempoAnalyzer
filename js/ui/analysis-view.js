// Analyze tab + session inspection: file upload, progress, report, chart,
// sections table, bar-timing profile, playback synced to the chart.

import { analyzeBlob } from '../analysis/client.js';
import { buildReport, liveReport, fmtTime } from '../analysis/report.js';
import { TimeChart } from './chart.js';
import { $, esc, toast, download, fmtBpm, fmtSigned, fmtMs, fmtDuration, driftStatus, statusBadge, legend } from './dom.js';
import { saveSession, getSession, newId, requestPersistence } from '../store/db.js';

export function initAnalyze() {
  const chart = new TimeChart($('resChart'), { wheelZoom: true });
  const audio = $('resAudio');
  let session = null, report = null, series = [], audioUrl = null, busy = false;

  // ---- file input / drag & drop ---------------------------------------
  const drop = $('dropZone');
  $('fileInput').addEventListener('change', (e) => e.target.files[0] && openFile(e.target.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac|webm)$/i.test(x.name));
    if (f) openFile(f); else toast('That does not look like an audio file.');
  });
  $('resNew').onclick = () => { location.hash = '#/analyze'; };
  $('demoBtn').onclick = async () => {
    const { makeDemoFile } = await import('../analysis/demo.js');
    showProgress('Generating demo recording', 0);
    await new Promise((r) => setTimeout(r, 30)); // let the progress bar paint
    openFile(makeDemoFile());
  };

  function showProgress(stage, fraction) {
    $('progress').hidden = false;
    $('progressFill').style.width = `${Math.round(fraction * 100)}%`;
    $('progressText').textContent = `${stage}…`;
  }

  async function runAnalysis(blob, opts) {
    busy = true;
    try {
      return await analyzeBlob(blob, opts, showProgress);
    } finally {
      busy = false;
      $('progress').hidden = true;
    }
  }

  async function openFile(file) {
    if (busy) return;
    $('result').hidden = true;
    drop.hidden = true;
    try {
      const hint = parseFloat($('fileHint').value) || undefined;
      const analysis = await runAnalysis(file, { expectedBpm: hint });
      const created = Date.now();
      session = {
        id: newId(),
        name: file.name.replace(/\.[^.]+$/, ''),
        created,
        kind: 'file',
        duration: analysis.duration,
        analysis,
        settings: { beatsPerBar: 4, barPhase: 0, targetBpm: null },
        audio: file,
        fileName: file.name,
      };
      try { await saveSession(session); requestPersistence(); } catch (err) { toast(`Analysis done, but saving failed: ${err.message}`, 6000); }
      history.replaceState(null, '', `#/session/${session.id}`);
      render();
    } catch (err) {
      console.error(err);
      drop.hidden = false;
      toast(`Could not analyze this file: ${err.message || err}. Formats your browser can play (mp3, wav, m4a…) are supported.`, 7000);
    }
  }

  async function openSession(id) {
    if (session?.id === id && report) { drop.hidden = true; $('result').hidden = false; chart.draw(); return; }
    drop.hidden = true;
    $('result').hidden = true;
    const s = await getSession(id);
    if (!s) { toast('Session not found.'); location.hash = '#/sessions'; return; }
    session = s;
    if (s.audio && !s.analysis) {
      try {
        s.analysis = await runAnalysis(s.audio, { expectedBpm: s.settings?.targetBpm || undefined });
        await saveSession(s);
      } catch (err) {
        console.error(err);
        toast(`Detailed analysis failed: ${err.message}. Showing the live readings only.`, 6000);
      }
    }
    render();
  }

  function reset() {
    session = null; report = null;
    audio.pause();
    $('result').hidden = true;
    $('progress').hidden = true;
    drop.hidden = false;
    $('fileInput').value = '';
  }

  // ---- rendering ------------------------------------------------------
  function render() {
    const s = session, a = s.analysis, st = s.settings || (s.settings = { beatsPerBar: 4, barPhase: 0 });
    drop.hidden = true;
    $('result').hidden = false;
    $('resTitle').value = s.name;
    $('resMeta').textContent = [
      new Date(s.created).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
      fmtDuration(a?.duration ?? s.duration),
      s.kind === 'live' ? 'live session' : s.fileName || 'file',
    ].join(' · ');

    const livePts = (s.live?.points || []).map((p) => ({ t: p.t, bpm: p.bpm }));
    report = a ? buildReport(a, st) : liveReport(livePts);
    const sum = report.summary;

    $('insights').innerHTML = report.insights.map((i) => `<li>${esc(i)}</li>`).join('');

    // tiles
    const tiles = [];
    const tile = (label, value, sub = '') => tiles.push(`<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div><div class="tile-sub">${sub}</div></div>`);
    if (sum) {
      const ds = driftStatus(sum.driftPct);
      tile('Average tempo', fmtBpm(sum.mean), `range ${fmtBpm(sum.p05)}–${fmtBpm(sum.p95)}`);
      tile('Drift start → end', fmtSigned(sum.drift), `${statusBadge(ds)} ${fmtSigned(sum.driftPct)}% · ${fmtBpm(sum.start)} → ${fmtBpm(sum.end)}`);
      tile('Trend', fmtSigned(sum.slopePerMin, 2), 'BPM per minute');
      tile('Steadiness', `±${sum.sd?.toFixed(1) ?? '–'}`, 'BPM standard deviation');
    }
    $('resTiles').innerHTML = tiles.join('');

    // chart
    series = [];
    if (a) {
      series.push({ id: 'curve', name: 'Tempo (8 s window)', color: '--line-main', gapSec: 1,
        points: a.curve.t.map((t, i) => ({ t, v: a.curve.bpm[i] })) });
      if (report.bars.length) {
        series.push({ id: 'bars', name: 'Per-bar tempo', color: '--line-bars', style: 'dots',
          points: report.bars.map((b) => ({ t: (b.t + b.end) / 2, v: b.bpm })) });
      }
    } else {
      series.push({ id: 'live', name: 'Live tempo', color: '--line-main', gapSec: 1.1, points: livePts.map((p) => ({ t: p.t, v: p.bpm })) });
    }
    const target = st.targetBpm;
    const reference = target ? { value: target, band: target * 0.02, label: `Target ${target}` }
      : sum ? { value: sum.start, band: sum.start * 0.02, label: `Start ${sum.start.toFixed(1)} ±2%` } : null;
    chart.setData({
      series,
      sections: report.sections?.map((x, i) => ({ ...x, name: sectionName(i), colorIndex: x.label.charCodeAt(0) - 65 })) || [],
      markers: s.live?.markers || [],
      reference,
      levels: a?.levels || null,
      duration: a?.duration ?? s.duration,
    });
    chart.resetZoom();
    if (series.length > 1) legend($('resLegend'), series, () => chart.draw());
    else $('resLegend').innerHTML = '';

    // bar controls
    const bpbSel = $('resBpb'), phSel = $('resPhase');
    bpbSel.innerHTML = [2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}">${n}</option>`).join('');
    bpbSel.value = st.beatsPerBar;
    phSel.innerHTML = Array.from({ length: st.beatsPerBar }, (_, i) => `<option value="${i}">${i + 1}</option>`).join('');
    phSel.value = st.barPhase;
    bpbSel.disabled = phSel.disabled = !a;

    renderSections();
    renderProfile();
    setupAudio();
  }

  function sectionName(i) {
    return session.sectionNames?.[i] ?? report.sections[i].name;
  }

  function renderSections() {
    const secs = report.sections || [];
    $('secCard').hidden = !secs.length;
    if (!secs.length) return;
    const multiTake = new Set(secs.map((s) => s.take)).size > 1;
    const rows = secs.map((s, i) => {
      const sm = s.summary;
      return `<tr class="clickable" data-i="${i}">
        <td><span class="swatch" style="background:var(--series-${((s.label.charCodeAt(0) - 65) % 8) + 1})"></span></td>
        <td><input class="name" data-i="${i}" value="${esc(sectionName(i))}" aria-label="Section name"> <span class="muted small">${s.label}</span></td>
        ${multiTake ? `<td class="num">${s.take}</td>` : ''}
        <td class="num">${fmtTime(s.start)}</td>
        <td class="num">${fmtDuration(s.end - s.start)}</td>
        <td class="num">${s.bars || '–'}</td>
        <td class="num">${fmtBpm(sm?.mean)}</td>
        <td class="num">${sm ? fmtSigned(sm.end - sm.start) : '–'}</td>
        <td class="num">${sm?.sd != null ? '±' + sm.sd.toFixed(1) : '–'}</td>
        <td class="num">${fmtMs(s.jitterMs)}</td>
        <td class="num">${fmtMs(s.spreadMs)}</td>
      </tr>`;
    }).join('');
    $('secTable').innerHTML = `<thead><tr><th></th><th>Section</th>${multiTake ? '<th class="num">Song</th>' : ''}<th class="num">Start</th><th class="num">Length</th><th class="num">Bars</th>
      <th class="num">Avg BPM</th><th class="num">Drift</th><th class="num">Steadiness</th><th class="num">Jitter</th><th class="num">Attack spread</th></tr></thead><tbody>${rows}</tbody>`;
    $('secTable').querySelectorAll('tr.clickable').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        const s = secs[+tr.dataset.i];
        const pad = (s.end - s.start) * 0.08;
        chart.setView(Math.max(0, s.start - pad), s.end + pad);
        seek(s.start);
      });
    });
    $('secTable').querySelectorAll('input.name').forEach((inp) => {
      inp.addEventListener('change', async () => {
        session.sectionNames = { ...(session.sectionNames || {}), [inp.dataset.i]: inp.value.trim() || report.sections[+inp.dataset.i].name };
        await saveSession(session);
        chart.setData({ sections: report.sections.map((x, i) => ({ ...x, name: sectionName(i), colorIndex: x.label.charCodeAt(0) - 65 })) });
      });
    });
  }

  function renderProfile() {
    const prof = report.profile || [];
    $('profileCard').hidden = !prof.length || !report.bars?.length;
    if (!prof.length) return;
    const maxAbs = Math.max(10, ...prof.map((p) => Math.abs(p.meanMs)));
    $('profile').innerHTML = prof.map((p) => {
      const w = (Math.abs(p.meanMs) / maxAbs) * 50;
      const left = p.meanMs < 0 ? 50 - w : 50;
      return `<div class="profile-row"><span>Beat ${p.position}</span>
        <div class="profile-track" title="±${p.sdMs.toFixed(1)} ms spread"><div class="profile-bar" style="left:${left}%;width:${Math.max(0.5, w)}%"></div></div>
        <span class="num">${fmtSigned(p.meanMs, 1)} ms</span></div>`;
    }).join('') + `<div class="profile-scale"><span></span><span><span>−${maxAbs.toFixed(0)} ms early</span><span>late +${maxAbs.toFixed(0)} ms</span></span><span></span></div>`;
    $('timingTiles').innerHTML = `
      <div class="tile"><div class="tile-label">Timing jitter</div><div class="tile-value">${fmtMs(report.jitterMs)}</div><div class="tile-sub">beats vs smooth grid (RMS)</div></div>
      <div class="tile"><div class="tile-label">Attack spread</div><div class="tile-value">${fmtMs(report.spreadMs)}</div><div class="tile-sub">median; lower = tighter together</div></div>`;
  }

  // ---- bar settings, octave fix ----------------------------------------
  $('resBpb').addEventListener('change', async (e) => {
    session.settings.beatsPerBar = +e.target.value;
    session.settings.barPhase = Math.min(session.settings.barPhase, session.settings.beatsPerBar - 1);
    await saveSession(session);
    render();
  });
  $('resPhase').addEventListener('change', async (e) => {
    session.settings.barPhase = +e.target.value;
    await saveSession(session);
    render();
  });
  $('resTitle').addEventListener('change', async (e) => {
    session.name = e.target.value.trim() || session.name;
    await saveSession(session);
  });

  async function octave(f) {
    if (!session || busy) return;
    const med = report.summary?.median;
    if (!med) return;
    if (session.audio) {
      const expected = Math.round(med * f);
      $('result').hidden = true;
      try {
        session.analysis = await runAnalysis(session.audio, { expectedBpm: expected });
        session.settings.targetBpm ||= null;
        await saveSession(session);
      } catch (err) { toast(`Re-analysis failed: ${err.message}`); }
      render();
      toast(`Re-analyzed around ${expected} BPM`);
    } else {
      for (const p of session.live.points) if (p.bpm != null) p.bpm *= f;
      await saveSession(session);
      render();
    }
  }
  $('resHalf').onclick = () => octave(0.5);
  $('resDouble').onclick = () => octave(2);

  $('zoomIn').onclick = () => chart.zoomBy(0.5, audio.src && !audio.paused ? audio.currentTime : undefined);
  $('zoomOut').onclick = () => chart.zoomBy(2);
  $('zoomReset').onclick = () => chart.resetZoom();

  // ---- playback -------------------------------------------------------
  function setupAudio() {
    audio.pause();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = null;
    $('resPlay').hidden = !session.audio;
    $('resTime').textContent = '';
    chart.setPlayhead(null);
    if (!session.audio) { audio.removeAttribute('src'); return; }
    audioUrl = URL.createObjectURL(session.audio);
    audio.src = audioUrl;
    $('resPlay').textContent = '▶ Play';
  }
  function seek(t) {
    if (!session?.audio) return;
    audio.currentTime = t;
    chart.setPlayhead(t);
    $('resTime').textContent = fmtTime(t);
  }
  chart.addEventListener('seek', (e) => {
    if (!session?.audio) return;
    seek(e.detail);
    if (audio.paused) audio.play().catch(() => {});
  });
  $('resPlay').onclick = () => (audio.paused ? audio.play().catch((e) => toast(`Cannot play: ${e.message}`)) : audio.pause());
  audio.addEventListener('play', () => { $('resPlay').textContent = '❚❚ Pause'; tick(); });
  audio.addEventListener('pause', () => { $('resPlay').textContent = '▶ Play'; });
  function tick() {
    if (audio.paused) return;
    chart.setPlayhead(audio.currentTime);
    $('resTime').textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(session.analysis?.duration ?? session.duration)}`;
    requestAnimationFrame(tick);
  }
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || $('view-analyze').hidden || !session?.audio) return;
    if (/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName)) return;
    e.preventDefault();
    $('resPlay').click();
  });

  // ---- export -----------------------------------------------------------
  const safeName = () => (session?.name || 'session').replace(/[^\w\- ]+/g, '').trim() || 'session';
  $('resExportJson').onclick = () => {
    const { audio: _a, ...rest } = session;
    download(`${safeName()}.json`, JSON.stringify({ ...rest, report: { summary: report.summary, insights: report.insights } }, null, 1), 'application/json');
  };
  $('resExportCsv').onclick = () => {
    const secAt = (t) => { const i = (report.sections || []).findIndex((s) => t >= s.start && t < s.end); return i < 0 ? '' : sectionName(i); };
    let csv;
    if (session.analysis) {
      const spread = new Map(session.analysis.beats.map((t, i) => [t, session.analysis.spreadMs[i]]));
      csv = 'time_s,local_bpm,offset_ms,attack_spread_ms,section\n' + report.beatPts
        .map((p) => [p.t.toFixed(3), p.bpm.toFixed(2), p.residualMs.toFixed(1), spread.get(p.t) ?? '', `"${secAt(p.t)}"`].join(',')).join('\n');
    } else {
      csv = 'time_s,bpm,confidence\n' + session.live.points.map((p) => [p.t, p.bpm ?? '', p.c].join(',')).join('\n');
    }
    download(`${safeName()}.csv`, csv, 'text/csv');
  };

  return { openSession, reset, chart, isBusy: () => busy };
}
