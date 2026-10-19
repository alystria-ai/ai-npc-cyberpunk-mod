// The conversation provider (Convai, Mistral, the fully local AI or the player's custom OpenAI-compatible endpoint) and the player's Mistral API key
// (docs/MISTRAL.md, docs/LOCAL_AI.md, docs/CUSTOM_PROVIDER.md). The custom endpoint's own settings (address, key, model id) live in
// bridge/custom-endpoint.mjs; this class only asks it whether it is set up.
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

// Mode 0600 protects the file on Linux and macOS only. On Windows the file takes the permissions of its folder (the data folder under
// %LOCALAPPDATA%, open only to the player's account, SYSTEM and Administrators); a data folder kept in the game folder has the game folder's.
export async function writePrivate(path, text) {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, text, {encoding: 'utf8', mode: 0o600});
    await rename(temporary, path);
  } catch (error) { await rm(temporary, {force: true}).catch(() => {}); throw error; }
}

// A saved setting that names none of these (an old 'groq', which was removed on 2026-10-14) is the default, Convai.
export const PROVIDERS = Object.freeze(['convai', 'mistral', 'local', 'custom']);

/**
 * Which provider conversations use. `preference` follows the Conversation provider setting; Mistral is `requested` only
 * when a key is saved, and the custom provider only when its address and model id are saved (without them the setting falls back to Convai and
 * says so once); the local AI is `requested` unless it has
 * failed (not installed, not enough graphics memory, would not start), in which case Convai is used and one notice says so until
 * the setting is changed again (only while Convai can answer: with its free tier's day used up the turns stay on Local AI and fail with
 * Local AI's own reason, `localDown`); `applied` is what turns use. `active` means a text provider (Mistral or local) answers.
 */
