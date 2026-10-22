// Puts optional pack files into place when they were extracted one folder too deep.
//
// The optional packs (Local AI lite/standard, Mature lite/standard, OmniVoice, MicPack-European, MicPack-Asian) are zips whose entries start at the game root
// (red4ext/plugins/AiNpcCyberpunkMod/app/local-ai/..., .../app/omni/..., .../app/models/stt/<id>/...). Windows "Extract All" and 7-Zip's "Extract to <name>\"
// wrap everything in a folder named after the zip, so a player who extracts inside the game folder ends up with
//   <game>/LocalAI-Standard/red4ext/plugins/AiNpcCyberpunkMod/app/local-ai/...
// and the mod never finds the pack. Shipped as app/launcher/place-packs.mjs and run by start-service.mjs before the pack checks.
// It imports nothing from the bridge.
//
// What it looks at (bounded, a handful of stat/readdir calls when there is nothing to fix; it runs once per game start):
//   - the game root's direct child folders, and one more level inside each (X/X/red4ext/...), skipping the game's own folders;
//   - the mod folder (bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod): red4ext/... and app/... extracted into it;
//   - the plugin folder (red4ext/plugins/AiNpcCyberpunkMod): red4ext/... extracted into it, also one wrapper folder deep.
// A candidate counts only when <candidate>/red4ext/plugins/AiNpcCyberpunkMod/app/ holds a pack marker:
//   local-ai/manifest.*.json (Local AI and Mature packs), local-ai/mature/, omni/omni-pack.json (OmniVoice), or
//   models/stt/<id>/mic-pack.json for one of the two voice-input pack ids (MIC_PACKS below);
// or when <candidate>/red4ext/plugins/AiNpcCyberpunkMod/voices/ holds a language pack: multilingual/<code>/manifest.json (a voice language
// pack) or multilingual-pocket/<code>/pocket-model.json (a PocketTTS model). Those zips hold only voices/, no app/.
//
// What it moves: only the pack folders of that misplaced app/ (local-ai/, omni/, models/stt/<id>/ of a voice-input pack), for the OmniVoice pack its
// voices/ folder (the pack's reference clips, a sibling of app/), and for a language pack its own voices/multilingual/<code>/ or
// voices/multilingual-pocket/<code>/ folder. Never the launcher, bridge or anything else a Runtime package holds, and never the
// Runtime's own models/stt/moonshine-tiny-en-int8/ (only the two ids below are looked at).
//   - rename (same volume), or a whole folder at once when it does not exist yet; on EXDEV copy, verify the size, then delete;
//   - a file already in place with the same size: the stray copy is dropped; with a different size: both are left as they are;
//   - the markers (manifest.*.json, omni-pack.json, mic-pack.json) move last, so an interrupted move is retried in full at the next start
//     and a pack is never detected half-placed;
//   - afterwards the wrapper folders are removed with a plain rmdir, so only when empty, and only inside the candidate;
//   - anything unexpected (permissions, a link or other odd entry, a failed rename): stop, leave what is left, log it.
import * as realFs from 'node:fs/promises';
import {dirname, join, relative, resolve} from 'node:path';

const NAME = 'AiNpcCyberpunkMod';
const MOD_PARTS = Object.freeze(['bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', NAME]);
// Folders of the game itself (and of other tools) that are never searched for a wrapped pack.
export const GAME_FOLDERS = Object.freeze(new Set(['archive', 'bin', 'engine', 'r6', 'red4ext', 'mods', 'tools', 'plugins', 'support',
  'localization', 'redprelauncher', 'redmod', 'app', 'voices', 'node_modules', '.git']));
// Pack folders under app/ that are moved. A sibling of app/ moved with the OmniVoice pack.
const APP_TREES = Object.freeze(['local-ai', 'omni']);
const LOCAL_MARKER = /^manifest\.[A-Za-z0-9._-]+\.json$/;
// The voice-input packs: pack id (the folder under app/models/stt/, bridge/speech-language.mjs LOCAL_PACKS) -> name in the log. The marker is mic-pack.json.
// The ids are repeated here because this file imports nothing from the bridge (packaging/mic-packs.test.mjs checks them against release.config.json).
export const MIC_PACKS = Object.freeze({'parakeet-tdt-0.6b-v3-int8': 'MicPack-European', 'sense-voice-int8': 'MicPack-Asian'});
const MIC_MARKER = 'mic-pack.json';
// The language packs: voices/multilingual/<code>/manifest.json (voice language pack, scripts/voice-packs/package_pack.mjs) and
// voices/multilingual-pocket/<code>/pocket-model.json (PocketTTS model, packaging/build-pocket-models.mjs). The folder names are the language codes
// (fr, it, de, es-es, pt-br ...).
export const LANGUAGE_PACKS = Object.freeze([
  {folder: 'multilingual', marker: 'manifest.json', label: 'Voice language pack'},
  {folder: 'multilingual-pocket', marker: 'pocket-model.json', label: 'PocketTTS model'},
]);
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i;
const micTree = id => `models/stt/${id}`;
const PACK_NAMES = Object.freeze({
  'manifest.standard.json': 'Local AI standard', 'manifest.lite.json': 'Local AI lite',
  'manifest.mature-standard.json': 'Mature standard', 'manifest.mature-lite.json': 'Mature lite',
});

