// Slow replies, for the automatic error reports (docs/ERROR_REPORTS.md, kind `slow-turn`). Players report replies getting slower over a
// session (Local AI going from 2-3 s to a minute or two); this watches the stage clock that already measures every turn
// (bridge/turn-clock.mjs, bridge-latency.json) and, when replies are clearly slow and stay slow, hands ONE event to the error recorder
// (bridge/error-events.mjs), so the developer sees it without asking the player for logs.
//
// Cost: one call per finished turn that reaches its first sound (a few array writes on numbers the clock already holds), nothing per
// frame, nothing per audio chunk, no file read and no probe. What is gathered for the report (the free video memory the local AI saw at its
// last start, the background connection counts) is read once, when the report is made.
//
// Trigger (SLOW_TURNS): `slowInWindow` of the last `windowTurns` turns took more than `slowMs` from the bridge reading the request to the
// first sound, or any one turn took more than `extremeMs`. One report per bridge run; the recorder and the sender add one per kind per UTC
// day and five a day, and the Privacy setting.
//
// Left out of the trigger: a turn that failed (it is reported as `turn-failed`), a turn during which the game said it was paused (a menu or
// a pause: the lease the game writes carries it) and the first turn after Local AI loaded its model (a cold start is slow by nature; it
// stays in the report's history, so it is visible). The window or the game being unfocused is not known to the bridge.
//
// Carries: numbers and the fixed names of stages, providers, voices and models only. Never a word anyone said.

export const SLOW_TURNS = Object.freeze({windowTurns: 5, slowInWindow: 3, slowMs: 15_000, extremeMs: 45_000,
  headTurns: 3, keepTurns: 8, slowListed: 5, maxMarks: 40});

const WORD = /^[A-Za-z0-9._:-]{1,80}$/;
const MARK = /^[A-Za-z][A-Za-z0-9]{1,23}$/;
const round = (value, places = 0) => Math.round(value * 10 ** places) / 10 ** places;
const word = value => typeof value === 'string' && WORD.test(value) ? value : undefined;
const count = value => Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

/** One turn as the report keeps it: small, numbers and fixed names. `marks`: stage -> ms after the bridge read the request. */
function entryOf({n, atMin, soundMs, details = {}, snapshot, fallback = {}, withMarks = true}) {
  const marks = {};
  if (withMarks) for (const [name, at] of Object.entries(snapshot?.marks ?? {}).slice(0, SLOW_TURNS.maxMarks)) {
    if (MARK.test(name) && Number.isFinite(at)) marks[name] = round(at);
  }
  const stalls = Array.isArray(snapshot?.stalls) ? snapshot.stalls : [];
  return {n, atMin, soundMs, provider: word(details.provider) ?? word(fallback.provider), model: word(details.model),
    voice: word(details.voice) ?? word(fallback.voice), promptTokens: count(details.promptTokens), cachedTokens: count(details.cachedTokens),
    ...(details.cold === true ? {cold: true} : {}),
    ...(stalls.length ? {stalls: {count: stalls.length, maxMs: round(Math.max(...stalls.map(stall => Number(stall.ms) || 0)))}} : {}),
    ...(withMarks ? {marks} : {})};
}

const clean = entry => Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));

export class SlowTurnWatch {
  /**
   * onSlow(data): called once, with the report's `slow` section. turnContext(): {provider, voice} for a turn that was not annotated
   * (a few property reads). reportContext(): {freeVideoMemoryMiB, background} read once at the trigger. now: for the tests.
   */
  constructor({onSlow = () => {}, turnContext = () => ({}), reportContext = () => ({}), now = Date.now, thresholds = {}} = {}) {
    Object.assign(this, {onSlow, turnContext, reportContext, now});
    this.limits = {...SLOW_TURNS, ...thresholds};
    this.startedAt = now();
    this.turns = 0;
    this.excluded = {failed: 0, paused: 0};
    this.head = [];
    this.recent = [];
    this.window = [];
    this.reported = false;
  }

