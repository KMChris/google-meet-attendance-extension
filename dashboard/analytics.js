/**
 * Analytics view — one filter row scoping every chart and read-out below it.
 *
 * The slice is (date range × series × meeting) and everything on the page is derived
 * from that one list of meetings, so the numbers always agree with each other. Filters
 * live in chrome.storage.local so the view opens where you left it.
 *
 * Charts are drawn by ./charts.js; each card can be flipped to the table it was drawn
 * from, which keeps every value reachable without hovering.
 */

import * as store from '../src/lib/storage.js';
import * as A from '../src/lib/attendance.js';
import * as i18n from '../src/lib/i18n.js';
import * as C from './charts.js';
import { hideTip } from './tooltip.js';

const { t } = i18n;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const DAY_MS = 86400000;
const FILTER_KEY = 'analyticsFilters';
const PRESET_DAYS = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };
const UNGROUPED = '__none';

let deps = null;
const state = {
  preset: '30d',      // '7d' | '30d' | '90d' | '365d' | 'all' | 'custom'
  from: '',           // 'YYYY-MM-DD', only meaningful for the custom preset
  to: '',
  groups: [],         // group ids (plus UNGROUPED); [] means every series
  titles: [],         // meeting titles; [] means every meeting
  archived: false     // meetings set aside are out of these figures unless this is on
};

/**
 * The meetings this view will consider at all.
 *
 * A meeting in the archive has been set aside, which is a statement about the meeting and not just
 * about the list it is on: it stays out of the figures here as it stays out of the list. The
 * switch in the filter bar is for the times you want the whole record anyway.
 */
function inScope() {
  const all = deps.history();
  return state.archived ? all : all.filter(m => !m.archived);
}

const tables = new Map();   // chart key -> { head, rows } for the table view
const pickers = new Map();

/* ============================ small helpers ============================ */

const pad2 = n => String(n).padStart(2, '0');
const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
const endOfDay = d => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x.getTime(); };
const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const fromDayKey = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };

function num(v, dec = 0) {
  return new Intl.NumberFormat(i18n.localeTag(), { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(v || 0);
}
const pct = v => `${Math.round(v || 0)}%`;
const mins = secs => Math.round((secs || 0) / 60);
/** Resolve a design token to the colour canvas needs (CSS `var()` is no use there). */
const tokenColor = name => getComputedStyle(document.body).getPropertyValue(name).trim() || '#888';

function txt(el, value) { el.textContent = value == null ? '' : String(value); }

/* ============================ scope ============================ */

/** The date window the filters currently describe, as inclusive local-day bounds. */
function resolveRange() {
  const all = inScope();
  const now = new Date();

  if (state.preset === 'custom') {
    const times = all.map(m => A.meetingStartMs(m)).filter(Number.isFinite);
    const first = times.length ? Math.min(...times) : Date.now();
    let from = state.from ? startOfDay(fromDayKey(state.from)) : startOfDay(new Date(first));
    let to = state.to ? endOfDay(fromDayKey(state.to)) : endOfDay(now);
    if (from > to) [from, to] = [startOfDay(new Date(to)), endOfDay(new Date(from))];
    return { from, to };
  }
  if (state.preset === 'all') {
    const times = all.map(m => A.meetingStartMs(m)).filter(Number.isFinite);
    const from = times.length ? startOfDay(new Date(Math.min(...times))) : startOfDay(now);
    const to = times.length ? Math.max(endOfDay(now), endOfDay(new Date(Math.max(...times)))) : endOfDay(now);
    return { from, to };
  }
  const days = PRESET_DAYS[state.preset] || 30;
  return { from: startOfDay(new Date(Date.now() - (days - 1) * DAY_MS)), to: endOfDay(now) };
}

const titleOf = m => (m.meetingTitle || '—').trim() || '—';
const seriesKeyOf = m => m.groupId || UNGROUPED;

function inWindow(m, from, to) {
  const ms = A.meetingStartMs(m);
  return Number.isFinite(ms) && ms >= from && ms <= to;
}
/** `skip` leaves one dimension out, so each picker can list what it could still offer. */
function matches(m, from, to, skip) {
  if (!inWindow(m, from, to)) return false;
  if (skip !== 'groups' && state.groups.length && !state.groups.includes(seriesKeyOf(m))) return false;
  if (skip !== 'titles' && state.titles.length && !state.titles.includes(titleOf(m))) return false;
  return true;
}

/* ============================ buckets ============================ */

function bucketUnit(from, to) {
  const days = Math.round((to - from) / DAY_MS) + 1;
  if (days <= 31) return 'day';
  if (days <= 210) return 'week';
  return 'month';
}

/** Ordered, gap-free time buckets covering [from, to] — empty periods included. */
function buildBuckets(from, to) {
  const unit = bucketUnit(from, to);
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  if (unit === 'week') cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7)); // Monday-first
  if (unit === 'month') cursor.setDate(1);

  const out = [];
  while (cursor.getTime() <= to && out.length < 400) {
    const start = new Date(cursor);
    const next = new Date(cursor);
    if (unit === 'day') next.setDate(next.getDate() + 1);
    else if (unit === 'week') next.setDate(next.getDate() + 7);
    else next.setMonth(next.getMonth() + 1);

    const endMs = next.getTime() - 1;
    out.push({
      unit,
      start: start.getTime(),
      end: endMs,
      label: unit === 'month'
        ? `${i18n.monthShort(start)} ${String(start.getFullYear()).slice(2)}`
        : `${start.getDate()} ${i18n.monthShort(start)}`,
      full: unit === 'day'
        ? i18n.formatDate(start.toISOString(), { weekday: 'long', day: 'numeric', month: 'long' })
        : unit === 'week'
          ? `${i18n.formatDate(start.toISOString(), { day: 'numeric', month: 'short' })} – ${i18n.formatDate(new Date(endMs).toISOString(), { day: 'numeric', month: 'short' })}`
          : i18n.formatDate(start.toISOString(), { month: 'long', year: 'numeric' }),
      meetings: []
    });
    cursor.setTime(next.getTime());
  }
  return out;
}

