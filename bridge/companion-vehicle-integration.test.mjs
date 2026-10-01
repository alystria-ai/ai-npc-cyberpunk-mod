import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
function run(body) {
  const state=lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program=fixture+companionEngine+setup+body;
  const status=lauxlib.luaL_dostring(state,to_luastring(program));
  const error=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  const line=Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state); assert.equal(status,lua.LUA_OK,error+(line?'\n'+program.split('\n')[line-1]:''));
}

const fixture=`
local cars,selected,mounts,carSequence,deletions={},nil,{},0,0
local playerVehicleState,playerMountVisible='Driving',true
EntityID={new=function() return {hash='0ULL'} end}
local function car(id,owned)
  local value={id=id,entityID={hash=id},owned=owned,ordinal=1,record='Vehicle.test',name='Test car',followAttempts=0}
  value.entity={id=value.entityID,ai={commands={}},attached=true}
  function value.entity:IsAttached() return self.attached end
  function value.entity:GetAIComponent() return self.ai end
  function value.entity:GetEntityID() return self.id end
  function value.entity:GetLinearVelocity() return {x=value.speed or 0,y=0,z=0} end
  function value.entity:IsPlayerMounted() return selected==value end
  function value.entity.ai:SendCommand(cmd) cmd.id=#self.commands+1; cmd.state='Executing'; self.commands[#self.commands+1]=cmd end
  function value.entity.ai:GetCommandState(cmd) return cmd.state end
  function value.entity.ai:StopExecutingCommand(cmd) cmd.state='Cancelled' end
  function value.entity.ai:CancelCommand(cmd) cmd.state='Cancelled' end
  function value.entity.ai:IsCommandActive(id)
    for _,cmd in ipairs(self.commands) do if cmd.id==id then return cmd.state=='Executing' or cmd.state=='NotExecuting' end end
    return false
  end
  function value.entity.ai:GetEnqueuedOrExecutingCommand(kind)
    for _,cmd in ipairs(self.commands) do if cmd.kind==kind and self:IsCommandActive(cmd.id) then return cmd end end
  end
  cars[id]=value; return value
end
companionVehicleAdapter=function(api)
  api.player=function() return selected end
  api.inspect=function(value)
    local current=cars[value.id]
    if not current then return {ready=false} end
    value.entity=current.entity
    local seats={}
    for _,name in ipairs({'seat_front_left','seat_front_right'}) do
      local occupant=name=='seat_front_left' and selected==current and 'player' or nil
      for id,mount in pairs(mounts) do if mount.vehicle==current.id and mount.seat==name then occupant=id end end
      seats[#seats+1]={name=name,occupant=occupant}
    end
    return {ready=true,seats=seats,speed=0,playerGap=5,playerMounted=selected==current}
  end
  api.spawn=function(choice,primary,ordinal)
    carSequence=carSequence+1
    local value=car('car-'..carSequence,true); value.system=Game.GetDynamicEntitySystem(); return value
  end
  api.brake=function(value) return value.owned and selected~=cars[value.id] end
  api.destroy=function(value)
    if not value.owned or selected==cars[value.id] then return false end
    for _,mount in pairs(mounts) do if mount.vehicle==value.id then return false end end
    cars[value.id]=nil; deletions=deletions+1; return true
  end
  return api
end
`;

const setup=`
local primary=car('v-car',false)
local ordinaryCreate=system.CreateEntity
function system:CreateEntity(spec)
  local id=ordinaryCreate(self,spec)
  local npc=self:GetEntity(id)
  npc.ai.onSend=function(command)
    if command.kind=='AIMountCommand' then
      mounts[npc.id.hash]={vehicle=command.mountData.mountParentEntityId.hash,seat=command.mountData.slotName}
      command.state='Success'
    elseif command.kind=='AIUnmountCommand' then mounts[npc.id.hash]=nil; command.state='Success' end
  end
  return id
end
local ordinaryManaged,ordinaryEntity,ordinaryTagged=system.IsManaged,system.GetEntity,system.IsTagged
function system:IsManaged(id) return cars[id.hash] and cars[id.hash].owned or ordinaryManaged(self,id) end
function system:IsTagged(id,tag)
  if cars[id.hash] then return cars[id.hash].owned and tag=='CyberpunkConvaiPartyVehicle' end
  return ordinaryTagged(self,id,tag)
end
function system:GetEntity(id) return cars[id.hash] and cars[id.hash].entity or ordinaryEntity(self,id) end
Game.FindEntityByID=function(id) return system:GetEntity(id) end
Game.GetMountingFacility=function() return {GetMountingInfoSingleWithObjects=function(_,npc)
  if npc==player then
    return selected and playerMountVisible and {parentId=selected.entityID,slotId={id='seat_front_left'}} or nil
  end
  local mount=mounts[npc:GetEntityID().hash]
  return mount and {parentId={hash=mount.vehicle},slotId={id=mount.seat}} or nil
end} end
Quaternion={ToEulerAngles=function() return {} end}
PlayerPuppet={GetCurrentVehicleState=function() return playerVehicleState end}
function player:IsInCombat() return self.combat or false end
Game.GetTeleportationFacility=function() return {Teleport=function(_,npc,position) npc.pos=position end} end
local function update(count,focus)
  for _=1,count or 1 do companions.update(player,0.1,focus) end
end
local function row(serial)
  for _,value in ipairs(companions.list()) do if value.serial==serial then return value end end
end
`;

