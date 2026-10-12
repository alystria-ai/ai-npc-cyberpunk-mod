import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {PhoneChat, parsePhoneState, parsePhoneBinding, phoneBindingKey, phoneScope, parsePlayerPhoneContext,
  parsePhoneReset, phoneRecentConversationContext} from './phone-chat.mjs';

const now = 100000;
const binding = (overrides = {}) => ({version: 1, status: 'available', authoritative: true, confidence: 'native-live',
  localUserId: 'user-1', campaignId: 'a'.repeat(32), branchId: 'b'.repeat(32), branchEpoch: 1,
  ledgerSequence: 10, generation: 1, activationId: 'c'.repeat(32), ...overrides});
const state = (overrides = {}) => {
  const value = {version: 2, world: 'world-1', updated: now, active: true, saveIdentity: binding(),
    request: {id: 'world-1-1', contact: 'judy', text: 'Hey Judy!'}, ...overrides};
  if (value.request) value.request = {saveIdentity: value.saveIdentity, ...value.request};
  return value;
};
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
function fixture(reply, options = {}) {
  const output = [], calls = [];
  const chat = new PhoneChat({contacts: [{contact: 'judy', key: 'judy-alvarez'}, {contact: 'panam', key: 'panam-palmer'}],
    ids: {'judy-alvarez': 'judy-id', 'panam-palmer': 'panam-id'}, now: () => now, ...options,
    reply: args => { calls.push(args); return reply(args); }, publish: async value => output.push(value)});
  return {chat, calls, output};
}

test('phone protocol accepts remote contacts without world entity spoofing and bounds input', () => {
  assert.equal(parsePhoneState(JSON.stringify(state())).request.contact, 'judy');
  for (const value of [state({world: '../../file'}), state({request: {id: 'another-world-1', contact: 'judy', text: 'hello'}}),
    state({request: {id: 'world-1-2', contact: 'judy', text: ' '}}),
    state({request: {id: 'world-1-2', contact: 'judy', text: 'a'.repeat(1201)}})]) {
    assert.equal(parsePhoneState(JSON.stringify(value)), null);
  }
});

async function finish(chat, value) { await chat.accept(value); await chat.active?.work; }

test('a legacy follow-up field is ignored and provider context is built once per send without changing displayed text or adding turns', async () => {
  for (const followUpQuestions of [undefined, false, null, 'true', 1, true]) {
    const message = 'How is the editing going?';
    const value = state({request: {id: 'world-1-1', contact: 'judy', text: message, followUpQuestions}});
    const {chat, calls, output} = fixture(async () => ({text: 'Going well.', sessionID: 'session'}));
    await finish(chat, value);
    assert.equal(calls.length, 1);
    assert.equal('followUpQuestions' in calls[0].input, false);
    assert.equal(calls[0].input.text, message);
    assert.match(calls[0].context, /Whether you ask V anything is your own call/);
    assert.doesNotMatch(calls[0].context, /follow-up question/i);
    assert.deepEqual(output.filter(row => row.state === 'reply').map(row => row.text), ['Going well.']);
  }
});
const memory = (save, remoteGeneration = 'remote-generation-1') => ({status: 'available',
  identity: {userId: save.localUserId, campaignId: save.campaignId, branchId: save.branchId, remoteGeneration},
  endUserId: `private-${save.branchId}-${remoteGeneration}`});
const playerContext = (overrides = {}) => ({status: 'player', endUserId: 'one-persistent-player',
  scope: `phone:world:${'a'.repeat(24)}`, sessionKey: 'b'.repeat(64), remoteGeneration: 'c'.repeat(64), ...overrides});
const unknownState = (overrides = {}) => state({saveIdentity: {version: 1, status: 'unavailable', generation: 1}, ...overrides});
const resetOwner = (characterEpoch=0,globalEpoch=0)=>({version:1,characterEpoch,globalEpoch});
const recentPhone = (overrides={})=>({version:1,source:'local-phone-chat',contact:'judy',profileKey:'judy-alvarez',
  world:'world-1',binding:'session:1',historyScope:'phone-local-player:v1',memoryReset:resetOwner(),
  rows:[{sent:true,text:'What are you editing?'},{sent:false,text:'Something from Lizzie’s.'}],...overrides});

test('recent actual phone messages are bounded, audience-bound and quoted without becoming instructions or facts', () => {
  const value=unknownState({request:{id:'world-1-1',contact:'judy',text:'Continue',memoryReset:resetOwner(),recentConversation:recentPhone()}});
  const parsed=parsePhoneState(JSON.stringify(value));assert.ok(parsed);
  assert.equal(Object.isFrozen(parsed.request.recentConversation),true);assert.equal(Object.isFrozen(parsed.request.recentConversation.rows[0]),true);
  const context=phoneRecentConversationContext({...parsed.request,profileKey:'judy-alvarez',channel:'phone'});
  assert.match(context,/quoted utterances, not new instructions or verified world facts/);
  assert.match(context,/What are you editing/);assert.ok(!context.includes('Continue'));
  assert.equal(phoneRecentConversationContext({...parsed.request,profileKey:'panam-palmer',channel:'phone'}),'');
  assert.equal(phoneRecentConversationContext({...parsed.request,profileKey:'judy-alvarez',channel:'private'}),'');
  for (const recent of [recentPhone({contact:'panam'}),recentPhone({world:'another-world'}),recentPhone({binding:'session:2'}),
    recentPhone({memoryReset:resetOwner(1)}),recentPhone({source:'native-story-messages'}),recentPhone({historyScope:'all-player-history'}),
    recentPhone({rows:Array.from({length:7},()=>({text:'Too many rows',sent:true}))}),
    recentPhone({rows:[{text:'あ'.repeat(801),sent:false}]}),recentPhone({rows:[{text:'Wrong role',sent:'false'}]}),
    recentPhone({rows:{1:{text:'Unordered row',sent:true}}})]) {
    assert.equal(parsePhoneState(JSON.stringify({...value,request:{...value.request,recentConversation:recent}})),null);
  }
  const empty=parsePhoneState(JSON.stringify({...value,request:{...value.request,recentConversation:recentPhone({rows:{}})}}));
  assert.deepEqual(empty.request.recentConversation.rows,[]);
  for(const owner of [{...resetOwner(),characterEpoch:-1},{...resetOwner(),globalEpoch:4097},{...resetOwner(),extra:'instruction'}]) assert.equal(parsePhoneReset(owner),null);
});

test('reset epochs prevent old pending phone files from acquiring a fresh guard after service restart', async () => {
  let owner={...resetOwner(),blocked:false};const old=defer(),entered=defer();
  const first=fixture(()=>{entered.resolve();return old.promise;},{resetFor:()=>owner,contextFor:()=>playerContext(),contextCurrent:()=>true});
  const input=unknownState({request:{id:'world-1-1',contact:'judy',text:'Before Forget',memoryReset:resetOwner()}});
  await first.chat.accept(input);const work=first.chat.active.work;await entered.promise;assert.equal(first.calls.length,1);
  owner={...resetOwner(1),blocked:true};old.resolve({text:'Obsolete reply',sessionID:'old'});await work;
  assert.equal(first.output.filter(row=>row.state==='reply').length,0);assert.equal(first.chat.transientSessions.size,0);
  owner={...resetOwner(1),blocked:false};
  const restarted=fixture(async()=>({text:'Fresh route',sessionID:'fresh'}),{resetFor:()=>owner,
    contextFor:()=>playerContext(),contextCurrent:()=>true});
  await finish(restarted.chat,input);assert.equal(restarted.calls.length,0);
  await finish(restarted.chat,unknownState({request:{id:'world-1-2',contact:'judy',text:'After Forget',memoryReset:resetOwner(1)}}));
  assert.equal(restarted.calls.length,1);assert.equal(restarted.output.at(-1).text,'Fresh route');
  owner={...resetOwner(1,1),blocked:false};
  await finish(restarted.chat,unknownState({request:{id:'world-1-3',contact:'judy',text:'Before all clear',memoryReset:resetOwner(1)}}));
  assert.equal(restarted.calls.length,1);
});

test('a reset of another character cannot invalidate the current phone owner', async () => {
  const gate=defer(), epochs={'judy-alvarez':0,'panam-palmer':0};
  const f=fixture(()=>gate.promise,{resetFor:key=>({...resetOwner(epochs[key]),blocked:false})});
  await f.chat.accept(unknownState({request:{id:'world-1-1',contact:'judy',text:'Unrelated to Panam',memoryReset:resetOwner()}}));
  const work=f.chat.active.work;epochs['panam-palmer']=1;gate.resolve({text:'Judy reply',sessionID:'judy'});await work;
  assert.equal(f.output.at(-1).text,'Judy reply');
});

