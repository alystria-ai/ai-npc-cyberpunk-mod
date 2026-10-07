import {validatePrefetch} from './group-prefetch.mjs';
import {abortable, cancelled} from './transport-pool.mjs';

// Look-ahead for ordered group rounds.
//
// The game only submits speaker N+1 after speaker N has been heard, so every
// speaker change used to pay a whole new provider request (about 2-3 s on
// Convai speech, 3-6 s on Omni). As soon as N's complete reply text is known
// the game publishes the request it will make for N+1 (its context contains
// N's text as heard). The bridge runs that exact turn now, through the normal
// pipeline, and holds it back from the game: Convai audio is buffered in the
// character's own page, Pocket PCM in memory, Omni's first phrase in memory.
// When the game later submits the identical turn it is claimed and released.
// Nothing reaches the game's files, speech owner, subtitles or lip sync before
// the claim, so one voice speaks at a time, in order.

// The fields that make a turn the same turn. Knowledge snapshots are excluded:
// the game recaptures them when it submits, and the held turn keeps the
// snapshot it was prepared with (still bound to the live world by the router).
export function turnKey(input) {
  return JSON.stringify([input.requestId, input.generation, input.entity, input.name, input.bodyType,
    input.profileKey, input.text, input.group ?? null,
    input.journal ?? null, input.battle ?? null, input.reaction ?? null]);
}

// source: {input, text, userText?, current}. A microphone speaker's own request
// text is a placeholder; later speakers answer the recognized transcript.
export function validateLookahead(command, source) {
  if (!source || typeof source.current !== 'function') return null;
  const input = typeof source.userText === 'string' ? {...source.input, text: source.userText} : source.input;
  return validatePrefetch(command, {input, text: source.text});
}

export class AheadOwner {
  constructor() { this.state = 'held'; this.inner = null; }
  bind(owner) { this.inner = owner; this.state = 'claimed'; }
  retire() { this.state = 'retired'; }
  async current() {
    if (this.state === 'held') return true;
    return this.state === 'claimed' ? this.inner.current() : false;
  }
}

export function waitUntil(ready, {signal, pollMs = 50, timeoutMs = Infinity, now = Date.now} = {}) {
  return new Promise((resolve, reject) => {
    const deadline = now() + timeoutMs;
    let timer;
    const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { stop(); reject(cancelled()); };
    const check = () => {
      let done;
      try { done = ready(); } catch (error) { stop(); reject(error); return; }
      if (done) { stop(); resolve(true); }
      else if (now() >= deadline) { stop(); resolve(false); }
      else timer = setTimeout(check, pollMs);
    };
    if (signal?.aborted) { reject(cancelled()); return; }
    signal?.addEventListener('abort', onAbort, {once: true});
    check();
  });
}

export class GroupLookahead {
  constructor({start, now = Date.now, maxHoldMs = 150000}) {
    Object.assign(this, {start, now, maxHoldMs});
    this.source = null; this.entry = null;
  }

  get busy() { return this.entry !== null; }

  setSource(source) { this.source = source; }

  // The submitted turn's identity is exactly the predicted one, or the held
  // turn is discarded. Offering the same turn twice is a no-op.
  offer(predicted) {
    const key = turnKey(predicted);
    if (this.entry?.key === key) return this.entry;
    this.cancel('replaced');
    let resolveClaim, rejectClaim;
    const claimed = new Promise((resolve, reject) => { resolveClaim = resolve; rejectClaim = reject; });
    claimed.catch(() => {});
    const entry = this.entry = {key, input: predicted, controller: new AbortController(), owner: new AheadOwner(),
      state: 'held', startedAt: this.now(), readyAt: null, claimedAt: null, request: null,
      claimed, resolveClaim, rejectClaim,
      isHeld: () => entry.state === 'held',
      waitClaimed: signal => abortable(claimed, signal),
      markReady: () => { entry.readyAt ??= this.now(); }};
    try { entry.request = this.start(entry); }
    catch (error) { this.fail(entry); throw error; }
    return entry;
  }

  // The game submitted a turn. Adopt the held one when it is that same turn;
  // anything else makes the held turn obsolete.
  claim(input, owner) {
    const entry = this.entry;
    if (!entry) return null;
    if (entry.state !== 'held' || turnKey(input) !== entry.key) { this.cancel('mismatch'); return null; }
    this.entry = null;
    entry.state = 'claimed'; entry.claimedAt = this.now();
    entry.owner.bind(owner);
    entry.request.receivedAt = entry.claimedAt;
    entry.resolveClaim();
    return entry.request;
  }

  // A held turn that failed publishes nothing. The game's own submission then
  // runs as a normal request, exactly as without look-ahead.
  fail(entry) {
    if (entry.state !== 'held') return;
    entry.state = 'failed'; entry.owner.retire();
    if (this.entry === entry) this.entry = null;
    entry.controller.abort(); entry.rejectClaim(cancelled('Look-ahead turn failed'));
  }

  cancel() {
    const entry = this.entry;
    if (!entry) return false;
    this.entry = null;
    entry.state = 'cancelled'; entry.owner.retire();
    entry.controller.abort(); entry.rejectClaim(cancelled('Look-ahead turn cancelled'));
    return true;
  }

  prune() {
    if (this.entry && this.now() - this.entry.startedAt > this.maxHoldMs) this.cancel();
  }

  stats(entry) {
    return {startedAt: entry.startedAt, readyAt: entry.readyAt, claimedAt: entry.claimedAt,
      readyBeforeClaim: entry.readyAt !== null && entry.claimedAt !== null && entry.readyAt <= entry.claimedAt,
      holdMs: entry.claimedAt !== null ? entry.claimedAt - entry.startedAt : undefined};
  }
}

// Pocket synthesis that runs while the previous speaker is still audible. The
// renderer is a single owned page, so the PCM is kept in memory (at most 120 s
// of mono float samples) and drained into it in order once the turn is
// claimed; packets the worker produces after that go straight through.
export class BufferedPcm {
  constructor({synthesize, signal}) {
    this.synthesize = synthesize; this.controller = new AbortController();
    this.cancel = () => this.controller.abort();
    this.parent = signal; signal?.addEventListener('abort', this.cancel, {once: true});
    if (signal?.aborted) this.cancel();
    this.packets = []; this.sink = null; this.finished = false; this.frames = 0;
  }

  start() {
    this.promise = Promise.resolve().then(() => this.synthesize(packet => this.accept(packet), {signal: this.controller.signal}))
      .then(response => { this.finished = true; return response; });
    this.promise.catch(() => {});
    return this.promise;
  }

  accept(packet) {
    if (this.sink) return this.sink(packet);
    // The worker may reuse its sample buffer; keep an owned copy.
    this.packets.push({...packet, pcm: packet.pcm.slice()});
    this.frames += packet.frames;
    return undefined;
  }

  async drain(sink, {signal} = {}) {
    const abort = () => this.cancel();
    signal?.addEventListener('abort', abort, {once: true});
    try {
      let at = 0;
      while (at < this.packets.length) {
        const packet = this.packets[at]; this.packets[at++] = null;
        await sink(packet);
        // Packets that arrived while awaiting are drained before going live.
      }
      this.packets = []; this.sink = sink;
      return await this.promise;
    } finally { signal?.removeEventListener('abort', abort); }
  }

  discard() { this.cancel(); this.parent?.removeEventListener('abort', this.cancel); this.packets = []; }
}
