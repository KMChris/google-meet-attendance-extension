import * as store from '../src/lib/storage.js';
import * as A from '../src/lib/attendance.js';
import * as i18n from '../src/lib/i18n.js';
import * as sheets from '../src/lib/sheets-api.js';
import * as sheetsSync from '../src/lib/sheets-sync.js';
import * as importers from '../src/lib/importers.js';
import { initAnalytics, renderAnalytics } from './analytics.js';
import { initTips } from './tooltip.js';

const { t } = i18n;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ------------------------------ state ------------------------------ */
let history = [];         // normalized meetings, newest-first
let trash = [];           // deleted meetings waiting out the retention window
let groups = [];
let settings = {};
let roster = [];          // global default roster
let autoTrack = true;     // own storage key, not part of settings
let curMeetingId = null;
let curGroupId = null;
let assignContextIds = []; // meeting ids awaiting a series assignment
let groupsArchive = false; // the series view is showing the archive rather than the active list
let meetingsList = 'active'; // which meetings list is on screen: 'active' | 'archive' | 'trash'

const GRP_COLORS = { teal: '--grp-teal', amber: '--grp-amber', violet: '--grp-violet', rose: '--grp-rose', sky: '--grp-sky', lime: '--grp-lime' };
const GRP_KEYS = Object.keys(GRP_COLORS);

/* ------------------------------ utils ------------------------------ */
// Quotes included: half of these strings land inside an HTML attribute, and a participant name
// or a meeting title can hold one.
function esc(s) {
  const d = document.createElement('div'); d.textContent = s == null ? '' : s;
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function initials(name) {
  const p = String(name || '').trim().split(/\s+/);
  return ((p.length >= 2 ? p[0][0] + p[p.length - 1][0] : (name || '').slice(0, 2)) || '?').toUpperCase();
}
function hash(str) { let h = 0; for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h); return Math.abs(h); }
function avatarStyle(name) {
  const v = GRP_COLORS[GRP_KEYS[hash(name) % GRP_KEYS.length]];
  return `background:color-mix(in srgb, var(${v}) 16%, var(--panel));color:var(${v})`;
}
const fmtDur = i18n.formatDuration;
function fmtHMS(secs) {
  secs = Math.floor(secs || 0);
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}
function setStat(el, value, unit) { el.innerHTML = unit ? `${value}<span class="u">${esc(unit)}</span>` : `${value}`; }

let toastTimer;
function toast(msg) {
  const el = $('#toast'); if (!el) return;
  el.textContent = msg; el.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 2400);
}
function groupById(id) { return groups.find(g => g.id === id) || null; }
function effectiveRoster(meeting) {
  const g = meeting.groupId ? groupById(meeting.groupId) : null;
  return (g && g.roster && g.roster.length) ? g.roster : roster;
}

/* ------------------------------ theme ------------------------------ */
function applyTheme(theme) {
  const root = document.documentElement;
  // the tokens move under everything that transitions a colour, so the swap lands with
  // transitions off (see .theme-swap in ui.css) and they are let back in once it has settled
  root.classList.add('theme-swap');
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  void root.offsetWidth;   // resolve the new colours before transitions come back
  requestAnimationFrame(() => root.classList.remove('theme-swap'));
  $$('#theme-seg button').forEach(b => b.classList.toggle('on', b.dataset.themeVal === (theme || 'system')));
  if ($('#view-analytics').classList.contains('on')) renderAnalytics();
}
// Redraw charts when the OS theme flips while in 'system' mode.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((settings.theme || 'system') === 'system' && $('#view-analytics').classList.contains('on')) renderAnalytics();
});

/* ------------------------------ router ------------------------------ */
/**
 * Every view is a URL: #meetings · #meeting=<id> · #groups · #group=<id>[&person=<name>] ·
 * #people[&person=<name>] · #analytics · #settings.
 *
 * Nothing renders except through route(), so an in-app click, the browser's back button and a
 * deep link from the popup all land in the same place. `window.history` is spelled out because
 * `history` is the meetings array in this module.
 */
const VIEWS = ['meetings', 'groups', 'people', 'analytics', 'settings'];
const PARENT_TAB = { detail: 'meetings', group: 'groups' };
let renderedRoute = null;
let previousRoute = null;

function currentHash() { return (location.hash || '').replace(/^#/, ''); }

function parseRoute(hash) {
  const p = new URLSearchParams(hash);
  if (p.get('meeting')) return { view: 'detail', id: p.get('meeting') };
  if (p.get('group')) return { view: 'group', id: p.get('group'), person: p.get('person') || null };
  const view = VIEWS.find(v => p.has(v)) || 'meetings';
  return {
    view,
    person: view === 'people' ? (p.get('person') || null) : null,
    archive: view === 'groups' && p.has('archive'),
    list: p.has('trash') ? 'trash' : p.has('archive') ? 'archive' : 'active'
  };
}

/** Navigate. `replace` for corrections (a dead id, a view you should not be able to go back to). */
function go(hash, { replace = false } = {}) {
  if (hash === currentHash()) { route(true); return; }
  const depth = (window.history.state && window.history.state.d) || 0;
  if (replace) window.history.replaceState({ d: depth }, '', '#' + hash);
  else window.history.pushState({ d: depth + 1 }, '', '#' + hash);
  route(true);
}
/**
 * The in-app back control is labelled with where it goes ("‹ Meetings"), so it always goes
 * there. When that is also the entry we came from it unwinds history instead of pushing a
 * duplicate — the browser's own back button is what retraces the actual path.
 */
function goBack(fallback) {
  const depth = (window.history.state && window.history.state.d) || 0;
  if (depth > 0 && previousRoute === fallback) window.history.back();
  else go(fallback, { replace: depth === 0 });
}

function route(force) {
  const hash = currentHash();
  if (!force && hash === renderedRoute) return;
  if (hash !== renderedRoute) { previousRoute = renderedRoute; selectionReset(); }
  renderedRoute = hash;
  const r = parseRoute(hash);

  if (r.view === 'detail') {
    const m = history.find(x => x.id === r.id);
    if (!m) { go('meetings', { replace: true }); return; }
    curMeetingId = r.id; curGroupId = null;
    renderDetail(m);
    switchView('detail');
    return;
  }
  if (r.view === 'group') {
    const g = groupById(r.id);
    if (!g) { go('groups', { replace: true }); return; }
    curGroupId = r.id; curMeetingId = null;
    renderGroup(g);                    // rebuilds the matrix, so any open row folds away
    switchView('group');
    if (r.person) expandSeriesPerson(g, r.person);
    return;
  }
  curMeetingId = null; curGroupId = null;
  // read before the view draws itself
  groupsArchive = r.view === 'groups' && !!r.archive;
  const list = r.view === 'meetings' ? r.list : 'active';
  if (list !== meetingsList) meetingsPage = 1;   // another list starts at its own first page
  meetingsList = list;
  switchView(r.view);
  if (r.view === 'people' && r.person) expandPerson(r.person);
}

// go() renders straight after pushState; these catch the browser's own moves through history.
window.addEventListener('popstate', () => route());
window.addEventListener('hashchange', () => route());

function switchView(name) {
  $$('.tab').forEach(tb => tb.classList.toggle('on', tb.dataset.view === (PARENT_TAB[name] || name)));
  // the rail scrolls on a phone, so the tab just lit may be out of frame
  const lit = $('.tab.on');
  if (lit) lit.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const view = $('#view-' + name);
  if (view && !view.classList.contains('on')) {
    $$('.view').forEach(v => v.classList.remove('on'));
    view.classList.add('on');
  }
  if (name === 'meetings') renderMeetings($('#meeting-search').value.trim());
  if (name === 'groups') renderGroups();
  if (name === 'people') renderPeople($('#people-search').value.trim());
  if (name === 'analytics') renderAnalytics();
}
$$('.tab').forEach(tb => tb.addEventListener('click', () => go(tb.dataset.view)));
$('#btn-back-detail').addEventListener('click', () => goBack('meetings'));
// back to the list this came from: the archive is a list of its own
$('#btn-back-group').addEventListener('click', () => goBack(groupsArchive ? 'groups&archive' : 'groups'));

/* ------------------------------ load ------------------------------ */
async function load() {
  await store.purgeExpiredTrash();   // whatever has waited out its window goes before anything is read
  const [h, tr, g, s, r, at] = await Promise.all([
    store.getHistory(), store.getTrash(), store.getGroups(), store.getSettings(), store.getRoster(), store.getAutoTrack()
  ]);
  history = h.map(A.normalizeMeeting).sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  trash = tr.map(A.normalizeMeeting).sort((a, b) => (Date.parse(b.deletedAt) || 0) - (Date.parse(a.deletedAt) || 0));
  groups = g; settings = s; roster = r; autoTrack = at;
  applyTheme(settings.theme || 'system');
  renderReadout();
  syncSettingsUI();
  route(true);   // whatever is on screen is re-read from the fresh data
  liveSettled();
}

function renderReadout() {
  const people = new Set();
  let shareSum = 0, shareN = 0;
  history.forEach(m => {
    Object.keys(m.attendance).forEach(n => people.add(n.toLowerCase()));
    Object.values(m.attendance).forEach(a => { shareSum += A.sharePct(a, m); shareN++; });
  });
  const att = shareN ? Math.round(shareSum / shareN) : 0;
  $('#readout').innerHTML =
    `${t('readoutMeetings').toUpperCase()} <b>${history.length}</b> · ${t('readoutPeople').toUpperCase()} <b>${people.size}</b> · ${t('readoutPresent').toUpperCase()} <b>${att}%</b>`;
}

/* ====================== WHAT IS HAPPENING RIGHT NOW ======================
 * Every row on the list is a record of something that already happened — except when it is not.
 * Two states have to read differently from the rest, and neither can be told apart by presence
 * alone, because a record nobody closed has everyone still standing inside it:
 *
 *   live       — the call is running. It rewrites itself every few seconds and its figures grow
 *                with the clock, so the page has to keep up or it is showing yesterday's numbers.
 *   unfinished — nothing ended the record: the browser closed on it, the extension went away
 *                mid-call, or it came in from a CSV exported during a call. Nothing about it is
 *                moving, and calling it live would be a lie the panel went on telling for hours.
 *
 * Both are watched from two directions, because both can change without the other noticing: the
 * store says when something was written, and the clock says when something aged (a call that goes
 * quiet stops being live three minutes later, and nothing is written anywhere when it does).
 */
const LIVE_TICK_MS = 1000;
const LIVE_SETTLE_MS = 1200;  // a live call writes every few seconds; one repaint covers a burst
const LIVE_BEAT = 10;         // and its derived figures are redrawn on this many ticks

let liveTarget = null;   // the meeting the masthead marker leads to (null: the list)
let livePainted = '';    // the state the page was last drawn with
let liveRefresh = null;  // the debounce in flight
let liveBusy = false;    // a repaint the page was too busy for, waiting for it to be idle
let liveBeats = 0;

/** Only a record without an end can be live or unfinished — the rest are settled. */
function openMeetings() { return history.filter(m => !m.endedAt); }

/** What the markers are drawn from, as a string, so a repaint follows a change and nothing else. */
function liveDigest() {
  return openMeetings().map(m => `${m.id}:${A.meetingState(m)}`).join('|');
}

/** Where a record nothing ended stops being known — and where a repair would close it. */
function lastSignIso(m) {
  const at = A.lastActivityMs(m) || Date.parse(m && m.date) || 0;
  return at ? new Date(at).toISOString() : null;
}
/** Day and hour together: a bare time would not say which day was the last anything was heard. */
function whenShort(iso) {
  if (!iso) return '—';
  return `${i18n.formatDate(iso, { day: 'numeric', month: 'short' })}, ${i18n.formatTime(iso)}`;
}

/** Point a clock at the moment it counts from, or take it out of the ticker's hands. */
function setSince(el, since) {
  if (!el) return;
  if (Number.isFinite(since) && since > 0) el.dataset.since = String(since);
  else { delete el.dataset.since; el.textContent = ''; }
}

/** Every running clock on the page, wherever it is, off the one timer. */
function tickClocks(now = Date.now()) {
  $$('[data-since]').forEach(el => {
    el.textContent = fmtHMS(Math.max(0, (now - Number(el.dataset.since)) / 1000));
  });
}

/**
 * The marker a record wears while it is not (yet) one: still running, or never ended. The clock
 * inside it is left to the ticker — the markup only says where it counts from.
 */
function stateTag(m, state = A.meetingState(m)) {
  if (state === 'live') {
    const since = A.meetingStartMs(m);
    const clock = Number.isFinite(since) ? `<span class="clock" data-since="${since}"></span>` : '';
    return `<span class="live-tag" title="${esc(t('liveNowHint'))}"><span class="pip"></span><span class="lb">${esc(t('liveNow'))}</span>${clock}</span>`;
  }
  if (state === 'unfinished') {
    const why = t('unfinishedHint', { time: whenShort(lastSignIso(m)) });
    return `<span class="live-tag warn" title="${esc(why)}"><span class="pip"></span><span class="lb">${esc(t('unfinished'))}</span></span>`;
  }
  return '';
}

/**
 * The marker beside the name of the app: whatever view is open, a call in progress is on screen,
 * and it leads to the call it is about. Several at once name none of them — the list does that.
 */
function renderLiveMarker() {
  const live = history.filter(m => A.isLive(m));
  const box = $('#live-now'), clock = $('#live-now-clock');
  box.hidden = !live.length;
  liveTarget = live.length === 1 ? live[0].id : null;
  if (!live.length) { setSince(clock, NaN); return; }

  const many = live.length > 1;
  $('#live-now-label').textContent = many ? `${t('liveNow')} · ${live.length}` : t('liveNow');
  box.title = many ? t('liveNowMany', { count: live.length }) : `${live[0].meetingTitle} — ${t('liveNowOne')}`;
  setSince(clock, many ? NaN : A.meetingStartMs(live[0]));
  tickClocks();
}
$('#live-now').addEventListener('click', () => go(liveTarget ? 'meeting=' + encodeURIComponent(liveTarget) : 'meetings'));

/**
 * A repaint under the user's hands is worse than a number a few seconds old: it rebuilds the rows
 * a selection is spread across, and closes the modal, menu or rename it lands on. So it waits for
 * the page to be idle, and the wait is remembered rather than dropped.
 */
function canRepaint() {
  // `selection.scope` is set by every mount, so what says a batch is being picked is what is in
  // it — the rows are only in the user's hands once something has actually been picked
  return !$('.modal:not([hidden])') && !$('.menu:not([hidden])')
    && !$('.title-line.editing') && !selection.keys.size;
}

/** Redraw whatever shows the two states. Only the two views that carry them are rebuilt. */
function repaintLive() {
  renderLiveMarker();   // one element, never in anyone's way
  if (!canRepaint()) { liveBusy = true; return; }
  liveBusy = false;
  livePainted = liveDigest();

  const view = parseRoute(currentHash()).view;
  if (view === 'meetings') renderMeetings($('#meeting-search').value.trim());
  else if (view === 'detail') { const m = currentMeeting(); if (m) renderDetail(m); }
  else tickClocks();
}

/** The page has just drawn itself from fresh data — nothing to catch up on. */
function liveSettled() {
  renderLiveMarker();
  livePainted = liveDigest();
  liveBusy = false;
}

function onLiveTick() {
  tickClocks();
  liveBeats++;
  const digest = liveDigest();
  // a live call's derived figures (its length, everyone's share of it) move with the clock and
  // not with anything written down, so they are redrawn on a beat of their own
  const beat = digest.includes(':live') && liveBeats % LIVE_BEAT === 0;
  if (digest !== livePainted || liveBusy || beat) repaintLive();
}

/**
 * The store is the other half: the tracker writes into it from the Meet tab, so what a call is
 * doing arrives here as a change rather than as anything this page asked for. The burst a busy
 * call writes is settled into one repaint.
 */
async function refreshFromStore() {
  try {
    const h = await store.getHistory();
    history = h.map(A.normalizeMeeting).sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
    renderReadout();
    livePainted = '';   // the records changed, not just the clock: draw them again
    repaintLive();
  } catch (err) {
    console.warn('[GM Attendance] could not follow the store:', err);
  }
}

function watchLive() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes || !(store.STORAGE_KEYS.HISTORY in changes)) return;
      if (liveRefresh) return;
      liveRefresh = setTimeout(() => { liveRefresh = null; refreshFromStore(); }, LIVE_SETTLE_MS);
    });
  } catch { /* no storage events outside the extension — the clock alone still keeps up */ }
  setInterval(onLiveTick, LIVE_TICK_MS);
  // A hidden page is throttled to about one beat a minute, so what is on screen can be a minute
  // behind the moment it is looked at again: it is read afresh on the way back rather than left
  // to whenever the next beat lands.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshFromStore(); });
}

