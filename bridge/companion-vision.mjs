// "Companions can see" (docs/COMPANION_VISION.md): with Convai, every conversation turn carries one recent picture of V's
// surroundings. Always on with Convai (there is no player setting; a saved "companionVision" key from an older install is ignored);
// CYBERPUNK_CONVAI_VISION=off is the developer switch.
//
// Why a rolling buffer and not a screenshot at talk time: when V talks, V is usually looking at the companion, so a picture taken
// then is mostly her face. The view from a few seconds *before* the conversation shows where they are. So, while a companion (or
// a character V may talk to) is near and no conversation is running, the out-of-process helper takes one game-window picture
// every FRAME_INTERVAL_MS and keeps the last FRAME_SLOTS in memory. Nothing is captured during a conversation or for TAIL_MS
// after it (the view is still on the companion), and a turn takes the newest frame from at least LEAD_MS before the conversation
// started (the moment V turned to talk). Pictures never touch the disk (except CYBERPUNK_CONVAI_VISION_DEBUG_DIR and CYBERPUNK_CONVAI_VISION_DEBUG_LAST, development).
//
// Freshness (live 2026-10-15: V and Alex had gone indoors and Alex still said they were in the street, because the picture sent was
// 52 s old): a picture older than MAX_FRAME_AGE_MS is never sent. The helper is released during a conversation, so when a turn
// starts (composer opens, talk key pressed) and no frame is younger than FRESH_FRAME_AGE_MS, one frame is taken at that moment
// (helper start plus capture, about 0.3 to 0.5 s, hidden behind typing or talking) and staged; the companion may be in it, which
// is accepted: a picture of the right place with her in it beats a clean one of the place they left. A turn that has no staged frame
// and none fresh waits at most TURN_CAPTURE_WAIT_MS for one capture, then goes without a picture and says so in the log.
//
// The yellow border (2026-10-23 Discord report: yellow bars around the screen, flashing every few seconds): Windows draws a border around a window
// that Windows Graphics Capture is capturing, for as long as the capture lasts, and an ordinary program cannot turn it off. So the helper takes the
// frame by Desktop Duplication, which has none, while the game is in front. On a system where it cannot (the capture reports `border`, see
// VisionCapture.borderShown) the buffer above does not run at all: a picture is taken only when a turn is starting (composer opening, talk key,
// a turn with no frame), so the border shows for a moment around a reply, never on a timer; and the player is told once, in a notice, what the
// border is and how to stop it (takeBorderNotice, keyNotice 'vision-border').
//
// Turns with no composer (a group's next speaker): Convai takes a picture only if it was published about MIN_LEAD_MS (3 s) before the line (live 2026-10-23), so when a
// group speaker's turn begins, stageForNext() puts a frame on the pages of the speakers after them (one reused if it is at most FRESH_FRAME_AGE_MS old, else one capture)
// and imagesForTurn gives that speaker the very same frame, which the page already holds. The turn itself never waits for any of it.
//
// Latency: the frame is already in memory when V talks. It is published to Convai ahead of the line (stagePage when the composer
// opens, stageVoice when the talk key is pressed), so Convai's acceptance of the frame overlaps typing or talking instead of the
// turn. The unload rule (docs/RESOURCE_LIFECYCLE.md): the helper process exists only while it is capturing: setting on, Convai
// answering, someone near, and no conversation running.
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {absoluteRuntimeOverride} from './runtime-paths.mjs';
import {MAX_IMAGES, validImages} from './convai-vision.mjs';

