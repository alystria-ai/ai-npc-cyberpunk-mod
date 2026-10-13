// The player's own Inworld key (docs/CLOUD_VOICE_INWORLD.md): handled exactly like the Groq key (bridge/groq-key.mjs) and the
// Mistral key (bridge/mistral-key.mjs).
//
// Stored only in this bridge's state folder (player-inworld-key.txt), never in the game folder, in settings.json, in a status file or in
// a log. The settings page shows only its last four characters. A player pastes it from the clipboard (the same command file
// protocol, runtime/inworld-key-command.json) or saves it in that file by hand. It is only ever sent to api.inworld.ai.
import {readFile, rm} from 'node:fs/promises';
import {writePrivate, keyTail} from './mistral-key.mjs';

export const INWORLD_KEY_FILE = 'player-inworld-key.txt';
export const INWORLD_VOICES_ENDPOINT = 'https://api.inworld.ai/voices/v1/voices';
// What the Inworld portal copies is one run of Base64 text (letters, digits, + / and = padding; the URL-safe form is tolerated).
// The shape check only keeps obvious mistakes (a sentence, a path) out; the check with Inworld before saving turns away anything else.
const KEY_PATTERN = /^[A-Za-z0-9+/_-]{40,500}={0,2}$/;

/** The key in a file's text (`api-key=...`, `key=...`, `Basic ...` or the bare value) or a pasted value. Null when it is not a plausible Inworld key. */
export function parseInworldKey(text) {
  if (typeof text !== 'string' || text.length > 4096) return null;
  const trimmed = text.replace(/^﻿/, '').trim();
  const labelled = /^(?:api[-_ ]?key|inworld[-_ ]?(?:api[-_ ]?)?key|key)\s*[=:]\s*(\S+)$/i.exec(trimmed);
  let value = labelled ? labelled[1] : /^\S+$/.test(trimmed) || /^Basic\s+\S+$/i.test(trimmed) ? trimmed : null;
  if (value) value = value.replace(/^Basic\s+/i, '');
  // A path is also made of Base64 characters; a real key never starts with a slash.
  return value && !value.startsWith('/') && KEY_PATTERN.test(value) ? value : null;
}

/**
 * Asks Inworld whether the key is accepted, with a request that costs nothing (the voice list). 'valid', 'invalid' (401 or 403)
 * or 'unknown' (anything else: the network, a server fault); only 'invalid' stops the key being saved.
 */
export async function validateInworldKey(apiKey, {fetchImpl = globalThis.fetch, endpoint = INWORLD_VOICES_ENDPOINT, timeoutMs = 10000} = {}) {
  try {
    const response = await fetchImpl(`${endpoint}?pageSize=1`, {headers: {authorization: `Basic ${apiKey}`, accept: 'application/json'}, signal: AbortSignal.timeout(timeoutMs)});
    try { await response.body?.cancel(); } catch { /* already closed */ }
    if (response.ok) return 'valid';
    return response.status === 401 || response.status === 403 ? 'invalid' : 'unknown';
  } catch { return 'unknown'; }
}

export class InworldKey {
  constructor({keyPath, readText = path => readFile(path, 'utf8'), writeText = writePrivate, removeFile = path => rm(path, {force: true})} = {}) {
    Object.assign(this, {keyPath, readText, writeText, removeFile});
    this.key = null; this.listeners = new Set();
  }
  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  #changed() { for (const listener of this.listeners) { try { listener(); } catch { /* an observer never breaks the key */ } } }
  /** Reads the saved key. A missing or malformed file means none. */
  async load() {
    this.key = null;
    if (this.keyPath) { try { this.key = parseInworldKey(await this.readText(this.keyPath)); } catch { /* none saved */ } }
    return this;
  }
  get tail() { return keyTail(this.key); }
  secrets() { return [this.key].filter(Boolean); }
  async save(key) { await this.writeText(this.keyPath, `api-key=${key}\n`); this.key = key; this.#changed(); }
  async remove() { await this.removeFile(this.keyPath); this.key = null; this.#changed(); }
}
