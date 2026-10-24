// Builds a Runtime update zip: only what changed between two full Runtime zips, to be extracted over the player's existing Runtime.
//
//   node packaging/build-runtime-update.mjs --old <previous full Runtime zip> --new <new full Runtime zip> --out <folder>
//        [--old <part 2>] [--new <part 2>]    (a Runtime made of several zips: name every part)
//        [--from 0.2.2 --to 0.2.3]            (default: the version in each Runtime's app/release.json)
//        [--remove <path>]...                 (a file to remove besides those found by the comparison; relative to the game folder)
//        [--listing <pack listing json> | --no-listing]
//        [--switch-game]                      (the old Runtime is for another game than the new one: the zip moves a player from one game's build to the other,
//                                              named with the new game's suffix. Only meaningful from a Runtime of the same version line, e.g. 0.3.0 (2.31) to 0.3.1 for 2.5.)
//
// It writes, into the folder:
//   Runtime-Update-<from>-to-<to>[-for-<game>].zip   (the suffix only for a game other than 2.31: packaging/game-variants.json; both Runtimes must be for the same game unless --switch-game is given)
//                                             every file the new Runtime has and the old one did not, or has with other
//                                                                  bytes (path, size and CRC-32 are compared), the new app/release.json, and
//                                                                  app/defaults/runtime-removals.json, and app/defaults/runtime-steps/step-<from>-to-<to>.json
//                                                                  (the step marker: a later setup check names an update step a player skipped)
//   Runtime-Update-<from>-to-<to>.files.json  path, size and SHA-256 of every file in the zip (the same shape as the full builds')
//   (no loose checksum file: the SHA-256 of the zip is in the summary this prints and returns)
//
// The removal list in the zip names the files the old Runtime had and the new one does not (and those the new Runtime's own list declares and
// any --remove): extracting adds and replaces but never deletes, so the service deletes them itself at its next start
// (packaging/runtime/apply-removals.mjs; docs/PACKAGING.md, "Runtime update zip"). A path the start step may not delete (outside the folders a
// Runtime installs into, or protected) or that an optional pack ships is left in place and reported, never listed.
//
// It only reads the two zips' directories and the entries it copies, and it does not depend on how the full zips were made. The same inputs
// give the same bytes.
import {mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipWriter, listZip} from './lib/zip.mjs';
import {extractEntry, readEntry} from './lib/zip-entry.mjs';
import {sha256File} from './lib/files.mjs';
import {PLUGIN} from './runtime/apply-removals.mjs';
import {REMOVALS_ENTRY, checkRemovals, removalListText} from './lib/runtime-removals.mjs';
import {validateListing} from './lib/pack-overlap.mjs';
import {STEPS_DIR, stepFileName, stepText} from '../bridge/runtime-steps.mjs';
import {DEFAULT_GAME, GAME_VARIANTS} from './lib/game-variants.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
export const DEFAULT_LISTING = resolve(project, 'packaging/pack-listings/packs-0.2.1.json');
export const RELEASE_ENTRY = `${PLUGIN}/app/release.json`;
// The step marker this zip adds (bridge/runtime-steps.mjs): its own file, so zips applied one after the other leave one marker each. The
// marker files of the two Runtimes compared (base.json, earlier steps) are never copied: they describe those Runtimes, not this step.
export const STEPS_PREFIX = `${PLUGIN}/app/${STEPS_DIR}/`.toLowerCase();

const sameBytes = (a, b) => a.uncompressed === b.uncompressed && (a.crc >>> 0) === (b.crc >>> 0);
const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The files of one Runtime (one zip or several parts): Map of lower-case path -> {name, zip, entry}. A path in two parts must be the same bytes.
export async function runtimeFiles(zips) {
  const files = new Map();
  for (const zip of zips) {
    for (const entry of await listZip(zip)) {
      if (entry.name.endsWith('/')) continue;
      const key = entry.name.toLowerCase(), known = files.get(key);
      if (known && !sameBytes(known.entry, entry)) throw Error(`${entry.name} is in ${basename(known.zip)} and in ${basename(zip)} with different bytes.`);
      if (!known) files.set(key, {name: entry.name, zip, entry});
    }
  }
  return files;
}

