import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
function run(code){
  const state=lauxlib.luaL_newstate();lualib.luaL_openlibs(state);
  const program=companionEngine+code;
  const status=lauxlib.luaL_dostring(state,to_luastring(program));
  const error=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  const line=Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state);assert.equal(status,lua.LUA_OK,error+(line?'\n'+program.split('\n')[line-1]:''));
}

// V stands on the lower road. Its desired stand-off is on a raised sidewalk.
// A body rooted at V's raw Z intersects that real support; the native navigation
// point fits. This independently models the live .147-metre ground mismatch.
const fixture=`
local npc=spawn();npc.ai.commands={};npc.pos=Vector4.new(0,2.5,0)
player.pos=Vector4.new(0,8,0)
local motor=dofile('companion-actuator.lua');local state=motor.new(npc)
local helper=dofile('companion-clearance.lua')
local lift,projectionAvailable,projectionThrows,realObstacle,lateral=.147,true,false,false,0
local projections,paths,queries=0,0,0
local nav=Game.GetAINavigationSystem();local originalPath=nav.CalculatePathForCharacter
nav.FindPointInSphereForCharacter=function(_,point)
  projections=projections+1
  if projectionThrows then error('Native navigation is unavailable') end
  if not projectionAvailable then return {status='Failed'} end
  return {status='OK',point=Vector4.new(point.x+lateral,point.y,point.z+lift)}
end
nav.CalculatePathForCharacter=function(self,...)
  paths=paths+1;return originalPath(self,...)
end
Game.GetAINavigationSystem=function() return nav end
Game.GetSpatialQueriesSystem=function() return {Overlap=function(_,extent,center,_,group)
  queries=queries+1
  local sidewalk=center.y>=5 and center.y<=7
  return group=='Static' and sidewalk and (realObstacle or center.z-extent.z<.147)
end} end
local context={position=npc.pos,direction=npc.forward,speed=0,player=player,slot=1,playerGap=5.5,
  frame={position=player.pos},others={},id=npc.id.hash}
local decision={operation={ticket='follow-projection',kind='follow',gait='Sprint'},look='none'}
local function update(dt)
  context.position,context.frame.position=npc.pos,player.pos
  context.playerGap=math.sqrt((npc.pos.x-player.pos.x)^2+(npc.pos.y-player.pos.y)^2)
  motor.useSpatialBudget(helper.newBudget());motor.sense(state,npc.pos,context.speed,dt or .1)
  motor.apply(state,decision,context,true)
end
`;

test('normal following tests the bounded native stand-off point before body clearance',()=>run(fixture+`
local raw=Vector4.new(0,6.3,0)
assert(helper.body(raw)==false,'fixture did not reproduce the raw-root ground intersection')
update()
assert(last(npc,'AIFollowTargetCommand') and not state.blockedReason,'raw V height still blocked safe following')
assert(projections>=1 and paths>=1)
assert(state.destinationProjection and state.destinationProjection.point.z==.147)
assert(state.destinationProjection.requested.z==0 and state.ticket=='follow-projection')
`));

test('a projected stand-off still rejects a genuine Static obstacle and preserves its owned hold',()=>run(fixture+`
realObstacle=true;update();local held=active(npc)[1]
assert(held.kind=='AIHoldPositionCommand' and state.lastRejection.group=='Static')
for i=1,25 do update() end
assert(active(npc)[1]==held and #npc.ai.commands==1)
assert(not last(npc,'AIFollowTargetCommand') and not last(npc,'AIMoveToCommand'))
`));

test('a destination hold re-resolves changed native projection while V and the ticket stay still',()=>run(fixture+`
lift=0;update();local held=active(npc)[1]
assert(state.blockedReason and state.lastRejection.stage=='destination')
lift=.147
for i=1,25 do update() if last(npc,'AIFollowTargetCommand') then break end end
assert(last(npc,'AIFollowTargetCommand') and not state.blockedReason,'old raw destination box was the only freshness sensor')
assert(state.ticket=='follow-projection' and held.state~='Executing')
`));

