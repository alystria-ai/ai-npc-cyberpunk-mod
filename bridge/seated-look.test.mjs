import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Free look while V sits (docs/COMPANION_SEATING.md): a fake TweakDB holding the
// vanilla camera parameter sets, driven through the module's one apply() call.
const source = readFileSync(new URL('../mod/seated-look.lua', import.meta.url), 'utf8');
function run(code) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(fixture + code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}
const fixture = `
local look=(load([==[${source}]==]))()
-- Vanilla values read from the installed tweakdb.bin (game 2.3, Phantom Liberty identical).
local function vanilla()
  return {
    ['fppCameraParamSets.Workspot.yawMaxLeft']=15,['fppCameraParamSets.Workspot.yawMaxRight']=-15,
    ['fppCameraParamSets.Workspot.pitchMin']=-15,['fppCameraParamSets.Workspot.pitchMax']=0,
    ['fppCameraParamSets.WorkspotUnlocked.yawMaxLeft']=15,['fppCameraParamSets.WorkspotUnlocked.yawMaxRight']=-15,
    ['fppCameraParamSets.WorkspotUnlocked.pitchMin']=-15,['fppCameraParamSets.WorkspotUnlocked.pitchMax']=15,
    ['fppCameraParamSets.WorkspotLocked.yawMaxLeft']=0,['fppCameraParamSets.WorkspotLocked.yawMaxRight']=0,
    ['fppCameraParamSets.WorkspotLocked.pitchMin']=0,['fppCameraParamSets.WorkspotLocked.pitchMax']=0,
    ['fppCameraParamSets.WorkspotUnlockedCameraVerySmall.yawMaxLeft']=.01,
    ['fppCameraParamSets.Tier3Scene.yawMaxLeft']=90,['fppCameraParamSets.Default.yawMaxLeft']=180,
  }
end
local function fake(flats)
  local db={flats=flats,writes={},updates={}}
  function db:GetFlat(path) return self.flats[path] end
  function db:SetFlat(path,value) self.writes[#self.writes+1]=path;if not self.refuse then self.flats[path]=value end;return true end
  function db:Update(record) self.updates[#self.updates+1]=record;return true end
  return db
end
`;

test('both free-look workspot sets widen to the seated limits, once, with their records refreshed', () => run(`
local db=fake(vanilla())
local report=look.apply(db)
assert(report.changed==8 and #report.failed==0,'eight flats changed, got '..report.changed)
for _,set in ipairs({'Workspot','WorkspotUnlocked'}) do
  local p='fppCameraParamSets.'..set..'.'
  assert(db.flats[p..'yawMaxLeft']==90 and db.flats[p..'yawMaxRight']==-90,set..' yaw')
  assert(db.flats[p..'pitchMin']==-50 and db.flats[p..'pitchMax']==45,set..' pitch')
end
assert(#db.updates==2,'each record is refreshed once')
`));

test('the locked, very small, scene and default sets are never written', () => run(`
local before=vanilla()
local db=fake(vanilla())
look.apply(db)
for path,value in pairs(before) do
  if not path:find('%.Workspot%.') and not path:find('%.WorkspotUnlocked%.') then
    assert(db.flats[path]==value,path..' was changed')
  end
end
for _,path in ipairs(db.writes) do
  assert(path:find('^fppCameraParamSets%.Workspot%.') or path:find('^fppCameraParamSets%.WorkspotUnlocked%.'),'wrote '..path)
end
`));

test('running again changes nothing: limits only ever widen', () => run(`
local db=fake(vanilla())
look.apply(db)
local writes=#db.writes
local again=look.apply(db)
assert(again.changed==0 and #db.writes==writes,'second run wrote again')
assert(#db.updates==2,'no refresh without a change')
`));

test('a flat that is already wider is kept, and a missing flat is skipped without error', () => run(`
local flats=vanilla()
flats['fppCameraParamSets.Workspot.yawMaxLeft']=120
flats['fppCameraParamSets.Workspot.pitchMax']=nil
local db=fake(flats)
local report=look.apply(db)
assert(db.flats['fppCameraParamSets.Workspot.yawMaxLeft']==120,'wider value was narrowed')
assert(#report.skipped==1 and report.skipped[1]=='fppCameraParamSets.Workspot.pitchMax','missing flat not reported')
assert(db.flats['fppCameraParamSets.Workspot.yawMaxRight']==-90,'other fields still widen')
`));

test('a write the game refuses is reported and does not throw', () => run(`
local db=fake(vanilla());db.refuse=true
local report=look.apply(db)
assert(report.changed==0 and #report.failed==8,'refused writes counted, got '..#report.failed)
assert(#db.updates==0,'nothing refreshed')
local none=look.apply(nil)
assert(none.changed==0 and #none.failed==1,'no TweakDB reports one failure')
local throwing=look.apply({GetFlat=function() error('boom') end})
assert(throwing.changed==0 and #throwing.failed==0,'a throwing read is skipped')
`));

test('the limits are wide enough to look at a companion on the same bench and not unbounded', () => run(`
local l=look.limits
assert(l.yawMaxLeft>=90 and l.yawMaxRight<=-90,'a neighbour 90 degrees to the side must be reachable')
assert(l.yawMaxLeft<=120 and l.yawMaxRight>=-120,'not a full turn')
assert(l.pitchMin<0 and l.pitchMax>0 and l.pitchMin>=-80 and l.pitchMax<=80,'pitch inside the default +-80')
`));

test('init.lua calls it once from onInit and no frame handler does', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  assert.equal((init.match(/seated-look\.lua/g) || []).length, 1);
  const call = init.indexOf("dofile('seated-look.lua')");
  const onInit = init.indexOf("registerForEvent('onInit'");
  const onUpdate = init.indexOf("registerForEvent('onUpdate'");
  assert(onInit < call && call < onUpdate, 'the call lives in onInit');
});
