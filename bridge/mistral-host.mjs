// The Mistral text route (docs/MISTRAL.md). `MistralHost.reply(config)` takes the same configuration the bridge hands the
// Convai realtime host for a turn and returns the same kind of result ({text, sessionID, timing, ...}, cleaned by the same
// transformReply), so subtitles, Phone Chat, the local voices, the face, the emotion selector and group rounds see no difference.
// `attachMistral(host, ...)` makes a RealtimeHost use this route for text turns while the provider is Mistral; everything
// else about the host (the browser audio page, local PCM playback) is untouched.
import {streamChat, MistralError, DEFAULT_MODELS, failureKind} from './mistral-client.mjs';
import {PersonaBook, buildMessages, cleanReply, capPoint, capReply, breaksCharacter, leaksReasoning, looksCut, trimUnfinished, summaryMessages, LIMITS} from './mistral-prompt.mjs';
import {hasEmotionTag} from './emotion-tags.mjs';
import {stripSpeechTags} from './natural-speech.mjs';

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

export class MistralHost {
  /**
   * provider    MistralProvider (the key and the provider state)
   * memory      MistralMemory
   * personas    PersonaBook
   * model       () => model id
   * transformReply   the bridge's cleanReply (Natural speech, Expressive emotions)
   * chat        the request function (streamChat; replaced in tests)
   */
  constructor({provider, memory, personas = new PersonaBook(), model = () => DEFAULT_MODELS, transformReply = result => result,
    chat = streamChat, now = () => performance.now(), log = () => {}, limits = LIMITS, endpoint, onFailure, onSuccess, gapMs = 1100} = {}) {
    if (!provider) throw Error('Mistral provider required');
    Object.assign(this, {provider, memory, personas, model, transformReply, chat, now, log, limits, endpoint, onFailure, onSuccess, gapMs});
    this.nextSlot = 0;
    this.blocked = new Map();
    this.summaries = new Set();
  }

  // The free plan allows about one request a second. Every request takes the next free start slot, so two requests (a reply and
  // the summary of older talk, or two companions in a group round) never start closer together than `gapMs`.
  async #slot(signal) {
    const now = this.now();
    const start = Math.max(now, this.nextSlot);
    this.nextSlot = start + this.gapMs;
    if (start > now) await pause(start - now, signal);
  }

  async #request(messages, signal, extra = {}) {
    await this.#slot(signal);
    // The models in order of preference. A model the account has no allowance for (limit 0) is skipped for ten minutes.
    const wanted = [this.model()].flat();
    const now = Date.now();
    const usable = wanted.filter(id => !(this.blocked.get(id) > now));
    let lastError;
    for (const model of usable.length ? usable : wanted.slice(0, 1)) {
      try {
        return await this.chat({apiKey: this.provider.apiKey, model, messages, signal, endpoint: this.endpoint,
          maxTokens: this.limits.maxTokens, temperature: this.limits.temperature, ...extra});
      } catch (error) {
        if (!(error instanceof MistralError) || !error.zeroQuota) throw error;
        this.blocked.set(model, now + 10 * 60_000);
        this.log(`no allowance for ${model}; trying the next model`);
        lastError = error;
      }
    }
    throw lastError;
  }

  async reply(config, {signal} = {}) {
    if (signal?.aborted) throw cancelled();
    const local = config?.local;
    if (!local || typeof local.profileKey !== 'string') throw new MistralError('request', 'turn has no character');
    const text = typeof config.text === 'string' ? config.text : '';
    if (!text.trim()) throw new MistralError('request', 'turn has no message');
    const started = this.now();
    const persona = this.personas.persona(local.profileKey, local.name);
    const reaction = !!config.reaction;
    const memoryKey = {profileKey: local.profileKey, channel: local.channel, ambientKey: local.ambientKey};
    const recalled = reaction ? this.memory.recall({...memoryKey, channel: 'private'}) : this.memory.recall(memoryKey);
    const build = nudge => buildMessages({persona, memory: recalled.summary, history: recalled.turns, context: config.context,
      text: nudge ? text + IN_CHARACTER_NUDGE : text, reaction, limits: this.limits});
    const shouldStop = soFar => capPoint(cleanReply(soFar, {name: persona.name, isTag}), this.limits) >= 0;
    const run = async nudge => {
      const response = await this.#request(build(nudge), signal, {shouldStop});
      let cleaned = cleanReply(response.text, {name: persona.name, isTag});
      if (response.finishReason === 'length') cleaned = trimUnfinished(cleaned);
      const reply = capReply(cleaned, this.limits);
      if (!reply.trim()) throw new MistralError('empty', 'answered with no text');
      return {response, reply};
    };
    let outcome;
    try {
      outcome = await run(false);
      // A reply that steps out of character, or is a model's reasoning, gets one more try. The second answer is used unless it
      // is reasoning again, which is never spoken (it counts as an empty answer).
      if ((breaksCharacter(outcome.reply) || leaksReasoning(outcome.reply) || looksCut(outcome.reply)) && !signal?.aborted) {
        this.log('reply broke character; asking once more');
        try { outcome = await run(true); } catch (error) { if (signal?.aborted) throw error; /* keep the first */ }
      }
      if (leaksReasoning(outcome.reply) || looksCut(outcome.reply) && outcome.reply.split(/\s+/).length < 4) throw new MistralError('empty', 'answered with its reasoning or a cut-off line');
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' && !(error instanceof MistralError)) throw error;
      this.#failed(error);
      throw error;
    }
    this.provider.noteSuccess();
    try { this.onSuccess?.(); } catch { /* an observer never fails a reply */ }
    const {response, reply} = outcome;
    // The exchange is remembered without tags (what the player read), except a battle / loot line, which is not a talk.
    if (!reaction) {
      this.memory.record({...memoryKey, v: text, r: stripSpeechTags(reply)});
      this.#summarize(local.profileKey);
    }
    const elapsed = Math.round(this.now() - started);
    return this.transformReply({text: reply, sessionID: config.sessionId, transport: 'mistral',
      timing: {provider: 'mistral', llmMs: elapsed, model: response.model ?? [this.model()].flat()[0], attempts: response.attempts}});
  }

  #failed(error) {
    const kind = failureKind(error);
    this.provider.noteLimit(kind === 'limit' ? 'rate' : kind === 'key' ? 'invalid' : kind === 'model' ? 'model' : null);
    try { this.onFailure?.(error); } catch { /* an observer never fails a reply */ }
  }

  // Folds older exchanges into the character's summary, one request per `batch` exchanges, never while one is running for the
  // character and not at all while the key is known to be out of requests or refused. Fire and forget: the reply is already on its way.
  #summarize(profileKey) {
    const limit = this.provider.limit;
    if (limit && limit.kind === 'invalid') return;
    if (this.summaries.has(profileKey)) return;
    const batch = this.memory.pendingSummary(profileKey);
    if (!batch) return;
    this.summaries.add(profileKey);
    this.memory.beginSummary(profileKey);
    const name = this.personas.persona(profileKey).name;
    void (async () => {
      try {
        // Queued behind the reply that triggered it: never within one slot of a chat request.
        await pause(this.gapMs);
        const response = await this.#request(summaryMessages({name, summary: batch.summary, turns: batch.turns}), undefined,
          {maxTokens: 260, temperature: 0.3, retries: 1, totalMs: 40000});
        const text = cleanReply(response.text, {name, isTag});
        if (!this.memory.applySummary(profileKey, text, batch)) this.memory.failSummary(profileKey);
      } catch (error) {
        this.memory.failSummary(profileKey);
        this.log('summary failed: ' + (failureKind(error) ?? 'error'));
      } finally { this.summaries.delete(profileKey); }
    })();
  }

  /** What Forget does to this provider's memory. */
  forget(scope) { return this.memory.forget(scope); }
}

