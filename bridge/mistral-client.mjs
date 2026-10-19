// Chat completions client for the OpenAI-compatible text providers (docs/MISTRAL.md, docs/LOCAL_AI.md, docs/CUSTOM_PROVIDER.md): Mistral (the original),
// the local llama.cpp server and the player's own endpoint ('custom': OpenRouter, Nano-GPT, Ollama, LM Studio, any OpenAI-style server).
// One streamed request, an SSE parser, bounded retries and errors mapped to the few things a player can act on. `provider` ('mistral'
// default, 'local', 'custom') picks the wording and marker of errors and the hosts a key may go to. Everything 'custom' adds (an optional key,
// the retry without a parameter the server refuses, a reply that is not streamed, 402, a Retry-After that is honoured) is behind that value:
// a Mistral or local request is built and handled exactly as before.
//
// The player's API key is used for exactly one thing: the Authorization header of a request to its own provider (api.mistral.ai). It is never put in a message, a log line, an error text or a state file; every message that leaves this module goes
// through `redact`. A different endpoint is accepted only when it is on this computer (the tests' fake server, the local AI), or when the caller
// names its exact origin as `trustedOrigin`: a server the player runs themselves (bridge/custom-models.mjs, an `endpoint` entry) on the local network
// or, with the player's explicit "remote": true, anywhere; the key then goes to that origin and to no other.
import {markStage} from './turn-clock.mjs';
export const MISTRAL_ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';
export const MISTRAL_MODELS_ENDPOINT = 'https://api.mistral.ai/v1/models';
// The conversation models, fastest first. The free plan's allowance differs by model and account (measured 11 Oct 2026: Small and
// Medium had a request allowance of 0 on a free account while the Ministral models answered at 30 to 750 requests a minute), so
// Small is not listed, and a model whose allowance is 0 is skipped for a while and the next one is used. `ministral-8b` answers
// in about 1 s and follows a persona well; `14b` is richer but slower (docs/FREE_CLOUD_OPTION_RESEARCH.md).
export const DEFAULT_MODELS = Object.freeze(['ministral-8b-latest', 'ministral-14b-latest', 'ministral-3b-latest']);
export const DEFAULT_MODEL = DEFAULT_MODELS[0];
// The companion-action decision (bridge/text-actions.mjs) is one word read from V's message, so the smallest model answers it: measured with
// scripts/Eval-MistralPrompt.mjs --actions --decision-only on 54 lines (14 Oct 2026), `ministral-3b` had recall 97% and no false trigger at a
// p50/p90 of 475/760 ms against 8b's 97-100% recall, one false trigger and 510-590/940 ms. The reply keeps DEFAULT_MODELS; 8b is the fallback.
export const DECISION_MODELS = Object.freeze(['ministral-3b-latest', 'ministral-8b-latest']);

// A Mistral key has no recognisable prefix, so only the exact key is removed, plus any long unbroken run of letters and digits
// that an error text might echo.
const KEY_SHAPE = /\b[A-Za-z0-9]{28,}\b/g;

/** Text with the key (when given) and anything shaped like one removed. */
export function redact(text, apiKey) {
  let out = String(text ?? '');
  if (typeof apiKey === 'string' && apiKey.length >= 8) out = out.split(apiKey).join('[key]');
  return out.replace(KEY_SHAPE, '[key]');
}

const PROVIDER_LABELS = Object.freeze({mistral: 'Mistral', local: 'The local AI', custom: 'The custom provider'});

/**
 * kind: 'key' (not accepted), 'limit' (the free plan's rate limit or allowance), 'model' (the model is not available to this
 * account), 'network' (unreachable, timed out or a server fault), 'empty' (the model answered nothing), 'request' (a refused request),
 * 'credits' (custom only: the account has no credit left, HTTP 402).
 * The message carries `[mistral:<kind>]` so the bridge can classify a failure from its text alone, like convai-quota.mjs.
 */
