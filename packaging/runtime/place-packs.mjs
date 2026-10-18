// Puts optional pack files into place when they were extracted one folder too deep.
//
// The optional packs (Local AI lite/standard, Mature lite/standard, OmniVoice) are zips whose entries start at the game root
// (red4ext/plugins/AiNpcCyberpunkMod/app/local-ai/..., .../app/omni/...). Windows "Extract All" and 7-Zip's "Extract to <name>\"
// wrap everything in a folder named after the zip, so a player who extracts inside the game folder ends up with
//   <game>/AI-NPC-Cyberpunk-Mod-LocalAI-Standard-0.2/red4ext/plugins/AiNpcCyberpunkMod/app/local-ai/...
// and the mod never finds the pack. Shipped as app/launcher/place-packs.mjs and run by start-service.mjs before the pack checks.
// It imports nothing from the bridge.
//
// What it looks at (bounded, a handful of stat/readdir calls when there is nothing to fix; it runs once per game start):
//   - the game root's direct child folders, and one more level inside each (X/X/red4ext/...), skipping the game's own folders;
//   - the mod folder (bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod): red4ext/... and app/... extracted into it;
//   - the plugin folder (red4ext/plugins/AiNpcCyberpunkMod): red4ext/... extracted into it, also one wrapper folder deep.
// A candidate counts only when <candidate>/red4ext/plugins/AiNpcCyberpunkMod/app/ holds a pack marker:
//   local-ai/manifest.*.json (Local AI and Mature packs), local-ai/mature/, or omni/omni-pack.json (OmniVoice).
//
// What it moves: only the pack folders of that misplaced app/ (local-ai/, omni/), and for the OmniVoice pack its voices/ folder
// (the pack's reference clips, a sibling of app/). Never the launcher, bridge or anything else a Runtime package holds.
//   - rename (same volume), or a whole folder at once when it does not exist yet; on EXDEV copy, verify the size, then delete;
//   - a file already in place with the same size: the stray copy is dropped; with a different size: both are left as they are;
//   - the markers (manifest.*.json, omni-pack.json) move last, so an interrupted move is retried in full at the next start
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
  return packs;
}

// Every place a wrapped pack may sit, as {base, tree, chain, voices}: `chain` lists the folders removed (deepest first, rmdir
// only) once emptied, and never includes a folder of the real installation.
export async function findCandidates(layout, fs = realFs) {
  const found = [];
  // `removable`: wrapper folders (deepest first) that go once empty, after app, <plugin>, plugins and red4ext of the misplaced tree.
  const addStandard = async (base, removable = []) => {
    const tree = treeOf(base);
    if (resolve(tree) === resolve(layout.app) || await kindOf(fs, tree) !== 'dir') return false;
    found.push({base, tree, voices: join(dirname(tree), 'voices'),
      chain: [tree, dirname(tree), dirname(dirname(tree)), join(base, 'red4ext'), ...removable]});
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

async function moveFile(ctx, source, target, rel) {
  const {fs} = ctx;
  const state = await kindOf(fs, target);
  if (state === 'file') {
    const [a, b] = [await fs.stat(source), await fs.stat(target)];
    if (a.size === b.size) { await fs.unlink(source); ctx.dropped += 1; } else ctx.conflicts.push(rel);
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
      if (marker?.(entry.name)) ctx.deferred.push({from, to, name}); else await moveFile(ctx, from, to, name);
    } else throw new Stop(`${from} is a link or another kind of entry`);
  }
}

// rmdir never removes a folder that still holds anything; a chain stops at the first folder that does.
async function removeChain(fs, folders) {
  for (const folder of folders) { try { await fs.rmdir(folder); } catch { return; } }
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

export async function placeMisplacedPacks({layout, log = () => {}, fs = realFs} = {}) {
  const report = {fixed: [], conflicts: [], errors: []};
  if (await kindOf(fs, layout.app) !== 'dir') return report;
  const candidates = await findCandidates(layout, fs);
  for (const candidate of candidates) {
    const packs = await packsIn(fs, candidate.tree);
    if (!packs.length) continue;
    const label = relative(layout.gameRoot, candidate.base) || '.';
    const ctx = {fs, moved: 0, dropped: 0, conflicts: [], deferred: []};
    const trees = [...new Set(packs.map(pack => pack.tree))];
    const jobs = trees.map(tree => ({rel: tree, source: join(candidate.tree, tree), target: join(layout.app, tree),
      marker: tree === 'local-ai' ? name => LOCAL_MARKER.test(name) : name => name === 'omni-pack.json'}));
    if (trees.includes('omni') && candidate.voices && await kindOf(fs, candidate.voices) === 'dir') {
      jobs.push({rel: 'voices', source: candidate.voices, target: layout.voices, marker: null});
    }
    try {
      for (const job of jobs) {
        await fs.mkdir(job.target, {recursive: true});
        await moveInto(ctx, job.source, job.target, job.rel, job.marker);
      }
      for (const item of ctx.deferred) await moveFile(ctx, item.from, item.to, item.name);
    } catch (error) {
      const message = `Could not finish moving the ${packs.map(pack => pack.name).join(', ')} files into place from ${label}: ${error?.message || error}. The remaining files were left where they are.`;
      log(message);
      report.errors.push(message);
      return report; // stop: nothing else is touched
    }
    for (const job of jobs) await removeEmptyFolders(fs, job.source);
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