test('stable player contexts require bounded exact phone, session and reset route fields', async () => {
  const context = playerContext(); assert.deepEqual(parsePlayerPhoneContext(context), context);
  assert.equal(Object.isFrozen(parsePlayerPhoneContext(context)), true);
  for (const value of [playerContext({endUserId: ''}), playerContext({endUserId: 'x'.repeat(257)}),
    playerContext({endUserId: 'another player'}), playerContext({scope: `private:world:${'a'.repeat(24)}`}),
    playerContext({scope: 'phone'}), playerContext({sessionKey: 'b'.repeat(65)}),
    playerContext({remoteGeneration: 'unverified-reset'}), playerContext({characterId:'../wrong-id'}),
    playerContext({characterId:''}), playerContext({characterId:'x'.repeat(257)})]) assert.equal(parsePlayerPhoneContext(value), null);
  for (const options of [{contextFor: () => playerContext()},
    {contextFor: () => playerContext({scope: `group:world:${'a'.repeat(24)}`}), contextCurrent: () => true}]) {
    const {chat, calls, output} = fixture(async () => ({text: 'Must not send', sessionID: 'invalid'}), options);
    await finish(chat, unknownState());
    assert.equal(calls.length, 0); assert.equal(output.at(-1).state, 'error');
  }
});

test('phone replies use the frozen selected provider ID and never borrow an ordinary/romantic session', async () => {
  let context=playerContext({characterId:'judy-romantic-id'});
  const {chat,calls,output}=fixture(async()=>({text:'Selected profile reply',sessionID:`variant-${calls.length}`}),
    {contextFor:()=>context,contextCurrent:()=>true});
  await finish(chat,unknownState());
  await finish(chat,unknownState({request:{id:'world-1-2',contact:'judy',text:'Again'}}));
  assert.deepEqual(calls.map(row=>row.characterId),['judy-romantic-id','judy-romantic-id']);
  assert.deepEqual(calls.map(row=>row.sessionId),['-1','variant-1']);
  context=playerContext({characterId:'judy-id'});
  await finish(chat,unknownState({request:{id:'world-1-3',contact:'judy',text:'Ordinary profile'}}));
  assert.equal(calls[2].characterId,'judy-id');assert.equal(calls[2].sessionId,'-1');
  context=playerContext({characterId:'judy-romantic-id'});
  await finish(chat,unknownState({request:{id:'world-1-4',contact:'judy',text:'Romantic again'}}));
  assert.equal(calls[3].sessionId,'variant-2');
  assert.ok(calls.every(row=>row.profileKey==='judy-alvarez'));
  assert.ok(output.every(row=>row.contact==='judy'&&!Object.hasOwn(row,'characterId')));
});

test('mutating a raw relationship context after dispatch cannot change that turn selected ID', async () => {
  const context=playerContext({characterId:'judy-romantic-id'}), gate=defer();
  const {chat,calls}=fixture(()=>gate.promise,{contextFor:()=>context,contextCurrent:()=>true});
  await chat.accept(unknownState());const work=chat.active.work;
  context.characterId='judy-id';gate.resolve({text:'Frozen profile reply',sessionID:'selected'});await work;
  assert.equal(calls[0].characterId,'judy-romantic-id');
  assert.equal([...chat.transientSessions.values()][0].characterId,'judy-romantic-id');
});

test('same player and contact still require exact scope, session key and reset epoch session reuse', async () => {
  let context = playerContext(); const writes = [];
  const {chat, calls} = fixture(async () => ({text: 'Scoped reply', sessionID: `player-session-${calls.length}`}),
    {contextFor: () => context, contextCurrent: () => true, saveSessions: async value => writes.push(value)});
  await finish(chat, unknownState());
  await finish(chat, unknownState({request: {id: 'world-1-2', contact: 'judy', text: 'Same route'}}));
  assert.deepEqual(calls.map(value => value.sessionId), ['-1', 'player-session-1']);
  context = playerContext({sessionKey: 'd'.repeat(64)});
  await finish(chat, unknownState({request: {id: 'world-1-3', contact: 'judy', text: 'New session route'}}));
  context = playerContext({sessionKey: 'd'.repeat(64), remoteGeneration: 'e'.repeat(64)});
  await finish(chat, unknownState({request: {id: 'world-1-4', contact: 'judy', text: 'Forgotten memory'}}));
  context = playerContext({scope: `phone:world:${'f'.repeat(24)}`, sessionKey: 'd'.repeat(64), remoteGeneration: 'e'.repeat(64)});
  await finish(chat, unknownState({request: {id: 'world-1-5', contact: 'judy', text: 'Changed world partition'}}));
  assert.deepEqual(calls.slice(2).map(value => value.sessionId), ['-1', '-1', '-1']);
  assert.equal(new Set(calls.map(value => value.endUserId)).size, 1); assert.equal(writes.length, 0);
  assert.equal(calls[4].scope, context.scope); assert.equal(calls[4].sessionKey, context.sessionKey);
  assert.equal(calls[4].remoteGeneration, context.remoteGeneration);
});

test('resetting the selected route while its guard awaits cannot admit a provider send', async () => {
  const guard = defer(), entered = defer();
  const {chat, calls, output} = fixture(async () => ({text: 'Must not send', sessionID: 'invalid'}),
    {contextFor: () => playerContext(), contextCurrent: () => { entered.resolve(); return guard.promise; }});
  await chat.accept(unknownState()); const work = chat.active.work; await entered.promise;
  guard.resolve(false); await work;
  assert.equal(calls.length, 0); assert.equal(output.filter(value => value.state === 'reply').length, 0);
  assert.equal(chat.transientSessions.size, 0);
});

test('a reply queued before forget is checked again at publication and cannot enter the cleared history', async () => {
  const provider = defer(), queue = defer(), queued = defer(); let epochCurrent = true;
  const {chat, output} = fixture(() => provider.promise,
    {contextFor: () => playerContext(), contextCurrent: () => epochCurrent});
  await chat.accept(unknownState()); const work = chat.active.work;
  const emit = chat.emit.bind(chat);
  chat.emit = (active, value) => { if (value.state === 'reply') queued.resolve(); return emit(active, value); };
  chat.writes = queue.promise;
  provider.resolve({text: 'Queued before forget', sessionID: 'queued-old-session'}); await queued.promise;
  epochCurrent = false; queue.resolve(); await work;
  assert.equal(output.filter(value => value.state === 'reply').length, 0);
});

test('superseding a player phone request with another contact blocks the first asynchronous reply', async () => {
  const old = defer(), entered = defer();
  const {chat, calls, output} = fixture(args => {
    if (args.profileKey === 'judy-alvarez') { entered.resolve(); return old.promise; }
    return {text: 'Panam reply', sessionID: 'panam-player-session'};
  }, {contextFor: ({profileKey}) => playerContext({sessionKey: (profileKey === 'judy-alvarez' ? 'b' : 'd').repeat(64)}),
    contextCurrent: () => true});
  await chat.accept(unknownState()); const work = chat.active.work; await entered.promise;
  await finish(chat, unknownState({request: {id: 'world-1-2', contact: 'panam', text: 'Panam instead'}}));
  assert.equal(calls[0].signal.aborted, true);
  old.resolve({text: 'Judy reply from superseded turn', sessionID: 'obsolete'}); await work;
  assert.deepEqual(output.filter(value => value.state === 'reply').map(value => value.contact), ['panam']);
});

test('phone sessions isolate two contacts, users, campaigns and rollback branches', async () => {
  let saved;
  const {chat, calls} = fixture(async () => ({text: 'Scoped reply', sessionID: `session-${calls.length}`}),
    {saveSessions: async value => { saved = structuredClone(value); }});
  await finish(chat, state());
  await finish(chat, state({request: {id: 'world-1-2', contact: 'panam', text: 'Hey Panam'}}));
  await finish(chat, state({request: {id: 'world-1-3', contact: 'judy', text: 'Back to Judy'}}));
  assert.deepEqual(calls.map(call => call.sessionId), ['-1', '-1', 'session-1']);
  for (const [index, saveIdentity] of [
    binding({campaignId: 'd'.repeat(32)}), binding({branchId: 'e'.repeat(32), branchEpoch: 2}),
    binding({localUserId: 'user-2'}),
  ].entries()) await finish(chat, state({saveIdentity,
    request: {id: `world-1-${index + 4}`, contact: 'judy', text: 'Another save'}}));
  assert.deepEqual(calls.slice(3).map(call => call.sessionId), ['-1', '-1', '-1']);
  await finish(chat, state({request: {id: 'world-1-7', contact: 'judy', text: 'Original branch again'}}));
  assert.equal(calls[6].sessionId, 'session-3');
  assert.equal(saved.version, 2); assert.equal(Object.keys(saved.scoped).length, 5);
});

