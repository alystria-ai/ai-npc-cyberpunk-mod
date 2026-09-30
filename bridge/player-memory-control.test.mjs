import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseMemoryCommand, PlayerMemoryControl} from './player-memory-control.mjs';

const NOW = 1790746000000;
const command = (id, profileKey = 'judy-alvarez') => ({version: 1, id, action: 'clear',
  scope: profileKey ? 'character' : 'all', ...(profileKey ? {profileKey} : {}), issuedAt: NOW});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
function fixture(initial = '') {
  let raw = initial;
  const published = [], calls = [], actions = new Map(), gate = deferred();
  const memory = {
    status: ({actionId} = {}) => ({available: true, talkedToCount: 2,
      characters: [{profileKey: 'judy-alvarez'}, {profileKey: 'panam-palmer'}], command: actions.get(actionId)}),
    async clearCharacter({profileKey, actionId, signal}) {
      calls.push({profileKey, actionId, signal});
      const pending = {id: actionId, scope: 'character', profileKey, state: 'pending'};
      actions.set(actionId, pending);
      await gate.promise;
      const result = {...pending, state: signal.aborted ? 'failed' : 'succeeded',
        message: signal.aborted ? 'Cancelled.' : 'Cloud memories currently empty.'};
      actions.set(actionId, result); return result;
    },
    async clearAll({actionId, signal}) {
      calls.push({actionId, signal});
      const result = {id: actionId, scope: 'all', state: 'succeeded', message: 'Cloud memories currently empty.'};
      actions.set(actionId, result); return result;
    },
  };
  return {memory, published, calls, actions, gate, set: value => { raw = typeof value === 'string' ? value : JSON.stringify(value); },
    options: {memory, commandPath: 'unused-by-injected-read', now: () => NOW,
      read: async () => raw, publish: async value => published.push(structuredClone(value))}};
}

test('memory command parser bounds identifiers and never accepts an identity or scope from a malformed command', () => {
  assert.deepEqual(parseMemoryCommand(JSON.stringify(command('ui-1:2')), NOW), command('ui-1:2'));
  for (const value of [command('bad/id'), {...command('a'), scope: 'account'},
    {...command('a'), profileKey: '__proto__'}, {...command('a', null), profileKey: 'judy-alvarez'},
    {...command('a'), issuedAt: NOW + 5001}, {...command('a'), issuedAt: 1.5},
    {...command('a'), version: 2}]) assert.equal(parseMemoryCommand(JSON.stringify(value), NOW), null);
  assert.equal(parseMemoryCommand('x'.repeat(8193), NOW), null);
});

test('startup restores a known result but never dispatches an old or unknown destructive command', async () => {
  const f = fixture(JSON.stringify(command('old-request')));
  const control = await PlayerMemoryControl.open(f.options);
  assert.equal(f.calls.length, 0);
  assert.equal(f.published.at(-1).command.id, 'old-request');
  assert.equal(f.published.at(-1).command.state, 'failed');
  await control.poll(); assert.equal(f.calls.length, 0);
  await control.close();

  const known = fixture(JSON.stringify(command('known-request')));
  known.actions.set('known-request', {...command('known-request'), state: 'succeeded'});
  const second = await PlayerMemoryControl.open(known.options);
  assert.equal(known.published.at(-1).command.state, 'succeeded');
  assert.equal(known.calls.length, 0);
  await second.close();
});

test('only a new confirmed command dispatches; its pending result is exact and repeated file observations do not retry', async () => {
  const f = fixture(), control = await PlayerMemoryControl.open(f.options);
  f.set(command('new-request')); await control.poll();
  assert.equal(f.calls.length, 1);
  assert.equal(f.published.at(-1).command.state, 'pending');
  await Promise.all([control.poll(), control.poll()]);
  assert.equal(f.calls.length, 1);
  const work = control.work; f.gate.resolve(); await work; await control.writing;
  assert.equal(f.published.at(-1).command.state, 'succeeded');
  f.set({...command('new-request'), issuedAt: NOW - 1}); await control.poll();
  assert.equal(f.calls.length, 1);
  assert.equal(f.published.at(-1).command.state, 'succeeded');
  await control.close();
});

test('a same-ID scope change cannot borrow the successful result for a different character', async () => {
  const f = fixture(), control = await PlayerMemoryControl.open(f.options);
  f.actions.set('known', {id: 'known', scope: 'character', profileKey: 'judy-alvarez', state: 'succeeded'});
  f.set(command('known', 'panam-palmer')); await control.poll();
  assert.equal(f.calls.length, 0);
  assert.equal(f.published.at(-1).command.profileKey, 'panam-palmer');
  assert.equal(f.published.at(-1).command.state, 'failed');
  await control.close();
});

test('an overlapping command is rejected and a late completion cannot overwrite the newer command status', async () => {
  const f = fixture(), control = await PlayerMemoryControl.open(f.options);
  f.set(command('first')); await control.poll();
  f.set(command('second', 'panam-palmer')); await control.poll();
  assert.equal(f.calls.length, 1);
  assert.equal(f.published.at(-1).command.id, 'second');
  assert.equal(f.published.at(-1).command.state, 'failed');
  const work = control.work; f.gate.resolve(); await work; await control.writing;
  assert.equal(f.published.at(-1).command.id, 'second');
  assert.equal(f.published.at(-1).command.state, 'failed');
  await control.close();
});

test('expired requests fail visibly without provider calls; an explicit all command targets the memory owner', async () => {
  const f = fixture(), control = await PlayerMemoryControl.open(f.options);
  f.set({...command('expired'), issuedAt: NOW - 120001}); await control.poll();
  assert.equal(f.calls.length, 0); assert.equal(f.published.at(-1).command.state, 'failed');
  f.set(command('all', null)); await control.poll();
  await control.work; await control.writing;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].actionId, 'all');
  assert.equal(f.published.at(-1).command.scope, 'all');
  assert.equal(f.published.at(-1).talkedToCount, 2);
  await control.close();
});

test('shutdown cancels the in-flight clear and publishes unavailable without starting another request', async () => {
  const f = fixture(), control = await PlayerMemoryControl.open(f.options);
  f.set(command('pending')); await control.poll();
  const closing = control.close();
  assert.equal(f.calls[0].signal.aborted, true);
  f.gate.resolve(); await closing;
  assert.equal(f.published.at(-1).state, 'unavailable');
  f.set(command('after-close')); await control.poll();
  assert.equal(f.calls.length, 1);
});
