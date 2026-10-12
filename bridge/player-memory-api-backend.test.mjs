import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlayerMemoryApi, PlayerMemoryApiError} from './player-memory-api.mjs';

// Backend mode: the shared account is reached with a sign-in backend token. The key-only calls (character list, character read,
// character update) must not happen from a player's machine; the two memory calls use the API-AUTH-TOKEN header.
const ids = {judy: 'mod-judy', panam: 'mod-panam'};
const pair = {profileKey: 'judy', characterId: ids.judy, endUserId: '12e8c51a-bcde-4567-8123-123456789abc'};
const empty = {memories: [], total_count: 0, page: 1, page_size: 1, has_more: false};
const json = body => new Response(JSON.stringify(body), {status: 200, headers: {'Content-Type': 'application/json'}});
function fake({credential, backend = true, own = false} = {}) {
  const calls = [];
  const api = new PlayerMemoryApi({key: 'embedded-fixture-key-00000000', characterIds: ids, pollIntervalMs: 0, credential,
    fetchImpl: async (url, init) => {
      const endpoint = url.slice('https://api.convai.com'.length);
      calls.push({endpoint, headers: init.headers, body: JSON.parse(init.body)});
      if (endpoint === '/memory/delete-all') return json({message: 'Deletion scheduled', character_id: pair.characterId, end_user_id: pair.endUserId});
      if (endpoint === '/memory/list') return json(empty);
      return json({STATUS: 'SUCCESS'});
    }});
  api.use({key: 'embedded-fixture-key-00000000', own, backend});
  return {api, calls};
}

test('clearing in backend mode checks ownership from the shipped id list, calls only the two memory endpoints, and sends the token', async () => {
  const {api, calls} = fake({credential: async () => ({authToken: 'fixture-token-not-a-secret'})});
  assert.equal(api.backend, true);
  assert.deepEqual(await api.clearMemory(pair), {accepted: true, providerEmptyObserved: true});
  assert.deepEqual(calls.map(call => call.endpoint), ['/memory/delete-all', '/memory/list']);
  for (const call of calls) {
    assert.equal(call.headers['API-AUTH-TOKEN'], 'fixture-token-not-a-secret');
    assert.equal('CONVAI-API-KEY' in call.headers, false, 'no key header when a token is used');
  }
  assert.deepEqual(calls[0].body, {character_id: ids.judy, end_user_id: pair.endUserId});
});

test('inspecting in backend mode makes one memory call', async () => {
  const {api, calls} = fake({credential: async () => ({authToken: 'fixture-token-not-a-secret'})});
  assert.deepEqual(await api.inspectMemory(pair), {providerEmptyObserved: true});
  assert.deepEqual(calls.map(call => call.endpoint), ['/memory/list']);
});

test('enabling memory is a provisioning step in backend mode: it makes no call at all', async () => {
  const {api, calls} = fake({credential: async () => ({authToken: 't'})});
  assert.deepEqual(await api.enableMemory(pair), {enabled: true, changed: false});
  assert.equal(calls.length, 0);
});

test('an id that is not the shipped one for the profile is still refused in backend mode', async () => {
  const {api, calls} = fake({credential: async () => ({authToken: 't'})});
  assert.throws(() => api.clearMemory({...pair, characterId: 'someone-elses-character'}), error => error instanceof PlayerMemoryApiError && error.code === 'CHARACTER_MISMATCH');
  assert.throws(() => api.clearMemory({...pair, profileKey: 'panam'}), {code: 'CHARACTER_MISMATCH'});
  assert.equal(calls.length, 0);
});

test('when the bridge falls back to the embedded key the header is the key header, and the key-only calls still stay off', async () => {
  const {api, calls} = fake({credential: async () => ({apiKey: 'embedded-fixture-key-00000000'})});
  await api.clearMemory(pair);
  assert.deepEqual(calls.map(call => call.endpoint), ['/memory/delete-all', '/memory/list']);
  assert.equal(calls[0].headers['CONVAI-API-KEY'], 'embedded-fixture-key-00000000');
  assert.equal('API-AUTH-TOKEN' in calls[0].headers, false);
});

test('without backend mode nothing changed: ownership and enabling use the key calls as before', async () => {
  const calls = [];
  const api = new PlayerMemoryApi({key: 'embedded-fixture-key-00000000', characterIds: ids, pollIntervalMs: 0,
    fetchImpl: async (url, init) => {
      const endpoint = url.slice('https://api.convai.com'.length);
      calls.push({endpoint, headers: init.headers});
      if (endpoint === '/character/list') return json({characters: [{character_id: ids.judy}]});
      if (endpoint === '/character/get') return json({character_id: ids.judy, backstory: '[CyberpunkConvai profile v2:judy]',
        memory_settings: {enabled: true}});
      return json(empty);
    }});
  assert.deepEqual(await api.enableMemory(pair), {enabled: true, changed: false});
  assert.deepEqual(calls.map(call => call.endpoint), ['/character/list', '/character/get']);
  assert.equal(calls[0].headers['CONVAI-API-KEY'], 'embedded-fixture-key-00000000');
});

test('a player\'s own key never enters backend mode', () => {
  const {api} = fake({own: true, backend: true});
  assert.equal(api.backend, false);
  assert.equal(api.ownKey, true);
});

test('a credential that cannot be had (the backend refused) fails the call without sending anything', async () => {
  const {api, calls} = fake({credential: async () => { throw Error('Convai sign-in is unavailable'); }});
  await assert.rejects(api.clearMemory(pair), error => error instanceof PlayerMemoryApiError && error.code === 'NETWORK_ERROR' && error.writeUncertain === false);
  assert.equal(calls.length, 0);
});