test('real companion handoff releases walking while riding and renews equipment when walking resumes',()=>run(`
local npc=spawn(); local saved=companions.list()[1].serial
local movement=active(npc)[1]; local oldGet=npc.ai.GetCommandState; local walkingReads=0
npc.ai.GetCommandState=function(self,command)
  if command==movement then walkingReads=walkingReads+1 end
  return oldGet(self,command)
end
selected=primary; update(4)
assert(row(saved).transport.phase=='riding' and mounts[npc.id.hash])
local reads=walkingReads; local commands=#npc.ai.commands
update(25)
assert(walkingReads==reads and #npc.ai.commands==commands,'walking touched the transport-owned actor')
selected=nil; update(30)
assert(not row(saved).transport and not mounts[npc.id.hash])
assert(row(saved).equipment.phase~='released','walking resumed with a permanently released equipment controller')
assert(#active(npc)==1 and active(npc)[1].kind~='AIMountCommand')
`));

test('a passenger in the actual same car responds to focus without any walking command or walking query',()=>run(`
local npc=spawn(); local serial=companions.list()[1].serial
selected=primary; update(12,npc.id.hash)
assert(row(serial).transport.phase=='riding' and mounts[npc.id.hash])
local look=next(npc.looks)
assert(look and look.parts[1].weight==0.18 and #look.parts==1,'Seated passenger did not use a head-only look')
local commands=#npc.ai.commands
npc.ai.GetCommandState=function() error('Seated attention queried a walking command') end
npc.ai.SendCommand=function() error('Seated attention submitted a walking command') end
primary.speed=15; update(20,npc.id.hash)
assert(next(npc.looks)==look and #npc.ai.commands==commands and not row(serial).error)
companions.gazeSettings=function() return {eyeContactHeight=0.05,headFollowStrength=0.5} end
update(2,npc.id.hash)
local adjusted=next(npc.looks)
assert(adjusted and adjusted~=look and not npc.looks[look] and #adjusted.parts==1)
assert(adjusted.targetPositionProvider.worldOffset.z==0.05 and #npc.ai.commands==commands)
update(2); assert(not next(npc.looks))
`));

test('seated attention releases for combat, player transitions, missing actual mounts and a foreign car',()=>run(`
local npc=spawn(); local serial=companions.list()[1].serial
selected=primary; update(12,npc.id.hash); assert(next(npc.looks))
local commands=#npc.ai.commands
npc.combat=true; update(1,npc.id.hash); assert(not next(npc.looks))
npc.combat=false; update(8,npc.id.hash); assert(next(npc.looks))
player.combat=true; update(1,npc.id.hash); assert(not next(npc.looks))
player.combat=false; update(8,npc.id.hash); assert(next(npc.looks))
playerVehicleState='Transition'; update(1,npc.id.hash); assert(not next(npc.looks))
playerVehicleState='Driving'; update(8,npc.id.hash); assert(next(npc.looks))
playerMountVisible=false; update(1,npc.id.hash); assert(not next(npc.looks))
playerMountVisible=true; update(8,npc.id.hash); assert(next(npc.looks))
local original=mounts[npc.id.hash]
mounts[npc.id.hash]={vehicle='another-car',seat='seat_front_right'}
update(1,npc.id.hash); assert(not next(npc.looks))
assert(#npc.ai.commands==commands,'Look release added a locomotion command')
mounts[npc.id.hash]=original; update(8,npc.id.hash); assert(next(npc.looks))
assert(companions.beginFastTravel()); assert(not next(npc.looks),'Fast travel retained seated look')
`));

test('a mount link while the boarding command still executes cannot start seated attention',()=>run(`
local npc=spawn(); local send=npc.ai.onSend
npc.ai.onSend=function(command)
  send(command)
  if command.kind=='AIMountCommand' then command.state='Executing' end
end
selected=primary; update(20,npc.id.hash)
assert(mounts[npc.id.hash] and companions.list()[1].transport.phase=='boarding')
assert(not next(npc.looks),'Low level mount was mistaken for completed boarding')
last(npc,'AIMountCommand').state='Success'; update(8,npc.id.hash)
assert(next(npc.looks))
`));

