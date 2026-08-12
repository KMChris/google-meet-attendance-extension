/**
 * Attendance core — pure derivation & aggregation (no chrome.* here).
 *
 * The raw source of truth for every participant is `events: [{time, type:'Join'|'Leave'}]`.
 * Everything else (sessions, presence, durations, lateness, status, group roll-ups) is
 * derived from those events so the whole app reads one consistent model.
 *
 * Imported by the service worker (module) and by the dashboard / report / popup pages
 * (loaded as `<script type="module">`).
 */

const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/** Milliseconds from an ISO string (NaN-safe: returns NaN for bad input). */
function ms(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? NaN : t;
}

/** A "stuck" meeting still marked in-progress after this long is treated as ended. */
export const STALE_MS = 4 * 60 * 60 * 1000;
/** A meeting re-opened within this window (refresh / rejoin) resumes the same record. */
export const RESUME_WINDOW_MS = 3 * 60 * 60 * 1000;

/** Is a string a bare Google Meet code (abc-defg-hij)? */
export function isMeetCode(s) {
  return typeof s === 'string' && CODE_RE.test(s);
}

/** Unique per-session id: keeps recurring links (same code) from overwriting each other. */
export function makeSessionId(code, startMs) {
  const base = isMeetCode(code) ? code : 'meet';
  const stamp = Number.isFinite(startMs) ? startMs : 0;
  return `${base}-${stamp}`;
}

/* ============================ per-participant ============================ */

/**
 * Pair Join/Leave events into presence sessions. Events are sorted defensively;
 * duplicate joins are ignored, a trailing open Join yields `leftAt: null` (present).
 */
export function sessionsFromEvents(events) {
  const evs = (Array.isArray(events) ? events : [])
    .filter(e => e && e.time && e.type && !Number.isNaN(ms(e.time)))
    .slice()
    .sort((a, b) => ms(a.time) - ms(b.time));

  const sessions = [];
  let open = null;
  for (const e of evs) {
    if (e.type === 'Join') {
      if (open == null) open = e.time;
    } else if (e.type === 'Leave') {
      if (open != null) { sessions.push({ joinedAt: open, leftAt: e.time }); open = null; }
    }
  }
  if (open != null) sessions.push({ joinedAt: open, leftAt: null });
  return sessions;
}

/**
 * Derive the attendee shape the UI consumes from a raw record
 * ({ email, events }). `present` is derived from an unclosed session — not from any
 * live `isPresent` flag — so stored/migrated/imported data is always self-consistent.
 */
export function deriveAttendee(p) {
  const events = (Array.isArray(p && p.events) ? p.events : []).filter(e => e && e.time && e.type);
  const sessions = sessionsFromEvents(events);
  const last = sessions[sessions.length - 1] || null;
  const present = !!last && last.leftAt === null;
  const firstSeen = sessions.length ? sessions[0].joinedAt : null;

  let lastLeft = null;
  let closedMs = 0;
  for (const s of sessions) {
    if (s.leftAt) { lastLeft = s.leftAt; closedMs += Math.max(0, ms(s.leftAt) - ms(s.joinedAt)); }
  }

  return {
    email: (p && p.email) || null,
    present,
    firstSeen,
    lastLeft: present ? null : lastLeft,
    joinedAt: present ? last.joinedAt : firstSeen, // current session start if present, else first
    totalSeconds: Math.floor(closedMs / 1000),
    sessions,
    events
  };
}

/** Seconds a participant was present, open sessions clamped to `endMs`. */
export function presenceSeconds(attendee, endMs) {
  if (!attendee) return 0;
  const sessions = attendee.sessions && attendee.sessions.length
    ? attendee.sessions
    : sessionsFromEvents(attendee.events);
  const cap = Number.isFinite(endMs) ? endMs : Date.now();
  let total = 0;
  for (const s of sessions) {
    const start = ms(s.joinedAt);
    if (Number.isNaN(start)) continue;
    const end = s.leftAt ? ms(s.leftAt) : cap;
    total += Math.max(0, end - start);
  }
  return Math.floor(total / 1000);
}

