// A text-only Convai reply voiced by a local voice while Convai is still writing it (the default route, docs/LATENCY_2026-10-12.md): the host reads the text
// so far from the page and gives it to the reply stream, which finds the first sentence the voice can start on. Offline: a fake page, no browser, no Convai.
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {RealtimeHost, TEXT_STREAM_POLL_MS} from './realtime-host.mjs';
import {ReplyStream, finishedText} from './reply-stream.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const config = {key: 'offline-test-key', characterId: 'judy', endUserId: 'offline-player', scope: 'private:offline-world', ttsEnabled: false, text: 'Hello'};

// A page whose reply call resolves after `finishMs` and whose partial text grows with time: [atMs, text] steps.
function fakePage({steps, finishMs, final = 'Sure thing, V. I can take you there right now. Hop in.'}) {
  const began = performance.now(), calls = {reply: 0, polls: 0, keys: [], replyConfig: null, afterEnd: 0};
  let ended = false;
  const page = {calls,
    evaluate: async (fn, arg) => {
      if (arg && typeof arg === 'object' && 'method' in arg) {
        calls.reply++; calls.replyConfig = arg.config;
        await sleep(finishMs); ended = true;
        return {text: final, sessionID: 'session-1', timing: {}};
      }
      calls.polls++; calls.keys.push(arg);
      if (ended) calls.afterEnd++;
      const age = performance.now() - began;
      // The page function itself answers only to the key the reply call carried.
      const text = [...steps].reverse().find(([at]) => age >= at)?.[1] ?? '';
      return arg === calls.replyConfig?.textStreamKey ? text : '';
    }};
  return page;
}

test('the text so far reaches the reply stream while the reply call is still running, so the first sentence can start the voice early', async () => {
  const host = new RealtimeHost({});
  const page = fakePage({finishMs: 400, steps: [[20, 'Sure thing'], [80, 'Sure thing, V. I can take you there'], [150, 'Sure thing, V. I can take you there right now. Hop in.']]});
  const stream = new ReplyStream({name: 'Judy Alvarez'});
  const began = performance.now();
  const head = stream.headReady.then(text => ({text, atMs: performance.now() - began}));
  const result = await host.evaluateSpeech(page, 'reply', config, {textStream: stream});
  const heard = await head;
  assert.equal(result.text, 'Sure thing, V. I can take you there right now. Hop in.', 'the call still returns the finished reply');
  assert.equal(heard.text, 'Sure thing, V. I can take you there right now.');
  assert.ok(heard.atMs < 300, `the first sentence was ready ${Math.round(heard.atMs)} ms in, well before the reply call ended (400 ms)`);
  assert.equal(page.calls.reply, 1);
  assert.match(page.calls.replyConfig.textStreamKey, /^[0-9a-f-]{36}$/, 'the turn carries its own marker');
  assert.ok(page.calls.keys.every(key => key === page.calls.replyConfig.textStreamKey), 'every poll names that marker');
  assert.ok(page.calls.polls >= 3 && page.calls.polls <= 400 / TEXT_STREAM_POLL_MS + 2, `polled ${page.calls.polls} times`);
  const afterwards = page.calls.polls;
  await sleep(3 * TEXT_STREAM_POLL_MS);
  assert.ok(page.calls.polls <= afterwards + 1, 'polling stops when the reply call has returned');
});

test("without a stream, for a warm-up, nothing is polled and the config is untouched", async () => {
  const host = new RealtimeHost({});
  const plain = fakePage({finishMs: 60, steps: []});
  await host.evaluateSpeech(plain, 'reply', config, {});
  assert.equal(plain.calls.polls, 0);
  assert.equal('textStreamKey' in plain.calls.replyConfig, false);
  const warm = fakePage({finishMs: 60, steps: []});
  await host.evaluateSpeech(warm, 'warm', config, {textStream: new ReplyStream({})});
  assert.equal(warm.calls.polls, 0, 'only a reply is read');
});

test('a poll that fails, or a page that has no text yet, changes nothing, and a failed reply call reaches the caller', async () => {
  const host = new RealtimeHost({});
  const stream = new ReplyStream({name: 'Judy Alvarez'});
  let polls = 0;
  const page = {evaluate: async (fn, arg) => {
    if (arg && typeof arg === 'object' && 'method' in arg) { await sleep(150); throw Error('Convai did not finish the reply'); }
    polls++; throw Error('page busy');
  }};
  await assert.rejects(host.evaluateSpeech(page, 'reply', config, {textStream: stream}), /did not finish/);
  assert.ok(polls >= 1);
  assert.equal(stream.committed, false);
  const after = polls; await sleep(3 * TEXT_STREAM_POLL_MS);
  assert.ok(polls <= after + 1, 'no polling after a failure');
});

test('a reply that is cancelled stops the polling', async () => {
  const host = new RealtimeHost({});
  const page = fakePage({finishMs: 5000, steps: [[0, 'Sure.']]});
  const controller = new AbortController();
  const pending = host.evaluateSpeech(page, 'reply', config, {textStream: new ReplyStream({}), signal: controller.signal});
  pending.catch(() => {});
  await sleep(120); controller.abort();
  await assert.rejects(pending);
  const seen = page.calls.polls; await sleep(4 * TEXT_STREAM_POLL_MS);
  assert.ok(page.calls.polls <= seen + 1);
});

