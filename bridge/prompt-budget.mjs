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
// It never touches the persona (who the character is, how it talks), the output rules, the player's world rules (bridge/world-rules.mjs), the format
// notes, the "right now" block or the player's words. If those alone do not fit, `fits` is false and the caller falls back to another route.
//
// Measuring: a character estimate with a ratio learned from the server's own prompt token counts (`TokenMeter`), and, when the
// estimate comes near the limit, the server's tokenizer (`budget.count`, one request of tens of milliseconds, only then). A turn
// that is far below the limit costs a few microseconds and no request.
import {buildMessages as defaultBuild, capContext, joinBlocks, PROMPT_SOURCE, systemHead} from './mistral-prompt.mjs';
import {MistralError} from './mistral-client.mjs';
import {worldRulesBlock} from './world-rules.mjs';

export const BUDGET = Object.freeze({
  charsPerToken: 3.6,    // before anything is learned, for a model nobody measured
  knownCharsPerToken: 4.0,   // ... for the shipped families: this prompt measures 4.2 to 4.5 on Gemma 4 and on Qwen3.5 (Bonsai), 3.8 to 4.0 for slang and dense notes
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
  biasFrom: 1.06,        // the server's count must top the budget's by this much before it is corrected for (the template and rounding are within it)
  biasKeep: 2,           // observations the correction is taken from: the larger of the last two
  maxBias: 2.5,
  mismatchLog: 1.15,     // a gap this large is written to the log
  keepExchanges: 2,      // older exchanges are dropped down to this many before anything else of the conversation is cut
});

// Text outside plain Latin is counted separately: the ratio learned from English prose does not apply to it. Measured 2026-10-20 with the tokenizers of both model
// families the Local AI ships (Gemma 4: standard and Mature good; Qwen3.5: Bonsai 2 lite and Mature lite), in tokens a character:
//   Chinese, Japanese, Korean                          0.48 to 0.67   counted 0.72 (wide)
//   Cyrillic, Greek, Hebrew, Arabic, Thai, Devanagari  0.27 to 0.47   counted 0.5 (other)
//   Latin Extended-A and -B (Polish, Czech, Turkish letters such as ł ś ę ř ő ğ): 1.0 to 2.7 tokens a letter, counted 2.0 (ext)
// English, French, Spanish, Italian, German and Portuguese prose, the persona and the output rules are 3.8 to 4.5 characters a token (the plain ratio).
export const SCRIPT_TOKENS = Object.freeze({wide: 0.72, other: 0.5, ext: 2.0});
const WIDE = /[ᄀ-ᇿ⺀-鿿가-퟿豈-﫿＀-￯\u{20000}-\u{2fa1f}]/gu;
const OTHER = /[^\u0000-ɏ -⁯₠-⃏←-⇿]/gu;

const EXT = /[Ā-ɏ]/g;

/** How many characters of `text` are wide-script, other-script and Latin-extended letters (the rest is plain). */
export function scriptCounts(text) {
  const value = String(text ?? '');
  // Pure ASCII and Latin-1 (almost every prompt) skips the three scans.
  let plain = true;
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) > 0xff) { plain = false; break; }
  if (plain) return {wide: 0, other: 0, ext: 0};
  const wide = (value.match(WIDE) ?? []).length;
  const ext = (value.match(EXT) ?? []).length;
  const other = Math.max(0, (value.match(OTHER) ?? []).length - wide);
  return {wide, other, ext};
}

/** The tokens a text costs: `charsPerToken` for ordinary characters, SCRIPT_TOKENS for the wide, other and Latin-extended ones. */
export function textTokens(text, charsPerToken = BUDGET.charsPerToken) {
  const value = String(text ?? '');
  if (!value) return 0;
  const {wide, other, ext} = scriptCounts(value);
  if (!wide && !other && !ext) return value.length / charsPerToken;
  return (value.length - wide - other - ext) / charsPerToken + wide * SCRIPT_TOKENS.wide + other * SCRIPT_TOKENS.other + ext * SCRIPT_TOKENS.ext;
}

