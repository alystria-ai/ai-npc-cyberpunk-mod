import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
function run(body) {
  const state=lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program=adapter+companionEngine+setup+body;
  const status=lauxlib.luaL_dostring(state,to_luastring(program));
  const error=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  const line=Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state);
  assert.equal(status,lua.LUA_OK,error+(line?'\n'+program.split('\n')[line-1]:''));
}

// Use real companion, equipment, actuator and native AIMount adapter code.
// Only the world car and physical mount observation are delayed boundaries.
const adapter=`
local selected,mounts=nil,{}
local primary={id='owned-player-car',entityID={hash='owned-player-car'},owned=false}
companionVehicleAdapter=function(api)
  api.player=function() return selected end
  api.inspect=function() return {ready=true,speed=0,playerGap=3,seats={
    {name='seat_front_left',occupant='player'},{name='seat_front_right'}}} end
  return api
end
`;
const setup=`
EntityID={new=function() return {hash='0ULL'} end}
Game.GetMountingFacility=function() return {GetMountingInfoSingleWithObjects=function(_,npc)
  local mount=mounts[npc:GetEntityID().hash]
  return mount and {parentId={hash=mount.vehicle},slotId={id=mount.seat}} or nil
end} end
PlayerPuppet={GetSceneTier=function() return 1 end,GetCurrentVehicleState=function() return 'Driving' end}
function player:IsDeadNoStatPool() return false end
function player:IsInCombat() return false end
local function update(count,focus)
  for _=1,count or 1 do companions.update(player,0.1,focus) end
end
local function equip(npc)
  npc.weapon={GetItemID=function() return {hash='gun',record='Items.Chao'} end}
  function npc:IsOnAutonomousAI() return true end
  function npc:GetPuppetStateBlackboard() return {GetInt=function() return 'Normal' end} end
  ItemID={IsValid=function() return true end,GetCombinedHash=function(id) return id.hash end,
    GetTDBID=function(id) return id.record end}
  WeaponObject={IsFists=function() return false end}
  ScriptedPuppet={GetWeaponRight=function(actor) return actor.weapon end,GetWeaponLeft=function() return nil end}
  TargetTrackingExtension={HasHostileThreat=function() return false end}
  Game.GetAllBlackboardDefs=function() return {PuppetState={UpperBody='UpperBody'}} end
  Game.GetSceneSystem=function() return {GetScriptInterface=function() return {
    IsEntityInScene=function() return false end,IsEntityInDialogue=function() return false end} end} end
end
`;

test('transport immediately removes standing foot and gaze ownership while a delayed equipment cancellation settles',()=>run(`
local npc=spawn(); update(20)
equip(npc); update(32)
local holster=last(npc,'AIUnequipCommand'); assert(holster and holster.state=='Executing')
update(4,npc.id.hash)
assert(next(npc.looks),'Standing gaze was not established')
local originalStop=npc.ai.StopExecutingCommand; local stops=0
npc.ai.StopExecutingCommand=function(self,command)
  if command==holster then stops=stops+1 else originalStop(self,command) end
end
selected=primary; update(2,npc.id.hash)
assert(stops==1 and holster.state=='Executing' and not last(npc,'AIMountCommand'))
assert(not next(npc.looks),'Standing gaze survived transport acquisition')
for _,command in ipairs(active(npc)) do
  assert(command==holster,'Foot or social-turn command survived transport acquisition')
end
local people=companions.list()
assert(people[1].transport.owned and people[1].equipment.phase=='cancelling')
update(15,npc.id.hash)
assert(not next(npc.looks) and not last(npc,'AIMountCommand') and stops==1)
holster.state='Cancelled'; update(3,npc.id.hash)
local boarding=last(npc,'AIMountCommand'); assert(boarding and boarding.state=='Executing')
assert(boarding.mountData.mountParentEntityId==primary.entityID and boarding.mountData.slotName=='seat_front_right')
assert(not boarding.mountData.isInstant and not boarding.mountData.allowFailsafeTeleport)
assert(#active(npc)==1 and active(npc)[1]==boarding and not next(npc.looks))
update(10,npc.id.hash)
assert(#active(npc)==1 and active(npc)[1]==boarding and not next(npc.looks),
  'Approach was interrupted by a new standing look or movement owner')
`));

test('transport reports Alerted entry refusal then submits one exact animated mount as soon as the native blocker clears',()=>run(`
local npc=spawn(); npc.hls='Alerted'
selected=primary; update(10,npc.id.hash)
assert(not last(npc,'AIMountCommand') and not next(npc.looks))
assert(companions.list()[1].transport.error=='Waiting for your companion to settle before boarding.')
npc.hls='Relaxed'; update(2,npc.id.hash)
local boarding=last(npc,'AIMountCommand'); assert(boarding and boarding.state=='Executing')
assert(#active(npc)==1 and active(npc)[1]==boarding)
assert(boarding.mountData.mountParentEntityId==primary.entityID and not boarding.mountData.ignoreHLS)
update(5,npc.id.hash)
assert(#active(npc)==1 and active(npc)[1]==boarding and not next(npc.looks))
`));
