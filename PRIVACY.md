# Privacy Policy

**Google Meet Attendance Tracker**

Last updated: 2026-08-14

## Data Collection

The extension records attendance in the Google Meet calls the user takes part in. What it stores:

- participant display names, as shown by Google Meet
- participant e-mail addresses, when Meet displays them (usually only for people in the same organisation)
- join and leave timestamps, plus the meeting's link, code, title and hours
- settings and any corrections the user makes (renamed or merged participants, series)

All of it is written to `chrome.storage.local` on the user's own device. Nothing is sent to us. There is no server behind this extension and no account to create.

## Google Sheets Sync (Optional)

Off until the user turns it on. If the user connects a Google account and enables sync, finished meetings, including the names and e-mail addresses listed above, are written to a spreadsheet the user owns. The extension requests the `spreadsheets` OAuth scope only, reads no other Google data, and the access token is issued and held by Chrome.

## Data Sharing

- We do **not** receive any of this data. It stays on the device unless the user enables Sheets sync.
- We do **not** sell, share, or transfer any data to third parties.
- We do **not** use any data for advertising or analytics.

## User Control

- All data is stored locally on the user's device.
- Users can delete individual or all meeting records from the extension.
- Uninstalling the extension removes all locally stored data.

## Permissions

| Permission | Reason |
|------------|--------|
| `storage` | Store attendance records and settings locally on the user's device |
| `host_permissions (meet.google.com)` | Run the content script on Google Meet pages and communicate with that tab to detect participants |
| `identity` | Google OAuth2 authentication for optional Sheets sync to the user's own spreadsheet |

## Contact

If you have questions about this privacy policy, please open an issue at:
https://github.com/KMChris/google-meet-attendance-extension/issues
