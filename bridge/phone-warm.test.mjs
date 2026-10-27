import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {PhoneWarm, PHONE_WARM_DWELL_MS, PHONE_WARM_KEEPALIVE_MS, PHONE_WARM_MAX_STARTS} from './phone-warm.mjs';
import {PlayerKnowledge} from './player-knowledge.mjs';
import {transportKey} from './transport-pool.mjs';

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const PROFILES = {judy: 'judy-alvarez', panam: 'panam-palmer', alex: 'alex'};

function fixture(options = {}) {
  const clock = {value: 1_000_000};
  const calls = {prepare: [], keepAlive: [], release: [], errors: []};
  const warm = new PhoneWarm({
    now: () => clock.value, enabled: options.enabled, profileFor: contact => PROFILES[contact],
    prepare: options.prepare ?? (async (profile, {signal}) => {
      calls.prepare.push({profile, signal});
      return {config: {characterId: profile + '-id', endUserId: 'v', scope: 'phone:world:x', ttsEnabled: false}, opened: true};
    }),
    keepAlive: options.keepAlive ?? (async config => { calls.keepAlive.push(config); return {present: true, ready: true}; }),
    release: async config => { calls.release.push(config); },
    onError: error => calls.errors.push(error.message), ...options.extra});
  const state = (contact, extra = {}) => ({version: 2, world: 'world-1', updated: clock.value, active: true,
    saveIdentity: {generation: 1}, chatContact: contact, ...extra});
  const tick = async ms => { clock.value += ms; };
  return {warm, calls, clock, state, tick};
}

test('opening a Chat prepares that contact once after a short dwell, never before and never twice', async () => {
  const f = fixture();
  f.warm.observe(f.state('judy'));
  await f.tick(PHONE_WARM_DWELL_MS - 1); f.warm.observe(f.state('judy')); await flush();
  assert.equal(f.calls.prepare.length, 0, 'paging through contacts opens nothing');
  await f.tick(2); f.warm.observe(f.state('judy')); await flush();
  assert.deepEqual(f.calls.prepare.map(call => call.profile), ['judy-alvarez']);
  for (let i = 0; i < 5; i++) { await f.tick(500); f.warm.observe(f.state('judy')); await flush(); }
  assert.equal(f.calls.prepare.length, 1, 'a contact that is ready is not prepared again');
});

test('a Chat that closes, a stale or inactive state and an unknown or malformed contact start nothing', async () => {
  const bad = [() => null, () => undefined, () => ({}), f => f.state(undefined), f => f.state(''), f => f.state('../x'),
    f => f.state('nobody'), f => f.state('judy', {active: false}), f => f.state('judy', {updated: f.clock.value - 20000}),
    f => f.state('judy', {updated: f.clock.value + 5000}), f => f.state('judy', {chatContact: 7})];
  for (const make of bad) {
    const f = fixture();
    f.warm.observe(make(f)); await f.tick(PHONE_WARM_DWELL_MS + 1); f.warm.observe(make(f)); await flush();
    assert.equal(f.calls.prepare.length, 0);
  }
});

test('a message already sent, a busy bridge and a disabled plan never start a warm-up', async () => {
  let allowed = false;
  const f = fixture({enabled: () => allowed});
  f.warm.observe(f.state('judy')); await f.tick(PHONE_WARM_DWELL_MS + 1);
  f.warm.observe(f.state('judy')); await flush();
  assert.equal(f.calls.prepare.length, 0, 'enabled() is false');
  allowed = true; f.warm.observe(f.state('judy', {request: {id: 'world-1-1'}})); await flush();
  assert.equal(f.calls.prepare.length, 0, 'the message owns the connection');
  f.warm.observe(f.state('judy')); await flush();
  assert.equal(f.calls.prepare.length, 1);
  const throwing = fixture({enabled: () => { throw Error('boom'); }});
  throwing.warm.observe(throwing.state('judy')); await throwing.tick(PHONE_WARM_DWELL_MS + 1);
  throwing.warm.observe(throwing.state('judy')); await flush();
  assert.equal(throwing.calls.prepare.length, 0, 'a faulty guard fails closed');
});

