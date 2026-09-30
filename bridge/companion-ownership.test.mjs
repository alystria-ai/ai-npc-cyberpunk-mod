import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(companionEngine + code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(status, lua.LUA_OK, error);
}

for (const failure of ['state-error', 'cancel-refused', 'cancel-throws', 'cancel-pending']) {
  test(`movement retains its exact command during ${failure} and resumes only after terminal confirmation`, () => run(`
    local npc=spawn(); tick(4)
    local first=active(npc)[1]; assert(first and #active(npc)==1)
    local original=npc.ai.GetCommandState
    local unavailable=true
    local stops=0
    npc.ai.GetCommandState=function(self,command)
      if '${failure}'=='state-error' and unavailable and command==first then error('native state unavailable') end
      return original(self,command)
    end
    npc.ai.StopExecutingCommand=function(self,command)
      stops=stops+1; assert(command==first,'lost the exact pending cancellation handle')
      if '${failure}'=='cancel-refused' then return false end
      if '${failure}'=='cancel-throws' then error('native stop unavailable') end
      -- Even accepted native cancellation may complete on a later update.
    end
    player.pos.y=7
    for i=1,30 do
      companions.update(player,0.1)
      assert(#active(npc)==1 and active(npc)[1]==first,'replacement overlapped the old native command')
    end
    assert(companions.list()[1].operation.error,'pending ownership must be diagnosable')
    assert(stops==('${failure}'=='state-error' and 0 or 1),'cancellation was retried every frame')
    unavailable=false
    companions.update(player,0.1)
    assert(stops==1 and #active(npc)==1)
    first.state='Cancelled'
    for i=1,5 do companions.update(player,0.1) end
    assert(#active(npc)==1 and active(npc)[1]~=first,'terminal cancellation did not allow the current intent')
    assert(stops==1,'ended cancellation was submitted again')
  `));
}

test('combat release keeps the retiring command owned without issuing a social replacement', () => run(`
  local npc=spawn(); tick(4)
  local first=active(npc)[1]; local stops=0; local commands=#npc.ai.commands
  npc.ai.StopExecutingCommand=function(_,command) assert(command==first); stops=stops+1 end
  npc.combat=true
  for i=1,20 do companions.update(player,0.1,npc.id.hash) end
  assert(stops==1 and #npc.ai.commands==commands)
  assert(#active(npc)==1 and active(npc)[1]==first)
  first.state='Cancelled'; companions.update(player,0.1,npc.id.hash)
  assert(#active(npc)==0 and #npc.ai.commands==commands)
  for _ in pairs(npc.looks) do error('combat retained a social look') end
  npc.combat=false; tick(4)
  assert(#active(npc)==1 and #npc.ai.commands==commands+1)
`));

test('queued cancellation uses CancelCommand once and waits for its asynchronous terminal state', () => run(`
  local npc=spawn(); tick(4)
  local first=active(npc)[1]; first.state='Enqueued'
  local cancelled=0
  npc.ai.CancelCommand=function(_,command) assert(command==first); cancelled=cancelled+1; return true end
  npc.ai.StopExecutingCommand=function() error('queued command was treated as executing') end
  local count=#npc.ai.commands
  player.pos.y=7
  for i=1,20 do companions.update(player,0.1) end
  assert(cancelled==1 and #npc.ai.commands==count)
  first.state='Cancelled'; companions.update(player,0.1)
  assert(#npc.ai.commands==count+1 and #active(npc)==1)
`));

test('world abandonment drops a pending cancellation without querying destroyed native objects', () => run(`
  local npc=spawn(); tick(4)
  npc.ai.StopExecutingCommand=function() return false end
  player.pos.y=7; companions.update(player,0.1); companions.update(player,0.1)
  assert(companions.list()[1].operation.error)
  npc.IsAttached=function() error('native entity unloaded') end
  npc.GetAIControllerComponent=function() error('native controller unloaded') end
  companions.abandon()
  assert(#companions.list()==0)
`));
