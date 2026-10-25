import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
const controller=readFileSync(new URL('../mod/companion-vehicles.lua',import.meta.url),'utf8');
const catalog=readFileSync(new URL('../mod/companion-vehicle-catalog.lua',import.meta.url),'utf8');
const native=readFileSync(new URL('../mod/companion-vehicle-native.lua',import.meta.url),'utf8');
const clearance=readFileSync(new URL('../mod/companion-clearance.lua',import.meta.url),'utf8');
function run(code) {
  const state=lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status=lauxlib.luaL_dostring(state,to_luastring(code));
  const error=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  lua.lua_close(state); assert.equal(status,lua.LUA_OK,error);
}
const fixture=`
local catalog=(function() ${catalog} end)()
dofile=function(file) assert(file=='companion-vehicle-catalog.lua',file); return catalog end
local transport=(function() ${controller} end)()
local player={}
local world={cars={},mounts={},commands={},spawned={},deleted={},releases={},resumes={},recoveries={}}
local function makeCar(id,n,occupied)
  local names={'seat_front_left','seat_front_right','seat_back_left','seat_back_right'}
  local car={id=id,entityID={hash=id},info={ready=true,speed=0,seats={}}}
  for i=1,n do car.info.seats[i]={name=names[i],occupant=occupied and occupied[i]} end
  world.cars[id]=car; return car
end
local primary=makeCar('v-car',4,{'player'})
world.primary=primary
local entries={}
local function party(n)
  for i=1,n do entries[i]={serial=i,key='person-'..i,npc={},entityID={hash='npc-'..i},slot=i} end
end
local function actual(person,car,seat)
  local before=world.mounts[person.serial]
  if before then
    for _,s in ipairs(world.cars[before.vehicle].info.seats) do if s.name==before.seat then s.occupant=nil end end
  end
  world.mounts[person.serial]=car and {vehicle=car.id,seat=seat} or nil
  if car then for _,s in ipairs(car.info.seats) do if s.name==seat then s.occupant=person.entityID.hash; s.reserved=false end end end
end
local api={}
function api.player() return world.primary end
function api.inspect(car) return world.cars[car.id].info end
function api.mounting(entry) return world.mounts[entry.serial] end
function api.spawn(choice,_,lead,ordinal)
  if world.spawnFail then world.spawnTries=(world.spawnTries or 0)+1; return nil,'blocked' end
  local car=makeCar('overflow-'..(#world.spawned+1),world.capacity or 4)
  car.record,car.name,car.appearance=choice.record,choice.name,choice.appearance
  if world.attachBlocked then car.info.ready=false end
  world.spawned[#world.spawned+1]=car
  return car
end
function api.mount(entry,car,seat,exit)
  local command={kind=exit and 'unmount' or 'mount',entry=entry,car=car,seat=seat,state='Executing'}
  world.commands[#world.commands+1]=command
  if not world.delayMount then
    local destination; if not exit then destination=car end
    actual(entry,destination,seat); command.state='Success'
  end
  return command
end
function api.commandState(command) return command.state end
function api.cancel(command)
  command.cancels=(command.cancels or 0)+1
  if world.cancelBlocked then return false end
  command.state='Cancelled'; return true
end
function api.follow(car,target,ordinal)
  local command={kind='follow',car=car,target=target,state='Executing'}
  world.commands[#world.commands+1]=command; return command
end
function api.brake(car) car.info.speed=0; car.brakedNative=true; return true end
function api.destroy(car)
  for _,s in ipairs(car.info.seats) do if s.occupant then return false,'occupied' end end
  world.deleted[#world.deleted+1]=car.id; return true
end
function api.recover(entry,_,occupied)
  world.recoveries[entry.serial]=(world.recoveries[entry.serial] or 0)+1
  if world.recoverBlocked then return false,'no ground' end
  occupied[#occupied+1]=entry.serial; return true
end
local hooks={
  release=function(entry)
    world.releases[entry.serial]=(world.releases[entry.serial] or 0)+1
    return not world.releaseBlocked
  end,
  resumed=function(entry) world.resumes[entry.serial]=(world.resumes[entry.serial] or 0)+1 end
}
local fleet=transport.new(api)
local function tick(n)
  for i=1,n or 1 do transport.update(fleet,player,entries,0.1,hooks) end
end
local function count(kind)
  local n=0; for _,c in ipairs(world.commands) do if c.kind==kind then n=n+1 end end; return n
end
`;

test('eight companions use three V passengers, one full four-seat car, then one driver',()=>run(`${fixture}
  party(8); tick(100)
  assert(#world.spawned==2,#world.spawned)
  assert(fleet.phase=='riding',fleet.phase)
  local totals={}
  for _,p in pairs(fleet.people) do totals[p.vehicle.id]=(totals[p.vehicle.id] or 0)+1 end
  assert(totals['v-car']==3 and totals['overflow-1']==4 and totals['overflow-2']==1)
  assert(primary.info.seats[1].occupant=='player')
  assert(count('mount')==8 and count('follow')==2)
  for i=1,8 do assert(world.releases[i]==1 and not world.resumes[i]) end
  tick(100); assert(count('mount')==8 and count('follow')==2)
`));

test('the overflow car guard grows with the party, so a party of thirty-six still gets every car it needs',()=>run(`${fixture}
  party(36); tick(900)
  -- Three ride with V, the other thirty-three fill nine four-seat cars: ten cars in all, past the old fixed eight.
  assert(#world.spawned==9,#world.spawned)
  assert(fleet.error==nil,fleet.error)
  local seated=0
  for _,p in pairs(fleet.people) do if p.phase=='riding' then seated=seated+1 end end
  assert(seated==36,seated)
`));

test('the overflow car guard still stops a runaway: it never creates cars beyond what the party needs plus one spare',()=>run(`${fixture}
  party(4); world.capacity=1
  tick(900)
  -- One-seat cars cannot ever seat anybody, so creation must stop at the guard instead of spawning forever.
  assert(#world.spawned+1<=math.max(8,2+math.ceil(4/4)),#world.spawned)
`));

test('real foreign occupants and reservations reduce capacity without eviction',()=>run(`${fixture}
  party(5); primary.info.seats[2].occupant='quest-npc'; primary.info.seats[3].reserved=true
  tick(80)
  assert(#world.spawned==1)
  assert(primary.info.seats[2].occupant=='quest-npc' and primary.info.seats[3].reserved)
  assert(fleet.people[1].seat=='seat_back_right')
  assert(count('unmount')==0)
`));

test('car preference selects a remaining model owner and carpools before creating the next car',()=>run(`${fixture}
  party(8); entries[4].key='judy-alvarez'; entries[5].key='panam-palmer'
  tick(100)
  assert(#world.spawned==2)
  assert(world.spawned[1].record=='Vehicle.v_standard25_villefort_columbus_player')
  assert(world.spawned[1].driver==4)
  assert(fleet.people[5].vehicle==world.spawned[1],'Panam should carpool into Judy remaining seat')
  assert(world.spawned[2].record==catalog.fallback.record)
`));

test('a two-seat V car fills its one passenger seat and uses actual overflow capacity',()=>run(`${fixture}
  party(6); primary.info.seats={primary.info.seats[1],primary.info.seats[2]}; world.capacity=2
  tick(140)
  assert(#world.spawned==3)
  assert(fleet.people[1].vehicle==primary)
  for _,car in ipairs(world.spawned) do
    local n=0; for _,p in pairs(fleet.people) do if p.vehicle==car then n=n+1 end end
    assert(n<=2)
  end
`));