const kindOf = async (fs, path) => {
  try {
    const info = await fs.lstat(path);
    return info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other';
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'none';
    throw error;
  }
};
const entriesOf = async (fs, path) => { try { return await fs.readdir(path, {withFileTypes: true}); } catch { return []; } };
const treeOf = base => join(base, 'red4ext', 'plugins', NAME, 'app');

// The language packs a misplaced voices folder holds: [{name, voiceTree: 'multilingual/fr', marker}].
async function languagePacksIn(fs, voices) {
  const packs = [];
  if (!voices) return packs;
  for (const {folder, marker, label} of LANGUAGE_PACKS) {
    for (const entry of await entriesOf(fs, join(voices, folder))) {
      if (entry.isDirectory() && LANGUAGE_CODE.test(entry.name) && await kindOf(fs, join(voices, folder, entry.name, marker)) === 'file') {
        packs.push({name: `${label} (${entry.name})`, tree: null, voiceTree: `${folder}/${entry.name}`, marker});
      }
    }
  }
  return packs;
}

// Which packs the misplaced app folder holds (empty when it holds none).
async function packsIn(fs, tree) {
  const packs = [];
  const local = await entriesOf(fs, join(tree, 'local-ai'));
  for (const entry of local) {
    if (entry.isFile() && LOCAL_MARKER.test(entry.name)) packs.push({name: PACK_NAMES[entry.name.toLowerCase()] ?? 'Local AI', tree: 'local-ai'});
  }
  if (!packs.some(pack => pack.name.startsWith('Mature'))
      && local.some(entry => entry.isDirectory() && entry.name.toLowerCase() === 'mature')
      && (await entriesOf(fs, join(tree, 'local-ai', 'mature'))).length) packs.push({name: 'Mature', tree: 'local-ai'});
  if (await kindOf(fs, join(tree, 'omni', 'omni-pack.json')) === 'file') packs.push({name: 'OmniVoice', tree: 'omni'});
  for (const [id, name] of Object.entries(MIC_PACKS)) {
    if (await kindOf(fs, join(tree, 'models', 'stt', id, MIC_MARKER)) === 'file') packs.push({name, tree: micTree(id)});
  }
  return packs;
}