/* ========================= BATCH SELECTION =========================
 * Selecting starts on the handle a row already carries — a meeting's date badge, a person's
 * avatar — which turns into a checkbox inside the very same box. The toolbar then takes over
 * the list's own header row, so entering and leaving selection never moves anything below.
 */
const selection = { scope: null, keys: new Set(), repaint: null };

function selectionReset() { selection.scope = null; selection.keys.clear(); }

/**
 * Once something is selected the whole row joins in, so a stray click adds to the batch
 * instead of navigating away and losing it. Returns true when the click was consumed.
 */
function selectionClick(key) {
  if (!selection.keys.size) return false;
  if (selection.keys.has(key)) selection.keys.delete(key); else selection.keys.add(key);
  if (selection.repaint) selection.repaint();
  return true;
}

/**
 * The label of a list switch (the archive, the trash): the word, and how much is in there.
 * The count is a span of its own because a narrow screen keeps only it beside the glyph, so
 * the whole text goes on the button as its name for a pointer and for a screen reader.
 */
function setSwitchLabel(btn, word, count) {
  const full = count == null ? word : `${word} (${count})`;
  $('.lbl', btn).innerHTML = `<span class="w">${esc(word)}</span>` +
    (count == null ? '' : `<span class="n">${count}</span>`);
  btn.title = full;
  btn.setAttribute('aria-label', full);
}

/** The handle that stands in for a badge or avatar while selecting. */
function pickHandle(key, inner) {
  return `<span class="pick" data-key="${esc(key)}" role="checkbox" aria-checked="false" tabindex="0"
    title="${esc(t('selectHint'))}"><span class="pick-mark"><svg width="13" height="13" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="3"><path d="m5 12 5 5L19 7"/></svg></span>${inner}</span>`;
}

/**
 * Wire the handles rendered inside `root` and the toolbar that lives in `head`.
 * Call it at the end of every render of the list — handles are recreated each time, the
 * toolbar is not. `actions` are `{ label(), run(keys), min?, danger? }`.
 */
function mountSelection({ scope, head, root, actions }) {
  if (!head || !root) return;
  if (selection.scope !== scope) { selection.scope = scope; selection.keys.clear(); }

  const handles = $$('.pick', root);
  const present = new Set(handles.map(p => p.dataset.key));
  // a filtered-out or deleted row must not keep voting for the count
  Array.from(selection.keys).forEach(k => { if (!present.has(k)) selection.keys.delete(k); });

  let bar = head.querySelector(':scope > .sel-bar');
  if (!bar) { bar = document.createElement('div'); bar.className = 'sel-bar'; bar.hidden = true; head.appendChild(bar); }

  const paint = () => {
    const on = selection.keys.size > 0;
    root.classList.toggle('selecting', on);
    head.classList.toggle('selecting', on);
    handles.forEach(p => {
      const picked = selection.keys.has(p.dataset.key);
      p.classList.toggle('on', picked);
      p.setAttribute('aria-checked', String(picked));
    });
    bar.hidden = !on;
    if (on) drawSelectionBar(bar, actions, paint, handles.map(p => p.dataset.key));
  };
  selection.repaint = paint;

  handles.forEach(p => {
    const toggle = e => {
      e.preventDefault(); e.stopPropagation();
      const k = p.dataset.key;
      if (selection.keys.has(k)) selection.keys.delete(k); else selection.keys.add(k);
      paint();
    };
    p.addEventListener('click', toggle);
    p.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') toggle(e); });
  });
  paint();
}

/**
 * The bar over the list head while something is picked: the count, the way to take the whole
 * list in one go, and what can be done with the picks. `allKeys` is what is on screen right
 * now, so "select all" follows the filter rather than reaching behind it.
 */
function drawSelectionBar(bar, actions, paint, allKeys) {
  const n = selection.keys.size;
  const shown = actions.filter(a => n >= (a.min || 1));
  const rest = allKeys.filter(k => !selection.keys.has(k));
  bar.innerHTML = `<span class="sel-count mono">${esc(t('selCount', { count: n }))}</span>
    ${rest.length ? `<button class="sel-all">${esc(t('selAll'))} (${allKeys.length})</button>` : ''}
    <div class="sel-acts">${shown.map((a, i) =>
      `<button class="sel-act${a.danger ? ' danger' : ''}" data-i="${i}">${esc(a.label())}</button>`).join('')}</div>
    <button class="sel-close" title="${esc(t('selClear'))}" aria-label="${esc(t('selClear'))}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 6 12 12M18 6 6 18"/></svg></button>`;
  const all = $('.sel-all', bar);
  if (all) all.addEventListener('click', e => { e.stopPropagation(); rest.forEach(k => selection.keys.add(k)); paint(); });
  $$('.sel-act', bar).forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    await shown[Number(b.dataset.i)].run(Array.from(selection.keys));
  }));
  $('.sel-close', bar).addEventListener('click', e => { e.stopPropagation(); selection.keys.clear(); paint(); });
}

/** The roster a meeting is measured against: its series' own list, or the default one. */
async function addNamesToRoster(names, group) {
  const list = group ? (group.roster || []).slice() : roster.slice();
  let added = 0;
  names.forEach(n => {
    if (!list.some(x => x.toLowerCase() === n.toLowerCase())) { list.push(n); added++; }
  });
  if (group) await store.updateGroup(group.id, { roster: list });
  else { roster = list; await store.saveRoster(list); }
  return added;
}
async function removeNamesFromRoster(names, group) {
  const drop = new Set(names.map(n => n.toLowerCase()));
  const before = group ? (group.roster || []) : roster;
  const list = before.filter(n => !drop.has(n.toLowerCase()));
  const removed = before.length - list.length;
  if (group) await store.updateGroup(group.id, { roster: list });
  else { roster = list; await store.saveRoster(list); }
  return removed;
}

/* ============================ MEETINGS ============================ */
// An imported record is not required to carry a title, and one missing it must not take the
// whole list down with it.
function meetingMatches(m, q) {
  if (String(m.meetingTitle || '').toLowerCase().includes(q)) return true;
  return Object.keys(m.attendance).some(n => n.toLowerCase().includes(q));
}
/**
 * Pages under a list: where you are in it, and the jumps out of it. The run of numbers
 * collapses around the current page, so a hundred pages take no more room than five.
 */
function renderPager(box, { page, pages, from, count, total, go }) {
  box.hidden = pages < 2;
  if (box.hidden) { box.innerHTML = ''; return; }
  const step = (p, disabled, key, path) =>
    `<button class="pg-step" data-p="${p}"${disabled ? ' disabled' : ''} title="${esc(t(key))}" aria-label="${esc(t(key))}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="${path}"/></svg></button>`;
  box.innerHTML = `<span class="pg-range mono">${esc(t('pagerRange', { from: from + 1, to: from + count, total }))}</span>
    <div class="pg-nav">
      ${step(page - 1, page === 1, 'pagerPrev', 'm15 18-6-6 6-6')}
      ${pageNumbers(page, pages).map(n => n === null
        ? '<span class="pg-gap">…</span>'
        : `<button class="pg-num${n === page ? ' on' : ''}" data-p="${n}"${n === page ? ' aria-current="page"' : ''}>${n}</button>`).join('')}
      ${step(page + 1, page === pages, 'pagerNext', 'm9 6 6 6-6 6')}
    </div>`;
  $$('button[data-p]', box).forEach(b => b.addEventListener('click', () => { if (!b.disabled) go(Number(b.dataset.p)); }));
}
/** The first page, the last one, and the current one with a neighbour either side; null is a gap. */
function pageNumbers(page, pages) {
  const keep = new Set([1, 2, pages - 1, pages, page - 1, page, page + 1]);
  const shown = Array.from(keep).filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
  return shown.flatMap((n, i) => (i && n - shown[i - 1] > 1 ? [null, n] : [n]));
}

const MEETINGS_PER_PAGE = 25;
let meetingsPage = 1;

