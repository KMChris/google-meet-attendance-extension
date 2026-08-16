import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDayCount, presetBounds } from '../src/lib/date-ranges.js';

process.env.TZ = 'Europe/Warsaw';

const key = date => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0')
].join('-');

test('a seven-day preset covers seven local dates across the spring DST change', () => {
  const { from, to } = presetBounds(7, new Date(2026, 2, 31, 12, 0, 0));

  assert.equal(key(from), '2026-03-25');
  assert.equal(key(to), '2026-03-31');
  assert.equal(calendarDayCount(from, to), 7);
});

test('a seven-day preset covers seven local dates across the autumn DST change', () => {
  const { from, to } = presetBounds(7, new Date(2026, 9, 27, 12, 0, 0));

  assert.equal(key(from), '2026-10-21');
  assert.equal(key(to), '2026-10-27');
  assert.equal(calendarDayCount(from, to), 7);
});
