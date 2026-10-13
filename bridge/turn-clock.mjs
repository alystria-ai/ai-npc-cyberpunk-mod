// Stage timestamps of one conversation turn, from the game writing the request to the first sound (docs/LATENCY_2026-10-12.md).
//
// A TurnClock holds the moment each stage of one turn was reached (epoch milliseconds, sub-millisecond precision, first write wins).
// `snapshot()` turns them into the record bridge-latency.json keeps: every mark as milliseconds after the bridge read the request,
// in time order, with the wait since the previous mark. The steps chain from the first mark to the last, so the record explains the
// whole time with no gaps: a long step is a long stage, and the step's name pair says which.
//
// The marks are placed by the code that knows the moment (the bridge, the text host, the voice and PCM hosts, the continuous
// speech). They reach the turn's clock through an AsyncLocalStorage (`markStage`), so no signature carries a clock around and a
// mark made with no clock in scope costs nothing but a lookup. Nothing runs per frame: a mark is a Map write, and the one timer a
// turn owns (the stall watcher) fires every 25 ms for a few seconds and is off in between.
import {AsyncLocalStorage} from 'node:async_hooks';

const storage = new AsyncLocalStorage();
const nowMs = () => {
  const clock = globalThis.performance;
  return typeof clock?.now === 'function' && Number.isFinite(clock.timeOrigin) ? clock.timeOrigin + clock.now() : Date.now();
};

/**
 * The stages, in the order a turn normally reaches them. Not every route reaches every stage (a Convai turn has no prompt of
 * ours; a text turn has no Convai connection); `snapshot()` lists what was marked, in time order.
 *   inputWritten      the game wrote the request file (its modification time)
 *   received          the bridge read the request
 *   knowledge         the turn's knowledge (journal, world, gear) was prepared
 *   admitted          memory admission and the receipt were recorded
 *   stock             an add-on remark took a line the model wrote ahead of time (bridge/addon-stock.mjs); no model call follows
 *   transport         the reply was requested from the conversation route
 *   recalled          the text route recalled the character's memory (history, retrieved facts)
 *   promptBuilt       the model's messages were built
 *   llmSent           the request was sent to the model (Convai: the text was sent over the connection)
 *   llmHeaders        the model's server answered (the response headers arrived)
 *   firstToken        the first piece of reply text arrived
 *   firstSentence     the first complete sentence of the reply is known
 *   fullText          the model finished the reply
 *   replyReturned     the text route handed the finished reply on (memory recorded, tags cleaned)
 *   voiceStart        the bridge began to voice the reply (route decided, expression planned)
 *   browserReady      the hidden browser that renders the local voice is running (a cold start is about a second under game load)
 *   playStart         the local voice's playback began (the renderer page is being opened, the voice is asked for audio)
 *   rendererReady     the audio renderer page is open and has begun this utterance
 *   ttsSent           the text-to-speech request was sent (cloud) or handed to the worker (local)
 *   firstPcm          the first audio from the voice arrived
 *   firstPcmAccepted  the renderer accepted the first audio
 *   firstFrame        the first renderer state with audio reached the continuous speech
 *   published         the reply was published to the game (it may start the sound)
 *   playbackObserved  the renderer's clock showed sound playing
 */
export const STAGES = Object.freeze(['inputWritten', 'received', 'knowledge', 'admitted', 'stock', 'transport', 'recalled', 'promptBuilt',
  'llmSent', 'llmHeaders', 'firstToken', 'firstSentence', 'fullText', 'replyReturned', 'voiceStart', 'browserReady', 'playStart', 'rendererReady', 'ttsSent', 'firstPcm',
  'firstPcmAccepted', 'firstFrame', 'published', 'playbackObserved']);

const round = (value, places = 1) => Math.round(value * 10 ** places) / 10 ** places;

export class TurnClock {
  constructor({origin, now = nowMs} = {}) {
    this.now = now;
    this.origin = Number.isFinite(origin) ? origin : now();
    this.marks = new Map();
    this.stalls = [];
    this.watching = null;
  }

