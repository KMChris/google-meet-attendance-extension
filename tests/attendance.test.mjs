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
import {
  mergeRawParticipants, deriveAttendee, presenceSeconds, sessionsFromEvents,
  closeOpenEvents, closeOpenParticipants, lastActivityMs
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

test('the watermark is what a quiet call is known by', () => {
  const meeting = { date: at('10:00'), attendance: { Anna: deriveAttendee({ events: [join('10:00')] }) } };

  assert.equal(lastActivityMs(meeting), Date.parse(at('10:00')), 'without one, the last join is all there is');
  assert.equal(lastActivityMs({ ...meeting, liveAt: at('10:45') }), Date.parse(at('10:45')));
});
