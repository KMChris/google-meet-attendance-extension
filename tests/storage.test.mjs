/**
 * The register with more than one writer on it.
 *
 * The dashboard, the report page and the worker all change one key, and Chrome hands none of them
 * a way to hold it still: each reads the whole array, changes it and writes it back. What these
 * pin down is that a change worked out from a copy that has since moved is not written over what
 * is there — the case being a rename made by hand while a call is being recorded into the same
 * record, which nothing would ever report again.
 *
 * The fake below is deliberately the worst of the real thing: every call takes its own turn, in
 * the order it was asked, so two writers interleave exactly where they hurt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
/** Long enough for a write to be announced and the repair it sets off to land. */
const idle = () => new Promise(resolve => setTimeout(resolve, 150));

/** chrome.storage.local, close enough: values are copied in and out, and changes are announced. */
function fakeStorage(seed = {}) {
  const data = clone(seed);
  const listeners = [];
  const later = (fn) => setTimeout(fn, 0);
  const keysOf = (k) => (Array.isArray(k) ? k : [k]);

  return {
    data,
    /** A fresh store between tests, without dropping the listeners the module registered. */
    reset(next = {}) {
      Object.keys(data).forEach(k => delete data[k]);
      Object.assign(data, clone(next));
      return data;
    },
    local: {
      get(keys, cb) {
        later(() => {
          const out = {};
          keysOf(keys).forEach(k => { if (k in data) out[k] = clone(data[k]); });
          cb(out);
        });
      },
      set(obj, cb) {
        later(() => {
          const changes = {};
          Object.entries(obj).forEach(([k, v]) => {
            changes[k] = { oldValue: clone(data[k]), newValue: clone(v) };
            data[k] = clone(v);
          });
          if (cb) cb();
          later(() => listeners.forEach(fn => fn(changes, 'local')));   // announced after the write
        });
      },
      remove(keys, cb) {
        later(() => { keysOf(keys).forEach(k => delete data[k]); if (cb) cb(); });
      }
    },
    onChanged: { addListener: (fn) => listeners.push(fn) }
  };
}

/** The shape buildMeetingRecord emits, which is what the worker writes: `endedAt` and all. */
const meeting = (id, extra = {}) => ({
  id, meetingCode: 'abc-defg-hij', date: '2026-08-14T09:00:00.000Z', endedAt: null,
  meetingTitle: id, url: '', attendance: {}, ...extra
});
const person = (joinIso) => ({ email: null, events: [{ time: joinIso, type: 'Join' }] });

globalThis.chrome = { storage: fakeStorage() };
const store = await import('../src/lib/storage.js');

const useStorage = (seed) => globalThis.chrome.storage.reset(seed);

/* ---------------------------- two writers at once ---------------------------- */

test('a rename and a live write at the same moment both survive', async () => {
  const data = useStorage({
    attendanceHistory: [meeting('m-1', { attendance: { Anna: person('2026-08-14T09:00:00.000Z') } })]
  });

  await Promise.all([
    store.setMeetingTitle('m-1', 'Monday sync'),
    // what the tracker writes a moment later, worked out from the register as it was before
    store.upsertMeeting(meeting('m-1', {
      attendance: { Anna: person('2026-08-14T09:00:00.000Z'), Bob: person('2026-08-14T09:05:00.000Z') }
    }))
  ]);
  await idle();   // the repair follows the write it repairs

  const [stored] = data.attendanceHistory;
  assert.equal(stored.meetingTitle, 'Monday sync', 'the name given by hand is still given');
  assert.deepEqual(Object.keys(stored.attendance), ['Anna', 'Bob'], 'and the call kept recording');
});

test('two edits to one meeting do not take each other back', async () => {
  const data = useStorage({ attendanceHistory: [meeting('m-1')] });

  await Promise.all([
    store.renameParticipant('m-1', 'anna k', 'Anna Kowalska'),
    store.assignMeetingToGroup('m-1', 'grp-1')
  ]);
  await idle();

  const [stored] = data.attendanceHistory;
  assert.equal(stored.nameMap['anna k'], 'Anna Kowalska');
  assert.equal(stored.groupId, 'grp-1');
});

test('a meeting written while another is being recorded joins it rather than replacing it', async () => {
  const data = useStorage({ attendanceHistory: [] });

  await Promise.all([
    store.upsertMeeting(meeting('m-1', { date: '2026-08-14T09:00:00.000Z' })),
    store.upsertMeeting(meeting('m-2', { date: '2026-08-14T11:00:00.000Z' }))
  ]);
  await idle();

  assert.deepEqual(data.attendanceHistory.map(m => m.id), ['m-2', 'm-1'], 'newest first, and both there');
});

/* ---------------------------- what a write may not undo ---------------------------- */

test('a scan that was merely late does not reopen a meeting that ended', async () => {
  const data = useStorage({
    attendanceHistory: [meeting('m-1', {
      endedAt: '2026-08-14T10:00:00.000Z',
      attendance: { Anna: { email: null, events: [
        { time: '2026-08-14T09:00:00.000Z', type: 'Join' }, { time: '2026-08-14T10:00:00.000Z', type: 'Leave' }
      ] } }
    })]
  });

  await store.upsertMeeting(meeting('m-1', { attendance: { Anna: person('2026-08-14T09:00:00.000Z') } }));

  assert.equal(data.attendanceHistory[0].endedAt, '2026-08-14T10:00:00.000Z');
});

test('a rejoin after the end brings the record back', async () => {
  const data = useStorage({
    attendanceHistory: [meeting('m-1', { endedAt: '2026-08-14T10:00:00.000Z' })]
  });

  await store.upsertMeeting(meeting('m-1', { attendance: { Anna: person('2026-08-14T10:01:00.000Z') } }));

  assert.equal(data.attendanceHistory[0].endedAt, null, 'somebody arrived after the end: the call is back');
});

/* ---------------------------- records with nothing in them ---------------------------- */

test('a link that was opened and never joined is not a meeting', async () => {
  const data = useStorage({
    attendanceHistory: [
      meeting('m-empty'),
      meeting('m-named', { titleEdited: true }),
      meeting('m-real', { attendance: { Anna: person('2026-08-14T09:00:00.000Z') } })
    ]
  });

  const gone = await store.discardEmptyMeetings(['m-empty', 'm-named', 'm-real']);

  assert.deepEqual(gone, ['m-empty']);
  assert.deepEqual(data.attendanceHistory.map(m => m.id), ['m-named', 'm-real'],
    'a record named by hand is the user\'s, whatever it holds');
});

test('nothing to drop is nothing written', async () => {
  const data = useStorage({ attendanceHistory: [meeting('m-1', { attendance: { Anna: person('2026-08-14T09:00:00.000Z') } })] });
  const before = data.attendanceHistoryRev;

  assert.deepEqual(await store.discardEmptyMeetings(['m-1']), []);
  assert.equal(data.attendanceHistoryRev, before, 'the register was left exactly as it was');
});

/* ---------------------------- the cap ---------------------------- */

test('lowering the cap trims the store, not the copy a page was holding', async () => {
  const data = useStorage({
    settings: { maxStoredMeetings: 2 },
    attendanceHistory: [
      meeting('m-3', { date: '2026-08-14T11:00:00.000Z' }),
      meeting('m-2', { date: '2026-08-14T10:00:00.000Z' }),
      meeting('m-1', { date: '2026-08-14T09:00:00.000Z' })
    ]
  });

  assert.equal(await store.trimHistoryToCap(), 1);
  assert.deepEqual(data.attendanceHistory.map(m => m.id), ['m-3', 'm-2']);
});
