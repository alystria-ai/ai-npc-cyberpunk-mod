import {readFileSync} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// The game versions the release is built for (packaging/game-variants.json, docs/GAME_VERSIONS.md).
const here = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(here, '..', 'game-variants.json');

/** {<game id>: {label, exeVersion, suffix, hfFolder, requirements}}; the default game (2.5) has an empty suffix and folder, the older 2.31 has "-for-2.31" and "game-2.31". */
export const GAME_VARIANTS = Object.freeze(JSON.parse(readFileSync(FILE, 'utf8')).variants);

/** The default variant's id: the one with no suffix (game 2.5). */
export const DEFAULT_GAME = Object.keys(GAME_VARIANTS).find(id => GAME_VARIANTS[id].suffix === '');

/** The game of a Runtime or Scripts whose release.json has no "game" field: everything built before there was a build per game was for 2.31, whatever the default is now. */
export const LEGACY_GAME = '2.31';

/**
 * The entries of a release list (`{source, target, games?}`) that ship for `game`: an entry without `games` ships for every game, one with `games`
 * only for the games it names (the ambient driver guard archive is built from a 2.31 quest phase, so only the 2.31 Runtime carries it). A name
 * that is not a game of game-variants.json is refused, so a typo cannot drop a file from every build.
 */
export function forGame(entries, game) {
  for (const entry of entries) {
    for (const id of entry.games ?? []) if (!Object.hasOwn(GAME_VARIANTS, id)) throw Error(`${entry.target}: unknown game ${id} in "games"`);
  }
  return entries.filter(entry => !entry.games || entry.games.includes(game));
}

/**
 * The files a variant lays over the source's own: Map of game-relative target path (forward slashes) to the absolute source file, from
 * packaging/game-variants/<game>/. A variant with no folder (2.31, the source tree's own game) has none.
 */
export async function gameOverlay(projectRoot, game) {
  const base = resolve(projectRoot, 'packaging', 'game-variants', game);
  const files = new Map();
  const visit = async (directory, prefix) => {
    let entries;
    try { entries = await readdir(directory, {withFileTypes: true}); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const target = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), target);
      else if (entry.isFile()) files.set(target, join(directory, entry.name));
    }
  };
  await visit(base, '');
  return files;
}
