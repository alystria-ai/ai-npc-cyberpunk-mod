// A voice clip given to a character in the editor, or taken away, counts from the next thing that character says: no restart of the game or of the
// service (docs/CHARACTER_EDITOR.md, "Voice clips"). This is the one place that turns the editor's save into the voices the engines should hold now.
//
// At start the bridge merges the clips that exist into the voice configurations (AddonHost.voiceConfigPaths) and the workers read those files.
// After that this class keeps the same three tables the bridge started with (Pocket's, OmniVoice's short and long ones: each configuration's `voices`
// object) and, when one character's clip changes, edits that one key in each of them:
//   a clip         the key's descriptor becomes {reference: runtime/player-voices/<key>.wav, sha256, transcript}, the player's clip as the index and the
//                  file agree on it (PlayerVoices.extras checks the hash);
//   no clip        the key goes back to the descriptor the shipped configuration has (read from the original, unmerged file), or leaves the table when
//                  the shipped configuration has none (a character the player made, which then speaks with the voice of its gender again).
// The new tables go to VoiceSelection.setVoices, which applies them at the next moment no reply is in flight, sends each running worker only the
// difference, and drops only that character's prepared voice (bridge/voice-selection.mjs). The cloud voices read the same registries and forget only
// that character. Nothing here runs on a timer or per turn: it runs when the player saves or removes a clip.
//
// Changes are handled one at a time, in the order they were made, so two quick saves end as the second one says.
import {readFile} from 'node:fs/promises';
import {PLAYER_REFERENCE_PREFIX} from './player-voices.mjs';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ENGINES = Object.freeze(['pocket', 'short', 'long']);

/** The `voices` object of a configuration (the parsed JSON), or null when it has none (that engine is not set up, so nothing is changed for it). */
export const voicesOf = config => plain(config) && plain(config.voices) ? config.voices : null;

/** The table of one engine with one character's clip applied: `descriptor` (the clip), else the shipped descriptor, else the key is gone. A new table. */
export function withPlayerVoice(voices, key, descriptor, shipped = null) {
  const next = {...voices};
  if (descriptor) next[key] = {reference: descriptor.reference, sha256: descriptor.sha256, transcript: descriptor.transcript};
  else if (plain(shipped?.[key])) next[key] = shipped[key];
  else delete next[key];
  return next;
}

export class LiveVoices {
  /**
   *   voices      {pocket, short, long}: the `voices` objects of the configurations the workers started with (a null or missing one: not set up)
   *   shipped     async () => {pocket, short, long}: the same engines' `voices` as the shipped, unmerged files have them (read when a clip changes)
   *   players     PlayerVoices (descriptor reading: extras)
   *   allowed     key => boolean: a story character or a character the player still has; any other key has no clip
   *   folder      the player voice folder the clips are in (PlayerVoices.folder)
   *   apply       update => boolean: VoiceSelection.setVoices
   *   log         (message) => void: never given the words said in a clip
   */
  constructor({voices = {}, shipped = async () => ({}), players, allowed = () => true, folder = null, apply, log = () => {}} = {}) {
    Object.assign(this, {shipped, players, allowed, folder, apply, log});
    this.voices = Object.fromEntries(ENGINES.map(engine => [engine, plain(voices[engine]) ? {...voices[engine]} : null]));
    this.chain = Promise.resolve();
  }
  /** The descriptor of a character's clip as the engines name it, or null (no clip, a clip whose file does not match the index, or a key that may not have one). */
  async descriptor(key) {
    let found = [];
    try { found = await this.players.extras(candidate => candidate === key && this.allowed(candidate) === true); } catch { found = []; }
    const clip = found[0];
    return clip ? {reference: `${PLAYER_REFERENCE_PREFIX}${key}.wav`, sha256: clip.sha256, transcript: clip.transcript} : null;
  }
  /** The character's clip changed (saved, its words changed, removed): the tables follow. Resolves to what setVoices answered (true: applied now). */
  refresh(key) {
    const job = this.chain.catch(() => {}).then(async () => {
      const descriptor = await this.descriptor(key);
      let shipped = {};
      if (!descriptor) { try { shipped = await this.shipped() ?? {}; } catch { shipped = {}; } }
      const update = {changed: [key], playerVoiceDirectory: this.folder, omni: {}};
      for (const engine of ENGINES) {
        if (!this.voices[engine]) continue;
        this.voices[engine] = withPlayerVoice(this.voices[engine], key, descriptor, shipped[engine]);
        if (engine === 'pocket') update.pocket = this.voices.pocket; else update.omni[engine] = this.voices[engine];
      }
      return this.apply(update);
    });
    this.chain = job;
    return job;
  }
}

/** A reader of the shipped (unmerged) configurations' voices: `paths` = {pocket, omni: {short, long}} as bridge/voice-config-paths.mjs resolves them. */
export function shippedVoicesReader(paths, {read = file => readFile(file, 'utf8')} = {}) {
  const load = async file => {
    if (!file) return null;
    try { return voicesOf(JSON.parse(String(await read(file)).replace(/^﻿/, ''))); } catch { return null; }
  };
  return async () => ({pocket: await load(paths?.pocket), short: await load(paths?.omni?.short), long: await load(paths?.omni?.long)});
}
