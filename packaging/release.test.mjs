// Source tests for the release pipeline (node --test packaging/release.test.mjs).
// They need no downloads, models or secrets; the full build is checked by
// packaging/test-release-install.mjs against real packages.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipWriter, listZip} from './lib/zip.mjs';
import {sha256Buffer, walk} from './lib/files.mjs';
import {checkLuaPartition, importClosure} from './lib/closure.mjs';
import {chooseKeyFile, installLayout, MANAGED_FILES, pocketConfigFor, prepareState, serviceEnvironment} from './runtime/prepare-state.mjs';
import {assembleParts} from './runtime/assemble-parts.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(project, 'packaging/release.config.json'), 'utf8'));
const temporary = async () => mkdtemp(join(tmpdir(), 'convai release test '));

test('archives are deterministic, readable by tar and keep stored weights uncompressed', async () => {
  const directory = await temporary();
  try {
    const source = join(directory, 'weights.safetensors');
    await writeFile(source, Buffer.alloc(300_000, 7));
    const build = async name => {
      const zip = await ZipWriter.create(join(directory, name), {timestamp: new Date(Date.UTC(2026, 9, 8))});
      await zip.add('a/text.txt', {buffer: Buffer.from('hello '.repeat(1000))});
      await zip.add('a/weights.safetensors', {source});
      await zip.add('a/part2', {source, start: 100_000, length: 50_000});
      return zip.close();
    };
    await build('one.zip'); await build('two.zip');
    const one = await readFile(join(directory, 'one.zip')), two = await readFile(join(directory, 'two.zip'));
    assert.equal(sha256Buffer(one), sha256Buffer(two));
    const entries = await listZip(join(directory, 'one.zip'));
    assert.deepEqual(entries.map(entry => [entry.name, entry.method, entry.uncompressed]),
      [['a/text.txt', 8, 6000], ['a/weights.safetensors', 0, 300_000], ['a/part2', 8, 50_000]]);
    await mkdir(join(directory, 'x'));
    const tar = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    assert.equal(spawnSync(tar, ['-xf', join(directory, 'one.zip'), '-C', join(directory, 'x')]).status, 0);
    assert.equal((await readFile(join(directory, 'x/a/text.txt'), 'utf8')).length, 6000);
    assert.equal((await readFile(join(directory, 'x/a/part2'))).length, 50_000);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('archive names are validated and never duplicated', async () => {
  const directory = await temporary();
  try {
    const zip = await ZipWriter.create(join(directory, 'n.zip'));
    await zip.add('ok/file.txt', {buffer: Buffer.from('x')});
    await assert.rejects(zip.add('OK/FILE.txt', {buffer: Buffer.from('x')}), /Duplicate/);
    await assert.rejects(zip.add('../escape.txt', {buffer: Buffer.from('x')}), /Invalid/);
    await assert.rejects(zip.add('C:/abs.txt', {buffer: Buffer.from('x')}), /Invalid/);
    await zip.close();
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the Lua partition ships every loaded module and leaves development probes out', async () => {
  const lua = (await walk(resolve(project, 'mod'))).filter(rel => rel.endsWith('.lua'));
  const {shipped, excluded} = await checkLuaPartition(resolve(project, 'mod'), lua, config.devOnlyLua);
  assert(shipped.includes('init.lua') && shipped.includes('movement-log.lua'));
  assert(shipped.some(rel => rel.startsWith('locales/')));
  assert.deepEqual([...excluded].sort(), lua.filter(rel => config.devOnlyLua.includes(rel)).sort());
  assert(!shipped.includes('diagnostics.lua'));
  // init.lua loads the diagnostics only on request, through pcall.
  assert.match(await readFile(resolve(project, 'mod/init.lua'), 'utf8'), /pcall\(dofile, 'diagnostics\.lua'\)/);
});

test('the bridge closure is complete, test-free and includes the supervisor and report modules', async () => {
  const closure = await importClosure(project, config.bridgeEntries);
  for (const required of ['bridge/convai-bridge.mjs', 'bridge/bridge-supervisor.mjs', 'bridge/guarded-file.mjs',
    'bridge/jali-face-worker.mjs', 'bridge/jali-face-text.mjs', 'bridge/support-report.mjs', 'bridge/zip-writer.mjs',
    'bridge/runtime-paths.mjs']) assert(closure.includes(required), required);
  assert(!closure.some(file => /\.test\.mjs$|fixture/.test(file)));
  for (const worker of config.bridgeWorkers) assert((await readdir(resolve(project, 'bridge'))).includes(worker.slice(7)), worker);
});

test('pinned toolchain entries are official HTTPS downloads with SHA-256 values', () => {
  for (const name of ['node', 'python', 'omniPython', 'browser']) {
    const item = config.toolchain[name];
    assert.match(item.url, /^https:\/\/(?:nodejs\.org|www\.python\.org|storage\.googleapis\.com\/chrome-for-testing-public)\//, name);
    assert.match(item.sha256, /^[a-f0-9]{64}$/, name);
  }
  for (const spec of Object.values(config.toolchain.omniModel.files)) assert.match(spec.sha256, /^[a-f0-9]{64}$/);
  assert(config.limits.assetBytes < 2 * 1024 ** 3);
});

test('Python locks pin every wheel by URL and hash', async () => {
  for (const name of ['pocket', 'omni']) {
    const lines = (await readFile(resolve(project, `packaging/python/${name}.lock.txt`), 'utf8')).split(/\r?\n/)
      .filter(line => line && !line.startsWith('#'));
    const pins = (await readFile(resolve(project, `packaging/python/${name}.in`), 'utf8')).split(/\r?\n/)
      .filter(line => line && !line.startsWith('#'));
    assert.equal(lines.length, pins.length, name);
    for (const line of lines) assert.match(line, /^[A-Za-z0-9_.-]+ @ https:\/\/\S+\.whl --hash=sha256:[a-f0-9]{64}$/, line);
  }
});

async function fakeInstall() {
  const root = await temporary();
  const game = join(root, 'Cyberpunk 2077 Ünïcode');
  const app = join(game, 'red4ext/plugins/CyberpunkConvai/app');
  await mkdir(join(app, 'defaults'), {recursive: true});
  await writeFile(join(app, 'defaults/pocket-voices.autobest.json'), JSON.stringify({version: 1, provider: 'pocket',
    engine: 'pocket-tts', runtime: {note: 'filled in'}, referenceRegistry: {path: 'C:\\dev'}, voices: {}}));
  for (const name of MANAGED_FILES) await writeFile(join(app, 'defaults', name), JSON.stringify({name, v: 1}));
  await mkdir(join(app, 'models/lipsync'), {recursive: true});
  await writeFile(join(app, 'models/lipsync/face-model.json'), '{}');
  return {root, game, app, layout: installLayout({appDirectory: app, gameRoot: game})};
}

test('state preparation fills install paths, follows managed defaults and keeps edits', async () => {
  const f = await fakeInstall();
  try {
    const first = await prepareState(f.layout);
    assert.equal(first.omni, false);
    const pocket = JSON.parse(await readFile(join(f.layout.state, 'pocket-voices.autobest.json'), 'utf8'));
    assert.equal(pocket.runtime.pythonExecutable, f.layout.python);
    assert.equal(pocket.runtime.referenceDirectory, f.layout.voices);
    assert.equal(pocket.runtime.workDirectory, join(f.layout.state, 'pocket-voice-work'));
    assert.equal(pocket.referenceRegistry, undefined);
    assert.equal(await readFile(join(f.layout.state, 'lipsync-model/face-model.json'), 'utf8'), '{}');
    assert.deepEqual(JSON.parse(await readFile(join(f.layout.state, 'voice-configs.json'), 'utf8')).omni,
      {short: 'local-voices.autobest-short.json', long: 'local-voices.autobest-long.json'});
    // A new package version updates untouched managed files but never an edited one.
    await writeFile(join(f.layout.state, 'relationship-profiles.json'), '{"mine":true}');
    for (const name of MANAGED_FILES) await writeFile(join(f.app, 'defaults', name), JSON.stringify({name, v: 2}));
    await prepareState(f.layout);
    assert.equal(JSON.parse(await readFile(join(f.layout.state, 'characters.json'), 'utf8')).v, 2);
    assert.deepEqual(JSON.parse(await readFile(join(f.layout.state, 'relationship-profiles.json'), 'utf8')), {mine: true});
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test("the player's own key wins over the packaged one, and a missing key stays visible", async () => {
  const f = await fakeInstall();
  try {
    await prepareState(f.layout);
    assert.equal(await chooseKeyFile(f.layout), join(f.layout.state, 'convai-key.txt'));
    await writeFile(join(f.app, 'defaults/service.txt'), 'api-key = packaged-test-value\n');
    assert.equal(await chooseKeyFile(f.layout), join(f.app, 'defaults/service.txt'));
    await writeFile(join(f.layout.state, 'convai-key.txt'), 'api-key = own-test-value\n');
    assert.equal(await chooseKeyFile(f.layout), join(f.layout.state, 'convai-key.txt'));
    await writeFile(join(f.layout.state, 'convai-key.txt'), 'not a key');
    assert.equal(await chooseKeyFile(f.layout), join(f.app, 'defaults/service.txt'));
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test('the service environment names every runtime path and clears inherited overrides', async () => {
  const f = await fakeInstall();
  try {
    const env = serviceEnvironment(f.layout, {omni: false, keyFile: 'K'}, {PATH: 'x', NODE_OPTIONS: '--inspect', PYTHONPATH: 'y',
      CYBERPUNK_CONVAI_PYTHON: 'C:\\old\\python.exe'});
    assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.PYTHONPATH, undefined);
    assert.equal(env.CYBERPUNK_CONVAI_PYTHON, undefined);
    assert.equal(env.CYBERPUNK_CONVAI_BROWSER, f.layout.browser);
    const omni = serviceEnvironment(f.layout, {omni: true, keyFile: 'K'}, {});
    assert.equal(omni.CYBERPUNK_CONVAI_PYTHON, f.layout.omniPython);
    assert.equal(omni.CYBERPUNK_CONVAI_OMNI_REFERENCES, f.layout.voices);
    assert(!omni.CYBERPUNK_CONVAI_OMNI_REFERENCES.startsWith(f.layout.app));
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test('split files are joined, verified and their parts removed', async () => {
  const directory = await temporary();
  try {
    const whole = Buffer.alloc(10_000); for (let i = 0; i < whole.length; i++) whole[i] = i % 251;
    const parts = [whole.subarray(0, 4000), whole.subarray(4000, 8000), whole.subarray(8000)];
    for (const [i, part] of parts.entries()) await writeFile(join(directory, `m.bin.part${i + 1}`), part);
    const manifest = {file: 'm.bin', size: whole.length, sha256: sha256Buffer(whole),
      parts: parts.map((part, i) => ({name: `m.bin.part${i + 1}`, size: part.length, sha256: sha256Buffer(part)}))};
    await writeFile(join(directory, 'm.bin.parts.json'), JSON.stringify(manifest));
    assert.deepEqual(await assembleParts(directory), [{file: 'm.bin', state: 'joined'}]);
    assert(whole.equals(await readFile(join(directory, 'm.bin'))));
    assert.deepEqual((await readdir(directory)).sort(), ['m.bin', 'm.bin.parts.json', 'm.bin.verified']);
    assert.deepEqual(await assembleParts(directory), [{file: 'm.bin', state: 'ready'}]);
    await writeFile(join(directory, 'm.bin.part1'), parts[0]);
    await assert.rejects(assembleParts(directory), /missing parts/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the Pocket template gets absolute paths for this installation only', () => {
  const layout = installLayout({appDirectory: 'D:\\Games\\CP\\red4ext\\plugins\\CyberpunkConvai\\app', gameRoot: 'D:\\Games\\CP'});
  const config = pocketConfigFor({version: 1, runtime: {note: 'x'}, proposal: {}, referenceRegistry: {}}, layout);
  assert.deepEqual(Object.keys(config.runtime).sort(), ['exportDirectory', 'pythonExecutable', 'referenceDirectory', 'sourceDirectory', 'workDirectory']);
  assert.equal(config.proposal, undefined);
  assert(config.runtime.workDirectory.startsWith(layout.state));
});

test('player-facing text never mentions credentials or keys', async () => {
  const readme = await readFile(resolve(project, 'packaging/PLAYER_README.md'), 'utf8');
  assert.doesNotMatch(readme, /\b(?:api[- ]?key|key|token|secret|credential)s?\b/i);
});

test('the project licence keeps Convai selectable and the notices cover the bundled components', async () => {
  const licence = await readFile(resolve(project, 'LICENSE'), 'utf8');
  assert.match(licence, /user-selectable Convai integration/);
  assert.match(licence, /Copyright \(c\) 2026 Alystria AI/);
  const notices = await readFile(resolve(project, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const name of ['AGPL-3.0', 'CC-BY-NC', 'Chrome for Testing', 'Node.js', 'CPython', 'BSD-2-Clause', 'espeak-ng', 'CC-BY-4.0', 'Kyutai']) {
    assert(notices.includes(name), `THIRD_PARTY_NOTICES.md must mention ${name}`);
  }
});
