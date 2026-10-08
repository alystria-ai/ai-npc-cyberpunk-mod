import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const logger = readFileSync(new URL('../mod/movement-log.lua', import.meta.url), 'utf8');
function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(status, lua.LUA_OK, error);
}

test('Developer trace is off without I/O and rotates both retained files within 4 MiB', () => run(`
  local files,opens,reads,calls={},0,0,0
  io.open=function(path,mode)
    opens=opens+1
    if mode=='rb' then
      if not files[path] then return nil end
      return {seek=function() return #files[path] end,close=function() return true end}
    end
    assert(mode=='ab');files[path]=files[path] or ''
    return {write=function(_,line) files[path]=files[path]..line;return true end,
      close=function() return true end}
  end
  os.remove=function(path) files[path]=nil;return true end
  os.rename=function(from,to)
    if files[to] or not files[from] then return nil end
    files[to],files[from]=files[from],nil;return true
  end
  json={encode=function() return '"'..string.rep('x',32765)..'"' end}
  local movement=(function() ${logger} end)()
  local provider=function() calls=calls+1;return {id=calls} end
  assert(not movement.update(false,1,provider) and opens==0 and calls==0)
  assert(movement.update(true,0,provider) and calls==1)
  assert(not movement.update(true,.49,provider) and calls==1)
  assert(movement.update(true,.01,provider) and calls==2)
  assert(not movement.update(false,1,provider) and calls==2)
  for i=1,130 do assert(movement.update(true,.5,provider)) end
  assert(movement.flush())
  local active='runtime/movement-trace.ndjson'
  local previous='runtime/movement-trace.previous.ndjson'
  assert(files[active] and files[previous])
  assert(#files[active]<=2097152 and #files[previous]<=2097152)
  assert(#files[active]+#files[previous]<=4194304)
  local retained=#files[active]
  movement=(function() ${logger} end)()
  assert(movement.update(true,0,provider))
  assert(#files[active]==retained,'A sample was written before its flush')
  assert(not movement.update(false,1,provider))
  assert(#files[active]==retained+32768,'CET reload must append, not erase; stopping the trace flushes it')
  assert(not movement.update(false,1,provider) and #files[active]==retained+32768)
`));

test('Developer trace buffers samples and opens the trace file only on its 5 s flush', () => run(`
  local files,opens={},0
  io.open=function(path,mode)
    opens=opens+1
    if mode=='rb' then
      if not files[path] then return nil end
      return {seek=function() return #files[path] end,close=function() return true end}
    end
    files[path]=files[path] or ''
    return {write=function(_,line) files[path]=files[path]..line;return true end,close=function() return true end}
  end
  os.remove=function(path) files[path]=nil;return true end
  os.rename=function(from,to) files[to],files[from]=files[from],nil;return true end
  json={encode=function() return '{}' end}
  local movement=(function() ${logger} end)()
  local provider=function() return {} end
  for _=1,9 do assert(movement.update(true,.5,provider)) end
  assert(opens==0,'samples opened the file before the flush: '..opens)
  assert(movement.update(true,.5,provider))
  local first=opens
  assert(first>=1 and first<=3 and #files['runtime/movement-trace.ndjson']>0,'5 s flush: '..first)
  for _=1,10 do assert(movement.update(true,.5,provider)) end
  assert(opens==first+1,'later flushes must reuse the tracked size: '..(opens-first))
`));

test('movement snapshot includes distant tracked copies without native polling', () => run(`
  ${companionEngine}
  local npc=spawn()
  player.pos=Vector4.new(0,50)
  tick(1)
  Game.GetPlayer=function() error('snapshot queried the game') end
  npc.GetWorldPosition=function() error('snapshot queried the actor') end
  local result=companions.movementSnapshot()
  assert(result.version==1 and result.player and result.player.position.y==50)
  assert(#result.copies==1 and result.copies[1].serial==1)
  assert(result.copies[1].actor.playerGap>35)
  assert(result.copies[1].brain.phase and result.copies[1].command.route)
`));
