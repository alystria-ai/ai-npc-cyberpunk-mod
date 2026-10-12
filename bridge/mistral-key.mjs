// The conversation provider (Convai, Mistral or the fully local AI) and the player's Mistral API key (docs/MISTRAL.md, docs/LOCAL_AI.md).
//
// The key is stored only in this bridge's state folder (player-mistral-key.txt), never in the game folder, in
// settings.json, in a status file or in a log. The settings page shows only its last four characters. A player can paste it
// from the clipboard (the same command file protocol as the Convai key, bridge/convai-key.mjs) or save it in that file by hand.
//
// The provider in use changes only at an idle boundary (`apply`), like the Convai key, so a conversation never mixes two providers.
import {readFile, writeFile, rename, rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {readClipboardText} from './convai-key.mjs';
import {validateKey} from './mistral-client.mjs';
import {parseGroqKey} from './groq-key.mjs';
import {parseInworldKey, validateInworldKey} from './inworld-key.mjs';

export const MISTRAL_KEY_FILE = 'player-mistral-key.txt';
// A Mistral key is a plain run of letters and digits (32 characters today) with no prefix. The shape check only keeps obvious mistakes
// (a sentence, a path) out; a key of another service is turned away by the check with Mistral before it is saved.
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{19,127}$/;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

/** The key in a file's text (`api-key=...`, `key=...` or the bare value) or a pasted value. Null when it is not a plausible Mistral key. */
export function parseMistralKey(text) {
  if (typeof text !== 'string' || text.length > 4096) return null;
  const trimmed = text.replace(/^﻿/, '').trim();
  const labelled = /^(?:api[-_ ]?key|mistral[-_ ]?(?:api[-_ ]?)?key|key)\s*[=:]\s*(\S+)$/i.exec(trimmed);
  const value = labelled ? labelled[1] : /^\S+$/.test(trimmed) ? trimmed : null;
  return value && KEY_PATTERN.test(value) ? value : null;
}

/** The only part of a key that may be shown. */
export const keyTail = key => typeof key === 'string' && key.length >= 16 ? key.slice(-4) : null;

export async function writePrivate(path, text) {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, text, {encoding: 'utf8', mode: 0o600});
    await rename(temporary, path);
  } catch (error) { await rm(temporary, {force: true}).catch(() => {}); throw error; }
}

export const PROVIDERS = Object.freeze(['convai', 'mistral', 'local', 'groq']);
// How long Groq is left alone after it refused a request (then it is tried again): its per-minute budget, its daily budget, a missing model.
export const GROQ_BLOCK_MS = Object.freeze({rate: 60_000, daily: 30 * 60_000, model: 5 * 60_000, invalid: Infinity});

/**
 * Which provider conversations use. `preference` follows the Conversation provider setting; Mistral is `requested` only
 * when a key is saved (without one the setting falls back to Convai and says so once); the local AI is `requested` unless it has
 * failed (not installed, not enough graphics memory, would not start), in which case Convai is used and one notice says so until
 * the setting is changed again; Groq is `requested` while it has a key and is not blocked by a limit (then Mistral when a Mistral key
 * exists, else Convai); `applied` is what turns use. `active` means a text provider (Mistral, Groq or local) answers.
 */
