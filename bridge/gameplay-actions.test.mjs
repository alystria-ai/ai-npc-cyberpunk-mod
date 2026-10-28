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
local nativeRefused,nativeThrow,developer=false,false,false
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
 developerMode=function()return developer end,
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

test('routine queued feedback uses the saved developer choice without repeating native admission', () => run(`
 local input=context();assert(q.capture(input,'private-text'))
 publish(packet(input));q.update(true);q.update(true)
 assert(#queued==1 and #feedback==0 and q.inspect().state=='queued')
 developer=true;q.update(true);assert(#queued==1 and #feedback==0)
 input=context('developer-trip');assert(q.capture(input,'private-text'))
 publish(packet(input));q.update(true);q.update(true)
 publish(packet(input));q.update(true)
 assert(#queued==2 and #feedback==1 and feedback[1].state=='queued')
 developer=false
 input=context('rejected-trip');assert(q.capture(input,'private-text'));nativeRefused=true
 publish(packet(input));q.update(true);q.update(true)
 assert(#queued==3 and #feedback==2 and feedback[2].state=='rejected')
`));

const tacticFixture = fixture
  .replace("offer=function(entity)assert(entity=='22ULL');return offer end,",
    "offer=function(entity)assert(entity=='22ULL');return driveAvailable and offer or {available=false} end,\n tacticOffer=function(entity)assert(entity=='22ULL');return tactic end,\n queueTactic=function(kind,snapshot,entity)tactics[#tactics+1]={kind=kind,offer=snapshot,entity=entity};return true,'started' end,")
  .replace('local packets,queued,feedback={},{},{}',
    "local packets,queued,feedback={},{},{}\nlocal tactics,driveAvailable={},false\nlocal tactic={available=true,actor={serial=2,id='22ULL',key='judy'},target={id='77ULL',name='Tyger Claw',hostile=true,distance=23},kinds={'fight'}}");
function runTactic(body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const status = lauxlib.luaL_dostring(vm, to_luastring(tacticFixture + body));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(status, lua.LUA_OK, error);
}

test('a marked-target offer is leased with the request and one offered tactic is queued once', () => runTactic(`
 local input=context();assert(q.capture(input,'private-text'))
 assert(input.chauffeurOffer==nil and input.tacticOffer.target.id=='77ULL')
 local base=packet(input);base.offer=nil;base.action='companion-tactic'
 base.tacticOffer=clone(input.tacticOffer)
 local wrong=clone(base);wrong.tactic='dance';publish(wrong);q.update(true);assert(#tactics==0,'unoffered kind')
 local changed=clone(base);changed.tactic='fight';changed.tacticOffer.target.id='99ULL';publish(changed);q.update(true);assert(#tactics==0)
 local drive=clone(base);drive.action='drive-to-waypoint';drive.offer=clone(offer);publish(drive);q.update(true)
 assert(#queued==0,'no drive offer was leased')
 local good=clone(base);good.tactic='fight';publish(good);q.update(true)
 assert(#tactics==1 and tactics[1].kind=='fight' and tactics[1].offer.target.id=='77ULL' and tactics[1].entity=='22ULL')
 publish(clone(good));q.update(true);assert(#tactics==1,'consumed once')
 driveAvailable=true;input=context('request-2');assert(q.capture(input,'private-text'))
 assert(input.chauffeurOffer and input.tacticOffer,'both offers ride on one lease')
`));

test('no marked target is reported to the bridge as one plain code, and never leases a tactic', () => runTactic(`
 tactic={available=false,reason='No target',code='no-target'}
 local input=context();assert(not q.capture(input,'private-text'))
 assert(input.tacticOffer==nil and input.tacticUnavailable=='no-target' and q.inspect().tacticUnavailable=='no-target')
 local again=context();again.requestId=input.requestId;assert(not q.capture(again,'private-text'))
 assert(again.tacticUnavailable=='no-target','the same admission keeps the advisory')
 tactic={available=false,reason='Target too far away'}
 input=context('request-2');assert(not q.capture(input,'private-text'))
 assert(input.tacticUnavailable==nil,'other reasons are not sent')
 tactic={available=false,reason='No target',code='no-target'}
 input=context('request-3');assert(not q.capture(input,'group-text'))
 assert(input.tacticUnavailable==nil,'only a private request carries it')
 tactic={available=true,actor={serial=2,id='22ULL',key='judy'},target={id='77ULL',name='Tyger Claw',hostile=true,distance=23},kinds={'fight'}}
 input=context('request-4');assert(q.capture(input,'private-text'))
 assert(input.tacticOffer and input.tacticUnavailable==nil)
`));

