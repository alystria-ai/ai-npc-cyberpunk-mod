import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {copyFile, mkdtemp, mkdir, readFile, writeFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {fakeBridgeSource} from './supervisor-fixture.mjs';
import {RUNTIME_REQUIRED_FILES} from './runtime-files.mjs';

const supervisorScript = fileURLToPath(new URL('../scripts/Supervise-ConversationBridge.mjs', import.meta.url));

// Exercises the real launcher DLL outside the game. dist/autostart/test-host.exe
// is a console-free GUI program that loads it like RED4ext. Build both with:
//   powershell -File scripts/Build-AutostartPlugin.ps1 -TestHost
const dist = fileURLToPath(new URL('../dist/autostart/', import.meta.url));
const dll = join(dist, 'CyberpunkConvaiLauncher.dll'), hostExe = join(dist, 'test-host.exe');
const available = process.platform === 'win32' && existsSync(dll) && existsSync(hostExe);
const skip = available ? false : 'launcher not built (run scripts/Build-AutostartPlugin.ps1 -TestHost)';
const prefix = 'cyberpunk-autostart-plugin-';
const modRuntime = ['bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', 'AiNpcCyberpunkMod', 'runtime'];

// Started by the plugin in place of the supervisor. It records how it was
// launched, whether a console window would be visible to a console grandchild
// that does not ask to be hidden, and when the game lifeline closes.
const probe = `
import {appendFileSync, writeFileSync} from 'node:fs';
import {execFile} from 'node:child_process';
const out = process.argv[2];
const record = value => appendFileSync(out, JSON.stringify({at: Date.now(), ...value}) + '\\n');
record({event: 'started', pid: process.pid, argv: process.argv.slice(3), cwd: process.cwd()});
const script = 'Add-Type -Namespace P -Name W -MemberDefinition \\'[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);\\'; $h=[P.W]::GetConsoleWindow(); "$([int64]$h) $(if ($h -ne [IntPtr]::Zero) { [P.W]::IsWindowVisible($h) } else { $false })"';
let consoleChecked = false;
execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide: false, timeout: 60000}, (error, stdout) => {
  record({event: 'console', output: String(stdout).trim(), error: error ? error.message : null});
  consoleChecked = true;
});
process.stdin.on('end', () => {
  record({event: 'lifeline-closed'});
  const deadline = Date.now() + 60000;
  setInterval(() => { if (consoleChecked || Date.now() > deadline) process.exit(0); }, 50);
});
process.stdin.on('data', () => {});
setInterval(() => {}, 1000);
`;

async function fakeGame(t, {mod = true, cet = true, ini} = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix + 'space dir '));
  const game = join(root, 'Cyberpunk 2077'), x64 = join(game, 'bin', 'x64');
  const plugin = join(game, 'red4ext', 'plugins', 'CyberpunkConvaiLauncher');
  const modDir = join(game, ...modRuntime.slice(0, -1));
  await mkdir(join(x64, 'plugins'), {recursive: true}); await mkdir(plugin, {recursive: true});
  await copyFile(hostExe, join(x64, 'Cyberpunk2077.exe'));
  await copyFile(dll, join(plugin, 'CyberpunkConvaiLauncher.dll'));
  if (cet) await writeFile(join(x64, 'plugins', 'cyber_engine_tweaks.asi'), 'fixture');
  if (mod) { await mkdir(modDir, {recursive: true}); await writeFile(join(modDir, 'init.lua'), '-- fixture'); }
  const probePath = join(root, 'probe.mjs'), result = join(root, 'probe.jsonl');
  await writeFile(probePath, probe);
  const values = ini ?? {enabled: '1', program: process.execPath, arg1: probePath, arg2: result,
    arg3: 'C:\\path with space\\', arg4: 'say "hi"', arg5: '%GAME%\\bin', working_directory: root};
  const text = '[launch]\r\n' + Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\r\n') + '\r\n';
  await writeFile(join(plugin, 'launcher.ini'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) { try { child.kill(); } catch {} }
    for (const row of await events(result)) if (row.pid) { try { process.kill(row.pid); } catch {} }
    await sleep(100);
    const target = await realpath(root), base = await realpath(tmpdir());
    assert.equal(dirname(target).toLowerCase(), base.toLowerCase());
    assert(basename(target).startsWith(prefix));
    await rm(target, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  });
  return {root, game, plugin, result, probePath, children, hostResult: join(root, 'host.json'),
    status: join(game, ...modRuntime, 'bridge-service.json'), log: join(plugin, 'launcher.log')};
}

