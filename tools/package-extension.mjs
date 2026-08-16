#!/usr/bin/env node
/**
 * Packs the extension for the Chrome Web Store into dist/<name>-<version>.zip.
 *
 *   node scripts/package-extension.mjs
 *
 * No dependencies and no build step: the sources ship as they are. What the
 * script does beyond copying is remove the local-only `key` from the manifest,
 * refuse to build a package whose OAuth client is still the placeholder, and
 * check that everything the manifest names is actually in the archive.
 *
 * The ZIP is written here rather than shelled out to, because the two packers
 * Windows offers are both wrong for this: PowerShell's Compress-Archive (5.1)
 * separates paths with backslashes, which the ZIP spec does not allow and
 * Chrome does not resolve, and Info-ZIP is not installed by default.
 */

import { execFileSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Directories whose tracked contents the extension loads at runtime. */
const RUNTIME_DIRS = ['_locales', 'dashboard', 'icons', 'report', 'src'];

/** Everything else is repo furniture: tests, docs, these tools, the site pages. */

/**
 * A fixed timestamp keeps the archive reproducible — the same commit packs to
 * the same bytes. 1980-01-01 is the earliest a ZIP can express.
 */
const DOS_EPOCH = { time: 0, date: (1 << 5) | 1 };

const problems = [];
const warnings = [];

function fail(message) {
  problems.push(message);
}

function warn(message) {
  warnings.push(message);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

/** Tracked runtime files, so the package inherits .gitignore for free. */
function runtimeFiles() {
  const listed = git(['ls-files', '-z', ...RUNTIME_DIRS]).split('\0').filter(Boolean);

  // A file added but never staged is invisible to `git ls-files`, and would go
  // missing from the package without anything else noticing.
  const untracked = git(['ls-files', '-z', '--others', '--exclude-standard', ...RUNTIME_DIRS])
    .split('\0').filter(Boolean);
  for (const file of untracked) {
    warn(`untracked, so left out of the package: ${file} — git add it if it ships`);
  }

  return listed.sort();
}

/** The manifest as it should ship: local-only key gone, real client id kept. */
function packagedManifest() {
  const source = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
  const stripped = source.split(/\r?\n/).filter(line => !/^\s*"key"\s*:/.test(line)).join('\n');

  let manifest;
  try {
    manifest = JSON.parse(stripped);
  } catch (err) {
    throw new Error(`manifest.json does not parse once "key" is removed: ${err.message}`);
  }

  if ('key' in manifest) fail('the local-only "key" is still in the packaged manifest');

  const clientId = manifest.oauth2?.client_id;
  if (!clientId || clientId.startsWith('YOUR_')) {
    fail(`oauth2.client_id is not configured (${clientId || 'missing'}) — the committed manifest ` +
      'carries a placeholder, so pack from a checkout that has the real one');
  }

  return { manifest, text: stripped };
}

/** Everything the manifest points at has to be in the archive. */
function checkReferences(manifest, files) {
  const present = new Set(files);
  const referenced = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_page,
    ...(manifest.content_scripts ?? []).flatMap(script => [...(script.js ?? []), ...(script.css ?? [])]),
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...Object.values(manifest.icons ?? {})
  ].filter(Boolean);

  for (const ref of new Set(referenced)) {
    if (!present.has(ref)) fail(`manifest names a file the package does not hold: ${ref}`);
  }
}

/**
 * `__MSG_x__` in the manifest is what localizes the store listing, and a key
 * missing from a catalogue leaves the raw placeholder on the listing.
 */
function checkMessages(manifest, files) {
  const keys = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map(match => match[1]);
  if (!keys.length) return;

  const catalogues = files.filter(file => /^_locales\/[^/]+\/messages\.json$/.test(file));
  if (!catalogues.length) return fail('the manifest uses __MSG_ placeholders but no catalogue ships');

  const defaultLocale = manifest.default_locale;
  if (defaultLocale && !catalogues.includes(`_locales/${defaultLocale}/messages.json`)) {
    fail(`default_locale is "${defaultLocale}" but _locales/${defaultLocale}/messages.json is not in the package`);
  }

  for (const catalogue of catalogues) {
    const messages = JSON.parse(fs.readFileSync(path.join(ROOT, catalogue), 'utf8'));
    for (const key of new Set(keys)) {
      if (!messages[key]) fail(`${catalogue} has no "${key}", which the manifest asks for`);
    }
  }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * Minimal ZIP writer: one entry per file, no directory entries (Chrome does
 * not need them), no ZIP64 (nothing here comes near 4 GB).
 */
function writeZip(entries, destination) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const deflated = deflateRawSync(raw, { level: 9 });

    // Already-compressed bytes (fonts, PNGs) can deflate larger than they are.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_EPOCH.time, 10);
    local.writeUInt16LE(DOS_EPOCH.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);          // no extra field

    chunks.push(local, name, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);         // version made by
    header.writeUInt16LE(20, 6);         // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_EPOCH.time, 12);
    header.writeUInt16LE(DOS_EPOCH.date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(0, 38);         // external attributes
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  fs.writeFileSync(destination, Buffer.concat([...chunks, directory, end]));
}

function slug(manifestName, messages) {
  const readable = /^__MSG_(\w+)__$/.exec(manifestName);
  const name = readable ? messages[readable[1]]?.message ?? readable[1] : manifestName;
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function main() {
  const { manifest, text } = packagedManifest();
  const files = runtimeFiles();

  checkReferences(manifest, files);
  checkMessages(manifest, files);

  if (problems.length) {
    console.error('Cannot pack:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  const catalogue = path.join(ROOT, '_locales', manifest.default_locale ?? 'en', 'messages.json');
  const messages = fs.existsSync(catalogue) ? JSON.parse(fs.readFileSync(catalogue, 'utf8')) : {};

  const entries = [
    { name: 'manifest.json', data: Buffer.from(text, 'utf8') },
    ...files.map(file => ({ name: file, data: fs.readFileSync(path.join(ROOT, file)) }))
  ].sort((a, b) => (a.name < b.name ? -1 : 1));

  const dist = path.join(ROOT, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const destination = path.join(dist, `${slug(manifest.name, messages)}-${manifest.version}.zip`);
  writeZip(entries, destination);

  for (const warning of warnings) console.warn(`warning: ${warning}`);

  const size = (fs.statSync(destination).size / 1024).toFixed(0);
  console.log(`Packed ${manifest.version} — ${entries.length} files, ${size} KB`);
  console.log(path.relative(ROOT, destination).replace(/\\/g, '/'));
}

main();