test('walking must release before native mount and asynchronous success must be measured',()=>run(`${fixture}
  party(1); world.releaseBlocked=true; world.delayMount=true
  tick(20); assert(count('mount')==0 and transport.owns(fleet,1))
  world.releaseBlocked=false; tick(1); assert(count('mount')==1)
  local cmd=world.commands[1]; tick(20)
  assert(fleet.people[1].phase=='boarding' and count('mount')==1)
  cmd.state='Success'; tick(1)
  assert(fleet.people[1].phase~='riding','command success is not an occupied seat')
  actual(entries[1],primary,'seat_front_right'); tick(1)
  assert(fleet.people[1].phase=='riding')
`));

test('a native follower already in V car is adopted before overflow allocation',()=>run(`${fixture}
  party(3); actual(entries[3],primary,'seat_front_right'); tick(50)
  assert(#world.spawned==0 and fleet.people[3].seat=='seat_front_right')
  assert(count('mount')==2)
`));

test('player departure cancels own convoy, unmounts, then deletes only empty spawned cars',()=>run(`${fixture}
  party(7); tick(80); assert(count('follow')==1)
  world.primary=nil; tick(100)
  assert(fleet.phase=='on-foot' and #fleet.cars==0)
  assert(#world.deleted==1 and world.deleted[1]=='overflow-1')
  assert(count('unmount')==7)
  for i=1,7 do assert(world.resumes[i]==1 and not transport.owns(fleet,i)) end
  assert(primary.info.seats[1].occupant=='player')
`));

test('a resume callback declining ownership keeps the native transport handoff',()=>run(`${fixture}
  party(1); tick(30)
  local ready=false
  hooks.resumed=function(entry)
    if not ready then return false end
    world.resumes[entry.serial]=(world.resumes[entry.serial] or 0)+1
  end
  world.primary=nil; tick(30)
  assert(transport.owns(fleet,1) and not world.resumes[1])
  ready=true; tick(30)
  assert(not transport.owns(fleet,1) and world.resumes[1]==1)
`));

test('an uncertain mount cancellation prevents unmount and walking handoff',()=>run(`${fixture}
  party(1); world.delayMount=true; tick(1)
  actual(entries[1],primary,'seat_front_right')
  world.cancelBlocked=true; world.primary=nil; tick(40)
  assert(count('unmount')==0 and not world.resumes[1] and transport.owns(fleet,1))
  world.cancelBlocked=false; world.delayMount=false; tick(50)
  assert(count('unmount')==1 and world.resumes[1]==1)
`));

test('failed spawn and attachment have bounded attempts and no leaked pending car',()=>run(`${fixture}
  party(8); world.spawnFail=true; tick(400)
  assert(world.spawnTries==3 and #world.spawned==0)
  transport.abandon(fleet); world.spawnFail=false; world.attachBlocked=true; tick(1000)
  assert(#world.spawned==3 and #world.deleted==3)
`));

test('failed boarding stops after three attempts and never reports a ride',()=>run(`${fixture}
  party(1); world.delayMount=true; tick(1000)
  assert(count('mount')==3 and fleet.people[1].phase=='boarding-failed')
  assert(not world.mounts[1] and transport.owns(fleet,1))
`));

test('fast travel recovers only existing companions after release and never recreates actors',()=>run(`${fixture}
  party(4); tick(80); world.primary=nil
  transport.fastTravel(fleet); tick(100)
  assert(fleet.phase=='on-foot' and #world.spawned==1 and #world.deleted==1)
  for i=1,4 do assert(world.recoveries[i]==1 and world.resumes[i]==1) end
  transport.abandon(fleet); tick(10)
  for i=1,4 do assert(world.recoveries[i]==1) end
`));

test('failed fast travel ground recovery stays bounded, then hands the copy back to walking recovery',()=>run(`${fixture}
  party(2); world.primary=nil; world.recoverBlocked=true
  transport.fastTravel(fleet); tick(200)
  -- Retaining ownership after the last attempt left the copy unplanned with
  -- no on-foot recovery at all; walking ownership places it near V instead.
  for i=1,2 do assert(world.recoveries[i]==3 and world.resumes[i]==1 and not transport.owns(fleet,i)) end
  assert(count('mount')==0 and #world.spawned==0)
`));

test('save teardown drops stale handles without any native call',()=>run(`${fixture}
  party(8); tick(20)
  for key in pairs(api) do api[key]=function() error('native use during teardown') end end
  transport.abandon(fleet)
  assert(fleet.phase=='on-foot' and #fleet.cars==0 and next(fleet.people)==nil)
`));

test('unknown primary capacity prevents speculative overflow and combat postpones mounting',()=>run(`${fixture}
  party(8); primary.info.ready=false; tick(20)
  assert(#world.spawned==0 and count('mount')==0)
  primary.info.ready=true
  api.canBoard=function() return false end
  tick(80); assert(count('mount')==0)
  for _,p in pairs(fleet.people) do assert(p.attempts==0) end
  api.canBoard=function() return true end
  tick(80); assert(fleet.phase=='riding' and count('mount')==8)
`));

test('changing V vehicle completes the old unmount transaction before seating anyone in the new car',()=>run(`${fixture}
  party(5); tick(80)
  local second=makeCar('new-v-car',4,{'player'}); world.primary=second
  tick(140)
  assert(fleet.phase=='riding' and fleet.primary==second)
  assert(world.deleted[1]=='overflow-1' and #world.spawned==2)
  for _,m in pairs(world.mounts) do assert(m.vehicle~='v-car' and m.vehicle~='overflow-1') end
`));

test('removing a driver after actor deletion cancels the old convoy and reallocates surviving copies',()=>run(`${fixture}
  party(5); tick(80)
  local old=world.spawned[1]; local oldCommand=old.command
  actual(entries[4],nil); transport.remove(fleet,4); table.remove(entries,4)
  tick(160)
  assert(oldCommand.state=='Cancelled')
  assert(world.deleted[1]==old.id and #world.spawned==2)
  assert(fleet.people[5].vehicle==world.spawned[2])
  assert(world.spawned[2].driver==5)
`));

test('a stationary convoy far behind V cancels and retries routes only three times',()=>run(`${fixture}
  party(4); tick(80)
  world.spawned[1].info.playerGap=100; tick(900)
  assert(count('follow')==3 and not world.spawned[1].command)
  assert(world.spawned[1].error:find('blocked',1,true))
`));

test('native command submission preserves an exact cancellable handle even after a binding error',()=>run(`
  dofile=function() return {} end
  local adapter=(function() ${native} end)()
  CName={new=function(v) return v end}; NameToString=function(v) return v end
  EntityID={new=function() return {hash='0ULL'} end}
  NewObject=function(kind)
    local value={kind=kind,Copy=function(self) return self end}
    if kind=='gameMountEventOptions' then
      local fields={entityID=true,alive=true,occupiedByNonFriendly=true,silentUnmount=true}
      return setmetatable(value,{__newindex=function(t,key,item)
        assert(fields[key],'Unknown native MountEventOptions field: '..key);rawset(t,key,item)
      end})
    end
    return value
  end
  local saved; local cancels=0
  local ai={SendCommand=function(_,handle) saved=handle; error('binding threw after enqueue') end,
    GetCommandState=function(_,handle) assert(handle==saved); return saved.state or 'Executing' end,
    StopExecutingCommand=function(_,handle) assert(handle==saved); cancels=cancels+1 end}
  local npc={IsAttached=function() return true end,GetAIControllerComponent=function() return ai end}
  local operation=adapter.mount({npc=npc},{entityID='car'},'seat_front_right',false)
  assert(operation.handle==saved and operation.sendError)
  assert(not operation.handle.mountData.isInstant and not operation.handle.mountData.allowFailsafeTeleport)
  assert(operation.handle.mountData.mountEventOptions.occupiedByNonFriendly==false)
  assert(operation.handle.mountData.mountEventOptions.entityID.hash=='0ULL')
  assert(operation.handle.mountData.mountEventOptions.alive==false)
  assert(operation.handle.mountData.mountParentEntityId=='car')
  assert(not adapter.cancel(operation)); assert(not adapter.cancel(operation)); assert(cancels==1)
  saved.state='Cancelled'; assert(adapter.cancel(operation))
`));

