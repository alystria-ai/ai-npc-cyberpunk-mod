// The custom (OpenAI-compatible) provider and models that think first, and OpenRouter's free-model daily limit (docs/CUSTOM_PROVIDER.md, "Models that think first" and
// "Free models and their daily limit"): what each kind of server is sent, what the character is never made to say, the empty reply whose budget went to thinking, and
// the daily 429. Against the loopback mock (bridge/openai-mock-server.mjs). No real network, no real key. Mistral and the local AI must not change.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {streamChat, mapFailure, errorCodeFor, failureKind, errorExtrasFor, resetClock, MistralError, newAdaptation, rejectedParameters} from './mistral-client.mjs';
import {ThinkFilter, THINKING_MODEL, NO_THINK_MODEL, afterStrayClose, reasoningIn, reasoningSteps, retryBudget, withNoThink} from './reasoning.mjs';
import {CustomEndpoint, describeFailure, parseEndpointUrl, testConnection} from './custom-endpoint.mjs';
import {TextProviderHost, customRoute} from './text-provider-host.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {MatureContent} from './mature-content.mjs';
import {MOCK_REPLY, startOpenAiMock} from './openai-mock-server.mjs';

const KEY = 'test' + 'x'.repeat(28);
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const messages = [{role: 'system', content: 'You are a test.'}, {role: 'user', content: 'Hi.'}];
const quick = {firstByteMs: 400, retryFirstByteMs: 400, totalMs: 1500, retries: 1, backoffMs: [5]};
const via = (mock, extra = {}) => ({provider: 'custom', endpoint: mock.url + '/chat/completions', trustedOrigin: mock.origin, model: 'test-model', messages, apiKey: KEY, ...extra});
const REASONING_FIELDS = ['reasoning', 'reasoning_effort', 'thinking'];
const asked = request => REASONING_FIELDS.filter(name => name in request.body);

// ---- What the character never says -------------------------------------------------------------------------------------------

const filtered = pieces => { const filter = new ThinkFilter(); const shown = pieces.map(piece => filter.push(piece)); return {shown, text: shown.join('') + filter.end(), filter}; };

test('think tags are removed however the stream is cut: at every pair of cut points, nothing of the block or of a half tag is ever shown', () => {
  const text = 'Sure.<think>why is V asking\nhmm</think>\n\nYes, V. Over here.';
  const expected = 'Sure.\n\nYes, V. Over here.';
  for (let i = 0; i <= text.length; i++) {
    for (let j = i; j <= text.length; j++) {
      const {shown, text: whole} = filtered([text.slice(0, i), text.slice(i, j), text.slice(j)]);
      assert.equal(whole, expected, `cut at ${i} and ${j}`);
      assert.ok(shown.every(piece => !/[<>]|why|hmm/.test(piece)), `cut at ${i} and ${j}: ${JSON.stringify(shown)}`);
    }
  }
  // One character at a time, and the other spellings.
  assert.equal(filtered([...text]).text, expected);
  assert.equal(filtered(['A <THINK>x</Think>B']).text, 'A B');
  assert.equal(filtered(['A <thinking>x</thinking>B <thought>y</thought>C <reasoning>z</reasoning>D']).text, 'A B C D');
  assert.equal(filtered(['<think>one</think>', '<think>two</think>Hello']).text, 'Hello');
  // A block that never closes was all thinking: the model never got to its answer.
  const open = filtered(['Hello <think>no end', ' in sight']);
  assert.equal(open.text, 'Hello ');
  assert.equal(open.filter.unfinished, true);
  // A "<" that is not a tag is text, also at the very end; a "</think>" with no opening one is left for the caller (afterStrayClose).
  assert.equal(filtered(['a < b']).text, 'a < b');
  assert.equal(filtered(['x <']).text, 'x <');
  assert.equal(filtered(['x <thi']).text, 'x <thi');
  assert.equal(filtered(['x <think', 'er>']).text, 'x <thinker>');
  assert.equal(filtered(['reasoning</think>Answer']).text, 'reasoning</think>Answer');
  assert.deepEqual(afterStrayClose('reasoning</think>\nAnswer'), {text: '\nAnswer', stray: true});
  assert.deepEqual(afterStrayClose('reasoning</think>'), {text: '', stray: true});
  assert.deepEqual(afterStrayClose('plain'), {text: 'plain', stray: false});
});

test('a model that thought in a field of its own is recognised in every shape servers use', () => {
  assert.equal(reasoningIn({reasoning: 'x'}), true);
  assert.equal(reasoningIn({reasoning_content: 'x'}), true);
  assert.equal(reasoningIn({reasoning_details: [{type: 'reasoning.text', text: 'x'}]}), true);
  assert.equal(reasoningIn({content: [{type: 'thinking', thinking: [{type: 'text', text: 'x'}]}, {type: 'text', text: 'Hi'}]}), true);
  for (const nothing of [{}, {content: 'Hi'}, {reasoning: ''}, {reasoning_details: []}, {content: [{type: 'text', text: 'Hi'}]}, null, 'text']) assert.equal(reasoningIn(nothing), false, JSON.stringify(nothing));
});

// ---- What each kind of server is sent ---------------------------------------------------------------------------------------

