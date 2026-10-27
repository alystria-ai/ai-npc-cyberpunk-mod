// Clean-install test for built release packages. It never touches a real game folder.
//
//   node packaging/test-release-install.mjs --packages dist/release/packages --version 0.2
//        [--host dist/release/native/test-host.exe] [--key-file runtime/convai-key.txt] [--omni] [--local-ai] [--keep]
//
// 1. Makes a stand-in game folder under %TEMP% whose path has spaces and non-ASCII characters
//    (bin/x64/Cyberpunk2077.exe is the launcher test host, plus empty CET and RED4ext markers).
// 2. Extracts the Scripts and Runtime zips (and the OmniVoice pack, one zip, with --omni) with
//    PowerShell's Expand-Archive, as a player would, and checks every file against the build's
//    file list (paths, sizes, SHA-256).
// 3. Runs the remaining checks with a PATH that holds only Windows system folders, so no
//    installed Node or Python can be used:
//    - the packaged Node loads the Pocket voice from the packaged Python, speaks a sentence and
//      the lip-sync model turns that audio into mouth frames (and, with --omni, OmniVoice speaks
//      on the GPU from the pack's Python);
//    - the real launcher DLL, loaded by the test host like RED4ext does, starts the packaged
//      service, which must report Ready (a Runtime built with the token backend's address and secret has no key and signs in through the backend; with
//      --key-file, used as the player's own key and never printed) or ask for setup (a dry-run build without either); closing the host must stop it again.
// 4. Plugin folders: only the launcher and the native plugin install into red4ext/plugins (never the development
//    launcher); the native DLL is inspected without running it (convai_plugin_host) and runtime/native-off.txt (the kill switch, always shipped) lists the
//    systems that start off.
// 5. With --update-from (the Runtime update zip test): instead of the new full Runtime, the PREVIOUS full Runtime and Scripts are extracted
//    first (--update-from <previous Runtime zip>, repeated for a Runtime in several zips; --update-from-scripts <previous Scripts zip>), then
//    the Runtime update zip (--update-zip, default Runtime-Update-<from>-to-<version>.zip in --packages) and the new
//    Scripts, as a player updates. The start step then runs (start-service --prepare-only): the files the update names in its removal list
//    must go, and afterwards every file must match the NEW full Runtime's file list (paths, sizes, SHA-256; the new Runtime's own
//    .files.json is read, its zip is not needed) with nothing of the previous Runtime left over that the new one does not ship, except
//    what the removal step may never delete (listed in the output). The remaining checks run on that installation, so they also prove it works.
// 6. With --local-ai: both Local AI packs are extracted too (one zip each, the chat models whole: nothing is joined), the
//    packaged bridge detects the pack, and the packaged llama-server loads the chat models and the embedding
//    model on the processor (no sound, no graphics card, no game).
import {spawn, spawnSync} from 'node:child_process';
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {childEnv, sha256File, walk} from './lib/files.mjs';
import {listZip} from './lib/zip.mjs';
import {readEntry} from './lib/zip-entry.mjs';

// The names the build gives its packages (build-release.mjs): the Scripts keep the long name (the file for Nexus Mods), the others have no product prefix.
// --game 2.31 tests the build for that game (default 2.5): its Scripts and Runtime (and the update zip) carry the variant's suffix (packaging/game-variants.json).
const gameArgument = process.argv.slice(2).indexOf('--game');
const gameId = gameArgument >= 0 && process.argv.slice(2)[gameArgument + 1] ? process.argv.slice(2)[gameArgument + 1] : DEFAULT_GAME;
if (!Object.hasOwn(GAME_VARIANTS, gameId)) throw Error(`--game must be one of ${Object.keys(GAME_VARIANTS).join(', ')}, not ${gameId}`);
const gameSuffix = GAME_VARIANTS[gameId].suffix;
const packageBase = (id, version) => id === 'Scripts' ? `AI-NPC-Cyberpunk-Mod-Scripts-${version}${gameSuffix}` : id === 'Runtime' ? `Runtime-${version}${gameSuffix}` : `${id}-${version}`;
import {PLUGIN as PLUGIN_FOLDER, refusalFor} from './runtime/apply-removals.mjs';
import {REMOVALS_ENTRY} from './lib/runtime-removals.mjs';
import {DEFAULT_GAME, GAME_VARIANTS, LEGACY_GAME} from './lib/game-variants.mjs';
import {STEPS_DIR, checkRuntimeSteps} from '../bridge/runtime-steps.mjs';
import {missingRuntimeFiles, requiredRuntimeFiles, V_VOICE_FOLDER} from './lib/runtime-required.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const argv = process.argv.slice(2);
const value = (name, fallback) => { const at = argv.indexOf(name); return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback; };
const packagesDir = resolve(value('--packages', resolve(project, 'dist/release/packages')));
const version = value('--version');
const host = resolve(value('--host', resolve(packagesDir, '../native/test-host.exe')));
const keyFile = value('--key-file');
const omni = argv.includes('--omni');
const localAi = argv.includes('--local-ai');
const pluginHost = resolve(value('--plugin-host', resolve(packagesDir, '../native/convai_plugin_host.exe')));
const keep = argv.includes('--keep');
const values = name => argv.flatMap((item, index) => (item === name && argv[index + 1] ? [resolve(argv[index + 1])] : []));
const updateFrom = values('--update-from');
const updateFromScripts = values('--update-from-scripts');
const updateZipArgument = values('--update-zip')[0];
// A manual script that needs built packages: `node --test packaging/` picks the file up like a test, so under the test runner (NODE_TEST_CONTEXT) a run without --version is a skip, not a failure.
if (!version && process.env.NODE_TEST_CONTEXT) { console.log('skipped: a manual script (needs built packages and --version)'); process.exit(0); }
if (!version) { console.error('--version is required'); process.exit(2); }

