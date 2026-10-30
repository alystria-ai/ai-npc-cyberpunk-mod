// Builds the FULL INSTALL zip from the two packages a release build wrote (docs/PACKAGING.md, "The Full install package"):
//
//   node packaging/build-full.mjs --version 0.3.4                    (game 2.5, from dist/release/packages)
//   node packaging/build-full.mjs --version 0.3.4 --game 2.31
//
// Input (dist/release/packages/, both written by `node packaging/build-release.mjs --packages scripts,runtime`, same version and game):
//   AI-Companions-LLM-Update-<from>-to-<v>[-for-2.31].zip     (<from> is the Runtime base it needs, or "any", full-package.mjs updateFrom) the update: the mod's code, the launcher and native DLLs, the CET and redscript files
//   Runtime-<v>[-for-2.31].zip                                    the Runtime base: Node, Python, llama.cpp, vgmstream, Playwright, voices, archives
// Output, beside them:
//   AI-Companions-LLM-<v>[-for-2.31].zip                      the two in one zip, extracted into the game folder (the main file for a new player)
//   AI-Companions-LLM-<v>[-for-2.31].files.json               [{path, bytes, sha256}] of every entry, like the other packages
// and a "full" record in release-manifest.json when that file is there.
//
// The two must not overlap (the split of 0.3.4 guarantees it) and the build stops loudly when they do. The combined zip holds every entry of both,
// byte for byte, but one install note of its own (worded for the Full zip) instead of the standard note each of them carries. The guards of the
// two builds run again over the union (packaging/lib/full-package.mjs): no file our own code writes or deletes (the Vortex rule), no development file,
// no key file. The result is checked against the plan by reading its directory back. Nothing is downloaded and no source tree is needed.
//
// Options:
//   --version V        release version (required)      --game 2.5|2.31    (default 2.5)
//   --packages DIR     where the two input zips are and the output goes (default dist/release/packages)
//   --update ZIP, --runtime ZIP   the input zips, when they are not named as a build names them
//   --out DIR          write the output here instead of beside the inputs
//   --release-config PATH   packaging/release.config.json (default)
//   --timestamp ISO    the time of every entry (default: the one the update zip carries, so the same inputs give the same zip)
import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {basename, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipWriter, listZip} from './lib/zip.mjs';
import {entryChunks, entryHead, readEntry} from './lib/zip-entry.mjs';
import {ARCHIVE_HEAD_BYTES, archiveEntry} from './lib/package-guards.mjs';
import {sha256File} from './lib/files.mjs';
import {isReleaseVersion} from './lib/version.mjs';
import {CODE_FOLDER, CODE_MANIFEST} from './lib/code-payload.mjs';
import {REMOVALS_ENTRY} from './lib/runtime-removals.mjs';
import {FULL_NOTE, fullBaseName, planFull, runtimeZipName, updateBaseNameFor} from './lib/full-package.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The DOS date and time of an entry's local header, as the UTC time a ZipWriter was given.
async function entryTime(zip, entry) {
  const handle = await open(zip, 'r');
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.offset);
    const time = header.readUInt16LE(10), date = header.readUInt16LE(12);
    return new Date(Date.UTC(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2));
  } finally { await handle.close(); }
}

const readJsonEntry = async (zip, entries, name) => {
  const entry = entries.find(item => item.name === name);
  return entry ? JSON.parse((await readEntry(zip, entry)).toString('utf8').replace(/^﻿/, '')) : null;
};

/**
 * Combines the update zip and the Runtime base zip into one Full install zip in `outDir`. Returns {file, path, bytes, entries, sha256, files}.
 * Throws, and leaves no output, when the two overlap or break a guard.
 */
