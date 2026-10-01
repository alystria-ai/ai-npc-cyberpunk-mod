import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CompanionInvitations, parseCompanionInvitations} from './companion-invitations.mjs';
import {PartyConnections, CONNECTION_LIMIT} from './party-connections.mjs';
import {PlayerMemory} from './player-memory.mjs';
import {abortable, transportKey} from './transport-pool.mjs';

const flush = () => new Promise(done => setImmediate(done));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const ids = Object.freeze({judy: 'owned-judy', panam: 'owned-panam', alex: 'owned-alex',
  kerry: 'owned-kerry', viktor: 'owned-viktor', misty: 'owned-misty', river: 'owned-river', jackie: 'owned-jackie'});
function ticket(id = 'queued:1', profileKey, extra = {}) {
  if (arguments.length < 2) profileKey = 'judy';
  return {id, revision: 1, modelKey: 'judy-model', ...(profileKey === undefined ? {} : {profileKey}), phase: 'preparing', ...extra};
}
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Expected event was not reached'); await flush(); }
}

function fixture(t, {memory: actualMemory, prepareVoice, voiceCurrent} = {}) {
  let time = 100000, world = {worldToken: 'world-1', generation: 1}, allowed = true;
  const memoryCalls = [], warmCalls = [], refreshes = [], retentions = [], publications = [], acknowledgements = [], live = new Map();
  const memoryGates = new Map(), warmGates = new Map(), epochs = new Map();
  const preparedProfiles = new Set(), refreshRequirements = new Set();
  const memory = actualMemory || {
    ignoreAbort: false,
    route(profileKey) {
      return {endUserId: 'private-player-identity', guard: {endUserId: 'private-player-identity',
        characterId: ids[profileKey], resetEpoch: 0, characterEpoch: epochs.get(profileKey) || 0}};
    },
    isCurrent(guard) {
      const key = Object.keys(ids).find(key => ids[key] === guard.characterId);
      return key !== undefined && guard.characterEpoch === (epochs.get(key) || 0);
    },
    async prepareCharacter(input) {
      memoryCalls.push(input);
      const gate = memoryGates.get(input.profileKey);
      if (gate) await (memory.ignoreAbort ? gate.promise : abortable(gate.promise, input.signal));
      if (!preparedProfiles.has(input.profileKey)) refreshRequirements.add(input.profileKey);
      preparedProfiles.add(input.profileKey);
      return {endUserId: input.guard.endUserId, guard: input.guard, memoryEnabled: true,
        reconnectRequired: refreshRequirements.has(input.profileKey)};
    },
    connectionRefreshRequired({profileKey, guard}) {
      assert.equal(memory.isCurrent(guard), true);
      return refreshRequirements.has(profileKey);
    },
    acknowledgeConnectionRefresh(input) {
      assert.equal(memory.isCurrent(input.guard), true); assert.equal(preparedProfiles.has(input.profileKey), true);
      acknowledgements.push(input); refreshRequirements.delete(input.profileKey);
      return true;
    },
    beginConversation() { throw Error('Invitations must not record contact'); }
  };
  const configFor = (profileKey, scope) => ({key: 'private-provider-key', characterId: ids[profileKey], scope,
    endUserId: memory.route(profileKey).endUserId, sessionId: 'private-session', ttsEnabled: true});
  const host = {
    async retain(configs, options) {
      assert.equal(options.protect, true); assert.ok(configs.length <= CONNECTION_LIMIT);
      retentions.push(configs);
      const wanted = new Set(configs.map(transportKey));
      for (const key of live.keys()) if (!wanted.has(key)) live.delete(key);
    },
    async warm(config, {signal}) {
      warmCalls.push({config, signal, at: time});
      const gate = warmGates.get(config.characterId);
      if (gate) await abortable(gate.promise, signal);
      if (signal.aborted) throw Error('cancelled');
      const key = transportKey(config);
      if (!live.has(key)) live.set(key, {config, ready: true});
      return {connectionMs: 20};
    },
    async readiness(config, {keepAlive}) {
      assert.equal(keepAlive, true);
      const page = live.get(transportKey(config));
      return {present: !!page, ready: page?.ready === true, busy: page?.busy === true};
    },
    async refreshIdle(config) {
      refreshes.push(config);
      const key = transportKey(config);
      if (live.get(key)?.busy) return false;
      live.delete(key); return true;
    },
    async reply(config) {
      const page = live.get(transportKey(config));
      assert.ok(page?.ready, 'the actual send must reuse the prepared private page');
      return {text: 'submitted reply', page, timing: {pageReused: true}};
    },
    close() { throw Error('Invitations must not reset the shared host'); }
  };
  const connections = new PartyConnections({host, configFor, now: () => time,
    isKnown: key => Object.hasOwn(ids, key), canWarm: () => allowed});
  const invitations = new CompanionInvitations({memory, connections, now: () => time, currentWorld: () => world,
    ...(prepareVoice ? {prepareVoice} : {}),
    ...(voiceCurrent ? {voiceCurrent} : {}),
    isKnown: key => Object.hasOwn(ids, key), publish: async (value, options) => {
      assert.equal(options.isCurrentSync(), true); publications.push(value); return true;
    }});
  const ingest = (rows, extra = {}) => invitations.ingest({version: 1, ...world, updated: time, invitations: rows, ...extra});
  const poll = async (ms = 0) => { time += ms; ingest([...invitations.rows.values()].map(({id, revision, modelKey, profileKey, phase}) =>
    ({id, revision, modelKey, ...(profileKey !== undefined ? {profileKey} : {}), phase}))); return invitations.poll(); };
  t.after(async () => {
    await invitations.clear('service-stopped'); await connections.clear();
    for (const gate of [...memoryGates.values(), ...warmGates.values()]) gate.resolve();
    await flush();
  });
  return {invitations, connections, host, memory, memoryCalls, warmCalls, refreshes, retentions, publications, acknowledgements,
    memoryGates, warmGates, epochs, live, configFor, ingest, poll, now: () => time,
    tick: ms => { time += ms; }, world: value => { world = value; }, gate: value => { allowed = value; }};
}

