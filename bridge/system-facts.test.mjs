import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEFENDER_SCRIPT, DISK_SCRIPT, FACTS_SCRIPT, MOD_LIST_LIMITS, cachedSystemFacts, detectModNames, detectSystemFacts, driveLetter, resetSystemFactsCache,
  shapeWindowsFacts, underProgramFiles} from './system-facts.mjs';

const CORE = {cpu: {name: 'Test CPU 9000 @ 4.0GHz', cores: 8, threads: 16},
  os: {caption: 'Microsoft Windows 11 Home', edition: 'Core', displayVersion: '25H2', build: '26200', revision: 9711, uiLanguage: 'de-DE', installLanguage: 'en-US', region: 'de-DE'},
  antivirus: [{name: 'Windows Defender', on: true}, {name: 'Other AV', on: false}], smartAppControl: 1, elevated: true,
  drive: {kind: 3, fileSystem: 'NTFS', freeGiB: 123.46, sizeGiB: 931.5}, display: {width: 2560, height: 1440, refreshHz: 165}};

test('the PowerShell scripts never ask for a user name or a folder listing, and take the drive from the environment', () => {
  for (const script of [FACTS_SCRIPT, DEFENDER_SCRIPT, DISK_SCRIPT]) {
    assert.ok(!/USERNAME|USERPROFILE|COMPUTERNAME|Get-ChildItem/i.test(script), 'no user name or folder listing in a script');
    assert.ok(/ConvertTo-Json/.test(script));
  }
  assert.ok(FACTS_SCRIPT.includes('$env:FACT_DRIVE') && DISK_SCRIPT.includes('$env:FACT_DRIVE'));
  assert.ok(/SecurityCenter2/.test(FACTS_SCRIPT) && /VerifiedAndReputablePolicyState/.test(FACTS_SCRIPT) && /IsInRole/.test(FACTS_SCRIPT));
});

test('driveLetter and underProgramFiles read the game path as written', () => {
  assert.equal(driveLetter('d:\\Games\\Cyberpunk 2077'), 'D');
  assert.equal(driveLetter('C:/Games'), 'C');
  assert.equal(driveLetter('\\\\server\\share'), null);
  assert.equal(driveLetter(undefined), null);
  const env = {ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)'};
  assert.equal(underProgramFiles('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Cyberpunk 2077', env), true);
  assert.equal(underProgramFiles('c:/program files/GOG Galaxy/Games/Cyberpunk 2077', env), true);
  assert.equal(underProgramFiles('C:\\Program Files Extra\\Cyberpunk', env), false, 'a folder that only starts with the same letters is not under it');
  assert.equal(underProgramFiles('D:\\Games\\Cyberpunk 2077', env), false);
  assert.equal(underProgramFiles('', env), null);
});

test('shapeWindowsFacts keeps what it understands and nulls the rest', () => {
  const shaped = shapeWindowsFacts({...CORE}, {game: 'D:\\Games\\Cyberpunk 2077', env: {}, defender: {controlledFolderAccess: 0}, disk: {media: 'SSD', bus: 'NVMe'}});
  assert.deepEqual(shaped.cpu, {name: 'Test CPU 9000 @ 4.0GHz', cores: 8, threads: 16});
  assert.deepEqual([shaped.os.edition, shaped.os.build, shaped.os.uiLanguage, shaped.os.displayVersion], ['Core', 26200, 'de-DE', '25H2']);
  assert.deepEqual(shaped.antivirus, [{name: 'Windows Defender', on: true}, {name: 'Other AV', on: false}]);
  assert.equal(shaped.smartAppControl, 'on');
  assert.equal(shaped.controlledFolderAccess, 'off');
  assert.equal(shaped.elevated, true);
  assert.deepEqual(shaped.drive, {letter: 'D', kind: 'fixed', fileSystem: 'NTFS', freeGiB: 123.5, sizeGiB: 932, media: 'SSD', bus: 'NVMe', underProgramFiles: false});
  assert.deepEqual(shaped.display, {width: 2560, height: 1440, refreshHz: 165});
  // A single product (PowerShell prints one object, not a list), junk values, a missing section.
  const odd = shapeWindowsFacts({antivirus: {name: 'Only AV', on: 'yes'}, smartAppControl: 'x', elevated: 'maybe', cpu: 'no', display: {width: -1}}, {game: undefined, env: {}});
  assert.deepEqual(odd.antivirus, [{name: 'Only AV', on: null}]);
  assert.deepEqual([odd.smartAppControl, odd.elevated, odd.cpu.name, odd.display.width, odd.drive.letter, odd.drive.underProgramFiles], [null, null, null, null, null, null]);
  assert.deepEqual(shapeWindowsFacts(null, {env: {}}).antivirus, []);
});

