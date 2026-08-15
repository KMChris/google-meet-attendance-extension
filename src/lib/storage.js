/**
 * chrome.storage layer for the attendance data model (schemaVersion 4).
 *
 * Stores:
 *   attendanceHistory : Meeting[]  (newest-first)
 *   attendanceHistoryRev : string  (changes on every write to the history — see mutate)
 *   trashedMeetings   : Meeting[]  (deleted, each with deletedAt; purged after the retention window)
 *   trashedMeetingsRev : string    (the same stamp on the trash, and for the same reason)
 *   meetingGroups     : Group[]    ({ id, name, color, roster[], createdAt })
 *   settings          : { autoSync, syncInterval, spreadsheetId, maxStoredMeetings,
 *                         trashRetentionDays, theme }
 *   syncState         : { lastSyncAt, claimedAt } (when the sheet and this store last agreed, and
 *                       when a pass took up the one-at-a-time claim — see sheets-sync.autoSync)
 *   savedRoster       : string[]   (global default roster)
 *   autoTrack         : boolean    (own key — the content script reads it directly)
 *   schemaVersion     : number
 *
 * Pure derivation lives in attendance.js; this module only persists and migrates.
 */

import {
  buildMeetingRecord, normalizeMeeting, resolveMappedName, splitConcatenatedEvents,
  annotateMerges, adoptMergeAnnotations, lastActivityMs, hasEventsAfter, closeOpenEvents,
  deriveAttendee, isMeetCode, RESUME_WINDOW_MS, REJOIN_WINDOW_MS
} from './attendance.js';

export const STORAGE_KEYS = {
  HISTORY: 'attendanceHistory',
  HISTORY_REV: 'attendanceHistoryRev',
  TRASH: 'trashedMeetings',
  TRASH_REV: 'trashedMeetingsRev',
  GROUPS: 'meetingGroups',
  LEGACY_MEETINGS: 'meetings',
  SETTINGS: 'settings',
  ROSTER: 'savedRoster',
  AUTO_TRACK: 'autoTrack',
  SYNC_STATE: 'syncState',
  SCHEMA_VERSION: 'schemaVersion'
};

export const SCHEMA_VERSION = 4;

export const DEFAULT_SETTINGS = {
  autoSync: false,
  syncInterval: 5,
  spreadsheetId: null,
  maxStoredMeetings: 200, // 0 = unlimited (keep every meeting)
  trashRetentionDays: 30, // how long a deleted meeting waits before it goes for good
  theme: 'system' // 'system' | 'light' | 'dark'
};

/* ============================ generic ============================ */

export function get(key) {
  return new Promise((resolve) => chrome.storage.local.get([key], (r) => resolve(r[key])));
}
export function set(key, value) {
  return setMany({ [key]: value });
}
export function remove(key) {
  return new Promise((resolve) => chrome.storage.local.remove([key], resolve));
}
function getMany(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

/**
 * Chrome refuses a write by saying so afterwards and doing nothing, which is how a store that has
 * filled up loses a meeting without anybody noticing: the call goes on being recorded into a
 * register that no longer takes it. Two things keep it from happening, and neither is here: the
 * cap on stored meetings, and the `unlimitedStorage` permission, without which a register of two
 * hundred meetings can come within a few megabytes of what an extension is allowed. What is left
 * (a disk with nothing on it to spare) is nothing this can put right, but a record that vanished
 * should not have to be guessed at.
 */
function setMany(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, () => {
    const err = chrome.runtime && chrome.runtime.lastError;
    if (err) console.error('[GM Attendance] the store refused a write:', err.message, '·', Object.keys(obj).join(', '));
    resolve();
  }));
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
  await setMany({ [STORAGE_KEYS.HISTORY]: history, [STORAGE_KEYS.HISTORY_REV]: uid('rev') });
  return history;
}

/** How many times a change is worked out again before it is written over what is there. */
const MUTATE_ATTEMPTS = 6;
/** How far a repair will chase a change that keeps being written over. */
const REPAIR_DEPTH = 3;

