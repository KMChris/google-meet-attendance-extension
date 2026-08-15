/**
 * Background service worker.
 *
 * Narrow responsibility: ingest attendance events from the content script into the
 * canonical history, keep the toolbar badge live, run migration on install, and
 * auto-sync a finished meeting to Google Sheets. All read/CRUD for the UI happens
 * in the pages themselves (they import storage.js directly).
 *
 * Session identity fix: a recurring Meet link reuses the same code, so we resolve a
 * per-session record id — resuming a recent session on refresh/rejoin, but starting a
 * fresh record for a later day — instead of letting the code overwrite prior sessions.
 * A resumed session keeps what it already recorded: see attendance.mergeRawParticipants.
 *
 * Nothing in here is allowed to be the only copy of anything. This worker is stopped and started
 * at Chrome's discretion, and reset outright by a reload, an update or a switch-off, so what it
 * holds in memory is a cache of the record on disk and never the record itself. Whenever it wakes
 * it puts the world back in order: meetings nobody got to end are ended, and Meet tabs left
 * without a tracker get one, which is what carries a call in progress across all of the above.
 */

import * as storage from '../lib/storage.js';
import * as attendance from '../lib/attendance.js';
import * as sheetsSync from '../lib/sheets-sync.js';

const BADGE_COLOR = '#1e7a4e'; // present-green, matches the status palette
const CONTENT_SCRIPT = 'src/content/content-script.js';
const MEET_URL = 'https://meet.google.com/*';

/** tabId -> raw meeting { id, meetingCode, startTime, url, meetingTitle, groupId?, participants } */
const activeMeetings = new Map();
/** tabId -> the resolve in flight, so two messages from one page load can't open two records. */
const resolving = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(error => {
      console.error('[GM Attendance] message error:', error);
      sendResponse({ error: error.message });
    });
  return true; // async
});

async function handleMessage(message, sender) {
  const tabId = sender.tab?.id;
  switch (message.type) {
    case 'MEETING_STARTED':   return handleMeetingStarted(message, tabId);
    case 'ATTENDANCE_UPDATE': return handleAttendanceUpdate(message, tabId);
    case 'MEETING_SCHEDULE':  return handleMeetingSchedule(message, tabId);
    case 'MEETING_HEARTBEAT': return handleHeartbeat(message, tabId);
    case 'MEETING_ENDED':     return handleMeetingEnded(message, tabId);
    default:                  return { error: 'Unknown message type' };
  }
}

/**
 * Resolve the raw meeting for a tab, resuming a stored session or starting a new one.
 *
 * A page load reports its first participants and its start at the same moment, and reading the
 * store to decide which session they belong to takes long enough for both to arrive first. They
 * share the answer rather than each opening a record of their own, which they would stamp a
 * millisecond apart and so give two ids to one call.
 */
function resolveRawMeeting(message, tabId) {
  if (tabId != null && activeMeetings.has(tabId)) return Promise.resolve(activeMeetings.get(tabId));
  if (tabId != null && resolving.has(tabId)) return resolving.get(tabId);

  const pending = openRawMeeting(message, tabId);
  if (tabId == null) return pending;
  resolving.set(tabId, pending);
  return pending.finally(() => resolving.delete(tabId));
}

async function openRawMeeting(message, tabId) {
  const code = message.meetingId || null;
  const resumable = await storage.findResumableSession(code);

  let raw;
  if (resumable) {
    raw = {
      id: resumable.id,
      meetingCode: code,
      startTime: resumable.date,
      url: message.url || resumable.url || '',
      meetingTitle: resumable.meetingTitle || message.meetingTitle || code,
      groupId: resumable.groupId,
      participants: attendance.rawParticipantsFromMeeting(resumable)
    };
  } else {
    const startIso = message.startTime || new Date().toISOString();
    raw = {
      id: attendance.makeSessionId(code, Date.parse(startIso) || Date.now()),
      meetingCode: code,
      startTime: startIso,
      url: message.url || '',
      meetingTitle: message.meetingTitle || code,
      participants: {}
    };
  }
  if (tabId != null) activeMeetings.set(tabId, raw);
  return raw;
}

/**
 * The record as it stands, stamped with the moment the page last reported. The stamp is what a
 * recovery ends an abandoned meeting at — see storage.endInterruptedMeetings.
 */
function liveRecord(raw) {
  return { ...attendance.buildMeetingRecord(raw), liveAt: new Date().toISOString() };
}