function fillBuckets(buckets, meetings) {
  meetings.forEach(m => {
    const ms = A.meetingStartMs(m);
    const b = buckets.find(x => ms >= x.start && ms <= x.end);
    if (b) b.meetings.push(m);
  });
  return buckets;
}

/* ============================ metrics ============================ */

/** Everything the KPI strip and the read-outs need, from one pass over the slice. */
function summarize(list) {
  const people = new Set();
  let durSum = 0, presenceSum = 0, shareSum = 0, parts = 0, absentN = 0, sizeSum = 0;

  list.forEach(m => {
    durSum += A.meetingDurationSeconds(m);
    const entries = Object.entries(m.attendance);
    sizeSum += entries.length;
    entries.forEach(([name, a]) => {
      people.add(name.toLowerCase());
      const st = A.statusFor(a, m);
      shareSum += st.sharePct;
      presenceSum += st.seconds;
      parts++;
    });
    absentN += A.absenteesFor(m, deps.rosterFor(m)).length;
  });

  return {
    meetings: list.length,
    people: people.size,
    parts, durSum, presenceSum, absentN,
    avgLen: list.length ? durSum / list.length : 0,
    avgShare: parts ? shareSum / parts : 0,
    avgSize: list.length ? sizeSum / list.length : 0
  };
}

/** Per-person roll-up across the slice. */
function peopleStats(list) {
  const map = new Map();
  list.forEach(m => {
    Object.entries(m.attendance).forEach(([name, a]) => {
      const key = name.toLowerCase();
      if (!map.has(key)) map.set(key, { name, meetings: 0, seconds: 0, shareSum: 0 });
      const p = map.get(key);
      const st = A.statusFor(a, m);
      p.meetings++; p.seconds += st.seconds; p.shareSum += st.sharePct;
    });
  });
  return Array.from(map.values()).map(p => ({
    ...p,
    avgShare: p.meetings ? p.shareSum / p.meetings : 0
  }));
}

/* ============================ filter bar ============================ */

const CHEVRON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

/**
 * A checkbox popover. Nothing selected means "all" — the common case stays one click
 * away and the button says so rather than listing every option.
 */
