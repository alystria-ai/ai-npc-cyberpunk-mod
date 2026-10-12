// One scheduler for every request the bridge sends to api.mistral.ai (text replies, text-to-speech, background work).
//
// Why: a free Mistral key shares its allowance between everything on the workspace, so a text reply, the speech of the previous one
// and a background summary all draw on it. Measured 2026-10-12 on the developer's free key: there is NO per-second limit (a text, a
// speech and a text back to back, and three requests started at the same moment, all answered 200); the response headers carry only
// per-minute limits (188 requests a minute for ministral-8b text, about 12,000 characters a minute for speech). So:
//   - a request STARTS IMMEDIATELY (the default spacing is 0); a request already running never holds the next one back;
//   - when requests do wait (a pause, or the slow mode below), the most urgent goes first: PRIORITY.TEXT before PRIORITY.TTS before
//     PRIORITY.BACKGROUND, oldest first within a level;
//   - the per-minute headers of every answer are read; only when an allowance is nearly used up (10% or 2 requests left) does the
//     scheduler slow down (an even spread of a request allowance over the minute, else about one start a second), and it relaxes when
//     a later answer shows room again or after 30 s; an allowance at 0 pauses starts until its Retry-After (else 5 s);
//   - on a 429 every start pauses for the server's `retry-after`, then starts are kept about 1 s apart for a minute, then relaxed
//     (docs/CLOUD_VOICE_VOXTRAL.md).
//
// API (shared instance: `import {mistralScheduler, PRIORITY} from './mistral-rate.mjs'`):
//   mistralScheduler.schedule(task, {priority = PRIORITY.TEXT, signal, retries = 0, maxQueueMs, label})
//     task({signal, sentAt, attempt}) is called when the request may start; `sentAt` is that moment (start first-audio or
//     first-token timers from it, not from the call to schedule). It returns a promise; its value or error is what schedule
//     returns. A task that throws an error with status 429 (and no `zeroQuota`) is run again, up to `retries` times, after
//     the error's `retryAfterMs` (else a second), ahead of anything of lower priority.
//     `signal` aborting while queued rejects with an AbortError and the task never runs; once started, the task owns its signal.
//     `maxQueueMs`: waiting longer than this in the queue rejects with an error whose `code` is 'queue-timeout' (the task never runs).
//   mistralScheduler.noteHeaders(headers)   call with every response's Headers (see above).
//   mistralScheduler.pause(ms)              nothing starts for ms (a 429 outside schedule's own retry, e.g. one handled by the caller);
//                                           it also starts the one-minute slow mode.
//   mistralScheduler.stats()                {spacingMs, queued, started, pausedForMs, slowForMs}, for the diagnostics.
import {cancelled} from './transport-pool.mjs';

export const PRIORITY = Object.freeze({TEXT: 0, TTS: 1, BACKGROUND: 2});
export const DEFAULT_SPACING_MS = 0;        // starts are not spaced unless the server says so
export const SLOW_SPACING_MS = 1000;        // the spacing while slowed down (after a 429, or with an allowance nearly used up)
const MIN_SPACING_MS = 250, MAX_SPACING_MS = 5000, MAX_PAUSE_MS = 60_000;
const SLOW_AFTER_429_MS = 60_000, SLOW_AFTER_HEADERS_MS = 30_000, EMPTY_PAUSE_MS = 5000;
const LOW_FRACTION = 0.1, LOW_COUNT = 2;

