// The game's side of Remote OmniVoice (docs/REMOTE_OMNIVOICE.md): a client that has the surface of bridge/resident-voice.mjs ResidentVoice (start, synthesize,
// prepareProfile, prepareLanguage, setVoices, close, the loaded/failure/prepared state), so bridge/voice-selection.mjs and everything above it treat a
// server on another PC like the local worker. It loads NO model: the process only talks to bridge/omni-server.mjs over HTTP (bridge/omni-remote.mjs).
//
// Rules this client keeps (owner, 2026-10-27):
//   - A server that cannot be reached, answers too slowly or is loading is a failure of this client (state 'error'): the voice service then routes the
//     reply to TEXT and asks again after a short wait (bridge/voice-selection.mjs, REMOTE_RETRY_DELAYS_MS). Never a cloud voice, never another local voice.
//   - A phrase is asked of the server the moment it is wanted, on a connection that is kept open: no extra buffering, no handshake in front of a phrase.
//   - Cancel is closing the connection: a job that has not started never starts; one that has finishes on the server (a render cannot be taken back).
//   - Clips the server does not have (a player's own clip, V's voice) are sent once, named by key and checked by hash; nothing else of this PC is sent.
import {Agent, request as httpRequest} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {inspectWav} from './speech-audio.mjs';
import {abortable, throwIfCancelled, cancelled} from './transport-pool.mjs';
import {createVoiceProfileRegistry, registryFromTable, voiceTable, isPlayerReference} from './voice-profile-registry.mjs';
import {OMNI_PROTOCOL, OMNI_SERVICE, TIMING_HEADER, LIMITS, parseServerAddress} from './omni-remote.mjs';

export const REMOTE_LIMITS = Object.freeze({connectMs: 3000, healthMs: 4000, loadWaitMs: 8000, voicesMs: 60_000, clipMs: 120_000, renderMs: 60_000, probeCount: 3});
// The waits between a failed remote voice and the next try: short (a server is on the home network; it is usually back at once, or still loading), and the last
// one repeats for as long as the player wants the voice.
export const REMOTE_RETRY_DELAYS_MS = Object.freeze([3000, 8000, 20_000, 60_000]);
export const REMOTE_FAILURE = 'Remote OmniVoice server';
export const remoteFailed = reason => String(reason ?? '').startsWith(REMOTE_FAILURE);

const mapOf = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sleep = ms => new Promise(done => setTimeout(done, ms));

function netError(kind, message, extra = {}) { return Object.assign(Error(message), {kind, ...extra}); }
const kindOf = error => error?.kind ?? (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ECONNABORTED|EADDRNOTAVAIL/.test(error?.code ?? '') ? 'unreachable'
  : /ECONNRESET|EPIPE|socket hang up/.test(`${error?.code ?? ''} ${error?.message ?? ''}`) ? 'reset' : 'network');

/**
 * One HTTP exchange: {status, headers, bytes}. Rejects with an error whose `kind` is 'unreachable' (nothing listens, no route), 'timeout', 'reset', 'aborted' or
 * 'network'. A connection kept open that the server had closed meanwhile is replaced once, silently (the request had not reached it).
 */
