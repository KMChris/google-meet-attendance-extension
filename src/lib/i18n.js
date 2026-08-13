/**
 * Runtime i18n (EN/PL) as an ES module. Pages import { t, initI18n, ... }.
 *
 *   <span data-i18n="navMeetings"></span>        → textContent
 *   <input data-i18n-placeholder="searchMeetings">
 *   <button data-i18n-title="save" data-i18n-aria="save">
 *
 * Language preference is stored in chrome.storage.sync ('rollcallLanguage') as 'en' | 'pl';
 * when the key is absent the language is Automatic — it follows the browser language.
 * Interpolation uses {n} tokens: t('importedToast', { n: 3 }).
 */
import { TRANSLATIONS } from './translations.js';

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English', native: 'English', flag: '🇬🇧' },
  { code: 'pl', label: 'Polish', native: 'Polski', flag: '🇵🇱' }
];

const STORAGE_KEY = 'rollcallLanguage';
const DEFAULT = 'en';
const AUTO = 'auto';
const listeners = new Set();
let preference = AUTO; // 'auto' | 'en' | 'pl' — user's choice ('auto' follows the browser)
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

/** Translate a key with optional {n}-style interpolation. Falls back to EN, then the key. */
export function t(key, params) {
  const table = TRANSLATIONS[locale] || TRANSLATIONS[DEFAULT];
  let str = table[key];
  if (str == null) str = TRANSLATIONS[DEFAULT][key];
  if (str == null) return key;
  if (params) for (const p in params) str = str.replace(new RegExp(`\\{${p}\\}`, 'g'), params[p]);
  return str;
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

/** Load the stored (or browser) locale and apply it. Call once per page. */
export async function initI18n() {
  const stored = await readStored();
  preference = (stored === 'en' || stored === 'pl') ? stored : AUTO;
  locale = resolveLocale(preference);
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
