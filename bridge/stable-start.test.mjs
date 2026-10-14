// The reply started on a stable live-words decode (docs/LATENCY_2026-10-14.md section 1, option B), and the decode at the player's pause that feeds it:
// the speech activity tracker, the recogniser's pause decode and `stable()`, the voice channel's keep-or-restart, ReplyStream.mirrorTo and the text
// host's `confirmed` gate. Fakes only: no worker, no model, no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {SpeechActivity, ACTIVITY} from './stt-activity.mjs';
import {LocalStt, MODEL_FILES, LOCAL_STT_LIMITS, sameWords, wordsOf} from './local-stt.mjs';
import {createLocalSttChannel} from './local-stt-capture.mjs';
import {ReplyStream} from './reply-stream.mjs';
import {hasEmotionTag} from './emotion-tags.mjs';
import {TextProviderHost, mistralRoute} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {PersonaBook} from './mistral-prompt.mjs';

const tick = (ms = 5) => new Promise(done => setTimeout(done, ms));
// 100 ms of loud, voice-like samples, or of near silence.
const speech = (ms = 100) => Buffer.from(Int16Array.from({length: 16 * ms}, (_, i) => (i % 2 ? 7000 : -7000)).buffer);
const quiet = (ms = 100) => Buffer.from(Int16Array.from({length: 16 * ms}, (_, i) => (i % 3) - 1).buffer);

test('SpeechActivity: speech, the pause after it, and the speech that came after a given byte', () => {
  const activity = new SpeechActivity();
  for (let i = 0; i < 10; i++) activity.push(quiet());
  assert.equal(activity.heardSpeech, false);
  assert.equal(activity.quietMs, 0, 'nothing heard: no pause to report');
  for (let i = 0; i < 6; i++) activity.push(speech());
  assert.equal(activity.heardSpeech, true);
  assert.equal(activity.quietMs, 0);
  const speechStart = activity.speechStartBytes;
  assert.ok(Math.abs(speechStart - 1000 * 16 * 2) <= 480 * 2, 'the first speech frame starts at the one second mark');
  const end = activity.speechEndBytes;
  assert.ok(Math.abs(end - 1600 * 16 * 2) <= 480 * 2, 'speech ends at 1.6 s');
  for (let i = 0; i < 4; i++) activity.push(quiet());
  assert.ok(activity.quietMs >= 360 && activity.quietMs <= 420, 'quiet for about 400 ms: ' + activity.quietMs);
  assert.equal(activity.speechMsAfter(activity.speechEndBytes), 0);
  assert.ok(activity.speechMsAfter(1000 * 16 * 2) >= 570, 'the speech after the 1 s mark is about 600 ms');
  activity.push(speech(300));
  assert.equal(activity.quietMs, 0);
  assert.ok(activity.speechMsAfter(end) >= 270);
});

test('SpeechActivity: odd chunk sizes and a split frame count the same samples', () => {
  const whole = new SpeechActivity(), pieces = new SpeechActivity();
  const audio = Buffer.concat([quiet(500), speech(500), quiet(500)]);
  whole.push(audio);
  for (let at = 0; at < audio.length; at += 1000) pieces.push(audio.subarray(at, Math.min(audio.length, at + 1000)));
  assert.equal(pieces.frames, whole.frames);
  assert.equal(pieces.samples, whole.samples);
  assert.equal(pieces.quietMs, whole.quietMs);
  assert.equal(pieces.speechEndBytes, whole.speechEndBytes);
});

test('words are compared without punctuation, case or an apostrophe at a word edge', () => {
  assert.deepEqual(wordsOf("Hey, Judy! It's me."), ['hey', 'judy', "it's", 'me']);
  assert.equal(sameWords('Hey Judy, long time.', 'hey judy long time'), true);
  assert.equal(sameWords('Hey Judy long time', 'hey judy long times'), false);
  assert.equal(sameWords('', ''), true);
});