export function exchange({endpoint, method, path, body, contentType, timeoutMs, connectMs = REMOTE_LIMITS.connectMs, signal, agent, maxBytes = 64 * 1024 * 1024}) {
  const attempt = retry => new Promise((done, fail) => {
    if (signal?.aborted) { fail(netError('aborted', 'cancelled')); return; }
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    let connectTimer = null, totalTimer = null, settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(connectTimer); clearTimeout(totalTimer); signal?.removeEventListener('abort', onAbort);
      error ? fail(error) : done(value);
    };
    const req = httpRequest({host: endpoint.host.replace(/^\[|\]$/g, ''), port: endpoint.port, method, path, agent,
      headers: {...(payload ? {'content-length': payload.length, 'content-type': contentType ?? 'application/json'} : {}), accept: '*/*'}}, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(netError('network', 'The answer is too large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => finish(null, {status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks)}));
      res.on('error', error => finish(netError(kindOf(error), String(error?.message ?? error))));
      res.on('aborted', () => finish(netError('reset', 'The connection closed before the answer was complete')));
    });
    const onAbort = () => { req.destroy(); finish(netError('aborted', 'cancelled')); };
    signal?.addEventListener('abort', onAbort, {once: true});
    req.on('socket', socket => {
      socket.setNoDelay(true);
      const connected = () => {
        clearTimeout(connectTimer);
        totalTimer = setTimeout(() => { req.destroy(); finish(netError('timeout', 'No answer in time')); }, timeoutMs);
      };
      if (socket.connecting) {
        connectTimer = setTimeout(() => { req.destroy(); finish(netError('unreachable', 'The connection did not open in time')); }, connectMs);
        socket.once('connect', connected);
      } else connected();
    });
    req.on('error', error => {
      if (settled) return;
      const kind = kindOf(error);
      if (kind === 'reset' && req.reusedSocket && retry && !signal?.aborted) {
        settled = true; clearTimeout(connectTimer); clearTimeout(totalTimer); signal?.removeEventListener('abort', onAbort);
        attempt(false).then(done, fail); return;
      }
      finish(netError(kind, String(error?.message ?? error), {code: error?.code}));
    });
    req.end(payload);
  });
  return attempt(true);
}

const parseJson = bytes => { try { const value = JSON.parse(bytes.toString('utf8')); return mapOf(value) ? value : null; } catch { return null; } };

/**
 * The Test button: asks the server who it is a few times and says what came back. Never throws.
 * {state: 'ok' | 'loading' | 'failed', code?, ms (the median round trip), version, protocol, device, gpu, voices} where `code` for a failure is one of
 * 'unreachable', 'timeout', 'not-omnivoice', 'protocol', 'blocked', 'server'.
 */
export async function probeOmniServer(endpoint, {count = REMOTE_LIMITS.probeCount, agent = new Agent({keepAlive: true, maxSockets: 1}), timeoutMs = REMOTE_LIMITS.healthMs, signal} = {}) {
  const times = [];
  let health = null;
  try {
    for (let at = 0; at < count; at++) {
      const started = performance.now();
      const answer = await exchange({endpoint, method: 'GET', path: '/v1/health', timeoutMs, signal, agent});
      const took = performance.now() - started;
      if (answer.status === 403) return {state: 'failed', code: 'blocked'};
      health = parseJson(answer.bytes);
      if (answer.status !== 200 || health?.service !== OMNI_SERVICE) return {state: 'failed', code: 'not-omnivoice'};
      // The first exchange opens the connection; the others measure the answer on a connection that is already there, which is what a phrase finds.
      if (at > 0 || count === 1) times.push(took);
    }
  } catch (error) {
    const kind = kindOf(error);
    return {state: 'failed', code: kind === 'timeout' ? 'timeout' : 'unreachable'};
  } finally { agent.destroy(); }
  if (health.protocol !== OMNI_PROTOCOL) return {state: 'failed', code: 'protocol', version: clip(health.version), protocol: Number(health.protocol) || null};
  times.sort((a, b) => a - b);
  const facts = {ms: Math.max(1, Math.round(times[Math.floor(times.length / 2)] ?? 0)), version: clip(health.version), protocol: health.protocol,
    device: clip(health.device), gpu: Number.isInteger(health.gpu?.index) ? health.gpu.index : null, voices: Number.isFinite(health.voices) ? health.voices : 0};
  if (health.state === 'ready') return {state: 'ok', ...facts};
  return health.state === 'error' ? {state: 'failed', code: 'server', ...facts} : {state: 'loading', ...facts};
}
const clip = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 60) : null;

