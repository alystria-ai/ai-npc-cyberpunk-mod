import {mkdir, open, readFile, rename, rm} from 'node:fs/promises';
import {spawn, execFile} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {bridgeEnvironment, inspectSetup, readJson, RuntimeError, verifyManifestFiles} from './runtime-layout.mjs';

const exec = promisify(execFile);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const pid = value => Number.isSafeInteger(value) && value > 0;

export async function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await open(temp, 'wx', 0o600).then(async file => {
      try { await file.writeFile(JSON.stringify(value) + '\n'); } finally { await file.close(); }
    });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, path); break; }
      catch (error) {
        if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await sleep(20);
      }
    }
  } finally { await rm(temp, {force: true}).catch(() => {}); }
}

export function processAlive(value) {
  if (!pid(value)) return false;
  try { process.kill(value, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export async function gameIdentity(layout) {
  if (process.platform !== 'win32')
    throw new RuntimeError('unsupported-platform', 'Game process ownership needs Windows.');
  const script = '$items = @(Get-Process -Name Cyberpunk2077 -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:CYBERPUNK_RUNTIME_GAME_EXE }); if ($items.Count -eq 1) { $p = $items[0]; Write-Output ($p.Id.ToString() + "-" + $p.StartTime.ToUniversalTime().Ticks.ToString()) }';
  let output;
  try {
    output = (await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      {windowsHide: true, timeout: 6000, maxBuffer: 1024,
        env: {...process.env, CYBERPUNK_RUNTIME_GAME_EXE: layout.gameExecutable}})).stdout.trim();
  } catch { throw new RuntimeError('game-probe-failed', 'The game process could not be checked.'); }
  if (!output) return null;
  if (!/^\d+-\d+$/.test(output)) throw new RuntimeError('game-probe-failed', 'The game process identity is invalid.');
  return output;
}

function validOwner(owner) {
  return owner?.schema === 1 && uuid(owner.token) && pid(owner.supervisorPid)
    && (owner.bridgePid === null || pid(owner.bridgePid));
}

function ownedStop(raw, token) {
  let command; try { command = JSON.parse(raw); } catch { return false; }
  return command?.schema === 1 && command.action === 'stop'
    && command.owner === token && uuid(command.nonce);
}

async function sameOwner(layout, token) {
  return (await readJson(layout.leasePath))?.token === token;
}

export async function serviceStatus(layout, {alive = processAlive} = {}) {
  const owner = await readJson(layout.leasePath);
  if (!owner) {
    const previous = await readJson(layout.serviceStatusPath);
    return {schema: 1, state: ['setup-required', 'game-not-running', 'error', 'stopped'].includes(previous?.state)
      ? previous.state : 'stopped', code: previous?.code, setup: previous?.setup};
  }
  if (!validOwner(owner)) return {schema: 1, state: 'ownership-unavailable'};
  const supervisorAlive = alive(owner.supervisorPid), bridgeAlive = alive(owner.bridgePid);
  if (!supervisorAlive) return {schema: 1, state: bridgeAlive ? 'orphaned' : 'recovery-required',
    supervisorAlive, bridgeAlive};
  const status = await readJson(layout.serviceStatusPath);
  if (status?.schema !== 1 || status.owner !== owner.token)
    return {schema: 1, state: 'starting', supervisorAlive, bridgeAlive};
  // Deliberately omit private IDs, profile mappings, credentials and paths.
  return {schema: 1, state: status.state, code: status.code,
    setup: status.setup, updated: status.updated, supervisorAlive, bridgeAlive,
    runtimeVersion: status.runtimeVersion};
}

export async function recoverService(layout, {alive = processAlive} = {}) {
  const recoveryPath = `${layout.leasePath}.recovery`;
  let recovery;
  try { recovery = await open(recoveryPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new RuntimeError('recovery-in-progress', 'Another runtime recovery is in progress.');
    throw error;
  }
  try {
    const owner = await readJson(layout.leasePath);
    if (!owner) return {schema: 1, state: 'stopped'};
    if (!validOwner(owner))
      throw new RuntimeError('ownership-unavailable', 'The service owner record cannot be safely recovered.');
    if (alive(owner.supervisorPid) || alive(owner.bridgePid))
      throw new RuntimeError('service-still-alive', 'Recovery requires both owned service processes to have exited.');
    if (!await sameOwner(layout, owner.token))
      throw new RuntimeError('ownership-changed', 'The service owner changed during recovery.');
    await rm(layout.leasePath);
    // A recovery never starts/resumes a worker or clears user data.
    return {schema: 1, state: 'stopped', recovered: true};
  } finally {
    await recovery.close(); await rm(recoveryPath, {force: true});
  }
}

export async function requestStop(layout, {alive = processAlive, waitMs = 0, pollMs = 100} = {}) {
  const owner = await readJson(layout.leasePath);
  if (!owner) return {schema: 1, state: 'stopped'};
  if (!validOwner(owner))
    throw new RuntimeError('ownership-unavailable', 'The service owner record is unavailable.');
  if (!alive(owner.supervisorPid))
    throw new RuntimeError('owner-not-running', 'The supervisor has exited. Inspect runtime recovery before continuing.');
  if (!await sameOwner(layout, owner.token))
    throw new RuntimeError('ownership-changed', 'The service owner changed before shutdown.');
  await atomicJson(layout.serviceControlPath,
    {schema: 1, action: 'stop', owner: owner.token, nonce: randomUUID()});
  const end = Date.now() + Math.max(0, Math.min(waitMs, 55_000));
  while (Date.now() < end) {
    if (!await sameOwner(layout, owner.token)) return {schema: 1, state: 'stopped'};
    await sleep(pollMs);
  }
  // The same supervisor continues its graceful stop after this caller returns.
  return {schema: 1, state: 'stopping'};
}

async function acquireOwner(layout, owner) {
  await mkdir(layout.stateRoot, {recursive: true});
  let file;
  try {
    const recovering = await readFile(`${layout.leasePath}.recovery`).catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (recovering !== null) throw new RuntimeError('recovery-in-progress', 'Another runtime recovery is in progress.');
    file = await open(layout.leasePath, 'wx', 0o600);
    await file.writeFile(JSON.stringify(owner) + '\n');
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new RuntimeError('service-already-owned', 'The runtime already has an owner. Check its service status.');
    throw error;
  } finally { await file?.close(); }
}

export async function superviseRuntime(layout, {spawnImpl = spawn, alive = processAlive,
  watchGame = true, identifyGame = () => gameIdentity(layout),
  pollMs = 500, startupMs = 60_000, now = Date.now, onStatus = () => {},
  signal} = {}) {
  const owner = {schema: 1, token: randomUUID(), supervisorPid: process.pid,
    bridgePid: null, createdAt: now()};
  await acquireOwner(layout, owner);
  let child, closed = null, output, errors, stopRequested = false, initialGame;
  let lastControl = '', lastGameProbe = 0, lastStopWrite = 0, ready = false, readinessSeen = false;
  let startedAt, everReady = false, shutdownReason;
  let lastStartupCheck = -Infinity;
  const publish = async (state, extra = {}) => {
    if (!await sameOwner(layout, owner.token))
      throw new RuntimeError('ownership-changed', 'The service owner record changed.');
    const value = {schema: 1, owner: owner.token, state, updated: now(),
      supervisorPid: owner.supervisorPid, bridgePid: owner.bridgePid,
      runtimeVersion: layout.manifest?.runtimeVersion || 'development', ...extra};
    await atomicJson(layout.serviceStatusPath, value); onStatus(value);
  };
  const shutdownBridge = async (reason = 'stop-requested') => {
    if (stopRequested) return;
    stopRequested = true; shutdownReason = reason;
    await publish('stopping', {code: reason});
    // Address the exact child we started, using the bridge's existing graceful
    // protocol. Never enumerate/kill other Node, Python, browser or game tasks.
    if (child && !closed) {
      await atomicJson(layout.bridgeControlPath,
        {action: 'shutdown', pid: child.pid, nonce: randomUUID()});
      lastStopWrite = now();
    }
  };
  const checkStartupStop = async (force = true) => {
    // A stop during verification/setup must prevent worker creation, rather
    // than starting a model/browser only to retire it afterward. Hash streams
    // call this between chunks; bound file polling to once per 100 ms there.
    if (signal?.aborted)
      throw new RuntimeError('startup-stopped', 'Runtime preparation was stopped.');
    if (!force && Date.now() - lastStartupCheck < 100) return;
    lastStartupCheck = Date.now();
    if (!await sameOwner(layout, owner.token))
      throw new RuntimeError('ownership-changed', 'The service owner record changed during preparation.');
    const control = await readFile(layout.serviceControlPath, 'utf8').catch(() => '');
    if (signal?.aborted || ownedStop(control, owner.token))
      throw new RuntimeError('startup-stopped', 'Runtime preparation was stopped.');
  };
  try {
    await publish('checking');
    await checkStartupStop();
    if (layout.packaged) await verifyManifestFiles(layout.appRoot, layout.manifest,
      {checkpoint: checkStartupStop});
    await checkStartupStop();
    const setup = await inspectSetup(layout);
    await checkStartupStop();
    if (setup.length) { await publish('setup-required', {setup}); return {state: 'setup-required', setup}; }
    const priorVoice = await readJson(resolve(layout.gameRuntime, 'local-voice-state.json'));
    await checkStartupStop();
    if (pid(priorVoice?.bridgePid) && alive(priorVoice.bridgePid)
        && Number.isFinite(priorVoice.updated) && Math.abs(now() - priorVoice.updated) < 15_000)
      throw new RuntimeError('service-conflict', 'Another conversation bridge is active for this game.');
    if (watchGame) {
      initialGame = await identifyGame();
      await checkStartupStop();
      if (!initialGame) { await publish('game-not-running'); return {state: 'game-not-running'}; }
    }
    await mkdir(resolve(layout.stateRoot, 'logs'), {recursive: true});
    if (layout.packaged) {
      for (const name of ['voice-references', 'voice-studio-data', 'lipsync-work'])
        await mkdir(resolve(layout.stateRoot, name), {recursive: true});
    }
    output = createWriteStream(resolve(layout.stateRoot, 'logs/bridge.stdout.log'), {flags: 'a', mode: 0o600});
    errors = createWriteStream(resolve(layout.stateRoot, 'logs/bridge.stderr.log'), {flags: 'a', mode: 0o600});
    // Pipeline only to private logs; a provider error/body is never a public
    // bootstrap status. These streams cannot keep the child alive after exit.
    output.on('error', () => {}); errors.on('error', () => {});
    await publish('starting');
    // There is no asynchronous step between this final owned-control check and
    // spawn. A later request belongs to the exact-child graceful-stop path.
    await checkStartupStop();
    child = spawnImpl(layout.nodeExecutable, [layout.entry], {
      cwd: layout.appRoot, env: bridgeEnvironment(layout), shell: false,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('error', () => { closed = {code: null, error: true}; });
    child.once('close', (code, terminationSignal) => { closed = {code, signal: terminationSignal}; });
    if (!pid(child.pid)) throw new RuntimeError('bridge-launch-failed', 'The conversation bridge could not be launched.');
    child.stdout.pipe(output); child.stderr.pipe(errors);
    let tail = '';
    child.stdout.on('data', data => {
      tail = (tail + data.toString('utf8')).slice(-4096);
      if (!readinessSeen && tail.includes('[CyberpunkConvai] Convai conversation bridge ready')) {
        readinessSeen = true; ready = true;
      }
    });
    owner.bridgePid = child.pid;
    if (!await sameOwner(layout, owner.token))
      throw new RuntimeError('ownership-changed', 'The service owner record changed before child publication.');
    await atomicJson(layout.leasePath, owner);
    startedAt = now(); await publish('starting');
    while (!closed) {
      if (!await sameOwner(layout, owner.token)) {
        // Ownership loss does not authorize a different child's shutdown.
        // This retained handle is still our exact child; retire it explicitly.
        await atomicJson(layout.bridgeControlPath,
          {action: 'shutdown', pid: child.pid, nonce: randomUUID()});
        throw new RuntimeError('ownership-changed', 'The service owner record changed.');
      }
      const control = await readFile(layout.serviceControlPath, 'utf8').catch(() => '');
      if (control !== lastControl) {
        lastControl = control;
        if (ownedStop(control, owner.token)) await shutdownBridge();
      }
      if (signal?.aborted) await shutdownBridge();
      if (stopRequested && now() - lastStopWrite >= 1000) {
        // A stop during imports may precede the bridge's initial control-file
        // snapshot. Repeat the same owned request until its event loop sees it.
        await atomicJson(layout.bridgeControlPath,
          {action: 'shutdown', pid: child.pid, nonce: randomUUID()});
        lastStopWrite = now();
      }
      if (!stopRequested && watchGame && now() - lastGameProbe >= 2000) {
        lastGameProbe = now();
        // Probe errors fail the owned service closed; a new PID/creation-time
        // token never transfers the existing speech service to a new game.
        try { if (await identifyGame() !== initialGame) await shutdownBridge('game-ended'); }
        catch { await shutdownBridge('game-probe-failed'); }
      }
      if (!stopRequested && ready) {
        ready = false; everReady = true; await publish('ready'); startedAt = null;
      }
      if (!stopRequested && startedAt !== null && now() - startedAt >= startupMs)
        await shutdownBridge('startup-timeout');
      await sleep(pollMs);
    }
    if (shutdownReason === 'startup-timeout') {
      await publish('error', {code: 'startup-timeout'}); return {state: 'error', code: 'startup-timeout'};
    }
    if ((!everReady || closed.code !== 0) && !stopRequested) {
      await publish('error', {code: 'bridge-exited'}); return {state: 'error', code: 'bridge-exited'};
    }
    await publish('stopped'); return {state: 'stopped'};
  } catch (error) {
    if (!child && error instanceof RuntimeError && error.code === 'startup-stopped') {
      await publish('stopped'); return {state: 'stopped'};
    }
    // A launched child remains owned until it exits. An unexpected bootstrap
    // failure must not release the lease while its GPU/browser workers live.
    if (child && !closed) {
      await atomicJson(layout.bridgeControlPath,
        {action: 'shutdown', pid: child.pid, nonce: randomUUID()}).catch(() => {});
      while (!closed && alive(child.pid)) {
        await sleep(Math.max(pollMs, 1000));
        if (!closed) await atomicJson(layout.bridgeControlPath,
          {action: 'shutdown', pid: child.pid, nonce: randomUUID()}).catch(() => {});
      }
    }
    if (await sameOwner(layout, owner.token))
      await publish('error', {code: error instanceof RuntimeError ? error.code : 'bootstrap-failed'}).catch(() => {});
    throw error;
  } finally {
    output?.end(); errors?.end();
    if ((!child || closed || !alive(child.pid)) && await sameOwner(layout, owner.token))
      await rm(layout.leasePath, {force: true});
  }
}
