/**
 * Canvas chart toolkit for the analytics view.
 *
 * Every chart is drawn on a HiDPI-scaled 2D context, reads its colours from the live
 * CSS custom properties (a theme flip only needs a redraw) and registers hover
 * hotspots for one shared tooltip.
 *
 * Text is always measured before it is drawn: labels are truncated to the width they
 * actually have — never cut off by the canvas edge — and the full text lives in the
 * tooltip and in the card's table view, so nothing is gated behind a hover.
 *
 * Conventions kept across every chart here:
 *   · bars ≤ 24px thick, 4px rounded data-end, square at the baseline
 *   · a 2px surface gap separates touching marks (stack segments, heat cells)
 *   · gridlines are solid hairlines one step off the surface, never dashed
 *   · one y-scale per plot — no dual axes
 *   · text wears ink tokens; colour identity comes from the mark beside it
 */

const FONT = '11px "IBM Plex Mono", monospace';
const FONT_MED = '500 11px "IBM Plex Mono", monospace';
const BAR_MAX = 24;   // px — never let a bar fill its whole slot
const HIT_MIN = 24;   // px — hover targets are bigger than the marks

const HOT = new WeakMap();   // canvas -> hotspot[]
const BOUND = new WeakSet(); // canvases already wired for hover

/* ============================ theme ============================ */

/** Current token values. Read fresh per render so light/dark just works. */
export function palette() {
  const cs = getComputedStyle(document.body);
  const v = n => (cs.getPropertyValue(n) || '').trim() || '#888';
  return {
    ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'),
    line: v('--line'), line2: v('--line-2'),
    panel: v('--panel'), panel2: v('--panel-2'), surface: v('--surface'),
    present: v('--present'), late: v('--late'), absent: v('--absent'), red: v('--red'),
    cat: ['--grp-teal', '--grp-amber', '--grp-violet', '--grp-rose', '--grp-sky', '--grp-lime'].map(v)
  };
}

/* ============================ tooltip ============================ */

function tipEl() {
  let el = document.getElementById('chart-tip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'chart-tip';
    el.className = 'chart-tip';
    el.hidden = true;
    el.innerHTML = '<div class="ct-title"></div><div class="ct-rows"></div>';
    document.body.appendChild(el);
  }
  return el;
}

export function hideTip() {
  const el = document.getElementById('chart-tip');
  if (el) el.hidden = true;
}

/**
 * Show the readout for one hotspot. Category and series names are meeting titles and
 * participant names — untrusted text — so every one of them goes in via textContent.
 */
function showTip(hit, ev) {
  const el = tipEl();
  el.querySelector('.ct-title').textContent = hit.title || '';
  const rows = el.querySelector('.ct-rows');
  rows.textContent = '';
  (hit.rows || []).forEach(r => {
    const row = document.createElement('div');
    row.className = 'ct-row';
    const key = document.createElement('span');
    key.className = 'ct-key';
    if (r.color) key.style.background = r.color; else key.style.visibility = 'hidden';
    row.appendChild(key);
    const val = document.createElement('span');
    val.className = 'ct-val';
    val.textContent = r.value;
    row.appendChild(val);
    if (r.label) {
      const lbl = document.createElement('span');
      lbl.className = 'ct-lbl';
      lbl.textContent = r.label;
      row.appendChild(lbl);
    }
    rows.appendChild(row);
  });
  el.hidden = false;

  const pad = 14, w = el.offsetWidth, h = el.offsetHeight;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
  el.style.left = Math.max(8, x) + 'px';
  el.style.top = Math.max(8, y) + 'px';
}

function bindHover(canvas) {
  if (BOUND.has(canvas)) return;
  BOUND.add(canvas);
  canvas.addEventListener('pointermove', ev => {
    const spots = HOT.get(canvas) || [];
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const hit = spots.find(s => x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h);
    if (hit) showTip(hit, ev); else hideTip();
  });
  canvas.addEventListener('pointerleave', hideTip);
}
window.addEventListener('scroll', hideTip, { passive: true, capture: true });

/* ============================ primitives ============================ */