export const FRAME_INTERVAL_MS = 3000;
export const FRAME_SLOTS = 5;
// A frame this close before the conversation started may already be the companion's face (V turning to talk).
export const LEAD_MS = 2500;
// After the last sign of a conversation (composer, turn, microphone, reply playing) the view is probably still on the companion.
export const TAIL_MS = 12000;
// An older frame is never sent: V walks 4 to 7 m a second, so 15 s is a door, a corridor and a lift, and the place a picture shows
// must still be the place they are in.
export const MAX_FRAME_AGE_MS = 15000;
// A frame this young is used as it is; an older one makes the turn take a new picture first (twice the 3 s buffer cadence, so a
// walk with the buffer running normally needs no extra capture).
export const FRESH_FRAME_AGE_MS = 6000;
// The longest a turn with no fresh picture waits for one capture (a turn that was not staged ahead).
export const TURN_CAPTURE_WAIT_MS = 450;
// How long a queued picture (attachToNextTurn) waits for a turn before it is dropped.
export const QUEUE_TTL_MS = 20000;
// How long ahead-of-time staging keeps retrying while the page is still connecting or the recording is starting.
export const STAGE_RETRY_MS = 6000;
const STAGE_RETRY_EVERY_MS = 250;
const STAGE_ATTEMPTS = Math.ceil(STAGE_RETRY_MS / STAGE_RETRY_EVERY_MS);
const TURN_MEMORY = 32;
// How long the pictures of a turn stay in memory for a retry of that turn (the game gives up on a request 90 s after writing it), and how long a recording's staged
// frame stays (a recording is bounded well under this). The turn's id stays in its map afterwards, with no picture.
export const ANSWER_KEEP_MS = 90_000;
export const VOICE_KEEP_MS = 10 * 60_000;

// Which conversation page a picture is on (a character and its scope: private, or a group's), for handing the turn that page serves the same frame.
const pageKeyOf = config => JSON.stringify([config?.characterId ?? null, config?.scope ?? null]);

export const visionDisabledByEnv = (env = process.env) => /^(0|off|false|no)$/i.test(String(env.CYBERPUNK_CONVAI_VISION ?? '').trim());

export class CompanionVision {
  // capture: a VisionCapture (bridge/vision-capture.mjs). isConvai(): true while Convai answers (Mistral and Local AI get no picture).
  // isNear(): a party member or a character V may talk to is around. isConversing(): a composer, turn, recording or reply is running.
  // stageVoice(images): hands pictures to the running microphone turn ({staged, reason}). stagePage(config, images) / unstagePage(config):
  // publish or withdraw a picture on an idle conversation page ahead of the turn ({staged, reason}).
  constructor({capture, isConvai = () => true, isNear = () => true, isConversing = () => false,
    stageVoice = async () => ({staged: false}), stagePage = async () => ({staged: false}), unstagePage = async () => {},
    log = () => {}, now = () => Date.now(), env = process.env,
    debugDirectory = absoluteRuntimeOverride(env.CYBERPUNK_CONVAI_VISION_DEBUG_DIR || undefined, 'CYBERPUNK_CONVAI_VISION_DEBUG_DIR'),
    lastSentPath = null,
    writeDebug = (path, bytes) => writeFile(path, bytes), sleep = ms => new Promise(done => setTimeout(done, ms))} = {}) {
    Object.assign(this, {capture, isConvai, isNear, isConversing, stageVoice, stagePage, unstagePage,
      log, now, debugDirectory, lastSentPath, writeDebug, sleep});
    this.envOff = visionDisabledByEnv(env);
    // Development only: keep the last picture handed to Convai (and a line about it) in lastSentPath, to look at what the model saw.
    this.debugLast = /^(1|on|true|yes)$/i.test(String(env.CYBERPUNK_CONVAI_VISION_DEBUG_LAST ?? '').trim());
    this.turnCapture = null; this.stagedFrame = null; this.newestTakenAt = null;
    this.enabled = !this.envOff; this.transport = 'video'; this.waitMs = null;
    this.frames = []; this.lastCaptureAt = -Infinity; this.busy = 0; this.frameSerial = 0;
    this.conversing = false; this.conversationStart = null; this.lastConversationAt = -Infinity;
    this.queue = []; this.voice = new Map(); this.answered = new Map(); this.answeredAt = new Map(); this.staged = new Map(); this.stageRound = 0;
    // The frame each idle conversation page holds ahead of its turn ({characterId, scope, frame, at}), so that turn sends that same frame and the page publishes nothing new.
    this.pageFrames = new Map(); this.nextRound = 0;
    this.counters = {captures: 0, failed: 0, minimised: 0, covered: 0, borderCaptures: 0, queued: 0, turnsWithPicture: 0, turnsWithoutFrame: 0, turnCaptures: 0,
      prestaged: 0, nextStaged: 0, nextCaptures: 0, unstagedSent: 0, helperStarts: 0, helperReleases: 0};
    this.borderNoticePending = false; this.borderNoticeGiven = false; this.borderLogged = false;
  }
  // Windows is drawing its capture border around the game for these pictures: no buffer on a timer, only a picture when a turn needs one.
  get borderShown() { try { return this.capture?.borderShown === true; } catch { return false; } }
  // True once, after the first picture that showed the border: the game says what the yellow border is and how to stop it (keyNotice 'vision-border').
  takeBorderNotice() {
    if (!this.borderNoticePending || !this.active) return false;
    this.borderNoticePending = false;
    return true;
  }
  get active() {
    try { return this.enabled && this.isConvai() === true; } catch { return false; }
  }
  // True while the helper may run: it is capturing frames.
  get capturing() {
    if (!this.active || this.conversing || this.now() - this.lastConversationAt < TAIL_MS) return false;
    // Never on a timer while Windows shows its yellow border for a capture.
    if (this.borderShown) return false;
    return this.near;
  }
  get near() { try { return this.isNear() === true; } catch { return false; } }

