// Voice language packs (docs/VOICE_LANGUAGE_PACKS.md): optional packs that give OmniVoice and the Mistral voice (Voxtral) the game's own dub of a
// character in the language of the reply, as the reference to clone, instead of the English actor's clips.
//
// A pack is a folder <references>/multilingual/<lang>/ with a manifest.json and the clips it names (picked/, archetypes/, v-voice/, and the Voxtral
// slots in prepared/). This module finds the packs, checks each one all-or-none, and answers "which reference for this voice in this language"
// from an in-memory map built at start, so nothing on a reply's path reads a folder:
//
//   scan()        reads every manifest and the header of every clip it names (never the audio), once at start. A pack is used only when its
//                 manifest is valid and EVERY file it names exists and is a 24 kHz mono 16-bit WAV of at most 20 s with a text; a pack that is
//                 not is ignored as a whole, with one log line, and its reason is kept for the support report. Never half-used.
//   refresh()     the live re-scan (the OmniVoice pack is looked for again every 30 s the same way): one directory listing and one stat per
//                 manifest, and the full check only when one of them changed. Called from the settings poll, never from a reply.
//   entry(tag, voiceKey)          the pack's entry for a voice in a reply language ('zh', 'ja', ...), or null: the voice keeps its English reference.
//   omniDescriptor(tag, voiceKey)  the same as the descriptor the OmniVoice worker verifies (path in the voice-reference namespace, SHA-256, text).
//   report()      what the support report lists: language, voice count, version, problems (no paths, no text).
//
// Pocket never asks: it speaks English only. A player's own clip for a character is never replaced by a pack's (the callers check it).
// Pure of the bridge: file access goes through `files` so tests can use a folder of generated sine waves.
import {createHash} from 'node:crypto';
import {open, readdir, readFile, stat} from 'node:fs/promises';
import {resolve} from 'node:path';

export const LANGUAGE_PACK_FOLDER = 'multilingual';
/** The game's voiced languages (Steam "Full Audio"): pack folder name -> the code the reply-language detector reports (bridge/reply-language.mjs). */
export const LANGUAGE_PACKS = Object.freeze({fr: 'fr', it: 'it', de: 'de', 'es-es': 'es', ja: 'ja', ko: 'ko', pl: 'pl', 'pt-br': 'pt', ru: 'ru', 'zh-cn': 'zh'});
/** Every clip of a pack: 24 kHz mono 16-bit WAV, at most OmniVoice's 20 s reference limit. */
export const PACK_AUDIO = Object.freeze({sampleRate: 24000, channels: 1, bits: 16, maxSeconds: 20});
/** The namespace the voice workers know references by: <references>/ is 'runtime/voice-references/'. */
export const REFERENCE_NAMESPACE = 'runtime/voice-references/';
export const PACK_NAMESPACE = `${REFERENCE_NAMESPACE}${LANGUAGE_PACK_FOLDER}/`;
export const PREPARED_FOLDER = 'prepared';
export const RESCAN_MS = 30_000;
export const PACK_LIMITS = Object.freeze({manifestBytes: 8 * 1024 * 1024, voices: 2048, textChars: 12_000, header: 2048, concurrency: 24});

const VOICE_KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const FILE = /^(picked|archetypes|v-voice)\/([a-z0-9][a-z0-9._-]{0,79})\.wav$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FORBIDDEN_KEYS = new Set(['constructor', 'prototype', '__proto__']);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** The pack that speaks a reply language code ('zh'), as its folder name ('zh-cn'), or null. */
export const packOfTag = tag => Object.entries(LANGUAGE_PACKS).find(([, code]) => code === tag)?.[0] ?? null;

// ---- one clip's header --------------------------------------------------------------------------------------------------------

/**
 * Checks the header of a WAV (its first bytes) against the pack format. `size` is the file's size. Returns {seconds} or throws Error with a short reason.
 * The audio itself is never read.
 */
