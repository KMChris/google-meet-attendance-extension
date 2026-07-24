import * as store from '../src/lib/storage.js';
import * as A from '../src/lib/attendance.js';
import * as i18n from '../src/lib/i18n.js';
import * as sheets from '../src/lib/sheets-api.js';

const { t } = i18n;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ------------------------------ state ------------------------------ */
let history = [];         // normalized meetings, newest-first
let groups = [];
let settings = {};
let roster = [];          // global default roster
let lateThreshold = 5;
let curMeetingId = null;
let curGroupId = null;
let assignContextId = null; // meeting id awaiting group assignment

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
function fmtDur(secs) {
  secs = Math.floor(secs || 0);
  if (secs <= 0) return '0m';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
function fmtHMS(secs) {
  secs = Math.floor(secs || 0);
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}
function setStat(el, value, unit) { el.innerHTML = unit ? `${value}<span class="u">${esc(unit)}</span>` : `${value}`; }
function cssVar(name) { return getComputedStyle(document.body).getPropertyValue(name).trim() || '#888'; }

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

/* ------------------------------ nav ------------------------------ */
function switchView(name) {
  $$('.tab').forEach(tb => tb.classList.toggle('on', tb.dataset.view === name));
  $$('.view').forEach(v => v.classList.remove('on'));
  const view = $('#view-' + name);
  if (view) view.classList.add('on');
  if (name === 'groups') renderGroups();
  if (name === 'people') renderPeople($('#people-search').value.trim());
  if (name === 'analytics') renderAnalytics();
}
$$('.tab').forEach(tb => tb.addEventListener('click', () => switchView(tb.dataset.view)));
$('#btn-back-detail').addEventListener('click', () => { curMeetingId = null; switchView('meetings'); });
$('#btn-back-group').addEventListener('click', () => { curGroupId = null; switchView('groups'); });

/* ------------------------------ load ------------------------------ */
async function load() {
  const [h, g, s, r] = await Promise.all([store.getHistory(), store.getGroups(), store.getSettings(), store.getRoster()]);
  history = h.map(A.normalizeMeeting).sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  groups = g; settings = s; roster = r;
  lateThreshold = Number(settings.lateThresholdMinutes) || 5;
  applyTheme(settings.theme || 'system');
  renderReadout();
  renderMeetings($('#meeting-search').value.trim());
  syncSettingsUI();
  handleDeepLink();
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
    const d = new Date(m.date);
    const people = Object.keys(m.attendance).length;
    const avg = people ? Math.round(Object.values(m.attendance).reduce((s, a) => s + A.liveSecondsFor(a, m), 0) / people) : 0;
    const g = m.groupId ? groupById(m.groupId) : null;
    const groupCell = g
      ? `<span class="group-pill"><span class="gdot" style="background:var(${GRP_COLORS[g.color] || '--grp-teal'})"></span><span class="gname">${esc(g.name)}</span></span>`
      : '';
    const live = A.isInProgress(m) ? `<span class="status status--present" style="margin-left:6px">${t('inCall')}</span>` : '';
    return `<div class="row meetings-grid" data-id="${esc(m.id)}">
      <div class="col-date"><div class="date-badge"><span class="day">${d.getDate()}</span><span class="mon">${esc(i18n.monthShort(d))}</span></div></div>
      <div class="col-title"><div class="m-title">${esc(m.meetingTitle)}${live}</div><div class="m-sub">${i18n.formatTime(m.date)}</div></div>
      <div class="col-group">${groupCell}</div>
      <div class="col-people num">${people}</div>
      <div class="col-avg num">${fmtDur(avg)}</div>
      <div class="col-actions" style="text-align:right"><button class="row-action" data-act="export" data-id="${esc(m.id)}">${t('export')}</button></div>
    </div>`;
  }).join('');

  $$('#meetings-body .row').forEach(row => row.addEventListener('click', () => openMeeting(row.dataset.id)));
  $$('#meetings-body [data-act="export"]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); downloadMeetingCSV(b.dataset.id); }));
}
$('#meeting-search').addEventListener('input', e => renderMeetings(e.target.value.trim()));

/* ============================ MEETING DETAIL ============================ */
function currentMeeting() { return history.find(m => m.id === curMeetingId) || null; }

function openMeeting(id) {
  curMeetingId = id;
  const m = currentMeeting(); if (!m) return;
  renderDetail(m);
  switchView('detail');
}

