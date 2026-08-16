/**
 * Attendance core — the pure derivation the whole app reads from.
 *
 * These cover the tab-reload path in particular: the content script starts over on every page
 * load, so what it reports has to be folded into what the tab reported before it. And the paths
 * where nothing got a chance to report at all: the browser closed on the call, or the extension
 * was switched off under it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as attendance from '../src/lib/attendance.js';
import {
  mergeRawParticipants, deriveAttendee, presenceSeconds, sessionsFromEvents,
  closeOpenEvents, closeOpenParticipants, lastActivityMs, hasEventsAfter,
  meetingState, isLive, meetingDurationSeconds, measuredStartMs, meetingStartMs,
  sharePct, makeSessionId, sessionStartMs
} from '../src/lib/attendance.js';

const at = (hhmm) => `2026-08-14T${hhmm}:00.000Z`;
const join = (hhmm) => ({ time: at(hhmm), type: 'Join' });
const leave = (hhmm) => ({ time: at(hhmm), type: 'Leave' });
const person = (events, extra = {}) => ({ name: 'x', email: null, isPresent: true, events, ...extra });
const END = Date.parse(at('11:00'));

test('a reload keeps the presence recorded before it', () => {
  const held = { Anna: person([join('10:00')]) };
  const fresh = { Anna: person([join('10:30')]) };   // the page rescanned from scratch

  const merged = mergeRawParticipants(held, fresh);
  const anna = deriveAttendee(merged.Anna);

  assert.equal(presenceSeconds(anna, END), 60 * 60, 'the whole hour, not just the part after the reload');
  assert.equal(anna.sessions.length, 1, 'the hand-off reads as one continuous session');
  assert.equal(anna.present, true);
});

test('a normal update inside one page load adds nothing twice', () => {
  const held = { Anna: person([join('10:00')]) };
  const fresh = { Anna: person([join('10:00'), leave('10:20')], { isPresent: false }) };

  const merged = mergeRawParticipants(held, fresh);

  assert.deepEqual(merged.Anna.events, [join('10:00'), leave('10:20')]);
  assert.equal(merged.Anna.isPresent, false, 'the fresh scan is what says who is in the call now');
  assert.equal(deriveAttendee(merged.Anna).totalSeconds, 20 * 60);
});

test('merging the same scan twice changes nothing', () => {
  const held = { Anna: person([join('10:00')]) };
  const fresh = { Anna: person([join('10:30')]) };

  const once = mergeRawParticipants(held, fresh);
  const twice = mergeRawParticipants(once, fresh);

  assert.deepEqual(twice.Anna.events, once.Anna.events);
});

test('a closed stream is picked up again as a second session', () => {
  const held = { Anna: person([join('10:00'), leave('10:20')], { isPresent: false }) };
  const fresh = { Anna: person([join('10:30')]) };

  const anna = deriveAttendee(mergeRawParticipants(held, fresh).Anna);

  assert.equal(anna.sessions.length, 2);
  assert.equal(presenceSeconds(anna, END), 50 * 60);
});

test('someone the reloaded page no longer sees is closed out, not left in the call', () => {
  const held = { Anna: person([join('10:00')]), Bob: person([join('10:00')]) };
  const fresh = { Anna: person([join('10:30')]) };   // Bob left while the tab was reloading

  const merged = mergeRawParticipants(held, fresh);
  const bob = deriveAttendee(merged.Bob);

  assert.equal(bob.present, false);
  assert.equal(bob.totalSeconds, 30 * 60, 'counted up to the moment the page picked the call back up');
  assert.equal(deriveAttendee(merged.Anna).present, true);
});

test('a participant only this scan knows about is carried over as is', () => {
  const merged = mergeRawParticipants({}, { Cara: person([join('10:05')]) });
  assert.deepEqual(merged.Cara.events, [join('10:05')]);
});

test('an e-mail learned by either scan survives the merge', () => {
  const held = { Anna: person([join('10:00')], { email: 'anna@example.com' }) };
  const fresh = { Anna: person([join('10:30')], { email: null }) };

  assert.equal(mergeRawParticipants(held, fresh).Anna.email, 'anna@example.com');
});

test('unusable events are dropped rather than poisoning the stream', () => {
  const held = { Anna: person([join('10:00'), { time: 'not a date', type: 'Leave' }, null]) };
  const fresh = { Anna: person([join('10:30')]) };

  const events = mergeRawParticipants(held, fresh).Anna.events;
  assert.ok(events.every(e => e && !Number.isNaN(Date.parse(e.time))));
  assert.equal(sessionsFromEvents(events).length, 1);
});

/* ---- what a recovery has to work from ---- */

test('a meeting nobody closed ends where tracking was last known to be running', () => {
  const anna = deriveAttendee({ events: closeOpenEvents([join('10:00')], at('10:45')) });

  assert.equal(anna.present, false, 'nobody is left standing inside the call');
  assert.equal(anna.totalSeconds, 45 * 60, 'the quiet stretch after the last join still counts');
});