export function checkWavHeader(head, size) {
  if (head.length < 44 || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') throw Error('not a WAV file');
  let at = 12, format = null;
  while (at + 8 <= head.length) {
    const id = head.toString('latin1', at, at + 4), length = head.readUInt32LE(at + 4), body = at + 8;
    if (id === 'fmt ') {
      if (length < 16 || body + 16 > head.length) throw Error('bad fmt chunk');
      format = {tag: head.readUInt16LE(body), channels: head.readUInt16LE(body + 2), rate: head.readUInt32LE(body + 4), bits: head.readUInt16LE(body + 14)};
    } else if (id === 'data') {
      if (!format) throw Error('data before fmt');
      if (format.tag !== 1) throw Error('not PCM');
      if (format.channels !== PACK_AUDIO.channels) throw Error(`${format.channels} channels, not mono`);
      if (format.rate !== PACK_AUDIO.sampleRate) throw Error(`${format.rate} Hz, not ${PACK_AUDIO.sampleRate}`);
      if (format.bits !== PACK_AUDIO.bits) throw Error(`${format.bits}-bit, not ${PACK_AUDIO.bits}`);
      // A streamed or truncated header can declare more than the file holds: what is there counts.
      const bytes = Math.min(length === 0 || length === 0xFFFFFFFF ? size : length, Math.max(0, size - body));
      const seconds = bytes / (format.rate * (format.bits / 8) * format.channels);
      if (!(seconds > 0)) throw Error('no audio');
      if (seconds > PACK_AUDIO.maxSeconds) throw Error(`${seconds.toFixed(1)} s, over the ${PACK_AUDIO.maxSeconds} s limit`);
      return {seconds: Math.round(seconds * 100) / 100};
    }
    at = body + length + (length & 1);
  }
  throw Error('no data chunk in the header');
}

/** File access as the real disk does it (tests wrap it to count reads). */
export const defaultFiles = {
  readFile: (path, encoding) => readFile(path, encoding),
  stat: path => stat(path),
  readdir: path => readdir(path),
  // The first `length` bytes of a file.
  async head(path, length) {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const {bytesRead} = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } finally { await handle.close().catch(() => {}); }
  },
};

const reasonOf = error => String(error?.code === 'ENOENT' ? 'file missing' : error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 100);

// ---- one pack -----------------------------------------------------------------------------------------------------------------

/**
 * Reads and checks the pack in `directory` (<root>/multilingual/<language>). Returns {pack} or {problem: 'reason'}. The manifest is checked first, then
 * the header of every file it names; the first few failures are named in the reason, with how many there were.
 */
