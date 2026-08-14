/**
 * Importers for attendance files this app didn't write as a JSON backup: exports from *other*
 * extensions, and our own CSV.
 *
 * Each source declares how to read one file and hand back meeting records in this app's shape
 * ({ id, meetingCode, date, endedAt, meetingTitle, url, attendance }). Everything downstream —
 * merging into history, normalizing, rendering — is the same path a backup of our own takes, so
 * an importer only has to answer one question: what are the raw joins and leaves?
 *
 * Adding a foreign source means adding an entry to IMPORT_SOURCES with a `convert(raw)` that
 * throws ImportFormatError when the file plainly isn't its format.
 *
 * Pure: no chrome.* here, same as attendance.js.
 */

import { deriveAttendee, isMeetCode, makeSessionId } from './attendance.js';

/** Thrown when a file doesn't look like the chosen source's export at all. */
export class ImportFormatError extends Error {}

const ms = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isNaN(t) ? NaN : t; };

/**
 * Undo the doubled strings RollCall writes into its titles ("SLTSLT", "abc-defg-hijabc-defg-hij"):
 * its scraper appends the heading to itself. Only an exact "s + s" is unfolded — anything else
 * is left as the user's own words.
 */
function undouble(s) {
  const v = String(s == null ? '' : s).trim();
  if (v.length < 2 || v.length % 2) return v;
  const half = v.length / 2;
  return v.slice(0, half) === v.slice(half) ? v.slice(0, half) : v;
}

/* ============================ RollCall (meet-attendance.com) ============================ */

/**
 * RollCall keeps one flat `sessionData` record per (person, day, meet code), keyed
 * "Name_YYYY-MM-DD_abc-defg-hij", with presence as `joinLeavePairs` and a still-open call in
 * `currentJoinTime`. We key meetings by (code, day) — the day is RollCall's own unit, and a
 * training that ran over two days is two sessions there and two meetings here.
 *
 * What doesn't survive: hand raises (this app has no model for them) and RollCall's rounded
 * per-pair minutes, which are recomputed from the timestamps.
 */
function fromRollCall(raw) {
  const root = (raw && typeof raw === 'object') ? (raw.data && typeof raw.data === 'object' ? raw.data : raw) : null;
  const sessionData = root && root.sessionData;
  if (!sessionData || typeof sessionData !== 'object') {
    throw new ImportFormatError('no sessionData');
  }

  const titles = (root.meetingAutoTitles && typeof root.meetingAutoTitles === 'object') ? root.meetingAutoTitles : {};
  const entries = Object.values(sessionData).filter(e => e && typeof e === 'object' && e.meetId && e.studentName);
  if (!entries.length) throw new ImportFormatError('no participants');

  // (code, day) -> entries. A record without a date falls back to the day of its first join.
  const byMeeting = new Map();
  for (const e of entries) {
    const day = e.date || (e.firstJoin || '').slice(0, 10) || 'unknown';
    const key = `${e.meetId}|${day}`;
    if (!byMeeting.has(key)) byMeeting.set(key, []);
    byMeeting.get(key).push(e);
  }

  const meetings = [];
  let skipped = 0;

  for (const [key, people] of byMeeting) {
    const code = key.slice(0, key.indexOf('|'));
    const attendance = {};

    people
      .slice()
      .sort((a, b) => String(a.studentName).localeCompare(String(b.studentName)))
      .forEach(p => {
        const events = [];
        for (const pair of (Array.isArray(p.joinLeavePairs) ? p.joinLeavePairs : [])) {
          if (pair && pair.join) events.push({ time: pair.join, type: 'Join' });
          if (pair && pair.leave) events.push({ time: pair.leave, type: 'Leave' });
        }
        // Nothing paired up (a record RollCall never closed) — fall back to its summary fields.
        if (!events.length && p.firstJoin) {
          events.push({ time: p.firstJoin, type: 'Join' });
          if (p.lastLeave) events.push({ time: p.lastLeave, type: 'Leave' });
        }
        // Still in the call when the backup was taken: an open Join, no Leave.
        if (p.currentJoinTime && !events.some(ev => ev.type === 'Join' && ev.time === p.currentJoinTime)) {
          events.push({ time: p.currentJoinTime, type: 'Join' });
        }

        const usable = events.filter(ev => !Number.isNaN(ms(ev.time)));
        if (!usable.length) { skipped++; return; }
        usable.sort((a, b) => ms(a.time) - ms(b.time));

        const name = String(p.studentName).trim();
        // Same person twice in one day (RollCall re-keyed them mid-call): keep both streams.
        const prev = attendance[name];
        attendance[name] = deriveAttendee({
          email: p.email || null,
          events: prev ? prev.events.concat(usable).sort((a, b) => ms(a.time) - ms(b.time)) : usable
        });
      });

    const names = Object.keys(attendance);
    if (!names.length) continue;

    const times = names.flatMap(n => attendance[n].events.map(ev => ms(ev.time)));
    const startMs = Math.min(...times);
    const endMs = Math.max(...times);
    const stillIn = names.some(n => attendance[n].present);
    const title = undouble(titles[code]) || code;

    meetings.push({
      id: makeSessionId(code, startMs),
      meetingCode: isMeetCode(code) ? code : null,
      date: new Date(startMs).toISOString(),
      endedAt: stillIn ? null : new Date(endMs).toISOString(),
      meetingTitle: title,
      url: isMeetCode(code) ? `https://meet.google.com/${code}` : '',
      attendance
    });
  }

  if (!meetings.length) throw new ImportFormatError('no meetings');
  meetings.sort((a, b) => ms(b.date) - ms(a.date));
  return { meetings, skipped };
}