/**
 * The two lists more than one context writes to, each with the stamp that says which version of
 * it a write was worked out from. The trash is one of them because a meeting only ever moves
 * between the two: a deletion that loses its race writes the record out of the register and never
 * into the trash, which is the one way this store can drop a meeting for good.
 */
const HISTORY = { list: STORAGE_KEYS.HISTORY, rev: STORAGE_KEYS.HISTORY_REV };
const TRASH = { list: STORAGE_KEYS.TRASH, rev: STORAGE_KEYS.TRASH_REV };

/**
 * Every change to either list goes through here.
 *
 * The dashboard, the report page and the worker all write to one key, and Chrome gives none of
 * them a way to hold it still while a change is worked out: two reading the same array and writing
 * it back a moment apart lose whichever wrote first, and with it a rename or a merge that nothing
 * will ever report again. There is no way to write a key only if it has not moved, so this is done
 * in two parts, and the second is what makes it sound:
 *
 *   before writing — the revision is read again, and a change worked out from a list that has
 *     since moved is worked out again on what is there now. Cheap, and it catches the slow cases:
 *     anything that read the store, went away to settings or the trash, and came back.
 *   after writing — Chrome says what each write replaced. A write that turns out to have gone over
 *     a revision this context never saw puts that revision back and applies its own change on top,
 *     so the store passes through a moment holding one of the two and settles holding both.
 *
 * Two writers at once is what that settles, which is the case there is: the worker recording a
 * call, and a page the user is editing it from. A third landing in the same instant can still cost
 * one of the three its change — one, as it would have cost before, and never the list itself.
 *
 * `change` is handed the stored array to edit in place or to replace, and returns
 * `{ list?, save?, value }`; `value` is what the caller gets back, and `save: false` says it
 * found nothing to do. It is run again for every one of the above, so it must decide everything
 * from the array it is given and keep nothing between runs. `save: false` also has to mean it
 * left the array alone: a repair that says so is answered by writing back the array it was handed,
 * which is the other context's, and an edit made on the way to saying "nothing to do" would ride
 * along with it.
 */
async function mutate(reg, change, resume = null, depth = 0) {
  let base = resume;   // the array to work from, and the revision it stands for
  let restoring = resume != null;   // this run is putting back what a write of ours went over
  for (let attempt = 1; ; attempt++) {
    if (!base) {
      restoring = false;            // read afresh: there is nothing of ours left to put back
      const stored = await getMany([reg.list, reg.rev]);
      base = {
        list: Array.isArray(stored[reg.list]) ? stored[reg.list] : [],
        rev: stored[reg.rev]
      };
    }

    const { list = base.list, save = true, value } = (await change(base.list)) || {};
    // A repair that finds nothing of its own left to do still has to write: what stands in the
    // store is our own write, and it went over the list being handed back here. Returning at this
    // point would leave the other context's change buried under a change that no longer needs it.
    if (!save && !restoring) return value;

    const rev = await get(reg.rev);
    if (rev !== base.rev && attempt < MUTATE_ATTEMPTS) { base = null; continue; }

    await writeList(reg, list, base.rev, change, depth);
    return value;
  }
}

const mutateHistory = (change, resume, depth) => mutate(HISTORY, change, resume, depth);
const mutateTrash = (change) => mutate(TRASH, change);

/**
 * What each write of ours replaced, kept by the revision the write carried so that only our own
 * writes are answered for. Notifications this context cannot have (no `storage.onChanged` to
 * listen to) leave entries nothing consumes, so the oldest are dropped: without the report there
 * is nothing to repair, which is how this behaved before there was one.
 */
const inFlight = new Map();
const IN_FLIGHT_MAX = 50;
let watching = false;

