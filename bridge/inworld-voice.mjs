// The Inworld cloud voice (docs/CLOUD_VOICE_INWORLD.md): an optional Companion voice that speaks a reply with Inworld's text-to-speech
// (`inworld-tts-2`), in a voice cloned from the character's own reference clip (the same clips the Mistral cloud voice and
// OmniVoice use), on the player's own Inworld key. It works with any conversation provider, because it only needs the key.
//
// It speaks through the same interface as Pocket TTS and the Mistral cloud voice: `synthesizeStream(voiceKey, text, {signal, onPcm,
// emotion})` hands `onPcm` packets of 24 kHz mono float32 audio, so the written reply, the subtitles, the lip sync and the facial model
// (all driven by those packets) are the Pocket path unchanged. The packets carry Pocket's transport marker (`engine: 'pocket-tts'`);
// `timing.voiceEngine` says the audio really came from Inworld.
//
// How it differs from the Mistral voice (bridge/voxtral-voice.mjs):
//  - Inworld keeps a cloned voice, so a character is cloned ONCE: the reference clip is uploaded, the answer is a voice id, and every
//    reply after that sends only the id. The id is kept per character in a small file (player-inworld-voices.json in the bridge's state
//    folder) and in memory; the account itself is the source of truth (the voice is named `cp2077-companion-<character>-<hash of the
//    clip>`, so a lost file is rebuilt from the account's voice list rather than by cloning again).
//  - Cloning is limited to 2 requests a minute on the free plan, so clones go one at a time and never faster than that. The first
//    reply of a character whose voice is not ready yet is spoken by Pocket (whole), and the voice is made in the background (warm-up
//    starts it when the character is prepared).
//  - Streaming is newline-delimited JSON with base64 16-bit PCM; the adapter converts it to float32 and cuts it into 100 ms packets.
//  - Emotion: the marks of Expressive emotions become steering instructions (bridge/inworld-steering.mjs).
//  - One request per reply part, never two voices inside one reply: a failure before any audio reached the player is thrown as an
//    InworldError and the caller (bridge/voice-selection.mjs) speaks the whole reply with Pocket; once audio is playing a later
//    failure ends that part's audio early (the written reply is complete). It is never handed to Pocket (bridge/voice-utterance.mjs).
//  - The key goes only in the Authorization header of a request to api.inworld.ai; it is never logged or written to a state file.
//    Messages pass through `redact`.
import {createHash, randomBytes} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {cancelled, throwIfCancelled} from './transport-pool.mjs';
import {VoxtralVoice} from './voxtral-voice.mjs';
import {steerText, fallbackMarks} from './inworld-steering.mjs';
import {INWORLD_VOICES_ENDPOINT} from './inworld-key.mjs';

export const INWORLD_ENDPOINTS = Object.freeze({
  speech: 'https://api.inworld.ai/tts/v1/voice:stream',
  clone: 'https://api.inworld.ai/voices/v1/voices:clone',
  voices: INWORLD_VOICES_ENDPOINT,
});
export const INWORLD_MODEL = 'inworld-tts-2';
export const INWORLD_RATE = 24000;
export const VOICE_NAME_PREFIX = 'cp2077-companion-';
export const INWORLD_LIMITS = Object.freeze({
  firstAudioMs: 5000,         // no audio this long after the request was sent: Pocket speaks this reply
  stallMs: 8000,              // silence this long inside a running stream ends it
  maxChars: 4000,             // longer text goes to Pocket (Inworld's limit for one streaming request)
  frameSamples: 2400,         // 100 ms packets, the size Pocket's own packets are in the same range
  maxReferenceSeconds: 25,    // a longer clip is cut (Inworld takes up to 30 s)
  maxReferenceBytes: 6_000_000,
  cloneWaitMs: 3000,          // a reply waits this long for a voice that is being made; after that Pocket speaks it
  clonesPerMinute: 2,         // the free plan's limit for cloning
  cloneTimeoutMs: 40_000,
  listTimeoutMs: 15_000,
  cloneRetryMs: 10 * 60_000,  // a clip Inworld refused is not offered again for this long
  cloneBusyRetryMs: 65_000,   // after a 429 on cloning
  cloneFaultRetryMs: 30_000,  // after a network error or a server fault on cloning
  limitCooldownMs: 20_000,    // after a 429 on speech, no request for the server's Retry-After (this when it names none, at most 60 s)
  keyCooldownMs: 60_000,      // after the key was refused
  quotaCooldownMs: 30 * 60_000, // after the plan said its free allowance or credit is used up
  listPages: 8,
});
const MODEL_ID = createHash('sha256').update(INWORLD_MODEL).digest('hex');
// A key's Base64 text and anything else that long and shaped like one.
const KEY_SHAPE = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
const SAFE_NAME = /[^a-z0-9-]+/g;
// gRPC status codes inside a stream or an error body (Inworld answers HTTP 200 and then an error line).
const GRPC = Object.freeze({invalid: 3, notFound: 5, permission: 7, exhausted: 8, unavailable: 14, unauthenticated: 16});

