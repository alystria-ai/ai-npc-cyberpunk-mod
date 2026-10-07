import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, cp, rm, readdir, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {readProvisionState} from '../scripts/provision-state.mjs';

const exec = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'scripts/development-files.json'), 'utf8'));
// The development scripts target PowerShell 7. Without it the installer tests
// still run under Windows PowerShell 5.1 (process-scoped execution policy only;
// nothing on the machine changes), but Set-DevelopmentBindings.ps1 needs
// ConvertFrom-Json -AsHashtable, which exists only in 7+.
const hasPwsh = (() => {
  try { execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {windowsHide: true, timeout: 30000, stdio: 'ignore'}); return true; }
  catch { return false; }
})();
const shell = hasPwsh ? ['pwsh.exe', ['-NoProfile', '-NonInteractive']] : ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']];
const skipWithoutPwsh = hasPwsh ? false : 'PowerShell 7 (pwsh.exe) is not installed; Set-DevelopmentBindings.ps1 uses ConvertFrom-Json -AsHashtable';
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''));
async function fixture(run) {
  const folder = await mkdtemp(join(tmpdir(), 'convai-development-tools-'));
  try { return await run(folder); }
  finally {
    const target = await realpath(folder), temporaryRoot = await realpath(tmpdir());
    assert.equal(dirname(target).toLowerCase(), temporaryRoot.toLowerCase());
    assert.ok(basename(target).startsWith('convai-development-tools-'));
    await rm(target, {recursive: true, force: true});
  }
}
async function put(path, data) { await mkdir(dirname(path), {recursive: true}); await writeFile(path, data); }
async function ps(folder, script, env = {}) {
  const entry = join(folder, 'test-driver.ps1');
  await writeFile(entry, "$ErrorActionPreference = 'Stop'\n" + script);
  return exec(shell[0], [...shell[1], '-File', entry], {
    windowsHide: true, timeout: 120000, maxBuffer: 100000,
    env: {...process.env, CONVAI_TEST_ROOT: folder, CONVAI_TEST_SOURCE: root, ...env},
  });
}
async function installFixture(folder) {
  const project = join(folder, 'project'), game = join(folder, 'game');
  await put(join(game, 'bin/x64/Cyberpunk2077.exe'), 'fixture, never executed');
  for (const file of manifest.files) await put(join(project, file.source), `new:${file.source}`);
  await put(join(project, 'scripts/development-files.json'), JSON.stringify(manifest));
  return {project, game};
}

test('compiler staging uses the shipped native set and excludes retired scripts', async () => fixture(async folder => {
  const {project} = await installFixture(folder), scripts = join(folder, 'stage');
  await put(join(scripts, 'CyberpunkConvai/KnowledgeState.reds'), 'retired');
  await put(join(scripts, 'CyberpunkConvai/RemovedOldFeature.reds'), 'stale staged file');
  await put(join(scripts, 'OtherMod/External.reds'), 'third party');
  await ps(folder, `Import-Module (Join-Path $env:CONVAI_TEST_SOURCE 'scripts/DevelopmentFiles.psm1') -Force
Copy-DevelopmentNativeStage -ProjectDirectory (Join-Path $env:CONVAI_TEST_ROOT 'project') -ScriptsDirectory (Join-Path $env:CONVAI_TEST_ROOT 'stage')`);
  const expected = manifest.files.filter(f => f.target.startsWith('r6/scripts/CyberpunkConvai/')).map(f => basename(f.target)).sort();
  assert.deepEqual((await readdir(join(scripts, 'CyberpunkConvai'))).sort(), expected);
  assert.equal(await readFile(join(scripts, 'OtherMod/External.reds'), 'utf8'), 'third party');
  const compiler = await readFile(join(root, 'scripts/Compile-Redscript.ps1'), 'utf8');
  assert.match(compiler, /Copy-DevelopmentNativeStage/);
  assert.match(compiler, /Where-Object \{ \$_\.Name -ine 'CyberpunkConvai' \}/);
}));

test('native install quarantines only the retired owned file and records old bytes for rollback', async () => fixture(async folder => {
  const {game} = await installFixture(folder), retired = join(game, manifest.retiredNative[0]);
  await put(retired, 'retired crash-prone code');
  await put(join(game, 'r6/scripts/OtherMod/Keep.reds'), 'user mod');
  await put(join(game, 'r6/scripts/CyberpunkConvai/Unknown.reds'), 'unknown owned-folder file');
  await put(join(game, manifest.files[0].target), 'previous working version');
  await ps(folder, `function global:Get-Process { return @() }
& (Join-Path $env:CONVAI_TEST_SOURCE 'scripts/Install-DevelopmentMod.ps1') -ProjectDirectory (Join-Path $env:CONVAI_TEST_ROOT 'project') -GameDirectory (Join-Path $env:CONVAI_TEST_ROOT 'game')`);
  await assert.rejects(readFile(retired), {code: 'ENOENT'});
  const backups = join(folder, 'project/backups'), backup = join(backups, (await readdir(backups))[0]);
  const receipt = await json(join(backup, 'manifest.json'));
  assert.equal(receipt.complete, true); assert.equal(receipt.files.length, manifest.files.length);
  assert.deepEqual(receipt.quarantined.map(f => f.path), manifest.retiredNative);
  assert.equal(await readFile(join(backup, manifest.retiredNative[0]), 'utf8'), 'retired crash-prone code');
  assert.equal(await readFile(join(backup, manifest.files[0].target), 'utf8'), 'previous working version');
  assert.equal(await readFile(join(game, 'r6/scripts/OtherMod/Keep.reds'), 'utf8'), 'user mod');
  assert.equal(await readFile(join(game, 'r6/scripts/CyberpunkConvai/Unknown.reds'), 'utf8'), 'unknown owned-folder file');
  for (const file of manifest.files) assert.equal(await readFile(join(game, file.target), 'utf8'), `new:${file.source}`);
}));

