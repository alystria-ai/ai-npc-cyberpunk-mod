import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConvaiContinuousSpeech} from './convai-continuous-speech.mjs';
import {DIALOGUE_MAKEUP_DB as MAKEUP, updateDialogueLevel, updateVoiceVolume} from './dialogue-level.mjs';

const QUIET = {allow: false, paused: true, volume: 0, pan: 0};
const owner = {requestId: 'reply-1', entity: 'judy-copy-2', generation: 7};
const poses = duration => Array.from({length: Math.round(duration * 30) + 1}, (_, i) => {
  const values = Array(61).fill(0); values[17] = .4;
  return {at: i / 30, values};
});
function fixture(input = owner, extra = {}) {
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
    onStarted: async value => f.started.push(value), onGenerated: async value => f.generated.push(value), ...extra});
  f.snapshot = changes => ({version: 1, token: 'continuous-1', sampleRate: 24000, channels: 1,
    receivedFrames: 12000, positionSeconds: 0, text: 'Hey V.', textComplete: false,
    sourceComplete: false, ended: false, underruns: 0, state: 'buffering', ...changes});
  f.control = changes => {
    f.raw = JSON.stringify({version: 1, id: 'continuous-1', ...owner, sequence: 1,
      updated: f.now, allow: true, paused: false, volume: .8, pan: .2, ...changes});
  };
  return f;
}

test('the companion renderer control carries the Voice volume on top of the dialogue level, live between polls', async () => {
  try {
    const f = fixture(); f.control({distance: 6});
    assert.equal((await f.stream.frame(f.snapshot({receivedFrames: 1920}))).makeupDb, MAKEUP, '100% is the dialogue level alone');
    updateVoiceVolume({voiceVolume: 200});
    const doubled = await f.stream.frame(f.snapshot({receivedFrames: 1920 * 2}));
    assert.ok(Math.abs(doubled.makeupDb - (MAKEUP + 6.0206)) < 1e-3, `${doubled.makeupDb}`);
    updateVoiceVolume({voiceVolume: 50});
    assert.ok(Math.abs((await f.stream.frame(f.snapshot({receivedFrames: 1920 * 3}))).makeupDb - (MAKEUP - 6.0206)) < 1e-3);
    // Level matching off keeps the distance low-pass open, whatever the volume does to the gain.
    updateDialogueLevel('{"enabled": false}');
    const off = await f.stream.frame(f.snapshot({receivedFrames: 1920 * 4}));
    assert.equal(off.distance, null); assert.ok(Math.abs(off.makeupDb + 6.0206) < 1e-3);
  } finally { updateVoiceVolume({}); updateDialogueLevel(''); }
});

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
  assert.deepEqual(await f.stream.frame(f.snapshot({receivedFrames: 1920})), {allow: true, paused: false, volume: .8, pan: .2, makeupDb: MAKEUP});
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
  assert.deepEqual(await f.stream.frame(f.snapshot()), {allow: true, paused: true, volume: .1, pan: -1, makeupDb: MAKEUP});
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

const sharing = () => Object.assign(Error('file in use'), {code: 'EPERM'});

test('a sharing violation skips one publication instead of failing the utterance, then publishes on the next poll', async () => {
  const f = fixture(); f.control();
  let failState = 1, failReply = 1;
  f.onState = () => { if (failState-- > 0) throw sharing(); };
  assert.deepEqual(await f.stream.frame(f.snapshot()), QUIET, 'no admission until the state is published');
  f.onReply = () => { if (failReply-- > 0) throw sharing(); };
  assert.deepEqual(await f.stream.frame(f.snapshot()), QUIET, 'a busy reply file retries on the next poll');
  assert.equal(f.published.length, 0);
  assert.equal((await f.stream.frame(f.snapshot())).allow, true);
  assert.equal(f.published.length, 1);
  // After admission a skipped state keeps the current lease rather than stopping speech.
  failState = 1; f.control({sequence: 2});
  assert.deepEqual(await f.stream.frame(f.snapshot({positionSeconds: .1, state: 'playing'})),
    {allow: true, paused: false, volume: .8, pan: .2, makeupDb: MAKEUP});
});

