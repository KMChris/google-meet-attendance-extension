/**
 * Sheets integration, the parts that are pure.
 *
 * Pointing at a spreadsheet is the step people get wrong, so what counts as a reference is
 * pinned down here: the link from the address bar has to work as well as the bare id.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpreadsheetRef, spreadsheetUrl, headerRepair, meetingRow } from '../src/lib/sheets-api.js';

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
  assert.equal(minutes, '60', 'the hour it was scheduled for, as everywhere else in the app');
});

test('a meeting with no hours of its own is the span it was tracked over', () => {
  const [, , start, end, minutes] = meetingRow({
    id: 'abc-defg-hij-2', meetingTitle: 'Ad hoc', url: '',
    date: '2026-08-14T09:00:00.000Z', endedAt: '2026-08-14T09:30:00.000Z', attendance: {}
  });

  assert.equal(start, '2026-08-14T09:00:00.000Z');
  assert.equal(end, '2026-08-14T09:30:00.000Z');
  assert.equal(minutes, '30');
});
