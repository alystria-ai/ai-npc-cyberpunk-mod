// Development measurement: is the renderer's heard position (what subtitles and
// the face follow) the moment the audio actually reaches the Windows output mix?
// Plays three faint (-50 dBFS) 2 kHz ticks through the real ContinuousPcmPlayer
// in headless Edge, logs its reported position against the wall clock, records
// the output mix with the WASAPI loopback meter, and prints, per tick, how much
// later the sound reached the mix than the clock said (positive = the face leads).
// Bluetooth/headset transmission after the Windows mix is not visible to it.
//   node scripts/audio-level/measure-playback-clock.mjs [--makeup 0,6]
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(root, 'runtime/audio-level'); await mkdir(out, {recursive: true});
const wav = resolve(out, 'clock.wav');
const index = process.argv.indexOf('--makeup');
const makeups = (index > 0 ? process.argv[index + 1] : '0,6').split(',').map(Number);
const seconds = 3 + makeups.length * 4.5;

// 1. Loopback recorder; playback starts once it is capturing.
const recorder = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  resolve(root, 'scripts/audio-level/Measure-OutputLoudness.ps1'), '-Seconds', String(seconds), '-Output', wav]);
let log = '';
const capturing = new Promise(resolveStart => recorder.stdout.on('data', chunk => {
  log += chunk; if (/Recording/.test(log)) resolveStart();
}));
recorder.stderr.on('data', chunk => { log += chunk; });
const recorded = new Promise(done => recorder.on('exit', done));
await capturing;
await new Promise(r => setTimeout(r, 1200));

// 2. The real renderer in Edge, audible (not muted), same flags as the bridge.
const allowed = new Set(['/continuous-pcm-player.mjs', '/continuous-pcm-worklet.mjs', '/continuous-pcm-core.mjs']);
const server = createServer(async (request, response) => {
  if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Clock</title>'); return; }
  if (!allowed.has(request.url)) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', 'text/javascript');
  response.end(await readFile(resolve(root, 'bridge', request.url.slice(1))));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({channel: 'msedge', headless: true, ignoreDefaultArgs: ['--mute-audio'],
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling']});
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}`);
const trials = [];
for (const makeupDb of makeups) {
  trials.push(await page.evaluate(async makeupDb => {
    const {ContinuousPcmPlayer} = await import('/continuous-pcm-player.mjs');
    const rate = 24000, ticks = [0.6, 1.6, 2.6], length = rate * 3.2;
    const pcm = new Int16Array(length);
    for (const at of ticks) for (let i = 0; i < rate * 0.04; i++)
      pcm[Math.round(at * rate) + i] = Math.round(32767 * 0.00316 * Math.sin(2 * Math.PI * 2000 * i / rate));
    const player = new ContinuousPcmPlayer();
    await player.open({sampleRate: rate, channels: 1, token: 'clock-' + makeupDb});
    const control = () => player.control({allow: true, paused: false, volume: 1, pan: 0, makeupDb, distance: 1});
    await player.append(new Uint8Array(pcm.buffer), 0); await player.end(length);
    control();
    const samples = [], started = performance.now();
    while (performance.now() - started < 4000) {
      const s = player.snapshot();
      samples.push([performance.timeOrigin + performance.now(), s.positionSeconds]);
      if (s.ended || s.error) break;
      if (samples.length % 10 === 0) control();
      await new Promise(r => setTimeout(r, 5));
    }
    const context = player.context;
    const latency = {outputLatency: context?.outputLatency, baseLatency: context?.baseLatency};
    await player.stop();
    return {makeupDb, ticks, samples, latency};
  }, makeupDb));
  await new Promise(r => setTimeout(r, 400));
}
await browser.close(); server.close();
await recorded;

// 3. Tick onsets in the recording, on the shared wall clock.
const clock = JSON.parse(readFileSync(wav.replace(/\.wav$/, '.clock.json'), 'utf8'));
const bytes = readFileSync(wav);
const dataAt = bytes.indexOf('data') + 8, channels = bytes.readUInt16LE(22), rate = bytes.readUInt32LE(24);
const frames = (bytes.length - dataAt) / 4 / channels;
const mono = new Float32Array(frames);
for (let i = 0; i < frames; i++) mono[i] = bytes.readFloatLE(dataAt + i * 4 * channels);
// 2 kHz envelope: quadrature demodulation over 2 ms windows.
const win = Math.round(rate * 0.002), env = new Float32Array(Math.floor(frames / win));
for (let w = 0; w < env.length; w++) {
  let c = 0, s = 0;
  for (let i = w * win; i < (w + 1) * win; i++) { const ph = 2 * Math.PI * 2000 * i / rate; c += mono[i] * Math.cos(ph); s += mono[i] * Math.sin(ph); }
  env[w] = Math.hypot(c, s) / win;
}
// Onset near each predicted moment: the first 2 ms window above half of the
// strongest 2 kHz window within -150..+400 ms, refined to the sample.
const onsetNear = wallMs => {
  const centre = Math.round((wallMs - clock.wallStartMs) / 1000 * rate / win);
  const from = Math.max(1, centre - Math.round(0.15 * rate / win)), to = Math.min(env.length - 1, centre + Math.round(0.4 * rate / win));
  let top = 0; for (let w = from; w <= to; w++) top = Math.max(top, env[w]);
  if (top < 1e-5) return undefined;
  for (let w = from; w <= to; w++) if (env[w] >= top * 0.5) {
    let i = (w - 1) * win; const level = top; // envelope = amplitude / 2
    while (i < (w + 1) * win && Math.abs(mono[i]) < level) i++;
    return clock.wallStartMs + i / rate * 1000;
  }
};
const onsets = [];
let k = 0;
for (const trial of trials) {
  const predicted = trial.ticks.map(at => {
    const s = trial.samples, j = s.findIndex(([, p]) => p >= at);
    if (j <= 0) return NaN;
    const [w0, p0] = s[j - 1], [w1, p1] = s[j];
    return w0 + (at - p0) / Math.max(1e-9, p1 - p0) * (w1 - w0);
  });
  const offsets = predicted.map(p => {
    const actual = Number.isFinite(p) ? onsetNear(p) : undefined; if (actual !== undefined) onsets.push(actual);
    return actual === undefined ? null : +(actual - p).toFixed(1);
  });
  console.log(JSON.stringify({makeupDb: trial.makeupDb, latencyMs: {output: +(trial.latency.outputLatency * 1000).toFixed(1),
    base: +(trial.latency.baseLatency * 1000).toFixed(1)}, audioAfterClockMs: offsets}));
  k++;
}
if (!onsets.length) console.log('No ticks found in the recording (output muted or another device?).', log.slice(-400));
