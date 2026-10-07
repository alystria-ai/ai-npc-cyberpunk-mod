// Builds the player release packages. Run by .github/workflows/release.yml, and locally:
//
//   node packaging/build-release.mjs --version 2077.1 --dry-run          (local stand-ins, no secrets)
//   node packaging/build-release.mjs --version 2077.1 --models hf --key-env CONVAI_API_KEY   (CI)
//
// Packages (dist/release/packages/):
//   CyberpunkConvai-Scripts-<v>.zip        text only: CET Lua, redscript, JSON catalogs (for Nexus Mods)
//   CyberpunkConvai-Runtime-<v>[...].zip   launcher, bundled Node/Chrome/Python, bridge, models, voices,
//                                          game archives and the Audioware bank (GitHub)
//   CyberpunkConvai-OmniPack-<v>-partNofM.zip  optional OmniVoice GPU pack (GitHub)
// plus SHA256SUMS.txt and release-manifest.json. See docs/PACKAGING.md.
//
// Options:
//   --version V        release version, 2077.N or 2077.N.M (required)
//   --dry-run          local build: models from the developer runtime/ folder, no key embedded
//   --models local|hf  where trained models come from (default: hf, or local with --dry-run)
//   --packages LIST    comma list of scripts,runtime,omni (default: all three)
//   --source REF       git ref to package (default HEAD); --worktree packages the working tree instead
//   --key-env NAME     embed the Convai key from this environment variable (never printed)
//   --key-file PATH    embed the Convai key from this file (local testing only)
//   --launcher PATH    use a prebuilt launcher DLL instead of compiling native/autostart with MSVC
//   --python EXE       host CPython used to run pip (default: python)
//   --out DIR, --cache DIR   output and download-cache folders (default dist/release, dist/release-cache)
import {createHash} from 'node:crypto';
import {mkdir, readFile, readdir, rename, rm, stat, writeFile, copyFile} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {basename, dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {ZipWriter, listZip} from './lib/zip.mjs';
import {isReleaseVersion, npmVersion} from './lib/version.mjs';
import {importClosure, checkLuaPartition} from './lib/closure.mjs';
import {copyInto, download, exists, extractZip, posix, readJson, run, sha256Buffer, sha256File, walk, writeText} from './lib/files.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const started = Date.now();

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const value = (name, fallback) => { const at = argv.indexOf(name); return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback; };
const version = value('--version');
if (!isReleaseVersion(version)) {
  console.error('Usage: node packaging/build-release.mjs --version 2077.N [--dry-run] [--models local|hf] [--packages scripts,runtime,omni]');
  process.exit(2);
}
const dryRun = flag('--dry-run');
const modelSource = value('--models', dryRun ? 'local' : 'hf');
const packages = new Set(value('--packages', 'scripts,runtime,omni').split(',').map(item => item.trim()).filter(Boolean));
const out = resolve(value('--out', resolve(project, 'dist/release')));
const cache = resolve(value('--cache', resolve(project, 'dist/release-cache')));
const hostPython = value('--python', 'python');
const sourceRef = value('--source', 'HEAD');
const useWorktree = flag('--worktree');
if (!['local', 'hf'].includes(modelSource)) throw Error('--models must be local or hf');
for (const name of packages) if (!['scripts', 'runtime', 'omni'].includes(name)) throw Error(`Unknown package: ${name}`);

const log = message => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${message}`);

// ---------------------------------------------------------------- the Convai key (never printed)
function loadKey() {
  const envName = value('--key-env'), file = value('--key-file');
  let raw;
  if (envName) raw = process.env[envName];
  else if (file) raw = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  else return null;
  if (!raw || !raw.trim()) {
    if (dryRun) return null;
    throw Error('The Convai key is empty. Set the CONVAI_API_KEY secret, or build with --dry-run.');
  }
  const text = raw.trim();
  const key = /^api-key\s*=\s*(\S+)$/i.exec(text)?.[1] ?? text;
  if (!/^[A-Za-z0-9._~+/=-]{8,512}$/.test(key)) throw Error('The Convai key has an unexpected format (value not shown).');
  if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::add-mask::${key}\n`);
  return key;
}

// ---------------------------------------------------------------- source tree
async function prepareSource() {
  if (useWorktree) return {root: project, commit: 'worktree', time: Math.floor(Date.now() / 1000)};
  const git = args => {
    const result = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], {cwd: project, encoding: 'buffer', maxBuffer: 2 ** 31 - 1});
    if (result.status !== 0) throw Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
    return result.stdout;
  };
  const commit = git(['rev-parse', `${sourceRef}^{commit}`]).toString().trim();
  const time = Number(git(['log', '-1', '--format=%ct', commit]).toString().trim());
  const root = resolve(out, 'source');
  await rm(root, {recursive: true, force: true});
  await mkdir(root, {recursive: true});
  const tarball = resolve(out, 'source.tar');
  await writeFile(tarball, git(['archive', '--format=tar', commit]));
  await run(process.platform === 'win32' ? resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar',
    ['-xf', tarball, '-C', root], {quiet: true});
  await rm(tarball);
  return {root, commit, time};
}

