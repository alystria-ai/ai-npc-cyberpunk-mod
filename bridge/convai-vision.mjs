// "Companions can see" inside the hidden browser (docs/COMPANION_VISION.md): hands one picture to the Convai session for the
// next turn. Bundled into runtime/realtime-client.js with the rest of bridge/realtime-client.mjs.
//
// One picture per turn, always: 1 to 4 images (the game view, or frames a caller queued) are composed into one canvas (side
// by side for two, a 2x2 grid for three or four), so the cost and the server's frame selection never depend on how many
// images a caller sent.
//
// Transport 'video' (the default) is Convai's documented dynamic vision context (@convai/web-sdk 1.7, "Vision dynamic context
// beta"): the session connects with enableVideo and a vision_input_config, the canvas is published as a LiveKit video track only
// for this turn, the server samples it into a small buffer and attaches the freshest frame to the next model turn. Vision
// arrives on the silent lane, so a picture never makes the character speak on its own. visionStatus() acknowledgements say
// when a frame is buffered; 'vision_not_enabled' marks the session so later turns do not try again.
// Transport 'upload' is the SDK's uploadFile (LiveKit byte stream, topic 'file-upload'): the composed JPEG is sent once.
// Its server-side behaviour is not documented; it exists for the live check only (settings.json "visionTransport": "upload").

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const COMPOSED_WIDTH = 768;
// Connect-time vision settings. One frame per turn, a 0.25 s sampling interval so a just-published picture is buffered quickly,
// a short staleness window so a picture never rides along into a later turn, and Convai's 768 px resolution cap.
export const VISION_INPUT_CONFIG = Object.freeze({enabled: true, sampleIntervalSecs: 0.25, framesPerTurn: 1, bufferFrames: 2,
  stalenessSeconds: 6, maxResolution: COMPOSED_WIDTH, replacePreviousVisionContext: true});
// The note added to the turn's context when a picture was handed over. The picture is a screenshot of the game, HUD included.
export const VISION_NOTE = ' An image of what V sees right now is attached: the game view, which may include the game\'s HUD, '
  + 'map, subtitles or menus. Use it only if V asks about something visible; describe the scene and people in it in your own '
  + 'words, never the interface, and say so plainly if the image does not show what V asks about.';
const REPAINT_MS = 200;
const STATUS_POLL_MS = 300;

// The ConvaiClient options a vision session connects with (none when vision is off).
export function visionConnectOptions(config) {
  if (config?.vision !== true) return {};
  return {enableVideo: true, startWithVideoOn: false, visionInputConfig: {...VISION_INPUT_CONFIG}};
}

// The session's identity for reuse: a page connected without video must reconnect when vision turns on, and back.
export const visionIdentity = (key, config) => config?.vision === true ? key + '|vision' : key;

// Accepts only well-formed images: {mime, base64[, width, height, label]}. Returns the valid ones (at most MAX_IMAGES).
export function validImages(images) {
  if (!Array.isArray(images)) return [];
  const valid = [];
  for (const image of images) {
    if (valid.length >= MAX_IMAGES) break;
    if (!image || typeof image !== 'object' || !IMAGE_TYPES.has(image.mime) || typeof image.base64 !== 'string') continue;
    if (!image.base64.length || image.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64)) continue;
    if (image.base64.length / 4 * 3 > MAX_IMAGE_BYTES) continue;
    valid.push({mime: image.mime, base64: image.base64});
  }
  return valid;
}

// Where each image goes on the composed canvas: one fills it, two sit side by side, three or four make a 2x2 grid.
export function layout(count, width = COMPOSED_WIDTH) {
  if (count <= 1) return {columns: 1, rows: 1, cell: width};
  if (count === 2) return {columns: 2, rows: 1, cell: width / 2};
  return {columns: 2, rows: 2, cell: width / 2};
}

