// Packaged entry point of the conversation service. From 0.3.4 the RED4ext launcher (red4ext/plugins/AiNpcCyberpunkCode/CyberpunkConvai.dll,
// shipped in the Scripts) starts the Scripts' install-code.mjs with the Runtime base's Node, which copies the Scripts' code into the Runtime's
// app/ and then runs this file in the same process as if it had been started as (an older Runtime's launcher did exactly this):
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
import {homedir} from 'node:os';
import {dirname, relative, resolve, isAbsolute} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

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
// The game this start serves. A start can outlive it (the game closed or crashed during a long first start, and the player started it
// again): the next session's launcher and start script write the same file, so a start whose game has ended publishes nothing more,
// above all not a failure the new session would show as its own. The same test as the supervisor's processAlive: a process that exists
// but cannot be opened counts as running. Without --game-pid (a start by hand) there is nothing to check.
const gamePid = Number(option('--game-pid')) || null;
const gameRunning = () => {
  if (!Number.isSafeInteger(gamePid) || gamePid <= 0) return true;
  try { process.kill(gamePid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};
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
// A full disk or a closed output never ends this process through a log line (bridge/safe-streams.mjs). The file is part of the code the Scripts
// install, so a Runtime without it only means no guard.
try { await import('../bridge/safe-streams-install.mjs'); } catch { /* the guard is an extra */ }
const canReachGame = existsSync(resolve(gameRoot, MOD_FOLDER, 'init.lua'));
const insideGame = folder => { const away = relative(resolve(gameRoot), folder); return away === '' || (!away.startsWith('..') && !isAbsolute(away)); };
// 'inside', 'outside', or 'in an MO2 mod' (started through the game folder, running from its real place elsewhere).
const runtimeAt = insideGame(appDirectory) ? 'inside' : insideGame(launchedApp) ? 'in an MO2 mod' : 'outside';
const runtimeWhere = runtimeAt === 'in an MO2 mod' ? 'in an MO2 mod folder' : `${runtimeAt} the game folder`;
const viewSummary = `usvfs ${insideVfs}${usvfsCompat ? ' (stat fallbacks on)' : ''}; Runtime ${runtimeWhere}; init.lua ${canReachGame ? 'visible' : 'not visible'}`;

// One short sentence for the game to show: Node's error code and message, every folder path cut down to its file name (a path can hold
// the player's user name, and folders with spaces in them are common), never longer than 140 characters.
// First the folders that hold the player's names (the game, the Runtime, the data home, the profile, %LOCALAPPDATA%, the temporary
// folder) are cut out wherever they appear, as paths or file:/// URLs, in any case: whatever a folder name holds, a quote or an
// apostrophe ("C:\Users\O'Brien"), none of it is left. Then any other path, from its drive, share or file:/// to where it ends,
// becomes its last name: an apostrophe ends a path only where a closing quote would (before a space, punctuation or the end), and a
// path that is not quoted runs to the end of the line, because where it ends cannot be told when a folder name has a space.
const PRIVATE_FOLDERS = (() => { try {
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = folder => folder.split(/[\\/]/).filter(Boolean).map(escape).join('[\\\\/]+');
  const folders = [gameRoot, appDirectory, process.env.CYBERPUNK_CONVAI_DATA_HOME, process.env.LOCALAPPDATA, process.env.APPDATA,
    process.env.USERPROFILE, process.env.TEMP, process.env.TMP, (() => { try { return homedir(); } catch { return null; } })()]
    .filter(folder => typeof folder === 'string' && isAbsolute(folder)).map(folder => resolve(folder))
    .filter(folder => folder.split(/[\\/]/).filter(Boolean).length >= 2);
  return [...new Set(folders)].sort((a, b) => b.length - a.length).map(folder => {
    let url = null;
    try { url = pathToFileURL(folder).href.replace(/^file:\/+/, ''); } catch {}
    const forms = [pattern(folder), ...(url ? [pattern(url)] : [])];
    return {drive: /^[A-Za-z]:/.test(folder) ? folder.slice(0, 2) : 'C:',
      match: new RegExp(`(?:file:/+)?(?:${forms.join('|')})(?=[\\\\/'"\\s]|$)`, 'gi')};
  });
} catch { return []; } })(); // this runs before the guards below: it must not be what ends the start without a word
function shortReason(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const last = path => path.split(/[\\/]/).filter(Boolean).pop() ?? '';
  let text = String(error?.message ?? error ?? '').split('\n')[0];
  // A private folder becomes its drive alone, so what follows it is still a path for the step after.
  for (const {drive, match} of PRIVATE_FOLDERS) text = text.replace(match, drive);
  text = text.replace(/(?:file:\/\/\/)?(?:[A-Za-z]:[\\/]|\\\\)(?:[^"<>|*?\r\n']|'(?![\s,.;:)\]]|$))*/g, path => last(path))
    .replace(/'([^']*[\\/][^']*)'/g, (_, path) => `'${last(path)}'`).replace(/\s+/g, ' ').trim();
  const body = code && !text.includes(code) ? `${code}: ${text}` : text;
  return (body || 'unknown error').slice(0, 140);
}

// Written in place (an existing file opened for writing stays where it is under Mod Organizer 2) and never creating the CET mod folder:
// when that folder is not there, nothing here makes it.
function publish(state, code, reason) {
  if (statusOwner !== 'service' || (prepareOnly && state !== 'failed') || !gameRunning()) return;
  try {
    const folder = dirname(statusPath);
    if (!existsSync(folder)) { if (!canReachGame) return; mkdirSync(folder, {recursive: true}); }
    const now = Date.now();
    writeFileSync(statusPath, JSON.stringify({version: 1, state, code, source: 'service', stage, ...(reason ? {reason} : {}), view: viewSummary,
      since: state === 'failed' ? now : startedAt, updated: now, supervisorPid: process.pid, bridgePid: null, adopted: false, restarts: 0,
      gamePid, gameRoot: resolve(gameRoot), ...(stateFolder ? {stateDirectory: stateFolder} : {})}));
  } catch {}
}
// While this script prepares (before the supervisor owns the file) the status is refreshed every few seconds, for five minutes at most:
// a stage that long has hung, and the status then goes stale with the stage it stopped in, which the game reports as a service that
// never came up.
const PREPARE_LIMIT_MS = 300_000;
const stopBeat = () => { if (beat) { clearInterval(beat); beat = null; } };
const startBeat = () => {
  if (prepareOnly) return;
  beat = setInterval(() => {
    if (Date.now() - startedAt > PREPARE_LIMIT_MS || !gameRunning()) stopBeat(); else publish('starting', 'service-starting');
  }, 5000);
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
// own MO2 mod, which the Runtime mod's real folder does not hold. One that is not installed stays under the Runtime's own app folder, as in a
// physical install.
//   - omni (one pack, one mod): a pack found only virtually is used from its real place; Python reads it there.
//   - local-ai: the Local AI packs and the Mature packs each unpack into app/local-ai and are usually separate MO2 mods, which USVFS merges
//     into one virtual folder. locate() would map that folder to ONE mod's real folder (the mod of the highest priority) and hide the other
//     packs' markers and models, so the bridge gets the VIRTUAL folder (its stat fallbacks list and read it merged) and maps each file a
//     manifest names to its own real place (bridge/local-ai-pack.mjs, realPathFor; llama-server and its DLLs from one real folder).
//   - stt (voice-input packs, app/models/stt/<id>): the same, with the virtual folder (bridge/local-stt.mjs resolveLocalSttPaths).
function packRootsFor() {
  if (!usvfsCompat || launchedApp === appDirectory) return {};
  const roots = {};
  for (const [key, name] of [['localAi', 'local-ai'], ['omni', 'omni']]) {
    const virtual = resolve(launchedApp, name);
    const found = usvfsCompat.locate(virtual);
    if (found.kind !== 'missing') roots[key] = key === 'localAi' ? virtual : found.path;
  }
  // The voice-input packs (app/models/stt/<id>, one mod each): the VIRTUAL folder lists every mod's <id> folders; bridge/local-stt.mjs maps each model
  // file to its real place and hands the worker the one real folder that holds the most of a model's files.
  const stt = resolve(launchedApp, 'models/stt');
  if (usvfsCompat.locate(stt).kind !== 'missing') roots.stt = stt;
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

// The player's saved state files in runtime/ (settings, phone chats, add-on settings, NPC names) come back from the copies kept in the data
// folder, wherever one is missing or empty, before anything slower and before the game's Lua can read them (bridge/game-state.mjs): under Mod
// Organizer 2 a file created in the game folder does not survive a launch. runtime/state-restore.json then tells the Lua the restore is over.
// A few stat calls when nothing needs restoring; a failure here never stops the service (the Lua stops waiting by itself after a while).
if (layout.dataHome) {
  try {
    const gameState = await import('../bridge/game-state.mjs');
    const log = message => early.push(message);
    const result = await gameState.restoreGameState({runtime: layout.runtime, durable: gameState.gameStateFolder(layout.state), log});
    await gameState.publishRestoreSignal({runtime: layout.runtime, result, log});
  } catch (error) {
    early.push(`Restoring the player's state files failed: ${error?.stack || error}`);
    try {
      mkdirSync(layout.runtime, {recursive: true});
      writeFileSync(resolve(layout.runtime, 'state-restore.json'), JSON.stringify({version: 1, state: 'done', written: Date.now(), restored: [], refreshed: [], errors: 1}));
    } catch {}
  }
}

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
// What the Scripts' install-code.mjs did before it ran this script (from 0.3.4 it starts the service: docs/PACKAGING.md, "Code in the Scripts").
for (const message of globalThis[Symbol.for('ai-npc-cyberpunk-mod.install-code')] ?? []) log(message);

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
  // Files the game folder holds that MO2 hides behind another copy (an older install's placeholders under a copy in a mod or in Overwrite):
  // stat now asks the file the process can open, so nothing is skipped; the line tells a support report which copies are doubled.
  try {
    const doubled = usvfsCompat.shadowedFiles(layout.runtime);
    if (doubled.length) log(`Mod Organizer 2: ${doubled.length} file(s) of runtime/ exist twice, a copy in the game folder and another in front of it in MO2's view (a mod or Overwrite): ${doubled.slice(0, 12).join(', ')}${doubled.length > 12 ? ', ...' : ''}.`);
  } catch (error) { log(`Mod Organizer 2: the check for doubled files of runtime/ failed: ${error?.message || error}`); }
  // Where each Local AI pack file really is (several packs may be separate MO2 mods merged into one folder), for the report.
  try {
    const {packPlaceLines} = await import('../bridge/local-ai-pack.mjs');
    const lines = packPlaceLines({environment: {CYBERPUNK_CONVAI_LOCAL_AI: layout.localAi, CYBERPUNK_CONVAI_USVFS: '1'}});
    if (lines.length) log(`Mod Organizer 2: Local AI pack files, where each really is (${layout.localAi}):\n  ${lines.join('\n  ')}`);
  } catch (error) { log(`Mod Organizer 2: locating the Local AI pack files failed: ${error?.message || error}`); }
  // And the voice-input packs: the virtual folder the bridge reads (CYBERPUNK_CONVAI_STT_PACKS) and the real folder each model is run from.
  try {
    if (layout.sttPacks) {
      const [{resolveLocalSttPaths}, {LOCAL_PACKS}] = await Promise.all([import('../bridge/local-stt.mjs'), import('../bridge/speech-language.mjs')]);
      const lines = [];
      for (const pack of LOCAL_PACKS) {
        const {modelDirectory, place} = resolveLocalSttPaths({project: layout.app, environment: {CYBERPUNK_CONVAI_STT_PACKS: layout.sttPacks, CYBERPUNK_CONVAI_USVFS: '1'}, engine: pack});
        if (place?.count) lines.push(`${pack.id}: ${modelDirectory} (${place.count === place.of ? `all ${place.of} files` : `${place.count} of ${place.of} files; the model is not complete in one folder`})`);
      }
      if (lines.length) log(`Mod Organizer 2: voice-input pack models, where each runs from (${layout.sttPacks}):\n  ${lines.join('\n  ')}`);
    }
  } catch (error) { log(`Mod Organizer 2: locating the voice-input packs failed: ${error?.message || error}`); }
}
// The files a Runtime update no longer ships are removed here (packaging/runtime/apply-removals.mjs): the update zip is extracted over
// the old Runtime and cannot delete, so it carries app/defaults/runtime-removals.json (every Runtime does, the full one too). It runs from
// this process's own place, so under Mod Organizer 2 it deletes inside the Runtime's mod folder. A handful of stat calls when the list is
// empty, a time budget when it is not, one log line per start; a problem is logged and never stops the start (nor does a missing module).
let removals = null;
try {
  const {applyRuntimeRemovals} = await import('./apply-removals.mjs');
  removals = applyRuntimeRemovals({appDirectory, log});
} catch (error) { log(`Removing the files an update no longer ships failed: ${error?.stack || error}`); }
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

// The game a package was built for (release.json "game"); a release.json from before there was a build per game is the 2.31 build.
function readGame(path) {
  try { const game = JSON.parse(readFileSync(path, 'utf8')).game; return typeof game === 'string' && game.trim() ? game.trim() : '2.31'; } catch { return null; }
}

let prepared;
try {
  const runtimeVersion = readVersion(resolve(appDirectory, 'release.json'));
  const scriptsRelease = (() => { try { return JSON.parse(readFileSync(resolve(layout.mod, 'release.json'), 'utf8')); } catch { return null; } })();
  const scriptsVersion = scriptsRelease?.version ?? null;
  // From 0.3.4 the code comes with the Scripts (install-code.mjs copies it into app/ and lists it in defaults/scripts-code.json) and the Runtime is
  // the base: its release.json is the base's version, which must be at least the Scripts' runtimeBase. Before, the two versions had to be equal.
  const code = (() => { try { return JSON.parse(readFileSync(resolve(appDirectory, 'defaults', 'scripts-code.json'), 'utf8')); } catch { return null; } })();
  log(`Conversation service ${code?.release ?? runtimeVersion ?? '(unknown version)'} preparing ${layout.gameRoot}; player data in ${layout.state}`
    + `${code ? `; Runtime base ${runtimeVersion ?? '(unknown)'}` : ''}.`);
  if (scriptsRelease?.runtimeBase) {
    if (code?.release !== scriptsVersion) log(`Warning: the Scripts package is ${scriptsVersion} but the code installed in the Runtime is ${code?.release ?? 'none'}. The Scripts' launcher installs it at the start; see the line about the code copy above.`);
    const parts = value => String(value ?? '').split(/[-+]/)[0].split('.').map(part => Number.parseInt(part, 10) || 0);
    const older = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < Math.max(x.length, y.length); i += 1) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0); } return false; };
    if (runtimeVersion && older(runtimeVersion, scriptsRelease.runtimeBase)) {
      log(`Warning: the Scripts ${scriptsVersion} need the Runtime base ${scriptsRelease.runtimeBase} or newer, and this Runtime is ${runtimeVersion}. Install the full install zip (AI-Companions-LLM).`);
    }
  } else if (scriptsVersion && runtimeVersion && scriptsVersion !== runtimeVersion) {
    log(`Warning: the Scripts package is ${scriptsVersion} but the Runtime package is ${runtimeVersion}. Install matching versions.`);
  }
  const runtimeGame = readGame(resolve(appDirectory, 'release.json')), scriptsGame = readGame(resolve(layout.mod, 'release.json'));
  if (runtimeGame && scriptsGame && runtimeGame !== scriptsGame) {
    log(`Warning: the Scripts package is the build for game ${scriptsGame} but the Runtime package is the build for game ${runtimeGame}. Install the two made for the same game.`);
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

const env = serviceEnvironment(layout, {...prepared, usvfs: Boolean(usvfsCompat)});
// The player's own choice of browser: browser.txt in the plugin folder beside launcher.ini names a Chromium program installed where no
// lookup finds it (bridge/system-browser.mjs). It feeds the same setting as a developer's CYBERPUNK_CONVAI_BROWSER, which wins when both
// are set. A file that names nothing usable is said so once in the log and the usual lookup goes on. One small read; a failure never stops the start.
try {
  const {readBrowserOverride, BROWSER_OVERRIDE_FILE} = await import('../bridge/system-browser.mjs');
  const choice = readBrowserOverride([resolve(launchedApp, '..'), resolve(appDirectory, '..')]);
  if (choice && env.CYBERPUNK_CONVAI_BROWSER) log(`${BROWSER_OVERRIDE_FILE} is not used: CYBERPUNK_CONVAI_BROWSER is set.`);
  else if (choice?.path) { env.CYBERPUNK_CONVAI_BROWSER = choice.path; log(`Browser from ${BROWSER_OVERRIDE_FILE}: ${choice.path}`); }
  else if (choice) log(`${choice.problem}. Looking for a browser the usual way instead.`);
} catch (error) { log(`Reading the browser file failed: ${error?.message || error}`); }
// Every Node process the service starts (the bridge and its workers) gets the same stat fallbacks before its first line runs.
// The file they import it from is a copy in the data folder, outside the game folder (usvfsCompat.stageChildImport): a Runtime written into the game folder under
// MO2 lies in Overwrite, which a child's own `--import` cannot stat (report c44c3c95). Without a data folder of its own, or when the copy fails, the Runtime's file is used.
if (usvfsCompat) {
  const own = new URL('./usvfs-compat.mjs', import.meta.url).href;
  const staged = layout.dataHome ? usvfsCompat.stageChildImport(layout.state, own) : null;
  log(staged ? 'The Mod Organizer 2 fallbacks for the service\'s Node processes are imported from the data folder, outside the game folder.'
    : 'The Mod Organizer 2 fallbacks for the service\'s Node processes are imported from the Runtime\'s own launcher folder.');
  Object.assign(env, usvfsCompat.childEnvironment(staged ?? own));
}
if (prepareOnly) {
  const localAi = await localAiJoined;
  const cleaned = await legacyCleanup(0);
  process.stdout.write(JSON.stringify({ok: true, omni: prepared.omni, localAi: localAi.map(item => `${item.file}:${item.state}`),
    legacy: legacy?.found ? {moved: legacy.report.moved.length, errors: legacy.report.errors, removed: cleaned?.removed ?? [], pending: cleaned?.pending ?? []} : null,
    removals: removals ? {state: removals.state, version: removals.version, removed: removals.removed, absent: removals.absent, refused: removals.refused,
      failed: removals.failed, left: removals.left} : null,
    key: 'player', state: layout.state, app: layout.app,
    packs: {localAi: layout.localAi, omni: layout.omni, ...(layout.sttPacks ? {stt: layout.sttPacks} : {})}, childNodeOptions: env.NODE_OPTIONS ?? null,
    browser: env.CYBERPUNK_CONVAI_BROWSER ?? null}) + '\n');
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
const {BridgeSupervisor, RUNTIME_REQUIRED_FILES, parseSupervisorArguments} = supervisorModule;
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
    lifeline: options.lifeline === 'stdin' ? process.stdin : null, errorReports: true, requiredFiles: RUNTIME_REQUIRED_FILES});
} catch (error) {
  log(`The supervisor could not be created: ${error?.stack || error}`);
  publishFailure('service-error', shortReason(error));
  process.exit(1);
}
// From here the supervisor writes the status (at once when it holds the lock, after 5 s when it waits for an earlier service to let go),
// and answers for what it does; the guards of the preparation end.
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
