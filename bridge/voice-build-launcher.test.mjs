import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, rmdir, realpath, stat, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildVoiceClient} from '../scripts/Build-VoiceClient.mjs';

const exec = promisify(execFile);
const prefix = 'cyberpunk-voice-build-';
const source = fileURLToPath(new URL('../scripts/', import.meta.url));
const quote = value => `'${value.replaceAll("'", "''")}'`;

async function fixture(t) {
  const project = await mkdtemp(join(tmpdir(), prefix));
  await Promise.all(['bridge', 'scripts', 'runtime', 'custom-state'].map(name => mkdir(join(project, name))));
  await writeFile(join(project, 'bridge/realtime-client.mjs'), "import {value} from './dependency.mjs'; globalThis.bundleVersion = value;\n");
  await writeFile(join(project, 'bridge/dependency.mjs'), "export const value = 'current-source';\n");
  await writeFile(join(project, 'runtime/realtime-client.js'), '// obsolete browser code');
  await writeFile(join(project, 'custom-state/convai-key.txt'), 'api-key=fixture-key-not-a-credential');
  const builder = new URL('../scripts/Build-VoiceClient.mjs', import.meta.url).href;
  await writeFile(join(project, 'scripts/Build-VoiceClient.mjs'),
    `import {buildVoiceClient} from ${JSON.stringify(builder)}; await buildVoiceClient({projectDirectory: process.argv[3]});\n`);
  t.after(async () => {
    const target = await realpath(project), base = await realpath(tmpdir());
    assert.equal(dirname(target).toLowerCase(), base.toLowerCase());
    assert(basename(target).startsWith(prefix));
    await rm(target, {recursive: true, force: true});
  });
  return {project, output: join(project, 'runtime/realtime-client.js'), state: join(project, 'custom-state')};
}

test('browser rebuild follows transitive content changes even when timestamps are unchanged', async t => {
  const f = await fixture(t);
  const first = await buildVoiceClient({projectDirectory: f.project});
  assert.match(await readFile(f.output, 'utf8'), /current-source/);
  const dependency = join(f.project, 'bridge/dependency.mjs'), before = await stat(dependency);
  await writeFile(dependency, "export const value = 'updated-source';\n");
  await utimes(dependency, before.atime, before.mtime);
  const second = await buildVoiceClient({projectDirectory: f.project});
  assert.notEqual(second.sha256, first.sha256);
  assert.match(await readFile(f.output, 'utf8'), /updated-source/);
  assert.deepEqual((await readdir(dirname(f.output))).filter(file => file.endsWith('.tmp')), []);
});

test('failed bundle compilation preserves the old complete file and reports failure', async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'bridge/dependency.mjs'), 'export const value = ;');
  await assert.rejects(buildVoiceClient({projectDirectory: f.project}), /Build failed/);
  assert.equal(await readFile(f.output, 'utf8'), '// obsolete browser code');
  assert.deepEqual((await readdir(dirname(f.output))).filter(file => file.endsWith('.tmp')), []);
});

test('browser bundle can be built before the generated runtime directory exists', async t => {
  const f = await fixture(t);
  // Remove only the known disposable file/directory, never a project runtime.
  await rm(f.output); await rmdir(dirname(f.output));
  const result = await buildVoiceClient({projectDirectory: f.project});
  assert.equal(result.output, resolve(f.output));
  assert.match(await readFile(f.output, 'utf8'), /current-source/);
});