test('native animated boarding reports its real high-level-state blockers without overriding them',()=>run(`
  dofile=function() return {} end
  local adapter=(function() ${native} end)()
  Enum={new=function(_,value) return value end}
  local npc={hls='Relaxed',GetHighLevelStateFromBlackboard=function(self) return self.hls end}
  NPCPuppet={IsInCombat=function(value) return value.combat==true end}
  assert(adapter.canBoard({npc=npc}))
  npc.hls='Alerted'; local calm,reason=adapter.canBoard({npc=npc})
  assert(not calm and reason=='Waiting for your companion to settle before boarding.' and npc.hls=='Alerted')
  npc.hls='Combat'; assert(not adapter.canBoard({npc=npc}))
  npc.hls='Relaxed'; npc.combat=true; calm,reason=adapter.canBoard({npc=npc})
  assert(not calm and reason=='Waiting for combat to finish before boarding.')
  npc.combat=false; assert(adapter.canBoard({npc=npc}))
`));

const nativeFixture=`
  dofile=function(file)
    if file=='companion-clearance.lua' then return (function() ${clearance} end)() end
    return {useSpatialBudget=function() end}
  end
  local adapter=(function() ${native} end)()
  CName={new=function(v) return v end}; NameToString=function(v) return v end
  EntityID={new=function() return {hash='0ULL'} end}; TweakDBID={new=function(v) return v end}
  Vector4={new=function(x,y,z,w) return {x=x,y=y,z=z,w=w} end}
  Quaternion={ToEulerAngles=function(v) return v end}
  Enum={new=function(_,v) return v end}
  NewObject=function(kind) return {kind=kind,Copy=function(self) return self end} end
  local values={record='Vehicle.v_standard3_thorton_mackinaw_ncu_player',occupants={},slots={},managed=true,tagged=true}
  local names={'seat_front_left','seat_front_right','seat_back_left','seat_back_right'}
  local seats={}
  for _,n in ipairs(names) do seats[#seats+1]={SeatName=function() return n end}; values.slots[n]=true end
  local record={VehDataPackage=function() return {VehSeatSet=function() return {VehSeats=function() return seats end} end} end,
    Type=function() return {Type=function() return 'Car' end} end,IsA=function() return true end}
  local ai={IsSeatReserved=function(_,n) return n==values.reserved end}
  local entity={IsAttached=function() return not values.detached end,IsVehicle=function() return true end,
    IsDestroyed=function() return values.destroyed or false end,GetRecord=function() return record end,
    GetRecordID=function() return values.record end,GetEntityID=function() return {hash='owned-car'} end,
    GetAIComponent=function() return ai end,HasOccupantSlot=function(_,n) return values.slots[n] end,
    GetLinearVelocity=function() return {x=values.speed or 0,y=0,z=0} end,
    GetDistanceToPlayerSquared=function() return 0 end,
    IsPlayerMounted=function() return values.playerMounted or false end,IsPerformingSceneAnimation=function() return false end,
    HasPassengers=function() return next(values.occupants)~=nil end,
    GetWorldPosition=function() return {x=0,y=0,z=0} end,
    GetWorldForward=function() return {x=0,y=1,z=0} end,
    GetWorldOrientation=function() return {} end}
  local system={IsManaged=function() return values.managed end,IsTagged=function() return values.tagged end,
    DeleteEntity=function()
      values.deletes=(values.deletes or 0)+1
      if not values.delayDelete then values.managed=false end
      return true
    end,
    IsReady=function() return true end,
    -- A detached cached handle is re-resolved by exact entity ID; streaming can
    -- hand back the same detached entity.
    GetEntity=function() return entity end,
    CreateEntity=function(_,spec) values.spec=spec; return {hash='new-car'} end}
  Game={GetMountingFacility=function() return {
    GetMountingInfoSingleWithIds=function(_,child,parent,slot)
      assert(child.hash=='0ULL' and parent.hash=='owned-car')
      return {childId={hash=values.occupants[slot.id] or '0ULL'}}
    end} end,
    GetDynamicEntitySystem=function() return system end,
    GetSpatialQueriesSystem=function() return {
      SyncRaycastByCollisionGroup=function(_,a,b,group)
        if values.noFloor then return false end
        return true,{position={z=0},normal={z=1}}
      end,
      Overlap=function() return values.blocked or false end} end}
  TweakDB={GetRecord=function() return record end}
  local car={id='owned-car',entityID={hash='owned-car'},entity=entity,system=system,owned=true}
`;

test('deferred car placement does not spend attempts or change the preferred car',()=>run(`${fixture}
  party(8)
  local original=api.spawn
  api.spawn=function() return nil,nil,true end
  tick(50)
  assert(fleet.spawnAttempts==0 and fleet.spawnFailures==0 and #world.spawned==0)
  assert(fleet.spawnAt==0 and not fleet.error)
  api.spawn=original
  tick(100)
  assert(fleet.phase=='riding' and #world.spawned==2)
`));

test('deferred ground recovery retains ownership without spending recovery attempts',()=>run(`${fixture}
  party(1); tick(20)
  transport.fastTravel(fleet)
  api.recover=function() return nil,nil,true end
  world.primary=nil
  tick(80)
  local person=fleet.people[1]
  assert(person.owned and (person.recoverAttempts or 0)==0 and not person.recoverAt)
  assert(person.phase~='recovery-failed' and not world.resumes[1])
  api.recover=function() return true end
  tick(10)
  assert(world.resumes[1])
`));

test('native capacity includes live reservations, actual entity slots, and the source Mackinaw exception',()=>run(`${nativeFixture}
  values.occupants.seat_front_left='player'; values.reserved='seat_back_left'
  local result=adapter.inspect(car)
  assert(#result.seats==3 and result.seats[1].occupant=='player' and result.seats[3].reserved)
  values.record='Other'; values.slots.seat_back_left=false
  result=adapter.inspect(car); assert(#result.seats==3)
  assert(result.seats[3].name=='seat_back_right')
`));

test('native cleanup refuses borrowed cars, foreign occupants, player use and unverified detached occupants',()=>run(`${nativeFixture}
  car.owned=false; assert(not adapter.destroy(car) and not values.deletes)
  car.owned=true; values.occupants.seat_front_right='quest-npc'
  assert(not adapter.destroy(car) and not values.deletes)
  values.occupants={}; values.playerMounted=true
  assert(not adapter.destroy(car) and not values.deletes)
  values.playerMounted=false; values.detached=true
  assert(not adapter.destroy(car) and not values.deletes)
  values.detached=false; assert(adapter.destroy(car) and values.deletes==1)
`));

test('native spawn rejects missing support and overlap and creates only nonpersistent tagged copies',()=>run(`${nativeFixture}
  local choice={record='Vehicle.v_standard2_archer_hella_player',name='Hella'}
  values.noFloor=true; assert(not adapter.spawn(choice,{},car,1) and not values.spec)
  values.noFloor=false; values.blocked=true
  assert(not adapter.spawn(choice,{},car,1) and not values.spec)
  values.blocked=false
  local created=adapter.spawn(choice,{},car,1)
  assert(created and created.owned and values.spec)
  assert(values.spec.persistSpawn==false and values.spec.persistState==false)
  assert(values.spec.tags[1]=='CyberpunkConvaiPartyVehicle')
  assert(values.spec.position.y<0 and values.spec.position.z>0)
`));

