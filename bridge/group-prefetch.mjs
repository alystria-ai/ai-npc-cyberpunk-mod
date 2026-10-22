import {createHash} from 'node:crypto';
import {snapshotKey} from './parsed-snapshot.mjs';
import {parseInput} from './protocol.mjs';
import {abortable, cancelled} from './transport-pool.mjs';

// Use every normalized input field, including listener order and heard text.
// A request ID alone does not identify the context a speculative reply used.
export function inputIdentity(input, context = '') {
  return parsedInputIdentity(parseInput(JSON.stringify(input)), context);
}

// The same digest for a value that parseInput itself just returned. Re-parsing
// a parsed request (with its large journal history) cost about 40 ms per turn. The two large snapshots enter by cached digest
// (bridge/parsed-snapshot.mjs), so hashing the request no longer serialises 800 KB of them again.
export function parsedInputIdentity(parsed, context = '') {
  const keyed = parsed !== null && typeof parsed === 'object'
    ? {...parsed, worldKnowledge: snapshotKey(parsed.worldKnowledge), journalHistory: snapshotKey(parsed.journalHistory), provider: undefined} : parsed;
  return createHash('sha256').update(JSON.stringify([keyed, context])).digest('hex');
}

export function parsePrewarm(value, ids) {
  if (!value || typeof value.nonce !== 'string' || !value.nonce || value.nonce.length > 120
      || typeof value.group !== 'boolean' || !Array.isArray(value.audience)
      || value.audience.length < 1 || value.audience.length > 3 || (!value.group && value.audience.length !== 1)
      || value.audience.some(key => typeof key !== 'string' || !Object.hasOwn(ids, key))
      || new Set(value.audience).size !== value.audience.length) return null;
  // A private hint may name the addressed NPC's entity (an ambient profile has no route without it).
  const entity = !value.group && typeof value.entity === 'string' && /^\d{1,24}ULL$/.test(value.entity) ? value.entity : undefined;
  // A private hint for a holocall's caller (mod/holocall.lua) is opened at once, even on a plan that pre-opens nothing.
  return {nonce: value.nonce, audience: value.audience, scope: value.group ? 'group:' + [...value.audience].sort().join(',') : 'private',
    ...(entity ? {entity} : {}), ...(!value.group && value.call === true ? {call: true} : {})};
}

export function validatePrefetch(command, source) {
  if (!command || !source || command.sourceRequestId !== source.input.requestId) return null;
  const input = parseInput(JSON.stringify(command.input)), before = source.input.group, next = input?.group;
  if (!before || !next || next.id !== before.id || next.index <= before.index || next.total !== before.total
      || input.requestId === source.input.requestId || input.generation <= source.input.generation
      || input.profileKey === source.input.profileKey || input.text !== source.input.text
      || !next.audience.includes(input.profileKey)
      || JSON.stringify(next.audience) !== JSON.stringify(before.audience)) return null;
  // The current reply is only *predicted* to be heard. The submitted input must
  // confirm it after native playback; failed playback produces a different key.
  const latest = next.heard.at(-1);
  if (!latest || latest.speaker !== source.input.name || latest.text !== source.text) return null;
  return input;
}

export class GroupPrefetch {
  constructor({prepare, now = Date.now, maxAgeMs = 45000}) {
    Object.assign(this, {prepare, now, maxAgeMs}); this.source = this.current = null;
  }
  published(input, text) { this.invalidate(); this.source = {input, text}; }
  invalidate() { const entry = this.current; this.current = null; entry?.controller.abort(); }
  prune() { if (this.current && this.now() - this.current.startedAt > this.maxAgeMs) this.invalidate(); }
  offer(command, context = '') {
    this.prune();
    const input = validatePrefetch(command, this.source);
    if (!input) { this.invalidate(); return null; }
    const identity = inputIdentity(input, context);
    if (this.current?.identity === identity) return this.current;
    this.invalidate();
    const entry = this.current = {input, identity, controller: new AbortController(), startedAt: this.now()};
    entry.promise = Promise.resolve().then(() => {
      if (entry.controller.signal.aborted) throw cancelled();
      return this.prepare(input, {signal: entry.controller.signal});
    }).then(result => { entry.readyAt = this.now(); return result; });
    // A rejected prediction must never become an unhandled rejection, or make
    // the real submitted turn fail instead of using the normal response path.
    entry.promise.catch(() => {});
    return entry;
  }
  claim(input, context = '', {signal} = {}) {
    this.prune();
    const entry = this.current;
    if (!entry || entry.identity !== inputIdentity(input, context)) { this.invalidate(); return null; }
    this.current = null;
    const claimedAt = this.now(), readyOnClaim = !!entry.readyAt;
    const cancel = () => entry.controller.abort();
    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel();
    const promise = abortable(entry.promise, signal).then(result => {
      if (entry.controller.signal.aborted) throw cancelled();
      return {...result, preparation: {mode: 'isolated-fresh-session', readyOnClaim,
        startedAt: entry.startedAt, readyAt: entry.readyAt, claimedAt,
        remainingWaitMs: this.now() - claimedAt,
        overlappedMs: Math.max(0, Math.min(claimedAt, entry.readyAt) - entry.startedAt)}};
    }).finally(() => signal?.removeEventListener('abort', cancel));
    promise.cancel = cancel;
    return promise;
  }
}
