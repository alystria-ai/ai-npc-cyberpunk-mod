import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {PlayerMemory, PlayerMemoryError} from './player-memory.mjs';
import {IntrinsicCharacterContext} from './intrinsic-character-context.mjs';

const ids = Object.freeze({judy: 'owned-judy', panam: 'owned-panam', johnny: 'owned-johnny'});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'player-memory-'));
  const path = join(directory, 'player-memory.json'), calls = [], opened = [];
  const provider = {
    async enableMemory(value) { calls.push({kind: 'enable', ...value}); return {enabled: true, changed: true}; },
    async clearMemory(value) { calls.push({kind: 'clear', ...value}); return {accepted: true, providerEmptyObserved: true}; },
    async inspectMemory(value) { calls.push({kind: 'inspect', ...value}); return {providerEmptyObserved: true}; }
  };
  const quiesce = async value => { calls.push({kind: 'quiesce', ...value}); return {quiesced: true}; };
  const open = async extra => {
    const memory = await PlayerMemory.open({path, characterIds: ids, provider, quiesce, ...options, ...extra});
    opened.push(memory); return memory;
  };
  t.after(async () => {
    await Promise.all(opened.map(memory => memory.close().catch(() => {})));
    // This path is returned directly by mkdtemp; no user/workspace paths enter it.
    await fs.rm(directory, {recursive: true, force: true});
  });
  return {path, directory, provider, quiesce, calls, open, memory: await open()};
}
async function talk(memory, key, options = {}) {
  return memory.beginConversation({profileKey: key, guard: memory.route(key).guard, source: 'player', ...options});
}
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Expected event was not reached'); await new Promise(resolve => setTimeout(resolve, 2)); }
}

test('open, route, audience scopes and reopen do no provider work and retain one immutable UUID', async t => {
  const {memory, open, calls, path} = await fixture(t);
  const first = memory.route('judy', {channel: 'private', audience: Object.freeze(['judy'])});
  assert.match(first.endUserId, /^[0-9a-f-]{36}$/);
  for (const key of Object.keys(ids)) for (const channel of ['private', 'group', 'phone', 'microphone']) {
    const route = memory.route(key, {channel});
    assert.equal(route.endUserId, first.endUserId);
    assert.equal(route.guard.characterId, ids[key]); assert.equal(memory.isCurrent(route.guard), true);
    assert.equal(Object.isFrozen(route), true); assert.equal(Object.isFrozen(route.guard), true);
  }
  assert.equal(memory.status().talkedToCount, 0); assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(memory), '{}'); assert.ok(!JSON.stringify(memory.status()).includes(first.endUserId));
  await memory.close();
  const reopened = await open(); assert.equal(reopened.route('johnny').endUserId, first.endUserId);
  assert.equal(calls.length, 0); assert.equal(reopened.status().talkedToCount, 0);
  const anchor = JSON.parse(await fs.readFile(path + '.identity', 'utf8'));
  assert.equal(anchor.endUserId, first.endUserId);
});

test('empty mappings are valid local startup state; unknown routing fails without cloud traffic', async t => {
  const {memory, calls, open} = await fixture(t, {characterIds: {}});
  assert.equal(memory.status().talkedToCount, 0);
  assert.throws(() => memory.route('judy'), {code: 'UNKNOWN_CHARACTER'});
  await memory.close(); await open({characterIds: {}}); assert.equal(calls.length, 0);
});

test('invitation preparation verifies an unused profile without contact, memory data or durable changes', async t => {
  const {memory, provider, path, calls} = await fixture(t);
  provider.addMemory = async () => { throw Error('Invitation must not create long-term memory'); };
  const before = await fs.readFile(path, 'utf8'), anchor = await fs.readFile(path + '.identity', 'utf8');
  const route = memory.route('judy');
  const prepared = await memory.prepareCharacter({profileKey: 'judy', guard: route.guard});
  assert.deepEqual(prepared, {...route, memoryEnabled: true, memoryEnabledNow: true, changed: true, reconnectRequired: true});
  assert.equal(Object.isFrozen(prepared), true); assert.equal(Object.isFrozen(prepared.guard), true);
  assert.equal(memory.status().talkedToCount, 0); assert.deepEqual(memory.status().characters, []);
  assert.equal(await fs.readFile(path, 'utf8'), before);
  assert.equal(await fs.readFile(path + '.identity', 'utf8'), anchor);
  assert.deepEqual(calls.map(row => row.kind), ['enable']);
  assert.equal(calls[0].characterId, ids.judy); assert.equal(calls[0].endUserId, route.endUserId);
  const repeated = await memory.prepareCharacter({profileKey: 'judy'});
  assert.deepEqual(repeated, {...route, memoryEnabled: true, memoryEnabledNow: false, changed: false, reconnectRequired: true});
  assert.equal(memory.acknowledgeConnectionRefresh({profileKey: 'judy', guard: route.guard}), true);
  assert.equal((await memory.prepareCharacter({profileKey: 'judy'})).reconnectRequired, false);
  assert.equal(calls.length, 1); assert.equal(await fs.readFile(path, 'utf8'), before);
});

test('the first actual player send records contact and keeps a completed invitation connection warm', async t => {
  const {memory, path, calls} = await fixture(t);
  const prepared = await memory.prepareCharacter({profileKey: 'judy'});
  assert.equal(memory.status().talkedToCount, 0);
  memory.acknowledgeConnectionRefresh({profileKey: 'judy', guard: prepared.guard});
  const first = await talk(memory, 'judy', {guard: prepared.guard, channel: 'group', requestId: 'first-prepared-send'});
  assert.deepEqual(first, {endUserId: prepared.endUserId, guard: prepared.guard,
    memoryEnabled: true, memoryEnabledNow: false, reconnectRequired: false});
  assert.equal(memory.status().talkedToCount, 1);
  const disk = JSON.parse(await fs.readFile(path, 'utf8'));
  assert.deepEqual(disk.characters, {[ids.judy]: {profileKey: 'judy', characterEpoch: 0, contacted: true}});
  assert.equal(disk.revision, 1); assert.deepEqual(disk.actions, []);
  for (const channel of ['private', 'phone', 'microphone']) {
    const receipt = await talk(memory, 'judy', {channel});
    assert.equal(receipt.reconnectRequired, false); assert.equal(receipt.memoryEnabledNow, false);
    assert.deepEqual(receipt.guard, prepared.guard);
  }
  assert.deepEqual(calls.map(row => row.kind), ['enable']);
});