test('moving primary defers the real native overflow spawn without exhausting fleet retries',()=>run(`${nativeFixture}
  local catalog=(function() ${catalog} end)()
  dofile=function(file) assert(file=='companion-vehicle-catalog.lua',file); return catalog end
  local transport=(function() ${controller} end)()
  values.record='Other'
  values.occupants.seat_front_left='player'
  values.speed=5
  local api={
    player=function() return car end,
    inspect=function(vehicle)
      if vehicle==car then return adapter.inspect(car) end
      return {ready=false}
    end,
    mounting=function() return nil end,
    spawn=adapter.spawn,
  }
  local entries={}
  for i=1,4 do entries[i]={serial=i,key='person-'..i,entityID={hash='npc-'..i},npc={}} end
  local hooks={release=function() return true end,resumed=function() end}
  local fleet=transport.new(api)
  for _=1,100 do transport.update(fleet,{},entries,0.1,hooks) end
  assert(#fleet.cars==0 and not values.spec)
  assert(fleet.spawnAttempts==0 and fleet.spawnFailures==0)
  values.speed=0
  transport.update(fleet,{},entries,0.1,hooks)
  assert(#fleet.cars==1 and values.spec and fleet.spawnFailures==0)
  assert(fleet.cars[1].driver==4)
`));

test('an unexpected foreign mount retains movement ownership until native dismount',()=>run(`${fixture}
  party(1); tick(20)
  local foreign=makeCar('quest-car',2,{'quest-driver'})
  actual(entries[1],foreign,'seat_front_right'); world.primary=nil; tick(20)
  assert(transport.owns(fleet,1) and not world.resumes[1])
  assert(fleet.people[1].phase=='waiting-for-native-dismount')
  assert(count('unmount')==0,'foreign occupant was forced out')
  actual(entries[1],nil); tick(2)
  assert(not transport.owns(fleet,1) and world.resumes[1]==1)
`));

test('native transit receipts reacquire only the exact command ID on a fresh owner',()=>run(`${nativeFixture}
  local stale={id=7,GetClassName=function() return 'AIMountCommand' end}
  local receipt=adapter.commandReceipt({handle=stale,cancelRequested=true})
  assert(receipt.id==7 and receipt.class=='AIMountCommand' and receipt.cancelRequested)
  assert(receipt.handle==nil and receipt.owner==nil and receipt.ai==nil)
  stale.GetClassName=function() error('stale native command') end
  local current={id=7,state='Executing'}; local stopped=0
  local currentAI={GetEnqueuedOrExecutingCommand=function(_,kind) assert(kind=='AIMountCommand'); return current end,
    IsCommandActive=function(_,id) return id==7 end,
    GetCommandState=function(_,command) assert(command==current); return current.state end,
    StopExecutingCommand=function() stopped=stopped+1 end}
  local actor={IsAttached=function() return true end,GetAIControllerComponent=function() return currentAI end}
  local operation=adapter.retiredCommand(receipt,actor,false)
  assert(not adapter.cancel(operation) and operation.handle==current and stopped==0)
  current.state='Cancelled'; assert(adapter.cancel(operation) and stopped==0)
  receipt.cancelRequested=false; current={id=9,state='Executing'}
  operation=adapter.retiredCommand(receipt,actor,false)
  assert(not adapter.cancel(operation) and operation.handle==nil and stopped==0,'different command was cancelled')
  currentAI.IsCommandActive=function() return false end
  assert(adapter.cancel(operation) and stopped==0)
`));

test('accepted native car deletion polls ownership without repeating deletion or touching detached components',()=>run(`${nativeFixture}
  values.delayDelete=true
  local done,reason=adapter.destroy(car)
  assert(not done and reason and car.deleteRequested and car.retired and values.deletes==1)
  entity.IsAttached=function() error('deleted vehicle component accessed') end
  for _=1,7 do assert(not adapter.destroy(car) and values.deletes==1) end
  values.tagged=false
  assert(not adapter.destroy(car) and values.deletes==1,'changed tag allowed another delete')
  values.managed=false
  assert(adapter.destroy(car) and values.deletes==1)
`));

test('an unavailable vehicle system cannot confirm deletion from its false managed result',()=>run(`${nativeFixture}
  values.delayDelete=true; assert(not adapter.destroy(car) and car.deleteRequested)
  system.IsReady=function() return false end
  system.IsManaged=function() error('managed query while system unavailable') end
  assert(not adapter.destroy(car) and values.deletes==1)
`));

test('failed car deletion requests remain retryable and retain tag and occupant guards',()=>run(`${nativeFixture}
  values.tagged=false; assert(not adapter.destroy(car) and not values.deletes)
  values.tagged=true; values.occupants.seat_back_left='foreign-passenger'
  assert(not adapter.destroy(car) and not values.deletes)
  values.occupants={}
  system.DeleteEntity=function() values.deletes=(values.deletes or 0)+1; return false end
  assert(not adapter.destroy(car) and not car.deleteRequested and values.deletes==1)
  assert(not adapter.destroy(car) and not car.deleteRequested and values.deletes==2)
`));

test('fleet retains a delayed deletion beyond three polls and never inspects its detached owner',()=>run(`${nativeFixture}
  local catalog=(function() ${catalog} end)()
  dofile=function(file) assert(file=='companion-vehicle-catalog.lua'); return catalog end
  local transport=(function() ${controller} end)()
  adapter.player=function() return nil end
  local inspect=adapter.inspect; local staleReads=0
  adapter.inspect=function(value)
    if value.deleteRequested then staleReads=staleReads+1; error('retiring vehicle component accessed') end
    return inspect(value)
  end
  values.delayDelete=true
  local fleet=transport.new(adapter); fleet.cars={car}
  local hooks={release=function() return true end,resumed=function() end}
  transport.update(fleet,{}, {},5,hooks)
  assert(#fleet.cars==1 and car.deleteAttempts==1 and car.deleteRequested and values.deletes==1)
  values.detached=true
  for _=1,7 do transport.update(fleet,{}, {},5,hooks) end
  assert(#fleet.cars==1 and car.deleteAttempts==1 and values.deletes==1 and staleReads==0)
  values.managed=false; transport.update(fleet,{}, {},5,hooks)
  assert(#fleet.cars==0 and values.deletes==1 and staleReads==0)
  assert(fleet.events[#fleet.events].event=='empty-car-deleted')
`));

test('accepted deletion survives transit without acquiring an entity handle or issuing another delete',()=>run(`${nativeFixture}
  local catalog=(function() ${catalog} end)()
  dofile=function(file) assert(file=='companion-vehicle-catalog.lua'); return catalog end
  local transport=(function() ${controller} end)()
  values.delayDelete=true
  assert(not adapter.destroy(car) and values.deletes==1)
  local fleet=transport.new(adapter); fleet.cars={car}
  local receipt=transport.suspend(fleet)
  assert(receipt.cars[1].deleteRequested and receipt.cars[1].entity==nil)
  system.GetEntity=function() error('retiring entity was reacquired') end
  values.tagged=false
  local returned=adapter.rebindVehicle(receipt.cars[1],system)
  assert(returned and returned.deleteRequested and returned.entity==nil)
  assert(not adapter.destroy(returned) and values.deletes==1)
  values.tagged=true; assert(not adapter.destroy(returned) and values.deletes==1)
  values.managed=false; assert(adapter.destroy(returned) and values.deletes==1)
`));

