import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {asciiTempEnvironment, isAsciiText, shortPathOf} from './ascii-temp.mjs';
import {AudioOutputWatch} from './audio-delay.mjs';

const options = extra => ({remember: false, ...extra});

test('an ASCII temporary folder, or any other system, changes nothing and runs nothing', () => {
  const never = () => { throw Error('must not run'); };
  assert.deepEqual(asciiTempEnvironment(options({tmpDir: 'C:\\Users\\akshi\\AppData\\Local\\Temp', platform: 'win32', short: never, makeFolder: never})), {});
  assert.deepEqual(asciiTempEnvironment(options({tmpDir: '/tmp/Игры', platform: 'linux', short: never, makeFolder: never})), {});
  assert.deepEqual(asciiTempEnvironment(options({tmpDir: 'C:\\Users\\Ivan Petrov\\Temp', platform: 'win32', short: never, makeFolder: never})), {}, 'spaces are ASCII');
});

test('a Cyrillic, Chinese or accented temporary folder gives its 8.3 short name as TEMP and TMP', () => {
  for (const user of ['Игорь', '张伟', 'José Ñ', 'Łukasz']) {
    const tmpDir = `C:\\Users\\${user}\\AppData\\Local\\Temp`, asked = [];
    const result = asciiTempEnvironment(options({tmpDir, platform: 'win32', short: folder => { asked.push(folder); return 'C:\\Users\\B5F3~1\\AppData\\Local\\Temp'; }, exists: () => true}));
    assert.deepEqual(result, {TEMP: 'C:\\Users\\B5F3~1\\AppData\\Local\\Temp', TMP: 'C:\\Users\\B5F3~1\\AppData\\Local\\Temp'});
    assert.deepEqual(asked, [tmpDir]);
  }
});

test('without a usable short name (8.3 names off) a folder under the Public profile is used; with neither, nothing changes', () => {
  const tmpDir = 'C:\\Users\\张伟\\AppData\\Local\\Temp', made = [];
  const common = {tmpDir, platform: 'win32', environment: {PUBLIC: 'C:\\Users\\Public'}, makeFolder: folder => made.push(folder), exists: folder => made.includes(folder)};
  const viaPublic = asciiTempEnvironment(options({...common, short: () => null}));
  assert.deepEqual(viaPublic, {TEMP: 'C:\\Users\\Public\\AiNpcCyberpunkMod-temp', TMP: 'C:\\Users\\Public\\AiNpcCyberpunkMod-temp'});
  // a short name that is itself not ASCII (the volume has no 8.3 names: cmd echoes the long name) is not taken
  assert.deepEqual(asciiTempEnvironment(options({...common, short: () => tmpDir})), viaPublic);
  assert.deepEqual(asciiTempEnvironment(options({...common, short: () => null, makeFolder: () => { throw Error('EACCES'); }, exists: () => false})), {});
  assert.deepEqual(asciiTempEnvironment(options({...common, environment: {PUBLIC: 'D:\\Публичные'}, short: () => null, exists: () => true})), {},
    'a Public profile that is not ASCII either gives no help');
});

test('the answer for one temporary folder is worked out once', () => {
  let calls = 0;
  const tmpDir = 'C:\\Users\\Игорь-once\\Temp', short = () => { calls++; return 'C:\\Users\\ONCE~1\\Temp'; };
  const first = asciiTempEnvironment({tmpDir, platform: 'win32', short, exists: () => true});
  const second = asciiTempEnvironment({tmpDir, platform: 'win32', short, exists: () => true});
  assert.equal(calls, 1); assert.equal(first, second);
});

test('isAsciiText accepts printable ASCII only', () => {
  assert.equal(isAsciiText('C:\\Users\\Ivan Petrov\\Temp'), true);
  for (const text of ['C:\\Игры', 'C:\\张伟', 'C:\\José', 'a\tb', 'a\nb']) assert.equal(isAsciiText(text), false, text);
});

