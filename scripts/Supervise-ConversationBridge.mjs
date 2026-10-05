// Entry point started by the RED4ext launcher when the game starts:
//   node scripts/Supervise-ConversationBridge.mjs [--project DIR] [--state DIR]
//     [--key-file FILE] [--build-voice-client] --game-root DIR
//     [--game-pid PID] [--lifeline stdin]
// It runs hidden with no console output; see <state>/bridge-service.log.
import {appendFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BridgeSupervisor, parseSupervisorArguments} from '../bridge/bridge-supervisor.mjs';

const defaultProject = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let options;
try {
  options = parseSupervisorArguments(process.argv.slice(2), {defaultProject});
} catch (error) {
  process.stderr.write(`Conversation service supervisor: ${error.message}\n`);
  process.exit(2);
}
const supervisor = new BridgeSupervisor({...options, lifeline: options.lifeline === 'stdin' ? process.stdin : null});
if (options.unknown.length) supervisor.log(`Ignored unknown arguments: ${options.unknown.join(' ')}`);
for (const name of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(name, () => supervisor.requestExit('supervisor-stopped'));
process.on('unhandledRejection', error => supervisor.log(`Unhandled rejection: ${error?.stack || error}`));

let code = 0;
try {
  await supervisor.run();
} catch (error) {
  code = 1;
  try { appendFileSync(supervisor.paths.log, `${new Date().toISOString()} Supervisor failed: ${error?.stack || error}\n`); } catch {}
  // Leave the bridge it started in a clean state rather than orphaned mid-session.
  if (supervisor.childPid && !supervisor.childExit) await supervisor.stopOwnBridge().catch(() => {});
  await supervisor.setStatus('failed', 'supervisor-error').catch(() => {});
}
// The lifeline keeps stdin open; exit explicitly once supervision has ended.
process.exit(code);
