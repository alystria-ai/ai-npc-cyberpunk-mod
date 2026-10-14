import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CompanionVision, FRAME_INTERVAL_MS, LEAD_MS, TAIL_MS, MAX_FRAME_AGE_MS, FRAME_SLOTS, visionDisabledByEnv} from './companion-vision.mjs';
import {VisionCapture, normalise, helperCandidates} from './vision-capture.mjs';
import {RealtimeHost} from './realtime-host.mjs';

const TV = Buffer.from('tv frame').toString('base64');
const shotOf = n => Buffer.from(`frame ${String(n).padStart(3, '0')}`).toString('base64');

// A helper that answers at once with a numbered picture; `running` follows start/stop/capture like VisionCapture.
function fakeCapture({fail} = {}) {
  const capture = {calls: 0, started: 0, stopped: 0, running: false,
    start: async () => { capture.started++; capture.running = true; return true; },
    stop: () => { capture.stopped++; capture.running = false; },
    capture: async () => {
      capture.calls++; capture.running = true;
      return fail ? {ok: false, reason: fail} : {ok: true, mime: 'image/jpeg', base64: shotOf(capture.calls), width: 768, height: 432, bytes: 9, ms: {total: 100}};
    }};
  return capture;
}
// A scene with a clock, a companion nearby or not, a conversation running or not; tick() is the bridge's 500 ms poll.
function scene(options = {}) {
  const state = {now: 100000, near: true, conversing: false, convai: true};
  const capture = options.capture ?? fakeCapture();
  const vision = new CompanionVision({capture, now: () => state.now, isNear: () => state.near, isConversing: () => state.conversing,
    isConvai: () => state.convai, env: {}, sleep: () => new Promise(done => setImmediate(done)), ...options});
  const settle = () => new Promise(done => setImmediate(done));
  const tick = async (settings = {}) => { vision.update(settings); await settle(); };
  // Advances the clock in poll-sized steps, ticking like the bridge does.
  const run = async (ms, settings) => { for (let t = 0; t < ms; t += 500) { state.now += 500; await tick(settings); } };
  return {state, capture, vision, tick, run};
}
const pictureOf = base64 => [{mime: 'image/jpeg', base64}];

test('on by default with Convai; settings.json false or CYBERPUNK_CONVAI_VISION=off turns it off; Mistral and Local get nothing', async () => {
  const {vision, state, tick} = scene();
  assert.equal(vision.active, true);
  assert.deepEqual(vision.connectConfig(), {transport: 'video'});
  await tick({companionVision: false});
  assert.equal(vision.active, false);
  assert.equal(vision.connectConfig(), null);
  assert.deepEqual(vision.attachToNextTurn(pictureOf(TV)), {queued: 0, reason: 'off'});
  await tick({});
  assert.equal(vision.active, true, 'a missing key is on');
  state.convai = false;
  assert.equal(vision.connectConfig(), null);
  assert.deepEqual(vision.attachToNextTurn(pictureOf(TV)), {queued: 0, reason: 'provider'});
  assert.equal(visionDisabledByEnv({CYBERPUNK_CONVAI_VISION: 'off'}), true);
  assert.equal(visionDisabledByEnv({}), false);
  const off = new CompanionVision({capture: fakeCapture(), env: {CYBERPUNK_CONVAI_VISION: '0'}});
  off.update({companionVision: true});
  assert.equal(off.active, false, 'the environment switch wins');
});

test('the buffer captures every FRAME_INTERVAL_MS while someone is near and nobody talks, and keeps FRAME_SLOTS frames in memory', async () => {
  const {vision, capture, run} = scene();
  await run(FRAME_INTERVAL_MS * 6);
  assert.ok(capture.calls >= 6 && capture.calls <= 7, `${capture.calls} captures`);
  assert.equal(vision.frames.length, FRAME_SLOTS);
  assert.equal(vision.diagnostics().helperRunning, true);
});

test('unload rule: no helper when the setting is off, under another provider, with nobody near, or during a conversation', async () => {
  const {vision, capture, state, run, tick} = scene();
  await run(1000);
  assert.equal(capture.running, true);
  await tick({companionVision: false});
  assert.equal(capture.running, false, 'setting off: released at once');
  assert.equal(vision.frames.length, 0, 'and the buffer is dropped');
  await run(4000, {}); assert.equal(capture.running, true);
  state.convai = false; await tick();
  assert.equal(capture.running, false, 'Mistral or Local AI: released at once');
  assert.equal(vision.frames.length, 0);
  state.convai = true; await run(4000); assert.equal(capture.running, true);
  state.near = false; await tick();
  assert.equal(capture.running, false, 'nobody near: released');
  state.near = true; await run(1000); assert.equal(capture.running, true);
  state.conversing = true; await tick();
  assert.equal(capture.running, false, 'a conversation: released (the view is on the companion)');
  const calls = capture.calls;
  state.conversing = false; await run(TAIL_MS - 1000);
  assert.equal(capture.calls, calls, 'nothing is captured for TAIL_MS after the conversation');
  await run(2000);
  assert.ok(capture.calls > calls, 'then the buffer fills again');
});