async function events(path) {
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function until(read, accepts, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accepts(last)) return last;
    await sleep(50);
  }
  assert.fail(`${label}; last=${JSON.stringify(last)}`);
}

function runHost(f, holdMs) {
  const child = spawn(join(f.game, 'bin', 'x64', 'Cyberpunk2077.exe'),
    [join(f.plugin, 'CyberpunkConvaiLauncher.dll'), f.hostResult, String(holdMs)], {stdio: 'ignore'});
  f.children.push(child);
  const exited = new Promise(done => child.once('exit', code => done(code)));
  return {child, exited};
}

test('the launcher reports a runtime-independent RED4ext plugin and starts the hidden service with exact arguments',
  {skip, timeout: 300_000}, async t => {
    const f = await fakeGame(t);
    const host = runHost(f, 120_000);
    const started = (await until(() => events(f.result), rows => rows.some(row => row.event === 'started'), 'service not started'))
      .find(row => row.event === 'started');
    const info = JSON.parse(await readFile(f.hostResult, 'utf8'));
    assert.deepEqual(info, {...info, api: 1, sdk: [0, 5, 0, 0, 0], name: 'CyberpunkConvaiLauncher',
      author: 'AI NPC Cyberpunk Mod', version: [1, 0, 0, 0, 0], runtime: [65535, 65535, 65535, 65535], load: true});
    assert.deepEqual(started.argv, ['C:\\path with space\\', 'say "hi"', `${f.game}\\bin`,
      '--game-pid', String(info.pid), '--game-root', f.game, '--lifeline', 'stdin']);
    assert.equal(started.cwd.toLowerCase(), f.root.toLowerCase());
    const status = JSON.parse(await readFile(f.status, 'utf8'));
    assert.equal(status.state, 'starting'); assert.equal(status.code, 'launcher-started');
    assert.equal(status.supervisorPid, started.pid); assert.equal(status.gamePid, info.pid);
    const console = (await until(() => events(f.result), rows => rows.some(row => row.event === 'console'), 'console probe missing', 60_000))
      .find(row => row.event === 'console');
    assert.equal(console.error, null);
    assert.match(console.output, /(^0 False$)|(^\d+ False$)/, 'no visible console window for the service or its console children');
    // A normal game exit (Main(Unload), then process exit) closes the lifeline.
    await writeFile(f.hostResult + '.exit', 'exit');
    assert.equal(await host.exited, 0);
    await until(() => events(f.result), rows => rows.some(row => row.event === 'lifeline-closed'), 'lifeline not closed on exit');
    const log = await readFile(f.log, 'utf8');
    assert.match(log, /Started the conversation service supervisor \(PID \d+, (outside|inside) the launcher job\)/);
  });

test('a crashed game closes the lifeline immediately', {skip, timeout: 180_000}, async t => {
  const f = await fakeGame(t);
  const host = runHost(f, 120_000);
  await until(() => events(f.result), rows => rows.some(row => row.event === 'started'), 'service not started');
  const killedAt = Date.now();
  host.child.kill(); // TerminateProcess: no Main(Unload), like a crash.
  await host.exited;
  const closed = (await until(() => events(f.result), rows => rows.some(row => row.event === 'lifeline-closed'),
    'lifeline not closed after a crash')).find(row => row.event === 'lifeline-closed');
  assert(closed.at - killedAt < 3000, `lifeline closed ${closed.at - killedAt} ms after the crash`);
});