  // ---- the 500 ms settings poll ----------------------------------------------------------------------------------------------
  // Reads the settings (a missing object changes nothing) and runs one cheap tick: conversation state, the helper's lifetime and,
  // when due, one capture. Returns true when the setting changed. Never per frame and never inside the game.
  update(settings) {
    let changed = false;
    if (settings && typeof settings === 'object') {
      const enabled = !this.envOff;
      const transport = settings.visionTransport === 'upload' ? 'upload' : 'video';
      const wait = Number(settings.visionWaitMs);
      changed = enabled !== this.enabled || transport !== this.transport;
      this.enabled = enabled; this.transport = transport;
      this.waitMs = Number.isFinite(wait) ? Math.max(0, Math.min(900, Math.round(wait))) : null;
      if (settings.visionDebugLastSent === true) this.debugLast = true;
      if (changed && !enabled) this.forget();
    }
    this.tick();
    return changed;
  }
  forget() { this.frames = []; this.stagedFrame = null; this.pageFrames.clear(); this.nextRound++; this.queue = []; this.voice.clear(); this.answered.clear(); this.answeredAt.clear(); this.closeComposer(); }
  tick() {
    let conversing = false;
    try { conversing = this.isConversing() === true; } catch {}
    if (conversing) this.markConversation(); else this.conversing = false;
    // Pictures are base64 JPEGs (about 0.2 to 0.3 MB each as a string): while vision is not used (the setting is off, another provider answers) none is held, and while it is
    // the pictures of turns that are over are let go once a retry of them can no longer happen (the ids stay).
    if (!this.active) { this.frames = []; this.releasePictures(); }
    else {
      if (this.frames.length) { const now = this.now(); this.frames = this.frames.filter(frame => now - frame.at <= MAX_FRAME_AGE_MS); }
      this.expirePictures();
    }
    const running = this.capture?.running === true;
    if (!this.capturing) {
      if (running && this.busy === 0) {
        this.capture.stop(); this.counters.helperReleases++;
        this.log(`helper released (${!this.active ? 'setting off or another provider'
          : this.conversing || this.now() - this.lastConversationAt < TAIL_MS ? 'conversation' : this.borderShown ? 'pictures only when a turn needs one' : 'nobody near'})`);
      }
      return;
    }
    if (this.busy === 0 && this.now() - this.lastCaptureAt >= FRAME_INTERVAL_MS) void this.collect();
  }
  // Every picture this object holds, bar the frame buffer (tick empties that): the staged frame, queued pictures, the recordings' and the answered turns' pictures. The
  // turns' ids stay, so a retried turn is still told it was answered. Cheap when there is nothing to release.
  releasePictures() {
    this.stagedFrame = null; this.pageFrames.clear();
    if (this.queue.length) this.queue = [];
    for (const entry of this.voice.values()) { entry.images = null; entry.frame = null; }
    for (const id of this.answered.keys()) this.answered.set(id, null);
    this.answeredAt.clear();
  }
  expirePictures() {
    if (!this.answeredAt.size && !this.voice.size && !this.pageFrames.size) return;
    const now = this.now();
    for (const [key, entry] of this.pageFrames) if (now - entry.frame.at > MAX_FRAME_AGE_MS) this.pageFrames.delete(key);
    for (const [id, at] of this.answeredAt) if (now - at > ANSWER_KEEP_MS) { this.answeredAt.delete(id); if (this.answered.has(id)) this.answered.set(id, null); }
    for (const entry of this.voice.values()) if (entry.at !== undefined && (entry.images || entry.frame) && now - entry.at > VOICE_KEEP_MS) { entry.images = null; entry.frame = null; }
  }
  // A conversation is running now (composer, typed turn, talk key, reply). The first mark after a quiet spell starts a new one.
  markConversation() {
    const now = this.now();
    if (!this.conversing && now - this.lastConversationAt >= TAIL_MS) this.conversationStart = now;
    this.conversing = true; this.lastConversationAt = now;
  }
  async collect() {
    if (!this.capture) return;
    if (this.capture.running !== true) this.counters.helperStarts++;
    this.busy++; this.lastCaptureAt = this.now();
    try {
      const shot = await this.grab('buffer');
      // A picture that finished after a conversation began is dropped: V may already have turned to the companion.
      if (shot && this.active && this.lastConversationAt < this.lastCaptureAt) {
        this.keep({...shot, at: this.lastCaptureAt});
      }
    } finally { this.busy--; }
  }
  keep(frame) {
    this.frames.push({...frame, serial: ++this.frameSerial});
    this.newestTakenAt = frame.at;
    while (this.frames.length > FRAME_SLOTS) this.frames.shift();
    return this.frames.at(-1);
  }
  // One picture taken because a turn is starting (the buffer does not run during a conversation, and its frames may be old). The
  // helper starts if it was released, takes the picture and is released again by the next poll. Shared by concurrent callers; never
  // throws; null when it fails or vision is off.
  captureForTurn(trigger) {
    if (this.turnCapture) return this.turnCapture;
    if (!this.active || !this.capture) return Promise.resolve(null);
    if (this.capture.running !== true) this.counters.helperStarts++;
    this.busy++;
    const run = (async () => {
      try {
        const shot = await this.grab(trigger);
        if (!shot || !this.active) return null;
        this.counters.turnCaptures++;
        return this.keep({...shot, at: this.now(), turn: true});
      } catch { return null; } finally { this.busy--; }
    })();
    this.turnCapture = run;
    void run.then(() => { if (this.turnCapture === run) this.turnCapture = null; });
    return run;
  }
  // True when the picture a turn would take is missing or older than FRESH_FRAME_AGE_MS (and a new one can be taken).
  wantsFresh(frame) { return !frame || this.now() - frame.at > FRESH_FRAME_AGE_MS; }
  // The frame a turn sends, never older than MAX_FRAME_AGE_MS (null when there is none): a young one taken before the conversation
  // started and at least LEAD_MS earlier (V turning to talk, so it shows the place and not her face); else the newest of all
  // (a picture taken when the turn began may show her, and is fresh).
  frame() {
    const now = this.now();
    const fresh = this.frames.filter(frame => now - frame.at <= MAX_FRAME_AGE_MS);
    if (!fresh.length) return null;
    const start = this.conversationStart ?? now;
    const before = [...fresh].reverse().find(frame => !frame.turn && frame.at <= start - LEAD_MS);
    return before && now - before.at <= FRESH_FRAME_AGE_MS ? before : fresh.at(-1);
  }
  // The frame already staged on the pages for this conversation turn, while it is still young enough to send.
  stagedYoung() {
    const frame = this.stagedFrame;
    return frame && this.now() - frame.at <= MAX_FRAME_AGE_MS ? frame : null;
  }
  // A frame for a turn that has none staged: any frame within MAX_FRAME_AGE_MS, else one capture, waited for at most
  // TURN_CAPTURE_WAIT_MS (a turn is never slowed to replace a 7 s old picture with a 1 s old one). Never throws.
  async freshFrame() {
    const have = this.frame();
    if (have) return have;
    await Promise.race([this.captureForTurn('turn'), this.sleep(TURN_CAPTURE_WAIT_MS)]).catch(() => {});
    return this.frame() ?? null;
  }
  // Why a turn has no picture, for the log: no frame ever, or the newest was too old.
  noPictureReason() {
    if (this.newestTakenAt === null) return 'no frame yet';
    return `no fresh frame (newest ${Math.round((this.now() - this.newestTakenAt) / 1000)} s old, limit ${MAX_FRAME_AGE_MS / 1000} s)`;
  }
  // Development: keep the picture that went to Convai, with a line about it (CYBERPUNK_CONVAI_VISION_DEBUG_LAST=1 or settings.json
  // "visionDebugLastSent": true). The file is overwritten by each picture; nothing is written otherwise.
  noteSent(frame, how) {
    if (!this.debugLast || !this.lastSentPath || !frame?.base64) return;
    const note = {sentAt: new Date(this.now()).toISOString(), how, takenAt: new Date(frame.at ?? this.now()).toISOString(),
      ageMs: frame.at ? this.now() - frame.at : null, takenForTurn: frame.turn === true,
      width: frame.width ?? null, height: frame.height ?? null, bytes: frame.bytes ?? null};
    this.writeDebug(this.lastSentPath, Buffer.from(frame.base64, 'base64')).catch(() => {});
    this.writeDebug(this.lastSentPath.replace(/\.jpe?g$/i, '') + '.json', JSON.stringify(note, null, 1)).catch(() => {});
  }
  connectConfig() { return this.active ? {transport: this.transport} : null; }
  turnWaitMs() { return this.waitMs; }