test('what is sent to ask for no reasoning, by kind of server and model: OpenRouter always, a server that lists reasoning models, and nothing to an ordinary one', () => {
  assert.deepEqual(reasoningSteps({hostname: 'openrouter.ai', model: 'meta-llama/llama-3.1-8b-instruct:free'}), [{reasoning: {effort: 'none'}}, {reasoning: {effort: 'low'}}],
    'OpenRouter ignores what a provider does not know, so it is sent for every model');
  assert.deepEqual(reasoningSteps({hostname: 'api.deepseek.com', model: 'deepseek-chat'}), [{thinking: {type: 'disabled'}}, {reasoning_effort: 'low'}]);
  assert.deepEqual(reasoningSteps({hostname: 'localhost', local: true, model: 'qwen3:8b'}), [{reasoning_effort: 'none'}, {reasoning_effort: 'low'}]);
  assert.deepEqual(reasoningSteps({hostname: 'api.openai.com', model: 'o3-mini'}), [{reasoning_effort: 'low'}]);
  assert.deepEqual(reasoningSteps({hostname: 'api.groq.com', model: 'openai/gpt-oss-20b'}), [{reasoning_effort: 'low'}]);
  for (const ordinary of ['gpt-4o', 'gpt-4o-mini', 'llama3.2', 'meta-llama/llama-3.1-8b-instruct', 'mistral-small-latest', 'gemma3:4b', 'phi4', 'qwen2.5:7b', 'claude-3-5-sonnet-20241022', 'x']) {
    assert.equal(reasoningSteps({hostname: 'api.openai.com', model: ordinary}), undefined, ordinary);
    assert.equal(reasoningSteps({hostname: 'localhost', local: true, model: ordinary}), undefined, ordinary);
  }
  assert.equal(reasoningSteps({}), undefined);
  for (const thinking of ['o1', 'o3-mini', 'o4-mini', 'openai/o3', 'gpt-5', 'gpt-5-mini', 'gpt-oss:20b', 'openai/gpt-oss-120b:free', 'deepseek-r1:8b', 'deepseek/deepseek-r1-0528:free', 'deepseek-reasoner',
    'qwen3:8b', 'qwen/qwen3-235b-a22b', 'qwen3-30b-a3b-thinking-2507', 'qwq:32b', 'magistral-small-latest', 'z-ai/glm-4.5-air:free', 'moonshotai/kimi-k2', 'grok-3-mini', 'gemini-2.5-flash',
    'claude-3-7-sonnet-latest', 'claude-sonnet-4', 'nvidia/nemotron-nano-9b-v2:free', 'phi4-reasoning', 'my-thinking-model']) assert.ok(THINKING_MODEL.test(thinking), thinking);
  assert.ok(NO_THINK_MODEL.test('qwen3:8b') && NO_THINK_MODEL.test('qwen/qwen3-235b-a22b') && NO_THINK_MODEL.test('Qwen3-32B'));
  for (const not of ['qwen3-30b-a3b-thinking-2507', 'qwen3-4b-instruct-2507', 'qwen3-coder:30b', 'qwen3.5:9b', 'qwen2.5:7b', 'qwen3-vl:8b', 'deepseek-r1:8b']) assert.ok(!NO_THINK_MODEL.test(not), not);
  assert.equal(retryBudget(300), 1500);
  assert.equal(retryBudget(24), 1500);
  assert.equal(retryBudget(500), 2500);
  assert.equal(retryBudget(5000), 4096);
  assert.equal(retryBudget(undefined), 1500);
  const list = [{role: 'system', content: 'S'}, {role: 'user', content: 'Hi'}, {role: 'assistant', content: 'Hello'}, {role: 'user', content: 'More'}];
  assert.deepEqual(withNoThink(list).map(message => message.content), ['S', 'Hi', 'Hello', 'More\n/no_think']);
  assert.equal(list[3].content, 'More', 'the list is copied');
});

test('the saved endpoint decides the steps: what the player entered, nothing sent anywhere', async () => {
  const stepsFor = async (url, model) => {
    const custom = new CustomEndpoint({path: null});
    await custom.setUrl(parseEndpointUrl(url)); await custom.setModel(model);
    return custom.reasoning;
  };
  assert.deepEqual(await stepsFor('https://openrouter.ai/api/v1', 'deepseek/deepseek-r1:free'), [{reasoning: {effort: 'none'}}, {reasoning: {effort: 'low'}}]);
  assert.deepEqual(await stepsFor('http://localhost:11434/v1', 'qwen3:8b'), [{reasoning_effort: 'none'}, {reasoning_effort: 'low'}]);
  assert.deepEqual(await stepsFor('http://192.168.1.20:1234/v1', 'openai/gpt-oss-20b'), [{reasoning_effort: 'none'}, {reasoning_effort: 'low'}]);
  assert.deepEqual(await stepsFor('https://api.openai.com/v1', 'o3-mini'), [{reasoning_effort: 'low'}]);
  assert.equal(await stepsFor('https://api.openai.com/v1', 'gpt-4o'), undefined);
  assert.equal(await stepsFor('http://localhost:11434/v1', 'llama3.2'), undefined);
  // The same host name lookalikes get nothing special.
  assert.equal(await stepsFor('https://openrouter.ai.example.com/v1', 'llama3.2'), undefined);
});