test('nothing starts when the CyberpunkConvai mod or CET is not installed', {skip, timeout: 180_000}, async t => {
  for (const options of [{mod: false}, {cet: false}]) {
    const f = await fakeGame(t, options);
    const host = runHost(f, 500);
    assert.equal(await host.exited, 0);
    await sleep(300);
    assert.deepEqual(await events(f.result), []);
    assert.equal(existsSync(f.status), false);
    assert.match(await readFile(f.log, 'utf8'), /Skipped: /);
  }
});

test('game start runs the real supervisor and a game crash stops the bridge it started', {skip, timeout: 240_000}, async t => {
  const root = await mkdtemp(join(tmpdir(), prefix + 'chain '));
  const project = join(root, 'project'), state = join(root, 'state');
  await mkdir(join(project, 'bridge'), {recursive: true}); await mkdir(state, {recursive: true});
  await writeFile(join(project, 'bridge', 'convai-bridge.mjs'), fakeBridgeSource);
  // The supervisor refuses a Runtime without the bridge's data files (bridge/runtime-files.mjs, `install-incomplete`): its data files and its Node packages.
  for (const name of RUNTIME_REQUIRED_FILES) {
    await mkdir(dirname(join(project, name)), {recursive: true});
    await writeFile(join(project, name), '{}');
  }
  await writeFile(join(state, 'convai-key.txt'), 'api-key=fixture-key-not-a-credential\n');
  await writeFile(join(state, 'characters.json'), '{"judy-alvarez":"fixture-id"}');
  t.after(async () => {
    const raw = await readFile(join(state, 'fake-starts.log'), 'utf8').catch(() => '');
    for (const line of raw.split('\n')) { const pid = Number(line.split(' ')[1]); if (pid) { try { process.kill(pid); } catch {} } }
    await sleep(100);
    const target = await realpath(root), base = await realpath(tmpdir());
    assert.equal(dirname(target).toLowerCase(), base.toLowerCase());
    assert(basename(target).startsWith(prefix));
    await rm(target, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  });
  const f = await fakeGame(t, {ini: {enabled: '1', program: process.execPath, arg1: supervisorScript,
    arg2: '--project', arg3: project, arg4: '--state', arg5: state, working_directory: project}});
  const host = runHost(f, 120_000);
  const ready = await until(() => readFile(f.status, 'utf8').then(JSON.parse).catch(() => null),
    value => value?.state === 'ready', 'the supervised bridge did not become ready', 30_000);
  assert.equal(ready.code, 'bridge-ready');
  const bridgePid = ready.bridgePid;
  host.child.kill(); // A crash: no Main(Unload).
  await host.exited;
  const stopped = await until(() => readFile(f.status, 'utf8').then(JSON.parse).catch(() => null),
    value => value?.state === 'stopped', 'the bridge was not stopped after the game crashed', 20_000);
  assert.equal(stopped.code, 'game-exited');
  assert.match(await readFile(join(state, 'fake-starts.log'), 'utf8'), new RegExp(`stopped ${bridgePid}`),
    'the bridge drained through its graceful shutdown');
  await until(async () => { try { process.kill(stopped.supervisorPid, 0); return false; } catch { return true; } },
    gone => gone, 'the supervisor did not exit after the game');
});

test('a disabled launcher starts nothing and a missing program is published to the mod', {skip, timeout: 180_000}, async t => {
  const disabled = await fakeGame(t, {ini: {enabled: '0', program: process.execPath}});
  assert.equal(await runHost(disabled, 300).exited, 0);
  assert.match(await readFile(disabled.log, 'utf8'), /disabled in launcher\.ini/);
  assert.equal(existsSync(disabled.status), false);

  const missing = await fakeGame(t, {ini: {enabled: '1', program: 'C:\\Missing\\node.exe'}});
  assert.equal(await runHost(missing, 300).exited, 0);
  const status = JSON.parse(await readFile(missing.status, 'utf8'));
  assert.equal(status.state, 'failed'); assert.equal(status.code, 'launcher-program-missing');
  assert.equal(status.source, 'launcher');
});