// October 5 overflow test: a convoy following the player puppet seated in V's
// car never moved. Native drive-follow trails a vehicle.
test('the overflow convoy follows the car V drives, not the seated player puppet',()=>run(`${fixture}
  local carEntity={IsAttached=function() return true end}
  primary.entity=carEntity
  party(4); tick(80)
  local follow
  for _,command in ipairs(world.commands) do if command.kind=='follow' then follow=command end end
  assert(follow,'no convoy follow was requested')
  assert(follow.target==carEntity,'the convoy followed something other than the car V drives')
`));


// Duplicate-copies review: dismissing one rider made every other rider step out
// and re-board, and a passenger leaving cancelled a whole chauffeur trip.
test('dismissing one passenger leaves the other riders seated',()=>run(`${fixture}
  party(4); tick(80)
  assert(fleet.phase=='riding')
  local before=count('unmount')
  transport.removing(fleet,1); table.remove(entries,1); transport.remove(fleet,1); tick(30)
  assert(count('unmount')==before,'other riders were made to step out')
  assert(fleet.phase=='riding')
`));

test('dismissing the convoy driver still replans the trip',()=>run(`${fixture}
  party(4); tick(80)
  local driver=world.spawned[1].driver
  assert(driver,'no convoy driver')
  local before=count('unmount')
  transport.removing(fleet,driver)
  for i=#entries,1,-1 do if entries[i].serial==driver then table.remove(entries,i) end end
  transport.remove(fleet,driver); tick(30)
  assert(count('unmount')>before,'losing the convoy driver did not replan')
`));

test('a passenger leaving does not cancel a chauffeur trip driven by someone else',()=>run(`${fixture}
  party(2); tick(30)
  fleet.chauffeur={serial=99,phase='driving'}
  transport.removing(fleet,1)
  assert(fleet.chauffeur and fleet.chauffeur.serial==99,'the trip was cancelled by a passenger leaving')
`));

// ---- the Delamain cab: a self-driving taxi, not a convoy leader ---------------------------------
const taxiFixture=`${fixture}
world.taxi={['v-car']=true}
function api.isTaxi(car) return world.taxi[car.id]==true end
-- V sits in the back left seat; nobody drives the cab.
primary.info.seats[1].occupant=nil; primary.info.seats[3].occupant='player'
`;

test('a taxi seats the first companion in the front passenger seat (back right may be taken by the game Johnny) and never uses the driver seat',()=>run(`${taxiFixture}
  party(1); tick(40)
  assert(fleet.phase=='riding',fleet.phase)
  assert(fleet.people[1].seat=='seat_front_right',fleet.people[1].seat)
  assert(#world.spawned==0 and primary.info.seats[1].occupant==nil)
`));

test('a taxi fills front right, then back right, and leaves the driver seat empty',()=>run(`${taxiFixture}
  party(2); tick(60)
  assert(fleet.phase=='riding',fleet.phase)
  assert(fleet.people[1].seat=='seat_front_right' and fleet.people[2].seat=='seat_back_right')
  assert(primary.info.seats[1].occupant==nil,'the driver seat was used')
  for _,command in ipairs(world.commands) do assert(command.seat~='seat_front_left') end
  assert(#world.spawned==0)
`));

test('a taxi never spawns or follows overflow cars; the rest wait with a plain reason',()=>run(`${taxiFixture}
  party(5); tick(200)
  assert(#world.spawned==0,#world.spawned)
  assert(count('follow')==0)
  local seated,waiting=0,0
  for _,p in pairs(fleet.people) do
    if p.phase=='riding' then seated=seated+1
    else
      waiting=waiting+1
      assert(p.error=='The Delamain cab has no free seat for this companion.',tostring(p.error))
      assert(p.owned and not p.vehicle)
    end
  end
  assert(seated==2 and waiting==3,seated..' '..waiting)
  assert(fleet.phase=='boarding')
`));

test('the taxi arrival starts the exit while V still sits, and the fleet does not board again',()=>run(`${taxiFixture}
  party(5); tick(100)
  assert(fleet.people[1].phase=='riding' and fleet.people[2].phase=='riding')
  local mounts=count('mount')
  transport.chauffeurAutodriveToggled(fleet,false)
  local arrived=false
  for _,event in ipairs(fleet.events) do if event.event=='taxi-arrived' then arrived=true end end
  assert(arrived,'no taxi-arrived event')
  tick(100)
  assert(count('unmount')==2,count('unmount'))
  for i=1,5 do assert(world.resumes[i]==1,'companion '..i..' did not walk on') end
  assert(fleet.phase=='on-foot',fleet.phase)
  -- V is still in the cab they just left: no new journey.
  tick(100)
  assert(fleet.phase=='on-foot' and count('mount')==mounts and next(fleet.people)==nil,fleet.phase)
  -- V gets out, then calls the cab again: a new journey boards normally.
  world.primary=nil; tick(5)
  assert(fleet.taxiExit==nil and fleet.phase=='on-foot')
  primary.info.seats[1].occupant=nil; primary.info.seats[3].occupant='player'
  world.primary=primary; tick(60)
  -- Three of the five find no seat, so the fleet stays in boarding but the seated two ride.
  assert(fleet.phase=='boarding' and fleet.people[1].phase=='riding' and fleet.people[2].phase=='riding',fleet.phase)
  assert(fleet.people[1].seat=='seat_front_right' and fleet.people[2].seat=='seat_back_right')
`));

test('taxiArrived is ignored on foot, and teardown clears the taxi exit guard',()=>run(`${taxiFixture}
  party(1)
  transport.chauffeurAutodriveToggled(fleet,false)
  assert(fleet.phase=='on-foot' and fleet.taxiExit==nil)
  tick(40); transport.chauffeurAutodriveToggled(fleet,false)
  assert(fleet.taxiExit=='v-car')
  transport.abandon(fleet)
  assert(fleet.taxiExit==nil and fleet.phase=='on-foot')
`));

test('the same autodrive call in an ordinary car changes nothing',()=>run(`${fixture}
  party(2); tick(60)
  assert(fleet.phase=='riding')
  transport.chauffeurAutodriveToggled(fleet,false)
  transport.chauffeurAutodriveToggled(fleet,true)
  tick(60)
  assert(fleet.phase=='riding' and fleet.taxiExit==nil and count('unmount')==0)
  for _,event in ipairs(fleet.events) do assert(event.event~='taxi-arrived') end
`));

test('an adapter without isTaxi treats every car as an ordinary car',()=>run(`${fixture}
  party(8); tick(100)
  assert(#world.spawned==2 and fleet.phase=='riding')
`));

// Alt Cunningham has a real body (our copy is an ordinary spawned character): she drives like anyone else, in the fallback car.
test('the catalog treats Alt Cunningham like anyone else: no personal car, so the fallback, and she can be chosen to drive',()=>run(`${fixture}
  assert(catalog.drives==nil and catalog.passengerOnly==nil,'the old passenger-only rule is gone')
  assert(not catalog.preferred['alt-cunningham'],'she owns no car record')
  local alt={entry={serial=1,key='alt-cunningham',record='Character.Alt'}}
  local judy={entry={serial=2,key='judy-alvarez'}}
  local plain={entry={serial=3,key='person-3'}}
  local choice,driver=catalog.choose({alt,plain})
  assert(choice==catalog.fallback and driver==alt,'the first in the queue drives')
  choice,driver=catalog.choose({alt,judy,plain}); assert(driver==judy and choice.name=="Judy's van")
  choice,driver=catalog.choose({alt}); assert(driver==alt and choice==catalog.fallback)
  assert(select(2,catalog.choose({}))==nil)
`));

