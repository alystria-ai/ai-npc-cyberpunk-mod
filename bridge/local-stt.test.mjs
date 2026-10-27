import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {constants as osConstants} from 'node:os';
import {PriorityGate} from './process-priority.mjs';
import {fileURLToPath} from 'node:url';
import {LocalStt, MODEL_FILES, LOCAL_STT_LIMITS, DEFAULT_FIXUPS, resolveLocalSttPaths} from './local-stt.mjs';

const tick = (ms = 5) => new Promise(done => setTimeout(done, ms));
const pcm = (ms, level = 1000) => Buffer.from(new Int16Array(16 * ms).fill(level).buffer);
const ALL = new Set(['/py/python.exe', '/app/bridge/local-stt-worker.py', '/py/Lib/site-packages/sherpa_onnx',
  ...MODEL_FILES.map(name => '/model/' + name)]);
const paths = {python: '/py/python.exe', worker: '/app/bridge/local-stt-worker.py', modelDirectory: '/model'};
const existsIn = files => path => files.has(String(path).replace(/^[A-Za-z]:/, '').replaceAll('\\', '/'));

// A fake worker process: records the lines it was sent and answers like bridge/local-stt-worker.py.
function fakeWorker({readyAfter = 0, finalText = 'hello judy', speech = true, silent = false, finalExtra = {}} = {}) {
  const spawned = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 4242; child.killed = false;
    child.kill = () => { child.killed = true; child.emit('exit', null); };
    const record = {command, args, lines: [], child};
    spawned.push(record);
    let bytes = 0;
    const reply = message => child.stdout.write(JSON.stringify(message) + '\n');
    child.stdin.setEncoding('utf8');
    let pending = '';
    child.stdin.on('data', text => {
      pending += text;
      let at;
      while ((at = pending.indexOf('\n')) >= 0) {
        const message = JSON.parse(pending.slice(0, at)); pending = pending.slice(at + 1);
        record.lines.push(message);
        if (message.op === 'audio') bytes += Buffer.from(message.pcm, 'base64').length;
        if (message.op === 'quit') setImmediate(() => { if (!child.killed) child.emit('exit', 0); });   // the real worker leaves on quit
        if (silent) continue;
        if (message.op === 'partial') reply({type: 'partial', id: message.id, text: 'heard ' + bytes + ' bytes', ms: 5});
        if (message.op === 'finish') {
          reply({type: 'final', id: message.id, text: finalText, ms: 12, seconds: bytes / 32000, speech, ...finalExtra});
          bytes = 0;
        }
      }
    });
    setTimeout(() => { if (!silent) reply({type: 'ready', engine: 'fake', threads: 2, loadMs: 1}); }, readyAfter);
    return child;
  };
  return {spawnImpl, spawned};
}
const make = (worker, extra = {}) => new LocalStt({paths, exists: existsIn(ALL), spawnImpl: worker.spawnImpl, partialIntervalMs: 15,
  lowerPriority: false, idleMs: 60, ...extra});

test('available() is false, with the reason, for every missing piece', () => {
  const without = file => new LocalStt({paths, exists: existsIn(new Set([...ALL].filter(item => item !== file)))});
  assert.deepEqual(new LocalStt({paths, exists: existsIn(ALL)}).availability(), {available: true, reason: null});
  assert.equal(new LocalStt({paths, exists: existsIn(ALL)}).available(), true);
  assert.equal(without('/py/python.exe').availability().reason, 'python-missing');
  assert.equal(without('/app/bridge/local-stt-worker.py').availability().reason, 'worker-missing');
  assert.equal(without('/model/encode.int8.onnx').availability().reason, 'model-missing');
  assert.equal(without('/py/Lib/site-packages/sherpa_onnx').availability().reason, 'engine-missing');
  assert.equal(new LocalStt({paths: {...paths, python: null}, exists: existsIn(ALL)}).available(), false);
  assert.equal(new LocalStt({paths: {...paths, modelDirectory: null}, exists: existsIn(ALL)}).availability().reason, 'model-missing');
});

test('start() on an unavailable install throws a coded error and never spawns', async () => {
  const worker = fakeWorker();
  const stt = new LocalStt({paths, exists: existsIn(new Set()), spawnImpl: worker.spawnImpl});
  await assert.rejects(stt.start('r1'), error => error.code === 'local-stt-unavailable' && error.reason === 'python-missing');
  assert.equal(worker.spawned.length, 0);
  await assert.rejects(stt.finish('r1'), /No recording/);
});

