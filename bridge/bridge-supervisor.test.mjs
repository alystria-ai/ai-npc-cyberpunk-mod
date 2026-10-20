import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {PassThrough} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {BridgeSupervisor, MOD_RUNTIME, parseSupervisorArguments, processAlive, usvfsCompatImport} from './bridge-supervisor.mjs';
import {fakeBridgeSource} from './supervisor-fixture.mjs';
import {INCOMPLETE_EXIT_CODE} from './runtime-files.mjs';
import {packKey} from './key-codec.mjs';

const prefix = 'cyberpunk-bridge-supervisor-';
const fakeKey = 'api-key=fixture-key-not-a-credential';

const timings = {pollMs: 20, gamePollMs: 50, heartbeatMs: 300, readyTimeoutMs: 4000, shutdownGraceMs: 3000,
  shutdownRepeatMs: 400, killWaitMs: 3000, crashWindowMs: 60_000, maxCrashes: 3, backoffMs: [100, 200, 300],
  crashCooldownMs: 600_000, adoptFreshMs: 3000, adoptCheckMs: 100, setupRetryMs: 100, lockRetryMs: 50,
  buildTimeoutMs: 10_000};

async function fixture(t, {key = true, ids = true, behavior = {}, buildScript} = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const project = join(root, 'project'), state = join(root, 'state'), game = join(root, 'game');
  const runtime = join(game, ...MOD_RUNTIME.split('/'));
  await Promise.all([mkdir(join(project, 'bridge'), {recursive: true}), mkdir(join(project, 'scripts'), {recursive: true}),
    mkdir(state, {recursive: true}), mkdir(runtime, {recursive: true})]);
  await writeFile(join(project, 'bridge/convai-bridge.mjs'), fakeBridgeSource);
  if (buildScript) await writeFile(join(project, 'scripts/Build-VoiceClient.mjs'), buildScript);
  if (key) await writeFile(join(state, 'convai-key.txt'), fakeKey + '\n');
  if (ids) await writeFile(join(state, 'characters.json'), '{"judy-alvarez":"fixture-id"}');
  await writeFile(join(state, 'fake-behavior.json'), JSON.stringify(behavior));
  const extra = [];
  t.after(async () => {
    for (const pid of [...await bridgePids(state), ...extra]) if (processAlive(pid)) { try { process.kill(pid); } catch {} }
    await sleep(100);
    const target = await realpath(root), base = await realpath(tmpdir());
    assert.equal(dirname(target).toLowerCase(), base.toLowerCase());
    assert(basename(target).startsWith(prefix));
    await rm(target, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  });
  return {root, project, state, game, runtime, extra, statusPath: join(runtime, 'bridge-service.json')};
}

async function bridgePids(state) {
  const raw = await readFile(join(state, 'fake-starts.log'), 'utf8').catch(() => '');
  return raw.split('\n').filter(line => line.startsWith('start ')).map(line => Number(line.split(' ')[1]));
}
// The supervisor repeats its shutdown request every shutdownRepeatMs while the bridge drains, so a slow
// (loaded) machine can log the same stop twice; what matters is which bridges were asked to stop.
async function stoppedPids(state) {
  const raw = await readFile(join(state, 'fake-starts.log'), 'utf8').catch(() => '');
  return [...new Set(raw.split('\n').filter(line => line.startsWith('stopped ')).map(line => Number(line.split(' ')[1])))];
}
const readJson = path => readFile(path, 'utf8').then(JSON.parse).catch(() => null);
async function until(read, accepts, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accepts(last)) return last;
    await sleep(25);
  }
  assert.fail(`${label}; last=${JSON.stringify(last)}`);
}

