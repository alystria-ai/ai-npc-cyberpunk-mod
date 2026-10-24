import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkExtra, extraFields, refusedKey, EXTRA_LIMITS} from './sampler-extras.mjs';
import {BASE_PROFILE, PROFILE_LIMITS, defaultProfile, readOverride, validateOverride} from './prompt-profiles.mjs';
import {PromptProfiles} from './prompt-profile-store.mjs';
import {namedKeys, newAdaptation, streamChat} from './mistral-client.mjs';

// The "Advanced parameters (JSON)" and the extra sampling boxes (Top K, Min P, the penalties) of the Prompting page: what is saved, what is refused and with which code.
// What reaches a request is tested in prompt-profiles-host.test.mjs, the page in character-editor-browser.test.mjs.
const codes = result => result.errors.map(({code, name}) => (name ? `${code}:${name}` : code));

test('checkExtra: a JSON object (as text or as an object) of numbers, texts, booleans, lists and small objects of those is kept', () => {
  const given = {typical_p: 0.9, dry_multiplier: 0.8, xtc_probability: 0.5, mirostat: 2, penalize_nl: false, samplers: ['top_k', 'min_p'], dry_sequence_breakers: ['\n', ':'],
    logit_bias: [[15043, -5], [1, false]], grammar_note: 'plain', bias: {'15043': -2}};
  const asObject = checkExtra(given);
  assert.deepEqual(asObject, {ok: true, value: given});
  assert.deepEqual(checkExtra(JSON.stringify(given, null, 2)), {ok: true, value: given});
  assert.notEqual(asObject.value, given, 'a copy');
  for (const nothing of ['', '   ', '{}', {}]) assert.deepEqual(checkExtra(nothing), {ok: true, value: {}}, JSON.stringify(nothing));
});

test('checkExtra: bad JSON, a value that is not an object, and size limits are refused with their own codes', () => {
  assert.deepEqual(codes(checkExtra('{"typical_p": ')), ['extra-json']);
  assert.deepEqual(codes(checkExtra('not json')), ['extra-json']);
  for (const value of ['[1, 2]', '5', '"text"', 'null', 'true', [1], 5]) assert.deepEqual(codes(checkExtra(value)), ['extra-type'], String(value));
  const many = Object.fromEntries(Array.from({length: EXTRA_LIMITS.keys + 1}, (_, index) => [`key_${index}`, index]));
  assert.deepEqual(codes(checkExtra(many)), ['extra-many']);
  assert.equal(checkExtra(many).errors[0].max, EXTRA_LIMITS.keys);
  const big = {samplers: Array.from({length: EXTRA_LIMITS.items}, () => 'a'.repeat(EXTRA_LIMITS.text))};
  assert.deepEqual(codes(checkExtra(big)), ['extra-big']);
  assert.deepEqual(codes(checkExtra(' '.repeat(EXTRA_LIMITS.chars * 3 + 1))), ['extra-big'], 'huge text is refused before it is parsed');
});

test('checkExtra: a key with a box of its own, the length of a reply, and a key the mod controls are refused, whatever the case; the message names the key', () => {
  for (const name of ['temperature', 'top_p', 'top_k', 'min_p', 'repeat_penalty', 'presence_penalty', 'frequency_penalty', 'stop', 'Temperature', 'TOP_K']) {
    assert.deepEqual(codes(checkExtra({[name]: 1})), [`extra-box:${name}`], name);
  }
  for (const name of ['max_tokens', 'max_completion_tokens', 'n_predict', 'max_new_tokens']) assert.deepEqual(codes(checkExtra({[name]: 100})), [`extra-length:${name}`], name);
  for (const name of ['model', 'messages', 'prompt', 'stream', 'stream_options', 'tools', 'tool_choice', 'response_format', 'n', 'prompt_cache_key', 'cache_prompt', 'grammar', 'json_schema',
    'return_progress', 'chat_template_kwargs', 'reasoning_effort', 'enable_thinking', 'Stream', 'MODEL']) {
    assert.deepEqual(codes(checkExtra({[name]: 1})), [`extra-reserved:${name}`], name);
    assert.equal(refusedKey(name), true, name);
  }
  assert.equal(refusedKey('typical_p'), false);
  // Every problem is listed, none is applied.
  assert.deepEqual(codes(checkExtra({mirostat: 2, model: 'x', top_p: 0.5, max_tokens: 5})), ['extra-reserved:model', 'extra-box:top_p', 'extra-length:max_tokens']);
});

