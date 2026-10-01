import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatMemoryResets} from './chat-memory-resets.mjs';
import {PlayerMemory} from './player-memory.mjs';
import {PhoneChat} from './phone-chat.mjs';

const action = (id, state = 'pending', profileKey = 'judy-alvarez') => ({id, state,
  scope: profileKey ? 'character' : 'all', ...(profileKey ? {profileKey} : {}), uncertain: false});
const status = (actions = [], characters = []) => ({actions, characters});
function fixture() {
  let raw, failWrite = false;
  const writes = [];
  const options = {path: 'injected-journal', now: () => 1000,
    read: async () => { if (raw === undefined) throw Object.assign(Error('missing'), {code:'ENOENT'}); return raw; },
    write: async (path, value) => { assert.equal(path, 'injected-journal'); if (failWrite) throw Error('Storage failure'); raw = value; writes.push(JSON.parse(value)); }};
  return {options, writes, value: () => JSON.parse(raw), corrupt: value => { raw = value; }, fail: value => { failWrite = value; }};
}

test('first installation baselines prior clears without deleting conversations created afterward', async () => {
  const f = fixture(), old = action('old-success', 'succeeded');
  const journal = await ChatMemoryResets.open({...f.options, status: status([old])});
  assert.deepEqual(f.value().baseline.map(row=>row.id), ['old-success']);
  assert.deepEqual(f.value().receipts, []);
  assert.equal(journal.phoneState('judy-alvarez').characterEpoch,1,'baseline suppresses deletion replay, not request retirement');
  await journal.sync(status([old, action('new-success', 'succeeded')]));
  assert.deepEqual(f.value().receipts.map(row=>row.id), ['new-success']);
  assert.ok(!JSON.stringify(f.value()).includes('characterId'));
});

test('persisted intent blocks the scope before cloud dispatch and survives the registry write gap', async () => {
  const f = fixture(), journal = await ChatMemoryResets.open({...f.options, status: status()});
  await journal.start(action('requested'));
  await journal.sync(status());
  assert.deepEqual(f.value().pending.map(row=>row.id), ['requested']);
  assert.deepEqual(f.value().blockedProfiles, ['judy-alvarez']);
  await journal.sync(status(), {finished:action('requested')});
  assert.deepEqual(f.value().pending, []); assert.deepEqual(f.value().receipts, []);
});

test('failed, cancelled and partial family/all clears retain local Chat data', async () => {
  const f = fixture(), journal = await ChatMemoryResets.open({...f.options, status:status()});
  for (const row of [action('failed','failed'), {...action('uncertain','failed'),uncertain:true},
    action('partial-all','failed',null), {...action('invalid-success','succeeded'),uncertain:true}]) {
    await journal.start(row); await journal.sync(status([row]), {finished:row});
  }
  assert.deepEqual(f.value().receipts, []);
  await journal.sync(status([action('uncertain','failed')], [{profileKey:'judy-alvarez',blocked:true}]));
  assert.deepEqual(f.value().blockedProfiles, ['judy-alvarez']);
});

test('confirmed character and all receipts remain exact, durable and idempotent across restarts', async () => {
  const f = fixture(), journal = await ChatMemoryResets.open({...f.options, status:status()});
  const first = action('first'), all = action('all','pending',null);
  await journal.start(first); await journal.sync(status([first]));
  await journal.sync(status([{...first,state:'succeeded'}]));
  await journal.start(all); await journal.sync(status([{...first,state:'succeeded'},all]));
  assert.equal(f.value().blockAll, true);
  const current = status([{...first,state:'succeeded'},{...all,state:'succeeded'}]);
  await journal.sync(current);
  const final = f.value(), writeCount = f.writes.length;
  assert.deepEqual(final.receipts, [{id:'first',scope:'character',profileKey:'judy-alvarez'},{id:'all',scope:'all'}]);
  const reopened = await ChatMemoryResets.open({...f.options,status:current}); await reopened.sync(current);
  assert.equal(f.writes.length, writeCount); assert.deepEqual(f.value(), final);
});

test('restart reconciles a missed successful outcome without repeating a deletion', async () => {
  const f = fixture(), journal = await ChatMemoryResets.open({...f.options,status:status()});
  await journal.start(action('persisted-intent'));
  await ChatMemoryResets.open({...f.options,status:status([action('persisted-intent','succeeded')])});
  assert.deepEqual(f.value().receipts.map(row=>row.id), ['persisted-intent']);
  assert.deepEqual(f.value().pending, []);
});

test('startup abandons an orphan local intent without deleting data or retrying the cloud', async () => {
  const f = fixture(), journal = await ChatMemoryResets.open({...f.options,status:status()});
  await journal.start(action('not-dispatched'));
  await ChatMemoryResets.open({...f.options,status:status()});
  assert.deepEqual(f.value().pending, []); assert.deepEqual(f.value().receipts, []);
});

