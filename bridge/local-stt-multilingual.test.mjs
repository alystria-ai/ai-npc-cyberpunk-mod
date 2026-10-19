// A recording in another language through the voice channel (bridge/local-stt-capture.mjs, plan modes 'voxtral' and 'pack'): fakes for the
// capture, the Mistral transcriber and the local recognisers. No network, no model, no microphone.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MicrophoneSession} from './microphone-session.mjs';
import {createLocalSttChannel, createLocalSpeech, NO_SPEECH_ERROR, SILENT_INPUT_CODE, STT_LANGUAGE_CODE, describeRemote} from './local-stt-capture.mjs';
import {VoxtralSttError} from './voxtral-stt.mjs';

const input = {requestId: '1-5-42ULL', entity: '42ULL', generation: 5, profileKey: 'judy', text: '(microphone)'};
const config = {characterId: 'x', endUserId: 'u', scope: 'private', sessionId: 's'};

// 16 kHz Int16 audio: `quietMs` of faint noise, then `speechMs` of a loud voiced tone.
function audio({quietMs = 400, speechMs = 1200, level = 9000, noise = 6} = {}) {
  const total = Math.round((quietMs + speechMs) * 16);
  const out = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    const loud = i >= quietMs * 16;
    const value = loud ? Math.round(Math.sin(2 * Math.PI * 140 * i / 16000) * level) : Math.round(Math.sin(i * 12.9898) * noise);
    out.writeInt16LE(value, i * 2);
  }
  return out;
}
const blocks = (buffer, size = 3200) => { const parts = []; for (let at = 0; at < buffer.length; at += size) parts.push(buffer.subarray(at, Math.min(buffer.length, at + size))); return parts; };

function fakeStt(name, {available = true, text = '', extra = {}} = {}) {
  const log = [];
  let open = null, received = 0;
  return {name, log, engine: {id: name}, get received() { return received; },
    availability: () => ({available, reason: available ? null : 'model-missing'}),
    start: async id => { log.push('start'); open = id; received = 0; },
    pushAudio: (chunk, id) => { log.push('audio'); received += chunk.length; return true; },
    heard: id => (open === id ? 'live ' + name : ''),
    finish: async id => { log.push('finish'); open = null; return {text, seconds: received / 32000, ...extra}; },
    cancel: async () => { log.push('cancel'); open = null; }, close: async () => {}};
}
function fakeCapture() {
  const log = [];
  let sink = null;
  return {log, emit: chunk => sink?.(chunk),
    begin: async onChunk => { log.push('begin'); sink = onChunk; return {device: 'Fake microphone'}; },
    end: async () => { log.push('end'); sink = null; },
    abort: async () => { log.push('abort'); sink = null; }};
}
function fakeTranscriber({text = 'привет, как дела', language = 'ru', fail = null, gate = null} = {}) {
  const calls = [];
  return {calls, async transcribe(pcm, options) {
    calls.push({bytes: pcm.length, language: options.language, signal: options.signal});
    if (gate) await gate;
    if (fail) throw fail;
    return {text, language, ms: 420};
  }};
}
function rig({plan, stt = fakeStt('english', {text: 'hello'}), transcriber = fakeTranscriber(), reply, route, onLanguage} = {}) {
  const capture = fakeCapture(), languages = [], logs = [];
  const states = [], replies = [], errors = [];
  const factory = createLocalSttChannel({stt, capture, reply, log: line => logs.push(line), route: route ?? (async () => plan), transcriber,
    onLanguage: onLanguage ?? (code => languages.push(code))});
  const mic = new MicrophoneSession({hostFactory: factory, minRecordMs: 0,
    onState: async (state, inputValue, opened) => { states.push({state, note: opened?.note}); },
    onReply: async (inputValue, result) => { replies.push(result); },
    onError: async (inputValue, error) => { states.push({state: 'error'}); errors.push(error); }});
  return {mic, capture, stt, transcriber, states, replies, errors, languages, logs};
}
const speak = async (f, pcm = audio()) => { await f.mic.start(input, config); for (const part of blocks(pcm)) f.capture.emit(part); };

