/**
 * Google Sheets API Integration
 * Handles OAuth2 authentication and Sheets API operations
 */

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/**
 * The two readable tabs are for people; `Backup` is for the extension. It carries the stored
 * record of every meeting and series verbatim as JSON, which is what makes a spreadsheet a
 * complete backup: raw Join/Leave events, e-mails, meeting hours, merges (nameMap) and all.
 * A cell tops out at 50k characters, so a long record is split over numbered parts.
 */
const SHEET_MEETINGS = 'Meetings';
const SHEET_PARTICIPANTS = 'Participants';
const SHEET_BACKUP = 'Backup';
const CELL_CHUNK = 40000;

const HEADERS = {
  [SHEET_MEETINGS]: ['Meeting ID', 'Title', 'Start Time', 'End Time', 'Duration (min)', 'Participant Count', 'URL'],
  [SHEET_PARTICIPANTS]: ['Meeting ID', 'Name', 'Email', 'Time', 'Type'],
  [SHEET_BACKUP]: ['Kind', 'ID', 'Part', 'JSON — written by the extension, do not edit']
};

/**
 * Read a spreadsheet id out of whatever the user has at hand: the link from the address bar,
 * a Drive link, or the id on its own. Anything else reads as "not a spreadsheet" so the field
 * can say so, instead of the API being asked about a meaningless id.
 *
 * A published link (/spreadsheets/d/e/2PACX-…) is refused on purpose: that id addresses the
 * published copy, not the spreadsheet, and no API call can open it.
 */
export function parseSpreadsheetRef(input) {
  const text = String(input == null ? '' : input).trim();
  if (!text) return null;
  if (/\/spreadsheets\/d\/e\//.test(text)) return null;

  const inPath = text.match(/\/spreadsheets\/(?:[^/]+\/)*d\/([\w-]{20,})/);
  if (inPath) return inPath[1];

  const inQuery = text.match(/[?&](?:key|id)=([\w-]{20,})/);   // older links, and Drive's ?id=
  if (inQuery) return inQuery[1];

  return /^[\w-]{20,}$/.test(text) ? text : null;
}

/** The link that opens a spreadsheet in the browser. */
export function spreadsheetUrl(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

/**
 * Get OAuth2 token using Chrome Identity API
 */
export async function getAuthToken(interactive = true) {
  const clientId = chrome.runtime.getManifest()?.oauth2?.client_id || '';
  if (!clientId || clientId.startsWith('YOUR_')) {
    throw new Error('Google OAuth client_id is not configured in manifest.json — see README.md → Google Cloud Console Setup');
  }
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!token) {
        reject(new Error('No OAuth token was returned'));
      } else {
        resolve(token);
      }
    });
  });
}

/**
 * Remove cached auth token (for logout or token refresh)
 */
export async function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, resolve);
  });
}

/**
 * Check if user is authenticated
 */
export async function isAuthenticated() {
  try {
    const token = await getAuthToken(false);
    return !!token;
  } catch {
    return false;
  }
}

/**
 * Make authenticated API request to Google Sheets.
 *
 * An expired token is the one failure worth retrying on its own — the second attempt is held to
 * the same standard as the first, so a sync that did not land can never report that it did.
 */
async function apiRequest(url, options = {}) {
  const send = (token) => fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  const token = await getAuthToken();
  let response = await send(token);

  if (response.status === 401) {
    await removeCachedToken(token);
    response = await send(await getAuthToken());
  }

  if (!response.ok) {
    // An error body is not always JSON (a proxy or a sign-in page is not), so the status is
    // what we can always say.
    const error = await response.json().catch(() => null);
    throw new Error(error?.error?.message || `Sheets API request failed (HTTP ${response.status})`);
  }

  return response.json();
}

/**
 * Create a new spreadsheet for attendance tracking
 */
export async function createSpreadsheet(title = 'Google Meet Attendance') {
  const spreadsheet = await apiRequest(SHEETS_API_BASE, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title },
      sheets: Object.keys(HEADERS).map(t => ({
        properties: { title: t, gridProperties: { frozenRowCount: 1 } }
      }))
    })
  });

  await writeHeaders(spreadsheet.spreadsheetId, Object.keys(HEADERS));
  return spreadsheet;
}

