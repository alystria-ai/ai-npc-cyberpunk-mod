// Which files a release zip shares with the optional packs, and whether the shared files are the same bytes.
//
// The packs (OmniVoice, Local AI, Mature) are big and hosted on Hugging Face; a new release reuses the ones that did not change as
// server-side copies, so the Scripts and Runtime of a new version meet OLD pack files in the player's game folder. A path that two zips
// share and whose bytes differ makes Windows ask "Replace or skip?", and one answer silently puts an older file over a newer one.
// The rule that makes the answer never matter: the Runtime and the Scripts never carry a pack's path with other bytes. A file both
// carry must be byte for byte the same (the install note, a clip both a Runtime voice and an OmniVoice list use); anything the
// Runtime has in a newer version than the pack's copy lives at a path the pack does not use.
//
// This module is the shared knowledge: where those Runtime-only places are (the build and the checks use the same names), the move the
// 0.2.1 Runtime needs to follow the rule, and the comparison itself. packaging/check-pack-overlap.mjs is the command line.
import {fileReader, listZip} from './zip.mjs';

export const PLUGIN = 'red4ext/plugins/AiNpcCyberpunkMod';

// The Mistral voice's pre-built reference slots (docs/PACKAGING.md, "Pre-built Mistral voice references"). The OmniVoice pack keeps its own
// slots, for the clips it adds, in voices/prepared (the bridge's cache folder); the Runtime's slots (the Pocket clips) are in a folder
// of their own that the bridge reads second (bridge/voxtral-reference.mjs RUNTIME_PREPARED_FOLDER).
export const PACK_PREPARED_FOLDER = 'voices/prepared';
export const RUNTIME_PREPARED_FOLDER = 'voices/prepared-runtime';
// The OmniVoice voice lists. The pack carries its copy in app/omni/defaults; the Runtime's own (newer) copy is in app/defaults, beside the
// Pocket list, and wins (packaging/runtime/prepare-state.mjs).
export const PACK_OMNI_LISTS_FOLDER = 'app/omni/defaults';
export const RUNTIME_OMNI_LISTS_FOLDER = 'app/defaults';

// Trees only the OmniVoice pack writes: far too many files to list, and the Runtime must never put a file in them.
export const PACK_OWN_TREES = Object.freeze([`${PLUGIN}/app/omni/python/`, `${PLUGIN}/app/omni/voicestudio/`, `${PLUGIN}/app/omni/model/`]);

// Files of the 0.2.1 Runtime that nothing in it uses (neither its Pocket list nor its OmniVoice lists point at them: both use voices/picked/autobest)
// and that the OmniVoice pack carries too, with the same bytes, for its own older lists. Harmless, but Windows still asks about them, so a
// Runtime that follows the rule leaves them out.
export const RUNTIME_DROPS = Object.freeze(['coach-fred', 'jim-jarry', 'life-coach'].map(key => `${PLUGIN}/voices/full-cast-draft/${key}/reference.wav`));

// Where a path of the 0.2.1 Runtime (built before this rule) belongs in a Runtime that follows it: the new path, the same path, or null
// when the file is left out (RUNTIME_DROPS). Folders are relative to the plugin folder above.
const MOVES = Object.freeze([[PACK_PREPARED_FOLDER, RUNTIME_PREPARED_FOLDER], [PACK_OMNI_LISTS_FOLDER, RUNTIME_OMNI_LISTS_FOLDER]]
  .map(([from, to]) => [`${PLUGIN}/${from}/`, `${PLUGIN}/${to}/`]));
export function runtimePathFor(path) {
  if (RUNTIME_DROPS.includes(path)) return null;
  for (const [from, to] of MOVES) if (path.startsWith(from)) return to + path.slice(from.length);
  return path;
}

const crcText = crc => (crc >>> 0).toString(16).padStart(8, '0');

// Files (not folders) of a zip as {path, size, crc} (crc as eight hex digits), from listZip entries.
export const zipFiles = entries => entries.filter(entry => !entry.name.endsWith('/')).map(entry => ({path: entry.name, size: entry.uncompressed, crc: crcText(entry.crc)}));

// One pack's record in a listing: its files, except what lies in a tree only that pack writes, which is counted and named instead.
export function packRecord({name, file, bytes}, files) {
  const claimed = PACK_OWN_TREES.map(prefix => ({prefix, entries: files.filter(item => item.path.startsWith(prefix)).length})).filter(item => item.entries);
  const listed = files.filter(item => !PACK_OWN_TREES.some(prefix => item.path.startsWith(prefix))).sort((a, b) => (a.path < b.path ? -1 : 1));
  return {name, file, bytes, entries: files.length, claimed, files: listed.map(item => [item.path, item.size, item.crc])};
}

export function listingText(packs, note) {
  const line = item => `    [${JSON.stringify(item[0])}, ${item[1]}, "${item[2]}"]`;
  const record = pack => `  {"name": ${JSON.stringify(pack.name)}, "file": ${JSON.stringify(pack.file)}, "bytes": ${pack.bytes}, "entries": ${pack.entries},\n`
    + `   "claimed": ${JSON.stringify(pack.claimed)},\n   "files": [\n${pack.files.map(line).join(',\n')}\n   ]}`;
  return `{\n "schema": 1,\n "note": ${JSON.stringify(note)},\n "packs": [\n${packs.map(record).join(',\n')}\n ]\n}\n`;
}

