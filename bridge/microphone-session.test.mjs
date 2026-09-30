import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {MicrophoneSession} from './microphone-session.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
function fixture(hooks = {}) {
  const opening = deferred(), response = deferred(), states = [], replies = [], replyInputs = [], errors = [];
  const begins = [], finishConfigs = [];
  let stops = 0, finishes = 0;
  const session = new MicrophoneSession({hostFactory: () => ({
    beginVoice: config => { begins.push(config); return opening.promise; },
    finishVoice: config => { finishes++; finishConfigs.push(config); return response.promise; },
    close: async () => { stops++; },
  }), onState: async (state, input) => { states.push(state); await hooks.onState?.(state, input); },
  onReply: async (input, result) => { replies.push([input.requestId, result]); replyInputs.push(input); },
  onError: async (input, error) => { states.push('error'); errors.push({input, error}); }});
  return {session, opening, response, states, replies, replyInputs, errors, begins, finishConfigs, counts: () => ({stops, finishes})};
}

const recording = changes => ({requestId: '123-5-42ULL', entity: '42ULL', generation: 5,
  profileKey: 'judy', text: '(microphone)', ...changes});
const configuration = changes => ({characterId: 'character-judy', endUserId: 'opaque-user-one',
  scope: 'private', sessionId: 'session-one', context: 'old objective', ...changes});
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
    {channel: 'phone'}, {followUpQuestions: true}, {group: {id: 'party', index: 1, total: 2, audience: ['judy', 'panam']}}]) {
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
