import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CompanionVision, wantsLook, CAPTURE_WAIT_MS} from './companion-vision.mjs';
import {VisionCapture, normalise, helperCandidates} from './vision-capture.mjs';
import {RealtimeHost} from './realtime-host.mjs';

const PICTURE = Buffer.from('game view').toString('base64');
const TV = Buffer.from('tv frame').toString('base64');

function fakeCapture({result = {ok: true, mime: 'image/jpeg', base64: PICTURE, width: 768, height: 432, bytes: 9, ms: {total: 140}},
  delayMs = 0} = {}) {
  const capture = {calls: 0, started: 0, stopped: 0,
    start: async () => { capture.started++; return true; }, stop: () => { capture.stopped++; },
    capture: async () => { capture.calls++; if (delayMs) await new Promise(r => setTimeout(r, delayMs)); return result; }};
  return capture;
}
const on = (vision, settings = {}) => { vision.update({companionVision: true, ...settings}); return vision; };

test('look-like lines are recognised; ordinary ones are not', () => {
  for (const line of ['What do you see?', 'look at that', 'Check this out', 'how do I look', 'Do you see that guy over there?',
    'What’s that?', 'who is that', 'take a look around', 'nice view huh', 'what do you think of my outfit', 'Look at this sunset',
    'what am I wearing', 'see that car?', "what's on the tv", 'anything behind us?'])
    assert.equal(wantsLook(line), true, line);
  for (const line of ['Hello', 'How are you?', 'Where should we go next?', 'I love you', 'What is the plan for tonight?',
    'Tell me about Night City', 'Let us drive to the docks', '', null])
    assert.equal(wantsLook(line), false, String(line));
});

test('off by default: no connect change, no capture, nothing queued', async () => {
  const capture = fakeCapture(), vision = new CompanionVision({capture});
  assert.equal(vision.connectConfig(), null);
  assert.equal(vision.beginTurn({requestId: 'r1', text: 'what do you see'}), false);
  assert.equal(vision.noteHeard('r1', 'look at that'), false);
  assert.deepEqual(vision.attachToNextTurn([{mime: 'image/jpeg', base64: TV}]), {queued: 0, reason: 'off'});
  assert.equal(await vision.imagesForTurn({visionTurn: 'r1'}), null);
  assert.equal(capture.calls + capture.started, 0);
});

test('Convai only: Mistral or Local AI turns get no picture and pages connect without video', () => {
  let convai = false;
  const vision = on(new CompanionVision({capture: fakeCapture(), isConvai: () => convai}));
  assert.equal(vision.connectConfig(), null);
  assert.deepEqual(vision.attachToNextTurn([{mime: 'image/jpeg', base64: TV}]), {queued: 0, reason: 'provider'});
  convai = true;
  assert.deepEqual(vision.connectConfig(), {transport: 'video'});
  vision.update({companionVision: true, visionTransport: 'upload'});
  assert.deepEqual(vision.connectConfig(), {transport: 'upload'});
});

test('turning it on readies the helper; turning it off stops it and forgets queued pictures', () => {
  const capture = fakeCapture(), vision = new CompanionVision({capture});
  assert.equal(vision.update({companionVision: true}), true);
  assert.equal(vision.update({companionVision: true}), false);
  assert.equal(capture.started, 1);
  vision.attachToNextTurn([{mime: 'image/jpeg', base64: TV}]);
  assert.equal(vision.update({}), true);
  assert.equal(capture.stopped, 1);
  assert.equal(vision.queue.length, 0);
});

test('a typed look-like line captures at admission and the turn takes that picture (once, also on a retry)', async () => {
  const capture = fakeCapture(), vision = on(new CompanionVision({capture}));
  assert.equal(vision.beginTurn({requestId: 'turn-1', text: 'Look at that!'}), true);
  assert.equal(vision.beginTurn({requestId: 'turn-2', text: 'Hello'}), false);
  assert.equal(vision.beginTurn({requestId: 'turn-3', text: 'look at that', reaction: {kind: 'battle'}}), false);
  const images = await vision.imagesForTurn({visionTurn: 'turn-1', characterId: 'judy'});
  assert.deepEqual(images, [{mime: 'image/jpeg', base64: PICTURE}]);
  assert.deepEqual(await vision.imagesForTurn({visionTurn: 'turn-1', characterId: 'judy'}), images);
  assert.equal(capture.calls, 1);
  assert.equal(await vision.imagesForTurn({visionTurn: 'turn-2'}), null);
  assert.equal(await vision.imagesForTurn({visionTurn: 'turn-1', freshSession: true}), null, 'speculative turns never carry one');
});