function watchWrites() {
  if (watching) return;
  watching = true;
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const reg of [HISTORY, TRASH]) {
        const rev = changes[reg.rev];
        if (!rev || !inFlight.has(rev.newValue)) continue;
        const ours = inFlight.get(rev.newValue);
        inFlight.delete(rev.newValue);

        const went = (changes[reg.list] || {}).oldValue;
        if (rev.oldValue === ours.expected || !Array.isArray(went) || ours.depth >= REPAIR_DEPTH) continue;
        mutate(reg, ours.change, { list: went, rev: rev.newValue }, ours.depth + 1)
          .catch(err => console.warn('[GM Attendance] could not put a change back:', err));
      }
    });
  } catch (err) {
    watching = false;   // nothing to listen to here; the write below still lands
  }
}

/** Write, and leave word to check what the write went over. */
async function writeList(reg, list, expected, change, depth) {
  watchWrites();
  const token = uid('rev');
  if (watching) {
    inFlight.set(token, { expected, change, depth });
    if (inFlight.size > IN_FLIGHT_MAX) inFlight.delete(inFlight.keys().next().value);
  }
  await setMany({ [reg.list]: list, [reg.rev]: token });
  return list;
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

  const { merged, fresh } = await mutateHistory(history => {
    const idx = history.findIndex(m => m.id === record.id);

    const nameMap = record.nameMap || (idx >= 0 && history[idx].nameMap) || null;
    const toStore = (nameMap && Object.keys(nameMap).length) ? { ...record, nameMap } : record;

    const next = idx >= 0 ? { ...history[idx], ...toStore } : toStore;
    // A name given by hand stays given. The tracker holds the title it scraped when the call
    // opened and writes it again every few seconds, which would otherwise take a rename back.
    if (idx >= 0 && history[idx].titleEdited) next.meetingTitle = history[idx].meetingTitle;
    // Nor does a placeholder take a name back. A tab that landed on the call before Meet put the
    // calendar event in its title holds the bare code and writes it on every scan, and a second
    // tab on the same call holds whatever it was told when it opened.
    if (idx >= 0 && isPlaceholderName(next, next.meetingTitle) && !isPlaceholderName(next, history[idx].meetingTitle)) {
      next.meetingTitle = history[idx].meetingTitle;
    }
    // An end is only undone by a write that carries something later than it — the call coming back
    // after a reload, which is a rejoin somebody records. A scan still in flight when the meeting
    // finished reports nothing newer than the end, and reopening the record on it would leave a
    // finished call reading as one nobody ever ended.
    if (idx >= 0 && history[idx].endedAt && !next.endedAt && !hasEventsAfter(record, history[idx].endedAt)) {
      next.endedAt = history[idx].endedAt;
    }
    if (idx >= 0) history[idx] = next; else history.push(next);

    history.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));

    return { list: capped(history, settings), value: { merged: next, fresh: idx < 0 } };
  });

  // a call thrown away and then rejoined is alive again, so it leaves the trash behind. Only
  // worth a look when the record is new here — during a call this runs every few seconds.
  if (fresh) await purgeMeetings([record.id]);
  return normalizeMeeting(merged);
}

/** The newest `maxStoredMeetings` of them (0 = unlimited — keep every meeting). */
function capped(history, settings) {
  const cap = settings.maxStoredMeetings === 0 ? 0 : (settings.maxStoredMeetings || 200);
  return cap > 0 && history.length > cap ? history.slice(0, cap) : history;
}

/**
 * Hold the register to the cap after the setting is lowered, without writing back a copy the page
 * has been holding while a call was recorded into it.
 */
export async function trimHistoryToCap() {
  const settings = await getSettings();
  return mutateHistory(history => {
    const next = capped(history, settings);
    return { list: next, save: next.length !== history.length, value: history.length - next.length };
  });
}

/**
 * Is this all the title says: the call's own code, or the id it is filed under? That is what a
 * record is opened with, and it is a stand-in for a name rather than one.
 */
function isPlaceholderName(meeting, title) {
  const name = String(title == null ? '' : title).trim();
  return !name || name === meeting.meetingCode || name === meeting.id || isMeetCode(name);
}

/**
 * Name a meeting by hand. Marked as named here (`titleEdited`), which is what keeps a live
 * meeting's own writes from putting the scraped title back — see upsertMeeting.
 */
