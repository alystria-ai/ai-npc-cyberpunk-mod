import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// The housing offer rides the same lease as the drive, follow and leave offers (docs/HOUSEMATES.md): one request leases it, one packet that
// names an offered choice and echoes the offer exactly queues it once.
const source = readFileSync(new URL('../mod/gameplay-actions.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const fixture = `
local now,raw,sequence=100000,nil,0
local packets,queued,feedback={},{},{}
local world={ready=true,worldToken='world-a',generation=1}
local function clone(value)
 if type(value)~='table'then return value end
 local result={};for k,v in pairs(value)do result[k]=clone(v)end;return result
end
local home={available=true,actor={id='22ULL',key='judy'},apartments={{id='h10',name='Megabuilding H10'},{id='corpo',name='Corpo Plaza'}},
 members={{serial=2,id='22ULL',key='judy',name='Judy'},{serial=3,id='33ULL',key='panam',name='Panam'}},here='corpo',moveOut=true}
local groupHome={available=true,actor={id='22ULL',key='judy'},apartments={},members=home.members}
local leave={available=true,actor={id='22ULL',key='judy'},members={{serial=2,id='22ULL',key='judy',name='Judy'}}}
local function context(group)
 local c={requestId='request-1',generation=7,entity='22ULL',profileKey='judy'}
 if group then c.group={index=1,id='group-1'} end
 return c
end
local function packet(input,body,source)
 sequence=sequence+1
 local p={version=1,action='companion-home',actionId='action-'..sequence,requestId=input.requestId,generation=input.generation,
  entity=input.entity,profileKey=input.profileKey,source=source or 'private-text',worldToken='world-a',worldGeneration=1,
  createdAt=now,expiresAt=now+10000,home=body,homeOffer=clone(input.homeOffer)}
 raw=tostring(sequence);packets[raw]=p
 return p
end
local useGroup=false
local q=(function() ${source} end)().new({
 world=function()return world end,clock=function()return now end,
 normalizeOffer=function(value)return clone(value)end,
 homeOffer=function() return clone(home) end,
 groupHomeOffer=function() return clone(groupHome) end,
 leaveOffer=function() return clone(leave) end,
 queueHome=function(body,offer,entity,requestId,groupId) queued[#queued+1]={body=body,offer=offer,entity=entity,requestId=requestId,group=groupId};return true end,
 read=function()return raw end,decode=function(value)return assert(packets[value])end,
 developerMode=function()return false end,
 feedback=function(state,reason)feedback[#feedback+1]={state=state,reason=reason}end})
`;
function run(body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const status = lauxlib.luaL_dostring(vm, to_luastring(fixture + body));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(status, lua.LUA_OK, error);
}

test('a private turn leases the housing offer and a stay for an offered flat is queued once', () => run(`
 local input=context();assert(q.capture(input,'private-text'))
 assert(input.homeOffer and input.homeOffer.here=='corpo' and #input.homeOffer.members==2)
 packet(input,{op='stay',apartment='corpo'});q.update(true)
 assert(#queued==1 and queued[1].body.op=='stay' and queued[1].body.apartment=='corpo' and queued[1].entity=='22ULL')
 q.update(true);assert(#queued==1,'replayed')
`));

test('a flat that was not offered, a move out that was not offered and a stranger as a target are refused', () => run(`
 local input=context();q.capture(input,'private-text')
 packet(input,{op='stay',apartment='north'});q.update(true);assert(#queued==0)
 input=context();q.capture(input,'private-text');home.moveOut=nil
 q.capture({requestId='r2',generation=7,entity='22ULL',profileKey='judy'},'private-text')
 local second={requestId='r3',generation=7,entity='22ULL',profileKey='judy'};q.capture(second,'private-text')
 packet(second,{op='move-out'});q.update(true);assert(#queued==0)
 home.moveOut=true
 local third={requestId='r4',generation=7,entity='22ULL',profileKey='judy'};q.capture(third,'private-text')
 packet(third,{op='join',target='99ULL'});q.update(true);assert(#queued==0)
 packet(third,{op='join',target='33ULL'});q.update(true);assert(#queued==1)
`));

test('an offer that differs from the leased one, or a packet for another request, is refused', () => run(`
 local input=context();q.capture(input,'private-text')
 local p=packet(input,{op='stay',apartment='h10'});p.homeOffer.apartments[1].name='Another place';q.update(true);assert(#queued==0)
 input=context();input.requestId='r9';q.capture(input,'private-text')
 local stale=packet(input,{op='stay',apartment='h10'});stale.requestId='r1';q.update(true);assert(#queued==0)
`));

test('join all needs at least one listed member and reaches the queue as a whole', () => run(`
 local input=context();q.capture(input,'private-text')
 packet(input,{op='join',target='all'});q.update(true)
 assert(#queued==1 and queued[1].body.target=='all' and #queued[1].offer.members==2)
`));

test('the first speaker of a group round leases the audience (no flats) next to the leave offer', () => run(`
 local input=context(true);assert(q.capture(input,'group-text'))
 assert(input.homeOffer and #input.homeOffer.apartments==0 and #input.homeOffer.members==2 and input.leaveOffer)
 packet(input,{op='join',target='all'},'group-text');q.update(true)
 assert(#queued==1 and queued[1].group=='group-1')
 -- a later speaker of the round gets nothing
 local later=context(true);later.group.index=2;assert(not q.capture(later,'group-text') and later.homeOffer==nil)
`));

test('a malformed housing offer (too many flats or members) is not leased', () => run(`
 home.members={}
 for i=1,13 do home.members[i]={serial=i,id=i..'ULL',key='k'..i,name='n'} end
 local input=context();q.capture(input,'private-text')
 assert(input.homeOffer==nil)
`));

test('the lease is gone with the world: a changed world token revokes a late housing packet', () => run(`
 local input=context();q.capture(input,'private-text')
 packet(input,{op='stay',apartment='h10'})
 world.worldToken='world-b';q.update(true)
 assert(#queued==0)
`));

test('a leave offer may name up to twelve members', () => run(`
 leave.members={}
 for i=1,12 do leave.members[i]={serial=i,id=i..'ULL',key='k'..i,name='n'} end
 leave.members[1].id='22ULL'
 local input=context();assert(q.capture(input,'private-text'))
 assert(#input.leaveOffer.members==12)
 leave.members[13]={serial=13,id='13ULL',key='k13',name='n'}
 local second={requestId='r2',generation=7,entity='22ULL',profileKey='judy'};q.capture(second,'private-text')
 assert(second.leaveOffer==nil)
`));
