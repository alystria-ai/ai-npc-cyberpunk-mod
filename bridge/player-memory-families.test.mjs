import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PlayerMemory} from './player-memory.mjs';

// Synthetic provider identities never touch production state or the network.
const ids = Object.freeze({judy: 'fixture-normal', 'judy-romantic': 'fixture-romantic',
  'judy-multilingual': 'fixture-multilingual', panam: 'fixture-panam', 'judy-unrelated': 'fixture-other'});
const families = Object.freeze({judy: 'judy', 'judy-romantic': 'judy', 'judy-multilingual': 'judy'});
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return {promise, resolve}; };
async function until(predicate) {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('Expected isolated operation was not reached');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'player-memory-families-'));
  const path = join(directory, 'player-memory.json'), calls = [], opened = [];
  const provider = {
    async enableMemory(value) { calls.push({kind: 'enable', ...value}); return {enabled: true, changed: false}; },
    async clearMemory(value) { calls.push({kind: 'clear', ...value}); return {accepted: true, providerEmptyObserved: true}; },
    async inspectMemory(value) { calls.push({kind: 'inspect', ...value}); return {providerEmptyObserved: true}; }
  };
  const quiesce = async value => { calls.push({kind: 'quiesce', ...value}); return {quiesced: true}; };
  const open = async extra => {
    const memory = await PlayerMemory.open({path, characterIds: ids, characterFamilies: families,
      provider, quiesce, ...options, ...extra});
    opened.push(memory); return memory;
  };
  t.after(async () => {
    await Promise.all(opened.map(memory => memory.close().catch(() => {})));
    // directory is the exact task-owned temporary root returned by mkdtemp.
    await fs.rm(directory, {recursive: true, force: true});
  });
  return {path, calls, provider, quiesce, open, memory: await open()};
}
const talk = (memory, profileKey, options = {}) => memory.beginConversation({profileKey, ...options});
const familyKeys = Object.keys(families);

test('explicit families do no startup/route work and do not merge exact provider guards', async t => {
  const {memory, path, calls} = await fixture(t);
  const before = await fs.readFile(path, 'utf8');
  const normal = memory.route('judy'), romantic = memory.route('judy-romantic');
  assert.equal(normal.endUserId, romantic.endUserId);
  assert.notEqual(normal.guard.characterId, romantic.guard.characterId);
  assert.deepEqual(calls, []);
  await assert.rejects(memory.prepareCharacter({profileKey: 'judy-romantic', guard: normal.guard}), {code: 'STALE_TURN'});
  await assert.rejects(talk(memory, 'judy', {guard: romantic.guard}), {code: 'STALE_TURN'});
  await assert.rejects(memory.recordAutomaticConversation({profileKey: 'judy', guard: romantic.guard}), {code: 'STALE_TURN'});
  assert.equal(await fs.readFile(path, 'utf8'), before);
  assert.deepEqual(calls, []);
});

test('status deduplicates contacted variants and family commands use the canonical key', async t => {
  const {memory, calls} = await fixture(t);
  await talk(memory, 'judy-romantic'); await talk(memory, 'judy'); await talk(memory, 'panam');
  assert.deepEqual(memory.status().characters, [{profileKey: 'judy', blocked: false}, {profileKey: 'panam', blocked: false}]);
  assert.equal(memory.status().talkedToCount, 2);
  const cleared = await memory.clearCharacter({profileKey: 'judy-romantic', actionId: 'canonical-command'});
  assert.equal(cleared.profileKey, 'judy'); assert.equal(cleared.state, 'succeeded');
  const count = calls.length;
  assert.deepEqual(await memory.clearCharacter({profileKey: 'judy', actionId: 'canonical-command'}), cleared);
  assert.equal(calls.length, count);
  const publicStatus = JSON.stringify(memory.status());
  assert.ok(!publicStatus.includes('judy-romantic'));
  assert.ok(!Object.values(ids).some(id => publicStatus.includes(id)));
});

