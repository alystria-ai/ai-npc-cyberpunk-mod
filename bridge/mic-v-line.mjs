// V's voice for what the player SAID (setting vVoiceMic, off by default; docs/V_VOICE.md "Microphone lines").
//
// The line of a voice turn (hold to talk, Voice activation) is V's voice repeating the final transcript. It is started by the transcript callback of the
// microphone channel (`options.onTranscript`, bridge/local-stt-capture.mjs), which runs after the recognition and before the reply is asked for, so the line
// is synthesized beside the reply's text request. It is a SOFT VLine (bridge/v-voice.mjs): the reply never holds for it. When the reply asks (its audio is
// ready, or its voice request goes out on a worker the two share) a line that is not finished is cut short, or dropped when it is not audible yet.
//
// Where a transcript cannot exist before the reply (the Convai provider recognises the speech together with the reply) nothing is started and the reason is
// logged once. An empty recording never reaches the callback (the channel fails with "no speech" first). A cancelled or superseded turn aborts its signal
// (the microphone session's), and a new turn ends the line of the previous one (dropAll). Nothing here runs unless V's voice and the setting are both on.
import {TurnClock, withClock} from './turn-clock.mjs';

export class MicVLines {
  /**
   * vVoice     the VVoice instance (bridge/v-voice.mjs)
   * stopped    () => boolean: the bridge is shutting down
   * max        how many turns' entries are kept (the oldest is dropped first)
   */
  constructor({vVoice, stopped = () => false, max = 4} = {}) {
    Object.assign(this, {vVoice, stopped, max});
    this.entries = new Map();   // request id -> {clock, line}
  }

  /** The turn's line while it is still pending or audible, else null. A settled line is forgotten, so a reply that asks later finds nothing to hold for. */
  lineOf(requestId) {
    const line = this.entries.get(requestId)?.line ?? null;
    return line && !line.settled ? line : null;
  }

  /** The clock the turn's reply voice marks 'ttsSent' on (bridge/voice-key-stream, synthesizeReply run inside it), or null when the turn has no line. */
  clockOf(requestId) { return this.entries.get(requestId)?.clock ?? null; }

  /** Ends every turn's line (a new turn starts: a typed message, a new recording, a cancel). */
  dropAll(reason = 'turn-ended') {
    for (const entry of this.entries.values()) entry.line?.drop(reason);
    this.entries.clear();
  }

  open(requestId) {
    const entry = {clock: new TurnClock(), line: null};
    this.entries.set(requestId, entry);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      this.entries.get(oldest)?.line?.drop('turn-ended');
      this.entries.delete(oldest);
    }
    return entry;
  }

  /**
   * The final transcript of the turn is known: start V's soft line for it, beside the reply. Returns the line or null (setting off, no entry, empty
   * transcript, cancelled turn, a language or engine V cannot speak). Never throws, never waits.
   */
  start(input, transcript, signal) {
    try {
      if (!this.vVoice.micWanted || signal?.aborted || this.stopped() || typeof transcript !== 'string' || !transcript.trim()) return null;
      const entry = this.entries.get(input.requestId);
      if (!entry) return null;
      if (entry.line) return entry.line;
      this.vVoice.noteGender(input);
      const line = this.vVoice.startSpoken(input, transcript.trim(), {signal, clock: entry.clock});
      if (!line) { this.entries.delete(input.requestId); return null; }
      entry.line = line;
      line.whenClear(() => { if (this.entries.get(input.requestId)?.line === line) this.entries.delete(input.requestId); });
      return line;
    } catch { return null; }
  }

  /**
   * Wraps the microphone session's prepareReply(input, signal) -> options. With the setting off, for an add-on's or a made character's voice turn (they start
   * V from their own turn, runAddonTurn) and on the Convai provider nothing changes. Otherwise the turn gets an entry, the reply is prepared inside the entry's
   * clock (so its voice requests mark 'ttsSent' there) and the options carry a transcript callback that starts V's line.
   * `own(input)`: the turn starts V by itself; `textRoute()`: the provider is a text one (Mistral, Local AI, Custom), the only kind with a transcript before the reply.
   */
  wrapPrepare(prepare, {own = () => false, textRoute = () => true} = {}) {
    return async (input, signal) => {
      if (own(input) || !this.vVoice.micWanted) return prepare(input, signal);
      if (!textRoute()) {
        this.vVoice.micUnavailable('convai', "V's microphone line skipped: the Convai provider recognises speech together with the reply, so there is no transcript to start from");
        return prepare(input, signal);
      }
      const entry = this.open(input.requestId);
      const options = await withClock(entry.clock, () => prepare(input, signal));
      return {...options, onTranscript: text => {
        try { options?.onTranscript?.(text); } catch { /* a listener never breaks the turn */ }
        this.start(input, text, signal);
      }};
    };
  }

  /** Wraps onReply(input, result, signal) so the non-streamed reply's voice request is made inside the turn's clock too. */
  wrapReply(reply) {
    return (input, result, signal) => {
      const clock = this.clockOf(input.requestId);
      return clock ? withClock(clock, () => reply(input, result, signal)) : reply(input, result, signal);
    };
  }
}
