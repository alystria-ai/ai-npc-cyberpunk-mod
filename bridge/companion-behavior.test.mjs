import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionModules, flatNavigation} from './companion-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8');
const locomotion = readFileSync(new URL('../mod/companion-locomotion.lua', import.meta.url), 'utf8');
const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

// Execute production Lua with command ownership and explicit measured positions.
// This verifies arbitration, not native animation, pathfinding or rendered gait.
const fixture = `
  io.open=function() return nil end
  ${companionModules}
  Vector4={new=function(x,y,z,w) return {x=x,y=y,z=z or 0,w=w or 1} end}
  Enum={new=function(_, value) return value end}; CName={new=function(value) return value end}
  TweakDBID={new=function(value) return value end}
  TweakDB={GetRecord=function() return {IsA=function() return true end} end}
  WorldPosition={new=function() return {SetVector4=function(self,p) self.position=p end} end}
  AIPositionSpec={new=function() return {
    SetWorldPosition=function(self,p) self.position=p.position end,
    SetEntity=function(self,e) self.entity=e end} end}
  LookAtPartRequest={new=function() return {} end}
  LookAtAddEvent={new=function() return {request={limits={}},
    SetEntityTarget=function(self,target) self.target=target end,
    SetStyle=function() end,
    SetAdditionalPartsArray=function(self,parts) self.parts=parts end} end}
  LookAtRemoveEvent={QueueRemoveLookatEvent=function(npc,event) npc.looks[event]=nil end}
  NewObject=function(kind) return {kind=kind, state='New',
    rotateEntityTowardsFacingTarget=true, OnRoleCleared=function() end} end
  local player={pos=Vector4.new(0,0),forward=Vector4.new(0,1)}
  function player:GetWorldPosition() return self.pos end
  function player:GetWorldForward() return self.forward end
  function player:GetWorldOrientation() return {} end
  local entities, sequence={},0
  local system={IsReady=function() return true end, IsSpawned=function() return true end}
  function system:CreateEntity(spec)
    sequence=sequence+1
    local ai={commands={}, role={IsA=function() return true end}}
    function ai:GetAIRole() return self.role end
    function ai:SetAIRole(role) self.role=role end
    function ai:OnAttach() end
    function ai:SendCommand(cmd)
      cmd.id=#self.commands+1; cmd.state='Executing'; self.commands[#self.commands+1]=cmd
      if self.onSend then self.onSend(cmd) end
    end
    function ai:GetCommandState(cmd) return cmd.state end
    function ai:StopExecutingCommand(cmd) cmd.state='Stopped' end
    function ai:CancelCommand(cmd) cmd.state='Cancelled' end
    local npc={id={hash=tostring(sequence)},pos=spec.position,forward=Vector4.new(0,1),ai=ai,looks={}}
    function npc:GetEntityID() return self.id end
    function npc:IsAttached() return true end
    function npc:IsA(kind) return kind=='NPCPuppet' end
    function npc:IsCrowd() return false end
    function npc:IsDeadNoStatPool() return false end
    function npc:GetWorldPosition() return self.pos end
    function npc:GetWorldForward() return self.forward end
    function npc:GetAIControllerComponent() return self.ai end
    function npc:GetComponents() return self.components or {} end
    function npc:QueueEvent(event) self.looks[event]=true end
    entities[sequence]=npc
    return npc.id
  end
  function system:GetEntity(id) return entities[tonumber(id.hash)] end
  function system:DeleteEntity(id) entities[tonumber(id.hash)]=nil; return true end
  Game={GetPlayer=function() return player end,GetDynamicEntitySystem=function() return system end,
    GetTargetingSystem=function() return {GetCrosshairData=function() return nil,player.forward end} end,
    CreateEntityReference=function() return {} end}
  NPCPuppet={IsInCombat=function(npc) return npc.combat or false end}
  ${flatNavigation}
  local companions=(function() ${source} end)()
  local function tick(count,focus)
    for i=1,(count or 1) do companions.update(player,0.5,focus) end
    for _,row in ipairs(companions.list()) do assert(not row.error, row.error) end
  end
  local function spawn(key) companions.spawn(key or 'judy-alvarez'); tick(); return entities[sequence] end
  local function active(npc,kind)
    local result={}
    for _,cmd in ipairs(npc.ai.commands) do
      if cmd.state=='Executing' and (not kind or cmd.kind==kind) then result[#result+1]=cmd end
    end
    return result
  end
  local function last(npc,kind)
    for i=#npc.ai.commands,1,-1 do if npc.ai.commands[i].kind==kind then return npc.ai.commands[i] end end
  end
`;