// ---- the recogniser -------------------------------------------------------------------------------------------------------------------
const ALL = new Set(['/py/python.exe', '/app/bridge/local-stt-worker.py', '/py/Lib/site-packages/sherpa_onnx', ...MODEL_FILES.map(name => '/model/' + name)]);
const paths = {python: '/py/python.exe', worker: '/app/bridge/local-stt-worker.py', modelDirectory: '/model'};
const existsIn = files => path => files.has(String(path).replace(/^[A-Za-z]:/, '').replaceAll('\\', '/'));
// A fake worker: answers partial requests with `partial(bytesSoFar)` ({text, ms}) when it is not holding them.
function fakeWorker({partial = bytes => ({text: 'hey judy ' + bytes, ms: 5}), hold = false} = {}) {
  const spawned = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 4243; child.kill = () => child.emit('exit', null);
    const record = {lines: [], child, answer: null};
    spawned.push(record);
    let bytes = 0, pending = '';
    const reply = message => child.stdout.write(JSON.stringify(message) + '\n');
    record.answer = id => { const {text, ms} = partial(bytes); reply({type: 'partial', id, text, ms}); };
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', text => {
      pending += text;
      let at;
      while ((at = pending.indexOf('\n')) >= 0) {
        const message = JSON.parse(pending.slice(0, at)); pending = pending.slice(at + 1);
        record.lines.push(message);
        if (message.op === 'audio') bytes += Buffer.from(message.pcm, 'base64').length;
        if (message.op === 'partial' && !hold) record.answer(message.id);
        if (message.op === 'finish') reply({type: 'final', id: message.id, text: 'hey judy', ms: 12, seconds: bytes / 32000, speech: true});
      }
    });
    setTimeout(() => reply({type: 'ready', engine: 'fake', threads: 1, loadMs: 1}), 0);
    return child;
  };
  return {spawnImpl, spawned, partials: () => spawned[0].lines.filter(line => line.op === 'partial').length};
}
const make = (worker, extra = {}) => new LocalStt({paths, exists: existsIn(ALL), spawnImpl: worker.spawnImpl, partialIntervalMs: 60_000,
  lowerPriority: false, idleMs: 60, ...extra});

test('the player pauses: one decode is asked for at once, once per pause, not before the pause and not when the switch is off', async () => {
  const worker = fakeWorker();
  const stt = make(worker);
  await stt.start('r1'); await stt.warm();
  for (let i = 0; i < 10; i++) stt.pushAudio(quiet(), 'r1');
  for (let i = 0; i < 6; i++) stt.pushAudio(speech(), 'r1');
  assert.equal(worker.partials(), 0, 'speech going on: the timer decides, not the pause');
  stt.pushAudio(quiet(), 'r1'); stt.pushAudio(quiet(), 'r1');
  assert.equal(worker.partials(), 0, 'a 200 ms gap is not a pause yet');
  stt.pushAudio(quiet(), 'r1'); stt.pushAudio(quiet(), 'r1');
  assert.equal(worker.partials(), 1, 'quiet for 300 ms after speech: decode now');
  await tick(20);
  for (let i = 0; i < 12; i++) stt.pushAudio(quiet(), 'r1');
  await tick(20);
  assert.equal(worker.partials(), 1, 'the same pause asks only once');
  for (let i = 0; i < 4; i++) stt.pushAudio(speech(), 'r1');
  for (let i = 0; i < 5; i++) stt.pushAudio(quiet(), 'r1');
  assert.equal(worker.partials(), 2, 'a later pause asks again');
  await stt.close();

  const off = fakeWorker(), plain = make(off, {pausePartials: false});
  await plain.start('r2'); await plain.warm();
  for (let i = 0; i < 4; i++) plain.pushAudio(quiet(), 'r2');
  for (let i = 0; i < 6; i++) plain.pushAudio(speech(), 'r2');
  for (let i = 0; i < 6; i++) plain.pushAudio(quiet(), 'r2');
  assert.equal(off.partials(), 0, 'switched off: timers only');
  await plain.close();
});