async function actualFixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'companion-invitations-'));
  const path = join(directory, 'player-memory.json'), enables = [], enableGate = deferred();
  const memory = await PlayerMemory.open({path, characterIds: ids,
    provider: {enableMemory: async input => { enables.push(input); await enableGate.promise; return {enabled: true, changed: true}; }}});
  t.after(async () => { await memory.close(); await fs.rm(directory, {recursive: true, force: true}); });
  return {...fixture(t, {memory}), path, enables, enableGate};
}

test('invitation protocol rejects stale, malformed, duplicated or oversized tickets and binds the exact world', () => {
  const value = {version: 1, worldToken: 'world-1', generation: 1, updated: 10000, invitations: [ticket()]};
  assert.deepEqual(parseCompanionInvitations(value, 10000), value);
  for (const change of [{version: 2}, {worldToken: ''}, {generation: -1}, {generation: 0}, {updated: 16000}, {updated: 3499},
    {invitations: [ticket(), ticket()]}, {invitations: Array.from({length: 9}, (_, n) => ticket('queued:' + n))},
    {invitations: [ticket('bad/id')]}, {invitations: [ticket('queued:1', 'bad/key')]},
    {invitations: [ticket('queued:1', 'judy', {revision: 0})]}, {invitations: [ticket('queued:1', 'judy', {phase: 'ready'})]},
    {invitations: [ticket('queued:1', 'judy', {modelKey: 'bad/model'})]}]) {
    assert.equal(parseCompanionInvitations({...value, ...change}, 10000), null);
  }
  assert.ok(parseCompanionInvitations({...value, updated: 3500}, 10000));
  assert.ok(parseCompanionInvitations({...value, invitations: [ticket('queued:1', undefined, {modelKey: 'model:6000'})]}, 10000));
});