/* ============================ meeting-level ============================ */

export function anyPresent(meeting) {
  return Object.values((meeting && meeting.attendance) || {}).some(p => p && p.present);
}

/** Latest observable timestamp across events / derived fields / endedAt. */
export function lastActivityMs(meeting) {
  let latest = 0;
  Object.values((meeting && meeting.attendance) || {}).forEach(p => {
    (p.events || []).forEach(e => { const t = ms(e.time); if (t > latest) latest = t; });
    ['firstSeen', 'lastLeft', 'joinedAt'].forEach(k => { const t = ms(p[k]); if (t > latest) latest = t; });
  });
  if (meeting && meeting.endedAt) { const t = ms(meeting.endedAt); if (t > latest) latest = t; }
  return latest;
}

/** In-progress but abandoned (browser closed without a clean end) for > STALE_MS. */
export function isStale(meeting) {
  if (!meeting || meeting.endedAt) return false;
  if (!anyPresent(meeting)) return false;
  const last = lastActivityMs(meeting);
  return last > 0 && (Date.now() - last) > STALE_MS;
}

export function isInProgress(meeting) {
  if (!meeting || meeting.endedAt) return false;
  return anyPresent(meeting) && !isStale(meeting);
}

/** Earliest join across all participants (Infinity when nobody ever joined). */
function earliestJoinMs(meeting) {
  let earliest = Infinity;
  Object.values((meeting && meeting.attendance) || {}).forEach(p => {
    const fs = p.firstSeen || (p.sessions && p.sessions[0] && p.sessions[0].joinedAt) || p.joinedAt;
    const t = ms(fs);
    if (!Number.isNaN(t)) earliest = Math.min(earliest, t);
  });
  return earliest;
}

/**
 * The window actually observed — earliest join to last activity — ignoring any
 * scheduled hours. This is what tracking saw; `meetingBounds` is what the meeting
 * officially was.
 */
export function observedBounds(meeting) {
  const earliest = earliestJoinMs(meeting);
  const startMs = earliest !== Infinity ? earliest : ms(meeting && meeting.date);
  const endMs = isInProgress(meeting) ? Date.now() : lastActivityMs(meeting);
  return { startMs, endMs: endMs || startMs };
}

/**
 * Meeting start — the scheduled start when one is known (from the calendar event or set
 * by hand), otherwise the authoritative `date` pulled back to the earliest join.
 *
 * The scheduled value is deliberately NOT pulled back: joining the call early must not
 * drag the start with it, or everyone arriving on time is counted as late.
 */
export function meetingStartMs(meeting) {
  const scheduled = ms(meeting && meeting.scheduledStart);
  if (!Number.isNaN(scheduled)) return scheduled;

  let start = meeting && meeting.date ? ms(meeting.date) : NaN;
  const earliest = earliestJoinMs(meeting);
  if (Number.isNaN(start)) start = earliest;
  else if (earliest !== Infinity) start = Math.min(start, earliest);
  return Number.isFinite(start) ? start : NaN;
}

/**
 * Meeting end — "now" while genuinely live (an open session can't run into the future),
 * else the scheduled end when known, else endedAt, else frozen at last activity.
 */
export function meetingEndMs(meeting) {
  if (isInProgress(meeting)) return Date.now();
  const scheduled = ms(meeting && meeting.scheduledEnd);
  if (!Number.isNaN(scheduled)) return scheduled;
  if (meeting && meeting.endedAt) return ms(meeting.endedAt);
  return lastActivityMs(meeting);
}

export function meetingBounds(meeting) {
  return { startMs: meetingStartMs(meeting), endMs: meetingEndMs(meeting) };
}

