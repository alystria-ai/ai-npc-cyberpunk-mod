// The sample rate Convai's audio really arrives at, remembered per Convai character.
//
// Convai's multilingual twin sends 44.1 kHz audio in packets that say 24 kHz (error reports 14e50b97, 7ff4a160, 83a236be and others, 2026-10-21). bridge/convai-data-audio.mjs
// finds that out when the final statistics arrive, which a turn played live (continuous speech) cannot wait for: its first packets are already in the player at the label's rate.
// So the first turn of such a character is corrected late, and this remembers what it showed: every later turn of that character is told the rate with its config
// (`config.audioRate`, read by bridge/realtime-client.mjs) and plays right from the first sample. The memory is a plain Map read once per turn (no request, no timer) and is
// saved to the state folder (`onChange`) when it changes, so it also holds in the next session.
import {validRateHint} from './convai-data-audio.mjs';

export class AudioRates {
  // initial: {characterId: {declared, actual}} from the saved file (anything not usable is ignored; `null` is a character whose audio was found to be labelled right, see below);
  // onChange(object): the whole memory, to be saved; log(line): one line, no character id.
  // seed: {ids: [characterId...], hint: {declared, actual}}: characters that are expected to be mislabelled before any turn has shown it (the multilingual twins: every twin turn in
  // the 2026-10-21 reports was), so even their first turn starts at the right rate. A seed is only a first guess: a turn whose statistics do not confirm it drops it (the character is
  // then saved as `null`, and not seeded again), and one that does makes it a remembered rate like any other.
  constructor({initial, onChange, log, seed} = {}) {
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
    const seedHint = validRateHint(seed?.hint);
    if (seedHint && Array.isArray(seed.ids)) {
      for (const id of seed.ids) {
        if (typeof id === 'string' && id && id.length <= 200 && !this.map.has(id) && !this.rightlyLabelled.has(id)) this.map.set(id, seedHint);
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
