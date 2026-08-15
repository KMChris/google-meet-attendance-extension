// Attendance Tracker — popup: live tracking status + recent meetings.
import * as store from '../lib/storage.js';
import * as A from '../lib/attendance.js';
import * as i18n from '../lib/i18n.js';

const { t } = i18n;
const $ = s => document.querySelector(s);
// Quotes included, as on the dashboard: a meeting's id and its title both land inside an HTML
// attribute below, and a record that came in from a file is free to carry one.
const esc = s => {
  const d = document.createElement('div'); d.textContent = s == null ? '' : s;
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};

// the stored theme lands after the first paint, so the same transition guard the dashboard needs
// applies here: without it every .btn keeps the background of the theme being left
function applyTheme(theme) {
  const r = document.documentElement;
  r.classList.add('theme-swap');
  if (theme === 'light' || theme === 'dark') r.setAttribute('data-theme', theme); else r.removeAttribute('data-theme');
  void r.offsetWidth;
  requestAnimationFrame(() => r.classList.remove('theme-swap'));
}
function openDashboard(hash) {
  const url = chrome.runtime.getURL('dashboard/dashboard.html') + (hash || '');
  if (hash) chrome.tabs.create({ url }); else if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage(); else chrome.tabs.create({ url });
  window.close();
}

function tabStatus() {
  return new Promise(resolve => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const tab = tabs && tabs[0];
        if (!tab || !/meet\.google\.com/.test(tab.url || '')) return resolve({ onMeet: false });
        chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, res => {
          if (chrome.runtime.lastError || !res) return resolve({ onMeet: true, tracking: false });
          resolve({ onMeet: true, tracking: !!res.isTracking, count: res.participantCount || 0 });
        });
      });
    } catch { resolve({ onMeet: false }); }
  });
}

function renderLive(st) {
  const card = $('#live-card'), pill = $('#pop-status');
  if (st.onMeet && st.tracking) {
    card.className = 'live-card tracking';
    $('#live-count').textContent = st.count;
    $('#live-label').textContent = t('popupInThisCall');
    pill.className = 'status status--present'; pill.textContent = t('popupStatusTracking');
  } else {
    card.className = 'live-card idle';
    $('#live-count').textContent = st.onMeet ? t('popupIdle') : t('popupNoMeeting');
    $('#live-label').textContent = '';
    pill.className = 'status status--info'; pill.textContent = st.onMeet ? t('popupStatusIdle') : t('popupStatusNoMeeting');
  }
}

function renderRecent(history) {
  const list = $('#recent-list'), empty = $('#recent-empty');
  if (!history.length) { empty.hidden = false; return; }
  empty.hidden = true;
  list.innerHTML = history.slice(0, 4).map(m => {
    const startIso = A.meetingStartIso(m);
    const d = new Date(startIso);
    const n = Object.keys(m.attendance).length;
    // the same two states the dashboard marks, in the room a popup row has for them: a dot that
    // rings while the call does, amber and still where nothing ever ended the record. It sits
    // beside the title rather than inside it, which is where the ellipsis would have eaten it.
    const state = A.meetingState(m);
    const tag = state === 'ended' ? '' :
      `<span class="live-tag${state === 'unfinished' ? ' warn' : ''}" title="${esc(t(state === 'live' ? 'liveNow' : 'unfinished'))}"><span class="pip"></span></span>`;
    return `<div class="rec-item" data-id="${esc(m.id)}">
      <div class="rec-date"><span class="d">${d.getDate()}</span><span class="m">${esc(i18n.monthShort(d))}</span></div>
      <div class="rec-body"><div class="rec-head"><div class="rec-title">${esc(m.meetingTitle)}</div>${tag}</div><div class="rec-sub">${i18n.formatTime(startIso)}</div></div>
      <div class="rec-count">${n}</div></div>`;
  }).join('');
  list.querySelectorAll('.rec-item').forEach(it => it.addEventListener('click', () => openDashboard('#meeting=' + encodeURIComponent(it.dataset.id))));
}

(async function () {
  await i18n.initI18n();
  const [settings, history] = await Promise.all([store.getSettings(), store.getHistory()]);
  applyTheme(settings.theme || 'system');
  // the archive is meant to be out of the way, here too
  renderRecent(history.filter(m => !m.archived).map(A.normalizeMeeting));
  renderLive(await tabStatus());

  $('#open-dash').addEventListener('click', () => openDashboard());
  $('#view-all').addEventListener('click', () => openDashboard());
})();
