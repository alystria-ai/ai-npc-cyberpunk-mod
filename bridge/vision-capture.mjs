// The game-window still picture for "Companions can see" (docs/COMPANION_VISION.md): a thin client of the native helper
// native/vision/CyberpunkConvaiVision.exe. The helper runs out of process at below-normal priority and holds no capture
// session between requests, so an idle helper costs the game nothing; a capture is one frame of the game's own window, cropped to
// its client area, scaled and encoded as a JPEG in memory. Nothing is written to disk here. The helper takes the frame by Desktop
// Duplication (no Windows capture border) while the game is in front, and by Windows Graphics Capture (which draws a yellow border,
// `borderShown` here) only on a system where the duplication cannot be made.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {absoluteRuntimeOverride} from './runtime-paths.mjs';
import {markBridgeStage} from './stage-marker.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HELPER_NAME = 'CyberpunkConvaiVision.exe';
// Where the helper is looked for: the operator's override, the release layout (next to the bridge's runtime) and the
// development build output. The first that exists wins.
export function helperCandidates({env = process.env, projectDirectory = project} = {}) {
  const override = absoluteRuntimeOverride(env.CYBERPUNK_CONVAI_VISION_HELPER, 'CYBERPUNK_CONVAI_VISION_HELPER');
  return [override, resolve(projectDirectory, 'vision', HELPER_NAME), resolve(projectDirectory, 'dist/vision', HELPER_NAME)]
    .filter(Boolean);
}

// 1024 px at JPEG quality 88 (was 768 at 80). Measured against the running game: the capture takes the same time, because it is the
// compositor's next frame that is waited for, not the scaling or the encoding (docs/COMPANION_VISION.md, section 4).
export const CAPTURE_DEFAULTS = Object.freeze({maxWidth: 1024, quality: 88, timeoutMs: 2500, readyTimeoutMs: 5000});
// 'covered': the border-free capture (Desktop Duplication) only takes the game while it is in front with nothing clickable over it; 'dxgi-unavailable': this
// system cannot make that duplication (the helper then falls back to the capture that shows Windows' yellow border).
const REASONS = new Set(['no-window', 'minimised', 'unsupported', 'no-frame', 'failed', 'bad-request', 'covered', 'dxgi-unavailable']);

