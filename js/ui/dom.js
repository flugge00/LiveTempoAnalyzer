// Small DOM and formatting helpers shared by the views.

export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let toastTimer;
export function toast(msg, ms = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

export function download(filename, content, type = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export const fmtBpm = (v) => (v == null || !isFinite(v) ? '–' : v.toFixed(1));
export const fmtSigned = (v, d = 1) => (v == null || !isFinite(v) ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(d)}`);
export const fmtMs = (v) => (v == null || !isFinite(v) ? '–' : `${v.toFixed(0)} ms`);

export function fmtDuration(s) {
  if (s == null || !isFinite(s)) return '–';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}

/** Status for a tempo deviation in percent. Always icon + words, never colour alone. */
export function driftStatus(pct) {
  const a = Math.abs(pct);
  if (a < 2) return { level: 'good', icon: '✓', word: 'steady' };
  if (a < 4) return { level: 'warning', icon: '!', word: pct > 0 ? 'rushing' : 'dragging' };
  return { level: 'serious', icon: '!!', word: pct > 0 ? 'rushing' : 'dragging' };
}

export function statusBadge(st) {
  return `<span class="status-icon" style="background:var(--${st.level})" aria-hidden="true">${st.icon}</span>`;
}

// localStorage can throw (private mode, blocked storage) so wrap every access.
export const prefs = {
  get(key, fallback) {
    try { const v = localStorage.getItem('lta.' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('lta.' + key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

export function legend(el, series, onToggle) {
  el.innerHTML = '';
  for (const s of series) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(!s.hidden));
    b.innerHTML = `<span class="key ${s.style === 'dots' ? 'dot' : ''}" style="background:var(${s.color})"></span>${esc(s.name)}`;
    b.onclick = () => { s.hidden = !s.hidden; b.setAttribute('aria-pressed', String(!s.hidden)); onToggle?.(); };
    el.append(b);
  }
}