test('the final drained state is retried, and persistent or other write errors still fail', async () => {
  const f = fixture(); f.control();
  await f.stream.frame(f.snapshot({receivedFrames: 4800, sourceComplete: true, textComplete: true}));
  let failState = 3; f.onState = () => { if (failState-- > 0) throw sharing(); };
  const ended = f.snapshot({receivedFrames: 4800, sourceComplete: true, textComplete: true, positionSeconds: .2, ended: true});
  assert.deepEqual(await f.stream.frame(ended), QUIET);
  assert.equal(f.states.at(-1).ended, true); assert.equal(f.stream.ended, true);
  const g = fixture(); g.control(); g.onState = () => { throw Object.assign(Error('disk full'), {code: 'ENOSPC'}); };
  await assert.rejects(g.stream.frame(g.snapshot()), /disk full/);
  const h = fixture(); h.control(); h.onState = () => { throw sharing(); };
  for (let poll = 0; poll < 20; poll++) assert.deepEqual(await h.stream.frame(h.snapshot()), QUIET);
  await assert.rejects(h.stream.frame(h.snapshot()), /file in use/);
});

function heldFixture(input = owner) {
  const f = fixture(input), texts = [];
  f.held = true; f.heldFrames = [];
  const base = f.stream;
  f.stream = new ConvaiContinuousSpeech({input, profile: {key: 'judy-alvarez'}, token: 'continuous-1',
    signal: f.abort.signal, now: () => f.now, current: async () => f.current,
    readControl: async () => { f.events.push('control'); return f.raw; },
    writeState: async value => { f.events.push('state'); f.states.push(structuredClone(value)); return true; },
    writeReply: async value => { f.events.push('reply'); f.replies.push(structuredClone(value)); return true; },
    onPublished: async value => { f.events.push('published'); f.published.push(value); },
    onStarted: async value => f.started.push(value), onGenerated: async value => { f.events.push('generated'); f.generated.push(value); },
    hold: () => f.held, onHeld: (seconds, complete) => f.heldFrames.push([seconds, complete]),
    onText: (text, userText) => { f.events.push('text'); texts.push([text, userText]); }});
  f.texts = texts; void base;
  return f;
}

test('a held look-ahead buffers silently: no state, reply, receipt or text announcement reaches the game', async () => {
  const f = heldFixture();
  const snapshot = f.snapshot({receivedFrames: 48000, textComplete: true, sourceComplete: true});
  assert.deepEqual(await f.stream.frame(snapshot), QUIET);
  assert.deepEqual(await f.stream.frame({...snapshot, positionSeconds: 0}), QUIET);
  assert.equal(f.states.length, 0); assert.equal(f.replies.length, 0); assert.equal(f.published.length, 0);
  assert.equal(f.generated.length, 0); assert.equal(f.texts.length, 0); assert.equal(f.events.includes('control'), false);
  assert.deepEqual(f.heldFrames[0], [2, true]);
  assert.equal(f.stream.options.pollMs(), 120);
});

test('a held look-ahead still enforces cancellation and rejects a corrupt renderer snapshot', async () => {
  const f = heldFixture();
  f.current = false;
  await assert.rejects(f.stream.frame(f.snapshot()), /owner changed/);
  const g = heldFixture();
  await assert.rejects(g.stream.frame(g.snapshot({sampleRate: 100})), /Invalid continuous speech state/);
  const h = heldFixture(); h.abort.abort();
  await assert.rejects(h.stream.frame(h.snapshot()), /owner changed/);
});

