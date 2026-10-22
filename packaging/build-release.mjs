// Builds the player release packages. Run by .github/workflows/release.yml, and locally:
//
//   node packaging/build-release.mjs --version 0.2 --dry-run          (local stand-ins, no secrets)
//   node packaging/build-release.mjs --version 0.2 --models hf   (CI: CONVAI_AUTH_URL and CONVAI_AUTH_CLIENT_SECRET in the environment)
//
// Packages (dist/release/packages/):
//   AI-NPC-Cyberpunk-Mod-Scripts-<v>.zip        text only: CET Lua, redscript, JSON catalogs (for Nexus Mods; the name the owner uploads there)
//   Runtime-<v>[...].zip                        launcher, bundled Node/Python, bridge, models, voices,
//                                               game archives and the Audioware bank (GitHub)
//   The optional packs are hosted on Hugging Face (alystria-ai/ai-npc-cyberpunk-mod-packs, each in its own folder; packaging/upload-packs.py),
//   each ONE zip with no parts and no split files (the zip is ZIP64 where a model is over 4 GiB). Every package except the Scripts drops
//   the product prefix, and the version stays in the build folder only (the uploader publishes them under the unversioned name):
//   OmniPack-<v>.zip                            optional OmniVoice GPU pack (voice/)
//   LocalAI-Standard-<v>.zip                    optional Local AI pack, Gemma 4 E4B (local-ai/)
//   LocalAI-Lite-<v>.zip                        optional Local AI pack, Bonsai 2 4B (local-ai/)
//   Mature-Lite-<v>.zip                         optional Mature lite pack, one uncensored model (Qwen3.5-4B); only with --packages mature-lite,
//                                               never in the default set, never Nexus; it carries its own marker, so it works alone (mature/)
//   Mature-Standard-<v>.zip                     optional Mature standard pack, one uncensored model (Gemma 4 E4B); only with --packages mature-standard (mature/)
//   MicPack-European-<v>.zip                    optional voice-input pack, NVIDIA Parakeet TDT 0.6B v3 (int8); only with --packages micpack-european (mic/)
//   MicPack-Asian-<v>.zip                       optional voice-input pack, SenseVoice Small (int8), Chinese, Japanese, Korean; only with --packages micpack-asian (mic/)
//                                               (neither is in the default set or on Nexus; the model files come from the pinned sherpa-onnx archive, or --mic-pack-source)
// Only the Scripts (Nexus) and Runtime (GitHub release) packages may still be split into several zips (writeArchives).
// plus release-manifest.json (no loose checksum files: nothing reads them). The Runtime package also carries the native plugin
// (red4ext/plugins/AiNpcCyberpunkModNative) and runtime/native-off.txt. See docs/PACKAGING.md.
//
// Options:
//   --version V        release version, 2077.N or 2077.N.M (required)
//   --dry-run          local build: models from the developer runtime/ folder; the sign-in settings below may be left out
//   --models local|hf  where trained models come from (default: hf, or local with --dry-run)
//   --packages LIST    comma list of scripts,runtime,omni,localai-standard,localai-lite,mature-lite,mature-standard,micpack-european,micpack-asian (default: the first five)
//   --source REF       git ref to package (default HEAD); --worktree packages the working tree instead
//   --auth-url URL     the token backend's address (https://<backend>/api/convai/token; default: the CONVAI_AUTH_URL environment variable)
//   --auth-secret-env NAME  the environment variable that holds the backend's client request secret (default CONVAI_AUTH_CLIENT_SECRET; at least
//                      32 characters, never printed). The Runtime ships NO Convai key: it carries these two as app/defaults/convai-auth.json,
//                      and a build of it without both fails (a --dry-run may leave them out). --key-env and --key-file are refused.
//   --launcher PATH    use a prebuilt launcher DLL instead of compiling native/autostart with MSVC
//   --native PATH      use a prebuilt CyberpunkConvaiNative.dll instead of compiling native/core with MSVC
//   --no-native        leave the native plugin out (the Lua keeps its own path)
//   --vision PATH      use a prebuilt CyberpunkConvaiVision.exe instead of compiling native/vision with MSVC
//   --no-vision        leave the "Companions can see" picture helper out (turns then carry no picture)
//   --local-ai-source DIR  with --models local: a folder shaped like the Local AI developer folder
//                      (default: CYBERPUNK_CONVAI_LOCAL_AI_DEV); a file missing there is downloaded
//   --mic-pack-source DIR  the voice-input packs' model files from a developer folder DIR/<pack id>/<file> instead of the pinned
//                      download (default: CYBERPUNK_CONVAI_MIC_PACKS_DEV); every file is checked against its pinned size and SHA-256
//   --release-config PATH  read the pinned inputs from this file instead of packaging/release.config.json (for the packaging tests)
//   --python EXE       host CPython used to run pip (default: python)
//   --out DIR, --cache DIR   output and download-cache folders (default dist/release, dist/release-cache)
import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile, copyFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {basename, dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {ZipWriter, listZip} from './lib/zip.mjs';
import {isReleaseVersion, npmVersion} from './lib/version.mjs';
import {importClosure, checkLuaPartition} from './lib/closure.mjs';
import {loadRuntimeExchange} from './lib/runtime-exchange.mjs';
import {AUTH_SECRET_ENV, AUTH_URL_ENV, SHIPPED_KEY_FILE, addPackagedAuth, readAuthInputs} from './lib/convai-auth.mjs';
import {copyInto, download, exists, extractZip, inside, posix, readJson, run, sha256Buffer, sha256File, walk, writeText} from './lib/files.mjs';
import {RUNTIME_PREPARED_FOLDER, LANGUAGE_PACK_TREE} from './lib/pack-overlap.mjs';
import {crcOfFile, omniMarker, omniNoticeLines, omniNoticesText, omniPythonSkip, runtimeClipSet} from './lib/omni-pack-rules.mjs';
import {POCKET_MODEL_TREE} from './lib/pack-overlap.mjs';
import {launcherIni} from './lib/launcher-ini.mjs';
import {nativeOffText} from './lib/native-off.mjs';
import {checkPocketSourceList, parsePocketSourceList} from './lib/pocket-source-list.mjs';
import {DECLARED_REMOVALS, REMOVALS_ENTRY, checkRemovals, removalListText} from './lib/runtime-removals.mjs';
import {BASE_FILE, STEPS_DIR, baseText} from '../bridge/runtime-steps.mjs';

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
// 'mature-lite' and 'mature-standard' are the two separate adult-flagged Mature packs (packaging/MATURE_PACK_README.md), one model each: built only
// when asked for, never in the default set. 'micpack-european' and 'micpack-asian' are the two voice-input packs (docs/LOCAL_STT.md), opt-in the same way.
// The optional packs (OPTIONAL_PACKAGE_IDS) are hosted on Hugging Face as one zip each.
const PACKAGE_IDS = ['scripts', 'runtime', 'omni', 'localai-standard', 'localai-lite', 'mature-lite', 'mature-standard', 'micpack-european', 'micpack-asian'];
const DEFAULT_PACKAGE_IDS = PACKAGE_IDS.filter(id => !id.startsWith('mature') && !id.startsWith('micpack'));
const OPTIONAL_PACKAGE_IDS = new Set(['omni', 'localai-standard', 'localai-lite', 'mature-lite', 'mature-standard', 'micpack-european', 'micpack-asian']);
const packages = new Set(value('--packages', DEFAULT_PACKAGE_IDS.join(',')).split(',').map(item => item.trim()).filter(Boolean));
const localAiSource = value('--local-ai-source', process.env.CYBERPUNK_CONVAI_LOCAL_AI_DEV);
const out = resolve(value('--out', resolve(project, 'dist/release')));
const cache = resolve(value('--cache', resolve(project, 'dist/release-cache')));
const hostPython = value('--python', 'python');
const sourceRef = value('--source', 'HEAD');
const useWorktree = flag('--worktree');
if (!['local', 'hf'].includes(modelSource)) throw Error('--models must be local or hf');
for (const name of packages) if (!PACKAGE_IDS.includes(name)) throw Error(`Unknown package: ${name}`);

const log = message => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${message}`);

// ---------------------------------------------------------------- the token backend (the secret is never printed)
// The Runtime ships no Convai key (packaging/lib/convai-auth.mjs): only the backend's address and its client secret.
function loadAuth() {
  if (argv.includes('--key-env') || argv.includes('--key-file')) {
    throw Error('The Convai key is no longer shipped: --key-env and --key-file are refused. The Runtime signs in through the token backend; use --auth-url and --auth-secret-env (or CONVAI_AUTH_URL and CONVAI_AUTH_CLIENT_SECRET).');
  }
  const secretName = value('--auth-secret-env', AUTH_SECRET_ENV);
  const secret = process.env[secretName];
  if (secret && secret.trim() && process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::add-mask::${secret.trim()}\n`);
  return readAuthInputs({url: value('--auth-url', process.env[AUTH_URL_ENV]), secret, required: packages.has('runtime') && !dryRun, secretName});
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