test('path resolution: packaged models/stt, development runtime/stt-model, environment overrides', () => {
  const have = new Set(['/app/models/stt/moonshine-tiny-en-int8']);
  const seen = resolveLocalSttPaths({project: '/app', environment: {CYBERPUNK_CONVAI_PYTHON: '/p/python.exe'}, pythonExecutable: undefined});
  assert.equal(seen.python, '/p/python.exe');
  assert.ok(seen.worker.replaceAll('\\', '/').endsWith('/app/bridge/local-stt-worker.py'));
  assert.ok(seen.modelDirectory.replaceAll('\\', '/').endsWith('/app/models/stt/moonshine-tiny-en-int8'), 'first candidate when none exists');
  const env = resolveLocalSttPaths({project: '/app', environment: {CYBERPUNK_CONVAI_STT_MODEL: '/m', CYBERPUNK_CONVAI_LOCAL_STT_PYTHON: '/own.exe'},
    pythonExecutable: '/ignored.exe'});
  assert.equal(env.python, '/own.exe'); assert.equal(env.modelDirectory, '/m');
  assert.equal(have.size, 1);
});

test('the worker is set to the level the bridge names: high for good, else below normal; a refusal changes nothing', async () => {
  const calls = [];
  const set = (pid, level) => calls.push([pid, level]);
  const high = fakeWorker();
  const sttHigh = make(high, {lowerPriority: true, setPriorityImpl: set, priority: 'high'});
  await sttHigh.start('r1');
  assert.deepEqual(high.spawned[0].args.slice(-2), ['--priority', 'high']);
  assert.deepEqual(calls, [[4242, osConstants.priority.PRIORITY_HIGH]], 'HIGH (-14), never HIGHEST (-20, the realtime class)');
  assert.notEqual(calls[0][1], osConstants.priority.PRIORITY_HIGHEST);
  await sttHigh.close?.();
  calls.length = 0;
  const low = fakeWorker();
  const sttLow = make(low, {lowerPriority: true, setPriorityImpl: set});
  await sttLow.start('r1');
  assert.deepEqual(calls, [[4242, osConstants.priority.PRIORITY_BELOW_NORMAL]], 'the default level (normal / below chosen by the player) is the old behaviour');
  const refused = fakeWorker();
  const sttRefused = make(refused, {lowerPriority: true, priority: 'high', setPriorityImpl() { throw Error('access denied'); }});
  await sttRefused.start('r1');
});

