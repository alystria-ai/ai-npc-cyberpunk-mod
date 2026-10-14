// "Companions can see" (docs/COMPANION_VISION.md): with Convai, every conversation turn carries one recent picture of V's
// surroundings. On by default (settings.json "companionVision"; false turns it off, as does CYBERPUNK_CONVAI_VISION=off).
//
// Why a rolling buffer and not a screenshot at talk time: when V talks, V is usually looking at the companion, so a picture taken
// then is mostly her face. The view from a few seconds *before* the conversation shows where they are. So, while a companion (or
// a character V may talk to) is near and no conversation is running, the out-of-process helper takes one game-window picture
// every FRAME_INTERVAL_MS and keeps the last FRAME_SLOTS in memory. Nothing is captured during a conversation or for TAIL_MS
// after it (the view is still on the companion), and a turn takes the newest frame from at least LEAD_MS before the conversation
// started (the moment V turned to talk). Pictures never touch the disk (except CYBERPUNK_CONVAI_VISION_DEBUG_DIR, development).
//
// Latency: the frame is already in memory when V talks. It is published to Convai ahead of the line (stagePage when the composer
// opens, stageVoice when the talk key is pressed), so Convai's acceptance of the frame overlaps typing or talking instead of the
// turn. The unload rule (docs/RESOURCE_LIFECYCLE.md): the helper process exists only while it is capturing: setting on, Convai
// answering, someone near, and no conversation running.
//
// The TV (YouTube on V's TV, setScreenSource): while a video is on, the TV replaces the surroundings. About one frame of the video
// a second is grabbed from our own TV window (no game capture, the helper is released) and fed to the near companions' pages as a
// live video track, so Convai always holds the video's last few seconds and attaches several frames to a turn. The pages reconnect
// with the TV's vision settings when the source changes, between conversations. Nothing is grabbed or published while no video
// plays, the setting is off, another provider answers or nobody is near.
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {absoluteRuntimeOverride} from './runtime-paths.mjs';
import {MAX_IMAGES, validImages} from './convai-vision.mjs';

export const FRAME_INTERVAL_MS = 3000;
export const FRAME_SLOTS = 4;
// A frame this close before the conversation started may already be the companion's face (V turning to talk).
export const LEAD_MS = 2500;
// After the last sign of a conversation (composer, turn, microphone, reply playing) the view is probably still on the companion.
export const TAIL_MS = 12000;
// An older frame is not sent: the scene may have changed (a long ride, a long talk).
export const MAX_FRAME_AGE_MS = 120000;
// How long a queued picture (attachToNextTurn) waits for a turn before it is dropped.
export const QUEUE_TTL_MS = 20000;
// How long ahead-of-time staging keeps retrying while the page is still connecting or the recording is starting.
export const STAGE_RETRY_MS = 6000;
const STAGE_RETRY_EVERY_MS = 250;
const STAGE_ATTEMPTS = Math.ceil(STAGE_RETRY_MS / STAGE_RETRY_EVERY_MS);
const TURN_MEMORY = 32;
// The TV: one frame a second (settings.json "visionTvFps" 1 or 2), the last few kept for a turn whose page has no live track.
export const TV_FRAME_MS = 1000;
export const TV_SLOTS = 4;
export const TV_MAX_FRAME_AGE_MS = 15000;
// A page still connected for the surroundings is reconnected for the TV at most this often.
const TV_REFRESH_RETRY_MS = 10000;
const pageId = config => `${config?.characterId ?? ''}|${config?.scope ?? ''}|${config?.endUserId ?? ''}`;

export const visionDisabledByEnv = (env = process.env) => /^(0|off|false|no)$/i.test(String(env.CYBERPUNK_CONVAI_VISION ?? '').trim());

