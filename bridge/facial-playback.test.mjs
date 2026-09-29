import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const facial = readFileSync(new URL('../mod/facial-playback.lua', import.meta.url), 'utf8');
const speech = readFileSync(new URL('../mod/speech.lua', import.meta.url), 'utf8');
const setup = `
local world, voice, paused, cursor, starts, stops, queries = true, true, false, 0, 0, 0, 0
local function native() assert(world, 'native call after world teardown'); queries=queries+1 end
local player = {
  ConvaiManagerVoice=function() native(); return voice end,
  GetEntityID=function() native(); return {hash='V'} end,
  ConvaiSpeechStart=function() native(); starts=starts+1; return true end,
  ConvaiSpeechStop=function() native(); stops=stops+1 end,
  ConvaiSpeechPause=function() native() end,
  ConvaiSpeechPosition=function() native(); return cursor end
}
Game={GetPlayer=function() return player end,
  GetAllBlackboardDefs=function() return {UI_System={}} end,
  GetBlackboardSystem=function() return {Get=function() return {GetBool=function() return paused end} end} end}
CName={new=function(x) return x end}
NewObject=function(name) assert(name=='ConvaiFaceFeature'); return {} end
io.open=function() return nil end
local captions={clear=function() end, show=function() end, enabled=function() return true end,
  beginTimed=function() end, syncTimed=function() end}
local function actor(id)
  local a={id=id, owned=true, ready=true, alive=true, frames={}, resets=0}
  function a:GetEntityID() native(); return {hash=self.id} end
  function a:IsAttached() native(); return true end
  function a:IsDeadNoStatPool() native(); return not self.alive end
  function a:ConvaiFaceReady() native(); return self.ready end
  function a:ConvaiFaceApply(feature)
    native(); if self.reject then error('rejected') end
    local copy={}; for key,value in pairs(feature) do copy[key]=value end
    self.frames[#self.frames+1]=copy; return true
  end
  function a:ConvaiFaceReset() native(); self.resets=self.resets+1; return true end
  return a
end
local judy,johnny=actor('Judy-1'),actor('Johnny-1')
convaiCompanions={owns=function(a) return a.owned end}
local face=(function() ${facial} end)()
dofile=function(path) return path=='facial-playback.lua' and face or captions end
local speech=(function() ${speech} end)()
speech.available=true
local function input(a,id)
  speech.target=a; cursor=0
  local context={entity=a.id, requestId=id, name=a.id}
  return context,{text='Hello V.',audio={slot=0,event='convai_reply_0',duration=2},
    face={version=1,requestId=id,entity=a.id,duration=2,source='audio-envelope',
      tracks={'jaw_mid_open'},frames={{0,0},{0.5,0.35},{2,0}}}}
end
`;
function run(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(setup + body));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

test('mouth follows the native audio cursor and rejoins it after pause, without restarting audio', () => run(`
  local context,reply=input(judy,'one'); assert(speech.start(context,reply))
  assert(#judy.frames==0)
  cursor=0.25; speech.update(1.2)
  assert(math.abs(judy.frames[1].jaw_mid_open-0.175)<0.0001)
  assert(face.position==0.25 and starts==1)
  paused=true; speech.update(1); assert(judy.resets==1 and face.state=='paused')
  speech.update(1); assert(#judy.frames==1 and judy.resets==1)
  paused=false; cursor=0.5; speech.update(0.01)
  assert(judy.frames[2].jaw_mid_open==0.35 and starts==1)
  cursor=2; speech.update(0.1)
  assert(judy.resets==2 and not face.active and not speech.requestId)
`));

test('speaker changes reset the old copy and a stale request cannot animate another entity', () => run(`
  local c,r=input(judy,'one'); speech.start(c,r); cursor=0.5; speech.update(0.1)
  c,r=input(johnny,'two'); assert(speech.start(c,r)); assert(judy.resets==1)
  cursor=0.5; speech.update(0.1); assert(#johnny.frames==1 and #judy.frames==1)
  face.sync(judy,0.8,'one')
  assert(face.active and #judy.frames==1 and judy.resets==1 and #johnny.frames==1)
  assert(speech.requestId=='two')
  speech.stop('cancelled'); assert(not speech.requestId and johnny.resets==1)
`));

test('unload abandons every face handle without invoking an old world object', () => run(`
  local c,r=input(judy,'one'); speech.start(c,r); cursor=0.5; speech.update(0.1)
  local before=queries; world=false
  speech.abandon()
  assert(queries==before and not face.active and not face.timeline and not face.feature)
  assert(not speech.actor and not speech.player and not speech.target and not speech.requestId)
  assert(face.state=='unloaded' and judy.resets==0)
`));

test('invalid timelines and unsupported rigs preserve voice playback without uncontrolled facial channels', () => run(`
  for _,kind in ipairs({'owner','time','weight','track','rig'}) do
    local c,r=input(judy,kind)
    judy.ready=true
    if kind=='owner' then r.face.entity='someone-else'
    elseif kind=='time' then r.face.frames[2][1]=0
    elseif kind=='weight' then r.face.frames[2][2]=0/0
    elseif kind=='track' then r.face.tracks[1]='head_yaw'
    elseif kind=='rig' then judy.ready=false end
    assert(speech.start(c,r) and not face.active)
    cursor=0.5; speech.update(0.1); assert(speech.state=='playing' and #judy.frames==0)
    speech.stop('cancelled')
  end
`));

test('native apply failure and muting clean up once without breaking the speech owner', () => run(`
  local c,r=input(judy,'one'); speech.start(c,r); judy.reject=true
  cursor=0.5; speech.update(0.1)
  assert(face.state=='error' and judy.resets==1 and speech.state=='playing')
  cursor=0.75; speech.update(0.1); assert(judy.resets==1)
  judy.reject=false; c,r=input(judy,'two'); speech.start(c,r)
  cursor=0.5; speech.update(0.1); voice=false; speech.update(0.1)
  assert(speech.state=='muted' and not face.active and judy.resets==2)
`));

test('reserved upper lip and active corner controls reach the native feature and clear with the same owner', () => run(`
  local c,r=input(judy,'articulation')
  r.face.source='local-phonetic'; r.face.articulation='coarticulated-v4'
  r.face.tracks={'jaw_mid_open','lips_l_upper_raise','lips_r_upper_raise','lips_l_corner_stretch','lips_r_corner_stretch'}
  r.face.frames={{0,0,0,0,0,0},{0.5,.05,0,0,.065,.065},{2,0,0,0,0,0}}
  assert(speech.start(c,r)); cursor=0.5; speech.update(.01)
  assert(judy.frames[1].lips_l_upper_raise==0 and judy.frames[1].lips_r_upper_raise==0)
  assert(judy.frames[1].lips_r_corner_stretch==.065)
  assert(face.status().articulation=='coarticulated-v4')
  speech.stop('cancelled'); assert(judy.resets==1 and not face.active)
`));
