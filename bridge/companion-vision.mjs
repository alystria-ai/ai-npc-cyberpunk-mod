// "Companions can see" (docs/COMPANION_VISION.md): when V's line asks about something visible, the companion gets one still picture
// of the game window with that turn. Convai only, off by default (settings.json "companionVision").
//
// Policy, all on demand (never per frame, never in the game process):
//  - typed line: the words are known when the turn is admitted; a look-like line starts the capture at once (beginTurn), and the
//    page acquisition overlaps it; the turn waits for it at most CAPTURE_WAIT_MS.
//  - talk key: the bridge already reads what Convai has heard while V talks (publishHeard). The first look-like words start the
//    capture and stage the picture on the voice page while V is still talking (noteHeard), so the finish does not wait for it.
//    If only V's last words ask, the finish captures then (bounded by CAPTURE_WAIT_MS).
//  - other features (YouTube-on-TV) queue their own frames with attachToNextTurn(); they go with the next turn, with or without
//    a game view, composed into the same single picture (bridge/convai-vision.mjs).
// Nothing is saved to disk, except one copy per picture into CYBERPUNK_CONVAI_VISION_DEBUG_DIR when a developer sets it.
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {absoluteRuntimeOverride} from './runtime-paths.mjs';
import {MAX_IMAGES, validImages} from './convai-vision.mjs';

// The longest a turn waits for its game picture (the helper takes ~140 ms, p95 ~190 ms; docs/COMPANION_VISION.md, "Measured").
export const CAPTURE_WAIT_MS = 400;
// How long a queued picture (attachToNextTurn) waits for a turn before it is dropped.
export const QUEUE_TTL_MS = 20000;
const TURN_MEMORY = 32;