// What changed from `before` to `after` (both from runtimeFiles): {added, changed, unchanged, removed}, each a sorted list of {name, zip, entry}
// (removed ones come from `before`).
export function compareRuntimes(before, after) {
  const added = [], changed = [], removed = [];
  let unchanged = 0;
  for (const [key, now] of after) {
    const was = before.get(key);
    if (!was) added.push(now);
    else if (!sameBytes(was.entry, now.entry)) changed.push(now);
    else unchanged++;
  }
  for (const [key, was] of before) if (!after.has(key)) removed.push(was);
  const sort = list => list.sort((a, b) => byPath(a.name, b.name));
  return {added: sort(added), changed: sort(changed), unchanged, removed: sort(removed)};
}

async function releaseVersion(files, label) {
  const found = files.get(RELEASE_ENTRY.toLowerCase());
  if (!found) throw Error(`The ${label} Runtime has no ${RELEASE_ENTRY}; name its version with --${label === 'old' ? 'from' : 'to'}.`);
  const release = JSON.parse((await readEntry(found.zip, found.entry)).toString('utf8'));
  if (release.package !== 'runtime' || typeof release.version !== 'string') throw Error(`The ${label} zip's release.json is not a Runtime's.`);
  return release.version;
}

// The game a Runtime was built for (release.json "game"); a Runtime from before there was a build per game is the default game's.
async function releaseGame(files) {
  const found = files.get(RELEASE_ENTRY.toLowerCase());
  if (!found) return DEFAULT_GAME;
  const game = JSON.parse((await readEntry(found.zip, found.entry)).toString('utf8')).game;
  return typeof game === 'string' && game ? game : DEFAULT_GAME;
}

// The paths of every file the optional packs ship (any case), so that the update never deletes one a pack put there.
export const packPaths = listing => new Set(listing.packs.flatMap(pack => pack.files.map(([path]) => path.toLowerCase())));