/** Structural changes (adding a tab) go to a different endpoint than cell values. */
async function structureUpdate(spreadsheetId, requests) {
  return apiRequest(`${SHEETS_API_BASE}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests })
  });
}

async function writeHeaders(spreadsheetId, titles) {
  await batchUpdate(spreadsheetId, titles.map(t => ({ range: `${t}!A1`, values: [HEADERS[t]] })));
}

/** A..G is the whole width we ever address. */
const colLetter = (n) => String.fromCharCode(64 + n);

/**
 * What a tab that already exists needs before it can hold our rows: nothing, a header row
 * written into an empty first row, or a row inserted to make room for one. Rows someone else
 * put there are never overwritten: a spreadsheet picked by hand may already be in use.
 */
export function headerRepair(firstRow, expected) {
  const cell = (v) => String(v == null ? '' : v).trim();
  const row = Array.isArray(firstRow) ? firstRow : [];
  if (expected.every((h, i) => cell(row[i]) === h)) return 'ok';
  return row.some(cell) ? 'insert' : 'write';
}

/**
 * Give the spreadsheet the structure we write into: the three tabs, each with its header row.
 * A sheet the user picked by hand has none of it and one an older version created may be
 * missing a tab, so it is built here rather than failing the sync. Returns what it had to do.
 */
export async function ensureSheets(spreadsheetId) {
  const ss = await getSpreadsheet(spreadsheetId);
  const props = new Map((ss.sheets || []).map(s => [s.properties && s.properties.title, s.properties]));

  const missing = Object.keys(HEADERS).filter(t => !props.has(t));
  if (missing.length) {
    await structureUpdate(spreadsheetId, missing.map(title => ({
      addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } }
    })));
    await writeHeaders(spreadsheetId, missing);
  }

  const repaired = await repairHeaders(spreadsheetId, Object.keys(HEADERS)
    .filter(t => props.has(t)).map(t => props.get(t)));

  return { spreadsheet: ss, added: missing, repaired, prepared: !!(missing.length + repaired.length) };
}

/** Header rows of the tabs that were already there. Returns the ones it had to write. */
async function repairHeaders(spreadsheetId, sheetProps) {
  if (!sheetProps.length) return [];
  const titles = sheetProps.map(p => p.title);
  const read = await getRanges(spreadsheetId, titles.map(t => `${t}!A1:${colLetter(HEADERS[t].length)}1`));
  const rows = (read.valueRanges || []).map(v => (v.values && v.values[0]) || []);

  const requests = [], repaired = [];
  titles.forEach((title, i) => {
    const fix = headerRepair(rows[i], HEADERS[title]);
    if (fix === 'ok') return;
    repaired.push(title);
    if (fix === 'insert') requests.push({
      insertDimension: {
        range: { sheetId: sheetProps[i].sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 }
      }
    });
  });
  // a header only helps while it stays in view over the rows that pile up under it
  sheetProps.filter(p => (p.gridProperties || {}).frozenRowCount !== 1).forEach(p => requests.push({
    updateSheetProperties: {
      properties: { sheetId: p.sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount'
    }
  }));

  if (requests.length) await structureUpdate(spreadsheetId, requests);
  if (repaired.length) await writeHeaders(spreadsheetId, repaired);
  return repaired;
}

/**
 * Get spreadsheet info
 */
export async function getSpreadsheet(spreadsheetId) {
  return apiRequest(`${SHEETS_API_BASE}/${spreadsheetId}`);
}

/**
 * Append data to a sheet
 */
export async function appendData(spreadsheetId, range, values) {
  const url = `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  return apiRequest(url, {
    method: 'POST',
    body: JSON.stringify({ values })
  });
}

/**
 * Batch update multiple ranges
 */
export async function batchUpdate(spreadsheetId, data) {
  const url = `${SHEETS_API_BASE}/${spreadsheetId}/values:batchUpdate`;

  return apiRequest(url, {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: data.map(d => ({
        range: d.range,
        values: d.values
      }))
    })
  });
}

/**
 * Get data from a sheet
 */
