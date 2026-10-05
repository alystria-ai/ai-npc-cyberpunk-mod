import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConvaiContinuousSpeech} from './convai-continuous-speech.mjs';

const QUIET = {allow: false, paused: true, volume: 0, pan: 0};
const owner = {requestId: 'reply-1', entity: 'judy-copy-2', generation: 7};
const poses = duration => Array.from({length: Math.round(duration * 30) + 1}, (_, i) => {
  const values = Array(61).fill(0); values[17] = .4;
  return {at: i / 30, values};
});
function fixture(input = owner) {
  const f = {now: 10000, current: true, raw: '{}', events: [], states: [], replies: [],
    published: [], started: [], generated: [], abort: new AbortController()};
  f.stream = new ConvaiContinuousSpeech({input, profile: {key: 'judy-alvarez'}, token: 'continuous-1',
    signal: f.abort.signal, now: () => f.now, current: async () => f.current,
    readControl: async () => { f.events.push('control'); await f.onRead?.(); return f.raw; },
    writeState: async value => { f.events.push('state'); f.states.push(structuredClone(value));
      await f.onState?.(); return f.stateOk !== false; },
    writeReply: async value => { f.events.push('reply'); f.replies.push(structuredClone(value));
      await f.onReply?.(); return f.replyOk !== false; },
    onPublished: async value => { f.events.push('published'); f.published.push(value); await f.onPublished?.(); },
    onStarted: async value => f.started.push(value), onGenerated: async value => f.generated.push(value)});
  f.snapshot = changes => ({version: 1, token: 'continuous-1', sampleRate: 24000, channels: 1,
    receivedFrames: 12000, positionSeconds: 0, text: 'Hey V.', textComplete: false,
    sourceComplete: false, ended: false, underruns: 0, state: 'buffering', ...changes});
  f.control = changes => {
    f.raw = JSON.stringify({version: 1, id: 'continuous-1', ...owner, sequence: 1,
      updated: f.now, allow: true, paused: false, volume: .8, pan: .2, ...changes});
  };
  return f;
}

test('F9 waits for its recognized prompt then includes it in the single admission descriptor', async () => {
  const f = fixture({...owner, source: 'microphone', group: {index: 1}});
  assert.deepEqual(await f.stream.frame(f.snapshot()), QUIET);
  assert.equal(f.replies.length, 0);
  f.control();
  await f.stream.frame(f.snapshot({userText: 'What do you both think?'}));
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].userText, 'What do you both think?');
  await f.stream.frame(f.snapshot({userText: 'What do you both think?', positionSeconds: .1}));
  assert.equal(f.replies.length, 1);
});

test('late expression metadata publishes against the same game owner without rebuilding speech weights',async()=>{
  const f=fixture();f.control();
  const snapshot=f.snapshot({faces:poses(.5),facesFormat:'arkit61',facesTimebase:'audio-seconds',
    sourceComplete:true,textComplete:true});
  await f.stream.frame(snapshot);const face=structuredClone(f.states.at(-1).face);
  await f.stream.frame({...snapshot,positionSeconds:.1,
    expressionSignal:{version:1,correlated:true,sequence:0,emotion:'Grief',scale:3}});
  const state=f.states.at(-1);
  assert.deepEqual(state.face,face);
  assert.deepEqual(state.expression,{version:1,...owner,sequence:0,emotion:'Grief',scale:3});
  await f.stream.frame({...snapshot,positionSeconds:.2,expressionSignal:{emotion:'Joy',scale:3}});
  assert.equal(f.states.at(-1).expression,undefined);
  assert.equal(f.replies.length,1);assert.equal(f.states.at(-1).position,.2);
});

test('a completed F9 reply without a transcript cannot play or invent a prompt for the group', async () => {
  const f = fixture({...owner, source: 'microphone', group: {index: 1}});
  await assert.rejects(f.stream.frame(f.snapshot({sourceComplete: true, textComplete: true})), /transcript unavailable/);
  assert.equal(f.states.length, 0); assert.equal(f.replies.length, 0);
});