export class MistralProvider {
  constructor({keyPath, readText = path => readFile(path, 'utf8'), writeText = writePrivate, removeFile = path => rm(path, {force: true}), inworld = null, custom = null} = {}) {
    Object.assign(this, {keyPath, readText, writeText, removeFile, inworld, custom});
    this.key = null; this.preference = 'convai'; this.applied = 'convai';
    this.noKeyPending = false; this.noSetupPending = false; this.voicePending = false; this.limit = null; this.sttAvailable = false;
    this.localTurnNoticePending = false; this.localModelNoticePending = false; this.localModelNoticeName = ''; this.lastNoticeModel = '';
    this.localBroken = null; this.localNoticePending = false; // why the local AI cannot be used (null: it can), and the one notice for it
    // May Convai take a turn now? The bridge sets this (false while the shared free tier's day is used up). A Local AI that cannot be used
    // hands its turns to Convai only while Convai can answer them; otherwise they stay on Local AI, whose failure names the real problem
    // instead of a Convai limit the player did not choose (2026-10-19 report: Local AI saved, the first turn showed the Convai daily limit).
    this.convaiAvailable = () => true;
    // The bridge holds the status file until its first settings poll has applied the saved provider, so the game never reads the defaults
    // (Convai) as the player's choice in the moment between the start and that poll.
    this.statusHeld = false;
    this.listeners = new Set();
    // What the player enters for the custom provider changes which provider is requested. A new address, key or model ID also ends what the
    // old one was refused for ("key not accepted", "out of credits", ...): the settings page stops saying so and summaries may run again.
    try {
      custom?.onChange?.(() => {
        if (this.applied === 'custom') this.limit = null;
        this.#changed();
      });
    } catch { /* an observer never breaks the provider */ }
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
      this.noKeyPending = next === 'mistral' && !this.key; this.noSetupPending = next === 'custom' && !this.custom?.ready; this.localBroken = null; this.localNoticePending = false; this.localModelNoticePending = false;
    }
    return changed;
  }
  /** The provider the setting asks for, given the key: Mistral only with a key. */
  get requested() {
    if (this.preference === 'mistral' && this.key) return 'mistral';
    if (this.preference === 'custom') return this.custom?.ready ? 'custom' : 'convai';
    // The local AI could not be used (pack missing, no room beside the voice, crashed): a cloud provider with a key answers, else Convai, but
    // only while Convai can take the turn (its free tier's day not used up); with nobody to take over the turns stay on Local AI and fail with its reason.
    if (this.preference === 'local') return !this.localBroken ? 'local' : this.key ? 'mistral' : this.#convaiOpen() ? 'convai' : 'local';
    return 'convai';
  }
  #convaiOpen() { try { return this.convaiAvailable() !== false; } catch { return true; } }
  /** Local AI is chosen and cannot answer (why: `localBroken`), and no other provider takes its turns: they fail with that reason. */
  get localDown() { return this.preference === 'local' && !!this.localBroken && this.requested === 'local'; }
  /** The game's notice code for a turn Local AI could not take: 'local-no-memory' (not enough free graphics memory) or 'local-unavailable'; undefined while it can. */
  get localFailureCode() { return !this.localBroken ? undefined : this.localBroken === 'low-memory' ? 'local-no-memory' : 'local-unavailable'; }
  /**
   * The game's notice code for a failed turn (`code`, what the failure alone says), corrected while Local AI is chosen and cannot start, so the
   * player hears Local AI's problem and never a Convai one: 'local-fallback' says a cloud provider takes over, untrue when none can (`localDown`),
   * and 'daily-limit' met by a turn that fell back to Convai would tell them to try the Local AI they already chose. Any other code is kept.
   */
  failureCode(code) {
    if (code === 'local-fallback' && this.localDown) return this.localFailureCode;
    if (code === 'daily-limit' && this.preference === 'local' && this.localBroken) return this.localFailureCode;
    return code;
  }
  get pending() { return this.requested !== this.applied; }
  /**
   * Neither the setting nor the provider in use is the local AI, so its model server has no job: the bridge unloads it (its graphics memory and RAM
   * go back to the game). False while the local AI answers turns, even when the player has just chosen another provider: the switch waits for an
   * idle boundary (apply) and unloads then.
   */
  get localUnused() { return this.preference !== 'local' && this.applied !== 'local'; }
  /** A text provider (Mistral, the local AI or the custom endpoint) answers turns, not Convai. */
  get active() { return this.applied !== 'convai'; }
  /** Which text route answers: 'mistral', 'local', 'custom' or (Convai) 'convai'. */
  get route() { return this.applied; }
  /** The local AI cannot be used (reason: 'not-installed', 'low-memory', 'mature-off', 'no-gpu', 'start-failed', 'crashed'): Convai takes over at the next idle boundary, with one notice. */
  noteLocalFailure(reason) {
    if (this.preference !== 'local') return;
    if (this.localBroken === (reason || 'start-failed')) return;
    this.localBroken = reason || 'start-failed'; this.localNoticePending = true;
    this.#changed();
  }
  /**
   * The reason the local AI could not be used has gone away (Mature content was turned on beside a Mature-only install): the local AI is the
   * requested provider again, taken at the next idle boundary, and the earlier failure's notice is dropped. Returns whether anything changed.
   */
  clearLocalFailure(reason) {
    if (this.preference !== 'local' || !this.localBroken || this.localBroken !== reason) return false;
    this.localBroken = null; this.localNoticePending = false;
    this.#changed();
    return true;
  }
  /**
   * One local turn could not be answered and the player's cloud provider answered it instead: the reply carries a notice
   * ('local-turn-fallback', once per call; the game limits how often it shows). The local AI stays the provider.
   */
  noteLocalTurnFallback() { if (this.applied === 'local') this.localTurnNoticePending = true; }
  /** The model the player chose for Local AI is missing, does not fit or did not start, and `model` (its name) was used instead: one notice ('local-model-fallback') with the next reply; `noticeModel` holds the name. */
  noteLocalModelFallback(model) { if (this.preference === 'local') { this.localModelNoticePending = true; this.localModelNoticeName = typeof model === 'string' ? model.slice(0, 80) : ''; } }
  /** The name of the model the 'local-model-fallback' notice just taken says was used, else ''. */
  get noticeModel() { return this.lastNoticeModel || ''; }
  /** Adopts the requested provider; call only at an idle boundary. Returns whether it changed. */
  apply() {
    const changed = this.pending;
    this.applied = this.requested;
    if (changed && this.applied !== 'convai') this.limit = null;
    if (changed && (this.applied === 'mistral' || this.applied === 'custom')) this.voicePending = true;
    // The custom provider was chosen but lost its address or model id (removed in Settings): Convai answers, and one notice says why.
    if (changed && this.applied === 'convai' && this.preference === 'custom' && !this.custom?.ready) this.noSetupPending = true;
    if (changed) this.#changed();
    return changed;
  }
  /** The key a request uses. Only the Mistral client ever receives it. */
  get apiKey() { return this.key; }
  get tail() { return keyTail(this.key); }
  /** Every value that must be scrubbed from reports. */
  secrets() { return [this.key, ...(this.custom?.secrets?.() ?? []), ...(this.inworld?.secrets?.() ?? [])].filter(Boolean); }
  noteLimit(kind) { this.limit = kind ? {kind, at: Date.now()} : null; this.#changed(); }
  noteSuccess() { if (this.limit) { this.limit = null; this.#changed(); } }
  /** 'mistral-no-key', 'mistral-voice', 'custom-no-setup', 'custom-voice', 'local-fallback' or 'local-turn-fallback' once each (the game shows them with the next reply), else undefined. */
  takeNotice({cloudVoice = false} = {}) {
    if (this.localNoticePending && this.applied !== 'local') { this.localNoticePending = false; return 'local-fallback'; }
    if (this.localModelNoticePending && this.applied === 'local') { this.localModelNoticePending = false; this.lastNoticeModel = this.localModelNoticeName || ''; return 'local-model-fallback'; }
    if (this.localTurnNoticePending) { this.localTurnNoticePending = false; return 'local-turn-fallback'; }
    if (this.noKeyPending && this.applied === 'convai') { this.noKeyPending = false; return 'mistral-no-key'; }
    if (this.noSetupPending && this.applied === 'convai') { this.noSetupPending = false; return 'custom-no-setup'; }
    if (this.voicePending && this.applied === 'mistral' && cloudVoice) { this.voicePending = false; return 'mistral-voice'; }
    if (this.voicePending && this.applied === 'custom' && cloudVoice) { this.voicePending = false; return 'custom-voice'; }
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
    read = path => readFile(path, 'utf8'), now = Date.now, localStatus, localReason,
    maturePack, localModels, localModelDefaults, localModelProblems, localDiagnostics, inworldCommandPath, validateInworld = validateInworldKey} = {}) {
    if (!provider || typeof commandPath !== 'string' || typeof publish !== 'function') throw Error('Invalid Mistral configuration');
    Object.assign(this, {provider, commandPath, publish, model, readClipboard, validate, read, now, localStatus, localReason, maturePack, localModels, localModelDefaults, localModelProblems, localDiagnostics, inworldCommandPath, validateInworld});
    this.observed = ''; this.result = null; this.busy = false; this.writing = Promise.resolve();
    this.inworldObserved = ''; this.inworldResult = null; this.inworldBusy = false;
  }
  /** Ignore a command left from an earlier session, then publish the first status. */
  async open() {
    this.observed = await this.read(this.commandPath).catch(() => '');
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
      // Why it failed, only 'mature-off' (a Mature-only install, or a server of the player's marked uncensored, with Mature content off): the page says what to do.
      ...(typeof this.localReason === 'function' && this.localReason() === 'mature-off' ? {localReason: 'mature-off'} : {}),
      // Is the optional Mature pack installed (bridge/mature-pack.mjs)? Only the Mature content help text reads it (it does not gate the setting).
      ...(typeof this.maturePack === 'function' ? {maturePack: this.maturePack() === true} : {}),
      // The installed Local AI chat models, [{id, name, sizeMiB}], for the model choice row (bridge/local-model-choice.mjs); names and sizes only, no paths.
      ...(typeof this.localModels === 'function' ? {localModels: this.localModels()} : {}),
      // Which of them the page shows as selected when no model was chosen yet (the largest that fits), and which one turning Mature content on
      // selects (the largest uncensored one that fits): ids, each only when there is such a model.
      ...(typeof this.localModelDefaults === 'function' ? (defaults => ({
        ...(defaults?.default ? {localModelDefault: defaults.default} : {}), ...(defaults?.mature ? {localModelMatureDefault: defaults.mature} : {})}))(this.localModelDefaults()) : {}),
      // Custom models that cannot be used, [{name, reason}] with reason 'missing' | 'bad-gguf' | 'embedding' | 'unreadable' (bridge/custom-models.mjs); only when there are some.
      ...(typeof this.localModelProblems === 'function' && this.localModelProblems().length ? {localModelProblems: this.localModelProblems()} : {}),
      // What the local model server loaded and how its turns went (bridge/local-llm-server.mjs diagnostics): file names, family, template length and hash, timings.
      // Only for the support report; the settings page does not read it. Never a path, a key or a word of a reply. Absent until a model was loaded.
      ...(typeof this.localDiagnostics === 'function' ? (diagnostics => (diagnostics ? {localDiagnostics: diagnostics} : {}))(this.localDiagnostics()) : {}),
      // Inworld (docs/CLOUD_VOICE_INWORLD.md): only the key status; never the key.
      ...(this.provider.inworld ? {inworld: {saved: !!this.provider.inworld.key, tail: this.provider.inworld.tail,
        ...(this.inworldResult ? {result: this.inworldResult} : {})}} : {})};
  }
  publishStatus() {
    // Held until the bridge's first settings poll (MistralProvider.statusHeld): the file keeps what the last session wrote meanwhile.
    if (this.provider.statusHeld === true) return this.writing;
    this.writing = this.writing.catch(() => {}).then(() => this.publish(this.status()));
    return this.writing;
  }
  async poll() {
    await this.pollMistral();
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
