// A lease owns one page until it is released. Page creation and disposal are
// serialized so even a cancelled startup cannot exceed the browser page cap.
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