test('releasing the hold publishes the buffered turn at once: text first, then one state, one admission, then generation', async () => {
  const f = heldFixture();
  const snapshot = f.snapshot({receivedFrames: 96000, textComplete: true, sourceComplete: true});
  await f.stream.frame(snapshot);
  f.held = false; f.control();
  await f.stream.frame(snapshot);
  assert.deepEqual(f.events.filter(name => name !== 'control'), ['text', 'state', 'reply', 'published', 'generated']);
  assert.equal(f.replies.length, 1); assert.equal(f.replies[0].text, 'Hey V.');
  assert.equal(f.states[0].bufferedDuration, 4); assert.equal(f.states[0].textComplete, true);
  assert.equal(f.stream.options.pollMs(), undefined);
  await f.stream.frame({...snapshot, positionSeconds: .1});
  assert.equal(f.replies.length, 1); assert.equal(f.texts.length, 1);
});

test('the complete text is announced once, only after publication rules allow it, with the microphone transcript', async () => {
  const f = heldFixture({...owner, source: 'microphone', group: {index: 1}}); f.held = false;
  await f.stream.frame(f.snapshot({textComplete: true}));
  assert.equal(f.texts.length, 0, 'no transcript, no admission and no announcement');
  f.control();
  await f.stream.frame(f.snapshot({textComplete: false, userText: 'Say hi', receivedFrames: 24000}));
  assert.equal(f.texts.length, 0, 'incomplete text is not announced');
  await f.stream.frame(f.snapshot({textComplete: true, userText: 'Say hi', receivedFrames: 36000}));
  await f.stream.frame(f.snapshot({textComplete: true, userText: 'Say hi', receivedFrames: 48000}));
  assert.deepEqual(f.texts, [['Hey V.', 'Say hi']]);
});

test('when the game advertises it, the facial timeline goes to its own file only when it changes', async () => {
  const faces = [];
  let failNext = false;
  const f = fixture(owner, {faceFile: async () => true, writeFace: async value => {
    if (failNext) { failNext = false; throw sharing(); }
    faces.push(structuredClone(value)); return true;
  }});
  f.control();
  const snapshot = f.snapshot({faces: poses(.5), facesFormat: 'arkit61', facesTimebase: 'audio-seconds'});
  await f.stream.frame(snapshot);
  assert.equal(faces.length, 1);
  assert.deepEqual({...faces[0], face: undefined}, {version: 1, id: 'continuous-1', ...owner, revision: 1, face: undefined});
  assert.ok(faces[0].face.frames.length > 2);
  assert.equal(f.states.at(-1).face, undefined);
  // The first publication does not wait for the face file: its state has no revision yet, the next poll's state does.
  assert.equal(f.states.at(-1).faceRevision, undefined);
  // Unchanged audio and face: the state is republished, the large face is not.
  await f.stream.frame({...snapshot, positionSeconds: .1});
  assert.equal(f.states.at(-1).faceRevision, 1);
  assert.equal(faces.length, 1); assert.equal(f.states.at(-1).faceRevision, 1);
  // A grown source changes the face; a sharing error keeps the old revision until the next poll.
  failNext = true;
  const grown = f.snapshot({faces: poses(1), facesFormat: 'arkit61', facesTimebase: 'audio-seconds', receivedFrames: 24000, positionSeconds: .15});
  await f.stream.frame(grown);
  assert.equal(faces.length, 1); assert.equal(f.states.at(-1).faceRevision, 1);
  await f.stream.frame({...grown, positionSeconds: .2});
  assert.equal(faces.length, 2); assert.equal(faces[1].revision, 2); assert.equal(f.states.at(-1).faceRevision, 2);
  assert.ok(faces[1].face.duration > faces[0].face.duration);
});

test('an older game adapter keeps the facial timeline inline in every state', async () => {
  let writes = 0;
  const f = fixture(owner, {faceFile: async () => false, writeFace: async () => { writes++; return true; }});
  f.control();
  await f.stream.frame(f.snapshot({faces: poses(.5), facesFormat: 'arkit61', facesTimebase: 'audio-seconds'}));
  assert.equal(writes, 0); assert.ok(f.states.at(-1).face); assert.equal(f.states.at(-1).faceRevision, undefined);
});

