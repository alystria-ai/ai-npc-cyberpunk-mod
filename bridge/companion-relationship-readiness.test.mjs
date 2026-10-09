import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CompanionInvitations} from './companion-invitations.mjs';

const flush = () => new Promise(done => setImmediate(done));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
async function until(check) {
  for (let tries = 0; !check(); tries++) { if (tries > 100) throw Error('Expected stage not reached'); await flush(); }
}
function fixture() {
  let selected = 'english-id', available = true;
  const memoryCalls = [], voiceCalls = [], warmCalls = [], ready = new Set(), memoryGates = new Map(), warmGates = new Map();
  const owner = {worldToken: 'world-a', generation: 3}, now = () => 100000;
  const memory = {
    route: () => {
      if (!available) throw Error('Fresh relationship state unavailable');
      return {endUserId: 'same-player', guard: {endUserId: 'same-player', characterId: selected, resetEpoch: 0, characterEpoch: 0}};
    },
    isCurrent: guard => ['english-id', 'multilingual-id'].includes(guard.characterId),
    prepareCharacter: async options => {
      memoryCalls.push(options);
      await memoryGates.get(options.guard.characterId)?.promise; // Deliberately ignores abort.
      return {guard: options.guard, memoryEnabled: true};
    },
    connectionRefreshRequired: () => false,
    acknowledgeConnectionRefresh: () => {},
  };
  const connections = {
    setInvitations: async () => {}, needsRetirement: () => false,
    warmInvitation: async () => {
      const characterId = selected; warmCalls.push(characterId);
      await warmGates.get(characterId)?.promise; // Deliberately ignores abort.
      ready.add(characterId); return {present: true, ready: true, busy: false};
    },
    invitationReadiness: async () => ({present: ready.has(selected), ready: ready.has(selected), busy: false}),
  };
  const invitations = new CompanionInvitations({memory, connections, currentWorld: () => owner,
    isKnown: profile => profile === 'judy-alvarez', now,
    routeCurrent: (_, guard) => available && selected === guard.characterId,
    prepareVoice: async (_, options) => { voiceCalls.push(options.guard.characterId); return {provider: 'convai', ready: true}; },
  });
  const ticket = {version: 1, ...owner, updated: now(), invitations: [{id: 'queued:1', revision: 1,
    modelKey: 'judy-model', profileKey: 'judy-alvarez', phase: 'preparing'}]};
  return {invitations, memoryCalls, voiceCalls, warmCalls, memoryGates, warmGates, ticket,
    select: value => { selected = value; }, unavailable: value => { available = !value; },
    state: () => invitations.snapshot().invitations[0]?.state};
}

test('a provider change (Multilingual Conversations) during memory preparation replaces only the pending lane without changing its spawn ticket', async () => {
  const f = fixture(), original = gate(), replacement = gate();
  f.memoryGates.set('english-id', original); f.memoryGates.set('multilingual-id', replacement);
  f.invitations.ingest(f.ticket);
  await until(() => f.memoryCalls.length === 1);
  f.select('multilingual-id'); await f.invitations.poll();
  await until(() => f.memoryCalls.length === 2);
  assert(f.memoryCalls[0].signal.aborted);
  original.resolve(); await flush();
  assert.notEqual(f.state(), 'ready'); assert.deepEqual(f.voiceCalls, []);
  replacement.resolve(); await until(() => f.warmCalls.length === 1); await flush();
  assert.deepEqual(f.voiceCalls, ['multilingual-id']); assert.deepEqual(f.warmCalls, ['multilingual-id']);
  assert.equal(f.state(), 'ready');
  assert.equal(f.invitations.snapshot().invitations[0].id, 'queued:1');
  assert.equal(f.invitations.snapshot().invitations[0].revision, 1);
  await f.invitations.clear();
});

test('an old ignored-abort socket readiness cannot authorize a new selected provider ID', async () => {
  const f = fixture(), original = gate(), replacement = gate();
  f.warmGates.set('english-id', original); f.warmGates.set('multilingual-id', replacement);
  f.invitations.ingest(f.ticket);
  await until(() => f.warmCalls.length === 1);
  f.select('multilingual-id');
  assert.notEqual(f.state(), 'ready');
  await f.invitations.poll(); await until(() => f.warmCalls.length === 2);
  original.resolve(); await flush();
  assert.notEqual(f.state(), 'ready', 'stale readiness of the previous provider ID granted the ticket of the new provider ID');
  assert.equal(f.memoryCalls[1].guard.characterId, 'multilingual-id');
  replacement.resolve(); await flush();
  assert.equal(f.state(), 'ready');
  await f.invitations.clear();
});

test('missing fresh relationship state masks a previous spawn grant until the current route is verifiable', async () => {
  const f = fixture(); f.invitations.ingest(f.ticket);
  await until(() => f.state() === 'ready');
  f.unavailable(true);
  assert.equal(f.state(), 'connecting'); await f.invitations.poll();
  assert.equal(f.state(), 'connecting'); assert.equal(f.memoryCalls.length, 1);
  f.unavailable(false); await f.invitations.poll(); assert.equal(f.state(), 'ready');
  await f.invitations.clear();
});

test('changing a profile after a copy spawned does not cancel its old lane or recreate the world copy', async () => {
  const f = fixture(); f.invitations.ingest(f.ticket);
  await until(() => f.state() === 'ready');
  f.ticket.invitations[0].phase = 'spawned'; f.invitations.ingest(f.ticket);
  const oldGuard = f.memoryCalls[0].guard, oldSignal = f.memoryCalls[0].signal;
  f.select('multilingual-id'); await f.invitations.poll();
  assert.equal(f.memoryCalls.length, 1); assert.equal(oldSignal.aborted, false);
  assert.equal(oldGuard.characterId, 'english-id');
  assert.equal(f.invitations.rows.get('queued:1').phase, 'spawned');
  await f.invitations.clear();
});

test('a native-state gap after awaited memory preparation resumes when its same selected route returns', async () => {
  const f = fixture(), pending = gate(); f.memoryGates.set('english-id', pending);
  f.invitations.ingest(f.ticket); await until(() => f.memoryCalls.length === 1);
  f.unavailable(true); pending.resolve(); await flush();
  assert.equal(f.state(), 'memory'); assert.equal(f.warmCalls.length, 0);
  f.unavailable(false); await f.invitations.poll();
  await until(() => f.state() === 'ready');
  assert.deepEqual(f.warmCalls, ['english-id']);
  assert.equal(f.memoryCalls[0].signal.aborted, false);
  await f.invitations.clear();
});
