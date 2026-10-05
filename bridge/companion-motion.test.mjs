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

for (const focused of [false,true]) {
  test(`V approaching a settled companion's face does not cause retreat, focused=${focused}`,()=>run(`${companionEngine}
    local one=spawn(); local two=spawn(); local three=spawn('panam-palmer'); tick(4)
    local counts={#one.ai.commands,#two.ai.commands,#three.ai.commands}
    local focus=${focused ? 'one.id.hash' : 'nil'}
    -- Hold each close distance beyond the former 0.6-second avoidance delay.
    -- A face/eye turn is allowed; a new walking or follow command is not.
    for _,gap in ipairs({0.68,0.35,0.08}) do
      player.pos=Vector4.new(one.pos.x-gap,one.pos.y)
      for i=1,18 do companions.update(player,0.1,focus) end
      assert(companions.list()[1].groupIntent=='local-interaction')
      assert(companions.list()[1].behavior~='yield','V standing close ordered a retreat')
      for n,npc in ipairs({one,two,three}) do
        for i=counts[n]+1,#npc.ai.commands do
          local kind=npc.ai.commands[i].kind
          assert(kind~='AIMoveToCommand' and kind~='AIFollowTargetCommand',
            'a close face inspection must not relocate this person or the group')
        end
      end
    end
    -- Holding still for a close conversation does not disable real departure.
    player.pos=Vector4.new(0,6); tick(1)
    assert(companions.list()[1].playerMoving)
    assert(last(one,'AIFollowTargetCommand') or last(one,'AIMoveToCommand'))
  `));
}

test('overlapping companions still make room without moving the rest of the party',()=>run(`${companionEngine}
  local one=spawn(); local two=spawn(); local three=spawn('panam-palmer'); tick(4)
  local countThree=#three.ai.commands
  two.pos=Vector4.new(one.pos.x,one.pos.y+0.5)
  for i=1,12 do companions.update(player,0.1) end
  assert(companions.list()[1].behavior=='yield')
  assert(companions.list()[2].behavior=='yield')
  local move=last(one,'AIMoveToCommand')
  assert(move and not move.rotateEntityTowardsFacingTarget)
  assert(move.movementTarget.position.y<one.pos.y,'separation must move away from the overlapping member')
  assert(#three.ai.commands==countThree,'peer separation must not relocate the whole party')
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
  for i=1,20 do player.pos.y=i*0.25; companions.update(player,0.1,npc.id.hash) end
  assert(submits>0)
`));

test('backing up to face a settled friend does not make the group form up again',()=>run(`${companionEngine}
  local one=spawn(); local two=spawn('panam-palmer'); tick(4)
  -- Establish attention without walking into the person, then step back two
  -- metres while maintaining that interest, like the 61-second live failure.
  companions.update(player,0.1,one.id.hash)
  local counts={#one.ai.commands,#two.ai.commands}
  for i=1,10 do player.pos.y=i*0.2; companions.update(player,0.1,one.id.hash) end
  assert(companions.list()[1].groupIntent=='local-interaction')
  for i,npc in ipairs({one,two}) do
    assert(#npc.ai.commands==counts[i], 'repositioning for conversation moved a companion')
  end
  assert(companions.list()[1].travelDirection.y>0.99,'local steps changed the group heading')
  -- The space is finite: actually leaving still releases the whole group.
  for i=11,28 do player.pos.y=i*0.2; companions.update(player,0.1) end
  assert(companions.list()[1].playerMoving and #one.ai.commands>counts[1])
`));

test('circling within the resting group without a precise gaze target keeps friends in place',()=>run(`${companionEngine}
  local one=spawn(); local two=spawn('panam-palmer'); tick(4)
  local counts={#one.ai.commands,#two.ai.commands}
  -- Move off the travel line and around its edge, with no locked gaze target.
  for i=1,12 do
    player.pos=Vector4.new(i*0.14,-i*0.1)
    companions.update(player,0.1)
  end
  for i=1,20 do
    player.pos=Vector4.new(1.68-i*0.14,-1.2)
    companions.update(player,0.1)
  end
  for i,npc in ipairs({one,two}) do assert(#npc.ai.commands==counts[i]) end
  assert(not companions.list()[1].playerMoving)
`));

