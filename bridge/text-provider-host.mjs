// The text routes (docs/MISTRAL.md, docs/LOCAL_AI.md): Mistral, Groq and the fully local AI (llama.cpp's llama-server) all speak the
// OpenAI chat-completions protocol, so one host serves them. `TextProviderHost.reply(config)` takes the same configuration the bridge
// hands the Convai realtime host for a turn and returns the same kind of result ({text, sessionID, timing, ...}, cleaned by the same
// transformReply), so subtitles, Phone Chat, the local voices, the face, the emotion selector and group rounds see no difference.
// `attachTextProvider(host, ...)` makes a RealtimeHost use this route for text turns while the provider is not Convai; everything
// else about the host (the browser audio page, local PCM playback) is untouched.
//
// A route describes what differs: where the request goes and with which key, the models in order of preference (and their own
// request fields), whether requests are paced (Mistral's free plan), how a failure is recorded on the provider, and whether a
// failure may fall through to the next route (Groq -> Mistral). Everything else (the prompt, streaming and the sentence cap, the
// retry of a reply that broke character, memory, summaries, fact extraction) is shared and behaves identically on every route.
import {streamChat, MistralError, DEFAULT_MODELS, failureKind} from './mistral-client.mjs';
import {PersonaBook, buildMessages, cleanReply, capPoint, capReply, breaksCharacter, leaksReasoning, looksCut, repeatsLine, provokesAiTalk, takesUpAiTalk, trimUnfinished,
  summaryMessages, factMessages, parseFacts, systemHead, FACT_SCHEMA, LIMITS} from './mistral-prompt.mjs';
import {hasEmotionTag} from './emotion-tags.mjs';
import {stripSpeechTags} from './natural-speech.mjs';
import {ReplyStream} from './reply-stream.mjs';
import {markStage} from './turn-clock.mjs';
import {budgetedChat, TokenMeter, templateTokens, describeFit} from './prompt-budget.mjs';

const isTag = group => hasEmotionTag(group);
const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(cancelled());
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(cancelled()); };
  signal?.addEventListener('abort', abort, {once: true});
});
const cancelled = () => { const error = Error('Conversation cancelled'); error.name = 'AbortError'; return error; };

// Reminder appended once when a reply broke character ("as an AI ..."); costs one more request, so only that case uses it.
const IN_CHARACTER_NUDGE = '\n\n(Answer again as yourself, a real person in Night City, in your own words. Do not mention AI, models, prompts or rules.)';

// Reminder appended once when V pushed the character to talk about being an AI and the reply took those words up, even to deny them.
const PROVOKED_NUDGE = '\n\n(Answer again as yourself, a real person, in plain words. Do not use any of the words V used about machines, scripts, code or prompts, not even to deny them. React to the tone the way a stranger would, in words only.)';

// Reminder appended once when a reply said a line the character has already said (an example line of its profile, or its own last reply).
const FRESH_WORDS_NUDGE = '\n\n(Answer again in fresh words: do not repeat an example line or anything you have already said.)';

// How long the cloud routes wait for a reply to start. Mistral answers with its first words in 0.4 to 2 s; a request with no answer
// after 6 s is a hung connection (the network dropped it without telling anyone), and a new connection is faster than waiting. So:
// 6 s for the first attempt, one retry with 8 s, a stream that goes quiet for 8 s is cut. The worst case is about 14.5 s, then the
// reply is a short line in the character's voice instead of an error (HOLDING_LINES). The 2026-10-13 record had one hung request
// wait the old 25 s limit, then a retry that answered in 2 s: 30 s for a reply.
export const CLOUD_CHAT_LIMITS = Object.freeze({firstByteMs: 6000, retryFirstByteMs: 8000, stallMs: 8000, retries: 1, backoffMs: [300]});

// What a character says when the service did not answer in time (twice) or a server fault ended the reply, so the player gets a
// short in-character line instead of a long silence and an error. Never recorded in the character's memory.
export const HOLDING_LINES = Object.freeze([
  'Hang on, V. I lost my train of thought there. Say that again?',
  'Sorry, V. I spaced out for a second. What was that?',
  'Hold on. I lost you for a moment there. Say it again?',
]);

