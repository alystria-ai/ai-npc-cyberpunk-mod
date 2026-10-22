import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ConvaiVision, VISION_INPUT_CONFIG, visionConnectOptions, visionIdentity, validImages, layout, readAck, ackHasFrame,
  visionWaitCap, VISION_READY_MS, MIN_LEAD_MS,
  MAX_IMAGES, VISION_NOTE, gammaFor, meanLuma, applyGamma, MIN_GAMMA, TARGET_MEAN} from './convai-vision.mjs';

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

// The vision-status reply Convai really sent (live 2026-10-23, @convai/web-sdk 1.7.0 serverResponse), field for field.
const REAL_STATUS = {label: 'rtvi-ai', event_type: 'vision-status', status: 'success', message: 'Vision status',
  extras: {vision_buffer: {enabled: false, status: 'vision_not_enabled', first_frame_pts: null, last_frame_pts: null, last_frame_age_ms: null,
    first_frame_index: null, retained_frames: 0, evicted_frames: 0, effective_fps: null, selected_participant: null, source_active: false,
    source_label: null}, vision_status_outcome: 'vision_not_enabled', active_source: null, active_source_label: null,
  update_id: 'vision-status:d6cbaac1-d942-4792-9b7f-610ba427990b', duplicate: false}};

test('server acknowledgements are read from either nesting', () => {
  assert.deepEqual(readAck({event_type: 'vision-status', status: 'success', extras: {update_id: 'u1', outcome: 'frames_available',
    vision_buffer: {retained_frames: 1}}}), {eventType: 'vision-status', status: 'success', outcome: 'frames_available',
    retained: 1, updateId: 'u1', enabled: null, sourceActive: null, imageTokens: null});
  const ack = readAck({event_type: 'vision-status', status: 'error', message: 'vision_not_enabled', extras: null});
  assert.equal(ack.outcome, 'vision_not_enabled');
  assert.equal(readAck({event_type: 'vision-trigger', extras: {vision_image_tokens_est: 258}}).imageTokens, 258);
  assert.equal(readAck({}).eventType, null);
});

