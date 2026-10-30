import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// The phone side of immersive invitations (mod/phone-chat.lua): the meeting offer that rides on a typed message, the bridge's answer
// handed to the game, and the texts a character sends on her own (arrived, stood up, called off) with their plain fallback.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
function runLua(program) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(program));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
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
  return {write=function(self,v) files[path]=v;return self end, close=function() return true end}
end
os.time=function() return clock end
os.remove=function(path) files[path]=nil end
os.rename=function(a,b) files[b]=files[a]; files[a]=nil; return true end
NewObject=function() return {} end
local function put(path,v) files[path]=json.encode(v) end
put('phone-contacts.json', {{contact='judy',key='judy-alvarez'},{contact='panam',key='panam-palmer'}})
local m=(function() ${adapter} end)(); m.resetPeriod=0; m.resetIdlePeriod=0
local saveBinding={version=1,status='available',authoritative=true,confidence='native-live',localUserId='user-1',
 campaignId=string.rep('a',32),branchId=string.rep('b',32),branchEpoch=1,ledgerSequence=10,generation=1,activationId=string.rep('c',32)}
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
m.configure({{key='judy-alvarez'},{key='panam-palmer'}},
  {profileEnabled=function(key) return enabled end},
  {captureBinding=function()return saveBinding end,captureWorldKnowledge=function() return {version=1,status='unavailable'} end})
local function update() for i=1,8 do m.update(player,0) end end
local function request() return json.decode(files['runtime/phone-chat-input.json']).request end
local function reply(extra)
  local pending=m.pending
  local row={world=m.world,binding=m.bindingKey,id=pending.id,contact=pending.contact}
  for k,v in pairs(extra) do row[k]=v end
  put('runtime/phone-chat-output.json',row)