function renderMeetings(filter = '') {
  const q = filter.toLowerCase();
  const inTrash = meetingsList === 'trash';
  // the archive and the trash are lists of their own: set aside, and on their way out
  const scope = inTrash ? trash : history.filter(m => !!m.archived === (meetingsList === 'archive'));
  const list = q ? scope.filter(m => meetingMatches(m, q)) : scope;

  const tab = (btn, key, count, on) => {
    setSwitchLabel(btn, t(key), count);
    btn.hidden = !count && !on;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  };
  tab($('#btn-meetings-archive'), 'meetingsArchive', history.filter(m => m.archived).length, meetingsList === 'archive');
  tab($('#btn-meetings-trash'), 'meetingsTrash', trash.length, inTrash);
  $('#btn-trash-empty').hidden = !(inTrash && trash.length);
  // the head and the rows are grids of their own: the card carries the mode, so both widen together
  $('#meetings-table').classList.toggle('trash-list', inTrash);

  // stats
  const people = new Set(); let durSum = 0, shareSum = 0, shareN = 0;
  list.forEach(m => {
    Object.keys(m.attendance).forEach(n => people.add(n.toLowerCase()));
    durSum += A.meetingDurationSeconds(m);
    Object.values(m.attendance).forEach(a => { shareSum += A.sharePct(a, m); shareN++; });
  });
  $('#stat-meetings').textContent = list.length;
  $('#stat-people').textContent = people.size;
  setStat($('#stat-length'), list.length ? fmtDur(Math.round(durSum / list.length)) : '—', '');
  setStat($('#stat-attendance'), shareN ? Math.round(shareSum / shareN) : 0, '%');

  const table = $('#meetings-table'), empty = $('#meetings-empty');
  const emptyKeys = {
    active: ['emptyMeetingsTitle', 'emptyMeetingsBody'],
    archive: ['emptyArchiveTitle', 'emptyMeetingsArchiveBody'],
    trash: ['emptyTrashTitle', 'emptyTrashBody']
  }[meetingsList];
  setI18nText($('#meetings-empty-title'), emptyKeys[0]);
  setI18nText($('#meetings-empty-body'), emptyKeys[1]);
  // the rows go too, or a later selection would still find the ones that are no longer listed
  if (!list.length) { $('#meetings-body').innerHTML = ''; table.style.display = 'none'; empty.classList.add('visible'); return; }
  table.style.display = ''; empty.classList.remove('visible');

  // clamped rather than reset: deleting the last record of page 4 lands on page 3, not page 1
  const pages = Math.max(1, Math.ceil(list.length / MEETINGS_PER_PAGE));
  meetingsPage = Math.min(Math.max(1, meetingsPage), pages);
  const from = (meetingsPage - 1) * MEETINGS_PER_PAGE;
  const page = list.slice(from, from + MEETINGS_PER_PAGE);

  $('#meetings-body').innerHTML = page.map(m => {
    const startIso = A.meetingStartIso(m);
    const d = new Date(startIso);
    const people = Object.keys(m.attendance).length;
    const avg = people ? Math.round(Object.values(m.attendance).reduce((s, a) => s + A.liveSecondsFor(a, m), 0) / people) : 0;
    const g = m.groupId ? groupById(m.groupId) : null;
    // the pill names the series and leads to it, without opening the meeting under it
    const groupCell = g
      ? `<button class="group-pill go" data-group="${esc(g.id)}" title="${esc(t('openGroup'))}: ${esc(g.name)}"><span class="gdot" style="background:var(${GRP_COLORS[g.color] || '--grp-teal'})"></span><span class="gname">${esc(g.name)}</span></button>`
      : '';
    // a call still running, and a record nothing ever ended, are not records like the rest: each
    // is marked beside the title and washes its row. In the trash neither matters — whatever is
    // in there is on its way out, not something to go back to a call about.
    const state = inTrash ? 'ended' : A.meetingState(m);
    const tag = stateTag(m, state);
    const mark = state === 'live' ? ' is-live' : state === 'unfinished' ? ' is-unfinished' : '';
    const badge = `<div class="date-badge"><span class="day">${d.getDate()}</span><span class="mon">${esc(i18n.monthShort(d))}</span></div>`;
    // in the trash the series it was in is beside the point; what is left of its stay is not
    const middle = inTrash
      ? `<span class="group-pill"><span class="gname">${esc(trashLeft(m))}</span></span>`
      : groupCell;
    // a row in the trash carries both ways out — back to the history, or gone for good — as the
    // same quiet glyphs the export is, since two worded buttons would not fit the column
    const action = inTrash
      ? `<button class="row-ic" data-act="restore" data-id="${esc(m.id)}" title="${esc(t('trashRestore'))}" aria-label="${esc(t('trashRestore'))}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 3v6h6"/><path d="M3.5 9a9 9 0 1 0 2.1-3.4L3 8"/></svg></button>
        <button class="row-ic danger" data-act="purge" data-id="${esc(m.id)}" title="${esc(t('trashDeleteNow'))}" aria-label="${esc(t('trashDeleteNow'))}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/><path d="m10 10.5 4 5m0-5-4 5"/></svg></button>`
      : `<button class="row-ic" data-act="export" data-id="${esc(m.id)}" title="${esc(t('exportCsv'))}" aria-label="${esc(t('exportCsv'))}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5"/><path d="M4 16.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2.5"/></svg></button>`;
    // a finished meeting reads as its full span; one still running only names its start,
    // the marker beside the title carries how long it has been going
    const endIso = A.meetingEndIso(m);
    const hours = !endIso || state === 'live'
      ? i18n.formatTime(startIso)
      : `${i18n.formatTime(startIso)}–${i18n.formatTime(endIso)}`;
    return `<div class="row meetings-grid${mark}" data-id="${esc(m.id)}">
      <div class="col-date">${pickHandle(m.id, badge)}</div>
      <div class="col-title"><div class="m-head"><div class="m-title" title="${esc(m.meetingTitle)}">${esc(m.meetingTitle)}</div>${tag}</div><div class="m-sub">${hours}</div></div>
      <div class="col-group">${middle}</div>
      <div class="col-people num">${people}</div>
      <div class="col-avg num">${fmtDur(avg)}</div>
      <div class="col-actions" style="text-align:right">${action}</div>
    </div>`;
  }).join('');

  tickClocks();   // a marker just drawn shows its clock now, not on the next beat

  $$('#meetings-body .row').forEach(row => row.addEventListener('click', () => {
    if (selectionClick(row.dataset.id)) return;
    // a meeting in the trash has no detail page to open — it is not in the history any more
    if (!inTrash) go('meeting=' + encodeURIComponent(row.dataset.id));
  }));
  $$('#meetings-body [data-group]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    // while a selection is running the whole row is a checkbox, series pill included
    if (selectionClick(b.closest('.row').dataset.id)) return;
    go('group=' + encodeURIComponent(b.dataset.group));
  }));
  $$('#meetings-body [data-act="export"]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); downloadMeetingCSV(b.dataset.id); }));
  $$('#meetings-body [data-act="restore"]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); restoreMeetings([b.dataset.id]); }));
  $$('#meetings-body [data-act="purge"]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); purgeMeetings([b.dataset.id]); }));

  renderPager($('#meetings-pager'), {
    page: meetingsPage, pages, from, count: page.length, total: list.length,
    go: p => { meetingsPage = p; renderMeetings(filter); table.scrollIntoView({ block: 'start' }); }
  });

  mountSelection({
    scope: 'meetings', head: $('#meetings-table .list-head'), root: $('#meetings-body'),
    actions: inTrash ? [
      { label: () => t('trashRestore'), run: ids => restoreMeetings(ids) },
      { label: () => t('trashDeleteNow'), danger: true, run: ids => purgeMeetings(ids) }
    ] : [
      { label: () => t('addToGroup'), run: ids => openAssignModal(ids.map(id => history.find(m => m.id === id)).filter(Boolean)) },
      { label: () => t('exportCsv'), run: ids => downloadSelectionCSV(ids) },
      { label: () => t(meetingsList === 'archive' ? 'unarchive' : 'archive'), run: ids => archiveMeetings(ids, meetingsList !== 'archive') },
      { label: () => t('delete'), danger: true, run: ids => trashMeetings(ids) }
    ]
  });
}
// a new filter is a new list, so it starts at its first page
$('#meeting-search').addEventListener('input', e => { meetingsPage = 1; renderMeetings(e.target.value.trim()); });
$('#btn-meetings-archive').addEventListener('click', () => go(meetingsList === 'archive' ? 'meetings' : 'meetings&archive'));
$('#btn-meetings-trash').addEventListener('click', () => go(meetingsList === 'trash' ? 'meetings' : 'meetings&trash'));

/** Put meetings aside, or bring them back. Used by the toolbar and by the detail header. */
async function archiveMeetings(ids, archived) {
  const n = await store.setMeetingsArchived(ids, archived);
  selectionReset(); await load();
  toast(t(archived ? 'archivedMeetingsToast' : 'unarchivedMeetingsToast', { count: n }));
}

/* ---- the trash ---- */
/** How much of its stay a deleted meeting has left, in the words the row has room for. */
function trashLeft(m) {
  const days = Number(settings.trashRetentionDays ?? 30);
  if (!(days > 0)) return t('trashLeftKept');
  const goneAt = (Date.parse(m.deletedAt) || Date.now()) + days * 86400000;
  const left = Math.ceil((goneAt - Date.now()) / 86400000);
  return left <= 1 ? t('trashLeftToday') : t('trashLeftDays', { days: left });
}
async function trashMeetings(ids) {
  for (const id of ids) await store.deleteMeetingById(id);
  selectionReset(); await load();
  toast(t('trashedToast', { count: ids.length }));
}
async function restoreMeetings(ids) {
  const n = await store.restoreMeetings(ids);
  selectionReset(); await load();
  toast(t('restoredToast', { count: n }));
}
async function purgeMeetings(ids) {
  if (!confirm(t('confirmPurge', { count: ids.length }))) return;
  const n = await store.purgeMeetings(ids);
  selectionReset(); await load();
  toast(t('purgedToast', { count: n }));
}
$('#btn-trash-empty').addEventListener('click', async () => {
  if (!confirm(t('confirmEmptyTrash', { count: trash.length }))) return;
  const n = await store.emptyTrash();
  selectionReset(); await load();
  toast(t('purgedToast', { count: n }));
});

/* ============================ MEETING DETAIL ============================ */
function currentMeeting() { return history.find(m => m.id === curMeetingId) || null; }

function renderDetail(m) {
  const roster = effectiveRoster(m);
  const people = Object.entries(m.attendance);
  const absentees = A.absenteesFor(m, roster);

  const startIso = A.meetingStartIso(m), endIso = A.meetingEndIso(m);
  // the hours live in their own badge under the title now — the eyebrow keeps date and code
  $('#detail-eyebrow').textContent =
    `${i18n.formatDate(startIso, { weekday: 'short', day: 'numeric', month: 'short' })} · ${m.meetingCode || m.id}`;
  // clamped to two lines in CSS — the full title stays reachable on hover
  $('#detail-title').textContent = m.meetingTitle;
  $('#detail-title').title = m.meetingTitle;
  // the archive box beside the name is both the state and the switch for it
  const arch = $('#btn-meeting-archive'), archLabel = t(m.archived ? 'unarchive' : 'archive');
  arch.classList.toggle('on', !!m.archived);
  arch.title = archLabel; arch.setAttribute('aria-label', archLabel);
  $('#detail-meta').innerHTML =
    `<b>${people.length}</b> ${t('metaAttended')} · <b>${absentees.length}</b> ${t('metaAbsent')}`;

  const avg = people.length ? Math.round(people.reduce((s, [, a]) => s + A.liveSecondsFor(a, m), 0) / people.length) : 0;
  setStat($('#d-attended'), people.length, absentees.length ? `+${absentees.length} ${t('absent').toLowerCase()}` : '');
  setStat($('#d-avg'), fmtDur(avg), '');
  const share = people.length ? Math.round(people.reduce((s, [, a]) => s + A.sharePct(a, m), 0) / people.length) : 0;
  setStat($('#d-share'), share, '%');
  setStat($('#d-length'), fmtDur(A.meetingDurationSeconds(m)), '');

  renderGroupBadge(m);

  // the hours badge reads them out and edits them; pinned hours are marked, not spelled out.
  // A call still running has no end to name — an hour printed there would read as the one it
  // finished at, so the span is left open and the marker beside it says how long it has been going.
  const state = A.meetingState(m);
  const hours = $('#btn-hours'), pinned = A.hasSchedule(m);
  $('#hours-value').textContent = state === 'live'
    ? `${i18n.formatTime(startIso)}–…`
    : `${i18n.formatTime(startIso)}–${i18n.formatTime(endIso)}`;
  hours.classList.toggle('pinned', pinned);
  hours.title = pinned ? t('hoursPinnedTitle') : t('hoursAutoTitle');
  renderDetailState(m, state);

  renderTimeline(m);
  renderAttendance(m, $('#participant-search').value.trim());
}

/**
 * What the record itself is, said above the numbers it explains: a call still running, whose
 * figures are still moving, or one nothing ended, whose figures stopped where its last sign of
 * life is and read as if everyone were still in the room. The second comes with the way out.
 */
function renderDetailState(m, state = A.meetingState(m)) {
  const tag = $('#detail-live'), endBtn = $('#btn-end-now');
  const clock = $('.clock', tag), label = $('.lb', tag);

  tag.hidden = state === 'ended';
  endBtn.hidden = state !== 'unfinished';
  tag.classList.toggle('warn', state === 'unfinished');
  if (state === 'ended') { setSince(clock, NaN); return; }

  if (state === 'live') {
    label.textContent = t('liveNow');
    tag.title = t('liveNowHint');
    setSince(clock, A.meetingStartMs(m));
    tickClocks();
    return;
  }
  label.textContent = t('unfinished');
  tag.title = endBtn.title = t('unfinishedHint', { time: whenShort(lastSignIso(m)) });
  setSince(clock, NaN);
}

/**
 * Close a record nothing got to end, where anything was last known to be reporting into it — the
 * same repair the worker runs whenever it wakes and finds a call whose link is gone from the
 * browser. By hand for the one case it cannot judge: the Meet tab is still open, so from out
 * there the call may well still be running.
 */
$('#btn-end-now').addEventListener('click', async () => {
  const m = currentMeeting(); if (!m) return;
  if (!confirm(t('confirmEndNow', { time: whenShort(lastSignIso(m)) }))) return;
  const closed = await store.endInterruptedMeetings([m.id]);
  await load();
  if (closed.length) toast(t('endedNowToast'));
});

/**
 * The hover readout for one presence block: whose lane it is, the hours it covers and how long
 * it ran. A session still open says so instead of naming an end; the meeting's end is only
 * where the block stops being drawn.
 */
function segTip(title, s, joinedMs, endedMs) {
  const from = i18n.formatTime(s.joinedAt);
  const to = s.leftAt ? i18n.formatTime(s.leftAt) : t('stillInCall');
  const secs = Math.max(0, Math.floor((endedMs - joinedMs) / 1000));
  return ` data-tip-title="${esc(title)}" data-tip-color="var(--present)"` +
    ` data-tip-value="${esc(from)} → ${esc(to)}" data-tip-label="${esc(fmtDur(secs))}"`;
}

function renderTimeline(m) {
  const { startMs, endMs } = A.meetingBounds(m);
  const span = Math.max(1, endMs - startMs);
  const tl = $('#timeline');

  // axis
  let axis = '<div class="tl-axis">';
  for (let i = 0; i <= 3; i++) {
    const frac = i / 3;
    const iso = new Date(startMs + span * frac).toISOString();
    const cls = i === 0 ? 'first' : i === 3 ? 'last' : '';
    axis += `<span class="tl-tick ${cls}" style="left:${frac * 100}%">${i18n.formatTime(iso)}</span>`;
  }
  axis += '</div>';

  const attended = Object.entries(m.attendance).sort((a, b) => (Date.parse(a[1].firstSeen) || 0) - (Date.parse(b[1].firstSeen) || 0));
  let lanes = '';
  attended.forEach(([name, a]) => {
    let segs = '';
    (a.sessions || []).forEach(s => {
      const sMs = Date.parse(s.joinedAt); if (Number.isNaN(sMs)) return;
      const eMs = s.leftAt ? Date.parse(s.leftAt) : endMs;
      const left = Math.max(0, (Math.max(sMs, startMs) - startMs) / span * 100);
      const width = Math.max(0.6, (Math.min(eMs, endMs) - Math.max(sMs, startMs)) / span * 100);
      segs += `<div class="seg"${segTip(name, s, sMs, eMs)} style="left:${left}%;width:${width}%"></div>`;
    });
    lanes += `<div class="tl-lane"><div class="tl-name"><span class="dot" style="background:var(--present)"></span><span class="who">${esc(name)}</span></div><div class="tl-track">${segs}</div></div>`;
  });

  A.absenteesFor(m, effectiveRoster(m)).sort((a, b) => a.localeCompare(b)).forEach(name => {
    lanes += `<div class="tl-lane absent"><div class="tl-name"><span class="dot" style="background:var(--absent)"></span><span class="who" style="color:var(--ink-3)">${esc(name)}</span></div><div class="tl-track"><span class="tl-abs">${t('absent')}</span></div></div>`;
  });

  const legend = `<div class="tl-legend">
    <span class="lg"><span class="sw" style="background:var(--present)"></span>${t('legendPresent')}</span>
    <span class="lg"><span class="sw" style="background:var(--absent-2);border:1px solid var(--line-2)"></span>${t('legendAbsent')}</span>
  </div>`;

  tl.innerHTML = axis + lanes + legend;
}

/** Names an attendee row was merged from, empty when it is a single participant. */
function mergedNames(a) {
  return Array.isArray(a && a.mergedFrom) && a.mergedFrom.length > 1 ? a.mergedFrom : [];
}
/** Badge marking a row as several Meet identities of one person (hover lists them). */
function mergedChip(a) {
  const names = mergedNames(a);
  if (!names.length) return '';
  return `<span class="merged-chip" title="${esc(t('mergedFromTitle', { names: names.join(' · ') }))}">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="9" cy="12" r="5.5"/><circle cx="15" cy="12" r="5.5"/></svg>${names.length}</span>`;
}

function renderAttendance(m, filter) {
  const q = (filter || '').toLowerCase();
  let people = Object.entries(m.attendance).sort((a, b) => a[0].localeCompare(b[0]));
  if (q) people = people.filter(([n]) => n.toLowerCase().includes(q));

  let rows = people.map(([name, a], i) => {
    // attendance is binary — being in the call at all is the whole story
    const st = A.statusFor(a, m);
    const chip = `<span class="status status--present">${t('present')}</span>`;
    const avatar = `<span class="avatar" style="${avatarStyle(name)}">${esc(initials(name))}</span>`;
    return `<tr>
      <td><div class="name-cell">${pickHandle(name, avatar)}<span class="nm">${esc(name)}</span>${mergedChip(a)}</div></td>
      <td class="mono">${i18n.formatTime(a.firstSeen)}</td>
      <td class="mono">${a.present ? '<span class="mono">'+esc(t('inCall'))+'</span>' : i18n.formatTime(a.lastLeft)}</td>
      <td class="num mono">${fmtHMS(st.seconds)}</td>
      <td><div class="share-cell"><div class="share-bar"><i style="width:${st.sharePct}%"></i></div><span class="pct">${st.sharePct}%</span></div></td>
      <td>${chip}</td>
      <td class="cell-actions"><button class="edit-name" data-i="${i}" title="${esc(t('editParticipantTitle'))}" aria-label="${esc(t('editParticipantTitle'))}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button></td>
    </tr>`;
  }).join('');

  let absentees = A.absenteesFor(m, effectiveRoster(m));
  if (q) absentees = absentees.filter(n => n.toLowerCase().includes(q));
  rows += absentees.sort((a, b) => a.localeCompare(b)).map(name => `<tr>
      <td><div class="name-cell"><span class="avatar avatar--muted">${esc(initials(name))}</span><span class="nm" style="color:var(--ink-2)">${esc(name)}</span></div></td>
      <td class="mono">—</td><td class="mono">—</td><td class="num mono">00:00:00</td>
      <td><div class="share-cell"><div class="share-bar"><i style="width:0"></i></div><span class="pct">0%</span></div></td>
      <td><span class="status status--absent">${t('absent')}</span></td>
      <td class="cell-actions"></td>
    </tr>`).join('');

  // header (localized) built once per render
  const thead = `<thead><tr><th data-i18n="colParticipant">${t('colParticipant')}</th><th>${t('colFirstSeen')}</th><th>${t('colLastLeft')}</th><th class="num">${t('colPresent')}</th><th>${t('colShare')}</th><th>${t('colStatus')}</th><th class="cell-actions"></th></tr></thead>`;
  $('#attendance-table').innerHTML = thead + `<tbody id="attendance-body">${rows}</tbody>`;
  $$('#attendance-table .edit-name').forEach(b =>
    b.addEventListener('click', () => openParticipantModal(people[Number(b.dataset.i)][0])));

  const g = m.groupId ? groupById(m.groupId) : null;
  mountSelection({
    scope: 'participants', head: $('#attendance-head'), root: $('#attendance-table'),
    actions: [
      {
        label: () => t('merge'), min: 2,
        run: async names => {
          // the first pick is the one everyone else folds into, so the reading stays predictable
          const [target, ...rest] = names;
          for (const from of rest) await store.renameParticipant(m.id, from, target);
          selectionReset(); await load();
          toast(t('mergedToast'));
        }
      },
      {
        label: () => t('selAddRoster'),
        run: async names => {
          const added = await addNamesToRoster(names, g);
          selectionReset(); await load();
          toast(added ? t('rosterAddedToast', { count: added }) : t('rosterAlreadyThere'));
        }
      }
    ]
  });
}
$('#participant-search').addEventListener('input', e => { const m = currentMeeting(); if (m) renderAttendance(m, e.target.value.trim()); });

/* ---- detail actions ---- */
/**
 * Open or close a title line for editing. The input sits over the heading rather than in its
 * place, so all this does is decide which of the two is the one you see.
 */
function setTitleEditing(input, on) {
  input.closest('.title-line').classList.toggle('editing', on);
  input.hidden = !on;
}

$('#btn-rename').addEventListener('click', () => startRename());
function startRename() {
  const m = currentMeeting(); if (!m) return;
  const input = $('#rename-input');
  input.value = m.meetingTitle;
  setTitleEditing(input, true); input.focus(); input.select();
}
async function commitRename() {
  const m = currentMeeting(); const input = $('#rename-input');
  if (input.hidden) return;         // Escape closed the line already: nothing left to keep
  const v = input.value.trim();
  if (m && v) {
    m.meetingTitle = v;
    await store.setMeetingTitle(m.id, v);   // marked as named by hand: a live call won't undo it
    $('#detail-title').textContent = v;
  }
  setTitleEditing(input, false);
  renderMeetings($('#meeting-search').value.trim());
}
$('#rename-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
  else if (e.key === 'Escape') { setTitleEditing($('#rename-input'), false); }
});
$('#rename-input').addEventListener('blur', commitRename);

$('#btn-meeting-archive').addEventListener('click', () => {
  const m = currentMeeting(); if (m) archiveMeetings([m.id], !m.archived);
});

/* ---- meeting hours ---- */
// <input type="datetime-local"> speaks local wall time; storage speaks ISO.
function toLocalInput(msVal) {
  if (!Number.isFinite(msVal) || msVal <= 0) return '';
  const local = new Date(msVal - new Date(msVal).getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
function fromLocalInput(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function openScheduleModal() {
  const m = currentMeeting(); if (!m) return;
  $('#schedule-start').value = toLocalInput(A.meetingStartMs(m));
  $('#schedule-end').value = toLocalInput(A.meetingEndMs(m));

  const obs = A.observedBounds(m);
  $('#schedule-observed').textContent = Number.isFinite(obs.startMs)
    ? t('scheduleObserved', { range: `${i18n.formatTime(new Date(obs.startMs).toISOString())}–${i18n.formatTime(new Date(obs.endMs).toISOString())}` })
    : '';

  $('#schedule-modal').hidden = false;
  $('#schedule-start').focus();
}

async function saveSchedule(start, end) {
  const m = currentMeeting(); if (!m) return;
  await store.setMeetingSchedule(m.id, { start, end });
  $('#schedule-modal').hidden = true;
  await load();
  toast(start || end ? t('savedToast') : t('scheduleClearedToast'));
}

$('#btn-hours').addEventListener('click', openScheduleModal);
$('#schedule-cancel').addEventListener('click', () => { $('#schedule-modal').hidden = true; });
$('#schedule-auto').addEventListener('click', () => saveSchedule(null, null));
$('#schedule-save').addEventListener('click', () => {
  const start = fromLocalInput($('#schedule-start').value);
  const end = fromLocalInput($('#schedule-end').value);
  if (start && end && Date.parse(end) <= Date.parse(start)) { toast(t('scheduleInvalid')); return; }
  saveSchedule(start, end);
});
$$('#schedule-start, #schedule-end').forEach(el => el.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('#schedule-save').click(); }
}));

/* ---- participant rename / merge ---- */
let editingName = null; // participant being edited in #participant-modal

function participantMergeTarget() {
  const m = currentMeeting(); if (!m || editingName == null) return null;
  const v = $('#participant-name').value.trim().toLowerCase();
  if (!v) return null;
  return Object.keys(m.attendance).find(n => n !== editingName && n.toLowerCase() === v) || null;
}

function refreshParticipantModal() {
  const v = $('#participant-name').value.trim();
  const target = participantMergeTarget();
  $('#merge-note').hidden = !target;
  if (target) $('#merge-note-text').textContent = t('mergeWarning', { name: target });
  const save = $('#participant-save');
  $('.lbl', save).textContent = target ? t('merge') : t('save');
  $('.ic-save', save).hidden = !!target;
  $('.ic-merge', save).hidden = !target;
  save.disabled = !v || v === editingName;
}

function openParticipantModal(name) {
  const m = currentMeeting(); if (!m) return;
  editingName = name;
  $('#participant-name').value = name;
  const others = Object.keys(m.attendance).filter(n => n !== name).sort((a, b) => a.localeCompare(b));
  $('#merge-pick').hidden = !others.length;
  $('#merge-list').innerHTML = others.map((n, i) =>
    `<button class="merge-item" data-i="${i}"><span class="avatar" style="${avatarStyle(n)}">${esc(initials(n))}</span><span class="nm">${esc(n)}</span></button>`).join('');
  $$('#merge-list .merge-item').forEach(b => b.addEventListener('click', () => {
    $('#participant-name').value = others[Number(b.dataset.i)];
    refreshParticipantModal();
  }));

  // the entries behind a merged row are still stored separately — offer the way back
  const sources = mergedNames(m.attendance[name]);
  $('#unmerge-block').hidden = !sources.length;
  $('#unmerge-names').innerHTML = sources
    .map(n => `<span class="chip"><span>${esc(n)}</span></span>`).join('');

  refreshParticipantModal();
  $('#participant-modal').hidden = false;
  const input = $('#participant-name'); input.focus(); input.select();
}

async function commitUnmerge() {
  const m = currentMeeting();
  const name = editingName;
  $('#participant-modal').hidden = true;
  editingName = null;
  if (!m || name == null) return;
  const res = await store.unmergeParticipant(m.id, name);
  if (!res) return;
  await load();
  toast(t('unmergedToast', { count: res.restored.length + 1 }));
}
$('#btn-unmerge').addEventListener('click', commitUnmerge);

async function commitParticipantEdit() {
  const m = currentMeeting();
  const v = $('#participant-name').value.trim();
  $('#participant-modal').hidden = true;
  if (!m || editingName == null || !v || v === editingName) { editingName = null; return; }
  const res = await store.renameParticipant(m.id, editingName, v);
  editingName = null;
  if (!res) return;
  await load();
  toast(res.merged ? t('mergedToast') : t('renamedToast'));
}
$('#participant-name').addEventListener('input', refreshParticipantModal);
$('#participant-name').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !$('#participant-save').disabled) { e.preventDefault(); commitParticipantEdit(); }
});
$('#participant-save').addEventListener('click', commitParticipantEdit);
$('#participant-cancel').addEventListener('click', () => { $('#participant-modal').hidden = true; editingName = null; });

