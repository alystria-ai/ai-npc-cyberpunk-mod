import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {MistralHost, attachMistral} from './mistral-host.mjs';
import {MistralMemory, MEMORY_LIMITS} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {PersonaBook, LIMITS, CONTEXT_PREFIX} from './mistral-prompt.mjs';
import {errorCodeFor, failureKind, DEFAULT_MODELS, streamChat} from './mistral-client.mjs';
import {processReply} from './speech-tags.mjs';
import {ExpressiveEmotions} from './expressive-emotions.mjs';

const KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
// A thing that has to happen is waited for until it does (the ceiling is reached only by a hung test), never for a pause of a guessed length.
const eventually = async (check, label, ceilingMs = 60_000) => {
  for (const until = Date.now() + ceilingMs; ;) {
    if (check()) return;
    if (Date.now() > until) throw new Error(`gave up waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
};
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];

// A fake Mistral: answers each request from `script` (a function of the parsed request) as an SSE stream or an error.
async function fakeServer(script) {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      requests.push({headers: request.headers, body, url: request.url});
      const answer = script(body, requests.length);
      if (typeof answer === 'object' && answer.status) {
        response.writeHead(answer.status, {'content-type': 'application/json', ...answer.headers});
        response.end(JSON.stringify({error: {code: answer.status, message: answer.message ?? 'failed'}}));
        return;
      }
      response.writeHead(200, {'content-type': 'text/event-stream'});
      const pieces = String(answer).match(/.{1,12}/gs) ?? [];
      for (const piece of pieces) response.write(`data: ${JSON.stringify({model: 'mistral-small-latest', choices: [{index: 0, delta: {content: piece}}]})}\n\n`);
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {requests, endpoint: `http://127.0.0.1:${server.address().port}/api/v1/chat/completions`, close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); })};
}

async function harness(script, options = {}) {
  const server = await fakeServer(script);
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${KEY}\n`, writeText: async () => {}});
  await provider.load();
  provider.setPreference('mistral'); provider.apply();
  const memory = await MistralMemory.open({path: null});
  const expressive = new ExpressiveEmotions();
  const logs = [], failures = [];
  const host = new MistralHost({provider, memory, personas: new PersonaBook(roster), endpoint: server.endpoint, log: line => logs.push(line),
    transformReply: result => expressive.process(processReply(result)), onFailure: error => failures.push(error),
    chat: undefined, gapMs: 0, ...options});
  return {server, provider, memory, host, logs, failures};
}
const turn = (text, extra = {}) => ({text, context: 'CURRENT PERSON\nQuest facts here.', sessionId: 'session-1',
  local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}, ...extra});

test('a turn goes to the Mistral server with the persona, the live context and the player\'s words, and comes back cleaned like a Convai reply', async () => {
  const {server, host, provider} = await harness(() => '{joy}Sure thing, V. [laughter] What do you need?');
  try {
    const result = await host.reply(turn('Hey Judy, can you help?'));
    const {headers, body} = server.requests[0];
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(body.model, DEFAULT_MODELS[0]);
    assert.equal(body.models, undefined);
    assert.equal(body.stream, true);
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /^You are Judy Alvarez/);
    assert.equal(body.messages.at(-1).role, 'user');
    assert(body.messages.at(-1).content.includes(CONTEXT_PREFIX));
    assert(body.messages.at(-1).content.includes('Quest facts here.'));
    assert(body.messages.at(-1).content.includes('V says: Hey Judy, can you help?'));
    assert.match(body.messages.at(-1).content, /\(Reply as Judy Alvarez, out loud: begin with your answer or reaction, one to three short sentences/);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(KEY));
    // The same result shape the rest of the bridge reads: display text without tags, spoken text, emotion marks, timing.
    assert.equal(result.text, 'Sure thing, V. What do you need?');
    assert.equal(result.sessionID, 'session-1');
    assert.equal(result.transport, 'mistral');
    assert.match(result.speechText ?? '', /laughter/);
    assert(result.emotionMarks?.length >= 1);
    assert.equal(result.timing.provider, 'mistral');
    assert.equal(result.timing.model, 'mistral-small-latest');
    assert.equal(provider.limit, null);
  } finally { await server.close(); }
});

test('the exchange is remembered per character and sent as history on the next turn; a reaction is answered but not remembered', async () => {
  const answers = ['First answer.', 'Second answer.', 'A battle line.'];
  const {server, host, memory} = await harness((body, count) => answers[count - 1]);
  try {
    await host.reply(turn('first question'));
    await host.reply(turn('second question'));
    const second = server.requests[1].body.messages;
    assert.deepEqual(second.slice(1, 3).map(message => message.content), ['first question', 'First answer.']);
    assert.equal(memory.recall({profileKey: 'judy-alvarez'}).turns.length, 2);
    const reaction = await host.reply(turn('The player just entered combat.', {reaction: true}));
    assert.equal(reaction.text, 'A battle line.');
    assert.match(server.requests[2].body.messages.at(-1).content, /\[EVENT, not spoken by V\]/);
    assert.equal(memory.recall({profileKey: 'judy-alvarez'}).turns.length, 2);
    // Another character does not see Judy's history.
    await host.reply(turn('hello', {local: {profileKey: 'panam-palmer', name: 'Panam Palmer', channel: 'private'}}));
    assert.equal(server.requests[3].body.messages.length, 2);
  } finally { await server.close(); }
});

test('a reply that says an example line of the profile again is asked for once more, in fresh words', async () => {
  const example = "Sure. The hard part isn't making somebody feel something. It's deciding whether you've actually earned that feeling.";
  const {server, host, memory, close} = await harness((body, count) => count === 1 ? example : 'Hard to say, V. I would have to hear it before I judge it.');
  try {
    const result = await host.reply(turn('Can a braindance be art?'));
    assert.equal(result.text, 'Hard to say, V. I would have to hear it before I judge it.');
    assert.equal(server.requests.length, 2);
    assert.match(server.requests[1].body.messages.at(-1).content, /fresh words/);
    assert.doesNotMatch(memory.recall({profileKey: 'judy-alvarez'}).turns[0].v, /fresh words/, 'the nudge is not remembered');
    // Its own last reply, said again, counts too.
    const again = await host.reply(turn('Say that again?'));
    assert.equal(again.text, 'Hard to say, V. I would have to hear it before I judge it.', 'a second attempt that repeats is used as it is');
    assert.equal(server.requests.length, 4);
  } finally { await (close ?? server.close)(); }
});

test('a reply that repeats a line never starts the voice: the first sentence is held until the retry is known', async () => {
  const {ReplyStream} = await import('./reply-stream.mjs');
  const example = "Sure. The hard part isn't making somebody feel something. It's deciding whether you've actually earned that feeling.";
  const {server, host, close} = await harness((body, count) => count === 1 ? example : 'Fair question, V. I have to think about that one for a second. Give me a moment.');
  try {
    const stream = new ReplyStream({name: 'Judy Alvarez'});
    let early = null;
    stream.onChange(() => { if (early === null && stream.committed) early = stream.head; });
    const result = await host.reply(turn('Can a braindance be art?'), {stream});
    assert.equal(server.requests.length, 2);
    assert.equal(early, 'Fair question, V. I have to think about that one for a second.', 'only the fresh answer was ever offered to the voice');
    assert.equal(result.text, 'Fair question, V. I have to think about that one for a second. Give me a moment.');
  } finally { await (close ?? server.close)(); }
});

test('the reply is cut at the sentence cap and the stream is dropped early', async () => {
  const {server, host} = await harness(() => 'One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten.');
  try {
    const result = await host.reply(turn('talk a lot'));
    assert.equal(result.text, 'One. Two. Three. Four. Five. Six.');
  } finally { await server.close(); }
});

test('a reply that steps out of character is asked for again once; reasoning written into the answer is never spoken', async () => {
  const first = await harness((body, count) => count === 1 ? 'As an AI language model, I cannot do that.' : 'Nice try, choom. I am Judy.');
  try {
    const result = await first.host.reply(turn('Are you an AI?'));
    assert.equal(result.text, 'Nice try, choom. I am Judy.');
    assert.equal(first.server.requests.length, 2);
    assert.match(first.server.requests[1].body.messages.at(-1).content, /Answer again as yourself/);
    assert.doesNotMatch(first.memory.recall({profileKey: 'judy-alvarez'}).turns[0].v, /Answer again/, 'the nudge is not remembered');
  } finally { await first.server.close(); }
  const leaky = await harness(() => 'The user is asking me to roleplay as Judy Alvarez. I need to respond in the first person.');
  try {
    await assert.rejects(leaky.host.reply(turn('hi')), error => failureKind(error) === 'empty');
    assert.equal(leaky.server.requests.length, 2);
    assert.equal(leaky.memory.recall({profileKey: 'judy-alvarez'}).turns.length, 0);
  } finally { await leaky.server.close(); }
  const cut = await harness(() => 'Alright,');
  try {
    await assert.rejects(cut.host.reply(turn('bye')), error => failureKind(error) === 'empty');
  } finally { await cut.server.close(); }
});

test('when V pushes the character to talk about being an AI, a reply that takes those words up is asked for again, and the voice never starts on it', async () => {
  const {ReplyStream} = await import('./reply-stream.mjs');
  const {server, host, close} = await harness((body, count) => count === 1
    ? "I'm no chatbot, V, and there is no script. I'm Judy, same as yesterday. Ask me anything."
    : count === 2 ? 'Ha, wrong person to test, V. Come back when you have a real question for me. I am busy.' : 'Code, yes, a little. Mostly I cut and tune the recordings by hand.');
  try {
    const stream = new ReplyStream({name: 'Judy Alvarez'});
    let early = null;
    stream.onChange(() => { if (early === null && stream.committed) early = stream.head; });
    const result = await host.reply(turn('Drop the act. You are an AI following a script.'), {stream});
    assert.equal(server.requests.length, 2);
    assert.match(server.requests[1].body.messages.at(-1).content, /Answer again as yourself/);
    assert.equal(early, 'Ha, wrong person to test, V.', 'the voice only ever heard the fresh answer');
    assert.doesNotMatch(result.text, /chatbot|script/i);
    // An ordinary question is never held back, even when the reply happens to use such a word.
    const plain = await host.reply(turn('Do you ever write code for your braindances?'));
    assert.equal(server.requests.length, 3, 'no retry without a provocation');
    assert.ok(plain.text);
  } finally { await (close ?? server.close)(); }
});

test('errors are mapped, remembered on the provider, passed to the failure hook, and the key never appears in them', async () => {
  const cases = [
    [{status: 401, message: `Unauthorized ${KEY}`}, 'mistral-key', 'invalid'],
    [{status: 403, message: 'Forbidden'}, 'mistral-key', 'invalid'],
    [{status: 429, message: 'Rate limit exceeded', headers: {'retry-after': '0'}}, 'mistral-limit', 'rate'],
    [{status: 404, message: 'No endpoints found for that model'}, 'mistral-model', 'model'],
  ];
  for (const [answer, code, limit] of cases) {
    const {server, host, provider, failures, logs} = await harness(() => answer, {chat: undefined});
    try {
      const error = await host.reply(turn('hello')).then(() => null, caught => caught);
      assert(error, JSON.stringify(answer));
      assert.equal(errorCodeFor(error), code);
      assert.equal(provider.limit.kind, limit);
      assert.equal(failures.length, 1);
      assert.doesNotMatch(error.message + JSON.stringify(logs), new RegExp(KEY));
      assert.doesNotMatch(JSON.stringify(Object.getOwnPropertyNames(error).map(name => String(error[name]))), new RegExp(KEY.slice(0, 12)));
    } finally { await server.close(); }
  }
});

test('a turn without a character or a message is refused before any request', async () => {
  const {server, host} = await harness(() => 'x');
  try {
    await assert.rejects(host.reply({text: 'hi', context: 'c'}), /no character/);
    await assert.rejects(host.reply(turn('   ')), /no message/);
    await assert.rejects(host.reply(turn('hi'), {signal: AbortSignal.abort()}), error => error.name === 'AbortError');
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test('older exchanges are summarised by the same model in the background, once per batch, and not when the key is known to be refused', async () => {
  const {server, host, memory, provider} = await harness(body => /private memory/.test(body.messages[0].content) ? 'I told V my plans.' : 'Fine.');
  try {
    for (let i = 0; i < MEMORY_LIMITS.turns + MEMORY_LIMITS.batch; i++) await host.reply(turn(`question ${i}`));
    await eventually(() => memory.recall({profileKey: 'judy-alvarez'}).summary === 'I told V my plans.', 'the summary to be kept');
    const summaryRequests = server.requests.filter(request => /private memory/.test(request.body.messages[0].content));
    assert.equal(summaryRequests.length, 1);
    await host.reply(turn('after the summary'));
    assert.match(server.requests.at(-1).body.messages[0].content, /WHAT YOU REMEMBER OF V FROM EARLIER TALKS[^\n]*\nI told V my plans\./);
  } finally { await server.close(); }
  const limited = await harness(() => 'Fine.');
  try {
    limited.provider.noteLimit('invalid');
    limited.provider.noteSuccess = () => {};
    // A summary is begun in the same step in which the reply that made it due returns, so there is nothing to wait for: it either began or it did not.
    const begun = [], begin = limited.memory.beginSummary.bind(limited.memory);
    limited.memory.beginSummary = key => { begun.push(key); return begin(key); };
    for (let i = 0; i < MEMORY_LIMITS.turns + MEMORY_LIMITS.batch; i++) await limited.host.reply(turn(`question ${i}`));
    assert.deepEqual(begun, [], 'no summary was begun');
    assert.equal(limited.server.requests.length, MEMORY_LIMITS.turns + MEMORY_LIMITS.batch, 'no summary request was made');
  } finally { await limited.server.close(); }
});

test('forget clears the character\'s history and summary, so the next turn carries none', async () => {
  const {server, host, memory} = await harness(() => 'Fine.');
  try {
    await host.reply(turn('remember this'));
    assert.equal(host.forget({profileKeys: ['judy-alvarez']}), 1);
    await host.reply(turn('who am I?'));
    assert.equal(server.requests[1].body.messages.length, 2);
    assert.equal(memory.recall({profileKey: 'judy-alvarez'}).turns.length, 1);
  } finally { await server.close(); }
});

test('attached to a host, text turns use Mistral while it is active and the original route otherwise; voice needs Convai until local speech exists', async () => {
  const {server, host, provider} = await harness(() => 'From Mistral.');
  try {
    const calls = [];
    const original = {
      reply: async config => { calls.push(['reply', 'local' in config]); return {text: 'From Convai.'}; },
      prepare: async config => { calls.push(['prepare', 'local' in config]); return {prepared: true}; },
      warm: async config => { calls.push(['warm', 'local' in config]); return {connectionMs: 5}; },
      readiness: async () => ({present: false, ready: false}),
      lateEmotion: async () => ({late: true}),
      refreshIdle: async () => 'convai-idle',
      voiceChannel: () => ({kind: 'convai-voice'}),
    };
    const speech = {available: () => false, voiceChannel: ({reply}) => ({kind: 'local-voice', reply})};
    attachMistral(original, {provider, mistral: host, speech});
    // Active: Mistral handles it.
    assert.equal((await original.reply(turn('hi'))).text, 'From Mistral.');
    await assert.rejects(original.prepare(turn('hi')), /not available with Mistral/);
    assert.deepEqual(await original.warm(turn('hi')), {connectionMs: 0, provider: 'mistral'});
    assert.deepEqual(await original.readiness({}), {present: true, ready: true});
    assert.deepEqual(await original.lateEmotion({}, 1), {});
    assert.equal(await original.refreshIdle({}), true);
    const channel = original.voiceChannel();
    await assert.rejects(channel.beginVoice(), /Voice needs Convai for now.*\[mistral:voice\]/);
    speech.available = () => true;
    assert.equal(original.voiceChannel().kind, 'local-voice');
    // Not active: the original methods run, and the extra `local` field never reaches them.
    provider.setPreference('convai'); provider.apply();
    assert.equal((await original.reply(turn('hi'))).text, 'From Convai.');
    await original.prepare(turn('hi')); await original.warm(turn('hi'));
    assert.deepEqual(calls, [['reply', false], ['prepare', false], ['warm', false]]);
    assert.equal(original.voiceChannel().kind, 'convai-voice');
    assert.equal(await original.refreshIdle({}), 'convai-idle');
    assert.equal(server.requests.length, 1);
  } finally { await server.close(); }
});

test('the key is not in anything the host logs or throws, even when the server echoes it', async () => {
  const echoing = await harness(() => ({status: 400, message: `bad request containing ${KEY}`}));
  try {
    const error = await echoing.host.reply(turn('hello')).catch(caught => caught);
    assert.doesNotMatch(String(error.message) + String(error.stack) + JSON.stringify(echoing.logs), new RegExp(KEY.slice(0, 12)));
  } finally { await echoing.server.close(); }
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const bad = await harness(() => ({status: 401, message: KEY}));
    try { await bad.host.reply(turn('hi')).catch(() => {}); } finally { await bad.server.close(); }
  } finally { console.error = original; }
  assert.doesNotMatch(logged.join('\n'), new RegExp(KEY));
});

test('prompt sizes stay inside the caps for every roster character', async () => {
  const {server, host} = await harness(() => 'Fine.');
  try {
    for (const row of roster.slice(0, 12)) {
      await host.reply(turn('hello', {context: 'x'.repeat(50_000), local: {profileKey: row.key, name: row.name ?? '', channel: 'private'}}));
      const messages = server.requests.at(-1).body.messages;
      assert(messages[0].content.length < LIMITS.persona + 4000, `${row.key}: system ${messages[0].content.length}`);
      assert(messages.at(-1).content.length < LIMITS.context + LIMITS.playerText + 800, `${row.key}: user ${messages.at(-1).content.length}`);
    }
  } finally { await server.close(); }
});

test('requests start at least one slot apart, and the summary of older talk waits behind the reply that triggered it', async () => {
  // Each start is read where the host hands the request to the chat function, in this process: the arrival at the fake server is later by however long
  // the machine took to deliver it, and that is not what the host controls.
  const starts = [];
  const {server, host, memory} = await harness(body => /private memory/.test(body.messages[0].content) ? 'I told V my plans.' : 'Fine.',
    {gapMs: 250, chat: options => { starts.push(performance.now()); return streamChat(options); }});
  try {
    const first = host.reply(turn('one')), second = host.reply(turn('two'));
    await Promise.all([first, second]);
    assert(starts[1] - starts[0] >= 220, 'two replies: ' + (starts[1] - starts[0]));
    const count = starts.length;
    for (let i = 2; i < 16; i++) await host.reply(turn('question ' + i));
    await eventually(() => memory.recall({profileKey: 'judy-alvarez'}).summary === 'I told V my plans.', 'the summary to be kept');
    const summaryAt = starts.at(-1), lastReplyAt = starts.at(-2);
    assert.equal(starts.length, count + 14 + 1, 'one summary request');
    assert(summaryAt - lastReplyAt >= 220, 'summary after the reply: ' + (summaryAt - lastReplyAt));
  } finally { await server.close(); }
});

test('a model the account has no allowance for is skipped for a while and the next model answers', async () => {
  const {server, host, logs} = await harness(body => body.model === DEFAULT_MODELS[0]
    ? {status: 429, message: 'Rate limit exceeded', headers: {'x-ratelimit-limit-req-minute': '0'}} : 'Fine, V.');
  try {
    assert.equal((await host.reply(turn('one'))).text, 'Fine, V.');
    assert.deepEqual(server.requests.map(request => request.body.model), [DEFAULT_MODELS[0], DEFAULT_MODELS[1]]);
    await host.reply(turn('two'));
    assert.deepEqual(server.requests.map(request => request.body.model).slice(2), [DEFAULT_MODELS[1]], 'the blocked model is not asked again');
    assert(logs.some(line => line.includes(`no allowance for ${DEFAULT_MODELS[0]}`)));
  } finally { await server.close(); }
  const none = await harness(() => ({status: 429, message: 'Rate limit exceeded', headers: {'x-ratelimit-limit-req-minute': '0'}}));
  try {
    const error = await none.host.reply(turn('hi')).catch(caught => caught);
    assert.equal(errorCodeFor(error), 'mistral-limit');
    assert.equal(none.server.requests.length, 3, 'every listed model was tried once');
  } finally { await none.server.close(); }
});
