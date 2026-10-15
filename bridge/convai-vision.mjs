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
//
// The TV (YouTube on V's TV, bridge/youtube-tv-host.mjs): while a video plays, the page connects with TV_VISION_INPUT_CONFIG and
// the bridge feeds it about one frame of the video a second (liveFrame). The frames stay on one published canvas track for as long
// as the video is on, so the server always holds the last few seconds and attaches several frames to whatever turn comes; a turn
// then publishes nothing of its own and waits for nothing.

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// 1024 px wide (was 768, 2026-10-15: "vision wasn't great"): Convai accepts max_resolution 64 to 2048, the game window is usually
// 1366 or wider, and a model reading signs, furniture and a ceiling does better with the extra detail. The picture is published
// ahead of the line, so the larger frame costs a little more upload and image tokens but no waiting (docs/COMPANION_VISION.md).
export const COMPOSED_WIDTH = 1024;
// Connect-time vision settings. One frame per turn, a 0.25 s sampling interval so a just-published picture is buffered quickly,
// a short staleness window so a picture never rides along into a later turn, and the same 1024 px resolution cap.
export const VISION_INPUT_CONFIG = Object.freeze({enabled: true, sampleIntervalSecs: 0.25, framesPerTurn: 1, bufferFrames: 2,
  stalenessSeconds: 6, maxResolution: COMPOSED_WIDTH, replacePreviousVisionContext: true});
// Connect-time vision settings while the TV is the source: one frame a second into a buffer of 10, the last 5 attached to a
// turn (about five seconds of the video), nothing older than 8 s, 640 px (the TV frames' width).
export const TV_FRAME_WIDTH = 640;
export const TV_VISION_INPUT_CONFIG = Object.freeze({enabled: true, sampleIntervalSecs: 1, framesPerTurn: 5, bufferFrames: 10,
  stalenessSeconds: 8, maxResolution: TV_FRAME_WIDTH, replacePreviousVisionContext: true});
// The note added to the turn's context when a picture is handed over: V's view of the surroundings from a few seconds before this
// message (bridge/companion-vision.mjs), a game screenshot that may include the HUD. It also settles who wins when the text and the
// picture disagree about being indoors or outdoors: the game's own word, when it gives one, else the picture, never a guess from
// the district's name (live 2026-10-15: a companion indoors said they were out in the street).
export const VISION_NOTE = ' An image of your surroundings may be attached: V\'s view from a few seconds before this message. '
  + 'It can include the game\'s HUD, map, subtitles or menus, V\'s vehicle, or you. Treat it as what you both can see around you: '
  + 'mention it only when it fits or when V asks, describe the place and people in your own words, never the interface. '
  + 'Whether you are indoors or outdoors: if the text above says so, that is fact; if it does not, judge it from the image '
  + '(walls, ceiling, windows, furniture, sky) and never from the name of the district. '
  + 'If no image is attached or it does not show what V asks about, say so plainly instead of guessing.';
// Interior frames are often dim. A frame whose average brightness is below DARK_MEAN (0 to 255) is lifted with a gamma curve that
// aims at TARGET_MEAN, never past MIN_GAMMA (a black or loading screen is left alone: below BLACK_MEAN there is nothing to lift), and
// only a single game picture, so a bright frame and the TV's frames are untouched. Runs in the hidden browser, never in the game.
export const DARK_MEAN = 70, TARGET_MEAN = 95, MIN_GAMMA = 0.55, BLACK_MEAN = 4;
// The average luma (0 to 255) of RGBA pixel data, sampling every `stride`th pixel.
export function meanLuma(data, stride = 1) {
  let sum = 0, count = 0;
  for (let i = 0; i + 2 < data.length; i += 4 * stride) { sum += (data[i] * 54 + data[i + 1] * 183 + data[i + 2] * 19) / 256; count++; }
  return count ? sum / count : 0;
}
// The gamma that lifts a frame of this average brightness to about TARGET_MEAN, or null when it needs none.
export function gammaFor(mean) {
  if (!Number.isFinite(mean) || mean >= DARK_MEAN || mean < BLACK_MEAN) return null;
  return Math.min(1, Math.max(MIN_GAMMA, Math.log(TARGET_MEAN / 255) / Math.log(mean / 255)));
}
// Applies out = 255 * (in / 255) ^ gamma to the colour channels in place (alpha untouched).
export function applyGamma(data, gamma) {
  const table = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) table[i] = Math.round(255 * Math.pow(i / 255, gamma));
  for (let i = 0; i + 2 < data.length; i += 4) { data[i] = table[data[i]]; data[i + 1] = table[data[i + 1]]; data[i + 2] = table[data[i + 2]]; }
  return data;
}
// The note while the TV is the source.
export const VISION_NOTE_TV = ' Images of the video playing on the TV you and V are watching together may be attached: its last '
  + 'few seconds, oldest first. Talk about what is on screen when it fits or when V asks, in your own words; never describe the '
  + 'player\'s controls, and if no image is attached or it does not show what V asks about, say so plainly instead of guessing.';