/** The most tokens a prompt may hold for a budget {contextTokens, reserveTokens?}: the context less the room for the reply and a margin. */
export function fitLimit(budget) {
  const context = Number(budget?.contextTokens);
  return Math.floor(context - (budget?.reserveTokens ?? BUDGET.reserveTokens) - Math.max(BUDGET.minMargin, context * BUDGET.marginRatio));
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

/** The ratio a model starts from before its server has said anything: the shipped families are measured (above), any other model is taken to tokenize worse. */
export const seedRatio = name => (/gemma[-_ ]?4|bonsai|qwen|hauhau/i.test(String(name ?? '')) ? BUDGET.knownCharsPerToken : BUDGET.charsPerToken);

/**
 * What one model's tokenizer really does to this prompt, learned from the token counts its server reports after each turn (nothing is asked of the server for it):
 *   charsPerToken   the lowest recent ratio of plain text (the most tokens for the characters seen), a little lower still: an estimate that is too high only trims
 *                   early, one that is too low costs a refused request. The seed is the measured ratio of the model's family (`seedRatio`).
 *   bias            a factor of 1 or more for what the count missed, whatever the cause (text the ratio does not describe, template or request parts the estimate does
 *                   not know): the server's count of a prompt over what the budget counted for it (the tokenizer's own count when it was asked, else the estimate under
 *                   the ratio learned meanwhile), the larger of the last two, so one odd turn is followed for two turns and a lasting gap for as long as it lasts.
 */
export class TokenMeter {
  #ratios = []; #gaps = [];
  constructor({charsPerToken = BUDGET.charsPerToken, keep = 6} = {}) { this.fallback = charsPerToken; this.keep = keep; this.lastGap = null; }
  get charsPerToken() {
    if (!this.#ratios.length) return this.fallback;
    const lowest = Math.min(...this.#ratios) * 0.97;
    return Math.min(BUDGET.maxCharsPerToken, Math.max(BUDGET.minCharsPerToken, lowest));
  }
  get samples() { return this.#ratios.length; }
  get bias() {
    const gap = Math.max(0, ...this.#gaps);
    return gap > BUDGET.biasFrom ? Math.min(BUDGET.maxBias, gap) : 1;
  }
  /**
   * `promptTokens` is the server's count for `messages` (usage.prompt_tokens, or n_prompt_tokens of a refusal). `raw` and `exact`: what the budget counted for them
   * before the bias, and whether that was the tokenizer's own count; with them the gap between the budget and the server is learned too.
   * Returns whether the ratio learned something (`lastGap` is the gap of this observation, or null).
   */
  observe(messages, promptTokens, {raw, exact = false} = {}) {
    this.lastGap = null;
    const real = Number(promptTokens);
    const tokens = real - templateTokens(messages.length);
    if (!Number.isFinite(tokens) || tokens < 200) return false;   // a tiny prompt says nothing about the ratio
    let chars = 0, plain = 0, foreign = 0;
    for (const message of messages) {
      const text = String(message?.content ?? '');
      const {wide, other, ext} = scriptCounts(text);
      chars += text.length; plain += text.length - wide - other - ext;
      foreign += wide * SCRIPT_TOKENS.wide + other * SCRIPT_TOKENS.other + ext * SCRIPT_TOKENS.ext;
    }
    // Plain text teaches the ratio; the letters of other scripts are taken off at what they are counted at.
    let learned = false;
    if (plain >= chars * 0.7 && tokens - foreign >= 150) {
      this.#ratios.push(plain / (tokens - foreign));
      if (this.#ratios.length > this.keep) this.#ratios.shift();
      learned = true;
    }
    const counted = exact ? Number(raw) : estimateTokens(messages, this.charsPerToken);
    if (Number.isFinite(counted) && counted >= 200) {
      this.lastGap = real / counted;
      this.#gaps.push(this.lastGap);
      if (this.#gaps.length > BUDGET.biasKeep) this.#gaps.shift();
    }
    return learned;
  }
  reset() { this.#ratios = []; this.#gaps = []; this.lastGap = null; }
}

// ---- How fast this machine reads a prompt -------------------------------------------------------------------------------------

// The context says how much a prompt MAY hold; it says nothing about how long the machine takes to read it. On the developer's card a
// 15,700-token prompt reads in 7 s. On the computers of the first player reports (2026-10-19) the game keeps the card busy, or the model had
// to leave some of its layers on the CPU, and the same server read 36 to 300 tokens a second: a 5,400-token prompt of which 3,000 were new
// took 10 to 70 s, or ran out of the 75 s the turn has. So a turn on a machine that has been seen to read slowly is fitted to a smaller
// target first: what it still has to read (the prompt less the part the server already holds) fits in `targetSeconds`. The cuts are the same
// ones, in the same order (above); a prompt that cannot reach the target is fitted to the context as before, so this never fails a request.
export const PREFILL = Object.freeze({
  fastTokensPerSecond: 700,   // from this speed on, the context is the only limit
  targetSeconds: 8,           // the new part of a prompt is cut to what is read in this long
  steps: Object.freeze([600, 900, 1300, 1800, 2500, 3500]),   // the new tokens allowed, in steps: a speed that wobbles must not move the early part of the prompt every turn
  minSample: 256,             // a prompt with fewer new tokens says nothing about the speed
  maxAgeMs: 10 * 60_000,      // a measurement older than this is no longer believed
  offloadPrior: 120,          // before anything is measured, a model with layers on the CPU is taken to read this many tokens a second
  failureFloor: 512,          // a stuck request is credited with at least one batch of this many tokens
  // The compact character text (bridge/compact-persona.mjs) is a further step for a machine that is clearly slow, with a hysteresis so it does not flip from turn to turn:
  // two readings in a row under `compactBelow` switch it on, two in a row at `compactAbove` or more switch it off, anything between keeps the state. Measured readings
  // only (the prior of a model with layers on the CPU does not count). 600: the 0.2.4 reports read 36 to 420 tokens a second when slow, a card the game shares reads 700 and
  // more at worst, and the developer's card reads 5,000; below 600 the 3,500 tokens of a long persona cost 6 s and more every time a character is spoken to for the first time.
  compactBelow: 600,
  compactAbove: 1000,
  compactRuns: 2,
});

/**
 * The prompt-reading speed of the model that is loaded, learned from its own timings (`trace.timings`: new tokens, cached tokens, milliseconds)
 * and from requests that got stuck reading the prompt (`trace.progress`). One per loaded model: a model that was loaded again (an idle stop and a
 * start with less memory free) gets a new one. `soft()` is the smaller budget `budgetedChat` tries first, or null while the machine is fast
 * or nothing is known.
 */
export class PrefillMeter {
  #rate = null; #at = 0; #cached = 0; #compact = false; #streak = 0;
  // compact: the state this machine was in under the load before (a model loaded again after an idle stop starts from what was learned, not from the full text).
  constructor({now = Date.now, offload = false, compact = false} = {}) { this.now = now; this.offload = offload === true; this.#compact = compact === true; }
  // One reading, `weight` of them (a request that stalled counts for the whole run at once): a streak of readings on the other side of the threshold flips the state.
  #judge(sample, weight = 1) {
    if (!(sample > 0) || !Number.isFinite(sample)) return;
    const against = this.#compact ? sample >= PREFILL.compactAbove : sample < PREFILL.compactBelow;
    this.#streak = against ? this.#streak + weight : 0;
    if (this.#streak >= PREFILL.compactRuns) { this.#compact = !this.#compact; this.#streak = 0; }
  }
  #blend(sample) {
    if (!(sample > 0) || !Number.isFinite(sample)) return;
    this.#rate = this.#rate !== null && this.now() - this.#at <= PREFILL.maxAgeMs ? (this.#rate + sample) / 2 : sample;
    this.#at = this.now();
  }
  /** A request that answered: the server's own numbers for the prompt it read. */
  observe(trace) {
    const timings = trace?.timings;
    const cached = Number(timings?.cachedTokens), fresh = Number(timings?.promptTokens), ms = Number(timings?.promptMs);
    if (Number.isFinite(cached) && cached >= 0) this.#cached = cached;
    if (fresh >= PREFILL.minSample && ms > 0) { this.#blend(fresh / ms * 1000); this.#judge(fresh / ms * 1000); }
  }
  /** A request that ended while the prompt was being read: what was read in the time the server had it (never before it had it). */
  observeFailure(trace) {
    const progress = trace?.progress;
    if (!progress || !(progress.processed < progress.total) || !Number.isFinite(trace.headersMs) || !(trace.elapsedMs > trace.headersMs)) return;
    const cache = Number(progress.cache) || 0;
    if (cache > 0) this.#cached = cache;
    const seconds = (trace.elapsedMs - trace.headersMs) / 1000;
    if (seconds < 5) return;
    const sample = Math.max(PREFILL.failureFloor, progress.processed - cache) / seconds;
    this.#blend(sample);
    this.#judge(sample, PREFILL.compactRuns);
  }
  /** Tokens a second, or null (nothing measured lately, and no reason to expect a slow machine). */
  get tokensPerSecond() {
    if (this.#rate !== null && this.now() - this.#at <= PREFILL.maxAgeMs) return this.#rate;
    return this.offload ? PREFILL.offloadPrior : null;
  }
  /** The tokens the server held of the last prompt. */
  get cachedTokens() { return this.#cached; }
  /**
   * True while this machine is measured to read prompts slowly enough for the compact character text (PREFILL.compactBelow / compactAbove; bridge/compact-persona.mjs).
   * Never true before something was measured, and never for a machine that reads fast.
   */
  get compact() { return this.#compact; }
  /** True while the machine is believed to read slowly (a measurement below PREFILL.fastTokensPerSecond, or the prior of a model with layers on the CPU). */
  get slow() { const rate = this.tokensPerSecond; return rate !== null && rate < PREFILL.fastTokensPerSecond; }
  /**
   * The smaller budget for a slow machine, as `fitMessages` takes it ({contextTokens, reserveTokens}); null when there is none.
   * `floorTokens`: what the prompt holds that is read once and then kept, its persona and rules (the first turn of a character, or a character that
   * is not the one the server held): the allowance is added to the larger of that and what the server holds.
   * `reach`: a prompt that was cut as far as it can be and still came to this many tokens (a target it could not reach): the smallest larger step whose limit holds it,
   * or null when even the largest step does not (the cliff of 2026-10-20: a prompt that missed the target by a few tokens was sent whole, 5,300 tokens instead of 3,300).
   */
  soft(floorTokens = 0, reach = 0) {
    const rate = this.tokensPerSecond;
    const held = Math.max(this.#cached, Number(floorTokens) || 0);
    if (rate === null || rate >= PREFILL.fastTokensPerSecond || !(held > 0)) return null;
    const wanted = rate * PREFILL.targetSeconds;
    let allowed = PREFILL.steps.reduce((best, step) => step <= wanted ? step : best, PREFILL.steps[0]);
    if (reach > 0) {
      const next = PREFILL.steps.find(step => step > allowed && held + step >= reach);
      if (next === undefined) return null;
      allowed = next;
    }
    const total = held + allowed;
    // fitMessages keeps a margin of max(minMargin, marginRatio of the context) below the context it is given: ask for one that leaves `total`.
    let contextTokens = Math.ceil(Math.max(total + BUDGET.minMargin, total / (1 - BUDGET.marginRatio)));
    while (Math.floor(contextTokens - Math.max(BUDGET.minMargin, contextTokens * BUDGET.marginRatio)) < total) contextTokens++;
    return {contextTokens, reserveTokens: 0};
  }
}

/** The tokens of the persona and the rules of a prompt's arguments (the head every turn of a character starts with; never cut), or 0 when they cannot be built. */
function headTokens(args, charsPerToken = BUDGET.charsPerToken) {
  try {
    if (!args?.persona) return 0;
    // The world rules follow the head in every turn and are read once like it: they are part of what the server holds.
    const head = [systemHead({persona: args.persona, limits: args.limits, mature: args.mature ?? null, guard: args.guard ?? false}), worldRulesBlock(args.persona.worldRules)].filter(Boolean).join('\n\n');
    return Math.ceil(textTokens(head, charsPerToken)) + templateTokens(1);
  } catch { return 0; }
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

// ---- The compact persona (last resort) -----------------------------------------------------------------------------------------

// A server with a small context (a 4,096-token one the player runs themselves) cannot hold a named character's persona and the output rules
// (Judy's alone are about 4,500 tokens), and nothing optional is left to cut. When no other route can answer the turn (`shrinkPersona`), the persona
// itself is shortened in fixed levels: the backstory keeps its beginning, the style keeps its beginning, the example lines are already gone, and the
// rules, the format notes, the right-now block, the player's own rules, the world rules and the Mature layer are never cut. The first level that fits is used. The levels
// are few and coarse on purpose: the persona sits at the very start of the prompt, so a level that changed with every turn would make the server read it
// again every turn; as the rest of the prompt is already at its smallest here, the same level is chosen turn after turn.
export const PERSONA_LEVELS = Object.freeze([
  Object.freeze({backstory: 9000, style: Infinity}), Object.freeze({backstory: 6000, style: Infinity}), Object.freeze({backstory: 4200, style: Infinity}),
  Object.freeze({backstory: 3000, style: 1200}), Object.freeze({backstory: 2200, style: 900}), Object.freeze({backstory: 1600, style: 700}),
  Object.freeze({backstory: 1100, style: 500}), Object.freeze({backstory: 700, style: 360})]);

// The beginning of a text up to `limit` characters, ended at a sentence (or else a word) so no sentence is cut in two; the text itself when it is not longer.
export function leadingText(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  const piece = value.slice(0, limit);
  const sentences = [...piece.matchAll(/[.!?…]["'”’)\]]*(?=\s)/g)], last = sentences.at(-1);
  const end = last && last.index + last[0].length >= limit * 0.6 ? last.index + last[0].length : piece.replace(/\s+\S*$/, '').length;
  return piece.slice(0, end > 0 ? end : limit).trimEnd();
}

/** The persona of `args` at a level of PERSONA_LEVELS, or null when that level cuts nothing (the persona is already that short). */
function compactPersona(args, level) {
  const persona = args?.persona;
  if (!persona) return null;
  const backstory = leadingText(persona.backstory, level.backstory), style = leadingText(persona.style, level.style);
  if (backstory === String(persona.backstory ?? '') && style === String(persona.style ?? '')) return null;
  return {...args, persona: {...persona, backstory, style, samples: []}};
}

/**
 * The messages of a request, cut to fit.
 *   args     what `buildMessages` takes (persona, memory, history, context, contextParts, remembered, text, reaction, limits);
 *            `contextParts.worldBlocks` ([{key, text}], in the order they are joined into `contextParts.world`) lets the world
 *            block be trimmed block by block
 *   budget   {contextTokens, reserveTokens?, meter?, count?}: the server's context, the room kept for the reply, a TokenMeter, and
 *            `count(messages)` -> Promise<tokens | null> from the server's tokenizer (optional)
 *   shrinkPersona   true: when everything optional is gone and the prompt is still over, the persona is shortened (PERSONA_LEVELS) rather than
 *            failing; the caller sets it only when no other route is left to answer the turn
 * Returns {messages, tokens, limit, fits, trimmed: [step names], counts, exact}.
 */
export async function fitMessages({args, build = defaultBuild, budget, shrinkPersona = false}) {
  const context = Number(budget?.contextTokens);
  let state = args;
  let messages = build(state);
  if (!(context > 0)) return {messages, tokens: estimateTokens(messages), raw: estimateTokens(messages), limit: Infinity, fits: true, trimmed: [], counts: 0, exact: false};
  const reserve = budget.reserveTokens ?? BUDGET.reserveTokens;
  const limit = fitLimit({contextTokens: context, reserveTokens: reserve});
  const perToken = () => budget.meter?.charsPerToken ?? BUDGET.charsPerToken;
  // The meter's bias (1 unless the server has counted more than the budget did) corrects the estimate and the tokenizer's count alike.
  const bias = () => budget.meter?.bias ?? 1;
  const estimate = list => Math.ceil(estimateTokens(list, perToken()) * bias());
  let counts = 0, scale = 1, exact = false;
  // The server's own count of `list`, which also corrects the estimate for the rest of this fit.
  const verify = async list => {
    if (typeof budget.count !== 'function' || counts >= BUDGET.maxCounts) return null;
    counts++;
    let value = null;
    try { value = await budget.count(list); } catch { value = null; }
    if (!Number.isFinite(value) || value <= 0) return null;
    value = Math.ceil(value * bias());
    scale = Math.min(3, Math.max(0.5, value / Math.max(1, estimate(list))));
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
    // Nothing optional is left and the prompt is still over: the persona is shortened, the largest level that fits.
    if (tokens > limit && shrinkPersona) {
      let used = null;
      for (const level of PERSONA_LEVELS) {
        const next = compactPersona(state, level);
        if (!next) continue;
        const list = build(next);
        let value = Math.ceil(estimate(list) * scale), counted = false;
        if (value <= limit && value >= limit * BUDGET.verifyBand) { const known = await verify(list); if (known !== null) { value = known; counted = true; } }
        state = next; messages = list; tokens = value; exact = counted; used = level;
        if (tokens <= limit) break;
      }
      if (used) trimmed.push(`persona:${used.backstory}`);
    }
  }
  // `raw`: the tokens before the meter's bias, which is what the server's own count is compared with afterwards (TokenMeter.observe).
  return {messages, tokens, raw: Math.ceil(tokens / bias()), limit, fits: tokens <= limit, trimmed, counts, exact, charsPerToken: perToken(), bias: bias()};
}

/** One line for the log: what was cut, and what the prompt came to. */
export const describeFit = fit => `prompt ${fit.tokens} of ${fit.limit} tokens${fit.target ? ` (${fit.raised ? 'raised ' : ''}${fit.target} target)` : ''}${fit.exact ? '' : ' (estimated)'}${fit.trimmed.length ? `; cut: ${fit.trimmed.join(', ')}` : ''}${fit.fits ? '' : '; does not fit'}`;

// ---- The request wrapper --------------------------------------------------------------------------------------------------

/** A prompt that cannot fit even with everything optional removed: a failed request (kind 'request') the caller falls back from. */
export class PromptTooLarge extends MistralError {
  // server: the context belongs to a model server the player runs; the words then say so, and the game tells the player to raise it there (errorCodeFor, 'local-context').
  constructor(fit, provider = 'local', {server = false} = {}) {
    super('request', `prompt of ${fit.tokens} tokens does not fit the context (${fit.limit})${server ? ': the model server\'s context is too small' : ''}`, {provider});
    this.name = 'PromptTooLarge'; this.fit = fit;
  }
}

/** The least context a server's is stepped down to when a refusal does not say what it really has (a smaller one could not hold even the shortest persona). */
export const MIN_SERVER_CONTEXT = 2048;

/**
 * `chat` with the prompt fitted to the route's budget before it is sent.
 *   budget(options) -> {contextTokens, reserveTokens?, meter?, count?} | null    (null: send as is)
 *   onFit(fit, options)      called with every fit that cut something (the log line)
 *   tooLarge(fit, options)   the error to throw when the prompt cannot fit (default: PromptTooLarge)
 *   shape(args, options, base)  optional: the arguments to build the prompt from instead (a route may build a smaller persona and history; `base` is the budget);
 *                            a route without one fits exactly what `buildMessages` was given
 *   options.lastResort       true when no other route is left to answer the turn: a prompt that cannot fit has its persona shortened (PERSONA_LEVELS)
 *                            instead of failing; otherwise it fails and the host hands the turn to the next route
 *   budget().server          true: the context is a model server the player runs (its loaded context can be smaller than it reported). A refusal of the prompt then
 *                            teaches the real context (the one the error names, else half of the one assumed, at least MIN_SERVER_CONTEXT), `learn(contextTokens, options)` is called
 *                            with it so later requests start from it, and a prompt that still does not fit fails with the words of a context that is too small (PromptTooLarge)
 *   budget().soft            optional {contextTokens, reserveTokens?}: a smaller target tried first; a prompt that cannot reach it is fitted
 *                            to the budget's own (hard) limit as before, so a soft target never makes a request fail. A target `budget().speed` chose
 *                            (a slow machine) that the prompt cannot reach even with everything optional cut is raised to the smallest larger step that holds
 *                            the cut prompt (PrefillMeter.soft `reach`) before the hard limit is used: the next step up reads a few hundred tokens more, the hard limit thousands
 *   onMismatch(info, options)  called when the server counted at least BUDGET.mismatchLog times what the budget did for the prompt that was sent: {raw, real, gap, exact, bias}
 * Only requests built by `buildMessages` are fitted (summaries, fact extraction and prewarm are small and pass through). A server that
 * still refuses the prompt (an estimate that was too low) says how many tokens it counted: that count is learned, the prompt is cut
 * to it, and the request is sent once more.
 */
export function budgetedChat(chat, {budget, onFit, onMismatch, tooLarge, shape, learn} = {}) {
  return async function fittedChat(options) {
    const source = options?.messages?.[PROMPT_SOURCE];
    const base = source ? await budget?.(options) : null;
    if (!base) return chat(options);
    const args = shape ? shape(source, options, base) : source;
    let current = base;
    // `speed` (a PrefillMeter): on a machine that has been seen to read prompts slowly, a smaller target than the context is tried first.
    // An explicit `soft` of the budget wins.
    const floor = base.soft || !base.speed?.slow ? 0 : headTokens(args, base.meter?.charsPerToken);
    const soft = base.soft ?? (base.speed?.slow ? base.speed.soft(floor) : null);
    for (let attempt = 0; ; attempt++) {
      // A soft target only ever lowers the limit: one that is not below the context's own (a persona that is itself longer than the allowance makes the soft
      // context larger than the real one; the reply's room and a context the server refused are lost with it) is not used, so a prompt it lets through
      // cannot be longer than the context allows. 2026-10-20 live record: 8919 tokens sent to an 8192-token server, and the retry fitted to the same target.
      const hard = {...current, soft: undefined}, lower = soft ? {...current, ...soft, soft: undefined} : null;
      let fit = lower && fitLimit(lower) < fitLimit(hard) ? await fitMessages({args, budget: lower}) : null;
      if (fit) fit.target = 'soft';
      // The target of a slow machine was missed with everything optional cut: the next step up that holds what is left, before the whole prompt goes.
      if (fit && !fit.fits && !base.soft && base.speed?.slow) {
        const higher = base.speed.soft(floor, fit.tokens);
        const wider = higher ? {...current, ...higher, soft: undefined} : null;
        if (wider && fitLimit(wider) < fitLimit(hard)) {
          const again = await fitMessages({args, budget: wider});
          if (again.fits) { fit = again; fit.target = 'soft'; fit.raised = true; }
        }
      }
      if (!fit?.fits) { fit = await fitMessages({args, budget: hard, shrinkPersona: options?.lastResort === true}); if (soft) fit.target = 'hard'; }
      if (fit.trimmed.length || !fit.fits) { try { onFit?.(fit, options); } catch { /* a log line never fails a request */ } }
      if (!fit.fits) throw tooLarge ? tooLarge(fit, options) : new PromptTooLarge(fit, options?.provider, {server: base.server === true});
      try {
        const result = await chat({...options, messages: fit.messages});
        base.meter?.observe(fit.messages, result?.usage?.prompt_tokens, {raw: fit.raw, exact: fit.exact});
        const gap = base.meter?.lastGap;
        if (gap >= BUDGET.mismatchLog) { try { onMismatch?.({raw: fit.raw, real: Number(result.usage.prompt_tokens), gap, exact: fit.exact, bias: base.meter.bias}, options); } catch { /* a log line never fails a request */ } }
        try { base.speed?.observe(result?.trace); } catch { /* a measurement never fails a request */ }
        return result;
      } catch (error) {
        // A request that was stuck reading the prompt says how far it got: the next turn is fitted to what this machine reads.
        try { base.speed?.observeFailure(error?.trace); } catch { /* a measurement never fails a request */ }
        const refused = error?.overflow;
        if (!refused || options?.signal?.aborted) throw error;
        if (attempt >= 1) {
          if (base.server !== true) throw error;
          // A model server the player runs that still refuses the prompt after it was fitted again: its context is too small for this character.
          const counted = Number(refused.promptTokens) > 0 ? Number(refused.promptTokens) : fit.tokens;
          throw new PromptTooLarge({tokens: counted, limit: Number(refused.contextTokens) > 0 ? Number(refused.contextTokens) : current.contextTokens}, options?.provider, {server: true});
        }
        // The server's count of the refused prompt replaces the estimate: learn the ratio and cut by what the estimate missed.
        const counted = Number(refused.promptTokens) > 0;
        const learned = counted ? base.meter?.observe(fit.messages, refused.promptTokens, {raw: fit.raw, exact: fit.exact}) : null;
        // A ratio the meter learned corrects the next estimate by itself; only a count it could not learn from is taken off the budget.
        const missed = learned || !counted ? 0 : Math.max(0, Number(refused.promptTokens) - fit.tokens);
        // The context the server says it has; one that does not say (LM Studio's loaded context can be smaller than what it reported) is stepped down by half.
        const said = Number(refused.contextTokens) > 0;
        let context = said ? Math.min(base.contextTokens, Number(refused.contextTokens)) : base.contextTokens;
        if (!said && base.server === true) context = Math.max(MIN_SERVER_CONTEXT, Math.floor(base.contextTokens / 2));
        if (base.server === true && context < base.contextTokens) { try { learn?.(context, options); } catch { /* a note of the context never fails a request */ } }
        current = {...base, contextTokens: context - missed - BUDGET.minMargin};
      }
    }
  };
}
