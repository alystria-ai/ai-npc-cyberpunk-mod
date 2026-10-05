import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {buildFacialTimeline} from './facial-timeline.mjs';
import {silentWav} from './speech-audio.mjs';
import {PocketFacialStream} from './pocket-facial-stream.mjs';
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

const luaLiteral=value=>Array.isArray(value)?`{${value.map(luaLiteral).join(',')}}`:
  value&&typeof value==='object'?`{${Object.entries(value).filter(([,v])=>v!==undefined)
    .map(([key,item])=>`[${JSON.stringify(key)}]=${luaLiteral(item)}`).join(',')}}`:
  value===null?'nil':JSON.stringify(value);

test('real Omni phonetic builder reaches the native adapter with calibrated contact, lift and reset',()=>{
  const bytes=Buffer.concat([silentWav().subarray(0,44),Buffer.alloc(24000*2*1.8)]);
  bytes.writeUInt32LE(bytes.length-8,4);bytes.writeUInt32LE(bytes.length-44,40);
  const cues=[...'ABCDEFGHX'].map((value,index)=>({value,start:index*.2,end:(index+1)*.2}));
  const timeline=buildFacialTimeline({audio:bytes.toString('base64'),mouthCues:cues,mouthCuesFormat:'rhubarb-phonetic-v1'},
    {requestId:'omni-native',entity:'Judy-1'});
  const literal=value=>Array.isArray(value)?`{${value.map(literal).join(',')}}`:
    value&&typeof value==='object'?`{${Object.entries(value).filter(([,v])=>v!==undefined).map(([k,v])=>`[${JSON.stringify(k)}]=${literal(v)}`).join(',')}}`:
    value===null?'nil':JSON.stringify(value);
  run(`
    local context,reply=input(judy,'omni-native');reply.audio.duration=1.8
    reply.face=${literal(timeline)}
    assert(speech.start(context,reply) and face.active)
    cursor=.1;speech.update(.1)
    assert(judy.frames[#judy.frames].jaw_mid_open>0 and judy.frames[#judy.frames].lips_together_up>.5
      and judy.frames[#judy.frames].lips_together_up<.85,'local contact should ease in')
    cursor=.3;speech.update(.2)
    assert(judy.frames[#judy.frames].lips_l_corner_stretch>.1 and judy.frames[#judy.frames].lips_l_upper_raise>0)
    cursor=1.3;speech.update(1)
    assert(judy.frames[#judy.frames].lips_l_lower_raise<.0001 and math.abs(judy.frames[#judy.frames].lips_suck_dn-.14)<.0001)
    cursor=1.5;speech.update(.2);assert(math.abs(judy.frames[#judy.frames].tongue_mid_tip_up-.25)<.0001)
    assert(face.status().articulation=='coarticulated-v5')
    cursor=1.8;speech.update(.3);assert(not face.active and judy.resets==1 and not speech.requestId)
  `);
});

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