/** Text with the key (when given) and anything shaped like one removed. */
export const redact = (text, apiKey) => {
  let out = String(text ?? '');
  if (typeof apiKey === 'string' && apiKey.length >= 8) out = out.split(apiKey).join('[key]');
  return out.replace(KEY_SHAPE, '[key]');
};

/**
 * kind: 'no-key', 'no-reference' (no clip for this character), 'voice' (the character's voice is not ready: being made, or not
 * makeable now), 'key' (refused), 'limit' (429), 'quota' (the plan's free allowance or credit is used up), 'timeout' (no first audio
 * in time), 'network' (unreachable, a server fault or a stalled stream), 'request' (a refused request or an unusable answer),
 * 'text' (not speakable). Always thrown before any audio reached `onPcm` (or by the consumer itself, marked `sink`).
 */
export class InworldError extends Error {
  constructor(kind, detail, {status, retryAfterMs, apiKey} = {}) {
    super(`Inworld ${redact(detail, apiKey).slice(0, 200)} [inworld:${kind}]`);
    this.name = 'InworldError';
    Object.assign(this, {kind, status, retryAfterMs});
  }
}

const retryAfter = headers => {
  const raw = headers?.get?.('retry-after');
  const seconds = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 60) * 1000 : undefined;
};
const QUOTA_WORDS = /\b(quota|credits?|balance|billing|insufficient|exhausted|free (?:tier|plan|minutes|allowance)|payment|subscription)\b/i;
const MISSING_VOICE = /\b(voice)\b.*\b(not found|does not exist|unknown|invalid)\b|\b(not found|does not exist)\b.*\bvoice\b/i;

/** The message of an Inworld error body (`{"error":{"code","message"}}` or `{"code","message"}`) as text, or the text itself. */
export function errorMessage(body) {
  if (typeof body !== 'string' || !body) return '';
  try {
    const value = JSON.parse(body);
    return String(value?.error?.message ?? value?.message ?? '');
  } catch { return body.slice(0, 160); }
}

/** Maps an HTTP status (and the answer's text) to an InworldError. */
export function mapStatus(status, body, {headers, apiKey} = {}) {
  const message = errorMessage(body);
  const detail = message ? message.slice(0, 160) : `HTTP ${status}`;
  const options = {status, retryAfterMs: retryAfter(headers), apiKey};
  if (status === 402 || ((status === 403 || status === 429) && QUOTA_WORDS.test(message))) return new InworldError('quota', detail, options);
  if (status === 401 || status === 403) return new InworldError('key', 'did not accept the key', options);
  if (status === 404 || (status === 400 && MISSING_VOICE.test(message))) return new InworldError('voice-missing', detail, options);
  if (status === 429) return new InworldError('limit', 'rate limited', options);
  if (status === 408 || status >= 500) return new InworldError('network', detail, options);
  return new InworldError('request', detail, options);
}

/** Maps an error line inside a stream (HTTP 200 first, then `{"error":{"code":N,"message":...}}`). */
export function mapStreamError(error, {apiKey} = {}) {
  const code = Number(error?.code), message = String(error?.message ?? 'reported an error');
  if (QUOTA_WORDS.test(message) && code !== GRPC.invalid) return new InworldError('quota', message, {apiKey});
  if (code === GRPC.permission || code === GRPC.unauthenticated) return new InworldError('key', 'did not accept the key', {apiKey});
  if (code === GRPC.exhausted) return new InworldError('limit', message, {apiKey});
  if (code === GRPC.unavailable) return new InworldError('network', message, {apiKey});
  if (code === GRPC.notFound || MISSING_VOICE.test(message)) return new InworldError('voice-missing', message, {apiKey});
  return new InworldError('request', message, {apiKey});
}

/** Yields each complete JSON line of a byte stream (newline-delimited JSON; the last line may have no newline). Lines that are not JSON are skipped. */
export async function* ndjson(body) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const parse = line => { const trimmed = line.trim(); if (!trimmed) return undefined; try { return JSON.parse(trimmed); } catch { return undefined; } };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, {stream: true});
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const value = parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      if (value !== undefined) yield value;
    }
  }
  buffer += decoder.decode();
  const value = parse(buffer);
  if (value !== undefined) yield value;
}