/** Size the canvas for the device pixel ratio and hand back CSS-pixel geometry. */
function prep(canvas, height) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(160, canvas.clientWidth || canvas.offsetWidth || 320);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.height = height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, height);
  ctx.font = FONT;
  ctx.textBaseline = 'alphabetic';
  HOT.set(canvas, []);
  bindHover(canvas);
  return { ctx, W, H: height };
}

function spots(canvas) { return HOT.get(canvas) || []; }

/** A rounded rectangle with per-corner radii [tl, tr, br, bl]. */
function roundPath(ctx, x, y, w, h, radii) {
  const lim = Math.min(w, h) / 2;
  const [a, b, c, d] = radii.map(r => Math.max(0, Math.min(r, lim)));
  ctx.beginPath();
  ctx.moveTo(x + a, y);
  ctx.lineTo(x + w - b, y); ctx.arcTo(x + w, y, x + w, y + b, b);
  ctx.lineTo(x + w, y + h - c); ctx.arcTo(x + w, y + h, x + w - c, y + h, c);
  ctx.lineTo(x + d, y + h); ctx.arcTo(x, y + h, x, y + h - d, d);
  ctx.lineTo(x, y + a); ctx.arcTo(x, y, x + a, y, a);
  ctx.closePath();
}
function fillRound(ctx, x, y, w, h, radii) {
  if (w <= 0 || h <= 0) return;
  roundPath(ctx, x, y, w, h, radii);
  ctx.fill();
}

