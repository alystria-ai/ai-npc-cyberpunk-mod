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

test('a follower standing in the car with V is brought along at arrival',()=>run(world+`
  for i=1,6 do player.pos=Vector4.new(0,i,0); play(1) end
  lift.inside=true; npc.pos=Vector4.new(.8,6,0); play(2)
  lift.moving=true
  for i=1,10 do player.pos=Vector4.new(0,6,i*4); play(1) end
  assert(logged('lift-departed') and logged('lift-departed').fields.withV==true,'the ride did not record her in the car'..dump())
  lift.moving=false
  player.forward=Vector4.new(0,-1)
  play(2)
  assert(#teleports>=1,'a companion who stood in the car with V was left on the old floor'..dump())
  assert(math.abs(teleports[1].spot.z-40)<1)
`));

test('a follower the car carried along is not teleported',()=>run(world+`
  for i=1,6 do player.pos=Vector4.new(0,i,0); play(1) end
  lift.inside=true; npc.pos=Vector4.new(.8,6,0); play(2)
  lift.moving=true
  for i=1,10 do player.pos=Vector4.new(0,6,i*4); npc.pos=Vector4.new(.8,6,i*4); play(1) end
  lift.moving=false; play(2); lift.inside=false; play(6)
  assert(#teleports==0,'a companion who rode along was teleported'..dump())
`));

