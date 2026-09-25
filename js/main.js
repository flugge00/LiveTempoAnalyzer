// App entry: hash router wiring the three views together.

import { initLive } from './ui/live-view.js';
import { initAnalyze } from './ui/analysis-view.js';
import { initSessions } from './ui/sessions-view.js';
import { $ } from './ui/dom.js';

const live = initLive();
const analyze = initAnalyze();
const sessions = initSessions();

function route() {
  const [, name = 'live', arg] = location.hash.split('/');
  const view = name === 'session' ? 'analyze' : ['live', 'analyze', 'sessions'].includes(name) ? name : 'live';
  for (const v of ['live', 'analyze', 'sessions']) $(`view-${v}`).hidden = v !== view;
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.route === (name === 'session' ? 'sessions' : view)));

  if (name === 'session' && arg) analyze.openSession(arg);
  else if (view === 'analyze' && !analyze.isBusy()) analyze.reset();
  else if (view === 'sessions') sessions.refresh();
  else if (view === 'live') live.chart.draw();
}

window.addEventListener('hashchange', route);
route();

// ?demo opens the Analyze tab and runs the demo recording (handy for sharing and smoke tests)
if (new URLSearchParams(location.search).has('demo')) {
  location.hash = '#/analyze';
  $('demoBtn').click();
}
