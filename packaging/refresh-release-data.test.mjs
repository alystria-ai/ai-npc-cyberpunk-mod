// packaging/Refresh-ReleaseData.mjs copies the small release inputs from the ignored developer runtime/ folder into
// packaging/release-data/ (the Convai character ids and the three generated game archives), and must never copy a credential or a
// retired twin. The script finds the project from its own location, so each test copies it into a throw-away project folder.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('./Refresh-ReleaseData.mjs', import.meta.url));
const SOURCES = {
  'runtime/characters.json': '{"version":1,"characters":{"judy-alvarez":{"id":"char-1"}}}\n',
  'runtime/multilingual-profiles.json': JSON.stringify({version: 1, characters: {'judy-alvarez': {id: 'ml-1'}}}),
  'runtime/facial-rig/package/convai_facial.archive': 'facial-archive-bytes',
  'runtime/gestures/package/convai_gestures.archive': 'gesture-archive-bytes',
  'runtime/ambient-driver-guard/package/cyberpunk_convai_ambient_driver_guard.archive': 'guard-archive-bytes',
};
const TARGETS = {
  'runtime/characters.json': 'packaging/release-data/characters.json',
  'runtime/multilingual-profiles.json': 'packaging/release-data/multilingual-profiles.json',
  'runtime/facial-rig/package/convai_facial.archive': 'packaging/release-data/archives/convai_facial.archive',
  'runtime/gestures/package/convai_gestures.archive': 'packaging/release-data/archives/convai_gestures.archive',
  'runtime/ambient-driver-guard/package/cyberpunk_convai_ambient_driver_guard.archive': 'packaging/release-data/archives/cyberpunk_convai_ambient_driver_guard.archive',
};

async function project(sources = SOURCES) {
  const root = await mkdtemp(join(tmpdir(), 'refresh-release-data-'));
  await mkdir(join(root, 'packaging'), {recursive: true});
  await copyFile(script, join(root, 'packaging/Refresh-ReleaseData.mjs'));
  for (const [rel, body] of Object.entries(sources)) {
    await mkdir(dirname(join(root, rel)), {recursive: true});
    await writeFile(join(root, rel), body);
  }
  return root;
}
const refresh = (root, ...args) => spawnSync(process.execPath, [join(root, 'packaging/Refresh-ReleaseData.mjs'), ...args], {encoding: 'utf8', timeout: 120_000});
const read = (root, rel) => readFile(join(root, rel), 'utf8');
const exists = async path => { try { await stat(path); return true; } catch { return false; } };