test('a slow capture never holds a turn longer than CAPTURE_WAIT_MS', async () => {
  const vision = on(new CompanionVision({capture: fakeCapture({delayMs: 1000}), waitMs: 50}));
  vision.beginTurn({requestId: 't', text: 'what do you see'});
  const started = performance.now();
  assert.equal(await vision.imagesForTurn({visionTurn: 't'}), null);
  assert.ok(performance.now() - started < 500);
  assert.ok(CAPTURE_WAIT_MS <= 400);
});

test('a minimised game or a failed capture sends no picture and the turn goes on', async () => {
  const vision = on(new CompanionVision({capture: fakeCapture({result: {ok: false, reason: 'minimised'}})}));
  vision.beginTurn({requestId: 't', text: 'what do you see'});
  assert.equal(await vision.imagesForTurn({visionTurn: 't'}), null);
  assert.equal(vision.diagnostics().minimised, 1);
});

test('talk key: the first look-like words stage the picture while V talks; the finish adds nothing', async () => {
  const staged = [];
  const capture = fakeCapture();
  const vision = on(new CompanionVision({capture, stageVoice: async (images, id) => { staged.push([id, images.length]); return {staged: true}; }}));
  assert.equal(vision.noteHeard('mic-1', 'so what do'), false);
  assert.equal(vision.noteHeard('mic-1', 'so what do you see'), true);
  assert.equal(vision.noteHeard('mic-1', 'so what do you see over there'), false, 'once per recording');
  assert.equal(await vision.imagesForTurn({visionTurn: 'mic-1'}, {phase: 'finish', heard: 'so what do you see over there'}), null);
  assert.deepEqual(staged, [['mic-1', 1]]);
  assert.equal(capture.calls, 1);
});

test('talk key: words that ask only at the very end are captured at the finish', async () => {
  const capture = fakeCapture(), vision = on(new CompanionVision({capture}));
  assert.deepEqual(await vision.imagesForTurn({visionTurn: 'mic-2'}, {phase: 'finish', heard: 'and how do I look'}),
    [{mime: 'image/jpeg', base64: PICTURE}]);
  assert.equal(await vision.imagesForTurn({visionTurn: 'mic-3'}, {phase: 'finish', heard: 'see you later then'}), null);
});

test('attachToNextTurn: queued frames go with the next turn after the game view, filtered by character, and expire', async () => {
  let now = 1000;
  const vision = on(new CompanionVision({capture: fakeCapture(), now: () => now}));
  assert.deepEqual(vision.attachToNextTurn([{mime: 'image/jpeg', base64: TV}], {characterId: 'judy'}), {queued: 1});
  assert.deepEqual(vision.attachToNextTurn([{mime: 'text/html', base64: TV}]), {queued: 0, reason: 'invalid'});
  assert.equal(await vision.imagesForTurn({visionTurn: 'a', characterId: 'panam'}), null, 'another character does not take it');
  vision.beginTurn({requestId: 'b', text: 'what do you see on the tv'});
  assert.deepEqual(await vision.imagesForTurn({visionTurn: 'b', characterId: 'judy'}),
    [{mime: 'image/jpeg', base64: PICTURE}, {mime: 'image/jpeg', base64: TV}]);
  vision.attachToNextTurn([{mime: 'image/png', base64: TV}], {ttlMs: 2000});
  now += 5000;
  assert.equal(await vision.imagesForTurn({visionTurn: 'c'}), null, 'expired');
  for (let i = 0; i < 6; i++) vision.attachToNextTurn([{mime: 'image/jpeg', base64: TV}]);
  assert.equal((await vision.imagesForTurn({visionTurn: 'd'})).length, 4, 'never more than four');
});

test('a queued picture joins a picture already staged during the recording', async () => {
  const vision = on(new CompanionVision({capture: fakeCapture(), stageVoice: async () => ({staged: true})}));
  vision.noteHeard('mic', 'look at that');
  vision.attachToNextTurn([{mime: 'image/jpeg', base64: TV}]);
  assert.deepEqual(await vision.imagesForTurn({visionTurn: 'mic'}, {phase: 'finish'}),
    [{mime: 'image/jpeg', base64: PICTURE}, {mime: 'image/jpeg', base64: TV}]);
});

test('nothing is written to disk unless a developer names a debug folder', async () => {
  const writes = [];
  const plain = on(new CompanionVision({capture: fakeCapture(), debugDirectory: undefined, writeDebug: async path => writes.push(path)}));
  plain.beginTurn({requestId: 'x', text: 'look at that'});
  await plain.imagesForTurn({visionTurn: 'x'});
  assert.equal(writes.length, 0);
  const debug = on(new CompanionVision({capture: fakeCapture(), debugDirectory: 'C:\\debug', writeDebug: async path => writes.push(path)}));
  debug.beginTurn({requestId: 'y', text: 'look at that'});
  await debug.imagesForTurn({visionTurn: 'y'});
  assert.equal(writes.length, 1);
  assert.match(writes[0], /vision-.*\.jpg$/);
});