export class MistralScheduler {
  constructor({spacingMs = DEFAULT_SPACING_MS, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
    Object.assign(this, {baseSpacingMs: spacingMs, now, setTimer, clearTimer});
    this.spacing = spacingMs; this.queue = []; this.sequence = 0;
    this.lastStart = -Infinity; this.pausedUntil = 0; this.timer = null; this.timerAt = 0;
    this.started = 0;
    this.slowUntil = 0; this.slowSpacing = SLOW_SPACING_MS; this.slowFrom429 = false;
  }
  /** The spacing in force now: the base (0 unless a per-second header set one), or the slow-mode spacing while that lasts. */
  get spacingMs() { return this.now() < this.slowUntil ? Math.max(this.spacing, this.slowSpacing) : this.spacing; }

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

  /** A 429 handled by the caller: no request starts for `ms` (at most a minute), then starts are kept about a second apart for a minute. */
  pause(ms) {
    const wait = Math.min(Math.max(Number(ms) || SLOW_SPACING_MS, 0), MAX_PAUSE_MS);
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    this.slowUntil = Math.max(this.slowUntil, this.now() + SLOW_AFTER_429_MS);
    this.slowSpacing = SLOW_SPACING_MS; this.slowFrom429 = true;
    this.pump();
  }

  /**
   * Reads a response's rate-limit headers. A per-second request limit sets the base spacing. Per-minute figures change nothing until
   * an allowance is nearly used up (10% or 2 left): then starts are slowed (an even spread of a request allowance over the minute,
   * else about a second) for 30 s, or until a later answer shows room. An allowance at 0 pauses starts until Retry-After (else 5 s).
   */
  noteHeaders(headers) {
    const read = name => { const raw = headers?.get?.(name); const value = raw === null || raw === undefined || raw === '' ? NaN : Number(raw); return Number.isFinite(value) ? value : null; };
    const perSecond = read('x-ratelimit-limit-req-second') ?? read('x-ratelimit-limit-requests-second');
    if (perSecond && perSecond > 0) this.spacing = Math.min(MAX_SPACING_MS, Math.max(MIN_SPACING_MS, Math.ceil(1000 / perSecond * 1.05)));
    // Every per-minute allowance the answer reports: {name: {limit, remaining}}.
    const allowances = new Map();
    const note = (name, value) => {
      const match = /^x-ratelimit-(limit|remaining)-(.+)-minute$/.exec(String(name).toLowerCase());
      if (!match || !Number.isFinite(value)) return;
      const entry = allowances.get(match[2]) ?? {};
      entry[match[1]] = value; allowances.set(match[2], entry);
    };
    try { if (typeof headers?.forEach === 'function') headers.forEach((value, name) => note(name, Number(value))); } catch { /* not iterable */ }
    for (const name of ['req', 'requests', 'tokens', 'chars', 'characters', 'input-characters', 'input-chars']) {
      for (const kind of ['limit', 'remaining']) {
        const header = `x-ratelimit-${kind}-${name}-minute`;
        const value = read(header);
        if (value !== null) note(header, value);
      }
    }
    let low = null, empty = false;
    for (const [name, {limit, remaining}] of allowances) {
      if (!(limit > 0) || !(remaining >= 0)) continue;
      if (remaining === 0) empty = true;
      if (remaining <= Math.max(LOW_COUNT, limit * LOW_FRACTION)) {
        const spacing = /^req/.test(name) ? Math.min(MAX_SPACING_MS, Math.max(MIN_SPACING_MS, Math.ceil(60_000 / limit * 1.1))) : SLOW_SPACING_MS;
        low = Math.max(low ?? 0, spacing);
      }
    }
    const now = this.now();
    if (empty) {
      const retry = read('retry-after');
      this.pausedUntil = Math.max(this.pausedUntil, now + Math.min(MAX_PAUSE_MS, retry !== null ? retry * 1000 : EMPTY_PAUSE_MS));
    }
    if (low !== null) {
      this.slowSpacing = Math.max(low, this.slowFrom429 && now < this.slowUntil ? this.slowSpacing : 0);
      this.slowUntil = Math.max(this.slowUntil, now + SLOW_AFTER_HEADERS_MS);
    } else if (allowances.size && !this.slowFrom429) {
      this.slowUntil = 0;   // room again
    }
    if (now >= this.slowUntil) this.slowFrom429 = false;
    this.pump();
  }

  stats() {
    return {spacingMs: this.spacingMs, queued: this.queue.length, started: this.started, pausedForMs: Math.max(0, this.pausedUntil - this.now()),
      slowForMs: Math.max(0, this.slowUntil - this.now())};
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
      const due = Math.max(this.lastStart + this.spacingMs, this.pausedUntil);
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
        this.pause(error.retryAfterMs ?? SLOW_SPACING_MS);
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
