import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
function run(code,prefix='') {
  const state=lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status=lauxlib.luaL_dostring(state,to_luastring(prefix+companionEngine+code));
  const message=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  lua.lua_close(state); assert.equal(status,lua.LUA_OK,message);
}

const counter=`
  local queries=0
  Game.GetSpatialQueriesSystem=function() return {
    Overlap=function() queries=queries+1; return false end,
    SyncRaycastByCollisionGroup=function(_,start)
      queries=queries+1
      return true,{position=Vector4.new(start.x,start.y,0),normal=Vector4.new(0,0,1)}
    end
  } end
`;

// A distant follow proves a six-metre native prefix (October 5 native follow).
// A dense native polyline makes that prefix cost more than one update's 192
// queries, so quota continuation is still exercised for a remote goal.
const denseRoute=`
  do
    local nav=Game.GetAINavigationSystem()
    nav.CalculatePathForCharacter=function(_,origin,destination)
      local dx,dy=destination.x-origin.x,destination.y-origin.y
      local length=math.sqrt(dx*dx+dy*dy)
      local path={origin}
      for i=1,40 do path[#path+1]=Vector4.new(origin.x+dx/length*.15*i,origin.y+dy/length*.15*i,origin.z) end
      path[#path+1]=destination
      return {path=path,CalculateLength=function() return length end}
    end
    Game.GetAINavigationSystem=function() return nav end
  end
`;

test('separate dofile adapters spend the exact same injected query allowance',()=>run(counter+`
  local one,two=dofile('companion-clearance.lua'),dofile('companion-clearance.lua')
  local budget=one.newBudget(); one.useBudget(budget); two.useBudget(budget)
  for i=1,16 do
    assert(one.body(Vector4.new(0,0,0)))
    assert(two.body(Vector4.new(2,0,0)))
  end
  local clear,reason,deferred=two.body(Vector4.new(4,0,0))
  assert(clear==nil and reason==nil and deferred==true)
  assert(queries==192 and budget.used==192 and budget.limit==192)
`));

test('eight clear six-metre follow admissions fit in one update including every collision group',()=>run(`
  local people={}
  for i=1,8 do people[i]=spawn() end
  ${counter}
  local helper=dofile('companion-clearance.lua')
  local motor=dofile('companion-actuator.lua')
  local budget=helper.newBudget(); motor.useSpatialBudget(budget)
  player.pos=Vector4.new(0,6)
  for i,npc in ipairs(people) do
    npc.ai.commands={}; npc.pos=Vector4.new(0,0)
    local state=motor.new(npc)
    local context={position=npc.pos,direction=npc.forward,speed=0,player=player,slot=i,
      playerGap=6,frame={position=player.pos},others={},id=npc.id.hash}
    motor.apply(state,{operation={ticket='follow',kind='follow',gait='Run'}},context,i<=2)
    assert(active(npc)[1].kind=='AIFollowTargetCommand','ordinary following waited for another frame')
  end
  assert(queries<=192 and budget.used==queries and queries>=144,
    'free stand-off checks did not cover every body and walking collision group')
`));

test('a long route continues across updates without repeating its verified prefix or releasing the hold',()=>run(`
  local npc=spawn(); npc.ai.commands={}; npc.pos=Vector4.new(0,0)
  ${counter}
  ${denseRoute}
  local helper=dofile('companion-clearance.lua')
  local motor=dofile('companion-actuator.lua'); local state=motor.new(npc)
  player.pos=Vector4.new(0,100)
  local context={position=npc.pos,direction=npc.forward,speed=0,player=player,slot=1,
    playerGap=100,frame={position=player.pos},others={},id=npc.id.hash}
  local decision={operation={ticket='long',kind='follow',gait='Run'}}
  local nav=Game.GetAINavigationSystem(); local calculate=nav.CalculatePathForCharacter; local paths=0
  nav.CalculatePathForCharacter=function(self,...) paths=paths+1; return calculate(self,...) end
  Game.GetAINavigationSystem=function() return nav end
  local first=helper.newBudget(); motor.useSpatialBudget(first)
  motor.apply(state,decision,context,true)
  assert(queries==192 and state.clearanceWaiting and not state.failed)
  assert(#active(npc)==1 and active(npc)[1].kind=='AIHoldPositionCommand')
  local held=active(npc)[1]
  local second=helper.newBudget(); motor.useSpatialBudget(second)
  motor.sense(state,npc.pos,0,.1); motor.apply(state,decision,context,true)
  assert(paths==1,'continuation recalculated and repeated the full route')
  assert(second.used<=192 and queries<384,'checked route prefix was repeated')
  assert(held.state~='Executing' and active(npc)[1].kind=='AIFollowTargetCommand')
  assert(not state.clearanceWaiting and not state.failed)
`));