// deleting is undoable now: it goes to the trash, and the list is where you land
$('#btn-delete').addEventListener('click', async () => {
  const m = currentMeeting(); if (!m) return;
  await store.deleteMeetingById(m.id);
  await load(); go('meetings', { replace: true });
  toast(t('trashedToast', { count: 1 }));
});

// export — the same three controls the series head offers, in the same order
$('#btn-export').addEventListener('click', () => { if (curMeetingId) downloadMeetingCSV(curMeetingId); });
$('#btn-pdf').addEventListener('click', () => { if (curMeetingId) openReport('meeting', curMeetingId); });

/* ---- the series this meeting belongs to ---- */
/**
 * The badge reads the series out and leads to it; the caret beside it opens the menu where the
 * series changes. With no series there is nowhere to go, so the badge is the menu on its own and
 * the caret stays out of the way.
 */
function renderGroupBadge(m) {
  const g = m.groupId ? groupById(m.groupId) : null;
  $('#group-badge-name').textContent = g ? g.name : t('addToGroup');
  $('#group-badge-dot').style.background = g ? `var(${groupColorVar(g)})` : 'var(--absent)';
  $('#btn-group').classList.toggle('none', !g);
  $('#btn-group').title = g ? `${t('openGroup')}: ${g.name}` : t('assignTitle');
  $('#btn-group-menu').hidden = !g;
}

/**
 * The series a meeting can be put into: the archive is out of the way here, which is the whole
 * point of it. The one a meeting is already in stays on the list even when archived, or the
 * badge would name a series the menu denies.
 */
function assignableGroups(inGroupIds) {
  const keep = new Set(inGroupIds.filter(Boolean));
  return groups.filter(g => !g.archived || keep.has(g.id));
}

const MI_CHECK = '<svg class="mi-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m5 13 4 4L19 7"/></svg>';
function groupMenuItems(m) {
  let html = assignableGroups([m.groupId]).map(g => `<button class="menu-item" role="menuitem" data-id="${esc(g.id)}">
      <span class="gdot" style="background:var(${groupColorVar(g)})"></span><span class="mi-name">${esc(g.name)}</span>${g.id === m.groupId ? MI_CHECK : ''}</button>`).join('');
  if (m.groupId) html += `<button class="menu-item" role="menuitem" data-id="__none">
      <span class="gdot" style="background:var(--absent)"></span><span class="mi-name">${esc(t('removeFromGroup'))}</span></button>`;
  if (html) html += '<div class="menu-sep"></div>';
  return html + `<button class="menu-item" role="menuitem" data-id="__new"><span class="mi-name">${esc(t('assignNew'))}</span></button>`;
}
function setGroupMenu(open) {
  const m = currentMeeting();
  if (open && m) $('#group-menu').innerHTML = groupMenuItems(m);
  $('#group-menu').hidden = !(open && m);
  [$('#btn-group'), $('#btn-group-menu')].forEach(b => b.setAttribute('aria-expanded', String(!!(open && m))));
}
function toggleGroupMenu() {
  const opening = $('#group-menu').hidden;
  $$('.menu').forEach(mn => mn.hidden = true);
  setGroupMenu(opening);
}
$('#btn-group').addEventListener('click', e => {
  e.stopPropagation();
  const m = currentMeeting();
  if (m && m.groupId) go('group=' + encodeURIComponent(m.groupId)); else toggleGroupMenu();
});
$('#btn-group-menu').addEventListener('click', e => { e.stopPropagation(); toggleGroupMenu(); });
$('#group-menu').addEventListener('click', async e => {
  const item = e.target.closest('.menu-item'); if (!item) return;
  e.stopPropagation();
  setGroupMenu(false);
  const m = currentMeeting(); if (!m) return;
  if (item.dataset.id === '__new') { openGroupModal([m.id]); return; }
  const gid = item.dataset.id === '__none' ? null : item.dataset.id;
  await store.assignMeetingsToGroup([m.id], gid);
  await load();
  toast(t(gid ? 'assignedToast' : 'removedFromGroupToast'));
});

