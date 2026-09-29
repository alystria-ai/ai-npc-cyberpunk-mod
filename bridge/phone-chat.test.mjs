import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {PhoneChat, parsePhoneState, parsePhoneBinding, phoneBindingKey, phoneScope} from './phone-chat.mjs';

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
const memory = (save, remoteGeneration = 'remote-generation-1') => ({status: 'available',
  identity: {userId: save.localUserId, campaignId: save.campaignId, branchId: save.branchId, remoteGeneration},
  endUserId: `private-${save.branchId}-${remoteGeneration}`});

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

function runLua(program) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(program));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}
const adapter = readFileSync(new URL('../mod/phone-chat.lua', import.meta.url), 'utf8');
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
  return {write=function(_,v) files[path]=v end, close=function() end}
end
os.time=function() return clock end
os.remove=function(path) files[path]=nil end
os.rename=function(a,b) files[b]=files[a]; files[a]=nil; return true end
NewObject=function() return {} end
local function put(path,v) files[path]=json.encode(v) end
put('phone-contacts.json', {{contact='judy',key='judy-alvarez'},{contact='panam',key='panam-palmer'}})
local function newModule() return (function() ${adapter} end)() end
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
`;
test('paused phone frames deliver replies to the original contact after selection changes', () => runLua(setup + `
update(); draft='Hey Judy'; submission={contact='judy',text=draft}; update()
local pending=m.pending; assert(pending and m.history.judy[1].text=='Hey Judy')
contact='panam'; draft='Panam draft'; update()
put('runtime/phone-chat-output.json',{world=m.world,binding=m.bindingKey,id=pending.id,contact='judy',state='reply',text='Hey V'})
update(); assert(not m.pending and #m.history.judy==2 and not m.history.panam)
assert(m.drafts.panam=='Panam draft' and paints[#paints].contact=='panam')
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

test('disappearing messages wait for the current launch and clear only the local transcript and drafts', () => runLua(setup + `
update();local stored=json.decode(files['runtime/phone-history.json'])
stored.buckets[m.scope].launch='1-100'
stored.buckets[m.scope].history={judy={{text='An old conversation',sent=false}}}
stored.buckets[m.scope].drafts={judy='Old draft'}
put('runtime/phone-history.json',stored)
put('runtime/phone-sessions.json',{['judy-alvarez']='retained-convai-session'})
local sessions=files['runtime/phone-sessions.json']
disappearing=true; m=newModule(); configure(); update()
assert(not paints[#paints].allowed and #paints[#paints].lines==0 and draft=='')
put('runtime/phone-game-launch.json',{world='stale-world',launch='2-200'})
update(); assert(not paints[#paints].allowed and m.history.judy)
put('runtime/phone-game-launch.json',{world=m.world,launch='2-200'})
update(); assert(paints[#paints].allowed and not m.history.judy and (m.drafts.judy or '')=='')
local saved=json.decode(files['runtime/phone-history.json'])
assert(saved.buckets[m.scope].launch=='2-200' and not saved.buckets[m.scope].history.judy and not saved.buckets[m.scope].drafts.judy)
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
assert(not paints[#paints].allowed)
put('runtime/phone-game-launch.json',{world=m.world,launch='2-200'}); update()
assert(paints[#paints].allowed and #m.history.judy==2 and draft=='Keep my draft')
`));

test('persistent history is the default and enabling disappearance applies at the next game launch', () => runLua(setup + `
update(); put('runtime/phone-game-launch.json',{world=m.world,launch='2-200'}); update()
draft='Remember this'; submission={contact='judy',text=draft}; update()
local pending=m.pending
put('runtime/phone-chat-output.json',{world=m.world,binding=m.bindingKey,id=pending.id,contact='judy',state='reply',text='Of course'})
update(); disappearing=true
update(); assert(#m.history.judy==2)
m.abandon(); m=newModule(); configure(); update()
put('runtime/phone-game-launch.json',{world=m.world,launch='2-200'}); update()
assert(#m.history.judy==2, 'enabling then CET reload is not a new game launch')
m.abandon(); m=newModule(); configure(); update()
put('runtime/phone-game-launch.json',{world=m.world,launch='3-300'}); update()
assert(not m.history.judy)
`));

test('legacy display history is preserved without assigning it to an arbitrary campaign', () => runLua(setup + `
put('runtime/phone-history.json',{version=1,history={judy={{text='Remember me',sent=false}}},drafts={judy='Hello'}})
m=newModule(); configure(); update()
assert(not m.history.judy and paints[#paints].allowed)
put('runtime/phone-game-launch.json',{world=m.world,launch='3-300'}); update()
assert(not m.history.judy and m.launch=='3-300')
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

test('same-process branch changes do not trigger disappearing messages or delete durable session storage', () => runLua(setup + `
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
assert(not m.history.judy and files['runtime/phone-sessions.json']==sessions)
`));

test('unparseable legacy history is retained verbatim instead of overwritten as empty history', () => runLua(setup + `
files['runtime/phone-history.json']='unparseable-history-bytes'
m=newModule();configure();update()
local stored=json.decode(files['runtime/phone-history.json'])
assert(stored.legacy[1].unparsed=='unparseable-history-bytes' and not m.history.judy)
`));
