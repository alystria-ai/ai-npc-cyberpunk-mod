// The listening report and the reference picker on one page.
//
//   node scripts/Reference-Picker.mjs            (or: npm run reference-picker, or Reference-Picker.bat)
//   then open http://127.0.0.1:8765/
//
// Options: --port 8765  --work <dir>  --research <dir|off>  --rebuild-index  --open  --gpu-busy-fraction 0.6
//          --runtime <dir> (log and status file location; default runtime/)
//          --fake-render (UI trials: renders short tones instead of speech; no models, no GPU)
//
// Main view: the research agent's listening report (read only: E:/CyberpunkConvai-offload/work/likeness-phase1), one row
// per voice with every model column, scores under the headers, column groups you can hide, and a quick verdict. Under
// each voice a collapsed "Reference clips" panel: the current clip sets, reroll, hand-pick, regenerate this voice only
// (extra "Your pick" columns in that row) and Keep / Reject per engine. Every action is appended to
// runtime/reference-picks.jsonl; runtime/reference-picks.json is the derived current state. Apply-ReferencePicks.mjs
// turns kept sets into proposed configs. The live voice configs are only ever read.
//
// Runs headless as a long-lived process on 127.0.0.1 only: it never opens a browser unless --open is given, writes
// runtime/reference-picker.json ({port, pid, started, url}), and if a picker is already running it prints that one's
// URL and exits 0. Renders wait ("GPU busy, queued") while another process holds most of the GPU.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {appendFile, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Engines} from './reference-picker/engines.mjs';
import {FakeEngines} from './reference-picker/fake-engines.mjs';
import {ensureIndex, loadIndex, Pool} from './reference-picker/pool.mjs';
import {PickStore} from './reference-picker/picks.mjs';
import {startPicker} from './reference-picker/server.mjs';
import {Research} from './reference-picker/research.mjs';
import {GpuMonitor} from './reference-picker/gpu.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, at, all) => {
  if (token.startsWith('--')) pairs.push([token.slice(2), all[at + 1] === undefined || all[at + 1].startsWith('--') ? true : all[at + 1]]);
  return pairs;
}, []));
const work = resolve(args.work ?? 'E:/CyberpunkConvai-offload/work/reference-picker');
const port = Number(args.port ?? 8765);
const runtimeDir = resolve(typeof args.runtime === 'string' ? args.runtime : resolve(project, 'runtime'));      // --runtime: where the log and status file live (default runtime/)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('--port must be 1-65535');
if (!existsSync(resolve(project, 'runtime/pocket-voices.json')) || !existsSync(resolve(project, 'runtime/local-voices.json'))) {
  throw Error('runtime/pocket-voices.json and runtime/local-voices.json are required');
}

await mkdir(resolve(work, 'logs'), {recursive: true});
await mkdir(runtimeDir, {recursive: true});
const indexPath = ensureIndex({project, work, rebuild: !!args['rebuild-index'], log: console.log});

const pool = new Pool(await loadIndex(indexPath), {project});
const store = new PickStore({logPath: resolve(runtimeDir, 'reference-picks.jsonl'), jsonPath: resolve(runtimeDir, 'reference-picks.json')});
await store.load();
const Renderer = args['fake-render'] ? FakeEngines : Engines;      // --fake-render: tones instead of speech, no models, no GPU
const engines = new Renderer({project, work, onLog: (kind, text) => {
  appendFile(resolve(work, 'logs', `${kind}.log`), text).catch(() => {});
}});

// One picker at a time: the status file names the running one; a stale file (dead process) is ignored.
const statusPath = resolve(runtimeDir, 'reference-picker.json');
async function runningPicker() {
  let status;
  try { status = JSON.parse(await readFile(statusPath, 'utf8')); } catch { return null; }
  for (const candidate of [...new Set([status.port, port])]) {
    try {
      const response = await fetch(`http://127.0.0.1:${candidate}/api/queue`, {signal: AbortSignal.timeout(2500)});
      if (response.ok && 'jobs' in await response.json()) return {...status, port: candidate, url: `http://127.0.0.1:${candidate}/`};
    } catch { /* not answering */ }
  }
  return null;
}
const existing = await runningPicker();
if (existing) {
  console.log(`Reference picker is already running: ${existing.url} (pid ${existing.pid}, started ${existing.started})`);
  process.exit(0);
}

const research = new Research({root: args.research === 'off' ? null : resolve(typeof args.research === 'string' ? args.research : 'E:/CyberpunkConvai-offload/work/likeness-phase1')});
const gpu = new GpuMonitor({busyFraction: Number(args['gpu-busy-fraction'] ?? 0.6)});
const logError = (label, error) => {
  const text = `${new Date().toISOString()} ${label}: ${error?.stack ?? error}\n`;
  console.error(text.trim());
  appendFile(resolve(work, 'logs', 'server.log'), text).catch(() => {});
};
// A long-lived background process must not die from one bad request or a stray rejection.
process.on('uncaughtException', error => logError('uncaughtException', error));
process.on('unhandledRejection', error => logError('unhandledRejection', error));

let running;
try { running = await startPicker({project, work, port, pool, store, engines, research, gpu}); }
catch (error) {
  if (error.code === 'EADDRINUSE') {
    const other = await runningPicker();
    if (other) { console.log(`Reference picker is already running: ${other.url}`); process.exit(0); }
    throw Error(`Port ${port} is already in use by something else (try --port ${port + 1})`);
  }
  throw error;
}
const url = `http://127.0.0.1:${running.port}/`;
const writeStatus = async () => {
  const temporary = `${statusPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({port: running.port, pid: process.pid, started: new Date().toISOString(), url, log: store.logPath, work}, null, 1) + '\n');
  await rename(temporary, statusPath);
};
await writeStatus();
console.log(`Reference picker: ${url}`);
console.log(`  ${pool.keys.length} voices with references, ${store.state.entries} logged actions, research report ${research.enabled ? 'found' : 'not found'}`);
console.log(`  log      ${store.logPath}`);
console.log(`  status   ${statusPath}`);
console.log(`  samples  ${resolve(work, 'samples')}`);
if (args.open) spawn('cmd', ['/c', 'start', '', url], {detached: true, stdio: 'ignore', windowsHide: true}).unref();

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  try { await running.close(); } catch (error) { logError('shutdown', error); }
  try { if (JSON.parse(await readFile(statusPath, 'utf8')).pid === process.pid) await rm(statusPath, {force: true}); } catch { /* already gone */ }
  process.exit(0);
};
process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGBREAK', stop);
