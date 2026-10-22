// The Convai credential a conversation uses: the shared account's short-lived token from the sign-in backend (a release ships no key),
// a developer's own plain key, or the player's own key.
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
import {createHash, randomBytes} from 'node:crypto';

export const PLAYER_KEY_FILE = 'player-convai-key.txt';
// The end-user id adopted for the player's key (ConvaiKeys.adoptUser). Holds no key, only a one-way tag of it.
export const PLAYER_USER_FILE = 'player-convai-user.json';
// Convai keys are long opaque tokens; anything shorter, or containing a space, is not one.
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{15,199}$/;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

/** The key in a developer's plain `api-key=...` convai-key.txt, or null. A release before 0.2.9 packed its shared key into that file as
 * `convai-key-v1 ...`; that line is not read (and the Runtime's start removes such a file): the shared account is reached through the
 * sign-in backend now. Any length: the file is the developer's own. */
export function parseKeyFileText(text) {
  if (typeof text !== 'string' || text.length > 4096) return null;
  return /^api-key\s*=\s*(\S+)$/i.exec(text.replace(/^\uFEFF/, '').trim())?.[1] ?? null;
}

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

/** The memory users (end users) of the account behind `key`, most recently active first: [{id, lastActive}]. Read-only
 * (POST /user/end-users/list, not a conversation turn). Null when the list could not be read. */
export async function listEndUsers(key, {fetchImpl = globalThis.fetch, timeoutMs = 10000} = {}) {
  try {
    const users = [];
    let cursor = null;
    for (let page = 0; page < 5; page++) {
      const response = await fetchImpl('https://api.convai.com/user/end-users/list', {method: 'POST',
        headers: {'Content-Type': 'application/json', 'CONVAI-API-KEY': key},
        body: JSON.stringify(cursor ? {cursor} : {}), signal: AbortSignal.timeout(timeoutMs)});
      if (!response.ok) { try { await response.body?.cancel(); } catch { /* already closed */ } return null; }
      const body = await response.json();
      for (const row of Array.isArray(body?.end_users) ? body.end_users : []) {
        const id = row?.end_user_id;
        if (typeof id !== 'string' || !id.trim() || id.length > 256) continue;
        const stamps = [row.last_ltm_usage_ts, row.last_active_ts].map(value => Date.parse(`${value}Z`)).filter(Number.isFinite);
        users.push({id, lastActive: stamps.length ? Math.max(...stamps) : 0});
      }
      cursor = body?.has_more === true && typeof body.next_cursor === 'string' ? body.next_cursor : null;
      if (!cursor) break;
    }
    return users.sort((a, b) => b.lastActive - a.lastActive);
  } catch { return null; }
}

const keyTag = key => createHash('sha256').update('convai-player-user:' + key).digest('hex').slice(0, 32);

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
export function memoryRecovery({keys, classify, onBlocked = () => {}, onAdopted = () => {}, list}) {
  return async (error, config) => {
    if (keys.source !== 'player' || classify(error) !== 'speaker' || config?.endUserId == null) return undefined;
    // First choice: a memory user the account already has (Convai's free plan allows very few), reused for everything.
    const adopted = await keys.adoptUser({refused: config.endUserId, list}).catch(() => null);
    if (adopted) {
      onAdopted(adopted);
      const {sessionId, ...rest} = config; // an identified session belongs to the identity that made it
      return {...rest, endUserId: adopted};
    }
    if (keys.blockMemory()) onBlocked();
    return withoutIdentity(config, {fresh: true});
  };
}

/** Which credential conversations use. `requested` follows the setting and the saved key; `applied` is what connections use.
 * `sharedKey` is optional: a release has none, and the shared account is then reached only through `backend` (a TokenSource). With
 * neither, a conversation on the shared source fails with a plain notice (noCredentialError); a player's own key works either way. */
