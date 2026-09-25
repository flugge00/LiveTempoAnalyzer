// Canvas time-series chart for tempo over time.
// Features: multiple series (line / dots) with gaps, song-section strip,
// markers, target line + tolerance band, level lane, playhead, live "follow"
// mode, wheel/drag/pinch zoom & pan, crosshair tooltip, click-to-seek,
// draggable section boundaries (option sectionEdit: {snap(t)}, emits 'sections').

import { fmtTime } from '../analysis/report.js';
import { moveEdge } from '../analysis/sections.js';

const PAD = { left: 46, right: 14, top: 8, bottom: 24 };
const STRIP_H = 22, LEVEL_H = 34;

export class TimeChart extends EventTarget {
  constructor(el, o = {}) {
    super();
    this.el = el;
    this.o = { minSpan: 6, unit: 'BPM', ...o };
    el.classList.add('chart');
    this.canvas = document.createElement('canvas');
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.tip.hidden = true;
    el.append(this.canvas, this.tip);
    this.ctx = this.canvas.getContext('2d');
    this.data = { series: [], sections: [], markers: [], reference: null, levels: null, duration: 0 };
    this.view = null;        // [x0, x1] seconds, null = auto
    this.follow = o.follow ?? null; // {windowSec} for live
    this.playhead = null;
    this.hoverX = null;
    this._bind();
    new ResizeObserver(() => this._resize()).observe(el);
    this._resize();
  }

  setData(d) { Object.assign(this.data, d); this.draw(); }
  setPlayhead(t) { this.playhead = t; this.draw(); }
  resetZoom() { this.view = null; this.draw(); this._emitView(); }
  setFollow(f) { this.follow = f; if (f) this.view = null; this.draw(); this._emitView(); }

  zoomBy(factor, centreT) {
    const [a, b] = this._xRange();
    const c = centreT ?? (a + b) / 2;
    const span = Math.max(4, Math.min(this._fullSpan(), (b - a) * factor));
    const f = (c - a) / (b - a || 1);
    this.setView(c - f * span, c - f * span + span);
  }

  // ---- geometry -------------------------------------------------------

  _fullSpan() { return Math.max(10, this.data.duration || this._maxT()); }

  _maxT() {
    let m = 0;
    for (const s of this.data.series) if (s.points.length) m = Math.max(m, s.points[s.points.length - 1].t);
    return m;
  }

  _xRange() {
    if (this.view) return this.view;
    if (this.follow) {
      const end = Math.max(this.follow.windowSec, this._maxT() + 2);
      return [end - this.follow.windowSec, end];
    }
    return [0, this._fullSpan()];
  }

  setView(a, b) {
    const full = this._fullSpan(), span = b - a;
    if (span >= full * 0.999 && !this.follow) { this.view = null; }
    else {
      if (a < 0) { b -= a; a = 0; }
      const maxT = Math.max(full, this._maxT());
      if (b > maxT) { a -= b - maxT; b = maxT; }
      this.view = [Math.max(0, a), b];
      if (this.follow) this.follow = null; // user took over
    }
    this.draw();
    this._emitView();
  }

  _emitView() { this.dispatchEvent(new CustomEvent('view', { detail: { zoomed: !!this.view, following: !!this.follow } })); }

  _plot() {
    const w = this.w, h = this.h;
    const top = PAD.top + (this.data.sections?.length ? STRIP_H + 4 : 0);
    const bottom = h - PAD.bottom - (this.data.levels ? LEVEL_H + 4 : 0);
    return { x: PAD.left, y: top, w: w - PAD.left - PAD.right, h: Math.max(20, bottom - top) };
  }

  _yRange(x0, x1) {
    let lo = Infinity, hi = -Infinity;
    for (const s of this.data.series) {
      if (s.hidden) continue;
      for (const p of s.points) {
        if (p.v == null || p.t < x0 || p.t > x1) continue;
        if (p.v < lo) lo = p.v;
        if (p.v > hi) hi = p.v;
      }
    }
    const ref = this.data.reference;
    if (ref?.value != null) { lo = Math.min(lo, ref.value - (ref.band || 0)); hi = Math.max(hi, ref.value + (ref.band || 0)); }
    if (!isFinite(lo)) { lo = 100; hi = 140; }
    const pad = (hi - lo) * 0.12;
    lo -= pad; hi += pad;
    if (hi - lo < this.o.minSpan) { const c = (hi + lo) / 2; lo = c - this.o.minSpan / 2; hi = c + this.o.minSpan / 2; }
    return [lo, hi];
  }

  // ---- drawing --------------------------------------------------------