end
local item={profileKey='judy-alvarez',name='Judy',kind='arrived',place="Lizzie's Bar, Kabuki",minutes=0,car=false,fallback="I'm here."}
`;

test('a typed message carries the meeting offer the game captured, and nothing when there is none', () => runLua(setup + `
update(); submission={contact='judy',text='Hello'}; update()
assert(m.pending and m.pending.meetOffer==nil and request().meetOffer==nil, 'no hook: the request is as before')
reply({state='reply',text='Hey V'}); update()
local asked={}
m.captureMeetOffer=function(c,key) asked[#asked+1]=c..':'..key; return {version=1,token='meet-0123456789abcdef',kinds={'here'},here={place='Kabuki'},etaMinutes=0,waitMinutes=5,cancel=false} end
submission={contact='judy',text='come meet me'}; update()
assert(asked[1]=='judy:judy-alvarez' and #asked==1)
assert(request().meetOffer.token=='meet-0123456789abcdef' and request().meetOffer.here.place=='Kabuki')
m.captureMeetOffer=function() return nil end
reply({state='reply',text='On my way'}); update()
submission={contact='judy',text='hi again'}; update()
assert(request().meetOffer==nil)
`));

// Character bonds (mod/bonds.lua): the block a typed Phone Chat message carries in the request file, read once when the message is sent.
test('a typed message carries the bonds block the game captured, nothing when there is none, and a text she sends herself carries none', () => runLua(setup + `
update(); submission={contact='judy',text='Hello'}; update()
assert(m.pending and m.pending.bonds==nil and request().bonds==nil, 'no hook: the request is as before')
reply({state='reply',text='Hey V'}); update()
local asked={}
m.captureBonds=function(key) asked[#asked+1]=key; return {version=1,on=true,packs=true,invitations=true,busy=true} end
submission={contact='judy',text='what are you up to'}; update()
assert(asked[1]=='judy-alvarez' and #asked==1, 'asked once, when the message is sent')
local block=request().bonds
assert(block.version==1 and block.on==true and block.packs==true and block.invitations==true and block.busy==true and block.copy==nil)
for i=1,3 do m.update(player,0) end
assert(#asked==1, 'not again while the request waits (the file is rewritten every few seconds)')
reply({state='reply',text='Not much'}); update()
m.captureBonds=function() return nil end
submission={contact='judy',text='ok'}; update()
assert(request().bonds==nil)
m.captureBonds=function() error('boom') end
reply({state='reply',text='ok'}); update()
submission={contact='judy',text='still there?'}; update()
assert(m.pending and request().bonds==nil, 'a raising hook costs the message nothing')
reply({state='reply',text='yes'}); update()
m.captureBonds=function() return {version=1,on=true} end
assert(m.sendEvent(item)==true); update()
assert(m.pending.event and request().bonds==nil, 'a text she sends on her own is not a turn of V')
`));

test('the bridge answer reaches the game only for a message that carried an offer, with the contact and profile', () => runLua(setup + `
local got={}
m.onMeetAction=function(profileKey,action,c) got[#got+1]={profileKey,action.kind,action.token,c} end
m.captureMeetOffer=function() return {version=1,token='meet-0123456789abcdef',kinds={'here'},here={place='Kabuki'},etaMinutes=0,waitMinutes=5,cancel=false} end
update(); submission={contact='judy',text='come meet me'}; update()
reply({state='reply',text='Sure',action={kind='meet-here',token='meet-0123456789abcdef'}}); update()
assert(#got==1 and got[1][1]=='judy-alvarez' and got[1][2]=='meet-here' and got[1][3]=='meet-0123456789abcdef' and got[1][4]=='judy')
assert(m.history.judy[#m.history.judy].text=='Sure')
-- no offer was sent: an action in the reply is ignored
m.captureMeetOffer=nil
submission={contact='judy',text='hello'}; update()
reply({state='reply',text='Hi',action={kind='meet-here',token='meet-0123456789abcdef'}}); update()
assert(#got==1)
`));

test('a text she sends herself: a phone turn with an event and no typed line, appended as a received message, then announced', () => runLua(setup + `
local delivered={}
m.onEventDelivered=function(it,text) delivered[#delivered+1]=it.kind..':'..text end
update()
assert(m.sendEvent(item)==true)
update()
assert(m.pending and m.pending.event and m.pending.text=='' and m.pending.profileKey=='judy-alvarez' and m.pending.contact=='judy')
local sent=request()
assert(sent.text=='' and sent.event.kind=='arrived' and sent.event.place=="Lizzie's Bar, Kabuki" and sent.event.minutes==0 and sent.event.car==false)
assert(sent.fallback==nil and sent.eventItem==nil, 'her plain line stays in the game')
assert(m.history.judy==nil or #m.history.judy==0, 'nothing is shown as V\\'s own message')
reply({state='reply',text='Where are you?'}); update()
assert(not m.pending and #m.history.judy==1 and m.history.judy[1].text=='Where are you?' and m.history.judy[1].sent==false)
assert(#delivered==1 and delivered[1]=='arrived:Where are you?')
`));

test("an event waits while V's own message is out, and several go one after the other", () => runLua(setup + `
update(); submission={contact='judy',text='Hello'}; update()
local first=m.pending
assert(m.sendEvent(item) and m.sendEvent({profileKey='judy-alvarez',name='Judy',kind='stood-up',place='x',minutes=5,car=false,fallback='Forget it.'}))
update(); assert(m.pending==first and not m.pending.event)
reply({state='reply',text='Hey'}); update()
assert(m.pending and m.pending.event.kind=='arrived')
reply({state='reply',text='I am here'}); update()
assert(m.pending and m.pending.event.kind=='stood-up' and m.pending.event.minutes==5)
reply({state='reply',text='Never again'}); update()
assert(not m.pending and #m.history.judy==4)
`));

test('a text the bridge cannot write, or that times out, is her plain line, and V gets no error status or draft', () => runLua(setup + `
local delivered={}
m.onEventDelivered=function(it,text) delivered[#delivered+1]=text end
update(); m.sendEvent(item); update()
reply({state='error',error='Message could not be delivered. Please try again.'}); update()
assert(not m.pending and m.history.judy[1].text=="I'm here." and delivered[1]=="I'm here.")
assert((m.errors or {}).judy==nil and (m.drafts.judy or '')=='')
m.sendEvent({profileKey='judy-alvarez',name='Judy',kind='cancelled',place='x',minutes=0,car=false,fallback='Fine.'}); update()
assert(m.pending and m.pending.event)
clock=clock+60; update()
assert(not m.pending and m.history.judy[2].text=='Fine.' and delivered[2]=='Fine.' and (m.errors or {}).judy==nil)
`));

test('events need a phone contact and an enabled conversation; the queue is bounded; a memory clear shows the plain line', () => runLua(setup + `
update()
assert(m.sendEvent({profileKey='someone-else',name='X',kind='arrived',place='',minutes=0,fallback='hi'})==false, 'no phone contact')
enabled=false; assert(m.sendEvent(item)==false); enabled=true
for i=1,8 do assert(m.sendEvent(item)) end
assert(m.sendEvent(item)==false, 'at most eight wait')
`));

test('a load drops the waiting events and leaves no draft or interrupted-message status behind', () => runLua(setup + `
update(); m.sendEvent(item); update()
assert(m.pending and m.pending.event)
m.sendEvent(item)
m.abandon()
assert(not m.pending and m.events==nil)
update()
assert(((m.errors or {}).judy)==nil and (m.drafts.judy or '')=='')
`));

test('a plain text (she could not come) is her fallback line at once: no request is written for the bridge', () => runLua(setup + `
local delivered={}
m.onEventDelivered=function(it,text) delivered[#delivered+1]=text end
update()
local plain={profileKey='judy-alvarez',name='Judy',kind='failed',place='x',minutes=0,car=false,plain=true,fallback="Something came up and I can't make it."}
assert(m.sendEvent(plain))
update()
assert(not m.pending and #m.history.judy==1 and m.history.judy[1].text==plain.fallback and m.history.judy[1].sent==false)
assert(delivered[1]==plain.fallback)
local sent=files['runtime/phone-chat-input.json'] and json.decode(files['runtime/phone-chat-input.json']).request
assert(sent==nil, 'nothing was asked of the bridge')
`));
