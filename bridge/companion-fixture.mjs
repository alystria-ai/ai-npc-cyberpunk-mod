import {readFileSync} from 'node:fs';

const behavior = readFileSync(new URL('../mod/companion-behavior.lua', import.meta.url), 'utf8');
const placement = readFileSync(new URL('../mod/companion-placement.lua', import.meta.url), 'utf8');
const appearance = readFileSync(new URL('../mod/companion-appearance.lua', import.meta.url), 'utf8');
const spawnRecords = readFileSync(new URL('../mod/companion-records.lua', import.meta.url), 'utf8');
const space = readFileSync(new URL('../mod/companion-space.lua', import.meta.url), 'utf8');
const travel = readFileSync(new URL('../mod/companion-travel.lua', import.meta.url), 'utf8');
const actuator = readFileSync(new URL('../mod/companion-actuator.lua', import.meta.url), 'utf8');
export const companionModules = `
  dofile=function(file)
    if file=='companion-space.lua' then return (function() ${space} end)() end
    if file=='companion-travel.lua' then return (function() ${travel} end)() end
    if file=='companion-actuator.lua' then return (function() ${actuator} end)() end
    if file=='companion-behavior.lua' then return (function() ${behavior} end)() end
    if file=='companion-placement.lua' then return (function() ${placement} end)() end
    if file=='companion-appearance.lua' then return (function() ${appearance} end)() end
    if file=='companion-records.lua' then return (function() ${spawnRecords} end)() end
    error('Unexpected module '..file)
  end
`;

// An open, flat navmesh. Individual placement cases override the native adapter.
export const flatNavigation = `
  Game.GetAINavigationSystem=function() return {
    FindPointInSphereForCharacter=function(_,position) return {status='OK',point=position} end,
    CalculatePathForCharacter=function(_,origin,destination)
      return {path={origin,destination}, CalculateLength=function()
        return math.sqrt((destination.x-origin.x)^2+(destination.y-origin.y)^2+(destination.z-origin.z)^2)
      end}
    end
  } end
`;

const source = readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8');
export const companionEngine = `
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
    local npc={id={hash=tostring(sequence)},pos=spec.position,forward=Vector4.new(0,1),ai=ai,looks={},spec=spec}
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