function renderDetail(m) {
  const roster = effectiveRoster(m);
  const people = Object.entries(m.attendance);
  const absentees = A.absenteesFor(m, roster);
  const lateN = people.filter(([, a]) => A.isLate(a, m, lateThreshold)).length;

  $('#detail-eyebrow').textContent =
    `${i18n.formatDate(m.date, { weekday: 'short', day: 'numeric', month: 'short' })} · ${i18n.formatTime(m.date)} · ${m.meetingCode || m.id}`;
  $('#detail-title').textContent = m.meetingTitle;
  $('#detail-meta').innerHTML =
    `<b>${people.length}</b> ${t('metaAttended')} · <b>${absentees.length}</b> ${t('metaAbsent')} · <b>${lateN}</b> ${t('metaLate')}`;

  const avg = people.length ? Math.round(people.reduce((s, [, a]) => s + A.liveSecondsFor(a, m), 0) / people.length) : 0;
  setStat($('#d-attended'), people.length, absentees.length ? `+${absentees.length} ${t('absent').toLowerCase()}` : '');
  setStat($('#d-avg'), fmtDur(avg), '');
  setStat($('#d-ontime'), people.length - lateN, `/${people.length}`);
  setStat($('#d-length'), fmtDur(A.meetingDurationSeconds(m)), '');

  // group button label
  const g = m.groupId ? groupById(m.groupId) : null;
  $('#btn-group').textContent = g ? g.name : t('addToGroup');

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
    const late = A.isLate(a, m, lateThreshold);
    const dot = late ? 'var(--late)' : 'var(--present)';
    let segs = '';
    (a.sessions || []).forEach(s => {
      const sMs = Date.parse(s.joinedAt); if (Number.isNaN(sMs)) return;
      const eMs = s.leftAt ? Date.parse(s.leftAt) : endMs;
      const left = Math.max(0, (Math.max(sMs, startMs) - startMs) / span * 100);
      const width = Math.max(0.6, (Math.min(eMs, endMs) - Math.max(sMs, startMs)) / span * 100);
      segs += `<div class="seg" style="left:${left}%;width:${width}%"></div>`;
    });
    if (late && a.firstSeen) {
      const p = (Date.parse(a.firstSeen) - startMs) / span * 100;
      segs += `<span class="evt late" style="left:${Math.max(0, Math.min(100, p))}%"></span>`;
    }
    if (!a.present && a.lastLeft) {
      const leftMs = Date.parse(a.lastLeft);
      if (endMs - leftMs > 30000) {
        const p = (leftMs - startMs) / span * 100;
        segs += `<span class="evt early" style="left:${Math.max(0, Math.min(100, p))}%"></span>`;
      }
    }
    lanes += `<div class="tl-lane"><div class="tl-name"><span class="dot" style="background:${dot}"></span><span class="who">${esc(name)}</span></div><div class="tl-track">${segs}</div></div>`;
  });

  A.absenteesFor(m, effectiveRoster(m)).sort((a, b) => a.localeCompare(b)).forEach(name => {
    lanes += `<div class="tl-lane absent"><div class="tl-name"><span class="dot" style="background:var(--absent)"></span><span class="who" style="color:var(--ink-3)">${esc(name)}</span></div><div class="tl-track"><span class="tl-abs">${t('absent')}</span></div></div>`;
  });

  const legend = `<div class="tl-legend">
    <span class="lg"><span class="sw" style="background:var(--present)"></span>${t('legendPresent')}</span>
    <span class="lg"><span class="sw tick" style="background:var(--late)"></span>${t('legendLate')}</span>
    <span class="lg"><span class="sw tick" style="background:var(--red)"></span>${t('legendEarly')}</span>
    <span class="lg"><span class="sw" style="background:var(--absent-2);border:1px solid var(--line-2)"></span>${t('legendAbsent')}</span>
  </div>`;

  tl.innerHTML = axis + lanes + legend;
}

