// Models that think before they answer, in the custom (OpenAI-compatible) provider (docs/CUSTOM_PROVIDER.md, "Models that think first").
//
// A reasoning model (DeepSeek R1, Qwen3 in thinking mode, gpt-oss, OpenRouter's reasoning models) writes its thoughts first and counts them against
// the same `max_tokens` as the answer. The reply budget of a turn is small (300 tokens), so such a model can spend all of it on thinking and return
// an empty `content`. Three things keep that from breaking a conversation (bridge/mistral-client.mjs uses them for provider 'custom' only; a Mistral or
// local request never passes through here):
//   1. `reasoningSteps`: the field that asks the server for no reasoning, or little, where the provider documents one. The first step is tried first;
//      a server that refuses it moves the request to the next step (and finally to none), through the refused-field retry.
//   2. `ThinkFilter`, `reasoningIn`: what the model thought (a `reasoning` / `reasoning_content` / `reasoning_details` field, or <think>...</think> in
//      the text) is never part of what the character says, whichever way the chunks of a stream are cut.
//   3. `retryBudget`, `withNoThink`: a reply that came back empty because the budget went to thinking is asked once more with more room.
//   4. `noThinkingFields`: a model whose id gave no hint is not asked for less thinking from the start; when a request to a server the player runs (the custom provider, or a
//      Local AI `endpoint` entry, which is the 'local' route) came back with only thinking, the retry carries these fields and the endpoint is remembered as one that thinks.
//
// Sources (read 19 Oct 2026):
//   OpenRouter  https://openrouter.ai/docs/use-cases/reasoning-tokens   `reasoning: {effort: "none"|"minimal"|"low"|...}` ("none" disables reasoning; a model
//               with `mandatory: true` rejects it), `exclude` still reasons and still bills, reasoning shares `max_tokens` with the answer ("the response returns
//               finish_reason: "length" with an empty content"), `reasoning` / `reasoning_content` / `reasoning_details` in the message and in each delta.
//               https://openrouter.ai/docs/guides/routing/provider-selection   a provider that lacks a parameter "will ignore unknown parameters" by default.
//               github.com/musistudio/claude-code-router/issues/1238   the refusal of `reasoning: {enabled: false}` on a model that must reason: HTTP 400,
//               "Reasoning is mandatory for this endpoint and cannot be disabled."
//   OpenAI      https://developers.openai.com/api/docs/guides/reasoning   `reasoning_effort` (none, minimal, low, medium, high, ... model-dependent; a value a
//               model lacks is a 400), reasoning tokens use the output budget "before any visible output tokens are produced".
//   Ollama      https://docs.ollama.com/api/openai-compatibility   /v1/chat/completions takes `reasoning_effort` ("none" requests no thinking).
//   DeepSeek    https://api-docs.deepseek.com/guides/thinking_mode   `thinking: {type: "enabled"|"disabled"}`, reasoning in `reasoning_content` of the message
//               and of each delta.
//   Qwen3       https://qwenlm.github.io/blog/qwen3/   the soft switch: "/no_think" in a user or system message turns thinking off for that turn (the hybrid
//               Qwen3 models; the 2507 Instruct/Thinking releases and Qwen3.5 are different models and are not given it).

// Ids of models that reason (or may). A hint list, not a promise: it decides only where the field below is sent to a server that is not OpenRouter, so an
// ordinary model is never sent a field it might refuse. A reasoning model it misses is handled by the empty-reply retry (`retryBudget`).
export const THINKING_MODEL = new RegExp('(?:^|[^a-z0-9])(?:o[134](?![a-z0-9.])|gpt-?5|gpt-?oss|r1(?![a-z0-9])|deepseek-?(?:reasoner|v3\\.[1-9]|v[4-9])|qwen-?3|qwq|magistral|'
  + 'glm-?4\\.[5-9]|glm-?[5-9]|kimi-?k2|grok-?(?:3-mini|[4-9])|gemini-?(?:2\\.5|[3-9])|claude-?(?:3[.-]7|[4-9]|opus-4|sonnet-4)|nemotron|hermes-?4|minimax-?m[12]|seed-?oss|smollm3|exaone-?4)'
  + '|reason|think', 'i');
// A hybrid Qwen3 (the original release): `/no_think` is its documented switch. Qwen3.5, the 2507 releases, the coder and vision models are other things.
export const NO_THINK_MODEL = /qwen-?3(?!\.\d)(?!.*(?:thinking|instruct|2507|coder|vl\b|next|embed|rerank))/i;