test('invalid microphone text is rejected before the game admission', async () => {
  for (const userText of [123, 'a'.repeat(1201), 'bad\u0000text']) {
    const f = fixture();
    await assert.rejects(f.stream.frame(f.snapshot({userText})), /Invalid continuous speech transcript/);
    assert.equal(f.replies.length, 0);
  }
});

test('continuous admission waits for PCM and text then publishes one descriptor before permitting playback', async () => {
  const f = fixture();
  assert.deepEqual(await f.stream.options.onFrame(f.snapshot({sampleRate: 0, receivedFrames: 0})), QUIET);
  assert.deepEqual(await f.stream.frame(f.snapshot({text: '  ', receivedFrames: 960})), QUIET);
  assert.equal(f.replies.length, 0); assert.equal(f.states.length, 0);
  f.onPublished = () => f.control();
  // One validated packet (80 ms) admits the game lease; the renderer, not this
  // admission, withholds sound until its 400 ms startup prefix is buffered.
  assert.deepEqual(await f.stream.frame(f.snapshot({receivedFrames: 1920})), {allow: true, paused: false, volume: .8, pan: .2});
  assert.deepEqual(f.events, ['state', 'reply', 'published', 'control']);
  assert.deepEqual(f.replies[0].continuous, {version: 1, id: 'continuous-1'});
  assert.equal(f.replies[0].profile, 'judy-alvarez');
  await f.stream.frame(f.snapshot({positionSeconds: .1, state: 'playing'}));
  assert.equal(f.replies.length, 1); assert.equal(f.published.length, 1); assert.equal(f.started.length, 1);
  assert.equal(f.started[0].continuousPlaybackStartEstimateAt, f.now - 100);
});

test('a short complete source may be admitted but source EOF alone never declares audible completion', async () => {
  const f = fixture(); f.control();
  const source = f.snapshot({receivedFrames: 4800, sourceComplete: true, textComplete: true});
  assert.equal((await f.stream.frame(source)).allow, true);
  assert.equal(f.states.at(-1).complete, true); assert.equal(f.states.at(-1).ended, false);
  assert.deepEqual(f.generated, ['Hey V.']); assert.equal(f.stream.ended, false);
  await f.stream.frame({...source, positionSeconds: .1});
  assert.equal(f.generated.length, 1); assert.equal(f.stream.ended, false);
  assert.deepEqual(await f.stream.frame({...source, positionSeconds: .2, ended: true, state: 'ended'}), QUIET);
  assert.equal(f.stream.ended, true); assert.equal(f.states.at(-1).ended, true);
});

test('ended playback is terminal and a later old renderer snapshot cannot reopen it', async () => {
  const f = fixture(); f.control();
  await f.stream.frame(f.snapshot({sourceComplete: true, textComplete: true, positionSeconds: .5, ended: true}));
  const writes = f.states.length;
  f.control({sequence: 2});
  assert.deepEqual(await f.stream.frame(f.snapshot({sourceComplete: true, textComplete: true, positionSeconds: .5})), QUIET);
  assert.equal(f.states.length, writes); assert.equal(f.replies.length, 1);
});

for (const change of [{sourceComplete: false, textComplete: true, positionSeconds: .5},
  {sourceComplete: true, textComplete: false, positionSeconds: .5},
  {sourceComplete: true, textComplete: true, positionSeconds: .45}]) {
  test(`audible completion rejects premature end ${JSON.stringify(change)}`, async () => {
    const f = fixture(); await assert.rejects(f.stream.frame(f.snapshot({...change, ended: true})), /before audible drain/);
    assert.equal(f.replies.length, 0); assert.equal(f.states.length, 0);
  });
}

for (const mode of ['cancelled', 'owner changed']) test(`${mode} cannot admit a stream`, async () => {
  const f = fixture(); if (mode === 'cancelled') f.abort.abort(); else f.current = false;
  await assert.rejects(f.stream.frame(f.snapshot()), /owner changed/);
  assert.equal(f.events.length, 0);
});

for (const mode of ['cancelled', 'owner changed']) test(`${mode} during state commit cannot publish the admission descriptor`, async () => {
  const f = fixture(); f.onState = () => { if (mode === 'cancelled') f.abort.abort(); else f.current = false; };
  await assert.rejects(f.stream.frame(f.snapshot()), /owner changed/);
  assert.equal(f.replies.length, 0); assert.equal(f.published.length, 0);
});