// ---------------------------------------------------------------- package model
// A package is a map of game-relative entry name -> {source, start?, length?} or {buffer}.
class Package {
  constructor(id) { this.id = id; this.entries = new Map(); }
  add(name, entry) {
    if (this.entries.has(name)) throw Error(`${this.id}: duplicate entry ${name}`);
    this.entries.set(name, entry);
  }
  file(name, source) { this.add(name, {source}); }
  text(name, text) { this.add(name, {buffer: Buffer.from(text, 'utf8')}); }
  json(name, value) { this.text(name, JSON.stringify(value, null, 2) + '\n'); }
  async tree(prefix, directory, {skip} = {}) {
    for (const rel of await walk(directory, {skip})) this.file(`${prefix}/${rel}`, join(directory, rel));
  }
}

const sizeOf = async entry => entry.buffer ? entry.buffer.length : entry.length ?? (await stat(entry.source)).size;

// ---------------------------------------------------------------- helpers
function sourceDigest(files) {
  // Mirrors bridge/pocket_voice_runtime.py digest_source(): path, NUL, raw file hash, newline.
  const digest = createHash('sha256');
  for (const {rel, sha} of files) { digest.update(Buffer.from(`${rel}\0`, 'utf8')); digest.update(Buffer.concat([Buffer.from(sha, 'hex'), Buffer.from('\n')])); }
  return digest.digest('hex');
}

async function gitCheckout(repository, revision, directory, {sparse} = {}) {
  if (existsSync(resolve(directory, '.git'))) {
    const head = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).stdout.trim();
    if (head === revision) return directory;
    await rm(directory, {recursive: true, force: true});
  }
  await mkdir(dirname(directory), {recursive: true});
  const base = ['-c', 'core.autocrlf=false', '-c', 'core.symlinks=false'];
  await run('git', [...base, 'clone', '--quiet', '--no-checkout', ...(sparse ? ['--filter=blob:none'] : []), repository, directory], {quiet: true});
  if (sparse) await run('git', [...base, '-C', directory, 'sparse-checkout', 'set', '--no-cone', ...sparse], {quiet: true});
  await run('git', [...base, '-C', directory, 'checkout', '--quiet', revision], {quiet: true});
  return directory;
}

const IGNORED_SOURCE_PARTS = new Set(['.git', '__pycache__', '.pytest_cache', '.ruff_cache']);

// ---------------------------------------------------------------- models
async function resolveModels(config, source) {
  const files = new Map(); // logical "group/target" -> absolute local path
  const models = config.models;
  if (modelSource === 'local') {
    for (const group of models.groups) for (const name of group.files) {
      const path = resolve(project, group.local, name);
      if (!existsSync(path)) throw Error(`Local stand-in missing: ${group.local}${name}`);
      files.set(group.bucket + name, path);
    }
    return {files, referencePath: rel => resolve(project, models.references.local, rel), manifest: null};
  }
  const fetched = resolve(cache, 'models');
  const report = resolve(out, 'models-fetched.json');
  log('Downloading trained models from the private Hugging Face bucket.');
  await run(hostPython, [resolve(source.root, 'packaging/fetch-models.py'), '--config',
    resolve(source.root, 'packaging/release.config.json'), '--cache', fetched, '--report', report]);
  const result = await readJson(report);
  for (const [bucketPath, path] of Object.entries(result.files)) files.set(bucketPath, path);
  return {files, referencePath: rel => files.get(models.references.bucket + rel), manifest: result.manifest};
}

// ---------------------------------------------------------------- build steps
async function buildClient(source, stageDir) {
  const {build} = await import(pathToFileURL(resolve(project, 'node_modules/esbuild/lib/main.js')).href);
  const result = await build({
    absWorkingDir: source.root, entryPoints: [resolve(source.root, 'bridge/realtime-client.mjs')],
    outfile: resolve(stageDir, 'realtime-client.js'), bundle: true, format: 'esm', platform: 'browser',
    write: true, logLevel: 'silent', metafile: true, nodePaths: [resolve(project, 'node_modules')],
    legalComments: 'eof',
  });
  const packagesUsed = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll('\\', '/'));
    if (match) packagesUsed.add(match[1]);
  }
  return [...packagesUsed].sort();
}

