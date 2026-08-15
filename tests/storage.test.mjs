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
const A = await import('../src/lib/attendance.js');

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

/* ---------------------------- the trash ---------------------------- */

test('a deletion is written out of the register and into the trash', async () => {
  const data = useStorage({
    attendanceHistory: [meeting('m-1', { attendance: { Anna: person('2026-08-14T09:00:00.000Z') } })]
  });

  assert.equal(await store.deleteMeetingById('m-1'), true);
  await idle();

  assert.deepEqual(data.attendanceHistory, []);
  assert.deepEqual(data.trashedMeetings.map(m => m.id), ['m-1']);
  assert.ok(data.trashedMeetings[0].deletedAt, 'stamped with the moment it was thrown away');
});

/**
 * Both writers meant a record to go, and the one that wrote second found nothing of its own left
 * to do on what the first had written. Returning at that point left the store holding the write it
 * had already made, which had gone over the first one: the trash came back after being emptied.
 */
test('emptying the trash is not undone by a purge worked out beside it', async () => {
  const data = useStorage({
    trashedMeetings: [
      { ...meeting('m-a'), deletedAt: '2026-08-15T09:00:00.000Z' },
      { ...meeting('m-b'), deletedAt: '2026-08-15T09:00:00.000Z' }
    ]
  });

  await Promise.all([store.emptyTrash(), store.purgeMeetings(['m-a'])]);
  await idle();

  assert.deepEqual(data.trashedMeetings, [], 'the trash is empty, as both of them meant it to be');
});

test('a meeting comes back out of the trash whole', async () => {
  const data = useStorage({
    trashedMeetings: [{ ...meeting('m-1', { attendance: { Anna: person('2026-08-14T09:00:00.000Z') } }), deletedAt: '2026-08-15T09:00:00.000Z' }]
  });

  assert.equal(await store.restoreMeetings(['m-1']), 1);
  assert.deepEqual(data.trashedMeetings, []);
  assert.deepEqual(Object.keys(data.attendanceHistory[0].attendance), ['Anna']);
  assert.equal(data.attendanceHistory[0].deletedAt, undefined, 'and without the mark of having been thrown away');
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

/* ---------------------------- picking a call back up ---------------------------- */

test('a merge survives the tab being reloaded without being baked in', async () => {
  // the window a record resumes in is measured against the clock, so this one happened just now
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const data = useStorage({
    attendanceHistory: [meeting('abc-defg-hij-1000', {
      date: ago(40), liveAt: ago(1),
      nameMap: { 'jan k': 'Jan Kowalski' },
      attendance: {
        'Jan K': { email: null, events: [{ time: ago(40), type: 'Join' }, { time: ago(30), type: 'Leave' }] },
        'Jan Kowalski': { email: null, events: [{ time: ago(30), type: 'Join' }] }
      }
    })]
  });

  // what the worker does with a tab that has just come back: resume the record, fold the fresh
  // scan into it, write the whole thing out again
  const resumed = await store.findResumableSession('abc-defg-hij');
  assert.deepEqual(Object.keys(resumed.attendance).sort(), ['Jan K', 'Jan Kowalski'],
    'the two Meet identities come back as they were recorded');

  const scan = (name) => ({ name, email: null, events: [{ time: ago(0), type: 'Join' }], isPresent: true });
  await store.upsertMeeting(A.buildMeetingRecord({
    id: resumed.id, meetingCode: 'abc-defg-hij', startTime: resumed.date, meetingTitle: resumed.meetingTitle,
    participants: A.mergeRawParticipants(A.rawParticipantsFromMeeting(resumed), {
      'Jan K': scan('Jan K'), 'Jan Kowalski': scan('Jan Kowalski')
    })
  }));

  const merged = A.normalizeMeeting(data.attendanceHistory[0]).attendance['Jan Kowalski'];
  assert.equal(A.presenceSeconds(merged, Date.now()), 40 * 60, 'the person was there for the whole forty minutes');

  await store.unmergeParticipant('abc-defg-hij-1000', 'Jan Kowalski');
  const split = A.normalizeMeeting(data.attendanceHistory[0]).attendance;
  assert.equal(A.presenceSeconds(split['Jan K'], Date.now()), 10 * 60,
    'and taking the merge back hands the first ten minutes to the identity that recorded them');
});
