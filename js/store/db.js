// Session storage in IndexedDB (stays on this device/browser).
//
// session = {
//   id, name, created (ms), kind: 'live' | 'file', duration,
//   live?: { points: [{t, bpm, c}], markers: [{t, label}] },
//   analysis?: <analyzeAudio result>,
//   settings: { beatsPerBar, barPhase: 'auto' | number, targetBpm },
//   sections?: [{start, end, label, name, take}],  // user-edited sections (replace analysis.sections)
//   sectionNames?: { [index]: string },      // older sessions: renames of the automatic sections
//   trim?: {start, end},                     // only this part counts in the numbers (see analysis/trim.js)
//   audio?: Blob, fileName?: string,
//   modified: ms,                            // last change; decides which copy wins on import
// }

const DB = 'live-tempo-analyzer', STORE = 'sessions', VERSION = 1;
let dbp = null;

function open() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('created', 'created');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage aborted (is the device out of space?)'));
  });
}

/** Stores a session and stamps `modified` (imports keep the sender's stamp). */
export function saveSession(s, { keepModified = false } = {}) {
  if (!keepModified || s.modified == null) s.modified = Date.now();
  return tx('readwrite', (st) => st.put(s)).then(() => s);
}
export const getSession = (id) => tx('readonly', (st) => st.get(id));
export const deleteSession = (id) => tx('readwrite', (st) => st.delete(id));

/** All sessions without their audio blobs, newest first. */
export async function listSessions() {
  const all = await tx('readonly', (st) => st.getAll());
  return (all || [])
    .map(({ audio, ...rest }) => ({ ...rest, hasAudio: !!audio }))
    .sort((a, b) => b.created - a.created);
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export async function requestPersistence() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* optional */ }
}
