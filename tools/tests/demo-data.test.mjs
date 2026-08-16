import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeMeeting, sharePct } from '../../src/lib/attendance.js';

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = join(here, '..', 'demo-data.mjs');

async function loadGenerator() {
  assert.ok(existsSync(modulePath), 'demo-data.mjs should exist');
  return import(pathToFileURL(modulePath));
}

test('demo data generator module exists', () => {
  assert.ok(existsSync(modulePath), 'demo-data.mjs should exist');
});

test('demo data has the store showcase contract', async () => {
  const { buildDemoData } = await loadGenerator();
  assert.equal(typeof buildDemoData, 'function');

  const demo = buildDemoData(new Date('2026-08-14T10:00:00.000Z'));
  assert.equal(demo.history.length, 12);
  assert.equal(demo.groups.length, 3);
  assert.equal(demo.settings.theme, 'dark');
  assert.equal(demo.language, 'pl');

  const ids = demo.history.map(meeting => meeting.id);
  assert.equal(new Set(ids).size, ids.length, 'meeting ids must be unique');

  const people = new Set(
    demo.history.flatMap(meeting => Object.keys(meeting.attendance || {}))
  );
  assert.equal(people.size, 22);

  const timestamps = demo.history.map(meeting => Date.parse(meeting.date));
  assert.deepEqual(timestamps, [...timestamps].sort((a, b) => b - a));

  const entries = demo.history.flatMap(meeting => Object.values(meeting.attendance || {}));
  assert.ok(entries.some(entry => entry.events.length >= 4), 'at least one participant should rejoin');
  for (const entry of entries) {
    assert.ok(entry.events.length >= 2, 'every visible participant should have a complete session');
    entry.events.forEach((event, index) => {
      assert.equal(event.type, index % 2 === 0 ? 'Join' : 'Leave');
      assert.ok(Number.isFinite(Date.parse(event.time)));
    });
  }

  for (const group of demo.groups) {
    assert.ok(group.roster.length >= 16, 'each series should demonstrate a substantial roster');
    assert.ok(demo.history.filter(meeting => meeting.groupId === group.id).length >= 3);
  }

  const normalized = demo.history.map(normalizeMeeting);
  const shares = normalized.flatMap(meeting =>
    Object.values(meeting.attendance).map(attendee => sharePct(attendee, meeting))
  );
  const averageShare = Math.round(shares.reduce((sum, value) => sum + value, 0) / shares.length);
  assert.equal(averageShare, 91, 'headline attendance should match the promotional story');
});

test('English demo keeps the same records and localizes meeting content', async () => {
  const { buildDemoData } = await loadGenerator();
  const anchor = new Date('2026-08-14T10:00:00.000Z');
  const polish = buildDemoData(anchor);
  const english = buildDemoData(anchor, { language: 'en' });

  assert.equal(english.language, 'en');
  assert.deepEqual(
    english.history.map(meeting => meeting.id),
    polish.history.map(meeting => meeting.id),
    'localization must not change the underlying meeting set'
  );
  assert.deepEqual(
    english.groups.map(group => group.name),
    ['AI in Professional Practice', 'Team Workflow Automation', 'Digital Skills Academy']
  );
  assert.equal(
    english.history.find(meeting => meeting.id === 'demo-ai-04')?.meetingTitle,
    'Ethics and Data Safety'
  );
  assert.equal(
    english.history.find(meeting => meeting.id === 'demo-consult')?.meetingTitle,
    'Project Consultations'
  );
  assert.equal(english.settings.spreadsheetName, 'Attendance · Training 2026');
  assert.equal(english.live.title, 'Ethics and Data Safety');
});

