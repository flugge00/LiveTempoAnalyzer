// Sessions tab: list, open, delete (with inline confirmation), export.

import { listSessions, deleteSession, getSession } from '../store/db.js';
import { tempoSummary } from '../dsp/stats.js';
import { beatTempo } from '../dsp/beats.js';
import { $, esc, toast, download, fmtBpm, fmtSigned, fmtDuration } from './dom.js';

export function initSessions() {
  async function refresh() {
    const list = await listSessions();
    $('sessEmpty').hidden = list.length > 0;
    $('sessTable').hidden = !list.length;
    if (!list.length) return;
    const rows = list.map((s) => {
      const sum = quickSummary(s);
      return `<tr data-id="${s.id}">
        <td><a href="#/session/${s.id}">${esc(s.name)}</a></td>
        <td>${new Date(s.created).toLocaleDateString()}</td>
        <td>${s.kind === 'live' ? 'Live' : 'File'}${s.hasAudio ? '' : ' <span class="muted small">(no audio)</span>'}</td>
        <td class="num">${fmtDuration(s.analysis?.duration ?? s.duration)}</td>
        <td class="num">${fmtBpm(sum?.mean)}</td>
        <td class="num">${sum ? fmtSigned(sum.drift) : '–'}</td>
        <td class="num"><button class="btn btn-small" data-act="export" type="button">Export</button>
          <button class="btn btn-small btn-danger" data-act="delete" type="button">Delete</button></td>
      </tr>`;
    }).join('');
    $('sessTable').innerHTML = `<thead><tr><th>Name</th><th>Date</th><th>Type</th><th class="num">Length</th><th class="num">Avg BPM</th><th class="num">Drift</th><th></th></tr></thead><tbody>${rows}</tbody>`;
  }

  $('sessTable').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    if (btn.dataset.act === 'delete') {
      // two-step confirm inside the button itself
      if (btn.dataset.armed) {
        await deleteSession(id);
        toast('Session deleted.');
        refresh();
      } else {
        btn.dataset.armed = '1';
        btn.textContent = 'Confirm delete';
        setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = 'Delete'; } }, 4000);
      }
    } else if (btn.dataset.act === 'export') {
      const s = await getSession(id);
      const { audio, ...rest } = s;
      download(`${s.name.replace(/[^\w\- ]+/g, '').trim() || 'session'}.json`, JSON.stringify(rest, null, 1), 'application/json');
    }
  });

  return { refresh };
}

function quickSummary(s) {
  if (s.analysis?.beats?.length > 16) return tempoSummary(beatTempo(s.analysis.beats));
  if (s.analysis) return tempoSummary(s.analysis.curve.t.map((t, i) => ({ t, bpm: s.analysis.curve.bpm[i] })));
  if (s.live) return tempoSummary(s.live.points);
  return null;
}