// Lines that ask about something V and the companion can see. English only; a miss just means no picture.
export const LOOK_PATTERNS = Object.freeze([
  /\bwhat (?:do|can|did|could) (?:you|ya|u) (?:see|spot|notice|make of)\b/,
  /\b(?:do|can|did) (?:you|ya|u) (?:see|spot|notice)\b/,
  /\b(?:look|looking|check|checking) (?:at|over|around|out|behind|up|down)\b/,
  /\b(?:take|have|get) a (?:look|gander|peek)\b/,
  /\b(?:look|check) (?:this|that|it|these|those)\b/,
  /\bsee (?:that|this|those|these|him|her|them|it|the)\b/,
  /\bhow (?:do|does) (?:i|my \w+|this|it|that|the \w+) look\b/,
  /\bdo i look\b/,
  /\bhow(?:'s| is| are) my (?:outfit|hair|look|clothes|car|ride|bike|jacket|gear|style)\b/,
  /\bwhat (?:am i|i'm|i am) wearing\b/,
  /\bwhat do you think (?:of|about) (?:my|this|that|these|those|the view)\b/,
  /\b(?:what|who)(?:'s| is| are) (?:that|this|those|these|he|she|they) (?:over|there|right|behind|guy|girl|woman|man|thing)\b/,
  /\b(?:what|who)(?:'s| is) (?:that|this)\s*\??\s*$/,
  /\b(?:that|this|those|these) (?:sky|sunset|sunrise|skyline|view|building|tower|car|bike|ride|sign|billboard|crowd|room|place|tv|screen|guy|girl|woman|man|dude|thing|graffiti|ad)\b/,
  /\b(?:nice|great|beautiful|amazing) view\b/,
  /\bover there\b/, /\bright there\b/,
  /\b(?:around|in front of|behind) (?:us|me|you)\b/,
  /\b(?:notice|spot) (?:anything|something|that|this|him|her|them)\b/,
  /\bdescribe (?:the|this|that|what|where|my|your|our|it)\b/,
  /\bon (?:the )?(?:tv|screen)\b/,
]);

export function wantsLook(text) {
  if (typeof text !== 'string' || !text) return false;
  const line = text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  return LOOK_PATTERNS.some(pattern => pattern.test(line));
}

export class CompanionVision {
  // capture: a VisionCapture (bridge/vision-capture.mjs). isConvai(): true while Convai answers (Mistral and Local AI get no picture).
  // stageVoice(images, requestId): hands pictures to the running microphone turn ({staged}). debugDirectory: absolute, optional.
  constructor({capture, isConvai = () => true, stageVoice = async () => ({staged: false}), log = () => {}, now = () => Date.now(),
    debugDirectory = absoluteRuntimeOverride(process.env.CYBERPUNK_CONVAI_VISION_DEBUG_DIR || undefined, 'CYBERPUNK_CONVAI_VISION_DEBUG_DIR'),
    writeDebug = (path, bytes) => writeFile(path, bytes), waitMs = CAPTURE_WAIT_MS} = {}) {
    Object.assign(this, {capture, isConvai, stageVoice, log, now, debugDirectory, writeDebug, waitMs});
    this.enabled = false; this.transport = 'video';
    this.queue = []; this.captures = new Map(); this.voice = new Map(); this.answered = new Map();
    this.counters = {captures: 0, failed: 0, minimised: 0, queued: 0, turnsWithPicture: 0};
  }
  get active() {
    try { return this.enabled && this.isConvai() === true; } catch { return false; }
  }
  // Reads the settings (on the bridge's settings poll, never per turn). Returns true when the setting changed.
  update(settings) {
    const enabled = settings?.companionVision === true;
    const transport = settings?.visionTransport === 'upload' ? 'upload' : 'video';
    const changed = enabled !== this.enabled || transport !== this.transport;
    this.enabled = enabled; this.transport = transport;
    if (changed && enabled) void this.capture?.start?.();   // the helper idles, ready, so the first picture is not slower
    if (changed && !enabled) { this.capture?.stop?.(); this.queue = []; this.captures.clear(); this.voice.clear(); this.answered.clear(); }
    return changed;
  }
  // What the realtime host connects pages with (bridge/realtime-host.mjs): null while vision is off or another provider answers.
  connectConfig() { return this.active ? {transport: this.transport} : null; }

  // ---- public API for other features ------------------------------------------------------------------------------------------
  // Sends `images` with the next conversation turn (typed or talk key), e.g. frames of a TV the companion is watching.
  // images: up to 4 of {mime: 'image/jpeg' | 'image/png' | 'image/webp', base64}; each at most 4 MB. They are composed into one
  // picture with the game view (if that turn has one). Options: characterId (only a turn with that Convai character takes them),
  // ttlMs (dropped if no turn comes in time, default 20 s). Returns {queued: n} or {queued: 0, reason}. Nothing is sent while
  // the setting is off or another provider answers, and nothing is kept on disk.
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

  // ---- turn hooks (bridge/convai-bridge.mjs) ----------------------------------------------------------------------------------
  // A typed turn was admitted: a look-like line starts its capture now.
  beginTurn(input) {
    if (!this.active || !input || input.reaction || typeof input.requestId !== 'string' || !wantsLook(input.text)) return false;
    this.remember(this.captures, input.requestId, this.grab('typed'));
    return true;
  }
  // What Convai has heard of a running recording: the first look-like words capture and stage the picture while V talks.
  noteHeard(requestId, text) {
    if (!this.active || typeof requestId !== 'string' || this.voice.has(requestId) || !wantsLook(text)) return false;
    const entry = {images: null, staged: false};
    this.remember(this.voice, requestId, entry);
    entry.done = (async () => {
      const shot = await this.grab('voice');
      if (!shot || this.voice.get(requestId) !== entry) return;
      entry.images = [shot];
      const result = await this.stageVoice([shot], requestId).catch(() => ({staged: false}));
      entry.staged = result?.staged === true;
      if (!entry.staged) this.log(`picture not staged on the recording (${result?.reason ?? 'unknown'})`);
    })();
    return true;
  }
  // The picture(s) for a turn about to be sent: the game view (if this turn asked) first, then queued pictures. Bounded in time.
  async imagesForTurn(config, {phase = 'reply', heard = ''} = {}) {
    if (!this.active || !config || config.freshSession || config.reaction) return null;
    const id = typeof config.visionTurn === 'string' ? config.visionTurn : null;
    if (id && this.answered.has(id)) return this.answered.get(id);   // a retried turn sends the same picture
    const pictures = [];
    if (phase === 'finish' && id && this.voice.has(id)) {
      const entry = this.voice.get(id);
      await this.within(entry.done, this.waitMs);
      // Already on the page: the finish adds nothing unless queued pictures must be composed with it.
      const queued = this.takeQueued(config.characterId);
      if (!queued.length) return this.settle(id, null, entry.staged ? 'staged-while-talking' : 'no-picture');
      if (entry.images) pictures.push(...entry.images);
      pictures.push(...queued);
    } else {
      let shot = null;
      if (id && this.captures.has(id)) shot = await this.within(this.captures.get(id), this.waitMs);
      else if (phase === 'finish' && wantsLook(heard)) shot = await this.within(this.grab('voice-finish'), this.waitMs);
      if (shot) pictures.push(shot);
      pictures.push(...this.takeQueued(config.characterId));
    }
    const images = pictures.slice(0, MAX_IMAGES);
    return this.settle(id, images.length ? images : null, images.length ? `${images.length} image(s)` : 'none');
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
    if (!this.capture) return null;
    let result;
    try { result = await this.capture.capture(); } catch { result = {ok: false, reason: 'failed'}; }
    if (!result?.ok) {
      if (result?.reason === 'minimised') this.counters.minimised++; else this.counters.failed++;
      this.log(`no picture (${trigger}): ${result?.reason ?? 'failed'}`);
      return null;
    }
    this.counters.captures++;
    this.log(`picture (${trigger}) ${result.width}x${result.height} ${result.bytes} bytes in ${Math.round(result.ms?.total ?? 0)} ms`);
    if (this.debugDirectory) {
      const path = resolve(this.debugDirectory, `vision-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.jpg`);
      this.writeDebug(path, Buffer.from(result.base64, 'base64')).catch(() => {});
    }
    return {mime: result.mime, base64: result.base64};
  }
  within(promise, ms) {
    return new Promise(done => {
      const timer = setTimeout(() => done(null), ms);
      Promise.resolve(promise).then(value => { clearTimeout(timer); done(value ?? null); }, () => { clearTimeout(timer); done(null); });
    });
  }
  remember(map, key, value) {
    map.delete(key); map.set(key, value);
    while (map.size > TURN_MEMORY) map.delete(map.keys().next().value);
  }
  diagnostics() {
    return {enabled: this.enabled, active: this.active, transport: this.transport, queued: this.queue.length, ...this.counters};
  }
  stop() { this.capture?.stop?.(); }
}