test('model-only readiness performs no AI work and an unknown explicit profile fails closed', async t => {
  const f = fixture(t);
  f.ingest([ticket('queued:1', undefined), ticket('queued:2', 'unknown')]);
  const state = await f.invitations.poll();
  assert.equal(state.invitations[0].state, 'ready'); assert.equal(Object.hasOwn(state.invitations[0], 'profileKey'), false);
  assert.equal(state.invitations[1].state, 'error'); assert.match(state.invitations[1].error, /unavailable/);
  assert.equal(f.memoryCalls.length, 0); assert.equal(f.warmCalls.length, 0);
  assert.equal(f.retentions.length, 0);
  f.world(null); assert.equal(f.invitations.ingest(undefined), null);
  const absent = await f.invitations.poll();
  assert.equal(absent.worldToken, null); assert.equal(absent.generation, null); assert.deepEqual(absent.invitations, []);
});

test('memory verification and warm readiness are causal prerequisites and polling never waits for those flights', async t => {
  const f = await actualFixture(t), warming = deferred();
  f.warmGates.set(ids.judy, warming);
  const before = await fs.readFile(f.path, 'utf8');
  f.ingest([ticket()]); await until(() => f.enables.length === 1);
  let finished = false;
  const early = f.invitations.poll().then(value => { finished = true; return value; });
  await flush(); assert.equal(finished, true, 'memory preflight must not block the polling loop');
  assert.equal((await early).invitations[0].state, 'memory');
  assert.equal(f.warmCalls.length, 0); assert.deepEqual(f.connections.invitations, []);
  assert.equal(f.memory.status().talkedToCount, 0); assert.equal(await fs.readFile(f.path, 'utf8'), before);
  f.tick(1500); f.enableGate.resolve(); await until(() => f.warmCalls.length === 1);
  finished = false;
  const connecting = f.invitations.poll().then(value => { finished = true; return value; });
  await flush(); assert.equal(finished, true, 'SDK startup must not block the polling loop');
  assert.equal((await connecting).invitations[0].state, 'connecting');
  assert.deepEqual(f.connections.invitations, ['judy']); assert.equal(f.memory.status().talkedToCount, 0);
  f.tick(1200); warming.resolve(); await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  const ready = await f.invitations.poll(); assert.equal(ready.invitations[0].state, 'ready');
  assert.equal(await fs.readFile(f.path, 'utf8'), before);
  const timing = f.invitations.diagnostic().invitations[0];
  assert.equal(timing.memoryMs, 1500); assert.equal(timing.warmMs, 1200);
  const report = JSON.stringify(f.invitations.diagnostic());
  for (const secret of [f.memory.route('judy').endUserId, ids.judy, 'private-provider-key', 'private-session']) assert.ok(!report.includes(secret));
});

test('duplicate copies share preparation and hand the retained page to the party before the first actual send', async t => {
  const f = await actualFixture(t);
  f.ingest([ticket('queued:1'), ticket('queued:2')]); await until(() => f.enables.length === 1);
  f.enableGate.resolve(); await until(() => f.invitations.snapshot().invitations.every(row => row.state === 'ready'));
  assert.equal(f.enables.length, 1); assert.equal(f.warmCalls.length, 1); assert.equal(f.memory.status().talkedToCount, 0);
  const key = transportKey(f.configFor('judy', 'private')), page = f.live.get(key);
  f.ingest([ticket('queued:1', 'judy', {phase: 'spawned'}), ticket('queued:2')]);
  await f.invitations.poll(); assert.equal(f.live.get(key), page); assert.equal(f.warmCalls.length, 1);
  f.connections.ingest({updated: f.now(), profiles: ['judy', 'judy']});
  f.ingest([]); await f.invitations.poll(); await f.connections.maintain(); await flush();
  assert.equal(f.live.get(key), page); assert.equal(f.warmCalls.length, 1);
  const admitted = await f.memory.beginConversation({profileKey: 'judy', guard: f.memory.route('judy').guard, source: 'player'});
  assert.equal(admitted.reconnectRequired, false); assert.equal(admitted.memoryEnabledNow, false);
  const reply = await f.host.reply(f.configFor('judy', 'private'));
  assert.equal(reply.page, page); assert.equal(reply.timing.pageReused, true);
  assert.equal(f.enables.length, 1); assert.equal(f.refreshes.length, 0); assert.equal(f.memory.status().talkedToCount, 1);
  f.connections.ingest({updated: f.now(), profiles: []}); await f.connections.maintain(); assert.equal(f.live.size, 0);
});

