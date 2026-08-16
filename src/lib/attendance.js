/**
 * Attendance core — pure derivation & aggregation (no chrome.* here).
 *
 * The raw source of truth for every participant is `events: [{time, type:'Join'|'Leave'}]`.
 * Everything else (sessions, presence, durations, status, group roll-ups) is derived from
 * those events so the whole app reads one consistent model.
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

/**
 * How long the last sign of life is worth believing. The page reports in once a minute even when
 * nobody comes or goes, so a missed beat or two is a busy machine — past that, nothing is
 * watching the call any more and the record can only be read as unfinished.
 */
export const LIVE_SIGNAL_MS = 3 * 60 * 1000;
/** A meeting re-opened within this window (refresh / rejoin) resumes the same record. */
export const RESUME_WINDOW_MS = 3 * 60 * 60 * 1000;
/**
 * A record that already ended still resumes for this long. Reloading the tab ends the meeting
 * on the way out (the page reports every remaining participant as gone), so without a short
 * grace period the same call would come back as a second, separate record.
 */
export const REJOIN_WINDOW_MS = 2 * 60 * 1000;

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

/**
 * When a session id says it began, or NaN for an id that does not say. The other direction of
 * makeSessionId, and the only thing that can date a record the spreadsheet lists without reading
 * the record itself — which is what keeps the check on a backup cheap.
 */
export function sessionStartMs(id) {
  const stamp = /-(\d{10,})$/.exec(String(id == null ? '' : id));
  return stamp ? Number(stamp[1]) : NaN;
}

/* ============================ per-participant ============================ */

/** Join sorts before Leave at an identical timestamp — see sessionsFromEvents. */
function eventRank(type) {
  return type === 'Join' ? 0 : 1;
}

/**
 * Fold Join/Leave events into presence sessions — the *union* of the intervals they
 * describe, not a strict alternation.
 *
 * A merge (two Meet identities of the same person, see `applyNameMap`) concatenates two
 * event streams, and those streams overlap: one identity leaves after — or at the very
 * moment — the other joins. Pairing each Join with the next Leave would close the session
 * on the wrong stream's Leave and silently drop every overlapping stretch, so a merged
 * person lost most of their time. Counting open joins instead keeps the session open until
 * the Leave that balances the last one, which is the only reading that can't lose presence.
 *
 * Ties sort Join first so a hand-off (one identity leaves in the same scan tick the other
 * joins) reads as one continuous session rather than two touching ones. A stray Leave with
 * nothing open is ignored; a trailing open Join yields `leftAt: null` (still present).
 */
export function sessionsFromEvents(events) {
  const evs = (Array.isArray(events) ? events : [])
    .filter(e => e && e.time && e.type && !Number.isNaN(ms(e.time)))
    .slice()
    .sort((a, b) => ms(a.time) - ms(b.time) || eventRank(a.type) - eventRank(b.type));

  const sessions = [];
  let open = null;
  let depth = 0; // how many identities/streams are currently inside the call
  for (const e of evs) {
    if (e.type === 'Join') {
      if (depth === 0) open = e.time;
      depth++;
    } else if (e.type === 'Leave') {
      if (depth === 0) continue; // unmatched Leave — nothing is open to close
      if (--depth === 0) { sessions.push({ joinedAt: open, leftAt: e.time }); open = null; }
    }
  }
  if (open != null) sessions.push({ joinedAt: open, leftAt: null });
  return sessions;
}

/**
 * Derive the attendee shape the UI consumes from a raw record
 * ({ email, events }). `present` is derived from an unclosed session — not from any
 * live `isPresent` flag — so stored/migrated/imported data is always self-consistent.
 *
 * `mergedFrom` (the scraped names folded into this person) is carried through when given,
 * so a merged row stays labelled as one all the way to the UI and the exports.
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

  const out = {
    email: (p && p.email) || null,
    present,
    firstSeen,
    lastLeft: present ? null : lastLeft,
    joinedAt: present ? last.joinedAt : firstSeen, // current session start if present, else first
    totalSeconds: Math.floor(closedMs / 1000),
    sessions,
    events
  };
  const from = Array.isArray(p && p.mergedFrom) ? p.mergedFrom.filter(Boolean) : [];
  if (from.length > 1) out.mergedFrom = from.slice();
  return out;
}

/** Seconds one session overlaps the supplied attendance window. */
export function boundedSessionSeconds(session, startMs = -Infinity, endMs = Date.now()) {
  const joined = ms(session && session.joinedAt);
  const left = session && session.leftAt ? ms(session.leftAt) : endMs;
  const from = Math.max(joined, startMs);
  const to = Math.min(left, endMs);
  return Number.isFinite(from) && Number.isFinite(to) && to > from
    ? Math.floor((to - from) / 1000)
    : 0;
}