// Only process cmdlets are replaced; the real scripts perform their path,
// environment and file operations inside the fixture. No bridge/game/provider
// worker is created or signalled by these tests.
async function powershell(f, {action = 'start', duplicates = 0, failStart = false, explicitState = false} = {}) {
  const harness = join(f.project, `test-${action}.ps1`), receipt = join(f.project, 'receipt.json');
  const script = join(source, action === 'start' ? 'Start-ConversationBridge.ps1' : 'Stop-ConversationBridge.ps1');
  await writeFile(harness, `
$ErrorActionPreference = 'Stop'
$global:testQueries = 0
$global:testObserved = @{ started = $false; waited = $false; }
function Get-CimInstance {
  param($ClassName, $Filter)
  $global:testQueries++
  $n = ${duplicates} -eq 3 -and $global:testQueries -gt 1
  if (${duplicates} -eq 1 -or $n) { [pscustomobject]@{CommandLine=${quote(join(f.project, 'bridge/convai-bridge.mjs').replaceAll('/', '\\'))};ProcessId=12345} }
  if (${duplicates} -eq 2) {
    [pscustomobject]@{CommandLine=${quote(join(f.project, 'bridge/convai-bridge.mjs').replaceAll('/', '\\'))};ProcessId=12345}
    [pscustomobject]@{CommandLine=${quote(join(f.project, 'bridge/convai-bridge.mjs').replaceAll('/', '\\'))};ProcessId=12346}
  }
}
function Get-Command { param($Name) @{Source=${quote(process.execPath)}} }
function Start-Sleep { param($Milliseconds) }
function Start-Process {
  param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,[switch]$PassThru,$RedirectStandardOutput,$RedirectStandardError)
  $global:testObserved.started = $true
  $global:testObserved.style = $WindowStyle
  $global:testObserved.state = $env:CYBERPUNK_CONVAI_STATE
  $global:testObserved.key = $env:CYBERPUNK_CONVAI_KEY_FILE
  $global:testObserved.cwd = $WorkingDirectory
  $global:testObserved.log = $RedirectStandardOutput
  $global:testObserved.bundle = [IO.File]::ReadAllText(${quote(f.output)})
  if (${failStart ? '$true' : '$false'}) { throw 'Fixture start failed' }
  $worker = [pscustomobject]@{Id=12345;HasExited=$false}
  $worker | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
  return $worker
}
function Get-Process {
  param($Id)
  $worker = [pscustomobject]@{Id=$Id}
  $worker | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {param($Milliseconds) $global:testObserved.waited = $true; return $true}
  return $worker
}
$env:CYBERPUNK_CONVAI_KEY_FILE = 'original-environment-key-path'
${explicitState ? "$env:CYBERPUNK_CONVAI_STATE = 'original-environment-state-path'" : `$env:CYBERPUNK_CONVAI_STATE = ${quote(f.state)}`}
try {
  & ${quote(script)} -ProjectDirectory ${quote(f.project)} ${explicitState ? `-StateDirectory ${quote(f.state)}` : ''}
} catch { $global:testObserved.error = $_.Exception.Message }
$global:testObserved.restoredState = $env:CYBERPUNK_CONVAI_STATE
$global:testObserved.restoredKey = $env:CYBERPUNK_CONVAI_KEY_FILE
$global:testObserved.queries = $global:testQueries
[IO.File]::WriteAllText(${quote(receipt)}, ($global:testObserved | ConvertTo-Json -Compress))
`);
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], {
    cwd: f.project, windowsHide: true, timeout: 20000,
    env: {...process.env, NODE_OPTIONS: '', NODE_PATH: ''},
  });
  return JSON.parse(await readFile(receipt, 'utf8'));
}

const windows = {skip: process.platform !== 'win32'};
test('launcher rebuilds before hidden startup and honors the custom state directory', windows, async t => {
  const f = await fixture(t), result = await powershell(f);
  assert.equal(result.error, undefined); assert.equal(result.started, true);
  assert.match(result.bundle, /current-source/); assert.doesNotMatch(result.bundle, /obsolete/);
  assert.equal(result.style, 'Hidden'); assert.equal(result.state, f.state);
  assert.equal(result.key, join(f.state, 'convai-key.txt'));
  assert.equal(result.log, join(f.state, 'bridge.stdout.log'));
  assert.equal(result.restoredState, f.state); assert.equal(result.restoredKey, 'original-environment-key-path');
  assert.equal((await readFile(join(f.state, 'bridge.pid'), 'utf8')).trim(), '12345');
});

test('launcher refuses to start the worker after a compilation failure', windows, async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'bridge/dependency.mjs'), 'export const value = ;');
  const result = await powershell(f);
  assert.equal(result.started, false); assert.match(result.error, /Voice client build failed|Build failed/);
  assert.equal(await readFile(f.output, 'utf8'), '// obsolete browser code');
  await assert.rejects(readFile(join(f.state, 'bridge.pid')), {code: 'ENOENT'});
});

test('launcher preserves duplicate protection before and after rebuilding', windows, async t => {
  for (const duplicates of [1, 3]) {
    const f = await fixture(t), result = await powershell(f, {duplicates});
    assert.equal(result.error, undefined); assert.equal(result.started, false);
    assert.equal(result.queries, duplicates === 1 ? 1 : 2);
  }
});

test('launcher restores environment overrides when hidden process creation fails', windows, async t => {
  const f = await fixture(t), result = await powershell(f, {failStart: true, explicitState: true});
  assert.match(result.error, /Fixture start failed/);
  assert.equal(result.state, f.state);
  assert.equal(result.restoredState, 'original-environment-state-path');
  assert.equal(result.restoredKey, 'original-environment-key-path');
});

test('stop control targets the same custom state and refuses duplicate workers', windows, async t => {
  const f = await fixture(t), result = await powershell(f, {action: 'stop', duplicates: 1});
  assert.equal(result.error, undefined); assert.equal(result.waited, true);
  const command = JSON.parse(await readFile(join(f.state, 'bridge-control.json'), 'utf8'));
  assert.equal(command.action, 'shutdown'); assert.equal(command.pid, 12345);
  await assert.rejects(readFile(join(f.project, 'runtime/bridge-control.json')), {code: 'ENOENT'});
  const other = await fixture(t), duplicate = await powershell(other, {action: 'stop', duplicates: 2});
  assert.match(duplicate.error, /Multiple conversation bridges/); assert.equal(duplicate.waited, false);
  await assert.rejects(readFile(join(other.state, 'bridge-control.json')), {code: 'ENOENT'});
});
