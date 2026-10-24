// V's voice for what the player SAID (setting vVoiceMic, off by default; docs/V_VOICE.md "Microphone lines").
//
// The line of a voice turn (hold to talk, Voice activation) is V's voice repeating the final transcript. The player chose it, so it behaves exactly like a typed
// line (owner, 2026-10-24: "it's fine to wait, we should respect player choice"): it is a normal VLine (bridge/v-voice.mjs), spoken in full, and the reply's
// audio is held until it has finished (the same hold, grace and hand-off as for a typed line). It starts the moment the transcript is known:
//   - text providers (Mistral, Local AI, Custom): the microphone channel's transcript callback (`options.onTranscript`, bridge/local-stt-capture.mjs) runs after
//     the recognition and before the model request, so the line is synthesized beside the reply's text request;
//   - the Convai provider: the transcript arrives in the realtime stream (the renderer's snapshots carry `userText`). The reply's audio is buffered silently
//     anyway, so the continuous speech (bridge/convai-continuous-speech.mjs) keeps the reply quiet until the transcript has arrived (at most
//     TRANSCRIPT_WAIT_MS (convai-continuous-speech.mjs) after its first audio, then the reply goes on without V), starts the line from `onTranscript`, and holds the buffered reply
//     behind it exactly as it does for a typed line.
// An empty recording never reaches the callback (the channel fails with "no speech" first). A cancelled or superseded turn aborts its signal (the microphone
// session's), and a new turn ends the line of the previous one (dropAll). Nothing here runs unless V's voice and the setting are both on.

export class MicVLines {
  /**
   * vVoice     the VVoice instance (bridge/v-voice.mjs)
   * stopped    () => boolean: the bridge is shutting down
   * max        how many turns' entries are kept (the oldest is dropped first)
   */
  constructor({vVoice, stopped = () => false, max = 4} = {}) {
    Object.assign(this, {vVoice, stopped, max});
    this.entries = new Map();   // request id -> {line}
  }

  /** The turn's line while it is still pending or audible, else null. A settled line is forgotten, so a reply that asks later finds nothing to hold for. */
  lineOf(requestId) {
    const line = this.entries.get(requestId)?.line ?? null;
    return line && !line.settled ? line : null;
  }

  /** Ends every turn's line (a new turn starts: a typed message, a new recording, a cancel). */
  dropAll(reason = 'turn-ended') {
    for (const entry of this.entries.values()) entry.line?.drop(reason);
    this.entries.clear();
  }

  open(requestId) {
    const entry = {line: null};
    this.entries.set(requestId, entry);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      this.entries.get(oldest)?.line?.drop('turn-ended');
      this.entries.delete(oldest);
    }
    return entry;
  }

  /**
   * The final transcript of the turn is known: start V's line for it, beside the reply. Returns the line or null (setting off, no entry, empty transcript,
   * cancelled turn, a language or engine V cannot speak). Never throws, never waits.
   */
  start(input, transcript, signal) {
    try {
      if (!this.vVoice.micWanted || signal?.aborted || this.stopped() || typeof transcript !== 'string' || !transcript.trim()) return null;
      const entry = this.entries.get(input.requestId);
      if (!entry) return null;
      if (entry.line) return entry.line;
      this.vVoice.noteGender(input);
      const line = this.vVoice.startSpoken(input, transcript.trim(), {signal});
      if (!line) { this.entries.delete(input.requestId); return null; }
      entry.line = line;
      line.whenClear(() => { if (this.entries.get(input.requestId)?.line === line) this.entries.delete(input.requestId); });
      return line;
    } catch { return null; }
  }

  /**
   * What the Convai provider's continuous speech takes for this turn: `awaitTranscript()` (the reply's first audio waits for the transcript while it is true,
   * bounded by TRANSCRIPT_WAIT_MS) and `onTranscript(text)` (starts the line, and wakes the speech when the line nears its end or clears). Null when the turn
   * has no entry (the setting is off, or the turn starts V by itself).
   */
  convaiHooks(input, signal, wake = () => {}) {
    const entry = this.entries.get(input.requestId);
    if (!entry) return null;
    return {
      awaitTranscript: () => this.vVoice.micWanted && entry.line === null && this.entries.get(input.requestId) === entry,
      onTranscript: text => {
        const line = this.start(input, text, signal);
        if (!line) return;
        line.whenNearEnd(wake);
        line.whenClear(wake);
      },
    };
  }

  /**
   * Wraps the microphone session's prepareReply(input, signal) -> options. With the setting off, and for an add-on's or a made character's voice turn (they start
   * V from their own turn, runAddonTurn), nothing changes. Otherwise the turn gets an entry and the options carry a transcript callback that starts V's line
   * (text providers). `own(input)`: the turn starts V by itself.
   */
  wrapPrepare(prepare, {own = () => false} = {}) {
    return async (input, signal) => {
      if (own(input) || !this.vVoice.micWanted) return prepare(input, signal);
      this.open(input.requestId);
      const options = await prepare(input, signal);
      return {...options, onTranscript: text => {
        try { options?.onTranscript?.(text); } catch { /* a listener never breaks the turn */ }
        this.start(input, text, signal);
      }};
    };
  }
}
