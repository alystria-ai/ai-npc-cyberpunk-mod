// Key press to the first audio chunk at the bridge, through the real path (MicTap -> LocalSttCapture -> hidden Edge page -> the real input device), cold and
// within the linger, for the default input and for a named one.
//
//   node scripts/Measure-PressToFrame.mjs [--device "Microphone Array (Realtek(R) Audio)"] [--cold 2] [--idle 20] [--linger 3]
//
// Nothing is recorded or kept: each turn lasts 300 ms and its chunks are thrown away. The press is tap.hold() (the bridge's reaction to the game's key-down
// file, which the directory watcher delivers about 15 ms after the write); the time stops when the first chunk reaches the sink (a chunk is 40 ms long).
import {chromium} from 'playwright';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf('--' + name); return at >= 0 ? args[at + 1] : fallback; };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = path => import(pathToFileURL(resolve(root, path)).href);
const [{LocalSttCapture}, {MicTap, TapCapture}] = await Promise.all([load('bridge/local-stt-capture.mjs'), load('bridge/mic-tap.mjs')]);
const wait = ms => new Promise(done => setTimeout(done, ms));

const browser = await chromium.launch({channel: 'msedge', headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--mute-audio']});
try {
  const capture = new LocalSttCapture({getBrowser: async () => browser, deviceLabel: option('device', null)});
  const tap = new MicTap({capture, limits: {lingerMs: 60_000}});
  await capture.ensurePage();
  const turn = async id => {
    const t0 = performance.now();
    let first = null;
    const ready = tap.hold(id);
    tap.open('req-' + id, {holdId: id});
    const adapter = new TapCapture({tap});
    await adapter.begin(() => { first ??= performance.now() - t0; }, {requestId: 'req-' + id});
    while (first === null && performance.now() - t0 < 5000) await wait(5);
    const info = await ready;
    await wait(300);
    await tap.released(id); await adapter.abort();
    return {first: Math.round(first), device: info?.device};
  };
  const cold = [], lingering = [];
  let device = '';
  for (let i = 0; i < Number(option('cold', 2)); i++) {
    await tap.release(undefined, 'idle'); await capture.cool();
    await wait(Number(option('idle', 20)) * 1000);
    const r = await turn('c' + i); cold.push(r.first); device = r.device;
    for (let j = 0; j < Number(option('linger', 3)); j++) { await wait(1500); lingering.push((await turn(`l${i}-${j}`)).first); }
  }
  console.log(`device "${device}"\n  cold (after ${option('idle', 20)} s unused), press to first 40 ms chunk: [${cold.join(', ')}] ms\n  within the linger: [${lingering.join(', ')}] ms`);
} finally { await browser.close(); }