export class CompanionVision {
  // capture: a VisionCapture (bridge/vision-capture.mjs). isConvai(): true while Convai answers (Mistral and Local AI get no picture).
  // isNear(): a party member or a character V may talk to is around. isConversing(): a composer, turn, recording or reply is running.
  // stageVoice(images): hands pictures to the running microphone turn ({staged, reason}). stagePage(config, images) / unstagePage(config):
  // publish or withdraw a picture on an idle conversation page ahead of the turn ({staged, reason}).
  // The TV: livePages() -> the page configs of the companions near V (fed while a video plays); feedPage(config, image|null) -> {fed,
  // reason} shows one frame on that page's live track (null stops it); refreshPage(config) reconnects an idle page with the current
  // vision settings. All optional; none may throw far.
  constructor({capture, isConvai = () => true, isNear = () => true, isConversing = () => false,
    stageVoice = async () => ({staged: false}), stagePage = async () => ({staged: false}), unstagePage = async () => {},
    livePages = () => [], feedPage = async () => ({fed: false}), refreshPage = async () => false,
    log = () => {}, now = () => Date.now(), env = process.env,
    debugDirectory = absoluteRuntimeOverride(env.CYBERPUNK_CONVAI_VISION_DEBUG_DIR || undefined, 'CYBERPUNK_CONVAI_VISION_DEBUG_DIR'),
    writeDebug = (path, bytes) => writeFile(path, bytes), sleep = ms => new Promise(done => setTimeout(done, ms))} = {}) {
    Object.assign(this, {capture, isConvai, isNear, isConversing, stageVoice, stagePage, unstagePage, livePages, feedPage, refreshPage,
      log, now, debugDirectory, writeDebug, sleep});
    this.envOff = visionDisabledByEnv(env);
    this.enabled = !this.envOff; this.transport = 'video'; this.waitMs = null; this.tvFrameMs = TV_FRAME_MS;
    this.frames = []; this.lastCaptureAt = -Infinity; this.busy = 0; this.frameSerial = 0;
    this.conversing = false; this.conversationStart = null; this.lastConversationAt = -Infinity;
    this.queue = []; this.voice = new Map(); this.answered = new Map(); this.staged = new Map(); this.stageRound = 0;
    this.screen = null; this.mode = 'still'; this.tvFrames = []; this.lastTvAt = -Infinity; this.tvBusy = false; this.live = new Map(); this.refreshed = new Map();
    this.counters = {captures: 0, failed: 0, minimised: 0, queued: 0, turnsWithPicture: 0, turnsWithoutFrame: 0,
      prestaged: 0, helperStarts: 0, helperReleases: 0, tvFrames: 0, tvFailed: 0, liveFed: 0, liveRefreshes: 0, sourceSwitches: 0};
  }
  get active() {
    try { return this.enabled && this.isConvai() === true; } catch { return false; }
  }
  // True while the helper may run: it is capturing frames.
  get capturing() {
    if (!this.active || this.mode === 'tv' || this.conversing || this.now() - this.lastConversationAt < TAIL_MS) return false;
    return this.near;
  }
  get near() { try { return this.isNear() === true; } catch { return false; } }
  // A video is on the TV (playing, paused or ended) and vision is active: the TV is the source.
  get screenWanted() {
    if (!this.active || !this.screen) return false;
    try { return this.screen.present() === true; } catch { return false; }
  }