test('unavailable or out-of-bound native projection never grants autonomous following',()=>run(fixture+`
projectionAvailable=false;update()
assert(active(npc)[1].kind=='AIHoldPositionCommand' and state.blockedReason)
assert(state.lastRejection.stage=='projection')
projectionAvailable=true;lift=1.3
for i=1,25 do update() end
assert(state.blockedReason and #active(npc)==1 and active(npc)[1].kind=='AIHoldPositionCommand')
assert(not last(npc,'AIFollowTargetCommand') and not last(npc,'AIMoveToCommand'))
lift=.147
for i=1,25 do update() if last(npc,'AIFollowTargetCommand') then break end end
assert(last(npc,'AIFollowTargetCommand'),'a later bounded valid projection never became eligible for admission')
`));

test('a native projection exception retains the ticket and a single safety owner',()=>run(fixture+`
projectionThrows=true;update()
local held=active(npc)[1]
assert(held.kind=='AIHoldPositionCommand' and state.lastRejection.unavailable)
for i=1,20 do update() end
assert(active(npc)[1]==held and #npc.ai.commands==1)
assert(not last(npc,'AIFollowTargetCommand') and not last(npc,'AIMoveToCommand'))
projectionThrows=false
for i=1,25 do update() if last(npc,'AIFollowTargetCommand') then break end end
assert(last(npc,'AIFollowTargetCommand') and state.ticket=='follow-projection')
`));

test('bounded projection does not waive the native route step or floor transition guard',()=>run(fixture+`
lift=.6
nav.CalculatePathForCharacter=function(_,origin,destination)
  paths=paths+1
  return {path={origin,Vector4.new(origin.x,origin.y,destination.z),destination},
    CalculateLength=function() return 6.9 end}
end
update()
assert(active(npc)[1].kind=='AIHoldPositionCommand')
assert(state.lastRejection.geometryType=='step-slope' and state.lastRejection.allowedRise==.35)
assert(state.lastRejection.rise==.6 and state.lastRejection.projection.shift==.6)
assert(not last(npc,'AIFollowTargetCommand') and not last(npc,'AIMoveToCommand'))
`));

test('a laterally projected initial goal receives certified point execution instead of a radial follower',()=>run(fixture+`
lateral=.3
for i=1,15 do update() if last(npc,'AIMoveToCommand') then break end end
local move=last(npc,'AIMoveToCommand')
assert(move and not last(npc,'AIFollowTargetCommand'),'a radial native follower cannot honor a lateral nav point')
assert(state.execution and state.execution.following and state.destinationProjection.lateralShift==.3)
assert(motor.ownsTravel(state,move) and #active(npc)==1)
assert(not move.ignoreNavigation and not move.rotateEntityTowardsFacingTarget)
assert(move.movementTarget.position.x>0 and move.movementTarget.position.z>0)
`));

test('a lateral projection change during follow retires the exact radial owner before walking its point',()=>run(fixture+`
update();local followed=last(npc,'AIFollowTargetCommand');assert(followed)
lateral=.3
for i=1,25 do update() if last(npc,'AIMoveToCommand') then break end end
local move=last(npc,'AIMoveToCommand')
assert(move and followed.state~='Executing' and #active(npc)==1)
assert(state.destinationProjection.lateralShift==.3 and state.execution.following)
assert(motor.ownsTravel(state,move) and state.ticket=='follow-projection')
`));

