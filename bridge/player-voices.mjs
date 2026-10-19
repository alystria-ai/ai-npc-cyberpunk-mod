// The voice clips players give characters in the editor (docs/CHARACTER_EDITOR.md, "Voice clips"): one clip per character, for a story
// character (it then speaks with the player's clip instead of the shipped one) or for a character the player made (bridge/custom-characters.mjs).
//
// Where it lives (player data: never shipped, never touched by an update of the mod, never in the game folder):
//   <state>/player-voices/<key>.wav   the clip, in the canonical form of bridge/custom-voice-clip.mjs (mono 16-bit PCM WAV)
//   <state>/player-voices.json        the index: per key the clip's SHA-256, length, rate and the words said in it
// The folder holds clips and nothing else, because the voice workers read it as a second reference root (`runtime/player-voices/<key>.wav`
// in the voice configurations, bridge/addons.mjs voiceConfigPaths): Pocket and OmniVoice from the configuration, Voxtral from `playerRoot`.
// The index is kept beside it, not in it.
//
// How a clip reaches the voices: at the next service start the bridge hands `extras()` to the voice merge, which writes each clip into the
// merged configurations over the shipped voice of that key (and out of the startup preparation): nothing is prepared or loaded before that
// character speaks. Removing a clip removes it from the index and the folder, so the next start merges nothing and the shipped voice is back.
//
// Privacy: the clip and its words stay on this computer. Nothing here logs the words, and support reports read only `readPlayerVoiceSummary` (bridge/player-voice-summary.mjs)
// (how many clips, and each one's length). Writes are atomic and one at a time; a damaged index is kept as .corrupt before the first write
// over it (the same care as bridge/custom-characters.mjs).
import {readFile, readdir, rename, rm, mkdir, lstat} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {atomicFile} from './guarded-file.mjs';
import {CLIP, checkTranscript, cleanTranscript, prepareUpload} from './custom-voice-clip.mjs';

export const PLAYER_VOICES_FOLDER = 'player-voices';
export const PLAYER_VOICES_FILE = 'player-voices.json';
export const PLAYER_REFERENCE_PREFIX = 'runtime/player-voices/';
export const PLAYER_VOICE_LIMITS = Object.freeze({clips: 160});
// Every profile key in the bridge and both voice workers is checked against this before it names a file.
const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const FORBIDDEN = new Set(['constructor', 'prototype', '__proto__']);
export const isVoiceKey = key => typeof key === 'string' && KEY.test(key) && !FORBIDDEN.has(key);
const CLIP_FILE = /^([a-z0-9][a-z0-9-]{0,79})\.wav$/;
const SHA = /^[a-f0-9]{64}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, extra = {}) => Object.assign(Error(code), {code, ...extra});

/** A stored entry read from disk: wrong types dropped, the words tidied and cut. Null when nothing usable is left. */
export function readEntry(raw) {
  if (!plain(raw) || !SHA.test(raw.sha256 ?? '') || !Number.isFinite(raw.seconds) || raw.seconds <= 0 || raw.seconds > CLIP.maxSeconds + 0.5
      || !Number.isInteger(raw.rate) || raw.rate < CLIP.minRate || raw.rate > CLIP.maxRate) return null;
  const transcript = Array.from(cleanTranscript(raw.transcript)).slice(0, CLIP.transcript).join('');
  if (!checkTranscript(transcript).ok) return null;
  return Object.freeze({sha256: raw.sha256, seconds: Math.round(raw.seconds * 10) / 10, rate: raw.rate, transcript,
    format: ['wav', 'mp3', 'ogg', 'flac'].includes(raw.format) ? raw.format : 'wav', updated: Number.isFinite(raw.updated) ? raw.updated : 0});
}

// What a support report may say about the clips: bridge/player-voice-summary.mjs (kept apart so it imports no clip code).
export {readPlayerVoiceSummary} from './player-voice-summary.mjs';