function makePicker(sel, { searchable, allLabel, onChange }) {
  const root = $(sel);
  // the field carries the popover's own id, so it is nameable and the browser can tell the
  // two pickers apart the way it does with any other named field
  const searchId = `${root.id}-search`;
  root.innerHTML =
    `<button class="pick-btn" type="button" aria-expanded="false"><span class="pick-label"></span>${CHEVRON}</button>
     <div class="pick-menu" hidden>
       ${searchable ? `<div class="pick-search"><input class="field" type="search" id="${searchId}" name="${searchId}" autocomplete="off" data-i18n-aria="pickSearchLabel"></div>` : ''}
       <div class="pick-list"></div>
       <div class="pick-foot"><button class="pick-clear btn subtle" type="button"></button><span class="pick-count mono"></span></div>
     </div>`;
  i18n.applyI18n(root);   // built after the page-wide pass, so it takes its own strings here

  const btn = $('.pick-btn', root);
  const menu = $('.pick-menu', root);
  const list = $('.pick-list', root);
  const search = $('.pick-search input', root);
  const p = { root, btn, menu, list, search, items: [], selected: [], allLabel, onChange, query: '' };

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const opening = menu.hidden;
    closeAllPickers();
    menu.hidden = !opening;
    btn.setAttribute('aria-expanded', String(opening));
    if (opening) { drawList(p); if (search) search.focus(); }
  });
  menu.addEventListener('click', e => e.stopPropagation());
  if (search) {
    search.addEventListener('input', () => { p.query = search.value.trim().toLowerCase(); drawList(p); });
    search.addEventListener('keydown', e => { if (e.key === 'Escape') { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
  }
  $('.pick-clear', root).addEventListener('click', () => { p.selected = []; p.onChange([]); });

  pickers.set(sel, p);
  return p;
}

function closeAllPickers() {
  pickers.forEach(p => { p.menu.hidden = true; p.btn.setAttribute('aria-expanded', 'false'); });
}

function drawList(p) {
  const q = p.query;
  const shown = q ? p.items.filter(it => it.label.toLowerCase().includes(q)) : p.items;
  p.list.textContent = '';
  if (!shown.length) {
    const none = document.createElement('div');
    none.className = 'pick-none';
    none.textContent = t('pickEmpty');
    p.list.appendChild(none);
  }
  shown.forEach(it => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pick-item' + (p.selected.includes(it.id) ? ' on' : '');
    row.dataset.id = it.id;

    const box = document.createElement('span');
    box.className = 'pick-box';
    row.appendChild(box);

    if (it.color) {
      const dot = document.createElement('span');
      dot.className = 'gdot';
      dot.style.background = it.color;
      row.appendChild(dot);
    }
    const label = document.createElement('span');
    label.className = 'pick-name';
    label.textContent = it.label;                       // meeting titles are untrusted text
    row.appendChild(label);

    const hint = document.createElement('span');
    hint.className = 'pick-hint mono';
    hint.textContent = it.hint == null ? '' : String(it.hint);
    row.appendChild(hint);

    row.addEventListener('click', () => {
      const next = p.selected.includes(it.id) ? p.selected.filter(x => x !== it.id) : p.selected.concat(it.id);
      p.selected = next;
      row.classList.toggle('on');
      syncPickerChrome(p);
      p.onChange(next);
    });
    p.list.appendChild(row);
  });
  syncPickerChrome(p);
}

function syncPickerChrome(p) {
  txt($('.pick-label', p.root), p.selected.length ? t('pickSelected', { count: p.selected.length }) : p.allLabel);
  p.root.classList.toggle('active', p.selected.length > 0);
  txt($('.pick-count', p.root), p.items.length ? `${p.items.length}` : '');
  txt($('.pick-clear', p.root), t('pickClear'));
  const search = p.search;
  if (search) search.placeholder = t('pickSearch');
}

/** Rebuild only while the menu is closed, so toggling an item can't steal focus. */
function setPicker(sel, items, selected, allLabel) {
  const p = pickers.get(sel);
  if (!p) return;
  p.items = items;
  p.selected = selected.slice();
  p.allLabel = allLabel;                 // re-read every render so it follows the locale
  if (p.menu.hidden) drawList(p); else syncPickerChrome(p);
}

/* ============================ persistence ============================ */

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { store.set(FILTER_KEY, { ...state }); }, 250);
}

async function restore() {
  try {
    const saved = await store.get(FILTER_KEY);
    if (saved && typeof saved === 'object') {
      if (typeof saved.preset === 'string') state.preset = saved.preset;
      if (typeof saved.from === 'string') state.from = saved.from;
      if (typeof saved.to === 'string') state.to = saved.to;
      if (Array.isArray(saved.groups)) state.groups = saved.groups.filter(x => typeof x === 'string');
      if (Array.isArray(saved.titles)) state.titles = saved.titles.filter(x => typeof x === 'string');
      state.archived = saved.archived === true;
    }
  } catch { /* first run */ }
}

/* ============================ table view ============================ */

function setTable(key, head, rows) { tables.set(key, { head, rows }); }