/** Truncate `text` with an ellipsis so it fits `maxW` in the context's current font. */
export function fitText(ctx, text, maxW) {
  const s = String(text == null ? '' : text);
  if (maxW <= 4 || !s) return '';
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(s.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? s.slice(0, lo).replace(/\s+$/, '') + '…' : '';
}

function measureMax(ctx, list) {
  let w = 0;
  list.forEach(s => { w = Math.max(w, ctx.measureText(String(s)).width); });
  return w;
}

/* ------------------------------- scales ------------------------------- */

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

/** A 0..top axis on round numbers. `integer` keeps counts off fractional ticks. */
function scaleFor(max, { ticks = 4, integer = false } = {}) {
  if (!(max > 0)) return { top: ticks, step: 1, ticks };
  let step = niceStep(max / ticks);
  if (integer) step = Math.max(1, Math.ceil(step));
  return { top: step * ticks, step, ticks };
}

function gridY(ctx, g, sc, fmt, pal) {
  ctx.lineWidth = 1;
  ctx.strokeStyle = pal.line;
  ctx.fillStyle = pal.ink3;
  ctx.textAlign = 'right';
  for (let i = 0; i <= sc.ticks; i++) {
    const val = i * sc.step;
    const y = Math.round(g.top + g.h - (val / sc.top) * g.h) + 0.5;
    ctx.beginPath(); ctx.moveTo(g.left, y); ctx.lineTo(g.left + g.w, y); ctx.stroke();
    ctx.fillText(fmt(val), g.left - 7, y + 4);
  }
}

/**
 * X labels only get drawn when they fit: with many buckets every n-th one is kept so
 * neighbours never collide. Returns the stride used.
 */
function labelStride(ctx, labels, slot) {
  const w = measureMax(ctx, labels);
  return Math.max(1, Math.ceil((w + 10) / Math.max(1, slot)));
}

function legend(ctx, series, x, y, pal) {
  ctx.textAlign = 'left';
  ctx.font = FONT;
  let cx = x;
  series.forEach(s => {
    ctx.fillStyle = s.color;
    fillRound(ctx, cx, y - 8, 10, 10, [3, 3, 3, 3]);
    ctx.fillStyle = pal.ink2;
    ctx.fillText(s.label, cx + 15, y);
    cx += 15 + ctx.measureText(s.label).width + 18;
  });
}

const NOOP_FMT = v => String(v);

/* ============================ charts ============================ */

/**
 * Columns for a single measure over time (or over a handful of ordered bins).
 * One series → no legend box; the card title already names it.
 */
export function columns(canvas, o) {
  const pal = o.pal || palette();
  const labels = o.labels, values = o.values;
  const fmt = o.fmt || NOOP_FMT, axisFmt = o.axisFmt || fmt;
  const height = o.height || 200;
  const { ctx, W, H } = prep(canvas, height);

  const sc = scaleFor(Math.max(...values, 0), { integer: o.integer });
  const padL = Math.round(measureMax(ctx, [0, sc.top].map(axisFmt)) + 12);
  const g = { left: padL, top: 12, w: W - padL - 8, h: H - 12 - 26 };
  gridY(ctx, g, sc, axisFmt, pal);

  const slot = g.w / Math.max(1, labels.length);
  const bw = Math.max(3, Math.min(BAR_MAX, slot * 0.62));
  const stride = labelStride(ctx, labels, slot);
  const peak = values.indexOf(Math.max(...values));
  const labelAll = labels.length <= 12;

  values.forEach((val, i) => {
    const cx = g.left + slot * (i + 0.5);
    const bh = sc.top > 0 ? (val / sc.top) * g.h : 0;
    const y = g.top + g.h - bh;
    ctx.save();
    // `alphas` steps one hue light→dark for ordered bins (share bands); never for
    // nominal categories, where it would double-encode the bar length as colour.
    if (o.alphas) ctx.globalAlpha = o.alphas[i];
    ctx.fillStyle = o.color || pal.present;
    fillRound(ctx, cx - bw / 2, y, bw, bh, [4, 4, 0, 0]);
    ctx.restore();

    // value on the cap — selectively, so the numbers stay readable
    if (val > 0 && (labelAll || i === peak)) {
      ctx.font = FONT_MED; ctx.fillStyle = pal.ink2; ctx.textAlign = 'center';
      ctx.fillText(fmt(val), cx, y - 6);
      ctx.font = FONT;
    }
    if (i % stride === 0) {
      ctx.fillStyle = pal.ink3; ctx.textAlign = 'center';
      ctx.fillText(labels[i], cx, H - 8);
    }
    spots(canvas).push({
      x: cx - Math.max(HIT_MIN, slot) / 2, y: g.top, w: Math.max(HIT_MIN, slot), h: g.h,
      title: (o.titles && o.titles[i]) || labels[i],
      rows: [{ color: o.color || pal.present, value: fmt(val), label: o.seriesLabel || '' }]
    });
  });
}

/** A single measure as a line + 10% wash. Trend at a glance; extremes direct-labelled. */
export function area(canvas, o) {
  const pal = o.pal || palette();
  const labels = o.labels, values = o.values;
  const fmt = o.fmt || NOOP_FMT, axisFmt = o.axisFmt || fmt;
  const color = o.color || pal.present;
  const height = o.height || 210;
  const { ctx, W, H } = prep(canvas, height);

  const sc = scaleFor(Math.max(...values, 0), { integer: o.integer });
  const padL = Math.round(measureMax(ctx, [0, sc.top].map(axisFmt)) + 12);
  const g = { left: padL, top: 16, w: W - padL - 10, h: H - 16 - 26 };
  gridY(ctx, g, sc, axisFmt, pal);

  const n = labels.length;
  const slot = g.w / Math.max(1, n);
  const px = i => g.left + slot * (i + 0.5);
  const py = v => g.top + g.h - (sc.top > 0 ? (v / sc.top) * g.h : 0);

  // wash under the line
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(px(0), g.top + g.h);
  values.forEach((v, i) => ctx.lineTo(px(i), py(v)));
  ctx.lineTo(px(n - 1), g.top + g.h);
  ctx.closePath();
  ctx.globalAlpha = 0.1;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  values.forEach((v, i) => { const x = px(i), y = py(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.stroke();

  const peak = values.indexOf(Math.max(...values));
  const stride = labelStride(ctx, labels, slot);
  values.forEach((v, i) => {
    const x = px(i), y = py(v);
    const marked = i === peak || i === n - 1;
    if (marked) {
      ctx.fillStyle = pal.panel;                       // 2px surface ring
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.font = FONT_MED; ctx.fillStyle = pal.ink2;
      ctx.textAlign = i === n - 1 && n > 1 ? 'right' : 'center';
      ctx.fillText(fmt(v), i === n - 1 && n > 1 ? x + 4 : x, Math.max(g.top + 9, y - 11));
      ctx.font = FONT;
    }
    if (i % stride === 0) {
      ctx.fillStyle = pal.ink3; ctx.textAlign = 'center';
      ctx.fillText(labels[i], x, H - 8);
    }
    spots(canvas).push({
      x: x - Math.max(HIT_MIN, slot) / 2, y: g.top, w: Math.max(HIT_MIN, slot), h: g.h,
      title: (o.titles && o.titles[i]) || labels[i],
      rows: [{ color, value: fmt(v), label: o.seriesLabel || '' }]
        .concat((o.extraRows && o.extraRows(i)) || [])
    });
  });
}

/** Two or three measures side by side per bucket. Legend is mandatory here. */
export function grouped(canvas, o) {
  const pal = o.pal || palette();
  const labels = o.labels, series = o.series;
  const fmt = o.fmt || NOOP_FMT, axisFmt = o.axisFmt || fmt;
  const height = o.height || 210;
  const { ctx, W, H } = prep(canvas, height);

  const sc = scaleFor(Math.max(0, ...series.flatMap(s => s.values)), { integer: o.integer });
  const padL = Math.round(measureMax(ctx, [0, sc.top].map(axisFmt)) + 12);
  const g = { left: padL, top: 30, w: W - padL - 8, h: H - 30 - 26 };
  legend(ctx, series, padL, 12, pal);
  gridY(ctx, g, sc, axisFmt, pal);

  const slot = g.w / Math.max(1, labels.length);
  const bw = Math.max(3, Math.min(BAR_MAX, (slot * 0.7 - 2 * (series.length - 1)) / series.length));
  const groupW = bw * series.length + 2 * (series.length - 1); // 2px surface gap between neighbours
  const stride = labelStride(ctx, labels, slot);

  labels.forEach((lb, i) => {
    const cx = g.left + slot * (i + 0.5);
    const x0 = cx - groupW / 2;
    series.forEach((s, si) => {
      const val = s.values[i] || 0;
      const bh = sc.top > 0 ? (val / sc.top) * g.h : 0;
      ctx.fillStyle = s.color;
      fillRound(ctx, x0 + si * (bw + 2), g.top + g.h - bh, bw, bh, [4, 4, 0, 0]);
    });
    if (i % stride === 0) {
      ctx.fillStyle = pal.ink3; ctx.textAlign = 'center';
      ctx.fillText(lb, cx, H - 8);
    }
    spots(canvas).push({
      x: cx - Math.max(HIT_MIN, slot) / 2, y: g.top, w: Math.max(HIT_MIN, slot), h: g.h,
      title: (o.titles && o.titles[i]) || lb,
      rows: series.map(s => ({ color: s.color, value: fmt(s.values[i] || 0), label: s.label }))
    });
  });
}

/**
 * Ranked horizontal bars. The name gutter is measured from the actual labels and
 * capped at 40% of the canvas, then every label is fitted to it — which is why a long
 * meeting title can no longer be sliced off the left edge.
 */
export function rankedBars(canvas, o) {
  const pal = o.pal || palette();
  const labels = o.labels, values = o.values;
  const fmt = o.fmt || NOOP_FMT;
  const bh = 20, gap = 12, padY = 10;
  const rows = Math.max(1, labels.length);
  const height = Math.max(120, padY * 2 + rows * bh + (rows - 1) * gap);
  const { ctx, W } = prep(canvas, height);

  const valueW = measureMax(ctx, values.map(fmt)) + 10;
  const gutter = Math.min(Math.max(64, measureMax(ctx, labels) + 12), Math.round(W * 0.4));
  const track = Math.max(24, W - gutter - valueW);
  const max = Math.max(...values, 1);

  labels.forEach((lb, i) => {
    const y = padY + i * (bh + gap);
    const w = Math.max(2, (values[i] / max) * track);
    ctx.fillStyle = (o.colors && o.colors[i]) || o.color || pal.present;
    fillRound(ctx, gutter, y, w, bh, [0, 4, 4, 0]);

    ctx.fillStyle = pal.ink2; ctx.textAlign = 'right';
    ctx.fillText(fitText(ctx, lb, gutter - 12), gutter - 10, y + bh / 2 + 4);

    ctx.font = FONT_MED; ctx.fillStyle = pal.ink2; ctx.textAlign = 'left';
    ctx.fillText(fmt(values[i]), gutter + w + 7, y + bh / 2 + 4);
    ctx.font = FONT;

    const hitH = Math.max(HIT_MIN, bh + gap);
    spots(canvas).push({
      x: 0, y: y + bh / 2 - hitH / 2, w: W, h: hitH,
      title: (o.titles && o.titles[i]) || lb,
      rows: [{ color: (o.colors && o.colors[i]) || o.color || pal.present, value: fmt(values[i]), label: o.seriesLabel || '' }]
        .concat((o.extraRows && o.extraRows(i)) || [])
    });
  });
}

/**
 * Magnitude on a grid (weekday × hour). One hue, light→dark, with a scale legend —
 * a sequential ramp, never a rainbow.
 */
export function heat(canvas, o) {
  const pal = o.pal || palette();
  const { rowLabels, colLabels, values } = o;     // values[row][col]
  const fmt = o.fmt || NOOP_FMT;
  const color = o.color || pal.present;
  const cell = 26, gap = 2, padT = 20, padB = 40;

  const probe = canvas.getContext('2d');
  probe.font = FONT;
  const gutter = Math.min(Math.max(38, measureMax(probe, rowLabels) + 12), 90);
  const height = padT + rowLabels.length * (cell + gap) - gap + padB;
  const { ctx, W, H } = prep(canvas, height);

  const cw = (W - gutter - 4) / Math.max(1, colLabels.length);
  const max = Math.max(1, ...values.flat());
  const stride = labelStride(ctx, colLabels, cw);

  rowLabels.forEach((rl, r) => {
    const y = padT + r * (cell + gap);
    ctx.fillStyle = pal.ink3; ctx.textAlign = 'right';
    ctx.fillText(fitText(ctx, rl, gutter - 10), gutter - 8, y + cell / 2 + 4);

    colLabels.forEach((cl, c) => {
      const x = gutter + c * cw;
      const v = values[r][c] || 0;
      const w = cw - gap;
      if (v > 0) {
        ctx.save();
        ctx.globalAlpha = 0.18 + 0.82 * (v / max);   // sequential: more is darker
        ctx.fillStyle = color;
        fillRound(ctx, x, y, w, cell, [4, 4, 4, 4]);
        ctx.restore();
        if (w >= 22 && v / max > 0.55) {             // only label where it comfortably fits
          ctx.fillStyle = pal.panel; ctx.textAlign = 'center';
          ctx.fillText(String(v), x + w / 2, y + cell / 2 + 4);
        }
      } else {
        ctx.fillStyle = pal.panel2;
        fillRound(ctx, x, y, w, cell, [4, 4, 4, 4]);
      }
      spots(canvas).push({
        x, y: y - gap / 2, w: Math.max(HIT_MIN, w), h: cell + gap,
        title: `${rl} · ${cl}`,
        rows: [{ color, value: fmt(v), label: o.seriesLabel || '' }]
      });
    });
  });

  const lastY = padT + rowLabels.length * (cell + gap);
  ctx.fillStyle = pal.ink3; ctx.textAlign = 'center';
  colLabels.forEach((cl, c) => {
    if (c % stride) return;
    ctx.fillText(cl, gutter + c * cw + (cw - gap) / 2, lastY + 12);
  });

  // scale legend — a sequential ramp always ships with one
  const lw = 96, lx = gutter, ly = H - 13;
  for (let i = 0; i < lw; i++) {
    ctx.save();
    ctx.globalAlpha = 0.18 + 0.82 * (i / (lw - 1));
    ctx.fillStyle = color;
    ctx.fillRect(lx + i, ly - 8, 1, 8);
    ctx.restore();
  }
  ctx.fillStyle = pal.ink3; ctx.textAlign = 'right';
  ctx.fillText(o.scaleMin != null ? o.scaleMin : '0', lx - 6, ly);
  ctx.textAlign = 'left';
  ctx.fillText(fmt(max), lx + lw + 6, ly);
}