test('a watermark behind the last event cannot close a session before its join', () => {
  const events = closeOpenEvents([join('10:00'), leave('10:20'), join('10:30')], at('10:10'));

  assert.equal(deriveAttendee({ events }).totalSeconds, 20 * 60, 'the second session is empty, not negative');
  assert.equal(sessionsFromEvents(events).length, 2);
});

test('a stream that already ended is left exactly as it is', () => {
  const events = [join('10:00'), leave('10:20')];
  assert.deepEqual(closeOpenEvents(events, at('10:45')), events);
});

test('closing a meeting leaves nobody in the call, whoever was still in it', () => {
  const closed = closeOpenParticipants({
    Anna: person([join('10:00')]),
    Bob: person([join('10:00'), leave('10:15')], { isPresent: false })
  }, at('10:45'));

  assert.equal(closed.Anna.isPresent, false);
  assert.equal(deriveAttendee(closed.Anna).totalSeconds, 45 * 60);
  assert.equal(deriveAttendee(closed.Bob).totalSeconds, 15 * 60, 'someone who had left keeps their own time');
});

/* ---- what may undo an end ----
 * A scan is still on its way to the worker when the call finishes, and a record is written from
 * whatever the page last reported. What that write shows is the only thing that can tell the
 * call coming back from a message that was simply late.
 */

test('a rejoin after the end is the call coming back', () => {
  const meeting = { attendance: { Anna: deriveAttendee({ events: [join('10:00'), leave('10:20'), join('10:22')] }) } };

  assert.equal(hasEventsAfter(meeting, at('10:20')), true);
});

test('a scan that was merely late carries nothing after the end', () => {
  const meeting = { attendance: { Anna: deriveAttendee({ events: [join('10:00'), leave('10:20')] }) } };

  assert.equal(hasEventsAfter(meeting, at('10:20')), false, 'the closing Leave is the end, not something after it');
  assert.equal(hasEventsAfter({ attendance: {} }, at('10:20')), false, 'and an empty scan says nothing at all');
});

test('with no end to protect, anything goes', () => {
  const meeting = { attendance: { Anna: deriveAttendee({ events: [join('10:00')] }) } };

  assert.equal(hasEventsAfter(meeting, null), true);
});

test('the watermark is what a quiet call is known by', () => {
  const meeting = { date: at('10:00'), attendance: { Anna: deriveAttendee({ events: [join('10:00')] }) } };

  assert.equal(lastActivityMs(meeting), Date.parse(at('10:00')), 'without one, the last join is all there is');
  assert.equal(lastActivityMs({ ...meeting, liveAt: at('10:45') }), Date.parse(at('10:45')));
});

/* ---- what the panel is allowed to call a meeting ----
 * These are about a record nobody closed, which looks exactly like a call in progress from the
 * inside: everyone is still standing in it. Only the last sign of life tells the two apart, so
 * the state is read against the clock rather than against presence.
 */

const NOW = Date.now();
const minsAgo = (mins) => new Date(NOW - mins * 60000).toISOString();
const joinedAgo = (mins) => deriveAttendee({ events: [{ time: minsAgo(mins), type: 'Join' }] });

test('a call that reported in a moment ago is live', () => {
  const meeting = { date: minsAgo(30), liveAt: minsAgo(0.5), attendance: { Anna: joinedAgo(30) } };

  assert.equal(meetingState(meeting), 'live');
});

test('a call nothing has reported into for minutes is unfinished, not live', () => {
  const meeting = { date: minsAgo(90), liveAt: minsAgo(45), attendance: { Anna: joinedAgo(90) } };

  assert.equal(meetingState(meeting), 'unfinished', 'the browser went away with it — nobody can say it is running');
  assert.equal(isLive(meeting), false);
});

test('a call nothing ended stops growing at its last sign of life', () => {
  const meeting = { date: minsAgo(90), liveAt: minsAgo(45), attendance: { Anna: joinedAgo(90) } };

  assert.equal(meetingDurationSeconds(meeting), 45 * 60, 'not the hour and a half the wall clock has run');
});

test('a record that carries an end is settled, whoever it left standing in the call', () => {
  const meeting = { date: minsAgo(90), endedAt: minsAgo(30), liveAt: minsAgo(30), attendance: { Anna: joinedAgo(90) } };

  assert.equal(meetingState(meeting), 'ended');
});

test('the moment between the last person leaving and the end arriving is not called unfinished', () => {
  const anna = deriveAttendee({ events: [{ time: minsAgo(60), type: 'Join' }, { time: minsAgo(1), type: 'Leave' }] });
  const meeting = { date: minsAgo(60), liveAt: minsAgo(0.2), attendance: { Anna: anna } };

  assert.equal(meetingState(meeting), 'ended', 'the page is still reporting; the end is on its way');
});

