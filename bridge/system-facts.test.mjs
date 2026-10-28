import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEFENDER_SCRIPT, DISK_SCRIPT, FACTS_CACHE_FILE, FACTS_SCRIPT, MOD_LIST_LIMITS, detectModNames, detectSystemFacts, driveLetter, readWindowsFacts, resetSystemFactsCache,
  shapeWindowsFacts, systemFactsNow, systemFactsRefresh, underProgramFiles} from './system-facts.mjs';

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

test('detectSystemFacts merges the three reads (one after the other) and runs PowerShell hidden, with a timeout and the drive in the environment', async () => {
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

test('the reads run one at a time, never side by side', async () => {
  let running = 0, most = 0, total = 0;
  const run = async (file, args) => {
    running += 1; total += 1; most = Math.max(most, running);
    await new Promise(done => setTimeout(done, 15));
    running -= 1;
    const script = args.at(-1);
    return {stdout: JSON.stringify(script === FACTS_SCRIPT ? CORE : script === DEFENDER_SCRIPT ? {controlledFolderAccess: 0} : {media: 'SSD', bus: 'NVMe'})};
  };
  const windows = await readWindowsFacts({game: 'D:/Games/Cyberpunk 2077', run, platform: 'win32', env: {}});
  assert.equal(total, 3);
  assert.equal(most, 1, 'one PowerShell child at a time');
  assert.equal(windows.drive.media, 'SSD');
  // The quick read failing stops the others (nothing else is worth another process).
  total = 0;
  assert.equal(await readWindowsFacts({game: 'D:/Games', run: async () => { total += 1; throw Error('x'); }, platform: 'win32', env: {}}), null);
  assert.equal(total, 1);
});

test('the children are started at idle priority and are never given a high one', async () => {
  const source = await readFile(new URL('./system-facts.mjs', import.meta.url), 'utf8');
  assert.match(source, /setPriority\(call\.child\.pid, osConstants\.priority\.PRIORITY_LOW\)/);
  assert.ok(!/PRIORITY_(?:HIGH|ABOVE_NORMAL|HIGHEST)/.test(source));
  assert.match(source, /child\?\.unref/, 'a pending read never keeps the process alive');
});

async function stateFolder() { return mkdtemp(join(tmpdir(), 'sysfacts-state-')); }
const GAME = 'D:/Games/Cyberpunk 2077';

test('the first report does not wait: no saved copy gives the processor from Node and the mod names at once, and the read runs in the background and is saved', async () => {
  resetSystemFactsCache();
  const state = await stateFolder();
  const game = await modFolder([['red4ext/plugins/Codeware', 'dir']]);
  let release; const gate = new Promise(done => { release = done; });
  let calls = 0;
  const run = async (file, args) => {
    calls += 1; await gate;
    const script = args.at(-1);
    return {stdout: JSON.stringify(script === FACTS_SCRIPT ? CORE : script === DEFENDER_SCRIPT ? {controlledFolderAccess: 0} : {media: 'SSD', bus: 'NVMe'})};
  };
  const options = {game, stateDirectory: state, platform: 'win32', env: {}, cpus: () => [{model: 'Node CPU'}], run, refresh: true};
  try {
    const first = await systemFactsNow(options);   // resolves while the read is still held at the gate
    assert.equal(first.os.build, null, 'nothing is known of Windows yet');
    assert.deepEqual([first.cpu.name, first.mods.red4ext], ['Node CPU', ['Codeware']]);
    assert.equal(calls, 1, 'the background read has started and is waiting');
    release();
    await systemFactsRefresh();
    assert.equal(calls, 3);
    const later = await systemFactsNow(options);
    assert.deepEqual([later.os.build, later.cpu.threads, later.drive.media], [26200, 16, 'SSD']);
    const saved = JSON.parse(await readFile(join(state, FACTS_CACHE_FILE), 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.facts.os.build, 26200);
    assert.ok(!JSON.stringify(saved).includes('sysfacts'), 'no folder in the saved copy');
    // A new process (a reset session) reads the saved copy and runs nothing.
    resetSystemFactsCache(); calls = 0;
    const again = await systemFactsNow(options);
    await systemFactsRefresh();
    assert.deepEqual([again.os.build, calls], [26200, 0]);
  } finally { release(); resetSystemFactsCache(); await rm(state, {recursive: true, force: true}); await rm(game, {recursive: true, force: true}); }
});

test('a saved copy is used for 7 days; an older one is still shown while one refresh runs; another game drive or a broken file is ignored', async () => {
  const state = await stateFolder();
  const T0 = Date.UTC(2026, 9, 28);
  let calls = 0;
  const run = async () => { calls += 1; return {stdout: JSON.stringify(CORE)}; };
  const write = (at, drive = 'D', extra = {}) => writeFile(join(state, FACTS_CACHE_FILE), JSON.stringify({version: 1, at, drive,
    facts: {cpu: {name: 'Saved CPU', cores: 4, threads: 8}, os: {build: 1}, ...extra}}));
  const options = (now, game = GAME) => ({game, stateDirectory: state, platform: 'win32', env: {}, cpus: () => [], run, refresh: true, readdir: async () => [], now: () => now});
  try {
    resetSystemFactsCache(); await write(T0 - 6 * 24 * 3600 * 1000);
    const fresh = await systemFactsNow(options(T0));
    await systemFactsRefresh();
    assert.deepEqual([fresh.cpu.name, calls], ['Saved CPU', 0], 'six days old: used, nothing runs');
    resetSystemFactsCache(); await write(T0 - 8 * 24 * 3600 * 1000);
    const stale = await systemFactsNow(options(T0));
    assert.equal(stale.cpu.name, 'Saved CPU', 'eight days old: still shown at once');
    await systemFactsRefresh();
    assert.equal(calls, 3, 'and one refresh ran');
    assert.equal(JSON.parse(await readFile(join(state, FACTS_CACHE_FILE), 'utf8')).at, T0, 'the refresh is saved with its time');
    // Asked again in the same process: no second refresh.
    await systemFactsNow(options(T0 + 1000)); await systemFactsRefresh();
    assert.equal(calls, 3);
    // The game on another drive: the saved copy is not about it.
    resetSystemFactsCache(); calls = 0; await write(T0, 'C');
    const other = await systemFactsNow(options(T0));
    await systemFactsRefresh();
    assert.deepEqual([other.cpu.name, calls], [null, 3]);
    // A broken file, a copy dated far in the future and a refresh that fails.
    resetSystemFactsCache(); calls = 0; await writeFile(join(state, FACTS_CACHE_FILE), '{not json');
    assert.equal((await systemFactsNow(options(T0))).cpu.name, null);
    await systemFactsRefresh();
    resetSystemFactsCache(); calls = 0; await write(T0 + 30 * 24 * 3600 * 1000);
    await systemFactsNow(options(T0)); await systemFactsRefresh();
    assert.equal(calls, 3, 'a clock that was wrong when it was saved does not make it fresh for ever');
    resetSystemFactsCache(); await rm(join(state, FACTS_CACHE_FILE), {force: true});
    const failing = await systemFactsNow({...options(T0), run: async () => { throw Error('powershell is missing'); }});
    await systemFactsRefresh();
    assert.equal(failing.os.build, null);
    await assert.rejects(readFile(join(state, FACTS_CACHE_FILE), 'utf8'), {code: 'ENOENT'}, 'a failed read saves nothing');
  } finally { resetSystemFactsCache(); await rm(state, {recursive: true, force: true}); }
});

test('refresh: false (the test runner\'s default) and a PC that is not Windows start no process', async () => {
  const state = await stateFolder();
  let calls = 0;
  const run = async () => { calls += 1; return {stdout: '{}'}; };
  try {
    resetSystemFactsCache();
    await systemFactsNow({game: GAME, stateDirectory: state, platform: 'win32', env: {}, cpus: () => [], run, refresh: false, readdir: async () => []});
    resetSystemFactsCache();
    await systemFactsNow({game: GAME, stateDirectory: state, platform: 'linux', env: {}, cpus: () => [], run, refresh: true, readdir: async () => []});
    await systemFactsRefresh();
    assert.equal(calls, 0);
    // Under `node --test` the default is off as well.
    resetSystemFactsCache();
    if (process.env.NODE_TEST_CONTEXT) {
      await systemFactsNow({game: GAME, stateDirectory: state, platform: 'win32', env: {}, cpus: () => [], run, readdir: async () => []});
      assert.equal(calls, 0);
    }
  } finally { resetSystemFactsCache(); await rm(state, {recursive: true, force: true}); }
});