test('unknown saves reuse only the current in-memory session and preserve legacy sessions without adopting them', async () => {
  const writes = [], legacy = {'judy-id': 'legacy-unscoped-session'};
  const {chat, calls} = fixture(async () => ({text: 'Hello', sessionID: `temporary-${calls.length}`}),
    {sessions: legacy, saveSessions: async value => writes.push(structuredClone(value))});
  await finish(chat, state({version: 1}));
  await finish(chat, state({version: 1, request: {id: 'world-1-2', contact: 'judy', text: 'Again'}}));
  await finish(chat, state({version: 1, world: 'world-2', request: {id: 'world-2-1', contact: 'judy', text: 'New load'}}));
  assert.deepEqual(calls.map(call => call.sessionId), ['-1', 'temporary-1', '-1']);
  assert.equal(writes.length, 0); assert.deepEqual(legacy, {'judy-id': 'legacy-unscoped-session'});
  await finish(chat, state());
  assert.equal(calls[3].sessionId, '-1'); assert.deepEqual(writes[0].legacy, legacy);
  const next = fixture(async () => ({text: 'Fresh anonymous reply', sessionID: 'new-process'}), {sessions: writes[0]});
  await finish(next.chat, state({version: 1}));
  assert.equal(next.calls[0].sessionId, '-1');
});

test('binding changes cancel work even when the world token is accidentally unchanged', async () => {
  for (const changed of [binding({generation: 2, activationId: 'd'.repeat(32)}),
    binding({branchId: 'e'.repeat(32), branchEpoch: 2}), {version: 1, status: 'unavailable', generation: 2}]) {
    const pending = defer(), writes = [];
    const {chat, calls, output} = fixture(() => pending.promise, {saveSessions: async value => writes.push(value)});
    await chat.accept(state()); const work = chat.active.work;
    await chat.accept(state({saveIdentity: changed, request: undefined}));
    assert.equal(calls[0].signal.aborted, true);
    pending.resolve({text: 'Obsolete branch reply', sessionID: 'obsolete'}); await work;
    assert.equal(output.filter(row => row.state === 'reply').length, 0);
    assert.equal(writes.length, 0);
  }
});

test('cancelled asynchronous context lookup cannot start a reply after a save transition', async () => {
  const capture = defer();
  const {chat, calls, output} = fixture(async () => ({text: 'Must not run', sessionID: 'wrong'}), {contextFor: () => capture.promise});
  await chat.accept(state()); const work = chat.active.work;
  await chat.accept(state({saveIdentity: binding({generation: 2, activationId: 'd'.repeat(32)}), request: undefined}));
  capture.resolve(memory(binding())); await work;
  assert.equal(calls.length, 0); assert.equal(output.filter(row => row.state === 'reply').length, 0);
});

test('ledger identities are verified before exposing end-user context and remote recovery starts fresh sessions', async () => {
  let generation = 'remote-generation-1';
  const {chat, calls} = fixture(async () => ({text: 'Bound reply', sessionID: `bound-${calls.length}`}),
    {contextFor: ({saveIdentity, characterKey, channel}) => {
      assert.equal(characterKey, 'judy-alvarez'); assert.equal(channel, 'phone'); return memory(saveIdentity, generation);
    }});
  await finish(chat, state());
  await finish(chat, state({request: {id: 'world-1-2', contact: 'judy', text: 'Same branch'}}));
  assert.equal(calls[0].profileKey, 'judy-alvarez'); assert.equal(calls[0].input.channel, 'phone');
  assert.equal(calls[0].endUserId, memory(binding()).endUserId); assert.equal(calls[1].sessionId, 'bound-1');
  generation = 'remote-generation-2';
  await finish(chat, state({request: {id: 'world-1-3', contact: 'judy', text: 'Recovered ledger'}}));
  assert.equal(calls[2].sessionId, '-1'); assert.notEqual(calls[2].endUserId, calls[0].endUserId);
  const wrong = fixture(async () => ({text: 'Must not run', sessionID: 'wrong'}),
    {contextFor: () => memory(binding({branchId: 'f'.repeat(32)}))});
  await finish(wrong.chat, state());
  assert.equal(wrong.calls.length, 0); assert.equal(wrong.output.at(-1).state, 'error');
});

test('submissions pass separate bounded world knowledge and reject stale generations or other phone audiences', async () => {
  const snapshot = {version: 1, status: 'ready', gameVersion: '2.31', generation: 1,
    capturedAt: '2026-09-30T10:00:00.000Z', identity: {status: 'verified', userId: 'user-1',
      playthroughId: 'a'.repeat(32), branchId: 'b'.repeat(32), checkpointId: 'checkpoint-10'},
    audience: {channel: 'phone', profileKeys: ['judy-alvarez']}, activeQuestKeys: [], facts: {}, journal: {}};
  const {chat, calls} = fixture(async () => ({text: 'Hello', sessionID: 'world-context'}));
  const send = async (number, worldKnowledge) => finish(chat, state({request: {
    id: `world-1-${number}`, contact: 'judy', text: 'Current objective?', worldKnowledge,
    journal: {version: 1, status: 'active', quest: {id: '10', title: 'Nocturne Op55N1',
      objectives: [{id: '11', text: 'Meet Hanako at Embers', tracked: true}]}}
  }}));
  await send(1, snapshot);
  assert.equal(calls[0].input.worldKnowledge.status, 'ready'); assert.deepEqual(calls[0].saveIdentity, binding());
  assert.match(calls[0].context, /Meet Hanako at Embers/); assert.equal(calls[0].input.text, 'Current objective?');
  await send(2, {...snapshot, generation: 0});
  await send(3, {...snapshot, audience: {channel: 'phone', profileKeys: ['panam-palmer']}});
  await send(4, {...snapshot, identity: {...snapshot.identity, branchId: 'd'.repeat(32)}});
  for (const call of calls.slice(1)) assert.equal(call.input.worldKnowledge.status, 'unavailable');
});

test('malformed binding claims cannot borrow a durable namespace and mismatched request bindings are rejected', () => {
  for (const mutate of [
    b => { b.authoritative = 'true'; }, b => { b.localUserId = undefined; }, b => { b.campaignId = '../../x'; },
    b => { b.activationId = 'short'; }, b => { b.generation = '1'; }, b => { b.branchEpoch = 0; },
    b => { b.ledgerSequence = -1; }, b => { b.confidence = 'guessed'; },
  ]) { const value = binding(); mutate(value); assert.equal(phoneScope(parsePhoneBinding(value)), null); }
  const value = state(); value.request.saveIdentity = binding({generation: 2});
  assert.equal(parsePhoneState(JSON.stringify(value)), null);
  assert.notEqual(phoneBindingKey(binding()), phoneBindingKey(binding({activationId: 'd'.repeat(32)})));
  assert.equal(phoneBindingKey(binding()), phoneBindingKey(binding({ledgerSequence: 11})));
});
test('repeat heartbeats send one text-only request and reuse the correct contact session', async () => {
  const pending = defer(); const {chat, calls, output} = fixture(() => pending.promise);
  await chat.accept(state()); const work = chat.active.work;
  await chat.accept(state()); await chat.accept(state());
  assert.equal(calls.length, 1); assert.equal(calls[0].voice, false);
  assert.equal(calls[0].characterId, 'judy-id');
  pending.resolve({text: 'Hey V.', sessionID: 'judy-session'}); await work;
  await chat.accept(state({request: {id: 'world-1-2', contact: 'judy', text: 'How are you?'}}));
  const second = chat.active?.work; if (second) await second;
  assert.equal(calls[1].sessionId, 'judy-session');
  assert.equal(output.at(-1).contact, 'judy');
});
test('save unload aborts an in-flight request and late replies cannot enter a new world', async () => {
  const pending = defer(); const {chat, calls, output} = fixture(() => pending.promise);
  await chat.accept(state()); const work = chat.active.work;
  await chat.accept(state({active: false}));
  assert.equal(calls[0].signal.aborted, true);
  await chat.accept(state({world: 'new-world', request: undefined}));
  pending.resolve({text: 'Late reply.', sessionID: 'old'}); await work;
  assert.equal(output.filter(item => item.state === 'reply').length, 0);
});
test('stale heartbeats and explicit cancellation never publish a reply', async () => {
  const pending = defer(); const {chat, calls, output} = fixture(() => pending.promise);
  await chat.accept(state()); const work = chat.active.work;
  await chat.accept(state({updated: now - 16000}));
  assert.ok(calls[0].signal.aborted);
  pending.resolve({text: 'Late.', sessionID: 'old'}); await work;
  assert.equal(output.length, 1);
});
test('unsupported contacts and API failures do not leak service details or substitute another NPC', async () => {
  const {chat, calls, output} = fixture(async () => { throw Error('secret server diagnostic'); });
  await chat.accept(state({request: {id: 'world-1-1', contact: 'unknown', text: 'Hey'}}));
  assert.equal(calls.length, 0); assert.equal(output.at(-1).state, 'error');
  await chat.accept(state({request: {id: 'world-1-2', contact: 'panam', text: 'Hey'}}));
  await chat.active?.work;
  assert.equal(calls[0].characterId, 'panam-id');
  assert.equal(calls[0].sessionId, '-1');
  assert.equal(output.at(-1).state, 'error');
  assert.ok(!JSON.stringify(output).includes('secret'));
});