function renderAttendance(m, filter) {
  const q = (filter || '').toLowerCase();
  let people = Object.entries(m.attendance).sort((a, b) => a[0].localeCompare(b[0]));
  if (q) people = people.filter(([n]) => n.toLowerCase().includes(q));

  let rows = people.map(([name, a]) => {
    const st = A.statusFor(a, m, lateThreshold);
    let chip;
    if (st.late) chip = `<span class="status status--late">${t('lateBy', { n: st.lateMinutes })}</span>`;
    else if (a.present) chip = `<span class="status status--present">${t('inCall')}</span>`;
    else chip = `<span class="status status--left">${t('left')}</span>`;
    return `<tr>
      <td><div class="name-cell"><span class="avatar" style="${avatarStyle(name)}">${esc(initials(name))}</span><span class="nm">${esc(name)}</span></div></td>
      <td class="mono">${i18n.formatTime(a.firstSeen)}</td>
      <td class="mono">${a.present ? '<span class="mono">'+esc(t('inCall'))+'</span>' : i18n.formatTime(a.lastLeft)}</td>
      <td class="num mono">${fmtHMS(st.seconds)}</td>
      <td><div class="share-cell"><div class="share-bar"><i style="width:${st.sharePct}%"></i></div><span class="pct">${st.sharePct}%</span></div></td>
      <td>${chip}</td>
    </tr>`;
  }).join('');

  let absentees = A.absenteesFor(m, effectiveRoster(m));
  if (q) absentees = absentees.filter(n => n.toLowerCase().includes(q));
  rows += absentees.sort((a, b) => a.localeCompare(b)).map(name => `<tr>
      <td><div class="name-cell"><span class="avatar avatar--muted">${esc(initials(name))}</span><span class="nm" style="color:var(--ink-2)">${esc(name)}</span></div></td>
      <td class="mono">—</td><td class="mono">—</td><td class="num mono">00:00:00</td>
      <td><div class="share-cell"><div class="share-bar"><i style="width:0"></i></div><span class="pct">0%</span></div></td>
      <td><span class="status status--absent">${t('absent')}</span></td>
    </tr>`).join('');

  // header (localized) built once per render
  const thead = `<thead><tr><th data-i18n="colParticipant">${t('colParticipant')}</th><th>${t('colFirstSeen')}</th><th>${t('colLastLeft')}</th><th class="num">${t('colPresent')}</th><th>${t('colShare')}</th><th>${t('colStatus')}</th></tr></thead>`;
  $('#attendance-table').innerHTML = thead + `<tbody id="attendance-body">${rows}</tbody>`;
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

$('#btn-delete').addEventListener('click', async () => {
  const m = currentMeeting(); if (!m) return;
  if (!confirm(t('confirmDeleteMeeting'))) return;
  await store.deleteMeetingById(m.id);
  await load(); switchView('meetings');
});

// export menu
toggleMenu('#btn-export', '#export-menu');
$$('#export-menu .menu-item').forEach(it => it.addEventListener('click', () => {
  $('#export-menu').hidden = true;
  const m = currentMeeting(); if (!m) return;
  if (it.dataset.format === 'pdf') openReport('meeting', m.id);
  else if (it.dataset.format === 'csv') downloadMeetingCSV(m.id);
  else copyMeeting(m);
}));

// assign to group
$('#btn-group').addEventListener('click', () => { assignContextId = curMeetingId; openAssignModal(currentMeeting()); });

/* ============================ GROUPS ============================ */
function renderGroups() {
  renderSeriesSuggestions();
  const list = $('#groups-list'), empty = $('#groups-empty');
  if (!groups.length) { list.innerHTML = ''; empty.classList.add('visible'); return; }
  empty.classList.remove('visible');

  list.innerHTML = groups.map(g => {
    const ms = history.filter(m => m.groupId === g.id);
    const agg = A.aggregateGroup(ms, g.roster, lateThreshold);
    const avgAtt = agg.people.length ? Math.round(agg.people.reduce((s, p) => s + p.avgShare, 0) / agg.people.length) : 0;
    return `<div class="card group-card" data-id="${esc(g.id)}">
      <div class="gc-top"><span class="gc-swatch" style="background:var(${GRP_COLORS[g.color] || '--grp-teal'})"></span>
        <div style="min-width:0"><h3>${esc(g.name)}</h3><div class="gc-meta">${ms.length === 1 ? t('sessionOne') : t('sessionsN', { n: ms.length })}</div></div></div>
      <div class="gc-stats">
        <div class="gc-stat"><div class="n">${agg.peopleCount}</div><div class="l">${t('colGroupPeople')}</div></div>
        <div class="gc-stat"><div class="n">${avgAtt}%</div><div class="l">${t('colGroupAttendance')}</div></div>
        <div class="gc-stat"><div class="n">${fmtDur(agg.totalDurationSeconds)}</div><div class="l">${t('colTotalTime')}</div></div>
      </div></div>`;
  }).join('');
  $$('#groups-list .group-card').forEach(c => c.addEventListener('click', () => openGroup(c.dataset.id)));
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
      <div class="s-txt"><div class="s-title">${t('seriesSuggestTitle')}</div><div class="s-sub">${esc(title)} · ${t('seriesSuggestBody', { n: ungrouped.length })}</div></div>
      <button class="btn sm">${t('groupThese', { n: ungrouped.length })}</button>`;
    div.querySelector('button').addEventListener('click', async () => {
      const g = await store.createGroup({ name: title });
      await store.assignMeetingsToGroup(ungrouped.map(m => m.id), g.id);
      await load(); openGroup(g.id);
    });
    box.appendChild(div);
  });
}

function openGroup(id) {
  curGroupId = id;
  const g = groupById(id); if (!g) return;
  renderGroup(g);
  switchView('group');
}

function renderGroup(g) {
  const ms = history.filter(m => m.groupId === g.id).sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
  const agg = A.aggregateGroup(ms, g.roster, lateThreshold);
  const avgAtt = agg.people.length ? Math.round(agg.people.reduce((s, p) => s + p.avgShare, 0) / agg.people.length) : 0;

  $('#group-eyebrow').innerHTML = `<span style="color:var(${GRP_COLORS[g.color] || '--grp-teal'})">●</span> ${t('navGroups').toUpperCase()}`;
  $('#group-title').textContent = g.name;
  $('#group-meta').innerHTML = `${ms.length === 1 ? t('sessionOne') : t('sessionsN', { n: ms.length })} · ${agg.peopleCount === 1 ? t('peopleOne') : t('peopleN', { n: agg.peopleCount })}`;

  setStat($('#g-sessions'), agg.sessionCount, '');
  setStat($('#g-people'), agg.peopleCount, '');
  setStat($('#g-attendance'), avgAtt, '%');
  setStat($('#g-length'), fmtDur(agg.sessionCount ? Math.round(agg.totalDurationSeconds / agg.sessionCount) : 0), '');

  renderMatrix(agg);
  renderGroupRoster(g);
}

function renderMatrix(agg) {
  if (!agg.sessions.length) { $('#group-matrix').innerHTML = `<tbody><tr><td class="mono" style="color:var(--ink-3);padding:16px">—</td></tr></tbody>`; return; }
  const head = `<thead><tr>
    <th>${t('matrixPerson') || t('colParticipant')}</th>
    ${agg.sessions.map(s => `<th class="col-session"><span class="ds">${esc(i18n.formatDate(s.date, { day: 'numeric', month: 'short' }))}</span>${esc((s.title || '').slice(0, 10))}</th>`).join('')}
    <th class="num">${t('colAttendedShare')}</th><th class="num">${t('colTotalTime')}</th>
  </tr></thead>`;
  const body = '<tbody>' + agg.people.map(p => `<tr>
    <td><div class="m-name"><span class="avatar" style="${avatarStyle(p.name)}">${esc(initials(p.name))}</span><span class="nm">${esc(p.name)}</span></div></td>
    ${agg.sessions.map(s => { const c = p.perSession[s.id]; return `<td><span class="cell-dot ${c.state}" title="${c.state} · ${c.sharePct}%"></span></td>`; }).join('')}
    <td class="num"><span class="m-att">${p.attendedCount}</span><span class="mono" style="color:var(--ink-3)">/${agg.sessionCount}</span></td>
    <td class="num m-total">${fmtDur(p.totalSeconds)}</td>
  </tr>`).join('') + '</tbody>';
  $('#group-matrix').innerHTML = head + body;
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
  await load(); switchView('groups');
});
$('#btn-group-pdf').addEventListener('click', () => { if (curGroupId) openReport('group', curGroupId); });
$('#btn-group-export').addEventListener('click', () => downloadGroupCSV(curGroupId));
$('#btn-new-group').addEventListener('click', () => openGroupModal(null));

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
  $('#people-panel').innerHTML = '';
  const map = aggregatePeople();
  let entries = Array.from(map.values());
  if (q) entries = entries.filter(p => p.name.toLowerCase().includes(q));
  entries.sort((a, b) => b.count - a.count || b.total - a.total || a.name.localeCompare(b.name));

  const table = $('#people-table'), empty = $('#people-empty');
  if (!entries.length) { table.style.display = 'none'; empty.classList.add('visible'); return; }
  table.style.display = ''; empty.classList.remove('visible');

  $('#people-body').innerHTML = entries.map(p => {
    const avg = p.shares.length ? Math.round(p.shares.reduce((s, r) => s + r, 0) / p.shares.length) : 0;
    return `<div class="row people-grid" data-name="${esc(p.name)}">
      <div class="col-name"><div class="name-cell"><span class="avatar" style="${avatarStyle(p.name)}">${esc(initials(p.name))}</span><span class="nm">${esc(p.name)}</span></div></div>
      <div class="num">${p.count}</div>
      <div class="num mono">${fmtDur(p.total)}</div>
      <div class="col-rate"><div class="share-cell"><div class="share-bar"><i style="width:${avg}%"></i></div><span class="pct">${avg}%</span></div></div>
      <div class="col-last num mono">${esc(i18n.formatDate(new Date(p.last).toISOString(), { day: 'numeric', month: 'short', year: 'numeric' }))}</div>
    </div>`;
  }).join('');
  $$('#people-body .row').forEach(r => r.addEventListener('click', () => openPerson(r.dataset.name, map)));
}
function openPerson(name, map) {
  const p = map.get(name.toLowerCase()); if (!p) return;
  const avg = p.shares.length ? Math.round(p.shares.reduce((s, r) => s + r, 0) / p.shares.length) : 0;
  const meetings = p.meetings.slice().sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  const panel = $('#people-panel');
  panel.innerHTML = `<div class="card person-card">
    <div class="person-top"><span class="avatar" style="${avatarStyle(p.name)}">${esc(initials(p.name))}</span>
      <div><h2>${esc(p.name)}</h2><div class="p-stats">
        <span>${p.count === 1 ? t('personMeetingOne') : t('personMeetingsN', { n: p.count })}</span>
        <span>${fmtDur(p.total)} ${t('personTotal')}</span><span>${avg}% ${t('personAvg')}</span></div></div></div>
    <table class="rc-table person-meetings"><thead><tr><th>${t('colMeeting')}</th><th>${t('colDate')}</th><th class="num">${t('colPresent')}</th><th>${t('colShare')}</th></tr></thead>
    <tbody>${meetings.map(mm => `<tr data-id="${esc(mm.id)}" style="cursor:pointer">
      <td class="nm">${esc(mm.title)}</td><td class="mono">${esc(i18n.formatDate(mm.date, { day: 'numeric', month: 'short', year: 'numeric' }))}</td>
      <td class="num mono">${fmtHMS(mm.secs)}</td>
      <td><div class="share-cell"><div class="share-bar"><i style="width:${mm.share}%"></i></div><span class="pct">${mm.share}%</span></div></td></tr>`).join('')}</tbody></table></div>`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $$('#people-panel tbody tr').forEach(tr => tr.addEventListener('click', () => openMeeting(tr.dataset.id)));
}
$('#people-search').addEventListener('input', e => renderPeople(e.target.value.trim()));

/* ============================ ANALYTICS ============================ */
function last7() { const days = []; const now = new Date(); for (let i = 6; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); d.setHours(0, 0, 0, 0); days.push(d); } return days; }
function meetingsOn(day) { const end = new Date(day); end.setDate(end.getDate() + 1); return history.filter(m => { const d = new Date(m.date); return d >= day && d < end; }); }

function renderAnalytics() {
  const empty = $('#analytics-empty'), charts = $('#charts');
  if (!history.length) { charts.style.display = 'none'; empty.classList.add('visible'); return; }
  charts.style.display = ''; empty.classList.remove('visible');

  const days = last7();
  const labels = days.map(d => i18n.monthShort(d) + ' ' + d.getDate());
  const ink = cssVar('--ink-2'), grid = cssVar('--line'), present = cssVar('--present'), late = cssVar('--late');

  drawBars('chart-meetings', labels, days.map(d => meetingsOn(d).length), { color: present, ink, grid });

  const dur = days.map(d => { const ms = meetingsOn(d); return ms.length ? Math.round(ms.reduce((s, m) => s + A.meetingDurationSeconds(m), 0) / ms.length / 60) : 0; });
  const pres = days.map(d => { const ms = meetingsOn(d); let tot = 0, n = 0; ms.forEach(m => Object.values(m.attendance).forEach(a => { tot += A.liveSecondsFor(a, m); n++; })); return n ? Math.round(tot / n / 60) : 0; });
  drawGrouped('chart-duration', labels, [{ data: dur, color: present, label: t('chartLegendAvgDuration') }, { data: pres, color: late, label: t('chartLegendAvgTimeInCall') }], { ink, grid });

  drawBars('chart-people', labels, days.map(d => { const ms = meetingsOn(d); return ms.length ? Math.round(ms.reduce((s, m) => s + Object.keys(m.attendance).length, 0) / ms.length) : 0; }), { color: cssVar('--grp-sky'), ink, grid });

  const counts = {}; history.forEach(m => { const k = m.meetingTitle || '—'; counts[k] = (counts[k] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const palette = ['--grp-teal', '--grp-amber', '--grp-violet', '--grp-rose', '--grp-sky', '--grp-lime'].map(cssVar);
  drawHBars('chart-top', top.map(([k]) => k.length > 18 ? k.slice(0, 18) + '…' : k), top.map(([, v]) => v), { colors: palette, ink, grid });
}

function prep(id, height) {
  const c = document.getElementById(id); if (!c) return null;
  const dpr = window.devicePixelRatio || 1; const W = c.offsetWidth || 300;
  c.width = W * dpr; c.height = height * dpr; c.style.height = height + 'px';
  const ctx = c.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, height);
  ctx.font = '11px "IBM Plex Mono", monospace';
  return { ctx, W, H: height };
}
function roundedBar(ctx, x, y, w, h, r) { if (h < r * 2) r = h / 2; if (w < r * 2) r = w / 2; if (h <= 0 || w <= 0) return; ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath(); ctx.fill(); }

function drawBars(id, labels, data, o) {
  const p = prep(id, 190); if (!p) return; const { ctx, W, H } = p;
  const pl = 32, pr = 8, pt = 12, pb = 26, cw = W - pl - pr, ch = H - pt - pb;
  const max = Math.max(...data, 1), step = Math.ceil(max / 4) || 1;
  ctx.strokeStyle = o.grid; ctx.fillStyle = o.ink; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const val = i * step; const y = pt + ch - (val / (step * 4)) * ch; ctx.beginPath(); ctx.moveTo(pl, y); ctx.lineTo(W - pr, y); ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText(val, pl - 6, y + 4); }
  const bw = Math.min(30, (cw / labels.length) * 0.6), gap = (cw - bw * labels.length) / (labels.length + 1);
  data.forEach((val, i) => { const x = pl + gap + i * (bw + gap); const bh = (val / (step * 4)) * ch; const y = pt + ch - bh; ctx.fillStyle = o.color; roundedBar(ctx, x, y, bw, bh, 4); ctx.fillStyle = o.ink; ctx.textAlign = 'center'; if (val > 0) ctx.fillText(val, x + bw / 2, y - 5); ctx.fillText(labels[i], x + bw / 2, H - 8); });
}
function drawGrouped(id, labels, series, o) {
  const p = prep(id, 190); if (!p) return; const { ctx, W, H } = p;
  const pl = 32, pr = 8, pt = 20, pb = 26, cw = W - pl - pr, ch = H - pt - pb;
  const max = Math.max(...series.flatMap(s => s.data), 1), step = Math.ceil(max / 4) || 1;
  ctx.strokeStyle = o.grid; ctx.fillStyle = o.ink; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const val = i * step; const y = pt + ch - (val / (step * 4)) * ch; ctx.beginPath(); ctx.moveTo(pl, y); ctx.lineTo(W - pr, y); ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText(val, pl - 6, y + 4); }
  const sbw = Math.min(13, (cw / labels.length) / (series.length + 1)), gw = sbw * series.length + 3, gap = (cw - gw * labels.length) / (labels.length + 1);
  labels.forEach((lb, gi) => { series.forEach((s, si) => { const val = s.data[gi]; const gx = pl + gap + gi * (gw + gap); const x = gx + si * (sbw + 2); const bh = (val / (step * 4)) * ch; ctx.fillStyle = s.color; roundedBar(ctx, x, pt + ch - bh, sbw, bh, 3); }); const gx = pl + gap + gi * (gw + gap); ctx.fillStyle = o.ink; ctx.textAlign = 'center'; ctx.fillText(lb, gx + gw / 2, H - 8); });
  series.forEach((s, i) => { const lx = pl + i * 150; ctx.fillStyle = s.color; ctx.fillRect(lx, 3, 9, 9); ctx.fillStyle = o.ink; ctx.textAlign = 'left'; ctx.fillText(s.label, lx + 13, 11); });
}
function drawHBars(id, labels, data, o) {
  const bh = 22, gap = 9, H = Math.max(150, labels.length * (bh + gap) + 16);
  const p = prep(id, H); if (!p) return; const { ctx, W } = p;
  const pl = 122, pr = 30, cw = W - pl - pr, max = Math.max(...data, 1);
  labels.forEach((lb, i) => { const y = 8 + i * (bh + gap); const bw = (data[i] / max) * cw; ctx.fillStyle = o.colors[i % o.colors.length]; roundedBar(ctx, pl, y, bw, bh, 4); ctx.fillStyle = o.ink; ctx.textAlign = 'right'; ctx.fillText(lb, pl - 8, y + bh / 2 + 4); ctx.textAlign = 'left'; ctx.fillText(data[i], pl + bw + 6, y + bh / 2 + 4); });
}
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if ($('#view-analytics').classList.contains('on')) renderAnalytics(); }, 200); });

/* ============================ EXPORT ============================ */
function downloadBlob(blob, filename) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url); }
function safe(s) { return String(s || 'export').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'export'; }
function csvRow(cells) { return cells.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(','); }

function downloadMeetingCSV(id) {
  const m = history.find(x => x.id === id); if (!m) return;
  const rows = [[t('colParticipant'), 'Email', t('colFirstSeen'), t('colLastLeft'), t('colPresent'), t('colShare'), t('colStatus')]];
  Object.entries(m.attendance).sort(([a], [b]) => a.localeCompare(b)).forEach(([name, a]) => {
    const st = A.statusFor(a, m, lateThreshold);
    rows.push([name, a.email || '', i18n.formatTime(a.firstSeen), a.present ? t('stillInCall') : i18n.formatTime(a.lastLeft), fmtHMS(st.seconds), st.sharePct + '%', st.late ? t('late') : (a.present ? t('inCall') : t('left'))]);
  });
  A.absenteesFor(m, effectiveRoster(m)).forEach(name => rows.push([name, '', '—', '—', '00:00:00', '0%', t('absent')]));
  downloadBlob(new Blob(['﻿' + rows.map(csvRow).join('\n')], { type: 'text/csv;charset=utf-8;' }), `${safe(m.meetingTitle)}-${new Date(m.date).toISOString().slice(0, 10)}.csv`);
}
function downloadGroupCSV(id) {
  const g = groupById(id); if (!g) return;
  const ms = history.filter(m => m.groupId === g.id).sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
  const agg = A.aggregateGroup(ms, g.roster, lateThreshold);
  const header = [t('colParticipant'), ...agg.sessions.map(s => `${i18n.formatDate(s.date, { day: 'numeric', month: 'short' })}`), t('colAttendedShare'), t('colTotalTime')];
  const rows = [header];
  agg.people.forEach(p => rows.push([p.name, ...agg.sessions.map(s => { const c = p.perSession[s.id]; return c.state === 'absent' ? t('absent') : c.sharePct + '%'; }), `${p.attendedCount}/${agg.sessionCount}`, fmtHMS(p.totalSeconds)]));
  downloadBlob(new Blob(['﻿' + rows.map(csvRow).join('\n')], { type: 'text/csv;charset=utf-8;' }), `${safe(g.name)}-series.csv`);
}
function copyMeeting(m) {
  let text = `${m.meetingTitle}\n${new Date(m.date).toLocaleString()}\n\n`;
  Object.entries(m.attendance).sort(([a], [b]) => a.localeCompare(b)).forEach(([name, a]) => { text += `${name} — ${i18n.formatTime(a.firstSeen)} — ${fmtHMS(A.liveSecondsFor(a, m))}\n`; });
  navigator.clipboard.writeText(text).then(() => toast(t('copiedToast')));
}
function openReport(kind, id) {
  const url = chrome.runtime.getURL('report/report.html') + `#${kind}=${encodeURIComponent(id)}`;
  chrome.tabs ? chrome.tabs.create({ url }) : window.open(url, '_blank');
}

// export-all menu
toggleMenu('#btn-export-all', '#export-all-menu');
$$('#export-all-menu .menu-item').forEach(it => it.addEventListener('click', async () => {
  $('#export-all-menu').hidden = true;
  if (it.dataset.format === 'json') { const json = await store.exportAllJSON(); downloadBlob(new Blob([json], { type: 'application/json' }), 'gm-attendance-backup.json'); }
  else downloadCombinedCSV();
}));
function downloadCombinedCSV() {
  const rows = [[t('colDate'), t('colMeeting'), t('colParticipant'), t('colFirstSeen'), t('colLastLeft'), t('colPresent'), t('colStatus')]];
  history.forEach(m => Object.entries(m.attendance).sort(([a], [b]) => a.localeCompare(b)).forEach(([name, a]) => {
    const st = A.statusFor(a, m, lateThreshold);
    rows.push([new Date(m.date).toISOString().slice(0, 10), m.meetingTitle, name, i18n.formatTime(a.firstSeen), a.present ? t('stillInCall') : i18n.formatTime(a.lastLeft), fmtHMS(st.seconds), st.late ? t('late') : (a.present ? t('inCall') : t('left'))]);
  }));
  downloadBlob(new Blob(['﻿' + rows.map(csvRow).join('\n')], { type: 'text/csv;charset=utf-8;' }), `gm-attendance-all-${new Date().toISOString().slice(0, 10)}.csv`);
}

/* ============================ MODALS ============================ */
function toggleMenu(btnSel, menuSel) {
  const btn = $(btnSel), menu = $(menuSel);
  btn.addEventListener('click', e => { e.stopPropagation(); const wasHidden = menu.hidden; $$('.menu').forEach(m => m.hidden = true); menu.hidden = !wasHidden; });
}
document.addEventListener('click', () => $$('.menu').forEach(m => m.hidden = true));

let groupModalColor = 'teal';
function openGroupModal(assignId) {
  assignContextId = assignId;
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
  if (assignContextId) await store.assignMeetingToGroup(assignContextId, g.id);
  $('#group-modal').hidden = true;
  const openMeetingAfter = assignContextId;
  assignContextId = null;
  await load();
  toast(t('groupCreatedToast'));
  if (openMeetingAfter) openMeeting(openMeetingAfter); else openGroup(g.id);
});