  // ---- the 500 ms settings poll ----------------------------------------------------------------------------------------------
  // Reads the settings (a missing object changes nothing) and runs one cheap tick: conversation state, the helper's lifetime and,
  // when due, one capture. Returns true when the setting changed. Never per frame and never inside the game.
  update(settings) {
    let changed = false;
    if (settings && typeof settings === 'object') {
      const enabled = !this.envOff && settings.companionVision !== false;
      const transport = settings.visionTransport === 'upload' ? 'upload' : 'video';
      const wait = Number(settings.visionWaitMs);
      changed = enabled !== this.enabled || transport !== this.transport;
      this.enabled = enabled; this.transport = transport;
      this.waitMs = Number.isFinite(wait) ? Math.max(0, Math.min(900, Math.round(wait))) : null;
      this.tvFrameMs = Number(settings.visionTvFps) >= 2 ? TV_FRAME_MS / 2 : TV_FRAME_MS;
      if (changed && !enabled) this.forget();
    }
    this.tick();
    return changed;
  }
  forget() { this.frames = []; this.queue = []; this.voice.clear(); this.answered.clear(); this.closeComposer(); this.endLive(); this.tvFrames = []; }
  tick() {
    let conversing = false;
    try { conversing = this.isConversing() === true; } catch {}
    if (conversing) this.markConversation(); else this.conversing = false;
    if (!this.active) this.frames = [];
    // The source changes between conversations only (the pages reconnect for it); leaving the TV is never held back while vision
    // is off, so nothing stays published.
    const source = this.screenWanted ? 'tv' : 'still';
    if (source !== this.mode && (!this.conversing || !this.active)) this.switchSource(source);
    if (this.mode === 'tv') this.tickScreen();
    const running = this.capture?.running === true;
    if (!this.capturing) {
      if (running && this.busy === 0) {
        this.capture.stop(); this.counters.helperReleases++;
        this.log(`helper released (${!this.active ? 'setting off or another provider' : this.mode === 'tv' ? 'the TV is the source'
          : this.conversing || this.now() - this.lastConversationAt < TAIL_MS ? 'conversation' : 'nobody near'})`);
      }
      return;
    }
    if (this.busy === 0 && this.now() - this.lastCaptureAt >= FRAME_INTERVAL_MS) void this.collect();
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
        this.frames.push({...shot, at: this.lastCaptureAt, serial: ++this.frameSerial});
        while (this.frames.length > FRAME_SLOTS) this.frames.shift();
      }
    } finally { this.busy--; }
  }
  // The frame a turn sends: the newest one at least LEAD_MS older than the conversation's start, else the newest, never one older
  // than MAX_FRAME_AGE_MS. Null when there is none.
  frame() {
    const now = this.now();
    // The TV: its newest frame (used only by a page without the live track, e.g. a group's page).
    if (this.mode === 'tv') return this.tvFrames.filter(frame => now - frame.at <= TV_MAX_FRAME_AGE_MS).at(-1) ?? null;
    const fresh = this.frames.filter(frame => now - frame.at <= MAX_FRAME_AGE_MS);
    if (!fresh.length) return null;
    const start = this.conversationStart ?? now;
    return [...fresh].reverse().find(frame => frame.at <= start - LEAD_MS) ?? fresh.at(-1);
  }
  connectConfig() { return this.active ? {transport: this.transport, ...(this.mode === 'tv' ? {mode: 'tv'} : {})} : null; }
  turnWaitMs() { return this.waitMs; }

  // ---- the TV as the source (bridge/youtube-tv-host.mjs visionSource) ----------------------------------------------------------
  // source: {present() -> a video is on the TV, playing() -> it is playing and visible now, grab() -> {mime, base64} | null}, or
  // null. Read on each tick; nothing is grabbed unless present, playing, vision active and someone near.
  setScreenSource(source) {
    this.screen = source && typeof source.present === 'function' && typeof source.grab === 'function' ? source : null;
    this.tick();
  }
  pages() {
    try { const list = this.livePages(); return Array.isArray(list) ? list.filter(config => config && typeof config === 'object').slice(0, 3) : []; }
    catch { return []; }
  }
  switchSource(next) {
    const previous = this.mode;
    this.mode = next; this.counters.sourceSwitches++;
    if (previous === 'tv') { this.endLive(); this.tvFrames = []; }
    this.log(`source: ${next === 'tv' ? 'the TV' : 'the surroundings'}`);
    if (!this.active) return;
    // The near companions' open pages reconnect now with the matching vision settings, so no turn pays for it.
    for (const config of this.pages()) this.refresh(config);
  }
  refresh(config) {
    this.counters.liveRefreshes++;
    this.remember(this.refreshed, pageId(config), this.now());
    void Promise.resolve().then(() => this.refreshPage(config)).catch(() => false);
  }
  tickScreen() {
    if (!this.screenWanted || !this.near) { this.endLive(); if (!this.screenWanted) this.tvFrames = []; return; }
    let playing = false;
    try { playing = this.screen.playing() === true; } catch {}
    if (!playing || this.tvBusy || this.now() - this.lastTvAt < this.tvFrameMs) return;
    void this.collectScreen();
  }
  async collectScreen() {
    this.tvBusy = true; this.lastTvAt = this.now();
    try {
      let shot = null;
      try { shot = await this.screen.grab(); } catch {}
      const [image] = validImages(shot ? [shot] : []);
      if (!image) { this.counters.tvFailed++; return; }
      if (this.mode !== 'tv' || !this.screenWanted) return;
      this.counters.tvFrames++;
      this.tvFrames.push({...image, at: this.lastTvAt});
      while (this.tvFrames.length > TV_SLOTS) this.tvFrames.shift();
      for (const config of this.pages()) this.feed(config, image);
    } finally { this.tvBusy = false; }
  }
  // One frame to one page; a page still answering the previous frame skips this one.
  feed(config, image) {
    const key = pageId(config);
    const live = this.live.get(key) ?? {config, pending: false, fed: false};
    if (live.pending) return;
    live.pending = true; live.config = config; this.live.set(key, live);
    void Promise.resolve().then(() => this.feedPage(config, image)).catch(() => ({fed: false, reason: 'failed'})).then(result => {
      live.pending = false;
      if (this.live.get(key) !== live) { if (result?.fed) void Promise.resolve().then(() => this.feedPage(config, null)).catch(() => {}); return; }
      if (result?.fed) { live.fed = true; this.counters.liveFed++; return; }
      // Connected for the surroundings (opened before the video started): reconnect it for the TV, between conversations.
      if (result?.reason === 'wrong-mode' && !this.conversing && this.now() - (this.refreshed.get(key) ?? -Infinity) >= TV_REFRESH_RETRY_MS) {
        this.refresh(config);
      }
    });
  }
  // Stops every page's live track (the video stopped, nobody is near, vision went off). Never throws.
  endLive() {
    for (const live of this.live.values()) if (live.fed) void Promise.resolve().then(() => this.feedPage(live.config, null)).catch(() => {});
    this.live.clear();
  }

  // ---- public API for other features ------------------------------------------------------------------------------------------
  // Sends `images` with the next conversation turn, e.g. frames of a TV the companion is watching. images: up to 4 of
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
  // types, retried while a page is still connecting. Queued pictures are not staged ahead (they may arrive later).
  openComposer(configs) {
    if (!this.active || !Array.isArray(configs) || !configs.length) return false;
    this.markConversation();
    const frame = this.frame();
    if (!frame) return false;
    const round = ++this.stageRound, images = [{mime: frame.mime, base64: frame.base64}];
    for (const config of configs) void this.stageAhead(round, config, images);
    return true;
  }
  async stageAhead(round, config, images) {
    const until = this.now() + STAGE_RETRY_MS;
    for (let attempt = 0; attempt <= STAGE_ATTEMPTS && round === this.stageRound && this.active; attempt++) {
      let result;
      try { result = await this.stagePage(config, images); } catch { result = {staged: false, reason: 'failed'}; }
      if (result?.staged) { this.staged.set(config, round); this.counters.prestaged++; return true; }
      if (!['no-page', 'busy', 'connecting', 'no-video-session'].includes(result?.reason) || this.now() >= until) return false;
      await this.sleep(STAGE_RETRY_EVERY_MS);
    }
    return false;
  }
  // The composer closed: pictures staged on pages that no turn took are withdrawn (each page also drops one after a minute).
  closeComposer() {
    this.stageRound++;
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
    const frame = this.frame();
    const entry = {images: frame ? [{mime: frame.mime, base64: frame.base64}] : null, staged: false};
    this.remember(this.voice, requestId, entry);
    if (!entry.images) { entry.done = Promise.resolve(); return false; }
    entry.done = (async () => {
      const until = this.now() + STAGE_RETRY_MS;
      for (let attempt = 0; attempt <= STAGE_ATTEMPTS && this.voice.get(requestId) === entry && this.active; attempt++) {
        const result = await this.stageVoice(entry.images, requestId).catch(() => ({staged: false, reason: 'failed'}));
        if (result?.staged) { entry.staged = true; return; }
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
      if (!queued.length) return this.settle(id, null, entry.staged ? 'staged while talking' : entry.images ? 'not staged' : 'no frame yet');
      return this.settle(id, [...(entry.images ?? []), ...queued].slice(0, MAX_IMAGES), 'frame and queued pictures');
    }
    const frame = this.frame();
    if (!frame) this.counters.turnsWithoutFrame++;
    const images = [...(frame ? [{mime: frame.mime, base64: frame.base64}] : []), ...queued].slice(0, MAX_IMAGES);
    return this.settle(id, images.length ? images : null,
      images.length ? `${images.length} image(s)${frame ? `, frame ${Math.round((this.now() - frame.at) / 1000)} s old` : ''}` : 'no frame yet');
  }
  settle(id, images, what) {
    if (id) this.remember(this.answered, id, images);
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
      if (result?.reason === 'minimised') this.counters.minimised++; else this.counters.failed++;
      if (result?.reason !== 'minimised' || this.counters.minimised === 1) this.log(`no picture (${trigger}): ${result?.reason ?? 'failed'}`);
      return null;
    }
    this.counters.captures++;
    if (this.counters.captures === 1 || this.counters.captures % 100 === 0)
      this.log(`picture (${trigger}) ${result.width}x${result.height} ${result.bytes} bytes in ${Math.round(result.ms?.total ?? 0)} ms (${this.counters.captures} so far)`);
    if (this.debugDirectory) {
      const path = resolve(this.debugDirectory, `vision-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.jpg`);
      this.writeDebug(path, Buffer.from(result.base64, 'base64')).catch(() => {});
    }
    return {mime: result.mime, base64: result.base64};
  }
  remember(map, key, value) {
    map.delete(key); map.set(key, value);
    while (map.size > TURN_MEMORY) map.delete(map.keys().next().value);
  }
  diagnostics() {
    const newest = this.frames.at(-1);
    return {enabled: this.enabled, active: this.active, transport: this.transport, source: this.mode, frames: this.frames.length,
      newestFrameAgeMs: newest ? this.now() - newest.at : null, capturing: this.capturing, helperRunning: this.capture?.running === true,
      tvFrames: this.tvFrames.length, livePages: [...this.live.values()].filter(live => live.fed).length,
      queued: this.queue.length, ...this.counters};
  }
  stop() { this.stageRound++; this.endLive(); this.capture?.stop?.(); }
}
