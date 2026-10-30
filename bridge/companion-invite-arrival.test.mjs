import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
function run(code) {
  const state=lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status=lauxlib.luaL_dostring(state,to_luastring(code));
  const error=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  lua.lua_close(state); assert.equal(status,lua.LUA_OK,error);
}

// A fresh invitation is looked at again (mod/companions.lua placementCheck). Live 2026-10-30 (game 2.5): Judy and Panam, invited from the
// Companion Manager, joined the group but were not near V a minute later, and nothing in the log said where they stood or why they did not
// walk to V. Judy never had an idle move in 21 minutes (idles need her within 4 m), and the mod never moved her (no 'Companion teleport').
const world=`${companionEngine}
  local logs={}
  companions.recoveryLog=function(kind,fields) logs[#logs+1]={kind=kind,fields=fields} end
  local function logged(kind,reason)
    for _,item in ipairs(logs) do
      if item.kind==kind and (not reason or item.fields.reason==reason or item.fields.rule==reason) then return item end
    end
  end
  local function count(kind)
    local n=0
    for _,item in ipairs(logs) do if item.kind==kind then n=n+1 end end
    return n
  end
  local teleports={}
  local space=dofile('companion-space.lua')
  local function wire(npc)
    npc.ai.onSend=function(cmd)
      if cmd.kind=='AITeleportCommand' then
        teleports[#teleports+1]={spot=cmd.position}
        npc.pos=cmd.position; cmd.state='Success'
      end
    end
  end
  -- The copy walks toward the goal of its active move or follow command, like the passage suite.
  local function walk(npc,step)
    for _,cmd in ipairs(npc.ai.commands) do
      if cmd.state=='Executing' and (cmd.kind=='AIFollowTargetCommand' or cmd.kind=='AIMoveToCommand') then
        local goal=cmd.kind=='AIMoveToCommand' and cmd.movementTarget.position or player.pos
        if space.ground(npc.pos,goal)>.3 then
          local moved=space.offset(npc.pos,space.bearing(npc.pos,goal),0,step or .6)
          npc.pos=Vector4.new(moved.x,moved.y,npc.pos.z)
        end
        return
      end
    end
  end
  local function play(npc,count,walking)
    for i=1,count do
      if walking then walk(npc) end
      companions.update(player,.5)
    end
    for _,row in ipairs(companions.list()) do assert(not row.error,row.error) end
  end
  local function away(npc) return space.ground(npc.pos,player.pos) end
`;

test('a fresh invitation that the game left far from V is placed behind V, and the log says so',()=>run(world+`
  Game.GetTeleportationFacility=function() return {Teleport=function(_,who,at) who.pos=at end} end
  local npc=spawn('judy-alvarez'); wire(npc)
  play(npc,2)
  assert(away(npc)<4,'a fresh copy is placed beside V')
  -- Something moves her 10 m behind V and her walk goes nowhere (a route that never opens).
  npc.pos=Vector4.new(0,-10,.1)
  play(npc,70)
  assert(#teleports>=1,'a copy 10 m from a standing V was never brought back')
  assert(away(npc)<6,'she was not placed near V: '..away(npc))
  local line=logged('placement','check1')
  assert(line,'no placement line at the first look')
  assert(line.fields.away==true and line.fields.gap>9,'the line does not show the distance: '..tostring(line.fields.gap))
  assert(line.fields.spawn and line.fields.spawn<4,'the line does not show how far from V she was created')
  assert(logged('relocated','invitation'),'no relocation line for the invitation rule')
`));

test('a copy that stands beside V at every look gets one probe line and is never moved',()=>run(world+`
  Game.GetTeleportationFacility=function() return {Teleport=function(_,who,at) who.pos=at end} end
  local npc=spawn('judy-alvarez'); wire(npc)
  play(npc,100,true)
  assert(#teleports==0,'a copy beside V was teleported')
  assert(count('placement')==1,'expected one placement line, got '..count('placement'))
  local line=logged('placement','check1')
  assert(line.fields.away==nil and line.fields.gap<4 and line.fields.phase,'the line does not describe a copy beside V')
`));

test('a copy that follows V walking away is not teleported by the invitation rule',()=>run(world+`
  Game.GetTeleportationFacility=function() return {Teleport=function(_,who,at) who.pos=at end} end
  local npc=spawn('judy-alvarez'); wire(npc)
  -- V runs straight off right after the invitation: she runs after V and keeps within a few metres of the group.
  for i=1,60 do
    player.pos=Vector4.new(0,i*.9,0)
    walk(npc,1.1); companions.update(player,.5)
  end
  assert(#teleports==0,'a follower that kept up was teleported: '..#teleports)
`));

test('a copy held by a car, a seat, a tactic or a departure is not taken by the invitation rule',()=>run(world+`
  Game.GetTeleportationFacility=function() return {Teleport=function(_,who,at) who.pos=at end} end
  local npc=spawn('judy-alvarez'); wire(npc)
  companions.bodyAnimation={owns=function() return true end,tick=function() end,observe=function() return true end,
    steer=function() return nil end}
  play(npc,2)
  npc.pos=Vector4.new(0,-10,.1)
  play(npc,70)
  assert(#teleports==0,'a seated copy was relocated by the invitation rule')
  local line=logged('placement','check1')
  assert(line and line.fields.holder=='seat','the line does not name who holds her: '..tostring(line and line.fields.holder))
`));

test('no look is taken after the last one, and a recreated copy has none',()=>run(world+`
  Game.GetTeleportationFacility=function() return {Teleport=function(_,who,at) who.pos=at end} end
  local npc=spawn('judy-alvarez'); wire(npc)
  play(npc,100,true)
  local row=companions.movementSnapshot().copies[1]
  assert(row,'no copy')
  -- 3 looks at 3, 12 and 30 s: after them nothing is kept.
  play(npc,20,true)
  assert(count('placement')==1)
`));
