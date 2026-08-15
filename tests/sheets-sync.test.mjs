/**
 * What a sync pass decides, before any of it reaches a spreadsheet.
 *
 * The whole promise of the sheet as a backup rests on these two functions producing additions and
 * nothing else: a record this store lost must still be up there, and a record the sheet carries
 * must survive whatever happens here. So the cases worth pinning down are the ones where a naive
 * "make both sides match" would delete something.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { incoming, outgoing } from '../src/lib/sheets-sync.js';
import { makeSessionId } from '../src/lib/attendance.js';

const ended = (id) => ({ id, date: '2026-08-14T09:00:00.000Z', endedAt: '2026-08-14T10:00:00.000Z' });
const running = (id) => ({ id, date: '2026-08-14T09:00:00.000Z' });
const series = (id) => ({ id, name: 'Tuesday standup', roster: [] });
/** The Backup tab as `readBackupIndex` reports it: kind and id, with the row each sits on. */
const index = (...rows) => rows.map(([kind, id], i) => ({ kind, id, row: i + 2 }));

const ids = (list) => list.map(r => r.id);

/* ---------------------------- what comes back from the sheet ---------------------------- */

test('a meeting only the sheet has is worth reading back', () => {
  const wanted = incoming({ index: index(['meeting', 'm-1'], ['meeting', 'm-2']), history: [ended('m-1')] });
  assert.deepEqual(ids(wanted), ['m-2']);
  assert.equal(wanted[0].row, 3, 'the row it sits on travels with it, so only that row is read');
});

test('a meeting in the trash is not brought back by the copy the sheet keeps', () => {
  const wanted = incoming({ index: index(['meeting', 'm-1']), history: [], trash: [ended('m-1')] });
  assert.deepEqual(wanted, [], 'a deletion here is not undone by the backup');
});

test('a series the sheet has and this store does not comes with it', () => {
  const wanted = incoming({
    index: index(['series', 'grp-1'], ['series', 'grp-2']), groups: [series('grp-1')]
  });
  assert.deepEqual(ids(wanted), ['grp-2']);
});

test('a row of a kind we do not write is left where it is', () => {
  assert.deepEqual(incoming({ index: index(['note', 'x-1']) }), []);
});

/* ---- and what a full register does not ask for ----
 * "Meetings to keep" drops the oldest whenever a newer one is written. Reading one of those back
 * would hand it straight to the next write to drop again, and every pass from then on would fetch
 * the same records to lose them again.
 */

const day = (n) => Date.UTC(2026, 7, n, 9);
const dated = (n) => ({ id: makeSessionId('abc-defg-hij', day(n)), date: new Date(day(n)).toISOString() });

test('a full register does not ask for meetings it would only drop again', () => {
  const wanted = incoming({
    index: index(['meeting', dated(10).id], ['meeting', dated(20).id]),
    history: [dated(15), dated(14)], cap: 2
  });

  assert.deepEqual(ids(wanted), [dated(20).id], 'the newer one is worth having; the older one would not survive');
});

test('a register under its cap takes everything the sheet has', () => {
  const wanted = incoming({
    index: index(['meeting', dated(10).id]), history: [dated(15)], cap: 2
  });

  assert.deepEqual(ids(wanted), [dated(10).id], 'there is room for it, so the cap has nothing to say');
});

test('raising the cap brings the older meetings home', () => {
  const held = [dated(15), dated(14)];
  assert.deepEqual(ids(incoming({ index: index(['meeting', dated(10).id]), history: held, cap: 2 })), []);
  assert.deepEqual(ids(incoming({ index: index(['meeting', dated(10).id]), history: held, cap: 100 })),
    [dated(10).id], 'the same sheet, the same register, a setting that now has room');
});

test('a record whose id does not say when it started is read back', () => {
  const wanted = incoming({
    index: index(['meeting', 'imported-from-somewhere']), history: [dated(15), dated(14)], cap: 2
  });

  assert.deepEqual(ids(wanted), ['imported-from-somewhere'], 'unknown is not old');
});

/* ------------------------------ what goes up to the sheet ------------------------------ */

test('a finished meeting the sheet has not got goes up', () => {
  const out = outgoing({ index: index(['meeting', 'm-1']), history: [ended('m-1'), ended('m-2')] });
  assert.deepEqual(ids(out.meetings), ['m-2']);
});

test('a meeting the sheet already carries is left exactly as it was sent', () => {
  const out = outgoing({ index: index(['meeting', 'm-1']), history: [ended('m-1')] });
  assert.deepEqual(out.meetings, [], 'the sheet is never written over');
  assert.equal(out.kept, 1, 'and the page can say how many it left alone');
});

test('a call still running waits for its end', () => {
  const out = outgoing({ index: [], history: [ended('m-1'), running('m-2')] });
  assert.deepEqual(ids(out.meetings), ['m-1']);
  assert.equal(out.running, 1, 'written mid-call it could never be corrected, since it is written once');
});

test('a call that has only just finished waits too', () => {
  // rejoining the link, or a second tab still in the call, brings a record like this straight back
  const justNow = { id: 'm-1', date: new Date().toISOString(), endedAt: new Date().toISOString() };
  const out = outgoing({ index: [], history: [justNow] });

  assert.deepEqual(out.meetings, [], 'the sheet cannot take back half a call it was handed early');
  assert.equal(out.running, 1);
});

test('a series is sent once and then left alone, however it is renamed here', () => {
  const groups = [{ ...series('grp-1'), name: 'Renamed here' }, series('grp-2')];
  const out = outgoing({ index: index(['series', 'grp-1']), groups });
  assert.deepEqual(ids(out.groups), ['grp-2']);
  assert.equal(out.keptGroups, 1);
});

test('what the sheet holds and this store has never seen changes nothing about the way out', () => {
  const out = outgoing({ index: index(['meeting', 'from-another-machine']), history: [ended('m-1')] });
  assert.deepEqual(ids(out.meetings), ['m-1']);
  assert.equal(out.kept, 0, 'a record only the sheet has is not this store\'s business to count');
});

test('a store with nothing in it proposes nothing at all', () => {
  const out = outgoing({ index: index(['meeting', 'm-1'], ['series', 'grp-1']) });
  assert.deepEqual(out.meetings, []);
  assert.deepEqual(out.groups, []);
  assert.equal(out.kept + out.keptGroups + out.running, 0,
    'an empty register after a reinstall asks the sheet for nothing and takes nothing from it');
});