test('a decode already running is not doubled: the pause waits for it, and asks again when it is back', async () => {
  const worker = fakeWorker({hold: true});
  const stt = make(worker);
  await stt.start('r1'); await stt.warm();
  for (let i = 0; i < 4; i++) stt.pushAudio(quiet(), 'r1');
  for (let i = 0; i < 6; i++) stt.pushAudio(speech(), 'r1');
  for (let i = 0; i < 6; i++) stt.pushAudio(quiet(), 'r1');
  assert.equal(worker.partials(), 1);
  for (let i = 0; i < 6; i++) stt.pushAudio(quiet(), 'r1');
  assert.equal(worker.partials(), 1, 'busy: no second request');
  await stt.close();
});

test('a worker that answers an empty decode (nothing heard yet) frees the next one', async () => {
  const worker = fakeWorker({partial: () => ({text: '', ms: 0})});
  const stt = make(worker, {partialIntervalMs: 15});
  await stt.start('r1'); await stt.warm();
  for (let i = 0; i < 10; i++) { stt.pushAudio(quiet(300), 'r1'); await tick(20); }
  assert.ok(worker.partials() >= 2, 'empty answers must not stall later decodes: ' + worker.partials());
  await stt.close();
});

test('stable(): the newest decode stands only when it read all the speech and the quiet after it', async () => {
  const worker = fakeWorker({partial: () => ({text: 'hey pan am', ms: 5})});
  const stt = make(worker);
  await stt.start('r1'); await stt.warm();
  assert.equal(stt.stable('r1'), null, 'no decode yet');
  for (let i = 0; i < 10; i++) stt.pushAudio(quiet(), 'r1');
  for (let i = 0; i < 8; i++) stt.pushAudio(speech(), 'r1');
  for (let i = 0; i < 4; i++) stt.pushAudio(quiet(), 'r1');
  await tick(20);
  const first = stt.stable('r1');
  assert.ok(first, 'the pause decode read everything');
  assert.equal(first.text, 'hey Panam', 'the same fixups as the final transcript');
  assert.equal(first.agree, false, 'only one decode so far');
  assert.ok(first.quietAfterMs >= LOCAL_STT_LIMITS.settleMs);
  assert.equal(stt.stable('other'), null);
  // The player says more after that decode: it no longer covers the speech.
  stt.pushAudio(speech(200), 'r1');
  assert.equal(stt.stable('r1'), null);
  await stt.close();
});

test('stable(): a decode taken at the last syllable (no quiet heard) and one that left the first word out do not stand', async () => {
  const early = fakeWorker({partial: () => ({text: 'hey judy', ms: 5})});
  const a = make(early, {pausePartials: false, partialIntervalMs: 20});
  await a.start('r1'); await a.warm();
  for (let i = 0; i < 5; i++) a.pushAudio(quiet(), 'r1');
  for (let i = 0; i < 8; i++) { a.pushAudio(speech(), 'r1'); }
  await tick(40);   // the timer decode lands right after the last speech sample: no quiet in it
  assert.equal(a.stable('r1'), null, 'no quiet after the speech in what the decode read');
  await a.close();

  const long = fakeWorker({partial: () => ({text: 'the end of a long recording', ms: 5})});
  const b = make(long);
  await b.start('r2'); await b.warm();
  for (let i = 0; i < 4; i++) b.pushAudio(quiet(), 'r2');
  for (let i = 0; i < 100; i++) b.pushAudio(speech(), 'r2');   // 10 s of speech from the 0.4 s mark: the 8 s window drops the start
  for (let i = 0; i < 4; i++) b.pushAudio(quiet(), 'r2');
  await tick(20);
  assert.equal(b.stable('r2'), null, 'the window left words out');
  await b.close();

  const lead = fakeWorker({partial: () => ({text: 'a recording with a long wait first', ms: 5})});
  const c = make(lead);
  await c.start('r3'); await c.warm();
  for (let i = 0; i < 40; i++) c.pushAudio(quiet(), 'r3');    // 4 s of waiting before the first word
  for (let i = 0; i < 50; i++) c.pushAudio(speech(), 'r3');   // 5 s of speech: 9 s in all, but the first word is inside the newest 8 s
  for (let i = 0; i < 4; i++) c.pushAudio(quiet(), 'r3');
  await tick(20);
  assert.ok(c.stable('r3'), 'only silence was left out of the window');
  await c.close();
});