/** The name the voice of a character is stored under in the account. */
export const voiceDisplayName = (key, referenceHash) =>
  `${VOICE_NAME_PREFIX}${String(key).toLowerCase().replace(SAFE_NAME, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'voice'}-${String(referenceHash).slice(0, 8)}`;

const fingerprint = text => createHash('sha256').update(String(text)).digest('hex');

async function writeAtomic(path, text) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try { await writeFile(temporary, text, 'utf8'); await rename(temporary, path); }
  catch (error) { await rm(temporary, {force: true}).catch(() => {}); throw error; }
}

export class InworldVoice {
  /**
   * getKey: () => the Inworld key or null. referenceRoot / registry: as for VoxtralVoice (the folder 'runtime/voice-references/' maps
   * to; an ordered list of voice registries, set later with setReferences). storePath: the file the voice ids are kept in.
   * onChange: called when the voice becomes degraded or recovers. library: replaces the reference reader (tests).
   * fetchImpl, readText, writeText, setTimer, clearTimer, now, clock, endpoints, limits: for tests.
   */
  constructor({getKey, referenceRoot, registry, library, storePath, onChange = () => {}, onLog = () => {}, fetchImpl = globalThis.fetch,
    readText = path => readFile(path, 'utf8'), writeText = writeAtomic, endpoints = {}, limits = {}, setTimer = setTimeout,
    clearTimer = clearTimeout, now = () => performance.now(), clock = Date.now, steering = true} = {}) {
    if (typeof getKey !== 'function') throw Error('Invalid Inworld configuration');
    this.limits = Object.freeze({...INWORLD_LIMITS, ...limits});
    this.endpoints = Object.freeze({...INWORLD_ENDPOINTS, ...endpoints});
    Object.assign(this, {getKey, storePath, onChange, onLog, fetchImpl, readText, writeText, setTimer, clearTimer, now, clock, steering});
    // The clips are read, hash-checked and chosen exactly as for the Mistral voice (OmniVoice long set, short set, Pocket set, extracted clips).
    this.library = library ?? new VoxtralVoice({getKey: () => null, referenceRoot, registry, limits: {
      maxReferenceSeconds: this.limits.maxReferenceSeconds, maxReferenceBytes: this.limits.maxReferenceBytes}});
    this.owner = randomBytes(16).toString('hex'); this.sequence = 0;
    this.degraded = null; this.until = 0; this.spoke = 0; this.fellBack = 0; this.chars = 0;
    this.entries = new Map();           // voice key -> {state: 'ready'|'making'|'failed', voiceId, hash, name, source, promise, retryAt, error}
    this.store = null;                  // the saved voice ids: {version: 1, voices: {key: {voiceId, hash, name}}}
    this.storeLoading = null;
    this.account = null;                // {apiKey, names: Map(displayName -> voiceId), ids: Set, promise}: the account's own voice list
    this.lastKey = null;
    this.cloneTimes = [];               // when the latest clones were sent (the plan allows `clonesPerMinute`)
    this.cloneChain = Promise.resolve();
  }
  setReferences(registry) { this.library.setReferences?.(registry); this.entries.clear(); }
  get hasKey() { return !!this.getKey(); }
  /** Whether a request may be made now (a key, and not inside a limit, quota or refused-key cool-down). */
  get ready() { return this.hasKey && this.clock() >= this.until; }
  /** Does a registry name a reference clip for this voice key (without reading it)? */
  hasReference(key) { return this.library.hasReference?.(key) ?? false; }
  log(message) { try { this.onLog(`[Inworld] ${message}\n`); } catch { /* a log line never affects speech */ } }
  note(reason) {
    const changed = (this.degraded?.reason ?? null) !== (reason ?? null);
    this.degraded = reason ? {reason, at: this.clock()} : null;
    if (reason) this.fellBack++;
    if (changed) { try { this.onChange(this.degraded); } catch { /* observers never break speech */ } }
  }
  fail(kind, detail, extra) { return new InworldError(kind, detail, {apiKey: this.getKey(), ...extra}); }