test('speaker conditioning gates both copies and connection startup without blocking polling', async t => {
  const gate = deferred(), calls = [];
  const f = fixture(t, {prepareVoice: async (profile, options) => {
    calls.push({profile, ...options}); await abortable(gate.promise, options.signal);
    return {provider: 'omnivoice', ready: true, profile};
  }});
  f.ingest([ticket('queued:1'), ticket('queued:2')]); await until(() => calls.length === 1);
  assert.equal(calls[0].profile, 'judy'); assert.equal(f.warmCalls.length, 0);
  assert.deepEqual(f.connections.invitations, []);
  assert.ok((await f.invitations.poll()).invitations.every(row => row.state !== 'ready'));
  f.tick(240); gate.resolve(); await until(() => f.invitations.snapshot().invitations.every(row => row.state === 'ready'));
  assert.equal(calls.length, 1); assert.equal(f.warmCalls.length, 1);
  assert.equal(f.invitations.diagnostic().invitations[0].voiceMs, 240);
  assert.equal(f.invitations.diagnostic().invitations[0].voiceProvider, 'omnivoice');
});

test('voice failures and wrong-speaker receipts never grant spawn permission or warm a page', async t => {
  for (const result of [{provider:'omnivoice', ready:true, profile:'panam'},
    {provider:'omnivoice', ready:false, profile:'judy'}, {provider:'unknown',ready:true}, null]) {
    const f = fixture(t, {prepareVoice: async () => result});
    f.ingest([ticket()]); await until(() => f.invitations.snapshot().invitations[0].state === 'error');
    assert.match(f.invitations.snapshot().invitations[0].error, /Voice preparation/);
    assert.equal(f.warmCalls.length, 0); assert.deepEqual(f.connections.invitations, []);
  }
});

test('cancel or world replacement during voice preparation fences late completion', async t => {
  for (const replaceWorld of [false, true]) {
    const gate = deferred(), calls = [];
    const f = fixture(t, {prepareVoice: async (profile, options) => {
      calls.push(options); await gate.promise; return {provider:'omnivoice',ready:true,profile};
    }});
    f.ingest([ticket()]); await until(() => calls.length === 1);
    if (replaceWorld) { f.world({worldToken:'replacement-world',generation:2}); await f.invitations.poll(); }
    else f.ingest([]);
    assert.equal(calls[0].signal.aborted, true); gate.resolve(); await flush(); await flush();
    assert.deepEqual(f.invitations.snapshot().invitations, []); assert.equal(f.warmCalls.length, 0);
  }
});

test('model-only invitation skips voice work and explicit remote receipt can become ready', async t => {
  const calls = [];
  const f = fixture(t, {prepareVoice: async profile => { calls.push(profile); return {provider:'convai',ready:true}; }});
  f.ingest([ticket('model-only', undefined), ticket('conversation')]);
  await until(() => f.invitations.snapshot().invitations.every(row => row.state === 'ready'));
  assert.deepEqual(calls, ['judy']); assert.equal(f.warmCalls.length, 1);
});

test('a pending spawn loses readiness immediately after conditioning eviction and prepares again', async t => {
  let conditioned = true, calls = 0;
  const reconditioning = deferred();
  const f = fixture(t, {voiceCurrent: () => conditioned,
    prepareVoice: async profile => {
      if (++calls > 1) { await reconditioning.promise; conditioned = true; }
      return {provider:'omnivoice',ready:true,profile};
    }});
  f.ingest([ticket()]); await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  conditioned = false;
  assert.equal(f.invitations.snapshot().invitations[0].state, 'connecting');
  await f.invitations.poll(); await until(() => calls === 2);
  assert.notEqual(f.invitations.snapshot().invitations[0].state, 'ready');
  f.tick(501); reconditioning.resolve(); await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  assert.equal(calls, 2);
});

test('already-spawned copies do not thrash the bounded conditioning cache when another voice evicts them', async t => {
  let conditioned = true, calls = 0;
  const f = fixture(t, {voiceCurrent: () => conditioned, prepareVoice: async profile => {
    calls++; return {provider:'omnivoice',ready:true,profile};
  }});
  f.ingest([ticket()]); await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  f.ingest([ticket('queued:1', 'judy', {phase:'spawned'})]); conditioned = false;
  await f.invitations.poll(); assert.equal(calls, 1);
  assert.equal(f.invitations.snapshot().invitations[0].state, 'ready');
});