test('catch-up releases attention and never pins running body direction to V', () => run(`${fixture}
  local npc=spawn(); tick(3)
  player.pos=Vector4.new(0,8); tick(1,npc.id.hash)
  local cmd=last(npc,'AIFollowTargetCommand')
  assert(cmd and cmd.movementType=='Sprint', 'looking at a running follower must not stop catch-up')
  assert(cmd.lookAtTarget==nil, 'catch-up must not face V independently of locomotion')
  assert(next(npc.looks)==nil and #active(npc,'AIRotateToCommand')==0)
`));

test('owned ghost copies become visible before ready without altering other entities or ordinary components', () => run(`${fixture}
  local function phantom()
    return {enabled=true, IsA=function(_,kind) return kind=='gamePhantomEntityComponent' end,
      Toggle=function(self,on) self.enabled=on end, IsEnabled=function(self) return self.enabled end}
  end
  local story=phantom()
  companions.spawn('judy-alvarez')
  local npc=entities[1]; local ghost=phantom()
  npc.components={ghost, {IsA=function() return false end, Toggle=function() error('ordinary component changed') end}}
  tick()
  assert(not ghost.enabled and story.enabled)
  local visible=false
  for event in pairs(npc.looks) do
    if event.kind=='enteventsSetVisibility' then
      assert(event.visible and event.source=='PhantomEntitySystem'); visible=true
    end
  end
  assert(visible and companions.list()[1].state=='ready')
  companions.spawn('panam-palmer')
  local blocked=phantom(); blocked.Toggle=function() end
  entities[2].components={blocked}
  companions.update(player,0.5)
  assert(companions.list()[2].state=='failed' and entities[2]==nil,
    'visibility failure must not be reported as a ready companion')
`));

test('post-run rejoin uses path facing, including after a conversation step', () => run(`${fixture}
  local npc=spawn(); tick(4,npc.id.hash)
  player.pos=Vector4.new(0,8); tick(1); tick(3)
  npc.pos=Vector4.new(1.5,6); tick(2)
  local move=last(npc,'AIMoveToCommand')
  assert(move and move.rotateEntityTowardsFacingTarget==false, 'rejoin must explicitly disable strafing')
  assert(not move.facingTarget or not move.facingTarget.entity, 'no entity-facing target while rejoining')
  assert(next(npc.looks)==nil, 'finish rejoining before making eye contact')
`));

test('looking at an approaching member does not interrupt their arrival', () => run(`${fixture}
  local npc=spawn(); tick(3)
  npc.pos=Vector4.new(1.5,-2); tick(3,npc.id.hash)
  assert(#active(npc,'AIMoveToCommand')==1, 'an approaching member must keep their route')
  assert(last(npc,'AIMoveToCommand').rotateEntityTowardsFacingTarget==false)
  assert(#active(npc,'AIRotateToCommand')==0 and #active(npc,'AIHoldPositionCommand')==0)
  assert(next(npc.looks)==nil)
`));

test('settled members can attend once; departure releases step, turn and hold together', () => run(`${fixture}
  local npc=spawn(); tick(3); tick(1,npc.id.hash)
  local step=last(npc,'AIMoveToCommand'); assert(step, 'settled attention retains the accepted small step')
  step.state='Succeeded'; npc.pos=step.movementTarget.position
  tick(4,npc.id.hash)
  local count=#npc.ai.commands; tick(3,npc.id.hash)
  assert(last(npc,'AIMoveToCommand')==step, 'no repeated attention step at the same stop')
  player.pos=Vector4.new(0,2); tick(1,npc.id.hash)
  assert(#active(npc,'AIRotateToCommand')==0 and #active(npc,'AIHoldPositionCommand')==0)
  assert(step.state~='Executing', 'departure cannot retain a conversation step')
`));