export class MistralError extends Error {
  constructor(kind, detail, {status, retryAfterMs, apiKey, zeroQuota = false, provider = 'mistral', slow = false, partial = false} = {}) {
    provider = PROVIDER_LABELS[provider] ? provider : 'mistral';
    super(`${PROVIDER_LABELS[provider]} ${redact(detail, apiKey).slice(0, 200)} [${provider}:${kind}]`);
    this.name = 'MistralError';
    // The words of the server's own answer (redacted), for the custom provider's connection test, which shows them to the player.
    if (provider === 'custom') this.detail = redact(detail, apiKey).slice(0, 160);
    // zeroQuota: the account has no allowance at all for this model (retrying cannot help; another model may work).
    // slow: the service was reachable but did not answer in time (no response, or a stream that went quiet), or answered with a server
    // fault; the caller may speak a short in-character line instead of an error (docs/MISTRAL.md).
    // partial: some of the reply had already been delivered (a retry would say it twice).
    Object.assign(this, {kind, status, retryAfterMs, zeroQuota, provider, slow, partial});
  }
}

export const MISTRAL_MARKER = /\[(?:mistral|local|custom):(key|limit|model|network|empty|request|credits)\]/;

/** The failure kind in an error's text ('key', 'limit', 'model', ...) or null. */
export function failureKind(error) {
  const text = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
  const match = MISTRAL_MARKER.exec(text);
  return match ? match[1] : null;
}