test('failed receipt writes keep prior ownership and can be retried locally after provider success', async () => {
  const f = fixture(), journal = await ChatMemoryResets.open({...f.options,status:status()});
  await journal.start(action('requested'));
  const prior = f.value(); f.fail(true);
  await assert.rejects(journal.sync(status([action('requested','succeeded')])), /Storage/);
  assert.deepEqual(f.value(), prior); assert.deepEqual(journal.state.receipts, []);
  f.fail(false); await journal.sync(status([action('requested','succeeded')]));
  assert.deepEqual(f.value().receipts.map(row=>row.id), ['requested']);
});

test('same-ID scope changes and malformed established journals fail without overwriting ownership', async () => {
  const f = fixture(), journal = await ChatMemoryResets.open({...f.options,status:status()});
  await journal.start(action('owned')); const prior=f.value();
  await assert.rejects(journal.start(action('owned','pending','panam-palmer')), /ownership/);
  await assert.rejects(journal.sync(status([action('owned','succeeded','panam-palmer')])), /ownership/);
  assert.deepEqual(f.value(), prior);
  for (const raw of ['broken', JSON.stringify({...prior,receipts:[{id:'not-tracked',scope:'all'}]}),
    JSON.stringify({...prior,blockedProfiles:['__proto__']})]) {
    f.corrupt(raw); await assert.rejects(ChatMemoryResets.open({...f.options,status:status()}), /Invalid/);
    assert.equal(await f.options.read(), raw);
  }
});

test('explicit family upgrade baselines legacy subset receipts without widening their old deletion scope', async () => {
  const f=fixture(), old=action('old-variant','succeeded','judy-alvarez-romantic');
  const journal=await ChatMemoryResets.open({...f.options,status:status()});
  await journal.start(old);await journal.sync(status([old]));
  const next=await ChatMemoryResets.open({...f.options,profileFamilies:{'judy-alvarez-romantic':'judy-alvarez'},
    status:status([{...old,profileKey:'judy-alvarez'}],[{profileKey:'judy-alvarez',blocked:true}])});
  assert.deepEqual(f.value().receipts,[]);
  assert.deepEqual(f.value().baseline,[{id:'old-variant',scope:'character',profileKey:'judy-alvarez'}]);
  assert.equal(f.value().profileFamilies['judy-alvarez-romantic'],'judy-alvarez');
  assert.equal(next.phoneState('judy-alvarez').characterEpoch,1);
  await next.sync(status([{...old,profileKey:'judy-alvarez'},action('unmapped','succeeded','custom-romantic'),action('aggregate','succeeded')]));
  assert.deepEqual(f.value().receipts.find(row=>row.id==='aggregate'),{id:'aggregate',scope:'character',profileKey:'judy-alvarez'});
  assert.equal(f.value().receipts.find(row=>row.id==='unmapped').profileKey,'custom-romantic');
  await assert.rejects(ChatMemoryResets.open({...f.options,status:status(),
    profileFamilies:{'judy-alvarez-romantic':'panam-palmer'}}),/ownership/);
  await assert.rejects(ChatMemoryResets.open({...f.options,status:status(),
    profileFamilies:{'judy-alvarez':'panam-palmer'}}),/Invalid/);
});

test('real durable recovery epochs fence same-ID stale phone files even before journal heartbeat sync', async t => {
  const directory=await fs.mkdtemp(join(tmpdir(),'chat-reset-recovery-')), path=join(directory,'memory.json');
  let memory;const calls=[];let quiesces=0;
  t.after(async()=>{await memory?.close();await fs.rm(directory,{recursive:true,force:true});});
  memory=await PlayerMemory.open({path,characterIds:{'judy-alvarez':'fixture-judy'},quiesce:async()=>({quiesced:++quiesces>1}),
    provider:{enableMemory:async()=>({enabled:true,changed:false}),clearMemory:async()=>({accepted:true,providerEmptyObserved:false}),
      inspectMemory:async()=>({providerEmptyObserved:true})}});
  await memory.beginConversation({profileKey:'judy-alvarez',source:'player'});
  const f=fixture(),journal=await ChatMemoryResets.open({...f.options,status:memory.status(),resetEpochFor:key=>memory.phoneResetEpochs(key)});
  const intent=action('recover-same-id');await journal.start(intent);
  const failed=await memory.clearCharacter({profileKey:'judy-alvarez',actionId:intent.id});assert.equal(failed.state,'failed');
  await journal.sync(memory.status());
  const before=journal.phoneState('judy-alvarez');assert.equal(before.characterEpoch,1);assert.equal(before.characterMemoryEpoch,1);
  assert.equal(before.blocked,false);
  await memory.recoverClear({actionId:intent.id});
  const after=journal.phoneState('judy-alvarez');assert.equal(after.characterEpoch,1);assert.equal(after.characterMemoryEpoch,2);
  const chat=new PhoneChat({contacts:[{contact:'judy',key:'judy-alvarez'}],ids:{'judy-alvarez':'fixture-judy'},
    resetFor:key=>journal.phoneState(key),reply:async value=>{calls.push(value);return {text:'Should not repeat',sessionID:'fixture'};},publish:async()=>{},now:()=>1000});
  const {blocked,...owner}=before;
  await chat.accept({version:2,world:'fixture-world',updated:1000,active:true,saveIdentity:{version:1,status:'unavailable',generation:1},
    request:{id:'fixture-world-1',contact:'judy',text:'Old pending message',memoryReset:owner,saveIdentity:{version:1,status:'unavailable',generation:1}}});
  await chat.active?.work;assert.deepEqual(calls,[]);
  await journal.sync(memory.status());assert.equal(f.value().memoryEpochs.characterEpochs['judy-alvarez'],2);
  assert.equal(memory.phoneResetEpochs('judy-alvarez').characterEpoch,2);
});