test('title-screen gate: a high worker starts at normal while the gate is closed and is set high by pid and told to switch when it opens; a replaced, dead, below or normal worker is untouched', async () => {
  const HIGH = osConstants.priority.PRIORITY_HIGH, BELOW = osConstants.priority.PRIORITY_BELOW_NORMAL;
  const calls = [];
  const set = (pid, level) => calls.push([pid, level]);
  const priorityLines = worker => worker.spawned.flatMap(record => record.lines.filter(line => line.op === 'priority'));
  // Closed: --priority normal, no by-pid change, nothing sent until the gate opens.
  const closed = new PriorityGate({open: false});
  const held = fakeWorker();
  const stt = make(held, {lowerPriority: true, setPriorityImpl: set, priority: 'high', gate: closed});
  await stt.start('r1');
  assert.deepEqual(held.spawned[0].args.slice(-2), ['--priority', 'normal']);
  assert.deepEqual(calls, []);
  assert.equal(closed.waiting.length, 1);
  closed.close(); closed.open('world');
  assert.deepEqual(calls, [[4242, HIGH]], 'set high by pid on open');
  await tick(20);
  assert.deepEqual(priorityLines(held), [{op: 'priority', level: 'high'}], 'and told once');
  await stt.close();

  // Open (the default and the shared gate): unchanged, high from the spawn, no command.
  calls.length = 0;
  const open = fakeWorker();
  const sttOpen = make(open, {lowerPriority: true, setPriorityImpl: set, priority: 'high', gate: new PriorityGate()});
  await sttOpen.start('r1'); await tick(20);
  assert.deepEqual(open.spawned[0].args.slice(-2), ['--priority', 'high']);
  assert.deepEqual(calls, [[4242, HIGH]]);
  assert.deepEqual(priorityLines(open), []);
  await sttOpen.close();

  // The worker is closed (and a new one spawned) before the gate opens: the old one is not raised, the new one is, once.
  calls.length = 0;
  const gate2 = new PriorityGate({open: false});
  const replaced = fakeWorker();
  const sttReplaced = make(replaced, {lowerPriority: true, setPriorityImpl: set, priority: 'high', gate: gate2});
  await sttReplaced.start('r1'); await sttReplaced.close();
  assert.equal(gate2.waiting.length, 0, 'the first worker left, its raiser went with it');
  await sttReplaced.start('r2');
  assert.equal(replaced.spawned.length, 2);
  assert.equal(gate2.waiting.length, 1);
  gate2.close(); gate2.open('turn'); await tick(20);
  assert.deepEqual(calls, [[4242, HIGH]], 'one raise, for the live worker');
  assert.equal(replaced.spawned[0].lines.filter(line => line.op === 'priority').length, 0);
  assert.equal(replaced.spawned[1].lines.filter(line => line.op === 'priority').length, 1);
  await sttReplaced.close();

  // 'below' (the default) and a player's normal never depend on the gate.
  calls.length = 0;
  const gate3 = new PriorityGate({open: false});
  const below = fakeWorker();
  const sttBelow = make(below, {lowerPriority: true, setPriorityImpl: set, gate: gate3});
  await sttBelow.start('r1');
  assert.deepEqual(below.spawned[0].args.slice(-2), ['--priority', 'below']);
  assert.deepEqual(calls, [[4242, BELOW]]);
  const normal = fakeWorker();
  const sttNormal = make(normal, {lowerPriority: true, setPriorityImpl: set, priority: 'normal', gate: gate3});
  await sttNormal.start('r1');
  assert.deepEqual(normal.spawned[0].args.slice(-2), ['--priority', 'normal']);
  assert.equal(gate3.waiting.length, 0);
  gate3.close(); gate3.open('world'); await tick(20);
  assert.equal(calls.some(([, level]) => level === HIGH), false, 'nothing is raised on open');
  assert.deepEqual(priorityLines(below).concat(priorityLines(normal)), []);
  await sttBelow.close(); await sttNormal.close();

  // The protocol is documented where the worker is.
  const worker = readFileSync(resolve(fileURLToPath(new URL('.', import.meta.url)), 'local-stt-worker.py'), 'utf8');
  assert.match(worker, /\{"op":"priority","level":"high"\}/);
});

test('chunks pushed while the model loads are held, then flushed in order after begin; finish returns the polished text', async () => {
  const worker = fakeWorker({readyAfter: 40, finalText: 'hey pan am, meet me at the after life'});
  const stt = make(worker);
  await stt.start('r1');
  assert.deepEqual(worker.spawned[0].args.slice(-6), ['--model', '/model', '--threads', '1', '--priority', 'below']);
  assert.equal(stt.pushAudio(pcm(100), 'r1'), true);
  assert.equal(stt.pushAudio(pcm(100), 'r1'), true);
  assert.equal(worker.spawned[0].lines.length, 0, 'nothing is sent before the worker is ready');
  const done = stt.finish('r1');
  const result = await done;
  const ops = worker.spawned[0].lines.map(line => line.op);
  assert.deepEqual(ops.filter(op => op !== 'partial'), ['begin', 'audio', 'audio', 'finish']);
  assert.equal(result.text, 'hey Panam, meet me at the Afterlife');
  assert.equal(result.speech, true);
  assert.equal(stt.pushAudio(pcm(100)), false, 'a finished recording takes no more audio');
  await stt.close();
});

test('partials stream into onPartial/heard while recording and stop at finish', async () => {
  const worker = fakeWorker();
  const stt = make(worker);
  const partials = [];
  stt.on('partial', event => partials.push(event));
  await stt.start('r1');
  await stt.warm();
  for (let i = 0; i < 6; i++) { stt.pushAudio(pcm(100), 'r1'); await tick(12); }
  await tick(40);
  assert.ok(partials.length >= 1, 'at least one live-words update');
  assert.equal(partials[0].requestId, 'r1');
  assert.match(partials[0].text, /^heard \d+ bytes$/);
  assert.equal(stt.heard('r1'), partials.at(-1).text);
  assert.equal(stt.heard('other'), '');
  const sent = worker.spawned[0].lines.filter(line => line.op === 'partial').length;
  assert.ok(sent >= 1 && sent <= 6, 'partials are throttled: ' + sent);
  await stt.finish('r1');
  const after = worker.spawned[0].lines.filter(line => line.op === 'partial').length;
  await tick(50);
  assert.equal(worker.spawned[0].lines.filter(line => line.op === 'partial').length, after, 'no partial after finish');
  assert.equal(stt.heard('r1'), '');
  await stt.close();
});

