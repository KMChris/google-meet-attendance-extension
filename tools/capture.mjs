/**
 * The store pack, made by the machine.
 *
 * Everything README.md asks for by hand is a rule in here instead: every frame is exactly the size
 * the store expects, no scrollbar is ever in shot (a scrollbar eats width and would push the layout
 * around), no cursor and no hover state is left on the page, and nothing is photographed mid-fade —
 * animations and transitions are switched off, so a colour is either its own or the run fails.
 *
 * Usage (from the repository root):
 *   npm run screenshots -- [--lang=pl,en] [--only=01,05] [--clean] [--port=4188]
 *
 * It serves the repository through demo-server.mjs, drives a real Chrome over the DevTools
 * protocol, and writes JPEGs into dist/assets/pl and dist/assets/en. Chrome is the one thing it
 * does not install: set CHROME_PATH if yours is somewhere unusual.
 */

import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

import { startDemoServer } from './demo-server.mjs';
import { SCREENSHOT_SPECS, PROMO_SPECS, PEOPLE_BY_LANGUAGE } from './demo-data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Generated assets are build output, so they land beside the store package and stay out of git. */
const OUT_ROOT = resolve(HERE, '..', 'dist', 'assets');
const FRAME = { width: 1280, height: 800 };
const QUALITY = 92;

const PROMO_PAGES = [
  { page: 'promo-small.html', file: 'small-promo-440x280.jpg', ...PROMO_SPECS.small },
  { page: 'promo-marquee.html', file: 'marquee-promo-1400x560.jpg', ...PROMO_SPECS.marquee }
];

/* --------------------------------- arguments --------------------------------- */

function parseArgs(argv) {
  const flags = new Map(argv.filter(a => a.startsWith('--')).map(a => {
    const [key, value = ''] = a.replace(/^--/, '').split('=');
    return [key, value];
  }));
  const list = (key) => (flags.get(key) || '').split(',').map(s => s.trim()).filter(Boolean);
  return {
    languages: list('lang').length ? list('lang') : ['pl', 'en'],
    only: list('only'),
    clean: flags.has('clean'),
    port: Number(flags.get('port')) || 4188
  };
}

/* ------------------------------- finding Chrome ------------------------------- */

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean);

function findChrome() {
  const found = CHROME_CANDIDATES.find(path => existsSync(path));
  if (!found) {
    throw new Error(`No Chrome found. Set CHROME_PATH to your browser.\nLooked in:\n  ${CHROME_CANDIDATES.join('\n  ')}`);
  }
  return found;
}

/* ------------------------------ measuring output ------------------------------ */