// Voxtral's prepared slots of player clips (bridge/voxtral-reference.mjs createReferencePreparer: <key>.json beside <key>.ogg, .mp3 or .wav,
// and the same names plus .tmp while written) are kept in the data folder too, in their own folder (the bridge names it). A removed clip's
// slot goes with it, and a slot no clip owns is swept at start. Only files with exactly those names, directly in that folder, are touched.
export const PLAYER_PREPARED_FOLDER = 'player-voices-prepared';
const PREPARED_SLOT = /^([a-z0-9][a-z0-9-]{0,79})\.(?:json|ogg|mp3|wav)(?:\.tmp)?$/;
/** Removes the prepared slots of `key`, or (without a key) of every key `keep` does not hold. Resolves to the number of files removed. */
export async function releasePreparedSlots({folder, key = null, keep = new Set(), files = {readdir, rm}} = {}) {
  if (!folder) return 0;
  let entries, removed = 0;
  try { entries = await files.readdir(folder, {withFileTypes: true}); } catch { return 0; }
  for (const entry of entries) {
    const match = PREPARED_SLOT.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink?.()) continue;
    if (key !== null ? match[1] !== key : keep.has(match[1])) continue;
    try { await files.rm(join(folder, entry.name), {force: true}); removed++; } catch { /* in use: tried again at the next start */ }
  }
  return removed;
}

const defaultIo = {
  read: file => readFile(file, 'utf8'),
  readBytes: file => readFile(file),
  write: async (file, data) => { await mkdir(dirname(file), {recursive: true}); return atomicFile(file, data); },
  list: dir => readdir(dir, {withFileTypes: true}),
  stat: file => lstat(file),
  move: (from, to) => rename(from, to),
  remove: file => rm(file, {force: true}),
};

export class PlayerVoices {
  /** Reads the index (a missing one is no clips) and removes clip files the index does not name (a save that stopped half way). */
  static async open(options = {}) {
    const store = new PlayerVoices(options);
    await store.#load();
    await store.#sweep();
    return store;
  }
  /**
   *   dir      the state folder (player-voices/ and player-voices.json live in it); without it nothing is written (tests)
   *   prepare  (bytes) => Promise<prepareUpload result>: checks and converts a clip (bridge/custom-voice-clip.mjs)
   *   log      (message) => void: never given the words said in a clip
   *   onRemoved (key) => void: a clip was removed (the bridge removes what was prepared from it, releasePreparedSlots)
   */
  constructor({dir = null, prepare = bytes => prepareUpload(bytes), now = Date.now, log = () => {}, onRemoved = () => {}, limits = PLAYER_VOICE_LIMITS,
    read = defaultIo.read, readBytes = defaultIo.readBytes, write = defaultIo.write, listDir = defaultIo.list, stat = defaultIo.stat,
    move = defaultIo.move, remove = defaultIo.remove} = {}) {
    Object.assign(this, {dir, prepare, now, log, onRemoved, limits, read, readBytes, write, listDir, stat, move, remove});
    this.entries = new Map();
    this.damaged = false;
    this.chain = Promise.resolve();
  }
  /** The folder the voice workers read player clips from. */
  get folder() { return this.dir ? join(this.dir, PLAYER_VOICES_FOLDER) : null; }
  get #index() { return join(this.dir, PLAYER_VOICES_FILE); }
  path(key) { return isVoiceKey(key) && this.dir ? join(this.folder, key + '.wav') : null; }

