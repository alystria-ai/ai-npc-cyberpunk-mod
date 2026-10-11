// Mistral chat completions client (docs/MISTRAL.md): one streamed request, an SSE parser, bounded retries and errors mapped to the
// few things a player can act on.
//
// The player's API key is used for exactly one thing: the Authorization header of a request to api.mistral.ai. It is never put in
// a message, a log line, an error text or a state file; every message that leaves this module goes through `redact`. A different
// endpoint is accepted only when it is on this computer (the tests' fake server).
export const MISTRAL_ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';
export const MISTRAL_MODELS_ENDPOINT = 'https://api.mistral.ai/v1/models';
// The conversation models, best first. Mistral Small follows a persona best; the free plan's allowance differs by model and account
// (measured 11 Oct 2026: Small and Medium had a request allowance of 0 on a free account while the Ministral models answered at
// 30 to 750 requests a minute), so a model whose allowance is 0 is skipped for a while and the next one is used.
export const DEFAULT_MODELS = Object.freeze(['mistral-small-latest', 'ministral-14b-latest', 'ministral-8b-latest']);
export const DEFAULT_MODEL = DEFAULT_MODELS[0];

// A Mistral key has no recognisable prefix, so only the exact key is removed, plus any long unbroken run of letters and digits
// that an error text might echo.
const KEY_SHAPE = /\b[A-Za-z0-9]{28,}\b/g;

/** Text with the key (when given) and anything shaped like one removed. */
export function redact(text, apiKey) {
  let out = String(text ?? '');
  if (typeof apiKey === 'string' && apiKey.length >= 8) out = out.split(apiKey).join('[key]');
  return out.replace(KEY_SHAPE, '[key]');
}

/**
 * kind: 'key' (not accepted), 'limit' (the free plan's rate limit or allowance), 'model' (the model is not available to this
 * account), 'network' (unreachable, timed out or a server fault), 'empty' (the model answered nothing), 'request' (a refused request).
 * The message carries `[mistral:<kind>]` so the bridge can classify a failure from its text alone, like convai-quota.mjs.
 */
export class MistralError extends Error {
  constructor(kind, detail, {status, retryAfterMs, apiKey, zeroQuota = false} = {}) {
    super(`Mistral ${redact(detail, apiKey).slice(0, 200)} [mistral:${kind}]`);
    this.name = 'MistralError';
    // zeroQuota: the account has no allowance at all for this model (retrying cannot help; another model may work).
    Object.assign(this, {kind, status, retryAfterMs, zeroQuota});
  }
}

export const MISTRAL_MARKER = /\[mistral:(key|limit|model|network|empty|request)\]/;

/** The failure kind in an error's text ('key', 'limit', 'model', ...) or null. */
export function failureKind(error) {
  const text = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
  const match = MISTRAL_MARKER.exec(text);
  return match ? match[1] : null;
}

/** The game's notice code for a failure, or undefined (the ordinary reply-error text is used). */
export function errorCodeFor(error) {
  const kind = failureKind(error);
  return kind === 'key' ? 'mistral-key' : kind === 'limit' ? 'mistral-limit' : kind === 'model' ? 'mistral-model' : undefined;
}

const textOf = body => {
  const error = body?.error;
  const message = body?.message ?? (typeof error === 'string' ? error : error?.message) ?? body?.detail;
  return typeof message === 'string' ? message : Array.isArray(message) || (message && typeof message === 'object') ? JSON.stringify(message) : '';
};

function retryAfter(headers) {
  const raw = headers?.get?.('retry-after');
  const seconds = raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 60) * 1000 : undefined;
}

/** Maps an HTTP status (or the `code` of an error object inside a stream) and its body to a MistralError. */
export function mapFailure(status, body, {headers, apiKey} = {}) {
  const text = textOf(body), lower = text.toLowerCase();
  const detail = text || `HTTP ${status}`;
  const zero = name => headers?.get?.(name) === '0';
  const options = {status, retryAfterMs: retryAfter(headers), apiKey,
    zeroQuota: status === 429 && (zero('x-ratelimit-limit-req-minute') || zero('x-ratelimit-limit-tokens-minute'))};
  if (status === 401 || status === 403) return new MistralError('key', 'did not accept the API key', options);
  // The free plan allows about one request a second and a monthly allowance; the first clears in a second, so it is retried.
  if (status === 429) return new MistralError('limit', 'rate limited', options);
  if (status === 404 || ((status === 400 || status === 422) && /model/.test(lower))) return new MistralError('model', detail, options);
  if (status === 408 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529) return new MistralError('network', detail, options);
  return new MistralError('request', detail, options);
}