test('empty contacted sets produce successful local clear receipts without unused-character provider setup', async t => {
  const directory=await fs.mkdtemp(join(tmpdir(),'chat-reset-empty-')),path=join(directory,'memory.json');
  let memory;const calls=[];
  t.after(async()=>{await memory?.close();await fs.rm(directory,{recursive:true,force:true});});
  memory=await PlayerMemory.open({path,characterIds:{'judy-alvarez':'fixture-unused-judy'},quiesce:async()=>({quiesced:true}),
    provider:{enableMemory:async()=>{calls.push('enable');throw Error('Unused character');},
      clearMemory:async()=>{calls.push('clear');throw Error('No contacted pair');},inspectMemory:async()=>{calls.push('inspect');throw Error('No contacted pair');}}});
  const f=fixture(),journal=await ChatMemoryResets.open({...f.options,status:memory.status(),resetEpochFor:key=>memory.phoneResetEpochs(key)});
  await journal.start(action('empty-character'));
  const character=await memory.clearCharacter({profileKey:'judy-alvarez',actionId:'empty-character'});assert.equal(character.state,'succeeded');
  await journal.sync(memory.status());
  await journal.start(action('empty-all','pending',null));const all=await memory.clearAll({actionId:'empty-all'});assert.equal(all.state,'succeeded');
  await journal.sync(memory.status());assert.deepEqual(calls,[]);assert.equal(memory.status().talkedToCount,0);
  assert.deepEqual(f.value().receipts.map(row=>row.scope),['character','all']);assert.equal(journal.phoneState('judy-alvarez').globalMemoryEpoch,1);
});

test('the default file writer commits a complete locally owned receipt for restart reconciliation', async t => {
  const directory=await fs.mkdtemp(join(tmpdir(),'chat-reset-journal-')), path=join(directory,'resets.json');
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const journal=await ChatMemoryResets.open({path,status:status()});
  await journal.start(action('temp-store'));await journal.sync(status([action('temp-store','succeeded')]));
  const reopened=await ChatMemoryResets.open({path,status:status([action('temp-store','succeeded')])});
  assert.equal(reopened.state.receipts[0].profileKey,'judy-alvarez');
  assert.equal((await fs.readdir(directory)).length,1);
});

test('phone intent epochs fence only the affected character and survive failed clears and restart', async () => {
  const f=fixture(), journal=await ChatMemoryResets.open({...f.options,status:status()});
  assert.deepEqual(journal.phoneState('judy-alvarez'),{version:1,globalEpoch:0,characterEpoch:0,blocked:false});
  await journal.start(action('judy-intent'));
  assert.deepEqual(journal.phoneState('judy-alvarez'),{version:1,globalEpoch:0,characterEpoch:1,blocked:true});
  assert.deepEqual(journal.phoneState('panam-palmer'),{version:1,globalEpoch:0,characterEpoch:0,blocked:false});
  const actions=[action('judy-intent','failed')];await journal.sync(status(actions));
  assert.deepEqual(journal.phoneState('judy-alvarez'),{version:1,globalEpoch:0,characterEpoch:1,blocked:false});
  const reopened=await ChatMemoryResets.open({...f.options,status:status(actions)});
  assert.deepEqual(reopened.phoneState('judy-alvarez'),journal.phoneState('judy-alvarez'));
  await reopened.start(action('all-intent','pending',null));
  assert.deepEqual(reopened.phoneState('panam-palmer'),{version:1,globalEpoch:1,characterEpoch:0,blocked:true});
  await reopened.sync(status([...actions,action('all-intent','succeeded',null)]));
  assert.equal(reopened.phoneState('judy-alvarez').globalEpoch,1);assert.equal(reopened.phoneState('judy-alvarez').blocked,false);
});
