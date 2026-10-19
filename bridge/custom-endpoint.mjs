// The "Custom (OpenAI-compatible)" conversation provider's settings (docs/CUSTOM_PROVIDER.md): the address, the API key and the model id of any
// OpenAI-style chat-completions endpoint (OpenRouter, Nano-GPT, a server such as Ollama or LM Studio on the player's own computer).
//
// Nothing here talks to a model. This module keeps what the player entered, the same way the Mistral key is kept (bridge/mistral-key.mjs):
//   - saved only in this bridge's state folder, in ONE small file, `player-custom-endpoint.txt` (lines `endpoint=`, `model=`, `api-key=`; the
//     key line is optional), written with mode 0600 through a temporary file; never in the game folder, settings.json, a status file or a log;
//   - entered from the clipboard by three commands of the settings page (paste URL, paste key, paste model id; the game writes
//     runtime/custom-provider-command.json, the bridge reads the clipboard), each checked for its shape and then saved; or written into the
//     file by hand (read when the bridge starts, and again at Test connection and when the provider is chosen);
//   - published to the settings page as runtime/custom-provider-state.json: the host (never a path or a query), the model id, whether a key is
//     saved and its last four characters (only for a key of 16 or more characters). The key itself never leaves this module except as the
//     Authorization header of a request to its own endpoint (bridge/mistral-client.mjs, `provider: 'custom'`).
// "Test connection" sends one tiny request, the only request this module makes, and only when the player presses the button.
import {readFile, rm} from 'node:fs/promises';
import {writePrivate, keyTail} from './mistral-key.mjs';
import {readClipboardText} from './convai-key.mjs';
import {checkEndpoint, hostKind} from './custom-models.mjs';
import {streamChat, MistralError, failureKind} from './mistral-client.mjs';

export const CUSTOM_FILE = 'player-custom-endpoint.txt';
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
export const COMMANDS = Object.freeze(['paste-url', 'paste-key', 'paste-model', 'clear-url', 'clear-key', 'clear-model', 'test']);
// Only OpenRouter gets its two optional attribution headers (https://openrouter.ai/docs: HTTP-Referer, X-Title). Never any other host.
export const OPENROUTER_HOST = 'openrouter.ai';
export const OPENROUTER_HEADERS = Object.freeze({'HTTP-Referer': 'https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs', 'X-Title': 'AI NPC Cyberpunk Mod'});