  // ---- public API for other features ------------------------------------------------------------------------------------------
  // Sends `images` with the next conversation turn, for a feature that already has pictures to show. images: up to 4 of
  // {mime: 'image/jpeg' | 'image/png' | 'image/webp', base64}; each at most 4 MB. They are composed into one picture with the
  // surroundings frame. Options: characterId (only a turn with that Convai character takes them), ttlMs (default 20 s).
  // Returns {queued: n} or {queued: 0, reason}. Nothing is sent while the setting is off or another provider answers.
  attachToNextTurn(images, {characterId, ttlMs = QUEUE_TTL_MS} = {}) {
    if (!this.active) return {queued: 0, reason: this.enabled ? 'provider' : 'off'};
    const valid = validImages(images);
    if (!valid.length) return {queued: 0, reason: 'invalid'};
    this.queue = this.queue.filter(entry => entry.expiresAt > this.now());
    this.queue.push({images: valid, characterId: typeof characterId === 'string' ? characterId : null,
      expiresAt: this.now() + Math.max(1000, Math.min(120000, Number(ttlMs) || QUEUE_TTL_MS))});
    while (this.queue.reduce((n, entry) => n + entry.images.length, 0) > MAX_IMAGES) this.queue.shift();
    this.counters.queued += valid.length;
    return {queued: valid.length};
  }

