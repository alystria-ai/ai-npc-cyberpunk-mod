import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';

const exec = promisify(execFile);

// Resolve only on adapter attachment, never every frame. PID plus creation time
// survives CET reloads, save changes and bridge restarts, but not a new game.
export async function identifyGameLaunch(game) {
  const script = '$p = Get-Process Cyberpunk2077 -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:CONVAI_GAME_EXE } | Select-Object -First 1; if ($p) { Write-Output ($p.Id.ToString() + "-" + $p.StartTime.ToUniversalTime().Ticks.ToString()) }';
  const {stdout} = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 6000, maxBuffer: 2048,
    env: {...process.env, CONVAI_GAME_EXE: resolve(game, 'bin/x64/Cyberpunk2077.exe')},
  });
  const token = stdout.trim();
  if (!/^\d+-\d+$/.test(token)) throw Error('Game launch identity unavailable');
  return token;
}

export class GameLaunchIdentity {
  constructor({identify, publish, now = Date.now}) {
    this.identify = identify; this.publish = publish; this.now = now;
    this.world = null; this.lastAttempt = -Infinity;
  }
  async update(state) {
    if (!state?.active || this.now() - state.updated > 15000 || this.world === state.world) return;
    if (this.now() - this.lastAttempt < 3000) return;
    this.lastAttempt = this.now();
    const launch = await this.identify();
    await this.publish({version: 1, world: state.world, launch});
    this.world = state.world;
  }
}