/** The game's notice code for a failure, or undefined (the ordinary reply-error text is used). */
export function errorCodeFor(error) {
  const kind = failureKind(error);
  const text = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
  const provider = /\[(mistral|local|custom):/.exec(text)?.[1] ?? 'mistral';
  // The local AI has no key or limit of its own. A server that could not be started has its own code in the bridge (local-fallback);
  // any other failure of a turn (a refused prompt, no answer, a server that went away) is 'local-failed'.
  if (provider === 'local') return kind ? 'local-failed' : undefined;
  // The custom provider: its own five notices (a failure of any other kind, a refused prompt or an empty answer, is the ordinary "no answer").
  if (provider === 'custom') return kind === 'key' ? 'custom-key' : kind === 'credits' ? 'custom-credits' : kind === 'limit' ? 'custom-limit'
    : kind === 'model' ? 'custom-model' : kind === 'network' ? 'custom-unreachable' : undefined;
  return kind === 'key' ? `${provider}-key` : kind === 'limit' ? `${provider}-limit` : kind === 'model' ? `${provider}-model` : undefined;
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

// Retry-After as a server may send it: a number of seconds or an HTTP date. The custom provider honours it up to an hour (a server that
// says "tomorrow" is believed); the Mistral reader above stays capped at a minute.
function customRetryAfter(headers, now = Date.now()) {
  const raw = headers?.get?.('retry-after');
  if (raw === null || raw === undefined || String(raw).trim() === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.min(seconds, 3600) * 1000 : undefined;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(Math.max(at - now, 0), 3600_000) : undefined;
}

// The optional request fields the custom provider sends, and the ones a server may refuse. A server's refusal names the field, or at least
// says "unsupported parameter"; the request is then sent once more without it (or, for max_tokens that a newer OpenAI model replaced by
// max_completion_tokens, with the new name) and the choice is remembered for the session (`adapt`, see streamChat).
const DROPPABLE = Object.freeze(['stream_options', 'response_format', 'temperature', 'prompt_cache_key', 'top_p', 'max_completion_tokens']);
const REFUSAL_WORDS = /unsupported|not supported|unknown|unrecogni[sz]ed|unexpected|not permitted|not allowed|not accepted|extra (?:inputs?|fields?|forbidden)|extra_forbidden|invalid (?:parameter|param|field|argument)|additional propert|does not support|only the default|invalid_request_error.*param/;
const FIELD_WORDS = /parameter|param\b|field|argument|propert/;
const NO_SUCH_MODEL = /(?:model|endpoint)s?\b.{0,60}\b(?:not found|does not exist|not a valid|no such|unknown|not available|is not supported)|no endpoints found|invalid model/;

/**
 * What a 400 or 422 says about a request field, or null when it is not a refusal of one: {names: [fields it names], swap: max_tokens is
 * to be sent as max_completion_tokens}. `names` is empty when the answer says a parameter is unsupported without naming it (all the
 * optional fields then go). A message about the model itself ("model not found") is not a refusal of a field.
 */
export function rejectedParameters(status, text) {
  if (status !== 400 && status !== 422) return null;
  const lower = String(text ?? '').toLowerCase();
  if (!REFUSAL_WORDS.test(lower)) return null;
  const names = DROPPABLE.filter(name => lower.includes(name));
  if (/\bstream\b/.test(lower.replace(/stream_options/g, ''))) names.push('stream');
  const swap = /\bmax_tokens\b/.test(lower) && /max_completion_tokens/.test(lower);
  if (/\bmax_tokens\b/.test(lower) && !swap) names.push('max_tokens');
  if (swap) return {names: names.filter(name => name !== 'max_completion_tokens'), swap: true};
  if (!names.length) return NO_SUCH_MODEL.test(lower) || !FIELD_WORDS.test(lower) ? null : {names: [], swap: false};
  return {names, swap: false};
}

/** Maps what the custom provider answered: the same few kinds, plus 402 (no credit) and a refused request field. */
function mapCustomFailure(status, body, {headers, apiKey}) {
  const text = textOf(body), lower = text.toLowerCase();
  const options = {status, retryAfterMs: customRetryAfter(headers), apiKey, provider: 'custom'};
  // The server's own words travel with the error (redacted) so the connection test can show them; the message names what it means.
  const make = (kind, detail, extra = {}) => {
    const error = new MistralError(kind, detail, {...options, ...extra});
    if (text) error.providerText = redact(text, apiKey).slice(0, 160);
    return error;
  };
  if (status === 401 || status === 403) return make('key', 'did not accept the API key');
  // Some providers answer an account that has spent its credit with 429 ("insufficient_quota") instead of 402.
  if (status === 402 || (status === 429 && /insufficient[_ ]quota|exceeded your current quota|out of credits|insufficient (?:credits|funds|balance)|add (?:more )?credits/.test(lower))) {
    return make('credits', 'has no credit left on this account');
  }
  if (status === 429) {
    const error = make('limit', 'is rate limiting requests');
    // A daily allowance does not clear by waiting a few seconds: no retry.
    error.daily = /per day|per-day|TPD|RPD|daily/i.test(text);
    return error;
  }
  const rejected = rejectedParameters(status, text);
  if (rejected) { const error = make('request', `refused the request: ${text || `HTTP ${status}`}`); error.paramsRejected = rejected; return error; }
  if (status === 404 || ((status === 400 || status === 422) && /model/.test(lower))) return make('model', `does not know that model: ${text || `HTTP ${status}`}`);
  if (status === 408 || (status >= 500 && status <= 599)) return make('network', `had a server fault (HTTP ${status})`, {slow: true});
  return make('request', `refused the request: ${text || `HTTP ${status}`}`);
}

/** Maps an HTTP status (or the `code` of an error object inside a stream) and its body to a MistralError. */
export function mapFailure(status, body, {headers, apiKey, provider} = {}) {
  if (provider === 'custom') return mapCustomFailure(status, body, {headers, apiKey});
  const text = textOf(body), lower = text.toLowerCase();
  const detail = text || `HTTP ${status}`;
  const zero = name => headers?.get?.(name) === '0';
  const options = {status, retryAfterMs: retryAfter(headers), apiKey, provider,
    zeroQuota: status === 429 && (zero('x-ratelimit-limit-req-minute') || zero('x-ratelimit-limit-tokens-minute'))};
  if (status === 401 || status === 403) return new MistralError('key', 'did not accept the API key', options);
  // The free plan allows about one request a second and a monthly allowance; the first clears in a second, so it is retried.
  if (status === 429) {
    const error = new MistralError('limit', 'rate limited', options);
    // A daily allowance does not clear by waiting a few seconds: no retry (the body's words are the only hint).
    error.daily = /per day|TPD|RPD|daily/i.test(lower);
    return error;
  }
  // llama-server refuses a prompt longer than its context and says how many tokens it counted (docs/LOCAL_AI.md, "Context budget").
  if (status === 400 && (body?.error?.type === 'exceed_context_size_error' || /exceeds the available context size/i.test(text))) {
    const counted = /request \((\d+) tokens\).*\((\d+) tokens\)/.exec(text);
    const error = new MistralError('request', detail, options);
    error.overflow = {promptTokens: Number(body?.error?.n_prompt_tokens ?? counted?.[1]) || undefined, contextTokens: Number(body?.error?.n_ctx ?? counted?.[2]) || undefined};
    return error;
  }
  if (status === 404 || ((status === 400 || status === 422) && /model/.test(lower))) return new MistralError('model', detail, options);
  if (status === 408 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529) return new MistralError('network', detail, {...options, slow: true});
  return new MistralError('request', detail, options);
}

/** Retry only what clears by itself: the per-second limit, a server fault, a timeout, an empty answer. Never a bad key. */
export const retryable = error => error instanceof MistralError && !error.zeroQuota && !error.daily && !error.partial
  && (error.kind === 'network' || error.kind === 'empty' || error.kind === 'limit');

// ---- SSE ---------------------------------------------------------------------------------------------------------------

/**
 * Parses a server-sent-events byte stream into data strings. Handles CRLF, comment lines (keep-alives start with a colon and are
 * ignored), events split over any number of chunks, several data lines per event and UTF-8 characters cut between chunks. Yields
 * the joined `data:` payload of each event; "[DONE]" is yielded as is.
 * `drainMs`: when the caller stops right after "[DONE]", the rest of the body (a few bytes) is read for at most this long, so the
 * connection can be reused by the next request (a body that is cancelled instead has its connection closed); 0 cancels at once.
 * Any other early exit (an error, the reply cap) cancels the body.
 * `setTimer` / `clearTimer`: the drain limit's timer (default `setTimeout` / `clearTimeout`; a test passes a manual clock's).
 */
export async function* sseData(body, {drainMs = 0, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '', data = [], sawDone = false;
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
      for (const line of parts) {
        const event = handle(line);
        if (event === undefined) continue;
        if (event === '[DONE]') sawDone = true;
        yield event;
      }
    }
    buffer += decoder.decode();
    for (const line of lines(buffer)) { const event = handle(line); if (event !== undefined) yield event; }
    const last = flush();
    if (last !== undefined) yield last;
  } finally {
    if (reader && sawDone && drainMs > 0) await drain(reader, drainMs, setTimer, clearTimer);
    else try { await reader?.cancel(); } catch { /* already closed */ }
  }
}

/** Reads a stream to its end for at most `ms`; a stream that does not end by then (or fails) is cancelled. Never throws. */
async function drain(reader, ms, setTimer, clearTimer) {
  let timer;
  const late = new Promise(resolve => { timer = setTimer(() => resolve(LATE), ms); });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), late]);
      if (next === LATE) break;
      if (next.done) return;
    }
  } catch { /* the stream failed: nothing left to reuse */ }
  finally { clearTimer(timer); }
  try { await reader.cancel(); } catch { /* already closed */ }
}
const LATE = Symbol('late');