test('a game that reads segmented face files is handed that layout, and a plain-file game is not', async () => {
  for (const mode of ['segments', true]) {
    const seen = [];
    const f = fixture(owner, {faceFile: async () => mode, writeFace: async (value, options) => { seen.push(options); return true; }});
    f.control();
    await f.stream.frame(f.snapshot({faces: poses(.5), facesFormat: 'arkit61', facesTimebase: 'audio-seconds'}));
    assert.deepEqual(seen, [{segments: mode === 'segments'}]);
    await f.stream.frame(f.snapshot({faces: poses(.5), facesFormat: 'arkit61', facesTimebase: 'audio-seconds', positionSeconds: .1}));
    assert.equal(f.states.at(-1).faceRevision, 1);
  }
});

test('the first publication writes the state and the reply before the face file, and the face is on disk before the frame returns', async () => {
  const order = [];
  const f = fixture(owner, {faceFile: async () => true, writeFace: async () => { order.push('face'); await new Promise(done => setTimeout(done, 15)); return true; }});
  f.onState = async () => { order.push('state'); };
  f.onReply = async () => { order.push('reply'); };
  f.control();
  await f.stream.frame(f.snapshot({faces: poses(.5), facesFormat: 'arkit61', facesTimebase: 'audio-seconds'}));
  assert.deepEqual(order, ['state', 'reply', 'face']);
  assert.equal(f.published.length, 1, 'published is reported before the face write');
  assert.ok(f.events.indexOf('published') < f.events.length, 'the face is written after onPublished');
  await f.stream.frame(f.snapshot({faces: poses(.5), facesFormat: 'arkit61', facesTimebase: 'audio-seconds', positionSeconds: .1}));
  assert.equal(order.filter(name => name === 'face').length, 1, 'an unchanged face is not written again');
  assert.equal(f.states.at(-1).faceRevision, 1);
});

test('the playback wake: held turns wake on release, admitted turns wake on the first lease only, and not after it', async () => {
  let leases = 0;
  const f = fixture(owner, {leaseWake: () => { leases++; return Promise.resolve('lease'); }});
  assert.equal(await f.stream.options.wake(), 'lease', 'admitted, no lease read yet: the lease file wakes the poll');
  f.control();
  await f.stream.frame(f.snapshot());
  assert.equal(f.stream.options.wake(), undefined, 'a lease was read: the 40 ms poll alone carries the stream');
  assert.equal(leases, 1);
  const held = heldFixture(owner);
  const heldWake = held.stream.options.wake();
  let released = false; heldWake.then(() => { released = true; });
  await new Promise(done => setTimeout(done, 5));
  assert.equal(released, false, 'a held look-ahead waits for its release');
  held.stream.wakeUp(); await heldWake;
  assert.equal(released, true, 'a held look-ahead still wakes on its release');
  assert.equal(fixture(owner).stream.options.wake(), undefined, 'no lease latch: nothing to wake on');
});

test('the host polls never call hold(): only a frame with audio may decide (a V line still being synthesized survives)', async () => {
  let holdCalls = 0, peek = false;
  const stream = new ConvaiContinuousSpeech({input: owner, profile: {key: 'judy-alvarez'}, token: 'continuous-1',
    current: async () => true, readControl: async () => '{}', writeState: async () => true, writeReply: async () => true,
    hold: () => { holdCalls++; return false; }, holdPeek: () => peek});
  assert.equal(stream.options.pollMs(), undefined); void stream.options.wake();
  assert.equal(holdCalls, 0);
  peek = true;
  assert.equal(stream.options.pollMs(), 120);
  const wake = stream.options.wake();
  assert.ok(wake instanceof Promise, 'held: the poll waits for the hold to change');
  stream.wakeUp(); await wake;
  assert.equal(holdCalls, 0);
});

// ---- A cloud voice that broke buffers a longer lead for its next lines (live 2026-10-16: Delamain's voice broke) ----------------------

import {SpeechPace} from './speech-pace.mjs';