const LOCAL_UNAVAILABLE =/\[local:unavailable\]/;
/** Is this error "the local AI cannot be used" (not installed, not enough graphics memory, would not start)? */
export const isLocalUnavailable = error => LOCAL_UNAVAILABLE.test(typeof error?.message === 'string' ? error.message : '');

// ---- Routes ------------------------------------------------------------------------------------------------------------------

/**
 * Mistral: the player's own key, the models in preference order (a model with a request allowance of 0 is skipped for ten
 * minutes), requests paced about a second apart (the free plan), and a stable `prompt_cache_key` per character so the long persona
 * prefix is cached on Mistral's side (measured: 98% of the prompt cached, about 20% faster, cached tokens do not count against the
 * token budget; docs/FREE_CLOUD_OPTION_RESEARCH.md).
 */
export function mistralRoute({provider, model = () => DEFAULT_MODELS, chat = streamChat, endpoint, gapMs = 1100, onFailure, onSuccess,
  cacheScope = '', now = () => performance.now(), scheduler, priorities = {TEXT: 0, BACKGROUND: 2}, chatDefaults = CLOUD_CHAT_LIMITS} = {}) {
  return {name: 'mistral', provider: 'mistral', chat, endpoint, gapMs, now, blocked: new Map(), nextSlot: 0, scheduler, priorities,
    chatDefaults,
    noteHeaders: scheduler ? headers => { try { scheduler.noteHeaders(headers); } catch { /* spacing is best effort */ } } : undefined,
    models: () => [model()].flat().map(id => ({id})),
    async connect() { return {apiKey: provider.apiKey}; },
    // The cache key must not hold secrets: the install scope is a hash, the rest is the character.
    cacheBody: profileKey => profileKey ? {prompt_cache_key: `cyberpunk-convai:${cacheScope}:${profileKey}`.slice(0, 120)} : {},
    jsonBody: () => ({response_format: {type: 'json_object'}}),
    summarizeAllowed: () => !(provider.limit && provider.limit.kind === 'invalid'),
    fallsBack: () => false,
    success() { provider.noteSuccess(); try { onSuccess?.(); } catch { /* an observer never fails a reply */ } },
    failure(error) {
      const kind = failureKind(error);
      provider.noteLimit(kind === 'limit' ? 'rate' : kind === 'key' ? 'invalid' : kind === 'model' ? 'model' : null);
      try { onFailure?.(error); } catch { /* an observer never fails a reply */ }
    },
    label: 'Mistral'};
}

// Groq's free plan is small (8,000 tokens a minute, 200,000 a day per model; docs/FREE_CLOUD_OPTION_RESEARCH.md): a limit is not
// an error to the player when a Mistral key exists, the turn simply goes there.
const GROQ_DAILY = /per day|\bTPD\b|\bRPD\b|daily/i;
/**
 * Groq: the player's own key; `qwen/qwen3.8-27b` with reasoning off first, then `openai/gpt-oss-20b` with low effort. Caching is
 * automatic on gpt-oss, so the stable prefix order of the prompt is all it needs. A key, limit or model failure is remembered on the
 * provider (Groq is left alone for a while) and the turn falls through to the next route (Mistral) when there is one.
 */