test('a phone message that meets the shared plan daily limit carries the game code, and other failures carry none', async () => {
  const limit = Object.assign(Error('Daily conversation limit reached [convai-quota:daily]'), {kind: 'daily'});
  const {chat, output} = fixture(async () => { throw limit; }, {failureCode: error => /\[convai-quota:daily\]/.test(error.message) ? 'daily-limit' : undefined});
  await chat.accept(state({request: {id: 'world-1-1', contact: 'panam', text: 'Hey'}}));
  await chat.active?.work;
  assert.equal(output.at(-1).state, 'error'); assert.equal(output.at(-1).errorCode, 'daily-limit');
  assert.ok(!output.at(-1).error.includes('quota'), 'the marker text is not what the player reads');
  const other = fixture(async () => { throw Error('secret server diagnostic'); }, {failureCode: () => { throw Error('hook failed'); }});
  await other.chat.accept(state({request: {id: 'world-1-2', contact: 'panam', text: 'Hey'}}));
  await other.chat.active?.work;
  assert.equal(other.output.at(-1).state, 'error'); assert.equal(other.output.at(-1).errorCode, undefined);
});

function runLua(program) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(program));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}
const adapter = readFileSync(new URL('../mod/phone-chat.lua', import.meta.url), 'utf8');
const productionPhoneBinding = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8')
  .match(/local function capturePhoneBinding\(\)[\s\S]*?\r?\nend/)[0];
const setup = `
local files, values, serial, clock = {}, {}, 0, 100
local function clone(v)
 if type(v)~='table'then return v end
 local result={};for key,item in pairs(v)do result[key]=clone(item)end;return result
end
json={encode=function(v) serial=serial+1; local k=tostring(serial); values[k]=clone(v); return k end,
  decode=function(v) assert(values[v]); return clone(values[v]) end}
io.open=function(path, mode)
  if mode=='rb' then if not files[path] then return end
    return {read=function() return files[path] end, close=function() end}
  end
  return {write=function(self,v) files[path]=v;return self end, close=function() return true end}
end
os.time=function() return clock end
os.remove=function(path) files[path]=nil end
os.rename=function(a,b) files[b]=files[a]; files[a]=nil; return true end
NewObject=function() return {} end
local function put(path,v) files[path]=json.encode(v) end
put('phone-contacts.json', {{contact='judy',key='judy-alvarez'},{contact='panam',key='panam-palmer'}})
-- Read the reset journal on every phone tick unless a test exercises the 500 ms production cadence.
local function newModule() local value=(function() ${adapter} end)(); value.resetPeriod=0; return value end
local m=newModule()
local disappearing=false
local saveBinding={version=1,status='available',authoritative=true,confidence='native-live',localUserId='user-1',
 campaignId=string.rep('a',32),branchId=string.rep('b',32),branchEpoch=1,ledgerSequence=10,generation=1,activationId=string.rep('c',32)}
local worldKnowledge={version=1,status='unavailable'}
local contact, draft, submission, enabled, paints = 'judy', '', nil, true, {}
local player={ConvaiPhoneChatContact=function() return contact end,
  ConvaiPhoneChatTick=function() end,
  ConvaiPhoneChatClearContacts=function() end, ConvaiPhoneChatRegisterContact=function() end,
  ConvaiPhoneChatDraft=function() return {contact=contact,text=draft} end,
  ConvaiPhoneChatTakeSubmission=function() local s=submission; submission=nil; return s end,
  ConvaiPhoneChatPresent=function(_,c,lines,status,d,allowed,busy,reset)
    paints[#paints+1]={contact=c,lines=lines,status=status,allowed=allowed,busy=busy}
    if reset then draft=d end
  end}
local function configure()
  m.configure({{key='judy-alvarez'},{key='panam-palmer'}},
    {profileEnabled=function() return enabled end, disappearingMessages=function() return disappearing end},
    {captureBinding=function()return saveBinding end,captureWorldKnowledge=function(p,key,b)
      assert(p==player and (key=='judy-alvarez' or key=='panam-palmer'));return worldKnowledge end})
end
configure()
local function update() for i=1,8 do m.update(player,0) end end
local resetRevision=0
local function resetJournal(receipts,pending,blocked,all,trackedOverride)
  resetRevision=resetRevision+1
  local tracked,seen={},{}
  for _,rows in ipairs({receipts or {},pending or {}}) do for _,row in ipairs(rows) do
    if not seen[row.id] then tracked[#tracked+1]=clone(row);seen[row.id]=true end
  end end
  put('runtime/memory-chat-resets.json',{version=1,revision=resetRevision,updated=clock*1000,
    baseline={},tracked=trackedOverride or tracked,receipts=receipts or {},pending=pending or {},blockedProfiles=blocked or {},blockAll=all==true})
end
local function clearAction(id,key) return {id=id,scope=key and 'character' or 'all',profileKey=key} end
`;
test('phone Lua never puts the retired follow-up field on a pending send', () => runLua(setup + `
update();submission={contact='judy',text='Hello'};update()
assert(m.pending and m.pending.followUpQuestions==nil)
clock=clock+1;update()
assert(m.pending.followUpQuestions==nil)
local pending=m.pending
put('runtime/phone-chat-output.json',{world=m.world,binding=m.bindingKey,id=pending.id,contact='judy',state='reply',text='Hey V'})
update();submission={contact='judy',text='How are you?'};update()
assert(m.pending and m.pending.followUpQuestions==nil)
clock=clock+1;update();assert(m.pending.followUpQuestions==nil)
`));

test('Lua recent phone continuity includes only six actual rows before the current send and preserves full history', () => runLua(setup + `
saveBinding={version=1,status='unavailable',generation=1,historyScope='local-player-v1'};update()
m.history.judy={};for index=1,8 do m.history.judy[index]={text='Actual row '..index,sent=index%2==1} end
m.history.panam={{text='Another private conversation',sent=false}}
submission={contact='judy',text='Current message'};update()
local recent=m.pending.recentConversation
assert(recent.contact=='judy' and recent.profileKey=='judy-alvarez' and recent.world==m.world and recent.binding==m.bindingKey)
assert(#recent.rows==6 and recent.rows[1].text=='Actual row 3' and recent.rows[6].text=='Actual row 8')
assert(#m.history.judy==9 and m.history.judy[9].text=='Current message')
assert(recent.memoryReset.characterEpoch==0 and m.pending.memoryReset.globalEpoch==0)
for _,row in ipairs(recent.rows) do assert(not row.text:find('Another') and not row.text:find('Current')) end
`));