/* ============================ GROUPS ============================ */
const ARCHIVE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.2"/><path d="M5 9v10.5h14V9M10 13h4"/></svg>';

/** Swap a node's translated text for another key, so a later locale change still finds it. */
function setI18nText(el, key) { el.dataset.i18n = key; el.textContent = t(key); }

/**
 * The series view has two lists: the ones in play, and the archive. The archive is a route of
 * its own (#groups&archive), so the back button and a reload land where you were.
 */
function renderGroups() {
  const archive = groupsArchive;
  const shown = groups.filter(g => !!g.archived === archive);
  const archivedCount = groups.filter(g => g.archived).length;

  if (archive) setSwitchLabel($('#btn-groups-archive'), t('groupsActive'), null);
  else setSwitchLabel($('#btn-groups-archive'), t('groupsArchive'), archivedCount);
  $('#btn-groups-archive').hidden = !archive && !archivedCount;
  $('#btn-new-group').hidden = archive;
  setI18nText($('#groups-lede'), archive ? 'archiveSubtitle' : 'groupsSubtitle');

  const list = $('#groups-list'), empty = $('#groups-empty');
  $('#series-suggestions').hidden = archive;
  if (!archive) renderSeriesSuggestions();

  if (!shown.length) {
    list.innerHTML = '';
    setI18nText($('#groups-empty-title'), archive ? 'emptyArchiveTitle' : 'emptyGroupsTitle');
    setI18nText($('#groups-empty-body'), archive ? 'emptyArchiveBody' : 'emptyGroupsBody');
    empty.classList.add('visible');
    return;
  }
  empty.classList.remove('visible');

  list.innerHTML = shown.map(g => {
    const ms = history.filter(m => m.groupId === g.id);
    const agg = A.aggregateGroup(ms, g.roster);
    const avgAtt = agg.people.length ? Math.round(agg.people.reduce((s, p) => s + p.avgShare, 0) / agg.people.length) : 0;
    const mark = g.archived ? `<span class="gc-archived" title="${esc(t('groupsArchive'))}">${ARCHIVE_ICON}</span>` : '';
    return `<div class="card group-card" data-id="${esc(g.id)}">
      <div class="gc-top"><span class="gc-swatch" style="background:var(${GRP_COLORS[g.color] || '--grp-teal'})"></span>
        <div style="min-width:0"><h3>${esc(g.name)}${mark}</h3><div class="gc-meta">${ms.length === 1 ? t('sessionOne') : t('sessionsN', { count: ms.length })}</div></div></div>
      <div class="gc-stats">
        <div class="gc-stat"><div class="n">${agg.peopleCount}</div><div class="l">${t('colGroupPeople')}</div></div>
        <div class="gc-stat"><div class="n">${avgAtt}%</div><div class="l">${t('colGroupAttendance')}</div></div>
        <div class="gc-stat"><div class="n">${fmtDur(agg.totalDurationSeconds)}</div><div class="l">${t('colTotalTime')}</div></div>
      </div></div>`;
  }).join('');
  $$('#groups-list .group-card').forEach(c => c.addEventListener('click', () => go('group=' + encodeURIComponent(c.dataset.id))));
}

// Name a series after the title text shared before a separator (e.g. "Szkolenie — Dzień 1/2" → "Szkolenie").
function seriesName(titles, code) {
  const segs = titles.map(t => String(t || '').split(/\s*[-–—:|]\s*/)[0].trim());
  if (segs[0] && segs.every(s => s === segs[0])) return segs[0];
  return titles[0] || code;
}
function renderSeriesSuggestions() {
  const box = $('#series-suggestions'); box.innerHTML = '';
  const bycode = A.seriesByCode(history);
  bycode.forEach((ms, code) => {
    const ungrouped = ms.filter(m => !m.groupId).sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
    if (ungrouped.length < 2) return; // only suggest real, still-ungrouped series
    const title = seriesName(ungrouped.map(m => m.meetingTitle), code);
    const div = document.createElement('div');
    div.className = 'suggest';
    div.innerHTML = `<div class="s-ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/></svg></div>
      <div class="s-txt"><div class="s-title">${t('seriesSuggestTitle')}</div><div class="s-sub">${esc(title)} · ${t('seriesSuggestBody', { count: ungrouped.length })}</div></div>
      <button class="btn">${t('groupThese', { count: ungrouped.length })}</button>`;
    div.querySelector('button').addEventListener('click', async () => {
      const g = await store.createGroup({ name: title });
      await store.assignMeetingsToGroup(ungrouped.map(m => m.id), g.id);
      await load(); go('group=' + encodeURIComponent(g.id));
    });
    box.appendChild(div);
  });
}

function renderGroup(g) {
  const ms = history.filter(m => m.groupId === g.id).sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
  const agg = A.aggregateGroup(ms, g.roster);
  const avgAtt = agg.people.length ? Math.round(agg.people.reduce((s, p) => s + p.avgShare, 0) / agg.people.length) : 0;

  $('#group-eyebrow').innerHTML = `<span style="color:var(${GRP_COLORS[g.color] || '--grp-teal'})">●</span> ${t('navGroups').toUpperCase()}`
    + (g.archived ? ` · ${esc(t('groupsArchive')).toUpperCase()}` : '');
  $('#group-title').textContent = g.name;
  $('#group-title').title = g.name;
  // the archive box beside the name is both the state and the switch for it
  const arch = $('#btn-group-archive'), label = t(g.archived ? 'unarchiveGroup' : 'archiveGroup');
  arch.classList.toggle('on', !!g.archived);
  arch.title = label; arch.setAttribute('aria-label', label);
  $('#group-meta').innerHTML = `${ms.length === 1 ? t('sessionOne') : t('sessionsN', { count: ms.length })} · ${agg.peopleCount === 1 ? t('peopleOne') : t('peopleN', { count: agg.peopleCount })}`;

  setStat($('#g-sessions'), agg.sessionCount, '');
  setStat($('#g-people'), agg.peopleCount, '');
  setStat($('#g-attendance'), avgAtt, '%');
  setStat($('#g-length'), fmtDur(agg.sessionCount ? Math.round(agg.totalDurationSeconds / agg.sessionCount) : 0), '');

  renderMatrix(agg);
  renderGroupSessions(ms);
  renderGroupRoster(g);
}

/** The sessions behind the matrix, each a way into the meeting itself. */
function renderGroupSessions(ms) {
  const table = $('#group-sessions');
  if (!ms.length) { table.innerHTML = `<tbody><tr><td class="mono" style="color:var(--ink-3)">—</td></tr></tbody>`; return; }
  const chevron = `<svg class="go" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;
  const head = `<thead><tr><th>${t('colDate')}</th><th>${t('colMeeting')}</th>
    <th class="num">${t('colPeople')}</th><th class="num">${t('statLength')}</th><th class="num">${t('colShare')}</th><th class="cell-go"></th></tr></thead>`;
  const body = '<tbody>' + ms.map(m => {
    const startIso = A.meetingStartIso(m);
    const entries = Object.values(m.attendance);
    const share = entries.length ? Math.round(entries.reduce((s, a) => s + A.sharePct(a, m), 0) / entries.length) : 0;
    return `<tr data-id="${esc(m.id)}" tabindex="0" title="${esc(t('openMeeting'))}">
      <td class="mono">${esc(i18n.formatDate(startIso, { day: 'numeric', month: 'short', year: 'numeric' }))}</td>
      <td><div class="s-title" title="${esc(m.meetingTitle)}">${esc(m.meetingTitle)}</div>
        <div class="s-time mono">${i18n.formatTime(startIso)}–${i18n.formatTime(A.meetingEndIso(m))}</div></td>
      <td class="num">${entries.length}</td>
      <td class="num mono">${fmtDur(A.meetingDurationSeconds(m))}</td>
      <td class="num mono">${share}%</td>
      <td class="cell-go">${chevron}</td></tr>`;
  }).join('') + '</tbody>';
  table.innerHTML = head + body;

  $$('#group-sessions tbody tr').forEach(tr => {
    const open = () => go('meeting=' + encodeURIComponent(tr.dataset.id));
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

function renderMatrix(agg) {
  if (!agg.sessions.length) { $('#group-matrix').innerHTML = `<tbody><tr><td class="mono" style="color:var(--ink-3);padding:16px">—</td></tr></tbody>`; return; }
  const head = `<thead><tr>
    <th>${t('colParticipant')}</th>
    ${agg.sessions.map(s => `<th class="col-session"><span class="ds">${esc(i18n.formatDate(s.date, { day: 'numeric', month: 'short' }))}</span>${esc((s.title || '').slice(0, 10))}</th>`).join('')}
    <th class="num">${t('colAttendedShare')}</th><th class="num">${t('colTotalTime')}</th>
  </tr></thead>`;
  const chevron = `<svg class="go" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;
  const body = '<tbody>' + agg.people.map(p => `<tr data-name="${esc(p.name)}" tabindex="0" title="${esc(t('personSessionsTitle', { name: p.name }))}">
    <td><div class="m-name">${pickHandle(p.name, `<span class="avatar" style="${avatarStyle(p.name)}">${esc(initials(p.name))}</span>`)}<span class="nm">${esc(p.name)}</span>${chevron}</div></td>
    ${agg.sessions.map(s => {
      const c = p.perSession[s.id];
      // the dot keeps the pattern readable across a row; the number says how much of it
      return `<td title="${esc(c.state === 'absent' ? t('absent') : fmtDur(c.seconds))}">
        <span class="cell-dot ${c.state}"></span><span class="cell-pct ${c.state}">${c.state === 'absent' ? '—' : c.sharePct + '%'}</span></td>`;
    }).join('')}
    <td class="num"><span class="m-att">${p.attendedCount}</span><span class="mono" style="color:var(--ink-3)">/${agg.sessionCount}</span></td>
    <td class="num m-total">${fmtDur(p.totalSeconds)}</td>
  </tr>`).join('') + '</tbody>';
  $('#group-matrix').innerHTML = head + body;

  $$('#group-matrix tbody tr').forEach(tr => {
    const toggle = () => {
      if (selectionClick(tr.dataset.name)) return;
      if (tr.classList.contains('expanded')) goBack('group=' + encodeURIComponent(curGroupId));
      else go(`group=${encodeURIComponent(curGroupId)}&person=${encodeURIComponent(tr.dataset.name)}`);
    };
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });

  const g = groupById(curGroupId);
  mountSelection({
    scope: 'series-people', head: $('#matrix-head'), root: $('#group-matrix'),
    actions: [
      {
        label: () => t('selAddRoster'),
        run: async names => {
          const added = await addNamesToRoster(names, g);
          selectionReset(); await load();
          toast(added ? t('rosterAddedToast', { count: added }) : t('rosterAlreadyThere'));
        }
      },
      {
        label: () => t('selRemoveRoster'),
        run: async names => {
          const removed = await removeNamesFromRoster(names, g);
          selectionReset(); await load();
          toast(removed ? t('rosterRemovedToast', { count: removed }) : t('rosterNotThere'));
        }
      }
    ]
  });
}

/* ---- one participant, across every session of the series ---- */
function seriesMeetings(g) {
  return history.filter(m => m.groupId === g.id).sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
}
/** The attendee entry for `name` in `m` — matched case-insensitively, as aggregateGroup does. */
function attendeeIn(m, name) {
  const key = String(name || '').trim().toLowerCase();
  const hit = Object.entries(m.attendance || {}).find(([n]) => n.trim().toLowerCase() === key);
  return hit ? hit[1] : null;
}

/**
 * The exact presence of one person in one session: the meeting's own hours as the track, their
 * join/leave blocks on it, and the same intervals spelled out underneath. Absent sessions keep
 * the lane (hatched) so the reading stays comparable down the list.
 */
function personSessionBlock(m, a) {
  const { startMs, endMs } = A.meetingBounds(m);
  const span = Math.max(1, endMs - startMs);
  const st = A.statusFor(a, m);
  const sessions = (a && Array.isArray(a.sessions)) ? a.sessions : [];

  let segs = '', ranges = '';
  sessions.forEach(s => {
    const sMs = Date.parse(s.joinedAt); if (Number.isNaN(sMs)) return;
    const open = !s.leftAt;
    const eMs = open ? endMs : Date.parse(s.leftAt);
    const left = Math.max(0, (Math.max(sMs, startMs) - startMs) / span * 100);
    const width = Math.max(0.6, (Math.min(eMs, endMs) - Math.max(sMs, startMs)) / span * 100);
    segs += `<div class="seg"${segTip(m.meetingTitle, s, sMs, eMs)} style="left:${left}%;width:${width}%"></div>`;
    ranges += `<span class="pm-range"><i class="rdot ${open ? 'open' : ''}"></i>${i18n.formatTime(s.joinedAt)} → ${open ? esc(t('stillInCall')) : i18n.formatTime(s.leftAt)} <b>${fmtDur(Math.max(0, Math.floor((eMs - sMs) / 1000)))}</b></span>`;
  });

  return `<div class="pm-sess${a ? '' : ' absent'}">
    <div class="pm-sess-head">
      <button class="pm-open" data-id="${esc(m.id)}" title="${esc(t('openMeeting'))}">
        <span class="pm-date">${esc(i18n.formatDate(A.meetingStartIso(m), { day: 'numeric', month: 'short' }))}</span>
        <span class="pm-title" title="${esc(m.meetingTitle)}">${esc(m.meetingTitle)}</span>
      </button>
      <span class="pm-share">${a ? `${fmtHMS(st.seconds)} · ${st.sharePct}%` : esc(t('absent'))}</span>
    </div>
    <div class="tl-lane pm-line${a ? '' : ' absent'}">
      <span class="pm-edge">${i18n.formatTime(A.meetingStartIso(m))}</span>
      <div class="tl-track">${a ? segs : `<span class="tl-abs">${esc(t('absent'))}</span>`}</div>
      <span class="pm-edge r">${i18n.formatTime(A.meetingEndIso(m))}</span>
    </div>
    ${ranges ? `<div class="pm-ranges">${ranges}</div>` : ''}
  </div>`;
}