// ---- the helper client ----------------------------------------------------------------------------------------------------------
function fakeChild(script) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.lines = [];
  child.stdin = {on() {}, write(line) { child.lines.push(line); const reply = script(line); if (reply !== undefined) setImmediate(() => child.stdout.emit('data', reply + '\n')); },
    end(line) { child.lines.push(line); setImmediate(() => child.emit('exit', 0)); }};
  child.kill = () => child.emit('exit', 1);
  setImmediate(() => child.stdout.emit('data', '{"ready":true}\n'));
  return child;
}

test('the helper client asks for one bounded picture and returns it', async () => {
  let child;
  const capture = new VisionCapture({candidates: ['C:\\helper.exe'], exists: () => true,
    spawnHelper: () => (child = fakeChild(() => JSON.stringify({ok: true, width: 768, height: 432, sourceWidth: 1366, sourceHeight: 768,
      bytes: 3, ms: {total: 120}, jpeg: PICTURE})))});
  const result = await capture.capture({maxWidth: 99999, quality: 0});
  assert.equal(result.ok, true);
  assert.equal(result.base64, PICTURE);
  assert.deepEqual(child.lines, ['capture 2048 80\n'], 'width is clamped; quality falls back to the default');
  capture.stop();
  assert.equal(child.lines.at(-1), 'quit\n');
});

test('the helper client reports a missing helper, a minimised game and a timeout without throwing', async () => {
  assert.deepEqual(await new VisionCapture({candidates: [], exists: () => false}).capture(), {ok: false, reason: 'unavailable', ms: {}});
  const minimised = new VisionCapture({candidates: ['C:\\h.exe'], exists: () => true,
    spawnHelper: () => fakeChild(() => '{"ok":false,"reason":"minimised","ms":{"total":1}}')});
  assert.equal((await minimised.capture()).reason, 'minimised');
  minimised.stop();
  const silent = new VisionCapture({candidates: ['C:\\h.exe'], exists: () => true, spawnHelper: () => fakeChild(() => undefined)});
  assert.equal((await silent.capture({timeoutMs: 30})).reason, 'timeout');
  assert.equal(normalise({ok: false, reason: '<script>'}).reason, 'failed');
});

test('the helper is looked for at an override, the release layout and the development build', () => {
  const list = helperCandidates({env: {}, projectDirectory: 'C:\\mod'});
  assert.deepEqual(list.map(path => path.replace(/\//g, '\\')), ['C:\\mod\\vision\\CyberpunkConvaiVision.exe', 'C:\\mod\\dist\\vision\\CyberpunkConvaiVision.exe']);
  assert.throws(() => helperCandidates({env: {CYBERPUNK_CONVAI_VISION_HELPER: 'relative.exe'}}), /absolute/);
});

// ---- the realtime host hooks ------------------------------------------------------------------------------------------------------
test('the realtime host connects pages with vision only while the policy says so and strips stale fields', () => {
  let active = false;
  const host = new RealtimeHost({vision: {connectConfig: () => active ? {transport: 'video'} : null}});
  assert.deepEqual(host.withVision({characterId: 'c', vision: true, visionTransport: 'upload'}), {characterId: 'c'});
  active = true;
  assert.deepEqual(host.withVision({characterId: 'c'}), {characterId: 'c', vision: true, visionTransport: 'video'});
  assert.deepEqual(new RealtimeHost().withVision({characterId: 'c'}), {characterId: 'c'});
});

test('the realtime host never lets a picture fail a turn, and never gives one to a speculative or reaction turn', async () => {
  const host = new RealtimeHost({vision: {imagesForTurn: async (config, {phase}) => {
    if (config.characterId === 'boom') throw Error('capture exploded');
    return [{mime: 'image/jpeg', base64: phase === 'finish' ? TV : PICTURE}];
  }}});
  assert.deepEqual(await host.turnImages({characterId: 'c'}, 'reply'), [{mime: 'image/jpeg', base64: PICTURE}]);
  assert.equal(await host.turnImages({characterId: 'boom'}, 'reply'), null);
  assert.equal(await host.turnImages({characterId: 'c', freshSession: true}, 'reply'), null);
  assert.equal(await host.turnImages({characterId: 'c', reaction: true}, 'reply'), null);
  assert.deepEqual(await host.stageVoiceVision([]), {staged: false, reason: 'no-recording'});
});
