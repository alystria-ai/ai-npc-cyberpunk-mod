// A voice-key turn on a text route is voiced from the model's first sentence (docs/LATENCY_2026-10-13.md, 4.1): a fake speech channel and
// a fake SSE text route through the real MicrophoneSession, the real local speech channel and the real text host, as
// reply-stream-tags.test.mjs does for the typed route.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {MicrophoneSession} from './microphone-session.mjs';
import {createLocalSttChannel} from './local-stt-capture.mjs';
import {startVoiceKeyStream} from './voice-key-stream.mjs';
import {TextProviderHost, mistralRoute} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {ReplyStream} from './reply-stream.mjs';
import {hasEmotionTag} from './emotion-tags.mjs';

const KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function model(reply, {pieceMs = 10} = {}) {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', async () => {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      for (const piece of reply.match(/.{1,8}/gs)) {
        if (response.destroyed) return;
        response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: piece}}]})}\n\n`);
        await sleep(pieceMs);
      }
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${KEY}\n`, writeText: async () => {}});
  await provider.load(); provider.setPreference('mistral'); provider.apply();
  const memory = await MistralMemory.open({path: null});
  const host = new TextProviderHost({provider, memory, personas: new PersonaBook(roster), log: () => {},
    routes: {mistral: mistralRoute({provider, gapMs: 0, cacheScope: 'x', endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`})}});
  return {host, close: async () => { host.close(); server.closeAllConnections?.(); await new Promise(done => server.close(done)); }};
}

const stt = text => ({availability: () => ({available: true, reason: null}), start: async () => {}, pushAudio: () => true, heard: () => '',
  finish: async () => ({text, seconds: 1}), cancel: async () => {}});
const capture = () => ({begin: async () => ({device: 'Fake'}), end: async () => {}, abort: async () => {}});
const turn = {text: '(microphone)', sessionId: 's', context: 'CURRENT PERSON\nBench.', local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}};
const input = {requestId: '1-5-42ULL', entity: '42ULL', generation: 5, profileKey: 'judy-alvarez', text: '(microphone)'};

// The bridge's wiring in miniature: prepareReply starts the stream and its voice, onReply hands over the finished reply.
async function voiceKey({host, said = 'is that a workshop', speak, streaming = true}) {
  const events = [], marks = {};
  const note = name => { marks[name] = performance.now(); events.push(name); };
  const streams = new Map();
  const mic = new MicrophoneSession({minRecordMs: 0,
    hostFactory: createLocalSttChannel({stt: stt(said), capture: capture(), reply: (config, options) => host.reply(config, options)}),
    onState: async () => {},
    prepareReply: async (inputValue, signal) => {
      if (!streaming) return undefined;
      const streamed = startVoiceKeyStream({stream: new ReplyStream({name: 'Judy Alvarez', isTag: hasEmotionTag}), signal,
        speak: arguments_ => speak({...arguments_, note})});
      streams.set(inputValue.requestId, streamed);
      return streamed.options;
    },
    onReply: async (inputValue, result) => {
      note('replyHandedOn');
      const streamed = streams.get(inputValue.requestId);
      if (!streamed) { marks.whole = result; return; }
      streamed.finish({...result, transport: 'realtime'});
      marks.spoken = await streamed.spoken;
      note('spokenDone');
    },
    onError: async (_input, error) => { events.push('error:' + error.message); streams.get(input.requestId)?.fail(error); }});
  await mic.start(input, turn);
  await mic.finish(input.requestId, {input, config: turn});
  return {events, marks, streams};
}

test('the first sentence is voiced while the model is still writing, with the transcript, and the finished reply is merged in at the end', async () => {
  const text = 'No, it is not. It is a workshop, a real one. I just finished a few tweaks on a couple of old dolls, if you can believe that.';
  const {host, close} = await model(text);
  try {
    let said;
    const result = await voiceKey({host, speak: async ({stream, final, userText, note}) => {
      const head = await stream.headReady;
      said = userText();
      note('headVoiced');
      const finished = await final;
      return {head, text: finished.text, userText: said};
    }});
    assert.deepEqual(result.events, ['headVoiced', 'replyHandedOn', 'spokenDone'], 'the head is voiced before the model has finished');
    assert.ok(result.marks.replyHandedOn - result.marks.headVoiced > 20, 'the model kept writing after the head was voiced');
    assert.equal(result.marks.spoken.head, 'No, it is not. It is a workshop, a real one.');
    assert.equal(result.marks.spoken.text, text);
    assert.equal(result.marks.spoken.userText, 'is that a workshop', 'the transcript is known before the first sentence is voiced');
  } finally { await close(); }
});

test('without the hook the reply is only available when it is whole, as before', async () => {
  const {host, close} = await model('No, it is not. It is a workshop, a real one. I just finished a few tweaks.');
  try {
    const result = await voiceKey({host, streaming: false, speak: async () => { throw Error('not used'); }});
    assert.deepEqual(result.events, ['replyHandedOn']);
    assert.equal(result.marks.whole.text, 'No, it is not. It is a workshop, a real one. I just finished a few tweaks.');
  } finally { await close(); }
});

test('a reply with no safe first sentence is voiced whole: the voice waits for the finished reply', async () => {
  const {host, close} = await model('Hey. Sure. Okay then.');
  try {
    const result = await voiceKey({host, speak: async ({stream, final, note}) => {
      const head = await stream.headReady;
      note(head ? 'headVoiced' : 'noHead');
      return {head, text: (await final).text};
    }});
    assert.deepEqual(result.events, ['noHead', 'replyHandedOn', 'spokenDone']);
    assert.equal(result.marks.spoken.head, null);
    assert.equal(result.marks.spoken.text, 'Hey. Sure. Okay then.');
  } finally { await close(); }
});

test('a failed or cancelled turn aborts the voice and rejects what it waits for', async () => {
  const seen = [];
  const streamed = startVoiceKeyStream({stream: new ReplyStream({}), signal: undefined,
    speak: async ({signal, final}) => { signal.addEventListener('abort', () => seen.push('aborted')); return final; }});
  await sleep(2);
  streamed.fail(Error('model failed'));
  await assert.rejects(streamed.spoken, /model failed/);
  assert.deepEqual(seen, ['aborted']);

  const controller = new AbortController(), cancelled = [];
  const other = startVoiceKeyStream({stream: new ReplyStream({}), signal: controller.signal,
    speak: async ({signal}) => { signal.addEventListener('abort', () => cancelled.push('aborted')); await new Promise(done => setTimeout(done, 20)); return 'x'; }});
  await sleep(2);
  controller.abort();
  assert.equal(await other.spoken, 'x');
  assert.deepEqual(cancelled, ['aborted'], 'the mic session\'s cancel reaches the voice');

  const stale = startVoiceKeyStream({stream: new ReplyStream({}), signal: undefined, speak: async ({final}) => final});
  stale.abort();
  await assert.rejects(stale.spoken, /cancelled/);
  stale.finish({text: 'late'});   // a late result changes nothing
});

test('the bridge starts the voice from prepareReply for a local voice on a text route and hands the finished reply over in onReply', () => {
  const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(turnUsesLocal\(input\)\) \{\s*if \(!mistral\.active \|\| !replyStreaming \|\| input\.reaction \|\| !prepared\) return;/);
  assert.match(source, /startVoiceKeyStream\(\{stream: newReplyStream\(config, profile\), signal,/);
  assert.match(source, /streamed\.finish\(\{\.\.\.result, transport: 'realtime'\}\); spoken = await streamed\.spoken;/);
  assert.match(source, /microphoneStreams\.get\(input\.requestId\)\?\.fail\(error\);/);
  assert.match(source, /async function voiceStreamedReply\(/);
  assert.match(source, /return voiceStreamedReply\(input, profile, \{signal, current, stream, final, config\}\);/);
});
