import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const facial = readFileSync(new URL('../mod/facial-playback.lua', import.meta.url), 'utf8');
const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
const probe = readFileSync(new URL('../mod/perf-probe.lua', import.meta.url), 'utf8');

// The development switch for the ordinary-NPC FPS comparison: runtime/crowd-face-mode.txt, read once per load.
const setup = `
local fileText, opened, services, serviceError = nil, {}, {}, nil
io.open=function(path)
  opened[#opened+1]=path
  if path~='runtime/crowd-face-mode.txt' or fileText==nil then return nil end
  return {read=function() return fileText end, close=function() end}
end
CName={new=function(x) return x end}
Game={GetScriptableServiceContainer=function()
  return {GetService=function(_,name)
    assert(name=='ConvaiFaceService', 'the service is ConvaiFaceService')
    return {SetCrowdMode=function(_,word)
      services[#services+1]=word
      if serviceError then error(serviceError) end
      return word
    end}
  end}
end}
local face=(function() ${facial} end)()
`;
function run(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(setup + body));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

test('no mode file means no service call and no stamp: the shipped default is gated and nothing is sent', () => run(`
  local requested,applied,problem=face.applyCrowdMode()
  assert(requested==nil and applied==nil and problem==nil)
  assert(#services==0 and face.crowdMode==nil)
`));

test('off, ungated and gated are handed to the service once and stamped as the mode the game reports', () => run(`
  for _,word in ipairs({'off','ungated','gated'}) do
    fileText=word..'\\r\\n'; services={}
    local requested,applied,problem=face.applyCrowdMode()
    assert(requested==word and applied==word and problem==nil, word)
    assert(#services==1 and services[1]==word and face.crowdMode==word, word)
  end
  fileText='  Gated  # the shipping mode'; services={}
  assert(face.applyCrowdMode()=='gated' and services[1]=='gated', 'case and trailing text are tolerated')
`));

test('a byte-order mark from PowerShell does not make the file invalid', () => run(`
  fileText='\\239\\187\\191ungated\\r\\n'; services={}
  assert(face.applyCrowdMode()=='ungated' and services[1]=='ungated' and face.crowdMode=='ungated')
`));

test('an unknown word is reported, sends nothing and is stamped invalid-file', () => run(`
  for _,text in ipairs({'maybe','','   ','123','!off'}) do
    fileText=text; services={}
    local requested,applied,problem=face.applyCrowdMode()
    assert(requested==nil and applied==nil and problem=='invalid', text)
    assert(#services==0 and face.crowdMode=='invalid-file', text)
  end
`));

test('a service that cannot be reached or throws leaves a failed stamp, never the requested mode, and raises nothing', () => run(`
  fileText='off'; serviceError='service missing'
  local requested,applied,problem=face.applyCrowdMode()
  assert(requested=='off' and applied==nil and problem:find('service missing',1,true))
  assert(face.crowdMode=='failed:off', tostring(face.crowdMode))
  serviceError=nil; Game.GetScriptableServiceContainer=function() error('no container') end
  fileText='gated'
  requested,applied,problem=face.applyCrowdMode()
  assert(requested=='gated' and applied==nil and face.crowdMode=='failed:gated')
`));

test('a missing file after a failed or invalid load clears the stamp again', () => run(`
  fileText='nonsense'; face.applyCrowdMode(); assert(face.crowdMode=='invalid-file')
  fileText=nil; face.applyCrowdMode(); assert(face.crowdMode==nil)
`));

test('the switch is read once at load: init.lua calls it only in onInit, the module registers nothing per frame, the probe stamps it', () => {
  const calls = init.split('applyCrowdMode').length - 1;
  assert(calls >= 2 && calls <= 3, `applyCrowdMode appears ${calls} times in init.lua (guard, pcall)`);
  const at = init.indexOf('applyCrowdMode');
  const onInit = init.lastIndexOf("registerForEvent('onInit'", at);
  const nextEvent = init.indexOf('registerForEvent(', at);
  assert(onInit >= 0 && (nextEvent < 0 || nextEvent > at), 'the call sits in the onInit handler, before the next event handler');
  assert.doesNotMatch(init.slice(nextEvent < 0 ? init.length : nextEvent), /applyCrowdMode/, 'never in onUpdate or onDraw');
  const mode = facial.slice(facial.indexOf('function M.crowdModeRequested'), facial.indexOf('-- Development-only visibility probe'));
  assert.doesNotMatch(mode, /registerForEvent|Observe\(|ObserveAfter|Override\(|onUpdate/, 'no per-frame hook');
  assert.match(probe, /crowdFace\s*=\s*type\(convaiFacialPlayback\)\s*==\s*'table'\s*and\s*convaiFacialPlayback\.crowdMode\s*or\s*'default'/);
});