test('cancellation during game-control read cannot return an allow decision', async () => {
  const f = fixture(); f.control(); f.onRead = () => f.abort.abort();
  await assert.rejects(f.stream.frame(f.snapshot()), /owner changed/);
});

test('a stalled control read evaluates lease freshness after the await', async () => {
  const f = fixture(); f.control(); await f.stream.frame(f.snapshot());
  f.control({sequence: 2}); f.onRead = () => { f.now += 2001; };
  await assert.rejects(f.stream.frame(f.snapshot()), /lease expired/);
});

test('first game acknowledgement has a five-second deadline and no control file cannot start sound', async () => {
  const f = fixture(); assert.deepEqual(await f.stream.frame(f.snapshot()), QUIET);
  f.now += 5000; assert.deepEqual(await f.stream.frame(f.snapshot()), QUIET);
  f.now++; await assert.rejects(f.stream.frame(f.snapshot()), /lease expired/);
  assert.equal(f.started.length, 0);
});

test('partial control JSON keeps a good lease only 400ms then mutes and expires at two seconds', async () => {
  const f = fixture(); f.control(); assert.equal((await f.stream.frame(f.snapshot())).allow, true);
  f.raw = '{"version":'; f.now += 400;
  assert.equal((await f.stream.frame(f.snapshot())).allow, true);
  f.now++; assert.deepEqual(await f.stream.frame(f.snapshot()), QUIET);
  f.now += 1599; assert.deepEqual(await f.stream.frame(f.snapshot()), QUIET);
  f.now++; await assert.rejects(f.stream.frame(f.snapshot()), /lease expired/);
});

test('duplicate and older control sequences cannot renew the game lease despite fresh timestamps', async () => {
  const f = fixture(); f.control({sequence: 4}); await f.stream.frame(f.snapshot());
  f.now += 401; f.control({sequence: 4}); assert.deepEqual(await f.stream.frame(f.snapshot()), QUIET);
  f.now += 1600; f.control({sequence: 3}); await assert.rejects(f.stream.frame(f.snapshot()), /lease expired/);
});

test('a fresh matching pause and distance gain update preserves the same stream', async () => {
  const f = fixture(); f.control(); await f.stream.frame(f.snapshot());
  f.now += 300; f.control({sequence: 2, paused: true, volume: .1, pan: -1});
  assert.deepEqual(await f.stream.frame(f.snapshot()), {allow: true, paused: true, volume: .1, pan: -1});
  assert.equal(f.replies.length, 1);
});

test('explicit game stop is terminal even if a later file allows the same actor again', async () => {
  const f = fixture(); f.control(); await f.stream.frame(f.snapshot());
  f.control({sequence: 2, allow: false}); await assert.rejects(f.stream.frame(f.snapshot()), /stopped/);
  f.control({sequence: 3}); await assert.rejects(f.stream.frame(f.snapshot()), /stopped|retired/);
});

test('wrong-owner, malformed, stale and future controls cannot admit an actor', async () => {
  const changes = [{id: 'other'}, {requestId: 'other'}, {entity: 'other'}, {generation: 8}, {version: 2},
    {sequence: -1}, {sequence: .5}, {sequence: Number.MAX_SAFE_INTEGER + 1}, {updated: 7999}, {updated: 11501},
    {allow: 1}, {paused: 0}, {volume: -1}, {volume: 1.01}, {pan: -1.01}, {pan: 1.01}];
  for (const change of changes) {
    const f = fixture(); f.control(change);
    assert.deepEqual(await f.stream.frame(f.snapshot()), QUIET, JSON.stringify(change));
    assert.equal(f.stream.controlSequence, -1);
  }
});

