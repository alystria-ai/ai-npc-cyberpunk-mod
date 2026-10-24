import {readFileSync} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// The game versions the release is built for (packaging/game-variants.json, docs/GAME_VERSIONS.md).
const here = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(here, '..', 'game-variants.json');

/** {<game id>: {label, exeVersion, suffix, hfFolder, requirements}}; the 2.31 variant has an empty suffix and folder. */
export const GAME_VARIANTS = Object.freeze(JSON.parse(readFileSync(FILE, 'utf8')).variants);

/** The default variant's id: the one with no suffix. */
export const DEFAULT_GAME = Object.keys(GAME_VARIANTS).find(id => GAME_VARIANTS[id].suffix === '');

/**
 * The files a variant lays over the source's own: Map of game-relative target path (forward slashes) to the absolute source file, from
 * packaging/game-variants/<game>/. A variant with no folder (2.31) has none.
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
