// One spoken reply that is voiced in more than one piece, and the voice that speaks it.
//
// A streamed reply (bridge/reply-stream.mjs, bridge/pocket-speech.mjs) is voiced as its first sentence (the HEAD) and, once the model
// has finished, the rest (the TAIL): two synthesis calls for one reply. The player must hear one voice. So the tail follows the head:
// the head's call says which engine spoke it (`decide`), and the tail is spoken by that engine only. A cloud voice (Voxtral) that
// fails before ANY audio was heard leaves the whole reply unspoken (written text: no local voice is loaded to take it over); one that
// fails after its first audio was heard ends the reply there (docs/CLOUD_VOICE_VOXTRAL.md). The same lock serves every cloud voice (Voxtral and
// Inworld, docs/CLOUD_VOICE_INWORLD.md): the engine is named 'voxtral', 'inworld' or 'pocket' ('pocket' also stands for "no cloud voice spoke the head").
//
// The tail is asked for as soon as its text is known, usually before the head has produced its first audio, so the decision may not
// exist yet: `decision` resolves with it, and the tail's audio is held until it does (bridge/voice-selection.mjs).

import {cancelled} from './transport-pool.mjs';

export const CLOUD_ENGINES = Object.freeze(['voxtral', 'inworld']);
const isCloud = engine => CLOUD_ENGINES.includes(engine);

export class Utterance {
  constructor() {
    this.engine = null;                       // null until decided, then 'voxtral', 'inworld' or 'pocket'
    this.decision = new Promise(resolve => { this.resolve = resolve; });
  }

  /** The engine that speaks the head (a cloud voice once its first audio is delivered; 'pocket' when Pocket speaks it). The first decision stands. */
  decide(engine) {
    if (this.engine) return this.engine;
    this.engine = isCloud(engine) ? engine : 'pocket';
    this.resolve(this.engine);
    return this.engine;
  }

  /** Resolves with the decided engine; rejects as a cancellation when `signal` aborts first (a part waiting for the head never outlives its reply). */
  wait(signal) {
    if (this.engine !== null) return Promise.resolve(this.engine);
    if (!signal) return this.decision;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(cancelled());
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, {once: true});
      this.decision.then(engine => { signal.removeEventListener('abort', onAbort); resolve(engine); });
    });
  }

  /** Decides from the head's finished result when nothing decided yet (a head that came from a buffer, or from a voice that does not report). */
  settle(result) {
    const named = [result?.provider, result?.engine, result?.timing?.voiceEngine].find(isCloud);
    return this.decide(named ?? 'pocket');
  }
}