/** Are the meeting's hours pinned (calendar event or hand-set) rather than derived? */
export function hasSchedule(meeting) {
  return !!(meeting && (meeting.scheduledStart || meeting.scheduledEnd));
}

/** Effective start / end as ISO strings, for display and formatting (null if unknown). */
export function meetingStartIso(meeting) {
  const t = meetingStartMs(meeting);
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : ((meeting && meeting.date) || null);
}
export function meetingEndIso(meeting) {
  const t = meetingEndMs(meeting);
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : ((meeting && meeting.endedAt) || null);
}

export function meetingDurationSeconds(meeting) {
  const { startMs, endMs } = meetingBounds(meeting);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.floor((endMs - startMs) / 1000);
}

/** Seconds a participant was present in this meeting, clamped to its end. */
export function liveSecondsFor(attendee, meeting) {
  return presenceSeconds(attendee, meetingEndMs(meeting));
}

/** Whole minutes a participant arrived after the meeting start (0 if on time / early). */
export function latenessMinutes(attendee, meeting) {
  const startMs = meetingStartMs(meeting);
  const fs = attendee && attendee.firstSeen;
  const fsMs = ms(fs);
  if (Number.isNaN(fsMs) || !Number.isFinite(startMs)) return 0;
  const diff = (fsMs - startMs) / 60000;
  return diff > 0 ? Math.round(diff) : 0;
}

export function isLate(attendee, meeting, thresholdMin) {
  return latenessMinutes(attendee, meeting) > (Number(thresholdMin) || 0);
}

/** Attendance share (0–100) of the meeting duration. */
export function sharePct(attendee, meeting) {
  const dur = meetingDurationSeconds(meeting);
  if (dur <= 0) return 0;
  return Math.min(100, Math.round((liveSecondsFor(attendee, meeting) / dur) * 100));
}

/**
 * Status for one attendee in one meeting.
 *   state: 'present' (still in call) | 'left' (attended, gone) | 'late' | 'absent'
 * `late` is orthogonal and also returned as a flag.
 */
export function statusFor(attendee, meeting, thresholdMin) {
  const late = isLate(attendee, meeting, thresholdMin);
  const state = late ? 'late' : (attendee && attendee.present ? 'present' : 'left');
  return {
    state,
    late,
    lateMinutes: latenessMinutes(attendee, meeting),
    present: !!(attendee && attendee.present),
    seconds: liveSecondsFor(attendee, meeting),
    sharePct: sharePct(attendee, meeting)
  };
}

/* ============================ roster / absence ============================ */

const norm = (s) => String(s || '').trim().toLowerCase();

/** Roster names (expected attendees) who never appeared in this meeting. */
export function absenteesFor(meeting, roster) {
  const present = new Set(Object.keys((meeting && meeting.attendance) || {}).map(norm));
  return (Array.isArray(roster) ? roster : [])
    .filter(name => name && !present.has(norm(name)));
}

/* ============================ groups / series ============================ */

/** Group meetings by their Meet code — the natural signal that they are a recurring series. */
export function seriesByCode(meetings) {
  const map = new Map();
  (meetings || []).forEach(m => {
    const code = m.meetingCode || (isMeetCode(m.id) ? m.id : null);
    if (!code) return;
    if (!map.has(code)) map.set(code, []);
    map.get(code).push(m);
  });
  return map; // code -> [meetings]
}

/**
 * Aggregate a set of meetings (a group) into a people × sessions matrix plus per-person
 * totals. Anyone who attended any session is a row; roster names who never attended are
 * added as fully-absent rows. Not attending a session counts as 'absent' for that column.
 */