test('Lua-only install neither changes nor claims validation of native files', async () => fixture(async folder => {
  const {game} = await installFixture(folder), retired = join(game, manifest.retiredNative[0]);
  await put(retired, 'still present until closed-game native install');
  const {stdout} = await ps(folder, `function global:Get-Process { throw 'Lua-only must not query or control game processes' }
& (Join-Path $env:CONVAI_TEST_SOURCE 'scripts/Install-DevelopmentMod.ps1') -LuaOnly -ProjectDirectory (Join-Path $env:CONVAI_TEST_ROOT 'project') -GameDirectory (Join-Path $env:CONVAI_TEST_ROOT 'game')`);
  assert.equal(await readFile(retired, 'utf8'), 'still present until closed-game native install');
  assert.match(stdout, /Native files were not changed or validated/);
  for (const file of manifest.files.filter(f => f.source.endsWith('.reds'))) await assert.rejects(readFile(join(game, file.target)), {code: 'ENOENT'});
}));

test('native installer refuses a running game before writing any files', async () => fixture(async folder => {
  const {game} = await installFixture(folder);
  await assert.rejects(ps(folder, `function global:Get-Process { return [pscustomobject]@{ Id = 1 } }
& (Join-Path $env:CONVAI_TEST_SOURCE 'scripts/Install-DevelopmentMod.ps1') -ProjectDirectory (Join-Path $env:CONVAI_TEST_ROOT 'project') -GameDirectory (Join-Path $env:CONVAI_TEST_ROOT 'game')`), /Close the game/);
  await assert.rejects(readFile(join(game, manifest.files[0].target)), {code: 'ENOENT'});
}));

test('development paths reject escaping sources and arbitrary retired files', async () => fixture(async folder => {
  const {project} = await installFixture(folder);
  const changed = structuredClone(manifest); changed.files[0].source = '../outside';
  await put(join(project, 'scripts/development-files.json'), JSON.stringify(changed));
  const script = `Import-Module (Join-Path $env:CONVAI_TEST_SOURCE 'scripts/DevelopmentFiles.psm1') -Force
Get-DevelopmentFiles -ProjectDirectory (Join-Path $env:CONVAI_TEST_ROOT 'project') -GameDirectory (Join-Path $env:CONVAI_TEST_ROOT 'game')`;
  await assert.rejects(ps(folder, script), /Unsafe development manifest path/);
  changed.files = manifest.files; changed.retiredNative = ['r6/scripts/OtherMod/Keep.reds'];
  await put(join(project, 'scripts/development-files.json'), JSON.stringify(changed));
  await assert.rejects(ps(folder, script), /Unrecognized retired native component/);
}));

test('binding setup fills F7 F8 and F10 and preserves custom manager/text assignments', {skip: skipWithoutPwsh}, async () => fixture(async folder => {
  const file = join(folder, 'game/bin/x64/plugins/cyber_engine_tweaks/bindings.json');
  const initial = {CyberpunkConvai: {cyberpunk_convai_manager: 32369622321725440, cyberpunk_convai_text: 99}, OtherMod: {other: 77}};
  await put(file, JSON.stringify(initial));
  await ps(folder, `function global:Get-Process { return @() }
& (Join-Path $env:CONVAI_TEST_SOURCE 'scripts/Set-DevelopmentBindings.ps1') -GameDirectory (Join-Path $env:CONVAI_TEST_ROOT 'game')`);
  const result = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(result.CyberpunkConvai.cyberpunk_convai_manager, initial.CyberpunkConvai.cyberpunk_convai_manager);
  assert.equal(result.CyberpunkConvai.cyberpunk_convai_text, 99); assert.deepEqual(result.OtherMod, initial.OtherMod);
  for (const [action, vk] of [['voice', 0x76], ['group_text', 0x77], ['group_voice', 0x79]]) assert.equal(result.CyberpunkConvai[`cyberpunk_convai_${action}`], vk * 2 ** 48);
}));

test('binding conflicts, including same-mod assignments, fail before changing the file', {skip: skipWithoutPwsh}, async () => fixture(async folder => {
  const file = join(folder, 'game/bin/x64/plugins/cyber_engine_tweaks/bindings.json');
  const initial = JSON.stringify({CyberpunkConvai: {custom_action: 0x79 * 2 ** 48}});
  await put(file, initial);
  await assert.rejects(ps(folder, `function global:Get-Process { return @() }
& (Join-Path $env:CONVAI_TEST_SOURCE 'scripts/Set-DevelopmentBindings.ps1') -GameDirectory (Join-Path $env:CONVAI_TEST_ROOT 'game')`), /conflicts with existing binding/);
  assert.equal(await readFile(file, 'utf8'), initial);
}));

test('provisioning permits missing mapping but rejects malformed JSON, shape and I/O failure', async () => fixture(async folder => {
  const path = join(folder, 'characters.json');
  assert.deepEqual(await readProvisionState(path), {});
  await put(path, '\ufeff{"judy":"existing-character-id"}');
  assert.deepEqual(await readProvisionState(path), {judy: 'existing-character-id'});
  for (const raw of ['{bad', 'null', '[]', '{"judy":null}', '{"judy":""}']) {
    await put(path, raw); await assert.rejects(readProvisionState(path), /Invalid (JSON|mapping)/);
    assert.equal(await readFile(path, 'utf8'), raw);
  }
  await assert.rejects(readProvisionState(folder), error => error.code !== 'ENOENT');
}));
