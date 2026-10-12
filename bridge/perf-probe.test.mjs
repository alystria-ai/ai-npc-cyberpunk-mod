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

test('hook registrations and onUpdate are counted and timed only in Developer mode', () => run(`
local registered={}
Override=function(class,method,handler) registered[class..'.'..method]=handler end
ObserveAfter=Override
local events={}
registerForEvent=function(name,handler) events[name]=handler end
assert(P.hookRegistrations() and not P.hookRegistrations())
local calls=0
Override('ReactionManagerComponent','OnEventReceived',function(self,event,wrapped) calls=calls+1;t=t+.001;return wrapped(event) end)
ObserveAfter('AIMoveToCommandHandler','UpdateCommand',function() t=t+.002 end)
registerForEvent('onUpdate',function() t=t+.003 end)
registerForEvent('onInit',function() end)
local hook=registered['ReactionManagerComponent.OnEventReceived']
assert(hook('self','event',function(e) return e=='event' end)==true and calls==1)
developer=true;t=t+2
for _=1,240 do
 frame(false);events.onUpdate(.016)
 for _=1,10 do hook('self','event',function() return true end) end
 registered['AIMoveToCommandHandler.UpdateCommand']()
end
local row=written.history[#written.history]
local stim=row.sections['hook:ReactionManagerComponent.OnEventReceived']
assert(stim and stim.calls>=10*row.fps*row.span-20,'hook calls '..tostring(stim and stim.calls))
assert(math.abs(stim.maxMs-1)<.001 and row.sections['hook:AIMoveToCommandHandler.UpdateCommand'].maxMs-2<.001)
assert(math.abs(row.sections['event:onUpdate'].maxMs-3)<.001)
`));

test('a second load returns the first probe, so hooks wrapped at the top of init.lua still record', () => run(`
local install1,watch1=P.install,P.watch
local again=(function()${probe}end)()
assert(again==P and P.install==install1 and P.watch==watch1,'second load built a separate probe')
local registered={}
Override=function(class,method,handler) registered[class..'.'..method]=handler end
assert(P.hookRegistrations())
Override('PlayerPuppet','OnAction',function() t=t+.001 end)
local tactics={update=function() t=t+.004 end}
assert(again.watch(tactics,'update','tactics.update'))
developer=true;t=t+2
for _=1,240 do frame(false);registered['PlayerPuppet.OnAction']();tactics.update() end
local row=written.history[#written.history]
assert(row.sections['hook:PlayerPuppet.OnAction'],'hook wrapped by the first load did not record')
assert(math.abs(row.sections['tactics.update'].maxMs-4)<.001,'watched section missing')
`));

test('CET binding its own hook functions again at onInit does not unwrap them: each onInit handler re-wraps first', () => run(`
local registered={}
local function cetOverride(class,method,handler) registered[class..'.'..method]=handler end
Override=cetOverride
local events={}
registerForEvent=function(name,handler) events[name]=handler end
assert(P.hookRegistrations())
registerForEvent('onInit',function() Override('ChatterLineLogicController','UpdateProjection',function() t=t+.001 end) end)
Override=cetOverride -- what CET does when onInit runs
events.onInit()
developer=true;t=t+2
for _=1,240 do frame(false);registered['ChatterLineLogicController.UpdateProjection']() end
local row=written.history[#written.history]
assert(row.sections['hook:ChatterLineLogicController.UpdateProjection'],'hook registered in onInit did not record')
assert(row.hooksWrapped==1,'hooksWrapped '..tostring(row.hooksWrapped))
-- Re-wrapping is idempotent: a second onInit does not time a handler twice.
events.onInit();assert(P.hooksWrapped==2)
`));

test('init.lua marks its own onUpdate segments; an early return closes the open one', () => run(`
local events={}
registerForEvent=function(name,handler) events[name]=handler end
assert(P.hookRegistrations())
local early=false
registerForEvent('onUpdate',function()
 frame(false)
 P.mark('init:a');t=t+.002
 P.mark('init:b');t=t+.001
 if early then return end
 P.mark('init:c');t=t+.004
end)
P.mark('init:a');t=t+5 -- Developer mode off: nothing open, nothing recorded
developer=true;t=t+2
for i=1,240 do early=(i%2==0);events.onUpdate(.016) end
local row=written.history[#written.history]
local a,b,c=row.sections['init:a'],row.sections['init:b'],row.sections['init:c']
assert(a and math.abs(a.maxMs-2)<.001,'init:a '..tostring(a and a.maxMs))
assert(b and math.abs(b.maxMs-1)<.001,'early return did not close init:b at the return: '..tostring(b and b.maxMs))
assert(c and math.abs(c.maxMs-4)<.001 and math.abs(c.calls*2-a.calls)<=2,'init:c '..tostring(c and c.calls))
assert(math.abs(row.sections['event:onUpdate'].maxMs-22)<.001,'onUpdate '..row.sections['event:onUpdate'].maxMs)
`));