export async function buildRuntimeUpdate({oldZips, newZips, out, from, to, remove = [], listing = null, switchGame = false, log = console.log}) {
  if (!oldZips.length || !newZips.length) throw Error('Name the previous full Runtime (--old) and the new one (--new).');
  const before = await runtimeFiles(oldZips), after = await runtimeFiles(newZips);
  from ??= await releaseVersion(before, 'old');
  to ??= await releaseVersion(after, 'new');
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(from) || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(to)) throw Error(`Unusable version names: "${from}", "${to}".`);
  if (from === to) throw Error(`Both Runtimes are version ${from}.`);
  // An update step stays within one game unless a switch is asked for: a 2.31 Runtime and a 2.5 Runtime differ in the native plugin and are two separate update
  // chains. A switch step (--switch-game) is the one zip that takes a Runtime of one game to the next version of the other game's build.
  const game = await releaseGame(after), oldGame = await releaseGame(before);
  if (switchGame ? oldGame === game : oldGame !== game) {
    throw Error(switchGame ? `Both Runtimes are for game ${game}; a switch update is built from a Runtime of another game.`
      : `The old Runtime is for game ${oldGame} and the new one for game ${game}; an update zip is built within one game (--switch-game builds the step from one game to the other).`);
  }
  if (!Object.hasOwn(GAME_VARIANTS, oldGame)) throw Error(`The old Runtime is for game ${oldGame}, which packaging/game-variants.json does not list.`);
  if (!Object.hasOwn(GAME_VARIANTS, game)) throw Error(`The Runtime is for game ${game}, which packaging/game-variants.json does not list.`);
  const diff = compareRuntimes(before, after);

  // The removal list: what went away, what the new Runtime's own list declares, and the extra paths asked for.
  const ownList = after.get(REMOVALS_ENTRY.toLowerCase());
  const declared = ownList ? (JSON.parse((await readEntry(ownList.zip, ownList.entry)).toString('utf8')).removes ?? []) : [];
  const shipped = new Set([...after.values()].map(item => item.name));
  const wanted = [...diff.removed.map(item => item.name).filter(name => name.toLowerCase() !== REMOVALS_ENTRY.toLowerCase()), ...declared, ...remove];
  const packs = listing ? packPaths(listing) : new Set();
  const claimed = listing ? listing.packs.flatMap(pack => pack.claimed.map(item => item.prefix.toLowerCase())) : [];
  const byPack = wanted.filter(path => packs.has(path.toLowerCase()) || claimed.some(prefix => path.toLowerCase().startsWith(prefix)));
  const checked = checkRemovals(wanted.filter(path => !byPack.includes(path)), shipped);
  const leftInPlace = [...checked.refused.map(item => `${item.path} (${item.why})`), ...byPack.map(path => `${path} (an optional pack ships it)`)];

  const work = await mkdtemp(join(tmpdir(), 'runtime update '));
  try {
    await mkdir(out, {recursive: true});
    // The name of a game other than the default carries its suffix (Runtime-Update-0.3.1-to-0.3.2-for-2.5.zip), so the zips cannot be mixed up.
    const base = `Runtime-Update-${from}-to-${to}${GAME_VARIANTS[game].suffix}`;
    const zipPath = resolve(out, `${base}.zip`), temporary = `${zipPath}.tmp`;
    const writer = await ZipWriter.create(temporary);
    const files = [];
    // The version stamp always goes (it is what the next start and the next update read); the removal list is the one made above.
    const release = after.get(RELEASE_ENTRY.toLowerCase());
    const copy = [...diff.added, ...diff.changed, ...(release && !diff.changed.includes(release) && !diff.added.includes(release) ? [release] : [])]
      .filter(item => item.name.toLowerCase() !== REMOVALS_ENTRY.toLowerCase() && !item.name.toLowerCase().startsWith(STEPS_PREFIX));
    const stepEntry = `${PLUGIN}/app/${STEPS_DIR}/${stepFileName(from, to)}`;
    const listText = Buffer.from(removalListText(to, checked.ok), 'utf8');
    const entries = [...copy.map(item => ({name: item.name, item})), {name: REMOVALS_ENTRY, buffer: listText},
      {name: stepEntry, buffer: Buffer.from(stepText(from, to), 'utf8')}].sort((a, b) => byPath(a.name, b.name));
    for (const [index, entry] of entries.entries()) {
      let added;
      if (entry.buffer) added = await writer.add(entry.name, {buffer: entry.buffer});
      else {
        const file = join(work, String(index));
        await extractEntry(entry.item.zip, entry.item.entry, file);
        added = await writer.add(entry.name, {source: file});
        await rm(file, {force: true});
      }
      files.push({path: entry.name, bytes: added.uncompressed, sha256: added.sha256});
    }
    const closed = await writer.close();
    await rename(temporary, zipPath);
    const sha256 = await sha256File(zipPath);
    await writeFile(resolve(out, `${base}.files.json`), JSON.stringify(files, null, 1) + '\n');
    const summary = {from, to, game, ...(switchGame ? {switchedFrom: oldGame} : {}), zip: zipPath, bytes: closed.bytes, entries: closed.entries, sha256, added: diff.added.length, changed: diff.changed.length,
      unchanged: diff.unchanged, removals: checked.ok.length, leftInPlace};
    log(`${base}.zip: ${(closed.bytes / 1024 ** 2).toFixed(1)} MiB, ${closed.entries} files (${diff.added.length} added, ${diff.changed.length} changed, ${diff.unchanged} unchanged and left out), `
      + `${checked.ok.length} file(s) in the removal list.`);
    for (const line of leftInPlace.slice(0, 20)) log(`  left in place, not in the removal list: ${line}`);
    if (leftInPlace.length > 20) log(`  ... and ${leftInPlace.length - 20} more`);
    log(`SHA-256 ${sha256}`);
    return summary;
  } finally { await rm(work, {recursive: true, force: true}); }
}

async function main(argv) {
  const all = name => argv.flatMap((item, index) => (item === name && argv[index + 1] ? [argv[index + 1]] : []));
  const one = name => all(name)[0];
  const out = one('--out');
  if (!out || !all('--old').length || !all('--new').length) {
    console.error('Usage: build-runtime-update.mjs --old <full Runtime zip> --new <full Runtime zip> --out <folder> [--from V --to V] [--remove PATH]... [--listing FILE | --no-listing] [--switch-game]');
    return 2;
  }
  const listing = argv.includes('--no-listing') ? null : validateListing(JSON.parse(await readFile(resolve(one('--listing') ?? DEFAULT_LISTING), 'utf8')));
  await buildRuntimeUpdate({oldZips: all('--old').map(path => resolve(path)), newZips: all('--new').map(path => resolve(path)), out: resolve(out),
    from: one('--from'), to: one('--to'), remove: all('--remove'), listing, switchGame: argv.includes('--switch-game')});
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error?.stack || error.message); process.exitCode = 1; });
}