  async #load() {
    if (!this.dir) return;
    let raw;
    try { raw = await this.read(this.#index); } catch { return; }
    if (typeof raw !== 'string' || !raw.trim()) return;
    let value = null;
    try { value = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); } catch { /* damaged */ }
    if (!plain(value) || value.version !== 1 || !plain(value.voices)) {
      this.damaged = true;
      this.log(`the voice clip list could not be read; it is kept as ${PLAYER_VOICES_FILE}.corrupt if you save a clip`);
      return;
    }
    let dropped = 0;
    for (const [key, item] of Object.entries(value.voices)) {
      const entry = isVoiceKey(key) ? readEntry(item) : null;
      if (entry && this.entries.size < this.limits.clips) this.entries.set(key, entry); else dropped++;
    }
    if (dropped) { this.damaged = true; this.log(`${dropped} voice clip entr${dropped === 1 ? 'y' : 'ies'} could not be used; the list is kept as ${PLAYER_VOICES_FILE}.corrupt if you save a clip`); }
  }
  // A clip file no entry names: left by a save that stopped between the clip and the index, or by a clear whose delete failed. Only a regular
  // file with exactly a clip's name, directly in the folder, is removed.
  async #sweep() {
    if (!this.dir) return;
    let names;
    try { names = await this.listDir(this.folder); } catch { return; }
    for (const entry of names) {
      const match = CLIP_FILE.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink?.() || this.entries.has(match[1])) continue;
      try { await this.remove(join(this.folder, entry.name)); } catch { /* tried again at the next start */ }
    }
  }
  async #keepAside() {
    if (!this.damaged) return;
    try { await this.remove(this.#index + '.corrupt'); await this.move(this.#index, this.#index + '.corrupt'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    this.damaged = false;
  }
  async #saveIndex(entries) {
    await this.#keepAside();
    const voices = Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
    if (!await this.write(this.#index, JSON.stringify({version: 1, updated: this.now(), voices}, null, 1))) throw fail('not-saved');
  }
  // One write at a time; the in-memory list changes only when the index on disk did.
  #commit(change) {
    const job = this.chain.catch(() => {}).then(async () => {
      const next = new Map(this.entries);
      const result = await change(next);
      this.entries = next;
      return result;
    });
    this.chain = job;
    return job;
  }

  // ---- reading (map lookups)
  has(key) { return this.entries.has(key); }
  /** The entry of a key: {sha256, seconds, rate, transcript, format, updated}, or null. */
  get(key) { return this.entries.get(key) ?? null; }
  get size() { return this.entries.size; }
  /** Every clip without its words: [{key, seconds, rate, updated}]. */
  list() { return [...this.entries].sort(([a], [b]) => a.localeCompare(b)).map(([key, {seconds, rate, updated}]) => ({key, seconds, rate, updated})); }

  /** The clip's bytes for the editor's preview, checked against the index; null when there is none or the file changed. */
  async audio(key) {
    const entry = this.entries.get(key), path = this.path(key);
    if (!entry || !path) return null;
    try { const bytes = await this.readBytes(path); return sha256(bytes) === entry.sha256 ? bytes : null; } catch { return null; }
  }

  /**
   * The clips to merge into the voice configurations at start (AddonHost.voiceConfigPaths `extra`, with `player: true`): each one whose file
   * is intact and whose key `wanted(key)` still accepts (a story character, or a character the player has not deleted).
   */
  async extras(wanted = () => true) {
    const out = [];
    for (const [key, entry] of [...this.entries].sort(([a], [b]) => a.localeCompare(b))) {
      let use = false;
      try { use = wanted(key) === true; } catch { use = false; }
      if (!use) continue;
      const path = this.path(key);
      try {
        const bytes = await this.readBytes(path);
        if (sha256(bytes) !== entry.sha256) throw Error('the clip does not match what was saved');
        out.push({key, reference: path, sha256: entry.sha256, transcript: entry.transcript, player: true});
      } catch (error) { this.log(`the voice clip of ${key} is not used: ${error?.code ?? error?.message ?? 'error'}`); }
    }
    return out;
  }

  // ---- writing
  /**
   * Gives `key` a clip: checked and converted (`prepare`), written, then recorded with the words said in it (`transcript`, or the words already
   * kept for that key when it is null). Resolves to {entry, clip: {seconds, rate, notes, format}}; rejects with {code} ('clip-*', 'voice-text-*',
   * 'clips-full', 'bad-key', 'not-saved'). A failed save leaves the previous clip as it was.
   */
  async set(key, bytes, transcript = null) {
    if (!isVoiceKey(key)) throw fail('bad-key');
    const words = checkTranscript(transcript === null ? this.entries.get(key)?.transcript ?? '' : transcript);
    if (!words.ok) throw fail(words.code, words.min !== undefined ? {min: words.min} : {max: words.max});
    if (!this.entries.has(key) && this.entries.size >= this.limits.clips) throw fail('clips-full', {max: this.limits.clips});
    const clip = await this.prepare(bytes);
    if (!clip?.ok) throw fail(clip?.code ?? 'clip-format', clip?.min !== undefined ? {min: clip.min} : clip?.max !== undefined ? {max: clip.max} : {});
    return this.#commit(async entries => {
      if (!entries.has(key) && entries.size >= this.limits.clips) throw fail('clips-full', {max: this.limits.clips});
      const entry = readEntry({sha256: clip.sha256, seconds: clip.seconds, rate: clip.rate, transcript: words.text, format: clip.format ?? 'wav', updated: this.now()});
      if (!entry) throw fail('clip-format');
      if (this.dir) {
        const path = this.path(key);
        let previous = null;
        try { previous = await this.readBytes(path); } catch { previous = null; }
        if (!await this.write(path, clip.wav)) throw fail('not-saved');
        try { await this.#saveIndex(new Map(entries).set(key, entry)); }
        catch (error) {
          // The index still names the previous clip: put its file back (or remove the new one), so the two agree again.
          try { if (previous) await this.write(path, previous); else await this.remove(path); } catch { /* the start-up check skips a mismatch */ }
          throw error?.code ? error : fail('not-saved');
        }
      }
      entries.set(key, entry);
      return {entry, clip: {seconds: clip.seconds, rate: clip.rate, notes: clip.notes ?? [], format: clip.format ?? 'wav'}};
    });
  }
  /** Changes only the words said in a key's clip. Rejects with 'not-found' or a 'voice-text-*' code. */
  setTranscript(key, transcript) {
    if (!this.entries.has(key)) return Promise.reject(fail('not-found'));
    const words = checkTranscript(transcript);
    if (!words.ok) return Promise.reject(fail(words.code, words.min !== undefined ? {min: words.min} : {max: words.max}));
    return this.#commit(async entries => {
      const old = entries.get(key);
      if (!old) throw fail('not-found');
      const entry = readEntry({...old, transcript: words.text, updated: this.now()});
      if (this.dir) await this.#saveIndex(new Map(entries).set(key, entry));
      entries.set(key, entry);
      return entry;
    });
  }
  /** Removes a key's clip (the character speaks with its shipped voice, or its generic one, from the next start). Resolves to true when there was one. */
  clear(key) {
    if (!this.entries.has(key)) return Promise.resolve(false);
    return this.#commit(async entries => {
      if (!entries.has(key)) return false;
      const next = new Map(entries); next.delete(key);
      if (this.dir) {
        await this.#saveIndex(next);
        try { await this.remove(this.path(key)); } catch { /* swept at the next start: the index no longer names it */ }
      }
      entries.delete(key);
      return true;
    }).then(had => {
      if (had) { try { const done = this.onRemoved(key); if (done && typeof done.catch === 'function') done.catch(() => {}); } catch { /* swept at the next start */ } }
      return had;
    });
  }
  /** Removes the clips of keys `keep(key)` no longer accepts (a character the player deleted while the service was not running). */
  async prune(keep) {
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      let stays = true;
      try { stays = keep(key) === true; } catch { stays = true; }
      if (!stays && await this.clear(key).catch(() => false)) removed++;
    }
    return removed;
  }
}
