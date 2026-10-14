// Measures what a "Companions can see" capture costs (docs/COMPANION_VISION.md): the helper's time and CPU per picture, and the
// game's frame times around the captures from the mod's developer perf probe (runtime/perf-probe.json, 2 s windows). It sends
// no game input and changes nothing in the game folder; it only reads the probe file. Pictures stay in memory unless --save-first
// names a file for one inspection copy.
//
// The run alternates blocks without and with captures (off, on, off, on, ...) so slow drifts in the game's frame rate (a scene
// change, thermal throttling) fall on both sides. A probe window counts for a block only when it lies wholly inside it.
//
//   node scripts/Measure-VisionCapture.mjs [--blocks 8] [--block 12] [--interval 2000] [--burst 1]
//     [--width 768] [--quality 80] [--perf <perf-probe.json>] [--save-first <file.jpg>] [--series]
import {readFile, writeFile} from 'node:fs/promises';
import {VisionCapture} from '../bridge/vision-capture.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const blocks = Number(value('--blocks', 8)), blockSeconds = Number(value('--block', 12));
const interval = Number(value('--interval', 2000)), burst = Number(value('--burst', 1));
const width = Number(value('--width', 768)), quality = Number(value('--quality', 80));
const perfPath = value('--perf', 'E:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077\\bin\\x64\\plugins\\cyber_engine_tweaks\\mods\\CyberpunkConvai\\runtime\\perf-probe.json');
const saveFirst = value('--save-first'), series = args.includes('--series');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => Date.now() / 1000;
const stats = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {n: sorted.length, median: at(0.5), p95: at(0.95), max: sorted.at(-1), mean: sorted.reduce((a, b) => a + b, 0) / sorted.length};
};
const round = object => JSON.parse(JSON.stringify(object, (key, v) => typeof v === 'number' ? Math.round(v * 100) / 100 : v));

const capture = new VisionCapture({log: message => console.error('[vision] ' + message)});
const spawnStarted = performance.now();
if (!await capture.start()) { console.error('The vision helper is not available (build it with scripts/Build-VisionCapture.ps1).'); process.exit(1); }
const helperStartMs = performance.now() - spawnStarted;
const shots = [], spans = [];
for (let block = 0; block < blocks; block++) {
  const on = block % 2 === 1, start = now(), end = start + blockSeconds;
  console.error(`block ${block + 1}/${blocks} ${on ? 'with' : 'without'} captures`);
  while (now() < end) {
    if (on) {
      for (let b = 0; b < burst; b++) {
        const t0 = performance.now(), at = now();
        const result = await capture.capture({maxWidth: width, quality});
        shots.push({at, roundTrip: performance.now() - t0, ok: result.ok, reason: result.reason, ms: result.ms, bytes: result.bytes,
          width: result.width, height: result.height, sourceWidth: result.sourceWidth, sourceHeight: result.sourceHeight});
        if (result.ok && saveFirst && shots.filter(s => s.ok).length === 1) await writeFile(saveFirst, Buffer.from(result.base64, 'base64'));
      }
    }
    await sleep(Math.max(0, Math.min(on ? interval : 250, (end - now()) * 1000)));
  }
  spans.push({on, start, end: now()});
}
capture.stop();
console.error('captures done; waiting for the perf probe to write its windows...');
await sleep(13000);

let windows = [];
try { windows = JSON.parse(await readFile(perfPath, 'utf8')).history ?? []; } catch (error) { console.error(`perf probe unreadable: ${error.message}`); }
const blockOf = w => spans.find(s => w.at - w.span >= s.start - 0.05 && w.at <= s.end + 0.05);
const labelled = windows.filter(w => Number.isFinite(w.at) && blockOf(w));
const describe = list => round({windows: list.length, fps: stats(list.map(w => w.fps)), frameMeanMs: stats(list.map(w => w.frameMeanMs)),
  frameMaxMs: stats(list.map(w => w.frameMaxMs)), over25msPerWindow: list.reduce((a, w) => a + (w.over25ms || 0), 0) / Math.max(1, list.length),
  over40msPerWindow: list.reduce((a, w) => a + (w.over40ms || 0), 0) / Math.max(1, list.length)});
const ok = shots.filter(s => s.ok);
const t0 = spans[0]?.start ?? 0;
console.log(JSON.stringify(round({
  settings: {blocks, blockSeconds, interval, burst, width, quality},
  helperStartMs,
  captures: {total: shots.length, ok: ok.length, failures: shots.filter(s => !s.ok).map(s => s.reason),
    source: ok[0] ? `${ok[0].sourceWidth}x${ok[0].sourceHeight}` : null, output: ok[0] ? `${ok[0].width}x${ok[0].height}` : null,
    bytes: stats(ok.map(s => s.bytes)), roundTripMs: stats(ok.map(s => s.roundTrip)), totalMs: stats(ok.map(s => s.ms.total)),
    frameWaitMs: stats(ok.map(s => s.ms.frame)), copyMs: stats(ok.map(s => s.ms.copy)), encodeMs: stats(ok.map(s => s.ms.encode)),
    cpuMs: stats(ok.map(s => s.ms.cpu))},
  game: {without: describe(labelled.filter(w => !blockOf(w).on)), with: describe(labelled.filter(w => blockOf(w).on))},
  ...(series ? {series: labelled.map(w => ({t: w.at - t0, on: blockOf(w).on, fps: w.fps, mean: w.frameMeanMs, max: w.frameMaxMs,
    over25: w.over25ms, captures: shots.filter(s => s.at > w.at - w.span && s.at <= w.at).length}))} : {}),
}), null, 2));