// A moving or newly parked car occupies the radial follower's old endpoint.
// Navigation can offer a clear side point and a bent path to it, but that proof
// grants nothing to the still-running old AIFollowTarget command.
const lateralWatchObstruction=`
npc.pos=Vector4.new(0,4.9,.147)
update();local radial=last(npc,'AIFollowTargetCommand');assert(radial)
local cars={{x=0,y=6.3,hx=.15,hy=.15}}
local previousSpatial=Game.GetSpatialQueriesSystem
Game.GetSpatialQueriesSystem=function() return {Overlap=function(_,extents,center,rotation,group)
  if group=='Vehicle' then
    local angle=math.rad(rotation.yaw or 0)
    local ux,uy=math.cos(angle),math.sin(angle);local vx,vy=-uy,ux
    for _,car in ipairs(cars) do
      local dx,dy=car.x-center.x,car.y-center.y
      if math.abs(dx)<=math.abs(ux)*extents.x+math.abs(vx)*extents.y+car.hx
        and math.abs(dy)<=math.abs(uy)*extents.x+math.abs(vy)*extents.y+car.hy
        and math.abs(dx*ux+dy*uy)<=extents.x+car.hx*math.abs(ux)+car.hy*math.abs(uy)
        and math.abs(dx*vx+dy*vy)<=extents.y+car.hx*math.abs(vx)+car.hy*math.abs(vy) then return true end
    end
  end
  return previousSpatial():Overlap(extents,center,rotation,group)
end} end
lateral=.7
nav.CalculatePathForCharacter=function(self,origin,destination)
  paths=paths+1
  if destination.x>0 then
    return {path={origin,Vector4.new(destination.x,origin.y,origin.z),destination},
      CalculateLength=function() return math.abs(destination.x-origin.x)+math.abs(destination.y-origin.y) end}
  end
  return originalPath(self,origin,destination)
end
motor.useSpatialBudget(helper.newBudget())
assert(helper.body(Vector4.new(0,6.3,.147))==false,'old radial endpoint is not actually occupied')
assert(helper.body(Vector4.new(.7,6.3,.147))==true,'side endpoint is not actually clear')
local function deferredUpdate(canPlan)
  context.position,context.frame.position=npc.pos,player.pos
  context.playerGap=math.sqrt((npc.pos.x-player.pos.x)^2+(npc.pos.y-player.pos.y)^2)
  motor.useSpatialBudget(helper.newBudget());motor.sense(state,npc.pos,0,.1)
  motor.apply(state,decision,context,canPlan)
end
`;

test('a safe lateral watch point cannot retain an invalid radial follower under deferred planning',()=>run(fixture+lateralWatchObstruction+`
update(.9);assert(state.execution and state.destinationProjection.lateralShift==.7)
deferredUpdate(false)
local held=active(npc)[1]
assert(radial.state~='Executing','new lateral-point clearance kept the occupied radial route active')
assert(#active(npc)==1 and held.kind=='AIHoldPositionCommand' and not last(npc,'AIMoveToCommand'))
for i=1,5 do deferredUpdate(false);assert(active(npc)[1]==held and #active(npc)==1) end
deferredUpdate(true)
local move=last(npc,'AIMoveToCommand')
assert(move and motor.ownsTravel(state,move) and #active(npc)==1)
assert(state.ticket=='follow-projection' and not state.blockedReason)
`));

test('lateral watch retirement retains an asynchronous exact handle and rechecks new point obstructions',()=>run(fixture+lateralWatchObstruction+`
local stops=0
npc.ai.StopExecutingCommand=function() stops=stops+1 end
update(.9)
assert(stops==1 and state.cancellation and state.command==radial)
for i=1,5 do deferredUpdate(false) end
assert(stops==1 and #active(npc)==1 and active(npc)[1]==radial)
assert(not last(npc,'AIHoldPositionCommand') and not last(npc,'AIMoveToCommand'))
radial.state='Cancelled';deferredUpdate(false)
assert(#active(npc)==1 and active(npc)[1].kind=='AIHoldPositionCommand')
cars[#cars+1]={x=.7,y=4.9,hx=.15,hy=.15}
npc.ai.StopExecutingCommand=function(_,command) command.state='Cancelled' end
for i=1,4 do deferredUpdate(true) if state.blockedReason then break end end
assert(state.blockedReason and state.lastRejection.group=='Vehicle')
assert(#active(npc)==1 and active(npc)[1].kind=='AIHoldPositionCommand')
assert(not last(npc,'AIMoveToCommand'),'point admission reused the old watch proof after another car arrived')
assert(state.ticket=='follow-projection')
`));