// Checks a listing's own arithmetic: every pack's files and claimed trees add up to its entry count, no path twice (case-insensitively).
export function validateListing(listing) {
  if (listing?.schema !== 1 || !Array.isArray(listing.packs)) throw Error('Not a pack listing (schema 1).');
  for (const pack of listing.packs) {
    const seen = new Set();
    for (const [path, size, crc] of pack.files) {
      if (typeof path !== 'string' || !Number.isSafeInteger(size) || !/^[0-9a-f]{8}$/.test(crc)) throw Error(`${pack.name}: a bad record for ${path}.`);
      if (seen.has(path.toLowerCase())) throw Error(`${pack.name}: ${path} is listed twice.`);
      seen.add(path.toLowerCase());
    }
    const total = pack.files.length + pack.claimed.reduce((sum, item) => sum + item.entries, 0);
    if (total !== pack.entries) throw Error(`${pack.name}: ${pack.files.length} files and the claimed trees make ${total}, not ${pack.entries}.`);
  }
  return listing;
}

// The files of `zip` (from zipFiles) against every pack of `listing`. Windows compares names without regard to case, so this does too.
// Returns {identical, different, inPackTrees}: each a list of {pack, path, ...}; `different` carries both sides' size and crc.
export function compareWithPacks(files, listing) {
  const identical = [], different = [], inPackTrees = [];
  for (const pack of listing.packs) {
    const known = new Map(pack.files.map(([path, size, crc]) => [path.toLowerCase(), {size, crc}]));
    for (const file of files) {
      const lower = file.path.toLowerCase();
      if (pack.claimed.some(item => lower.startsWith(item.prefix.toLowerCase()))) { inPackTrees.push({pack: pack.name, path: file.path}); continue; }
      const theirs = known.get(lower);
      if (!theirs) continue;
      if (theirs.size === file.size && theirs.crc === file.crc) identical.push({pack: pack.name, path: file.path});
      else different.push({pack: pack.name, path: file.path, zip: {size: file.size, crc: file.crc}, packFile: theirs});
    }
  }
  return {identical, different, inPackTrees, ok: !different.length && !inPackTrees.length};
}

// Paths a zip holds more than once (Windows compares names without regard to case): each is a "Replace or skip?" inside that one zip, and
// with other bytes the answer decides which copy the player gets, which is what the rule above exists to prevent. ZipWriter refuses
// them, but a zip patched or made by another tool can have them. Returns [{path, copies: [{path, size, crc}], same}].
export function duplicatePaths(files) {
  const byName = new Map();
  for (const file of files) {
    const key = file.path.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), file]);
  }
  return [...byName.values()].filter(copies => copies.length > 1).map(copies => ({path: copies[0].path,
    copies: copies.map(({path, size, crc}) => ({path, size, crc})), same: copies.every(copy => copy.size === copies[0].size && copy.crc === copies[0].crc)}));
}

// How many of `items` lie in each folder, `depth` folders below the plugin folder (a path outside it counts in its own top folder).
export function countByFolder(items, depth = 3) {
  const counts = new Map();
  for (const {path} of items) {
    const parts = path.split('/');
    const base = path.startsWith(`${PLUGIN}/`) ? 3 : 0;
    const folder = parts.slice(base, Math.min(parts.length - 1, base + depth)).join('/') || '(top of the zip)';
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

// A reader for listZip that asks a web server for byte ranges, so a zip on Hugging Face is listed without downloading it: the end of
// the file, then the central directory. `bytes()` is what was read in all (the body of every answer); a public file needs no token.
export async function urlReader(url, {fetchImpl = globalThis.fetch} = {}) {
  const head = await fetchImpl(url, {method: 'HEAD', redirect: 'follow'});
  const size = Number(head.headers.get('content-length'));
  if (!head.ok || !Number.isSafeInteger(size) || size <= 0) throw Error(`${url}: no size (HTTP ${head.status}).`);
  let total = 0;
  return {size, label: url, bytes: () => total, async read(position, length) {
    const answer = await fetchImpl(url, {headers: {Range: `bytes=${position}-${position + length - 1}`}, redirect: 'follow'});
    if (answer.status !== 206) throw Error(`${url}: the server does not answer byte ranges (HTTP ${answer.status}).`);
    const buffer = Buffer.from(await answer.arrayBuffer());
    if (buffer.length !== length) throw Error(`${url}: asked for ${length} bytes, got ${buffer.length}.`);
    total += buffer.length;
    return buffer;
  }};
}

export const isUrl = source => /^https?:\/\//i.test(source);

// The files of a zip given as a path or a URL, and how many bytes it cost to learn them (a local file costs none).
export async function filesOfZip(source, {fetchImpl} = {}) {
  if (isUrl(source)) {
    const reader = await urlReader(source, {fetchImpl});
    const files = zipFiles(await listZip(reader));
    return {files, size: reader.size, bytesRead: reader.bytes()};
  }
  const reader = await fileReader(source);
  try { return {files: zipFiles(await listZip(reader)), size: reader.size, bytesRead: 0}; } finally { await reader.close(); }
}
