// Waiting helpers for tests that drive a real local server but must not depend on how fast the machine is (see fake-clock.mjs for the clock).
import {fakeClock} from './fake-clock.mjs';

const pause = ms => new Promise(finish => setTimeout(finish, ms));

// Event-driven wait: resolves once `condition()` holds. The 60 s ceiling is reached only by a test that hangs.
export async function until(condition, what) {
  const deadline = performance.now() + 60_000;
  while (!condition()) {
    if (performance.now() > deadline) throw Error(`gave up waiting for ${what}`);
    await pause(5);
  }
}

// Follows a promise from outside: `done` flips when it settles, and a failure is kept in `error` (never an unhandled rejection).
export function track(promise) {
  const state = {done: false, value: undefined, error: undefined};
  promise.then(value => { state.value = value; state.done = true; }, error => { state.error = error; state.done = true; });
  return state;
}

// A manual clock for the timers of a class that takes `setTimer`/`clearTimer` (a cloud voice's limits and waits; `hooks` go to its constructor).
// A limit then fires only when the test moves the clock, which the test does once the request it is meant to cut has reached the fake server;
// a real 60 ms timer can fire on a loaded machine before the request is even sent. `armed` lists every timer set ({ms, at}), `limits()` its lengths.
export function manualTimers() {
  const clock = fakeClock(), armed = [];
  return {clock, armed, limits: () => armed.map(timer => timer.ms),
    hooks: {setTimer: (callback, ms) => { armed.push({ms, at: clock.now()}); return clock.setTimer(callback, ms); }, clearTimer: id => clock.clearTimer(id)}};
}