test('a real automatic conversation after invitation becomes a Forget-all target without extra memory provider calls', async t => {
  const {memory, path, calls} = await fixture(t);
  const invited = await memory.prepareCharacter({profileKey: 'judy'});
  memory.acknowledgeConnectionRefresh({profileKey: 'judy', guard: invited.guard});
  await memory.prepareCharacter({profileKey: 'panam'});
  assert.equal(memory.status().talkedToCount, 0, 'unused invitation remains preparation only');
  const source = await fs.readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function admitPlayerConversation('), source.indexOf('async function pollMicrophone()'));
  const prepared = {sendAllowed: true, route: {profileKey: 'judy', channel: 'private', transport: 'private'},
    guard: invited.guard, input: {requestId: 'fixture-loot-reaction', reaction: {kind: 'loot'}}};
  const admit = runInNewContext('(' + body + ')', {playerMemory: memory, mistral: {active: false}, knowledgeRouter: {current: async () => true},
    intrinsicHistory: new IntrinsicCharacterContext([]),
    throwIfCancelled: signal => { if (signal?.aborted) throw Error('Cancelled'); }});
  await admit(prepared);
  assert.deepEqual(memory.status().characters.map(row => row.profileKey), ['judy']);
  assert.deepEqual(calls.map(row => row.kind), ['enable', 'enable'], 'automatic admission never enables, inspects or seeds memory');
  const first = await fs.readFile(path, 'utf8');
  await admit(prepared);
  assert.equal(await fs.readFile(path, 'utf8'), first, 'already-recorded automatic dialogue adds no repeated registry mutation');
  await memory.clearAll({actionId: 'forget-after-loot'});
  assert.deepEqual(calls.filter(row => row.kind === 'clear').map(row => row.characterId), [ids.judy]);
  assert.equal(memory.route('judy').endUserId, invited.endUserId);
});

test('automatic admission is local bookkeeping and rejects stale, cancelled or mismatched ownership', async t => {
  const {memory, calls, path} = await fixture(t, {provider: {}});
  const before = await fs.readFile(path, 'utf8'), cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(memory.recordAutomaticConversation({profileKey: 'judy', signal: cancelled.signal}), {code: 'CANCELLED'});
  await assert.rejects(memory.recordAutomaticConversation({profileKey: 'missing'}), {code: 'UNKNOWN_CHARACTER'});
  await assert.rejects(memory.recordAutomaticConversation({profileKey: 'judy', guard: memory.route('panam').guard}), {code: 'STALE_TURN'});
  assert.equal(await fs.readFile(path, 'utf8'), before); assert.deepEqual(calls, []);
  const route = memory.route('judy');
  const recorded = await memory.recordAutomaticConversation({profileKey: 'judy', guard: route.guard, requestId: 'actual-battle'});
  assert.deepEqual(recorded, route); assert.equal(memory.status().talkedToCount, 1);
  assert.deepEqual(calls, [], 'recording an admitted turn requires no enable, inspect, clear or seed provider capability');
  await memory.close();
  await assert.rejects(memory.recordAutomaticConversation({profileKey: 'judy', guard: route.guard}), {code: 'CLOSED'});
});

test('automatic admission verifies existing durable registry state before a later send', async t => {
  const {memory, calls, path} = await fixture(t);
  await memory.recordAutomaticConversation({profileKey: 'judy'});
  await fs.writeFile(path, '{}');
  await assert.rejects(memory.recordAutomaticConversation({profileKey: 'judy'}), {code: 'REGISTRY_CHANGED'});
  assert.deepEqual(calls, []);
});

test('simultaneous invitations and actual sends share one enable and preserve first-wave reconnect receipts', async t => {
  const gate = deferred(); let enables = 0;
  const {memory, provider, path} = await fixture(t);
  provider.enableMemory = async () => { enables++; return gate.promise; };
  const guard = memory.route('judy').guard;
  const invitations = Array.from({length: 6}, () => memory.prepareCharacter({profileKey: 'judy', guard}));
  await until(() => enables === 1);
  assert.equal(memory.status().talkedToCount, 0);
  const sends = [talk(memory, 'judy', {guard, channel: 'phone'}), talk(memory, 'judy', {guard, channel: 'group'})];
  await until(() => memory.status().talkedToCount === 1);
  gate.resolve({enabled: true, changed: true});
  const [prepared, admitted] = await Promise.all([Promise.all(invitations), Promise.all(sends)]);
  assert.equal(enables, 1);
  for (const receipt of [...prepared, ...admitted]) {
    assert.equal(receipt.memoryEnabled, true); assert.equal(receipt.memoryEnabledNow, true);
    assert.equal(receipt.reconnectRequired, true); assert.deepEqual(receipt.guard, guard);
  }
  assert.ok(prepared.every(receipt => receipt.changed === true));
  assert.equal(Object.keys(JSON.parse(await fs.readFile(path, 'utf8')).characters).length, 1);
  memory.acknowledgeConnectionRefresh({profileKey: 'judy', guard});
  const later = await talk(memory, 'judy');
  assert.equal(later.reconnectRequired, false); assert.equal(later.memoryEnabledNow, false);
});

test('cancelling one invitation does not cancel another invitation or an actual send sharing its enable', async t => {
  const gate = deferred(), cancelled = new AbortController(); let enables = 0, providerSignal;
  const {memory, provider} = await fixture(t);
  provider.enableMemory = async ({signal}) => { enables++; providerSignal = signal; return gate.promise; };
  const abandoned = memory.prepareCharacter({profileKey: 'judy', signal: cancelled.signal}); abandoned.catch(() => {});
  const preparing = memory.prepareCharacter({profileKey: 'judy'});
  const sending = talk(memory, 'judy');
  await until(() => enables === 1 && memory.status().talkedToCount === 1);
  cancelled.abort(); await assert.rejects(abandoned, {code: 'CANCELLED'});
  assert.equal(providerSignal.aborted, false);
  gate.resolve({enabled: true, changed: true});
  const receipts = await Promise.all([preparing, sending]);
  assert.equal(enables, 1); assert.ok(receipts.every(row => row.memoryEnabled && row.reconnectRequired));
  memory.acknowledgeConnectionRefresh({profileKey: 'judy', guard: receipts[0].guard});
  assert.equal((await talk(memory, 'judy')).reconnectRequired, false);
});

test('pre-cancelled, unknown and mismatched-guard preparations do no provider or contact work', async t => {
  const {memory, path, calls} = await fixture(t);
  const before = await fs.readFile(path, 'utf8'), cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(memory.prepareCharacter({profileKey: 'judy', signal: cancelled.signal}), {code: 'CANCELLED'});
  await assert.rejects(memory.prepareCharacter({profileKey: 'missing'}), {code: 'UNKNOWN_CHARACTER'});
  await assert.rejects(memory.prepareCharacter({profileKey: 'judy', guard: memory.route('panam').guard}), {code: 'STALE_TURN'});
  assert.equal(memory.status().talkedToCount, 0); assert.equal(calls.length, 0);
  assert.equal(await fs.readFile(path, 'utf8'), before);
});

test('cancelled preparation cannot consume a shared enable that completes after its last waiter leaves', async t => {
  const {memory, provider, path} = await fixture(t), gate = deferred(), cancelled = new AbortController();
  const before = await fs.readFile(path, 'utf8'); let entered = false;
  provider.enableMemory = async () => { entered = true; return gate.promise; };
  const preparation = memory.prepareCharacter({profileKey: 'judy', signal: cancelled.signal});
  preparation.catch(() => {}); await until(() => entered);
  cancelled.abort(); await assert.rejects(preparation, {code: 'CANCELLED'});
  gate.resolve({enabled: true, changed: true});
  const guard = memory.route('judy').guard;
  await until(() => memory.connectionRefreshRequired({profileKey: 'judy', guard}));
  const retry = await memory.prepareCharacter({profileKey: 'judy'});
  assert.equal(retry.memoryEnabledNow, false); assert.equal(retry.reconnectRequired, true);
  assert.equal(memory.status().talkedToCount, 0); assert.equal(await fs.readFile(path, 'utf8'), before);
  const send = await talk(memory, 'judy');
  assert.equal(send.reconnectRequired, true, 'a real send must still dispose pre-enable transports');
  memory.acknowledgeConnectionRefresh({profileKey: 'judy', guard});
  assert.equal((await talk(memory, 'judy')).reconnectRequired, false);
});

test('only a current verified character guard can acknowledge connection disposal', async t => {
  const {memory} = await fixture(t), old = memory.route('judy').guard;
  assert.throws(() => memory.acknowledgeConnectionRefresh({profileKey: 'judy', guard: old}), {code: 'ENABLE_UNVERIFIED'});
  await memory.prepareCharacter({profileKey: 'judy'});
  await memory.prepareCharacter({profileKey: 'panam'});
  assert.throws(() => memory.acknowledgeConnectionRefresh({profileKey: 'judy', guard: memory.route('panam').guard}), {code: 'STALE_TURN'});
  memory.acknowledgeConnectionRefresh({profileKey: 'judy', guard: old});
  assert.equal(memory.connectionRefreshRequired({profileKey: 'panam', guard: memory.route('panam').guard}), true);
  await memory.clearCharacter({profileKey: 'judy', actionId: 'refresh-guard'});
  const next = await memory.prepareCharacter({profileKey: 'judy'});
  assert.throws(() => memory.acknowledgeConnectionRefresh({profileKey: 'judy', guard: old}), {code: 'STALE_TURN'});
  assert.equal(memory.connectionRefreshRequired({profileKey: 'judy', guard: next.guard}), true);
});

test('preparation fails closed without a memory provider and leaves the unused profile uncontacted', async t => {
  const {memory, path, calls} = await fixture(t, {provider: {}});
  const before = await fs.readFile(path, 'utf8');
  await assert.rejects(memory.prepareCharacter({profileKey: 'judy'}), {code: 'MEMORY_UNAVAILABLE'});
  assert.equal(memory.status().talkedToCount, 0); assert.equal(calls.length, 0);
  assert.equal(await fs.readFile(path, 'utf8'), before);
});

test('a failed invitation never contacts the profile; verified retry resolves uncertain configuration before warming', async t => {
  const {memory, provider, path} = await fixture(t);
  const before = await fs.readFile(path, 'utf8');
  provider.enableMemory = async () => ({enabled: true});
  await assert.rejects(memory.prepareCharacter({profileKey: 'judy'}), {code: 'ENABLE_UNVERIFIED', writeUncertain: true});
  assert.equal(memory.status().talkedToCount, 0); assert.equal(await fs.readFile(path, 'utf8'), before);
  provider.enableMemory = async () => ({enabled: true, changed: false});
  const prepared = await memory.prepareCharacter({profileKey: 'judy'});
  assert.equal(prepared.reconnectRequired, true); assert.equal(prepared.changed, false);
  assert.equal(prepared.memoryEnabledNow, false); assert.equal(memory.status().talkedToCount, 0);
  memory.acknowledgeConnectionRefresh({profileKey: 'judy', guard: prepared.guard});
  const first = await talk(memory, 'judy', {guard: prepared.guard});
  assert.equal(first.reconnectRequired, false); assert.equal(first.memoryEnabledNow, false);
});

test('a bounded preparation timeout leaves no contact or trusted cache after a late provider result', async t => {
  const gate = deferred();
  const {memory, provider, path} = await fixture(t, {timeoutMs: 25});
  const before = await fs.readFile(path, 'utf8');
  provider.enableMemory = () => gate.promise;
  await assert.rejects(memory.prepareCharacter({profileKey: 'judy'}), {code: 'TIMEOUT'});
  assert.equal(memory.status().talkedToCount, 0); assert.equal(await fs.readFile(path, 'utf8'), before);
  gate.resolve({enabled: true, changed: true});
  let verifiedAgain = 0;
  provider.enableMemory = async () => { verifiedAgain++; return {enabled: true, changed: false}; };
  const prepared = await memory.prepareCharacter({profileKey: 'judy'});
  assert.equal(verifiedAgain, 1); assert.equal(prepared.reconnectRequired, true);
  assert.equal(prepared.changed, false); assert.equal(memory.status().talkedToCount, 0);
  memory.acknowledgeConnectionRefresh({profileKey: 'judy', guard: prepared.guard});
  assert.equal((await talk(memory, 'judy')).reconnectRequired, false);
});

for (const scope of ['character', 'all']) test(`${scope} clear fences abort unused-profile preparation and late results cannot restore its cache`, async t => {
  const gate = deferred(); let entered = false, providerSignal;
  const {memory, provider, calls} = await fixture(t);
  provider.enableMemory = async ({signal}) => { entered = true; providerSignal = signal; return gate.promise; };
  const before = memory.route('judy');
  const preparing = memory.prepareCharacter({profileKey: 'judy', guard: before.guard}); preparing.catch(() => {});
  await until(() => entered);
  const clearing = scope === 'character' ? memory.clearCharacter({profileKey: 'judy', actionId: 'prepare-reset'})
    : memory.clearAll({actionId: 'prepare-reset'});
  assert.equal(providerSignal.aborted, true); assert.equal(memory.isCurrent(before.guard), false);
  await assert.rejects(memory.prepareCharacter({profileKey: 'judy'}), {code: 'MEMORY_CLEAR_PENDING'});
  assert.equal((await clearing).state, 'succeeded'); await assert.rejects(preparing);
  gate.resolve({enabled: true, changed: true});
  assert.equal(memory.status().talkedToCount, 0); assert.deepEqual(calls.map(row => row.kind), ['quiesce']);
  await assert.rejects(memory.prepareCharacter({profileKey: 'judy', guard: before.guard}), {code: 'STALE_TURN'});
  let verifiedAgain = 0;
  provider.enableMemory = async () => { verifiedAgain++; return {enabled: true, changed: false}; };
  const prepared = await memory.prepareCharacter({profileKey: 'judy'});
  assert.equal(verifiedAgain, 1); assert.equal(prepared.reconnectRequired, true);
  assert.equal(prepared.endUserId, before.endUserId); assert.equal(memory.status().talkedToCount, 0);
  if (scope === 'character') assert.equal(prepared.guard.characterEpoch, before.guard.characterEpoch + 1);
  else assert.equal(prepared.guard.resetEpoch, before.guard.resetEpoch + 1);
  memory.acknowledgeConnectionRefresh({profileKey: 'judy', guard: prepared.guard});
  assert.equal((await talk(memory, 'judy', {guard: prepared.guard})).reconnectRequired, false);
});

test('forgetting a prepared unused profile invalidates completed verification without deleting any memories', async t => {
  const {memory, provider, calls} = await fixture(t);
  const prepared = await memory.prepareCharacter({profileKey: 'judy'}); calls.length = 0;
  const cleared = await memory.clearCharacter({profileKey: 'judy', actionId: 'prepared-no-contact'});
  assert.equal(cleared.state, 'succeeded'); assert.equal(cleared.providerEmptyObserved, false);
  assert.equal(memory.isCurrent(prepared.guard), false); assert.equal(memory.status().talkedToCount, 0);
  assert.deepEqual(calls.map(row => row.kind), ['quiesce']);
  let verifies = 0;
  provider.enableMemory = async () => { verifies++; return {enabled: true, changed: false}; };
  const next = await memory.prepareCharacter({profileKey: 'judy'});
  assert.equal(verifies, 1); assert.equal(next.reconnectRequired, false);
  assert.equal(next.endUserId, prepared.endUserId); assert.equal(memory.status().talkedToCount, 0);
});

test('closing aborts invitation preparation and reopening retains identity while requiring a fresh verification', async t => {
  const gate = deferred(); let entered = false, providerSignal;
  const {memory, provider, open, path} = await fixture(t);
  const before = await fs.readFile(path, 'utf8'), identity = memory.route('judy').endUserId;
  provider.enableMemory = async ({signal}) => { entered = true; providerSignal = signal; return gate.promise; };
  const preparing = memory.prepareCharacter({profileKey: 'judy'}); preparing.catch(() => {});
  await until(() => entered); await memory.close();
  assert.equal(providerSignal.aborted, true); await assert.rejects(preparing);
  await assert.rejects(memory.prepareCharacter({profileKey: 'judy'}), {code: 'CLOSED'});
  gate.resolve({enabled: true, changed: true});
  let verifies = 0;
  provider.enableMemory = async () => { verifies++; return {enabled: true, changed: false}; };
  const reopened = await open();
  const prepared = await reopened.prepareCharacter({profileKey: 'judy'});
  assert.equal(prepared.endUserId, identity); assert.equal(verifies, 1);
  assert.equal(reopened.status().talkedToCount, 0); assert.equal(await fs.readFile(path, 'utf8'), before);
});

test('an unused-profile invitation checks registry integrity before sending any provider request', async t => {
  const {memory, path, calls} = await fixture(t);
  const guard = memory.route('judy').guard;
  await fs.writeFile(path, 'tampered');
  await assert.rejects(memory.prepareCharacter({profileKey: 'judy'}), {code: 'REGISTRY_CHANGED'});
  assert.equal(calls.length, 0); assert.equal(memory.isCurrent(guard), false);
  assert.equal(memory.status().available, false); assert.equal(memory.status().talkedToCount, 0);
  assert.equal(await fs.readFile(path, 'utf8'), 'tampered');
});

test('cached invitation verification still checks the exact identity anchor and fails closed on corruption', async t => {
  const {memory, path, calls} = await fixture(t);
  const prepared = await memory.prepareCharacter({profileKey: 'judy'}), before = await fs.readFile(path, 'utf8');
  await fs.writeFile(path + '.identity', 'broken anchor');
  await assert.rejects(memory.prepareCharacter({profileKey: 'judy'}), {code: 'IDENTITY_CHANGED'});
  assert.deepEqual(calls.map(row => row.kind), ['enable']);
  assert.equal(memory.isCurrent(prepared.guard), false); assert.equal(memory.status().available, false);
  assert.equal(memory.status().talkedToCount, 0); assert.equal(await fs.readFile(path, 'utf8'), before);
});

test('non-player sources cannot contact or enable any character', async t => {
  const {memory, calls} = await fixture(t);
  for (const source of ['warm', 'spawn', 'npc', 'battle', 'submitted']) {
    await assert.rejects(talk(memory, 'judy', {source}), {code: 'PLAYER_SEND_REQUIRED'});
  }
  assert.equal(memory.status().talkedToCount, 0); assert.equal(calls.length, 0);
});

test('concurrent admitted sends contact once, share one verified enable, and request reconnect only when needed', async t => {
  const gate = deferred(); let enables = 0;
  const {memory, provider, path} = await fixture(t);
  provider.enableMemory = async () => { enables++; return gate.promise; };
  const guard = memory.route('judy').guard;
  const conversations = Array.from({length: 8}, (_, requestId) => talk(memory, 'judy', {guard, requestId}));
  await until(() => enables === 1); gate.resolve({enabled: true, changed: true});
  const receipts = await Promise.all(conversations);
  assert.equal(enables, 1); assert.equal(memory.status().talkedToCount, 1);
  for (const receipt of receipts) {
    assert.equal(receipt.memoryEnabled, true); assert.equal(receipt.memoryEnabledNow, true);
    assert.equal(receipt.reconnectRequired, true); assert.deepEqual(receipt.guard, guard);
  }
  memory.acknowledgeConnectionRefresh({profileKey: 'judy', guard});
  const subsequent = await talk(memory, 'judy');
  assert.equal(subsequent.memoryEnabledNow, false); assert.equal(subsequent.reconnectRequired, false);
  assert.equal(Object.keys(JSON.parse(await fs.readFile(path, 'utf8')).characters).length, 1);
});

test('character clear preserves identity/contact registry, invalidates only its guard and closes before delete', async t => {
  const {memory, provider, calls, path} = await fixture(t);
  await talk(memory, 'judy'); await talk(memory, 'panam'); calls.length = 0;
  const judy = memory.route('judy'), panam = memory.route('panam');
  provider.clearMemory = async value => {
    calls.push({kind: 'clear', ...value});
    const disk = JSON.parse(await fs.readFile(path, 'utf8'));
    assert.equal(disk.actions.at(-1).quiesced, true); assert.equal(disk.actions.at(-1).targets[0].mayHaveReachedProvider, true);
    assert.equal(memory.isCurrent(judy.guard), false);
    return {accepted: true, providerEmptyObserved: true};
  };
  const command = await memory.clearCharacter({profileKey: 'judy', actionId: 'clear-judy'});
  assert.equal(command.state, 'succeeded'); assert.equal(command.providerEmptyObserved, true);
  assert.equal(memory.route('judy').endUserId, judy.endUserId); assert.equal(memory.status().talkedToCount, 2);
  assert.equal(memory.isCurrent(judy.guard), false); assert.equal(memory.isCurrent(panam.guard), true);
  assert.deepEqual(calls.map(row => row.kind), ['quiesce', 'clear']);
  assert.equal(calls[1].characterId, ids.judy); assert.equal(calls[1].endUserId, judy.endUserId);
  assert.equal(memory.route('judy').guard.characterEpoch, judy.guard.characterEpoch + 1);
});

test('clear-all targets only contacted IDs, advances global epoch and retains player UUID across reopen', async t => {
  const {memory, calls, open} = await fixture(t);
  await talk(memory, 'judy'); await talk(memory, 'panam'); memory.route('johnny');
  const before = Object.keys(ids).map(key => memory.route(key)); calls.length = 0;
  const result = await memory.clearAll({actionId: 'clear-all'});
  assert.equal(result.state, 'succeeded'); assert.equal(memory.status().talkedToCount, 2);
  assert.deepEqual(calls.filter(row => row.kind === 'clear').map(row => row.characterId).sort(), [ids.judy, ids.panam].sort());
  assert.ok(before.every(route => !memory.isCurrent(route.guard)));
  for (const key of Object.keys(ids)) assert.equal(memory.route(key).endUserId, before[0].endUserId);
  await memory.close(); const reopened = await open();
  assert.equal(reopened.route('johnny').endUserId, before[0].endUserId);
  assert.equal(reopened.route('johnny').guard.resetEpoch, before[0].guard.resetEpoch + 1);
  assert.equal(reopened.status().talkedToCount, 2);
});

test('forgetting an uncontacted character resets its warm guard without provider operations or contact', async t => {
  const {memory, calls} = await fixture(t);
  const before = memory.route('johnny');
  const result = await memory.clearCharacter({profileKey: 'johnny', actionId: 'never-talked'});
  assert.equal(result.state, 'succeeded'); assert.equal(result.providerEmptyObserved, false);
  assert.equal(memory.status().talkedToCount, 0); assert.equal(memory.isCurrent(before.guard), false);
  assert.deepEqual(calls.map(row => row.kind), ['quiesce']);
});

test('an in-flight enable is invalidated by clear and a late provider resolution cannot make it current', async t => {
  const gate = deferred(); let entered = false;
  const {memory, provider} = await fixture(t);
  provider.enableMemory = async () => { entered = true; return gate.promise; };
  const before = memory.route('judy');
  const sending = talk(memory, 'judy'); sending.catch(() => {});
  await until(() => entered);
  const clearing = memory.clearCharacter({profileKey: 'judy', actionId: 'enable-race'});
  assert.equal(memory.isCurrent(before.guard), false);
  assert.throws(() => memory.route('judy'), {code: 'MEMORY_CLEAR_PENDING'});
  await clearing; await assert.rejects(sending);
  gate.resolve({enabled: true, changed: true});
  provider.enableMemory = async () => ({enabled: true, changed: false});
  const next = await talk(memory, 'judy'); assert.equal(next.endUserId, before.endUserId);
  assert.equal(next.reconnectRequired, true); assert.equal(next.memoryEnabledNow, false);
});

test('pre-cancelled admission writes nothing; a cancelled wait is bounded even when provider ignores signal', async t => {
  const {memory, provider, calls} = await fixture(t, {timeoutMs: 40});
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(talk(memory, 'judy', {signal: cancelled.signal}), {code: 'CANCELLED'});
  assert.equal(calls.length, 0); assert.equal(memory.status().talkedToCount, 0);
  const signal = new AbortController(); let entered = false;
  provider.enableMemory = async () => { entered = true; return new Promise(() => {}); };
  const sending = talk(memory, 'judy', {signal: signal.signal}); sending.catch(() => {});
  await until(() => entered); signal.abort(); await assert.rejects(sending, {code: 'CANCELLED'});
});

test('enable timeout never admits a send and the next verified enable requires reconnect', async t => {
  const {memory, provider} = await fixture(t, {timeoutMs: 25});
  provider.enableMemory = () => new Promise(() => {});
  const before = memory.route('judy');
  await assert.rejects(talk(memory, 'judy'), {code: 'TIMEOUT'});
  provider.enableMemory = async () => ({enabled: true, changed: false});
  const next = await talk(memory, 'judy');
  assert.equal(next.reconnectRequired, true); assert.equal(next.memoryEnabledNow, false);
  assert.deepEqual(next.guard, before.guard);
});

test('failed local quiesce invalidates guard but never deletes provider memory', async t => {
  const {memory, calls} = await fixture(t, {quiesce: async () => ({quiesced: false})});
  await talk(memory, 'judy'); calls.length = 0;
  const before = memory.route('judy').guard;
  const result = await memory.clearCharacter({profileKey: 'judy', actionId: 'close-failed'});
  assert.equal(result.state, 'failed'); assert.equal(result.uncertain, false); assert.equal(calls.length, 0);
  assert.equal(memory.isCurrent(before), false); assert.equal(memory.route('judy').guard.characterEpoch, 1);
});

test('accepted but unconfirmed clear persists, blocks sends and never retries on repeat or reopen', async t => {
  const {memory, provider, calls, open} = await fixture(t);
  await talk(memory, 'judy');
  provider.clearMemory = async value => { calls.push({kind: 'clear', ...value}); return {accepted: true, providerEmptyObserved: false}; };
  const first = await memory.clearCharacter({profileKey: 'judy', actionId: 'unconfirmed'});
  assert.equal(first.state, 'failed'); assert.equal(first.uncertain, true);
  assert.throws(() => memory.route('judy'), {code: 'MEMORY_CLEAR_PENDING'});
  await assert.rejects(memory.beginConversation({profileKey: 'judy'}), {code: 'MEMORY_CLEAR_PENDING'});
  await assert.rejects(memory.prepareCharacter({profileKey: 'judy'}), {code: 'MEMORY_CLEAR_PENDING'});
  const before = calls.length;
  assert.deepEqual(await memory.clearCharacter({profileKey: 'judy', actionId: 'unconfirmed'}), first);
  await memory.close(); const reopened = await open();
  assert.equal(calls.length, before); assert.deepEqual(reopened.status({actionId: 'unconfirmed'}).command, first);
  assert.throws(() => reopened.route('judy'), {code: 'MEMORY_CLEAR_PENDING'});
});

test('explicit retry can resolve uncertainty; definitive failure in between cannot silently unblock it', async t => {
  const {memory, provider} = await fixture(t);
  const identity = memory.route('judy').endUserId; await talk(memory, 'judy');
  provider.clearMemory = async () => { throw Object.assign(Error('provider secret'), {code: 'TIMEOUT', writeUncertain: true}); };
  await memory.clearCharacter({profileKey: 'judy', actionId: 'uncertain-first'});
  provider.clearMemory = async () => { throw Object.assign(Error('provider secret'), {code: 'NOT_MOD_OWNED', writeUncertain: false}); };
  const failed = await memory.clearCharacter({profileKey: 'judy', actionId: 'definite-second'});
  assert.equal(failed.uncertain, false); assert.throws(() => memory.route('judy'), {code: 'MEMORY_CLEAR_PENDING'});
  provider.clearMemory = async () => ({accepted: true, providerEmptyObserved: true});
  const recovered = await memory.clearCharacter({profileKey: 'judy', actionId: 'explicit-third'});
  assert.equal(recovered.state, 'succeeded'); assert.equal(memory.route('judy').endUserId, identity);
  assert.equal(memory.status().actions.length, 3); assert.equal(memory.status().talkedToCount, 1);
});

test('clear-all retains successful target evidence while blocking only unresolved contacted targets', async t => {
  const {memory, provider} = await fixture(t);
  await talk(memory, 'judy'); await talk(memory, 'panam');
  provider.clearMemory = async ({characterId}) => ({accepted: true, providerEmptyObserved: characterId === ids.judy});
  const result = await memory.clearAll({actionId: 'partial-all'});
  assert.equal(result.state, 'failed'); assert.equal(result.uncertain, true);
  assert.equal(memory.route('judy').guard.resetEpoch, 1);
  assert.throws(() => memory.route('panam'), {code: 'MEMORY_CLEAR_PENDING'});
  assert.equal(memory.route('johnny').guard.resetEpoch, 1);
});

test('same in-flight action is idempotent, conflicting reuse and overlap fail before a second delete', async t => {
  const gate = deferred(); let deletes = 0;
  const {memory, provider} = await fixture(t);
  await talk(memory, 'judy'); await talk(memory, 'panam');
  provider.clearMemory = async () => { deletes++; return gate.promise; };
  const one = memory.clearCharacter({profileKey: 'judy', actionId: 'one-action'});
  const repeated = memory.clearCharacter({profileKey: 'judy', actionId: 'one-action'});
  assert.equal(one, repeated);
  assert.throws(() => memory.clearAll({actionId: 'one-action'}), {code: 'ACTION_CONFLICT'});
  assert.throws(() => memory.clearCharacter({profileKey: 'judy', actionId: 'overlap'}), {code: 'CLEAR_IN_PROGRESS'});
  await until(() => deletes === 1); gate.resolve({accepted: true, providerEmptyObserved: true});
  await one; assert.equal(deletes, 1);
});

test('independent character clears serialize durable writes without losing either epoch', async t => {
  const {memory, path} = await fixture(t);
  await talk(memory, 'judy'); await talk(memory, 'panam');
  const results = await Promise.all([
    memory.clearCharacter({profileKey: 'judy', actionId: 'parallel-judy'}),
    memory.clearCharacter({profileKey: 'panam', actionId: 'parallel-panam'})
  ]);
  assert.ok(results.every(row => row.state === 'succeeded'));
  const disk = JSON.parse(await fs.readFile(path, 'utf8'));
  assert.equal(disk.characters[ids.judy].characterEpoch, 1); assert.equal(disk.characters[ids.panam].characterEpoch, 1);
  assert.equal(disk.actions.length, 2); assert.equal(memory.status().talkedToCount, 2);
});

test('explicit recovery performs list-only work, preserves UUID and completes only the requested action', async t => {
  const {memory, provider, calls} = await fixture(t);
  const identity = memory.route('judy').endUserId; await talk(memory, 'judy');
  provider.clearMemory = async () => ({accepted: true, providerEmptyObserved: false});
  await memory.clearCharacter({profileKey: 'judy', actionId: 'recover-explicit'}); calls.length = 0;
  const result = await memory.recoverClear({actionId: 'recover-explicit'});
  assert.equal(result.id, 'recover-explicit'); assert.equal(result.state, 'succeeded');
  assert.deepEqual(calls.map(row => row.kind), ['quiesce', 'inspect']);
  assert.equal(memory.route('judy').endUserId, identity);
});

test('malformed/ambiguous established files fail closed and are never silently restored or replaced', async t => {
  const {memory, path, open} = await fixture(t);
  const anchor = await fs.readFile(path + '.identity', 'utf8'); await memory.close();
  await fs.writeFile(path, '{broken');
  await assert.rejects(open(), {code: 'CORRUPT_REGISTRY'});
  assert.equal(await fs.readFile(path + '.identity', 'utf8'), anchor);
  assert.equal(await fs.readFile(path, 'utf8'), '{broken');
});

test('missing either established file refuses a new identity and obsolete ledgers are never read', async t => {
  const {memory, path, directory, open} = await fixture(t);
  const anchor = await fs.readFile(path + '.identity', 'utf8'); await memory.close();
  await fs.writeFile(join(directory, 'quest-memory.json'), 'user-owned obsolete ledger');
  await fs.unlink(path); await assert.rejects(open(), {code: 'MISSING_ESTABLISHED_REGISTRY'});
  assert.equal(await fs.readFile(path + '.identity', 'utf8'), anchor);
  assert.equal(await fs.readFile(join(directory, 'quest-memory.json'), 'utf8'), 'user-owned obsolete ledger');
});

test('identity disagreement is corruption rather than authorization to rotate the player', async t => {
  const {memory, path, open} = await fixture(t); await memory.close();
  const disk = JSON.parse(await fs.readFile(path, 'utf8')); disk.endUserId = randomUUID();
  await fs.writeFile(path, JSON.stringify(disk));
  await assert.rejects(open(), {code: 'CORRUPT_REGISTRY'});
});

test('external registry tampering during execution disables routing instead of overwriting corruption', async t => {
  const {memory, path, calls} = await fixture(t);
  const guard = memory.route('judy').guard; await fs.writeFile(path, 'tampered');
  await assert.rejects(talk(memory, 'judy'), {code: 'REGISTRY_CHANGED'});
  assert.equal(memory.isCurrent(guard), false); assert.equal(memory.status().available, false);
  assert.equal(calls.length, 0); assert.equal(await fs.readFile(path, 'utf8'), 'tampered');
});

test('atomic rename failure retains last durable identity/state and admits no provider operation', async t => {
  let failRename = false;
  const files = {...fs, rename: async (...args) => { if (failRename && args[1].endsWith('player-memory.json')) throw Object.assign(Error('disk secret'), {code: 'EIO'}); return fs.rename(...args); }};
  const {memory, path, directory, calls, open} = await fixture(t, {fsImpl: files});
  const before = await fs.readFile(path, 'utf8'), identity = memory.route('judy').endUserId;
  failRename = true; await assert.rejects(talk(memory, 'judy'), {code: 'STORAGE_FAILURE'});
  assert.equal(await fs.readFile(path, 'utf8'), before); assert.equal(calls.length, 0);
  assert.ok(!(await fs.readdir(directory)).some(name => name.endsWith('.tmp')));
  await memory.close(); failRename = false; const reopened = await open({fsImpl: fs});
  assert.equal(reopened.route('judy').endUserId, identity); assert.equal(reopened.status().talkedToCount, 0);
});

test('interrupted dispatched clear is terminal uncertain on reopen and startup never retries it', async t => {
  const {memory, provider, path, calls, open} = await fixture(t);
  await talk(memory, 'judy'); const identity = memory.route('judy').endUserId;
  let entered = false;
  provider.clearMemory = () => { entered = true; return new Promise(() => {}); };
  const clear = memory.clearCharacter({profileKey: 'judy', actionId: 'interrupted'}); clear.catch(() => {});
  await until(() => entered);
  assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).actions.at(-1).state, 'pending');
  await memory.close(); await assert.rejects(clear); const before = calls.length;
  const reopened = await open(); assert.equal(calls.length, before);
  const action = reopened.status({actionId: 'interrupted'}).command;
  assert.equal(action.state, 'failed'); assert.equal(action.uncertain, true);
  assert.throws(() => reopened.route('judy'), {code: 'MEMORY_CLEAR_PENDING'});
  assert.equal(JSON.parse(await fs.readFile(path + '.identity', 'utf8')).endUserId, identity);
});