/** The size a JPEG actually claims, read off its frame header — proof rather than expectation. */
export function jpegSize(buffer) {
  let offset = 2;                                    // past SOI
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 — every frame header carries the size
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/* --------------------------------- the page --------------------------------- */

/**
 * What has to be true of every page before it is worth photographing. The stylesheet is the whole
 * anti-blur policy: with no animation and no transition there is no half-finished state to catch,
 * and with the scrollbar given no width the layout is the same whether the page scrolls or not.
 */
const STEADY_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
  html { scrollbar-width: none !important; }
  ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
  ::selection { background: transparent !important; }
  * { cursor: none !important; }
`;

/**
 * Going from `#meetings` to `#groups` is a same-document navigation: the URL changes and the page
 * does not reload, so whatever the last frame left open — a modal, an expanded row — is still there
 * for the next one. Every frame starts from a blank tab so that it starts from nothing.
 */
async function freshPage(page, url) {
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.addStyleTag({ content: STEADY_CSS });
}

/**
 * A `person=` route expands one row in place, and the lists are ordered by time rather than by the
 * cast, so the row that just opened is usually well below the fold. The frame is about that panel,
 * so the panel is what the viewport is put over.
 */
async function focusExpansion(page) {
  await page.waitForSelector('.row-panel, .person-expand', { timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelector('.row-panel, .person-expand')?.scrollIntoView({ block: 'center' });
  });
}

/**
 * Nothing may be left open that this frame did not ask for.
 *
 * A modal is a native `<dialog>` raised with `showModal()`, so what says it is up is `[open]` —
 * a closed one carries no `hidden` to test for. A menu is still a plain div that `hidden` hides.
 * The dashboard decides this the same way; see the guard in `dashboard.js`.
 */
async function assertNoStrayOverlay(page, allowModal) {
  const open = await page.evaluate(() =>
    [...document.querySelectorAll('.modal[open], .menu:not([hidden])')].map(el => el.id || el.className));
  if (open.length && !allowModal) {
    throw new Error(`stray overlay left open: ${open.join(', ')}`);
  }
  if (!open.length && allowModal) throw new Error('the modal this frame is about never opened');
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await new Promise(done => setTimeout(done, 220));
}

/** Views are `.view.on`; a view that has not drawn yet is empty, so wait for it to say something. */
async function waitForView(page, view) {
  await page.waitForFunction((name) => {
    const section = document.querySelector(`#view-${name}`);
    return !!section && section.classList.contains('on') && section.innerText.trim().length > 40;
  }, { timeout: 20_000 }, view);
}

const VIEW_OF = (route) =>
  route.startsWith('meeting=') ? 'detail'
    : route.startsWith('group=') ? 'group'
      : route.split('&')[0];

/* --------------------------------- the actions --------------------------------- */

/**
 * The three frames that are not just a URL. Each is done through the page's own handlers rather
 * than the mouse, so the pointer never rests on a row and no hover state is left in shot.
 */
const ACTIONS = {
  async 'participant-modal'(page) {
    await page.evaluate(() => {
      document.querySelector('#attendance-table .edit-name')?.click();
    });
    await page.waitForSelector('#participant-modal[open]', { timeout: 10_000 });
    // the modal focuses and selects the name; a highlighted field is not what the frame is about
    await page.evaluate(() => {
      const input = document.querySelector('#participant-name');
      if (input) input.setSelectionRange(input.value.length, input.value.length);
      window.getSelection()?.removeAllRanges();
    });
  },

  async 'analytics-table'(page) {
    await page.evaluate(() => {
      const toggle = document.querySelector('.cc-toggle');
      toggle?.click();
      toggle?.closest('.card, .cc-card, section')?.scrollIntoView({ block: 'center' });
    });
    await page.waitForFunction(() => {
      const table = document.querySelector('.cc-table');
      return table && !table.hidden && table.innerText.trim().length > 20;
    }, { timeout: 10_000 });
  },

  async 'sheets-section'(page) {
    await page.evaluate(() => {
      document.querySelector('#sheets-step-account')?.scrollIntoView({ block: 'center' });
    });
  }
};

/* --------------------------------- the capture --------------------------------- */

async function shoot(page, { width, height }, target) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  const buffer = await page.screenshot({ type: 'jpeg', quality: QUALITY, fullPage: false });

  const size = jpegSize(buffer);
  if (!size || size.width !== width || size.height !== height) {
    throw new Error(`${target} came out ${size ? `${size.width}×${size.height}` : 'unreadable'}, expected ${width}×${height}`);
  }
  await writeFile(target, buffer);
  return size;
}

