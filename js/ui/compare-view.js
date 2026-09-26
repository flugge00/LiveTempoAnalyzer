// Compare view: several takes of the same song (picked on the Sessions tab)
// overlaid on one chart, plus a take-by-take table: "are we getting steadier?"

import { analyzeBlob } from '../analysis/client.js';
import { sessionReport, trimOf, trimPoints } from '../analysis/trim.js';
import { TimeChart } from './chart.js';
import { $, esc, toast, fmtBpm, fmtSigned, fmtMs, fmtDuration, legend } from './dom.js';
import { getSession, saveSession } from '../store/db.js';

export function initCompare() {
  const chart = new TimeChart($('cmpChart'), { wheelZoom: true });
  let takes = [], relative = false, loadedKey = null, busy = false;

  async function open(idList) {
    const key = idList.join(',');
    if (key === loadedKey && takes.length) { $('cmpResult').hidden = false; chart.draw(); return; }
    if (busy) return;
    busy = true;
    loadedKey = null;
    $('cmpResult').hidden = true;
    try {
      const sessions = (await Promise.all(idList.map(getSession))).filter(Boolean);
      if (sessions.length < 2) { toast('Pick at least two sessions to compare.'); location.hash = '#/sessions'; return; }
      sessions.sort((a, b) => a.created - b.created);
      // live sessions get their detailed analysis the first time they're needed
      for (const [k, s] of sessions.entries()) {
        if (s.analysis || !s.audio) continue;
        const label = `Analyzing "${s.name}" (${k + 1} of ${sessions.length})`;
        try {
          s.analysis = await analyzeBlob(s.audio, { expectedBpm: s.settings?.targetBpm || undefined }, (stage, f) => progress(`${label}: ${stage.toLowerCase()}`, f));
          await saveSession(s);
        } catch (err) {
          console.error(err);
          toast(`Could not analyze "${s.name}": ${err.message}. Using its live readings.`, 6000);
        }
      }
      takes = sessions.map((s, i) => makeTake(s, i));
      loadedKey = key;
      render();
    } finally {
      busy = false;
      $('cmpProgress').hidden = true;
    }
  }

  function progress(text, f) {
    $('cmpProgress').hidden = false;
    $('cmpProgressFill').style.width = `${Math.round(f * 100)}%`;
    $('cmpProgressText').textContent = `${text}…`;
  }

  function makeTake(s, i) {
    // only the trimmed part counts, and takes line up where it starts
    const a = s.analysis, tr = trimOf(s);
    const report = sessionReport(s);
    let points, t0;
    if (a) {
      points = trimPoints(a.curve.t.map((t, k) => ({ t, v: a.curve.bpm[k] })), tr);
      t0 = trimPoints(a.beats.map((t) => ({ t })), tr)[0]?.t ?? firstValid(points, (a.options?.windowSec ?? 8) / 2);
    } else {
      points = trimPoints((s.live?.points || []).map((p) => ({ t: p.t, v: p.bpm })), tr);
      t0 = firstValid(points, 4);
    }
    return { session: s, report, t0, points, color: `--series-${(i % 8) + 1}` };
  }

  function render() {
    $('cmpResult').hidden = false;
    $('cmpTitle').textContent = `Compare ${takes.length} takes`;
    const series = takes.map((k) => {
      const ref = relative ? k.report.summary?.start ?? 0 : 0;
      return {
        id: k.session.id, name: `${k.session.name} · ${new Date(k.session.created).toLocaleDateString()}`,
        color: k.color, gapSec: 1.1, width: 2,
        points: k.points.filter((p) => p.t >= k.t0).map((p) => ({ t: p.t - k.t0, v: p.v == null ? null : p.v - ref })),
      };
    });
    const duration = Math.max(...series.map((s) => s.points.at(-1)?.t ?? 0));
    chart.o.unit = relative ? 'BPM vs start' : 'BPM';
    chart.setData({ series, sections: [], markers: [], levels: null, duration,
      reference: relative ? { value: 0, band: 0, label: 'Start tempo' } : null });
    chart.resetZoom();
    legend($('cmpLegend'), series, () => chart.draw());
    $('cmpAbs').setAttribute('aria-pressed', String(!relative));
    $('cmpRel').setAttribute('aria-pressed', String(relative));
    renderTable();
    $('cmpInsights').innerHTML = insights().map((t) => `<li>${esc(t)}</li>`).join('');
  }

  function renderTable() {
    const rows = takes.map((k) => {
      const s = k.session, sum = k.report.summary;
      return `<tr>
        <td><span class="swatch line" style="background:var(${k.color})"></span></td>
        <td><a href="#/session/${s.id}">${esc(s.name)}</a></td>
        <td>${new Date(s.created).toLocaleDateString()}</td>
        <td class="num">${fmtDuration(sum?.duration)}</td>
        <td class="num">${fmtBpm(sum?.mean)}</td>
        <td class="num">${sum ? `${fmtBpm(sum.start)} → ${fmtBpm(sum.end)}` : '–'}</td>
        <td class="num">${sum ? fmtSigned(sum.drift) : '–'}</td>
        <td class="num">${sum?.slopePerMin != null ? fmtSigned(sum.slopePerMin, 2) : '–'}</td>
        <td class="num">${sum?.sd != null ? '±' + sum.sd.toFixed(1) : '–'}</td>
        <td class="num">${fmtMs(k.report.jitterMs)}</td>
        <td class="num">${fmtMs(k.report.spreadMs)}</td>
      </tr>`;
    }).join('');
    $('cmpTable').innerHTML = `<thead><tr><th></th><th>Take</th><th>Date</th><th class="num">Length</th><th class="num">Avg BPM</th><th class="num">Start → end</th>
      <th class="num">Drift</th><th class="num">Trend /min</th><th class="num">Steadiness</th><th class="num">Jitter</th><th class="num">Attack spread</th></tr></thead><tbody>${rows}</tbody>`;
  }

  function insights() {
    const ok = takes.filter((k) => k.report.summary);
    if (ok.length < 2) return ['Not enough steady rhythm in these takes to compare them.'];
    const out = [];
    const first = ok[0], last = ok[ok.length - 1];
    const name = (k) => `"${k.session.name}"`;
    const fs = first.report.summary, ls = last.report.summary;
    if (fs.sd != null && ls.sd != null) {
      const d = ls.sd - fs.sd;
      out.push(Math.abs(d) < 0.2
        ? `Steadiness about the same from the first take to the latest (±${fs.sd.toFixed(1)} → ±${ls.sd.toFixed(1)} BPM).`
        : `${d < 0 ? 'Steadier' : 'Less steady'} than before: ±${fs.sd.toFixed(1)} BPM in the first take, ±${ls.sd.toFixed(1)} in the latest.`);
    }
    const ad = (k) => Math.abs(k.report.summary.drift);
    if (Math.abs(ad(last) - ad(first)) >= 0.5) {
      out.push(`Drift ${ad(last) < ad(first) ? 'shrank' : 'grew'} from ${fmtSigned(fs.drift)} to ${fmtSigned(ls.drift)} BPM (start to end of the song).`);
    }
    const steadiest = [...ok].filter((k) => k.report.summary.sd != null).sort((a, b) => a.report.summary.sd - b.report.summary.sd)[0];
    if (steadiest && ok.length > 2) out.push(`Steadiest take: ${name(steadiest)} (±${steadiest.report.summary.sd.toFixed(1)} BPM).`);
    const jit = ok.filter((k) => k.report.jitterMs != null);
    if (jit.length >= 2) {
      const a = jit[0].report.jitterMs, b = jit[jit.length - 1].report.jitterMs;
      if (Math.abs(b - a) >= 2) out.push(`Timing jitter ${b < a ? 'dropped' : 'rose'} from ${a.toFixed(0)} ms to ${b.toFixed(0)} ms (${b < a ? 'tighter' : 'looser'}).`);
    }
    const means = ok.map((k) => k.report.summary.mean);
    const lo = Math.min(...means), hi = Math.max(...means);
    if (hi - lo >= 2) out.push(`The takes were played at different tempos (${lo.toFixed(1)}–${hi.toFixed(1)} BPM). "Change from start" compares their drift directly.`);
    return out;
  }

  $('cmpAbs').onclick = () => { relative = false; render(); };
  $('cmpRel').onclick = () => { relative = true; render(); };
  $('cmpFit').onclick = () => chart.resetZoom();

  return { open, chart };
}

function firstValid(points, back) {
  const p = points.find((x) => x.v != null);
  return p ? Math.max(0, p.t - back) : 0;
}
