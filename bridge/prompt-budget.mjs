// Fits the prompt of a text provider into a token budget (docs/LOCAL_AI.md, "Context budget").
//
// The prompt builder (bridge/mistral-prompt.mjs) bounds each part in characters, and the sum of those bounds is far larger than a
// small server's context: Judy's persona and the output rules alone are about 19,000 characters (4,500 tokens), and a turn with the
// whole world block, eight exchanges of history and the volatile notes reaches 9,000 tokens and more. A llama-server started with
// -c 8192 refuses such a request ("exceeds the available context size", 2026-10-12 live record). `fitMessages` builds the prompt,
// measures it and, while it is over the budget, removes content in a fixed order of priority (the same order every turn, so the stable
// early part of the prompt stays identical from turn to turn and the server's prefix cache keeps working):
//
//   1. the lowest-priority knowledge, each block halved once and then dropped: the list of available jobs, the older journal, shared
//      recent events, what V wears
//   2. the memories the memory store retrieved for this turn (one at a time)
//   3. older exchanges of the conversation (the last two stay), then the older-talk summary (halved once, then dropped), then the
//      tracked-quest block (halved, then dropped)
//   4. the world facts (halved once), this turn's volatile notes (capped), the last exchanges, the world block as a whole (capped), the
//      persona's example lines
//
// It never touches the persona (who the character is, how it talks), the output rules, the format notes, the "right now" block or the
// player's words. If those alone do not fit, `fits` is false and the caller falls back to another route.
//
// Measuring: a character estimate with a ratio learned from the server's own prompt token counts (`TokenMeter`), and, when the
// estimate comes near the limit, the server's tokenizer (`budget.count`, one request of tens of milliseconds, only then). A turn
// that is far below the limit costs a few microseconds and no request.
import {buildMessages as defaultBuild, capContext, joinBlocks, PROMPT_SOURCE} from './mistral-prompt.mjs';
import {MistralError} from './mistral-client.mjs';

export const BUDGET = Object.freeze({
  charsPerToken: 3.6,    // before anything is learned; this prompt measures about 4.2 on Gemma 4 and on Qwen3.5
  minCharsPerToken: 2.4,
  maxCharsPerToken: 4.6,
  messageTokens: 6,      // chat-template tokens around each message (measured 4.4 on both models)
  baseTokens: 12,        // ... and the generation prompt
  reserveTokens: 320,    // room for the reply: 700 characters is about 175 tokens, plus tags and an action code
  marginRatio: 0.015,    // of the context, for an estimate that is a little low
  minMargin: 48,
  verifyFrom: 0.8,       // ask the server's tokenizer once the estimate passes this share of the limit
  verifyBand: 0.9,       // ... and again for a trimmed prompt that lands above this share of it
  maxCounts: 4,          // tokenizer requests in one fit
  keepExchanges: 2,      // older exchanges are dropped down to this many before anything else of the conversation is cut
});

// Text in scripts that spend about a token a character (Chinese, Japanese, Korean) or two characters a token (Cyrillic, Greek,
// Arabic, ...) is counted separately: the ratio learned from English prose does not apply to it.
const WIDE = /[ᄀ-ᇿ⺀-鿿가-퟿豈-﫿＀-￯\u{20000}-\u{2fa1f}]/gu;
const OTHER = /[^\u0000-ɏ -⁯₠-⃏←-⇿]/gu;

/** The tokens a text costs: `charsPerToken` for ordinary characters, a token each for wide scripts, half a token each for the rest. */
export function textTokens(text, charsPerToken = BUDGET.charsPerToken) {
  const value = String(text ?? '');
  if (!value) return 0;
  // Pure ASCII and Latin text (almost every prompt) skips the two scans.
  let plain = true;
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) > 0x24f) { plain = false; break; }
  if (plain) return value.length / charsPerToken;
  const wide = (value.match(WIDE) ?? []).length;
  const other = (value.match(OTHER) ?? []).length - wide;
  return (value.length - wide - Math.max(0, other)) / charsPerToken + wide * 1.05 + Math.max(0, other) * 0.55;
}

export const promptChars = messages => messages.reduce((sum, message) => sum + String(message?.content ?? '').length, 0);

