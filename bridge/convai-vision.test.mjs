import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ConvaiVision, VISION_INPUT_CONFIG, visionConnectOptions, visionIdentity, validImages, layout, readAck,
  MAX_IMAGES, VISION_NOTE, VISION_NOTE_TV, TV_VISION_INPUT_CONFIG, gammaFor, meanLuma, applyGamma, MIN_GAMMA, TARGET_MEAN} from './convai-vision.mjs';

// The SDK's own serializer (the installed @convai/web-sdk, read only): its dist uses bundler-style imports, so the one
// dependency-free file is loaded directly.
const sdk = dirname(createRequire(import.meta.url).resolve('@convai/web-sdk/package.json'));
const {serializeVisionInputConfig, resolveVisionInputConfig} = await import(pathToFileURL(join(sdk, 'dist/core/visionRequest.js')).href);

const JPEG =Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const image = (mime = 'image/jpeg', base64 = JPEG) => ({mime, base64});

// The connect request the SDK builds from our options (@convai/web-sdk 1.7.0 core/visionRequest.js, ConvaiClient.connect).
test('a vision session connects with video and the documented vision_input_config, within the documented ranges', () => {
  assert.deepEqual(visionConnectOptions({}), {});
  assert.deepEqual(visionConnectOptions({vision: 'yes'}), {});
  const options = visionConnectOptions({vision: true});
  assert.equal(options.enableVideo, true);
  assert.equal(options.startWithVideoOn, false, 'no camera, ever');
  const wire = serializeVisionInputConfig(resolveVisionInputConfig(options));
  assert.deepEqual(wire, {enabled: true, sample_interval_secs: 0.25, frames_per_turn: 1, buffer_frames: 2,
    staleness_seconds: 6, max_resolution: 1024, replace_previous_vision_context: true});
  // Ranges from Convai's "Dynamic vision context" page.
  assert.ok(wire.sample_interval_secs >= 0.1 && wire.sample_interval_secs <= 60);
  assert.ok(wire.frames_per_turn >= 1 && wire.frames_per_turn <= 20);
  assert.ok(wire.buffer_frames >= wire.frames_per_turn && wire.buffer_frames <= 120);
  assert.ok(wire.staleness_seconds >= 0.1 && wire.staleness_seconds <= 120);
  assert.ok(wire.max_resolution >= 64 && wire.max_resolution <= 2048);
  assert.ok(Object.isFrozen(VISION_INPUT_CONFIG));
});

test('a page connected without video is not reused for a vision turn, and back', () => {
  assert.equal(visionIdentity('k', {}), 'k');
  assert.equal(visionIdentity('k', {vision: true}), 'k|vision');
  assert.notEqual(visionIdentity('k', {}), visionIdentity('k', {vision: true}));
});

test('only well-formed images of an allowed type and size are accepted, at most four', () => {
  assert.deepEqual(validImages(null), []);
  assert.deepEqual(validImages([image('image/gif'), image('image/jpeg', 'not base64!'), image('image/jpeg', ''), {mime: 'image/png'}]), []);
  assert.deepEqual(validImages([image('image/png'), image('image/webp')]).map(i => i.mime), ['image/png', 'image/webp']);
  assert.equal(validImages(Array.from({length: 6}, () => image())).length, MAX_IMAGES);
  const huge = 'A'.repeat(4 * 1024 * 1024 / 3 * 4 + 8);
  assert.deepEqual(validImages([image('image/jpeg', huge)]), []);
  // Extra fields from a caller never reach the page.
  assert.deepEqual(validImages([{...image(), label: 'x', url: 'https://example.invalid'}]), [image()]);
});

test('one to four images always make one picture: full, side by side, or a 2x2 grid', () => {
  assert.deepEqual(layout(1), {columns: 1, rows: 1, cell: 1024});
  assert.deepEqual(layout(2), {columns: 2, rows: 1, cell: 512});
  assert.deepEqual(layout(3), {columns: 2, rows: 2, cell: 512});
  assert.deepEqual(layout(4), {columns: 2, rows: 2, cell: 512});
});

