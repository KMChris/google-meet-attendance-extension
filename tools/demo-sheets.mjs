/**
 * The Google Sheets API, in memory.
 *
 * The demo runs the extension's real Sheets code: sheets-api.js builds the same URLs and
 * sheets-sync.js makes the same decisions. The one thing that must not be real is the network —
 * without this, opening the dashboard hands the mock's made-up OAuth token to Google, collects a
 * 401 twice per call, and finishes with a sync failure in the console of every screenshot session.
 *
 * The sheet is seeded with the records the demo store already holds, so a pass finds nothing to do
 * in either direction: no rows move, no toast fires, and the register on screen is the register
 * that was seeded no matter how often the page is reloaded. What the pass does exercise is the
 * real path — a two-column read of the Backup tab — which is the point of demonstrating it at all.
 *
 * Everything that is not the Sheets API is handed to the fetch that was there before, because the
 * pages still load their locales that way.
 */

const API_HOST = 'sheets.googleapis.com';
const API_PREFIX = '/v4/spreadsheets';

/**
 * Mirrors HEADERS and CELL_CHUNK in src/lib/sheets-api.js. A sheet the extension has been syncing
 * to already carries these, and seeding them is what leaves `ensureSheets` with nothing to repair.
 * They are copied rather than imported because the demo may not reach into the extension's private
 * constants; if the real ones ever change, the worst that happens here is a repair nobody sees.
 */
const CELL_CHUNK = 40000;
const HEADERS = {
  Meetings: ['Meeting ID', 'Title', 'Start Time', 'End Time', 'Duration (min)', 'Participant Count', 'URL'],
  Participants: ['Meeting ID', 'Name', 'Email', 'Time', 'Type'],
  Backup: ['Kind', 'ID', 'Part', 'JSON — written by the extension, do not edit']
};

/* ------------------------------------ the grid ------------------------------------ */

const cell = (value) => (value == null ? '' : String(value));

function columnIndex(letters) {
  return [...letters.toUpperCase()].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
}

/**
 * A1 notation, in the shapes this codebase actually writes: `Tab!A1`, `Tab!A:G` (whole columns)
 * and `Tab!A2:D` (from a row, open ended). An open end reads as "to wherever the data stops",
 * which is how Sheets treats it too.
 */
export function parseRange(range) {
  const text = String(range == null ? '' : range);
  const bang = text.lastIndexOf('!');
  if (bang === -1) return null;

  const title = text.slice(0, bang).replace(/^'(.*)'$/, '$1');
  const [from, to = from] = text.slice(bang + 1).split(':');
  const start = /^([A-Za-z]*)(\d*)$/.exec(from);
  const end = /^([A-Za-z]*)(\d*)$/.exec(to);
  if (!title || !start || !end) return null;

  return {
    title,
    startCol: start[1] ? columnIndex(start[1]) : 0,
    startRow: start[2] ? Number(start[2]) - 1 : 0,
    endCol: end[1] ? columnIndex(end[1]) : Infinity,
    endRow: end[2] ? Number(end[2]) - 1 : Infinity
  };
}

function lastFilledRow(rows) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if ((rows[i] || []).some(value => cell(value) !== '')) return i;
  }
  return -1;
}

/** Trailing blanks are not sent by Sheets, and code that reads it is written for that. */
function readRange(tab, range) {
  const lastRow = Math.min(range.endRow, tab.rows.length - 1);
  const out = [];
  for (let r = range.startRow; r <= lastRow; r += 1) {
    const row = tab.rows[r] || [];
    const lastCol = Math.min(range.endCol, row.length - 1);
    const cells = [];
    for (let c = range.startCol; c <= lastCol; c += 1) cells.push(cell(row[c]));
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    out.push(cells);
  }
  while (out.length && out[out.length - 1].length === 0) out.pop();
  return out;
}

