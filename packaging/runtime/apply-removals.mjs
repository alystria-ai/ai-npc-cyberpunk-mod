// Removes the files an updated Runtime no longer ships. Shipped as app/launcher/apply-removals.mjs and run by start-service.mjs at every start;
// it imports nothing from the bridge so it can be tested on its own.
//
// A Runtime update zip (docs/PACKAGING.md, "Runtime update zip") is extracted over the player's existing Runtime, and extracting adds and
// replaces files but never deletes one. The files a new version no longer ships (a renamed voice clip, a retired model) are therefore listed
// in app/defaults/runtime-removals.json, which every Runtime carries (the full one too, so a full install over an old one cleans up as
// well), and this module deletes them at the next start, so the player never deletes anything by hand:
//
//   {"version": "0.2.3", "removes": ["red4ext/plugins/AiNpcCyberpunkMod/voices/old/clip.wav", ...]}
//
// Each path is relative to the folder the Runtime was extracted into (the game folder, or the Runtime's own mod folder under Mod Organizer 2),
// with forward slashes, exactly as the path is named in the zip. What may be deleted is narrow on purpose: only files, only under the
// folders the Runtime ships into (ALLOWED_ROOTS), never the player's own settings or the optional packs (PROTECTED), and a path that tries
// anything else ("..", an absolute path, a drive, a backslash, a link that leads elsewhere) is refused and counted, not followed.
//
// The protected paths are also checked against the REAL path of the file (the long name Windows reports for it), because on a volume with
// 8.3 names a file has a second spelling (voices/MULTIL~1/x for voices/multilingual/x, app/RELEAS~1.JSO for app/release.json) that the text
// of a list does not match: a part that looks like a short name (~1) is refused outright, and what is left is re-checked after the path is resolved.
//
// Under Mod Organizer 2 the Runtime is a mod folder (mods\<name>\red4ext\plugins\...) that exists only virtually at the game folder. This
// process runs from the REAL place of its own files (start-service.mjs), so the root is worked out from where app/ is, not from the game
// folder: the delete then happens in the Runtime's own mod folder, as a plain delete of a plain file. A file that lives in another MO2 mod is
// not in that folder and so is never touched (it counts as already gone). A Runtime that is not in the standard place (no red4ext/plugins/
// AiNpcCyberpunkMod/app above the script) is left alone.
//
// Safe to repeat: a file that is gone is only counted. It never holds the start for long (a time budget; what is left waits for the next
// start) and a problem is logged, never fatal.
import {lstatSync, readFileSync, realpathSync, rmdirSync, unlinkSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';

export const PLUGIN = 'red4ext/plugins/AiNpcCyberpunkMod';
export const REMOVALS_FILE = 'defaults/runtime-removals.json';

// The folders a Runtime installs into (packaging/build-release.mjs): the launcher's plugin folder, the optional native plugin, the Audioware
// reply bank and the game archives (the last one only for files named like ours).
export const ALLOWED_ROOTS = Object.freeze([
  {prefix: `${PLUGIN}/`},
  {prefix: 'red4ext/plugins/AiNpcCyberpunkModNative/'},
  {prefix: 'r6/audioware/CyberpunkConvai/'},
  {prefix: 'archive/pc/mod/', name: /^(?:convai_|cyberpunk_convai_)[^/]*$/i},
]);
// Under the plugin folder: what is never deleted whatever a list says. The player's launcher.ini (enabled=0 is their choice), launcher.log,
// browser.txt (the browser they named), the optional packs (their own zips), a data folder in the plugin folder, this list and the version stamp.
export const PROTECTED = Object.freeze([
  `${PLUGIN}/launcher.ini`, `${PLUGIN}/launcher.log`, `${PLUGIN}/browser.txt`, `${PLUGIN}/app/release.json`, `${PLUGIN}/app/${REMOVALS_FILE}`,
  `${PLUGIN}/app/omni/`, `${PLUGIN}/app/local-ai/`, `${PLUGIN}/data/`, `${PLUGIN}/state/`,
  // The voice language packs (docs/VOICE_LANGUAGE_PACKS.md): their own zips write this folder, and no Runtime's list ever deletes in it.
  `${PLUGIN}/voices/multilingual/`,
  // The Pocket language models (docs/POCKET_LANGUAGE_MODELS.md): the same, one optional zip per language.
  `${PLUGIN}/voices/multilingual-pocket/`,
]);

const MAX_LIST_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
const DEFAULT_BUDGET_MS = 8_000;

// Why a path may not be removed, or null when it may. `rel` is a path as it stands in the list.
export function refusalFor(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 400) return 'not a path';
  if (/[\x00-\x1f\\:*?"<>|]/.test(rel) || rel.startsWith('/') || isAbsolute(rel)) return 'not a relative path with forward slashes';
  if (rel.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) return 'has an empty, "." or ".." part';
  if (rel.split('/').some(part => /~\d/.test(part))) return 'has a part that looks like an 8.3 short name (~1)';
  const lower = rel.toLowerCase();
  const root = ALLOWED_ROOTS.find(item => lower.startsWith(item.prefix.toLowerCase()));
  if (!root) return 'outside the folders a Runtime installs into';
  if (root.name && !root.name.test(rel.slice(root.prefix.length))) return 'not one of our file names';
  if (PROTECTED.some(item => (item.endsWith('/') ? lower.startsWith(item.toLowerCase()) : lower === item.toLowerCase()))) return 'protected';
  return null;
}

// The folder the Runtime was extracted into, from where its app/ folder is (the real place under Mod Organizer 2), or null.
export function installRootOf(appDirectory) {
  const app = resolve(appDirectory), tail = `${sep}${PLUGIN.split('/').join(sep)}${sep}app`;
  if (!app.toLowerCase().endsWith(tail.toLowerCase())) return null;
  return app.slice(0, app.length - tail.length) || null;
}

// Reads the list; returns {version, removes} or null when there is none (or it is unreadable: said in `problem`).
export function readRemovalList(path) {
  try {
    const text = readFileSync(path, 'utf8');
    if (text.length > MAX_LIST_BYTES) return {problem: 'is too large'};
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || !Array.isArray(value.removes)) return {problem: 'has no "removes" list'};
    return {version: typeof value.version === 'string' ? value.version : null, removes: value.removes};
  } catch (error) {
    return error?.code === 'ENOENT' ? null : {problem: `could not be read (${error?.message || error})`};
  }
}

const inside = (root, path) => { const away = relative(root, path); return away !== '' && !away.startsWith('..') && !isAbsolute(away); };

// Applies the list. `appDirectory` is the Runtime's app/ folder (where this script runs from). Returns
// {state: 'no-list' | 'not-standard' | 'bad-list' | 'done' | 'partial', version, removed, absent, refused, failed, left, root}.
// `realpath` resolves a path to the name Windows reports for it (8.3 short names written out in full); a fake in the tests.
export function applyRuntimeRemovals({appDirectory, log = () => {}, budgetMs = DEFAULT_BUDGET_MS, now = Date.now, realpath = realpathSync.native}) {
  // The native resolver writes short names out; where it cannot work (some network or virtual drives) the plain one stands in. A path that is not there stays an error.
  const real = path => {
    try { return realpath(path); } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw error;
      return realpathSync(path);
    }
  };
  const result = {state: 'no-list', version: null, removed: 0, absent: 0, refused: 0, failed: 0, left: 0, root: null};
  const list = readRemovalList(resolve(appDirectory, REMOVALS_FILE));
  if (!list) return result;
  if (list.problem) { log(`Runtime removal list ${list.problem}; nothing was removed.`); return {...result, state: 'bad-list'}; }
  result.version = list.version;
  const root = installRootOf(appDirectory);
  if (!root) { log('Runtime removal list: this Runtime is not in the standard folder, so nothing was removed.'); return {...result, state: 'not-standard'}; }
  result.root = root;
  let realRoot;
  try { realRoot = real(root); } catch { realRoot = resolve(root); }
  const started = now();
  const removes = list.removes.slice(0, MAX_ENTRIES);
  const refusals = [];
  const parents = new Set();
  for (const [index, rel] of removes.entries()) {
    if (now() - started > budgetMs) { result.left = removes.length - index; break; }
    const why = refusalFor(rel);
    if (why) { result.refused++; if (refusals.length < 3) refusals.push(`${String(rel).slice(0, 80)}: ${why}`); continue; }
    const target = resolve(root, ...rel.split('/'));
    try {
      // A link on the way (a junction in the plugin folder) must not lead outside the Runtime's folder.
      let parent;
      try { parent = real(dirname(target)); }
      catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') { result.absent++; continue; } throw error; }
      if (parent !== realRoot && !inside(realRoot, parent)) { result.refused++; if (refusals.length < 3) refusals.push(`${rel}: leads outside the Runtime's folder`); continue; }
      let info;
      try { info = lstatSync(target); }
      catch (error) { if (error?.code === 'ENOENT') { result.absent++; continue; } throw error; }
      if (info.isDirectory()) { result.refused++; if (refusals.length < 3) refusals.push(`${rel}: is a folder`); continue; }
      // The name the file really has: a short spelling of a protected file is the protected file. (A link is only ever unlinked, never followed,
      // so its own place, with its resolved parent, is what counts.)
      let resolved;
      try { resolved = info.isSymbolicLink() ? join(parent, basename(target)) : real(target); } catch { resolved = null; }
      const away = resolved === null ? null : relative(realRoot, resolved);
      const again = away === null || away === '' || away.startsWith('..') || isAbsolute(away) ? 'cannot be resolved inside the Runtime\'s folder' : refusalFor(away.split(sep).join('/'));
      if (again) { result.refused++; if (refusals.length < 3) refusals.push(`${rel}: ${again}`); continue; }
      unlinkSync(target);
      result.removed++;
      parents.add(dirname(target));
    } catch (error) {
      result.failed++;
      if (refusals.length < 3) refusals.push(`${rel}: ${error?.code || error?.message || error}`);
    }
  }
  // Folders the removals emptied go too, up to (not including) the plugin folder's own top: rmdir only ever removes an empty folder.
  const stop = resolve(root, ...PLUGIN.split('/'));
  for (const folder of parents) {
    for (let at = folder; inside(stop, at); at = dirname(at)) { try { rmdirSync(at); } catch { break; } }
  }
  result.state = result.left || result.failed ? 'partial' : 'done';
  log(`Runtime removal list ${list.version ?? '(no version)'}: ${removes.length} listed, ${result.removed} removed, ${result.absent} already gone`
    + `${result.refused ? `, ${result.refused} refused (${refusals.join('; ')})` : ''}${result.failed ? `, ${result.failed} could not be removed (${refusals.join('; ')})` : ''}`
    + `${result.left ? `, ${result.left} left for the next start` : ''}.`);
  return result;
}