function renderTable(card, key) {
  const box = $('.cc-table', card);
  const data = tables.get(key);
  box.textContent = '';
  if (!data) return;
  const table = document.createElement('table');
  table.className = 'rc-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  data.head.forEach((h, i) => {
    const th = document.createElement('th');
    th.textContent = h;
    if (i) th.className = 'num';
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  data.rows.forEach(r => {
    const tr = document.createElement('tr');
    r.forEach((cell, i) => {
      const td = document.createElement('td');
      td.textContent = cell;
      if (i) td.className = 'num mono';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  box.appendChild(table);
}

function bindCards() {
  $$('#charts .chart-card').forEach(card => {
    const toggle = $('.cc-toggle', card);
    if (!toggle) return;
    toggle.addEventListener('click', () => {
      const showTable = card.classList.toggle('as-table');
      toggle.setAttribute('aria-pressed', String(showTable));
      toggle.title = showTable ? t('chartView') : t('tableView');
      $('canvas', card).hidden = showTable;
      $('.cc-table', card).hidden = !showTable;
      if (showTable) renderTable(card, card.dataset.chart);
      else { hideTip(); renderAnalytics(); }
    });
  });
}

/* ============================ rendering ============================ */

export async function initAnalytics(dependencies) {
  deps = dependencies;
  await restore();

  makePicker('#pick-series', { searchable: false, allLabel: t('pickAllSeries'), onChange: v => { state.groups = v; persist(); renderAnalytics(); } });
  makePicker('#pick-titles', { searchable: true, allLabel: t('pickAllMeetings'), onChange: v => { state.titles = v; persist(); renderAnalytics(); } });
  document.addEventListener('click', closeAllPickers);

  $$('#range-seg button').forEach(b => b.addEventListener('click', () => {
    state.preset = b.dataset.preset;
    persist();
    renderAnalytics();
  }));
  $$('#range-from, #range-to').forEach(el => el.addEventListener('change', () => {
    state.from = $('#range-from').value;
    state.to = $('#range-to').value;
    state.preset = 'custom';
    persist();
    renderAnalytics();
  }));
  $('#filter-archived').addEventListener('change', e => {
    state.archived = e.target.checked;
    persist();
    renderAnalytics();
  });
  $('#filters-reset').addEventListener('click', () => {
    state.preset = '30d'; state.from = ''; state.to = ''; state.groups = []; state.titles = []; state.archived = false;
    persist();
    renderAnalytics();
  });
  $('#btn-analytics-csv').addEventListener('click', exportSlice);
  $('#insights').addEventListener('click', e => {
    const card = e.target.closest('[data-meeting]');
    if (card) deps.openMeeting(card.dataset.meeting);
  });

  bindCards();
}

export function renderAnalytics() {
  if (!deps) return;
  const empty = $('#analytics-empty'), body = $('#analytics-body');
  // "nothing here at all" is about the register, not about the slice: a set of meetings that are
  // all in the archive falls through to the filter bar, where the switch that counts them is
  if (!deps.history().length) { body.hidden = true; empty.classList.add('visible'); return; }
  body.hidden = false; empty.classList.remove('visible');
  const all = inScope();

  const { from, to } = resolveRange();
  syncFilterUI(from, to);

  const scoped = all.filter(m => matches(m, from, to)).sort((a, b) => A.meetingStartMs(a) - A.meetingStartMs(b));
  const none = $('#analytics-none');
  $('#charts').hidden = !scoped.length;
  $('#insights').hidden = !scoped.length;
  $('#analytics-kpi').hidden = !scoped.length;
  none.classList.toggle('visible', !scoped.length);

  renderSummary(scoped, from, to);
  if (!scoped.length) return;

  const span = to - from + 1;
  const prev = all.filter(m => matches(m, from - span, from - 1));
  const buckets = fillBuckets(buildBuckets(from, to), scoped);
  const pal = C.palette();

  renderKpi(scoped, prev);
  renderActivity(buckets, pal);
  renderDuration(buckets, pal);
  renderRhythm(scoped, pal);
  renderShare(scoped, pal);
  renderTopMeetings(scoped, pal);
  renderTopPeople(scoped, pal);
  renderSeries(scoped, pal);
  renderInsights(scoped, prev);

  // a card left flipped to its table stays flipped across re-renders
  $$('#charts .chart-card').forEach(card => {
    const flipped = card.classList.contains('as-table');
    if (flipped) renderTable(card, card.dataset.chart);
    const toggle = $('.cc-toggle', card);
    if (toggle) toggle.title = flipped ? t('chartView') : t('tableView');
  });
}

/* ---- filter chrome ---- */

function syncFilterUI(from, to) {
  $$('#range-seg button').forEach(b => b.classList.toggle('on', b.dataset.preset === state.preset));
  $('#filterbar').classList.toggle('custom', state.preset === 'custom');
  const fromEl = $('#range-from'), toEl = $('#range-to');
  if (document.activeElement !== fromEl) fromEl.value = dayKey(from);
  if (document.activeElement !== toEl) toEl.value = dayKey(to);

  const all = inScope();

  // Each picker lists what the *other* filters still allow, with live counts.
  const byGroup = new Map();
  all.filter(m => matches(m, from, to, 'groups')).forEach(m => {
    const k = seriesKeyOf(m);
    byGroup.set(k, (byGroup.get(k) || 0) + 1);
  });
  const groupItems = deps.groups()
    .filter(g => byGroup.has(g.id) || state.groups.includes(g.id))
    .map(g => ({ id: g.id, label: g.name, hint: byGroup.get(g.id) || 0, color: `var(${deps.groupColorVar(g)})` }));
  if (byGroup.has(UNGROUPED) || state.groups.includes(UNGROUPED)) {
    groupItems.push({ id: UNGROUPED, label: t('pickNone'), hint: byGroup.get(UNGROUPED) || 0, color: 'var(--absent)' });
  }
  setPicker('#pick-series', groupItems, state.groups, t('pickAllSeries'));

  const byTitle = new Map();
  all.filter(m => matches(m, from, to, 'titles')).forEach(m => {
    const k = titleOf(m);
    byTitle.set(k, (byTitle.get(k) || 0) + 1);
  });
  state.titles.forEach(k => { if (!byTitle.has(k)) byTitle.set(k, 0); });
  const titleItems = Array.from(byTitle.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, n]) => ({ id: label, label, hint: n }));
  setPicker('#pick-titles', titleItems, state.titles, t('pickAllMeetings'));

  // the switch only earns its place while there is an archive to count
  const archive = deps.history().some(m => m.archived);
  $('#filter-archived').closest('.switch-row').hidden = !archive;
  $('#filter-archived').checked = state.archived;

  const dirty = state.preset !== '30d' || state.groups.length || state.titles.length || state.archived;
  $('#filters-reset').hidden = !dirty;
}

function renderSummary(scoped, from, to) {
  const people = new Set();
  scoped.forEach(m => Object.keys(m.attendance).forEach(n => people.add(n.toLowerCase())));
  const fmt = ms => i18n.formatDate(new Date(ms).toISOString(), { day: 'numeric', month: 'short', year: 'numeric' });
  txt($('#filter-summary'), `${fmt(from)} – ${fmt(to)} · ${t('summaryMeetings', { count: scoped.length })} · ${t('summaryPeople', { count: people.size })}`);
}

/* ---- KPI strip ---- */

function renderKpi(scoped, prev) {
  const now = summarize(scoped);
  const before = prev.length ? summarize(prev) : null;

  // `eps` is the smallest change worth reporting for that unit; `good` is only set
  // where a direction is unambiguously better, so counts stay uncoloured.
  const tiles = [
    { key: 'kpiMeetings', text: num(now.meetings), cur: now.meetings, was: before && before.meetings, eps: 0.5, fmt: v => num(v) },
    { key: 'kpiHours', text: i18n.formatDuration(now.durSum), cur: now.durSum, was: before && before.durSum, eps: 60, fmt: v => i18n.formatDuration(v) },
    { key: 'kpiPeople', text: num(now.people), cur: now.people, was: before && before.people, eps: 0.5, fmt: v => num(v) },
    { key: 'kpiAttendance', text: pct(now.avgShare), cur: now.avgShare, was: before && before.avgShare, eps: 0.5, fmt: v => `${num(v)} ${t('unitPoints')}`, good: true },
    { key: 'kpiSize', text: num(now.avgSize, 1), cur: now.avgSize, was: before && before.avgSize, eps: 0.05, fmt: v => num(v, 1) }
  ];

  const box = $('#analytics-kpi');
  box.textContent = '';
  tiles.forEach(tile => {
    const el = document.createElement('div');
    el.className = 'stat';

    const k = document.createElement('div');
    k.className = 'k';
    k.textContent = tile.text;
    el.appendChild(k);

    const lbl = document.createElement('div');
    lbl.className = 'lbl eyebrow';
    lbl.textContent = t(tile.key);
    el.appendChild(lbl);

    const delta = document.createElement('div');
    delta.className = 'delta mono';
    const diff = tile.was == null ? null : tile.cur - tile.was;
    if (diff == null) {
      delta.classList.add('muted');
      delta.textContent = '—';
      delta.title = t('kpiNoPrev');
    } else if (Math.abs(diff) < tile.eps) {
      delta.classList.add('muted');
      delta.textContent = t('deltaSame');
      delta.title = t('kpiVsPrev');
    } else {
      if (tile.good) delta.classList.add(diff > 0 ? 'up' : 'down');
      delta.textContent = `${diff > 0 ? '▲' : '▼'} ${tile.fmt(Math.abs(diff))}`;
      delta.title = t('kpiVsPrev');
    }
    el.appendChild(delta);
    box.appendChild(el);
  });
}

/* ---- charts ---- */

const unitHint = unit => t(unit === 'day' ? 'bucketDaily' : unit === 'week' ? 'bucketWeekly' : 'bucketMonthly');

function renderActivity(buckets, pal) {
  const labels = buckets.map(b => b.label);
  const values = buckets.map(b => b.meetings.length);
  txt($('#sub-activity'), unitHint(buckets[0] ? buckets[0].unit : 'day'));

  const peoplePer = buckets.map(b => {
    const set = new Set();
    b.meetings.forEach(m => Object.keys(m.attendance).forEach(n => set.add(n.toLowerCase())));
    return set.size;
  });
  const hoursPer = buckets.map(b => b.meetings.reduce((s, m) => s + A.meetingDurationSeconds(m), 0));

  C.area($('#chart-activity'), {
    pal, labels, values, integer: true, color: pal.present,
    titles: buckets.map(b => b.full),
    seriesLabel: t('unitMeetings'),
    fmt: v => num(v),
    extraRows: i => [
      { value: num(peoplePer[i]), label: t('unitPeople') },
      { value: i18n.formatDuration(hoursPer[i]), label: t('unitTotalTime') }
    ]
  });
  setTable('activity', [t('colBucket'), t('colMeetingsCount'), t('colGroupPeople'), t('colTotalTime')],
    buckets.map((b, i) => [b.full, num(values[i]), num(peoplePer[i]), i18n.formatDuration(hoursPer[i])]));
}

function renderDuration(buckets, pal) {
  const labels = buckets.map(b => b.label);
  const length = buckets.map(b => b.meetings.length
    ? mins(b.meetings.reduce((s, m) => s + A.meetingDurationSeconds(m), 0) / b.meetings.length) : 0);
  const presence = buckets.map(b => {
    let total = 0, n = 0;
    b.meetings.forEach(m => Object.values(m.attendance).forEach(a => { total += A.liveSecondsFor(a, m); n++; }));
    return n ? mins(total / n) : 0;
  });
  txt($('#sub-duration'), unitHint(buckets[0] ? buckets[0].unit : 'day'));

  C.grouped($('#chart-duration'), {
    pal, labels, integer: true,
    titles: buckets.map(b => b.full),
    series: [
      { label: t('chartLegendAvgDuration'), color: pal.cat[0], values: length },
      { label: t('chartLegendAvgTimeInCall'), color: pal.cat[1], values: presence }
    ],
    fmt: v => `${num(v)} ${t('unitMin')}`,
    axisFmt: v => num(v)
  });
  setTable('duration', [t('colBucket'), t('chartLegendAvgDuration'), t('chartLegendAvgTimeInCall')],
    buckets.map((b, i) => [b.full, num(length[i]), num(presence[i])]));
}

function renderRhythm(scoped, pal) {
  const days = Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, 1 + i).toLocaleDateString(i18n.localeTag(), { weekday: 'short' }));

  let lo = 23, hi = 0, seen = false;
  scoped.forEach(m => {
    const d = new Date(A.meetingStartMs(m));
    if (Number.isNaN(d.getTime())) return;
    lo = Math.min(lo, d.getHours()); hi = Math.max(hi, d.getHours()); seen = true;
  });
  if (!seen) { lo = 8; hi = 17; }
  while (hi - lo < 7) { if (lo > 0) lo--; else if (hi < 23) hi++; else break; if (hi - lo < 7 && hi < 23) hi++; }

  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const grid = days.map(() => hours.map(() => 0));
  scoped.forEach(m => {
    const d = new Date(A.meetingStartMs(m));
    if (Number.isNaN(d.getTime())) return;
    const row = (d.getDay() + 6) % 7;
    const col = hours.indexOf(d.getHours());
    if (col >= 0) grid[row][col]++;
  });

  C.heat($('#chart-rhythm'), {
    pal, rowLabels: days, colLabels: hours.map(h => pad2(h)),
    values: grid, color: pal.present,
    seriesLabel: t('unitMeetings'),
    fmt: v => num(v)
  });
  setTable('rhythm', [t('colWeekday')].concat(hours.map(h => `${pad2(h)}:00`)),
    days.map((d, r) => [d].concat(grid[r].map(v => num(v)))));
}

