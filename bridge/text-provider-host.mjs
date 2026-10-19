// The text routes (docs/MISTRAL.md, docs/LOCAL_AI.md): Mistral and the fully local AI (llama.cpp's llama-server) both speak the
// OpenAI chat-completions protocol, so one host serves them. `TextProviderHost.reply(config)` takes the same configuration the bridge
// hands the Convai realtime host for a turn and returns the same kind of result ({text, sessionID, timing, ...}, cleaned by the same
// transformReply), so subtitles, Phone Chat, the local voices, the face, the emotion selector and group rounds see no difference.
// `attachTextProvider(host, ...)` makes a RealtimeHost use this route for text turns while the provider is not Convai; everything
// else about the host (the browser audio page, local PCM playback) is untouched.
//
// A route describes what differs: where the request goes and with which key, the models in order of preference (and their own
// request fields), whether requests are paced (Mistral's free plan), how a failure is recorded on the provider, and whether a
// failure may fall through to the next route (Local -> Mistral). Everything else (the prompt, streaming and the sentence cap, the
// retry of a reply that broke character, memory, summaries, fact extraction) is shared and behaves identically on every route.
import {streamChat, MistralError, DEFAULT_MODELS, failureKind} from './mistral-client.mjs';
import {PersonaBook, buildMessages, cleanReply, stripPlayerEcho, speakerTurn, startsLikeLine, capPoint, capReply, breaksCharacter, leaksReasoning, looksCut, repeatsLine, provokesAiTalk, takesUpAiTalk, trimUnfinished,
  summaryMessages, factMessages, capWords, overWords, remarkTokens, parseFacts, systemHead, joinBlocks, FACT_SCHEMA, LIMITS} from './mistral-prompt.mjs';
import {actionMenu, splitActions} from './text-actions.mjs';
import {hasEmotionTag} from './emotion-tags.mjs';
import {stripSpeechTags} from './natural-speech.mjs';
import {ReplyStream} from './reply-stream.mjs';
import {markStage} from './turn-clock.mjs';
import {budgetedChat, TokenMeter, templateTokens, describeFit} from './prompt-budget.mjs';
import {MatureGuard, refusalLog} from './mature-guard.mjs';
import {allowanceFor} from './mature-content.mjs';

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
export function mistralRoute({provider, model = () => DEFAULT_MODELS, decisionModel, chat = streamChat, endpoint, gapMs = 1100, onFailure, onSuccess,
  cacheScope = '', now = () => performance.now(), scheduler, priorities = {TEXT: 0, BACKGROUND: 2}, chatDefaults = CLOUD_CHAT_LIMITS} = {}) {
  return {name: 'mistral', provider: 'mistral', chat, endpoint, gapMs, now, blocked: new Map(), nextSlot: 0, scheduler, priorities,
    chatDefaults,
    noteHeaders: scheduler ? headers => { try { scheduler.noteHeaders(headers); } catch { /* spacing is best effort */ } } : undefined,
    models: () => [model()].flat().map(id => ({id})),
    // The models of the companion-action decision (a one-word answer, bridge/text-actions.mjs); without it the reply's models are used.
    decisionModels: decisionModel ? () => [decisionModel()].flat().map(id => ({id})) : undefined,
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

/**
 * The fully local AI: the supervised llama-server (bridge/local-llm-server.mjs), or a server the player runs themselves (an `endpoint` entry of
 * the custom manifest; the supervisor then hands out its address, key and model id instead). No pacing, no key of the player's: the
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
  // parallel: false: the server answers one request at a time (one slot), so an action decision does not overlap the reply; measured
  // 2026-10-13: the overlap gained nothing on Gemma 4 with one slot or two (docs/LOCAL_AI.md, Actions).
  return {name: 'local', provider: 'local', chat, gapMs: 0, blocked: new Map(), nextSlot: 0, parallel: false,
    models: () => [{id: 'local'}],
    async connect(signal, {background = false} = {}) {
      if (background && server.status().state !== 'ready') throw new MistralError('network', 'is not loaded right now', {provider: 'local'});
      const connection = await server.ensure({signal, background});
      // A request in flight keeps the server loaded; releasing it re-arms the idle timer.
      const done = typeof server.begin === 'function' ? server.begin() : null;
      return {apiKey: connection.apiKey, endpoint: connection.endpoint, model: connection.model, requestModel: connection.requestModel, trustedOrigin: connection.trustedOrigin,
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
      // A server the player runs that did not answer (stopped, moved, asleep) is looked at again before the next turn: one short request, no polling.
      else if (failureKind(error) === 'network') { try { server.externalLost?.(); } catch { /* best effort */ } }
      // A refused key on a server whose first look could not tell (KoboldCpp guards only its chat requests): named once in the log.
      else if (failureKind(error) === 'key') { try { server.externalKeyRefused?.(); } catch { /* best effort */ } }
      try { onFailure?.(error); } catch { /* an observer never fails a reply */ }
    },
    prewarm: messages => server.prewarm(messages),
    // The loaded model's name, for the Mature content allowance (bridge/mature-content.mjs); `loadedModel` starts the server if it is not up.
    // Only while a model is up: after an idle stop (or during a reload) the status still names the previous model, and the next start may
    // load another one, so the level would be read for the wrong model; with null `loadedModel` starts the server and names the real one.
    modelName: () => { const status = server.status?.(); return ['stopped', 'failed', 'starting'].includes(status?.state) ? null : status?.model ?? null; },
    loadedModel: async signal => (await server.ensure({signal}))?.model ?? null,
    // What the manifest of a model added by hand says about it ({uncensored, family}); the Mature allowance reads it before the name.
    modelHints: () => server.modelHints ?? null,
    label: 'The local AI'};
}

