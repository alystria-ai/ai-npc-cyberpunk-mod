import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CompanionVision, FRAME_INTERVAL_MS, LEAD_MS, TAIL_MS, MAX_FRAME_AGE_MS, FRESH_FRAME_AGE_MS, FRAME_SLOTS, visionDisabledByEnv} from './companion-vision.mjs';
import {VisionCapture, normalise, helperCandidates, CAPTURE_DEFAULTS} from './vision-capture.mjs';
import {RealtimeHost} from './realtime-host.mjs';

const QUEUED = Buffer.from('queued picture').toString('base64');
const shotOf = n => Buffer.from(`frame ${String(n).padStart(3, '0')}`).toString('base64');

// A helper that answers at once with a numbered picture; `running` follows start/stop/capture like VisionCapture.
function fakeCapture({fail, border} = {}) {
  const capture = {calls: 0, started: 0, stopped: 0, running: false, borderShown: false,
    start: async () => { capture.started++; capture.running = true; return true; },
    stop: () => { capture.stopped++; capture.running = false; },
    capture: async options => {
      capture.calls++; capture.running = true; capture.options = options; (capture.allOptions ??= []).push(options);
      if (!fail && border === true) capture.borderShown = true;
      return fail ? {ok: false, reason: fail} : {ok: true, mime: 'image/jpeg', base64: shotOf(capture.calls), width: 768, height: 432, bytes: 9, ms: {total: 100},
        ...(border === undefined ? {} : {method: border ? 'wgc' : 'dxgi', border})};
    }};
  return capture;
}
// A scene with a clock, a companion nearby or not, a conversation running or not; tick() is the bridge's 500 ms poll.
function scene(options = {}) {
  const state = {now: 100000, near: true, conversing: false, convai: true, sees: false};
  const capture = options.capture ?? fakeCapture();
  const vision = new CompanionVision({capture, now: () => state.now, isNear: () => state.near, isConversing: () => state.conversing,
    isConvai: () => state.convai, sees: () => state.sees, env: {}, sleep: () => new Promise(done => setImmediate(done)), ...options});
  vision.enabled = true;   // as if the settings poll had already read companionVision: true (nothing is polled before the first tick)
  const settle = () => new Promise(done => setImmediate(done));
  // The setting is on (settings.json `companionVision: true`) unless a test says otherwise: it is off by default, so nothing here runs without it.
  const tick = async (settings = {}) => { vision.update({companionVision: true, ...settings}); await settle(); };
  // Advances the clock in poll-sized steps, ticking like the bridge does.
  const run = async (ms, settings) => { for (let t = 0; t < ms; t += 500) { state.now += 500; await tick(settings); } };
  return {state, capture, vision, tick, run};
}
const pictureOf = base64 => [{mime: 'image/jpeg', base64}];

test('off by default: nothing is active, captured or held until the setting is on; it covers Convai and every other provider; CYBERPUNK_CONVAI_VISION=off overrides it', async () => {
  const state = {convai: true, sees: true};
  const capture = fakeCapture();
  const vision = new CompanionVision({capture, now: () => 1000, env: {}, isConvai: () => state.convai, sees: () => state.sees});
  assert.equal(vision.active, false, 'a fresh bridge has not read the setting: off');
  assert.equal(vision.connectConfig(), null);
  vision.update({});
  assert.equal(vision.active, false, 'a missing key is off');
  vision.update({companionVision: false});
  assert.equal(vision.active, false);
  assert.equal(vision.update({companionVision: true}), true, 'turning it on is a change');
  assert.equal(vision.active, true, 'Convai answers: on');
  assert.deepEqual(vision.connectConfig(), {transport: 'video'});
  state.convai = false;
  assert.equal(vision.active, true, 'Mistral, Local AI or Custom that can see: on too');
  assert.equal(vision.connectConfig(), null, 'no pages to connect with a picture channel');
  state.sees = false;
  assert.equal(vision.active, false, 'a provider that cannot see is not active');
  assert.deepEqual(vision.attachToNextTurn(pictureOf(QUEUED)), {queued: 0, reason: 'provider'});
  state.sees = true;
  assert.equal(vision.update({companionVision: false}), true);
  assert.equal(vision.active, false, 'turned off again');
  assert.deepEqual(vision.attachToNextTurn(pictureOf(QUEUED)), {queued: 0, reason: 'off'});
  assert.equal(visionDisabledByEnv({CYBERPUNK_CONVAI_VISION: 'off'}), true);
  assert.equal(visionDisabledByEnv({}), false);
  const off = new CompanionVision({capture: fakeCapture(), env: {CYBERPUNK_CONVAI_VISION: '0'}});
  off.update({companionVision: true});
  assert.equal(off.active, false, 'the environment switch overrides the setting');
});

