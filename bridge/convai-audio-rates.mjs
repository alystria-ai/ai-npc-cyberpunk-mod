// The sample rate Convai's audio really arrives at, remembered per Convai character, for the characters whose packets carry another rate than their label says.
//
// Audio that arrives at another rate than its packets say is corrected by bridge/convai-data-audio.mjs when the final statistics have arrived and the bytes that came prove it, which a
// turn played live (continuous speech) cannot wait for: its first packets are already in the player at the label's rate. So the first turn of such a character is corrected late,
// and this remembers what it showed: every later turn of that character is told the rate with its config (`config.audioRate`, read by bridge/realtime-client.mjs) and plays right
// from the first sample. The memory is a plain Map read once per turn (no request, no timer) and is saved to the state folder (`onChange`) when it changes, so it also holds in
// the next session.
//
// Nothing is guessed in advance. A first version assumed 44.1 kHz for every multilingual twin before any turn had shown it (error reports 14e50b97, 7ff4a160, 83a236be, 2026-10-21, were
// read as 44.1 kHz audio in packets that say 24 kHz), but the twins' audio arrives at 24 kHz and only Convai's statistics count it in 44.1 kHz bytes, so every Ukrainian, Russian or
// other twin line was played 1.84 times too fast ("like they inhaled helium") and never counted as complete. A rate is remembered only after the bytes of a turn proved it
// (`sampleRateCorrected` in the result is set only then).
import {validRateHint} from './convai-data-audio.mjs';

export class AudioRates {
  // initial: {characterId: {declared, actual}} from the saved file (anything not usable is ignored; `null` is a character whose audio was found to be labelled right, see below);
  // onChange(object): the whole memory, to be saved; log(line): one line, no character id.
  constructor({initial, onChange, log} = {}) {
    this.map = new Map(); this.rightlyLabelled = new Set();
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.log = typeof log === 'function' ? log : () => {};
    if (initial && typeof initial === 'object' && !Array.isArray(initial)) {
      for (const [id, hint] of Object.entries(initial)) {
        if (id.length > 200) continue;
        const valid = validRateHint(hint);
        if (valid) this.map.set(id, valid); else if (hint === null) this.rightlyLabelled.add(id);
      }
    }
  }

  get size() { return this.map.size; }
  hintFor(characterId) { return typeof characterId === 'string' ? this.map.get(characterId) ?? null : null; }
  snapshot() { return {...Object.fromEntries(this.map), ...Object.fromEntries([...this.rightlyLabelled].map(id => [id, null]))}; }

  /** The config of a turn with the remembered rate of its character (and no stale one). Only a turn that asks for Convai's audio gets it. */
  forConfig(config) {
    const {audioRate: _stale, ...rest} = config ?? {};
    const hint = config?.ttsEnabled === false ? null : this.hintFor(config?.characterId);
    return hint ? {...rest, audioRate: hint} : rest;
  }

  /** What a finished turn showed: a correction is remembered (and saved when it is new); a remembered rate that the statistics did not confirm is forgotten. Never throws. */
  learn(config, result) {
    const id = config?.characterId;
    if (typeof id !== 'string' || !id || !result || typeof result !== 'object') return;
    try {
      const learned = validRateHint(result.sampleRateCorrected), known = this.map.get(id);
      if (learned) {
        if (known?.declared === learned.declared && known?.actual === learned.actual) return;
        this.map.set(id, learned); this.rightlyLabelled.delete(id);
        this.log(`Convai audio of a character arrives at ${learned.actual} Hz in packets that say ${learned.declared} Hz; remembered, later turns start at the right rate`);
      } else if (known && (result.sampleRateHintMissed === true || (result.sampleRate === known.declared && result.sampleRateHinted !== true))) {
        this.map.delete(id); this.rightlyLabelled.add(id);
        this.log(`Convai audio of a character no longer arrives at ${known.actual} Hz (it arrives at ${result.sampleRate ?? 'an unknown rate'} Hz); the remembered rate is dropped`);
      } else return;
      this.onChange?.(this.snapshot());
    } catch { /* a remembered rate is never worth failing a turn for */ }
  }
}
