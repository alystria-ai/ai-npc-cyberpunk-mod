import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
const source=readFileSync(new URL('../mod/fact-identity-probe.lua',import.meta.url),'utf8');
function run(code) {
  const L=lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  const result=lauxlib.luaL_dostring(L,to_luastring(`local Probe=(function()\n${source}\nend)()\n${fixture}\n${code}`));
  const error=result===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(L,-1));lua.lua_close(L);
  assert.equal(result,lua.LUA_OK,error);
}
const fixture=`
local callback,latest,clock,reads,writes= nil,nil,100,0,0
local facts={GetFactStr=function(self,name) reads=reads+1; return 0 end,
 SetFactStr=function() writes=writes+1;error('probe must never write') end}
local options={request='test',names={'head','a','b'},now=function()return clock end,
 getFacts=function()return facts end,world=function()return {attached=true}end,
 observe=function(class,method,fn) assert(class=='PlayerSystem' and method=='OnGameRestored');callback=fn end,
 publish=function(report)latest=report end}
`;

test('read-only probe distinguishes registration/current reads from observed restoration',()=>run(`
 local p=Probe.new(options);assert(reads==0 and callback==nil)
 p.arm();assert(latest.observerRegistered and latest.restoreCount==0 and reads==5)
 assert(latest.samples[1].kind=='armed-current-read' and latest.samples[1].stableHead)
 p.read();assert(latest.restoreCount==0 and writes==0)
 callback();assert(latest.restoreCount==1 and latest.samples[3].kind=='observed-game-restored')
 assert(latest.samples[3].world.attached and writes==0)
 p.stop();callback();assert(latest.restoreCount==1 and not latest.active)
`));
test('registration failure and fact failure are recorded without inventing a restoration',()=>run(`
 options.observe=function()error('not observable')end
 options.getFacts=function()error('not ready')end
 local p=Probe.new(options);p.arm()
 assert(not latest.observerRegistered and latest.restoreCount==0)
 assert(not latest.samples[1].ok and latest.samples[1].error:match('not ready'))
`));
test('probe expires and bounds retained snapshots',()=>run(`
 local p=Probe.new(options);p.arm()
 for i=1,20 do callback() end
 assert(latest.restoreCount==20 and #latest.samples==12 and writes==0)
 clock=2000;callback();assert(latest.restoreCount==20)
`));