export function groqRoute({provider, chat = streamChat, endpoint, onFailure, onSuccess,
  models = () => GROQ_MODELS, log = () => {}} = {}) {
  // A request above the plan's 8,000 tokens a minute (reply included) is refused for good, so the prompt is cut to fit
  // (bridge/prompt-budget.mjs). Groq reports no token count the host reads, so this is an estimate with the default ratio.
  const meter = new TokenMeter();
  chat = budgetedChat(chat, {budget: () => ({contextTokens: GROQ_REQUEST_TOKENS, reserveTokens: 256, meter}), onFit: fit => log('Groq: ' + describeFit(fit))});
  return {name: 'groq', provider: 'groq', chat, endpoint, gapMs: 0, blocked: new Map(), nextSlot: 0, models, chatDefaults: CLOUD_CHAT_LIMITS,
    async connect() { return {apiKey: provider.groqApiKey}; },
    cacheBody: () => ({}),
    jsonBody: () => ({response_format: {type: 'json_object'}}),
    summarizeAllowed: () => !provider.groqLimit,
    fallsBack: error => ['limit', 'key', 'model'].includes(failureKind(error)),
    success() { provider.noteGroqSuccess(); try { onSuccess?.(); } catch { /* an observer never fails a reply */ } },
    failure(error) {
      const kind = failureKind(error);
      if (kind === 'limit') provider.noteGroqLimit(error?.daily || GROQ_DAILY.test(error?.message ?? '') ? 'daily' : 'rate');
      else if (kind === 'key') provider.noteGroqLimit('invalid');
      else if (kind === 'model') provider.noteGroqLimit('model');
      try { onFailure?.(error); } catch { /* an observer never fails a reply */ }
    },
    label: 'Groq'};
}
// The most tokens one Groq request may carry on the free plan (tokens per minute).
export const GROQ_REQUEST_TOKENS = 8000;
// Request fields per model. Reasoning must stay off or low and must not use up the reply's token budget.
export const GROQ_MODELS = Object.freeze([
  {id: 'qwen/qwen3.8-27b', body: {reasoning_effort: 'none'}, maxTokens: 200},
  // Hidden reasoning counts against max_tokens (a limit of 20 left an empty reply), so this one gets headroom; the reasoning text
  // itself is not requested. Groq rejects unknown fields (prompt_cache_key is a 400), so nothing else is added.
  {id: 'openai/gpt-oss-20b', body: {reasoning_effort: 'low', include_reasoning: false}, maxTokens: 256},
]);

/**
 * The fully local AI: the supervised llama-server (bridge/local-llm-server.mjs). No pacing, no key of the player's: the
 * supervisor's per-session key on a loopback port. Starting the server is part of `connect` (it waits for the model to load on the
 * first turn after an idle unload). Background work (summaries, facts) never starts the server: it runs only while it is loaded.
 */
export function localRoute({server, chat = streamChat, provider, onFailure, log = () => {}} = {}) {
  // Every request is fitted to the context the server really has (bridge/prompt-budget.mjs): n_ctx is read from the server, the prompt is
  // cut in a fixed order of priority when it does not fit, and a refusal that still comes (an estimate that was low) is learned from.
  const meters = new Map();
  chat = budgetedChat(chat, {
    budget: async options => {
      const handle = await server.ensure({signal: options?.signal});
      if (!(handle?.contextSize > 0)) return null;
      if (!meters.has(handle.model)) meters.set(handle.model, new TokenMeter());
      const count = typeof server.tokenize !== 'function' ? undefined : async messages => {
        const tokens = await server.tokenize(messages.map(message => message.content).join('\n'), {signal: options?.signal});
        return tokens === null ? null : tokens + templateTokens(messages.length);
      };
      return {contextTokens: handle.contextSize, meter: meters.get(handle.model), count};
    },
    onFit: fit => log('The local AI: ' + describeFit(fit))});
  return {name: 'local', provider: 'local', chat, gapMs: 0, blocked: new Map(), nextSlot: 0,
    models: () => [{id: 'local'}],
    async connect(signal, {background = false} = {}) {
      if (background && server.status().state !== 'ready') throw new MistralError('network', 'is not loaded right now', {provider: 'local'});
      const connection = await server.ensure({signal, background});
      // A request in flight keeps the server loaded; releasing it re-arms the idle timer.
      const done = typeof server.begin === 'function' ? server.begin() : null;
      return {apiKey: connection.apiKey, endpoint: connection.endpoint, model: connection.model,
        release: () => { try { if (done) done(); else server.touch?.(); } catch { /* the idle timer is best effort */ } }};
    },
    // The closing chunk of a reply carries the server's own count of the prompt, which the token meter learns from.
    cacheBody: () => ({stream_options: {include_usage: true}}),
    chatDefaults: {retries: 1, backoffMs: [400], firstByteMs: 90_000, totalMs: 90_000},
    jsonBody: () => ({response_format: {type: 'json_schema', json_schema: {name: 'facts', strict: true, schema: FACT_SCHEMA}}}),
    summarizeAllowed: () => true,
    // Any failure of a local turn (a refused prompt, no answer, a server that went away) hands the turn to the player's cloud provider
    // when there is one (TextProviderHost#candidates); without one the turn fails and the game says so (local-failed).
    fallsBack: () => true,
    // The turn is about to be answered by the cloud: the game tells the player once (a start that failed has its own notice).
    fellBack(error) { if (!isLocalUnavailable(error)) provider?.noteLocalTurnFallback?.(); },
    success() { /* nothing to clear */ },
    failure(error) {
      if (isLocalUnavailable(error)) provider?.noteLocalFailure?.(error.reason ?? 'start-failed');
      try { onFailure?.(error); } catch { /* an observer never fails a reply */ }
    },
    prewarm: messages => server.prewarm(messages),
    label: 'The local AI'};
}