function supervise(f, options = {}) {
  const lifeline = new PassThrough();
  const spawned = [];
  const supervisor = new BridgeSupervisor({project: f.project, stateDirectory: f.state,
    keyFile: join(f.state, 'convai-key.txt'), gameRoot: f.game, lifeline, timings, browserAvailable: () => true,
    spawn: (command, args, spawnOptions) => { spawned.push({command, args, spawnOptions}); return spawn(command, args, spawnOptions); },
    ...options});
  const done = supervisor.run();
  return {supervisor, lifeline, spawned, done, endGame: () => lifeline.end()};
}

function startManualBridge(f) {
  const child = spawn(process.execPath, [join(f.project, 'bridge/convai-bridge.mjs')], {windowsHide: true, stdio: 'ignore',
    env: {...process.env, CYBERPUNK_CONVAI_STATE: f.state, CYBERPUNK_CONVAI_GAME: f.game}});
  f.extra.push(child.pid);
  return child;
}

test('starts one hidden bridge with the configured paths and stops it gracefully when the game exits', async t => {
  const f = await fixture(t);
  // An inherited NODE_OPTIONS (for example a debugger flag) must not reach the bridge.
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--no-warnings';
  let run, ready;
  try {
    run = supervise(f);
    ready = await until(() => readJson(f.statusPath), value => value?.state === 'ready', 'bridge did not become ready');
  } finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
  assert.equal(ready.code, 'bridge-ready'); assert.equal(ready.adopted, false); assert.equal(ready.restarts, 0);
  assert.equal(run.spawned.length, 1);
  const [{command, args, spawnOptions}] = run.spawned;
  assert.equal(command, process.execPath); assert.deepEqual(args, [join(f.project, 'bridge/convai-bridge.mjs')]);
  assert.equal(spawnOptions.windowsHide, true); assert.equal(spawnOptions.cwd, f.project);
  const [pid] = await bridgePids(f.state);
  assert.equal(ready.bridgePid, pid);
  const env = await readJson(join(f.state, `fake-env-${pid}.json`));
  assert.deepEqual({state: env.state, game: env.game, key: env.key, nodeOptions: env.nodeOptions},
    {state: f.state, game: f.game, key: join(f.state, 'convai-key.txt'), nodeOptions: null});
  assert.equal((await readFile(join(f.state, 'bridge.pid'), 'utf8')).trim(), String(pid));
  run.endGame();
  const result = await run.done;
  assert.deepEqual(result, {state: 'stopped', code: 'game-exited'});
  assert.deepEqual(await stoppedPids(f.state), [pid], 'the bridge drained through its own shutdown protocol');
  assert.equal(processAlive(pid), false);
  const final = await readJson(f.statusPath);
  assert.equal(final.state, 'stopped'); assert.equal(final.bridgePid, null);
  for (const file of [f.statusPath, join(f.state, 'bridge-service.log')]) {
    assert.doesNotMatch(await readFile(file, 'utf8'), /fixture-key-not-a-credential/, 'the credential is never published');
  }
});

