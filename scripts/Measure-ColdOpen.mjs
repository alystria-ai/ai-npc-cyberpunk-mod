// Where the time goes between "the talk key went down" and "the first audio frame", on this computer's REAL default microphone (game closed).
//
//   node scripts/Measure-ColdOpen.mjs [--runs 5] [--cold 2] [--idle 20] [--json out.json]
//
// It opens the real default input device in the same kind of hidden Edge the bridge uses (same launch flags, a page served from memory, the microphone
// granted with grantPermissions) and records nothing: each open is closed again at once, only times are kept.
//   (a) the key-down signal: a file written the way the game writes it, noticed by the bridge's real directory watcher (bridge/file-wake.mjs), and
//       the interval poll that backs it up
//   (b) the bridge reaching the capture page: page.evaluate round trip on a reused page; creating the page; granting the permission
//   (c) getUserMedia resolving, for each set of constraints
//   (d) the AudioContext, the worklet and the first audio frame; or no AudioContext at all (MediaStreamTrackProcessor)
// "recent" = about 2 s after the previous open was closed; "cold" = after --idle seconds without any use of the device.
import {chromium} from 'playwright';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf('--' + name); return at >= 0 ? args[at + 1] : fallback; };
const RUNS = Number(option('runs', 5)), COLD = Number(option('cold', 2)), IDLE_S = Number(option('idle', 20));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(done => setTimeout(done, ms));
const median = list => { const sorted = [...list].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN; };
const round = value => Math.round(value * 10) / 10;

// ---- (a) the signal ----------------------------------------------------------------------------------------------------------------------
async function signal() {
  const {watchFiles} = await import(pathToFileURL(resolve(root, 'bridge/file-wake.mjs')).href);
  const folder = mkdtempSync(join(tmpdir(), 'cold-open-'));
  const woke = [];
  let wakeAt = 0;
  const wake = watchFiles(folder, {'microphone-live.json': () => { wakeAt = performance.now(); }});
  await wait(200);
  const out = [];
  for (let i = 0; i < 8; i++) {
    wakeAt = 0;
    const start = performance.now();
    writeFileSync(join(folder, 'microphone-live.json'), JSON.stringify({n: i, holdId: 'h' + i, down: true}));   // in place, truncating, like the game's io.open(path, 'wb')
    const written = performance.now();
    while (!wakeAt && performance.now() - written < 500) await wait(1);
    out.push({writeMs: round(written - start), wakeMs: wakeAt ? round(wakeAt - written) : null});
    await wait(150);
  }
  wake.close(); rmSync(folder, {recursive: true, force: true});
  void woke;
  return out;
}

// ---- the capture page: one instrumented open -----------------------------------------------------------------------------------------------
const PROBE = `
window.persist = {};
window.probe = async options => {
  const marks = {}; const t0 = performance.now(); const mark = name => { marks[name] = Math.round((performance.now() - t0) * 10) / 10; };
  const worklet = 'class P extends AudioWorkletProcessor{constructor(){super();this.arm=false;this.port.onmessage=e=>{if(e.data==="arm")this.arm=true;};}process(i){if(this.arm&&i[0]&&i[0][0]){this.arm=false;this.port.postMessage("frame");}return true;}}registerProcessor("probe",P);';
  const constraints = {audio: {channelCount: 1, ...options.constraints}};
  if (options.deviceLabel) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const found = devices.find(d => d.kind === 'audioinput' && d.label === options.deviceLabel);
    if (!found) throw Error('no input named ' + options.deviceLabel);
    constraints.audio.deviceId = {exact: found.deviceId};
  }
  const keep = options.keepContext ? window.persist : {};
  async function buildContext() {
    if (keep.context && keep.context.state !== 'closed') return;
    const contextOptions = {latencyHint: options.latencyHint || 'interactive'};
    if (options.sampleRate !== null) contextOptions.sampleRate = options.sampleRate || 16000;
    keep.context = new AudioContext(contextOptions);
    const url = URL.createObjectURL(new Blob([worklet], {type: 'text/javascript'}));
    try { await keep.context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    keep.node = new AudioWorkletNode(keep.context, 'probe', {numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit'});
    if (keep.context.state !== 'running') await keep.context.resume();
  }
  let stream, first;
  if (options.processor) {
    stream = await navigator.mediaDevices.getUserMedia(constraints); mark('getUserMedia');
    const track = stream.getAudioTracks()[0];
    const reader = new MediaStreamTrackProcessor({track}).readable.getReader();
    const {value} = await reader.read(); value?.close?.(); mark('firstFrame');
    await reader.cancel().catch(() => {});
  } else if (options.parallel) {
    const [s] = await Promise.all([navigator.mediaDevices.getUserMedia(constraints).then(r => { mark('getUserMedia'); return r; }), buildContext().then(() => mark('contextReady'))]);
    stream = s;
    first = new Promise(done => { keep.node.port.onmessage = () => done(); });
    const source = keep.context.createMediaStreamSource(stream); source.connect(keep.node); keep.node.port.postMessage('arm'); await first; mark('firstFrame');
  } else {
    stream = await navigator.mediaDevices.getUserMedia(constraints); mark('getUserMedia');
    await buildContext(); mark('contextReady');
    first = new Promise(done => { keep.node.port.onmessage = () => done(); });
    const source = keep.context.createMediaStreamSource(stream); source.connect(keep.node); keep.node.port.postMessage('arm'); await first; mark('firstFrame');
  }
  const label = stream.getAudioTracks()[0].label;
  stream.getTracks().forEach(track => track.stop());
  if (!options.keepContext && keep.context) { try { await keep.context.close(); } catch {} }
  return {marks, label};
};
`;

