// One reply, one voice (docs/CLOUD_VOICE_INWORLD.md, "One voice per reply").
//
// A reply that is voiced in two parts (its first sentence while the model is still writing, then the rest: bridge/pocket-speech.mjs)
// is two calls to the voice. A cloud voice can fail before its audio starts; Pocket then speaks the reply, but only the WHOLE reply:
// the second part must follow the first part's voice, never switch to the other one inside the reply.
//
// The first part decides: it speaks with the cloud voice as soon as the first packet reaches the player, or with Pocket when the cloud
// voice could not start. A later part waits for that decision and follows it. Once the cloud voice has begun, a failure of a later
// part ends the reply early (what was spoken stands); it is never handed to Pocket.
import {cancelled} from './transport-pool.mjs';

export class ReplyVoice {
  constructor() {
    this.engine = null;      // null until decided, then the name of the cloud voice ('inworld') or 'pocket'
    this.started = false;    // a first part has claimed the decision
    this.waiters = new Set();
  }
  /** The first call of a reply claims the decision; every later call must wait for it. */
  claim() {
    if (this.started) return false;
    this.started = true;
    return true;
  }
  /** Records the voice of this reply (the first decision stands) and wakes the parts waiting for it. */
  decide(engine) {
    if (this.engine !== null) return this.engine;
    this.engine = engine;
    for (const waiter of this.waiters) waiter(engine);
    this.waiters.clear();
    return engine;
  }
  /** Resolves with the decided voice; rejects when `signal` aborts first. */
  decision(signal) {
    if (this.engine !== null) return Promise.resolve(this.engine);
    return new Promise((resolve, reject) => {
      const onAbort = () => { this.waiters.delete(done); reject(cancelled()); };
      const done = engine => { signal?.removeEventListener('abort', onAbort); resolve(engine); };
      this.waiters.add(done);
      if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, {once: true});
    });
  }
}
