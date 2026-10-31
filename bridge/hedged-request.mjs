// The hedged request of the Google Gemini provider (owner decision, 31 Oct 2026). Gemini's free plan sometimes holds a request for 20 s or more without a first word (0.4.0 report
// 931d4563: attempt 1 silent for 20.0 s, attempt 2 answered after 20.3 s, 45.9 s to the first sound), and the first try is only given up after the first-byte window.
//
//   - A streamed reply (a request with `onDelta`) that has given no first word 4 s after it was sent is sent again, once, with the same messages. Whichever of the two gives a word first
//     is the answer: its words go on, the other request is cancelled at once (its connection is closed). At most ONE extra request per call, so per turn: only the reply stream has an
//     `onDelta`, the action decision, the summary and the facts are never hedged.
//   - Only the Google Gemini route wraps its chat in this (bridge/text-provider-host.mjs customRoute, name 'gemini'). No other provider is touched, and a turn whose first word comes
//     within 4 s sends nothing extra.
//   - Both requests go to the same endpoint with the same key, so Google counts both against the same allowance, and the mod's own handling of that allowance is unchanged: a failure that
//     is about the account (a refused key, a rate or daily limit, credits, a region) from EITHER request ends the call at once with that failure, which the route notes as it always did
//     (provider.noteLimit, the gemini-daily / gemini-limit / gemini-key notices). A failure of the network (no answer in time, a closed connection) of one request waits for the other.
//   - One log line per hedge, when it is decided: which request won, or that neither answered.
//
// Busy answers (owner request, 31 Oct 2026, after a live "Google Gemini is busy" notice on a normal talk turn): an answer that says Google is overloaded (`error.busy`, set by
// bridge/mistral-client.mjs: HTTP 500 INTERNAL, 503 UNAVAILABLE, a 429 RESOURCE_EXHAUSTED that names no quota, any 5xx whose body says overloaded) is asked again in the same turn, after
// 1 s and then after 2 s, at most twice, and only while the retry would still start within 8 s of the call's start and leave a turn deadline (`deadlineAt`) its minimum attempt.
//   - The retries share this wrapper's one-extra-request rule: at most two requests are in flight at a time (the original and the hedge, or a retry and the hedge). A busy answer from
//     one request while the other is still in flight waits for the other, and the retry is only made once no request is left. The 4 s hedge timer counts from the latest start.
//   - The request's own retry loop (bridge/mistral-client.mjs streamChat) is told to leave busy answers to this wrapper (`deferBusy`), so a busy turn is 3 requests at most, not 6.
//   - A first word ends it all: nothing is retried once a reply has begun. A success adds no delay. Quota, key, region and model failures end the call at once, as before.
//   - One log line per retry. When every retry failed, the busy error is the call's (the route's gemini-server notice).
//
// Cost: nothing unless a streamed Gemini request is still silent after 4 s or answers busy: one timer per request, cleared as soon as the first word comes.
export const HEDGE_AFTER_MS = 4000;
/** The waits before the first and the second busy retry, and how many retries a call gets at most. */
export const BUSY_BACKOFF_MS = Object.freeze([1000, 2000]);
/** A busy retry starts only if it would begin within this long of the call's start (the retries stay inside about 8 s). */
export const BUSY_WINDOW_MS = 8000;
/** The least time left before a turn deadline (`deadlineAt`) for a busy retry to be worth starting (the same as bridge/mistral-client.mjs MIN_ATTEMPT_MS). */
const MIN_RETRY_ROOM_MS = 3000;
const LOST = Symbol('hedge-lost');
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];

/**
 * Wraps `chat(options)` (bridge/mistral-client.mjs streamChat or a wrapper of it) for a route that hedges.
 * `log(line)` gets the one line of a hedge or of a busy retry. `backoffMs` / `windowMs`: the busy retries (one entry per retry, [] for none). `setTimer` / `clearTimer` / `now`: for the tests.
 */
