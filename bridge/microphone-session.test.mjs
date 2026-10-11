import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {MicrophoneSession} from './microphone-session.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
function fixture(hooks = {}) {
  const opening = deferred(), response = deferred(), states = [], replies = [], replyInputs = [], errors = [];
  const begins = [], finishConfigs = [], finishOptions = [];
  let stops = 0, finishes = 0;
  const session = new MicrophoneSession({hostFactory: () => ({
    beginVoice: config => { begins.push(config); return opening.promise; },
    finishVoice: (config, options) => { finishes++; finishConfigs.push(config); finishOptions.push(options); return response.promise; },
    close: async () => { stops++; },
  }), onState: async (state, input) => { states.push(state); await hooks.onState?.(state, input); },
  onReply: async (input, result) => { replies.push([input.requestId, result]); replyInputs.push(input); },
  onError: async (input, error) => { states.push('error'); errors.push({input, error}); }, prepareReply: hooks.prepareReply,
  minRecordMs: hooks.minRecordMs ?? 0});
  return {session, opening, response, states, replies, replyInputs, errors, begins, finishConfigs, finishOptions, counts: () => ({stops, finishes})};
}

const recording = changes => ({requestId: '123-5-42ULL', entity: '42ULL', generation: 5,
  profileKey: 'judy', text: '(microphone)', ...changes});
const configuration = changes => ({characterId: 'character-judy', endUserId: 'opaque-user-one',
  scope: 'private', sessionId: 'session-one', context: 'old objective', ...changes});

test('microphone renderer is prepared for the refreshed exact owner before finishing input', async () => {
  const options = {liveSpeech: {token: 'owned-live-speech', onFrame: async () => {}}};
  let prepared;
  const f = fixture({prepareReply: async (input, signal) => { prepared = {input, signal}; return options; }});
  const input = recording(), start = f.session.start(input, configuration());
  await setImmediate(); f.opening.resolve(); await start;
  const refreshed = {...input, worldKnowledge: {capturedAt: 'now'}};
  const finish = f.session.finish(input.requestId, {input: refreshed, config: configuration()});
  await setImmediate();
  assert.equal(prepared.input, refreshed); assert.equal(prepared.signal.aborted, false);
  assert.equal(f.finishOptions[0], options); assert.equal(f.counts().finishes, 1);
  f.response.resolve({text: 'Done.', continuous: true}); await finish;
  assert.equal(f.replies.length, 1);
});

test('cancel during renderer preparation cannot finish or submit the retired microphone', async () => {
  const preparation = deferred();
  const f = fixture({prepareReply: () => preparation.promise});
  const input = recording(), start = f.session.start(input, configuration());
  await setImmediate(); f.opening.resolve(); await start;
  const finish = f.session.finish(input.requestId); await setImmediate();
  await f.session.cancel(); preparation.resolve({liveSpeech: {token: 'retired'}}); await finish;
  assert.equal(f.counts().finishes, 0); assert.equal(f.replies.length, 0);
});
test('second press while microphone opens finishes it once ready', async () => {
  const f = fixture(); const start = f.session.start({requestId: 'one'}, {});
  await setImmediate(); await f.session.finish('one');
  assert.equal(f.counts().finishes, 0);
  f.opening.resolve(); await setImmediate();
  assert.equal(f.counts().finishes, 1);
  f.response.resolve({text: 'hello'}); await start;
  assert.equal(f.replies.length, 1); assert.ok(f.counts().stops);
});
test('cancel during device opening closes the late device and emits no reply', async () => {
  const f = fixture(); const start = f.session.start({requestId: 'one'}, {});
  await setImmediate(); await f.session.cancel(); f.opening.resolve(); await start;
  assert.equal(f.session.current, null); assert.equal(f.counts().finishes, 0);
  assert.equal(f.replies.length, 0); assert.ok(f.counts().stops);
});
test('game loss discards a late response and stops the owned host', async () => {
  const f = fixture(); const start = f.session.start({requestId: 'one'}, {});
  await setImmediate(); f.opening.resolve(); await start;
  const finish = f.session.finish('one'); await setImmediate();
  await f.session.tick(false); f.response.resolve({text: 'stale'}); await finish;
  assert.equal(f.replies.length, 0); assert.equal(f.session.current, null);
});

test('finish refresh uses current world context on the same recording and retains it for reply publication', async () => {
  const f = fixture(), input = recording(), config = configuration();
  const start = f.session.start(input, config);
  await setImmediate(); f.opening.resolve(); await start;
  const updated = {...input, journal: {status: 'known', quest: {title: 'Current quest'}},
    worldKnowledge: {capturedAt: 'fresh capture'}, journalHistory: {generation: 12}};
  const refreshedConfig = {...config, context: 'current verified objective'};
  const finish = f.session.finish(input.requestId, {input: updated, config: refreshedConfig});
  await setImmediate();
  assert.equal(f.begins.length, 1);
  assert.deepEqual(f.finishConfigs, [refreshedConfig]);
  f.response.resolve({text: 'Current objective reply'}); await finish;
  assert.equal(f.replyInputs[0], updated);
  assert.equal(f.errors.length, 0);
  assert.equal(f.session.current, null);
});

