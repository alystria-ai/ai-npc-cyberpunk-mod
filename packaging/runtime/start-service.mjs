// Packaged entry point of the conversation service. The RED4ext launcher
// (red4ext/plugins/AiNpcCyberpunkMod/CyberpunkConvai.dll) starts it with the bundled Node
// when the game starts, as configured by launcher.ini next to the DLL (packaging/lib/launcher-ini.mjs):
//   app/node/node.exe --eval <bootstrap> app/launcher/start-service.mjs --game-pid <pid> --game-root <root> --lifeline stdin
// The bootstrap loads this script from its real place when Node's stat cannot see it (a Runtime installed as a Mod Organizer 2 mod);
// process.argv is the same as with the script as Node's entry.
// It prepares the data folder for this installation (first moving optional pack files that were extracted one folder too deep
// into place), joins any split download parts,
// sets every executable and asset path explicitly, and then runs the same supervisor as
// development (bridge/bridge-supervisor.mjs): one bridge for this game session, crash
// restarts, and a graceful stop when the game exits.
//
// Nothing here may end without a word. The launcher sends this process's own output nowhere, and the game knows the service only by the
// status it reads from runtime/bridge-service.json. So the status is written from the first line (state "starting", the stage it is in,
// and a short path-free reason when it fails), this script's own modules are loaded inside a guard, and an error nobody caught ends in
// a "failed" status too. Only Node's own modules are imported at the top: a file missing there could not be reported.
//
// The Runtime may be an installed folder or a Mod Organizer 2 mod that exists only in the virtual file system (USVFS); this process then
// runs inside that file system too, as does every process the game starts. The one thing it cannot know from inside is that it IS
// inside: the launcher saw the CET mod's init.lua before it started this process, so a process that cannot see it looks at another
// file system than the game, and nothing it wrote under the game folder would reach the game. It says so in its log and stops, instead
// of creating stray folders and loading models for a service nobody can talk to.
//
// Inside USVFS (Mod Organizer 2 2.5.2, usvfs 0.5.6.1) the bundled Node's stat cannot see a file that exists only in an MO2 mod folder, while
// opening and reading it works (packaging/runtime/usvfs-compat.mjs). So when usvfs is loaded, this script first puts the stat fallbacks
// of usvfs-compat.mjs in place (the CET mod's runtime/ folder, which the game reads, stays at its virtual place), runs the Runtime's own
// files from their real place (the bootstrap loaded this script from there; the optional packs are looked up at their virtual place and
// used from their real one, so a pack installed as its own MO2 mod is found), and gives every Node process it starts the same fallbacks.
//
// --prepare-only does everything except starting the service and prints a summary.
import {appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, relative, resolve, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

// Where this script runs from (its real place, under Mod Organizer 2) and where the launcher started it (the virtual place).
const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launchedApp = /(?:^|[\\/])start-service\.mjs$/i.test(process.argv[1] ?? '') ? resolve(dirname(process.argv[1]), '..') : appDirectory;
const argv = process.argv.slice(2);
const option = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
const gameRoot = option('--game-root');
const prepareOnly = argv.includes('--prepare-only');
if (!gameRoot) {
  process.stderr.write('Conversation service: --game-root is required.\n');
  process.exit(2);
}

// ------------------------------------------------------------------------------------------------ the status the game reads
const MOD_FOLDER = 'bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod';
const statusPath = resolve(gameRoot, MOD_FOLDER, 'runtime', 'bridge-service.json');
const startedAt = Date.now();
const startNotes = []; // log lines from before the log file's folder is known
let stage = 'starting', stateFolder = null, statusOwner = 'service', beat = null, logSink = null;
const note = message => { if (logSink) logSink(message); else startNotes.push(message); };

// What this process sees, for the log and for the status the game reads (so the short report carries it): whether it runs inside Mod
// Organizer 2's virtual file system (usvfs is among its loaded libraries, as bridge/setup-check.mjs reads it), where the Runtime is
// relative to the game, and whether the CET mod's init.lua is visible. A support request that includes it answers most of what a start
// failure raises.
const insideVfs = (() => {
  try {
    const objects = process.report?.getReport?.()?.sharedObjects;
    if (Array.isArray(objects)) return objects.some(path => /(?:^|[\\/])usvfs_x(?:64|86)\.dll$/i.test(String(path))) ? 'yes' : 'no';
  } catch {}
  return 'unknown';
})();
// Inside usvfs the stat fallbacks go in before anything looks at the game folder (init.lua below, the status, the layout). A problem
// loading them is logged and the start goes on as before (the init.lua check then says what this process can see).
let usvfsCompat = null;
if (insideVfs === 'yes') {
  try { usvfsCompat = await import('./usvfs-compat.mjs'); usvfsCompat.installUsvfsCompat(); }
  catch (error) { usvfsCompat = null; note(`Mod Organizer 2 support could not be loaded: ${error?.stack || error}`); }
}
const canReachGame = existsSync(resolve(gameRoot, MOD_FOLDER, 'init.lua'));
const insideGame = folder => { const away = relative(resolve(gameRoot), folder); return away === '' || (!away.startsWith('..') && !isAbsolute(away)); };
// 'inside', 'outside', or 'in an MO2 mod' (started through the game folder, running from its real place elsewhere).
const runtimeAt = insideGame(appDirectory) ? 'inside' : insideGame(launchedApp) ? 'in an MO2 mod' : 'outside';
const runtimeWhere = runtimeAt === 'in an MO2 mod' ? 'in an MO2 mod folder' : `${runtimeAt} the game folder`;
const viewSummary = `usvfs ${insideVfs}${usvfsCompat ? ' (stat fallbacks on)' : ''}; Runtime ${runtimeWhere}; init.lua ${canReachGame ? 'visible' : 'not visible'}`;

// One short sentence for the game to show: Node's error code and message, every folder path cut down to its file name (a path can hold
// the player's user name, and folders with spaces in them are common), never longer than 140 characters. A quoted path ends at its
// quote; a path that is not quoted runs to the end of the line, because where it ends cannot be told when a folder name has a space.
function shortReason(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const last = path => path.split(/[\\/]/).filter(Boolean).pop() ?? '';
  let text = String(error?.message ?? error ?? '').split('\n')[0];
  text = text.replace(/'([^']*[\\/][^']*)'/g, (_, path) => `'${last(path)}'`)
    .replace(/(?:file:\/\/\/)?(?:[A-Za-z]:[\\/]|\\\\)[^'"<>|*?\r\n]*/g, path => last(path)).replace(/\s+/g, ' ').trim();
  const body = code && !text.includes(code) ? `${code}: ${text}` : text;
  return (body || 'unknown error').slice(0, 140);
}

// Written in place (an existing file opened for writing stays where it is under Mod Organizer 2) and never creating the CET mod folder:
// when that folder is not there, nothing here makes it.
function publish(state, code, reason) {
  if (statusOwner !== 'service' || (prepareOnly && state !== 'failed')) return;
  try {
    const folder = dirname(statusPath);
    if (!existsSync(folder)) { if (!canReachGame) return; mkdirSync(folder, {recursive: true}); }
    const now = Date.now();
    writeFileSync(statusPath, JSON.stringify({version: 1, state, code, source: 'service', stage, ...(reason ? {reason} : {}), view: viewSummary,
      since: state === 'failed' ? now : startedAt, updated: now, supervisorPid: process.pid, bridgePid: null, adopted: false, restarts: 0,
      gamePid: Number(option('--game-pid')) || null, gameRoot: resolve(gameRoot), ...(stateFolder ? {stateDirectory: stateFolder} : {})}));
  } catch {}
}
// While this script prepares (before the supervisor owns the file) the status is refreshed every few seconds, for five minutes at most:
// a stage that long has hung, and the status then goes stale with the stage it stopped in, which the game reports as a service that
// never came up.
const PREPARE_LIMIT_MS = 300_000;
const stopBeat = () => { if (beat) { clearInterval(beat); beat = null; } };
const startBeat = () => {
  if (prepareOnly) return;
  beat = setInterval(() => { if (Date.now() - startedAt > PREPARE_LIMIT_MS) stopBeat(); else publish('starting', 'service-starting'); }, 5000);
  beat.unref();
};
// Same file and fields the supervisor publishes, so the in-game status explains the problem.
const publishFailure = (code, reason) => { stopBeat(); publish('failed', code, reason); };
const enterStage = name => { stage = name; publish('starting', 'service-starting'); };

// When the log's own folder is not known yet (the script's files did not load, or the layout could not be made), the notes are written to
// where the log would be, when the usual place can be worked out.
function writeNotesToUsualLog() {
  try {
    let where = null;
    try { if (typeof dataHomeFor === 'function') where = dataHomeFor(process.env).root; } catch {}
    where ||= process.env.CYBERPUNK_CONVAI_DATA_HOME || (process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, 'AiNpcCyberpunkMod') : null);
    if (where && isAbsolute(where)) {
      mkdirSync(resolve(where, 'data'), {recursive: true});
      for (const message of startNotes.splice(0)) appendFileSync(resolve(where, 'data', 'bridge-service.log'), `${new Date().toISOString()} ${message}\n`);
    }
  } catch {}
}

// An error nobody caught ends the start with a status, not silently. The supervisor takes these handlers over once it runs.
function died(error) {
  note(`The conversation service stopped: ${error?.stack || error}`);
  if (!logSink) writeNotesToUsualLog();
  publishFailure('service-error', shortReason(error));
  process.exit(1);
}
process.on('uncaughtException', died);
process.on('unhandledRejection', died);
enterStage('loading-modules');
startBeat();

// The script's own modules, loaded inside the guard: a Runtime extracted only in part, or a file blocked or removed by antivirus, ends here.
let installLayout, prepareState, serviceEnvironment, assembleParts, placeMisplacedPacks, recordPlacement, adoptLegacyInstall,
  cleanupLegacyInstall, dataHomeFor, moveGameFolderState;
try {
  ({installLayout, prepareState, serviceEnvironment} = await import('./prepare-state.mjs'));
  ({assembleParts} = await import('./assemble-parts.mjs'));
  ({placeMisplacedPacks, recordPlacement} = await import('./place-packs.mjs'));
  ({adoptLegacyInstall, cleanupLegacyInstall} = await import('./migrate-legacy.mjs'));
  ({dataHomeFor, moveGameFolderState} = await import('./state-home.mjs'));
} catch (error) {
  note(`Loading the service's own files failed: ${error?.stack || error}`);
  writeNotesToUsualLog();
  publishFailure('install-incomplete', shortReason(error));
  process.exit(1);
}
enterStage('preparing');

// The optional packs (app/local-ai, app/omni) are looked up where the launcher started this script: under Mod Organizer 2 a pack may be its
// own MO2 mod, which the Runtime mod's real folder does not hold. A pack found only virtually is used from its real place (Python and
// llama-server read it there); one that is not installed stays under the Runtime's own app folder, as in a physical install.
function packRootsFor() {
  if (!usvfsCompat || launchedApp === appDirectory) return {};
  const roots = {};
  for (const [key, name] of [['localAi', 'local-ai'], ['omni', 'omni']]) {
    const found = usvfsCompat.locate(resolve(launchedApp, name));
    if (found.kind !== 'missing') roots[key] = found.path;
  }
  return roots;
}
const layoutFor = dataHome => installLayout({appDirectory, gameRoot, dataHome, packRoots: packRootsFor()});

// The service must see what the game sees, and this is checked before anything is written (the player's data, the restore of the state
// files and the carry-over of an older installation all come after): the launcher saw the CET mod's init.lua before it started this
// process. One that cannot see it looks at another file system than the game (with Mod Organizer 2, it runs outside the virtual file
// system), so nothing it writes in the game folder would reach the game, and a folder it made there would be a stray copy of the mod's.
// --prepare-only is a development and test aid with no game to talk to: it goes on.
if (!canReachGame && !prepareOnly) {
  note(viewLine(layoutFor(null)));
  note(`Stopped: the CET mod's init.lua (${resolve(gameRoot, MOD_FOLDER, 'init.lua')}) is not visible to this process, although the launcher saw it `
    + 'before starting the service. This process looks at a different file system than the game (with Mod Organizer 2, it runs outside the '
    + 'virtual file system), so nothing it writes in the game folder would reach the game. Nothing was started.');
  writeNotesToUsualLog();
  publishFailure('game-folder-not-visible', 'the service cannot see the game\'s mod folder');
  process.exit(3);
}

// The player's data lives outside the game folder, in %LOCALAPPDATA%\AiNpcCyberpunkMod\data (packaging/runtime/state-home.mjs): under
// Mod Organizer 2 every file created inside the game folder is redirected into its Overwrite folder. Only runtime/, which the game's
// Lua must reach, stays in the mod folder.
const early = [];
const home = dataHomeFor(process.env);
if (home.problem) early.push(home.problem);
let layout = layoutFor(home.root);

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
  if (moved?.found && moved.state === 'deferred') layout = layoutFor(null);
}

// A data folder that cannot be made (a read-only or full disk, a blocked path) ends the start; say so in the status the game reads, because
// the launcher sends this process's own output nowhere.
stateFolder = layout.state;
try { mkdirSync(layout.state, {recursive: true}); }
catch (error) {
  process.stderr.write(`Conversation service: the data folder ${layout.state} cannot be created: ${error?.message || error}
`);
  publishFailure('install-incomplete', shortReason(error));
  process.exit(1);
}
const logPath = resolve(layout.state, 'bridge-service.log');
const log = message => { try { appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`); } catch {} };
for (const message of early) log(message);
logSink = log;
for (const message of startNotes.splice(0)) log(message);

// The same facts in one line for the player's log, with the paths: the game's mod folder and its runtime/ folder are visible or not.
function viewLine(shown) {
  return `View: Node ${process.version}, PID ${process.pid}; inside a virtual file system (usvfs): ${insideVfs}${usvfsCompat ? ' (stat fallbacks on)' : ''}; `
    + `the Runtime is ${runtimeWhere} (${shown.app}${launchedApp !== appDirectory ? `, started as ${launchedApp}` : ''}); game ${shown.gameRoot}; the CET mod's init.lua is ${canReachGame ? 'visible' : 'NOT visible'}; runtime/ is `
    + `${existsSync(shown.runtime) ? 'visible' : 'not there'}.`;
}
log(viewLine(layout));
// Under Mod Organizer 2 the bundled Pythons take their virtual folder for their home; their ._pth lines become absolute real paths
// (usvfs-compat.mjs, pinPythonPaths). A problem is logged; the voices that need Python then report it themselves.
if (usvfsCompat) {
  for (const python of [layout.python, layout.omniPython]) {
    try {
      const changed = usvfsCompat.pinPythonPaths(dirname(python));
      if (changed.length) log(`Mod Organizer 2: Python's search paths pinned to its real folder (${changed.join(', ')}).`);
    } catch (error) { log(`Mod Organizer 2: Python's search paths could not be pinned (${dirname(python)}): ${error?.message || error}`); }
  }
}
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
  // What it did is kept in <state>/pack-placement.json for the setup check on the Help page; failing to write that never stops the service.
  enterStage('placing-packs');
  try {
    const placed = await placeMisplacedPacks({layout, log});
    try { await recordPlacement({state: layout.state, report: placed}); }
    catch (error) { log(`Recording the pack placement failed: ${error?.message || error}`); }
  } catch (error) { log(`Checking for misplaced pack files failed: ${error?.stack || error}`); }
  enterStage('preparing-state');
  prepared = await prepareState(layout, {log});
  if (prepared.omni) await assembleParts(layout.omni, {log});
} catch (error) {
  log(`Preparing the installation failed: ${error?.stack || error}`);
  publishFailure('install-incomplete', shortReason(error));
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
// Every Node process the service starts (the bridge and its workers) gets the same stat fallbacks before its first line runs.
if (usvfsCompat) Object.assign(env, usvfsCompat.childEnvironment(new URL('./usvfs-compat.mjs', import.meta.url).href));
if (prepareOnly) {
  const localAi = await localAiJoined;
  const cleaned = await legacyCleanup(0);
  process.stdout.write(JSON.stringify({ok: true, omni: prepared.omni, localAi: localAi.map(item => `${item.file}:${item.state}`),
    legacy: legacy?.found ? {moved: legacy.report.moved.length, errors: legacy.report.errors, removed: cleaned?.removed ?? [], pending: cleaned?.pending ?? []} : null,
    key: prepared.keyFile.startsWith(layout.state) ? 'player' : 'package', state: layout.state, app: layout.app,
    packs: {localAi: layout.localAi, omni: layout.omni}, childNodeOptions: env.NODE_OPTIONS ?? null}) + '\n');
  process.exit(0);
}
for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
Object.assign(process.env, env);

// A Runtime extracted only in part (the supervisor or a file it imports is missing) fails here. Nothing else would say so: Node's own
// error goes to the launcher's null output, and without a status the game reads the service as never started.
enterStage('loading-supervisor');
let supervisorModule;
try { supervisorModule = await import('../bridge/bridge-supervisor.mjs'); }
catch (error) {
  log(`Loading the conversation service failed: ${error?.stack || error}`);
  publishFailure('install-incomplete', shortReason(error));
  process.exit(1);
}
const {BridgeSupervisor, parseSupervisorArguments} = supervisorModule;
let options;
try {
  options = parseSupervisorArguments([...argv.filter(value => value !== '--prepare-only'),
    '--project', appDirectory, '--state', layout.state, '--key-file', prepared.keyFile], {defaultProject: appDirectory});
} catch (error) {
  log(`Supervisor arguments rejected: ${error.message}`);
  publishFailure('service-error', shortReason(error));
  process.exit(2);
}
legacyCleanup(45_000);
let supervisor;
try {
  supervisor = new BridgeSupervisor({...options, nodeExecutable: process.execPath,
    lifeline: options.lifeline === 'stdin' ? process.stdin : null});
} catch (error) {
  log(`The supervisor could not be created: ${error?.stack || error}`);
  publishFailure('service-error', shortReason(error));
  process.exit(1);
}
// From here the supervisor writes the status (its first line comes before it waits for an earlier service to let go), and answers for
// what it does; the guards of the preparation end.
stopBeat(); statusOwner = 'supervisor';
process.removeListener('uncaughtException', died);
process.removeListener('unhandledRejection', died);
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
  await supervisor.setStatus('failed', 'supervisor-error', shortReason(error)).catch(() => {});
}
process.exit(code);
