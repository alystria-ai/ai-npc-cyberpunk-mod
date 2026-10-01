import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
const source=readFileSync(new URL('../mod/companion-reload-cleanup.lua',import.meta.url),'utf8');
function run(body,native=false) {
  const vm=lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const program=storage+'local cleanup=(function() '+source+' end)()\n'+(native?nativeFixture:policyFixture)+body;
    const status=lauxlib.luaL_dostring(vm,to_luastring(program));
    const error=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(vm,-1));
    const line=Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(status,lua.LUA_OK,error+(line?'\n'+program.split('\n')[line-1]:''));
  } finally { lua.lua_close(vm); }
}
const storage=`
local function copy(v)
 if type(v)~='table' then return v end
 local out={};for k,c in pairs(v) do out[k]=copy(c) end;return out
end
local now,files,encoded,sequence,reads,writes=10000,{},{},0,0,0
local PATH='runtime/companion-chauffeur-cleanup.json'
os={time=function()return now end,remove=function(p)files[p]=nil;return true end,
 rename=function(a,b)if files[a] then files[b]=files[a];files[a]=nil;return true end end}
json={encode=function(v)sequence=sequence+1;local k='json-'..sequence;encoded[k]=copy(v);return k end,
 decode=function(k)return copy(assert(encoded[k],'invalid json'))end}
io={open=function(path,mode)
 if mode=='rb' then if not files[path] then return nil end
  return {read=function(_,count)reads=reads+1;return files[path]:sub(1,count)end,close=function()return true end}
 end
 return {write=function(_,v)writes=writes+1;files[path]=v;return true end,close=function()return true end}
end}
local receipt={version=2,intent='cleanup-only',issuedAt=now,expiresAt=now+3600,
 player='1001ULL',actor={id='2001ULL',record='Character.Test'},car={id='3001ULL',record='Vehicle.Test'},
 tag='CyberpunkConvaiCleanup_10000_123456789',seat='seat_front_left'}
local function save(v)files[PATH]=json.encode(v or receipt)end
`;
const policyFixture=`
local calls={samples=0,stops=0,brakes=0,restores=0,states=0,cancels=0,unmounts=0,deletes=0,polls=0}
local world={aboard=false,driverMounted=true,speed=0,auto=false,autoMatches=true}
local old={state='Executing',id=17,class='AIMountCommand'}
local latest
local api={}
function api.sample()
 calls.samples=calls.samples+1
 if world.unavailable then return nil,'missing',world.fatal end
 return {car={entityID={hash='3001ULL'}},info={speed=world.speed},driverMounted=world.driverMounted,
  playerAboard=world.aboard,playerDriver=world.playerDriver,autoEnabled=world.auto,
  autoMatches=world.autoMatches,blocked=world.blocked,driverExiting=world.exiting}
end
function api.stop()calls.stops=calls.stops+1;return true end
function api.brake()calls.brakes=calls.brakes+1;return true end
function api.restore(r)
 calls.restores=calls.restores+1
 old.id,old.class=r.id,r.class;return old
end
function api.commandState(cmd)calls.states=calls.states+1;return cmd.state end
function api.cancel(cmd)
 calls.cancels=calls.cancels+1;cmd.cancelRequested=true
 if not world.blockCancel then cmd.state='Cancelled' end
 return cmd.state=='Cancelled'
end
function api.commandReceipt(cmd)return {id=cmd.id,class=cmd.class,cancelRequested=cmd.cancelRequested==true}end
function api.unmount()
 calls.unmounts=calls.unmounts+1
 latest={id=100+calls.unmounts,class='AIUnmountCommand',state='Executing'}
 if world.instant then latest.state='Success';world.driverMounted=false end
 return latest
end
function api.delete(_,requested)
 if requested then calls.polls=calls.polls+1;return world.despawned,true end
 calls.deletes=calls.deletes+1;return not world.delayDelete,true
end
function api.capture(_,_,_,cmd,tag)
 local r=copy(receipt);r.tag=tag;r.command=cmd and api.commandReceipt(cmd);return r
end
function api.seated()return {},{},nil end
local owner=cleanup.new(api)
local function tick(n,dt,ready)
 for i=1,n or 1 do cleanup.update(owner,{},dt or .5,ready~=false) end
end
local function noMutations()
 assert(calls.stops+calls.brakes+calls.cancels+calls.unmounts+calls.deletes==0)
end
`;
test('absent, paused and malformed receipts never read native actors or mutate a world',()=>run(`
tick(3);assert(calls.samples==0 and reads==0)
owner=cleanup.new(api);files[PATH]=string.rep('x',4097);tick();assert(owner.phase=='rejected');noMutations()
owner=cleanup.new(api);save();tick(5,.5,false);assert(owner.receipt and calls.samples==0)
`));
test('legacy, expired, future, invalid-command and oversized receipts have no authority',()=>run(`
for _,change in ipairs({{version=1},{expiresAt=now},{issuedAt=now+60},{command={id=1,class='AITeleportCommand'}},
 {actor={id='quest',record='Character.Test'}},{tag='CyberpunkConvaiCompanion'},{attempts=4}}) do
 local v=copy(receipt);for k,c in pairs(change)do v[k]=c end
 owner=cleanup.new(api);save(v);tick();assert(owner.phase=='rejected' and not owner.receipt)
end
assert(calls.samples==0);noMutations()
`));
test('cleanup stays fully dormant while V occupies any seat of the borrowed car',()=>run(`
receipt.command={id=17,class='AIMountCommand'};save();world.aboard=true;world.auto=true
tick(30);assert(owner.phase=='waiting-for-player-exit');noMutations()
world.aboard=false;world.playerDriver=true;tick(4);noMutations()
assert(calls.restores==0 and calls.states==0)
`));
test('foreign AutoDrive owner is never disabled and native stop retries are bounded',()=>run(`
save();world.auto=true;world.autoMatches=false;tick(10);noMutations()
world.autoMatches=true;tick(30);assert(calls.stops==3 and calls.unmounts==0)
world.auto=false;tick();assert(calls.unmounts==1)
`));
test('a moving car is braked at most three times and no exit is sent until stopped',()=>run(`
save();world.speed=5;tick(50);assert(calls.brakes==3 and calls.unmounts==0)
world.speed=0;tick();assert(calls.unmounts==1)
`));
test('native scene/combat blocks retirement, unmount and deletion',()=>run(`
receipt.command={id=17,class='AIMountCommand'};save();world.blocked=true
tick(25);assert(owner.phase=='waiting-for-safe-exit');noMutations()
world.blocked=false;tick();assert(calls.restores==1 and calls.cancels==1)
`));
test('exact retired mount is cancelled before one animated unmount, then real unmount and terminal state gate deletion',()=>run(`
receipt.command={id=17,class='AIMountCommand'};save()
tick();assert(calls.restores==1 and calls.cancels==1 and calls.unmounts==0)
tick();assert(calls.unmounts==1 and owner.phase=='unmounting-driver')
tick(8);assert(calls.unmounts==1 and calls.deletes==0 and calls.cancels==1)
world.driverMounted=false;tick();assert(calls.cancels==2 and calls.deletes==0)
tick();assert(calls.deletes==1 and owner.phase=='complete' and not files[PATH])
`));
test('a recovered executing unmount waits for its seat link to clear',()=>run(`
receipt.command={id=17,class='AIUnmountCommand'};save();old.class='AIUnmountCommand'
tick(8);assert(calls.restores==1 and calls.cancels==0 and calls.unmounts==0)
world.driverMounted=false;tick();assert(calls.cancels==1 and calls.deletes==0)
tick();assert(calls.deletes==1)
`));
test('a cleared mount link does not permit deletion while the native exit workspot is still active',()=>run(`
save();world.driverMounted=false;world.exiting=true;tick(10)
assert(owner.phase=='waiting-for-driver-exit' and calls.deletes==0 and calls.unmounts==0)
world.exiting=false;tick();assert(owner.phase=='complete' and calls.deletes==1)
`));
test('unmount attempts are persisted and limited even across repeated CET reloads',()=>run(`
receipt.attempts=2;save();tick();assert(owner.attempts==3 and calls.unmounts==1)
latest.state='Failure';tick();assert(owner.phase=='failed' and calls.deletes==0)
assert(not files[PATH])
`));
test('a timed-out native command never licenses driver deletion',()=>run(`
receipt.command={id=17,class='AIMountCommand'};save();world.blockCancel=true
tick(30);assert(owner.phase=='failed' and calls.deletes==0 and calls.unmounts==0)
local before=calls.samples;tick(10);assert(calls.samples==before)
`));
test('accepted despawn is polled without sending a second deletion',()=>run(`
save();world.driverMounted=false;world.delayDelete=true;tick()
assert(calls.deletes==1 and owner.phase=='waiting-for-despawn')
tick(5);assert(calls.deletes==1 and calls.polls==5)
world.despawned=true;tick();assert(owner.phase=='complete' and calls.deletes==1)
`));
test('ownership rejection drops the receipt; unavailable world probes are rate limited and pauses do not advance them',()=>run(`
save();world.unavailable=true;tick(1,.1);assert(calls.samples==1)
tick(3,.1);assert(calls.samples==1)
tick(50,.1,false);assert(calls.samples==1)
tick(1,1000);assert(calls.samples==2)
world.fatal=true;tick();assert(owner.phase=='rejected');noMutations()
`));
test('capture is a one-driver cleanup receipt, and world abandonment performs no native access',()=>run(`
assert(cleanup.captureSeated(owner,{},{}));local saved=json.decode(files[PATH])
assert(saved.intent=='cleanup-only' and saved.version==2 and not saved.profileKey and not saved.waypoint)
assert(not cleanup.captureSeated(owner,{},{}));noMutations()
local before=calls.samples;cleanup.abandon(owner)
assert(not files[PATH] and not owner.receipt and owner.operation==nil and calls.samples==before)
tick();assert(calls.samples==before)
`));

