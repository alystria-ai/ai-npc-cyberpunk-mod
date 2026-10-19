// Runs the optional microphone packs (docs/LOCAL_STT.md, "Other languages") through the mod's own LocalStt and worker, on 16-bit WAV clips.
//
//   node scripts/Test-MicPacks.mjs --packs <folder with <pack id>/ folders> --pack <pack id> --clips <folder of .wav> [--only <regex>]
//        [--threads N] [--python <python.exe with sherpa-onnx>] [--json <out.json>]
//
// A `<name>.txt` next to a clip is its expected text: the output shows it beside what was heard. Per clip it prints the audio length, the wait
// from the end of the audio to the transcript (what the player waits after the second key press), the worker's load time and its memory, and at
// the end that the worker exited. Nobody is recorded; nothing leaves this computer. On a laptop in Silent power mode expect slower numbers.
import {readFileSync, readdirSync, existsSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {LocalStt} from '../bridge/local-stt.mjs';
import {LOCAL_PACKS} from '../bridge/speech-language.mjs';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const option = (name, fallback) => { const at = argv.indexOf('--' + name); return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback; };
const packs = option('packs'), packId = option('pack'), clips = option('clips');
if (!packs || !packId || !clips) {
  console.error('Usage: node scripts/Test-MicPacks.mjs --packs <folder> --pack <' + LOCAL_PACKS.map(pack => pack.id).join('|') + '> --clips <folder of .wav> [--only regex] [--threads N] [--python exe] [--json out]');
  process.exit(2);
}
const engine = LOCAL_PACKS.find(pack => pack.id === packId);
if (!engine) throw Error('Unknown pack ' + packId);
const threads = Number(option('threads', 1));
// The interpreter that has sherpa-onnx: --python, CYBERPUNK_CONVAI_PYTHON, or the development environment (vendor/pocket-tts-env) of this checkout or of
// the main checkout this one is a worktree of.
function findPython() {
  const given = option('python', process.env.CYBERPUNK_CONVAI_PYTHON);
  if (given) return given;
  for (let dir = project, i = 0; i < 6; i += 1, dir = resolve(dir, '..')) {
    const candidate = join(dir, 'vendor', 'pocket-tts-env', 'Scripts', 'python.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
const python = findPython();

// 16-bit PCM WAV -> 16 kHz mono Int16 samples (channel average, linear resampling).
function readWav(path) {
  const b = readFileSync(path);
  let at = 12, format = null, data = null;
  while (at + 8 <= b.length) {
    const id = b.toString('latin1', at, at + 4), size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') format = {channels: b.readUInt16LE(at + 10), rate: b.readUInt32LE(at + 12), bits: b.readUInt16LE(at + 22)};
    if (id === 'data') { data = b.subarray(at + 8, at + 8 + Math.min(size, b.length - at - 8)); break; }
    at += 8 + size + (size & 1);
  }
  if (!format || !data || format.bits !== 16) throw Error(path + ': only 16-bit PCM WAV is supported');
  const frames = Math.floor(data.length / 2 / format.channels), mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < format.channels; c++) sum += data.readInt16LE((i * format.channels + c) * 2);
    mono[i] = sum / format.channels;
  }
  if (format.rate === 16000) return Int16Array.from(mono);
  const out = new Int16Array(Math.floor(frames * 16000 / format.rate));
  for (let i = 0; i < out.length; i++) {
    const position = i * format.rate / 16000, low = Math.floor(position), high = Math.min(frames - 1, low + 1), t = position - low;
    out[i] = Math.round(mono[low] * (1 - t) + mono[high] * t);
  }
  return out;
}

// Working set (MB) of the worker and its children (a venv's python.exe is a launcher that starts the real interpreter).
function memoryMb(pid) {
  if (process.platform !== 'win32' || !pid) return null;
  const script = `$ids=@(${Number(pid)}); $ids += (Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)}").ProcessId; ($ids | ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).WorkingSet64 } | Measure-Object -Sum).Sum`;
  const value = Number(String(spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {encoding: 'utf8'}).stdout).trim());
  return Number.isFinite(value) && value > 0 ? Math.round(value / 1048576) : null;
}

const stt = new LocalStt({project, pythonExecutable: python, environment: {...process.env, CYBERPUNK_CONVAI_STT_PACKS: resolve(packs)}, engine,
  partials: false, pausePartials: false, idleMs: 60_000, startupMs: 150_000, finishMs: 60_000, threads});
console.log('availability', JSON.stringify(stt.availability()), 'model folder', stt.paths.modelDirectory);
const only = option('only') ? new RegExp(option('only')) : null;
const rows = [];
for (const file of readdirSync(clips).filter(name => name.toLowerCase().endsWith('.wav')).sort()) {
  if (only && !only.test(file)) continue;
  const samples = readWav(join(clips, file));
  const expectedFile = join(clips, file.replace(/\.wav$/i, '.txt'));
  const expected = existsSync(expectedFile) ? readFileSync(expectedFile, 'utf8').trim() : null;
  const id = 'clip-' + (rows.length + 1);
  await stt.start(id);
  for (let at = 0; at < samples.length; at += 1600) stt.pushAudio(samples.subarray(at, at + 1600), id);
  const sent = Date.now();
  let result = null, error = null;
  try { result = await stt.finish(id); } catch (failure) { error = failure.message; }
  const row = {file, seconds: +(samples.length / 16000).toFixed(2), expected, text: result?.text ?? null, waitMs: Date.now() - sent, decodeMs: result?.ms ?? null,
    rejected: result?.rejected ?? null, error, loadMs: stt.worker?.info?.loadMs ?? null, memoryMb: memoryMb(stt.worker?.child?.pid)};
  rows.push(row);
  console.log(JSON.stringify(row));
}
const pid = stt.worker?.child?.pid;
await stt.close();
const stillThere = pid ? spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH'], {encoding: 'utf8'}).stdout.includes(String(pid)) : false;
console.log(stillThere ? 'WORKER STILL RUNNING after close' : 'worker exited');
if (option('json')) writeFileSync(option('json'), JSON.stringify(rows, null, 1));
process.exitCode = stillThere || rows.some(row => row.error) ? 1 : 0;