test('single-writer lock prevents concurrent identities and malformed locks fail closed', async t => {
  const {memory, open, path} = await fixture(t);
  const id = memory.route('judy').endUserId;
  await assert.rejects(open(), {code: 'REGISTRY_LOCKED'}); await memory.close();
  const candidates = await Promise.allSettled([open(), open()]);
  assert.equal(candidates.filter(row => row.status === 'fulfilled').length, 1);
  const winner = candidates.find(row => row.status === 'fulfilled').value;
  assert.equal(winner.route('judy').endUserId, id); await winner.close();
  await fs.writeFile(path + '.lock', ''); await assert.rejects(open(), {code: 'LOCK_UNCERTAIN'});
});

test('bounded clear timeout and provider errors never leak identities, text, paths or raw provider messages', async t => {
  const {memory, provider} = await fixture(t, {timeoutMs: 25});
  await talk(memory, 'judy'); const identity = memory.route('judy').endUserId;
  provider.clearMemory = () => new Promise(() => {});
  const result = await memory.clearCharacter({profileKey: 'judy', actionId: 'timeout-clear'});
  assert.equal(result.state, 'failed'); assert.equal(result.uncertain, true);
  const status = JSON.stringify(memory.status());
  assert.ok(!status.includes(identity)); assert.ok(!status.includes(ids.judy));
  provider.enableMemory = async () => { throw Error('secret key / private conversation text'); };
  await assert.rejects(talk(memory, 'panam'), error => {
    assert.ok(error instanceof PlayerMemoryError); assert.ok(!error.message.includes('secret'));
    assert.ok(!error.message.includes(identity)); return true;
  });
});

