// Dubbed voice reference clips made on demand (docs/VOICE_LANGUAGE_PACKS.md, "Clips on demand"): the multilingual packs without the download.
//
// A language pack (Voices-German, ...) holds, per character, one reference clip joined from the game's own dub in that language. Since 0.4.1 a player no longer needs the pack:
// when a reply is in a language the game is voiced in, the clip of the character that speaks is made once, in the background, and kept:
//
//   1. from the player's own dub, when that language's voice files are installed (`lang_<xx>_voice.archive`, base game and Phantom Liberty): `bridge/voice_clip_build.py
//      build-language` repeats the pack builder's recipe from `characters/voice-language-clips/<lang>.json` (the dub's lines, the resampler, the gain) in a process of its own
//      at below normal priority, and gives the pack's clip sample for sample;
//   2. else (no dub installed, or the build failed, or the clip is one the recipe cannot repeat exactly) downloaded from our Hugging Face files,
//      `voice-clips/<lang>/<picked|archetypes|v-voice>/<key>.wav`, checked against the manifest's SHA-256;
//   3. else nothing: the English reference speaks, exactly as before. A reply never waits for a clip.
//
// Where things are: the clips go to `<references>/multilingual/<lang>/<picked|archetypes|v-voice>/<key>.wav`, the same place an installed pack keeps them, so the voice workers
// (which accept a language reference only there) and the Mistral voice's slots (`<lang>/prepared/`, made by the bridge's own VoxtralVoice on first use) need nothing new. A
// folder that holds clips made here and no `manifest.json` carries a `generated.json` marker and is not an incomplete pack (bridge/voice-language-packs.mjs skips it); an
// installed pack, when there is one, is used first (VoiceLanguagePacks.entry). The index of what is ready is `<state>/voice-language-clips.json`.
//
// Nothing runs per frame and nothing runs in front of a reply: `entry()` is an in-memory lookup that, when the clip is not ready, asks for it once and answers null.
import {existsSync} from 'node:fs';
import {copyFile, mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {atomicFile} from './guarded-file.mjs';
import {GENERATED_MARKER, LANGUAGE_PACKS, LANGUAGE_PACK_FOLDER, PACK_AUDIO, packOfTag} from './voice-language-packs.mjs';
import {BUILD_TIMEOUT_MS, EXIT_NO_ENGLISH_VOICE, SerialQueue, VOICE_CLIPS_FOLDER, VOICE_CLIPS_REPOSITORY, downloadFile, runBuilder} from './voice-clips.mjs';

export const LANGUAGE_CLIPS_INDEX = 'voice-language-clips.json';
export const LANGUAGE_CLIPS_MANIFESTS = 'characters/voice-language-clips';
export const RETRY_MS = 15 * 60_000;
/** The name inside `lang_<name>_voice.archive` of each pack language. */
export const DUB_ARCHIVE_NAMES = Object.freeze({fr: 'fr', it: 'it', de: 'de', 'es-es': 'es-es', ja: 'ja', ko: 'ko', pl: 'pl', 'pt-br': 'pt', ru: 'ru', 'zh-cn': 'zh-cn'});
const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const FILE = /^(picked|archetypes|v-voice)\/([a-z0-9][a-z0-9._-]{0,79})\.wav$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_CLIP_BYTES = Math.ceil(PACK_AUDIO.maxSeconds * PACK_AUDIO.sampleRate * 2) + 4096;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const packFolders = Object.freeze(Object.keys(LANGUAGE_PACKS));

export const languageDownloadUrl = (language, file, repository = VOICE_CLIPS_REPOSITORY) => `https://huggingface.co/${repository}/resolve/main/${VOICE_CLIPS_FOLDER}/${language}/${file}`;
export const dubArchivePath = (gameDirectory, language, part = 'content') => join(gameDirectory, 'archive', 'pc', part, `lang_${DUB_ARCHIVE_NAMES[language]}_voice.archive`);

/**
 * One language's manifest (characters/voice-language-clips/<lang>.json): {language, tag, voices: Map(key -> {kind, file, text, gender, seconds, samples, sha256, exact})}. Entries that are
 * not well formed are left out; null when the file is not a manifest of this language.
 */
export function readLanguageManifest(text, language) {
  let parsed;
  try { parsed = JSON.parse(String(text).replace(/^﻿/, '')); } catch { return null; }
  if (!plain(parsed) || parsed.version !== 1 || parsed.language !== language || parsed.languageTag !== LANGUAGE_PACKS[language] || !plain(parsed.voices)) return null;
  const voices = new Map();
  for (const [key, row] of Object.entries(parsed.voices)) {
    if (!KEY.test(key) || !plain(row)) continue;
    const match = typeof row.file === 'string' ? FILE.exec(row.file) : null, words = typeof row.text === 'string' ? row.text.trim() : '';
    if (!match || !words || words.length > 12_000 || !SHA.test(row.sha256 ?? '') || !Number.isInteger(row.samples) || row.samples <= 0 || !(row.seconds > 0)) continue;
    voices.set(key, Object.freeze({kind: match[1], file: row.file, text: words, gender: typeof row.gender === 'string' ? row.gender : null, seconds: row.seconds, samples: row.samples,
      sha256: row.sha256, exact: row.exact === true && Array.isArray(row.lines) && row.lines.length > 0,
      needsEp1: Array.isArray(row.lines) && row.lines.some(line => Array.isArray(line) && line[0] === 'ep1')}));
  }
  return Object.freeze({language, tag: LANGUAGE_PACKS[language], voices});
}

export class LanguageVoiceClips {
  /**
   *   projectDirectory  the folder `characters/voice-language-clips/<lang>.json` is under
   *   gameDirectory     the game folder (read only): where the dub's voice archives are
   *   referenceRoot     the references folder the clips are written to (<referenceRoot>/multilingual/<lang>/...)
   *   mirrorRoots       the other reference folders a worker reads, each given a copy of every finished clip in the same place
   *   stateDirectory    the service's data folder (the index lives in it)
   *   python, script, vgmstream   the Runtime's Python, bridge/voice_clip_build.py and vgmstream-cli.exe
   *   download          false, or {fetch, repository}: fetch a clip from Hugging Face when the game cannot give it
   *   serial            the queue the English clips use too (one build at a time)
   *   dubPresent        (language, part) => boolean: is the voice archive of the language there, part 'content' (the base game's) or 'ep1' (Phantom Liberty's) (default: a stat, remembered for a few minutes)
   *   onReady           (tag, key) => void: a clip is ready
   */
  constructor({projectDirectory, gameDirectory = null, referenceRoot, mirrorRoots = [], stateDirectory = null, python = null, script = null, vgmstream = null, download = false,
    serial = new SerialQueue(), dubPresent = null, onReady = () => {}, log = () => {}, run = runBuilder, now = Date.now, retryMs = RETRY_MS,
    files = {readFile, writeFile, mkdir, rename, rm, stat, copyFile}, enabled = true} = {}) {
    Object.assign(this, {projectDirectory, gameDirectory, referenceRoot, mirrorRoots: mirrorRoots.filter(root => typeof root === 'string' && root), stateDirectory, python, script,
      vgmstream, download, serial, onReady, log, run, now, retryMs, files, enabled});
    this.dubSeen = new Map();             // language -> {at, present} for the base game's archive
    this.ep1Seen = new Map();             // the same for Phantom Liberty's
    this.dubPresent = dubPresent ?? ((language, part) => this.#dubOnDisk(language, part));
    this.manifests = new Map();           // language -> manifest | null (loaded once; null: none or unusable)
    this.loading = new Map();             // language -> promise
    this.available = new Set();           // languages with a manifest file in the project
    this.index = Object.create(null);     // language -> key -> {sha256, bytes, source}
    this.entries = new Map();             // `${language}|${key}` -> frozen entry
    this.failed = new Map();              // `${language}|${key}` -> {reason, at}
    this.running = new Map();             // `${language}|${key}` -> promise
    this.markers = new Set();             // `${root}|${language}` whose generated.json was written this session
  }

  static async open(options = {}) {
    const clips = new LanguageVoiceClips(options);
    await clips.#load();
    return clips;
  }

  get indexPath() { return this.stateDirectory ? join(this.stateDirectory, LANGUAGE_CLIPS_INDEX) : null; }
  manifestPath(language) { return join(this.projectDirectory, ...LANGUAGE_CLIPS_MANIFESTS.split('/'), `${language}.json`); }
  clipPath(language, file, root = this.referenceRoot) { return join(root, LANGUAGE_PACK_FOLDER, language, ...file.split('/')); }
  // Is the dub's voice archive there: the base game's (`content`) or Phantom Liberty's (`ep1`). A stat, remembered for a few minutes.
  #dubOnDisk(language, part = 'content') {
    const seenMap = part === 'ep1' ? this.ep1Seen : this.dubSeen, seen = seenMap.get(language), at = this.now();
    if (seen && at - seen.at < 5 * 60_000) return seen.present;
    let present = false;
    try { present = !!this.gameDirectory && DUB_ARCHIVE_NAMES[language] !== undefined && existsSync(dubArchivePath(this.gameDirectory, language, part)); } catch { present = false; }
    seenMap.set(language, {at, present});
    return present;
  }

  async #load() {
    // Which languages have a manifest (a stat each, once). Nothing else is read at start but the index.
    for (const language of packFolders) {
      try { if ((await this.files.stat(this.manifestPath(language))).isFile()) this.available.add(language); } catch { /* none for this language */ }
    }
    if (!this.indexPath || !this.available.size) return;
    let parsed = null;
    try { parsed = JSON.parse(String(await this.files.readFile(this.indexPath, 'utf8')).replace(/^﻿/, '')); } catch { parsed = null; }
    if (!plain(parsed) || !plain(parsed.clips)) return;
    for (const [language, rows] of Object.entries(parsed.clips)) {
      if (!this.available.has(language) || !plain(rows)) continue;
      const manifest = await this.#manifest(language);
      if (!manifest) continue;
      for (const [key, row] of Object.entries(rows)) {
        const voice = manifest.voices.get(key);
        if (!voice || !plain(row) || !SHA.test(row.sha256 ?? '') || !Number.isInteger(row.bytes)) continue;
        // An entry counts only while its file is there with the recorded size; the hash was checked when it was written.
        try {
          const info = await this.files.stat(this.clipPath(language, voice.file));
          if (info.size !== row.bytes) continue;
          (this.index[language] ??= Object.create(null))[key] = {sha256: row.sha256, bytes: row.bytes, source: String(row.source ?? 'build')};
        } catch { /* the file is gone: made again when wanted */ }
      }
    }
  }

  async #save() {
    if (!this.indexPath) return;
    await this.files.mkdir(this.stateDirectory, {recursive: true});
    await atomicFile(this.indexPath, JSON.stringify({version: 1, clips: this.index}, null, 1));
  }

  /** The manifest of a language, read once (null: there is none, or it is not usable). */
  #manifest(language) {
    if (this.manifests.has(language)) return Promise.resolve(this.manifests.get(language));
    if (!this.loading.has(language)) {
      this.loading.set(language, (async () => {
        let manifest = null;
        try { manifest = readLanguageManifest(await this.files.readFile(this.manifestPath(language), 'utf8'), language); } catch { manifest = null; }
        this.manifests.set(language, manifest);
        this.loading.delete(language);
        return manifest;
      })());
    }
    return this.loading.get(language);
  }

  /** Is there a way to make a clip: a builder with the game folder, or the download? */
  get canMake() { return !!(this.python && this.script && this.gameDirectory) || !!this.download; }
  /** Does any language have clips here (a manifest in the project, and clips ready or a way to make them)? */
  get active() { return this.enabled && this.available.size > 0 && (this.canMake || Object.values(this.index).some(rows => Object.keys(rows).length > 0)); }
  /** May a reply language (the code the detector reports, 'de') be served from here? */
  supports(tag) { const language = packOfTag(tag); return this.active && !!language && this.available.has(language); }
  ready(language, key) { return !!this.index[language]?.[key]; }

  /**
   * The entry for a voice in a reply language, in the shape of an installed pack's entries (bridge/voice-language-packs.mjs loadPack), or null while the clip is not ready. When it is
   * not, it is asked for (once, in the background) and the English reference speaks this reply. An in-memory lookup.
   */
  entry(tag, key) {
    const language = packOfTag(tag);
    if (!language || !this.supports(tag) || typeof key !== 'string') return null;
    const id = `${language}|${key}`, known = this.entries.get(id);
    if (known) return known;
    const row = this.index[language]?.[key], voice = this.manifests.get(language)?.voices.get(key);
    if (row && voice) {
      const path = this.clipPath(language, voice.file);
      const entry = Object.freeze({key, language, tag, file: voice.file, kind: voice.kind, path, set: `${LANGUAGE_PACK_FOLDER}/${language}/${voice.file.slice(0, -4)}`, text: voice.text,
        seconds: voice.seconds, sha256: row.sha256, size: row.bytes, mtimeMs: 0, preparedDirectory: resolve(this.referenceRoot, LANGUAGE_PACK_FOLDER, language, 'prepared'), generated: true});
      this.entries.set(id, entry);
      return entry;
    }
    this.want(tag, key);
    return null;
  }

  /** A voice is wanted in a language (a reply, an invitation, a talk): once, in the background, make its clip unless it is ready, failed lately or the manifest does not know it. Never throws. */
  want(tag, key, {reason = 'wanted'} = {}) {
    const language = packOfTag(tag);
    if (!language || !this.supports(tag) || !this.canMake || !KEY.test(String(key))) return;
    const id = `${language}|${key}`;
    if (this.ready(language, key) || this.running.has(id)) return;
    const failed = this.failed.get(id);
    if (failed && (failed.permanent || this.now() - failed.at < this.retryMs)) return;
    void this.ensure(tag, key, {reason}).catch(() => {});
  }

  /** Makes (or downloads) one voice's clip unless it is ready. Resolves to 'ready', 'unavailable' or 'unknown' (the manifest does not have the voice). */
  ensure(tag, key, {reason = 'wanted'} = {}) {
    const language = packOfTag(tag);
    if (!language || !this.supports(tag)) return Promise.resolve('unknown');
    const id = `${language}|${key}`;
    if (this.ready(language, key)) return Promise.resolve('ready');
    if (this.running.has(id)) return this.running.get(id);
    const job = this.serial.run(() => this.#make(language, key, reason)).finally(() => this.running.delete(id));
    this.running.set(id, job);
    return job;
  }

  async #make(language, key, reason) {
    const id = `${language}|${key}`, started = this.now();
    let result;
    let voice = null;
    try {
      voice = (await this.#manifest(language))?.voices.get(key) ?? null;
      if (!voice) { this.failed.set(id, {reason: 'not in the manifest', at: this.now(), permanent: true}); return 'unknown'; }
      result = 'no way to make it';
      // A recipe that uses Phantom Liberty's lines needs that archive too (829 of the 3015 do): without it the clip is downloaded, no process is started.
      if (voice.exact && this.dubPresent(language, 'content') && (!voice.needsEp1 || this.dubPresent(language, 'ep1'))) result = await this.#build(language, key, voice);
      if (result !== 'ready' && this.download) result = await this.#fetch(language, key, voice);
    } catch (error) { result = `stopped: ${String(error?.message ?? error).slice(0, 120)}`; }
    if (result === 'ready') {
      this.failed.delete(id);
      this.log(`${language} voice clip of ${key} ready (${reason}, ${this.now() - started} ms, ${this.index[language][key].source})`);
      try { await this.onReady(LANGUAGE_PACKS[language], key); } catch { /* the next reply finds it */ }
      return 'ready';
    }
    this.failed.set(id, {reason: result, at: this.now(), permanent: false});
    this.log(`${language} voice clip of ${key} not made: ${result}; the English reference speaks`);
    return 'unavailable';
  }

  async #build(language, key, voice) {
    if (!this.python || !this.script || !this.gameDirectory) return 'no builder';
    await this.#marker(this.referenceRoot, language);
    const out = join(this.referenceRoot, LANGUAGE_PACK_FOLDER, language);
    const args = [this.script, 'build-language', '--manifest', this.manifestPath(language), '--key', key, '--game', this.gameDirectory, '--out', out];
    if (this.vgmstream) args.push('--vgmstream', this.vgmstream);
    const done = await this.run(this.python, args, {timeout: BUILD_TIMEOUT_MS});
    if (done.code === EXIT_NO_ENGLISH_VOICE) { this.dubSeen.set(language, {at: this.now(), present: false}); return 'the game has no voice files of this language'; }
    if (done.code !== 0) return String(done.stderr || `the builder stopped with ${done.code}`).trim().split(/\r?\n/).pop().slice(0, 200);
    return this.#record(language, key, voice, 'build');
  }

  async #fetch(language, key, voice) {
    const fetchImpl = this.download?.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') return 'no network client';
    try {
      const bytes = await downloadFile(languageDownloadUrl(language, voice.file, this.download?.repository ?? VOICE_CLIPS_REPOSITORY), fetchImpl, voice.sha256);
      if (bytes.length > MAX_CLIP_BYTES) throw Error('download is not a clip');
      await this.#marker(this.referenceRoot, language);
      const target = this.clipPath(language, voice.file);
      await this.files.mkdir(join(target, '..'), {recursive: true});
      await this.files.writeFile(`${target}.part`, bytes);
      await this.files.rename(`${target}.part`, target);
    } catch (error) { return `download failed: ${String(error?.message ?? error).slice(0, 120)}`; }
    return this.#record(language, key, voice, 'download');
  }

  /** generated.json beside the clips: a folder with clips made here and no manifest.json is not an incomplete pack. */
  async #marker(root, language) {
    const id = `${root}|${language}`;
    if (this.markers.has(id)) return;
    const directory = join(root, LANGUAGE_PACK_FOLDER, language);
    await this.files.mkdir(directory, {recursive: true});
    await this.files.writeFile(join(directory, GENERATED_MARKER), JSON.stringify({generated: true, by: 'voice-language-clips'}));
    this.markers.add(id);
  }

  async #mirror(language, voice) {
    const from = this.clipPath(language, voice.file);
    for (const root of this.mirrorRoots) {
      const target = this.clipPath(language, voice.file, root);
      if (resolve(target).toLowerCase() === resolve(from).toLowerCase()) continue;
      try {
        await this.#marker(root, language);
        await this.files.mkdir(join(target, '..'), {recursive: true});
        await this.files.copyFile(from, `${target}.part`);
        await this.files.rename(`${target}.part`, target);
      } catch (error) { this.log(`${language} voice clip not copied to a reference folder: ${error?.code ?? 'error'}`); }
    }
  }

  async #record(language, key, voice, source) {
    let bytes;
    try { bytes = await this.files.readFile(this.clipPath(language, voice.file)); } catch { return 'the clip was not written'; }
    if (bytes.length < 44 || bytes.length > MAX_CLIP_BYTES || bytes.toString('latin1', 0, 4) !== 'RIFF') return 'the clip is not usable';
    const digest = sha256(bytes);
    // A built clip that differs from the pack's (a patched voice line, a CPU whose last bit differs) is kept: it is the player's own dub. A downloaded one was checked already.
    if (source === 'build' && digest !== voice.sha256) this.log(`${language} voice clip of ${key} differs from the pack's clip (${bytes.length} bytes against ${voice.samples * 2 + 44}); kept`);
    await this.#mirror(language, voice);
    (this.index[language] ??= Object.create(null))[key] = {sha256: digest, bytes: bytes.length, source};
    this.entries.delete(`${language}|${key}`);
    try { await this.#save(); } catch (error) { this.log(`Voice language clip index not saved: ${error?.message ?? error}`); }
    return 'ready';
  }

  /** What a support report may say: counts only. */
  report() {
    const languages = {};
    for (const [language, rows] of Object.entries(this.index)) {
      const list = Object.values(rows);
      languages[language] = {ready: list.length, built: list.filter(row => row.source !== 'download').length, downloaded: list.filter(row => row.source === 'download').length};
    }
    return {active: this.active, languages: this.available.size, dub: Object.fromEntries([...this.dubSeen].map(([language, seen]) => [language, seen.present])),
      failed: this.failed.size, running: this.running.size, clips: languages};
  }
}
