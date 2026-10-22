// How much audio a voice's line needs buffered before its first sound, learned from how its recent lines played.
//
// A voice that generates a reply while it plays (the Mistral Voxtral cloud voice, the Pocket voice on the CPU, the Convai voice) can deliver
// more slowly than the audio plays, or in bursts with gaps, and then the voice breaks (the buffer runs dry, the renderer waits and speech resumes).
// Live 2026-10-16 (the Delamain cab): the typed answers took 6.5 to 9.6 s to play audio of 4.6 to 6.2 s. 2026-10-22 review of 367 player reports:
// 59 of the 62 broken lines were the Pocket voice on a busy CPU, which had no lead at all.
// Nothing here costs latency while lines play whole: the lead is 0 (the renderer's own 0.4 s applies) until one of the last few lines of the
// voice broke, and then each new line waits for `lead` seconds of audio (or the end of the stream, or the wait limit) before it starts, so
// the next lines have room to ride out the same gaps. A run of whole lines puts the voice back at no extra wait.
// The lead follows the speed the broken line was measured to have been produced at (its seconds of audio over the time it took to play it):
// the slower the voice, the longer the lead, up to maxLead, and the wait limit follows it (up to maxWaitCapMs). One SpeechPace is kept per
// voice engine (bridge/convai-bridge.mjs): the speed is the engine's and the machine's, not the character's.
export class SpeechPace {
  constructor({keep = 3, lead = 1.2, maxWaitMs = 1500, maxLead = 2.4, maxWaitCapMs = 3000} = {}) {
    Object.assign(this, {keep, leadSeconds: lead, maxWaitMs, maxLead, maxWaitCapMs});
    this.history = [];
  }

  /**
   * A line has been played to its end: how many times its audio ran dry, and (when it broke) how long its audio took to play, so the speed it
   * was produced at is known: {seconds, playedMs}.
   */
  note(underruns, {seconds, playedMs} = {}) {
    if (!Number.isSafeInteger(underruns) || underruns < 0) return;
    const speed = underruns > 0 && seconds >= 1 && playedMs > seconds * 1000 ? seconds * 1000 / playedMs : null;
    this.history.push({underruns, speed});
    while (this.history.length > this.keep) this.history.shift();
  }

  get broke() { return this.history.some(entry => entry.underruns > 0); }

  /** The slowest speed (seconds of audio per second) a recent broken line was produced at, or null when none could be told. */
  get speed() {
    const speeds = this.history.filter(entry => entry.underruns > 0 && entry.speed !== null).map(entry => entry.speed);
    return speeds.length ? Math.min(...speeds) : null;
  }

  /** Seconds of audio the next line waits for before its first sound; 0 for none. */
  get lead() {
    if (!this.broke) return 0;
    const speed = this.speed;
    return speed === null ? this.leadSeconds : Math.min(this.maxLead, this.leadSeconds * (2 - Math.min(1, speed)));
  }

  /** The longest the next line stays silent for its lead (ms after its first audio). */
  get waitMs() {
    const speed = this.speed, lead = this.lead;
    if (!lead || speed === null) return this.maxWaitMs;
    return Math.min(this.maxWaitCapMs, Math.max(this.maxWaitMs, Math.ceil(lead / Math.max(speed, 0.1) * 1000)));
  }

  /** True while a line that has `buffered` seconds of audio, `waitedMs` after its first audio, should still stay silent. */
  holds(buffered, waitedMs, {complete = false} = {}) {
    const lead = this.lead;
    return lead > 0 && !complete && buffered < lead && waitedMs < this.waitMs;
  }
}