// ---- Request -----------------------------------------------------------------------------------------------------------

const DRAIN_MS = 250;
const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])$/;
const HOSTS = Object.freeze({mistral: 'api.mistral.ai'});
function checkedEndpoint(endpoint, provider = 'mistral', trustedOrigin) {
  const url = new URL(endpoint);
  if (url.protocol === 'https:' && HOSTS[provider] && url.hostname === HOSTS[provider]) return url.href;
  if ((url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK.test(url.hostname)) return url.href;
  // A server the player runs (local) or named themselves (custom): the key goes to the origin the caller names, and to no other.
  if ((provider === 'local' || provider === 'custom') && typeof trustedOrigin === 'string' && trustedOrigin && url.origin === trustedOrigin) return url.href;
  throw Error(`The ${PROVIDER_LABELS[provider] ?? 'Mistral'} key is only ever sent to ${HOSTS[provider] ?? (provider === 'custom' ? 'the saved endpoint' : 'api.mistral.ai')}`);
}

// ---- Connection reuse --------------------------------------------------------------------------------------------------
// Node's built-in fetch (undici) keeps an idle connection for 4 s, far less than the gap between two turns, so every turn paid DNS,
// TCP and TLS again (about 55 to 150 ms, docs/LATENCY_2026-10-13.md section 4.5). The cloud routes get one shared Agent that keeps
// idle connections for 60 s. `undici` is not a dependency and cannot be imported from application code, but the copy inside Node
// is reachable: its global dispatcher is an `Agent`, and its constructor makes another one that the built-in fetch accepts as
// `dispatcher`. Nothing else is changed: the local AI and a test's fake server keep the default client. Any failure to build the
// Agent (a Node without this internal) leaves the default client, which is only slower.
export const KEEP_ALIVE_MS = 60000;
const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');
let remoteAgent; // undefined: not tried; null: not available

/** The shared keep-alive dispatcher for the cloud routes, or undefined. */
async function remoteDispatcher() {
  if (remoteAgent !== undefined) return remoteAgent ?? undefined;
  try {
    // Node creates its global dispatcher on the first fetch; a data: URL makes that without touching the network.
    if (!globalThis[GLOBAL_DISPATCHER]) await globalThis.fetch('data:,').then(response => response.text());
    const Agent = globalThis[GLOBAL_DISPATCHER]?.constructor;
    remoteAgent = Agent?.name === 'Agent' ? new Agent({keepAliveTimeout: KEEP_ALIVE_MS, keepAliveMaxTimeout: KEEP_ALIVE_MS}) : null;
  } catch { remoteAgent = null; }
  return remoteAgent ?? undefined;
}
const isCloud = url => { const {protocol, hostname} = new URL(url); return protocol === 'https:' && Object.values(HOSTS).includes(hostname); };

/**
 * Opens the connection to the provider ahead of the first turn, so that turn finds a ready connection (TLS done). One unauthenticated
 * `GET` of the provider's origin root: it carries no key (only the method, the host and the client's default headers leave), is not
 * an API call so it uses no quota, and answers with a body of about 100 bytes (JSON, 404 at Mistral) that is read to
 * its end so the connection returns to the shared pool. A `HEAD` is not used: Mistral's host (Cloudflare) answers it with
 * `Connection: close`, which drops the connection (measured 2026-10-13). Resolves true when the host answered (any status), false
 * otherwise; never throws, never rejects, gives up after `timeoutMs`, and the caller does not need to wait for it.
 * `connections`: how many are opened side by side. A turn that may offer a game action sends two requests at once (the action decision
 * and the reply, bridge/text-provider-host.mjs), and a pool serves two requests at once only with two connections: warming one would
 * leave the second to pay DNS, TCP and TLS in front of the first sound.
 */
export async function warmConnection({provider = 'mistral', fetchImpl = globalThis.fetch, timeoutMs = 5000, connections = 1, origin} = {}) {
  try {
    // The custom provider names its own https origin (its saved endpoint; the caller passes none for a server on this computer or the home
    // network, which has no TLS to warm).
    const target = provider === 'custom' ? (typeof origin === 'string' && /^https:\/\/[^/\s]+$/.test(origin) ? origin + '/' : null)
      : HOSTS[provider] ? `https://${HOSTS[provider]}/` : null;
    if (!target) return false;
    const signal = AbortSignal.timeout(timeoutMs);
    const dispatcher = fetchImpl === globalThis.fetch ? await remoteDispatcher() : undefined;
    const one = async () => {
      // The custom provider's origin root may be a whole web page (OpenRouter's is): a HEAD opens the connection and reads nothing.
      const response = await fetchImpl(target, {method: provider === 'custom' ? 'HEAD' : 'GET', signal, headers: {Accept: 'application/json'}, ...(dispatcher ? {dispatcher} : {})});
      try { await response.arrayBuffer(); } catch { /* the body failed: the connection is gone, nothing to keep */ }
      return true;
    };
    const opened = await Promise.allSettled(Array.from({length: Math.max(1, Math.min(4, connections | 0))}, one));
    return opened.some(result => result.status === 'fulfilled');
  } catch { return false; }
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
 *   signal: the caller's cancellation
 *   firstByteMs: how long a request may take to deliver its first piece of reply (response headers included); `retryFirstByteMs`
 *     (default: the same) is the limit of the later attempts. A request that hangs (a connection the network dropped without telling
 *     anyone) is cut at this limit and sent again on a new connection: the 2026-10-13 live record had one hang for the whole 25 s limit
 *     before the retry answered in 2 s (docs/LATENCY_2026-10-12.md).
 *   stallMs: once the reply has started, silence this long ends the attempt (0: off); totalMs: the whole attempt
 *   retries / backoffMs: for 429, 5xx, a timeout, an empty answer
 *   onRetry({attempt, error, waitMs}): called before each retry, so the caller can log why a turn took long
 *   setTimer / clearTimer: the timers of the first-byte, stall and total limits and of the drain after [DONE] (default setTimeout / clearTimeout;
 *     a test passes a manual clock's, so a loaded machine cannot cut a request early)
 * Returns {text, model, finishReason, usage, attempts, failed: [{kind, status, ms}]} (`failed` lists the attempts that were given up).
 */
export async function streamChat({apiKey, model = DEFAULT_MODEL, messages, maxTokens = 300, temperature = 0.8, onDelta, shouldStop,
  signal, fetchImpl = globalThis.fetch, endpoint, firstByteMs = 25000, retryFirstByteMs, stallMs = 0, totalMs = 70000, retries = 2,
  backoffMs = [1200, 3500], sleepImpl = sleep, extraBody, provider = 'mistral', trustedOrigin, onHeaders, onRetry, now = () => performance.now(),
  adapt, headers, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  // The custom provider's key is optional (a server on this computer wants none); a key it has is held to the same length as any other.
  const keyless = provider === 'custom' && (apiKey === undefined || apiKey === null || apiKey === '');
  if (!keyless && (typeof apiKey !== 'string' || apiKey.length < 8)) throw new MistralError('key', 'has no API key', {provider});
  if (keyless) apiKey = undefined;
  const url = checkedEndpoint(endpoint ?? MISTRAL_ENDPOINT, provider, trustedOrigin);
  let lastError, adapted = false;
  const failed = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw signal.reason ?? abortError();
    const began = now();
    try {
      const result = await once({apiKey, model, messages, maxTokens, temperature, onDelta, shouldStop, signal, fetchImpl, url,
        firstByteMs: attempt > 0 && retryFirstByteMs ? retryFirstByteMs : firstByteMs, stallMs, totalMs, extraBody, provider, onHeaders, adapt, headers, setTimer, clearTimer});
      return {...result, attempts: attempt + 1 + (adapted ? 1 : 0), failed};
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' && !(error instanceof MistralError)) throw signal?.aborted ? (signal.reason ?? abortError()) : error;
      lastError = error instanceof MistralError ? error : new MistralError('network', redact(error?.message ?? 'request failed', apiKey), {apiKey, provider});
      failed.push({kind: lastError.kind, status: lastError.status, ms: Math.round(now() - began)});
      // The custom provider's server refused an optional field of the request: the same request is sent once more without it, at once, and the
      // refusal is remembered (in `adapt`, which the route keeps for the session) so no later request sends the field again.
      if (adapt && !adapted && lastError.paramsRejected) {
        adapted = true;
        learnRefusal(adapt, lastError.paramsRejected);
        try { onRetry?.({attempt: attempt + 1, error: lastError, waitMs: 0, ms: failed.at(-1).ms}); } catch { /* an observer never fails a reply */ }
        attempt--;
        continue;
      }
      // A Retry-After longer than a reply can wait is not waited for (the custom provider; Mistral's is capped at a minute and waited up to 8 s).
      const tooLong = provider === 'custom' && lastError.kind === 'limit' && lastError.retryAfterMs > MAX_RETRY_WAIT_MS;
      if (attempt >= retries || !retryable(lastError) || tooLong) { lastError.failed = failed; throw lastError; }
      const wait = Math.min(lastError.retryAfterMs ?? backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 2000, MAX_RETRY_WAIT_MS);
      try { onRetry?.({attempt: attempt + 1, error: lastError, waitMs: wait, ms: failed.at(-1).ms}); } catch { /* an observer never fails a reply */ }
      await sleepImpl(wait, signal);
    }
  }
  lastError.failed = failed;
  throw lastError;
}

const MAX_RETRY_WAIT_MS = 8000;

// What the custom provider's server refused is remembered in `adapt` ({dropped: Set of field names, swapped: max_tokens is sent as
// max_completion_tokens}); the route keeps one per endpoint and model for the session.
export function newAdaptation() { return {dropped: new Set(), swapped: false}; }
const OPTIONAL_FIELDS = Object.freeze(['stream_options', 'response_format', 'temperature', 'prompt_cache_key', 'top_p']);
function learnRefusal(adapt, rejected) {
  if (rejected.swap) adapt.swapped = true;
  for (const name of rejected.names.length ? rejected.names : OPTIONAL_FIELDS) adapt.dropped.add(name);
}
function applyAdaptation(body, adapt) {
  if (adapt.swapped && 'max_tokens' in body) { body.max_completion_tokens = body.max_tokens; delete body.max_tokens; }
  for (const name of adapt.dropped) {
    if (name === 'stream') body.stream = false;
    else delete body[name];
  }
}
const isPlainJson = headers => { const type = String(headers?.get?.('content-type') ?? ''); return /\bjson\b/i.test(type) && !/event-stream/i.test(type); };

// The body of a refused request. A custom server may answer in plain text or HTML (a proxy's "502 Bad Gateway"): its words become the message.
async function errorBody(response, provider) {
  if (provider === 'custom' && typeof response.text === 'function') {
    let raw = '';
    try { raw = await response.text(); } catch { return undefined; }
    try { return JSON.parse(raw); } catch {
      const plain = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      return plain ? {message: plain} : undefined;
    }
  }
  try { return await response.json(); } catch { return undefined; }
}

async function once({apiKey, model, messages, maxTokens, temperature, onDelta, shouldStop, signal, fetchImpl, url, firstByteMs, stallMs, totalMs, extraBody, provider, onHeaders, adapt, headers: extraHeaders, setTimer, clearTimer}) {
  const controller = new AbortController();
  let timedOut = false, started = false;
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, {once: true});
  const total = setTimer(() => { timedOut = true; controller.abort(); }, totalMs);
  // The first piece of the reply is waited for `firstByteMs`; after that, silence is waited for `stallMs` (0: only the total limit).
  let first = setTimer(() => { timedOut = true; controller.abort(); }, firstByteMs);
  const quiet = () => { clearTimer(first); if (stallMs > 0) first = setTimer(() => { timedOut = true; controller.abort(); }, stallMs); };
  try {
    let response;
    try {
      // The custom provider's https connections are kept alive like Mistral's (the reply after a pause finds one ready).
      const dispatcher = isCloud(url) || (provider === 'custom' && url.startsWith('https:')) ? await remoteDispatcher() : undefined;
      const body = {model, messages, stream: true, max_tokens: maxTokens, temperature, ...extraBody};
      if (adapt) applyAdaptation(body, adapt);
      markStage('llmSent');
      response = await fetchImpl(url, {method: 'POST', signal: controller.signal, ...(dispatcher ? {dispatcher} : {}),
        // The key's origin is the endpoint's; a redirect to another host is an error, not something to follow with the key.
        ...(provider === 'custom' ? {redirect: 'error'} : {}),
        headers: {...(apiKey ? {Authorization: `Bearer ${apiKey}`} : {}), 'Content-Type': 'application/json',
          Accept: body.stream === false ? 'application/json' : 'text/event-stream', ...extraHeaders},
        body: JSON.stringify(body)});
    } catch (error) {
      if (timedOut) throw new MistralError('network', 'did not answer in time', {apiKey, provider, slow: true});
      if (signal?.aborted) throw signal.reason ?? abortError();
      if (provider === 'custom' && /redirect/i.test(String(error?.cause?.message ?? error?.message ?? ''))) {
        const redirect = new MistralError('network', 'answered with a redirect to another address; check the endpoint URL', {apiKey, provider});
        redirect.redirect = true;
        throw redirect;
      }
      throw new MistralError('network', `could not be reached (${redact(error?.cause?.code ?? error?.message ?? 'network error', apiKey)})`, {apiKey, provider});
    }
    markStage('llmHeaders');
    // The rate-limit headers go to the caller (the shared request scheduler reads a per-second limit from them).
    try { onHeaders?.(response.headers); } catch { /* an observer never fails a reply */ }
    if (!response.ok) throw mapFailure(response.status, await errorBody(response, provider), {headers: response.headers, apiKey, provider});
    // A custom server that does not stream (or was asked not to, after it refused "stream") answers with one JSON body: the whole reply is one piece.
    if (provider === 'custom' && isPlainJson(response.headers)) {
      let value;
      try { value = await response.json(); } catch {
        if (timedOut) throw new MistralError('network', 'did not finish in time', {apiKey, provider, slow: true});
        if (signal?.aborted) throw signal.reason ?? abortError();
        throw new MistralError('network', 'sent an answer that could not be read', {apiKey, provider});
      }
      if (value?.error) throw mapFailure(Number.isInteger(value.error?.code) ? value.error.code : Number.isInteger(value.code) ? value.code : 502, value, {apiKey, provider});
      const choice = value?.choices?.[0];
      const whole = contentText(choice?.message?.content ?? choice?.text);
      if (!whole.trim()) throw new MistralError('empty', 'answered with no text', {apiKey, provider});
      markStage('firstToken');
      onDelta?.(whole, whole);
      return {text: whole, model: typeof value.model === 'string' ? value.model : undefined, finishReason: choice?.finish_reason ?? 'stop', usage: value.usage};
    }
    if (!response.body) throw new MistralError('network', 'sent no reply stream', {apiKey, provider});
    let text = '', actualModel, finishReason, usage, stoppedEarly = false, sawDone = false;
    try {
      // After [DONE] the body is read to its end (bounded) instead of cancelled, so the connection is reused by the next turn.
      for await (const data of sseData(response.body, {drainMs: DRAIN_MS, setTimer, clearTimer})) {
        quiet();
        if (data === '[DONE]') { sawDone = true; break; }
        let chunk; try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk?.object === 'error' || chunk?.error) throw mapFailure(Number.isInteger(chunk.code) ? chunk.code : Number.isInteger(chunk.error?.code) ? chunk.error.code : 502, chunk, {apiKey, provider});
        if (typeof chunk?.model === 'string') actualModel = chunk.model;
        if (chunk?.usage) usage = chunk.usage;
        const choice = chunk?.choices?.[0];
        if (!choice) continue;
        const piece = contentText(choice.delta?.content);
        if (piece) {
          if (!text) markStage('firstToken');
          started = true;
          text += piece;
          onDelta?.(piece, text);
          if (shouldStop?.(text)) { stoppedEarly = true; break; }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (choice.finish_reason === 'error') throw new MistralError('network', 'stopped the reply with an error', {apiKey, provider});
      }
      // A server the player runs can die while it writes (a killed KoboldCpp closes the stream as cleanly as a finished one): a stream that ends
      // with neither "[DONE]" nor a finish_reason is a reply cut off, not a finished one. The cloud's streams always end with one of them.
      if ((provider === 'local' || provider === 'custom') && !stoppedEarly && !sawDone && !finishReason) throw new MistralError('network', 'went quiet before the reply was finished', {apiKey, provider, partial: !!text.trim()});
    } catch (error) {
      if (timedOut) throw new MistralError('network', started ? 'went quiet before the reply was finished' : 'did not finish in time', {apiKey, provider, slow: true});
      if (signal?.aborted) throw signal.reason ?? abortError();
      throw error;
    }
    if (!text.trim()) throw new MistralError('empty', 'answered with no text', {apiKey, provider});
    return {text, model: actualModel, finishReason: stoppedEarly ? 'stop' : finishReason, usage};
  } finally {
    clearTimer(first); clearTimer(total);
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

/** The key check: one authenticated GET of the model list (no completion is used). 'valid', 'invalid' or 'unknown'. */
export async function validateKey(apiKey, {fetchImpl = globalThis.fetch, provider = 'mistral', endpoint = MISTRAL_MODELS_ENDPOINT, timeoutMs = 10000} = {}) {
  try {
    const url = checkedEndpoint(endpoint, provider);
    const response = await fetchImpl(url, {headers: {Authorization: `Bearer ${apiKey}`, Accept: 'application/json'}, signal: AbortSignal.timeout(timeoutMs)});
    try { await response.body?.cancel(); } catch { /* already closed */ }
    if (response.ok) return 'valid';
    return response.status === 401 || response.status === 403 ? 'invalid' : 'unknown';
  } catch { return 'unknown'; }
}