/** Seconds a participant was present inside `[startMs, endMs]`. */
export function presenceSeconds(attendee, endMs, startMs = -Infinity) {
  if (!attendee) return 0;
  const sessions = attendee.sessions && attendee.sessions.length
    ? attendee.sessions
    : sessionsFromEvents(attendee.events);
  const cap = Number.isFinite(endMs) ? endMs : Date.now();
  const floor = Number.isFinite(startMs) ? startMs : -Infinity;
  return sessions.reduce((total, session) =>
    total + boundedSessionSeconds(session, floor, cap), 0);
}

/** Position one session on a timeline, or null when it has no duration inside it. */
export function timelineSegmentBox(sessionStartMs, sessionEndMs, startMs, endMs, span = endMs - startMs) {
  const from = Math.max(sessionStartMs, startMs);
  const to = Math.min(sessionEndMs, endMs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(span) || span <= 0 || to <= from) {
    return null;
  }
  return {
    left: (from - startMs) / span * 100,
    width: Math.max(0.6, (to - from) / span * 100)
  };
}

/* ============================ meeting-level ============================ */

export function anyPresent(meeting) {
  return Object.values((meeting && meeting.attendance) || {}).some(p => p && p.present);
}

/**
 * Latest observable timestamp across events / derived fields / endedAt, and `liveAt` — the
 * watermark tracking leaves behind while it runs. A quiet call records nothing between its
 * joins, so without the watermark the last thing known about a meeting the browser took with
 * it would be somebody arriving an hour before it stopped.
 */
export function lastActivityMs(meeting) {
  let latest = 0;
  Object.values((meeting && meeting.attendance) || {}).forEach(p => {
    (p.events || []).forEach(e => { const t = ms(e.time); if (t > latest) latest = t; });
    ['firstSeen', 'lastLeft', 'joinedAt'].forEach(k => { const t = ms(p[k]); if (t > latest) latest = t; });
  });
  ['liveAt', 'endedAt'].forEach(k => { const t = ms(meeting && meeting[k]); if (t > latest) latest = t; });
  return latest;
}

/**
 * Does this meeting carry a Join or a Leave later than `iso`?
 *
 * What a write has to show before it is allowed to reopen a call that already ended: the call
 * coming back is somebody arriving after the end, while a message still in flight when it
 * finished carries nothing newer than the end it would otherwise undo.
 */
export function hasEventsAfter(meeting, iso) {
  const after = ms(iso);
  if (Number.isNaN(after)) return true;   // no end to protect
  return Object.values((meeting && meeting.attendance) || {})
    .some(p => (p.events || []).some(e => ms(e.time) > after));
}

/** Time since anything was known to be reporting into this meeting (Infinity if nothing ever was). */
function sinceLastSignMs(meeting, now) {
  const last = lastActivityMs(meeting);
  return last > 0 ? now - last : Infinity;
}

/**
 * What a record is, which is as much a question about its last sign of life as about its end:
 *
 *   'live'       — no end, somebody inside it, and something reported in a moment ago.
 *   'unfinished' — no end, and nothing has reported in for longer than that. The browser was
 *                  killed, the extension went away mid-call, or the record came in from a CSV
 *                  exported while the call was still running. Nothing ended it, and nothing
 *                  about it is growing either — it stopped where its last sign of life is.
 *   'ended'      — it carries an end; or the call is plainly over and the page is still
 *                  reporting, which is the moment between the last person leaving and the end
 *                  arriving.
 *
 * The signal is what keeps a call the browser was killed on from reading as live: presence alone
 * cannot tell the two apart, because an abandoned record has everyone still standing inside it.
 * Going quiet is never read as "ended", only as "nobody can say" — the difference the UI shows.
 */
export function meetingState(meeting, now = Date.now()) {
  if (!meeting || meeting.endedAt) return 'ended';
  if (sinceLastSignMs(meeting, now) >= LIVE_SIGNAL_MS) return 'unfinished';
  return anyPresent(meeting) ? 'live' : 'ended';
}

/**
 * Is the call happening right now? This is also the question "does its clock still run?": only a
 * live call's does, so an abandoned record stops at its last sign of life rather than growing with
 * the wall clock for as long as it takes somebody to notice it.
 */
export function isLive(meeting, now) {
  return meetingState(meeting, now) === 'live';
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
  const endMs = isLive(meeting) ? Date.now() : lastActivityMs(meeting);
  return { startMs, endMs: endMs || startMs };
}

