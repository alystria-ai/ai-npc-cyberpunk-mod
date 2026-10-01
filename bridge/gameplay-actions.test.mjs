import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const source = readFileSync(new URL('../mod/gameplay-actions.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const fixture = `
local now,raw,sequence=100000,nil,0
local packets,queued,feedback={},{},{}
local world={ready=true,worldToken='world-a',generation=1}
local offer={available=true,actor={serial=2,id='22ULL',key='judy'},
 car={id='33ULL',record='Vehicle.car',name='Car'},
 waypoint={id='map-4',position={x=1,y=2,z=3},name='Destination'},passengerSeat='seat_front_right'}
local function clone(value)
 if type(value)~='table'then return value end
 local result={};for k,v in pairs(value)do result[k]=clone(v)end;return result
end
local function context(id)return {requestId=id or 'request-1',generation=7,entity='22ULL',profileKey='judy'}end
local normalize=clone
local function packet(input)
 return {version=1,action='drive-to-waypoint',actionId='action-'..(sequence+1),requestId=input.requestId,
  generation=input.generation,entity=input.entity,profileKey=input.profileKey,source='private-text',
  worldToken='world-a',worldGeneration=1,createdAt=now,expiresAt=now+10000,offer=clone(input.chauffeurOffer or offer)}
end
local function publish(value)
 sequence=sequence+1;raw=tostring(sequence);packets[raw]=value
end
local nativeRefused,nativeThrow=false,false
local q=(function() ${source} end)().new({
 world=function()return world end,clock=function()return now end,
 normalizeOffer=function(value)return normalize(value)end,
 offer=function(entity)assert(entity=='22ULL');return offer end,
 queue=function(serial,snapshot,entity)
  queued[#queued+1]={serial=serial,offer=snapshot,entity=entity}
  if nativeThrow then error('side effect already occurred')end
  return not nativeRefused,nativeRefused and 'Waypoint changed' or 'Driving request queued'
 end,
 read=function()return raw end,decode=function(value)return assert(packets[value])end,
 feedback=function(state,reason)feedback[#feedback+1]={state=state,reason=reason}end})
`;
function run(body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const status = lauxlib.luaL_dostring(vm, to_luastring(fixture + body));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(status, lua.LUA_OK, error);
}

test('only an actual manual private admission captures an immutable actor and destination offer', () => run(`
 for _,source in ipairs({'phone','reaction','prefetch','group'})do
  assert(not q.capture(context(),source))
 end
 local input=context();input.group={};assert(not q.capture(input,'private-text'))
 input=context();input.reaction={};assert(not q.capture(input,'private-text'))
 input=context();assert(q.capture(input,'private-text'))
 assert(#queued==0 and input.chauffeurOffer.actor.id=='22ULL')
 local command=packet(input);input.chauffeurOffer.car.id='another-car';offer.car.id='changed'
 publish(command);q.update(true)
 assert(#queued==1 and queued[1].offer.car.id=='33ULL')
 assert(queued[1].serial==2 and queued[1].entity=='22ULL')
`));

test('wrong request, actor, source, world, action and destination cannot acquire a drive transaction', () => run(`
 local input=context();q.capture(input,'private-text')
 local valid=packet(input)
 for key,value in pairs({requestId='stale',generation=9,entity='99ULL',profileKey='panam',
  source='phone',worldToken='old-world',worldGeneration=9,version=2,action='execute-script'})do
  local bad=clone(valid);bad[key]=value;publish(bad);q.update(true);assert(#queued==0)
 end
 local bad=clone(valid);bad.offer.waypoint.position.x=300;publish(bad);q.update(true);assert(#queued==0)
 bad=clone(valid);bad.expiresAt=now;publish(bad);q.update(true);assert(#queued==0)
 bad=clone(valid);bad.createdAt=now+6000;publish(bad);q.update(true);assert(#queued==0)
 publish(valid);q.update(true);assert(#queued==1)
`));

test('the captured receipt uses the wire coordinate precision while changed actor, car and route remain rejected', () => run(`
 offer.waypoint.position={x=-1099.8369140625,y=2314.44873046875,z=37.0538749694824}
 normalize=function(value)
  local result=clone(value)
  for key,number in pairs(result.waypoint.position)do
   result.waypoint.position[key]=math.floor(number*1000000+0.5)/1000000
  end
  return result
 end
 local input=context();assert(q.capture(input,'private-text'))
 assert(input.chauffeurOffer.waypoint.position.x~=offer.waypoint.position.x)
 local valid=packet(input)
 local bad=clone(valid);bad.offer.actor.serial=19;publish(bad);q.update(true);assert(#queued==0)
 bad=clone(valid);bad.offer.car.id='changed';publish(bad);q.update(true);assert(#queued==0)
 bad=clone(valid);bad.offer.waypoint.position.x=bad.offer.waypoint.position.x+0.000001
 publish(bad);q.update(true);assert(#queued==0,'canonical packet equality must remain exact')
 publish(valid);q.update(true);assert(#queued==1)
 assert(queued[1].offer.waypoint.position.x==input.chauffeurOffer.waypoint.position.x)
`));

test('failed or identity-changing offer serialization cannot authorize an action', () => run(`
 for _,fault in ipairs({'throw','nil','actor','availability'})do
  normalize=function(value)
   if fault=='throw'then error('codec failed')end
   if fault=='nil'then return nil end
   local result=clone(value)
   if fault=='actor'then result.actor.id='other-actor'else result.available=false end
   return result
  end
  local input=context(fault);assert(not q.capture(input,'private-text'))
  assert(input.chauffeurOffer==nil and not q.inspect().pending)
 end
`));

test('duplicates and a throw after native submission never replay; repeated capture cannot rearm it', () => run(`
 local input=context();q.capture(input,'private-text');nativeThrow=true
 publish(packet(input));q.update(true);q.update(true)
 publish(packet(input));q.update(true);assert(#queued==1)
 assert(not q.capture(input,'private-text'));q.update(true);assert(#queued==1)
 assert(q.inspect().state=='rejected')
`));

test('menu, cancellation, newer requests and world changes revoke late actions', () => run(`
 local input=context();q.capture(input,'private-text');local old=packet(input)
 q.update(false);publish(old);q.update(true);assert(#queued==0)
 input=context('request-2');q.capture(input,'private-text');local second=packet(input)
 input=context('request-3');q.capture(input,'private-text');publish(second);q.update(true);assert(#queued==0)
 local third=packet(input);world.generation=2;publish(third);q.update(true);assert(#queued==0)
 world.generation=1;input=context('request-4');q.capture(input,'private-text')
 local fourth=packet(input);q.revoke('memory-reset');publish(fourth);q.update(true);assert(#queued==0)
`));

test('lease expiry and oversized or malformed packets fail without native calls', () => run(`
 local input=context();q.capture(input,'private-text')
 raw=string.rep('x',16385);q.update(true);assert(#queued==0)
 raw='malformed';q.update(true);assert(#queued==0)
 local command=packet(input);now=now+125000;publish(command);q.update(true);assert(#queued==0)
`));

test('native preconditions remain authoritative and a rejected action is consumed once', () => run(`
 local input=context();q.capture(input,'private-text');nativeRefused=true
 publish(packet(input));q.update(true);q.update(true)
 assert(#queued==1 and feedback[1].state=='rejected' and feedback[1].reason=='Waypoint changed')
`));

test('an older microphone cancellation cannot revoke a newer private action', () => run(`
 local input=context('new-text');q.capture(input,'private-text')
 q.revoke('old-microphone','older-recording');assert(q.inspect().pending)
 publish(packet(input));q.update(true);assert(#queued==1)
 input=context('next-text');q.capture(input,'private-text')
 q.revoke('this-request',input.requestId);assert(not q.inspect().pending)
`));
