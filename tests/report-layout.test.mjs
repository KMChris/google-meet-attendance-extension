import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkSessions, renderSeriesMatrices } from '../src/lib/report-layout.js';

test('thirty sessions are split into complete five-column chunks', () => {
  const sessions = Array.from({ length: 30 }, (_, index) => ({ id: `s-${index + 1}` }));
  const chunks = chunkSessions(sessions, 5);

  assert.equal(chunks.length, 6);
  assert.deepEqual(chunks.flat().map(session => session.id), sessions.map(session => session.id));
  assert.ok(chunks.every(chunk => chunk.length <= 5));
  assert.throws(() => chunkSessions(sessions, 0), RangeError);
});

test('every print chunk repeats participant and total columns', () => {
  const sessions = Array.from({ length: 12 }, (_, index) => ({ id: `s-${index + 1}` }));
  const person = {
    name: '<Anna>',
    attendedCount: 12,
    totalSeconds: 3600,
    totalShare: 50,
    perSession: Object.fromEntries(sessions.map(session => [
      session.id,
      { state: 'present', sharePct: 50 }
    ]))
  };

  const markup = renderSeriesMatrices(
    { sessions, sessionCount: sessions.length, people: [person] },
    {
      labels: {
        matrix: 'Attendance matrix',
        participant: 'Participant',
        attended: 'Attended count',
        totalTime: 'Total presence',
        totalShare: 'Total share'
      },
      formatSession: session => session.id,
      formatDuration: seconds => `${seconds}s`,
      maxColumns: 5
    }
  );

  assert.match(markup.screen, /class="report-matrix-scroll" tabindex="0"/);
  assert.equal((markup.print.match(/class="rep-matrix print-matrix"/g) || []).length, 3);
  for (const heading of ['Participant', 'Attended count', 'Total presence', 'Total share']) {
    assert.equal((markup.print.match(new RegExp(`>${heading}<`, 'g')) || []).length, 3);
  }
  assert.doesNotMatch(markup.screen + markup.print, /<Anna>/);
  assert.match(markup.screen + markup.print, /&lt;Anna&gt;/);
});
