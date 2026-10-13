import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {MicrophoneSession} from './microphone-session.mjs';
import {createLocalSttChannel, createLocalSpeech, LocalSttCapture, NO_SPEECH_ERROR, STT_UNAVAILABLE_CODE} from './local-stt-capture.mjs';
import {LocalStt} from './local-stt.mjs';

const tick = (ms = 5) => new Promise(done => setTimeout(done, ms));
const input = {requestId: '1-5-42ULL', entity: '42ULL', generation: 5, profileKey: 'judy', text: '(microphone)'};
const config = {characterId: 'x', endUserId: 'u', scope: 'private', sessionId: 's'};

// A LocalStt stand-in with the same surface.
function fakeStt({available = true, text = 'hello there', partial = ''} = {}) {
  const log = [];
  let open = null;
  return {log,
    availability: () => ({available, reason: available ? null : 'model-missing'}),
    start: async id => { log.push('start:' + id); open = id; },
    pushAudio: chunk => { log.push('audio:' + chunk.length); return true; },
    heard: id => (open === id ? partial : ''),
    finish: async id => { log.push('finish:' + id); open = null; return {text, seconds: 1.5}; },
    cancel: async id => { log.push('cancel:' + id); open = null; },
    setPartial: value => { partial = value; }};
}
// A capture stand-in that pushes chunks when told to.
function fakeCapture({failBegin = false} = {}) {
  const log = [];
  let sink = null;
  return {log, emit: chunk => sink?.(chunk),
    begin: async onChunk => { log.push('begin'); if (failBegin) throw Error('NotAllowedError'); sink = onChunk; return {device: 'Fake microphone'}; },
    end: async () => { log.push('end'); sink = null; },
    abort: async () => { log.push('abort'); sink = null; }};
}
function session({stt, capture, reply, minRecordMs = 0}) {
  const states = [], replies = [], errors = [];
  const factory = createLocalSttChannel({stt, capture, reply});
  const mic = new MicrophoneSession({hostFactory: factory, minRecordMs,
    onState: async state => { states.push(state); },
    onReply: async (inputValue, result) => { replies.push(result); },
    onError: async (inputValue, error) => { states.push('error'); errors.push(error); }});
  return {mic, states, replies, errors};
}

test('a recording runs through MicrophoneSession: starting, recording, chunks to the recogniser, reply with the transcript', async () => {
  const stt = fakeStt({text: 'Hey Judy'}), capture = fakeCapture();
  const f = session({stt, capture});
  await f.mic.start(input, config);
  assert.deepEqual(f.states, ['starting', 'recording']);
  capture.emit(Buffer.alloc(3200)); capture.emit(Buffer.alloc(3200));
  assert.deepEqual(stt.log.filter(line => line.startsWith('audio')), ['audio:3200', 'audio:3200']);
  await f.mic.finish(input.requestId);
  assert.deepEqual(f.states, ['starting', 'recording', 'reply', 'off']);
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].userText, 'Hey Judy');
  assert.equal(f.replies[0].local, true);
  assert.equal(f.replies[0].timing.audioSeconds, 1.5);
  assert.deepEqual(capture.log, ['begin', 'end', 'abort']);
  assert.ok(stt.log.includes('finish:' + stt.log.find(line => line.startsWith('start:')).slice(6)));
});

test('the provider reply hook turns the transcript into the reply the bridge publishes', async () => {
  const seen = [];
  const f = session({stt: fakeStt({text: 'where are we going'}), capture: fakeCapture(),
    reply: async (used, options) => { seen.push([used.text, used.characterId, options.signal.aborted, options.marker]); return {text: 'To the Afterlife.', provider: 'mistral'}; }});
  await f.mic.start(input, config);
  await f.mic.finish(input.requestId, {input, config});
  assert.deepEqual(seen, [['where are we going', 'x', false, undefined]]);
  assert.equal(f.replies[0].text, 'To the Afterlife.');
  assert.equal(f.replies[0].userText, 'where are we going');
});

