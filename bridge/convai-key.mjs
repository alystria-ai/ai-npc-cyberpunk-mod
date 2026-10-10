// The Convai API key a conversation uses: the one the installation provides, or the player's own.
//
// Player's own key (docs/OWN_CONVAI_KEY.md): the player switches "Use my own Convai API key" on in the settings
// (Development) and pastes a free Convai key from the clipboard. The key is stored only in this bridge's state folder
// (player-convai-key.txt), never in the game folder, in settings.json, in a status file or in a log. The settings page
// shows only its last four characters.
//
// The key in use changes only at an idle boundary (`apply`), so a conversation never mixes two keys and a warm page
// that was opened with one key is never reused under the other.
import {readFile, writeFile, rename, rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {randomBytes} from 'node:crypto';

export const PLAYER_KEY_FILE = 'player-convai-key.txt';
// Convai keys are long opaque tokens; anything shorter, or containing a space, is not one.
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{15,199}$/;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

/** The key in `api-key=...` file text, or in a bare pasted value. Null when it is not a plausible key. */
export function parseKeyText(text) {
  if (typeof text !== 'string' || text.length > 4096) return null;
  const trimmed = text.replace(/^﻿/, '').trim();
  const labelled = /^api-key\s*=\s*(\S+)$/i.exec(trimmed);
  const value = labelled ? labelled[1] : /^\S+$/.test(trimmed) ? trimmed : null;
  return value && KEY_PATTERN.test(value) ? value : null;
}

/** The only part of a key that may be shown or published. */
export const keyTail = key => typeof key === 'string' && key.length >= 16 ? key.slice(-4) : null;

/** Windows clipboard text through PowerShell (bounded, hidden, on demand only). Never logged. */
export function readClipboardText({exec = execFile, timeoutMs = 6000} = {}) {
  return new Promise((resolve, reject) => {
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw'],
    {timeout: timeoutMs, windowsHide: true, maxBuffer: 65536, encoding: 'utf8'},
    (error, stdout) => error ? reject(Error('The clipboard could not be read')) : resolve(String(stdout ?? '')));
  });
}

/** 'valid' (200), 'invalid' (401/403) or 'unknown' (anything else: offline, a server error). Lists characters only,
 * which is not a conversation turn and uses no interaction. */
export async function validateKey(key, {fetchImpl = globalThis.fetch, timeoutMs = 10000} = {}) {
  try {
    const response = await fetchImpl('https://api.convai.com/character/list', {method: 'POST',
      headers: {'Content-Type': 'application/json', 'CONVAI-API-KEY': key}, body: '{}',
      signal: AbortSignal.timeout(timeoutMs)});
    try { await response.body?.cancel(); } catch { /* already closed */ }
    if (response.ok) return 'valid';
    return response.status === 401 || response.status === 403 ? 'invalid' : 'unknown';
  } catch { return 'unknown'; }
}

async function writePrivate(path, text) {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, text, {encoding: 'utf8', mode: 0o600});
    await rename(temporary, path);
  } catch (error) { await rm(temporary, {force: true}).catch(() => {}); throw error; }
}

/** The same request without the player's identity: an anonymous conversation, so Convai creates no memory user for it
 * (and forms no long-term memory). `fresh` also drops the session id: an identified session belongs to the identity that
 * made it and cannot continue anonymously. */
export function withoutIdentity(config, {fresh = false} = {}) {
  if (!config || typeof config !== 'object') return config;
  const {endUserId, endUserMetadata, sessionId, ...rest} = config;
  return fresh || sessionId === undefined ? rest : {...rest, sessionId};
}

/** The host's recover(error, config) hook for a player's key: when Convai refuses a new memory user ("speaker limit"),
 * switch memory off for this key (once) and return the same request without an identity. Anything else, an anonymous
 * request, or the shared key returns nothing, so the failure surfaces as before. `classify(error)` is
 * classifyFailure from convai-quota.mjs; `onBlocked()` runs when memory was switched off by this call. */
export function memoryRecovery({keys, classify, onBlocked = () => {}}) {
  return (error, config) => {
    if (keys.source !== 'player' || classify(error) !== 'speaker' || config?.endUserId == null) return undefined;
    if (keys.blockMemory()) onBlocked();
    return withoutIdentity(config, {fresh: true});
  };
}

