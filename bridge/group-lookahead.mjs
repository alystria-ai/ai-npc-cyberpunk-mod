import {validatePrefetch} from './group-prefetch.mjs';
import {abortable, cancelled} from './transport-pool.mjs';
import {parseInput} from './protocol.mjs';
import {HEAD_PROFILE, cleanText, FOLLOW_LIMITS} from './johnny-head.mjs';
import {displayText} from './speech-tags.mjs';

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
    input.journal ?? null, input.battle ?? null, input.reaction ?? null, input.gameDialogue ?? null]);
}

// source: {input, text, userText?, current}. A microphone speaker's own request
// text is a placeholder; later speakers answer the recognized transcript.
export function validateLookahead(command, source) {
  if (!source || typeof source.current !== 'function') return null;
  const input = typeof source.userText === 'string' ? {...source.input, text: source.userText} : source.input;
  return validatePrefetch(command, {input, text: source.text});
}

// ---- Lines prepared ahead that are not a group speaker (docs/COMPANION_SPEAK_UP.md, "Bridge side") --------------------------------------------------
// The same hold-and-claim mechanism serves two more kinds of turn, named by `kind` in runtime/group-prefetch.json (a command without `kind` is a group
// prediction exactly as before):
//   'follow'  Johnny's remark on a line that is still playing: `{kind: 'follow', sourceRequestId, input}`. The source is the turn whose complete text the bridge
//             already has (a companion's speak-up, or a reply in a conversation V is having). The remark is written and voiced while the source plays and is
//             heard right after it, when the game submits the identical turn.
//   'ahead'   A companion's after-scene line, `{kind: 'ahead', input}`: there is no source turn of ours (the scene is game audio), the line is prepared while the
//             scene's last line plays and said once the scene is over. The next line of a housemates' chat is the same command (reaction kind `house`, event
//             `chat`): prepared while the line before it plays and said the moment that line has been heard. A party round's next line (reaction kind `speakup`,
//             event `party`) is the same.
// Both are lowest-priority work: they never delay a turn of V's (a prepared turn is dropped the moment V's own request arrives, a recording or the text box
// opens), and they are held for at most PREPARED_HOLD_MS.
export const PREPARED_HOLD_MS = 90_000;
export const PREPARED_KINDS = Object.freeze(['follow', 'ahead']);

/** 'group', 'follow' or 'ahead' for a command from the game; null for any other `kind`. */
export const lookaheadKind = command => command?.kind === undefined ? 'group' : PREPARED_KINDS.includes(command.kind) ? command.kind : null;

/**
 * A file read that asks the disk for the text only when the file changed. The poll that looks for a prediction runs every 60 ms for as long as the
 * bridge lives (the text providers may prepare lines ahead too), and the file is `{}` almost all of that time: one stat tells it is the same file
 * (modification time and size), so the last text is answered again. A missing file reads as '' and a failed read is not remembered.
 */
export function createStatCachedReader({stat, read}) {
  let signature = null, text = '';
  return async path => {
    let info;
    try { info = await stat(path); } catch { signature = null; text = ''; return ''; }
    const next = `${info.mtimeMs}:${info.size}`;
    if (next === signature) return text;
    try { text = await read(path); } catch { signature = null; text = ''; return ''; }
    signature = next;
    return text;
  };
}

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const alive = (reaction, now) => Number.isSafeInteger(reaction?.expiresAt) && reaction.expiresAt > now;

/**
 * Johnny's follow-on to the turn `source` ({input, text, current}): the input to hold, or null (fail closed). The source must be the turn named by
 * `sourceRequestId`, a private turn of anyone but Johnny (a companion's own speak-up, or a normal reply in a conversation V is having), with its COMPLETE text
 * equal to the line the remark is about and its speaker's name the one the remark names; the follow-on is Johnny's head turn, a later request.
 */
export function validateFollow(command, source, now = Date.now()) {
  if (!plain(command) || command.kind !== 'follow' || !source?.input || typeof source.text !== 'string'
      || command.sourceRequestId !== source.input.requestId) return null;
  const input = parseInput(JSON.stringify(command.input)), reaction = input?.reaction, before = source.input;
  if (!input || input.profileKey !== HEAD_PROFILE || !input.head || input.group || reaction?.kind !== 'head' || reaction.event !== 'follow' || !alive(reaction, now)) return null;
  if (input.requestId === before.requestId || input.generation <= before.generation) return null;
  if (before.profileKey === HEAD_PROFILE || before.group || (before.reaction && before.reaction.kind !== 'speakup')) return null;
  // How it came about must agree with the source: a speak-up is "companion", a reply to V is "talk".
  if (reaction.facts.via !== (before.reaction ? 'companion' : 'talk')) return null;
  if (cleanText(displayText(source.text, true), FOLLOW_LIMITS.line) !== reaction.facts.line || cleanText(before.name, FOLLOW_LIMITS.who) !== reaction.facts.who) return null;
  return input;
}