test('verified contacts still fail closed when the durable identity is corrupted between actual sends', async t => {
  const {memory, path, calls} = await fixture(t);
  await talk(memory, 'judy'); const count = calls.length;
  await fs.writeFile(path + '.identity', 'broken anchor');
  await assert.rejects(talk(memory, 'judy'), {code: 'IDENTITY_CHANGED'});
  assert.equal(calls.length, count); assert.equal(memory.status().available, false);
});

test('interrupted initialization preserves its anchored UUID and refuses replacement on reopen', async t => {
  const {directory, open, calls} = await fixture(t);
  const path = join(directory, 'fresh', 'player-memory.json');
  const files = {...fs, rename: async (from, to) => {
    if (to === path) throw Object.assign(Error('write failed'), {code: 'EIO'});
    return fs.rename(from, to);
  }};
  await assert.rejects(open({path, fsImpl: files}), {code: 'STORAGE_FAILURE'});
  const anchor = await fs.readFile(path + '.identity', 'utf8');
  await assert.rejects(open({path}), {code: 'MISSING_ESTABLISHED_REGISTRY'});
  assert.equal(await fs.readFile(path + '.identity', 'utf8'), anchor); assert.equal(calls.length, 0);
});

test('global clears overlap even with an empty mapping; a second command cannot bypass the operation fence', async t => {
  const gate = deferred();
  const {memory} = await fixture(t, {characterIds: {}, quiesce: () => gate.promise});
  const first = memory.clearAll({actionId: 'empty-first'});
  assert.throws(() => memory.clearAll({actionId: 'empty-second'}), {code: 'CLEAR_IN_PROGRESS'});
  gate.resolve({quiesced: true}); assert.equal((await first).state, 'succeeded');
});

