import test from 'node:test';
import assert from 'node:assert/strict';

const EN = { greeting: { message: 'English' } };
const PL = { greeting: { message: 'Polski' } };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function response(messages) {
  return { ok: true, json: async () => messages };
}

function installEnvironment({ stored = null, fetchImpl } = {}) {
  const translated = { dataset: { i18n: 'greeting' }, textContent: '' };
  const events = [];
  const storage = stored ? { rollcallLanguage: stored } : {};
  const document = {
    documentElement: { lang: '' },
    querySelectorAll(selector) { return selector === '[data-i18n]' ? [translated] : []; },
    dispatchEvent(event) { events.push(event); }
  };

  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-US' }, configurable: true
  });
  globalThis.document = document;
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options && options.detail; }
  };
  globalThis.chrome = {
    runtime: { lastError: null, getURL: path => `chrome-extension://test/${path}` },
    storage: {
      sync: {
        get(_keys, callback) { callback({ ...storage }); },
        set(values) { Object.assign(storage, values); },
        remove(key) { delete storage[key]; }
      }
    }
  };
  globalThis.fetch = fetchImpl;
  return { document, translated, events, storage };
}

async function freshI18n(label) {
  return import(`../src/lib/i18n.js?test=${label}-${Date.now()}-${Math.random()}`);
}

test('locale transitions finish in request order when fetches finish out of order', async () => {
  const en = deferred();
  const pl = deferred();
  const env = installEnvironment({
    fetchImpl: url => url.includes('/pl/') ? pl.promise : en.promise
  });
  const i18n = await freshI18n('queue');
  const notifications = [];
  i18n.onLocaleChange(code => notifications.push(code));

  const polish = i18n.setLocale('pl');
  const english = i18n.setLocale('en');
  en.resolve(response(EN));
  await Promise.resolve();
  pl.resolve(response(PL));

  assert.deepEqual(await Promise.all([polish, english]), ['pl', 'en']);
  assert.equal(env.storage.rollcallLanguage, 'en');
  assert.equal(env.document.documentElement.lang, 'en');
  assert.equal(env.translated.textContent, 'English');
  assert.equal(i18n.getLanguagePreference(), 'en');
  assert.equal(i18n.getLocale(), 'en');
  assert.deepEqual(notifications, ['pl', 'en']);
});

test('initializing the default locale fetches its catalogue only once', async () => {
  let fetches = 0;
  installEnvironment({
    fetchImpl: async () => { fetches++; return response(EN); }
  });
  const i18n = await freshI18n('dedupe');

  assert.equal(await i18n.initI18n(), 'en');
  assert.equal(fetches, 1);
});

test('an asynchronous sync-storage failure does not discard the selected locale', async () => {
  const env = installEnvironment({
    fetchImpl: async url => response(url.includes('/pl/') ? PL : EN)
  });
  globalThis.chrome.storage.sync.set = async () => { throw new Error('sync unavailable'); };
  const i18n = await freshI18n('storage-failure');

  assert.equal(await i18n.setLocale('pl'), 'pl');
  assert.equal(i18n.getLanguagePreference(), 'pl');
  assert.equal(i18n.getLocale(), 'pl');
  assert.equal(env.translated.textContent, 'Polski');
});