test('ordinary follow admission re-proves a moved V and newly occupied route after retiring its hold',()=>run(fixture+`
lift=0;update();local held=active(npc)[1];assert(held.kind=='AIHoldPositionCommand')
lift=.147
local stops=0
npc.ai.StopExecutingCommand=function(_,command)
  stops=stops+1;command.state='Cancelled'
  player.pos=Vector4.new(0,20)
  local prior=Game.GetSpatialQueriesSystem
  Game.GetSpatialQueriesSystem=function() return {Overlap=function(self,extents,center,rotation,group)
    if group=='Vehicle' and math.abs(center.x)<=extents.x+.5
      and math.abs(center.y-3)<=extents.y+.5 then return true end
    return prior():Overlap(extents,center,rotation,group)
  end} end
end
for i=1,25 do update() if stops>0 then break end end
assert(stops==1 and held.state=='Cancelled' and player.pos.y==20)
assert(not last(npc,'AIFollowTargetCommand') and not last(npc,'AIMoveToCommand'),
  'pre-cancellation clearance admitted a now-occupied follow route')
assert(state.blockedReason and state.lastRejection.group=='Vehicle')
assert(#active(npc)==1 and active(npc)[1].kind=='AIHoldPositionCommand')
assert(state.ticket=='follow-projection')
`));

test('asynchronous ordinary admission waits for its exact hold then refreshes the native projected point',()=>run(fixture+`
lift=0;update();local held=active(npc)[1];lift=.147
local stops=0
npc.ai.StopExecutingCommand=function() stops=stops+1 end
for i=1,25 do update() if stops>0 then break end end
assert(stops==1 and state.cancellation and active(npc)[1]==held)
assert(not last(npc,'AIFollowTargetCommand') and not last(npc,'AIMoveToCommand'))
lateral=.3;held.state='Cancelled'
for i=1,25 do update() if last(npc,'AIMoveToCommand') then break end end
assert(last(npc,'AIMoveToCommand') and not last(npc,'AIFollowTargetCommand'))
assert(stops==1 and #active(npc)==1 and state.destinationProjection.lateralShift==.3)
assert(state.ticket=='follow-projection' and not state.cancellation)
`));

// October 5 native follow: a clear distant route is admitted as ONE native
// follower on its six-metre horizon, which does not prove (or need) V's remote
// stand-off. The follower is never walked through MoveTo legs here. Inside the
// horizon the periodic route proof resolves the raised stand-off through native
// projection, never V's raw height, and keeps the same owned follower.
test('a distant native follower re-proves a raised stand-off through native projection inside the horizon',()=>run(fixture+`
player.pos=Vector4.new(0,14)
local supportY=player.pos.y-1.7
Game.GetSpatialQueriesSystem=function() return {Overlap=function(_,extents,center,_,group)
  queries=queries+1
  return group=='Static' and math.abs(center.y-supportY)<.7 and center.z-extents.z<.147
end} end
update();local follower=last(npc,'AIFollowTargetCommand')
assert(follower and not last(npc,'AIMoveToCommand') and not state.blockedReason)
assert(projections==0 and not state.destinationProjection,'a distant horizon proved an unused remote endpoint')
-- Native following carries the copy to within the full-goal boundary of V.
npc.pos=Vector4.new(0,7,0)
local before=projections
for i=1,20 do update() end
assert(not state.blockedReason,'the horizon-to-full boundary still body-tests raw V height')
assert(projections>before and state.destinationProjection.point.z==.147)
assert(state.destinationProjection.requested.z==0 and state.ticket=='follow-projection')
assert(active(npc)[1]==follower and #active(npc)==1,'a clear proof inside the horizon restarted the native follower')
`));

test('release and replacement discard pending follow projection admission without reviving it',()=>run(fixture+`
lift=0;update();local held=active(npc)[1];lift=.147
npc.ai.StopExecutingCommand=function() end
for i=1,25 do update() if state.followAdmission and state.cancellation then break end end
assert(state.followAdmission and state.cancellation)
decision.operation={ticket='released',kind='release'}
held.state='Cancelled';update()
assert(state.ticket=='released' and not state.followAdmission and not state.destinationProjection)
assert(#active(npc)==0 and not last(npc,'AIFollowTargetCommand'))
decision.operation={ticket='new-idle',kind='hold'};update()
assert(state.ticket=='new-idle' and active(npc)[1].kind=='AIHoldPositionCommand')
assert(not last(npc,'AIFollowTargetCommand') and not last(npc,'AIMoveToCommand'))
`));