function openAssignModal(m) {
  if (!m) return;
  const list = $('#assign-list');
  list.innerHTML = groups.map(g => `<div class="assign-item ${m.groupId === g.id ? 'current' : ''}" data-id="${esc(g.id)}"><span class="gdot" style="background:var(${GRP_COLORS[g.color] || '--grp-teal'})"></span>${esc(g.name)}</div>`).join('')
    + (m.groupId ? `<div class="assign-item" data-id="__none"><span class="gdot" style="background:var(--absent)"></span>${t('removeFromGroup')}</div>` : '');
  if (!groups.length) list.innerHTML = `<p class="hint">${t('emptyGroupsBody')}</p>`;
  $$('#assign-list .assign-item').forEach(it => it.addEventListener('click', async () => {
    const gid = it.dataset.id === '__none' ? null : it.dataset.id;
    await store.assignMeetingToGroup(m.id, gid);
    $('#assign-modal').hidden = true;
    await load(); openMeeting(m.id); toast(t('assignedToast'));
  }));
  $('#assign-modal').hidden = false;
}
$('#assign-cancel').addEventListener('click', () => $('#assign-modal').hidden = true);
$('#assign-new').addEventListener('click', () => { $('#assign-modal').hidden = true; openGroupModal(assignContextId); });
$$('.modal').forEach(mod => mod.addEventListener('click', e => { if (e.target === mod) mod.hidden = true; }));

