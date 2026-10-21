// Mod Organizer 2 support: a file that exists twice (node --test packaging/usvfs-shadow.test.mjs).
//
// Seen in a player's support report and reproduced in a live MO2 test (usvfs 0.5.6.1, Windows 11 25H2): when a path is a real file in the game
// folder and MO2 also holds a copy of it in front of that one (a mod with the same path, or the Overwrite folder), open, read, write and
// rename reach the copy in front, while Node's plain stat (the 24H2 call that usvfs does not hook) answers for the real file: it never changes.
// The bridge skips reading runtime/last-input.json while its stat equals the last one, so no turn was ever read. Under usvfs stat now asks
// an opened handle, which answers for the file the process can open. These tests build a file system that behaves that way.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {installUsvfsCompat, shadowedFiles} from './runtime/usvfs-compat.mjs';

// gameFolder holds the real files; front holds the copies MO2 puts in front. stat-family calls answer for the game folder's file, open for the
// copy in front (the game folder's file when there is none).
function shadowLike(gameFolder, front) {
  const real = path => join(gameFolder, basename(String(path)));
  const seen = path => { const copy = join(front, basename(String(path))); return fs.existsSync(copy) ? copy : real(path); };
  return {
    statSync: (path, options) => fs.statSync(real(path), options),
    lstatSync: (path, options) => fs.lstatSync(real(path), options),
    stat: (path, options, callback) => { if (typeof options === 'function') { callback = options; options = undefined; } fs.stat(real(path), options, callback); },
    lstat: (path, options, callback) => { if (typeof options === 'function') { callback = options; options = undefined; } fs.lstat(real(path), options, callback); },
    existsSync: path => fs.existsSync(real(path)),
    exists: (path, callback) => fs.exists(real(path), callback),
    mkdirSync: fs.mkdirSync, mkdir: fs.mkdir,
    realpathSync: Object.assign(path => real(path), {native: path => real(path)}), realpath: Object.assign((...args) => fs.realpath(...args), {native: (...args) => fs.realpath.native(...args)}),
    openSync: (path, flags) => fs.openSync(seen(path), flags), fstatSync: fs.fstatSync, closeSync: fs.closeSync,
    accessSync: (path, mode) => fs.accessSync(seen(path), mode),
    open: (path, flags, callback) => fs.open(seen(path), flags, callback), fstat: fs.fstat, close: fs.close,
    readdirSync: () => fs.readdirSync(gameFolder),
    promises: {
      stat: async (path, options) => fs.promises.stat(real(path), options), lstat: async (path, options) => fs.promises.lstat(real(path), options),
      mkdir: fs.promises.mkdir, realpath: async path => real(path), open: (path, flags) => fs.promises.open(seen(path), flags),
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ai npc usvfs shadow '));
  const game = join(root, 'game'), front = join(root, 'overwrite');
  fs.mkdirSync(game); fs.mkdirSync(front);
  // The placeholder the install shipped (empty, old) and the file Overwrite holds in front of it (what the game and the service write).
  fs.writeFileSync(join(game, 'last-input.json'), '');
  fs.utimesSync(join(game, 'last-input.json'), new Date('2026-10-20T09:51:01Z'), new Date('2026-10-20T09:51:01Z'));
  fs.writeFileSync(join(front, 'last-input.json'), '{"requestId":"r-1","text":"hello"}');
  // A file with no copy in front, and a folder.
  fs.writeFileSync(join(game, 'plain.json'), '{"a":1}');
  fs.mkdirSync(join(game, 'reports'));
  const fake = shadowLike(game, front);
  return {root, game, front, fake, cleanup: () => rm(root, {recursive: true, force: true})};
}

test('the fake file system answers a stale stat for a shadowed file before the fallbacks go in', async () => {
  const f = await fixture();
  try {
    const path = join(f.game, 'last-input.json');
    assert.equal(f.fake.statSync(path).size, 0, 'stat answers for the placeholder in the game folder');
    assert.equal(f.fake.statSync(path).mtime.toISOString(), '2026-10-20T09:51:01.000Z');
    const fd = f.fake.openSync(path, 'r');
    try { assert.equal(f.fake.fstatSync(fd).size, 34, 'the handle is the copy in front'); } finally { f.fake.closeSync(fd); }
  } finally { await f.cleanup(); }
});

test('stat, with the fallbacks in, answers for the copy the process can open: sync, callback and promise forms', async () => {
  const f = await fixture();
  try {
    installUsvfsCompat({target: f.fake});
    const path = join(f.game, 'last-input.json');
    const sync = f.fake.statSync(path);
    assert.equal(sync.size, 34);
    assert.notEqual(sync.mtime.toISOString(), '2026-10-20T09:51:01.000Z');
    assert.equal(f.fake.statSync(path, {bigint: true}).size, 34n);
    assert.equal((await f.fake.promises.stat(path)).size, 34);
    assert.equal((await new Promise((done, fail) => f.fake.stat(path, (error, stats) => error ? fail(error) : done(stats)))).size, 34);
    assert.equal((await new Promise((done, fail) => f.fake.stat(path, {}, (error, stats) => error ? fail(error) : done(stats)))).size, 34);
    // The poll's identity changes with a new write to the copy in front, though the real file never does.
    const before = f.fake.statSync(path);
    await new Promise(done => setTimeout(done, 20));
    fs.writeFileSync(join(f.front, 'last-input.json'), '{"requestId":"r-2","text":"hello again, longer"}');
    const after = f.fake.statSync(path);
    assert.notEqual(`${after.size}:${after.mtimeMs}`, `${before.size}:${before.mtimeMs}`);
  } finally { await f.cleanup(); }
});

test('a file with no copy in front, a folder and a missing file behave as before', async () => {
  const f = await fixture();
  try {
    installUsvfsCompat({target: f.fake});
    assert.equal(f.fake.statSync(join(f.game, 'plain.json')).size, 7);
    assert.equal(f.fake.statSync(join(f.game, 'reports')).isDirectory(), true);
    const missing = join(f.game, 'no-such-file.json');
    assert.throws(() => f.fake.statSync(missing), {code: 'ENOENT'});
    assert.equal(f.fake.statSync(missing, {throwIfNoEntry: false}), undefined);
    await assert.rejects(f.fake.promises.stat(missing), {code: 'ENOENT'});
    await new Promise(done => f.fake.stat(missing, error => { assert.equal(error?.code, 'ENOENT'); done(); }));
    assert.equal(f.fake.lstatSync(join(f.game, 'last-input.json')).size, 0, 'lstat keeps its plain call');
  } finally { await f.cleanup(); }
});

test('shadowedFiles names the files whose plain stat and handle stat disagree, and only those', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(shadowedFiles(f.game, f.fake), ['last-input.json']);
    installUsvfsCompat({target: f.fake});
    assert.deepEqual(shadowedFiles(f.game, f.fake), ['last-input.json'], 'it uses the plain stat even after the fallbacks are in');
    assert.deepEqual(shadowedFiles(join(f.root, 'no such folder'), {...f.fake, readdirSync: fs.readdirSync}), []);
    fs.rmSync(join(f.front, 'last-input.json'));
    assert.deepEqual(shadowedFiles(f.game, f.fake), [], 'nothing in front, nothing shadowed');
  } finally { await f.cleanup(); }
});

test('a real file system: the plain and the handle stat agree, so nothing is reported and stat is unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai npc usvfs shadow real '));
  try {
    fs.writeFileSync(join(root, 'a.json'), '{"a":1}');
    assert.deepEqual(shadowedFiles(root), []);
    const copy = {...fs, promises: {...fs.promises}};
    installUsvfsCompat({target: copy});
    assert.equal(copy.statSync(join(root, 'a.json')).size, 7);
    assert.equal((await copy.promises.stat(join(root, 'a.json'))).size, 7);
    assert.throws(() => copy.statSync(join(root, 'nothing')), {code: 'ENOENT'});
  } finally { await rm(root, {recursive: true, force: true}); }
});
