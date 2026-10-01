import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(companionEngine + code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(status, lua.LUA_OK, error);
}

// Native-style box queries against world solids. Navmesh deliberately remains
// flat and walks through these boxes, reproducing parked cars not carved into
// the navigation route. A rotated query uses all four 2D separating axes.
const solids = `
  local obstacles,queries={},0
  local function overlaps(extents,center,rotation,box)
    if center.z+extents.z<box.z-box.hz or center.z-extents.z>box.z+box.hz then return false end
    local angle=math.rad(rotation.yaw or 0)
    local ux,uy=math.cos(angle),math.sin(angle)
    local vx,vy=-uy,ux
    local dx,dy=box.x-center.x,box.y-center.y
    if math.abs(dx)>math.abs(ux)*extents.x+math.abs(vx)*extents.y+box.hx then return false end
    if math.abs(dy)>math.abs(uy)*extents.x+math.abs(vy)*extents.y+box.hy then return false end
    if math.abs(dx*ux+dy*uy)>extents.x+box.hx*math.abs(ux)+box.hy*math.abs(uy) then return false end
    if math.abs(dx*vx+dy*vy)>extents.y+box.hx*math.abs(vx)+box.hy*math.abs(vy) then return false end
    return true
  end
  Game.GetSpatialQueriesSystem=function() return {
    Overlap=function(_,extents,center,rotation,group)
      queries=queries+1
      for _,box in ipairs(obstacles) do
        if box.group==group and overlaps(extents,center,rotation,box) then return true end
      end
      return false
    end
  } end
  local function solid(group,x,y,hx,hy,z,hz)
    obstacles[#obstacles+1]={group=group,x=x,y=y,hx=hx,hy=hy,z=z or 0.8,hz=hz or 0.8}
  end
`;

const walking = `
  local npc=spawn(); tick(4)
  npc.ai.commands={}
  npc.pos=Vector4.new(0,0)
  player.pos=Vector4.new(4,6)
  local motor=dofile('companion-actuator.lua')
  local state=motor.new(npc)
  local context={position=npc.pos,direction=npc.forward,speed=0,player=player,slot=1,
    playerGap=8,frame={position=player.pos},others={},id=npc.id.hash}
  local decision={operation={ticket='walk',kind='move',goal=Vector4.new(0,6),
    gait='Walk',finish=true,face=false},look='none'}
  local function update(dt,canPlan)
    context.position,context.direction=npc.pos,npc.forward
    motor.sense(state,npc.pos,context.speed,dt or 0.1)
    return motor.apply(state,decision,context,canPlan~=false)
  end
`;

for (const group of ['Static', 'Vehicle', 'Dynamic', 'Collider', 'Destructible']) {
  test(`a ${group} solid on a clear navmesh cannot receive a walking command`, () => run(walking + solids + `
    solid('${group}',0,3,0.6,0.02)
    update()
    assert(not last(npc,'AIMoveToCommand'),'navigation alone admitted a solid obstacle')
    assert(last(npc,'AIHoldPositionCommand'),'native follower role must be held while blocked')
    assert(state.failed and state.blockedReason)
  `));
}

test('an obstructed preferred stance selects a physically clear alternative route', () => run(walking + solids + `
  solid('Vehicle',0,3,0.8,0.8)
  context.alternatives={Vector4.new(3,1.4)}
  update()
  local move=last(npc,'AIMoveToCommand')
  assert(move and move.movementTarget.position.x==3)
  assert(move.ignoreNavigation==false and not state.failed)
`));

test('arrival tests body width even when the destination center misses the car', () => run(walking + solids + `
  solid('Vehicle',0.65,6,0.3,0.5)
  update()
  assert(not last(npc,'AIMoveToCommand'),'the arrival body would be inside the parked car')
`));

test('a navigation route starting past an obstacle cannot hide the first walking leg', () => run(walking + solids + `
  solid('Static',0,2,0.8,0.2)
  local nav=Game.GetAINavigationSystem()
  nav.CalculatePathForCharacter=function(_,origin,destination)
    return {path={Vector4.new(0,4),destination},CalculateLength=function() return 2 end}
  end
  Game.GetAINavigationSystem=function() return nav end
  update()
  assert(not last(npc,'AIMoveToCommand'),'the connector from the actual feet was unchecked')
`));

test('a native detour around a parked car is accepted without replacing navigation', () => run(walking + solids + `
  solid('Vehicle',0,3,0.8,0.8)
  local nav=Game.GetAINavigationSystem()
  nav.CalculatePathForCharacter=function(_,origin,destination)
    return {path={origin,Vector4.new(2,0),Vector4.new(2,6),destination},
      CalculateLength=function() return 10 end}
  end
  Game.GetAINavigationSystem=function() return nav end
  update()
  assert(last(npc,'AIMoveToCommand') and not state.failed)
`));

test('a vehicle entering during the preparation turn prevents the walking command', () => run(walking + solids + `
  decision.operation.goal=Vector4.new(0,-4)
  update()
  local turn=last(npc,'AIRotateToCommand'); assert(turn)
  solid('Vehicle',0,-2,0.8,0.6)
  turn.state='Success'; npc.forward=Vector4.new(0,-1)
  update(0.5)
  assert(not last(npc,'AIMoveToCommand'))
  assert(state.blockedReason and active(npc)[1].kind=='AIHoldPositionCommand')
`));