export class MistralProvider {
  constructor({keyPath, readText = path => readFile(path, 'utf8'), writeText = writePrivate, removeFile = path => rm(path, {force: true}), groq = null, inworld = null} = {}) {
    Object.assign(this, {keyPath, readText, writeText, removeFile, groq, inworld});
    this.groqLimit = null; this.groqBlockedUntil = 0; this.groqNoKeyPending = false;
    // A new Groq key (or its removal) ends any block that came from the old one.
    groq?.onChange?.(() => { this.groqLimit = null; this.groqBlockedUntil = 0; this.#changed(); });
    this.key = null; this.preference = 'convai'; this.applied = 'convai';
    this.noKeyPending = false; this.voicePending = false; this.limit = null; this.sttAvailable = false;
    this.localBroken = null; this.localNoticePending = false; // why the local AI cannot be used (null: it can), and the one notice for it
    this.listeners = new Set();
  }
  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  #changed() { for (const listener of this.listeners) { try { listener(); } catch { /* an observer never breaks the provider */ } } }
  /** Reads the saved key. A missing or malformed file means none. */
  async load() {
    this.key = null;
    if (this.keyPath) { try { this.key = parseMistralKey(await this.readText(this.keyPath)); } catch { /* none saved */ } }
    return this;
  }
  setPreference(value) {
    const next = PROVIDERS.includes(value) ? value : 'convai', changed = next !== this.preference;
    this.preference = next;
    if (changed) {
      this.noKeyPending = next === 'mistral' && !this.key; this.localBroken = null; this.localNoticePending = false;
      this.groqNoKeyPending = next === 'groq' && !this.groq?.key; this.groqBlockedUntil = 0; this.groqLimit = null;
    }
    return changed;
  }
  /** The provider the setting asks for, given the key: Mistral only with a key. */
  get requested() {
    if (this.preference === 'groq') {
      if (!this.groq?.key) return 'convai';
      return Date.now() >= this.groqBlockedUntil ? 'groq' : this.key ? 'mistral' : 'convai';
    }
    if (this.preference === 'mistral' && this.key) return 'mistral';
    // The local AI could not be used (pack missing, no room beside the voice, crashed): a cloud provider with a key answers, else Convai.
    if (this.preference === 'local') return !this.localBroken ? 'local' : this.key ? 'mistral' : 'convai';
    return 'convai';
  }
  get pending() { return this.requested !== this.applied; }
  /** A text provider (Mistral or the local AI) answers turns, not Convai. */
  get active() { return this.applied !== 'convai'; }
  /** Which text route answers: 'mistral', 'local' or (Convai) 'convai'. */
  get route() { return this.applied; }
  /** Groq refused or could not answer (kind: 'rate', 'daily', 'invalid', 'model'): it is left alone for a while; Mistral (with a key) or Convai answers meanwhile. */
  noteGroqLimit(kind) {
    this.groqLimit = kind ? {kind, at: Date.now()} : null;
    if (kind && GROQ_BLOCK_MS[kind] !== undefined) this.groqBlockedUntil = Date.now() + GROQ_BLOCK_MS[kind];
    this.#changed();
  }
  noteGroqSuccess() { if (this.groqLimit) { this.groqLimit = null; this.#changed(); } }
  /** Groq's key, for the Groq route only. */
  get groqApiKey() { return this.groq?.key ?? null; }
  /** The local AI cannot be used (reason: 'not-installed', 'low-memory', 'no-gpu', 'start-failed', 'crashed'): Convai takes over at the next idle boundary, with one notice. */
  noteLocalFailure(reason) {
    if (this.preference !== 'local') return;
    if (this.localBroken === (reason || 'start-failed')) return;
    this.localBroken = reason || 'start-failed'; this.localNoticePending = true;
    this.#changed();
  }
  /** Adopts the requested provider; call only at an idle boundary. Returns whether it changed. */
  apply() {
    const changed = this.pending;
    this.applied = this.requested;
    if (changed && this.applied !== 'convai') { this.limit = null; if (this.applied === 'groq') this.groqLimit = null; }
    if (changed && this.applied === 'mistral') this.voicePending = true;
    if (changed) this.#changed();
    return changed;
  }
  /** The key a request uses. Only the Mistral client ever receives it. */
  get apiKey() { return this.key; }
  get tail() { return keyTail(this.key); }
  /** Every value that must be scrubbed from reports. */
  secrets() { return [this.key, ...(this.groq?.secrets?.() ?? []), ...(this.inworld?.secrets?.() ?? [])].filter(Boolean); }
  noteLimit(kind) { this.limit = kind ? {kind, at: Date.now()} : null; this.#changed(); }
  noteSuccess() { if (this.limit) { this.limit = null; this.#changed(); } }
  /** 'mistral-no-key', 'groq-no-key', 'mistral-voice' or 'local-fallback' once each (the game shows them with the next reply), else undefined. */
  takeNotice({cloudVoice = false} = {}) {
    if (this.localNoticePending && this.applied !== 'local') { this.localNoticePending = false; return 'local-fallback'; }
    if (this.noKeyPending && this.applied === 'convai') { this.noKeyPending = false; return 'mistral-no-key'; }
    if (this.groqNoKeyPending && this.applied === 'convai') { this.groqNoKeyPending = false; return 'groq-no-key'; }
    if (this.voicePending && this.applied === 'mistral' && cloudVoice) { this.voicePending = false; return 'mistral-voice'; }
    return undefined;
  }
  async save(key) {
    await this.writeText(this.keyPath, `api-key=${key}\n`);
    this.key = key; this.limit = null; this.#changed();
  }
  async remove() { await this.removeFile(this.keyPath); this.key = null; this.limit = null; this.#changed(); }
}

export function parseKeyCommand(raw, now = Date.now()) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 4096) return null;
  let value; try { value = JSON.parse(raw); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !COMMAND_ID.test(value.id ?? '')
      || !['paste', 'clear'].includes(value.action) || !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0
      || value.issuedAt > now + 5000) return null;
  return {id: value.id, action: value.action};
}

/** File IPC for the two settings actions (Paste Mistral key, Remove my Mistral key) and the status file the settings page
 * reads (runtime/mistral-state.json). The key itself never enters either file. */
export class MistralControl {
  constructor({provider, commandPath, publish, model, readClipboard = readClipboardText, validate = validateKey,
    read = path => readFile(path, 'utf8'), now = Date.now, localStatus, groqCommandPath, validateGroq = key => validateKey(key, {provider: 'groq'}), inworldCommandPath, validateInworld = validateInworldKey} = {}) {
    if (!provider || typeof commandPath !== 'string' || typeof publish !== 'function') throw Error('Invalid Mistral configuration');
    Object.assign(this, {provider, commandPath, publish, model, readClipboard, validate, read, now, localStatus, groqCommandPath, validateGroq, inworldCommandPath, validateInworld});
    this.observed = ''; this.result = null; this.busy = false; this.writing = Promise.resolve();
    this.groqObserved = ''; this.groqResult = null; this.groqBusy = false;
    this.inworldObserved = ''; this.inworldResult = null; this.inworldBusy = false;
  }
  /** Ignore a command left from an earlier session, then publish the first status. */
  async open() {
    this.observed = await this.read(this.commandPath).catch(() => '');
    if (this.groqCommandPath) this.groqObserved = await this.read(this.groqCommandPath).catch(() => '');
    if (this.inworldCommandPath) this.inworldObserved = await this.read(this.inworldCommandPath).catch(() => '');
    await this.publishStatus();
    return this;
  }
  status() {
    const p = this.provider;
    return {version: 1, updated: this.now(), provider: p.preference, effective: p.applied, saved: !!p.key, tail: p.tail,
      pending: p.pending, ...(this.result ? {result: this.result} : {}), limit: p.limit?.kind ?? null,
      model: typeof this.model === 'function' ? this.model() : this.model, stt: p.sttAvailable === true,
      // The local AI: 'ready' | 'warming' | 'not-installed' | 'no-memory' | 'failed' (docs/LOCAL_AI.md); never a path or a key.
      ...(typeof this.localStatus === 'function' ? {localAi: this.localStatus()} : {}),
      // Groq (docs/MISTRAL.md): the key status and the latest limit; never the key.
      ...(this.provider.groq ? {groq: {saved: !!this.provider.groq.key, tail: this.provider.groq.tail,
        limit: this.provider.groqLimit?.kind ?? null, ...(this.groqResult ? {result: this.groqResult} : {})}} : {}),
      // Inworld (docs/CLOUD_VOICE_INWORLD.md): only the key status; never the key.
      ...(this.provider.inworld ? {inworld: {saved: !!this.provider.inworld.key, tail: this.provider.inworld.tail,
        ...(this.inworldResult ? {result: this.inworldResult} : {})}} : {})};
  }
  publishStatus() {
    this.writing = this.writing.catch(() => {}).then(() => this.publish(this.status()));
    return this.writing;
  }
  async poll() {
    await this.pollMistral();
    await this.pollGroq();
    await this.pollInworld();
  }
  async pollInworld() {
    if (this.inworldBusy || !this.inworldCommandPath || !this.provider.inworld) return;
    const raw = await this.read(this.inworldCommandPath).catch(() => '');
    if (raw === this.inworldObserved) return;
    this.inworldObserved = raw;
    const command = parseKeyCommand(raw, this.now());
    if (!command) return;
    this.inworldBusy = true;
    try {
      this.inworldResult = {id: command.id, state: 'checking'};
      await this.publishStatus();
      this.inworldResult = {id: command.id, state: await this.runInworld(command)};
    } catch { this.inworldResult = {id: command.id, state: 'failed'}; }
    finally { this.inworldBusy = false; }
    await this.publishStatus();
  }
  async runInworld(command) {
    const inworld = this.provider.inworld;
    if (command.action === 'clear') { await inworld.remove(); return 'cleared'; }
    let text;
    try { text = await this.readClipboard(); } catch { return 'unreadable'; }
    if (typeof text !== 'string' || !text.trim()) return 'unreadable';
    const key = parseInworldKey(text);
    if (!key) return 'invalid';
    if (await this.validateInworld(key) === 'invalid') return 'invalid';
    await inworld.save(key);
    return 'saved';
  }
  async pollGroq() {
    if (this.groqBusy || !this.groqCommandPath || !this.provider.groq) return;
    const raw = await this.read(this.groqCommandPath).catch(() => '');
    if (raw === this.groqObserved) return;
    this.groqObserved = raw;
    const command = parseKeyCommand(raw, this.now());
    if (!command) return;
    this.groqBusy = true;
    try {
      this.groqResult = {id: command.id, state: 'checking'};
      await this.publishStatus();
      this.groqResult = {id: command.id, state: await this.runGroq(command)};
    } catch { this.groqResult = {id: command.id, state: 'failed'}; }
    finally { this.groqBusy = false; }
    await this.publishStatus();
  }
  async runGroq(command) {
    const groq = this.provider.groq;
    if (command.action === 'clear') { await groq.remove(); return 'cleared'; }
    let text;
    try { text = await this.readClipboard(); } catch { return 'unreadable'; }
    if (typeof text !== 'string' || !text.trim()) return 'unreadable';
    const key = parseGroqKey(text);
    if (!key) return 'invalid';
    if (await this.validateGroq(key) === 'invalid') return 'invalid';
    await groq.save(key);
    return 'saved';
  }
  async pollMistral() {
    if (this.busy) return;
    const raw = await this.read(this.commandPath).catch(() => '');
    if (raw === this.observed) return;
    this.observed = raw;
    const command = parseKeyCommand(raw, this.now());
    if (!command) return;
    this.busy = true;
    try {
      this.result = {id: command.id, state: 'checking'};
      await this.publishStatus();
      this.result = {id: command.id, state: await this.run(command)};
    } catch { this.result = {id: command.id, state: 'failed'}; }
    finally { this.busy = false; }
    await this.publishStatus();
  }
  async run(command) {
    if (command.action === 'clear') { await this.provider.remove(); return 'cleared'; }
    let text;
    try { text = await this.readClipboard(); } catch { return 'unreadable'; }
    if (typeof text !== 'string' || !text.trim()) return 'unreadable';
    const key = parseMistralKey(text);
    if (!key) return 'invalid';
    if (await this.validate(key) === 'invalid') return 'invalid';
    await this.provider.save(key);
    return 'saved';
  }
}