test('finish received during device opening keeps its refreshed context until the device is ready', async () => {
  const f = fixture(), input = recording(), config = configuration();
  const start = f.session.start(input, config);
  await setImmediate();
  const updated = {...input, worldKnowledge: {capturedAt: 'at finish'}};
  const refreshedConfig = {...config, context: 'fresh before open completed'};
  await f.session.finish(input.requestId, {input: updated, config: refreshedConfig});
  refreshedConfig.context = 'caller changed its object afterward';
  assert.equal(f.counts().finishes, 0);
  f.opening.resolve(); await setImmediate();
  assert.equal(f.finishConfigs[0].context, 'fresh before open completed');
  assert.equal(f.counts().finishes, 1);
  f.response.resolve({text: 'hello'}); await start;
  assert.equal(f.replyInputs[0], updated);
});

test('a refreshed finish cannot redirect an utterance to another request, entity, generation, profile, or audience', async t => {
  for (const changed of [{requestId: 'other'}, {entity: '43ULL'}, {generation: 6}, {profileKey: 'panam'},
    {channel: 'phone'}, {group: {id: 'party', index: 1, total: 2, audience: ['judy', 'panam']}}]) {
    await t.test(Object.keys(changed)[0], async () => {
      const f = fixture(), input = recording(), config = configuration();
      const start = f.session.start(input, config);
      await setImmediate(); f.opening.resolve(); await start;
      await f.session.finish(input.requestId, {input: {...input, ...changed}, config});
      assert.equal(f.counts().finishes, 0);
      assert.equal(f.replies.length, 0);
      assert.equal(f.session.current, null);
      assert.equal(f.errors.length, 1);
      assert.equal(f.errors[0].input, input);
      assert.match(f.errors[0].error.message, /no longer matches/);
    });
  }
});

test('user or scope changes cancel a still-opening recording before it can submit audio', async t => {
  for (const changed of [{endUserId: 'opaque-user-two'}, {scope: 'another-save'}, {freshSession: true}]) {
    await t.test(Object.keys(changed)[0], async () => {
      const f = fixture(), input = recording(), config = configuration();
      const start = f.session.start(input, config);
      await setImmediate();
      await f.session.finish(input.requestId, {input, config: {...config, ...changed}});
      f.opening.resolve(); await start;
      assert.equal(f.counts().finishes, 0);
      assert.equal(f.errors.length, 1);
      assert.equal(f.replies.length, 0);
      assert.equal(f.session.current, null);
      assert.ok(f.counts().stops);
    });
  }
});

test('partial refresh is rejected and a stale request does not cancel the current recording', async () => {
  const f = fixture(), input = recording(), config = configuration();
  const start = f.session.start(input, config);
  await setImmediate(); f.opening.resolve(); await start;
  await f.session.finish('stale-request', {input: recording({entity: '99ULL'}), config});
  assert.equal(f.session.current.input, input);
  assert.equal(f.errors.length, 0);
  await f.session.finish(input.requestId, {input});
  assert.equal(f.session.current, null);
  assert.equal(f.counts().finishes, 0);
  assert.equal(f.errors.length, 1);
});

test('caller mutation cannot change a recording identity behind its original receipt', async () => {
  const f = fixture(), input = recording(), config = configuration();
  const start = f.session.start(input, config);
  await setImmediate(); f.opening.resolve(); await start;
  input.generation++;
  await f.session.finish('123-5-42ULL');
  assert.equal(f.counts().finishes, 0);
  assert.equal(f.session.current, null);
  assert.equal(f.errors.length, 1);
});

test('cancel during the reply-state callback does not call finishVoice afterward', async () => {
  const enteringReply = deferred();
  const f = fixture({onState: state => state === 'reply' ? enteringReply.promise : undefined});
  const input = recording(), config = configuration(), start = f.session.start(input, config);
  await setImmediate(); f.opening.resolve(); await start;
  const finish = f.session.finish(input.requestId, {input: {...input}, config: {...config, context: 'new'}});
  await setImmediate(); await f.session.cancel();
  enteringReply.resolve(); await finish;
  assert.equal(f.counts().finishes, 0);
  assert.equal(f.replies.length, 0);
  assert.equal(f.session.current, null);
});

test('cancel during the starting-state callback never opens a late microphone', async () => {
  const enteringStart = deferred();
  const f = fixture({onState: state => state === 'starting' ? enteringStart.promise : undefined});
  const start = f.session.start(recording(), configuration());
  await setImmediate(); await f.session.cancel();
  enteringStart.resolve(); await start;
  assert.equal(f.begins.length, 0);
  assert.equal(f.replies.length, 0);
  assert.equal(f.session.current, null);
});

