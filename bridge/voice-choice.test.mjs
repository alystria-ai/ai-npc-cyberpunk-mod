import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createVoiceChoice, KeySender, parseHub, scrollKeys} from './voice-choice.mjs';

// Speak dialogue choices (docs/VOICE_CHOICES.md), the bridge half: the detector's start and end of speech, the recording, the match, and the keys. The microphone,
// the recogniser, the key presser and the game's list are stand-ins; the recording session (bridge/microphone-session.mjs) and the matcher are the real ones.

const hubOf = (texts, selected = 0, fp = 'h1') => ({open: true, fp, hubId: 7, selected, texts});
const waitFor = async (test, what, ms = 1500) => {
  const until = Date.now() + ms;
  while (!test()) { if (Date.now() > until) throw Error('timed out waiting for ' + what); await new Promise(done => setTimeout(done, 5)); }
};

function rig({words = 'option three', texts = ['Who are you?', 'Tell me about the job.', 'Never mind.'], selected = 0, enabled = true, error = null, scrollWorks = true, speechDelay = 0} = {}) {
  const calls = {sent: [], quit: 0, published: [], opened: [], released: [], stopped: [], began: 0, closed: 0, cancelled: 0};
  const state = {hub: hubOf(texts, selected), on: enabled, words};
  const sender = {
    start() { calls.senderStarted = (calls.senderStarted ?? 0) + 1; },
    async send(keys) {
      calls.sent.push([...keys]);
      if (keys[0] === 'down' && scrollWorks) state.hub = {...state.hub, selected: state.hub.selected + keys.length};
      if (keys[0] === 'up' && scrollWorks) state.hub = {...state.hub, selected: state.hub.selected - keys.length};
      if (keys[0] === 'apply') state.hub = {open: false, fp: '', hubId: null, selected: null, texts: []};
      return {ok: true, sent: keys.length};
    },
    quit() { calls.quit++; },
  };
  const tap = {listening: true, vadStatus: {onsetMs: 1200},
    open(owner, options) { calls.opened.push([owner, options]); return Promise.resolve({device: 'mic'}); },
    stop(owner) { calls.stopped.push(owner); return Promise.resolve(); },
    release(owner, reason) { calls.released.push([owner, reason]); return Promise.resolve(); }};
  const speech = {voiceChannel: () => ({
    async beginVoice() { calls.began++; return {device: 'mic'}; },
    async endCapture() {},
    async finishVoice() {
      if (speechDelay) await new Promise(done => setTimeout(done, speechDelay));
      if (error) throw error;
      return {userText: state.words, text: '', local: true};
    },
    async close() { calls.closed++; },
  })};
  const choice = createVoiceChoice({speech, tap, readHub: async () => state.hub, publish: async body => { calls.published.push(body); },
    enabled: () => state.on, makeSender: () => sender, sleepFn: () => new Promise(done => setTimeout(done, 1)), limits: {minGapMs: 0, scrollWaitMs: 80, scrollPollMs: 2}});
  const speak = async () => { choice.onVad({phase: 'speech', onsetMs: 1200}); await waitFor(() => calls.began > 0, 'the recording to open'); choice.onVad({phase: 'ended', endMs: 2600}); };
  return {choice, calls, state, speak};
}

test('a spoken position moves the highlight, checks it, then applies', async () => {
  const {calls, speak} = rig();
  await speak();
  await waitFor(() => calls.published.length > 0, 'the result');
  assert.deepEqual(calls.sent, [['down', 'down'], ['apply']]);
  assert.equal(calls.published[0].status, 'pick');
  assert.equal(calls.published[0].index, 2);
  assert.equal(calls.published[0].reason, 'number');
  assert.equal(calls.senderStarted, 1, 'the key presser starts while the player speaks');
  assert.equal(calls.quit, 1, 'and is gone after the pick');
  // The recording took the listening tap from before the detected start (the pre-roll), as a Voice activation turn does.
  assert.equal(calls.opened.length, 1);
  assert.equal(calls.opened[0][1].vad, true);
  assert.equal(calls.opened[0][1].sinceMs, 1200 - 300);
  assert.ok(calls.released.length >= 1, 'the tap is released when the recording is over');
});

test('the words of a caption pick it; already highlighted means only Enter; going up uses the up key', async () => {
  const one = rig({words: 'tell me about the job', selected: 1});
  await one.speak();
  await waitFor(() => one.calls.published.length > 0, 'the result');
  assert.deepEqual(one.calls.sent, [['apply']]);
  assert.equal(one.calls.published[0].index, 1);
  const up = rig({words: 'never mind', selected: 2, texts: ['Who are you?', 'Tell me about the job.', 'Never mind.']});
  up.state.hub = hubOf(['Who are you?', 'Tell me about the job.', 'Never mind.'], 2);
  const first = rig({words: 'who are you', selected: 2});
  await first.speak();
  await waitFor(() => first.calls.published.length > 0, 'the result');
  assert.deepEqual(first.calls.sent, [['up', 'up'], ['apply']]);
});

test('two options that fit, or none: no key is pressed, the game is told', async () => {
  for (const [words, status] of [['who', 'none'], ['tell me', 'ambiguous'], ['pass the controller', 'none'], ['option nine', 'ambiguous']]) {
    const {calls, speak} = rig({words, texts: ['Tell me about the job.', 'Tell me about Jackie.', 'Never mind.']});
    await speak();
    await waitFor(() => calls.published.length > 0, 'the result for ' + words);
    assert.equal(calls.published[0].status, status, words);
    assert.deepEqual(calls.sent, [], 'no key for ' + words);
    assert.equal(calls.quit, 1);
  }
});

