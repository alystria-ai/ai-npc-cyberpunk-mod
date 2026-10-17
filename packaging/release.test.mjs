// Source tests for the release pipeline (node --test packaging/release.test.mjs).
// They need no downloads, models or secrets; the full build is checked by
// packaging/test-release-install.mjs against real packages.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
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
import {packagedKeyText} from './lib/packaged-key.mjs';
import {readKeyFileText} from '../bridge/key-codec.mjs';

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
  const app = join(game, 'red4ext/plugins/AiNpcCyberpunkMod/app');
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
    await writeFile(join(f.layout.state, 'multilingual-profiles.json'), '{"mine":true}');
    for (const name of MANAGED_FILES) await writeFile(join(f.app, 'defaults', name), JSON.stringify({name, v: 2}));
    await prepareState(f.layout);
    assert.equal(JSON.parse(await readFile(join(f.layout.state, 'characters.json'), 'utf8')).v, 2);
    assert.deepEqual(JSON.parse(await readFile(join(f.layout.state, 'multilingual-profiles.json'), 'utf8')), {mine: true});
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

test('the packaged Convai key is scrambled: no plain key line, round-trips, and is accepted as the packaged key', async () => {
  const fake = 'packaged-fixture-value-0123456789';
  const packed = await packagedKeyText(project, fake);
  assert(!packed.includes(fake) && !/api-key/i.test(packed), 'no greppable key line');
  assert.deepEqual(readKeyFileText(packed), {key: fake, packed: true});
  const f = await fakeInstall();
  try {
    await prepareState(f.layout);
    await writeFile(join(f.app, 'defaults/service.txt'), packed);
    assert.equal(await chooseKeyFile(f.layout), join(f.app, 'defaults/service.txt'), 'the launcher accepts the packed file');
    // A player's own plain key still wins over it, and a damaged packed file falls back to the player path.
    await writeFile(join(f.layout.state, 'convai-key.txt'), 'api-key = own-test-value\n');
    assert.equal(await chooseKeyFile(f.layout), join(f.layout.state, 'convai-key.txt'));
    await rm(join(f.layout.state, 'convai-key.txt'));
    await writeFile(join(f.app, 'defaults/service.txt'), 'convai-key-v1 !!!');
    assert.equal(await chooseKeyFile(f.layout), join(f.layout.state, 'convai-key.txt'));
  } finally { await rm(f.root, {recursive: true, force: true}); }
  // The builder writes it through this helper and nowhere else.
  const builder = await readFile(resolve(project, 'packaging/build-release.mjs'), 'utf8');
  assert.match(builder, /packagedKeyText\(source\.root, key\)/);
  assert.doesNotMatch(builder, /api-key = \$\{key\}/);
});

