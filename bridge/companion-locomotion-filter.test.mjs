import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

// The MoveTo filter (docs/COMPANION_IMPROVEMENTS_2026-10-17.md, item 2): r6/scripts/CyberpunkConvai/Locomotion.reds reports to Lua
// only the move commands the movement controller marked, and mod/companion-locomotion.lua observes that report instead of the
// engine's UpdateCommand. These tests run the production Lua against a model of the game's side of the hook, and read the
// redscript as text (no compiler here; scripts/Compile-Redscript.ps1 is the compile check).
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const locomotion = read('../mod/companion-locomotion.lua');
const reds = read('../r6/scripts/CyberpunkConvai/Locomotion.reds');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

// Standalone module with a fake CET: registers are recorded by method name.
const standalone = `
  local registered={}
  ObserveAfter=function(class,method,callback)
    assert(class=='AIMoveToCommandHandler')
    if _G.observeFails and _G.observeFails[method] then error('Function '..method..' not found') end
    registered[#registered+1]={method=method,callback=callback}
  end
  local function methods() local list={} for _,r in ipairs(registered) do list[#list+1]=r.method end return table.concat(list,',') end
  local function reflection(present)
    Reflection={GetClass=function(name)
      return {GetFunction=function(_,method) return present[name..'.'..method] and {} or nil end}
    end}
  end
  local both={['AIMoveToCommandHandler.ConvaiOwnedMoveUpdate']=true,['AIMoveToCommand.ConvaiMarkOwned']=true}
  local function load() return (function() ${locomotion} end)() end
`;

test('the script half is present: Lua observes the mod-only method and never the engine one', () => run(`${standalone}
  reflection(both)
  local motion=load(); motion.install(function() return false end)
  assert(motion.mode=='filtered' and motion.installed)
  assert(methods()=='ConvaiOwnedMoveUpdate', methods())
`));

test('fallbacks keep the previous engine hook: missing method, failing Observe, unreadable reflection, and the kill switch', () => run(`${standalone}
  -- 1. reflection says the method is not there (old scripts, or the scripts did not compile)
  reflection({['AIMoveToCommandHandler.ConvaiOwnedMoveUpdate']=false,['AIMoveToCommand.ConvaiMarkOwned']=true})
  local motion=load(); motion.install(function() return false end)
  assert(motion.mode=='engine' and methods()=='UpdateCommand', methods())
  -- 2. the marking method is missing even though the update method exists
  registered={}
  reflection({['AIMoveToCommandHandler.ConvaiOwnedMoveUpdate']=true})
  motion=load(); motion.install(function() return false end)
  assert(motion.mode=='engine' and methods()=='UpdateCommand', methods())
  -- 3. no reflection API: the Observe call itself decides, and its error is swallowed
  registered={}; Reflection=nil; observeFails={ConvaiOwnedMoveUpdate=true}
  motion=load(); motion.install(function() return false end)
  assert(motion.mode=='engine' and methods()=='UpdateCommand', methods())
  -- 4. reflection that raises is no answer either
  registered={}; observeFails=nil
  Reflection={GetClass=function() error('no reflection') end}
  motion=load(); motion.install(function() return false end)
  assert(motion.mode=='filtered' and methods()=='ConvaiOwnedMoveUpdate', methods())
  -- 5. the kill switch file
  registered={}; reflection(both)
  local realOpen=io.open
  io.open=function(path,...)
    if path=='runtime/locomotion-engine-hook.txt' then return {close=function() end} end
    return realOpen(path,...)
  end
  motion=load(); motion.install(function() return false end)
  io.open=realOpen
  assert(motion.mode=='engine' and methods()=='UpdateCommand', methods())
  -- install is idempotent
  motion.install(function() return false end)
  assert(methods()=='UpdateCommand')
`));

test('mark: sets the flag through the script method, is a no-op for the engine hook, and a failing mark falls back once', () => run(`${standalone}
  reflection(both)
  local motion=load(); motion.install(function() return false end)
  local marks=0
  local command={ConvaiMarkOwned=function(self) marks=marks+1; self.m_convaiOwned=true end}
  assert(motion.mark(command)==true and command.m_convaiOwned and motion.marked==1)
  assert(motion.mark(nil)==false)
  -- scripts older than this file: the method is not callable on the command
  local old={}
  assert(motion.mark(old)==false)
  assert(motion.markFailed==1 and motion.mode=='engine' and methods()=='ConvaiOwnedMoveUpdate,UpdateCommand', methods())
  assert(motion.mark({ConvaiMarkOwned=function() end})==false, 'marking is off once the engine hook is in use')
  assert(motion.mark(old)==false and methods()=='ConvaiOwnedMoveUpdate,UpdateCommand', 'the engine hook was registered twice')
  -- the engine mode never marks
  registered={}; reflection({})
  local engine=load(); engine.install(function() return false end)
  local touched=false
  assert(engine.mode=='engine' and engine.mark({ConvaiMarkOwned=function() touched=true end})==false and not touched)
`));

