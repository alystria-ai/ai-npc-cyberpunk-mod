import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PlayerMemory} from './player-memory.mjs';
import {PlayerMemoryApi} from './player-memory-api.mjs';

const user = '12345678-abcd-4567-8234-123456789abc';
const normal = {profileKey: 'judy', characterId: 'fixture-current', endUserId: user};
const retired = {profileKey: 'judy-retired-romantic', characterId: 'fixture-retired', endUserId: user};
const replaced = {profileKey: 'judy', characterId: 'fixture-previous-normal', endUserId: user};
const empty = {memories: [], total_count: 0, page: 1, page_size: 1, has_more: false};
const json = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
function fake(options = {}) {
  const owners = new Map([[normal.characterId, normal.profileKey], [retired.characterId, retired.profileKey],
    [replaced.characterId, replaced.profileKey]]);
  const calls = [], receipts = [];
  const respond = async call => {
    if (call.endpoint === '/character/list') return json({characters: [...owners.keys()].map(character_id => ({character_id}))});
    if (call.endpoint === '/character/get') return json({character_id: call.body.charID,
      backstory: `[CyberpunkConvai profile v2:${owners.get(call.body.charID)}]`, memory_settings: {enabled: true}});
    if (call.endpoint === '/memory/delete-all') return json({message: 'Scheduled', ...call.body});
    if (call.endpoint === '/memory/list') return json(empty);
    throw Error('Unexpected isolated wire operation');
  };
  const api = new PlayerMemoryApi({key: 'fixture-credential', characterIds: {judy: normal.characterId}, pollIntervalMs: 0,
    fetchImpl: async (url, init) => {
      const call = {endpoint: url.slice('https://api.convai.com'.length), body: JSON.parse(init.body)};
      calls.push(call); return (options.respond ?? respond)(call, owners);
    }, ...options});
  return {api, calls, receipts, owners, respond};
}

test('historical authorization permits only clear/inspect, not enable or current-pair reassignment', async () => {
  const allowed = [];
  const {api, calls} = fake({historicalPairAllowed: pair => {
    allowed.push(pair); return pair.characterId === retired.characterId || pair.characterId === replaced.characterId;
  }});
  assert.equal(calls.length, 0);
  assert.throws(() => api.enableMemory(retired), {code: 'CHARACTER_MISMATCH'});
  assert.throws(() => api.enableMemory(replaced), {code: 'CHARACTER_MISMATCH'});
  assert.equal(allowed.length, 0); assert.equal(calls.length, 0);
  assert.deepEqual(await api.clearMemory(retired), {accepted: true, providerEmptyObserved: true});
  assert.deepEqual(await api.inspectMemory(replaced), {providerEmptyObserved: true});
  assert.equal(allowed.length, 4, 'historical authority is checked before and after ownership readback');
  assert.ok(allowed.every(Object.isFrozen));
  assert.deepEqual(calls.filter(row => row.endpoint === '/memory/delete-all').map(row => row.body),
    [{character_id: retired.characterId, end_user_id: user}]);
  assert.ok(!calls.some(row => row.endpoint === '/character/update'));
});

test('durable callbacks cannot authorize ambiguous current IDs or a different configured owner', () => {
  const borrowed = fake({historicalPairAllowed: () => true});
  assert.throws(() => borrowed.api.clearMemory({...retired, characterId: normal.characterId}), {code: 'CHARACTER_MISMATCH'});
  assert.equal(borrowed.calls.length, 0);
  const duplicate = fake({characterIds: {judy: normal.characterId, another: normal.characterId}, historicalPairAllowed: () => true});
  assert.throws(() => duplicate.api.inspectMemory(normal), {code: 'CHARACTER_MISMATCH'});
  assert.equal(duplicate.calls.length, 0);
});

test('missing, throwing, async or merely truthy authorization fails before any wire request', () => {
  for (const historicalPairAllowed of [undefined, () => false, () => 'true', () => ({}),
    () => Promise.resolve(true), () => Promise.reject(Error('private async fixture failure')),
    () => { throw Error('private fixture failure'); }]) {
    const {api, calls} = fake({historicalPairAllowed});
    assert.throws(() => api.clearMemory(retired), {code: 'CHARACTER_MISMATCH'});
    assert.throws(() => api.inspectMemory(retired), {code: 'CHARACTER_MISMATCH'});
    assert.equal(calls.length, 0);
  }
  assert.throws(() => fake({historicalPairAllowed: true}), {code: 'INVALID_CONFIGURATION'});
});

