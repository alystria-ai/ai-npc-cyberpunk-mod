// One scheduler for every request the bridge sends to api.mistral.ai (text replies, text-to-speech, background work).
//
// Why: a free Mistral key may be limited to about one request per second for the whole workspace, so a text reply and the
// spoken form of the previous one, or two group speakers, can collide. The scheduler spaces the *starts* of requests
// (default 1.05 s; a request that is already running is never held back), serves the most urgent waiting request first
// (PRIORITY.TEXT before PRIORITY.TTS before PRIORITY.BACKGROUND, oldest first within a level), and when Mistral answers 429 it
// pauses every start for the server's `retry-after`.
//
// Measured 2026-10-12 on the developer's free key: three requests started at the same moment (two text, one TTS) all answered
// 200; the response headers carry only per-minute limits (requests and tokens for text, input characters for TTS) and no
// per-second one. The spacing is therefore a precaution that costs a request at most about a second of waiting when two
// start together; it is raised if a per-second header or a 429 says so (docs/CLOUD_VOICE_VOXTRAL.md).
//
// API (shared instance: `import {mistralScheduler, PRIORITY} from './mistral-rate.mjs'`):
//   mistralScheduler.schedule(task, {priority = PRIORITY.TEXT, signal, retries = 0, maxQueueMs, label})
//     task({signal, sentAt, attempt}) is called when the request may start; `sentAt` is that moment (start first-audio or
//     first-token timers from it, not from the call to schedule). It returns a promise; its value or error is what schedule
//     returns. A task that throws an error with status 429 (and no `zeroQuota`) is run again, up to `retries` times, after
//     the error's `retryAfterMs` (else the spacing), ahead of anything of lower priority.
//     `signal` aborting while queued rejects with an AbortError and the task never runs; once started, the task owns its signal.
//     `maxQueueMs`: waiting longer than this in the queue rejects with an error whose `code` is 'queue-timeout' (the task never runs).
//   mistralScheduler.noteHeaders(headers)   call with every response's Headers: a per-second limit header sets the spacing.
//   mistralScheduler.pause(ms)              nothing starts for ms (a 429 outside schedule's own retry, e.g. one handled by the caller).
//   mistralScheduler.stats()                {spacingMs, queued, started, pausedForMs}, for the diagnostics.
import {cancelled} from './transport-pool.mjs';

export const PRIORITY = Object.freeze({TEXT: 0, TTS: 1, BACKGROUND: 2});
export const DEFAULT_SPACING_MS = 1050;
const MIN_SPACING_MS = 250, MAX_SPACING_MS = 5000, MAX_PAUSE_MS = 60_000;