test('a provider-driven connection replacement is retried instead of permanently failing the ticket', async t => {
  let calls = 0;
  const f = fixture(t);
  f.connections.warmInvitation = async () => {
    if (++calls === 1) throw Object.assign(Error('controlled route replacement'), {code:'INVITATION_CONNECTION_REPLACED'});
    return {present:true,ready:true,busy:false};
  };
  f.ingest([ticket()]); await until(() => calls === 1); await flush();
  assert.equal(f.invitations.snapshot().invitations[0].state, 'connecting');
  await f.poll(501); await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  assert.equal(calls, 2);
});

test('a verified memory cache cannot hide failed retirement of a busy pre-enable page', async t => {
  const f = await actualFixture(t);
  f.connections.ingest({updated: f.now(), profiles: ['judy']}); await f.connections.maintain(); await flush();
  const key = transportKey(f.configFor('judy', 'private')), page = f.live.get(key); page.busy = true;
  f.ingest([ticket()]); await until(() => f.enables.length === 1); f.enableGate.resolve();
  await until(() => f.invitations.snapshot().invitations[0].state === 'error');
  assert.equal(f.connections.needsRetirement('judy'), true); assert.equal(f.live.get(key), page);
  assert.equal((await f.connections.invitationReadiness('judy')).ready, false);
  const admitted = await f.memory.beginConversation({profileKey: 'judy', source: 'player'});
  assert.equal(admitted.reconnectRequired, true, 'verified memory cannot acknowledge a retirement that failed');
  page.busy = false; f.tick(500);
  await f.connections.retireInvitation('judy');
  assert.equal(f.connections.needsRetirement('judy'), false); assert.equal(f.live.has(key), false);
  assert.equal(f.memory.connectionRefreshRequired({profileKey: 'judy', guard: admitted.guard}), true);
  f.memory.acknowledgeConnectionRefresh({profileKey: 'judy', guard: admitted.guard});
  assert.equal(f.memory.connectionRefreshRequired({profileKey: 'judy', guard: admitted.guard}), false);
});

test('a cancelled invitation cannot lose a shared enable retirement obligation before transport retirement starts', async t => {
  const f = await actualFixture(t);
  f.connections.ingest({updated: f.now(), profiles: ['judy', 'panam']});
  for (let n = 0; n < 4; n++) { f.tick(n ? 500 : 0); await f.connections.maintain(); await flush(); }
  const before = await fs.readFile(f.path, 'utf8');
  const key = transportKey(f.configFor('judy', 'private')), oldPage = f.live.get(key);
  const otherPages = new Map([...f.live].filter(([, page]) => page.config.characterId === ids.panam));
  f.ingest([ticket()]); await until(() => f.enables.length === 1);
  const cancelled = f.invitations.lanes.get('judy');
  f.ingest([]); assert.equal(cancelled.controller.signal.aborted, true);
  f.enableGate.resolve();
  const cached = await f.memory.prepareCharacter({profileKey: 'judy'});
  assert.equal(cached.reconnectRequired, true);
  assert.equal(f.connections.needsRetirement('judy'), false, 'the cancelled owner never began transport retirement');
  assert.equal(f.refreshes.length, 0); assert.equal(f.live.get(key), oldPage);
  assert.equal(f.memory.status().talkedToCount, 0); assert.equal(await fs.readFile(f.path, 'utf8'), before);
  f.tick(500); f.ingest([ticket('queued:2')]);
  await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  const preparedPage = f.live.get(key);
  assert.notEqual(preparedPage, oldPage);
  assert.deepEqual(f.refreshes.map(config => config.characterId), [ids.judy, ids.judy]);
  for (const [otherKey, page] of otherPages) assert.equal(f.live.get(otherKey), page);
  assert.equal(f.enables.length, 1); assert.equal(f.memory.status().talkedToCount, 0);
  const admitted = await f.memory.beginConversation({profileKey: 'judy', source: 'player'});
  assert.equal(admitted.reconnectRequired, false); assert.equal(admitted.memoryEnabledNow, false);
  const reply = await f.host.reply(f.configFor('judy', 'private'));
  assert.equal(reply.page, preparedPage); assert.equal(reply.timing.pageReused, true);
});