  // ---- ahead-of-time staging (bridge/convai-bridge.mjs) -----------------------------------------------------------------------
  // The composer (or a group's composer) opened for these conversation pages: the frame is published on each page now, while V
  // types, retried while a page is still connecting. When no frame is young (FRESH_FRAME_AGE_MS) one is taken first (the helper
  // starts; about 0.3 to 0.5 s, hidden behind typing). Queued pictures are not staged ahead (they may arrive later).
  openComposer(configs) {
    if (!this.active || !Array.isArray(configs) || !configs.length) return false;
    this.markConversation();
    const round = ++this.stageRound, have = this.frame();
    this.stagedFrame = null;
    if (!this.wantsFresh(have)) { if (have) this.beginStage(round, configs, have); return !!have; }
    void this.captureForTurn('composer').then(() => {
      const frame = this.frame();   // the new picture, or an older one that is still within MAX_FRAME_AGE_MS, or none
      if (round === this.stageRound && frame) this.beginStage(round, configs, frame);
    });
    return true;
  }
  beginStage(round, configs, frame) {
    this.stagedFrame = frame;
    const images = [{mime: frame.mime, base64: frame.base64}];
    for (const config of configs) void this.stageAhead(round, config, images, frame);
  }
  // Publishes `images` on the page for `config`, retried while it connects. `current()` says whether this staging is still wanted (the composer round, or the group
  // round of stageForNext). The page's frame is remembered, so the turn that page serves sends that very frame.
  async stageAhead(round, config, images, frame, {current = () => round === this.stageRound, how = 'staged on the page while typing', counter = 'prestaged'} = {}) {
    const until = this.now() + STAGE_RETRY_MS;
    for (let attempt = 0; attempt <= STAGE_ATTEMPTS && current() && this.active; attempt++) {
      let result;
      try { result = await this.stagePage(config, images); } catch { result = {staged: false, reason: 'failed'}; }
      if (result?.staged) {
        this.staged.set(config, round); this.counters[counter]++; this.noteSent(frame, how);
        this.pageFrames.set(pageKeyOf(config), {characterId: config?.characterId ?? null, scope: config?.scope ?? null, frame, at: this.now()});
        return true;
      }
      if (!['no-page', 'busy', 'connecting', 'no-video-session'].includes(result?.reason) || this.now() >= until) return false;
      await this.sleep(STAGE_RETRY_EVERY_MS);
    }
    return false;
  }
  // A group's current speaker is starting: their turn is sent without a composer, so the next speakers' turns would have no picture published 3 s ahead. The
  // pages of the speakers after them get a frame now, while this one is written and heard: the newest frame if it is at most FRESH_FRAME_AGE_MS old (no capture),
  // else one new capture (the helper starts, about 0.3 to 0.5 s). Never waited for by the turn that calls it. configs: the next speakers' conversation pages.
  stageForNext(configs) {
    if (!this.active || !Array.isArray(configs) || !configs.length) return false;
    const round = ++this.nextRound, current = () => round === this.nextRound;
    const publish = (frame, source) => {
      if (!frame || !current() || !this.active || this.now() - frame.at > MAX_FRAME_AGE_MS) return;
      const images = [{mime: frame.mime, base64: frame.base64}];
      this.log(`next speaker: frame ${Math.round((this.now() - frame.at) / 1000)} s old (${source}), staged ahead on ${configs.length} page(s)`);
      for (const config of configs) void this.stageAhead(round, config, images, frame, {current, how: "staged on the next speaker's page", counter: 'nextStaged'});
    };
    const have = this.frame();
    if (!this.wantsFresh(have)) { publish(have, 'reused'); return true; }
    this.counters.nextCaptures++;
    void this.captureForTurn('next speaker').then(() => publish(this.frame(), 'taken now'));
    return true;
  }
  // The frame already published on the idle page this turn runs on (composer or next-speaker staging), taken once, while it is within MAX_FRAME_AGE_MS. null when the
  // page holds none, or the turn cannot be matched to a page (no character id).
  takePageFrame(config) {
    if (!this.pageFrames.size || typeof config?.characterId !== 'string') return null;
    for (const [key, entry] of this.pageFrames) {
      if (entry.characterId !== config.characterId || (entry.scope && config.scope && entry.scope !== config.scope)) continue;
      this.pageFrames.delete(key);
      return this.now() - entry.frame.at <= MAX_FRAME_AGE_MS ? entry : null;
    }
    return null;
  }
  // The composer closed: pictures staged on pages that no turn took are withdrawn (each page also drops one after a minute).
  closeComposer() {
    this.stageRound++; this.nextRound++; this.stagedFrame = null; this.pageFrames.clear();
    for (const config of this.staged.keys()) void Promise.resolve().then(() => this.unstagePage(config)).catch(() => {});
    this.staged.clear();
  }