test('read-only recovery advances reset epochs and cannot race an overlapping destructive command', async t => {
  const {memory, provider} = await fixture(t); await talk(memory, 'judy');
  const original = memory.route('judy').guard;
  provider.clearMemory = async () => ({accepted: true, providerEmptyObserved: false});
  await memory.clearCharacter({profileKey: 'judy', actionId: 'recovery-fence'});
  const gate = deferred(); let entered = false;
  provider.inspectMemory = async () => { entered = true; return gate.promise; };
  const recovery = memory.recoverClear({actionId: 'recovery-fence'});
  assert.throws(() => memory.clearCharacter({profileKey: 'judy', actionId: 'racing-clear'}), {code: 'CLEAR_IN_PROGRESS'});
  await until(() => entered); assert.throws(() => memory.route('judy'), {code: 'MEMORY_CLEAR_PENDING'});
  gate.resolve({providerEmptyObserved: true}); assert.equal((await recovery).state, 'succeeded');
  assert.equal(memory.route('judy').guard.characterEpoch, original.characterEpoch + 2);
});

test('restart resolves a pre-dispatch interrupted intent locally without claiming an uncertain delete', {timeout: 10000}, async t => {
  const gate = deferred(), entered = deferred();
  const {memory, path, calls, open} = await fixture(t, {quiesce: () => { entered.resolve(); return gate.promise; }});
  await talk(memory, 'judy');
  const clearing = memory.clearCharacter({profileKey: 'judy', actionId: 'pre-dispatch-crash'}); clearing.catch(() => {});
  // Wait for the actual callback after its durable intent write. An early
  // settlement fails immediately; the test deadline bounds a stalled write.
  await Promise.race([entered.promise, clearing.then(() => assert.fail('Clear settled before its quiesce callback'))]);
  const pending = JSON.parse(await fs.readFile(path, 'utf8')).actions.at(-1);
  assert.equal(pending.state, 'pending'); assert.equal(pending.quiesced, false);
  assert.ok(pending.targets.every(target => target.mayHaveReachedProvider === false));
  assert.ok(!calls.some(call => call.kind === 'clear'));
  await memory.close(); await assert.rejects(clearing);
  const before = calls.length, reopened = await open({quiesce: async () => ({quiesced: true})});
  assert.equal(calls.length, before);
  assert.equal(reopened.status().command.state, 'failed'); assert.equal(reopened.status().command.uncertain, false);
  assert.equal(reopened.route('judy').guard.characterEpoch, 1);
});