test('a refused seated-look release retains its owner and delays the walking resume handoff',()=>run(`
local npc=spawn(); local serial=companions.list()[1].serial
selected=primary; update(12,npc.id.hash)
local owned=next(npc.looks); assert(owned)
local originalRemove=LookAtRemoveEvent.QueueRemoveLookatEvent
local blocked,attempts=true,0
LookAtRemoveEvent.QueueRemoveLookatEvent=function(actor,event)
  assert(actor==npc and event==owned); attempts=attempts+1
  if blocked then return false end
  return originalRemove(actor,event)
end
selected=nil; update(20,npc.id.hash)
assert(not mounts[npc.id.hash] and row(serial).transport.owned and npc.looks[owned])
assert(attempts==1 and #active(npc)==0,'Resume lost its exact look owner or submitted walking too early')
blocked=false; update(20)
assert(not row(serial).transport and not npc.looks[owned] and attempts==2)
assert(#active(npc)==1 and active(npc)[1].kind~='AIMountCommand')
`));

test('an unreadable seated native state removes existing attention instead of trusting a stale riding phase',()=>run(`
local npc=spawn(); selected=primary; update(12,npc.id.hash)
assert(next(npc.looks))
PlayerPuppet.GetCurrentVehicleState=function() error('native state temporarily unavailable') end
update(1,npc.id.hash)
assert(not next(npc.looks) and companions.list()[1].seatedAttention.error)
assert(companions.list()[1].transport.phase=='riding')
local nativeCalls=0
npc.IsAttached=function() nativeCalls=nativeCalls+1; error('world detached') end
companions.abandon()
assert(nativeCalls==0 and #companions.list()==0)
`));

test('the integration honors equipment release phase and waits for a delayed holster before mounting',()=>run(`
local npc=spawn(); update(20)
npc.weapon={GetItemID=function() return {hash='gun',record='Items.Chao'} end}
function player:IsDeadNoStatPool() return false end
function player:IsInCombat() return false end
function npc:IsOnAutonomousAI() return true end
function npc:GetHighLevelStateFromBlackboard() return 'Relaxed' end
function npc:GetPuppetStateBlackboard() return {GetInt=function() return 'Normal' end} end
ItemID={IsValid=function() return true end,GetCombinedHash=function(id) return id.hash end,GetTDBID=function(id) return id.record end}
WeaponObject={IsFists=function() return false end}
ScriptedPuppet={GetWeaponRight=function(actor) return actor.weapon end,GetWeaponLeft=function() return nil end}
PlayerPuppet={GetSceneTier=function() return 1 end}
TargetTrackingExtension={HasHostileThreat=function() return false end}
Game.GetAllBlackboardDefs=function() return {PuppetState={UpperBody='UpperBody'}} end
Game.GetSceneSystem=function() return {GetScriptInterface=function() return {
 IsEntityInScene=function() return false end,IsEntityInDialogue=function() return false end} end} end
update(32)
local holster=last(npc,'AIUnequipCommand'); assert(holster and holster.state=='Executing')
local originalStop=npc.ai.StopExecutingCommand; local stops=0
npc.ai.StopExecutingCommand=function(self,command)
 if command==holster then stops=stops+1 else originalStop(self,command) end
end
selected=primary; update(20)
assert(stops==1 and not last(npc,'AIMountCommand') and not mounts[npc.id.hash])
assert(companions.list()[1].equipment.phase=='cancelling')
holster.state='Cancelled'; update(6)
assert(mounts[npc.id.hash] and companions.list()[1].transport.phase=='riding')
assert(stops==1 and companions.list()[1].equipment.phase=='released')
`));

test('delayed actor deletion keeps the fleet owner and services cars after the last dismissal',()=>run(`
local one,two=spawn(),spawn('panam-palmer')
selected=primary; update(15)
assert(carSequence==1 and #companions.vehicleSnapshot().cars==1)
local pending={}; local ordinaryDelete=system.DeleteEntity
system.DeleteEntity=function(_,id) pending[id.hash]=true; return true end
local list=companions.list()
assert(companions.dismiss(list[2].serial)); assert(companions.dismiss(list[1].serial))
assert(#companions.list()==2 and #companions.vehicleSnapshot().people==2)
update(5); assert(#companions.list()==2 and deletions==0)
for id in pairs(pending) do ordinaryDelete(system,{hash=id}); mounts[id]=nil end
update(60)
assert(#companions.list()==0 and #companions.vehicleSnapshot().people==0)
assert(#companions.vehicleSnapshot().cars==0 and deletions==1,'empty fleet stopped servicing after final dismissal')
assert(cars['v-car'],'borrowed V car was deleted')
`));

