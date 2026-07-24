# Privacy Policy

**Google Meet Attendance Tracker**

Last updated: 2026-07-24

## Data Collection

This extension does **not** collect, transmit, or store any user data on external servers.

All data (participant names, timestamps, meeting records) is stored **locally** on the user's device using Chrome's `chrome.storage.local` API.

## Google Sheets Sync (Optional)

If the user enables Google Sheets sync, attendance data is sent **only** to the user's own Google Spreadsheet. The extension does not have access to any other user's data.

## Data Sharing

- We do **not** collect any user data.
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
| `activeTab` | Communicate with the Google Meet tab to detect participants |
| `host_permissions (meet.google.com)` | Run content script on Google Meet pages |
| `identity` | Google OAuth2 authentication for optional Sheets sync to the user's own spreadsheet |

## Contact

If you have questions about this privacy policy, please open an issue at:
https://github.com/KMChris/google-meet-attendance-extension/issues
