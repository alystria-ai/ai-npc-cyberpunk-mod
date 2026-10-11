// The conversation provider (Convai or Mistral) and the player's Mistral API key (docs/MISTRAL.md).
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

async function writePrivate(path, text) {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, text, {encoding: 'utf8', mode: 0o600});
    await rename(temporary, path);
  } catch (error) { await rm(temporary, {force: true}).catch(() => {}); throw error; }
}

export const PROVIDERS = Object.freeze(['convai', 'mistral']);

/**
 * Which provider conversations use. `preference` follows the Conversation provider setting; Mistral is `requested` only
 * when a key is saved (without one the setting falls back to Convai and says so once); `applied` is what turns use.
 */
export class MistralProvider {
  constructor({keyPath, readText = path => readFile(path, 'utf8'), writeText = writePrivate, removeFile = path => rm(path, {force: true})} = {}) {
    Object.assign(this, {keyPath, readText, writeText, removeFile});
    this.key = null; this.preference = 'convai'; this.applied = 'convai';
    this.noKeyPending = false; this.voicePending = false; this.limit = null; this.sttAvailable = false;
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
    if (changed) this.noKeyPending = next === 'mistral' && !this.key;
    return changed;
  }
  /** The provider the setting asks for, given the key: Mistral only with a key. */
  get requested() { return this.preference === 'mistral' && this.key ? 'mistral' : 'convai'; }
  get pending() { return this.requested !== this.applied; }
  get active() { return this.applied === 'mistral'; }
  /** Adopts the requested provider; call only at an idle boundary. Returns whether it changed. */
  apply() {
    const changed = this.pending;
    this.applied = this.requested;
    if (changed && this.applied === 'mistral') { this.limit = null; this.voicePending = true; }
    if (changed) this.#changed();
    return changed;
  }
  /** The key a request uses. Only the Mistral client ever receives it. */
  get apiKey() { return this.key; }
  get tail() { return keyTail(this.key); }
  /** Every value that must be scrubbed from reports. */
  secrets() { return [this.key].filter(Boolean); }
  noteLimit(kind) { this.limit = kind ? {kind, at: Date.now()} : null; this.#changed(); }
  noteSuccess() { if (this.limit) { this.limit = null; this.#changed(); } }
  /** 'mistral-no-key' or 'mistral-voice' once each (the game shows them with the next reply), else undefined. */
  takeNotice({cloudVoice = false} = {}) {
    if (this.noKeyPending && this.applied === 'convai') { this.noKeyPending = false; return 'mistral-no-key'; }
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
    read = path => readFile(path, 'utf8'), now = Date.now} = {}) {
    if (!provider || typeof commandPath !== 'string' || typeof publish !== 'function') throw Error('Invalid Mistral configuration');
    Object.assign(this, {provider, commandPath, publish, model, readClipboard, validate, read, now});
    this.observed = ''; this.result = null; this.busy = false; this.writing = Promise.resolve();
  }
  /** Ignore a command left from an earlier session, then publish the first status. */
  async open() {
    this.observed = await this.read(this.commandPath).catch(() => '');
    await this.publishStatus();
    return this;
  }
  status() {
    const p = this.provider;
    return {version: 1, updated: this.now(), provider: p.preference, effective: p.applied, saved: !!p.key, tail: p.tail,
      pending: p.pending, ...(this.result ? {result: this.result} : {}), limit: p.limit?.kind ?? null,
      model: typeof this.model === 'function' ? this.model() : this.model, stt: p.sttAvailable === true};
  }
  publishStatus() {
    this.writing = this.writing.catch(() => {}).then(() => this.publish(this.status()));
    return this.writing;
  }
  async poll() {
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
