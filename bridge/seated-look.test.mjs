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
-- seat = what the game reports at the Workspot state entry: {path, anim, tier, vehicle}.
local function fake(seat)
  local n={calls={},seat=seat,logs={},nextId=0,queued={},delayed={}}
  function n.seat() n.calls[#n.calls+1]='seat';return n.seat_ end
  n.seat_=seat
  function n.classify(p,a) return seatingModule.classify(p,a) end
  function n.queue(limits,set) n.calls[#n.calls+1]='queue';n.queued[#n.queued+1]={limits=limits,set=set} end
  function n.delay(limits,set,seconds) n.calls[#n.calls+1]='delay';n.nextId=n.nextId+1;n.delayed[#n.delayed+1]={limits=limits,set=set,seconds=seconds,id=n.nextId};return n.nextId end
  function n.cancel(id) n.calls[#n.calls+1]='cancel';n.cancelled=id end
  function n.log(kind,fields) n.logs[#n.logs+1]={kind=kind,fields=fields} end
  return n
end
local function count(n,name) local c=0;for _,x in ipairs(n.calls) do if x==name then c=c+1 end end;return c end
local BENCH='base\\\\workspots\\\\player\\\\bench\\\\player__sit_bench_lean_back_r_hand_on_back__talk__01.workspot'
local COUCH='base\\\\workspots\\\\player\\\\couch\\\\player__sit_couch_lean_back__sit_around__01.workspot'
`;

test('a named seat workspot sends the wide limits after the settle delay, never at once', () => run(`
for _,path in ipairs({BENCH,COUCH,'base\\\\workspots\\\\player\\\\chair\\\\player__sit_chair__sit_around__01.workspot',
  'base\\\\workspots\\\\player\\\\barstool\\\\player__sit_barstool__sit_around__01.workspot',
  'base\\\\workspots\\\\player\\\\bar\\\\player__sit_barstool_bar_lean_front__sit_around__01.workspot'}) do
  local n=fake({path=path,anim='sit_around',tier=1,vehicle=0})
  local c=look.new(n)
  assert(c.entered()==true,path)
  assert(#n.queued==0,'no event at once: a scene ending flickers the state')
  local l=n.delayed[1].limits
  assert(l.yawMaxLeft==90 and l.yawMaxRight==-90 and l.pitchMax==45 and l.pitchMin==-50,'limits '..path)
  assert(l.sensitivityMultX==1 and l.sensitivityMultY==1,'sensitivity must stay 1')
  assert(n.delayed[1].seconds==.4 and n.delayed[1].set=='WorkspotUnlocked','delayed copy on the plain workspot set')
end
`));

test('a scene sit (tier 3, no workspot instance: every live chair and couch) is widened on the scene set', () => run(`
local n=fake({path=nil,anim=nil,tier=3,vehicle=0})
local c=look.new(n)
assert(c.entered()==true)
assert(#n.queued==0 and n.delayed[1].set=='Tier3Scene','scene base set, delayed only')
assert(n.delayed[1].limits.yawMaxLeft==90,'the couch had 60.9 left')
assert(c.sitting=='scene')
local logged=n.logs[#n.logs-1]
assert(logged.kind=='seated-look-enter' and logged.fields.tier==3)
`));

test('only seats are widened: cars, beds, the ground, scenes in a vehicle, locked or standing workspots are left alone', () => run(`
for _,path in ipairs({
  'base\\\\workspots\\\\player\\\\car\\\\player__sit_car_passenger_seat__sit_around__01.workspot',
  'base\\\\workspots\\\\player\\\\bed\\\\player__sit_bed__idle__01.workspot',
  'base\\\\workspots\\\\player\\\\ground\\\\player__sit_ground_lean_back__idle__01.workspot',
  'base\\\\workspots\\\\player\\\\bike\\\\player__sit_bike__sit_around__01.workspot',
  'base\\\\workspots\\\\player\\\\netrunners_chair\\\\sit_ripper_chair_lean180__2h_on_sides__01.workspot',
  'base\\\\workspots\\\\takedown\\\\player__takedown__01.workspot'}) do
  local n=fake({path=path,anim='x',tier=3,vehicle=0});local c=look.new(n)
  assert(c.entered()==false,path)
  assert(#n.queued==0 and #n.delayed==0,'sent for '..path)
end
-- no instance and not scene tier 3 (a plain tier 1 workspot we cannot read)
local n=fake({tier=1,vehicle=0});local c=look.new(n)
assert(c.entered()==false and #n.queued==0)
assert(n.logs[#n.logs].kind=='seated-look-skip')
-- a scene in a car
local v=fake({tier=3,vehicle=1});assert(look.new(v).entered()==false and #v.queued==0)
`));

test('a scene ending flickers the state: the entry that follows an exit sends nothing that can outlive it', () => run(`
local n=fake({tier=3,vehicle=0});local c=look.new(n)
c.entered();c.left();c.entered();c.left()
assert(#n.queued==0,'nothing sent at once')
assert(count(n,'cancel')==2 and n.cancelled==2,'every delayed copy cancelled by the exit that follows it')
`));

test('the scene resending its narrow tier 3 limits while V sits gets the override behind it, and never after standing', () => run(`
local n=fake({tier=3,vehicle=0});local c=look.new(n)
assert(c.sceneCamera()==false and #n.queued==0,'before sitting: nothing')
c.entered()
assert(#n.queued==0)
assert(c.sceneCamera()==true and #n.queued==1 and n.queued[1].set=='Tier3Scene','resent behind the scene camera')
c.left()
assert(c.sceneCamera()==false and #n.queued==1,'after leaving: nothing')
`));

test('leaving the state cancels the pending second copy, and only once', () => run(`
local n=fake({path=BENCH,anim='x',tier=1,vehicle=0});local c=look.new(n)
c.entered();c.left()
assert(n.cancelled==1,'cancel the delayed event')
c.left()
assert(count(n,'cancel')==1,'a second exit does not cancel again')
local m=fake({path=BENCH,anim='x',tier=1,vehicle=0});local d=look.new(m);d.left();assert(m.cancelled==nil,'exit without an enter cancels nothing')
`));

test('native failures never throw out of the hook', () => run(`
local n=fake({path=BENCH,anim='x',tier=1,vehicle=0});function n.seat() error('boom') end
local c=look.new(n);assert(c.entered()==false)
local m=fake({path=BENCH,anim='x',tier=1,vehicle=0});function m.queue() error('no event') end;function m.delay() error('no delay') end
local d=look.new(m);assert(d.entered()==false,'both sends failing reports false')
local k=fake({path=BENCH,anim='x',tier=1,vehicle=0});function k.cancel() error('late') end
local e=look.new(k);e.entered();e.left()
local j=fake({path=BENCH,anim='x',tier=1,vehicle=0});function j.queue() error('no event') end
local f=look.new(j);assert(f.entered()==true,'the delayed copy alone still counts')
`));

test('the limits reach a neighbour on the same bench and stay bounded', () => run(`
local l=look.limits
assert(l.yawMaxLeft>=90 and l.yawMaxRight<=-90 and l.yawMaxLeft<=120 and l.yawMaxRight>=-120)
assert(l.pitchMin<0 and l.pitchMax>0 and l.pitchMin>=-80 and l.pitchMax<=80)
assert(look.baseSet=='WorkspotUnlocked' and look.sceneSet=='Tier3Scene')
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
  assert.equal((body.match(/ObserveAfter\(/g) || []).length, 4, 'enter, exit, forced exit, scene camera');
});