test('setting off: no capture, no helper process, no picture in memory, on any provider', async () => {
  const {vision, capture, state, run, tick} = scene();
  await run(2000, {companionVision: false});
  assert.equal(capture.calls, 0);
  assert.equal(capture.started, 0, 'the helper was never started');
  assert.equal(capture.running, false);
  assert.equal(vision.frames.length, 0);
  state.convai = false;
  await run(2000, {companionVision: false});
  assert.equal(capture.calls, 0);
  assert.equal(capture.running, false);
  assert.equal(vision.openComposer([{characterId: 'a'}]), false, 'the composer opening takes no picture');
  assert.equal(vision.beginVoice('r1'), false);
  assert.equal(await vision.imagesForTurn({characterId: 'a', visionTurn: 'turn-1'}), null);
  await tick({companionVision: false});
  assert.equal(capture.calls, 0, 'nothing was captured for any of it');
  // The setting goes on, runs, and goes off again: the helper is released at once and the buffer emptied.
  state.convai = true;
  await run(4000);
  assert.equal(capture.running, true);
  assert.ok(vision.frames.length > 0);
  await tick({companionVision: false});
  assert.equal(capture.running, false, 'released on the next poll');
  assert.equal(vision.frames.length, 0);
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

test('a stale buffer is never sent and a turn never waits for a picture: it goes without one, a capture starts in the background for the next turn, and the log says why', async () => {
  const logs = [];
  const {vision, state, run, capture} = scene({log: line => logs.push(line)});
  await run(FRAME_INTERVAL_MS * 3);
  state.conversing = true;
  await run(60000);   // a long conversation: the helper is released, the buffered frames are 1 minute old
  assert.equal(vision.frames.length, 0, 'frames past the limit are dropped');
  assert.equal(capture.running, false, 'the helper stays released during the conversation');
  const callsBefore = capture.calls;
  const images = await vision.imagesForTurn({visionTurn: 'b'});
  assert.equal(images, null, 'no frame within the limit: the turn goes out at once without a picture');
  assert.match(logs.find(line => /turn \w+: /.test(line)), /no fresh frame|no frame yet/);
  assert.equal(vision.diagnostics().turnsWithoutFrame, 1);
  await new Promise(done => setImmediate(done));
  assert.equal(capture.calls, callsBefore + 1, 'one capture was started in the background');
  assert.equal(shotOf(capture.calls), vision.frame().base64, 'it lands in the buffer');
  const next = await vision.imagesForTurn({visionTurn: 'b2'});
  assert.equal(next.length, 1, 'the next turn has a frame');
  assert.equal(next[0].base64, shotOf(capture.calls), 'the new picture, not a stale one');
  assert.equal(capture.calls, callsBefore + 1, 'and takes no capture of its own');
  await run(1000);
  assert.equal(capture.running, false, 'the helper is released again by the next polls');
  assert.equal(vision.diagnostics().turnCaptures, 1);
  // The capture fails (a minimised game): no picture, never a stale one, and the log says so.
  const failing = scene({capture: fakeCapture({fail: 'minimised'}), log: line => logs.push(line)});
  await failing.run(FRAME_INTERVAL_MS);
  failing.state.conversing = true;
  await failing.run(30000);
  assert.equal(await failing.vision.imagesForTurn({visionTurn: 'c'}), null);
  assert.ok(logs.some(line => /turn \w+: no frame yet/.test(line)));
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
  assert.ok(logs.some(line => /no fresh frame \(newest 5\d s old, limit 15 s\)/.test(line)));
});

test('a slow capture does not hold a turn at all: no sleep, no timer, the turn goes out while the capture is still running', async () => {
  let release;
  const capture = fakeCapture();
  const slow = {...capture, get running() { return capture.running; }, start: capture.start, stop: capture.stop,
    capture: () => new Promise(done => { release = () => done({ok: true, mime: 'image/jpeg', base64: shotOf(7), width: 1, height: 1, bytes: 1, ms: {}}); })};
  let waited = 0;
  const vision = new CompanionVision({capture: slow, now: () => 1000, env: {}, sleep: ms => { waited = ms; return new Promise(done => setImmediate(done)); }});
  vision.update({companionVision: true});
  const images = await vision.imagesForTurn({visionTurn: 'x'});
  assert.equal(images, null);
  assert.equal(waited, 0, 'nothing slept for a picture');
  assert.ok(vision.turnCapture, 'the capture is still running, started for the next turn');
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

test('a long typed line: a frame staged more than 15 s ago is not sent; the turn goes out at once and a capture starts for the next one', async () => {
  const {vision, state, run, capture} = scene({stagePage: async () => ({staged: true})});
  await run(FRAME_INTERVAL_MS * 2);
  state.conversing = true;
  vision.openComposer([{characterId: 'alex'}]);
  for (let i = 0; i < 4; i++) await new Promise(done => setImmediate(done));
  const stagedShot = vision.stagedFrame.base64;
  await run(20000);   // V types for 20 s
  const calls = capture.calls;
  const images = await vision.imagesForTurn({visionTurn: 'slow-typist'});
  assert.equal(images, null, 'not the staged picture, which is past the limit, and no wait for a new one');
  await new Promise(done => setImmediate(done));
  assert.equal(capture.calls, calls + 1, 'a capture was started in the background');
  const next = await vision.imagesForTurn({visionTurn: 'next-line'});
  assert.notEqual(next[0].base64, stagedShot, 'the next turn has the new picture');
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
  assert.equal(replaced, null, 'the finish does not wait for a new picture');
  assert.ok(logs.some(line => /the frame staged while talking was 2\d s old/.test(line)));
  await new Promise(done => setImmediate(done));
  assert.equal(capture.calls, stale + 1, 'a capture started in the background for the next turn');
  assert.equal(vision.frame().base64, shotOf(capture.calls));
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

test('a game that is not in front (covered) is not a failure: no frame, one log line, counted apart', async () => {
  const logs = [];
  const {vision, run} = scene({capture: fakeCapture({fail: 'covered'}), log: line => logs.push(line)});
  await run(FRAME_INTERVAL_MS * 3);
  assert.equal(await vision.imagesForTurn({visionTurn: 't'}), null);
  const counts = vision.diagnostics();
  assert.ok(counts.covered >= 3 && counts.failed === 0, JSON.stringify(counts));
  assert.equal(logs.filter(line => /no picture .*covered/.test(line)).length, 1, 'said once');
});

test('the yellow border (Discord 2026-10-23): a capture that shows it stops the timer, pictures are taken only when a turn needs one, and the player is told once', async () => {
  const logs = [];
  const {vision, capture, run, state} = scene({capture: fakeCapture({border: true}), log: line => logs.push(line)});
  await run(FRAME_INTERVAL_MS * 10);
  assert.equal(capture.calls, 1, 'one picture showed the border; no capture ran on the timer after it');
  assert.equal(capture.running, false, 'the helper is released: nothing runs between turns');
  assert.equal(vision.capturing, false);
  assert.equal(vision.diagnostics().borderShown, true);
  assert.equal(logs.filter(line => /capture border/.test(line)).length, 1);
  // The notice is given once, with the next reply.
  assert.equal(vision.takeBorderNotice(), true);
  assert.equal(vision.takeBorderNotice(), false);
  // A turn still gets a picture: one capture when it starts (the composer opens), and no more than that.
  const before = capture.calls;
  state.conversing = true;
  vision.openComposer([{characterId: 'c'}]);
  await run(1000);
  assert.equal(capture.calls, before + 1, 'one capture for the turn');
  assert.ok(await vision.imagesForTurn({visionTurn: 'turn-1'}));
  assert.equal(capture.calls, before + 1, 'the turn reuses that picture');
  assert.equal(vision.takeBorderNotice(), false, 'still said once');
  // Long after the conversation, with someone near, nothing is captured on a timer.
  state.conversing = false;
  const after = capture.calls;
  await run(TAIL_MS + FRAME_INTERVAL_MS * 10);
  assert.equal(capture.calls, after);
});

test('a border-free capture keeps the buffer on its timer and never asks the player anything', async () => {
  const {vision, capture, run} = scene({capture: fakeCapture({border: false})});
  await run(FRAME_INTERVAL_MS * 6);
  assert.ok(capture.calls >= 6);
  assert.equal(vision.takeBorderNotice(), false);
  assert.equal(vision.diagnostics().borderShown, false);
  assert.equal(vision.diagnostics().captureMethod, null, 'the fake client reports no method of its own');
});

test('the border notice is not taken while another provider answers', async () => {
  const {vision, run, state} = scene({capture: fakeCapture({border: true})});
  await run(FRAME_INTERVAL_MS * 2);
  state.convai = false;
  assert.equal(vision.takeBorderNotice(), false);
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
function fakeChild(script, ready = '{"ready":true}') {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.lines = [];
  child.stdin = {on() {}, write(line) { child.lines.push(line); const reply = script(line); if (reply !== undefined) setImmediate(() => child.stdout.emit('data', reply + '\n')); },
    end(line) { child.lines.push(line); setImmediate(() => child.emit('exit', 0)); }};
  child.kill = () => child.emit('exit', 1);
  setImmediate(() => child.stdout.emit('data', ready + '\n'));
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
  assert.deepEqual(child.lines, ['capture 2048 88 auto\n'], 'width is clamped; quality falls back to the default (1024 px, quality 88 when nothing is asked)');
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

test('unload rule for memory: no picture is held while another provider answers, and the pictures of turns that are over are let go (the ids stay)', async () => {
  const {vision, state, run, tick} = scene();
  await run(FRAME_INTERVAL_MS * 3);
  assert.ok(vision.frames.length > 0);
  // A typed turn on Convai answers with the buffered picture, and the turn's picture is remembered for a retry.
  const config = {characterId: 'judy', visionTurn: 'request-0000000a'};
  const first = await vision.imagesForTurn(config);
  assert.ok(first?.length === 1);
  assert.deepEqual(await vision.imagesForTurn(config), first, 'a retry of the turn sends the same picture');
  vision.attachToNextTurn(pictureOf(QUEUED));
  assert.equal(vision.queue.length, 1);
  vision.beginVoice('voice-0000000b');
  await new Promise(done => setImmediate(done));
  const voice = vision.voice.get('voice-0000000b');
  assert.ok(voice.frame && voice.images, 'the recording holds its staged frame');
  // The turn's picture is let go once no retry can come, and the id stays.
  state.now += 91_000; await tick({});
  assert.equal(vision.answered.has('request-0000000a'), true);
  assert.equal(vision.answered.get('request-0000000a'), null, 'the picture of an answered turn is dropped after the retry window');
  assert.ok(voice.frame && voice.images, 'a recording keeps its frame for longer');
  // Another provider answers: nothing at all is held.
  state.convai = false; await tick({});
  assert.equal(vision.frames.length, 0); assert.equal(vision.queue.length, 0); assert.equal(vision.stagedFrame, null);
  assert.equal(voice.frame, null); assert.equal(voice.images, null);
  assert.equal(vision.voice.has('voice-0000000b'), true, 'its id stays');
  assert.equal(vision.answeredAt.size, 0);
  // And it comes back when Convai answers again, with nothing left over.
  state.convai = true; await run(FRAME_INTERVAL_MS * 2);
  assert.ok(vision.frames.length > 0);
  assert.equal(vision.answered.get('request-0000000a'), null);
});

test('answered turns keep at most TURN_MEMORY ids and their picture times follow them out', async () => {
  const {vision, run} = scene();
  await run(FRAME_INTERVAL_MS * 2);
  for (let index = 0; index < 50; index++) await vision.imagesForTurn({characterId: 'judy', visionTurn: 'turn-' + String(index).padStart(8, '0')});
  assert.ok(vision.answered.size <= 32 && vision.answeredAt.size <= 32, `${vision.answered.size} ids, ${vision.answeredAt.size} times`);
});

test('the helper client tells a capture that shows the Windows border from one that does not, and keeps what the helper said about itself', async () => {
  let border = false;
  const reply = () => JSON.stringify({ok: true, width: 768, height: 432, sourceWidth: 1366, sourceHeight: 768, bytes: 3, method: border ? 'wgc' : 'dxgi', border, ms: {total: 30}, jpeg: QUEUED});
  const capture = new VisionCapture({candidates: ['C:\\helper.exe'], exists: () => true,
    spawnHelper: () => fakeChild(reply, '{"ready":true,"build":26200,"wgc":true,"borderless":false}')});
  assert.equal(capture.borderShown, false, 'not known before the first picture');
  let shot = await capture.capture();
  assert.deepEqual([shot.method, shot.border, capture.borderShown], ['dxgi', false, false]);
  assert.deepEqual(capture.info, {build: 26200, wgc: true, borderless: false});
  border = true;
  shot = await capture.capture();
  assert.deepEqual([shot.method, shot.border, capture.borderShown], ['wgc', true, true]);
  // A failure (the game is covered) leaves what the last picture showed as it was.
  capture.stop();
  const covered = new VisionCapture({candidates: ['C:\\helper.exe'], exists: () => true, spawnHelper: () => fakeChild(() => '{"ok":false,"reason":"covered","ms":{"total":1}}')});
  const none = await covered.capture();
  assert.deepEqual([none.ok, none.reason, covered.borderShown], [false, 'covered', false]);
  assert.equal(normalise({ok: false, reason: 'dxgi-unavailable'}).reason, 'dxgi-unavailable');
  covered.stop();
  // A helper from before the border fields (nothing in the picture, nothing in its ready line) is not taken for one that shows it.
  const old = new VisionCapture({candidates: ['C:\\helper.exe'], exists: () => true,
    spawnHelper: () => fakeChild(() => JSON.stringify({ok: true, width: 768, height: 432, sourceWidth: 1366, sourceHeight: 768, bytes: 3, ms: {total: 30}, jpeg: QUEUED}))});
  const oldShot = await old.capture();
  assert.deepEqual([oldShot.ok, oldShot.border, old.borderShown, old.info], [true, undefined, false, null]);
  old.stop();
});

// ---- a group's next speaker (no composer): the picture is staged on its page while the speaker before is written and heard ---------------------------------------------
const settleSome = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(done => setImmediate(done)); };
const dax = {characterId: 'dax', scope: 'group:dax,judy'}, rex = {characterId: 'rex', scope: 'group:dax,judy'};

test('group next speaker: a young frame is staged on the next pages with no capture, and their turn sends that very frame, once', async () => {
  const calls = [];
  const logs = [];
  const {vision, state, run, capture} = scene({stagePage: async (config, images) => { calls.push([config.characterId, images[0].base64]); return {staged: true}; }, log: line => logs.push(line)});
  await run(FRAME_INTERVAL_MS * 3);
  state.conversing = true;
  const before = capture.calls;
  assert.equal(vision.stageForNext([dax, rex]), true);
  await settleSome();
  assert.equal(capture.calls, before, 'a frame under FRESH_FRAME_AGE_MS is used as it is');
  assert.deepEqual(calls.map(call => call[0]).sort(), ['dax', 'rex']);
  assert.equal(calls[0][1], calls[1][1], 'the same frame on every page');
  assert.equal(vision.diagnostics().nextStaged, 2);
  state.now += 4000;   // the speaker before is heard for a few seconds
  const images = await vision.imagesForTurn({visionTurn: 'turn-dax-0001', characterId: 'dax', scope: 'group:dax,judy'});
  assert.deepEqual(images, pictureOf(calls[0][1]), 'the page already holds this frame: the turn sends the same one');
  assert.equal(capture.calls, before, 'the turn took no capture');
  assert.match(logs.at(-1), /1 image\(s\), frame \d+ s old, on its page 4 s ahead/);
  await vision.imagesForTurn({visionTurn: 'turn-dax-0002', characterId: 'dax', scope: 'group:dax,judy'});
  assert.doesNotMatch(logs.at(-1), /on its page/, 'the staged frame is taken once: a later turn is not told it has a lead');
});

test('group next speaker: with no young frame one picture is taken, then reused by the speaker after (one capture per round, not per speaker)', async () => {
  const staged = [];
  const {vision, state, run, capture} = scene({stagePage: async (config, images) => { staged.push([config.characterId, images[0].base64]); return {staged: true}; }});
  await run(FRAME_INTERVAL_MS * 2);
  state.conversing = true;
  await run(40000);   // the buffer is gone
  assert.equal(vision.frames.length, 0);
  const before = capture.calls;
  vision.stageForNext([dax, rex]);
  await settleSome();
  assert.equal(capture.calls, before + 1, 'one capture');
  assert.deepEqual(staged.map(item => item[1]), [shotOf(capture.calls), shotOf(capture.calls)]);
  // The second speaker's turn begins 3 s later: it stages the third, from the same frame.
  state.now += 3000;
  vision.stageForNext([rex]);
  await settleSome();
  assert.equal(capture.calls, before + 1, 'the frame is still young: no second capture');
  assert.equal(vision.diagnostics().nextCaptures, 1);
});

test('group next speaker: staging is retried while the next page connects, and never makes the calling turn wait', async () => {
  let connected = false, tries = 0;
  const {vision, state, run} = scene({stagePage: async () => { tries++; return connected ? {staged: true} : {staged: false, reason: 'no-page'}; }});
  await run(FRAME_INTERVAL_MS * 3);
  state.conversing = true;
  assert.equal(vision.stageForNext([dax]), true, 'returns at once, not a promise');
  await settleSome(3);
  connected = true;
  await settleSome(8);
  assert.ok(tries >= 2);
  assert.equal(vision.diagnostics().nextStaged, 1);
  // A page that never answers (hung browser) holds nothing up: the turn still gets its picture from memory.
  const hung = scene({stagePage: () => new Promise(() => {})});
  await hung.run(FRAME_INTERVAL_MS * 3);
  hung.state.conversing = true;
  hung.vision.stageForNext([dax]);
  const images = await hung.vision.imagesForTurn({visionTurn: 'turn-hung', characterId: 'dax', scope: 'group:dax,judy'});
  assert.equal(images.length, 1);
});

test('group next speaker: the turn sends the frame its page holds even when a newer one was taken, so nothing is republished', async () => {
  const staged = [];
  const {vision, state, run} = scene({stagePage: async (config, images) => { staged.push(images[0].base64); return {staged: true}; }});
  await run(FRAME_INTERVAL_MS * 3);
  state.conversing = true;
  vision.stageForNext([dax]);
  await settleSome();
  const stagedShot = staged[0];
  state.now += 7000;   // the buffered frame is no longer the one a turn prefers
  await vision.captureForTurn('other');   // a newer frame is in memory now
  assert.notEqual(vision.frame().base64, stagedShot);
  const images = await vision.imagesForTurn({visionTurn: 'turn-dax', characterId: 'dax', scope: 'group:dax,judy'});
  assert.equal(images[0].base64, stagedShot, 'the page already holds the staged frame; a newer one would be published too late');
});

test('group typed round: the composer frame is remembered per page, taken once, and a frame past the limit is not sent', async () => {
  const {vision, state, run} = scene({stagePage: async () => ({staged: true})});
  await run(FRAME_INTERVAL_MS * 3);
  state.conversing = true;
  vision.openComposer([dax, rex]);
  await settleSome();
  const frame = vision.stagedFrame;
  assert.equal(vision.pageFrames.size, 2);
  const first = await vision.imagesForTurn({visionTurn: 'turn-1', characterId: 'dax', scope: 'group:dax,judy'});
  assert.equal(first[0].base64, frame.base64);
  assert.equal(vision.pageFrames.size, 1, 'taken by the turn that page served');
  state.now += MAX_FRAME_AGE_MS + 1000;
  const late = await vision.imagesForTurn({visionTurn: 'turn-2', characterId: 'rex', scope: 'group:dax,judy'});
  assert.notEqual(late?.[0]?.base64, frame.base64, 'a frame past MAX_FRAME_AGE_MS is not sent, whatever page holds it');
  vision.closeComposer();
  assert.equal(vision.pageFrames.size, 0);
});

test('group next speaker: a covered game, another provider or no pages stage nothing, and a turn without a picture still goes', async () => {
  const calls = [];
  const covered = scene({capture: fakeCapture({fail: 'covered'}), stagePage: async config => { calls.push(config.characterId); return {staged: true}; }});
  covered.state.conversing = true;
  assert.equal(covered.vision.stageForNext([dax]), true);
  await settleSome();
  assert.deepEqual(calls, [], 'menus, the phone and scenes: no picture, so nothing staged');
  assert.equal(await covered.vision.imagesForTurn({visionTurn: 'turn-covered', characterId: 'dax', scope: 'group:dax,judy'}), null);
  const other = scene({stagePage: async config => { calls.push(config.characterId); return {staged: true}; }});
  other.state.convai = false;
  assert.equal(other.vision.stageForNext([dax]), false, 'Mistral and Local AI get no picture');
  assert.equal(scene().vision.stageForNext([]), false);
  assert.equal(scene().vision.stageForNext(undefined), false);
  assert.deepEqual(calls, []);
});

test('group next speaker: a cancelled round withdraws the staged pictures', async () => {
  const log = [];
  const {vision, state, run} = scene({stagePage: async config => { log.push(['stage', config.characterId]); return {staged: true}; }, unstagePage: async config => log.push(['unstage', config.characterId])});
  await run(FRAME_INTERVAL_MS * 3);
  state.conversing = true;
  vision.stageForNext([dax]);
  await settleSome();
  vision.closeComposer();
  await settleSome();
  assert.deepEqual(log, [['stage', 'dax'], ['unstage', 'dax']]);
  assert.equal(vision.pageFrames.size, 0);
});

test('talk key: a picture that could not be staged on the recording still goes with the finish (no wait), and a stale one is replaced', async () => {
  const logs = [];
  const {vision, run, state, capture} = scene({stageVoice: async () => ({staged: false, reason: 'no-recording'}), log: line => logs.push(line)});
  await run(FRAME_INTERVAL_MS * 3);
  state.conversing = true;
  vision.beginVoice('mic-late');
  await vision.voice.get('mic-late').done;
  assert.equal(vision.voice.get('mic-late').staged, false);
  const images = await vision.imagesForTurn({visionTurn: 'mic-late'}, {phase: 'finish'});
  assert.equal(images.length, 1, 'before, a recording that did not take the picture went without one');
  assert.match(logs.at(-1), /not staged on the recording, sent with the turn/);
  assert.equal(vision.diagnostics().unstagedSent, 1);
  vision.beginVoice('mic-old');
  await vision.voice.get('mic-old').done;
  await run(20000);
  const calls = capture.calls;
  const replaced = await vision.imagesForTurn({visionTurn: 'mic-old'}, {phase: 'finish'});
  assert.equal(replaced, null, 'a picture past the limit is not sent and the finish does not wait for another');
  assert.ok(logs.some(line => /the frame staged while talking was 2\d s old/.test(line)));
  await new Promise(done => setImmediate(done));
  assert.equal(capture.calls, calls + 1, 'a capture started in the background');
});

test('a recording whose frame is still being taken at the finish does not wait for it', async () => {
  let release;
  const capture = fakeCapture();
  const slow = {...capture, get running() { return capture.running; }, start: capture.start, stop: capture.stop,
    capture: () => new Promise(done => { release = () => done({ok: true, mime: 'image/jpeg', base64: shotOf(9), width: 1, height: 1, bytes: 1, ms: {}}); })};
  let waited = 0;
  const vision = new CompanionVision({capture: slow, now: () => 1000, env: {}, sleep: ms => { waited = ms; return new Promise(done => setImmediate(done)); }});
  vision.update({companionVision: true});
  vision.beginVoice('mic-quick');
  await new Promise(done => setImmediate(done));
  assert.equal(await vision.imagesForTurn({visionTurn: 'mic-quick'}, {phase: 'finish'}), null);
  assert.equal(waited, 0);
  release();
});

// ---- the text providers (Mistral, Local AI, Custom): same setting, no pages, the picture rides with the request ----------------------------------------------------------------

test('text providers: the picture is 768 px at quality 80, Convai keeps 1024 at 88 (the helper default), and a change of provider drops pictures taken for the other', async () => {
  const {vision, capture, state, run} = scene();
  await run(FRAME_INTERVAL_MS * 2);
  assert.equal(capture.options, undefined, 'Convai: the helper default (1024 px, quality 88)');
  assert.ok(vision.frames.length > 0);
  state.convai = false; state.sees = true;
  await run(500);
  assert.equal(vision.frames.length <= 1, true, 'the pictures taken at the old size are gone');
  await run(FRAME_INTERVAL_MS * 2);
  assert.deepEqual(capture.options, {maxWidth: 768, quality: 80}, 'a text provider: 768 px, quality 80');
  assert.equal(vision.diagnostics().provider, 'mistral');
  assert.equal(vision.diagnostics().paged, false);
});

test('text providers: the composer picks the frame while V types and publishes nothing, the voice key does the same, nothing is staged on pages', async () => {
  const staged = [];
  const {vision, capture, state, run} = scene({stagePage: async (config, images) => { staged.push(config.characterId); return {staged: true}; },
    stageVoice: async () => { staged.push('voice'); return {staged: true}; }});
  state.convai = false; state.sees = true;
  await run(FRAME_INTERVAL_MS * 2);
  // A composer opens: no configs are needed (there are no pages), the newest young frame is the turn's picture.
  assert.equal(vision.openComposer([]), true);
  await new Promise(done => setImmediate(done));
  assert.ok(vision.stagedYoung(), 'the frame is chosen');
  const images = await vision.imagesForTurn({visionTurn: 'text-1', characterId: 'judy'});
  assert.equal(images.length, 1);
  assert.equal(images[0].mime, 'image/jpeg');
  // The same turn asked again (a retry, or the reply that broke character and is written again) gets the same picture.
  assert.deepEqual(await vision.imagesForTurn({visionTurn: 'text-1', characterId: 'judy'}), images);
  // The talk key: a frame is taken or reused and kept for the turn; the recording is not asked to hold it.
  assert.equal(vision.beginVoice('voice-1'), true);
  await vision.voice.get('voice-1').done;
  const voiced = await vision.imagesForTurn({visionTurn: 'voice-1', characterId: 'judy'}, {phase: 'reply'});
  assert.equal(voiced.length, 1);
  assert.equal(vision.stageForNext([{characterId: 'dax'}]), false, 'no next-speaker staging without pages');
  assert.deepEqual(staged, [], 'nothing was published anywhere');
  assert.ok(capture.calls >= 1);
});

test('text providers: a provider that cannot see captures nothing and starts no helper, and the player is told once per case', async () => {
  const blocked = {code: 'vision-local-no-model', key: 'local:Gemma 4 E4B:no-projector', why: 'Gemma 4 E4B cannot see (it has no vision projector)'};
  const state = {blocker: blocked};
  const {vision, capture, state: scenery, run} = scene({blocker: () => state.blocker});
  scenery.convai = false; scenery.sees = false;
  await run(FRAME_INTERVAL_MS * 3);
  assert.equal(capture.calls, 0, 'nothing is captured for a model that cannot see');
  assert.equal(capture.started, 0);
  assert.equal(vision.takeSightNotice(), 'vision-local-no-model');
  assert.equal(vision.takeSightNotice(), null, 'said once');
  await run(2000);
  assert.equal(vision.takeSightNotice(), null, 'the same cause is not said again');
  state.blocker = {...blocked, key: 'local:Bonsai 2 4B:no-projector'};
  await run(1000);
  assert.equal(vision.takeSightNotice(), 'vision-local-no-model', 'another model is a new case');
  // With the setting off nobody is told anything.
  state.blocker = {...blocked, key: 'local:Other:no-room'};
  await run(1000, {companionVision: false});
  assert.equal(vision.takeSightNotice(), null);
});

test('text providers: an endpoint that refused a picture is told once, and the Custom case only', async () => {
  const {vision, state, run} = scene();
  state.convai = false; state.sees = true;
  await run(500);
  vision.noteRefused('mistral');
  assert.equal(vision.takeSightNotice(), null, 'Mistral and Local AI refusals are a log line, not a notice');
  vision.noteRefused('custom');
  assert.equal(vision.takeSightNotice(), 'vision-custom-no-images');
  vision.noteRefused('custom');
  assert.equal(vision.takeSightNotice(), null, 'once');
});