test('partials can be switched off', async () => {
  const worker = fakeWorker();
  const stt = make(worker, {partials: false});
  await stt.start('r1'); await stt.warm();
  for (let i = 0; i < 4; i++) { stt.pushAudio(pcm(200), 'r1'); await tick(10); }
  await tick(40);
  assert.equal(worker.spawned[0].lines.filter(line => line.op === 'partial').length, 0);
  await stt.close();
});

test('a recording with no speech finishes with empty text, and punctuation-only output counts as none', async () => {
  const silentWorker = fakeWorker({finalText: '', speech: false});
  const quiet = make(silentWorker);
  await quiet.start('r1'); quiet.pushAudio(pcm(300, 0), 'r1');
  const nothing = await quiet.finish('r1');
  assert.equal(nothing.text, ''); assert.equal(nothing.speech, false);
  await quiet.close();
  const dotty = make(fakeWorker({finalText: ' . ... ', speech: true}));
  await dotty.start('r2'); dotty.pushAudio(pcm(300), 'r2');
  assert.equal((await dotty.finish('r2')).text, '');
  await dotty.close();
});

test('cancel drops the recording: the worker is told, a pending finish rejects, late audio is ignored', async () => {
  const worker = fakeWorker({readyAfter: 30});
  const stt = make(worker);
  await stt.start('r1'); stt.pushAudio(pcm(100), 'r1');
  const pending = stt.finish('r1');
  const outcome = assert.rejects(pending, error => error.code === 'cancelled');
  await stt.cancel('r1');
  await outcome;
  assert.equal(stt.pushAudio(pcm(100), 'r1'), false);
  await assert.rejects(stt.finish('r1'), /No recording/);
  await tick(60);
  assert.equal(worker.spawned[0].lines.some(line => line.op === 'finish'), false, 'a cancelled recording is never decoded');
  await stt.close();
});

test('spam: a new start supersedes the open recording; the old id is dead and the new one works', async () => {
  const worker = fakeWorker({finalText: 'second'});
  const stt = make(worker);
  await stt.start('r1'); await stt.warm(); stt.pushAudio(pcm(100), 'r1');
  await stt.start('r2'); stt.pushAudio(pcm(100), 'r2');
  assert.equal(stt.pushAudio(pcm(100), 'r1'), false);
  await assert.rejects(stt.finish('r1'), /No recording/);
  assert.equal((await stt.finish('r2')).text, 'second');
  assert.equal(worker.spawned.length, 1, 'one worker serves both');
  const ops = worker.spawned[0].lines.map(line => line.op + ':' + line.id).filter(line => !line.startsWith('partial'));
  assert.deepEqual(ops, ['begin:r1', 'audio:r1', 'cancel:r1', 'begin:r2', 'audio:r2', 'finish:r2']);
  await stt.close();
});

test('audio beyond the limit is ignored', async () => {
  const stt = make(fakeWorker());
  await stt.start('r1'); await stt.warm();
  const second = pcm(1000);
  let accepted = 0;
  for (let i = 0; i < LOCAL_STT_LIMITS.maxSeconds + 5; i++) if (stt.pushAudio(second, 'r1')) accepted++;
  assert.equal(accepted, LOCAL_STT_LIMITS.maxSeconds);
  await stt.close();
});

test('the worker dying mid-recording rejects finish, emits failure, and the next start spawns a fresh worker', async () => {
  const worker = fakeWorker();
  const stt = make(worker);
  const failures = [];
  stt.on('failure', error => failures.push(error.message));
  await stt.start('r1'); await stt.warm(); stt.pushAudio(pcm(100), 'r1');
  worker.spawned[0].child.emit('exit', 1);
  await assert.rejects(stt.finish('r1'), /stopped \(exit 1\)/);
  assert.equal(failures.length, 1);
  await stt.start('r2');
  assert.equal(worker.spawned.length, 2);
  await stt.warm();
  assert.equal((await stt.finish('r2')).text, 'hello judy');
  await stt.close();
});

test('a worker that never becomes ready fails the recording instead of hanging', async () => {
  const worker = fakeWorker({silent: true});
  const stt = make(worker, {startupMs: 40});
  await stt.start('r1'); stt.pushAudio(pcm(100), 'r1');
  await assert.rejects(stt.finish('r1'), /too long to start|timed out/);
  assert.equal(worker.spawned[0].child.killed, true);
  await stt.close();
});

