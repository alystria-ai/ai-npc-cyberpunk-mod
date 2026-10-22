// The Scripts package (the Nexus Mods download), built for real by packaging/build-release.mjs and checked against what
// docs/PACKAGING.md promises: text only, the CET mod folder with every shipped Lua file and locale, the redscript, the four catalogs,
// the empty runtime/ placeholders (Mod Organizer 2), README, licence, release.json and the install note. The Scripts build needs no
// download, model or secret and takes about two seconds, so the test runs the real builder (a dry run of only this package).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {listZip} from './lib/zip.mjs';
import {sha256File, walk} from './lib/files.mjs';
import {loadRuntimeExchange} from './lib/runtime-exchange.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(project, 'packaging/release.config.json'), 'utf8'));
const exchange = await loadRuntimeExchange(project);
const MOD = config.layout.modDirectory;
const VERSION = '0.0.1';
const ZIP_NAME = `${config.product}-Scripts-${VERSION}.zip`;
const INSTALL_NOTE = 'HOW TO INSTALL - extract into your Cyberpunk 2077 folder.txt';
const tar = process.platform === 'win32' ? resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

function build(args, env = {}) {
  return spawnSync(process.execPath, [resolve(project, 'packaging/build-release.mjs'), ...args], {
    cwd: project, encoding: 'utf8', timeout: 180_000, env: {...process.env, GITHUB_ACTIONS: '', ...env},
  });
}
const buildArgs = (out, cache, extra = []) => ['--version', VERSION, '--dry-run', '--packages', 'scripts', '--worktree', '--out', out, '--cache', cache, ...extra];

let root, out, packages, zipPath, entries, extracted, built;
const names = () => entries.map(entry => entry.name);
const under = prefix => names().filter(name => name.startsWith(prefix));
const text = async rel => readFile(join(extracted, ...rel.split('/')), 'utf8');

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'scripts-package-layout-'));
  out = join(root, 'out'); packages = join(out, 'packages'); extracted = join(root, 'extracted');
  built = build(buildArgs(out, join(root, 'cache')));
  zipPath = join(packages, ZIP_NAME);
  if (built.status !== 0) return;
  entries = await listZip(zipPath);
  await mkdir(extracted);
  const result = spawnSync(tar, ['-xf', zipPath, '-C', extracted], {encoding: 'utf8'});
  if (result.status !== 0) throw Error(`tar could not extract the Scripts zip: ${result.stderr}`);
});
after(async () => { if (root) await rm(root, {recursive: true, force: true}); });

test('a Scripts-only dry run builds with no download, model or key, and writes the zip, its file list and the manifest (no checksum file)', async () => {
  assert.equal(built.status, 0, built.stderr + built.stdout);
  assert.deepEqual((await readdir(packages)).sort(), [`${config.product}-Scripts-${VERSION}.files.json`, ZIP_NAME, 'release-manifest.json'].sort());
  // Nothing but the Scripts package was staged: no Runtime or pack zip, and no stage/native working folders left behind.
  assert.deepEqual((await readdir(out)).filter(name => name !== 'packages'), []);
  assert.match(built.stdout, /Staging the Scripts package/);
  assert.doesNotMatch(built.stdout + built.stderr, /Downloading|download/i);
});

test('the manifest and the file list agree with the zip, byte for byte', async () => {
  const zipSha = await sha256File(zipPath);
  const manifest = JSON.parse(await readFile(join(packages, 'release-manifest.json'), 'utf8'));
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.dryRun, true);
  assert.deepEqual(Object.keys(manifest.packages), ['scripts']);
  const archive = manifest.packages.scripts.archives;
  assert.equal(archive.length, 1, 'the Scripts package is one zip at this size');
  assert.equal(archive[0].file, ZIP_NAME);
  assert.equal(archive[0].sha256, zipSha);
  assert.equal(archive[0].entries, entries.length);
  const list = JSON.parse(await readFile(join(packages, `${config.product}-Scripts-${VERSION}.files.json`), 'utf8'));
  assert.equal(list.length, entries.length);
  assert.equal(manifest.packages.scripts.fileCount, entries.length);
  assert.equal(manifest.packages.scripts.uncompressedBytes, list.reduce((sum, file) => sum + file.bytes, 0));
  assert.deepEqual(list.map(file => file.path).sort(), names().sort());
  for (const file of list) {
    const path = join(extracted, ...file.path.split('/'));
    assert.equal(await sha256File(path), file.sha256, file.path);
  }
});