test('server acknowledgements are read from either nesting', () => {
  assert.deepEqual(readAck({event_type: 'vision-status', status: 'success', extras: {update_id: 'u1', outcome: 'frames_available',
    vision_buffer: {retained_frames: 1}}}), {eventType: 'vision-status', status: 'success', outcome: 'frames_available',
    retained: 1, updateId: 'u1', imageTokens: null});
  const ack = readAck({event_type: 'vision-status', status: 'error', message: 'vision_not_enabled', extras: null});
  assert.equal(ack.outcome, 'vision_not_enabled');
  assert.equal(readAck({event_type: 'vision-trigger', extras: {vision_image_tokens_est: 258}}).imageTokens, 258);
  assert.equal(readAck({}).eventType, null);
});

function fakeEnv() {
  let now = 0, id = 0;
  const timers = new Map();
  const drawn = [];
  const canvas = () => ({width: 0, height: 0, getContext: () => ({fillStyle: '', fillRect() {}, drawImage: (...args) => drawn.push(args.length)}),
    toBlob: (done, type) => done(new Blob([Buffer.from('jpeg')], {type}))});
  return {drawn, timers,
    advance(ms) { now += ms; for (const [key, timer] of [...timers]) if (timer.due <= now) { timers.delete(key); if (timer.every) timers.set(key, {...timer, due: now + timer.every}); timer.fn(); } },
    env: {document: {createElement: tag => { assert.equal(tag, 'canvas'); return canvas(); }},
      createImageBitmap: async () => ({width: 1366, height: 768, close() {}}),
      setTimeout: (fn, ms) => { timers.set(++id, {fn, due: now + ms}); return id; }, clearTimeout: key => timers.delete(key),
      setInterval: (fn, ms) => { timers.set(++id, {fn, due: now + ms, every: ms}); return id; }, clearInterval: key => timers.delete(key),
      now: () => now}};
}

function fakeConnection({video = true, ack} = {}) {
  const handlers = new Map(), calls = [];
  let statusCount = 0;
  const connection = {connectionType: video ? 'video' : 'audio', calls,
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
    emit(response) { handlers.get('serverResponse')?.(response); },
    videoControls: {publishCanvas: async (canvas, options) => {
      calls.push(['publish', options]);
      return {unpublish: async () => { calls.push(['unpublish']); }};
    }},
    visionStatus() {
      const id = 'status-' + ++statusCount;
      calls.push(['status', id]);
      queueMicrotask(() => ack && connection.emit(ack(id, statusCount)));
      return id;
    },
    uploadFile: async (file, options) => { calls.push(['upload', file.name, file.type, options]); }};
  return connection;
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a staged picture is published as a canvas track on the silent lane and ready once the server buffers a frame', async () => {
  const {env, advance, timers} = fakeEnv();
  const connection = fakeConnection({ack: (id, n) => ({event_type: 'vision-status', status: 'success',
    extras: {update_id: id, vision_buffer: {retained_frames: n >= 2 ? 1 : 0}, outcome: n >= 2 ? 'frames_available' : 'buffer_empty'}})});
  const vision = new ConvaiVision(connection, {env});
  assert.deepEqual(await vision.stage([image()]), {staged: true});
  const ready = vision.ready(900);
  for (let i = 0; i < 10; i++) { await settle(); advance(100); }
  const result = await ready;
  assert.equal(result.attached, true);
  assert.equal(result.outcome, 'frames_available');
  assert.deepEqual(connection.calls[0], ['publish', {source: 'canvas', name: 'game-view', fps: 5, stopTrackOnUnpublish: true}]);
  assert.ok(connection.calls.filter(call => call[0] === 'status').length >= 2);
  assert.ok([...timers.values()].some(timer => timer.every), 'the picture is repainted while it is staged');
  await vision.retire();
  assert.deepEqual(connection.calls.at(-1), ['unpublish']);
  assert.ok(![...timers.values()].some(timer => timer.every), 'the repaint stops with the turn');
  assert.equal(vision.diagnostics().attached, 1);
});