test('V waiting in a stopped car pulls a blocked follower into the car, never in view',()=>run(world+`
  local front=door(3,{locked=true})
  for i=1,10 do player.pos=Vector4.new(0,i,0); play(1) end
  lift.inside=true
  player.forward=Vector4.new(0,-1) -- V faces the car doors, toward her
  play(8)
  assert(#teleports==0,'she was teleported into the car in front of V'..dump())
  player.forward=Vector4.new(0,1) -- V turns to the back wall
  play(4)
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

// Recorded case 2026-10-08 (CityCenter, probe.log 08:16-08:18Z): V stood in a
// stopped lift car whose floor carries no navmesh; the nearest walkable ground
// was the doorway 2.8 m from V. Judy's routes were refused ('navigation') and
// the navmesh placement refused every spot in the car ("Move onto open,
// walkable ground"), so she waited at the threshold for 65 s.
// Car: x -1.2..1.2, y 6.8..9.2, open side at y=6.8; navmesh only at y<6.6.
const car=`
  local walls={{-1.2,6.8,-1.2,9.2},{1.2,6.8,1.2,9.2},{-1.2,9.2,1.2,9.2}}
  local function inCar(x,y) return x>-1.2 and x<1.2 and y>6.8 and y<9.2 end
  local function crosses(ax,ay,bx,by,w)
    local function side(px,py,qx,qy,rx,ry) return (qx-px)*(ry-py)-(qy-py)*(rx-px) end
    local d1,d2=side(w[1],w[2],w[3],w[4],ax,ay),side(w[1],w[2],w[3],w[4],bx,by)
    local d3,d4=side(ax,ay,bx,by,w[1],w[2]),side(ax,ay,bx,by,w[3],w[4])
    return d1*d2<0 and d3*d4<0
  end
  -- A wall point inside the (yaw-rotated) box footprint is a hit.
  local function boxHits(extents,center,rotation)
    local yaw=math.rad(rotation and rotation.yaw or 0)
    local fx,fy=-math.sin(yaw),math.cos(yaw) -- local y (travel direction)
    for _,w in ipairs(walls) do
      for k=0,40 do
        local px,py=w[1]+(w[3]-w[1])*k/40-center.x,w[2]+(w[4]-w[2])*k/40-center.y
        local along,across=px*fx+py*fy,px*fy-py*fx
        if math.abs(along)<extents.y and math.abs(across)<extents.x then return true end
      end
    end
    return false
  end
  walkable=function(position) return position.y<6.6 end
  navigation.CalculatePathForCharacter=function(self,from,to,...)
    if not walkable(to) or not walkable(from) then return nil end
    return calculate(self,from,to,...)
  end
  Game.GetSpatialQueriesSystem=function() return {
    Overlap=function(_,extents,center,rotation) return boxHits(extents,center,rotation),{} end,
    SyncRaycastByCollisionGroup=function(_,from,to,group)
      if from.x==to.x and from.y==to.y then
        -- The car floor rides with V; the lobby floors are below it.
        local z=inCar(from.x,from.y) and player.pos.z or nil
        if not z and from.y<6.8 then z=from.z>=player.pos.z-.6 and player.pos.z or 0 end
        if group=='Static' and z and from.z>=z and to.z<=z then return true,{position=Vector4.new(from.x,from.y,z)} end
        return false,{}
      end
      -- Floors lie between storeys.
      if math.abs(from.z-to.z)>3 then return true,{} end
      for _,w in ipairs(walls) do if crosses(from.x,from.y,to.x,to.y,w) then return true,{} end end
      return false,{}
    end} end
  local function boardCommands()
    local n=0
    for _,cmd in ipairs(npc.ai.commands) do if cmd.kind=='AIMoveToCommand' and cmd.ignoreNavigation then n=n+1 end end
    return n
  end
  -- V walks north into the car and stops at its centre.
  local function enterCar()
    for i=1,8 do player.pos=Vector4.new(0,i,0); play(1) end
    player.forward=Vector4.new(0,-1) -- V turns to face the doors
    lift.inside=true
  end
`;

test('V in a car without navmesh: the follower walks into the car beside V, no teleport',()=>run(world+car+`
  enterCar()
  play(10)
  assert(boardCommands()>=1,'the follower never walked onto the car floor'..dump())
  assert(#teleports==0,'the follower was teleported although she could walk in'..dump())
  assert(inCar(npc.pos.x,npc.pos.y),'the follower is not standing in the car'..dump())
  assert(logged('lift-boarded'),'no probe line for boarding the car')
  local gap=math.sqrt((npc.pos.x-player.pos.x)^2+(npc.pos.y-player.pos.y)^2)
  assert(gap>.8 and gap<1.5,'she does not stand beside V: '..gap)
  -- She stays in the car while V does, holding still.
  local spot=Vector4.new(npc.pos.x,npc.pos.y,npc.pos.z)
  play(8)
  assert(inCar(npc.pos.x,npc.pos.y) and math.abs(npc.pos.y-spot.y)<.3,'she walked out of the car while V stayed'..dump())
`));

test('she rides with V, then walks out after V on the new floor',()=>run(world+car+`
  enterCar(); play(10)
  assert(logged('lift-boarded'),'she never boarded'..dump())
  lift.moving=true
  for i=1,10 do
    player.pos=Vector4.new(0,8,i*4); npc.pos=Vector4.new(npc.pos.x,npc.pos.y,i*4); play(1)
  end
  lift.moving=false; play(2)
  -- V steps out of the car on the new floor and walks on.
  lift.inside=false
  for i=1,5 do player.pos=Vector4.new(0,7-i*.8,40); player.forward=Vector4.new(0,-1); play(1) end
  play(10)
  assert(#teleports==0,'a companion who rode along was teleported'..dump())
  assert(not inCar(npc.pos.x,npc.pos.y),'she stayed in the car after V stepped out'..dump())
  assert(math.abs(npc.pos.z-40)<.5)
  assert(math.sqrt((npc.pos.x-player.pos.x)^2+(npc.pos.y-player.pos.y)^2)<4,'she did not follow V out'..dump())
`));

test('a walk into the car the engine does not perform ends in a teleport into the car',()=>run(world+car+`
  -- The walk helper ignores off-navmesh walks: she never gets in on foot.
  local plain=npc.ai.onSend
  npc.ai.onSend=function(cmd)
    if cmd.kind=='AIMoveToCommand' and cmd.ignoreNavigation then cmd.kind='AIMoveToCommandIgnored' end
    return plain(cmd)
  end
  enterCar()
  play(16)
  assert(logged('lift-board-walk-failed'),'the refused walk was not noticed'..dump())
  assert(#teleports==0,'she was teleported into the car while V watched the doors'..dump())
  player.forward=Vector4.new(0,1) -- V turns away
  play(4)
  assert(#teleports>=1,'the follower stayed outside the car'..dump())
  local spot=teleports[#teleports].spot
  assert(inCar(spot.x,spot.y),'she was not placed in the car')
  assert(logged('relocated','lift-board'),'no probe line for the teleport into the car')
`));

test('a moving car carries her along with V, then she walks out after V',()=>run(world+car+`
  -- Live 2026-10-08 08:51Z: the car does not carry an NPC; M.carry moves her.
  local carried=0
  Game.GetTeleportationFacility=function() return {Teleport=function(_,who,at) carried=carried+1; who.pos=at end} end
  enterCar(); play(10)
  assert(logged('lift-boarded'),'she never boarded'..dump())
  local offset={x=npc.pos.x-player.pos.x,y=npc.pos.y-player.pos.y}
  lift.moving=true
  for i=1,40 do
    -- init.lua carries riders every frame, before the companion update.
    player.pos=Vector4.new(0,8,i)
    if companions.riders then companions.carry(player) end
    play(1)
  end
  assert(carried>=30,'she was not carried with V ('..carried..' moves)'..dump())
  assert(math.abs(npc.pos.z-40)<.2 and math.abs(npc.pos.x-player.pos.x-offset.x)<.05,'she did not keep her place beside V: '
    ..npc.pos.x..','..npc.pos.y..','..npc.pos.z..' offset '..offset.x..','..offset.y)
  lift.moving=false; play(2)
  assert(not companions.riders,'still carried after the car stopped')
  lift.inside=false
  for i=1,5 do player.pos=Vector4.new(0,7-i*.8,40); player.forward=Vector4.new(0,-1); play(1) end
  play(10)
  assert(#teleports==0,'an AI teleport was used during the ride'..dump())
  assert(not inCar(npc.pos.x,npc.pos.y),'she stayed in the car after V stepped out'..dump())
`));

test('a failed walk into the car is retried once by another approach, and she walks in',()=>run(world+car+`
  -- Live 2026-10-08 20:26:05Z: the first walk failed and boarding was given up.
  local plain,ignored=npc.ai.onSend,0
  npc.ai.onSend=function(cmd)
    if cmd.kind=='AIMoveToCommand' and cmd.ignoreNavigation and ignored==0 then ignored=1; cmd.kind='AIMoveToCommandIgnored' end
    return plain(cmd)
  end
  enterCar(); play(16)
  assert(logged('lift-board-walk-failed'),'the first walk did not fail'..dump())
  assert(logged('lift-boarded'),'the retry did not bring her into the car'..dump())
  assert(#teleports==0,'teleported although the retry walk worked'..dump())
  assert(inCar(npc.pos.x,npc.pos.y))
`));

test('V keeps watching while she cannot get in: she vanishes as the car departs and is in the car at arrival',()=>run(world+car+`
  Game.GetTeleportationFacility=function() return {Teleport=function() end} end
  local plain=npc.ai.onSend
  npc.ai.onSend=function(cmd)
    if cmd.kind=='AIMoveToCommand' and cmd.ignoreNavigation then cmd.kind='AIMoveToCommandIgnored' end
    return plain(cmd)
  end
  local events={}
  local queue=npc.QueueEvent
  npc.QueueEvent=function(self,event)
    if type(event)=='table' and event.kind=='enteventsSetVisibility' then events[#events+1]=event.visible end
    return queue(self,event)
  end
  enterCar(); play(30) -- V watches the doors the whole time
  assert(#teleports==0,'she was teleported in while V watched'..dump())
  assert(not inCar(npc.pos.x,npc.pos.y),'she got in anyway')
  lift.moving=true
  for i=1,20 do
    player.pos=Vector4.new(0,8,i*2)
    if companions.riders then companions.carry(player) end
    play(1)
  end
  assert(events[1]==false,'she was not hidden when the car departed without her'..dump())
  assert(logged('lift-departed') and logged('lift-departed').fields.withV==true,'the ride did not count her')
  lift.moving=false; play(4)
  assert(#teleports>=1,'she was not placed in the car at arrival'..dump())
  local spot=teleports[1].spot
  assert(math.abs(spot.z-40)<.5 and inCar(spot.x,spot.y),'not placed in the car on the new floor')
  play(2)
  assert(events[#events]==true,'she was not shown again')
`));

test('the inside flag flickering as V steps to the doors keeps the fallback; she is placed the moment V looks away',()=>run(world+car+`
  -- Live 2026-10-08 20:37:12Z: V stepped toward the doors inside the car,
  -- and after the failed walk no fallback ran at all.
  local plain=npc.ai.onSend
  npc.ai.onSend=function(cmd)
    if cmd.kind=='AIMoveToCommand' and cmd.ignoreNavigation then cmd.kind='AIMoveToCommandIgnored' end
    return plain(cmd)
  end
  enterCar(); play(6)
  player.pos=Vector4.new(0,7.3,0); lift.inside=false; play(1) -- V by the doors
  lift.inside=true; play(10)
  assert(logged('lift-board-walk-failed'),'the walk did not fail'..dump())
  assert(#teleports==0,'placed while V watched'..dump())
  player.forward=Vector4.new(0,1) -- V looks away
  play(2)
  assert(#teleports>=1,'she was not placed when V looked away'..dump())
  local spot=teleports[1].spot
  assert(inCar(spot.x,spot.y),'not placed in the car')
`));

test('a carry that does not hold her hides her for the ride; she is in the car at arrival',()=>run(world+car+`
  -- Live 2026-10-08 20:07:59-20:08:10Z: the per-frame transform left Judy at
  -- z 8.3 while V rose to 49.2; she seemed to sink through the car floor.
  Game.GetTeleportationFacility=function() return {Teleport=function() end} end
  local function visible()
    local state=true
    for event in pairs(npc.looks) do
      if type(event)=='table' and event.kind=='enteventsSetVisibility' then state=event.visible end
    end
    return state
  end
  local events={}
  local queue=npc.QueueEvent
  npc.QueueEvent=function(self,event)
    if type(event)=='table' and event.kind=='enteventsSetVisibility' then events[#events+1]=event.visible end
    return queue(self,event)
  end
  enterCar(); play(10)
  assert(logged('lift-boarded'),'she never boarded'..dump())
  lift.moving=true
  for i=1,40 do
    player.pos=Vector4.new(0,8,i)
    if companions.riders then companions.carry(player) end
    play(1)
    if i==4 then assert(events[1]==false,'she was not hidden when the carry did not hold her'..dump()) end
  end
  assert(logged('lift-carry') and logged('lift-carry').fields.result=='hidden','no probe line for the hidden ride')
  assert(#teleports==0,'teleported during the ride')
  lift.moving=false; play(4)
  assert(#teleports>=1,'she was not placed in the car at arrival'..dump())
  local spot=teleports[1].spot
  assert(math.abs(spot.z-40)<.5 and inCar(spot.x,spot.y),'not placed in the car on the new floor')
  play(2)
  assert(events[#events]==true,'she was not shown again in the car')
`));

test('a carry that fails outright (no teleport facility) also hides her and places her at arrival',()=>run(world+car+`
  Game.GetTeleportationFacility=function() error('teleport facility unavailable') end
  enterCar(); play(10)
  assert(logged('lift-boarded'),'she never boarded'..dump())
  lift.moving=true
  for i=1,10 do
    player.pos=Vector4.new(0,8,i*4)
    if companions.riders then companions.carry(player) end
    play(1)
  end
  local hidden=logged('lift-carry')
  assert(hidden and hidden.fields.result=='hidden' and tostring(hidden.fields.error):find('unavailable'),
    'the failed carry was not hidden and reported'..dump())
  assert(#teleports==0,'teleported during the ride')
  lift.moving=false; play(3)
  assert(#teleports>=1,'she stayed on the old floor'..dump())
  local spot=teleports[1].spot
  assert(math.abs(spot.z-40)<.5 and inCar(spot.x,spot.y),'not placed in the car on the new floor')
`));

test('a companion touching a prop steps clear and then follows instead of being refused forever',()=>run(world+`
  -- Live 2026-10-08 14:23Z: 38 goals refused in 6 s at the 'origin' stage.
  play(2)
  local prop=Vector4.new(npc.pos.x+.15,npc.pos.y,npc.pos.z)
  local start=Vector4.new(npc.pos.x,npc.pos.y,npc.pos.z)
  Game.GetSpatialQueriesSystem=function() return {
    Overlap=function(_,extents,center,rotation)
      -- The prop is solid where it stands: a box over that point is a hit.
      local yaw=math.rad(rotation and rotation.yaw or 0)
      local fx,fy=-math.sin(yaw),math.cos(yaw)
      local px,py=prop.x-center.x,prop.y-center.y
      return math.abs(px*fx+py*fy)<extents.y and math.abs(px*fy-py*fx)<extents.x,{}
    end,
    SyncRaycastByCollisionGroup=function() return false end} end
  -- She stands a little below the navmesh there: every route starts with the
  -- native origin projection straight up through the prop.
  navigation.CalculatePathForCharacter=function(self,from,to,...)
    if math.sqrt((from.x-start.x)^2+(from.y-start.y)^2)<.1 then
      return {path={Vector4.new(from.x,from.y,from.z+.5),to},CalculateLength=function()
        return math.sqrt((to.x-from.x)^2+(to.y-from.y)^2)+.5 end}
    end
    return calculate(self,from,to,...)
  end
  player.pos=Vector4.new(start.x-1,start.y+6,0); play(2)
  player.pos=Vector4.new(start.x-1,start.y+7,0); play(16)
  local stepped
  for _,cmd in ipairs(npc.ai.commands) do
    if cmd.kind=='AIMoveToCommand' and cmd.ignoreNavigation then
      local at=cmd.movementTarget.position
      if math.sqrt((at.x-start.x)^2+(at.y-start.y)^2)<.7 then stepped=true end
    end
  end
  assert(stepped,'she never stepped clear of the prop'..dump())
  assert(#teleports==0,'a teleport was used to unstick her')
  assert(math.sqrt((npc.pos.x-player.pos.x)^2+(npc.pos.y-player.pos.y)^2)<4,'she did not follow V after stepping clear'..dump())
`));

test('left behind on the old floor: she appears out of view near V once V steps out of the car',()=>run(world+car+`
  -- She is held 20 m back behind a locked door: too far to be taken along.
  local front=door(-9,{locked=true})
  npc.pos=Vector4.new(0,-12,0); play(2)
  for i=1,8 do player.pos=Vector4.new(0,i,0); play(1) end
  lift.inside=true; play(1)
  lift.moving=true
  for i=1,10 do player.pos=Vector4.new(0,8,i*4); play(1) end
  lift.moving=false; play(4)
  assert(#teleports==0,'placed while V still stood in a car without walkable floor')
  lift.inside=false
  for i=1,4 do player.pos=Vector4.new(0,7-i,40); player.forward=Vector4.new(0,-1); play(1) end
  play(4)
  assert(#teleports>=1,'she stayed on the old floor after V stepped out'..dump())
  local item=teleports[1]
  assert(math.abs(item.spot.z-40)<1,'not placed on the floor of V')
  local space=dofile('companion-space.lua')
  local angle=space.angle({x=0,y=-1},space.bearing(item.from,item.spot))
  assert(angle>60,'she appeared in front of V ('..angle..' degrees)')
`));

test('a follower on another floor walking about without climbing rejoins after the backstop',()=>run(world+`
  -- V 6 m up; she keeps walking back and forth on the floor below.
  player.pos=Vector4.new(0,10,6); player.forward=Vector4.new(0,1)
  for i=1,24 do npc.pos=Vector4.new(i%2==0 and 2 or -2,4,0); play(1,0) end
  assert(#teleports>=1,'a follower walking about a floor below never rejoined'..dump())
  assert(math.abs(teleports[1].spot.z-6)<1)
`));

test('a refused move beside a still V settles instead of waiting forever',()=>run(world+`
  -- Recorded case 2026-10-08 (V's apartment): every walk from Judy's stance
  -- was refused by furniture and she stood 'obstructed' 0.6 m from V for 8 min.
  play(4)
  Game.GetSpatialQueriesSystem=function() return {Overlap=function() return true,{} end,
    SyncRaycastByCollisionGroup=function() return false end} end
  player.pos=Vector4.new(npc.pos.x+.6,npc.pos.y+1.4,0); play(1)
  local phases={}
  local before=#npc.ai.commands
  for i=1,24 do
    play(1,0)
    phases[#phases+1]=companions.movementSnapshot().copies[1].brain.phase
  end
  assert(table.concat(phases,','):find('obstructed'),'the refused move was not reproduced: '..table.concat(phases,','))
  local final=phases[#phases]
  assert(final~='obstructed','she still waits obstructed after 12 s: '..table.concat(phases,','))
  assert(#npc.ai.commands-before<12,'the refused move became a command storm')
`));

test('furniture refusing every route beside her: a short step, then an out-of-view rejoin near V',()=>run(world+`
  -- Live 2026-10-08 20:55Z (V's apartment): every follow refused at 'path'
  -- on its second leg by furniture 0.75 m away; detours exhausted; she
  -- stood 9.3 m from V for minutes, under the 10 m stranded distance.
  play(2)
  local o=Vector4.new(npc.pos.x,npc.pos.y,npc.pos.z)
  -- A U of furniture 0.75 m around her, open behind her (away from V).
  local walls={{o.x-.75,o.y-.3,o.x-.75,o.y+.75},{o.x-.75,o.y+.75,o.x+.75,o.y+.75},{o.x+.75,o.y+.75,o.x+.75,o.y-.3}}
  Game.GetSpatialQueriesSystem=function() return {
    Overlap=function(_,extents,center,rotation)
      local yaw=math.rad(rotation and rotation.yaw or 0)
      local fx,fy=-math.sin(yaw),math.cos(yaw)
      for _,w in ipairs(walls) do
        for k=0,30 do
          local px,py=w[1]+(w[3]-w[1])*k/30-center.x,w[2]+(w[4]-w[2])*k/30-center.y
          if math.abs(px*fx+py*fy)<extents.y and math.abs(px*fy-py*fx)<extents.x then return true,{} end
        end
      end
      return false,{}
    end,
    SyncRaycastByCollisionGroup=function() return false end} end
  -- V walks 6 m ahead (through the furniture's open side for V) and stops,
  -- looking further ahead: she is out of V's view.
  player.forward=Vector4.new(0,1)
  for i=1,4 do player.pos=Vector4.new(o.x,o.y+1.5*i,0); play(1) end
  play(44)
  local stepped
  for _,cmd in ipairs(npc.ai.commands) do
    if cmd.kind=='AIMoveToCommand' and cmd.ignoreNavigation then
      local at=cmd.movementTarget.position
      if math.sqrt((at.x-o.x)^2+(at.y-o.y)^2)<.7 then stepped=true end
    end
  end
  assert(stepped,'she never took the short step clear'..dump())
  assert(#teleports>=1,'she stayed stranded behind the furniture'..dump())
  assert(logged('relocated','stance'),'the rejoin was not the stance rule'..dump())
  local spot=teleports[1].spot
  assert(math.sqrt((spot.x-player.pos.x)^2+(spot.y-player.pos.y)^2)<6,'not placed near V')
`));

// Live 2026-10-10: "she walks too slowly into the lift" while V waited in the
// car. The walk onto the car floor was a Walk for the last 3 m; it now jogs,
// sprints from 5 m, and walks only for the last 1.5 m (no overshoot).
test('boarding gait: walk when very close, jog in between, sprint from afar',()=>run(companionEngine+`
  local passage=dofile('companion-passage.lua')
  assert(passage.boardGait(0.5)=='Walk' and passage.boardGait(1.5)=='Walk')
  assert(passage.boardGait(1.6)=='Run' and passage.boardGait(3)=='Run' and passage.boardGait(5)=='Run')
  assert(passage.boardGait(5.1)=='Sprint' and passage.boardGait(10)=='Sprint')
`));

test('she hurries onto the car floor: no leisurely walk beyond 1.5 m, sprint from afar',()=>run(world+car+`
  local sent={}
  local plain=npc.ai.onSend
  npc.ai.onSend=function(cmd)
    if cmd.kind=='AIMoveToCommand' and cmd.ignoreNavigation then
      sent[#sent+1]={gait=cmd.movementType,gap=space.ground(npc.pos,cmd.movementTarget.position)}
    end
    return plain(cmd)
  end
  -- She stands 8 m back from the doors when V steps into the car.
  npc.pos=Vector4.new(0,-6,0)
  enterCar(); play(14)
  assert(#sent>=1,'she never walked onto the car floor'..dump())
  for _,leg in ipairs(sent) do
    local want=leg.gap<=1.5 and 'Walk' or leg.gap>5 and 'Sprint' or 'Run'
    assert(leg.gait==want,'gait '..tostring(leg.gait)..' for '..leg.gap..' m, wanted '..want)
  end
  local fast=0
  for _,leg in ipairs(sent) do if leg.gait~='Walk' then fast=fast+1 end end
  assert(fast>=1,'every leg onto the car floor was a walk')
  assert(logged('lift-boarded'),'she never boarded'..dump())
  assert(#teleports==0,'she was teleported although she could walk in'..dump())
`));

// Live 2026-10-09 20:01Z, after the boarding gait change: door-then-walk, the
// native walk ended 0.5 m from the doorway foothold, the straight leg from
// there was blocked, and with no door leg tried (the door was inside 0.6 m) the
// retry found nothing clear and fell back to the unseen placement, so she never
// got in while V watched. The door leg now goes exactly to the doorway, and
// every retry leg walks.
test('a native walk that stops beside the doorway is finished exactly at the doorway, then she walks in',()=>run(world+car+`
  local sent={}
  -- A wall across her straight line, so the native route to the doorway runs
  -- first; a short wall that only blocks a start 0.5 m left of the doorway.
  walls[#walls+1]={-8,-1,8,-1}
  walls[#walls+1]={-3,6.5,-.5,6.5}
  local plain=npc.ai.onSend
  local stopped
  npc.ai.onSend=function(cmd)
    if cmd.kind=='AIMoveToCommand' then
      local t=cmd.movementTarget.position
      sent[#sent+1]={gait=cmd.movementType,navigate=not cmd.ignoreNavigation,x=t.x,y=t.y}
      if not cmd.ignoreNavigation and not stopped and t.y>5 then
        -- The route to the doorway (0,6) ends 0.5 m beside it instead of at it.
        stopped=cmd.movementType
        npc.pos=Vector4.new(t.x-.5,t.y,npc.pos.z)
        cmd.kind='AIMoveToCommandIgnored'
      end
    end
    return plain(cmd)
  end
  npc.pos=Vector4.new(-5,-6,0)
  enterCar(); play(24)
  assert(stopped,'the native walk to the doorway never ran'..dump())
  assert(stopped=='Run','the native route to the doorway sprinted: '..tostring(stopped))
  assert(logged('lift-board-walk-failed'),'the blocked leg was not noticed'..dump())
  assert(logged('lift-boarded'),'she never got in on foot'..dump())
  assert(#teleports==0,'she fell back to the placement'..dump())
  assert(inCar(npc.pos.x,npc.pos.y),'she is not in the car'..dump())
  -- The retry legs walk: to the doorway exactly, then in.
  local retry={}
  for _,s in ipairs(sent) do if not s.navigate and s.y>5.5 then retry[#retry+1]=s end end
  assert(#retry>=2 and retry[1].gait=='Walk' and retry[2].gait=='Walk','the retry did not walk: '..#retry)
`));

// Live 2026-10-11 (probe.log 07:18Z), the normal case: V stepped into the car
// first, and for both companions every straight leg from the doorway into the
// car was refused by the sweep (swept blocked, then lift-board-walk-failed
// twice, the retry's door leg stopping 0.4 m short), so neither walked in while
// V watched. The refusal came from the door frame brushing the 0.8 m wide body
// box when she stood a little off the doorway line; a slimmer body fits.
test('a leg into the car that only the full body box refuses is walked with a slimmer body, no placement',()=>run(world+car+`
  -- Door posts: a gap of 0.8 m at the car's open side.
  walls[#walls+1]={-1.2,6.8,-.4,6.8}
  walls[#walls+1]={.4,6.8,1.2,6.8}
  walls[#walls+1]={-8,-1,8,-1}
  local plain=npc.ai.onSend
  local short=0
  npc.ai.onSend=function(cmd)
    if cmd.kind=='AIMoveToCommand' then
      local t=cmd.movementTarget.position
      -- Every walk to the doorway ends 0.45 m beside it, as in the log.
      if t.y<6.6 and short<3 then
        short=short+1
        npc.pos=Vector4.new(t.x-.45,t.y,npc.pos.z)
        cmd.kind='AIMoveToCommandIgnored'
      end
    end
    return plain(cmd)
  end
  npc.pos=Vector4.new(-5,-6,0)
  enterCar(); play(30)
  assert(short>=1,'no walk to the doorway was cut short'..dump())
  assert(logged('lift-boarded'),'she never walked into the car'..dump())
  assert(#teleports==0,'she was placed instead of walking in'..dump())
  assert(inCar(npc.pos.x,npc.pos.y),'she is not in the car'..dump())
`));

test('a leg into the car that every body size refuses still ends in the placement, and logs what blocked it',()=>run(world+car+`
  walls[#walls+1]={-1.2,6.8,1.2,6.8} -- the doors are shut
  walls[#walls+1]={-8,-1,8,-1}
  npc.pos=Vector4.new(-5,-6,0)
  enterCar(); play(12)
  assert(#teleports==0,'she was teleported while V watched the doors'..dump())
  local boarding
  for _,l in ipairs(logs) do if l.kind=='lift-boarding' and l.fields.swept then boarding=l.fields end end
  assert(boarding and boarding.swept=='blocked','the refusal was not logged'..dump())
  assert(boarding.blocked and boarding.blocked.by,'what blocked the leg was not logged')
`));
