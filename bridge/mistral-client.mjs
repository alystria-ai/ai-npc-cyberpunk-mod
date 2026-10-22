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
import {ThinkFilter, reasoningIn, reasoningTokens, afterStrayClose, retryBudget, withNoThink, NO_THINK_MODEL, NO_THINKING_FIELDS} from './reasoning.mjs';
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
 * 'credits' (custom only: the account has no credit left, HTTP 402), 'daily' (custom only: a daily allowance is used up, such as OpenRouter's
 * free models; `resetAt` is when it ends, when the server said), 'reasoning' (custom only: a reasoning model spent its whole reply on thinking, even
 * with more room, bridge/reasoning.mjs).
 * The message carries `[mistral:<kind>]` so the bridge can classify a failure from its text alone, like convai-quota.mjs.
 */
export class MistralError extends Error {
  constructor(kind, detail, {status, retryAfterMs, apiKey, zeroQuota = false, provider = 'mistral', slow = false, partial = false, resetAt, reasoning = false, reason, trace, noRetry = false, deadline = false, noAttempt = false} = {}) {
    provider = PROVIDER_LABELS[provider] ? provider : 'mistral';
    super(`${PROVIDER_LABELS[provider]} ${redact(detail, apiKey).slice(0, 200)} [${provider}:${kind}]`);
    this.name = 'MistralError';
    // The words of the server's own answer (redacted), for the custom provider's connection test, which shows them to the player.
    if (provider === 'custom') this.detail = redact(detail, apiKey).slice(0, 160);
    // zeroQuota: the account has no allowance at all for this model (retrying cannot help; another model may work).
    // slow: the service was reachable but did not answer in time (no response, or a stream that went quiet), or answered with a server
    // fault; the caller may speak a short in-character line instead of an error (docs/MISTRAL.md).
    // partial: some of the reply had already been delivered (a retry would say it twice).
    // reason: why a request ended without a reply, from what the stream showed (stallReason): 'no-response', 'no-first-token', 'prefill-stalled',
    //   'thinking-only', 'stalled'. trace: the request's record (what came when; see `newTrace`). noRetry: asking again would only repeat the wait.
    //   deadline: the attempt was cut short by the turn's time limit (`deadlineAt`), not by its own limits. noAttempt: the turn's time was spent before any attempt was made (no request was sent: it is not a stall of the server).
    Object.assign(this, {kind, status, retryAfterMs, zeroQuota, provider, slow, partial, reason, trace, noRetry, deadline});
    if (noAttempt) this.noAttempt = true;
    // Custom only, and only when set: when a daily allowance ends (epoch ms), and an empty answer whose reply budget went to thinking (`reasoning`; not the same as `reason`).
    if (resetAt !== undefined) this.resetAt = resetAt;
    if (reasoning) this.reasoning = true;
  }
}

// Words in an error's text that say what the player's own model server needs (errorCodeFor works from the text alone, like the rest of the markers).
const STUBBORN_THINKING = /even when asked not to think/;
const SERVER_CONTEXT = /the model server's context is too small/;

export const MISTRAL_MARKER = /\[(?:mistral|local|custom):(key|limit|model|network|empty|request|credits|daily|reasoning)\]/;

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
  // Two of them are about the player's own model server (a server added through manifest.custom.json) and name what to change there: a model that only thinks
  // even when asked not to (streamChat), and a context too small for the character (bridge/prompt-budget.mjs PromptTooLarge).
  if (provider === 'local') return !kind ? undefined : kind === 'empty' && STUBBORN_THINKING.test(text) ? 'local-thinking' : kind === 'request' && SERVER_CONTEXT.test(text) ? 'local-context' : 'local-failed';
  // The custom provider: its own seven notices (a failure of any other kind, a refused prompt or an empty answer, is the ordinary "no answer").
  if (provider === 'custom') return kind === 'key' ? 'custom-key' : kind === 'credits' ? 'custom-credits' : kind === 'limit' ? 'custom-limit'
    : kind === 'daily' ? 'custom-daily' : kind === 'reasoning' ? 'custom-reasoning' : kind === 'model' ? 'custom-model' : kind === 'network' ? 'custom-unreachable' : undefined;
  return kind === 'key' ? `${provider}-key` : kind === 'limit' ? `${provider}-limit` : kind === 'model' ? `${provider}-model` : undefined;
}

