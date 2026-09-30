import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PlayerMemory, PlayerMemoryError} from './player-memory.mjs';

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

test('restart resolves a pre-dispatch interrupted intent locally without claiming an uncertain delete', async t => {
  const gate = deferred(); let entered = false;
  const {memory, calls, open} = await fixture(t, {quiesce: () => { entered = true; return gate.promise; }});
  await talk(memory, 'judy');
  const clearing = memory.clearCharacter({profileKey: 'judy', actionId: 'pre-dispatch-crash'}); clearing.catch(() => {});
  await until(() => entered); await memory.close(); await assert.rejects(clearing);
  const before = calls.length, reopened = await open({quiesce: async () => ({quiesced: true})});
  assert.equal(calls.length, before);
  assert.equal(reopened.status().command.state, 'failed'); assert.equal(reopened.status().command.uncertain, false);
  assert.equal(reopened.route('judy').guard.characterEpoch, 1);
});
