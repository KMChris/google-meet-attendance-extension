# Changelog

All notable changes to this project. This project adheres to [Semantic Versioning](https://semver.org/).

## [1.3.0] 2026-08-13

### Added
- **Analytics is now a filtered workbench.** One filter row scopes everything below it:
  a **date range** (7 / 30 / 90 days, 12 months, everything, or a custom from–to), a
  **series** picker and a **meeting** picker — both multi-select popovers that list only
  what the other filters still allow, with live counts. The slice is remembered between
  sessions and exports to CSV.
- **Headline numbers** — meetings, total time, people, average attendance and average meeting
  size, each against the previous period of the same length.
- **New charts** — meeting activity over time (buckets switch between day / week / month with
  the range), average length vs. presence, a **weekday × hour heatmap** of when meetings start,
  the distribution of attendance share, most frequent meetings, most present people, and a
  series comparison.
- **Read-outs** — busiest day, peak hour, longest meeting, biggest turnout, the most regular
  person, who stays longest and who leaves earliest, and the attendance trend.
- Every chart card flips to the **table it was drawn from**, so no value is only reachable
  by hovering, and each chart has a hover read-out.
- **Click a participant in a series** — the attendance matrix opens a panel with that person's
  exact presence in every session: the meeting hours as the track, their join/leave blocks on it
  and the same intervals written out, absent sessions included.
- **Every view has a URL** — `#meetings`, `#meeting=<id>`, `#groups`, `#group=<id>[&person=…]`,
  `#people[&person=…]`, `#analytics`, `#settings`. The browser's back and forward buttons work,
  views can be linked to, and the in-app back control lands where its label says.
- **Import a CSV this extension wrote** — Settings → *Import backup* now takes a JSON backup **or**
  a CSV of ours (a single meeting, a series file, or the combined export, in either language). Rows
  are matched back to the meetings they came from by the new `ID` column, so re-importing a file you
  already have adds nothing, and a series named in the file is matched to an existing one or created.
- **Import from another attendance extension** — Settings → *Import from another app* converts a
  backup and merges it in; RollCall (meet-attendance.com) is the first supported source.
- **Attendance share in every matrix cell**, on screen and in the series PDF, plus a **% of series**
  column in the report: time present against the summed meeting hours, so missing a whole session
  costs what it should.
- **Undo a merge** — a merged participant can be split back into the entries it was folded from.
- **Meeting hours** read out as an editable badge under the title, marked when they were set by hand.

### Changed
- **Attendance is binary.** Arriving late no longer makes anyone less present: the *late* status,
  the lateness threshold setting and the timeline's late marker are gone.
  How much of a meeting someone was there for is reported as time and share, which is where the
  nuance belongs.
- **Richer CSV exports.** One row per participant per meeting with the same columns everywhere
  (date, meeting, code, series, meeting hours and length, participant, e-mail, status, first seen,
  last left, presence as `HH:MM:SS` *and* in minutes, share, presence blocks, **joins & leaves as a
  JSON array**, merged-from names, and the meeting's id). The series file carries both readings: the
  matrix first, then the per-session detail. Files are CRLF + BOM so Excel opens them without
  mangling Polish. Times are minute-resolution, so a CSV round trip can come back up to a minute per
  session higher — the JSON backup is the lossless path.
- **The JSON backup no longer bakes merges in.** Participants export exactly as they were recorded,
  with the merge riding along as the meeting's `nameMap` plus a readable `mergeInto` on each folded
  entry; import folds them back and writes unmerged records, so a merge survives a round trip and
  can still be undone.
- **PDF reports open in the same tab** and carry their own *Back* button, which is hidden on paper.
- **Meeting detail** reworked: renaming is a pencil beside the title (as in the series head), and the
  action row matches the series — *Copy · Export CSV · PDF report · delete*.
- **Data model v4.**

### Fixed
- **A merged participant no longer loses time.** Two Meet identities of one person produce
  overlapping event streams; pairing each join with the next leave closed a session on the wrong
  stream's leave and silently dropped every overlapping stretch. Sessions are now the union of the
  intervals the events describe.
- **Importing no longer bakes existing merges in permanently** — the import path wrote the merged
  *view* back to storage, which made earlier merges impossible to undo.
- **Long meeting names are no longer sliced off** in "Most frequent meetings". Labels used a
  fixed 122px gutter and a blind 18-character cut, so a long title ran off the left edge of
  the canvas ("…kolenie - AI w p…"). The gutter is now measured from the actual labels and
  each one is fitted to the width it really has, with the full title in the hover read-out
  and the table view.
- **The series matrix header** showed the raw string `matrixPerson` instead of a heading.
- **CSV dates** were the UTC day, so a late-evening meeting could be filed a day early, and
  export file names no longer carry a 200-character meeting title.

### Migration
- v3 → v4 unbakes merges that earlier versions had written into the stored records: the folded
  entries come back under their own names with the merge kept as a `nameMap`, so they can be
  split apart again. Raw events are preserved and everything is re-derived.

## [1.2.1] 2026-08-12

### Added
- **Edit participant names & merge duplicates** — a pencil on each row of the meeting's
  attendance table opens an editor: fix the display name, or enter/pick another participant's
  name to **merge the two entries into one person** (their joins & leaves are combined and
  sessions, lateness and share re-derived). Useful when someone joins under a different name
  and is counted as a new person. Edits are stored as a per-meeting alias map (`nameMap`) and
  re-applied on every write, so they survive live-meeting updates, rejoins under the old name,
  and flow through to reports, CSV exports and Sheets sync.
- **Editable meeting hours** — an *Hours* button in the meeting detail pins the official start
  and end (`scheduledStart` / `scheduledEnd`). They are read automatically from the calendar
  event Meet displays when it can be found, and can always be corrected by hand; the editor
  shows the tracked activity window for reference and offers a way back to automatic.

### Fixed
- **Joining early no longer marks everyone late.** The tracked `date` is merely when the tab
  was opened, and the meeting start was pulled back to the earliest join — so opening the call
  15 minutes ahead flagged everyone arriving on time as 15 minutes late. Lateness, length and
  attendance share are now measured against the meeting's hours, and a scheduled start is never
  dragged backwards by an early join. Time actually connected is still reported in full.

## [1.2.0] 2026-07-24 · fork by [KMChris](https://github.com/KMChris/google-meet-attendance-extension)

First release of the fork — a full redesign plus new capabilities.

### Added
- **Design system** — a bespoke "presence instrument" look; the **presence timeline**
  (every join/leave per participant on the meeting clock) is the signature element.
- **Series** — bundle recurring sessions (e.g. a weekend training); recurring Meet links
  are auto-detected. Each series has an aggregate **attendance matrix** (people × sessions), its own
  roster, and its own report.
- **Dark mode** — follows the browser's `prefers-color-scheme`, with a System / Light / Dark override.
- **Technical PDF reports** — for a single meeting *and* for a whole series, including every
  join/leave event with session durations and roster reconciliation.
- Full **English + Polish** localization (auto-detected, switchable).
- **People** and **Analytics** views.
- **Unlimited storage** — the “Meetings to keep” setting adds an *Unlimited* option (plus a 1000 step) beside the existing caps.

### Changed
- **Data model v3**: unique per-session `id` (`<code>-<startMs>`) plus a separate `meetingCode`;
  derived `sessions` / `firstSeen` / `lastLeft`. Series stored under `meetingGroups`.
- **"Late"** is measured from the meeting start (previously: from the first participant to join).
- **Architecture**: dashboard / report / popup are ES-module pages importing a shared `src/lib`
  layer (`attendance.js`, `storage.js`, `i18n.js`); the service worker is slimmed to event
  ingestion, badge, migration and Sheets sync.
- **Typography**: Space Grotesk + IBM Plex Sans + IBM Plex Mono, self-hosted (latin + latin-ext).

### Fixed
- **Recurring meetings on the same link no longer overwrite each other** — each session is its own record.
- **"First seen"** now reports the first-ever join for participants who left and rejoined.
- **Durations** no longer tick forever for abandoned/stale meetings (clamped to the meeting end).

### Migration
- Legacy `meetings` objects and v2 records (without `sessions`/`meetingCode`) are migrated
  automatically on extension update; raw `events` are preserved and everything re-derived.

---

## Upstream history (starone99)

- **1.1.0**: Auto-sync to Google Sheets on meeting end.
- **1.0.1**: Extension key for a consistent extension ID.
- **1.0.0**: Initial release: real-time participant detection, local storage, CSV export.