/** Retry only what clears by itself: the per-second limit, a server fault, a timeout, an empty answer. Never a bad key. */
export const retryable = error => error instanceof MistralError && !error.zeroQuota && (error.kind === 'network' || error.kind === 'empty' || error.kind === 'limit');

// ---- SSE ---------------------------------------------------------------------------------------------------------------

/**
 * Parses a server-sent-events byte stream into data strings. Handles CRLF, comment lines (keep-alives start with a colon and are
 * ignored), events split over any number of chunks, several data lines per event and UTF-8 characters cut between chunks. Yields
 * the joined `data:` payload of each event; "[DONE]" is yielded as is.
 */
export async function* sseData(body) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '', data = [];
  const flush = () => {
    if (!data.length) return undefined;
    const joined = data.join('\n'); data = [];
    return joined;
  };
  const lines = text => text.split(/\r\n|\n|\r/);
  const handle = line => {
    if (line === '') return flush();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== 'data') return undefined;
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    data.push(value);
    return undefined;
  };
  const reader = body.getReader ? body.getReader() : null;
  const chunks = reader ? (async function* () {
    for (;;) { const {done, value} = await reader.read(); if (done) return; yield value; }
  })() : body;
  try {
    for await (const chunk of chunks) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, {stream: true});
      // A CR at the very end may be the first half of a CRLF: keep it for the next chunk.
      const hold = buffer.endsWith('\r') ? 1 : 0;
      const complete = buffer.slice(0, buffer.length - hold);
      const parts = lines(complete);
      buffer = parts.pop() + (hold ? '\r' : '');
      for (const line of parts) { const event = handle(line); if (event !== undefined) yield event; }
    }
    buffer += decoder.decode();
    for (const line of lines(buffer)) { const event = handle(line); if (event !== undefined) yield event; }
    const last = flush();
    if (last !== undefined) yield last;
  } finally {
    try { await reader?.cancel(); } catch { /* already closed */ }
  }
}

// ---- Request -----------------------------------------------------------------------------------------------------------

const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])$/;
function checkedEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol === 'https:' && url.hostname === 'api.mistral.ai') return url.href;
  if ((url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK.test(url.hostname)) return url.href;
  throw Error('The Mistral key is only ever sent to api.mistral.ai');
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? abortError());
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason ?? abortError()); };
  signal?.addEventListener('abort', abort, {once: true});
});
const abortError = () => { const error = Error('Conversation cancelled'); error.name = 'AbortError'; return error; };

// A delta's content is a string; a model that returns structured content gives a list of {type: 'text', text} parts.
const contentText = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => typeof part === 'string' ? part : part?.type === 'text' && typeof part.text === 'string' ? part.text : '').join('') : '';

/**
 * One streamed chat completion with retries.
 *   apiKey, model, messages [{role, content}], maxTokens, temperature
 *   onDelta(text, soFar): called for each piece of reply text
 *   shouldStop(soFar): return true to end the reply early (the reply length cap); the stream is cancelled and the text so far is returned
 *   signal: the caller's cancellation; firstByteMs / totalMs: timeouts; retries / backoffMs: for 429, 5xx, a timeout, an empty answer
 * Returns {text, model, finishReason, usage, attempts}.
 */