test('the poll ends once the stream has its head: only the first sentence is read this way', async () => {
  const host = new RealtimeHost({});
  const page = fakePage({finishMs: 900, steps: [[0, 'Sure thing, V. I can take you there right now. Hop in.']]});
  const stream = new ReplyStream({name: 'Judy Alvarez'});
  await host.evaluateSpeech(page, 'reply', config, {textStream: stream});
  assert.equal(stream.committed, true);
  assert.ok(page.calls.polls <= 3, `${page.calls.polls} polls for a 900 ms reply whose head was there at once`);
});

test('a page whose client bundle has no early text ends the polling at once and says so once', async () => {
  const lines = [];
  const host = new RealtimeHost({log: line => lines.push(line)});
  let polls = 0;
  const page = {evaluate: async (fn, arg) => {
    if (arg && typeof arg === 'object' && 'method' in arg) { await sleep(300); return {text: 'Hi.', sessionID: 's', timing: {}}; }
    polls++;
    // What the page function itself answers when the bundle has no partialReply.
    return fn.call(null, arg);
  }};
  globalThis.window = {convaiRealtime: {}};
  try {
    await host.evaluateSpeech(page, 'reply', config, {textStream: new ReplyStream({})});
    await host.evaluateSpeech(page, 'reply', config, {textStream: new ReplyStream({})});
  } finally { delete globalThis.window; }
  assert.equal(polls, 2, 'one poll per reply, then nothing');
  assert.equal(lines.filter(line => /no early reply text/.test(line)).length, 1);
});

// The finished Convai text is cleaned the way the head was: the head is a prefix of it, so the reply is not cut to its first sentence (review 2026-10-22).
for (const [label, text, name] of [
  ['an em dash', 'Hey there, V \u2014 good to see you again. How are you doing today, choom?', 'Judy Alvarez'],
  ['an emoji', 'Hey there, V, good to see you \u{1F60A}. How are you doing today, choom?', 'Judy Alvarez'],
  ['a name label', 'Judy Alvarez: Hey there, V, good to see you. How are you doing today, choom?', 'Judy Alvarez'],
  ['a stage direction', '*smiles* Hey there, V, good to see you. How are you doing today, choom?', 'Judy Alvarez'],
  ['a line break', 'Hey there, V, good to see you.\nHow are you doing today, choom?', 'Judy Alvarez'],
  ['markdown', '**Hey there, V**, good to see you. How are you doing today, choom?', 'Judy Alvarez'],
  ['nothing to clean', 'Hey there, V, good to see you. How are you doing today, choom?', 'Judy Alvarez'],
]) {
  test(`a Convai reply with ${label} in its first sentence is finished whole, not cut to the sentence the voice has`, () => {
    const stream = new ReplyStream({name});
    for (let at = 12; at < text.length; at += 9) stream.update(text.slice(0, at));
    stream.update(text);
    assert.ok(stream.committed, 'a head was found while the text arrived');
    const finished = finishedText(stream, text);
    assert.ok(finished.length > stream.head.length + 20, `cut to the head: ${JSON.stringify(finished)}`);
    assert.ok(finished.startsWith(stream.head));
    assert.match(finished, /How are you doing today, choom\?$/);
    stream.finish(finished, {text: finished});
    assert.ok(stream.tail.length > 20, 'the rest of the reply is still voiced after the head');
    assert.doesNotMatch(finished, /[\u2014*\u{1F60A}\n]|^Judy Alvarez:/u);
  });
}

test('a finished Convai reply that really disagrees with the head is cut back to it, as on the text routes', () => {
  const stream = new ReplyStream({name: 'Judy Alvarez'});
  stream.update('Hey there, V, good to see you. How are');
  assert.ok(stream.committed);
  assert.equal(finishedText(stream, 'Oh, hello again. Something else entirely, V.'), stream.head);
  const empty = new ReplyStream({name: 'Judy'});
  assert.equal(finishedText(empty, '\u{1F60A}'), '\u{1F60A}', 'nothing left after cleaning and no head: the text as it came');
});

test('the bridge routes a Convai text turn with a local voice through the reply stream, finishes or fails that stream, and keeps the setting and look-ahead exclusions', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').split('\r\n').join('\n');
  assert.ok(bridge.includes('if (!mistral.active && replyStreaming && !current?.ahead && !input.reaction) return respondConvaiStreamed('), 'the route: setting on, no held look-ahead speaker, no reaction line');
  const body = bridge.slice(bridge.indexOf('async function respondConvaiStreamed'), bridge.indexOf('const newReplyStream'));
  assert.ok(body.includes('textStream: stream'));
  assert.ok(body.includes('stream.finish(text, done)'));
  assert.ok(body.includes('stream.fail(error)'));
  assert.ok(body.includes('finishedText(stream, result.text)'), 'the finished text is cleaned like the head, then cut back to it only when it disagrees');
  // A turn that speaks with Convai's own voice never reaches it (convaiReply returns first).
  assert.ok(bridge.indexOf('return convaiReply(input, profile, current, signal);') < bridge.indexOf('return respondConvaiStreamed(input'));
});