/** Which key conversations use. `requested` follows the setting and the saved key; `applied` is what connections use. */
export class ConvaiKeys {
  constructor({sharedKey, playerKeyPath, readText = path => readFile(path, 'utf8'), writeText = writePrivate,
    removeFile = path => rm(path, {force: true})} = {}) {
    if (typeof sharedKey !== 'string' || !sharedKey) throw Error('A conversation key is required');
    Object.assign(this, {sharedKey, playerKeyPath, readText, writeText, removeFile});
    this.player = null; this.preference = false;
    this.applied = {source: 'shared', key: sharedKey};
    // On a player's key whose plan has no room for another memory user (Convai's free plan allows one), conversations
    // run anonymously: no long-term memory, and no offered companion actions (those need an identified session).
    this.memoryBlocked = false; this.noticePending = false;
  }
  /** Returns true when this changed anything. Only a player's key can be limited this way. */
  blockMemory() {
    if (this.applied.source !== 'player' || this.memoryBlocked) return false;
    this.memoryBlocked = true; this.noticePending = true;
    return true;
  }
  unblockMemory() { const had = this.memoryBlocked; this.memoryBlocked = this.noticePending = false; return had; }
  /** 'memory-off' once after memory was switched off, so the game says so with the first reply that runs without it. */
  takeNotice() {
    if (!this.noticePending) return undefined;
    this.noticePending = false;
    return 'memory-off';
  }
  /** Reads the saved player key. A missing or malformed file means none. */
  async load() {
    this.player = null;
    if (!this.playerKeyPath) return this;
    try { this.player = parseKeyText(await this.readText(this.playerKeyPath)); } catch { /* none saved */ }
    return this;
  }
  setPreference(on) { const next = on === true, changed = next !== this.preference; this.preference = next; return changed; }
  get requested() {
    return this.preference && this.player ? {source: 'player', key: this.player} : {source: 'shared', key: this.sharedKey};
  }
  get pending() { return this.requested.key !== this.applied.key; }
  /** Adopts the requested key; call only at an idle boundary. Returns whether the key in use changed. */
  apply() {
    const changed = this.pending;
    this.applied = this.requested;
    if (changed) this.unblockMemory(); // a different key is a different plan
    return changed;
  }
  current() { return this.applied.key; }
  get source() { return this.applied.source; }
  /** A player key has a free plan's single-session allowance: one conversation connection at a time. */
  get singleSession() { return this.applied.source === 'player'; }
  /** Every value that must be scrubbed from reports. */
  secrets() { return [this.sharedKey, this.player].filter(Boolean); }
  get tail() { return keyTail(this.player); }
  async save(key) {
    await this.writeText(this.playerKeyPath, `api-key=${key}\n`);
    this.player = key;
  }
  async remove() { await this.removeFile(this.playerKeyPath); this.player = null; }
}

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseKeyCommand(raw, now = Date.now()) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 4096) return null;
  let value; try { value = JSON.parse(raw); } catch { return null; }
  if (!plain(value) || value.version !== 1 || !COMMAND_ID.test(value.id ?? '') || !['paste', 'clear'].includes(value.action)
      || !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0 || value.issuedAt > now + 5000) return null;
  return {id: value.id, action: value.action};
}

/** File IPC for the two settings actions (Paste Convai API key, Remove my Convai API key) and the status file the
 * settings page reads. The key itself never enters either file. */
export class OwnKeyControl {
  constructor({keys, commandPath, publish, quota, readClipboard = readClipboardText, validate = validateKey,
    read = path => readFile(path, 'utf8'), now = Date.now} = {}) {
    if (!keys || typeof commandPath !== 'string' || typeof publish !== 'function') throw Error('Invalid own key configuration');
    Object.assign(this, {keys, commandPath, publish, quota, readClipboard, validate, read, now});
    this.observed = ''; this.result = null; this.busy = false; this.writing = Promise.resolve();
  }
  /** Ignore a command left from an earlier session, then publish the first status. */
  async open() {
    this.observed = await this.read(this.commandPath).catch(() => '');
    await this.publishStatus();
    return this;
  }
  status() {
    const quota = this.quota?.snapshot() ?? null;
    return {version: 1, updated: this.now(), preference: this.keys.preference, saved: !!this.keys.player,
      tail: this.keys.tail, active: this.keys.source, pending: this.keys.pending, memory: this.keys.memoryBlocked ? 'off' : 'on',
      ...(this.result ? {result: this.result} : {}), ...(quota ? {limit: quota} : {})};
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
    if (command.action === 'clear') { await this.keys.remove(); this.quota?.clear(); return 'cleared'; }
    let text;
    try { text = await this.readClipboard(); } catch { return 'clipboard'; }
    if (typeof text !== 'string' || !text.trim()) return 'empty';
    const key = parseKeyText(text);
    if (!key) return 'not-a-key';
    if (await this.validate(key) === 'invalid') return 'invalid';
    await this.keys.save(key);
    this.quota?.clear();
    return 'saved';
  }
}