const nativeFixture=`
CName={new=function(v)return v end};NameToString=function(v)return v end
local values={managed=true,tagged=true,role=true,owned=true,mounted=true,scene=false,
 actorId='18446744073709551001ULL',carId='18446744073709551002ULL',playerId='18446744073709551003ULL'}
local tags={CyberpunkConvaiCompanion=true}
local commands={};local retired=0
local role={IsA=function(_,class)return values.role and class=='AIFollowerRole' end}
local ai={GetAIRole=function()return role end,
 GetEnqueuedOrExecutingCommand=function(_,class)return commands[class] end}
local player={IsAttached=function()return true end,IsDeadNoStatPool=function()return false end,
 GetEntityID=function()return {hash=values.playerId} end,IsInCombat=function()return false end}
local npc={IsAttached=function()return true end,IsA=function(_,class)return class=='NPCPuppet' end,
 IsCrowd=function()return false end,GetEntityID=function()return {hash=values.actorId}end,
 GetRecordID=function()if values.retiring then error('retired actor record read')end;return 'Character.Test' end,
 GetAIControllerComponent=function()if values.retiring then error('retired actor AI read')end;return ai end}
local entity={IsAttached=function()return true end,IsVehicle=function()return true end,
 IsPlayerVehicle=function()return values.owned end,GetEntityID=function()return {hash=values.carId}end,
 GetRecordID=function()return 'Vehicle.Test' end,IsPlayerDriver=function()return false end}
local system={IsReady=function()return true end,
 IsManaged=function(_,e)return values.managed and e.hash==values.actorId end,
 IsTagged=function(_,e,tag)return e.hash==values.actorId and tags[tag] and values.tagged end,
 GetEntity=function(_,e)return e.hash==values.actorId and npc end,
 AssignTag=function(_,e,tag)assert(e.hash==values.actorId);if not values.noTag then tags[tag]=true end end,
 GetTaggedIDs=function(_,tag)
  if values.duplicate then return {{hash=values.actorId},{hash='999ULL'}} end
  return tags[tag] and {{hash=values.actorId}} or {}
 end,DeleteEntity=function()values.retiring=true;return true end}
local auto={GetAutodriveEnabled=function()return false end,GetAutodriveVehicle=function()return nil end,
 GetAutodriveIsDelamain=function()return false end}
Game={GetDynamicEntitySystem=function()return system end,FindEntityByID=function(e)
 assert(type(e.hash)=='string','UInt64 was converted through a double');return e.hash==values.carId and entity end,
 GetScriptableSystemsContainer=function()return {Get=function()return auto end}end,
 GetSceneSystem=function()return {GetScriptInterface=function()return {
 IsEntityInScene=function()return values.scene end,IsEntityInDialogue=function()return false end}end}end,
 GetWorkspotSystem=function()return {IsActorInWorkspot=function()return false end}end,
 GetAllBlackboardDefs=function()return {VehicleSummonData={SummonedVehicleEntityID='vehicle'}}end,
 GetBlackboardSystem=function()return {Get=function()return {
 GetEntityID=function()return {hash=values.carId}end}end}end}
NPCPuppet={IsInCombat=function()return false end}
local transport={mounting=function(entry)
 if entry.npc==npc and values.mounted then return {vehicle=values.carId,parent={hash=values.carId},seat=values.seat or 'seat_front_left'}end
 if entry.npc==player and values.aboard then return {vehicle=values.carId,parent={hash=values.carId},seat='seat_front_right'}end
end,inspect=function()return {ready=true,speed=0,playerMounted=values.aboard}end,
 commandReceipt=function(cmd)return {id=cmd.handle.id,class=cmd.handle.class}end,
 retiredCommand=function(r,owner)retired=retired+1;return {owner=owner,receipt=r,handle=commands[r.class]}end,
 commandState=function(cmd)return cmd.handle and cmd.handle.state or 'Cancelled' end,
 cancel=function()error('unexpected cancellation')end,mount=function()error('unexpected unmount')end}
local chauffeur={disable=function()error('unexpected AutoDrive disable')end,brake=function()error('unexpected brake')end}
local owner=cleanup.new(nil,transport,chauffeur)
`;
test('native legacy handoff requires actual managed tag, follower role and actual owned car driver seat',()=>run(`
for _,change in ipairs({'managed','tagged','role','owned'}) do
 values[change]=false;assert(not cleanup.captureSeated(owner,player,npc));values[change]=true
end
values.seat='seat_front_right';assert(not cleanup.captureSeated(owner,player,npc));values.seat=nil
assert(cleanup.captureSeated(owner,player,npc));local r=json.decode(files[PATH])
assert(r.actor.id==values.actorId and r.car.id==values.carId and r.player==values.playerId)
assert(tags[r.tag] and r.intent=='cleanup-only')
values.aboard=true;cleanup.update(owner,player,.5,true)
assert(owner.phase=='waiting-for-player-exit' and retired==0)
`,true));
test('native unique tag must read back as exactly one same entity; a disk receipt alone cannot authorize cleanup',()=>run(`
values.noTag=true;assert(not cleanup.captureSeated(owner,player,npc));assert(not files[PATH])
values.noTag=false;values.duplicate=true;assert(not cleanup.captureSeated(owner,player,npc));assert(not files[PATH])
values.duplicate=false;assert(cleanup.captureSeated(owner,player,npc))
local r=json.decode(files[PATH]);tags[r.tag]=nil
cleanup.update(owner,player,.5,true);assert(owner.phase=='rejected' and retired==0)
`,true));
test('native legacy command capture rejects a handler belonging to another car or slot',()=>run(`
commands.AIMountCommand={id=4,class='AIMountCommand',mountData={mountParentEntityId={hash='999ULL'},slotName='seat_front_left'}}
assert(not cleanup.captureSeated(owner,player,npc));assert(not files[PATH])
commands.AIMountCommand.mountData.mountParentEntityId.hash=values.carId
commands.AIMountCommand.mountData.slotName='seat_back_right'
assert(not cleanup.captureSeated(owner,player,npc));assert(not files[PATH])
commands.AIMountCommand.mountData.slotName='seat_front_left'
assert(cleanup.captureSeated(owner,player,npc));assert(json.decode(files[PATH]).command.id==4)
`,true));
test('accepted native deletion polls only its registry receipt, without retired actor or car component getters',()=>run(`
assert(cleanup.captureSeated(owner,player,npc));values.mounted=false
cleanup.update(owner,player,.5,true)
assert(owner.phase=='waiting-for-despawn' and values.retiring)
Game.FindEntityByID=function()error('retired vehicle read')end
cleanup.update(owner,player,.5,true);assert(owner.phase=='waiting-for-despawn')
values.managed=false;cleanup.update(owner,player,.5,true)
assert(owner.phase=='complete' and not files[PATH])
`,true));