export class RemoteVoice {
  /**
   *   config      the voice configuration (provider 'hybrid', engine 'omnivoice', voices, preparation), like ResidentVoice's
   *   endpoint    {host, port} (bridge/omni-remote.mjs parseServerAddress)
   *   referenceRoots   folders `runtime/voice-references/...` clips are read from, for the ones the server lacks
   *   limits      REMOTE_LIMITS overrides (tests)
   */
  constructor(config = {}, {endpoint, referenceRoots = [], onState = () => {}, onLog = () => {}, limits = {}, playerVoiceDirectory = config.playerVoiceDirectory ?? null} = {}) {
    const address = endpoint?.host ? endpoint : parseServerAddress(endpoint);
    if (!address?.host) throw Error(`${REMOTE_FAILURE} address is not valid`);
    this.endpoint = {host: address.host, port: address.port};
    this.limits = {...REMOTE_LIMITS, ...limits};
    this.registry = createVoiceProfileRegistry(config);
    this.baseRegistry = this.registry; this.wanted = null; this.playerDirectory = playerVoiceDirectory;
    this.config = Object.freeze({...config, voices: this.registry.profiles, preparation: this.registry.preparation});
    Object.assign(this, {referenceRoots, onState, onLog});
    this.steps = config.steps === 32 ? 32 : 16;
    this.agent = new Agent({keepAlive: true, maxSockets: 4, keepAliveMsecs: 30_000});
    this.state = this.enabled ? 'stopped' : 'disabled';
    this.loaded = false; this.details = {remote: true, host: this.endpoint.host, port: this.endpoint.port};
    this.prepared = new Set(); this.available = new Set(); this.protocolVersion = 2;
    this.tail = Promise.resolve(); this.fill = Promise.resolve(); this.synced = ''; this.instance = null; this.keepPrepared = false;
    this.control = new AbortController();
  }
  get enabled() { return this.config.provider === 'hybrid' && this.registry.keys.length > 0; }
  get profileKeys() { return this.registry.keys.filter(key => this.available.has(key)); }
  hasProfile(key) { return this.registry.has(key) && this.available.has(key); }
  usesProfile(key) { return this.enabled && this.hasProfile(key); }
  profileReady(key) { return this.loaded && this.hasProfile(key) && this.prepared.has(key); }
  setKeepPrepared(value) { this.keepPrepared = value === true; }
  setSteps(value) {
    const next = value === 32 ? 32 : 16, changed = next !== this.steps;
    this.steps = next;
    if (changed) this.publish(this.state);
    return changed;
  }
  publish(state, extra = {}) {
    this.state = state;
    try {
      Promise.resolve(this.onState({version: 1, state, steps: this.steps, engine: 'omnivoice', provider: this.enabled ? 'hybrid' : 'convai', bridgePid: process.pid,
        profiles: this.enabled ? this.profileKeys : [], preparedProfiles: [...this.prepared], resident: false, remote: true, updated: Date.now(), ...this.details, ...extra})).catch(() => {});
    } catch { /* a diagnostic write never interrupts a phrase */ }
  }
  log(message) { try { this.onLog(`[RemoteOmni] ${message}\n`); } catch { /* a log line is an extra */ } }

  /** The voices this client should hold from now on (the same contract as ResidentVoice.setVoices). Resolves to true when the server was sent a change. */
  setVoices(voices, {playerVoiceDirectory = null} = {}) {
    if (this.closing || this.failure) return Promise.resolve(false);
    try { this.wanted = {table: voiceTable(registryFromTable(voices, this.config))}; } catch (error) { return Promise.reject(error); }
    if (playerVoiceDirectory) this.playerDirectory = playerVoiceDirectory;
    if (!this.loaded) return Promise.resolve(false);
    const operation = this.tail.then(() => this.syncVoices());
    this.tail = operation.catch(() => {});
    return operation;
  }
  currentTable() { return this.wanted?.table ?? voiceTable(this.baseRegistry); }

