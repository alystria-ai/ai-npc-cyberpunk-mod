import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {companionModules, companionEngine} from './companion-fixture.mjs';

const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
function run(code) {
  const state=lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status=lauxlib.luaL_dostring(state,to_luastring(code));
  const error=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  lua.lua_close(state); assert.equal(status,lua.LUA_OK,error);
}

// Replay residual root motion AFTER the engine reports a successful arrival.
// The old controller instead saved the moving sample and commanded a reversal.
for (const dt of [0.05,0.1,0.23,0.5]) {
  test(`arrival accepts the eventual coast position with a backward camera glance, dt=${dt}`,()=>run(`${companionEngine}
    local dt=${dt}
    local npc=spawn(); tick(3)
    player.pos=Vector4.new(0,8); tick(1); tick(3)
    npc.pos=Vector4.new(1.5,6); tick(1)
    local route=last(npc,'AIMoveToCommand'); assert(route and not route.rotateEntityTowardsFacingTarget)
    local destination=route.movementTarget.position.y
    local remaining=4
    while remaining>0 do
      local elapsed=4-remaining
      local velocity=elapsed<2.5 and 0.9 or math.max(0,0.9-(elapsed-2.5)*0.75)
      npc.pos.y=npc.pos.y+velocity*dt
      if npc.pos.y>=destination then route.state='Success' end
      player.forward=Vector4.new(0,-1)
      companions.update(player,dt,npc.id.hash)
      local row=companions.list()[1]; assert(not row.error,row.error)
      if velocity>0.18 then
        assert(not row.focused,'attention interrupted moving feet')
        assert(last(npc,'AIMoveToCommand')==route,'coasting produced a second route')
        assert(#active(npc,'AIRotateToCommand')==0,'arrival turned back toward V')
      end
      remaining=remaining-dt
    end
    local actual=Vector4.new(npc.pos.x,npc.pos.y)
    for i=1,math.ceil(2/dt) do companions.update(player,dt) end
    local row=companions.list()[1]
    assert(row.behavior=='settled',row.behavior)
    assert(row.acceptedPosition and math.abs(row.acceptedPosition.y-actual.y)<0.01)
    assert(actual.y>destination+0.4,'replay must include meaningful overshoot')
    assert(last(npc,'AIMoveToCommand')==route,'a safe overshoot was corrected backwards')
    assert(#active(npc,'AIRotateToCommand')==0)
  `));
}

test('walking beside V brakes once and accepts coasting without a new reverse destination',()=>run(`${companionEngine}
  local npc=spawn(); tick(3)
  for i=1,25 do
    player.pos.y=i*0.15; npc.pos.y=player.pos.y+0.05
    companions.update(player,0.1)
  end
  local route=last(npc,'AIMoveToCommand'); assert(route)
  local before=#npc.ai.commands
  for i=1,25 do
    npc.pos.y=npc.pos.y+math.max(0,1.0-i*0.06)*0.1
    player.forward=Vector4.new(-1,0)
    companions.update(player,0.1,npc.id.hash)
    if i<=16 then assert(not companions.list()[1].focused) end
  end
  -- A later deliberate, settled look may have its own tiny social step.
  for i=before+1,#npc.ai.commands do
    local command=npc.ai.commands[i]
    assert(command.kind~='AIMoveToCommand' or command.rotateEntityTowardsFacingTarget,
      'stopping created another ordinary walking destination')
  end
`));

test('travel intent and trailing lanes ignore camera turns and brief backward steps',()=>run(`${companionModules}
  local travel=dofile('companion-travel.lua')
  local frame=travel.new({x=0,y=0,z=0},{x=0,y=1})
  for i=1,30 do travel.update(frame,{x=0,y=i*0.15,z=0},0.1) end
  assert(frame.moving and frame.direction.y>0.99)
  for i=1,4 do travel.update(frame,{x=0,y=4.5-i*0.1,z=0},0.1) end
  assert(frame.direction.y>0.95 and frame.reversal==0)
  for _,slot in ipairs({3,5,7}) do assert(travel.laneFrame(frame,slot).direction.y>0.9) end
  -- Purposeful reverse travel is recognized after enough actual displacement.
  for i=1,30 do travel.update(frame,{x=0,y=4.1-i*0.15,z=0},0.1) end
  assert(frame.direction.y< -0.95 and frame.reversal==1)
  local direction=frame.direction
  for i=1,40 do travel.update(frame,{x=0,y=-0.4,z=0},0.1) end
  assert(not frame.moving and math.abs(frame.direction.y-direction.y)<0.001)
`));

