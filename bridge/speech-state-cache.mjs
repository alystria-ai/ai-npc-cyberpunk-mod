// The game's `speech-state.json` (its heartbeat: what the playback adapter can do, and the last delivery receipt) read on a turn's critical
// path without a file read per question (docs/LATENCY_2026-10-13.md, 4.4).
//
// The Lua adapter rewrites the file every few seconds and the bridge's own polls read it every 0.5 s, yet a turn read and parsed it again
// at every decision (is continuous playback available, how does the face file work, is the audio service alive): 5 to 60 ms each on a
// busy disk, in front of the first sound. `fresh()` is the plain read (and refreshes the copy); `cached()` answers from the last good
// read when it is younger than `maxAgeMs`, else reads. Receipts and the heartbeat watchdog keep using `fresh()`.
//
// A read that failed (the game replaces the file by removing it, then renaming: a short gap) is `{}` and is never cached; `cached()`
// then keeps answering with the last good copy while that is still younger than `staleMs` (the game's own 5 s heartbeat limit), where
// the old code answered `{}` and a turn lost its voice for nothing.
export function createSpeechStateReader({read, now = Date.now, maxAgeMs = 1000, staleMs = 5000} = {}) {
  let value = null, at = -Infinity, pending = null;
  const store = (state, startedAt) => {
    if (state && typeof state === 'object' && Object.keys(state).length && startedAt >= at) { value = state; at = startedAt; }
    return state;
  };
  const fresh = async () => { const startedAt = now(); return store(await read(), startedAt); };
  return {
    fresh,
    /** The state as of at most `maxAgeMs` ago (one read serves everyone who asks while it runs). */
    async cached() {
      const age = now() - at;
      if (value !== null && age >= 0 && age < maxAgeMs) return value;
      pending ??= fresh().finally(() => { pending = null; });
      const state = await pending;
      if (state && Object.keys(state).length) return state;
      return value !== null && now() - at < staleMs ? value : state;
    },
    /** The last good copy and its age in ms, without reading (diagnostics and tests). */
    peek: () => ({value, ageMs: value === null ? Infinity : now() - at}),
  };
}

/** The audio service is alive: the same rule as `audioReady` in bridge/speech-audio.mjs, applied to a state already read. */
export const audioAvailable = (state, now = Date.now()) => state?.available === true && now - state.updated < 5000;