test('vision_not_enabled is remembered: later turns of that session do not publish again', async () => {
  const {env, advance} = fakeEnv();
  const connection = fakeConnection({ack: id => ({event_type: 'vision-status', status: 'error', message: 'vision_not_enabled', extras: {update_id: id}})});
  const vision = new ConvaiVision(connection, {env});
  await vision.stage([image()]);
  const ready = vision.ready(900);
  for (let i = 0; i < 4; i++) { await settle(); advance(100); }
  assert.deepEqual(await ready.then(r => [r.attached, r.outcome]), [false, 'vision_not_enabled']);
  assert.deepEqual(await vision.stage([image()]), {staged: false, reason: 'vision-not-enabled'});
  assert.equal(connection.calls.filter(call => call[0] === 'publish').length, 1);
});

test('without an acknowledgement the turn waits no longer than its deadline', async () => {
  const {env, advance} = fakeEnv();
  const vision = new ConvaiVision(fakeConnection(), {env});
  await vision.stage([image()]);
  const ready = vision.ready(900);
  for (let i = 0; i < 12; i++) { await settle(); advance(100); }
  const result = await ready;
  assert.equal(result.attached, false);
  assert.ok(result.ms <= 1000, `waited ${result.ms} ms`);
});

test('an audio-only session, a bad image or nothing staged never publishes', async () => {
  const {env} = fakeEnv();
  const audio = fakeConnection({video: false});
  assert.deepEqual(await new ConvaiVision(audio, {env}).stage([image()]), {staged: false, reason: 'no-video-session'});
  const video = fakeConnection();
  const vision = new ConvaiVision(video, {env});
  assert.deepEqual(await vision.stage([image('image/gif')]), {staged: false, reason: 'no-valid-image'});
  assert.deepEqual(await vision.ready(100), {attached: false, outcome: 'nothing-staged', ms: 0, waitedMs: 0});
  assert.equal(audio.calls.length + video.calls.length, 0);
});

test('the upload transport sends one composed JPEG through uploadFile', async () => {
  const {env} = fakeEnv();
  const connection = fakeConnection({video: false});
  const vision = new ConvaiVision(connection, {env, transport: 'upload'});
  assert.deepEqual(await vision.stage([image(), image('image/png')]), {staged: true});
  const result = await vision.ready(900);
  assert.equal(result.attached, true);
  assert.deepEqual(connection.calls, [['upload', 'game-view.jpg', 'image/jpeg', undefined]]);
});

test('a newer picture replaces the staged one (its track is withdrawn first)', async () => {
  const {env} = fakeEnv();
  const connection = fakeConnection();
  const vision = new ConvaiVision(connection, {env});
  await vision.stage([image()]);
  await settle();
  await vision.stage([image('image/png')]);
  await settle();
  assert.deepEqual(connection.calls.map(call => call[0]), ['publish', 'unpublish', 'publish']);
});

test('a picture staged ahead is reused by its turn (no second publish) and the turn waits for nothing once it is buffered', async () => {
  const {env, advance} = fakeEnv();
  const connection = fakeConnection({ack: id => ({event_type: 'vision-status', status: 'success',
    extras: {update_id: id, vision_buffer: {retained_frames: 1}, outcome: 'frames_available'}})});
  const vision = new ConvaiVision(connection, {env});
  assert.deepEqual(await vision.stage([image()], {ttlMs: 60000}), {staged: true});
  const ahead = vision.ready(5000);
  for (let i = 0; i < 4; i++) { await settle(); advance(100); }
  assert.equal((await ahead).attached, true, 'buffered while V typed');
  assert.deepEqual(await vision.stage([image()]), {staged: true, reused: true});
  const turn = await vision.ready(350);
  assert.equal(turn.attached, true);
  assert.equal(turn.waitedMs, 0);
  assert.equal(connection.calls.filter(call => call[0] === 'publish').length, 1);
  advance(61000);
  assert.ok(vision.staged, 'a claimed picture is not withdrawn by the ahead-of-time expiry');
});