  // ---- talking to the server ----
  call(method, path, {body, timeoutMs, signal, contentType, mark = true} = {}) {
    const merged = signal ? AbortSignal.any([signal, this.control.signal]) : this.control.signal;
    return exchange({endpoint: this.endpoint, method, path, body, timeoutMs, contentType, signal: merged, agent: this.agent, connectMs: this.limits.connectMs}).then(answer => {
      const instance = answer.headers['x-omni-instance'] ?? parseJson(answer.bytes)?.instance;
      if (mark && typeof instance === 'string') this.noteInstance(instance);
      return answer;
    });
  }
  // A server that started again (another instance) forgot the voices the game sent: they are sent again before the next phrase.
  noteInstance(instance) {
    if (this.instance && this.instance !== instance) { this.synced = ''; this.log('the server was restarted; its voices will be sent again'); }
    this.instance = instance;
  }
  asFailure(error, doing) {
    if (error?.kind === 'aborted' || error?.name === 'AbortError') return cancelled();
    const why = error?.kind === 'timeout' ? 'did not answer in time' : error?.kind === 'unreachable' ? 'cannot be reached' : error?.kind === 'reset' ? 'closed the connection'
      : 'failed';   // never the system's own words: they name the address
    return Object.assign(Error(`${REMOTE_FAILURE} ${why} (${doing})`), {kind: error?.kind ?? 'network'});
  }
  // The server said something other than success.
  refused(answer, doing) {
    const body = parseJson(answer.bytes) ?? {};
    const code = typeof body.error === 'string' ? body.error : String(answer.status);
    return Object.assign(Error(`${REMOTE_FAILURE} refused ${doing} (${code}${body.message ? `: ${String(body.message).slice(0, 120)}` : ''})`), {code, status: answer.status});
  }

  // ---- start ----
  start() {
    if (!this.enabled) { this.publish('disabled'); return Promise.resolve(); }
    if (this.closing) return Promise.reject(cancelled('Remote speech is stopping'));
    if (this.ready) return this.ready;
    this.publish('loading');
    this.ready = this.connect().then(() => {
      this.loaded = true; this.publish('ready');
    }, error => { this.fail(error); throw this.failure; });
    this.ready.catch(() => {});
    return this.ready;
  }
  async connect() {
    const started = performance.now();
    let health;
    for (;;) {
      let answer;
      try { answer = await this.call('GET', '/v1/health', {timeoutMs: this.limits.healthMs, mark: false}); }
      catch (error) { throw this.asFailure(error, 'looking for it'); }
      health = parseJson(answer.bytes);
      if (answer.status !== 200 || health?.service !== OMNI_SERVICE) throw Error(`${REMOTE_FAILURE} at this address is not an OmniVoice server`);
      if (health.protocol !== OMNI_PROTOCOL) throw Error(`${REMOTE_FAILURE} is another version (protocol ${health.protocol}); update the server or the mod`);
      if (health.state === 'ready') break;
      if (health.state === 'error') throw Error(`${REMOTE_FAILURE} could not load its voice${health.detail ? ` (${String(health.detail).slice(0, 120)})` : ''}`);
      if (performance.now() - started > this.limits.loadWaitMs) throw Error(`${REMOTE_FAILURE} is still loading its voice`);
      await sleep(400);
    }
    this.noteInstance(health.instance ?? '');
    this.details = {...this.details, device: health.device ?? undefined, serverVersion: health.version, serverMs: Math.round(performance.now() - started)};
    await this.syncVoices(true);
  }