test('a record imported with everyone still in the call is unfinished', () => {
  const meeting = { date: minsAgo(3 * 24 * 60), attendance: { Anna: joinedAgo(3 * 24 * 60) } };

  assert.equal(meetingState(meeting), 'unfinished', 'no end, and no sign of life since the day it was recorded');
});

/* ---- hours that have not arrived yet ----
 * A meeting keeps the hours it was scheduled for, and joining early must not stretch them. But
 * people do gather before the hour, and until it comes those hours are ahead of the clock: measured
 * from them, a call with five people in it has been going for no time and nobody has attended any
 * of it.
 */

const inMins = (mins) => new Date(NOW + mins * 60000).toISOString();

test('a call joined before its hour is measured from when it was joined', () => {
  const meeting = {
    date: minsAgo(10), liveAt: minsAgo(0.2), scheduledStart: inMins(5), scheduledEnd: inMins(65),
    attendance: { Anna: joinedAgo(10) }
  };

  assert.equal(isLive(meeting), true);
  assert.equal(meetingStartMs(meeting), Date.parse(inMins(5)), 'the hours themselves are untouched');
  assert.equal(measuredStartMs(meeting), Date.parse(minsAgo(10)), 'the clock counts from the gathering');
  assert.ok(meetingDurationSeconds(meeting) >= 10 * 60 - 1, 'not nothing, which is what it read before');
  assert.ok(sharePct(meeting.attendance.Anna, meeting) > 90, 'and the share of it is not nothing either');
});

test('once the hour has come, the meeting is measured from it', () => {
  const meeting = {
    date: minsAgo(70), liveAt: minsAgo(0.2), scheduledStart: minsAgo(60), scheduledEnd: inMins(5),
    attendance: { Anna: joinedAgo(70) }
  };

  assert.equal(measuredStartMs(meeting), Date.parse(minsAgo(60)), 'the ten minutes of gathering are not the meeting');
  assert.ok(Math.abs(meetingDurationSeconds(meeting) - 60 * 60) <= 1);
});

test('a start pinned after the meeting ended does not leave it with no length', () => {
  const meeting = {
    date: minsAgo(180), endedAt: minsAgo(120), scheduledStart: minsAgo(60),
    attendance: { Anna: deriveAttendee({ events: [
      { time: minsAgo(180), type: 'Join' }, { time: minsAgo(120), type: 'Leave' }
    ] }) }
  };

  assert.equal(meetingDurationSeconds(meeting), 60 * 60, 'the hour it was actually seen to run');
});

test('presence is clipped to both sides of the scheduled meeting', () => {
  const anna = deriveAttendee({ events: [join('09:00'), leave('11:00')] });
  const meeting = {
    date: at('09:00'), endedAt: at('11:00'),
    scheduledStart: at('09:30'), scheduledEnd: at('10:30'),
    attendance: { Anna: anna }
  };

  assert.equal(attendance.liveSecondsFor(anna, meeting), 60 * 60);
  assert.equal(presenceSeconds(anna, Date.parse(at('10:30')), Date.parse(at('09:30'))), 60 * 60);
  assert.equal(sharePct(anna, meeting), 100);
});

test('sessions wholly outside the meeting count as zero', () => {
  const before = deriveAttendee({ events: [join('08:00'), leave('09:00')] });
  const after = deriveAttendee({ events: [join('11:00'), leave('12:00')] });
  const startMs = Date.parse(at('09:30'));
  const endMs = Date.parse(at('10:30'));

  assert.equal(attendance.boundedSessionSeconds(before.sessions[0], startMs, endMs), 0);
  assert.equal(attendance.boundedSessionSeconds(after.sessions[0], startMs, endMs), 0);
});

test('an open session is clipped at both meeting bounds', () => {
  const open = deriveAttendee({ events: [join('09:00')] });
  const meeting = {
    date: at('09:00'), endedAt: at('11:00'),
    scheduledStart: at('09:30'), scheduledEnd: at('10:30'),
    attendance: { Anna: open }
  };

  assert.equal(attendance.liveSecondsFor(open, meeting), 60 * 60);
});

test('a timeline boundary touch has no visible segment', () => {
  const startMs = Date.parse(at('09:30'));
  const endMs = Date.parse(at('10:30'));
  const span = endMs - startMs;

  assert.equal(attendance.timelineSegmentBox(Date.parse(at('09:00')), startMs, startMs, endMs, span), null);
  assert.equal(attendance.timelineSegmentBox(endMs, Date.parse(at('11:00')), startMs, endMs, span), null);
  assert.deepEqual(
    attendance.timelineSegmentBox(startMs, startMs + 1000, startMs, endMs, span),
    { left: 0, width: 0.6 }
  );
});

test('a session id says when it began, and an id from anywhere else does not', () => {
  assert.equal(sessionStartMs(makeSessionId('abc-defg-hij', 1786824000000)), 1786824000000);
  assert.ok(Number.isNaN(sessionStartMs('imported-from-somewhere')));
  assert.ok(Number.isNaN(sessionStartMs(null)));
});