test('short trail still separates rear rows, including during the first departure',()=>run(`${companionModules}
  local travel=dofile('companion-travel.lua'); local space=dofile('companion-space.lua')
  local frame=travel.new({x=0,y=0,z=0},{x=0,y=1})
  travel.update(frame,{x=0,y=1.1,z=0},0.4)
  local front=travel.laneFrame(frame,1); local rear=travel.laneFrame(frame,7)
  assert(front.position.y-rear.position.y>2.8,'rear rows collapsed onto front row')
  assert(space.angle(front.direction,rear.direction)<10)
`));

test('only a companion whose personal space is invaded yields',()=>run(`${companionEngine}
  local one=spawn(); local two=spawn(); local three=spawn('panam-palmer'); tick(4)
  local countTwo,countThree=#two.ai.commands,#three.ai.commands
  player.pos.x=1.0
  for i=1,12 do companions.update(player,0.1) end
  assert(companions.list()[1].behavior=='yield')
  assert(last(one,'AIMoveToCommand') and not last(one,'AIMoveToCommand').rotateEntityTowardsFacingTarget)
  assert(#two.ai.commands==countTwo and #three.ai.commands==countThree,
    'one personal-space adjustment must not relocate the whole party')
`));

test('finite arrivals survive delayed completion and cannot be reissued every update',()=>run(`${companionEngine}
  local npc=spawn(); tick(3)
  player.pos=Vector4.new(0,8); tick(1); tick(3)
  npc.pos=Vector4.new(1.5,6); tick(1)
  local command=last(npc,'AIMoveToCommand'); local count=#npc.ai.commands
  command.state='Enqueued'
  for i=1,18 do npc.pos.y=npc.pos.y+0.02; companions.update(player,0.1,npc.id.hash) end
  assert(#npc.ai.commands==count and last(npc,'AIMoveToCommand')==command)
  command.state='Failure'; companions.update(player,0.1)
  local recovery=last(npc,'AIFollowTargetCommand'); assert(recovery)
  recovery.state='Failure'; count=#npc.ai.commands
  for i=1,20 do companions.update(player,0.1) end
  assert(#npc.ai.commands==count,'failed native recovery must respect its backoff')
`));

test('a walking operation releases full attention before its first command reaches the engine',()=>run(`${companionEngine}
  local npc=spawn(); tick(3); tick(1,npc.id.hash)
  local step=last(npc,'AIMoveToCommand'); assert(step.rotateEntityTowardsFacingTarget)
  local submits=0
  npc.ai.onSend=function(command)
    if command.kind=='AIMoveToCommand' or command.kind=='AIFollowTargetCommand' then
      submits=submits+1
      assert(not command.facingTarget or not command.facingTarget.entity)
      for event in pairs(npc.looks) do assert(event.parts[1].weight<=0.05) end
      assert(step.state~='Executing')
    end
  end
  for i=1,10 do player.pos.y=i*0.25; companions.update(player,0.1,npc.id.hash) end
  assert(submits>0)
`));