async function modFolder(layout) {
  const game = await mkdtemp(join(tmpdir(), 'sysfacts-'));
  for (const [path, kind] of layout) {
    const full = join(game, ...path.split('/'));
    if (kind === 'dir') await mkdir(full, {recursive: true});
    else { await mkdir(join(full, '..'), {recursive: true}); await writeFile(full, 'x'); }
  }
  return game;
}

test('detectModNames lists mod names one level deep, sorted, without paths or hidden entries', async () => {
  const game = await modFolder([
    ['bin/x64/plugins/cyber_engine_tweaks/mods/zeta_mod', 'dir'], ['bin/x64/plugins/cyber_engine_tweaks/mods/AppearanceMenuMod', 'dir'], ['bin/x64/plugins/cyber_engine_tweaks/mods/.hidden', 'dir'],
    ['bin/x64/plugins/cyber_engine_tweaks/mods/readme.txt', 'file'],
    ['red4ext/plugins/Codeware', 'dir'], ['red4ext/plugins/ArchiveXL', 'dir'],
    ['r6/scripts/MyMod', 'dir'], ['r6/scripts/loose.reds', 'file'], ['r6/scripts/notes.txt', 'file'],
    ['archive/pc/mod/b.archive', 'file'], ['archive/pc/mod/a.archive', 'file'], ['archive/pc/mod/a.archive.xl', 'file'],
    ['mods/SomeRedmod', 'dir'], ['r6/tweaks/x.yaml', 'file'], ['bin/x64/plugins/a.asi', 'file'], ['bin/x64/plugins/b.dll', 'file']]);
  try {
    const found = await detectModNames({game});
    assert.deepEqual(found.cet, ['AppearanceMenuMod', 'zeta_mod']);
    assert.deepEqual(found.red4ext, ['ArchiveXL', 'Codeware']);
    assert.deepEqual(found.scripts, ['loose.reds', 'MyMod']);
    assert.deepEqual(found.archives, ['a.archive', 'b.archive']);
    assert.deepEqual(found.redmod, ['SomeRedmod']);
    assert.deepEqual(found.tweaks, ['x.yaml']);
    assert.deepEqual(found.plugins, ['a.asi', 'b.dll']);
    assert.deepEqual(found.more, {});
    assert.ok(!JSON.stringify(found).includes('sysfacts-'), 'no folder path in the names');
  } finally { await rm(game, {recursive: true, force: true}); }
  const none = await detectModNames({game: join(tmpdir(), 'sysfacts-not-there')});
  assert.deepEqual([none.cet, none.archives, none.more], [[], [], {}]);
  assert.deepEqual((await detectModNames({game: undefined})).cet, []);
});

test('a very long mod list is cut and says how many names were left out', async () => {
  const entries = Array.from({length: MOD_LIST_LIMITS.red4ext + 7}, (_, index) => [`red4ext/plugins/p${String(index).padStart(3, '0')}`, 'dir']);
  const game = await modFolder(entries);
  try {
    const found = await detectModNames({game});
    assert.equal(found.red4ext.length, MOD_LIST_LIMITS.red4ext);
    assert.deepEqual(found.more, {red4ext: 7});
  } finally { await rm(game, {recursive: true, force: true}); }
});