test('the request carries the first step, only for a custom request, and an ordinary model is sent nothing', async () => {
  const mock = await startOpenAiMock();
  try {
    const cases = [[reasoningSteps({hostname: 'openrouter.ai', model: 'x'}), {reasoning: {effort: 'none'}}],
      [reasoningSteps({hostname: 'api.deepseek.com', model: 'deepseek-chat'}), {thinking: {type: 'disabled'}}],
      [reasoningSteps({hostname: 'localhost', local: true, model: 'qwen3:8b'}), {reasoning_effort: 'none'}],
      [reasoningSteps({hostname: 'api.openai.com', model: 'o3-mini'}), {reasoning_effort: 'low'}],
      [undefined, {}]];
    for (const [reasoning, fields] of cases) {
      mock.requests.length = 0;
      assert.equal((await streamChat({...via(mock), reasoning})).text, MOCK_REPLY);
      const {body} = mock.requests[0];
      assert.deepEqual(Object.fromEntries(REASONING_FIELDS.filter(name => name in body).map(name => [name, body[name]])), fields);
      assert.deepEqual([body.model, body.stream, body.max_tokens, body.temperature], ['test-model', true, 300, 0.8], 'nothing else changed');
    }
    // Mistral and the local AI never get the field (nor does their text lose a <think> block): both are handled exactly as before.
    for (const provider of ['mistral', 'local']) {
      mock.requests.length = 0;
      mock.behave(() => ({sse: ['<think>x</think>Hi']}));
      const result = await streamChat({...via(mock), provider, reasoning: [{reasoning_effort: 'low'}], adapt: newAdaptation()});
      assert.equal(result.text, '<think>x</think>Hi', provider);
      assert.deepEqual(asked(mock.requests[0]), [], provider);
    }
  } finally { await mock.close(); }
});

// ---- Reasoning in what the server sends -------------------------------------------------------------------------------------

test('a stream: the reasoning fields (reasoning, reasoning_content, reasoning_details) and <think> text, cut anywhere, never reach the reply', async () => {
  const mock = await startOpenAiMock();
  try {
    mock.behave(() => ({sse: [{role: 'assistant', reasoning: 'The user greets me. '}, {reasoning_content: 'I should answer.'}, {reasoning_details: [{type: 'reasoning.text', text: 'x'}]},
      'Sure, ', {content: 'V.'}], usage: {completion_tokens: 30, completion_tokens_details: {reasoning_tokens: 20}}}));
    const seen = [], soFar = [];
    const result = await streamChat({...via(mock), onDelta: (piece, text) => { seen.push(piece); soFar.push(text); }});
    assert.equal(result.text, 'Sure, V.');
    assert.deepEqual(seen, ['Sure, ', 'V.'], 'a delta with only reasoning is not a piece of the reply');
    assert.deepEqual(soFar, ['Sure, ', 'Sure, V.']);

    // The same for think tags in the text, cut in the middle of a tag.
    mock.behave(() => ({sse: ['<thi', 'nk>The user says hi. I should', ' answer in character.</th', 'ink>', '\n\nHello', ', V.']}));
    seen.length = 0;
    const tagged = await streamChat({...via(mock), onDelta: piece => seen.push(piece)});
    assert.equal(tagged.text.trim(), 'Hello, V.');
    assert.ok(seen.every(piece => !/[<>]|user says|answer in/.test(piece)), JSON.stringify(seen));

    // A reply cut off by shouldStop (the reply length cap) while a held-back "<" is pending still returns what was said.
    mock.behave(() => ({sse: ['One. ', 'Two. ', 'Three <']}));
    const stopped = await streamChat({...via(mock), shouldStop: text => text.includes('Two.')});
    assert.equal(stopped.text, 'One. Two. ');
    // A "<" that was not a tag is part of the reply.
    mock.behave(() => ({sse: ['5 ', '<', ' 6']}));
    assert.equal((await streamChat({...via(mock)})).text, '5 < 6');
    mock.behave(() => ({sse: ['I like <']}));
    assert.equal((await streamChat({...via(mock)})).text, 'I like <');
  } finally { await mock.close(); }
});

test('a reply that is not streamed: reasoning, reasoning_content and <think> text are dropped from it too', async () => {
  const mock = await startOpenAiMock();
  try {
    const answer = (message, extra = {}) => ({json: {id: 'm', model: 'm', choices: [{index: 0, message: {role: 'assistant', ...message}, finish_reason: extra.finish ?? 'stop'}], usage: extra.usage ?? {total_tokens: 9}}});
    for (const message of [{content: 'Hello, V.', reasoning: 'thinking first'}, {content: 'Hello, V.', reasoning_content: 'thinking first', reasoning_details: [{type: 'reasoning.text', text: 'x'}]},
      {content: '<think>thinking first</think>\n\nHello, V.'}, {content: [{type: 'thinking', thinking: [{type: 'text', text: 'x'}]}, {type: 'text', text: 'Hello, V.'}]}, {content: 'thinking first</think>Hello, V.'}]) {
      mock.behave(() => answer(message));
      const seen = [];
      const result = await streamChat({...via(mock), onDelta: piece => seen.push(piece)});
      assert.equal(result.text.trim(), 'Hello, V.', JSON.stringify(message));
      assert.equal(seen.join('').trim(), 'Hello, V.');
    }
  } finally { await mock.close(); }
});

// ---- A server that refuses the field ----------------------------------------------------------------------------------------