test('Lua continuity keeps complete UTF-8 utterances within its byte budget and stamps failed-clear epochs', () => runLua(setup + `
update();local intent=clearAction('failed-intent','judy-alvarez')
resetJournal({}, {}, {}, false, {intent});update()
m.history.judy={{text=string.rep('あ',300),sent=true},{text=string.rep('あ',660),sent=false}}
submission={contact='judy',text='Fresh after failed clear'};update()
assert(#m.pending.recentConversation.rows==1 and #m.pending.recentConversation.rows[1].text==1980)
assert(#m.history.judy==3 and m.pending.memoryReset.characterEpoch==1 and m.pending.memoryReset.globalEpoch==0)
`));
test('paused phone frames deliver replies to the original contact after selection changes', () => runLua(setup + `
update(); draft='Hey Judy'; submission={contact='judy',text=draft}; update()
local pending=m.pending; assert(pending and m.history.judy[1].text=='Hey Judy')
contact='panam'; draft='Panam draft'; update()
put('runtime/phone-chat-output.json',{world=m.world,binding=m.bindingKey,id=pending.id,contact='judy',state='reply',text='Hey V'})
update(); assert(not m.pending and #m.history.judy==2 and not m.history.panam)
assert(m.drafts.panam=='Panam draft' and paints[#paints].contact=='panam')
`));
test('the phone status row words the daily limit itself, in the line the notice uses', () => runLua(setup + `
update(); draft='Hey Judy'; submission={contact='judy',text=draft}; update()
local pending=m.pending
put('runtime/phone-chat-output.json',{world=m.world,binding=m.bindingKey,id=pending.id,contact='judy',state='error',
  error='Message could not be delivered. Please try again.',errorCode='daily-limit'})
update(); assert(not m.pending)
local status=paints[#paints].status
assert(status:find('today', 1, true) and status:find('free conversation limit', 1, true) and status:find('Settings > Development', 1, true), status)
assert(status:find('free Mistral key', 1, true) and status:find('fully local option is coming', 1, true) and not status:find('Convai API key', 1, true), status)
assert(not status:find('Message could not be delivered', 1, true))
`));
test('phone timeout restores the draft and save unload rejects a stale reply', () => runLua(setup + `
update(); draft='Hello'; submission={contact='judy',text=draft}; update()
local old=m.pending; clock=clock+46; update()
assert(not m.pending and draft=='Hello' and paints[#paints].status:find('No reply'))
submission={contact='judy',text='Second message'}; update(); old=m.pending
m.abandon(); assert(not m.pending)
put('runtime/phone-chat-output.json',{world='old',id=old.id,contact='judy',state='reply',text='Wrong world'})
update(); assert(#m.history.judy==2 and not m.history.judy[2].text:find('Wrong'))
`));
test('disabled conversations keep typed text and never queue a request', () => runLua(setup + `
update(); enabled=false; draft='Do not send'; submission={contact='judy',text=draft}; update()
assert(not m.pending and not m.history.judy and draft=='Do not send')
assert(not paints[#paints].allowed)
`));
test('an offline service never replaces a follow-up draft already being typed', () => runLua(setup + `
update(); draft='Hello'; submission={contact='judy',text=draft}; update()
draft='A new unsent thought'; clock=clock+46; update()
assert(not m.pending and draft=='A new unsent thought')
`));

test('retired disappearing-message settings never clear stored Chat or wait for a launch token', () => runLua(setup + `
update();local stored=json.decode(files['runtime/phone-history.json'])
stored.buckets[m.scope].launch='1-100'
stored.buckets[m.scope].history={judy={{text='An old conversation',sent=false}}}
stored.buckets[m.scope].drafts={judy='Old draft'}
put('runtime/phone-history.json',stored)
put('runtime/phone-sessions.json',{['judy-alvarez']='retained-convai-session'})
local sessions=files['runtime/phone-sessions.json']
disappearing=true; m=newModule(); configure(); update()
assert(paints[#paints].allowed and m.history.judy[1].text=='An old conversation' and draft=='Old draft')
put('runtime/phone-game-launch.json',{world=m.world,launch='2-200'});update()
assert(m.history.judy[1].text=='An old conversation' and m.drafts.judy=='Old draft')
assert(files['runtime/phone-sessions.json']==sessions)
`));

test('CET reloads, save loads and bridge identity refresh retain this launch history and drafts', () => runLua(setup + `
disappearing=true; m=newModule(); configure(); update()
put('runtime/phone-game-launch.json',{world=m.world,launch='2-200'}); update()
draft='Hi'; submission={contact='judy',text=draft}; update()
local pending=m.pending
put('runtime/phone-chat-output.json',{world=m.world,binding=m.bindingKey,id=pending.id,contact='judy',state='reply',text='Hey V'})
update(); draft='Keep my draft'; clock=clock+1; update(); m.abandon()
update();put('runtime/phone-game-launch.json',{world=m.world,launch='2-200'});update()
assert(#m.history.judy==2 and draft=='Keep my draft')
m.abandon(); m=newModule(); configure(); update()
assert(paints[#paints].allowed)
put('runtime/phone-game-launch.json',{world=m.world,launch='2-200'}); update()
assert(paints[#paints].allowed and #m.history.judy==2 and draft=='Keep my draft')
`));

test('full Chat and drafts survive every game launch even when a retired setting remains in saved settings', () => runLua(setup + `
update();draft='Remember this';submission={contact='judy',text=draft};update()
local pending=m.pending
put('runtime/phone-chat-output.json',{world=m.world,binding=m.bindingKey,id=pending.id,contact='judy',state='reply',text='Of course'})
update();draft='Keep the unsent thought';clock=clock+1;update();disappearing=true
m.abandon();m=newModule();configure();update()
assert(#m.history.judy==2 and draft=='Keep the unsent thought' and paints[#paints].allowed)
put('runtime/phone-game-launch.json',{world=m.world,launch='3-300'});update()
assert(#m.history.judy==2 and m.drafts.judy=='Keep the unsent thought')
`));

test('legacy display history is preserved without assigning it to an arbitrary campaign', () => runLua(setup + `
put('runtime/phone-history.json',{version=1,history={judy={{text='Remember me',sent=false}}},drafts={judy='Hello'}})
m=newModule(); configure(); update()
assert(not m.history.judy and paints[#paints].allowed)
put('runtime/phone-game-launch.json',{world=m.world,launch='3-300'}); update()
assert(not m.history.judy)
local stored=json.decode(files['runtime/phone-history.json'])
assert(stored.version==3 and stored.legacy[1].version==1)
assert(stored.legacy[1].history.judy[1].text=='Remember me' and stored.legacy[1].drafts.judy=='Hello')
`));

test('persisted conversation history does not silently discard earlier turns', () => runLua(setup + `
update()
for i=1,25 do
  draft='Message '..i; submission={contact='judy',text=draft}; update()
  local pending=m.pending
  put('runtime/phone-chat-output.json',{world=m.world,binding=m.bindingKey,id=pending.id,contact='judy',state='reply',text='Reply '..i})
  update()
end
assert(#m.history.judy==50 and m.history.judy[1].text=='Message 1')
m.abandon(); m=newModule(); configure(); update()
assert(#m.history.judy==50 and #paints[#paints].lines==50)
`));

test('confirmed character Forget clears every contact alias and archived bucket while preserving other characters', () => runLua(setup + `
saveBinding={version=1,status='unavailable',generation=1,historyScope='local-player-v1'};update()
m.catalog.judy_alias='judy-alvarez'
m.history={judy={{text='Judy history',sent=false}},judy_alias={{text='Alias history',sent=true}},panam={{text='Panam history',sent=false}}}
m.drafts={judy='Old native draft',judy_alias='Alias draft',panam='Panam draft'}
m.store.buckets.archived={history=clone(m.history),drafts=clone(m.drafts)}
m.store.contactProfiles.retired_judy_alias='judy-alvarez'
m.store.buckets.archived.history.retired_judy_alias={{text='Retired alias history',sent=false}}
m.store.buckets.archived.drafts.retired_judy_alias='Retired alias draft'
m.store.legacy={{version=1,history=clone(m.history),drafts=clone(m.drafts)}}
draft='Old native draft';m.dirty=true;update()
resetJournal({clearAction('forget-judy','judy-alvarez')});update()
assert(not m.history.judy and not m.history.judy_alias and not m.drafts.judy and draft=='')
assert(m.history.panam[1].text=='Panam history' and m.drafts.panam=='Panam draft')
local saved=json.decode(files['runtime/phone-history.json'])
assert(not saved.buckets.archived.history.judy and not saved.buckets.archived.drafts.judy_alias)
assert(not saved.buckets.archived.history.retired_judy_alias and not saved.buckets.archived.drafts.retired_judy_alias)
assert(saved.buckets.archived.history.panam[1].text=='Panam history')
assert(not saved.legacy[1].history.judy and saved.legacy[1].drafts.panam=='Panam draft')
assert(saved.memoryResetsApplied['forget-judy']=='character:judy-alvarez')
`));

test('successful Forget cancels stale replies and native queued submissions without restoring the old draft', () => runLua(setup + `
update();draft='Old outgoing message';submission={contact='judy',text=draft};update()
local old=m.pending;assert(old)
draft='Queued before Forget';submission={contact='judy',text=draft}
put('runtime/phone-chat-output.json',{world=m.world,binding=m.bindingKey,id=old.id,contact='judy',state='reply',text='Old reply'})
resetJournal({clearAction('clear-active','judy-alvarez')});update()
assert(not m.pending and not m.history.judy and not m.drafts.judy and draft=='')
assert(json.decode(files['runtime/phone-chat-input.json']).request==nil)
clock=clock+46;update();m.abandon();update()
assert(not m.history.judy and not m.drafts.judy)
`));