function renderShare(scoped, pal) {
  const bins = [0, 0, 0, 0, 0];
  scoped.forEach(m => Object.values(m.attendance).forEach(a => {
    const s = A.sharePct(a, m);
    bins[Math.min(4, Math.floor(s / 20))]++;
  }));
  const labels = bins.map((_, i) => `${i * 20}–${(i + 1) * 20}%`);

  C.columns($('#chart-share'), {
    pal, labels, values: bins, integer: true, color: pal.present,
    alphas: [0.28, 0.46, 0.64, 0.82, 1],           // ordered bins → one hue, light→dark
    seriesLabel: t('unitParticipations'),
    fmt: v => num(v)
  });
  setTable('share', [t('colShare'), t('colParticipations')], labels.map((l, i) => [l, num(bins[i])]));
}

function renderTopMeetings(scoped, pal) {
  const counts = new Map();
  scoped.forEach(m => {
    const k = titleOf(m);
    if (!counts.has(k)) counts.set(k, { n: 0, secs: 0 });
    const e = counts.get(k);
    e.n++; e.secs += A.meetingDurationSeconds(m);
  });
  const top = Array.from(counts.entries()).sort((a, b) => b[1].n - a[1].n || b[1].secs - a[1].secs).slice(0, 7);

  C.rankedBars($('#chart-top'), {
    pal, labels: top.map(([k]) => k), values: top.map(([, v]) => v.n),
    color: pal.present, seriesLabel: t('unitMeetings'), fmt: v => num(v),
    extraRows: i => [{ value: i18n.formatDuration(top[i][1].secs), label: t('unitTotalTime') }]
  });
  setTable('top', [t('colMeeting'), t('colMeetingsCount'), t('colTotalTime')],
    top.map(([k, v]) => [k, num(v.n), i18n.formatDuration(v.secs)]));
}