/** The template overhead the server adds around `count` messages. */
export const templateTokens = count => BUDGET.baseTokens + count * BUDGET.messageTokens;

/** The estimated tokens of a request's messages. */
export function estimateTokens(messages, charsPerToken = BUDGET.charsPerToken) {
  let sum = 0;
  for (const message of messages) sum += textTokens(message?.content, charsPerToken);
  return Math.ceil(sum) + templateTokens(messages.length);
}

/**
 * The characters-per-token ratio of one model, learned from the prompt token counts its server reports. The lowest recent ratio is
 * used (the most tokens for the characters seen), a little lower still: an estimate that is too high only trims early, one that is
 * too low costs a refused request.
 */
export class TokenMeter {
  #ratios = [];
  constructor({charsPerToken = BUDGET.charsPerToken, keep = 6} = {}) { this.fallback = charsPerToken; this.keep = keep; }
  get charsPerToken() {
    if (!this.#ratios.length) return this.fallback;
    const lowest = Math.min(...this.#ratios) * 0.97;
    return Math.min(BUDGET.maxCharsPerToken, Math.max(BUDGET.minCharsPerToken, lowest));
  }
  get samples() { return this.#ratios.length; }
  /** `promptTokens` is the server's count for `messages` (usage.prompt_tokens, or n_prompt_tokens of a refusal). */
  observe(messages, promptTokens) {
    const tokens = Number(promptTokens) - templateTokens(messages.length);
    if (!Number.isFinite(tokens) || tokens < 200) return false;   // a tiny prompt says nothing about the ratio
    let chars = 0, foreign = 0;
    for (const message of messages) {
      const text = String(message?.content ?? '');
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code > 0x24f && !(code >= 0x2000 && code <= 0x206f)) foreign++;   // letters of another script; curly quotes and dashes are English
      }
      chars += text.length;
    }
    if (foreign > chars * 0.01) return false;                                // English prose only
    this.#ratios.push(chars / tokens);
    if (this.#ratios.length > this.keep) this.#ratios.shift();
    return true;
  }
  reset() { this.#ratios = []; }
}

// ---- Trimming ------------------------------------------------------------------------------------------------------------

// The world blocks that may be cut, from the first to go to the last; a block is first halved, then dropped.
export const WORLD_TRIM_ORDER = Object.freeze(['jobs', 'history', 'recency', 'gear']);

// Keeps the leading lines of a text up to about half of it (a block lists its items in order of relevance); null when there is
// nothing worth halving.
function halve(text) {
  const value = String(text ?? '');
  const lines = value.split('\n');
  if (lines.length < 3 || value.length < 400) return null;
  const target = Math.ceil(value.length / 2);
  let kept = 0, used = 0;
  while (kept < lines.length - 1 && used < target) used += lines[kept++].length + 1;
  const cut = lines.slice(0, Math.max(1, kept)).join('\n').trimEnd();
  return cut.length < value.length ? cut : null;
}

const withParts = (args, parts) => ({...args, contextParts: {...args.contextParts, ...parts}});

function worldBlocks(args) { return Array.isArray(args.contextParts?.worldBlocks) ? args.contextParts.worldBlocks : null; }

// A block is halved once (a second halving would move the early part of the prompt on every turn) and then dropped.
function changeBlock(args, key, how) {
  const blocks = worldBlocks(args);
  const index = blocks ? blocks.findIndex(block => block?.key === key && String(block.text ?? '').trim()) : -1;
  if (index < 0 || (how === 'half' && blocks[index].halved)) return null;
  const text = how === 'half' ? halve(blocks[index].text) : '';
  if (text === null || text === blocks[index].text) return null;
  const next = blocks.map((block, at) => at === index ? {...block, text, halved: true} : block);
  return withParts(args, {worldBlocks: next, world: joinBlocks(next.map(block => block?.text))});
}

const blockStep = (key, how) => ({name: `${key}:${how}`, apply: args => changeBlock(args, key, how)});

const clipHalf = text => { const value = String(text ?? ''); return value.length < 300 ? null : value.slice(0, Math.ceil(value.length / 2)).replace(/\s+\S*$/, '').trimEnd() + '…'; };

// The ordered steps. Each returns the next arguments for `buildMessages`, or null when it has nothing left to remove.
function planFor() {
  const steps = [];
  let summaryClipped = false;
  for (const key of WORLD_TRIM_ORDER) steps.push(blockStep(key, 'half'), blockStep(key, 'drop'));
  steps.push(
    {name: 'remembered', apply: args => args.remembered?.length ? {...args, remembered: args.remembered.slice(0, -1)} : null},
    {name: 'older-exchanges', apply: args => args.history?.length > BUDGET.keepExchanges ? {...args, history: args.history.slice(1)} : null},
    {name: 'summary:half', apply: args => {
      const text = summaryClipped ? null : clipHalf(args.memory);
      if (text === null) return null;
      summaryClipped = true;
      return {...args, memory: text};
    }},
    {name: 'summary:drop', apply: args => args.memory ? {...args, memory: ''} : null},
    blockStep('journal', 'half'), blockStep('journal', 'drop'),
    blockStep('knowledge', 'half'),
    {name: 'notes', apply: args => {
      const volatile = String(args.contextParts?.volatile ?? '');
      return volatile.length > 2400 ? withParts(args, {volatile: capContext(volatile, 2400)}) : null;
    }},
    {name: 'exchanges', apply: args => args.history?.length ? {...args, history: args.history.slice(1)} : null},
    {name: 'world:cap', apply: args => {
      const world = String(args.contextParts?.world ?? '');
      const limit = world.length > 6000 ? 6000 : world.length > 3000 ? 3000 : 0;
      return limit ? withParts(args, {world: capContext(world, limit), worldBlocks: undefined}) : null;
    }},
    {name: 'samples', apply: args => args.persona?.samples?.length ? {...args, persona: {...args.persona, samples: []}} : null},
    // The older layout (no `contextParts`: the whole live context is one string in the last message).
    {name: 'context:cap', apply: args => {
      if (args.contextParts) return null;
      const length = String(args.context ?? '').length;
      const limit = length > 6000 ? 6000 : length > 3000 ? 3000 : 0;
      return limit ? {...args, context: capContext(args.context, limit)} : null;
    }});
  return steps;
}

/**
 * The messages of a request, cut to fit.
 *   args     what `buildMessages` takes (persona, memory, history, context, contextParts, remembered, text, reaction, limits);
 *            `contextParts.worldBlocks` ([{key, text}], in the order they are joined into `contextParts.world`) lets the world
 *            block be trimmed block by block
 *   budget   {contextTokens, reserveTokens?, meter?, count?}: the server's context, the room kept for the reply, a TokenMeter, and
 *            `count(messages)` -> Promise<tokens | null> from the server's tokenizer (optional)
 * Returns {messages, tokens, limit, fits, trimmed: [step names], counts, exact}.
 */
export async function fitMessages({args, build = defaultBuild, budget}) {
  const context = Number(budget?.contextTokens);
  let state = args;
  let messages = build(state);
  if (!(context > 0)) return {messages, tokens: estimateTokens(messages), limit: Infinity, fits: true, trimmed: [], counts: 0, exact: false};
  const reserve = budget.reserveTokens ?? BUDGET.reserveTokens;
  const limit = Math.floor(context - reserve - Math.max(BUDGET.minMargin, context * BUDGET.marginRatio));
  const perToken = () => budget.meter?.charsPerToken ?? BUDGET.charsPerToken;
  const estimate = list => estimateTokens(list, perToken());
  let counts = 0, scale = 1, exact = false;
  // The server's own count of `list`, which also corrects the estimate for the rest of this fit.
  const verify = async list => {
    if (typeof budget.count !== 'function' || counts >= BUDGET.maxCounts) return null;
    counts++;
    let value = null;
    try { value = await budget.count(list); } catch { value = null; }
    if (!Number.isFinite(value) || value <= 0) return null;
    scale = Math.min(1.6, Math.max(0.5, value / Math.max(1, estimate(list))));
    return value;
  };
  let tokens = estimate(messages);
  if (tokens >= limit * BUDGET.verifyFrom) {
    const counted = await verify(messages);
    if (counted !== null) { tokens = counted; exact = true; }
  }
  const trimmed = [];
  if (tokens > limit) {
    const steps = planFor();
    let at = 0;
    while (tokens > limit) {
      let next = null, name = null;
      while (at < steps.length && !next) {
        next = steps[at].apply(state);
        if (next) name = steps[at].name; else at++;
      }
      if (!next) break;
      state = next; trimmed.push(name);
      messages = build(state);
      tokens = Math.ceil(estimate(messages) * scale); exact = false;
      if (tokens <= limit && tokens >= limit * BUDGET.verifyBand) {
        const counted = await verify(messages);
        if (counted !== null) { tokens = counted; exact = true; }
      }
    }
  }
  return {messages, tokens, limit, fits: tokens <= limit, trimmed, counts, exact, charsPerToken: perToken()};
}

/** One line for the log: what was cut, and what the prompt came to. */
export const describeFit = fit => `prompt ${fit.tokens} of ${fit.limit} tokens${fit.target ? ` (${fit.target} target)` : ''}${fit.exact ? '' : ' (estimated)'}${fit.trimmed.length ? `; cut: ${fit.trimmed.join(', ')}` : ''}${fit.fits ? '' : '; does not fit'}`;

// ---- The request wrapper --------------------------------------------------------------------------------------------------

/** A prompt that cannot fit even with everything optional removed: a failed request (kind 'request') the caller falls back from. */
export class PromptTooLarge extends MistralError {
  constructor(fit, provider = 'local') {
    super('request', `prompt of ${fit.tokens} tokens does not fit the context (${fit.limit})`, {provider});
    this.name = 'PromptTooLarge'; this.fit = fit;
  }
}

/**
 * `chat` with the prompt fitted to the route's budget before it is sent.
 *   budget(options) -> {contextTokens, reserveTokens?, meter?, count?} | null    (null: send as is)
 *   onFit(fit, options)      called with every fit that cut something (the log line)
 *   tooLarge(fit, options)   the error to throw when the prompt cannot fit (default: PromptTooLarge)
 *   shape(args, options)     optional: the arguments to build the prompt from instead (a route may build a smaller persona and history);
 *                            a route without one fits exactly what `buildMessages` was given
 *   budget().soft            optional {contextTokens, reserveTokens?}: a smaller target tried first; a prompt that cannot reach it is fitted
 *                            to the budget's own (hard) limit as before, so a soft target never makes a request fail
 * Only requests built by `buildMessages` are fitted (summaries, fact extraction and prewarm are small and pass through). A server that
 * still refuses the prompt (an estimate that was too low) says how many tokens it counted: that count is learned, the prompt is cut
 * to it, and the request is sent once more.
 */
export function budgetedChat(chat, {budget, onFit, tooLarge, shape} = {}) {
  return async function fittedChat(options) {
    const source = options?.messages?.[PROMPT_SOURCE];
    const base = source ? await budget?.(options) : null;
    if (!base) return chat(options);
    const args = shape ? shape(source, options) : source;
    let current = base;
    for (let attempt = 0; ; attempt++) {
      let fit = base.soft ? await fitMessages({args, budget: {...current, ...base.soft, soft: undefined}}) : null;
      if (fit) fit.target = 'soft';
      if (!fit?.fits) { fit = await fitMessages({args, budget: {...current, soft: undefined}}); if (base.soft) fit.target = 'hard'; }
      if (fit.trimmed.length || !fit.fits) { try { onFit?.(fit, options); } catch { /* a log line never fails a request */ } }
      if (!fit.fits) throw tooLarge ? tooLarge(fit, options) : new PromptTooLarge(fit, options?.provider);
      try {
        const result = await chat({...options, messages: fit.messages});
        base.meter?.observe(fit.messages, result?.usage?.prompt_tokens);
        return result;
      } catch (error) {
        const refused = error?.overflow;
        if (!refused || attempt >= 1 || options?.signal?.aborted) throw error;
        // The server's count of the refused prompt replaces the estimate: learn the ratio and cut by what the estimate missed.
        const learned = base.meter?.observe(fit.messages, refused.promptTokens);
        // A ratio the meter learned corrects the next estimate by itself; only a count it could not learn from is taken off the budget.
        const missed = learned ? 0 : Math.max(0, Number(refused.promptTokens) - fit.tokens);
        const context = Math.min(base.contextTokens, Number(refused.contextTokens) || base.contextTokens);
        current = {...base, contextTokens: context - missed - BUDGET.minMargin};
      }
    }
  };
}