/**
 * A line prepared while another plays, with no source turn of ours: the input to hold, or null. Two kinds of reaction: a companion's after-scene line (the scene's
 * last line is game audio), and the next line of a housemates' chat (the line before it is ours, but its text is already in the prepared turn, so the game
 * names no source: the housemates' chat module only prepares line n + 1 once line n's text is known, and withdraws it with `{}` when the chat stops).
 */
export function validateAhead(command, now = Date.now()) {
  if (!plain(command) || command.kind !== 'ahead' || command.sourceRequestId !== undefined) return null;
  const input = parseInput(JSON.stringify(command.input)), reaction = input?.reaction;
  const scene = reaction?.kind === 'speakup' && reaction.event === 'scene', chat = reaction?.kind === 'house' && reaction.event === 'chat';
  // The next line of a party round (the group speak-up) is prepared the same way as the next line of a housemates' chat.
  const party = reaction?.kind === 'speakup' && reaction.event === 'party';
  if (!input || !(scene || chat || party) || input.group || !alive(reaction, now)) return null;
  return input;
}

// Whether the held next speaker may run beside the speaker being heard. It needs a second conversation connection while the
// first is still open, so it needs a plan that allows two: the shared key (no cap of ours), or a player's own key on a confirmed
// paid plan (connectionLimit 6). A player's key on a free, unknown or unread plan has one connection and keeps the serial path,
// and with Mistral or the local AI there is no Convai connection to run ahead on. Memory-only; it is asked every poll.
// singleSession: the key in use is a player's own; connectionLimit: how many connections that key may hold (1 when unknown).
// kind 'follow' / 'ahead' (one line prepared beside a line that is playing): Convai follows the rule above; the text providers (Mistral, Local AI, Custom)
// are allowed too, because their prepared turn is background-priority work that gives way to any turn of V's (bridge/text-provider-host.mjs, `prepared`).
export function lookaheadAllowed({singleSession = false, connectionLimit = 1, textProvider = false, kind = 'group'} = {}) {
  if (textProvider) return PREPARED_KINDS.includes(kind);
  return !singleSession || (Number.isFinite(connectionLimit) && connectionLimit >= 2);
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
  // meta (a prepared line, see PREPARED_KINDS): {kind, sourceRequestId, maxHoldMs}; a group speaker has none and is held for this.maxHoldMs.
  offer(predicted, meta = {}) {
    const key = turnKey(predicted);
    if (this.entry?.key === key) return this.entry;
    this.cancel('replaced');
    let resolveClaim, rejectClaim;
    const claimed = new Promise((resolve, reject) => { resolveClaim = resolve; rejectClaim = reject; });
    claimed.catch(() => {});
    const entry = this.entry = {key, input: predicted, controller: new AbortController(), owner: new AheadOwner(),
      kind: meta.kind ?? 'group', sourceRequestId: meta.sourceRequestId, maxHoldMs: meta.maxHoldMs ?? this.maxHoldMs, sourceGoneAt: null,
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
    if (this.entry && this.now() - this.entry.startedAt > this.entry.maxHoldMs) this.cancel();
  }

  /**
   * A held follow-on whose source turn is gone (cancelled, withdrawn, replaced by another turn) is dropped. `sourceGone` says so. It must stay true for
   * `graceMs` first: the game submits the held turn the moment the source has been heard, and that same submission is what ends the source, so a
   * source seen gone at that instant is the claim in progress, not a cancellation.
   */
  async watchSource(sourceGone, graceMs = 1500) {
    const entry = this.entry;
    if (!entry || entry.sourceRequestId === undefined) return false;
    const gone = await sourceGone(entry);
    if (this.entry !== entry) return false;   // claimed or replaced while the source was being looked at
    if (!gone) { entry.sourceGoneAt = null; return false; }
    entry.sourceGoneAt ??= this.now();
    if (this.now() - entry.sourceGoneAt < graceMs) return false;
    return this.cancel();
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