test('switching or closing a Chat aborts a warm-up that is still opening', async () => {
  const gate = defer(), signals = [];
  const f = fixture({prepare: async (profile, {signal}) => { signals.push(signal); await gate.promise; return {config: null}; }});
  f.warm.observe(f.state('judy')); await f.tick(PHONE_WARM_DWELL_MS + 1); f.warm.observe(f.state('judy')); await flush();
  assert.equal(signals.length, 1); assert.equal(signals[0].aborted, false);
  f.warm.observe(f.state('panam')); assert.equal(signals[0].aborted, true, 'another contact');
  await f.tick(PHONE_WARM_DWELL_MS + 1); f.warm.observe(f.state('panam')); await flush();
  assert.equal(signals.length, 2); assert.equal(signals[1].aborted, false);
  f.warm.observe(null); assert.equal(signals[1].aborted, true, 'the Chat closed');
  gate.resolve(); await flush();
  f.warm.observe(f.state('panam')); await f.tick(PHONE_WARM_DWELL_MS + 1); f.warm.observe(f.state('panam')); await flush();
  assert.equal(signals.length, 3, 'reopening the same Chat later starts a fresh attempt');
});

test('failures retry with backoff, at most a few times per visit, and never throw into the bridge', async () => {
  let attempts = 0;
  const f = fixture({prepare: async () => { attempts++; throw Error('offline'); }});
  f.warm.observe(f.state('judy')); await f.tick(PHONE_WARM_DWELL_MS + 1);
  for (let i = 0; i < 60; i++) { f.warm.observe(f.state('judy')); await flush(); await f.tick(2000); }
  assert.equal(attempts, PHONE_WARM_MAX_STARTS);
  assert.equal(f.calls.errors.length, PHONE_WARM_MAX_STARTS);
  assert.ok(f.calls.errors.every(message => message === 'offline'));
  // An observer that throws does not matter either.
  const loud = fixture({prepare: async () => { throw Error('x'); }, extra: {onError: () => { throw Error('observer'); }}});
  loud.warm.observe(loud.state('judy')); await loud.tick(PHONE_WARM_DWELL_MS + 1); loud.warm.observe(loud.state('judy')); await flush();
});

test('an open Chat keeps its idle connection alive on an interval and opens it again if the page is gone', async () => {
  let present = true;
  const f = fixture({keepAlive: async config => { f.calls.keepAlive.push(config); return {present, ready: true}; }});
  f.warm.observe(f.state('judy')); await f.tick(PHONE_WARM_DWELL_MS + 1); f.warm.observe(f.state('judy')); await flush();
  assert.equal(f.calls.prepare.length, 1);
  await f.tick(PHONE_WARM_KEEPALIVE_MS - 100); f.warm.observe(f.state('judy')); await flush();
  assert.equal(f.calls.keepAlive.length, 0);
  await f.tick(200); f.warm.observe(f.state('judy')); await flush();
  assert.equal(f.calls.keepAlive.length, 1);
  assert.equal(f.calls.prepare.length, 1, 'a live page is left alone');
  present = false;
  await f.tick(PHONE_WARM_KEEPALIVE_MS + 1); f.warm.observe(f.state('judy')); await flush();
  f.warm.observe(f.state('judy')); await flush();
  assert.equal(f.calls.prepare.length, 2, 'a closed page is opened again');
});

test('a page that holds a message in flight or a conversation of its own is never reconnected by the keep-alive', async () => {
  let answer = {present: true, busy: true};
  const f = fixture({keepAlive: async () => answer});
  f.warm.observe(f.state('judy')); await f.tick(PHONE_WARM_DWELL_MS + 1); f.warm.observe(f.state('judy')); await flush();
  await f.tick(PHONE_WARM_KEEPALIVE_MS + 1); f.warm.observe(f.state('judy')); await flush();
  answer = {present: true, ready: false};
  await f.tick(PHONE_WARM_KEEPALIVE_MS + 1); f.warm.observe(f.state('judy')); await flush();
  for (let i = 0; i < 4; i++) { await f.tick(PHONE_WARM_KEEPALIVE_MS + 1); f.warm.observe(f.state('judy')); await flush(); }
  assert.equal(f.calls.prepare.length, 1);
});