const unquote = value => value.replace(/^["'`<]+|["'`>]+$/g, '');

/**
 * The address in a file's text (`endpoint=...`) or a pasted value: {endpoint, origin, host, kind, secure} or {reason}. `endpoint` is the base
 * (no trailing slash; a pasted `.../chat/completions` is cut back to its base; no path means /v1) the requests go to; `host` includes a port that is not
 * the default. Reasons: empty, long, not-a-url, scheme (no http:// or https://), insecure (http:// to a host that is not this computer or the home
 * network), extras (a user name, a query or a #fragment: a key must not travel in an address).
 */
export function parseEndpointUrl(text) {
  if (typeof text !== 'string') return {reason: 'empty'};
  let value = text.replace(/^﻿/, '').trim();
  const labelled = /^(?:endpoint|base[-_ ]?url|api[-_ ]?base|url)\s*[=:]\s*(\S+)$/i.exec(value);
  if (labelled) value = labelled[1];
  value = unquote(value);
  if (!value) return {reason: 'empty'};
  if (value.length > 300) return {reason: 'long'};
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return {reason: 'not-a-url'};
  if (!/^https?:\/\//i.test(value)) return {reason: /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[\w.-]+(?::\d+)?(?:\/|$)/.test(value) ? 'scheme' : 'not-a-url'};
  const base = value.replace(/\/chat\/completions\/?$/i, '');
  const checked = checkEndpoint(base, {remote: true});
  if (checked.error) {
    const reason = /user name or password|query or a #fragment/.test(checked.error) ? 'extras' : /must use https/.test(checked.error) ? 'insecure'
      : /must start with/.test(checked.error) ? 'scheme' : 'not-a-url';
    return {reason};
  }
  const url = new URL(checked.endpoint);
  return {endpoint: checked.endpoint, origin: checked.origin, host: url.host, hostname: url.hostname, kind: checked.kind, secure: url.protocol === 'https:'};
}

/** The API key in a pasted value (`api-key=...`, `Bearer ...` or the bare value). Null when it is not a plausible key: one run of printable characters, 8 to 512. */
export function parseCustomKey(text) {
  if (typeof text !== 'string' || text.length > 4096) return null;
  let value = text.replace(/^﻿/, '').trim();
  const labelled = /^(?:api[-_ ]?key|key|token)\s*[=:]\s*(\S+)$/i.exec(value);
  if (labelled) value = labelled[1];
  value = value.replace(/^bearer\s+(?=\S+$)/i, '');
  value = unquote(value);
  return /^[\x21-\x7e]{8,512}$/.test(value) && !/["'`\\<>]/.test(value) && !/^https?:\/\//i.test(value) ? value : null;
}

/** A model id (`model=...` or the bare value): letters, digits and . _ : / @ + -, at most 120. OpenRouter's `vendor/name:free` and Ollama's `name:tag` fit. */
export function parseModelId(text) {
  if (typeof text !== 'string') return null;
  let value = text.replace(/^﻿/, '').trim();
  const labelled = /^(?:model(?:[-_ ]?id)?)\s*[=:]\s*(\S+)$/i.exec(value);
  if (labelled) value = labelled[1];
  value = unquote(value);
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/.test(value) && !/^https?:\/\//i.test(value) ? value : null;
}

/**
 * The file's lines. Order does not matter, `#` starts a comment, a field that is not valid is left out and named in `problems` (never its value).
 * Returns {endpoint, model, key, problems}.
 */
export function parseCustomFile(text) {
  const out = {endpoint: null, model: null, key: null, problems: []};
  if (typeof text !== 'string' || text.length > 16384) return out;
  for (const raw of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_-]+)\s*[=:]\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1].toLowerCase().replace(/_/g, '-'), value = match[2];
    if (['endpoint', 'url', 'base-url', 'baseurl', 'api-base'].includes(name)) {
      const parsed = parseEndpointUrl(value);
      if (parsed.endpoint) out.endpoint = parsed; else out.problems.push(`endpoint (${parsed.reason})`);
    } else if (['model', 'model-id', 'modelid'].includes(name)) {
      const parsed = parseModelId(value);
      if (parsed) out.model = parsed; else out.problems.push('model');
    } else if (['api-key', 'apikey', 'key'].includes(name)) {
      const parsed = parseCustomKey(value);
      if (parsed) out.key = parsed; else out.problems.push('api-key');
    }
  }
  return out;
}

/** The file's text for what is saved (no line for what is not). */
export function formatCustomFile({endpoint, model, key}) {
  return ['# AI NPC Cyberpunk Mod: Custom (OpenAI-compatible) provider. Saved by Settings; you can also edit it by hand.',
    ...(endpoint ? [`endpoint=${endpoint}`] : []), ...(model ? [`model=${model}`] : []), ...(key ? [`api-key=${key}`] : [])].join('\n') + '\n';
}

export class CustomEndpoint {
  constructor({path, readText = file => readFile(file, 'utf8'), writeText = writePrivate, removeFile = file => rm(file, {force: true}), log = () => {}} = {}) {
    Object.assign(this, {path, readText, writeText, removeFile, log});
    this.address = null; this.model = null; this.key = null;
    this.listeners = new Set(); this.writing = Promise.resolve();
  }
  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  #changed() { for (const listener of this.listeners) { try { listener(); } catch { /* an observer never breaks the settings */ } } }

  /** Reads the file. A missing or unreadable file means nothing is saved; a field that is not valid is left out and named in the log (never its value). */
  async load() {
    if (!this.path) return this;   // nothing is stored (a test): what was set stays
    let parsed = {endpoint: null, model: null, key: null, problems: []};
    try { parsed = parseCustomFile(await this.readText(this.path)); } catch { /* nothing saved */ }
    if (parsed.problems.length) this.log(`${CUSTOM_FILE}: ignored ${parsed.problems.join(', ')}`);
    const before = JSON.stringify([this.address?.endpoint, this.model, !!this.key, this.key?.slice(-4)]);
    this.address = parsed.endpoint; this.model = parsed.model; this.key = parsed.key;
    if (before !== JSON.stringify([this.address?.endpoint, this.model, !!this.key, this.key?.slice(-4)])) this.#changed();
    return this;
  }

  /** The address and the model id are both saved: the provider can answer (the key is optional). */
  get ready() { return !!(this.address && this.model); }
  /** Where a chat request goes. */
  get chatUrl() { return this.address ? this.address.endpoint + '/chat/completions' : null; }
  /** The only origin the key may go to. */
  get origin() { return this.address?.origin ?? null; }
  get host() { return this.address?.host ?? null; }
  get secure() { return this.address?.secure === true; }
  /** The host is this computer or the home network (a server the player runs): no TLS to warm, one request at a time, a long wait for a model to load. */
  get local() { return !!this.address && this.address.kind !== 'remote'; }
  /** The https origin whose connection is worth opening ahead of the first turn, or null. */
  get warmOrigin() { return this.address && this.secure && !this.local ? this.address.origin : null; }
  get tail() { return keyTail(this.key); }
  /** OpenRouter's two optional headers, for OpenRouter only. */
  get extraHeaders() { return this.address?.secure && this.address.hostname === OPENROUTER_HOST ? OPENROUTER_HEADERS : undefined; }
  secrets() { return [this.key].filter(Boolean); }

  // One write at a time, the file always holding the whole of what is saved.
  #persist() {
    const save = async () => {
      if (!this.path) return;   // nothing is stored (a test)
      if (!this.address && !this.model && !this.key) { await this.removeFile(this.path); return; }
      await this.writeText(this.path, formatCustomFile({endpoint: this.address?.endpoint, model: this.model, key: this.key}));
    };
    this.writing = this.writing.catch(() => {}).then(save);
    return this.writing;
  }
  async #set(field, value) {
    const was = this[field];
    this[field] = value;
    try { await this.#persist(); } catch (error) { this[field] = was; throw error; }
    this.#changed();
  }
  async setUrl(address) { await this.#set('address', address); }
  async setModel(model) { await this.#set('model', model); }
  async setKey(key) { await this.#set('key', key); }
  async clearUrl() { await this.#set('address', null); }
  async clearModel() { await this.#set('model', null); }
  async clearKey() { await this.#set('key', null); }
}

// ---- Test connection ----------------------------------------------------------------------------------------------------------

const clip = (value, size) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, size) : '';

/** How a failed request is told to the player: the code the settings page has a sentence for, the status, the wait the server asked for and its own words. */
export function describeFailure(error) {
  if (!(error instanceof MistralError)) return {code: 'unreachable', detail: clip(error?.message, 160) || undefined};
  const kind = failureKind(error);
  const detail = clip(error.providerText ?? error.detail, 160) || undefined;
  const status = Number.isInteger(error.status) ? error.status : undefined;
  if (kind === 'key') return {code: 'key', status, detail};
  if (kind === 'credits') return {code: 'credits', status, detail};
  if (kind === 'model') return {code: 'model', status, detail};
  if (kind === 'limit') return {code: 'limit', status, ...(error.retryAfterMs > 0 ? {waitS: Math.max(1, Math.ceil(error.retryAfterMs / 1000))} : {}), detail};
  if (kind === 'empty') return {code: 'empty', detail};
  if (kind === 'network') {
    if (error.redirect) return {code: 'redirect', detail};
    if (status >= 500) return {code: 'server', status, detail};
    return {code: error.slow || /in time|went quiet/.test(error.message) ? 'timeout' : 'unreachable', detail};
  }
  return {code: 'request', status, detail};
}

/**
 * One tiny request to the saved endpoint with the saved model and key, through the same client every turn uses. Resolves
 * {state: 'ok', ms} or {state: 'failed', code, status?, waitS?, detail?, ms}; never throws and never carries the key.
 *   chat       the request function (streamChat; replaced in tests)
 *   adapt      the route's remembered refusals, when the caller has them (a refusal learned here is then known to the turns)
 */
export async function testConnection(custom, {chat = streamChat, adapt, fetchImpl, now = () => performance.now()} = {}) {
  if (!custom?.ready) return {state: 'failed', code: 'no-setup', ms: 0};
  const began = now();
  try {
    await chat({apiKey: custom.key ?? undefined, model: custom.model, provider: 'custom', endpoint: custom.chatUrl, trustedOrigin: custom.origin,
      headers: custom.extraHeaders, ...(adapt ? {adapt} : {}), ...(fetchImpl ? {fetchImpl} : {}),
      messages: [{role: 'system', content: 'You are a connection test. Reply with the single word OK.'}, {role: 'user', content: 'Test.'}],
      maxTokens: 24, temperature: 0, retries: 0, firstByteMs: custom.local ? 60000 : 25000, totalMs: custom.local ? 90000 : 35000});
    return {state: 'ok', ms: Math.round(now() - began)};
  } catch (error) {
    return {state: 'failed', ...describeFailure(error), ms: Math.round(now() - began)};
  }
}

// ---- The settings page's commands and status -----------------------------------------------------------------------------------

/** A command is {version: 1, id, action, issuedAt}; anything else (including a half-written file) is null. */
export function parseCustomCommand(raw, now = Date.now()) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 4096) return null;
  let value; try { value = JSON.parse(raw); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !COMMAND_ID.test(value.id ?? '')
      || !COMMANDS.includes(value.action) || !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0 || value.issuedAt > now + 5000) return null;
  return {id: value.id, action: value.action};
}

const FIELD_OF = {'paste-url': 'url', 'clear-url': 'url', 'paste-key': 'key', 'clear-key': 'key', 'paste-model': 'model', 'clear-model': 'model'};
const LIMITS = new Set(['rate', 'invalid', 'model', 'credits']);

/**
 * File IPC for the settings page's commands and the status file it reads (runtime/custom-provider-state.json). The key itself never enters
 * either file. Every paste is checked for its shape (nothing is sent anywhere); only `test` makes a request, and it runs in the background so
 * the settings poll never waits for it.
 */
export class CustomControl {
  constructor({custom, provider, commandPath, publish, readClipboard = readClipboardText, test, read = file => readFile(file, 'utf8'), now = Date.now,
    log = () => {}} = {}) {
    if (!custom || typeof commandPath !== 'string' || typeof publish !== 'function') throw Error('Invalid custom provider configuration');
    Object.assign(this, {custom, provider, commandPath, publish, readClipboard, read, now, log});
    this.test = test ?? (() => testConnection(custom));
    this.observed = ''; this.result = null; this.testResult = null; this.busy = false; this.testing = false; this.writing = Promise.resolve();
  }
  /** Ignore a command left from an earlier session, then publish the first status. */
  async open() {
    this.observed = await this.read(this.commandPath).catch(() => '');
    await this.publishStatus();
    return this;
  }
  status() {
    const c = this.custom, limit = this.provider?.applied === 'custom' ? this.provider.limit?.kind : null;
    return {version: 1, updated: this.now(), ready: c.ready, host: c.host, secure: c.secure, local: c.local, model: c.model,
      keySaved: !!c.key, tail: c.tail, ...(this.result ? {result: this.result} : {}), ...(this.testResult ? {test: this.testResult} : {}),
      limit: LIMITS.has(limit) ? limit : null};
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
    const command = parseCustomCommand(raw, this.now());
    if (!command) return;
    this.busy = true;
    try {
      if (command.action === 'test') { await this.#startTest(command); return; }
      this.result = {id: command.id, field: FIELD_OF[command.action], state: 'checking'};
      await this.publishStatus();
      this.result = {id: command.id, field: FIELD_OF[command.action], ...await this.run(command)};
    } catch { this.result = {id: command.id, field: FIELD_OF[command.action], state: 'failed'}; }
    finally { this.busy = false; }
    await this.publishStatus();
  }
  /** One command that changes what is saved: {state: 'saved' | 'cleared' | 'invalid' | 'unreadable', reason?}. */
  async run({action}) {
    const c = this.custom;
    if (action === 'clear-url') { await c.clearUrl(); this.testResult = null; return {state: 'cleared'}; }
    if (action === 'clear-key') { await c.clearKey(); this.testResult = null; return {state: 'cleared'}; }
    if (action === 'clear-model') { await c.clearModel(); this.testResult = null; return {state: 'cleared'}; }
    let text;
    try { text = await this.readClipboard(); } catch { return {state: 'unreadable'}; }
    if (typeof text !== 'string' || !text.trim()) return {state: 'invalid', reason: 'empty'};
    this.testResult = null;
    if (action === 'paste-url') {
      const parsed = parseEndpointUrl(text);
      if (!parsed.endpoint) return {state: 'invalid', reason: parsed.reason};
      await c.setUrl(parsed);
      return {state: 'saved'};
    }
    if (action === 'paste-key') {
      const key = parseCustomKey(text);
      if (!key) return {state: 'invalid', reason: 'not-a-key'};
      await c.setKey(key);
      return {state: 'saved'};
    }
    const model = parseModelId(text);
    if (!model) return {state: 'invalid', reason: 'not-a-model'};
    await c.setModel(model);
    return {state: 'saved'};
  }
  // The request itself runs after the poll has returned: the settings poll also applies the provider, and must not wait up to 30 s for a server.
  async #startTest(command) {
    if (this.testing) return;
    this.testing = true;
    // A file edited by hand is read again before the test.
    await this.custom.load().catch(() => {});
    this.testResult = {id: command.id, state: 'testing'};
    await this.publishStatus();
    void (async () => {
      let outcome;
      try { outcome = await this.test(); } catch { outcome = {state: 'failed', code: 'unreachable'}; }
      this.testResult = {id: command.id, ...outcome};
      this.log(`Test connection: ${outcome.state}${outcome.code ? ` (${outcome.code}${outcome.status ? ` ${outcome.status}` : ''})` : ''}`);
      this.testing = false;
      await this.publishStatus().catch(() => {});
    })();
  }
}