test('sessions are named for what they covered, not numbered', async () => {
  const { buildDemoData } = await loadGenerator();
  const anchor = new Date('2026-08-14T10:00:00.000Z');

  for (const language of ['pl', 'en']) {
    const demo = buildDemoData(anchor, { language });
    const titles = demo.history.map(meeting => meeting.meetingTitle);

    assert.equal(new Set(titles).size, titles.length, `${language}: every meeting reads differently`);
    for (const title of titles) {
      assert.ok(title && title.trim().length > 3, `${language}: "${title}" is not a title`);
      assert.doesNotMatch(title, /mod[uł]{1,2}|module|\bsesja\b|\bsession\b|\d/iu,
        `${language}: "${title}" still names a number instead of a subject`);
    }

    // a series still has to read as one course rather than a dozen unrelated talks
    const ai = demo.history.filter(meeting => meeting.groupId === 'grp-ai');
    assert.equal(ai.length, 4);
    assert.ok(ai.every(meeting => !meeting.meetingTitle.includes(demo.groups[0].name)),
      `${language}: the title must not repeat the series column`);
  }
});

test('English demo casts English names over the very same attendance', async () => {
  const { buildDemoData, PEOPLE_BY_LANGUAGE } = await loadGenerator();
  const anchor = new Date('2026-08-14T10:00:00.000Z');
  const polish = buildDemoData(anchor);
  const english = buildDemoData(anchor, { language: 'en' });

  assert.equal(PEOPLE_BY_LANGUAGE.en.length, PEOPLE_BY_LANGUAGE.pl.length);
  assert.equal(new Set(PEOPLE_BY_LANGUAGE.en).size, PEOPLE_BY_LANGUAGE.en.length);
  assert.ok(PEOPLE_BY_LANGUAGE.en.every(name => /^[A-Za-z]+ [A-Za-z]+$/.test(name)),
    'English names must not carry Polish diacritics');
  assert.ok(!PEOPLE_BY_LANGUAGE.en.some(name => PEOPLE_BY_LANGUAGE.pl.includes(name)));

  // the same seats, the same joins and leaves — only the name on them changes
  polish.history.forEach((meeting, index) => {
    const twin = english.history[index];
    const seats = Object.keys(meeting.attendance);
    const twinSeats = Object.keys(twin.attendance);
    assert.equal(twinSeats.length, seats.length);
    seats.forEach((name, seat) => {
      assert.equal(PEOPLE_BY_LANGUAGE.en[PEOPLE_BY_LANGUAGE.pl.indexOf(name)], twinSeats[seat]);
      assert.deepEqual(twin.attendance[twinSeats[seat]].events, meeting.attendance[name].events);
    });
  });

  const addresses = english.history.flatMap(m => Object.values(m.attendance).map(a => a.email));
  assert.ok(addresses.every(address => /^[a-z]+\.[a-z]+@example\.com$/.test(address)),
    'English addresses should read as English names');
});

test('every published frame is named for both languages', async () => {
  const { SCREENSHOT_SPECS } = await loadGenerator();

  for (const language of ['pl', 'en']) {
    const files = SCREENSHOT_SPECS.map(spec => spec.file[language]);
    assert.ok(files.every(name => /^\d\d-[a-z0-9-]+\.jpg$/.test(name)), `${language}: odd file name`);
    assert.equal(new Set(files).size, files.length, `${language}: duplicate file name`);
    assert.deepEqual(files, [...files].sort(), `${language}: frames must be numbered in order`);
  }
});

test('capture specifications cover every tab and extra feature views', async () => {
  const { SCREENSHOT_SPECS, PROMO_SPECS } = await loadGenerator();
  assert.ok(Array.isArray(SCREENSHOT_SPECS));
  assert.ok(SCREENSHOT_SPECS.length >= 9);

  const requiredViews = ['meetings', 'groups', 'people', 'analytics', 'settings'];
  for (const view of requiredViews) {
    assert.ok(
      SCREENSHOT_SPECS.some(spec => spec.route.includes(view)),
      `missing screenshot for ${view}`
    );
  }

  assert.ok(SCREENSHOT_SPECS.some(spec => spec.route.includes('meeting=')), 'missing meeting detail');
  assert.ok(SCREENSHOT_SPECS.some(spec => spec.route.includes('group=')), 'missing series detail');
  assert.ok(SCREENSHOT_SPECS.some(spec => spec.route.includes('person=')), 'missing person expansion');
  assert.deepEqual(PROMO_SPECS, {
    small: { width: 440, height: 280 },
    marquee: { width: 1400, height: 560 }
  });
});