test('checkExtra: key names and values are checked (no null, no deep objects, no long texts, no prototype key, no case-twins)', () => {
  for (const name of ['', '1abc', 'with space', 'a-b', 'a.b', 'x'.repeat(EXTRA_LIMITS.name + 1)]) assert.equal(checkExtra({[name]: 1}).errors[0].code, 'extra-name', JSON.stringify(name));
  assert.equal(checkExtra(JSON.parse('{"__proto__": 1}')).errors[0].code, 'extra-name');
  assert.deepEqual(codes(checkExtra({Mirostat: 1, mirostat: 2})), ['extra-name:mirostat']);
  for (const value of [null, {a: {b: 1}}, [[[1]]], [{a: 1}], 'x'.repeat(EXTRA_LIMITS.text + 1), Array.from({length: EXTRA_LIMITS.items + 1}, () => 1)]) {
    assert.deepEqual(codes(checkExtra({typical_p: value})), ['extra-value:typical_p'], JSON.stringify(value)?.slice(0, 40));
  }
});

test('extraFields: only what the form accepts reaches a request, even from a file edited by hand', () => {
  assert.deepEqual(extraFields({typical_p: 0.9, model: 'x', top_k: 5, max_tokens: 1, bad: null, 'a-b': 1, mirostat: 2}), {typical_p: 0.9, mirostat: 2});
  assert.deepEqual(extraFields(null), {});
  assert.deepEqual(extraFields([1]), {});
});

test('validateOverride: Top K, Min P and the penalties have their ranges and an Off; the advanced parameters are stored as an object and an empty one clears them', () => {
  const d = defaultProfile('local-standard');
  const ok = validateOverride({sampling: {topK: 40, minP: 0.05, presencePenalty: -0.5, frequencyPenalty: 1.5, extra: '{"typical_p": 0.9}'}}, d);
  assert.deepEqual(ok, {ok: true, value: {sampling: {topK: 40, minP: 0.05, presencePenalty: -0.5, frequencyPenalty: 1.5, extra: {typical_p: 0.9}}}});
  const range = (key, value) => validateOverride({sampling: {[key]: value}}, d);
  for (const [key, value] of [['topK', 1.5], ['topK', -1], ['topK', 1001], ['minP', 1.1], ['minP', -0.1], ['presencePenalty', 2.5], ['frequencyPenalty', -3], ['topK', '5'], ['minP', 'high']]) {
    const result = range(key, value);
    assert.equal(result.ok, false, `${key} ${value}`);
    assert.equal(result.errors[0].code, 'out-of-range'); assert.deepEqual([result.errors[0].min, result.errors[0].max], PROFILE_LIMITS[key]);
  }
  assert.equal(range('topK', 0).ok, true, 'Top K 0 is a value llama.cpp understands');
  // Off puts the field to "not sent" where the default has a value; where the default is already off it is no change.
  const withValue = validateOverride({sampling: {minP: 0.1}}, d).value;
  assert.deepEqual(validateOverride({sampling: {minP: 'off'}}, d, withValue), {ok: true, value: {}});
  assert.deepEqual(validateOverride({sampling: {extra: null}}, d, ok.value).value, {sampling: {topK: 40, minP: 0.05, presencePenalty: -0.5, frequencyPenalty: 1.5}});
  assert.deepEqual(validateOverride({sampling: {extra: {}}}, d, ok.value).value.sampling.extra, undefined);
  assert.deepEqual(validateOverride({sampling: {extra: ''}}, d, ok.value).value.sampling.extra, undefined);
  // Errors of the JSON come with the field and key the page puts them under.
  const bad = validateOverride({sampling: {extra: {model: 'x'}}}, d);
  assert.deepEqual(bad, {ok: false, errors: [{field: 'sampling', key: 'extra', code: 'extra-reserved', name: 'model'}]});
  assert.deepEqual(validateOverride({sampling: {extra: '{oops'}}, d).errors, [{field: 'sampling', key: 'extra', code: 'extra-json'}]);
  assert.equal(validateOverride({sampling: {extra: 5}}, d).errors[0].code, 'extra-type');
  // Nothing is partly applied.
  assert.equal(validateOverride({sampling: {topK: 20, extra: {model: 'x'}}}, d).ok, false);
});

