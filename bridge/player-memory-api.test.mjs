import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlayerMemoryApi, PlayerMemoryApiError} from './player-memory-api.mjs';

const ids = {judy: 'mod-judy', panam: 'mod-panam'};
const pair = {profileKey: 'judy', characterId: ids.judy, endUserId: '12e8c51a-bcde-4567-8123-123456789abc'};
const detail = (enabled = false) => ({character_id: ids.judy, character_name: 'Judy',
  backstory: 'A fictional character.\n[CyberpunkConvai profile v2:judy]\n', voice_type: 'original-voice',
  speaking_style_description: 'Original style.',
  speaking_style: {description: 'Original nested style.', sample_dialogues: 'Original spoken example.'},
  personalised_prompt_config: {MODEL: 'original-model'},
  memory_settings: {enabled, time_to_live: 30, user_facts: true, ltm_min_credit_cost_e8: 1}});
const empty = {memories: [], total_count: 0, page: 1, page_size: 1, has_more: false};
const nonempty = {memories: [{id: 'private-memory', memory: 'private conversation text'}], total_count: 2,
  page: 1, page_size: 1, has_more: true};
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {status,
  headers: {'Content-Type': 'application/json', ...headers}});
function fake(respond, options = {}) {
  const calls = [];
  const api = new PlayerMemoryApi({key: 'credential-secret', characterIds: ids, pollIntervalMs: 0,
    fetchImpl: async (url, init) => {
      const call = {endpoint: url.slice('https://api.convai.com'.length), ...init, body: JSON.parse(init.body)};
      calls.push(call); return respond(call, calls);
    }, ...options});
  return {api, calls};
}
function standard(call) {
  if (call.endpoint === '/character/list') return json({characters: [{character_id: ids.judy}]});
  if (call.endpoint === '/character/get') return json(detail(true));
  if (call.endpoint === '/memory/delete-all') return json({message: 'Deletion scheduled',
    character_id: pair.characterId, end_user_id: pair.endUserId});
  if (call.endpoint === '/memory/list') return json(empty);
  return json({STATUS: 'SUCCESS'});
}
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Expected wire operation missing'); await new Promise(resolve => setTimeout(resolve, 2)); }
}

test('construction, disabled credentials and empty mappings are local-only and secrets stay private', () => {
  const {api, calls} = fake(standard);
  assert.equal(calls.length, 0); assert.equal(JSON.stringify(api), '{}');
  const disabled = new PlayerMemoryApi({characterIds: {}, fetchImpl: () => { throw Error('Network must remain closed'); }});
  assert.throws(() => disabled.enableMemory(pair), {code: 'DISABLED'});
  assert.equal(calls.length, 0);
});

test('actual enable uses authenticated ownership, minimal camelCase update and strict root readback', async () => {
  let gets = 0;
  const {api, calls} = fake(call => call.endpoint === '/character/get' ? json(detail(++gets > 1)) : standard(call));
  assert.deepEqual(await api.enableMemory(pair), {enabled: true, changed: true});
  assert.deepEqual(calls.map(row => row.endpoint), ['/character/list', '/character/get', '/character/update', '/character/get']);
  assert.deepEqual(calls[0].body, {}); assert.deepEqual(calls[1].body, {charID: ids.judy});
  assert.deepEqual(calls[2].body, {charID: ids.judy, memorySettings: {enabled: true}});
  for (const call of calls) {
    assert.equal(call.method, 'POST'); assert.equal(call.headers['CONVAI-API-KEY'], 'credential-secret');
    assert.equal(call.headers['Content-Type'], 'application/json'); assert.equal(call.signal instanceof AbortSignal, true);
    assert.ok(!JSON.stringify(call.body).includes(pair.endUserId));
  }
});

test('already enabled natural memory is verified without an update', async () => {
  const {api, calls} = fake(standard);
  assert.deepEqual(await api.enableMemory(pair), {enabled: true, changed: false});
  assert.deepEqual(calls.map(row => row.endpoint), ['/character/list', '/character/get']);
});

test('unmapped IDs, remapped profiles, duplicate aliases and invalid UUIDs cannot dispatch', () => {
  const {api, calls} = fake(standard);
  for (const options of [{...pair, characterId: ids.panam}, {...pair, profileKey: 'missing'}, {...pair, endUserId: 'arbitrary-user'}]) {
    assert.throws(() => api.enableMemory(options));
  }
  const duplicate = fake(standard, {characterIds: {judy: ids.judy, another: ids.judy}});
  assert.throws(() => duplicate.api.clearMemory(pair), {code: 'CHARACTER_MISMATCH'});
  assert.equal(calls.length, 0); assert.equal(duplicate.calls.length, 0);
});