test('stable() reports when the two newest decodes say the same words', async () => {
  let n = 0;
  const worker = fakeWorker({partial: () => ({text: n++ ? 'Hey Judy!' : 'hey judy', ms: 5})});
  const stt = make(worker);
  await stt.start('r1'); await stt.warm();
  for (let i = 0; i < 3; i++) stt.pushAudio(quiet(), 'r1');
  for (let i = 0; i < 8; i++) stt.pushAudio(speech(), 'r1');
  for (let i = 0; i < 4; i++) stt.pushAudio(quiet(), 'r1');
  await tick(20);
  for (let i = 0; i < 4; i++) stt.pushAudio(speech(), 'r1');
  for (let i = 0; i < 4; i++) stt.pushAudio(quiet(), 'r1');
  await tick(20);
  const stable = stt.stable('r1');
  assert.equal(stable.decodes, 2);
  assert.equal(stable.agree, true);
  await stt.close();
});

// ---- ReplyStream.mirrorTo -------------------------------------------------------------------------------------------------------------
test('mirrorTo: a stream that was fed before its listener existed hands everything on, and what comes later', async () => {
  const first = new ReplyStream({name: 'Judy', isTag: hasEmotionTag}), second = new ReplyStream({name: 'Judy', isTag: hasEmotionTag});
  first.update('Hey choom, good to see you again. You look');
  assert.equal(first.committed, true);
  assert.equal(second.committed, false);
  first.mirrorTo(second);
  assert.equal(second.head, first.head, 'the same head, at once');
  first.update('Hey choom, good to see you again. You look tired.');
  first.finish('Hey choom, good to see you again. You look tired.', {marker: 1});
  assert.equal(await second.headReady, 'Hey choom, good to see you again.');
  assert.equal(await second.finished, 'Hey choom, good to see you again. You look tired.');
  assert.deepEqual(second.meta, {marker: 1});
  // A failure is handed on too, and a stream finished before the mirror exists is replayed.
  const failing = new ReplyStream({name: 'Judy'}), sink = new ReplyStream({name: 'Judy'});
  failing.mirrorTo(sink);
  failing.fail(Error('the model went away'));
  await assert.rejects(sink.finished, /went away/);
  const done = new ReplyStream({name: 'Judy'}), late = new ReplyStream({name: 'Judy'});
  done.update('Short.'); done.finish('Short.', {});
  done.mirrorTo(late);
  assert.equal(await late.finished, 'Short.');
});

// ---- the voice channel ----------------------------------------------------------------------------------------------------------------
// A recogniser stand-in whose newest decode says `guess` (or nothing stable) and whose final says `final` after `finalMs`.
function guessStt({guess, final, finalMs = 40}) {
  return {availability: () => ({available: true, reason: null}), start: async () => {}, pushAudio: () => true, heard: () => '',
    stable: () => (guess === null ? null : {text: guess, coveredBytes: 1, quietAfterMs: 300, decodes: 1, agree: false}),
    finish: async () => { await tick(finalMs); return {text: final, seconds: 2}; }, cancel: async () => {}};
}
const capture = () => ({begin: async () => ({device: 'Fake'}), end: async () => { await tick(10); }, abort: async () => {}});
// A reply function with the host's contract for `confirmed`: it writes into the stream at once, remembers nothing until confirmed, and ends
// with the gate's error when it is shut.
function fakeReply() {
  const calls = [], remembered = [];
  const reply = async (config, options) => {
    const call = {text: config.text, speculative: !!options.confirmed, aborted: false, at: performance.now()};
    calls.push(call);
    options.signal?.addEventListener('abort', () => { call.aborted = true; });
    const text = `You said ${config.text}. And that is all I have to say about it for now.`;
    options.stream?.update(text);
    await tick(15);
    if (options.signal?.aborted) throw Object.assign(Error('cancelled'), {name: 'AbortError'});
    if (options.confirmed) await options.confirmed;
    remembered.push(config.text);
    options.stream?.finish(text, {});
    return {text, provider: 'mistral'};
  };
  return {reply, calls, remembered};
}
async function channelTurn({guess, final, speculate = true, reply, finalMs}) {
  const stt = guessStt({guess, final, finalMs});
  const channel = createLocalSttChannel({stt, capture: capture(), reply: reply.reply, speculate: () => speculate})();
  await channel.beginVoice({requestId: 'r1'});
  const stream = new ReplyStream({name: 'Judy', isTag: hasEmotionTag});
  const heads = []; stream.headReady.then(head => heads.push(head));
  const transcripts = [];
  const result = await channel.finishVoice({sessionId: 's', local: {profileKey: 'judy-alvarez', name: 'Judy', channel: 'private'}},
    {stream, onTranscript: text => transcripts.push(text)});
  await channel.close();
  return {result, stream, heads, transcripts};
}