async function buildLauncher(source) {
  const prebuilt = value('--launcher');
  if (prebuilt) return resolve(prebuilt);
  const output = resolve(out, 'native');
  await rm(output, {recursive: true, force: true});
  log('Compiling the RED4ext launcher from native/autostart with MSVC.');
  await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    resolve(source.root, 'scripts/Build-AutostartPlugin.ps1'), '-ProjectDirectory', source.root,
    '-OutputDirectory', output, '-TestHost'], {quiet: true});
  return resolve(output, 'CyberpunkConvaiLauncher.dll');
}

function launcherIni() {
  const lines = [
    '; Cyberpunk Convai: starts the conversation service with the game and stops it when the game exits.',
    '; Set enabled=0 to start it yourself instead.',
    '[launch]', 'enabled=1',
    'program=%PLUGIN%\\app\\node\\node.exe',
    'arg1=%PLUGIN%\\app\\launcher\\start-service.mjs',
    'working_directory=%PLUGIN%\\app',
  ];
  // GetPrivateProfileString reads Unicode only from UTF-16LE files with a byte order mark.
  return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf16le')]);
}

async function installPython(spec, lockFile, target, pthExtra) {
  const zip = await download(spec.url, resolve(cache, 'downloads', basename(spec.url)), spec.sha256, log);
  await extractZip(zip, target);
  const sitePackages = resolve(target, 'Lib/site-packages');
  log(`Installing ${basename(lockFile)} into ${posix(relative(out, target))} (hash-locked wheels, no dependency resolution).`);
  await run(hostPython, ['-m', 'pip', 'install', '--no-deps', '--require-hashes', '--only-binary=:all:', '--no-compile',
    '--disable-pip-version-check', '--no-warn-script-location', '--platform', 'win_amd64',
    '--python-version', spec.version.split('.').slice(0, 2).join('.'), '--implementation', 'cp',
    '--target', sitePackages, '--cache-dir', resolve(cache, 'pip'), '-r', lockFile], {quiet: true});
  // pip's generated console-script launchers are not part of any upstream wheel and are never used.
  await rm(resolve(sitePackages, 'bin'), {recursive: true, force: true});
  const pth = ['python' + spec.version.split('.').slice(0, 2).join('') + '.zip', '.', 'Lib\\site-packages', ...pthExtra, 'import site', ''];
  await writeFile(resolve(target, spec.pth), pth.join('\r\n'));
}

// Files a Python worker never loads at run time: C/C++ headers, link libraries, CMake files, caches.
const PYTHON_SKIP = rel => /(?:^|\/)__pycache__(?:\/|$)/.test(rel) || /\.pyc$/.test(rel)
  || /^Lib\/site-packages\/torch\/(?:include|share)\//.test(rel) || /^Lib\/site-packages\/torch\/lib\/[^/]+\.lib$/i.test(rel)
  // Build tools inside wheels: setuptools' script-launcher stubs and PyTorch's protobuf compiler.
  || /^Lib\/site-packages\/setuptools\/(?:cli|gui)[^/]*\.exe$/i.test(rel) || /^Lib\/site-packages\/torch\/bin\/[^/]+\.exe$/i.test(rel);

async function scriptsPackage(source, config) {
  const pkg = new Package('scripts');
  const mod = config.layout.modDirectory;
  const lua = (await walk(resolve(source.root, 'mod'))).filter(rel => rel.endsWith('.lua'));
  const {shipped, excluded} = await checkLuaPartition(resolve(source.root, 'mod'), lua, config.devOnlyLua);
  for (const rel of shipped) pkg.file(`${mod}/${rel}`, resolve(source.root, 'mod', rel));
  for (const {source: from, target} of config.catalogs) pkg.file(`${mod}/${target}`, resolve(source.root, from));
  const retired = new Set(config.retiredRedscript);
  for (const rel of await walk(resolve(source.root, 'r6/scripts/CyberpunkConvai'))) {
    if (rel.endsWith('.reds') && !retired.has(rel)) pkg.file(`r6/scripts/CyberpunkConvai/${rel}`, resolve(source.root, 'r6/scripts/CyberpunkConvai', rel));
  }
  pkg.json(`${mod}/release.json`, {product: config.product, package: 'scripts', version, commit: source.commit});
  pkg.text(`${mod}/README.txt`, await readFile(resolve(source.root, 'packaging/PLAYER_README.md'), 'utf8'));
  pkg.text(`${mod}/LICENSE.txt`, await readFile(resolve(source.root, 'LICENSE'), 'utf8'));
  for (const name of pkg.entries.keys()) {
    if (!/\.(?:lua|reds|json|txt)$/.test(name)) throw Error(`Scripts package must stay text-only: ${name}`);
  }
  return {pkg, devOnlyExcluded: excluded};
}

