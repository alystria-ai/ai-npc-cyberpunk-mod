// A cloud provider that refuses a prompt as too long and says how long it may be (docs/ERROR_REPORTS.md, 27 Oct 2026: a Groq free plan took 8,000 tokens a minute and the
// mod's prompt was 8,626): the limit is read from the refusal, the prompt is cut to it once, the request is sent again once, and the limit is remembered for the provider and
// model so every later prompt is built to fit from the start.
//
// The refusals understood (bridge/mistral-client.mjs contextRefusal puts them in `error.overflow`): Groq / OpenAI style "Request too large ... Limit 8000, Requested 8626",
// OpenAI and OpenRouter "maximum context length is N tokens", llama.cpp "exceeds the available context size", Mistral "too large for model with N maximum context length",
// and "prompt is too long: N tokens > M maximum".
//
// The cutting is the fit the Local AI already uses (bridge/prompt-budget.mjs fitMessages): the lowest-priority knowledge first, then the retrieved memories, then the older
// exchanges and the older-talk summary, and last the world facts and the last exchanges. Never the character's persona and output rules, the player's world rules, the "right now"
// block, this turn's fresh facts or the player's words; a prompt that cannot fit without them fails with its plain "does not fit" error.
//
// Cost: nothing on a normal turn. With no limit known the request goes out exactly as before (one await of a function that returns null); with one known, the prompt is measured
// by character count (microseconds) and cut only when it is over. The one extra request is made only after a refusal.
import {PROMPT_SOURCE} from './mistral-prompt.mjs';
import {TokenMeter, budgetedChat, seedRatio} from './prompt-budget.mjs';
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

/** The smallest limit worth learning: a persona alone is longer than this, so a refusal naming less is not something a cut can answer. */
export const MIN_LEARNED_LIMIT = 1500;
/** A learned limit is kept this long on disk: a plan that was upgraded since is asked again. */
export const LIMIT_TTL_MS = 3 * 24 * 3600_000;

/**
 * The limits learned from refusals, per provider, address and model (never a key): in memory for the session and, with a file, on disk (a small JSON in the state folder) so the
 * next session starts from them. Reads once at start; a write is a small file replaced after a refusal.
 */