  /**
   * One finished turn: {soundMs, snapshot (TurnClock.snapshot()), details (TurnClock.details)}. soundMs is the time from the bridge reading the
   * request to the first sound. Never throws: a report is never worth a failed turn. Returns the data handed to onSlow, or null.
   */
  observe({soundMs, snapshot, details = {}} = {}) {
    try {
      if (!Number.isFinite(soundMs) || soundMs < 0) return null;
      this.turns += 1;
      if (details.failed === true) { this.excluded.failed += 1; return null; }
      if (details.gamePaused === true) { this.excluded.paused += 1; return null; }
      const fallback = (() => { try { return this.turnContext() ?? {}; } catch { return {}; } })();
      const entry = clean(entryOf({n: this.turns, atMin: round((this.now() - this.startedAt) / 60_000, 1), soundMs: round(soundMs), details, snapshot, fallback}));
      if (this.head.length < this.limits.headTurns) this.head.push(entry);
      this.recent.push(entry);
      while (this.recent.length > this.limits.keepTurns) this.recent.shift();
      if (this.reported || details.cold === true) return null;
      this.window.push(entry);
      while (this.window.length > this.limits.windowTurns) this.window.shift();
      const slowInWindow = this.window.filter(item => item.soundMs > this.limits.slowMs).length;
      const reason = entry.soundMs > this.limits.extremeMs ? 'one-turn-over-extreme' : slowInWindow >= this.limits.slowInWindow ? 'slow-in-window' : null;
      if (!reason) return null;
      this.reported = true;
      const data = this.#data(reason, fallback);
      this.onSlow(data);
      return data;
    } catch { return null; }
  }

  #data(reason, fallback) {
    const limits = this.limits;
    let extra = {};
    try { extra = this.reportContext() ?? {}; } catch { /* the context is optional */ }
    const slow = this.recent.filter(item => item.soundMs > limits.slowMs && item.cold !== true).slice(-limits.slowListed);
    const listed = new Set(slow.map(item => item.n));
    const first = this.head.filter(item => !listed.has(item.n));
    const background = {};
    for (const [key, value] of Object.entries(extra.background ?? {})) if (/^[A-Za-z]{2,30}$/.test(key) && count(value) !== undefined) background[key] = count(value);
    return {reason,
      thresholds: {windowTurns: limits.windowTurns, slowInWindow: limits.slowInWindow, slowMs: limits.slowMs, extremeMs: limits.extremeMs},
      turns: this.turns, excluded: {...this.excluded}, minutes: round((this.now() - this.startedAt) / 60_000, 1),
      provider: word(fallback.provider), voice: word(fallback.voice),
      ...(count(extra.freeVideoMemoryMiB) !== undefined ? {freeVideoMemoryMiB: count(extra.freeVideoMemoryMiB)} : {}),
      ...(Object.keys(background).length ? {background} : {}),
      recentSoundMs: this.recent.map(item => item.soundMs),
      first, slow};
  }

  /**
   * Watches one turn's clock. The turn is judged once it has reached its first sound AND its run has ended (the model's token counts
   * are known only then), whichever comes last: `ended()` is called when the turn's run is over. Nothing is held after that.
   */
  track(clock) {
    let sounded = false, ended = false, judged = false;
    const judge = () => {
      if (judged) return;
      judged = true;
      try {
        const snapshot = clock.snapshot(), marks = snapshot.marks;
        this.observe({soundMs: (marks.playbackObserved ?? NaN) - (marks.received ?? 0), snapshot, details: clock.details});
      } catch { /* never fails a turn */ }
    };
    try { clock.on('playbackObserved', () => { sounded = true; if (ended) judge(); }); } catch { return () => {}; }
    return () => { ended = true; try { if (sounded || clock.has('playbackObserved')) judge(); } catch { /* never fails a turn */ } };
  }
}