/* ============================ our own CSV ============================ */

/** Split CSV text into rows of cells (RFC 4180 quoting, LF or CRLF, BOM tolerated). */
export function parseCSV(text) {
  const src = String(text == null ? '' : text).replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch !== '"') { cell += ch; continue; }
      if (src[i + 1] === '"') { cell += '"'; i++; continue; }   // "" is one quote
      quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * The CSV header is localized, so a file exported in either language has to be recognised:
 * every locale's label for the columns we need maps back to one canonical name.
 */
const CSV_COLUMNS = {
  colDate: 'day', colMeeting: 'title', csvMeetingCode: 'code', colGroup: 'group',
  csvMeetingStart: 'start', csvMeetingEnd: 'end',
  colParticipant: 'name', csvEmail: 'email', colStatus: 'status',
  colFirstSeen: 'firstSeen', colLastLeft: 'lastLeft', csvSessionList: 'ranges', csvId: 'mid'
};
const HEADER_ALIASES = new Map();
const ABSENT_LABELS = new Set();

/**
 * Hand over every locale's strings, as { en: { colDate: 'Date', … }, pl: { … } }.
 * The caller owns the message catalogues (they are loaded from _locales at runtime),
 * which keeps this module free of chrome.* and of any single language.
 */
export function configureLocaleLabels(tables) {
  HEADER_ALIASES.clear();
  ABSENT_LABELS.clear();
  for (const table of Object.values(tables || {})) {
    for (const key in CSV_COLUMNS) {
      const label = table[key];
      if (label) HEADER_ALIASES.set(String(label).trim().toLowerCase(), CSV_COLUMNS[key]);
    }
    if (table.absent) ABSENT_LABELS.add(String(table.absent).trim().toLowerCase());
  }
}

const DAY_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const TIME_RE = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i;

/** A wall-clock time on a given day, read in the importing machine's own timezone. */
function localMs(day, time, dayOffset = 0) {
  const d = DAY_RE.exec(String(day || '').trim());
  const t = TIME_RE.exec(String(time || ''));
  if (!d || !t) return NaN;
  let hour = Number(t[1]);
  const half = (t[4] || '').toLowerCase();
  if (half === 'pm' && hour < 12) hour += 12;
  if (half === 'am' && hour === 12) hour = 0;
  return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + dayOffset, hour, Number(t[2]), Number(t[3] || 0)).getTime();
}

/** ["08:58–17:00","17:10–"] → [{from,to}] — also accepts a plain "a–b; c–d" list. */
function rangesOf(cell) {
  const raw = String(cell == null ? '' : cell).trim();
  if (!raw) return [];
  let parts = null;
  if (raw[0] === '[') { try { parts = JSON.parse(raw); } catch { parts = null; } }
  if (!Array.isArray(parts)) parts = raw.replace(/^\[|\]$/g, '').split(/[;|]/);
  return parts
    .map(p => String(p).replace(/^"|"$/g, '').trim())
    .filter(Boolean)
    .map(p => { const [from, to] = p.split(/\s*[–—→>-]\s*/); return { from: (from || '').trim(), to: (to || '').trim() }; });
}

/** Join/Leave events for one row: its presence ranges, or first seen → last left as a fallback. */
function eventsFromRow(get, day) {
  const events = [];
  const push = (from, to) => {
    const joined = localMs(day, from);
    if (Number.isNaN(joined)) return;
    events.push({ time: new Date(joined).toISOString(), type: 'Join' });
    if (!to) return;                                   // open range: still in the call
    let left = localMs(day, to);
    if (left < joined) left = localMs(day, to, 1);      // ran past midnight
    if (!Number.isNaN(left)) events.push({ time: new Date(left).toISOString(), type: 'Leave' });
  };

  const ranges = rangesOf(get('ranges'));
  if (ranges.length) ranges.forEach(r => push(r.from, r.to));
  else push(get('firstSeen'), get('lastLeft'));
  return events;
}

