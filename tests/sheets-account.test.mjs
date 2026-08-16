import test from 'node:test';
import assert from 'node:assert/strict';

const clone = value => JSON.parse(JSON.stringify(value));
const data = {};
let identityError = null;

globalThis.chrome = {
  runtime: {
    lastError: null,
    getManifest: () => ({ oauth2: { client_id: 'test.apps.googleusercontent.com' } })
  },
  identity: {
    clearAllCachedAuthTokens(callback) {
      if (identityError) chrome.runtime.lastError = { message: identityError };
      callback();
      chrome.runtime.lastError = null;
    }
  },
  storage: {
    local: {
      get(keys, callback) {
        const out = {};
        for (const key of keys) if (key in data) out[key] = clone(data[key]);
        callback(out);
      },
      set(values, callback) {
        Object.assign(data, clone(values));
        callback();
      },
      remove(keys, callback) {
        for (const key of keys) delete data[key];
        callback();
      }
    }
  }
};

const { disconnectSheetsAccount } = await import('../src/lib/sheets-account.js');

function reset() {
  for (const key of Object.keys(data)) delete data[key];
  data.settings = {
    autoSync: true,
    spreadsheetId: 'sheet-id',
    spreadsheetName: 'Attendance',
    theme: 'dark'
  };
  identityError = null;
}

test('disconnect clears the linked sheet only after identity succeeds', async () => {
  reset();

  const settings = await disconnectSheetsAccount();

  assert.equal(settings.spreadsheetId, null);
  assert.equal(settings.spreadsheetName, null);
  assert.equal(settings.autoSync, false);
  assert.equal(settings.theme, 'dark');
  assert.deepEqual(data.settings, settings);
});

test('an identity failure leaves the linked sheet and auto-sync unchanged', async () => {
  reset();
  identityError = 'identity refused';

  await assert.rejects(disconnectSheetsAccount(), /identity refused/);

  assert.equal(data.settings.spreadsheetId, 'sheet-id');
  assert.equal(data.settings.autoSync, true);
});
