import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const runtimePath = join(here, '..', 'demo-chrome.mjs');
const serverPath = join(here, '..', 'demo-server.mjs');
const sheetsPath = join(here, '..', 'demo-sheets.mjs');
const dataPath = join(here, '..', 'demo-data.mjs');
const syncPath = join(here, '..', '..', 'src', 'lib', 'sheets-sync.js');

async function load(path) {
  assert.ok(existsSync(path), `${path} should exist`);
  return import(pathToFileURL(path));
}

function call(area, method, ...args) {
  return new Promise(resolve => area[method](...args, resolve));
}

test('Chrome mock provides callback-compatible storage and live status', async () => {
  const { createChromeMock } = await load(runtimePath);
  const demo = {
    history: [{ id: 'm1' }],
    groups: [{ id: 'g1' }],
    settings: { theme: 'dark' },
    roster: ['Anna'],
    schemaVersion: 4,
    autoTrack: true,
    language: 'pl',
    live: { participantCount: 16 }
  };
  const chrome = createChromeMock(demo, { origin: 'http://127.0.0.1:4177' });

  const stored = await call(chrome.storage.local, 'get', ['attendanceHistory', 'settings']);
  assert.deepEqual(stored.attendanceHistory, demo.history);
  assert.deepEqual(stored.settings, demo.settings);

  await call(chrome.storage.local, 'set', { extra: 42 });
  assert.deepEqual(await call(chrome.storage.local, 'get', 'extra'), { extra: 42 });
  await call(chrome.storage.local, 'remove', 'extra');
  assert.deepEqual(await call(chrome.storage.local, 'get', 'extra'), {});

  assert.deepEqual(await call(chrome.storage.sync, 'get', ['rollcallLanguage']), { rollcallLanguage: 'pl' });
  assert.equal(chrome.runtime.getURL('dashboard/dashboard.html'), 'http://127.0.0.1:4177/dashboard/dashboard.html');

  const tabs = await call(chrome.tabs, 'query', { active: true, currentWindow: true });
  const status = await new Promise(resolve => chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_STATUS' }, resolve));
  assert.equal(status.isTracking, true);
  assert.equal(status.participantCount, 16);
});

test('server injects demo launchers without duplicating production pages', async () => {
  const { injectModuleEntry, contentTypeFor } = await load(serverPath);
  const html = '<body><script type="module" src="dashboard.js"></script></body>';
  const injected = injectModuleEntry(html, 'dashboard.js', '/tools/demo-entry.mjs');

  assert.match(injected, /demo-entry\.mjs/);
  assert.doesNotMatch(injected, /src="dashboard\.js"/);
  assert.equal(contentTypeFor('asset.png'), 'image/png');
  assert.equal(contentTypeFor('module.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('page.html'), 'text/html; charset=utf-8');
});

test('A1 ranges parse in the shapes the extension writes', async () => {
  const { parseRange } = await load(sheetsPath);

  assert.deepEqual(parseRange('Backup!A1'), { title: 'Backup', startCol: 0, startRow: 0, endCol: 0, endRow: 0 });
  assert.deepEqual(parseRange('Meetings!A:G'),
    { title: 'Meetings', startCol: 0, startRow: 0, endCol: 6, endRow: Infinity });
  assert.deepEqual(parseRange('Backup!A2:B'),
    { title: 'Backup', startCol: 0, startRow: 1, endCol: 1, endRow: Infinity });
  assert.equal(parseRange('no-tab'), null);
});

test('Sheets stub serves the seeded sheet and passes everything else through', async () => {
  const { createSheetsFetch } = await load(sheetsPath);
  const { buildDemoData } = await load(dataPath);

  const demo = buildDemoData(new Date('2026-08-14T10:00:00.000Z'));
  const seen = [];
  const stub = createSheetsFetch(demo, { passthrough: async url => { seen.push(url); return 'passed'; } });
  const get = async (path) => {
    const res = await stub(`https://sheets.googleapis.com/v4/spreadsheets/${path}`,
      { headers: { Authorization: 'Bearer demo-oauth-token' } });
    return { status: res.status, body: await res.json() };
  };

  const index = await get(`${demo.settings.spreadsheetId}/values/Backup!A2%3AB`);
  assert.equal(index.status, 200);
  assert.equal(index.body.values.length, demo.groups.length + demo.history.length);
  assert.deepEqual(index.body.values[0], ['series', demo.groups[0].id]);

  const info = await get(demo.settings.spreadsheetId);
  assert.deepEqual(info.body.sheets.map(s => s.properties.title), ['Meetings', 'Participants', 'Backup']);

  assert.equal((await get('not-a-demo-sheet')).status, 404);
  const unauthorized = await stub(`https://sheets.googleapis.com/v4/spreadsheets/${demo.settings.spreadsheetId}`, {});
  assert.equal(unauthorized.status, 401);

  assert.equal(await stub('http://127.0.0.1:4177/_locales/pl/messages.json'), 'passed');
  assert.deepEqual(seen, ['http://127.0.0.1:4177/_locales/pl/messages.json']);
});

test('a sync pass over the stub moves nothing and never reaches the network', async () => {
  const { createSheetsFetch } = await load(sheetsPath);
  const { createChromeMock } = await load(runtimePath);
  const { buildDemoData } = await load(dataPath);

  const demo = buildDemoData(new Date('2026-08-14T10:00:00.000Z'));
  const previous = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  globalThis.chrome = createChromeMock(demo, { origin: 'http://127.0.0.1:4177' });
  globalThis.fetch = createSheetsFetch(demo, {
    passthrough: url => assert.fail(`the demo must not reach the network: ${url}`)
  });

  try {
    const sync = await load(syncPath);
    assert.deepEqual(await sync.syncNow(demo.settings.spreadsheetId),
      { pulled: 0, pulledGroups: 0, pushed: 0, pushedGroups: 0 });

    // and the records really are readable back out of it, not merely counted
    const restored = await sync.pullEverything(demo.settings.spreadsheetId);
    assert.equal(restored.found, demo.groups.length + demo.history.length);
    assert.equal(restored.pulled, 0);
    assert.equal(restored.kept, demo.history.length);
  } finally {
    Object.assign(globalThis, previous);
  }
});

test('the demo clock reports one fixed now without breaking real dates', async () => {
  const { freezeClock } = await load(join(here, '..', 'demo-clock.mjs'));
  const { DEMO_ANCHOR } = await load(dataPath);

  const sample = '2026-01-02T03:04:05.000Z';
  const fixed = new Date(DEMO_ANCHOR).getTime();
  const sampleMs = new Date(sample).getTime();          // read off the real clock, before it stops

  const restore = freezeClock(DEMO_ANCHOR);
  try {
    assert.equal(Date.now(), fixed);
    assert.equal(new Date().getTime(), fixed, 'an argument-free Date is the anchor');
    assert.equal(new Date().toISOString(), DEMO_ANCHOR);

    // dates that already exist are still themselves — only "now" is pinned
    assert.equal(new Date(sample).toISOString(), sample);
    assert.equal(Date.parse(sample), sampleMs);
    assert.ok(new Date() instanceof Date);
  } finally {
    restore();
  }

  assert.notEqual(Date.now(), new Date(DEMO_ANCHOR).getTime(), 'the clock starts again afterwards');
});

test('a frame is measured by what the JPEG itself claims', async () => {
  const { jpegSize } = await load(join(here, '..', 'capture.mjs'));

  // a minimal JPEG: SOI, a JFIF APP0, then an SOF0 frame header carrying 800×1280
  const jpeg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x05, 0x00, 0x03, 0x01, 0x11, 0x00
  ]);
  assert.deepEqual(jpegSize(jpeg), { width: 1280, height: 800 });
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8])), null);
});