test('a stale enable receipt does not retire a refreshed page acknowledged by another current caller', async t => {
  const f = await actualFixture(t), returned = deferred();
  const prepare = f.memory.prepareCharacter.bind(f.memory);
  f.memory.prepareCharacter = async input => {
    const receipt = await prepare(input); await returned.promise; return receipt;
  };
  f.ingest([ticket()]); await until(() => f.enables.length === 1);
  f.enableGate.resolve();
  const current = await prepare({profileKey: 'judy'});
  assert.equal(current.reconnectRequired, true);
  await f.connections.retireInvitation('judy');
  f.memory.acknowledgeConnectionRefresh({profileKey: 'judy', guard: current.guard});
  await f.connections.setInvitations(['judy']);
  await f.connections.warmInvitation('judy');
  const key = transportKey(f.configFor('judy', 'private')), page = f.live.get(key);
  assert.ok(page?.ready);
  returned.resolve(); await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  assert.equal(f.live.get(key), page); assert.equal(f.refreshes.length, 0); assert.equal(f.warmCalls.length, 1);
  assert.equal(f.memory.status().talkedToCount, 0);
});

test('a new memory enable retires only that profile old scopes before retaining and warming its prepared page', async t => {
  const f = fixture(t), enable = deferred();
  f.connections.ingest({updated: f.now(), profiles: ['judy', 'panam']});
  for (let n = 0; n < 4; n++) { f.tick(n ? 500 : 0); await f.connections.maintain(); await flush(); }
  const panam = new Map([...f.live].filter(([, page]) => page.config.characterId === ids.panam));
  f.memoryGates.set('judy', enable); f.ingest([ticket()]);
  await f.invitations.poll(); assert.equal(f.warmCalls.length, 4); assert.deepEqual(f.connections.invitations, []);
  f.tick(500); enable.resolve(); await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  assert.deepEqual(f.refreshes.map(config => config.characterId), [ids.judy, ids.judy]);
  assert.deepEqual(f.refreshes.map(config => config.scope), ['private', 'group:judy,panam']);
  for (const [key, page] of panam) assert.equal(f.live.get(key), page);
  assert.equal(f.warmCalls.length, 5); assert.equal(f.warmCalls.at(-1).config.scope, 'private');
});

test('cancelling one duplicate keeps the shared memory flight and the remaining copy alive', async t => {
  const f = fixture(t), enable = deferred(); f.memoryGates.set('judy', enable);
  f.ingest([ticket('queued:1'), ticket('queued:2')]); assert.equal(f.memoryCalls.length, 1);
  const signal = f.memoryCalls[0].signal;
  f.ingest([ticket('queued:2')]); assert.equal(signal.aborted, false);
  enable.resolve(); await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  assert.deepEqual(f.invitations.snapshot().invitations.map(row => row.id), ['queued:2']);
  assert.equal(f.memoryCalls.length, 1); assert.equal(f.warmCalls.length, 1);
});

test('cancellation fences a late memory completion and releases its reservation', async t => {
  const f = fixture(t), enable = deferred(); f.memory.ignoreAbort = true; f.memoryGates.set('judy', enable);
  f.ingest([ticket()]); const signal = f.memoryCalls[0].signal;
  f.ingest([]); assert.equal(signal.aborted, true); enable.resolve(); await flush();
  assert.deepEqual((await f.invitations.poll()).invitations, []);
  assert.equal(f.warmCalls.length, 0); assert.deepEqual(f.connections.invitations, []);
  f.ingest([ticket()]); assert.equal(f.invitations.snapshot().invitations[0].state, 'error');
  assert.equal(f.memoryCalls.length, 1, 'a cancelled revision must not prepare again');
});