export async function setMeetingTitle(id, title) {
  const name = String(title || '').trim();
  if (!name) return null;
  return mutateHistory(history => {
    const meeting = history.find(m => m.id === id);
    if (meeting) { meeting.meetingTitle = name; meeting.titleEdited = true; }
    return { save: !!meeting, value: meeting || null };
  });
}

/**
 * Take up the name the page is showing, while the record has none of its own.
 *
 * A record is opened the moment a tab is on a call, and at that moment the tab title is usually
 * still the bare code: Meet puts the calendar event there once the call is up, by which time
 * nothing was left that would notice. The page says what it sees on every heartbeat, and this
 * takes it up the first time it says something better. A name given by hand is never touched.
 */
export async function nameUntitledMeeting(id, title) {
  const name = String(title || '').trim();
  if (!name) return null;
  return mutateHistory(history => {
    const meeting = history.find(m => m.id === id);
    if (!meeting || meeting.titleEdited ||
        isPlaceholderName(meeting, name) || !isPlaceholderName(meeting, meeting.meetingTitle)) {
      return { save: false, value: null };
    }
    meeting.meetingTitle = name;
    return { value: meeting };
  });
}

/**
 * A record nothing was ever recorded in: a link that was opened and a call that was never joined
 * — the green room left standing, a Meet address in a tab nobody went back to. It is not a
 * meeting that happened, and it is the one record with nothing to lose: no participant, no event,
 * no hour anybody spent anywhere. Whatever the user gave it by hand makes it theirs, and that is
 * a record like any other.
 */
function isEmptyRecord(m) {
  return !!m && !Object.keys(m.attendance || {}).length &&
    !m.titleEdited && !m.groupId && !m.archived;
}

/**
 * Drop the records among these that nothing was ever recorded in. Called where a meeting would
 * otherwise be ended, because an empty record ended is an empty row in the register for good — and
 * from there in the spreadsheet too, which only ever adds. Returns the ids that went.
 */
export async function discardEmptyMeetings(ids) {
  const wanted = new Set(ids || []);
  if (!wanted.size) return [];
  return mutateHistory(history => {
    const gone = new Set(history.filter(m => wanted.has(m.id) && isEmptyRecord(m)).map(m => m.id));
    return {
      list: gone.size ? history.filter(m => !gone.has(m.id)) : history,
      save: gone.size > 0, value: [...gone]
    };
  });
}

/** Set aside (or bring back) meetings: a flag on the record, so nothing else about it changes. */
export async function setMeetingsArchived(ids, archived) {
  const wanted = new Set(ids);
  return mutateHistory(history => {
    let changed = 0;
    history.forEach(m => {
      if (!wanted.has(m.id) || !!m.archived === !!archived) return;
      if (archived) m.archived = true; else delete m.archived;
      changed++;
    });
    return { save: changed > 0, value: changed };
  });
}

/* ============================ trash ============================ */
/**
 * Deleting is a move, not an erasure: the record waits in `trashedMeetings` with the moment it
 * was thrown away, and goes for good once it has waited out `trashRetentionDays`. Nothing else
 * reads this key, so a meeting in the trash is out of every count, chart and sync until it is
 * either restored or expires.
 */
export async function getTrash() {
  const t = await get(STORAGE_KEYS.TRASH);
  return Array.isArray(t) ? t : [];
}

/**
 * A deletion is two writes, and the second is the one that must not be lost: the record leaves the
 * register first and only then arrives in the trash, so a write that goes over somebody else's
 * (the worker sweeping what has expired, a second page emptying it) would drop the meeting out of
 * both. Both halves go through the guarded write, which is why the trash carries a revision too.
 */
export async function deleteMeetingById(id) {
  const record = await mutateHistory(history => {
    const found = history.find(m => m.id === id) || null;
    return { list: found ? history.filter(m => m.id !== id) : history, save: !!found, value: found };
  });
  if (!record) return false;
  await mutateTrash(trash => ({
    list: [{ ...record, deletedAt: new Date().toISOString() }, ...trash.filter(m => m.id !== id)],
    value: true
  }));
  return true;
}

