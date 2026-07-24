/**
 * chrome.storage layer for the attendance data model (schemaVersion 3).
 *
 * Stores:
 *   attendanceHistory : Meeting[]  (newest-first)
 *   meetingGroups     : Group[]    ({ id, name, color, roster[], createdAt })
 *   settings          : { autoSync, syncInterval, spreadsheetId, maxStoredMeetings,
 *                         lateThresholdMinutes, theme }
 *   savedRoster       : string[]   (global default roster)
 *   autoTrack         : boolean    (own key — the content script reads it directly)
 *   schemaVersion     : number
 *
 * Pure derivation lives in attendance.js; this module only persists and migrates.
 */

import {
  buildMeetingRecord, normalizeMeeting, lastActivityMs, RESUME_WINDOW_MS
} from './attendance.js';

export const STORAGE_KEYS = {
  HISTORY: 'attendanceHistory',
  GROUPS: 'meetingGroups',
  LEGACY_MEETINGS: 'meetings',
  SETTINGS: 'settings',
  ROSTER: 'savedRoster',
  AUTO_TRACK: 'autoTrack',
  SCHEMA_VERSION: 'schemaVersion'
};

export const SCHEMA_VERSION = 3;

export const DEFAULT_SETTINGS = {
  autoSync: false,
  syncInterval: 5,
  spreadsheetId: null,
  maxStoredMeetings: 200, // 0 = unlimited (keep every meeting)
  lateThresholdMinutes: 5,
  theme: 'system' // 'system' | 'light' | 'dark'
};

/* ============================ generic ============================ */

export function get(key) {
  return new Promise((resolve) => chrome.storage.local.get([key], (r) => resolve(r[key])));
}
export function set(key, value) {
  return new Promise((resolve) => chrome.storage.local.set({ [key]: value }, resolve));
}
export function remove(key) {
  return new Promise((resolve) => chrome.storage.local.remove([key], resolve));
}
function getMany(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function setMany(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ============================ history CRUD ============================ */

export async function getHistory() {
  const h = await get(STORAGE_KEYS.HISTORY);
  return Array.isArray(h) ? h : [];
}

export async function saveHistory(history) {
  await set(STORAGE_KEYS.HISTORY, history);
  return history;
}

export async function getMeetingById(id) {
  return (await getHistory()).find(m => m.id === id) || null;
}

/** Insert or replace by id, newest-first, capped to maxStoredMeetings (0 = unlimited). Preserves groupId. */
export async function upsertMeeting(record) {
  const settings = await getSettings();
  let history = await getHistory();

  const idx = history.findIndex(m => m.id === record.id);
  if (idx >= 0) history[idx] = { ...history[idx], ...record };
  else history.push(record);

  history.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));

  // maxStoredMeetings === 0 means unlimited — keep every meeting.
  const cap = settings.maxStoredMeetings === 0 ? 0 : (settings.maxStoredMeetings || 200);
  if (cap > 0 && history.length > cap) history = history.slice(0, cap);

  await saveHistory(history);
  return record;
}

export async function deleteMeetingById(id) {
  const history = await getHistory();
  const next = history.filter(m => m.id !== id);
  await saveHistory(next);
  return next.length !== history.length;
}

export async function clearHistory() {
  await saveHistory([]);
}

/**
 * A recurring link reuses the same Meet code. To avoid overwriting a prior session we
 * only resume an existing record when it is still open (no endedAt) and was active
 * recently (refresh / rejoin); otherwise the caller starts a fresh session record.
 */
export async function findResumableSession(code) {
  if (!code) return null;
  const now = Date.now();
  let best = null, bestT = 0;
  for (const raw of await getHistory()) {
    const m = normalizeMeeting(raw);
    if (m.meetingCode !== code || m.endedAt) continue;
    const t = lastActivityMs(m) || Date.parse(m.date) || 0;
    if (now - t < RESUME_WINDOW_MS && t > bestT) { best = m; bestT = t; }
  }
  return best;
}

/* ============================ groups CRUD ============================ */

const GROUP_COLORS = ['teal', 'amber', 'violet', 'rose', 'sky', 'lime'];

