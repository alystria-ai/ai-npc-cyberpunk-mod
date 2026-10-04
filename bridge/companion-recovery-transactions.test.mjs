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

// Independent native-style oriented-box overlap against world obstacles.
const solids=`
local obstacles,queries={},0
local function overlap(extents,center,rotation,box)
  if center.z+extents.z<box.z-box.hz or center.z-extents.z>box.z+box.hz then return false end
  local angle=math.rad(rotation.yaw or 0)
  local ux,uy=math.cos(angle),math.sin(angle);local vx,vy=-uy,ux
  local dx,dy=box.x-center.x,box.y-center.y
  if math.abs(dx)>math.abs(ux)*extents.x+math.abs(vx)*extents.y+box.hx then return false end
  if math.abs(dy)>math.abs(uy)*extents.x+math.abs(vy)*extents.y+box.hy then return false end
  if math.abs(dx*ux+dy*uy)>extents.x+box.hx*math.abs(ux)+box.hy*math.abs(uy) then return false end
  if math.abs(dx*vx+dy*vy)>extents.y+box.hx*math.abs(vx)+box.hy*math.abs(vy) then return false end
  return true
end
Game.GetSpatialQueriesSystem=function() return {Overlap=function(_,extents,center,rotation,group)
  queries=queries+1
  for _,box in ipairs(obstacles) do if group==box.group and overlap(extents,center,rotation,box) then return true end end
  return false
end} end
local function solid(group,x,y,hx,hy)
  obstacles[#obstacles+1]={group=group,x=x,y=y,hx=hx,hy=hy,z=.8,hz=.8}
end
`;

const motor=`
local npc=spawn();npc.ai.commands={};npc.pos=Vector4.new(0,0,0)
local actuator=dofile('companion-actuator.lua');local state=actuator.new(npc)
local helper=dofile('companion-clearance.lua')
player.pos=Vector4.new(0,8,0)
local context={position=npc.pos,direction=npc.forward,speed=0,player=player,slot=1,playerGap=8,
  frame={position=player.pos},others={},id=npc.id.hash}
local decision={operation={ticket='same-follow',kind='follow',gait='Sprint'},look='none'}
local function update(dt)
  context.position,context.direction,context.frame.position=npc.pos,npc.forward,player.pos
  context.playerGap=math.sqrt((npc.pos.x-player.pos.x)^2+(npc.pos.y-player.pos.y)^2)
  actuator.useSpatialBudget(helper.newBudget());actuator.sense(state,npc.pos,context.speed,dt or .1)
  actuator.apply(state,decision,context,true)
end
`;

