// The list of pinned Pocket TTS files inside bridge/pocket_voice_runtime.py (what the worker checks the installed source against):
// it parses, it is the pinned revision (the digest packaging/release.config.json pins and the worker's SOURCE_SHA256), and the release
// builder's comparison catches a list that is not the files it ships.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkPocketSourceList, parsePocketSourceList, pocketSourceListDigest} from './lib/pocket-source-list.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const python = await readFile(resolve(project, 'bridge/pocket_voice_runtime.py'), 'utf8');
const config = JSON.parse(await readFile(resolve(project, 'packaging/release.config.json'), 'utf8'));
const list = parsePocketSourceList(python);

test('the worker list is the pinned revision', () => {
  assert.equal(list.size, 140);
  assert.equal(pocketSourceListDigest(list), config.toolchain.pocketTts.treeSha256);
  assert.equal(new RegExp(`SOURCE_SHA256 = "${config.toolchain.pocketTts.treeSha256}"`).test(python), true);
  assert.ok(list.has('pocket_tts/__init__.py') && list.has('LICENSE'));
});

test('the builder accepts exactly the shipped files and names a difference', () => {
  const shipped = [...list].map(([rel, sha]) => ({rel, sha}));
  checkPocketSourceList(list, shipped);
  assert.throws(() => checkPocketSourceList(list, shipped.slice(1)), /is listed but not shipped/);
  assert.throws(() => checkPocketSourceList(list, [...shipped, {rel: 'pocket_tts/extra.py', sha: 'a'.repeat(64)}]), /pocket_tts\/extra\.py is shipped but not listed/);
  assert.throws(() => checkPocketSourceList(list, [{...shipped[0], sha: 'b'.repeat(64)}, ...shipped.slice(1)]), /differs from the list/);
  assert.throws(() => parsePocketSourceList('SOURCE_FILES = {}'), /no Pocket source manifest/);
});
