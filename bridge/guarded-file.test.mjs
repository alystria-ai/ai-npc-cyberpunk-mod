import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {readFileSync, renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {atomicFile} from './guarded-file.mjs';

const deferred = () => {
  let release;
  const promise = new Promise(done => { release = done; });
  return {promise, release};
};
const failure = code => Object.assign(new Error(code), {code});

async function fixture(t) {
  const parent = resolve(tmpdir());
  const directory = await fs.mkdtemp(join(parent, 'cyberpunk-guarded-file-'));
  assert.equal(dirname(directory), parent);
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const output = join(directory, 'reply.json');
  await fs.writeFile(output, 'original');
  return {directory, output};
}

async function onlyOutput(directory, output, expected) {
  assert.equal(await fs.readFile(output, 'utf8'), expected);
  assert.deepEqual(await fs.readdir(directory), ['reply.json']);
}

test('real fs defaults replace an existing output and leave no temporary file', async t => {
  const {directory, output} = await fixture(t);
  assert.equal(await atomicFile(output, 'fresh'), true);
  await onlyOutput(directory, output, 'fresh');
});

test('the default commit finishes before a reset queued by the synchronous guard can run', async t => {
  const {directory, output} = await fixture(t);
  let observedAtReset;
  assert.equal(await atomicFile(output, 'fresh', {isCurrentSync: () => {
    queueMicrotask(() => { observedAtReset = readFileSync(output, 'utf8'); });
    return true;
  }}), true);
  assert.equal(observedAtReset, 'fresh');
  await onlyOutput(directory, output, 'fresh');
});

test('a synchronous fence rejects an async guard snapshot invalidated before commit', async t => {
  const {directory, output} = await fixture(t);
  let closed = false, fenced = false, syncChecks = 0;
  assert.equal(await atomicFile(output, 'stale', {
    isCurrent: () => {
      if (closed) queueMicrotask(() => { fenced = true; });
      return true;
    },
    isCurrentSync: () => { syncChecks++; return !fenced; },
    files: {open: async (...args) => {
      const handle = await fs.open(...args);
      return {writeFile: data => handle.writeFile(data), close: async () => {
        await handle.close();
        closed = true;
      }};
    }},
  }), false);
  assert.equal(fenced, true);
  assert.equal(syncChecks, 1);
  await onlyOutput(directory, output, 'original');
});

test('abort between current resolution and commit is checked again at the caller', async t => {
  const {directory, output} = await fixture(t);
  const controller = new AbortController();
  let closed = false;
  assert.equal(await atomicFile(output, 'stale', {
    signal: controller.signal,
    isCurrent: () => {
      // The first microtask runs before current resumes. The second runs after
      // current resolves true and before atomicFile resumes to dispatch rename.
      if (closed) queueMicrotask(() => queueMicrotask(() => controller.abort()));
      return true;
    },
    files: {open: async (...args) => {
      const handle = await fs.open(...args);
      return {writeFile: data => handle.writeFile(data), close: async () => {
        await handle.close();
        closed = true;
      }};
    }},
  }), false);
  assert.equal(controller.signal.aborted, true);
  await onlyOutput(directory, output, 'original');
});

test('an async value cannot authorize the synchronous commit guard', async t => {
  const {directory, output} = await fixture(t);
  assert.equal(await atomicFile(output, 'stale', {isCurrentSync: async () => true}), false);
  await onlyOutput(directory, output, 'original');
});

test('each write opens a unique temporary file exclusively', async t => {
  const {directory, output} = await fixture(t);
  const temporaryPaths = [];
  const files = {open: async (path, flags) => {
    temporaryPaths.push(path);
    assert.equal(flags, 'wx');
    assert.ok(path.startsWith(output + '.'));
    assert.match(path, /\.[a-f0-9-]{36}\.tmp$/);
    return fs.open(path, flags);
  }};
  assert.equal(await atomicFile(output, 'first', {files}), true);
  assert.equal(await atomicFile(output, 'second', {files}), true);
  assert.equal(new Set(temporaryPaths).size, 2);
  await onlyOutput(directory, output, 'second');
});

test('an already aborted or stale write never opens a file', async () => {
  const controller = new AbortController();
  controller.abort();
  const files = {open: async () => assert.fail('cancelled write opened a file')};
  assert.equal(await atomicFile('unused', 'stale', {files, signal: controller.signal}), false);
  assert.equal(await atomicFile('unused', 'stale', {files, isCurrent: async () => false}), false);
});

test('a reset during a delayed write cannot overwrite the newer reply', {timeout: 5000}, async t => {
  const {directory, output} = await fixture(t);
  const entered = deferred(), resume = deferred();
  let generation = 1;
  const stale = atomicFile(output, 'stale', {
    isCurrent: () => generation === 1,
    files: {open: async (...args) => {
      const handle = await fs.open(...args);
      return {writeFile: async data => {
        entered.release();
        await resume.promise;
        await handle.writeFile(data);
      }, close: () => handle.close()};
    }},
  });
  try {
    await entered.promise;
    generation = 2;
    assert.equal(await atomicFile(output, 'newer'), true);
  } finally { resume.release(); }
  assert.equal(await stale, false);
  await onlyOutput(directory, output, 'newer');
});

test('a reset during a delayed close cannot overwrite the newer reply', {timeout: 5000}, async t => {
  const {directory, output} = await fixture(t);
  const entered = deferred(), resume = deferred();
  let generation = 1;
  const stale = atomicFile(output, 'stale', {
    isCurrent: () => generation === 1,
    files: {open: async (...args) => {
      const handle = await fs.open(...args);
      return {writeFile: data => handle.writeFile(data), close: async () => {
        entered.release();
        await resume.promise;
        await handle.close();
      }};
    }},
  });
  try {
    await entered.promise;
    generation = 2;
    assert.equal(await atomicFile(output, 'newer'), true);
  } finally { resume.release(); }
  assert.equal(await stale, false);
  await onlyOutput(directory, output, 'newer');
});

test('abort while awaiting the publish guard cannot authorize a rename', {timeout: 5000}, async t => {
  const {directory, output} = await fixture(t);
  const entered = deferred(), resume = deferred();
  const controller = new AbortController();
  let closed = false, renames = 0;
  const stale = atomicFile(output, 'stale', {
    signal: controller.signal,
    isCurrent: async () => {
      if (closed) {
        entered.release();
        await resume.promise;
      }
      return true;
    },
    files: {
      open: async (...args) => {
        const handle = await fs.open(...args);
        return {writeFile: data => handle.writeFile(data), close: async () => {
          await handle.close();
          closed = true;
        }};
      },
      rename: async (...args) => { renames++; await fs.rename(...args); },
    },
  });
  try {
    await entered.promise;
    controller.abort();
    assert.equal(await atomicFile(output, 'newer'), true);
  } finally { resume.release(); }
  assert.equal(await stale, false);
  assert.equal(renames, 0);
  await onlyOutput(directory, output, 'newer');
});

test('cancellation during a rename retry cannot replace the newer output', {timeout: 5000}, async t => {
  const {directory, output} = await fixture(t);
  const entered = deferred(), resume = deferred();
  const controller = new AbortController();
  let renames = 0;
  const stale = atomicFile(output, 'stale', {
    signal: controller.signal,
    files: {rename: async (...args) => {
      if (++renames === 1) throw failure('EPERM');
      await fs.rename(...args);
    }},
    retryDelay: async () => { entered.release(); await resume.promise; },
  });
  try {
    await entered.promise;
    controller.abort();
    assert.equal(await atomicFile(output, 'newer'), true);
  } finally { resume.release(); }
  assert.equal(await stale, false);
  assert.equal(renames, 1);
  await onlyOutput(directory, output, 'newer');
});

test('cancellation after a failed rename skips the retry delay', async t => {
  const {directory, output} = await fixture(t);
  const controller = new AbortController();
  let renames = 0;
  assert.equal(await atomicFile(output, 'stale', {
    signal: controller.signal,
    files: {rename: async () => {
      renames++;
      controller.abort();
      throw failure('EBUSY');
    }},
    retryDelay: () => assert.fail('cancelled write delayed a retry'),
  }), false);
  assert.equal(renames, 1);
  await onlyOutput(directory, output, 'original');
});

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`${code} permits five total rename attempts before a successful replacement`, async t => {
    const {directory, output} = await fixture(t);
    let attempts = 0, delays = 0;
    assert.equal(await atomicFile(output, 'fresh', {
      files: {rename: (...args) => {
        if (++attempts < 5) throw failure(code);
        renameSync(...args);
      }},
      retryDelay: async () => { delays++; },
    }), true);
    assert.equal(attempts, 5);
    assert.equal(delays, 4);
    await onlyOutput(directory, output, 'fresh');
  });
}

