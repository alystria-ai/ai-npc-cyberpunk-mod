// The runtime/ files of the CET mod folder (bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod/runtime/), and the rule that
// decides what of them a package may carry. Shared by the release builder and its tests.
//
// Nothing the Lua or the bridge rewrites ships. A mod manager that tracks every file it installed (Vortex) reports each of them as
// "changed outside the manager" at every later deploy, and the Scripts package used to carry about 70 of them as empty placeholders.
// Every writer creates its file at its first write and every reader treats a missing, an empty and a half-written file alike, as
// "nothing yet" (a bridge started over no files at all: bridge/startup-exchange-placeholders.test.mjs). The same goes for
// red4ext/plugins/AiNpcCyberpunkMod/launcher.log, which the launcher opens with CREATE_ALWAYS. packaging/runtime-exchange.json lists the files:
//   exchange   written by the game and the service while playing; never shipped (an install made before this change still has them as
//              empty files, which is harmless: every writer opens an existing file in place)
//   state      the player's own state (settings, chat history, ...): never shipped, an update would wipe it; the writers keep their
//              temp-file and backup protection, and the service keeps a durable copy outside the game folder and writes it back at
//              its start (bridge/game-state.mjs)
//   optional   switch and probe files a person or a tool creates by hand: a missing file is harmless (native-off.txt, the kill switch, is
//              the one the Runtime package ships: only a person edits it)
//   elsewhere  names the sources write as runtime/<name> that are not in the mod folder (the developer's project runtime/ folder,
//              the data folder): listed so the guard test can tell them from an unclassified exchange file
// Under Mod Organizer 2 the first write of such a file lands in Overwrite, like every other file the Runtime and the packs create there
// (docs/PACKAGING.md, "Mod Organizer 2").
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export const EXCHANGE_MANIFEST = 'packaging/runtime-exchange.json';
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function checkRuntimeExchange(manifest) {
  const seen = new Map();
  for (const section of ['exchange', 'state', 'optional', 'elsewhere']) {
    const names = manifest?.[section];
    if (!Array.isArray(names)) throw Error(`${EXCHANGE_MANIFEST}: "${section}" must be a list`);
    for (const name of names) {
      if (typeof name !== 'string' || !NAME.test(name) || name.endsWith('.tmp')) throw Error(`${EXCHANGE_MANIFEST}: bad file name ${JSON.stringify(name)} in "${section}"`);
      if (seen.has(name)) throw Error(`${EXCHANGE_MANIFEST}: ${name} is listed in "${seen.get(name)}" and "${section}"`);
      seen.set(name, section);
    }
  }
  return manifest;
}

export async function loadRuntimeExchange(root) {
  return checkRuntimeExchange(JSON.parse(await readFile(resolve(root, EXCHANGE_MANIFEST), 'utf8')));
}

// CET lets the Lua open files only inside its mod folder, and io.open does not create folders, so runtime/ has to exist before the first
// write. It exists because this one static file ships in it, which nothing ever writes.
export const RUNTIME_FOLDER_NOTE = 'This folder is where AI NPC Cyberpunk Mod and its conversation service pass messages and keep notes while the game runs.\r\n'
  + 'The mod creates the files in it when it needs them. Nothing here is for you to edit.\r\n'
  + 'This note is the only file the mod package puts here: it keeps the folder in place, because the scripting in the game cannot create folders.\r\n';

// The only files a package may carry in runtime/: the folder note, and the kill-switch file of the optional native plugin, which only a
// person edits.
export const STATIC_RUNTIME_FILES = Object.freeze(['README.txt', 'native-off.txt']);

// The names (as listed in a package) that a package must not ship because the game or the service writes them while it runs: anything in
// the mod folder's runtime/ besides STATIC_RUNTIME_FILES, and launcher.log in the plugin folder. `layout` is release.config.json's "layout".
export function runtimeWrittenShipped(names, layout) {
  const runtime = `${layout.modDirectory}/runtime/`.toLowerCase(), launcher = `${layout.pluginDirectory}/launcher.log`.toLowerCase();
  const allowed = new Set(STATIC_RUNTIME_FILES.map(name => name.toLowerCase()));
  return names.filter(name => {
    const lower = name.toLowerCase();
    return lower === launcher || (lower.startsWith(runtime) && !allowed.has(lower.slice(runtime.length)));
  });
}