// ---- Host --------------------------------------------------------------------------------------------------------------------

export class TextProviderHost {
  /**
   * provider    the provider state (bridge/mistral-key.mjs): `route` names the route in use, `active` whether one is
   * routes      {mistral, groq, local}: route objects as above
   * memory      MistralMemory or MemoryStore (bridge/memory-store.mjs; adds retrieval and fact extraction)
   * personas    PersonaBook
   * transformReply   the bridge's cleanReply (Natural speech, Expressive emotions)
   * gate        () => boolean: may background work (summaries, facts) run now? (the bridge: no combat, nothing speaking)
   * resolveProfile   config => profile key, for warm connections that carry no `local` field
   * idleRetryMs   how often a gated background task checks the gate again
   */
  constructor({provider, memory, personas = new PersonaBook(), routes = {}, transformReply = result => result, now = () => performance.now(),
    log = () => {}, limits = LIMITS, gate, resolveProfile, idleRetryMs = 10_000} = {}) {
    if (!provider) throw Error('Text provider required');
    Object.assign(this, {provider, memory, personas, routes, transformReply, now, log, limits, gate, resolveProfile, idleRetryMs});
    this.summaries = new Set();
    this.holdingTurns = 0;
    this.timers = new Set();
    this.closed = false;
    // Facts are extracted by the memory store when it is idle; it calls back here for the model request.
    this.memory?.setExtractor?.(task => this.#extract(task));
  }

  // The free plan allows about one request a second. Every request takes the next free start slot, so two requests (a reply and
  // the summary of older talk, or two companions in a group round) never start closer together than `gapMs`.
  // A route may bring the account's scheduler (`route.scheduler`, bridge/mistral-rate.mjs): it spaces the starts of every request on the
  // same Mistral key (text and speech), serves a reply before background work and retries a 429 after its retry-after. `#request` is the
  // only place a Mistral text request is sent, so this is the only place it is paced.
  async #slot(route, signal) {
    if (route.scheduler || !route.gapMs) return;
    const now = route.now ? route.now() : this.now();
    const start = Math.max(now, route.nextSlot);
    route.nextSlot = start + route.gapMs;
    if (start > now) await pause(start - now, signal);
  }

