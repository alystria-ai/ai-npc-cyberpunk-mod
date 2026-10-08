import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

const fixture = `${companionEngine}
  local actuator=dofile('companion-actuator.lua')
  local id=system:CreateEntity({position=Vector4.new(1.5,0)})
  local npc=system:GetEntity(id)
  local motor=actuator.new(npc)
  local context={player=player,gazeSettings=nil}
  local decision={look='side',operation={ticket='held',kind='hold'}}
  local function apply(dt)
    actuator.sense(motor,npc.pos,0,dt or 0.1)
    actuator.apply(motor,decision,context,false)
  end
  local function countLooks()
    local count=0; for _ in pairs(npc.looks) do count=count+1 end; return count
  end
`;

test('default gaze retains the accepted attachment, limits, head weights and zero chest', () => run(`${fixture}
  apply()
  local first=motor.look
  assert(first and first.target==player and first.slot=='pla_default_tgt')
  assert(first.offset.x==0 and first.offset.y==0 and first.offset.z==0)
  assert(first.offset.w==0 and first.parts[1].weight==0.05 and first.parts[2].weight==0)
  assert(first.targetPositionProvider.worldOffset==nil,'default unexpectedly changed the native target provider')
  assert(first.request.limits.softLimitDegrees==45 and first.request.limits.hardLimitDegrees==100)
  assert(first.request.calculatePositionInParentSpace==nil,'default changed native target-space policy')
  for i=1,20 do apply() end
  assert(motor.look==first and countLooks()==1 and #npc.ai.commands==1)
  decision.look='full'; apply()
  assert(motor.look~=first and not npc.looks[first] and motor.look.parts[1].weight==0.18)
  assert(motor.look.parts[2].weight==0 and countLooks()==1 and #npc.ai.commands==1)
  assert(motor.look.request.limits.softLimitDegrees==70 and motor.look.request.limits.hardLimitDegrees==120)
`));

test('changing gaze replaces exactly one owned request without issuing a movement command', () => run(`${fixture}
  local foreign={}; npc.looks[foreign]=true
  apply(); local first=motor.look; local held=npc.ai.commands[1]
  context.gazeSettings={eyeContactHeight=0.10,headFollowStrength=1.5}; apply()
  local changed=motor.look
  assert(changed~=first and not npc.looks[first] and npc.looks[foreign])
  assert(changed.offset.z==0 and changed.targetPositionProvider.worldOffset.z==0.10)
  assert(math.abs(changed.parts[1].weight-0.075)<0.00001)
  assert(changed.parts[2].weight==0 and countLooks()==2)
  assert(#npc.ai.commands==1 and npc.ai.commands[1]==held and held.state=='Executing')
  for i=1,20 do apply() end
  assert(motor.look==changed and countLooks()==2 and #npc.ai.commands==1)
  context.gazeSettings={eyeContactHeight=0,headFollowStrength=1}; apply()
  assert(motor.look.offset.z==0 and motor.look.targetPositionProvider.worldOffset==nil and motor.look.parts[1].weight==0.05)
  assert(not npc.looks[changed] and npc.looks[foreign] and #npc.ai.commands==1)
  decision.look='full'; context.gazeSettings={eyeContactHeight=-0.10,headFollowStrength=0}; apply()
  assert(motor.look.offset.z==0 and motor.look.targetPositionProvider.worldOffset.z==-0.10)
  assert(motor.look.parts[1].weight==0 and motor.look.parts[2].weight==0)
  assert(#npc.ai.commands==1,'head-follow setting changed body/locomotion ownership')
`));

test('invalid runtime policy uses safe defaults instead of unbounded tracking', () => run(`${fixture}
  for _,settings in ipairs({{eyeContactHeight=math.huge,headFollowStrength=math.huge},
      {eyeContactHeight=-0.11,headFollowStrength=-1},{eyeContactHeight='0.1',headFollowStrength='1.5'},
      {eyeContactHeight=0/0,headFollowStrength=0/0}}) do
    context.gazeSettings=settings; apply()
    assert(motor.look.offset.z==0 and motor.look.parts[1].weight==0.05)
  end
  assert(countLooks()==1 and #npc.ai.commands==1)
`));

