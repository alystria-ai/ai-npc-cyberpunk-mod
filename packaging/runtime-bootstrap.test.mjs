import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm, stat, copyFile, symlink, readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {build} from 'esbuild';
import {ADAPTER_REVISION, BRIDGE_MODULES, bridgeEnvironment, CLIENT_ASSETS, inspectSetup, MOD_DIRECTORY,
  NODE_PACKAGE_ENTRIES, OMNI_REVISION, packageFile, packagePath,
  readJson, resolveRuntimeLayout, validateManifest, verifyManifestFiles} from './runtime-layout.mjs';
import {atomicJson, recoverService, requestStop, serviceStatus, superviseRuntime} from './runtime-bootstrap.mjs';

const prefix = 'cyberpunk-runtime-bootstrap-';
const source = fileURLToPath(new URL('.', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const modules = ['Runtime-Service.mjs', 'runtime-layout.mjs', 'runtime-bootstrap.mjs'];
const bridgeFixture = `
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const state = process.env.CYBERPUNK_CONVAI_STATE;
await new Promise(done => setTimeout(done, Number(process.env.FIXTURE_IMPORT_DELAY_MS || 0)));
const control = resolve(state, 'bridge-control.json');
let observed = await readFile(control, 'utf8').catch(() => '');
console.log('[CyberpunkConvai] Convai conversation bridge ready');
let polling = false;
const timer = setInterval(async () => {
  if (polling) return; polling = true;
  try {
    const raw = await readFile(control, 'utf8').catch(() => '');
    if (raw !== observed) {
      observed = raw; let message; try { message = JSON.parse(raw); } catch {}
      if (message?.action === 'shutdown' && message.pid === process.pid) {
        clearInterval(timer);
        await writeFile(resolve(state, 'fixture-graceful-stop.json'), JSON.stringify({pid: process.pid}));
        setTimeout(() => process.exit(0), 75);
      }
    }
  } finally { polling = false; }
}, 20);
`;

async function until(read, accepts, timeout = 6000) {
  const end = Date.now() + timeout; let latest;
  while (Date.now() < end) {
    try { latest = await read(); } catch { latest = null; }
    if (accepts(latest)) return latest;
    await sleep(20);
  }
  assert.fail(`Runtime fixture timed out: ${JSON.stringify(latest)}`);
}

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), prefix)), game = join(folder, 'Game 日本 with spaces');
  const app = join(game, ...MOD_DIRECTORY.split('/'), 'app'), state = join(dirname(app), 'data');
  await mkdir(join(game, 'bin/x64'), {recursive: true});
  await writeFile(join(game, 'bin/x64/Cyberpunk2077.exe'), 'fixture only; never executed');
  await mkdir(join(app, 'bridge'), {recursive: true});
  await mkdir(state, {recursive: true});
  await writeFile(join(app, 'bridge/convai-bridge.mjs'), bridgeFixture);
  await writeFile(join(state, 'convai-key.txt'), 'api-key=isolated-test-token-not-a-real-credential\n');
  await atomicJson(join(state, 'characters.json'), {'johnny-silverhand': 'isolated-character-id'});
  await atomicJson(join(state, 'player-memory.json'), {endUserId: 'fixture-existing-player', sentinel: true});
  await atomicJson(join(state, 'phone-history.json'), {messages: ['fixture-existing-history']});
  await atomicJson(join(state, 'local-voices.json'), {});
  const layout = await resolveRuntimeLayout({developmentProject: app, gameDirectory: game, stateDirectory: state});
  return {folder, game, app, state, layout};
}

async function cleanup(fix) {
  // Delete only this test's absolute, named mkdtemp workspace.
  assert(resolve(fix.folder).startsWith(resolve(tmpdir(), prefix)));
  await rm(fix.folder, {recursive: true, force: true});
}

