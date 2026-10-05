// Choose each character's voice-reference clips by ear.
//
//   node scripts/Reference-Picker.mjs            (or: npm run reference-picker, or Reference-Picker.bat)
//   then open http://127.0.0.1:8765/
//
// Options: --port 8765  --work <dir>  --rebuild-index  --open
//
// One card per voice: the original game line, the current reference clips (each playable), samples of the same line
// from Pocket (3-clip), OmniVoice 16 and 32 steps and today's single-reference versions, a reroll, a manual clip
// browser, "regenerate this voice only", and Keep / Reject. Every action is appended to runtime/reference-picks.jsonl;
// runtime/reference-picks.json is the derived current state. Apply-ReferencePicks.mjs turns the kept sets into
// proposed configs. The live voice configs are only ever read. Listens on 127.0.0.1 only.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {appendFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Engines} from './reference-picker/engines.mjs';
import {ensureIndex, loadIndex, Pool} from './reference-picker/pool.mjs';
import {PickStore} from './reference-picker/picks.mjs';
import {startPicker} from './reference-picker/server.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, at, all) => {
  if (token.startsWith('--')) pairs.push([token.slice(2), all[at + 1] === undefined || all[at + 1].startsWith('--') ? true : all[at + 1]]);
  return pairs;
}, []));
const work = resolve(args.work ?? 'E:/CyberpunkConvai-offload/work/reference-picker');
const port = Number(args.port ?? 8765);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('--port must be 1-65535');
if (!existsSync(resolve(project, 'runtime/pocket-voices.json')) || !existsSync(resolve(project, 'runtime/local-voices.json'))) {
  throw Error('runtime/pocket-voices.json and runtime/local-voices.json are required');
}

await mkdir(resolve(work, 'logs'), {recursive: true});
const indexPath = ensureIndex({project, work, rebuild: !!args['rebuild-index'], log: console.log});

const pool = new Pool(await loadIndex(indexPath), {project});
const store = new PickStore({logPath: resolve(project, 'runtime/reference-picks.jsonl'), jsonPath: resolve(project, 'runtime/reference-picks.json')});
await store.load();
const engines = new Engines({project, work, onLog: (kind, text) => {
  appendFile(resolve(work, 'logs', `${kind}.log`), text).catch(() => {});
}});

let running;
try { running = await startPicker({project, work, port, pool, store, engines}); }
catch (error) {
  if (error.code === 'EADDRINUSE') throw Error(`Port ${port} is already in use (is the picker already running? try --port ${port + 1})`);
  throw error;
}
const url = `http://127.0.0.1:${running.port}/`;
console.log(`Reference picker: ${url}`);
console.log(`  ${pool.keys.length} voices, ${store.state.entries} logged actions`);
console.log(`  log      ${store.logPath}`);
console.log(`  samples  ${resolve(work, 'samples')}`);
console.log('Press Ctrl+C to stop.');
if (args.open) spawn('cmd', ['/c', 'start', '', url], {detached: true, stdio: 'ignore', windowsHide: true}).unref();

const stop = async () => { console.log('\nStopping...'); await running.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