test('every entry sits in the CET mod folder, the redscript folder or is the install note, and every path fits a typical game folder', () => {
  const stray = names().filter(name => name !== INSTALL_NOTE && !name.startsWith(`${MOD}/`) && !name.startsWith('r6/scripts/CyberpunkConvai/'));
  assert.deepEqual(stray, []);
  const limit = config.layout.maxPathLength - config.layout.maxGameRootLength - 1;
  assert.deepEqual(names().filter(name => name.length > limit), []);
  assert.deepEqual(names().filter(name => /[\\]|^\/|(?:^|\/)\.\.?(?:\/|$)|[:*?"<>|]/.test(name)), [], 'plain relative forward-slashed names');
  assert.equal(new Set(names().map(name => name.toLowerCase())).size, names().length, 'no two names differ only by case (Windows would merge them)');
});

test('the package is text only: no binary, no archive, no executable, no model', () => {
  const unexpected = names().filter(name => !/\.(?:lua|reds|json|txt|log|ndjson)$/.test(name));
  assert.deepEqual(unexpected, []);
  assert.deepEqual(entries.filter(entry => entry.method !== 8 && entry.uncompressed > 0), [], 'text is deflated, never stored');
});

test('every shipped Lua file and locale is in the package and byte-identical to the source; no development-only file ships', async () => {
  const sources = (await walk(resolve(project, 'mod'))).filter(rel => rel.endsWith('.lua'));
  const shippedSources = sources.filter(rel => !config.devOnlyLua.includes(rel)).sort();
  const inZip = under(`${MOD}/`).map(name => name.slice(MOD.length + 1)).filter(rel => rel.endsWith('.lua')).sort();
  assert.deepEqual(inZip, shippedSources);
  for (const name of config.devOnlyLua) assert(!inZip.includes(name), `${name} is development-only`);
  for (const rel of shippedSources) {
    assert.equal(await sha256File(join(extracted, ...MOD.split('/'), ...rel.split('/'))), await sha256File(resolve(project, 'mod', rel)), rel);
  }
  assert(inZip.includes('init.lua') && inZip.includes('manager.lua') && inZip.includes('native-core.lua'));
  // CET loads init.lua first: it must be at the top of the mod folder, not inside a subfolder.
  assert(names().includes(`${MOD}/init.lua`));
});

test('every interface language the Lua offers has its locale file in the package, and no locale file is unused', async () => {
  const source = await readFile(resolve(project, 'mod/ui-locale.lua'), 'utf8');
  const table = /local languages = \{([\s\S]*?)\n\}/.exec(source)?.[1];
  assert(table, 'ui-locale.lua has its language table');
  const codes = [...table.matchAll(/value = '([a-z-]+)'/g)].map(match => match[1]);
  assert(codes.length >= 15, `${codes.length} languages`);
  const shipped = under(`${MOD}/locales/`).map(name => name.slice(`${MOD}/locales/`.length).replace(/\.lua$/, '')).sort();
  assert.deepEqual(shipped, codes.filter(code => code !== 'en').sort(), 'English is the keys themselves; every other language is one locale file');
});

test('the redscript is every .reds the repository has minus the retired ones', async () => {
  const sources = (await readdir(resolve(project, 'r6/scripts/CyberpunkConvai'))).filter(name => name.endsWith('.reds'))
    .filter(name => !config.retiredRedscript.includes(name)).sort();
  const shipped = under('r6/scripts/CyberpunkConvai/').map(name => name.split('/').pop()).sort();
  assert.deepEqual(shipped, sources);
  for (const name of config.retiredRedscript) assert(!shipped.includes(name), `${name} is retired`);
  assert(shipped.length >= 10);
});

test('the four JSON catalogs sit at the mod root under the names the Lua reads, identical to their sources and valid JSON', async () => {
  for (const {source, target} of config.catalogs) {
    const rel = `${MOD}/${target}`;
    assert(names().includes(rel), rel);
    assert.equal(await sha256File(join(extracted, ...rel.split('/'))), await sha256File(resolve(project, source)), target);
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(extracted, ...rel.split('/')), 'utf8')), `${target} parses`);
  }
  assert.equal(config.catalogs.length, 4);
});