test('native follow and navigation recovery cannot bypass a parked-car rejection', () => run(walking + solids + `
  player.pos=Vector4.new(0,7); context.frame.position=player.pos
  solid('Vehicle',0,3,1,1)
  decision.operation={ticket='recover',kind='follow',gait='Run'}
  update()
  assert(not last(npc,'AIFollowTargetCommand'),'unvalidated follow bypassed the blocked route')
  assert(active(npc)[1].kind=='AIHoldPositionCommand')
  local count=#npc.ai.commands
  for i=1,120 do update(0.1) end
  assert(#npc.ai.commands==count,'blocked follow submitted commands every update')
`));

test('an occupied finite route is cancelled and held when a vehicle arrives after issue', () => run(walking + solids + `
  update()
  local move=last(npc,'AIMoveToCommand'); assert(move)
  solid('Vehicle',0,3,0.8,0.8)
  update(0.9)
  assert(move.state~='Executing' and state.blockedReason)
  assert(#active(npc)==1 and active(npc)[1].kind=='AIHoldPositionCommand')
  assert(not motor.sense(state,npc.pos,0,0.1).complete,'safety hold was reported as a successful arrival')
`));

test('a close motion obstacle stops the owned command even when the planning budget is busy', () => run(walking + solids + `
  update()
  local move=last(npc,'AIMoveToCommand'); assert(move)
  -- Native steering has moved off the accepted northbound route toward a car.
  npc.pos=Vector4.new(0.3,0); context.speed=1
  solid('Vehicle',1.15,0,0.25,0.7)
  update(0.3,false)
  assert(move.state~='Executing' and state.blockedReason)
  assert(active(npc)[1].kind=='AIHoldPositionCommand')
`));

test('obstacle cancellation retains the exact command until native terminal confirmation', () => run(walking + solids + `
  update()
  local move=last(npc,'AIMoveToCommand'); local stops=0
  npc.ai.StopExecutingCommand=function(_,command)
    assert(command==move); stops=stops+1; return true
  end
  solid('Vehicle',0,3,0.8,0.8)
  update(0.9)
  for i=1,30 do update(0.1) end
  assert(stops==1 and #npc.ai.commands==1,'a hold overlapped the pending native stop')
  move.state='Cancelled'
  update()
  assert(#npc.ai.commands==2 and active(npc)[1].kind=='AIHoldPositionCommand')
`));

for (const broken of ['spatial', 'navigation']) {
  test(`loss of ${broken} verification retires an already active route`, () => run(walking + solids + `
    update()
    local move=last(npc,'AIMoveToCommand'); assert(move)
    if '${broken}'=='spatial' then
      Game.GetSpatialQueriesSystem=function() error('query system unavailable') end
    else
      Game.GetAINavigationSystem=function() error('navigation unavailable') end
    end
    update(0.9)
    assert(move.state~='Executing' and state.failed)
    assert(active(npc)[1].kind=='AIHoldPositionCommand')
  `));
}

test('large model clearance reaches the movement adapter instead of a human-sized probe', () => run(walking + solids + `
  state=motor.new(npc,{radius=0.9,height=3})
  solid('Vehicle',1.1,6,0.3,0.6)
  update()
  assert(not last(npc,'AIMoveToCommand'),'large model body clipped the parked car')
`));

test('a member waiting for a planning slot keeps an owned hold until its route is checked', () => run(walking + solids + `
  solid('Vehicle',0,3,0.8,0.8)
  for i=1,8 do update(0.1,false) end
  assert(#npc.ai.commands==1 and active(npc)[1].kind=='AIHoldPositionCommand')
  assert(not last(npc,'AIMoveToCommand'))
  update()
  assert(state.blockedReason and active(npc)[1].kind=='AIHoldPositionCommand')
`));

test('a blocked operation renews its hold before native expiry without a command storm', () => run(walking + solids + `
  solid('Vehicle',0,3,0.8,0.8)
  update()
  for i=1,380 do update(0.1) end
  assert(#npc.ai.commands==2,'a finite hold expired or was renewed every update')
  assert(#active(npc)==1 and active(npc)[1].kind=='AIHoldPositionCommand')
`));

test('a planted car keeps the party in owned bounded waits instead of autonomous traversal', () => run(`
  local npc=spawn(); tick(4)
  ${solids}
  solid('Vehicle',0,3,20,1)
  player.pos=Vector4.new(0,8)
  local initial=#npc.ai.commands
  local space=dofile('companion-space.lua')
  for i=1,200 do
    companions.update(player,0.1)
    local command=active(npc)[1]
    assert(command and command.kind=='AIHoldPositionCommand','the default follower role regained movement')
    -- A deliberately collision-free engine stand-in would follow straight
    -- through the car unless this controller retained its blocking hold.
    if not command or command.kind=='AIFollowTargetCommand' or command.kind=='AIMoveToCommand' then
      local goal=command and command.kind=='AIMoveToCommand' and command.movementTarget.position or player.pos
      npc.pos=space.offset(npc.pos,space.bearing(npc.pos,goal),0,0.15)
    end
    assert(npc.pos.y<2,'a companion traversed the planted car')
    assert(not companions.list()[1].error,companions.list()[1].error)
  end
  assert(#npc.ai.commands-initial<15,'blocked recovery became a command storm')
  for i=initial+1,#npc.ai.commands do
    assert(npc.ai.commands[i].kind=='AIHoldPositionCommand','movement was dispatched into the car')
  end
  obstacles={}
  for i=1,80 do companions.update(player,0.1) end
  local follow=last(npc,'AIFollowTargetCommand')
  assert(follow and follow.teleport==false,'clearing the obstruction did not resume ordinary navigation')
`));