export class LearnedLimits {
  #rows = new Map();
  constructor({file, now = Date.now, ttlMs = LIMIT_TTL_MS, readText = path => readFileSync(path, 'utf8'), writeText = (path, text) => { mkdirSync(dirname(path), {recursive: true}); const temporary = `${path}.${process.pid}.tmp`; writeFileSync(temporary, text); renameSync(temporary, path); }} = {}) {
    Object.assign(this, {file, now, ttlMs, writeText});
    if (!file) return;
    try {
      const value = JSON.parse(readText(file).replace(/^﻿/, ''));
      for (const [key, row] of Object.entries(value?.version === 1 && value.limits && typeof value.limits === 'object' ? value.limits : {})) {
        if (typeof key === 'string' && key.length <= 300 && Number.isFinite(row?.limit) && row.limit >= MIN_LEARNED_LIMIT && Number.isFinite(row?.at) && now() - row.at < ttlMs) this.#rows.set(key, {limit: Math.floor(row.limit), at: row.at});
      }
    } catch { /* no file, or one that cannot be read: nothing is known yet */ }
  }
  /** The learned limit (tokens), or undefined. */
  get(key) {
    const row = this.#rows.get(key);
    return row && this.now() - row.at < this.ttlMs ? row.limit : undefined;
  }
  /** Remembers the limit; the file (if any) is rewritten. Never throws. */
  learn(key, limit) {
    if (typeof key !== 'string' || !(limit >= MIN_LEARNED_LIMIT)) return;
    this.#rows.set(key, {limit: Math.floor(limit), at: this.now()});
    if (!this.file) return;
    try {
      this.writeText(this.file, JSON.stringify({version: 1, limits: Object.fromEntries([...this.#rows].filter(([, row]) => this.now() - row.at < this.ttlMs))}));
    } catch { /* the limit stays known for this session */ }
  }
  get size() { return this.#rows.size; }
}

const keyOf = options => `${options?.provider ?? 'custom'}|${options?.trustedOrigin ?? ''}|${options?.model ?? ''}`;

/** "history:3,memory:1": what was cut, by step name and how often. */
export function trimmedText(list) {
  if (!Array.isArray(list) || !list.length) return 'none';
  const counts = new Map();
  for (const name of list) { const step = String(name).split(':')[0]; counts.set(step, (counts.get(step) ?? 0) + 1); }
  return [...counts].map(([step, count]) => `${step}:${count}`).join(',');
}

/** The one log line of a learned refusal. `provider` and `model` are the request's own, no key or address. */
export function promptFitLine(options, {limit, sent, trimmed, retried}) {
  const word = value => String(value ?? '?').replace(/[^A-Za-z0-9._:/-]/g, '').slice(0, 80) || '?';
  return `[PromptFit] provider=${word(options?.provider ?? 'custom')} model=${word(options?.model)} limit=${limit} sent=${Number.isFinite(sent) ? Math.round(sent) : '?'} trimmed=${trimmedText(trimmed)} retried=${retried}`;
}

/**
 * `chat` that learns a provider's limit from a size refusal. `limits`: a LearnedLimits. `log(line)`: the [PromptFit] line (the caller writes it). Only a request built by
 * `buildMessages` (it carries its arguments, PROMPT_SOURCE) can be cut; summaries and the like pass through and fail as they did. At most one extra request per call.
 */
export function learnedLimitChat(chat, {limits = new LearnedLimits(), log = () => {}, meters = new Map()} = {}) {
  let lastFit = null;
  const meterFor = (key, model) => { if (!meters.has(key)) meters.set(key, new TokenMeter({charsPerToken: seedRatio(model)})); return meters.get(key); };
  const say = (options, info) => { try { log(promptFitLine(options, info)); } catch { /* a log line never fails a request */ } };
  const fitted = budgetedChat(chat, {
    // Unknown limit: null, the request is sent as it is. Known: the prompt is fitted to it, with the reply's room (the provider counts it in the limit).
    budget: async options => {
      const key = keyOf(options), limit = limits.get(key);
      return limit ? {contextTokens: limit, ...(Number.isFinite(options?.maxTokens) ? {reserveTokens: options.maxTokens} : {}), meter: meterFor(key, options?.model), learnable: true} : null;
    },
    learn: (tokens, options) => limits.learn(keyOf(options), tokens),
    onFit: fit => { lastFit = fit; },
    // The refusal of a prompt that was already being fitted (the limit had been learned and the provider took it lower): budgetedChat cut and retried by itself.
    onLearned: (info, options) => say(options, info),
  });
  return async function learnedChat(options) {
    const key = keyOf(options), known = limits.get(key) !== undefined;
    try { return await fitted(options); } catch (error) {
      const refused = error?.overflow;
      if (known || !refused || !(refused.contextTokens >= MIN_LEARNED_LIMIT) || options?.signal?.aborted || !options?.messages?.[PROMPT_SOURCE]) throw error;
      limits.learn(key, refused.contextTokens);
      // The provider's count of the refused prompt teaches the characters-per-token ratio (the count includes the reply's room when the words say "requested").
      const room = /request too large|you requested|requested about/i.test(String(error.message ?? '')) && Number.isFinite(options?.maxTokens) ? options.maxTokens : 0;
      if (refused.promptTokens > 0) { try { meterFor(key, options?.model).observe(options.messages, Math.max(0, refused.promptTokens - room), {gap: false}); } catch { /* a ratio is best effort */ } }
      lastFit = null;
      try {
        const result = await fitted({...options, singleFit: true});
        say(options, {limit: refused.contextTokens, sent: lastFit?.tokens ?? Number(result?.usage?.prompt_tokens), trimmed: lastFit?.trimmed ?? [], retried: 'ok'});
        return result;
      } catch (second) {
        if (!options?.signal?.aborted) say(options, {limit: refused.contextTokens, sent: lastFit?.tokens, trimmed: lastFit?.trimmed ?? [], retried: 'failed'});
        throw second;
      }
    }
  };
}
