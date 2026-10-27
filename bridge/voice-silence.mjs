// "The voice never played": replies went out while the player has voice playback on, and not one of them made a sound, for a whole bridge run (docs/ERROR_REPORTS.md).
// A voice that fails to START is reported where it fails (bridge/voice-selection.mjs noteFailure -> ErrorEvents.voiceFailed). This catches the rest: the voice looked fine
// and still nothing was heard (a hidden browser page that never played, a renderer that got no audio, a worker that answered with silence, a game that never read the lease),
// and a player who sees subtitles only without any failure having been logged (a Discord report of 27 Oct 2026: "the npcs don't have voice, i only receive responses by subtitles").
//
// Cost: one call per finished turn, a few property reads on the stage clock the bridge already keeps (bridge/turn-clock.mjs), one short timer per turn that has not sounded
// yet. Nothing per frame, nothing per audio chunk, no file read.
//
// A turn counts as SILENT when playback is on, the voice planner gave it a voice (the bridge annotates the clock with `voicePlan`/`voiceReason`), its reply was published, the
// turn did not fail and the game was not paused, and `graceMs` after its run ended the renderer's clock had still not shown sound (`playbackObserved`). A turn the planner kept
// written on purpose (a language the chosen voice does not speak) is left out. The report is made once per bridge run, when `silentTurns` turns were silent and none ever sounded.
//
// Carries: counts, the furthest voice stage the last silent turn reached, and fixed words. Never a word anyone said.

export const VOICE_SILENCE = Object.freeze({silentTurns: 3, graceMs: 30_000});

// The stages a spoken reply goes through, in order (bridge/turn-clock.mjs); the furthest one a silent turn reached says where the sound stopped.
const VOICE_STAGES = Object.freeze(['voiceStart', 'browserReady', 'playStart', 'rendererReady', 'ttsSent', 'firstPcm', 'firstPcmAccepted', 'firstFrame', 'published', 'leaseRead']);
// Reasons the voice planner (bridge/multilingual.mjs planTurnVoice) keeps a reply written although playback is on: the chosen voice does not speak the language. Not a failure.
const WRITTEN_BY_DESIGN = new Set(['english-only-voice', 'pocket-language-pack-missing', 'voice-language-unsupported']);
const WORD = /^[A-Za-z0-9._:-]{1,80}$/;

export class VoiceSilenceWatch {
  /**
   * onSilent(data): called once, with the report's summary. wanted(): voice playback is on. context(): {engine, requested, active, fellBackTo} read once, when the report is made.
   * setTimer/clearTimer/thresholds: for the tests.
   */
  constructor({onSilent = () => {}, wanted = () => true, context = () => ({}), setTimer = setTimeout, clearTimer = clearTimeout, thresholds = {}} = {}) {
    Object.assign(this, {onSilent, wanted, context, setTimer, clearTimer});
    this.limits = {...VOICE_SILENCE, ...thresholds};
    this.turns = 0; this.silent = 0; this.played = 0;
    this.lastStage = undefined;
    this.reasons = new Set();
    this.reported = false;
  }

  /** One finished turn, judged now. Returns the data handed to onSilent, or null. Never throws: a report is never worth a failed turn. */
  observe(clock) {
    try {
      if (this.reported || !this.wanted()) return null;
      const marks = clock.snapshot().marks ?? {}, details = clock.details ?? {};
      if (Number.isFinite(marks.playbackObserved)) { this.turns += 1; this.played += 1; return null; }
      if (details.failed === true || details.gamePaused === true) return null;
      if (typeof details.voicePlan !== 'string' || !Number.isFinite(marks.published)) return null;
      if (WRITTEN_BY_DESIGN.has(details.voiceReason)) return null;
      this.turns += 1; this.silent += 1;
      this.lastStage = [...VOICE_STAGES].reverse().find(stage => Number.isFinite(marks[stage]));
      for (const word of [details.voicePlan, details.voiceReason]) if (typeof word === 'string' && WORD.test(word) && this.reasons.size < 8) this.reasons.add(word);
      if (this.played > 0 || this.silent < this.limits.silentTurns) return null;
      this.reported = true;
      let context = {};
      try { context = this.context() ?? {}; } catch { /* the context is optional */ }
      const data = {...context, turns: this.turns, silentTurns: this.silent, playedTurns: this.played, lastStage: this.lastStage, reasons: [...this.reasons]};
      this.onSilent(data);
      return data;
    } catch { return null; }
  }

  /**
   * Watches one turn's clock. A turn that sounds is counted at once; one that has not sounded when its run ends is judged `graceMs` later (the sound of a spoken reply
   * usually starts after the run has returned). The timer is unreferenced, one per turn, and gone after it fires.
   */
  track(clock) {
    let judged = false, timer = null;
    const judge = () => {
      if (judged) return;
      judged = true;
      if (timer !== null) { this.clearTimer(timer); timer = null; }
      this.observe(clock);
    };
    try { clock.on('playbackObserved', () => judge()); } catch { return () => {}; }
    return () => {
      try {
        if (judged || this.reported) return;
        if (clock.has('playbackObserved')) { judge(); return; }
        timer = this.setTimer(judge, this.limits.graceMs);
        timer?.unref?.();
      } catch { /* never fails a turn */ }
    };
  }
}