test('the final words agree with the stable decode: the reply that was started is the reply, started before the final decode was back', async () => {
  const reply = fakeReply();
  const started = performance.now();
  const {result, stream, heads, transcripts} = await channelTurn({guess: 'Hey Judy, long time no see.', final: 'hey judy long time no see', reply});
  assert.equal(reply.calls.length, 1, 'one request, not two');
  assert.equal(reply.calls[0].speculative, true);
  assert.ok(reply.calls[0].at - started < 30, 'started at the key press, not after the final decode');
  assert.deepEqual(reply.remembered, ['Hey Judy, long time no see.']);
  assert.equal(result.timing.speculation, 'kept');
  assert.equal(result.userText, 'hey judy long time no see', 'the player sees the final transcript');
  assert.deepEqual(transcripts, ['hey judy long time no see']);
  assert.equal(heads.length, 1, 'the real stream got the head');
  assert.match(heads[0], /^You said Hey Judy/);
  assert.equal(stream.complete, true);
});

test('the final words differ: the started reply is cancelled before anything is voiced or remembered, and the final words are asked again', async () => {
  const reply = fakeReply();
  const {result, stream, heads} = await channelTurn({guess: 'Hey Judy, long time no see.', final: 'Hey Jackie, long time no see.', reply});
  assert.equal(reply.calls.length, 2);
  assert.equal(reply.calls[0].speculative, true);
  assert.equal(reply.calls[0].aborted, true, 'the first request was cancelled');
  assert.equal(reply.calls[1].speculative, false);
  assert.equal(reply.calls[1].text, 'Hey Jackie, long time no see.');
  assert.deepEqual(reply.remembered, ['Hey Jackie, long time no see.'], 'the words the player did not say are never remembered');
  assert.equal(result.timing.speculation, 'restarted');
  assert.equal(heads.length, 1);
  assert.match(heads[0], /^You said Hey Jackie/, 'only the reply to the final words reached the voice');
  assert.doesNotMatch(stream.text, /Judy/);
});

test('nothing stable, the switch off, or no reply hook: the turn goes as it always did', async () => {
  for (const options of [{guess: null, speculate: true}, {guess: 'hey judy', speculate: false}]) {
    const reply = fakeReply();
    const {result} = await channelTurn({...options, final: 'hey judy', reply});
    assert.equal(reply.calls.length, 1);
    assert.equal(reply.calls[0].speculative, false);
    assert.equal(result.timing?.speculation, undefined);
  }
});