/**
 * What to send, by step, to ask for no reasoning (or little). Step 0 first; a refusal that names the field moves on one step (adapt.reasoningStep,
 * bridge/mistral-client.mjs), and after the last step nothing is sent. undefined: send nothing.
 *   openrouter.ai   `reasoning: {effort: 'none'}`, then `{effort: 'low'}` (a model that must reason refuses 'none'). Always sent: OpenRouter's providers ignore
 *                   what they do not know. `exclude` is not used: the model would still think and the budget would still go.
 *   api.deepseek.com   `thinking: {type: 'disabled'}`, then `reasoning_effort: 'low'`.
 *   a server on this computer or the home network (Ollama, LM Studio, llama.cpp), model id that looks like a reasoning model   `reasoning_effort: 'none'`, then 'low'.
 *   any other host, model id that looks like a reasoning model   `reasoning_effort: 'low'` (every OpenAI-style reasoning model takes it).
 */
export function reasoningSteps({hostname, local = false, model} = {}) {
  const host = String(hostname ?? '').toLowerCase();
  if (host === 'openrouter.ai') return [{reasoning: {effort: 'none'}}, {reasoning: {effort: 'low'}}];
  if (host === 'api.deepseek.com') return [{thinking: {type: 'disabled'}}, {reasoning_effort: 'low'}];
  if (!THINKING_MODEL.test(String(model ?? ''))) return undefined;
  return local ? [{reasoning_effort: 'none'}, {reasoning_effort: 'low'}] : [{reasoning_effort: 'low'}];
}

/** The fields `noThinkingFields` can send (a server's refusal that names one of them drops just that one, adapt.noThinkDropped in bridge/mistral-client.mjs). */
export const NO_THINKING_FIELDS = Object.freeze(['reasoning_effort', 'chat_template_kwargs', 'think']);

/**
 * What a turn is asked again with after it came back with only thinking (bridge/mistral-client.mjs, `noThinking`), whatever the model id looked like: a model
 * of a name nobody listed (a server's own label such as "Laptop AI") is not asked for less thinking by `reasoningSteps`, and then thinks through the token limit.
 * Every field here is one a server may honour and a server that does not know it ignores; one that refuses a field by name loses just that field.
 *   a server on this computer or the home network (LM Studio, llama.cpp, Ollama, KoboldCpp)   `reasoning_effort: 'none'` (Ollama's OpenAI endpoint, gpt-oss),
 *     `chat_template_kwargs: {enable_thinking: false}` (llama.cpp's and vLLM's way into a Qwen3-style template), `think: false` (Ollama's own switch)
 *   any other host   `reasoning_effort: 'low'` (a model that cannot be told 'none' takes it) and the template switch
 *   openrouter.ai, api.deepseek.com   undefined: their documented field (`reasoningSteps`) is sent on every request already
 */
export function noThinkingFields({hostname, local = false} = {}) {
  const host = String(hostname ?? '').toLowerCase();
  if (host === 'openrouter.ai' || host === 'api.deepseek.com') return undefined;
  return local
    ? {reasoning_effort: 'none', chat_template_kwargs: {enable_thinking: false}, think: false}
    : {reasoning_effort: 'low', chat_template_kwargs: {enable_thinking: false}};
}

/**
 * The room a request is given from its first try on a route that has refused to turn reasoning off (OpenRouter's "Reasoning is mandatory for this endpoint and cannot be disabled",
 * adapt.mustReason in bridge/mistral-client.mjs): such a model thinks 100 to 1500 tokens before its first word whatever effort it is asked for (measured 2026-10-23, recursive/flint-v1.0:free: 100 to 650 on most turns, over 1500 on one in ten,
 * with `effort` low or minimal and `reasoning.max_tokens` 64 or 256 alike), so the usual 300-token reply budget is gone before the answer starts. The reply's own length cap
 * (`shouldStop`) ends the stream as soon as the reply is long enough, so the larger limit costs no time when the model answers normally.
 */
export const REASONING_ROOM = 2500;

/**
 * The same request field asked for the least reasoning the provider has a word for, used when a reply came back empty because the model thought through its budget: OpenRouter's
 * `effort: 'low'` (or medium, high) becomes 'minimal', the lowest level that still reasons (https://openrouter.ai/docs/use-cases/reasoning-tokens). undefined when there is nothing lower to ask
 * (`none`, another provider's field, or no field).
 */
export function lowerEffort(field) {
  const effort = field?.reasoning?.effort;
  return ['low', 'medium', 'high'].includes(effort) ? {...field, reasoning: {...field.reasoning, effort: 'minimal'}} : undefined;
}

