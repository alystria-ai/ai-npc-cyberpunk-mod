import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseInput} from './protocol.mjs';
import {VTalkLedger} from './v-talks.mjs';
import {inputIdentity, parsedInputIdentity} from './group-prefetch.mjs';
import {fileIdentity, RequestFileOwner, requestFileEmpty} from './request-ownership.mjs';
import {reactionLeaseProblem} from './battle-context.mjs';

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
  const state = {queue: [], reads: 0, delays: [], accepted: [], errors: [], statuses: [], gone: false, actionRevocations: 0, now: Date.now(),
    lease: {requestId: input.requestId, valid: true, updated: Date.now()}};
  // The bridge's clock (Date.now) is this fixture's own, so a test can let time pass.
  const clock = {now: () => state.now};
  const context = vm.createContext({parseInput, vTalkLedger: new VTalkLedger(), inputIdentity, parsedInputIdentity, fileIdentity, RequestFileOwner, requestFileEmpty,
    reactionLeaseProblem: (value, lease) => reactionLeaseProblem(value, lease, state.now), Date: clock, AbortController,
    companionActions: {revoke: async () => { state.actionRevocations++; }},
    readLease: async () => {
      state.reads++;
      const value = state.queue.length ? state.queue.shift() : JSON.stringify(state.lease);
      if (value instanceof Error) throw value;
      return value;
    },
    record: request => state.accepted.push(request), noteStatus: (...args) => state.statuses.push(args), fileState: state,
    setTimeout: (done, delay) => { state.delays.push(delay); done(); },
    console: {error: (...args) => { state.errors.push(args); throw Error(args.join(' ')); }}, rawInput: JSON.stringify(input)});
  vm.runInContext(`
    let polling=false, stopped=false, active=null, observed='', observedIdentity=null, invalidSeen='', lastAcceptedIdentity='', voiceRouteReservation=false;
    let relationshipRouteReservation=false;
    const inputPath='input', runtime='runtime', resolve=(...parts)=>parts.join('/');
    const stat=async()=>fileState.gone?null:({mtimeMs:1,size:rawInput.length});
    const readFile=async path=>path===inputPath ? rawInput : readLease();
    const prefetch={invalidate(){},claim(){return null;}}, lookahead={claim(){return null;}}, completeContext=()=>'', status=async(...args)=>noteStatus(...args);
    const processInput=request=>record(request);
    ${adapter}
    globalThis.api={tick,reactionCurrent,refusal:reactionLeaseRefusal,state:()=>({active,observed,lastAcceptedIdentity}),
      setActive:value=>{active=value;},setRelationshipReservation:value=>{relationshipRouteReservation=value;}};
  `, context);
  return {state, api: context.api, context};
}

test('manual turns do not read a reaction lease', async () => {
  const {state, api} = fixture();
  assert.equal(await api.reactionCurrent({...input, reaction: undefined}), true);
  assert.equal(state.reads, 0);
});

test('a relationship route reservation preserves an unseen battle input until page retirement finishes', async () => {
  const {state, api} = fixture();
  api.setRelationshipReservation(true);
  await api.tick();
  assert.equal(state.reads, 0); assert.equal(state.accepted.length, 0);
  assert.equal(state.actionRevocations, 0);
  assert.equal(api.state().observed, ''); assert.equal(api.state().lastAcceptedIdentity, '');
  api.setRelationshipReservation(false);
  await api.tick();
  assert.equal(state.accepted.length, 1); assert.equal(state.reads, 1);
  assert.equal(state.actionRevocations, 1);
  assert.equal(api.state().lastAcceptedIdentity, inputIdentity(input));
  assert.deepEqual(state.errors, []);
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
    Object.assign(Error('Is a directory'), {code: 'EISDIR'}),
  ]) {
    const {state, api} = fixture();
    state.queue.push(value);
    assert.equal(await api.reactionCurrent(input), false);
    assert.equal(state.reads, 1);
    assert.deepEqual(state.delays, []);
  }
});

test('a Windows sharing refusal while the game replaces the lease is retried like a rename gap', async () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const {state, api} = fixture();
    state.queue.push(Object.assign(Error('Sharing violation'), {code}));
    assert.equal(await api.reactionCurrent(input), true, code);
    assert.equal(state.reads, 2);
    assert.deepEqual(state.delays, [15]);
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
  assert.equal(state.actionRevocations, 1, 'Only the newly accepted input revokes an earlier action');
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
  assert.equal(state.actionRevocations, 0);
});