test('combat wins over gaze and releases all commands owned by the social controller', () => run(`${fixture}
  local npc=spawn(); tick(3); tick(1,npc.id.hash)
  npc.combat=true; tick(1,npc.id.hash)
  assert(#active(npc)==0, 'combat must release step, rotation, hold and locomotion')
  assert(next(npc.looks)==nil)
`));

test('camera turns keep distinct copy positions without issuing walking commands', () => run(`${fixture}
  local one=spawn(); local two=spawn(); local three=spawn('panam-palmer'); tick(5)
  local counts={#one.ai.commands,#two.ai.commands,#three.ai.commands}
  player.forward=Vector4.new(1,0); tick(5)
  for i,npc in ipairs({one,two,three}) do
    assert(#npc.ai.commands==counts[i], 'turning the camera must not move party feet')
  end
  assert(one.pos.x~=two.pos.x and (three.pos.x~=one.pos.x or three.pos.y~=one.pos.y))
`));

test('a small step inside the resting group does not restart everybody\'s formation', () => run(`${fixture}
  local one=spawn(); local two=spawn(); local three=spawn('panam-palmer'); tick(5)
  local counts={#one.ai.commands,#two.ai.commands,#three.ai.commands}
  player.pos=Vector4.new(0,0.6); tick(4)
  for i,npc in ipairs({one,two,three}) do
    assert(#npc.ai.commands==counts[i], 'local reposition by V made the whole group relocate')
  end
  player.pos=Vector4.new(0,4); tick(1)
  assert(last(one,'AIFollowTargetCommand'), 'leaving the resting group must still start catch-up')
`));

test('a short route behind the companion turns first instead of starting a backward walk', () => run(`${fixture}
  local npc=spawn(); tick(4)
  npc.pos=Vector4.new(1.5,3); tick(1)
  local turn=last(npc,'AIRotateToCommand')
  assert(turn and #active(npc,'AIMoveToCommand')==0, 'a short backward correction needs a turn before locomotion')
  assert(next(npc.looks)==nil, 'route turn must not fight social gaze')
  npc.forward=Vector4.new(0,-1); turn.state='Success'; tick(2)
  assert(#active(npc,'AIMoveToCommand')==1)
  assert(last(npc,'AIMoveToCommand').rotateEntityTowardsFacingTarget==false)
`));

test('a walking leg owns steering and is not repeatedly cancelled by yaw changes', () => run(`${fixture}
  local npc=spawn(); tick(3)
  npc.pos=Vector4.new(1.5,-2); tick(2)
  local move=last(npc,'AIMoveToCommand'); assert(move)
  npc.forward=Vector4.new(0,-1); tick(2)
  assert(#active(npc,'AIRotateToCommand')==0, 'a yaw change during a walking leg must not start another turn')
  assert(move.state=='Executing', 'do not cancel a short walking route to correct yaw')
`));

test('an accepted loose side spot remains accepted for the whole stop', () => run(`${fixture}
  local npc=spawn(); tick(3)
  player.pos=Vector4.new(0,8); tick(1); tick(3)
  npc.pos=Vector4.new(2.2,8.05); tick(1)
  local count=#npc.ai.commands
  tick(6)
  assert(#active(npc,'AIMoveToCommand')==0 and #active(npc,'AIRotateToCommand')==0,
    'an accepted side spot was revoked in favor of the exact mathematical seat')
  assert(#npc.ai.commands==count, 'settling should not restart walking each update')
`));