test('a family clear immediately fences every configured variant and advances every exact epoch', async t => {
  const gate = deferred(); let entered = false;
  const {memory, calls, path} = await fixture(t, {quiesce: async value => {
    calls.push({kind: 'quiesce', ...value}); entered = true; return gate.promise;
  }});
  await talk(memory, 'judy-romantic');
  const before = familyKeys.map(key => memory.route(key));
  const unrelated = memory.route('panam');
  const clearing = memory.clearCharacter({profileKey: 'judy', actionId: 'all-variant-fence'});
  assert.ok(before.every(route => !memory.isCurrent(route.guard)));
  familyKeys.forEach(key => assert.throws(() => memory.route(key), {code: 'MEMORY_CLEAR_PENDING'}));
  assert.equal(memory.isCurrent(unrelated.guard), true);
  await until(() => entered);
  const quiesced = calls.find(row => row.kind === 'quiesce');
  assert.deepEqual(new Set(quiesced.profileKeys), new Set(familyKeys));
  assert.deepEqual(new Set(quiesced.characterIds), new Set(familyKeys.map(key => ids[key])));
  assert.equal(calls.filter(row => row.kind === 'clear').length, 0);
  gate.resolve({quiesced: true}); assert.equal((await clearing).state, 'succeeded');
  assert.deepEqual(calls.filter(row => row.kind === 'clear').map(row => row.profileKey), ['judy-romantic']);
  for (const key of familyKeys) {
    assert.equal(memory.route(key).guard.characterEpoch, 1);
    assert.equal(memory.route(key).endUserId, before[0].endUserId);
  }
  const disk = JSON.parse(await fs.readFile(path, 'utf8'));
  assert.equal(Object.values(disk.characters).filter(row => row.contacted).length, 1);
  assert.equal(disk.characters[ids['judy-multilingual']].contacted, false);
});

test('an uncontacted family clear deletes nothing and never turns unused variants into contacts', async t => {
  const {memory, calls} = await fixture(t);
  await memory.prepareCharacter({profileKey: 'judy-romantic'}); calls.length = 0;
  const old = familyKeys.map(key => memory.route(key).guard);
  assert.equal((await memory.clearCharacter({profileKey: 'judy', actionId: 'uncontacted-family'})).state, 'succeeded');
  assert.deepEqual(calls.map(row => row.kind), ['quiesce']);
  assert.equal(memory.status().talkedToCount, 0);
  assert.ok(old.every(guard => !memory.isCurrent(guard)));
});

test('durable family history includes previous IDs and removed provider aliases without identity rotation', async t => {
  const {memory, calls, open} = await fixture(t);
  await talk(memory, 'judy-romantic'); await talk(memory, 'judy');
  const identity = memory.route('judy').endUserId;
  await memory.close();
  const replacementIds = {judy: 'fixture-normal-new', panam: ids.panam};
  const reopened = await open({characterIds: replacementIds, characterFamilies: {judy: 'judy'}});
  await talk(reopened, 'judy'); calls.length = 0;
  const result = await reopened.clearCharacter({profileKey: 'judy', actionId: 'historical-targets'});
  assert.equal(result.state, 'succeeded');
  const deletes = calls.filter(row => row.kind === 'clear');
  assert.deepEqual(new Set(deletes.map(row => row.characterId)), new Set([ids.judy, ids['judy-romantic'], replacementIds.judy]));
  assert.equal(deletes.find(row => row.characterId === ids['judy-romantic']).profileKey, 'judy-romantic');
  assert.equal(reopened.route('judy').endUserId, identity);
  assert.deepEqual(reopened.status().characters, [{profileKey: 'judy', blocked: false}]);
});

test('partial family deletion blocks successful, failed and unused variants through reopen', async t => {
  const {memory, provider, open, calls} = await fixture(t);
  await talk(memory, 'judy'); await talk(memory, 'judy-romantic');
  provider.clearMemory = async value => { calls.push({kind: 'clear', ...value});
    return {accepted: true, providerEmptyObserved: value.characterId === ids.judy}; };
  const result = await memory.clearCharacter({profileKey: 'judy', actionId: 'partial-family'});
  assert.equal(result.state, 'failed'); assert.equal(result.uncertain, true);
  familyKeys.forEach(key => assert.throws(() => memory.route(key), {code: 'MEMORY_CLEAR_PENDING'}));
  assert.equal(memory.status().characters[0].blocked, true);
  const before = calls.length; await memory.close();
  const reopened = await open({characterIds: {...ids, 'judy-new-mode': 'fixture-new-mode'},
    characterFamilies: {...families, 'judy-new-mode': 'judy'}});
  assert.equal(calls.length, before, 'reopen performs no cloud work');
  for (const key of [...familyKeys, 'judy-new-mode']) assert.throws(() => reopened.route(key), {code: 'MEMORY_CLEAR_PENDING'});
  assert.equal(reopened.route('panam').guard.characterEpoch, 0);
});