export function hedged(chat, {afterMs = HEDGE_AFTER_MS, log = () => {}, label = 'Google Gemini', backoffMs = BUSY_BACKOFF_MS, windowMs = BUSY_WINDOW_MS,
  setTimer = setTimeout, clearTimer = clearTimeout, now = () => performance.now()} = {}) {
  return function hedgedChat(options = {}) {
    if (typeof options.onDelta !== 'function' || options.signal?.aborted) return chat(options);
    return new Promise((resolve, reject) => {
      const runs = [];
      let winner = null, done = false, hedgeTimer = null, retryTimer = null, hedgedYet = false, retries = 0, lastBusy = null, lastFailure = null, onAbort = null;
      const began = now();
      const clock = () => (Number.isFinite(options.deadlineAt) && typeof options.now === 'function' ? options.now() : now());
      const stopTimers = () => {
        if (hedgeTimer !== null) { clearTimer(hedgeTimer); hedgeTimer = null; }
        if (retryTimer !== null) { clearTimer(retryTimer); retryTimer = null; }
      };
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        stopTimers();
        if (onAbort) options.signal?.removeEventListener('abort', onAbort);
        for (const run of runs) if (run !== winner) { try { run.controller.abort(LOST); } catch { /* already over */ } }
        fn(value);
      };
      const say = text => { try { log(`${label}: ${text}`); } catch { /* a log line never fails a reply */ } };
      const ordinal = run => ORDINALS[run.index] ?? `number ${run.index + 1}`;
      const live = () => runs.filter(run => !run.settled).length;
      const elapsed = () => ((now() - began) / 1000).toFixed(1);
      const armHedge = () => {
        if (hedgeTimer !== null) { clearTimer(hedgeTimer); hedgeTimer = null; }
        if (hedgedYet || done) return;
        hedgeTimer = setTimer(() => {
          hedgeTimer = null;
          // Only one request is in flight (the latest start) and it is still silent; a request that already failed busy is the retry's business.
          if (done || winner !== null || hedgedYet || live() !== 1 || retryTimer !== null) return;
          hedgedYet = true;
          say(`no first word after ${(afterMs / 1000).toFixed(1)} s, the same request is sent once more and the first to answer wins`);
          start();
        }, afterMs);
        hedgeTimer?.unref?.();
      };
      // The call ends with the last failure if Google was busy at any point (a busy answer stays the busy notice), else with the first request's failure.
      const giveUp = () => finish(reject, lastBusy ? lastFailure : runs[0].error);
      // Is a busy retry still allowed, and after how long? null: no.
      const retryWait = () => {
        if (retries >= backoffMs.length || options.signal?.aborted) return null;
        const wait = backoffMs[retries];
        if (now() - began + wait > windowMs) return null;
        if (Number.isFinite(options.deadlineAt) && options.deadlineAt - clock() - wait < (options.minAttemptMs ?? MIN_RETRY_ROOM_MS)) return null;
        return wait;
      };
      // Called after a request failed with no winner: wait for the other request, or ask again after a busy answer, or end the call.
      const settle = () => {
        if (done || live() > 0 || retryTimer !== null) return;
        const wait = lastBusy && lastBusy === lastFailure ? retryWait() : null;
        if (wait === null) {
          if (hedgedYet && !lastBusy) say(`hedged request: neither request answered (${runs.map(item => item.error?.kind ?? 'error').join(', ')})`);
          giveUp();
          return;
        }
        retries++;
        const status = lastBusy.status ? ` (HTTP ${lastBusy.status})` : '';
        say(`busy${status}, asking again in ${(wait / 1000).toFixed(1)} s (retry ${retries} of ${backoffMs.length}, ${elapsed()} s into the turn)`);
        retryTimer = setTimer(() => {
          retryTimer = null;
          if (done) return;
          if (options.signal?.aborted) { finish(reject, options.signal.reason ?? lastBusy); return; }
          start();
          armHedge();
        }, wait);   // not unref'd: a pending retry is a turn still waiting for its answer (2 s at most, cleared when the call ends)
      };
      const start = () => {
        const run = {index: runs.length, controller: new AbortController(), settled: false, error: undefined, startedAt: now()};
        runs.push(run);
        const signal = options.signal ? AbortSignal.any([options.signal, run.controller.signal]) : run.controller.signal;
        const onDelta = (...args) => {
          if (done) return undefined;
          if (winner === null) {
            winner = run;
            stopTimers();
            if (hedgedYet) say(`hedged request: the ${ordinal(run)} request gave the first word at ${elapsed()} s and won, the other was cancelled`);
            for (const other of runs) if (other !== run) { try { other.controller.abort(LOST); } catch { /* already over */ } }
          }
          return winner === run ? options.onDelta(...args) : undefined;
        };
        Promise.resolve().then(() => chat({...options, signal, onDelta, deferBusy: true})).then(result => {
          run.settled = true;
          if (done || (winner !== null && winner !== run)) return;
          // An answer with no streamed word (the reply came whole): it counts as the first answer.
          if (winner === null) {
            winner = run;
            if (hedgedYet) say(`hedged request: the ${ordinal(run)} request answered first, at ${elapsed()} s, the other was cancelled`);
          }
          finish(resolve, result);
        }, error => {
          run.settled = true;
          run.error = error; lastFailure = error;
          if (done || (winner !== null && winner !== run)) return;
          // The caller stopped the turn: every request ends with it.
          if (options.signal?.aborted) { finish(reject, error); return; }
          // The winner failed after its first word: the failure is the call's.
          if (winner === run) { finish(reject, error); return; }
          // No winner yet. Google was busy: the other request, if one is in flight, may still answer; if none is left the busy answer is asked again after a short backoff.
          if (error?.busy === true) { lastBusy = error; settle(); return; }
          // A failure about the account (key, limit, credits, region, model) is the same for the other request: the call ends with it now.
          if (error?.kind !== 'network') {
            if (hedgedYet) say(`hedged request: the ${ordinal(run)} request failed (${error?.kind ?? 'error'}), the call ends with it`);
            finish(reject, error);
            return;
          }
          // A network failure waits for the other request when there is one.
          settle();
        });
        return run;
      };
      if (options.signal) {
        onAbort = () => { if (!done && live() === 0) finish(reject, options.signal.reason); };
        options.signal.addEventListener('abort', onAbort, {once: true});
      }
      start();
      armHedge();
    });
  };
}