export async function getData(spreadsheetId, range) {
  const url = `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  return apiRequest(url);
}

/** Several ranges in one read. They come back in the order they were asked for. */
async function getRanges(spreadsheetId, ranges) {
  const query = ranges.map(r => `ranges=${encodeURIComponent(r)}`).join('&');
  return apiRequest(`${SHEETS_API_BASE}/${spreadsheetId}/values:batchGet?${query}`);
}

/* ------------------------- what a meeting looks like in the sheet ------------------------- */

function meetingRow(meeting) {
  const names = Object.keys(meeting.attendance || {});
  const duration = meeting.date && meeting.endedAt
    ? Math.round((new Date(meeting.endedAt) - new Date(meeting.date)) / 60000).toString()
    : '';
  return [meeting.id, meeting.meetingTitle || '', meeting.date || '', meeting.endedAt || '',
    duration, names.length, meeting.url || ''];
}

/** One row per raw Join/Leave event — a summary row only when a record carries no events. */
function participantRows(meeting) {
  const attendance = meeting.attendance || {};
  return Object.keys(attendance).flatMap(name => {
    const p = attendance[name] || {};
    const events = Array.isArray(p.events) ? p.events : [];
    if (events.length) return events.map(e => [meeting.id, name, p.email || '', e.time || '', e.type]);
    return [[meeting.id, name, p.email || '', p.joinedAt || '', p.present ? 'In call' : 'Left']];
  });
}

/** The verbatim record, split into cell-sized parts. */
function backupRows(kind, id, obj) {
  const json = JSON.stringify(obj);
  const parts = Math.max(1, Math.ceil(json.length / CELL_CHUNK));
  return Array.from({ length: parts }, (_, i) => [kind, id, i, json.slice(i * CELL_CHUNK, (i + 1) * CELL_CHUNK)]);
}

/**
 * Sync one meeting (an attendanceHistory record) — the readable rows plus the backup rows
 * that make it restorable.
 */
export async function syncMeeting(spreadsheetId, meeting) {
  await ensureSheets(spreadsheetId);
  await appendData(spreadsheetId, `${SHEET_MEETINGS}!A:G`, [meetingRow(meeting)]);

  const rows = participantRows(meeting);
  if (rows.length) await appendData(spreadsheetId, `${SHEET_PARTICIPANTS}!A:E`, rows);
  await appendData(spreadsheetId, `${SHEET_BACKUP}!A:D`, backupRows('meeting', meeting.id, meeting));

  return { success: true, meetingId: meeting.id, participantCount: Object.keys(meeting.attendance || {}).length };
}

/**
 * Write the whole local store to the sheet, replacing what is there. This is the operation
 * that makes the spreadsheet a full backup: after it, `restoreAll` can rebuild everything.
 */
export async function pushAll(spreadsheetId, { meetings = [], groups = [] } = {}) {
  await ensureSheets(spreadsheetId);
  await clearValues(spreadsheetId, [`${SHEET_MEETINGS}!A2:Z`, `${SHEET_PARTICIPANTS}!A2:Z`, `${SHEET_BACKUP}!A2:D`]);

  const backup = [
    ...groups.flatMap(g => backupRows('series', g.id, g)),
    ...meetings.flatMap(m => backupRows('meeting', m.id, m))
  ];
  const data = [
    { range: `${SHEET_MEETINGS}!A2`, values: meetings.map(meetingRow) },
    { range: `${SHEET_PARTICIPANTS}!A2`, values: meetings.flatMap(participantRows) },
    { range: `${SHEET_BACKUP}!A2`, values: backup }
  ].filter(d => d.values.length);
  if (data.length) await batchUpdate(spreadsheetId, data);

  return { meetings: meetings.length, groups: groups.length };
}

/**
 * Read everything back out of the sheet. Rows are read in order and a part 0 starts a fresh
 * record, so a meeting appended several times restores as the last version written.
 */
export async function restoreAll(spreadsheetId) {
  let rows = [];
  try {
    const data = await getData(spreadsheetId, `${SHEET_BACKUP}!A2:D`);
    rows = data.values || [];
  } catch { rows = []; }               // no Backup tab: nothing was ever written for restore

  const byKey = new Map();
  rows.forEach(([kind, id, part, json]) => {
    if (!kind || !id) return;
    const key = `${kind}::${id}`;
    const idx = Number(part) || 0;
    if (idx === 0 || !byKey.has(key)) byKey.set(key, { kind, id, parts: new Map() });
    byKey.get(key).parts.set(idx, json || '');
  });

  const meetings = [], groups = [];
  byKey.forEach(rec => {
    const json = Array.from(rec.parts.keys()).sort((a, b) => a - b).map(i => rec.parts.get(i)).join('');
    let obj;
    try { obj = JSON.parse(json); } catch { return; }
    if (!obj || !obj.id) return;
    (rec.kind === 'series' ? groups : meetings).push(obj);
  });
  return { meetings, groups };
}

async function clearValues(spreadsheetId, ranges) {
  const url = `${SHEETS_API_BASE}/${spreadsheetId}/values:batchClear`;
  return apiRequest(url, { method: 'POST', body: JSON.stringify({ ranges }) });
}

