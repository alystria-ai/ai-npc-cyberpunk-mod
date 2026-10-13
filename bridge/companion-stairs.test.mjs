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

// Live 2026-10-13, Heywood/Glen: Carol stopped at the foot of a 33 degree flight
// (rise 2.5-2.9 m), was marked stranded and teleported. The flight below is a
// continuous ramp: ground z=0 up to y=4, then 0.6 m of rise per metre to y=8
// (z=2.4), then a flat landing. Physics boxes hit it wherever it rises above
// their bottom; the navmesh answers with the ramp's own height.
const stairs=`
local function surface(x,y)
  if math.abs(x)>3 then return 0 end
  if y<=4 then return 0 end
  if y>=8 then return 2.4 end
  return (y-4)*.6
end
local npc=spawn();npc.ai.commands={};npc.pos=Vector4.new(0,1,0)
player.pos=Vector4.new(0,14,2.4)
local motor=dofile('companion-actuator.lua');local state=motor.new(npc)
local helper=dofile('companion-clearance.lua')
local nav=Game.GetAINavigationSystem()
local navQueries=0
nav.FindPointInSphereForCharacter=function(_,point,radius)
  navQueries=navQueries+1
  local z=surface(point.x,point.y)
  if math.abs(z-point.z)>(radius or .5)+1e-6 then return {status='Failed'} end
  return {status='OK',point=Vector4.new(point.x,point.y,z)}
end
nav.CalculatePathForCharacter=function(_,origin,destination)
  local points={origin}
  local length=math.sqrt((destination.x-origin.x)^2+(destination.y-origin.y)^2)
  local count=math.max(1,math.ceil(length))
  for i=1,count-1 do
    local x=origin.x+(destination.x-origin.x)*i/count;local y=origin.y+(destination.y-origin.y)*i/count
    points[#points+1]=Vector4.new(x,y,surface(x,y))
  end
  points[#points+1]=destination
  return {path=points,CalculateLength=function() return length+(destination.z-origin.z)^2/10 end}
end
Game.GetAINavigationSystem=function() return nav end
local boxes={}
Game.GetSpatialQueriesSystem=function() return {Overlap=function(_,extent,center,rotation,group)
  boxes[#boxes+1]=group
  if group~='Static' then return false end
  local yaw=math.rad(rotation.yaw or 0)
  local ux,uy=math.cos(yaw),math.sin(yaw);local vx,vy=-uy,ux
  local bottom=center.z-extent.z
  for a=-4,4 do for b=-4,4 do
    local px=center.x+ux*extent.x*a/4+vx*extent.y*b/4
    local py=center.y+uy*extent.x*a/4+vy*extent.y*b/4
    if surface(px,py)>bottom then return true end
  end end
  return false
end} end
local context={position=npc.pos,direction=npc.forward,speed=0,player=player,slot=1,playerGap=13,
  frame={position=player.pos,moving=true,rawSpeed=0},others={},id=npc.id.hash}
local decision={operation={ticket='stairs',kind='follow',gait='Run'},look='none'}
local function update(dt,speed)
  context.position,context.frame.position=npc.pos,player.pos
  context.speed=speed or 0
  context.playerGap=math.sqrt((npc.pos.x-player.pos.x)^2+(npc.pos.y-player.pos.y)^2)
  motor.useSpatialBudget(helper.newBudget());motor.sense(state,npc.pos,context.speed,dt or .1)
  motor.apply(state,decision,context,true)
end
-- Walks the copy up the ramp at 3 m/s with the feet on the surface.
local function climb(to,onStep)
  local y=npc.pos.y
  while y<to do
    y=y+.3
    npc.pos=Vector4.new(0,y,surface(0,y))
    update(.1,3)
    if onStep then onStep(y) end
  end
end
`;

test('the model reproduces the live failure: a level box at the foot of the flight hits Static',()=>run(stairs+`
local clear,_,_,hit=helper.segment(Vector4.new(0,3,0),Vector4.new(0,5,0))
assert(clear==false and hit.group=='Static','level sweep did not meet the rising treads')
assert(helper.body(Vector4.new(0,6,1.2))==false,'a standing body on the flight did not meet the treads')
`));

test('a follower climbs the flight under the moving-feet guard without being held as blocked',()=>run(stairs+`
update(.1,0)
assert(last(npc,'AIFollowTargetCommand') and not state.blockedReason,'the first follow was not admitted')
local follower=last(npc,'AIFollowTargetCommand')
climb(9,function(y)
  local r=state.lastRejection
  assert(not state.blockedReason,'blocked at y='..y..' by '..tostring(r and r.stage)..' '..tostring(r and r.group))
end)
assert(npc.pos.z>2.3,'the fixture did not reach the landing')
assert(not last(npc,'AIHoldPositionCommand'),'a safety hold was issued on the stairs')
`));

test('a wall standing across the flight still stops the moving-feet guard',()=>run(stairs+`
local previous=Game.GetSpatialQueriesSystem()
Game.GetSpatialQueriesSystem=function() return {Overlap=function(_,extent,center,rotation,group)
  -- A full-height wall across the flight at y=6.
  if group=='Static' and math.abs(center.y-6)<extent.y+.1 then return true end
  return previous.Overlap(_,extent,center,rotation,group)
end} end
update(.1,0)
local blocked
climb(5.6,function() blocked=blocked or state.blockedReason end)
assert(blocked,'the raised stair band waived a genuine wall')
`));

test('the follow stand-off is taken on the flight, not at the height of V above it',()=>run(stairs+`
npc.pos=Vector4.new(0,3,0);player.pos=Vector4.new(0,7,1.8)
update(.1,0)
assert(not state.blockedReason and last(npc,'AIFollowTargetCommand'),
  'V mid-flight made the follow stand-off unresolvable: '..tostring(state.lastRejection and state.lastRejection.stage))
assert(state.destinationProjection and math.abs(state.destinationProjection.requested.z-1.035)<.05,
  'the stand-off kept V height '..tostring(state.destinationProjection and state.destinationProjection.requested.z))
`));

test('a flat sweep stays level: a wall at the same height still blocks the level ground',()=>run(stairs+`
npc.pos=Vector4.new(0,0,0);player.pos=Vector4.new(0,3.5,0)
local previous=Game.GetSpatialQueriesSystem()
Game.GetSpatialQueriesSystem=function() return {Overlap=function(_,extent,center,rotation,group)
  if group=='Static' and math.abs(center.y-1.5)<extent.y+.1 and center.z-extent.z<1 then return true end
  return previous.Overlap(_,extent,center,rotation,group)
end} end
context.frame.position=player.pos
update(.1,0)
local blocked
for i=1,8 do npc.pos=Vector4.new(0,i*.2,0);update(.1,2);blocked=blocked or state.blockedReason end
assert(blocked,'a wall on flat ground no longer blocks')
`));