test('a prepare that leaves the connection to the message (no config) is final for that visit and sends no keep-alive', async () => {
  let prepared = 0;
  const f = fixture({prepare: async () => { prepared++; return {config: null}; }});
  f.warm.observe(f.state('judy')); await f.tick(PHONE_WARM_DWELL_MS + 1); f.warm.observe(f.state('judy')); await flush();
  for (let i = 0; i < 4; i++) { await f.tick(PHONE_WARM_KEEPALIVE_MS + 1); f.warm.observe(f.state('judy')); await flush(); }
  assert.equal(prepared, 1); assert.equal(f.calls.keepAlive.length, 0);
});

test('only one speculative page is kept: an unused page is released when another opens, a spoken-through page never is', async () => {
  const f = fixture();
  const open = async contact => {
    f.warm.observe(f.state(contact)); await f.tick(PHONE_WARM_DWELL_MS + 1); f.warm.observe(f.state(contact)); await flush();
  };
  await open('judy'); assert.deepEqual(f.calls.release, []);
  await open('panam'); await flush();
  assert.deepEqual(f.calls.release.map(config => config.characterId), ['judy-alvarez-id'], 'Judy was never spoken to');
  // Panam's message claims her page: moving on must keep it.
  const panam = {characterId: 'panam-palmer-id', endUserId: 'v', scope: 'phone:world:x', ttsEnabled: false};
  assert.equal(f.warm.claim(panam, 'panam-palmer'), panam, 'claim returns the very config it was given');
  await open('alex'); await flush();
  assert.deepEqual(f.calls.release.map(config => config.characterId), ['judy-alvarez-id']);
});

test('a page that already existed is adopted for keep-alive but is never marked speculative', async () => {
  const f = fixture({prepare: async profile => ({config: {characterId: profile + '-id', endUserId: 'v', scope: 's'}})});
  for (const contact of ['judy', 'panam']) {
    f.warm.observe(f.state(contact)); await f.tick(PHONE_WARM_DWELL_MS + 1); f.warm.observe(f.state(contact)); await flush();
  }
  assert.deepEqual(f.calls.release, []);
});

test('a message to another contact gives way a warm-up that is still opening; the same contact does not', async () => {
  const gate = defer(), signals = [];
  const f = fixture({prepare: async (profile, {signal}) => { signals.push(signal); await gate.promise; return {config: null}; }});
  f.warm.observe(f.state('judy')); await f.tick(PHONE_WARM_DWELL_MS + 1); f.warm.observe(f.state('judy')); await flush();
  f.warm.interrupt('judy-alvarez'); assert.equal(signals[0].aborted, false);
  f.warm.claim({characterId: 'x', endUserId: 'v', scope: 's'}, 'judy-alvarez'); assert.equal(signals[0].aborted, false);
  f.warm.interrupt('panam-palmer'); assert.equal(signals[0].aborted, true);
  gate.resolve(); await flush();
});

test('claim tolerates a malformed config and the used set stays bounded', () => {
  const f = fixture();
  assert.doesNotThrow(() => f.warm.claim(undefined, 'judy-alvarez'));
  for (let i = 0; i < 200; i++) f.warm.claim({characterId: 'c' + i, endUserId: 'v', scope: 's'}, 'judy-alvarez');
  assert.ok(f.warm.used.size <= 64);
});

test('after the idle cap an open Chat no longer keeps connections alive, and a closed module does nothing', async () => {
  const f = fixture({prepare: async () => { throw Error('offline'); }, extra: {idleMs: 10_000}});
  f.warm.observe(f.state('judy')); await f.tick(11_000); f.warm.observe(f.state('judy')); await flush();
  assert.equal(f.calls.prepare.length, 0);
  const g = fixture(); g.warm.close();
  g.warm.observe(g.state('judy')); await g.tick(PHONE_WARM_DWELL_MS + 1); g.warm.observe(g.state('judy')); await flush();
  assert.equal(g.calls.prepare.length, 0);
});

// ---------------------------------------------------------------------------
// The bridge's own preparation, extracted from convai-bridge.mjs and run against fakes.

const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('const phoneWarm = new PhoneWarm({'), source.indexOf('let phonePolling = false;'));
const PHONE_SCOPE = 'phone:world:' + 'a'.repeat(24);

