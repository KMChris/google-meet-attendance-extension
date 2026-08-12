/**
 * Background service worker.
 *
 * Narrow responsibility: ingest attendance events from the content script into the
 * canonical history, keep the toolbar badge live, run migration on install, and
 * auto-sync a finished meeting to Google Sheets. All read/CRUD for the UI happens
 * in the pages themselves (they import storage.js directly).
 *
 * Session identity fix: a recurring Meet link reuses the same code, so we resolve a
 * per-session record id — resuming an open session on refresh/rejoin, but starting a
 * fresh record for a later day — instead of letting the code overwrite prior sessions.
 */

import * as storage from '../lib/storage.js';
import * as attendance from '../lib/attendance.js';
import * as sheetsApi from '../lib/sheets-api.js';

const BADGE_COLOR = '#1e7a4e'; // present-green, matches the status palette

/** tabId -> raw meeting { id, meetingCode, startTime, url, meetingTitle, groupId?, participants } */
const activeMeetings = new Map();

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
    case 'MEETING_ENDED':     return handleMeetingEnded(message, tabId);
    default:                  return { error: 'Unknown message type' };
  }
}

/** Resolve the raw meeting for a tab, resuming a stored session or starting a new one. */
async function resolveRawMeeting(message, tabId) {
  if (tabId != null && activeMeetings.has(tabId)) return activeMeetings.get(tabId);

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

async function handleMeetingStarted(message, tabId) {
  const raw = await resolveRawMeeting(message, tabId);
  // Persist the (possibly empty) record so it appears immediately; don't clobber a resume.
  const existing = await storage.getMeetingById(raw.id);
  if (!existing) await storage.upsertMeeting(attendance.buildMeetingRecord(raw));

  updateBadge(tabId, 'ON', BADGE_COLOR);
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
  if (!existing) await storage.upsertMeeting(attendance.buildMeetingRecord(raw));

  const applied = await storage.applyDetectedSchedule(raw.id, {
    start: message.scheduledStart || null,
    end: message.scheduledEnd || null
  });
  if (applied) console.log('[GM Attendance] scheduled hours detected:', message.scheduledStart, '→', message.scheduledEnd);
  return { success: true, id: raw.id, applied: !!applied };
}

async function handleAttendanceUpdate(message, tabId) {
  const raw = await resolveRawMeeting(message, tabId);
  raw.participants = message.participants || {};
  if (tabId != null) activeMeetings.set(tabId, raw);

  // upsertMeeting re-applies any user renames/merges (nameMap) — count the mapped result.
  const saved = await storage.upsertMeeting(attendance.buildMeetingRecord(raw));

  updateBadge(tabId, String(Object.keys(saved.attendance).length), BADGE_COLOR);
  return { success: true, id: raw.id };
}

async function handleMeetingEnded(message, tabId) {
  const raw = await resolveRawMeeting(message, tabId);
  if (message.participants) raw.participants = message.participants;

  const record = attendance.buildMeetingRecord(raw);
  record.endedAt = message.endTime || new Date().toISOString();
  // The stored record has the user's renames/merges (nameMap) applied — sync that one.
  const saved = await storage.upsertMeeting(record);

  if (tabId != null) activeMeetings.delete(tabId);
  updateBadge(tabId, '', '');

  const settings = await storage.getSettings();
  if (settings.autoSync && settings.spreadsheetId) {
    try {
      await sheetsApi.syncMeeting(settings.spreadsheetId, saved);
      console.log('[GM Attendance] auto-synced to Sheets:', saved.id);
    } catch (err) {
      console.warn('[GM Attendance] auto-sync failed:', err);
    }
  }
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

/** Tab closed mid-meeting — close out any still-present sessions and finalize. */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!activeMeetings.has(tabId)) return;
  const raw = activeMeetings.get(tabId);

  const endTime = new Date().toISOString();
  for (const name in raw.participants) {
    const p = raw.participants[name];
    if (p && p.isPresent) {
      p.events = p.events || [];
      p.events.push({ time: endTime, type: 'Leave' });
      p.isPresent = false;
    }
  }

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

console.log('[GM Attendance] service worker started');
