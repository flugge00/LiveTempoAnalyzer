// Decode real recordings (mp3, m4a, ...) to raw mono 22.05 kHz float32 using a
// headless Chromium browser: the exact decoder the app uses. Node can't decode
// mp3 by itself. Output goes to test_audio/.cache/<name>.f32 for tests/real-audio.mjs.
//
//   node tools/decode-audio.mjs [files...]      (default: every file in test_audio/)
//
// Needs Edge or Chrome installed; set BROWSER=<path> if it isn't found.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { join, extname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const audioDir = join(root, 'test_audio'), cacheDir = join(audioDir, '.cache');
const files = process.argv.slice(2).length ? process.argv.slice(2).map((f) => resolve(f))
  : readdirSync(audioDir).filter((f) => /\.(mp3|m4a|aac|wav|ogg|flac|webm)$/i.test(f)).map((f) => join(audioDir, f));
mkdirSync(cacheDir, { recursive: true });

const browser = [process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));
if (!browser) throw new Error('No Edge/Chrome found; set BROWSER=<path>');

// tiny static server: a blank page plus the audio files
const server = createServer((req, res) => {
  const i = Number(new URL(req.url, 'http://x').searchParams.get('i'));
  if (req.url.startsWith('/audio')) { res.end(readFileSync(files[i])); return; }
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>decode</title>');
}).listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const port = 9222 + Math.floor(Math.random() * 500);
const proc = spawn(browser, ['--headless=new', '--no-first-run', `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'lta-decode-'))}`, `${base}/`], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page;
for (let i = 0; i < 100 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page' && t.url.startsWith(base)); } catch { /* not up yet */ }
  if (!page) await sleep(200);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); pending.delete(d.id); });
const ev = (expression) => new Promise((resolve, reject) => {
  const i = ++id;
  pending.set(i, (d) => (d.result?.exceptionDetails ? reject(new Error(d.result.exceptionDetails.exception?.description)) : resolve(d.result.result.value)));
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
});

try {
  // the target can show our URL before the document has actually committed
  for (let i = 0; i < 100 && (await ev('location.origin')) !== base; i++) await sleep(100);
  for (const [i, f] of files.entries()) {
    const n = await ev(`(async () => {
      const buf = await (await fetch('/audio?i=${i}')).arrayBuffer();
      const a = await new OfflineAudioContext(1, 1, 22050).decodeAudioData(buf);
      const m = new Float32Array(a.length);
      for (let c = 0; c < a.numberOfChannels; c++) { const d = a.getChannelData(c); for (let k = 0; k < m.length; k++) m[k] += d[k] / a.numberOfChannels; }
      window.pcm = m; return m.length; })()`);
    const parts = [];
    for (let s = 0; s < n; s += 1 << 20) {
      const len = Math.min(1 << 20, n - s);
      const b64 = await ev(`(() => { const u = new Uint8Array(window.pcm.buffer, ${s * 4}, ${len * 4}); let o = '';
        for (let k = 0; k < u.length; k += 32768) o += String.fromCharCode.apply(null, u.subarray(k, k + 32768)); return btoa(o); })()`);
      parts.push(Buffer.from(b64, 'base64'));
    }
    const out = join(cacheDir, basename(f, extname(f)) + '.f32');
    writeFileSync(out, Buffer.concat(parts));
    console.log(`${basename(f)}: ${(n / 22050).toFixed(1)} s -> ${out}`);
  }
} finally {
  ws.close();
  proc.kill();
  server.close();
}