test('a turn takes the newest frame from at least LEAD_MS before the conversation started, not one taken as V turned to talk', async () => {
  const {vision, state, run} = scene();
  await run(FRAME_INTERVAL_MS * 4);
  const frames = vision.frames.map(frame => ({at: frame.at, base64: frame.base64}));
  // The talk starts just after the newest capture: that frame may already show the companion's face.
  state.now = frames.at(-1).at + 1000;
  vision.beginTurn({requestId: 't1', text: 'hello'});
  const expected = [...frames].reverse().find(frame => frame.at <= state.now - LEAD_MS);
  assert.notEqual(expected.base64, frames.at(-1).base64);
  assert.deepEqual(await vision.imagesForTurn({visionTurn: 't1'}), pictureOf(expected.base64));
  assert.deepEqual(await vision.imagesForTurn({visionTurn: 't1'}), pictureOf(expected.base64), 'a retry sends the same picture');
  assert.equal(await vision.imagesForTurn({visionTurn: 't2', freshSession: true}), null, 'speculative turns carry none');
  assert.equal(await vision.imagesForTurn({visionTurn: 't3', reaction: {kind: 'battle'}}), null, 'reactions carry none');
});

test('a long conversation keeps the frame from before it; one older than MAX_FRAME_AGE_MS is not sent', async () => {
  const {vision, state, run} = scene();
  await run(FRAME_INTERVAL_MS * 3);
  state.conversing = true;
  await run(60000);
  assert.ok(await vision.imagesForTurn({visionTurn: 'a'}), 'a minute in: still the frame from before');
  await run(MAX_FRAME_AGE_MS);
  assert.equal(await vision.imagesForTurn({visionTurn: 'b'}), null, 'too old');
  assert.equal(vision.diagnostics().turnsWithoutFrame, 1);
});

test('a picture finished after a conversation began is dropped', async () => {
  let release;
  const capture = fakeCapture();
  const slow = {...capture, get running() { return capture.running; }, start: capture.start, stop: capture.stop,
    capture: () => new Promise(done => { release = () => done({ok: true, mime: 'image/jpeg', base64: shotOf(9), width: 1, height: 1, bytes: 1, ms: {}}); })};
  const {vision, state, tick} = scene({capture: slow});
  await tick();
  assert.equal(typeof release, 'function', 'a capture is running');
  state.now += 100; vision.beginTurn({requestId: 'r', text: 'hi'});
  release(); await tick();
  assert.equal(vision.frames.length, 0);
});

test('typed line: the frame is staged on the target pages when the composer opens, retried while a page connects', async () => {
  const calls = [];
  let connected = false;
  const {vision, run} = scene({stagePage: async (config, images) => {
    calls.push([config.characterId, images.length]);
    return connected ? {staged: true} : {staged: false, reason: 'no-page'};
  }, unstagePage: async config => calls.push(['unstage', config.characterId])});
  await run(FRAME_INTERVAL_MS * 3);
  const page = {characterId: 'judy'};
  assert.equal(vision.openComposer([page]), true);
  await new Promise(done => setImmediate(done));
  connected = true;
  for (let i = 0; i < 5; i++) await new Promise(done => setImmediate(done));
  assert.ok(calls.filter(call => call[0] === 'judy').length >= 2, 'retried until the page was open');
  assert.equal(vision.diagnostics().prestaged, 1);
  vision.closeComposer();
  await new Promise(done => setImmediate(done));
  assert.deepEqual(calls.at(-1), ['unstage', 'judy'], 'a picture no turn took is withdrawn');
  assert.equal(vision.openComposer([]), false);
});

test('talk key: the frame is staged on the recording as soon as it runs; the finish sends nothing more', async () => {
  const staged = [];
  let recording = false;
  const {vision, run} = scene({stageVoice: async (images, id) => {
    staged.push(id);
    return recording ? {staged: true} : {staged: false, reason: 'no-recording'};
  }});
  await run(FRAME_INTERVAL_MS * 3);
  assert.equal(vision.beginVoice('mic-1'), true);
  assert.equal(vision.beginVoice('mic-1'), false, 'once per recording');
  await new Promise(done => setImmediate(done));
  recording = true;
  await vision.voice.get('mic-1').done;
  assert.ok(staged.length >= 2);
  assert.equal(await vision.imagesForTurn({visionTurn: 'mic-1'}, {phase: 'finish'}), null);
  vision.attachToNextTurn(pictureOf(TV));
  const both = await vision.imagesForTurn({visionTurn: 'mic-2'}, {phase: 'reply'});
  assert.equal(both.length, 2, 'a queued picture joins the frame');
});