test('Alt is seated in serial order like anyone else and drives the overflow car when she is first to need one',()=>run(`${fixture}
  party(8); entries[8].key='alt-cunningham'; entries[8].record='Character.Alt'
  tick(100)
  assert(fleet.people[8].vehicle~=primary,'serial order: she is not seated first')
  assert(#world.spawned==2,#world.spawned)
  assert(world.spawned[2].driver==8,'she drives the second overflow car')
  for _,p in pairs(fleet.people) do assert(p.phase=='riding',p.entry.serial..' '..tostring(p.phase)) end
`));

test('Alt, first in serial order, takes the wheel of the one overflow car',()=>run(`${fixture}
  party(5); primary.info.seats[2].occupant='quest-npc'; primary.info.seats[3].reserved=true
  entries[1].key='alt-cunningham'; entries[1].record='Character.Alt'
  tick(100)
  assert(#world.spawned==1,#world.spawned)
`));

// ---- another mod's riders (docs/COMPANION_VEHICLES_DESIGN.md, "Other mods' riders") -----------------------------------------------
// The follower mod seats its own followers in V's car when V gets in: the front passenger seat first, then the next free
// passenger seats in the vehicle's seat order, one per rider, without looking at who sits where. The adapter reports how
// many of them are about to ride; our companions choose from what is left after that plan.
const foreignFixture=`${fixture}
  world.foreignCalls=0
  function api.foreignRiders(player,car)
    world.foreignCalls=world.foreignCalls+1
    if world.foreignError then return nil,'scan failed' end
    return world.foreign or 0
  end
  local function seatsOf(car) local out={} for _,p in pairs(fleet.people) do if p.vehicle==car then out[p.seat]=p.entry.serial end end return out end
`;

test('with no foreign riders the first companion still takes the front passenger seat',()=>run(`${foreignFixture}
  party(1); tick(30)
  assert(fleet.people[1].seat=='seat_front_right',fleet.people[1].seat)
  assert(world.foreignCalls==1,world.foreignCalls)
`));

test('one foreign rider takes the front passenger seat in the plan: our companion sits in the next seat',()=>run(`${foreignFixture}
  world.foreign=1; party(1); tick(30)
  assert(fleet.people[1].vehicle==primary and fleet.people[1].seat=='seat_back_left',tostring(fleet.people[1].seat))
  assert(fleet.people[1].phase=='riding',fleet.people[1].phase)
  assert(world.mounts[1].seat=='seat_back_left')
`));

test('two foreign riders leave one seat: the first companion takes the last seat, the second gets an overflow car',()=>run(`${foreignFixture}
  world.foreign=2; party(2); tick(100)
  local at=seatsOf(primary)
  assert(at.seat_back_right==1 and not at.seat_front_right and not at.seat_back_left,'V car: '..tostring(at.seat_back_right)..' '..tostring(at.seat_front_right)..' '..tostring(at.seat_back_left))
  assert(#world.spawned==1 and fleet.people[2].vehicle==world.spawned[1] and fleet.people[2].seat=='seat_front_left')
  for _,m in pairs(world.mounts) do if m.vehicle=='v-car' then assert(m.seat=='seat_back_right',m.seat) end end
`));

test('three foreign riders take every passenger seat: nobody of ours shares one, the companion uses the no-free-seat path',()=>run(`${foreignFixture}
  world.foreign=3; party(1); tick(100)
  assert(fleet.people[1].vehicle~=primary,'never in V car')
  assert(#world.spawned==1 and fleet.people[1].vehicle==world.spawned[1])
  for _,m in pairs(world.mounts) do assert(m.vehicle~='v-car',m.vehicle..' '..m.seat) end
`));

test('more foreign riders than seats hold only the seats that exist, and a companion drives her own car',()=>run(`${foreignFixture}
  world.foreign=7; party(1); entries[1].key='alt-cunningham'; entries[1].record='Character.Alt'
  tick(100)
  assert(#world.spawned==1 and fleet.people[1].vehicle==world.spawned[1])
`));

test('the hold ends after twenty-five seconds: a companion still waiting (no overflow car can be made) then takes the seat that stayed empty',()=>run(`${foreignFixture}
  world.foreign=3; world.spawnFail=true; party(1)
  tick(240)
  assert(not fleet.people[1].vehicle,'held at 24 s')
  tick(30)
  assert(fleet.people[1].vehicle==primary and fleet.people[1].seat=='seat_front_right',tostring(fleet.people[1].seat))
`));

test('the plan is made once per boarding from the seats free then: a seat that fills up does not move the hold',()=>run(`${foreignFixture}
  world.foreign=1; party(2)
  primary.info.speed=3 -- V is still rolling: assignment happens, mounting waits
  tick(10)
  assert(world.foreignCalls==1)
  -- The follower mod's rider reaches the front seat; our companions must not slide into back left as the free list changes.
  for _,s in ipairs(primary.info.seats) do if s.name=='seat_front_right' then s.occupant='foreign-rider' end end
  primary.info.speed=0; tick(60)
  local at=seatsOf(primary)
  assert(at.seat_back_left==1 and at.seat_back_right==2,tostring(at.seat_back_left)..' '..tostring(at.seat_back_right))
  assert(world.foreignCalls==1,world.foreignCalls)
`));

test('a seat the plan did not name is still re-checked just before the mount: an occupant there sends the companion on',()=>run(`${foreignFixture}
  world.foreign=1; party(1)
  primary.info.speed=3; tick(10)
  assert(fleet.people[1].seat=='seat_back_left',tostring(fleet.people[1].seat))
  -- The plan was wrong (a favourite seat): the other mod's rider took back left before we sent the mount.
  for _,s in ipairs(primary.info.seats) do if s.name=='seat_back_left' then s.occupant='foreign-rider' end end
  primary.info.speed=0; tick(60)
  assert(fleet.people[1].vehicle==primary and fleet.people[1].seat=='seat_back_right',tostring(fleet.people[1].seat))
  assert(count('mount')==1 and world.mounts[1].seat=='seat_back_right')
`));

test('the hold applies to V car only: an overflow car keeps all of its passenger seats',()=>run(`${foreignFixture}
  world.foreign=3; party(5); tick(200)
  local over=seatsOf(world.spawned[1])
  assert(over.seat_front_left==1 and over.seat_front_right and over.seat_back_left and over.seat_back_right,'a full overflow car')
`));

test('a failed foreign read leaves the ordinary seat choice and is not asked again for the same boarding',()=>run(`${foreignFixture}
  world.foreignError=true; party(2); tick(40)
  assert(world.foreignCalls==1,world.foreignCalls)
  assert(fleet.people[1].seat=='seat_front_right' and fleet.people[2].seat=='seat_back_left')
  assert(fleet.foreign.error=='scan failed',tostring(fleet.foreign.error))
`));

test('an adapter without the foreign read changes nothing',()=>run(`${fixture}
  party(1); tick(30)
  assert(fleet.people[1].seat=='seat_front_right' and not fleet.foreign.error)
`));

test('a new boarding asks again, and so does a new vehicle',()=>run(`${foreignFixture}
  world.foreign=1; party(1); tick(30)
  assert(world.foreignCalls==1 and fleet.people[1].seat=='seat_back_left')
  transport.abandon(fleet); world.mounts={}
  for _,s in ipairs(primary.info.seats) do if s.name~='seat_front_left' then s.occupant=nil end end
  world.foreign=0; party(1); tick(30)
  assert(world.foreignCalls==2 and fleet.people[1].seat=='seat_front_right',tostring(fleet.people[1].seat))
`));

