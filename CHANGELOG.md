# Changelog

All notable changes to this project. This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
  the distribution of attendance share,
  most frequent meetings, most present people, and a series comparison.
- **Read-outs** — busiest day, peak hour, longest meeting, biggest turnout, the most regular
  person, and the attendance trend.
- Every chart card flips to the **table it was drawn from**, so no value is only reachable
  by hovering, and each chart has a hover read-out.

### Fixed
- **Long meeting names are no longer sliced off** in "Most frequent meetings". Labels used a
  fixed 122px gutter and a blind 18-character cut, so a long title ran off the left edge of
  the canvas ("…kolenie - AI w p…"). The gutter is now measured from the actual labels and
  each one is fitted to the width it really has, with the full title in the hover read-out
  and the table view.
- The series attendance matrix header showed the raw string `matrixPerson` instead of
  "Person" / "Osoba".

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