test('only a clear first native height projection bridges Chang while Hanako keeps the ordinary step band',()=>run(motor+`
local origin=Vector4.new(-1812.455566,-455.850250,7.573303)
local first=Vector4.new(origin.x,origin.y,7.976767)
npc.pos=origin;player.pos=Vector4.new(-1734,-455,8.285)
local nav=Game.GetAINavigationSystem()
nav.CalculatePathForCharacter=function(_,from,destination)
  return {path={Vector4.new(from.x,from.y,first.z),destination},
    CalculateLength=function() return math.sqrt((destination.x-from.x)^2+(destination.y-from.y)^2) end}
end
Game.GetAINavigationSystem=function() return nav end
local obstacle=false
Game.GetSpatialQueriesSystem=function() return {Overlap=function(_,extent,center,_,group)
  if group~='Static' then return false end
  local bottom,top=center.z-extent.z,center.z+extent.z
  if obstacle=='plane' then return bottom<7.82 and top>7.78 end
  return obstacle==true and center.z>9
end} end
-- The recorded ground is 7.572752. Ordinary feet-to-nav stepping rejects
-- the .403464 rise; only the typed first native point may use a strict sweep.
assert(helper.segment(origin,first)==false)
update()
assert(not state.blockedReason and last(npc,'AIFollowTargetCommand'),
  'Chang first native point stayed blocked despite a fully clear strict sweep')
context.speed=1;update(.25);context.speed=0
assert(not state.blockedReason and active(npc)[1].kind=='AIFollowTargetCommand',
  'the running follow dropped its typed first connector')
-- Native follow re-proves its distant route every 0.8 s, with the strict
-- first-connector sweep; the moving-feet guard covers the time between.
obstacle='plane';context.speed=1;update(.9);context.speed=0
assert(state.blockedReason and state.lastRejection.group=='Static',
  'a new plane inside the first connector was missed by the periodic route proof')
state=actuator.new(npc);npc.ai.commands={};obstacle='plane'
assert(helper.segment(origin,Vector4.new(origin.x,origin.y,origin.z+.25),nil,nil,true)==false,
  'a partial first connector lost its strict sweep below the ordinary step band')
update()
assert(state.blockedReason and state.lastRejection.group=='Static',
  'an intervening floor plane inside the strict connector was skipped')
assert(not last(npc,'AIMoveToCommand'))
state=actuator.new(npc);npc.ai.commands={};obstacle=false
first.z=origin.z+.7
update()
assert(state.blockedReason and state.lastRejection.geometryType=='step-slope',
  'a higher native point waived the ordinary slope limit')
-- Hanako's recorded root/nav gap is .213135 m, below the exception. A plane
-- below the normal +.35 walking band must not be swept as though it were Chang.
local hanako=Vector4.new(0,0,7.386871)
local hanakoNav=Vector4.new(0,0,7.600006)
Game.GetSpatialQueriesSystem=function() return {Overlap=function(_,extent,center,_,group)
  local bottom,top=center.z-extent.z,center.z+extent.z
  return group=='Static' and bottom<7.58 and top>7.54
end} end
assert(helper.segment(hanako,hanakoNav,nil,nil,false)==true,
  'Hanako ordinary step was subjected to the strict Chang-only sweep')
`));

test('blocked six-metre temporary prefix admits a shorter point on the same native path',()=>run(motor+`
local origin=Vector4.new(-1806.567139,-450.629608,7.765152)
npc.pos=origin;player.pos=Vector4.new(-1734,-455,8.285)
local nav=Game.GetAINavigationSystem()
nav.CalculatePathForCharacter=function(_,from,destination)
  return {path={from,destination},CalculateLength=function()
    return math.sqrt((destination.x-from.x)^2+(destination.y-from.y)^2+(destination.z-from.z)^2) end}
end
Game.GetAINavigationSystem=function() return nav end
local blockedX=-1800.612493
local queries=0
Game.GetSpatialQueriesSystem=function() return {Overlap=function(_,extent,center,_,group)
  queries=queries+1
  return group=='Static' and extent.x<.5 and extent.y<.5
    and math.abs(center.x-blockedX)<.22
end} end
update()
local follow=last(npc,'AIFollowTargetCommand')
assert(follow and not state.blockedReason,'an artificial six-metre endpoint became a permanent hold')
local legs=state.followRoute
assert(legs and legs[#legs].to.x<blockedX-1,'the blocked endpoint was still admitted')
assert(queries<=192,'fallback exceeded the shared physics budget')
state=actuator.new(npc);npc.ai.commands={}
Game.GetSpatialQueriesSystem=function() return {Overlap=function(_,extent,center,_,group)
  return group=='Static' and extent.x<.5 and extent.y<.5
    and center.x>-1805 and center.x<-1800
end} end
update()
assert(state.lastRejection.stage=='path' and state.lastRejection.temporaryHorizon)
assert(state.detourSearch and active(npc)[1].kind=='AIHoldPositionCommand')
assert(not last(npc,'AIMoveToCommand') and not last(npc,'AIFollowTargetCommand'),
  'all blocked prefixes started unchecked movement')
`));

