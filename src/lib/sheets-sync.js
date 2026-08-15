/**
 * Keeping the spreadsheet and the local register in step, in both directions.
 *
 * The sheet is the one place two machines (or the same machine reinstalled) meet, so a pass is
 * symmetrical: meetings the sheet has and this store does not are read back, meetings this store
 * has and the sheet does not are appended.
 *
 * Every direction only ever adds. Nothing here removes a record from this store, and nothing here
 * removes or rewrites a record in the sheet — including the two deliberate acts, "Send everything"
 * and "Restore from the sheet", which are the same rule run over everything rather than over what
 * is new. That is what makes a spreadsheet a backup worth the name: once a meeting is up there it
 * survives this machine being cleared, reinstalled or emptied by mistake. The price is that the
 * copy in the sheet is the version that was sent, and only Google Sheets can change or drop it;
 * a sheet nobody wants to touch is replaced by starting a new one.
 *
 * When a pass runs is a schedule rather than a timer, because freshness only matters where the
 * data is about to be read or written:
 *   - right after a meeting ends: the record is new and the call is over,
 *   - when the dashboard is opened, at most every OPEN_INTERVAL_MS,
 *   - when the worker wakes, at most every BACKGROUND_INTERVAL_MS.
 * A pass with nothing to do is one short read (two columns of the Backup tab), so firing often
 * costs little; the throttle is what keeps a reload or a busy worker from repeating it.
 *
 * Policy lives here. sheets-api.js stays the transport and storage.js stays the store.
 */

import * as storage from './storage.js';
import * as api from './sheets-api.js';

export const OPEN_INTERVAL_MS = 5 * 60 * 1000;
export const BACKGROUND_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * What the sheet holds and this store does not: the backup rows worth reading back. A meeting in
 * the trash counts as held, so a deletion is not undone by the copy the sheet still carries.
 *
 * Pure, and so is `outgoing` — between them they are the whole of what a pass decides, and what
 * they never produce is an instruction to remove anything.
 */
export function incoming({ index = [], history = [], trash = [], groups = [] } = {}) {
  const here = new Set([...history.map(m => m.id), ...trash.map(m => m.id)]);
  const mine = new Set(groups.map(g => g.id));
  return index.filter(r => r.kind === 'meeting' ? !here.has(r.id)
    : (r.kind === 'series' && !mine.has(r.id)));
}

/**
 * What this store holds and the sheet does not. Only meetings that ended, because a call still
 * running would be written once and never corrected — and never written again, since an id the
 * sheet already carries is left alone from then on.
 *
 * Counts what it left behind as well as what it takes, so the caller can say so: skipping is the
 * rule working, and it is worth being told about when a whole register was just sent.
 */
export function outgoing({ index = [], history = [], groups = [] } = {}) {
  const remoteMeetings = new Set(), remoteSeries = new Set();
  index.forEach(r => {
    if (r.kind === 'meeting') remoteMeetings.add(r.id);
    else if (r.kind === 'series') remoteSeries.add(r.id);
  });

  const ended = history.filter(m => m.endedAt);
  const meetings = ended.filter(m => !remoteMeetings.has(m.id));
  const series = groups.filter(g => !remoteSeries.has(g.id));
  return {
    meetings, groups: series,
    kept: ended.length - meetings.length,
    keptGroups: groups.length - series.length,
    running: history.length - ended.length
  };
}

/** One two-way pass over a spreadsheet. Returns what moved, in each direction. */
export async function syncNow(spreadsheetId) {
  const [history, trash, groups] = await Promise.all([
    storage.getHistory(), storage.getTrash(), storage.getGroups()
  ]);
  const index = await api.readBackupIndex(spreadsheetId);

  const wanted = incoming({ index, history, trash, groups });
  let pulled = 0, pulledGroups = 0;
  if (wanted.length) {
    const back = await api.readBackupRecords(spreadsheetId, wanted.map(r => r.row));
    pulledGroups = await storage.mergeGroups(back.groups);   // series first: a meeting may name one
    pulled = await storage.mergeMeetings(back.meetings);
  }

  const out = outgoing({ index, history, groups });
  if (out.meetings.length || out.groups.length) await api.appendRecords(spreadsheetId, out);

  await storage.setSyncState({ lastSyncAt: new Date().toISOString() });
  return { pulled, pulledGroups, pushed: out.meetings.length, pushedGroups: out.groups.length };
}

/**
 * "Send everything": the whole register offered to the sheet at once, rather than the meetings
 * one pass happens to find new. What the sheet already has stays exactly as it was sent, so this
 * cannot be used to bring the sheet back in line with this machine — it can only ever fill it in.
 * The counts say what was left as it was, which is what the page then offers advice about.
 */
export async function pushEverything(spreadsheetId) {
  const [history, groups] = await Promise.all([storage.getHistory(), storage.getGroups()]);
  const index = await api.readBackupIndex(spreadsheetId);

  const out = outgoing({ index, history, groups });
  if (out.meetings.length || out.groups.length) await api.appendRecords(spreadsheetId, out);

  return {
    pushed: out.meetings.length, pushedGroups: out.groups.length,
    kept: out.kept, keptGroups: out.keptGroups, running: out.running
  };
}

/**
 * "Restore from the sheet": every record the sheet holds, of which only the ones this store has
 * never seen are added. A meeting already here keeps whatever was edited about it, and one in the
 * trash stays deleted — a backup that still carries it must not undo the deletion.
 *
 * Which of the two a record was skipped for is counted separately, because there is something to
 * do about the second (the trash) and nothing to do about the first.
 */
export async function pullEverything(spreadsheetId) {
  const { meetings, groups } = await api.restoreAll(spreadsheetId);
  const [history, trash] = await Promise.all([storage.getHistory(), storage.getTrash()]);
  const here = new Set(history.map(m => m.id));
  const deleted = new Set(trash.map(m => m.id));

  const pulledGroups = await storage.mergeGroups(groups);    // series first: a meeting may name one
  const pulled = await storage.mergeMeetings(meetings);

  return {
    found: meetings.length + groups.length,
    pulled, pulledGroups,
    kept: meetings.filter(m => here.has(m.id)).length,
    trashed: meetings.filter(m => deleted.has(m.id)).length,
    keptGroups: groups.length - pulledGroups
  };
}

/**
 * The scheduled entry point: does nothing unless auto-sync is on, a sheet is linked, the account
 * is still connected and the last pass is older than `maxAgeMs`. Returns null when it stayed out
 * of the way.
 *
 * It never asks for a sign-in. A grant that has lapsed is left to the settings page, where the
 * user can see what is being asked instead of a window appearing on its own.
 */
export async function autoSync({ maxAgeMs = BACKGROUND_INTERVAL_MS, force = false } = {}) {
  const settings = await storage.getSettings();
  if (!settings.autoSync || !settings.spreadsheetId) return null;

  if (!force) {
    const { lastSyncAt } = await storage.getSyncState();
    if (Date.now() - (Date.parse(lastSyncAt) || 0) < maxAgeMs) return null;
  }
  if (!(await api.isAuthenticated())) return null;

  return syncNow(settings.spreadsheetId);
}