  // ---- voices ----
  // The clip a descriptor names, read from this PC: the player's own folder or the reference folders. Null when it is not there or is not the file the hash names.
  async readClip(descriptor) {
    const reference = descriptor.reference;
    const roots = isPlayerReference(reference) ? [this.playerDirectory] : this.referenceRoots;
    const relative = reference.replace(/^runtime\/(?:player-voices|voice-references)\//, '');
    for (const root of roots) {
      if (!root) continue;
      try {
        const bytes = await readFile(resolve(root, ...relative.split('/')));
        if (bytes.length <= LIMITS.clipBytes && createHash('sha256').update(bytes).digest('hex') === descriptor.sha256) return bytes;
      } catch { /* the next folder */ }
    }
    return null;
  }
  async putClip(key, descriptor) {
    const bytes = await this.readClip(descriptor);
    if (!bytes) return false;
    const answer = await this.call('PUT', `/v1/clips/${key}?sha256=${descriptor.sha256}`, {body: bytes, contentType: 'audio/wav', timeoutMs: this.limits.clipMs});
    return answer.status === 200;
  }
  async sendVoices(table, reload = []) {
    let answer;
    try { answer = await this.call('POST', '/v1/voices', {body: {voices: table, ...(reload.length ? {reload} : {})}, timeoutMs: this.limits.voicesMs}); }
    catch (error) { throw this.asFailure(error, 'sending the voices'); }
    if (answer.status !== 200) throw this.refused(answer, 'the voices');
    const body = parseJson(answer.bytes) ?? {};
    return {missing: Array.isArray(body.missing) ? body.missing.filter(item => mapOf(item) && typeof item.key === 'string' && Object.hasOwn(table, item.key)) : [],
      prepared: Array.isArray(body.prepared) ? body.prepared.filter(key => typeof key === 'string') : []};
  }
  // Sends the voice table the game wants and the clips the server lacks. The urgent clips (the player's own, V's voice) are waited for; the shipped ones the
  // server may lack arrive in the background, and a character is spoken once its clip is there.
  async syncVoices(first = false) {
    const table = this.currentTable(), signature = JSON.stringify(table);
    if (!first && signature === this.synced) return false;
    let answer = await this.sendVoices(table);
    // V's two voices are urgent too: they are merged in as runtime/voice-references/addons/v-male.wav and v-female.wav (bridge/addons.mjs), which the server never
    // holds, and V's typed or spoken line is skipped until the clip is there (2026-10-28: the background send came after every other missing clip).
    const urgent = item => isPlayerReference(table[item.key]?.reference) || item.key === 'v-male' || item.key === 'v-female'
      || /^runtime\/voice-references\/v-voice\//.test(table[item.key]?.reference ?? '');
    const send = async items => {
      const sent = [];
      for (const item of items) {
        try { if (await this.putClip(item.key, table[item.key])) sent.push(item.key); }
        catch (error) { throw this.asFailure(error, 'sending a voice clip'); }
      }
      return sent;
    };
    const first_ = answer.missing.filter(urgent), later = answer.missing.filter(item => !urgent(item));
    if (first_.length) {
      const sent = await send(first_);
      if (sent.length) answer = await this.sendVoices(table, sent);
    }
    this.take(table, answer);
    this.synced = signature;
    if (later.length) this.backfill(table, later);
    return true;
  }
  // What the server holds now: the table minus the clips it still lacks.
  take(table, answer) {
    const lacking = new Set(answer.missing.map(item => item.key));
    this.registry = registryFromTable(table, this.config);
    this.available = new Set(this.registry.keys.filter(key => !lacking.has(key)));
    this.prepared = new Set(answer.prepared.filter(key => this.available.has(key)));
    this.stillMissing = answer.missing.length;
    this.publish(this.closing ? this.state : 'ready');
  }
  backfill(table, items) {
    this.fill = this.fill.then(async () => {
      for (let at = 0; at < items.length && !this.closing && !this.failure; at += 8) {
        const sent = [];
        for (const item of items.slice(at, at + 8)) { try { if (await this.putClip(item.key, table[item.key])) sent.push(item.key); } catch { return; } }
        if (!sent.length || JSON.stringify(this.currentTable()) !== JSON.stringify(table)) continue;
        try { this.take(table, await this.sendVoices(table, sent)); } catch { return; }
      }
      this.log(`${items.length} voice clips were sent to the server`);
    }).catch(() => {});
  }

  // ---- phrases ----
  fail(error) {
    if (this.failure || this.closing) return;
    this.failure = error;
    this.loaded = false; this.prepared.clear();
    this.control.abort();
    this.agent.destroy();
    this.log(`failed: ${error.message}`);
    this.publish('error', {detail: 'The remote OmniVoice server is unavailable.'});
  }
  async serverReady(signal) {
    await this.start();
    throwIfCancelled(signal);
    if (this.closing || this.failure) throw this.failure || cancelled();
    // A restarted server lost the voices: they are sent again before the phrase.
    if (this.synced === '') await this.syncVoices(true).catch(error => { this.fail(error); throw this.failure; });
  }
  async ask(path, body, signal, timeoutMs, doing) {
    for (let again = 0; ; again++) {
      let answer;
      try { answer = await this.call('POST', path, {body, signal, timeoutMs}); }
      catch (error) {
        const failure = this.asFailure(error, doing);
        if (failure.name !== 'AbortError') this.fail(failure);
        throw failure;
      }
      if (answer.status === 200) return answer;
      const refusal = this.refused(answer, doing);
      // The server was restarted and does not know the voice: send the voices again and ask once more.
      if (refusal.code === 'unknown-profile' && again === 0) {
        this.synced = '';
        try { await this.syncVoices(true); } catch (error) { this.fail(error); throw this.failure; }
        continue;
      }
      // Loading, restarting or busy: this client stops; the voice service falls back to text and asks again (REMOTE_RETRY_DELAYS_MS).
      if (answer.status === 503) { this.fail(refusal); throw this.failure; }
      throw refusal;
    }
  }
  async command(kind, profile, payload, signal) {
    this.publish(kind === 'prepare' ? 'warming' : 'speaking', {profile});
    try {
      const answer = await this.ask(kind === 'prepare' ? '/v1/prepare' : '/v1/synthesize', {profile, ...payload}, signal, this.limits.renderMs,
        kind === 'prepare' ? 'a voice preparation' : 'a phrase');
      return answer;
    } finally { if (!this.closing && !this.failure) this.publish('ready'); }
  }
  async ensurePrepared(profile, signal) {
    await this.serverReady(signal);
    if (!this.hasProfile(profile)) throw Error('This character uses its Convai voice');
    if (!this.prepared.has(profile)) {
      const answer = await this.command('prepare', profile, {steps: this.steps}, signal);
      this.notePrepared(parseJson(answer.bytes)?.prepared);
      throwIfCancelled(signal);
    }
  }
  notePrepared(list) { if (Array.isArray(list)) this.prepared = new Set(list.filter(key => typeof key === 'string' && this.available.has(key))); }
  prepareProfile(profile, {signal} = {}) {
    if (!this.usesProfile(profile)) return Promise.resolve({provider: 'text', ready: true, reason: this.registry.has(profile) ? 'unavailable' : this.registry.status(profile)});
    const operation = this.tail.then(async () => {
      await this.ensurePrepared(profile, signal);
      return {provider: 'omnivoice', ready: this.profileReady(profile), profile};
    });
    this.tail = operation.catch(() => {});
    return abortable(operation, signal);
  }
  prepareLanguage(profile, languageReference, {signal} = {}) {
    if (!this.usesProfile(profile)) return Promise.reject(Error('This character uses its Convai voice'));
    if (!(languageReference && typeof languageReference.reference === 'string' && /^[a-f0-9]{64}$/.test(languageReference.sha256 ?? '')
        && typeof languageReference.transcript === 'string' && languageReference.transcript.trim())) return Promise.reject(Error('Invalid language reference'));
    const wanted = {languageReference: {reference: languageReference.reference, sha256: languageReference.sha256, transcript: languageReference.transcript}};
    const operation = this.tail.then(async () => {
      await this.serverReady(signal);
      if (!this.hasProfile(profile)) throw Error('This character uses its Convai voice');
      const answer = await this.command('prepare', profile, {steps: this.steps, ...wanted}, signal);
      const body = parseJson(answer.bytes) ?? {};
      throwIfCancelled(signal);
      return {provider: 'omnivoice', profile, languageReference: body.languageReference === 'used' ? 'used' : 'fallback', ms: body.ms};
    });
    this.tail = operation.catch(() => {});
    return abortable(operation, signal);
  }
  // Same contract as ResidentVoice.synthesize: {audio (base64 WAV), wav, faces, captions, timing}.
  synthesize(profile, text, {signal, steps: chosenSteps, language, languageReference} = {}) {
    if (!this.usesProfile(profile)) return Promise.reject(Error('This character uses its Convai voice'));
    if (typeof text !== 'string' || !text.trim() || text.length > LIMITS.textChars) return Promise.reject(Error('Invalid speech text'));
    if (chosenSteps !== undefined && ![16, 32].includes(chosenSteps)) return Promise.reject(Error('Invalid voice quality'));
    if (language !== undefined && language !== null && !/^[a-z]{2,3}$/.test(language)) return Promise.reject(Error('Invalid speech language'));
    const languageField = language && language !== 'en' ? {language} : {};
    const wanted = languageField.language && languageReference && typeof languageReference.reference === 'string' && /^[a-f0-9]{64}$/.test(languageReference.sha256 ?? '')
      && typeof languageReference.transcript === 'string' && languageReference.transcript.trim()
      ? {languageReference: {reference: languageReference.reference, sha256: languageReference.sha256, transcript: languageReference.transcript}} : {};
    const steps = chosenSteps ?? this.steps, queued = performance.now();
    const operation = this.tail.then(async () => {
      if (wanted.languageReference) {
        await this.serverReady(signal);
        if (!this.hasProfile(profile)) throw Error('This character uses its Convai voice');
      } else await this.ensurePrepared(profile, signal);
      const started = performance.now();
      const answer = await this.command('synthesize', profile, {text, steps, ...languageField, ...wanted}, signal);
      throwIfCancelled(signal);
      if (this.closing || this.failure) throw this.failure || cancelled();
      let timing = {};
      try { timing = JSON.parse(answer.headers[TIMING_HEADER] ?? '{}'); } catch { timing = {}; }
      this.notePrepared(timing.prepared);
      let wav;
      try { wav = inspectWav(answer.bytes); } catch { throw Error(`${REMOTE_FAILURE} sent audio that is not a phrase`); }
      const roundTrip = performance.now() - started;
      return {audio: answer.bytes.toString('base64'), wav, faces: [], captions: [], timing: {
        voiceProvider: 'omnivoice', voiceEngine: 'omnivoice', voiceSteps: steps, voiceWarm: true, voiceRemote: true,
        ...(wanted.languageReference ? {voiceLanguageReference: timing.voiceLanguageReference === 'used' ? 'used' : 'fallback'} : {}),
        voiceDtype: timing.voiceDtype, voiceRuntime: timing.voiceRuntime, voiceAcceleration: timing.voiceAcceleration || 'eager', voiceGraph: timing.voiceGraph,
        voiceQueueMs: started - queued, voiceGenerationMs: timing.voiceGenerationMs, voiceRoundTripMs: roundTrip,
        ...(Number.isFinite(timing.voiceGenerationMs) ? {voiceNetworkMs: Math.max(0, roundTrip - timing.voiceGenerationMs)} : {})}};
    });
    this.tail = operation.catch(() => {});
    return abortable(operation, signal);
  }

  close() {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve();
    this.control.abort();
    this.loaded = false;
    try { this.agent.destroy(); } catch { /* already gone */ }
    this.publish('stopped');
    return this.closing;
  }
}