test('the shipped profiles send none of the new fields, and the default of each is "not sent"', () => {
  for (const profile of [BASE_PROFILE, defaultProfile('mistral'), defaultProfile('local-lite'), defaultProfile('mature-standard'), defaultProfile('family:qwen')].filter(Boolean)) {
    for (const key of ['topK', 'minP', 'presencePenalty', 'frequencyPenalty', 'extra']) assert.equal(profile.sampling[key], null, key);
  }
});

test('Mistral\'s profile refuses Top K, Min P and the advanced parameters (and the penalties are fine); a stored file that has them keeps the rest', () => {
  const d = defaultProfile('mistral');
  for (const sampling of [{topK: 10}, {minP: 0.1}, {extra: {mirostat: 1}}]) assert.deepEqual(codes(validateOverride({sampling}, d, {}, {mistral: true})), ['not-for-mistral']);
  assert.equal(validateOverride({sampling: {presencePenalty: 0.5}}, d, {}, {mistral: true}).ok, true);
  assert.deepEqual(readOverride({sampling: {topK: 10, extra: {mirostat: 1}, temperature: 0.3, presencePenalty: 0.5}}, d, {mistral: true}), {sampling: {temperature: 0.3, presencePenalty: 0.5}});
  assert.deepEqual(readOverride({sampling: {topK: 10, extra: {mirostat: 1}}}, defaultProfile('local-lite')), {sampling: {topK: 10, extra: {mirostat: 1}}});
});

test('the store keeps the advanced parameters in the profile file, a restart reads them back, and reset takes them away', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sampler-extras-'));
  try {
    const store = await PromptProfiles.open({dir});
    assert.equal((await store.set('local-lite', {sampling: {topK: 25, extra: '{"dry_multiplier": 0.8, "samplers": ["top_k"]}'}})).ok, true);
    const reopened = await PromptProfiles.open({dir});
    const profile = reopened.resolve({route: 'local', tier: 'lite'});
    assert.equal(profile.sampling.topK, 25);
    assert.deepEqual(profile.sampling.extra, {dry_multiplier: 0.8, samplers: ['top_k']});
    assert.equal(Object.isFrozen(profile.sampling.extra), true, 'frozen, so a turn cannot change it');
    assert.equal(reopened.resolve({route: 'local', tier: 'standard'}).sampling.extra, null, 'another option is not touched');
    assert.equal((await reopened.set('local-lite', {sampling: {extra: {model: 'x'}}})).ok, false);
    assert.equal(reopened.resolve({route: 'local', tier: 'lite'}).sampling.extra.dry_multiplier, 0.8, 'a refused save changes nothing');
    await reopened.reset('local-lite', 'sampling');
    assert.equal(reopened.resolve({route: 'local', tier: 'lite'}).sampling.extra, null);
    assert.equal(reopened.resolve({route: 'local', tier: 'lite'}).sampling.topK, null);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('namedKeys: a refusal names a field as a whole word', () => {
  assert.deepEqual(namedKeys("Unsupported parameter: 'mirostat'", ['mirostat', 'typical_p']), ['mirostat']);
  assert.deepEqual(namedKeys('dry_multiplier: Extra inputs are not permitted', ['dry_multiplier', 'dry']), ['dry_multiplier']);
  assert.deepEqual(namedKeys('unknown field min_p_extra', ['min_p']), []);
  assert.deepEqual(namedKeys('', ['top_k']), []);
});

test('a request that learns advanced keys one refusal at a time is not cut off by the usual limit of four learned fields', async () => {
  const keys = ['k_one', 'k_two', 'k_three', 'k_four', 'k_five', 'k_six'];
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const left = keys.find(key => key in body);
    if (left) return new Response(JSON.stringify({error: {message: `Unsupported parameter: '${left}'`}}), {status: 400, headers: {'content-type': 'application/json'}});
    const sse = `data: ${JSON.stringify({choices: [{index: 0, delta: {content: 'Fine.'}}]})}\n\ndata: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`;
    return new Response(sse, {status: 200, headers: {'content-type': 'text/event-stream'}});
  };
  const adapt = newAdaptation();
  const result = await streamChat({apiKey: 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL', provider: 'custom', endpoint: 'https://example.com/v1/chat/completions', trustedOrigin: 'https://example.com', messages: [{role: 'user', content: 'hi'}],
    fetchImpl, adapt, askedKeys: keys, extraBody: Object.fromEntries(keys.map(key => [key, 1])), retries: 0});
  assert.equal(result.text, 'Fine.');
  assert.equal(requests.length, keys.length + 1);
  assert.deepEqual([...adapt.dropped].sort(), [...keys].sort());
});