export async function loadPack({directory, language, files = defaultFiles}) {
  const tag = LANGUAGE_PACKS[language];
  if (!tag) return {problem: 'not a language the game is voiced in'};
  let manifest;
  try {
    const info = await files.stat(resolve(directory, 'manifest.json'));
    if (info.size > PACK_LIMITS.manifestBytes) return {problem: 'manifest.json is too large'};
    manifest = JSON.parse(String(await files.readFile(resolve(directory, 'manifest.json'), 'utf8')).replace(/^﻿/, ''));
  } catch (error) { return {problem: error?.code === 'ENOENT' ? 'manifest.json is missing' : `manifest.json is unreadable (${reasonOf(error)})`}; }
  if (!plain(manifest) || manifest.version !== 1) return {problem: 'manifest.json is not version 1'};
  if (manifest.language !== language) return {problem: `manifest.json says language "${String(manifest.language).slice(0, 20)}", the folder is ${language}`};
  if (manifest.languageTag !== tag) return {problem: `manifest.json says languageTag "${String(manifest.languageTag).slice(0, 20)}", expected ${tag}`};
  if (!plain(manifest.voices)) return {problem: 'manifest.json has no voices'};
  const keys = Object.keys(manifest.voices);
  if (!keys.length || keys.length > PACK_LIMITS.voices) return {problem: `manifest.json lists ${keys.length} voices`};

  const entries = new Map(), failures = [];
  const fail = (key, why) => failures.push(`${String(key).slice(0, 40)}: ${why}`);
  const checked = [];
  for (const key of keys) {
    const row = manifest.voices[key];
    if (!VOICE_KEY.test(key) || FORBIDDEN_KEYS.has(key)) { fail(key, 'not a voice key'); continue; }
    if (!plain(row)) { fail(key, 'not an entry'); continue; }
    const match = typeof row.file === 'string' ? FILE.exec(row.file) : null;
    if (!match) { fail(key, 'invalid file name'); continue; }
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    if (!text) { fail(key, 'no text'); continue; }
    if (text.length > PACK_LIMITS.textChars || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) { fail(key, 'invalid text'); continue; }
    if (row.sha256 !== undefined && !(typeof row.sha256 === 'string' && SHA256.test(row.sha256))) { fail(key, 'invalid sha256'); continue; }
    checked.push({key, row, text, file: row.file, kind: match[1]});
  }
  // The headers, a few at a time (a pack lists a few hundred clips).
  for (let at = 0; at < checked.length; at += PACK_LIMITS.concurrency) {
    await Promise.all(checked.slice(at, at + PACK_LIMITS.concurrency).map(async ({key, row, text, file, kind}) => {
      const path = resolve(directory, ...file.split('/'));
      try {
        const info = await files.stat(path);
        if (!info.isFile()) throw Error('not a file');
        const {seconds} = checkWavHeader(await files.head(path, PACK_LIMITS.header), info.size);
        entries.set(key, Object.freeze({key, language, tag, file, kind, path, set: `${LANGUAGE_PACK_FOLDER}/${language}/${file.slice(0, -4)}`,
          text, seconds, sha256: row.sha256 ?? null, size: info.size, mtimeMs: info.mtimeMs, preparedDirectory: resolve(directory, PREPARED_FOLDER)}));
      } catch (error) { fail(key, reasonOf(error)); }
    }));
  }
  if (failures.length) {
    failures.sort();
    return {problem: `${failures.length} of ${keys.length} voices unusable (${failures.slice(0, 3).join('; ')}${failures.length > 3 ? '; ...' : ''})`};
  }
  return {pack: Object.freeze({language, tag, directory, version: typeof manifest.built === 'string' ? manifest.built.slice(0, 20) : null,
    gameLanguage: typeof manifest.gameLanguage === 'string' ? manifest.gameLanguage.slice(0, 20) : null, entries,
    preparedDirectory: resolve(directory, PREPARED_FOLDER)})};
}

// ---- the set of packs ---------------------------------------------------------------------------------------------------------

export class VoiceLanguagePacks {
  /**
   *   roots     the voice reference folders (<references>), in order; a pack is looked for in <root>/multilingual/<lang>, the first root that has the language wins
   *   files     file access (tests); log: one line per notice; onChange: the set of packs changed (a live re-scan found something new)
   */
  constructor({roots = [], files = defaultFiles, log = () => {}, onChange = () => {}, now = Date.now, rescanMs = RESCAN_MS} = {}) {
    Object.assign(this, {roots: roots.filter(Boolean).map(root => resolve(root)), files, log, onChange, now, rescanMs});
    this.packs = new Map();        // reply language code -> pack
    this.problems = new Map();     // pack folder name -> reason
    this.noticed = new Set();      // `${language}|${reason}`: a notice is written once
    this.signature = null; this.scannedAt = 0; this.checking = null;
    this.hashes = new Map();       // path -> {size, mtimeMs, sha256}
  }
  /** Is any pack installed? */
  get installed() { return this.packs.size > 0; }
  has(tag) { return this.packs.has(tag); }
  /** The reply language codes with a pack ('zh', 'ja', ...). */
  languages() { return [...this.packs.keys()]; }
  pack(tag) { return this.packs.get(tag) ?? null; }
  /** The pack's entry for a voice in a reply language, or null. An in-memory lookup. */
  entry(tag, voiceKey) {
    if (!tag || tag === 'en') return null;
    return this.packs.get(tag)?.entries.get(voiceKey) ?? null;
  }
  /** The SHA-256 of an entry's clip: the manifest's, else computed once (the clip is read once per process, and again only when the file changes). */
  async sha256(entry) {
    if (entry.sha256) return entry.sha256;
    const known = this.hashes.get(entry.path);
    if (known && known.size === entry.size && known.mtimeMs === entry.mtimeMs) return known.sha256;
    const sha256 = createHash('sha256').update(await this.files.readFile(entry.path)).digest('hex');
    this.hashes.set(entry.path, {size: entry.size, mtimeMs: entry.mtimeMs, sha256});
    return sha256;
  }
  /** What the OmniVoice worker verifies before it clones from a pack clip: {reference, sha256, transcript}; null when the voice has no entry. */
  async omniDescriptor(tag, voiceKey) {
    const entry = this.entry(tag, voiceKey);
    if (!entry) return null;
    return {reference: `${PACK_NAMESPACE}${entry.language}/${entry.file}`, sha256: await this.sha256(entry), transcript: entry.text};
  }
  /** The set a pack clip is logged as (the voice-routing line's ref): multilingual/<lang>/picked/<voice>. */
  setOf(tag, voiceKey) { return this.entry(tag, voiceKey)?.set ?? null; }