test('a session-only (ambient) player send records the Forget target locally and never verifies or enables provider memory', async t => {
  const {memory, path, calls} = await fixture(t);
  const route = memory.route('judy');
  const receipt = await memory.beginSessionConversation({profileKey: 'judy', guard: route.guard, source: 'player', requestId: 'resident-turn'});
  assert.equal(receipt.memoryEnabled, false); assert.equal(receipt.reconnectRequired, false);
  assert.deepEqual(receipt.guard, route.guard);
  assert.deepEqual(calls, [], 'no enable, inspect or seed call for an ambient profile');
  assert.equal(memory.connectionRefreshRequired({profileKey: 'judy', guard: route.guard}), false);
  const first = await fs.readFile(path, 'utf8');
  await memory.beginSessionConversation({profileKey: 'judy', guard: route.guard, requestId: 'resident-turn-2'});
  assert.equal(await fs.readFile(path, 'utf8'), first, 'a later turn only checks the registry');
  await assert.rejects(memory.beginSessionConversation({profileKey: 'judy', guard: route.guard, source: 'npc'}), {code: 'PLAYER_SEND_REQUIRED'});
  await assert.rejects(memory.beginSessionConversation({profileKey: 'judy', guard: memory.route('panam').guard}), {code: 'STALE_TURN'});
  await memory.clearAll({actionId: 'forget-after-resident'});
  assert.deepEqual(calls.filter(row => row.kind === 'clear').map(row => row.characterId), [ids.judy], 'Forget all still covers it');
});