test('family recovery checks every partial-family target and fences configured but unused variants', async t => {
  const {memory, provider, calls, open} = await fixture(t);
  const identity = memory.route('judy').endUserId;
  await talk(memory, 'judy'); await talk(memory, 'judy-romantic');
  provider.clearMemory = async ({characterId}) => ({accepted: true, providerEmptyObserved: characterId === ids.judy});
  await memory.clearCharacter({profileKey: 'judy', actionId: 'recover-family'});
  await memory.close(); const reopened = await open(); calls.length = 0;
  const gate = deferred(); let entered = false;
  provider.inspectMemory = async value => { calls.push({kind: 'inspect', ...value}); entered = true; await gate.promise;
    return {providerEmptyObserved: true}; };
  const recovery = reopened.recoverClear({actionId: 'recover-family'});
  familyKeys.forEach(key => assert.throws(() => reopened.route(key), {code: 'MEMORY_CLEAR_PENDING'}));
  assert.throws(() => reopened.clearCharacter({profileKey: 'judy-multilingual', actionId: 'overlap'}), {code: 'CLEAR_IN_PROGRESS'});
  await until(() => entered); gate.resolve();
  assert.equal((await recovery).state, 'succeeded');
  assert.deepEqual(calls.map(row => row.kind), ['quiesce', 'inspect', 'inspect']);
  assert.deepEqual(new Set(calls.filter(row => row.kind === 'inspect').map(row => row.characterId)), new Set([ids.judy, ids['judy-romantic']]));
  for (const key of familyKeys) assert.equal(reopened.route(key).guard.characterEpoch, 2);
  assert.equal(reopened.route('judy').endUserId, identity);
});

test('clear-all partial results block whole unresolved families but preserve unrelated completed families', async t => {
  const {memory, provider} = await fixture(t);
  await talk(memory, 'judy'); await talk(memory, 'judy-romantic'); await talk(memory, 'panam');
  provider.clearMemory = async ({characterId}) => ({accepted: true, providerEmptyObserved: characterId !== ids['judy-romantic']});
  assert.equal((await memory.clearAll({actionId: 'partial-all-families'})).state, 'failed');
  familyKeys.forEach(key => assert.throws(() => memory.route(key), {code: 'MEMORY_CLEAR_PENDING'}));
  assert.equal(memory.route('panam').guard.resetEpoch, 1);
  assert.equal(memory.route('judy-unrelated').guard.resetEpoch, 1);
});

test('explicit mapping binds legacy history and an uncertain old variant command into the canonical family', async t => {
  const {memory, provider, path, open, calls} = await fixture(t, {characterFamilies: undefined});
  await talk(memory, 'judy-romantic');
  const identity = memory.route('judy').endUserId;
  provider.clearMemory = async () => ({accepted: true, providerEmptyObserved: false});
  await memory.clearCharacter({profileKey: 'judy-romantic', actionId: 'legacy-variant'});
  const old = JSON.parse(await fs.readFile(path, 'utf8'));
  assert.equal(Object.hasOwn(old.characters[ids['judy-romantic']], 'familyKey'), false);
  await memory.close(); const before = calls.length;
  const reopened = await open({characterFamilies: families});
  assert.equal(calls.length, before);
  assert.equal(reopened.status().command.profileKey, 'judy');
  assert.deepEqual(reopened.status().characters, [{profileKey: 'judy', blocked: true}]);
  familyKeys.forEach(key => assert.throws(() => reopened.route(key), {code: 'MEMORY_CLEAR_PENDING'}));
  assert.equal(JSON.parse(await fs.readFile(path + '.identity', 'utf8')).endUserId, identity);
});

test('family membership is explicit: a similarly named character is independent', async t => {
  const {memory, calls} = await fixture(t);
  await talk(memory, 'judy-unrelated'); await talk(memory, 'judy-romantic');
  const unrelated = memory.route('judy-unrelated').guard;
  calls.length = 0; await memory.clearCharacter({profileKey: 'judy', actionId: 'no-suffix-inference'});
  assert.equal(memory.isCurrent(unrelated), true);
  assert.deepEqual(calls.filter(row => row.kind === 'clear').map(row => row.characterId), [ids['judy-romantic']]);
  assert.equal(memory.status().talkedToCount, 2);
});