test('continuous V travel cannot restart local escape search or release its exact owner',()=>run(motor+solids+`
solid('Vehicle',0,3,1.6,1.3)
local firstMove
for frame=1,90 do
  player.pos=Vector4.new(0,8+frame*.38)
  local before=queries;update()
  assert(queries-before<=192,'escape exceeded the shared query budget')
  assert(#active(npc)==1,'a changing far goal released the movement owner')
  if last(npc,'AIMoveToCommand') then firstMove=frame;break end
end
assert(firstMove and firstMove<=35,'local escape waited for V to stop')
assert(state.ticket=='same-follow' and #npc.ai.commands<8,'search restarted its ticket or hold every half second')
`));

test('coasting under a metre refreshes an observed step rejection without changing the step bound',()=>run(motor+`
npc.pos=Vector4.new(0,0,8.01047);player.pos=Vector4.new(5.99,-12.59,8.2)
local nav=Game.GetAINavigationSystem()
nav.CalculatePathForCharacter=function(_,origin,destination)
  return {path={Vector4.new(origin.x,origin.y,8.38422),destination},CalculateLength=function()
    return math.sqrt((destination.x-origin.x)^2+(destination.y-origin.y)^2) end}
end
Game.GetAINavigationSystem=function() return nav end
update();assert(state.blockedReason and state.lastRejection.geometryType=='step-slope')
assert(state.lastRejection.from and state.lastRejection.to and state.lastRejection.allowedRise==.35)
npc.pos=Vector4.new(.32642,-.52139,8.18644)
for i=1,25 do update() if last(npc,'AIFollowTargetCommand') or last(npc,'AIMoveToCommand') then break end end
assert(not state.blockedReason and state.ticket=='same-follow','fresh valid feet retained an obsolete projection hold')
assert(last(npc,'AIFollowTargetCommand') or last(npc,'AIMoveToCommand'))
local clear=helper.segment(Vector4.new(0,0,0),Vector4.new(0,0,.4))
assert(clear==false,'repair raised or skipped the real vertical step guard')
`));

test('a genuinely unchanged vertical transition stays held while bounded native geometry polls refresh metadata',()=>run(motor+`
local nav=Game.GetAINavigationSystem();local reads=0
nav.CalculatePathForCharacter=function(_,origin,destination)
  reads=reads+1
  return {path={Vector4.new(origin.x,origin.y,.4),destination},CalculateLength=function()
    return math.sqrt((destination.x-origin.x)^2+(destination.y-origin.y)^2) end}
end
Game.GetAINavigationSystem=function() return nav end
update();local held=active(npc)[1]
for i=1,50 do update() end
assert(state.lastRejection.geometryType=='step-slope' and state.lastRejection.rise>.35)
assert(reads>=4 and reads<=8,'step geometry was frozen forever or polled every frame')
assert(active(npc)[1]==held and #npc.ai.commands==1)
assert(not last(npc,'AIMoveToCommand') and not last(npc,'AIFollowTargetCommand'))
`));

test('distant catch-up resumes measured Sprint intent after a physically verified local escape',()=>run(motor+solids+`
solid('Vehicle',0,3,2,1.4);player.pos=Vector4.new(0,28)
local outsideFast=false
for i=1,220 do
  update()
  local command=active(npc)[1]
  if not command then break end
  if command.kind=='AIRotateToCommand' then
    local point=command.target.position;local dx,dy=point.x-npc.pos.x,point.y-npc.pos.y
    local length=math.sqrt(dx*dx+dy*dy);npc.forward=Vector4.new(dx/length,dy/length);command.state='Success'
  elseif command.kind=='AIMoveToCommand' then
    local point=command.movementTarget.position
    if npc.pos.y>7 and command.movementType=='Sprint' then outsideFast=true;break end
    npc.pos=point;command.state='Success'
  elseif command.kind=='AIFollowTargetCommand' then
    assert(command.movementType=='Sprint' and not command.teleport)
    outsideFast=true;break
  end
end
assert(outsideFast,'the entire remote route remained forced Walk after the car was cleared')
assert(state.ticket=='same-follow')
`));