// Every package carries this note at its top level, so a player who opens the zip sees where it goes before extracting.
// The same text in every package, so extracting several over one another is harmless. THE TEXT IS FIXED: the Mature packs already published
// on Hugging Face (reused unchanged by later versions) carry this exact file (574 bytes), and a Scripts or Runtime zip with other words in
// it would make Windows ask whether to replace it. Change it only together with a rebuild of every pack
// (packaging/pack-overlap.test.mjs fails when the text drifts from the packs' copy).
const INSTALL_NOTE_NAME = 'HOW TO INSTALL - extract into your Cyberpunk 2077 folder.txt';
const INSTALL_NOTE = [
  'AI NPC Cyberpunk Mod',
  '',
  'Extract this zip INTO your Cyberpunk 2077 folder (the folder that has bin, archive and r6 in it), and allow folders to merge.',
  'The zip already starts with the right folders (red4ext or bin).',
  '',
  'Do not extract it into a new folder named after the zip. Windows "Extract All" and 7-Zip "Extract to <name>" do that by default:',
  'change the destination to the Cyberpunk 2077 folder itself. If it happened anyway, the mod moves its optional pack files into',
  'place by itself the next time the game starts.',
  '',
  'You can delete this text file after installing.',
  ''].join('\r\n');

// ---------------------------------------------------------------- package model
// A package is a map of game-relative entry name -> {source, start?, length?} or {buffer}.
class Package {
  constructor(id) { this.id = id; this.entries = new Map(); }
  add(name, entry) {
    if (this.entries.has(name)) throw Error(`${this.id}: duplicate entry ${name}`);
    // The voice language packs' folder belongs to their own zips (docs/VOICE_LANGUAGE_PACKS.md): the Runtime and the Scripts never ship a file in it.
    if (['scripts', 'runtime'].includes(this.id) && name.toLowerCase().startsWith(LANGUAGE_PACK_TREE.toLowerCase())) {
      throw Error(`${this.id}: ${name} is in the voice language packs' folder, which only their own zips write`);
    }
    // The PocketTTS models' folder is theirs alone in the same way (docs/POCKET_LANGUAGE_MODELS.md).
    if (['scripts', 'runtime'].includes(this.id) && name.toLowerCase().startsWith(POCKET_MODEL_TREE.toLowerCase())) {
      throw Error(`${this.id}: ${name} is in the PocketTTS models' folder, which only their own zips write`);
    }
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

// The "Companions can see" picture helper (native/vision, docs/COMPANION_VISION.md). Optional: without it turns simply
// sends no picture, so a failed build is logged and the release goes on (--no-vision skips it, --vision PATH uses a prebuilt one).
async function buildVision(source) {
  if (flag('--no-vision')) return null;
  const prebuilt = value('--vision');
  if (prebuilt) {
    if (!existsSync(resolve(prebuilt))) throw Error(`--vision: ${prebuilt} does not exist.`);
    return resolve(prebuilt);
  }
  const output = resolve(out, 'native-vision');
  await rm(output, {recursive: true, force: true});
  log('Compiling the vision helper from native/vision with MSVC.');
  try {
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      resolve(source.root, 'scripts/Build-VisionCapture.ps1'), '-ProjectDirectory', source.root, '-OutputDirectory', output], {quiet: true});
    return resolve(output, 'CyberpunkConvaiVision.exe');
  } catch (error) { log(`The vision helper was not built (${error.message}); the release ships without it.`); return null; }
}

// The optional native plugin (native/core). Built with MSVC and CMake like the launcher. The package works without it,
// because the Lua keeps its own path for every system, but a failed build fails the release unless --no-native says so.
async function buildNative(source) {
  if (flag('--no-native')) return null;
  const prebuilt = value('--native');
  if (prebuilt) {
    if (!existsSync(resolve(prebuilt))) throw Error(`--native: ${prebuilt} does not exist.`);
    return resolve(prebuilt);
  }
  const output = resolve(out, 'native-core');
  await rm(output, {recursive: true, force: true});
  log('Compiling the native plugin from native/core with MSVC (the headless tests run as part of it).');
  await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    resolve(source.root, 'scripts/Build-NativeCore.ps1'), '-ProjectDirectory', source.root, '-OutputDirectory', output], {quiet: true});
  const dll = resolve(output, 'CyberpunkConvaiNative.dll');
  if (!existsSync(dll)) throw Error('The native build produced no DLL.');
  // The file-only inspector the install test runs on the extracted DLL (it maps the image without running any of its code).
  const host = resolve(output, 'build/Release/convai_plugin_host.exe');
  await mkdir(resolve(out, 'native'), {recursive: true});
  if (existsSync(host)) await copyFile(host, resolve(out, 'native/convai_plugin_host.exe'));
  await rm(resolve(output, 'build'), {recursive: true, force: true});
  return dll;
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
  // The runtime/ files the Lua and the bridge exchange, as empty placeholders: under Mod Organizer 2 a file created in the game
  // folder lands in Overwrite and is gone at the next launch, while an existing one is only ever modified or replaced
  // (packaging/lib/runtime-exchange.mjs). An update that extracts over a running install only empties transient files.
  for (const name of (await loadRuntimeExchange(source.root)).exchange) pkg.text(`${mod}/runtime/${name}`, '');
  for (const name of pkg.entries.keys()) {
    if (!/\.(?:lua|reds|json|txt|log|ndjson)$/.test(name)) throw Error(`Scripts package must stay text-only: ${name}`);
  }
  return {pkg, devOnlyExcluded: excluded};
}

