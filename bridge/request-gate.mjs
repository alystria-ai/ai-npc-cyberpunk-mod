// A cap on how many cloud text-to-speech requests are in flight at once (used by bridge/voxtral-voice.mjs).
//
// Why: a group round runs the next speaker's reply ahead (bridge/group-lookahead.mjs), so the speaker being heard, the V line and the
// held next speaker can all ask for speech in the same second. A refusal in that burst (2026-10-17: one HTTP 403 in the middle of a round)
// must not become a dropped voice. The gate keeps the burst small without ever slowing the speaker being heard:
//   - a request for the speaker being heard (foreground) runs at once while fewer than `limit` requests are running, and always goes
//     before a held look-ahead request that is still waiting;
//   - the look-ahead (`ahead: true`) never has more than `aheadLimit` requests running, so it can never take every slot;
//   - after a refusal that may be a burst limit (`tighten`), the cap drops to `tightLimit` for `tightMs`, then returns by itself.
// A request that waits longer than `maxQueueMs` (or whose signal aborts) leaves the queue with an error and never runs. Memory only; a timer runs only for a
// request that is waiting.
import {cancelled} from './transport-pool.mjs';

export class RequestGate {
  constructor({limit = 4, aheadLimit = 1, tightLimit = 2, tightMs = 30_000, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
    Object.assign(this, {limit, aheadLimit, tightLimit, tightMs, now, setTimer, clearTimer});
    this.running = 0; this.runningAhead = 0; this.tightUntil = 0; this.waiting = [];
  }
  /** The cap in force now. */
  get cap() { return this.now() < this.tightUntil ? Math.min(this.limit, this.tightLimit) : this.limit; }
  /** A refusal that may be a burst limit: fewer requests at once for a while. */
  tighten(ms = this.tightMs) { this.tightUntil = Math.max(this.tightUntil, this.now() + ms); }
  stats() { return {running: this.running, runningAhead: this.runningAhead, waiting: this.waiting.length, cap: this.cap}; }

  /** Resolves with a release function once a slot is free; rejects when `signal` aborts or `maxQueueMs` passes first. */
  acquire({ahead = false, signal, maxQueueMs = Infinity} = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? cancelled());
    return new Promise((resolve, reject) => {
      const entry = {ahead, resolve, reject, timer: null, onAbort: null};
      const leave = () => { this.clearTimer(entry.timer); signal?.removeEventListener('abort', entry.onAbort); };
      entry.onAbort = () => {
        const at = this.waiting.indexOf(entry);
        if (at < 0) return;
        this.waiting.splice(at, 1); leave(); reject(signal.reason ?? cancelled()); this.pump();
      };
      entry.leave = leave;
      signal?.addEventListener('abort', entry.onAbort, {once: true});
      if (Number.isFinite(maxQueueMs)) {
        entry.timer = this.setTimer(() => {
          const at = this.waiting.indexOf(entry);
          if (at < 0) return;
          this.waiting.splice(at, 1); leave();
          reject(Object.assign(Error('Request waited too long for a free slot'), {code: 'queue-timeout'})); this.pump();
        }, maxQueueMs);
      }
      this.waiting.push(entry);
      this.pump();
    });
  }

  pump() {
    for (;;) {
      const cap = this.cap;
      // A tightened cap lifts by itself with the clock; the next release (or arrival) looks at it again.
      if (this.running >= cap) return;
      // Foreground first, then the look-ahead; each in the order asked.
      let at = this.waiting.findIndex(entry => !entry.ahead);
      if (at < 0) at = this.waiting.findIndex(entry => entry.ahead && this.runningAhead < this.aheadLimit);
      if (at < 0) return;
      const [entry] = this.waiting.splice(at, 1);
      entry.leave();
      this.running++; if (entry.ahead) this.runningAhead++;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true; this.running--; if (entry.ahead) this.runningAhead--;
        this.pump();
      });
    }
  }
}