function renderTopPeople(scoped, pal) {
  const top = peopleStats(scoped).sort((a, b) => b.seconds - a.seconds || b.meetings - a.meetings).slice(0, 7);

  C.rankedBars($('#chart-people'), {
    pal, labels: top.map(p => p.name), values: top.map(p => p.seconds),
    color: pal.present, seriesLabel: t('unitTotalTime'),
    fmt: v => i18n.formatDuration(v),
    extraRows: i => [
      { value: num(top[i].meetings), label: t('unitMeetings') },
      { value: pct(top[i].avgShare), label: t('colAvgRate') }
    ]
  });
  setTable('people', [t('colName'), t('colTotalTimeP'), t('colMeetingsCount'), t('colAvgRate')],
    top.map(p => [p.name, i18n.formatDuration(p.seconds), num(p.meetings), pct(p.avgShare)]));
}

function renderSeries(scoped, pal) {
  const card = $('[data-chart="series"]');
  const byGroup = new Map();
  scoped.forEach(m => {
    if (!m.groupId) return;
    if (!byGroup.has(m.groupId)) byGroup.set(m.groupId, []);
    byGroup.get(m.groupId).push(m);
  });
  card.hidden = byGroup.size < 2;   // a comparison needs at least two things to compare
  if (card.hidden) return;

  const rows = Array.from(byGroup.entries()).map(([id, list]) => {
    const g = deps.groupById(id);
    const s = summarize(list);
    // colour follows the series itself, so filtering never repaints the survivors
    return {
      name: (g && g.name) || '—', color: tokenColor(deps.groupColorVar(g)),
      share: Math.round(s.avgShare), sessions: list.length, people: s.people,
      hours: s.durSum
    };
  }).sort((a, b) => b.share - a.share || b.sessions - a.sessions).slice(0, 7);

  C.rankedBars($('#chart-series'), {
    pal, labels: rows.map(r => r.name), values: rows.map(r => r.share),
    colors: rows.map(r => r.color),
    seriesLabel: t('colGroupAttendance'), fmt: v => pct(v),
    extraRows: i => [
      { value: num(rows[i].sessions), label: t('colSessions') },
      { value: num(rows[i].people), label: t('unitPeople') },
      { value: i18n.formatDuration(rows[i].hours), label: t('colTotalTime') }
    ]
  });
  setTable('series', [t('colGroupName'), t('colGroupAttendance'), t('colSessions'), t('unitPeople'), t('colTotalTime')],
    rows.map(r => [r.name, pct(r.share), num(r.sessions), num(r.people), i18n.formatDuration(r.hours)]));
}

