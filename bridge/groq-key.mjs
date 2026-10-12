// The player's Groq API key (docs/MISTRAL.md, "Groq"): handled exactly like the Mistral key (bridge/mistral-key.mjs).
//
// Stored only in this bridge's state folder (player-groq-key.txt), never in the game folder, in settings.json, in a status file or in
// a log. The settings page shows only its last four characters. A player pastes it from the clipboard (the same command file
// protocol, runtime/groq-key-command.json) or saves it in that file by hand. The key is only ever sent to api.groq.com.
import {readFile, rm} from 'node:fs/promises';
import {writePrivate, keyTail} from './mistral-key.mjs';

export const GROQ_KEY_FILE = 'player-groq-key.txt';
// A Groq key starts with gsk_ followed by letters and digits (56 characters today).
const KEY_PATTERN = /^gsk_[A-Za-z0-9]{20,160}$/;

/** The key in a file's text (`api-key=...`, `key=...` or the bare value) or a pasted value. Null when it is not a plausible Groq key. */
export function parseGroqKey(text) {
  if (typeof text !== 'string' || text.length > 4096) return null;
  const trimmed = text.replace(/^﻿/, '').trim();
  const labelled = /^(?:api[-_ ]?key|groq[-_ ]?(?:api[-_ ]?)?key|key)\s*[=:]\s*(\S+)$/i.exec(trimmed);
  const value = labelled ? labelled[1] : /^\S+$/.test(trimmed) ? trimmed : null;
  return value && KEY_PATTERN.test(value) ? value : null;
}

export class GroqKey {
  constructor({keyPath, readText = path => readFile(path, 'utf8'), writeText = writePrivate, removeFile = path => rm(path, {force: true})} = {}) {
    Object.assign(this, {keyPath, readText, writeText, removeFile});
    this.key = null; this.listeners = new Set();
  }
  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  #changed() { for (const listener of this.listeners) { try { listener(); } catch { /* an observer never breaks the key */ } } }
  /** Reads the saved key. A missing or malformed file means none. */
  async load() {
    this.key = null;
    if (this.keyPath) { try { this.key = parseGroqKey(await this.readText(this.keyPath)); } catch { /* none saved */ } }
    return this;
  }
  get tail() { return keyTail(this.key); }
  secrets() { return [this.key].filter(Boolean); }
  async save(key) { await this.writeText(this.keyPath, `api-key=${key}\n`); this.key = key; this.#changed(); }
  async remove() { await this.removeFile(this.keyPath); this.key = null; this.#changed(); }
}