  /** Marks `name` now, or at `at` (epoch ms) when given. The first mark of a name wins. Returns the time marked. */
  mark(name, at) {
    if (this.marks.has(name)) return this.marks.get(name);
    const value = Number.isFinite(at) ? at : this.now();
    this.marks.set(name, value);
    this.notify(name, value);
    return value;
  }

  /**
   * Calls `fn(time)` once, the first time `name` is marked (at once when it already is). A listener that throws is ignored: a
   * mark is never allowed to fail the code that made it. Used by V's voice to stop its own synthesis when the companion's
   * text-to-speech request goes out (bridge/v-voice.mjs).
   */
  on(name, fn) {
    if (typeof fn !== 'function') return;
    if (this.marks.has(name)) { try { fn(this.marks.get(name)); } catch { /* a listener never fails a mark */ } return; }
    (this.listeners ??= new Map()).set(name, [...this.listeners.get(name) ?? [], fn]);
  }

  notify(name, value) {
    const listeners = this.listeners?.get(name);
    if (!listeners) return;
    this.listeners.delete(name);
    for (const fn of listeners) { try { fn(value); } catch { /* a listener never fails a mark */ } }
  }

  /** Marks again, replacing an earlier mark of the same name (a stage that is reached more than once: the last one counts). */
  remark(name, at) {
    const value = Number.isFinite(at) ? at : this.now();
    this.marks.set(name, value);
    return value;
  }

  has(name) { return this.marks.has(name); }
  at(name) { return this.marks.get(name); }

  /**
   * Watches for the event loop being blocked: a timer every `intervalMs` notes how late it ran. A stall of `minMs` or more is
   * recorded (at most `limit`). Stops by itself after `maxMs`, or by `stop()`. Cheap enough to run for one turn.
   */
  watch({intervalMs = 25, minMs = 80, limit = 12, maxMs = 20_000, setTimer = setInterval, clearTimer = clearInterval} = {}) {
    if (this.watching) return;
    let expected = this.now() + intervalMs;
    const started = this.now();
    const timer = setTimer(() => {
      const late = this.now() - expected;
      expected = this.now() + intervalMs;
      if (late >= minMs && this.stalls.length < limit) this.stalls.push({at: round(this.now() - this.origin), ms: round(late)});
      if (this.now() - started > maxMs) this.stop();
    }, intervalMs);
    timer?.unref?.();
    this.watching = () => clearTimer(timer);
  }

  stop() { try { this.watching?.(); } finally { this.watching = null; } }

  /**
   * {origin, marks: {name: ms after origin}, order: [names in time order], steps: [{from, to, ms}], totalMs, stalls}. Marks that
   * came earlier than the origin (the request file was written before the bridge read it) are negative. `steps` joins each mark to
   * the next, so their sum is `totalMs` (first mark to last): the whole turn is explained.
   */
  snapshot() {
    const rows = [...this.marks].map(([name, at]) => [name, at]).sort((a, b) => a[1] - b[1]);
    const marks = {};
    for (const [name, at] of rows) marks[name] = round(at - this.origin);
    const steps = [];
    for (let index = 1; index < rows.length; index++) {
      steps.push({from: rows[index - 1][0], to: rows[index][0], ms: round(rows[index][1] - rows[index - 1][1])});
    }
    const total = rows.length > 1 ? rows.at(-1)[1] - rows[0][1] : 0;
    return {version: 1, origin: round(this.origin, 0), marks, order: rows.map(([name]) => name), steps, totalMs: round(total),
      ...(this.stalls.length ? {stalls: this.stalls.map(stall => ({...stall}))} : {})};
  }
}

/** Runs `fn` with `clock` as the clock of everything it starts (marks made by that code reach it). */
export const withClock = (clock, fn) => storage.run(clock, fn);
/** The clock of the code now running, or undefined. */
export const currentClock = () => storage.getStore();
/** Marks `name` on the running turn's clock; does nothing when no turn is running. */
export const markStage = (name, at) => storage.getStore()?.mark(name, at);
