import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {INCOMPLETE_EXIT_CODE, RUNTIME_DATA_FILES, RuntimeIncomplete, endIfIncomplete, incompleteMessage, installFileErrorGuard, isTransientFileError,
  missingRuntimeFiles, readRequiredJson} from './runtime-files.mjs';

const module = pathToFileURL(join(import.meta.dirname, 'runtime-files.mjs')).href;

async function project(t, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cyberpunk-runtime-files-'));
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), {recursive: true});
    await writeFile(join(root, name), text);
  }
  return root;
}

test('the files named are the ones the bridge reads at its start, and a missing one is found by name', async t => {
  assert(RUNTIME_DATA_FILES.includes('research/cyberpunk/generated/quest-catalog.json'));
  assert(RUNTIME_DATA_FILES.includes('characters/world-knowledge.json'));
  const root = await project(t, {'characters/roster.json': '[]', 'characters/world-knowledge.json': '{}'});
  assert.deepEqual(await missingRuntimeFiles(root), ['characters/phone-contacts.json', 'research/cyberpunk/generated/quest-catalog.json']);
  assert.deepEqual(await missingRuntimeFiles(root, ['characters/roster.json']), []);
  assert.deepEqual(await missingRuntimeFiles(root, RUNTIME_DATA_FILES, {exists: async () => { throw Object.assign(Error('denied'), {code: 'EPERM'}); }}), [...RUNTIME_DATA_FILES],
    'a file that cannot be reached counts as missing');
});

test('a required file that is not there is a RuntimeIncomplete that names the file and never a folder', async t => {
  const root = await project(t, {'characters/roster.json': '[{"id":1}]'});
  assert.deepEqual(await readRequiredJson(root, 'characters/roster.json'), [{id: 1}]);
  await assert.rejects(readRequiredJson(root, 'research/cyberpunk/generated/quest-catalog.json'), error => {
    assert(error instanceof RuntimeIncomplete);
    assert.equal(error.code, 'RUNTIME_INCOMPLETE');
    assert.match(error.message, /^The Runtime is incomplete: research\/cyberpunk\/generated\/quest-catalog\.json is missing\. Download the Runtime again/);
    assert(!error.message.includes(root), 'no folder (it can hold the Windows user name)');
    return true;
  });
  // A damaged file, or one that cannot be read, is not "missing": it is the error it was.
  const damaged = await project(t, {'characters/roster.json': '{not json'});
  await assert.rejects(readRequiredJson(damaged, 'characters/roster.json'), SyntaxError);
  await assert.rejects(readRequiredJson(root, 'characters/roster.json', {read: async () => { throw Object.assign(Error('busy'), {code: 'EBUSY'}); }}), {code: 'EBUSY'});
  assert.equal(incompleteMessage(['a.json', 'b.json']).startsWith('The Runtime is incomplete: a.json, b.json are missing.'), true);
});

test('the bridge\'s top level ends cleanly for a missing file (one line, its own exit code) and still throws every other error', () => {
  const lines = [], exits = [];
  const options = {log: line => lines.push(line), exit: code => exits.push(code)};
  const missing = new RuntimeIncomplete('characters/world-knowledge.json');
  assert.throws(() => endIfIncomplete(missing, options), missing, 'an exit that did not end the process does not let the caller go on');
  assert.deepEqual(exits, [INCOMPLETE_EXIT_CODE]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /characters\/world-knowledge\.json is missing/);
  const damaged = new SyntaxError('Unexpected token');
  assert.throws(() => endIfIncomplete(damaged, options), damaged);
  assert.deepEqual(exits, [INCOMPLETE_EXIT_CODE], 'a damaged file does not use the incomplete code');
});

test('which file errors are the kind a read nobody waits for can have', () => {
  for (const code of ['ENOENT', 'EPERM', 'EBUSY', 'EACCES']) assert.equal(isTransientFileError(Object.assign(Error('x'), {code, syscall: 'open'})), true, code);
  assert.equal(isTransientFileError(Object.assign(Error('x'), {code: 'ENOENT'})), false, 'no syscall: not from the file system');
  assert.equal(isTransientFileError(Object.assign(Error('x'), {code: 'ECONNRESET', syscall: 'read'})), false);
  assert.equal(isTransientFileError(new TypeError('x is not a function')), false);
  assert.equal(isTransientFileError(undefined), false);
});

test('an unawaited read of a file that went away does not end the process; any other unhandled rejection still does', () => {
  const run = body => spawnSync(process.execPath, ['--input-type=module', '-e', `import {installFileErrorGuard} from ${JSON.stringify(module)};
const lines = [], recorded = [];
installFileErrorGuard({log: line => lines.push(line), record: error => recorded.push(error.code)});
${body}`], {encoding: 'utf8', timeout: 20000});
  const survived = run(`import('node:fs/promises').then(async fs => {
  fs.readFile('definitely-not-a-file-' + process.pid + '.json');   // nobody awaits it
  await new Promise(done => setTimeout(done, 300));
  console.log(JSON.stringify({lines, recorded}));
});`);
  assert.equal(survived.status, 0, survived.stderr);
  const seen = JSON.parse(survived.stdout.trim());
  assert.deepEqual(seen.recorded, ['ENOENT']);
  assert.match(seen.lines[0], /nothing was waiting for it \(ENOENT, open\); the service goes on/);
  assert(!seen.lines[0].includes('definitely-not-a-file'), 'no path in the log line');
  const crashed = run(`Promise.reject(new TypeError('a real bug')); setTimeout(() => console.log('still alive'), 300);`);
  assert.notEqual(crashed.status, 0, 'a bug in the code is still a crash');
  assert.match(crashed.stderr, /a real bug/);
  assert.doesNotMatch(crashed.stdout, /still alive/);
});

test('the guard can be removed again', () => {
  const calls = [], processRef = {on: (name, listener) => calls.push(['on', name, listener]), removeListener: (name, listener) => calls.push(['off', name, listener])};
  const remove = installFileErrorGuard({processRef});
  remove();
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['on', 'unhandledRejection'], ['off', 'unhandledRejection']]);
  assert.equal(calls[0][2], calls[1][2]);
});