test('the marquee names one cast in Polish and the same cast in English', async () => {
  const { PEOPLE_BY_LANGUAGE } = await load(dataPath);
  const html = readFileSync(join(here, '..', 'promo-marquee.html'), 'utf8');

  const labels = [...html.matchAll(/<label([^>]*)>([^<]+)<\/label>/g)];
  assert.ok(labels.length >= 4, 'the timeline should name a few people');

  for (const [, attributes, polish] of labels) {
    const english = /data-en="([^"]+)"/.exec(attributes)?.[1];
    assert.ok(english, `"${polish}" is hard-coded with no English name beside it`);
    assert.ok(PEOPLE_BY_LANGUAGE.pl.includes(polish), `"${polish}" is not in the Polish cast`);
    assert.equal(english, PEOPLE_BY_LANGUAGE.en[PEOPLE_BY_LANGUAGE.pl.indexOf(polish)],
      `"${english}" is not the same person as "${polish}"`);
  }
});

test('browser launchers and showcase pages are present', () => {
  const root = join(here, '..');
  const required = [
    'demo-entry.mjs',
    'popup-entry.mjs',
    'demo-clock.mjs',
    'capture.mjs',
    'popup-showcase.html',
    'promo-small.html',
    'promo-marquee.html'
  ];

  for (const file of required) {
    const path = join(root, file);
    assert.ok(existsSync(path), `${file} should exist`);
    const source = readFileSync(path, 'utf8');
    assert.ok(source.trim().length > 100, `${file} should contain a real implementation`);
  }
});
