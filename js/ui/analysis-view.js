// Analyze tab + session inspection: file upload, progress, report, chart,
// editable sections table, bar-timing profile, playback synced to the chart.

import { analyzeBlob, decodeToMono } from '../analysis/client.js';
import { splitSession, canSplitAt, suggestSongBreak, partHint } from '../analysis/split.js';
import { encodeWav } from '../audio/wav.js';
import { ANALYSIS_VERSION } from '../analysis/analyze.js';
import { fmtTime } from '../analysis/report.js';
import { sessionReport, trimOf, trimPoints, normaliseTrim, MIN_TRIM_SEC } from '../analysis/trim.js';
import { effectiveSections, editable, snapToBeat, sectionAt, canSplit, split, joinNext, colorIndexes, SECTION_NAMES } from '../analysis/sections.js';
import { TimeChart } from './chart.js';
import { $, esc, toast, download, fmtBpm, fmtSigned, fmtMs, fmtDuration, driftStatus, statusBadge, legend } from './dom.js';
import { saveSession, getSession, deleteSession, newId, requestPersistence } from '../store/db.js';
import { exportSessions, safeFileName } from '../store/share.js';

export function initAnalyze({ onImportFile } = {}) {
  const chart = new TimeChart($('resChart'), {
    wheelZoom: true,
    sectionEdit: { snap: (t) => snapToBeat(session?.analysis?.beats, t) },
    trimEdit: { snap: (t) => snapToBeat(session?.analysis?.beats, t, 0.5), minSec: MIN_TRIM_SEC },
  });
  const audio = $('resAudio');
  let session = null, report = null, series = [], audioUrl = null, busy = false;
  let cursor = null; // playhead / edit position (s), also without audio

  // ---- file input / drag & drop ---------------------------------------
  const drop = $('dropZone');
  const isSessionFile = (f) => /\.(zip|json)$/i.test(f.name) || /zip|json/.test(f.type);
  $('fileInput').addEventListener('change', (e) => e.target.files[0] && openFile(e.target.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const files = [...(e.dataTransfer?.files || [])];
    const shared = files.find(isSessionFile);
    if (shared && onImportFile) { onImportFile(shared); return; }
    const f = files.find((x) => x.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac|webm)$/i.test(x.name));
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
    if (isSessionFile(file) && onImportFile) { onImportFile(file); return; }
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
        settings: { beatsPerBar: 4, barPhase: 'auto', targetBpm: null },
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
    const outdated = s.analysis && (s.analysis.version || 1) < ANALYSIS_VERSION;
    if (s.audio && (!s.analysis || outdated)) {
      try {
        if (outdated) showProgress('Updating the analysis to the latest version', 0);
        s.analysis = await runAnalysis(s.audio, {
          expectedBpm: s.analysis?.options?.expectedBpm || s.settings?.targetBpm || undefined,
          beatsPerBar: s.settings?.beatsPerBar,
        });
        // the old default was "bar starts on beat 1"; downbeats are found automatically now
        if (outdated && s.settings && !s.settings.barPhase) s.settings.barPhase = 'auto';
        await saveSession(s);
      } catch (err) {
        console.error(err);
        toast(`Detailed analysis failed: ${err.message}. ${s.analysis ? 'Showing the previous analysis.' : 'Showing the live readings only.'}`, 6000);
      }
    }
    render();
  }

  function reset() {
    setTrimMode(false);
    session = null; report = null;
    audio.pause();
    $('result').hidden = true;
    $('progress').hidden = true;
    drop.hidden = false;
    $('fileInput').value = '';
  }

  // ---- rendering ------------------------------------------------------
  function render() {
    const s = session, a = s.analysis, st = s.settings || (s.settings = { beatsPerBar: 4, barPhase: 'auto' });
    drop.hidden = true;
    $('result').hidden = false;
    $('resTitle').value = s.name;
    $('resMeta').textContent = [
      new Date(s.created).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
      fmtDuration(a?.duration ?? s.duration),
      s.kind === 'live' ? 'live session' : s.fileName || 'file',
    ].join(' · ');

    setTrimMode(false);
    renderReport();
    chart.resetZoom();

    // bar controls
    const bpbSel = $('resBpb'), phSel = $('resPhase');
    bpbSel.innerHTML = [2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}">${n}</option>`).join('');
    bpbSel.value = st.beatsPerBar;
    phSel.innerHTML = (a?.accent ? '<option value="auto">Auto</option>' : '') +
      Array.from({ length: st.beatsPerBar }, (_, i) => `<option value="${i}">${i + 1}</option>`).join('');
    phSel.value = report.autoBars ? 'auto' : String(st.barPhase === 'auto' ? 0 : st.barPhase);
    phSel.title = report.autoBars ? 'The "1" of each bar is found automatically. Play the recording to check the beat counter.' : '';
    bpbSel.disabled = phSel.disabled = !a;

    renderSections();
    renderProfile();
    setupAudio();
    $('splitPanel').hidden = true;
    const dur = a?.duration ?? s.duration ?? 0;
    $('resSplit').hidden = !(s.audio || s.live?.points?.length) || dur < 20;
  }

  /** Report, insights, tiles and chart data (without touching zoom or playback). */
  function renderReport() {
    const s = session, a = s.analysis, st = s.settings;
    report = sessionReport(s);
    const sum = report.summary;
    const tr = trimOf(s);
    $('resTrim').hidden = !tr || trimMode;
    if (tr) $('resTrim').textContent = `Only ${fmtTime(tr.start)}–${fmtTime(tr.end)} counts`;
    updateTrimPanel();

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
      series.push({ id: 'live', name: 'Live tempo', color: '--line-main', gapSec: 1.1, points: (s.live?.points || []).map((p) => ({ t: p.t, v: p.bpm })) });
    }
    const target = st.targetBpm;
    const reference = target ? { value: target, band: target * 0.02, label: `Target ${target}` }
      : sum ? { value: sum.start, band: sum.start * 0.02, label: `Start ${sum.start.toFixed(1)} ±2%` } : null;
    chart.setData({
      series,
      sections: chartSections(),
      markers: s.live?.markers || [],
      reference,
      levels: a?.levels || null,
      duration: a?.duration ?? s.duration,
      trim: tr,
    });
    if (series.length > 1) legend($('resLegend'), series, () => chart.draw());
    else $('resLegend').innerHTML = '';
  }

  // ---- trim: leave out the start / end ----------------------------------
  // Trim mode shows the Start / End handles on the chart and the trim panel.
  let trimMode = false;
  const fullLength = () => session.analysis?.duration ?? session.duration ?? 0;
  const currentTrim = () => trimOf(session) ?? { start: 0, end: fullLength() };

  function setTrimMode(on) {
    trimMode = !!on && !!session;
    chart.setTrimMode(trimMode);
    $('trimPanel').hidden = !trimMode;
    $('resTrimBtn').setAttribute('aria-pressed', String(trimMode));
    $('resTrim').hidden = trimMode || !trimOf(session || {});
    if (!trimMode) return;
    $('splitPanel').hidden = true;
    updateTrimPanel();
    $('trimPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /** Range text and button states; `live` is the range while a handle is being dragged. */
  function updateTrimPanel(live) {
    if (!trimMode) return;
    const dur = fullLength(), tr = live ?? currentTrim();
    $('trimRange').textContent = `Counts: ${fmtTime(tr.start)} – ${fmtTime(tr.end)} (${fmtDuration(tr.end - tr.start)} of ${fmtDuration(dur)})`;
    $('trimReset').disabled = !trimOf(session) && !live;
    const okStart = cursor != null && cursor < tr.end - MIN_TRIM_SEC;
    const okEnd = cursor != null && cursor > tr.start + MIN_TRIM_SEC;
    $('trimStartHere').disabled = !okStart;
    $('trimEndHere').disabled = !okEnd;
    $('trimStartHere').textContent = okStart ? `Start at ${fmtTime(cursor)}` : 'Start at playhead';
    $('trimEndHere').textContent = okEnd ? `End at ${fmtTime(cursor)}` : 'End at playhead';
    const hint = cursor == null ? 'Click the chart or play the recording to place the playhead' : `Keep at least ${MIN_TRIM_SEC} s`;
    $('trimStartHere').title = okStart ? '' : hint;
    $('trimEndHere').title = okEnd ? '' : hint;
  }

  async function setTrim(tr) {
    const t = normaliseTrim(tr, fullLength());
    if (t) session.trim = t; else delete session.trim;
    await saveSession(session);
    renderReport();
    renderSections();
    renderProfile();
  }
  chart.addEventListener('trim', (e) => setTrim(e.detail));
  chart.addEventListener('trimming', (e) => updateTrimPanel(e.detail));
  $('resTrimBtn').onclick = () => setTrimMode(!trimMode);
  $('trimDone').onclick = () => setTrimMode(false);
  $('trimStartHere').onclick = () => { if (cursor != null) setTrim({ start: cursor, end: currentTrim().end }); };
  $('trimEndHere').onclick = () => { if (cursor != null) setTrim({ start: currentTrim().start, end: cursor }); };
  $('trimReset').onclick = () => { setTrim(null); toast('The whole recording counts again.'); };

  function chartSections() {
    const list = report.sections || [];
    const colors = colorIndexes(list);
    return list.map((x, i) => ({ ...x, colorIndex: colors[i] }));
  }

  // ---- sections: table, rename, split / join / drag -----------------------
  async function saveSections(list, { rerender = true } = {}) {
    session.sections = list.map(({ start, end, label, name, take }) => ({ start, end, label, name, take }));
    delete session.sectionNames;
    await saveSession(session);
    if (rerender) refreshSections();
  }

  /** Re-derive the report after a section edit, without resetting zoom or playback. */
  function refreshSections() {
    report = sessionReport(session);
    $('insights').innerHTML = report.insights.map((i) => `<li>${esc(i)}</li>`).join('');
    chart.setData({ sections: chartSections() });
    renderSections();
  }

  chart.addEventListener('sections', (e) => saveSections(e.detail));

  function renderSections() {
    const secs = report.sections || [];
    $('secCard').hidden = !secs.length;
    $('secReset').hidden = !session.sections;
    const colors = colorIndexes(secs);
    const cur = cursor == null ? -1 : sectionAt(secs, cursor);
    const tr = trimOf(session);
    const rows = secs.map((s, i) => {
      const sm = s.summary;
      const out = tr && (s.end <= tr.start + 0.5 || s.start >= tr.end - 0.5);
      return `<tr class="clickable${i === cur ? ' current' : ''}${out ? ' trimmed' : ''}" data-i="${i}"${out ? ' title="Left out: outside the part that counts"' : ''}>
        <td><span class="swatch" style="background:var(--series-${(colors[i] % 8) + 1})"></span></td>
        <td><input class="name" data-i="${i}" value="${esc(s.name)}" list="secNameList" aria-label="Section name"></td>
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
    $('secTable').innerHTML = secs.length ? `<thead><tr><th></th><th>Section</th><th class="num">Start</th><th class="num">Length</th><th class="num">Bars</th>
      <th class="num">Avg BPM</th><th class="num">Drift</th><th class="num">Steadiness</th><th class="num">Jitter</th><th class="num">Attack spread</th></tr></thead><tbody>${rows}</tbody>` : '';
    const used = [...new Set([...SECTION_NAMES, ...secs.map((s) => s.name.replace(/\s+\d+$/, ''))])];
    $('secNameList').innerHTML = used.map((n) => `<option value="${esc(n)}">`).join('');
    updateSectionTools();
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
      inp.addEventListener('change', () => {
        const list = editable(session);
        const i = +inp.dataset.i;
        list[i].name = inp.value.trim() || list[i].name;
        saveSections(list);
      });
    });
  }

  function updateSectionTools() {
    const secs = report?.sections || [];
    const cur = cursor == null ? -1 : sectionAt(secs, cursor);
    const splitOk = cursor != null && canSplit(secs, cursor);
    $('secSplit').disabled = !splitOk;
    $('secSplit').title = splitOk ? `Split "${secs[cur].name}" at ${fmtTime(cursor)}` : 'Click the chart where the new section should start';
    $('secJoin').disabled = cur < 0 || cur >= secs.length - 1;
    $('secJoin').title = cur >= 0 && cur < secs.length - 1 ? `Join "${secs[cur].name}" with "${secs[cur + 1].name}"` : 'Click a section (or the chart) first';
    $('secTable').querySelectorAll('tr.clickable').forEach((tr) => tr.classList.toggle('current', +tr.dataset.i === cur));
  }

  $('secSplit').onclick = () => {
    if (cursor == null) return;
    const t = snapToBeat(session.analysis?.beats, cursor);
    saveSections(split(editable(session), canSplit(effectiveSections(session), t) ? t : cursor));
  };
  $('secJoin').onclick = () => {
    const list = editable(session);
    saveSections(joinNext(list, sectionAt(list, cursor)));
  };
  $('secReset').onclick = async () => {
    delete session.sections;
    delete session.sectionNames;
    await saveSession(session);
    refreshSections();
    toast('Sections reset to the automatic ones.');
  };

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
    const st = session.settings;
    st.beatsPerBar = +e.target.value;
    if (st.barPhase !== 'auto') st.barPhase = Math.min(st.barPhase, st.beatsPerBar - 1);
    await saveSession(session);
    render();
  });
  $('resPhase').addEventListener('change', async (e) => {
    session.settings.barPhase = e.target.value === 'auto' ? 'auto' : +e.target.value;
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
        session.analysis = await runAnalysis(session.audio, { expectedBpm: expected, beatsPerBar: session.settings.beatsPerBar });
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
    cursor = null;
    $('resPlay').hidden = !session.audio;
    $('resTime').textContent = '';
    $('resBeat').hidden = true;
    chart.setPlayhead(null);
    updateSectionTools();
    if (!session.audio) { audio.removeAttribute('src'); return; }
    audioUrl = URL.createObjectURL(session.audio);
    audio.src = audioUrl;
    $('resPlay').textContent = '▶ Play';
  }
  function seek(t) {
    cursor = t;
    chart.setPlayhead(t);
    $('resTime').textContent = fmtTime(t);
    updateSectionTools();
    updateSplit();
    updateTrimPanel();
    if (session?.audio) audio.currentTime = t;
  }
  chart.addEventListener('seek', (e) => {
    if (!session) return;
    seek(e.detail);
    if (session.audio && audio.paused) audio.play().catch(() => {});
  });
  $('resPlay').onclick = () => (audio.paused ? audio.play().catch((e) => toast(`Cannot play: ${e.message}`)) : audio.pause());
  audio.addEventListener('play', () => { $('resPlay').textContent = '❚❚ Pause'; tick(); });
  audio.addEventListener('pause', () => { $('resPlay').textContent = '▶ Play'; $('resBeat').hidden = true; });
  let lastSec = -1;
  function tick() {
    if (audio.paused) return;
    const t = audio.currentTime;
    cursor = t;
    chart.setPlayhead(t);
    $('resTime').textContent = `${fmtTime(t)} / ${fmtTime(session.analysis?.duration ?? session.duration)}`;
    showBeat(t);
    const sec = sectionAt(report.sections || [], t);
    if (sec !== lastSec) { lastSec = sec; updateSectionTools(); }
    if (!$('splitPanel').hidden) updateSplit();
    updateTrimPanel();
    requestAnimationFrame(tick);
  }

  /** Beat counter while playing, to check by ear where the "1" is. */
  function showBeat(t) {
    const beats = session.analysis?.beats, pos = report.positions?.pos;
    const el = $('resBeat');
    if (!beats?.length || !pos) { el.hidden = true; return; }
    let lo = 0, hi = beats.length - 1;
    if (t < beats[0] - 0.05) { el.hidden = true; return; }
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (beats[m] <= t + 0.03) lo = m; else hi = m; }
    const i = beats[hi] <= t + 0.03 ? hi : lo;
    const gap = (beats[i + 1] ?? beats[i] + 1) - beats[i];
    if (pos[i] < 0 || t - beats[i] > Math.min(1.5, 1.5 * gap)) { el.hidden = true; return; }
    const bpb = session.settings.beatsPerBar;
    if (el.childElementCount !== bpb) el.innerHTML = Array.from({ length: bpb }, (_, k) => `<span>${k + 1}</span>`).join('');
    [...el.children].forEach((c, k) => c.classList.toggle('on', k === pos[i]));
    el.hidden = false;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && trimMode && !$('view-analyze').hidden) { setTrimMode(false); return; }
    if (e.code !== 'Space' || $('view-analyze').hidden || !session?.audio) return;
    if (/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName)) return;
    e.preventDefault();
    $('resPlay').click();
  });

  // ---- split into two songs ---------------------------------------------
  // The playhead marks where the second song starts. The audio is cut and
  // stored as WAV (browsers can't write mp3/webm), and each part is analyzed
  // on its own; the two new sessions replace this one.
  function updateSplit() {
    if ($('splitPanel').hidden) return;
    const ok = cursor != null && canSplitAt(session, cursor);
    $('splitAt').textContent = cursor == null ? '–' : fmtTime(cursor);
    $('splitGo').disabled = !ok || busy;
    $('splitGo').title = ok ? '' : 'Click the chart where the second song starts';
  }

  $('resSplit').onclick = () => {
    const dur = session.analysis?.duration ?? session.duration;
    $('splitName1').value = session.name;
    $('splitName1').placeholder = `${session.name} (1)`;
    $('splitName2').value = '';
    $('splitName2').placeholder = `${session.name} (2)`;
    setTrimMode(false);
    $('splitPanel').hidden = false;
    if (cursor == null || !canSplitAt(session, cursor)) {
      const t = suggestSongBreak(session.analysis) ?? dur / 2;
      audio.pause();
      seek(t);
      chart.setView(Math.max(0, t - 45), Math.min(dur, t + 45));
    }
    updateSplit();
    $('splitPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  $('splitCancel').onclick = () => { $('splitPanel').hidden = true; };

  $('splitGo').onclick = async () => {
    if (busy || cursor == null || !canSplitAt(session, cursor)) return;
    const old = session, t = cursor;
    const parts = splitSession(old, t, { ids: [newId(), newId()], names: [$('splitName1').value, $('splitName2').value] });
    audio.pause();
    busy = true;
    $('result').hidden = true;
    try {
      if (old.audio) {
        showProgress('Cutting the recording', 0);
        const { samples, sampleRate } = await decodeToMono(old.audio, 44100);
        const cut = Math.round(t * sampleRate);
        parts[0].audio = encodeWav(samples.subarray(0, cut), sampleRate);
        parts[1].audio = encodeWav(samples.subarray(cut), sampleRate);
        const ranges = [[0, t], [t, Infinity]];
        for (const [k, p] of parts.entries()) {
          p.analysis = await analyzeBlob(p.audio, { expectedBpm: partHint(old.analysis, ...ranges[k]), beatsPerBar: p.settings?.beatsPerBar },
            (stage, f) => showProgress(`Song ${k + 1} of 2: ${stage}`, f));
          p.duration = p.analysis.duration;
        }
      }
      for (const p of parts) await saveSession(p);
      await deleteSession(old.id);
      toast(`Split into "${parts[0].name}" and "${parts[1].name}".`, 5000);
      location.hash = `#/session/${parts[0].id}`;
    } catch (err) {
      console.error(err);
      toast(`Could not split the recording: ${err.message || err}`, 7000);
      $('result').hidden = false;
    } finally {
      busy = false;
      $('progress').hidden = true;
    }
  };

  // ---- export -----------------------------------------------------------
  $('resExport').onclick = async () => {
    const btn = $('resExport');
    btn.disabled = true;
    try {
      download(`${safeFileName(session.name)}.zip`, await exportSessions([session]));
    } catch (err) {
      toast(`Export failed: ${err.message}`, 6000);
    } finally {
      btn.disabled = false;
    }
  };
  $('resExportCsv').onclick = () => {
    const secAt = (t) => { const i = sectionAt(report.sections || [], t); return i < 0 ? '' : report.sections[i].name.replace(/"/g, "'"); };
    let csv;
    if (session.analysis) {
      const spread = new Map(session.analysis.beats.map((t, i) => [t, session.analysis.spreadMs[i]]));
      const barPos = new Map(session.analysis.beats.map((t, i) => [t, report.positions.pos[i]]));
      csv = 'time_s,local_bpm,offset_ms,attack_spread_ms,beat_in_bar,section\n' + report.beatPts
        .map((p) => [p.t.toFixed(3), p.bpm.toFixed(2), p.residualMs.toFixed(1), spread.get(p.t) ?? '', (barPos.get(p.t) ?? -1) + 1 || '', `"${secAt(p.t)}"`].join(',')).join('\n');
    } else {
      csv = 'time_s,bpm,confidence\n' + trimPoints(session.live.points, trimOf(session)).map((p) => [p.t, p.bpm ?? '', p.c].join(',')).join('\n');
    }
    download(`${safeFileName(session.name)}.csv`, csv, 'text/csv');
  };

  return { openSession, reset, chart, isBusy: () => busy, openFile };
}