function decode(base64) {
  const binary = atob(base64), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// The acknowledgement fields this module reads from a server-response (vision-status / vision-trigger), whatever their nesting.
export function readAck(response) {
  const extras = response?.extras && typeof response.extras === 'object' ? response.extras : {};
  const buffer = extras.vision_buffer && typeof extras.vision_buffer === 'object' ? extras.vision_buffer : {};
  const outcome = [extras.outcome, extras.vision_outcome, extras.vision_attach_outcome, response?.message]
    .find(value => typeof value === 'string' && /^[a-z_]{3,40}$/.test(value)) ?? null;
  const retained = Number.isFinite(buffer.retained_frames) ? buffer.retained_frames
    : Number.isFinite(extras.retained_frames) ? extras.retained_frames : null;
  const updateId = typeof extras.update_id === 'string' ? extras.update_id
    : typeof response?.update_id === 'string' ? response.update_id : null;
  return {eventType: typeof response?.event_type === 'string' ? response.event_type : null,
    status: typeof response?.status === 'string' ? response.status : null, outcome, retained, updateId,
    imageTokens: Number.isFinite(extras.vision_image_tokens_est) ? extras.vision_image_tokens_est
      : Number.isFinite(buffer.last_attach?.vision_image_tokens_est) ? buffer.last_attach.vision_image_tokens_est : null};
}

// The browser functions this module uses, bound (a detached setTimeout throws "Illegal invocation"). Tests pass their own.
export const browserEnv = () => ({document: globalThis.document, createImageBitmap: (...args) => globalThis.createImageBitmap(...args),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: id => globalThis.clearTimeout(id),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms), clearInterval: id => globalThis.clearInterval(id),
  now: () => globalThis.performance.now()});