export function aggregateGroup(meetings, roster, thresholdMin) {
  const sorted = (meetings || []).slice().sort((a, b) => ms(a.date) - ms(b.date));
  const sessions = sorted.map(m => ({
    id: m.id,
    date: meetingStartIso(m),
    title: m.meetingTitle,
    durationSeconds: meetingDurationSeconds(m)
  }));

  // Union of attendee display names, keyed case-insensitively (first spelling wins).
  const nameByKey = new Map();
  const emailByKey = new Map();
  sorted.forEach(m => {
    Object.entries(m.attendance || {}).forEach(([name, a]) => {
      const k = norm(name);
      if (!nameByKey.has(k)) nameByKey.set(k, name);
      if (a && a.email && !emailByKey.get(k)) emailByKey.set(k, a.email);
    });
  });
  (roster || []).forEach(name => { const k = norm(name); if (!nameByKey.has(k)) nameByKey.set(k, name); });

  const people = [];
  nameByKey.forEach((displayName, key) => {
    const perSession = {};
    let attendedCount = 0;
    let totalSeconds = 0;
    let shareSum = 0;

    sorted.forEach(m => {
      const entry = Object.entries(m.attendance || {}).find(([n]) => norm(n) === key);
      if (entry) {
        const st = statusFor(entry[1], m, thresholdMin);
        const state = st.late ? 'late' : 'present';
        perSession[m.id] = { state, seconds: st.seconds, sharePct: st.sharePct };
        attendedCount++;
        totalSeconds += st.seconds;
        shareSum += st.sharePct;
      } else {
        perSession[m.id] = { state: 'absent', seconds: 0, sharePct: 0 };
      }
    });

    people.push({
      name: displayName,
      email: emailByKey.get(key) || null,
      perSession,
      attendedCount,
      totalSeconds,
      avgShare: sessions.length ? Math.round(shareSum / sessions.length) : 0,
      attendedShare: sessions.length ? Math.round((attendedCount / sessions.length) * 100) : 0
    });
  });

  // Most-committed first, then name.
  people.sort((a, b) =>
    b.attendedCount - a.attendedCount ||
    b.totalSeconds - a.totalSeconds ||
    a.name.localeCompare(b.name)
  );

  return {
    sessions,
    people,
    sessionCount: sessions.length,
    peopleCount: people.length,
    totalDurationSeconds: sessions.reduce((s, x) => s + x.durationSeconds, 0)
  };
}

/* ============================ name aliases ============================ */

/**
 * A meeting may carry a `nameMap` — { normalizedSourceName: displayName } — recorded when
 * the user renames a participant or merges two of them (same person, different Meet name).
 * The content script keeps reporting raw scraped names during a live meeting, so the map
 * is re-applied on every write (storage.upsertMeeting) and defensively on read
 * (normalizeMeeting) instead of being a one-off rewrite.
 */

/** Display name for a raw name under a nameMap (follows chains, guarded). */
export function resolveMappedName(name, nameMap) {
  let cur = String(name == null ? '' : name);
  if (!nameMap) return cur;
  for (let i = 0; i < 20; i++) {
    const next = nameMap[norm(cur)];
    if (typeof next !== 'string' || !next.trim() || next === cur) break;
    cur = next;
  }
  return cur;
}

/** Raw events of an attendee, reconstructed from sessions for legacy no-events records. */
function eventsOf(a) {
  if (Array.isArray(a && a.events) && a.events.length) return a.events;
  const evs = [];
  (Array.isArray(a && a.sessions) ? a.sessions : []).forEach(s => {
    if (!s || !s.joinedAt) return;
    evs.push({ time: s.joinedAt, type: 'Join' });
    if (s.leftAt) evs.push({ time: s.leftAt, type: 'Leave' });
  });
  return evs;
}

/**
 * Apply a nameMap to an attendance object: rename keys and, when two entries land on
 * the same person, merge them by concatenating their raw events and re-deriving.
 * Idempotent — safe to run on both write and read paths.
 */
