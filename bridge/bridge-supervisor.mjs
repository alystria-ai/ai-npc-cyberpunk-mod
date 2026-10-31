// Owns the conversation bridge for one game session. Started hidden by the
// RED4ext launcher (native/autostart) when the game starts, it:
//   - starts the bridge once, or uses a bridge that is already running;
//   - restarts the bridge after a crash, with backoff and a crash limit;
//   - leaves the bridge stopped after an explicit Stop-ConversationBridge.ps1;
//   - stops the bridge gracefully when the game exits (lifeline EOF or PID);
//   - publishes runtime/bridge-service.json in the mod folder so the game can
//     explain a missing or starting service instead of waiting silently.
// It never kills a process it did not start. The bridge keeps its existing
// protocol: the ready line on stdout and PID-addressed bridge-control.json.
import {spawn as spawnProcess, execFile} from 'node:child_process';
import {appendFileSync, closeSync, constants, fstatSync, ftruncateSync, openSync, readFileSync, readSync,
  renameSync, statSync, writeSync} from 'node:fs';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname, isAbsolute, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {atomicFile} from './guarded-file.mjs';
import {REPORT_FOLDER, collectCrashInfo, crashLogLines, exitCodeWords, prepareReportFolder, reportArguments} from './bridge-diagnostics.mjs';
import {endedFromOutsideCode} from './voice-failures.mjs';
import {capLogFile} from './log-cap.mjs';
import {CHILDREN_FILE, reapChildren} from './child-registry.mjs';
import {parseKeyFileText} from './convai-key.mjs';
import {AUTH_CONFIG_FILE, PACKAGED_AUTH_FILE, readAuthSettings} from './convai-credential.mjs';
import {readTurnPriority, setProcessPriority} from './process-priority.mjs';
import {NO_BROWSER_MESSAGE, browserLookupSummary, systemBrowserAvailable} from './system-browser.mjs';
import {INCOMPLETE_EXIT_CODE, incompleteMessage, mismatchMessage, missingModuleInLog, missingRuntimeFiles, versionMismatchInLog,
  USVFS_COMPAT_FILE, USVFS_FILE_REASON, usvfsFileMessage} from './runtime-files.mjs';
// For the entry points (scripts/Supervise-ConversationBridge.mjs, the packaged start-service.mjs): what they pass as `requiredFiles`.
export {RUNTIME_DATA_FILES, RUNTIME_PACKAGE_FILES, RUNTIME_REQUIRED_FILES} from './runtime-files.mjs';

export const READY_MARKER = '[CyberpunkConvai] Convai conversation bridge ready';
export const MOD_RUNTIME = 'bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod/runtime';
// libuv opens a file with no sharing for this flag (Windows only). The lock is
// released by the kernel when the holder exits, so a crash never leaves it stale.
const EXCLUSIVE = process.platform === 'win32' ? (constants.UV_FS_O_EXLOCK ?? 0x10000000) : 0;

// The Mod Organizer 2 stat fallbacks the packaged start script named (app/launcher/usvfs-compat.mjs, childEnvironment): a file URL
// of that one module, and only when the start script found usvfs in its own process. Anything else is never loaded into the bridge.
export function usvfsCompatImport(env) {
  const url = env.CYBERPUNK_CONVAI_USVFS_IMPORT;
  return env.CYBERPUNK_CONVAI_USVFS === '1' && typeof url === 'string' && /^file:\/\/\/[^\s"']+\/launcher\/usvfs-compat\.mjs$/i.test(url) ? url : null;
}

export const DEFAULT_TIMINGS = Object.freeze({
  pollMs: 250, gamePollMs: 1000, heartbeatMs: 5000, readyTimeoutMs: 180_000,
  shutdownGraceMs: 45_000, shutdownRepeatMs: 2000, killWaitMs: 10_000,
  crashWindowMs: 600_000, maxCrashes: 5, backoffMs: [2000, 5000, 10_000, 20_000, 30_000],
  crashCooldownMs: 180_000, adoptFreshMs: 15_000, adoptCheckMs: 5000, setupRetryMs: 10_000, lockRetryMs: 1000, lockStatusAfterMs: 5000,
  buildTimeoutMs: 180_000, logLimitBytes: 1_000_000,
  // The bridge's stdout and stderr files are cut back to their last bridgeLogKeepBytes when they pass bridgeLogMaxBytes; the service log to half
  // of logLimitBytes when it passes it. Looked at every logCheckMs (bridge/log-cap.mjs): a long session or a restart loop no longer grows them.
  logCheckMs: 300_000, bridgeLogMaxBytes: 6_000_000, bridgeLogKeepBytes: 3_000_000,
});

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function killProcessTree(pid) {
  return new Promise(done => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'],
    {windowsHide: true, timeout: 15_000}, () => done()));
}

const describeExit = exit => exit?.error ? `launch error: ${exit.error}`
  : exit?.signal ? `signal ${exit.signal}` : exit?.adopted ? 'process ended' : `exit code ${exit?.code}`;