test('under Mod Organizer 2 the bridge gets the start script\'s stat fallbacks and nothing else from NODE_OPTIONS', async t => {
  const f = await fixture(t);
  // Where the packaged start script has it: app/launcher/usvfs-compat.mjs.
  const compatFile = join(f.root, 'app', 'launcher', 'usvfs-compat.mjs');
  await mkdir(dirname(compatFile), {recursive: true});
  await writeFile(compatFile, await readFile(new URL('../packaging/runtime/usvfs-compat.mjs', import.meta.url)));
  const compat = pathToFileURL(compatFile).href;
  const names = ['NODE_OPTIONS', 'CYBERPUNK_CONVAI_USVFS', 'CYBERPUNK_CONVAI_USVFS_IMPORT'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, {NODE_OPTIONS: '--no-warnings', CYBERPUNK_CONVAI_USVFS: '1', CYBERPUNK_CONVAI_USVFS_IMPORT: compat});
  let run;
  try {
    run = supervise(f);
    await until(() => readJson(f.statusPath), value => value?.state === 'ready', 'bridge did not become ready with the fallbacks loaded');
  } finally { for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  const [pid] = await bridgePids(f.state);
  assert.equal((await readJson(join(f.state, `fake-env-${pid}.json`))).nodeOptions, `--import=${compat}`);
  run.endGame();
  assert.deepEqual(await run.done, {state: 'stopped', code: 'game-exited'});
});

test('the stat fallbacks are let in only as the start script names them', () => {
  const compat = 'file:///C:/Modding/MO2/mods/AI%20NPC%20Runtime/red4ext/plugins/AiNpcCyberpunkMod/app/launcher/usvfs-compat.mjs';
  assert.equal(usvfsCompatImport({CYBERPUNK_CONVAI_USVFS: '1', CYBERPUNK_CONVAI_USVFS_IMPORT: compat}), compat);
  assert.equal(usvfsCompatImport({CYBERPUNK_CONVAI_USVFS_IMPORT: compat}), null, 'only when the start script found usvfs');
  for (const other of ['file:///C:/x/inspector-hook.mjs', 'C:\\x\\launcher\\usvfs-compat.mjs', 'file:///C:/x/launcher/usvfs-compat.mjs --inspect',
    'data:text/javascript,1', '']) {
    assert.equal(usvfsCompatImport({CYBERPUNK_CONVAI_USVFS: '1', CYBERPUNK_CONVAI_USVFS_IMPORT: other}), null, other);
  }
  const supervisor = new BridgeSupervisor({project: 'C:\\p', stateDirectory: 'C:\\s', keyFile: 'C:\\s\\k.txt', gameRoot: 'C:\\g', lifeline: null, timings});
  const previous = {NODE_OPTIONS: process.env.NODE_OPTIONS, U: process.env.CYBERPUNK_CONVAI_USVFS};
  try {
    process.env.NODE_OPTIONS = '--inspect'; delete process.env.CYBERPUNK_CONVAI_USVFS;
    assert.equal(supervisor.bridgeEnvironment().NODE_OPTIONS, undefined, 'outside MO2 nothing inherited reaches the bridge');
  } finally {
    if (previous.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous.NODE_OPTIONS;
    if (previous.U === undefined) delete process.env.CYBERPUNK_CONVAI_USVFS; else process.env.CYBERPUNK_CONVAI_USVFS = previous.U;
  }
});

test('a crashed bridge is restarted after a backoff and reports ready again', async t => {
  const f = await fixture(t, {behavior: {crashStarts: [1]}});
  const run = supervise(f);
  await until(() => bridgePids(f.state), pids => pids.length === 2, 'the bridge was not restarted');
  const status = await until(() => readJson(f.statusPath), value => value?.state === 'ready' && value.restarts === 1,
    'the restarted bridge did not become ready');
  const pids = await bridgePids(f.state);
  assert.equal(status.bridgePid, pids[1]); assert.equal(processAlive(pids[0]), false);
  assert.match(await readFile(join(f.state, 'bridge-service.log'), 'utf8'), /exited unexpectedly \(exit code 4\)/);
  run.endGame(); await run.done;
});

test('repeated crashes stop the restart loop and publish a failure', async t => {
  const f = await fixture(t, {behavior: {crashAlways: true, crashBeforeReady: true}});
  const run = supervise(f);
  const failed = await until(() => readJson(f.statusPath), value => value?.state === 'failed', 'no failure was published');
  assert.equal(failed.code, 'bridge-crashed');
  await sleep(500);
  assert.equal((await bridgePids(f.state)).length, timings.maxCrashes, 'no further restarts after the crash limit');
  run.endGame();
  assert.deepEqual(await run.done, {state: 'stopped', code: 'game-exited'});
});

test('an explicit stop keeps the bridge stopped and a later manual bridge is used, not duplicated', async t => {
  const f = await fixture(t);
  const run = supervise(f);
  await until(() => readJson(f.statusPath), value => value?.state === 'ready', 'bridge did not become ready');
  const [pid] = await bridgePids(f.state);
  // The same PID-addressed request that scripts/Stop-ConversationBridge.ps1 writes.
  await writeFile(join(f.state, 'bridge-control.json'), JSON.stringify({action: 'shutdown', pid, nonce: 'developer-stop'}));
  const stopped = await until(() => readJson(f.statusPath), value => value?.state === 'stopped', 'explicit stop was not reported');
  assert.equal(stopped.code, 'stop-requested');
  await sleep(600);
  assert.equal((await bridgePids(f.state)).length, 1, 'an explicit stop is not treated as a crash');
  const manual = startManualBridge(f);
  const adopted = await until(() => readJson(f.statusPath), value => value?.state === 'ready', 'manual bridge was not used');
  assert.equal(adopted.code, 'existing-bridge'); assert.equal(adopted.adopted, true); assert.equal(adopted.bridgePid, manual.pid);
  assert.equal(run.spawned.length, 1);
  run.endGame(); await run.done;
  await until(() => stoppedPids(f.state), pids => pids.includes(manual.pid), 'the used bridge was not asked to stop at game exit');
});

test('a bridge that is already running is used instead of starting a second one', async t => {
  const f = await fixture(t);
  const manual = startManualBridge(f);
  await until(() => readJson(join(f.runtime, 'local-voice-state.json')), value => value?.bridgePid === manual.pid, 'manual bridge heartbeat missing');
  const run = supervise(f);
  const status = await until(() => readJson(f.statusPath), value => value?.state === 'ready', 'existing bridge was not used');
  assert.equal(status.code, 'existing-bridge'); assert.equal(status.bridgePid, manual.pid);
  await sleep(300);
  assert.equal(run.spawned.length, 0, 'no duplicate bridge');
  run.endGame();
  await run.done;
  assert.deepEqual(await stoppedPids(f.state), [manual.pid]);
});

test('the empty placeholders the install ships are no status and no bridge: the supervisor starts one, publishes over them and never removes them', async t => {
  const f = await fixture(t);
  await writeFile(f.statusPath, ''); await writeFile(join(f.runtime, 'local-voice-state.json'), '');
  const run = supervise(f);
  const ready = await until(() => readJson(f.statusPath), value => value?.state === 'ready', 'bridge did not become ready over the placeholder');
  assert.equal(ready.code, 'bridge-ready', 'an empty local-voice-state.json is not a bridge that is already running');
  assert.equal(run.spawned.length, 1);
  run.endGame(); await run.done;
  const final = await readJson(f.statusPath);
  assert.equal(final.state, 'stopped', 'the status file stays and holds the last state');
});

test('missing setup is reported without starting a bridge and recovers once the key is added', async t => {
  const f = await fixture(t, {key: false});
  const run = supervise(f);
  const failed = await until(() => readJson(f.statusPath), value => value?.state === 'failed', 'setup failure was not reported');
  assert.equal(failed.code, 'missing-key');
  assert.equal(run.spawned.length, 0);
  await writeFile(join(f.state, 'convai-key.txt'), fakeKey + '\n');
  await until(() => readJson(f.statusPath), value => value?.state === 'ready', 'the bridge did not start after setup was completed');
  run.endGame(); await run.done;
});

test('the packed key of the release package passes the supervisor check, and a damaged one is a setup failure', async t => {
  const f = await fixture(t, {key: false});
  await writeFile(join(f.state, 'convai-key.txt'), 'convai-key-v1 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n');
  const run = supervise(f);
  const failed = await until(() => readJson(f.statusPath), value => value?.state === 'failed', 'a damaged packed key was accepted');
  assert.equal(failed.code, 'missing-key');
  await writeFile(join(f.state, 'convai-key.txt'), packKey('packed-fixture-not-a-credential-0123'));
  await until(() => readJson(f.statusPath), value => value?.state === 'ready', 'the packed key was not accepted');
  assert.doesNotMatch(await readFile(f.statusPath, 'utf8'), /packed-fixture/, 'the credential is never published');
  run.endGame(); await run.done;
});

test('missing character IDs are reported as a setup failure', async t => {
  const f = await fixture(t, {ids: false});
  const run = supervise(f);
  const failed = await until(() => readJson(f.statusPath), value => value?.state === 'failed', 'setup failure was not reported');
  assert.equal(failed.code, 'missing-character-ids'); assert.equal(run.spawned.length, 0);
  run.endGame(); await run.done;
});

test('no Edge or Chrome is a setup failure with one clear log line, and the bridge starts once a browser is installed', async t => {
  const f = await fixture(t);
  let installed = false;
  const run = supervise(f, {browserAvailable: () => installed});
  const failed = await until(() => readJson(f.statusPath), value => value?.state === 'failed', 'a missing browser was not reported');
  assert.equal(failed.code, 'browser-missing'); assert.equal(run.spawned.length, 0);
  await sleep(300);
  const lines = (await readFile(join(f.state, 'bridge-service.log'), 'utf8')).split('\n').filter(line => line.includes('No browser to run the conversation page'));
  assert.equal(lines.length, 1, 'the instruction is logged once, not on every retry');
  assert.match(lines[0], /Microsoft Edge.*Google Chrome/);
  installed = true;
  await until(() => readJson(f.statusPath), value => value?.state === 'ready', 'the bridge did not start once a browser was available');
  run.endGame(); await run.done;
});

test('a Runtime that lacks a data file is "install-incomplete" with no bridge started, says which file once, and recovers when it is back', async t => {
  const f = await fixture(t);
  await mkdir(join(f.project, 'characters'), {recursive: true});
  await writeFile(join(f.project, 'characters/roster.json'), '[]');
  const files = ['characters/roster.json', 'characters/world-knowledge.json'];
  const run = supervise(f, {requiredFiles: files});
  const failed = await until(() => readJson(f.statusPath), value => value?.state === 'failed', 'an incomplete Runtime was not reported');
  assert.equal(failed.code, 'install-incomplete'); assert.equal(run.spawned.length, 0, 'no bridge is started on a Runtime that cannot work');
  await sleep(400);
  const log = await readFile(join(f.state, 'bridge-service.log'), 'utf8');
  const lines = log.split('\n').filter(line => line.includes('The Runtime is incomplete'));
  assert.equal(lines.length, 1, 'said once, not on every retry');
  assert.match(lines[0], /characters\/world-knowledge\.json is missing/);
  assert.doesNotMatch(lines[0], /characters\/roster\.json/, 'only what is missing is named');
  assert.doesNotMatch(lines[0], new RegExp(f.project.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')), 'never a folder');
  await writeFile(join(f.project, 'characters/world-knowledge.json'), '{}');
  await until(() => readJson(f.statusPath), value => value?.state === 'ready', 'the bridge did not start once the file was back');
  run.endGame(); await run.done;
});

test('a bridge that ends with the incomplete-Runtime exit code is not restarted over and over: one failure the game explains', async t => {
  const f = await fixture(t, {behavior: {crashAlways: true, crashBeforeReady: true, exitCode: INCOMPLETE_EXIT_CODE}});
  const run = supervise(f);
  const failed = await until(() => readJson(f.statusPath), value => value?.state === 'failed', 'no failure was published');
  assert.equal(failed.code, 'install-incomplete', 'not bridge-crashed');
  await sleep(500);
  assert.equal((await bridgePids(f.state)).length, 1, 'one start, no restart loop');
  assert.match(await readFile(join(f.state, 'bridge-service.log'), 'utf8'), /file of the Runtime is missing/);
  run.endGame(); await run.done;
});

test('a bridge that dies on a package or file of its own that is not there is "install-incomplete" after one start, naming the file and never a folder', async t => {
  const f = await fixture(t);
  const asked = join(f.project, 'node_modules', 'fakepkg-core', 'lib', 'server', 'index.js').replace(/\//g, '\\');
  await writeFile(join(f.state, 'fake-behavior.json'), JSON.stringify({crashAlways: true, crashBeforeReady: true, exitCode: 1,
    stderrText: `node:internal/modules/cjs/loader:1564\nError: Cannot find module './inner/thing'\nRequire stack:\n- ${asked}\n  code: 'MODULE_NOT_FOUND',`}));
  const run = supervise(f);
  const failed = await until(() => readJson(f.statusPath), value => value?.state === 'failed', 'no failure was published');
  assert.equal(failed.code, 'install-incomplete', 'not bridge-crashed');
  await sleep(500);
  assert.equal((await bridgePids(f.state)).length, 1, 'one start, no restart loop');
  const log = await readFile(join(f.state, 'bridge-service.log'), 'utf8');
  const line = log.split('\n').find(text => text.includes('The Runtime is incomplete'));
  assert(line, log);
  assert.match(line, /The Runtime is incomplete: node_modules\/fakepkg-core\/lib\/server\/inner\/thing is missing\. Download the Runtime again/);
  assert(!line.includes(f.project) && !line.toLowerCase().includes(basename(f.root).toLowerCase()), 'never a folder');
  assert.doesNotMatch(log, /exited unexpectedly/, 'not counted as a crash');
  run.endGame(); await run.done;
});

test('a bridge whose files are of two versions (Node: "does not provide an export named") is "install-incomplete" after one start, with the full Runtime or the update zips in order named', async t => {
  const f = await fixture(t);
  const importer = join(f.project, 'bridge', 'convai-bridge.mjs').replace(/\//g, '\\');
  await writeFile(join(f.state, 'fake-behavior.json'), JSON.stringify({crashAlways: true, crashBeforeReady: true, exitCode: 1,
    stderrText: `file:///${importer.replace(/\\/g, '/')}:12\nimport {newerThing} from './runtime-files.mjs';\n        ^^^^^^^^\nSyntaxError: The requested module './runtime-files.mjs' does not provide an export named 'newerThing'\n    at ModuleJob._instantiate (node:internal/modules/esm/module_job:180:21)`}));
  const run = supervise(f);
  const failed = await until(() => readJson(f.statusPath), value => value?.state === 'failed', 'no failure was published');
  assert.equal(failed.code, 'install-incomplete', 'not bridge-crashed');
  await sleep(500);
  assert.equal((await bridgePids(f.state)).length, 1, 'one start, no restart loop');
  const log = await readFile(join(f.state, 'bridge-service.log'), 'utf8');
  const line = log.split('\n').find(text => text.includes('does not match'));
  assert(line, log);
  assert.match(line, /The Runtime does not match the mod's Scripts: bridge\/runtime-files\.mjs comes from a different version\. Download the full Runtime again, or apply the Runtime update zips in order/);
  assert(!line.includes(f.project) && !line.toLowerCase().includes(basename(f.root).toLowerCase()), 'never a folder');
  assert.doesNotMatch(log, /exited unexpectedly/, 'not counted as a crash');
  run.endGame(); await run.done;
});

test('a bridge that crashes for another reason is still a crash that is restarted and finally "bridge-crashed"', async t => {
  const f = await fixture(t, {behavior: {crashAlways: true, crashBeforeReady: true, exitCode: 1,
    stderrText: 'TypeError: something is not a function\n    at run (convai-bridge.mjs:1:1)'}});
  const run = supervise(f);
  const failed = await until(() => readJson(f.statusPath), value => value?.state === 'failed', 'no failure was published');
  assert.equal(failed.code, 'bridge-crashed');
  assert(((await bridgePids(f.state)).length) >= 3, 'restarted until the crash limit');
  assert.match(await readFile(join(f.state, 'bridge-service.log'), 'utf8'), /exited unexpectedly/);
  run.endGame(); await run.done;
});

test('a Runtime without a Node package the bridge imports is "install-incomplete" with no bridge started', async t => {
  const f = await fixture(t);
  const files = ['node_modules/fakepkg/package.json'];
  const run = supervise(f, {requiredFiles: files});
  const failed = await until(() => readJson(f.statusPath), value => value?.state === 'failed', 'an incomplete Runtime was not reported');
  assert.equal(failed.code, 'install-incomplete'); assert.equal(run.spawned.length, 0);
  assert.match(await readFile(join(f.state, 'bridge-service.log'), 'utf8'), /node_modules\/fakepkg\/package\.json is missing/);
  await mkdir(join(f.project, 'node_modules', 'fakepkg'), {recursive: true});
  await writeFile(join(f.project, 'node_modules', 'fakepkg', 'package.json'), '{}');
  await until(() => readJson(f.statusPath), value => value?.state === 'ready', 'the bridge did not start once the package was back');
  run.endGame(); await run.done;
});

test('a bridge that ignores shutdown is ended with its process tree after the grace period', async t => {
  const f = await fixture(t, {behavior: {ignoreShutdown: true}});
  const killed = [];
  const run = supervise(f, {killTree: async pid => { killed.push(pid); process.kill(pid); }});
  await until(() => readJson(f.statusPath), value => value?.state === 'ready', 'bridge did not become ready');
  const [pid] = await bridgePids(f.state);
  run.endGame();
  assert.deepEqual(await run.done, {state: 'stopped', code: 'game-exited'});
  assert.deepEqual(killed, [pid]); assert.equal(processAlive(pid), false);
});

test('a bridge that never reports ready is restarted', async t => {
  const f = await fixture(t, {behavior: {neverReady: true}});
  const run = supervise(f, {timings: {...timings, readyTimeoutMs: 600}});
  await until(() => bridgePids(f.state), pids => pids.length >= 2, 'a hung startup was not restarted');
  const [first] = await bridgePids(f.state);
  assert.deepEqual((await stoppedPids(f.state)).slice(0, 1), [first], 'the hung bridge was asked to stop first');
  run.endGame(); await run.done;
});

test('the game PID alone also ends supervision', async t => {
  const f = await fixture(t);
  let gameAlive = true;
  const run = supervise(f, {lifeline: null, gamePid: 424242, alive: pid => pid === 424242 ? gameAlive : processAlive(pid)});
  await until(() => readJson(f.statusPath), value => value?.state === 'ready', 'bridge did not become ready');
  gameAlive = false;
  assert.deepEqual(await run.done, {state: 'stopped', code: 'game-exited'});
});

test('a second supervisor waits for the first to finish, then owns the next bridge', async t => {
  const f = await fixture(t);
  const first = supervise(f);
  await until(() => readJson(f.statusPath), value => value?.state === 'ready', 'first bridge did not become ready');
  const second = supervise(f);
  await sleep(400);
  assert.equal(second.spawned.length, 0, 'the second supervisor waited for the lock');
  first.endGame();
  await first.done;
  await until(() => readJson(f.statusPath), value => value?.state === 'ready' && value.supervisorPid === process.pid
    && second.spawned.length === 1, 'the second supervisor did not take over');
  assert.equal((await bridgePids(f.state)).length, 2);
  second.endGame(); await second.done;
});

test('a waiting supervisor whose game ends never starts a bridge', async t => {
  const f = await fixture(t);
  const first = supervise(f);
  await until(() => readJson(f.statusPath), value => value?.state === 'ready', 'first bridge did not become ready');
  const second = supervise(f);
  second.endGame();
  assert.deepEqual(await second.done, {state: 'not-started'});
  assert.equal(second.spawned.length, 0);
  first.endGame(); await first.done;
});

test('the development voice client is rebuilt once and a failed build prevents startup', async t => {
  const ok = await fixture(t, {behavior: {crashStarts: [1]}, buildScript: `
    import {appendFileSync} from 'node:fs';
    appendFileSync(process.argv[3] + '/build-count.log', 'built\\n');
    console.log('Voice client rebuilt and verified (1 bytes, SHA-256 fixture).');`});
  const run = supervise(ok, {buildVoiceClient: true});
  await until(() => readJson(ok.statusPath), value => value?.state === 'ready' && value.restarts === 1, 'restart after build failed');
  assert.equal((await readFile(join(ok.project, 'build-count.log'), 'utf8')).trim().split('\n').length, 1, 'built once per session');
  run.endGame(); await run.done;

  const broken = await fixture(t, {buildScript: `console.error('Voice client build failed: fixture'); process.exitCode = 1;`});
  const failing = supervise(broken, {buildVoiceClient: true});
  const failed = await until(() => readJson(broken.statusPath), value => value?.state === 'failed', 'build failure was not reported');
  assert.equal(failed.code, 'voice-client-build-failed'); assert.equal(failing.spawned.length, 1, 'only the build process ran');
  assert.equal((await bridgePids(broken.state)).length, 0);
  failing.endGame(); await failing.done;
});

test('the status heartbeat stays current while a slow build runs', async t => {
  const f = await fixture(t, {buildScript: `setTimeout(() => console.log('Voice client rebuilt and verified.'), 1500);`});
  const run = supervise(f, {buildVoiceClient: true});
  const first = await until(() => readJson(f.statusPath), value => value?.code === 'building-voice-client', 'no build status');
  await until(() => readJson(f.statusPath), value => value?.code === 'building-voice-client' && value.updated >= first.updated + 500,
    'the heartbeat stalled during the build');
  await until(() => readJson(f.statusPath), value => value?.state === 'ready', 'not ready after the build');
  run.endGame(); await run.done;
});

test('arguments resolve the development defaults and reject an unusable game directory', () => {
  const parsed = parseSupervisorArguments(['--game-root', 'C:\\Games\\Cyberpunk 2077', '--game-pid', '1234', '--lifeline', 'stdin',
    '--build-voice-client', '--unexpected'], {defaultProject: 'C:\\Project', env: {}});
  assert.equal(parsed.project, 'C:\\Project'); assert.equal(parsed.stateDirectory, 'C:\\Project\\runtime');
  assert.equal(parsed.keyFile, 'C:\\Project\\runtime\\convai-key.txt'); assert.equal(parsed.gameRoot, 'C:\\Games\\Cyberpunk 2077');
  assert.equal(parsed.gamePid, 1234); assert.equal(parsed.lifeline, 'stdin'); assert.equal(parsed.buildVoiceClient, true);
  assert.deepEqual(parsed.unknown, ['--unexpected']);
  const state = parseSupervisorArguments(['--game-root', 'C:\\Game'], {defaultProject: 'C:\\Project',
    env: {CYBERPUNK_CONVAI_STATE: 'D:\\State'}});
  assert.equal(state.stateDirectory, 'D:\\State'); assert.equal(state.keyFile, 'D:\\State\\convai-key.txt');
  assert.throws(() => parseSupervisorArguments([], {defaultProject: 'C:\\Project', env: {}}), /--game-root/);
  assert.throws(() => parseSupervisorArguments(['--game-root', 'relative'], {defaultProject: 'C:\\Project', env: {}}), /--game-root/);
  assert.throws(() => parseSupervisorArguments(['--game-root', 'C:\\Game', '--game-pid', 'x'], {defaultProject: 'C:\\Project', env: {}}), /process ID/);
  assert.throws(() => parseSupervisorArguments(['--game-root', 'C:\\Game', '--lifeline', 'pipe'], {defaultProject: 'C:\\Project', env: {}}), /stdin/);
});