function fakeRun(answers, calls = []) {
  return async (file, args, options) => {
    const script = args.at(-1);
    calls.push({file, args, options});
    const key = script === FACTS_SCRIPT ? 'core' : script === DEFENDER_SCRIPT ? 'defender' : 'disk';
    const answer = answers[key];
    if (answer instanceof Error) throw answer;
    return {stdout: `noise\r\n${JSON.stringify(answer)}\r\n`};
  };
}

test('detectSystemFacts merges the three reads and runs PowerShell hidden, with a timeout and the drive in the environment', async () => {
  const calls = [];
  const game = await modFolder([['red4ext/plugins/Codeware', 'dir']]);
  try {
    const facts = await detectSystemFacts({game, platform: 'win32', env: {SystemRoot: 'C:\\Windows'}, cpus: () => [],
      run: fakeRun({core: CORE, defender: {controlledFolderAccess: 1}, disk: {media: 'HDD', bus: 'SATA'}}, calls)});
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.ok(call.file.endsWith('powershell.exe'));
      assert.equal(call.options.windowsHide, true);
      assert.ok(call.options.timeout > 0 && call.options.timeout <= 60_000);
      assert.ok(call.args.includes('-NoProfile') && call.args.includes('-NonInteractive'));
    }
    assert.equal(calls[0].options.env.FACT_DRIVE, game[0].toUpperCase());
    assert.equal(facts.cpu.threads, 16);
    assert.equal(facts.controlledFolderAccess, 'on');
    assert.deepEqual([facts.drive.media, facts.drive.bus], ['HDD', 'SATA']);
    assert.deepEqual(facts.mods.red4ext, ['Codeware']);
  } finally { await rm(game, {recursive: true, force: true}); }
});

test('a slow read that fails loses only its own field; every read failing still gives the processor from Node and the mod names', async () => {
  const game = await modFolder([['archive/pc/mod/a.archive', 'file']]);
  try {
    const partial = await detectSystemFacts({game, platform: 'win32', env: {}, cpus: () => [], run: fakeRun({core: CORE, defender: new Error('timed out'), disk: new Error('timed out')})});
    assert.equal(partial.os.build, 26200);
    assert.deepEqual([partial.controlledFolderAccess, partial.drive.media, partial.drive.freeGiB], [null, null, 123.5]);
    const none = await detectSystemFacts({game, platform: 'win32', env: {}, cpus: () => [{model: 'Node CPU'}, {model: 'Node CPU'}],
      run: fakeRun({core: new Error('no powershell'), defender: new Error('x'), disk: new Error('x')})});
    assert.deepEqual([none.cpu.name, none.cpu.threads, none.os.build, none.antivirus], ['Node CPU', 2, null, []]);
    assert.deepEqual(none.mods.archives, ['a.archive']);
    // Garbage on stdout is a failed read, not a crash.
    const junk = await detectSystemFacts({game, platform: 'win32', env: {}, cpus: () => [], run: async () => ({stdout: 'not json'})});
    assert.equal(junk.os.build, null);
    // Off Windows PowerShell is not called at all.
    let called = false;
    const linux = await detectSystemFacts({game, platform: 'linux', env: {}, cpus: () => [], run: async () => { called = true; return {stdout: '{}'}; }});
    assert.equal(called, false);
    assert.deepEqual(linux.mods.archives, ['a.archive']);
    // Even a listing that throws gives a result.
    const broken = await detectSystemFacts({game, platform: 'linux', env: {}, cpus: () => { throw Error('no cpus'); }, readdir: async () => { throw Error('denied'); }});
    assert.equal(broken.cpu.name, null);
    assert.deepEqual(broken.mods.cet, []);
  } finally { await rm(game, {recursive: true, force: true}); }
});

test('cachedSystemFacts reads once per process', async () => {
  resetSystemFactsCache();
  let reads = 0;
  const run = async () => { reads += 1; return {stdout: JSON.stringify(CORE)}; };
  const options = {game: undefined, platform: 'win32', env: {}, cpus: () => [], run};
  const first = await cachedSystemFacts(options);
  const second = await cachedSystemFacts(options);
  assert.equal(first, second);
  assert.equal(reads, 2, 'the quick read and the Defender read; no game drive, so no disk read');
  resetSystemFactsCache();
});