const REPAINT_MS = 200;
const LIVE_REPAINT_MS = 500;
const STATUS_POLL_MS = 100;

// The ConvaiClient options a vision session connects with (none when vision is off).
export function visionConnectOptions(config) {
  if (config?.vision !== true) return {};
  return {enableVideo: true, startWithVideoOn: false,
    visionInputConfig: {...(config.visionMode === 'tv' ? TV_VISION_INPUT_CONFIG : VISION_INPUT_CONFIG)}};
}

// The session's identity for reuse: a page connected without video must reconnect when vision turns on, and back. The TV's
// settings differ (several frames a turn), so switching the source reconnects too (the bridge does it between conversations).
export const visionIdentity = (key, config) => config?.vision !== true ? key : key + (config.visionMode === 'tv' ? '|vision-tv' : '|vision');

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

// A cheap identity for a set of pictures (length and tail of each), to recognise one already staged.
export const signatureOf = images => images.map(image => `${image.mime}:${image.base64.length}:${image.base64.slice(-48)}`).join('|');

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
  // mode 'tv': the session was connected for the TV's frames (TV_VISION_INPUT_CONFIG); liveFrame works only then.
  constructor(connection, {transport = 'video', mode = 'still', env = browserEnv()} = {}) {
    this.connection = connection;
    this.transport = transport === 'upload' ? 'upload' : 'video';
    this.mode = mode === 'tv' ? 'tv' : 'still';
    this.env = env;
    this.staged = null; this.live = null; this.notEnabled = false;
    this.stats = {staged: 0, attached: 0, skipped: 0, lastOutcome: null, lastReadyMs: null, lastImageTokens: null, lastReason: null,
      liveFrames: 0, lastMean: null, lastGamma: null};
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
  // ttlMs: a picture staged ahead of its turn is withdrawn after this long unless a turn claims it (claim()).
  async stage(images, {ttlMs = 0} = {}) {
    // The TV's frames are on the session already: the turn takes the server's last few, nothing more is published.
    if (this.live?.handle) return {staged: true, live: true};
    const valid = validImages(images);
    if (!valid.length) return this.skip('no-valid-image');
    if (this.transport === 'video' && this.connection?.connectionType !== 'video') return this.skip('no-video-session');
    if (this.notEnabled) return this.skip('vision-not-enabled');
    const signature = signatureOf(valid);
    // The same picture is already on the session (staged ahead while V typed or talked): nothing to publish again.
    if (this.staged?.signature === signature) { if (!ttlMs) this.claim(); return {staged: true, reused: true}; }
    await this.retire();
    const started = this.env.now();
    const staged = this.staged = {started, signature, ready: null, attached: false, handle: null, timer: null, canvas: null, expiry: null};
    if (ttlMs > 0) staged.expiry = this.env.setTimeout(() => { if (this.staged === staged) void this.retire(); }, ttlMs);
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
  // A turn takes the staged picture: it is no longer withdrawn by its ahead-of-time expiry (the turn retires it).
  claim() {
    const staged = this.staged;
    if (staged?.expiry) { this.env.clearTimeout(staged.expiry); staged.expiry = null; }
  }
  async compose(images, width = COMPOSED_WIDTH, {adjust = true} = {}) {
    const {document, createImageBitmap} = this.env;
    const bitmaps = [];
    try {
      for (const image of images) bitmaps.push(await createImageBitmap(new Blob([decode(image.base64)], {type: image.mime})));
      const {columns, rows, cell} = layout(bitmaps.length);
      const single = bitmaps.length === 1;
      const scale = single ? Math.min(1, width / bitmaps[0].width) : 1;
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
      if (single && adjust) this.brighten(context, canvas);
      return canvas;
    } finally { for (const bitmap of bitmaps) bitmap.close?.(); }
  }
  // A dim picture (an interior at night) is lifted; a normal one is left as it is. Never throws: a browser without pixel access only
  // means no adjustment.
  brighten(context, canvas) {
    try {
      const stride = 4, sample = context.getImageData(0, 0, canvas.width, canvas.height);
      const mean = meanLuma(sample.data, stride), gamma = gammaFor(mean);
      this.stats.lastMean = Math.round(mean); this.stats.lastGamma = gamma === null ? null : Math.round(gamma * 100) / 100;
      if (gamma === null) return;
      applyGamma(sample.data, gamma);
      context.putImageData(sample, 0, 0);
    } catch { /* no pixel access: the picture goes as it is */ }
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
    if (this.live?.handle) return {attached: true, outcome: 'live', ms: 0, waitedMs: 0};
    const staged = this.staged, now = () => this.env.now(), asked = now();
    if (!staged) return {attached: false, outcome: 'nothing-staged', ms: 0, waitedMs: 0};
    const result = attached => {
      const ms = now() - staged.started;
      this.stats.lastReadyMs = ms;
      if (attached && !staged.attached) { staged.attached = true; this.stats.attached++; }
      return {attached, outcome: this.notEnabled ? 'vision_not_enabled' : this.stats.lastOutcome, ms, waitedMs: now() - asked};
    };
    // Buffered already (staged ahead and acknowledged while V typed or talked): the turn waits for nothing.
    if (staged.attached) return result(true);
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
    if (staged.expiry) this.env.clearTimeout(staged.expiry);
    try { await staged.ready; } catch {}
    if (staged.handle) await staged.handle.unpublish().catch(() => {});
  }
  // ---- the TV's frames ----------------------------------------------------------------------------------------------------
  // Shows one more frame of the TV on the live track (published with the first frame, then repainted with each new one), or
  // stops the track (image null). Returns {fed, reason?}; never throws.
  async liveFrame(image) {
    if (!image) { await this.stopLive(); return {fed: false, reason: 'stopped'}; }
    if (this.mode !== 'tv') return {fed: false, reason: 'wrong-mode'};
    if (this.transport !== 'video' || this.connection?.connectionType !== 'video') return {fed: false, reason: 'no-video-session'};
    if (this.notEnabled) return {fed: false, reason: 'vision-not-enabled'};
    const [valid] = validImages([image]);
    if (!valid) return {fed: false, reason: 'no-valid-image'};
    try {
      if (!this.live) {
        await this.retire();   // a still picture staged for a turn gives way to the TV
        const live = this.live = {canvas: null, handle: null, timer: null, ready: null};
        live.canvas = await this.compose([valid], TV_FRAME_WIDTH, {adjust: false});
        if (this.live !== live) return {fed: false, reason: 'superseded'};
        live.ready = this.connection.videoControls.publishCanvas(live.canvas, {source: 'canvas', name: 'tv-view', fps: 2,
          stopTrackOnUnpublish: true}).then(async handle => {
          if (this.live !== live) { await handle.unpublish().catch(() => {}); return false; }
          live.handle = handle;
          // A canvas track carries a frame only when the canvas is painted: repaint between the bridge's frames.
          const context = live.canvas.getContext('2d');
          live.timer = this.env.setInterval(() => { try { context.drawImage(live.canvas, 0, 0); } catch {} }, LIVE_REPAINT_MS);
          return true;
        });
        const published = await live.ready.catch(() => false);
        if (!published) { if (this.live === live) this.live = null; return {fed: false, reason: 'publish-failed'}; }
      } else {
        const live = this.live;
        if (!live.handle && !await live.ready?.catch(() => false)) return {fed: false, reason: 'publishing'};
        const bitmap = await this.env.createImageBitmap(new Blob([decode(valid.base64)], {type: valid.mime}));
        try { live.canvas.getContext('2d').drawImage(bitmap, 0, 0, live.canvas.width, live.canvas.height); }
        finally { bitmap.close?.(); }
      }
      this.stats.liveFrames++;
      return {fed: true};
    } catch { return {fed: false, reason: 'failed'}; }
  }
  async stopLive() {
    const live = this.live;
    this.live = null;
    if (!live) return;
    if (live.timer) this.env.clearInterval(live.timer);
    try { await live.ready; } catch {}
    if (live.handle) await live.handle.unpublish().catch(() => {});
  }
  close() { void this.retire(); void this.stopLive(); this.unsubscribe?.(); this.unsubscribe = null; for (const waiter of [...this.waiters]) waiter({}); }
  diagnostics() {
    return {transport: this.transport, mode: this.mode, enabled: this.enabled, notEnabled: this.notEnabled, staged: !!this.staged,
      live: !!this.live?.handle, ...this.stats};
  }
}
