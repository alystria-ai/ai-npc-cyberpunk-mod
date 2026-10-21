import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {CODE_LIST, MAX_NAMES, checkRuntimeFiles, codeListText, hashBytes, integrityLine, isCodePath, resetRuntimeIntegrityCache} from './runtime-integrity.mjs';

async function runtime(files, {list = true} = {}) {
  const app = await mkdtemp(join(tmpdir(), 'runtime-integrity-'));
  const put = async (path, text) => { await mkdir(dirname(join(app, path)), {recursive: true}); await writeFile(join(app, path), text); };
  for (const [path, text] of Object.entries(files)) await put(path, text);
  if (list) await put(CODE_LIST, codeListText({version: '0.2.8', rows: Object.entries(files).filter(([path]) => isCodePath(path)).map(([path, text]) => ({path, hash: hashBytes(Buffer.from(text))}))}));
  return {app, put, cleanup: () => rm(app, {recursive: true, force: true})};
}

test('which files the list covers: code in bridge, launcher and assets, never vendor folders or data', () => {
  for (const path of ['bridge/a.mjs', 'bridge/sub/b.py', 'launcher/start-service.mjs', 'assets/realtime-client.js', 'bridge/c.cjs']) assert.equal(isCodePath(path), true, path);
  for (const path of ['characters/roster.json', 'bridge/data.json', 'node_modules/x/a.mjs', 'bridge/node_modules/x/a.js', 'bridge/__pycache__/a.py', 'python/Lib/x.py', 'a.mjs', 'defaults/x.json']) assert.equal(isCodePath(path), false, path);
});

test('a Runtime whose files are the shipped ones matches', async () => {
  resetRuntimeIntegrityCache();
  const fix = await runtime({'bridge/a.mjs': 'export const a = 1;\n', 'launcher/start-service.mjs': 'start();\n', 'bridge/data.json': '{}', 'characters/r.json': '{}'});
  try {
    const result = await checkRuntimeFiles({project: fix.app});
    assert.deepEqual(result, {state: 'ok', checked: 2, changed: 0, extra: 0, missing: 0, listVersion: '0.2.8', names: []});
    assert.match(integrityLine(result), /all 2 code files match/);
  } finally { await fix.cleanup(); }
});

test('changed, extra and missing files are counted and up to five are named; no contents', async () => {
  resetRuntimeIntegrityCache();
  const files = {'bridge/a.mjs': 'one', 'bridge/b.mjs': 'two', 'bridge/c.mjs': 'three', 'launcher/start-service.mjs': 'start'};
  const fix = await runtime(files);
  try {
    await fix.put('bridge/a.mjs', 'one, edited by someone else with a secret');
    await fix.put('launcher/start-service.mjs', 'start; callHome();');
    await fix.put('bridge/fesir.mjs', 'extra file');
    for (let index = 0; index < 4; index++) await fix.put(`assets/extra${index}.js`, 'x');
    await rm(join(fix.app, 'bridge/c.mjs'));
    const result = await checkRuntimeFiles({project: fix.app});
    assert.equal(result.state, 'modified');
    assert.equal(result.checked, 8, 'the files that are on disk');
    assert.equal(result.changed, 2); assert.equal(result.extra, 5); assert.equal(result.missing, 1);
    assert.equal(result.names.length, MAX_NAMES);
    assert.deepEqual(result.names.slice(0, 2), ['changed bridge/a.mjs', 'changed launcher/start-service.mjs']);
    assert.ok(result.names.slice(2).every(name => name.startsWith('extra ')), 'changed first, then extra');
    assert.doesNotMatch(JSON.stringify(result), /secret|callHome/);
    assert.match(integrityLine(result), /2 changed, 5 extra, 1 missing of 8 \(changed bridge\/a\.mjs/);
  } finally { await fix.cleanup(); }
});

test('a Runtime without the list (before 0.2.8), a damaged list and no folder say so and claim nothing', async () => {
  resetRuntimeIntegrityCache();
  const plain = await runtime({'bridge/a.mjs': 'x'}, {list: false});
  try {
    assert.deepEqual(await checkRuntimeFiles({project: plain.app}), {state: 'no-list'});
    await plain.put(CODE_LIST, '{"version": 1, "files": ');
    assert.deepEqual(await checkRuntimeFiles({project: plain.app}), {state: 'damaged-list'});
    await plain.put(CODE_LIST, '{"version": 2, "files": {}}');
    assert.deepEqual(await checkRuntimeFiles({project: plain.app}), {state: 'damaged-list'});
    assert.deepEqual(await checkRuntimeFiles({project: undefined}), {state: 'unavailable'});
  } finally { await plain.cleanup(); }
});

test('a file is read once: a later check trusts size and modification time, and reads again when either changed', async () => {
  resetRuntimeIntegrityCache();
  const fix = await runtime({'bridge/a.mjs': 'AAAA', 'bridge/b.mjs': 'BBBB'});
  try {
    const fixed = new Date('2026-10-01T10:00:00Z');   // whole seconds: the same value back from the file system
    for (const name of ['a', 'b']) await utimes(join(fix.app, `bridge/${name}.mjs`), fixed, fixed);
    assert.equal((await checkRuntimeFiles({project: fix.app})).state, 'ok');
    // Same size, same modification time, other bytes: the cache stands (nothing was read), which is how the second report costs nothing.
    await writeFile(join(fix.app, 'bridge/a.mjs'), 'ZZZZ');
    await utimes(join(fix.app, 'bridge/a.mjs'), fixed, fixed);
    assert.equal((await checkRuntimeFiles({project: fix.app})).state, 'ok', 'cached by modification time');
    // A new modification time is read again.
    const later = new Date(fixed.getTime() + 5000);
    await utimes(join(fix.app, 'bridge/a.mjs'), later, later);
    const result = await checkRuntimeFiles({project: fix.app});
    assert.equal(result.state, 'modified'); assert.deepEqual(result.names, ['changed bridge/a.mjs']);
  } finally { await fix.cleanup(); }
});