test('createLocalSpeech has the hook shape the text provider host takes', async () => {
  const stt = fakeStt({text: 'hi'}), capture = fakeCapture();
  const speech = createLocalSpeech({stt, capture});
  assert.equal(speech.available(), true);
  assert.deepEqual(speech.availability(), {available: true, reason: null});
  assert.equal(createLocalSpeech({stt: fakeStt({available: false}), capture}).available(), false);
  const channel = speech.voiceChannel({reply: async used => ({text: 'echo ' + used.text})});
  for (const name of ['beginVoice', 'finishVoice', 'heard', 'close']) assert.equal(typeof channel[name], 'function', name);
  await channel.beginVoice(config);
  const result = await channel.finishVoice(config, {});
  assert.equal(result.text, 'echo hi'); assert.equal(result.userText, 'hi');
  await channel.close();
});

test('live words: heard() follows the recogniser partials while recording and is empty otherwise', async () => {
  const stt = fakeStt(), capture = fakeCapture();
  const f = session({stt, capture});
  assert.equal(await f.mic.heard(), '');
  await f.mic.start(input, config);
  assert.equal(await f.mic.heard(), '');
  stt.setPartial('hey judy do you');
  assert.equal(await f.mic.heard(), 'hey judy do you');
  stt.setPartial('hey judy do you want to');
  assert.equal(await f.mic.heard(), 'hey judy do you want to');
  await f.mic.finish(input.requestId);
  assert.equal(await f.mic.heard(), '');
});

test('no speech: an empty transcript fails the turn as "No speech was heard", which the bridge maps to the no-speech notice', async () => {
  const f = session({stt: fakeStt({text: ''}), capture: fakeCapture()});
  await f.mic.start(input, config);
  await f.mic.finish(input.requestId);
  assert.equal(f.replies.length, 0);
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].message, NO_SPEECH_ERROR);
  assert.match(f.errors[0].message, /No speech was heard/, 'the bridge tests this exact text');
  assert.deepEqual(f.states.slice(-2), ['error', 'off']);
});

test('cancel while recording releases the device and the recogniser and sends no reply', async () => {
  const stt = fakeStt(), capture = fakeCapture();
  const f = session({stt, capture});
  await f.mic.start(input, config);
  await f.mic.cancel();
  assert.ok(capture.log.includes('abort'));
  assert.ok(stt.log.some(line => line.startsWith('cancel:')));
  assert.equal(f.replies.length, 0);
  assert.equal(f.states.at(-1), 'off');
  assert.equal(await f.mic.heard(), '');
});

test('spam: a finish inside the minimum recording time waits it out; a second finish is ignored', async () => {
  const stt = fakeStt({text: 'ok'}), capture = fakeCapture();
  const f = session({stt, capture, minRecordMs: 80});
  await f.mic.start(input, config);
  const started = Date.now();
  const first = f.mic.finish(input.requestId);
  const second = f.mic.finish(input.requestId);
  await Promise.all([first, second]);
  assert.ok(Date.now() - started >= 70, 'held for the rest of the minimum recording');
  assert.equal(f.replies.length, 1);
  assert.equal(stt.log.filter(line => line.startsWith('finish')).length, 1);
});

test('a second press while the device is still opening finishes once, when the device is ready', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const capture = fakeCapture(); const open = capture.begin;
  capture.begin = async onChunk => { await gate; return open(onChunk); };
  const stt = fakeStt();
  const f = session({stt, capture});
  const started = f.mic.start(input, config);
  await tick(); await f.mic.finish(input.requestId);
  assert.equal(f.replies.length, 0);
  release(); await started;
  assert.equal(f.replies.length, 1);
  assert.equal(stt.log.filter(line => line.startsWith('finish')).length, 1);
});