/** Back into the history, newest-first as the list expects it. */
export async function restoreMeetings(ids) {
  const wanted = new Set(ids);
  const coming = await mutateTrash(trash => {
    const found = trash.filter(m => wanted.has(m.id));
    return { list: trash.filter(m => !wanted.has(m.id)), save: found.length > 0, value: found };
  });
  if (!coming.length) return 0;
  const restored = coming.map(({ deletedAt, ...rec }) => rec);
  return mutateHistory(history => ({
    list: restored.concat(history.filter(m => !wanted.has(m.id)))
      .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)),
    value: restored.length
  }));
}

/** Out of the trash for good. */
export async function purgeMeetings(ids) {
  const wanted = new Set(ids);
  return mutateTrash(trash => {
    const kept = trash.filter(m => !wanted.has(m.id));
    return { list: kept, save: kept.length !== trash.length, value: trash.length - kept.length };
  });
}

export async function emptyTrash() {
  return mutateTrash(trash => ({ list: [], save: trash.length > 0, value: trash.length }));
}

/**
 * Drop whatever has waited out the retention window. Called on every dashboard load and when
 * the worker wakes, which is often enough for a window measured in days.
 */
export async function purgeExpiredTrash(now = Date.now()) {
  const days = Number((await getSettings()).trashRetentionDays);
  if (!(days > 0)) return 0;
  const cutoff = now - days * 86400000;
  return mutateTrash(trash => {
    // an unreadable timestamp is treated as "just deleted" rather than silently dropped
    const kept = trash.filter(m => (Date.parse(m.deletedAt) || now) > cutoff);
    return { list: kept, save: kept.length !== trash.length, value: trash.length - kept.length };
  });
}

export async function clearHistory() {
  await saveHistory([]);
}

/* ============================ records from elsewhere ============================ */
/**
 * An import, a restore and a sync all bring in records recorded somewhere else, and they all
 * add rather than overwrite: a meeting already here keeps whatever was edited about it, and one
 * in the trash stays deleted, because a backup that still carries it must not undo the deletion.
 *
 * Records land *unmerged*: the merge annotations a record travels with become its nameMap
 * (adoptMergeAnnotations) and the participants stay as they were recorded. Folding them together
 * on the way in would bake two people into one and make the merge impossible to undo, which is
 * the same reason upsertMeeting keeps the map beside the attendance rather than in it.
 *
 * Returns how many were added.
 */
export async function mergeMeetings(records) {
  const [trash, settings] = await Promise.all([getTrash(), getSettings()]);
  return mutateHistory(history => {
    const seen = new Set([...history.map(m => m.id), ...trash.map(m => m.id)]);

    const fresh = [];
    (records || []).forEach(rec => {
      if (!rec || !rec.id || seen.has(rec.id)) return;
      seen.add(rec.id);
      fresh.push(adoptMergeAnnotations(rec));
    });
    if (!fresh.length) return { save: false, value: 0 };

    // Held to "meetings to keep" here rather than by whatever writes next. A file or a sheet can
    // carry more than the register keeps, and taking all of them in would report every one and
    // then lose the oldest to the first call recorded afterwards, without a word. What is left out
    // is still in the file and still in the sheet, and comes home when the setting is raised.
    const next = capped(history.concat(fresh)
      .map(m => normalizeMeeting(m, { mergeAliases: false }))
      .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)), settings);

    const kept = new Set(next.map(m => m.id));
    return { list: next, value: fresh.filter(m => kept.has(m.id)).length };
  });
}