  #request(route, messages, signal, extra = {}) {
    const {priority, ...options} = extra;
    if (!route.scheduler) return this.#slot(route, signal).then(() => this.#send(route, messages, signal, options));
    return route.scheduler.schedule(() => this.#send(route, messages, signal, options),
      {priority: priority === 'background' ? route.priorities.BACKGROUND : route.priorities.TEXT, signal, retries: 1, label: 'text'});
  }

  async #send(route, messages, signal, extra = {}) {
    const {profileKey, background, extraBody, ...rest} = extra;
    const lease = await route.connect(signal, {background});
    try {
      // The models in order of preference. A model the account has no allowance for (limit 0) is skipped for ten minutes.
      const wanted = route.models();
      const now = Date.now();
      const usable = wanted.filter(item => !(route.blocked.get(item.id) > now));
      let lastError;
      for (const item of usable.length ? usable : wanted.slice(0, 1)) {
        try {
          return await route.chat({apiKey: lease.apiKey, model: item.id, messages, signal, endpoint: lease.endpoint ?? route.endpoint,
            provider: route.provider, maxTokens: item.maxTokens ?? this.limits.maxTokens, temperature: this.limits.temperature,
            ...(route.chatDefaults ?? {}), ...rest, onHeaders: route.noteHeaders,
            onRetry: ({attempt, error, waitMs, ms}) => this.log(`${route.label} attempt ${attempt} failed after ${ms} ms (${error.kind}${error.status ? ` ${error.status}` : ''}${error.slow ? ', no answer in time' : ''}); asking again in ${waitMs} ms`),
            extraBody: {...route.cacheBody(profileKey), ...(item.body ?? {}), ...extraBody}});
        } catch (error) {
          if (!(error instanceof MistralError) || !error.zeroQuota) throw error;
          route.blocked.set(item.id, now + 10 * 60_000);
          this.log(`no allowance for ${item.id}; trying the next model`);
          lastError = error;
        }
      }
      throw lastError;
    } finally { try { lease.release?.(); } catch { /* best effort */ } }
  }

  /** The routes a turn may use, in order: the provider's own, then (Groq only) Mistral when the player has a Mistral key. */
  #candidates() {
    const first = this.routes[this.provider.route];
    if (!first) throw new MistralError('request', 'has no route for this provider');
    const list = [first];
    if (first.name === 'groq' && this.routes.mistral && this.provider.apiKey) list.push(this.routes.mistral);
    // The local AI: the player's own cloud provider answers a turn it could not (Mistral when a key is saved, else Groq).
    if (first.name === 'local') {
      const groqReady = this.routes.groq && this.provider.groqApiKey && Date.now() >= (this.provider.groqBlockedUntil ?? 0);
      const cloud = this.routes.mistral && this.provider.apiKey ? this.routes.mistral : groqReady ? this.routes.groq : null;
      if (cloud) list.push(cloud);
    }
    return list;
  }

  /**
   * `stream` (optional, bridge/reply-stream.mjs): the voice's view of the reply while it is written. It is fed the text as it
   * arrives, told when the reply is finished (with the text the voice and subtitles end with) or failed, and a first sentence
   * that is safe to speak is handed to the voice before the model is done. Without one the reply is built exactly as before.
   */
  async reply(config, {signal, stream} = {}) {
    if (signal?.aborted) throw cancelled();
    const local = config?.local;
    if (!local || typeof local.profileKey !== 'string') throw new MistralError('request', 'turn has no character');
    const text = typeof config.text === 'string' ? config.text : '';
    if (!text.trim()) throw new MistralError('request', 'turn has no message');
    const started = this.now();
    // A turn starts: background memory work (fact extraction) gives way to it.
    try { this.memory?.interrupt?.(); } catch { /* best effort */ }
    const persona = this.personas.persona(local.profileKey, local.name);
    const reaction = !!config.reaction;
    const memoryKey = {profileKey: local.profileKey, channel: local.channel, ambientKey: local.ambientKey};
    // The stream the reply text goes through: the voice's, or one that only marks the first sentence on the turn's clock.
    const feed = stream ?? new ReplyStream({name: persona.name, isTag, speak: false});
    const recalled = reaction ? this.memory.recall({...memoryKey, channel: 'private'}) : this.memory.recall(memoryKey);
    // What the memory store remembers that bears on V's words (private and phone talk of a named character; empty otherwise and
    // whenever it cannot answer in a few hundred milliseconds).
    let remembered = [];
    if (!reaction && config.contextParts && typeof this.memory?.retrieve === 'function') {
      try { remembered = await this.memory.retrieve({...memoryKey, query: text, signal}) ?? []; } catch { remembered = []; }
      if (signal?.aborted) throw cancelled();
    }
    markStage('recalled');
    const candidates = this.#candidates();
    for (const [index, route] of candidates.entries()) {
      try {
        const outcome = await this.#replyOn(route, {config, persona, reaction, recalled, remembered, text, signal, memoryKey, profileKey: local.profileKey, feed});
        const elapsed = Math.round(this.now() - started);
        const {response} = outcome;
        // What was already spoken stands: a finished reply that does not begin with it is cut back to it.
        const reply = feed.reconcile(outcome.reply);
        // The exchange is remembered without tags (what the player read), except a battle / loot line, which is not a talk.
        if (!reaction) {
          this.memory.record({...memoryKey, v: text, r: stripSpeechTags(reply)});
          this.#summarize(route, local.profileKey);
        }
        markStage('replyReturned');
        const result = this.transformReply({text: reply, sessionID: config.sessionId, transport: route.name,
          timing: {provider: route.name, llmMs: elapsed, model: response.model ?? route.models()[0]?.id, attempts: response.attempts,
            ...(response.failed?.length ? {llmFailed: response.failed} : {}),
            ...(feed.committed ? {streamedHead: true} : {})}});
        feed.finish(result.text, result);
        return result;
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError' && !(error instanceof MistralError)) { feed.fail(error); throw error; }
        route.failure(error);
        if (index < candidates.length - 1 && route.fallsBack(error) && !feed.committed) {
          this.log(`${route.label} could not answer (${failureKind(error) ?? 'error'}); using ${candidates[index + 1].label}`);
          try { route.fellBack?.(error); } catch { /* a notice never fails the turn */ }
          continue;
        }
        const standing = this.#standingReply(route, error, {reaction, config, text, memoryKey, feed, started, profileKey: local.profileKey});
        if (standing) return standing;
        feed.fail(error);
        throw error;
      }
    }
    const none = new MistralError('request', 'has no route for this provider');
    feed.fail(none);
    throw none;
  }

  /**
   * A reply the service could not finish (no answer in time after the retry, a stream that went quiet, a server fault):
   *  - the first sentence was already spoken: that sentence is the reply (the voice and the written reply agree, nothing is switched);
   *  - nothing was spoken and the service was merely slow: a short line in the character's voice (HOLDING_LINES), not recorded in its
   *    memory, instead of an error and a long silence. A battle or loot bark just stops, as it does for every failure.
   * Any other failure (a refused key, a limit, no network) is still an error: the player can act on it. Returns the reply or null.
   */
  #standingReply(route, error, {reaction, config, text, memoryKey, feed, started, profileKey}) {
    if (!(error instanceof MistralError) || route.name === 'local') return null;
    const head = feed.committed ? feed.head : '';
    if (!head && (reaction || !error.slow)) return null;
    const spoken = head || HOLDING_LINES[this.holdingTurns++ % HOLDING_LINES.length];
    // What the character really said is remembered; the holding line is not (it answers nothing).
    if (head && !reaction) { this.memory.record({...memoryKey, v: text, r: stripSpeechTags(head)}); this.#summarize(route, profileKey); }
    this.log(head ? `${route.label} stopped after the first sentence (${error.kind}); that sentence is the reply`
      : `${route.label} did not answer in time (${(error.failed ?? []).map(item => `${item.kind} ${item.ms} ms`).join(', ') || error.kind}); the character says a short holding line`);
    markStage('replyReturned');
    const result = this.transformReply({text: spoken, sessionID: config.sessionId, transport: route.name,
      timing: {provider: route.name, llmMs: Math.round(this.now() - started), model: route.models()[0]?.id, attempts: error.failed?.length ?? 1,
        ...(error.failed?.length ? {llmFailed: error.failed} : {}), ...(head ? {streamedHead: true, replyCutShort: error.kind} : {holdingLine: true})}});
    feed.finish(result.text, result);
    return result;
  }

  async #replyOn(route, {config, persona, reaction, recalled, remembered, text, signal, profileKey, feed}) {
    const build = nudge => buildMessages({persona, memory: recalled.summary, history: recalled.turns, context: config.context,
      contextParts: config.contextParts, remembered, text: nudge ? text + nudge : text, reaction, limits: this.limits});
    const shouldStop = soFar => capPoint(cleanReply(soFar, {name: persona.name, isTag}), this.limits) >= 0;
    const run = async nudge => {
      const messages = build(nudge);
      markStage('promptBuilt');
      const response = await this.#request(route, messages, signal, {shouldStop, profileKey, onDelta: (_piece, soFar) => { try { feed.update(soFar); } catch { /* the voice's view of the reply never breaks the reply */ } }});
      markStage('fullText');
      let cleaned = cleanReply(response.text, {name: persona.name, isTag});
      if (response.finishReason === 'length') cleaned = trimUnfinished(cleaned);
      const reply = capReply(cleaned, this.limits);
      if (!reply.trim()) throw new MistralError('empty', 'answered with no text', {provider: route.provider});
      return {response, reply};
    };
    // The lines this character must not say again: its profile's example lines and its own earlier replies (not for a battle or loot bark).
    const said = reaction ? [] : [...persona.samples, ...recalled.turns.map(turn => turn.r)];
    // V trying to make the character say it is an AI or a script: the reply must not take those words up, even to deny them.
    const provoked = !reaction && provokesAiTalk(text);
    if (feed && typeof feed === 'object') feed.reject = said.length || provoked ? head => repeatsLine(head, said) || (provoked && takesUpAiTalk(head)) : null;
    let outcome = await run('');
    // A reply that steps out of character, or is a model's reasoning, gets one more try. The second answer is used unless it
    // is reasoning again, which is never spoken (it counts as an empty answer). A reply whose first sentence the voice already
    // started is not tried again: that sentence was checked before it was spoken, so it stands and the rest is dropped.
    // A reply that says a line already said (an example line, its own last reply) gets the same one more try.
    const repeated = repeatsLine(outcome.reply, said), echoed = provoked && takesUpAiTalk(outcome.reply);
    if ((breaksCharacter(outcome.reply) || leaksReasoning(outcome.reply) || looksCut(outcome.reply) || repeated || echoed) && !signal?.aborted) {
      if (feed.committed) {
        this.log(repeated ? 'reply repeated a line after its first sentence was spoken; keeping that sentence' : 'reply broke character after its first sentence was spoken; keeping that sentence');
        outcome = {...outcome, reply: feed.head};
      } else {
        this.log(repeated ? 'reply repeated a line; asking once more' : 'reply broke character; asking once more');
        try { outcome = await run(repeated ? FRESH_WORDS_NUDGE : echoed && !breaksCharacter(outcome.reply) ? PROVOKED_NUDGE : IN_CHARACTER_NUDGE); } catch (error) { if (signal?.aborted) throw error; /* keep the first */ }
      }
    }
    if (leaksReasoning(outcome.reply) || looksCut(outcome.reply) && outcome.reply.split(/\s+/).length < 4) throw new MistralError('empty', 'answered with its reasoning or a cut-off line', {provider: route.provider});
    route.success();
    return outcome;
  }

  /** Runs `task` when background work may run (the bridge's gate: no combat, nothing speaking); checks again every 10 s until then. */
  #whenIdle(task) {
    const attempt = () => {
      if (this.closed) return;
      if (this.gate && !this.gate()) { this.#later(attempt, this.idleRetryMs); return; }
      task();
    };
    attempt();
  }
  #later(fn, ms) {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }

  // Folds older exchanges into the character's summary, one request per `batch` exchanges, never while one is running for the
  // character and not at all while the provider is known to refuse requests. Fire and forget: the reply is already on its way.
  // The fully local route also waits until background work may run, so it never competes with a reply or a fight for the GPU.
  #summarize(route, profileKey) {
    if (!route.summarizeAllowed()) return;
    if (this.summaries.has(profileKey)) return;
    const batch = this.memory.pendingSummary(profileKey);
    if (!batch) return;
    this.summaries.add(profileKey);
    this.memory.beginSummary(profileKey);
    const name = this.personas.persona(profileKey).name;
    const work = async () => {
      try {
        // Queued behind the reply that triggered it: never within one slot of a chat request.
        if (!route.scheduler) await pause(route.gapMs);
        const response = await this.#request(route, summaryMessages({name, summary: batch.summary, turns: batch.turns}), undefined,
          {maxTokens: 260, temperature: 0.3, retries: 1, totalMs: 40000, background: route.name === 'local', priority: 'background'});
        const text = cleanReply(response.text, {name, isTag});
        if (!this.memory.applySummary(profileKey, text, batch)) this.memory.failSummary(profileKey);
      } catch (error) {
        this.memory.failSummary(profileKey);
        this.log('summary failed: ' + (failureKind(error) ?? 'error'));
      } finally { this.summaries.delete(profileKey); }
    };
    if (route.name === 'local' || this.gate) this.#whenIdle(() => { void work(); }); else void work();
  }

  // The memory store's fact extraction (bridge/memory-store.mjs): it decides when (idle, 6 exchanges), this makes the request.
  async #extract({profileKey, turns, known, signal}) {
    const route = this.routes[this.provider.route];
    if (!route || !this.provider.active || !route.summarizeAllowed()) throw new MistralError('request', 'cannot extract facts now');
    const name = this.personas.persona(profileKey).name;
    const response = await this.#request(route, factMessages({name, turns, known}), signal,
      {maxTokens: 300, temperature: 0.2, retries: 1, totalMs: 40000, background: route.name === 'local', priority: 'background', extraBody: route.jsonBody()});
    return parseFacts(response.text, {known});
  }

  /**
   * A companion joined or was invited: let the local server load the persona prefix into its prompt cache so the first reply is
   * quick. Best effort, never throws, and only for routes that have a server to warm.
   */
  async prewarm(config) {
    const route = this.routes[this.provider.route];
    if (!route?.prewarm || this.closed) return;
    try {
      const key = config?.local?.profileKey ?? this.resolveProfile?.(config);
      if (typeof key !== 'string') { await route.connect(undefined, {}).then(lease => lease.release?.()); return; }
      const persona = this.personas.persona(key, config?.local?.name);
      await route.prewarm([{role: 'system', content: systemHead({persona, limits: this.limits})}, {role: 'user', content: '.'}]);
    } catch (error) {
      route.failure?.(error);
      this.log('prewarm failed: ' + (failureKind(error) ?? 'error'));
    }
  }

  /** What Forget does to this provider's memory. */
  forget(scope) { return this.memory.forget(scope); }

  close() { this.closed = true; for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
}