test('attachToNextTurn: queued pictures follow the frame, filtered by character, expire, and never exceed four', async () => {
  const {vision, state, run} = scene();
  await run(FRAME_INTERVAL_MS * 2);
  assert.deepEqual(vision.attachToNextTurn(pictureOf(TV), {characterId: 'judy'}), {queued: 1});
  assert.deepEqual(vision.attachToNextTurn([{mime: 'text/html', base64: TV}]), {queued: 0, reason: 'invalid'});
  assert.equal((await vision.imagesForTurn({visionTurn: 'a', characterId: 'panam'})).length, 1, 'another character does not take it');
  const judy = await vision.imagesForTurn({visionTurn: 'b', characterId: 'judy'});
  assert.equal(judy.length, 2); assert.equal(judy[1].base64, TV);
  vision.attachToNextTurn([{mime: 'image/png', base64: TV}], {ttlMs: 2000});
  state.now += 5000;
  assert.equal((await vision.imagesForTurn({visionTurn: 'c'})).length, 1, 'expired');
  for (let i = 0; i < 6; i++) vision.attachToNextTurn(pictureOf(TV));
  assert.equal((await vision.imagesForTurn({visionTurn: 'd'})).length, 4, 'never more than four');
});

test('a minimised game gives no frame and the turn goes on without one', async () => {
  const {vision, run} = scene({capture: fakeCapture({fail: 'minimised'})});
  await run(FRAME_INTERVAL_MS * 2);
  assert.equal(await vision.imagesForTurn({visionTurn: 't'}), null);
  assert.ok(vision.diagnostics().minimised >= 2);
});

test('nothing is written to disk unless a developer names a debug folder', async () => {
  const writes = [];
  const plain = scene({debugDirectory: undefined, writeDebug: async path => writes.push(path)});
  await plain.run(FRAME_INTERVAL_MS);
  assert.equal(writes.length, 0);
  const debug = scene({debugDirectory: 'C:\\debug', writeDebug: async path => writes.push(path)});
  await debug.run(FRAME_INTERVAL_MS);
  assert.ok(writes.length >= 1);
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
      bytes: 3, ms: {total: 120}, jpeg: TV})))});
  assert.equal(capture.running, false);
  const result = await capture.capture({maxWidth: 99999, quality: 0});
  assert.equal(result.ok, true);
  assert.equal(result.base64, TV);
  assert.equal(capture.running, true);
  assert.deepEqual(child.lines, ['capture 2048 80\n'], 'width is clamped; quality falls back to the default');
  capture.stop();
  assert.equal(child.lines.at(-1), 'quit\n');
  assert.equal(capture.running, false);
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
test('the realtime host connects pages with vision only while the policy says so, passes the wait cap, and strips stale fields', () => {
  let active = false;
  const host = new RealtimeHost({vision: {connectConfig: () => active ? {transport: 'video'} : null, turnWaitMs: () => 0}});
  assert.deepEqual(host.withVision({characterId: 'c', vision: true, visionTransport: 'upload', visionWaitMs: 5}), {characterId: 'c'});
  active = true;
  assert.deepEqual(host.withVision({characterId: 'c'}), {characterId: 'c', vision: true, visionTransport: 'video', visionWaitMs: 0});
  assert.deepEqual(new RealtimeHost().withVision({characterId: 'c'}), {characterId: 'c'});
});

test('the realtime host never lets a picture fail a turn, and never gives one to a speculative or reaction turn', async () => {
  const host = new RealtimeHost({vision: {imagesForTurn: async (config, {phase}) => {
    if (config.characterId === 'boom') throw Error('capture exploded');
    return [{mime: 'image/jpeg', base64: phase === 'finish' ? TV : shotOf(1)}];
  }}});
  assert.deepEqual(await host.turnImages({characterId: 'c'}, 'reply'), [{mime: 'image/jpeg', base64: shotOf(1)}]);
  assert.equal(await host.turnImages({characterId: 'boom'}, 'reply'), null);
  assert.equal(await host.turnImages({characterId: 'c', freshSession: true}, 'reply'), null);
  assert.equal(await host.turnImages({characterId: 'c', reaction: true}, 'reply'), null);
  assert.deepEqual(await host.stageVoiceVision([]), {staged: false, reason: 'no-recording'});
  assert.deepEqual(await host.prestageVision({characterId: 'c'}, []), {staged: false, reason: 'no-page'});
  await host.unstageVision({characterId: 'c'});
});