  // ---- turn hooks (bridge/convai-bridge.mjs, bridge/realtime-host.mjs) --------------------------------------------------------
  // A typed turn was admitted (or a group's next speaker): it counts as conversation, so no capture runs beside it.
  beginTurn(input) {
    if (!this.active || !input || input.reaction || input.addon) return false;
    this.markConversation();
    return true;
  }
  // The talk key was pressed: the frame is published on the voice page as soon as the recording runs, while V talks.
  beginVoice(requestId) {
    if (!this.active || typeof requestId !== 'string' || this.voice.has(requestId)) return false;
    this.markConversation();
    const entry = {images: null, frame: null, staged: false, at: this.now()};
    this.remember(this.voice, requestId, entry);
    entry.done = (async () => {
      // No young frame: one is taken now, while V starts to talk (the helper starts; about 0.3 to 0.5 s).
      if (this.wantsFresh(this.frame())) await this.captureForTurn('talk key');
      const frame = this.frame();
      if (!frame || this.voice.get(requestId) !== entry || !this.active) return;
      this.stagedFrame = entry.frame = frame;
      entry.images = [{mime: frame.mime, base64: frame.base64}];
      const until = this.now() + STAGE_RETRY_MS;
      for (let attempt = 0; attempt <= STAGE_ATTEMPTS && this.voice.get(requestId) === entry && this.active; attempt++) {
        const result = await this.stageVoice(entry.images, requestId).catch(() => ({staged: false, reason: 'failed'}));
        if (result?.staged) { entry.staged = true; this.noteSent(frame, 'staged on the recording while talking'); return; }
        if (result?.reason !== 'no-recording' || this.now() >= until) { this.log(`picture not staged on the recording (${result?.reason ?? 'unknown'})`); return; }
        await this.sleep(STAGE_RETRY_EVERY_MS);
      }
    })();
    return true;
  }
  // The picture(s) for a turn about to be sent: the surroundings frame first, then queued pictures. Never waits for a capture.
  // phase 'finish' (talk key): a frame staged while V talked is already on the page, so nothing more goes unless pictures were queued.
  async imagesForTurn(config, {phase = 'reply'} = {}) {
    if (!this.active || !config || config.freshSession || config.reaction) return null;
    const id = typeof config.visionTurn === 'string' ? config.visionTurn : null;
    if (id && this.answered.has(id)) return this.answered.get(id);   // a retried turn sends the same picture
    const queued = this.takeQueued(config.characterId);
    if (phase === 'finish' && id && this.voice.has(id)) {
      const entry = this.voice.get(id);
      // The frame for the recording is still being taken (the talk key was only just pressed): wait for it, briefly.
      if (!entry.images) await Promise.race([entry.done, this.sleep(TURN_CAPTURE_WAIT_MS)]).catch(() => {});
      const age = entry.frame ? this.now() - entry.frame.at : null;
      // V talked for so long that the picture is past the limit: a new one replaces it (this turn publishes it).
      if (age !== null && age > MAX_FRAME_AGE_MS) {
        const frame = await this.freshFrame();
        if (frame && this.now() - frame.at <= MAX_FRAME_AGE_MS) {
          this.noteSent(frame, 'replaced a stale staged frame at the end of the recording');
          return this.settle(id, [{mime: frame.mime, base64: frame.base64}, ...queued].slice(0, MAX_IMAGES),
            `1 image(s), frame ${Math.round((this.now() - frame.at) / 1000)} s old (the ${entry.staged ? 'staged' : 'unstaged'} one was ${Math.round(age / 1000)} s old)`);
        }
        this.counters.turnsWithoutFrame++;
        return this.settle(id, queued.length ? queued : null, `${this.noPictureReason()}; the frame staged while talking was ${Math.round(age / 1000)} s old`);
      }
      if (entry.staged && !queued.length) return this.settle(id, null, `staged while talking${age !== null ? ` (frame ${Math.round(age / 1000)} s old)` : ''}`);
      // Not staged on the recording (it was not running in time, or the page refused): the frame still goes with the turn, as a typed line's does when the composer was too
      // short. Nothing waits for it; Convai takes it only sometimes with no lead, but that is better than none.
      if (!entry.staged && entry.images) this.counters.unstagedSent++;
      if (!entry.images && !queued.length) return this.settle(id, null, this.noPictureReason());
      return this.settle(id, [...(entry.images ?? []), ...queued].slice(0, MAX_IMAGES),
        entry.staged ? 'frame and queued pictures' : `${entry.images ? 'frame not staged on the recording, sent with the turn' : 'queued pictures'}${entry.images && queued.length ? ' and queued pictures' : ''}`);
    }
    // The frame staged while V typed, else a young frame, else one capture (at most TURN_CAPTURE_WAIT_MS): never one past the limit.
    // The frame this turn's page holds already (staged while V typed, or when the speaker before began): the same frame goes, so the page publishes nothing new.
    const held = this.takePageFrame(config);
    const frame = held?.frame ?? this.stagedYoung() ?? await this.freshFrame();
    const usable = frame && this.now() - frame.at <= MAX_FRAME_AGE_MS ? frame : null;
    if (!usable) this.counters.turnsWithoutFrame++;
    if (usable) this.noteSent(usable, held ? 'sent with the turn, already staged on its page' : 'sent with the turn');
    const images = [...(usable ? [{mime: usable.mime, base64: usable.base64}] : []), ...queued].slice(0, MAX_IMAGES);
    return this.settle(id, images.length ? images : null,
      images.length ? `${images.length} image(s)${usable ? `, frame ${Math.round((this.now() - usable.at) / 1000)} s old` : ''}${held && usable ? `, on its page ${Math.round((this.now() - held.at) / 1000)} s ahead` : ''}` : this.noPictureReason());
  }
  settle(id, images, what) {
    if (id) { this.remember(this.answered, id, images); this.answeredAt.delete(id); if (images) this.answeredAt.set(id, this.now()); while (this.answeredAt.size > TURN_MEMORY) this.answeredAt.delete(this.answeredAt.keys().next().value); }
    if (images) this.counters.turnsWithPicture++;
    if (id) this.log(`turn ${id.slice(-8)}: ${what}`);
    return images;
  }
  takeQueued(characterId) {
    const now = this.now(), taken = [];
    this.queue = this.queue.filter(entry => {
      if (entry.expiresAt <= now) return false;
      if (entry.characterId && entry.characterId !== characterId) return true;
      taken.push(...entry.images);
      return false;
    });
    return taken;
  }
  // One game picture, or null. Never throws.
  async grab(trigger) {
    let result;
    try { result = await this.capture.capture(); } catch { result = {ok: false, reason: 'failed'}; }
    if (!result?.ok) {
      // A minimised game, or one that is not in front or has a window over it (the border-free capture sees the whole monitor, so it does not take that), is not a failure.
      const quiet = result?.reason === 'minimised' || result?.reason === 'covered';
      if (result?.reason === 'minimised') this.counters.minimised++; else if (result?.reason === 'covered') this.counters.covered++; else this.counters.failed++;
      if (!quiet || this.counters[result.reason] === 1) this.log(`no picture (${trigger}): ${result?.reason ?? 'failed'}`);
      return null;
    }
    this.counters.captures++;
    // Windows drew its yellow border around the game for this picture: from here on no timer capture (`capturing`), and the player is told once.
    if (result.border === true) {
      this.counters.borderCaptures++;
      if (!this.borderNoticeGiven) { this.borderNoticeGiven = true; this.borderNoticePending = true; }
      if (!this.borderLogged) { this.borderLogged = true; this.log(`Windows shows its capture border for these pictures (method ${result.method ?? 'unknown'}): pictures are taken only when a turn needs one`); }
    }
    if (this.counters.captures === 1 || this.counters.captures % 100 === 0)
      this.log(`picture (${trigger}) ${result.width}x${result.height} ${result.bytes} bytes in ${Math.round(result.ms?.total ?? 0)} ms (${this.counters.captures} so far)`);
    if (this.debugDirectory) {
      const path = resolve(this.debugDirectory, `vision-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.jpg`);
      this.writeDebug(path, Buffer.from(result.base64, 'base64')).catch(() => {});
    }
    return {mime: result.mime, base64: result.base64, width: result.width, height: result.height, bytes: result.bytes};
  }
  remember(map, key, value) {
    map.delete(key); map.set(key, value);
    while (map.size > TURN_MEMORY) map.delete(map.keys().next().value);
  }
  diagnostics() {
    const newest = this.frames.at(-1);
    return {enabled: this.enabled, active: this.active, transport: this.transport, frames: this.frames.length,
      newestFrameAgeMs: newest ? this.now() - newest.at : null, capturing: this.capturing, helperRunning: this.capture?.running === true,
      captureMethod: this.capture?.method ?? null, borderShown: this.borderShown, helper: this.capture?.info ?? null,
      queued: this.queue.length, ...this.counters};
  }
  stop() { this.stageRound++; this.nextRound++; this.pageFrames.clear(); this.capture?.stop?.(); }
}