test('the daily-limit override cannot be inherited by the packaged service', async () => {
  const f = await fakeInstall();
  try {
    const env = serviceEnvironment(f.layout, {omni: false, keyFile: 'K'}, {PATH: 'x', CYBERPUNK_CONVAI_DAILY_LIMIT: 'off'});
    assert.equal(env.CYBERPUNK_CONVAI_DAILY_LIMIT, undefined);
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
  const layout = installLayout({appDirectory: 'D:\\Games\\CP\\red4ext\\plugins\\AiNpcCyberpunkMod\\app', gameRoot: 'D:\\Games\\CP'});
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

test('release versions follow 0.N with 0.N.M hotfixes (legacy 2077.N still accepted) and the workflow accepts the same forms', async () => {
  const {isReleaseVersion, npmVersion} = await import('./lib/version.mjs');
  for (const good of ['0.1', '0.2', '0.10', '0.2.1', '0.2-rc.1', '0.2.1-rc.2', '2077.1', '2077.1.1']) assert(isReleaseVersion(good), good);
  for (const bad of ['0', 'v0.2', '0.', '0.2.', '0.2.1.1.1', '0.2-', 'latest', '']) assert(!isReleaseVersion(bad), bad);
  assert.equal(npmVersion('0.2'), '0.2.0');
  assert.equal(npmVersion('0.10'), '0.10.0');
  assert.equal(npmVersion('0.2.1'), '0.2.1');
  assert.equal(npmVersion('0.2-rc.1'), '0.2.0-rc.1');
  assert.equal(npmVersion('0.2.1.1'), '0.2.1-1');
  assert.equal(npmVersion('2077.1'), '2077.1.0');
  const workflow = await readFile(resolve(project, '.github/workflows/release.yml'), 'utf8');
  assert(workflow.includes("- 'v[0-9]+.[0-9]+'") && workflow.includes("- 'v[0-9]+.[0-9]+.[0-9]+'"), 'tag filters for v0.2 and v0.2.1');
  assert(workflow.includes(String.raw`'^\d+(\.\d+){1,3}([-+][0-9A-Za-z.-]+)?$'`), 'the workflow version check matches lib/version.mjs');
  // A publish always marks the newest build as the latest release.
  assert(/'--latest'/.test(workflow), 'the workflow marks the published release as Latest');
});

test('developer-only folders never feed a package', () => {
  const sources = [...config.catalogs.map(item => item.source), ...config.appData, ...config.bridgeEntries, ...config.bridgeWorkers,
    ...config.releaseData.archives.map(item => item.source)];
  for (const source of sources) assert(!/^(?:misc|vendor|runtime|ref mods)\//.test(source), source);
});

// ---------------------------------------------------------------- native plugin and Local AI packs (docs/PACKAGING.md)
test('the native plugin ships beside its own licences, and the systems not yet proven live start off', () => {
  assert.equal(config.layout.nativeDirectory, 'red4ext/plugins/AiNpcCyberpunkModNative');
  assert.equal(config.layout.nativeDll, 'CyberpunkConvaiNative.dll');
  // The plugin reads runtime/native-off.txt of the mod folder (native/core/src/core/Paths.cpp); a missing file means all on.
  assert.equal(config.native.offFile, `${config.layout.modDirectory}/runtime/native-off.txt`);
  assert.deepEqual(config.native.off, ['actuator', 'vehicles', 'chauffeur', 'passage', 'faces']);
  for (const rel of Object.values(config.native.licences)) assert(existsSync(resolve(project, rel)), rel);
});

test('Local AI downloads pin every file by revision, size and hash, and the licences are Apache-2.0 or MIT', async () => {
  const spec = config.localAi;
  assert.match(spec.server.url, /^https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download\/b\d+\/llama-b\d+-bin-win-vulkan-x64\.zip$/);
  assert(spec.server.url.includes(`/${spec.server.version}/llama-${spec.server.version}-`));
  assert.equal(spec.server.license, 'MIT');
  for (const name of spec.server.require) assert(!spec.server.drop.includes(name), `${name} is required, so it cannot be dropped`);
  for (const [label, item] of [['embed', spec.embed], ['standard', spec.tiers.standard], ['lite', spec.tiers.lite]]) {
    assert.match(item.sha256, /^[a-f0-9]{64}$/, label);
    assert.match(item.revision, /^[a-f0-9]{40}$/, label);
    assert(Number.isInteger(item.size) && item.size > 1_000_000, label);
    assert.match(item.file, /\.gguf$/, label);
    assert.equal(item.license, 'Apache-2.0', label);
  }
  assert.match(spec.server.sha256, /^[a-f0-9]{64}$/);
  assert.equal(spec.tiers.standard.name, 'Gemma 4 E4B');
  assert.equal(spec.tiers.lite.name, 'Bonsai 2 4B');
  assert.equal(spec.embed.dim, 384);
  // The standard model is over 4 GiB and ships whole in a ZIP64 zip (no parts); the lite model is well under it.
  assert(spec.tiers.standard.size > 0xFFFFFFFF && spec.tiers.lite.size < 0xF0000000);
  for (const name of ['Apache-2.0.txt', 'llama.cpp-MIT.txt']) assert(existsSync(resolve(project, 'packaging/licenses', name)), name);
  assert.match(await readFile(resolve(project, 'packaging/licenses/Apache-2.0.txt'), 'utf8'), /Apache License\s+Version 2\.0/);
  assert.match(await readFile(resolve(project, 'packaging/licenses/llama.cpp-MIT.txt'), 'utf8'), /MIT License/);
});

test('GGUF models and their split parts are stored, not deflated', async () => {
  const directory = await temporary();
  try {
    const source = join(directory, 'm.gguf');
    await writeFile(source, Buffer.alloc(200_000, 3));
    const zip = await ZipWriter.create(join(directory, 'g.zip'));
    await zip.add('a/m.gguf', {source});
    await zip.add('a/m.gguf.part2', {source, start: 1000, length: 5000});
    await zip.add('a/notes.txt', {buffer: Buffer.from('x'.repeat(5000))});
    await zip.close();
    assert.deepEqual((await listZip(join(directory, 'g.zip'))).map(entry => [entry.name, entry.method]),
      [['a/m.gguf', 0], ['a/m.gguf.part2', 0], ['a/notes.txt', 8]]);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the packaged service points the bridge at the Local AI pack and ignores a developer folder', async () => {
  const f = await fakeInstall();
  try {
    assert.equal(f.layout.localAi, join(f.app, 'local-ai'));
    const env = serviceEnvironment(f.layout, {omni: false, keyFile: 'K'}, {CYBERPUNK_CONVAI_LOCAL_AI_DEV: 'E:\dev', CYBERPUNK_CONVAI_LOCAL_SERVER: 'x.exe',
      CYBERPUNK_CONVAI_LOCAL_MODEL: 'a.gguf', CYBERPUNK_CONVAI_LOCAL_LITE_MODEL: 'b.gguf', CYBERPUNK_CONVAI_LOCAL_EMBED_MODEL: 'c.gguf', CYBERPUNK_CONVAI_LOCAL_AI: 'elsewhere'});
    assert.equal(env.CYBERPUNK_CONVAI_LOCAL_AI, f.layout.localAi);
    for (const name of ['DEV', 'SERVER', 'MODEL', 'LITE_MODEL', 'EMBED_MODEL']) assert.equal(env[`CYBERPUNK_CONVAI_LOCAL_${name === 'DEV' ? 'AI_DEV' : name}`], undefined, name);
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test('the bridge detects the manifest fragments the Local AI packs write, standard and lite together or alone', async () => {
  const {detectLocalAiPack} = await import('../bridge/local-ai-pack.mjs');
  const root = join('C:', 'game', 'app', 'local-ai');
  const files = new Map();
  const put = (rel, text = '') => files.set(resolve(root, rel), text);
  const embed = {file: 'models/granite-embedding-107m-multilingual-Q8_0.gguf', dim: 384, id: 'granite-embedding-107m-multilingual-q8_0'};
  put('llama/llama-server.exe'); put(embed.file);
  put('manifest.lite.json', JSON.stringify({version: 1, server: 'llama/llama-server.exe', lite: {file: 'models/Ternary-Bonsai-2-4B-Q2_0.gguf', name: 'Bonsai 2 4B'}, embed}));
  put('models/Ternary-Bonsai-2-4B-Q2_0.gguf');
  const detect = () => detectLocalAiPack({project: 'x', environment: {CYBERPUNK_CONVAI_LOCAL_AI: root}, exists: path => files.has(path), readText: path => files.get(path)});
  let pack = detect();
  assert(pack.installed && pack.tiers.lite && !pack.tiers.standard && pack.missing.length === 0);
  put('manifest.standard.json', JSON.stringify({version: 1, server: 'llama/llama-server.exe', standard: {file: 'models/gemma-4-E4B_q4_0-it.gguf', name: 'Gemma 4 E4B'}, embed}));
  assert(!detect().tiers.standard, 'a manifest without its model file is not a tier');
  put('models/gemma-4-E4B_q4_0-it.gguf');
  pack = detect();
  assert(pack.tiers.standard?.name === 'Gemma 4 E4B' && pack.tiers.lite?.name === 'Bonsai 2 4B' && pack.embed.dim === 384);
});

test('the build writes the manifest fragments the detector reads, and ships both Local AI packs as separate downloads', async () => {
  const builder = await readFile(resolve(project, 'packaging/build-release.mjs'), 'utf8');
  assert.match(builder, /manifest\.\$\{tierKey\}\.json/);
  assert.match(builder, /'localai-standard'/); assert.match(builder, /'localai-lite'/);
  assert.match(builder, /LocalAI-Standard/); assert.match(builder, /LocalAI-Lite/);
  const workflow = await readFile(resolve(project, '.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /tier: \[standard, lite\]/);
  assert.match(workflow, /--packages "localai-\$\{\{ matrix\.tier \}\}"/);
  assert.match(workflow, /--pack "localai-\$\{\{ matrix\.tier \}\}"/, 'each Local AI pack is uploaded under its own name, with its own SHA256SUMS-<pack>.txt');
});

// ---------------------------------------------------------------- the optional packs: one zip each, hosted on Hugging Face
const workflowText = async () => (await readFile(resolve(project, '.github/workflows/release.yml'), 'utf8')).replaceAll('\r\n', '\n');
const jobOf = (workflow, name) => new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][\\w-]*:\\n|$)`).exec(workflow)?.[1]?.replace(/^\s*#.*\n/gm, '');

test('optional packs are one zip each with no parts: the builder never splits a file or a pack, and says which packs are optional', async () => {
  const builder = await readFile(resolve(project, 'packaging/build-release.mjs'), 'utf8');
  assert.match(builder, /const OPTIONAL_PACKAGE_IDS = new Set\(\['omni', 'localai-standard', 'localai-lite', 'mature-lite', 'mature-standard'\]\)/);
  assert.doesNotMatch(builder, /splitLargeFiles|\.part\$\{index\}|\.parts\.json|splitPartBytes|splitFileBytes/, 'no file is split into .partN files and no .parts.json is written');
  assert.match(builder, /writeArchives\(pkg, [^\n]*\{single: OPTIONAL_PACKAGE_IDS\.has\(id\)\}\)/, 'an optional pack is written as a single zip');
  assert.match(builder, /if \(!single && writer\.count && /, 'only a non-optional package may roll over to a next zip');
  assert.match(builder, /if \(!OPTIONAL_PACKAGE_IDS\.has\(id\)\) await checkFileSizes\(pkg, config\)/, 'the Scripts and Runtime packages still refuse a file over the GitHub limit');
  // The header and the notes name no partNofM zip for any optional pack.
  const header = builder.slice(0, builder.indexOf('// Options:'));
  assert.doesNotMatch(header, /partNofM/);
  assert.equal(config.limits.splitFileBytes, undefined);
  assert.equal(config.limits.splitPartBytes, undefined);
  assert(config.limits.githubFileBytes < 2 * 1024 ** 3);
  // The join code stays for old installs, and finds nothing to do on an unsplit model: the Local AI detector reads the model file itself.
  const directory = await temporary();
  try {
    await writeFile(join(directory, 'model.gguf'), Buffer.alloc(100, 1));
    assert.deepEqual(await assembleParts(directory), [], 'an unsplit model needs no joining');
    assert.deepEqual(await readdir(directory), ['model.gguf']);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the Local AI detector uses an unsplit model file directly, with no .parts.json or .verified beside it', async () => {
  const {detectLocalAiPack} = await import('../bridge/local-ai-pack.mjs');
  const root = join('C:', 'game', 'app', 'local-ai');
  const files = new Map();
  const put = (rel, text = '') => files.set(resolve(root, rel), text);
  const embed = {file: 'models/e.gguf', dim: 384, id: 'e'};
  put('llama/llama-server.exe'); put(embed.file); put('models/gemma-4-E4B_q4_0-it.gguf');
  put('manifest.standard.json', JSON.stringify({version: 1, server: 'llama/llama-server.exe', standard: {file: 'models/gemma-4-E4B_q4_0-it.gguf', name: 'Gemma 4 E4B'}, embed}));
  const pack = detectLocalAiPack({project: 'x', environment: {CYBERPUNK_CONVAI_LOCAL_AI: root}, exists: path => files.has(path), readText: path => files.get(path)});
  assert(pack.installed && pack.tiers.standard?.file === resolve(root, 'models/gemma-4-E4B_q4_0-it.gguf'));
  assert(![...files.keys()].some(path => /\.(?:parts\.json|verified|part\d+)$/.test(path)));
});

test('ZIP64: an entry over the threshold, an archive with many entries and a big offset read back correctly and extract with tar', async () => {
  const directory = await temporary();
  try {
    const source = join(directory, 'big.gguf');
    const bytes = Buffer.alloc(50_000); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 253;
    await writeFile(source, bytes);
    const zip = await ZipWriter.create(join(directory, 'z.zip'), {zip64Entry: 10_000});
    await zip.add('a/small.txt', {buffer: Buffer.from('tiny')});
    await zip.add('a/big.gguf', {source});
    await zip.add('a/text.txt', {buffer: Buffer.from('hello '.repeat(5000))});
    await zip.add('a/range.bin', {source, start: 100, length: 20_000});
    await zip.close();
    const entries = await listZip(join(directory, 'z.zip'));
    assert.deepEqual(entries.map(entry => [entry.name, entry.method, entry.uncompressed]),
      [['a/small.txt', 8, 4], ['a/big.gguf', 0, 50_000], ['a/text.txt', 8, 30_000], ['a/range.bin', 8, 20_000]]);
    await mkdir(join(directory, 'x'));
    const tar = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const run = spawnSync(tar, ['-xf', join(directory, 'z.zip'), '-C', join(directory, 'x')]);
    assert.equal(run.status, 0, String(run.stderr));
    assert(bytes.equals(await readFile(join(directory, 'x/a/big.gguf'))));
    assert.equal((await readFile(join(directory, 'x/a/text.txt'), 'utf8')).length, 30_000);
    assert(bytes.subarray(100, 20_100).equals(await readFile(join(directory, 'x/a/range.bin'))));
    // The end records go ZIP64 only past 65,535 entries; a normal archive stays a plain ZIP byte for byte (the first test checks that).
    const many = await ZipWriter.create(join(directory, 'many.zip'));
    for (let i = 0; i < 65_600; i++) await many.add(`m/${i}.txt`, {buffer: Buffer.from('x'), store: true});
    await many.close();
    const listed = await listZip(join(directory, 'many.zip'));
    assert.equal(listed.length, 65_600);
    assert.equal(listed[65_599].name, 'm/65599.txt');
    await mkdir(join(directory, 'y'));
    assert.equal(spawnSync(tar, ['-xf', join(directory, 'many.zip'), '-C', join(directory, 'y')]).status, 0);
    assert.equal((await readdir(join(directory, 'y/m'))).length, 65_600);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the optional packs are uploaded to Hugging Face, one zip each with a SHA256SUMS-<pack>.txt, and never with gh release upload', async () => {
  const workflow = await workflowText();
  const jobs = {omni: jobOf(workflow, 'omni'), mature: jobOf(workflow, 'mature'), localai: jobOf(workflow, 'localai')};
  for (const [name, job] of Object.entries(jobs)) {
    assert(job, `the workflow has a ${name} job`);
    assert.match(job, /python packaging\/upload-packs\.py --version "\$\{\{ needs\.runtime\.outputs\.version \}\}" --pack /, `${name} uploads its pack to Hugging Face`);
    assert.match(job, /HF_PACKS_TOKEN: \$\{\{ secrets\.HF_PACKS_TOKEN \}\}/, `${name} uploads with the pack repository's own token`);
    assert.doesNotMatch(job, /gh release upload|GH_TOKEN|\bgh \w/, `${name} never uploads to the GitHub release`);
    assert.match(job, /upload-packs\.py --check/, `${name} checks the write access before it builds`);
    assert.match(job, /huggingface_hub==\$env:HF_HUB_VERSION/, `${name} installs huggingface_hub`);
  }
  assert.match(jobs.omni, /--pack omni --packages "\$env:OUT\\packages"/);
  assert.match(workflow, /HF_PACKS_REPO: alystria-ai\/ai-npc-cyberpunk-mod-packs/);
  // The Runtime job still creates the GitHub release with Scripts and Runtime, and nothing else is attached to it.
  const runtime = jobOf(workflow, 'runtime');
  assert.match(runtime, /gh release upload \$tag --repo \$env:GITHUB_REPOSITORY --clobber @files /, 'the file list is splatted as an array');
  assert.match(runtime, /\$files = @\(Get-ChildItem /, 'the single-zip splat bug stays fixed: the file list is always an array');
  assert.doesNotMatch(runtime, /upload-packs/);
  assert.equal(workflow.split('gh release upload').length - 1, 1, 'only the Runtime job uploads to the GitHub release');
  // The uploader: one zip, the version folder, the sums file next to it, a clear message when the token cannot write.
  const uploader = await readFile(resolve(project, 'packaging/upload-packs.py'), 'utf8');
  assert.match(uploader, /REPOSITORY = "alystria-ai\/ai-npc-cyberpunk-mod-packs"/);
  assert.match(uploader, /f"\{version\}\/\{zips\[0\]\.name\}"/);
  assert.match(uploader, /f"\{version\}\/\{sums_name\(pack\)\}"/);
  assert.match(uploader, /f"SHA256SUMS-\{pack\}\.txt"/);
  assert.match(uploader, /The HF_PACKS_TOKEN secret cannot write to the Hugging Face repository \{repository\}\./);
  assert.match(uploader, /write access to \{repository\}/);
  assert.match(uploader, /Expected exactly one zip/, 'a multi-zip pack is refused');
});

test('the release workflow builds the Mature packs only in an opt-in job: off by default, never on a tag push, one matrix entry per pack, never Nexus, from the bucket mirror', async () => {
  const workflow = await workflowText();
  const input = /\n      mature:\n([\s\S]*?)\n      \w+:\n/.exec(workflow)?.[1] ?? '';
  assert.match(input, /type: boolean/, 'a boolean workflow_dispatch input named mature');
  assert.match(input, /default: false/, 'the input is off by default');
  assert.match(input, /Mature packs, lite and standard \(uploaded to Hugging Face\)/);
  const job = jobOf(workflow, 'mature');
  assert(job, 'the workflow has a mature job');
  assert.match(job, /needs: runtime/);
  assert.match(job, /\n    if: inputs\.mature\n/, 'the job runs only when the input is ticked');
  assert.doesNotMatch(job, /ref_type|startsWith\(github\.ref|refs\/tags/, 'its condition never mentions a tag push');
  assert.match(job, /\n      matrix:\n        tier: \[lite, standard\]\n/, 'a matrix of the two packs');
  assert.match(job, /fail-fast: false/);
  assert.match(job, /--packages "mature-\$\{\{ matrix\.tier \}\}" `\s*\n\s*--models hf/, 'it builds the pack of its tier from the bucket mirror');
  assert.match(job, /--pack "mature-\$\{\{ matrix\.tier \}\}"/, 'and uploads that pack under its own name');
  assert.match(job, /HF_TOKEN: \$\{\{ secrets\.HF_TOKEN \}\}/);
  assert.doesNotMatch(job, /gh release upload/);
  assert.doesNotMatch(job, /nexus/i, 'Hugging Face only');
  // The tag filters sit in the push trigger, which has no input: the mature input is false there, so the job is skipped.
  const trigger = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));
  assert(trigger.includes('tags:') && !/mature/.test(trigger.slice(trigger.indexOf('push:'))), 'the push trigger knows nothing of it');
  // The other jobs never build it.
  for (const name of ['runtime', 'omni', 'localai']) assert.doesNotMatch(jobOf(workflow, name), /--packages[^\n]*mature/, `${name} does not build the Mature packs`);
  // The builder reads the model from the mirror with --models hf (only the tier being built) and falls back to the pinned public URL.
  const builder = await readFile(resolve(project, 'packaging/build-release.mjs'), 'utf8');
  assert.match(builder, /modelSource === 'hf' \? await matureMirror\(source, tierKey\)/);
  assert.match(builder, /'--mature', '--tier', tierKey\]/, 'only the tier being built is fetched');
  assert.match(builder, /mirrored\.get\(model\.file\) \?\? await localAiFile\(/, 'a model the mirror lacks comes from the pinned public URL');
  const fetcher = await readFile(resolve(project, 'packaging/fetch-models.py'), 'utf8');
  assert.match(fetcher, /--tier/);
  assert.match(fetcher, /for key in tiers:/);
  assert.equal(config.maturePack.mirror.bucket, 'mature/', 'the mirror sits outside final/');
  assert.equal(config.maturePack.mirror.manifest, 'mature/MANIFEST.json');
  assert(!config.maturePack.mirror.bucket.startsWith('final/'));
});

// ---------------------------------------------------------------- the Mature pack (docs/LOCAL_AI.md, "Mature content")
test('the Mature packs are their own packages: built only on request, never in the default set, and nothing of it in the Runtime package or the main page text', async () => {
  const builder = await readFile(resolve(project, 'packaging/build-release.mjs'), 'utf8');
  assert.match(builder, /const PACKAGE_IDS = \[[^\]]*'localai-lite', 'mature-lite', 'mature-standard'\]/, 'the two Mature packs are package ids beside the Local AI packs');
  assert.match(builder, /const DEFAULT_PACKAGE_IDS = PACKAGE_IDS\.filter\(id => !id\.startsWith\('mature'\)\)/, 'the default set leaves them out');
  assert.match(builder, /value\('--packages', DEFAULT_PACKAGE_IDS\.join\(','\)\)/, 'a plain build uses the default set');
  // The release workflow produces the Mature pack only in its own opt-in job (see the workflow test below).
  // Nothing in the release plan or the runtime layout (the Runtime package) is the pack's marker, README, release notes or models.
  const plan = await readFile(resolve(project, 'packaging/release-plan.json'), 'utf8');
  assert.doesNotMatch(plan, /manifest\.mature|MATURE_PACK|mature\/|uncensored|abliterat|heretic|hauhau/i);
  const {BRIDGE_MODULES} = await import('./runtime-layout.mjs');
  assert.doesNotMatch(JSON.stringify(BRIDGE_MODULES), /manifest\.mature|MATURE_PACK|\.gguf/i);
  assert(BRIDGE_MODULES.includes('bridge/mature-pack.mjs') && BRIDGE_MODULES.includes('bridge/mature-content.mjs'), 'the code that looks for the pack ships; the pack does not');
  // The runtime builder never reads the pack's config section, README or models.
  const runtimeBuilder = builder.slice(builder.indexOf('async function runtimePackage'), builder.indexOf('async function omniPackage'));
  assert(runtimeBuilder.length > 1000);
  assert.doesNotMatch(runtimeBuilder, /maturePack|MATURE_PACK|manifest\.mature/);
  // The player README (the one the Runtime package carries and the release page shows) says nothing of the pack.
  assert.doesNotMatch(await readFile(resolve(project, 'packaging/PLAYER_README.md'), 'utf8'), /mature|uncensored|adult|18\+/i);
});

test('the Mature packs definition: one marker each, README, Hugging Face page text and Apache-2.0 licences, exactly two pinned models (lite and good, one per pack), and the build refusing anything else', async () => {
  const spec = config.maturePack;
  const {MATURE_MARKERS, MATURE_TIERS} = await import('../bridge/mature-pack.mjs');
  assert.deepEqual(spec.markers, {lite: 'manifest.mature-lite.json', good: 'manifest.mature-standard.json'});
  assert.deepEqual(spec.markers, MATURE_MARKERS, 'the build writes the file names the bridge looks for');
  assert.equal(spec.marker, undefined, 'no single marker: each pack carries its own');
  assert.equal(new Set(Object.values(spec.markers)).size, 2, 'the two packs never overwrite each other');
  assert.equal(spec.status, 'pinned');
  for (const marker of Object.values(spec.markers)) { assert.notEqual(marker, 'manifest.standard.json'); assert.notEqual(marker, 'manifest.lite.json'); }
  for (const rel of [spec.readme, spec.releaseNotes, ...spec.licenceFiles]) assert(existsSync(resolve(project, rel)), rel);
  assert.deepEqual(spec.licenceFiles, ['packaging/licenses/Apache-2.0.txt']);
  // Exactly two models, like the Local AI packs' lite and standard, each pinned by repository, revision, size and hash.
  assert.deepEqual(Object.keys(spec.tiers), [...MATURE_TIERS]);
  assert.equal(spec.models, undefined, 'no list any more');
  for (const model of Object.values(spec.tiers)) {
    assert.equal(model.license, 'Apache-2.0', model.name);
    assert.match(model.revision, /^[0-9a-f]{40}$/, model.name);
    assert.match(model.sha256, /^[0-9a-f]{64}$/, model.name);
    assert(Number.isInteger(model.size) && model.size > 1e9, model.name);
    assert.match(model.file, /^[\w.-]+\.gguf$/, 'a plain file name; a folder in the repository goes in remote');
    assert(!model.remote || model.remote.endsWith('/' + model.file), model.name);
    assert.doesNotMatch(JSON.stringify(model), /PLACEHOLDER/);
    assert.match(model.name, /uncensored/i, 'the model row says what it is');
  }
  assert(spec.tiers.lite.size < spec.tiers.good.size, 'lite is the smaller one');
  assert(spec.tiers.lite.size < 3e9 && spec.tiers.good.size < 5.6e9, 'lite fits a small card, good stays near the standard Local AI model');
  assert.deepEqual(new Set(Object.values(spec.tiers).map(model => model.family)), new Set(['qwen', 'gemma-4']));
  // The pack lives in the Local AI folder, so the marker is found next to the Local AI manifests.
  assert.equal(config.layout.localAiDirectory, 'red4ext/plugins/AiNpcCyberpunkMod/app/local-ai');
  assert.equal(spec.directory, 'mature');
  // The builder refuses an unfinished or non-Apache pair, and writes the marker in the shape the bridge reads.
  const builder = await readFile(resolve(project, 'packaging/build-release.mjs'), 'utf8');
  assert.match(builder, /model\.placeholder \|\| \/PLACEHOLDER\//);
  assert.match(builder, /the Mature packs ship Apache-2\.0 base models only/);
  assert.match(builder, /lite and good, one model each/);
  assert.match(builder, /pkg\.json\(`\$\{root\}\/\$\{spec\.markers\[tierKey\]\}`, \{version: 1, pack: 'mature', \[tierKey\]: \{file: /, 'each pack writes its own marker with its own model only');
  assert.match(builder, /THIRD-PARTY-NOTICES-\$\{packKey\}\.txt/, 'the notices of the two packs have different names, so extracting both keeps both');
  assert.match(builder, /mature-pack-\$\{packKey\}\.json/);
  // A marker of that shape, for each pinned model, is what the detector accepts alone, and it is not the Local AI pack.
  const {detectMaturePack} = await import('../bridge/mature-pack.mjs');
  const {detectLocalAiPack} = await import('../bridge/local-ai-pack.mjs');
  const root = join('C:', 'game', 'app', 'local-ai');
  const entry = model => ({file: `models/${model.file}`, name: model.name, family: model.family});
  const markerOf = tier => JSON.stringify({version: 1, pack: 'mature', [tier]: entry(spec.tiers[tier])});
  const detect = (files, detector = detectMaturePack) => detector({project: 'x', environment: {CYBERPUNK_CONVAI_LOCAL_AI: root}, exists: path => files.has(path), readText: path => files.get(path)});
  const liteOnly = new Map([[resolve(root, spec.markers.lite), markerOf('lite')]]);
  const goodOnly = new Map([[resolve(root, spec.markers.good), markerOf('good')]]);
  const both = new Map([...liteOnly, ...goodOnly]);
  assert.deepEqual(detect(liteOnly).models.map(model => model.tier), ['lite'], 'Mature lite alone is detected');
  assert.deepEqual(detect(goodOnly).models.map(model => model.tier), ['good'], 'Mature standard alone is detected');
  assert.deepEqual(detect(both).models.map(model => model.tier), ['lite', 'good'], 'both together');
  for (const files of [liteOnly, goodOnly, both]) {
    assert.equal(detect(files).installed, true);
    assert.equal(detect(files, detectLocalAiPack).installed, false, 'the Mature markers alone are not a Local AI pack');
  }
});

test('the Mature pack README and release notes are for adults, need the main mod and Local AI, give install steps, and say nothing they must not', async () => {
  for (const rel of ['packaging/MATURE_PACK_README.md', 'packaging/MATURE_PACK_RELEASE_NOTES.md']) {
    const text = await readFile(resolve(project, rel), 'utf8');
    assert.match(text, /18\+/, rel); assert.match(text, /adults? only/i, rel);
    assert.match(text, /Local AI/, rel); assert.match(text, /AI NPC Cyberpunk Mod/, rel);
    assert.match(text, /^\s*1\. Close the game\./m, `${rel}: install steps`);
    assert.match(text, /hard limits/i, rel);
    assert.match(text, /Apache-2\.0/, rel);
    assert.doesNotMatch(text, /\brecommended?\b/i, rel);
    assert.doesNotMatch(text, /every part|each part|several (?:parts|zips)|part\d+of|release page/i, `${rel}: one zip, from Hugging Face`);
    assert.match(text, /huggingface\.co\/alystria-ai\/ai-npc-cyberpunk-mod-packs|Hugging Face/, rel);
    assert.doesNotMatch(text, /\bamm\b|reference-amm/i, rel);
    assert.doesNotMatch(text, /\b(?:api[- ]?key|token|secret|credential)s?\b/i, `${rel}: no keys`);
    assert.doesNotMatch(text, /convai (?:free|shared|embedded)/i, rel);
  }
  const notes = await readFile(resolve(project, 'packaging/MATURE_PACK_RELEASE_NOTES.md'), 'utf8');
  assert.match(notes, /only as optional files on this project's Hugging Face page/);
  assert.match(notes, /Never on Nexus Mods and not on the GitHub release/);
  assert.doesNotMatch(notes, /adult-flagged|generative-AI tag|classify it as|mark as adult/i, 'no Nexus page instructions');
  assert.match(notes, /The main mod has a \*\*Mature content\*\* setting/, 'the setting belongs to the main mod');
  assert.doesNotMatch(await readFile(resolve(project, 'packaging/MATURE_PACK_README.md'), 'utf8'), /nexus/i);
});

test('the README and the release notes send players to Hugging Face for every optional pack: one zip each, no parts, Install near the top', async () => {
  const hf = 'https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs';
  const readme = (await readFile(resolve(project, 'README.md'), 'utf8')).replaceAll('\r\n', '\n');
  const player = (await readFile(resolve(project, 'packaging/PLAYER_README.md'), 'utf8')).replaceAll('\r\n', '\n');
  const files = ['OmniPack', 'LocalAI-Standard', 'LocalAI-Lite', 'Mature-Lite', 'Mature-Standard'].map(name => `AI-NPC-Cyberpunk-Mod-${name}-0.2.zip`);
  for (const file of files) assert(readme.includes(hf + '/blob/main/0.2/' + file), 'the README links ' + file);
  for (const file of files.filter(name => !/Mature/.test(name))) assert(player.includes(hf + '/blob/main/0.2/' + file), 'the release notes link ' + file);
  assert(readme.includes(hf + ')'), 'and the repository page');
  // The Install section sits before Requirements and the long feature list, right after the intro.
  const heading = text => readme.indexOf('\n## ' + text + '\n');
  assert(heading('Install') > 0 && heading('Install') < heading('What you can do') && heading('What you can do') < heading('Requirements'), 'Install comes first');
  assert(heading('Install') < 6000, 'near the top of the page');
  const install = readme.slice(heading('Install'), heading('What you can do'));
  assert.match(install, /Scripts come from Nexus Mods and the Runtime from the release page/);
  assert.match(install, /Each pack is one zip file/);
  // No parts, anywhere in what players read.
  for (const [name, text] of [['README', readme], ['PLAYER_README', player]]) {
    assert.doesNotMatch(text, /several parts|every part|extract (?:each|all) (?:of the )?parts|partNofM|part1of|in 1 GB parts|joins the downloaded parts|If it comes in several/i, name);
  }
  assert.doesNotMatch(readme, /Mature pack\*\* on the GitHub|GitHub Releases\b[^\n]*(?:OmniVoice|Local AI|Mature)/);
  assert.doesNotMatch(player, /GitHub[^\n]*(?:OmniVoice|Local AI standard|Local AI lite)/);
  // The wording rules for players: nothing called recommended, the paid Convai tier in one place, no Inworld, no word about a shared key.
  assert.doesNotMatch(readme.slice(0, readme.indexOf('# For developers')), /\brecommended\b|inworld|embedded key|shared key|packaged key/i);
  assert.equal(readme.slice(0, readme.indexOf('# For developers')).split('Convai paid tier').length - 1, 1, 'the paid Convai tier appears in one spot');
  assert.doesNotMatch(player, /\b(?:api[- ]?key|key|token|secret|credential)s?\b|\brecommended\b|inworld/i);
  // The Mature help text in the settings page names the Hugging Face page, in every language.
  const mcm = await readFile(resolve(project, 'mod/mcm.lua'), 'utf8');
  assert.match(mcm, /Pack: not installed \(optional, on this mod’s Hugging Face page\)\./);
  assert.doesNotMatch(mcm, /GitHub page/);
  const key = 'Pack: not installed (optional, on this mod’s Hugging Face page).';
  for (const name of (await readdir(resolve(project, 'mod/locales'))).filter(file => file.endsWith('.lua'))) {
    const lua = await readFile(resolve(project, 'mod/locales', name), 'utf8');
    assert(lua.includes(key), name + ' keys the new sentence');
    assert(/Hugging Face/.test(lua.split('\n').find(line => line.includes(key)) ?? ''), name + ' translates it with the Hugging Face page');
    assert.doesNotMatch(lua, /GitHub[^\n]*Mature|Mature[^\n]*GitHub/, name);
  }
});

test('the release guard refuses a package that would install the development launcher', async () => {
  const builder = await readFile(resolve(project, 'packaging/build-release.mjs'), 'utf8');
  assert.match(builder, /CyberpunkConvaiLauncher/);
  assert.match(builder, /unexpected RED4ext plugin file/);
  // The shipped DLL keeps the name CyberpunkConvai.dll, in its own plugin folder.
  assert.equal(config.layout.pluginDll, 'CyberpunkConvai.dll');
  assert.equal(config.layout.pluginDirectory, 'red4ext/plugins/AiNpcCyberpunkMod');
});

test('player-facing text follows the wording rules', async () => {
  const readme = await readFile(resolve(project, 'packaging/PLAYER_README.md'), 'utf8');
  assert.doesNotMatch(readme, /\b(?:antivirus|anti-virus|defender|malware|virus|smartscreen)\b/i);
  assert.doesNotMatch(readme, /\bAMM\b|appearance menu mod/i);
  assert.doesNotMatch(readme, /text[- ]only/i);
  assert.doesNotMatch(readme, /paid (?:tier|plan|subscription)|subscription|premium/i);
  assert.doesNotMatch(readme, /embedded|shared plan/i);
  assert.match(readme, /Convai[^.]*gives better quality responses/);
  assert.match(readme, /RED4ext/);
  // Guidance is by goal, not by graphics card or a quality ranking (the user, 2026-10-16): every voice sounds good; no per-card table.
  assert.match(readme, /## Choosing a setup/);
  assert.match(readme, /\*\*Least effect on your frames:\*\*/);
  assert.doesNotMatch(readme, /\| (?:6|8|12|16) GB \||lower settings/i);
  const notices = await readFile(resolve(project, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const name of ['llama.cpp', 'Gemma 4', 'Bonsai 2 4B', 'PrismML', 'granite-embedding', 'Apache-2.0']) assert(notices.includes(name), `THIRD_PARTY_NOTICES.md must mention ${name}`);
});

test('the Mistral voice finds its pre-built references with or without the OmniVoice pack', async () => {
  const f = await fakeInstall();
  try {
    const plain = serviceEnvironment(f.layout, {omni: false, keyFile: 'K'}, {CYBERPUNK_CONVAI_OMNI_REFERENCES: 'C:\old\refs'});
    // The bridge looks in <references>/prepared first; the folder is the install's voices/ even with no OmniVoice pack.
    assert.equal(plain.CYBERPUNK_CONVAI_OMNI_REFERENCES, f.layout.voices);
    // The OmniVoice worker needs all four paths or none, and is only created with the pack, so only the pack sets the other three.
    assert.equal(plain.CYBERPUNK_CONVAI_OMNI_MODEL, undefined);
    assert.equal(plain.CYBERPUNK_CONVAI_OMNI_CACHE, undefined);
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test('the build pre-encodes the Mistral voice references with the bridge code and ships them under voices/prepared', async () => {
  const builder = await readFile(resolve(project, 'packaging/build-release.mjs'), 'utf8');
  assert.match(builder, /voxtral-voice\.mjs/); assert.match(builder, /voxtral-reference\.mjs/);
  assert(builder.includes('voice.build(name)'), 'the references are made by the call a conversation makes');
  assert(builder.includes('${plugin}/voices/prepared'));
  // Runtime holds the Pocket clips' slots; the OmniVoice pack the slots whose clip differs.
  assert.equal(builder.split('await voxtralCache(').length - 1, 3);
  assert.match(builder, /was not compressed/);
  const workflow = await readFile(resolve(project, '.github/workflows/release.yml'), 'utf8');
  assert.equal(workflow.split('choco install ffmpeg').length - 1, 2, 'the Runtime and OmniVoice jobs install ffmpeg');
});

test('the release notes open with where the download files are, and a rebuild refreshes them', async () => {
  const workflow = await workflowText();
  assert.match(workflow, /very bottom of this page, under Assets/);
  assert.match(workflow, /releases\/download\/\$tag/);
  assert.match(workflow, /AI-NPC-Cyberpunk-Mod-Scripts-\$version\.zip/);
  assert.match(workflow, /AI-NPC-Cyberpunk-Mod-Runtime-\$version\.zip/);
  assert.match(workflow, /\$download \+ \(Get-Content packaging\/PLAYER_README\.md -Raw\)/);
  assert.match(workflow, /gh release edit \$tag --repo \$env:GITHUB_REPOSITORY --title "AI NPC Cyberpunk Mod \$version" --notes-file \$notes/);
  // The pointer lives only on the release page: README.txt in the zips is PLAYER_README.md as it is.
  assert.doesNotMatch(await readFile(resolve(project, 'packaging/PLAYER_README.md'), 'utf8'), /under Assets/);
});
