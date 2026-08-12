// Technical attendance report — single meeting (#meeting=<id>) or a whole series (#group=<id>).
import * as store from '../src/lib/storage.js';
import * as A from '../src/lib/attendance.js';
import * as i18n from '../src/lib/i18n.js';

const { t } = i18n;
const esc = s => { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; };
const initials = name => { const p = String(name || '').trim().split(/\s+/); return ((p.length >= 2 ? p[0][0] + p[p.length - 1][0] : (name || '').slice(0, 2)) || '?').toUpperCase(); };
function fmtDur(secs) { secs = Math.floor(secs || 0); if (secs <= 0) return '0m'; const h = Math.floor(secs / 3600), m = Math.floor(secs % 3600 / 60), s = secs % 60; if (h) return `${h}h ${String(m).padStart(2, '0')}m`; if (m) return `${m}m`; return `${s}s`; }
function fmtHMS(secs) { secs = Math.floor(secs || 0); const h = Math.floor(secs / 3600), m = Math.floor(secs % 3600 / 60), s = secs % 60; return [h, m, s].map(v => String(v).padStart(2, '0')).join(':'); }
const time = iso => i18n.formatTime(iso);

function statusChip(a, m, threshold) {
  const st = A.statusFor(a, m, threshold);
  if (st.late) return `<span class="rep-status late">${t('lateBy', { n: st.lateMinutes })}</span>`;
  if (a.present) return `<span class="rep-status present">${t('inCall')}</span>`;
  return `<span class="rep-status left">${t('left')}</span>`;
}

function attendanceTable(m, roster, threshold) {
  const rows = Object.entries(m.attendance).sort(([a], [b]) => a.localeCompare(b)).map(([name, a]) => {
    const st = A.statusFor(a, m, threshold);
    return `<tr><td><b>${esc(name)}</b>${a.email ? ` <span class="mono" style="color:var(--ink-3)">${esc(a.email)}</span>` : ''}</td>
      <td class="mono">${time(a.firstSeen)}</td><td class="mono">${a.present ? esc(t('stillInCall')) : time(a.lastLeft)}</td>
      <td class="num mono">${fmtHMS(st.seconds)}</td><td class="num mono">${st.sharePct}%</td><td>${statusChip(a, m, threshold)}</td></tr>`;
  }).join('');
  const absentRows = A.absenteesFor(m, roster).sort((a, b) => a.localeCompare(b)).map(name =>
    `<tr><td><b>${esc(name)}</b></td><td class="mono">—</td><td class="mono">—</td><td class="num mono">00:00:00</td><td class="num mono">0%</td><td><span class="rep-status absent">${t('absent')}</span></td></tr>`).join('');
  return `<table class="rep-table"><thead><tr><th>${t('colParticipant')}</th><th>${t('colFirstSeen')}</th><th>${t('colLastLeft')}</th><th class="num">${t('colPresent')}</th><th class="num">${t('colShare')}</th><th>${t('colStatus')}</th></tr></thead><tbody>${rows}${absentRows}</tbody></table>`;
}

function eventLog(m) {
  const endMs = A.meetingEndMs(m);
  return `<div class="evlog">` + Object.entries(m.attendance).sort(([a], [b]) => a.localeCompare(b)).map(([name, a]) => {
    const lines = (a.sessions || []).map(s => {
      const joinMs = Date.parse(s.joinedAt);
      const open = !s.leftAt;
      const endS = open ? endMs : Date.parse(s.leftAt);
      const dur = Math.max(0, Math.floor((endS - joinMs) / 1000));
      const out = open
        ? `<span class="io"><span class="ev-tag open"></span>${esc(t('stillInCall'))}</span>`
        : `<span class="io"><span class="ev-tag out"></span>${t('evLeft')} <span class="t">${time(s.leftAt)}</span></span>`;
      return `<div class="ev-line"><span class="io"><span class="ev-tag in"></span>${t('evJoined')} <span class="t">${time(s.joinedAt)}</span></span><span class="arrow">→</span>${out}<span class="dur">· ${fmtDur(dur)} ${t('evSession')}</span></div>`;
    }).join('');
    return `<div class="ev-person"><div class="ev-head"><span class="avatar">${esc(initials(name))}</span><span class="nm">${esc(name)}</span></div><div class="ev-sessions">${lines}</div></div>`;
  }).join('') + `</div>`;
}