function writeRange(tab, range, values) {
  values.forEach((row, r) => {
    const index = range.startRow + r;
    while (tab.rows.length <= index) tab.rows.push([]);
    const target = tab.rows[index];
    while (target.length < range.startCol) target.push('');
    row.forEach((value, c) => { target[range.startCol + c] = cell(value); });
  });
}

/* ------------------------------- the fake spreadsheet ------------------------------- */

/**
 * The verbatim records, in the shape sheets-api.js writes them: one row per record, split over
 * numbered parts when a record is longer than a cell holds. Only meetings that ended, because a
 * call still running is never sent — seeding one would claim the sheet holds something it could
 * not have been given.
 */
export function backupSeedRows(demo) {
  const rows = (kind, id, value) => {
    const json = JSON.stringify(value);
    const parts = Math.max(1, Math.ceil(json.length / CELL_CHUNK));
    return Array.from({ length: parts }, (_, i) =>
      [kind, id, i, json.slice(i * CELL_CHUNK, (i + 1) * CELL_CHUNK)]);
  };

  return [
    ...(demo.groups || []).flatMap(group => rows('series', group.id, group)),
    ...(demo.history || []).filter(m => m.endedAt).flatMap(m => rows('meeting', m.id, m))
  ];
}

function createSpreadsheetModel({ spreadsheetId, title, tabs }) {
  let nextSheetId = 1;
  const sheets = new Map();
  const addSheet = (name, rows = []) => {
    sheets.set(name, { title: name, sheetId: nextSheetId++, frozenRowCount: 1, rows });
    return sheets.get(name);
  };
  tabs.forEach(({ name, rows }) => addSheet(name, rows));
  return { spreadsheetId, title, sheets, addSheet };
}