async function runtimePackage(source, config, models, auth) {
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
  // The launcher opens launcher.log in the game process with CREATE_ALWAYS. Under Mod Organizer 2 that is a new file in Overwrite
  // unless one exists; an existing real file opened for writing stays in place, so it ships empty.
  pkg.text(`${plugin}/launcher.log`, '');
  pkg.text(`${plugin}/README.txt`, await readFile(resolve(source.root, 'packaging/PLAYER_README.md'), 'utf8'));
  pkg.text(`${plugin}/LICENSE.txt`, await readFile(resolve(source.root, 'LICENSE'), 'utf8'));

  // The vision helper sits beside the bridge (bridge/vision-capture.mjs looks for app/vision/CyberpunkConvaiVision.exe).
  const visionExe = await buildVision(source);
  if (visionExe) pkg.file(`${app}/vision/CyberpunkConvaiVision.exe`, visionExe);

  // The optional native plugin: RED4ext loads it from red4ext/plugins/<name>/, and runtime/native-off.txt (the kill switch, always
  // shipped; native.off in release.config.json lists the systems that start off, none at present) keeps those on their script path.
  const nativeDll = await buildNative(source);
  if (nativeDll) {
    const native = config.layout.nativeDirectory;
    pkg.file(`${native}/${config.layout.nativeDll}`, nativeDll);
    for (const [name, rel] of Object.entries(config.native.licences)) pkg.file(`${native}/${name}`, resolve(source.root, rel));
    pkg.text(`${native}/README.txt`, 'Optional speed-up plugin for AI NPC Cyberpunk Mod, loaded by RED4ext.\r\n'
      + 'AI NPC Cyberpunk Mod works the same without it: delete this folder and the mod runs entirely from its scripts.\r\n'
      + 'To switch one native system off, put its name on a line of runtime\\native-off.txt in the mod folder.\r\n');
    pkg.text(config.native.offFile, nativeOffText(config.native.off));
    notices.push('Native plugin (red4ext/plugins/AiNpcCyberpunkModNative/CyberpunkConvaiNative.dll, built from native/core in this release): yyjson 0.12.0 (MIT, Copyright (c) 2020 YaoYuan)'
      + ' and the RED4ext.SDK headers (MIT, Copyright (c) 2020 - present Octavian Dima); the licence texts are in that folder.');
  }

  // Node.js: the official Windows build, node.exe and its licence only.
  const nodeZip = await download(tool.node.url, resolve(cache, 'downloads', basename(tool.node.url)), tool.node.sha256, log);
  const nodeDir = resolve(cache, 'extract/node');
  await extractZip(nodeZip, nodeDir);
  for (const name of tool.node.files) pkg.file(`${app}/node/${name}`, resolve(nodeDir, tool.node.root, name));
  notices.push(`Node.js ${tool.node.version} - MIT and bundled licences: app/node/LICENSE - ${tool.node.url}`);

  // No browser is bundled: the hidden browser is the Edge that ships with Windows, else an installed Chrome (bridge/system-browser.mjs).

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
  // The worker checks the installed source against the list of these files in bridge/pocket_voice_runtime.py (extra files beside them are ignored);
  // a list that is not these files would fail every player's voice, so the build stops here instead.
  checkPocketSourceList(parsePocketSourceList(await readFile(resolve(source.root, 'bridge/pocket_voice_runtime.py'), 'utf8')), hashed);
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
  for (const target of ['app/models/pocket/', 'app/models/lipsync/', 'app/models/stt/moonshine-tiny-en-int8/']) {
    const item = group(target);
    for (const name of item.files) pkg.file(`${plugin}/${target}${name}`, models.files.get(item.bucket + name));
  }
  const configs = group('voice-configs/');
  const pocketConfig = JSON.parse(await readFile(models.files.get(configs.bucket + 'pocket-voices.autobest.json'), 'utf8'));
  await verifyPocketModel(pocketConfig, models.files, group('app/models/pocket/'));
  pkg.json(`${app}/defaults/pocket-voices.autobest.json`, templateOf(pocketConfig));
  // The Runtime's own OmniVoice lists, beside the Pocket list: app/launcher/prepare-state.mjs reads them before the pack's copy in app/omni/defaults.
  // Every Runtime carries them, because nothing deletes an earlier version's files: a list an older Runtime left in app/defaults would
  // otherwise win over a newer pack's at every start (docs/PACKAGING.md, "Packs reused unchanged"). Without the pack they are not used.
  for (const name of OMNI_LIST_NAMES) pkg.json(`${app}/defaults/${name}`, await omniListOf(models.files.get(configs.bucket + name), name, config.toolchain.omniModel));
  for (const name of config.releaseData.managed) pkg.file(`${app}/defaults/${name}`, resolve(source.root, 'packaging/release-data', name));
  // No Convai key: the Runtime signs in through the token backend (bridge/convai-credential.mjs reads this file as its lowest-priority source;
  // the daily limit applies to that sign-in). Not the error reports' file: app/defaults/error-reports.json has its own secret and is not written here.
  if (auth) addPackagedAuth(pkg, app, auth);

  // Pocket reference clips: only those the live configuration uses, each checked against its hash.
  const pocketRefs = await referencesOf(pocketConfig, models);
  for (const [rel, path] of pocketRefs) pkg.file(`${plugin}/voices/${rel}`, path);
  // V's voice for typed lines (docs/V_VOICE.md): the two clips cut from the game's own V lines, beside the other voice references. They
  // are kept out of git (assets/v-voice/*.wav), so they are packed from the local copy, like an add-on's voice clips. A build without
  // them still works: the setting then has no voice to use and says so in the log.
  const vVoiceFiles = await vVoiceReferenceFiles();
  for (const [rel, path] of vVoiceFiles) pkg.file(`${plugin}/voices/v-voice/${rel}`, path);
  log(vVoiceFiles.size ? `V voice: ${vVoiceFiles.size - 2} reference clips (and the V voice mod line list) in the Runtime package.` : 'V voice: assets/v-voice has no clips; this build ships none (the setting stays silent).');
  // The Mistral voice's reference clips, already cut and encoded, in the Runtime's own slot folder (voices/prepared-runtime, which the bridge reads
  // after its cache in voices/prepared). The OmniVoice pack ships slots for its clips in voices/prepared, so the Runtime must not: the same path
  // with other bytes would make Windows offer to replace one with the other.
  const voxtral = await voxtralCache(source, models, resolve(stage, 'voxtral-prepared'), [{version: 2, provider: 'hybrid', engine: 'omnivoice', voices: pocketConfig.voices}],
    {label: 'Voxtral references (Pocket clips)'});
  await pkg.tree(`${plugin}/${RUNTIME_PREPARED_FOLDER}`, voxtral.directory);
  log(`Voxtral references: ${voxtral.keys.length} voices, ${(voxtral.bytes / 1e6).toFixed(2)} MB in the Runtime package.`);

  // The llama.cpp engine of Local AI: the server, llama-fit-params and their libraries (docs/LOCAL_AI.md, "The engine is in the Runtime").
  log(`llama.cpp engine: ${await addRuntimeEngine(pkg, source, config, app, notices)} files in app/${config.localAi.server.runtimeFolder}/.`);
  // vgmstream-cli and its libraries: the decoder of a player's V voice mod (docs/PACKAGING.md, "vgmstream in the Runtime").
  log(`vgmstream ${tool.vgmstream.version}: ${await addRuntimeVgmstream(pkg, source, config, app, notices)} files in app/${tool.vgmstream.runtimeFolder}/.`);

  // Launcher scripts, application metadata and notices.
  for (const name of ['start-service.mjs', 'prepare-state.mjs', 'assemble-parts.mjs', 'migrate-legacy.mjs', 'place-packs.mjs', 'state-home.mjs', 'usvfs-compat.mjs', 'apply-removals.mjs']) pkg.file(`${app}/launcher/${name}`, resolve(source.root, 'packaging/runtime', name));
  pkg.json(`${app}/package.json`, {name: 'cyberpunk-convai', version: npmVersion(version), private: true, type: 'module'});
  // Files an earlier Runtime shipped that this one does not: the service deletes them at its next start (packaging/runtime/apply-removals.mjs).
  // The list is in every Runtime, the full one too; a Runtime update zip replaces it with what it finds by comparing two Runtimes
  // (packaging/build-runtime-update.mjs). Here it carries the paths declared in packaging/runtime-removals.json, which must be paths the
  // start step may delete and none that this same Runtime ships.
  const declared = (await readJson(resolve(source.root, DECLARED_REMOVALS))).removes ?? [];
  const checked = checkRemovals(declared, new Set(pkg.entries.keys()));
  if (checked.refused.length) throw Error(`${DECLARED_REMOVALS}: ${checked.refused.map(item => `${item.path} (${item.why})`).join('; ')}`);
  pkg.text(REMOVALS_ENTRY, removalListText(version, checked.ok));
  // The step marker of a full Runtime: the version the chain of update zips starts from (bridge/runtime-steps.mjs). Update zips add their own step
  // files beside it; the setup check names a step that was skipped.
  pkg.text(`${app}/${STEPS_DIR}/${BASE_FILE}`, baseText(version));

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
  notices.push('Local speech recognition (Mistral voice input): Moonshine Tiny, English, int8 ONNX (app/models/stt/moonshine-tiny-en-int8/), MIT, Copyright (c) 2025 Useful Sensors, Inc. (Moonshine AI);'
    + ' licence text in app/models/stt/moonshine-tiny-en-int8/LICENSE. Run by sherpa-onnx (k2-fsa), Apache-2.0, licence in its *.dist-info folder.');
  notices.push('Pocket voice and lip-sync weights: trained for this mod; free for personal use with the mod.');
  notices.push('Cyberpunk 2077, its audio and voice performances belong to CD PROJEKT RED and the performers; the reference voice clips (voices/) and game archives (archive/pc/mod/) are not licensed by the AI NPC Cyberpunk Mod Use License.');
  notices.push('AI NPC Cyberpunk Mod itself: AI NPC Cyberpunk Mod Use License, see LICENSE.txt in the plugin folder.');
  pkg.text(`${app}/licenses/THIRD-PARTY-NOTICES.txt`, ['AI NPC Cyberpunk Mod runtime - third-party components', '', ...notices.map(line => `- ${line}`), ''].join('\r\n'));
  pkg.text(`${app}/licenses/THIRD_PARTY_NOTICES.md`, await readFile(resolve(source.root, 'THIRD_PARTY_NOTICES.md'), 'utf8'));
  // The list of the Runtime's own code files and their hashes (bridge/runtime-integrity.mjs): the error reports say whether the
  // installed files still match it, so a Runtime that someone else edited is seen. Made last, from exactly the bytes this package ships; a Runtime update zip
  // carries the new list (it differs from the old one at every release), so the list always belongs to the newest Runtime applied.
  const integrity = await import(pathToFileURL(resolve(source.root, 'bridge/runtime-integrity.mjs')).href);
  const codeRows = [];
  for (const [name, entry] of pkg.entries) {
    const rel = name.startsWith(`${app}/`) ? name.slice(app.length + 1) : null;
    if (rel && integrity.isCodePath(rel)) codeRows.push({path: rel, hash: integrity.hashBytes(entry.buffer ?? await readFile(entry.source))});
  }
  if (!codeRows.length) throw Error('The Runtime has no code files to list (bridge/runtime-integrity.mjs).');
  pkg.text(`${app}/${integrity.CODE_LIST}`, integrity.codeListText({version, rows: codeRows}));
  pkg.json(`${app}/release.json`, {product: config.product, package: 'runtime', version, commit: source.commit,
    node: tool.node.version, python: tool.python.version,
    pocketTts: tool.pocketTts.revision, pocketModel: pocketConfig.model.sha256, convaiKey: 'none', convaiSignIn: auth ? 'backend' : 'none',
    nativePlugin: nativeDll ? await sha256File(nativeDll) : 'none'});
  return pkg;
}

