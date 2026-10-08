import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const probe = readFileSync(new URL('../mod/perf-probe.lua', import.meta.url), 'utf8');

function run(body) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const setup = `
local t,developer,written,frames=100,false,nil,0
os.clock=function()return t end
json={encode=function(v)written=v;return 'encoded' end,decode=function()return {} end}
local realOpen=io.open
io.open=function(path,mode)
 if path=='runtime/perf-probe.json'then return {write=function()return true end,close=function()return true end}end
 if path=='runtime/state.json'then t=t+.002;return {read=function()return '' end,close=function()return true end}end
 return realOpen(path,mode)
end
companions={beginSpatialFrame=function()frames=frames+1 end}
local function speechUpdate()t=t+.005 end
convaiSpeech={update=speechUpdate,requestId='r1',continuous=true}
local P=(function()${probe}end)()
assert(P.install(companions,function()return developer end))
assert(not P.install(companions,function()return developer end),'installed twice')
local function frame(work)
 companions.beginSpatialFrame();convaiSpeech.update();if work then local f=io.open('runtime/state.json','rb');f:close()end
 t=t+.010
end
`;
  const status = lauxlib.luaL_dostring(vm, to_luastring(setup + '\n' + body));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(status, lua.LUA_OK, error);
}

test('the frame-cost probe stays inert with Developer mode off', () => run(`
for _=1,300 do frame(true) end
assert(written==nil and frames==300 and not P.enabled())
assert(convaiSpeech.update==speechUpdate,'Sections were wrapped while Developer mode was off')
`));

test('with Developer mode on it reports frame rate, section cost and file opens per window', () => run(`
developer=true;t=t+2;for _=1,260 do frame(true) end
assert(P.enabled() and written and #written.history>=1)
local row=written.history[1]
assert(row.speaking and row.continuous and row.fps>50 and row.fps<60,'fps '..tostring(row.fps))
local speech=row.sections['speech.update']
assert(speech and math.abs(speech.msPerSecond/row.fps-5)<.01,'speech.update cost '..tostring(speech and speech.msPerSecond))
assert(row.sections['io.open'] and math.abs(row.sections['io.open'].maxMs-2)<.001)
assert(row.opens['state.json:rb']==row.sections['io.open'].calls)
assert(row.over25ms==0 and row.frameMaxMs<17.1)
developer=false;t=t+2;frame(true);assert(not P.enabled())
P.uninstall();assert(convaiSpeech.update==speechUpdate and io.open~=nil)
`));