test('looking away does not rotate a settled friend back to the group heading', () => run(`${fixture}
  local npc=spawn(); tick(3); tick(1,npc.id.hash)
  local step=last(npc,'AIMoveToCommand')
  npc.pos=step.movementTarget.position; step.state='Success'
  npc.forward=Vector4.new(-npc.pos.x,-npc.pos.y)
  tick(2,npc.id.hash)
  local count=#npc.ai.commands
  player.forward=Vector4.new(1,0); tick(5)
  assert(#active(npc,'AIRotateToCommand')==0, 'look-away must not align the body to a travel or camera heading')
  assert(#npc.ai.commands==count and last(npc,'AIMoveToCommand')==step,
    'keep the natural conversation step and do not force a second reposition')
`));

const nativeFacing = `
  local observer
  ObserveAfter=function(_,_,callback) observer=callback end
  AIPositionSpec.IsEntity=function(spec) return spec and spec.entity~=nil end
  local mapping={GetArgumentName=function() return '_facingTarget' end,
    GetArgumentType=function() return 'AIArgumentType : Object (7)' end,
    GetParameterizationType=function() return 'AIParameterizationType : BehaviorArgument (0)' end}
  local handler={outFacingTarget=mapping}
  ScriptExecutionContext={
    GetOwner=function(context) return context.owner end,
    GetArgumentObject=function(context,name) return context[name] end,
    SetArgumentObject=function(context,name,value) context[name]=value end,
  }
  local motion=(function() ${locomotion} end)()
  motion.install(companions.ownsTravelCommand)
`;

test('native retained facing is cleared only for the current owned travel command, even during SendCommand', () => run(`${fixture}
  ${nativeFacing}
  local npc=spawn(); tick(3)
  local context={owner=npc}
  npc.ai.onSend=function(command)
    if command.kind~='AIMoveToCommand' then return end
    -- Model the engine handler: an empty spec leaves the old object in place.
    if AIPositionSpec.IsEntity(command.facingTarget) then context._facingTarget=command.facingTarget.entity end
    observer(handler,context,command)
  end
  tick(1,npc.id.hash)
  assert(context._facingTarget==player, 'the useful conversation step must retain its facing target')
  player.pos=Vector4.new(0,8); tick(1); tick(3)
  npc.pos=Vector4.new(1.5,6); tick(2)
  local travel=last(npc,'AIMoveToCommand')
  assert(context._facingTarget==nil and motion.cleared==1, 'an ordinary walk inherited the conversation facing target')
  assert(companions.ownsTravelCommand(npc,travel), 'native callback must recognize ownership before SendCommand returns')
  context._facingTarget=player
  observer(handler,context,{id=999, rotateEntityTowardsFacingTarget=false})
  assert(context._facingTarget==player, 'commands from another system on our copy must remain untouched')
  local foreign={GetEntityID=function() return {hash='quest-actor'} end}
  context.owner=foreign; observer(handler,context,travel)
  assert(context._facingTarget==player, 'story NPC facing must remain untouched')
  context.owner=npc; companions.abandon(); observer(handler,context,travel)
  assert(context._facingTarget==player, 'an old copy cannot retain command ownership across save unload')
`));

test('native facing cleanup respects explicit targets and skips unconfigured mappings', () => run(`${fixture}
  ${nativeFacing}
  local context={_facingTarget=player}
  assert(not motion.apply(handler,context,{rotateEntityTowardsFacingTarget=true}))
  assert(not motion.apply(handler,context,{rotateEntityTowardsFacingTarget=false,facingTarget={entity=player}}))
  assert(context._facingTarget==player)
  assert(not motion.apply({},context,{rotateEntityTowardsFacingTarget=false}))
  mapping.GetParameterizationType=function() return 'AIParameterizationType : CustomValue (1)' end
  assert(not motion.apply(handler,context,{rotateEntityTowardsFacingTarget=false}))
  assert(context._facingTarget==player and motion.cleared==0)
`));