export class MistralScheduler {
  constructor({spacingMs = DEFAULT_SPACING_MS, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
    Object.assign(this, {baseSpacingMs: spacingMs, now, setTimer, clearTimer});
    this.spacing = spacingMs; this.queue = []; this.sequence = 0;
    this.lastStart = -Infinity; this.pausedUntil = 0; this.timer = null; this.timerAt = 0;
    this.started = 0; this.calm = 0;
  }
  get spacingMs() { return this.spacing; }

  schedule(task, {priority = PRIORITY.TEXT, signal, retries = 0, maxQueueMs, label} = {}) {
    if (typeof task !== 'function') return Promise.reject(Error('A scheduled Mistral request needs a task'));
    if (signal?.aborted) return Promise.reject(signal.reason ?? cancelled());
    return new Promise((resolve, reject) => {
      const entry = {task, priority, seq: ++this.sequence, signal, retries, attempt: 0, label, resolve, reject,
        enqueuedAt: this.now(), maxQueueMs: Number.isFinite(maxQueueMs) ? maxQueueMs : Infinity};
      entry.onAbort = () => {
        const at = this.queue.indexOf(entry);
        if (at < 0) return;
        this.queue.splice(at, 1);
        reject(signal.reason ?? cancelled());
        this.pump();
      };
      signal?.addEventListener('abort', entry.onAbort, {once: true});
      this.queue.push(entry);
      this.pump();
    });
  }

  /** A 429 handled by the caller: no request starts for `ms` (at most a minute). */
  pause(ms) {
    const wait = Math.min(Math.max(Number(ms) || this.spacing, 0), MAX_PAUSE_MS);
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    this.calm = 0;
    this.spacing = Math.min(MAX_SPACING_MS, Math.round(this.spacing * 1.25));
    this.pump();
  }

  /** Reads a response's rate-limit headers. Only a per-second request limit changes the spacing; per-minute and per-model figures do not. */
  noteHeaders(headers) {
    const read = name => { const raw = headers?.get?.(name); const value = raw === null || raw === undefined || raw === '' ? NaN : Number(raw); return Number.isFinite(value) ? value : null; };
    const perSecond = read('x-ratelimit-limit-req-second') ?? read('x-ratelimit-limit-requests-second');
    if (perSecond && perSecond > 0) {
      this.spacing = Math.min(MAX_SPACING_MS, Math.max(MIN_SPACING_MS, Math.ceil(1000 / perSecond * 1.05)));
      this.calm = 0;
    } else if (++this.calm >= 20 && this.spacing > this.baseSpacingMs) {
      // Twenty good answers in a row after a 429: ease back toward the default.
      this.spacing = Math.max(this.baseSpacingMs, Math.round(this.spacing * 0.9)); this.calm = 0;
    }
  }

  stats() {
    return {spacingMs: this.spacing, queued: this.queue.length, started: this.started, pausedForMs: Math.max(0, this.pausedUntil - this.now())};
  }

  expire(time) {
    for (const entry of this.queue.slice()) {
      if (time - entry.enqueuedAt < entry.maxQueueMs) continue;
      this.queue.splice(this.queue.indexOf(entry), 1);
      entry.signal?.removeEventListener('abort', entry.onAbort);
      entry.reject(Object.assign(Error('Mistral request waited too long for its turn'), {code: 'queue-timeout'}));
    }
  }

  pump() {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    for (;;) {
      const time = this.now();
      this.expire(time);
      if (!this.queue.length) return;
      const due = Math.max(this.lastStart + this.spacing, this.pausedUntil);
      if (time >= due) { this.start(this.take(), time); continue; }
      // Wake for the next start or the next queue expiry, whichever comes first.
      let wake = due;
      for (const entry of this.queue) if (entry.maxQueueMs !== Infinity) wake = Math.min(wake, entry.enqueuedAt + entry.maxQueueMs);
      this.timer = this.setTimer(() => { this.timer = null; this.pump(); }, Math.max(1, Math.ceil(wake - time)));
      return;
    }
  }

  take() {
    let best = 0;
    for (let at = 1; at < this.queue.length; at++) {
      const a = this.queue[at], b = this.queue[best];
      if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = at;
    }
    return this.queue.splice(best, 1)[0];
  }

  start(entry, time) {
    entry.signal?.removeEventListener('abort', entry.onAbort);
    this.lastStart = time; this.started++;
    const attempt = entry.attempt++;
    Promise.resolve().then(() => entry.task({signal: entry.signal, sentAt: time, attempt})).then(entry.resolve, error => {
      if (error?.status === 429 && !error.zeroQuota && attempt < entry.retries && !entry.signal?.aborted) {
        // Wait out the server's retry-after for everything, then run this one again before lower priorities.
        this.pause(error.retryAfterMs ?? this.spacing);
        entry.signal?.addEventListener('abort', entry.onAbort, {once: true});
        entry.enqueuedAt = this.now();
        this.queue.push(entry);
        this.pump();
        return;
      }
      entry.reject(error);
    });
  }
}

/** The one scheduler every Mistral request of this bridge goes through. */
export const mistralScheduler = new MistralScheduler();