export class ConvaiKeys {
  constructor({sharedKey, playerKeyPath, playerUserPath, readText = path => readFile(path, 'utf8'), writeText = writePrivate,
    removeFile = path => rm(path, {force: true}), listUsers = listEndUsers, backend = null} = {}) {
    if (sharedKey != null && (typeof sharedKey !== 'string' || !sharedKey)) throw Error('The conversation key is not valid');
    sharedKey = sharedKey || null;
    // backend: a TokenSource (bridge/convai-credential.mjs) when the shared account is reached through the sign-in backend, else
    // null (the shared key, when there is one, is used directly). A player's own key never goes through it.
    Object.assign(this, {sharedKey, playerKeyPath, playerUserPath, readText, writeText, removeFile, listUsers, backend});
    this.player = null; this.preference = false;
    // The one end-user id every conversation on the player's key carries, once the account refused a new one and an
    // existing memory user was adopted (saved in playerUserPath, bound to the key). Null: the mod's own id is used.
    this.memoryUser = null; this.triedUsers = new Set(); this.userCandidates = null; this.adopting = null;
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
  /** The request as the player's key must send it: its adopted memory user replaces the mod's own end-user id (anonymous
   * requests and the shared key are left alone). */
  identify(config) {
    if (this.applied.source !== 'player' || !this.memoryUser || typeof config?.endUserId !== 'string'
        || config.endUserId === this.memoryUser) return config;
    return {...config, endUserId: this.memoryUser};
  }
  /** A reply was completed: a later refusal starts a fresh look at the account. */
  settled() { this.triedUsers.clear(); this.userCandidates = null; }
  /** After Convai refused `refused`: picks the next memory user of the account that was not tried yet, saves it as the
   * player's id for this key and returns it; null when there is none (or the list could not be read). Concurrent calls
   * share one lookup. Only a player's key adopts. */
  adoptUser({refused, list = this.listUsers} = {}) {
    if (this.applied.source !== 'player' || !this.player) return Promise.resolve(null);
    const key = this.player;
    this.adopting ??= (async () => {
      try {
        if (typeof refused === 'string') this.triedUsers.add(refused);
        if (refused === this.memoryUser) await this.#dropUser();
        this.userCandidates ??= (await list(key))?.toSorted((a, b) => b.lastActive - a.lastActive) ?? null;
        if (key !== this.player || this.applied.key !== key) return null;
        const next = (this.userCandidates ?? []).find(user => !this.triedUsers.has(user.id));
        if (!next) return null;
        this.triedUsers.add(next.id);
        this.memoryUser = next.id;
        if (this.playerUserPath) {
          await this.writeText(this.playerUserPath, JSON.stringify({version: 1, tag: keyTag(key), endUserId: next.id}) + '\n').catch(() => {});
        }
        return next.id;
      } finally { this.adopting = null; }
    })();
    return this.adopting;
  }
  async #dropUser() {
    this.memoryUser = null;
    if (this.playerUserPath) await this.removeFile(this.playerUserPath).catch(() => {});
  }
  /** Reads the saved player key and its adopted memory user. A missing or malformed file means none. */
  async load() {
    this.player = null; this.memoryUser = null; this.settled();
    if (!this.playerKeyPath) return this;
    try { this.player = parseKeyText(await this.readText(this.playerKeyPath)); } catch { /* none saved */ }
    if (this.player && this.playerUserPath) {
      try {
        const saved = JSON.parse(await this.readText(this.playerUserPath));
        if (saved?.version === 1 && saved.tag === keyTag(this.player) && typeof saved.endUserId === 'string'
            && saved.endUserId.trim() && saved.endUserId.length <= 256) this.memoryUser = saved.endUserId;
      } catch { /* none adopted */ }
    }
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
  /** True while conversations on the shared account sign in through the backend (the key-only calls leave the runtime). */
  get usesBackend() { return !!this.backend && this.applied.source === 'shared'; }
  /** The failure for a conversation on the shared source with no key and no backend (a damaged package): one plain notice, never a hang.
   * The marker makes bridge/convai-quota.mjs classify it like a failed sign-in. */
  noCredentialError() { return Error('Convai sign-in is not set up on this installation [convai-auth:none]'); }
  /** What a call to Convai must authenticate with right now: {authToken} or {apiKey}. Synchronous when a token is held, which is
   * the normal case; otherwise it waits only for the first fetch of this run (at most four seconds), never for a retry. Throws when
   * the backend refuses, or is unreachable and no fallback key may stand in, or there is neither a key nor a backend. */
  async credential() {
    if (!this.usesBackend) {
      if (!this.applied.key) throw this.noCredentialError();
      return {apiKey: this.applied.key};
    }
    const source = this.backend;
    let held = source.current();
    if (!held) { await source.ready(); held = source.current(); }
    if (held) return {authToken: held.token};
    if (this.sharedKey && source.fallbackAllowed()) { source.noteFallbackUse(); return {apiKey: this.applied.key}; }
    throw source.unavailableError();
  }
  /** `config` as it must be sent to Convai: with `authToken` (and no `key`) in backend mode, unchanged otherwise. */
  async credentialFor(config) {
    if (!this.usesBackend) {
      if (!this.applied.key) throw this.noCredentialError();
      return config;
    }
    const credential = await this.credential();
    if (!credential.authToken) return config;
    const {key, ...rest} = config;
    return {...rest, authToken: credential.authToken};
  }
  /** Throws the daily-limit failure while the backend says this installation's day is used up. */
  assertAllowed() { if (this.usesBackend) this.backend.assertAllowed(); }
  get source() { return this.applied.source; }
  /** A player key has a free plan's single-session allowance: one conversation connection at a time. */
  get singleSession() { return this.applied.source === 'player'; }
  /** Every value that must be scrubbed from reports. */
  secrets() { return [this.sharedKey, this.player, ...(this.backend?.secrets() ?? [])].filter(Boolean); }
  get tail() { return keyTail(this.player); }
  async save(key) {
    await this.writeText(this.playerKeyPath, `api-key=${key}\n`);
    if (key !== this.player) await this.#dropUser(); // another key is another account
    this.player = key; this.settled();
  }
  async remove() { await this.removeFile(this.playerKeyPath); this.player = null; await this.#dropUser(); this.settled(); }
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
  // daily: the shared key's SharedKeyGuard (its snapshot() is published as `daily` while the shared key is in use).
  constructor({keys, commandPath, publish, quota, daily, readClipboard = readClipboardText, validate = validateKey,
    read = path => readFile(path, 'utf8'), now = Date.now} = {}) {
    if (!keys || typeof commandPath !== 'string' || typeof publish !== 'function') throw Error('Invalid own key configuration');
    Object.assign(this, {keys, commandPath, publish, quota, daily, readClipboard, validate, read, now});
    this.observed = ''; this.result = null; this.busy = false; this.writing = Promise.resolve();
  }
  /** Ignore a command left from an earlier session, then publish the first status. */
  async open() {
    this.observed = await this.read(this.commandPath).catch(() => '');
    await this.publishStatus();
    return this;
  }
  status() {
    const quota = this.quota?.snapshot() ?? null, daily = this.daily?.snapshot() ?? null;
    return {version: 1, updated: this.now(), preference: this.keys.preference, saved: !!this.keys.player,
      tail: this.keys.tail, active: this.keys.source, pending: this.keys.pending, memory: this.keys.memoryBlocked ? 'off' : 'on',
      ...(this.result ? {result: this.result} : {}), ...(quota ? {limit: quota} : {}),
      ...(daily ? {daily} : {})};
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