test('what a refusal says about the reasoning fields: it moves the request to the next step, and a refusal of something else does not', () => {
  const OPENROUTER = 'Reasoning is mandatory for this endpoint and cannot be disabled.';
  assert.deepEqual(rejectedParameters(400, OPENROUTER), {names: [], swap: false, reasoning: true});
  assert.deepEqual(rejectedParameters(400, "Unsupported parameter: 'reasoning_effort' is not supported with this model."), {names: [], swap: false, reasoning: true});
  assert.deepEqual(rejectedParameters(400, 'registry.ollama.ai/library/llama3.2:latest does not support thinking'), {names: [], swap: false, reasoning: true});
  assert.deepEqual(rejectedParameters(400, "Unsupported parameter: 'thinking'"), {names: [], swap: false, reasoning: true});
  assert.deepEqual(rejectedParameters(422, 'extra_forbidden: reasoning'), {names: [], swap: false, reasoning: true});
  assert.deepEqual(rejectedParameters(400, "Unsupported value: 'temperature' does not support 0.8. Unsupported parameter: reasoning.effort"), {names: ['temperature'], swap: false, reasoning: true});
  // A model whose id has the word in it is a model, not a field.
  assert.equal(rejectedParameters(400, 'The model `qwen3-235b-a22b-thinking-2507` does not exist'), null);
  assert.equal(rejectedParameters(400, 'Unknown model: deepseek/deepseek-r1:thinking'), null);
  // The old cases are unchanged: no extra key when it does not apply.
  assert.deepEqual(rejectedParameters(400, "Unsupported value: 'temperature' does not support 0.8 with this model."), {names: ['temperature'], swap: false});
  assert.deepEqual(rejectedParameters(400, 'Unsupported parameter in the request'), {names: [], swap: false});
  assert.equal(rejectedParameters(400, 'messages must not be empty'), null);
});

test('OpenRouter: a model that must reason refuses "none", so the request goes again with "low", for good; a refusal of that too drops the field', async () => {
  const mock = await startOpenAiMock();
  try {
    const steps = reasoningSteps({hostname: 'openrouter.ai', model: 'deepseek/deepseek-r1:free'});
    const mandatory = {status: 400, body: {error: {message: 'Reasoning is mandatory for this endpoint and cannot be disabled.', code: 400}}};
    mock.behave(request => request.body.reasoning?.effort === 'none' ? mandatory : null);
    const adapt = newAdaptation();
    const result = await streamChat({...via(mock, {model: 'deepseek/deepseek-r1:free'}), reasoning: steps, adapt, retries: 0});
    assert.equal(result.text, MOCK_REPLY);
    assert.equal(result.attempts, 2);
    assert.deepEqual(mock.requests.map(request => request.body.reasoning), [{effort: 'none'}, {effort: 'low'}]);
    assert.equal(adapt.reasoningStep, 1);
    assert.equal(adapt.dropped.size, 0, 'only the reasoning field moved on; nothing else was dropped');
    mock.requests.length = 0;
    await streamChat({...via(mock), reasoning: steps, adapt});
    assert.deepEqual(mock.requests.map(request => request.body.reasoning), [{effort: 'low'}], 'remembered for the session');

    // OpenRouter passes a provider's refusal on wrapped: "Provider returned error", the provider's words in error.metadata.raw.
    mock.requests.length = 0;
    mock.behave(request => 'reasoning' in request.body
      ? {status: 400, body: {error: {message: 'Provider returned error', code: 400, metadata: {raw: JSON.stringify({error: {message: 'Reasoning is mandatory for this endpoint and cannot be disabled.', code: 400}}), provider_name: 'Chutes'}}}} : null);
    const wrapped = newAdaptation();
    assert.equal((await streamChat({...via(mock), reasoning: steps, adapt: wrapped, retries: 0})).text, MOCK_REPLY);
    assert.deepEqual(mock.requests.map(request => 'reasoning' in request.body), [true, true, false], 'none, low, then neither');
    assert.equal(wrapped.reasoningStep, 2);
    // A refusal that comes again with no field in the request is an error, not a loop.
    mock.requests.length = 0;
    mock.behave(() => mandatory);
    await assert.rejects(streamChat({...via(mock), reasoning: steps, adapt: wrapped, retries: 0}), error => error.kind === 'request');
    assert.equal(mock.requests.length, 1);
  } finally { await mock.close(); }
});