export function applyNameMap(attendance, nameMap) {
  const src = attendance || {};
  if (!nameMap || !Object.keys(nameMap).length) return { ...src };

  const buckets = new Map(); // norm(target) -> { name: display target, list: [attendee] }
  for (const name in src) {
    const target = resolveMappedName(name, nameMap);
    const k = norm(target);
    if (!buckets.has(k)) buckets.set(k, { name: target, list: [] });
    buckets.get(k).list.push(src[name]);
  }

  const out = {};
  buckets.forEach(({ name, list }) => {
    if (list.length === 1) { out[name] = list[0]; return; }
    const events = list.flatMap(eventsOf);
    const email = list.map(a => a && a.email).find(Boolean) || null;
    out[name] = deriveAttendee({ email, events });
  });
  return out;
}

/* ============================ normalization ============================ */

/**
 * Re-derive every attendee from its preserved `events`, and backfill `meetingCode`.
 * Runs during migration and defensively on read, so old / imported records gain
 * `sessions` / `firstSeen` / `lastLeft` and a consistent `present`.
 */
export function normalizeMeeting(meeting) {
  if (!meeting || typeof meeting !== 'object') return meeting;
  const attendance = {};
  const src = applyNameMap(meeting.attendance || {}, meeting.nameMap);
  for (const name in src) {
    const a = src[name] || {};
    if (Array.isArray(a.events) && a.events.length) {
      attendance[name] = deriveAttendee({ email: a.email, events: a.events });
    } else {
      // No raw events (unexpected) — keep what we have, fill the derived shape.
      const sessions = Array.isArray(a.sessions) ? a.sessions : [];
      attendance[name] = {
        email: a.email || null,
        present: !!a.present,
        firstSeen: a.firstSeen || a.joinedAt || null,
        lastLeft: a.present ? null : (a.lastLeft || a.leftAt || null),
        joinedAt: a.joinedAt || a.firstSeen || null,
        totalSeconds: a.totalSeconds || 0,
        sessions,
        events: []
      };
    }
  }
  const meetingCode = meeting.meetingCode || (isMeetCode(meeting.id) ? meeting.id : null);
  return { ...meeting, meetingCode, attendance };
}

/** Build a canonical meeting record from an in-memory service-worker meeting. */
export function buildMeetingRecord(m) {
  const attendance = {};
  const parts = (m && m.participants) || {};
  for (const name in parts) attendance[name] = deriveAttendee(parts[name]);

  const startIso = (m && (m.startTime || m.date)) || new Date().toISOString();
  const code = (m && (m.meetingCode || (isMeetCode(m.meetingId) ? m.meetingId : null))) || null;
  const id = (m && m.id) || makeSessionId(code || (m && m.meetingId), ms(startIso));

  const record = {
    id,
    meetingCode: code,
    date: startIso,
    endedAt: (m && (m.endTime || m.endedAt)) || null,
    meetingTitle: (m && (m.meetingTitle || m.title)) || code || id,
    url: (m && m.url) || '',
    attendance
  };
  if (m && m.groupId) record.groupId = m.groupId;
  return record;
}

/** Convert a stored meeting back into raw SW participants (round-trips via events). */
export function rawParticipantsFromMeeting(meeting) {
  const parts = {};
  Object.entries((meeting && meeting.attendance) || {}).forEach(([name, a]) => {
    parts[name] = { name, email: a.email || null, events: (a.events || []).slice(), isPresent: !!a.present };
  });
  return parts;
}

/* ============================ csv ============================ */

function csvRow(cells) {
  return cells.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',');
}

/** Plain (English) per-participant CSV — used by the popup's quick export. */
export function meetingToCSV(meeting, thresholdMin) {
  const rows = [['Name', 'Email', 'First seen', 'Last left', 'Time (s)', 'Share %', 'Status']];
  Object.entries((meeting && meeting.attendance) || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([name, a]) => {
      const st = statusFor(a, meeting, thresholdMin);
      rows.push([
        name, a.email || '', a.firstSeen || '', a.present ? '' : (a.lastLeft || ''),
        st.seconds, st.sharePct, st.late ? 'Late' : (a.present ? 'In call' : 'Left')
      ]);
    });
  return rows.map(csvRow).join('\n');
}
