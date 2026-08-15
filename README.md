# Google Meet Attendance Tracker

A Chrome extension that automatically tracks participant attendance in Google Meet meetings.
Its interface is a bespoke "presence instrument" design whose signature is a
**presence timeline** that plots exactly when each participant was in the meeting, including
every time they left and rejoined.

## Features

- **Real-time Participant Detection**: Track participant join/leave events using MutationObserver and polling
- **Event-based Tracking**: Records each join and leave as a separate event with timestamp; presence, sessions, durations and shares are all derived from those raw events
- **Full Dashboard** (Meetings · Series · People · Analytics · Settings): search, rename, native canvas charts, and the presence timeline — opens as the extension's options page. Every view has its own URL, so the browser's back button works and any view can be linked to
- **A call in progress reads as one**: it is marked in the list, on its own page and beside the name of the app, with the time it has been running, and the panel follows it rather than freezing at the moment it was opened. A record nothing ever ended is marked apart from it, in amber, with the last moment anything was heard from the call — and can be closed at exactly that moment
- **Analytics**: filter by date range, series and meeting, then read the slice as headline numbers with period-over-period deltas, charts (activity over time, length vs. presence, a weekday × hour heatmap, attendance distribution, top meetings and people, series comparison) and derived read-outs. Every chart flips to the table behind it and exports to CSV
- **Series**: Bundle recurring sessions (e.g. a weekend training) into a series. Recurring links are auto-detected; each series has an aggregate **attendance matrix** (people × sessions, with each person's share of every session), per-series roster, and its own report. Click a person to see their exact joins and leaves in each session
- **Attendance is binary**: whoever was in the call is present. How much of it they were there for is reported as time and share — against the meeting's hours, which are read from the calendar event when Meet shows it and can always be corrected by hand
- **Editable participants**: fix a scraped display name, or merge two Meet identities into one person — and split them apart again later
- **Batch actions**: click a meeting's date badge or a person's avatar to select it, then act on the whole selection — add meetings to a series, export or delete them, merge participants, or add people to a roster
- **Exports**: per-meeting CSV, series CSV (matrix *and* per-session detail), combined CSV, JSON backup, clipboard, and detailed **technical PDF reports** — for a single meeting or a whole series — with every join/leave event, print-ready
- **Imports**: a JSON backup, a CSV this extension wrote, or a backup from another attendance extension (RollCall / meet-attendance.com) — always merged, never replacing what is already stored
- **Dark mode**: Follows the browser's light/dark preference, with a System / Light / Dark override in Settings
- **Localized**: Full English + Polish interface (auto-detected, switchable in Settings)
- **Local Storage**: Local data storage using the Chrome Storage API
- **Google Sheets Integration** (Optional): Two-way sync with a spreadsheet of your own via OAuth2. Finished meetings go up, meetings recorded on another machine come down, and everything can be restored from it, since the sheet keeps the full record

## Installation

### Developer Mode Installation

1. Clone or download this repository:
   ```bash
   git clone https://github.com/KMChris/google-meet-attendance-extension.git
   ```

2. Open Chrome browser and navigate to `chrome://extensions`

3. Enable **Developer mode** in the top right corner

4. Click **Load unpacked** button

5. Select the downloaded project folder

## Usage

### Basic Usage

1. Join a Google Meet meeting
2. The extension will automatically start tracking participants
3. Click the extension icon in the browser toolbar to view the current participant list
4. Use the **Export CSV** button to export attendance records

### Recorded Data

Each participant's join and leave is recorded as a separate event:

| Field | Description |
|-------|-------------|
| Name | Display name of the meeting participant |
| Email | Shown for same-organization users (optional) |
| Time | Timestamp of the event |
| Type | `Join` or `Leave` |

Everything else — sessions, presence, durations, share, series roll-ups — is derived from those
events, so the whole app reads one consistent model.

### Export & import

Two formats, and they answer different questions.

**CSV** is for a spreadsheet. All three exports (one meeting, a whole series, everything) write
the same row — one per participant per meeting:

| | |
|---|---|
| Meeting | date, title, Meet code, series, start, end, length |
| Person | participant, e-mail, status, first seen, last left |
| Presence | `HH:MM:SS`, minutes (for summing), share of the meeting |
| Detail | presence blocks, **joins & leaves** as a JSON array (`["08:58–17:00","17:10–"]`, an open range means still in the call), merged-from names, and the meeting's `ID` |

The series file carries both readings: the attendance matrix first, then a blank line and the
per-session detail. Files are UTF-8 with a BOM and CRLF line endings, so Excel opens them
without mangling anything.

**JSON** is the lossless backup: exact timestamps, groups, and participants exactly as they were
recorded — a merge travels as the meeting's `nameMap` plus a readable `mergeInto` beside each
folded entry, so it can still be undone after a restore.

Settings → **Import backup** takes either. A CSV of ours is matched back to the meetings it came
from by that `ID` column, so re-importing a file you already have adds nothing; its series name is
matched to an existing series or creates one. What CSV cannot carry: times are minute-resolution
(so totals can come back up to a minute per session higher), absentees are roster-derived rather
than data and are skipped, and a merged participant arrives as the one person the file shows.

Settings → **Import from another app** converts a backup written by a different attendance
extension — currently RollCall (meet-attendance.com) — and merges it in the same way.

### Google Sheets Integration (Optional)

Settings walks it in three steps: **connect a Google account**, **create a spreadsheet** (or paste
the ID of one you already have), then use it — auto-sync when a meeting ends, **Send everything**
to offer the whole register at once, or **Restore from the sheet** to read it all back.

The sheet has three tabs. *Meetings* and *Participants* are for reading: one row per meeting and
one row per join or leave. *Backup* is for the extension — it holds every record verbatim, which is
what makes the spreadsheet a complete backup: restoring from it brings back raw events, e-mails,
meeting hours, merges and series.

**Both directions only ever add.** Nothing in the extension removes or rewrites a record in the
sheet, and nothing the sheet holds removes a record from here:

- Sending sends the finished meetings the sheet has not got. One it already carries stays exactly
  as it was sent, so a meeting deleted here — or on another machine — survives in the backup.
- Restoring adds the records this copy has never seen. A meeting already here keeps whatever was
  edited about it, and one in the trash stays deleted.
- Both buttons say what they left as it was, and what to do about it: **to change or drop what the
  sheet holds, edit it in Google Sheets, or create a new sheet and send everything to that one.**

> ⚠️ Google Sheets sync needs an OAuth client ID **bound to your own extension ID**. The `oauth2.client_id`
> in `manifest.json` is a placeholder (`YOUR_OAUTH_CLIENT_ID…`) — create your own and paste it in, registering
> the ID Chrome gives your unpacked copy. See
> [Google Cloud Console Setup](#google-cloud-console-setup-for-sheets-integration) below. Everything except
> Sheets sync works without any of this.

## Project Structure

```
google-meet-attendance-extension/
├── manifest.json              # Extension configuration (Manifest V3)
├── icons/                     # Icon files (16, 32, 48, 128px)
├── dashboard/                 # Full-page dashboard (also the options page)
│   ├── dashboard.html
│   ├── dashboard.css          # Dashboard layout
│   ├── dashboard.js           # ES module: router, views, timeline, series, exports
│   ├── analytics.js           # The Analytics view: filters, KPIs, read-outs
│   └── charts.js              # Canvas chart primitives (bars, stacked, heatmap, ranked)
├── report/                    # Print-ready technical PDF report (meeting or series)
│   ├── report.html
│   ├── report.css
│   └── report.js
└── src/
    ├── content/
    │   └── content-script.js  # Google Meet participant detection (classic script)
    ├── background/
    │   └── service-worker.js  # Ingest events, session resume, badge, Sheets sync, migration
    ├── popup/
    │   ├── popup.html         # Compact live view + recent meetings
    │   ├── popup.css
    │   └── popup.js
    └── lib/                   # Shared ES-module data + UI layer
        ├── attendance.js      # Pure derivation & aggregation (sessions, status, groups)
        ├── storage.js         # chrome.storage CRUD (history, series, settings) + migration
        ├── importers.js       # Read our own CSV and other extensions' backups
        ├── i18n.js            # Runtime i18n (EN/PL) over the _locales catalogues
        ├── sheets-api.js      # Google Sheets API
        ├── sheets-sync.js     # Two-way sync with the spreadsheet, and when it runs
        ├── ui.css             # design system (tokens light/dark, primitives, timeline)
        └── fonts/             # Self-hosted woff2 (Space Grotesk, IBM Plex Sans, IBM Plex Mono)
```

Pages (dashboard, report, popup) load their scripts as `<script type="module">` and import the
shared library directly; the service worker only ingests attendance events, keeps the badge
live, and runs a Sheets sync when a meeting ends or when it wakes.

## Data Structure

Meetings are stored in `chrome.storage.local` under `attendanceHistory` (an array) and series
under `meetingGroups`. Each participant keeps the raw `events` (the source of truth for the
technical report) plus fields derived from those events.

Because a recurring Google Meet link reuses the same code, each session gets a **unique `id`**
(`<code>-<startMs>`) with the code kept separately in `meetingCode` — so weekly sessions on one
link never overwrite each other, and can be recognised as a series. The stamp in the id is also
what dates a meeting the spreadsheet lists, without reading the record back out of it.

Every write to `attendanceHistory` also stamps `attendanceHistoryRev`. The dashboard, the report
page and the worker all change that one array, so a write that finds the revision moved under it
works its change out again on what is there now (`storage.js` → `mutateHistory`).

```javascript
// chrome.storage.local.attendanceHistory = [ … ]
{
  id: "abc-defg-hij-1739610000000", // unique per session
  meetingCode: "abc-defg-hij",       // the Meet link code (series key)
  date: "2026-02-15T09:00:00Z",      // meeting start
  endedAt: "2026-02-15T10:00:00Z",
  liveAt: "2026-02-15T09:59:00Z",    // last sign of life — what says a call is live, and where a recovery ends an abandoned one
  meetingTitle: "Weekly Standup",    // editable in the dashboard; an edit is marked (titleEdited) so a live call cannot take it back
  url: "https://meet.google.com/abc-defg-hij",
  groupId: "grp-…",                  // optional — links to meetingGroups
  attendance: {
    "John Doe": {
      email: "john@example.com",
      present: false,
      firstSeen: "2026-02-15T09:00:00Z", // first-ever join
      lastLeft: "2026-02-15T10:00:00Z",  // last leave (null while present)
      joinedAt: "2026-02-15T09:50:00Z",  // current/last session start
      totalSeconds: 3300,                // sum of completed sessions
      sessions: [                        // derived intervals — power the timeline
        { joinedAt: "2026-02-15T09:00:00Z", leftAt: "2026-02-15T09:45:00Z" },
        { joinedAt: "2026-02-15T09:50:00Z", leftAt: "2026-02-15T10:00:00Z" }
      ],
      events: [
        { time: "2026-02-15T09:00:00Z", type: "Join" },
        { time: "2026-02-15T09:45:00Z", type: "Leave" },
        { time: "2026-02-15T09:50:00Z", type: "Join" },
        { time: "2026-02-15T10:00:00Z", type: "Leave" }
      ]
    }
  }
}

// chrome.storage.local.meetingGroups = [ … ]
{ id: "grp-…", name: "Weekend Training", color: "teal",
  roster: ["Anna Kowalska", "…"], createdAt: "2026-02-15T09:00:00Z" }
```

A meeting can also carry `scheduledStart` / `scheduledEnd` (its official hours, editable in the
dashboard) and a `nameMap` — the renames and merges the user made, kept as aliases and applied on
read rather than written into `attendance`, which is what keeps a merge undoable.

Data from older versions (a `meetings` object, v2 records without `sessions`/`meetingCode`, or v3
records with merges already folded into `attendance`) is migrated automatically on update; raw
`events` are preserved and everything is re-derived.

## Google Cloud Console Setup (For Sheets Integration)

The client is bound to one extension ID, and Chrome derives that ID from the folder you load — so load
the extension first and copy the ID shown for it on `chrome://extensions`.

1. Create a new project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable "Google Sheets API" in **APIs & Services > Library**
3. Configure the **OAuth consent screen** — for a personal build you can keep it in *Testing* and
   add your own Google account as a test user. A **privacy policy URL** is required; you can host
   [`privacy.html`](privacy.html) via GitHub Pages and point to it.
4. Create an OAuth 2.0 Client ID in **APIs & Services > Credentials**:
   - Application type: **Chrome Extension**
   - Application (extension) ID: the ID from `chrome://extensions`
5. Copy the generated client ID into `manifest.json` under `oauth2.client_id`, replacing the
   `YOUR_OAUTH_CLIENT_ID…` placeholder, then reload the extension.

> **Loading the extension from another folder changes its ID**, and a client registered for the old one is
> then refused with `bad client id`. The Chrome Web Store assigns a permanent ID on publishing — register
> that one for the published build.

## Permissions

This extension uses the following permissions:

- `storage`: Local storage for attendance data
- `identity`: Google OAuth2 authentication (for Sheets integration)
- `scripting`: Put the tracker back into a Google Meet tab that is already open — after an update, a reload or the extension being switched back on, and when the extension is installed while a call is already running
- `host_permissions (meet.google.com)`: Run content scripts on Google Meet pages and talk to that tab

## Interrupted tracking

Nothing gets to run when the browser is killed, the extension is switched off, or an update swaps
it out mid-call, so tracking is built to be picked back up rather than to be kept alive:

- Attendance is written to `chrome.storage.local` as it happens, so what is on disk is never
  more than one event behind.
- The page reports in once a minute even when nobody comes or goes (`liveAt`). It is what a call
  that was interrupted is ended at, and without it a quiet hour would be lost.
- Whenever the service worker wakes it ends the meetings nothing got to end, and puts a tracker
  back into every Meet tab that hasn't got one. A call still on screen is resumed into the same
  record; one whose link is gone from the browser is closed at its last sign of life.
- The same watermark is what the panel reads a record by, because presence cannot tell a live call
  from an abandoned one — both have everyone still standing inside them. Reported in within the
  last few minutes: live, and its figures are still moving. Longer than that: unfinished, its hours
  stopped where the reports stopped, and the panel says so instead of claiming it is running. A
  record left open because its Meet tab is still up — the one case the worker cannot judge — can be
  closed by hand from its page, at the last moment anything was heard from it.
- A call already running when the extension arrives is picked up on the spot, with no record of
  it ever having begun.

## Known Limitations

- Participant detection may temporarily fail if Google Meet updates its DOM structure
- Email addresses are only visible for same-organization users or under certain conditions
- When a browser tab is closed, remaining participants are marked as left at that moment
- A call the browser was killed on is closed at the last minute it was known to be running, so up to a minute of it can be lost
- The participant panel is briefly opened automatically on tracking start; this is required for Google Meet to initialize the participant DOM elements

## Privacy

All data stays on your device (`chrome.storage.local`); nothing is sent anywhere unless you enable
Google Sheets sync, which writes only to your own spreadsheet. See [PRIVACY.md](PRIVACY.md).

## Credits & License

**This is a fork** of [`starone99/google-meet-attendance-extension`](https://github.com/starone99/google-meet-attendance-extension). The original MIT licence and copyright are retained in [LICENSE](LICENSE). If you redistribute, keep both notices.