const results = [];
const check = (name, ok, detail = '') => { results.push({name, ok, detail}); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
// Only Windows' own folders: no Node, Python, Git or developer tools.
const cleanPath = [join(systemRoot, 'System32'), systemRoot, join(systemRoot, 'System32', 'Wbem'),
  join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
// The player's data folder (%LOCALAPPDATA%\AiNpcCyberpunkMod in a real install) goes to a folder of this test run instead.
let dataHome = null;
const cleanEnv = () => {
  const env = {};
  for (const name of ['SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'COMPUTERNAME', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
    'CommonProgramFiles', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'PATHEXT', 'ComSpec']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return {...env, PATH: cleanPath, ...(dataHome ? {CYBERPUNK_CONVAI_DATA_HOME: dataHome} : {})};
};

async function expand(zip, destination) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath $env:ZIP -DestinationPath $env:DEST -Force`],
  {env: childEnv('powershell.exe', {...process.env, ZIP: zip, DEST: destination}), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  if (result.status !== 0) throw Error(`Expand-Archive failed for ${zip}: ${result.stderr.slice(-2000)}`);
}

function runNode(node, script, env, timeoutMs = 600_000) {
  return new Promise(done => {
    const child = spawn(node, [script], {env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { err = (err + data).slice(-8000); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', code => { clearTimeout(timer); done({code, out, err}); });
  });
}

const smokeScript = (app, state, withOmni, game) => `
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const app = ${JSON.stringify(app)}, state = ${JSON.stringify(state)};
const load = path => import(pathToFileURL(resolve(app, path)).href);
// The same environment the packaged service gives the bridge and its workers.
const launcher = await load('launcher/prepare-state.mjs');
const layout = launcher.installLayout({appDirectory: app, gameRoot: ${JSON.stringify(game)}, dataHome: resolve(state, '..')});
Object.assign(process.env, launcher.serviceEnvironment(layout, {omni: ${withOmni ? 'true' : 'false'}, keyFile: resolve(state, 'unused.txt')}, process.env));
const {PocketVoice} = await load('bridge/pocket-voice.mjs');
const {JaliFace} = await load('bridge/jali-face.mjs');
const report = {};
const configPath = resolve(state, 'pocket-voices.autobest.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const pocket = new PocketVoice(config, {project: app, configPath, pythonExecutable: config.runtime.pythonExecutable});
let t = performance.now();
await pocket.start();
report.pocketStartMs = Math.round(performance.now() - t);
report.pocketProfiles = pocket.profileKeys.length;
const profile = pocket.profileKeys.includes('judy-alvarez') ? 'judy-alvarez' : pocket.profileKeys[0];
const chunks = [];
t = performance.now();
const done = await pocket.synthesizeStream(profile, 'Hey, choom. Glad you made it in one piece.', {onPcm: packet => { chunks.push(packet.pcm); }});
report.pocketProfile = profile; report.pocketSeconds = done.duration; report.pocketRenderMs = Math.round(performance.now() - t);
await pocket.close();
const pcm = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
let at = 0; for (const c of chunks) { pcm.set(c, at); at += c.length; }
const face = await JaliFace.load(resolve(state, 'lipsync-model'));
report.faceLoaded = !!face;
if (face) {
  report.faceText = !!face.paths.text;
  const frames = await face.analyse(pcm, 24000, {text: 'Hey, choom. Glad you made it in one piece.'});
  report.faceFrames = frames.count ?? frames.length ?? frames.frames?.length ?? null;
  report.faceFramesType = frames.constructor?.name;
  await face.close();
}
// Local speech recognition (voice input on the Mistral text route): the packaged Python and model transcribe the Pocket speech.
{
  const {LocalStt} = await load('bridge/local-stt.mjs');
  const stt = new LocalStt({project: app, pythonExecutable: config.runtime.pythonExecutable});
  report.sttAvailable = stt.available();
  if (report.sttAvailable) {
    const out = new Int16Array(Math.floor(pcm.length * 16000 / 24000));
    for (let i = 0; i < out.length; i++) {
      const p = i * 1.5, lo = Math.floor(p), hi = Math.min(pcm.length - 1, lo + 1), f = p - lo;
      out[i] = Math.max(-32768, Math.min(32767, Math.round((pcm[lo] * (1 - f) + pcm[hi] * f) * 32767)));
    }
    await stt.start('install-test'); stt.pushAudio(out, 'install-test');
    t = performance.now();
    const heard = await stt.finish('install-test');
    report.sttText = heard.text; report.sttMs = Math.round(performance.now() - t);
    await stt.close();
  } else report.sttReason = stt.availability().reason;
}
if (${withOmni ? 'true' : 'false'}) {
  const {ResidentVoice} = await load('bridge/resident-voice.mjs');
  const omniPath = resolve(state, 'local-voices.autobest-short.json');
  const omniConfig = JSON.parse(await readFile(omniPath, 'utf8'));
  const voice = new ResidentVoice(omniConfig, {project: app, configPath: omniPath});
  t = performance.now();
  await voice.start();
  report.omniStartMs = Math.round(performance.now() - t);
  const key = voice.profileKeys.includes('judy-alvarez') ? 'judy-alvarez' : voice.profileKeys[0];
  t = performance.now();
  const spoken = await voice.synthesize(key, 'Hey, choom. Glad you made it in one piece.', {steps: 16});
  report.omniRenderMs = Math.round(performance.now() - t);
  report.omniAudioBytes = Buffer.from(spoken.audio, 'base64').length;
  report.omniDevice = voice.details?.device;
  await voice.close();
}
console.log(JSON.stringify(report));
process.exit(0);
`;

// ---------------------------------------------------------------- Local AI packs
const freePort = () => new Promise((resolvePort, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const {port} = probe.address(); probe.close(() => resolvePort(port)); });
});

// Starts the packaged llama-server on the processor only (no graphics card, nothing is spoken), waits until it reports the
// model loaded, and stops it again.
async function loadModel(exe, model, {embedding = false, timeoutMs = 900_000} = {}) {
  const port = await freePort();
  const args = ['-m', model, '-ngl', '0', '--device', 'none', '-c', '512', '-np', '1', '--threads', '4',
    '--host', '127.0.0.1', '--port', String(port), '--no-webui', ...(embedding ? ['--embedding'] : [])];
  const child = spawn(exe, args, {env: cleanEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let tail = '', exited = false;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { tail = (tail + data).slice(-2000); });
  const closed = new Promise(done => child.once('exit', () => { exited = true; done(); }));
  const started = Date.now();
  let ready = false;
  while (!exited && Date.now() - started < timeoutMs) {
    await sleep(1000);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch { /* still loading */ }
  }
  if (!exited) child.kill();
  await closed;
  return {ready, seconds: Math.round((Date.now() - started) / 1000), tail};
}

async function localAiChecks({work, game, app}) {
  const root = join(app, 'local-ai');
  const spec = JSON.parse(await readFile(join(project, 'packaging/release.config.json'), 'utf8')).localAi;
  // The packs ship every model whole (no parts, nothing to join at the first start); everything must match its pin.
  for (const [label, item] of [['standard chat model', spec.tiers.standard], ['lite chat model', spec.tiers.lite], ['embedding model', spec.embed]]) {
    const path = join(root, 'models', item.file);
    const whole = existsSync(path) && (await stat(path)).size === item.size && await sha256File(path) === item.sha256;
    check(`Local AI ${label} is whole and matches its pinned hash`, whole, item.name);
  }
  check('Local AI models are whole files, no parts', !(await readdir(join(root, 'models'))).some(name => /\.part\d+$/.test(name)));
  // The packaged bridge finds the pack from the environment the packaged service gives it, ignoring a developer's folder.
  const script = join(work, 'local-ai-detect.mjs');
  // The second argument of the script is a folder to use as the Runtime's engine folder instead of the install's (the fall-back check below).
  await writeFile(script, `
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const app = ${JSON.stringify(app)};
const load = path => import(pathToFileURL(resolve(app, path)).href);
const launcher = await load('launcher/prepare-state.mjs');
const {detectLocalAiPack} = await load('bridge/local-ai-pack.mjs');
const layout = launcher.installLayout({appDirectory: app, gameRoot: ${JSON.stringify(game)}});
const env = launcher.serviceEnvironment(layout, {omni: false, keyFile: 'unused'}, {CYBERPUNK_CONVAI_LOCAL_AI_DEV: 'C:/nowhere'});
if (process.argv[2]) env.CYBERPUNK_CONVAI_LOCAL_ENGINE = process.argv[2];
console.log(JSON.stringify(detectLocalAiPack({project: app, environment: env})));
`);
  const detected = spawnSync(join(app, 'node/node.exe'), [script], {env: cleanEnv(), encoding: 'utf8'});
  let pack = {};
  try { pack = JSON.parse(detected.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
  check('the packaged bridge detects both Local AI tiers and the embedding model',
    pack.installed === true && pack.dev === false && pack.tiers?.standard?.name === spec.tiers.standard.name && pack.tiers?.lite?.name === spec.tiers.lite.name
      && pack.embed?.dim === spec.embed.dim && (pack.missing ?? ['?']).length === 0 && pack.server?.startsWith(join(app, spec.server.runtimeFolder)),
    detected.status === 0 ? `standard ${pack.tiers?.standard?.name}, lite ${pack.tiers?.lite?.name}, embed ${pack.embed?.id}, missing [${pack.missing}]` : detected.stderr.slice(-500));
  // The Runtime's engine is the one used; a pack that still carries its own copy (localAi.server.inPacks) is the fall-back when the Runtime has none
  // (an older Runtime, a file an antivirus tool took).
  check("the packaged bridge uses the Runtime's engine, not the pack's copy", pack.engine?.source === 'runtime', `engine ${JSON.stringify(pack.engine)}`);
  if (spec.server.inPacks !== false) {
    const fallback = spawnSync(join(app, 'node/node.exe'), [script, join(work, 'no-engine-here')], {env: cleanEnv(), encoding: 'utf8'});
    let old = {};
    try { old = JSON.parse(fallback.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
    check("with no Runtime engine the pack's own copy is found", old.installed === true && old.server?.startsWith(root),
      fallback.status === 0 ? String(old.server).split(/[\\/]/).slice(-3).join('/') : fallback.stderr.slice(-400));
  }
  const server = pack.server;
  if (!server) return;
  const version = spawnSync(server, ['--version'], {env: cleanEnv(), encoding: 'utf8'});
  const number = spec.server.version.replace(/^b/, '');
  check('the packaged llama-server starts without anything else installed', new RegExp(`build ${number}\\b`).test(`${version.stdout}${version.stderr}`),
    `${version.stdout}${version.stderr}`.split('\n')[0]);
  for (const [label, file, embedding] of [['lite chat model', pack.tiers?.lite?.file, false], ['embedding model', pack.embed?.file, true],
    ['standard chat model', pack.tiers?.standard?.file, false]]) {
    if (!file) continue;
    const loaded = await loadModel(server, file, {embedding});
    check(`llama-server loads the ${label} on the processor`, loaded.ready, loaded.ready ? `ready after ${loaded.seconds} s` : loaded.tail.slice(-600));
  }
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'convai install test '));
  const game = join(work, 'Cyberpunk 2077 Ünïcode Test');
  dataHome = join(work, 'LocalAppData', 'AiNpcCyberpunkMod');
  console.log(`Stand-in game folder: ${game}`);
  try {
    await mkdir(join(game, 'bin/x64/plugins/cyber_engine_tweaks'), {recursive: true});
    await mkdir(join(game, 'red4ext'), {recursive: true});
    await writeFile(join(game, 'bin/x64/plugins/cyber_engine_tweaks.asi'), '');
    await writeFile(join(game, 'red4ext/RED4ext.dll'), '');
    if (!existsSync(host)) throw Error(`Launcher test host not found: ${host} (built by the release build).`);
    await copyFile(host, join(game, 'bin/x64/Cyberpunk2077.exe'));

    // Extract and compare every file with the build's file list.
    const names = await readdir(packagesDir);
    // Exact names only: version 0.2 must not pick up files of 0.2.1 or 0.20.
    const escaped = text => text.replace(/[.+]/g, '\\$&');
    // Only the Runtime may still come in several zips; the optional packs (OmniVoice, Local AI) are one zip each.
    const pick = (prefix, {parts = false} = {}) => names.filter(name => name === `${packageBase(prefix, version)}.zip`
      || (parts && new RegExp(`^${packageBase(prefix, escaped(version))}-part\\d+of\\d+\\.zip$`).test(name))).sort();
    const localIds = localAi ? ['LocalAI-Standard', 'LocalAI-Lite'] : [];
    // The update test extracts the previous version and the update zip instead of the new full Runtime (see the header).
    const updateZips = names.filter(name => new RegExp(`^Runtime-Update-.+-to-${escaped(version)}${escaped(gameSuffix)}\\.zip$`).test(name));
    const updateZip = updateFrom.length ? (updateZipArgument ?? (updateZips.length === 1 ? join(packagesDir, updateZips[0]) : null)) : null;
    const wanted = updateFrom.length ? [...pick('Scripts'), ...(omni ? pick('OmniPack') : []), ...localIds.flatMap(pick)]
      : [...pick('Scripts'), ...pick('Runtime', {parts: true}), ...(omni ? pick('OmniPack') : []), ...localIds.flatMap(pick)];
    check('packages present', pick('Scripts').length === 1 && (updateFrom.length ? existsSync(updateZip ?? '') && existsSync(join(packagesDir, `${packageBase('Runtime', version)}.files.json`))
      : pick('Runtime', {parts: true}).length >= 1) && (!omni || pick('OmniPack').length === 1) && localIds.every(id => pick(id).length === 1),
    updateFrom.length ? [...wanted, updateZip ? updateZip.split(/[\\/]/).pop() : '(no update zip)'].join(', ') : wanted.join(', '));
    let t = Date.now();
    let update = null;
    if (updateFrom.length) {
      // As a player updates: the previous Runtime and Scripts, then the update zip over them, then the new Scripts (below).
      for (const zip of [...updateFromScripts, ...updateFrom]) await expand(zip, game);
      const previous = new Set();
      for (const zip of updateFrom) for (const entry of await listZip(zip)) if (!entry.name.endsWith('/')) previous.add(entry.name);
      await expand(updateZip, game);
      const listed = (await listZip(updateZip)).find(entry => entry.name === REMOVALS_ENTRY);
      const removes = listed ? JSON.parse((await readEntry(updateZip, listed)).toString('utf8')).removes : null;
      const present = (removes ?? []).filter(rel => existsSync(join(game, rel)));
      update = {previous, removes, present, listBytes: listed ? await readEntry(updateZip, listed) : null};
      check('the previous Runtime is installed and the update zip carries a removal list', previous.size > 0 && Array.isArray(removes),
        `${previous.size} files before; the update names ${removes?.length ?? '(no list)'} to remove, ${present.length} of them installed`);
    }
    for (const zip of wanted) await expand(join(packagesDir, zip), game);
    check('extracted with Expand-Archive', true, `${wanted.length + (update ? updateFrom.length + updateFromScripts.length + 1 : 0)} archives in ${((Date.now() - t) / 1000).toFixed(0)} s`);
    let mismatches = 0, count = 0, longest = 0;
    const omniSplit = new Set();
    for (const id of ['Scripts', 'Runtime', ...(omni ? ['OmniPack'] : []), ...localIds]) {
      const list = JSON.parse(await readFile(join(packagesDir, `${packageBase(id, version)}.files.json`), 'utf8'));
      for (const file of list) {
        count++; longest = Math.max(longest, game.length + 1 + file.path.length);
        // The one file that differs by design: the update's removal list (what went away since the previous Runtime) replaces the full Runtime's own; it is checked below.
        if (update && file.path === REMOVALS_ENTRY) continue;
        // The step markers differ by design too: an updated Runtime has the update's step file instead of the full Runtime's base.json (checked below).
        if (update && file.path.startsWith(`${PLUGIN_FOLDER}/app/${STEPS_DIR}/`)) continue;
        const path = join(game, file.path);
        if (!existsSync(path) || (await stat(path)).size !== file.bytes || await sha256File(path) !== file.sha256) {
          mismatches++; if (mismatches < 5) console.log(`  mismatch: ${file.path}`);
        }
        if (file.path.endsWith('.parts.json')) omniSplit.add(file.path);
      }
    }
    check('every file matches the build', mismatches === 0, `${count} files, longest path ${longest} characters`);

    const plugin = join(game, 'red4ext/plugins/AiNpcCyberpunkMod'), app = join(plugin, 'app');
    const mod = join(game, 'bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod'), state = join(dataHome, 'data');
    const node = join(app, 'node/node.exe');
    const where = spawnSync(join(systemRoot, 'System32/where.exe'), ['node', 'python', 'python3'], {env: cleanEnv(), encoding: 'utf8'});
    check('no Node or Python on the test PATH', where.status !== 0, (where.stdout || '').trim() || 'where found none');
    if (keyFile) {
      await mkdir(state, {recursive: true});
      await copyFile(resolve(keyFile), join(state, 'convai-key.txt'));
      console.log('  copied the provided key file as the player\'s own key (contents not shown)');
    }

    // Prepare the data folder exactly as the launcher does, then exercise voice and face.
    const prepare = spawnSync(node, [join(app, 'launcher/start-service.mjs'), '--prepare-only', '--game-root', game],
      {env: cleanEnv(), encoding: 'utf8'});
    let summary = {};
    try { summary = JSON.parse(prepare.stdout.trim().split('\n').pop()); } catch {}
    check('start-service prepares the installation', prepare.status === 0 && summary.ok === true,
      `omni=${summary.omni} key=${summary.key}`);
    if (update) {
      const installedList = existsSync(join(game, REMOVALS_ENTRY)) ? await readFile(join(game, REMOVALS_ENTRY)) : null;
      check("the installed removal list is the update's own", installedList !== null && update.listBytes !== null && installedList.equals(update.listBytes));
      // The start step has run (--prepare-only is the same code path as the launcher's start): the listed files are gone, the rest matches the new Runtime.
      const removals = summary.removals ?? {};
      check('the start removed the files the update names, refusing and failing on none', removals.state === 'done' && removals.removed === update.present.length
        && removals.refused === 0 && removals.failed === 0 && update.present.every(rel => !existsSync(join(game, rel))),
      JSON.stringify(removals));
      const newList = JSON.parse(await readFile(join(packagesDir, `${packageBase('Runtime', version)}.files.json`), 'utf8'));
      const shippedNow = new Set(newList.map(file => file.path.toLowerCase()));
      const dropped = [...update.previous].filter(name => !shippedNow.has(name.toLowerCase())).sort();
      // What the previous Runtime had and the new one has not: gone, or left on purpose (a path the removal step may not delete, or an optional pack's file).
      const stayed = dropped.filter(name => existsSync(join(game, name)));
      const listedGone = new Set(update.removes);
      const why = name => refusalFor(name) ?? 'not in the update\'s list';
      check('every file the new Runtime no longer ships is gone, except what is left on purpose', stayed.every(name => !listedGone.has(name)),
        `${dropped.length} no longer shipped, ${dropped.length - stayed.length} gone, ${stayed.length} left in place${stayed.length ? ` (${stayed.slice(0, 5).map(name => `${name} [${why(name)}]`).join('; ')})` : ''}`);
      // Nothing else is in the Runtime's folders: no file of the previous Runtime the update missed.
      const extra = (await walk(join(game, PLUGIN_FOLDER), {skip: rel => /(?:^|\/)__pycache__(?:\/|$)/.test(rel)})).map(rel => `${PLUGIN_FOLDER}/${rel}`)
        .filter(name => !shippedNow.has(name.toLowerCase()) && !stayed.includes(name) && !name.endsWith('.pyc') && !name.startsWith(`${PLUGIN_FOLDER}/app/${STEPS_DIR}/step-`));
      // The update step markers (bridge/runtime-steps.mjs): the update adds only its own step-<from>-to-<to>.json and never base.json (a previous Runtime without markers has none, so the
      // chain starts at this step and shows no gap); the setup check's own walk reaches the installed version.
      const stepsDir = join(app, STEPS_DIR), stepNames = existsSync(stepsDir) ? await readdir(stepsDir) : [];
      const chain = await checkRuntimeSteps({project: app, current: JSON.parse(await readFile(join(app, 'release.json'), 'utf8')).version});
      // base.json is there exactly when the previous Runtime had one (0.2.9 and later write it; 0.2.8 and older had no markers): the update never adds or replaces it.
      const hadBase = [...update.previous].some(name => name.toLowerCase() === `${PLUGIN_FOLDER}/app/${STEPS_DIR}/base.json`.toLowerCase());
      check('the update left its own step marker, kept the previous base marker (if any), and the chain has no gap',
        stepNames.some(name => name.startsWith('step-') && name.endsWith(`-to-${version}.json`)) && stepNames.includes('base.json') === hadBase && chain.code === 'ok',
        `${stepNames.join(', ') || '(none)'}; chain ${chain.code}`);
      check('the plugin folder holds nothing the new Runtime does not ship', extra.length === 0, extra.slice(0, 5).join(', ') || `${newList.length} shipped files`);
    }
    for (const name of omniSplit) {
      const target = join(game, name.replace(/\.parts\.json$/, ''));
      check(`split file joined: ${name.split('/').pop().replace('.parts.json', '')}`, existsSync(target) && existsSync(`${target}.verified`));
    }
    // RED4ext plugin folders: the shipped launcher and the optional native plugin, nothing else. The development launcher
    // (red4ext/plugins/CyberpunkConvaiLauncher) would start a second service.
    const plugins = join(game, 'red4ext/plugins');
    const pluginFolders = (await readdir(plugins, {withFileTypes: true})).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    check('only the shipped plugins are installed (no development launcher)',
      pluginFolders.every(name => ['AiNpcCyberpunkMod', 'AiNpcCyberpunkModNative'].includes(name)) && pluginFolders.includes('AiNpcCyberpunkMod'), pluginFolders.join(', '));
    // A clean install has no folder under the mod's first name, and the first start finds no old installation to move.
    check('no old-name folders on a clean install', summary.legacy === null
      && !existsSync(join(plugins, 'CyberpunkConvai')) && !existsSync(join(game, 'bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai')), JSON.stringify(summary.legacy));
    // No package ships a file the game or the service rewrites (Vortex would report it as changed), so runtime/ exists only through its static note.
    check('runtime/ is in place through its static note', existsSync(join(mod, 'runtime', 'README.txt')));
    // What the Runtime must carry for its features (packaging/lib/runtime-required.mjs): V's voice clips and its OmniVoice lists.
    // A Runtime without them (0.2 and 0.2.1 had no V clips) fails here, and so does one whose clips the bridge's own loader rejects.
    // The Runtime ships no Convai key: a build with the token backend carries its settings (app/defaults/convai-auth.json, enabled, no fallback) and no
    // service.txt; a --dry-run build may carry neither.
    const runtimeRelease = JSON.parse(await readFile(join(app, 'release.json'), 'utf8'));
    const scriptsRelease = JSON.parse(await readFile(join(mod, 'release.json'), 'utf8'));
    check(`the Scripts and the Runtime are both the build for game ${gameId}`, (scriptsRelease.game ?? LEGACY_GAME) === gameId && (runtimeRelease.game ?? LEGACY_GAME) === gameId,
      `Scripts ${scriptsRelease.game ?? '(none)'}, Runtime ${runtimeRelease.game ?? '(none)'}`);
    const signIn = runtimeRelease.convaiSignIn === 'backend';
    check('the Runtime ships no Convai key file (no defaults/service.txt)', !existsSync(join(app, 'defaults/service.txt')) && runtimeRelease.convaiKey === 'none');
    if (signIn) {
      let settings = null;
      try { settings = JSON.parse(await readFile(join(app, 'defaults/convai-auth.json'), 'utf8')); } catch {}
      check('the sign-in settings are on, https, without a key fallback', settings?.enabled === true && settings.fallback === false
        && /^https:\/\/[^/]+\/api\/convai\/token$/.test(String(settings.url)) && String(settings.secret).length >= 32);
    }
    const required = await requiredRuntimeFiles(project, {signIn});
    const installed = new Set(Object.values(required).flat().filter(rel => existsSync(join(game, rel))));
    const absent = missingRuntimeFiles(installed, required);
    check("the Runtime carries V's voice clips, its OmniVoice lists, the llama.cpp engine and vgmstream", Object.keys(absent).length === 0,
      Object.keys(absent).length ? Object.entries(absent).map(([group, files]) => `${group}: ${files.map(file => file.split('/').pop()).join(', ')}`).join('; ') : `${Object.values(required).flat().length} files`);
    // The engine is part of the Runtime (docs/LOCAL_AI.md, "The engine is in the Runtime"): the server starts from there with nothing else installed, and the
    // free-memory fit tool beside it answers. This needs no Local AI pack and no graphics card, so it runs on every install.
    {
      const engineSpec = JSON.parse(await readFile(join(project, 'packaging/release.config.json'), 'utf8')).localAi.server;
      const engineDirectory = join(app, engineSpec.runtimeFolder);
      const runtimeServer = spawnSync(join(engineDirectory, 'llama-server.exe'), ['--version'], {env: cleanEnv(), encoding: 'utf8'});
      const output = `${runtimeServer.stdout}${runtimeServer.stderr}`;
      check("the Runtime's llama-server starts without anything else installed", new RegExp(`build ${engineSpec.version.replace(/^b/, '')}\\b`).test(output),
        output.split('\n').find(line => /build/.test(line)) ?? `exit ${runtimeServer.status}`);
      const fitTool = spawnSync(join(engineDirectory, 'llama-fit-params.exe'), ['--help'], {env: cleanEnv(), encoding: 'utf8'});
      check("the Runtime's llama-fit-params starts", fitTool.status === 0 && /fit/i.test(`${fitTool.stdout}${fitTool.stderr}`), `exit ${fitTool.status}`);
    }
    // vgmstream (the decoder of a player's V voice mod) is part of the Runtime: the CLI starts from app/vgmstream/ with nothing else installed, loads its libraries from
    // beside itself and names the pinned release. The files and licences themselves are in `required` above.
    {
      const vgmstreamSpec = JSON.parse(await readFile(join(project, 'packaging/release.config.json'), 'utf8')).toolchain.vgmstream;
      const vgmstream = spawnSync(join(app, vgmstreamSpec.runtimeFolder, vgmstreamSpec.executable), ['-h'], {env: cleanEnv(), encoding: 'utf8'});
      const help = `${vgmstream.stdout}${vgmstream.stderr}`;
      check("the Runtime's vgmstream-cli starts and is the pinned release", help.includes(`vgmstream CLI decoder ${vgmstreamSpec.version} (${vgmstreamSpec.build})`),
        help.split(/\r?\n/).find(line => /vgmstream/.test(line)) ?? `exit ${vgmstream.status}`);
    }
    const vScript = join(work, 'v-voice-check.mjs');
    await writeFile(vScript, `
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const {loadVVoiceReferences} = await import(pathToFileURL(resolve(${JSON.stringify(app)}, 'bridge/v-voice.mjs')).href);
const log = [];
const found = await loadVVoiceReferences([${JSON.stringify(join(plugin, V_VOICE_FOLDER))}], {log: message => log.push(message)});
console.log(JSON.stringify({genders: Object.keys(found?.voices ?? {}).sort(), log}));
`);
    const vLoad = spawnSync(node, [vScript], {env: cleanEnv(), encoding: 'utf8'});
    let vResult = {};
    try { vResult = JSON.parse(vLoad.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
    check("the packaged bridge loads both of V's voice clips (names and hashes match the manifest)", vLoad.status === 0 && vResult.genders?.join() === 'female,male' && !vResult.log?.length,
      vLoad.status === 0 ? `${vResult.genders?.join(', ') || 'none'}${vResult.log?.length ? `; ${vResult.log.join('; ')}` : ''}` : (vLoad.stderr || '').slice(-300));
    const nativeDll = join(plugins, 'AiNpcCyberpunkModNative/CyberpunkConvaiNative.dll');
    const nativeOff = join(mod, 'runtime/native-off.txt');
    const release = JSON.parse(await readFile(join(app, 'release.json'), 'utf8'));
    if (existsSync(nativeDll)) {
      check('native plugin matches the recorded hash', release.nativePlugin === await sha256File(nativeDll), (release.nativePlugin || '').slice(0, 12));
      if (existsSync(pluginHost)) {
        const inspected = spawnSync(pluginHost, [nativeDll], {env: cleanEnv(), encoding: 'utf8'});
        check('native plugin exports what RED4ext needs and imports only system DLLs', inspected.status === 0, (inspected.stdout || '').trim().split('\n').slice(-3).join(' | '));
      } else console.log(`  (no plugin inspector at ${pluginHost}; skipped)`);
      const buildConfig = JSON.parse(await readFile(join(project, 'packaging/release.config.json'), 'utf8'));
      // The plugin's own parser rule: one name per line, '#' starts a comment, a missing file means all on.
      const off = existsSync(nativeOff) ? (await readFile(nativeOff, 'utf8')).split(/\r?\n/).map(line => line.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean) : null;
      check('runtime/native-off.txt ships and lists exactly the configured off systems (none: every system on)', JSON.stringify(off) === JSON.stringify(buildConfig.native.off), off ? (off.join(', ') || 'no system off') : 'missing');
      check('native plugin licences ship beside the DLL', ['RED4ext.SDK-LICENSE.md', 'yyjson-LICENSE.txt', 'README.txt'].every(name => existsSync(join(plugins, 'AiNpcCyberpunkModNative', name))));
    } else {
      check('package without the native plugin has no native-off.txt', !existsSync(nativeOff) && release.nativePlugin === 'none');
    }
    if (localAi) await localAiChecks({work, game, app});

    const harness = join(work, 'smoke.mjs');
    await writeFile(harness, smokeScript(app, state, omni, game));
    t = Date.now();
    const smoke = await runNode(node, harness, cleanEnv(), 900_000);
    let report = {};
    try { report = JSON.parse(smoke.out.trim().split('\n').pop()); } catch {}
    check('Pocket voice speaks from the packaged Python', smoke.code === 0 && report.pocketSeconds > 0.5,
      smoke.code === 0 ? `${report.pocketProfiles} voices, ${report.pocketProfile}: ${report.pocketSeconds?.toFixed?.(2)} s of audio, start ${report.pocketStartMs} ms, render ${report.pocketRenderMs} ms`
        : smoke.err.slice(-1500));
    check('lip-sync model loads and animates that audio', report.faceLoaded === true && !!report.faceFramesType,
      `text stage ${report.faceText ? 'on' : 'off'}, frames: ${report.faceFramesType} ${report.faceFrames ?? ''}`);
    check('local speech recognition transcribes that speech from the packaged Python and model', report.sttAvailable === true && /glad|piece|choom|chum/i.test(report.sttText || ''),
      report.sttAvailable ? `"${report.sttText}" in ${report.sttMs} ms` : `unavailable: ${report.sttReason}`);
    if (omni) check('OmniVoice speaks on the GPU from the pack', report.omniAudioBytes > 10_000,
      `device ${report.omniDevice}, start ${report.omniStartMs} ms, render ${report.omniRenderMs} ms`);

    // The real launcher path: test host -> CyberpunkConvai.dll -> launcher.ini -> packaged Node -> service.
    const result = join(work, 'host-result.json');
    const status = join(mod, 'runtime/bridge-service.json');
    await rm(status, {force: true});
    const hostProcess = spawn(join(game, 'bin/x64/Cyberpunk2077.exe'), [join(plugin, 'CyberpunkConvai.dll'), result, '900000'],
      {env: cleanEnv(), windowsHide: true, stdio: 'ignore'});
    // A package with the token backend's settings starts without setup, like one with the player's own key.
    const keyed = !!keyFile || signIn;
    const expected = keyed ? 'ready' : 'failed';
    let last = null;
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      await sleep(1000);
      try { last = JSON.parse(await readFile(status, 'utf8')); } catch { continue; }
      if (last.source === 'launcher' && last.state === 'failed') break;
      if (last.state === expected && (keyed || last.code === 'missing-key')) break;
      if (last.state === 'failed' && last.code !== 'missing-key') break;
    }
    const hostInfo = existsSync(result) ? JSON.parse(await readFile(result, 'utf8')) : {};
    check('launcher DLL loads like a RED4ext plugin', hostInfo.load === true && hostInfo.name === 'CyberpunkConvaiLauncher', JSON.stringify({api: hostInfo.api, name: hostInfo.name}));
    check(keyed ? 'service reports Ready (bridge started from the packaged Node)' : 'service asks for setup without a key',
      last?.state === expected && (keyed || last.code === 'missing-key'), last ? `${last.state}/${last.code}` : 'no status');
    if (keyed && last?.state === 'ready') {
      const stdout = await readFile(join(state, 'bridge.stdout.log'), 'utf8').catch(() => '');
      const stderr = await readFile(join(state, 'bridge.stderr.log'), 'utf8').catch(() => '');
      check('bridge loaded the lip-sync model', !/Facial model unavailable/.test(stderr), stderr.match(/Facial model[^\n]*/)?.[0] ?? 'no facial-model error');
      check('bridge printed its ready marker', /Convai conversation bridge ready/.test(stdout));
    }
    // A normal game exit closes the lifeline; the service must stop the bridge.
    await writeFile(`${result}.exit`, '');
    await new Promise(done => hostProcess.once('close', done));
    let stopped = null;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      try { stopped = JSON.parse(await readFile(status, 'utf8')); } catch {}
      if (stopped?.state === 'stopped' || (!keyed && stopped?.state === 'failed')) break;
    }
    check('service stops when the game exits', keyed ? stopped?.state === 'stopped' : true, stopped ? `${stopped.state}/${stopped.code}` : '');
    const log = await readFile(join(state, 'bridge-service.log'), 'utf8').catch(() => '');
    check('service log has no packaging errors', !/Preparing the installation failed|Supervisor failed/.test(log));
  } finally {
    const failed = results.filter(item => !item.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    if (!keep) {
      // The bridge may still be releasing files for a moment after it stops.
      for (let i = 0; i < 10; i++) { try { await rm(work, {recursive: true, force: true}); break; } catch { await sleep(2000); } }
    } else console.log(`Kept ${work}`);
    process.exitCode = failed ? 1 : 0;
  }
}

main().catch(error => { console.error(error?.stack || error); process.exit(1); });