async function stageManifest(fix) {
  const fixed = [...BRIDGE_MODULES.filter(path => path !== 'bridge/convai-bridge.mjs'),
    ...NODE_PACKAGE_ENTRIES, 'node/node.exe', 'python/python.exe', 'browser/chrome.exe',
    'bridge/resident-voice-worker.py', 'bridge/voice-cuda-graph.py',
    'python/Lib/site-packages/omnivoice/__init__.py',
    'python/Lib/site-packages/omnivoice/models/omnivoice.py',
    'voice/voicestudio/backend/services/tts_backend.py', 'tools/rhubarb/rhubarb.exe',
    'characters/roster.json', 'characters/world-knowledge.json', 'characters/phone-contacts.json',
    'models/omnivoice/model.safetensors', 'models/omnivoice/config.json',
    'models/omnivoice/tokenizer.json', 'models/omnivoice/tokenizer_config.json',
    'models/omnivoice/chat_template.jinja', 'models/omnivoice/audio_tokenizer/model.safetensors',
    'models/omnivoice/audio_tokenizer/config.json', 'models/omnivoice/audio_tokenizer/preprocessor_config.json',
    'research/cyberpunk/generated/quest-catalog.json', ...CLIENT_ASSETS.map(name => `assets/${name}`)];
  for (const path of fixed) {
    await mkdir(dirname(join(fix.app, path)), {recursive: true});
    await writeFile(join(fix.app, path), `isolated non-executable fixture ${path}`);
  }
  await mkdir(join(fix.app, 'bootstrap'), {recursive: true});
  for (const module of modules) await copyFile(join(source, module), join(fix.app, 'bootstrap', module));
  await copyFile(join(source, 'Start-Runtime.ps1'), join(fix.app, 'Start-Runtime.ps1'));
  const paths = ['bridge/convai-bridge.mjs', 'Start-Runtime.ps1', ...fixed, ...modules.map(name => `bootstrap/${name}`)];
  const files = [];
  for (const path of paths) {
    const bytes = await readFile(join(fix.app, path));
    files.push({path, bytes: bytes.length, sha256: hash(bytes)});
  }
  const manifest = {schema: 1, runtimeVersion: 'fixture-1', scriptsVersion: 'fixture-1',
    bridgeEntry: 'bridge/convai-bridge.mjs', bootstrapEntry: 'bootstrap/Runtime-Service.mjs',
    clientAssetsDirectory: 'assets', executables: {
      node: {path: 'node/node.exe'}, python: {path: 'python/python.exe'}, browser: {path: 'browser/chrome.exe'},
    }, localVoice: {engine: 'omnivoice', revision: OMNI_REVISION, adapterRevision: ADAPTER_REVISION,
      modelDirectory: 'models/omnivoice', adapterDirectory: 'voice/voicestudio/backend'},
    tools: {rhubarb: {path: 'tools/rhubarb/rhubarb.exe', version: '1.14.0'}}, files};
  await atomicJson(join(fix.app, 'runtime-manifest.json'), manifest);
  return manifest;
}