test('public profiles, duplicate roster IDs, foreign/substring/ambiguous markers and wrong returned identity cannot mutate', async () => {
  const variations = [
    {roster: []}, {roster: [{character_id: ids.judy}, {character_id: ids.judy}]},
    {profile: {...detail(), character_id: ids.panam}},
    {profile: {...detail(), backstory: 'Prefix [CyberpunkConvai profile v2:judy] suffix'}},
    {profile: {...detail(), backstory: '[CyberpunkConvai profile v2:panam]'}},
    {profile: {...detail(), backstory: '[CyberpunkConvai profile v2:judy]\n[CyberpunkConvai profile v2:panam]'}}
  ];
  for (const variation of variations) {
    const {api, calls} = fake(call => call.endpoint === '/character/list'
      ? json({characters: variation.roster ?? [{character_id: ids.judy}]})
      : call.endpoint === '/character/get' ? json(variation.profile ?? detail()) : standard(call));
    await assert.rejects(api.enableMemory(pair), error => {
      assert.equal(error.writeUncertain, false); assert.ok(['NOT_MOD_OWNED', 'CHARACTER_MISMATCH'].includes(error.code)); return true;
    });
    assert.ok(calls.every(call => call.endpoint !== '/character/update'));
    await assert.rejects(api.clearMemory(pair));
    assert.ok(calls.every(call => call.endpoint !== '/memory/delete-all'));
  }
});

test('missing/malformed memory settings and provider error envelopes are not enablement', async () => {
  for (const profile of [{...detail(), memory_settings: undefined}, {...detail(), memory_settings: {enabled: 'false'}},
    {...detail(), ERROR: 'credential-secret'}, JSON.stringify({character: detail()})]) {
    const {api, calls} = fake(call => call.endpoint === '/character/get' ? json(profile) : standard(call));
    await assert.rejects(api.enableMemory(pair), error => { assert.equal(error.writeUncertain, false); return true; });
    assert.ok(calls.every(call => call.endpoint !== '/character/update'));
  }
});

test('toggle verifies preserved memory/profile configuration, allowing server cost estimate changes only', async () => {
  let gets = 0;
  const good = fake(call => {
    if (call.endpoint !== '/character/get') return standard(call);
    const row = detail(++gets > 1); if (gets > 1) row.memory_settings.ltm_min_credit_cost_e8 = 900;
    return json(row);
  });
  assert.equal((await good.api.enableMemory(pair)).changed, true);
  for (const change of [row => { row.memory_settings.user_facts = false; }, row => { row.voice_type = 'other-voice'; },
    row => { row.personalised_prompt_config.MODEL = 'other-model'; }, row => { delete row.memory_settings.time_to_live; },
    row => { row.speaking_style.description = 'Replaced style'; },
    row => { row.speaking_style.sample_dialogues = 'Replaced examples'; }]) {
    let reads = 0;
    const {api, calls} = fake(call => {
      if (call.endpoint !== '/character/get') return standard(call);
      const row = detail(++reads > 1); if (reads > 1) change(row); return json(row);
    });
    await assert.rejects(api.enableMemory(pair), {code: 'CONFIGURATION_DRIFT', writeUncertain: true});
    assert.equal(calls.filter(call => call.endpoint === '/character/update').length, 1);
  }
});

test('bad update ack/readback never admits a conversation and remains an uncertain write', async () => {
  for (const ack of [{STATUS: 'FAILURE'}, {STATUS: 'SUCCESS', ERROR: 'private body'}]) {
    const {api} = fake(call => call.endpoint === '/character/get' ? json(detail())
      : call.endpoint === '/character/update' ? json(ack) : standard(call));
    await assert.rejects(api.enableMemory(pair), error => { assert.equal(error.writeUncertain, true); return true; });
  }
  const unchanged = fake(call => call.endpoint === '/character/get' ? json(detail(false)) : standard(call));
  await assert.rejects(unchanged.api.enableMemory(pair), {code: 'ENABLE_UNVERIFIED', writeUncertain: true});
});

test('clear sends exactly one exact-pair deletion and capped list polls observe asynchronous completion', async () => {
  let polls = 0;
  const {api, calls} = fake(call => call.endpoint === '/memory/list' ? json(++polls < 3 ? nonempty : empty) : standard(call));
  assert.deepEqual(await api.clearMemory(pair), {accepted: true, providerEmptyObserved: true});
  const deletion = calls.filter(call => call.endpoint === '/memory/delete-all');
  assert.equal(deletion.length, 1); assert.deepEqual(deletion[0].body, {character_id: pair.characterId, end_user_id: pair.endUserId});
  for (const call of calls.filter(call => call.endpoint === '/memory/list')) assert.deepEqual(call.body,
    {character_id: pair.characterId, end_user_id: pair.endUserId, page: 1, page_size: 1});
  assert.equal(polls, 3); assert.ok(calls.every(call => !call.endpoint.endsWith('/add')));
});

test('accepted-but-nonempty clear never pretends completion and destructive request is never retried', async () => {
  const {api, calls} = fake(call => call.endpoint === '/memory/list' ? json(nonempty) : standard(call), {maxClearPolls: 2});
  assert.deepEqual(await api.clearMemory(pair), {accepted: true, providerEmptyObserved: false});
  assert.equal(calls.filter(row => row.endpoint === '/memory/delete-all').length, 1);
  assert.equal(calls.filter(row => row.endpoint === '/memory/list').length, 2);
});

