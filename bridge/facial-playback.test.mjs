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

test('the 60 Hz sampling threshold tolerates float roundoff but rejects a true half-frame step', () => run(`
  local context,reply=input(judy,'frame-boundary');assert(face.start(context,reply.face,judy,2))
  face.sync(judy,.05,context.requestId);assert(#judy.frames==1)
  local nextPosition=.05+1/60
  assert(nextPosition-.05<1/60,'Fixture must reproduce the subtractive rounding boundary')
  face.sync(judy,nextPosition,context.requestId);assert(#judy.frames==2,'An exact 60 Hz step was dropped')
  face.sync(judy,nextPosition+1/120,context.requestId);assert(#judy.frames==2,'A true half-frame bypassed the rate limit')
  face.sync(judy,nextPosition+1/60,context.requestId);assert(#judy.frames==3)
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

test('contiguous native audio segments retain the actual mouth pose until final completion', () => run(`
  local context={entity='Judy-1',requestId='continuous',generation=7}
  local function timeline(index,start,first,last,a,b)
    return {version=1,requestId='continuous',entity='Judy-1',duration=1,source='convai-arkit61',
      segment={version=1,index=index,startSeconds=start,first=first,last=last},
      tracks={'jaw_mid_open'},frames={{0,a},{1,b}}}
  end
  assert(face.start(context,timeline(1,0,true,false,.05,.2),judy,1,{index=1,startSeconds=0}))
  face.sync(judy,.996,'continuous');face.sync(judy,1,'continuous')
  assert(face.active and judy.resets==0 and judy.frames[#judy.frames].jaw_mid_open==.2)
  assert(face.hold(judy,'continuous')and judy.resets==0)
  assert(face.start(context,timeline(2,1,false,false,.2,.3),judy,1,{index=2,startSeconds=1}))
  assert(judy.resets==0);face.sync(judy,.01,'continuous')
  assert(math.abs(judy.frames[#judy.frames].jaw_mid_open-.201)<.001)
  face.sync(judy,1,'continuous')
  assert(face.start(context,timeline(3,2,false,true,.3,0),judy,1,{index=3,startSeconds=2}))
  assert(judy.resets==0);face.sync(judy,.5,'continuous');face.sync(judy,1,'continuous')
  assert(judy.resets==1 and not face.active)
`));

test('invalid or noncontiguous facial replacements release the held pose and cannot borrow another turn', () => run(`
  local context={entity='Judy-1',requestId='continuous',generation=7}
  local function timeline(index,start)
    return {version=1,requestId='continuous',entity='Judy-1',duration=1,source='convai-arkit61',
      segment={version=1,index=index,startSeconds=start,first=index==1,last=false},
      tracks={'jaw_mid_open'},frames={{0,.1},{1,.2}}}
  end
  assert(face.start(context,timeline(1,0),judy,1,{index=1,startSeconds=0}))
  face.sync(judy,1,'continuous');assert(judy.resets==0)
  assert(face.start(context,timeline(3,2),judy,1,{index=3,startSeconds=2}))
  assert(judy.resets==1,'A missing segment must break the facial handoff')
  face.sync(judy,1,'continuous')
  assert(not face.start(context,timeline(4,3),judy,1,{index=5,startSeconds=3}))
  assert(judy.resets==2 and not face.active)
  assert(face.start(context,timeline(1,0),judy,1,{index=1,startSeconds=0}))
  face.sync(judy,1,'continuous');context.generation=8
  assert(face.start(context,timeline(2,1),judy,1,{index=2,startSeconds=1}))
  assert(judy.resets==3)
  face.sync(judy,.5,'continuous');assert(not face.start(context,nil,judy,1,{index=3,startSeconds=2}))
  assert(judy.resets==4 and not face.active)
`));

const continuousSetup = `
local context={entity='Judy-1',requestId='live-voice',generation=8}
local function growing(duration,complete,frames)
 return {version=1,continuous=true,complete=complete,requestId=context.requestId,
  entity=context.entity,generation=context.generation,duration=duration,
  source='convai-arkit61',articulation='arkit61-open-v2',tracks={'jaw_mid_open'},
  frames=frames or {{0,.1},{duration,.2}}}
end
`;

test('growing absolute timelines retain one native feature and synchronize only to heard audio', () => run(continuousSetup + `
 assert(face.updateContinuous(context,growing(.4,false),judy,.4))
 local feature=face.feature
 face.sync(judy,.2,context.requestId)
 assert(math.abs(judy.frames[1].jaw_mid_open-.15)<.0001 and face.position==.2)
 local index,applied=face.index,face.applied
 assert(face.updateContinuous(context,growing(.8,false,{{0,.1},{.4,.2},{.8,.3}}),judy,.8))
 assert(face.feature==feature and face.index==index and face.position==.2
  and face.applied==applied and judy.resets==0 and #judy.frames==1)
 face.sync(judy,.6,context.requestId)
 assert(face.feature==feature and face.index==2 and math.abs(judy.frames[2].jaw_mid_open-.25)<.0001)
 -- A revised tail is legitimate but does not create an extra audio tick.
 -- Apply its new pose at the next confirmed heard step, within the 60 Hz cap.
 assert(face.updateContinuous(context,growing(.8,false,{{0,.1},{.4,.2},{.8,.4}}),judy,.8))
 assert(#judy.frames==2)
 face.sync(judy,.6,context.requestId)
 assert(#judy.frames==2)
 local nextPosition=.6+1/60
 face.sync(judy,nextPosition,context.requestId)
 assert(math.abs(judy.frames[3].jaw_mid_open-(.3+1/120))<.0001 and judy.resets==0)
 -- Compacted snapshots may change frame count, not track identity or time.
 assert(face.updateContinuous(context,growing(1,false),judy,1))
 assert(face.index==1 and face.position==nextPosition and face.feature==feature)
 face.sync(judy,.7,context.requestId)
 assert(math.abs(judy.frames[4].jaw_mid_open-.17)<.0001)
`));

test('incomplete continuous boundaries hold a pose until final heard completion, including unchanged cursor', () => run(continuousSetup + `
 assert(face.updateContinuous(context,growing(.4,false),judy,.4))
 face.sync(judy,.45,context.requestId)
 assert(face.active and face.state=='holding-boundary' and face.position==.45
  and judy.frames[1].jaw_mid_open==.2 and judy.resets==0)
 local feature=face.feature
 assert(face.updateContinuous(context,growing(.8,false),judy,.8))
 face.sync(judy,.45,context.requestId)
 assert(face.feature==feature and #judy.frames==1 and face.state=='holding-boundary')
 local nextPosition=.45+1/60
 face.sync(judy,nextPosition,context.requestId)
 assert(face.state=='playing' and math.abs(judy.frames[2].jaw_mid_open-(.1+nextPosition/8))<.0001)
 face.sync(judy,.8,context.requestId)
 assert(face.active and face.state=='holding-boundary' and judy.resets==0)
 assert(face.updateContinuous(context,growing(.8,true),judy,.8))
 assert(face.active and judy.resets==0)
 face.sync(judy,.8,context.requestId)
 assert(not face.active and face.state=='finished' and judy.resets==1)
 face.sync(judy,.9,context.requestId);assert(judy.resets==1)
`));

test('repeated continuous timeline publications at a held cursor cannot bypass the facial rate cap', () => run(continuousSetup + `
 assert(face.updateContinuous(context,growing(.8,false),judy,.8))
 face.sync(judy,.2,context.requestId);assert(#judy.frames==1)
 for index=1,120 do
  assert(face.updateContinuous(context,growing(.8,false),judy,.8))
  face.sync(judy,.2,context.requestId)
 end
 assert(#judy.frames==1 and face.position==.2 and judy.resets==0)
 face.sync(judy,.2+1/120,context.requestId);assert(#judy.frames==1)
 face.sync(judy,.2+1/60,context.requestId);assert(#judy.frames==2)
`));

test('continuous facial updates reject other owners and stale generations without disturbing the current speaker', () => run(continuousSetup + `
 assert(face.updateContinuous(context,growing(.4,false),judy,.4))
 face.sync(judy,.2,context.requestId)
 local feature,timeline,applied=face.feature,face.timeline,face.applied
 for _,change in ipairs({'requestId','entity','generation'})do
  local other={requestId=context.requestId,entity=context.entity,generation=context.generation}
  other[change]=change=='generation' and 7 or 'other'
  assert(not face.updateContinuous(other,growing(.8,false),johnny,.8))
  local old=growing(.8,false);old[change]=other[change]
  assert(not face.updateContinuous(context,old,judy,.8))
  assert(face.active and face.feature==feature and face.timeline==timeline and face.applied==applied)
 end
 assert(judy.resets==0 and johnny.resets==0 and #johnny.frames==0)
 face.sync(johnny,.3,'other');assert(face.active and #johnny.frames==0)
`));

test('malformed or regressing continuous updates fail closed for their exact owner', () => run(continuousSetup + `
 for _,kind in ipairs({'duration','frames','duplicate','weight','track','track-order','source','complete','segment','regression','unfinalize'})do
  judy.resets=0
  local initial=growing(.4,kind=='unfinalize')
  if kind=='track-order'then initial.tracks={'jaw_mid_open','lips_apart_up'};initial.frames={{0,.1,.05},{.4,.2,.1}}end
  assert(face.updateContinuous(context,initial,judy,.4))
  face.sync(judy,.2,context.requestId)
  local next=growing(.8,false)
  if kind=='duration'then next.duration=0/0
  elseif kind=='frames'then next.frames={{0,.1}}
  elseif kind=='duplicate'then next.frames={{0,.1},{0,.2},{.8,.1}}
  elseif kind=='weight'then next.frames[2][2]=.51
  elseif kind=='track'then next.tracks={'head_yaw'}
  elseif kind=='track-order'then next.tracks={'lips_apart_up','jaw_mid_open'};next.frames={{0,.1,.05},{.8,.2,.1}}
  elseif kind=='source'then next.source='audio-envelope'
  elseif kind=='complete'then next.complete=nil
  elseif kind=='segment'then next.segment={index=1}
  elseif kind=='regression'then next=growing(.2,false)end
  assert(not face.updateContinuous(context,next,judy,kind=='regression' and .2 or .8),kind)
  assert(not face.active and face.feature==nil and face.timeline==nil and judy.resets==1,kind)
  face.sync(judy,.3,context.requestId);assert(judy.resets==1)
 end
`));

test('continuous pause releases the pose, growth stays paused, resume catches up, and unload abandons native state', () => run(continuousSetup + `
 assert(face.updateContinuous(context,growing(.4,false),judy,.4))
 face.sync(judy,.2,context.requestId)
 local feature=face.feature
 face.pause(judy);face.pause(judy)
 assert(judy.resets==1 and face.state=='paused')
 assert(face.updateContinuous(context,growing(.8,true),judy,.8))
 assert(face.feature==feature and face.state=='paused' and #judy.frames==1 and judy.resets==1)
 face.sync(judy,.6,context.requestId)
 assert(face.state=='playing' and math.abs(judy.frames[2].jaw_mid_open-.175)<.0001)
 local before=queries;world=false
 face.abandon('unloaded')
 assert(queries==before and not face.active and face.feature==nil and face.timeline==nil)
 assert(face.continuous==nil and face.generation==nil and face.requestId==nil)
 face.sync(judy,.7,context.requestId);assert(queries==before)
`));
