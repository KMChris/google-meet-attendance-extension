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

/**
 * tabId -> raw meeting { id, meetingCode, startTime, url, meetingTitle, groupId?, participants }.
 *
 * `inCall` is set once a page has reported somebody of its own: a Meet link can be open in more
 * than one tab, and that is what tells a tab in the meeting from a tab sitting in the green room
 * of the same link. A resumed record hands a tab everyone it already holds, so the participants
 * alone say nothing about where the page is.
 */
const activeMeetings = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // One at a time (see serial): every one of these reads the history, changes it and writes it
  // back, and two at once would lose whichever wrote first — a page reporting into two calls, or
  // a recovery pass running while one of them is being tracked.
  serial(() => handleMessage(message, sender))
    .then(result => {
      sendResponse(result);
      // A call that is over is the moment to hand the sheet this meeting, and to take from it
      // whatever was recorded elsewhere meanwhile. Outside the queue: it goes to the network, and
      // nothing being tracked can wait behind a request that may never answer.
      //
      // A page merely going away says nothing about the call — it comes straight back on a
      // reload, and the record with it. That one waits for a later pass, because the sheet is
      // written once and a half a meeting sent to it could never be corrected.
      if (message.type === 'MEETING_ENDED' && message.reason !== 'unload') syncWithSheet({ force: true });
    })
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
 * Is what a page is saying about the call this tab is already reporting into?
 *
 * A tab is not tied to one meeting: entering another call from the same tab is a page load, and
 * leaving one for the next is not even that. The page says so on its way out, and that message —
 * sent while the page is being taken down — is the one that can go missing. Without asking, the
 * second meeting's people would be recorded into the first meeting's record, under its title.
 */
function sameCall(raw, code) {
  return !code || !raw.meetingCode || raw.meetingCode === code;
}

/**
 * Resolve the raw meeting for a tab, resuming a stored session or starting a new one.
 *
 * A page load reports its first participants and its start at the same moment, and reading the
 * store to decide which session they belong to takes long enough for both to arrive first. What
 * keeps them from each opening a record of their own — stamped a millisecond apart, so two ids for
 * one call — is that every message is handled in turn: see `serial`, which the second one waits
 * behind until the first has put the tab in `activeMeetings`.
 */
async function resolveRawMeeting(message, tabId) {
  const code = message.meetingId || null;

  const held = tabId != null ? activeMeetings.get(tabId) : null;
  if (held) {
    if (sameCall(held, code)) return held;
    activeMeetings.delete(tabId);   // this tab has moved on; what it says now is about another call
  }
  return openRawMeeting(message, tabId);
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
  // Meet puts the calendar event in the tab title once the call is up, which is after the record
  // was opened and named after its bare code. The page says what it sees every minute, so this is
  // where a meeting stops being called abc-defg-hij.
  const named = await storage.nameUntitledMeeting(raw.id, message.meetingTitle);
  if (named) raw.meetingTitle = named.meetingTitle;   // or the next scan writes the code back
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
  // and it has seen the call itself, not merely resumed a record about it
  if (Object.keys(message.participants || {}).length) raw.inCall = true;
  if (tabId != null) activeMeetings.set(tabId, raw);

  // upsertMeeting re-applies any user renames/merges (nameMap) — count the mapped result.
  const saved = await storage.upsertMeeting(liveRecord(raw));

  updateBadge(tabId, String(Object.keys(saved.attendance).length), BADGE_COLOR);
  return { success: true, id: raw.id };
}

/** Is another tab in this same call right now? */
function stillInCall(id) {
  for (const raw of activeMeetings.values()) if (raw.id === id && raw.inCall) return true;
  return false;
}