// Pre-built Mistral voice references. Voxtral sends each character's reference clip with every request; the bridge makes it small
// (mono 24 kHz, cut to about 8.5 s, then Ogg Vorbis q2 with ffmpeg) and keeps the result in <voices>/prepared, one slot per voice key,
// named by the source clip's hash. A player without ffmpeg would otherwise send the 408 KB WAV instead of the 38 KB Ogg.
// This builds those slots with the bridge's own code (VoxtralVoice.build, the same call a conversation makes), from `configs`
// (registry configurations in the bridge's order of preference), and returns {directory, keys, bytes, skipped}.
// `except`: a Map of key -> signature already shipped by another package; a slot with the same signature is left out.
async function voxtralCache(source, models, directory, configs, {except = new Map(), label = 'Voxtral references'} = {}) {
  const bridge = name => import(pathToFileURL(resolve(source.root, 'bridge', name)).href);
  const {VoxtralVoice} = await bridge('voxtral-voice.mjs');
  const {createReferencePreparer, findFfmpeg} = await bridge('voxtral-reference.mjs');
  const {createVoiceProfileRegistry} = await bridge('voice-profile-registry.mjs');
  if (!await findFfmpeg()) throw Error(`${label}: ffmpeg is needed to pre-build the compressed references (put it on PATH or set CYBERPUNK_CONVAI_FFMPEG).`);
  await rm(directory, {recursive: true, force: true});
  await mkdir(directory, {recursive: true});
  const root = resolve(directory, '..', 'voxtral-root');
  const registries = configs.map(createVoiceProfileRegistry);
  const voice = new VoxtralVoice({getKey: () => null, referenceRoot: root, registry: registries,
    read: async path => {
      const file = models.referencePath(posix(relative(root, path)));
      if (!file || !existsSync(file)) throw Object.assign(Error('missing reference clip'), {code: 'ENOENT'});
      return readFile(file);
    },
    prepare: createReferencePreparer({cacheDirectory: directory, onLog: message => log(`${label}: ${message}`)})});
  const keys = [...new Set(registries.flatMap(registry => registry.keys))].sort();
  const skipped = [];
  for (const name of keys) {
    const made = await voice.build(name);
    if (!made) throw Error(`${label}: no reference could be prepared for ${name}.`);
    if (made.format === 'wav') throw Error(`${label}: ${name} was not compressed (is ffmpeg with libvorbis working?).`);
    if (!existsSync(join(directory, `${name}.json`))) throw Error(`${label}: ${name} was not cached (its key cannot name a cache slot).`);
  }
  let bytes = 0;
  const kept = [];
  for (const name of keys) {
    const metaPath = join(directory, `${name}.json`), meta = JSON.parse(await readFile(metaPath, 'utf8'));
    if (except.get(name) === meta.signature) { skipped.push(name); await rm(metaPath); await rm(join(directory, `${name}.${meta.format}`)); continue; }
    // The build time is not part of what a slot means; a fixed value keeps the package reproducible.
    meta.written = '2026-01-01T00:00:00.000Z';
    await writeFile(metaPath, JSON.stringify(meta));
    bytes += meta.bytes + (await stat(metaPath)).size;
    kept.push(name);
    except.set(name, meta.signature);
  }
  await rm(root, {recursive: true, force: true});
  return {directory, keys: kept, bytes, skipped};
}

// The OmniVoice lists, in the Runtime's app/defaults and the pack's app/omni/defaults alike.
const OMNI_LIST_NAMES = Object.freeze(['local-voices.autobest-short.json', 'local-voices.autobest-long.json']);
// One list as it ships: checked against the pinned OmniVoice model and without the picker's proposal. The Runtime and the pack get the same text.
async function omniListOf(path, name, model) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (value.revision !== model.revision) throw Error(`${name} names OmniVoice ${value.revision}, not the packaged ${model.revision}.`);
  const copy = structuredClone(value); delete copy.proposal;
  return copy;
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

// The manifest and the clips it lists, checked against their hashes (bridge/v-voice.mjs): Map of file name to local path, empty when
// there are none. Only what loads is packed, so a stale or mismatched clip never ships.
async function vVoiceReferenceFiles() {
  const directory = resolve(project, 'assets/v-voice');
  const {loadVVoiceReferences} = await import(pathToFileURL(resolve(project, 'bridge/v-voice.mjs')).href);
  const found = await loadVVoiceReferences([directory], {log: message => log(`V voice: ${message}`)});
  const files = new Map();
  if (!Object.keys(found.voices).length) return files;
  files.set('v-voice.json', resolve(directory, 'v-voice.json'));
  for (const voice of Object.values(found.voices)) files.set(basename(voice.reference), voice.reference);
  // The line list that lets the bridge recognise a player's V voice mod and read V's lines from it (bridge/v-voice-mods.mjs): it is committed, not generated.
  files.set('v-mod-lines.json', resolve(directory, 'v-mod-lines.json'));
  return files;
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
  // Without the tests folders of the Python packages and the DLL copies in torch/bin (packaging/lib/omni-pack-rules.mjs).
  await pkg.tree(`${omni}/python`, pythonDir, {skip: rel => PYTHON_SKIP(rel) || omniPythonSkip(rel)});
  for (const rel of tracked) {
    if (excluded(rel)) continue;
    if (studio.adapter.some(prefix => rel.startsWith(prefix + '/'))) pkg.file(`${omni}/voicestudio/${rel}`, resolve(studioDir, rel));
    if (studio.notices.includes(rel)) pkg.file(`${omni}/voicestudio/${rel}`, resolve(studioDir, rel));
  }
  pkg.text(`${omni}/voicestudio/SOURCE.txt`, `VoiceStudio ${studio.revision}\r\n${studio.repository}\r\n`
    + `Licence: ${studio.license} (see LICENSE). The complete corresponding source is available at the repository above at this revision.\r\n`);

  // The OmniVoice model at the pinned revision: every file unmodified except model.safetensors, which is rounded to float16 (the precision the worker
  // loads it in; packaging/convert-omni-fp16.py, release.config.json toolchain.omniModel.converted). The audio tokenizer stays float32: OmniVoice loads it as float32.
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
    if (rel === 'model.safetensors') path = await omniHalfPrecisionModel(path, model, modelDir, resolve(pythonDir, 'python.exe'), source);
    pkg.file(`${omni}/model/${rel}`, path);
  }
  pkg.text(`${omni}/LICENSE.txt`, await readFile(resolve(source.root, 'LICENSE'), 'utf8'));

  // OmniVoice voice configurations and their reference clips.
  const configs = config.models.groups.find(item => item.target === 'voice-configs/');
  // The clips the Runtime carries for the voices added after this pack was frozen stay in the Runtime (the Mistral voice reads them without the pack):
  // the pack never ships the same path (packaging/check-pack-overlap.mjs). A clip the pack would skip must be the very bytes the Runtime has.
  const runtimeClips = runtimeClipSet(await readJson(resolve(source.root, config.omniPack.runtimeClips)));
  let leftToRuntime = 0;
  const seen = new Set(), values = {};
  for (const name of OMNI_LIST_NAMES) {
    const value = values[name] = JSON.parse(await readFile(models.files.get(configs.bucket + name), 'utf8'));
    // The Runtime carries the same list in app/defaults (a newer one, once this pack is reused by a later version), which the launcher prefers
    // (packaging/runtime/prepare-state.mjs).
    pkg.json(`${omni}/defaults/${name}`, await omniListOf(models.files.get(configs.bucket + name), name, model));
    for (const [rel, path] of await referencesOf(value, models)) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      const held = runtimeClips.get(`${plugin}/voices/${rel}`.toLowerCase());
      if (held) {
        if ((await stat(path)).size !== held.size || await crcOfFile(path) !== held.crc) throw Error(`The Runtime carries voices/${rel} with other bytes than this build's clip.`);
        leftToRuntime++; continue;
      }
      pkg.file(`${plugin}/voices/${rel}`, path);
    }
  }
  if (leftToRuntime !== runtimeClips.size) throw Error(`The Runtime clip listing names ${runtimeClips.size} clips but the lists use ${leftToRuntime} of them.`);
  log(`OmniVoice reference clips: ${leftToRuntime} left to the Runtime package (they are in it already).`);
  // The Mistral voice clones from the OmniVoice clips (long first, then short, then Pocket's) when this pack is installed, and its
  // prepared reference is kept per voice by the clip's hash. The Runtime package carries the slots for the Pocket clips in its own folder
  // (voices/prepared-runtime); this pack's slots, for the clips whose hash differs, go in voices/prepared, and the bridge finds either by
  // signature. Slots the Runtime package already holds (same clip) are not repeated.
  const pocketConfig = JSON.parse(await readFile(models.files.get(configs.bucket + 'pocket-voices.autobest.json'), 'utf8'));
  const shipped = new Map();
  await voxtralCache(source, models, resolve(stage, 'voxtral-pocket'), [{version: 2, provider: 'hybrid', engine: 'omnivoice', voices: pocketConfig.voices}],
    {except: shipped, label: 'Voxtral references (Pocket clips, for comparison)'});
  const voxtral = await voxtralCache(source, models, resolve(stage, 'voxtral-prepared'),
    [values['local-voices.autobest-long.json'], values['local-voices.autobest-short.json']], {except: shipped, label: 'Voxtral references (OmniVoice clips)'});
  await pkg.tree(`${plugin}/voices/prepared`, voxtral.directory);
  log(`Voxtral references: ${voxtral.keys.length} voices, ${(voxtral.bytes / 1e6).toFixed(2)} MB in the OmniVoice pack (${voxtral.skipped.length} identical to the Runtime package's).`);
  pkg.text(`${omni}/THIRD-PARTY-NOTICES.txt`, omniNoticesText(omniNoticeLines({tool, studio})));
  pkg.json(`${omni}/omni-pack.json`, omniMarker({config, version, commit: source.commit}));
  return pkg;
}