  // The folders and manifests as they are now: what refresh() compares. One listing and one stat per manifest.
  async look() {
    const seen = [];
    for (const root of this.roots) {
      let names;
      try { names = await this.files.readdir(resolve(root, LANGUAGE_PACK_FOLDER)); } catch { continue; }
      for (const name of names.filter(item => Object.hasOwn(LANGUAGE_PACKS, item)).sort()) {
        let stamp = 'none';
        try { const info = await this.files.stat(resolve(root, LANGUAGE_PACK_FOLDER, name, 'manifest.json')); stamp = `${info.size}:${Math.round(info.mtimeMs)}`; } catch {}
        seen.push({root, language: name, stamp});
      }
    }
    return seen;
  }

  /** Finds and checks every pack. Returns report(). Safe to call again (a live re-scan builds the new set and swaps it in whole). */
  async scan() {
    const seen = await this.look();
    const packs = new Map(), problems = new Map(), taken = new Set();
    for (const {root, language} of seen) {
      if (taken.has(language)) continue;   // the first root that has the language wins
      taken.add(language);
      const directory = resolve(root, LANGUAGE_PACK_FOLDER, language);
      let result;
      try { result = await loadPack({directory, language, files: this.files}); }
      catch (error) { result = {problem: `could not be checked (${reasonOf(error)})`}; }
      if (result.pack) packs.set(result.pack.tag, result.pack);
      else {
        problems.set(language, result.problem);
        // One notice per pack and reason, however many times it is looked at.
        const notice = `${language}|${result.problem}`;
        if (!this.noticed.has(notice)) { this.noticed.add(notice); try { this.log(`voice language pack ${language} is not used: ${result.problem}`); } catch {} }
      }
    }
    const before = this.describe();
    this.packs = packs; this.problems = problems; this.signature = JSON.stringify(seen.map(({language, stamp}) => [language, stamp]));
    this.scannedAt = this.now();
    if (before !== this.describe()) {
      for (const [tag, pack] of packs) try { this.log(`voice language pack ${pack.language} ready: ${pack.entries.size} voices`); } catch {}
      if (this.hadScan) try { this.onChange(this.report()); } catch {}
    }
    this.hadScan = true;
    return this.report();
  }
  describe() { return JSON.stringify([[...this.packs.values()].map(pack => [pack.language, pack.entries.size, pack.version]), [...this.problems]]); }

  /**
   * The live re-scan: at most every `rescanMs`, one listing and a stat per manifest, and a full check only when a manifest or a folder changed. Called from the
   * settings poll and never awaited by a reply. Resolves to true when the set of packs changed.
   */
  refresh() {
    if (this.checking) return this.checking;
    if (this.now() - this.scannedAt < this.rescanMs) return Promise.resolve(false);
    this.scannedAt = this.now();
    this.checking = (async () => {
      try {
        const signature = JSON.stringify((await this.look()).map(({language, stamp}) => [language, stamp]));
        if (signature === this.signature) return false;
        const before = this.describe();
        await this.scan();
        return before !== this.describe();
      } catch { return false; } finally { this.checking = null; }
    })();
    return this.checking;
  }

  /** The support report's view: no paths, no text. */
  report() {
    return {scannedAt: this.scannedAt ? new Date(this.scannedAt).toISOString() : null,
      packs: [...this.packs.values()].map(pack => ({language: pack.language, tag: pack.tag, voices: pack.entries.size, version: pack.version})),
      problems: [...this.problems].map(([language, reason]) => ({language, reason}))};
  }
}
