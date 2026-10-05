import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rename, rm, readFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, basename, resolve} from 'node:path';
import {RequestFileOwner, fileIdentity} from './request-ownership.mjs';

async function scratch(run) {
  const root = await mkdtemp(join(tmpdir(), 'cyberpunk-request-owner-'));
  try { await run(root); }
  finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('cyberpunk-request-owner-'));
    await rm(root, {recursive: true, force: true});
  }
}
// Lua publishes a request by writing a temporary file and renaming it.
async function publish(path, text) { await writeFile(path + '.tmp', text); await rename(path + '.tmp', path); }

test('an unchanged request file stays current without rereading its bytes', async () => scratch(async root => {
  const path = join(root, 'last-input.json'), raw = JSON.stringify({requestId: '1-1-1ULL', journal: 'x'.repeat(4096)});
  await publish(path, raw);
  let reads = 0, stats = 0;
  const files = {stat: path => { stats++; return stat(path); }, readFile: (...args) => { reads++; return readFile(...args); }};
  const owner = await RequestFileOwner.admit(path, raw, undefined, files);
  for (let i = 0; i < 5; i++) assert.equal(await owner.current(), true);
  assert.equal(reads, 0); assert.equal(stats, 6);
  // A replacement is detected by its identity and then compared byte for byte.
  await publish(path, raw.replace('"x', '"y'));
  assert.equal(await owner.current(), false); assert.equal(reads, 1);
}));

test('any replacement with different bytes retires the owner, even with the same size', async () => scratch(async root => {
  const path = join(root, 'last-input.json'), raw = JSON.stringify({requestId: '1-1-1ULL', text: 'aaaa'});
  await publish(path, raw);
  const owner = await RequestFileOwner.admit(path, raw);
  await publish(path, raw.replace('aaaa', 'bbbb'));
  assert.equal(await owner.current(), false);
}));

test('identical bytes republished under a new file stay current and adopt the new identity', async () => scratch(async root => {
  const path = join(root, 'last-input.json'), raw = JSON.stringify({requestId: '1-1-1ULL'});
  await publish(path, raw);
  const owner = await RequestFileOwner.admit(path, raw), first = owner.identity;
  await new Promise(done => setTimeout(done, 20));
  await publish(path, raw);
  assert.equal(await owner.current(), true);
  assert.notEqual(owner.identity, first);
  assert.equal(await readFile(path, 'utf8'), raw);
}));

test('a missing request file is never current', async () => scratch(async root => {
  const path = join(root, 'last-input.json'), raw = '{}';
  await publish(path, raw);
  const owner = await RequestFileOwner.admit(path, raw);
  await rm(path);
  assert.equal(await owner.current(), false);
}));

test('a stale admission identity falls back to the exact byte comparison', async () => scratch(async root => {
  const path = join(root, 'last-input.json'), raw = '{"requestId":"1-1-1ULL"}';
  await publish(path, raw);
  // The poll can stat one file and read its successor; ownership must still
  // compare bytes instead of trusting the earlier identity.
  const owner = new RequestFileOwner(path, raw, {ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1, birthtimeMs: 1});
  assert.equal(await owner.current(), true);
  assert.notEqual(owner.identity, fileIdentity({ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1, birthtimeMs: 1}));
  assert.equal(fileIdentity(null), null);
}));