function bridge(options = {}) {
  const log = [];
  const route = options.route === undefined ? {guard: {characterId: 'judy-id', endUserId: 'v-1'}, scope: PHONE_SCOPE,
    sessionKey: 's'.repeat(64), remoteConfig: {endUserId: 'v-1'}, route: {profileKey: 'judy-alvarez', channel: 'phone'}} : options.route;
  let configs = 0;
  const context = {
    PhoneWarm: class { constructor(value) { context.config = value; } },
    customCharacters: {has: key => options.custom === key},
    stopped: false, memoryQuiescing: 0, active: null, mic: {}, micPolling: false, voiceRouteReservation: false,
    relationshipRouteReservation: false, phone: {active: null, profileFor: contact => (contact === 'judy' ? 'judy-alvarez' : undefined)},
    singleSession: () => options.single === true,
    currentBoundary: () => ({worldToken: 'world-a', generation: 3}),
    knowledgeRouter: {configFor: (profile, scope, boundary) => { log.push(['route', profile, scope, boundary.generation]); configs++;
      if (typeof options.second === 'function' && configs > 1) return options.second(route);
      return route; }},
    playerMemory: {prepareCharacter: async args => { log.push(['memory', args.profileKey, args.guard.characterId]);
      return {reconnectRequired: options.reconnectRequired === true}; }},
    memoryPolicy: config => ({...config}), currentKey: () => 'key',
    throwIfCancelled: signal => { if (signal?.aborted) throw Error('cancelled'); },
    phoneRealtime: {readiness: async (config, extra) => { log.push(['readiness', !!extra?.keepAlive]); return {present: options.present === true}; },
      warm: async config => { log.push(['warm', config]); return {}; }, refreshIdle: async config => { log.push(['refresh', config]); return true; }},
    console: {error: (...args) => log.push(['error', ...args])},
  };
  runInNewContext(block, context);
  return {log, config: context.config, context};
}

test('the bridge checks the character memory, then opens the one text connection the message will use', async () => {
  const {log, config} = bridge();
  assert.equal(config.profileFor('judy'), 'judy-alvarez'); assert.equal(config.profileFor('nobody'), undefined);
  const outcome = await config.prepare('judy-alvarez', {signal: new AbortController().signal});
  assert.deepEqual(log.map(row => row[0]), ['route', 'memory', 'route', 'readiness', 'warm']);
  assert.deepEqual(log[0].slice(1), ['judy-alvarez', 'phone', 3]);
  assert.deepEqual(log[1].slice(1), ['judy-alvarez', 'judy-id']);
  assert.equal(outcome.opened, true);
  assert.deepEqual({...outcome.config}, {key: 'key', characterId: 'judy-id', scope: PHONE_SCOPE, endUserId: 'v-1', ttsEnabled: false});
  assert.equal(log.at(-1)[1], outcome.config, 'exactly the config that was prepared is opened');
});

test('the bridge leaves the connection to the message when memory was just enabled, for an ambient route or without a route', async () => {
  for (const options of [{reconnectRequired: true}, {route: null}, {route: {providerMemory: 'session-only', guard: {characterId: 'x'}}}]) {
    const {log, config} = bridge(options);
    const outcome = await config.prepare('judy-alvarez', {signal: new AbortController().signal});
    assert.equal(outcome.config, null);
    assert.equal(log.some(row => row[0] === 'warm'), false);
    assert.equal(log.some(row => row[0] === 'memory') , options.reconnectRequired === true);
  }
});

test('the bridge never reconnects a page that already holds a conversation, and drops a route that changed while the memory was checked', async () => {
  const present = bridge({present: true});
  const outcome = await present.config.prepare('judy-alvarez', {signal: new AbortController().signal});
  assert.ok(outcome.config); assert.equal(outcome.opened, undefined);
  assert.equal(present.log.some(row => row[0] === 'warm'), false);
  const moved = bridge({second: route => ({...route, scope: 'phone:world:' + 'b'.repeat(24)})});
  assert.equal((await moved.config.prepare('judy-alvarez', {signal: new AbortController().signal})).config, null);
  assert.equal(moved.log.some(row => row[0] === 'warm'), false);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(bridge().config.prepare('judy-alvarez', {signal: aborted.signal}), /cancelled/);
});