async function handleMeetingEnded(message, tabId) {
  const raw = await resolveRawMeeting(message, tabId);
  if (tabId != null) activeMeetings.delete(tabId);   // before the question below, or it answers itself

  // A page can leave a call that is still going on: the same link open in a second tab is a second
  // page on the same meeting, and one of them closing says nothing about the other. Ending the
  // record here would cut the meeting short at this moment and mark everyone still in it as gone,
  // and it would stay that way until the last page leaves — long enough for the spreadsheet, which
  // is written once, to be handed half a meeting. The tab that is still in the call keeps
  // reporting, and its own end is the one that ends the record.
  if (stillInCall(raw.id)) {
    updateBadge(tabId, '', '');
    return { success: true, id: raw.id, stillInCall: true };
  }

  if (message.participants) raw.participants = attendance.mergeRawParticipants(raw.participants, message.participants);

  const endTime = message.endTime || new Date().toISOString();
  // Nobody is left standing in a call that is over. The page reports on the people this load of
  // it knew about, and a resumed record holds more than that — anyone it never saw would keep
  // their session open and read as still in the call for the life of the record.
  raw.participants = attendance.closeOpenParticipants(raw.participants, endTime);

  const record = attendance.buildMeetingRecord(raw);
  record.endedAt = endTime;

  // Nothing was ever recorded in this one: the link was opened and the call was never joined. It
  // is not a meeting that happened, and ended it would sit in the register empty — and from there
  // in the spreadsheet, which only ever adds.
  const empty = !Object.keys(record.attendance).length &&
    (await storage.discardEmptyMeetings([record.id])).length > 0;
  const saved = empty ? record : await storage.upsertMeeting(record);

  updateBadge(tabId, '', '');
  return { success: true, id: saved.id, discarded: empty };
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
 * Tab closed mid-meeting.
 *
 * What the tab held is only known here while this worker has been up as long as the call, and a
 * link can be open in more than one tab — a second one sitting in the green room is still a tab
 * on that call. So closing one is not taken as the call ending: it says the call was live until
 * this moment, and which records that leaves abandoned is worked out the way every other recovery
 * works it out, by the Meet links no longer open anywhere.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  const raw = activeMeetings.get(tabId);
  activeMeetings.delete(tabId);   // before the pass below, or it reads as still being reported into
  serial(async () => {
    if (raw) await storage.touchMeetingLive(raw.id, new Date().toISOString());
    await reconcileOpenMeetings({ ignoreTabId: tabId });
  }).catch(err => console.warn('[GM Attendance] could not close out the tab:', err));
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

/**
 * The meeting code a tab sits on, read from its URL the way the content script reads it: out of
 * the path, wherever in it the code sits. Reading it any more narrowly than the page does would
 * leave a call whose link this cannot recognise looking like one nobody has open, and this is
 * the judgement that ends abandoned meetings.
 */
function meetCodeOf(url) {
  const path = /^https?:\/\/meet\.google\.com(\/[^?#]*)/.exec(url || '');
  const code = path && /\/([a-z]{3}-[a-z]{4}-[a-z]{3})/.exec(path[1]);
  return code ? code[1] : null;
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
  // What this worker holds open in a tab, which is the one thing that says a record has only just
  // been opened rather than been left behind. Kept before the line below takes it away.
  const held = new Set([...activeMeetings.values()].map(raw => raw.id));

  // A browser that has just started is not tracking anything yet, whatever this worker has been
  // told since it came up: a record being reported into at this point can only be one that a
  // tracker put back into a restored tab has resumed, and no call survived the browser going away.
  if (browserStart) activeMeetings.clear();

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

  const ids = stranded.map(m => m.id);
  // The green room left standing, a Meet address in a tab nobody went back to: a record nothing was
  // ever recorded in goes rather than being ended, or the register fills with meetings that never
  // happened. A record this worker has just opened in a tab is not one of those — it is empty
  // because the first scan has not come back yet, and only the message that opened it carries the
  // meeting's name and link.
  const dropped = await storage.discardEmptyMeetings(ids.filter(id => !held.has(id)));
  if (dropped.length) console.log('[GM Attendance] dropped records of calls nobody joined:', dropped.length);

  const closed = await storage.endInterruptedMeetings(ids);
  if (closed.length) console.log('[GM Attendance] ended interrupted meetings:', closed.length);
}

/**
 * Two-way sync, whenever this worker is a good place to run one. Failures are never fatal.
 *
 * One pass at a time. This worker is told to wake twice when the browser starts — once because it
 * started, once because Chrome says the browser did — and a pass decides what to send by reading
 * what the sheet already has: two of them reading before either has written would both find the
 * same meetings missing, and both send them. The spreadsheet is only ever added to, so a row sent
 * twice stays there twice.
 */
let syncing = null;
function syncWithSheet(opts) {
  if (syncing) return syncing;
  syncing = sheetsSync.autoSync(opts)
    .then(moved => { if (moved) console.log('[GM Attendance] synced with Sheets:', moved); })
    .catch(err => console.warn('[GM Attendance] auto-sync failed:', err))
    .finally(() => { syncing = null; });
  return syncing;
}

/**
 * One at a time: everything that changes the history reads it, changes it and writes it back, so
 * two at once would lose whichever wrote first. The caller still gets its own result and its own
 * failure, and neither leaves the queue broken for what is waiting behind it.
 *
 * It is also what keeps one page load to one record: the start of a meeting and its first scan
 * arrive together, and the second waits here while the first works out which session they belong
 * to and writes the tab down.
 */
let queued = Promise.resolve();
function serial(task) {
  const run = queued.then(task);
  queued = run.catch(() => {});
  return run;
}

/**
 * Housekeeping whenever the worker wakes: end what nothing got to end, give every Meet tab a
 * tracker back, and drop what has waited out its stay in the trash.
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
}

/**
 * Waking up: the housekeeping, and then whatever was recorded on another machine. The dashboard
 * takes from the sheet on load as well; between the two, neither needs an alarm of its own.
 *
 * The sheet is asked for afterwards rather than as part of the pass, because it is reached over
 * the network: a request that never answers would hold up every call being tracked behind it.
 */
function wakeUp(opts) {
  return serial(() => catchUp(opts))
    .catch(err => console.warn('[GM Attendance] catch-up pass failed:', err))
    .then(() => syncWithSheet());
}
// A browser that has just started took every call with it when it went, however its restored tabs
// look, so that pass ends them all rather than asking which links are still on screen.
chrome.runtime.onStartup.addListener(() => wakeUp({ browserStart: true }));
wakeUp();

console.log('[GM Attendance] service worker started');