const CONSTRAINTS = {
  'all on (today)': {echoCancellation: true, noiseSuppression: true, autoGainControl: true},
  'all off': {echoCancellation: false, noiseSuppression: false, autoGainControl: false},
  'echo cancellation off only': {echoCancellation: false, noiseSuppression: true, autoGainControl: true},
  'browser defaults': {},
};
const VARIANTS = [
  ['today: all on, 16 kHz context, sequential', {constraints: CONSTRAINTS['all on (today)']}],
  ['echoCancellation off only', {constraints: CONSTRAINTS['echo cancellation off only']}],
  ['all processing off', {constraints: CONSTRAINTS['all off']}],
  ['browser default constraints', {constraints: CONSTRAINTS['browser defaults']}],
  ['context at the device rate (no 16 kHz)', {constraints: CONSTRAINTS['all on (today)'], sampleRate: null}],
  ['latencyHint playback', {constraints: CONSTRAINTS['all on (today)'], latencyHint: 'playback'}],
  ['getUserMedia and context in parallel', {constraints: CONSTRAINTS['all on (today)'], parallel: true}],
  ['context + worklet kept alive, only the device opens', {constraints: CONSTRAINTS['all on (today)'], keepContext: true}],
  ['no AudioContext: MediaStreamTrackProcessor', {constraints: CONSTRAINTS['all on (today)'], processor: true}],
  ['no AudioContext, all processing off', {constraints: CONSTRAINTS['all off'], processor: true}],
];

