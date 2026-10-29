// A full disk never ends a Node process of the mod and never leaves a settings or memory file cut short (error report 1cbe337a5144ebbd:
// ENOSPC at a log line, bridge.stderr.log on a C: drive with 0.8 GiB free). ENOSPC is injected into fake streams and fake writes, and a real
// child process writes its log to a handle that refuses every write (the same asynchronous 'error' event a full disk makes).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {closeSync, openSync, writeFileSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {LOG_WRITE_ERRORS, guardStream, installSafeStreams, isDiskFullError, isLogWriteError} from './safe-streams.mjs';
import {atomicFile, safeWriteFile} from './guarded-file.mjs';
import {installFileErrorGuard, isTransientFileError} from './runtime-files.mjs';
import {repeatLimiter} from './repeat-log.mjs';

const failure = (code, syscall = 'write') => Object.assign(new Error(`${code}: injected, ${syscall}`), {code, syscall});
const streamsUrl = pathToFileURL(join(import.meta.dirname, 'safe-streams.mjs')).href;

// A file stream the way Node makes one for a redirected stderr: a write that fails destroys the stream, and the error arrives on the next tick.
class FullDiskStream extends EventEmitter {
  constructor(fd = 2) { super(); this.fd = fd; this.destroyed = false; this.full = true; this.written = []; }
  write(chunk, encoding, callback) {
    const done = typeof encoding === 'function' ? encoding : callback;
    if (this.destroyed) { process.nextTick(() => done?.(failure('ERR_STREAM_DESTROYED'))); return false; }
    if (this.full) {
      this.destroyed = true; this.fd = null;
      const error = failure('ENOSPC');
      process.nextTick(() => { done?.(error); this.emit('error', error); });
      return false;
    }
    this.written.push(String(chunk));
    return true;
  }
}

test('the codes of a log write that never matter are named, a full disk among them', () => {
  for (const code of ['ENOSPC', 'EPIPE', 'EIO', 'EBADF']) {
    assert(LOG_WRITE_ERRORS.includes(code), code);
    assert.equal(isLogWriteError(failure(code)), true, code);
  }
  assert.equal(isDiskFullError(failure('ENOSPC')), true);
  assert.equal(isDiskFullError(failure('EPIPE')), false);
  assert.equal(isLogWriteError(new TypeError('a real bug')), false);
});

test('a stream that has no error listener would end the process; a guarded one swallows ENOSPC, EPIPE, EIO and EBADF', () => {
  const bare = new EventEmitter();
  assert.throws(() => bare.emit('error', failure('ENOSPC')), /ENOSPC/, 'control: an error event with no listener is thrown, which ends a process');

  for (const code of ['ENOSPC', 'EPIPE', 'EIO', 'EBADF']) {
    const stream = new EventEmitter(), seen = [];
    stream.write = () => true;
    assert.equal(guardStream(stream, {onError: error => seen.push(error.code)}), true);
    assert.doesNotThrow(() => stream.emit('error', failure(code)), code);
    assert.deepEqual(seen, [code]);
  }
});

test('a log line on a full disk throws nothing, calls its callback and is dropped; the log comes back when space is freed', async () => {
  const stream = new FullDiskStream(), handle = [], errors = [];
  const writeFd = (fd, bytes) => { if (stream.full) throw failure('ENOSPC'); handle.push([fd, String(bytes)]); };
  assert.equal(guardStream(stream, {writeFd, onError: error => errors.push(error.code)}), true);
  assert.equal(guardStream(stream), false, 'guarded once');
  let called = 0;
  assert.doesNotThrow(() => stream.write('first\n', () => { called += 1; }));
  await new Promise(done => setTimeout(done, 20));   // the asynchronous 'error' event of the failed write is swallowed
  assert.equal(stream.destroyed, true);
  assert.doesNotThrow(() => stream.write('second\n', 'utf8', () => { called += 1; }));
  assert.doesNotThrow(() => stream.write(Buffer.from('third\n')));
  await new Promise(done => setTimeout(done, 20));
  assert.equal(called, 2, 'every callback is called, nothing waits for a dropped line');
  assert.deepEqual(handle, [], 'nothing was written while the disk was full');
  assert(errors.includes('ENOSPC'));

  stream.full = false;   // space was freed: the lines go through the handle that was kept from before the stream died
  stream.write('after\n');
  stream.write('more\n', 'utf8', () => { called += 1; });
  await new Promise(done => setTimeout(done, 20));
  assert.deepEqual(handle, [[2, 'after\n'], [2, 'more\n']]);
  assert.equal(called, 3);
});

