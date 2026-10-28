// What no package may ship because the mod, the launcher, install-code.mjs or the service writes, replaces or deletes it. A mod manager that tracks
// every file it deployed (Vortex: hardlinks from its staging folder) reports a deployed file that was later replaced, deleted or changed as
// "changed outside the manager" (docs/PACKAGING.md, "Files the game rewrites"). So the rule for the Scripts zip and for a Runtime base zip is:
// nothing in either is ever written, replaced or deleted by our own code. Writes into files no package ships are fine.
//
// Shared by packaging/build-release.mjs (which refuses to build a package that breaks it) and packaging/vortex-no-rewrites.test.mjs. The writers:
//   - the Lua and the service: anything in the CET mod folder's runtime/ but the static note (runtimeWrittenShipped), launcher.log (the launcher
//     opens it with CREATE_ALWAYS, in the folder of its own DLL, and an older Runtime's launcher in its plugin folder)
//   - install-code.mjs: the Runtime's code copy (isCodeGamePath), its list and error note, the temporary and .old-<pid> copies beside a target
//     (LEFTOVER, swept by sweepLeftovers), the code files code.json "removes" lists, and GAME_REMOVALS (deleted for that game)
//   - the launcher: an older Runtime's two DLLs (RETIRED_DLLS), renamed to <name>.retired
//   - apply-removals.mjs: whatever packaging/runtime-removals.json lists (and an update zip's list)
//   - migrate-legacy.mjs: the folders of the mod's first name (CyberpunkConvai)
import {RETIRED_DLLS, RUNTIME_APP, isCodeGamePath, isCodePath} from './code-payload.mjs';
import {runtimeWrittenShipped} from './runtime-exchange.mjs';
import {ERROR_NOTE, GAME_REMOVALS, LEFTOVER} from '../runtime/install-code.mjs';

// The folders of the mod's first name: migrate-legacy.mjs renames and deletes what it finds there.
const LEGACY_FOLDERS = Object.freeze(['bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai/', 'red4ext/plugins/CyberpunkConvai/', 'red4ext/plugins/CyberpunkConvaiNative/']);

/**
 * `names`: the game-relative entries of one package. `layout`: release.config.json "layout". `game`: '2.5' or '2.31'.
 * `removes`: paths (game-relative, or app-relative for `codeRemoves`) that a removal list deletes at the start.
 * Returns [{name, why}] for every entry that one of our own writers touches.
 */
export function shippedButWritten(names, {layout, game, removes = [], codeRemoves = []}) {
  const found = [];
  const add = (name, why) => found.push({name, why});
  for (const name of runtimeWrittenShipped(names, layout)) add(name, 'the game, the launcher or the service writes it (runtime/ or launcher.log)');
  const lower = new Map(names.map(name => [name.toLowerCase(), name]));
  const hit = (path, why) => { const name = lower.get(String(path).toLowerCase()); if (name) add(name, why); };
  for (const name of names) {
    if (isCodeGamePath(name) || name.toLowerCase() === `${RUNTIME_APP}/${ERROR_NOTE}`.toLowerCase()) add(name, 'install-code.mjs replaces or deletes it in the Runtime');
    else if (LEFTOVER.test(name)) add(name, 'install-code.mjs sweeps files named like this');
    else if (LEGACY_FOLDERS.some(folder => name.toLowerCase().startsWith(folder.toLowerCase()))) add(name, 'migrate-legacy.mjs renames or deletes what is in the mod\'s first folders');
  }
  for (const path of RETIRED_DLLS) hit(path, 'the launcher renames an older Runtime\'s DLL to .retired');
  for (const path of GAME_REMOVALS[game] ?? []) hit(path, `install-code.mjs deletes it for game ${game}`);
  for (const rel of codeRemoves) if (isCodePath(rel)) hit(`${RUNTIME_APP}/${rel}`, 'code.json "removes" lists it for deletion');
  for (const path of removes) hit(path, 'a removal list deletes it at the next start');
  return found;
}