test('durable pair authorization requires contact, exact alias and ID, and a live healthy store', async t => {
  const {memory, path} = await fixture(t);
  await memory.prepareCharacter({profileKey: 'judy'});
  assert.equal(memory.hasContactedProviderPair('judy', ids.judy), false);
  await talk(memory, 'judy-romantic');
  assert.equal(memory.hasContactedProviderPair('judy-romantic', ids['judy-romantic']), true);
  assert.equal(memory.hasContactedProviderPair('judy', ids['judy-romantic']), false);
  assert.equal(memory.hasContactedProviderPair('judy-romantic', ids.judy), false);
  await fs.writeFile(path, 'isolated corrupt fixture');
  await assert.rejects(talk(memory, 'judy-romantic'), {code: 'REGISTRY_CHANGED'});
  assert.equal(memory.hasContactedProviderPair('judy-romantic', ids['judy-romantic']), false);
  await memory.close();
  assert.equal(memory.hasContactedProviderPair('judy-romantic', ids['judy-romantic']), false);
});

test('arbitrary mixed-family character targets and exact target-owner mismatches remain corruption', async t => {
  for (const mutate of [
    state => { state.actions[0].targets.push({...state.actions[0].targets[0], characterId: ids.panam, profileKey: 'panam'}); },
    state => { state.actions[0].targets[0].profileKey = 'judy-romantic'; },
    state => { state.characters[ids.judy].familyKey = 'panam'; }
  ]) {
    const {memory, path, open} = await fixture(t);
    await talk(memory, 'judy'); await talk(memory, 'panam');
    await memory.clearCharacter({profileKey: 'judy', actionId: 'integrity-command'});
    await memory.close();
    const state = JSON.parse(await fs.readFile(path, 'utf8')); mutate(state);
    await fs.writeFile(path, JSON.stringify(state));
    await assert.rejects(open(), {code: 'CORRUPT_REGISTRY'});
  }
});

test('family chains, ambiguous IDs, durable reassignment and ID hijacking fail closed', async t => {
  const {memory, open, path} = await fixture(t);
  await talk(memory, 'judy-romantic'); await memory.close();
  const before = await fs.readFile(path, 'utf8');
  for (const extra of [
    {characterFamilies: {'judy-romantic': 'judy', judy: 'panam'}},
    {characterIds: {judy: 'fixture-shared', 'judy-romantic': 'fixture-shared'}},
    {characterFamilies: {...families, 'judy-romantic': 'panam'}},
    {characterIds: {panam: ids['judy-romantic']}}
  ]) {
    await assert.rejects(open(extra), {code: 'INVALID_CONFIGURATION'});
    assert.equal(await fs.readFile(path, 'utf8'), before);
  }
});

test('partial success plus a definitive later failure still blocks every variant until aggregate recovery', async t => {
  const {memory, provider} = await fixture(t);
  await talk(memory, 'judy'); await talk(memory, 'judy-romantic');
  provider.clearMemory = async ({characterId}) => {
    if (characterId === ids['judy-romantic']) throw Object.assign(Error('isolated error'), {code: 'NOT_MOD_OWNED', writeUncertain: false});
    return {accepted: true, providerEmptyObserved: true};
  };
  const result = await memory.clearCharacter({profileKey: 'judy', actionId: 'definitive-partial'});
  assert.equal(result.state, 'failed'); assert.equal(result.uncertain, false);
  familyKeys.forEach(key => assert.throws(() => memory.route(key), {code: 'MEMORY_CLEAR_PENDING'}));
  assert.equal((await memory.recoverClear({actionId: 'definitive-partial'})).state, 'succeeded');
  familyKeys.forEach(key => assert.ok(memory.route(key)));
});

test('a valid provider ID matching an object prototype property cannot bypass a family fence', async t => {
  const gate = deferred();
  const {memory} = await fixture(t, {characterIds: {...ids, judy: 'constructor'}, quiesce: () => gate.promise});
  const old = memory.route('judy').guard;
  const clearing = memory.clearCharacter({profileKey: 'judy', actionId: 'prototype-id-fence'});
  assert.equal(memory.isCurrent(old), false);
  familyKeys.forEach(key => assert.throws(() => memory.route(key), {code: 'MEMORY_CLEAR_PENDING'}));
  gate.resolve({quiesced: true}); assert.equal((await clearing).state, 'succeeded');
});

test('durable family bindings remain authoritative when an optional configuration map is absent after reopen', async t => {
  const {memory, provider, open, calls} = await fixture(t);
  await talk(memory, 'judy-romantic');
  provider.clearMemory = async () => ({accepted: true, providerEmptyObserved: false});
  await memory.clearCharacter({profileKey: 'judy', actionId: 'durable-only-family'});
  await memory.close(); const before = calls.length;
  const reopened = await open({characterFamilies: undefined});
  assert.equal(calls.length, before);
  familyKeys.forEach(key => assert.throws(() => reopened.route(key), {code: 'MEMORY_CLEAR_PENDING'}));
  assert.deepEqual(reopened.status().characters, [{profileKey: 'judy', blocked: true}]);
});

