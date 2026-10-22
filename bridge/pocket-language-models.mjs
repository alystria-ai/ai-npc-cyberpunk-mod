// Pocket language models (docs/POCKET_LANGUAGE_MODELS.md): optional downloads that let the Pocket voice (CPU) speak French, Italian, German, Spanish and
// Portuguese, cloned from the game's own dub of a character in that language (the voice language pack of the same language, bridge/voice-language-packs.mjs).
//
// A model is a folder <references>/multilingual-pocket/<lang>/ (a sibling of <references>/multilingual/<lang>/, the voice pack) with pocket-model.json,
// model.safetensors, tokenizer.json, inference.yaml and NOTICE.txt. This module finds the models and checks each one all-or-none, like the packs:
//
//   scan()      reads every pocket-model.json and stats the files it names (sizes must match; the SHA-256 of the big file is checked by the worker when it
//               loads the model, so a start does not read 220 MB per model). A model that is not valid is ignored as a whole, with one log line.
//   refresh()   the live re-scan (every 30 s from the settings poll): one directory listing and one stat per manifest, the full check only when one changed.
//   speaks(tag) Pocket may speak this reply language: a valid model AND a valid voice language pack of the same language, in the folder the Pocket worker reads.
//   packMissing(tag)  the model is valid but its voice pack is not: the reply is shown as text and the player is told once per language (PocketLanguageNotice).
//   report()    what the support report lists (no paths).
//
// Pure of the bridge: file access goes through `files` so tests can use a folder of small files.
import {readFile, readdir, stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {LANGUAGE_PACKS} from './voice-language-packs.mjs';

export const POCKET_MODEL_FOLDER = 'multilingual-pocket';
export const POCKET_MODEL_MANIFEST = 'pocket-model.json';
/** The pinned Pocket source every model was checked against (bridge/pocket-voice.mjs POCKET_SOURCE_*): the 3.3.0 source runs the v4 language models unchanged. */
export const POCKET_MODEL_SOURCE = '3.3.0';
export const POCKET_MODEL_FILES = Object.freeze(['model.safetensors', 'tokenizer.json', 'inference.yaml', 'NOTICE.txt']);
export const POCKET_MODEL_LIMITS = Object.freeze({manifestBytes: 64 * 1024, modelBytes: 1024 * 1024 * 1024, smallBytes: 2 * 1024 * 1024});
export const RESCAN_MS = 30_000;
/** Pack folder name -> {tag, name (English), pocket (Kyutai's name)}. The languages the game is voiced in that Kyutai's v4 models speak. */
export const POCKET_LANGUAGES = Object.freeze({
  fr: Object.freeze({tag: 'fr', name: 'French', pocket: 'french'}),
  it: Object.freeze({tag: 'it', name: 'Italian', pocket: 'italian'}),
  de: Object.freeze({tag: 'de', name: 'German', pocket: 'german'}),
  'es-es': Object.freeze({tag: 'es', name: 'Spanish', pocket: 'spanish'}),
  'pt-br': Object.freeze({tag: 'pt', name: 'Portuguese', pocket: 'portuguese'}),
});
export const pocketFolderOfTag = tag => Object.entries(POCKET_LANGUAGES).find(([, value]) => value.tag === tag)?.[0] ?? null;

const SHA256 = /^[a-f0-9]{64}$/;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

// ---- "Night City" ----------------------------------------------------------------------------------------------------------------
// The Italian, Spanish and Portuguese models do not say the English name the English way (0 of 5 renders in each; docs/POCKET_V4_MULTILINGUAL_EVAL_2026-10-22.md).
// A respelling the model reads as the English sounds fixed it (Italian 4/5, Spanish 5/5, Portuguese 4/5 with "Náit Síti"). French and German say it right. Used only
// on the text handed to Pocket; the written reply and every other voice keep "Night City".
export const NIGHT_CITY_RESPELLING = Object.freeze({it: 'Nait Siti', es: 'Nait Siti', pt: 'Náit Síti'});
const NIGHT_CITY = /\bNight[\s-]+City\b/gi;
/** The text Pocket is given for a reply in `tag` (the respelling where one is needed). */
export const pocketSpokenText = (tag, text) => Object.hasOwn(NIGHT_CITY_RESPELLING, tag) && typeof text === 'string'
  ? text.replace(NIGHT_CITY, NIGHT_CITY_RESPELLING[tag]) : text;

// ---- files ---------------------------------------------------------------------------------------------------------------------

export const defaultFiles = {
  readFile: (path, encoding) => readFile(path, encoding),
  stat: path => stat(path),
  readdir: path => readdir(path),
};
const reasonOf = error => String(error?.code === 'ENOENT' ? 'file missing' : error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 100);

// ---- one model -----------------------------------------------------------------------------------------------------------------

/** Reads and checks the model in `directory` (<root>/multilingual-pocket/<language>). Returns {model} or {problem: 'reason'}. */
export async function loadPocketModel({directory, language, files = defaultFiles}) {
  const info = POCKET_LANGUAGES[language];
  if (!info) return {problem: 'not a language a Pocket model exists for'};
  let manifest;
  try {
    const size = (await files.stat(resolve(directory, POCKET_MODEL_MANIFEST))).size;
    if (size > POCKET_MODEL_LIMITS.manifestBytes) return {problem: `${POCKET_MODEL_MANIFEST} is too large`};
    manifest = JSON.parse(String(await files.readFile(resolve(directory, POCKET_MODEL_MANIFEST), 'utf8')).replace(/^﻿/, ''));
  } catch (error) { return {problem: error?.code === 'ENOENT' ? `${POCKET_MODEL_MANIFEST} is missing` : `${POCKET_MODEL_MANIFEST} is unreadable (${reasonOf(error)})`}; }
  if (!plain(manifest) || manifest.version !== 1 || manifest.kind !== 'pocket-language-model') return {problem: `${POCKET_MODEL_MANIFEST} is not a version 1 PocketTTS model`};
  if (manifest.language !== language) return {problem: `${POCKET_MODEL_MANIFEST} says language "${String(manifest.language).slice(0, 20)}", the folder is ${language}`};
  if (manifest.languageTag !== info.tag) return {problem: `${POCKET_MODEL_MANIFEST} says languageTag "${String(manifest.languageTag).slice(0, 20)}", expected ${info.tag}`};
  if (manifest.pocketSource !== POCKET_MODEL_SOURCE) return {problem: `made for Pocket source ${String(manifest.pocketSource).slice(0, 20)}, this mod runs ${POCKET_MODEL_SOURCE}`};
  if (manifest.layers !== 6) return {problem: `${String(manifest.layers).slice(0, 10)} layers, the runtime runs the six-layer models`};
  if (!plain(manifest.files)) return {problem: `${POCKET_MODEL_MANIFEST} lists no files`};
  const listed = {};
  for (const name of POCKET_MODEL_FILES) {
    const row = manifest.files[name];
    const limit = name === 'model.safetensors' ? POCKET_MODEL_LIMITS.modelBytes : POCKET_MODEL_LIMITS.smallBytes;
    if (!plain(row) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > limit || !SHA256.test(row.sha256 ?? '')) return {problem: `${POCKET_MODEL_MANIFEST} does not describe ${name}`};
    listed[name] = {bytes: row.bytes, sha256: row.sha256};
  }
  const failures = [];
  for (const name of POCKET_MODEL_FILES) {
    try {
      const file = await files.stat(resolve(directory, name));
      if (!file.isFile()) failures.push(`${name}: not a file`);
      else if (file.size !== listed[name].bytes) failures.push(`${name}: ${file.size} bytes, expected ${listed[name].bytes}`);
    } catch (error) { failures.push(`${name}: ${reasonOf(error)}`); }
  }
  if (failures.length) return {problem: `${failures.length} of ${POCKET_MODEL_FILES.length} files unusable (${failures.slice(0, 3).join('; ')})`};
  return {model: Object.freeze({language, tag: info.tag, name: info.name, directory, version: typeof manifest.built === 'string' ? manifest.built.slice(0, 20) : null,
    files: Object.freeze(listed), bytes: listed['model.safetensors'].bytes,
    // What the worker checks the files against before it loads the model.
    expected: Object.freeze({sha256: listed['model.safetensors'].sha256, tokenizerSha256: listed['tokenizer.json'].sha256, configSha256: listed['inference.yaml'].sha256})})};
}

// ---- the set of models ---------------------------------------------------------------------------------------------------------

export class PocketLanguageModels {
  /**
   *   roots   the folders the Pocket worker reads references from (`runtime.referenceDirectory` of its configuration): a model is looked for in <root>/multilingual-pocket/<lang>
   *   packs   the VoiceLanguagePacks (a model is used only with the pack of its language, and only when that pack is in the same root)
   *   files   file access (tests); log: one line per notice; onChange: the set of models changed (a live re-scan found something new)
   */
  constructor({roots = [], packs = null, files = defaultFiles, log = () => {}, onChange = () => {}, now = Date.now, rescanMs = RESCAN_MS} = {}) {
    Object.assign(this, {roots: roots.filter(Boolean).map(root => resolve(root)), packs, files, log, onChange, now, rescanMs});
    this.models = new Map();      // reply language code -> model
    this.problems = new Map();    // pack folder name -> reason
    this.failed = new Map();      // tag -> reason: the worker refused a model that looked valid (kept until the model's files change)
    this.noticed = new Set();
    this.signature = null; this.scannedAt = 0; this.checking = null; this.hadScan = false;
  }
  get installed() { return this.models.size > 0; }
  has(tag) { return this.models.has(tag) && !this.failed.has(tag); }
  /** The model for a reply language, or null. */
  model(tag) { return this.has(tag) ? this.models.get(tag) : null; }
  languages() { return [...this.models.keys()].filter(tag => !this.failed.has(tag)); }
  // The voice pack of this language, when it is valid and sits where the worker can read its clips (<root>/multilingual/<lang>).
  packOf(tag) {
    const pack = this.packs?.pack?.(tag);
    if (!pack) return null;
    const model = this.models.get(tag);
    if (!model) return pack;
    const wanted = resolve(model.directory, '..', '..', 'multilingual', model.language);
    const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    return same(resolve(pack.directory), wanted) ? pack : null;
  }
  /** May Pocket speak a reply in this language: a valid model and a valid voice pack of the language. In-memory. */
  speaks(tag) { return this.has(tag) && this.packOf(tag) !== null; }
  /** The model is there and valid, the voice pack it clones from is not. */
  packMissing(tag) { return this.has(tag) && this.packOf(tag) === null; }
  /** The voice pack's entry for a voice, or null (that voice has no clip in the pack: the reply is shown as text). */
  entry(tag, voiceKey) { return this.speaks(tag) ? this.packOf(tag).entries.get(voiceKey) ?? null : null; }
  /** The worker refused this model (its hash differs, it did not load): not used again until its files change. */
  markFailed(tag, reason) {
    if (!this.models.has(tag) || this.failed.has(tag)) return;
    this.failed.set(tag, String(reason ?? 'refused by the worker').replace(/[\r\n]+/g, ' ').slice(0, 100));
    try { this.log(`PocketTTS model ${this.models.get(tag).language} is not used: ${this.failed.get(tag)}`); } catch {}
  }

  async look() {
    const seen = [];
    for (const root of this.roots) {
      let names;
      try { names = await this.files.readdir(resolve(root, POCKET_MODEL_FOLDER)); } catch { continue; }
      for (const name of names.filter(item => Object.hasOwn(POCKET_LANGUAGES, item)).sort()) {
        let stamp = 'none';
        try { const info = await this.files.stat(resolve(root, POCKET_MODEL_FOLDER, name, POCKET_MODEL_MANIFEST)); stamp = `${info.size}:${Math.round(info.mtimeMs)}`; } catch {}
        seen.push({root, language: name, stamp});
      }
    }
    return seen;
  }

  /** Finds and checks every model. Returns report(). Safe to call again (a live re-scan builds the new set and swaps it in whole). */
  async scan() {
    const seen = await this.look();
    const models = new Map(), problems = new Map(), taken = new Set();
    for (const {root, language} of seen) {
      if (taken.has(language)) continue;
      taken.add(language);
      let result;
      try { result = await loadPocketModel({directory: resolve(root, POCKET_MODEL_FOLDER, language), language, files: this.files}); }
      catch (error) { result = {problem: `could not be checked (${reasonOf(error)})`}; }
      if (result.model) models.set(result.model.tag, result.model);
      else {
        problems.set(language, result.problem);
        const notice = `${language}|${result.problem}`;
        if (!this.noticed.has(notice)) { this.noticed.add(notice); try { this.log(`PocketTTS model ${language} is not used: ${result.problem}`); } catch {} }
      }
    }
    const before = this.describe();
    // A model the worker refused is tried again only when its files are not the ones it refused.
    for (const tag of [...this.failed.keys()]) {
      const old = this.models.get(tag), now = models.get(tag);
      if (!now || !old || now.expected.sha256 !== old.expected.sha256 || now.version !== old.version) this.failed.delete(tag);
    }
    this.models = models; this.problems = problems; this.signature = JSON.stringify(seen.map(({language, stamp}) => [language, stamp]));
    this.scannedAt = this.now();
    if (before !== this.describe()) {
      for (const model of models.values()) try { this.log(`PocketTTS model ${model.language} ready (${Math.round(model.bytes / 1e6)} MB)`); } catch {}
      if (this.hadScan) try { this.onChange(this.report()); } catch {}
    }
    this.hadScan = true;
    return this.report();
  }
  describe() { return JSON.stringify([[...this.models.values()].map(model => [model.language, model.bytes, model.version]), [...this.problems]]); }

  /** The live re-scan: at most every `rescanMs`, a listing and a stat per manifest, the full check only on a change. Never awaited by a reply. */
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

  /** The support report's view: no paths. `usable` is what the reply path decides on; `packInstalled` says why not. */
  report() {
    return {scannedAt: this.scannedAt ? new Date(this.scannedAt).toISOString() : null,
      models: [...this.models.values()].map(model => ({language: model.language, tag: model.tag, version: model.version, megabytes: Math.round(model.bytes / 1e5) / 10,
        packInstalled: this.packOf(model.tag) !== null, usable: this.speaks(model.tag), ...(this.failed.has(model.tag) ? {refused: this.failed.get(model.tag)} : {})})),
      problems: [...this.problems].map(([language, reason]) => ({language, reason}))};
  }
}

// ---- the notice ----------------------------------------------------------------------------------------------------------------

/**
 * The one-time note, per language and game session, for a reply shown as text because the Pocket model of its language is installed but the voice pack it clones
 * from is not: `note(tag)` when such a reply is shown as text, `take()` when the next reply is written (it returns {keyNotice, keyNoticeLanguage} once per language,
 * then nothing). The game shows it in the menu language (mod/init.lua 'pocket-language-pack').
 */
export class PocketLanguageNotice {
  constructor() { this.pending = []; this.sent = new Set(); }
  note(tag) { if (tag && !this.sent.has(tag) && !this.pending.includes(tag)) this.pending.push(tag); }
  take() {
    const tag = this.pending.shift();
    if (!tag) return undefined;
    this.sent.add(tag);
    return {keyNotice: 'pocket-language-pack', keyNoticeLanguage: tag};
  }
}