test('historical mod ownership still requires the exact original profile marker and exact returned ID', async () => {
  for (const corruption of [
    {character_id: retired.characterId, backstory: '[CyberpunkConvai profile v2:judy]'},
    {character_id: normal.characterId, backstory: `[CyberpunkConvai profile v2:${retired.profileKey}]`},
    {character_id: retired.characterId, backstory: `Prefix [CyberpunkConvai profile v2:${retired.profileKey}] suffix`}
  ]) {
    const setup = fake({historicalPairAllowed: () => true});
    const {api, calls} = fake({historicalPairAllowed: () => true,
      respond: call => call.endpoint === '/character/get' ? json(corruption) : setup.respond(call)});
    await assert.rejects(api.clearMemory(retired));
    assert.ok(!calls.some(row => row.endpoint === '/memory/delete-all'));
  }
});

test('historical authorization revoked during ownership reads cannot reach deletion or memory reads', async () => {
  for (const operation of ['clearMemory', 'inspectMemory']) {
    let allowed = true;
    const setup = fake();
    const {api, calls} = fake({historicalPairAllowed: () => allowed, respond: async call => {
      const response = await setup.respond(call);
      if (call.endpoint === '/character/get') allowed = false;
      return response;
    }});
    await assert.rejects(api[operation](retired), {code: 'CHARACTER_MISMATCH', writeUncertain: false});
    assert.deepEqual(calls.map(row => row.endpoint), ['/character/list', '/character/get']);
  }
});

test('mutable caller options cannot swap the authorization identity after the original pair was checked', async () => {
  for (const operation of ['clearMemory', 'inspectMemory']) {
    let allowed = true;
    const options = {...retired}, setup = fake();
    const {api, calls} = fake({historicalPairAllowed: () => allowed, respond: async call => {
      const response = await setup.respond(call);
      if (call.endpoint === '/character/get') { allowed = false; Object.assign(options, normal); }
      return response;
    }});
    await assert.rejects(api[operation](options), {code: 'CHARACTER_MISMATCH', writeUncertain: false});
    assert.deepEqual(calls.map(row => row.endpoint), ['/character/list', '/character/get']);
  }
});

test('real temporary durable history authorizes removed and replaced family targets without enabling historical profiles', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'player-memory-api-history-'));
  const path = join(directory, 'player-memory.json'), opened = [];
  t.after(async () => {
    await Promise.all(opened.map(memory => memory.close().catch(() => {})));
    // Exact task-owned mkdtemp root, never a supplied workspace/user path.
    await fs.rm(directory, {recursive: true, force: true});
  });
  const oldIds = {judy: replaced.characterId, [retired.profileKey]: retired.characterId};
  const familyMap = {judy: 'judy', [retired.profileKey]: 'judy'};
  const initial = await PlayerMemory.open({path, characterIds: oldIds, characterFamilies: familyMap,
    provider: {enableMemory: async () => ({enabled: true, changed: false})}}); opened.push(initial);
  await initial.beginConversation({profileKey: 'judy'});
  await initial.beginConversation({profileKey: retired.profileKey});
  const identity = initial.route('judy').endUserId; await initial.close();
  let memory;
  const {api, calls} = fake({historicalPairAllowed: ({profileKey, characterId}) => memory?.hasContactedProviderPair(profileKey, characterId) === true});
  memory = await PlayerMemory.open({path, characterIds: {judy: normal.characterId}, characterFamilies: {judy: 'judy'},
    provider: api, quiesce: async () => ({quiesced: true})}); opened.push(memory);
  assert.equal(calls.length, 0);
  assert.throws(() => api.enableMemory({...retired, endUserId: identity}), {code: 'CHARACTER_MISMATCH'});
  assert.equal((await memory.clearCharacter({profileKey: 'judy', actionId: 'clear-all-family-history'})).state, 'succeeded');
  assert.deepEqual(new Set(calls.filter(row => row.endpoint === '/memory/delete-all').map(row => row.body.character_id)),
    new Set([replaced.characterId, retired.characterId]));
  assert.ok(calls.filter(row => row.endpoint.startsWith('/memory/')).every(row => row.body.end_user_id === identity));
  assert.equal(memory.route('judy').endUserId, identity);
  assert.deepEqual(memory.status().characters, [{profileKey: 'judy', blocked: false}]);
});