/**
 * Makes `host` (a RealtimeHost) answer text turns through `mistral` while `provider.active` is true. Only the text path is
 * replaced: the host's browser page, local PCM playback and Convai connections stay as they are and are used again the moment
 * the provider is Convai. While Mistral is active:
 *   reply     the Mistral route (the `local` field the bridge adds to a turn's configuration names the character)
 *   prepare   refused (a speculative turn has no meaning here)
 *   warm      succeeds at once and opens no connection (an invitation is ready without one)
 *   readiness reports a ready connection
 *   voiceChannel  a channel that refuses with a message the voice key turns into a notice (until local speech recognition exists)
 * `speech` is an optional hook for local speech recognition (bridge/local-stt.mjs): {available(): boolean, voiceChannel({reply})}.
 */
export function attachMistral(host, {provider, mistral, speech} = {}) {
  const original = {reply: host.reply, prepare: host.prepare, warm: host.warm, readiness: host.readiness, lateEmotion: host.lateEmotion,
    refreshIdle: host.refreshIdle, voiceChannel: host.voiceChannel};
  const withoutLocal = config => { if (!config || !('local' in config)) return config; const {local: _local, ...rest} = config; return rest; };
  host.reply = function reply(config, options) {
    return provider.active ? mistral.reply(config, options) : original.reply.call(this, withoutLocal(config), options);
  };
  host.prepare = function prepare(config, options) {
    if (provider.active) return Promise.reject(Error('A speculative turn is not available with Mistral'));
    return original.prepare.call(this, withoutLocal(config), options);
  };
  host.warm = function warm(config, options) {
    return provider.active ? Promise.resolve({connectionMs: 0, provider: 'mistral'}) : original.warm.call(this, withoutLocal(config), options);
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
    // through the Mistral route; until it exists the voice key says voice needs Convai.
    if (speech?.available?.() && typeof speech.voiceChannel === 'function') return speech.voiceChannel({reply: (config, options) => mistral.reply(config, options)});
    const refuse = () => Promise.reject(Error('Voice needs Convai for now: speech recognition is not available with Mistral [mistral:voice]'));
    return {beginVoice: refuse, finishVoice: refuse, heard: async () => '', close: async () => {}};
  };
  return host;
}
