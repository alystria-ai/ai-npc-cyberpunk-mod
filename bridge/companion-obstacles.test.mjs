import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program=companionEngine+code;
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  const line=Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state); assert.equal(status, lua.LUA_OK, error+(line?'\n'+program.split('\n')[line-1]:''));
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
    if destination.x~=0 or destination.y~=6 or origin.x~=0 or origin.y~=0 then
      return {path={origin,destination},CalculateLength=function()
        return math.sqrt((destination.x-origin.x)^2+(destination.y-origin.y)^2)
      end}
    end
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
  solid('Vehicle',0,3,20,1)
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
  solid('Vehicle',0,3,20,0.8)
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
  local rejectedTicket
  local space=dofile('companion-space.lua')
  for i=1,200 do
    companions.update(player,0.1)
    local command=active(npc)[1]
    assert(command and command.kind=='AIHoldPositionCommand','the default follower role regained movement at '..i..
      ' phase '..tostring(companions.list()[1].behavior)..' stage '..tostring(companions.list()[1].operation.stage)..
      ' command '..tostring(command and command.kind))
    -- A deliberately collision-free engine stand-in would follow straight
    -- through the car unless this controller retained its blocking hold.
    if not command or command.kind=='AIFollowTargetCommand' or command.kind=='AIMoveToCommand' then
      local goal=command and command.kind=='AIMoveToCommand' and command.movementTarget.position or player.pos
      npc.pos=space.offset(npc.pos,space.bearing(npc.pos,goal),0,0.15)
    end
    assert(npc.pos.y<2,'a companion traversed the planted car')
    assert(not companions.list()[1].error,companions.list()[1].error)
    local feedback=companions.list()[1].operation
    if feedback.blocked then
      rejectedTicket=rejectedTicket or feedback.ticket
      assert(feedback.ticket==rejectedTicket,'unchanged obstruction restarted the same recovery ticket')
      assert(feedback.rejection and feedback.rejection.group=='Vehicle')
    end
  end
  assert(#npc.ai.commands-initial<15,'blocked recovery became a command storm')
  assert(rejectedTicket,'the rejection stage was absent from the party snapshot')
  for i=initial+1,#npc.ai.commands do
    assert(npc.ai.commands[i].kind=='AIHoldPositionCommand','movement was dispatched into the car')
  end
  obstacles={}
  for i=1,80 do companions.update(player,0.1) end
  local follow=last(npc,'AIFollowTargetCommand')
  assert(follow and follow.teleport==false,'clearing the obstruction did not resume ordinary navigation')
`));

const executeDetour = `
  local helper=dofile('companion-clearance.lua')
  -- Same-gait legs retarget the one owned command (October 5 command
  -- continuity), so count distinct certified waypoint goals, not commands.
  local travelled,waypoints,targets=0,{},{}
  for frame=1,600 do
    motor.useSpatialBudget(helper.newBudget())
    update(0.1)
    assert(#active(npc)==1 or state.feedback.complete,
      'detour lost exclusive locomotion ownership at '..frame..' stage '..tostring(state.stage)..
      ' state '..tostring(state.feedback.state))
    if state.feedback.complete then break end
    local command=active(npc)[1]
    if command.kind=='AIFollowTargetCommand' then break end
    if command.kind=='AIMoveToCommand' then
      local goal=command.movementTarget.position
      if #waypoints==0 or waypoints[#waypoints]~=command then waypoints[#waypoints+1]=command end
      local seen=targets[#targets]
      if not seen or math.abs(seen.x-goal.x)>.01 or math.abs(seen.y-goal.y)>.01 then targets[#targets+1]={x=goal.x,y=goal.y} end
      assert(command.ignoreNavigation==false and not command.rotateEntityTowardsFacingTarget)
      local gap=math.sqrt((goal.x-npc.pos.x)^2+(goal.y-npc.pos.y)^2)
      local step=math.min(gap,0.1)
      if gap>0 then
        local next=Vector4.new(npc.pos.x+(goal.x-npc.pos.x)*step/gap,
          npc.pos.y+(goal.y-npc.pos.y)*step/gap,npc.pos.z)
        -- A NPC is a round capsule. Test its true footprint against the solid;
        -- a heading-independent .4 m square has corners the swept (rotated)
        -- clearance box rightly does not claim.
        for _,box in ipairs(obstacles) do
          local nearX=math.max(box.x-box.hx,math.min(next.x,box.x+box.hx))
          local nearY=math.max(box.y-box.hy,math.min(next.y,box.y+box.hy))
          local vertical=next.z<box.z+box.hz and next.z+2.1>box.z-box.hz
          assert(not (vertical and (next.x-nearX)^2+(next.y-nearY)^2<.4*.4),
            'a validated detour command crossed the parked vehicle')
        end
        npc.forward=Vector4.new((goal.x-npc.pos.x)/gap,(goal.y-npc.pos.y)/gap)
        npc.pos=next; travelled=travelled+step; context.speed=step/.1
      end
      if gap<=.18 then command.state='Success'; context.speed=0 end
    elseif command.kind=='AIRotateToCommand' then
      local goal=command.target.position
      local gap=math.sqrt((goal.x-npc.pos.x)^2+(goal.y-npc.pos.y)^2)
      npc.forward=Vector4.new((goal.x-npc.pos.x)/gap,(goal.y-npc.pos.y)/gap)
      command.state='Success'; context.speed=0
    else context.speed=0 end
    if state.feedback.complete then break end
  end
`;

test('a parked car omitted by native navigation produces executed clearance-checked waypoints',()=>run(walking+solids+`
  solid('Vehicle',0,3,.85,1.3)
  update()
  assert(state.lastRejection and state.lastRejection.group=='Vehicle')
  assert(state.lastRejection.stage=='path' and state.lastRejection.leg and state.lastRejection.box)
  ${executeDetour}
  assert(travelled>6 and #targets>=3,'only the final goal was submitted after biased preflight')
  assert(math.sqrt(npc.pos.x^2+(npc.pos.y-6)^2)<.4,'the detour never completed the original approach')
  assert(state.feedback.complete and not state.feedback.failed)
`));

test('blocked catch-up checks a free stand-off and hands its certified local escape to verified follow',()=>run(walking+solids+`
  player.pos=Vector4.new(0,8); context.frame.position=player.pos
  context.playerGap=8
  decision.operation={ticket='catch-up',kind='follow',gait='Run'}
  solid('Vehicle',0,3,.9,1.3)
  solid('Dynamic',0,8,.3,.3)
  ${executeDetour}
  assert(travelled>6 and #targets>=3)
  local follow=last(npc,'AIFollowTargetCommand')
  assert(follow and state.completedEscapeTicket==state.ticket,'local escape never acquired a verified follow owner')
  assert(not state.feedback.complete and not state.feedback.failed,'local success completed the whole follow operation')
  assert(follow.desiredDistance>=1.7 and math.sqrt((state.target.x-player.pos.x)^2+(state.target.y-player.pos.y)^2)>=1.69,
    'follow validation targeted V occupied centre instead of a stand-off')
`));

test('detour quota deferral retains the exact safety owner and release clears pending route work',()=>run(walking+solids+`
  solid('Vehicle',0,3,.9,1.3)
  local helper=dofile('companion-clearance.lua')
  motor.useSpatialBudget(helper.newBudget()); update()
  local held=active(npc)[1]; assert(held.kind=='AIHoldPositionCommand')
  for i=1,10 do
    local budget=helper.newBudget(); budget.used=budget.limit; motor.useSpatialBudget(budget)
    update(.1)
    assert(active(npc)[1]==held and #npc.ai.commands==1,'quota exhaustion replaced the held owner')
  end
  assert(state.detourSearch and not state.feedback.failed)
  assert(motor.release(state))
  assert(not state.detourSearch and not state.routeProbe and not state.execution)
  motor.useSpatialBudget(helper.newBudget())
  decision.operation={ticket='released',kind='release'}; update()
  assert(#npc.ai.commands==1,'retired detour resumed after release')
`));

test('a moving foreign vehicle invalidates the next detour leg before native movement can use it',()=>run(walking+solids+`
  solid('Vehicle',0,3,.9,1.3)
  for i=1,20 do
    update(.1)
    local turn=last(npc,'AIRotateToCommand')
    if turn and turn.state=='Executing' then
      local point=turn.target.position
      local dx,dy=point.x-npc.pos.x,point.y-npc.pos.y
      local length=math.sqrt(dx*dx+dy*dy)
      npc.forward=Vector4.new(dx/length,dy/length); turn.state='Success'
    end
    if last(npc,'AIMoveToCommand') then break end
  end
  local command=last(npc,'AIMoveToCommand'); assert(command,
    'stage '..tostring(state.stage)..' search '..tostring(state.detourSearch and state.detourSearch.index)..
    ' leg '..tostring(state.detourSearch and state.detourSearch.leg)..' commands '..#npc.ai.commands..
    ' blocked '..tostring(state.blockedReason))
  local target=command.movementTarget.position
  solid('Vehicle',target.x,target.y,.6,.6)
  update(.9)
  assert(command.state~='Executing' and state.blockedReason)
  assert(active(npc)[1].kind=='AIHoldPositionCommand')
  assert(state.lastRejection.group=='Vehicle' and not state.feedback.complete)
`));

test('a detour cannot overlap an asynchronously cancelling hold and abandon never calls torn-down native state',()=>run(walking+solids+`
  solid('Vehicle',0,3,.9,1.3)
  update(); local held=active(npc)[1]
  local requests=0
  npc.ai.StopExecutingCommand=function(_,command)
    assert(command==held); requests=requests+1; return true
  end
  for i=1,30 do update(.1) end
  assert(requests==1 and #npc.ai.commands==1 and state.command==held)
  held.state='Cancelled'; update()
  local turn=last(npc,'AIRotateToCommand')
  if turn then
    local point=turn.target.position
    local dx,dy=point.x-npc.pos.x,point.y-npc.pos.y
    local length=math.sqrt(dx*dx+dy*dy)
    npc.forward=Vector4.new(dx/length,dy/length); turn.state='Success'; update()
  end
  assert(#active(npc)==1 and active(npc)[1].kind=='AIMoveToCommand',
    'stage '..tostring(state.stage)..' search '..tostring(state.detourSearch and state.detourSearch.index)..
    ' command '..tostring(active(npc)[1] and active(npc)[1].kind))
  npc.ai.GetCommandState=function() error('native state was torn down') end
  npc.ai.StopExecutingCommand=function() error('native state was torn down') end
  motor.abandon(state)
  assert(not state.command and not state.execution and not state.detourSearch)
`));

test('the actual party behavior completes blocked catch-up without replacing the detour ticket',()=>run(`
  local npc=spawn(); tick(4)
  ${solids}
  solid('Vehicle',0,3,1.6,1.3)
  player.pos=Vector4.new(0,8)
  local detourTicket,detourCommands,arrived=nil,0,false
  for i=1,400 do
    companions.update(player,.1)
    local row=companions.list()[1]
    assert(not row.error,row.error)
    if row.operation.route and row.operation.route.kind=='waypoints' and not row.operation.complete then
      detourTicket=detourTicket or row.operation.ticket
      assert(row.operation.ticket==detourTicket,'behavior replaced an unfinished local detour')
    end
    local command=active(npc)[1]
    if command and command.kind=='AIRotateToCommand' then
      local point=command.target.position
      local dx,dy=point.x-npc.pos.x,point.y-npc.pos.y
      local length=math.sqrt(dx*dx+dy*dy)
      npc.forward=Vector4.new(dx/length,dy/length); command.state='Success'
    elseif command and command.kind=='AIMoveToCommand' then
      detourCommands=detourCommands+1
      local point=command.movementTarget.position
      local dx,dy=point.x-npc.pos.x,point.y-npc.pos.y
      local gap=math.sqrt(dx*dx+dy*dy)
      local step=math.min(.1,gap)
      if gap>0 then npc.pos=Vector4.new(npc.pos.x+dx*step/gap,npc.pos.y+dy*step/gap) end
      if gap<.18 then command.state='Success' end
    end
    for _,box in ipairs(obstacles) do
      assert(not overlaps({x=.4,y=.4,z=1.05},{x=npc.pos.x,y=npc.pos.y,z=1.15},{yaw=0},box),
        'party integration walked through the parked car')
    end
    if row.behavior=='settled' and math.sqrt(npc.pos.x^2+(npc.pos.y-8)^2)<3.5 then arrived=true; break end
  end
  assert(detourTicket and detourCommands>15 and arrived,'the post-trip catch-up never settled with the group')
`));

test('an unavailable spatial adapter retains the hold and resumes only after complete verification recovers',()=>run(walking+solids+`
  local working=Game.GetSpatialQueriesSystem
  Game.GetSpatialQueriesSystem=function() error('native spatial system is temporarily unavailable') end
  update()
  assert(state.lastRejection.unavailable and active(npc)[1].kind=='AIHoldPositionCommand')
  for i=1,20 do update(.1) end
  assert(not last(npc,'AIMoveToCommand') and #active(npc)==1)
  Game.GetSpatialQueriesSystem=working
  for i=1,70 do update(.1) if last(npc,'AIMoveToCommand') then break end end
  assert(last(npc,'AIMoveToCommand') and not state.blockedReason)
`));

test('a vehicle appearing in an already verified deferred prefix prevents follow admission',()=>run(walking+solids+`
  player.pos=Vector4.new(0,8); context.frame.position=player.pos
  decision.operation={ticket='deferred-follow',kind='follow',gait='Run'}
  local helper=dofile('companion-clearance.lua')
  local first=helper.newBudget(); first.limit=12; motor.useSpatialBudget(first)
  update(); assert(state.clearanceWaiting and state.routeProbe)
  solid('Vehicle',0,.8,.2,.2)
  motor.useSpatialBudget(helper.newBudget()); update(.1)
  assert(not last(npc,'AIFollowTargetCommand'),'a stale checked prefix admitted native follow')
  assert(state.lastRejection.group=='Vehicle' and state.lastRejection.resumedPrefix)
  assert(active(npc)[1].kind=='AIHoldPositionCommand')
`));

test('a transient native detour failure retries verified geometry with bounded backoff',()=>run(walking+solids+`
  solid('Vehicle',0,3,.9,1.3)
  npc.forward=Vector4.new(1,0)
  local helper=dofile('companion-clearance.lua')
  local first
  for i=1,20 do
    motor.useSpatialBudget(helper.newBudget()); update(.1)
    first=last(npc,'AIMoveToCommand'); if first then break end
  end
  assert(first); first.state='Failure'; update(.1)
  assert(state.lastRejection.nativeLegFailure and state.blockedReason)
  local count=#npc.ai.commands
  for i=1,10 do update(.1) end
  assert(#npc.ai.commands==count,'native failure retried without its backoff')
  for i=1,60 do
    motor.useSpatialBudget(helper.newBudget()); update(.1)
    local next=last(npc,'AIMoveToCommand')
    if next and next~=first then break end
  end
  local next=last(npc,'AIMoveToCommand')
  assert(next and next~=first and next.state=='Executing','unchanged geometry prevented native-leg recovery')
  assert(state.nativeLegFailures==1 and #active(npc)==1)
`));

test('a catch-up waypoint participates in the exact retained-facing cleanup owner',()=>run(walking+solids+`
  player.pos=Vector4.new(0,8); context.frame.position=player.pos
  decision.operation={ticket='owned-follow-detour',kind='follow',gait='Run'}
  solid('Vehicle',0,3,.9,1.3)
  npc.forward=Vector4.new(1,0)
  local ownedAtSend=false
  npc.ai.onSend=function(command)
    if command.kind=='AIMoveToCommand' then ownedAtSend=motor.ownsTravel(state,command) end
  end
  for i=1,20 do update(.1) if last(npc,'AIMoveToCommand') then break end end
  local move=last(npc,'AIMoveToCommand'); assert(move)
  assert(ownedAtSend and motor.ownsTravel(state,move),'the ordinary follow leg retained an obsolete facing object')
  assert(not motor.ownsTravel(state,{id=move.id+1}))
  state.face=true; assert(not motor.ownsTravel(state,move))
`));

test('unchanged repeated native leg failures stop after three attempts until a real geometry change',()=>run(walking+solids+`
  solid('Vehicle',0,3,.9,1.3); npc.forward=Vector4.new(1,0)
  local failed,failures={},0
  for i=1,250 do
    update(.1)
    local move=active(npc,'AIMoveToCommand')[1]
    if move and not failed[move] then failed[move]=true; move.state='Failure'; failures=failures+1 end
  end
  assert(failures==3 and state.nativeLegFailures==3,'native failure retries were unbounded')
  assert(state.blockedReason and active(npc)[1].kind=='AIHoldPositionCommand')
  local count=#npc.ai.commands
  for i=1,50 do update(.1) end
  assert(#npc.ai.commands==count,'an unchanged failed native route kept resubmitting commands')
  obstacles={}
  for i=1,30 do update(.1) if active(npc,'AIMoveToCommand')[1] then break end end
  assert(active(npc,'AIMoveToCommand')[1] and not state.blockedReason,'real geometry change never released the wait')
`));

test('a small V displacement invalidates a cached player crossing without changing the movement ticket',()=>run(walking+solids+`
  decision.operation.goal=Vector4.new(0,6)
  player.pos=Vector4.new(0,3); context.frame.position=player.pos; context.playerGap=3
  update()
  assert(state.blockedReason and state.lastRejection.stage=='player')
  local ticket=state.ticket
  player.pos=Vector4.new(.9,3); context.frame.position=player.pos
  for i=1,20 do update(.1) if last(npc,'AIMoveToCommand') then break end end
  assert(last(npc,'AIMoveToCommand'),'a sub-1.5-metre player move left a stale crossing hold')
  assert(state.ticket==ticket and not state.blockedReason)
`));

test('an unchanged player and side goal resume after native routing changes to a player-clear path',()=>run(walking+solids+`
  player.pos=Vector4.new(0,3); context.frame.position=player.pos; context.playerGap=3
  decision.operation.goal=Vector4.new(2,6)
  local nav=Game.GetAINavigationSystem(); local straight=nav.CalculatePathForCharacter
  local blocked,reads=true,0
  nav.CalculatePathForCharacter=function(self,origin,destination)
    reads=reads+1
    if blocked then
      return {path={origin,Vector4.new(0,3),destination},CalculateLength=function() return 7 end}
    end
    return straight(self,origin,destination)
  end
  Game.GetAINavigationSystem=function() return nav end
  update(); assert(state.blockedReason and state.lastRejection.stage=='player')
  local ticket=state.ticket; blocked=false
  for i=1,25 do update(.1) if last(npc,'AIMoveToCommand') then break end end
  assert(last(npc,'AIMoveToCommand'),'a changed native route never invalidated the player rejection')
  assert(reads>=2 and state.ticket==ticket and not state.blockedReason)
`));

test('an unchanged real player crossing retains its exact hold with bounded periodic verification',()=>run(walking+solids+`
  player.pos=Vector4.new(0,3); context.frame.position=player.pos; context.playerGap=3
  local nav=Game.GetAINavigationSystem(); local calculate=nav.CalculatePathForCharacter; local reads=0
  nav.CalculatePathForCharacter=function(self,...)
    reads=reads+1; return calculate(self,...)
  end
  Game.GetAINavigationSystem=function() return nav end
  update(); local held=active(npc)[1]; local ticket=state.ticket
  for i=1,50 do update(.1) end
  assert(active(npc)[1]==held and #npc.ai.commands==1 and state.ticket==ticket)
  assert(reads>=4 and reads<=7,'player-crossing verification was absent or ran every frame')
  assert(state.lastRejection.playerPosition.y==3 and state.lastRejection.distance<state.lastRejection.margin)
  assert(state.blockedReason and not last(npc,'AIMoveToCommand') and not last(npc,'AIFollowTargetCommand'))
`));

test('quota-deferred player revalidation preserves the safety hold until fresh route checks finish',()=>run(walking+solids+`
  player.pos=Vector4.new(0,3); context.frame.position=player.pos; context.playerGap=3
  decision.operation.goal=Vector4.new(2,6)
  local nav=Game.GetAINavigationSystem(); local straight=nav.CalculatePathForCharacter; local blocked=true
  nav.CalculatePathForCharacter=function(self,origin,destination)
    if blocked then return {path={origin,Vector4.new(0,3),destination},CalculateLength=function() return 7 end} end
    return straight(self,origin,destination)
  end
  Game.GetAINavigationSystem=function() return nav end
  update(); local held=active(npc)[1]; local ticket=state.ticket; blocked=false
  local helper=dofile('companion-clearance.lua')
  for i=1,15 do
    local budget=helper.newBudget(); budget.used=budget.limit; motor.useSpatialBudget(budget)
    update(.1)
    assert(active(npc)[1]==held and #npc.ai.commands==1)
  end
  assert(state.clearanceWaiting and state.blockedContext.playerChecking)
  for i=1,10 do
    motor.useSpatialBudget(helper.newBudget()); update(.1)
    if last(npc,'AIMoveToCommand') then break end
  end
  assert(last(npc,'AIMoveToCommand') and state.ticket==ticket and not state.blockedReason)
`));

test('a projected side stance occupied by V uses the same refreshable player geometry type',()=>run(walking+solids+`
  decision.operation.goal=Vector4.new(0,6)
  player.pos=Vector4.new(.85,6); context.frame.position=player.pos; context.playerGap=6
  update()
  assert(state.lastRejection.stage=='player','a V-occupied endpoint was cached as a non-refreshable stance')
  local ticket=state.ticket
  player.pos=Vector4.new(1.2,6); context.frame.position=player.pos
  for i=1,15 do update(.1) if last(npc,'AIMoveToCommand') then break end end
  assert(last(npc,'AIMoveToCommand') and state.ticket==ticket and not state.blockedReason)
`));

const stayNear = `
  local helper=dofile('companion-clearance.lua')
  local function drive(frames)
    local moved,seen=false,{}
    for frame=1,frames do
      motor.useSpatialBudget(helper.newBudget())
      update(0.1)
      for _,event in ipairs(state.events) do seen[event.event]=true end
      if last(npc,'AIMoveToCommand') then moved=true end
    end
    return moved,seen
  end
`;

test('a rejected cosmetic attention step is held in place and never plans a detour', () => run(walking + solids + stayNear + `
  player.pos=Vector4.new(0,-1.6); context.frame.position=player.pos; context.playerGap=1.6
  solid('Static',0,.1,.9,.1)
  decision.operation={ticket='attend',kind='move',goal=Vector4.new(0,.16),gait='Walk',finish=true,face=true}
  local moved,seen=drive(80)
  assert(state.failed and seen['route-rejected'],'the blocked attention step was not rejected')
  assert(not state.detourSearch and not state.execution and not seen['detour-ready'],'a cosmetic step planned a detour')
  assert(not moved and npc.pos.x==0 and npc.pos.y==0,'a rejected attention step moved the companion')
`));

test('a stay-near detour that would walk away from V is refused and the companion holds', () => run(walking + solids + stayNear + `
  player.pos=Vector4.new(0,-1.6); context.frame.position=player.pos; context.playerGap=1.6
  decision.operation={ticket='alongside',kind='move',goal=Vector4.new(0,2.8),gait='Walk',finish=false,face=false}
  solid('Static',0,1.4,.9,.1)
  local moved,seen=drive(200)
  assert(seen['route-rejected'] and seen['detour-refused'] and seen['detours-exhausted'],
    'the long detour was not refused')
  assert(not seen['detour-ready'] and not moved,'a detour walked away from the stopped player')
  assert(npc.pos.x==0 and npc.pos.y==0 and active(npc)[1].kind=='AIHoldPositionCommand')
`));

test('the same obstruction still gets its detour when V is far away (cap applies to staying near only)', () => run(walking + solids + stayNear + `
  player.pos=Vector4.new(0,-7); context.frame.position=player.pos; context.playerGap=7
  decision.operation={ticket='alongside',kind='move',goal=Vector4.new(0,2.8),gait='Walk',finish=false,face=false}
  solid('Static',0,1.4,.9,.1)
  local moved,seen=drive(200)
  assert(seen['detour-ready'] and not seen['detour-refused'],'a far companion lost its legitimate detour')
`));