test('the real vision-status reply is read: vision_status_outcome, vision_buffer.status, enabled, source_active, retained_frames', () => {
  assert.deepEqual(readAck(REAL_STATUS), {eventType: 'vision-status', status: 'success', outcome: 'vision_not_enabled', retained: 0,
    updateId: 'vision-status:d6cbaac1-d942-4792-9b7f-610ba427990b', enabled: false, sourceActive: false, imageTokens: null});
  // 'Vision status' (the message) is prose, never an outcome; vision_buffer.status stands in when the outcome field is absent.
  const bufferOnly = {...REAL_STATUS, extras: {vision_buffer: {enabled: true, status: 'frames_available', retained_frames: 2, source_active: true}}};
  assert.deepEqual(readAck(bufferOnly), {eventType: 'vision-status', status: 'success', outcome: 'frames_available', retained: 2, updateId: null,
    enabled: true, sourceActive: true, imageTokens: null});
  assert.equal(readAck({event_type: 'vision-status', message: 'Vision status'}).outcome, null);
  // Garbage in the fields never becomes an outcome.
  assert.equal(readAck({event_type: 'vision-status', extras: {vision_status_outcome: 'Not An Outcome!', vision_buffer: {status: 7, enabled: 'yes'}}}).outcome, null);
  assert.equal(readAck({event_type: 'vision-status', extras: {vision_buffer: {enabled: 'yes'}}}).enabled, null);
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

test('a staged picture is published as a canvas track on the silent lane; a turn waits for the publish, never for a status reply', async () => {
  const {env, advance, timers} = fakeEnv();
  const connection = fakeConnection({ack: id => ({...REAL_STATUS, extras: {...REAL_STATUS.extras, update_id: id}})});
  const vision = new ConvaiVision(connection, {env});
  assert.deepEqual(await vision.stage([image()]), {staged: true});
  const ready = vision.ready(900);
  await settle(); advance(1);
  const result = await ready;
  assert.equal(result.published, true);
  assert.equal(result.waitedMs <= 1, true, 'returns as soon as the track is published, not after any polling');
  assert.deepEqual(connection.calls[0], ['publish', {source: 'canvas', name: 'game-view', fps: 5, stopTrackOnUnpublish: true}]);
  assert.equal(connection.calls.filter(call => call[0] === 'status').length, 0, 'the status request is never sent: no turn polls for an acknowledgement');
  assert.ok([...timers.values()].some(timer => timer.every), 'the picture is repainted while it is staged');
  await vision.retire();
  assert.deepEqual(connection.calls.at(-1), ['unpublish']);
  assert.ok(![...timers.values()].some(timer => timer.every), 'the repaint stops with the turn');
});

// Live 2026-10-23: every status reply said vision_not_enabled / enabled:false / source_active:false / 0 retained frames while the
// model described the published picture. So the replies are recorded for diagnostics and never switch vision off.
test('vision_not_enabled is recorded but never gates: the picture is still published, kept and used on every later turn', async () => {
  const {env, advance} = fakeEnv();
  const connection = fakeConnection();
  const vision = new ConvaiVision(connection, {env});
  vision.onServerResponse(REAL_STATUS);
  assert.equal(vision.diagnostics().lastOutcome, 'vision_not_enabled');
  assert.equal(vision.diagnostics().serverEnabled, false);
  assert.equal(vision.diagnostics().serverSourceActive, false);
  assert.equal(vision.diagnostics().serverRetained, 0);
  assert.equal('notEnabled' in vision.diagnostics(), false);
  for (let turn = 0; turn < 3; turn++) {
    assert.deepEqual(await vision.stage([image()]), {staged: true}, 'turn ' + turn);
    const ready = vision.ready(900);
    await settle(); advance(1);
    assert.equal((await ready).published, true);
    vision.onServerResponse(REAL_STATUS);
    await vision.retire();
  }
  assert.equal(connection.calls.filter(call => call[0] === 'publish').length, 3);
  assert.equal(vision.diagnostics().skipped, 0);
  assert.equal(vision.diagnostics().attached, 0, 'a not-enabled reply is not a buffered frame');
});

test('a reply that does report a frame marks the staged picture as buffered; other vision events and other replies are ignored', async () => {
  const {env} = fakeEnv();
  const vision = new ConvaiVision(fakeConnection(), {env});
  vision.onServerResponse({event_type: 'vision-status', extras: {vision_buffer: {retained_frames: 1}}});
  assert.equal(vision.diagnostics().attached, 0, 'nothing staged yet');
  await vision.stage([image()]);
  vision.onServerResponse({event_type: 'context-update', extras: {vision_buffer: {retained_frames: 1}}});
  assert.equal(vision.diagnostics().attached, 0, 'not a vision event');
  vision.onServerResponse({event_type: 'vision-status', extras: {vision_status_outcome: 'frames_available', vision_buffer: {enabled: true, retained_frames: 1}}});
  vision.onServerResponse({event_type: 'vision-status', extras: {vision_status_outcome: 'frames_available', vision_buffer: {enabled: true, retained_frames: 1}}});
  assert.equal(vision.diagnostics().attached, 1, 'counted once');
  assert.equal((await vision.ready(0)).attached, true);
  assert.equal(ackHasFrame(readAck({extras: {vision_status_outcome: 'attached'}})), true);
  assert.equal(ackHasFrame(readAck(REAL_STATUS)), false);
  assert.equal(ackHasFrame(readAck({extras: {vision_buffer: {retained_frames: 0, status: 'buffer_empty'}}})), false);
});

test('the wait decision: no wait by default, the developer cap is 0 to 900 ms, and a pending publish never holds the line past it', async () => {
  assert.equal(VISION_READY_MS, 0);
  assert.equal(visionWaitCap({}), 0);
  assert.equal(visionWaitCap(null), 0);
  assert.equal(visionWaitCap({visionWaitMs: 250}), 250);
  assert.equal(visionWaitCap({visionWaitMs: 5000}), 900);
  assert.equal(visionWaitCap({visionWaitMs: -5}), 0);
  assert.equal(visionWaitCap({visionWaitMs: 'soon'}), 0);
  assert.ok(MIN_LEAD_MS >= 2500, 'a picture needs to be on the session about 3 s before the line for the server to use it');
  // A publish that is slow: with the default cap the turn is released at once and the picture keeps publishing.
  const {env, advance} = fakeEnv();
  let finish;
  const connection = fakeConnection();
  connection.videoControls.publishCanvas = () => new Promise(resolve => { finish = () => resolve({unpublish: async () => { connection.calls.push(['unpublish']); }}); });
  const vision = new ConvaiVision(connection, {env});
  await vision.stage([image()]);
  const none = await vision.ready(env.now() + visionWaitCap({}));
  assert.deepEqual([none.published, none.waitedMs], [false, 0], 'sent at once');
  const capped = vision.ready(env.now() + visionWaitCap({visionWaitMs: 200}));
  advance(200);
  assert.equal((await capped).published, false, 'released at the cap');
  const later = vision.ready(env.now() + 900);
  await settle(); finish(); await settle();
  assert.equal((await later).published, true, 'a publish that finishes inside the cap is reported');
  await vision.retire();
  assert.deepEqual(connection.calls.at(-1), ['unpublish'], 'the late track is withdrawn after the turn');
});

test('a turn is never held by what a server reply says: a never-answering session costs no wait either', async () => {
  const {env, advance} = fakeEnv();
  const vision = new ConvaiVision(fakeConnection(), {env});
  await vision.stage([image()]);
  await settle();
  const started = env.now();
  const ready = vision.ready(env.now() + 900);
  await settle(); advance(0);
  const result = await ready;
  assert.equal(result.published, true);
  assert.equal(result.attached, false);
  assert.equal(env.now() - started, 0, 'no timer was needed');
  assert.ok(result.ms <= 1000, `waited ${result.ms} ms`);
});

test('an audio-only session, a bad image or nothing staged never publishes', async () => {
  const {env} = fakeEnv();
  const audio = fakeConnection({video: false});
  assert.deepEqual(await new ConvaiVision(audio, {env}).stage([image()]), {staged: false, reason: 'no-video-session'});
  const video = fakeConnection();
  const vision = new ConvaiVision(video, {env});
  assert.deepEqual(await vision.stage([image('image/gif')]), {staged: false, reason: 'no-valid-image'});
  assert.deepEqual(await vision.ready(100), {published: false, attached: false, outcome: 'nothing-staged', ms: 0, waitedMs: 0});
  assert.equal(audio.calls.length + video.calls.length, 0);
});

test('the upload transport sends one composed JPEG through uploadFile', async () => {
  const {env} = fakeEnv();
  const connection = fakeConnection({video: false});
  const vision = new ConvaiVision(connection, {env, transport: 'upload'});
  assert.deepEqual(await vision.stage([image(), image('image/png')]), {staged: true});
  const result = await vision.ready(900);
  assert.equal(result.published, true);
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

test('a picture staged ahead is reused by its turn (no second publish) and the turn waits for nothing once it is published', async () => {
  const {env, advance} = fakeEnv();
  const connection = fakeConnection();
  const vision = new ConvaiVision(connection, {env});
  assert.deepEqual(await vision.stage([image()], {ttlMs: 60000}), {staged: true});
  const ahead = vision.ready(5000);
  await settle(); advance(1);
  assert.equal((await ahead).published, true, 'published while V typed');
  assert.deepEqual(await vision.stage([image()]), {staged: true, reused: true});
  const turn = await vision.ready(env.now());
  assert.equal(turn.published, true);
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

test('a dim game picture is lifted on its canvas; a bright one, a multi-picture canvas is not touched; no pixel access is harmless', async () => {
  const run = async (grey, {images = 1} = {}) => {
    const puts = [];
    const ctx = {fillStyle: '', fillRect() {}, drawImage() {}, getImageData: (x, y, w, h) => ({data: Uint8ClampedArray.from(Array.from({length: 16}, () => [grey, grey, grey, 255]).flat())}),
      putImageData: (data) => puts.push(data.data[0])};
    const {env} = fakeEnv();
    env.document = {createElement: () => ({width: 0, height: 0, getContext: () => ctx})};
    const vision = new ConvaiVision(fakeConnection().connection, {env});
    await vision.compose(Array.from({length: images}, () => image()));
    return {puts, vision};
  };
  const dim = await run(30);
  assert.equal(dim.puts.length, 1);
  assert.ok(dim.puts[0] > 30, 'lifted');
  assert.ok(dim.vision.diagnostics().lastGamma < 1 && dim.vision.diagnostics().lastMean === 30);
  assert.equal((await run(160)).puts.length, 0, 'bright: untouched');
  assert.equal((await run(30, {images: 2})).puts.length, 0, 'two pictures: untouched');
  const noPixels = new ConvaiVision(fakeConnection().connection, {env: {...fakeEnv().env, document: {createElement: () => ({width: 0, height: 0,
    getContext: () => ({fillStyle: '', fillRect() {}, drawImage() {}})})}}});
  assert.ok(await noPixels.compose([image()]), 'a canvas without getImageData still composes');
});