async function runtimePackage(source, config, models, key) {
  const pkg = new Package('runtime');
  const plugin = config.layout.pluginDirectory, app = `${plugin}/app`;
  const stage = resolve(out, 'stage/runtime');
  await rm(stage, {recursive: true, force: true});
  const tool = config.toolchain;
  const notices = [];

  // Launcher (compiled from native/autostart in this build) and its configuration.
  const dll = await buildLauncher(source);
  pkg.file(`${plugin}/${config.layout.pluginDll}`, dll);
  pkg.add(`${plugin}/launcher.ini`, {buffer: launcherIni()});
  pkg.text(`${plugin}/README.txt`, await readFile(resolve(source.root, 'packaging/PLAYER_README.md'), 'utf8'));
  pkg.text(`${plugin}/LICENSE.txt`, await readFile(resolve(source.root, 'LICENSE'), 'utf8'));

  // Node.js: the official Windows build, node.exe and its licence only.
  const nodeZip = await download(tool.node.url, resolve(cache, 'downloads', basename(tool.node.url)), tool.node.sha256, log);
  const nodeDir = resolve(cache, 'extract/node');
  await extractZip(nodeZip, nodeDir);
  for (const name of tool.node.files) pkg.file(`${app}/node/${name}`, resolve(nodeDir, tool.node.root, name));
  notices.push(`Node.js ${tool.node.version} - MIT and bundled licences: app/node/LICENSE - ${tool.node.url}`);

  // Browser: the official Chrome for Testing build Playwright ${version} is made for.
  const chromeZip = await download(tool.browser.url, resolve(cache, 'downloads', basename(tool.browser.url)), tool.browser.sha256, log);
  const chromeDir = resolve(stage, 'browser');
  await extractZip(chromeZip, chromeDir);
  await pkg.tree(`${app}/browser`, chromeDir);
  notices.push(`${tool.browser.name} ${tool.browser.version} (Chromium) - unmodified official build - ${tool.browser.url}`
    + ' - licences: https://chromium.googlesource.com/chromium/src/+/main/LICENSE and chrome://credits');

  // Python for the Pocket voice worker.
  const pythonDir = resolve(stage, 'python');
  await installPython(tool.python, resolve(source.root, tool.python.lock), pythonDir, ['..\\bridge']);
  await pkg.tree(`${app}/python`, pythonDir, {skip: PYTHON_SKIP});
  notices.push(`Python ${tool.python.version} embeddable distribution - PSF License: app/python/LICENSE.txt - ${tool.python.url}`);
  notices.push(`Python packages (${basename(tool.python.lock)}) - each package's licence is in its *.dist-info folder under app/python/Lib/site-packages`);

  // Pocket TTS source at the pinned upstream revision (the worker verifies its tree hash).
  const pocketDir = await gitCheckout(tool.pocketTts.repository, tool.pocketTts.revision, resolve(cache, 'git/pocket-tts'));
  const pocketFiles = (await walk(pocketDir, {skip: rel => rel.split('/').some(part => IGNORED_SOURCE_PARTS.has(part))}));
  const hashed = [];
  for (const rel of pocketFiles) hashed.push({rel, sha: await sha256File(resolve(pocketDir, rel))});
  const tree = sourceDigest(hashed);
  if (tree !== tool.pocketTts.treeSha256) throw Error(`Pocket TTS source hash ${tree} differs from the pinned ${tool.pocketTts.treeSha256}.`);
  for (const rel of pocketFiles) pkg.file(`${app}/pocket-tts/${rel}`, resolve(pocketDir, rel));
  notices.push(`Pocket TTS (Kyutai) ${tool.pocketTts.revision} - ${tool.pocketTts.license}: app/pocket-tts/LICENSE - ${tool.pocketTts.repository}`);

  // Bridge: the production import closure plus the worker scripts it starts by path.
  const closure = await importClosure(source.root, config.bridgeEntries);
  for (const rel of [...new Set([...closure, ...config.bridgeWorkers])].sort()) pkg.file(`${app}/${rel}`, resolve(source.root, rel));
  // Node packages the bridge imports at run time (the Convai SDK is compiled into the client bundle).
  for (const name of config.nodePackages) {
    const directory = resolve(project, 'node_modules', name);
    if (!existsSync(directory)) throw Error(`node_modules/${name} is missing: run npm ci first.`);
    await pkg.tree(`${app}/node_modules/${name}`, directory);
    const info = await readJson(resolve(directory, 'package.json'));
    notices.push(`${name} ${info.version} - ${info.license}: app/node_modules/${name}/LICENSE`);
  }

  // Browser client: a fresh bundle of bridge/realtime-client.mjs and the PCM player modules.
  const assetsDir = resolve(stage, 'assets');
  const bundled = await buildClient(source, assetsDir);
  pkg.file(`${app}/assets/realtime-client.js`, resolve(assetsDir, 'realtime-client.js'));
  for (const name of config.clientModules) pkg.file(`${app}/assets/${name}`, resolve(source.root, 'bridge', name));
  for (const name of bundled) {
    const directory = resolve(project, 'node_modules', name);
    const info = existsSync(resolve(directory, 'package.json')) ? await readJson(resolve(directory, 'package.json')) : {};
    const licences = (await readdir(directory).catch(() => [])).filter(file => /^(?:licen[cs]e|notice|copying)/i.test(file)).sort();
    for (const file of licences) pkg.file(`${app}/licenses/client/${name.replace('/', '__')}/${file}`, resolve(directory, file));
    notices.push(`${name} ${info.version ?? ''} - ${typeof info.license === 'string' ? info.license : 'see package'} (compiled into app/assets/realtime-client.js)`);
  }

  // Data the bridge reads from the application directory. A literal data path in the closure
  // that is missing from appData would fail at start-up, so refuse to build without it.
  for (const rel of closure) {
    const text = await readFile(resolve(source.root, rel), 'utf8');
    for (const match of text.matchAll(/resolve\(project, '((?:characters|research)\/[^']+\.json)'\)/g)) {
      if (!config.appData.includes(match[1])) throw Error(`${rel} reads ${match[1]}, which appData in release.config.json does not ship.`);
    }
  }
  for (const rel of config.appData) pkg.file(`${app}/${rel}`, resolve(source.root, rel));
  const intrinsic = await import(pathToFileURL(resolve(source.root, 'bridge/intrinsic-character-context.mjs')).href);
  for (const descriptor of intrinsic.REVIEWED_INTRINSIC_PACKS) pkg.file(`${app}/${descriptor.file}`, resolve(source.root, descriptor.file));

  // Trained models (Pocket voice, lip sync) and the default state templates.
  const group = prefix => config.models.groups.find(item => item.target === prefix);
  for (const target of ['app/models/pocket/', 'app/models/lipsync/']) {
    const item = group(target);
    for (const name of item.files) pkg.file(`${plugin}/${target}${name}`, models.files.get(item.bucket + name));
  }
  const configs = group('voice-configs/');
  const pocketConfig = JSON.parse(await readFile(models.files.get(configs.bucket + 'pocket-voices.autobest.json'), 'utf8'));
  await verifyPocketModel(pocketConfig, models.files, group('app/models/pocket/'));
  pkg.json(`${app}/defaults/pocket-voices.autobest.json`, templateOf(pocketConfig));
  for (const name of config.releaseData.managed) pkg.file(`${app}/defaults/${name}`, resolve(source.root, 'packaging/release-data', name));
  if (key) pkg.text(`${app}/defaults/service.txt`, `api-key = ${key}\n`);

  // Pocket reference clips: only those the live configuration uses, each checked against its hash.
  const pocketRefs = await referencesOf(pocketConfig, models);
  for (const [rel, path] of pocketRefs) pkg.file(`${plugin}/voices/${rel}`, path);

  // Launcher scripts, application metadata and notices.
  for (const name of ['start-service.mjs', 'prepare-state.mjs', 'assemble-parts.mjs']) pkg.file(`${app}/launcher/${name}`, resolve(source.root, 'packaging/runtime', name));
  pkg.json(`${app}/package.json`, {name: 'cyberpunk-convai', version: npmVersion(version), private: true, type: 'module'});

  // Game-side binary assets: the three generated archives and the Audioware reply bank.
  for (const item of config.releaseData.archives) pkg.file(item.target, resolve(source.root, item.source));
  const bank = resolve(stage, 'bank');
  const {initializeAudioDepot} = await import(pathToFileURL(resolve(source.root, 'bridge/speech-audio.mjs')).href);
  await initializeAudioDepot(bank);
  await pkg.tree('r6/audioware/CyberpunkConvai', resolve(bank, 'r6/audioware/CyberpunkConvai'));

  notices.push('Convai Web SDK (@convai/web-sdk) - Apache-2.0 (compiled into app/assets/realtime-client.js; licence text in app/licenses/client/)');
  notices.push('Lip-sync pronunciation table (app/models/lipsync/face-lexicon.txt.gz): CMU Pronouncing Dictionary, BSD-2-Clause, Copyright (c) 1993-2015 Carnegie Mellon University,'
    + ' plus 6553 game-vocabulary pronunciations generated with espeak-ng (espeak-ng is not shipped); see app/models/lipsync/face-lexicon-NOTICE.txt');
  notices.push('Pocket voice model (app/models/pocket/): adapted from Kyutai Pocket TTS (kyutai/pocket-tts), weights CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/), code MIT.'
    + ' Changes: the flow language-model tensors are weights trained for this mod and the Mimi decoder tensors are retrained. Kyutai prohibits voice impersonation or cloning without explicit and lawful consent.');
  notices.push('Pocket voice and lip-sync weights: trained for this mod; free for personal use with the mod.');
  notices.push('Cyberpunk 2077, its audio and voice performances belong to CD PROJEKT RED and the performers; the reference voice clips (voices/) and game archives (archive/pc/mod/) are not licensed by the Cyberpunk Convai Use License.');
  notices.push('Cyberpunk Convai itself: Cyberpunk Convai Use License, see LICENSE.txt in the plugin folder.');
  pkg.text(`${app}/licenses/THIRD-PARTY-NOTICES.txt`, ['Cyberpunk Convai runtime - third-party components', '', ...notices.map(line => `- ${line}`), ''].join('\r\n'));
  pkg.text(`${app}/licenses/THIRD_PARTY_NOTICES.md`, await readFile(resolve(source.root, 'THIRD_PARTY_NOTICES.md'), 'utf8'));
  pkg.json(`${app}/release.json`, {product: config.product, package: 'runtime', version, commit: source.commit,
    node: tool.node.version, python: tool.python.version, browser: `${tool.browser.name} ${tool.browser.version}`,
    pocketTts: tool.pocketTts.revision, pocketModel: pocketConfig.model.sha256, convaiKey: key ? 'package' : 'player'});
  return pkg;
}

