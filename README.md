# Google Meet Attendance Tracker

A Chrome extension that automatically tracks participant attendance in Google Meet meetings.
Its interface is a bespoke "presence instrument" design whose signature is a
**presence timeline** that plots exactly when each participant was in the meeting, including
every time they left and rejoined.

## Features

- **Real-time Participant Detection**: Track participant join/leave events using MutationObserver and polling
- **Event-based Tracking**: Records each join and leave as a separate event with timestamp; presence, sessions, durations and lateness are all derived from those raw events
- **Full Dashboard** (Meetings · Series · People · Analytics · Settings): search, rename, native canvas charts, and the presence timeline — opens as the extension's options page
- **Analytics**: filter by date range, series and meeting, then read the slice as headline numbers with period-over-period deltas, charts (activity over time, length vs. presence, punctuality, a weekday × hour heatmap, attendance distribution, top meetings and people, series comparison) and derived read-outs. Every chart flips to the table behind it and exports to CSV
- **Series**: Bundle recurring sessions (e.g. a weekend training) into a series. Recurring links are auto-detected; each series has an aggregate **attendance matrix** (people × sessions), per-series roster, and its own report
- **Roster & Status**: Expected-attendee rosters flag who was **Late** or **Absent** (configurable late threshold, measured from the meeting start)
- **Exports**: Per-meeting CSV, combined CSV, JSON backup/restore, clipboard, and detailed **technical PDF reports** — for a single meeting or a whole series — with attendance and every join/leave event, print-ready
- **Dark mode**: Follows the browser's light/dark preference, with a System / Light / Dark override in Settings
- **Localized**: Full English + Polish interface (auto-detected, switchable in Settings)
- **Local Storage**: Local data storage using the Chrome Storage API
- **Google Sheets Integration** (Optional): Auto-sync finished meetings to Google Spreadsheets via OAuth2

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

CSV export outputs one row per event, making it easy to analyze attendance patterns and exact durations.

### Google Sheets Integration (Optional)

1. Open the extension settings page
2. Click **Connect Google Account** to link your Google account
3. Click **Create New Spreadsheet** to create a new spreadsheet, or enter an existing spreadsheet ID
4. Enable the **Auto-sync** option to automatically sync when meetings end

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
│   └── dashboard.js           # ES module: views, timeline, series, charts
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
        ├── i18n.js            # Runtime i18n (EN/PL)
        ├── translations.js    # EN + PL string tables
        ├── sheets-api.js      # Google Sheets API
        ├── ui.css             # design system (tokens light/dark, primitives, timeline)
        └── fonts/             # Self-hosted woff2 (Space Grotesk, IBM Plex Sans, IBM Plex Mono)
```

Pages (dashboard, report, popup) load their scripts as `<script type="module">` and import the
shared library directly; the service worker only ingests attendance events, keeps the badge
live, and auto-syncs to Sheets.

## Data Structure

Meetings are stored in `chrome.storage.local` under `attendanceHistory` (an array) and series
under `meetingGroups`. Each participant keeps the raw `events` (the source of truth for the
technical report) plus fields derived from those events.

Because a recurring Google Meet link reuses the same code, each session gets a **unique `id`**
(`<code>-<startMs>`) with the code kept separately in `meetingCode` — so weekly sessions on one
link never overwrite each other, and can be recognised as a series.

```javascript
// chrome.storage.local.attendanceHistory = [ … ]
{
  id: "abc-defg-hij-1739610000000", // unique per session
  meetingCode: "abc-defg-hij",       // the Meet link code (series key)
  date: "2026-02-15T09:00:00Z",      // meeting start
  endedAt: "2026-02-15T10:00:00Z",
  meetingTitle: "Weekly Standup",    // editable in the dashboard
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

Data from older versions (a `meetings` object, or v2 records without `sessions`/`meetingCode`)
is migrated automatically on update.

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
- `activeTab`: Access to current Google Meet page
- `identity`: Google OAuth2 authentication (for Sheets integration)
- `host_permissions (meet.google.com)`: Run content scripts on Google Meet pages

## Known Limitations

- Participant detection may temporarily fail if Google Meet updates its DOM structure
- Email addresses are only visible for same-organization users or under certain conditions
- When a browser tab is closed, remaining participants are marked as left at that moment
- The participant panel is briefly opened automatically on tracking start; this is required for Google Meet to initialize the participant DOM elements

## Privacy

All data stays on your device (`chrome.storage.local`); nothing is sent anywhere unless you enable
Google Sheets sync, which writes only to your own spreadsheet. See [PRIVACY.md](PRIVACY.md).

## Credits & License

**This is a fork** of [`starone99/google-meet-attendance-extension`](https://github.com/starone99/google-meet-attendance-extension). The original MIT licence and copyright are retained in [LICENSE](LICENSE). If you redistribute, keep both notices.