test('SpeechPace: no extra wait until a recent line broke, then a lead, then none again after whole lines', () => {
  const pace = new SpeechPace({keep: 3, lead: 1.2, maxWaitMs: 1500});
  assert.equal(pace.lead, 0); assert.equal(pace.holds(0.1, 0), false);
  pace.note(0); assert.equal(pace.lead, 0);
  pace.note(2); assert.equal(pace.lead, 1.2);
  assert.equal(pace.holds(0.5, 100), true, 'under the lead');
  assert.equal(pace.holds(1.3, 100), false, 'enough audio');
  assert.equal(pace.holds(0.5, 1600), false, 'never waits past maxWaitMs');
  assert.equal(pace.holds(0.5, 100, {complete: true}), false, 'the whole line is here');
  pace.note(0); pace.note(0); assert.equal(pace.lead, 1.2, 'the break is still among the last three');
  pace.note(0); assert.equal(pace.lead, 0, 'three whole lines in a row');
  pace.note(-1); pace.note(1.5); pace.note('x'); assert.equal(pace.lead, 0, 'bad values are ignored');
});

test('a line after a broken one stays silent (nothing published) until the lead is buffered, then goes as usual', async () => {
  const pace = new SpeechPace({keep: 3, lead: 1.2, maxWaitMs: 1500});
  pace.note(1);
  const f = fixture(owner, {pace});
  f.control();
  assert.deepEqual(await f.stream.frame(f.snapshot({receivedFrames: 4800})), QUIET, '0.2 s of audio: held');
  assert.equal(f.replies.length, 0); assert.equal(f.states.length, 0);
  f.now += 400;
  assert.deepEqual(await f.stream.frame(f.snapshot({receivedFrames: 14400})), QUIET, '0.6 s: still held');
  assert.equal(f.replies.length, 0);
  f.now += 400;
  await f.stream.frame(f.snapshot({receivedFrames: 31200}));
  assert.equal(f.replies.length, 1, '1.3 s buffered: published');
});

test('the held line goes after maxWaitMs even if the audio is slow, and a normal voice is never held', async () => {
  const pace = new SpeechPace({keep: 3, lead: 1.2, maxWaitMs: 1500});
  pace.note(3);
  const f = fixture(owner, {pace});
  f.control();
  await f.stream.frame(f.snapshot({receivedFrames: 2400}));
  assert.equal(f.replies.length, 0);
  f.now += 1600;
  await f.stream.frame(f.snapshot({receivedFrames: 4800}));
  assert.equal(f.replies.length, 1, 'waited long enough');
  const calm = fixture(owner, {pace: new SpeechPace()});
  calm.control();
  await calm.stream.frame(calm.snapshot({receivedFrames: 2400}));
  assert.equal(calm.replies.length, 1, 'no break in its history: published at once, as before');
});

test('the end of a line reports its underruns and teaches the pace', async () => {
  const pace = new SpeechPace(), ended = [];
  const f = fixture(owner, {pace, onEnded: info => ended.push(info)});
  f.control();
  const whole = f.snapshot({receivedFrames: 24000, sourceComplete: true, textComplete: true});
  await f.stream.frame(whole);
  f.now += 500; await f.stream.frame({...whole, positionSeconds: .2});
  f.now += 900; await f.stream.frame({...whole, positionSeconds: 1, ended: true, underruns: 2});
  assert.equal(ended.length, 1);
  assert.equal(ended[0].underruns, 2); assert.equal(ended[0].seconds, 1);
  assert.equal(pace.lead, 1.2, 'the next lines buffer first');
});

test('onLease reports the first valid game lease once (the turn record), and a throwing report never stops playback', async () => {
  let leases = 0;
  const f = fixture(owner, {onLease: () => { leases++; throw Error('report failed'); }});
  assert.deepEqual(await f.stream.frame(f.snapshot()), QUIET, 'published, no lease yet');
  assert.equal(leases, 0);
  f.control();
  const first = await f.stream.frame(f.snapshot({receivedFrames: 24000}));
  assert.equal(first.allow, true);
  assert.equal(leases, 1);
  f.control({sequence: 2});
  await f.stream.frame(f.snapshot({receivedFrames: 36000, positionSeconds: .1}));
  assert.equal(leases, 1, 'a refreshed lease is not reported again');
});