// The pinned upstream model.safetensors as the pack ships it: rounded to float16 by packaging/convert-omni-fp16.py with the pack's own Python (torch and
// safetensors are in it), checked against the pinned result. Kept in the cache: an existing converted file is reused when its SHA-256 matches.
async function omniHalfPrecisionModel(upstream, model, modelDir, python, source) {
  const pin = model.converted['model.safetensors'];
  const target = resolve(modelDir, 'float16/model.safetensors');
  if (existsSync(target) && await sha256File(target) === pin.sha256) return target;
  await mkdir(dirname(target), {recursive: true});
  log('Rounding the OmniVoice model to float16 (packaging/convert-omni-fp16.py).');
  await run(python, [resolve(source.root, pin.script), upstream, target], {quiet: true});
  const actual = await sha256File(target);
  if (actual !== pin.sha256 || (await stat(target)).size !== pin.size) throw Error(`The float16 OmniVoice model is ${actual}, not the pinned ${pin.sha256} (release.config.json, toolchain.omniModel.converted).`);
  return target;
}

// A Local AI download (docs/LOCAL_AI.md): the llama-server build, the embedding model and one chat model, with a manifest
// fragment that bridge/local-ai-pack.mjs merges with the other pack's. Both packs ship identical server, embedding and notice
// files, so extracting the second over the first only overwrites identical bytes.
const globToRegExp = pattern => new RegExp('^' + pattern.split('*').map(part => part.replace(/[^A-Za-z0-9_-]/g, '\\$&')).join('.*') + '$', 'i');

// A pinned file of the Local AI packs: from the developer folder when building with --models local and the file is there
// (still checked against the recorded hash), else downloaded from the pinned URL.
async function localAiFile(spec, url, cacheName) {
  const developer = modelSource === 'local' && localAiSource && spec.local ? resolve(localAiSource, spec.local) : null;
  if (developer && existsSync(developer)) {
    if ((await stat(developer)).size !== spec.size || await sha256File(developer) !== spec.sha256) throw Error(`${developer} differs from the pinned ${cacheName}.`);
    return developer;
  }
  return download(url, resolve(cache, 'local-ai', cacheName), spec.sha256, log);
}

// The llama.cpp files that ship: the official Windows Vulkan release (unmodified), only the server, llama-fit-params and the libraries they load (localAi.server
// keep/drop/require in release.config.json). The Runtime carries them in app/llama-cpp/ (addRuntimeEngine); the packs carry a second copy in the Local AI folder's
// llama/ while localAi.server.inPacks is true (addEngine).
async function engineFiles(config) {
  const spec = config.localAi;
  const zip = await localAiFile(spec.server, spec.server.url, `llama-${spec.server.version}-vulkan-x64.zip`);
  const extracted = resolve(cache, 'extract', `llama-${spec.server.version}`);
  await extractZip(zip, extracted);
  const keep = spec.server.keep.map(globToRegExp), drop = new Set(spec.server.drop);
  const shipped = (await readdir(extracted)).filter(name => keep.some(pattern => pattern.test(name)) && !drop.has(name)).sort();
  for (const name of spec.server.require) if (!shipped.includes(name)) throw Error(`The llama.cpp ${spec.server.version} download has no ${name}.`);
  return {extracted, shipped};
}

// The engine in the Runtime (docs/LOCAL_AI.md, "The engine is in the Runtime"): the server, llama-fit-params and their libraries in app/llama-cpp/, where
// bridge/local-ai-pack.mjs looks first, so an engine fix reaches players through the Runtime update zip (which carries what changed). The licence text goes
// to app/licenses/ and the notice into the Runtime's THIRD-PARTY-NOTICES.
async function addRuntimeEngine(pkg, source, config, app, notices) {
  const spec = config.localAi, folder = spec.server.runtimeFolder;
  if (!folder || !/^[a-z0-9-]+$/.test(folder)) throw Error('localAi.server.runtimeFolder in release.config.json names the Runtime folder of the engine.');
  const {extracted, shipped} = await engineFiles(config);
  for (const name of shipped) pkg.file(`${app}/${folder}/${name}`, resolve(extracted, name));
  pkg.file(`${app}/licenses/llama.cpp-MIT.txt`, resolve(source.root, 'packaging/licenses/llama.cpp-MIT.txt'));
  notices.push(`llama.cpp ${spec.server.version} (llama-server and llama-fit-params, Vulkan build for Windows x64, the unmodified official release without its other command line tools; the engine of Local AI) - ${spec.server.license},`
    + ` Copyright (c) 2023-2026 The ggml authors: app/licenses/llama.cpp-MIT.txt; the LLVM OpenMP runtime it includes (libomp.dll) has its licence in app/${folder}/LICENSE-LLVM-OpenMP`
    + ` - https://github.com/ggml-org/llama.cpp/tree/${spec.server.version}`);
  return shipped.length;
}

// vgmstream-cli.exe and the ten libraries it loads, in app/vgmstream/ (docs/PACKAGING.md, "vgmstream in the Runtime"). The bridge decodes the Wwise voice-over of a
// player's V voice mod with it. The unmodified files of the official release are read from <checkout>/vendor/vgmstream/ (git-ignored, never downloaded) and each is checked
// against the size and SHA-256 pinned in release.config.json (toolchain.vgmstream); a missing or different file stops the build. The licence texts are committed in
// packaging/licenses/vgmstream/ and go to app/licenses/vgmstream/, and the notice joins the Runtime's THIRD-PARTY-NOTICES.
async function addRuntimeVgmstream(pkg, source, config, app, notices) {
  const spec = config.toolchain.vgmstream, folder = spec.runtimeFolder;
  if (!folder || !/^[a-z0-9-]+$/.test(folder)) throw Error('toolchain.vgmstream.runtimeFolder in release.config.json names the Runtime folder of vgmstream.');
  const vendor = resolve(project, spec.vendorFolder); // the working checkout, not the exported commit: vendor/ is not in git, like assets/v-voice/*.wav
  const names = Object.keys(spec.files);
  if (!names.includes(spec.executable)) throw Error(`toolchain.vgmstream.files does not list ${spec.executable}.`);
  for (const name of names) {
    const path = resolve(vendor, name), pinned = spec.files[name];
    if (!existsSync(path)) throw Error(`${spec.vendorFolder}/${name} is missing: copy the ${names.length} files of the official vgmstream ${spec.version} Windows release (listed in toolchain.vgmstream.files) into ${spec.vendorFolder}/.`);
    if ((await stat(path)).size !== pinned.size || await sha256File(path) !== pinned.sha256) throw Error(`${spec.vendorFolder}/${name} differs from the pinned file (${pinned.size} bytes, SHA-256 ${pinned.sha256}).`);
    pkg.file(`${app}/${folder}/${name}`, path);
  }
  for (const [name, licence] of Object.entries(spec.licences)) {
    const path = resolve(source.root, licence.path);
    if (licence.sha256 && sha256Buffer((await readFile(path, 'utf8')).replaceAll('\r\n', '\n')) !== licence.sha256) throw Error(`${licence.path} differs from the pinned licence text.`);
    pkg.file(`${app}/${spec.licenceFolder}/${name}`, path);
  }
  notices.push(`vgmstream ${spec.version} (vgmstream-cli.exe with its libraries, the unmodified official Windows release; decodes the voice-over of a player's V voice mod on the player's PC) - ${spec.license}, `
    + `Copyright (c) 2008-2025 Adam Gashlin, Fastelbja, Ronny Elfert, bnnm, Christopher Snowhill, NicknineTheEagle, bxaimc, Thealexbarney, CyberBotX, et al: app/${spec.licenceFolder}/COPYING,`
    + ` source ${spec.source}`);
  notices.push(`vgmstream's libraries (app/${folder}/, unmodified vgmstream release DLLs, dynamically linked and replaceable): FFmpeg n5.1.2 (avcodec, avformat, avutil; LGPL-2.1-or-later) and mpg123 (libmpg123; LGPL-2.1-or-later), `
    + 'with the Opus library linked into the FFmpeg build (BSD-3-Clause); libvorbis 1.3.7 (BSD-3-Clause); Speex and CELT (libspeex, libcelt; BSD-3-Clause); LibAtrac9 (MIT); libg719_decode (the vgmstream release gives no licence text for it).'
    + ` Licences and the source location of each: app/${spec.licenceFolder}/NOTICE-bundled-libraries.txt; the sources and build scripts are in ${spec.source}`);
  return names.length;
}