test('the real party makes escape progress and resumes catch-up while V keeps moving',()=>run(`
local npc=spawn();tick(4);npc.pos=Vector4.new(0,0)
${solids}
solid('Vehicle',0,3,1.6,1.3)
local firstMove,fast,ticket
for frame=1,180 do
  player.pos=Vector4.new(0,8+frame*.38)
  local before=queries;companions.update(player,.1)
  local row=companions.list()[1]
  assert(not row.error,row.error);assert(queries-before<=192)
  local command=active(npc)[1];assert(command,'party lost the transport-to-travel movement owner')
  if command.kind=='AIRotateToCommand' then
    local point=command.target.position;local dx,dy=point.x-npc.pos.x,point.y-npc.pos.y
    local length=math.sqrt(dx*dx+dy*dy);npc.forward=Vector4.new(dx/length,dy/length);command.state='Success'
  elseif command.kind=='AIMoveToCommand' then
    firstMove=firstMove or frame;ticket=ticket or row.operation.ticket
    local point=command.movementTarget.position
    local dx,dy=point.x-npc.pos.x,point.y-npc.pos.y;local gap=math.sqrt(dx*dx+dy*dy)
    local speed=command.movementType=='Sprint' and 4.5 or command.movementType=='Run' and 2.5 or 1.3
    local step=math.min(gap,speed*.1)
    if gap>0 then npc.pos=Vector4.new(npc.pos.x+dx*step/gap,npc.pos.y+dy*step/gap);npc.forward=Vector4.new(dx/gap,dy/gap) end
    if gap<.18 and command.finishWhenDestinationReached then command.state='Success' end
    if npc.pos.y>7 and command.movementType=='Sprint' then fast=true end
  elseif command.kind=='AIFollowTargetCommand' then fast=command.movementType=='Sprint';break end
  for _,box in ipairs(obstacles) do
    assert(not overlap({x=.4,y=.4,z=1.05},{x=npc.pos.x,y=npc.pos.y,z=1.15},{yaw=0},box),'escape clipped the car')
  end
  if fast then break end
end
assert(firstMove and firstMove<=35,'real behavior waited for V to stop before escaping')
assert(fast,'obstructed behavior kept stale Walk after distant catch-up resumed')
`));

const curvedTravel=`
decision.operation={ticket='curved-travel',kind='move',goal=Vector4.new(0,10),gait='Run',finish=true,face=false}
player.pos=Vector4.new(6,6)
local nav=Game.GetAINavigationSystem();local direct=nav.CalculatePathForCharacter
nav.CalculatePathForCharacter=function(self,origin,destination)
  if origin.x==0 and origin.y==0 and destination.x==0 and destination.y==10 then
    return {path={origin,Vector4.new(2,0),Vector4.new(2,10),destination},CalculateLength=function() return 14 end}
  end
  return direct(self,origin,destination)
end
Game.GetAINavigationSystem=function() return nav end
for i=1,20 do update() if last(npc,'AIMoveToCommand') then break end end
local first=last(npc,'AIMoveToCommand');assert(first)
`;

test('a rolling waypoint hands off before native success without a stop/start animation or second owner',()=>run(motor+curvedTravel+`
local point=first.movementTarget.position
local length=math.sqrt(point.x^2+point.y^2)
npc.pos=Vector4.new(point.x-point.x/length*.25,point.y-point.y/length*.25)
npc.forward=Vector4.new(point.x/length,point.y/length);context.speed=2.4
local stops=0
npc.ai.StopExecutingCommand=function(_,command)
  assert(command==first);stops=stops+1;command.state='Cancelled';return true
end
assert(not first.finishWhenDestinationReached and not first.useStop)
update()
local next=last(npc,'AIMoveToCommand')
assert(next==first and stops==0 and first.state=='Executing','clear continuation restarted native locomotion')
assert(next.movementTarget.position~=point,'continuation retained the old endpoint')
assert(next.movementType=='Run' and not next.useStart and not next.useStop)
assert(#active(npc)==1 and state.ticket=='curved-travel')
`));

