// Packaged entry point of the conversation service. The RED4ext launcher
// (red4ext/plugins/CyberpunkConvai/CyberpunkConvai.dll) starts it with the bundled Node
// when the game starts, as configured by launcher.ini next to the DLL:
//   app/node/node.exe app/launcher/start-service.mjs --game-pid <pid> --game-root <root> --lifeline stdin
// It prepares the data folder for this installation, joins any split download parts,
// sets every executable and asset path explicitly, and then runs the same supervisor as
// development (bridge/bridge-supervisor.mjs): one bridge for this game session, crash
// restarts, and a graceful stop when the game exits.
//
// --prepare-only does everything except starting the service and prints a summary.
import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installLayout, prepareState, serviceEnvironment} from './prepare-state.mjs';
import {assembleParts} from './assemble-parts.mjs';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
const gameRoot = option('--game-root');
const prepareOnly = argv.includes('--prepare-only');
if (!gameRoot) {
  process.stderr.write('Conversation service: --game-root is required.\n');
  process.exit(2);
}
const layout = installLayout({appDirectory, gameRoot});
mkdirSync(layout.state, {recursive: true});
const logPath = resolve(layout.state, 'bridge-service.log');
const log = message => { try { appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`); } catch {} };

function readVersion(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')).version ?? null; } catch { return null; }
}

function publishFailure(code) {
  // Same file and fields the supervisor publishes, so the in-game status explains the problem.
  try {
    mkdirSync(layout.runtime, {recursive: true});
    const now = Date.now();
    writeFileSync(resolve(layout.runtime, 'bridge-service.json'), JSON.stringify({version: 1, state: 'failed', code,
      since: now, updated: now, supervisorPid: process.pid, bridgePid: null, adopted: false, restarts: 0,
      gamePid: Number(option('--game-pid')) || null, gameRoot: layout.gameRoot, stateDirectory: layout.state}));
  } catch {}
}

let prepared;
try {
  const runtimeVersion = readVersion(resolve(appDirectory, 'release.json'));
  const scriptsVersion = readVersion(resolve(layout.mod, 'release.json'));
  log(`Conversation service ${runtimeVersion ?? '(unknown version)'} preparing ${layout.gameRoot}.`);
  if (scriptsVersion && runtimeVersion && scriptsVersion !== runtimeVersion) {
    log(`Warning: the Scripts package is ${scriptsVersion} but the Runtime package is ${runtimeVersion}. Install matching versions.`);
  }
  prepared = await prepareState(layout, {log});
  if (prepared.omni) await assembleParts(layout.omni, {log});
} catch (error) {
  log(`Preparing the installation failed: ${error?.stack || error}`);
  publishFailure('install-incomplete');
  if (prepareOnly) { process.stdout.write(JSON.stringify({ok: false, error: String(error?.message || error)}) + '\n'); }
  process.exit(1);
}

const env = serviceEnvironment(layout, prepared);
if (prepareOnly) {
  process.stdout.write(JSON.stringify({ok: true, omni: prepared.omni,
    key: prepared.keyFile.startsWith(layout.state) ? 'player' : 'package', state: layout.state}) + '\n');
  process.exit(0);
}
for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
Object.assign(process.env, env);

const {BridgeSupervisor, parseSupervisorArguments} = await import('../bridge/bridge-supervisor.mjs');
let options;
try {
  options = parseSupervisorArguments([...argv.filter(value => value !== '--prepare-only'),
    '--project', appDirectory, '--state', layout.state, '--key-file', prepared.keyFile], {defaultProject: appDirectory});
} catch (error) {
  log(`Supervisor arguments rejected: ${error.message}`);
  process.exit(2);
}
const supervisor = new BridgeSupervisor({...options, nodeExecutable: process.execPath,
  lifeline: options.lifeline === 'stdin' ? process.stdin : null});
if (options.unknown.length) supervisor.log(`Ignored unknown arguments: ${options.unknown.join(' ')}`);
for (const name of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(name, () => supervisor.requestExit('supervisor-stopped'));
process.on('unhandledRejection', error => supervisor.log(`Unhandled rejection: ${error?.stack || error}`));

let code = 0;
try {
  await supervisor.run();
} catch (error) {
  code = 1;
  log(`Supervisor failed: ${error?.stack || error}`);
  if (supervisor.childPid && !supervisor.childExit) await supervisor.stopOwnBridge().catch(() => {});
  await supervisor.setStatus('failed', 'supervisor-error').catch(() => {});
}
process.exit(code);
