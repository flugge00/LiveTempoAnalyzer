// App entry: hash router wiring the views together, session import, and the
// service worker (offline use / install as an app).

import { initLive } from './ui/live-view.js';
import { initAnalyze } from './ui/analysis-view.js';
import { initSessions } from './ui/sessions-view.js';
import { initCompare } from './ui/compare-view.js';
import { initTheme } from './ui/theme.js';
import { $, toast } from './ui/dom.js';
import { readSessionsFile, importSessions } from './store/share.js';
import * as db from './store/db.js';

initTheme();
const live = initLive();
const analyze = initAnalyze({ onImportFile: (f) => importFiles([f]) });
const sessions = initSessions({ onImportFiles: importFiles });
const compare = initCompare();

const VIEWS = ['live', 'analyze', 'sessions', 'compare'];

function route() {
  const [, name = 'live', arg] = location.hash.split('/');
  const view = name === 'session' ? 'analyze' : VIEWS.includes(name) ? name : 'live';
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  const tab = name === 'session' || view === 'compare' ? 'sessions' : view;
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.route === tab));

  if (name === 'session' && arg) analyze.openSession(arg);
  else if (view === 'compare') compare.open((arg || '').split(',').filter(Boolean));
  else if (view === 'analyze' && !analyze.isBusy()) analyze.reset();
  else if (view === 'sessions') sessions.refresh();
  else if (view === 'live') live.chart.draw();
}

async function importFiles(files) {
  const total = { added: 0, updated: 0, unchanged: 0, ids: [] };
  for (const f of files) {
    try {
      const res = await importSessions(await readSessionsFile(f), db);
      for (const k of ['added', 'updated', 'unchanged']) total[k] += res[k];
      total.ids.push(...res.ids);
    } catch (err) {
      console.error(err);
      toast(`${f.name}: ${err.message}`, 7000);
      return;
    }
  }
  db.requestPersistence();
  const parts = [];
  if (total.added) parts.push(`${total.added} new`);
  if (total.updated) parts.push(`${total.updated} updated`);
  if (total.unchanged) parts.push(`${total.unchanged} already up to date`);
  toast(`Imported ${total.ids.length} session${total.ids.length === 1 ? '' : 's'}: ${parts.join(', ')}.`, 5000);
  if (total.ids.length === 1) location.hash = `#/session/${total.ids[0]}`;
  else if (location.hash === '#/sessions') sessions.refresh();
  else location.hash = '#/sessions';
}

window.addEventListener('hashchange', route);
route();

// ?demo opens the Analyze tab and runs the demo recording (handy for sharing and smoke tests)
if (new URLSearchParams(location.search).has('demo')) {
  location.hash = '#/analyze';
  $('demoBtn').click();
}

// ---- offline support ------------------------------------------------------
// Not on localhost (so development always gets fresh files) unless ?sw is given.
const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
if ('serviceWorker' in navigator && (!local || new URLSearchParams(location.search).has('sw'))) {
  // A new version waits until the user says so: never reload in the middle of a recording.
  let reloadRequested = false;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (w) => {
      $('updateNotice').hidden = false;
      $('updateReload').onclick = () => { reloadRequested = true; w.postMessage('skipWaiting'); };
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
  }).catch((err) => console.warn('Service worker not registered', err));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloadRequested) return;
    reloadRequested = false;
    location.reload();
  });
}