test('a stream whose write throws, and a missing stream, are harmless', () => {
  const stream = new EventEmitter();
  stream.write = () => { throw failure('EBADF'); };
  guardStream(stream);
  assert.doesNotThrow(() => stream.write('x'));
  assert.equal(guardStream(null), false);
  assert.equal(installSafeStreams({processRef: {}}), 0);
  assert.equal(installSafeStreams({processRef: {get stdout() { throw failure('EBADF'); }, stderr: new EventEmitter()}}), 0, 'a stream without write is left alone');
});

test('a real process whose log handle refuses every write keeps running with the guard, and ends without it', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'cyberpunk-disk-full-'));
  t.after(() => fs.rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}));
  const log = join(root, 'bridge.stderr.log');
  writeFileSync(log, 'x');
  const script = `import(${JSON.stringify(streamsUrl)}).then(({installSafeStreams}) => {
    if (process.argv[1] === 'guard') installSafeStreams();
    console.error('first line'); console.error('second line');
    setTimeout(() => { console.error('later'); process.stdout.write('alive\\n'); }, 100);
    setTimeout(() => process.exit(0), 300);
  });`;
  const run = mode => {
    const handle = openSync(log, 'r');   // a handle opened for reading only: every write to it fails, the way a full disk's does
    try { return spawnSync(process.execPath, ['--input-type=module', '-e', script, mode], {stdio: ['ignore', 'pipe', handle], encoding: 'utf8', timeout: 20000}); }
    finally { closeSync(handle); }
  };
  const bare = run('plain');
  assert.notEqual(bare.status, 0, 'control: an unguarded process ends on its first log line');
  const guarded = run('guard');
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /alive/);
});

test('a rejected write nobody awaited (a full disk or a quota) is logged and the service goes on', async () => {
  assert.equal(isTransientFileError(failure('ENOSPC')), true);
  assert.equal(isTransientFileError(failure('EDQUOT')), true);
  assert.equal(isTransientFileError(new Error('ENOSPC')), false, 'not a file error without a syscall');
  const listeners = [], lines = [], recorded = [];
  const processRef = {on: (_, listener) => listeners.push(listener), removeListener() {}};
  installFileErrorGuard({processRef, log: line => lines.push(line), record: error => recorded.push(error.code)});
  assert.doesNotThrow(() => listeners[0](failure('ENOSPC')));
  assert.deepEqual(recorded, ['ENOSPC']);
  assert.match(lines[0], /ENOSPC, write\); the service goes on/);
  assert.throws(() => listeners[0](new TypeError('a real bug')), /a real bug/);
});

test('the repeat limiter never throws when its sink fails on a full disk', () => {
  const log = repeatLimiter({write: () => { throw failure('ENOSPC'); }});
  assert.doesNotThrow(() => log('[Poll]', failure('EBUSY')));
  assert.doesNotThrow(() => log('[Poll]', failure('EBUSY')));
});

async function fixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'cyberpunk-disk-full-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}));
  const path = join(directory, 'settings.json');
  await fs.writeFile(path, '{"saved":true}');
  return {directory, path};
}
const intact = async ({directory, path}) => {
  assert.equal(await fs.readFile(path, 'utf8'), '{"saved":true}', 'the old file is as it was');
  assert.deepEqual(await fs.readdir(directory), ['settings.json'], 'no temporary file is left behind');
};