test('a started reply that fails on its own before the words are confirmed is asked again; a final with no words ends the turn quietly', async () => {
  let n = 0;
  const calls = [];
  const reply = async (config, options) => {
    calls.push(options.confirmed ? 'speculative' : 'plain');
    if (!n++) throw Error('network down');
    options.stream?.update('Fine, here we are. Nothing else to say.'); options.stream?.finish('Fine, here we are. Nothing else to say.', {});
    return {text: 'Fine, here we are. Nothing else to say.'};
  };
  const {result} = await channelTurn({guess: 'hey judy', final: 'hey judy', reply: {reply}, finalMs: 60});
  assert.deepEqual(calls, ['speculative', 'plain']);
  assert.equal(result.timing.speculation, 'failed');

  const quietReply = fakeReply();
  await assert.rejects(channelTurn({guess: 'hey judy', final: '', reply: quietReply}), /No speech was heard/);
  await tick(40);
  assert.equal(quietReply.calls[0].aborted, true, 'the started reply was cancelled');
  assert.deepEqual(quietReply.remembered, []);
});

test('closing the channel while the started reply waits for its words ends that reply instead of leaving it hanging', async () => {
  const reply = fakeReply();
  let release;
  const stt = {...guessStt({guess: 'hey judy', final: 'hey judy'}), finish: () => new Promise(done => { release = done; })};
  const channel = createLocalSttChannel({stt, capture: capture(), reply: reply.reply, speculate: () => true})();
  await channel.beginVoice({requestId: 'r1'});
  const finishing = channel.finishVoice({sessionId: 's', local: {profileKey: 'judy-alvarez', name: 'Judy', channel: 'private'}},
    {stream: new ReplyStream({name: 'Judy'})});
  finishing.catch(() => {});
  await tick(60);
  assert.equal(reply.calls.length, 1);
  await channel.close();
  await tick(40);
  assert.equal(reply.calls[0].aborted, true);
  assert.deepEqual(reply.remembered, []);
  release?.({text: 'hey judy', seconds: 1});
});

// ---- the text host's gate ---------------------------------------------------------------------------------------------------------------
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
async function textHost(reply = 'Hey choom, good to see you again. You look like you have not slept in days.') {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', async () => {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      for (const piece of reply.match(/.{1,8}/gs)) {
        if (response.destroyed) return;
        response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: piece}}]})}\n\n`);
        await tick(3);
      }
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => 'api-key=aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL\n', writeText: async () => {}});
  await provider.load(); provider.setPreference('mistral'); provider.apply();
  const memory = await MistralMemory.open({path: null});
  const recorded = [];
  const original = memory.record.bind(memory);
  memory.record = turn => { recorded.push(turn.v); return original(turn); };
  const host = new TextProviderHost({provider, memory, personas: new PersonaBook(roster), log: () => {},
    routes: {mistral: mistralRoute({provider, gapMs: 0, cacheScope: 'x', endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`})}});
  return {host, recorded, close: async () => { host.close(); server.closeAllConnections?.(); await new Promise(done => server.close(done)); }};
}
const turn = text => ({text, sessionId: 's', context: 'CURRENT PERSON\nBench.', local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}});

test('text host: a reply held by `confirmed` is written but not remembered until it resolves, and leaves no trace when it rejects', async () => {
  const {host, recorded, close} = await textHost();
  try {
    let open; const gate = new Promise(done => { open = done; });
    const stream = new ReplyStream({name: 'Judy Alvarez', isTag: hasEmotionTag});
    const pending = host.reply(turn('hey judy'), {stream, confirmed: gate});
    await stream.headReady;
    await tick(80);
    assert.deepEqual(recorded, [], 'written, not remembered');
    open();
    const result = await pending;
    assert.deepEqual(recorded, ['hey judy']);
    assert.match(result.text, /good to see you/);

    let shut; const refused = new Promise((_, no) => { shut = no; });
    refused.catch(() => {});
    const second = host.reply(turn('hey jackie'), {stream: new ReplyStream({name: 'Judy Alvarez', isTag: hasEmotionTag}), confirmed: refused});
    second.catch(() => {});
    await tick(80);
    shut(Object.assign(Error('The words changed'), {name: 'AbortError'}));
    await assert.rejects(second, error => error.name === 'AbortError');
    assert.deepEqual(recorded, ['hey judy'], 'the cancelled reply was never remembered');
  } finally { await close(); }
});