test('a refresh copies every input to its release-data place, then says it is up to date', async () => {
  const root = await project();
  try {
    const first = refresh(root);
    assert.equal(first.status, 0, first.stderr);
    for (const target of Object.values(TARGETS)) assert.match(first.stdout, new RegExp(`updated: ${target.replace(/[./]/g, '\\$&')}`));
    for (const [source, target] of Object.entries(TARGETS)) {
      // The profiles file is always re-written through the twin filter (pretty-printed); everything else is copied byte for byte.
      if (source.endsWith('multilingual-profiles.json')) assert.deepEqual(JSON.parse(await read(root, target)), JSON.parse(await read(root, source)), target);
      else assert.equal(await read(root, target), await read(root, source), target);
    }
    const second = refresh(root);
    assert.equal(second.status, 0);
    assert.equal(second.stdout.trim(), 'Release data is up to date.');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('--check reports a stale or missing copy with exit code 1 and writes nothing', async () => {
  const root = await project();
  try {
    const check = refresh(root, '--check');
    assert.equal(check.status, 1);
    assert.match(check.stdout, /differs: packaging\/release-data\/characters\.json/);
    assert.equal(await exists(join(root, 'packaging/release-data')), false, 'a check never creates the release-data folder');
    assert.equal(refresh(root).status, 0);
    assert.equal(refresh(root, '--check').status, 0, 'in step after a refresh');
    await writeFile(join(root, TARGETS['runtime/gestures/package/convai_gestures.archive']), 'an older archive');
    const stale = refresh(root, '--check');
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /differs: packaging\/release-data\/archives\/convai_gestures\.archive/);
    assert.doesNotMatch(stale.stdout, /characters\.json/, 'only the stale file is named');
    assert.equal(await read(root, TARGETS['runtime/gestures/package/convai_gestures.archive']), 'an older archive', 'the check left it alone');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('a missing developer input is named, counts as a difference for --check and leaves the committed copy untouched', async () => {
  const {['runtime/characters.json']: omitted, ...rest} = SOURCES;
  const root = await project(rest);
  try {
    await mkdir(join(root, 'packaging/release-data'), {recursive: true});
    await writeFile(join(root, 'packaging/release-data/characters.json'), 'committed copy');
    const check = refresh(root, '--check');
    assert.equal(check.status, 1);
    assert.match(check.stdout, /missing source: runtime\/characters\.json/);
    const copy = refresh(root);
    assert.match(copy.stdout, /missing source: runtime\/characters\.json/);
    assert.equal(await read(root, 'packaging/release-data/characters.json'), 'committed copy', 'a missing source never empties the committed file');
    // The inputs that do exist were still copied.
    assert.deepEqual(JSON.parse(await read(root, TARGETS['runtime/multilingual-profiles.json'])), JSON.parse(await read(root, 'runtime/multilingual-profiles.json')));
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('the retired romantic twins are dropped from the copied multilingual profiles and never packaged', async () => {
  const root = await project({...SOURCES, 'runtime/multilingual-profiles.json': JSON.stringify({version: 2, characters: {
    'judy-alvarez': {id: 'a'}, 'judy-alvarez-romantic': {id: 'b'}, 'panam-palmer-romantic': {id: 'c'}, 'romantic-notes': {id: 'd'}}})});
  try {
    assert.equal(refresh(root).status, 0);
    const copied = JSON.parse(await read(root, TARGETS['runtime/multilingual-profiles.json']));
    assert.deepEqual(Object.keys(copied.characters).sort(), ['judy-alvarez', 'romantic-notes'], 'only keys that END in -romantic are retired');
    assert.equal(copied.version, 2, 'the rest of the document is kept');
    // The cleaned copy is what a later check compares with, so a developer file that still has the twins is not "different" forever.
    assert.equal(refresh(root, '--check').status, 0);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('a profiles file with a byte order mark is read, and a file with no characters table copies as an empty one', async () => {
  const root = await project({...SOURCES, 'runtime/multilingual-profiles.json': '﻿' + JSON.stringify({version: 1, characters: {'jackie-welles': {id: 'x'}}})});
  try {
    assert.equal(refresh(root).status, 0);
    assert.deepEqual(JSON.parse(await read(root, TARGETS['runtime/multilingual-profiles.json'])).characters, {'jackie-welles': {id: 'x'}});
  } finally { await rm(root, {recursive: true, force: true}); }
  const bare = await project({...SOURCES, 'runtime/multilingual-profiles.json': '{"version":1}'});
  try {
    assert.equal(refresh(bare).status, 0);
    assert.deepEqual(JSON.parse(await read(bare, TARGETS['runtime/multilingual-profiles.json'])), {version: 1, characters: {}});
  } finally { await rm(bare, {recursive: true, force: true}); }
});

test('a JSON input that looks like a credential is refused and nothing of it is copied', async () => {
  for (const [label, body] of [
    ['an api-key line', '{"version":1,"characters":{},"note":"api-key = abcdef1234567890"}'],
    ['an apiKey field', '{"version":1,"characters":{},"apiKey":"abcdef1234567890"}'],
    ['an api_key field', '{"version":1,"characters":{},"api_key":"abcdef1234567890"}'],
    ['a Hugging Face token', '{"version":1,"characters":{},"token":"hf_abcdefghijklmnopqrstuvwxyz0123"}'],
  ]) {
    const root = await project({...SOURCES, 'runtime/characters.json': body});
    try {
      const run = refresh(root);
      assert.notEqual(run.status, 0, label);
      assert.match(run.stderr, /looks like it holds a credential; refusing to copy it/, label);
      assert.equal(await exists(join(root, TARGETS['runtime/characters.json'])), false, `${label}: the file was not copied`);
      assert(!run.stdout.includes('abcdef1234567890') && !run.stderr.includes('abcdef1234567890'), `${label}: the value is not echoed`);
    } finally { await rm(root, {recursive: true, force: true}); }
  }
});

test('the credential check reads JSON only: a binary archive that happens to contain the text is copied', async () => {
  const root = await project({...SOURCES, 'runtime/gestures/package/convai_gestures.archive': 'binary ... api-key ... bytes'});
  try {
    const run = refresh(root);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(await read(root, TARGETS['runtime/gestures/package/convai_gestures.archive']), 'binary ... api-key ... bytes');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('the files it can copy are exactly the five release inputs: no key, state, audio or settings file is on its list', async () => {
  const text = await readFile(script, 'utf8');
  const listed = [...text.matchAll(/\['(runtime\/[^']+)',\s*'(packaging\/release-data\/[^']+)'\]/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(Object.fromEntries(listed), TARGETS);
  assert.doesNotMatch(listed.map(pair => pair[0]).join('\n'), /key|settings|memory|session|\.wav|\.txt/i);
});