test('five failed rename attempts preserve the output and clean the owned temporary file', async t => {
  const {directory, output} = await fixture(t);
  let attempts = 0, delays = 0;
  await assert.rejects(atomicFile(output, 'stale', {
    files: {rename: async () => { attempts++; throw failure('EPERM'); }},
    retryDelay: async () => { delays++; },
  }), {code: 'EPERM'});
  assert.equal(attempts, 5);
  assert.equal(delays, 4);
  await onlyOutput(directory, output, 'original');
});

test('an unrecognized rename error is not retried and cleans the owned temporary file', async t => {
  const {directory, output} = await fixture(t);
  let attempts = 0;
  await assert.rejects(atomicFile(output, 'stale', {
    files: {rename: async () => { attempts++; throw failure('EIO'); }},
    retryDelay: () => assert.fail('unexpected error was retried'),
  }), {code: 'EIO'});
  assert.equal(attempts, 1);
  await onlyOutput(directory, output, 'original');
});

test('a write failure closes and cleans the owned temporary file', async t => {
  const {directory, output} = await fixture(t);
  let closes = 0;
  await assert.rejects(atomicFile(output, 'stale', {
    files: {open: async (...args) => {
      const handle = await fs.open(...args);
      return {writeFile: async () => { throw failure('ENOSPC'); }, close: async () => {
        closes++;
        await handle.close();
      }};
    }},
  }), {code: 'ENOSPC'});
  assert.equal(closes, 1);
  await onlyOutput(directory, output, 'original');
});

test('an exclusive-open collision cannot remove a foreign temporary file', async t => {
  const {directory, output} = await fixture(t);
  let foreign;
  await assert.rejects(atomicFile(output, 'stale', {
    files: {
      open: async (path, flags) => {
        foreign = path;
        assert.equal(flags, 'wx');
        await fs.writeFile(path, 'foreign', {flag: 'wx'});
        return fs.open(path, flags);
      },
      rm: async () => assert.fail('write removed a temporary file it did not own'),
    },
  }), {code: 'EEXIST'});
  assert.equal(await fs.readFile(output, 'utf8'), 'original');
  assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign');
  assert.equal((await fs.readdir(directory)).length, 2);
});