export function parseSupervisorArguments(argv, {defaultProject, env = process.env} = {}) {
  const values = {'--project': 'project', '--state': 'stateDirectory', '--key-file': 'keyFile',
    '--game-root': 'gameRoot', '--game-pid': 'gamePid', '--lifeline': 'lifeline', '--node': 'nodeExecutable'};
  const result = {buildVoiceClient: false, unknown: []};
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === '--build-voice-client') { result.buildVoiceClient = true; continue; }
    const name = values[option];
    if (!name || index + 1 >= argv.length) { result.unknown.push(option); continue; }
    result[name] = argv[++index];
  }
  result.project = resolve(result.project || defaultProject);
  result.stateDirectory = resolve(result.stateDirectory || env.CYBERPUNK_CONVAI_STATE || resolve(result.project, 'runtime'));
  result.keyFile = resolve(result.keyFile || env.CYBERPUNK_CONVAI_KEY_FILE || resolve(result.stateDirectory, 'convai-key.txt'));
  const game = result.gameRoot || env.CYBERPUNK_CONVAI_GAME;
  if (!game || !isAbsolute(game)) throw Error('Pass the absolute game directory with --game-root.');
  result.gameRoot = resolve(game);
  if (result.gamePid !== undefined) {
    const pid = Number(result.gamePid);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('--game-pid must be a process ID.');
    result.gamePid = pid;
  }
  if (result.lifeline !== undefined && result.lifeline !== 'stdin') throw Error('--lifeline only supports stdin.');
  return result;
}

// Wine's own stand-in for a default browser is what the lookup reports on a Windows game run on Linux or the Steam Deck (Proton): its prefix has no browser,
// and the hidden one plays every voice and hears the microphone, so the service stops there (26 Oct: every browser-missing report of 0.3.2 was such a prefix).
const WINE_BROWSER_MESSAGE = 'This looks like Wine or Proton (Linux, Steam Deck): there is no Windows browser in the game prefix, and the mod needs one for sound and the microphone. Install Chrome or Edge into the prefix and write its path in a browser.txt file in the red4ext/plugins/AiNpcCyberpunkMod folder of the game (no launcher.ini is needed).';

export class BridgeSupervisor {
  constructor({project, stateDirectory, keyFile, gameRoot, gamePid = null, lifeline = null,
    buildVoiceClient = false, nodeExecutable = process.execPath, spawn = spawnProcess,
    alive = processAlive, killTree = killProcessTree, now = Date.now, sleep = delay,
    browserAvailable = systemBrowserAvailable, browserReport = browserLookupSummary, timings = {}, errorReports = false,
    // requiredFiles: files (relative to `project`) the bridge cannot start without: its data files and the files of the Node packages it
    // imports (bridge/runtime-files.mjs RUNTIME_REQUIRED_FILES); the entry points of a real install pass them. One that is missing is the
    // failure `install-incomplete`, not a bridge that crashes five times.
    requiredFiles = [],
    // The bridge runs at HIGH priority (docs/PROCESS_PRIORITY.md): it is the conversation service every reply passes through. `priority` is the level (normally read from the
    // state folder's priority.txt at each start); the child is set here and the bridge sets itself too. A test's stand-in child is never handed to the system call.
    priority = null, setPriority = spawn === spawnProcess ? undefined : () => { /* a stand-in child has no process */ }} = {}) {
    Object.assign(this, {project, stateDirectory, keyFile, gameRoot, gamePid, lifeline,
      buildVoiceClient, nodeExecutable, spawn, alive, killTree, now, sleep, browserAvailable, browserReport, errorReports, requiredFiles, priority, setPriority});
    this.timings = {...DEFAULT_TIMINGS, ...timings};
    this.entry = resolve(project, 'bridge/convai-bridge.mjs');
    this.paths = {
      status: resolve(gameRoot, MOD_RUNTIME, 'bridge-service.json'),
      voiceState: resolve(gameRoot, MOD_RUNTIME, 'local-voice-state.json'),
      control: resolve(stateDirectory, 'bridge-control.json'),
      lock: resolve(stateDirectory, 'bridge-supervisor.lock'),
      log: resolve(stateDirectory, 'bridge-service.log'),
      stdout: resolve(stateDirectory, 'bridge.stdout.log'),
      stderr: resolve(stateDirectory, 'bridge.stderr.log'),
      pid: resolve(stateDirectory, 'bridge.pid'),
    };
    this.watchingGame = !!(gamePid || lifeline);
    this.mode = 'idle'; this.status = null; this.restarts = 0; this.crashes = [];
    this.child = null; this.childPid = null; this.childExit = null; this.adoptedPid = null;
    this.ready = false; this.stopRequested = false; this.ownNonces = new Set(); this.retiredPids = new Set();
    this.exitReason = null; this.lifelineEnded = false; this.built = false; this.logsRotated = false;
    this.lastGameProbe = -Infinity; this.lastStatusWrite = -Infinity; this.lastDormantCheck = -Infinity; this.lastLogCheck = -Infinity;
    this.lastSetupCheck = -Infinity; this.retrySetup = false; this.lockFd = null; this.reporter = null;
  }