function spreadsheetResource(model) {
  return {
    spreadsheetId: model.spreadsheetId,
    properties: { title: model.title },
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${model.spreadsheetId}/edit`,
    sheets: [...model.sheets.values()].map(tab => ({
      properties: {
        sheetId: tab.sheetId,
        title: tab.title,
        gridProperties: { frozenRowCount: tab.frozenRowCount }
      }
    }))
  };
}

/* ---------------------------------- the transport ---------------------------------- */

const respond = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' }
});

const fail = (status, message) => respond({
  error: { code: status, message, status: status === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT' }
}, status);

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input?.url || '';
}

/**
 * A stand-in for `fetch` that answers the Sheets API out of memory and passes everything else
 * through. `demo` seeds the spreadsheet the demo settings point at; `passthrough` is the fetch the
 * page would otherwise have used.
 */
export function createSheetsFetch(demo, { passthrough, spreadsheetId, spreadsheetName } = {}) {
  const id = spreadsheetId || demo?.settings?.spreadsheetId || 'demo-spreadsheet';
  const name = spreadsheetName || demo?.settings?.spreadsheetName || 'Demo';
  const books = new Map();
  let created = 0;

  books.set(id, createSpreadsheetModel({
    spreadsheetId: id,
    title: name,
    tabs: [
      // Only the Backup tab is given rows: it is the one a sync reads, and the two readable tabs
      // are the extension's own formatting, which the demo has no business restating.
      { name: 'Meetings', rows: [[...HEADERS.Meetings]] },
      { name: 'Participants', rows: [[...HEADERS.Participants]] },
      { name: 'Backup', rows: [[...HEADERS.Backup], ...backupSeedRows(demo)] }
    ]
  }));

  function handle(url, options) {
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : {};
    if (!/^Bearer .+/.test(options.headers?.Authorization || '')) {
      return fail(401, 'Request had invalid authentication credentials.');
    }

    const path = url.pathname.slice(API_PREFIX.length).replace(/^\//, '');

    if (!path) {
      if (method !== 'POST') return fail(400, 'Unsupported request');
      const fresh = createSpreadsheetModel({
        spreadsheetId: `demo-spreadsheet-${++created}`,
        title: body.properties?.title || 'Google Meet Attendance',
        tabs: (body.sheets || []).map(s => ({ name: s.properties?.title, rows: [] }))
      });
      books.set(fresh.spreadsheetId, fresh);
      return respond(spreadsheetResource(fresh));
    }

    const slash = path.indexOf('/');
    const head = slash === -1 ? path : path.slice(0, slash);
    const rest = slash === -1 ? '' : path.slice(slash + 1);
    const book = books.get(decodeURIComponent(head.replace(/:batchUpdate$/, '')));
    if (!book) return fail(404, 'Requested entity was not found.');

    // structure: adding a tab, inserting a row, freezing a header
    if (!rest && head.endsWith(':batchUpdate')) {
      (body.requests || []).forEach(request => {
        const add = request.addSheet?.properties;
        if (add?.title && !book.sheets.has(add.title)) book.addSheet(add.title, []);

        const insert = request.insertDimension?.range;
        if (insert?.dimension === 'ROWS') {
          const tab = [...book.sheets.values()].find(s => s.sheetId === insert.sheetId);
          if (tab) tab.rows.splice(insert.startIndex, 0, []);
        }

        const update = request.updateSheetProperties?.properties;
        if (update?.gridProperties) {
          const tab = [...book.sheets.values()].find(s => s.sheetId === update.sheetId);
          if (tab) tab.frozenRowCount = update.gridProperties.frozenRowCount;
        }
      });
      return respond({ spreadsheetId: book.spreadsheetId, replies: [] });
    }

    if (!rest) return respond(spreadsheetResource(book));

    if (rest === 'values:batchGet') {
      const valueRanges = url.searchParams.getAll('ranges').map(range => {
        const parsed = parseRange(range);
        const tab = parsed && book.sheets.get(parsed.title);
        return { range, values: tab ? readRange(tab, parsed) : [] };
      });
      return respond({ spreadsheetId: book.spreadsheetId, valueRanges });
    }

    if (rest === 'values:batchUpdate') {
      for (const entry of body.data || []) {
        const parsed = parseRange(entry.range);
        const tab = parsed && book.sheets.get(parsed.title);
        if (!tab) return fail(400, `Unable to parse range: ${entry.range}`);
        writeRange(tab, parsed, entry.values || []);
      }
      return respond({ spreadsheetId: book.spreadsheetId, totalUpdatedRows: (body.data || []).length });
    }

    if (rest.startsWith('values/')) {
      const raw = rest.slice('values/'.length);
      const appending = raw.endsWith(':append');
      const parsed = parseRange(decodeURIComponent(appending ? raw.slice(0, -':append'.length) : raw));
      const tab = parsed && book.sheets.get(parsed.title);
      if (!tab) return fail(400, `Unable to parse range: ${decodeURIComponent(raw)}`);

      if (!appending) {
        return respond({ range: parsed.title, majorDimension: 'ROWS', values: readRange(tab, parsed) });
      }
      const values = body.values || [];
      writeRange(tab, { ...parsed, startRow: lastFilledRow(tab.rows) + 1, startCol: parsed.startCol }, values);
      return respond({
        spreadsheetId: book.spreadsheetId,
        updates: { updatedRows: values.length, updatedRange: parsed.title }
      });
    }

    return fail(400, 'Unsupported request');
  }

  const sheetsFetch = async (input, options = {}) => {
    const href = requestUrl(input);
    let url = null;
    try { url = new URL(href, globalThis.location?.href); } catch { url = null; }

    if (url?.host !== API_HOST || !url.pathname.startsWith(API_PREFIX)) {
      if (!passthrough) throw new TypeError(`No transport for ${href}`);
      return passthrough(input, options);
    }

    try { return handle(url, options); } catch (error) {
      return fail(400, error?.message || 'Demo Sheets stub failed');
    }
  };

  sheetsFetch.books = books;
  return sheetsFetch;
}

/** Put the stub in front of the page's fetch. Returns what it replaced. */
export function installSheetsFetch(demo, target = globalThis) {
  const previous = target.fetch;
  target.fetch = createSheetsFetch(demo, {
    passthrough: typeof previous === 'function' ? previous.bind(target) : null
  });
  return previous;
}
