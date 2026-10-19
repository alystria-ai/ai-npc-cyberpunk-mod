import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';

const run = promisify(execFile);

// PowerShell cannot be used on this PC: it is blocked or missing (ENOENT, EACCES, EPERM), exits non-zero (a group policy or
// constrained language mode refusing the command), prints something that is not an identity (policy text), or hangs past the timeout.
// `timeout` marks the one case that can be a slow, busy PC rather than a refusal.
export class PowerShellUnavailable extends Error {
  constructor(reason, {timeout = false} = {}) {
    super('PowerShell cannot be used here'); this.reason = reason; this.timeout = timeout;
  }
}

// Resolve only on adapter attachment, never every frame. PID plus creation time
// survives CET reloads, save changes and bridge restarts, but not a new game.
export async function identifyGameLaunch(game, {exec = run} = {}) {
  const script = '$p = Get-Process Cyberpunk2077 -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:CONVAI_GAME_EXE } | Select-Object -First 1; if ($p) { Write-Output ($p.Id.ToString() + "-" + $p.StartTime.ToUniversalTime().Ticks.ToString()) }';
  let stdout;
  try {
    ({stdout} = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 6000, maxBuffer: 2048,
      env: {...process.env, CONVAI_GAME_EXE: resolve(game, 'bin/x64/Cyberpunk2077.exe')},
    }));
  } catch (error) {
    const timeout = error?.killed === true || typeof error?.signal === 'string';
    throw new PowerShellUnavailable(timeout ? 'timeout' : String(error?.code ?? 'failed'), {timeout});
  }
  const token = String(stdout ?? '').trim();
  // Nothing printed and a zero exit: PowerShell worked and the game process is not there (yet). That is worth another try.
  if (!token) throw Error('Game launch identity unavailable');
  if (!/^\d+-\d+$/.test(token)) throw new PowerShellUnavailable('unexpected output');
  return token;
}

export class GameLaunchIdentity {
  // PowerShell failing is remembered for the life of this object (the bridge process): one log line, no more attempts, and no
  // launch identity is published (nothing reads it as a requirement). Two timeouts in a row count as a refusal too. A game that is
  // simply not found is retried every 3 s at first, then every 30 s.
  constructor({identify, publish, now = Date.now, log = message => console.error(`[CyberpunkConvai] ${message}`)}) {
    this.identify = identify; this.publish = publish; this.now = now; this.log = log;
    this.world = null; this.lastAttempt = -Infinity; this.unavailable = false; this.timeouts = 0; this.misses = 0;
  }
  async update(state) {
    if (this.unavailable) return;
    if (!state?.active || this.now() - state.updated > 15000 || this.world === state.world) return;
    if (this.now() - this.lastAttempt < (this.misses >= 5 ? 30000 : 3000)) return;
    this.lastAttempt = this.now();
    let launch;
    try { launch = await this.identify(); }
    catch (error) {
      if (!(error instanceof PowerShellUnavailable)) { this.misses++; this.timeouts = 0; throw error; }
      this.timeouts = error.timeout ? this.timeouts + 1 : 0;
      if (!error.timeout || this.timeouts >= 2) {
        this.unavailable = true;
        this.log(`Game launch identity: PowerShell cannot be used on this PC (${String(error.reason).slice(0, 40)}), so it is skipped for this session.`);
      }
      return;
    }
    this.misses = 0; this.timeouts = 0;
    await this.publish({version: 1, world: state.world, launch});
    this.world = state.world;
  }
}