// What every Local AI pack and every Mature pack ships, byte for byte the same files at the same paths, so installing one pack over another
// only overwrites identical bytes: the embedding model, the licence texts (licenses/Apache-2.0.txt, licenses/llama.cpp-MIT.txt) with the mod's own LICENSE.txt, and,
// while localAi.server.inPacks is true (0.2.7: a pack bought with an older Runtime still runs), a copy of the engine in llama/. With inPacks false the packs carry
// models only and the manifests name no `server`: the Runtime's engine is used (bridge/local-ai-pack.mjs).
// Returns the manifest `server` (null without the engine) and `embed` entries both kinds of marker carry.
async function addEngine(pkg, source, config) {
  const spec = config.localAi, root = config.layout.localAiDirectory;
  const huggingFace = item => `https://huggingface.co/${item.repository}/resolve/${item.revision}/${item.file}`;
  const inPacks = spec.server.inPacks !== false;
  if (inPacks) {
    const {extracted, shipped} = await engineFiles(config);
    for (const name of shipped) pkg.file(`${root}/llama/${name}`, resolve(extracted, name));
  }
  pkg.file(`${root}/models/${spec.embed.file}`, await localAiFile(spec.embed, huggingFace(spec.embed), spec.embed.file));
  const licences = resolve(source.root, 'packaging/licenses');
  pkg.file(`${root}/licenses/Apache-2.0.txt`, resolve(licences, 'Apache-2.0.txt'));
  if (inPacks) pkg.file(`${root}/licenses/llama.cpp-MIT.txt`, resolve(licences, 'llama.cpp-MIT.txt'));
  pkg.text(`${root}/LICENSE.txt`, await readFile(resolve(source.root, 'LICENSE'), 'utf8'));
  return {server: inPacks ? 'llama/llama-server.exe' : null,
    embed: {file: `models/${spec.embed.file}`, dim: spec.embed.dim, id: spec.embed.file.replace(/\.gguf$/i, '').toLowerCase()}};
}

// The notice lines for the engine (llama.cpp with its bundled OpenMP runtime, the Granite embedding model); the same text in every pack that has the engine.
function engineNotices(spec, bothPacks) {
  return [
    spec.server.inPacks === false
      ? `llama.cpp ${spec.server.version} (llama-server, the engine of Local AI) - ${spec.server.license}, Copyright (c) 2023-2026 The ggml authors: it is part of the Runtime package (app/${spec.server.runtimeFolder}/, licence in app/licenses/llama.cpp-MIT.txt),`
        + ' not of this pack - https://github.com/ggml-org/llama.cpp/tree/' + spec.server.version
      : `llama.cpp ${spec.server.version} (llama-server, Vulkan build for Windows x64, the unmodified official release without its other command line tools) - ${spec.server.license}, Copyright (c) 2023-2026 The ggml authors: licenses/llama.cpp-MIT.txt;`
        + ' the LLVM OpenMP runtime it includes (libomp.dll) has its licence in llama/LICENSE-LLVM-OpenMP - https://github.com/ggml-org/llama.cpp/tree/' + spec.server.version,
    `${spec.embed.name} (embedding model for memory search; ${bothPacks}) - IBM Granite, ${spec.embed.license}: licenses/Apache-2.0.txt`
      + ` - https://huggingface.co/ibm-granite/granite-embedding-107m-multilingual and the GGUF at https://huggingface.co/${spec.embed.repository}`,
  ];
}

async function localAiPackage(source, config, tierKey) {
  const spec = config.localAi, tier = spec.tiers[tierKey];
  const pkg = new Package(`localai-${tierKey}`);
  const root = config.layout.localAiDirectory;
  const huggingFace = item => `https://huggingface.co/${item.repository}/resolve/${item.revision}/${item.file}`;

  // llama-server, the embedding model and the licence texts (shared with the Mature packs), then this pack's chat model, whole: the pack is one zip on
  // Hugging Face (ZIP64 when the model is over 4 GiB).
  const engine = await addEngine(pkg, source, config);
  const chatPath = await localAiFile(tier, huggingFace(tier), tier.file);
  pkg.file(`${root}/models/${tier.file}`, chatPath);

  pkg.json(`${root}/manifest.${tierKey}.json`, {version: 1, ...(engine.server ? {server: engine.server} : {}), [tierKey]: {file: `models/${tier.file}`, name: tier.name}, embed: engine.embed});

  // Notices. The same bytes in both Local AI packs.
  const standard = spec.tiers.standard, lite = spec.tiers.lite;
  const [llamaNotice, embedNotice] = engineNotices(spec, 'both packs');
  const notices = [
    llamaNotice,
    `${standard.name} (instruction-tuned, QAT q4_0 GGUF; Local AI standard only) - Google, ${standard.license}: licenses/Apache-2.0.txt - https://huggingface.co/${standard.repository}`
      + ' - Google also publishes a prohibited use policy for Gemma: https://ai.google.dev/gemma/prohibited_use_policy',
    `${lite.name} (ternary Q2_0 GGUF, a Qwen3.5-based model; Local AI lite only) - ${lite.publisher}, ${lite.license}: licenses/Apache-2.0.txt;`
      + ' it derives from Qwen3.5 (Alibaba Cloud, Apache-2.0)'
      + ` - https://huggingface.co/${lite.repository}`,
    embedNotice,
    ...(spec.server.inPacks === false ? ['This pack carries models only and needs the Runtime of version 0.2.7 or newer: the llama.cpp engine that runs the models is part of the Runtime, not of this pack.'] : []),
    'The model files are the unmodified converted files of the publishers named above.',
    'AI NPC Cyberpunk Mod itself: AI NPC Cyberpunk Mod Use License, see LICENSE.txt in this folder.',
  ];
  pkg.text(`${root}/THIRD-PARTY-NOTICES.txt`, ['AI NPC Cyberpunk Mod Local AI packs - third-party components', '', ...notices.map(line => `- ${line}`), ''].join('\r\n'));
  pkg.json(`${root}/local-ai-${tierKey}.json`, {product: config.product, package: `localai-${tierKey}`, version, commit: '' + source.commit,
    llamaCpp: spec.server.version, model: `${tier.repository}@${tier.revision}`, modelFile: tier.file, modelSha256: tier.sha256,
    embedModel: `${spec.embed.repository}@${spec.embed.revision}`});
  return pkg;
}

// A Mature pack (docs/LOCAL_AI.md, "Mature content"): a separate download, hosted on Hugging Face with the other optional packs (built by the release
// workflow's opt-in `mature` job from the private bucket's mirror, or by hand; never on a tag push, never to Nexus). There are two, Mature lite and
// Mature standard, one model each, and each works alone: a pack carries its own uncensored model file in the Local AI folder's models/ and its own marker
// (manifest.mature-lite.json or manifest.mature-standard.json, read by bridge/mature-pack.mjs; the Local AI detector never reads them), plus the
// shared README and licence files and its own notices under mature/. Nothing of them is in the Runtime package.
// With --models hf, the model comes from the private bucket's mirror (packaging/fetch-models.py --mature --tier: same token, same
// download helper, SHA-256 checked against the pin), only the tier being built. It returns the cached local path of the model when the mirror has
// it, keyed by file name; a model it lacks is downloaded from its pinned public Hugging Face URL by localAiFile.
async function matureMirror(source, tierKey) {
  const report = resolve(out, `mature-mirror-${tierKey}.json`);
  log(`Fetching the Mature ${tierKey} model from the private Hugging Face bucket mirror.`);
  await run(hostPython, [resolve(source.root, 'packaging/fetch-models.py'), '--config', resolve(source.root, 'packaging/release.config.json'),
    '--cache', resolve(cache, 'models'), '--report', report, '--mature', '--tier', tierKey]);
  return new Map(Object.entries((await readJson(report)).files));
}

