// The Scripts package (the Nexus Mods download), built for real by packaging/build-release.mjs and checked against what
// docs/PACKAGING.md promises: text only, the CET mod folder with every shipped Lua file and locale, the redscript, the four catalogs,
// the one static note in runtime/ (no file the game rewrites ships: Vortex), README, licence, release.json and the install note. The Scripts build needs no
// download, model or secret and takes about two seconds, so the test runs the real builder (a dry run of only this package).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {listZip} from './lib/zip.mjs';
import {sha256File, walk} from './lib/files.mjs';
import {RUNTIME_FOLDER_NOTE, loadRuntimeExchange} from './lib/runtime-exchange.mjs';

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
// From 0.3.4 the Scripts carry the code (docs/PACKAGING.md, "Code in the Scripts"): the launcher and the native plugin are compiled by the build. These
// layout tests give a stand-in launcher and leave the native plugin and the picture helper out, so they need no compiler.
const CODE = 'red4ext/plugins/AiNpcCyberpunkCode';
const FAKE_LAUNCHER = join(tmpdir(), `scripts-layout-launcher-${process.pid}.dll`);
const CODE_ARGS = ['--launcher', FAKE_LAUNCHER, '--no-native', '--no-vision'];
const buildArgs = (out, cache, extra = []) => ['--version', VERSION, '--dry-run', '--packages', 'scripts', '--worktree', '--out', out, '--cache', cache, ...CODE_ARGS, ...extra];

let root, out, packages, zipPath, entries, extracted, built;
const names = () => entries.map(entry => entry.name);
const under = prefix => names().filter(name => name.startsWith(prefix));
const text = async rel => readFile(join(extracted, ...rel.split('/')), 'utf8');