export class VisionCapture {
  // spawnHelper(path) -> a ChildProcess-like object (tests pass a fake). exists(path) -> boolean.
  constructor({candidates = helperCandidates(), spawnHelper = path => spawn(path, [], {windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']}),
    exists = existsSync, log = () => {}} = {}) {
    Object.assign(this, {candidates, spawnHelper, exists, log});
    this.child = null; this.ready = null; this.queue = Promise.resolve(); this.waiting = []; this.buffer = '';
    // What the helper said about itself when it started ({build, wgc, borderless}; null for a helper from before it told), and what its newest picture showed:
    // `border` true when Windows drew its yellow capture border around the game for it, false when it did not, null when not known yet.
    this.info = null; this.border = null; this.method = null;
  }
  // True once a picture was taken with Windows' yellow capture border showing. The border flashes for as long as the capture lasts, so a caller must not capture on a
  // timer while this is true: only when a reply needs a picture (bridge/companion-vision.mjs).
  get borderShown() { return this.border === true; }
  get path() { return this.candidates.find(path => this.exists(path)) ?? null; }
  get available() { return this.path !== null; }
  // True while a helper process exists (starting or ready).
  get running() { return this.child !== null; }
  // Starts the helper (idempotent). Resolves true once it reports ready, false when it is missing or cannot start.
  start({readyTimeoutMs = CAPTURE_DEFAULTS.readyTimeoutMs} = {}) {
    if (this.ready) return this.ready;
    const path = this.path;
    if (!path) { this.log('vision helper not found'); return Promise.resolve(false); }
    markBridgeStage('vision.helper-start');
    let child;
    try { child = this.spawnHelper(path); } catch (error) { this.log(`vision helper did not start: ${error.message}`); return Promise.resolve(false); }
    this.child = child; this.buffer = '';
    const ready = new Promise(resolveReady => {
      const timer = setTimeout(() => { this.log('vision helper did not become ready'); this.stop(); resolveReady(false); }, readyTimeoutMs);
      this.waiting.push({resolve: message => {
        clearTimeout(timer);
        if (message?.ready === true && Number.isInteger(message.build)) this.info = {build: message.build, wgc: message.wgc === true, borderless: message.borderless === true};
        resolveReady(message?.ready === true);
      }, ready: true});
    });
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', chunk => this.receive(String(chunk)));
    const gone = () => { if (this.child === child) this.reset('vision helper exited'); };
    child.on('exit', gone); child.on('error', gone);
    child.stdin.on?.('error', () => {});
    this.ready = ready.then(ok => { if (!ok && this.child === child) this.stop(); return ok; });
    return this.ready;
  }
  receive(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { message = {ok: false, reason: 'failed'}; }
      this.waiting.shift()?.resolve(message);
    }
  }
  reset(reason) {
    this.child = null; this.ready = null; this.buffer = '';
    for (const waiter of this.waiting.splice(0)) waiter.resolve(waiter.ready ? {ready: false} : {ok: false, reason: 'failed'});
    if (reason) this.log(reason);
  }
  // One still picture: {ok: true, mime, base64, width, height, sourceWidth, sourceHeight, bytes, ms} or {ok: false, reason}.
  // Requests are served one at a time; a capture that overruns timeoutMs restarts the helper.
  capture({maxWidth = CAPTURE_DEFAULTS.maxWidth, quality = CAPTURE_DEFAULTS.quality, timeoutMs = CAPTURE_DEFAULTS.timeoutMs} = {}) {
    const width = Math.round(Math.min(2048, Math.max(64, Number(maxWidth) || CAPTURE_DEFAULTS.maxWidth)));
    const level = Math.round(Math.min(100, Math.max(1, Number(quality) || CAPTURE_DEFAULTS.quality)));
    const run = async () => {
      markBridgeStage('vision.capture');
      if (!await this.start()) return normalise({ok: false, reason: this.available ? 'failed' : 'unavailable'});
      const child = this.child;
      const reply = await new Promise(resolveReply => {
        const timer = setTimeout(() => { resolveReply({ok: false, reason: 'timeout'}); if (this.child === child) { this.stop(); } }, timeoutMs);
        this.waiting.push({resolve: message => { clearTimeout(timer); resolveReply(message); }});
        // "auto": a borderless capture where the system allows one, else Desktop Duplication (no border), else the capture that shows the border. A helper from before
        // the third word ignores it. "view" (2026-10-30): only the middle of the frame, without the HUD around its edges (the minimap, the quest tracker, phone notices,
        // subtitles and the mod's text box), which a model read as V "staring at a screen" and talked about (docs/NATURAL_TALK_RESEARCH_2026-10-30.md). A helper from before it
        // ignores the word and sends the whole frame.
        try { child.stdin.write(`capture ${width} ${level} auto view\n`); }
        catch { clearTimeout(timer); resolveReply({ok: false, reason: 'failed'}); }
      });
      const shot = normalise(reply);
      if (shot.ok) { this.method = shot.method ?? null; this.border = typeof shot.border === 'boolean' ? shot.border : this.border; }
      return shot;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }
  stop() {
    const child = this.child;
    this.reset();
    if (!child) return;
    try { child.stdin.end('quit\n'); } catch {}
    // A helper that does not leave on end of input is stopped.
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 1000);
    timer.unref?.();
    child.once?.('exit', () => clearTimeout(timer));
  }
}

export function normalise(reply) {
  if (reply?.ok === true && typeof reply.jpeg === 'string' && reply.jpeg.length > 0
      && Number.isInteger(reply.width) && Number.isInteger(reply.height)) {
    return {ok: true, mime: 'image/jpeg', base64: reply.jpeg, width: reply.width, height: reply.height,
      sourceWidth: reply.sourceWidth, sourceHeight: reply.sourceHeight, bytes: reply.bytes, ms: reply.ms ?? {},
      ...(reply.method === 'dxgi' || reply.method === 'wgc' ? {method: reply.method} : {}), ...(typeof reply.border === 'boolean' ? {border: reply.border} : {})};
  }
  const reason = typeof reply?.reason === 'string' && (REASONS.has(reply.reason) || reply.reason === 'timeout' || reply.reason === 'unavailable')
    ? reply.reason : 'failed';
  return {ok: false, reason, ms: reply?.ms ?? {}};
}
