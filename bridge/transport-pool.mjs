// A lease owns one page until it is released. Page creation and disposal are
// serialized so even a cancelled startup cannot exceed the browser page cap.
export function endUserOptions(config) {
  const id = config.endUserId;
  // Unknown identity stays anonymous. Metadata alone must not establish one.
  if (id === undefined || id === null) return {};
  if (typeof id !== 'string' || !id.trim()) throw Error('Invalid conversation user identity');
  // A fresh session still shares identified LTM. Dropping a speculative page
  // cannot undo that write, so identified preparation must be gated upstream.
  if (config.freshSession) throw Error('Identified conversations cannot use speculative preparation');
  const metadata = config.endUserMetadata;
  if (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
    throw Error('Invalid conversation user metadata');
  }
  return {endUserId: id, ...(metadata != null ? {endUserMetadata: metadata} : {})};
}

const sessionIdentity = config => [config.characterId, endUserOptions(config).endUserId ?? null, config.scope || 'private'];

export const transportKey = config => JSON.stringify([...sessionIdentity(config), config.ttsEnabled !== false]);

// Upstream persistence owns provenance for a session first seen here. Once a
// supplied or returned session is bound, even another page may not adopt it for
// a different user/save namespace or audience. TTS changes keep that ownership.
export class SessionBindings {
  constructor() { this.owners = new Map(); }
  accept(config) { if (!config.freshSession) this.bind(config, config.sessionId); }
  bind(config, sessionId) {
    if (sessionId == null || sessionId === '' || sessionId === '-1') return;
    if (typeof sessionId !== 'string') throw Error('Invalid conversation session');
    const owner = JSON.stringify(sessionIdentity(config)), previous = this.owners.get(sessionId);
    if (previous !== undefined && previous !== owner) throw Error('Conversation session belongs to another user or scope');
    this.owners.set(sessionId, owner);
  }
}

export function cancelled(message = 'Conversation cancelled') {
  const error = Error(message); error.name = 'AbortError'; return error;
}

export function throwIfCancelled(signal) { if (signal?.aborted) throw cancelled(); }

export function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(cancelled()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export class TransportPool {
  constructor({create, dispose, limit = 3}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 11) throw Error('Transport pool must contain one to eleven pages');
    Object.assign(this, {create, dispose, limit});
    this.entries = new Map(); this.closed = false; this.serial = Promise.resolve();
    this.protectedKeys = new Set();
    this.stats = {created: 0, reused: 0, evicted: 0, maximum: 0};
    this.change();
  }
  change() {
    this.notify?.(); this.changed = new Promise(resolve => { this.notify = resolve; });
  }
  lock(fn) { const task = this.serial.then(fn); this.serial = task.catch(() => {}); return task; }
  async remove(entry) {
    if (this.entries.get(entry.key) !== entry) return;
    // Keep it counted until the underlying page has actually closed.
    entry.removed = true;
    try { await this.dispose(entry.value); }
    finally { this.entries.delete(entry.key); this.change(); }
  }
  async acquire(key, {signal} = {}) {
    while (true) {
      throwIfCancelled(signal);
      const outcome = await this.lock(async () => {
        throwIfCancelled(signal);
        if (this.closed) throw cancelled('Transport pool closed');
        let entry = this.entries.get(key), reused = !!entry;
        if (entry?.busy) return {wait: this.changed};
        if (!entry) {
          if (this.entries.size >= this.limit) {
            const idle = [...this.entries.values()].filter(row => !row.busy && !this.protectedKeys.has(row.key)).sort((a, b) => a.used - b.used)[0];
            if (!idle) return {wait: this.changed};
            await this.remove(idle); this.stats.evicted++;
          }
          throwIfCancelled(signal);
          if (this.closed) throw cancelled('Transport pool closed');
          entry = {key, busy: true, used: performance.now(), value: null};
          this.entries.set(key, entry);
          this.stats.maximum = Math.max(this.stats.maximum, this.entries.size);
          try {
            entry.value = await this.create(key);
            this.stats.created++;
            throwIfCancelled(signal);
            if (this.closed) throw cancelled('Transport pool closed');
          } catch (error) { await this.remove(entry); throw error; }
        }
        entry.busy = true; entry.used = performance.now();
        if (reused) this.stats.reused++;
        let released = false;
        return {lease: {value: entry.value, reused, release: ({discard = false} = {}) => this.lock(async () => {
          if (released) return;
          released = true;
          if (this.entries.get(key) !== entry) return;
          if (discard || this.closed) await this.remove(entry);
          else { entry.busy = false; entry.used = performance.now(); this.change(); }
        })}};
      });
      if (outcome.lease) return outcome.lease;
      await abortable(outcome.wait, signal);
    }
  }
  retain(keys, {protect = false} = {}) {
    const allowed = new Set(keys);
    return this.lock(async () => {
      this.protectedKeys = protect ? allowed : new Set();
      for (const entry of [...this.entries.values()]) if (!allowed.has(entry.key)) await this.remove(entry);
      this.change();
    });
  }
  close() {
    this.closed = true; this.change();
    return this.lock(async () => { for (const entry of [...this.entries.values()]) await this.remove(entry); });
  }
}