before(async () => {
  await writeFile(FAKE_LAUNCHER, 'stand-in launcher');
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
after(async () => { if (root) await rm(root, {recursive: true, force: true}); await rm(FAKE_LAUNCHER, {force: true}); });

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

test('every entry sits in the CET mod folder, the redscript folder, the code folder or is the install note, and every path fits a typical game folder', () => {
  const stray = names().filter(name => name !== INSTALL_NOTE && !name.startsWith(`${MOD}/`) && !name.startsWith('r6/scripts/CyberpunkConvai/') && !name.startsWith(`${CODE}/`));
  assert.deepEqual(stray, []);
  const limit = config.layout.maxPathLength - config.layout.maxGameRootLength - 1;
  assert.deepEqual(names().filter(name => name.length > limit), []);
  assert.deepEqual(names().filter(name => /[\\]|^\/|(?:^|\/)\.\.?(?:\/|$)|[:*?"<>|]/.test(name)), [], 'plain relative forward-slashed names');
  assert.equal(new Set(names().map(name => name.toLowerCase())).size, names().length, 'no two names differ only by case (Windows would merge them)');
});

test('outside the code folder the package is text only: no binary, no archive, no executable, no model', () => {
  const unexpected = names().filter(name => !name.startsWith(`${CODE}/`) && !/\.(?:lua|reds|json|txt|log|ndjson)$/.test(name));
  assert.deepEqual(unexpected, []);
  assert.deepEqual(entries.filter(entry => !entry.name.startsWith(`${CODE}/`) && entry.method !== 8 && entry.uncompressed > 0), [], 'text is deflated, never stored');
});

test('the code folder holds the launcher, install-code.mjs and one complete copy of the code, listed in code.json with sizes and hashes', async () => {
  const manifest = JSON.parse(await text(`${CODE}/code.json`));
  assert.equal(manifest.version, 1); assert.equal(manifest.package, 'scripts-code'); assert.equal(manifest.release, VERSION);
  assert.equal(manifest.runtimeBase, config.runtimeBase.required); assert.equal(manifest.game, '2.5');
  assert.equal(await text(`${CODE}/install-code.mjs`), await readFile(resolve(project, 'packaging/runtime/install-code.mjs'), 'utf8'));
  assert.equal(await text(`${CODE}/CyberpunkConvai.dll`), 'stand-in launcher');
  const listed = new Set(manifest.files.map(row => `${CODE}/app/${row.path}`));
  assert.deepEqual(under(`${CODE}/app/`).filter(name => !listed.has(name)), [], 'every file in app/ is listed');
  for (const row of manifest.files) {
    const bytes = await readFile(join(extracted, ...`${CODE}/app/${row.path}`.split('/')));
    assert.equal(bytes.length, row.size, row.path); assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256, row.path);
  }
  for (const rel of ['bridge/convai-bridge.mjs', 'bridge/bridge-supervisor.mjs', 'launcher/start-service.mjs', 'launcher/usvfs-compat.mjs', 'assets/realtime-client.js',
    'characters/roster.json', 'defaults/characters.json', 'defaults/runtime-code-files.json', 'package.json']) assert(listed.has(`${CODE}/app/${rel}`), rel);
  // Nothing of the Runtime base: no Node, Python, models, voices, engine, sign-in settings or voice lists.
  assert.deepEqual(names().filter(name => /\/(?:node|python|models|llama-cpp|vgmstream|node_modules|pocket-tts)\/|convai-auth\.json$|pocket-voices|local-voices|\/voices\//.test(name)), []);
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

test('runtime/ holds one static note and no file that the game or the service rewrites (Vortex reports every installed file that changes)', async () => {
  const runtime = under(`${MOD}/runtime/`).map(name => name.slice(`${MOD}/runtime/`.length));
  assert.deepEqual(runtime, ['README.txt'], 'the folder exists for the first write of the Lua, and nothing else in it is shipped');
  assert.equal(await text(`${MOD}/runtime/README.txt`), RUNTIME_FOLDER_NOTE);
  const classified = new Set([...exchange.exchange, ...exchange.state, ...exchange.optional, ...exchange.elsewhere]);
  assert.ok(!classified.has('README.txt'), 'the folder note is static: it must not be a name the mod writes');
  // No file of any class, no temp, backup or lock file, and no empty file anywhere (an empty file in a package is a placeholder for a rewritten one).
  assert.deepEqual(runtime.filter(name => classified.has(name) || /\.(?:tmp|bak|previous|lock|pid|corrupt)$/i.test(name)), []);
  assert.deepEqual(entries.filter(entry => entry.uncompressed === 0).map(entry => entry.name), [], 'an empty file is a placeholder for a file that is rewritten while playing');
  assert.deepEqual(entries.filter(entry => /launcher\.log$/i.test(entry.name)).map(entry => entry.name), []);
});

test("the player's own state and secrets never ship: no settings, key, memory, chat history or session file anywhere in the zip", () => {
  // The data and secret files by their real names (bridge/convai-key.mjs, mistral-key.mjs, player-memory.mjs, ...):
  // the "*-key-command.json" and "*-state.json" files are exchange files and ship in no package.
  const FORBIDDEN = /(?:^|\/)(?:settings\.json|convai-key\.txt|player-(?:convai|mistral|inworld|voxtral)-key\.txt|[a-z-]*-key\.txt|service\.txt|kaggle-access-token\.txt|huggingface-[^/]*\.txt|\.env|(?:player|vendor)-memory[^/]*\.(?:json|bak|tmp|corrupt)|phone-sessions\.json|phone-history\.json|characters-verified\.json|addon-settings\.json|witness-receipts\.json|decision-ledger\.json)$/i;
  assert.deepEqual(names().filter(name => FORBIDDEN.test(name)), []);
  assert.deepEqual(names().filter(name => /^misc\//.test(name) || /CyberpunkConvaiLauncher/i.test(name)), []);
});

test('release.json, README.txt and LICENSE.txt are written from the build and the repository', async () => {
  const release = JSON.parse(await text(`${MOD}/release.json`));
  assert.deepEqual(release, {product: config.product, package: 'scripts', version: VERSION, game: '2.5', commit: 'worktree', runtimeBase: config.runtimeBase.required});
  assert.equal(await text(`${MOD}/README.txt`), await readFile(resolve(project, 'packaging/PLAYER_README.md'), 'utf8'));
  assert.equal(await text(`${MOD}/LICENSE.txt`), await readFile(resolve(project, 'LICENSE'), 'utf8'));
});

test('the install note is the first thing in the zip root and tells the player to extract into the game folder', async () => {
  const note = await text(INSTALL_NOTE);
  assert.match(note, /Extract this zip INTO your Cyberpunk 2077 folder/);
  assert.match(note, /bin, archive and r6/);
  assert.match(note, /Do not extract it into a new folder named after the zip/);
  // What the note promises about the zip is true of this zip: it starts with the game's own folders (bin, r6 and, from 0.3.4, red4ext for the code folder).
  const roots = new Set(names().filter(name => name !== INSTALL_NOTE).map(name => name.split('/')[0]));
  assert.deepEqual([...roots].sort(), ['bin', 'r6', 'red4ext']);
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
      const run = build(['--version', VERSION, '--dry-run', '--packages', 'scripts', '--out', join(twice, name), '--cache', join(twice, 'cache'), ...CODE_ARGS]);
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

// One source tree, one build per game (docs/GAME_VERSIONS.md): game 2.5 is the default build, laid over the source tree (which is the 2.31 one) with
// the files of packaging/game-variants/2.5/ (only GameVariant.reds). The 2.31 Scripts differ from the 2.5 ones in the file name (-for-2.31), release.json's
// game field and that one file (the source tree's own), and in nothing else.
test('the 2.31 build: suffixed file name, game 2.31 in release.json, only GameVariant.reds differs, the same files otherwise', async () => {
  const out231 = join(root, 'out231');
  const result = build(buildArgs(out231, join(root, 'cache231'), ['--game', '2.31']));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const zip231 = join(out231, 'packages', `${config.product}-Scripts-${VERSION}-for-2.31.zip`);
  assert.deepEqual((await readdir(join(out231, 'packages'))).sort(), [`${config.product}-Scripts-${VERSION}-for-2.31.files.json`, `${config.product}-Scripts-${VERSION}-for-2.31.zip`, 'release-manifest.json'].sort());
  const entries231 = await listZip(zip231);
  assert.deepEqual(entries231.map(entry => entry.name).sort(), names().sort(), 'the same files in both builds');
  const dir231 = join(root, 'extracted231');
  await mkdir(dir231);
  assert.equal(spawnSync(tar, ['-xf', zip231, '-C', dir231], {encoding: 'utf8'}).status, 0);
  assert.deepEqual(JSON.parse(await readFile(join(dir231, ...`${MOD}/release.json`.split('/')), 'utf8')), {product: config.product, package: 'scripts', version: VERSION, game: '2.31', commit: 'worktree', runtimeBase: config.runtimeBase.required});
  const differing = [];
  for (const rel of names()) {
    const a = await readFile(join(extracted, ...rel.split('/')));
    const b = await readFile(join(dir231, ...rel.split('/')));
    if (!a.equals(b)) differing.push(rel);
  }
  // The code is the same for both games; its list names the game (and a real build carries each game's own native plugin, left out here).
  assert.deepEqual(differing, [`${MOD}/release.json`, 'r6/scripts/CyberpunkConvai/GameVariant.reds', `${CODE}/code.json`].sort((a, b) => names().indexOf(a) - names().indexOf(b)));
  // The 2.5 file (the default build) is the overlay's, the 2.31 file is the one in the source tree, and the callers name only the two helpers.
  const variant = await text('r6/scripts/CyberpunkConvai/GameVariant.reds');
  assert.equal(variant, await readFile(resolve(project, 'packaging/game-variants/2.5/r6/scripts/CyberpunkConvai/GameVariant.reds'), 'utf8'));
  assert.match(variant, /return InputTarget\.Key\(key\);/);
  const older = await readFile(join(dir231, 'r6', 'scripts', 'CyberpunkConvai', 'GameVariant.reds'), 'utf8');
  assert.equal(older, await readFile(resolve(project, 'r6/scripts/CyberpunkConvai/GameVariant.reds'), 'utf8'));
  assert.match(older, /return InputTarget\.Key\(key, action\);/);
  for (const rel of names().filter(name => name.endsWith('.reds') && !name.endsWith('GameVariant.reds'))) {
    assert.doesNotMatch(await text(rel), /GameInstance\.(?:GetCallbackSystem|GetScriptableServiceContainer)\(|InputTarget\.Key\(/, `${rel} calls an engine function that GameVariant.reds owns`);
  }
});

test('an unknown game is refused, and the packs that are the same for every game are not built with a game', () => {
  const unknown = build(buildArgs(join(root, 'outx'), join(root, 'cachex'), ['--game', '9.9']));
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /--game must be one of 2\.31, 2\.5, not 9\.9/);
  const shared = build(['--version', VERSION, '--dry-run', '--packages', 'omni', '--game', '2.31', '--worktree', '--out', join(root, 'outy'), '--cache', join(root, 'cachey')]);
  assert.notEqual(shared.status, 0);
  assert.match(shared.stderr, /same for every game version/);
});