function summaryStats(m, roster, threshold) {
  const people = Object.entries(m.attendance);
  const avg = people.length ? Math.round(people.reduce((s, [, a]) => s + A.liveSecondsFor(a, m), 0) / people.length) : 0;
  const late = people.filter(([, a]) => A.isLate(a, m, threshold)).length;
  const absent = A.absenteesFor(m, roster).length;
  return statGrid([
    [people.length, t('reportPeople')], [fmtDur(avg), t('reportAvg')],
    [late, t('reportLate')], [absent, t('reportAbsentees')], [fmtDur(A.meetingDurationSeconds(m)), t('statLength')]
  ]);
}
function statGrid(items) {
  return `<div class="rep-stats">` + items.map(([k, l]) => `<div class="rep-stat"><div class="k">${esc(String(k))}</div><div class="l">${esc(l)}</div></div>`).join('') + `</div>`;
}

function reconciliation(m, roster) {
  const absent = A.absenteesFor(m, roster);
  const expected = roster && roster.length ? roster : Object.keys(m.attendance);
  return `<div class="recon">
    <div class="col"><h3>${t('rosterExpected')} · ${expected.length}</h3><div class="names">${expected.map(n => `<span class="name-chip">${esc(n)}</span>`).join('')}</div></div>
    <div class="col"><h3>${t('rosterAbsent')} · ${absent.length}</h3><div class="names">${absent.length ? absent.map(n => `<span class="name-chip absent">${esc(n)}</span>`).join('') : '<span class="mono" style="color:var(--ink-3)">—</span>'}</div></div>
  </div>`;
}

function footer() {
  const gen = new Date().toLocaleString(i18n.localeTag());
  return `<div class="rep-footer"><span>${t('reportGenerated', { date: gen })}</span><span>${t('reportBy')}</span></div>`;
}

/* ---------------- single meeting ---------------- */
function renderMeeting(m, roster, threshold) {
  const doc = `<div class="doc">
    <div class="rep-eyebrow">GM · ${t('reportSubtitle')}</div>
    <h1>${esc(m.meetingTitle)}</h1>
    <div class="rep-meta">
      <span>${esc(i18n.formatDate(A.meetingStartIso(m), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }))}</span>
      <span><b>${time(A.meetingStartIso(m))}</b> – <b>${time(A.meetingEndIso(m))}</b></span>
      ${m.meetingCode ? `<span>${esc(m.meetingCode)}</span>` : ''}
    </div>
    ${summaryStats(m, roster, threshold)}
    <div class="rep-sect"><h2>${t('attendanceTitle')}</h2>${attendanceTable(m, roster, threshold)}</div>
    <div class="rep-sect"><h2>${t('eventLogTitle')}</h2><p class="rep-hint">${t('eventLogHint')}</p>${eventLog(m)}</div>
    <div class="rep-sect"><h2>${t('rosterReconTitle')}</h2>${reconciliation(m, roster)}</div>
  </div>${footer()}`;
  document.getElementById('report').innerHTML = doc;
  document.title = `${m.meetingTitle} — Attendance Tracker`;
}