export async function streamChat({apiKey, model = DEFAULT_MODEL, messages, maxTokens = 300, temperature = 0.8, onDelta, shouldStop,
  signal, fetchImpl = globalThis.fetch, endpoint = MISTRAL_ENDPOINT, firstByteMs = 25000, totalMs = 70000, retries = 2,
  backoffMs = [1200, 3500], sleepImpl = sleep, extraBody} = {}) {
  if (typeof apiKey !== 'string' || apiKey.length < 8) throw new MistralError('key', 'has no API key');
  const url = checkedEndpoint(endpoint);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw signal.reason ?? abortError();
    try {
      const result = await once({apiKey, model, messages, maxTokens, temperature, onDelta, shouldStop, signal, fetchImpl, url, firstByteMs,
        totalMs, extraBody});
      return {...result, attempts: attempt + 1};
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' && !(error instanceof MistralError)) throw signal?.aborted ? (signal.reason ?? abortError()) : error;
      lastError = error instanceof MistralError ? error : new MistralError('network', redact(error?.message ?? 'request failed', apiKey), {apiKey});
      if (attempt >= retries || !retryable(lastError)) throw lastError;
      const wait = Math.min(lastError.retryAfterMs ?? backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 2000, 8000);
      await sleepImpl(wait, signal);
    }
  }
  throw lastError;
}

async function once({apiKey, model, messages, maxTokens, temperature, onDelta, shouldStop, signal, fetchImpl, url, firstByteMs, totalMs, extraBody}) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, {once: true});
  const total = setTimeout(() => { timedOut = true; controller.abort(); }, totalMs);
  let first = setTimeout(() => { timedOut = true; controller.abort(); }, firstByteMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {method: 'POST', signal: controller.signal,
        headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream'},
        body: JSON.stringify({model, messages, stream: true, max_tokens: maxTokens, temperature, ...extraBody})});
    } catch (error) {
      if (timedOut) throw new MistralError('network', 'did not answer in time', {apiKey});
      if (signal?.aborted) throw signal.reason ?? abortError();
      throw new MistralError('network', `could not be reached (${redact(error?.cause?.code ?? error?.message ?? 'network error', apiKey)})`, {apiKey});
    }
    if (!response.ok) {
      let body; try { body = await response.json(); } catch { /* no JSON body */ }
      throw mapFailure(response.status, body, {headers: response.headers, apiKey});
    }
    if (!response.body) throw new MistralError('network', 'sent no reply stream', {apiKey});
    let text = '', actualModel, finishReason, usage, stoppedEarly = false;
    try {
      for await (const data of sseData(response.body)) {
        clearTimeout(first);
        if (data === '[DONE]') break;
        let chunk; try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk?.object === 'error' || chunk?.error) throw mapFailure(Number.isInteger(chunk.code) ? chunk.code : Number.isInteger(chunk.error?.code) ? chunk.error.code : 502, chunk, {apiKey});
        if (typeof chunk?.model === 'string') actualModel = chunk.model;
        if (chunk?.usage) usage = chunk.usage;
        const choice = chunk?.choices?.[0];
        if (!choice) continue;
        const piece = contentText(choice.delta?.content);
        if (piece) {
          text += piece;
          onDelta?.(piece, text);
          if (shouldStop?.(text)) { stoppedEarly = true; break; }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (choice.finish_reason === 'error') throw new MistralError('network', 'stopped the reply with an error', {apiKey});
      }
    } catch (error) {
      if (timedOut) throw new MistralError('network', 'did not finish in time', {apiKey});
      if (signal?.aborted) throw signal.reason ?? abortError();
      throw error;
    }
    if (!text.trim()) throw new MistralError('empty', 'answered with no text', {apiKey});
    return {text, model: actualModel, finishReason: stoppedEarly ? 'stop' : finishReason, usage};
  } finally {
    clearTimeout(first); clearTimeout(total);
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

/** The key check: one authenticated GET of the model list (no completion is used). 'valid', 'invalid' or 'unknown'. */
export async function validateKey(apiKey, {fetchImpl = globalThis.fetch, endpoint = MISTRAL_MODELS_ENDPOINT, timeoutMs = 10000} = {}) {
  try {
    const url = checkedEndpoint(endpoint);
    const response = await fetchImpl(url, {headers: {Authorization: `Bearer ${apiKey}`, Accept: 'application/json'}, signal: AbortSignal.timeout(timeoutMs)});
    try { await response.body?.cancel(); } catch { /* already closed */ }
    if (response.ok) return 'valid';
    return response.status === 401 || response.status === 403 ? 'invalid' : 'unknown';
  } catch { return 'unknown'; }
}