test('speech recognition not installed: the turn fails with a coded error before the microphone opens', async () => {
  const capture = fakeCapture();
  const f = session({stt: fakeStt({available: false}), capture});
  await f.mic.start(input, config);
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].code, STT_UNAVAILABLE_CODE);
  assert.equal(f.errors[0].reason, 'model-missing');
  assert.ok(!capture.log.includes('begin'), 'the microphone was never opened');
  assert.equal(f.replies.length, 0);
});

test('a microphone that cannot open fails the turn and cancels the recogniser', async () => {
  const stt = fakeStt(), capture = fakeCapture({failBegin: true});
  const f = session({stt, capture});
  await f.mic.start(input, config);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0].message, /NotAllowed/);
  assert.ok(stt.log.some(line => line.startsWith('cancel:')));
});

test('a second recording after a finished one uses a fresh channel and recogniser session', async () => {
  const stt = fakeStt({text: 'again'}), capture = fakeCapture();
  const f = session({stt, capture});
  await f.mic.start(input, config); await f.mic.finish(input.requestId);
  const next = {...input, requestId: '2-5-42ULL'};
  await f.mic.start(next, config); await f.mic.finish(next.requestId);
  assert.equal(f.replies.length, 2);
  const starts = stt.log.filter(line => line.startsWith('start:'));
  assert.equal(new Set(starts).size, 2);
});

// The browser half, end to end, with Chrome's fake microphone fed from a recorded clip (nobody is recorded).
const here = fileURLToPath(new URL('..', import.meta.url));
const sample = resolve(here, 'bridge/fixtures/local-stt-sample.wav');
const stt = new LocalStt({project: here, pythonExecutable: resolve(here, 'vendor/pocket-tts-env/Scripts/python.exe')});
const browserExecutable = process.env.CYBERPUNK_CONVAI_BROWSER
  || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(path => existsSync(path));
const skip = (!stt.available() && 'local speech recognition is not installed here') || (!browserExecutable && 'no Chromium browser found') || (!existsSync(sample) && 'sample missing');
test('browser capture: AudioWorklet chunks reach the recogniser and the clip is transcribed', {skip, timeout: 60000}, async () => {
  const browser = await chromium.launch({executablePath: browserExecutable, headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${sample}%noloop`,
      '--autoplay-policy=no-user-gesture-required', '--mute-audio']});
  const capture = new LocalSttCapture({getBrowser: async () => browser});
  const f = session({stt, capture});
  try {
    const partials = [];
    stt.on('partial', event => partials.push(event.text));
    await f.mic.start(input, config);
    assert.equal(f.states.at(-1), 'recording');
    await tick(6500);   // the clip is 4.8 s long
    assert.ok(stt.heard() === '' || /\w/.test(stt.heard()));
    await f.mic.finish(input.requestId);
    assert.equal(f.errors.length, 0, f.errors.map(error => error.message).join());
    assert.match(f.replies[0].userText, /manner less interesting/i, f.replies[0].userText);
    assert.ok(partials.length >= 1, 'live words arrived while recording');
  } finally { await capture.close(); await stt.close(); await browser.close(); }
});

test('the transcript is reported through options.onTranscript before the reply starts, and a throwing listener changes nothing', async () => {
  const order = [];
  const f = session({stt: fakeStt({text: 'where are we going'}), capture: fakeCapture(),
    reply: async (used, options) => { order.push('reply:' + used.text); return {text: 'To the Afterlife.'}; }});
  await f.mic.start(input, config);
  // MicrophoneSession hands the options of prepareReply to finishVoice; call the channel directly for the hook.
  const channel = createLocalSttChannel({stt: fakeStt({text: 'hello'}), capture: fakeCapture(),
    reply: async (used) => { order.push('reply:' + used.text); return {text: 'Hi.'}; }})();
  await channel.beginVoice({requestId: 'r-1'});
  const result = await channel.finishVoice({}, {onTranscript: text => { order.push('transcript:' + text); throw Error('listener fault'); }});
  assert.deepEqual(order, ['transcript:hello', 'reply:hello']);
  assert.equal(result.text, 'Hi.');
  await f.mic.cancel();
});
