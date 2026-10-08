import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
function run(code) {
  const state=lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status=lauxlib.luaL_dostring(state,to_luastring(code));
  const error=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  lua.lua_close(state); assert.equal(status,lua.LUA_OK,error);
}

// Doors, lifts and fast travel (mod/companion-passage.lua, recoverDistant).
// Live case 2026-10-08: after fast travel to V's building Judy stood 25 m back
// behind a closed automatic door for 60 s while V waited in the lift car, and
// was only teleported up 12 s after a ride she could not join.
const world=`${companionEngine}
  local logs={}
  companions.recoveryLog=function(kind,fields) logs[#logs+1]={kind=kind,fields=fields} end
  local function logged(kind,rule)
    for _,item in ipairs(logs) do
      if item.kind==kind and (not rule or item.fields.rule==rule) then return item end
    end
  end
  -- Failure context: the recovery decisions logged so far and the copy's state.
  local function dump()
    local t={}
    for _,l in ipairs(logs) do t[#t+1]=l.kind..'/'..tostring(l.fields.rule or l.fields.reason or l.fields.result)..'/'..tostring(l.fields.gap) end
    local row=companions.movementSnapshot().copies[1]
    return ' ['..table.concat(t,'; ')..'] pos='..NPC.pos.x..','..NPC.pos.y..','..NPC.pos.z..' phase='..tostring(row and row.brain.phase)..' stage='..tostring(row and row.command.stage)
  end
  -- V's PlayerStateMachine lift flags.
  local lift={inside=false,moving=false}
  Game.GetAllBlackboardDefs=function() return {PlayerStateMachine={
    IsPlayerInsideElevator='inside',IsPlayerInsideMovingElevator='moving'}} end
  Game.GetBlackboardSystem=function() return {GetLocalInstanced=function()
    return {GetBool=function(_,id) return lift[id] end} end} end
  -- Door devices found by the targeting query.
  local doors,queries,queued={},0,0
  TargetSearchQuery={new=function() return {} end}; TargetingSet={Complete='Complete'}
  local function door(y,options)
    options=options or {}
    local d={y=y,open=false,locked=options.locked==true,lift=options.lift==true}
    local ps={IsOpen=function() return d.open end,IsLocked=function() return d.locked end,
      IsSealed=function() return false end,IsLiftDoor=function() return d.lift end,
      ActionToggleOpen=function() return {door=d,SetExecutor=function(self,who) self.executor=who end} end}
    d.entity={whoOpened=options.byV~=false and player or nil,
      IsA=function(_,kind) return kind=='Door' end,
      GetEntityID=function() return {hash='door'..y} end,
      GetWorldPosition=function() return Vector4.new(0,y,1) end,
      GetDevicePS=function() return ps end}
    doors[#doors+1]=d
    return d
  end
  Game.GetTargetingSystem=function() return {
    GetCrosshairData=function() return nil,player.forward end,
    GetTargetParts=function()
      queries=queries+1
      local parts={}
      for _,d in ipairs(doors) do
        parts[#parts+1]={GetComponent=function() return {GetEntity=function() return d.entity end} end}
      end
      return true,parts
    end} end
  Game.GetPersistencySystem=function() return {QueuePSDeviceEvent=function(_,action)
    queued=queued+1; action.door.open=true end} end
  -- Navigation: a closed door between two points has no route through it.
  local navigation=Game.GetAINavigationSystem()
  local calculate=navigation.CalculatePathForCharacter
  local walkable=function() return true end
  navigation.CalculatePathForCharacter=function(self,from,to,...)
    for _,d in ipairs(doors) do
      if not d.open and (from.y-d.y)*(to.y-d.y)<0 then return nil end
    end
    return calculate(self,from,to,...)
  end
  local find=navigation.FindPointInSphereForCharacter
  navigation.FindPointInSphereForCharacter=function(self,position,radius,...)
    if walkable(position) then return find(self,position,radius,...) end
    return {status='Failed'}
  end
  Game.GetAINavigationSystem=function() return navigation end
  local spatial=Game.GetSpatialQueriesSystem()
  local sight=true
  Game.GetSpatialQueriesSystem=function() return {Overlap=spatial.Overlap,
    SyncRaycastByCollisionGroup=function() return not sight end} end
  local npc=spawn(); tick(4); NPC=npc
  local teleports={}
  npc.ai.onSend=function(cmd)
    if cmd.kind=='AITeleportCommand' then
      teleports[#teleports+1]={spot=cmd.position,from=Vector4.new(player.pos.x,player.pos.y,player.pos.z)}
      npc.pos=cmd.position; cmd.state='Success'
    end
  end
  -- Ordinary walking: an owned route moves the copy toward its goal.
  local space=dofile('companion-space.lua')
  local function walk(step)
    local command=active(npc)[1]
    if command and (command.kind=='AIFollowTargetCommand' or command.kind=='AIMoveToCommand') then
      local goal=command.kind=='AIMoveToCommand' and command.movementTarget.position or player.pos
      if space.ground(npc.pos,goal)>.3 then
        local moved=space.offset(npc.pos,space.bearing(npc.pos,goal),0,step or .6)
        -- A closed door is solid: nobody walks through it.
        for _,d in ipairs(doors) do
          if not d.open and (npc.pos.y-d.y)*(moved.y-d.y)<=0 then moved=npc.pos end
        end
        npc.pos=Vector4.new(moved.x,moved.y,npc.pos.z)
      end
    end
  end
  local function play(count,step)
    for i=1,count do walk(step); companions.update(player,.5); walk(step) end
    for _,row in ipairs(companions.list()) do assert(not row.error,row.error) end
  end
`;

