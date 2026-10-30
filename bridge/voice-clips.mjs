// Voice reference clips built on the player's own PC from their own game files (docs/VOICE_CLIPS_FROM_GAME.md).
//
// Every character's reference clips (OmniVoice short and long, Pocket) were cut from the game's own English voice lines. This module builds the same
// clips again, line for line, the first time a character needs them, and keeps them: `characters/voice-clips-manifest.json` says which lines of
// `lang_en_voice.archive`, in which order, how each is turned into 24 kHz mono and what gain was applied; `bridge/voice_clip_build.py` does the work (a
// small reader of the game's archive format, vgmstream for the .wem, numpy for the rest) in a process of its own at below normal priority that exits when
// the character's clips are written. Nothing runs per frame and nothing runs in front of a reply.
//
// Where things are:
//   <references>/generated/<omni-short|omni-long|pocket>/<key>.wav   the clips (the references folder the voice workers read, next to prepared/ and addons/)
//   <state>/voice-clips.json                                         the index: per key and kind the clip's SHA-256 and where it came from (build, download)
// A generated clip is named in the voice tables as `runtime/voice-references/generated/<kind>/<key>.wav` with its own SHA-256, so every voice engine reads
// it like any reference. When one is ready it replaces the shipped clip of that key (descriptors()); a clip that is not ready leaves the table as it was.
//
// When a clip is wanted (needs()): the manifest knows the character, the three clips are not ready, and a shipped clip is missing (or CYBERPUNK_CONVAI_GAME_CLIPS=1
// asks for the game's clips even when shipped ones exist). A game with no English voice archive (a player who installed only another voice language), or a
// line this game version does not have, is not an error: the clip is downloaded from our Hugging Face files when `download` is on, else the character keeps the
// shipped clip or the archetype voice it has today.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {copyFile, mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {setPriority, constants as osConstants} from 'node:os';
import {join, resolve} from 'node:path';
import {atomicFile} from './guarded-file.mjs';

export const GENERATED_FOLDER = 'generated';
export const VOICE_CLIPS_INDEX = 'voice-clips.json';
export const VOICE_CLIPS_REPOSITORY = 'alystria-ai/ai-npc-cyberpunk-mod-packs';
export const VOICE_CLIPS_FOLDER = 'voice-clips';
export const REFERENCE_NAMESPACE = 'runtime/voice-references/';
/** The engines' tables and the kind each reads: Pocket's, OmniVoice's short and long ones. */
export const ENGINE_KINDS = Object.freeze({pocket: 'pocket', short: 'omni-short', long: 'omni-long'});
const KINDS = Object.freeze(Object.values(ENGINE_KINDS));
const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SHA = /^[a-f0-9]{64}$/;
/**
 * The two archetype voices that always ship, with every package (packaging/build-release.mjs leaves them in when voiceClips.fromGame leaves the other clips out). A character
 * whose own clips are not built yet speaks with the one of its gender (standInDescriptors) for any line it needs before they are, so a first talk never meets a missing
 * voice and shows no error.
 */
export const STAND_IN_VOICES = Object.freeze({female: 'resident-female', male: 'resident-male'});
export const standInKey = gender => STAND_IN_VOICES[String(gender ?? '').toLowerCase() === 'female' ? 'female' : 'male'];
export const BUILD_TIMEOUT_MS = 180_000;
export const EXIT_NO_ENGLISH_VOICE = 3;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const generatedReference = (kind, key) => `${REFERENCE_NAMESPACE}${GENERATED_FOLDER}/${kind}/${key}.wav`;
export const downloadUrl = (kind, key, repository = VOICE_CLIPS_REPOSITORY) => `https://huggingface.co/${repository}/resolve/main/${VOICE_CLIPS_FOLDER}/${kind}/${key}.wav`;

