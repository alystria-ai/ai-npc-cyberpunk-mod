import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {readFileSync, renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {IN_PLACE_AFTER_REFUSALS, atomicFile, atomicFileSession, resetAtomicFileSession} from './guarded-file.mjs';

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

test('a reset during a delayed write cannot overwrite the newer reply', {timeout: 120000}, async t => {
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

test('a reset during a delayed close cannot overwrite the newer reply', {timeout: 120000}, async t => {
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

test('abort while awaiting the publish guard cannot authorize a rename', {timeout: 120000}, async t => {
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

test('cancellation during a rename retry cannot replace the newer output', {timeout: 120000}, async t => {
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
  test(`${code} permits six total rename attempts before a successful replacement`, async t => {
    const {directory, output} = await fixture(t);
    let attempts = 0, delays = 0;
    assert.equal(await atomicFile(output, 'fresh', {
      files: {rename: (...args) => {
        if (++attempts < 6) throw failure(code);
        renameSync(...args);
      }},
      retryDelay: async () => { delays++; },
    }), true);
    assert.equal(attempts, 6);
    assert.equal(delays, 5);
    await onlyOutput(directory, output, 'fresh');
  });
}

test('six failed rename attempts preserve the output and clean the owned temporary file', async t => {
  const {directory, output} = await fixture(t);
  let attempts = 0, delays = 0;
  await assert.rejects(atomicFile(output, 'stale', {
    files: {rename: async () => { attempts++; throw failure('EPERM'); }},
    retryDelay: async () => { delays++; },
  }), {code: 'EPERM'});
  assert.equal(attempts, 6);
  assert.equal(delays, 5);
  await onlyOutput(directory, output, 'original');
});

test('a rename across drives (EXDEV, a temporary file in MO2\'s Overwrite on another drive) writes the output in place and cleans the temporary file', async t => {
  const {directory, output} = await fixture(t);
  let attempts = 0;
  assert.equal(await atomicFile(output, 'fresh', {
    files: {rename: async () => { attempts++; throw failure('EXDEV'); }},
    retryDelay: () => assert.fail('EXDEV was retried'),
  }), true);
  assert.equal(attempts, 1);
  await onlyOutput(directory, output, 'fresh');
});

test('a cancelled write is not written in place after an EXDEV rename', async t => {
  const {directory, output} = await fixture(t);
  const controller = new AbortController();
  assert.equal(await atomicFile(output, 'stale', {
    signal: controller.signal,
    files: {rename: async () => { controller.abort(); throw failure('EXDEV'); }},
  }), false);
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

test('a rename that fails with EPERM twice then succeeds replaces the output and leaves no temporary file', async t => {
  const {directory, output} = await fixture(t);
  let attempts = 0;
  assert.equal(await atomicFile(output, 'fresh', {
    files: {rename: (...args) => {
      if (++attempts <= 2) throw failure('EPERM');
      renameSync(...args);
    }},
  }), true);
  assert.equal(attempts, 3);
  await onlyOutput(directory, output, 'fresh');
});

test('the default backoff outlasts a short lock and stays under about 400 ms in total', async t => {
  const {directory, output} = await fixture(t);
  let attempts = 0;
  // The total is the sum of the delays the default backoff asks for, read from the timers it sets (they still run for real: the elapsed
  // time keeps its lower bound). An upper bound on the elapsed wall time would only measure how busy the machine is.
  const delays = [], realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...rest) => { delays.push(ms); return realSetTimeout(callback, ms, ...rest); };
  const started = Date.now();
  try {
    await assert.rejects(atomicFile(output, 'stale', {
      files: {rename: () => { attempts++; throw failure('EBUSY'); }},
    }), {code: 'EBUSY'});
  } finally { globalThis.setTimeout = realSetTimeout; }
  const elapsed = Date.now() - started;
  assert.equal(attempts, 6);
  assert.deepEqual(delays, [10, 20, 40, 80, 150]);
  const requested = delays.reduce((sum, ms) => sum + ms, 0);
  assert.ok(requested >= 250 && requested < 400, `backoff asks for ${requested} ms`);
  assert.ok(elapsed >= 250, `backoff took ${elapsed} ms`);
  await onlyOutput(directory, output, 'original');
});

test('a rename that always fails keeps the old file, removes the temporary file and reports each error', async t => {
  const {directory, output} = await fixture(t);
  const failures = [];
  for (let round = 0; round < 3; round++) {
    await atomicFile(output, 'stale', {
      files: {rename: () => { throw failure('EACCES'); }},
      retryDelay: 0,
    }).catch(error => failures.push(error.code));
  }
  assert.deepEqual(failures, ['EACCES', 'EACCES', 'EACCES']);
  await onlyOutput(directory, output, 'original');
});

test('after six refused renames in a session the writes go in place, and the switch is logged once', async t => {
  const {directory, output} = await fixture(t);
  const session = {refused: 0, inPlace: false};
  const logs = [];
  let renames = 0;
  const refuse = {rename: () => { renames++; throw failure('EPERM'); }};
  const options = {files: refuse, session, retryDelay: () => {}, log: line => logs.push(line)};
  // One write is refused six times in its retry loop (it used to end in an error): the sixth refusal is the switch, and that write goes in place.
  assert.equal(await atomicFile(output, 'b', options), true, 'the sixth refused rename writes this file in place instead of failing');
  assert.equal(IN_PLACE_AFTER_REFUSALS, 6);
  assert.deepEqual([session.refused, session.inPlace, renames], [6, true, 6]);
  assert.equal(await fs.readFile(output, 'utf8'), 'b');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /refused 6 renames/);
  // Later writes do not try the rename at all, and do not log again.
  assert.equal(await atomicFile(output, 'c', options), true);
  assert.equal(await atomicFile(output, 'd', options), true);
  assert.equal(renames, 6);
  assert.equal(logs.length, 1);
  await onlyOutput(directory, output, 'd');
});

test('refusals add up across writes, a rename that works does not count, and a cancelled write is not written in place', async t => {
  const {directory, output} = await fixture(t);
  const session = {refused: 0, inPlace: false};
  const logs = [];
  let calls = 0;
  const files = {rename: (from, to) => { if (++calls % 2 === 1) throw failure('EBUSY'); return renameSync(from, to); }};
  for (let write = 0; write < IN_PLACE_AFTER_REFUSALS - 1; write++) {
    assert.equal(await atomicFile(output, `w${write}`, {files, session, retryDelay: () => {}, log: line => logs.push(line)}), true);
    assert.equal(session.inPlace, false, `${write + 1} refusals do not switch yet`);
  }
  assert.equal(session.refused, IN_PLACE_AFTER_REFUSALS - 1);
  await onlyOutput(directory, output, `w${IN_PLACE_AFTER_REFUSALS - 2}`);
  const controller = new AbortController();
  const refusing = {rename: () => { controller.abort(); throw failure('EPERM'); }};
  assert.equal(await atomicFile(output, 'stale', {files: refusing, session, signal: controller.signal, retryDelay: () => {}, log: line => logs.push(line)}), false);
  await onlyOutput(directory, output, `w${IN_PLACE_AFTER_REFUSALS - 2}`);
  assert.equal(await atomicFile(output, 'last', {files: {rename: () => { throw failure('EACCES'); }}, session, retryDelay: () => {}, log: line => logs.push(line)}), true);
  assert.equal(session.inPlace, true);
  assert.equal(logs.length, 1);
  await onlyOutput(directory, output, 'last');
});

test('the real rename counts toward the process-wide switch and a test with its own rename and no session does not', async t => {
  const {directory, output} = await fixture(t);
  resetAtomicFileSession();
  t.after(resetAtomicFileSession);
  await assert.rejects(atomicFile(output, 'x', {files: {rename: () => { throw failure('EPERM'); }}, retryDelay: () => {}}), {code: 'EPERM'});
  assert.deepEqual([atomicFileSession.refused, atomicFileSession.inPlace], [0, false]);
  assert.equal(await atomicFile(output, 'real'), true);
  await onlyOutput(directory, output, 'real');
  assert.deepEqual([atomicFileSession.refused, atomicFileSession.inPlace], [0, false]);
});