// ---- Host --------------------------------------------------------------------------------------------------------------------

export class TextProviderHost {
  /**
   * provider    the provider state (bridge/mistral-key.mjs): `route` names the route in use, `active` whether one is
   * routes      {mistral, local}: route objects as above
   * memory      MistralMemory or MemoryStore (bridge/memory-store.mjs; adds retrieval and fact extraction)
   * personas    PersonaBook
   * transformReply   the bridge's cleanReply (Natural speech, Expressive emotions)
   * gate        () => boolean: may background work (summaries, facts) run now? (the bridge: no combat, nothing speaking)
   * resolveProfile   config => profile key, for warm connections that carry no `local` field
   * idleRetryMs   how often a gated background task checks the gate again
   * deliverAction  message => Promise<boolean>: hands a companion action the reply asked for to the game (CompanionActions.deliver);
   *                without it the turn offers no actions (bridge/text-actions.mjs)
   * matureContent  the Mature setting (bridge/mature-content.mjs); the hard-limit guard runs for a turn on the local AI when it is on or when the loaded
   *                model is an uncensored one (the guard follows the model that answers, not only the setting)
   * guardOnly      true for an add-on's host: the guard (input screen, output screen, adults-only and hard-limit lines) but never the crude Mature persona layer
   * spokenLines  (profileKey) => the speaker's own recent lines (an add-on's journal, remarks included): a conversation reply that says one
   *                again is held back from the voice while it matches and is written once more when it is one
   * stripPlayerEcho  true for an add-on's host: a conversation reply that opens by saying V's own line again (or writes V's side of the talk as a
   *                script) loses those words, in the text the voice is given as it streams and in the finished reply (stripPlayerEcho in mistral-prompt.mjs)
   */
  constructor({provider, memory, personas = new PersonaBook(), routes = {}, transformReply = result => result, now = () => performance.now(),
    log = () => {}, limits = LIMITS, gate, resolveProfile, idleRetryMs = 10_000, deliverAction, matureContent = null, matureGuard = new MatureGuard(), guardOnly = false, stripPlayerEcho: echoCut = false, spokenLines = null} = {}) {
    if (!provider) throw Error('Text provider required');
    Object.assign(this, {provider, memory, personas, routes, transformReply, now, log, limits, gate, resolveProfile, idleRetryMs, deliverAction, matureContent, matureGuard, guardOnly, echoCut, spokenLines});
    this.summaries = new Set();
    this.matureLogged = new Set();
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
    const {profileKey, background, extraBody, models, ...rest} = extra;
    const lease = await route.connect(signal, {background});
    try {
      // The models in order of preference. A model the account has no allowance for (limit 0) is skipped for ten minutes.
      const wanted = models?.length ? models : route.models();
      const now = Date.now();
      const usable = wanted.filter(item => !(route.blocked.get(item.id) > now));
      let lastError;
      for (const item of usable.length ? usable : wanted.slice(0, 1)) {
        try {
          // `lease.requestModel`: the model id a server the player runs is asked for (the local route only); `lease.trustedOrigin`: the one origin
          // that server's key may go to (bridge/mistral-client.mjs). Neither exists for the other routes.
          return await route.chat({apiKey: lease.apiKey, model: lease.requestModel ?? item.id, messages, signal, endpoint: lease.endpoint ?? route.endpoint,
            provider: route.provider, ...(lease.trustedOrigin ? {trustedOrigin: lease.trustedOrigin} : {}), maxTokens: item.maxTokens ?? this.limits.maxTokens, temperature: this.limits.temperature,
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

  /** The routes a turn may use, in order: the provider's own, then (the local AI only) Mistral when the player has a Mistral key. */
  #candidates() {
    const first = this.routes[this.provider.route];
    if (!first) throw new MistralError('request', 'has no route for this provider');
    const list = [first];
    // The local AI: Mistral answers a turn it could not when the player has a Mistral key saved.
    if (first.name === 'local' && this.routes.mistral && this.provider.apiKey) list.push(this.routes.mistral);
    return list;
  }

  /**
   * `stream` (optional, bridge/reply-stream.mjs): the voice's view of the reply while it is written. It is fed the text as it
   * arrives, told when the reply is finished (with the text the voice and subtitles end with) or failed, and a first sentence
   * that is safe to speak is handed to the voice before the model is done. Without one the reply is built exactly as before.
   * `confirmed` (optional promise): the reply was started on words that are not final yet (a stable live-words decode, bridge/local-stt-capture.mjs).
   * It is written as usual, but nothing is remembered and no companion action is handed to the game until `confirmed` resolves; when it rejects
   * (the final words differ) the reply ends there with that error and leaves no trace.
   */
  async reply(config, {signal, stream, confirmed} = {}) {
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
    // The companion actions the game offers this turn (a private conversation with a companion; never a reaction line). Which one V asked
    // for is decided by a tiny request of its own that runs while the memory store retrieves (bridge/text-actions.mjs).
    const menu = !reaction && typeof this.deliverAction === 'function' ? actionMenu(config.companionAction) : null;
    const recalled = reaction ? this.memory.recall({...memoryKey, channel: 'private'}) : this.memory.recall(memoryKey);
    // The guard is on (Mature content on, or an uncensored model loaded; the local AI only): it reads V's words before any model is asked (bridge/mature-guard.mjs). A
    // refusal is the character's own short line; nothing is sent to a model and nothing is stored.
    const firstRoute = this.routes[this.provider.route];
    if (!reaction && firstRoute?.name === 'local' && await this.#guardOn(firstRoute, signal)) {
      const verdict = this.matureGuard.screenInput(text, {history: recalled.turns});
      if (verdict.blocked) return this.#refuse(firstRoute, {config, local, feed, started, where: 'input'});
    }
    // Only a line with a word a request could use is sent to the decision (bridge/text-action-words.mjs): ordinary talk pays nothing.
    const maybe = menu?.rows.length ? menu.screen(text, recalled.turns.at(-1)) : [];
    const deciding = maybe.length ? this.#decide(this.routes[this.provider.route], menu, {text, last: recalled.turns.at(-1), signal}) : null;
    // One action it could be: the reply is written at once as if V asked for it, and held back from the voice until the decision agrees
    // (see #replyOn); with several, or on a route that serves one request at a time (`parallel: false`), the reply waits for the decision.
    const guess = maybe.length && this.routes[this.provider.route]?.parallel !== false ? menu.guess(text, maybe) : null;
    // What the memory store remembers that bears on V's words (private and phone talk of a named character; empty otherwise and
    // whenever it cannot answer in a few hundred milliseconds).
    let remembered = [];
    if (!reaction && config.contextParts && typeof this.memory?.retrieve === 'function') {
      try { remembered = await this.memory.retrieve({...memoryKey, query: text, signal}) ?? []; } catch { remembered = []; }
      if (signal?.aborted) throw cancelled();
    }
    const decision = deciding && !guess ? await deciding : null;
    if (signal?.aborted) throw cancelled();
    const chosen = decided => decided && menu.message(decided) ? decided.code : null;
    const actionNotes = menu ? menu.notes(guess ? (guess === 'NONE' ? null : guess) : chosen(decision)) : '';
    const speculation = guess ? {guess, deciding, confirms: decided => (chosen(decided) ?? 'NONE') === guess, notesFor: decided => menu.notes(chosen(decided))} : null;
    markStage('recalled');
    const candidates = this.#candidates();
    for (const [index, route] of candidates.entries()) {
      try {
        const outcome = await this.#replyOn(route, {config, persona, reaction, recalled, remembered, text, signal, memoryKey, profileKey: local.profileKey, feed, actionNotes, speculation});
        if (confirmed) await confirmed;
        const elapsed = Math.round(this.now() - started);
        const {response} = outcome;
        // What was already spoken stands: a finished reply that does not begin with it is cut back to it.
        const reply = feed.reconcile(outcome.reply);
        // The exchange is remembered without tags (what the player read), except a battle / loot line, which is not a talk. A reply the
        // hard-limit guard replaced is not remembered, and neither are the words that led to it.
        if (!reaction && !outcome.guarded) {
          this.memory.record({...memoryKey, v: text, r: stripSpeechTags(reply)});
          this.#summarize(route, local.profileKey);
        }
        markStage('replyReturned');
        if (deciding) { const settled = await deciding, act = settled && menu.message(settled); if (act) this.#act({code: settled.code, message: act}); }
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
        if (confirmed) await confirmed;
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
  /** The hard-limit guard refused a message: the character answers in her own short words, no model is asked, nothing is stored. */
  #refuse(route, {config, local, feed, started, where}) {
    const line = this.matureGuard.refusalLine(local.profileKey);
    this.log(refusalLog(this.matureGuard, where));
    markStage('replyReturned');
    const result = this.transformReply({text: line, sessionID: config.sessionId, transport: route.name,
      timing: {provider: route.name, llmMs: Math.round(this.now() - started), model: 'mature-guard', attempts: 0, guardRefusal: where}});
    feed.finish(result.text, result);
    return result;
  }

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

  /** Hands the action a finished reply asked for to the game. Best effort: the spoken reply never waits for it or fails with it. */
  #act({code, message}) {
    try {
      Promise.resolve(this.deliverAction(message)).then(
        accepted => this.log(`action ${code} ${accepted ? 'handed to the game' : 'was not accepted'}`),
        error => this.log(`action ${code} failed: ${error?.message ?? 'error'}`));
    } catch (error) { this.log(`action ${code} failed: ${error?.message ?? 'error'}`); }
  }

  /**
   * Which of the offered actions V's words plainly ask for: one small request, no persona, a one-word answer. Never throws; a failure,
   * a late answer or an unclear one is "none" (the reply is then written as plain talk with what is not possible said in its notes).
   */
  async #decide(route, menu, {text, last, signal}) {
    if (!route) return null;
    try {
      const response = await this.#request(route, menu.classifier({text, last}), signal,
        {maxTokens: 12, temperature: 0, retries: 0, totalMs: 8000, firstByteMs: 6000, models: route.decisionModels?.()});
      return menu.decide(response.text);
    } catch (error) {
      if (!signal?.aborted) this.log('action decision failed: ' + (failureKind(error) ?? error?.message ?? 'error'));
      return null;
    }
  }

  /**
   * The Mature content level for a turn on `route` ('full' or 'suggestive'), or null: the setting is off, or the route is not one that may
   * have it (only the local AI). The model decides the level (its licence), so it is read from the loaded model; the server is started
   * for it when it is not up yet, as the request would. Nothing is awaited while the setting is off.
   */
  async #matureLevel(route, signal) {
    if (!this.matureContent?.enabled) return null;
    if (route.name !== 'local') { this.#noteMature(`layer NOT applied (provider ${route.name} never gets it)`); return null; }
    let model = route.modelName?.() ?? null;
    if (!model && route.loadedModel) model = await route.loadedModel(signal);
    const level = this.matureContent.forTurn(route.name, model, route.modelHints?.())?.level ?? null;
    if (level) this.#noteMature(`layer applied (level ${level}, model ${model ?? 'unknown'})`);
    return level;
  }

  /**
   * Does the hard-limit guard run for a turn on `route`? Only the local AI can be uncensored, and only a host that has the Mature setting
   * (the main hosts and the add-on hosts) has a guard. It runs when the setting is on, or when the loaded model is an uncensored one even with
   * the setting off. Off with a normal model nothing here is awaited beyond a model-name lookup and the prompt is untouched.
   */
  async #guardOn(route, signal) {
    if (!this.matureContent || route?.name !== 'local') return false;
    if (this.matureContent.enabled) return true;
    let model = route.modelName?.() ?? null;
    if (!model && route.loadedModel) {
      try { model = await route.loadedModel(signal); } catch { return false; }   // the request fails (or falls back) on its own terms
    }
    const uncensored = allowanceFor(model, route.modelHints?.()).uncensored;
    if (uncensored) this.#noteMature(`guard applied (the loaded model is uncensored, setting off, model ${model ?? 'unknown'})`);
    return uncensored;
  }

  /** One log line per distinct fact for the life of this host (the bridge session): the setting is on, so say what the prompt got. Never the words of a turn. */
  #noteMature(fact) {
    if (this.matureLogged.has(fact)) return;
    this.matureLogged.add(fact);
    this.log(`[MatureContent] ${fact}`);
  }

  async #replyOn(route, {config, persona, reaction, recalled, remembered, text, signal, profileKey, feed, actionNotes, speculation}) {
    // The crude persona layer: the Mature setting only, never an add-on's host. The guard alone: also an uncensored model with the setting off, and add-ons.
    const mature = this.matureContent?.enabled && !this.guardOnly ? await this.#matureLevel(route, signal) : null;
    const guard = mature ? true : await this.#guardOn(route, signal);
    // This turn's action notes go last in the prompt, after everything that can be cached.
    let notes = actionNotes;
    const cutEcho = this.echoCut && !reaction;
    // An earlier reply of the speaker that opened with V's words (stored before this was cut) is shown to the model without them: a model copies the pattern of its own history.
    const history = cutEcho ? recalled.turns.map(turn => ({...turn, r: stripPlayerEcho(turn.r, turn.v)})) : recalled.turns;
    const build = nudge => buildMessages({persona, memory: recalled.summary, history,
      context: notes && !config.contextParts ? joinBlocks([config.context, notes]) : config.context,
      contextParts: notes && config.contextParts ? {...config.contextParts, volatile: joinBlocks([config.contextParts.volatile, notes])} : config.contextParts,
      remembered, text: nudge ? text + nudge : text, reaction: reaction && config.reaction?.kind === 'vtalk' ? 'said' : reaction, limits: this.limits,
      ...(mature ? {mature} : guard ? {guard: true} : {})});
    // A speculative request (reply()) assumes V asked for the guessed action. It shows the voice nothing until the decision agrees; if the
    // decision says otherwise it is cancelled and the reply is written again with the right notes.
    const spec = speculation ? {controller: new AbortController(), open: false, latest: '', missed: false, over: false} : null;
    speculation?.deciding.then(decided => {
      if (spec.over) return;
      if (speculation.confirms(decided)) { spec.open = true; try { feed.update(spec.latest); } catch { /* the voice's view never breaks the reply */ } }
      else { spec.missed = true; notes = speculation.notesFor(decided); spec.controller.abort(); }
    });
    // An action code ("[DRIVE]") is never part of the reply: the voice, the subtitles and the memory see the text without it.
    // An add-on speaker never says V's words: a reply that starts with V's line (or V's label) is held back from the voice until it moves on.
    // An add-on speaker's own recent lines (its remarks as well as its replies, which the conversation memory does not hold): a reply that
    // says one again is held back from the voice while it still matches, and is written once more if it turns out to be one.
    let recentSpoken = [];
    if (!reaction && this.spokenLines) { try { recentSpoken = this.spokenLines(profileKey) ?? []; } catch { recentSpoken = []; } }
    const visible = soFar => {
      const shown = splitActions(soFar, {streaming: true}).text;
      if (!cutEcho) return shown;
      const own = stripPlayerEcho(speakerTurn(shown, persona.name, {streaming: true}), text, {streaming: true});
      return recentSpoken.length && startsLikeLine(own, recentSpoken) ? '' : own;
    };
    // A remark with a word limit (reaction.maxWords, an add-on's) also stops the stream at that limit plus a little, is asked for few
    // tokens, and is cut at its last sentence end. Ordinary replies and battle barks carry no such limit and are unchanged.
    const wordLimit = reaction && Number.isInteger(config.reaction?.maxWords) && config.reaction.maxWords > 0 ? config.reaction.maxWords : 0;
    const shouldStop = soFar => {
      const clean = cleanReply(visible(soFar), {name: persona.name, isTag});
      return capPoint(clean, this.limits) >= 0 || (wordLimit > 0 && overWords(clean, wordLimit));
    };
    const run = async nudge => {
      const messages = build(nudge);
      markStage('promptBuilt');
      const sent = spec && !spec.over ? (signal ? AbortSignal.any([signal, spec.controller.signal]) : spec.controller.signal) : signal;
      const response = await this.#request(route, messages, sent, {shouldStop, profileKey, ...(wordLimit ? {maxTokens: remarkTokens(wordLimit)} : {}), onDelta: (_piece, soFar) => {
        const shown = visible(soFar);
        if (spec && !spec.over) { spec.latest = shown; if (!spec.open) return; }
        try { feed.update(shown); } catch { /* the voice's view of the reply never breaks the reply */ }
      }});
      if (spec && !spec.over) { await speculation.deciding; if (spec.missed) throw new MistralError('request', 'the action decision changed the notes'); }
      markStage('fullText');
      const {text: spoken} = splitActions(response.text);
      let cleaned = cleanReply(spoken, {name: persona.name, isTag});
      if (cutEcho) cleaned = stripPlayerEcho(cleaned, text);
      if (response.finishReason === 'length') cleaned = trimUnfinished(cleaned);
      let reply = capReply(cleaned, this.limits);
      if (wordLimit) reply = capWords(reply, wordLimit);
      // Mature content only: a reply that puts a minor and romance or sex together (or has the character claim to be under 18) is dropped for
      // the character's own refusal; the turn is logged (never the words) and neither the reply nor V's words are remembered. A first
      // sentence the voice already started stands (it was screened before it was spoken), and the refusal follows it.
      if (guard) {
        const verdict = this.matureGuard.screenReply(reply, {history: recalled.turns});
        if (verdict.hit) {
          this.log(refusalLog(this.matureGuard, 'output'));
          const line = this.matureGuard.refusalLine(profileKey);
          return {response, reply: feed.committed ? `${feed.head} ${line}` : line, guarded: true};
        }
      }
      if (!reply.trim()) throw new MistralError('empty', 'answered with no text', {provider: route.provider});
      return {response, reply};
    };
    // The lines this character must not say again: its profile's example lines and its own earlier replies (not for a battle or loot bark).
    const said = reaction ? [] : [...persona.samples, ...recalled.turns.map(turn => turn.r), ...recentSpoken];
    // V trying to make the character say it is an AI or a script: the reply must not take those words up, even to deny them.
    const provoked = !reaction && provokesAiTalk(text);
    const refuseHead = said.length || provoked ? head => repeatsLine(head, said) || (provoked && takesUpAiTalk(head)) : null;
    // With the guard on, a first sentence that flags is never committed to the voice either.
    if (feed && typeof feed === 'object') feed.reject = guard ? head => (refuseHead ? refuseHead(head) : false) || this.matureGuard.flagsReply(head, {history: recalled.turns}) : refuseHead;
    let outcome;
    try { outcome = await run(''); } catch (error) {
      if (!spec?.missed || signal?.aborted) throw error;
      spec.over = true;
      outcome = await run('');
    }
    // A reply the guard replaced is final: no second attempt, no checks (the refusal is the character's own line).
    if (outcome.guarded) { route.success(); return outcome; }
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
      // With Mature content on, the layer is part of the head, so the warmed prefix is the one the first reply will use.
      const mature = this.guardOnly ? null : await this.#matureLevel(route);
      const guard = mature ? true : await this.#guardOn(route);
      await route.prewarm([{role: 'system', content: systemHead({persona, limits: this.limits, ...(mature ? {mature} : guard ? {guard: true} : {})})}, {role: 'user', content: '.'}]);
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
 * `prewarmVoice` (default true; a boolean or a function asked at each warm-up): a warm-up also opens the host's local voice renderer (the phone host has none to open; with voice playback Off the bridge says no).
 * `speech` is an optional hook for local speech recognition (bridge/local-stt.mjs): {available(): boolean, voiceChannel({reply})}.
 */
export function attachTextProvider(host, {provider, mistral, speech, prewarmVoice = true, warmCloud} = {}) {
  const textHost = mistral;
  const original = {reply: host.reply, prepare: host.prepare, warm: host.warm, readiness: host.readiness, lateEmotion: host.lateEmotion,
    refreshIdle: host.refreshIdle, voiceChannel: host.voiceChannel};
  const withoutLocal = config => {
    if (!config || !('local' in config || 'contextParts' in config)) return config;
    const {local: _local, contextParts: _parts, ...rest} = config;
    return rest;
  };
  const label = () => ({mistral: 'Mistral', local: 'the local AI'})[provider.route] ?? 'Mistral';
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
    // A cloud route's connection is kept open for 60 s after its last use: opening the composer renews it (an unauthenticated request).
    else if (warmCloud && provider.route === 'mistral') void warmCloud({provider: provider.route});
    // The local voice's browser and renderer page open now, while V types or looks, not in front of the first reply.
    if (typeof prewarmVoice === 'function' ? prewarmVoice() : prewarmVoice) void this.prewarmLocal?.();
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
    // A reply may start on a stable live-words decode before the final decode is back (bridge/local-stt-capture.mjs, `confirmed`): Mistral only
    // (a cancelled request costs a little quota there; the local AI shares the game's GPU and a cancelled request there is not free).
    if (speech?.available?.() && typeof speech.voiceChannel === 'function') return speech.voiceChannel({reply: (config, options) => textHost.reply(config, options),
      speculate: () => provider.route === 'mistral' && process.env.CYBERPUNK_CONVAI_STT_SPECULATE !== '0'});
    const refuse = () => Promise.reject(Error(`Voice needs Convai for now: speech recognition is not available with ${label()} [mistral:voice]`));
    return {beginVoice: refuse, finishVoice: refuse, heard: async () => '', close: async () => {}};
  };
  return host;
}
