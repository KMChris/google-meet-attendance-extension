# Contributing

Thanks for your interest! Issues and pull requests are welcome.

## Running it locally

There is **no build step**. Load the folder directly:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the project root
3. After editing, hit **Reload** on the extension card (and reopen the dashboard/popup)

## Project layout

See [README → Project Structure](README.md#project-structure). In short:

- `src/lib/attendance.js` — **pure** derivation & aggregation (no `chrome.*`). Presence, sessions,
  durations, share, status, name aliases and group roll-ups all live here. Prefer adding logic here
  so the dashboard, report and popup stay thin.
- `src/lib/storage.js` — the only `chrome.storage` layer (history, series, settings, migration).
- `src/lib/importers.js` — **pure** readers for files we didn't write as a JSON backup: our own CSV
  and other extensions' exports. Each returns records in this app's shape; the merge path is shared.
- `src/background/service-worker.js` — ingests content-script events, keeps the badge live,
  runs migration, auto-syncs to Sheets. It does **not** serve UI reads — pages use `storage.js` directly.
- `dashboard/`, `report/`, `src/popup/` — ES-module pages (`<script type="module">`).
- `src/lib/ui.css` — the design system (tokens for light/dark, primitives, the timeline).

## Conventions

- **Escape all user-supplied strings** (names, titles) before inserting into HTML — use the
  `esc()` helpers already present.
- **Keep light + dark working.** Colours come from CSS variables in `ui.css`; don't hard-code hex
  in components. Charts read CSS variables at draw time.
- **Derive from `events`.** `events` (raw Join/Leave) is the source of truth; never persist a
  derived value that can't be recomputed from it.

## Adding or changing UI text

All strings live in Chrome's message catalogues, `_locales/en/messages.json` and
`_locales/pl/messages.json`, keyed the same. Add the key to **both** languages, then reference it
with `t('key')` in JS or `data-i18n="key"` in HTML.

Substitutions use the `messages.json` placeholder contract, so a message declares what it takes:

```json
"importedToast": {
  "message": "Imported $COUNT$ meetings",
  "description": "Confirmation after importing meetings from a file.",
  "placeholders": { "count": { "content": "$1", "example": "3" } }
}
```

and the call passes it by name: `t('importedToast', { count: 3 })`. A value that is missing at
runtime leaves `$COUNT$` visible rather than blanking out, so the gap is easy to spot.

`manifest.json` reads the same catalogues through `__MSG_extName__`, `__MSG_extShortName__`,
`__MSG_extDescription__` and `__MSG_extActionTitle__`, which is what localizes the Chrome Web Store
listing. Keep `extShortName` at 12 characters or fewer and `extDescription` at 132 or fewer;
Chrome truncates past those limits.

### Adding a language

1. Add `_locales/<code>/messages.json` (copy `en`, translate the `message` values, leave the keys,
   `description` and `placeholders` alone).
2. Add the language to `SUPPORTED_LANGUAGES` in `src/lib/i18n.js`.

Pages read these files over `fetch` rather than through `chrome.i18n.getMessage`, because
`getMessage` is pinned to the browser UI language and Settings lets the user pick a language.

## Before opening a PR

- Sanity-check the pages in `chrome://extensions` (no console errors) in both light and dark.
- If you touched `attendance.js` / `storage.js`, verify the derivation still holds (durations,
  share, absentees, series matrix) on a meeting with a rejoin, a merged participant and an absentee.
- If you touched the CSV columns, export one and import it back — the row shape is a contract
  between `dashboard.js` and `importers.js`.
- Update [CHANGELOG.md](CHANGELOG.md).