test('shortPathOf passes the folder in the environment, never the command line, and refuses anything that is not a plain ASCII answer', () => {
  const seen = [];
  const run = answer => (command, args, opts) => { seen.push({command, args, env: opts.env.CONVAI_LONG_PATH}); if (answer instanceof Error) throw answer; return answer; };
  assert.equal(shortPathOf('C:\\Users\\Игорь\\Temp', {platform: 'win32', run: run('C:\\Users\\B5F3~1\\Temp\r\n')}), 'C:\\Users\\B5F3~1\\Temp');
  assert.equal(seen[0].env, 'C:\\Users\\Игорь\\Temp');
  assert.ok(!seen[0].args.join(' ').includes('Игорь'), 'the folder is not in the arguments');
  assert.equal(shortPathOf('C:\\Users\\Игорь\\Temp', {platform: 'win32', run: run('C:\\Users\\Игорь\\Temp')}), null);
  assert.equal(shortPathOf('C:\\Users\\Игорь\\Temp', {platform: 'win32', run: run('')}), null);
  assert.equal(shortPathOf('C:\\Users\\Игорь\\Temp', {platform: 'win32', run: run(Error('boom'))}), null);
  assert.equal(shortPathOf('/tmp/x', {platform: 'linux', run: run('x')}), null);
});

// Windows only: the real 8.3 lookup on a folder with a Cyrillic and a Chinese name (skipped where 8.3 names are off for the volume).
test('on Windows a real non-ASCII folder gets a short name that is the same folder', {skip: process.platform !== 'win32'}, t => {
  const root = mkdtempSync(join(tmpdir(), 'ascii-temp-'));
  try {
    const folder = join(root, 'Игры 张伟');
    mkdirSync(folder);
    const short = shortPathOf(folder);
    if (short === null) { t.skip('8.3 names are off for this volume'); return; }
    assert.ok(isAsciiText(short), short);
    mkdirSync(join(short, 'inside'));
    assert.ok(!isAsciiText(folder));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// The PowerShell probe of bridge/audio-delay.mjs compiles a helper with Add-Type, which cannot write under a TEMP that is not ASCII
// (checked with Cyrillic and Chinese folders, 2026-10-21): it then gets an ASCII TEMP and TMP. An ASCII temporary folder adds no option.
function fakeProbe() {
  const spawns = [];
  const spawnFn = (command, args, spawnOptions) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stdin = {end() {}}; child.kill = () => {};
    spawns.push({command, args, options: spawnOptions, child}); return child;
  };
  return {spawns, spawnFn};
}
const watchWith = (probe, tempEnvironment) => new AudioOutputWatch({spawnFn: probe.spawnFn, platform: 'win32', tempEnvironment, setTimeoutFn: () => 1, clearTimeoutFn: () => {}});

test('the audio probe gets an ASCII TEMP only when the real one is not ASCII', () => {
  const plain = fakeProbe();
  watchWith(plain, () => ({})).start();
  assert.deepEqual(Object.keys(plain.spawns[0].options).sort(), ['stdio', 'windowsHide'], 'no env option for an ASCII temporary folder');
  const moved = fakeProbe();
  watchWith(moved, () => ({TEMP: 'C:\\Users\\B5F3~1\\Temp', TMP: 'C:\\Users\\B5F3~1\\Temp'})).start();
  const {env} = moved.spawns[0].options;
  assert.equal(env.TEMP, 'C:\\Users\\B5F3~1\\Temp'); assert.equal(env.TMP, 'C:\\Users\\B5F3~1\\Temp');
  assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path, 'the rest of the environment is inherited');
  const broken = fakeProbe();
  watchWith(broken, () => { throw Error('no'); }).start();
  assert.equal(broken.spawns.length, 1, 'a failing helper never stops the probe');
  assert.equal(broken.spawns[0].options.env, undefined);
});