/**
 * Meeting start — the scheduled start when one is known (from the calendar event or set
 * by hand), otherwise the authoritative `date` pulled back to the earliest join.
 *
 * The scheduled value is deliberately NOT pulled back: joining the call early must not
 * drag the start with it, or the meeting reads as longer than it was and everyone's
 * share of it drops.
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
  if (isLive(meeting)) return Date.now();
  const scheduled = ms(meeting && meeting.scheduledEnd);
  if (!Number.isNaN(scheduled)) return scheduled;
  if (meeting && meeting.endedAt) return ms(meeting.endedAt);
  return lastActivityMs(meeting);
}

/**
 * The start a meeting is measured from, which is not always the start it is filed under.
 *
 * Official hours can sit ahead of what is happening: people gather before the hour, and a schedule
 * read off the wrong event can miss the call altogether. Measured from a start it has not reached,
 * a call in progress has no length and nobody has attended any of it — the clock stands at nothing
 * while the meeting is plainly on, and every share of it reads as zero. So where the official start
 * is not behind the end, the figures are taken from what tracking saw instead. The hours themselves
 * are left exactly as they are: they say what the meeting is, and printing them is not the same as
 * measuring with them.
 */
export function measuredStartMs(meeting) {
  const start = meetingStartMs(meeting);
  const endMs = meetingEndMs(meeting);
  if (!Number.isFinite(start) || !Number.isFinite(endMs) || start < endMs) return start;
  const observed = observedBounds(meeting).startMs;
  return Number.isFinite(observed) && observed < endMs ? observed : start;
}

