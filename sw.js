// Service worker: makes the app work offline and installable.
//
// Every app file is cached on install, and pages are served from the cache
// first. The deploy workflow replaces __BUILD__ with the commit, so each deploy
// installs a fresh cache. The page then offers "Reload" to switch over
// (see js/main.js). tests/run.mjs checks that FILES lists every file in js/.

const BUILD = '__BUILD__';
const CACHE = `lta-${BUILD}`;
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'js/main.js',
  'js/analysis/analyze.js',
  'js/analysis/client.js',
  'js/analysis/demo-synth.js',
  'js/analysis/demo.js',
  'js/analysis/live-tempo.js',
  'js/analysis/report.js',
  'js/analysis/sections.js',
  'js/analysis/split.js',
  'js/analysis/trim.js',
  'js/analysis/worker.js',
  'js/audio/capture-worklet.js',
  'js/audio/count-in.js',
  'js/audio/live.js',
  'js/audio/wav.js',
  'js/dsp/beats.js',
  'js/dsp/downbeat.js',
  'js/dsp/fft.js',
  'js/dsp/onset.js',
  'js/dsp/segment.js',
  'js/dsp/stats.js',
  'js/dsp/tempo.js',
  'js/store/db.js',
  'js/store/share.js',
  'js/store/zip.js',
  'js/ui/analysis-view.js',
  'js/ui/chart.js',
  'js/ui/compare-view.js',
  'js/ui/dom.js',
  'js/ui/live-view.js',
  'js/ui/sessions-view.js',
  'js/ui/theme.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('lta-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // navigations (with ?demo, #/…) all get the app page
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' }) || (req.mode === 'navigate' && await cache.match('index.html'));
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  })());
});