test('a short sustained run releases the group even while V looks at a friend',()=>run(`${companionEngine}
  local one=spawn(); local two=spawn('panam-palmer'); tick(4)
  companions.update(player,.1,one.id.hash)
  local count=#one.ai.commands
  for i=1,2 do player.pos.y=i*.65; companions.update(player,.1,one.id.hash) end
  local row=companions.list()[1]
  assert(row.playerMoving and row.playerRunning,'running remained trapped in local conversation space')
  assert(#one.ai.commands>count,'companion waited for a distant gap before leaving')
  assert(row.travelDirection.y>.99)
`));

test('ordinary forward walking starts promptly when V is not addressing anyone',()=>run(`${companionEngine}
  local npc=spawn(); tick(4)
  for i=1,10 do player.pos.y=i*0.15; companions.update(player,0.1) end
  assert(companions.list()[1].playerMoving and last(npc,'AIMoveToCommand'))
`));

test('after V circles and stops, only the addressed person readjusts once',()=>run(`${companionEngine}
  local one=spawn(); local two=spawn('panam-palmer'); tick(4)
  tick(2,one.id.hash)
  local first=last(one,'AIMoveToCommand'); assert(first)
  one.pos=first.movementTarget.position; first.state='Success'
  one.forward=Vector4.new(-one.pos.x,-one.pos.y); tick(6,one.id.hash)
  local countTwo=#two.ai.commands
  for i=1,10 do player.pos.y=i*0.2; companions.update(player,0.1,one.id.hash) end
  tick(4,one.id.hash)
  local second=last(one,'AIMoveToCommand')
  assert(second~=first and second.rotateEntityTowardsFacingTarget)
  one.pos=second.movementTarget.position; second.state='Success'
  one.forward=Vector4.new(player.pos.x-one.pos.x,player.pos.y-one.pos.y)
  tick(8,one.id.hash)
  assert(last(one,'AIMoveToCommand')==second,'stationary attention repeated its adjustment')
  assert(#two.ai.commands==countTwo,'addressed person readjusted the whole party')
`));