/* ---------------- group series ---------------- */
function renderGroup(group, meetings, threshold) {
  const ms = meetings.slice().sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
  const agg = A.aggregateGroup(ms, group.roster, threshold);
  const avgAtt = agg.people.length ? Math.round(agg.people.reduce((s, p) => s + p.avgShare, 0) / agg.people.length) : 0;
  const first = ms[0], last = ms[ms.length - 1];

  const matrix = `<table class="rep-matrix"><thead><tr><th>${t('colParticipant')}</th>
    ${agg.sessions.map(s => `<th>${esc(i18n.formatDate(s.date, { day: 'numeric', month: 'short' }))}</th>`).join('')}
    <th>${t('colAttendedShare')}</th><th>${t('colTotalTime')}</th></tr></thead><tbody>
    ${agg.people.map(p => `<tr><td style="text-align:left"><b>${esc(p.name)}</b></td>
      ${agg.sessions.map(s => `<td><span class="dot ${p.perSession[s.id].state}"></span></td>`).join('')}
      <td class="mono">${p.attendedCount}/${agg.sessionCount}</td><td class="mono">${fmtHMS(p.totalSeconds)}</td></tr>`).join('')}
    </tbody></table>`;

  const sessionBlocks = ms.map(m => {
    const people = Object.keys(m.attendance).length;
    const late = Object.values(m.attendance).filter(a => A.isLate(a, m, threshold)).length;
    const absent = A.absenteesFor(m, group.roster).length;
    return `<div class="sess-block">
      <div class="sb-head"><div class="sb-title">${esc(m.meetingTitle)}</div>
        <div class="sb-meta">${esc(i18n.formatDate(m.date, { weekday: 'short', day: 'numeric', month: 'short' }))} · ${time(m.date)} · ${people} ${t('reportPeople').toLowerCase()} · ${late} ${t('late').toLowerCase()} · ${absent} ${t('absent').toLowerCase()}</div></div>
      ${attendanceTable(m, group.roster, threshold)}
      <div class="rep-sect"><h2>${t('eventLogTitle')}</h2>${eventLog(m)}</div>
    </div>`;
  }).join('');

  const range = first && last
    ? esc(i18n.formatDate(first.date, { day: 'numeric', month: 'short' })) + ' – ' + esc(i18n.formatDate(last.date, { day: 'numeric', month: 'short', year: 'numeric' }))
    : '';

  document.getElementById('report').innerHTML = `<div class="doc">
    <div class="rep-eyebrow">GM · ${t('groupReportSubtitle')}</div>
    <h1>${esc(group.name)}</h1>
    <div class="rep-meta"><span><b>${agg.sessionCount}</b> ${t('colSessions').toLowerCase()}</span><span>${range}</span><span><b>${agg.peopleCount}</b> ${t('colGroupPeople').toLowerCase()}</span></div>
    ${statGrid([[agg.sessionCount, t('colSessions')], [agg.peopleCount, t('reportPeople')], [avgAtt + '%', t('statAvgAttendance')], [fmtDur(agg.sessionCount ? Math.round(agg.totalDurationSeconds / agg.sessionCount) : 0), t('statAvgLength')], [fmtDur(agg.totalDurationSeconds), t('colTotalTime')]])}
    <div class="rep-sect"><h2>${t('matrixTitle')}</h2><p class="rep-hint">${t('perSessionHint')}</p>${matrix}</div>
    <div class="rep-sect"><h2>${t('sessionsBreakdown')}</h2>${sessionBlocks}</div>
  </div>${footer()}`;
  document.title = `${group.name} — Attendance Tracker`;
}

function notFound() {
  document.getElementById('report').innerHTML = `<div class="doc rep-notfound"><h1>${t('reportNotFound')}</h1><p>${t('reportNotFoundBody')}</p></div>`;
}

/* ---------------- boot ---------------- */
(async function () {
  await i18n.initI18n();
  document.getElementById('btn-print').addEventListener('click', () => window.print());

  const params = new URLSearchParams((location.hash || '').slice(1));
  const meetingId = params.get('meeting');
  const groupId = params.get('group');
  const settings = await store.getSettings();
  const threshold = Number(settings.lateThresholdMinutes) || 5;

  let ok = false;
  if (meetingId) {
    const raw = await store.getMeetingById(meetingId);
    if (raw) {
      const m = A.normalizeMeeting(raw);
      const groups = await store.getGroups();
      const g = m.groupId ? groups.find(x => x.id === m.groupId) : null;
      const roster = (g && g.roster && g.roster.length) ? g.roster : await store.getRoster();
      renderMeeting(m, roster, threshold); ok = true;
    }
  } else if (groupId) {
    const g = await store.getGroupById(groupId);
    if (g) {
      const meetings = (await store.getHistory()).map(A.normalizeMeeting).filter(m => m.groupId === g.id);
      renderGroup(g, meetings, threshold); ok = true;
    }
  }
  if (!ok) notFound();

  if (ok && !params.has('noprint')) {
    try { await document.fonts.ready; } catch {}
    setTimeout(() => window.print(), 250);
  }
})();