  log(message) {
    try { appendFileSync(this.paths.log, `${new Date(this.now()).toISOString()} ${message}\n`); } catch {}
  }

  requestExit(reason = 'supervisor-stopped') { this.exitReason ||= reason; }

  gameGone() {
    if (this.exitReason) return true;
    if (this.lifelineEnded) { this.exitReason = 'game-exited'; return true; }
    if (this.gamePid && this.now() - this.lastGameProbe >= this.timings.gamePollMs) {
      this.lastGameProbe = this.now();
      if (!this.alive(this.gamePid)) { this.exitReason = 'game-exited'; return true; }
    }
    return false;
  }

  watchLifeline() {
    if (!this.lifeline) return;
    const ended = () => {
      if (this.lifelineEnded) return;
      this.lifelineEnded = true; this.log('The game process ended (lifeline closed).');
    };
    this.lifeline.on('end', ended); this.lifeline.on('close', ended); this.lifeline.on('error', ended);
    this.lifeline.on('data', () => {}); this.lifeline.resume?.();
  }

  async run() {
    await mkdir(this.stateDirectory, {recursive: true});
    try { if (statSync(this.paths.log).size > this.timings.logLimitBytes) renameSync(this.paths.log, `${this.paths.log}.previous`); } catch {}
    this.log(`Supervisor ${process.pid} started for game ${this.gamePid ?? '(not watched)'} in ${this.gameRoot}.`);
    this.watchLifeline();
    if (!await this.acquireLock()) {
      this.log('The game ended before the previous service released its lock; nothing started.');
      return {state: 'not-started'};
    }
    try {
      await mkdir(dirname(this.paths.status), {recursive: true}).catch(() => {});
      this.lastControlRaw = await this.readControl();
      await this.setStatus('starting', 'supervisor-started');
      this.startHeartbeat();
      await this.startErrorReports();
      while (!this.gameGone() && this.mode !== 'done') {
        await this.step();
        if (this.gameGone() || this.mode === 'done') break;
        await this.sleep(this.timings.pollMs);
      }
      if (this.mode !== 'done') await this.shutdownForGameExit();
      return {state: this.status?.state, code: this.status?.code};
    } finally {
      clearInterval(this.heartbeat);
      await this.statusWriting?.catch(() => {});
      // A report being sent gets a moment to finish; anything still queued goes out at the next game start.
      if (this.reporter) { await this.reporter.idle(3000).catch(() => {}); this.reporter.close(); }
      if (this.lockFd !== null) { try { closeSync(this.lockFd); } catch {} this.lockFd = null; }
      this.log(`Supervisor ${process.pid} finished.`);
    }
  }

  // The lock is released by the kernel when its holder exits, so waiting for it ends when the previous session's supervisor is gone. The
  // wait used to be silent, and a start that waited for a holder that never let go left the game with the launcher's "starting" for good.
  // A wait that lasts past lockStatusAfterMs (an earlier session stopping its bridge takes a few seconds, not longer) publishes a status
  // of its own, kept fresh by the heartbeat, so the game sees a service that is alive and what it is waiting for.
  async acquireLock() {
    let announced = false, waitingSince = null, published = false;
    for (;;) {
      try {
        this.lockFd = openSync(this.paths.lock, constants.O_RDWR | constants.O_CREAT | EXCLUSIVE);
        try { ftruncateSync(this.lockFd, 0); writeSync(this.lockFd, `${process.pid}\n`); } catch {}
        return true;
      } catch (error) {
        if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        if (this.gameGone()) { clearInterval(this.heartbeat); this.heartbeat = null; return false; }
        if (!announced) {
          announced = true; waitingSince = this.now();
          this.log('Another supervisor still owns the bridge (for example, still stopping the previous game session). Waiting for it.');
        }
        if (!published && this.now() - waitingSince >= this.timings.lockStatusAfterMs) {
          published = true;
          this.log('Still waiting for the earlier supervisor to let go of the bridge.');
          await mkdir(dirname(this.paths.status), {recursive: true}).catch(() => {});
          await this.setStatus('starting', 'waiting-for-previous-service');
          this.startHeartbeat();
        }
        await this.sleep(this.timings.lockRetryMs);
      }
    }
  }

  // Automatic error reports (bridge/error-reports.mjs, docs/ERROR_REPORTS.md), for the packaged and development entry points that ask
  // for them. Loaded here, after the status is written, so a problem in that module can never stop the service; it sends off the turn
  // path, from this process, and outlives a crashed bridge.
  async startErrorReports() {
    if (!this.errorReports || this.reporter) return;
    try {
      const {ErrorReporter} = await import('./error-reports.mjs');
      this.reporter = new ErrorReporter({game: this.gameRoot, runtime: dirname(this.paths.status), stateDirectory: this.stateDirectory,
        project: this.project, log: message => this.log(message)}).start();
    } catch (error) { this.log(`Error reports are unavailable: ${error?.message ?? error}`); }
  }

  reportEvent(event) {
    if (this.reporter) void this.reporter.record(event).catch(() => {});
  }