test('a closed door V walked through is opened for the follower, who then walks through it',()=>run(world+`
  -- V walked north through this automatic door; it has closed behind V.
  local front=door(3)
  for i=1,12 do player.pos=Vector4.new(0,i*1.2,0); play(1) end
  player.forward=Vector4.new(0,1)
  play(16)
  assert(queued>=1,'the door V used was never opened for the follower')
  assert(logged('door') and logged('door').fields.result=='opened','no probe line for the door decision')
  assert(#teleports==0,'the follower was teleported although the opened door gave her a route'..dump())
  assert(npc.pos.y>front.y,'the follower never walked through the opened door')
`));

test('a locked door is never opened; the follower rejoins out of view within seconds',()=>run(world+`
  local front=door(3,{locked=true})
  front.open=false
  for i=1,12 do player.pos=Vector4.new(0,i*1.2,0); play(1) end
  player.forward=Vector4.new(0,1)
  play(14)
  assert(queued==0,'a locked door was opened')
  assert(logged('door-none'),'no probe line when no door could be opened')
  assert(#teleports>=1,'a follower behind a locked door stayed stranded')
  local item=teleports[1]
  assert(item.spot.y>front.y and item.spot.y<item.from.y,'the follower did not rejoin just behind V')
  assert(logged('relocated','no-route'),'no probe line for the relocation decision')
`));

test('a door V never opened is left alone',()=>run(world+`
  local side=door(3,{byV=false})
  for i=1,12 do player.pos=Vector4.new(0,i*1.2,0); play(1) end
  player.forward=Vector4.new(0,1)
  play(10)
  assert(queued==0,'a door V never used was opened')
  assert(not side.open)
`));

test('door searches stay throttled while a follower waits',()=>run(world+`
  door(3,{locked=true})
  for i=1,12 do player.pos=Vector4.new(0,i*1.2,0); play(1) end
  -- V keeps watching her: no teleport, so the wait lasts.
  player.forward=Vector4.new(0,-1)
  local before=queries
  play(20)
  assert(queries-before<=6,'door searches ran '..(queries-before)..' times in 10 s')
`));

const ride=`
  -- V steps into the car at (0,6) and rides 40 m up; nothing carries the copy.
  for i=1,6 do player.pos=Vector4.new(0,i,0); play(1) end
  lift.inside=true; play(2)
  lift.moving=true
  for i=1,10 do player.pos=Vector4.new(0,6,i*4); play(1) end
`;

test('no teleport happens during a lift ride; the left-behind follower rejoins at arrival',()=>run(world+ride+`
  assert(#teleports==0,'a follower was teleported while the car was still moving')
  lift.moving=false; play(1)
  lift.inside=false; player.pos=Vector4.new(0,8,40); player.forward=Vector4.new(0,1); play(4)
  assert(#teleports>=1,'the follower stayed on the old floor after the lift arrived')
  local spot=teleports[1].spot
  assert(math.abs(spot.z-40)<1,'the follower was not placed on the new floor of V')
  assert(logged('lift-arrived'),'no probe line for the lift arrival')
  assert(logged('relocated','lift-arrival'),'the relocation was not logged as a lift arrival')
`));