test('fast travel reacquires living copies and preserves model/profile/serial while retiring old command IDs',()=>run(`
local npc=spawn(); local serial=companions.list()[1].serial
companions.setProfile(serial,'panam-palmer','Panam')
local old=active(npc)[1]; local stops=0
npc.ai.StopExecutingCommand=function(_,command) assert(command==old); stops=stops+1 end
assert(companions.beginFastTravel()); assert(stops==1 and row(serial).state=='transit')
local oldPosition=npc.pos; player.pos=Vector4.new(500,700,8)
assert(companions.fastTravel()); update(5)
assert(row(serial).state=='transit' and #npc.ai.commands==1 and npc.pos==oldPosition)
old.state='Cancelled'; update(5)
local current=row(serial)
assert(sequence==1 and current.state=='ready' and current.serial==serial)
assert(current.key=='judy-alvarez' and current.profileKey=='panam-palmer')
assert(math.abs(npc.pos.z-8.1)<0.001 and math.abs(npc.pos.x-player.pos.x)<6)
assert(stops==1 and #active(npc)==1,'native cancellation was repeated or walking overlapped its old owner')
`));

test('fast travel drops stale actors and convoy handles, then unmounts current copies before safe relocation',()=>run(`
local one,two=spawn(),spawn('panam-palmer')
selected=primary; update(15); assert(carSequence==1)
assert(companions.beginFastTravel())
for index,old in ipairs({one,two}) do
 local fresh={}; for key,value in pairs(old) do fresh[key]=value end
 local currentAI={}; for key,value in pairs(old.ai) do currentAI[key]=value end
 fresh.ai=currentAI; entities[index]=fresh
 old.IsAttached=function() error('stale NPC handle') end
 old.GetAIControllerComponent=function() error('stale AI owner') end
end
selected=nil; player.pos=Vector4.new(900,120,3)
companions.abandon(true); assert(companions.fastTravel()); update(80)
assert(#companions.list()==2 and sequence==2 and #companions.vehicleSnapshot().cars==0 and deletions==1)
for _,npc in pairs(entities) do
 assert(not mounts[npc.id.hash] and math.abs(npc.pos.z-3.1)<.001)
 assert(math.abs(npc.pos.x-player.pos.x)<6 and #active(npc)==1)
end
assert(cars['v-car'],'borrowed vehicle was modified by cleanup')
`));

test('lost fast travel copies use private floor-safe admission and ordinary save abandonment cannot restore them',()=>run(`
local one,two=spawn(),spawn(); local list=companions.list()
companions.setProfile(list[1].serial,'panam-palmer','Panam')
companions.canSpawn=function() return false,'Invitation required' end
assert(companions.beginFastTravel()); companions.abandon(true)
entities[1],entities[2]=nil,nil
player.pos=Vector4.new(100,200,15)
assert(companions.fastTravel()); update(8)
assert(sequence==4 and #companions.list()==2)
local current=companions.list()
assert(current[1].serial==list[1].serial and current[2].serial==list[2].serial)
assert(current[1].profileKey=='panam-palmer' and current[2].profileKey=='judy-alvarez')
assert(current[1].key=='judy-alvarez' and math.abs(current[1].spawnZ-15.1)<0.001 and math.abs(current[2].spawnZ-15.1)<0.001)
assert(not companions.spawn('judy-alvarez'),'private return bypass leaked into public invitations')
assert(companions.beginFastTravel())
local nativeCalls=0; local oldGame=Game
Game=setmetatable({}, {__index=function() nativeCalls=nativeCalls+1; error('world is unloading') end})
companions.abandon(); assert(nativeCalls==0 and #companions.list()==0)
Game=oldGame; assert(not companions.fastTravel()); update(20)
assert(sequence==4 and #companions.list()==0,'ordinary load restored saved party intent')
`));

test('failed destination placement stays bounded without creating a copy on another floor',()=>run(`
spawn(); local serial=companions.list()[1].serial
assert(companions.beginFastTravel()); entities[1]=nil
local probes=0
Game.GetAINavigationSystem=function() return {FindPointInSphereForCharacter=function()
  probes=probes+1; return {status='FAIL'} end} end
player.pos=Vector4.new(500,700,50); assert(companions.fastTravel()); update(130)
local attempts=probes; update(100)
assert(sequence==1 and row(serial).state=='failed' and probes==attempts and row(serial).error)
`));

test('changed ownership during fast travel prevents reacquisition and dismissal from mutating the other actor',()=>run(`
local npc=spawn(); local serial=companions.list()[1].serial
assert(companions.beginFastTravel())
local deletes,roleChanges=0,0
system.IsTagged=function() return false end
system.DeleteEntity=function() deletes=deletes+1; return true end
npc.ai.SetAIRole=function() roleChanges=roleChanges+1 end
assert(companions.fastTravel()); update(2)
assert(row(serial).state=='failed' and row(serial).error)
assert(not companions.dismiss(serial))
assert(deletes==0 and roleChanges==0 and sequence==1,'ownership mismatch altered another actor')
`));