// ---- the wait for another mod's followers, the log lines and the exits (live check 2026-10-19: Alex, Lucy, Rita and Judy) -------
const waitFixture=`${foreignFixture}
  world.pendingCalls=0
  world.log={}
  fleet.report=function(kind,fields) world.log[#world.log+1]={kind=kind,fields=fields} end
  function api.foreignRiders(player,car)
    world.foreignCalls=world.foreignCalls+1
    local ids={} for i=1,(world.foreign or 0) do ids[i]='f'..i end
    return world.foreign or 0,{ids=ids,rows={{who='judy-alvarez',counted=true,why='follower',distance=8.2}}}
  end
  function api.foreignPending(ids) world.pendingCalls=world.pendingCalls+1; return world.walking or 0 end
  local baseMount=api.mount
  function api.mount(entry,car,seat,exit,failsafe)
    if exit and world.unmountRefused then
      local c={kind='unmount',entry=entry,car=car,seat=seat,state='Failure',failsafe=failsafe}
      world.commands[#world.commands+1]=c; return c
    end
    return baseMount(entry,car,seat,exit)
  end
  local function lines(kind) local out={} for _,l in ipairs(world.log) do if l.kind==kind then out[#out+1]=l.fields end end return out end
  local function occupy(name,id) for _,s in ipairs(primary.info.seats) do if s.name==name then s.occupant=id end end end
  local function unmounts() local n=0 for _,c in ipairs(world.commands) do if c.kind=='unmount' then n=n+1 end end return n end
`;

test('our companions send no mount command while a counted rider is still walking to the car, then board when she sat down',()=>run(`${waitFixture}
  world.foreign=1; world.walking=1; party(1); tick(30)
  assert(count('mount')==0,'no mount while she walks')
  assert(fleet.people[1].seat=='seat_back_left' and fleet.people[1].phase=='waiting-to-board',tostring(fleet.people[1].phase))
  assert(#world.spawned==0 and fleet.people[1].error and fleet.people[1].error:find('followers',1,true),tostring(fleet.people[1].error))
  assert(world.pendingCalls>=4 and world.pendingCalls<=7,'polled about twice a second: '..world.pendingCalls)
  world.walking=0; tick(10)
  assert(count('mount')==1 and fleet.people[1].phase=='riding' and world.mounts[1].seat=='seat_back_left')
  local settled=lines('settled'); assert(#settled==1 and settled[1].why=='seated',#settled)
  assert(fleet.foreign.settled)
`));

test('the wait ends after twelve seconds when a counted rider never sits down',()=>run(`${waitFixture}
  world.foreign=1; world.walking=1; party(1); tick(100)
  assert(count('mount')==0,count('mount'))
  tick(40)
  assert(count('mount')==1 and fleet.people[1].phase=='riding')
  assert(lines('settled')[1].why=='timeout')
`));

test('after the wait the seat comes from what is really occupied: a rider the plan did not expect there sends her on',()=>run(`${waitFixture}
  world.foreign=1; world.walking=1; party(1); tick(10)
  assert(fleet.people[1].seat=='seat_back_left')
  -- The other mod (or the engine) put its rider in back left, not in the front seat the plan expected.
  occupy('seat_back_left','foreign-rider'); world.walking=0; tick(40)
  assert(fleet.people[1].vehicle==primary and fleet.people[1].seat=='seat_front_right',tostring(fleet.people[1].seat))
  assert(fleet.people[1].phase=='riding')
  for _,c in ipairs(world.commands) do assert(not(c.kind=='mount' and c.seat=='seat_back_left'),'never into the occupied seat') end
`));

test('no overflow car and no seat decision for good while the other mod is still seating its riders',()=>run(`${waitFixture}
  world.foreign=3; world.walking=3; party(1); tick(60)
  assert(#world.spawned==0 and count('mount')==0 and not fleet.people[1].vehicle)
  occupy('seat_front_right','f1'); occupy('seat_back_left','f2'); occupy('seat_back_right','f3')
  world.walking=0; tick(60)
  assert(#world.spawned==1 and fleet.people[1].vehicle==world.spawned[1],'now she is the one who needs a car')
  for _,m in pairs(world.mounts) do assert(m.vehicle~='v-car') end
`));

test('with five companions and three counted riders no car is spawned during the wait, two after it',()=>run(`${waitFixture}
  world.foreign=3; world.walking=3; party(5); tick(100)
  assert(#world.spawned==0,#world.spawned)
  world.walking=0
  occupy('seat_front_right','f1'); occupy('seat_back_left','f2'); occupy('seat_back_right','f3')
  tick(300)
  assert(#world.spawned==2,#world.spawned)
  for _,m in pairs(world.mounts) do assert(m.vehicle~='v-car') end
`));

test('the boarding line says what was counted, which seats were held and where each of our companions went',()=>run(`${waitFixture}
  world.foreign=2; world.walking=2; party(2); tick(30)
  local boarding=lines('boarding'); assert(#boarding==1,#boarding)
  local b=boarding[1]
  assert(b.riders==2 and #b.held==2 and b.held[1]=='seat_back_left' and b.held[2]=='seat_front_right',table.concat(b.held,','))
  assert(b.foreign[1].who=='judy-alvarez' and b.foreign[1].counted==true)
  assert(b.people[1].name=='person-1' and b.people[1].seat=='seat_back_right' and b.people[1].car=='V')
  assert(b.people[2].seat=='none')
  assert(b.waiting==true)
`));

test('the boarding line is written even when nobody was counted, so a silent read is visible',()=>run(`${waitFixture}
  world.foreign=0; party(1); tick(20)
  local b=lines('boarding')[1]
  assert(b and b.riders==0 and #b.held==0 and b.people[1].seat=='seat_front_right')
  transport.abandon(fleet); fleet.report=nil; world.mounts={}; party(1); tick(5) -- no report hook: nothing raised
`));

test('a read that failed is named in the boarding line',()=>run(`${waitFixture}
  function api.foreignRiders() error('targeting system unavailable') end
  party(1); tick(20)
  local b=lines('boarding')[1]
  assert(b.riders==0 and b.error and b.error:find('targeting system',1,true) and b.why=='read failed',tostring(b.error))
`));

test('a companion the engine seated in V car while the fleet planned another car for her is adopted where she sits',()=>run(`${waitFixture}
  party(1)
  for i=2,4 do primary.info.seats[i].occupant='quest-npc' end
  tick(40)
  assert(#world.spawned==1 and fleet.people[1].vehicle==world.spawned[1],'planned for her own car')
  -- a seat frees up and the engine's follower AI mounts her there before our own mount does anything
  primary.info.seats[3].occupant=nil; actual(entries[1],primary,'seat_back_left')
  tick(20)
  assert(fleet.people[1].vehicle==primary and fleet.people[1].seat=='seat_back_left' and fleet.people[1].phase=='riding',tostring(fleet.people[1].phase))
  local seat=lines('seat'); assert(#seat>=1 and seat[#seat].seat=='seat_back_left' and seat[#seat].car=='V')
`));

test('V gets out while she sits in V car although another car was planned for her: her unmount is ours to run',()=>run(`${waitFixture}
  party(1)
  for i=2,4 do primary.info.seats[i].occupant='quest-npc' end
  tick(40)
  assert(fleet.people[1].vehicle==world.spawned[1])
  primary.info.seats[3].occupant=nil; actual(entries[1],primary,'seat_back_left')
  tick(1) -- board() reads the mount; the next allocate would adopt her
  world.primary=nil -- V is out before that
  tick(40)
  local first
  for _,c in ipairs(world.commands) do if c.kind=='unmount' then first=first or c end end
  assert(first and first.car==primary and first.seat=='seat_back_left',tostring(first))
  assert(not world.mounts[1],'she is out')
  local kinds={}
  for _,e in ipairs(lines('exit')) do kinds[#kinds+1]=e.decision end
  assert(table.concat(kinds,','):find('exits-from-actual-car',1,true),table.concat(kinds,','))
  assert(#lines('exit-start')==1 and lines('exit-start')[1].reason=='vehicle-change')
`));