async function handleMeetingStarted(message, tabId) {
  const raw = await resolveRawMeeting(message, tabId);
  // Persist the (possibly empty) record so it appears immediately; don't clobber a resume.
  const existing = await storage.getMeetingById(raw.id);
  if (!existing) await storage.upsertMeeting(liveRecord(raw));

  updateBadge(tabId, 'ON', BADGE_COLOR);
  return { success: true, id: raw.id };
}

/**
 * The page saying it is still on the call. Nothing else does: a call where nobody comes or goes
 * records no events for an hour, and a meeting the browser was closed on can only be ended where
 * it was last known to be running.
 */
async function handleHeartbeat(message, tabId) {
  const raw = await resolveRawMeeting(message, tabId);
  await storage.touchMeetingLive(raw.id, message.at || new Date().toISOString());
  return { success: true, id: raw.id };
}

/**
 * Scheduled hours scraped from the calendar event Meet shows. Only fills blanks, so a
 * hand-set value is never overwritten; the record is created first if the schedule
 * arrives before MEETING_STARTED landed.
 */
async function handleMeetingSchedule(message, tabId) {
  const raw = await resolveRawMeeting(message, tabId);
  const existing = await storage.getMeetingById(raw.id);
  if (!existing) await storage.upsertMeeting(liveRecord(raw));

  const applied = await storage.applyDetectedSchedule(raw.id, {
    start: message.scheduledStart || null,
    end: message.scheduledEnd || null
  });
  if (applied) console.log('[GM Attendance] scheduled hours detected:', message.scheduledStart, '→', message.scheduledEnd);
  return { success: true, id: raw.id, applied: !!applied };
}

async function handleAttendanceUpdate(message, tabId) {
  const raw = await resolveRawMeeting(message, tabId);
  // The page reports what *this* load of the content script has seen, which starts over on
  // every reload — fold it into what the tab reported before rather than replacing it.
  raw.participants = attendance.mergeRawParticipants(raw.participants, message.participants);
  if (tabId != null) activeMeetings.set(tabId, raw);

  // upsertMeeting re-applies any user renames/merges (nameMap) — count the mapped result.
  const saved = await storage.upsertMeeting(liveRecord(raw));

  updateBadge(tabId, String(Object.keys(saved.attendance).length), BADGE_COLOR);
  return { success: true, id: raw.id };
}

async function handleMeetingEnded(message, tabId) {
  const raw = await resolveRawMeeting(message, tabId);
  if (message.participants) raw.participants = attendance.mergeRawParticipants(raw.participants, message.participants);

  const record = attendance.buildMeetingRecord(raw);
  record.endedAt = message.endTime || new Date().toISOString();
  const saved = await storage.upsertMeeting(record);

  if (tabId != null) activeMeetings.delete(tabId);
  updateBadge(tabId, '', '');

  // The call is over: the moment to hand the sheet this meeting, and to take from it whatever
  // was recorded elsewhere in the meantime.
  await syncWithSheet({ force: true });
  return { success: true, id: saved.id };
}

function updateBadge(tabId, text, color) {
  const opts = { text };
  if (tabId != null) opts.tabId = tabId;
  chrome.action.setBadgeText(opts);
  if (color) {
    chrome.action.setBadgeBackgroundColor({ color, ...(tabId != null ? { tabId } : {}) });
  }
}

/**
 * Tab closed mid-meeting — close out any still-present sessions and finalize.
 *
 * The tab is only known here while this worker has been up as long as the call. When it hasn't,
 * nothing in memory says what the tab held, so the meeting is found the other way round: by the
 * Meet link that is no longer open anywhere.
 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const raw = activeMeetings.get(tabId);
  if (!raw) {
    await serial(() => reconcileOpenMeetings({ ignoreTabId: tabId }));
    return;
  }

  const endTime = new Date().toISOString();
  raw.participants = attendance.closeOpenParticipants(raw.participants, endTime);

  const record = attendance.buildMeetingRecord(raw);
  record.endedAt = endTime;
  await storage.upsertMeeting(record);
  activeMeetings.delete(tabId);
});

/** Install / update: migrate to the current schema, default autoTrack on. */
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const { migrated } = await storage.migrateIfNeeded();
    if (migrated) console.log('[GM Attendance] migrated legacy meetings:', migrated);
  } catch (err) {
    console.warn('[GM Attendance] migration failed:', err);
  }
  chrome.storage.local.get(['autoTrack'], (res) => {
    if (res.autoTrack === undefined) chrome.storage.local.set({ autoTrack: true });
  });
});

/* ============================ picking the pieces back up ============================ */

/**
 * The Meet tabs open right now. Reading their URLs is what the host permission for
 * meet.google.com buys; without it the query throws, and then we know nothing rather than
 * wrongly knowing there is nothing — hence null instead of an empty list.
 */
