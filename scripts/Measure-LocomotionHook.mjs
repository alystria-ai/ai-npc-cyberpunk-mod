#!/usr/bin/env node
// Unit-level measure of the MoveTo hook (docs/COMPANION_IMPROVEMENTS_2026-10-17.md, item 2). Headless: production Lua
// (mod/companion-locomotion.lua, the movement controller and companions.ownsTravelCommand) runs in fengari against a model of the
// game's side of the hook: every walking NPC's AIMoveToCommandHandler.UpdateCommand is called once per tick, and the model
// of the redscript wrapper (r6/scripts/CyberpunkConvai/Locomotion.reds) calls ConvaiOwnedMoveUpdate only for a marked command.
//
// It reports, per scenario (companions K, ordinary walking NPCs N):
//   luaCalls   how many times the Lua observer is entered over TICKS ticks;
//   luaMsTick  the Lua time per tick, in fengari (relative: CET's own trampoline per call is NOT in this number);
//   owners     GetOwner calls from Lua (a native call each in the game).
// "before" runs the engine hook (the previous build, read from git), "after" the filtered hook (the working tree).
//
// Usage: node scripts/Measure-LocomotionHook.mjs [--before-ref <git ref>] [--ticks <n>] [--json]
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fengari from 'fengari';
import {companionEngine} from '../bridge/companion-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const ref = option('--before-ref', 'spawned-characters');
const ticks = Number(option('--ticks', '600'));
const asJson = args.includes('--json');

const afterSource = readFileSync(path.join(root, 'mod/companion-locomotion.lua'), 'utf8');
const beforeSource = execFileSync('git', ['show', `${ref}:mod/companion-locomotion.lua`], {cwd: root, encoding: 'utf8', maxBuffer: 1 << 24});

function scenario(source, filtered, companions, movers) {
  const program = `${companionEngine}
    -- The game's side of the hook.
    local observers={}
    ObserveAfter=function(class,method,callback) observers[method]=observers[method] or {}; table.insert(observers[method],callback) end
    ${filtered ? `Reflection={GetClass=function() return {GetFunction=function() return {} end} end}` : ''}
    AIPositionSpec.IsEntity=function(spec) return spec and spec.entity~=nil end
    local mapping={GetArgumentName=function() return '_facingTarget' end,
      GetArgumentType=function() return 'AIArgumentType : Object (7)' end,
      GetParameterizationType=function() return 'AIParameterizationType : BehaviorArgument (0)' end}
    local handler={outFacingTarget=mapping}
    local owners,luaCalls=0,0
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
    local motion=(function() ${source} end)()
    convaiLocomotion=motion
    motion.install(companions.ownsTravelCommand)
    ${filtered ? "assert(motion.mode=='filtered', 'unexpected mode '..tostring(motion.mode))" : ''}
    -- Count entries into Lua by wrapping what the model hands out.
    for _,list in pairs(observers) do
      for index,callback in ipairs(list) do list[index]=function(...) luaCalls=luaCalls+1; return callback(...) end end
    end
    -- The game's UpdateCommand: the original, then (filtered build only) the redscript wrapper.
    local function updateCommand(owner,command)
      local context={owner=owner,_facingTarget=nil}
      for _,callback in ipairs(observers['UpdateCommand'] or {}) do callback(handler,context,command) end
      ${filtered ? `if command.m_convaiOwned then
        for _,callback in ipairs(observers['ConvaiOwnedMoveUpdate'] or {}) do callback(handler,context,command) end
      end` : ''}
      return context
    end
    local companionsOut,keys={}, {'judy-alvarez','panam-palmer','johnny-silverhand','alt-cunningham'}
    for index=1,${companions} do companionsOut[index]=spawn(keys[index]); tick(3) end
    player.pos=Vector4.new(0,8); tick(1); tick(3)
    local commands={}
    for _,npc in ipairs(companionsOut) do
      npc.pos=Vector4.new(1.5,6); tick(2)
      local travel=last(npc,'AIMoveToCommand')
      assert(travel and companions.ownsTravelCommand(npc,travel), 'a companion has no owned travel command')
      assert(not ${filtered} or travel.m_convaiOwned==true, 'the controller did not mark its command')
      commands[#commands+1]={npc=npc,command=travel}
    end
    -- Ordinary NPCs on a move command of their own: never ours, never marked.
    local walkers={}
    for index=1,${movers} do
      walkers[index]={owner={GetEntityID=function() return {hash='world-'..index} end},
        command={id=index,rotateEntityTowardsFacingTarget=false}}
    end
    -- The harness's own loop, context tables and wrapper test cost the same in both builds: run it with no observers
    -- registered, and subtract it. Best of three runs of each, to damp scheduler noise.
    local function run()
      local started=os.clock()
      for _=1,${ticks} do
        for _,walker in ipairs(walkers) do updateCommand(walker.owner,walker.command) end
        for _,entry in ipairs(commands) do updateCommand(entry.npc,entry.command) end
      end
      return os.clock()-started
    end
    local base,elapsed=math.huge,math.huge
    local live=observers
    for _=1,3 do
      observers={}; base=math.min(base,run())
      observers=live; luaCalls,owners=0,0; elapsed=math.min(elapsed,run())
    end
    elapsed=math.max(elapsed-base,0)
    -- Behaviour check: the stale facing target of an owned command is still cleared.
    local cleared=0
    for _,entry in ipairs(commands) do
      local context={owner=entry.npc,_facingTarget=player}
      for _,callback in ipairs(observers['UpdateCommand'] or {}) do callback(handler,context,entry.command) end
      ${filtered ? `for _,callback in ipairs(observers['ConvaiOwnedMoveUpdate'] or {}) do callback(handler,context,entry.command) end` : ''}
      if context._facingTarget==nil then cleared=cleared+1 end
    end
    RESULT=string.format('%d %d %.6f %d %d',luaCalls,owners,elapsed,cleared,#commands)
  `;
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  if (status !== lua.LUA_OK) {
    const message = to_jsstring(lua.lua_tostring(state, -1));
    lua.lua_close(state);
    throw new Error(message);
  }
  lua.lua_getglobal(state, to_luastring('RESULT'));
  const [luaCalls, owners, seconds, cleared, owned] = to_jsstring(lua.lua_tostring(state, -1)).split(' ').map(Number);
  lua.lua_close(state);
  return {luaCalls, owners, luaMsTick: (seconds * 1000) / ticks, cleared, owned};
}

const rows = [];
for (const companions of [0, 3]) {
  for (const movers of [0, 50, 200]) {
    const before = scenario(beforeSource, false, companions, movers);
    const after = scenario(afterSource, true, companions, movers);
    rows.push({companions, movers, ticks, before, after});
  }
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(`MoveTo hook, ${ticks} ticks per scenario (before = ${ref} engine hook, after = filtered hook)`);
  console.log('K = companions, N = ordinary walking NPCs. Lua ms are fengari-relative with the harness loop subtracted; the CET trampoline cost per call is not included.');
  console.log('K   N    | Lua calls before -> after | GetOwner before -> after | Lua ms/tick before -> after | facing cleared (before/after of K)');
  for (const row of rows) {
    const {before, after} = row;
    console.log(`${row.companions}  ${String(row.movers).padStart(4)} | ${String(before.luaCalls).padStart(8)} -> ${String(after.luaCalls).padStart(6)} | ${String(before.owners).padStart(8)} -> ${String(after.owners).padStart(6)} | ${before.luaMsTick.toFixed(4)} -> ${after.luaMsTick.toFixed(4)} | ${before.cleared}/${after.cleared} of ${row.companions}`);
  }
}