export async function buildFull({updatePath, runtimePath, outDir, version, game, config, timestamp, log = () => {}}) {
  const label = path => basename(path);
  const load = async (path, kind) => {
    if (!existsSync(path)) throw Error(`The ${kind} zip is missing: ${path}`);
    return {path, entries: await listZip(path)};
  };
  const [update, runtime] = [await load(updatePath, 'update'), await load(runtimePath, 'Runtime')];
  const part = {
    update: {label: label(updatePath), entries: update.entries, release: await readJsonEntry(updatePath, update.entries, `${config.layout.modDirectory}/release.json`),
      extra: {removes: (await readJsonEntry(updatePath, update.entries, `${CODE_FOLDER}/${CODE_MANIFEST}`))?.removes ?? []}},
    runtime: {label: label(runtimePath), entries: runtime.entries, release: await readJsonEntry(runtimePath, runtime.entries, `${config.layout.pluginDirectory}/app/release.json`),
      extra: {removes: (await readJsonEntry(runtimePath, runtime.entries, REMOVALS_ENTRY))?.removes ?? []}},
  };
  const plan = planFull({...part, config, game, version});
  if (plan.problems.length) throw Error(`The Full install zip cannot be made from ${label(updatePath)} and ${label(runtimePath)}:\n  - ${plan.problems.join('\n  - ')}`);

  // The first bytes of every file too (planFull has the names): a renamed archive is refused here, before the zip is written.
  const archives = [];
  for (const item of plan.entries) {
    if (!item.entry) continue;
    const why = archiveEntry(item.entry.name, await entryHead(item.from === 'update' ? updatePath : runtimePath, item.entry, ARCHIVE_HEAD_BYTES));
    if (why) archives.push(`${item.entry.name} ${why}`);
  }
  if (archives.length) throw Error(`The Full install zip would hold an archive, which the main file must not: ${archives.slice(0, 6).join(', ')}`);

  const base = fullBaseName(version, game);
  await mkdir(outDir, {recursive: true});
  const final = resolve(outDir, `${base}.zip`), temporary = resolve(outDir, `${base}.tmp`);
  const stamp = timestamp ?? await entryTime(updatePath, update.entries[0]);
  const writer = await ZipWriter.create(temporary, {timestamp: stamp});
  const files = [];
  try {
    for (const item of plan.entries) {
      if (item.note) {
        const added = await writer.add(item.note, {buffer: Buffer.from(FULL_NOTE, 'utf8')});
        files.push({path: item.note, bytes: added.uncompressed, sha256: added.sha256});
        continue;
      }
      const source = item.from === 'update' ? updatePath : runtimePath;
      const added = await writer.add(item.entry.name, {chunks: entryChunks(source, item.entry), length: item.entry.uncompressed});
      files.push({path: item.entry.name, bytes: added.uncompressed, sha256: added.sha256});
    }
    await writer.close();
  } catch (error) {
    await writer.handle.close().catch(() => {});
    await rm(temporary, {force: true});
    throw error;
  }
  // Read the result back: the same names, sizes and CRC-32 as the plan.
  const written = await listZip(temporary);
  const expected = new Map(plan.entries.filter(item => item.entry).map(item => [item.entry.name, item.entry]));
  const problems = [];
  if (written.length !== plan.entries.length) problems.push(`${written.length} entries written, ${plan.entries.length} planned`);
  for (const entry of written) {
    const planned = expected.get(entry.name);
    if (entry.name === plan.entries.find(item => item.note)?.note) continue;
    if (!planned) problems.push(`${entry.name} was not planned`);
    else if (planned.uncompressed !== entry.uncompressed || (planned.crc >>> 0) !== (entry.crc >>> 0)) problems.push(`${entry.name} differs from its source`);
  }
  const bytes = (await stat(temporary)).size;
  if (bytes > config.limits.assetBytes) problems.push(`the zip is ${(bytes / 1e9).toFixed(2)} GB, over the ${(config.limits.assetBytes / 1e9).toFixed(2)} GB a single upload takes`);
  if (problems.length) { await rm(temporary, {force: true}); throw Error(`The Full install zip failed its check: ${problems.slice(0, 5).join('; ')}`); }
  await rename(temporary, final);
  const sha256 = await sha256File(final);
  await writeFile(resolve(outDir, `${base}.files.json`), JSON.stringify(files, null, 1) + '\n');
  log(`  ${basename(final)}: ${(bytes / 1024 ** 2).toFixed(1)} MiB, ${written.length} entries (${update.entries.length - 1} from the update, ${runtime.entries.length - 1} from the Runtime base, one install note)`);
  return {file: basename(final), path: final, bytes, entries: written.length, sha256, files};
}

async function main() {
  const argv = process.argv.slice(2);
  const value = (name, fallback) => { const at = argv.indexOf(name); return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback; };
  const version = value('--version');
  if (!isReleaseVersion(version)) { console.error('Usage: node packaging/build-full.mjs --version 0.3.4 [--game 2.5|2.31] [--packages DIR]'); process.exit(2); }
  const game = value('--game', '2.5');
  const packages = resolve(value('--packages', resolve(project, 'dist/release/packages')));
  const config = JSON.parse(await readFile(resolve(value('--release-config', resolve(project, 'packaging/release.config.json'))), 'utf8'));
  const updatePath = resolve(value('--update', resolve(packages, `${updateBaseNameFor(config, version, game)}.zip`)));
  const runtimePath = resolve(value('--runtime', resolve(packages, runtimeZipName(version, game))));
  const outDir = resolve(value('--out', packages));
  const timestamp = value('--timestamp') ? new Date(value('--timestamp')) : undefined;
  const started = Date.now();
  const log = message => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${message}`);
  log(`Full install ${version} for game ${game}: ${basename(updatePath)} + ${basename(runtimePath)}`);
  const result = await buildFull({updatePath, runtimePath, outDir, version, game, config, timestamp, log});
  const manifestPath = resolve(outDir, 'release-manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.packages = {...manifest.packages, full: {archives: [{file: result.file, bytes: result.bytes, entries: result.entries, sha256: result.sha256}],
      fileCount: result.files.length, uncompressedBytes: result.files.reduce((sum, file) => sum + file.bytes, 0)}};
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  log(`Done: ${result.path}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Full install build failed: ${error?.stack || error}`); process.exit(1); });
}