async function meetTabs() {
  try {
    return await chrome.tabs.query({ url: MEET_URL });
  } catch (err) {
    console.warn('[GM Attendance] could not read the Meet tabs:', err);
    return null;
  }
}

/** The meeting code a tab sits on, read from its URL the way the content script reads it. */
function meetCodeOf(url) {
  const m = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#]|$)/.exec(url || '');
  return m ? m[1] : null;
}

/**
 * Put a tracker in every Meet tab that hasn't got one.
 *
 * Installing, updating, re-enabling or reloading the extension cuts the script already in the page
 * off from here — it keeps running, but nothing it says arrives — and Chrome injects into tabs
 * that load afterwards, not into the ones already open. Without this, a call in progress is picked
 * up again only if the user thinks to reload the tab. It is also what starts a call that was
 * already running when the extension arrived, which has no record of ever having begun.
 *
 * A tab that answers is left alone: replacing a working tracker would open the participant panel
 * in the user's face for nothing.
 */
async function ensureTrackers() {
  const tabs = await meetTabs();
  if (!tabs) return;

  await Promise.all(tabs.map(async (tab) => {
    if (tab.id == null || tab.status !== 'complete') return; // still loading: it gets one on its own
    const answered = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }).catch(() => null);
    if (answered) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [CONTENT_SCRIPT] });
      console.log('[GM Attendance] tracker put back in tab', tab.id);
    } catch (err) {
      console.warn('[GM Attendance] could not put the tracker back:', err);
    }
  }));
}

/**
 * End the meetings nothing got to end.
 *
 * A record with no end means the page stopped reporting without saying so. A call whose link is
 * still open in a tab is left alone — it may well still be running, and the tracker about to be
 * put back there will resume it. At browser start there is nothing to spare: whatever a restored
 * tab shows, no call survived the browser going away.
 */
async function reconcileOpenMeetings({ browserStart = false, ignoreTabId = null } = {}) {
  const open = (await storage.getHistory()).filter(m => !m.endedAt);
  if (!open.length) return;

  // A call being reported into right now is live by definition, whatever the browser did before.
  const reporting = new Set([...activeMeetings.values()].map(raw => raw.id));
  let stranded = open.filter(m => !reporting.has(m.id));

  if (!browserStart) {
    const tabs = await meetTabs();
    if (!tabs) return; // can't tell a live call from an abandoned one, so touch neither
    const live = new Set(tabs.filter(t => t.id !== ignoreTabId).map(t => meetCodeOf(t.url)).filter(Boolean));
    stranded = stranded.filter(m => !live.has(m.meetingCode));
  }

  const closed = await storage.endInterruptedMeetings(stranded.map(m => m.id));
  if (closed.length) console.log('[GM Attendance] ended interrupted meetings:', closed.length);
}

/** Two-way sync, whenever this worker is a good place to run one. Failures are never fatal. */
async function syncWithSheet(opts) {
  try {
    const moved = await sheetsSync.autoSync(opts);
    if (moved) console.log('[GM Attendance] synced with Sheets:', moved);
  } catch (err) {
    console.warn('[GM Attendance] auto-sync failed:', err);
  }
}

/** One pass at a time: these all rewrite the history, and two at once would lose one of them. */
let queued = Promise.resolve();
function serial(task) {
  queued = queued.then(task).catch(err => console.warn('[GM Attendance] background pass failed:', err));
  return queued;
}

/**
 * Housekeeping whenever the worker wakes: end what nothing got to end, give every Meet tab a
 * tracker back, drop what has waited out its stay in the trash, and take from the sheet anything
 * recorded on another machine. The dashboard does the last two on load as well; between the two,
 * neither needs an alarm of its own.
 *
 * Ending comes before injecting, so a tracker put back into a tab resumes a record this pass has
 * already made up its mind about.
 */
async function catchUp({ browserStart = false } = {}) {
  try {
    await reconcileOpenMeetings({ browserStart });
  } catch (err) {
    console.warn('[GM Attendance] could not end interrupted meetings:', err);
  }
  await ensureTrackers();
  try {
    const gone = await storage.purgeExpiredTrash();
    if (gone) console.log('[GM Attendance] trash purged:', gone);
  } catch (err) {
    console.warn('[GM Attendance] trash purge failed:', err);
  }
  await syncWithSheet();
}
// A browser that has just started took every call with it when it went, however its restored tabs
// look, so that pass ends them all rather than asking which links are still on screen.
chrome.runtime.onStartup.addListener(() => serial(() => catchUp({ browserStart: true })));
serial(catchUp);

console.log('[GM Attendance] service worker started');
