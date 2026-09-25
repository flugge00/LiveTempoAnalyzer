// Sharing sessions between devices: export one or more sessions (with their
// audio) as a .zip, and import such a zip (or an older .json export) again.
//
// Zip layout:
//   live-tempo-analyzer.json          {app, format, exported, sessions: [dir, ...]}
//   <dir>/session.json                the stored session without its audio blob
//   <dir>/audio.<ext>                 the recording, if there is one

import { makeZip, readZip } from './zip.js';

export const APP_ID = 'live-tempo-analyzer';
const FORMAT = 1;

const EXT = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/aac': 'aac' };
const MIME = { webm: 'audio/webm', m4a: 'audio/mp4', mp4: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac' };

export const safeFileName = (name) => String(name || '').replace(/[^\w\- ]+/g, '').trim() || 'session';

function audioExt(s) {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(s.fileName || '')?.[1]?.toLowerCase();
  if (fromName && MIME[fromName]) return fromName;
  return EXT[(s.audio?.type || '').split(';')[0]] || 'webm';
}

/** @param {object[]} sessions full sessions (with audio blobs) @returns {Promise<Blob>} */
export async function exportSessions(sessions) {
  const files = [], dirs = [];
  const used = new Set();
  for (const s of sessions) {
    let dir = `${safeFileName(s.name).slice(0, 60)} ${s.id}`;
    while (used.has(dir)) dir += '_';
    used.add(dir);
    dirs.push(dir);
    const { audio, ...rest } = s;
    const audioFile = audio ? `audio.${audioExt(s)}` : null;
    files.push({ name: `${dir}/session.json`, data: JSON.stringify({ ...rest, audioFile, audioType: audio?.type || null }) });
    if (audio) files.push({ name: `${dir}/${audioFile}`, data: audio });
  }
  files.unshift({ name: `${APP_ID}.json`, data: JSON.stringify({ app: APP_ID, format: FORMAT, exported: new Date().toISOString(), sessions: dirs }, null, 1) });
  return makeZip(files);
}

/**
 * Reads sessions from an exported .zip or .json file.
 * @param {File|Blob} file
 * @returns {Promise<object[]>} sessions ready to store (audio as Blob where present)
 */
export async function readSessionsFile(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  if (!isZip) {
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error('This is neither a session export (.zip) nor a session .json file.'); }
    const list = Array.isArray(data) ? data : [data];
    return list.map((s) => validate(s, file.name || 'This file'));
  }
  const entries = await readZip(file);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const jsons = entries.filter((e) => /(^|\/)session\.json$/.test(e.name));
  if (!jsons.length) throw new Error('This zip does not contain any Live Tempo Analyzer sessions.');
  const out = [];
  for (const e of jsons) {
    const s = validate(JSON.parse(await e.text()), e.name);
    const dir = e.name.slice(0, e.name.length - 'session.json'.length);
    const audioEntry = s.audioFile && byName.get(dir + s.audioFile);
    if (audioEntry) {
      const ext = s.audioFile.split('.').pop().toLowerCase();
      const raw = await audioEntry.blob();
      s.audio = new Blob([raw], { type: s.audioType || MIME[ext] || 'audio/webm' });
    }
    delete s.audioFile;
    delete s.audioType;
    out.push(s);
  }
  return out;
}

function validate(s, where) {
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id || !isFinite(s.created) || !(s.live || s.analysis)) {
    throw new Error(`${where} is not a Live Tempo Analyzer session.`);
  }
  const { report, hasAudio, ...rest } = s; // report: extra data in older JSON exports
  rest.name = String(rest.name || 'Imported session');
  rest.kind = rest.kind === 'live' ? 'live' : 'file';
  return rest;
}

/**
 * Stores imported sessions. A session that already exists is replaced only if
 * the imported copy was changed more recently.
 * @param {object[]} sessions
 * @param {{getSession, saveSession}} db
 */
export async function importSessions(sessions, db) {
  const res = { added: 0, updated: 0, unchanged: 0, ids: [] };
  for (const s of sessions) {
    const cur = await db.getSession(s.id);
    const when = (x) => x.modified ?? x.created;
    if (cur && when(cur) >= when(s)) { res.unchanged++; res.ids.push(s.id); continue; }
    if (cur && !s.audio && cur.audio) s.audio = cur.audio; // don't lose audio to a JSON-only update
    await db.saveSession(s, { keepModified: true });
    res[cur ? 'updated' : 'added']++;
    res.ids.push(s.id);
  }
  return res;
}
