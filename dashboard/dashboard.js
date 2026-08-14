import * as store from '../src/lib/storage.js';
import * as A from '../src/lib/attendance.js';
import * as i18n from '../src/lib/i18n.js';
import * as sheets from '../src/lib/sheets-api.js';
import * as importers from '../src/lib/importers.js';
import { initAnalytics, renderAnalytics } from './analytics.js';

const { t } = i18n;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ------------------------------ state ------------------------------ */
let history = [];         // normalized meetings, newest-first
let groups = [];
let settings = {};
let roster = [];          // global default roster
let autoTrack = true;     // own storage key, not part of settings
let curMeetingId = null;
let curGroupId = null;
let assignContextIds = []; // meeting ids awaiting a series assignment

const GRP_COLORS = { teal: '--grp-teal', amber: '--grp-amber', violet: '--grp-violet', rose: '--grp-rose', sky: '--grp-sky', lime: '--grp-lime' };
const GRP_KEYS = Object.keys(GRP_COLORS);

/* ------------------------------ utils ------------------------------ */
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
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
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
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
  return { view, person: view === 'people' ? (p.get('person') || null) : null };
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
  switchView(r.view);
  if (r.view === 'people' && r.person) expandPerson(r.person);
}

// go() renders straight after pushState; these catch the browser's own moves through history.
window.addEventListener('popstate', () => route());
window.addEventListener('hashchange', () => route());