test('distant catch-up keeps one native follow command across successive horizons',()=>run(motor+`
player.pos=Vector4.new(0,50,0)
update()
local command=last(npc,'AIFollowTargetCommand');assert(command and not last(npc,'AIMoveToCommand'))
local stops=0
npc.ai.StopExecutingCommand=function(_,owned)
  stops=stops+1;owned.state='Cancelled';return true
end
-- Live traces restarted a MoveTo leg every 0.3-1.0 s while V sprinted.
for i=1,10 do
  npc.pos=Vector4.new(0,npc.pos.y+1.5,0);npc.forward=Vector4.new(0,1,0);context.speed=5
  player.pos=Vector4.new(0,player.pos.y+2.4,0)
  update(.3)
  assert(state.command==command and command.state=='Executing' and stops==0,'catch-up restarted native locomotion')
  assert(#active(npc)==1 and not state.blockedReason)
end
assert(state.followRoute and #state.followRoute>0,'the running follower lost its certified route')
`));

test('terminal waypoint success under exhausted quota immediately owns a safety hold',()=>run(motor+curvedTravel+`
npc.pos=first.movementTarget.position;first.state='Success'
local budget=helper.newBudget();budget.used=budget.limit;actuator.useSpatialBudget(budget)
context.position=npc.pos;actuator.sense(state,npc.pos,0,.1);actuator.apply(state,decision,context,true)
assert(#active(npc)==1 and active(npc)[1].kind=='AIHoldPositionCommand','terminal success freed autonomous following')
assert(state.execution and state.ticket=='curved-travel')
for i=1,10 do update() if active(npc,'AIMoveToCommand')[1] then break end end
assert(active(npc,'AIMoveToCommand')[1] and #active(npc)==1)
`));

test('asynchronous gait-change cancellation rechecks a newly occupied successor before committing it',()=>run(motor+solids+curvedTravel+`
local point=first.movementTarget.position
local length=math.sqrt(point.x^2+point.y^2)
npc.pos=Vector4.new(point.x-point.x/length*.25,point.y-point.y/length*.25)
npc.forward=Vector4.new(point.x/length,point.y/length);context.speed=2.4
decision.operation.gait='Sprint'
local stops=0
npc.ai.StopExecutingCommand=function(_,command) assert(command==first);stops=stops+1;return true end
update();assert(state.cancellation and state.execution.pendingIndex and stops==1)
for i=1,4 do update() assert(state.command==first and #npc.ai.commands==1) end
for i=state.execution.minimumIndex,state.execution.pendingIndex do
  local target=state.execution.points[i];solid('Vehicle',target.x,target.y,.6,.6)
end
first.state='Cancelled';context.speed=0
for i=1,10 do update() if state.blockedReason then break end end
assert(state.blockedReason and #active(npc)==1 and active(npc)[1].kind=='AIHoldPositionCommand')
assert(not active(npc,'AIMoveToCommand')[1],'retired preparation granted movement through a new car')
`));

test('corridor monitoring follows the freshly certified native bend rather than its straight chord',()=>run(motor+`
decision.operation={ticket='native-bend',kind='move',goal=Vector4.new(0,10),gait='Run',finish=true,face=false}
player.pos=Vector4.new(6,6)
local nav=Game.GetAINavigationSystem();local direct=nav.CalculatePathForCharacter
nav.CalculatePathForCharacter=function(self,origin,destination)
  if origin.x==0 and origin.y==0 then
    return {path={origin,Vector4.new(2,0),destination},CalculateLength=function()
      return 2+math.sqrt((destination.x-2)^2+destination.y^2) end}
  end
  return direct(self,origin,destination)
end
Game.GetAINavigationSystem=function() return nav end
update();local command=last(npc,'AIMoveToCommand');assert(command)
npc.pos=Vector4.new(1.5,0);npc.forward=Vector4.new(1,0);context.speed=1.3
update()
assert(not state.blockedReason and state.command==command,'valid native corner movement was mistaken for corridor escape')
assert(#state.execution.commandRoute>=2)
`));