test('the bridge warms nothing while a turn, a microphone, a reset or a single-session plan owns the connection', () => {
  const idle = bridge();
  assert.equal(idle.config.enabled(), true);
  for (const [name, value] of [['stopped', true], ['memoryQuiescing', 1], ['active', {}], ['micPolling', true],
    ['voiceRouteReservation', true], ['relationshipRouteReservation', true]]) {
    const {config, context} = bridge(); context[name] = value;
    assert.equal(config.enabled(), false, name);
  }
  const busy = bridge(); busy.context.mic = {current: {}}; assert.equal(busy.config.enabled(), false, 'a recording');
  const sending = bridge(); sending.context.phone.active = {}; assert.equal(sending.config.enabled(), false, 'a phone message in flight');
  assert.equal(bridge({single: true}).config.enabled(), false, 'a free key allows one connection at a time');
  const wired = bridge();
  return Promise.all([wired.config.keepAlive({}), wired.config.release({})]).then(() => {
    assert.deepEqual(wired.log.map(row => row[0]), ['readiness', 'refresh']);
    assert.equal(wired.log[0][1], true, 'keep-alive sends only the idle-timer reset');
  });
});

test('the bridge feeds every phone poll to the warm-up and hands the message its own transport config through claim', () => {
  assert.match(source, /await phone\.accept\(state\);\s*phoneWarm\.observe\(state\);/);
  const reply = source.slice(source.indexOf('const result = await phoneRealtime.reply('), source.indexOf('stagedKnowledgeTurn(prepared);'));
  assert.match(reply, /phoneRealtime\.reply\(phoneWarm\.claim\(memoryPolicy\(/);
  assert.match(reply, /ttsEnabled: false, local: localTurn\(prepared\.input, prepared\)\}\), options\.profileKey\), \{signal: options\.signal\}\)/);
  assert.match(source, /phoneWarm\.interrupt\(options\.profileKey\);\s*const admitted = await admitPlayerConversation/);
});

// ---------------------------------------------------------------------------
// The warm page and the message use the same page: same route, same transport identity.

const NOW = Date.parse('2026-10-11T07:00:00Z');
const USER = 'bf5a7019-3e8c-47a2-9367-a9b6d179d89d';
function router() {
  const memory = {
    route: profileKey => ({endUserId: USER, guard: Object.freeze({endUserId: USER, characterId: profileKey + '-provider', resetEpoch: 0, characterEpoch: 0})}),
    isCurrent: guard => guard?.endUserId === USER,
  };
  const pack = {version: 1, id: 'p', revision: 1, gameVersions: ['2.31'], profileKeys: ['judy-alvarez'], sources: [], evidence: [],
    factAllowlist: {}, journalAllowlist: {}, rules: []};
  const boundary = {worldToken: 'world-a', generation: 3};
  return {boundary, router: new PlayerKnowledge({playerMemory: memory, pack, now: () => NOW,
    getBoundary: () => boundary, isWorldCurrent: binding => binding.worldToken === 'world-a' && binding.generation === 3})};
}

test('the warm route has exactly the transport identity of the phone message that follows it', async () => {
  const {router: knowledge, boundary} = router();
  const warm = knowledge.configFor('judy-alvarez', 'phone', boundary);
  assert.ok(warm, 'a phone route is available for a warm-up');
  const input = {id: 'world-1-1', channel: 'phone', contact: 'judy', profileKey: 'judy-alvarez', text: 'Hey', saveIdentity: {generation: 3}};
  const prepared = await knowledge.prepare(input, {channel: 'phone', ...boundary});
  assert.equal(prepared.sendAllowed, true);
  assert.equal(warm.scope, prepared.scope); assert.equal(warm.sessionKey, prepared.sessionKey);
  assert.equal(warm.guard.characterId, prepared.guard.characterId);
  const forPage = route => ({key: 'k', characterId: route.guard.characterId, scope: route.scope, ...route.remoteConfig, ttsEnabled: false});
  // The message builds its config from the admitted turn and adds a session, context and text; none of them is part of the page identity.
  const message = {...forPage(prepared), sessionId: '-1', context: 'c', text: 'Hey'};
  assert.equal(transportKey(forPage(warm)), transportKey(message));
  assert.match(warm.scope, /^phone:world:[a-f0-9]{24}$/);
});
