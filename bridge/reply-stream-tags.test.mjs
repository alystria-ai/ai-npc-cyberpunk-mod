// The streamed head through the real text host with Expressive emotions on: the model opens every reply with a {tag}, and the
// head (display text) must still be found while the reply is being written (2026-10-13 live record: it never was).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {TextProviderHost, mistralRoute} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {GroqKey} from './groq-key.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {ReplyStream} from './reply-stream.mjs';
import {hasEmotionTag} from './emotion-tags.mjs';
import {NaturalSpeech} from './natural-speech.mjs';
import {ExpressiveEmotions} from './expressive-emotions.mjs';

const KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];

async function harness(reply, {pieceMs = 8} = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', async () => {
      requests.push(1);
      response.writeHead(200, {'content-type': 'text/event-stream'});
      for (const piece of reply.match(/.{1,8}/gs)) {
        response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: piece}}]})}\n\n`);
        await new Promise(done => setTimeout(done, pieceMs));
      }
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${KEY}\n`, writeText: async () => {}, groq: new GroqKey({keyPath: 'g.txt'})});
  await provider.load(); provider.setPreference('mistral'); provider.apply();
  const memory = await MistralMemory.open({path: null});
  const speech = new NaturalSpeech(), emotions = new ExpressiveEmotions();
  const host = new TextProviderHost({provider, memory, personas: new PersonaBook(roster), log: () => {},
    transformReply: result => emotions.process(speech.process(result)),
    routes: {mistral: mistralRoute({provider, gapMs: 0, cacheScope: 'x', endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`})}});
  return {host, requests, close: async () => { host.close(); server.closeAllConnections?.(); await new Promise(done => server.close(done)); }};
}
const turn = {text: 'Is that a workshop?', sessionId: 's', context: 'CURRENT PERSON\nBench.', local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}};

test('a tagged reply streams a tag-free head before the model is done, and the tail and marks of the finished reply agree with it', async () => {
  const text = '{calm}No, it’s not. It’s a workshop. {joy}I just finished a few tweaks on a couple of old dolls, if you can believe that.';
  const {host, close} = await harness(text);
  try {
    const stream = new ReplyStream({name: 'Judy Alvarez', isTag: hasEmotionTag});
    let headWhen = null;
    stream.onChange(() => { if (headWhen === null) headWhen = stream.complete ? 'after' : 'before'; });
    const result = await host.reply(turn, {stream});
    assert.equal(headWhen, 'before', 'the voice can start while the model is still writing');
    assert.equal(stream.head, 'No, it’s not. It’s a workshop.');
    assert.equal(result.timing.streamedHead, true);
    assert.equal(result.text, 'No, it’s not. It’s a workshop. I just finished a few tweaks on a couple of old dolls, if you can believe that.');
    assert.equal(stream.text, result.text);
    assert.equal(stream.tail, 'I just finished a few tweaks on a couple of old dolls, if you can believe that.');
    assert.deepEqual(result.emotionMarks.map(mark => [mark.at, mark.name]), [[0, 'calm'], [31, 'joy']]);
    assert.deepEqual(stream.headMarks.map(mark => [mark.at, mark.name]), [[0, 'calm']]);
  } finally { await close(); }
});

test('a tagged reply whose sentences are all short has no head, exactly as before', async () => {
  const {host, close} = await harness('{calm}Hey. {interest}What’s up? I was just finishing up some checks.');
  try {
    const stream = new ReplyStream({name: 'Judy Alvarez', isTag: hasEmotionTag});
    const result = await host.reply(turn, {stream});
    assert.equal(stream.head, null);
    assert.equal(result.text, 'Hey. What’s up? I was just finishing up some checks.');
  } finally { await close(); }
});

test('the bridge hands the head\'s emotion marks to the face planner and the live mark list', async () => {
  const {readFileSync} = await import('node:fs');
  const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /const headMarks = expressiveEmotions\.enabled \? stream\.headMarks : \[\];/);
  assert.match(source, /if \(headMarks\.length && !marks\.length\) marks\.push\(\.\.\.headMarks\);/);
  assert.match(source, /\.\.\.\(headMarks\.length \? \{emotionMarks: headMarks\} : \{\}\)/);
});