  // The three logs are cut back when they have grown past their cap, at most every logCheckMs (a stat and, only when over, one small rewrite).
  capLogsWhenDue() {
    if (this.now() - this.lastLogCheck < this.timings.logCheckMs) return;
    this.lastLogCheck = this.now();
    const cap = this.timings.bridgeLogMaxBytes, keep = this.timings.bridgeLogKeepBytes;
    for (const path of [this.paths.stdout, this.paths.stderr]) capLogFile(path, {maxBytes: cap, keepBytes: keep});
    capLogFile(this.paths.log, {maxBytes: this.timings.logLimitBytes, keepBytes: Math.floor(this.timings.logLimitBytes / 2)});
  }

  async step() {
    this.capLogsWhenDue();
    await this.pollControl();
    if (this.mode === 'idle') return this.decide();
    if (this.mode === 'running') return this.checkRunning();
    if (this.mode === 'adopted') return this.checkAdopted();
    if (this.mode === 'backoff') { if (this.now() >= this.backoffUntil) this.mode = 'idle'; return; }
    if (this.mode === 'stopped' || this.mode === 'failed') return this.checkDormant();
  }

  async decide() {
    const existing = await this.findServingBridge();
    if (existing) return this.adopt(existing);
    const setup = await this.preflight();
    if (setup) {
      this.retrySetup = true;
      if (setup === 'browser-missing') {
        this.log(NO_BROWSER_MESSAGE);
        // What the lookup had to go on, once per supervisor (it reads the registry), so a report of this failure says why no browser was found.
        if (!this.browserReported) {
          this.browserReported = true;
          try {
            const summary = this.browserReport();
            this.log(summary);
            if (/winebrowser\.exe/i.test(String(summary))) this.log(WINE_BROWSER_MESSAGE);
          } catch { /* a diagnostic never changes the failure */ }
        }
      }
      // Said once, not on every retry: the names of the files (never a folder) that are not there.
      if (setup === 'install-incomplete' && this.status?.code !== setup) this.log(incompleteMessage(this.missingFiles ?? []));
      return this.fail(setup);
    }
    if (this.buildVoiceClient && !this.built) {
      await this.setStatus('starting', 'building-voice-client');
      const built = await this.build();
      if (this.gameGone()) return;
      if (!built) { this.retrySetup = false; return this.fail('voice-client-build-failed'); }
      this.built = true;
      const appeared = await this.findServingBridge();
      if (appeared) return this.adopt(appeared);
    }
    return this.launch();
  }