test('a failed native removal retains its exact owner and never adds a second look', () => run(`${fixture}
  apply(); local first=motor.look
  local originalRemove=LookAtRemoveEvent.QueueRemoveLookatEvent
  local removed,blocked={},true
  LookAtRemoveEvent.QueueRemoveLookatEvent=function(actor,event)
    assert(actor==npc); removed[#removed+1]=event
    if blocked then error('simulated removal failure') end
    return originalRemove(actor,event)
  end
  context.gazeSettings={eyeContactHeight=0.05,headFollowStrength=0.5}; apply()
  assert(motor.look==first and npc.looks[first] and countLooks()==1 and motor.lookError)
  apply(); assert(#removed==1 and countLooks()==1,'failure ignored the look retry interval')
  blocked=false; apply(3.1)
  assert(#removed==2 and removed[1]==first and removed[2]==first)
  assert(motor.look~=first and not npc.looks[first] and countLooks()==1)
  assert(not motor.lookError and #npc.ai.commands==1)
`));

test('a QueueEvent exception after its side effect is retired before a replacement', () => run(`${fixture}
  local originalQueue=npc.QueueEvent
  local first=true
  npc.QueueEvent=function(self,event)
    originalQueue(self,event)
    if first then first=false; error('simulated queue exception after side effect') end
  end
  apply(); local partial=motor.look
  assert(partial and npc.looks[partial] and motor.lookError and countLooks()==1)
  apply(3.1)
  assert(motor.look~=partial and not npc.looks[partial] and countLooks()==1 and not motor.lookError)
  decision.look='none'; apply()
  assert(not motor.look and countLooks()==0)
`));

test('combat retries a refused exact look removal with a bounded interval and no replacement', () => run(`${fixture}
  apply(); local owned=motor.look
  local originalRemove=LookAtRemoveEvent.QueueRemoveLookatEvent
  local attempts,refused=0,true
  LookAtRemoveEvent.QueueRemoveLookatEvent=function(actor,event)
    attempts=attempts+1; assert(actor==npc and event==owned)
    if refused then return false end
    return originalRemove(actor,event)
  end
  decision={look='none',operation={ticket='combat',kind='release'}}
  for i=1,12 do apply() end
  assert(attempts==1 and motor.look==owned and npc.looks[owned] and countLooks()==1)
  assert(#active(npc)==0 and #npc.ai.commands==1,'cleanup submitted a social movement replacement')
  refused=false; apply(3.1)
  assert(attempts==2 and not motor.look and not npc.looks[owned] and countLooks()==0)
`));

test('combat removes the owned look and world abandonment does not query destroyed handles', () => run(`${fixture}
  local foreign={}; npc.looks[foreign]=true
  context.gazeSettings={eyeContactHeight=-0.05,headFollowStrength=1.5}; apply()
  local owned=motor.look
  decision={look='none',operation={ticket='combat',kind='release'}}; apply()
  assert(not motor.look and not npc.looks[owned] and npc.looks[foreign])
  assert(#active(npc)==0)
  context.gazeSettings={eyeContactHeight=0.10,headFollowStrength=0.5}
  for i=1,10 do apply() end
  assert(not motor.look and countLooks()==1,'a setting change during combat created a social look')
  decision={look='full',operation={ticket='after-combat',kind='hold'}}; apply()
  assert(motor.look and motor.look.targetPositionProvider.worldOffset.z==0.10 and math.abs(motor.look.parts[1].weight-0.09)<0.00001)
  npc.IsAttached=function() error('destroyed NPC queried') end
  actuator.abandon(motor)
  assert(not motor.npc and not motor.look and motor.lookStyle=='none' and not motor.lookHeight and not motor.lookStrength)
`));