test('failed or uncertain clears preserve Chat/drafts and block only the affected character', () => runLua(setup + `
update();draft='Preserve my question';submission={contact='judy',text=draft};update()
local pending=m.pending
resetJournal({}, {clearAction('pending-clear','judy-alvarez')},{'judy-alvarez'});update()
assert(not m.pending and m.history.judy[1].text=='Preserve my question' and m.drafts.judy=='Preserve my question')
assert(not paints[#paints].allowed)
put('runtime/phone-chat-output.json',{world=m.world,binding=m.bindingKey,id=pending.id,contact='judy',state='reply',text='Stale before reset'})
resetJournal({}, {}, {'judy-alvarez'});update();assert(#m.history.judy==1 and not paints[#paints].allowed)
contact='panam';draft='';update();assert(paints[#paints].allowed)
submission={contact='panam',text='Unaffected chat'};update();assert(m.pending and m.pending.profileKey=='panam-palmer')
resetJournal({}, {}, {});update()
assert(m.history.judy[1].text=='Preserve my question' and m.drafts.judy=='Preserve my question')
`));

test('an unrelated successful clear does not cancel another character pending reply or draft', () => runLua(setup + `
update();contact='panam';draft='Panam question';submission={contact='panam',text=draft};update()
local old=m.pending;assert(old)
draft='Panam follow-up draft';update()
resetJournal({clearAction('judy-only','judy-alvarez')});update();assert(m.pending==old)
put('runtime/phone-chat-output.json',{world=m.world,binding=m.bindingKey,id=old.id,contact='panam',state='reply',text='Panam response'})
update();assert(not m.pending and #m.history.panam==2 and m.drafts.panam=='Panam follow-up draft')
`));

test('confirmed Forget all removes every Chat bucket and draft and cannot replay after new conversations', () => runLua(setup + `
saveBinding={version=1,status='unavailable',generation=1,historyScope='local-player-v1'};update()
m.history={judy={{text='Before clear',sent=true}},panam={{text='Panam before clear',sent=false}}};m.drafts={judy='Draft',panam='Another draft'}
m.store.buckets.old={history={unknown_contact={{text='Archived history',sent=false}}},drafts={unknown_contact='Archived draft'}}
m.store.legacy={{history={unknown_contact={{text='Older history',sent=false}}}},{unparsed='unparseable-old-data'}}
local clear=clearAction('clear-everyone');resetJournal({clear});update()
assert(next(m.history)==nil and next(m.drafts)==nil and #m.store.legacy==0)
assert(next(m.store.buckets.old.history)==nil and next(m.store.buckets.old.drafts)==nil)
submission={contact='judy',text='After clear'};update();local new=m.pending
put('runtime/phone-chat-output.json',{world=m.world,binding=m.bindingKey,id=new.id,contact='judy',state='reply',text='New memory starts here'});update()
m.abandon();m=newModule();configure();update()
assert(#m.history.judy==2 and m.history.judy[1].text=='After clear')
assert(m.store.memoryResetsApplied['clear-everyone']=='all')
`));

test('explicit profile-family migration updates an old tombstone without deleting post-clear Chat', () => runLua(setup + `
update();m.history.judy={{text='After the old reset',sent=false}};m.drafts.judy='New draft';draft='New draft'
m.store.memoryResetsApplied['old-variant']='character:judy-alvarez-romantic';m.dirty=true;update()
local action=clearAction('old-variant','judy-alvarez')
put('runtime/memory-chat-resets.json',{version=1,revision=1,baseline={action},tracked={},receipts={},pending={},
 blockedProfiles={},blockAll=false,profileFamilies={['judy-alvarez-romantic']='judy-alvarez'}})
update();assert(m.history.judy[1].text=='After the old reset' and m.drafts.judy=='New draft')
assert(m.store.memoryResetsApplied['old-variant']=='character:judy-alvarez')
`));

test('a clear arriving during a save change never restores the cancelled request into the cleared draft', () => runLua(setup + `
saveBinding={version=1,status='unavailable',generation=1,historyScope='local-player-v1'};update()
submission={contact='judy',text='Old-world pending'};update();assert(m.pending)
resetJournal({clearAction('clear-across-load','judy-alvarez')});saveBinding.generation=2;update()
assert(not m.pending and not m.history.judy and not m.drafts.judy and draft=='')
`));

test('failed local history replacement holds sends until the durable clear and tombstone can be saved', () => runLua(setup + `
update();submission={contact='judy',text='Before disk failure'};update();assert(m.history.judy)
local realOpen=io.open
io.open=function(path,mode)
 if path=='runtime/phone-history.json.tmp' and mode=='wb' then return nil end
 return realOpen(path,mode)
end
resetJournal({clearAction('disk-clear','judy-alvarez')});submission={contact='judy',text='Must wait'};update()
assert(not m.pending and not paints[#paints].allowed and not m.store.memoryResetsApplied['disk-clear'])
io.open=realOpen;update()
assert(paints[#paints].allowed and not m.history.judy and m.store.memoryResetsApplied['disk-clear'])
m.abandon();m=newModule();configure();update();assert(not m.history.judy)
`));

test('invalid reset ownership cannot erase histories or admit a new send', () => runLua(setup + `
update();m.history.judy={{text='Keep this',sent=false}};m.dirty=true;update()
put('runtime/memory-chat-resets.json',{version=1,revision=1,baseline={},tracked={},receipts={clearAction('unowned')},pending={},blockedProfiles={},blockAll=false})
submission={contact='judy',text='Must wait'};update()
assert(m.history.judy[1].text=='Keep this' and not m.pending and not paints[#paints].allowed)
resetJournal({}, {}, {});update();assert(paints[#paints].allowed and m.history.judy[1].text=='Keep this')
`));

test('a newly invalid journal cannot borrow cached valid reset readiness', () => runLua(setup + `
update();resetJournal({}, {}, {});update()
m.history.judy={{text='Keep through corruption',sent=false}};m.dirty=true;update()
put('runtime/memory-chat-resets.json',{version=1,revision=2,baseline={},tracked={},receipts={clearAction('unowned')},pending={},blockedProfiles={},blockAll=false})
submission={contact='judy',text='Must not submit'};update()
assert(not m.pending and not paints[#paints].allowed and m.history.judy[1].text=='Keep through corruption')
resetJournal({}, {}, {});update();assert(paints[#paints].allowed)
`));

test('a fast failed clear cancels an old queued reply even when no blocked frame was observed', () => runLua(setup + `
update();submission={contact='judy',text='Before failed clear'};update();local old=m.pending
local failed=clearAction('missed-pending','judy-alvarez')
put('runtime/phone-chat-output.json',{world=m.world,binding=m.bindingKey,id=old.id,contact='judy',state='reply',text='Stale queued reply'})
resetJournal({}, {}, {}, false, {failed});update()
assert(not m.pending and #m.history.judy==1 and m.history.judy[1].text=='Before failed clear')
assert(m.drafts.judy=='Before failed clear' and draft=='Before failed clear')
`));

test('same-ID recovery memory epochs invalidate a pending reply without erasing preserved Chat', () => runLua(setup + `
update();local failed=clearAction('recover-one','judy-alvarez')
resetJournal({}, {}, {}, false, {failed});local current=json.decode(files['runtime/memory-chat-resets.json'])
current.memoryEpochs={version=1,globalEpoch=0,characterEpochs={['judy-alvarez']=1}};put('runtime/memory-chat-resets.json',current);update()
submission={contact='judy',text='Before recovery'};update();local old=m.pending
assert(old.memoryReset.characterEpoch==1 and old.memoryReset.characterMemoryEpoch==1)
current.revision=current.revision+1;current.memoryEpochs.characterEpochs['judy-alvarez']=2
put('runtime/memory-chat-resets.json',current)
put('runtime/phone-chat-output.json',{world=m.world,binding=m.bindingKey,id=old.id,contact='judy',state='reply',text='Old recovery reply'})
update();assert(not m.pending and #m.history.judy==1 and m.drafts.judy=='Before recovery')
`));

test('a fresh game/bridge session reuses saved Convai memory independently of the UI transcript', async () => {
  const calls = [];
  let sessions = {};
  const create = () => new PhoneChat({contacts: [{contact: 'judy', key: 'judy-alvarez'}],
    ids: {'judy-alvarez': 'judy-id'}, now: () => now, sessions,
    publish: async () => {}, saveSessions: async value => { sessions = structuredClone(value); },
    reply: async args => { calls.push(args); return {text: 'Hey V.', sessionID: 'retained-session'}; }});
  let chat = create();
  await chat.accept(state()); await chat.active?.work; chat.close();
  chat = create();
  await chat.accept(state({world: 'new-game', request: {id: 'new-game-1', contact: 'judy', text: 'Remember me?'}}));
  await chat.active?.work;
  assert.equal(calls[1].sessionId, 'retained-session');
});