test('the explicit bridge allowlist covers the real production import closure and its only external package', async () => {
  const result = await build({absWorkingDir: resolve(source, '..'),
    entryPoints: ['bridge/convai-bridge.mjs'], bundle: true, write: false,
    platform: 'node', format: 'esm', packages: 'external', metafile: true, logLevel: 'silent'});
  assert.deepEqual(Object.keys(result.metafile.inputs).sort(), [...BRIDGE_MODULES]);
  const packages = [...new Set(Object.values(result.metafile.inputs)
    .flatMap(file => file.imports.filter(entry => entry.external && !entry.path.startsWith('node:'))
      .map(entry => entry.path)))].sort();
  assert.deepEqual(packages, ['playwright']);
  for (const name of ['playwright', 'playwright-core']) {
    const info = JSON.parse(await readFile(resolve(source, '..', 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(info.version, '1.58.2', name);
    for (const file of NODE_PACKAGE_ENTRIES.filter(path => path.startsWith(`node_modules/${name}/`)))
      assert((await stat(resolve(source, '..', file))).isFile(), file);
  }
});

test('a prepared manifest cannot omit an imported bridge module, package entry point or player launcher', async () => {
  const fix = await fixture();
  try {
    const manifest = await stageManifest(fix);
    assert(validateManifest(manifest).fileMap.has('bridge/player-memory.mjs'));
    for (const required of [...BRIDGE_MODULES, ...NODE_PACKAGE_ENTRIES, 'Start-Runtime.ps1']) {
      assert.throws(() => validateManifest({...manifest,
        files: manifest.files.filter(file => file.path !== required)}),
      {code: 'invalid-manifest'}, required);
    }
  } finally { await cleanup(fix); }
});

test('installed root discovery and overrides survive a relocated path with spaces and Japanese text', async () => {
  const fix = await fixture();
  try {
    await stageManifest(fix);
    const layout = await resolveRuntimeLayout({appDirectory: fix.app});
    assert.equal(layout.gameRoot, fix.game); assert.equal(layout.stateRoot, fix.state);
    assert.equal(layout.entry, join(fix.app, 'bridge/convai-bridge.mjs'));
    assert.equal(layout.nodeExecutable, join(fix.app, 'node/node.exe'));
    assert.equal(layout.env.CYBERPUNK_CONVAI_PYTHON, join(fix.app, 'python/python.exe'));
    assert.equal(layout.env.CYBERPUNK_CONVAI_BROWSER, join(fix.app, 'browser/chrome.exe'));
    assert.equal(layout.env.CYBERPUNK_CONVAI_CLIENT_ASSETS, join(fix.app, 'assets'));
    assert.equal(layout.env.CYBERPUNK_CONVAI_OMNI_MODEL, join(fix.app, 'models/omnivoice'));
    assert.equal(layout.env.CYBERPUNK_CONVAI_OMNI_ADAPTER, join(fix.app, 'voice/voicestudio/backend'));
    assert.equal(layout.env.CYBERPUNK_CONVAI_OMNI_REFERENCES, join(fix.state, 'voice-references'));
    assert.equal(layout.env.CYBERPUNK_CONVAI_OMNI_CACHE, join(fix.state, 'voice-studio-data'));
    assert.equal(layout.env.CYBERPUNK_CONVAI_RHUBARB, join(fix.app, 'tools/rhubarb/rhubarb.exe'));
    assert.equal(layout.env.CYBERPUNK_CONVAI_LIPSYNC_WORK, join(fix.state, 'lipsync-work'));
    assert.equal(layout.env.CYBERPUNK_CONVAI_STATE, fix.state);
    await verifyManifestFiles(layout.appRoot, layout.manifest);
    await assert.rejects(resolveRuntimeLayout({appDirectory: fix.app, gameDirectory: fix.game}), {code: 'invalid-installation'});
  } finally { await cleanup(fix); }
});

test('package paths reject traversal, absolute drives, backslashes and private/default player data', async () => {
  const fix = await fixture();
  try {
    for (const path of ['../elsewhere', '/absolute', 'C:/absolute', 'data\\key.txt', 'nested/../x', 'a//b', './a', 'a/'])
      assert.throws(() => packagePath(fix.app, path), {code: 'invalid-manifest'});
    const manifest = await stageManifest(fix);
    for (const path of ['data/characters.json', 'runtime/convai-key.txt', 'logs/private.log',
      'nested/player-memory.json', 'nested/.env.private', 'private/api.key',
      'assets/characters.json', 'characters/relationship-profiles.json', 'voice/local-voices.json',
      'bootstrap/script.lua', 'voices/Johnny.wav']) {
      assert.throws(() => validateManifest({...manifest, files: [...manifest.files,
        {path, bytes: 0, sha256: hash('')}]}), {code: 'invalid-manifest'});
    }
    const duplicate = {...manifest.files[0], path: manifest.files[0].path.toUpperCase()};
    assert.throws(() => validateManifest({...manifest, files: [...manifest.files, duplicate]}), {code: 'invalid-manifest'});
    assert.throws(() => validateManifest({...manifest, files: manifest.files.filter(file => !file.path.endsWith('quest-catalog.json'))}), {code: 'invalid-manifest'});
  } finally { await cleanup(fix); }
});

test('file integrity fails before child launch and rejects a junction outside app', async () => {
  const fix = await fixture();
  try {
    await stageManifest(fix);
    const layout = await resolveRuntimeLayout({appDirectory: fix.app});
    await writeFile(join(fix.app, 'assets/realtime-client.js'), 'tampered');
    let launches = 0;
    await assert.rejects(superviseRuntime(layout, {watchGame: false,
      spawnImpl: () => { launches++; throw Error('must not launch'); }}), {code: 'runtime-integrity'});
    assert.equal(launches, 0);
    const outside = join(fix.folder, 'outside'); await mkdir(outside);
    await writeFile(join(outside, 'outside.txt'), 'private outside marker');
    await symlink(outside, join(fix.app, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(packageFile(fix.app, 'linked/outside.txt'), {code: 'invalid-manifest'});
    assert.equal(await readFile(join(outside, 'outside.txt'), 'utf8'), 'private outside marker');
  } finally { await cleanup(fix); }
});

test('setup returns field names without creating player IDs, profiles, workers or changing existing history', async () => {
  const fix = await fixture();
  try {
    await rm(join(fix.state, 'convai-key.txt'));
    await rm(join(fix.state, 'characters.json'));
    const before = await readFile(join(fix.state, 'player-memory.json'));
    const history = await readFile(join(fix.state, 'phone-history.json'));
    let launches = 0;
    const result = await superviseRuntime(fix.layout, {watchGame: false,
      spawnImpl: () => { launches++; throw Error('must not launch'); }});
    assert.deepEqual(result, {state: 'setup-required', setup: ['convai-key', 'character-profiles']});
    assert.equal(launches, 0);
    assert.deepEqual(await readFile(join(fix.state, 'player-memory.json')), before);
    assert.deepEqual(await readFile(join(fix.state, 'phone-history.json')), history);
    assert.equal((await serviceStatus(fix.layout)).state, 'setup-required');
    await assert.rejects(stat(fix.layout.leasePath), {code: 'ENOENT'});
    await assert.rejects(stat(join(fix.state, 'characters.json')), {code: 'ENOENT'});
  } finally { await cleanup(fix); }
});

test('portable voice configuration is preserved while package paths arrive separately', async () => {
  const fix = await fixture();
  try {
    await stageManifest(fix);
    const layout = await resolveRuntimeLayout({appDirectory: fix.app});
    await atomicJson(join(fix.state, 'local-voices.json'), {provider: 'hybrid', voices: {'johnny-silverhand': {status: 'ready'}}});
    const before = await readFile(join(fix.state, 'local-voices.json'));
    assert.deepEqual(await inspectSetup(layout), []);
    assert.deepEqual(await inspectSetup(fix.layout), []);
    assert.deepEqual(await readFile(join(fix.state, 'local-voices.json')), before);
    await atomicJson(join(fix.state, 'local-voices.json'), ['invalid-config-shape']);
    await assert.rejects(inspectSetup(layout), {code: 'invalid-configuration'});
  } finally { await cleanup(fix); }
});

test('an owner-addressed stop while Checking prevents every bridge/browser/model child launch', async () => {
  const fix = await fixture();
  try {
    await stageManifest(fix);
    const layout = await resolveRuntimeLayout({appDirectory: fix.app});
    const before = await readFile(join(fix.state, 'player-memory.json'));
    const history = await readFile(join(fix.state, 'phone-history.json'));
    let stop, launches = 0;
    const result = await superviseRuntime(layout, {watchGame: false,
      onStatus: value => { if (value.state === 'checking') stop = requestStop(layout); },
      spawnImpl: () => { launches++; throw Error('Checking stop must not launch a child'); }});
    await stop;
    assert.deepEqual(result, {state: 'stopped'}); assert.equal(launches, 0);
    assert.equal((await serviceStatus(layout)).state, 'stopped');
    await assert.rejects(stat(layout.leasePath), {code: 'ENOENT'});
    await assert.rejects(stat(join(fix.state, 'fixture-graceful-stop.json')), {code: 'ENOENT'});
    assert.deepEqual(await readFile(join(fix.state, 'player-memory.json')), before);
    assert.deepEqual(await readFile(join(fix.state, 'phone-history.json')), history);
  } finally { await cleanup(fix); }
});

test('a stop arriving after setup/game inspection is checked immediately before bridge spawn', async () => {
  const fix = await fixture();
  try {
    let launches = 0;
    const result = await superviseRuntime(fix.layout, {
      identifyGame: async () => {
        assert.equal((await requestStop(fix.layout)).state, 'stopping');
        return '12345-56789';
      },
      spawnImpl: () => { launches++; throw Error('Prepared stop must not launch a child'); },
    });
    assert.deepEqual(result, {state: 'stopped'}); assert.equal(launches, 0);
    await assert.rejects(stat(fix.layout.leasePath), {code: 'ENOENT'});
  } finally { await cleanup(fix); }
});

test('streamed manifest hashing honors a cancellation checkpoint inside a file', async () => {
  const fix = await fixture();
  try {
    const manifest = validateManifest(await stageManifest(fix));
    let streamCheck = false;
    await assert.rejects(verifyManifestFiles(fix.app, manifest, {
      checkpoint: async force => {
        if (!force) {
          streamCheck = true;
          throw Object.assign(Error('fixture cancellation'), {code: 'fixture-cancelled'});
        }
      },
    }), {code: 'fixture-cancelled'});
    assert.equal(streamCheck, true);
    // The interrupted iterator releases its owned read stream without touching
    // the fixture contents or entering any child process path.
    assert.equal(await readFile(join(fix.app, 'bridge/convai-bridge.mjs'), 'utf8'), bridgeFixture);
  } finally { await cleanup(fix); }
});

test('launch environment removes import hooks and preserves explicit application overrides', async () => {
  const fix = await fixture();
  try {
    await stageManifest(fix);
    const layout = await resolveRuntimeLayout({appDirectory: fix.app});
    const env = bridgeEnvironment(layout, {NODE_OPTIONS: '--import private-import.mjs', NODE_PATH: 'private-modules',
      PYTHONHOME: 'private-python', PYTHONPATH: 'private-python-path', CYBERPUNK_CONVAI_PYTHON: 'other-python',
      PATH: 'ordinary-system-path', FIXTURE_FLAG: 'present'});
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'PYTHONHOME', 'PYTHONPATH']) assert.equal(env[key], undefined);
    assert.equal(env.CYBERPUNK_CONVAI_PYTHON, layout.env.CYBERPUNK_CONVAI_PYTHON);
    assert.equal(env.PATH, 'ordinary-system-path'); assert.equal(env.FIXTURE_FLAG, 'present');
  } finally { await cleanup(fix); }
});

test('real hidden fixture child reaches readiness, ignores a foreign stop and drains the exact owned stop',
  {timeout: 15000}, async () => {
    const fix = await fixture(), controller = new AbortController(); let run, child;
    try {
      const before = await readFile(join(fix.state, 'player-memory.json'));
      const config = await readFile(join(fix.state, 'local-voices.json'));
      const history = await readFile(join(fix.state, 'phone-history.json'));
      run = superviseRuntime(fix.layout, {watchGame: false, pollMs: 25, signal: controller.signal,
        spawnImpl: (executable, args, options) => {
          assert.equal(executable, process.execPath); assert.equal(options.windowsHide, true);
          assert.equal(options.shell, false); assert.deepEqual(args, [fix.layout.entry]);
          assert.equal(options.env.CYBERPUNK_CONVAI_GAME, fix.game);
          child = spawn(executable, args, options); return child;
        }});
      await until(() => serviceStatus(fix.layout), status => status?.state === 'ready');
      const owner = await readJson(fix.layout.leasePath);
      assert.equal(owner.bridgePid, child.pid);
      await atomicJson(fix.layout.serviceControlPath, {schema: 1, action: 'stop', owner: randomUUID(), nonce: randomUUID()});
      await sleep(100); assert.equal((await serviceStatus(fix.layout)).state, 'ready');
      await assert.rejects(superviseRuntime(fix.layout, {watchGame: false}), {code: 'service-already-owned'});
      await requestStop(fix.layout);
      assert.deepEqual(await run, {state: 'stopped'});
      const stopped = await readJson(join(fix.state, 'fixture-graceful-stop.json'));
      assert.equal(stopped.pid, child.pid);
      assert.deepEqual(await readFile(join(fix.state, 'player-memory.json')), before);
      assert.deepEqual(await readFile(join(fix.state, 'local-voices.json')), config);
      assert.deepEqual(await readFile(join(fix.state, 'phone-history.json')), history);
      await assert.rejects(stat(fix.layout.leasePath), {code: 'ENOENT'});
    } finally {
      controller.abort(); if (run) await Promise.race([run.catch(() => {}), sleep(4000)]);
      if (child && child.exitCode === null) child.kill();
      await cleanup(fix);
    }
  });

test('concurrent service launchers admit only one bridge child', {timeout: 15000}, async () => {
  const fix = await fixture(), controller = new AbortController(); let launches = 0;
  try {
    const options = {watchGame: false, pollMs: 25, signal: controller.signal,
      onStatus: value => { if (value.state === 'ready') setTimeout(() => controller.abort(), 50); },
      spawnImpl: (...args) => { launches++; return spawn(...args); }};
    const results = await Promise.allSettled([superviseRuntime(fix.layout, options), superviseRuntime(fix.layout, options)]);
    assert.equal(launches, 1); assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'service-already-owned');
    assert.equal((await serviceStatus(fix.layout)).state, 'stopped');
  } finally { controller.abort(); await cleanup(fix); }
});

test('a stop during imports is retried after the bridge initial control snapshot', {timeout: 15000}, async () => {
  const fix = await fixture(), controller = new AbortController(); let child, run;
  try {
    run = superviseRuntime(fix.layout, {watchGame: false, pollMs: 25, signal: controller.signal,
      spawnImpl: (exe, args, options) => {
        child = spawn(exe, args, {...options, env: {...options.env, FIXTURE_IMPORT_DELAY_MS: '250'}}); return child;
      }});
    await until(() => readJson(fix.layout.leasePath), owner => Number.isSafeInteger(owner?.bridgePid));
    await requestStop(fix.layout);
    assert.deepEqual(await run, {state: 'stopped'});
    assert.equal((await readJson(join(fix.state, 'fixture-graceful-stop.json'))).pid, child.pid);
  } finally {
    controller.abort(); if (run) await Promise.race([run.catch(() => {}), sleep(4000)]);
    if (child && child.exitCode === null) child.kill(); await cleanup(fix);
  }
});

test('a changed game creation-time token gracefully retires this service without transferring it', {timeout: 15000}, async () => {
  const fix = await fixture(), controller = new AbortController(); let token = '12345-56789', run;
  try {
    run = superviseRuntime(fix.layout, {pollMs: 25, signal: controller.signal, identifyGame: async () => token});
    await until(() => serviceStatus(fix.layout), status => status?.state === 'ready');
    const original = await readJson(fix.layout.leasePath); token = '12345-98765';
    assert.deepEqual(await run, {state: 'stopped'});
    assert.equal((await readJson(join(fix.state, 'fixture-graceful-stop.json'))).pid, original.bridgePid);
  } finally { controller.abort(); if (run) await run.catch(() => {}); await cleanup(fix); }
});

test('missing game and an existing fresh live bridge do not launch another process', async () => {
  const fix = await fixture();
  try {
    let launches = 0;
    const options = {spawnImpl: () => { launches++; throw Error(); }, identifyGame: async () => null};
    assert.deepEqual(await superviseRuntime(fix.layout, options), {state: 'game-not-running'});
    assert.equal((await serviceStatus(fix.layout)).state, 'game-not-running');
    await mkdir(fix.layout.gameRuntime, {recursive: true});
    await atomicJson(join(fix.layout.gameRuntime, 'local-voice-state.json'), {bridgePid: process.pid, updated: Date.now()});
    await assert.rejects(superviseRuntime(fix.layout, {...options, watchGame: false}), {code: 'service-conflict'});
    assert.equal(launches, 0);
  } finally { await cleanup(fix); }
});

test('recovery clears only a dead owned record and never touches live/orphaned processes or player state', async () => {
  const fix = await fixture();
  try {
    const before = await readFile(join(fix.state, 'player-memory.json'));
    const dead = {schema: 1, token: randomUUID(), supervisorPid: 456789, bridgePid: 456790, createdAt: Date.now()};
    await atomicJson(fix.layout.leasePath, dead);
    assert.equal((await serviceStatus(fix.layout, {alive: () => false})).state, 'recovery-required');
    assert.deepEqual(await recoverService(fix.layout, {alive: () => false}), {schema: 1, state: 'stopped', recovered: true});
    await atomicJson(fix.layout.leasePath, dead);
    assert.equal((await serviceStatus(fix.layout, {alive: value => value === dead.bridgePid})).state, 'orphaned');
    await assert.rejects(recoverService(fix.layout, {alive: value => value === dead.bridgePid}), {code: 'service-still-alive'});
    assert.deepEqual(await readJson(fix.layout.leasePath), dead);
    await atomicJson(fix.layout.leasePath, {schema: 0, token: 'ambiguous'});
    await assert.rejects(recoverService(fix.layout, {alive: () => false}), {code: 'ownership-unavailable'});
    assert.deepEqual(await readFile(join(fix.state, 'player-memory.json')), before);
  } finally { await cleanup(fix); }
});

test('manifest generator uses a file recipe, produces checked hashes and refuses an installed overwrite', {timeout: 15000}, async () => {
  const fix = await fixture();
  try {
    const sourceManifest = await stageManifest(fix);
    await rm(join(fix.app, 'runtime-manifest.json'));
    const recipe = join(fix.folder, 'recipe.json');
    await atomicJson(recipe, {runtimeVersion: sourceManifest.runtimeVersion, scriptsVersion: sourceManifest.scriptsVersion,
      executables: sourceManifest.executables, localVoice: sourceManifest.localVoice, tools: sourceManifest.tools,
      files: sourceManifest.files.map(file => file.path)});
    const invoke = () => new Promise((done, reject) => {
      const child = spawn(process.execPath, [join(source, 'Create-RuntimeManifest.mjs'), '--app', fix.app, '--recipe', recipe],
        {cwd: fix.folder, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
      let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value; });
      child.stderr.on('data', value => { stderr += value; }); child.on('error', reject);
      child.on('close', code => done({code, stdout, stderr}));
    });
    const first = await invoke(); assert.equal(first.code, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).state, 'manifest-created');
    const made = await readJson(join(fix.app, 'runtime-manifest.json'));
    await verifyManifestFiles(fix.app, validateManifest(made));
    const second = await invoke(); assert.equal(second.code, 1);
    assert.equal(JSON.parse(second.stderr).code, 'manifest-build-failed');
    assert.deepEqual(await readJson(join(fix.app, 'runtime-manifest.json')), made);
  } finally { await cleanup(fix); }
});

test('startup timeout uses graceful owned shutdown and never reports a readiness success', {timeout: 15000}, async () => {
  const fix = await fixture();
  try {
    await writeFile(fix.layout.entry, bridgeFixture.replace("console.log('[CyberpunkConvai] Convai conversation bridge ready');", "console.log('[Fixture] still initializing');"));
    const states = [];
    const result = await superviseRuntime(fix.layout, {watchGame: false, pollMs: 25, startupMs: 100,
      onStatus: value => states.push(value.state)});
    assert.deepEqual(result, {state: 'error', code: 'startup-timeout'});
    assert(!states.includes('ready')); assert.equal(states.at(-1), 'error');
    assert.equal((await serviceStatus(fix.layout)).code, 'startup-timeout');
    assert(Number.isSafeInteger((await readJson(join(fix.state, 'fixture-graceful-stop.json')))?.pid));
  } finally { await cleanup(fix); }
});

test('a clean child exit before readiness is a startup error', async () => {
  const fix = await fixture();
  try {
    await writeFile(fix.layout.entry, 'process.exit(0);\n');
    assert.deepEqual(await superviseRuntime(fix.layout, {watchGame: false, pollMs: 25}),
      {state: 'error', code: 'bridge-exited'});
    assert.equal((await serviceStatus(fix.layout)).state, 'error');
  } finally { await cleanup(fix); }
});

test('Windows launcher checks explicit development paths hidden without launching bridge/model/game',
  {skip: process.platform !== 'win32', timeout: 15000}, async () => {
    const fix = await fixture();
    try {
      const before = await readFile(join(fix.state, 'player-memory.json'));
      const history = await readFile(join(fix.state, 'phone-history.json'));
      const result = await new Promise((done, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', join(source, 'Start-Runtime.ps1'), '-Action', 'check', '-DevelopmentProjectDirectory', fix.app,
          '-GameDirectory', fix.game, '-StateDirectory', fix.state],
        {cwd: fix.folder, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
          env: {...process.env, NODE_OPTIONS: '--import deliberately-invalid-import-path-for-isolated-test.mjs',
            NODE_PATH: 'deliberately-invalid-module-path-for-isolated-test'}});
        let stdout = '', stderr = '';
        child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
        child.on('error', reject); child.on('close', code => done({code, stdout, stderr}));
      });
      const ownedLogs = await readdir(join(fix.state, 'logs'));
      const logText = await Promise.all(ownedLogs.filter(name => name.endsWith('.stderr.log'))
        .map(name => readFile(join(fix.state, 'logs', name), 'utf8')));
      assert.equal(result.code, 0, result.stderr + '\n' + logText.join('\n'));
      const value = JSON.parse(result.stdout.trim());
      assert.equal(value.state, 'checked'); assert.equal(value.packaged, false);
      assert.deepEqual(await readFile(join(fix.state, 'player-memory.json')), before);
      assert.deepEqual(await readFile(join(fix.state, 'phone-history.json')), history);
      await assert.rejects(stat(fix.layout.leasePath), {code: 'ENOENT'});
      await assert.rejects(stat(join(fix.state, 'fixture-graceful-stop.json')), {code: 'ENOENT'});
    } finally { await cleanup(fix); }
  });

test('Windows launcher accepts quoted directory paths ending in a backslash',
  {skip: process.platform !== 'win32', timeout: 15000}, async () => {
    const fix = await fixture();
    try {
      const before = await readFile(join(fix.state, 'player-memory.json'));
      const result = await new Promise((done, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', join(source, 'Start-Runtime.ps1'), '-Action', 'check',
          '-DevelopmentProjectDirectory', fix.app + '\\', '-GameDirectory', fix.game + '\\',
          '-StateDirectory', fix.state + '\\'],
        {cwd: fix.folder, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
        let stdout = '', stderr = '';
        child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
        child.on('error', reject); child.on('close', code => done({code, stdout, stderr}));
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout.trim()).state, 'checked');
      assert.deepEqual(await readFile(join(fix.state, 'player-memory.json')), before);
      await assert.rejects(stat(fix.layout.leasePath), {code: 'ENOENT'});
    } finally { await cleanup(fix); }
  });