test('the real companion update applies settings to independent copies and dismissal preserves the other owner', () => run(`${companionEngine}
  local policy={eyeContactHeight=0,headFollowStrength=1}
  companions.gazeSettings=function() return policy end
  local one=spawn(); local two=spawn('panam-palmer'); tick(4)
  local firstOne,firstTwo=next(one.looks),next(two.looks)
  assert(firstOne and firstTwo and firstOne~=firstTwo)
  local commandsOne,commandsTwo=#one.ai.commands,#two.ai.commands
  policy={eyeContactHeight=0.05,headFollowStrength=0.5}; tick(1)
  local changedOne,changedTwo=next(one.looks),next(two.looks)
  assert(changedOne~=firstOne and changedTwo~=firstTwo and changedOne~=changedTwo)
  assert(changedOne.target==player and changedTwo.target==player)
  assert(changedOne.targetPositionProvider.worldOffset.z==0.05 and changedTwo.targetPositionProvider.worldOffset.z==0.05)
  assert(#one.ai.commands==commandsOne and #two.ai.commands==commandsTwo)
  assert(companions.dismiss(companions.list()[1].serial))
  assert(not next(one.looks) and two.looks[changedTwo] and not two.looks[changedOne])
  assert(#companions.list()==1)
`));

test('seated attention changes only the owned look after a stable mount and yields to a moving driver', () => run(`${fixture}
  npc.ai.GetCommandState=function() error('Seated gaze queried a locomotion command') end
  npc.ai.SendCommand=function() error('Seated gaze submitted a locomotion command') end
  local seated={player=player,vehicle='car',seat='seat_front_right',ready=true,selected=true,speed=12}
  local function seatTick(count)
    for _=1,count or 1 do actuator.applySeatedLook(motor,seated,0.1) end
  end
  actuator.applySeatedLook(motor,seated,2)
  assert(not motor.look,'A single delayed frame was mistaken for two stable seat observations')
  seatTick(3); assert(not motor.look,'Look started during seat settling')
  seatTick(4); local first=motor.look
  assert(first and first.parts[1].weight==0.18 and #first.parts==1 and countLooks()==1)
  seatTick(20); assert(motor.look==first and #npc.ai.commands==0)
  seated.seat='seat_front_left'; seatTick()
  assert(not motor.look and motor.seatedAttention.reason=='Driver watches the road')
  seated.speed=0; seatTick(3); assert(not motor.look)
  seatTick(4); assert(motor.look,'Stopped driver never regained attention')
  seated.speed=0.6; seatTick(); assert(not motor.look)
  seated.speed=0/0; seatTick(10); assert(not motor.look,'Unknown driver speed allowed a look')
  seated.seat='seat_front_right'; seated.speed=12; seatTick(7); assert(motor.look)
  seated.ready=false; seatTick(); assert(not motor.look)
  seated.ready=true; seatTick(3); assert(not motor.look,'Boarding release retained settled time')
  seatTick(4); assert(motor.look)
  seated.selected=false; seatTick(); assert(not motor.look and #npc.ai.commands==0)
`));

test('seated release retries its exact failed look and abandonment never queries torn down actors', () => run(`${fixture}
  local foreign={}; npc.looks[foreign]=true
  local seated={player=player,vehicle='car',seat='seat_front_right',ready=true,selected=true,speed=0}
  for _=1,7 do actuator.applySeatedLook(motor,seated,0.1) end
  local owned=motor.look; assert(owned)
  local originalRemove=LookAtRemoveEvent.QueueRemoveLookatEvent
  local attempts,blocked=0,true
  LookAtRemoveEvent.QueueRemoveLookatEvent=function(actor,event)
    assert(actor==npc and event==owned); attempts=attempts+1
    if blocked then return false end
    return originalRemove(actor,event)
  end
  seated.ready=false
  for _=1,15 do actuator.applySeatedLook(motor,seated,0.1) end
  assert(attempts==1 and motor.look==owned and npc.looks[foreign] and countLooks()==2)
  blocked=false; actuator.applySeatedLook(motor,seated,3.1)
  assert(attempts==2 and not motor.look and npc.looks[foreign] and countLooks()==1)
  assert(#npc.ai.commands==0)
  npc.IsAttached=function() error('Destroyed actor queried') end
  actuator.abandon(motor)
  assert(not motor.look and not motor.seatedAttention)
`));

