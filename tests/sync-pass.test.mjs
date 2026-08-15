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

/** Every request the transport makes, answered; appends are what the test reads. */
const appended = [];
globalThis.fetch = async (url, opts = {}) => {
  const reply = (obj) => ({ ok: true, status: 200, json: async () => obj });
  if (/:append\?/.test(url)) {
    const range = decodeURIComponent(/values\/([^:]+):append/.exec(url)[1]);
    // a pass is not instant: a request is where two of them get the chance to overlap
    await new Promise(r => setTimeout(r, 50));
    appended.push(range);
    return reply({});
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

const meetingRows = () => appended.filter(r => r.startsWith('Meetings')).length;

test('a pass that starts while another is running stands down', async () => {
  seed();

  const running = sync.autoSync({ force: true });
  await new Promise(r => setTimeout(r, 40));      // it is somewhere in its requests by now
  const second = await sync.autoSync({ force: true });
  await running;

  assert.equal(second, null, 'the second pass had nothing to do that the first was not doing');
  assert.equal(meetingRows(), 1, 'and the meeting went up once');
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

test('a claim nothing gave up is not honoured for ever', async () => {
  const at = Date.parse('2026-08-14T12:00:00.000Z');
  seed({ syncState: { claimedAt: new Date(at).toISOString() } });   // a worker stopped mid-request

  assert.equal(await sync.autoSync({ force: true, now: at + MINUTE }), null, 'a pass may still be running');
  assert.equal(meetingRows(), 0);

  await sync.autoSync({ force: true, now: at + 3 * MINUTE });
  assert.equal(meetingRows(), 1, 'past the window, the next pass takes it up');
});

test('nothing runs while the schedule says the last pass is recent', async () => {
  seed({ syncState: { lastSyncAt: '2026-08-14T11:59:00.000Z' } });

  const at = Date.parse('2026-08-14T12:00:00.000Z');
  assert.equal(await sync.autoSync({ maxAgeMs: 5 * MINUTE, now: at }), null);
  assert.equal(meetingRows(), 0);
});
