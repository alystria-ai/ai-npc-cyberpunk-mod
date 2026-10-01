import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseInput} from './protocol.mjs';
import {inputIdentity} from './group-prefetch.mjs';
import {reactionLeaseValid} from './battle-context.mjs';

// Execute the bridge's real read and polling functions without starting its
// services, reading credentials, or touching the running game's files.
const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
const adapter = source.slice(source.indexOf('async function reactionCurrent(input) {'),
  source.indexOf('async function processInput(request, prepared) {'));
const input = {requestId: '1000-1-1ULL', generation: 1, entity: '1ULL', name: 'Judy',
  bodyType: 'WomanAverage', profileKey: 'judy-alvarez', text: 'An observed battle event.',
  battle: {version: 1, status: 'fighting', encounter: 'battle-1', ageSeconds: 2,
    durationSeconds: 2, opponents: [], witnesses: ['judy-alvarez']},
  reaction: {kind: 'battle', phase: 'start', encounter: 'battle-1', expiresAt: Date.now() + 60000}};
const missing = () => Object.assign(Error('Heartbeat rename gap'), {code: 'ENOENT'});

function fixture() {
  const state = {queue: [], reads: 0, delays: [], accepted: [], errors: [],
    lease: {requestId: input.requestId, valid: true, updated: Date.now()}};
  const context = vm.createContext({parseInput, inputIdentity, reactionLeaseValid, AbortController,
    readLease: async () => {
      state.reads++;
      const value = state.queue.length ? state.queue.shift() : JSON.stringify(state.lease);
      if (value instanceof Error) throw value;
      return value;
    },
    record: request => state.accepted.push(request),
    setTimeout: (done, delay) => { state.delays.push(delay); done(); },
    console: {error: (...args) => state.errors.push(args)}, rawInput: JSON.stringify(input)});
  vm.runInContext(`
    let polling=false, stopped=false, active=null, observed='', lastAcceptedIdentity='', voiceRouteReservation=false;
    const inputPath='input', runtime='runtime', resolve=(...parts)=>parts.join('/');
    const stat=async()=>({mtimeMs:1,size:rawInput.length});
    const readFile=async path=>path===inputPath ? rawInput : readLease();
    const prefetch={invalidate(){},claim(){return null;}}, completeContext=()=>'', status=async()=>{};
    const processInput=request=>record(request);
    ${adapter}
    globalThis.api={tick,reactionCurrent,state:()=>({active,observed,lastAcceptedIdentity}),
      setActive:value=>{active=value;}};
  `, context);
  return {state, api: context.api};
}

test('manual turns do not read a reaction lease', async () => {
  const {state, api} = fixture();
  assert.equal(await api.reactionCurrent({...input, reaction: undefined}), true);
  assert.equal(state.reads, 0);
});

test('heartbeat rename gaps and partial JSON recover within a bounded read', async () => {
  const {state, api} = fixture();
  state.queue.push(missing(), '{');
  assert.equal(await api.reactionCurrent(input), true);
  assert.equal(state.reads, 3);
  assert.deepEqual(state.delays, [15, 15]);
});

test('explicit cancellation, stale leases and real IO failures are not retried', async () => {
  for (const value of [
    JSON.stringify({requestId: input.requestId, valid: false, updated: Date.now()}),
    JSON.stringify({requestId: input.requestId, valid: true, updated: Date.now() - 6000}),
    Object.assign(Error('Access denied'), {code: 'EACCES'}),
  ]) {
    const {state, api} = fixture();
    state.queue.push(value);
    assert.equal(await api.reactionCurrent(input), false);
    assert.equal(state.reads, 1);
    assert.deepEqual(state.delays, []);
  }
});

test('an unchanged new input retries after exhausted transient lease reads', async () => {
  const {state, api} = fixture();
  state.queue.push(missing(), '{', missing());
  await api.tick();
  assert.equal(state.accepted.length, 0);
  assert.equal(api.state().observed, '');
  assert.equal(api.state().lastAcceptedIdentity, '');
  await api.tick();
  assert.equal(state.accepted.length, 1);
  assert.equal(api.state().lastAcceptedIdentity, inputIdentity(input));
  assert.equal(state.reads, 4);
  await api.tick();
  assert.equal(state.accepted.length, 1, 'A successfully accepted request must not replay');
  assert.deepEqual(state.errors, []);
});

test('an explicitly cancelled unseen request is not resurrected by a later heartbeat', async () => {
  const {state, api} = fixture();
  state.lease.valid = false;
  await api.tick();
  assert.equal(state.accepted.length, 0);
  assert.equal(api.state().lastAcceptedIdentity, '');
  state.lease.valid = true;
  await api.tick();
  assert.equal(state.accepted.length, 0);
  assert.equal(state.reads, 1);
});

test('active reactions survive a short rename gap but fail closed after bounded unreadability', async () => {
  const {state, api} = fixture();
  await api.tick();
  const request = state.accepted[0];
  state.queue.push(missing(), '{');
  await api.tick();
  assert.equal(request.controller.signal.aborted, false);
  state.queue.push(missing(), missing(), missing());
  await api.tick();
  assert.equal(request.controller.signal.aborted, true);
  assert.deepEqual(state.delays, [15, 15, 15, 15]);
});

test('an invalid lease cannot abort a newer owner while its read was pending', async () => {
  const {state, api} = fixture();
  await api.tick();
  const first = state.accepted[0];
  const newer = {input: {...input, requestId: '1001-2-2ULL'}, controller: new AbortController()};
  state.queue.push(JSON.stringify({...state.lease, valid: false}));
  const poll = api.tick();
  api.setActive(newer);
  await poll;
  assert.equal(first.controller.signal.aborted, false);
  assert.equal(newer.controller.signal.aborted, false);
});