function templateOf(config) {
  const copy = structuredClone(config);
  delete copy.referenceRegistry; delete copy.proposal;
  // Paths are filled in for the player's installation by app/launcher/prepare-state.mjs.
  if (copy.runtime) copy.runtime = {note: 'filled in at start-up by app/launcher/prepare-state.mjs'};
  return copy;
}

async function verifyPocketModel(config, files, group) {
  const expected = {'model.safetensors': config.model.sha256, 'inference.yaml': config.model.configSha256,
    'tokenizer.json': config.model.tokenizerSha256, 'receipt.json': config.model.receiptSha256};
  for (const [name, sha] of Object.entries(expected)) {
    const actual = await sha256File(files.get(group.bucket + name));
    if (actual !== sha) throw Error(`Pocket model ${name} does not match its configuration (${actual} != ${sha}).`);
  }
}

async function referencesOf(config, models) {
  const result = new Map();
  for (const [key, descriptor] of Object.entries(config.voices || {})) {
    if ((descriptor.status ?? 'ready') !== 'ready') continue;
    const rel = descriptor.reference.replace(/^runtime\/voice-references\//, '');
    if (rel === descriptor.reference || rel.includes('..')) throw Error(`Unexpected reference path for ${key}`);
    if (result.has(rel)) continue;
    const path = models.referencePath(rel);
    if (!path || !existsSync(path)) throw Error(`Missing reference clip for ${key}: ${rel}`);
    if (await sha256File(path) !== descriptor.sha256) throw Error(`Reference clip for ${key} differs from its configured hash.`);
    result.set(rel, path);
  }
  return result;
}

async function omniPackage(source, config, models) {
  const pkg = new Package('omni');
  const plugin = config.layout.pluginDirectory, omni = `${plugin}/app/omni`;
  const stage = resolve(out, 'stage/omni');
  await rm(stage, {recursive: true, force: true});
  const tool = config.toolchain;
  const notices = [];

  const pythonDir = resolve(stage, 'python');
  await installPython(tool.omniPython, resolve(source.root, tool.omniPython.lock), pythonDir, ['..\\..\\bridge']);
  // OmniVoice's own Python package, from VoiceStudio at the pinned revision.
  const studio = tool.voiceStudio;
  const studioDir = await gitCheckout(studio.repository, studio.revision, resolve(cache, 'git/voicestudio'),
    {sparse: [...studio.adapter.map(path => `/${path}/`), `/${studio.package}/`, ...studio.notices.map(path => `/${path}`)]});
  const tracked = spawnSync('git', ['-C', studioDir, 'ls-files'], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024}).stdout.split('\n').filter(Boolean);
  const excluded = rel => studio.packageExclude.some(prefix => rel === prefix || rel.startsWith(prefix + '/'))
    || /(?:^|\/)tests?\//.test(rel);
  for (const rel of tracked) {
    if (excluded(rel)) continue;
    if (rel.startsWith(studio.package + '/')) await copyInto(resolve(studioDir, rel), resolve(pythonDir, 'Lib/site-packages', rel));
  }
  await pkg.tree(`${omni}/python`, pythonDir, {skip: PYTHON_SKIP});
  for (const rel of tracked) {
    if (excluded(rel)) continue;
    if (studio.adapter.some(prefix => rel.startsWith(prefix + '/'))) pkg.file(`${omni}/voicestudio/${rel}`, resolve(studioDir, rel));
    if (studio.notices.includes(rel)) pkg.file(`${omni}/voicestudio/${rel}`, resolve(studioDir, rel));
  }
  pkg.text(`${omni}/voicestudio/SOURCE.txt`, `VoiceStudio ${studio.revision}\r\n${studio.repository}\r\n`
    + `Licence: ${studio.license} (see LICENSE). The complete corresponding source is available at the repository above at this revision.\r\n`);
  notices.push(`Python ${tool.omniPython.version} embeddable distribution - PSF License: app/omni/python/LICENSE.txt`);
  notices.push(`Python packages (${basename(tool.omniPython.lock)}), including PyTorch with CUDA 12.8 - licences in each *.dist-info folder`);
  notices.push(`VoiceStudio ${studio.revision} (OmniVoice adapter and the omnivoice package) - ${studio.license} - ${studio.repository}`);

  // The OmniVoice model, unmodified, at the pinned revision.
  const model = tool.omniModel;
  const modelDir = resolve(cache, `omnivoice-${model.revision.slice(0, 12)}`);
  for (const [rel, spec] of Object.entries(model.files)) {
    let path;
    if (modelSource === 'local' && existsSync(resolve(project, model.localSnapshot, rel))) {
      path = resolve(project, model.localSnapshot, rel);
      if ((await stat(path)).size !== spec.size || await sha256File(path) !== spec.sha256) throw Error(`Local OmniVoice ${rel} differs from the pinned file.`);
    } else {
      path = await download(model.urlTemplate.replace('{revision}', model.revision).replace('{path}', rel), resolve(modelDir, rel), spec.sha256, log);
    }
    pkg.file(`${omni}/model/${rel}`, path);
  }
  notices.push(`OmniVoice model (${model.repository} ${model.revision}) - code Apache-2.0, pretrained weights CC-BY-NC (see app/omni/model/README.md)`);
  notices.push('OmniVoice audio tokenizer - Boson Higgs Audio 2 Community License (app/omni/model/audio_tokenizer/LICENSE)');
  notices.push(`The OmniVoice weights are non-commercial (CC-BY-NC). VoiceStudio is AGPL-3.0-only: complete source at ${studio.repository} revision ${studio.revision} (app/omni/voicestudio/SOURCE.txt).`);
  notices.push('Cyberpunk Convai itself: Cyberpunk Convai Use License, see LICENSE.txt in this folder.');
  pkg.text(`${omni}/LICENSE.txt`, await readFile(resolve(source.root, 'LICENSE'), 'utf8'));

  // OmniVoice voice configurations and their reference clips.
  const configs = config.models.groups.find(item => item.target === 'voice-configs/');
  const seen = new Set();
  for (const name of ['local-voices.autobest-short.json', 'local-voices.autobest-long.json']) {
    const value = JSON.parse(await readFile(models.files.get(configs.bucket + name), 'utf8'));
    if (value.revision !== model.revision) throw Error(`${name} names OmniVoice ${value.revision}, not the packaged ${model.revision}.`);
    const copy = structuredClone(value); delete copy.proposal;
    pkg.json(`${omni}/defaults/${name}`, copy);
    for (const [rel, path] of await referencesOf(value, models)) {
      if (seen.has(rel)) continue;
      seen.add(rel); pkg.file(`${plugin}/voices/${rel}`, path);
    }
  }
  pkg.text(`${omni}/THIRD-PARTY-NOTICES.txt`, ['Cyberpunk Convai OmniVoice pack - third-party components', '', ...notices.map(line => `- ${line}`), ''].join('\r\n'));
  pkg.json(`${omni}/omni-pack.json`, {product: config.product, package: 'omni', version, commit: '' + source.commit,
    python: tool.omniPython.version, model: `${model.repository}@${model.revision}`, adapter: `${studio.repository}@${studio.revision}`});
  return pkg;
}