  // A bridge serving this game publishes its PID in local-voice-state.json every
  // five seconds. A fresh, live entry means it is already running (for example,
  // started by hand); the supervisor uses it instead of starting a second one.
  async findServingBridge() {
    let state;
    try { state = JSON.parse(await readFile(this.paths.voiceState, 'utf8')); } catch { return null; }
    const pid = state?.bridgePid;
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || pid === this.childPid
        || this.retiredPids.has(pid)) return null;
    if (!Number.isFinite(state.updated) || Math.abs(this.now() - state.updated) > this.timings.adoptFreshMs) return null;
    if (state.state === 'stopped' || !this.alive(pid)) return null;
    return pid;
  }

  async adopt(pid) {
    this.adoptedPid = pid; this.mode = 'adopted'; this.stopRequested = false; this.retrySetup = false;
    this.log(`Using the conversation bridge that is already running (PID ${pid}); no second bridge started.`);
    await this.setStatus('ready', 'existing-bridge');
  }

  // Whether Convai conversations have a credential to start from: a plain `api-key=...` file (a developer's own key; the format is checked, the
  // key itself is never logged or published), or the sign-in backend switched on (a release ships it on, with no key at all: app/defaults/
  // convai-auth.json; bridge/convai-credential.mjs readAuthSettings, the same reading the bridge does). A key a release before 0.2.9 packed
  // into the state folder is not a plain key and does not count.
  async hasCredential() {
    let plain = false;
    try {
      const info = await stat(this.keyFile);
      plain = info.isFile() && info.size <= 4096 && parseKeyFileText(await readFile(this.keyFile, 'utf8')) !== null;
    } catch { /* none */ }
    if (plain) return true;
    try {
      return (await readAuthSettings({path: resolve(this.stateDirectory, AUTH_CONFIG_FILE), packagedPath: resolve(this.project, PACKAGED_AUTH_FILE)})).enabled;
    } catch { return false; }
  }

  async preflight() {
    if (!await this.hasCredential()) return 'missing-key';
    try {
      const ids = JSON.parse(await readFile(resolve(this.stateDirectory, 'characters.json'), 'utf8'));
      if (!ids || typeof ids !== 'object' || Array.isArray(ids)) return 'missing-character-ids';
    } catch { return 'missing-character-ids'; }
    try { await stat(this.entry); } catch { return 'bridge-missing'; }
    // A Runtime extracted only partly has the bridge's code but not all of its data: the game says so ("The Runtime is incomplete") and the
    // check is repeated until the file is back (retrySetup), instead of a bridge that dies on it five times.
    if (this.requiredFiles.length) {
      this.missingFiles = await missingRuntimeFiles(this.project, this.requiredFiles);
      if (this.missingFiles.length) return 'install-incomplete';
    }
    // The conversation page runs in an installed Chromium browser (Edge, Chrome, Brave, Opera and others), which the mod does not ship
    // (bridge/system-browser.mjs looks in the usual folders and the registry, once per start).
    try { if (!this.browserAvailable()) return 'browser-missing'; } catch {}
    return null;
  }

  bridgeEnvironment() {
    const env = {...process.env, CYBERPUNK_CONVAI_STATE: this.stateDirectory,
      CYBERPUNK_CONVAI_KEY_FILE: this.keyFile, CYBERPUNK_CONVAI_GAME: this.gameRoot};
    // An inherited debugger or import hook must not reach the service.
    delete env.NODE_OPTIONS; delete env.NODE_PATH;
    // The one exception: under Mod Organizer 2 the packaged start script asks for its stat fallbacks (app/launcher/usvfs-compat.mjs)
    // in every Node process it starts, so the bridge and its workers see the files that exist only in an MO2 mod folder.
    const compat = usvfsCompatImport(env);
    if (compat) env.NODE_OPTIONS = `--import=${compat}`;
    return env;
  }

  build() {
    const script = resolve(this.project, 'scripts/Build-VoiceClient.mjs');
    this.log('Rebuilding the voice client bundle.');
    return new Promise(done => {
      let settled = false, output = '';
      const finish = (ok, note) => {
        if (settled) return; settled = true; clearTimeout(timer);
        this.log(`Voice client build ${ok ? 'finished' : 'failed'}: ${note}`); done(ok);
      };
      let child;
      try {
        child = this.spawn(this.nodeExecutable, [script, '--project', this.project], {cwd: this.project,
          env: this.bridgeEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
      } catch (error) { finish(false, error.message); return; }
      const collect = data => { output = (output + data).slice(-2000); };
      child.stdout?.on('data', collect); child.stderr?.on('data', collect);
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish(false, 'timed out'); },
        this.timings.buildTimeoutMs);
      child.once('error', error => finish(false, error.message));
      child.once('close', code => finish(code === 0, output.trim().split(/\r?\n/).slice(-2).join(' | ') || `exit ${code}`));
    });
  }

  rotateLogs() {
    for (const path of [this.paths.stdout, this.paths.stderr]) {
      try { if (statSync(path).size > 0) renameSync(path, path.replace(/\.log$/, '.previous.log')); } catch {}
    }
  }

  async launch() {
    if (!this.logsRotated) { this.rotateLogs(); this.logsRotated = true; }
    let out, err, child;
    try {
      out = openSync(this.paths.stdout, 'a'); err = openSync(this.paths.stderr, 'a');
      this.readyScan = {offset: fstatSync(out).size, tail: ''};
      // The marker line is an extra: on a full disk it fails (ENOSPC) and the bridge must still start (error report 1cbe337a5144ebbd).
      try { writeSync(err, `--- bridge started by the conversation service supervisor at ${new Date(this.now()).toISOString()} ---\n`); } catch { /* no marker */ }
      // Node writes a diagnostic report into <data>/node-reports when the bridge hits a fatal error or an uncaught exception (the supervisor
      // reads the newest one if the bridge ends unexpectedly, bridge/bridge-diagnostics.mjs). Costs nothing until one of those happens.
      const reports = resolve(this.stateDirectory, REPORT_FOLDER);
      prepareReportFolder(reports, {now: this.now()});
      child = this.spawn(this.nodeExecutable, [...reportArguments(reports, {nodeExecutable: this.nodeExecutable}), this.entry], {cwd: this.project, env: this.bridgeEnvironment(),
        windowsHide: true, stdio: ['ignore', out, err]});
    } catch (error) {
      this.log(`The bridge could not be started: ${error.message}`);
      this.childExit = {code: null, error: error.message}; this.childPid = null;
      return this.onBridgeExit(null, this.childExit);
    } finally {
      if (out !== undefined) closeSync(out);
      if (err !== undefined) closeSync(err);
    }
    this.child = child; this.childPid = child.pid ?? null; this.childExit = null;
    this.prioritize(child.pid);
    child.once('error', error => { this.childExit ||= {code: null, error: error.message}; });
    child.once('exit', (code, signal) => { this.childExit ||= {code, signal}; });
    this.ready = false; this.stopRequested = false; this.launchedAt = this.now(); this.mode = 'running';
    if (!this.childPid) return;
    await writeFile(this.paths.pid, `${this.childPid}\n`).catch(() => {});
    this.log(`Started the bridge (PID ${this.childPid}).`);
    await this.setStatus(this.restarts ? 'restarting' : 'starting', this.restarts ? 'bridge-restarting' : 'bridge-starting');
  }

  // The bridge's priority class (docs/PROCESS_PRIORITY.md): high in play, unless the state folder's priority.txt says normal. NOT at its start: the game is on its title screen then,
  // loading with every core busy and its main thread waiting for the key press, and the service spends its first seconds importing modules; High there can starve the title
  // (27 Oct 2026). So the child is left at normal here and takes High itself when the game has a world (bridge/convai-bridge.mjs, bridge/process-priority.mjs PriorityGate).
  // Logged once per start so the supervisor log shows the level it was given. Best effort.
  prioritize(pid) {
    try {
      const level = this.priority ?? readTurnPriority({stateDirectory: this.stateDirectory}).level;
      if (level !== 'high' || !pid) return;
      this.log('The bridge starts at normal priority and takes high priority itself once the game has a world.');
    } catch { /* a priority is an optimisation, never a failure */ }
  }

  // What the bridge wrote to its stderr since its last start (at most 24 KB, from the supervisor's own start line on), or ''.
  bridgeErrorText() {
    let fd;
    try {
      fd = openSync(this.paths.stderr, 'r');
      const size = fstatSync(fd).size, length = Math.min(size, 24_576);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const text = buffer.toString('utf8'), at = text.lastIndexOf('--- bridge started by the conversation service supervisor');
      return at >= 0 ? text.slice(at) : text;
    } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
  }

  scanReady() {
    let fd;
    try {
      fd = openSync(this.paths.stdout, 'r');
      const size = fstatSync(fd).size;
      if (size < this.readyScan.offset) this.readyScan.offset = 0;
      while (this.readyScan.offset < size) {
        const buffer = Buffer.alloc(Math.min(65536, size - this.readyScan.offset));
        const read = readSync(fd, buffer, 0, buffer.length, this.readyScan.offset);
        if (read <= 0) break;
        this.readyScan.offset += read;
        const text = this.readyScan.tail + buffer.toString('utf8', 0, read);
        if (text.includes(READY_MARKER)) return true;
        this.readyScan.tail = text.slice(-READY_MARKER.length);
      }
    } catch {} finally { if (fd !== undefined) closeSync(fd); }
    return false;
  }

  async checkRunning() {
    if (this.childExit) return this.onBridgeExit(this.childPid, this.childExit);
    if (this.ready) return;
    if (this.scanReady()) {
      this.ready = true;
      this.log(`The bridge is ready (PID ${this.childPid}).`);
      return this.setStatus('ready', 'bridge-ready');
    }
    if (this.now() - this.launchedAt > this.timings.readyTimeoutMs) {
      this.log(`The bridge did not report ready within ${Math.round(this.timings.readyTimeoutMs / 1000)} s; restarting it.`);
      await this.stopOwnBridge();
    }
  }

  async checkAdopted() {
    if (this.alive(this.adoptedPid)) return;
    return this.onBridgeExit(this.adoptedPid, {adopted: true});
  }

  async checkDormant() {
    if (this.now() - this.lastDormantCheck >= this.timings.adoptCheckMs) {
      this.lastDormantCheck = this.now();
      const existing = await this.findServingBridge();
      if (existing) return this.adopt(existing);
    }
    if (this.mode === 'failed' && this.retrySetup && this.now() - this.lastSetupCheck >= this.timings.setupRetryMs) {
      this.lastSetupCheck = this.now();
      if (!await this.preflight()) { this.log('Setup is complete now; starting the bridge.'); this.mode = 'idle'; }
    }
    // A crash loop is retried rarely, so a transient cause (such as a network
    // outage at startup) can recover without restarting the game.
    if (this.mode === 'failed' && this.status?.code === 'bridge-crashed'
        && this.now() - this.failedAt >= this.timings.crashCooldownMs) {
      this.log('Trying the bridge again after the crash cool-down.');
      this.mode = 'idle';
    }
  }

  async onBridgeExit(pid, exit) {
    await this.pollControl(); // A stop command written just before the exit still counts.
    const requested = this.stopRequested;
    if (pid && pid === this.childPid) this.retiredPids.add(pid);
    this.child = null; this.childPid = null; this.childExit = null; this.adoptedPid = null;
    this.ready = false; this.stopRequested = false;
    // A bridge that ends without cleaning up (a V8 out-of-memory, a native crash, "End task") leaves its model server running with the card's memory: stop what it
    // wrote down in children.json (only a process that is exactly the exe and start it recorded; bridge/child-registry.mjs), so the next bridge finds the card free.
    // A bridge that ended on request cleaned up itself and left nothing to find. Never longer than 15 s.
    // The cap ends the work too (no entry is started after it; what is not reached stays in the file) and a late finish removes only the records it dealt with, so the next
    // bridge's own are never overwritten.
    const cap = new AbortController(), timer = setTimeout(() => cap.abort(), 15_000);
    timer.unref?.();
    try {
      await Promise.race([reapChildren({file: resolve(this.stateDirectory, CHILDREN_FILE), log: line => this.log(line), signal: cap.signal}), delay(15_000, undefined, {ref: false})]);
    } catch { /* a failed look at the leftovers never changes what the supervisor does next */ }
    finally { clearTimeout(timer); }
    if (requested) {
      this.log(`The bridge (PID ${pid}) stopped on request; it stays stopped until it is started again.`);
      this.mode = this.watchingGame ? 'stopped' : 'done';
      return this.setStatus('stopped', 'stop-requested');
    }
    // The bridge found a data file of the Runtime missing (bridge/runtime-files.mjs) and ended itself with its own exit code and a line
    // in bridge.stderr.log: starting it again would end the same way, so this is the failure the game explains (the preflight
    // looks for the same files before every start, with `requiredFiles`, and checks again every few seconds; this exit is for a file it does
    // not know of, and waits for a new game).
    if (exit?.code === INCOMPLETE_EXIT_CODE) {
      this.log(`The bridge${pid ? ` (PID ${pid})` : ''} stopped because a file of the Runtime is missing (see bridge.stderr.log).`);
      this.retrySetup = false;
      return this.fail('install-incomplete');
    }
    // The bridge died on a file or package of its own that is not there (a Runtime extracted only partly, a file an antivirus removed) and said
    // so on its stderr, in Node's own words. Starting it again would end the same way, so this is `install-incomplete` too, named by the file.
    // The same when its files are of two versions (Node: "does not provide an export named", 0.2.5 report: Scripts 0.2.5 over a Runtime 0.2.2): the bridge ends at its first import,
    // every time, so this is not a crash loop either; the line says to take the full install zip.
    const errorText = typeof exit?.code === 'number' && exit.code !== 0 ? this.bridgeErrorText() : '';
    const missingModule = errorText ? missingModuleInLog(errorText, this.project) : null;
    if (missingModule) {
      // The stat fallbacks of Mod Organizer 2 (the bridge's own `--import`) that Node cannot see although they are there: not an incomplete extraction (runtime-files.mjs, usvfsFileMessage).
      // The name is the one under the Runtime, or only the file name when the copy in the data folder is the one that could not be seen.
      const hidden = (missingModule === USVFS_COMPAT_FILE || missingModule === 'usvfs-compat.mjs') && usvfsCompatImport(this.bridgeEnvironment()) !== null;
      this.log(`The bridge${pid ? ` (PID ${pid})` : ''} stopped at once. ${hidden ? usvfsFileMessage() : versionMismatchInLog(errorText) ? mismatchMessage(missingModule) : incompleteMessage(missingModule)}`);
      this.missingFiles = [missingModule];
      this.retrySetup = false;
      return this.fail('install-incomplete', hidden ? USVFS_FILE_REASON : undefined);
    }
    const now = this.now();
    this.crashes = this.crashes.filter(at => now - at < this.timings.crashWindowMs);
    this.crashes.push(now); this.restarts++;
    // What the exit code means, the stage the bridge was in and Node's own report, when it wrote one (bridge/bridge-diagnostics.mjs).
    let crashInfo = {};
    try { crashInfo = collectCrashInfo({stateDirectory: this.stateDirectory, pid, exit, launchedAt: this.launchedAt ?? 0, now}); } catch {}
    const words = exitCodeWords(exit?.code);
    this.log(`The bridge${pid ? ` (PID ${pid})` : ''} exited unexpectedly (${describeExit(exit)}${words ? `; ${words}` : ''}).`);
    for (const line of crashLogLines(crashInfo)) this.log(line);
    // A bridge that Windows ended from outside while the game closed or the session ended is logged (above) but never reported: nothing in it can be fixed (reports 5aff7ff8, 3d7ebef0).
    if (this.reporter && !endedFromOutsideCode(exit?.code)) void this.reporter.bridgeExited(describeExit(exit), crashInfo).catch(() => {});
    if (this.crashes.length >= this.timings.maxCrashes) {
      this.log(`Giving up after ${this.crashes.length} exits in ${Math.round(this.timings.crashWindowMs / 60000)} minutes. Check bridge.stderr.log.`);
      this.retrySetup = false;
      return this.fail('bridge-crashed');
    }
    const backoff = this.timings.backoffMs[Math.min(this.crashes.length - 1, this.timings.backoffMs.length - 1)];
    this.backoffUntil = now + backoff; this.mode = 'backoff';
    this.log(`Restarting the bridge in ${Math.round(backoff / 100) / 10} s.`);
    return this.setStatus('restarting', 'bridge-exited');
  }

  async fail(code, reason) {
    this.mode = 'failed'; this.failedAt = this.now();
    this.log(`The conversation service cannot run: ${code}${reason ? ` (${reason})` : ''}.`);
    this.reportEvent({kind: 'service-failed', message: code, frame: 'supervisor'});
    return this.setStatus('failed', code, reason);
  }

  async readControl() { return readFile(this.paths.control, 'utf8').catch(() => ''); }

  async pollControl() {
    const raw = await this.readControl();
    if (raw === this.lastControlRaw) return;
    this.lastControlRaw = raw;
    let command; try { command = JSON.parse(raw); } catch { return; }
    if (command?.action !== 'shutdown' || this.ownNonces.has(command.nonce)) return;
    const current = this.childPid ?? this.adoptedPid;
    if (current && command.pid === current) {
      this.stopRequested = true;
      this.log(`A stop was requested for the bridge (PID ${current}).`);
    }
  }

  async writeShutdown(pid) {
    const nonce = randomUUID();
    this.ownNonces.add(nonce);
    if (this.ownNonces.size > 64) this.ownNonces.delete(this.ownNonces.values().next().value);
    await atomicFile(this.paths.control, JSON.stringify({action: 'shutdown', pid, nonce}))
      .catch(error => this.log(`The shutdown request could not be written: ${error.message}`));
  }

  // The bridge drains local speech and releases its workers on this request.
  // Repeat it: a request written while the bridge is still importing would be
  // taken as its initial snapshot and ignored.
  async requestShutdown(pid, isRunning) {
    const deadline = this.now() + this.timings.shutdownGraceMs;
    let written = -Infinity;
    while (isRunning() && this.now() < deadline) {
      if (this.now() - written >= this.timings.shutdownRepeatMs) { await this.writeShutdown(pid); written = this.now(); }
      await this.sleep(this.timings.pollMs);
    }
    return !isRunning();
  }

  async stopOwnBridge() {
    const pid = this.childPid;
    if (!pid || this.childExit) return;
    if (await this.requestShutdown(pid, () => !this.childExit)) return;
    this.log(`The bridge (PID ${pid}) did not stop within ${Math.round(this.timings.shutdownGraceMs / 1000)} s; ending its process tree.`);
    await this.killTree(pid);
    const deadline = this.now() + this.timings.killWaitMs;
    while (!this.childExit && this.now() < deadline) await this.sleep(this.timings.pollMs);
  }

  async shutdownForGameExit() {
    const reason = this.exitReason || 'game-exited';
    if (this.childPid && !this.childExit) {
      this.log('Stopping the bridge because the game exited.');
      await this.setStatus('stopping', reason);
      await this.stopOwnBridge();
    } else if (this.adoptedPid && this.alive(this.adoptedPid)) {
      // Graceful only: a bridge started elsewhere is never force-killed.
      this.log(`Asking the existing bridge (PID ${this.adoptedPid}) to stop because the game exited.`);
      await this.setStatus('stopping', reason);
      const pid = this.adoptedPid;
      if (!await this.requestShutdown(pid, () => this.alive(pid))) this.log(`The existing bridge (PID ${pid}) is still running.`);
    }
    this.child = null; this.childPid = null; this.adoptedPid = null; this.mode = 'done';
    await this.setStatus('stopped', reason);
  }

  // `reason` is an optional short sentence for the game to show beside a failure's code (never a path or a secret).
  async setStatus(state, code, reason) {
    if (state !== this.status?.state || code !== this.status?.code || reason !== this.status?.reason) {
      this.status = {state, code, since: state === this.status?.state ? this.status.since : this.now(), ...(reason ? {reason} : {})};
    }
    return this.writeStatus();
  }

  // Writes are serialized and snapshot the state when they run, so a heartbeat
  // can never land after, and hide, a newer state change.
  writeStatus() {
    if (!this.status) return Promise.resolve();
    this.lastStatusWrite = this.now();
    this.statusWriting = (this.statusWriting || Promise.resolve()).then(() => {
      if (this.nextSessionOwnsStatus()) return;
      const value = {version: 1, state: this.status.state, code: this.status.code, since: this.status.since,
        ...(this.status.reason ? {reason: this.status.reason} : {}), updated: this.now(), supervisorPid: process.pid, bridgePid: this.childPid ?? this.adoptedPid ?? null,
        adopted: !!this.adoptedPid, restarts: this.restarts, gamePid: this.gamePid ?? null,
        // Where the service logs are, for the in-game Help page when the bridge never started.
        gameRoot: this.gameRoot, stateDirectory: this.stateDirectory};
      // A status file that cannot be written (the game holds it, a permission error) fails the same way every five seconds: said once, until a write works.
      return atomicFile(this.paths.status, JSON.stringify(value))
        .then(() => { this.statusFailed = false; })
        .catch(error => { if (!this.statusFailed) { this.statusFailed = true; this.log(`The service status could not be published: ${error.message}`); } });
    });
    return this.statusWriting;
  }

  // After its game has exited this supervisor still reports its own stop ('stopping' while the bridge drains, then 'stopped'), but the
  // player may have started the game again meanwhile: the next session's launcher, start script and supervisor write the same file, each
  // with its own game's PID. Their status (a failure above all, which the game would otherwise never see) is not written over.
  nextSessionOwnsStatus() {
    if (!this.gamePid || this.exitReason !== 'game-exited') return false;
    let other = null;
    try { other = JSON.parse(readFileSync(this.paths.status, 'utf8'))?.gamePid; } catch { return false; }
    if (!Number.isSafeInteger(other) || other <= 0 || other === this.gamePid) return false;
    if (!this.yieldedStatus) {
      this.yieldedStatus = true;
      this.log(`The service status now belongs to the next game session (game PID ${other}); this supervisor no longer writes it.`);
    }
    return true;
  }

  // The heartbeat runs on its own timer so the status stays current during a
  // long build or a bridge that is slow to stop.
  startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      if (this.status && this.now() - this.lastStatusWrite >= this.timings.heartbeatMs) void this.writeStatus();
    }, Math.min(1000, this.timings.heartbeatMs));
    this.heartbeat.unref?.();
  }
}
