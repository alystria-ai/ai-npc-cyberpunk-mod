import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {PhoneChat, parsePhoneState} from './phone-chat.mjs';

const now = 100000;
const state = (overrides = {}) => ({version: 1, world: 'world-1', updated: now, active: true,
  request: {id: 'world-1-1', contact: 'judy', text: 'Hey Judy!'}, ...overrides});
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
function fixture(reply) {
  const output = [], calls = [];
  const chat = new PhoneChat({contacts: [{contact: 'judy', key: 'judy-alvarez'}, {contact: 'panam', key: 'panam-palmer'}],
    ids: {'judy-alvarez': 'judy-id', 'panam-palmer': 'panam-id'}, now: () => now,
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
json={encode=function(v) serial=serial+1; local k=tostring(serial); values[k]=v; return k end,
  decode=function(v) assert(values[v]); return values[v] end}
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
    {profileEnabled=function() return enabled end, disappearingMessages=function() return disappearing end})
end
configure()
local function update() for i=1,8 do m.update(player,0) end end
`;
test('paused phone frames deliver replies to the original contact after selection changes', () => runLua(setup + `
update(); draft='Hey Judy'; submission={contact='judy',text=draft}; update()
local pending=m.pending; assert(pending and m.history.judy[1].text=='Hey Judy')
contact='panam'; draft='Panam draft'; update()
put('runtime/phone-chat-output.json',{world=m.world,id=pending.id,contact='judy',state='reply',text='Hey V'})
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
put('runtime/phone-history.json',{version=2,launch='1-100',
  history={judy={{text='An old conversation',sent=false}}},drafts={judy='Old draft'}})
put('runtime/phone-sessions.json',{['judy-alvarez']='retained-convai-session'})
local sessions=files['runtime/phone-sessions.json']
disappearing=true; m=newModule(); configure(); update()
assert(not paints[#paints].allowed and #paints[#paints].lines==0 and draft=='')
put('runtime/phone-game-launch.json',{world='stale-world',launch='2-200'})
update(); assert(not paints[#paints].allowed and m.history.judy)
put('runtime/phone-game-launch.json',{world=m.world,launch='2-200'})
update(); assert(paints[#paints].allowed and not m.history.judy and (m.drafts.judy or '')=='')
local saved=json.decode(files['runtime/phone-history.json'])
assert(saved.launch=='2-200' and not saved.history.judy and not saved.drafts.judy)
assert(files['runtime/phone-sessions.json']==sessions)
`));

test('CET reloads, save loads and bridge identity refresh retain this launch history and drafts', () => runLua(setup + `
disappearing=true; m=newModule(); configure(); update()
put('runtime/phone-game-launch.json',{world=m.world,launch='2-200'}); update()
draft='Hi'; submission={contact='judy',text=draft}; update()
local pending=m.pending
put('runtime/phone-chat-output.json',{world=m.world,id=pending.id,contact='judy',state='reply',text='Hey V'})
update(); draft='Keep my draft'; clock=clock+1; update(); m.abandon()
update(); assert(#m.history.judy==2 and draft=='Keep my draft')
m.abandon(); m=newModule(); configure(); update()
assert(not paints[#paints].allowed)
put('runtime/phone-game-launch.json',{world=m.world,launch='2-200'}); update()
assert(paints[#paints].allowed and #m.history.judy==2 and draft=='Keep my draft')
`));

test('persistent history is the default and enabling disappearance applies at the next game launch', () => runLua(setup + `
update(); put('runtime/phone-game-launch.json',{world=m.world,launch='2-200'}); update()
draft='Remember this'; submission={contact='judy',text=draft}; update()
local pending=m.pending
put('runtime/phone-chat-output.json',{world=m.world,id=pending.id,contact='judy',state='reply',text='Of course'})
update(); disappearing=true
update(); assert(#m.history.judy==2)
m.abandon(); m=newModule(); configure(); update()
put('runtime/phone-game-launch.json',{world=m.world,launch='2-200'}); update()
assert(#m.history.judy==2, 'enabling then CET reload is not a new game launch')
m.abandon(); m=newModule(); configure(); update()
put('runtime/phone-game-launch.json',{world=m.world,launch='3-300'}); update()
assert(not m.history.judy)
`));

test('persistent display history survives a new game launch and old-format migration', () => runLua(setup + `
put('runtime/phone-history.json',{version=1,history={judy={{text='Remember me',sent=false}}},drafts={judy='Hello'}})
m=newModule(); configure(); update()
assert(#m.history.judy==1 and paints[#paints].allowed)
put('runtime/phone-game-launch.json',{world=m.world,launch='3-300'}); update()
assert(#m.history.judy==1 and m.launch=='3-300')
`));

test('persisted conversation history does not silently discard earlier turns', () => runLua(setup + `
update()
for i=1,25 do
  draft='Message '..i; submission={contact='judy',text=draft}; update()
  local pending=m.pending
  put('runtime/phone-chat-output.json',{world=m.world,id=pending.id,contact='judy',state='reply',text='Reply '..i})
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