/* ---- read-outs ---- */

function renderInsights(scoped, prev) {
  const days = Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, 1 + i).toLocaleDateString(i18n.localeTag(), { weekday: 'long' }));
  const perDay = new Array(7).fill(0), perHour = new Array(24).fill(0);
  let longest = null, largest = null;

  scoped.forEach(m => {
    const d = new Date(A.meetingStartMs(m));
    if (!Number.isNaN(d.getTime())) { perDay[(d.getDay() + 6) % 7]++; perHour[d.getHours()]++; }
    const dur = A.meetingDurationSeconds(m);
    if (!longest || dur > longest.dur) longest = { m, dur };
    const size = Object.keys(m.attendance).length;
    if (!largest || size > largest.size) largest = { m, size };
  });

  const people = peopleStats(scoped);
  const regular = people.slice().sort((a, b) => b.meetings - a.meetings || b.seconds - a.seconds)[0];
  // among people seen often enough for a rate to mean anything
  const eligible = people.filter(p => p.meetings >= Math.min(3, scoped.length));
  const steady = eligible.slice().sort((a, b) => b.avgShare - a.avgShare || b.meetings - a.meetings)[0];
  const fleeting = eligible.filter(p => p.avgShare < 50).sort((a, b) => a.avgShare - b.avgShare)[0];

  const busiestDay = perDay.indexOf(Math.max(...perDay));
  const peakHour = perHour.indexOf(Math.max(...perHour));
  const now = summarize(scoped);
  const before = prev.length ? summarize(prev) : null;
  const trend = before ? Math.round(now.avgShare) - Math.round(before.avgShare) : null;

  const cards = [
    perDay[busiestDay] > 0 && { key: 'insightBusiestDay', value: days[busiestDay], hint: t('summaryMeetings', { count: perDay[busiestDay] }) },
    perHour[peakHour] > 0 && { key: 'insightPeakHour', value: `${pad2(peakHour)}:00`, hint: t('summaryMeetings', { count: perHour[peakHour] }) },
    longest && { key: 'insightLongest', value: i18n.formatDuration(longest.dur), hint: titleOf(longest.m), meeting: longest.m.id },
    largest && { key: 'insightLargest', value: largest.size === 1 ? t('peopleOne') : t('peopleN', { count: largest.size }), hint: titleOf(largest.m), meeting: largest.m.id },
    regular && { key: 'insightRegular', value: regular.name, hint: t('insightAttendedOf', { count: regular.meetings, total: scoped.length }) },
    steady && { key: 'insightSteadiestPerson', value: steady.name, hint: t('insightShareOf', { count: Math.round(steady.avgShare), total: steady.meetings }) },
    fleeting && { key: 'insightFleetingPerson', value: fleeting.name, hint: t('insightShareOf', { count: Math.round(fleeting.avgShare), total: fleeting.meetings }) },
    trend != null && { key: 'insightTrend', value: `${trend > 0 ? '+' : ''}${num(trend)} ${t('unitPoints')}`, hint: t('kpiVsPrev'), tone: trend === 0 ? '' : (trend > 0 ? 'up' : 'down') }
  ].filter(Boolean);

  const box = $('#insights-grid');
  box.textContent = '';
  cards.forEach(c => {
    const el = document.createElement(c.meeting ? 'button' : 'div');
    el.className = 'ins' + (c.tone ? ` ${c.tone}` : '');
    if (c.meeting) { el.type = 'button'; el.dataset.meeting = c.meeting; }

    const label = document.createElement('div');
    label.className = 'ins-label eyebrow';
    label.textContent = t(c.key);
    el.appendChild(label);

    const value = document.createElement('div');
    value.className = 'ins-value';
    value.textContent = c.value;
    el.appendChild(value);

    const hint = document.createElement('div');
    hint.className = 'ins-hint';
    hint.textContent = c.hint;
    el.appendChild(hint);

    box.appendChild(el);
  });
}