/**
 * Read a CSV this app exported — a single meeting, the whole history, or a series file (whose
 * matrix block is skipped: the per-participant header is looked for anywhere in the file).
 *
 * What the format can carry, it keeps: the meeting's own id (so re-importing a file you already
 * have adds nothing), its code, hours and series name, and every join and leave. What it cannot:
 * times are minute-resolution, absentees are roster-derived rather than data and are skipped,
 * and a merged participant arrives as the one person the file shows — the JSON backup is the
 * lossless path.
 */
export function fromOwnCSV(text) {
  if (!HEADER_ALIASES.size) throw new Error('configureLocaleLabels() must run before a CSV is read');
  const rows = parseCSV(text);
  if (!rows.length) throw new ImportFormatError('empty file');

  let cols = null, first = -1;
  for (let i = 0; i < rows.length && !cols; i++) {
    const map = {};
    rows[i].forEach((cell, idx) => {
      const canonical = HEADER_ALIASES.get(String(cell).trim().toLowerCase());
      if (canonical && map[canonical] == null) map[canonical] = idx;
    });
    if (map.name != null && map.day != null && (map.ranges != null || map.firstSeen != null)) { cols = map; first = i + 1; }
  }
  if (!cols) throw new ImportFormatError('no participant header');

  const byMeeting = new Map();
  let skipped = 0;

  for (let i = first; i < rows.length; i++) {
    const row = rows[i];
    if (!row.length || row.every(c => !String(c).trim())) break;   // a blank line ends the block
    const get = key => (cols[key] == null ? '' : String(row[cols[key]] == null ? '' : row[cols[key]]).trim());

    const name = get('name'), day = get('day');
    if (!name || !DAY_RE.test(day)) { skipped++; continue; }
    if (ABSENT_LABELS.has(get('status').toLowerCase())) continue;  // not data: derived from a roster

    const events = eventsFromRow(get, day);
    if (!events.length) { skipped++; continue; }
    events.sort((a, b) => ms(a.time) - ms(b.time));

    const code = get('code');
    const startMs = localMs(day, get('start'));
    const id = get('mid') || makeSessionId(code, Number.isFinite(startMs) ? startMs : ms(events[0].time));

    let rec = byMeeting.get(id);
    if (!rec) {
      let endMs = localMs(day, get('end'));
      if (endMs < startMs) endMs = localMs(day, get('end'), 1);
      rec = { id, code, title: get('title') || code || id, group: get('group'), startMs, endMs, attendance: {} };
      byMeeting.set(id, rec);
    }
    const prev = rec.attendance[name];
    rec.attendance[name] = deriveAttendee({
      email: get('email') || null,
      events: prev ? prev.events.concat(events).sort((a, b) => ms(a.time) - ms(b.time)) : events
    });
  }

  const meetings = [];
  for (const rec of byMeeting.values()) {
    const names = Object.keys(rec.attendance);
    if (!names.length) continue;
    const times = names.flatMap(n => rec.attendance[n].events.map(e => ms(e.time)));
    const startMs = Number.isFinite(rec.startMs) ? rec.startMs : Math.min(...times);
    const endMs = Number.isFinite(rec.endMs) ? rec.endMs : Math.max(...times);
    const stillIn = names.some(n => rec.attendance[n].present);

    const meeting = {
      id: rec.id,
      meetingCode: isMeetCode(rec.code) ? rec.code : null,
      date: new Date(startMs).toISOString(),
      endedAt: stillIn ? null : new Date(endMs).toISOString(),
      meetingTitle: rec.title,
      url: isMeetCode(rec.code) ? `https://meet.google.com/${rec.code}` : '',
      attendance: rec.attendance
    };
    if (rec.group) meeting.groupName = rec.group;   // resolved to a series by the importing page
    meetings.push(meeting);
  }

  if (!meetings.length) throw new ImportFormatError('no participants');
  meetings.sort((a, b) => ms(b.date) - ms(a.date));
  return { meetings, skipped };
}

/* ============================ registry ============================ */

export const IMPORT_SOURCES = [
  { id: 'rollcall', label: 'RollCall — meet-attendance.com', convert: fromRollCall }
];

export function getImportSource(id) {
  return IMPORT_SOURCES.find(s => s.id === id) || null;
}