// ---------------------------------------------------------------- archives
async function splitLargeFiles(pkg, config) {
  for (const [name, entry] of [...pkg.entries]) {
    const size = await sizeOf(entry);
    if (size <= config.limits.splitFileBytes) continue;
    if (!entry.source || !name.includes('/app/omni/')) throw Error(`${name} is too large to ship in one piece.`);
    const sha = await sha256File(entry.source);
    const parts = [];
    for (let start = 0, index = 1; start < size; start += config.limits.splitPartBytes, index++) {
      const length = Math.min(config.limits.splitPartBytes, size - start);
      parts.push({name: `${basename(name)}.part${index}`, size: length, sha256: await sha256File(entry.source, {start, length}), start});
    }
    pkg.entries.delete(name);
    for (const part of parts) pkg.add(`${dirname(name)}/${part.name}`, {source: entry.source, start: part.start, length: part.size});
    pkg.json(`${name}.parts.json`, {file: basename(name), size, sha256: sha, parts: parts.map(({name: n, size: s, sha256}) => ({name: n, size: s, sha256}))});
  }
}

async function writeArchives(pkg, baseName, config, timestamp) {
  const directory = resolve(out, 'packages');
  await mkdir(directory, {recursive: true});
  const names = [...pkg.entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const limitPath = config.layout.maxPathLength - config.layout.maxGameRootLength - 1;
  const tooLong = names.filter(name => name.length > limitPath);
  if (tooLong.length) throw Error(`${tooLong.length} paths are too long for a typical game folder, e.g. ${tooLong[0]}`);
  const archives = [];
  let writer = null, index = 0;
  const open = async () => { index++; writer = await ZipWriter.create(resolve(directory, `${baseName}.part${index}.tmp`), {timestamp}); };
  const files = [];
  await open();
  for (const name of names) {
    const entry = pkg.entries.get(name), size = await sizeOf(entry);
    const bound = Math.ceil(size * 1.001) + 1024 + 2 * name.length + 128;
    if (writer.count && (writer.size + bound > config.limits.assetBytes || writer.count >= 60000)) {
      archives.push(await writer.close()); await open();
    }
    const added = await writer.add(name, entry);
    files.push({path: name, bytes: size, sha256: added.sha256});
  }
  archives.push(await writer.close());
  const result = [];
  for (const [position, archive] of archives.entries()) {
    const final = archives.length === 1 ? `${baseName}.zip` : `${baseName}-part${position + 1}of${archives.length}.zip`;
    await rename(archive.path, resolve(directory, final));
    const path = resolve(directory, final);
    result.push({file: final, bytes: archive.bytes, entries: archive.entries, sha256: await sha256File(path)});
  }
  return {archives: result, files};
}

// ---------------------------------------------------------------- main
async function main() {
  await mkdir(out, {recursive: true});
  for (const name of ['packages', 'stage', 'native']) await rm(resolve(out, name), {recursive: true, force: true});
  const key = loadKey();
  log(`Building ${[...packages].join(', ')} ${version}${dryRun ? ' (dry run)' : ''}; models from ${modelSource}; Convai key ${key ? 'embedded' : 'not embedded'}.`);
  const source = await prepareSource();
  log(`Source: ${source.commit}`);
  const config = await readJson(resolve(source.root, 'packaging/release.config.json'));
  const timestamp = new Date(source.time * 1000);
  const models = (packages.has('runtime') || packages.has('omni')) ? await resolveModels(config, source) : null;
  const report = {product: config.product, version, commit: source.commit, dryRun, models: modelSource,
    built: new Date().toISOString(), packages: {}};

  const builders = {
    scripts: async () => { const {pkg, devOnlyExcluded} = await scriptsPackage(source, config); report.devOnlyLuaExcluded = devOnlyExcluded; return pkg; },
    runtime: () => runtimePackage(source, config, models, key),
    omni: () => omniPackage(source, config, models),
  };
  const titles = {scripts: 'Scripts', runtime: 'Runtime', omni: 'OmniPack'};
  for (const id of ['scripts', 'runtime', 'omni']) {
    if (!packages.has(id)) continue;
    log(`Staging the ${titles[id]} package.`);
    const pkg = await builders[id]();
    await splitLargeFiles(pkg, config);
    log(`Writing ${titles[id]} (${pkg.entries.size} files).`);
    const result = await writeArchives(pkg, `${config.product}-${titles[id]}-${version}`, config, timestamp);
    report.packages[id] = {archives: result.archives, fileCount: result.files.length,
      uncompressedBytes: result.files.reduce((sum, file) => sum + file.bytes, 0)};
    await writeFile(resolve(out, 'packages', `${config.product}-${titles[id]}-${version}.files.json`), JSON.stringify(result.files, null, 1) + '\n');
    for (const archive of result.archives) log(`  ${archive.file}: ${(archive.bytes / 1024 ** 2).toFixed(1)} MiB, ${archive.entries} entries`);
  }
  const sums = Object.values(report.packages).flatMap(item => item.archives).map(item => `${item.sha256}  ${item.file}`);
  await writeFile(resolve(out, 'packages', 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  await writeFile(resolve(out, 'packages', 'release-manifest.json'), JSON.stringify(report, null, 2) + '\n');
  // Final guard: no archive may carry an obvious credential file or development state.
  for (const item of Object.values(report.packages).flatMap(entry => entry.archives)) {
    for (const entry of await listZip(resolve(out, 'packages', item.file))) {
      if (/^misc\//.test(entry.name)) throw Error(`${item.file} contains developer-only material: ${entry.name}`);
      if (/(?:^|\/)(?:convai-key\.txt|kaggle-access-token\.txt|huggingface-[^/]*\.txt|\.env|player-memory[^/]*\.(?:json|bak|tmp)|phone-sessions\.json|characters-verified\.json)$/i.test(entry.name)) {
        throw Error(`${item.file} contains a forbidden file: ${entry.name}`);
      }
    }
  }
  if (!useWorktree) await rm(source.root, {recursive: true, force: true});
  log(`Done: ${resolve(out, 'packages')}`);
}

main().catch(error => { console.error(`Release build failed: ${error?.stack || error}`); process.exit(1); });