  _resize() {
    const r = this.el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(100, r.width);
    this.h = Math.max(120, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this._draw(); });
  }

  _draw() {
    const ctx = this.ctx, css = getComputedStyle(this.el);
    const col = (v) => css.getPropertyValue(v).trim() || v;
    const C = {
      surface: col('--surface-1'), ink: col('--text-primary'), ink2: col('--text-secondary'),
      muted: col('--text-muted'), grid: col('--grid'), axis: col('--axis'),
    };
    ctx.clearRect(0, 0, this.w, this.h);
    const P = this._plot();
    const [x0, x1] = this._xRange();
    const [y0, y1] = this._yRange(x0, x1);
    const X = (t) => P.x + ((t - x0) / (x1 - x0)) * P.w;
    const Y = (v) => P.y + P.h - ((v - y0) / (y1 - y0)) * P.h;
    this._map = { X, Y, x0, x1, y0, y1, P };
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';

    // section washes + strip
    const secs = this.data.sections || [];
    for (const s of secs) {
      const a = Math.max(P.x, X(s.start)), b = Math.min(P.x + P.w, X(s.end));
      if (b <= a) continue;
      const c = col(`--series-${(s.colorIndex % 8) + 1}`);
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = c;
      ctx.fillRect(a, P.y, b - a, P.h);
      ctx.globalAlpha = 1;
      const sy = PAD.top;
      ctx.fillStyle = c;
      roundRect(ctx, a + 1, sy, Math.max(0, b - a - 2), STRIP_H, 4);
      ctx.fill();
      const label = s.name;
      if (ctx.measureText(label).width + 10 < b - a - 2) {
        ctx.fillStyle = textOn(c);
        ctx.textAlign = 'left';
        ctx.fillText(label, a + 6, sy + STRIP_H / 2);
      }
    }
    // drag handles on the section edges
    if (this.o.sectionEdit) {
      ctx.fillStyle = C.ink;
      for (const e of this._edges()) {
        const x = X(e.t);
        if (x < P.x - 1 || x > P.x + P.w + 1) continue;
        const active = this._edgeDrag && this._edgeDrag.edge.i === e.i && this._edgeDrag.edge.side === e.side;
        roundRect(ctx, x - (active ? 2.5 : 1.5), PAD.top + 3, active ? 5 : 3, STRIP_H - 6, 1.5);
        ctx.fill();
      }
    }

    // grid + y ticks
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'right';
    for (const v of niceTicks(y0, y1, Math.max(3, Math.floor(P.h / 40)))) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke();
      ctx.fillText(fmtNum(v), P.x - 6, y);
    }
    // x ticks
    ctx.textAlign = 'center';
    const xt = timeTicks(x0, x1, Math.max(2, Math.floor(P.w / 80)));
    const axisY = this.h - PAD.bottom;
    for (const t of xt) {
      const x = Math.round(X(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke();
      ctx.fillText(fmtTime(t), x, axisY + 12);
    }
    ctx.strokeStyle = C.axis;
    ctx.beginPath(); ctx.moveTo(P.x, P.y + P.h + 0.5); ctx.lineTo(P.x + P.w, P.y + P.h + 0.5); ctx.stroke();

    // reference line + tolerance band
    const ref = this.data.reference;
    if (ref?.value != null) {
      if (ref.band) {
        ctx.fillStyle = C.ink2; ctx.globalAlpha = 0.08;
        ctx.fillRect(P.x, Y(ref.value + ref.band), P.w, Y(ref.value - ref.band) - Y(ref.value + ref.band));
        ctx.globalAlpha = 1;
      }
      const y = Math.round(Y(ref.value)) + 0.5;
      ctx.strokeStyle = C.ink2; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke();
      ctx.fillStyle = C.ink2; ctx.textAlign = 'right';
      ctx.fillText(ref.label || `${fmtNum(ref.value)}`, P.x + P.w - 4, y - 8);
    }

    // level lane
    const lv = this.data.levels;
    if (lv) {
      const ly = this.h - PAD.bottom - LEVEL_H;
      ctx.fillStyle = C.muted; ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(P.x, ly + LEVEL_H);
      const i0 = Math.max(0, Math.floor(x0 / lv.dt)), i1 = Math.min(lv.db.length - 1, Math.ceil(x1 / lv.dt));
      const stepI = Math.max(1, Math.floor((i1 - i0) / P.w));
      for (let i = i0; i <= i1; i += stepI) {
        let m = -120;
        for (let j = i; j < Math.min(i + stepI, lv.db.length); j++) m = Math.max(m, lv.db[j]);
        const f = Math.max(0, Math.min(1, (m + 60) / 60));
        ctx.lineTo(X(i * lv.dt), ly + LEVEL_H - f * LEVEL_H);
      }
      ctx.lineTo(X(i1 * lv.dt), ly + LEVEL_H);
      ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
    }

    // series
    ctx.save();
    ctx.beginPath(); ctx.rect(P.x, P.y - 6, P.w, P.h + 12); ctx.clip();
    for (const s of this.data.series) {
      if (s.hidden) continue;
      const c = col(s.color);
      if (s.style === 'dots') {
        for (const p of s.points) {
          if (p.v == null || p.t < x0 - 1 || p.t > x1 + 1) continue;
          ctx.beginPath(); ctx.arc(X(p.t), Y(p.v), 4, 0, 2 * Math.PI);
          ctx.fillStyle = C.surface; ctx.fill();
          ctx.beginPath(); ctx.arc(X(p.t), Y(p.v), 2.75, 0, 2 * Math.PI);
          ctx.fillStyle = c; ctx.fill();
        }
      } else {
        ctx.strokeStyle = c; ctx.lineWidth = s.width || 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();
        let prev = null;
        const gap = s.gapSec ?? 2;
        for (const p of s.points) {
          if (p.t < x0 - gap || p.t > x1 + gap) { prev = null; continue; }
          if (p.v == null) { prev = null; continue; }
          if (prev && p.t - prev.t <= gap) ctx.lineTo(X(p.t), Y(p.v));
          else ctx.moveTo(X(p.t), Y(p.v));
          prev = p;
        }
        ctx.stroke();
        // end dot for the live head
        const last = s.points[s.points.length - 1];
        if (s.endDot && last?.v != null) {
          ctx.beginPath(); ctx.arc(X(last.t), Y(last.v), 6, 0, 2 * Math.PI); ctx.fillStyle = C.surface; ctx.fill();
          ctx.beginPath(); ctx.arc(X(last.t), Y(last.v), 4, 0, 2 * Math.PI); ctx.fillStyle = c; ctx.fill();
        }
      }
    }
    ctx.restore();

    // markers
    ctx.textAlign = 'left';
    for (const m of this.data.markers || []) {
      if (m.t < x0 || m.t > x1) continue;
      const x = Math.round(X(m.t)) + 0.5;
      ctx.strokeStyle = C.ink2; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke();
      ctx.fillStyle = C.ink2;
      ctx.fillText(m.label, x + 4, P.y + 10);
    }

    // playhead
    if (this.playhead != null && this.playhead >= x0 && this.playhead <= x1) {
      const x = Math.round(X(this.playhead)) + 0.5;
      ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, P.y - 4); ctx.lineTo(x, this.h - PAD.bottom); ctx.stroke();
    }

    // hover crosshair
    if (this.hoverX != null) {
      const x = Math.round(this.hoverX) + 0.5;
      ctx.strokeStyle = C.muted; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke();
    }
  }

  // ---- interaction ----------------------------------------------------

  /** Section edges; a boundary shared by two neighbours is one edge (the left one's end). */
  _edges() {
    const secs = this.data.sections || [], out = [];
    secs.forEach((s, i) => {
      if (!(i > 0 && Math.abs(secs[i - 1].end - s.start) < 0.05)) out.push({ i, side: 'start', t: s.start });
      out.push({ i, side: 'end', t: s.end });
    });
    return out;
  }

  /** The section edge under the pointer, if it's on the section strip. */
  _edgeAt(clientX, clientY, touch) {
    if (!this.o.sectionEdit || !this._map || !this.data.sections?.length) return null;
    const r = this.canvas.getBoundingClientRect();
    const y = clientY - r.top, x = clientX - r.left;
    if (y < PAD.top - 6 || y > PAD.top + STRIP_H + 6) return null;
    const tol = touch ? 16 : 7;
    let best = null;
    for (const e of this._edges()) {
      const d = Math.abs(this._map.X(e.t) - x);
      if (d <= tol && (!best || d < best.d)) best = { ...e, d };
    }
    return best && { i: best.i, side: best.side };
  }

  _bind() {
    const c = this.canvas;
    const pointers = new Map();
    let drag = null, pinch = null, moved = false;
    const tAt = (clientX) => {
      const r = c.getBoundingClientRect(), m = this._map;
      return m.x0 + ((clientX - r.left - m.P.x) / m.P.w) * (m.x1 - m.x0);
    };

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, e.clientX);
      moved = false;
      const edge = pointers.size === 1 && this._edgeAt(e.clientX, e.clientY, e.pointerType !== 'mouse');
      if (edge) {
        this._edgeDrag = { edge, orig: this.data.sections };
        drag = null;
        this.draw();
        return;
      }
      if (pointers.size === 1) drag = { x: e.clientX, range: this._xRange() };
      if (pointers.size === 2) {
        const xs = [...pointers.values()];
        pinch = { d: Math.abs(xs[0] - xs[1]) || 1, range: this._xRange(), mid: tAt((xs[0] + xs[1]) / 2) };
        drag = null;
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, e.clientX);
      if (this._edgeDrag) {
        const t = this.o.sectionEdit.snap?.(tAt(e.clientX)) ?? tAt(e.clientX);
        this.data.sections = moveEdge(this._edgeDrag.orig, this._edgeDrag.edge, t);
        moved = true;
        this.draw();
        return;
      }
      if (e.pointerType === 'mouse' && !drag) c.style.cursor = this._edgeAt(e.clientX, e.clientY, false) ? 'ew-resize' : '';
      if (pinch && pointers.size === 2) {
        const xs = [...pointers.values()];
        const f = pinch.d / (Math.abs(xs[0] - xs[1]) || 1);
        const [a, b] = pinch.range, span = (b - a) * f;
        const k = (pinch.mid - a) / (b - a);
        this.setView(pinch.mid - k * span, pinch.mid - k * span + Math.max(4, span));
        moved = true;
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x;
        if (Math.abs(dx) > 4) moved = true;
        if (moved) {
          const [a, b] = drag.range;
          const dt = (-dx / this._map.P.w) * (b - a);
          this.setView(a + dt, b + dt);
        }
      }
      if (e.pointerType === 'mouse' || drag) this._hover(e.clientX);
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (this._edgeDrag) {
        const changed = this.data.sections !== this._edgeDrag.orig;
        this._edgeDrag = null;
        this.draw();
        if (changed) this.dispatchEvent(new CustomEvent('sections', { detail: this.data.sections }));
        return;
      }
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) {
        if (drag && !moved) this.dispatchEvent(new CustomEvent('seek', { detail: Math.max(0, tAt(e.clientX)) }));
        drag = null;
        if (e.pointerType !== 'mouse') this._hover(null);
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this._hover(null); });
    c.addEventListener('wheel', (e) => {
      if (!this.o.wheelZoom) return;
      e.preventDefault();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const [a, b] = this._xRange(), dt = (e.deltaX / this._map.P.w) * (b - a);
        this.setView(a + dt, b + dt);
      } else this.zoomBy(Math.exp(e.deltaY * 0.0015), tAt(e.clientX));
    }, { passive: false });
    c.addEventListener('dblclick', () => this.resetZoom());
  }

  _hover(clientX) {
    if (clientX == null) { this.hoverX = null; this.tip.hidden = true; this.draw(); return; }
    const r = this.canvas.getBoundingClientRect(), m = this._map;
    const x = clientX - r.left;
    if (!m || x < m.P.x || x > m.P.x + m.P.w) { this._hover(null); return; }
    this.hoverX = x;
    const t = m.x0 + ((x - m.P.x) / m.P.w) * (m.x1 - m.x0);
    const rows = [`<b>${fmtTime(t)}</b>`];
    const sec = (this.data.sections || []).find((s) => t >= s.start && t < s.end);
    if (sec) rows.push(`<span class="muted">${esc(sec.name)}</span>`);
    for (const s of this.data.series) {
      if (s.hidden) continue;
      const p = nearest(s.points, t);
      if (p && p.v != null && Math.abs(p.t - t) < Math.max(2, (m.x1 - m.x0) / 60)) {
        rows.push(`<span class="key" style="background:var(${s.color})"></span>${esc(s.name)}: <b>${p.v.toFixed(1)}</b> ${this.o.unit}`);
      }
    }
    this.tip.innerHTML = rows.join('<br>');
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth;
    this.tip.style.left = `${x + 12 + tw > this.w ? x - 12 - tw : x + 12}px`;
    this.tip.style.top = `${m.P.y + 4}px`;
    this.draw();
  }
}

function nearest(points, t) {
  let lo = 0, hi = points.length - 1;
  if (hi < 0) return null;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid].t < t) lo = mid; else hi = mid; }
  return Math.abs(points[lo].t - t) < Math.abs(points[hi].t - t) ? points[lo] : points[hi];
}

function niceTicks(lo, hi, count) {
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

function timeTicks(lo, hi, count) {
  const raw = (hi - lo) / count;
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find((s) => s >= raw) || 3600;
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out.push(t);
  return out;
}

const fmtNum = (v) => (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(1));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/** Ink colour that reads on a filled background. */
function textOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.3 ? '#0b0b0b' : '#ffffff';
}
