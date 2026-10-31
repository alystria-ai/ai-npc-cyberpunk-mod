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
// Cost: nothing unless a streamed Gemini request is still silent after 4 s: one timer per request, cleared as soon as the first word comes.
export const HEDGE_AFTER_MS = 4000;
const LOST = Symbol('hedge-lost');

/**
 * Wraps `chat(options)` (bridge/mistral-client.mjs streamChat or a wrapper of it) for a route that hedges.
 * `log(line)` gets the one line of a hedge. `setTimer` / `clearTimer` / `now`: for the tests.
 */
export function hedged(chat, {afterMs = HEDGE_AFTER_MS, log = () => {}, label = 'Google Gemini', setTimer = setTimeout, clearTimer = clearTimeout, now = () => performance.now()} = {}) {
  return function hedgedChat(options = {}) {
    if (typeof options.onDelta !== 'function' || options.signal?.aborted) return chat(options);
    return new Promise((resolve, reject) => {
      const runs = [];
      let winner = null, done = false, timer = null, began = now();
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        if (timer !== null) { clearTimer(timer); timer = null; }
        for (const run of runs) if (run !== winner) { try { run.controller.abort(LOST); } catch { /* already over */ } }
        fn(value);
      };
      const say = text => { try { log(`${label}: ${text}`); } catch { /* a log line never fails a reply */ } };
      const ordinal = run => (run.index === 0 ? 'first' : 'second');
      const start = () => {
        const run = {index: runs.length, controller: new AbortController(), settled: false, error: undefined, startedAt: now()};
        runs.push(run);
        const signal = options.signal ? AbortSignal.any([options.signal, run.controller.signal]) : run.controller.signal;
        const onDelta = (...args) => {
          if (done) return undefined;
          if (winner === null) {
            winner = run;
            if (timer !== null) { clearTimer(timer); timer = null; }
            if (runs.length > 1) say(`hedged request: the ${ordinal(run)} request gave the first word at ${((now() - began) / 1000).toFixed(1)} s and won, the other was cancelled`);
            for (const other of runs) if (other !== run) { try { other.controller.abort(LOST); } catch { /* already over */ } }
          }
          return winner === run ? options.onDelta(...args) : undefined;
        };
        Promise.resolve().then(() => chat({...options, signal, onDelta})).then(result => {
          run.settled = true;
          if (done || (winner !== null && winner !== run)) return;
          // An answer with no streamed word (the reply came whole): it counts as the first answer.
          if (winner === null) {
            winner = run;
            if (runs.length > 1) say(`hedged request: the ${ordinal(run)} request answered first, at ${((now() - began) / 1000).toFixed(1)} s, the other was cancelled`);
          }
          finish(resolve, result);
        }, error => {
          run.settled = true;
          run.error = error;
          if (done || (winner !== null && winner !== run)) return;
          // The caller stopped the turn: both requests end with it.
          if (options.signal?.aborted) { finish(reject, error); return; }
          // The winner failed after its first word: the failure is the call's.
          if (winner === run) { finish(reject, error); return; }
          // No winner yet. A failure about the account (key, limit, credits, region, model) is the same for the other request: the call ends with it now.
          if (error?.kind !== 'network') {
            if (runs.length > 1) say(`hedged request: the ${ordinal(run)} request failed (${error?.kind ?? 'error'}), the call ends with it`);
            finish(reject, error);
            return;
          }
          // A network failure waits for the other request when there is one.
          if (runs.every(item => item.settled)) {
            if (runs.length > 1) say(`hedged request: neither request answered (${runs.map(item => item.error?.kind ?? 'error').join(', ')})`);
            finish(reject, runs[0].error);
          }
        });
        return run;
      };
      start();
      timer = setTimer(() => {
        timer = null;
        if (done || winner !== null || runs.length > 1 || runs[0].settled) return;
        say(`no first word after ${(afterMs / 1000).toFixed(1)} s, the same request is sent once more and the first to answer wins`);
        start();
      }, afterMs);
      timer?.unref?.();
    });
  };
}