test('a picture staged ahead that no turn takes is withdrawn after its time', async () => {
  const {env, advance} = fakeEnv();
  const connection = fakeConnection();
  const vision = new ConvaiVision(connection, {env});
  await vision.stage([image()], {ttlMs: 60000});
  await settle();
  advance(60001);
  await settle();
  assert.equal(vision.staged, null);
  assert.deepEqual(connection.calls.map(call => call[0]), ['publish', 'unpublish']);
});

test('the context note says the picture shows the surroundings from just before this message and to ignore the interface', () => {
  assert.match(VISION_NOTE, /surroundings/);
  assert.match(VISION_NOTE, /before this message/);
  assert.match(VISION_NOTE, /never the interface/);
  assert.doesNotMatch(VISION_NOTE, /screenshot|key|free|recommended/i);
});

test('indoors or outdoors: the game\'s word when the text gives one, else the picture, never the district\'s name; no picture means say so', () => {
  assert.match(VISION_NOTE, /if the text above says so, that is fact/);
  assert.match(VISION_NOTE, /if it does not, judge it from the image/);
  assert.match(VISION_NOTE, /never from the name of the district/);
  assert.match(VISION_NOTE, /If no image is attached or it does not show what V asks about, say so plainly instead of guessing/);
});

test('a dim picture is lifted with a gamma curve, a normal or black one is left alone', () => {
  const frame = (r, g, b, pixels = 64) => Uint8ClampedArray.from(Array.from({length: pixels}, () => [r, g, b, 255]).flat());
  assert.equal(gammaFor(meanLuma(frame(200, 200, 200))), null, 'a bright frame');
  assert.equal(gammaFor(meanLuma(frame(70, 70, 70))), null, 'at the threshold');
  assert.equal(gammaFor(meanLuma(frame(1, 1, 1))), null, 'a black or loading screen has nothing to lift');
  const dim = frame(55, 55, 55), mean = meanLuma(dim);
  assert.ok(Math.abs(mean - 55) < 1, 'luma of grey is the grey');
  const gamma = gammaFor(mean);
  assert.ok(gamma > MIN_GAMMA && gamma < 1, 'gamma ' + gamma);
  applyGamma(dim, gamma);
  assert.ok(Math.abs(meanLuma(dim) - TARGET_MEAN) < 6, 'lifted to about the target: ' + meanLuma(dim));
  assert.equal(dim[3], 255, 'alpha is untouched');
  // Very dark: the lift is capped, so noise is not blown up.
  assert.equal(gammaFor(6), MIN_GAMMA);
  const white = frame(255, 255, 255); applyGamma(white, 0.6);
  assert.deepEqual([...white.slice(0, 4)], [255, 255, 255, 255], 'highlights (the HUD) stay put');
});

test('a dim game picture is lifted on its canvas; a bright one, a multi-picture canvas and the TV are not touched; no pixel access is harmless', async () => {
  const run = async (grey, {images = 1, width, adjust} = {}) => {
    const puts = [];
    const ctx = {fillStyle: '', fillRect() {}, drawImage() {}, getImageData: (x, y, w, h) => ({data: Uint8ClampedArray.from(Array.from({length: 16}, () => [grey, grey, grey, 255]).flat())}),
      putImageData: (data) => puts.push(data.data[0])};
    const {env} = fakeEnv();
    env.document = {createElement: () => ({width: 0, height: 0, getContext: () => ctx})};
    const vision = new ConvaiVision(fakeConnection().connection, {env});
    await vision.compose(Array.from({length: images}, () => image()), width, adjust === undefined ? undefined : {adjust});
    return {puts, vision};
  };
  const dim = await run(30);
  assert.equal(dim.puts.length, 1);
  assert.ok(dim.puts[0] > 30, 'lifted');
  assert.ok(dim.vision.diagnostics().lastGamma < 1 && dim.vision.diagnostics().lastMean === 30);
  assert.equal((await run(160)).puts.length, 0, 'bright: untouched');
  assert.equal((await run(30, {images: 2})).puts.length, 0, 'two pictures: untouched');
  assert.equal((await run(30, {width: 640, adjust: false})).puts.length, 0, 'the TV: untouched');
  const noPixels = new ConvaiVision(fakeConnection().connection, {env: {...fakeEnv().env, document: {createElement: () => ({width: 0, height: 0,
    getContext: () => ({fillStyle: '', fillRect() {}, drawImage() {}})})}}});
  assert.ok(await noPixels.compose([image()]), 'a canvas without getImageData still composes');
});