test('a finish right after the device opened waits out the minimum recording, then submits once', async () => {
  const f = fixture({minRecordMs: 120});
  const input = recording(), start = f.session.start(input, configuration());
  await setImmediate(); f.opening.resolve(); await start;
  const finish = f.session.finish(input.requestId);
  await setImmediate();
  assert.equal(f.counts().finishes, 0, 'a double tap does not submit an empty recording');
  assert.equal(f.states.includes('reply'), false);
  await new Promise(done => setTimeout(done, 200));
  assert.equal(f.counts().finishes, 1); assert.equal(f.states.at(-1), 'reply');
  f.response.resolve({text: 'ok'}); await finish;
  assert.equal(f.replies.length, 1); assert.equal(f.session.current, null); assert.equal(f.states.at(-1), 'off');
});

test('a second finish while the minimum recording is still being waited out is ignored', async () => {
  const f = fixture({minRecordMs: 100});
  const input = recording(), start = f.session.start(input, configuration());
  await setImmediate(); f.opening.resolve(); await start;
  const first = f.session.finish(input.requestId); await f.session.finish(input.requestId);
  await new Promise(done => setTimeout(done, 180));
  assert.equal(f.counts().finishes, 1);
  f.response.resolve({text: 'ok'}); await first;
  assert.equal(f.replies.length, 1);
});

test('cancel during the minimum-recording wait submits nothing and releases the device', async () => {
  const f = fixture({minRecordMs: 150});
  const input = recording(), start = f.session.start(input, configuration());
  await setImmediate(); f.opening.resolve(); await start;
  const finish = f.session.finish(input.requestId); await setImmediate();
  await f.session.cancel(); await finish;
  await new Promise(done => setTimeout(done, 220));
  assert.equal(f.counts().finishes, 0); assert.equal(f.replies.length, 0);
  assert.equal(f.session.current, null); assert.equal(f.states.at(-1), 'off'); assert.ok(f.counts().stops);
});

test('rapid start, cancel, start leaves only the last recording and no stuck session', async () => {
  const hosts = [], states = [];
  const session = new MicrophoneSession({minRecordMs: 0,
    hostFactory: () => { const host = {closed: 0, opening: deferred(),
      beginVoice() { return host.opening.promise; }, finishVoice: async () => ({text: 'heard'}), close: async () => { host.closed++; }};
      hosts.push(host); return host; },
    onState: async (state, input) => { states.push([input.requestId, state]); }, onReply: async () => {}, onError: async () => {}});
  const first = session.start(recording({requestId: 'a'}), configuration());
  await session.cancel();
  const second = session.start(recording({requestId: 'b'}), configuration());
  await session.cancel();
  const third = session.start(recording({requestId: 'c'}), configuration());
  await setImmediate();
  for (const host of hosts) host.opening.resolve();
  await Promise.all([first, second, third]);
  assert.equal(session.current?.requestId, 'c');
  assert.deepEqual(states.filter(([id, state]) => state === 'recording'), [['c', 'recording']]);
  for (const host of hosts.slice(0, -1)) assert.ok(host.closed >= 1, 'every superseded device was released');
  await session.finish('c');
  assert.equal(session.current, null); assert.equal(states.at(-1)[1], 'off');
  const fourth = session.start(recording({requestId: 'd'}), configuration()); await setImmediate();
  hosts.at(-1).opening.resolve(); await fourth;
  assert.equal(session.current?.requestId, 'd'); assert.equal(states.at(-1)[1], 'recording');
});

test('heard words are read from the open recording only, and never from a cancelled or replaced one', async () => {
  const words = {text: ''};
  const hosts = [];
  const session = new MicrophoneSession({minRecordMs: 0,
    hostFactory: () => { const host = {opening: deferred(), beginVoice() { return host.opening.promise; },
      finishVoice: async () => ({text: 'ok'}), heard: async () => words.text, close: async () => {}}; hosts.push(host); return host; },
    onState: async () => {}, onReply: async () => {}, onError: async () => {}});
  assert.equal(await session.heard(), '', 'nothing recording');
  const start = session.start(recording({requestId: 'a'}), configuration());
  await setImmediate(); words.text = 'too early';
  assert.equal(await session.heard(), '', 'the device is still opening');
  hosts[0].opening.resolve(); await start;
  assert.equal(await session.heard(), 'too early');
  words.text = 'and more'; assert.equal(await session.heard(), 'and more');
  await session.cancel();
  assert.equal(await session.heard(), '');
  const failing = new MicrophoneSession({minRecordMs: 0, hostFactory: () => ({beginVoice: async () => ({}),
    heard: async () => { throw Error('page closed'); }, close: async () => {}}), onState: async () => {}, onReply: async () => {}, onError: async () => {}});
  await failing.start(recording({requestId: 'b'}), configuration());
  assert.equal(await failing.heard(), '', 'a failing page read never throws into the poll');
});
