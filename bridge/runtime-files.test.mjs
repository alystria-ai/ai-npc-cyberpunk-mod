import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {INCOMPLETE_EXIT_CODE, RUNTIME_DATA_FILES, RUNTIME_PACKAGE_FILES, RUNTIME_REQUIRED_FILES, RuntimeIncomplete, endIfIncomplete, incompleteMessage,
  installFileErrorGuard, isTransientFileError, mismatchMessage, missingModuleInLog, missingRuntimeFiles, readRequiredJson, versionMismatchInLog} from './runtime-files.mjs';

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
    assert.match(error.message, /^The Runtime is incomplete: research\/cyberpunk\/generated\/quest-catalog\.json is missing\. Extract the full install zip/);
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

test('the Node packages the bridge imports are required files too, so a Runtime without them is incomplete before any bridge starts', async t => {
  assert(RUNTIME_PACKAGE_FILES.includes('node_modules/playwright/package.json'));
  assert(RUNTIME_PACKAGE_FILES.includes('node_modules/playwright-core/package.json'));
  assert(RUNTIME_PACKAGE_FILES.includes('node_modules/playwright-core/lib/server/dispatchers/dispatcher.js'), 'the file one report found missing');
  assert.deepEqual([...RUNTIME_REQUIRED_FILES], [...RUNTIME_DATA_FILES, ...RUNTIME_PACKAGE_FILES]);
  const files = Object.fromEntries(RUNTIME_REQUIRED_FILES.map(name => [name, '{}']));
  const whole = await project(t, files);
  assert.deepEqual(await missingRuntimeFiles(whole, RUNTIME_REQUIRED_FILES), []);
  delete files['node_modules/playwright/package.json']; delete files['node_modules/playwright-core/lib/server/dispatchers/dispatcher.js'];
  const partial = await project(t, files);
  assert.deepEqual(await missingRuntimeFiles(partial, RUNTIME_REQUIRED_FILES),
    ['node_modules/playwright/package.json', 'node_modules/playwright-core/lib/server/dispatchers/dispatcher.js']);
});

test('what Node says when the bridge cannot load a package or a file of its own becomes a name relative to the Runtime, never a folder', () => {
  const project = 'D:\\Made Up Games\\Some Game\\red4ext\\plugins\\FakeMod\\app';
  const stack = `${project}\\node_modules\\fakepkg-core\\lib\\server\\index.js`;
  // ESM, a package that is not installed at all
  assert.equal(missingModuleInLog(`--- bridge started ---\nnode:internal/modules/package_json_reader:331\n    throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);\n          ^\n`
    + `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'fakepkg' imported from ${project}\\bridge\\realtime-host.mjs\n    code: 'ERR_MODULE_NOT_FOUND'\n`, project), 'node_modules/fakepkg');
  assert.equal(missingModuleInLog(`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@fakescope/tool/sub' imported from ${project}\\bridge\\x.mjs`, project), 'node_modules/@fakescope/tool');
  // CommonJS, a file inside a package: the specifier is relative to the first file of the require stack
  const inner = `node:internal/modules/cjs/loader:1564\nError: Cannot find module './inner/thing'\nRequire stack:\n- ${stack}\n- ${project}\\node_modules\\fakepkg-core\\lib\\other.js\n  code: 'MODULE_NOT_FOUND',\n`;
  assert.equal(missingModuleInLog(inner, project), 'node_modules/fakepkg-core/lib/server/inner/thing');
  assert.equal(missingModuleInLog(inner), 'node_modules/fakepkg-core/lib/server/inner/thing', 'without the project folder the name starts at node_modules');
  assert.equal(missingModuleInLog(`Error: Cannot find module '../up'\nRequire stack:\n- ${stack}`, project), 'node_modules/fakepkg-core/lib/up');
  // CommonJS, a package named by its bare name
  assert.equal(missingModuleInLog(`Error: Cannot find module 'leftpad-fake'\nRequire stack:\n- ${project}\\bridge\\x.cjs`, project), 'node_modules/leftpad-fake');
  // ESM, a file of the bridge itself, by its absolute path
  assert.equal(missingModuleInLog(`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${project}\\bridge\\gone.mjs' imported from ${project}\\bridge\\convai-bridge.mjs`, project), 'bridge/gone.mjs');
  assert.equal(missingModuleInLog(`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${project}\\bridge\\gone.mjs' imported from ${project}\\bridge\\convai-bridge.mjs`), 'gone.mjs');
  for (const log of [inner, `Error: Cannot find module 'D:\\Made Up Games\\elsewhere\\x.js'`]) {
    const name = missingModuleInLog(log, project);
    assert(!/Made Up|Some Game|D:/.test(name), `a folder in ${name}`);
  }
  // anything else is not a missing file
  for (const log of ['', undefined, null, 'TypeError: x is not a function\n    at run (file.mjs:1:1)', 'Error: connect ECONNREFUSED 127.0.0.1:1', 'ValueError: Pocket source differs']) assert.equal(missingModuleInLog(log, project), null, String(log));
});

test('Node\'s "does not provide an export named" (files of two versions) is read like a missing file, named relative to the Runtime, and told apart for its own message', () => {
  const project = 'D:\\Made Up Games\\Some Game\\red4ext\\plugins\\FakeMod\\app';
  const heading = 'file:///D:/Made Up Games/Some Game/red4ext/plugins/FakeMod/app/bridge/convai-bridge.mjs:12';
  const local = `${heading}\nimport {newerThing} from './runtime-files.mjs';\n        ^^^^^^^^\nSyntaxError: The requested module './runtime-files.mjs' does not provide an export named 'newerThing'\n    at ModuleJob._instantiate (node:internal/modules/esm/module_job:180:21)`;
  assert.equal(missingModuleInLog(local, project), 'bridge/runtime-files.mjs');
  assert.equal(versionMismatchInLog(local), true);
  assert.equal(missingModuleInLog(local), 'runtime-files.mjs', 'without the project folder only the file name');
  // From a package's own file and a bare package name
  assert.equal(missingModuleInLog(`SyntaxError: The requested module 'fakepkg-core/lib/x' does not provide an export named 'y'`, project), 'node_modules/fakepkg-core');
  assert.equal(missingModuleInLog(`SyntaxError: The requested module 'D:\\Made Up Games\\Some Game\\red4ext\\plugins\\FakeMod\\app\\bridge\\old.mjs' does not provide an export named 'z'`, project), 'bridge/old.mjs');
  // A missing file is not a mismatch, and a message with no importing file still names the file
  assert.equal(versionMismatchInLog(`Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'fakepkg' imported from ${project}\\bridge\\x.mjs`), false);
  assert.equal(missingModuleInLog(`SyntaxError: The requested module './lone.mjs' does not provide an export named 'q'`, project), 'lone.mjs');
  for (const name of ['bridge/runtime-files.mjs', 'node_modules/fakepkg-core']) {
    const message = mismatchMessage(name);
    assert.match(message, /full install zip \(AI-Companions-LLM, on Nexus Mods\) into the Cyberpunk 2077 folder again/);
    assert(!/\d+\.\d+/.test(message.replace(name, '')), 'no version number in the instruction');
    assert(message.includes(name) && !/Made Up|Some Game|D:/.test(message));
  }
});

test('the guard can be removed again', () => {
  const calls = [], processRef = {on: (name, listener) => calls.push(['on', name, listener]), removeListener: (name, listener) => calls.push(['off', name, listener])};
  const remove = installFileErrorGuard({processRef});
  remove();
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['on', 'unhandledRejection'], ['off', 'unhandledRejection']]);
  assert.equal(calls[0][2], calls[1][2]);
});
