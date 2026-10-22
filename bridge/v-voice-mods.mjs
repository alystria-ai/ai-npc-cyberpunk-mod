// Does a mod in archive/pc/mod (or a REDmod mod's archives) replace V's voice-over? (docs/V_VOICE.md, "V voice mods")
//
// A voice mod ships V's lines as .wem files under the game's own depot paths (base\localization\en-us\vo\v_<scene>_<f|m>_<id>.wem, and ep1\...), so its
// archive's index holds the same path hashes as the game's. assets/v-voice/v-mod-lines.json lists, per V gender, the lines of the shipped English
// reference (and spare lines), and a seeded sample of 300 hashes of V's plain lines. One pass over an archive's index tells which of them it holds:
//   - coverage = the share of the 300 sampled V lines the archive replaces (a full V voice mod holds about all of one gender; a mod that replaces a
//     few lines, or other voices, holds none or a few);
//   - the line hits say which lines of our recipe can be built from it.
//
// Cost: the header and the index of each archive in the mod folder, read once (a stat per archive on every later start). The result is kept by archive
// path, size and modification time (and the line list's digest) in a small JSON file, so an archive that did not change is never opened again. It runs
// in the bridge's service (never the game), once at start and again only when the folder's listing changes; nothing here runs per frame or per reply.
import {mkdir, readdir, readFile, rm, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename, join, relative, resolve, sep} from 'node:path';
import {atomicFile} from './guarded-file.mjs';
import {depotHash, openArchive} from './rdar.mjs';
import {buildModReference} from './v-voice-mod-reference.mjs';

export const V_MOD_CACHE_VERSION = 1;
export const V_MOD_DETECTION = Object.freeze({minCoverage: 0.25, minLines: 3, maxArchives: 4000, maxDepth: 3});
export const GENDERS = Object.freeze(['male', 'female']);

/** Reads v-mod-lines.json and adds each line's depot hash. Throws on a malformed file (it ships with the mod, so that is a bug, not a player's problem). */
export function parseModLines(text) {
  const raw = JSON.parse(String(text).replace(/^﻿/, ''));
  if (raw?.version !== 1 || raw.locale !== 'en-us') throw Error('v-mod-lines.json: unsupported version or locale');
  const genders = {};
  for (const gender of GENDERS) {
    const row = raw.genders?.[gender];
    if (!row || !Array.isArray(row.lines) || !Array.isArray(row.probe)) throw Error(`v-mod-lines.json: ${gender} is missing`);
    const lines = row.lines.map(line => {
      if (typeof line.path !== 'string' || !/^(base|ep1)\\localization\\en-us\\vo\\v_[a-z0-9_]+_[fm]_[0-9a-f]{16}\.wem$/.test(line.path)) throw Error(`v-mod-lines.json: bad path ${String(line.path).slice(0, 80)}`);
      if (typeof line.transcript !== 'string' || !line.transcript.trim()) throw Error(`v-mod-lines.json: ${line.stringId} has no transcript`);
      return Object.freeze({path: line.path, stringId: String(line.stringId), transcript: line.transcript.trim(), pick: line.pick === true, hash: depotHash(line.path)});
    });
    if (row.probe.some(hex => !/^[0-9a-f]{16}$/.test(hex))) throw Error(`v-mod-lines.json: bad probe hash for ${gender}`);
    genders[gender] = Object.freeze({lines: Object.freeze(lines), probe: Object.freeze([...row.probe]), pool: row.pool});
  }
  return Object.freeze({digest: createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 16), genders: Object.freeze(genders)});
}