// A deliberately simple engine stand-in provides acceleration, delayed stops,
// native completion and command feedback. It is not a gait/animation test.
const physicalWorld=`
  local space=dofile('companion-space.lua')
  local function physics(npc,dt)
    local command=active(npc)[1]
    local goal,desired,speed=nil,0,npc.velocity or 0
    if command and (command.kind=='AIMoveToCommand' or command.kind=='AIFollowTargetCommand') then
      goal=command.kind=='AIMoveToCommand' and command.movementTarget.position or player.pos
      local gap=space.ground(npc.pos,goal)
      local margin=command.kind=='AIFollowTargetCommand' and command.desiredDistance or command.desiredDistanceFromTarget
      desired=math.min(({Walk=1.5,Run=4.5,Sprint=7})[command.movementType],
        math.sqrt(2*5.5*math.max(0,gap-margin)))
      if gap<margin+0.05 and command.finishWhenDestinationReached then command.state='Success'; desired=0 end
    elseif command and command.kind=='AIRotateToCommand' then
      npc.forward=space.bearing(npc.pos,command.target.position); command.state='Success'
    end
    local nextSpeed=speed+math.max(-dt*5.5,math.min(dt*5,desired-speed))
    if goal and desired>0.1 then npc.forward=space.bearing(npc.pos,goal) end
    npc.pos=space.offset(npc.pos,npc.forward,0,nextSpeed*dt)
    npc.velocity=nextSpeed
  end
  local function frame(dt,focus)
    for _,npc in pairs(entities) do physics(npc,dt) end
    companions.update(player,dt,focus)
    for _,row in ipairs(companions.list()) do assert(not row.error,row.error) end
    for _,npc in pairs(entities) do assert(#active(npc)<=1,'multiple owners issued movement') end
  end
`;

test('three friends including duplicate copies walk, run, coast and keep separate resting places',()=>run(`${companionEngine}${physicalWorld}
  local one=spawn(); local two=spawn('panam-palmer'); local three=spawn(); tick(4)
  for i=1,160 do
    local speed=i<=60 and 1.4 or (i<=110 and 5.0 or 0)
    player.pos.y=player.pos.y+speed*0.1
    if i>105 then player.forward=Vector4.new(0,-1) end
    frame(0.1,i>100 and i<135 and one.id.hash or nil)
  end
  for i=1,100 do frame(0.1) end
  local rows=companions.list()
  for i,npc in ipairs({one,two,three}) do
    local sprint=false
    for _,command in ipairs(npc.ai.commands) do
      if command.movementType=='Sprint' then sprint=true end
    end
    assert(sprint,'running V never caused sprint catch-up')
    if rows[i].behavior~='settled' then
      print('UNSETTLED',i,npc.pos.x,npc.pos.y,player.pos.y,rows[i].behavior,rows[i].operation.kind,
        rows[i].operation.state,rows[i].operation.error,rows[i].npcSpeed)
      for _,item in ipairs(rows[i].behaviorTrace) do print(item.at,item.phase,item.reason) end
      for _,item in ipairs(rows[i].commandTrace) do print(item.at,item.kind,item.event,item.target and item.target.y) end
    end
    assert(rows[i].behavior=='settled',rows[i].behavior..': '..tostring(rows[i].behaviorReason))
    assert(space.ground(npc.pos,player.pos)<5.5,'a member was left behind')
    assert(#npc.ai.commands<65,'formation caused a command storm')
  end
  assert(space.ground(one.pos,two.pos)>0.8 and space.ground(one.pos,three.pos)>0.8)
  local counts={#one.ai.commands,#two.ai.commands,#three.ai.commands}
  for i=1,25 do player.forward=Vector4.new(math.sin(i),math.cos(i)); frame(0.1) end
  for i,npc in ipairs({one,two,three}) do assert(#npc.ai.commands==counts[i]) end
`));

test('eight copies share a navigation budget and retain unique lanes after a real reversal and replacement',()=>run(`${companionEngine}
  for i=1,8 do spawn() end
  tick(4)
  local nav=Game.GetAINavigationSystem(); local queries=0
  local find=nav.FindPointInSphereForCharacter
  nav.FindPointInSphereForCharacter=function(self,...) queries=queries+1; return find(self,...) end
  Game.GetAINavigationSystem=function() return nav end
  for i=1,35 do
    player.pos.y=-i*0.2
    local before=queries; companions.update(player,0.1)
    assert(queries-before<=2,'more than two cruise navigation requests in one update')
  end
  local rows=companions.list(); local lanes={}
  for _,row in ipairs(rows) do assert(not lanes[row.lane]); lanes[row.lane]=true end
  assert(rows[1].travelDirection.y< -0.9,'actual reverse travel was not recognized')
  local serial=rows[1].serial; assert(companions.dismiss(serial))
  assert(companions.spawn('judy-alvarez')); companions.update(player,0.1)
  lanes={}
  for _,row in ipairs(companions.list()) do assert(not lanes[row.lane]); lanes[row.lane]=true end
`));
