// The game-window still picture for "Companions can see" (docs/COMPANION_VISION.md): a thin client of the native helper
// native/vision/CyberpunkConvaiVision.exe. The helper runs out of process at below-normal priority and holds no capture
// session between requests, so an idle helper costs the game nothing; a capture is one Windows Graphics Capture frame of the
// game's own window (never the desktop), scaled and encoded as a JPEG in memory. Nothing is written to disk here.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {absoluteRuntimeOverride} from './runtime-paths.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HELPER_NAME = 'CyberpunkConvaiVision.exe';
// Where the helper is looked for: the operator's override, the release layout (next to the bridge's runtime) and the
// development build output. The first that exists wins.
export function helperCandidates({env = process.env, projectDirectory = project} = {}) {
  const override = absoluteRuntimeOverride(env.CYBERPUNK_CONVAI_VISION_HELPER, 'CYBERPUNK_CONVAI_VISION_HELPER');
  return [override, resolve(projectDirectory, 'vision', HELPER_NAME), resolve(projectDirectory, 'dist/vision', HELPER_NAME)]
    .filter(Boolean);
}

export const CAPTURE_DEFAULTS = Object.freeze({maxWidth: 768, quality: 80, timeoutMs: 2500, readyTimeoutMs: 5000});
const REASONS = new Set(['no-window', 'minimised', 'unsupported', 'no-frame', 'failed', 'bad-request']);

export class VisionCapture {
  // spawnHelper(path) -> a ChildProcess-like object (tests pass a fake). exists(path) -> boolean.
  constructor({candidates = helperCandidates(), spawnHelper = path => spawn(path, [], {windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']}),
    exists = existsSync, log = () => {}} = {}) {
    Object.assign(this, {candidates, spawnHelper, exists, log});
    this.child = null; this.ready = null; this.queue = Promise.resolve(); this.waiting = []; this.buffer = '';
  }
  get path() { return this.candidates.find(path => this.exists(path)) ?? null; }
  get available() { return this.path !== null; }
  // Starts the helper (idempotent). Resolves true once it reports ready, false when it is missing or cannot start.
  start({readyTimeoutMs = CAPTURE_DEFAULTS.readyTimeoutMs} = {}) {
    if (this.ready) return this.ready;
    const path = this.path;
    if (!path) { this.log('vision helper not found'); return Promise.resolve(false); }
    let child;
    try { child = this.spawnHelper(path); } catch (error) { this.log(`vision helper did not start: ${error.message}`); return Promise.resolve(false); }
    this.child = child; this.buffer = '';
    const ready = new Promise(resolveReady => {
      const timer = setTimeout(() => { this.log('vision helper did not become ready'); this.stop(); resolveReady(false); }, readyTimeoutMs);
      this.waiting.push({resolve: message => { clearTimeout(timer); resolveReady(message?.ready === true); }, ready: true});
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
      if (!await this.start()) return normalise({ok: false, reason: this.available ? 'failed' : 'unavailable'});
      const child = this.child;
      const reply = await new Promise(resolveReply => {
        const timer = setTimeout(() => { resolveReply({ok: false, reason: 'timeout'}); if (this.child === child) { this.stop(); } }, timeoutMs);
        this.waiting.push({resolve: message => { clearTimeout(timer); resolveReply(message); }});
        try { child.stdin.write(`capture ${width} ${level}\n`); }
        catch { clearTimeout(timer); resolveReply({ok: false, reason: 'failed'}); }
      });
      return normalise(reply);
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
      sourceWidth: reply.sourceWidth, sourceHeight: reply.sourceHeight, bytes: reply.bytes, ms: reply.ms ?? {}};
  }
  const reason = typeof reply?.reason === 'string' && (REASONS.has(reply.reason) || reply.reason === 'timeout' || reply.reason === 'unavailable')
    ? reply.reason : 'failed';
  return {ok: false, reason, ms: reply?.ms ?? {}};
}
