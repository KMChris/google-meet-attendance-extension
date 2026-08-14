/**
 * The page's one hover readout, shared by every mark that has something to say.
 *
 * A canvas hotspot has no element of its own, so it puts the panel at the cursor. A mark that
 * *is* an element (a presence segment on the timeline) anchors it above its own box, where it
 * never sits under the pointer it belongs to.
 *
 * Everything shown is data (participant names, meeting titles), so every value goes in as text
 * and never as markup. A DOM mark declares its readout in `data-tip-*` attributes, which is what
 * lets the timeline render as one string of HTML and still get a tooltip.
 */

const TIP_ID = 'ui-tip';

function tipEl() {
  let el = document.getElementById(TIP_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = TIP_ID;
    el.className = 'tip';
    el.hidden = true;
    el.innerHTML = '<div class="tip-title"></div><div class="tip-rows"></div>';
    document.body.appendChild(el);
  }
  return el;
}

export function hideTip() {
  const el = document.getElementById(TIP_ID);
  if (el) el.hidden = true;
}

/** Fill the panel and show it. It has to be visible before it can be measured, so placing follows. */
function fill(data) {
  const el = tipEl();
  el.querySelector('.tip-title').textContent = data.title || '';
  const rows = el.querySelector('.tip-rows');
  rows.textContent = '';
  (data.rows || []).forEach(r => {
    const row = document.createElement('div');
    row.className = 'tip-row';
    const key = document.createElement('span');
    key.className = 'tip-key';
    if (r.color) key.style.background = r.color; else key.style.visibility = 'hidden';
    row.appendChild(key);
    const val = document.createElement('span');
    val.className = 'tip-val';
    val.textContent = r.value;
    row.appendChild(val);
    if (r.label) {
      const lbl = document.createElement('span');
      lbl.className = 'tip-lbl';
      lbl.textContent = r.label;
      row.appendChild(lbl);
    }
    rows.appendChild(row);
  });
  el.hidden = false;
  return el;
}

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/** Beside the cursor, flipped to its other side when the panel would leave the viewport. */
export function showTipAt(data, ev) {
  const el = fill(data);
  const pad = 14, w = el.offsetWidth, h = el.offsetHeight;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
  el.style.left = Math.max(8, x) + 'px';
  el.style.top = Math.max(8, y) + 'px';
}

/** Centred above the mark, dropped underneath it when there is no room up there. */
export function showTipOver(data, rect) {
  const el = fill(data);
  const gap = 9, w = el.offsetWidth, h = el.offsetHeight;
  const above = rect.top - h - gap;
  const y = above >= 8 ? above : rect.bottom + gap;
  el.style.left = clamp(rect.left + rect.width / 2 - w / 2, 8, Math.max(8, window.innerWidth - w - 8)) + 'px';
  el.style.top = clamp(y, 8, Math.max(8, window.innerHeight - h - 8)) + 'px';
}

/** What a DOM mark carries, or null when the element is not one. */
function markData(el) {
  const d = el.dataset;
  if (!d.tipValue) return null;
  return {
    title: d.tipTitle || '',
    rows: [{ color: d.tipColor || '', value: d.tipValue, label: d.tipLabel || '' }]
  };
}

/**
 * One delegated listener covers every mark on the page, including the ones a later render
 * replaces: `pointerover` fires on each new target, so moving off a mark onto anything else
 * takes the panel down.
 */
export function initTips(root = document) {
  root.addEventListener('pointerover', ev => {
    const mark = ev.target.closest ? ev.target.closest('[data-tip-value]') : null;
    const data = mark && markData(mark);
    if (data) showTipOver(data, mark.getBoundingClientRect());
    else hideTip();
  });
}

window.addEventListener('scroll', hideTip, { passive: true, capture: true });
