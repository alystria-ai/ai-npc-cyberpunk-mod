// scripts/run-tests.mjs is how `npm test` finds and runs the suite: a new *.test.mjs is picked up by location, a short EXCLUDE list is
// skipped, and the files are run in batches that stay under the Windows command-line limit. A test file that lands where the runner
// does not look, or a stale EXCLUDE entry, silently removes coverage, so the runner and the file layout are checked here.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EXCLUDE, collectTestFiles} from './run-tests.mjs';

const run = promisify(execFile);
const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const runner = resolve(project, 'scripts/run-tests.mjs');
const SEARCH_DIRS = ['bridge', 'packaging', 'scripts', 'auth-backend', 'addons'];
const pkg = JSON.parse(await readFile(resolve(project, 'package.json'), 'utf8'));

// Directories that hold developer-only or third-party material and are not part of the repository (the root .gitignore names them).
async function ignoredRoots() {
  const text = await readFile(resolve(project, '.gitignore'), 'utf8');
  const names = new Set(['.git', '.claude', 'node_modules']);
  for (const line of text.split(/\r?\n/)) { const match = /^\/([^/*!#]+)\/$/.exec(line.trim()); if (match) names.add(match[1]); }
  return names;
}
async function walkTests(dir, skip, out = []) {
  for (const entry of await readdir(join(project, dir), {withFileTypes: true})) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (!dir && skip.has(entry.name)) continue;
    if (entry.isDirectory()) await walkTests(rel, skip, out);
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) out.push(rel);
  }
  return out;
}

test('the runner finds test files by location: sorted, unique, slash-separated, inside the searched folders only, EXCLUDE removed', () => {
  const files = collectTestFiles();
  assert(files.length > 250, `${files.length} test files`);
  assert.deepEqual(files, [...files].sort());
  assert.equal(new Set(files).size, files.length);
  for (const file of files) {
    assert.match(file, /^(?:bridge|packaging|scripts|auth-backend|addons)\/.+\.test\.mjs$/, file);
    assert(!file.includes('\\') && !file.includes('node_modules'), file);
    assert(!EXCLUDE.has(file), `${file} is excluded`);
  }
  for (const dir of SEARCH_DIRS) assert(files.some(file => file.startsWith(`${dir}/`)), `${dir}/ has tests that run`);
  // This file, and the tests of the newest areas, are found without being listed anywhere.
  assert(files.includes('scripts/run-tests.test.mjs'));
  assert(files.includes('bridge/manager.test.mjs'));
});

test('every EXCLUDE entry names a real test file in a searched folder, so a rename cannot leave a stale entry that hides a new test', () => {
  for (const file of EXCLUDE) {
    assert(existsSync(resolve(project, file)), `${file} does not exist: remove it from EXCLUDE in scripts/run-tests.mjs`);
    assert.match(file, /^(?:bridge|packaging|scripts|auth-backend|addons)\/.+\.test\.mjs$/, file);
  }
});

test('every test file in the repository is run by npm test, is excluded on purpose, or is run by a named npm script', async () => {
  const skip = await ignoredRoots();
  const found = (await walkTests('', skip)).sort();
  assert(found.length >= collectTestFiles().length);
  const runByScript = JSON.stringify(pkg.scripts);
  const collected = new Set(collectTestFiles());
  const orphans = found.filter(file => !collected.has(file) && !EXCLUDE.has(file) && !runByScript.includes(file));
  assert.deepEqual(orphans, [], 'no runner looks here: move the file under bridge/, packaging/, scripts/, auth-backend/ or addons/, or add it to a package.json script');
});

test('every file a package.json script names exists, so a renamed test cannot leave a script that fails on its first line', async () => {
  const missing = [];
  for (const [name, command] of Object.entries(pkg.scripts)) {
    for (const match of command.matchAll(/(?:^|\s)((?:bridge|packaging|scripts|research|auth-backend|addons)\/[A-Za-z0-9_./-]+\.(?:mjs|py|js))\b/g)) {
      if (!existsSync(resolve(project, match[1]))) missing.push(`${name}: ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the files npm test leaves out are a short, commented list: adding to it is a visible decision', async () => {
  // Every test file runs (the list is empty since the gesture, seating, profile and release pipeline tests were taken off it); the runner
  // must not grow a silent list. The count is pinned so that adding to EXCLUDE is a visible decision.
  assert(EXCLUDE.size <= 3, `${EXCLUDE.size} excluded files: review the list before adding to it`);
  const source = await readFile(resolve(project, 'scripts/run-tests.mjs'), 'utf8');
  for (const file of EXCLUDE) assert(source.includes(`"${file}", //`), `${file} carries a comment saying why`);
});

// ---- the runner as a process, in a copy of the layout (the script finds its project from its own location)
async function layout(files, {exclude = []} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'run-tests-layout-'));
  await mkdir(join(root, 'scripts'), {recursive: true});
  // The copy may carry an EXCLUDE list of its own, written into the empty one the real runner has.
  const empty = 'export const EXCLUDE = new Set([\n]);';
  const text = (await readFile(runner, 'utf8')).replace(/\r\n/g, '\n');
  assert(text.includes(empty), 'the runner declares its EXCLUDE list as an empty Set, one entry per line');
  const entries = exclude.map(file => `  "${file}", // for this test\n`).join('');
  await writeFile(join(root, 'scripts/run-tests.mjs'), text.replace(empty, `export const EXCLUDE = new Set([\n${entries}]);`));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const dir of SEARCH_DIRS) await mkdir(join(root, dir), {recursive: true});
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(root, rel, '..'), {recursive: true});
    await writeFile(join(root, rel), body);
  }
  return root;
}
const passing = "import {test} from 'node:test'; test('ok', () => {});\n";
const failing = "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('bad', () => assert.equal(1, 2));\n";
// The nested runner must not think it is a child of this test run (NODE_TEST_CONTEXT makes `node --test` print nothing and exit 0).
const cleanEnv = () => { const env = {...process.env}; delete env.NODE_TEST_CONTEXT; return env; };
const execute = async (root, ...args) => {
  try { const done = await run(process.execPath, [join(root, 'scripts/run-tests.mjs'), ...args], {cwd: root, env: cleanEnv(), encoding: 'utf8', timeout: 120_000}); return {code: 0, ...done}; }
  catch (error) { return {code: error.code, stdout: error.stdout, stderr: error.stderr}; }
};

test('the runner exits 0 when every collected test passes and 1 when one fails; node_modules, dot folders and other folders are not searched', async () => {
  const good = await layout({'bridge/a.test.mjs': passing, 'packaging/b.test.mjs': passing, 'node_modules/x/c.test.mjs': failing,
    '.hidden/d.test.mjs': failing, 'research/e.test.mjs': failing, 'bridge/not-a-test.mjs': failing});
  try {
    const ok = await execute(good, '--test-reporter=dot');
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /run-tests: 2 test files in 1 batch\(es\)/);
  } finally { await rm(good, {recursive: true, force: true}); }
  const bad = await layout({'bridge/a.test.mjs': passing, 'scripts/b.test.mjs': failing});
  try {
    const failed = await execute(bad, '--test-reporter=dot');
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /run-tests: 2 test files in 1 batch\(es\)/);
  } finally { await rm(bad, {recursive: true, force: true}); }
});

test('an excluded file is not run even when it fails, and the same file outside the list is', async () => {
  const name = 'bridge/skipped.test.mjs';
  const root = await layout({[name]: failing, 'bridge/other.test.mjs': passing}, {exclude: [name]});
  try {
    const skipped = await execute(root, '--test-reporter=dot');
    assert.equal(skipped.code, 0, skipped.stdout + skipped.stderr);
    assert.match(skipped.stdout, /run-tests: 1 test files/);
  } finally { await rm(root, {recursive: true, force: true}); }
  const renamed = await layout({'bridge/not-excluded-name.test.mjs': failing});
  try { assert.equal((await execute(renamed, '--test-reporter=dot')).code, 1); } finally { await rm(renamed, {recursive: true, force: true}); }
});

test('a suite too large for one command line is split into batches, every file runs once, and one failing batch fails the whole run', async () => {
  const files = {};
  // 20,000 characters of arguments per process: 260 files with 100-character paths need two or more batches.
  for (let index = 0; index < 260; index++) files[`bridge/${'long-name-'.repeat(8)}${String(index).padStart(3, '0')}.test.mjs`] = passing;
  const root = await layout(files);
  try {
    const result = await execute(root, '--test-reporter=dot');
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const header = /run-tests: (\d+) test files in (\d+) batch\(es\)/.exec(result.stdout);
    assert.equal(Number(header[1]), 260);
    assert(Number(header[2]) >= 2, `${header[2]} batches`);
    assert.equal((result.stdout.match(/^\.+$/gm) ?? []).join('').length, 260, 'each of the 260 tests ran exactly once');
    await writeFile(join(root, 'bridge', `${'long-name-'.repeat(8)}259.test.mjs`), failing);
    assert.equal((await execute(root, '--test-reporter=dot')).code, 1, 'a failure in the last batch fails the run');
    await writeFile(join(root, 'bridge', `${'long-name-'.repeat(8)}259.test.mjs`), passing);
    await writeFile(join(root, 'bridge', `${'long-name-'.repeat(8)}000.test.mjs`), failing);
    assert.equal((await execute(root, '--test-reporter=dot')).code, 1, 'a failure in the first batch fails the run too, though later batches pass');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('a search folder that does not exist is skipped, not a crash of the whole run', async () => {
  const root = await layout({'bridge/a.test.mjs': passing});
  try {
    await rm(join(root, 'addons'), {recursive: true, force: true});
    const result = await execute(root, '--test-reporter=dot');
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /run-tests: 1 test files/);
  } finally { await rm(root, {recursive: true, force: true}); }
});