async function maturePackage(source, config, tierKey) {
  const spec = config.maturePack;
  // Exactly two models exist, lite and good (bridge/mature-pack.mjs, MATURE_TIERS); each pack carries one.
  if (Object.keys(spec.tiers ?? {}).join() !== 'lite,good') throw Error('The Mature packs are lite and good, one model each (maturePack.tiers).');
  const model = {key: tierKey, ...spec.tiers[tierKey]};
  if (!model.file || model.placeholder || /PLACEHOLDER/.test(`${model.file}${model.sha256}${model.revision}`)) {
    throw Error(`The Mature ${tierKey} model is missing or a placeholder in packaging/release.config.json, maturePack.tiers.`);
  }
  if (model.license !== 'Apache-2.0') throw Error(`${model.name}: the Mature packs ship Apache-2.0 base models only.`);
  // The pack and its files are named lite and standard (like the Local AI packs); the model's tier key stays `good` (ids mature:good).
  const packKey = tierKey === 'good' ? 'standard' : tierKey;
  const pkg = new Package(`mature-${packKey}`);
  const root = config.layout.localAiDirectory;
  const huggingFace = item => `https://huggingface.co/${item.repository}/resolve/${item.revision}/${item.remote ?? item.file}`;
  // The engine (llama-server, the embedding model, the licence texts) is the same files as in the Local AI packs, so the pack works alone and
  // either pack installed over the other only overwrites identical bytes. Then this pack's uncensored model.
  const engine = await addEngine(pkg, source, config);
  const mirrored = modelSource === 'hf' ? await matureMirror(source, tierKey) : new Map();
  pkg.file(`${root}/models/${model.file}`, mirrored.get(model.file) ?? await localAiFile(model, huggingFace(model), model.file));
  // This pack's own marker, so the other pack's marker is never overwritten and either one alone is detected. It names the server and the
  // embedding model too (bridge/local-ai-pack.mjs reads those two fields), so a Mature-only install counts as installed.
  pkg.json(`${root}/${spec.markers[tierKey]}`, {version: 1, pack: 'mature', ...(engine.server ? {server: engine.server} : {}), [tierKey]: {file: `models/${model.file}`, name: model.name, family: model.family}, embed: engine.embed});
  pkg.text(`${root}/${spec.directory}/README.md`, await readFile(resolve(source.root, spec.readme), 'utf8'));
  for (const licence of spec.licenceFiles) pkg.file(`${root}/${spec.directory}/licenses/${basename(licence)}`, resolve(source.root, licence));
  const [llamaNotice, embedNotice] = engineNotices(config.localAi, 'every Local AI pack and Mature pack');
  pkg.text(`${root}/${spec.directory}/THIRD-PARTY-NOTICES-${packKey}.txt`, [`AI NPC Cyberpunk Mod Mature ${packKey} pack - third-party components`, '',
    `- ${model.name} (${model.key}; GGUF file ${model.file}; base model ${model.baseModel}) - ${model.license}: ${spec.directory}/licenses/Apache-2.0.txt - https://huggingface.co/${model.repository}`,
    `- The model is a community fine-tune of the Apache-2.0 base model named above.${tierKey === 'good' ? ' Google also publishes a prohibited use policy for Gemma: https://ai.google.dev/gemma/prohibited_use_policy' : ''}`,
    `- ${llamaNotice}`, `- ${embedNotice}`,
    config.localAi.server.inPacks === false
      ? '- The pack includes the embedding model and uses the llama-server engine that is part of the Runtime, so it needs the Runtime of version 0.2.7 or newer. The same embedding model is in the Local AI packs; installing one pack over another only overwrites identical files.'
      : '- The pack includes the llama-server build and the embedding model, so it works without a Local AI pack. The same files are in the Local AI packs; installing one pack over another only overwrites identical files.',
    '- The licence paths above (licenses/...) are in the Local AI folder, one level up from this folder; the Apache-2.0 text is also in mature/licenses/.',
    '- AI NPC Cyberpunk Mod itself: AI NPC Cyberpunk Mod Use License, see ../LICENSE.txt.', ''].join('\r\n'));
  pkg.json(`${root}/${spec.directory}/mature-pack-${packKey}.json`, {product: config.product, package: `mature-${packKey}`, version, commit: '' + source.commit,
    models: [{tier: model.key, repository: model.repository, revision: model.revision, file: model.remote ?? model.file, sha256: model.sha256}]});
  return pkg;
}

// ---------------------------------------------------------------- the voice-input packs (docs/LOCAL_STT.md, "The optional packs")
// Two optional downloads, MicPack-European (NVIDIA Parakeet TDT 0.6B v3, int8) and MicPack-Asian (SenseVoice Small, int8: Mandarin Chinese, Japanese, Korean),
// each ONE zip on Hugging Face like the other optional packs (built only on request, never in the default set, never Nexus). A pack holds the model files
// of one entry of bridge/speech-language.mjs LOCAL_PACKS in app/models/stt/<id>/, where bridge/local-stt.mjs resolveLocalSttPaths looks for it, beside the
// Runtime's own app/models/stt/moonshine-tiny-en-int8/ (a path the packs never use), plus mic-pack.json (the marker packaging/runtime/place-packs.mjs
// recognises), NOTICE.txt (the model's licence and attribution) and LICENSE-mod.txt (the mod's own licence, one copy per pack folder, so the two packs share no path).
// The model files are the unmodified files of the sherpa-onnx release archive pinned in release.config.json (micPacks), checked against their recorded size
// and SHA-256. A licence that is only LINKED (the FunASR Model Open Source License of SenseVoice) is linked in NOTICE.txt and is not copied into the pack:
// the link is the licence, and the notice says so; the build refuses a notice that does not carry the pinned licence link.
const micSource = value('--mic-pack-source', process.env.CYBERPUNK_CONVAI_MIC_PACKS_DEV);
const MIC_TAR = process.platform === 'win32' ? resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

// A file of a voice-input pack, checked against its pinned size and SHA-256 (a link or a missing file is refused).
async function verifiedMicFile(path, name, spec, where) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) throw Error(`${where}: ${name} is missing or is not a plain file.`);
  if (info.size !== spec.size || await sha256File(path) !== spec.sha256) throw Error(`${where}: ${name} differs from the pinned file (${spec.size} bytes, SHA-256 ${spec.sha256}).`);
  return path;
}