async function main() {
  console.log('(a) the key-down signal, the game\'s write noticed by the bridge\'s directory watcher:');
  const sig = await signal();
  console.log('    write ms', sig.map(s => s.writeMs).join(' '), '| watcher wake ms', sig.map(s => s.wakeMs).join(' '),
    '| median wake', median(sig.map(s => s.wakeMs).filter(v => v !== null)), 'ms (the interval poll behind it: 150 ms for the command, 500 ms for the live file)');

  const {LocalSttCapture} = await import(pathToFileURL(resolve(root, 'bridge/local-stt-capture.mjs')).href);
  const browser = await chromium.launch({channel: 'msedge', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--mute-audio']});
  const results = {signal: sig, page: {}, variants: []};
  try {
    // (b) the bridge's capture page, created cold and reused
    const capture = new LocalSttCapture({getBrowser: async () => browser});
    const created = performance.now();
    const page = await capture.ensurePage();
    results.page.createMs = round(performance.now() - created);
    const trips = [];
    for (let i = 0; i < 20; i++) { const s = performance.now(); await page.evaluate(() => 1); trips.push(performance.now() - s); }
    results.page.evaluateMs = round(median(trips));
    const grants = [];
    for (let i = 0; i < 5; i++) { const s = performance.now(); await page.context().grantPermissions(['microphone'], {origin: capture.origin}); grants.push(performance.now() - s); }
    results.page.grantMs = round(median(grants));
    console.log(`(b) reaching the page: creating the capture page ${results.page.createMs} ms (once per browser), page.evaluate round trip ${results.page.evaluateMs} ms (median of 20), grantPermissions ${results.page.grantMs} ms`);

    // (c) and (d) on a probe page
    const probe = await browser.newPage();
    await probe.route('**/*', route => route.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><title>probe</title>'}));
    await probe.goto('http://127.0.0.1:1/probe');
    await probe.context().grantPermissions(['microphone'], {origin: 'http://127.0.0.1:1'});
    await probe.evaluate(PROBE);
    let device = '';
    const run = async (name, options, cold) => {
      const samples = [];
      for (let i = 0; i < (cold ? COLD : RUNS); i++) {
        if (cold) await wait(IDLE_S * 1000); else await wait(i === 0 ? 300 : 2000);
        if (options.keepContext && i === 0) await probe.evaluate(o => window.probe({...o, constraints: o.constraints}), options).catch(() => {});   // the kept context is built once, before the press
        const answer = await probe.evaluate(o => window.probe(o), options);
        device = answer.label;
        samples.push(answer.marks);
      }
      const med = key => round(median(samples.map(m => m[key]).filter(v => v !== undefined)));
      const row = {name, cold, runs: samples.length, getUserMedia: med('getUserMedia'), contextReady: med('contextReady'), firstFrame: med('firstFrame'),
        all: samples.map(m => m.firstFrame)};
      results.variants.push(row);
      console.log(`${cold ? 'cold  ' : 'recent'} ${name.padEnd(54)} getUserMedia ${String(row.getUserMedia).padStart(6)}  context+worklet ${String(row.contextReady).padStart(6)}  first frame ${String(row.firstFrame).padStart(6)} ms   [${row.all.join(', ')}]`);
    };
    console.log('(c)+(d) key down at the page to the first audio frame, medians of ' + RUNS + ' (cold: ' + COLD + ' after ' + IDLE_S + ' s idle):');
    for (const [name, options] of VARIANTS) await run(name, options, false);
    // the device alone: the Windows floor
    for (const [name, options] of [VARIANTS[0], VARIANTS[7], VARIANTS[9]]) await run(name, options, true);
    results.device = device;
    console.log('default device:', device);
    // the same variants taken in turns, so a slow stretch of the Bluetooth link cannot favour one of them
    console.log('interleaved (5 rounds, recent):');
    const turns = [VARIANTS[0], VARIANTS[4], VARIANTS[5], VARIANTS[6]];
    const interleaved = new Map(turns.map(([name]) => [name, []]));
    for (let round = 0; round < 5; round++) for (const [name, options] of turns) {
      await wait(2000);
      const answer = await probe.evaluate(o => window.probe(o), options);
      interleaved.get(name).push(answer.marks);
    }
    for (const [name, list] of interleaved) {
      const med = key => round(median(list.map(m => m[key]).filter(v => v !== undefined)));
      console.log(`    ${name.padEnd(54)} getUserMedia ${String(med('getUserMedia')).padStart(6)}  context ${String(med('contextReady')).padStart(6)}  first frame ${String(med('firstFrame')).padStart(6)} ms  [${list.map(m => m.firstFrame).join(', ')}]`);
    }
    // how long after a close the next open stays quick (the Bluetooth link back in its call profile): --gaps 5,10,15 (seconds)
    const gaps = String(option('gaps', '')).split(',').filter(Boolean).map(Number);
    results.gaps = {};
    for (const gap of gaps) {
      const times = [];
      for (let i = 0; i < 2; i++) { await wait(gap * 1000); times.push((await probe.evaluate(o => window.probe(o), {constraints: CONSTRAINTS['all off'], processor: true})).marks.firstFrame); }
      results.gaps[gap] = times;
      console.log(`    ${gap} s after the previous close: first frame [${times.join(', ')}] ms`);
    }
    // each physical input on its own: is the device alone already slow?
    const labels = await probe.evaluate(() => navigator.mediaDevices.enumerateDevices().then(list => list.filter(d => d.kind === 'audioinput' && !/^(Default|Communications) - /.test(d.label)).map(d => d.label)));
    results.devices = {};
    for (const label of labels) {
      const options = {constraints: CONSTRAINTS['all off'], processor: true, deviceLabel: label};
      const recent = [], cold = [];
      if (option('skipDevices', null)) break;
      for (let i = 0; i < 4; i++) { await wait(i ? 2000 : 300); recent.push((await probe.evaluate(o => window.probe(o), options)).marks.firstFrame); }
      for (let i = 0; i < COLD; i++) { await wait(IDLE_S * 1000); cold.push((await probe.evaluate(o => window.probe(o), options)).marks.firstFrame); }
      results.devices[label] = {recent, cold};
      console.log(`    input "${label}": first frame recent [${recent.join(', ')}] ms, cold after ${IDLE_S} s [${cold.join(', ')}] ms (no AudioContext, processing off)`);
    }
  } finally { await browser.close(); }
  const out = option('json', null);
  if (out) writeFileSync(out, JSON.stringify(results, null, 2));
}
await main();