test('a list that changed while the player spoke is never picked from', async () => {
  const {calls, state, speak} = rig({speechDelay: 30});
  const spoken = speak();
  await spoken;
  state.hub = hubOf(['Something else.', 'Other.', 'More.'], 0, 'h2');
  await new Promise(done => setTimeout(done, 80));
  assert.deepEqual(calls.sent, []);
  assert.deepEqual(calls.published, []);
});

test('a highlight that does not move stops before Enter', async () => {
  const {calls, speak} = rig({scrollWorks: false});
  await speak();
  await waitFor(() => calls.published.length > 0, 'the result');
  assert.deepEqual(calls.sent, [['down', 'down']], 'Enter is not pressed');
  assert.equal(calls.published[0].status, 'error');
  assert.equal(calls.published[0].reason, 'highlight-did-not-move');
});

test('an unknown highlight is not guessed', async () => {
  const {calls, state, speak} = rig();
  state.hub = {...state.hub, selected: null};
  await speak();
  await waitFor(() => calls.published.length > 0, 'the result');
  assert.deepEqual(calls.sent, []);
  assert.equal(calls.published[0].reason, 'selection-unknown');
});

test('off: the detector is ignored', async () => {
  const {choice, calls} = rig({enabled: false});
  choice.onVad({phase: 'speech', onsetMs: 10});
  await new Promise(done => setTimeout(done, 30));
  assert.equal(calls.began, 0);
  assert.equal(calls.opened.length, 0);
});

test('no list on screen: the detector is ignored', async () => {
  const {choice, calls, state} = rig();
  state.hub = {open: false, fp: '', hubId: null, selected: null, texts: []};
  choice.onVad({phase: 'speech', onsetMs: 10});
  await new Promise(done => setTimeout(done, 30));
  assert.equal(calls.began, 0);
});

test('a sound that was not speech says nothing; no recogniser says so once', async () => {
  const quiet = rig({error: Error('No speech was heard')});
  await quiet.speak();
  await new Promise(done => setTimeout(done, 60));
  assert.deepEqual(quiet.calls.published, []);
  assert.equal(quiet.calls.quit, 1);
  const missing = rig({error: Object.assign(Error('Local speech recognition is not installed'), {code: 'local-stt-unavailable'})});
  await missing.speak();
  await waitFor(() => missing.calls.published.length > 0, 'the result');
  assert.equal(missing.calls.published[0].status, 'unavailable');
});

test('the list closing while the player speaks drops the recording', async () => {
  const {choice, calls, state} = rig({speechDelay: 200});
  choice.onVad({phase: 'speech', onsetMs: 10});
  await waitFor(() => calls.began > 0, 'the recording');
  state.hub = {open: false, fp: '', hubId: null, selected: null, texts: []};
  choice.hubChanged(state.hub);
  await new Promise(done => setTimeout(done, 40));
  assert.equal(choice.active, false);
  assert.equal(calls.quit, 1);
  assert.deepEqual(calls.published, []);
});

test('hub file parsing and the keys that move the highlight', () => {
  assert.deepEqual(parseHub('{"open":false}'), {open: false, fp: '', hubId: null, selected: null, texts: []});
  assert.equal(parseHub('nonsense'), null);
  assert.equal(parseHub('{"open":true,"fp":"bad fp","texts":["a"]}'), null);
  assert.equal(parseHub('{"open":true,"fp":"1:2:abc","texts":[]}'), null);
  const hub = parseHub(JSON.stringify({open: true, fp: '7:3:0000beef', hubId: 7, selected: 1, texts: ['a', 'b', 7]}));
  assert.deepEqual(hub, {open: true, fp: '7:3:0000beef', hubId: 7, selected: 1, texts: ['a', 'b', '']});
  assert.equal(parseHub(JSON.stringify({open: true, fp: 'x', selected: 9, texts: ['a']})).selected, null);
  assert.deepEqual(scrollKeys(0, 2, 3), ['down', 'down']);
  assert.deepEqual(scrollKeys(3, 1, 4), ['up', 'up']);
  assert.deepEqual(scrollKeys(1, 1, 4), []);
  assert.equal(scrollKeys(null, 1, 4), null);
  assert.equal(scrollKeys(0, 4, 4), null);
});

test('the key presser: starts, answers a request, and ends on quit', async () => {
  const written = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough();
  child.stdin.on('data', chunk => { for (const line of String(chunk).split('\n').filter(Boolean)) written.push(JSON.parse(line)); });
  child.kill = () => {};
  let args = null;
  const sender = new KeySender({python: 'py.exe', script: 'choice-keys.py', spawnFn: (...call) => { args = call; setImmediate(() => child.stdout.write('{"ready":true}\n')); return child; }});
  sender.start();
  const pending = sender.send(['down', 'apply']);
  await waitFor(() => written.length > 0, 'the request');
  assert.equal(args[0], 'py.exe');
  assert.deepEqual(args[1].slice(0, 2), ['-I', '-B']);
  assert.deepEqual(written[0].keys, ['down', 'apply']);
  child.stdout.write(JSON.stringify({id: written[0].id, ok: true, sent: 2}) + '\n');
  assert.deepEqual(await pending, {id: written[0].id, ok: true, sent: 2});
  sender.quit();
  await waitFor(() => written.some(item => item.quit), 'the quit');
  const after = await sender.send(['apply']);
  assert.equal(after.ok, false);
});

test('a key presser that cannot start is reported, not waited for', async () => {
  const sender = new KeySender({python: 'missing', script: 'x.py', spawnFn: () => { const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); setImmediate(() => child.emit('error', Object.assign(Error('spawn'), {code: 'ENOENT'}))); return child; }});
  const answer = await sender.send(['apply']);
  assert.equal(answer.ok, false);
});
