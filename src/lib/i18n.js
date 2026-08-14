/**
 * Runtime i18n as an ES module. Pages import { t, initI18n, ... }.
 *
 *   <span data-i18n="navMeetings"></span>        → textContent
 *   <input data-i18n-placeholder="searchMeetings">
 *   <button data-i18n-title="save" data-i18n-aria="save">
 *
 * Strings live in Chrome's own message catalogues, _locales/<code>/messages.json,
 * which is what the manifest's __MSG_*__ references resolve against. Pages read
 * those files over fetch rather than through chrome.i18n.getMessage, because
 * getMessage is pinned to the browser UI language and this extension lets the
 * user pick a language in Settings.
 *
 * Language preference is stored in chrome.storage.sync ('rollcallLanguage') as 'en' | 'pl';
 * when the key is absent the language is Automatic and follows the browser language.
 * Substitution follows the messages.json placeholder contract: t('importedToast', { count: 3 })
 * fills the $COUNT$ placeholder declared for that message.
 *
 * initI18n() must resolve before the first t() call; every page awaits it on startup.
 */

/**
 * `flag` is drawn, not written. A flag emoji is a pair of regional indicators (Poland is U+1F1F5
 * U+1F1F1) and Windows ships no country glyphs in Segoe UI Emoji, so it renders the bare letters
 * "PL" instead, which is why these are SVG. Each sits in a shared 3:2 box; strokes that run past
 * the edge (the Union Jack's diagonals) are cut by the SVG viewport, which clips by default.
 *
 * These hex values are deliberate, against the rule that colour comes from the tokens in ui.css:
 * they belong to the flags rather than to the interface, so they hold in light and dark alike.
 */
const FLAG_GB = '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
  + '<rect width="60" height="40" fill="#012169"/>'
  + '<path d="M0 0 60 40M60 0 0 40" stroke="#fff" stroke-width="9"/>'
  + '<path d="M0 0 60 40M60 0 0 40" stroke="#c8102e" stroke-width="5"/>'
  + '<path d="M30 0v40M0 20h60" stroke="#fff" stroke-width="15"/>'
  + '<path d="M30 0v40M0 20h60" stroke="#c8102e" stroke-width="9"/></svg>';
const FLAG_PL = '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
  + '<rect width="60" height="20" fill="#fff"/><rect y="20" width="60" height="20" fill="#dc143c"/></svg>';

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English', native: 'English', flag: FLAG_GB },
  { code: 'pl', label: 'Polish', native: 'Polski', flag: FLAG_PL }
];

const STORAGE_KEY = 'rollcallLanguage';
const DEFAULT = 'en';
const AUTO = 'auto';
const listeners = new Set();

/** locale code -> parsed messages.json ({ key: { message, placeholders? } }). */
const catalogues = new Map();

let preference = AUTO; // 'auto' | 'en' | 'pl' — the user's choice ('auto' follows the browser)
let locale = DEFAULT;  // resolved 'en' | 'pl' currently in use

function normalize(code) {
  if (!code) return null;
  const base = String(code).toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LANGUAGES.some(l => l.code === base) ? base : null;
}

function detectLocale() { return normalize(navigator.language) || DEFAULT; }
function resolveLocale(pref) { return pref === AUTO ? detectLocale() : pref; }

export function getLocale() { return locale; }
/** The stored language preference: 'auto' (follow the browser) | 'en' | 'pl'. */
export function getLanguagePreference() { return preference; }
export function localeTag() { return locale === 'pl' ? 'pl-PL' : 'en-GB'; }

/** Read one locale's messages.json out of the extension package. Cached per locale. */
async function loadCatalogue(code) {
  const cached = catalogues.get(code);
  if (cached) return cached;
  try {
    const res = await fetch(chrome.runtime.getURL(`_locales/${code}/messages.json`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    catalogues.set(code, messages);
    return messages;
  } catch (err) {
    console.warn(`[GM Attendance] could not load _locales/${code}/messages.json:`, err);
    catalogues.set(code, {});
    return {};
  }
}

/**
 * Fill the message's placeholders, following the messages.json rules: '$$' is a
 * literal '$' and '$name$' is matched case-insensitively. A placeholder with no
 * value is left in place so the gap is visible rather than silently blank.
 */
function substitute(message, params) {
  return message.replace(/\$(\$|[A-Za-z0-9_]+\$)/g, (token, body) => {
    if (body === '$') return '$';
    if (!params) return token;
    const name = body.slice(0, -1).toLowerCase();
    const value = params[name];
    return value == null ? token : String(value);
  });
}

/** Translate a key with optional placeholder values. Falls back to EN, then the key. */
export function t(key, params) {
  const entry = (catalogues.get(locale) || {})[key] ?? (catalogues.get(DEFAULT) || {})[key];
  if (!entry || typeof entry.message !== 'string') return key;
  return substitute(entry.message, params);
}

/** Apply translations to every [data-i18n*] node under root. */
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  if (root === document || root === document.documentElement) document.documentElement.lang = locale;
}

export function onLocaleChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }

/**
 * Every locale's plain key -> string table, e.g. { en: { save: 'Save' }, pl: { save: 'Zapisz' } }.
 * Used where all languages matter at once, such as recognising a CSV header that was
 * exported in the other language.
 */
export async function getAllMessages() {
  const tables = {};
  await Promise.all(SUPPORTED_LANGUAGES.map(async ({ code }) => {
    const messages = await loadCatalogue(code);
    const table = {};
    for (const key in messages) table[key] = messages[key].message;
    tables[code] = table;
  }));
  return tables;
}

function readStored() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get([STORAGE_KEY], (r) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(r && r[STORAGE_KEY]);
      });
    } catch { resolve(null); }
  });
}

/** Load the stored (or browser) locale and apply it. Call once per page, before t(). */
export async function initI18n() {
  const stored = await readStored();
  preference = (stored === 'en' || stored === 'pl') ? stored : AUTO;
  locale = resolveLocale(preference);
  await Promise.all([loadCatalogue(locale), loadCatalogue(DEFAULT)]);
  applyI18n(document);
  return locale;
}

/** Set the language preference ('auto' | 'en' | 'pl'), persist, re-apply, and notify listeners. */
export async function setLocale(code) {
  preference = (code === 'en' || code === 'pl') ? code : AUTO;
  try {
    if (preference === AUTO) chrome.storage.sync.remove(STORAGE_KEY);
    else chrome.storage.sync.set({ [STORAGE_KEY]: preference });
  } catch { /* sync unavailable */ }
  const next = resolveLocale(preference);
  if (next === locale) return;
  await loadCatalogue(next);
  locale = next;
  applyI18n(document);
  listeners.forEach(cb => { try { cb(next); } catch (e) { console.warn(e); } });
  document.dispatchEvent(new CustomEvent('rollcall:locale', { detail: next }));
}

/* ---- locale-aware formatting ---- */
export function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' });
}
export function formatDate(iso, opts) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(localeTag(), opts || { year: 'numeric', month: 'long', day: 'numeric' });
}
export function monthShort(date) {
  return date.toLocaleDateString(localeTag(), { month: 'short' });
}
/** Compact duration: `2h 05m`, `47m`, `12s`. Zero and negatives read as `0m`. */
export function formatDuration(seconds) {
  const secs = Math.floor(seconds || 0);
  if (secs <= 0) return '0m';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${secs}s`;
}