/** What one archive says about each gender: {entries, male: {probeHits, probeTotal, lineHits: [index of the line list...]}, female: {...}}. */
export async function inspectArchive(file, modLines, {open = openArchive} = {}) {
  const archive = await open(file);
  try {
    const wanted = new Set();
    for (const gender of GENDERS) { for (const line of modLines.genders[gender].lines) wanted.add(line.hash); for (const hex of modLines.genders[gender].probe) wanted.add(hex); }
    const found = archive.scan(wanted), out = {entries: archive.entries};
    for (const gender of GENDERS) {
      const {lines, probe} = modLines.genders[gender];
      out[gender] = {probeHits: probe.filter(hex => found.has(hex)).length, probeTotal: probe.length, lineHits: lines.flatMap((line, index) => found.has(line.hash) ? [index] : [])};
    }
    return out;
  } finally { await archive.close().catch(() => {}); }
}

/** Every .archive under `folder` (down to maxDepth folders), as {path, relative, size, mtimeMs}. A folder that is not there is an empty list. */
export async function listArchives(folder, {depth = V_MOD_DETECTION.maxDepth, limit = V_MOD_DETECTION.maxArchives} = {}) {
  const out = [];
  const walk = async (directory, level) => {
    let names;
    try { names = await readdir(directory, {withFileTypes: true}); } catch { return; }
    for (const entry of names) {
      if (out.length >= limit) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory() && level < depth) await walk(path, level + 1);
      else if (entry.isFile() && /\.archive$/i.test(entry.name)) {
        try { const info = await stat(path); out.push({path, relative: relative(folder, path).split(sep).join('/'), size: info.size, mtimeMs: Math.floor(info.mtimeMs)}); } catch { /* gone */ }
      }
    }
  };
  await walk(folder, 0);
  return out.sort((a, b) => a.relative.toLowerCase() < b.relative.toLowerCase() ? -1 : a.relative.toLowerCase() > b.relative.toLowerCase() ? 1 : 0);
}