test('managed gaze has one owner and does not also start the civilian native hold', () => {
  const begin = init.slice(init.indexOf('local function beginFocus('), init.indexOf('local function gameplayCanAcquire('));
  run(`
    local calls=0
    local companions={owns=function(npc) return npc.managed end}
    local function endFocus() end
    local function log() end
    local player={ConvaiBeginFocus=function() calls=calls+1; return true end}
    local npc={managed=true,GetEntityID=function() return {hash='1'} end}
    ${begin}
    assert(beginFocus(player,npc)==true and calls==0, 'managed attention belongs to the formation controller')
    npc.managed=false
    assert(beginFocus(player,npc)==true and calls==1, 'ordinary world NPC behavior stays on its existing path')
  `);
});

test('save unload discards references without querying or cancelling a destroyed AI controller', () => run(`${fixture}
  local npc=spawn(); tick(3); tick(1,npc.id.hash)
  npc.ai.GetCommandState=function() error('destroyed native controller') end
  npc.GetAIControllerComponent=function() error('destroyed native actor') end
  system.DeleteEntity=function() error('world is unloading') end
  assert(#companions.list()==1, 'menu snapshots must not query native commands')
  companions.abandon()
  assert(#companions.list()==0 and #companions.connectionProfiles()==0)
  assert(companions.dismissAll(), 'shutdown after unload must not call the old world')
`));

test('invitations refuse a road beneath V and never create an entity there', () => run(`${fixture}
  player.pos=Vector4.new(0,0,12)
  Game.GetAINavigationSystem=function() return {
    FindPointInSphereForCharacter=function() return {status='OK',point=Vector4.new(0,0,0)} end
  } end
  local id,reason=companions.spawn('judy-alvarez')
  assert(not id and reason:find('walkable') and sequence==0)
`));

test('invitations reject disconnected floors and reserve separate safe positions for copies', () => run(`${fixture}
  Game.GetAINavigationSystem=function() return {
    FindPointInSphereForCharacter=function(_,p) return {status='OK',point=p} end,
    CalculatePathForCharacter=function(_,a,b) return {path={a,Vector4.new(0,0,-4),b},CalculateLength=function() return 2 end} end
  } end
  assert(not companions.spawn('judy-alvarez') and sequence==0)
  ${flatNavigation}
  local one=companions.spawn('judy-alvarez'); local two=companions.spawn('judy-alvarez')
  assert(one and two and entities[1].pos.x~=entities[2].pos.x)
`));

test('an engine placement on a different floor is removed before assigning a follower role', () => run(`${fixture}
  assert(companions.spawn('judy-alvarez'))
  entities[1].pos.z=-9
  companions.update(player,0.5)
  local member=companions.list()[1]
  assert(member.state=='failed' and member.error:find('verified ground'))
  assert(entities[1]==nil and #companions.connectionProfiles()==0)
`));

test('arrival requires actual settling before gaze can take over; losing gaze does not repeat the small step', () => run(`${fixture}
  local npc=spawn(); tick(3)
  player.pos=Vector4.new(0,8); tick(); tick(3)
  npc.pos=Vector4.new(1.5,6); tick(2,npc.id.hash)
  local approach=last(npc,'AIMoveToCommand')
  npc.pos=approach.movementTarget.position; approach.state='Succeeded'
  tick(1,npc.id.hash)
  assert(not companions.list()[1].focused, 'arrival momentum must settle before the turn')
  tick(2,npc.id.hash)
  local step=last(npc,'AIMoveToCommand')
  assert(step~=approach and step.rotateEntityTowardsFacingTarget==true)
  npc.pos=step.movementTarget.position; step.state='Succeeded'; tick(1,npc.id.hash)
  tick(3); tick(3,npc.id.hash)
  assert(last(npc,'AIMoveToCommand')==step, 'a glance away cannot cause a second sideways shuffle')
`));

test('a blocked route gets one quiet native recovery interval rather than a command every frame', () => run(`${fixture}
  local npc=spawn(); tick(3)
  npc.pos=Vector4.new(1.5,-3); tick(10)
  assert(companions.list()[1].behavior=='recover')
  local follow=last(npc,'AIFollowTargetCommand'); local count=#npc.ai.commands
  tick(3)
  assert(last(npc,'AIFollowTargetCommand')==follow and #npc.ai.commands==count)
`));