// The game's side, around the real controller: the engine calls UpdateCommand for every walking NPC; the redscript wrapper
// (modelled as in Locomotion.reds) reports a marked command to ConvaiOwnedMoveUpdate after the original.
const world = `${companionEngine}
  local observers={}
  ObserveAfter=function(class,method,callback) observers[method]=observers[method] or {}; table.insert(observers[method],callback) end
  Reflection={GetClass=function() return {GetFunction=function() return {} end} end}
  AIPositionSpec.IsEntity=function(spec) return spec and spec.entity~=nil end
  local mapping={GetArgumentName=function() return '_facingTarget' end,
    GetArgumentType=function() return 'AIArgumentType : Object (7)' end,
    GetParameterizationType=function() return 'AIParameterizationType : BehaviorArgument (0)' end}
  local handler={outFacingTarget=mapping}
  local owners=0
  ScriptExecutionContext={
    GetOwner=function(context) owners=owners+1; return context.owner end,
    GetArgumentObject=function(context,name) return context[name] end,
    SetArgumentObject=function(context,name,value) context[name]=value end}
  local realNewObject=NewObject
  NewObject=function(kind)
    local object=realNewObject(kind)
    if kind=='AIMoveToCommand' then object.ConvaiMarkOwned=function(self) self.m_convaiOwned=true end end
    return object
  end
  local entered={update=0,engine=0}
  local function updateCommand(owner,command,context)
    context=context or {owner=owner}
    context.owner=owner
    local original=true -- the engine's own work, always first
    for _,callback in ipairs(observers['UpdateCommand'] or {}) do entered.engine=entered.engine+1; callback(handler,context,command) end
    if command.m_convaiOwned then
      command.m_convaiOwned=false -- Locomotion.reds: disarmed before the report; Lua may arm it again
      for _,callback in ipairs(observers['ConvaiOwnedMoveUpdate'] or {}) do entered.update=entered.update+1; callback(handler,context,command) end
    end
    return context
  end
  local motion=(function() ${locomotion} end)()
  convaiLocomotion=motion
  motion.install(companions.ownsTravelCommand)
  assert(motion.mode=='filtered')
`;

test('ordinary walking NPCs never enter Lua; a companion walk is marked, reported, and its stale facing cleared as before', () => run(`${world}
  -- 300 ordinary NPCs on move commands of their own (vanilla, a quest, another mod): unmarked.
  for index=1,300 do
    updateCommand({GetEntityID=function() return {hash='world-'..index} end},{id=index,rotateEntityTowardsFacingTarget=false})
  end
  assert(entered.update==0 and entered.engine==0 and owners==0, 'an ordinary NPC reached Lua')
  local npc=spawn(); tick(3)
  -- A command from another system on our copy (not one the controller marked) does not reach Lua either.
  local foreign={id=999,rotateEntityTowardsFacingTarget=false}
  updateCommand(npc,foreign)
  assert(entered.update==0 and owners==0)
  player.pos=Vector4.new(0,8); tick(1); tick(3)
  npc.pos=Vector4.new(1.5,6); tick(2)
  local travel=last(npc,'AIMoveToCommand')
  assert(travel and travel.m_convaiOwned==true, 'the controller did not mark its walking command')
  assert(companions.ownsTravelCommand(npc,travel))
  local context={_facingTarget=player}
  updateCommand(npc,travel,context)
  assert(entered.update==1 and entered.engine==0)
  assert(context._facingTarget==nil and motion.cleared==1, 'the stale facing target was not cleared')
  -- Reported once: the command is disarmed, its other AI ticks never enter Lua and read no AI context.
  assert(travel.m_convaiOwned==false, 'the command stayed armed after its report')
  owners=0
  for _=1,50 do updateCommand(npc,travel,context) end
  assert(entered.update==1 and owners==0, 'a command that was already reported entered Lua again')
  -- The next command the controller sends is marked again and reported once more.
  travel.m_convaiOwned=true
  -- Teardown rule is unchanged: after abandon a marked command makes no native call.
  companions.abandon()
  owners=0
  context._facingTarget=player
  updateCommand(npc,travel,context)
  assert(owners==0 and context._facingTarget==player, 'the filtered hook read an AI context while the session is abandoned')
`));

