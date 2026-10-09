import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Free look while V sits (docs/COMPANION_SEATING.md): the controller driven with
// a fake native layer, plus the real seat classifier of the companion seating.
const source = readFileSync(new URL('../mod/seated-look.lua', import.meta.url), 'utf8');
const seating = readFileSync(new URL('../mod/companion-seating.lua', import.meta.url), 'utf8');
function run(code) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(fixture + code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}
const fixture = `
local look=(load([==[${source}]==]))()
local seatingModule=(function()
  local saved=dofile
  dofile=function(path) if path=='gesture-workspot.lua' then return {} end error('unexpected dofile '..path) end
  local m=(load([==[${seating}]==]))()
  dofile=saved
  return m
end)()
local function fake(path,anim)
  local n={calls={},path=path,anim=anim,logs={},nextId=0}
  function n.seat() n.calls[#n.calls+1]='seat';return n.path,n.anim end
  function n.classify(p,a) return seatingModule.classify(p,a) end
  function n.queue(limits) n.calls[#n.calls+1]='queue';n.queued=limits end
  function n.delay(limits,seconds) n.calls[#n.calls+1]='delay';n.delayed={limits=limits,seconds=seconds};n.nextId=n.nextId+1;return n.nextId end
  function n.cancel(id) n.calls[#n.calls+1]='cancel';n.cancelled=id end
  function n.log(kind,fields) n.logs[#n.logs+1]={kind=kind,fields=fields} end
  return n
end
local BENCH='base\\\\workspots\\\\player\\\\bench\\\\player__sit_bench_lean_back_r_hand_on_back__talk__01.workspot'
local COUCH='base\\\\workspots\\\\player\\\\couch\\\\player__sit_couch_lean_back__sit_around__01.workspot'
`;

test('entering a bench or couch workspot sends the wide limits at once and again after the settle delay', () => run(`
for _,path in ipairs({BENCH,COUCH,'base\\\\workspots\\\\player\\\\chair\\\\player__sit_chair__sit_around__01.workspot',
  'base\\\\workspots\\\\player\\\\barstool\\\\player__sit_barstool__sit_around__01.workspot',
  'base\\\\workspots\\\\player\\\\bar\\\\player__sit_barstool_bar_lean_front__sit_around__01.workspot'}) do
  local n=fake(path,'sit_around')
  local c=look.new(n)
  assert(c.entered()==true,path)
  local l=n.queued
  assert(l.yawMaxLeft==90 and l.yawMaxRight==-90 and l.pitchMax==45 and l.pitchMin==-50,'limits '..path)
  assert(l.sensitivityMultX==1 and l.sensitivityMultY==1,'sensitivity must stay 1')
  assert(n.delayed.seconds==.4 and n.delayed.limits==l,'second copy')
  assert(n.logs[#n.logs].kind=='seated-look')
end
`));

test('only seats are widened: cars, beds, the ground, an unknown or missing workspot are left alone', () => run(`
for _,path in ipairs({
  'base\\\\workspots\\\\player\\\\car\\\\player__sit_car_passenger_seat__sit_around__01.workspot',
  'base\\\\workspots\\\\player\\\\bed\\\\player__sit_bed__idle__01.workspot',
  'base\\\\workspots\\\\player\\\\ground\\\\player__sit_ground_lean_back__idle__01.workspot',
  'base\\\\workspots\\\\player\\\\bike\\\\player__sit_bike__sit_around__01.workspot',
  'base\\\\workspots\\\\player\\\\netrunners_chair\\\\sit_ripper_chair_lean180__2h_on_sides__01.workspot',
  'base\\\\workspots\\\\takedown\\\\player__takedown__01.workspot'}) do
  local n=fake(path,'x');local c=look.new(n)
  assert(c.entered()==false,path)
  assert(n.queued==nil and n.delayed==nil,'sent for '..path)
end
local n=fake(nil,nil);local c=look.new(n)
assert(c.entered()==false and n.queued==nil,'no instance (the apartment scene) sends nothing')
assert(n.logs[#n.logs].kind=='seated-look-skip')
`));

test('leaving the state cancels the pending second copy, and only once', () => run(`
local n=fake(BENCH,'x');local c=look.new(n)
c.entered();c.left()
assert(n.cancelled==1,'cancel the delayed event')
c.left()
local cancels=0;for _,x in ipairs(n.calls) do if x=='cancel' then cancels=cancels+1 end end
assert(cancels==1,'a second exit does not cancel again, got '..cancels)
local m=fake(BENCH,'x');local d=look.new(m);d.left();assert(m.cancelled==nil,'exit without an enter cancels nothing')
`));

test('native failures never throw out of the hook', () => run(`
local n=fake(BENCH,'x');function n.seat() error('boom') end
local c=look.new(n);assert(c.entered()==false)
local m=fake(BENCH,'x');function m.queue() error('no event') end;function m.delay() error('no delay') end
local d=look.new(m);assert(d.entered()==false,'both sends failing reports false')
local k=fake(BENCH,'x');function k.cancel() error('late') end
local e=look.new(k);e.entered();e.left()
local j=fake(BENCH,'x');function j.queue() error('no event') end
local f=look.new(j);assert(f.entered()==true,'the delayed copy alone still counts')
`));

test('the limits reach a neighbour on the same bench and stay bounded', () => run(`
local l=look.limits
assert(l.yawMaxLeft>=90 and l.yawMaxRight<=-90 and l.yawMaxLeft<=120 and l.yawMaxRight>=-120)
assert(l.pitchMin<0 and l.pitchMax>0 and l.pitchMin>=-80 and l.pitchMax<=80)
assert(look.baseSet=='WorkspotUnlocked')
`));

test('init.lua installs it once from onInit with the seating classifier, and nothing runs per frame', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  assert.equal((init.match(/seated-look\.lua/g) || []).length, 1);
  const call = init.indexOf("dofile('seated-look.lua')");
  const onInit = init.indexOf("registerForEvent('onInit'");
  const onUpdate = init.indexOf("registerForEvent('onUpdate'");
  assert(onInit < call && call < onUpdate, 'the call lives in onInit');
  assert(init.includes("classify = dofile('companion-seating.lua').classify"));
  const body = readFileSync(new URL('../mod/seated-look.lua', import.meta.url), 'utf8');
  assert(!/onUpdate|registerForEvent|SetFlat/.test(body.replace(/--.*$/gm, '')), 'no frame handler, no TweakDB write');
  assert.equal((body.match(/ObserveAfter\(/g) || []).length, 3, 'enter, exit, forced exit');
});