/* ============================ SETTINGS ============================ */
function syncSettingsUI() {
  $('#set-auto-track').checked = settings.autoTrack !== false; // read below from local
  $('#set-late').value = lateThreshold;
  $('#set-max').value = String(settings.maxStoredMeetings ?? 200);
  $('#set-language').value = i18n.getLanguagePreference();
  applyTheme(settings.theme || 'system');
  renderRosterChips();
}
// auto-track lives in its own local key
chrome.storage.local.get(['autoTrack'], r => { $('#set-auto-track').checked = r.autoTrack !== false; });
$('#set-auto-track').addEventListener('change', () => chrome.storage.local.set({ autoTrack: $('#set-auto-track').checked }));

$('#set-late').addEventListener('change', async () => {
  lateThreshold = Math.max(0, parseInt($('#set-late').value, 10) || 0);
  settings = await store.updateSettings({ lateThresholdMinutes: lateThreshold });
  const m = currentMeeting(); if (m && $('#view-detail').classList.contains('on')) renderDetail(m);
  toast(t('savedToast'));
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
  toast(names.length === 1 ? t('addedNamesOne') : t('addedNamesMany', { n: names.length }));
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal').forEach(m => m.hidden = true); });

// import
$('#btn-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      const meetings = Array.isArray(data) ? data : (Array.isArray(data.meetings) ? data.meetings : null);
      if (!meetings) { toast(t('importInvalid')); return; }
      const byId = new Map(history.map(m => [m.id, m]));
      let added = 0;
      meetings.forEach(rec => { if (rec && rec.id && !byId.has(rec.id)) { byId.set(rec.id, rec); added++; } });
      if (data.groups && Array.isArray(data.groups)) { const gids = new Set(groups.map(g => g.id)); data.groups.forEach(g => { if (g && g.id && !gids.has(g.id)) groups.push(g); }); await store.saveGroups(groups); }
      const merged = Array.from(byId.values()).map(A.normalizeMeeting).sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
      await store.saveHistory(merged);
      await load();
      toast(t('importedToast', { n: added }));
    } catch { toast(t('importInvalid')); }
  };
  reader.readAsText(file); e.target.value = '';
});