test('reassignment requires a new revision and old preparation cannot authorize the replacement profile', async t => {
  const f = fixture(t), first = deferred(), replacement = deferred(); f.memory.ignoreAbort = true;
  f.memoryGates.set('judy', first); f.memoryGates.set('panam', replacement);
  f.ingest([ticket()]);
  f.ingest([ticket('queued:1', 'panam', {revision: 2})]);
  first.resolve(); await flush();
  assert.equal(f.invitations.snapshot().invitations[0].profileKey, 'panam');
  assert.equal(f.invitations.snapshot().invitations[0].state, 'memory'); assert.equal(f.warmCalls.length, 0);
  replacement.resolve(); await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  assert.deepEqual(f.warmCalls.map(call => call.config.characterId), [ids.panam]);
  f.ingest([ticket('queued:1', 'judy', {revision: 2})]);
  assert.equal(f.invitations.snapshot().invitations[0].state, 'error');
});

test('world changes, reset guards and service clearing reject late memory completion', async t => {
  for (const mode of ['world', 'guard', 'service', 'clear']) {
    const f = fixture(t), enable = deferred(); f.memory.ignoreAbort = true; f.memoryGates.set('judy', enable);
    f.ingest([ticket()]);
    if (mode === 'world') { f.world({worldToken: 'world-2', generation: 2}); f.ingest([]); }
    else if (mode === 'guard') f.epochs.set('judy', 1);
    else await f.invitations.clear(mode === 'service' ? 'service-stopped' : 'world-or-memory-reset');
    enable.resolve(); await flush(); const state = await f.invitations.poll();
    assert.ok(state.invitations.every(row => row.state !== 'ready'), mode); assert.equal(f.warmCalls.length, 0, mode);
    assert.deepEqual(f.connections.invitations, [], mode);
    if (mode === 'service') {
      assert.equal(state.worldToken, null); assert.equal(f.ingest([ticket()]), null);
    } else if (mode === 'clear') {
      f.ingest([ticket()]); assert.equal(f.invitations.snapshot().invitations[0].state, 'error');
    }
  }
});

test('cancelling or reassigning during SDK startup cannot revive the old ready receipt', async t => {
  const f = fixture(t), warming = deferred(); f.warmGates.set(ids.judy, warming);
  f.ingest([ticket()]); await until(() => f.warmCalls.length === 1);
  f.ingest([ticket('queued:1', 'panam', {revision: 2})]);
  assert.equal(f.warmCalls[0].signal.aborted, true);
  warming.resolve(); await flush(); f.tick(500);
  await f.invitations.poll(); await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  assert.equal(f.invitations.snapshot().invitations[0].profileKey, 'panam');
  assert.equal(f.live.has(transportKey(f.configFor('judy', 'private'))), false);
});

test('connection loss revokes readiness; foreground gating preserves ready pages and retries without extra warmups', async t => {
  const f = fixture(t); f.ingest([ticket()]); await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  const key = transportKey(f.configFor('judy', 'private')), page = f.live.get(key);
  f.gate(false); await f.invitations.poll(); assert.equal(f.live.get(key), page); assert.equal(f.warmCalls.length, 1);
  page.ready = false;
  assert.equal((await f.invitations.poll()).invitations[0].state, 'connecting');
  await flush(); assert.equal(f.warmCalls.length, 1); assert.equal(f.live.get(key), page);
  page.ready = true; f.tick(500); await f.invitations.poll();
  await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  assert.equal(f.warmCalls.length, 1); assert.equal(f.live.get(key), page);
  f.live.delete(key); assert.equal((await f.invitations.poll()).invitations[0].state, 'connecting');
  f.gate(true); f.tick(500); await f.invitations.poll();
  await until(() => f.invitations.snapshot().invitations[0].state === 'ready'); assert.equal(f.warmCalls.length, 2);
});

test('a completed warm is not a ready receipt until the retained SDK itself reports present and ready', async t => {
  const f = fixture(t), readiness = f.host.readiness;
  let sdkReady = false;
  f.host.readiness = async (...args) => ({...await readiness(...args), ready: sdkReady});
  f.ingest([ticket()]); await until(() => f.warmCalls.length === 1 && !f.invitations.lanes.get('judy').warming);
  assert.equal(f.connections.diagnostic().ready, 1, 'warm completion alone is weaker evidence than SDK readiness');
  assert.equal((await f.invitations.poll()).invitations[0].state, 'connecting');
  sdkReady = true; f.tick(500); await f.invitations.poll();
  await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  assert.equal(f.warmCalls.length, 1);
});

