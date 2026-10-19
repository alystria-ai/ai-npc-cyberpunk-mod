import {MOD_RUNTIME, READY_MARKER} from './bridge-supervisor.mjs';

// A stand-in for bridge/convai-bridge.mjs that speaks the real bridge's
// lifecycle protocol: environment paths, the ready line on stdout, a PID
// heartbeat in local-voice-state.json and PID-addressed bridge-control.json
// shutdown. <state>/fake-behavior.json selects crashes or a stubborn shutdown;
// <state>/fake-starts.log records "start PID" and "stopped PID" lines.
export const fakeBridgeSource = `
import {appendFileSync, readFileSync, writeFileSync, renameSync, existsSync} from 'node:fs';
import {join} from 'node:path';
const state = process.env.CYBERPUNK_CONVAI_STATE, game = process.env.CYBERPUNK_CONVAI_GAME;
const runtime = join(game, ${JSON.stringify(MOD_RUNTIME)});
const read = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
const behavior = read(join(state, 'fake-behavior.json'), {});
const starts = (existsSync(join(state, 'fake-starts.log')) ? readFileSync(join(state, 'fake-starts.log'), 'utf8').split('\\n').filter(line => line.startsWith('start')).length : 0) + 1;
appendFileSync(join(state, 'fake-starts.log'), 'start ' + process.pid + '\\n');
writeFileSync(join(state, 'fake-env-' + process.pid + '.json'), JSON.stringify({state, game,
  key: process.env.CYBERPUNK_CONVAI_KEY_FILE, nodeOptions: process.env.NODE_OPTIONS ?? null, cwd: process.cwd()}));
const crash = behavior.crashStarts?.includes(starts) || behavior.crashAlways;
if (crash && behavior.crashBeforeReady) process.exit(behavior.exitCode ?? 3);
const control = join(state, 'bridge-control.json');
let observed = (() => { try { return readFileSync(control, 'utf8'); } catch { return ''; } })();
const publish = voice => {
  const target = join(runtime, 'local-voice-state.json'), temp = target + '.' + process.pid + '.tmp';
  writeFileSync(temp, JSON.stringify({version: 1, state: voice, bridgePid: process.pid, updated: Date.now()}));
  try { renameSync(temp, target); } catch {}
};
publish('ready');
setInterval(() => publish('ready'), 150);
if (!behavior.neverReady) setTimeout(() => console.log(${JSON.stringify(READY_MARKER)}), behavior.readyDelayMs ?? 50);
if (crash) setTimeout(() => process.exit(4), 250);
setInterval(() => {
  let raw; try { raw = readFileSync(control, 'utf8'); } catch { return; }
  if (raw === observed) return;
  observed = raw;
  let command; try { command = JSON.parse(raw); } catch { return; }
  if (command.action === 'shutdown' && command.pid === process.pid && !behavior.ignoreShutdown) {
    publish('stopped'); appendFileSync(join(state, 'fake-starts.log'), 'stopped ' + process.pid + '\\n');
    setTimeout(() => process.exit(0), 30);
  }
}, 40);
`;
