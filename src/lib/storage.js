/**
 * chrome.storage layer for the attendance data model (schemaVersion 4).
 *
 * Stores:
 *   attendanceHistory : Meeting[]  (newest-first)
 *   meetingGroups     : Group[]    ({ id, name, color, roster[], createdAt })
 *   settings          : { autoSync, syncInterval, spreadsheetId, maxStoredMeetings, theme }
 *   savedRoster       : string[]   (global default roster)
 *   autoTrack         : boolean    (own key — the content script reads it directly)
 *   schemaVersion     : number
 *
 * Pure derivation lives in attendance.js; this module only persists and migrates.
 */

import {
  buildMeetingRecord, normalizeMeeting, resolveMappedName, splitConcatenatedEvents,
  annotateMerges, lastActivityMs, RESUME_WINDOW_MS, REJOIN_WINDOW_MS
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

export const SCHEMA_VERSION = 4;

export const DEFAULT_SETTINGS = {
  autoSync: false,
  syncInterval: 5,
  spreadsheetId: null,
  maxStoredMeetings: 200, // 0 = unlimited (keep every meeting)
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

/**
 * Insert or replace by id, newest-first, capped to maxStoredMeetings (0 = unlimited).
 * Preserves groupId and the nameMap across live-meeting rewrites, so a rename/merge isn't
 * undone by the content script reporting raw scraped names again.
 *
 * The map is *not* folded into the stored attendance: participants stay separate on disk and
 * are merged on read (normalizeMeeting), which is what keeps a merge undoable. Callers get
 * the merged view back — it is what the badge counts and what Sheets should receive.
 */
export async function upsertMeeting(record) {
  const settings = await getSettings();
  let history = await getHistory();

  const idx = history.findIndex(m => m.id === record.id);

  const nameMap = record.nameMap || (idx >= 0 && history[idx].nameMap) || null;
  const toStore = (nameMap && Object.keys(nameMap).length) ? { ...record, nameMap } : record;

  const merged = idx >= 0 ? { ...history[idx], ...toStore } : toStore;
  if (idx >= 0) history[idx] = merged; else history.push(merged);

  history.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));

  // maxStoredMeetings === 0 means unlimited — keep every meeting.
  const cap = settings.maxStoredMeetings === 0 ? 0 : (settings.maxStoredMeetings || 200);
  if (cap > 0 && history.length > cap) history = history.slice(0, cap);

  await saveHistory(history);
  return normalizeMeeting(merged);
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
 * A recurring link reuses the same Meet code. To avoid overwriting a prior session we only
 * resume an existing record when it was active recently (refresh / rejoin); otherwise the
 * caller starts a fresh session record.
 *
 * A record that already ended resumes only within the much shorter REJOIN_WINDOW_MS, because
 * reloading a Meet tab ends the meeting on the way out: the page reports everyone as gone
 * before it goes away. Rejoining the same link a minute later is that same call coming back,
 * while the same link tomorrow is a new session and must stay one.
 */
export async function findResumableSession(code) {
  if (!code) return null;
  const now = Date.now();
  let best = null, bestT = 0;
  for (const raw of await getHistory()) {
    const m = normalizeMeeting(raw);
    if (m.meetingCode !== code) continue;
    const window = m.endedAt ? REJOIN_WINDOW_MS : RESUME_WINDOW_MS;
    const t = lastActivityMs(m) || Date.parse(m.date) || 0;
    if (now - t < window && t > bestT) { best = m; bestT = t; }
  }
  return best;
}

/* ============================ participants ============================ */

const normName = (s) => String(s || '').trim().toLowerCase();

/**
 * Rename one participant of one meeting; when the new name already belongs to another
 * participant the two entries read as one person from then on. Only an alias is written to
 * the meeting's `nameMap` — the entries themselves are left alone, so a live meeting that
 * keeps reporting the old scraped name re-applies the edit on every read, and the merge can
 * be taken back later. Returns { meeting, merged } or null.
 */
export async function renameParticipant(meetingId, fromName, toName) {
  const from = String(fromName || '').trim();
  const to = String(toName || '').trim();
  if (!from || !to || from === to) return null;

  const history = await getHistory();
  const meeting = history.find(m => m.id === meetingId);
  if (!meeting) return null;

  const key = normName(from);
  const merged = Object.keys(meeting.attendance || {})
    .some(n => normName(n) !== key && normName(n) === normName(to));

  // Flatten chains at write time: aliases that pointed at the old name follow it.
  const nameMap = { ...(meeting.nameMap || {}) };
  for (const k in nameMap) if (normName(nameMap[k]) === key) nameMap[k] = to;
  nameMap[key] = to;

  meeting.nameMap = nameMap;
  await saveHistory(history);
  return { meeting, merged };
}

/**
 * Undo a merge: drop every alias that resolves to `displayName`, so the entries folded into
 * that person appear under their own scraped names again. An alias that only restyles the
 * same name (a rename, "edyta tatara" → "EDYTA TATARA") is kept — that is not what the merge
 * added, and dropping it would undo an unrelated edit. Returns { meeting, restored } or null.
 */
export async function unmergeParticipant(meetingId, displayName) {
  const history = await getHistory();
  const meeting = history.find(m => m.id === meetingId);
  if (!meeting || !meeting.nameMap) return null;

  const target = normName(displayName);
  const kept = {};
  const restored = [];
  for (const key in meeting.nameMap) {
    const landsHere = normName(resolveMappedName(key, meeting.nameMap)) === target;
    if (landsHere && key !== target) restored.push(key);
    else kept[key] = meeting.nameMap[key];
  }
  if (!restored.length) return null;

  if (Object.keys(kept).length) meeting.nameMap = kept; else delete meeting.nameMap;
  await saveHistory(history);
  return { meeting, restored };
}

/* ============================ meeting hours ============================ */

/**
 * The official hours of a meeting, kept separately from `date` (which is when tracking
 * started) so that joining the call early doesn't move the start and stretch the meeting.
 * `buildMeetingRecord` never emits these fields, so the spread in `upsertMeeting` keeps
 * them across live-meeting rewrites — same mechanism that preserves `groupId`.
 */
function writeSchedule(meeting, start, end) {
  if (start) meeting.scheduledStart = start; else delete meeting.scheduledStart;
  if (end) meeting.scheduledEnd = end; else delete meeting.scheduledEnd;
}

/** Set the hours by hand. Pass null for a side to drop it back to automatic. */
export async function setMeetingSchedule(meetingId, { start = null, end = null } = {}) {
  const history = await getHistory();
  const meeting = history.find(m => m.id === meetingId);
  if (!meeting) return null;
  writeSchedule(meeting, start, end);
  await saveHistory(history);
  return meeting;
}

/**
 * Fill in hours detected from the calendar event. Only fills blanks — a value already
 * on the record (typically the user's own edit) always wins.
 */
export async function applyDetectedSchedule(meetingId, { start = null, end = null } = {}) {
  const history = await getHistory();
  const meeting = history.find(m => m.id === meetingId);
  if (!meeting) return null;
  if (meeting.scheduledStart || meeting.scheduledEnd) return null;
  if (!start && !end) return null;
  writeSchedule(meeting, start, end);
  await saveHistory(history);
  return meeting;
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

/**
 * Auto-tracking has its own key rather than living in `settings`, because the content script
 * reads it on a Meet page where nothing else about the settings matters. Absent means on.
 */
export async function getAutoTrack() {
  return (await get(STORAGE_KEYS.AUTO_TRACK)) !== false;
}
export async function setAutoTrack(on) {
  await set(STORAGE_KEYS.AUTO_TRACK, !!on);
}

/* ============================ migration ============================ */

/**
 * Take apart merges that an older version wrote into the attendance itself: the alias target
 * holds both participants' events and the source entry is gone, so the merge cannot be undone.
 * Where the target's events are plainly a concatenation (time steps backwards) and the parts
 * line up one-for-one with the missing sources, hand the extra parts back to their names.
 * Anything ambiguous is left merged — a wrong split would be worse than no split.
 */
function unbakeMerges(meeting) {
  const nameMap = meeting && meeting.nameMap;
  const attendance = meeting && meeting.attendance;
  if (!nameMap || !attendance) return meeting;

  const present = new Set(Object.keys(attendance).map(normName));
  const missing = new Map(); // display target -> [source keys with no entry of their own]
  for (const key in nameMap) {
    const target = resolveMappedName(key, nameMap);
    if (key === normName(target) || present.has(key)) continue;
    if (!missing.has(target)) missing.set(target, []);
    missing.get(target).push(key);
  }
  if (!missing.size) return meeting;

  const next = { ...attendance };
  let changed = false;
  missing.forEach((sources, target) => {
    const entry = next[target];
    if (!entry) return;
    const parts = splitConcatenatedEvents(entry.events);
    if (parts.length !== sources.length + 1) return; // can't tell the streams apart — leave it
    next[target] = { ...entry, events: parts[0] };
    sources.forEach((src, i) => { next[src] = { email: null, events: parts[i + 1] }; });
    changed = true;
  });
  return changed ? { ...meeting, attendance: next } : meeting;
}

/**
 * Migrate to the current schemaVersion: fold any legacy v1 `meetings` object into the
 * history, normalize every record (adds meetingCode / sessions / firstSeen, consistent
 * presence). Idempotent and gated on schemaVersion.
 *
 * v4 rewrites in place, without folding aliases in: records written before the session
 * folding understood merged participants hold sessions that dropped the overlap between two
 * merged identities, and merges that were baked into the attendance are split back out so
 * they can be undone. Every read path merges the view anyway.
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

  history = history.map(m => normalizeMeeting(unbakeMerges(m), { mergeAliases: false }))
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

/**
 * Full backup. Meetings are normalized on the way out — like every read path — so the file
 * carries freshly derived sessions and totals rather than whatever a record was written with;
 * records stored before a derivation fix would otherwise export stale numbers.
 *
 * Participants are exported *unmerged*, exactly as recorded, because a merge is a view and not
 * a fact about the call: folding it in would export one lump of two people's events and no
 * backup could give them back. The merge travels beside them instead — as the `nameMap` the
 * app already uses, plus a readable `mergeInto` on each folded entry (attendance.annotateMerges)
 * — so importing restores the merged view and leaves it undoable.
 */
export async function exportAllJSON() {
  const [history, groups] = await Promise.all([getHistory(), getGroups()]);
  const meetings = history.map(m => annotateMerges(normalizeMeeting(m, { mergeAliases: false })));
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, groups, meetings }, null, 2);
}