test('an unmount the game keeps refusing is retried in rounds ten seconds apart: three plain rounds, then one failsafe round, then it stops',()=>run(`${waitFixture}
  party(1); tick(30)
  assert(fleet.people[1].phase=='riding')
  world.unmountRefused=true; world.primary=nil
  tick(90)  -- nine seconds: the first round of three attempts is used up
  assert(unmounts()==3,unmounts())
  assert(fleet.people[1].phase=='exit-failed',tostring(fleet.people[1].phase))
  tick(150)
  assert(unmounts()>=4,unmounts())
  tick(900)
  assert(unmounts()==12,'bounded: '..unmounts())
  local plain,failsafe=0,0
  for _,c in ipairs(world.commands) do
    if c.kind=='unmount' then if c.failsafe then failsafe=failsafe+1 else plain=plain+1 end end
  end
  assert(plain==9 and failsafe==3,plain..' plain, '..failsafe..' failsafe')
  local kinds={}
  for _,e in ipairs(lines('exit')) do kinds[#kinds+1]=e.decision end
  assert(table.concat(kinds,','):find('exit-failed-0',1,true) and table.concat(kinds,','):find('exit-failed-3',1,true),table.concat(kinds,','))
`));

test('when every unmount round failed the copy is moved out once, then removed, and the fleet leaves the exiting phase',()=>run(`${waitFixture}
  party(1); tick(30)
  assert(fleet.people[1].phase=='riding')
  world.unmountRefused=true; world.primary=nil
  local discards,asked=0,{}
  hooks.discard=function(entry) discards=discards+1; asked[#asked+1]=entry.serial; return true end
  tick(300)
  assert(discards==0 and (world.recoveries[1] or 0)==0,'still inside the unmount rounds: '..discards)
  tick(600)
  assert(world.recoveries[1]==1,'moved out exactly once: '..tostring(world.recoveries[1]))
  assert(discards==1 and asked[1]==1,'removal asked once: '..discards)
  assert(fleet.people[1].removing,'no further unmounts while the removal is pending')
  local before=unmounts(); tick(300)
  assert(unmounts()==before and discards==1)
  local kinds={}
  for _,e in ipairs(lines('exit')) do kinds[#kinds+1]=e.decision end
  assert(table.concat(kinds,','):find('exit-teleport-out',1,true) and table.concat(kinds,','):find('exit-discarded',1,true),table.concat(kinds,','))
  -- The owner of the copy deletes it: the person is removed and the fleet is done.
  transport.remove(fleet,1); entries[1]=nil; tick(5)
  assert(fleet.phase=='on-foot',tostring(fleet.phase))
`));

test('a removal the owner refuses is asked again ten seconds later, and a fleet without the hook just keeps its bounded retries',()=>run(`${waitFixture}
  party(1); tick(30)
  world.unmountRefused=true; world.primary=nil
  local discards=0
  hooks.discard=function(entry) discards=discards+1; return false end
  tick(1200)
  assert(discards>=3,'asked again: '..discards)
  assert(not fleet.people[1].removing)
  hooks.discard=nil
  local before=unmounts(); tick(300)
  assert(unmounts()==before,'no unmount beyond the failsafe round')
`));

test('a plain exit logs the start and each person once, never per tick',()=>run(`${waitFixture}
  party(2); tick(40)
  world.primary=nil; tick(80)
  assert(#lines('exit-start')==1)
  local starts=lines('exit-start')[1]
  assert(#starts.people==2 and starts.people[1].mounted:find('@V',1,true),tostring(starts.people[1].mounted))
  local perPerson={}
  for _,e in ipairs(lines('exit')) do perPerson[e.name]=(perPerson[e.name] or 0)+1 end
  for name,n in pairs(perPerson) do assert(n<=2,name..' logged '..n) end
`));

test('shutdown removes the overflow party cars this load owns and never V car',()=>run(`${fixture}
  party(7); tick(100)
  assert(#world.spawned==1)
  -- an occupied car is refused by the adapter and stays for the next load's sweep
  assert(transport.shutdown(fleet)==1 and #world.deleted==0 and #fleet.cars==1)
  for _,seat in ipairs(world.spawned[1].info.seats) do seat.occupant=nil end
  assert(transport.shutdown(fleet)==1 and #world.deleted==1 and world.deleted[1]=='overflow-1' and #fleet.cars==0)
  for _,id in ipairs(world.deleted) do assert(id~='v-car') end
  assert(transport.shutdown(fleet)==0)
`));

test('the first update sweeps party cars a reload left behind, once, never per frame, and never this load own cars',()=>run(`${fixture}
  local calls,known={},nil
  function api.sweepOwned(set) calls[#calls+1]=set; known=set; return 0 end
  party(8); tick(100)
  assert(#calls==1,'one sweep: '..#calls)
  assert(next(calls[1])==nil,'the first sweep ran before this load had any car')
  tick(2000); assert(#calls==1)
`));

test('the sweep asks again only while some cars were occupied or the world was not ready, a bounded number of times',()=>run(`${fixture}
  local calls=0
  function api.sweepOwned(set) calls=calls+1; return 2 end
  tick(1500); assert(calls==6,'occupied cars: '..calls)
  local fresh=transport.new(api); local waits=0
  function api.sweepOwned() waits=waits+1; if waits<4 then return nil,'Vehicle world is not ready.' end return 0 end
  for _=1,400 do transport.update(fresh,player,{},0.1,hooks) end
  assert(waits==4,'not ready, then done: '..waits)
`));

test('the sweep skips the cars this load owns and stops after a save teardown',()=>run(`${fixture}
  local seen={}
  function api.sweepOwned(set) seen[#seen+1]=set; return 2 end
  party(8); tick(100)
  tick(120)
  local last=seen[#seen]
  assert(#seen>=2 and last['overflow-1'] and last['v-car'],'known cars are passed')
  transport.abandon(fleet); local n=#seen; tick(1500); assert(#seen==n)
`));

test('native sweep deletes only tagged managed party cars that are empty, counting the skipped ones',()=>run(`${nativeFixture}
  local tagged={a=true,b=true,c=true,d=true,e=false}
  local entities={a={},b={},c={},d={}}
  entities.b.IsPlayerMounted=function() return true end
  entities.b.HasPassengers=function() return false end
  entities.c.IsPlayerMounted=function() return false end
  entities.c.HasPassengers=function() return true end
  for _,k in ipairs({'a','d'}) do
    entities[k].IsPlayerMounted=function() return false end
    entities[k].HasPassengers=function() return false end
  end
  local deleted={}
  system.GetTaggedIDs=function() return {{hash='a'},{hash='b'},{hash='c'},{hash='d'},{hash='e'},{hash='f'}} end
  system.IsManaged=function(_,e) return e.hash~='f' end
  system.IsTagged=function(_,e) return tagged[e.hash]==true end
  system.DeleteEntity=function(_,e) deleted[#deleted+1]=e.hash; return true end
  Game.FindEntityByID=function(e) return entities[e.hash] end
  local left=adapter.sweepOwned({d=true})
  table.sort(deleted)
  assert(table.concat(deleted,',')=='a','only the empty tagged unknown car: '..table.concat(deleted,','))
  assert(left==2,'V car and the occupied car are skipped: '..tostring(left))
  system.IsReady=function() return false end
  local none,why=adapter.sweepOwned(); assert(none==nil and why)
`));