// ---- the TV (YouTube on V's TV) -----------------------------------------------------------------------------------------------
test('a page connected for the TV asks for several frames a turn, within the documented ranges, and is a different session', () => {
  const wire = serializeVisionInputConfig(resolveVisionInputConfig(visionConnectOptions({vision: true, visionMode: 'tv'})));
  assert.deepEqual(wire, {enabled: true, sample_interval_secs: 1, frames_per_turn: 5, buffer_frames: 10,
    staleness_seconds: 8, max_resolution: 640, replace_previous_vision_context: true});
  assert.ok(wire.frames_per_turn <= 20 && wire.buffer_frames >= wire.frames_per_turn && wire.buffer_frames <= 120);
  assert.ok(Object.isFrozen(TV_VISION_INPUT_CONFIG));
  assert.equal(visionIdentity('k', {vision: true, visionMode: 'tv'}), 'k|vision-tv');
  assert.notEqual(visionIdentity('k', {vision: true, visionMode: 'tv'}), visionIdentity('k', {vision: true}));
  assert.equal(visionIdentity('k', {visionMode: 'tv'}), 'k', 'no vision, no TV');
  assert.match(VISION_NOTE_TV, /video playing on the TV/);
  assert.match(VISION_NOTE_TV, /never describe/);
  assert.doesNotMatch(VISION_NOTE_TV, /screenshot|key|free|recommended/i);
});

test('the TV frames stay on one live track: published once, repainted with each frame, a turn publishes nothing and waits for nothing', async () => {
  const {env, timers, drawn} = fakeEnv();
  const connection = fakeConnection();
  const vision = new ConvaiVision(connection, {env, mode: 'tv'});
  assert.deepEqual(await vision.liveFrame(image()), {fed: true});
  assert.deepEqual(connection.calls, [['publish', {source: 'canvas', name: 'tv-view', fps: 2, stopTrackOnUnpublish: true}]]);
  assert.ok([...timers.values()].some(timer => timer.every), 'repainted between frames');
  const before = drawn.length;
  assert.deepEqual(await vision.liveFrame(image('image/png')), {fed: true});
  assert.ok(drawn.length > before, 'the new frame is drawn');
  assert.equal(connection.calls.length, 1, 'no second publish');
  assert.deepEqual(await vision.stage([image()]), {staged: true, live: true});
  const ready = await vision.ready(0);
  assert.equal(ready.attached, true); assert.equal(ready.outcome, 'live'); assert.equal(ready.waitedMs, 0);
  await vision.retire();
  assert.equal(connection.calls.length, 1, 'the end of a turn leaves the TV track alone');
  assert.equal(vision.diagnostics().live, true);
  assert.equal(vision.diagnostics().liveFrames, 2);
  assert.deepEqual(await vision.liveFrame(null), {fed: false, reason: 'stopped'});
  assert.deepEqual(connection.calls.at(-1), ['unpublish']);
  assert.ok(![...timers.values()].some(timer => timer.every), 'the repaint stops with the video');
});

test('a page connected for the surroundings, an audio-only page or a refused session takes no TV frame', async () => {
  const {env} = fakeEnv();
  assert.deepEqual(await new ConvaiVision(fakeConnection(), {env}).liveFrame(image()), {fed: false, reason: 'wrong-mode'});
  assert.deepEqual(await new ConvaiVision(fakeConnection({video: false}), {env, mode: 'tv'}).liveFrame(image()), {fed: false, reason: 'no-video-session'});
  const refused = new ConvaiVision(fakeConnection(), {env, mode: 'tv'});
  refused.notEnabled = true;
  assert.deepEqual(await refused.liveFrame(image()), {fed: false, reason: 'vision-not-enabled'});
  assert.deepEqual(await new ConvaiVision(fakeConnection(), {env, mode: 'tv'}).liveFrame(image('image/gif')), {fed: false, reason: 'no-valid-image'});
});
