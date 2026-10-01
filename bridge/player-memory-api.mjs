// Narrow natural-LTM adapter. Construction performs zero network operations.
// The provider contract and primary source links are recorded in
// research/cyberpunk/PLAYER_MEMORY_API.md. This adapter has no memory-seeding API.
// historicalPairAllowed({profileKey,characterId}) is a local, synchronous boolean
// authorization callback for durable CONTACTED pairs, used only by clear/inspect.
// It supplements (never replaces) exact provider ownership/marker verification.
const API = 'https://api.convai.com';
const ENDPOINTS = new Set(['/character/list', '/character/get', '/character/update', '/memory/delete-all', '/memory/list']);
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const OMIT_MEMORY_FIELDS = new Set(['enabled', 'ltm_min_credit_cost_e8', 'kb_min_credit_cost_e8']);
const PROFILE_FIELDS = ['character_name', 'backstory', 'speaking_style', 'speaking_style_description', 'sample_dialogue',
  'sample_dialogues', 'voice_type', 'personalised_prompt_config'];

export class PlayerMemoryApiError extends Error {
  constructor(code, {status, writeUncertain = false} = {}) {
    super(`Player memory provider operation failed: ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'PlayerMemoryApiError';
    Object.assign(this, {code, status, writeUncertain: writeUncertain === true});
  }
}
const fail = code => { throw new PlayerMemoryApiError(code); };
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function memoryConfiguration(detail) {
  return JSON.stringify(canonical(Object.fromEntries(Object.entries(detail.memory_settings).filter(([key]) => !OMIT_MEMORY_FIELDS.has(key)))));
}
function cancelBody(body) { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* Already closed/locked. */ } }
function abortable(promise, signal, uncertain = false) {
  if (signal.aborted) return Promise.reject(new PlayerMemoryApiError('CANCELLED', {writeUncertain: uncertain}));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new PlayerMemoryApiError('CANCELLED', {writeUncertain: uncertain}));
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function wait(ms, signal) {
  if (signal.aborted) return Promise.reject(new PlayerMemoryApiError('CANCELLED'));
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new PlayerMemoryApiError('CANCELLED')); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', abort, {once: true});
  });
}
async function boundedJson(response, maxBytes, signal) {
  const advertised = Number(response.headers?.get('content-length'));
  if (Number.isFinite(advertised) && advertised > maxBytes) { cancelBody(response.body); fail('RESPONSE_TOO_LARGE'); }
  const reader = response.body?.getReader();
  if (!reader) fail('INVALID_RESPONSE');
  const parts = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) fail('RESPONSE_TOO_LARGE');
      parts.push(value);
    }
  } catch (error) { cancelBody(reader); throw error; }
  finally { reader.releaseLock(); }
  let result;
  try {
    result = JSON.parse(Buffer.concat(parts, size).toString('utf8'));
    // Core character responses have also historically been JSON-encoded strings.
    if (typeof result === 'string') result = JSON.parse(result);
  } catch { fail('INVALID_RESPONSE'); }
  if (!object(result) || ['ERROR', 'API_ERROR', 'INTERNAL_ERROR'].some(key => Object.hasOwn(result, key))) fail('INVALID_RESPONSE');
  return result;
}

export class PlayerMemoryApi {
  #key; #ids; #fetch; #timeout; #maxBytes; #polls; #interval; #historicalPairAllowed;
  constructor({key, characterIds = {}, fetchImpl = globalThis.fetch, timeoutMs = 15000,
    maxResponseBytes = 4 * 1024 * 1024, maxClearPolls = 5, pollIntervalMs = 250, historicalPairAllowed} = {}) {
    if ((key !== undefined && typeof key !== 'string') || typeof fetchImpl !== 'function'
        || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000
        || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 128 || maxResponseBytes > 8 * 1024 * 1024
        || !Number.isInteger(maxClearPolls) || maxClearPolls < 1 || maxClearPolls > 20
        || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 2000
        || !(characterIds instanceof Map || object(characterIds))
        || (historicalPairAllowed !== undefined && typeof historicalPairAllowed !== 'function')) fail('INVALID_CONFIGURATION');
    this.#ids = new Map(characterIds instanceof Map ? characterIds : Object.entries(characterIds));
    if (this.#ids.size > 1024 || [...this.#ids].some(([profileKey, id]) => !token(profileKey) || !token(id))) fail('INVALID_CONFIGURATION');
    this.#key = key?.trim(); this.#fetch = fetchImpl; this.#timeout = timeoutMs; this.#maxBytes = maxResponseBytes;
    this.#polls = maxClearPolls; this.#interval = pollIntervalMs;
    this.#historicalPairAllowed = historicalPairAllowed;
  }
  #pair({profileKey, characterId, endUserId} = {}, {historical = false} = {}) {
    if (!this.#key) fail('DISABLED');
    if (!token(profileKey) || !token(characterId) || !uuid(endUserId)) fail('INVALID_IDENTITY');
    const owners = [...this.#ids].filter(([, id]) => id === characterId).map(([key]) => key);
    // A durable historical pair may clear/inspect a retired ID after the current
    // config changes. It never authorizes enabling memory or a new conversation,
    // and cannot bypass another configured owner or an ambiguous current ID.
    if (owners.length > 1 || (owners.length === 1 && owners[0] !== profileKey)) fail('CHARACTER_MISMATCH');
    const current = this.#ids.get(profileKey) === characterId && owners.length === 1;
    let allowed = false;
    if (!current && historical && this.#historicalPairAllowed) {
      try {
        const result = this.#historicalPairAllowed(Object.freeze({profileKey, characterId}));
        allowed = result === true;
        // Async callbacks grant nothing. Consume rejection without leaking its
        // exception or turning invalid authorization into an unhandled failure.
        if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
      }
      catch { /* A faulty/unavailable durable store grants no authorization. */ }
    }
    if (!current && !allowed) fail('CHARACTER_MISMATCH');
    return {character_id: characterId, end_user_id: endUserId};
  }
  async #request(endpoint, body, {signal, write = false} = {}) {
    if (!ENDPOINTS.has(endpoint)) fail('INVALID_ENDPOINT');
    if (signal?.aborted) throw new PlayerMemoryApiError('CANCELLED');
    const timeout = new AbortController(), combined = AbortSignal.any([timeout.signal, ...(signal ? [signal] : [])]);
    const timer = setTimeout(() => timeout.abort(), this.#timeout);
    let dispatched = false;
    try {
      dispatched = true;
      const fetching = Promise.resolve(this.#fetch(API + endpoint, {method: 'POST',
        headers: {'Content-Type': 'application/json', 'CONVAI-API-KEY': this.#key},
        body: JSON.stringify(body), signal: combined}));
      fetching.then(response => { if (combined.aborted) cancelBody(response.body); }, () => {});
      const response = await abortable(fetching, combined, write);
      if (!response.ok) {
        cancelBody(response.body);
        throw new PlayerMemoryApiError('HTTP_ERROR', {status: response.status,
          writeUncertain: write && (response.status >= 500 || response.status === 408)});
      }
      const result = await boundedJson(response, this.#maxBytes, combined);
      if (combined.aborted) throw new PlayerMemoryApiError('CANCELLED', {writeUncertain: write});
      return result;
    } catch (error) {
      if (error instanceof PlayerMemoryApiError && error.code === 'HTTP_ERROR') throw error;
      const code = timeout.signal.aborted ? 'TIMEOUT' : signal?.aborted ? 'CANCELLED'
        : error instanceof PlayerMemoryApiError ? error.code : 'NETWORK_ERROR';
      throw new PlayerMemoryApiError(code, {writeUncertain: write && dispatched});
    } finally { clearTimeout(timer); }
  }
  async #run(operation, signal) {
    if (signal?.aborted) throw new PlayerMemoryApiError('CANCELLED');
    const deadline = new AbortController(), combined = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
    const writeState = {uncertain: false}, timer = setTimeout(() => deadline.abort(), this.#timeout);
    try {
      const result = await abortable(operation(combined, writeState), combined);
      if (combined.aborted) throw new PlayerMemoryApiError('CANCELLED', {writeUncertain: writeState.uncertain});
      return result;
    } catch (error) {
      if (deadline.signal.aborted || signal?.aborted) throw new PlayerMemoryApiError(deadline.signal.aborted ? 'TIMEOUT' : 'CANCELLED',
        {writeUncertain: writeState.uncertain});
      if (error instanceof PlayerMemoryApiError) throw error;
      throw new PlayerMemoryApiError('NETWORK_ERROR', {writeUncertain: writeState.uncertain});
    } finally { clearTimeout(timer); }
  }
  async #owned(profileKey, characterId, signal) {
    const roster = await this.#request('/character/list', {}, {signal});
    if (!Array.isArray(roster.characters) || roster.characters.length > 4096) fail('INVALID_RESPONSE');
    if (roster.characters.filter(row => object(row) && row.character_id === characterId).length !== 1) fail('NOT_MOD_OWNED');
    const detail = await this.#request('/character/get', {charID: characterId}, {signal});
    if (detail.character_id !== characterId) fail('CHARACTER_MISMATCH');
    if (typeof detail.backstory !== 'string') fail('NOT_MOD_OWNED');
    const markers = detail.backstory.split(/\r?\n/).map(line => line.trim()).filter(line => /^\[CyberpunkConvai profile v2:.*\]$/.test(line));
    if (markers.length !== 1 || markers[0] !== `[CyberpunkConvai profile v2:${profileKey}]`) fail('NOT_MOD_OWNED');
    return detail;
  }
  enableMemory(options = {}) {
    this.#pair(options);
    const {profileKey, characterId, signal} = options;
    return this.#run(async (combined, writeState) => {
      const before = await this.#owned(profileKey, characterId, combined);
      if (!object(before.memory_settings) || typeof before.memory_settings.enabled !== 'boolean') fail('INVALID_RESPONSE');
      if (before.memory_settings.enabled) return {enabled: true, changed: false};
      writeState.uncertain = true;
      const ack = await this.#request('/character/update', {charID: characterId, memorySettings: {enabled: true}}, {signal: combined, write: true});
      if (ack.STATUS !== 'SUCCESS') throw new PlayerMemoryApiError('ENABLE_UNVERIFIED', {writeUncertain: true});
      try {
        const after = await this.#request('/character/get', {charID: characterId}, {signal: combined});
        if (after.character_id !== characterId || !object(after.memory_settings) || after.memory_settings.enabled !== true
            || typeof after.backstory !== 'string' || !after.backstory.split(/\r?\n/).some(line => line.trim() === `[CyberpunkConvai profile v2:${profileKey}]`)) {
          throw new PlayerMemoryApiError('ENABLE_UNVERIFIED', {writeUncertain: true});
        }
        if (memoryConfiguration(before) !== memoryConfiguration(after) || PROFILE_FIELDS.some(field =>
          JSON.stringify(canonical(before[field])) !== JSON.stringify(canonical(after[field])))) {
          throw new PlayerMemoryApiError('CONFIGURATION_DRIFT', {writeUncertain: true});
        }
        return {enabled: true, changed: true};
      } catch (error) {
        throw new PlayerMemoryApiError(error instanceof PlayerMemoryApiError ? error.code : 'ENABLE_UNVERIFIED', {writeUncertain: true});
      }
    }, signal);
  }
  async #empty(pair, signal) {
    const value = await this.#request('/memory/list', {...pair, page: 1, page_size: 1}, {signal});
    if (!Array.isArray(value.memories) || value.memories.length > 1 || !Number.isSafeInteger(value.total_count)
        || value.total_count < 0 || typeof value.has_more !== 'boolean' || value.page !== 1 || value.page_size !== 1
        || (value.total_count === 0 && (value.memories.length !== 0 || value.has_more))
        || (value.total_count > 0 && value.memories.length !== 1)
        || value.has_more !== (value.total_count > 1)) fail('INVALID_RESPONSE');
    return value.total_count === 0 && value.memories.length === 0 && value.has_more === false;
  }
  clearMemory(options = {}) {
    const identity = Object.freeze({profileKey: options.profileKey, characterId: options.characterId, endUserId: options.endUserId});
    const pair = this.#pair(identity, {historical: true}), {profileKey, characterId} = identity, {signal} = options;
    return this.#run(async (combined, writeState) => {
      await this.#owned(profileKey, characterId, combined);
      this.#pair(identity, {historical: true});
      writeState.uncertain = true;
      const ack = await this.#request('/memory/delete-all', pair, {signal: combined, write: true});
      if (typeof ack.message !== 'string' || !ack.message.trim() || ack.message.length > 1000
          || (ack.character_id !== undefined && ack.character_id !== pair.character_id)
          || (ack.end_user_id !== undefined && ack.end_user_id !== pair.end_user_id)) {
        throw new PlayerMemoryApiError('CLEAR_UNVERIFIED', {writeUncertain: true});
      }
      try {
        for (let attempt = 0; attempt < this.#polls; attempt++) {
          if (await this.#empty(pair, combined)) return {accepted: true, providerEmptyObserved: true};
          if (attempt + 1 < this.#polls) await wait(this.#interval, combined);
        }
        return {accepted: true, providerEmptyObserved: false};
      } catch (error) {
        throw new PlayerMemoryApiError(error instanceof PlayerMemoryApiError ? error.code : 'CLEAR_UNVERIFIED', {writeUncertain: true});
      }
    }, signal);
  }
  inspectMemory(options = {}) {
    const identity = Object.freeze({profileKey: options.profileKey, characterId: options.characterId, endUserId: options.endUserId});
    const pair = this.#pair(identity, {historical: true}), {profileKey, characterId} = identity, {signal} = options;
    return this.#run(async combined => {
      await this.#owned(profileKey, characterId, combined);
      this.#pair(identity, {historical: true});
      return {providerEmptyObserved: await this.#empty(pair, combined)};
    }, signal);
  }
}