test('the worker exits after the idle time and nothing runs between recordings', async () => {
  const worker = fakeWorker();
  const stt = make(worker, {idleMs: 30});
  await stt.start('r1'); await stt.warm(); stt.pushAudio(pcm(100), 'r1');
  await stt.finish('r1');
  assert.equal(worker.spawned[0].lines.at(-1).op, 'finish');
  await tick(90);
  assert.equal(worker.spawned[0].lines.at(-1).op, 'quit', 'told to quit when idle');
  const lines = worker.spawned[0].lines.length;
  await tick(60);
  assert.equal(worker.spawned[0].lines.length, lines, 'no traffic while idle');
  await stt.start('r2');
  assert.equal(worker.spawned.length, 2, 'a later recording starts a fresh worker');
  await stt.close();
});

test('threads are clamped to 1-4 and passed to the worker', async () => {
  for (const [asked, used] of [[0, 1], [3, 3], [32, 4]]) {
    const worker = fakeWorker();
    const stt = make(worker, {threads: asked});
    await stt.start('r'); await stt.close();
    assert.equal(worker.spawned[0].args[worker.spawned[0].args.indexOf('--threads') + 1], String(used));
  }
});

test('fixups repair the game names Moonshine mishears, and can be replaced', () => {
  const stt = new LocalStt({paths, exists: existsIn(ALL)});
  assert.equal(stt.polish('Pan M can you cover me'), 'Panam can you cover me');
  assert.equal(stt.polish('meet at the after life'), 'meet at the Afterlife');
  assert.equal(stt.polish('tell me about Ares Acha Tower'), 'tell me about Arasaka Tower');
  assert.equal(stt.polish('Panamera'), 'Panamera');
  assert.equal(new LocalStt({paths, exists: existsIn(ALL), fixups: []}).polish('after life'), 'after life');
  assert.ok(DEFAULT_FIXUPS.length >= 3);
  const long = stt.shorten('word '.repeat(80));
  assert.ok([...long].length <= 101 && long.startsWith('…'));
});

// The real Python worker and model, when this machine has them (a developer machine, or the packaged runtime).
const here = fileURLToPath(new URL('..', import.meta.url));
// A real Python process and model: when the whole suite runs at once it can take far longer than the 30 s production allowance to load.
const REAL_WORKER_LIMITS = {startupMs: 120_000, finishMs: 60_000,
  // Normal priority: the production worker runs below normal so a decode never competes with the game, which on a computer
  // busy with the whole suite starves it for minutes.
  lowerPriority: false, priority: 'normal'};
const real = new LocalStt({project: here, pythonExecutable: resolve(here, 'vendor/pocket-tts-env/Scripts/python.exe'), ...REAL_WORKER_LIMITS});
const sample = new URL('./fixtures/local-stt-sample.wav', import.meta.url);
test('real worker: silence is no speech, and a clean read decodes to its words', {skip: !real.available() && 'local speech recognition is not installed here'}, async () => {
  await real.start('silence');
  real.pushAudio(Buffer.alloc(32000 * 2), 'silence');
  const silence = await real.finish('silence');
  assert.equal(silence.text, ''); assert.equal(silence.speech, false);
  if (existsSync(sample)) {
    const wav = readFileSync(sample).subarray(44);
    await real.start('read');
    for (let at = 0; at < wav.length; at += 3200) real.pushAudio(wav.subarray(at, at + 3200), 'read');
    const result = await real.finish('read');
    assert.match(result.text, /manner less interesting/i);
    assert.ok(result.ms < 3000, 'final decode ' + result.ms + ' ms');
    // With a live-words decode that already covered the clip and only silence after it, finish decodes nothing again.
    const quick = new LocalStt({project: here, pythonExecutable: resolve(here, 'vendor/pocket-tts-env/Scripts/python.exe'), partialIntervalMs: 100, ...REAL_WORKER_LIMITS});
    const partials = [];
    quick.on('partial', event => partials.push(event.text));
    await quick.start('reuse');
    for (let at = 0; at < wav.length; at += 3200) quick.pushAudio(wav.subarray(at, at + 3200), 'reuse');
    quick.pushAudio(Buffer.alloc(32000 * 2), 'reuse');
    for (let waited = 0; waited < 20000 && !partials.some(text => /matter/i.test(text)); waited += 100) await tick(100);
    const reused = await quick.finish('reuse');
    assert.match(reused.text, /manner less interesting/i);
    assert.equal(reused.reused, true);
    assert.ok(reused.ms < 100, 'reused text returned in ' + reused.ms + ' ms');
    await quick.close();
  }
  await real.close();
});