test('the controller marks the walking commands it sends and nothing else', () => {
  run(`${world}
    local npc=spawn(); tick(3)
    player.pos=Vector4.new(0,8); tick(1); tick(3)
    npc.pos=Vector4.new(1.5,6); tick(2)
    local total=0
    for _,command in ipairs(npc.ai.commands) do
      if command.kind=='AIMoveToCommand' then
        total=total+1
        assert(command.m_convaiOwned==true, 'a walking command was sent unmarked')
      else
        assert(not command.m_convaiOwned, command.kind..' was marked')
      end
    end
    assert(total>0, 'no walking command was sent')
  `);
  // One marking site, inside walk(): board, unstick and every other command stay unreported (ownsTravel never claims them).
  const actuator = read('../mod/companion-actuator.lua');
  assert.equal([...actuator.matchAll(/convaiLocomotion\.mark\(/g)].length, 1);
  const walk = actuator.slice(actuator.indexOf('local function walk(s,intent,c)'), actuator.indexOf('local function follow(s,intent,c)'));
  assert.match(walk, /convaiLocomotion\.mark\(cmd\)[\s\S]*submit\(s,cmd\)/, 'mark before the command is sent');
});

test('Locomotion.reds: the wrapper runs the original first, returns its result, tests one Bool and does nothing else', () => {
  const wrapper = reds.match(/@wrapMethod\(AIMoveToCommandHandler\)\s*protected func UpdateCommand\([^)]*\) -> AIbehaviorUpdateOutcome \{([\s\S]*?)\n\}/);
  assert(wrapper, 'the wrap of AIMoveToCommandHandler.UpdateCommand is missing');
  const body = wrapper[1];
  assert.match(body, /^\s*let outcome: AIbehaviorUpdateOutcome = wrappedMethod\(context, command\);/, 'the original must run first, unconditionally');
  assert.match(body, /return outcome;\s*$/, 'the original result must be returned unchanged');
  assert.equal([...body.matchAll(/wrappedMethod\(/g)].length, 1);
  assert.match(body, /IsDefined\(move\) && move\.m_convaiOwned/);
  // Nothing per call besides the cast, the Bool read and the empty report: no string building, no game-system lookups.
  assert.doesNotMatch(body, /GetOwner|GameInstance|GetDynamicEntitySystem|StrLen|n"|"|\+/);
  assert.match(reds, /@addMethod\(AIMoveToCommandHandler\)\s*public final func ConvaiOwnedMoveUpdate\(context: ScriptExecutionContext, command: ref<AICommand>\) -> Void \{\s*\}/, 'the report method must be empty');
  assert.match(reds, /@addField\(AIMoveToCommand\)\s*public let m_convaiOwned: Bool;/);
  assert.doesNotMatch(reds, /AMM|reference-amm/i);
});

test('Locomotion.reds ships: it is in the release plan and in the development install with matching targets', () => {
  for (const file of ['../packaging/release-plan.json', '../scripts/development-files.json']) {
    const entries = [...read(file).matchAll(/"source": "(r6\/scripts\/CyberpunkConvai\/Locomotion\.reds)",\s*"target": "([^"]+)"/g)];
    assert.equal(entries.length, 1, `${file} must list Locomotion.reds once`);
    assert.equal(entries[0][2], 'r6/scripts/CyberpunkConvai/Locomotion.reds');
  }
});

test('a report that cannot finish arms the command again; one that finished does not; the engine fallback never arms anything', () => run(`${world}
  local npc=spawn(); tick(3)
  player.pos=Vector4.new(0,8); tick(1); tick(3)
  npc.pos=Vector4.new(1.5,6); tick(2)
  local travel=last(npc,'AIMoveToCommand')
  local context={_facingTarget=player}
  -- Not this copy's current travel command yet (ownership not established): armed again, retried on the next tick.
  local real=motion.ownsCommand
  motion.ownsCommand=function() return false end
  updateCommand(npc,travel,context)
  assert(entered.update==1 and travel.m_convaiOwned==true and motion.rearmed==1, 'an unfinished report did not arm the command again')
  motion.ownsCommand=real
  updateCommand(npc,travel,context)
  assert(entered.update==2 and travel.m_convaiOwned==false and context._facingTarget==nil, 'the retry did not finish the cleanup')
  -- A failure inside the cleanup is retried too.
  travel.m_convaiOwned=true; context._facingTarget=player
  local setter=ScriptExecutionContext.SetArgumentObject
  ScriptExecutionContext.SetArgumentObject=function() error('boom') end
  updateCommand(npc,travel,context)
  assert(travel.m_convaiOwned==true and motion.error and motion.error:find('boom'), 'a failed cleanup did not arm the command again')
  ScriptExecutionContext.SetArgumentObject=setter
  -- Engine fallback: the hook sees every command, so nothing is ever marked from Lua.
  motion.mode='engine'
  local other={}
  motion.ownsCommand=function() return false end
  local touched=false
  other.ConvaiMarkOwned=function() touched=true end
  for _,callback in ipairs(observers['ConvaiOwnedMoveUpdate'] or {}) do callback(handler,{owner=npc},other) end
  assert(not touched, 'the engine fallback armed a command')
`));