test('the real eight-copy update stays within 192 queries and gives deferred members a turn',()=>run(`
  local people={}; for i=1,8 do people[i]=spawn() end
  tick(4)
  ${counter}
  player.pos=Vector4.new(0,100)
  local admitted={}
  for frame=1,22 do
    local before=queries
    companions.update(player,.1)
    local count=queries-before
    assert(count<=192,'one update exceeded the aggregate native query cap')
    assert(companions.spatialQueryUsage().used==count)
    for i,npc in ipairs(people) do
      if last(npc,'AIFollowTargetCommand') then admitted[i]=true end
      local current=active(npc)[1]
      assert(current,'a deferred member released native follower ownership')
      assert(not companions.list()[i].error,companions.list()[i].error)
    end
    local total=0; for _ in pairs(admitted) do total=total+1 end
    if total==8 then break end
  end
  for i=1,8 do
    if not admitted[i] then
      local row=companions.list()[i]
      print('WAITING',i,row.behavior,row.operation.stage,row.operation.failed,row.operation.error)
      for _,event in ipairs(row.commandTrace) do print(event.at,event.event,event.kind) end
    end
    assert(admitted[i],'round-robin continuation starved a member')
  end
`));

test('a partial receipt aging during busy frames stays pending instead of becoming a failed route',()=>run(`
  local npc=spawn(); npc.ai.commands={}; npc.pos=Vector4.new(0,0)
  ${counter}
  ${denseRoute}
  local helper=dofile('companion-clearance.lua')
  local motor=dofile('companion-actuator.lua'); local state=motor.new(npc)
  player.pos=Vector4.new(0,100)
  local context={position=npc.pos,direction=npc.forward,speed=0,player=player,slot=1,
    playerGap=100,frame={position=player.pos},others={},id=npc.id.hash}
  local decision={operation={ticket='long',kind='follow',gait='Run'}}
  motor.useSpatialBudget(helper.newBudget()); motor.apply(state,decision,context,true)
  motor.sense(state,npc.pos,0,4)
  motor.useSpatialBudget(helper.newBudget()); motor.apply(state,decision,context,true)
  assert(state.clearanceWaiting and not state.failed and not state.blockedReason)
  assert(active(npc)[1].kind=='AIHoldPositionCommand')
`));

test('actual coasting during quota deferral rebuilds the route from the new feet',()=>run(`
  local npc=spawn(); npc.ai.commands={}; npc.pos=Vector4.new(0,0)
  ${counter}
  ${denseRoute}
  local helper=dofile('companion-clearance.lua')
  local motor=dofile('companion-actuator.lua'); local state=motor.new(npc)
  player.pos=Vector4.new(0,100)
  local context={position=npc.pos,direction=npc.forward,speed=0,player=player,slot=1,
    playerGap=100,frame={position=player.pos},others={},id=npc.id.hash}
  local nav=Game.GetAINavigationSystem(); local calculate=nav.CalculatePathForCharacter; local origins={}
  nav.CalculatePathForCharacter=function(self,origin,...)
    origins[#origins+1]=origin; return calculate(self,origin,...)
  end
  Game.GetAINavigationSystem=function() return nav end
  local decision={operation={ticket='coasting-follow',kind='follow',gait='Run'}}
  motor.useSpatialBudget(helper.newBudget()); motor.apply(state,decision,context,true)
  assert(state.clearanceWaiting and #origins==1)
  npc.pos=Vector4.new(.25,0); context.position=npc.pos
  motor.sense(state,npc.pos,0,.1)
  motor.useSpatialBudget(helper.newBudget()); motor.apply(state,decision,context,true)
  assert(#origins==2 and origins[2].x==.25,'the route was calculated from stale pre-coast feet')
  assert(active(npc)[1].kind=='AIHoldPositionCommand')
`));

test('queued invitations, attachment, walking and car queries share the same frame budget',()=>run(counter+`
  local budget=companions.beginSpatialFrame()
  for i=1,8 do assert(companions.spawn('judy-alvarez')) end
  companions.update(player,.1)
  -- Each spawn: standing body plus its first swept exit box; attachment: body.
  assert(queries==144,'spawn and attachment did not share their expected body checks')
  local car={IsAttached=function() return true end,
    GetLinearVelocity=function() return Vector4.new(0,0,0) end,
    GetWorldPosition=function() return Vector4.new(0,0,0) end,
    GetWorldForward=function() return Vector4.new(0,1,0) end,
    GetWorldOrientation=function() return {yaw=0} end}
  local deferred=false
  for i=1,10 do
    local created,reason,pending=capturedVehicle.spawn({record='test'},player,{entity=car},i)
    if pending then assert(not created and not reason); deferred=true; break end
  end
  assert(deferred and queries==192 and budget.used==192,'car native queries escaped the shared frame cap')
`, `companionVehicleAdapter=function(native) capturedVehicle=native; return native end\n`));

test('deferred attachment does not delete the copy or spend its native attachment timeout',()=>run(`
  assert(companions.spawn('judy-alvarez'))
  for i=1,30 do
    local budget=companions.beginSpatialFrame(); budget.used=budget.limit
    companions.update(player,.5)
    assert(companions.list()[1].state=='spawning' and entities[1])
  end
  companions.beginSpatialFrame(); companions.update(player,.1)
  assert(companions.list()[1].state=='ready')
`));

test('an exhausted frame returns a typed pending invitation without creating any entity',()=>run(counter+`
  local budget=companions.beginSpatialFrame(); budget.used=budget.limit
  local created,reason,deferred=companions.spawn('judy-alvarez')
  assert(not created and not reason and deferred and sequence==0 and queries==0)
  companions.beginSpatialFrame()
  assert(companions.spawn('judy-alvarez') and sequence==1)
`));
