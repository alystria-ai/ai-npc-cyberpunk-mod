// The "Advanced parameters (JSON)" of a prompt profile's sampling (docs/CHARACTER_EDITOR.md, "Prompting"): extra request fields a player writes down for the samplers that have no box of their own
// (typical_p, dry_multiplier, xtc_probability, mirostat ...). They are added to the body of the player's reply turns on Local AI and Custom, never to Mistral's, and checked here when they are saved.
//
// Precedence: a key that has a box of its own in the form (temperature, top_p, top_k, min_p, repeat_penalty, presence_penalty, frequency_penalty, the stop texts, the longest reply) is refused,
// so there is never a second value to choose between. A key the mod controls (the model, the messages, streaming, tools, the response format, the prompt cache, the thinking fields) is refused too.
// A value is a number, a text, true or false, a list of those (or of lists of those, such as a logit_bias pair), or a small object of those. Pure functions: no I/O here.

export const EXTRA_LIMITS = Object.freeze({chars: 2000, keys: 16, name: 40, text: 200, items: 64, members: 32});

// Keys with a box of their own in the Prompting form.
const BOXED = new Set(['temperature', 'top_p', 'top_k', 'min_p', 'repeat_penalty', 'presence_penalty', 'frequency_penalty', 'stop']);
// The length of a reply is the Longest reply box, under whatever name a server knows it by.
const LENGTH = new Set(['max_tokens', 'max_completion_tokens', 'n_predict', 'max_new_tokens']);
// Fields the mod itself sets or relies on: the request's shape, streaming, tools, the answer format, the prompt cache of our own llama-server, and the fields that ask a model to think less.
const RESERVED = new Set(['model', 'messages', 'prompt', 'input', 'stream', 'stream_options', 'tools', 'tool_choice', 'functions', 'function_call', 'parallel_tool_calls',
  'response_format', 'json_schema', 'grammar', 'n', 'best_of', 'logprobs', 'top_logprobs', 'prompt_cache_key', 'cache_prompt', 'id_slot', 'slot_id', 'return_progress', 'timings_per_token',
  'chat_template', 'chat_template_kwargs', 'reasoning', 'reasoning_effort', 'reasoning_format', 'thinking', 'think', 'enable_thinking', 'include_reasoning',
  'user', 'metadata', 'store', 'service_tier', 'prediction', 'safe_prompt', 'echo', 'suffix', 'add_generation_prompt', 'continue_final_message']);
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const scalar = value => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && Array.from(value).length <= EXTRA_LIMITS.text);

/** Is this a value the advanced parameters accept: a scalar, a list of scalars or of lists of scalars, or an object of scalars? */
function valueOk(value) {
  if (scalar(value)) return true;
  if (Array.isArray(value)) return value.length <= EXTRA_LIMITS.items && value.every(item => scalar(item) || (Array.isArray(item) && item.length <= EXTRA_LIMITS.items && item.every(scalar)));
  if (plain(value)) {
    const entries = Object.entries(value);
    return entries.length <= EXTRA_LIMITS.members && entries.every(([key, item]) => key !== '__proto__' && Array.from(key).length <= EXTRA_LIMITS.name && scalar(item));
  }
  return false;
}

/** Is `name` a request field the advanced parameters may not set? (Case does not matter.) */
export const refusedKey = name => { const lower = String(name).toLowerCase(); return BOXED.has(lower) || LENGTH.has(lower) || RESERVED.has(lower); };

/**
 * Checks the advanced parameters of a sampling: a JSON text or an object. Returns {ok: true, value} (a fresh object; an empty one means none) or {ok: false, errors}, each error
 * {field: 'sampling', key: 'extra', code, name?, max?} with the code one of extra-json, extra-type, extra-big, extra-many, extra-name, extra-box, extra-length, extra-reserved, extra-value.
 */
export function checkExtra(given) {
  const fail = (code, more = {}) => ({ok: false, errors: [{field: 'sampling', key: 'extra', code, ...more}]});
  let value = given;
  if (typeof given === 'string') {
    if (Array.from(given).length > EXTRA_LIMITS.chars * 3) return fail('extra-big', {max: EXTRA_LIMITS.chars});
    if (!given.trim()) return {ok: true, value: {}};
    try { value = JSON.parse(given); } catch { return fail('extra-json'); }
  }
  if (!plain(value)) return fail('extra-type');
  if (Array.from(JSON.stringify(value)).length > EXTRA_LIMITS.chars) return fail('extra-big', {max: EXTRA_LIMITS.chars});
  const names = Object.keys(value);
  if (names.length > EXTRA_LIMITS.keys) return fail('extra-many', {max: EXTRA_LIMITS.keys});
  const errors = [], out = {}, seen = new Set();
  for (const name of names) {
    const lower = name.toLowerCase();
    if (!NAME.test(name) || name.length > EXTRA_LIMITS.name) { errors.push({field: 'sampling', key: 'extra', code: 'extra-name', name: name.slice(0, EXTRA_LIMITS.name)}); continue; }
    if (seen.has(lower)) { errors.push({field: 'sampling', key: 'extra', code: 'extra-name', name}); continue; }
    seen.add(lower);
    if (BOXED.has(lower)) { errors.push({field: 'sampling', key: 'extra', code: 'extra-box', name}); continue; }
    if (LENGTH.has(lower)) { errors.push({field: 'sampling', key: 'extra', code: 'extra-length', name}); continue; }
    if (RESERVED.has(lower)) { errors.push({field: 'sampling', key: 'extra', code: 'extra-reserved', name}); continue; }
    if (!valueOk(value[name])) { errors.push({field: 'sampling', key: 'extra', code: 'extra-value', name}); continue; }
    out[name] = value[name];
  }
  return errors.length ? {ok: false, errors} : {ok: true, value: out};
}

/** The advanced parameters of a stored sampling as request fields: a key that is refused now is left out, whatever the file says (a hand-edited file never reaches the request). */
export function extraFields(extra) {
  const out = {};
  if (plain(extra)) for (const [name, value] of Object.entries(extra)) if (NAME.test(name) && !refusedKey(name) && valueOk(value)) out[name] = value;
  return out;
}