/** The window a meeting's figures are drawn and counted over. */
export function meetingBounds(meeting) {
  return { startMs: measuredStartMs(meeting), endMs: meetingEndMs(meeting) };
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

/** Seconds a participant was present inside this meeting's measured bounds. */
export function liveSecondsFor(attendee, meeting) {
  const { startMs, endMs } = meetingBounds(meeting);
  return presenceSeconds(attendee, endMs, startMs);
}

/** Attendance share (0–100) of the meeting duration. */
export function sharePct(attendee, meeting) {
  const dur = meetingDurationSeconds(meeting);
  if (dur <= 0) return 0;
  return Math.min(100, Math.round((liveSecondsFor(attendee, meeting) / dur) * 100));
}

/**
 * Status for one attendee in one meeting.
 *   state: 'present' (was in the call at some point) | 'absent' (never showed up)
 *
 * Attendance is binary and nothing else: arriving late or leaving early doesn't make someone
 * less present. Whether they are in the call *right now* is a live detail, reported as
 * `inCall` rather than as a status of its own. How long and how much of the meeting they were
 * there for is reported as time and share, which is where nuance belongs.
 */
export function statusFor(attendee, meeting) {
  return {
    state: attendee ? 'present' : 'absent',
    inCall: !!(attendee && attendee.present),
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
export function aggregateGroup(meetings, roster) {
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

  // Share across the whole series is measured against the summed meeting hours, not against
  // the sessions a person happened to attend — missing a session has to cost.
  const totalDuration = sessions.reduce((s, x) => s + x.durationSeconds, 0);

  const people = [];
  nameByKey.forEach((displayName, key) => {
    const perSession = {};
    let attendedCount = 0;
    let totalSeconds = 0;
    let shareSum = 0;

    sorted.forEach(m => {
      const entry = Object.entries(m.attendance || {}).find(([n]) => norm(n) === key);
      if (entry) {
        const st = statusFor(entry[1], m);
        perSession[m.id] = { state: st.state, seconds: st.seconds, sharePct: st.sharePct };
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
      attendedShare: sessions.length ? Math.round((attendedCount / sessions.length) * 100) : 0,
      totalShare: totalDuration > 0 ? Math.min(100, Math.round((totalSeconds / totalDuration) * 100)) : 0
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
    totalDurationSeconds: totalDuration
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

/**
 * Split an event list into the streams it was concatenated from. One participant's events are
 * appended in real time, so they only ever move forward; a step backwards means another
 * stream starts there. Returns a single stream when the list is already monotonic.
 *
 * Used to take apart records merged by an older version, which folded both participants'
 * events into one entry and dropped the other name.
 */
export function splitConcatenatedEvents(events) {
  const streams = [];
  let cur = [];
  let prev = -Infinity;
  for (const e of (Array.isArray(events) ? events : [])) {
    const t = ms(e && e.time);
    if (Number.isNaN(t)) continue;
    if (t < prev && cur.length) { streams.push(cur); cur = []; }
    cur.push(e);
    prev = t;
  }
  if (cur.length) streams.push(cur);
  return streams;
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
 * the same person, merge them by concatenating their raw events and re-deriving. The
 * scraped names behind a merged row are kept as `mergedFrom`, which is what lets the UI
 * label the row and offer to split it again.
 *
 * This is a *view*: storage keeps the entries separate and the map beside them, so a merge
 * is applied on every read and stays undoable (storage.unmergeParticipant). Idempotent.
 */
export function applyNameMap(attendance, nameMap) {
  const src = attendance || {};
  if (!nameMap || !Object.keys(nameMap).length) return { ...src };

  const buckets = new Map(); // norm(target) -> { name: display target, list: [{ from, attendee }] }
  for (const name in src) {
    const target = resolveMappedName(name, nameMap);
    const k = norm(target);
    if (!buckets.has(k)) buckets.set(k, { name: target, list: [] });
    buckets.get(k).list.push({ from: name, attendee: src[name] });
  }

  const out = {};
  buckets.forEach(({ name, list }) => {
    if (list.length === 1) { out[name] = list[0].attendee; return; }
    const events = list.flatMap(x => eventsOf(x.attendee));
    const email = list.map(x => x.attendee && x.attendee.email).find(Boolean) || null;
    out[name] = deriveAttendee({ email, events, mergedFrom: list.map(x => x.from) });
  });
  return out;
}

/**
 * Annotate an *unmerged* meeting for export: every entry that a rename or a merge folds into
 * another name gets `mergeInto: "<display name>"` beside its own events.
 *
 * A backup has to carry the participants as they were recorded — the raw Meet identities — or
 * re-importing it hands back one lump with no way to take it apart. The `nameMap` beside them
 * is what restores the merge, and this annotation is the same instruction written where a
 * human reading the file will see it. The map stays authoritative; entries whose alias only
 * restyles their own name (a rename, "edyta tatara" → "EDYTA TATARA") are left alone.
 */
export function annotateMerges(meeting) {
  const nameMap = meeting && meeting.nameMap;
  if (!nameMap || !Object.keys(nameMap).length) return meeting;

  const attendance = { ...((meeting && meeting.attendance) || {}) };
  let changed = false;
  for (const name in attendance) {
    const target = resolveMappedName(name, nameMap);
    if (!target || norm(target) === norm(name)) continue;
    attendance[name] = { ...attendance[name], mergeInto: target };
    changed = true;
  }
  return changed ? { ...meeting, attendance } : meeting;
}

/**
 * The other direction, for import: fold `mergeInto` annotations back into the meeting's
 * nameMap so a file that carries them (ours, or one edited by hand) merges on read like any
 * locally-made merge. An explicit nameMap entry wins — the annotation only fills gaps.
 *
 * The annotations themselves don't survive `normalizeMeeting`, which rebuilds each attendee
 * from its events, so nothing stale is written to storage.
 */
export function adoptMergeAnnotations(meeting) {
  const attendance = (meeting && meeting.attendance) || null;
  if (!attendance) return meeting;

  const nameMap = { ...((meeting && meeting.nameMap) || {}) };
  let changed = false;
  for (const name in attendance) {
    const target = attendance[name] && attendance[name].mergeInto;
    if (typeof target !== 'string' || !target.trim()) continue;
    const key = norm(name);
    if (nameMap[key]) continue;
    nameMap[key] = target.trim();
    changed = true;
  }
  return changed ? { ...meeting, nameMap } : meeting;
}

/* ============================ normalization ============================ */

/**
 * Re-derive every attendee from its preserved `events`, and backfill `meetingCode`.
 * Runs during migration and defensively on read, so old / imported records gain
 * `sessions` / `firstSeen` / `lastLeft` and a consistent `present`.
 *
 * Renames and merges are applied on the way out. Pass `{ mergeAliases: false }` when the
 * result goes back to storage, which keeps participants separate — see storage.upsertMeeting.
 */
export function normalizeMeeting(meeting, { mergeAliases = true } = {}) {
  if (!meeting || typeof meeting !== 'object') return meeting;
  const attendance = {};
  const src = mergeAliases ? applyNameMap(meeting.attendance || {}, meeting.nameMap) : (meeting.attendance || {});
  for (const name in src) {
    const a = src[name] || {};
    if (Array.isArray(a.events) && a.events.length) {
      attendance[name] = deriveAttendee({ email: a.email, events: a.events, mergedFrom: a.mergedFrom });
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
      if (Array.isArray(a.mergedFrom) && a.mergedFrom.length > 1) attendance[name].mergedFrom = a.mergedFrom.slice();
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

/* ============================ live tracking ============================ */

const eventKey = (e) => `${e.time}|${e.type}`;

function usableEvents(events) {
  return (Array.isArray(events) ? events : [])
    .filter(e => e && e.time && e.type && !Number.isNaN(ms(e.time)))
    .slice()
    .sort((a, b) => ms(a.time) - ms(b.time) || eventRank(a.type) - eventRank(b.type));
}

/** Does this stream leave the person inside the call? */
function endsOpen(events) {
  const sessions = sessionsFromEvents(events);
  return sessions.length > 0 && sessions[sessions.length - 1].leftAt === null;
}

function lastEventMs(events) {
  return events.length ? ms(events[events.length - 1].time) : -Infinity;
}

/** Earliest event across a whole participants map (Infinity when there are none). */
function earliestEventMs(participants) {
  let earliest = Infinity;
  Object.values(participants || {}).forEach(p => {
    usableEvents(p && p.events).forEach(e => { const t = ms(e.time); if (t < earliest) earliest = t; });
  });
  return earliest;
}

/**
 * Write the Leave that never arrived.
 *
 * A page that stops reporting without saying so — the browser was closed on it, the extension was
 * switched off — leaves its people standing inside the call, and every later read keeps counting
 * them. Recovery closes the stream itself, at `iso`: the last moment tracking was known to be
 * running, which is the last moment anything is known about the call at all.
 *
 * Never earlier than the stream's own last event, so a watermark that lags behind what was
 * recorded can't close a session before the join that opened it.
 */
export function closeOpenEvents(events, iso) {
  const evs = usableEvents(events);
  if (!endsOpen(evs)) return evs;
  const at = Math.max(ms(iso) || 0, lastEventMs(evs));
  return evs.concat({ time: new Date(at).toISOString(), type: 'Leave' });
}

/** The same over a whole map of raw participants: nobody is left inside the call. */
export function closeOpenParticipants(participants, iso) {
  const out = {};
  for (const name in (participants || {})) {
    const p = participants[name] || {};
    out[name] = { ...p, events: closeOpenEvents(p.events, iso), isPresent: false };
  }
  return out;
}

/**
 * Fold a fresh event stream into one already held for the same person, keeping both.
 *
 * A stream still held open is closed where the fresh one picks the person up again: the earlier
 * stream was abandoned (the page went away), not left running, so the Leave that would have
 * balanced it never arrives. Without that close the two Joins outnumber the Leaves and the
 * person reads as never having left.
 */
function mergeEventStreams(held, fresh) {
  const prior = usableEvents(held);
  const next = usableEvents(fresh);
  if (!prior.length) return next;
  if (!next.length) return prior;

  const seen = new Set(prior.map(eventKey));
  const added = next.filter(e => !seen.has(eventKey(e)));
  if (!added.length) return prior;

  const resumesAt = ms(added[0].time);
  const out = prior.concat(added);
  if (added[0].type === 'Join' && resumesAt >= lastEventMs(prior) && endsOpen(prior)) {
    out.push({ time: added[0].time, type: 'Leave' });
  }
  return usableEvents(out);   // one canonical order, so merging the same scan again is a no-op
}

/**
 * Fold a tab's fresh scan into what it reported before, matched by name.
 *
 * A page reload restarts the content script's own record of the call: it reports a stream that
 * begins again from the moment it rescanned, and the people it has not found again yet are
 * simply missing from it. Taking that scan as the whole truth would drop everything observed
 * before the reload, so the two are merged instead — events deduplicated by (time, type), and
 * anyone the fresh scan no longer knows about closed out where it picked the call back up
 * rather than left standing as present for the rest of the day.
 */
export function mergeRawParticipants(held, fresh) {
  const prior = (held && typeof held === 'object') ? held : {};
  const next = (fresh && typeof fresh === 'object') ? fresh : {};

  const out = {};
  const restart = Object.keys(prior).some(name => !(name in next));
  const resumesAt = restart ? earliestEventMs(next) : Infinity;

  for (const name in prior) {
    const a = prior[name];
    if (name in next) continue;                       // merged below, with the fresh entry
    const events = usableEvents(a && a.events);
    if (Number.isFinite(resumesAt) && resumesAt >= lastEventMs(events) && endsOpen(events)) {
      out[name] = { ...a, events: events.concat({ time: new Date(resumesAt).toISOString(), type: 'Leave' }), isPresent: false };
    } else {
      out[name] = a;
    }
  }
  for (const name in next) {
    const a = prior[name], b = next[name] || {};
    out[name] = a
      ? { ...a, ...b, email: b.email || a.email || null, events: mergeEventStreams(a.events, b.events) }
      : b;
  }
  return out;
}