/** The manifest's voices with `sameAs` entries resolved: {key: {kind: {sha256, samples, ...}}}. Entries that are not well formed are left out. */
export function readManifest(text) {
  const parsed = JSON.parse(String(text).replace(/^﻿/, ''));
  const voices = Object.create(null);
  if (!plain(parsed) || !plain(parsed.voices)) return voices;
  for (const [key, kinds] of Object.entries(parsed.voices)) {
    if (!KEY.test(key) || !plain(kinds)) continue;
    const row = {};
    for (const kind of KINDS) {
      let spec = kinds[kind];
      if (plain(spec) && typeof spec.sameAs === 'string') spec = kinds[spec.sameAs];
      if (plain(spec) && SHA.test(spec.sha256 ?? '') && Number.isInteger(spec.samples)) row[kind] = {sha256: spec.sha256, samples: spec.samples};
    }
    if (KINDS.every(kind => row[kind])) voices[key] = Object.freeze(row);
  }
  return voices;
}

/**
 * The words of each character's clips (characters/voice-clips-words.json, written by scripts/voice-extract/write_words.mjs): {key: {pocket, short, long}}. A voice table
 * names a clip with its words, and a character that is not in the shipped configurations (an older Runtime) has none to take them from. Entries that are not well formed are left out.
 */
export function readWords(text) {
  const words = Object.create(null);
  let parsed = null;
  try { parsed = JSON.parse(String(text).replace(/^﻿/, '')); } catch { return words; }
  if (!plain(parsed) || !plain(parsed.voices)) return words;
  for (const [key, row] of Object.entries(parsed.voices)) {
    if (!KEY.test(key) || !plain(row)) continue;
    const engines = Object.keys(ENGINE_KINDS);
    if (engines.every(engine => typeof row[engine] === 'string' && row[engine].trim())) words[key] = Object.freeze(Object.fromEntries(engines.map(engine => [engine, row[engine]])));
  }
  return words;
}

/** The text that says which game files the clips came from: the English voice archives' sizes and times (a stat each, never a read). */
export async function gameFingerprint(gameDirectory, files = {stat}) {
  const parts = [];
  for (const name of ['content', 'ep1']) {
    try {
      const info = await files.stat(join(gameDirectory, 'archive', 'pc', name, 'lang_en_voice.archive'));
      parts.push(`${name}:${info.size}:${Math.round(info.mtimeMs)}`);
    } catch { parts.push(`${name}:none`); }
  }
  return parts.join('|');
}

/** Runs the builder: resolves to {code, stdout, stderr}. The process is started at below normal priority and killed after `timeout`. */
export function runBuilder(command, args, {timeout = BUILD_TIMEOUT_MS, spawnProcess = spawn} = {}) {
  return new Promise(resolveRun => {
    let child;
    try { child = spawnProcess(command, args, {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}); }
    catch (error) { resolveRun({code: -1, stdout: '', stderr: String(error?.message ?? error)}); return; }
    let stdout = '', stderr = '', finished = false;
    const done = result => { if (!finished) { finished = true; clearTimeout(timer); resolveRun(result); } };
    try { if (child.pid) setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* a process that already ended */ }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done({code: -2, stdout, stderr: `${stderr}\nstopped after ${timeout} ms`.trim()}); }, timeout);
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on('error', error => done({code: -1, stdout, stderr: String(error?.message ?? error)}));
    child.on('close', code => done({code: code ?? -1, stdout, stderr}));
  });
}