test('bridge admission takes the session-only fast path for ambient routes and reports the memory stage', async t => {
  const {memory, calls} = await fixture(t);
  const source = await fs.readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function admitPlayerConversation('), source.indexOf('async function pollMicrophone()'));
  const retired = [];
  const admit = runInNewContext('(' + body + ')', {playerMemory: memory, mistral: {active: false}, knowledgeRouter: {current: async () => true},
    intrinsicHistory: new IntrinsicCharacterContext([]),
    connections: {needsRetirement: () => false, retireInvitation: async profile => { retired.push(profile); }},
    throwIfCancelled: signal => { if (signal?.aborted) throw Error('Cancelled'); }});
  const ambient = {sendAllowed: true, providerMemory: 'session-only', route: {profileKey: 'judy', channel: 'private', transport: 'private'},
    guard: memory.route('judy').guard, input: {requestId: 'resident-1', text: 'Hey'}};
  const started = Date.now();
  const receipt = await admit(ambient);
  assert.equal(receipt.reconnectRequired, false); assert.equal(receipt.memory.mode, 'session-only');
  assert.ok(Number.isFinite(receipt.memory.beginMs) && receipt.memory.beginMs >= 0);
  assert.ok(Date.now() - started < 1000, 'the ambient admission is local');
  assert.deepEqual(calls, [], 'an ambient turn never contacts the memory provider');
  assert.deepEqual(retired, []);
  assert.deepEqual(memory.status().characters.map(row => row.profileKey), ['judy']);
  // A named character still verifies (and on a change, refreshes) through the provider path.
  const named = {...ambient, providerMemory: undefined, route: {...ambient.route, profileKey: 'panam'},
    guard: memory.route('panam').guard, input: {requestId: 'panam-1', text: 'Hey'}};
  const host = {refreshIdle: async () => true};
  const namedAdmit = runInNewContext('(' + body + ')', {playerMemory: memory, mistral: {active: false}, knowledgeRouter: {current: async () => true},
    intrinsicHistory: new IntrinsicCharacterContext([]), realtime: host, phoneRealtime: host,
    connections: {needsRetirement: () => false, retireInvitation: async profile => { retired.push(profile); }},
    realtimeConfig: () => ({}), localVoice: {playbackEnabled: true}, turnUsesLocal: () => false,
    throwIfCancelled: signal => { if (signal?.aborted) throw Error('Cancelled'); }});
  const provider = await namedAdmit(named);
  assert.equal(provider.memory.mode, 'provider'); assert.equal(provider.reconnectRequired, true);
  assert.ok(provider.memory.refreshMs >= 0);
  assert.deepEqual(calls.map(row => row.kind), ['enable']); assert.deepEqual(retired, ['panam']);
});
