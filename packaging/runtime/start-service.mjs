// Packaged entry point of the conversation service. The RED4ext launcher
// (red4ext/plugins/AiNpcCyberpunkMod/CyberpunkConvai.dll) starts it with the bundled Node
// when the game starts, as configured by launcher.ini next to the DLL:
//   app/node/node.exe app/launcher/start-service.mjs --game-pid <pid> --game-root <root> --lifeline stdin
// It prepares the data folder for this installation (first moving optional pack files that were extracted one folder too deep
// into place), joins any split download parts,
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
import {placeMisplacedPacks} from './place-packs.mjs';
import {adoptLegacyInstall, cleanupLegacyInstall} from './migrate-legacy.mjs';
import {dataHomeFor, moveGameFolderState} from './state-home.mjs';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
const gameRoot = option('--game-root');
const prepareOnly = argv.includes('--prepare-only');
if (!gameRoot) {
  process.stderr.write('Conversation service: --game-root is required.\n');
  process.exit(2);
}
// The player's data lives outside the game folder, in %LOCALAPPDATA%\AiNpcCyberpunkMod\data (packaging/runtime/state-home.mjs): under
// Mod Organizer 2 every file created inside the game folder is redirected into its Overwrite folder. Only runtime/, which the game's
// Lua must reach, stays in the mod folder.
const early = [];
const home = dataHomeFor(process.env);
if (home.problem) early.push(home.problem);
let layout = installLayout({appDirectory, gameRoot, dataHome: home.root});

// An older installation (this mod was called CyberpunkConvai) is retired and its state moved to the new folders before anything
// reads the data folder (packaging/runtime/migrate-legacy.mjs). It is a few stat calls when there is no old folder. A failure here
// never stops the service: the old state stays where it is and the next start tries again.
let legacy = null;
try { legacy = await adoptLegacyInstall({gameRoot: layout.gameRoot, stateDirectory: layout.state, log: message => early.push(message)}); }
catch (error) { early.push(`Carry-over from the old installation failed: ${error?.stack || error}`); }

// Then the data folder an earlier release kept in the game folder moves to the data home, once. One lstat when there is nothing to
// move. The move is all or nothing; when it cannot finish (a file in use, a full disk) this start keeps the game folder's copy and
// the next start tries again, so the player never sees an empty data folder.
if (layout.dataHome) {
  let moved = null;
  try { moved = await moveGameFolderState({from: layout.gameState, to: layout.state, log: message => early.push(message)}); }
  catch (error) { early.push(`Moving the data folder out of the game folder failed: ${error?.stack || error}`); moved = {found: true, state: 'deferred'}; }
  if (moved?.found && moved.state === 'deferred') layout = installLayout({appDirectory, gameRoot, dataHome: null});
}

mkdirSync(layout.state, {recursive: true});
const logPath = resolve(layout.state, 'bridge-service.log');
const log = message => { try { appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`); } catch {} };
for (const message of early) log(message);
// What is left of the old folders (the old application and its browser, Python...) is removed off the main path, a while after
// the start, so the game's loading never competes with the deletion. A locked file only postpones it to the next start.
const legacyCleanup = delayMs => new Promise(done => {
  if (!legacy?.found) return done(null);
  const run = () => cleanupLegacyInstall({adopted: legacy, log}).then(done, error => { log(`Removing the old folders failed: ${error?.message || error}`); done(null); });
  if (delayMs > 0) setTimeout(run, delayMs).unref(); else run();
});

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
  log(`Conversation service ${runtimeVersion ?? '(unknown version)'} preparing ${layout.gameRoot}; player data in ${layout.state}.`);
  if (scriptsVersion && runtimeVersion && scriptsVersion !== runtimeVersion) {
    log(`Warning: the Scripts package is ${scriptsVersion} but the Runtime package is ${runtimeVersion}. Install matching versions.`);
  }
  // Optional pack files extracted one folder too deep (a wrapper folder named after the zip) are moved into place first, so the pack
  // checks below and the bridge find them (packaging/runtime/place-packs.mjs). A few stat calls when there is nothing to fix; a
  // problem is logged and never stops the service.
  try { await placeMisplacedPacks({layout, log}); }
  catch (error) { log(`Checking for misplaced pack files failed: ${error?.stack || error}`); }
  prepared = await prepareState(layout, {log});
  if (prepared.omni) await assembleParts(layout.omni, {log});
} catch (error) {
  log(`Preparing the installation failed: ${error?.stack || error}`);
  publishFailure('install-incomplete');
  if (prepareOnly) { process.stdout.write(JSON.stringify({ok: false, error: String(error?.message || error)}) + '\n'); }
  process.exit(1);
}

// The optional Local AI packs (docs/LOCAL_AI.md) now ship every model whole, so a current install has nothing to join and the detector
// uses the model file directly. This only matters for files left by an earlier release, which split the standard chat model into
// parts: those are joined and verified once after extraction. It runs beside the service rather than before it, so a first start
// does not wait for 5 GB; the bridge looks for the pack again whenever Local is chosen, so it is found as soon as the join finishes.
// A problem here only means the Local AI row reads "Not installed"; it never stops the service.
const localAiJoined = assembleParts(layout.localAi, {log}).catch(error => { log(`Local AI pack: ${error?.message || error}`); return []; });

const env = serviceEnvironment(layout, prepared);
if (prepareOnly) {
  const localAi = await localAiJoined;
  const cleaned = await legacyCleanup(0);
  process.stdout.write(JSON.stringify({ok: true, omni: prepared.omni, localAi: localAi.map(item => `${item.file}:${item.state}`),
    legacy: legacy?.found ? {moved: legacy.report.moved.length, errors: legacy.report.errors, removed: cleaned?.removed ?? [], pending: cleaned?.pending ?? []} : null,
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
legacyCleanup(45_000);
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
