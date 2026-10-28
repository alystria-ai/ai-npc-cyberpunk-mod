import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {forGame} from './lib/game-variants.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = async path => JSON.parse(await readFile(resolve(project, path), 'utf8'));
const GUARD = 'archive/pc/mod/cyberpunk_convai_ambient_driver_guard.archive';

// The driver guard is built from the 2.31 copy of thepassenger.questphase; game 2.5 has its own, different copy (the archive SHA-1 differs between
// the two installs), so a 2.5 Runtime that shipped the guard would lay the 2.31 quest phase over the 2.5 one.
test('the ambient driver guard archive ships in the 2.31 Runtime only, the other archives in both', async () => {
  const archives = (await json('packaging/release.config.json')).releaseData.archives;
  const targets = game => forGame(archives, game).map(item => item.target);
  assert.ok(targets('2.31').includes(GUARD));
  assert.ok(!targets('2.5').includes(GUARD));
  for (const name of ['convai_facial', 'convai_gestures']) {
    for (const game of ['2.31', '2.5']) assert.ok(targets(game).includes(`archive/pc/mod/${name}.archive`), `${name} on ${game}`);
  }
});

test('the development install and the release plan say the same about the guard', async () => {
  const dev = (await json('scripts/development-files.json')).files.find(file => file.target === GUARD);
  assert.deepEqual(dev.games, ['2.31']);
  const plan = (await json('packaging/release-plan.json')).archives.flatMap(archive => archive.files).find(file => file.target === GUARD);
  assert.deepEqual(plan.games, ['2.31']);
});

test('an entry without "games" ships everywhere, and an unknown game name is refused', () => {
  const entries = [{target: 'a'}, {target: 'b', games: ['2.31']}];
  assert.deepEqual(forGame(entries, '2.5').map(entry => entry.target), ['a']);
  assert.deepEqual(forGame(entries, '2.31').map(entry => entry.target), ['a', 'b']);
  assert.throws(() => forGame([{target: 'c', games: ['2.3']}], '2.5'), /unknown game 2\.3/);
});