/**
 * Makes `host` (a RealtimeHost) answer text turns through `textHost` while `provider.active` is true. Only the text path is
 * replaced: the host's browser page, local PCM playback and Convai connections stay as they are and are used again the moment
 * the provider is Convai. While a text provider is active:
 *   reply     the text route (the `local` field the bridge adds to a turn's configuration names the character)
 *   prepare   refused (a speculative turn has no meaning here)
 *   warm      succeeds at once and opens no connection (an invitation is ready without one); the local AI loads its persona prefix
 *   readiness reports a ready connection
 *   voiceChannel  a channel that refuses with a message the voice key turns into a notice (until local speech recognition exists)
 * `prewarmVoice` (default true): a warm-up also opens the host's local voice renderer (the phone host has none to open).
 * `speech` is an optional hook for local speech recognition (bridge/local-stt.mjs): {available(): boolean, voiceChannel({reply})}.
 */
export function attachTextProvider(host, {provider, mistral, speech, prewarmVoice = true} = {}) {
  const textHost = mistral;
  const original = {reply: host.reply, prepare: host.prepare, warm: host.warm, readiness: host.readiness, lateEmotion: host.lateEmotion,
    refreshIdle: host.refreshIdle, voiceChannel: host.voiceChannel};
  const withoutLocal = config => {
    if (!config || !('local' in config || 'contextParts' in config)) return config;
    const {local: _local, contextParts: _parts, ...rest} = config;
    return rest;
  };
  const label = () => ({mistral: 'Mistral', groq: 'Groq', local: 'the local AI'})[provider.route] ?? 'Mistral';
  host.reply = function reply(config, options) {
    return provider.active ? textHost.reply(config, options) : original.reply.call(this, withoutLocal(config), options);
  };
  host.prepare = function prepare(config, options) {
    if (provider.active) return Promise.reject(Error(`A speculative turn is not available with ${label()}`));
    return original.prepare.call(this, withoutLocal(config), options);
  };
  host.warm = function warm(config, options) {
    if (!provider.active) return original.warm.call(this, withoutLocal(config), options);
    if (provider.route === 'local') void textHost.prewarm?.(config);
    // The local voice's browser and renderer page open now, while V types or looks, not in front of the first reply.
    if (prewarmVoice) void this.prewarmLocal?.();
    return Promise.resolve({connectionMs: 0, provider: provider.route});
  };
  host.readiness = function readiness(config, options) {
    return provider.active ? Promise.resolve({present: true, ready: true}) : original.readiness.call(this, config, options);
  };
  host.lateEmotion = function lateEmotion(config, token) {
    return provider.active ? Promise.resolve({}) : original.lateEmotion.call(this, config, token);
  };
  host.refreshIdle = function refreshIdle(config) {
    return provider.active ? Promise.resolve(true) : original.refreshIdle.call(this, config);
  };
  host.voiceChannel = function voiceChannel() {
    if (!provider.active) return original.voiceChannel.call(this);
    // Local speech recognition (bridge/local-stt.mjs) supplies a channel that turns the recording into text and answers it
    // through the text route; without it the voice key says voice needs Convai.
    if (speech?.available?.() && typeof speech.voiceChannel === 'function') return speech.voiceChannel({reply: (config, options) => textHost.reply(config, options)});
    const refuse = () => Promise.reject(Error(`Voice needs Convai for now: speech recognition is not available with ${label()} [mistral:voice]`));
    return {beginVoice: refuse, finishVoice: refuse, heard: async () => '', close: async () => {}};
  };
  return host;
}