test('Lua history and pending drafts stay with their exact campaign and rollback branch', () => runLua(setup + `
update();draft='Campaign A, Judy';submission={contact='judy',text=draft};update()
local old,oldWorld,oldBinding,scopeA=clone(m.pending),m.world,m.bindingKey,m.scope
saveBinding.campaignId=string.rep('d',32);saveBinding.generation=2;saveBinding.activationId=string.rep('e',32)
update();assert(not m.pending and not m.history.judy and draft=='')
local scopeB=m.scope;assert(scopeA~=scopeB)
put('runtime/phone-chat-output.json',{world=oldWorld,binding=oldBinding,id=old.id,contact='judy',state='reply',text='Stale A reply'})
update();assert(not m.history.judy)
contact='panam';draft='Campaign B, Panam';submission={contact='panam',text=draft};update()
assert(#m.history.panam==1 and not m.history.judy)
saveBinding.campaignId=string.rep('a',32);saveBinding.branchId=string.rep('f',32)
saveBinding.branchEpoch=2;saveBinding.generation=3;saveBinding.activationId=string.rep('d',32)
update();assert(not m.history.judy and not m.history.panam and m.scope~=scopeA)
saveBinding.branchId=string.rep('b',32);saveBinding.branchEpoch=1;saveBinding.generation=4
saveBinding.activationId=string.rep('e',32);contact='judy';update()
assert(m.scope==scopeA and #m.history.judy==1 and m.history.judy[1].text=='Campaign A, Judy')
assert(draft=='Campaign A, Judy' and not m.history.panam)
local stored=json.decode(files['runtime/phone-history.json'])
assert(stored.buckets[scopeB].history.panam[1].text=='Campaign B, Panam')
assert(stored.buckets[scopeA].drafts.judy=='Campaign A, Judy')
`));

test('unknown Lua identity is session-only but keeps unbound transcripts preserved on disk', () => runLua(setup + `
saveBinding={version=1,status='unavailable',generation=1};update()
draft='Unbound conversation';submission={contact='judy',text=draft};update()
local firstScope=m.scope;assert(firstScope:match('^session:') and #m.history.judy==1)
m.abandon();update();assert(m.scope~=firstScope and not m.history.judy and draft=='')
local stored=json.decode(files['runtime/phone-history.json'])
assert(stored.buckets[firstScope].sessionOnly and stored.buckets[firstScope].history.judy[1].text=='Unbound conversation')
saveBinding={version=1,status='available',authoritative=true,confidence='native-live',localUserId='user-1',
 campaignId=string.rep('a',32),branchId=string.rep('b',32),branchEpoch=1,ledgerSequence=10,generation=2,activationId=string.rep('c',32)}
update();assert(not m.history.judy and m.scope:match('^phone%-v1:'))
`));

test('current single-player display history survives CET reload and save generation changes without accepting stale replies', () => runLua(setup + `
local frame={status='ready',generation=1}
local function refreshKnowledgeFrame()return frame end
${productionPhoneBinding}
saveBinding=capturePhoneBinding()
update();draft='Remember this';submission={contact='judy',text=draft};update()
local pending=m.pending
put('runtime/phone-chat-output.json',{world=m.world,binding=m.bindingKey,id=pending.id,contact='judy',state='reply',text='I remember, V.'})
update();draft='Keep this draft';update();clock=clock+1;update()
local originalScope=m.scope;assert(originalScope=='phone-local-player:v1' and m.bindingKey=='session:1')
m.abandon();m=newModule();configure();update()
assert(m.scope==originalScope and #m.history.judy==2 and draft=='Keep this draft')
contact='panam';draft='';update();assert(not m.history.panam and #paints[#paints].lines==0)
submission={contact='panam',text='Cancelled by load'};update();local cancelled=m.pending
frame.generation=2;saveBinding=capturePhoneBinding();update()
assert(m.scope==originalScope and #m.history.judy==2 and m.drafts.panam=='Cancelled by load' and not m.pending)
assert(m.bindingKey=='session:2' and m.world~=cancelled.id:match('^(.*)%-%d+$'))
put('runtime/phone-chat-output.json',{world=cancelled.id:match('^(.*)%-%d+$'),binding='session:1',id=cancelled.id,contact='panam',state='reply',text='Wrong world'})
update();assert(#m.history.panam==1 and m.history.panam[1].sent)
`));

test('local display policy migrates only the exact prior session and preserves all legacy source buckets', () => runLua(setup + `
saveBinding={version=1,status='unavailable',generation=1};update()
submission={contact='judy',text='Previous UI session'};update()
local legacyScope=m.scope;m.abandon()
local stored=json.decode(files['runtime/phone-history.json'])
stored.buckets['session:unrelated-world']={identity=saveBinding,sessionOnly=true,history={panam={{text='Unrelated',sent=false}}},drafts={}}
put('runtime/phone-history.json',stored)
saveBinding.historyScope='local-player-v1';m=newModule();configure();update()
assert(m.scope=='phone-local-player:v1' and m.history.judy[1].text=='Previous UI session' and m.drafts.judy=='Previous UI session')
assert(not m.history.panam,'Do not merge unrelated histories into the visible conversation')
stored=json.decode(files['runtime/phone-history.json'])
assert(stored.buckets[m.scope].migratedFrom==legacyScope)
assert(stored.buckets[legacyScope].history.judy[1].text=='Previous UI session')
assert(stored.buckets['session:unrelated-world'].history.panam[1].text=='Unrelated')
`));

test('migration does not guess a legacy bucket when the prior display receipt is missing or mismatched', () => runLua(setup + `
saveBinding={version=1,status='unavailable',generation=1};update()
submission={contact='judy',text='Archived session'};update();local oldScope=m.scope;m.abandon()
local prior=json.decode(files['runtime/phone-chat-input.json']);prior.saveIdentity.generation=99;put('runtime/phone-chat-input.json',prior)
saveBinding.historyScope='local-player-v1';m=newModule();configure();update()
assert(not m.history.judy and m.scope=='phone-local-player:v1')
local stored=json.decode(files['runtime/phone-history.json'])
assert(stored.buckets[oldScope].history.judy[1].text=='Archived session')
`));

test('single-player Chat stays visible through new game launches, saves and bridge restarts', () => runLua(setup + `
saveBinding={version=1,status='unavailable',generation=1,historyScope='local-player-v1'}
update();submission={contact='judy',text='Persistent across launches'};update();local pending=m.pending
put('runtime/phone-chat-output.json',{world=m.world,binding=m.bindingKey,id=pending.id,contact='judy',state='reply',text='Still here'})
update();disappearing=true;m.abandon();m=newModule();configure();update()
assert(paints[#paints].allowed and #m.history.judy==2)
saveBinding.generation=2;update();assert(#m.history.judy==2)
m.abandon();m=newModule();configure();update()
put('runtime/phone-game-launch.json',{world=m.world,launch='21-2100'});update()
assert(#m.history.judy==2 and paints[#paints].allowed)
`));

test('temporary unavailable startup frame cannot replace the persistent local display bucket', () => runLua(setup + `
saveBinding={version=1,status='unavailable',generation=1,historyScope='local-player-v1'};update()
submission={contact='judy',text='Keep through startup'};update();m.abandon()
saveBinding={version=1,status='unavailable'};m=newModule();configure();update()
assert(not m.history.judy)
saveBinding={version=1,status='unavailable',generation=2,historyScope='local-player-v1'};update()
assert(m.history.judy[1].text=='Keep through startup' and m.drafts.judy=='Keep through startup')
`));

test('phone history recovers the last complete replacement when its primary file is missing or malformed', () => runLua(setup + `
saveBinding={version=1,status='unavailable',generation=1,historyScope='local-player-v1'};update()
submission={contact='judy',text='Recover me'};update();m.abandon()
local backup=files['runtime/phone-history.json']
for _,bad in ipairs({false,'damaged-primary-bytes'})do
 files['runtime/phone-history.json.previous']=backup
 files['runtime/phone-history.json']=bad or nil
 m=newModule();configure();update()
 assert(m.history.judy[1].text=='Recover me' and m.drafts.judy=='Recover me')
 if bad then
  local stored=json.decode(files['runtime/phone-history.json']);local found=false
  for _,entry in ipairs(stored.legacy)do if entry.unparsed==bad then found=true end end
  assert(found,'Keep the malformed primary for recovery rather than dropping it')
 end
end
`));