/**
 * The person unfolds under their own row in the matrix — the row stays where it is, so the
 * pattern above and below it keeps its place. Opening another person folds this one away,
 * because the expansion is part of the route and the matrix is rebuilt on every route change.
 */
function expandSeriesPerson(g, name) {
  const ms = seriesMeetings(g);
  const agg = A.aggregateGroup(ms, g.roster);
  const key = String(name).trim().toLowerCase();
  const p = agg.people.find(x => x.name.trim().toLowerCase() === key);
  const row = $$('#group-matrix tbody tr').find(tr => tr.dataset.name === name);
  if (!p || !row) { go('group=' + encodeURIComponent(g.id), { replace: true }); return; }

  const stats = [
    [`${p.attendedCount}<small>/${agg.sessionCount}</small>`, t('colAttendedShare')],
    [esc(fmtDur(p.totalSeconds)), t('colTotalTime')],
    [`${p.totalShare}%`, t('colTotalShare')]
  ].map(([n, l]) => `<div class="pm-stat"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`).join('');

  row.classList.add('expanded');
  const tr = document.createElement('tr');
  tr.className = 'person-expand';
  tr.innerHTML = `<td colspan="${row.children.length}"><div class="pm">
    <div class="pm-stats">${stats}</div>
    <div class="pm-sessions">${ms.map(m => personSessionBlock(m, attendeeIn(m, p.name))).join('')}</div>
  </div></td>`;
  row.after(tr);
  $$('.pm-open', tr).forEach(b =>
    b.addEventListener('click', () => go('meeting=' + encodeURIComponent(b.dataset.id))));
}

function renderGroupRoster(g) {
  const box = $('#group-roster-chips');
  box.innerHTML = (g.roster || []).map((n, i) => `<span class="chip">${esc(n)}<span class="x" data-i="${i}">×</span></span>`).join('');
  $$('#group-roster-chips .x').forEach(x => x.addEventListener('click', async () => {
    g.roster.splice(Number(x.dataset.i), 1);
    await store.updateGroup(g.id, { roster: g.roster });
    renderGroup(g);
  }));
}
async function addGroupRoster() {
  const g = groupById(curGroupId); if (!g) return;
  const input = $('#group-roster-input'); const v = input.value.trim();
  if (!v) return;
  g.roster = g.roster || [];
  if (!g.roster.some(n => n.toLowerCase() === v.toLowerCase())) g.roster.push(v);
  await store.updateGroup(g.id, { roster: g.roster });
  input.value = ''; renderGroup(g);
}
$('#group-roster-add').addEventListener('click', addGroupRoster);
$('#group-roster-input').addEventListener('keydown', e => { if (e.key === 'Enter') addGroupRoster(); });

$('#btn-group-rename').addEventListener('click', () => startGroupRename());
function startGroupRename() {
  const g = groupById(curGroupId); if (!g) return;
  const input = $('#group-rename-input');
  input.value = g.name;
  setTitleEditing(input, true); input.focus(); input.select();
}
async function commitGroupRename() {
  const g = groupById(curGroupId); const input = $('#group-rename-input');
  if (input.hidden) return;         // Escape closed the line already: nothing left to keep
  const v = input.value.trim();
  if (g && v) { g.name = v; await store.updateGroup(g.id, { name: v }); $('#group-title').textContent = v; }
  setTitleEditing(input, false);
}
$('#group-rename-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); commitGroupRename(); }
  else if (e.key === 'Escape') { setTitleEditing($('#group-rename-input'), false); }
});
$('#group-rename-input').addEventListener('blur', commitGroupRename);

$('#btn-group-delete').addEventListener('click', async () => {
  const g = groupById(curGroupId); if (!g) return;
  if (!confirm(t('confirmDeleteGroup'))) return;
  await store.deleteGroup(g.id);
  await load(); go('groups', { replace: true });
});
$('#btn-group-pdf').addEventListener('click', () => { if (curGroupId) openReport('group', curGroupId); });
$('#btn-group-export').addEventListener('click', () => downloadGroupCSV(curGroupId));
$('#btn-new-group').addEventListener('click', () => openGroupModal([]));
$('#btn-groups-archive').addEventListener('click', () => go(groupsArchive ? 'groups' : 'groups&archive'));
$('#btn-group-archive').addEventListener('click', async () => {
  const g = groupById(curGroupId); if (!g) return;
  const archived = !g.archived;
  await store.updateGroup(g.id, { archived });
  await load();
  toast(t(archived ? 'archivedToast' : 'unarchivedToast'));
});

/* ---- filling a series from its own page ---- */
/**
 * The meeting's badge answers "which series is this in?"; this answers the other one, "what
 * else belongs here?". Anything not already in this series is offered, one in another series
 * included: picking it moves it, and the badge it carries says where it is coming from.
 * The picks live in a Set rather than in the DOM, so filtering the list keeps them.
 */
const pickedMeetings = new Set();
function openPickMeetings() {
  if (!groupById(curGroupId)) return;
  pickedMeetings.clear();
  $('#pick-meetings-search').value = '';
  renderPickMeetings();
  $('#pick-meetings-modal').hidden = false;
  $('#pick-meetings-search').focus();
}
function renderPickMeetings() {
  const g = groupById(curGroupId); if (!g) return;
  const q = $('#pick-meetings-search').value.trim().toLowerCase();
  const box = $('#pick-meetings-list');
  let list = history.filter(m => m.groupId !== g.id);
  const offered = list.length;
  if (q) list = list.filter(m => `${m.meetingTitle} ${m.meetingCode || ''}`.toLowerCase().includes(q));

  if (!list.length) {
    box.innerHTML = `<p class="pick-empty">${esc(t(offered ? 'pickEmpty' : 'pickMeetingsEmpty'))}</p>`;
  } else {
    box.innerHTML = list.map(m => {
      const og = m.groupId ? groupById(m.groupId) : null;
      const on = pickedMeetings.has(m.id);
      return `<label class="pick-item${on ? ' on' : ''}">
        <input type="checkbox" name="pickMeeting" id="pick-m-${esc(m.id)}" value="${esc(m.id)}"${on ? ' checked' : ''}>
        <span class="pi-date">${esc(i18n.formatDate(A.meetingStartIso(m), { day: 'numeric', month: 'short', year: 'numeric' }))}</span>
        <span class="pi-title">${esc(m.meetingTitle)}</span>
        ${og ? `<span class="pi-tag"><span class="gdot" style="background:var(${groupColorVar(og)})"></span>${esc(og.name)}</span>` : ''}
      </label>`;
    }).join('');
  }
  syncPickCount();
}
function syncPickCount() {
  const n = pickedMeetings.size;
  $('#pick-meetings-save .lbl').textContent = n ? `${t('add')} (${n})` : t('add');
  $('#pick-meetings-save').disabled = !n;
}
$('#btn-add-meetings').addEventListener('click', openPickMeetings);
$('#pick-meetings-search').addEventListener('input', renderPickMeetings);
$('#pick-meetings-list').addEventListener('change', e => {
  const cb = e.target.closest('input[type="checkbox"]'); if (!cb) return;
  if (cb.checked) pickedMeetings.add(cb.value); else pickedMeetings.delete(cb.value);
  cb.closest('.pick-item').classList.toggle('on', cb.checked);
  syncPickCount();
});
$('#pick-meetings-cancel').addEventListener('click', () => $('#pick-meetings-modal').hidden = true);
$('#pick-meetings-save').addEventListener('click', async () => {
  const g = groupById(curGroupId), ids = Array.from(pickedMeetings);
  if (!g || !ids.length) return;
  await store.assignMeetingsToGroup(ids, g.id);
  $('#pick-meetings-modal').hidden = true;
  pickedMeetings.clear();
  await load();
  toast(t('meetingsAddedToast', { count: ids.length }));
});

/* ============================ PEOPLE ============================ */
function aggregatePeople() {
  const map = new Map();
  history.forEach(m => {
    Object.entries(m.attendance).forEach(([name, a]) => {
      const k = name.toLowerCase();
      if (!map.has(k)) map.set(k, { name, count: 0, total: 0, shares: [], last: 0, meetings: [] });
      const p = map.get(k);
      const secs = A.liveSecondsFor(a, m);
      p.count++; p.total += secs; p.shares.push(A.sharePct(a, m));
      const dt = Date.parse(m.date) || 0; if (dt > p.last) p.last = dt;
      p.meetings.push({ id: m.id, title: m.meetingTitle, date: m.date, secs, share: A.sharePct(a, m) });
    });
  });
  return map;
}
function renderPeople(filter = '') {
  const q = filter.toLowerCase();
  const map = aggregatePeople();
  let entries = Array.from(map.values());
  if (q) entries = entries.filter(p => p.name.toLowerCase().includes(q));
  entries.sort((a, b) => b.count - a.count || b.total - a.total || a.name.localeCompare(b.name));

  const table = $('#people-table'), empty = $('#people-empty');
  if (!entries.length) { table.style.display = 'none'; empty.classList.add('visible'); return; }
  table.style.display = ''; empty.classList.remove('visible');

  $('#people-body').innerHTML = entries.map(p => {
    const avg = p.shares.length ? Math.round(p.shares.reduce((s, r) => s + r, 0) / p.shares.length) : 0;
    const avatar = `<span class="avatar" style="${avatarStyle(p.name)}">${esc(initials(p.name))}</span>`;
    return `<div class="row people-grid" data-name="${esc(p.name)}">
      <div class="col-name"><div class="name-cell">${pickHandle(p.name, avatar)}<span class="nm">${esc(p.name)}</span></div></div>
      <div class="num">${p.count}</div>
      <div class="num mono">${fmtDur(p.total)}</div>
      <div class="col-rate"><div class="share-cell"><div class="share-bar"><i style="width:${avg}%"></i></div><span class="pct">${avg}%</span></div></div>
      <div class="col-last num mono">${esc(i18n.formatDate(new Date(p.last).toISOString(), { day: 'numeric', month: 'short', year: 'numeric' }))}</div>
    </div>`;
  }).join('');
  $$('#people-body .row').forEach(r => r.addEventListener('click', () => {
    if (selectionClick(r.dataset.name)) return;
    if (r.classList.contains('expanded')) goBack('people');
    else go('people&person=' + encodeURIComponent(r.dataset.name));
  }));

  mountSelection({
    scope: 'people', head: $('#people-table .list-head'), root: $('#people-body'),
    actions: [
      {
        label: () => t('selAddRoster'),
        run: async names => {
          const added = await addNamesToRoster(names, null);
          selectionReset(); await load();
          toast(added ? t('rosterAddedToast', { count: added }) : t('rosterAlreadyThere'));
        }
      },
      {
        label: () => t('selCopyNames'),
        run: names => navigator.clipboard.writeText(names.join('\n')).then(() => toast(t('copiedToast')))
      }
    ]
  });
}

/**
 * A person unfolds under their own row: their meetings, newest first, each a way into the
 * meeting. Only one is open at a time — the list is rebuilt from the route on every change.
 */
function expandPerson(name) {
  const p = aggregatePeople().get(String(name).toLowerCase());
  const row = $$('#people-body .row').find(r => r.dataset.name === name);
  if (!p || !row) { go('people', { replace: true }); return; }

  const avg = p.shares.length ? Math.round(p.shares.reduce((s, r) => s + r, 0) / p.shares.length) : 0;
  const meetings = p.meetings.slice().sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));

  row.classList.add('expanded');
  const panel = document.createElement('div');
  panel.className = 'row-panel';
  panel.innerHTML = `<div class="p-stats">
      <span>${p.count === 1 ? t('personMeetingOne') : t('personMeetingsN', { count: p.count })}</span>
      <span>${fmtDur(p.total)} ${t('personTotal')}</span><span>${avg}% ${t('personAvg')}</span></div>
    <table class="rc-table person-meetings"><thead><tr><th>${t('colMeeting')}</th><th>${t('colDate')}</th><th class="num">${t('colPresent')}</th><th>${t('colShare')}</th></tr></thead>
    <tbody>${meetings.map(mm => `<tr data-id="${esc(mm.id)}" tabindex="0" title="${esc(t('openMeeting'))}">
      <td class="nm" title="${esc(mm.title)}">${esc(mm.title)}</td>
      <td class="mono">${esc(i18n.formatDate(mm.date, { day: 'numeric', month: 'short', year: 'numeric' }))}</td>
      <td class="num mono">${fmtHMS(mm.secs)}</td>
      <td><div class="share-cell"><div class="share-bar"><i style="width:${mm.share}%"></i></div><span class="pct">${mm.share}%</span></div></td></tr>`).join('')}</tbody></table>`;
  row.after(panel);
  $$('tbody tr', panel).forEach(tr => {
    const open = () => go('meeting=' + encodeURIComponent(tr.dataset.id));
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}
// searching replaces the open person rather than leaving the URL pointing at a hidden panel
$('#people-search').addEventListener('input', e => {
  if (parseRoute(currentHash()).person) go('people', { replace: true });
  else renderPeople(e.target.value.trim());
});

/* ============================ ANALYTICS ============================ */
// The view itself lives in ./analytics.js; this page only supplies the data and the
// handful of dashboard actions it needs to call back into.
function groupColorVar(g) { return GRP_COLORS[(g && g.color) || 'teal'] || '--grp-teal'; }
function exportCSV(rows, filename) {
  downloadBlob(new Blob(['﻿' + rows.map(csvRow).join('\n')], { type: 'text/csv;charset=utf-8;' }), filename);
}

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if ($('#view-analytics').classList.contains('on')) renderAnalytics(); }, 200); });