export class ConvaiVision {
  // connection: the ConvaiClient. env: {document, createImageBitmap, setInterval, clearInterval, setTimeout, clearTimeout, now}.
  constructor(connection, {transport = 'video', env = browserEnv()} = {}) {
    this.connection = connection;
    this.transport = transport === 'upload' ? 'upload' : 'video';
    this.env = env;
    this.staged = null; this.notEnabled = false;
    this.stats = {staged: 0, attached: 0, skipped: 0, lastOutcome: null, lastReadyMs: null, lastImageTokens: null, lastReason: null};
    this.unsubscribe = typeof connection?.on === 'function' ? connection.on('serverResponse', response => this.onServerResponse(response)) : null;
    this.waiters = new Set();
  }
  get enabled() { return this.connection?.connectionType === 'video' || this.transport === 'upload'; }
  onServerResponse(response) {
    const ack = readAck(response);
    if (!ack.eventType || !/vision/.test(ack.eventType)) return;
    this.stats.lastOutcome = ack.outcome;
    if (ack.imageTokens !== null) this.stats.lastImageTokens = ack.imageTokens;
    if (ack.outcome === 'vision_not_enabled') this.notEnabled = true;
    for (const waiter of [...this.waiters]) waiter(ack);
  }
  // Starts handing `images` to the session. Never throws: a failure only means the turn goes without a picture.
  // Returns {staged: boolean, reason?}.
  async stage(images) {
    const valid = validImages(images);
    if (!valid.length) return this.skip('no-valid-image');
    if (this.transport === 'video' && this.connection?.connectionType !== 'video') return this.skip('no-video-session');
    if (this.notEnabled) return this.skip('vision-not-enabled');
    await this.retire();
    const started = this.env.now();
    const staged = this.staged = {started, ready: null, attached: false, handle: null, timer: null, canvas: null};
    try {
      staged.canvas = await this.compose(valid);
      if (this.staged !== staged) return {staged: false, reason: 'superseded'};
      staged.ready = this.transport === 'upload' ? this.upload(staged) : this.publish(staged);
      staged.ready.catch(() => {});
      this.stats.staged++;
      return {staged: true};
    } catch (error) {
      if (this.staged === staged) this.staged = null;
      return this.skip('compose-or-publish-failed', error);
    }
  }
  skip(reason) { this.stats.skipped++; this.stats.lastReason = reason; return {staged: false, reason}; }
  async compose(images) {
    const {document, createImageBitmap} = this.env;
    const bitmaps = [];
    try {
      for (const image of images) bitmaps.push(await createImageBitmap(new Blob([decode(image.base64)], {type: image.mime})));
      const {columns, rows, cell} = layout(bitmaps.length);
      const single = bitmaps.length === 1;
      const scale = single ? Math.min(1, COMPOSED_WIDTH / bitmaps[0].width) : 1;
      const canvas = document.createElement('canvas');
      canvas.width = single ? Math.max(1, Math.round(bitmaps[0].width * scale)) : COMPOSED_WIDTH;
      canvas.height = single ? Math.max(1, Math.round(bitmaps[0].height * scale)) : Math.round(cell * rows * 9 / 16);
      const context = canvas.getContext('2d');
      context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height);
      bitmaps.forEach((bitmap, index) => {
        if (single) { context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); return; }
        const cellHeight = canvas.height / rows, x = (index % columns) * cell, y = Math.floor(index / columns) * cellHeight;
        const fit = Math.min(cell / bitmap.width, cellHeight / bitmap.height), w = bitmap.width * fit, h = bitmap.height * fit;
        context.drawImage(bitmap, x + (cell - w) / 2, y + (cellHeight - h) / 2, w, h);
      });
      return canvas;
    } finally { for (const bitmap of bitmaps) bitmap.close?.(); }
  }
  async publish(staged) {
    const handle = await this.connection.videoControls.publishCanvas(staged.canvas, {source: 'canvas', name: 'game-view', fps: 5,
      stopTrackOnUnpublish: true});
    if (this.staged !== staged) { await handle.unpublish().catch(() => {}); return false; }
    staged.handle = handle;
    // A canvas track carries a frame only when the canvas is painted. Repaint the same picture until the turn ends, so the
    // server's sampler finds a frame however late it subscribes. This timer lives in the hidden browser, never in the game.
    const context = staged.canvas.getContext('2d');
    staged.timer = this.env.setInterval(() => { try { context.drawImage(staged.canvas, 0, 0); } catch {} }, REPAINT_MS);
    return true;
  }
  async upload(staged) {
    const blob = await new Promise((resolve, reject) => staged.canvas.toBlob(value => value ? resolve(value) : reject(Error('encode')), 'image/jpeg', 0.85));
    if (this.staged !== staged) return false;
    await this.connection.uploadFile(new File([blob], 'game-view.jpg', {type: 'image/jpeg'}));
    staged.attached = this.staged === staged;
    return staged.attached;
  }
  // Waits until the staged picture is buffered by the server (or uploaded), at most until `deadline` (a time from env.now).
  // Returns {attached, outcome, ms}. Never throws.
  async ready(deadline) {
    const staged = this.staged, now = () => this.env.now();
    if (!staged) return {attached: false, outcome: 'nothing-staged', ms: 0};
    const result = attached => {
      const ms = now() - staged.started;
      this.stats.lastReadyMs = ms;
      if (attached) { staged.attached = true; this.stats.attached++; }
      return {attached, outcome: this.notEnabled ? 'vision_not_enabled' : this.stats.lastOutcome, ms};
    };
    const remaining = () => Math.max(0, deadline - now());
    const published = await this.within(staged.ready.catch(() => false), remaining());
    if (published !== true || this.staged !== staged) return result(false);
    if (this.transport === 'upload') return result(true);
    // Poll the server's buffer until a frame is admitted, the session says vision is not enabled, or time runs out.
    while (remaining() > 0 && this.staged === staged && !this.notEnabled) {
      const id = this.connection.visionStatus?.();
      if (!id) break;
      const ack = await this.nextAck(ack => ack.updateId === id || (ack.updateId === null && ack.eventType === 'vision-status'),
        Math.min(STATUS_POLL_MS * 2, remaining()));
      if (ack && (ack.retained > 0 || ack.outcome === 'frames_available')) return result(true);
      if (ack?.outcome === 'vision_not_enabled') break;
      if (remaining() > 0) await this.within(new Promise(resolve => this.env.setTimeout(resolve, STATUS_POLL_MS)), remaining());
    }
    // Out of time without an acknowledgement: the picture stays published for the turn and may still be sampled in time.
    return result(false);
  }
  nextAck(match, timeoutMs) {
    return new Promise(resolve => {
      const done = ack => { this.waiters.delete(waiter); this.env.clearTimeout(timer); resolve(ack); };
      const waiter = ack => { if (match(ack)) done(ack); };
      const timer = this.env.setTimeout(() => done(null), timeoutMs);
      this.waiters.add(waiter);
    });
  }
  within(promise, timeoutMs) {
    return new Promise(resolve => {
      const timer = this.env.setTimeout(() => resolve(undefined), timeoutMs);
      Promise.resolve(promise).then(value => { this.env.clearTimeout(timer); resolve(value); }, () => { this.env.clearTimeout(timer); resolve(undefined); });
    });
  }
  // Ends the picture's life after its turn: the repaint stops and the track is unpublished. Idempotent; never throws.
  async retire() {
    const staged = this.staged;
    this.staged = null;
    if (!staged) return;
    if (staged.timer) this.env.clearInterval(staged.timer);
    try { await staged.ready; } catch {}
    if (staged.handle) await staged.handle.unpublish().catch(() => {});
  }
  close() { void this.retire(); this.unsubscribe?.(); this.unsubscribe = null; for (const waiter of [...this.waiters]) waiter({}); }
  diagnostics() {
    return {transport: this.transport, enabled: this.enabled, notEnabled: this.notEnabled, staged: !!this.staged, ...this.stats};
  }
}