test('a full disk while the new file is written leaves the old settings or memory file untouched (atomicFile)', async t => {
  const where = await fixture(t);
  const files = {open: async (target, mode) => {
    const handle = await fs.open(target, mode);
    return {writeFile: async () => { throw failure('ENOSPC'); }, close: () => handle.close()};
  }};
  await assert.rejects(atomicFile(where.path, '{"saved":false,"padding":"............"}', {files}), /ENOSPC/);
  await intact(where);
});

test('a full disk at the commit step leaves the old file untouched and removes the temporary file (atomicFile)', async t => {
  const where = await fixture(t);
  await assert.rejects(atomicFile(where.path, 'new', {files: {rename: () => { throw failure('ENOSPC', 'rename'); }}}), /ENOSPC/);
  await intact(where);
});

test('an in-place write that fails on a full disk puts the old bytes back and still reports the failure (atomicFile)', async t => {
  const where = await fixture(t);
  let target = 0;
  const files = {open: async (path, mode) => {
    const handle = await fs.open(path, mode);
    if (path !== where.path) return handle;
    target += 1;
    // The first open of the target empties it (mode 'w') and its write fails; the second one, which puts the old bytes back, works.
    if (target === 1) return {writeFile: async () => { throw failure('ENOSPC'); }, close: () => handle.close()};
    return handle;
  }};
  const session = {refused: 0, inPlace: true};
  await assert.rejects(atomicFile(where.path, 'a much longer new text that does not fit', {files, session}), /ENOSPC/);
  assert.equal(target, 2, 'the old bytes were written back through a second handle');
  await intact(where);
});

test('safeWriteFile: a full disk keeps the old file and leaves no temporary file; a good write replaces it', async t => {
  const where = await fixture(t);
  await assert.rejects(safeWriteFile(where.path, 'new', {files: {writeFile: async temp => { await fs.writeFile(temp, 'ne'); throw failure('ENOSPC'); }}}), /ENOSPC/);
  await intact(where);
  await assert.rejects(safeWriteFile(where.path, 'new', {files: {rename: async () => { throw failure('ENOSPC', 'rename'); }}}), /ENOSPC/);
  await intact(where);
  await safeWriteFile(where.path, 'new');
  assert.equal(await fs.readFile(where.path, 'utf8'), 'new');
  assert.deepEqual(await fs.readdir(where.directory), ['settings.json']);
});

test('every long-lived Node entry of the mod guards its output before anything else can write to it, and the guard ships', async () => {
  const read = async file => (await fs.readFile(join(import.meta.dirname, '..', file), 'utf8')).replace(/\r\n/g, '\n');
  const firstImport = source => /^import [^\n]*$/m.exec(source.replace(/^\/\/[^\n]*\n/gm, ''))[0];
  assert.equal(firstImport(await read('bridge/convai-bridge.mjs')), "import './safe-streams-install.mjs';", 'the conversation service');
  assert.equal(firstImport(await read('scripts/Supervise-ConversationBridge.mjs')), "import '../bridge/safe-streams-install.mjs';", 'the supervisor started by hand');
  assert.match(await read('packaging/runtime/start-service.mjs'), /await import\('\.\.\/bridge\/safe-streams-install\.mjs'\)/, 'the supervisor the launcher starts');
  assert.match(await read('bridge/omni-server-main.mjs'), /installSafeStreams\(\);[^\n]*\n\s*main\(\)/, 'the OmniVoice server');
  const {BRIDGE_MODULES} = await import('../packaging/runtime-layout.mjs');
  for (const file of ['bridge/safe-streams.mjs', 'bridge/safe-streams-install.mjs']) assert(BRIDGE_MODULES.includes(file), `${file} is in runtime-layout.mjs`);
});
