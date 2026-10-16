import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CompanionVision, FRAME_INTERVAL_MS, LEAD_MS, TAIL_MS, MAX_FRAME_AGE_MS, FRESH_FRAME_AGE_MS, FRAME_SLOTS, visionDisabledByEnv} from './companion-vision.mjs';
import {VisionCapture, normalise, helperCandidates, CAPTURE_DEFAULTS} from './vision-capture.mjs';
import {RealtimeHost} from './realtime-host.mjs';

const QUEUED = Buffer.from('queued picture').toString('base64');
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

test('always on with Convai (a saved companionVision false from an older install is ignored); CYBERPUNK_CONVAI_VISION=off turns it off; Mistral and Local get nothing', async () => {
  const {vision, state, tick} = scene();
  assert.equal(vision.active, true);
  assert.deepEqual(vision.connectConfig(), {transport: 'video'});
  await tick({companionVision: false});
  assert.equal(vision.active, true, 'the retired setting no longer turns vision off');
  assert.deepEqual(vision.connectConfig(), {transport: 'video'});
  await tick({});
  assert.equal(vision.active, true, 'a missing key is on');
  state.convai = false;
  assert.equal(vision.connectConfig(), null);
  assert.deepEqual(vision.attachToNextTurn(pictureOf(QUEUED)), {queued: 0, reason: 'provider'});
  assert.equal(visionDisabledByEnv({CYBERPUNK_CONVAI_VISION: 'off'}), true);
  assert.equal(visionDisabledByEnv({}), false);
  const off = new CompanionVision({capture: fakeCapture(), env: {CYBERPUNK_CONVAI_VISION: '0'}});
  off.update({});
  assert.equal(off.active, false, 'the environment switch is the only off switch');
});

test('the buffer captures every FRAME_INTERVAL_MS while someone is near and nobody talks, and keeps FRAME_SLOTS frames in memory', async () => {
  const {vision, capture, run} = scene();
  await run(FRAME_INTERVAL_MS * 6);
  assert.ok(capture.calls >= 6 && capture.calls <= 7, `${capture.calls} captures`);
  assert.equal(vision.frames.length, FRAME_SLOTS);
  assert.equal(vision.diagnostics().helperRunning, true);
});

