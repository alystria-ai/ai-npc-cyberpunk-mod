// One spoken reply that is voiced in more than one piece, and the voice that speaks it.
//
// A streamed reply (bridge/reply-stream.mjs, bridge/pocket-speech.mjs) is voiced as its first sentence (the HEAD) and, once the model
// has finished, the rest (the TAIL): two synthesis calls for one reply. The player must hear one voice. So the tail follows the head:
// the head's call says which engine spoke it (`decide`), and the tail is spoken by that engine only. A cloud voice (Voxtral) that
// fails before ANY audio was heard hands the whole reply to Pocket; one that fails after its first audio was heard never hands
// the rest to Pocket, the reply ends there instead (docs/CLOUD_VOICE_VOXTRAL.md).
//
// The tail is asked for as soon as its text is known, usually before the head has produced its first audio, so the decision may not
// exist yet: `decision` resolves with it, and the tail's audio is held until it does (bridge/voice-selection.mjs).

export class Utterance {
  constructor() {
    this.engine = null;                       // null until decided, then 'voxtral' or 'pocket'
    this.decision = new Promise(resolve => { this.resolve = resolve; });
  }

  /** The engine that speaks the head ('voxtral' once its first audio is delivered; 'pocket' when Pocket speaks it). The first decision stands. */
  decide(engine) {
    if (this.engine) return this.engine;
    this.engine = engine === 'voxtral' ? 'voxtral' : 'pocket';
    this.resolve(this.engine);
    return this.engine;
  }

  /** Decides from the head's finished result when nothing decided yet (a head that came from a buffer, or from a voice that does not report). */
  settle(result) {
    return this.decide(result?.provider === 'voxtral' || result?.engine === 'voxtral' || result?.timing?.voiceEngine === 'voxtral' ? 'voxtral' : 'pocket');
  }
}