test('renderer source schema, size, format and cursor bounds reject before publication', async () => {
  const changes = [{token: 'other'}, {version: 2}, {error: 'device failed'}, {sampleRate: 7999}, {sampleRate: 96001},
    {sampleRate: 24000.5}, {channels: 0}, {channels: 3}, {receivedFrames: -1}, {receivedFrames: .5},
    {receivedFrames: 24000 * 121}, {positionSeconds: -.1}, {positionSeconds: Infinity}, {positionSeconds: .526},
    {text: null}, {text: 'x'.repeat(12001)}, {textComplete: 1}, {sourceComplete: 1}, {ended: 1},
    {underruns: -1}, {underruns: .5}, {state: 'x'.repeat(51)}];
  for (const change of changes) {
    const f = fixture(); await assert.rejects(f.stream.frame(f.snapshot(change)), undefined, JSON.stringify(change));
    assert.equal(f.replies.length, 0); assert.equal(f.states.length, 0);
  }
});

test('format and received sample count cannot change or regress after admission', async () => {
  for (const change of [{sampleRate: 48000}, {channels: 2}, {receivedFrames: 11999}]) {
    const f = fixture(); await f.stream.frame(f.snapshot());
    await assert.rejects(f.stream.frame(f.snapshot(change)), /format changed|Invalid/);
  }
  for (const change of [{receivedFrames: 12001}, {sourceComplete: false}]) {
    const f = fixture(); await f.stream.frame(f.snapshot({sourceComplete: true}));
    await assert.rejects(f.stream.frame(f.snapshot({sourceComplete: true, ...change})), /Completed/);
  }
});

test('cursor jitter is clamped without replaying start or moving face/subtitle time backwards', async () => {
  const f = fixture(); f.control(); await f.stream.frame(f.snapshot({positionSeconds: .25}));
  await f.stream.frame(f.snapshot({positionSeconds: .24}));
  assert.equal(f.states.at(-1).position, .25); assert.equal(f.started.length, 1);
  await f.stream.frame(f.snapshot({positionSeconds: .52}));
  assert.equal(f.states.at(-1).position, .5);
});

test('provider face prefixes grow on the same global clock and no WAV or phrase descriptor is created', async () => {
  const f = fixture(); f.control();
  const snapshot = f.snapshot({faces: poses(.5), facesFormat: 'arkit61', facesTimebase: 'audio-seconds'});
  await f.stream.frame(snapshot); const first = f.states.at(-1).face;
  assert.equal(first.continuous, true); assert.equal(first.complete, false);
  assert.equal(first.requestId, owner.requestId); assert.equal(first.entity, owner.entity);
  await f.stream.frame({...snapshot, receivedFrames: 19200, faces: poses(.8), positionSeconds: .2});
  const second = f.states.at(-1).face;
  assert.equal(second.duration, .8); assert.equal(second.requestId, first.requestId);
  assert.deepEqual(second.frames.filter(row => row[0] < .5), first.frames.filter(row => row[0] < .5));
  await f.stream.frame({...snapshot, receivedFrames: 19200, faces: poses(.8), positionSeconds: .3,
    sourceComplete: true, textComplete: true});
  assert(f.states.at(-1).face.frames.at(-1).slice(1).every(value => value === 0));
  for (const document of [...f.states, ...f.replies]) {
    for (const field of ['audio', 'stream', 'speechSegment', 'chunks', 'slot', 'event', 'wav']) assert.equal(document[field], undefined);
  }
});

test('failed state or descriptor persistence never admits audio', async () => {
  const state = fixture(); state.stateOk = false;
  await assert.rejects(state.stream.frame(state.snapshot()), /state could not be committed/);
  assert.equal(state.replies.length, 0);
  const reply = fixture(); reply.replyOk = false;
  await assert.rejects(reply.stream.frame(reply.snapshot()), /admission could not be committed/);
  assert.equal(reply.published.length, 0); assert.equal(reply.events.includes('control'), false);
});

test('failure reports only an admitted current stream and shutdown cannot write another owner state', async () => {
  const empty = fixture(); await empty.stream.fail(); assert.equal(empty.states.length, 0);
  const f = fixture(); await f.stream.frame(f.snapshot()); await f.stream.fail();
  assert.equal(f.states.at(-1).state, 'error'); assert.equal(f.states.at(-1).requestId, owner.requestId);
  const count = f.states.length; f.abort.abort(); await f.stream.fail(); assert.equal(f.states.length, count);
});