export async function getGroups() {
  const g = await get(STORAGE_KEYS.GROUPS);
  return Array.isArray(g) ? g : [];
}
export async function saveGroups(groups) {
  await set(STORAGE_KEYS.GROUPS, groups);
  return groups;
}
export async function getGroupById(id) {
  return (await getGroups()).find(g => g.id === id) || null;
}

export async function createGroup({ name, color, roster } = {}) {
  const groups = await getGroups();
  const group = {
    id: uid('grp'),
    name: (name || '').trim() || 'Series',
    color: color || GROUP_COLORS[groups.length % GROUP_COLORS.length],
    roster: Array.isArray(roster) ? roster : [],
    createdAt: new Date().toISOString()
  };
  groups.push(group);
  await saveGroups(groups);
  return group;
}

export async function updateGroup(id, patch) {
  const groups = await getGroups();
  const i = groups.findIndex(g => g.id === id);
  if (i < 0) return null;
  groups[i] = { ...groups[i], ...patch };
  await saveGroups(groups);
  return groups[i];
}

/** Delete a group and unassign its meetings (meetings themselves are kept). */
export async function deleteGroup(id) {
  await saveGroups((await getGroups()).filter(g => g.id !== id));
  const history = await getHistory();
  let changed = false;
  history.forEach(m => { if (m.groupId === id) { delete m.groupId; changed = true; } });
  if (changed) await saveHistory(history);
  return true;
}

export async function assignMeetingToGroup(meetingId, groupId) {
  const history = await getHistory();
  const m = history.find(x => x.id === meetingId);
  if (!m) return false;
  if (groupId) m.groupId = groupId; else delete m.groupId;
  await saveHistory(history);
  return true;
}

/** Assign many meetings at once (used by "group this series"). */
export async function assignMeetingsToGroup(meetingIds, groupId) {
  const ids = new Set(meetingIds || []);
  const history = await getHistory();
  history.forEach(m => { if (ids.has(m.id)) { if (groupId) m.groupId = groupId; else delete m.groupId; } });
  await saveHistory(history);
  return true;
}

/* ============================ settings / roster ============================ */

export async function getSettings() {
  const s = await get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}
export async function updateSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await set(STORAGE_KEYS.SETTINGS, next);
  return next;
}

export async function getRoster() {
  const r = await get(STORAGE_KEYS.ROSTER);
  return Array.isArray(r) ? r : [];
}
export async function saveRoster(roster) {
  await set(STORAGE_KEYS.ROSTER, Array.isArray(roster) ? roster : []);
}

/* ============================ migration ============================ */

/**
 * Migrate to schemaVersion 3: fold any legacy v1 `meetings` object into the history,
 * normalize every record (adds meetingCode / sessions / firstSeen, consistent presence).
 * Idempotent and gated on schemaVersion.
 */
export async function migrateIfNeeded() {
  const stored = await getMany([
    STORAGE_KEYS.SCHEMA_VERSION, STORAGE_KEYS.LEGACY_MEETINGS,
    STORAGE_KEYS.HISTORY, STORAGE_KEYS.GROUPS
  ]);

  if ((stored[STORAGE_KEYS.SCHEMA_VERSION] || 0) >= SCHEMA_VERSION) return { migrated: 0 };

  let history = Array.isArray(stored[STORAGE_KEYS.HISTORY]) ? stored[STORAGE_KEYS.HISTORY] : [];
  let migrated = 0;

  const legacy = stored[STORAGE_KEYS.LEGACY_MEETINGS];
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
    const ids = new Set(history.map(m => m.id));
    for (const key in legacy) {
      const rec = buildMeetingRecord(legacy[key]);
      if (!ids.has(rec.id)) { history.push(rec); ids.add(rec.id); migrated++; }
    }
  }

  history = history.map(normalizeMeeting)
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));

  const groups = Array.isArray(stored[STORAGE_KEYS.GROUPS]) ? stored[STORAGE_KEYS.GROUPS] : [];

  await setMany({
    [STORAGE_KEYS.HISTORY]: history,
    [STORAGE_KEYS.GROUPS]: groups,
    [STORAGE_KEYS.SCHEMA_VERSION]: SCHEMA_VERSION
  });
  return { migrated };
}

/* ============================ export ============================ */

export async function exportAllJSON() {
  const [history, groups] = await Promise.all([getHistory(), getGroups()]);
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, groups, meetings: history }, null, 2);
}
