// Explicit REST operations only. Constructing this adapter never connects,
// enables character memory, generates dialogue, or retries a write.
const API = 'https://api.convai.com';
const ENDPOINTS = new Set(['/memory/add', '/memory/list', '/memory/get', '/memory/delete', '/memory/delete-all']);
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(value);
export const normalizeMemoryText = value => typeof value === 'string' ? value.normalize('NFC').replace(/\s+/gu, ' ').trim() : '';

export class ConvaiMemoryError extends Error {
  constructor(code, {status, writeUncertain = false, retryable = false} = {}) {
    super(`Convai memory operation failed: ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'ConvaiMemoryError';
    Object.assign(this, {code, status, writeUncertain, retryable});
  }
}

function boundedText(value) {
  const text = normalizeMemoryText(value);
  if (!text || text.length > 6000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw new ConvaiMemoryError('INVALID_TEXT');
  return text;
}
function pair({characterId, endUserId} = {}) {
  if (!token(characterId) || !token(endUserId)) throw new ConvaiMemoryError('INVALID_IDENTITY');
  return {character_id: characterId, end_user_id: endUserId};
}
function memoryRecord(value) {
  if (!value || !token(value.id) || typeof value.memory !== 'string' || !normalizeMemoryText(value.memory)
      || value.memory.length > 12000) throw new ConvaiMemoryError('INVALID_RESPONSE');
  const result = {id: value.id, memory: value.memory};
  for (const key of ['created_at', 'updated_at', 'event']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' || value[key].length > 100) throw new ConvaiMemoryError('INVALID_RESPONSE');
      result[key] = value[key];
    }
  }
  return result;
}
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new ConvaiMemoryError('CANCELLED'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ConvaiMemoryError('CANCELLED'));
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function cancelBody(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* Already locked/closed. */ }
}
async function readJson(response, maxBytes, signal) {
  const advertised = Number(response.headers?.get('content-length'));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    cancelBody(response.body); throw new ConvaiMemoryError('RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ConvaiMemoryError('INVALID_RESPONSE');
  let size = 0;
  const parts = [];
  try {
    for (;;) {
      const {done, value} = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ConvaiMemoryError('RESPONSE_TOO_LARGE');
      parts.push(value);
    }
  } catch (error) { cancelBody(reader); throw error; }
  finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(parts, size).toString('utf8')); }
  catch { throw new ConvaiMemoryError('INVALID_RESPONSE'); }
}

export class ConvaiMemoryAdapter {
  constructor({key, enabled = false, fetchImpl = globalThis.fetch, timeoutMs = 15000, maxResponseBytes = 1024 * 1024} = {}) {
    if (typeof key !== 'string' || !key.trim() || typeof fetchImpl !== 'function'
        || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000
        || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 128 || maxResponseBytes > 8 * 1024 * 1024) {
      throw new ConvaiMemoryError('INVALID_CONFIGURATION');
    }
    // Keep the credential out of enumerable diagnostics/JSON snapshots.
    Object.defineProperty(this, '_key', {value: key});
    Object.assign(this, {enabled: enabled === true, fetchImpl, timeoutMs, maxResponseBytes});
  }
  async request(endpoint, body, {signal, write = false, validate = value => value} = {}) {
    if (!ENDPOINTS.has(endpoint)) throw new ConvaiMemoryError('INVALID_ENDPOINT');
    if (!this.enabled) throw new ConvaiMemoryError('DISABLED');
    if (signal?.aborted) throw new ConvaiMemoryError('CANCELLED');
    const timeout = new AbortController(), combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    let dispatched = false;
    try {
      dispatched = true;
      // redirect 'error': fetch would forward the CONVAI-API-KEY header (only Authorization is stripped) to another host.
      const fetching = Promise.resolve(this.fetchImpl(API + endpoint, {method: 'POST', redirect: 'error',
        headers: {'Content-Type': 'application/json', 'CONVAI-API-KEY': this._key},
        body: JSON.stringify(body), signal: combined}));
      // Bound even an injected transport that ignores AbortSignal. A late
      // response is discarded and its body cancelled, never treated as an ack.
      fetching.then(response => { if (combined.aborted) cancelBody(response.body); }, () => {});
      const response = await abortable(fetching, combined);
      if (!response.ok) {
        cancelBody(response.body);
        // A 5xx/timeout may occur after the server committed a write. Do not
        // echo response bodies: provider errors can contain submitted text.
        throw new ConvaiMemoryError('HTTP_ERROR', {status: response.status,
          writeUncertain: write && (response.status >= 500 || response.status === 408),
          retryable: !write && (response.status >= 500 || [408, 429].includes(response.status))});
      }
      const result = validate(await readJson(response, this.maxResponseBytes, combined));
      if (combined.aborted) throw new ConvaiMemoryError(timeout.signal.aborted ? 'TIMEOUT' : 'CANCELLED');
      return result;
    } catch (error) {
      if (error instanceof ConvaiMemoryError && error.code === 'HTTP_ERROR') throw error;
      const code = timeout.signal.aborted ? 'TIMEOUT' : signal?.aborted ? 'CANCELLED'
        : error instanceof ConvaiMemoryError ? error.code : 'NETWORK_ERROR';
      throw new ConvaiMemoryError(code, {writeUncertain: write && dispatched,
        retryable: !write && ['TIMEOUT', 'NETWORK_ERROR'].includes(code)});
    } finally { clearTimeout(timer); }
  }
  add({characterId, endUserId, memories, signal} = {}) {
    const body = pair({characterId, endUserId});
    if (!Array.isArray(memories) || !memories.length || memories.length > 32) throw new ConvaiMemoryError('INVALID_BATCH');
    body.memories = memories.map(boundedText);
    return this.request('/memory/add', body, {signal, write: true, validate(value) {
      if (!Array.isArray(value?.memories) || !value.memories.length || value.memories.length > 256) throw new ConvaiMemoryError('INVALID_RESPONSE');
      return {memories: value.memories.map(memoryRecord)};
    }});
  }
  list({characterId, endUserId, page = 1, pageSize = 50, signal} = {}) {
    const body = pair({characterId, endUserId});
    if (!Number.isInteger(page) || page < 1 || page > 1000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new ConvaiMemoryError('INVALID_PAGINATION');
    }
    Object.assign(body, {page, page_size: pageSize});
    return this.request('/memory/list', body, {signal, validate(value) {
      if (!Array.isArray(value?.memories) || value.memories.length > 100 || !Number.isSafeInteger(value.total_count)
          || value.total_count < 0 || typeof value.has_more !== 'boolean'
          || value.page !== page || value.page_size !== pageSize) throw new ConvaiMemoryError('INVALID_RESPONSE');
      return {memories: value.memories.map(memoryRecord), total_count: value.total_count,
        has_more: value.has_more, page, page_size: pageSize};
    }});
  }
  get({characterId, endUserId, memoryId, signal} = {}) {
    const body = pair({characterId, endUserId});
    if (!token(memoryId)) throw new ConvaiMemoryError('INVALID_MEMORY_ID');
    return this.request('/memory/get', {...body, memory_id: memoryId}, {signal, validate(value) {
      const record = memoryRecord(value);
      if (record.id !== memoryId) throw new ConvaiMemoryError('INVALID_RESPONSE');
      return record;
    }});
  }
  delete({characterId, endUserId, memoryId, signal} = {}) {
    const body = pair({characterId, endUserId});
    if (!token(memoryId)) throw new ConvaiMemoryError('INVALID_MEMORY_ID');
    return this.request('/memory/delete', {...body, memory_id: memoryId}, {signal, write: true, validate(value) {
      if (value?.memory_id !== memoryId || typeof value.deleted !== 'boolean') throw new ConvaiMemoryError('INVALID_RESPONSE');
      return {memory_id: memoryId, deleted: value.deleted};
    }});
  }
  deleteAll({characterId, endUserId, signal} = {}) {
    const body = pair({characterId, endUserId});
    return this.request('/memory/delete-all', body, {signal, write: true, validate(value) {
      if (typeof value?.message !== 'string' || value.message.length > 1000) throw new ConvaiMemoryError('INVALID_RESPONSE');
      if (value.character_id !== undefined && value.character_id !== characterId) throw new ConvaiMemoryError('INVALID_RESPONSE');
      if (value.end_user_id !== undefined && value.end_user_id !== endUserId) throw new ConvaiMemoryError('INVALID_RESPONSE');
      // The endpoint schedules asynchronous deletion; it does not prove empty.
      return {accepted: true, verifiedEmpty: false, characterId, endUserId};
    }});
  }
  async scan({characterId, endUserId, maxPages = 20, signal} = {}) {
    pair({characterId, endUserId});
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new ConvaiMemoryError('INVALID_PAGINATION');
    const memories = [], seen = new Set();
    for (let page = 1; page <= maxPages; page++) {
      const result = await this.list({characterId, endUserId, page, pageSize: 100, signal});
      for (const record of result.memories) if (!seen.has(record.id)) { seen.add(record.id); memories.push(record); }
      if (!result.has_more) return {characterId, endUserId, memories, complete: true};
    }
    return {characterId, endUserId, memories, complete: false};
  }
}