// Every place a wrapped pack may sit, as {base, tree, chain, voices}: `chain` lists the folders removed (deepest first, rmdir
// only) once emptied, and never includes a folder of the real installation.
export async function findCandidates(layout, fs = realFs) {
  const found = [];
  // `removable`: wrapper folders (deepest first) that go once empty, after app, <plugin>, plugins and red4ext of the misplaced tree.
  const addStandard = async (base, removable = []) => {
    const tree = treeOf(base), voices = join(dirname(tree), 'voices');
    if (resolve(tree) === resolve(layout.app) || resolve(voices) === resolve(layout.voices)) return false;
    // A language pack has no app/ folder, only voices/: either one makes this a candidate.
    if (await kindOf(fs, tree) !== 'dir' && await kindOf(fs, voices) !== 'dir') return false;
    found.push({base, tree, voices, chain: [tree, voices, dirname(tree), dirname(dirname(tree)), join(base, 'red4ext'), ...removable]});
    return true;
  };

  // 1. The game root's child folders, and one level further.
  const skip = name => GAME_FOLDERS.has(name.toLowerCase());
  const top = (await entriesOf(fs, layout.gameRoot)).filter(entry => entry.isDirectory() && !skip(entry.name));
  await Promise.all(top.map(async entry => {
    const base = join(layout.gameRoot, entry.name);
    if (await addStandard(base, [base])) return;
    for (const inner of (await entriesOf(fs, base)).filter(item => item.isDirectory() && !skip(item.name))) {
      await addStandard(join(base, inner.name), [join(base, inner.name), base]);
    }
  }));
  // 2. Extracted into the CET mod folder: the whole tree, or just the app folder.
  await addStandard(layout.mod);
  const bare = join(layout.mod, 'app');
  if (await kindOf(fs, bare) === 'dir') found.push({base: layout.mod, tree: bare, voices: null, chain: [bare]});
  // 3. Extracted into the plugin folder: red4ext/... inside it, or inside one wrapper folder of it.
  await addStandard(layout.plugin);
  for (const entry of (await entriesOf(fs, layout.plugin)).filter(item => item.isDirectory() && !skip(item.name))) {
    await addStandard(join(layout.plugin, entry.name), [join(layout.plugin, entry.name)]);
  }
  // Deduplicate by tree, then keep a stable order.
  const seen = new Set();
  return found.filter(item => { const key = resolve(item.tree).toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => a.tree.localeCompare(b.tree));
}

class Stop extends Error {}

async function copyVerified(fs, source, target, size) {
  await fs.copyFile(source, target, 1); // COPYFILE_EXCL: never overwrite
  const copied = await fs.stat(target);
  if (copied.size !== size) { await fs.rm(target, {force: true}); throw new Stop(`the copy of ${source} has the wrong size`); }
  await fs.unlink(source);
}

// Whether two files of the same size hold the same bytes (read in chunks, nothing kept). False when either cannot be read.
async function sameBytes(fs, first, second) {
  let a, b;
  try {
    a = await fs.open(first, 'r'); b = await fs.open(second, 'r');
    const x = Buffer.alloc(1 << 20), y = Buffer.alloc(1 << 20);
    for (;;) {
      const [one, two] = [await a.read(x, 0, x.length, null), await b.read(y, 0, y.length, null)];
      if (one.bytesRead !== two.bytesRead || !x.subarray(0, one.bytesRead).equals(y.subarray(0, two.bytesRead))) return false;
      if (one.bytesRead === 0) return true;
    }
  } catch { return false; } finally { await a?.close().catch(() => {}); await b?.close().catch(() => {}); }
}

async function moveFile(ctx, source, target, rel) {
  const {fs} = ctx;
  const state = await kindOf(fs, target);
  if (state === 'file') {
    const [a, b] = [await fs.stat(source), await fs.stat(target)];
    // A language pack or Pocket model that is extracted again may be a NEWER build with files of the same size (weights change, sizes do not): its bytes are
    // compared before a stray copy is dropped, and a copy that differs is left where it is, never deleted.
    if (a.size === b.size && (!ctx.verifyContent || await sameBytes(fs, source, target))) { await fs.unlink(source); ctx.dropped += 1; } else ctx.conflicts.push(rel);
    return;
  }
  if (state !== 'none') { ctx.conflicts.push(rel); return; }
  await fs.mkdir(dirname(target), {recursive: true});
  try { await fs.rename(source, target); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await copyVerified(fs, source, target, (await fs.stat(source)).size);
  }
  ctx.moved += 1;
}

// Moves what is inside `source` into `target`. Folders that do not exist at the target move whole, everything else file by file.
// Markers (`marker(rel)`) at the top of a pack folder are only queued: they move last.
async function moveInto(ctx, source, target, rel, marker) {
  const {fs} = ctx;
  for (const entry of (await fs.readdir(source, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    const from = join(source, entry.name), to = join(target, entry.name), name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const state = await kindOf(fs, to);
      if (state === 'none') {
        await fs.mkdir(dirname(to), {recursive: true});
        try { await fs.rename(from, to); ctx.moved += 1; continue; }
        catch (error) { if (error.code !== 'EXDEV') throw error; }
        await fs.mkdir(to, {recursive: true});
        await moveInto(ctx, from, to, name, null);
      } else if (state === 'dir') await moveInto(ctx, from, to, name, null);
      else ctx.conflicts.push(name);
    } else if (entry.isFile()) {
      if (marker?.(entry.name)) ctx.deferred.push({from, to, name, verifyContent: ctx.verifyContent === true}); else await moveFile(ctx, from, to, name);
    } else throw new Stop(`${from} is a link or another kind of entry`);
  }
}

// rmdir never removes a folder that still holds anything; a chain stops at the first folder that does.
async function removeChain(fs, folders) {
  for (const folder of folders) { try { await fs.rmdir(folder); } catch (error) { if (error?.code !== 'ENOENT') return; } }
}

// Folders of a moved tree that are now empty, deepest first, so a pack folder vanishes when nothing was left behind in it.
async function removeEmptyFolders(fs, root) {
  const folders = [];
  const walk = async dir => {
    for (const entry of await entriesOf(fs, dir)) if (entry.isDirectory()) await walk(join(dir, entry.name));
    folders.push(dir);
  };
  await walk(root);
  for (const folder of folders) { try { await fs.rmdir(folder); } catch {} }
}

// What this start's move did, for the bridge's setup check (bridge/setup-check.mjs readPackPlacement) and the support report: one small
// file in the state folder (outside the game folder in a released install), replaced at every start. The caller logs a failure and goes on.
export const PLACEMENT_FILE = 'pack-placement.json';
export async function recordPlacement({state, report, fs = realFs, now = Date.now}) {
  await fs.mkdir(state, {recursive: true});
  await fs.writeFile(join(state, PLACEMENT_FILE), JSON.stringify({version: 1, updated: now(),
    fixed: report?.fixed ?? [], conflicts: report?.conflicts ?? [], errors: report?.errors ?? []}));
}

export async function placeMisplacedPacks({layout, log = () => {}, fs = realFs} = {}) {
  const report = {fixed: [], conflicts: [], errors: []};
  if (await kindOf(fs, layout.app) !== 'dir') return report;
  const candidates = await findCandidates(layout, fs);
  for (const candidate of candidates) {
    const packs = [...await packsIn(fs, candidate.tree), ...await languagePacksIn(fs, candidate.voices)];
    if (!packs.length) continue;
    const label = relative(layout.gameRoot, candidate.base) || '.';
    const ctx = {fs, moved: 0, dropped: 0, conflicts: [], deferred: []};
    const trees = [...new Set(packs.map(pack => pack.tree).filter(Boolean))];
    const markerOf = tree => tree === 'local-ai' ? name => LOCAL_MARKER.test(name) : tree === 'omni' ? name => name === 'omni-pack.json' : name => name === MIC_MARKER;
    const jobs = trees.map(tree => ({rel: tree, source: join(candidate.tree, tree), target: join(layout.app, tree), marker: markerOf(tree)}));
    if (trees.includes('omni') && candidate.voices && await kindOf(fs, candidate.voices) === 'dir') {
      jobs.push({rel: 'voices', source: candidate.voices, target: layout.voices, marker: null});
    } else {
      // A language pack moves its own folder (the whole voices/ tree is moved with an OmniVoice pack above); its manifest moves last.
      for (const pack of packs.filter(item => item.voiceTree)) {
        jobs.push({rel: `voices/${pack.voiceTree}`, source: join(candidate.voices, ...pack.voiceTree.split('/')),
          target: join(layout.voices, ...pack.voiceTree.split('/')), marker: name => name === pack.marker, verifyContent: true});
      }
    }
    try {
      for (const job of jobs) {
        await fs.mkdir(job.target, {recursive: true});
        ctx.verifyContent = job.verifyContent === true;
        await moveInto(ctx, job.source, job.target, job.rel, job.marker);
      }
      for (const item of ctx.deferred) { ctx.verifyContent = item.verifyContent === true; await moveFile(ctx, item.from, item.to, item.name); }
    } catch (error) {
      const message = `Could not finish moving the ${packs.map(pack => pack.name).join(', ')} files into place from ${label}: ${error?.message || error}. The remaining files were left where they are.`;
      log(message);
      report.errors.push(message);
      return report; // stop: nothing else is touched
    }
    for (const job of jobs) await removeEmptyFolders(fs, job.source);
    // A language pack leaves voices/multilingual (or multilingual-pocket) behind once its last language moved.
    for (const pack of packs.filter(item => item.voiceTree)) await removeChain(fs, [join(candidate.voices, pack.voiceTree.split('/')[0])]);
    // A voice-input pack sat two folders down (models/stt/<id>): those two go too once empty (only inside the misplaced tree), so app/ can follow.
    if (trees.some(tree => tree.startsWith('models/stt/'))) await removeChain(fs, [join(candidate.tree, 'models', 'stt'), join(candidate.tree, 'models')]);
    await removeChain(fs, candidate.chain);
    for (const pack of packs) {
      log(`Moved the ${pack.name} files into place from ${label}`);
      report.fixed.push({pack: pack.name, from: label});
    }
    if (ctx.conflicts.length) {
      const note = `Left ${ctx.conflicts.length} file${ctx.conflicts.length === 1 ? '' : 's'} in ${label} because a different file is already in place (for example ${ctx.conflicts[0]}).`;
      log(note);
      report.conflicts.push(...ctx.conflicts);
    }
  }
  return report;
}