$('#btn-clear-all').addEventListener('click', async () => {
  if (!confirm(t('confirmClearAll'))) return;
  await store.clearHistory(); await load(); switchView('meetings');
});

/* ---- Sheets ---- */
async function refreshSheets() {
  let connected = false;
  try { connected = await sheets.isAuthenticated(); } catch { connected = false; }
  $('#sheets-connect').hidden = connected;
  $('#sheets-disconnect').hidden = !connected;
  $('#sheets-config').hidden = !connected;
  $('#sheets-status').textContent = connected ? t('sheetsConnected') : t('sheetsNotConnected');
  $('#sheets-status').className = 'status ' + (connected ? 'status--present' : 'status--info');
  if (settings.spreadsheetId) {
    $('#spreadsheet-id').value = settings.spreadsheetId;
    $('#sheets-open').href = 'https://docs.google.com/spreadsheets/d/' + settings.spreadsheetId + '/edit';
    $('#sheets-open').hidden = false; $('#autosync-row').hidden = false;
  } else { $('#sheets-open').hidden = true; }
  $('#set-autosync').checked = !!settings.autoSync;
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
  settings = await store.updateSettings({ spreadsheetId: null, autoSync: false });
  toast(t('sheetsDisconnectedToast')); refreshSheets();
});
$('#sheets-create').addEventListener('click', async () => {
  $('#sheets-create').disabled = true;
  try { const ss = await sheets.createSpreadsheet(); settings = await store.updateSettings({ spreadsheetId: ss.spreadsheetId }); toast(t('sheetsCreatedToast')); window.open('https://docs.google.com/spreadsheets/d/' + ss.spreadsheetId + '/edit', '_blank'); }
  catch (e) { console.error('[GM Attendance] create spreadsheet failed:', (e && e.message) || e); toast(t('sheetsCreateFailed')); }
  $('#sheets-create').disabled = false; refreshSheets();
});
$('#sheets-save').addEventListener('click', async () => {
  const id = $('#spreadsheet-id').value.trim(); if (!id) { toast(t('sheetsIdRequired')); return; }
  $('#sheets-save').disabled = true;
  try { await sheets.getSpreadsheet(id); settings = await store.updateSettings({ spreadsheetId: id }); toast(t('sheetsSavedToast')); }
  catch (e) { console.error('[GM Attendance] open spreadsheet failed:', (e && e.message) || e); toast(t('sheetsSaveFailed')); }
  $('#sheets-save').disabled = false; refreshSheets();
});
$('#set-autosync').addEventListener('change', async () => { settings = await store.updateSettings({ autoSync: $('#set-autosync').checked }); toast(t('savedToast')); });

/* ============================ deep link + locale ============================ */
function handleDeepLink() {
  const hash = (location.hash || '').slice(1); if (!hash) return;
  const params = new URLSearchParams(hash);
  if (params.get('meeting')) { const id = params.get('meeting'); if (history.some(m => m.id === id)) openMeeting(id); }
  else if (params.get('group')) { const id = params.get('group'); if (groupById(id)) openGroup(id); }
}
window.addEventListener('hashchange', handleDeepLink);

i18n.onLocaleChange(() => {
  i18n.applyI18n(document);
  renderReadout();
  renderMeetings($('#meeting-search').value.trim());
  const active = $('.view.on');
  if (active) {
    if (active.id === 'view-detail' && currentMeeting()) renderDetail(currentMeeting());
    else if (active.id === 'view-group' && groupById(curGroupId)) renderGroup(groupById(curGroupId));
    else if (active.id === 'view-groups') renderGroups();
    else if (active.id === 'view-people') renderPeople($('#people-search').value.trim());
    else if (active.id === 'view-analytics') renderAnalytics();
  }
});

/* ============================ boot ============================ */
(async function boot() {
  await i18n.initI18n();
  await load();
  refreshSheets();
})();