const byName = (a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;

/**
 * Every archive that can hold V's voice-over, in the order the game loads them as far as is known: archive/pc/mod (alphabetical), then the archives of each
 * REDmod mod (mods/<name>/archives, mods alphabetical). `relative` is 'x.archive', 'sub/x.archive' or 'redmod/<mod>/x.archive'. A folder that is not there adds nothing.
 */
export async function listVoiceModArchives({game, limit = V_MOD_DETECTION.maxArchives} = {}) {
  const out = await listArchives(join(game, 'archive', 'pc', 'mod'));
  let mods = [];
  try { mods = (await readdir(join(game, 'mods'), {withFileTypes: true})).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(byName); } catch { /* no REDmod folder */ }
  for (const name of mods) {
    for (const item of await listArchives(join(game, 'mods', name, 'archives'), {depth: 1})) out.push({...item, relative: `redmod/${name}/${item.relative}`});
  }
  return out.slice(0, limit);
}

/**
 * The scan: lists the folder (`list`, an async function returning the same rows, replaces it: listVoiceModArchives), answers each archive from the cache when its path, size and time are the same, inspects the others (one at a time), saves the
 * cache when anything changed. `cachePath` may be null (no cache). Resolves to {archives: [{relative, size, cached, error?, male?, female?}], winners: {male, female},
 * stats: {total, inspected, cached, failed, ms}} where winners[gender] is the archive the game would use for V's lines of that gender (the last that
 * qualifies in alphabetical order: the game loads archives alphabetically and a later one replaces an earlier one's files; to be confirmed in game) or null.
 */
export async function detectVoiceMods({folder, list = null, modLines, cachePath = null, now = () => performance.now(), log = () => {}, files = {readFile, atomicFile}, inspect = inspectArchive, shouldStop = () => false} = {}) {
  const started = now();
  const found = list ? await list() : await listArchives(folder);
  let cache = {};
  if (cachePath) {
    try {
      const raw = JSON.parse(String(await files.readFile(cachePath, 'utf8')).replace(/^﻿/, ''));
      if (raw?.version === V_MOD_CACHE_VERSION && raw.lines === modLines.digest && raw.archives && typeof raw.archives === 'object') cache = raw.archives;
    } catch { cache = {}; }
  }
  const next = {}, archives = [];
  let inspected = 0, cached = 0, failed = 0;
  for (const item of found) {
    if (shouldStop()) break;
    const key = item.relative.toLowerCase(), hit = cache[key];
    let result;
    if (hit && hit.size === item.size && hit.mtimeMs === item.mtimeMs && (hit.result || hit.error)) { result = hit; cached++; }
    else {
      try { result = {size: item.size, mtimeMs: item.mtimeMs, result: await inspect(item.path, modLines)}; inspected++; }
      catch (error) { result = {size: item.size, mtimeMs: item.mtimeMs, error: String(error?.code ?? 'unreadable')}; failed++; }
    }
    next[key] = result;
    archives.push({path: item.path, relative: item.relative, size: item.size, mtimeMs: item.mtimeMs, cached: result === hit, ...(result.error ? {error: result.error} : result.result)});
  }
  if (cachePath && (inspected || failed || Object.keys(cache).length !== Object.keys(next).length)) {
    try { await files.atomicFile(cachePath, JSON.stringify({version: V_MOD_CACHE_VERSION, lines: modLines.digest, archives: next})); } catch (error) { log(`the V voice mod cache could not be saved: ${error?.code ?? 'error'}`); }
  }
  const winners = {};
  for (const gender of GENDERS) {
    const {minCoverage, minLines} = V_MOD_DETECTION;
    const qualifying = archives.filter(a => a[gender] && a[gender].probeHits / a[gender].probeTotal >= minCoverage && a[gender].lineHits.length >= minLines);
    winners[gender] = qualifying.at(-1) ?? null;
    if (qualifying.length > 1) log(`${qualifying.length} mods replace V's ${gender} voice (${qualifying.map(a => basename(a.relative)).join(', ')}); the last in load order wins: ${basename(winners[gender].relative)}`);
  }
  return {archives, winners, stats: {total: found.length, inspected, cached, failed, ms: Math.round(now() - started)}};
}

/** The rows of the gender's line list the archive holds, in the recipe's order (picks first). */
export function linesHeld(modLines, gender, archiveResult) {
  const {lines} = modLines.genders[gender];
  return archiveResult[gender].lineHits.map(index => lines[index]);
}

// ---- keeping V's references current -------------------------------------------------------------------------------------------------------

/** Where the tool that decodes the mod's Wwise lines is: an explicit path, CYBERPUNK_CONVAI_VGMSTREAM, or the first of `candidates` that exists. Null when none. */
export async function findVgmstream({explicit = null, env = process.env, candidates = [], exists = async path => !!(await stat(path).catch(() => null))?.isFile()} = {}) {
  for (const path of [explicit, env.CYBERPUNK_CONVAI_VGMSTREAM, ...candidates].filter(value => typeof value === 'string' && value)) if (await exists(path)) return path;
  return null;
}

/**
 * Brings the folder of mod-built references in line with the mods installed: for each gender with a winning archive, the reference is kept when the
 * manifest says it was built from that very archive (name, size, time) and its WAV still matches its SHA-256, otherwise it is built again; a gender with no
 * winner has its reference removed (the mod is gone). A build that fails is remembered in the manifest (`failed`, by archive name, size, modification time and line-list digest), so
 * the same archive is not tried again at every start (a decoder that is missing is not a failure of the archive and is not remembered); and when the winner changed, the
 * previous mod's reference goes (V then speaks with the shipped clip, never with an older mod's voice under the new mod's name). The folder holds v-voice.json and v-<gender>.wav in the shape of assets/v-voice, so the bridge's
 * loadVVoiceReferences reads it as it reads the shipped one (nothing in the folder is a script or is ever run). A missing decoder means nothing is built
 * and the result says so (`needsDecoder`), never an error. Resolves to {directory, voices: {male?, female?}: 'kept' | 'built' | 'removed' | 'needs-decoder'
 * | 'failed:<code>' | 'failed-before:<code>', sources: {male?, female?}: the archive each kept or built reference came from, detection}.
 */
export async function ensureVoiceModReferences({modFolder = null, list = null, outFolder, modLines, decode = null, cachePath = null, log = () => {}, files = {readFile, atomicFile, rm, mkdir}, detect = detectVoiceMods, build = buildModReference} = {}) {
  const detection = await detect({folder: modFolder, list, modLines, cachePath, log});
  const manifestPath = resolve(outFolder, 'v-voice.json');
  let manifest = {version: 1, voices: {}};
  try { const raw = JSON.parse(String(await files.readFile(manifestPath, 'utf8')).replace(/^﻿/, '')); if (raw?.version === 1 && raw.voices && typeof raw.voices === 'object') manifest = raw; } catch { /* none yet */ }
  if (!manifest.failed || typeof manifest.failed !== 'object' || Array.isArray(manifest.failed)) manifest.failed = {};
  const voices = {}, sources = {}, wavName = gender => `v-${gender}.wav`;
  const removeReference = async gender => { delete manifest.voices[gender]; await files.rm(resolve(outFolder, wavName(gender)), {force: true}).catch(() => {}); };
  let changed = false;
  for (const gender of GENDERS) {
    const winner = detection.winners[gender], row = manifest.voices[gender];
    if (!winner) {
      if (manifest.failed[gender]) { delete manifest.failed[gender]; changed = true; }
      if (row) { await removeReference(gender); changed = true; voices[gender] = 'removed'; log(`the ${gender} V voice mod is gone; its reference was removed`); }
      continue;
    }
    const source = {archive: winner.relative, size: winner.size, mtimeMs: winner.mtimeMs};
    const same = other => other?.archive === source.archive && other.size === source.size && other.mtimeMs === source.mtimeMs;
    if (same(row?.source)) {
      try { if (createHash('sha256').update(await files.readFile(resolve(outFolder, wavName(gender)))).digest('hex') === row.sha256) { voices[gender] = 'kept'; sources[gender] = source.archive; continue; } } catch { /* rebuilt below */ }
    }
    // A build of this very archive failed before (same name, size, time and line list): not tried again until the archive or the list changes.
    const failedBefore = manifest.failed[gender];
    if (same(failedBefore) && failedBefore.lines === modLines.digest) {
      if (row) { await removeReference(gender); changed = true; }
      voices[gender] = `failed-before:${failedBefore.code}`;
      log(`V's ${gender} reference was not built from ${basename(winner.relative)} (${failedBefore.code}, as before); V keeps the shipped voice`);
      continue;
    }
    if (!decode) { voices[gender] = 'needs-decoder'; continue; }
    try {
      const made = await build({archive: winner.path ?? resolve(modFolder, winner.relative), log, lines: linesHeld(modLines, gender, winner), decode, file: wavName(gender)});
      await files.mkdir(outFolder, {recursive: true});
      await files.atomicFile(resolve(outFolder, wavName(gender)), made.wav);
      manifest.voices[gender] = {...made.entry, source};
      delete manifest.failed[gender];
      changed = true; voices[gender] = 'built'; sources[gender] = source.archive;
      log(`V's ${gender} reference was built from ${basename(winner.relative)} (${made.entry.seconds} s)`);
    } catch (error) {
      const code = String(error?.code ?? 'error').slice(0, 40);
      voices[gender] = `failed:${code}`;
      manifest.failed[gender] = {...source, lines: modLines.digest, code};
      // The reference of another (older) mod must not stay: V would speak with its voice while the log and the report name the new one.
      if (row) await removeReference(gender);
      changed = true;
      log(`V's ${gender} reference was not built from ${basename(winner.relative)}: ${code}; V keeps the shipped voice`);
    }
  }
  if (!Object.keys(manifest.failed).length) delete manifest.failed;
  if (changed) { await files.mkdir(outFolder, {recursive: true}); await files.atomicFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n'); }
  return {directory: Object.keys(manifest.voices).length ? outFolder : null, voices, sources, detection};
}
