// How much audio a cloud voice's line needs buffered before its first sound, learned from how its recent lines played.
//
// A cloud voice (Mistral Voxtral) streams a reply as it is generated. The renderer starts after 0.4 s of audio; when the service then
// delivers more slowly than the audio plays, or in bursts with gaps, the voice breaks (the buffer runs dry, the renderer waits for 0.4 s
// again and speech resumes). Live 2026-10-16 (the Delamain cab): the typed answers took 6.5 to 9.6 s to play audio of 4.6 to 6.2 s.
// Nothing here costs latency while lines play whole: the lead is 0 (the renderer's own 0.4 s applies) until one of the last few lines of the
// voice broke, and then each new line waits for `lead` seconds of audio (or the end of the stream, or `maxWaitMs`) before it starts, so
// the next lines have room to ride out the same gaps. A run of whole lines puts the voice back at no extra wait.
export class SpeechPace {
  constructor({keep = 3, lead = 1.2, maxWaitMs = 1500} = {}) {
    Object.assign(this, {keep, leadSeconds: lead, maxWaitMs});
    this.history = [];
  }

  /** A line has been played to its end: how many times its audio ran dry. */
  note(underruns) {
    if (!Number.isSafeInteger(underruns) || underruns < 0) return;
    this.history.push(underruns);
    while (this.history.length > this.keep) this.history.shift();
  }

  /** Seconds of audio the next line waits for before its first sound; 0 for none. */
  get lead() { return this.history.some(count => count > 0) ? this.leadSeconds : 0; }

  /** True while a line that has `buffered` seconds of audio, `waitedMs` after its first audio, should still stay silent. */
  holds(buffered, waitedMs, {complete = false} = {}) {
    const lead = this.lead;
    return lead > 0 && !complete && buffered < lead && waitedMs < this.maxWaitMs;
  }
}
