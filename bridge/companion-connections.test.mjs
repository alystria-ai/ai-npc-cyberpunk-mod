import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionModules, flatNavigation} from './companion-fixture.mjs';
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8');

test('accepted spawns immediately publish unique identities; last dismissal and failed spawns release them', () => {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = `
    local now, created = 100, 0
    os.time=function() return now end
    io.open=function() return nil end
    Vector4={new=function(x,y,z,w) return {x=x,y=y,z=z,w=w} end}
    TweakDBID={new=function(v) return v end}
    CName={new=function(v) return v end}
    TweakDB={GetRecord=function() return {IsA=function(_, kind) return kind=='gamedataCharacter_Record' end} end}
    NewObject=function() return {} end
    Enum={new=function(_, value) return value end}
    local player={
      GetWorldPosition=function() return Vector4.new(0,0,0,1) end,
      GetWorldForward=function() return Vector4.new(0,1,0,0) end,
      GetWorldOrientation=function() return {} end
    }
    local system={IsReady=function() return true end,
      CreateEntity=function(_,spec)
        assert(spec.tags[1]=='CyberpunkConvaiCompanion')
        created=created+1; return {hash=tostring(created)} end,
      DeleteEntity=function() end, IsSpawned=function() return false end}
    Game={GetPlayer=function() return player end,GetDynamicEntitySystem=function() return system end,
      GetTargetingSystem=function() return {GetCrosshairData=function()
        return player:GetWorldPosition(),player:GetWorldForward() end} end}
    ${companionModules}
    ${flatNavigation}
    local companions=(function() ${source} end)()
    local changes={}
    companions.onPartyChanged=function() changes[#changes+1]=table.concat(companions.connectionProfiles(),',') end
    local one=companions.spawn('judy-alvarez')
    assert(changes[1]=='judy-alvarez') -- Fired before the engine attaches her.
    local two=companions.spawn('judy-alvarez')
    assert(changes[2]=='judy-alvarez')
    local three=companions.spawn('panam-palmer')
    assert(changes[3]=='judy-alvarez,panam-palmer')
    companions.dismiss(one)
    assert(changes[4]=='judy-alvarez,panam-palmer')
    companions.dismiss(two)
    assert(changes[5]=='panam-palmer')
    now=113; companions.update(player,13.0,nil)
    assert(#companions.connectionProfiles()==0) -- Engine never attached Panam.
    companions.dismissAll()
    assert(changes[#changes]=='')
    assert(not companions.spawn('unknown') and changes[#changes]=='')
  `;
  const result = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
});
