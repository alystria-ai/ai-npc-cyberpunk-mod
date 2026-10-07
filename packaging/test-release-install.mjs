// Clean-install test for built release packages. It never touches a real game folder.
//
//   node packaging/test-release-install.mjs --packages dist/release/packages --version 0.9.0
//        [--host dist/release/native/test-host.exe] [--key-file runtime/convai-key.txt] [--omni] [--keep]
//
// 1. Makes a stand-in game folder under %TEMP% whose path has spaces and non-ASCII characters
//    (bin/x64/Cyberpunk2077.exe is the launcher test host, plus empty CET and RED4ext markers).
// 2. Extracts the Scripts and Runtime zips (and every OmniVoice part with --omni) with
//    PowerShell's Expand-Archive, as a player would, and checks every file against the build's
//    file list (paths, sizes, SHA-256).
// 3. Runs the remaining checks with a PATH that holds only Windows system folders, so no
//    installed Node or Python can be used:
//    - the packaged Node loads the Pocket voice from the packaged Python, speaks a sentence and
//      the lip-sync model turns that audio into mouth frames (and, with --omni, OmniVoice speaks
//      on the GPU from the pack's Python);
//    - the real launcher DLL, loaded by the test host like RED4ext does, starts the packaged
//      service, which must report Ready (with --key-file, used as the player's own key and never
//      printed) or ask for setup (without a key); closing the host must stop it again.
import {spawn, spawnSync} from 'node:child_process';
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {sha256File} from './lib/files.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const argv = process.argv.slice(2);
const value = (name, fallback) => { const at = argv.indexOf(name); return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback; };
const packagesDir = resolve(value('--packages', resolve(project, 'dist/release/packages')));
const version = value('--version');
const host = resolve(value('--host', resolve(packagesDir, '../native/test-host.exe')));
const keyFile = value('--key-file');
const omni = argv.includes('--omni');
const keep = argv.includes('--keep');
if (!version) { console.error('--version is required'); process.exit(2); }

const results = [];
const check = (name, ok, detail = '') => { results.push({name, ok, detail}); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
// Only Windows' own folders: no Node, Python, Git or developer tools.
const cleanPath = [join(systemRoot, 'System32'), systemRoot, join(systemRoot, 'System32', 'Wbem'),
  join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
const cleanEnv = () => {
  const env = {};
  for (const name of ['SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'COMPUTERNAME', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
    'CommonProgramFiles', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'PATHEXT', 'ComSpec']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return {...env, PATH: cleanPath};
};

async function expand(zip, destination) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath $env:ZIP -DestinationPath $env:DEST -Force`],
  {env: {...process.env, ZIP: zip, DEST: destination}, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
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
const layout = launcher.installLayout({appDirectory: app, gameRoot: ${JSON.stringify(game)}});
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

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'convai install test '));
  const game = join(work, 'Cyberpunk 2077 Ünïcode Test');
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
    const pick = prefix => names.filter(name => name.startsWith(`CyberpunkConvai-${prefix}-${version}`) && name.endsWith('.zip')).sort();
    const wanted = [...pick('Scripts'), ...pick('Runtime'), ...(omni ? pick('OmniPack') : [])];
    check('packages present', pick('Scripts').length === 1 && pick('Runtime').length >= 1 && (!omni || pick('OmniPack').length >= 1), wanted.join(', '));
    let t = Date.now();
    for (const zip of wanted) await expand(join(packagesDir, zip), game);
    check('extracted with Expand-Archive', true, `${wanted.length} archives in ${((Date.now() - t) / 1000).toFixed(0)} s`);
    let mismatches = 0, count = 0, longest = 0;
    const omniSplit = new Set();
    for (const id of ['Scripts', 'Runtime', ...(omni ? ['OmniPack'] : [])]) {
      const list = JSON.parse(await readFile(join(packagesDir, `CyberpunkConvai-${id}-${version}.files.json`), 'utf8'));
      for (const file of list) {
        count++; longest = Math.max(longest, game.length + 1 + file.path.length);
        const path = join(game, file.path);
        if (!existsSync(path) || (await stat(path)).size !== file.bytes || await sha256File(path) !== file.sha256) {
          mismatches++; if (mismatches < 5) console.log(`  mismatch: ${file.path}`);
        }
        if (file.path.endsWith('.parts.json')) omniSplit.add(file.path);
      }
    }
    check('every file matches the build', mismatches === 0, `${count} files, longest path ${longest} characters`);

    const plugin = join(game, 'red4ext/plugins/CyberpunkConvai'), app = join(plugin, 'app');
    const mod = join(game, 'bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai'), state = join(mod, 'data');
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
    for (const name of omniSplit) {
      const target = join(game, name.replace(/\.parts\.json$/, ''));
      check(`split file joined: ${name.split('/').pop().replace('.parts.json', '')}`, existsSync(target) && existsSync(`${target}.verified`));
    }
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
    if (omni) check('OmniVoice speaks on the GPU from the pack', report.omniAudioBytes > 10_000,
      `device ${report.omniDevice}, start ${report.omniStartMs} ms, render ${report.omniRenderMs} ms`);

    // The real launcher path: test host -> CyberpunkConvai.dll -> launcher.ini -> packaged Node -> service.
    const result = join(work, 'host-result.json');
    const status = join(mod, 'runtime/bridge-service.json');
    await rm(status, {force: true});
    const hostProcess = spawn(join(game, 'bin/x64/Cyberpunk2077.exe'), [join(plugin, 'CyberpunkConvai.dll'), result, '900000'],
      {env: cleanEnv(), windowsHide: true, stdio: 'ignore'});
    // A package with a built-in service key starts without setup, like one with the player's own key.
    const builtIn = JSON.parse(await readFile(join(app, 'release.json'), 'utf8')).convaiKey === 'package';
    const keyed = !!keyFile || builtIn;
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