test('a canonical logical key need not itself have a configured provider ID', async t => {
  const providerIds = {'judy-normal': 'fixture-logical-normal', 'judy-romance': 'fixture-logical-romance'};
  const {memory, calls} = await fixture(t, {characterIds: providerIds,
    characterFamilies: {'judy-normal': 'judy-alvarez', 'judy-romance': 'judy-alvarez'}});
  await talk(memory, 'judy-romance'); calls.length = 0;
  const result = await memory.clearCharacter({profileKey: 'judy-alvarez', actionId: 'logical-only-command'});
  assert.equal(result.profileKey, 'judy-alvarez'); assert.equal(result.state, 'succeeded');
  assert.deepEqual(memory.status().characters, [{profileKey: 'judy-alvarez', blocked: false}]);
  assert.deepEqual(calls.filter(row => row.kind === 'clear').map(row => row.profileKey), ['judy-romance']);
  assert.throws(() => memory.route('judy-alvarez'), {code: 'UNKNOWN_CHARACTER'}, 'route remains provider-specific');
});

test('a partial later config cannot reassign a durable logical root after retiring its provider alias', async t => {
  const {memory, open, path} = await fixture(t, {characterIds: {'judy-romantic': ids['judy-romantic']},
    characterFamilies: {'judy-romantic': 'judy'}});
  await talk(memory, 'judy-romantic'); await memory.close();
  const before = await fs.readFile(path, 'utf8');
  await assert.rejects(open({characterIds: {judy: ids.judy, panam: ids.panam},
    characterFamilies: {judy: 'panam', panam: 'panam'}}), {code: 'INVALID_CONFIGURATION'});
  assert.equal(await fs.readFile(path, 'utf8'), before);
  const reopened = await open({characterIds: {judy: ids.judy, panam: ids.panam}, characterFamilies: {judy: 'judy'}});
  assert.deepEqual(reopened.status().characters, [{profileKey: 'judy', blocked: false}]);
  assert.equal((await reopened.clearCharacter({profileKey: 'judy', actionId: 'root-remains-canonical'})).state, 'succeeded');
});

test('a successful legacy sibling subset cannot supersede another exact ID uncertainty after explicit family merge', async t => {
  const {memory, provider, open, calls} = await fixture(t, {characterFamilies: undefined});
  await talk(memory, 'judy'); await talk(memory, 'judy-romantic');
  provider.clearMemory = async value => { calls.push({kind: 'clear', ...value});
    return {accepted: true, providerEmptyObserved: value.characterId === ids['judy-romantic']}; };
  await memory.clearCharacter({profileKey: 'judy', actionId: 'legacy-normal-uncertainty'});
  assert.equal((await memory.clearCharacter({profileKey: 'judy-romantic', actionId: 'legacy-sibling-success'})).state, 'succeeded');
  assert.throws(() => memory.route('judy'), {code: 'MEMORY_CLEAR_PENDING'});
  assert.ok(memory.route('judy-romantic'));
  await memory.close(); const before = calls.length;
  const reopened = await open({characterFamilies: families});
  assert.equal(calls.length, before);
  familyKeys.forEach(key => assert.throws(() => reopened.route(key), {code: 'MEMORY_CLEAR_PENDING'}));
  assert.deepEqual(reopened.status().characters, [{profileKey: 'judy', blocked: true}]);
  provider.clearMemory = async value => { calls.push({kind: 'clear', ...value}); return {accepted: true, providerEmptyObserved: true}; };
  const result = await reopened.clearCharacter({profileKey: 'judy', actionId: 'aggregate-family-retry'});
  assert.equal(result.state, 'succeeded');
  familyKeys.forEach(key => assert.ok(reopened.route(key)));
  assert.equal(calls.filter(row => row.kind === 'clear').length, 4);
});

test('a new family cannot target a durable provider alias as though it were a logical root', async t => {
  const {memory, path, open} = await fixture(t, {characterIds: {'judy-romantic': ids['judy-romantic']},
    characterFamilies: {'judy-romantic': 'judy'}});
  await talk(memory, 'judy-romantic'); await memory.close();
  const before = await fs.readFile(path, 'utf8');
  await assert.rejects(open({characterIds: {'judy-new-mode': 'fixture-new-mode'},
    characterFamilies: {'judy-new-mode': 'judy-romantic'}}), {code: 'INVALID_CONFIGURATION'});
  assert.equal(await fs.readFile(path, 'utf8'), before);
});