test('unload rule: no helper under another provider, with nobody near, or during a conversation', async () => {
  const {vision, capture, state, run, tick} = scene();
  await run(1000);
  assert.equal(capture.running, true);
  await tick({companionVision: false});
  assert.equal(capture.running, true, 'an old saved false does not release it');
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

test('the age limit is 15 s: the frame from before a conversation is sent while it is within it, never after', async () => {
  assert.equal(MAX_FRAME_AGE_MS, 15000);
  const logs = [];
  const {vision, state, run, capture} = scene({log: line => logs.push(line)});
  await run(FRAME_INTERVAL_MS * 3);
  state.conversing = true;
  await run(8000);   // the frames taken before the conversation are now 8 to 14 s old
  const callsBefore = capture.calls;
  const young = await vision.imagesForTurn({visionTurn: 'a'});
  assert.ok(young, 'a frame within the limit is sent as it is');
  assert.equal(capture.calls, callsBefore, 'and no capture is taken to replace a frame that is merely not brand new');
  assert.match(logs.at(-1), /turn \w+: 1 image\(s\), frame \d+ s old/);
  assert.ok(Number(/frame (\d+) s old/.exec(logs.at(-1))[1]) <= 15);
});

test('a stale buffer is never sent: the turn takes one capture (at most TURN_CAPTURE_WAIT_MS), and with none it goes without a picture and logs why', async () => {
  const logs = [];
  const {vision, state, run, capture} = scene({log: line => logs.push(line)});
  await run(FRAME_INTERVAL_MS * 3);
  state.conversing = true;
  await run(60000);   // a long conversation: the helper is released, the buffered frames are 1 minute old
  assert.equal(vision.frames.length, 0, 'frames past the limit are dropped');
  assert.equal(capture.running, false, 'the helper stays released during the conversation');
  const callsBefore = capture.calls;
  const images = await vision.imagesForTurn({visionTurn: 'b'});
  assert.equal(capture.calls, callsBefore + 1, 'one capture for the turn');
  assert.equal(images.length, 1);
  assert.equal(images[0].base64, shotOf(capture.calls), 'the new picture, not a stale one');
  assert.match(logs.at(-1), /1 image\(s\), frame 0 s old/);
  await run(1000);
  assert.equal(capture.running, false, 'the helper is released again by the next polls');
  assert.equal(vision.diagnostics().turnCaptures, 1);
  // The capture fails (a minimised game): no picture, never a stale one, and the log says so.
  const failing = scene({capture: fakeCapture({fail: 'minimised'}), log: line => logs.push(line)});
  await failing.run(FRAME_INTERVAL_MS);
  failing.state.conversing = true;
  await failing.run(30000);
  assert.equal(await failing.vision.imagesForTurn({visionTurn: 'c'}), null);
  assert.match(logs.at(-1), /turn \w+: no frame yet/);
  assert.equal(failing.vision.diagnostics().turnsWithoutFrame, 1);
});

test('a turn that finds only an old frame says how old it was in the log', async () => {
  const logs = [];
  const capture = fakeCapture();
  const {vision, state, run} = scene({capture, log: line => logs.push(line)});
  await run(FRAME_INTERVAL_MS * 2);
  state.conversing = true;
  await run(52000);
  capture.capture = async () => ({ok: false, reason: 'failed'});
  assert.equal(await vision.imagesForTurn({visionTurn: 'late'}), null);
  assert.match(logs.at(-1), /no fresh frame \(newest 5\d s old, limit 15 s\)/);
});

test('a slow capture does not hold a turn for more than TURN_CAPTURE_WAIT_MS', async () => {
  let release;
  const capture = fakeCapture();
  const slow = {...capture, get running() { return capture.running; }, start: capture.start, stop: capture.stop,
    capture: () => new Promise(done => { release = () => done({ok: true, mime: 'image/jpeg', base64: shotOf(7), width: 1, height: 1, bytes: 1, ms: {}}); })};
  let waited = 0;
  const vision = new CompanionVision({capture: slow, now: () => 1000, env: {}, sleep: ms => { waited = ms; return new Promise(done => setImmediate(done)); }});
  const images = await vision.imagesForTurn({visionTurn: 'x'});
  assert.equal(images, null);
  assert.equal(waited, 450);
  release();   // it lands in the buffer for the next turn
  await new Promise(done => setImmediate(done)); await new Promise(done => setImmediate(done));
  assert.equal(vision.frames.length, 1);
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

test('typed line: with no young frame a picture is taken as the composer opens and staged; with a young one no capture is taken', async () => {
  const staged = [];
  const {vision, state, run, capture} = scene({stagePage: async (config, images) => { staged.push(images[0].base64); return {staged: true}; }});
  await run(FRAME_INTERVAL_MS * 2);
  state.conversing = true;
  await run(30000);   // the buffer is gone: only a picture taken now can be sent
  assert.equal(vision.frames.length, 0);
  const before = capture.calls;
  assert.equal(vision.openComposer([{characterId: 'alex'}]), true);
  for (let i = 0; i < 6; i++) await new Promise(done => setImmediate(done));
  assert.equal(capture.calls, before + 1, 'one capture at the composer');
  assert.deepEqual(staged, [shotOf(capture.calls)], 'the new picture is the one staged');
  assert.equal(vision.stagedFrame.turn, true);
  // The send: the staged frame goes, no second capture.
  assert.deepEqual(await vision.imagesForTurn({visionTurn: 'typed'}), pictureOf(shotOf(capture.calls)));
  assert.equal(capture.calls, before + 1);
  // A young buffered frame needs no capture at all.
  const fresh = scene({stagePage: async () => ({staged: true})});
  await fresh.run(FRAME_INTERVAL_MS * 3);
  const calls = fresh.capture.calls;
  fresh.vision.openComposer([{characterId: 'alex'}]);
  for (let i = 0; i < 4; i++) await new Promise(done => setImmediate(done));
  assert.equal(fresh.capture.calls, calls, 'a frame under FRESH_FRAME_AGE_MS is used as it is');
  assert.ok(FRESH_FRAME_AGE_MS < MAX_FRAME_AGE_MS);
});

test('a long typed line: a frame staged more than 15 s ago is replaced by a new capture at the send', async () => {
  const {vision, state, run, capture} = scene({stagePage: async () => ({staged: true})});
  await run(FRAME_INTERVAL_MS * 2);
  state.conversing = true;
  vision.openComposer([{characterId: 'alex'}]);
  for (let i = 0; i < 4; i++) await new Promise(done => setImmediate(done));
  const stagedShot = vision.stagedFrame.base64;
  await run(20000);   // V types for 20 s
  const calls = capture.calls;
  const images = await vision.imagesForTurn({visionTurn: 'slow-typist'});
  assert.equal(capture.calls, calls + 1);
  assert.notEqual(images[0].base64, stagedShot, 'not the staged picture, which is past the limit');
});

test('debug: the last picture sent is kept only when a developer turns it on, with a line about it', async () => {
  const writes = [];
  const path = 'C:\\runtime\\vision-last-sent.jpg';
  const off = scene({lastSentPath: path, writeDebug: async (target, bytes) => writes.push([target, bytes])});
  await off.run(FRAME_INTERVAL_MS * 2);
  await off.vision.imagesForTurn({visionTurn: 'a'});
  assert.equal(writes.length, 0, 'off by default');
  const on = scene({lastSentPath: path, env: {CYBERPUNK_CONVAI_VISION_DEBUG_LAST: '1'}, writeDebug: async (target, bytes) => writes.push([target, bytes])});
  await on.run(FRAME_INTERVAL_MS * 2);
  await on.vision.imagesForTurn({visionTurn: 'b'});
  assert.equal(writes.length, 2);
  assert.equal(writes[0][0], path);
  assert.match(writes[0][1].toString(), /^frame \d+$/);
  const note = JSON.parse(writes[1][1]);
  assert.equal(writes[1][0], 'C:\\runtime\\vision-last-sent.json');
  assert.equal(note.how, 'sent with the turn');
  assert.equal(note.width, 768);
  assert.ok(note.ageMs >= 0 && note.ageMs <= MAX_FRAME_AGE_MS);
  // The setting in settings.json does the same.
  const viaSettings = scene({lastSentPath: path, writeDebug: async (target, bytes) => writes.push([target, bytes])});
  await viaSettings.tick({visionDebugLastSent: true});
  assert.equal(viaSettings.vision.debugLast, true);
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
  vision.attachToNextTurn(pictureOf(QUEUED));
  const both = await vision.imagesForTurn({visionTurn: 'mic-2'}, {phase: 'reply'});
  assert.equal(both.length, 2, 'a queued picture joins the frame');
});

test('talk key: with no young frame a picture is taken as the key is pressed and staged; a recording longer than 15 s gets a new picture at the end', async () => {
  const staged = [];
  const logs = [];
  const {vision, state, run, capture} = scene({stageVoice: async images => { staged.push(images[0].base64); return {staged: true}; }, log: line => logs.push(line)});
  await run(FRAME_INTERVAL_MS * 2);
  state.conversing = true;
  await run(40000);
  assert.equal(vision.frames.length, 0);
  const before = capture.calls;
  assert.equal(vision.beginVoice('mic-stale'), true);
  await vision.voice.get('mic-stale').done;
  assert.equal(capture.calls, before + 1);
  assert.deepEqual(staged, [shotOf(capture.calls)]);
  assert.equal(await vision.imagesForTurn({visionTurn: 'mic-stale'}, {phase: 'finish'}), null, 'staged while talking: nothing more');
  assert.match(logs.at(-1), /staged while talking \(frame \d+ s old\)/);
  // A long monologue: the staged picture is past the limit by the time the key is released.
  vision.beginVoice('mic-long');
  await vision.voice.get('mic-long').done;
  const stale = capture.calls;
  await run(20000);
  const replaced = await vision.imagesForTurn({visionTurn: 'mic-long'}, {phase: 'finish'});
  assert.equal(capture.calls, stale + 1);
  assert.equal(replaced[0].base64, shotOf(capture.calls), 'a new picture goes with the finish');
  assert.match(logs.at(-1), /the staged one was 2\d s old/);
});

test('attachToNextTurn: queued pictures follow the frame, filtered by character, expire, and never exceed four', async () => {
  const {vision, state, run} = scene();
  await run(FRAME_INTERVAL_MS * 2);
  assert.deepEqual(vision.attachToNextTurn(pictureOf(QUEUED), {characterId: 'judy'}), {queued: 1});
  assert.deepEqual(vision.attachToNextTurn([{mime: 'text/html', base64: QUEUED}]), {queued: 0, reason: 'invalid'});
  assert.equal((await vision.imagesForTurn({visionTurn: 'a', characterId: 'panam'})).length, 1, 'another character does not take it');
  const judy = await vision.imagesForTurn({visionTurn: 'b', characterId: 'judy'});
  assert.equal(judy.length, 2); assert.equal(judy[1].base64, QUEUED);
  vision.attachToNextTurn([{mime: 'image/png', base64: QUEUED}], {ttlMs: 2000});
  state.now += 5000;
  assert.equal((await vision.imagesForTurn({visionTurn: 'c'})).length, 1, 'expired');
  for (let i = 0; i < 6; i++) vision.attachToNextTurn(pictureOf(QUEUED));
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
      bytes: 3, ms: {total: 120}, jpeg: QUEUED})))});
  assert.equal(capture.running, false);
  const result = await capture.capture({maxWidth: 99999, quality: 0});
  assert.equal(result.ok, true);
  assert.equal(result.base64, QUEUED);
  assert.equal(capture.running, true);
  assert.deepEqual(child.lines, ['capture 2048 88\n'], 'width is clamped; quality falls back to the default (1024 px, quality 88 when nothing is asked)');
  assert.equal(CAPTURE_DEFAULTS.maxWidth, 1024);
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
    return [{mime: 'image/jpeg', base64: phase === 'finish' ? QUEUED : shotOf(1)}];
  }}});
  assert.deepEqual(await host.turnImages({characterId: 'c'}, 'reply'), [{mime: 'image/jpeg', base64: shotOf(1)}]);
  assert.equal(await host.turnImages({characterId: 'boom'}, 'reply'), null);
  assert.equal(await host.turnImages({characterId: 'c', freshSession: true}, 'reply'), null);
  assert.equal(await host.turnImages({characterId: 'c', reaction: true}, 'reply'), null);
  assert.deepEqual(await host.stageVoiceVision([]), {staged: false, reason: 'no-recording'});
  assert.deepEqual(await host.prestageVision({characterId: 'c'}, []), {staged: false, reason: 'no-page'});
  await host.unstageVision({characterId: 'c'});
});