test('rear members wait with a large resting party while V steps around a front member',()=>run(`${companionEngine}
  for i=1,8 do spawn() end
  tick(4)
  local counts={}
  for i,npc in ipairs(entities) do counts[i]=#npc.ai.commands end
  companions.update(player,0.1,entities[1].id.hash)
  for i=1,10 do player.pos.y=i*0.2; companions.update(player,0.1,entities[1].id.hash) end
  for i,npc in ipairs(entities) do
    assert(#npc.ai.commands==counts[i],'rear member followed during local interaction')
  end
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

const strandedPocket=(facing='Vector4.new(0,1)',before='')=>`${companionEngine}
  local teleports={}
  Game.GetTeleportationFacility=function() return {Teleport=function(_,npc,position)
    teleports[#teleports+1]=position; npc.pos=position
    teleportedFrom=Vector4.new(player.pos.x,player.pos.y,player.pos.z) end} end
  local npc=spawn(); tick(4)
  local pocket=Vector4.new(npc.pos.x,npc.pos.y,npc.pos.z)
  -- Recorded Blue Moon case: every body or walking box at her spot hits
  -- Static; the ground near V stays open for placement.
  local sight=true
  Game.GetSpatialQueriesSystem=function() return {
    Overlap=function(_,half,center,_,group)
      return group=='Static' and math.abs(center.x-pocket.x)<1.6 and math.abs(center.y-pocket.y)<1.6
    end,
    SyncRaycastByCollisionGroup=function() return not sight end} end
  player.forward=${facing}
  ${before}
  for i=1,40 do player.pos=Vector4.new(0,i,0); tick(1) end
`;

test('a blocked follower far behind V and out of view is re-placed near V',()=>run(strandedPocket()+`
  -- V faces away from the stranded copy.
  tick(20)
  assert(#teleports>=1,'stranded copy was never recovered')
  local spot=teleports[#teleports]
  local gap=math.sqrt((spot.x-teleportedFrom.x)^2+(spot.y-teleportedFrom.y)^2)
  assert(gap<7 and spot.y<teleportedFrom.y,'recovery did not place the copy just behind V')
  assert(companions.movementSnapshot().copies[1].relocations==#teleports)
  local count=#teleports
  tick(10)
  assert(#teleports==count,'a recovered copy near a standing V was moved again')
`));

test('a stranded follower in plain view is not teleported',()=>run(strandedPocket('Vector4.new(0,-1)')+`
  -- V keeps looking back at the copy with clear line of sight.
  tick(20)
  assert(#teleports==0,'teleported a copy V could see')
  sight=false
  tick(8)
  assert(#teleports==1,'an occluded stranded copy was not recovered')
`));

test('a stranded copy is released from its owned hold before it is teleported',()=>run(strandedPocket()+`
  -- Live trace: the engine left a copy in place when teleported under an
  -- executing hold command.
  Game.GetTeleportationFacility=function() return {Teleport=function(_,owner,position)
    for _,cmd in ipairs(owner.ai.commands) do
      if cmd.state=='Executing' and cmd.kind=='AIHoldPositionCommand' then return end
    end
    teleports[#teleports+1]=position; owner.pos=position end} end
  player.forward=Vector4.new(0,1)
  tick(20)
  assert(#teleports==1,'the copy was teleported while its hold pinned it')
  assert(companions.movementSnapshot().copies[1].relocations==1)
`));

test('a teleport the engine ignores is recorded as a failure, not a relocation',()=>run(strandedPocket('Vector4.new(0,1)',
  'Game.GetTeleportationFacility=function() return {Teleport=function() end} end')+`
  tick(12)
  local row=companions.movementSnapshot().copies[1]
  assert(not row.relocations and (row.relocationFailures or 0)>=1,'an ignored teleport counted as a relocation')
`));

const leftBehind=(facing)=>`${companionEngine}
  local teleports={}
  Game.GetTeleportationFacility=function() return {Teleport=function(_,npc,position)
    teleports[#teleports+1]={spot=position,from=Vector4.new(player.pos.x,player.pos.y,player.pos.z)}
    npc.pos=position end} end
  local sight=true
  local spatial=Game.GetSpatialQueriesSystem()
  Game.GetSpatialQueriesSystem=function() return {Overlap=spatial.Overlap,
    SyncRaycastByCollisionGroup=function() return not sight end} end
  local npc=spawn(); tick(4)
  -- The fixture never moves the copy, standing in for an animation-capped
  -- sprint that falls far behind V.
  player.forward=${facing}
  for i=1,30 do player.pos=Vector4.new(0,i*1.5,0); tick(1) end
`;

test('a follower left far behind rejoins behind V, never in front of the camera',()=>run(leftBehind('Vector4.new(0,1)')+`
  tick(6)
  assert(#teleports>=1,'a follower far behind and off-screen never rejoined')
  for _,item in ipairs(teleports) do
    assert(item.spot.y<item.from.y-1,'the follower was placed in front of the camera')
    assert(math.sqrt((item.spot.x-item.from.x)^2+(item.spot.y-item.from.y)^2)<7,'the follower rejoined too far away')
  end
  local first=teleports[1]
  assert(first.from.y>=25,'a follower rejoined before it was 25 m behind')
`));

test('a far follower V can see keeps running instead of teleporting',()=>run(leftBehind('Vector4.new(0,-1)')+`
  tick(6)
  assert(#teleports==0,'teleported a follower V was looking at')
`));