  /** A new key (or none) forgets what was learned about the account; the saved voice ids are checked against the new account's list. */
  #syncKey() {
    const apiKey = this.getKey() ?? null;
    if (apiKey === this.lastKey) return apiKey;
    const replaced = this.lastKey && apiKey;   // one key swapped for another (not the first key of the session, not a removal)
    this.lastKey = apiKey; this.account = null; this.entries.clear(); this.until = 0;
    // The saved ids belong to the old account: with another account's key they would only be refused.
    if (replaced && this.store && Object.keys(this.store.voices).length) { this.store.voices = {}; void this.#saveStore(); }
    return apiKey;
  }

  // ---- the saved voice ids ----------------------------------------------------------------------------------------------

  async #loadStore() {
    if (this.store) return this.store;
    this.storeLoading ??= (async () => {
      let value = null;
      if (this.storePath) { try { value = JSON.parse(await this.readText(this.storePath)); } catch { /* none saved */ } }
      const voices = {};
      if (value?.version === 1 && value.voices && typeof value.voices === 'object') {
        for (const [key, entry] of Object.entries(value.voices)) {
          if (entry && typeof entry.voiceId === 'string' && typeof entry.hash === 'string') voices[key] = {voiceId: entry.voiceId, hash: entry.hash, name: String(entry.name ?? '')};
        }
      }
      this.store = {version: 1, voices};
      return this.store;
    })();
    return this.storeLoading;
  }
  async #saveStore() {
    if (!this.storePath || !this.store) return;
    try { await this.writeText(this.storePath, JSON.stringify(this.store)); } catch { /* the voice is still used from memory */ }
  }

  // ---- the account's voice list ------------------------------------------------------------------------------------------

  /** One request (a few pages at most) for the voices already in the account; it costs nothing. Cached until the key changes. */
  listVoices(apiKey) {
    if (this.account?.apiKey === apiKey) return this.account.promise;
    const account = {apiKey, names: new Map(), ids: new Set(), promise: null};
    account.promise = (async () => {
      let token = '';
      for (let page = 0; page < this.limits.listPages; page++) {
        const url = `${this.endpoints.voices}?pageSize=500${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
        const response = await this.request(url, {method: 'GET', headers: {authorization: `Basic ${apiKey}`, accept: 'application/json'}}, this.limits.listTimeoutMs);
        const text = await response.text().catch(() => '');
        if (!response.ok) throw mapStatus(response.status, text, {headers: response.headers, apiKey});
        let value; try { value = JSON.parse(text); } catch { throw this.fail('request', 'sent an unreadable voice list'); }
        for (const voice of Array.isArray(value?.voices) ? value.voices : []) {
          if (typeof voice?.voiceId !== 'string') continue;
          account.ids.add(voice.voiceId);
          if (typeof voice.displayName === 'string') account.names.set(voice.displayName, voice.voiceId);
        }
        token = typeof value?.nextPageToken === 'string' ? value.nextPageToken : '';
        if (!token) break;
      }
      return account;
    })();
    account.promise.catch(() => { if (this.account === account) this.account = null; });
    this.account = account;
    return account.promise;
  }

  /** A request with a time limit; a network error becomes an InworldError. */
  async request(url, init, timeoutMs, signal) {
    const controller = new AbortController();
    const relay = () => controller.abort(signal?.reason ?? cancelled());
    signal?.addEventListener('abort', relay, {once: true});
    if (signal?.aborted) relay();
    let timedOut = false;
    const timer = this.setTimer(() => { timedOut = true; controller.abort(Error('timeout')); }, timeoutMs);
    timer?.unref?.();
    try { return await this.fetchImpl(url, {...init, signal: controller.signal}); }
    catch (error) {
      throwIfCancelled(signal);
      throw this.fail(timedOut ? 'timeout' : 'network', timedOut ? `did not answer within ${timeoutMs} ms` : error?.message || 'is unreachable');
    } finally { this.clearTimer(timer); signal?.removeEventListener('abort', relay); }
  }

  // ---- the voice of a character -------------------------------------------------------------------------------------------

  /** The voice id of a character when its voice is ready, else null. */
  readyVoice(key) {
    this.#syncKey();
    const entry = this.entries.get(key);
    return entry?.state === 'ready' ? entry.voiceId : null;
  }
  /** Starts making the voice of a character in the background (the character was prepared): reads the clip, finds or clones the voice. */
  warm(key) {
    if (!this.ready) return;
    this.ensureVoice(key).catch(() => {});
  }
  /**
   * Resolves with the voice id of a character, making the voice when it does not exist (once; callers share the work). Rejects with an
   * InworldError: 'no-key', 'no-reference' or 'voice' (a clone Inworld refused or could not be made now, with the reason).
   */
  ensureVoice(key) {
    const apiKey = this.#syncKey();
    const entry = this.entries.get(key);
    if (entry?.state === 'ready') return Promise.resolve(entry.voiceId);
    if (entry?.state === 'making') return entry.promise;
    if (entry?.state === 'failed' && this.clock() < entry.retryAt) return Promise.reject(entry.error);
    const fresh = {state: 'making', voiceId: null, retryAt: 0, error: null, promise: null};
    this.entries.set(key, fresh);
    fresh.promise = this.#make(key, apiKey, fresh).then(voiceId => voiceId, error => {
      fresh.state = 'failed';
      fresh.error = error instanceof InworldError ? error : this.fail('voice', error?.message || 'could not be made');
      if (fresh.error.kind === 'no-reference') fresh.retryAt = this.clock() + 30_000;
      else if (!fresh.retryAt) fresh.retryAt = this.clock() + this.limits.cloneFaultRetryMs;
      if (fresh.error.kind === 'key' || fresh.error.kind === 'quota') this.noteFailure(fresh.error);
      throw fresh.error;
    });
    fresh.promise.catch(() => {});
    return fresh.promise;
  }

  async #make(key, apiKey, entry) {
    if (!apiKey) throw this.fail('no-key', 'has no Inworld key');
    const reference = await this.library.reference(key);
    if (!reference) throw this.fail('no-reference', 'has no reference clip for this voice');
    const hash = fingerprint(reference.base64).slice(0, 16), name = voiceDisplayName(key, hash);
    Object.assign(entry, {hash, name, source: reference.source});
    const store = await this.#loadStore();
    const saved = store.voices[key];
    if (saved && saved.hash === hash) {
      // Trusted at once (no wait for the list); the account's list corrects it in the background.
      Object.assign(entry, {state: 'ready', voiceId: saved.voiceId});
      void this.#reconcile(apiKey);
      return saved.voiceId;
    }
    let account;
    try { account = await this.listVoices(apiKey); }
    catch (error) { if (error instanceof InworldError && (error.kind === 'key' || error.kind === 'quota')) throw error; account = null; }
    const found = account?.names.get(name);
    let voiceId = found;
    if (!voiceId) voiceId = await this.#queueClone({key, apiKey, name, reference, entry});
    store.voices[key] = {voiceId, hash, name};
    await this.#saveStore();
    Object.assign(entry, {state: 'ready', voiceId});
    this.log(found ? `found the voice of ${key} in the account` : `made the voice of ${key} from ${reference.source} (${(reference.bytes / 1024).toFixed(0)} KB)`);
    if (!found) void this.#removeStale(key, name, apiKey);
    return voiceId;
  }

  /** The saved ids that the account does not have are forgotten (another account, a deleted voice), so they are made again. */
  async #reconcile(apiKey) {
    try {
      const account = await this.listVoices(apiKey);
      if (this.getKey() !== apiKey || !this.store) return;
      let changed = false;
      for (const [key, saved] of Object.entries(this.store.voices)) {
        if (account.ids.has(saved.voiceId)) continue;
        // Gone from the list: a voice of the same name may exist under another id; otherwise it is made again.
        const byName = saved.name ? account.names.get(saved.name) : undefined;
        if (byName) { saved.voiceId = byName; const entry = this.entries.get(key); if (entry?.state === 'ready') entry.voiceId = byName; }
        else { delete this.store.voices[key]; this.entries.delete(key); }
        changed = true;
      }
      if (changed) await this.#saveStore();
    } catch { /* the list is only a check */ }
  }

  /** Clones go one at a time and never faster than the plan allows; the wait for a free slot is part of the background work. */
  #queueClone(job) {
    const run = this.cloneChain.then(() => this.#clone(job));
    this.cloneChain = run.catch(() => {});
    return run;
  }
  async #waitForCloneSlot() {
    for (;;) {
      const at = this.clock();
      this.cloneTimes = this.cloneTimes.filter(time => at - time < 60_000);
      if (this.cloneTimes.length < this.limits.clonesPerMinute) return;
      const wait = 60_000 - (at - this.cloneTimes[0]) + 250;
      await new Promise(resolve => { const timer = this.setTimer(resolve, wait); timer?.unref?.(); });
    }
  }
  async #clone({key, apiKey, name, reference, entry}) {
    if (this.getKey() !== apiKey) throw this.fail('no-key', 'key changed while the voice was being made');
    await this.#waitForCloneSlot();
    this.cloneTimes.push(this.clock());
    const body = {displayName: name, languageCode: 'en-US', description: `Cyberpunk 2077 companion mod, voice of ${String(key).slice(0, 60)}`,
      tags: ['cp2077'], voiceSamples: [{audioData: reference.base64}], audioProcessingConfig: {removeBackgroundNoise: false}};
    let response, text;
    try {
      response = await this.request(this.endpoints.clone, {method: 'POST', headers: {authorization: `Basic ${apiKey}`, 'content-type': 'application/json', accept: 'application/json'},
        body: JSON.stringify(body)}, this.limits.cloneTimeoutMs);
      text = await response.text().catch(() => '');
    } catch (error) { entry.retryAt = this.clock() + this.limits.cloneFaultRetryMs; throw error; }
    if (!response.ok) {
      const failure = mapStatus(response.status, text, {headers: response.headers, apiKey});
      entry.retryAt = this.clock() + (failure.kind === 'limit' ? this.limits.cloneBusyRetryMs : failure.kind === 'network' ? this.limits.cloneFaultRetryMs : this.limits.cloneRetryMs);
      throw failure.kind === 'key' || failure.kind === 'quota' || failure.kind === 'limit' || failure.kind === 'network'
        ? failure : this.fail('voice', `was refused the clip: ${failure.message.replace(/^Inworld /, '').replace(/ \[inworld:[a-z-]+\]$/, '')}`, {status: response.status});
    }
    let value; try { value = JSON.parse(text); } catch { value = null; }
    const voiceId = value?.voice?.voiceId;
    if (typeof voiceId !== 'string' || !voiceId) {
      const problem = (value?.audioSamplesValidated ?? []).flatMap(sample => sample?.errors ?? []).map(error => error?.text).filter(Boolean)[0];
      entry.retryAt = this.clock() + this.limits.cloneRetryMs;
      throw this.fail('voice', problem ? `did not accept the clip: ${problem}` : 'answered without a voice');
    }
    const warnings = (value.audioSamplesValidated ?? []).flatMap(sample => sample?.warnings ?? []).map(warning => warning?.text).filter(Boolean);
    if (warnings.length) this.log(`clone of ${key}: ${warnings.slice(0, 2).join('; ').slice(0, 160)}`);
    return voiceId;
  }

  /** After a new clone, an older voice of the same character (the clip changed) is removed so the plan's stored voices do not fill up. */
  async #removeStale(key, name, apiKey) {
    try {
      const account = await this.listVoices(apiKey);
      const stem = name.slice(0, name.lastIndexOf('-') + 1);
      for (const [displayName, voiceId] of account.names) {
        if (displayName === name || !displayName.startsWith(stem) || !/^[a-f0-9]{8}$/.test(displayName.slice(stem.length))) continue;
        const response = await this.request(`${this.endpoints.voices}/${encodeURIComponent(voiceId)}`, {method: 'DELETE', headers: {authorization: `Basic ${apiKey}`}}, this.limits.listTimeoutMs);
        await response.body?.cancel().catch(() => {});
        if (response.ok) { account.names.delete(displayName); account.ids.delete(voiceId); this.log(`removed an older voice of ${key}`); }
      }
    } catch { /* an old voice staying is harmless */ }
  }

  /** The voice is forgotten after Inworld said it does not exist: it is made again the next time (this reply goes to Pocket). */
  #forget(key) {
    this.entries.delete(key);
    if (this.store?.voices[key]) { delete this.store.voices[key]; void this.#saveStore(); }
    this.account = null;
  }

  // ---- speaking -------------------------------------------------------------------------------------------------------------

  /**
   * Speaks `text` as the voice `key`, handing `onPcm` 24 kHz mono float32 packets of Pocket's shape. `emotion` ({marks, sounds, from}) carries
   * the Expressive emotions marks and the non-verbal sounds of the text. Resolves with the stream's summary. Throws an InworldError when nothing was delivered (the
   * caller uses Pocket for the whole reply), `cancelled` when `signal` aborts, and the consumer's own error (marked `sink`) when `onPcm` fails.
   */
  async synthesizeStream(key, text, {signal, onPcm, emotion} = {}) {
    throwIfCancelled(signal);
    if (typeof onPcm !== 'function') throw Error('Inworld streaming requires a PCM consumer');
    const apiKey = this.#syncKey();
    try {
      if (typeof text !== 'string' || !text.trim() || text.length > this.limits.maxChars
          || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw this.fail('text', 'cannot speak this text');
      if (!apiKey) throw this.fail('no-key', 'has no Inworld key');
      if (this.clock() < this.until) throw this.fail('limit', 'is waiting out a limit');
      const queued = this.now();
      const voiceId = await this.#voiceFor(key, signal);
      throwIfCancelled(signal);
      const result = await this.#stream({key, text, apiKey, voiceId, emotion, signal, onPcm, queued});
      this.spoke++; this.note(null);
      return result;
    } catch (error) {
      if (error instanceof InworldError) {
        if (error.kind === 'voice-missing') { this.#forget(key); error = this.fail('voice', 'no longer has the voice of this character'); }
        this.noteFailure(error);
      }
      throw error;
    }
  }

  /** The ready voice, or the one being made when it arrives within the wait; else a 'voice' error (Pocket speaks this reply). */
  async #voiceFor(key, signal) {
    const ready = this.readyVoice(key);
    if (ready) return ready;
    const pending = this.ensureVoice(key);
    pending.catch(() => {});
    let timer, onAbort;
    const waited = new Promise((_, reject) => {
      timer = this.setTimer(() => reject(this.fail('voice', 'is still making the voice of this character')), this.limits.cloneWaitMs);
      timer?.unref?.();
    });
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(cancelled());
      if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, {once: true});
    });
    aborted.catch(() => {}); waited.catch(() => {});
    try { return await Promise.race([pending, waited, aborted]); }
    finally { this.clearTimer(timer); signal?.removeEventListener('abort', onAbort); }
  }

  /** Records why Inworld could not deliver (a limit, a refused key or a used-up plan pauses requests) and says so in the log. */
  noteFailure(error, scope = '') {
    if (error.kind === 'limit' && error.status === 429) this.until = this.clock() + (error.retryAfterMs ?? this.limits.limitCooldownMs);
    if (error.kind === 'key') this.until = this.clock() + this.limits.keyCooldownMs;
    if (error.kind === 'quota') this.until = this.clock() + this.limits.quotaCooldownMs;
    // A voice not made yet, a character without a clip, or text that cannot be spoken is that reply's problem, not the service's.
    if (!['text', 'no-reference', 'voice'].includes(error.kind)) this.note(error.kind);
    const detail = String(error.message ?? '').replace(/^Inworld /, '').replace(/ \[inworld:[a-z-]+\]$/, '');
    this.log(`${scope ? scope + ' ' : ''}fell back to Pocket: ${error.kind}${error.status ? ` (HTTP ${error.status})` : ''}${detail ? ` - ${detail}` : ''}`);
  }

  /** One request for the whole text of this part. */
  async #stream({key, text, apiKey, voiceId, emotion, signal, onPcm, queued}) {
    const id = ++this.sequence, started = this.now();
    // The character's own marks steer the voice. A reply that carries none (the model wrote no tag, or the provider could not be asked)
    // is read by the same small lexicon the face uses: a clear feeling in the words steers it, anything else is spoken plainly.
    const written = Array.isArray(emotion?.marks) && emotion.marks.length > 0;
    const inferred = this.steering && !written ? fallbackMarks(text) : [];
    const steered = !this.steering ? steerText(text, null)
      : steerText(text, written ? emotion.marks : inferred, {from: written ? emotion?.from ?? 0 : 0, sounds: emotion?.sounds, soundsFrom: emotion?.from ?? 0});
    steered.source = written ? 'tags' : inferred.length ? 'text' : 'none';
    let delivered = 0, chunks = 0, firstMs = null, sentAt = null, bytesCarry = Buffer.alloc(0), pending = new Float32Array(0);
    const emit = async samples => {
      const packet = {version: 1, engine: 'pocket-tts', profile: key, owner: this.owner, id, index: chunks + 1,
        sampleRate: INWORLD_RATE, channels: 1, pcm: samples, format: 'f32le', offsetFrames: delivered,
        frames: samples.length, timebase: 'audio-seconds', startSeconds: delivered / INWORLD_RATE,
        modelSha256: MODEL_ID, timing: {voicePcmReceivedMs: this.now() - started}};
      try { await onPcm(packet); }
      catch (error) { error.sink = true; throw error; }
      delivered += samples.length; chunks++;
    };
    // Whole 100 ms frames while audio arrives; the remainder waits for the next line or the end. 16-bit little-endian to float32.
    const push = async (bytes, final) => {
      const joined = bytesCarry.length ? Buffer.concat([bytesCarry, bytes]) : bytes;
      const whole = joined.length - (joined.length % 2);
      bytesCarry = Buffer.from(joined.subarray(whole));
      if (whole) {
        firstMs ??= this.now() - sentAt;
        const merged = new Float32Array(pending.length + whole / 2);
        merged.set(pending);
        for (let at = 0; at < whole / 2; at++) merged[pending.length + at] = joined.readInt16LE(at * 2) / 32768;
        pending = merged;
      }
      const size = this.limits.frameSamples;
      let from = 0;
      while (pending.length - from >= size || (final && pending.length - from > 0)) {
        const end = Math.min(from + size, pending.length);
        await emit(pending.slice(from, end));
        from = end;
      }
      if (from) pending = pending.slice(from);
    };

    const controller = new AbortController();
    const onAbort = () => controller.abort(cancelled());
    signal?.addEventListener('abort', onAbort, {once: true});
    if (signal?.aborted) onAbort();
    let timer, timedOut = null;
    const arm = (ms, kind) => {
      this.clearTimer(timer);
      timer = this.setTimer(() => { timedOut = kind; controller.abort(Error(`inworld ${kind}`)); }, ms);
      timer?.unref?.();
    };
    try {
      let response;
      sentAt = this.now();
      arm(this.limits.firstAudioMs, 'timeout');
      try {
        response = await this.fetchImpl(this.endpoints.speech, {method: 'POST', signal: controller.signal,
          headers: {authorization: `Basic ${apiKey}`, 'content-type': 'application/json', accept: 'application/json'},
          body: JSON.stringify({text: steered.text, voiceId, modelId: INWORLD_MODEL, audioConfig: {audioEncoding: 'PCM', sampleRateHertz: INWORLD_RATE}})});
      } catch (error) {
        throwIfCancelled(signal);
        throw timedOut ? this.fail('timeout', `gave no audio within ${this.limits.firstAudioMs} ms`) : this.fail('network', error?.message || 'is unreachable');
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw mapStatus(response.status, body, {headers: response.headers, apiKey});
      }
      if (!response.body) throw this.fail('request', 'answered without a stream');
      let done = true;
      try {
        for await (const line of ndjson(response.body)) {
          const failure = line?.error;
          if (failure) throw mapStreamError(failure, {apiKey});
          const content = line?.result?.audioContent ?? line?.audioContent;
          if (typeof content === 'string' && content) {
            await push(Buffer.from(content, 'base64'), false);
            // Audio is flowing: the first-audio limit is over, a long silence is the next limit.
            if (delivered || pending.length) arm(this.limits.stallMs, 'stall');
          }
        }
        await push(Buffer.alloc(0), true);
      } catch (error) {
        throwIfCancelled(signal);
        if (error.sink || error instanceof InworldError && !delivered && !pending.length) throw error;
        if (!delivered && !pending.length) throw timedOut === 'timeout' ? this.fail('timeout', `gave no audio within ${this.limits.firstAudioMs} ms`) : this.fail('network', error?.message || 'stream failed');
        // Audio is already playing: end the audio here, after the last whole sample received. The voice is not switched.
        this.log(`stream ended early after ${(delivered / INWORLD_RATE).toFixed(1)} s: ${redact(error?.message, apiKey).slice(0, 80)}`);
        done = false;
        try { await push(Buffer.alloc(0), true); } catch (flushError) { if (flushError.sink) throw flushError; }
      }
      if (!delivered) throw this.fail('request', 'answered without audio');
      this.chars += text.length;
      this.log(`first audio ${Math.round(firstMs)}ms, chars ${text.length}${steered.tags ? `, ${steered.tags} emotion tag${steered.tags === 1 ? '' : 's'}${steered.source === 'text' ? ' (from the words)' : ''}` : ''}${steered.sounds ? `, ${steered.sounds} sound${steered.sounds === 1 ? '' : 's'}` : ''}`);
      return {provider: 'inworld', engine: 'inworld', sampleRate: INWORLD_RATE, channels: 1, frames: delivered, chunks,
        duration: delivered / INWORLD_RATE, modelSha256: MODEL_ID, truncated: !done,
        timing: {voiceProvider: 'pocket', voiceEngine: 'inworld', voiceCloud: true, voiceWarm: true,
          voiceFirstPcmReceivedMs: firstMs, voiceGenerationMs: this.now() - started, voiceRoundTripMs: this.now() - started,
          voiceQueueMs: sentAt - queued, voiceRequests: 1, voiceEmotionTags: steered.tags, voiceEmotionSource: steered.source, voiceSounds: steered.sounds, ...(done ? {} : {voiceTruncated: true})}};
    } finally {
      this.clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
      // Free the connection whichever way this ended.
      if (!controller.signal.aborted) controller.abort(cancelled('Inworld request completed'));
    }
  }
}