test('active reactions survive a short rename gap but fail closed after bounded unreadability', async () => {
  const {state, api} = fixture();
  await api.tick();
  const request = state.accepted[0];
  state.queue.push(missing(), '{');
  await api.tick();
  assert.equal(request.controller.signal.aborted, false);
  // Unreadable three times in a row, a moment after a good read: the remark the game is playing goes on.
  state.now += 400;
  state.queue.push(missing(), missing(), missing());
  await api.tick();
  assert.equal(request.controller.signal.aborted, false, 'one refused read must not cut a playing reaction');
  // Still unreadable well after the last good read: it fails closed.
  state.now += 1500;
  state.queue.push(missing(), missing(), missing());
  await api.tick();
  assert.equal(request.controller.signal.aborted, true);
  assert.deepEqual(state.delays, [15, 15, 15, 15, 15, 15]);
});

test('a lease that names why it refused is kept for the log of a remark nobody heard', async () => {
  const {state, api} = fixture();
  const late = {...input, requestId: '1002-3-1ULL', reaction: {...input.reaction, expiresAt: state.now - 250}};
  state.queue.push(JSON.stringify({requestId: late.requestId, valid: true, updated: state.now}));
  assert.equal(await api.reactionCurrent(late), false);
  assert.match(api.refusal(late.requestId), /past its deadline by 250 ms with no playback confirmed/);
  state.queue.push(JSON.stringify({requestId: late.requestId, valid: true, updated: state.now, playbackStartedAt: state.now - 500}));
  assert.equal(await api.reactionCurrent(late), true, 'playback that began before the deadline carries the request past it');
  assert.equal(api.refusal(late.requestId), null);
  state.queue.push(JSON.stringify({requestId: late.requestId, valid: false, updated: state.now}));
  assert.equal(await api.reactionCurrent(late), false);
  assert.equal(api.refusal(late.requestId), 'withdrawn by the game');
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

// The game withdraws a request by writing last-input.json empty (it never deletes the file: Mod Organizer 2), and ships it empty.
test('an empty request file is a missing request file: nothing accepted, nothing reported, nothing remembered', async () => {
  const outcome = async setup => {
    const {state, api, context} = fixture();
    setup(context, state);
    await api.tick(); await api.tick();
    return {accepted: state.accepted.length, statuses: state.statuses, errors: state.errors, reads: state.reads, observed: api.state().observed};
  };
  const missingFile = await outcome((context, state) => { state.gone = true; });
  const emptyFile = await outcome(context => { context.rawInput = ''; });
  const blankFile = await outcome(context => { context.rawInput = ' \t '; });
  assert.deepEqual(emptyFile, missingFile);
  assert.deepEqual(blankFile, missingFile);
  assert.deepEqual(emptyFile, {accepted: 0, statuses: [], errors: [], reads: 0, observed: ''});
});

test('a request written over an empty file is accepted, and an empty write afterwards does not cancel or reaccept anything', async () => {
  const {state, api, context} = fixture();
  const full = context.rawInput;
  context.rawInput = ''; await api.tick();
  assert.equal(state.accepted.length, 0);
  context.rawInput = full; await api.tick();
  assert.equal(state.accepted.length, 1);
  // The withdrawal: the bridge's poll takes no action of its own on it (the request owner sees the change), and the same
  // request written again is the one it already accepted.
  context.rawInput = ''; await api.tick(); await api.tick();
  assert.equal(state.accepted.length, 1); assert.equal(state.accepted[0].controller.signal.aborted, false);
  assert.deepEqual(state.statuses, []); assert.deepEqual(state.errors, []);
});

test('a half-written request is read again on the next change, and only content that stays unreadable is reported', async () => {
  const {state, api, context} = fixture();
  const full = context.rawInput;
  context.rawInput = full.slice(0, 40);
  await api.tick();
  assert.equal(state.accepted.length, 0); assert.deepEqual(state.statuses, []);
  // The write finished: the finished request is accepted, and the partial read was never reported.
  context.rawInput = full; await api.tick();
  assert.equal(state.accepted.length, 1); assert.deepEqual(state.statuses, []);
  // Content that still cannot be parsed on the poll after is a real fault, and is reported once.
  api.setActive(null);
  context.rawInput = '{"requestId": nonsense'; await api.tick();
  assert.deepEqual(state.statuses, []);
  await api.tick(); await api.tick();
  assert.equal(state.statuses.length, 1); assert.equal(state.statuses[0][0], 'invalid-input');
});