/* ---- export ---- */

function exportSlice() {
  const { from, to } = resolveRange();
  const scoped = inScope().filter(m => matches(m, from, to)).sort((a, b) => A.meetingStartMs(a) - A.meetingStartMs(b));
  if (!scoped.length) return;

  const rows = [[t('colDate'), t('colMeeting'), t('colGroup'), t('statLength'), t('colPeople'),
    t('legendAbsentP'), t('csvPresentMinutes'), t('statAvgAttendance')]];
  scoped.forEach(m => {
    const g = m.groupId ? deps.groupById(m.groupId) : null;
    const entries = Object.values(m.attendance);
    const presence = entries.reduce((s, a) => s + A.liveSecondsFor(a, m), 0);
    const share = entries.length ? Math.round(entries.reduce((s, a) => s + A.sharePct(a, m), 0) / entries.length) : 0;
    rows.push([
      dayKey(A.meetingStartMs(m)),
      titleOf(m), (g && g.name) || '',
      i18n.formatDuration(A.meetingDurationSeconds(m)),
      entries.length,
      A.absenteesFor(m, deps.rosterFor(m)).length,
      Math.round(presence / 60),
      `${share}%`
    ]);
  });
  deps.exportCSV(rows, `analytics-${dayKey(from)}_${dayKey(to)}.csv`);
}
