import * as sheets from './sheets-api.js';
import * as storage from './storage.js';

/** Disconnect the account before removing the local link that explains what was connected. */
export async function disconnectSheetsAccount() {
  await sheets.disconnect();
  return storage.updateSettings({
    spreadsheetId: null,
    spreadsheetName: null,
    autoSync: false
  });
}