/* ============================ EXPORT ============================ */
function downloadBlob(blob, filename) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url); }
// Meet titles can run to a couple of hundred characters; a file name that long is a nuisance
// to handle and can push a path over the Windows limit, so it is cut to something readable.
function safe(s) { return String(s || 'export').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '') || 'export'; }
function csvRow(cells) { return cells.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(','); }

function downloadCSV(rows, filename) {
  // BOM + CRLF: what Excel needs to open a UTF-8 CSV without mangling the Polish characters
  downloadBlob(new Blob(['﻿' + rows.map(csvRow).join('\r\n')], { type: 'text/csv;charset=utf-8;' }), filename);
}
/** Calendar day of an instant in local time — toISOString() would name the UTC day. */
function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * One row per participant per meeting — the same columns for a single meeting, a series and
 * the whole history, so the three exports line up and can be pasted into one sheet.
 *
 * Every join and leave rides along in one cell as a JSON array of "HH:MM–HH:MM" strings (an
 * open session ends empty), which a spreadsheet keeps in a single column and a script can
 * still read back. Times are local wall clock like everywhere else in the app; the exact
 * instants live in the JSON backup, which is the machine-readable path.
 *
 * The last column is the meeting's own id: it is what lets the file be imported back without
 * duplicating meetings that are already here (see importers.fromOwnCSV).
 */
function csvDetailHeader() {
  return [t('colDate'), t('colMeeting'), t('csvMeetingCode'), t('colGroup'),
    t('csvMeetingStart'), t('csvMeetingEnd'), t('csvMeetingLength'),
    t('colParticipant'), t('csvEmail'), t('colStatus'), t('colFirstSeen'), t('colLastLeft'),
    t('colPresent'), t('csvPresentMinutes'), t('colShare'),
    t('csvSessionCount'), t('csvSessionList'), t('csvMergedFrom'), t('csvId')];
}
function csvSessionList(a) {
  return JSON.stringify(((a && a.sessions) || []).map(s =>
    `${i18n.formatTime(s.joinedAt)}–${s.leftAt ? i18n.formatTime(s.leftAt) : ''}`));
}
function csvDetailRows(m) {
  const startIso = A.meetingStartIso(m), endIso = A.meetingEndIso(m);
  const g = m.groupId ? groupById(m.groupId) : null;
  const meta = [localDay(startIso), m.meetingTitle, m.meetingCode || '', g ? g.name : '',
    i18n.formatTime(startIso), i18n.formatTime(endIso), fmtHMS(A.meetingDurationSeconds(m))];

  const rows = Object.entries(m.attendance).sort(([a], [b]) => a.localeCompare(b)).map(([name, a]) => {
    const st = A.statusFor(a, m);
    const merged = mergedNames(a);
    return [...meta, name, a.email || '', t('present'),
      i18n.formatTime(a.firstSeen), a.present ? t('stillInCall') : i18n.formatTime(a.lastLeft),
      fmtHMS(st.seconds), Math.round(st.seconds / 60), st.sharePct + '%',
      (a.sessions || []).length, csvSessionList(a), merged.length ? JSON.stringify(merged) : '', m.id];
  });
  A.absenteesFor(m, effectiveRoster(m)).sort((a, b) => a.localeCompare(b)).forEach(name =>
    rows.push([...meta, name, '', t('absent'), '—', '—', '00:00:00', 0, '0%', 0, '[]', '', m.id]));
  return rows;
}

function downloadMeetingCSV(id) {
  const m = history.find(x => x.id === id); if (!m) return;
  downloadCSV([csvDetailHeader(), ...csvDetailRows(m)],
    `${safe(m.meetingTitle)}-${localDay(A.meetingStartIso(m))}.csv`);
}
/** A hand-picked set of meetings, oldest first — the same columns as every other export. */
function downloadSelectionCSV(ids) {
  const ms = ids.map(id => history.find(m => m.id === id)).filter(Boolean)
    .sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
  if (!ms.length) return;
  downloadCSV([csvDetailHeader(), ...ms.flatMap(m => csvDetailRows(m))],
    `gm-attendance-${ms.length}-${localDay(new Date().toISOString())}.csv`);
}
/** The series file carries both readings: the matrix to scan, the detail to work with. */
function downloadGroupCSV(id) {
  const g = groupById(id); if (!g) return;
  const ms = seriesMeetings(g);
  const agg = A.aggregateGroup(ms, g.roster);
  const rows = [
    [t('matrixTitle'), g.name],
    [t('colParticipant'), t('csvEmail'),
      ...agg.sessions.map(s => i18n.formatDate(s.date, { day: 'numeric', month: 'short' })),
      t('colAttendedShare'), t('colTotalTime'), t('csvTotalMinutes'), t('colTotalShare')],
    ...agg.people.map(p => [p.name, p.email || '',
      ...agg.sessions.map(s => { const c = p.perSession[s.id]; return c.state === 'absent' ? t('absent') : c.sharePct + '%'; }),
      `${p.attendedCount}/${agg.sessionCount}`, fmtHMS(p.totalSeconds), Math.round(p.totalSeconds / 60), p.totalShare + '%']),
    [],
    [t('sessionsBreakdown')],
    csvDetailHeader(),
    ...ms.flatMap(m => csvDetailRows(m))
  ];
  downloadCSV(rows, `${safe(g.name)}-series.csv`);
}
// Same tab: the report is a view of this data, not a second app. It carries its own back
// button (hidden on paper), and this page comes back from history with its route intact.
function openReport(kind, id) {
  location.href = chrome.runtime.getURL('report/report.html') + `#${kind}=${encodeURIComponent(id)}`;
}

// export-all menu
toggleMenu('#btn-export-all', '#export-all-menu');
$$('#export-all-menu .menu-item').forEach(it => it.addEventListener('click', async () => {
  $('#export-all-menu').hidden = true;
  if (it.dataset.format === 'json') { const json = await store.exportAllJSON(); downloadBlob(new Blob([json], { type: 'application/json' }), 'gm-attendance-backup.json'); }
  else downloadCombinedCSV();
}));
function downloadCombinedCSV() {
  const rows = [csvDetailHeader()];
  history.slice().reverse().forEach(m => rows.push(...csvDetailRows(m)));   // oldest first, like a register
  downloadCSV(rows, `gm-attendance-all-${localDay(new Date().toISOString())}.csv`);
}

/* ============================ MODALS ============================ */
function toggleMenu(btnSel, menuSel) {
  const btn = $(btnSel), menu = $(menuSel);
  btn.addEventListener('click', e => { e.stopPropagation(); const wasHidden = menu.hidden; $$('.menu').forEach(m => m.hidden = true); menu.hidden = !wasHidden; });
}
document.addEventListener('click', () => {
  $$('.menu').forEach(m => m.hidden = true);
  $$('[aria-haspopup]').forEach(b => b.setAttribute('aria-expanded', 'false'));
});

let groupModalColor = 'teal';
function openGroupModal(assignIds) {
  assignContextIds = assignIds || [];
  $('#group-modal-name').value = '';
  groupModalColor = GRP_KEYS[groups.length % GRP_KEYS.length];
  $('#group-modal-colors').innerHTML = GRP_KEYS.map(k => `<button data-c="${k}" style="background:var(${GRP_COLORS[k]})" class="${k === groupModalColor ? 'on' : ''}"></button>`).join('');
  $$('#group-modal-colors button').forEach(b => b.addEventListener('click', () => { groupModalColor = b.dataset.c; $$('#group-modal-colors button').forEach(x => x.classList.toggle('on', x === b)); }));
  $('#group-modal').hidden = false; $('#group-modal-name').focus();
}
$('#group-modal-cancel').addEventListener('click', () => $('#group-modal').hidden = true);
$('#group-modal-save').addEventListener('click', async () => {
  const name = $('#group-modal-name').value.trim(); if (!name) return;
  const g = await store.createGroup({ name, color: groupModalColor });
  const assigned = assignContextIds;
  if (assigned.length) await store.assignMeetingsToGroup(assigned, g.id);
  $('#group-modal').hidden = true;
  assignContextIds = [];
  selectionReset();
  await load();
  toast(t('groupCreatedToast'));
  // one meeting came here from its own page, so go back to it; a batch belongs in the series
  if (assigned.length === 1) go('meeting=' + encodeURIComponent(assigned[0]));
  else go('group=' + encodeURIComponent(g.id));
});

/** Assign one meeting or a hand-picked batch; the current series is only marked if they share one. */
function openAssignModal(meetings) {
  const ms = (Array.isArray(meetings) ? meetings : [meetings]).filter(Boolean);
  if (!ms.length) return;
  assignContextIds = ms.map(m => m.id);
  const shared = ms.every(m => m.groupId === ms[0].groupId) ? ms[0].groupId : null;

  const list = $('#assign-list');
  const offered = assignableGroups(ms.map(m => m.groupId));
  list.innerHTML = offered.map(g => `<div class="assign-item ${shared === g.id ? 'current' : ''}" data-id="${esc(g.id)}"><span class="gdot" style="background:var(${GRP_COLORS[g.color] || '--grp-teal'})"></span>${esc(g.name)}</div>`).join('')
    + (ms.some(m => m.groupId) ? `<div class="assign-item" data-id="__none"><span class="gdot" style="background:var(--absent)"></span>${t('removeFromGroup')}</div>` : '');
  if (!offered.length) list.innerHTML = `<p class="hint">${t('emptyGroupsBody')}</p>`;
  $$('#assign-list .assign-item').forEach(it => it.addEventListener('click', async () => {
    const gid = it.dataset.id === '__none' ? null : it.dataset.id;
    await store.assignMeetingsToGroup(assignContextIds, gid);
    $('#assign-modal').hidden = true;
    assignContextIds = [];
    selectionReset();
    await load(); toast(t('assignedToast'));
  }));
  $('#assign-modal').hidden = false;
}
$('#assign-cancel').addEventListener('click', () => $('#assign-modal').hidden = true);
$('#assign-new').addEventListener('click', () => { $('#assign-modal').hidden = true; openGroupModal(assignContextIds); });

function dismissModal(mod) { mod.hidden = true; }
$$('.modal').forEach(mod => mod.addEventListener('click', e => { if (e.target === mod) dismissModal(mod); }));

/* ============================ SETTINGS ============================ */
function syncSettingsUI() {
  $('#set-auto-track').checked = autoTrack;
  $('#set-max').value = String(settings.maxStoredMeetings ?? 200);
  $('#set-trash-days').value = String(settings.trashRetentionDays ?? 30);
  renderLanguage();
  applyTheme(settings.theme || 'system');
  renderRosterChips();
}
$('#set-auto-track').addEventListener('change', async () => {
  autoTrack = $('#set-auto-track').checked;
  await store.setAutoTrack(autoTrack);
});

$$('#theme-seg button').forEach(b => b.addEventListener('click', async () => { settings = await store.updateSettings({ theme: b.dataset.themeVal }); applyTheme(b.dataset.themeVal); }));
$('#set-max').addEventListener('change', async () => {
  const cap = parseInt($('#set-max').value, 10) || 0; // 0 = unlimited
  settings = await store.updateSettings({ maxStoredMeetings: cap });
  if (cap > 0 && history.length > cap) { const trimmed = history.slice(0, cap); await store.saveHistory(trimmed); await load(); }
  toast(t('savedToast'));
});

// a shorter window can put records past their date straight away, so the trash is swept here
$('#set-trash-days').addEventListener('change', async () => {
  settings = await store.updateSettings({ trashRetentionDays: parseInt($('#set-trash-days').value, 10) || 30 });
  await store.purgeExpiredTrash();
  await load();
  toast(t('savedToast'));
});

/* ---- language ----
 * The flags come drawn from i18n.js, which is why this is a menu and not a <select>: an <option>
 * holds text only, and the flag emoji it would hold reads as "GB" / "PL" on Windows.
 */
const GLOBE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3.4 9h17.2M3.4 15h17.2"/><ellipse cx="12" cy="12" rx="4.2" ry="9"/></svg>';

const langByCode = code => i18n.SUPPORTED_LANGUAGES.find(l => l.code === code) || null;
/** Automatic follows the browser, so it gets a globe where a language gets its flag. */
function langMark(code) {
  const l = langByCode(code);
  return l ? `<span class="lang-mark flag">${l.flag}</span>` : `<span class="lang-mark auto">${GLOBE_ICON}</span>`;
}
function langName(code) {
  const l = langByCode(code);
  return l ? l.native : t('languageAuto');
}
function renderLanguage() {
  const cur = i18n.getLanguagePreference();
  $('#set-language').innerHTML = `${langMark(cur)}<span class="lang-name">${esc(langName(cur))}</span>`;
  $('#lang-menu').innerHTML = ['auto', ...i18n.SUPPORTED_LANGUAGES.map(l => l.code)].map(code =>
    `<button class="menu-item" role="option" aria-selected="${code === cur}" data-code="${esc(code)}">
       ${langMark(code)}<span class="mi-name">${esc(langName(code))}</span>${code === cur ? MI_CHECK : ''}</button>`).join('');
}
function setLangMenu(open) {
  $('#lang-menu').hidden = !open;
  $('#set-language').setAttribute('aria-expanded', String(open));
}
$('#set-language').addEventListener('click', e => {
  e.stopPropagation();
  const opening = $('#lang-menu').hidden;
  $$('.menu').forEach(mn => mn.hidden = true);
  setLangMenu(opening);
  if (opening) ($('#lang-menu .menu-item[aria-selected="true"]') || $('#lang-menu .menu-item')).focus();
});
$('#lang-menu').addEventListener('click', async e => {
  const item = e.target.closest('.menu-item'); if (!item) return;
  e.stopPropagation();
  setLangMenu(false);
  $('#set-language').focus();
  // setLocale is quiet when the resolved locale is unchanged (auto -> en on an English browser),
  // and the preference still moved, so the picker is repainted here rather than left to the listener
  await i18n.setLocale(item.dataset.code);
  renderLanguage();
});
// the menu replaces a control that was keyboard-operable, so it answers the same keys
$('#lang-menu').addEventListener('keydown', e => {
  const items = $$('.menu-item', $('#lang-menu'));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    items[(items.indexOf(document.activeElement) + step + items.length) % items.length].focus();
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    setLangMenu(false);
    $('#set-language').focus();
  }
});