async function downloadFile(url, fetchImpl, expectedSha) {
  const response = await fetchImpl(url, {redirect: 'follow'});
  if (!response.ok) throw Error(`download answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 44 || bytes.length > 24_000_000 || bytes.toString('latin1', 0, 4) !== 'RIFF') throw Error('download is not a clip');
  if (sha256(bytes) !== expectedSha) throw Error('download does not match the manifest');
  return bytes;
}

export class GameVoiceClips {
  /**
   *   manifest         voices of readManifest(): which characters have clips that can be built, and the hash each clip must have when it matches the shipped one
   *   gameDirectory    the game folder (read only)
   *   referenceRoot    the references folder the voice workers read (clips go to <referenceRoot>/generated/)
   *   mirrorRoots      other reference folders a worker reads (Pocket's own), each given a copy of every finished clip in the same place under it
   *   stateDirectory   the service's data folder (the index lives in it)
   *   python, script, vgmstream   the Runtime's Python, bridge/voice_clip_build.py and vgmstream-cli.exe
   *   manifestPath     the manifest file the builder reads
   *   words            readWords(): the words of each character's clips, for a character the shipped tables have no row for
   *   shippedPresent   async (reference path) => boolean: is that shipped clip on disk (default: a stat under referenceRoot)
   *   shippedPresentSync  the same, synchronous, for the stand-in voices at start and per reply (default: existsSync under referenceRoot; a file check only)
   *   prefer           true: build the game's clips even when shipped ones exist (CYBERPUNK_CONVAI_GAME_CLIPS=1)
   *   download         false, or {fetch, repository}: fetch the clips from Hugging Face when the game cannot give them
   *   onBuilt          (key) => void: a character's clips are ready (the bridge makes the voice tables follow, bridge/live-voices.mjs)
   */
  constructor({manifest = {}, words = {}, gameDirectory = null, referenceRoot, mirrorRoots = [], stateDirectory, python = null, script = null, vgmstream = null, manifestPath = null,
    shippedPresent = null, shippedPresentSync = null, prefer = false, download = false, onBuilt = () => {}, log = () => {}, run = runBuilder, now = Date.now,
    files = {readFile, writeFile, mkdir, rename, rm, stat, copyFile}} = {}) {
    Object.assign(this, {manifest, words, gameDirectory, referenceRoot, mirrorRoots: mirrorRoots.filter(root => typeof root === 'string' && root), stateDirectory, python, script, vgmstream, manifestPath, prefer, download, onBuilt, log, run, now, files});
    this.shippedPresentSync = shippedPresentSync ?? (reference => existsSync(join(referenceRoot, reference.slice(REFERENCE_NAMESPACE.length))));
    this.shippedPresent = shippedPresent ?? (async reference => this.shippedPresentSync(reference));
    this.index = Object.create(null);     // key -> {kind: {sha256, samples, source}}
    this.failed = new Map();              // key -> reason (this session: a character that could not be built is not tried again at every line)
    this.running = new Map();             // key -> promise
    this.queue = Promise.resolve();       // one build at a time
    this.checked = new Set();             // keys `wanted()` has looked at this session
    this.asking = new Map();              // key -> promise of a `wanted()` that is still looking
    this.fingerprint = null;
  }

  static async open(options = {}) {
    const clips = new GameVoiceClips(options);
    await clips.#load();
    return clips;
  }

  get indexPath() { return this.stateDirectory ? join(this.stateDirectory, VOICE_CLIPS_INDEX) : null; }
  clipPath(kind, key) { return join(this.referenceRoot, GENERATED_FOLDER, kind, `${key}.wav`); }

  async #load() {
    this.fingerprint = this.gameDirectory ? await gameFingerprint(this.gameDirectory, this.files) : null;
    if (!this.indexPath) return;
    let parsed = null;
    try { parsed = JSON.parse(String(await this.files.readFile(this.indexPath, 'utf8')).replace(/^﻿/, '')); } catch { parsed = null; }
    if (!plain(parsed) || !plain(parsed.clips)) return;
    // An entry counts only while its file is there with the recorded size on disk; the hash was checked when it was written.
    for (const [key, kinds] of Object.entries(parsed.clips)) {
      if (!KEY.test(key) || !plain(kinds) || !this.manifest[key]) continue;
      const row = {};
      for (const kind of KINDS) {
        const entry = kinds[kind];
        if (!plain(entry) || !SHA.test(entry.sha256 ?? '') || !Number.isInteger(entry.bytes)) continue;
        try { if ((await this.files.stat(this.clipPath(kind, key))).size === entry.bytes) row[kind] = {sha256: entry.sha256, bytes: entry.bytes, source: String(entry.source ?? 'build')}; } catch { /* the file is gone: built again when wanted */ }
      }
      if (KINDS.every(kind => row[kind])) this.index[key] = row;
    }
  }

  async #save() {
    if (!this.indexPath) return;
    const clips = {};
    for (const [key, row] of Object.entries(this.index)) clips[key] = row;
    await this.files.mkdir(this.stateDirectory, {recursive: true});
    await atomicFile(this.indexPath, JSON.stringify({version: 1, game: this.fingerprint, clips}, null, 1));
  }

  /** True when this reference path of a table (runtime/voice-references/...) names a file that is on disk. A path outside the references folder counts as there (a player's clip). */
  isShipped(reference) {
    if (typeof reference !== 'string' || !reference.startsWith(REFERENCE_NAMESPACE)) return typeof reference === 'string' && reference !== '';
    try { return this.shippedPresentSync(reference) === true; } catch { return false; }
  }
  has(key) { return Object.hasOwn(this.manifest, key); }
  ready(key) { return Object.hasOwn(this.index, key); }
  /** The keys whose clips are built, for the voice tables to be made at start. */
  readyKeys() { return Object.keys(this.index); }

  /**
   * The descriptors of a ready character's clips, as the voice tables name them: {pocket, short, long}, each {reference, sha256, transcript}. The words are the
   * shipped descriptors' (`shipped` = {pocket, short, long} descriptors of the same character: the same lines are said in the generated clip), else the manifest's
   * words file (a character the shipped tables have no row for). Null when the character is not ready or neither has words to give.
   */
  descriptors(key, shipped = {}) {
    const row = this.index[key];
    if (!row) return null;
    const out = {};
    for (const [engine, kind] of Object.entries(ENGINE_KINDS)) {
      const own = shipped[engine]?.transcript, transcript = typeof own === 'string' && own.trim() ? own : this.words?.[key]?.[engine];
      if (typeof transcript !== 'string' || !transcript.trim()) return null;
      out[engine] = {reference: generatedReference(kind, key), sha256: row[kind].sha256, transcript};
    }
    return out;
  }

  /** True when this character's clips should be built now: known to the manifest, not ready, not failed this session, and a shipped clip is missing (or `prefer`). */
  async needs(key, shippedTable = {}) {
    if (!this.has(key) || this.ready(key) || this.failed.has(key)) return false;
    if (this.prefer) return true;
    for (const [engine] of Object.entries(ENGINE_KINDS)) {
      const reference = shippedTable[engine]?.reference;
      if (typeof reference !== 'string' || !reference.startsWith(REFERENCE_NAMESPACE) || !(await this.shippedPresent(reference))) return true;
    }
    return false;
  }

  /**
   * A character is wanted (an invitation, the first talk, a composer opened on it): once per session and key, ask whether its clips need to be made (`needs`, with the shipped
   * tables `shipped()` gives: {pocket, short, long}) and make them in the background if so. Resolves to what ensure() resolves to, or 'not needed'. Never throws.
   */
  wanted(key, {shipped = async () => ({}), reason = 'wanted'} = {}) {
    if (!this.has(key)) return Promise.resolve('unknown');
    if (this.asking.has(key)) return this.asking.get(key);
    if (this.checked.has(key)) return this.running.get(key) ?? Promise.resolve(this.ready(key) ? 'ready' : 'not needed');
    this.checked.add(key);
    const asked = (async () => {
      try {
        const tables = await shipped() ?? {};
        const table = Object.fromEntries(Object.keys(ENGINE_KINDS).map(engine => [engine, tables[engine]?.[key] ?? null]));
        return (await this.needs(key, table)) ? await this.ensure(key, {reason}) : 'not needed';
      } catch { return 'not needed'; }
    })();
    this.asking.set(key, asked);
    return asked.finally(() => this.asking.delete(key));
  }

  /**
   * Builds (or downloads) one character's clips unless they are ready. One build at a time, in the order asked, never in front of anything: the caller does not wait
   * unless it wants to. Resolves to 'ready', 'unavailable' (it could not be made: the character keeps what it had) or 'unknown' (not in the manifest).
   */
  ensure(key, {reason = 'wanted'} = {}) {
    if (!this.has(key)) return Promise.resolve('unknown');
    if (this.ready(key)) return Promise.resolve('ready');
    if (this.failed.has(key)) return Promise.resolve('unavailable');
    if (this.running.has(key)) return this.running.get(key);
    const job = this.queue.catch(() => {}).then(() => this.#make(key, reason));
    this.queue = job;
    const tracked = job.finally(() => this.running.delete(key));
    this.running.set(key, tracked);
    return tracked;
  }

  async #make(key, reason) {
    const started = this.now();
    let result;
    try {
      result = await this.#build(key);
      if (result !== 'ready' && this.download) result = await this.#fetch(key);
    } catch (error) { result = `stopped: ${String(error?.message ?? error).slice(0, 120)}`; }
    if (result === 'ready') {
      this.log(`Voice clips of ${key} ready (${reason}, ${this.now() - started} ms)`);
      try { await this.onBuilt(key); } catch { /* the tables follow at the next start */ }
      return 'ready';
    }
    this.failed.set(key, result);
    this.log(`Voice clips of ${key} not made: ${result}`);
    return 'unavailable';
  }

  async #build(key) {
    if (!this.python || !this.script || !this.manifestPath || !this.gameDirectory) return 'no builder';
    const out = join(this.referenceRoot, GENERATED_FOLDER);
    const args = [this.script, 'build', '--manifest', this.manifestPath, '--key', key, '--game', this.gameDirectory, '--out', out];
    if (this.vgmstream) args.push('--vgmstream', this.vgmstream);
    const done = await this.run(this.python, args);
    if (done.code === EXIT_NO_ENGLISH_VOICE) return 'the game has no English voice files';
    if (done.code !== 0) return String(done.stderr || `the builder stopped with ${done.code}`).trim().split(/\r?\n/).pop().slice(0, 200);
    return this.#record(key, 'build');
  }

  async #fetch(key) {
    const fetchImpl = this.download?.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') return 'no network client';
    const repository = this.download?.repository ?? VOICE_CLIPS_REPOSITORY;
    try {
      for (const kind of KINDS) {
        const bytes = await downloadFile(downloadUrl(kind, key, repository), fetchImpl, this.manifest[key][kind].sha256);
        const target = this.clipPath(kind, key);
        await this.files.mkdir(join(this.referenceRoot, GENERATED_FOLDER, kind), {recursive: true});
        await this.files.writeFile(`${target}.part`, bytes);
        await this.files.rename(`${target}.part`, target);
      }
    } catch (error) { return `download failed: ${String(error?.message ?? error).slice(0, 120)}`; }
    return this.#record(key, 'download');
  }

  /** A copy of a finished clip in every other reference folder (a worker reads one folder only); a folder that cannot be written is skipped, the worker of the main one still has the clip. */
  async #mirror(kind, key) {
    const from = this.clipPath(kind, key);
    for (const root of this.mirrorRoots) {
      const target = join(root, GENERATED_FOLDER, kind, `${key}.wav`);
      if (resolve(target).toLowerCase() === resolve(from).toLowerCase()) continue;
      try {
        await this.files.mkdir(join(root, GENERATED_FOLDER, kind), {recursive: true});
        await this.files.copyFile(from, `${target}.part`);
        await this.files.rename(`${target}.part`, target);
      } catch (error) { this.log(`Voice clip of ${key} not copied to a reference folder: ${error?.code ?? 'error'}`); }
    }
  }

  async #record(key, source) {
    const row = {};
    for (const kind of KINDS) {
      try {
        const bytes = await this.files.readFile(this.clipPath(kind, key));
        if (bytes.length < 44 || bytes.length > 24_000_000) throw Error('size');
        row[kind] = {sha256: sha256(bytes), bytes: bytes.length, source};
      } catch { return 'a clip was not written'; }
    }
    for (const kind of KINDS) await this.#mirror(kind, key);
    this.index[key] = row;
    try { await this.#save(); } catch (error) { this.log(`Voice clip index not saved: ${error?.message ?? error}`); }
    return 'ready';
  }

  /** What a support report may say: counts only (no names of lines, no text). */
  report() {
    const sources = {build: 0, download: 0};
    for (const row of Object.values(this.index)) sources[row.pocket?.source === 'download' ? 'download' : 'build']++;
    return {characters: Object.keys(this.manifest).length, ready: this.readyKeys().length, built: sources.build, downloaded: sources.download, failed: this.failed.size, running: this.running.size};
  }
}

/**
 * What a character speaks with until its own clips are built: the descriptors of the stand-in voice of its gender (STAND_IN_VOICES), per engine, for each engine whose
 * shipped clip of the character is not on disk. `shipped` = {pocket, short, long} descriptors of the character (as the shipped configurations have them), `tables` = {pocket,
 * short, long} voices objects that hold the two stand-in voices. Null when the character is not in the manifest, is ready, is itself a stand-in, or no engine needs one
 * (its shipped clips are there, so it keeps them), or the stand-in voice has no file either. Pure file checks, no process.
 * A character with no shipped row in an engine's table counts as having no shipped clip there.
 */
export function standInDescriptors(clips, key, shipped, tables, gender = null) {
  if (!clips.has(key) || clips.ready(key) || Object.values(STAND_IN_VOICES).includes(key)) return null;
  const spareKey = standInKey(gender);
  const out = {};
  for (const engine of Object.keys(ENGINE_KINDS)) {
    const own = shipped?.[engine], spare = tables?.[engine]?.[spareKey];
    // A character with no row at all (an older Runtime that predates it) has no shipped clip either: it speaks with the stand-in too.
    if ((own !== null && own !== undefined && !plain(own)) || !plain(spare) || (plain(own) && clips.isShipped(own.reference))) continue;
    if (!clips.isShipped(spare.reference) || typeof spare.sha256 !== 'string' || typeof spare.transcript !== 'string') continue;
    out[engine] = {reference: spare.reference, sha256: spare.sha256, transcript: spare.transcript};
  }
  return Object.keys(out).length ? out : null;
}

/**
 * At start, after applyReadyClips: a character of the manifest whose clips are not ready and whose shipped clip is not on disk (voiceClips.fromGame leaves them out)
 * gets its stand-in voice in the tables, so the voice workers see a clip that exists and the character can speak at once. The tables are edited in place. `genderOf` =
 * key => 'female' | 'male' | null. Returns the keys that were changed.
 */
export function applyStandIns(clips, tables, genderOf = () => null) {
  const changed = [];
  const spares = Object.fromEntries(Object.keys(ENGINE_KINDS).map(engine => [engine, {...tables[engine]}]));
  for (const key of Object.keys(clips.manifest)) {
    const shipped = Object.fromEntries(Object.keys(ENGINE_KINDS).map(engine => [engine, tables[engine]?.[key] ?? null]));
    let gender = null;
    try { gender = genderOf(key); } catch { gender = null; }
    const named = standInDescriptors(clips, key, shipped, spares, gender);
    if (!named) continue;
    for (const engine of Object.keys(named)) tables[engine][key] = {...shipped[engine], ...named[engine]};
    changed.push(key);
  }
  return changed;
}

/**
 * At start: the voice tables (parsed configurations, {pocket, short, long}: each the `voices` object) get the descriptors of every character whose clips are ready, unless the table
 * names the player's own clip for that key. The tables are edited in place. Returns the keys that were changed.
 */
export function applyReadyClips(clips, tables) {
  const changed = [];
  for (const key of clips.readyKeys()) {
    const current = Object.fromEntries(Object.keys(ENGINE_KINDS).map(engine => [engine, tables[engine]?.[key] ?? null]));
    if (Object.values(current).some(entry => typeof entry?.reference === 'string' && entry.reference.startsWith('runtime/player-voices/'))) continue;
    const named = clips.descriptors(key, current);
    if (!named) continue;
    for (const engine of Object.keys(ENGINE_KINDS)) if (tables[engine]) tables[engine][key] = {...current[engine], ...named[engine]};
    changed.push(key);
  }
  return changed;
}

/** The files of the builder in a Runtime (or a source checkout): {python, script, vgmstream}; a part that is not there is null. */
export function builderFiles({project, runtimePython = null, exists = existsSync} = {}) {
  const pick = candidates => candidates.find(path => path && exists(path)) ?? null;
  return {
    python: runtimePython && exists(runtimePython) ? runtimePython : pick([resolve(project, 'python', 'python.exe'), resolve(project, '..', 'python', 'python.exe')]),
    script: pick([resolve(project, 'bridge', 'voice_clip_build.py')]),
    vgmstream: pick([resolve(project, 'vgmstream', 'vgmstream-cli.exe'), resolve(project, 'vendor', 'vgmstream', 'vgmstream-cli.exe')]),
  };
}