// Map of file name -> local path for one pack: from the developer folder (DIR/<local>/<file>) when --mic-pack-source or CYBERPUNK_CONVAI_MIC_PACKS_DEV
// is set, else from the pinned archive. The archive is untrusted data: it is listed first and an entry outside its own folder (an absolute path, a
// drive, a backslash or a .. part) stops the build, only the files the pack ships are extracted (into a fresh folder of the cache, with the system tar),
// each is checked against its pin, and nothing in it is ever run.
async function micPackFiles(pack) {
  const files = new Map();
  if (micSource) {
    const folder = resolve(micSource, pack.local ?? pack.id);
    for (const [name, spec] of Object.entries(pack.files)) files.set(name, await verifiedMicFile(resolve(folder, name), name, spec, folder));
    return files;
  }
  const {url, size, sha256, folder} = pack.archive;
  const archive = await download(url, resolve(cache, 'mic-packs', basename(new URL(url).pathname)), sha256, log);
  if ((await stat(archive)).size !== size) throw Error(`${basename(archive)} is not ${size} bytes.`);
  const listed = spawnSync(MIC_TAR, ['-tjf', archive], {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
  if (listed.status !== 0) throw Error(`Could not list ${basename(archive)}: ${String(listed.stderr).slice(-400)}`);
  const entries = listed.stdout.split(/\r?\n/).filter(Boolean).map(entry => entry.replace(/\/$/, ''));
  for (const entry of entries) {
    if (/^[\\/]|^[A-Za-z]:|\\|(?:^|\/)\.\.(?:\/|$)/.test(entry) || !(entry === folder || entry.startsWith(`${folder}/`))) {
      throw Error(`${basename(archive)} holds an entry outside ${folder}/: ${entry}`);
    }
  }
  const members = Object.keys(pack.files).map(name => `${folder}/${name}`);
  for (const member of members) if (!entries.includes(member)) throw Error(`${basename(archive)} has no ${member}.`);
  const extracted = resolve(cache, 'extract', `mic-pack-${pack.id}`);
  await rm(extracted, {recursive: true, force: true});
  await mkdir(extracted, {recursive: true});
  log(`Extracting ${members.length} files of ${basename(archive)}.`);
  await run(MIC_TAR, ['-xjf', archive, '-C', extracted, ...members], {quiet: true});
  for (const [name, spec] of Object.entries(pack.files)) {
    const path = resolve(extracted, folder, name);
    if (!inside(extracted, path)) throw Error(`${name} left the extraction folder.`);
    files.set(name, await verifiedMicFile(path, name, spec, extracted));
  }
  return files;
}

async function micPackage(source, config, packKey) {
  const spec = config.micPacks, pack = spec.packs?.[packKey];
  if (!pack) throw Error(`Unknown voice-input pack ${packKey} (micPacks.packs in packaging/release.config.json).`);
  if (spec.directory !== 'app/models/stt' || !/^[a-z0-9][a-z0-9.-]*$/.test(pack.id)) throw Error(`${pack.packageId}: the pack id or folder is not one bridge/local-stt.mjs looks for.`);
  const pkg = new Package(pack.packageId);
  const folder = `${config.layout.pluginDirectory}/${spec.directory}/${pack.id}`;
  for (const [name, path] of await micPackFiles(pack)) pkg.file(`${folder}/${name}`, path);
  const notice = (await readFile(resolve(source.root, pack.noticeSource), 'utf8')).replace(/\r?\n/g, '\r\n');
  if (!notice.includes(pack.licenseUrl)) throw Error(`${pack.noticeSource} does not carry the licence link ${pack.licenseUrl}.`);
  pkg.text(`${folder}/${spec.noticeFile}`, notice);
  pkg.text(`${folder}/${spec.modLicenceFile}`, await readFile(resolve(source.root, 'LICENSE'), 'utf8'));
  pkg.json(`${folder}/${spec.markerFile}`, {product: config.product, package: pack.packageId, version, commit: '' + source.commit, pack: pack.id,
    languages: pack.languages, model: pack.model, source: pack.archive.url, archiveSha256: pack.archive.sha256, license: pack.license,
    licenseUrl: pack.licenseUrl, attribution: pack.attribution});
  return pkg;
}

// ---------------------------------------------------------------- archives
// No file is split any more. The optional packs are hosted on Hugging Face as ONE zip each (no limit there to stay under), and the
// Scripts and Runtime packages carry no file near the GitHub per-file limit: one that is over it would break the upload, so it stops the build.
// (Older installs may still have `.partN` files from earlier releases; packaging/runtime/assemble-parts.mjs joins those at start-up.)
async function checkFileSizes(pkg, config) {
  for (const [name, entry] of pkg.entries) {
    const size = await sizeOf(entry);
    if (size > config.limits.githubFileBytes) throw Error(`${name} is ${(size / 1e9).toFixed(2)} GB, over the GitHub per-file limit; only the optional packs (hosted on Hugging Face) may hold files that large.`);
  }
}

// `single`: one zip whatever its size (the optional packs: ZIP64 where needed, no `-partNofM` zips). Otherwise an archive that would pass the
// GitHub asset limit (or 60,000 entries) is closed and the next entry starts another one.
async function writeArchives(pkg, baseName, config, timestamp, {single = false} = {}) {
  const directory = resolve(out, 'packages');
  await mkdir(directory, {recursive: true});
  const names = [...pkg.entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const limitPath = config.layout.maxPathLength - config.layout.maxGameRootLength - 1;
  const tooLong = names.filter(name => name.length > limitPath);
  if (tooLong.length) throw Error(`${tooLong.length} paths are too long for a typical game folder, e.g. ${tooLong[0]}`);
  const archives = [];
  let writer = null, index = 0;
  const open = async () => { index++; writer = await ZipWriter.create(resolve(directory, `${baseName}.${index}.tmp`), {timestamp}); };
  const files = [];
  await open();
  for (const name of names) {
    const entry = pkg.entries.get(name), size = await sizeOf(entry);
    const bound = Math.ceil(size * 1.001) + 1024 + 2 * name.length + 128;
    if (!single && writer.count && (writer.size + bound > config.limits.assetBytes || writer.count >= 60000)) {
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
  const auth = loadAuth(); // before anything is written: a build that must not start stops here
  await mkdir(out, {recursive: true});
  for (const name of ['packages', 'stage', 'native']) await rm(resolve(out, name), {recursive: true, force: true});
  log(`Building ${[...packages].join(', ')} ${version}${dryRun ? ' (dry run)' : ''}; models from ${modelSource}; no Convai key shipped, sign-in backend ${auth ? new URL(auth.url).host : 'not set'}.`);
  const source = await prepareSource();
  log(`Source: ${source.commit}`);
  const config = await readJson(value('--release-config') ? resolve(value('--release-config')) : resolve(source.root, 'packaging/release.config.json'));
  const timestamp = new Date(source.time * 1000);
  const models = (packages.has('runtime') || packages.has('omni')) ? await resolveModels(config, source) : null;
  const report = {product: config.product, version, commit: source.commit, dryRun, models: modelSource,
    built: new Date().toISOString(), packages: {}};

  const builders = {
    scripts: async () => { const {pkg, devOnlyExcluded} = await scriptsPackage(source, config); report.devOnlyLuaExcluded = devOnlyExcluded; return pkg; },
    runtime: () => runtimePackage(source, config, models, auth),
    omni: () => omniPackage(source, config, models),
    'localai-standard': () => localAiPackage(source, config, 'standard'),
    'localai-lite': () => localAiPackage(source, config, 'lite'),
    'mature-lite': () => maturePackage(source, config, 'lite'),
    'mature-standard': () => maturePackage(source, config, 'good'),
    'micpack-european': () => micPackage(source, config, 'european'),
    'micpack-asian': () => micPackage(source, config, 'asian'),
  };
  const titles = {scripts: 'Scripts', runtime: 'Runtime', omni: 'OmniPack', 'localai-standard': 'LocalAI-Standard', 'localai-lite': 'LocalAI-Lite', 'mature-lite': 'Mature-Lite', 'mature-standard': 'Mature-Standard',
    'micpack-european': 'MicPack-European', 'micpack-asian': 'MicPack-Asian'};
  for (const id of PACKAGE_IDS) {
    if (!packages.has(id)) continue;
    log(`Staging the ${titles[id]} package.`);
    const pkg = await builders[id]();
    pkg.text(INSTALL_NOTE_NAME, INSTALL_NOTE);
    if (!OPTIONAL_PACKAGE_IDS.has(id)) await checkFileSizes(pkg, config);
    log(`Writing ${titles[id]} (${pkg.entries.size} files).`);
    // The Scripts keep the long name (the file the owner uploads to Nexus Mods); the others have no product prefix.
    const archiveBase = id === 'scripts' ? `${config.product}-Scripts-${version}` : `${titles[id]}-${version}`;
    const result = await writeArchives(pkg, archiveBase, config, timestamp, {single: OPTIONAL_PACKAGE_IDS.has(id)});
    report.packages[id] = {archives: result.archives, fileCount: result.files.length,
      uncompressedBytes: result.files.reduce((sum, file) => sum + file.bytes, 0)};
    await writeFile(resolve(out, 'packages', `${archiveBase}.files.json`), JSON.stringify(result.files, null, 1) + '\n');
    for (const archive of result.archives) log(`  ${archive.file}: ${(archive.bytes / 1024 ** 2).toFixed(1)} MiB, ${archive.entries} entries`);
  }
  await writeFile(resolve(out, 'packages', 'release-manifest.json'), JSON.stringify(report, null, 2) + '\n');
  // Final guard: no archive may carry an obvious credential file or development state.
  for (const item of Object.values(report.packages).flatMap(entry => entry.archives)) {
    for (const entry of await listZip(resolve(out, 'packages', item.file))) {
      if (/^misc\//.test(entry.name)) throw Error(`${item.file} contains developer-only material: ${entry.name}`);
      // Only the shipped launcher and the native plugin may install a RED4ext plugin. The development launcher
      // (red4ext/plugins/CyberpunkConvaiLauncher) must never ship: with it, two services start.
      if (/^red4ext\//i.test(entry.name) && /\.(?:dll|ini)$/i.test(entry.name)
          && !entry.name.startsWith(`${config.layout.pluginDirectory}/`) && !entry.name.startsWith(`${config.layout.nativeDirectory}/`)) {
        throw Error(`${item.file} installs an unexpected RED4ext plugin file: ${entry.name}`);
      }
      if (/(?:^|\/)CyberpunkConvaiLauncher[^/]*$/i.test(entry.name)) throw Error(`${item.file} contains the development launcher: ${entry.name}`);
      if (SHIPPED_KEY_FILE.test(entry.name)) throw Error(`${item.file} would ship a Convai key file: ${entry.name}`);
      if (/(?:^|\/)(?:convai-key\.txt|kaggle-access-token\.txt|huggingface-[^/]*\.txt|\.env|(?:player|vendor)-memory[^/]*\.(?:json|bak|tmp|corrupt)|phone-sessions\.json|characters-verified\.json)$/i.test(entry.name)) {
        throw Error(`${item.file} contains a forbidden file: ${entry.name}`);
      }
    }
  }
  if (!useWorktree) await rm(source.root, {recursive: true, force: true});
  log(`Done: ${resolve(out, 'packages')}`);
}

main().catch(error => { console.error(`Release build failed: ${error?.stack || error}`); process.exit(1); });