const initSource=readFileSync(new URL('../mod/init.lua',import.meta.url),'utf8');
const targetSource=initSource.slice(initSource.indexOf('local function targetAtCrosshair()'),
  initSource.indexOf('local function resetGaze()'));
const targetingFixture=`
  local player={}
  local npc={root={x=0.5,y=0,z=0},head={x=0.5,y=0,z=0.9}}
  function npc:IsNPC() return true end
  function npc:IsAttached() return true end
  function npc:IsDeadNoStatPool() return false end
  function npc:GetEntityID() return {hash='judy'} end
  function npc:GetWorldPosition() return self.root end
  function npc:GetSlotComponent() return {GetSlotTransform=function(_,slot,...)
    assert(slot=='Head' and select('#',...)==0,'CET out parameters must be returned, not supplied')
    return npc.head~=nil,npc.head and {position=npc.head} or nil
  end} end
  WorldTransform={GetWorldPosition=function(value) return value.position end}
  WorldPosition={ToVector4=function(value) return value end}
  CName={new=function(value) return value end}
  local seats={npc}
  local companions={seatedCandidates=function() return seats end}
  TargetSearchQuery={new=function() return {} end}
  TS_TargetPartInfo={GetComponent=function() return {GetEntity=function() return npc end} end}
  local parts,nearest,looked={}
  local origin,forward={x=0,y=0,z=0.9},{x=1,y=0,z=0}
  local targeting={GetTargetParts=function() return true,parts end,
    GetObjectClosestToCrosshair=function() return nearest end,
    GetLookAtObject=function() return looked end,
    GetCrosshairData=function() return origin,forward end}
  Game={GetPlayer=function() return player end,GetTargetingSystem=function() return targeting end,
    ['TSF_NPC;']=function() return {} end}
  ${targetSource}
`;

test('seated selection uses the native head position when target parts omit a close passenger',()=>run(`${targetingFixture}
  assert(targetAtCrosshair()==npc,'A close seated head was lost above the fixed standing-height aim point')
  forward={x=-1,y=0,z=0}
  assert(targetAtCrosshair()==nil,'A passenger behind the camera acquired focus')
  forward={x=1,y=0,z=0}; seats={}
  assert(targetAtCrosshair()==nil,'An actor outside the verified same-car fallback acquired focus')
`));

test('unavailable seated head geometry cannot invent a fallback aim point or change standing selection',()=>run(`${targetingFixture}
  npc.head=nil; assert(targetAtCrosshair()==nil)
  npc.GetSlotComponent=function() error('head component unavailable') end
  assert(targetAtCrosshair()==nil)
  seats={}; parts={{}}; origin.z=1.3
  assert(targetAtCrosshair()==npc,'Standing selection was changed by the seated path')
`));

// October 9: a sad face (mod/facial-playback.lua gazeDrop) lowers the eye-contact target; the request is replaced
// only when the drop changes, and the user's height setting still adds to it.
test('a sad face lowers the owned look by its gaze drop and restores eye contact when the mood passes', () => run(`${fixture}
  local drop=0
  convaiFacialPlayback={gazeDrop=function(entity) assert(type(entity)=='string');return drop end}
  apply(); local first=motor.look
  assert(first.targetPositionProvider.worldOffset==nil)
  drop=-0.15; apply()
  local sad=motor.look
  assert(sad~=first and not npc.looks[first] and math.abs(sad.targetPositionProvider.worldOffset.z+0.15)<1e-6)
  for i=1,20 do apply() end
  assert(motor.look==sad and countLooks()==1,'no re-issue while the mood holds')
  context.gazeSettings={eyeContactHeight=0.05,headFollowStrength=1}; apply()
  assert(math.abs(motor.look.targetPositionProvider.worldOffset.z+0.10)<1e-6,'the user height adds')
  drop=0; context.gazeSettings=nil; apply()
  assert(motor.look.targetPositionProvider.worldOffset==nil and countLooks()==1,'eye contact again')
  convaiFacialPlayback={gazeDrop=function() error('broken') end}; apply()
  assert(countLooks()==1 and motor.look.targetPositionProvider.worldOffset==nil,'a failing face never moves the gaze')
`));
