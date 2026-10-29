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
      characters: [{profileKey: 'judy-alvarez'}, {profileKey: 'panam-palmer'}], command: actions.get(actionId), actions:[...actions.values()]}),
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

test('closing never throws when the last status write is refused (the game exiting holds the file), so the shutdown goes on to close the memory', async () => {
  const f = fixture();
  let refuse = false;
  const control = await PlayerMemoryControl.open({...f.options, publish: async value => {
    if (refuse) throw Object.assign(Error('EPERM: operation not permitted, rename'), {code: 'EPERM'});
    f.published.push(value);
  }});
  refuse = true;
  await control.close();
  assert.equal(control.closed, true);
});

test('a full disk at start-up does not stop the bridge: the first status write is best effort, any other fault still throws', async () => {
  const f = fixture();
  const control = await PlayerMemoryControl.open({...f.options, publish: async () => { throw Object.assign(Error('ENOSPC: no space left on device, write'), {code: 'ENOSPC'}); }});
  assert.equal(control.closed, false);
  await assert.rejects(PlayerMemoryControl.open({...f.options, publish: async () => { throw Object.assign(Error('EACCES: permission denied'), {code: 'EACCES'}); }}), /EACCES/);
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

test('a durable local Chat intent precedes provider dispatch and the aggregate result is reconciled', async () => {
  const f=fixture(), events=[];
  const chatResets={start:async command=>{events.push(['intent',command.id]);},
    sync:async(status,options)=>{events.push(['sync',status.actions.map(row=>row.state),options?.finished?.id]);}};
  const clear=f.memory.clearCharacter;
  f.memory.clearCharacter=async options=>{events.push(['dispatch',options.actionId]);return clear(options);};
  const control=await PlayerMemoryControl.open({...f.options,chatResets});
  f.set(command('new-clear'));await control.poll();
  await new Promise(done=>setImmediate(done));
  assert.ok(events.findIndex(row=>row[0]==='intent') < events.findIndex(row=>row[0]==='dispatch'));
  f.gate.resolve();await control.work;await control.writing;
  assert.ok(events.some(row=>row[0]==='sync'&&row[1].includes('succeeded')&&row[2]==='new-clear'));
  await control.close();
});

test('failed local intent persistence prevents cloud deletion; later status failure is explicit', async () => {
  const f=fixture(), control=await PlayerMemoryControl.open({...f.options,
    chatResets:{start:async()=>{throw Error('Disk full');},sync:async()=>{throw Error('Disk full');}}});
  f.set(command('intent-failed'));await control.poll();await control.work;await control.writing;
  assert.equal(f.calls.length,0);assert.equal(f.published.at(-1).command.state,'failed');
  assert.equal(f.published.at(-1).chatHistory,'unavailable');
  await control.close();
});

test('shutdown while intent is persisting never starts a provider operation afterward', async () => {
  const f=fixture(), gate=deferred(), entered=deferred();
  const control=await PlayerMemoryControl.open({...f.options,chatResets:{
    start:async()=>{entered.resolve();await gate.promise;},sync:async()=>{}}});
  f.set(command('persisting'));await control.poll();await entered.promise;
  const closing=control.close();gate.resolve();await closing;
  assert.equal(f.calls.length,0);assert.equal(f.published.at(-1).state,'unavailable');
});

test('explicit family mapping canonicalizes legacy command keys without changing their action ID', async () => {
  const old=command('old-variant','judy-alvarez-romantic'), f=fixture(JSON.stringify(old));
  f.actions.set(old.id,{...old,profileKey:'judy-alvarez',state:'succeeded'});
  const control=await PlayerMemoryControl.open({...f.options,chatResetFamilies:{'judy-alvarez-romantic':'judy-alvarez'}});
  assert.equal(f.calls.length,0);assert.equal(f.published.at(-1).command.state,'succeeded');
  assert.equal(f.published.at(-1).command.profileKey,'judy-alvarez');
  f.set(command('new-family','judy-alvarez-romantic'));await control.poll();
  assert.equal(f.calls[0].profileKey,'judy-alvarez');assert.equal(f.calls[0].actionId,'new-family');
  f.gate.resolve();await control.work;await control.close();
});

test('an all reset with the memory registry null profile restores exactly without invalid-request status', async () => {
  const old=command('old-all',null), f=fixture(JSON.stringify(old));
  f.actions.set(old.id,{...old,profileKey:null,state:'succeeded'});
  const control=await PlayerMemoryControl.open(f.options);
  assert.equal(f.calls.length,0);assert.equal(f.published.at(-1).command.state,'succeeded');
  assert.equal(Object.hasOwn(f.published.at(-1).command,'profileKey'),false);
  f.set({...old,issuedAt:NOW-1});await control.poll();
  assert.equal(f.published.at(-1).command.state,'succeeded');await control.close();
});
