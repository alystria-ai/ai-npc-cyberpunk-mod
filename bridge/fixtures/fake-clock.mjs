// A manual clock for tests of code that takes `now`, `setTimer` and `clearTimer` (or a `sleep`): time moves only when the test says so, so a
// busy machine cannot change what happens between two lines. advance(ms) fires the timers that fall due, in order, and lets the promise
// work they set off finish before it returns; runUntilIdle() jumps from timer to timer until none is left.
//
//   const clock = fakeClock();
//   const scheduler = new MistralScheduler({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
//   await clock.sleep(30)          // a promise that resolves once the clock has moved 30 ms
//   await clock.advance(30)        // moves the clock; every timer that came due has fired and its microtasks have run
//
// Only promise (microtask) work is flushed. A code path that waits for real I/O (a file write, a socket) needs an event-driven wait of its own.
export function fakeClock(start = 1_000_000) {
  let time = start, sequence = 0;
  const timers = new Map();
  // A macrotask turn: every microtask queued before it has run by then, however slow the machine is.
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const clock = {
    now: () => time,
    setTimer(callback, ms) {
      const id = ++sequence;
      timers.set(id, {id, at: time + Math.max(0, Number(ms) || 0), callback});
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    sleep: ms => new Promise(resolve => clock.setTimer(resolve, ms)),
    pending: () => timers.size,
    settle,
    async advance(ms = 0) {
      const target = time + ms;
      await settle();
      for (;;) {
        let next = null;
        for (const timer of timers.values()) if (timer.at <= target && (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id))) next = timer;
        if (!next) break;
        timers.delete(next.id);
        time = Math.max(time, next.at);
        next.callback();
        await settle();
      }
      time = target;
      await settle();
    },
    // Jumps to each pending timer in turn until none is left (a run of retries and waits, start to finish).
    async runUntilIdle(limit = 10_000) {
      await settle();
      for (let turns = 0; timers.size; turns++) {
        if (turns >= limit) throw Error(`the fake clock still had ${timers.size} timer(s) after ${limit} jumps`);
        await clock.advance(Math.max(0, Math.min(...[...timers.values()].map(timer => timer.at)) - time));
      }
    },
  };
  return clock;
}
