// Sessions tab: list, open, delete (with inline confirmation), select several
// to compare or export, and import sessions shared by someone else.

import { listSessions, deleteSession, getSession } from '../store/db.js';
import { exportSessions, safeFileName } from '../store/share.js';
import { tempoSummary } from '../dsp/stats.js';
import { beatTempo } from '../dsp/beats.js';
import { $, esc, toast, download, fmtBpm, fmtSigned, fmtDuration } from './dom.js';

export function initSessions({ onImportFiles }) {
  const selected = new Set();

  async function refresh() {
    const list = await listSessions();
    for (const id of [...selected]) if (!list.some((s) => s.id === id)) selected.delete(id);
    $('sessEmpty').hidden = list.length > 0;
    $('sessTable').hidden = !list.length;
    $('sessSelHint').hidden = list.length < 2;
    updateTools();
    if (!list.length) return;
    const rows = list.map((s) => {
      const sum = quickSummary(s);
      return `<tr data-id="${s.id}"${selected.has(s.id) ? ' class="selected"' : ''}>
        <td class="check"><input type="checkbox" data-act="select" aria-label="Select ${esc(s.name)}"${selected.has(s.id) ? ' checked' : ''}></td>
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
    $('sessTable').innerHTML = `<thead><tr><th class="check"><input type="checkbox" data-act="all" aria-label="Select all"></th><th>Name</th><th>Date</th><th>Type</th><th class="num">Length</th><th class="num">Avg BPM</th><th class="num">Drift</th><th></th></tr></thead><tbody>${rows}</tbody>`;
    syncAll();
  }

  function updateTools() {
    const n = selected.size;
    $('sessCompare').disabled = n < 2;
    $('sessCompare').textContent = n >= 2 ? `Compare ${n}` : 'Compare';
    $('sessExport').disabled = n < 1;
    $('sessExport').textContent = n ? `Export ${n}` : 'Export selected';
  }

  function syncAll() {
    const all = $('sessTable').querySelector('input[data-act="all"]');
    const boxes = $('sessTable').querySelectorAll('tbody input[data-act="select"]');
    if (!all) return;
    all.checked = boxes.length > 0 && [...boxes].every((b) => b.checked);
    all.indeterminate = !all.checked && [...boxes].some((b) => b.checked);
  }

  $('sessTable').addEventListener('change', (e) => {
    const box = e.target.closest('input[type="checkbox"]');
    if (!box) return;
    const rows = box.dataset.act === 'all' ? [...$('sessTable').querySelectorAll('tbody tr')] : [box.closest('tr')];
    for (const tr of rows) {
      const on = box.checked;
      if (on) selected.add(tr.dataset.id); else selected.delete(tr.dataset.id);
      tr.classList.toggle('selected', on);
      tr.querySelector('input[data-act="select"]').checked = on;
    }
    syncAll();
    updateTools();
  });

  $('sessTable').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    if (btn.dataset.act === 'delete') {
      // two-step confirm inside the button itself
      if (btn.dataset.armed) {
        await deleteSession(id);
        selected.delete(id);
        toast('Session deleted.');
        refresh();
      } else {
        btn.dataset.armed = '1';
        btn.textContent = 'Confirm delete';
        setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = 'Delete'; } }, 4000);
      }
    } else if (btn.dataset.act === 'export') {
      await exportIds([id], btn);
    }
  });

  async function exportIds(ids, btn) {
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Packing…';
    try {
      const sessions = (await Promise.all(ids.map(getSession))).filter(Boolean);
      const name = sessions.length === 1 ? safeFileName(sessions[0].name) : `Tempo sessions ${new Date().toISOString().slice(0, 10)}`;
      download(`${name}.zip`, await exportSessions(sessions));
    } catch (err) {
      console.error(err);
      toast(`Export failed: ${err.message}`, 6000);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
      updateTools();
    }
  }

  $('sessCompare').onclick = () => { location.hash = `#/compare/${[...selected].join(',')}`; };
  $('sessExport').onclick = (e) => exportIds([...selected], e.currentTarget);
  $('importInput').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) onImportFiles(files);
  });
  const card = $('sessCard');
  card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('over'); });
  card.addEventListener('dragleave', () => card.classList.remove('over'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('over');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) onImportFiles(files);
  });

  return { refresh };
}

function quickSummary(s) {
  if (s.analysis?.beats?.length > 16) return tempoSummary(beatTempo(s.analysis.beats));
  if (s.analysis) return tempoSummary(s.analysis.curve.t.map((t, i) => ({ t, bpm: s.analysis.curve.bpm[i] })));
  if (s.live) return tempoSummary(s.live.points);
  return null;
}