test('validation bounds follow the native ranges written by Cyberpunk dialogue lipsync',()=>run(`
  local c,r=input(judy,'contact')
  r.face.tracks={'jaw_mid_open','lips_together_up','lips_together_dn'}
  r.face.frames={{0,0,0,0},{.5,.66,1,1},{2,0,0,0}}
  assert(speech.start(c,r) and face.active)
  cursor=.5;speech.update(.1)
  assert(judy.frames[#judy.frames].lips_together_up==1 and judy.frames[#judy.frames].jaw_mid_open==.66)
  speech.stop('cancelled');assert(judy.resets==1)
  c,r=input(judy,'bad-contact');r.face.tracks={'lips_together_up'}
  r.face.frames={{0,0},{.5,1.0001},{2,0}}
  assert(speech.start(c,r) and not face.active);speech.stop('cancelled')
  c,r=input(judy,'bad-jaw');r.face.frames[2][2]=.7001
  assert(speech.start(c,r) and not face.active)
  c,r=input(judy,'other-track');r.face.tracks={'lips_l_purse'};r.face.frames={{0,0},{.5,.5001},{2,0}}
  assert(speech.start(c,r) and not face.active)
  c,r=input(judy,'upper-roll');r.face.tracks={'lips_suck_up'}
  r.face.frames={{0,0},{.5,.29},{2,0}}
  assert(speech.start(c,r) and face.active)
  cursor=.5;speech.update(.1);assert(judy.frames[#judy.frames].lips_suck_up==.29)
  speech.stop('cancelled')
  c,r=input(judy,'bad-upper-roll');r.face.tracks={'lips_suck_up'}
  r.face.frames={{0,0},{.5,.3001},{2,0}}
  assert(speech.start(c,r) and not face.active)
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
  elseif kind=='weight'then next.frames[2][2]=.71
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

test('actual Pocket prefix upgrades envelope to phonetic poses through the Lua continuous consumer without layer restart',async()=>{
  const owner={requestId:'pocket-native-contract',entity:'Judy-1',generation:7};
  const lipsync={analyse:async()=>({mouthCuesFormat:'rhubarb-phonetic-v1',
    mouthCues:['A','B','D','F','G','H','E','C'].map((value,index)=>({start:index*.1,end:(index+1)*.1,value}))})};
  const stream=new PocketFacialStream({input:owner,lipsync});
  stream.push({index:1,offsetFrames:0,frames:19200,sampleRate:24000,channels:1,
    pcm:Float32Array.from({length:19200},(_,index)=>.2*Math.sin(index*.043))});
  const envelope=stream.snapshot(9600,false);
  await new Promise(done=>setImmediate(done));const phonetic=stream.snapshot(19200,false);
  stream.finish();const final=stream.snapshot(19200,true);
  assert.equal(envelope.source,'audio-envelope');assert.equal(phonetic.source,'local-phonetic');
  run(`
    local context=${luaLiteral(owner)}
    local envelope=${luaLiteral(envelope)}
    assert(face.updateContinuous(context,envelope,judy,.4),face.error)
    local feature=face.feature
    face.sync(judy,.2,context.requestId)
    assert(face.applied>0 and judy.frames[#judy.frames].jaw_mid_open>0)
    local before=face.applied
    local phonetic=${luaLiteral(phonetic)}
    assert(face.updateContinuous(context,phonetic,judy,.8),face.error)
    assert(face.feature==feature and judy.resets==0 and face.position==.2)
    face.sync(judy,.55,context.requestId)
    assert(face.applied>before and face.status().source=='local-phonetic'
      and face.status().articulation=='coarticulated-v5')
    assert(judy.frames[#judy.frames].tongue_mid_tip_up>0,'phonetic shapes were lost at the Lua seam')
    assert(face.updateContinuous(context,${luaLiteral(final)},judy,.8),face.error)
    face.sync(judy,.8,context.requestId)
    assert(not face.active and face.state=='finished' and judy.resets==1)
  `);
  stream.close();
});

test('Pocket continuous local-source schema retains owner, duration, weight and no-file-segment fences',()=>{
  const owner={requestId:'pocket-native-fences',entity:'Judy-1',generation:7};
  const stream=new PocketFacialStream({input:owner});
  stream.push({index:1,offsetFrames:0,frames:9600,sampleRate:24000,channels:1,pcm:new Float32Array(9600).fill(.1)});
  const prefix=stream.snapshot(9600,false);stream.close();
  run(`
    local context=${luaLiteral(owner)}
    for _,kind in ipairs({'requestId','entity','generation','duration','weight','segment','source','articulation'}) do
      local line=${luaLiteral(prefix)}
      if kind=='requestId' or kind=='entity' then line[kind]='wrong'
      elseif kind=='generation' then line.generation=8
      elseif kind=='duration' then line.duration=.5
      elseif kind=='weight' then line.frames[2][2]=2
      elseif kind=='segment' then line.segment={version=1,index=1,startSeconds=0,first=true,last=false}
      elseif kind=='source' then line.source='unqualified-local'
      elseif kind=='articulation' then line.source='local-phonetic';line.articulation='unqualified-phonetic' end
      assert(not face.updateContinuous(context,line,judy,.4),kind)
      assert(not face.active and #judy.frames==0,kind)
    end
  `);
});

test('actual resident allphone Pocket timeline reaches the Lua consumer with varied shapes and final reset',async()=>{
  const owner={requestId:'resident-phone-native-contract',entity:'Judy-1',generation:7};let deliver;
  const phoneAnalysis={beginTurn(input,{onPhones}){deliver=onPhones;return{push(){},finish(){},close(){}};}};
  const stream=new PocketFacialStream({input:owner,phoneAnalysis});
  stream.push({index:1,offsetFrames:0,frames:19200,sampleRate:24000,channels:1,
    pcm:Float32Array.from({length:19200},(_,index)=>.2*Math.sin(index*.043))});
  const envelope=stream.snapshot(9600,false,0);
  const receipt={type:'phones',owner,receivedFrames:19200,
    segments:[{phone:'AA',startFrame:0,endFrame:29},{phone:'OW',startFrame:30,endFrame:69}]};
  deliver(receipt);deliver(receipt);const phonetic=stream.snapshot(19200,false,.4);
  assert.equal(phonetic.recognition.format,'pocketsphinx-allphone-live-v1');
  stream.finish();const final=stream.snapshot(19200,true,.8);
  run(`
    local context=${luaLiteral(owner)}
    assert(face.updateContinuous(context,${luaLiteral(envelope)},judy,.4),face.error)
    local feature=face.feature
    face.sync(judy,.2,context.requestId)
    assert(face.updateContinuous(context,${luaLiteral(phonetic)},judy,.8),face.error)
    assert(face.feature==feature and judy.resets==0)
    face.sync(judy,.55,context.requestId)
    assert(judy.frames[#judy.frames].lips_l_purse>0,'resident acoustic shape was lost at the Lua seam')
    assert(face.status().source=='local-phonetic' and face.status().articulation=='coarticulated-v5')
    assert(face.updateContinuous(context,${luaLiteral(final)},judy,.8),face.error)
    face.sync(judy,.8,context.requestId)
    assert(not face.active and face.state=='finished' and judy.resets==1)
  `);
  await stream.close();
});
