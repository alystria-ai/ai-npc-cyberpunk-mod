// The runtime/ files of the CET mod folder (bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod/runtime/), and the rule that
// keeps them working under Mod Organizer 2. Shared by the release builder and its tests.
//
// MO2 runs the game and every process it starts (node, Python, the browser) inside USVFS. A NEW file created under the game folder
// lands in MO2's Overwrite folder and is invisible at the next launch; an EXISTING real file that is opened for writing, or replaced
// with MoveFileExW(REPLACE_EXISTING), stays where it is. So every file the Lua and the bridge exchange during normal play is shipped
// in the Scripts package as an empty placeholder, and both sides only modify or replace those files: nothing creates one new, nothing
// deletes one (a "consumed" or "cancelled" signal is an empty file). A missing, an empty and a half-written file all mean "nothing yet"
// to every reader. packaging/runtime-exchange.json lists the files:
//   exchange   shipped as empty placeholders (Scripts package)
//   state      the player's own state (settings, chat history, ...): never shipped, an update would wipe it; the writers keep their
//              temp-file and backup protection
//   optional   switch and probe files a person or a tool creates by hand: a missing file is harmless
//   elsewhere  names the sources write as runtime/<name> that are not in the mod folder (the developer's project runtime/ folder,
//              the data folder): listed so the guard test can tell them from an unclassified exchange file
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