const driveFixture = tacticFixture
  .replace("return driveAvailable and offer or {available=false} end,", "return driveAvailable and offer or driveRefusal end,")
  .replace('local tactics,driveAvailable={},false', "local tactics,driveAvailable={},false\nlocal driveRefusal={available=false}");
function runDrive(body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const status = lauxlib.luaL_dostring(vm, to_luastring(driveFixture + body));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(status, lua.LUA_OK, error);
}

test('a ride the game refuses is reported to the bridge as one plain code, and never leases a ride', () => runDrive(`
 tactic={available=false}
 driveRefusal={available=false,reason='No waypoint',code='no-waypoint'}
 local input=context();assert(not q.capture(input,'private-text'))
 assert(input.chauffeurOffer==nil and input.driveUnavailable=='no-waypoint' and q.inspect().driveUnavailable=='no-waypoint')
 local again=context();again.requestId=input.requestId;assert(not q.capture(again,'private-text'))
 assert(again.driveUnavailable=='no-waypoint','the same admission keeps the advisory')
 driveRefusal={available=false,reason='Stopped',code='ambiguous-owned-car'}
 input=context('request-2');assert(not q.capture(input,'private-text'))
 assert(input.driveUnavailable=='no-car','several refusals share one code')
 driveRefusal={available=false,reason='Choose a ready companion from your party.',code='not-companion'}
 input=context('request-2b');assert(not q.capture(input,'private-text'))
 assert(input.driveUnavailable=='not-driver','a character the game placed (no copy of ours) is told it does not drive')
 driveRefusal={available=false,reason='Elsewhere',code='some-new-code'}
 input=context('request-3');assert(not q.capture(input,'private-text'))
 assert(input.driveUnavailable==nil,'an unknown reason is not sent')
 driveRefusal={available=false}
 input=context('request-4');assert(not q.capture(input,'private-text'))
 assert(input.driveUnavailable==nil,'no code, nothing sent')
 driveRefusal={available=false,reason='No waypoint',code='no-waypoint'}
 input=context('request-5');assert(not q.capture(input,'group-text'))
 assert(input.driveUnavailable==nil,'only a private request carries it')
 driveAvailable=true
 input=context('request-6');assert(q.capture(input,'private-text'))
 assert(input.chauffeurOffer and input.driveUnavailable==nil)
`));

test('with the native change counter the packet file is not read again until its revision changes, and still once a second', () => run(`
 local revision,reads,realRead=5,0,nil
 local second=(function() ${source} end)().new({
  world=function()return world end,clock=function()return now end,normalizeOffer=function(v)return normalize(v)end,
  offer=function()return offer end,queue=function(serial,snapshot,entity)queued[#queued+1]={serial=serial}return true,'ok'end,
  read=function()reads=reads+1;return raw end,decode=function(value)return assert(packets[value])end,
  revision=function(name)assert(name=='companion-actions.json');return revision end})
 local input=context();second.capture(input,'private-text');publish(packet(context('other')))
 second.update(true);assert(reads==1)
 for _=1,20 do second.update(true) end
 assert(reads==1,'An unchanged revision read the file again: '..reads)
 -- A changed revision reads at once and the packet is acted on.
 revision=6;publish(packet(input));second.update(true)
 assert(reads==2 and #queued==1,'A changed revision was not read')
 -- Without a counter every update reads, as before.
 local plain=(function() ${source} end)().new({
  world=function()return world end,clock=function()return now end,normalizeOffer=function(v)return normalize(v)end,
  offer=function()return offer end,queue=function()return true,'ok'end,
  read=function()reads=reads+1;return raw end,decode=function(value)return assert(packets[value])end})
 plain.capture(context('request-2'),'private-text');local before=reads
 for _=1,5 do plain.update(true) end
 assert(reads==before+5,'Without the plugin each update must read')
`));