async function captureFrames(page, origin, language, only) {
  const outDir = join(OUT_ROOT, language);
  const people = PEOPLE_BY_LANGUAGE[language];
  const done = [];

  for (const [index, spec] of SCREENSHOT_SPECS.entries()) {
    const file = spec.file[language];
    const number = file.slice(0, 2);
    if (only.length && !only.includes(number)) continue;

    // `person=0` names a seat in the cast rather than a person, so either language can use it
    const route = spec.route.replace(/person=(\d+)/, (_, i) => `person=${encodeURIComponent(people[Number(i)])}`);
    const query = language === 'en' ? '?lang=en' : '';

    await page.setViewport({ ...FRAME, deviceScaleFactor: 1 });

    if (spec.page === 'popup') {
      await freshPage(page, `${origin}/tools/popup-showcase.html${query}`);
      // the popup itself lives in an iframe, and it has its own fade-ins to switch off
      for (const frame of page.frames()) {
        if (frame !== page.mainFrame()) await frame.addStyleTag({ content: STEADY_CSS }).catch(() => {});
      }
      await settle(page);
    } else {
      await freshPage(page, `${origin}/dashboard/dashboard.html${query}#${route}`);
      await waitForView(page, VIEW_OF(route));
      if (route.includes('person=')) await focusExpansion(page);
      await settle(page);
      if (spec.action) { await ACTIONS[spec.action](page); await settle(page); }
      await assertNoStrayOverlay(page, spec.action === 'participant-modal');
    }

    const size = await shoot(page, FRAME, join(outDir, file));
    done.push(`${language}/${file}  ${size.width}×${size.height}  ${spec.label[language]}`);
    process.stdout.write(`  ${String(index + 1).padStart(2)}/${SCREENSHOT_SPECS.length}  ${file}\n`);
  }

  return done;
}

async function capturePromo(page, origin, language, only) {
  if (only.length) return [];
  const outDir = join(OUT_ROOT, language);
  const query = language === 'en' ? '?lang=en' : '';
  const done = [];

  for (const promo of PROMO_PAGES) {
    await page.setViewport({ width: promo.width, height: promo.height, deviceScaleFactor: 1 });
    await freshPage(page, `${origin}/tools/${promo.page}${query}`);
    await settle(page);

    const size = await shoot(page, { width: promo.width, height: promo.height }, join(outDir, promo.file));
    done.push(`${language}/${promo.file}  ${size.width}×${size.height}`);
    process.stdout.write(`  promo  ${promo.file}\n`);
  }

  return done;
}

/** Only ever removes what this tool itself publishes — never a stray file somebody put there. */
async function cleanLanguage(language) {
  const outDir = join(OUT_ROOT, language);
  if (!existsSync(outDir)) return;
  const ours = new Set([
    ...SCREENSHOT_SPECS.map(spec => spec.file[language]),
    ...PROMO_PAGES.map(promo => promo.file)
  ]);
  for (const name of await readdir(outDir)) {
    if (/\.(jpe?g|png)$/i.test(name) && !ours.has(name)) {
      await unlink(join(outDir, name));
      process.stdout.write(`  removed stale ${language}/${name}\n`);
    }
  }
}

/* ----------------------------------- the run ----------------------------------- */

export async function run(argv = []) {
  const args = parseArgs(argv);
  const chrome = findChrome();
  const { server, url } = await startDemoServer({ port: args.port });
  process.stdout.write(`Chrome:  ${chrome}\nServing: ${url}\n\n`);

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    defaultViewport: { ...FRAME, deviceScaleFactor: 1 },
    args: [
      '--hide-scrollbars',                // the width a scrollbar would take is the width of the frame
      '--force-device-scale-factor=1',    // 1280×800 means 1280×800 pixels, whatever the display does
      '--font-render-hinting=none',
      '--disable-features=DialMediaRouteProvider'
    ]
  });

  const written = [];
  try {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);

    for (const language of args.languages) {
      if (!PEOPLE_BY_LANGUAGE[language]) throw new Error(`Unknown language: ${language}`);
      process.stdout.write(`${language}:\n`);
      await mkdir(join(OUT_ROOT, language), { recursive: true });
      if (args.clean) await cleanLanguage(language);
      written.push(...await captureFrames(page, url, language, args.only));
      written.push(...await capturePromo(page, url, language, args.only));
      process.stdout.write('\n');
    }
  } finally {
    await browser.close();
    server.close();
  }

  process.stdout.write(`${written.length} files written to dist/assets/\n`);
  return written;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await run(process.argv.slice(2));