for (const fault of ['write', 'close']) test(`phone ${fault} failure cannot publish a partial outgoing request or discard the draft`, () => runLua(setup + `
update();local previous=files['runtime/phone-chat-input.json'];local originalOpen=io.open
io.open=function(path,mode)
 if path=='runtime/phone-chat-input.json.tmp' and mode=='wb'then
  return {write=function(self,value)files[path]='partial-bytes';return ${fault === 'write' ? "nil,'disk full'" : 'self'} end,
   close=function()return ${fault === 'close' ? "nil,'flush failed'" : 'true'} end}
 end
 return originalOpen(path,mode)
end
draft='Preserve this draft';submission={contact='judy',text=draft};update()
assert(not m.pending and not m.history.judy)
assert(m.drafts.judy=='Preserve this draft' and m.errors.judy:find('Unable to send'))
assert(files['runtime/phone-chat-input.json']==previous and not files['runtime/phone-chat-input.json.tmp'])
`));

test('fresh capture accompanies phone submissions and a binding change during capture cancels publication', () => runLua(setup + `
worldKnowledge={version=1,status='ready',generation=1,facts={observed={value=1}}}
m.captureJournal=function()return {version=1,status='untracked'}end
m.captureBattle=function()return {version=1,status='none'}end
update();draft='What happened?';submission={contact='judy',text=draft};update()
assert(m.pending.saveIdentity.campaignId==saveBinding.campaignId and m.pending.saveIdentity.activationId==saveBinding.activationId)
assert(m.pending.worldKnowledge.facts.observed.value==1 and m.pending.journal.status=='untracked' and m.pending.battle.status=='none')
worldKnowledge.facts.observed.value=2
assert(m.pending.worldKnowledge.facts.observed.value==1,'A later capture must not mutate an in-flight snapshot')
m.abandon();update()
m.captureWorldKnowledge=function()
 saveBinding.generation=2;saveBinding.activationId=string.rep('d',32)
 return {version=1,status='ready',generation=1}
end
draft='Do not send across this load';submission={contact='judy',text=draft};update()
assert(not m.pending)
local input=json.decode(files['runtime/phone-chat-input.json'])
assert(input.request==nil,'A mixed-world capture must never publish an outgoing request')
`));

test('branch and game launch changes preserve full Chat and durable session storage', () => runLua(setup + `
disappearing=true;m=newModule();configure();update()
put('runtime/phone-game-launch.json',{world=m.world,launch='9-900'});update()
draft='Keep within this launch';submission={contact='judy',text=draft};update()
local pending=m.pending
put('runtime/phone-chat-output.json',{world=m.world,binding=m.bindingKey,id=pending.id,contact='judy',state='reply',text='Retained reply'})
update();local originalScope=m.scope
put('runtime/phone-sessions.json',{version=2,scoped={existing='durable'}});local sessions=files['runtime/phone-sessions.json']
saveBinding.branchId=string.rep('d',32);saveBinding.branchEpoch=2;saveBinding.generation=2;saveBinding.activationId=string.rep('e',32)
update();put('runtime/phone-game-launch.json',{world=m.world,launch='9-900'});update()
saveBinding.branchId=string.rep('b',32);saveBinding.branchEpoch=1;saveBinding.generation=3;saveBinding.activationId=string.rep('f',32)
update();put('runtime/phone-game-launch.json',{world=m.world,launch='9-900'});update()
assert(m.scope==originalScope and #m.history.judy==2 and files['runtime/phone-sessions.json']==sessions)
m.abandon();m=newModule();configure();update()
put('runtime/phone-game-launch.json',{world=m.world,launch='10-1000'});update()
assert(#m.history.judy==2 and files['runtime/phone-sessions.json']==sessions)
`));

test('unparseable legacy history is retained verbatim instead of overwritten as empty history', () => runLua(setup + `
files['runtime/phone-history.json']='unparseable-history-bytes'
m=newModule();configure();update()
local stored=json.decode(files['runtime/phone-history.json'])
assert(stored.legacy[1].unparsed=='unparseable-history-bytes' and not m.history.judy)
`));

test('the reset journal is read every 500 ms in production, and freshly before a submission is judged', () => runLua(setup + `
local opens, open = 0, io.open
io.open=function(path,mode) if path=='runtime/memory-chat-resets.json' then opens=opens+1 end; return open(path,mode) end
resetJournal({},{},{},false)
m=newModule();m.resetPeriod=nil;configure()
for _=1,60 do m.update(player,1/60) end
assert(opens>=2 and opens<=4,'reset journal reads in one second: '..opens)
local before=opens
for _=1,6 do m.update(player,1/60) end
assert(opens<=before+1)
resetJournal({},{},{},true);before=opens
submission={contact='judy',text='Are you there?'}
for _=1,6 do m.update(player,1/60) end
assert(opens==before+1,'submission did not read the journal once: '..(opens-before))
assert(m.errors.judy=='Memory clearing is in progress. Your draft has been kept.',tostring(m.errors.judy))
`));

test('forgetting sessions starts every thread afresh, saves the empty store and keeps the shown transcript', async () => {
  let saved;
  const {chat, calls, output} = fixture(async () => ({text: 'Scoped reply', sessionID: `session-${calls.length}`}),
    {saveSessions: async value => { saved = structuredClone(value); }});
  await finish(chat, state());
  await finish(chat, state({request: {id: 'world-1-2', contact: 'judy', text: 'Again'}}));
  assert.deepEqual(calls.map(call => call.sessionId), ['-1', 'session-1']);
  const replies = output.filter(value => value.state === 'reply').length;
  await chat.forgetSessions();
  assert.deepEqual(saved, {version: 2, scoped: {}, legacy: null});
  await finish(chat, state({request: {id: 'world-1-3', contact: 'judy', text: 'New key'}}));
  assert.equal(calls[2].sessionId, '-1');
  assert.equal(output.filter(value => value.state === 'reply').length, replies + 1);
});

test('the open Chat contact is an optional hint: kept when well formed, dropped (never rejecting the state) otherwise', () => {
  const idle = {version: 2, world: 'world-1', updated: now, active: true, saveIdentity: binding()};
  assert.equal(parsePhoneState(JSON.stringify(idle)).chatContact, undefined);
  assert.equal(parsePhoneState(JSON.stringify({...idle, chatContact: 'judy'})).chatContact, 'judy');
  assert.equal(parsePhoneState(JSON.stringify(state({chatContact: 'judy'}))).chatContact, 'judy', 'a state with a request keeps it too');
  for (const chatContact of ['', '../x', 'a b', 'x'.repeat(121), 7, null, {}, ['judy']]) {
    const parsed = parsePhoneState(JSON.stringify({...idle, chatContact}));
    assert.ok(parsed, 'the state itself is still accepted');
    assert.equal(parsed.chatContact, undefined);
  }
  // The hint is not part of a request: sending it changes nothing a reply is built from.
  assert.equal(parsePhoneState(JSON.stringify(state({chatContact: 'panam'}))).request.contact, 'judy');
});

test('a phone contact resolves to its profile, an unknown one to nothing', () => {
  const {chat} = fixture(async () => ({text: 'x', sessionID: 's'}));
  assert.equal(chat.profileFor('judy'), 'judy-alvarez');
  assert.equal(chat.profileFor('panam'), 'panam-palmer');
  assert.equal(chat.profileFor('nobody'), undefined);
  assert.equal(chat.profileFor(undefined), undefined);
});

test('Lua publishes the open Chat contact at once when it changes, only for a known contact and never when the phone is not active', () => runLua(setup + `
local function published() return json.decode(files['runtime/phone-chat-input.json']) end
contact='';update()
assert(published().chatContact==nil,'no Chat open')
contact='judy';clock=clock+0;m.tick=1;m.update(player,0.2)
assert(published().chatContact=='judy','published in the same update the contact changed, not on the 3 s heartbeat')
local writes=0;local original=io.open
io.open=function(path,mode) if path=='runtime/phone-chat-input.json.tmp' and mode=='wb' then writes=writes+1 end return original(path,mode) end
update();update();assert(writes==0,'an unchanged contact does not write again before the heartbeat')
contact='panam';update()
assert(writes==1 and published().chatContact=='panam','switching Chat publishes once more')
contact='stranger';update()
assert(published().chatContact==nil,'an unknown contact is never published')
contact='';update()
assert(published().chatContact==nil,'closing the Chat clears it')
contact='judy';update();assert(published().chatContact=='judy')
clock=clock+4;update()
assert(published().chatContact=='judy','the heartbeat keeps it')
m.abandon()
local after=published()
assert(after.active==false and after.chatContact==nil,'an inactive phone publishes no contact')
io.open=original
`));

test('Lua keeps sending exactly as before: the contact hint rides along but never changes a request', () => runLua(setup + `
update();draft='Hello';submission={contact='judy',text=draft};update()
local input=json.decode(files['runtime/phone-chat-input.json'])
assert(input.chatContact=='judy' and input.request and input.request.contact=='judy' and input.request.text=='Hello')
assert(input.request.chatContact==nil)
`));
