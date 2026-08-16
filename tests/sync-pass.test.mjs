/**
 * An unattended pass over the spreadsheet, with more than one context trying to run it.
 *
 * The worker is told to wake twice when the browser starts, and any open dashboard runs a pass of
 * its own when it opens. Each decides what to send by reading what the sheet already has, so two
 * of them overlapping would both find the same meetings missing and both send them — and the
 * sheet is only ever added to, so a row sent twice stays there twice.
 *
 * The fake below answers every request the Sheets API would make and records the appends.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const SHEET = 'a'.repeat(30);
const MINUTE = 60 * 1000;

const store = {};
globalThis.chrome = {
  runtime: {
    lastError: null,
    getManifest: () => ({ oauth2: { client_id: 'test.apps.googleusercontent.com' } })
  },
  storage: {
    local: {
      get(keys, cb) {
        setTimeout(() => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in store) out[k] = clone(store[k]); });
          cb(out);
        }, 0);
      },
      set(obj, cb) { setTimeout(() => { Object.assign(store, clone(obj)); if (cb) cb(); }, 0); },
      remove(keys, cb) { setTimeout(() => { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete store[k]); if (cb) cb(); }, 0); }
    },
    onChanged: { addListener() {} }
  },
  identity: {
    getAuthToken(_opts, cb) { cb('token'); },
    removeCachedAuthToken(_opts, cb) { cb(); }
  }
};

/** Every request the transport makes, answered; appended sheet IDs are what the test reads. */
const appended = [];
globalThis.fetch = async (url, opts = {}) => {
  const reply = (obj) => ({ ok: true, status: 200, json: async () => obj });
  if (/\/spreadsheets\/[^/:]+:batchUpdate$/.test(url)) {
    const body = JSON.parse(opts.body);
    // a pass is not instant: a request is where two of them get the chance to overlap
    await new Promise(r => setTimeout(r, 50));
    body.requests.forEach(request => {
      if (request.appendCells) appended.push(request.appendCells.sheetId);
    });
    return reply({ replies: body.requests.map(() => ({})) });
  }
  if (/values:batchGet/.test(url)) return reply({ valueRanges: [] });
  if (/values:batchUpdate/.test(url)) return reply({});
  if (/values\/[^:]+$/.test(url)) return reply({ values: [] });      // the sheet holds nothing yet
  if (/spreadsheets\/[^/:]+$/.test(url)) {
    return reply({ sheets: ['Meetings', 'Participants', 'Backup'].map((title, i) => ({
      properties: { title, sheetId: i, gridProperties: { frozenRowCount: 1 } }
    })) });
  }
  return reply({});
};

const sync = await import('../src/lib/sheets-sync.js');

const ended = (id, endedAt) => ({
  id, meetingCode: 'abc-defg-hij', date: '2026-08-14T09:00:00.000Z', endedAt,
  meetingTitle: id, url: '', attendance: {
    Anna: { email: null, events: [{ time: '2026-08-14T09:00:00.000Z', type: 'Join' }, { time: endedAt, type: 'Leave' }] }
  }
});

function seed(extra = {}) {
  Object.keys(store).forEach(k => delete store[k]);
  appended.length = 0;
  Object.assign(store, {
    settings: { autoSync: true, spreadsheetId: SHEET },
    attendanceHistory: [ended('m-1', '2026-08-14T10:00:00.000Z')],
    ...extra
  });
}

const meetingRows = () => appended.filter(sheetId => sheetId === 0).length;

test('two automatic passes started in the same turn upload once', async () => {
  seed();

  const results = await Promise.all([
    sync.autoSync({ force: true }),
    sync.autoSync({ force: true })
  ]);

  assert.equal(results.filter(Boolean).length, 1, 'one pass owns the work');
  assert.equal(meetingRows(), 1, 'the meeting went up once');
});

test('an automatic pass stands down while a manual sync owns the work', async () => {
  seed();

  const manual = sync.syncNow(SHEET);
  const automatic = sync.autoSync({ force: true });
  const [, automaticResult] = await Promise.all([manual, automatic]);

  assert.equal(automaticResult, null);
  assert.equal(meetingRows(), 1);
});

test('an automatic pass stands down while a manual push owns the work', async () => {
  seed();

  const manual = sync.pushEverything(SHEET);
  const automatic = sync.autoSync({ force: true });
  const [, automaticResult] = await Promise.all([manual, automatic]);

  assert.equal(automaticResult, null);
  assert.equal(meetingRows(), 1);
});

test('an automatic pass stands down while a manual restore owns the work', async () => {
  seed();

  const manual = sync.pullEverything(SHEET);
  const automatic = sync.autoSync({ force: true });
  const [, automaticResult] = await Promise.all([manual, automatic]);

  assert.equal(automaticResult, null);
  assert.equal(meetingRows(), 0, 'the restore itself does not append a meeting');
});

test('a pass that comes after the first has finished still runs', async () => {
  seed();

  await sync.autoSync({ force: true });
  assert.equal(store.syncState.claimedAt, null, 'the claim is given up when the pass is over');
  appended.length = 0;
  store.attendanceHistory = [...store.attendanceHistory, ended('m-2', '2026-08-14T12:00:00.000Z')];
  await sync.autoSync({ force: true });

  assert.equal(meetingRows(), 1, 'and the meeting the sheet had not got goes up');
});

test('a stale claim from an older version does not block a pass', async () => {
  const at = Date.parse('2026-08-14T12:00:00.000Z');
  seed({ syncState: { claimedAt: new Date(at).toISOString() } });

  const result = await sync.autoSync({ force: true, now: at + MINUTE });

  assert.ok(result);
  assert.equal(meetingRows(), 1);
  assert.equal(store.syncState.claimedAt, null);
});

test('nothing runs while the schedule says the last pass is recent', async () => {
  seed({ syncState: { lastSyncAt: '2026-08-14T11:59:00.000Z' } });

  const at = Date.parse('2026-08-14T12:00:00.000Z');
  assert.equal(await sync.autoSync({ maxAgeMs: 5 * MINUTE, now: at }), null);
  assert.equal(meetingRows(), 0);
});