test('terminal native success between sense and apply cannot free the deferred waypoint owner',()=>run(motor+curvedTravel+`
npc.pos=first.movementTarget.position;context.position=npc.pos;context.speed=0
actuator.sense(state,npc.pos,0,.1)
assert(state.feedback.active)
first.state='Success'
actuator.apply(state,decision,context,false)
assert(#active(npc)==1 and active(npc)[1].kind=='AIHoldPositionCommand')
assert(state.ticket=='curved-travel' and state.execution)
`));

test('moving V and a small query slice retain fixed escape receipts and eventually acquire walking',()=>run(motor+solids+`
solid('Vehicle',0,3,1.6,1.3)
local firstMove
for frame=1,100 do
  player.pos=Vector4.new(0,8+frame*.38)
  context.position=npc.pos;context.frame.position=player.pos;context.playerGap=player.pos.y
  local budget=helper.newBudget();budget.limit=24;actuator.useSpatialBudget(budget)
  local before=queries;actuator.sense(state,npc.pos,0,.1);actuator.apply(state,decision,context,true)
  assert(queries-before<=24 and #active(npc)==1)
  if last(npc,'AIMoveToCommand') then firstMove=frame;break end
end
assert(firstMove and firstMove<60,'moving V restarted a quota-deferred local receipt or commit forever')
assert(state.ticket=='same-follow')
`));

test('V entering a quota-deferred local prefix is freshly excluded before any walking grant',()=>run(motor+solids+`
solid('Vehicle',0,3,1.6,1.3)
for i=1,20 do
  context.frame.position=player.pos
  local budget=helper.newBudget();budget.limit=12;actuator.useSpatialBudget(budget)
  actuator.sense(state,npc.pos,0,.1);actuator.apply(state,decision,context,true)
  if state.routeProbe and state.routeProbe.legs then break end
end
assert(state.routeProbe and state.routeProbe.legs and not last(npc,'AIMoveToCommand'))
local leg=state.routeProbe.legs[1]
player.pos=Vector4.new((leg.from.x+leg.to.x)/2,(leg.from.y+leg.to.y)/2,0)
context.frame.position=player.pos;context.playerGap=3
actuator.useSpatialBudget(helper.newBudget());actuator.sense(state,npc.pos,0,.1)
actuator.apply(state,decision,context,true)
assert(not last(npc,'AIMoveToCommand') and active(npc)[1].kind=='AIHoldPositionCommand')
assert(state.lastRejection.stage=='player','retained planner physics prefix masked a new V crossing')
`));

test('a foreign vehicle arriving during successor preparation never receives a coalesced walking command',()=>run(motor+solids+curvedTravel+`
local point=first.movementTarget.position;local length=math.sqrt(point.x^2+point.y^2)
npc.pos=Vector4.new(point.x-point.x/length*.25,point.y-point.y/length*.25)
npc.forward=Vector4.new(point.x/length,point.y/length);context.position=npc.pos;context.speed=2.4
local budget=helper.newBudget();budget.limit=6;actuator.useSpatialBudget(budget)
actuator.sense(state,npc.pos,2.4,.1);actuator.apply(state,decision,context,true)
local target=state.routeProbe and state.routeProbe.target
assert(target,'successor preparation was not quota deferred')
solid('Vehicle',target.x,target.y,.7,.7)
for i=1,5 do update() end
for _,command in ipairs(npc.ai.commands) do
  if command.kind=='AIMoveToCommand' and command~=first then
    local goal=command.movementTarget.position
    assert(math.sqrt((goal.x-target.x)^2+(goal.y-target.y)^2)>.7,'a stale successor clipped the arriving vehicle')
  end
end
assert(#active(npc)==1)
`));