test('finish carries what the microphone gave and why words were held back, for the bridge log', async () => {
  const levels = {peakDb: -23.5, soundMs: 1200, voicedMs: 540};
  const heard = await (async () => { const stt = make(fakeWorker({finalExtra: levels})); await stt.start('r1'); stt.pushAudio(pcm(100), 'r1'); return stt.finish('r1'); })();
  assert.deepEqual([heard.peakDb, heard.soundMs, heard.voicedMs, heard.rejected, heard.ignored], [-23.5, 1200, 540, null, '']);
  const held = await (async () => { const stt = make(fakeWorker({finalText: '', finalExtra: {...levels, rejected: 'not-voiced', ignored: 'Thank you.'}})); await stt.start('r2'); stt.pushAudio(pcm(100), 'r2'); return stt.finish('r2'); })();
  assert.deepEqual([held.text, held.rejected, held.ignored], ['', 'not-voiced', 'Thank you.']);
  const older = await (async () => { const stt = make(fakeWorker()); await stt.start('r3'); stt.pushAudio(pcm(100), 'r3'); return stt.finish('r3'); })();
  assert.deepEqual([older.peakDb, older.rejected], [null, null], 'a worker that reports nothing about levels leaves them unknown');
});

// ---- the multilingual packs (bridge/speech-language.mjs LOCAL_PACKS), run by the same class ----
import {LOCAL_PACKS} from './speech-language.mjs';

test('a pack is looked for in its own folder, needs its own files, and starts the worker with --kind', async () => {
  const parakeet = LOCAL_PACKS.find(pack => pack.kind === 'nemo-transducer'), sense = LOCAL_PACKS.find(pack => pack.kind === 'sense-voice');
  const folder = '/app/models/stt/' + parakeet.id;
  const files = new Set(['/py/python.exe', '/app/bridge/local-stt-worker.py', '/py/Lib/site-packages/sherpa_onnx', ...parakeet.files.map(name => folder + '/' + name)]);
  const resolved = resolveLocalSttPaths({project: '/app', environment: {}, pythonExecutable: '/py/python.exe', engine: parakeet});
  assert.ok(resolved.modelDirectory.replaceAll('\\', '/').endsWith('/app/models/stt/' + parakeet.id), 'packaged folder first');
  // The English model's own variable does not point a pack at the English folder.
  const english = resolveLocalSttPaths({project: '/app', environment: {CYBERPUNK_CONVAI_STT_MODEL: '/english'}, engine: parakeet});
  assert.ok(!english.modelDirectory.startsWith('/english'));
  assert.equal(resolveLocalSttPaths({project: '/app', environment: {CYBERPUNK_CONVAI_STT_PACKS: '/packs'}, engine: sense}).modelDirectory.replaceAll('\\', '/').replace(/^[A-Za-z]:/, ''), '/packs/' + sense.id);

  const worker = fakeWorker();
  const stt = new LocalStt({project: '/app', pythonExecutable: '/py/python.exe', engine: parakeet, environment: {}, exists: existsIn(files), spawnImpl: worker.spawnImpl,
    partials: false, pausePartials: false, lowerPriority: false, idleMs: 60});
  assert.equal(stt.available(), true);
  assert.equal(new LocalStt({project: '/app', pythonExecutable: '/py/python.exe', engine: sense, environment: {}, exists: existsIn(files)}).availability().reason, 'model-missing',
    'the other pack has no files here');
  assert.equal(new LocalStt({project: '/app', pythonExecutable: '/py/python.exe', environment: {}, exists: existsIn(files)}).availability().reason, 'model-missing',
    'and neither does the English recogniser');
  await stt.start('r1');
  const args = worker.spawned[0].args;
  assert.deepEqual(args.slice(args.indexOf('--kind'), args.indexOf('--kind') + 2), ['--kind', 'nemo-transducer']);
  assert.ok(args.indexOf('--kind') < args.indexOf('--model'));
  stt.pushAudio(pcm(300), 'r1');
  assert.equal((await stt.finish('r1')).text, 'hello judy');
  await tick(30);
  assert.equal(worker.spawned[0].lines.filter(line => line.op === 'partial').length, 0, 'a pack decodes once, at the end');
  await stt.close();
});

test('the English recogniser is started exactly as before: no --kind', async () => {
  const worker = fakeWorker();
  const stt = make(worker);
  await stt.start('r1');
  assert.ok(!worker.spawned[0].args.includes('--kind'));
  await stt.close();
});