test('runtime/ holds exactly the exchange placeholders, all empty, and nothing of the player-state, optional or other classes', () => {
  const runtime = under(`${MOD}/runtime/`).map(name => name.slice(`${MOD}/runtime/`.length));
  assert.deepEqual(runtime.sort(), [...exchange.exchange].sort());
  const sizes = entries.filter(entry => entry.name.startsWith(`${MOD}/runtime/`)).filter(entry => entry.uncompressed !== 0);
  assert.deepEqual(sizes.map(entry => entry.name), [], 'a placeholder is a 0-byte file: a non-empty one would be stale data on every install');
  const forbidden = new Set([...exchange.state, ...exchange.optional, ...exchange.elsewhere]);
  assert.deepEqual(runtime.filter(name => forbidden.has(name)), []);
  // Never a temp, backup or lock file: the Lua and the bridge never write those under runtime/ in the game folder.
  assert.deepEqual(runtime.filter(name => /\.(?:tmp|bak|previous|lock|pid|corrupt)$/i.test(name)), []);
  assert.deepEqual(runtime.filter(name => name.includes('/')), [], 'no subfolders: each placeholder sits directly in runtime/');
});

test("the player's own state and secrets never ship: no settings, key, memory, chat history or session file anywhere in the zip", () => {
  // The data and secret files by their real names (bridge/convai-key.mjs, mistral-key.mjs, player-memory.mjs, ...):
  // the "*-key-command.json" and "*-state.json" files are exchange placeholders and are rightly shipped, empty.
  const FORBIDDEN = /(?:^|\/)(?:settings\.json|convai-key\.txt|player-(?:convai|mistral|inworld|voxtral)-key\.txt|[a-z-]*-key\.txt|service\.txt|kaggle-access-token\.txt|huggingface-[^/]*\.txt|\.env|(?:player|vendor)-memory[^/]*\.(?:json|bak|tmp|corrupt)|phone-sessions\.json|phone-history\.json|characters-verified\.json|addon-settings\.json|witness-receipts\.json|decision-ledger\.json)$/i;
  assert.deepEqual(names().filter(name => FORBIDDEN.test(name)), []);
  assert.deepEqual(names().filter(name => /^misc\//.test(name) || /CyberpunkConvaiLauncher/i.test(name)), []);
});

test('release.json, README.txt and LICENSE.txt are written from the build and the repository', async () => {
  const release = JSON.parse(await text(`${MOD}/release.json`));
  assert.deepEqual(release, {product: config.product, package: 'scripts', version: VERSION, commit: 'worktree'});
  assert.equal(await text(`${MOD}/README.txt`), await readFile(resolve(project, 'packaging/PLAYER_README.md'), 'utf8'));
  assert.equal(await text(`${MOD}/LICENSE.txt`), await readFile(resolve(project, 'LICENSE'), 'utf8'));
});

test('the install note is the first thing in the zip root and tells the player to extract into the game folder', async () => {
  const note = await text(INSTALL_NOTE);
  assert.match(note, /Extract this zip INTO your Cyberpunk 2077 folder/);
  assert.match(note, /bin, archive and r6/);
  assert.match(note, /Do not extract it into a new folder named after the zip/);
  // What the note promises about the zip is true of this zip: it starts with the game's own folders (bin and r6 here).
  const roots = new Set(names().filter(name => name !== INSTALL_NOTE).map(name => name.split('/')[0]));
  assert.deepEqual([...roots].sort(), ['bin', 'r6']);
  assert.equal(names().filter(name => !name.includes('/')).join(), INSTALL_NOTE, 'the note is the only top-level file');
});

// The Runtime ships no Convai key (packaging/lib/convai-auth.mjs): the build refuses one, and takes the token backend's address and client secret instead.
const NO_AUTH = {CONVAI_AUTH_URL: '', CONVAI_AUTH_CLIENT_SECRET: ''};

test('a Convai key given to the build is refused with a clear message, never printed and never written', async () => {
  const secret = 'test-only-key-3f9a1c7e5b2d4a60';
  const keyRoot = await mkdtemp(join(tmpdir(), 'scripts-package-key-'));
  try {
    for (const args of [['--key-env', 'CPM_TEST_PACKAGE_KEY'], ['--key-file', join(keyRoot, 'key.txt')]]) {
      await writeFile(join(keyRoot, 'key.txt'), `api-key = ${secret}\n`);
      const run = build(buildArgs(join(keyRoot, 'out'), join(keyRoot, 'cache'), args), {...NO_AUTH, CPM_TEST_PACKAGE_KEY: `api-key = ${secret}`});
      assert.notEqual(run.status, 0, args[0]);
      assert.match(run.stderr, /Convai key is no longer shipped/);
      assert(!(run.stdout + run.stderr).includes(secret), 'the key is never printed');
    }
    assert.equal(existsSync(join(keyRoot, 'out/packages')), false, 'nothing was built');
  } finally { await rm(keyRoot, {recursive: true, force: true}); }
});

test('the backend secret given to a dry run is never printed and never ends up in the Scripts zip; GitHub gets it masked', async () => {
  const secret = 'test-only-client-secret-3f9a1c7e5b2d4a60';
  const keyRoot = await mkdtemp(join(tmpdir(), 'scripts-package-auth-'));
  try {
    const run = build(buildArgs(join(keyRoot, 'out'), join(keyRoot, 'cache'), ['--auth-url', 'https://backend.example/api/convai/token', '--auth-secret-env', 'CPM_TEST_CONVAI_AUTH_SECRET']),
      {...NO_AUTH, CPM_TEST_CONVAI_AUTH_SECRET: secret});
    assert.equal(run.status, 0, run.stderr);
    assert(!(run.stdout + run.stderr).includes(secret), 'the secret is never printed');
    assert.match(run.stdout, /sign-in backend backend\.example/, 'only the host is logged');
    const masked = build(buildArgs(join(keyRoot, 'out2'), join(keyRoot, 'cache')), {...NO_AUTH, CONVAI_AUTH_URL: 'https://backend.example/api/convai/token', CONVAI_AUTH_CLIENT_SECRET: secret, GITHUB_ACTIONS: 'true'});
    assert.equal(masked.status, 0, masked.stderr);
    assert(masked.stdout.includes(`::add-mask::${secret}`), 'the runner is told to mask it');
    const keyZip = join(keyRoot, 'out/packages', ZIP_NAME);
    const where = join(keyRoot, 'x'); await mkdir(where);
    assert.equal(spawnSync(tar, ['-xf', keyZip, '-C', where]).status, 0);
    for (const rel of await walk(where)) {
      const bytes = await readFile(join(where, rel));
      assert(!bytes.includes(secret), `${rel} carries the secret`);
      assert(!bytes.includes(Buffer.from(secret).toString('base64')), `${rel} carries the secret base64`);
    }
  } finally { await rm(keyRoot, {recursive: true, force: true}); }
});

test('a bad backend address or secret stops the build without printing the secret; a real Runtime build without both stops before anything is fetched', async () => {
  const keyRoot = await mkdtemp(join(tmpdir(), 'scripts-package-badauth-'));
  try {
    const good = 'test-only-client-secret-3f9a1c7e5b2d4a60';
    const cases = [
      [{CONVAI_AUTH_URL: 'http://backend.example/api/convai/token', CONVAI_AUTH_CLIENT_SECRET: good}, /must be https/],
      [{CONVAI_AUTH_URL: 'https://backend.example/api/other', CONVAI_AUTH_CLIENT_SECRET: good}, /must end with \/api\/convai\/token/],
      [{CONVAI_AUTH_URL: 'https://backend.example/api/convai/token', CONVAI_AUTH_CLIENT_SECRET: 'too short 123'}, /client secret/],
      [{CONVAI_AUTH_URL: 'https://backend.example/api/convai/token', CONVAI_AUTH_CLIENT_SECRET: ''}, /needs both/],
      [{CONVAI_AUTH_URL: '', CONVAI_AUTH_CLIENT_SECRET: good}, /needs both/],
    ];
    for (const [env, message] of cases) {
      const run = build(buildArgs(join(keyRoot, 'a'), join(keyRoot, 'c')), env);
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, message);
      assert(!(run.stdout + run.stderr).includes(good) && !(run.stdout + run.stderr).includes('too short 123'), 'no secret is shown');
    }
    // A non-dry build of the Runtime without the backend settings fails loudly, before any download.
    const runtime = build(['--version', VERSION, '--packages', 'runtime', '--worktree', '--out', join(keyRoot, 'b'), '--cache', join(keyRoot, 'c')], NO_AUTH);
    assert.notEqual(runtime.status, 0);
    assert.match(runtime.stderr, /needs the sign-in backend.*CONVAI_AUTH_URL.*CONVAI_AUTH_CLIENT_SECRET/);
    // ...while a Scripts-only real build needs no backend, and a dry-run Runtime build would too (it may omit them).
    assert.equal(existsSync(join(keyRoot, 'c')), false, 'nothing was downloaded');
  } finally { await rm(keyRoot, {recursive: true, force: true}); }
});

test('a bad version, an unknown package or an unknown model source is refused before anything is written', async () => {
  const refuseRoot = await mkdtemp(join(tmpdir(), 'scripts-package-refuse-'));
  try {
    const usage = build(['--packages', 'scripts', '--worktree', '--out', join(refuseRoot, 'a')]);
    assert.equal(usage.status, 2, 'no --version: usage');
    assert.match(usage.stderr, /Usage: node packaging\/build-release\.mjs/);
    const wrong = build(['--version', 'v0.2', '--packages', 'scripts', '--worktree', '--out', join(refuseRoot, 'b')]);
    assert.equal(wrong.status, 2, 'the version has no v prefix');
    const unknown = build(['--version', VERSION, '--dry-run', '--packages', 'scripts,bogus', '--worktree', '--out', join(refuseRoot, 'c')]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Unknown package: bogus/);
    const models = build(['--version', VERSION, '--dry-run', '--packages', 'scripts', '--models', 'cloud', '--worktree', '--out', join(refuseRoot, 'd')]);
    assert.notEqual(models.status, 0);
    assert.match(models.stderr, /--models must be local or hf/);
    assert.deepEqual(await readdir(refuseRoot), [], 'no output folder was created by a refused run');
  } finally { await rm(refuseRoot, {recursive: true, force: true}); }
});

test('a rebuild into the same output folder replaces the packages: a stale zip or file list is never left to be uploaded', async () => {
  const again = await mkdtemp(join(tmpdir(), 'scripts-package-rebuild-'));
  try {
    const args = buildArgs(join(again, 'out'), join(again, 'cache'));
    assert.equal(build(args).status, 0);
    const packagesDir = join(again, 'out/packages');
    await writeFile(join(packagesDir, 'AI-NPC-Cyberpunk-Mod-Scripts-0.0.0.zip'), 'stale');
    await writeFile(join(packagesDir, 'SHA256SUMS.txt'), 'stale'); // an old build's checksum file is cleared too
    assert.equal(build(args).status, 0);
    assert.deepEqual((await readdir(packagesDir)).sort(), [`${config.product}-Scripts-${VERSION}.files.json`, ZIP_NAME, 'release-manifest.json'].sort());
  } finally { await rm(again, {recursive: true, force: true}); }
});

test('building the same commit twice gives the same zip, and the commit it records is the one asked for', async (t) => {
  const git = spawnSync('git', ['-C', project, 'rev-parse', 'HEAD'], {encoding: 'utf8'});
  if (git.status !== 0) return t.skip('not a git checkout');
  const twice = await mkdtemp(join(tmpdir(), 'scripts-package-twice-'));
  try {
    const sums = [];
    for (const name of ['one', 'two']) {
      const run = build(['--version', VERSION, '--dry-run', '--packages', 'scripts', '--out', join(twice, name), '--cache', join(twice, 'cache')]);
      assert.equal(run.status, 0, run.stderr);
      sums.push(await sha256File(join(twice, name, 'packages', ZIP_NAME)));
      const unpacked = join(twice, `x-${name}`); await mkdir(unpacked);
      assert.equal(spawnSync(tar, ['-xf', join(twice, name, 'packages', ZIP_NAME), '-C', unpacked]).status, 0);
      const release = JSON.parse(await readFile(join(unpacked, ...MOD.split('/'), 'release.json'), 'utf8'));
      assert.equal(release.commit, git.stdout.trim());
      // A build from a commit leaves no copy of the source tree behind.
      assert.deepEqual((await readdir(join(twice, name))).sort(), ['packages']);
    }
    assert.equal(sums[0], sums[1], 'the same inputs make the same bytes');
  } finally { await rm(twice, {recursive: true, force: true}); }
});