test('release and abandonment retire all escape, horizon and handoff receipts without reviving them',()=>run(motor+solids+`
solid('Vehicle',0,3,1.6,1.3)
for i=1,20 do update() if state.execution then break end end
assert(state.execution or state.detourSearch)
assert(actuator.release(state))
assert(not state.execution and not state.detourSearch and not state.routeProbe and not state.recoveryTicket and not state.completedEscapeTicket)
decision.operation={ticket='released',kind='release'};update()
assert(#active(npc)==0)
npc.ai.GetCommandState=function() error('query after abandoned native lifetime') end
actuator.abandon(state)
assert(not state.command and not state.execution and not state.detourSearch)
`));

test('an impossible local floor transition remains held and inspectable without any navigation bypass',()=>run(motor+`
decision.operation={ticket='wrong-floor',kind='move',goal=Vector4.new(0,8),gait='Walk',finish=true,face=false}
player.pos=Vector4.new(4,8)
local nav=Game.GetAINavigationSystem()
nav.CalculatePathForCharacter=function(_,origin,destination)
  return {path={origin,Vector4.new(1,2,2),destination},CalculateLength=function() return 10 end}
end
Game.GetAINavigationSystem=function() return nav end
update();local held=active(npc)[1]
for i=1,35 do update() end
assert(state.lastRejection.geometryType=='floor' and state.lastRejection.allowedRise==1.4)
assert(state.lastRejection.rise==2 and active(npc)[1]==held)
assert(not last(npc,'AIMoveToCommand') and not last(npc,'AIFollowTargetCommand'))
`));

test('unknown physics at escape handoff keeps a hold instead of starting distant following',()=>run(motor+solids+`
solid('Vehicle',0,3,1.6,1.3)
local atBoundary=false
for i=1,70 do
  update()
  local command=active(npc)[1]
  if command and command.kind=='AIRotateToCommand' then
    local point=command.target.position;local dx,dy=point.x-npc.pos.x,point.y-npc.pos.y
    local length=math.sqrt(dx*dx+dy*dy);npc.forward=Vector4.new(dx/length,dy/length);command.state='Success'
  elseif command and command.kind=='AIMoveToCommand' then
    npc.pos=command.movementTarget.position
    if state.execution and state.execution.mode=='escape' and state.execution.index==#state.execution.points then
      atBoundary=true;break
    end
    command.state='Success'
  end
end
assert(atBoundary)
Game.GetSpatialQueriesSystem=function() error('native scene physics unavailable') end
for i=1,10 do update() end
assert(state.blockedReason and #active(npc)==1 and active(npc)[1].kind=='AIHoldPositionCommand')
assert(not last(npc,'AIFollowTargetCommand'),'escape success bypassed unavailable distant clearance')
`));

test('completed escape placement context belongs only to its exact operation ticket',()=>run(motor+solids+`
solid('Vehicle',0,3,1.6,1.3)
for i=1,90 do
  update()
  local command=active(npc)[1]
  if command.kind=='AIRotateToCommand' then
    local point=command.target.position;local dx,dy=point.x-npc.pos.x,point.y-npc.pos.y
    local length=math.sqrt(dx*dx+dy*dy);npc.forward=Vector4.new(dx/length,dy/length);command.state='Success'
  elseif command.kind=='AIMoveToCommand' then npc.pos=command.movementTarget.position;command.state='Success'
  elseif command.kind=='AIFollowTargetCommand' then break end
end
assert(state.completedEscapeTicket==state.ticket and last(npc,'AIFollowTargetCommand'))
decision.operation={ticket='new-resting-operation',kind='hold'};update()
assert(not state.completedEscapeTicket and not state.recoveryTicket)
actuator.sense(state,npc.pos,0,.1)
assert(state.feedback.ticket=='new-resting-operation' and not state.feedback.afterEscape)
`));