/** Extra fields of the game's reply for a failure that has a notice (custom only): a daily limit's reset time as "HH:MM" on this computer's clock, when the server gave one. */
export function errorExtrasFor(error) {
  const at = error?.provider === 'custom' && error.kind === 'daily' ? resetClock(error.resetAt) : undefined;
  return at ? {errorResetTime: at} : {};
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
const DROPPABLE = Object.freeze(['stream_options', 'response_format', 'temperature', 'prompt_cache_key', 'top_p', 'repeat_penalty', 'max_completion_tokens']);
// "must be": LM Studio refuses the fact extraction's json_object with "'response_format.type' must be 'json_schema'" (a field it names is dropped;
// a sentence that names no optional field, such as "messages must be non-empty", is still not a refusal of one).
const REFUSAL_WORDS = /unsupported|not supported|unknown|unrecogni[sz]ed|unexpected|not permitted|not allowed|not accepted|extra (?:inputs?|fields?|forbidden)|extra_forbidden|invalid (?:parameter|param|field|argument)|additional propert|does not support|only the default|must be|invalid_request_error.*param/;
const FIELD_WORDS = /parameter|param\b|field|argument|propert/;
// A refusal of unknown extra request fields that names no field and does not use the word field or parameter ("Extra inputs are not permitted"): for the local route's no-thinking fields only.
const UNKNOWN_FIELD_WORDS = /extra (?:inputs?|fields?|forbidden)|extra_forbidden|unrecogni[sz]ed|unknown|unexpected|not permitted|not allowed|unsupported|not supported|additional propert/;
const NO_SUCH_MODEL = /(?:model|endpoint)s?\b.{0,60}\b(?:not found|does not exist|not a valid|no such|unknown|not available|is not supported)|no endpoints found|invalid model/;
// The fields that ask a model to think less (bridge/reasoning.mjs). A word of one of them that is not part of a model id ("qwen3-thinking") says the refusal is
// about them: OpenAI's "reasoning_effort", Ollama's "does not support thinking", OpenRouter's "Reasoning is mandatory for this endpoint and cannot be disabled".
const REASONING_FIELD = /(?<![\w/:-])(?:reasoning|thinking|think|enable_thinking|include_reasoning|chat_template_kwargs)(?:[_.](?:effort|budget|type|enabled))?(?![\w-])/;
const MANDATORY = /mandatory|cannot be (?:disabled|turned off|switched off)|can(?:'|’)?t be (?:disabled|turned off)|is required|must (?:reason|think)/;

/**
 * What a 400 or 422 says about a request field, or null when it is not a refusal of one: {names: [fields it names], swap: max_tokens is
 * to be sent as max_completion_tokens}. `names` is empty when the answer says a parameter is unsupported without naming it (all the
 * optional fields then go). A message about the model itself ("model not found") is not a refusal of a field. `reasoning: true` (only when it applies): the
 * refusal is about the fields that ask the model to think less; the request moves to the next step of them (adapt.reasoningStep), nothing else goes.
 */
export function rejectedParameters(status, text) {
  if (status !== 400 && status !== 422) return null;
  const lower = String(text ?? '').toLowerCase();
  const about = REASONING_FIELD.test(lower) && !NO_SUCH_MODEL.test(lower);
  if (!REFUSAL_WORDS.test(lower) && !(about && MANDATORY.test(lower))) return null;
  const flag = about ? {reasoning: true} : {};
  const names = DROPPABLE.filter(name => lower.includes(name));
  if (/\bstream\b/.test(lower.replace(/stream_options/g, ''))) names.push('stream');
  const swap = /\bmax_tokens\b/.test(lower) && /max_completion_tokens/.test(lower);
  if (/\bmax_tokens\b/.test(lower) && !swap) names.push('max_tokens');
  if (swap) return {names: names.filter(name => name !== 'max_completion_tokens'), swap: true, ...flag};
  if (!names.length) return about ? {names: [], swap: false, reasoning: true} : NO_SUCH_MODEL.test(lower) || !FIELD_WORDS.test(lower) ? null : {names: [], swap: false};
  return {names, swap: false, ...flag};
}

/**
 * Which of the fields that ask for no thinking (bridge/reasoning.mjs noThinkingFields) a refusal names; only those are left out of the request sent again
 * (`adapt.noThinkDropped`). Empty when it names none.
 */
export function namedNoThinkFields(text) {
  const lower = String(text ?? '').toLowerCase();
  return NO_THINKING_FIELDS.filter(name => new RegExp(String.raw`(?<![\w/:-])${name}(?![\w-])`).test(lower));
}

// A daily allowance does not clear by waiting a few seconds. OpenRouter's free models answer 429 "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000
// free model requests per day", with X-RateLimit-Limit / -Remaining / -Reset in the response headers and in error.metadata.headers (Reset: milliseconds since 1970)
// (https://openrouter.ai/docs/api-reference/limits); other servers say "per day", "daily", TPD or RPD.
const FREE_DAILY = /free-models-per-day|free model requests per day/;
const DAILY_WORDS = /per[ _-]?day|\b(?:tpd|rpd)\b|daily/;
const CREDIT_WORDS = /insufficient[_ ]quota|exceeded your current quota|out of credits|insufficient (?:credits|funds|balance)|add (?:more )?credits/;
const TWO_DAYS = 48 * 3600_000;

// A response header, or the same one in OpenRouter's error.metadata.headers (names compared without case).
function limitHeader(headers, body, name) {
  const own = headers?.get?.(name);
  if (own !== null && own !== undefined && String(own).trim() !== '') return own;
  const listed = body?.error?.metadata?.headers;
  if (listed && typeof listed === 'object') for (const [key, value] of Object.entries(listed)) if (key.toLowerCase() === name) return value;
  return undefined;
}

// When a limit ends, as epoch ms, from a reset header: milliseconds or seconds since 1970, a number of seconds from now, or an HTTP date. Only a time still to come
// within two days counts: a server that sent nothing, or something that cannot be read, gives no time.
function resetTime(value, now) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const number = Number(value);
  const at = Number.isFinite(number) ? (number > 1e11 ? number : number > 1e8 ? number * 1000 : now + number * 1000) : Date.parse(value);
  return Number.isFinite(at) && at > now && at - now <= TWO_DAYS ? Math.round(at) : undefined;
}

// A Retry-After of more than a minute, as a time (the daily limit of a server that has no reset header but says how long to wait).
function retryAfterTime(headers, now) {
  const raw = headers?.get?.('retry-after');
  if (raw === null || raw === undefined || String(raw).trim() === '') return undefined;
  const number = Number(raw), at = Number.isFinite(number) ? now + number * 1000 : Date.parse(raw);
  return Number.isFinite(at) && at - now > 60_000 ? resetTime(at, now) : undefined;
}

// OpenRouter passes a provider's own refusal on as "Provider returned error" and puts the provider's words in error.metadata.raw.
function providerWords(body) {
  const raw = body?.error?.metadata?.raw;
  if (typeof raw === 'string') { try { return textOf(JSON.parse(raw)) || raw.slice(0, 300); } catch { return raw.slice(0, 300); } }
  return raw && typeof raw === 'object' ? textOf(raw) : '';
}

/** "HH:MM" on this computer's clock for a time still to come within a day and a bit (a reset), else undefined. */
export function resetClock(at, now = Date.now()) {
  if (!Number.isFinite(at) || at <= now || at - now > 26 * 3600_000) return undefined;
  const date = new Date(at), two = number => String(number).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** Maps what the custom provider answered: the same few kinds, plus 402 (no credit), a daily limit, and a refused request field. */
function mapCustomFailure(status, body, {headers, apiKey, now = Date.now()}) {
  // Google's OpenAI-compatible endpoint answers an error as a list of one error object.
  const first = Array.isArray(body) ? body[0] : body;
  const message = textOf(first), raw = providerWords(first);
  const text = raw && (!message || /^provider returned error\b/i.test(message)) ? raw : message;
  const matching = [message, raw].filter(Boolean).join(' '), lower = matching.toLowerCase();
  const options = {status, retryAfterMs: customRetryAfter(headers, now), apiKey, provider: 'custom'};
  // The server's own words travel with the error (redacted) so the connection test can show them; the message names what it means.
  const make = (kind, detail, extra = {}) => {
    const error = new MistralError(kind, detail, {...options, ...extra});
    if (text) error.providerText = redact(text, apiKey).slice(0, 160);
    return error;
  };
  if (status === 401 || status === 403) return make('key', 'did not accept the API key');
  // Some providers answer an account that has spent its credit with 429 ("insufficient_quota") instead of 402.
  const freeDaily = status === 429 && FREE_DAILY.test(lower);
  if (status === 402 || (status === 429 && !freeDaily && CREDIT_WORDS.test(lower))) {
    return make('credits', 'has no credit left on this account');
  }
  if (status === 429) {
    // A daily allowance: no retry (a different kind, which is not retried), and the notice says when it ends if the server did.
    const resetAt = resetTime(limitHeader(headers, first, 'x-ratelimit-reset'), now);
    const spent = String(limitHeader(headers, first, 'x-ratelimit-remaining') ?? '').trim() === '0';
    if (freeDaily || DAILY_WORDS.test(lower) || (spent && resetAt !== undefined && resetAt - now > 15 * 60_000)) {
      const error = make('daily', 'reached its daily limit', {resetAt: resetAt ?? retryAfterTime(headers, now)});
      error.daily = true;
      return error;
    }
    return make('limit', 'is rate limiting requests');
  }
  const rejected = rejectedParameters(status, matching);
  if (rejected) {
    const error = make('request', `refused the request: ${text || `HTTP ${status}`}`);
    const noThink = namedNoThinkFields(matching);
    error.paramsRejected = noThink.length ? {...rejected, noThink} : rejected;
    return error;
  }
  // A 404 that speaks of a model (or OpenRouter's "No endpoints found for <model>") is an unknown model id. A bare "Not Found" (an HTML page, Ollama's
  // "404 page not found") is a wrong address: a path without /v1, Ollama's own /api, a site's web page. The player is sent to the address, not the model.
  if (status === 404 && !/model|no endpoints found/.test(lower)) return Object.assign(make('network', `has no chat endpoint at that address (HTTP 404)${text ? `: ${text}` : ''}`), {permanent: true});
  if (status === 404 || ((status === 400 || status === 422) && /model/.test(lower))) return make('model', `does not know that model: ${text || `HTTP ${status}`}`);
  if (status === 408 || (status >= 500 && status <= 599)) return make('network', `had a server fault (HTTP ${status})`, {slow: true});
  return make('request', `refused the request: ${text || `HTTP ${status}`}`);
}

// A server saying the prompt is longer than the context it has loaded: llama.cpp ("request (N tokens) exceeds the available context size (M tokens)", type
// `exceed_context_size_error` with n_prompt_tokens and n_ctx), OpenAI-style servers ("maximum context length is M tokens ... you requested N") and LM Studio's
// own ("Trying to keep the first N tokens when context the overflows ... context length of only M tokens"). LM Studio wraps llama.cpp's refusal in a 500 or 502.
const CONTEXT_FULL = /exceeds?[_ ](?:the )?(?:available |model'?s? )?(?:max(?:imum)? )?context[_ ](?:size|length|window)|(?:maximum|max) context (?:length|size)|context (?:size|length|window) (?:has been |was |is )?exceeded|context length of only|when context the overflows|prompt is too long for the context|input is too long for the context/i;

/**
 * {promptTokens, contextTokens} (either may be undefined: the server did not say) when a failed request was a prompt longer than the server's context, else null.
 * Any 4xx that a server answers a refused prompt with and any 5xx a front end passes it on as count.
 */
export function contextRefusal(status, text, body) {
  if (!(status === 400 || status === 413 || status === 422 || (status >= 500 && status <= 599))) return null;
  const words = String(text ?? '');
  if (!(body?.error?.type === 'exceed_context_size_error' || CONTEXT_FULL.test(words))) return null;
  const number = (...values) => { for (const value of values) { const count = Math.floor(Number(value)); if (Number.isFinite(count) && count > 0) return count; } return undefined; };
  const counted = /request \((\d+) tokens\).*?\((\d+) tokens\)/.exec(words);
  const asked = /maximum context length is (\d+) tokens.*?(?:requested|resulted in|contain(?:s|ed)?) (\d+) tokens/i.exec(words);
  return {
    promptTokens: number(body?.error?.n_prompt_tokens, /"n_prompt_tokens"\s*:\s*(\d+)/.exec(words)?.[1], counted?.[1], asked?.[2], /keep the first (\d+) tokens/i.exec(words)?.[1]),
    contextTokens: number(body?.error?.n_ctx, /"n_ctx"\s*:\s*(\d+)/.exec(words)?.[1], counted?.[2], asked?.[1], /context length of only (\d+) tokens/i.exec(words)?.[1])};
}

/** Maps an HTTP status (or the `code` of an error object inside a stream) and its body to a MistralError. */
export function mapFailure(status, body, {headers, apiKey, provider, now} = {}) {
  if (provider === 'custom') return mapCustomFailure(status, body, {headers, apiKey, ...(now !== undefined ? {now} : {})});
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
  // llama-server refuses a prompt longer than its context and says how many tokens it counted (docs/LOCAL_AI.md, "Context budget"). A server in front of it
  // (LM Studio) passes that refusal on inside its own error, as a 500 or 502: the words are what tell it from a server that failed.
  const overflow = contextRefusal(status, text, body);
  if (overflow) {
    const error = new MistralError('request', detail, options);
    error.overflow = overflow;
    return error;
  }
  if (status === 404 || ((status === 400 || status === 422) && /model/.test(lower))) return new MistralError('model', detail, options);
  if (status === 408 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529) return new MistralError('network', detail, {...options, slow: true});
  return new MistralError('request', detail, options);
}

/** Retry only what clears by itself: the per-second limit, a server fault, a timeout, an empty answer. Never a bad key, nor a wrong address (`permanent`, custom only),
 * nor a wait that asking again would only repeat (`noRetry`: a local server's timeout, a model that only thinks). */
export const retryable = error => error instanceof MistralError && !error.zeroQuota && !error.daily && !error.partial && !error.permanent && !error.noRetry
  && (error.kind === 'network' || error.kind === 'empty' || error.kind === 'limit');

// ---- What one request did ----------------------------------------------------------------------------------------------
// A request leaves a record (`trace`) on its result and on its error, so a turn that was slow or failed can say what it was waiting for
// (docs/LOCAL_AI.md, "When a local turn fails"): the times are milliseconds after the request was sent, `null` when it never came.
//   headersMs      the response headers          eventMs      the first stream event of any kind (llama-server sends one per prompt batch
//   firstTokenMs   the first piece of reply text                with `return_progress`, then one per token)
//   events, pieces, reasoning   stream events, pieces of reply text, pieces of the model's thinking (`reasoning_content`)
//   progress       the last prompt-progress report {processed, total, cache} (llama-server `return_progress`), else null
//   timings        the server's own numbers from the closing chunk {promptTokens, cachedTokens, promptMs, generated, tokensPerSecond}, else null
//   finishReason, elapsedMs
export function newTrace() {
  return {headersMs: null, eventMs: null, firstTokenMs: null, events: 0, pieces: 0, reasoning: 0, progress: null, timings: null, finishReason: null, elapsedMs: 0};
}

/**
 * Why a request ended without a reply, from its record: 'no-response' (no headers), 'stalled' (the reply had started and stopped),
 * 'thinking-only' (the model wrote only thinking), 'prefill-stalled' (the prompt was being read and the report stopped short of its end),
 * 'no-first-token' (headers came, then nothing, or the whole prompt was read and no word followed).
 */
export function stallReason(trace) {
  if (!trace || trace.headersMs === null) return 'no-response';
  if (trace.pieces > 0) return 'stalled';
  if (trace.reasoning > 0) return 'thinking-only';
  if (trace.progress && trace.progress.processed < trace.progress.total) return 'prefill-stalled';
  return 'no-first-token';
}

const seconds = ms => Math.max(1, Math.round(ms / 1000));

/**
 * One plain English sentence for a failed local turn: what the model was waiting for. It goes into the log, the support report and the game's
 * notice (as data after the translated sentence, like any provider's error text), so it never has a word of the reply, a path or a key.
 * `undefined` for an error that is not a local turn's. A turn that was slow for a reason the host knows (`error.hint`: "the model is partly on the CPU",
 * because the game left too little graphics memory) says so after the sentence, when the whole still fits what the game shows (140 characters).
 */
export function failureDetail(error) {
  const sentence = plainFailureDetail(error);
  const hint = typeof error?.hint === 'string' ? error.hint : '';
  return sentence && hint && sentence.length + hint.length + 2 <= 140 ? `${sentence}; ${hint}` : sentence;
}

function plainFailureDetail(error) {
  if (!(error instanceof MistralError) || error.provider !== 'local') return undefined;
  const trace = error.trace, took = trace?.elapsedMs ? seconds(trace.elapsedMs) : null, after = took ? ` after ${took} s` : '';
  const head = error.deadline ? 'ran out of the turn\'s time: ' : '';
  // No request was sent: the time went on something before it (a model that was loading, a queue), so "no answer from the server" would be untrue.
  if (error.noAttempt === true) return 'ran out of the turn\'s time before the model could be asked (it was loading or busy)';
  switch (error.reason) {
    case 'no-response': return head + `the model server gave no answer${after}`;
    case 'no-first-token': return head + `no first word from the model${after}`;
    case 'prefill-stalled': return head + `stuck reading the prompt (${trace.progress.processed} of ${trace.progress.total} tokens${after})`;
    case 'thinking-only': return head + 'the model wrote only thinking and no reply';
    case 'stalled': return head + `the reply stopped after ${trace?.pieces ?? 0} pieces${after}`;
    case 'loading': return `the model was still loading${after} (a first start compiles shaders for a minute or two)`;
    case 'restarting': return `the model server stopped working and was still starting again${after}`;
    default: break;
  }
  if (error.overflow) return `the prompt (${error.overflow.promptTokens ?? '?'} tokens) does not fit the model's context (${error.overflow.contextTokens ?? '?'})`;
  if (error.kind === 'empty') return trace?.finishReason === 'length' ? 'the model ran out of tokens before it said anything' : 'the model gave an empty reply';
  if (Number.isInteger(error.status)) return `the model server refused the request (HTTP ${error.status})`;
  if (error.kind === 'network') return 'the model server could not be reached or went away';
  return 'the request was refused';
}

// ---- SSE ---------------------------------------------------------------------------------------------------------------

/**
 * Parses a server-sent-events byte stream into data strings. Handles CRLF, comment lines (keep-alives start with a colon and are
 * ignored), events split over any number of chunks, several data lines per event and UTF-8 characters cut between chunks. Yields
 * the joined `data:` payload of each event; "[DONE]" is yielded as is.
 * `setTimer` / `clearTimer`: the drain limit's timer (default `setTimeout` / `clearTimeout`; a test passes a manual clock's).
 * `drainMs`: when the caller stops right after "[DONE]", the rest of the body (a few bytes) is read for at most this long, so the
 * connection can be reused by the next request (a body that is cancelled instead has its connection closed); 0 cancels at once.
 * Any other early exit (an error, the reply cap) cancels the body.
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
 * `{dispatcher}` (the shared keep-alive pool above) for a request to a cloud provider's host made with the built-in fetch, else `{}`
 * (another fetch, another host, or no pool). The cloud voice (bridge/voxtral-voice.mjs) asks for it too: its requests go to the same
 * host, so they share the connections the composer's warm-up opened instead of opening their own (a new connection is DNS, TCP and TLS:
 * about 50 to 90 ms more to the first audio, measured 2026-10-19). Never throws.
 */
export async function cloudFetchOptions(url, fetchImpl = globalThis.fetch) {
  try {
    if (fetchImpl !== globalThis.fetch || !isCloud(url)) return {};
    const dispatcher = await remoteDispatcher();
    return dispatcher ? {dispatcher} : {};
  } catch { return {}; }
}

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
 *   stallMs: silence this long ends the attempt once the reply text has started (0: off); promptStallMs: the same before the first piece of reply
 *     text, once the first event has come (default: stallMs; a model reading a long prompt on a slow machine is silent for longer between two reports
 *     than a model that is writing); totalMs: the whole attempt. Any stream event
 *     counts as life: a text piece, a piece of the model's thinking, llama-server's prompt-progress report (`return_progress`).
 *   deadlineAt: the moment (the `now` clock) the turn's time is up. No attempt starts with less than MIN_ATTEMPT_MS left, and the limits above
 *     are cut to what is left, so a turn ends with its own explanation before the game gives up on it (the game waits 90 s).
 *   thinkingPieces: more than this many pieces of the model's thinking with no reply text ends the attempt at once (0: off)
 *   retries / backoffMs: for 429, 5xx, a timeout, an empty answer (a local server's timeout is never retried: it would repeat the wait)
 *   onRetry({attempt, error, waitMs}): called before each retry, so the caller can log why a turn took long
 *   reasoning (custom only): the steps of the field that asks a reasoning model to think less (bridge/reasoning.mjs reasoningSteps); adapt.reasoningStep says which one is current
 *   thinkingRoom (custom only, default true): a reply that comes back empty because the model spent the whole budget on thinking is asked once more with more room
 *     (retryBudget, and Qwen3's documented /no_think), and the room that worked is kept in `adapt` (floorTokens, noThink); if that is empty too, the error is kind
 *     'reasoning'. The one-word action decision passes false: it is never worth a thinking model's long answer, and it just reads as "no action".
 *   noThinking (a server of the player's, custom or local): the fields that ask for no thinking at all (bridge/reasoning.mjs noThinkingFields). Sent only once a request came
 *     back with nothing but thinking: that request is asked again at once, with them, once (the turn's own time limit still holds), and `adapt.thinks` makes every later request to
 *     that endpoint carry them from the start. A second answer of only thinking fails the turn saying so ("even when asked not to think"). Never given for the packaged
 *     local models, which never think.
 *   setTimer / clearTimer: the timers of the first-byte, stall and total limits and of the drain after [DONE] (default setTimeout / clearTimeout;
 *     a test passes a manual clock's, so a loaded machine cannot cut a request early)
 * Returns {text, model, finishReason, usage, trace, attempts, failed: [{kind, status, ms, reason}]} (`failed` lists the attempts that were given up).
 * A failure carries `reason` and `trace` (see `stallReason`, `newTrace`).
 */
export async function streamChat({apiKey, model = DEFAULT_MODEL, messages, maxTokens = 300, temperature = 0.8, onDelta, shouldStop,
  signal, fetchImpl = globalThis.fetch, endpoint, firstByteMs = 25000, retryFirstByteMs, stallMs = 0, promptStallMs = stallMs, totalMs = 70000, retries = 2,
  backoffMs = [1200, 3500], sleepImpl = sleep, extraBody, provider = 'mistral', trustedOrigin, onHeaders, onRetry, now = () => performance.now(),
  adapt, headers, reasoning, noThinking, thinkingRoom = true, deadlineAt, thinkingPieces = 0, minAttemptMs = MIN_ATTEMPT_MS, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  // The custom provider's key is optional (a server on this computer wants none); a key it has is held to the same length as any other.
  const keyless = provider === 'custom' && (apiKey === undefined || apiKey === null || apiKey === '');
  if (!keyless && (typeof apiKey !== 'string' || apiKey.length < 8)) throw new MistralError('key', 'has no API key', {provider});
  if (keyless) apiKey = undefined;
  const url = checkedEndpoint(endpoint ?? MISTRAL_ENDPOINT, provider, trustedOrigin);
  let lastError, adapted = 0, larger = null;   // larger: {maxTokens, noThink} once a reply that went to thinking is asked again with more room
  let thinkRetry = false;   // a reply of only thinking is asked again once with the fields that ask for no thinking (noThinking)
  const failed = [];
  const hasDeadline = Number.isFinite(deadlineAt);
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw signal.reason ?? abortError();
    const began = now();
    const remaining = hasDeadline ? deadlineAt - began : Infinity;
    if (remaining < minAttemptMs) {
      // The turn's time is spent: the last failure stands, or (no attempt was made) the turn says it ran out before the model could be asked.
      const error = lastError ?? new MistralError('network', 'ran out of time before the model could be asked', {apiKey, provider, slow: true, deadline: true, noAttempt: true, noRetry: true, reason: 'no-response', trace: {...newTrace(), elapsedMs: 0}});
      error.failed = failed; throw error;
    }
    const capped = remaining < totalMs;
    // Do the fields that ask for no thinking go with this attempt? (The retry of a reply that was only thinking, or an endpoint that has shown it thinks.)
    const askedNoThink = !!noThinking && (thinkRetry || adapt?.thinks === true);
    try {
      const result = await once({apiKey, model, messages, maxTokens, temperature, onDelta, shouldStop, signal, fetchImpl, url,
        firstByteMs: Math.min(attempt > 0 && retryFirstByteMs ? retryFirstByteMs : firstByteMs, remaining), stallMs, promptStallMs, totalMs: Math.min(totalMs, remaining), extraBody, provider, onHeaders,
        adapt, headers, reasoning, noThinking: askedNoThink ? noThinking : undefined, thinkingRoom, thinkingPieces, deadlineCapped: capped, setTimer, clearTimer,
        ...(larger ? {maxTokens: larger.maxTokens, noThink: larger.noThink} : {})});
      // What the larger budget (and the switch) bought is kept: the next requests start with it, so no turn pays for the empty first try again.
      if (larger && adapt) { adapt.floorTokens = larger.maxTokens; if (larger.noThink) adapt.noThink = true; }
      return {...result, attempts: attempt + 1 + adapted + (larger ? 1 : 0), failed};
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' && !(error instanceof MistralError)) throw signal?.aborted ? (signal.reason ?? abortError()) : error;
      lastError = error instanceof MistralError ? error : new MistralError('network', redact(error?.message ?? 'request failed', apiKey), {apiKey, provider});
      failed.push({kind: lastError.kind, status: lastError.status, ms: Math.round(now() - began), ...(lastError.reason ? {reason: lastError.reason} : {})});
      // A reply of only thinking from a server of the player's: the endpoint is remembered as one that thinks (the next requests carry the fields that ask for no
      // thinking from the start), and this request is asked again at once with them, whatever retries are left (the loop above still holds the turn's own time).
      // A custom provider's reply that spent its budget on thinking also gets the larger room, in the same one retry.
      const thoughtOnly = lastError.reason === 'thinking-only' || lastError.reasoning === true;
      if (noThinking && thoughtOnly && !askedNoThink) {
        if (adapt) adapt.thinks = true;
        // The one-word decision (thinkingRoom: false) is asked again too, with the fields that ask for no thinking and the same small budget: that is
        // short, and without it a model that thinks first answered "no action" to every request of the first turn that learned it thinks.
        if (!signal?.aborted) {
          thinkRetry = true;
          if (provider === 'custom' && thinkingRoom && lastError.reasoning && !larger) larger = {maxTokens: retryBudget(Math.max(maxTokens, adapt?.floorTokens ?? 0)), noThink: NO_THINK_MODEL.test(model)};
          try { onRetry?.({attempt: attempt + 1, error: lastError, waitMs: 0, ms: failed.at(-1).ms}); } catch { /* an observer never fails a reply */ }
          attempt--;
          continue;
        }
      }
      // It thought again although it was asked not to: a server of ours says so, in words the game turns into one line (errorCodeFor).
      if (provider === 'local' && askedNoThink && thoughtOnly && lastError.reason === 'thinking-only') {
        lastError = new MistralError('empty', `answered only with thinking (${lastError.trace?.reasoning ?? 0} pieces) even when asked not to think`,
          {apiKey, provider, reason: 'thinking-only', noRetry: true, trace: lastError.trace});
        lastError.failed = failed;
        throw lastError;
      }
      // A reasoning model that spent its whole reply on thinking (bridge/reasoning.mjs): asked once more with more room, whatever retries are left. Empty again: the
      // player is told this model thinks first.
      if (provider === 'custom' && thinkingRoom && lastError.reasoning && !signal?.aborted) {
        if (!larger) {
          larger = {maxTokens: retryBudget(Math.max(maxTokens, adapt?.floorTokens ?? 0)), noThink: NO_THINK_MODEL.test(model)};
          try { onRetry?.({attempt: attempt + 1, error: lastError, waitMs: 0, ms: failed.at(-1).ms}); } catch { /* an observer never fails a reply */ }
          attempt--;
          continue;
        }
        lastError = new MistralError('reasoning', 'spends its reply on thinking', {apiKey, provider, status: lastError.status});
        lastError.failed = failed;
        throw lastError;
      }
      // The custom provider's server refused an optional field of the request: the same request is sent once more without it, at once, and the
      // refusal is remembered (in `adapt`, which the route keeps for the session) so no later request sends the field again. A server that refuses
      // one field at a time (OpenAI's reasoning models: max_tokens, then temperature) is asked again after each refusal that taught something new,
      // at most MAX_ADAPTATIONS times; a refusal that changes nothing in the request is an error at once (no loop).
      if (adapt && adapted < MAX_ADAPTATIONS && lastError.paramsRejected && learnRefusal(adapt, lastError.paramsRejected, reasoning?.length ?? 0)) {
        adapted++;
        try { onRetry?.({attempt: attempt + 1, error: lastError, waitMs: 0, ms: failed.at(-1).ms}); } catch { /* an observer never fails a reply */ }
        attempt--;
        continue;
      }
      // A Retry-After longer than a reply can wait is not waited for (the custom provider; Mistral's is capped at a minute and waited up to 8 s).
      const tooLong = provider === 'custom' && lastError.kind === 'limit' && lastError.retryAfterMs > MAX_RETRY_WAIT_MS;
      if (attempt >= retries || !retryable(lastError) || tooLong) { lastError.failed = failed; throw lastError; }
      let wait = Math.min(lastError.retryAfterMs ?? backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 2000, MAX_RETRY_WAIT_MS);
      if (hasDeadline) wait = Math.max(0, Math.min(wait, deadlineAt - now() - minAttemptMs));
      try { onRetry?.({attempt: attempt + 1, error: lastError, waitMs: wait, ms: failed.at(-1).ms}); } catch { /* an observer never fails a reply */ }
      await sleepImpl(wait, signal);
    }
  }
  lastError.failed = failed;
  throw lastError;
}

/** The least time an attempt is worth starting with (a request that is cut after less than this cannot have said anything). */
export const MIN_ATTEMPT_MS = 3000;

const MAX_RETRY_WAIT_MS = 8000;
// How many refused fields one request may learn before it gives up (max_tokens renamed, temperature, response_format, stream).
const MAX_ADAPTATIONS = 4;

// What the custom provider's server refused is remembered in `adapt` ({dropped: Set of field names, swapped: max_tokens is sent as
// max_completion_tokens, reasoningStep: how many steps of the reasoning field it refused, floorTokens / noThink: what a reasoning model needed, see streamChat});
// the route keeps one per endpoint and model for the session.
// `thinks`: a request to this endpoint came back with only thinking, so the fields that ask for no thinking go with every request (bridge/reasoning.mjs noThinkingFields);
// `noThinkDropped`: which of those fields the server refused by name.
export function newAdaptation() { return {dropped: new Set(), swapped: false, reasoningStep: 0, floorTokens: 0, noThink: false, thinks: false, noThinkDropped: new Set()}; }
const OPTIONAL_FIELDS = Object.freeze(['stream_options', 'response_format', 'temperature', 'prompt_cache_key', 'top_p', 'repeat_penalty', 'stop']);
/**
 * Adds what a refusal says to `adapt`; true when that changed anything (a refusal already learned changes nothing, and is not asked again). `steps`: how many
 * steps of the reasoning field the request has (bridge/reasoning.mjs): a refusal that is about them moves to the next, after the last nothing is sent.
 */
function learnRefusal(adapt, rejected, steps = 0) {
  adapt.noThinkDropped ??= new Set();
  const signature = () => `${adapt.swapped}|${[...adapt.dropped].join(',')}|${adapt.reasoningStep ?? 0}|${[...adapt.noThinkDropped].join(',')}`;
  const before = signature();
  if (rejected.swap) adapt.swapped = true;
  for (const name of rejected.noThink ?? []) adapt.noThinkDropped.add(name);
  if (rejected.reasoning) adapt.reasoningStep = Math.min((adapt.reasoningStep ?? 0) + 1, steps);
  // A refusal that names no field drops every optional one (the reasoning field too); a rename of max_tokens alone, or a refusal of the reasoning field alone,
  // drops nothing else (temperature and the fact extraction's response_format stay until the server refuses them).
  else if (!rejected.names.length && !rejected.swap) { adapt.reasoningStep = steps; for (const name of NO_THINKING_FIELDS) adapt.noThinkDropped.add(name); }
  for (const name of rejected.names.length || rejected.swap || rejected.reasoning ? rejected.names : OPTIONAL_FIELDS) adapt.dropped.add(name);
  return signature() !== before;
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

// An empty answer. From a custom server whose reply was cut at its limit with nothing shown, or that thought and then ended without a word, the budget went to
// thinking (a reasoning model, bridge/reasoning.mjs): the caller asks again with more room. Any other empty answer is just empty.
function emptyAnswer(provider, apiKey, {thought, finishReason, extra = {}}) {
  const spent = provider === 'custom' && (finishReason === 'length' || (thought && !finishReason));
  return new MistralError('empty', spent ? 'spent its reply on thinking' : 'answered with no text', {apiKey, provider, ...(spent ? {reasoning: true} : {}), ...extra});
}

async function once({apiKey, model, messages, maxTokens, temperature, onDelta, shouldStop, signal, fetchImpl, url, firstByteMs, stallMs, promptStallMs = stallMs, totalMs, extraBody, provider, onHeaders, adapt, headers: extraHeaders, setTimer = setTimeout, clearTimer = clearTimeout,
  reasoning, noThinking, noThink, thinkingRoom, thinkingPieces = 0, deadlineCapped = false}) {
  const controller = new AbortController();
  let timedOut = null;   // which limit ended it: 'first', 'stall' or 'total'
  const trace = newTrace();
  const sentAt = performance.now();
  const since = () => Math.round(performance.now() - sentAt);
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, {once: true});
  const total = setTimer(() => { timedOut = 'total'; controller.abort(); }, totalMs);
  // The first stream event is waited for `firstByteMs`; after that, silence is waited for `promptStallMs` until the reply text starts and for `stallMs` from
  // then on (0: only the total limit).
  let waitedMs = firstByteMs;
  let first = setTimer(() => { timedOut = 'first'; controller.abort(); }, firstByteMs);
  const quiet = () => {
    clearTimer(first);
    waitedMs = trace.pieces === 0 ? promptStallMs : stallMs;
    if (waitedMs > 0) first = setTimer(() => { timedOut = 'stall'; controller.abort(); }, waitedMs);
  };
  // The error for the limit that fired: what the stream showed says what the model was doing (stallReason). A local server's timeout is never retried.
  const timeoutError = () => {
    trace.elapsedMs = since();
    const reason = stallReason(trace);
    const limit = Math.round((timedOut === 'stall' ? waitedMs : timedOut === 'total' ? totalMs : firstByteMs) / 1000);
    const lead = reason === 'no-response' ? 'did not answer in time' : reason === 'stalled' ? 'went quiet before the reply was finished' : 'did not finish in time';
    // 'stall' is silence after the first event; 'first' and 'total' are the limits on the whole wait (the total one may be the turn's own deadline).
    const silence = timedOut === 'stall' ? `${limit} s of silence` : `the ${limit} s limit`;
    const why = reason === 'no-response' ? `no response in ${limit} s`
      : reason === 'stalled' ? (timedOut === 'stall' ? `nothing for ${limit} s after ${trace.pieces} pieces` : `${trace.pieces} pieces, then ${silence}`)
      : reason === 'thinking-only' ? `only thinking, ${trace.reasoning} pieces, no reply`
      : reason === 'prefill-stalled' ? `prompt read ${trace.progress.processed} of ${trace.progress.total} tokens, then ${silence}`
      : `no first word in ${limit} s`;
    return new MistralError('network', `${lead} (${why})`, {apiKey, provider, slow: true, reason, trace, noRetry: provider === 'local', deadline: deadlineCapped && trace.elapsedMs >= totalMs - 50});
  };
  try {
    let response;
    try {
      // The custom provider's https connections are kept alive like Mistral's (the reply after a pause finds one ready).
      const dispatcher = isCloud(url) || (provider === 'custom' && url.startsWith('https:')) ? await remoteDispatcher() : undefined;
      const custom = provider === 'custom';
      const body = {model, messages: custom && (noThink || adapt?.noThink) && NO_THINK_MODEL.test(model) ? withNoThink(messages) : messages, stream: true,
        max_tokens: custom && thinkingRoom !== false && adapt?.floorTokens ? Math.max(maxTokens, adapt.floorTokens) : maxTokens, temperature, ...extraBody};
      // The field that asks a reasoning model to think less, at the step the server has not refused yet (bridge/reasoning.mjs).
      if (custom) Object.assign(body, reasoning?.[adapt?.reasoningStep ?? 0]);
      // The fields that ask for no thinking at all, for a server that has shown it thinks (a refused one is left out).
      if (noThinking) for (const [name, value] of Object.entries(noThinking)) if (!adapt?.noThinkDropped?.has(name)) body[name] = value;
      if (adapt) applyAdaptation(body, adapt);
      markStage('llmSent');
      response = await fetchImpl(url, {method: 'POST', signal: controller.signal, ...(dispatcher ? {dispatcher} : {}),
        // The key's origin is the endpoint's; a redirect to another host is an error, not something to follow with the key.
        ...(provider === 'custom' ? {redirect: 'error'} : {}),
        headers: {...(apiKey ? {Authorization: `Bearer ${apiKey}`} : {}), 'Content-Type': 'application/json',
          Accept: body.stream === false ? 'application/json' : 'text/event-stream', ...extraHeaders},
        body: JSON.stringify(body)});
    } catch (error) {
      if (timedOut) throw timeoutError();
      if (signal?.aborted) throw signal.reason ?? abortError();
      if (provider === 'custom' && /redirect/i.test(String(error?.cause?.message ?? error?.message ?? ''))) {
        const redirect = new MistralError('network', 'answered with a redirect to another address; check the endpoint URL', {apiKey, provider, trace: {...trace, elapsedMs: since()}});
        redirect.redirect = true;
        throw redirect;
      }
      throw new MistralError('network', `could not be reached (${redact(error?.cause?.code ?? error?.message ?? 'network error', apiKey)})`, {apiKey, provider, trace: {...trace, elapsedMs: since()}});
    }
    trace.headersMs = since();
    markStage('llmHeaders');
    // The rate-limit headers go to the caller (the shared request scheduler reads a per-second limit from them).
    try { onHeaders?.(response.headers); } catch { /* an observer never fails a reply */ }
    if (!response.ok) {
      const refused = await errorBody(response, provider);
      const failure = mapFailure(response.status, refused, {headers: response.headers, apiKey, provider});
      // A server of ours (the local route has no refused-field handling of its own) that refuses a field that asks for no thinking by name: sent again without it.
      if (noThinking && provider !== 'custom' && !failure.paramsRejected) {
        const refusal = rejectedParameters(response.status, textOf(refused));
        const named = refusal ? namedNoThinkFields(textOf(refused)) : [];
        if (named.length) failure.paramsRejected = {names: [], swap: false, reasoning: true, noThink: named};
        // A strict server that says "Extra inputs are not permitted" or "unknown field" without naming one (and without the word field or parameter): the fields we added from the first request
        // are the likely cause, so all three go, once, and the request is sent again at once (a server the player runs gets them from its first request, bridge/text-provider-host.mjs).
        else if ((response.status === 400 || response.status === 422) && UNKNOWN_FIELD_WORDS.test(textOf(refused).toLowerCase()) && !NO_SUCH_MODEL.test(textOf(refused).toLowerCase())) {
          failure.paramsRejected = {names: [], swap: false, reasoning: true, noThink: [...NO_THINKING_FIELDS]};
        }
      }
      failure.trace = {...trace, elapsedMs: since()};
      throw failure;
    }
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
      // What the model thought is not what it says: <think> blocks go, and so does everything before a closing tag that has no opening one.
      const thoughts = new ThinkFilter();
      const shown = thoughts.push(contentText(choice?.message?.content ?? choice?.text)) + thoughts.end();
      const cut = afterStrayClose(shown), whole = cut.text;
      if (!whole.trim()) {
        throw emptyAnswer(provider, apiKey, {finishReason: choice?.finish_reason,
          thought: reasoningIn(choice?.message) || thoughts.sawBlock || cut.stray || reasoningTokens(value.usage) > 0});
      }
      markStage('firstToken');
      onDelta?.(whole, whole);
      return {text: whole, model: typeof value.model === 'string' ? value.model : undefined, finishReason: choice?.finish_reason ?? 'stop', usage: value.usage, trace: {...trace, elapsedMs: since()}};
    }
    if (!response.body) throw new MistralError('network', 'sent no reply stream', {apiKey, provider, trace: {...trace, elapsedMs: since()}});
    let text = '', actualModel, finishReason, usage, stoppedEarly = false, sawDone = false, thought = false, thinkingStop = false;
    // The custom provider's streams: thoughts (a reasoning field, or <think> blocks in the text, however the chunks are cut) are not part of the reply.
    const thoughts = provider === 'custom' ? new ThinkFilter() : null;
    try {
      // After [DONE] the body is read to its end (bounded) instead of cancelled, so the connection is reused by the next turn.
      for await (const data of sseData(response.body, {drainMs: DRAIN_MS, setTimer, clearTimer})) {
        quiet();
        trace.events++; trace.eventMs ??= since();
        if (data === '[DONE]') { sawDone = true; break; }
        let chunk; try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk?.object === 'error' || chunk?.error) throw mapFailure(Number.isInteger(chunk.code) ? chunk.code : Number.isInteger(chunk.error?.code) ? chunk.error.code : 502, chunk, {apiKey, provider});
        if (typeof chunk?.model === 'string') actualModel = chunk.model;
        if (chunk?.usage) usage = chunk.usage;
        const reported = chunk?.prompt_progress;
        if (reported && Number(reported.total) > 0) trace.progress = {processed: Number(reported.processed) || 0, total: Number(reported.total), cache: Number(reported.cache) || 0};
        const timings = chunk?.timings;
        if (timings && typeof timings === 'object') trace.timings = {promptTokens: timings.prompt_n, cachedTokens: timings.cache_n, promptMs: timings.prompt_ms, generated: timings.predicted_n, tokensPerSecond: timings.predicted_per_second};
        const choice = chunk?.choices?.[0];
        if (!choice) continue;
        if (thoughts && reasoningIn(choice.delta)) thought = true;
        const piece = thoughts ? thoughts.push(contentText(choice.delta?.content)) : contentText(choice.delta?.content);
        if (!piece && (choice.delta?.reasoning_content || choice.delta?.reasoning)) {
          trace.reasoning++;
          // A local model that thinks instead of answering would use up its whole token allowance on it: stop it at once and say so.
          if (thinkingPieces > 0 && !text && trace.reasoning >= thinkingPieces) { thinkingStop = true; break; }
        }
        if (piece) {
          if (!text) { markStage('firstToken'); trace.firstTokenMs = since(); }
          trace.pieces++;
          quiet();   // the reply text has started: from here the (shorter) stallMs counts
          text += piece;
          onDelta?.(piece, text);
          if (shouldStop?.(text)) { stoppedEarly = true; break; }
        }
        if (choice.finish_reason) finishReason = trace.finishReason = choice.finish_reason;
        if (choice.finish_reason === 'error') throw new MistralError('network', 'stopped the reply with an error', {apiKey, provider, trace: {...trace, elapsedMs: since()}});
      }
      if (thoughts && !stoppedEarly) {
        // A "<" that never became a tag is part of the text; a block that never closed was all thinking.
        const rest = thoughts.end();
        if (rest) { text += rest; onDelta?.(rest, text); }
      }
      // A server the player runs can die while it writes (a killed KoboldCpp closes the stream as cleanly as a finished one): a stream that ends
      // with neither "[DONE]" nor a finish_reason is a reply cut off, not a finished one. The cloud's streams always end with one of them.
      if ((provider === 'local' || provider === 'custom') && !stoppedEarly && !thinkingStop && !sawDone && !finishReason) throw new MistralError('network', 'went quiet before the reply was finished', {apiKey, provider, partial: !!text.trim(), reason: 'stalled', trace: {...trace, elapsedMs: since()}});
    } catch (error) {
      if (timedOut) throw timeoutError();
      if (signal?.aborted) throw signal.reason ?? abortError();
      if (error instanceof MistralError && !error.trace) error.trace = {...trace, elapsedMs: since()};
      throw error;
    }
    trace.elapsedMs = since();
    if (thinkingStop) throw new MistralError('empty', `answered only with thinking (${trace.reasoning} pieces) and no reply`, {apiKey, provider, reason: 'thinking-only', noRetry: true, trace});
    if (thoughts) {
      // A closing tag with no opening one (the server's template opened the block in the prompt): what is before it was thinking.
      const cut = afterStrayClose(text);
      if (cut.stray) text = cut.text;
      thought = thought || thoughts.sawBlock || cut.stray || reasoningTokens(usage) > 0;
    }
    if (!text.trim()) throw emptyAnswer(provider, apiKey, {thought, finishReason, extra: {reason: trace.reasoning > 0 ? 'thinking-only' : undefined, trace}});
    return {text, model: actualModel, finishReason: stoppedEarly ? 'stop' : finishReason, usage, trace};
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