test('another language on the Mistral route: the audio is kept, no local recogniser starts, Mistral gets it all when the key is pressed again', async () => {
  const pcm = audio();
  const f = rig({plan: {mode: 'voxtral', language: 'ru', source: 'ui', hint: null, fallback: [{mode: 'english'}]},
    reply: async (used) => ({text: 'Ответ.', provider: 'mistral', heardAs: used.text})});
  await speak(f, pcm);
  assert.deepEqual(f.states.map(s => s.state), ['starting', 'recording']);
  assert.deepEqual(f.stt.log, [], 'the English recogniser is not started, so no worker, no memory');
  assert.equal(await f.mic.current.host.heard(), '', 'no live words for a recording kept for Mistral');
  await f.mic.finish(input.requestId, {input, config});
  assert.equal(f.transcriber.calls.length, 1);
  assert.equal(f.transcriber.calls[0].bytes, pcm.length, 'every sample is sent');
  assert.equal(f.transcriber.calls[0].language, null, 'an interface-language guess is not sent as a hint');
  assert.deepEqual(f.languages, ['ru'], 'the language Mistral reported is remembered');
  assert.equal(f.replies[0].userText, 'привет, как дела');
  assert.equal(f.replies[0].heardAs, 'привет, как дела');
  assert.equal(f.replies[0].timing.sttEngine, 'mistral-voxtral');
  assert.deepEqual(f.stt.log, [], 'and still none after the answer');
  assert.ok(f.logs.some(line => /speech language ru \(ui\).*Mistral transcription/.test(line)));
  assert.ok(f.logs.some(line => /recorded 1\.6 s .*mistral-voxtral \[ru\] in 420 ms: heard "привет/.test(line)), f.logs.join('\n'));
});

test('a language hint from the player\'s own text is passed on', async () => {
  const f = rig({plan: {mode: 'voxtral', language: 'ru', source: 'text', hint: 'ru', fallback: []}});
  await speak(f); await f.mic.finish(input.requestId, {input, config});
  assert.equal(f.transcriber.calls[0].language, 'ru');
});

test('a recording without speech is never sent: "no speech", or "this input sends no sound" for a dead device', async () => {
  const quiet = rig({plan: {mode: 'voxtral', language: 'ru', source: 'ui', fallback: []}});
  await speak(quiet, audio({quietMs: 1500, speechMs: 0, noise: 120}));
  await quiet.mic.finish(input.requestId, {input, config});
  assert.equal(quiet.transcriber.calls.length, 0);
  assert.equal(quiet.errors[0].message, NO_SPEECH_ERROR);
  const dead = rig({plan: {mode: 'voxtral', language: 'ru', source: 'ui', fallback: []}});
  await speak(dead, Buffer.alloc(32000));
  await dead.mic.finish(input.requestId, {input, config});
  assert.equal(dead.transcriber.calls.length, 0);
  assert.equal(dead.errors[0].code, SILENT_INPUT_CODE);
});

test('Mistral answers with nothing or punctuation: "no speech was heard"', async () => {
  const f = rig({plan: {mode: 'voxtral', language: 'ru', source: 'ui', fallback: []}, transcriber: fakeTranscriber({text: '...'})});
  await speak(f); await f.mic.finish(input.requestId, {input, config});
  assert.equal(f.errors[0].message, NO_SPEECH_ERROR);
});

test('Mistral fails: a local pack reads the same audio first, then the English recogniser, and the log says so', async () => {
  const pack = fakeStt('parakeet', {text: 'привет из пака'}), english = fakeStt('english', {text: 'privet'});
  const pcm = audio();
  const f = rig({stt: english, plan: {mode: 'voxtral', language: 'ru', source: 'text', hint: 'ru', fallback: [{mode: 'pack', stt: pack}, {mode: 'english'}]},
    transcriber: fakeTranscriber({fail: new VoxtralSttError('limit', 'rate limited', {status: 429})})});
  await speak(f, pcm); await f.mic.finish(input.requestId, {input, config});
  assert.equal(f.replies[0].userText, 'привет из пака');
  assert.equal(pack.received, pcm.length, 'the pack was given every sample');
  assert.deepEqual(english.log, [], 'the English recogniser stays out when the pack answers');
  assert.equal(f.replies[0].timing.sttEngine, 'pack:parakeet');
  assert.ok(f.logs.some(line => /Mistral transcription failed \(.*limited.*\); local pack parakeet reads the same audio/.test(line)), f.logs.join('\n'));
  assert.deepEqual(f.languages, [], 'nothing is learned from a failed Mistral call');

  const second = rig({stt: fakeStt('english', {text: 'privet'}), plan: {mode: 'voxtral', language: 'ru', source: 'text', fallback: [{mode: 'pack', stt: fakeStt('p', {available: false})}, {mode: 'english'}]},
    transcriber: fakeTranscriber({fail: new VoxtralSttError('network', 'is unreachable')})});
  await speak(second, pcm); await second.mic.finish(input.requestId, {input, config});
  assert.equal(second.replies[0].userText, 'privet');
  assert.equal(second.replies[0].timing.sttEngine, 'moonshine-fallback');
  assert.ok(second.logs.some(line => /English recogniser reads the same audio/.test(line)));
});

test('Mistral fails and nothing else can read it: the turn ends with the language code the game turns into its notice', async () => {
  const f = rig({plan: {mode: 'voxtral', language: 'ru', source: 'text', fallback: [{mode: 'english'}]}, stt: fakeStt('english', {available: false}),
    transcriber: fakeTranscriber({fail: new VoxtralSttError('key', 'did not accept the API key', {status: 401})})});
  await speak(f); await f.mic.finish(input.requestId, {input, config});
  assert.equal(f.errors.length, 1); assert.equal(f.errors[0].code, STT_LANGUAGE_CODE);
  assert.ok(!/Authorization|Bearer/i.test(f.errors[0].message));
});

test('a pack plan runs the pack like the English recogniser: audio flows to it as it arrives, the English one stays out', async () => {
  const pack = fakeStt('parakeet', {text: 'guten tag'}), english = fakeStt('english', {text: 'hello'});
  const f = rig({stt: english, plan: {mode: 'pack', language: 'de', source: 'ui', stt: pack}, reply: async used => ({text: 'Hallo.', saw: used.text})});
  await f.mic.start(input, config);
  f.capture.emit(audio().subarray(0, 3200));
  assert.deepEqual(pack.log, ['start', 'audio']);
  assert.equal(await f.mic.current.host.heard(), 'live parakeet');
  await f.mic.finish(input.requestId, {input, config});
  assert.deepEqual(english.log, []);
  assert.equal(f.replies[0].saw, 'guten tag');
  assert.ok(f.logs.some(line => /speech language de \(ui\): local pack parakeet, no live words/.test(line)));
});

test('a pack that is not installed refuses before the microphone opens, like the English recogniser', async () => {
  const f = rig({plan: {mode: 'pack', language: 'de', source: 'ui', stt: fakeStt('parakeet', {available: false})}});
  await f.mic.start(input, config);
  assert.equal(f.errors.length, 1); assert.equal(f.errors[0].code, 'local-stt-unavailable');
  assert.ok(!f.capture.log.includes('begin'));
});

test('nothing hears the language: the English recogniser runs and the channel hands the note to the state the game reads', async () => {
  const english = fakeStt('english', {text: 'garbled'});
  const f = rig({stt: english, plan: {mode: 'english', language: 'ru', source: 'text', note: 'english-only'}});
  await f.mic.start(input, config);
  assert.deepEqual(f.states, [{state: 'starting', note: undefined}, {state: 'recording', note: 'english-only'}]);
  assert.deepEqual(english.log, ['start']);
  assert.ok(f.logs.some(line => /nothing here recognises it, English recogniser used/.test(line)));
  await f.mic.finish(input.requestId, {input, config});
  assert.equal(f.replies[0].userText, 'garbled');
});

test('a route that throws, or says nothing, never blocks the recording: English as before', async () => {
  const broken = rig({route: async () => { throw Error('cannot read the language'); }});
  await speak(broken); await broken.mic.finish(input.requestId, {input, config});
  assert.equal(broken.replies[0].userText, 'hello');
  assert.ok(broken.logs.some(line => /language route failed/.test(line)));
  const empty = rig({route: async () => undefined});
  await speak(empty); await empty.mic.finish(input.requestId, {input, config});
  assert.equal(empty.replies[0].userText, 'hello');
});

test('cancelling while Mistral is working stops the request and starts nothing local', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const english = fakeStt('english', {text: 'x'});
  const f = rig({stt: english, plan: {mode: 'voxtral', language: 'ru', source: 'text', fallback: [{mode: 'english'}]}, transcriber: fakeTranscriber({gate})});
  await speak(f);
  const finishing = f.mic.finish(input.requestId, {input, config});
  await new Promise(done => setTimeout(done, 20));
  assert.equal(f.transcriber.calls.length, 1);
  await f.mic.release();
  release();
  await finishing.catch(() => {});
  assert.equal(f.transcriber.calls[0].signal.aborted, true, 'the closed recording aborts the request');
  assert.deepEqual(english.log, [], 'and no fallback runs for a recording nobody waits for');
});

test('describeRemote names the engine, language and time', () => {
  assert.match(describeRemote({seconds: 3.2, peakDb: -12, soundMs: 2100, engine: 'mistral-voxtral', language: 'pl', ms: 700, text: 'cześć'}, 'Headset'),
    /^recorded 3\.2 s from "Headset" \(peak -12 dBFS, 2100 ms of sound\) by mistral-voxtral \[pl\] in 700 ms: heard "cześć"$/);
  assert.match(describeRemote({seconds: 1, text: ''}, ''), /no words$/);
});

test('the speech hook releases the microphone page only when no recording is open, a while after the last one', async () => {
  const timers = [];
  const setTimer = (fn, ms) => { const timer = {fn, ms, cleared: false, unref() {}}; timers.push(timer); return timer; };
  const clearTimer = timer => { if (timer) timer.cleared = true; };
  const capture = fakeCapture(); let closed = 0;
  capture.close = async () => { closed++; };
  const speech = createLocalSpeech({stt: fakeStt('english', {available: false}), capture, setTimer, clearTimer, idleMs: 90_000,
    route: async () => ({mode: 'voxtral', language: 'ru', source: 'ui', fallback: []}), transcriber: fakeTranscriber(), alternatives: () => true});
  assert.equal(speech.available(), true, 'Mistral can hear it even though the English model is missing');
  assert.equal(createLocalSpeech({stt: fakeStt('english', {available: false}), capture}).available(), false);
  const channel = speech.voiceChannel({});
  await channel.beginVoice({requestId: 'a'});
  capture.emit(audio());
  await channel.finishVoice({requestId: 'a'});
  const pending = timers.filter(timer => !timer.cleared);
  assert.equal(pending.length, 1); assert.equal(pending[0].ms, 90_000);
  // A new recording before it fires cancels it.
  const second = speech.voiceChannel({});
  await second.beginVoice({requestId: 'b'});
  assert.equal(timers.filter(timer => !timer.cleared).length, 0);
  await second.close();
  const armed = timers.filter(timer => !timer.cleared);
  assert.equal(armed.length, 1);
  armed[0].fn();
  await new Promise(done => setImmediate(done));
  assert.equal(closed, 1, 'the page is released once, after the last recording');
  await speech.close();
});