test('a follower standing in the car with V is brought along at arrival even in view',()=>run(world+`
  for i=1,6 do player.pos=Vector4.new(0,i,0); play(1) end
  lift.inside=true; npc.pos=Vector4.new(.8,6,0); play(2)
  lift.moving=true
  for i=1,10 do player.pos=Vector4.new(0,6,i*4); play(1) end
  assert(logged('lift-departed') and logged('lift-departed').fields.withV==true,'the ride did not record her in the car'..dump())
  lift.moving=false
  player.forward=Vector4.new(0,-1)
  play(2)
  assert(#teleports>=1,'a companion who stood in the car with V was left on the old floor')
  assert(math.abs(teleports[1].spot.z-40)<1)
`));

test('a follower the car carried along is not teleported',()=>run(world+`
  for i=1,6 do player.pos=Vector4.new(0,i,0); play(1) end
  lift.inside=true; npc.pos=Vector4.new(.8,6,0); play(2)
  lift.moving=true
  for i=1,10 do player.pos=Vector4.new(0,6,i*4); npc.pos=Vector4.new(.8,6,i*4); play(1) end
  lift.moving=false; play(2); lift.inside=false; play(6)
  assert(#teleports==0,'a companion who rode along was teleported')
`));

test('V waiting in a stopped car pulls a blocked follower into the car',()=>run(world+`
  local front=door(3,{locked=true})
  for i=1,10 do player.pos=Vector4.new(0,i,0); play(1) end
  lift.inside=true
  player.forward=Vector4.new(0,-1) -- V faces the car doors, back toward her
  play(8)
  assert(#teleports>=1,'V waited in the car while the follower stayed outside'..dump())
  local item=teleports[1]
  assert(math.sqrt((item.spot.x-player.pos.x)^2+(item.spot.y-player.pos.y)^2)<=1.9,'she was not placed in the car beside V')
  assert(logged('relocated','lift-board'))
`));

test("V standing off the navmesh still gets the follower back from the trail V walked",()=>run(world+`
  -- Recorded case: V in a lift car with no walkable floor; Judy 25 m back
  -- behind a door. Spots around V fail, the lobby V crossed does not.
  local front=door(3,{locked=true})
  walkable=function(position) return position.y<23.6 end
  for i=1,25 do player.pos=Vector4.new(0,i,0); play(1) end
  player.forward=Vector4.new(0,1)
  play(16)
  assert(#teleports>=1,'a follower stayed stranded while V stood off the navmesh'..dump())
  local spot=teleports[1].spot
  assert(spot.y<23.6 and spot.y>front.y,'she was not placed on the ground V walked')
  assert(math.sqrt((spot.x-player.pos.x)^2+(spot.y-player.pos.y)^2)<15)
`));

test('stairs climbed in progress are left alone; a follower stalled a floor below rejoins',()=>run(world+`
  -- V is 6 m up; while she keeps moving nothing happens.
  player.pos=Vector4.new(0,10,6); player.forward=Vector4.new(0,1)
  for i=1,6 do npc.pos=Vector4.new(0,npc.pos.y+1.2,npc.pos.z+.4); play(1,0) end
  assert(#teleports==0,'a companion climbing toward V was teleported')
  -- Now she stops making progress on the floor below.
  play(16,0)
  assert(#teleports>=1,'a follower stalled on another floor never rejoined'..dump())
  assert(logged('relocated','floor-change'))
`));

test('after fast travel the party is re-acquired and placed near V once the world is ready',()=>run(world+`
  Game.GetTeleportationFacility=function() return {Teleport=function(_,who,at) who.pos=at end} end
  assert(companions.beginFastTravel())
  player.pos=Vector4.new(400,0,0); player.forward=Vector4.new(0,1)
  assert(companions.fastTravel())
  play(8)
  assert(logged('fast-travel-reacquired'),'no probe line for re-acquiring the party after fast travel')
  assert(math.sqrt((npc.pos.x-400)^2+npc.pos.y^2)<7,'the copy was not placed near V after the loading screen')
`));

test('a fast-travel placement that keeps failing hands the copy back, and it still rejoins V',()=>run(world+`
  -- Before: three failed placements left the copy owned by the travel
  -- transaction forever, with every distance recovery disarmed.
  Game.GetTeleportationFacility=function() return {Teleport=function() error('teleport unavailable') end} end
  assert(companions.beginFastTravel())
  player.pos=Vector4.new(400,0,0); player.forward=Vector4.new(0,1)
  assert(companions.fastTravel())
  play(24)
  assert(#teleports>=1,'the copy stayed at the old fast-travel origin'..dump())
  local spot=teleports[1].spot
  assert(math.sqrt((spot.x-400)^2+spot.y^2)<7,'the copy did not rejoin near V')
`));