function switchView(name) {
  $$('.tab').forEach(tb => tb.classList.toggle('on', tb.dataset.view === (PARENT_TAB[name] || name)));
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
$('#btn-back-group').addEventListener('click', () => goBack('groups'));

/* ------------------------------ load ------------------------------ */
async function load() {
  const [h, g, s, r, at] = await Promise.all([
    store.getHistory(), store.getGroups(), store.getSettings(), store.getRoster(), store.getAutoTrack()
  ]);
  history = h.map(A.normalizeMeeting).sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  groups = g; settings = s; roster = r; autoTrack = at;
  applyTheme(settings.theme || 'system');
  renderReadout();
  syncSettingsUI();
  route(true);   // whatever is on screen is re-read from the fresh data
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
    if (on) drawSelectionBar(bar, actions, paint);
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

function drawSelectionBar(bar, actions, paint) {
  const n = selection.keys.size;
  const shown = actions.filter(a => n >= (a.min || 1));
  bar.innerHTML = `<span class="sel-count mono">${esc(t('selCount', { count: n }))}</span>
    <div class="sel-acts">${shown.map((a, i) =>
      `<button class="sel-act${a.danger ? ' danger' : ''}" data-i="${i}">${esc(a.label())}</button>`).join('')}</div>
    <button class="sel-close" title="${esc(t('selClear'))}" aria-label="${esc(t('selClear'))}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 6 12 12M18 6 6 18"/></svg></button>`;
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
function meetingMatches(m, q) {
  if (m.meetingTitle.toLowerCase().includes(q)) return true;
  return Object.keys(m.attendance).some(n => n.toLowerCase().includes(q));
}
function renderMeetings(filter = '') {
  const q = filter.toLowerCase();
  const list = q ? history.filter(m => meetingMatches(m, q)) : history;

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
  if (!list.length) { table.style.display = 'none'; empty.classList.add('visible'); return; }
  table.style.display = ''; empty.classList.remove('visible');

  $('#meetings-body').innerHTML = list.map(m => {
    const startIso = A.meetingStartIso(m);
    const d = new Date(startIso);
    const people = Object.keys(m.attendance).length;
    const avg = people ? Math.round(Object.values(m.attendance).reduce((s, a) => s + A.liveSecondsFor(a, m), 0) / people) : 0;
    const g = m.groupId ? groupById(m.groupId) : null;
    const groupCell = g
      ? `<span class="group-pill"><span class="gdot" style="background:var(${GRP_COLORS[g.color] || '--grp-teal'})"></span><span class="gname">${esc(g.name)}</span></span>`
      : '';
    const live = A.isInProgress(m) ? `<span class="status status--present" style="margin-left:6px">${t('inCall')}</span>` : '';
    const badge = `<div class="date-badge"><span class="day">${d.getDate()}</span><span class="mon">${esc(i18n.monthShort(d))}</span></div>`;
    return `<div class="row meetings-grid" data-id="${esc(m.id)}">
      <div class="col-date">${pickHandle(m.id, badge)}</div>
      <div class="col-title"><div class="m-title" title="${esc(m.meetingTitle)}">${esc(m.meetingTitle)}${live}</div><div class="m-sub">${i18n.formatTime(startIso)}</div></div>
      <div class="col-group">${groupCell}</div>
      <div class="col-people num">${people}</div>
      <div class="col-avg num">${fmtDur(avg)}</div>
      <div class="col-actions" style="text-align:right"><button class="row-action" data-act="export" data-id="${esc(m.id)}">${t('export')}</button></div>
    </div>`;
  }).join('');

  $$('#meetings-body .row').forEach(row => row.addEventListener('click', () => {
    if (selectionClick(row.dataset.id)) return;
    go('meeting=' + encodeURIComponent(row.dataset.id));
  }));
  $$('#meetings-body [data-act="export"]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); downloadMeetingCSV(b.dataset.id); }));

  mountSelection({
    scope: 'meetings', head: $('#meetings-table .list-head'), root: $('#meetings-body'),
    actions: [
      { label: () => t('addToGroup'), run: ids => openAssignModal(ids.map(id => history.find(m => m.id === id)).filter(Boolean)) },
      { label: () => t('exportCsv'), run: ids => downloadSelectionCSV(ids) },
      {
        label: () => t('delete'), danger: true,
        run: async ids => {
          if (!confirm(t('confirmDeleteMeetings', { count: ids.length }))) return;
          for (const id of ids) await store.deleteMeetingById(id);
          selectionReset(); await load();
          toast(t('deletedMeetingsToast', { count: ids.length }));
        }
      }
    ]
  });
}
$('#meeting-search').addEventListener('input', e => renderMeetings(e.target.value.trim()));

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
  $('#detail-meta').innerHTML =
    `<b>${people.length}</b> ${t('metaAttended')} · <b>${absentees.length}</b> ${t('metaAbsent')}`;

  const avg = people.length ? Math.round(people.reduce((s, [, a]) => s + A.liveSecondsFor(a, m), 0) / people.length) : 0;
  setStat($('#d-attended'), people.length, absentees.length ? `+${absentees.length} ${t('absent').toLowerCase()}` : '');
  setStat($('#d-avg'), fmtDur(avg), '');
  const share = people.length ? Math.round(people.reduce((s, [, a]) => s + A.sharePct(a, m), 0) / people.length) : 0;
  setStat($('#d-share'), share, '%');
  setStat($('#d-length'), fmtDur(A.meetingDurationSeconds(m)), '');

  // group button label
  const g = m.groupId ? groupById(m.groupId) : null;
  $('#btn-group').textContent = g ? g.name : t('addToGroup');

  // the hours badge reads them out and edits them; pinned hours are marked, not spelled out
  const hours = $('#btn-hours'), pinned = A.hasSchedule(m);
  $('#hours-value').textContent = `${i18n.formatTime(startIso)}–${i18n.formatTime(endIso)}`;
  hours.classList.toggle('pinned', pinned);
  hours.title = pinned ? t('hoursPinnedTitle') : t('hoursAutoTitle');

  renderTimeline(m);
  renderAttendance(m, $('#participant-search').value.trim());
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
      segs += `<div class="seg" style="left:${left}%;width:${width}%"></div>`;
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
$('#btn-rename').addEventListener('click', () => startRename());
function startRename() {
  const m = currentMeeting(); if (!m) return;
  const input = $('#rename-input');
  $('#detail-title').hidden = true; input.hidden = false; input.value = m.meetingTitle; input.focus(); input.select();
}
async function commitRename() {
  const m = currentMeeting(); const input = $('#rename-input');
  const v = input.value.trim();
  if (m && v) {
    m.meetingTitle = v;
    const stored = await store.getMeetingById(m.id);
    if (stored) { stored.meetingTitle = v; await store.upsertMeeting(stored); }
    $('#detail-title').textContent = v;
  }
  input.hidden = true; $('#detail-title').hidden = false;
  renderMeetings($('#meeting-search').value.trim());
}
$('#rename-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
  else if (e.key === 'Escape') { $('#rename-input').hidden = true; $('#detail-title').hidden = false; }
});
$('#rename-input').addEventListener('blur', commitRename);

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
  save.textContent = target ? t('merge') : t('save');
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

$('#btn-delete').addEventListener('click', async () => {
  const m = currentMeeting(); if (!m) return;
  if (!confirm(t('confirmDeleteMeeting'))) return;
  await store.deleteMeetingById(m.id);
  await load(); go('meetings', { replace: true });
});

// export — the same three controls the series head offers, in the same order
$('#btn-copy').addEventListener('click', () => { const m = currentMeeting(); if (m) copyMeeting(m); });
$('#btn-export').addEventListener('click', () => { if (curMeetingId) downloadMeetingCSV(curMeetingId); });
$('#btn-pdf').addEventListener('click', () => { if (curMeetingId) openReport('meeting', curMeetingId); });

// assign to group
$('#btn-group').addEventListener('click', () => openAssignModal(currentMeeting()));

/* ============================ GROUPS ============================ */
function renderGroups() {
  renderSeriesSuggestions();
  const list = $('#groups-list'), empty = $('#groups-empty');
  if (!groups.length) { list.innerHTML = ''; empty.classList.add('visible'); return; }
  empty.classList.remove('visible');

  list.innerHTML = groups.map(g => {
    const ms = history.filter(m => m.groupId === g.id);
    const agg = A.aggregateGroup(ms, g.roster);
    const avgAtt = agg.people.length ? Math.round(agg.people.reduce((s, p) => s + p.avgShare, 0) / agg.people.length) : 0;
    return `<div class="card group-card" data-id="${esc(g.id)}">
      <div class="gc-top"><span class="gc-swatch" style="background:var(${GRP_COLORS[g.color] || '--grp-teal'})"></span>
        <div style="min-width:0"><h3>${esc(g.name)}</h3><div class="gc-meta">${ms.length === 1 ? t('sessionOne') : t('sessionsN', { count: ms.length })}</div></div></div>
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

  $('#group-eyebrow').innerHTML = `<span style="color:var(${GRP_COLORS[g.color] || '--grp-teal'})">●</span> ${t('navGroups').toUpperCase()}`;
  $('#group-title').textContent = g.name;
  $('#group-title').title = g.name;
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
    segs += `<div class="seg" style="left:${left}%;width:${width}%"></div>`;
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
  $('#group-title').hidden = true; input.hidden = false; input.value = g.name; input.focus(); input.select();
}
async function commitGroupRename() {
  const g = groupById(curGroupId); const input = $('#group-rename-input'); const v = input.value.trim();
  if (g && v) { g.name = v; await store.updateGroup(g.id, { name: v }); $('#group-title').textContent = v; }
  input.hidden = true; $('#group-title').hidden = false;
}
$('#group-rename-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); commitGroupRename(); }
  else if (e.key === 'Escape') { $('#group-rename-input').hidden = true; $('#group-title').hidden = false; }
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
function copyMeeting(m) {
  let text = `${m.meetingTitle}\n${new Date(m.date).toLocaleString()}\n\n`;
  Object.entries(m.attendance).sort(([a], [b]) => a.localeCompare(b)).forEach(([name, a]) => { text += `${name} — ${i18n.formatTime(a.firstSeen)} — ${fmtHMS(A.liveSecondsFor(a, m))}\n`; });
  navigator.clipboard.writeText(text).then(() => toast(t('copiedToast')));
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
document.addEventListener('click', () => $$('.menu').forEach(m => m.hidden = true));

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
  list.innerHTML = groups.map(g => `<div class="assign-item ${shared === g.id ? 'current' : ''}" data-id="${esc(g.id)}"><span class="gdot" style="background:var(${GRP_COLORS[g.color] || '--grp-teal'})"></span>${esc(g.name)}</div>`).join('')
    + (ms.some(m => m.groupId) ? `<div class="assign-item" data-id="__none"><span class="gdot" style="background:var(--absent)"></span>${t('removeFromGroup')}</div>` : '');
  if (!groups.length) list.innerHTML = `<p class="hint">${t('emptyGroupsBody')}</p>`;
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
  $('#set-language').value = i18n.getLanguagePreference();
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

// language
(function initLang() {
  const sel = $('#set-language');
  const auto = document.createElement('option');
  auto.value = 'auto'; auto.dataset.i18n = 'languageAuto'; auto.textContent = t('languageAuto');
  sel.appendChild(auto);
  i18n.SUPPORTED_LANGUAGES.forEach(l => { const o = document.createElement('option'); o.value = l.code; o.textContent = `${l.flag} ${l.native}`; sel.appendChild(o); });
  sel.value = i18n.getLanguagePreference();
  sel.addEventListener('change', () => i18n.setLocale(sel.value));
})();

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
 * Add imported records to the history, keeping every meeting already stored. Merge annotations
 * become the meeting's nameMap, and records are written *unmerged* — merging on write would
 * bake two people into one and make the merge impossible to undo (see storage.upsertMeeting).
 *
 * Starts from what is on disk rather than from `history`, which is the merged *view*: writing
 * that back would bake every existing merge in as a side effect of importing.
 */
async function mergeImportedMeetings(records) {
  const byId = new Map((await store.getHistory()).map(m => [m.id, m]));
  let added = 0;
  records.forEach(rec => {
    if (rec && rec.id && !byId.has(rec.id)) { byId.set(rec.id, A.adoptMergeAnnotations(rec)); added++; }
  });
  const merged = Array.from(byId.values())
    .map(m => A.normalizeMeeting(m, { mergeAliases: false }))
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  await store.saveHistory(merged);
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
  if (data.groups && Array.isArray(data.groups)) {
    const gids = new Set(groups.map(g => g.id));
    data.groups.forEach(g => { if (g && g.id && !gids.has(g.id)) groups.push(g); });
    await store.saveGroups(groups);
  }
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
  $('#spreadsheet-id').value = settings.spreadsheetId || '';
  $('#sheets-open').hidden = !linked;
  if (linked) $('#sheets-open').href = 'https://docs.google.com/spreadsheets/d/' + settings.spreadsheetId + '/edit';

  $('#sheets-step-data').classList.toggle('off', !linked);
  $('#set-autosync').checked = !!settings.autoSync;
}

/** Remember the sheet's own title, so step 2 can name it instead of showing a raw id. */
async function linkSpreadsheet(id) {
  const ss = await sheets.getSpreadsheet(id);
  settings = await store.updateSettings({
    spreadsheetId: id,
    spreadsheetName: (ss.properties && ss.properties.title) || null
  });
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
  toast(t('sheetsDisconnectedToast')); refreshSheets();
});
$('#sheets-create').addEventListener('click', async () => {
  $('#sheets-create').disabled = true;
  try {
    const ss = await sheets.createSpreadsheet();
    settings = await store.updateSettings({ spreadsheetId: ss.spreadsheetId, spreadsheetName: (ss.properties && ss.properties.title) || null });
    toast(t('sheetsCreatedToast'));
    window.open('https://docs.google.com/spreadsheets/d/' + ss.spreadsheetId + '/edit', '_blank');
  } catch (e) { console.error('[GM Attendance] create spreadsheet failed:', (e && e.message) || e); toast(t('sheetsCreateFailed')); }
  $('#sheets-create').disabled = false; refreshSheets();
});
$('#sheets-save').addEventListener('click', async () => {
  const id = $('#spreadsheet-id').value.trim(); if (!id) { toast(t('sheetsIdRequired')); return; }
  $('#sheets-save').disabled = true;
  try { await linkSpreadsheet(id); toast(t('sheetsSavedToast')); }
  catch (e) { console.error('[GM Attendance] open spreadsheet failed:', (e && e.message) || e); toast(t('sheetsSaveFailed')); }
  $('#sheets-save').disabled = false; refreshSheets();
});

// the sheet becomes a full backup: every stored record goes in, replacing what was there
$('#sheets-push').addEventListener('click', async () => {
  if (!settings.spreadsheetId) return;
  $('#sheets-push').disabled = true;
  try {
    const stored = await store.getHistory();      // raw records, merges unbaked
    const res = await sheets.pushAll(settings.spreadsheetId, { meetings: stored, groups });
    toast(t('sheetsPushedToast', { count: res.meetings }));
  } catch (e) { console.error('[GM Attendance] push to Sheets failed:', (e && e.message) || e); toast(t('sheetsPushFailed')); }
  $('#sheets-push').disabled = false;
});

// and back again: whatever the sheet holds that is not here yet is added, nothing is removed
$('#sheets-restore').addEventListener('click', async () => {
  if (!settings.spreadsheetId) return;
  if (!confirm(t('confirmSheetsRestore'))) return;
  $('#sheets-restore').disabled = true;
  try {
    const { meetings, groups: restoredGroups } = await sheets.restoreAll(settings.spreadsheetId);
    if (!meetings.length && !restoredGroups.length) { toast(t('sheetsNoBackup')); }
    else {
      const known = new Set(groups.map(g => g.id));
      const fresh = restoredGroups.filter(g => g && g.id && !known.has(g.id));
      if (fresh.length) { groups = groups.concat(fresh); await store.saveGroups(groups); }
      const added = await mergeImportedMeetings(meetings);
      toast(added || fresh.length ? t('sheetsRestoredToast', { count: added }) : t('importNothingNew'));
    }
  } catch (e) { console.error('[GM Attendance] restore from Sheets failed:', (e && e.message) || e); toast(t('sheetsRestoreFailed')); }
  $('#sheets-restore').disabled = false;
});
$('#set-autosync').addEventListener('change', async () => { settings = await store.updateSettings({ autoSync: $('#set-autosync').checked }); toast(t('savedToast')); });

/* ============================ locale ============================ */
i18n.onLocaleChange(() => {
  i18n.applyI18n(document);
  renderReadout();
  route(true);
});

/* ============================ boot ============================ */
(async function boot() {
  await i18n.initI18n();
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
  refreshSheets();
})();
