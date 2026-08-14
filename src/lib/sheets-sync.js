/**
 * Keeping the spreadsheet and the local register in step, in both directions.
 *
 * The sheet is the one place two machines (or the same machine reinstalled) meet, so a pass is
 * symmetrical: meetings the sheet has and this store does not are read back, meetings this store
 * has and the sheet does not are appended. Neither side is ever overwritten or cleared, which is
 * what makes it safe to run unattended. Replacing the sheet wholesale stays a deliberate act:
 * that is what "Send everything" is for.
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

/** One two-way pass over a spreadsheet. Returns what moved, in each direction. */
export async function syncNow(spreadsheetId) {
  const [history, trash, groups] = await Promise.all([
    storage.getHistory(), storage.getTrash(), storage.getGroups()
  ]);
  const index = await api.readBackupIndex(spreadsheetId);

  const remoteMeetings = new Set(), remoteSeries = new Set();
  index.forEach(r => {
    if (r.kind === 'meeting') remoteMeetings.add(r.id);
    else if (r.kind === 'series') remoteSeries.add(r.id);
  });

  // in: what the sheet holds and this machine does not. A meeting in the trash counts as held,
  // so a deletion is not undone by the copy the sheet still carries.
  const here = new Set([...history.map(m => m.id), ...trash.map(m => m.id)]);
  const mine = new Set(groups.map(g => g.id));
  const wanted = index.filter(r => r.kind === 'meeting' ? !here.has(r.id)
    : (r.kind === 'series' && !mine.has(r.id)));

  let pulled = 0, pulledGroups = 0;
  if (wanted.length) {
    const back = await api.readBackupRecords(spreadsheetId, wanted.map(r => r.row));
    pulledGroups = await storage.mergeGroups(back.groups);   // series first: a meeting may name one
    pulled = await storage.mergeMeetings(back.meetings);
  }

  // out: what this machine holds and the sheet does not. Only meetings that ended, because a
  // call still running would be written once and never corrected.
  const pushMeetings = history.filter(m => m.endedAt && !remoteMeetings.has(m.id));
  const pushGroups = groups.filter(g => !remoteSeries.has(g.id));
  if (pushMeetings.length || pushGroups.length) {
    await api.appendRecords(spreadsheetId, { meetings: pushMeetings, groups: pushGroups });
  }

  await storage.setSyncState({ lastSyncAt: new Date().toISOString() });
  return { pulled, pulledGroups, pushed: pushMeetings.length, pushedGroups: pushGroups.length };
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
