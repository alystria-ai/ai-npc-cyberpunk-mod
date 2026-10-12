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
  // v0.2 sorts below the legacy v2077.1 by version number, so a publish must say it is the latest release.
  assert(/'--latest'/.test(workflow), 'the workflow marks the published release as Latest');
});

test('developer-only folders never feed a package', () => {
  const sources = [...config.catalogs.map(item => item.source), ...config.appData, ...config.bridgeEntries, ...config.bridgeWorkers,
    ...config.releaseData.archives.map(item => item.source)];
  for (const source of sources) assert(!/^(?:misc|vendor|runtime|ref mods)\//.test(source), source);
});

// ---------------------------------------------------------------- native plugin and Local AI packs (docs/PACKAGING.md)
test('the native plugin ships beside its own licences, and the systems not yet proven live start off', () => {
  assert.equal(config.layout.nativeDirectory, 'red4ext/plugins/CyberpunkConvaiNative');
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
  assert.equal(spec.tiers.lite.name, 'Qwen3.5-2B');
  assert.equal(spec.embed.dim, 384);
  // Only the standard model is over the download limit, so only it is split; the lite pack is one download.
  assert(spec.tiers.standard.size > config.limits.splitFileBytes && spec.tiers.lite.size < config.limits.splitFileBytes);
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
  put('manifest.lite.json', JSON.stringify({version: 1, server: 'llama/llama-server.exe', lite: {file: 'models/Qwen3.5-2B-Q4_K_M.gguf', name: 'Qwen3.5-2B'}, embed}));
  put('models/Qwen3.5-2B-Q4_K_M.gguf');
  const detect = () => detectLocalAiPack({project: 'x', environment: {CYBERPUNK_CONVAI_LOCAL_AI: root}, exists: path => files.has(path), readText: path => files.get(path)});
  let pack = detect();
  assert(pack.installed && pack.tiers.lite && !pack.tiers.standard && pack.missing.length === 0);
  put('manifest.standard.json', JSON.stringify({version: 1, server: 'llama/llama-server.exe', standard: {file: 'models/gemma-4-E4B_q4_0-it.gguf', name: 'Gemma 4 E4B'}, embed}));
  assert(!detect().tiers.standard, 'a manifest without its model file is not a tier');
  put('models/gemma-4-E4B_q4_0-it.gguf');
  pack = detect();
  assert(pack.tiers.standard?.name === 'Gemma 4 E4B' && pack.tiers.lite?.name === 'Qwen3.5-2B' && pack.embed.dim === 384);
});

test('the build writes the manifest fragments the detector reads, and ships both Local AI packs as separate downloads', async () => {
  const builder = await readFile(resolve(project, 'packaging/build-release.mjs'), 'utf8');
  assert.match(builder, /manifest\.\$\{tierKey\}\.json/);
  assert.match(builder, /'localai-standard'/); assert.match(builder, /'localai-lite'/);
  assert.match(builder, /LocalAI-Standard/); assert.match(builder, /LocalAI-Lite/);
  assert(builder.includes('(?:omni|local-ai)'), 'big model files are split only inside the OmniVoice and Local AI folders');
  const workflow = await readFile(resolve(project, '.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /tier: \[standard, lite\]/);
  assert.match(workflow, /--packages "localai-\$\{\{ matrix\.tier \}\}"/);
  assert.match(workflow, /SHA256SUMS-localai-/);
});

test('the release guard refuses a package that would install the development launcher', async () => {
  const builder = await readFile(resolve(project, 'packaging/build-release.mjs'), 'utf8');
  assert.match(builder, /CyberpunkConvaiLauncher/);
  assert.match(builder, /unexpected RED4ext plugin file/);
  // The shipped DLL keeps the name CyberpunkConvai.dll, in its own plugin folder.
  assert.equal(config.layout.pluginDll, 'CyberpunkConvai.dll');
  assert.equal(config.layout.pluginDirectory, 'red4ext/plugins/CyberpunkConvai');
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
  // The graphics-memory picks cover 6, 8, 12 and 16 GB cards.
  for (const size of ['6 GB', '8 GB', '12 GB', '16 GB']) assert(readme.includes(`| ${size} |`), size);
  const notices = await readFile(resolve(project, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const name of ['llama.cpp', 'Gemma 4', 'Qwen3.5-2B', 'granite-embedding', 'Apache-2.0']) assert(notices.includes(name), `THIRD_PARTY_NOTICES.md must mention ${name}`);
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