test('world, memory guard, service and connection clearing fence a pending SDK startup', async t => {
  for (const mode of ['world', 'guard', 'service', 'connection']) {
    const f = fixture(t), warming = deferred(); f.warmGates.set(ids.judy, warming);
    f.ingest([ticket()]); await until(() => f.warmCalls.length === 1);
    if (mode === 'world') { f.world(null); f.invitations.ingest(undefined); }
    else if (mode === 'guard') f.epochs.set('judy', 1);
    else if (mode === 'service') await f.invitations.clear('service-stopped');
    else await f.connections.clear();
    warming.resolve(); await flush();
    const state = await f.invitations.poll();
    assert.ok(state.invitations.every(row => row.state !== 'ready'), mode);
    assert.equal(f.live.size, 0, mode);
  }
});

test('new dispatch waits for the foreground gate while all eight tickets remain retained and duplicate copies share one page', async t => {
  const f = fixture(t); f.gate(false);
  f.ingest(Array.from({length: 8}, (_, n) => ticket('queued:' + n)));
  await until(() => f.invitations.snapshot().invitations.every(row => row.state === 'connecting'));
  assert.equal(f.memoryCalls.length, 1); assert.equal(f.warmCalls.length, 0);
  for (let n = 0; n < 4; n++) { await f.poll(150); await flush(); await f.connections.maintain(); }
  assert.equal(f.warmCalls.length, 0); assert.deepEqual(f.connections.invitations, ['judy']);
  f.gate(true); await f.poll(500); await until(() => f.invitations.snapshot().invitations.every(row => row.state === 'ready'));
  assert.equal(f.warmCalls.length, 1); assert.equal(f.live.size, 1);
});

test('expired input drops the old receipt and the last invitation page', async t => {
  const f = fixture(t); f.ingest([ticket()]); await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  f.tick(6501); const expired = await f.invitations.poll();
  assert.deepEqual(expired.invitations, []); assert.deepEqual(f.connections.invitations, []); assert.equal(f.live.size, 0);
  f.ingest([ticket('queued:2')]); await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  f.ingest([ticket('queued:2')], {worldToken: 'old-world'});
  f.tick(6501);
  assert.deepEqual((await f.invitations.poll()).invitations, []); assert.equal(f.live.size, 0);
});

test('a missing or partial Windows publication frame preserves the fresh ticket and the same prepared page', async t => {
  const f = fixture(t); f.ingest([ticket()]); await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  const key = transportKey(f.configFor('judy', 'private')), page = f.live.get(key);
  for (const frame of [undefined, {}, {version: 1, invitations: []}]) {
    assert.equal(f.invitations.ingest(frame), null);
    assert.equal((await f.invitations.poll()).invitations[0].state, 'ready');
    assert.equal(f.live.get(key), page);
  }
  f.ingest([ticket()]); await f.invitations.poll();
  assert.equal(f.memoryCalls.length, 1); assert.equal(f.warmCalls.length, 1);
  f.world(null); f.invitations.ingest(undefined);
  assert.deepEqual((await f.invitations.poll()).invitations, []); assert.equal(f.live.size, 0);
});

test('publication carries a synchronous owner fence so cancelled receipts cannot commit after a deferred write', async t => {
  const f = fixture(t); f.ingest([ticket()]); await until(() => f.invitations.snapshot().invitations[0].state === 'ready');
  const gate = deferred(), writes = [], committed = [];
  f.invitations.publish = async (value, options) => {
    writes.push({value, options}); await gate.promise;
    if (options.isCurrentSync()) committed.push(value); return options.isCurrentSync();
  };
  const publishing = f.invitations.poll(); await until(() => writes.length === 1);
  f.ingest([]); assert.equal(writes[0].options.signal.aborted, true); assert.equal(writes[0].options.isCurrentSync(), false);
  gate.resolve(); await publishing; assert.deepEqual(committed, []);
  await f.invitations.poll(); assert.deepEqual(committed[0].invitations, []);
});