test('an OpenAI-style server that has no such field is asked again without it; a server that names no field loses every optional one, this too', async () => {
  const mock = await startOpenAiMock();
  try {
    const steps = reasoningSteps({hostname: 'api.openai.com', model: 'gpt-5-chat-latest'});
    mock.behave(request => 'reasoning_effort' in request.body ? {status: 400, body: {error: {message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.", type: 'invalid_request_error', param: 'reasoning_effort'}}} : null);
    const adapt = newAdaptation();
    assert.equal((await streamChat({...via(mock), reasoning: steps, adapt, retries: 0})).text, MOCK_REPLY);
    assert.deepEqual(mock.requests.map(request => 'reasoning_effort' in request.body), [true, false]);
    mock.requests.length = 0;
    await streamChat({...via(mock), reasoning: steps, adapt});
    assert.deepEqual(mock.requests.map(request => 'reasoning_effort' in request.body), [false]);

    // Ollama: a model that cannot think, asked for "none" and then "low".
    const ollama = reasoningSteps({hostname: 'localhost', local: true, model: 'qwen3:8b'});
    mock.requests.length = 0;
    mock.behave(request => 'reasoning_effort' in request.body ? {status: 400, body: {error: {message: 'registry.ollama.ai/library/qwen3:8b does not support thinking', type: 'api_error'}}} : null);
    assert.equal((await streamChat({...via(mock), reasoning: ollama, adapt: newAdaptation(), retries: 0})).text, MOCK_REPLY);
    assert.deepEqual(mock.requests.map(request => request.body.reasoning_effort), ['none', 'low', undefined]);

    // Unsupported but not named: every optional field goes, and the reasoning field with them.
    mock.requests.length = 0;
    mock.behave(request => 'reasoning_effort' in request.body || 'temperature' in request.body ? {status: 422, body: {detail: 'Extra inputs are not permitted: unsupported parameter in request body'}} : null);
    await streamChat({...via(mock), reasoning: steps, adapt: newAdaptation(), retries: 0});
    assert.deepEqual(mock.requests.map(request => ['temperature' in request.body, 'reasoning_effort' in request.body]), [[true, true], [false, false]]);
  } finally { await mock.close(); }
});

// ---- A reply whose budget went to thinking -----------------------------------------------------------------------------------

const thoughtOnly = (extra = {}) => ({sse: [{reasoning: 'Let me think about how to answer this...'}], finish: 'length', usage: {completion_tokens: 300, completion_tokens_details: {reasoning_tokens: 300}}, ...extra});

test('a reply that came back empty because the model thought through its budget is asked once more with more room, and the room is kept for the session', async () => {
  const mock = await startOpenAiMock();
  try {
    mock.behave((request, index) => index === 0 ? thoughtOnly() : {sse: [{reasoning: 'ok. '}, 'Hello', ', V.']});
    const adapt = newAdaptation();
    const retried = [];
    const result = await streamChat({...via(mock, {model: 'deepseek/deepseek-r1:free'}), adapt, onRetry: info => retried.push(info), retries: 0});
    assert.equal(result.text, 'Hello, V.');
    assert.equal(result.attempts, 2);
    assert.deepEqual(mock.requests.map(request => request.body.max_tokens), [300, 1500]);
    assert.deepEqual(mock.requests.map(request => request.body.messages.at(-1).content), ['Hi.', 'Hi.'], 'no /no_think for a model that has no such switch');
    assert.equal(retried.length, 1);
    assert.equal(retried[0].error.reasoning, true);
    assert.equal(adapt.floorTokens, 1500);
    assert.equal(adapt.noThink, false);
    // The next turn starts with the larger room: no turn pays for the empty first try again.
    mock.requests.length = 0;
    mock.behave(() => null);
    await streamChat({...via(mock, {model: 'deepseek/deepseek-r1:free'}), adapt});
    assert.deepEqual(mock.requests.map(request => request.body.max_tokens), [1500]);
    // With the renamed field, the larger room is sent under the new name.
    mock.requests.length = 0;
    const renamed = newAdaptation(); renamed.swapped = true; renamed.floorTokens = 1500;
    await streamChat({...via(mock), adapt: renamed});
    assert.deepEqual(mock.requests.map(request => [request.body.max_tokens, request.body.max_completion_tokens]), [[undefined, 1500]]);
    // Without a remembered adaptation the retry still happens (the connection test calls it so).
    mock.requests.length = 0;
    mock.behave((request, index) => index === 0 ? thoughtOnly() : null);
    assert.equal((await streamChat({...via(mock), retries: 0})).text, MOCK_REPLY);
    assert.deepEqual(mock.requests.map(request => request.body.max_tokens), [300, 1500]);
  } finally { await mock.close(); }
});

test('Qwen3, which has a documented /no_think switch, gets it on the second try, and keeps it once it worked', async () => {
  const mock = await startOpenAiMock();
  try {
    mock.behave((request, index) => index === 0 ? thoughtOnly() : null);
    const adapt = newAdaptation();
    await streamChat({...via(mock, {model: 'qwen/qwen3-8b'}), adapt, retries: 0});
    assert.deepEqual(mock.requests.map(request => request.body.messages.at(-1).content), ['Hi.', 'Hi.\n/no_think']);
    assert.equal(adapt.noThink, true);
    assert.equal(mock.requests[1].body.messages[0].content, 'You are a test.', 'the system prompt is as it was');
    mock.requests.length = 0;
    mock.behave(() => null);
    await streamChat({...via(mock, {model: 'qwen/qwen3-8b'}), adapt});
    assert.deepEqual(mock.requests.map(request => request.body.messages.at(-1).content), ['Hi.\n/no_think']);
    // Another model with the same adaptation never gets it.
    mock.requests.length = 0;
    await streamChat({...via(mock, {model: 'llama3.2'}), adapt});
    assert.deepEqual(mock.requests.map(request => request.body.messages.at(-1).content), ['Hi.']);
  } finally { await mock.close(); }
});

test('empty again after more room: the error says the model thinks first (a notice of its own), after exactly two requests, whatever retries are left', async () => {
  const mock = await startOpenAiMock();
  try {
    mock.behave(() => thoughtOnly());
    await assert.rejects(streamChat({...via(mock), adapt: newAdaptation(), ...quick, retries: 3}), error => {
      assert.ok(error instanceof MistralError);
      assert.equal(error.kind, 'reasoning');
      assert.equal(failureKind(error), 'reasoning');
      assert.equal(errorCodeFor(error), 'custom-reasoning');
      assert.equal(error.provider, 'custom');
      assert.ok(!error.message.includes(KEY));
      assert.ok(Array.isArray(error.failed) && error.failed.length === 2);
      return true;
    });
    assert.equal(mock.requests.length, 2);
    // Not streamed: the same.
    mock.requests.length = 0;
    mock.behave(() => ({json: {id: 'm', model: 'm', choices: [{index: 0, message: {role: 'assistant', content: '', reasoning_content: 'thinking'}, finish_reason: 'length'}],
      usage: {completion_tokens: 300, completion_tokens_details: {reasoning_tokens: 300}}}}));
    await assert.rejects(streamChat({...via(mock), ...quick, retries: 3}), error => error.kind === 'reasoning');
    assert.equal(mock.requests.length, 2);
    // Content that is only an unfinished <think> block, and one that is only a closing tag after thoughts, count the same.
    for (const plan of [{sse: ['<think>I am thinking and never finish'], finish: 'length'}, {sse: ['reasoning that ran out</think>'], finish: 'length'}]) {
      mock.requests.length = 0;
      mock.behave(() => plan);
      await assert.rejects(streamChat({...via(mock), ...quick}), error => error.kind === 'reasoning', JSON.stringify(plan));
      assert.equal(mock.requests.length, 2, JSON.stringify(plan));
    }
    // Cancelled: no second request.
    mock.requests.length = 0;
    const controller = new AbortController();
    mock.behave(() => { setTimeout(() => controller.abort(), 0); return thoughtOnly(); });
    await assert.rejects(streamChat({...via(mock), signal: controller.signal, ...quick}), error => error.name === 'AbortError' || /cancel/i.test(error.message));
    assert.equal(mock.requests.length, 1);
  } finally { await mock.close(); }
});

test('the one-word action decision is not given room to think: one request, the floor is not applied, and the failure is just "no action"', async () => {
  const mock = await startOpenAiMock();
  try {
    mock.behave(() => thoughtOnly());
    const adapt = newAdaptation(); adapt.floorTokens = 1500;
    await assert.rejects(streamChat({...via(mock), adapt, maxTokens: 12, thinkingRoom: false, retries: 0}), error => error.kind === 'empty' && error.reasoning === true && errorCodeFor(error) === undefined);
    assert.deepEqual(mock.requests.map(request => request.body.max_tokens), [12], 'asked once, with the budget it was given');
    // The same call with room (a reply, a summary, the connection test) is asked again with more.
    mock.requests.length = 0;
    await assert.rejects(streamChat({...via(mock), adapt, maxTokens: 12, retries: 0}), error => error.kind === 'reasoning');
    assert.deepEqual(mock.requests.map(request => request.body.max_tokens), [1500, 4096], 'the remembered floor, then the most it ever asks for');
  } finally { await mock.close(); }
});

test('an empty reply that was not the budget is only empty: asked again as before, with the same room, and no notice about thinking', async () => {
  const mock = await startOpenAiMock();
  try {
    // Nothing thought and the model stopped on its own: the ordinary retry of an empty answer.
    mock.behave((request, index) => index === 0 ? {sse: [''], finish: 'stop'} : null);
    const result = await streamChat({...via(mock), ...quick});
    assert.equal(result.text, MOCK_REPLY);
    assert.deepEqual(mock.requests.map(request => request.body.max_tokens), [300, 300]);
    // It thought and then said nothing, with a normal stop: still only empty.
    mock.requests.length = 0;
    mock.behave(() => ({sse: [{reasoning: 'hmm'}], finish: 'stop'}));
    await assert.rejects(streamChat({...via(mock), ...quick}), error => error.kind === 'empty' && !error.reasoning && errorCodeFor(error) === undefined);
    assert.equal(mock.requests.length, 2);
    // Mistral and the local AI: an empty answer is what it was, one retry, no larger room.
    for (const provider of ['mistral', 'local']) {
      mock.requests.length = 0;
      mock.behave(() => ({sse: [{reasoning: 'hmm'}], finish: 'length'}));
      await assert.rejects(streamChat({...via(mock), provider, ...quick, retries: 0}), error => error.kind === 'empty' && !error.reasoning, provider);
      assert.deepEqual(mock.requests.map(request => request.body.max_tokens), [300], provider);
    }
  } finally { await mock.close(); }
});

test('a whole turn: a reasoning model is asked for no reasoning, answers on the second try with more room, and says only its answer; the notice names the kind of model', async () => {
  const mock = await startOpenAiMock();
  const {host, provider, route, logs} = await harness(mock, {model: 'deepseek/deepseek-r1:free'});
  try {
    mock.behave((request, index) => index === 0 ? thoughtOnly() : {sse: [{reasoning: 'ok. '}, '<think>again</think>', 'Sure, V. ', 'What do you need?']});
    const result = await host.reply(turn('Hey Judy, can you help?'));
    assert.equal(result.text, 'Sure, V. What do you need?');
    assert.deepEqual(mock.requests.map(request => [request.body.reasoning_effort, request.body.max_tokens]), [['none', 600], ['none', 3000]],
      'a model on this computer that looks like a reasoning model is asked for none');
    assert.equal(provider.limit, null);
    assert.ok(logs.some(line => /attempt 1 failed/.test(line)), 'the retry is in the log');

    // It never answers: the turn fails with the error that has its own notice, and says nothing in the character's voice.
    mock.requests.length = 0;
    mock.behave(() => thoughtOnly());
    await assert.rejects(host.reply(turn('Hello?')), error => errorCodeFor(error) === 'custom-reasoning');
    assert.equal(mock.requests.length, 2);
    assert.equal(route.summarizeAllowed(), true, 'this is not a limit: summaries are not stopped');
  } finally { host.close(); await mock.close(); }
});

test('an ordinary model is sent exactly what it was before: no reasoning field, no /no_think and the usual reply budget in a whole turn', async () => {
  const mock = await startOpenAiMock();
  const {host} = await harness(mock);
  try {
    mock.behave(() => ({sse: ['Sure, V.']}));
    await host.reply(turn('Hello?'));
    assert.deepEqual(asked(mock.requests[0]), []);
    assert.equal(mock.requests[0].body.max_tokens, 600, 'the reply budget of the host');
    assert.equal(mock.requests[0].body.messages.at(-1).content.includes('/no_think'), false);
  } finally { host.close(); await mock.close(); }
});

test('the connection test sends the same field, and a model that thinks through the larger room says so', async () => {
  const mock = await startOpenAiMock();
  try {
    const custom = new CustomEndpoint({path: null});
    await custom.setUrl(parseEndpointUrl(mock.url)); await custom.setModel('deepseek/deepseek-r1:free');
    mock.behave(() => null);
    assert.equal((await testConnection(custom)).state, 'ok');
    assert.equal(mock.requests[0].body.reasoning_effort, 'none');
    mock.requests.length = 0;
    mock.behave(() => thoughtOnly());
    const failed = await testConnection(custom);
    assert.deepEqual([failed.state, failed.code], ['failed', 'reasoning']);
    assert.equal(mock.requests.length, 2);
  } finally { await mock.close(); }
});

// ---- OpenRouter's free-model daily limit -------------------------------------------------------------------------------------

const NOW = Date.UTC(2026, 9, 19, 9, 0, 0);
const MIDNIGHT = Date.UTC(2026, 9, 20, 0, 0, 0);
// The body OpenRouter documents for the daily cap of its free models (https://openrouter.ai/docs/api-reference/limits; the message and metadata as it has been seen in the wild).
const dailyBody = (reset = MIDNIGHT) => ({error: {message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', code: 429,
  metadata: {headers: {'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(reset)}, provider_name: null}}});
const headersOf = object => new Headers(object);

test('the daily limit of a free model is its own kind, found from the body or the headers, with the reset time when the server gave one', () => {
  // The body alone (OpenRouter puts the headers in error.metadata.headers as well): the message and the reset in milliseconds.
  let error = mapFailure(429, dailyBody(), {provider: 'custom', now: NOW});
  assert.deepEqual([error.kind, error.daily, error.resetAt, error.status], ['daily', true, MIDNIGHT, 429]);
  assert.equal(errorCodeFor(error), 'custom-daily');
  assert.equal(failureKind(error), 'daily');
  assert.match(error.message, /^The custom provider reached its daily limit \[custom:daily\]$/);
  assert.notEqual(failureKind(mapFailure(429, dailyBody(), {provider: 'custom', now: NOW})), 'credits', '"Add 10 credits to unlock" is not "out of credits"');
  // The response headers alone, in every unit a server may use: milliseconds, seconds since 1970, seconds from now, an HTTP date.
  const body = {error: {message: 'Rate limit exceeded: free-models-per-day'}};
  for (const reset of [String(MIDNIGHT), String(MIDNIGHT / 1000), String((MIDNIGHT - NOW) / 1000), new Date(MIDNIGHT).toUTCString()]) {
    error = mapFailure(429, body, {provider: 'custom', now: NOW, headers: headersOf({'x-ratelimit-reset': reset, 'x-ratelimit-remaining': '0'})});
    assert.deepEqual([error.kind, error.resetAt], ['daily', MIDNIGHT], reset);
  }
  // A time that is in the past, more than two days away or unreadable is "not given": the notice still comes, without a time.
  for (const reset of ['1700000000000', String(NOW + 3 * 86_400_000), 'soon', '', '-5']) {
    error = mapFailure(429, body, {provider: 'custom', now: NOW, headers: headersOf({'x-ratelimit-reset': reset})});
    assert.deepEqual([error.kind, error.resetAt], ['daily', undefined], reset);
  }
  // Without the words of the message: the headers say it (nothing left, and the reset hours away), or a long Retry-After with "per day" words.
  error = mapFailure(429, {error: {message: 'Rate limit exceeded'}}, {provider: 'custom', now: NOW, headers: headersOf({'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(MIDNIGHT)})});
  assert.deepEqual([error.kind, error.resetAt], ['daily', MIDNIGHT]);
  error = mapFailure(429, {error: {message: 'Quota exceeded: requests per day'}}, {provider: 'custom', now: NOW, headers: headersOf({'retry-after': String(5 * 3600)})});
  assert.deepEqual([error.kind, error.resetAt], ['daily', NOW + 5 * 3600_000]);
  for (const message of ['Quota exceeded for GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'Rate limit reached for model on tokens per day (TPD): Limit 100000', 'Daily request limit reached']) {
    assert.equal(mapFailure(429, {error: {message}}, {provider: 'custom', now: NOW}).kind, 'daily', message);
  }
  // A limit that clears in a moment is still a limit: the per-minute cap (20 a minute on free models) with its reset a few seconds away, and an upstream provider's.
  for (const [message, headers] of [['Rate limit exceeded', {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW + 30_000)}],
    ['Rate limit exceeded: free-models-per-min', {'x-ratelimit-limit': '20', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW + 40_000)}],
    ['deepseek/deepseek-r1:free is temporarily rate-limited upstream', {'retry-after': '20'}], ['slow down', {}]]) {
    error = mapFailure(429, {error: {message}}, {provider: 'custom', now: NOW, headers: headersOf(headers)});
    assert.deepEqual([error.kind, error.daily ?? false, error.resetAt], ['limit', false, undefined], message);
  }
  // OpenRouter's wrapping of a provider's own 429.
  error = mapFailure(429, {error: {message: 'Provider returned error', code: 429, metadata: {raw: JSON.stringify({error: {message: 'Daily quota exceeded for this key'}}), provider_name: 'Google'}}}, {provider: 'custom', now: NOW});
  assert.equal(error.kind, 'daily');
  // Mistral's mapping is untouched: the same words are a plain limit there, and there is no such notice code.
  const mistral = mapFailure(429, {message: 'Rate limit exceeded: free-models-per-day'}, {provider: 'mistral'});
  assert.deepEqual([mistral.kind, errorCodeFor(mistral), mistral.resetAt], ['limit', 'mistral-limit', undefined]);
});

test('the reset time is told as a clock time on this computer, or not at all', () => {
  const at = Date.now() + 5 * 3600_000 + 7 * 60_000;
  const date = new Date(at);
  assert.equal(resetClock(at), `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`);
  assert.match(resetClock(at), /^\d\d:\d\d$/);
  for (const none of [undefined, NaN, null, Date.now() - 1000, Date.now() + 30 * 3600_000]) assert.equal(resetClock(none), undefined, String(none));
  assert.deepEqual(errorExtrasFor(Object.assign(new MistralError('daily', 'x', {provider: 'custom'}), {resetAt: at})), {errorResetTime: resetClock(at)});
  assert.deepEqual(errorExtrasFor(new MistralError('daily', 'x', {provider: 'custom'})), {}, 'no time given');
  assert.deepEqual(errorExtrasFor(new MistralError('limit', 'x', {provider: 'custom', resetAt: at})), {});
  assert.deepEqual(errorExtrasFor(new Error('x')), {});
  const described = describeFailure(new MistralError('daily', 'reached its daily limit', {provider: 'custom', status: 429, resetAt: at}));
  assert.deepEqual([described.code, described.status, described.resetTime], ['daily', 429, resetClock(at)]);
  const noTime = describeFailure(new MistralError('daily', 'x', {provider: 'custom', status: 429}));
  assert.deepEqual([noTime.code, noTime.status, 'resetTime' in noTime], ['daily', 429, false]);
  assert.equal(describeFailure(new MistralError('reasoning', 'spends its reply on thinking', {provider: 'custom'})).code, 'reasoning');
});

test('on the wire: a daily 429 is not retried, not waited for, and carries its reset', async () => {
  const mock = await startOpenAiMock();
  try {
    const reset = Date.now() + 6 * 3600_000;
    mock.behave(() => ({status: 429, body: dailyBody(reset)}));
    const waits = [];
    await assert.rejects(streamChat({...via(mock), ...quick, retries: 3, sleepImpl: async ms => { waits.push(ms); }}), error => {
      assert.equal(error.kind, 'daily');
      assert.equal(error.resetAt, reset);
      assert.equal(errorCodeFor(error), 'custom-daily');
      assert.ok(!error.message.includes(KEY));
      assert.match(error.providerText, /free-models-per-day/);
      return true;
    });
    assert.deepEqual([mock.requests.length, waits.length], [1, 0]);
    // The same through the headers of the response, as OpenRouter documents for a platform limit.
    mock.requests.length = 0;
    mock.behave(() => ({status: 429, headers: {'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset)}, body: {error: {message: 'Rate limit exceeded: free-models-per-day'}}}));
    await assert.rejects(streamChat({...via(mock), ...quick, retries: 3}), error => error.kind === 'daily' && error.resetAt === reset);
    assert.equal(mock.requests.length, 1);
    // A per-minute limit is still waited out and retried.
    mock.requests.length = 0;
    let calls = 0;
    mock.behave(() => ++calls === 1 ? {status: 429, headers: {'retry-after': '2', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.now() + 2000)}, body: {error: {message: 'Rate limit exceeded: free-models-per-min'}}} : null);
    waits.length = 0;
    assert.equal((await streamChat({...via(mock), ...quick, sleepImpl: async ms => { waits.push(ms); }})).text, MOCK_REPLY);
    assert.deepEqual([mock.requests.length, waits], [2, [2000]]);
  } finally { await mock.close(); }
});

test('a whole turn: the daily limit stops the turn with its notice and its reset, is recorded for the settings page, and stops background requests until a reply works', async () => {
  const mock = await startOpenAiMock();
  const {host, provider, route} = await harness(mock);
  try {
    const reset = Date.now() + 4 * 3600_000;
    mock.behave(() => ({status: 429, body: dailyBody(reset)}));
    await assert.rejects(host.reply(turn('hello')), error => {
      assert.equal(errorCodeFor(error), 'custom-daily');
      assert.deepEqual(errorExtrasFor(error), {errorResetTime: resetClock(reset)});
      return true;
    });
    assert.equal(mock.requests.length, 1, 'not retried');
    assert.equal(provider.limit?.kind, 'daily');
    assert.equal(route.summarizeAllowed(), false, 'no background request goes to an endpoint that has no allowance left');
    // The next turn asks again once (the player may have added credits, or the day may have turned); a good answer clears it.
    mock.behave(() => null);
    assert.equal((await host.reply(turn('hello again'))).text, MOCK_REPLY);
    assert.equal(provider.limit, null);
    assert.equal(route.summarizeAllowed(), true);
  } finally { host.close(); await mock.close(); }
});

// ---- the host harness (as bridge/custom-provider.test.mjs builds it) -----------------------------------------------------------

async function harness(mock, {model = 'vendor/test-model:free', now} = {}) {
  const custom = new CustomEndpoint({path: null});
  await custom.setUrl(parseEndpointUrl(mock.url)); await custom.setModel(model);
  await custom.setKey(KEY);
  const provider = new MistralProvider({keyPath: 'k', readText: async () => { throw Error('none'); }, writeText: async () => {}, custom});
  await provider.load();
  provider.setPreference('custom'); provider.apply();
  const memory = await MistralMemory.open({path: null});
  const logs = [];
  const route = customRoute({provider, custom, now, chat: options => streamChat({...options, ...quick})});
  const matureContent = new MatureContent(); matureContent.setPack(true); matureContent.update({matureContent: false});
  const host = new TextProviderHost({provider, memory, personas: new PersonaBook(roster), routes: {custom: route}, log: line => logs.push(line), matureContent});
  return {custom, provider, memory, route, host, logs};
}
function turn(text, extra = {}) {
  return {text, context: 'CURRENT PERSON\nQuest facts here.', sessionId: 'session-1', local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}, ...extra};
}