/** The fields `reasoningSteps` can add to a request (all of them are removed when a request is rebuilt for another step). */
export const REASONING_FIELDS = Object.freeze(['reasoning', 'reasoning_effort', 'thinking']);

/** The room a reply is asked again with after it came back empty because the model thought through its budget: five times the budget, at least 1500, at most 4096. */
export const retryBudget = maxTokens => Math.min(4096, Math.max(Number.isFinite(maxTokens) ? maxTokens * 5 : 0, 1500));

/** The messages with Qwen3's documented `/no_think` soft switch on the last user message (the list is copied; the system prompt stays the same). */
export function withNoThink(messages) {
  const at = messages.findLastIndex(message => message?.role === 'user' && typeof message.content === 'string');
  if (at < 0) return messages;
  return messages.map((message, index) => index === at ? {...message, content: `${message.content}\n/no_think`} : message);
}

/** Does a streamed delta or a whole message carry the model's thinking (in any of the fields servers use for it)? */
export function reasoningIn(part) {
  if (!part || typeof part !== 'object') return false;
  for (const key of ['reasoning', 'reasoning_content', 'reasoning_details', 'thinking']) {
    const value = part[key];
    if (typeof value === 'string' ? value.length > 0 : Array.isArray(value) ? value.length > 0 : value && typeof value === 'object') return true;
  }
  return Array.isArray(part.content) && part.content.some(item => item && typeof item === 'object' && (item.type === 'thinking' || item.type === 'reasoning'));
}

/** The reasoning tokens a usage block reports (OpenAI, OpenRouter and most servers: completion_tokens_details.reasoning_tokens). */
export const reasoningTokens = usage => {
  const count = Number(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens ?? 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
};

const OPENERS = ['<think>', '<thinking>', '<thought>', '<reasoning>'];
const OPEN = /<(think|thinking|thought|reasoning)>/i;
const CLOSE = /<\/(?:think|thinking|thought|reasoning)>/gi;

// The length of the longest end of `text` that is the start of one of `words` (a tag cut between two chunks), 0 when none is.
function heldBack(text, words) {
  const lower = text.toLowerCase();
  for (let size = Math.min(lower.length, Math.max(...words.map(word => word.length)) - 1); size > 0; size--) {
    const tail = lower.slice(-size);
    if (words.some(word => word.length > size && word.startsWith(tail))) return size;
  }
  return 0;
}

/**
 * Removes <think>...</think> (also <thinking>, <thought>, <reasoning>) from a stream of text pieces. `push(piece)` returns the text that is safe to show: a tag
 * cut between two pieces ("<thi" + "nk>") is held back until it is known to be one or not, and everything between an opening and its closing tag is dropped,
 * however many pieces it takes. `end()` returns what is still held (a "<" that never became a tag); a block that never closed is dropped with its thoughts.
 * A closing tag with no opening tag (a server whose template opened the block in the prompt) is left in the text; the caller cuts the text after it.
 */
export class ThinkFilter {
  constructor() { this.buffer = ''; this.tag = null; this.sawBlock = false; }
  push(piece) {
    this.buffer += String(piece ?? '');
    let shown = '';
    for (;;) {
      if (this.tag === null) {
        const open = OPEN.exec(this.buffer);
        if (open) {
          shown += this.buffer.slice(0, open.index);
          this.buffer = this.buffer.slice(open.index + open[0].length);
          this.tag = open[1].toLowerCase(); this.sawBlock = true;
          continue;
        }
        const held = heldBack(this.buffer, OPENERS);
        shown += this.buffer.slice(0, this.buffer.length - held);
        this.buffer = this.buffer.slice(this.buffer.length - held);
        return shown;
      }
      const close = `</${this.tag}>`, at = this.buffer.toLowerCase().indexOf(close);
      if (at >= 0) { this.buffer = this.buffer.slice(at + close.length); this.tag = null; continue; }
      const held = heldBack(this.buffer, [close]);
      this.buffer = this.buffer.slice(this.buffer.length - held);
      return shown;
    }
  }
  end() {
    const rest = this.tag === null ? this.buffer : '';
    this.buffer = '';
    return rest;
  }
  /** The stream ended inside a block: the model never got to its answer. */
  get unfinished() { return this.tag !== null; }
}

/** The text after the last stray closing tag (or the text itself when there is none), and whether there was one. */
export function afterStrayClose(text) {
  let last = -1, end = 0;
  for (const match of text.matchAll(CLOSE)) { last = match.index; end = match.index + match[0].length; }
  return last < 0 ? {text, stray: false} : {text: text.slice(end), stray: true};
}