/** Series from elsewhere, under the same rule: only the ones this store does not have. */
export async function mergeGroups(list) {
  const groups = await getGroups();
  const known = new Set(groups.map(g => g.id));

  const fresh = [];
  (list || []).forEach(g => {
    if (!g || !g.id || known.has(g.id)) return;
    known.add(g.id);
    fresh.push(g);
  });
  if (fresh.length) await saveGroups(groups.concat(fresh));
  return fresh.length;
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
 *
 * Participants come back unmerged, the way they are stored. The worker seeds the tab's own record
 * of the call from this and writes it out again on the next scan, so a merged view handed back
 * here would be written to disk as one participant holding both people's events: the merge baked
 * in, and no longer undoable. The map beside them merges the view on read, as it does everywhere.
 */
export async function findResumableSession(code) {
  if (!code) return null;
  const now = Date.now();
  let best = null, bestT = 0;
  for (const raw of await getHistory()) {
    const m = normalizeMeeting(raw, { mergeAliases: false });
    if (m.meetingCode !== code) continue;
    const window = m.endedAt ? REJOIN_WINDOW_MS : RESUME_WINDOW_MS;
    const t = lastActivityMs(m) || Date.parse(m.date) || 0;
    if (now - t < window && t > bestT) { best = m; bestT = t; }
  }
  return best;
}

/* ============================ interrupted tracking ============================ */
/**
 * Nothing gets a chance to run when the browser is killed, the extension is switched off or an
 * update swaps it out mid-call, so a record can be left open with everyone still inside it. Two
 * things put that right: a watermark written while tracking runs, and a pass that ends whatever
 * the watermark says has been abandoned.
 */

/**
 * Note that the page was still reporting at `at`. Costs one field on the record.
 *
 * A record that carries an end is left alone: the watermark says when tracking was last known to
 * be running, which is nothing a finished meeting has left to say, and moving it would stretch
 * the window the meeting was observed over past the end it already has.
 */
export async function touchMeetingLive(id, at = new Date().toISOString()) {
  return mutateHistory(history => {
    const meeting = history.find(m => m.id === id);
    if (!meeting || meeting.endedAt || meeting.liveAt === at) return { save: false, value: null };
    meeting.liveAt = at;
    return { value: meeting };
  });
}

/**
 * End meetings nothing got to end. Every session still open is closed at the last moment tracking
 * was known to be running, and the record is marked ended — otherwise it reads as in progress and
 * its hours grow with the clock until it is four hours stale. Returns the ids that changed.
 *
 * Which meetings those are is the caller's judgement: it is the one that can see whether a call is
 * still on screen somewhere.
 */
export async function endInterruptedMeetings(ids) {
  const wanted = new Set(ids || []);
  if (!wanted.size) return [];

  return mutateHistory(history => {
    const closed = [];
    history.forEach(meeting => {
      if (!wanted.has(meeting.id) || meeting.endedAt) return;
      const at = new Date(lastActivityMs(meeting) || Date.parse(meeting.date) || Date.now()).toISOString();
      const attendance = meeting.attendance || {};
      for (const name in attendance) {
        const a = attendance[name] || {};
        if (!Array.isArray(a.events) || !a.events.length) continue; // nothing to close it from
        attendance[name] = deriveAttendee({
          email: a.email, mergedFrom: a.mergedFrom, events: closeOpenEvents(a.events, at)
        });
      }
      meeting.endedAt = at;
      closed.push(meeting.id);
    });
    return { save: closed.length > 0, value: closed };
  });
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

  return mutateHistory(history => {
    const meeting = history.find(m => m.id === meetingId);
    if (!meeting) return { save: false, value: null };

    const key = normName(from);
    const merged = Object.keys(meeting.attendance || {})
      .some(n => normName(n) !== key && normName(n) === normName(to));

    // Flatten chains at write time: aliases that pointed at the old name follow it.
    const nameMap = { ...(meeting.nameMap || {}) };
    for (const k in nameMap) if (normName(nameMap[k]) === key) nameMap[k] = to;
    nameMap[key] = to;

    meeting.nameMap = nameMap;
    return { value: { meeting, merged } };
  });
}

/**
 * Undo a merge: drop every alias that resolves to `displayName`, so the entries folded into
 * that person appear under their own scraped names again. An alias that only restyles the
 * same name (a rename, "edyta tatara" → "EDYTA TATARA") is kept — that is not what the merge
 * added, and dropping it would undo an unrelated edit. Returns { meeting, restored } or null.
 */
export async function unmergeParticipant(meetingId, displayName) {
  return mutateHistory(history => {
    const meeting = history.find(m => m.id === meetingId);
    if (!meeting || !meeting.nameMap) return { save: false, value: null };

    const target = normName(displayName);
    const kept = {};
    const restored = [];
    for (const key in meeting.nameMap) {
      const landsHere = normName(resolveMappedName(key, meeting.nameMap)) === target;
      if (landsHere && key !== target) restored.push(key);
      else kept[key] = meeting.nameMap[key];
    }
    if (!restored.length) return { save: false, value: null };

    if (Object.keys(kept).length) meeting.nameMap = kept; else delete meeting.nameMap;
    return { value: { meeting, restored } };
  });
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
  return mutateHistory(history => {
    const meeting = history.find(m => m.id === meetingId);
    if (!meeting) return { save: false, value: null };
    writeSchedule(meeting, start, end);
    return { value: meeting };
  });
}

/**
 * Fill in hours detected from the calendar event. Only fills blanks — a value already
 * on the record (typically the user's own edit) always wins.
 */
export async function applyDetectedSchedule(meetingId, { start = null, end = null } = {}) {
  if (!start && !end) return null;
  return mutateHistory(history => {
    const meeting = history.find(m => m.id === meetingId);
    if (!meeting || meeting.scheduledStart || meeting.scheduledEnd) return { save: false, value: null };
    writeSchedule(meeting, start, end);
    return { value: meeting };
  });
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
  await mutateHistory(history => {
    let changed = 0;
    history.forEach(m => { if (m.groupId === id) { delete m.groupId; changed++; } });
    return { save: changed > 0, value: changed };
  });
  return true;
}

export async function assignMeetingToGroup(meetingId, groupId) {
  return mutateHistory(history => {
    const m = history.find(x => x.id === meetingId);
    if (m) { if (groupId) m.groupId = groupId; else delete m.groupId; }
    return { save: !!m, value: !!m };
  });
}

/** Assign many meetings at once (used by "group this series"). */
export async function assignMeetingsToGroup(meetingIds, groupId) {
  const ids = new Set(meetingIds || []);
  return mutateHistory(history => {
    history.forEach(m => { if (ids.has(m.id)) { if (groupId) m.groupId = groupId; else delete m.groupId; } });
    return { value: true };
  });
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

/**
 * When the spreadsheet and this store last agreed, and whether a pass is running right now. Kept
 * out of `settings` because neither is a preference: they are what the sync schedule reads to
 * decide whether a pass is due and whether it is this context's to run.
 */
export async function getSyncState() {
  const s = await get(STORAGE_KEYS.SYNC_STATE);
  return (s && typeof s === 'object') ? s : {};
}
export async function setSyncState(patch) {
  const next = { ...(await getSyncState()), ...patch };
  await set(STORAGE_KEYS.SYNC_STATE, next);
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
    STORAGE_KEYS.SCHEMA_VERSION, STORAGE_KEYS.LEGACY_MEETINGS, STORAGE_KEYS.GROUPS
  ]);

  if ((stored[STORAGE_KEYS.SCHEMA_VERSION] || 0) >= SCHEMA_VERSION) return { migrated: 0 };

  // Through the same guarded write as everything else: an update fires this off while the worker
  // is already putting interrupted meetings to bed, and a rewrite of the whole register is the
  // one write that could not afford to lose the other.
  const migrated = await mutateHistory(history => {
    let count = 0;
    const legacy = stored[STORAGE_KEYS.LEGACY_MEETINGS];
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
      const ids = new Set(history.map(m => m.id));
      for (const key in legacy) {
        const rec = buildMeetingRecord(legacy[key]);
        if (!ids.has(rec.id)) { history.push(rec); ids.add(rec.id); count++; }
      }
    }
    return {
      list: history.map(m => normalizeMeeting(unbakeMerges(m), { mergeAliases: false }))
        .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)),
      value: count
    };
  });

  const groups = Array.isArray(stored[STORAGE_KEYS.GROUPS]) ? stored[STORAGE_KEYS.GROUPS] : [];
  await setMany({
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