// roster (global)
function renderRosterChips() {
  $('#roster-chips').innerHTML = roster.map((n, i) => `<span class="chip">${esc(n)}<span class="x" data-i="${i}">×</span></span>`).join('');
  $$('#roster-chips .x').forEach(x => x.addEventListener('click', async () => { roster.splice(Number(x.dataset.i), 1); await store.saveRoster(roster); renderRosterChips(); }));
}
async function addRoster(name) {
  name = (name || '').trim(); if (!name) return;
  if (!roster.some(n => n.toLowerCase() === name.toLowerCase())) roster.push(name);
  await store.saveRoster(roster); renderRosterChips();
}
$('#roster-add').addEventListener('click', () => { addRoster($('#roster-input').value); $('#roster-input').value = ''; });
$('#roster-input').addEventListener('keydown', e => { if (e.key === 'Enter') { addRoster($('#roster-input').value); $('#roster-input').value = ''; } });
$('#roster-clear').addEventListener('click', async () => { roster = []; await store.saveRoster([]); renderRosterChips(); toast(t('rosterClearedToast')); });
$('#roster-paste').addEventListener('click', () => { $('#paste-textarea').value = ''; $('#paste-modal').hidden = false; $('#paste-textarea').focus(); });
$('#paste-cancel').addEventListener('click', () => $('#paste-modal').hidden = true);
$('#paste-add').addEventListener('click', async () => {
  const names = $('#paste-textarea').value.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
  for (const n of names) await addRoster(n);
  $('#paste-modal').hidden = true;
  toast(names.length === 1 ? t('addedNamesOne') : t('addedNamesMany', { count: names.length }));
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal:not([hidden])').forEach(dismissModal); });

// import
function readTextFile(input, handler) {
  input.addEventListener('change', e => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      Promise.resolve(handler(String(reader.result || '')))
        .catch(err => { console.error('[GM Attendance] import failed:', (err && err.message) || err); toast(t('importInvalid')); });
    };
    reader.readAsText(file); e.target.value = '';
  });
}

/**
 * A CSV of ours names its series in plain text; on the way back in, that name is matched to an
 * existing series or becomes one, so a restored file lands in the same shape it left.
 */
async function resolveGroupNames(records) {
  const wanted = Array.from(new Set(records.map(r => r.groupName).filter(Boolean)));
  for (const name of wanted) {
    const key = name.trim().toLowerCase();
    let g = groups.find(x => String(x.name).trim().toLowerCase() === key);
    if (!g) { g = await store.createGroup({ name }); groups.push(g); }
    records.forEach(r => { if (r.groupName === name) r.groupId = g.id; });
  }
  records.forEach(r => { delete r.groupName; });
}

/**
 * Add imported records to the history, keeping every meeting already stored (storage.mergeMeetings
 * is the same door a restore and a sync come through), then re-read the page from what is now on
 * disk.
 */
async function mergeImportedMeetings(records) {
  const added = await store.mergeMeetings(records);
  await load();
  return added;
}

// a backup of our own: the JSON one, or a CSV this app exported
$('#btn-import').addEventListener('click', () => $('#import-file').click());
readTextFile($('#import-file'), async text => {
  if (!/^\s*[{[]/.test(text.replace(/^﻿/, ''))) {           // not JSON — read it as our CSV
    let converted;
    try { converted = importers.fromOwnCSV(text); }
    catch { toast(t('importInvalid')); return; }
    await resolveGroupNames(converted.meetings);
    const added = await mergeImportedMeetings(converted.meetings);
    toast(added ? t('importedToast', { count: added }) : t('importNothingNew'));
    return;
  }

  let data;
  try { data = JSON.parse(text); } catch { toast(t('importInvalid')); return; }
  const meetings = Array.isArray(data) ? data : (Array.isArray(data.meetings) ? data.meetings : null);
  if (!meetings) { toast(t('importInvalid')); return; }
  if (Array.isArray(data.groups)) await store.mergeGroups(data.groups);
  toast(t('importedToast', { count: await mergeImportedMeetings(meetings) }));
});

// import from another attendance extension — the file is converted first, then merged as above
$('#import-source').innerHTML = importers.IMPORT_SOURCES.map(s => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('');
$('#btn-import-app').addEventListener('click', () => $('#import-app-file').click());
readTextFile($('#import-app-file'), async text => {
  const source = importers.getImportSource($('#import-source').value) || importers.IMPORT_SOURCES[0];
  let converted;
  try { converted = source.convert(JSON.parse(text)); }
  catch { toast(t('importSourceInvalid', { source: source.label })); return; }

  const added = await mergeImportedMeetings(converted.meetings);
  toast(added ? t('importedConvertedToast', { count: added, source: source.label }) : t('importNothingNew'));
});

$('#btn-clear-all').addEventListener('click', async () => {
  if (!confirm(t('confirmClearAll'))) return;
  await store.clearHistory(); await load(); go('meetings', { replace: true });
});

/* ---- Sheets ----
 * Three steps, always all three on screen: connect an account, point at a sheet, then use it.
 * A step you cannot reach yet is dimmed rather than hidden, so the whole path is legible
 * before you start.
 */
async function refreshSheets() {
  let connected = false;
  try { connected = await sheets.isAuthenticated(); } catch { connected = false; }
  const linked = !!settings.spreadsheetId;

  $('#sheets-connect').hidden = connected;
  $('#sheets-disconnect').hidden = !connected;
  $('#sheets-account-state').textContent = connected ? t('sheetsConnected') : t('sheetsNotConnected');
  $('#sheets-step-account').classList.toggle('done', connected);

  $('#sheets-step-sheet').classList.toggle('off', !connected);
  $('#sheets-step-sheet').classList.toggle('done', linked);
  $('#sheets-sheet-state').textContent = linked ? (settings.spreadsheetName || settings.spreadsheetId) : t('sheetsNoSheet');
  $('#spreadsheet-ref').value = settings.spreadsheetId || '';
  $('#sheets-open').hidden = !linked;
  if (linked) $('#sheets-open').href = sheets.spreadsheetUrl(settings.spreadsheetId);

  // step 3 counts as done once the sheet keeps itself up to date without being told to
  const auto = linked && !!settings.autoSync;
  $('#sheets-step-data').classList.toggle('off', !linked);
  $('#sheets-step-data').classList.toggle('done', auto);
  $('#set-autosync').checked = !!settings.autoSync;

  // an unattended sync is only believable if you can see when it last ran
  const { lastSyncAt } = await store.getSyncState();
  const stamp = $('#sheets-sync-state');
  stamp.hidden = !(auto && lastSyncAt);
  if (!stamp.hidden) {
    stamp.textContent = t('sheetsLastSync', {
      when: `${i18n.formatDate(lastSyncAt, { day: 'numeric', month: 'short' })}, ${i18n.formatTime(lastSyncAt)}`
    });
  }
}

/**
 * Opening the register is when it matters that it is current, so a pass runs here as well as in
 * the worker, throttled so a reload does not sync again. Whatever came in is loaded into the page.
 */
async function syncOnOpen() {
  let moved = null;
  try { moved = await sheetsSync.autoSync({ maxAgeMs: sheetsSync.OPEN_INTERVAL_MS }); }
  catch (e) { console.warn('[GM Attendance] sync on open failed:', (e && e.message) || e); }
  if (!moved) return;

  if (moved.pulled || moved.pulledGroups) {
    await load();
    toast(t('sheetsPulledToast', { count: moved.pulled }));
  }
  refreshSheets();
}

/**
 * Link a sheet and leave it ready to be written to: a spreadsheet picked by hand rarely has the
 * tabs, so they are created here. Its own title is remembered, so step 2 can name the sheet
 * instead of showing a raw id.
 */
async function linkSpreadsheet(id) {
  sheetsNote();                        // advice about the last sheet does not carry to another one
  const { spreadsheet, prepared } = await sheets.ensureSheets(id);
  settings = await store.updateSettings({
    spreadsheetId: id,
    spreadsheetName: (spreadsheet.properties && spreadsheet.properties.title) || null
  });
  return prepared;
}
$('#sheets-connect').addEventListener('click', async () => {
  $('#sheets-connect').disabled = true;
  try { await sheets.getAuthToken(true); toast(t('sheetsConnectedToast')); }
  catch (e) { console.error('[GM Attendance] Google sign-in failed:', (e && e.message) || e); toast(t('sheetsConnectFailed')); }
  $('#sheets-connect').disabled = false; refreshSheets();
});
$('#sheets-disconnect').addEventListener('click', async () => {
  if (!confirm(t('confirmSheetsDisconnect'))) return;
  try { const tok = await sheets.getAuthToken(false); if (tok) await sheets.removeCachedToken(tok); } catch {}
  settings = await store.updateSettings({ spreadsheetId: null, spreadsheetName: null, autoSync: false });
  sheetsNote();
  toast(t('sheetsDisconnectedToast')); refreshSheets();
});
$('#sheets-create').addEventListener('click', async () => {
  $('#sheets-create').disabled = true;
  try {
    const ss = await sheets.createSpreadsheet();
    settings = await store.updateSettings({ spreadsheetId: ss.spreadsheetId, spreadsheetName: (ss.properties && ss.properties.title) || null });
    sheetsNote();                      // a fresh sheet has nothing to be advised about yet
    toast(t('sheetsCreatedToast'));
    window.open(sheets.spreadsheetUrl(ss.spreadsheetId), '_blank');
  } catch (e) { console.error('[GM Attendance] create spreadsheet failed:', (e && e.message) || e); toast(t('sheetsCreateFailed')); }
  $('#sheets-create').disabled = false; refreshSheets();
});
// a link or a bare id, whichever the user has at hand: the id is read out of it here
async function useSpreadsheet() {
  const id = sheets.parseSpreadsheetRef($('#spreadsheet-ref').value);
  if (!id) { toast(t('sheetsRefRequired')); return; }
  $('#sheets-save').disabled = true;
  try { toast(await linkSpreadsheet(id) ? t('sheetsPreparedToast') : t('sheetsSavedToast')); }
  catch (e) { console.error('[GM Attendance] open spreadsheet failed:', (e && e.message) || e); toast(t('sheetsSaveFailed')); }
  $('#sheets-save').disabled = false; refreshSheets();
}
$('#sheets-save').addEventListener('click', useSpreadsheet);
$('#spreadsheet-ref').addEventListener('keydown', ev => { if (ev.key === 'Enter') useSpreadsheet(); });

/**
 * What the last send or restore left alone, and what can be done about it. A toast is gone in two
 * seconds and this is a suggestion, so it stays under step 3 until the next attempt — with the way
 * to act on it, which is the sheet itself, beside it.
 */
function sheetsNote(...lines) {
  const el = $('#sheets-note');
  const said = lines.filter(Boolean);
  el.hidden = !said.length;
  const link = settings.spreadsheetId
    ? `<a href="${esc(sheets.spreadsheetUrl(settings.spreadsheetId))}" target="_blank" rel="noopener">${esc(t('sheetsOpenNote'))}</a>`
    : '';
  el.innerHTML = said.length ? said.map(s => `<p>${esc(s)}</p>`).join('') + link : '';
}

// everything the sheet has not got is added to it; everything it has stays as it was sent
$('#sheets-push').addEventListener('click', async () => {
  if (!settings.spreadsheetId) return;
  $('#sheets-push').disabled = true;
  sheetsNote();
  try {
    const res = await sheetsSync.pushEverything(settings.spreadsheetId);
    toast(res.pushed || res.pushedGroups ? t('sheetsPushedToast', { count: res.pushed }) : t('sheetsPushNothingNew'));
    sheetsNote(
      res.kept && t('sheetsPushKept', { count: res.kept }),
      res.running && t('sheetsPushRunning', { count: res.running })
    );
  } catch (e) { console.error('[GM Attendance] push to Sheets failed:', (e && e.message) || e); toast(t('sheetsPushFailed')); }
  $('#sheets-push').disabled = false;
});

// and back again: whatever the sheet holds that is not here yet is added, nothing is removed
$('#sheets-restore').addEventListener('click', async () => {
  if (!settings.spreadsheetId) return;
  if (!confirm(t('confirmSheetsRestore'))) return;
  $('#sheets-restore').disabled = true;
  sheetsNote();
  try {
    const res = await sheetsSync.pullEverything(settings.spreadsheetId);
    if (!res.found) { toast(t('sheetsNoBackup')); }
    else {
      await load();
      toast(res.pulled || res.pulledGroups ? t('sheetsRestoredToast', { count: res.pulled }) : t('importNothingNew'));
      sheetsNote(
        res.kept && t('sheetsRestoreKept', { count: res.kept }),
        res.trashed && t('sheetsRestoreTrashed', { count: res.trashed })
      );
    }
  } catch (e) { console.error('[GM Attendance] restore from Sheets failed:', (e && e.message) || e); toast(t('sheetsRestoreFailed')); }
  $('#sheets-restore').disabled = false;
});
$('#set-autosync').addEventListener('change', async () => {
  settings = await store.updateSettings({ autoSync: $('#set-autosync').checked });
  toast(t('savedToast'));
  refreshSheets();
});

/* ============================ locale ============================ */
i18n.onLocaleChange(() => {
  i18n.applyI18n(document);
  renderLanguage();   // "Automatic" is a translated label, so the picker reads differently now
  renderReadout();
  route(true);
});

/* ============================ boot ============================ */
(async function boot() {
  await i18n.initI18n();
  initTips();   // one delegated listener for every mark that carries a readout
  // A CSV exported in either language has to import, so the reader needs every locale's headers.
  importers.configureLocaleLabels(await i18n.getAllMessages());
  await initAnalytics({
    history: () => history,
    groups: () => groups,
    groupById,
    groupColorVar,
    rosterFor: effectiveRoster,
    openMeeting: id => go('meeting=' + encodeURIComponent(id)),
    exportCSV
  });
  await load();
  watchLive();
  await refreshSheets();
  syncOnOpen();
})();