test('clear identity echo mismatch and contradictory/404/error-envelope list results stay uncertain', async () => {
  const lists = [{...empty, memories: [{}]}, {...empty, total_count: -1}, {...empty, has_more: true},
    {...empty, page: 2}, {...empty, page_size: 2}, {...empty, ERROR: 'private memory body'}, {...nonempty, total_count: 0}];
  for (const value of lists) {
    const {api} = fake(call => call.endpoint === '/memory/list' ? json(value) : standard(call));
    await assert.rejects(api.clearMemory(pair), error => {
      assert.equal(error.writeUncertain, true); assert.ok(!error.message.includes('private')); return true;
    });
  }
  const missing = fake(call => call.endpoint === '/memory/list' ? json({message: 'missing'}, 404) : standard(call));
  await assert.rejects(missing.api.clearMemory(pair), {code: 'HTTP_ERROR', writeUncertain: true});
  const mismatch = fake(call => call.endpoint === '/memory/delete-all' ? json({message: 'scheduled', end_user_id: 'foreign-user'}) : standard(call));
  await assert.rejects(mismatch.api.clearMemory(pair), {code: 'CLEAR_UNVERIFIED', writeUncertain: true});
  assert.equal(mismatch.calls.filter(row => row.endpoint === '/memory/list').length, 0);
});

test('HTTP rejections preserve known certainty while 5xx, transport failure and untrusted success are uncertain', async () => {
  for (const status of [400, 401, 403, 404, 429, 408, 500, 503]) {
    const {api, calls} = fake(call => call.endpoint === '/memory/delete-all' ? json({ERROR: 'credential-secret'}, status) : standard(call));
    await assert.rejects(api.clearMemory(pair), error => {
      assert.equal(error.writeUncertain, status >= 500 || status === 408); assert.equal(error.status, status);
      assert.ok(!error.message.includes('credential')); return true;
    });
    assert.equal(calls.filter(row => row.endpoint === '/memory/delete-all').length, 1);
  }
  const network = fake(call => { if (call.endpoint === '/memory/delete-all') throw Error('secret network detail'); return standard(call); });
  await assert.rejects(network.api.clearMemory(pair), {code: 'NETWORK_ERROR', writeUncertain: true});
});

test('whole operation deadline bounds transports that ignore cancellation and tracks whether mutation began', async () => {
  const initial = fake(() => new Promise(() => {}), {timeoutMs: 20});
  await assert.rejects(initial.api.clearMemory(pair), {code: 'TIMEOUT', writeUncertain: false});
  assert.equal(initial.calls.length, 1);
  const writing = fake(call => call.endpoint === '/memory/delete-all' ? new Promise(() => {}) : standard(call), {timeoutMs: 20});
  await assert.rejects(writing.api.clearMemory(pair), {code: 'TIMEOUT', writeUncertain: true});
  assert.equal(writing.calls.filter(row => row.endpoint === '/memory/delete-all').length, 1);
});

test('pre-abort sends nothing; abort after destructive dispatch is uncertain and cannot later report success', async () => {
  const signal = new AbortController(); signal.abort();
  const pre = fake(standard);
  await assert.rejects(pre.api.clearMemory({...pair, signal: signal.signal}), {code: 'CANCELLED', writeUncertain: false});
  assert.equal(pre.calls.length, 0);
  const during = new AbortController(); let resolveLate;
  const writing = fake(call => call.endpoint === '/memory/delete-all' ? new Promise(resolve => { resolveLate = resolve; }) : standard(call));
  const operation = writing.api.clearMemory({...pair, signal: during.signal}); operation.catch(() => {});
  await until(() => writing.calls.some(row => row.endpoint === '/memory/delete-all'));
  during.abort(); await assert.rejects(operation, {code: 'CANCELLED', writeUncertain: true});
  resolveLate(json({message: 'late completion'}));
  assert.equal(writing.calls.filter(row => row.endpoint === '/memory/list').length, 0);
});

test('body timeout and byte limits fail without echoing provider data', async () => {
  const stream = new ReadableStream({pull: () => new Promise(() => {}), cancel: () => new Promise(() => {})});
  const hanging = fake(() => new Response(stream), {timeoutMs: 20});
  await assert.rejects(hanging.api.enableMemory(pair), {code: 'TIMEOUT', writeUncertain: false});
  const huge = fake(() => json({characters: [{character_id: ids.judy, backstory: 'secret'.repeat(1000)}]}), {maxResponseBytes: 128});
  await assert.rejects(huge.api.enableMemory(pair), error => {
    assert.ok(error instanceof PlayerMemoryApiError); assert.equal(error.code, 'RESPONSE_TOO_LARGE');
    assert.ok(!error.message.includes('secret')); assert.ok(!error.message.includes(pair.endUserId)); return true;
  });
});

test('explicit inspection is ownership-verified list-only and never invents deletion acceptance', async () => {
  const {api, calls} = fake(standard);
  assert.deepEqual(await api.inspectMemory(pair), {providerEmptyObserved: true});
  assert.deepEqual(calls.map(row => row.endpoint), ['/character/list', '/character/get', '/memory/list']);
});
