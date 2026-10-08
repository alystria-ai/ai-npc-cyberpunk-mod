import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {buildFacialTimeline, buildProviderFacialTimeline, SPEECH_TRACKS} from './facial-timeline.mjs';
import {expressionTarget, ExpressionSmoother, ownedExpressionReceipt} from './companion-expressions.mjs';
import {silentWav} from './speech-audio.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const faceSource = readFileSync(new URL('../mod/facial-playback.lua', import.meta.url), 'utf8');
const speechSource = readFileSync(new URL('../mod/speech.lua', import.meta.url), 'utf8');
const literal = value => Array.isArray(value) ? `{${value.map(literal).join(',')}}` : value && typeof value === 'object'
  ? `{${Object.entries(value).filter(([, v]) => v !== undefined).map(([k,v]) => `[${JSON.stringify(k)}]=${literal(v)}`).join(',')}}`
  : value === null || value === undefined ? 'nil' : JSON.stringify(value);
const owner = {requestId: 'expression-turn', entity: 'copy-a', generation: 4};
const signal = (emotion = 'Joy', scale = 3, sequence = 0) => ({version: 1, correlated: true, emotion, scale, sequence});
const receipt = (emotion, scale, sequence) => ownedExpressionReceipt(signal(emotion, scale, sequence), owner);
const setup = `
local world,paused,cursor,nativeCount=true,false,0,0
local function native() assert(world,'native access after teardown');nativeCount=nativeCount+1 end
local function copy(v) if type(v)~='table' then return v end;local o={};for k,x in pairs(v) do o[k]=copy(x) end;return o end
local function actor(id)
 local a={id=id,owned=true,ready=true,alive=true,attached=true,frames={},resets=0,autonomous=true}
 function a:GetEntityID() native();return {hash=self.id} end
 function a:IsAttached() native();return self.attached end
 function a:IsDeadNoStatPool() native();return not self.alive end
 function a:IsOnAutonomousAI() native();return self.autonomous end
 function a:ConvaiFaceReady() native();return self.ready end
 function a:ConvaiFaceApply(feature) native();self.frames[#self.frames+1]=copy(feature);return true end
 function a:ConvaiFaceReset() native();self.resets=self.resets+1;return true end
 return a
end
local a,b,player=actor('copy-a'),actor('copy-b'),actor('V')
function player:ConvaiManagerVoice() return true end
function player:ConvaiSpeechStart() return true end
function player:ConvaiSpeechStop() end
function player:ConvaiSpeechPause() end
function player:ConvaiSpeechPosition() return cursor end
Game={GetPlayer=function() return player end,GetAllBlackboardDefs=function() return {UI_System={}} end,
 GetBlackboardSystem=function() return {Get=function() return {GetBool=function() return paused end} end} end,
 GetSceneSystem=function() return {GetScriptInterface=function() return {
  IsEntityInDialogue=function(_,id) return id.hash=='copy-a' and a.dialogue or false end,
  IsEntityInScene=function(_,id) return id.hash=='copy-a' and a.scene or false end} end} end}
NPCPuppet={IsInCombat=function(actor) native();return actor.combat or false end}
StatusEffectSystem={ObjectHasStatusEffectWithTag=function(actor,tag) native();return actor.injured and tag=='Injured' or false end}
CName={new=function(v) return v end}
NewObject=function(name) assert(name=='ConvaiFaceFeature');return {} end
io.open=function() return nil end
convaiCompanions={owns=function(actor) return actor.owned end}
local face=(function() ${faceSource} end)()
local captions={clear=function() end,clearEntity=function() end,show=function() end,enabled=function() return false end,
 beginTimed=function() end,syncTimed=function() end}
dofile=function(path) if path=='facial-playback.lua' then return face end;return captions end
local speech=(function() ${speechSource} end)();speech.available=true
local context=${literal(owner)}
local rows={{entity=a.id,npc=a},{entity=b.id,npc=b}}
local function tick(dt,options)
 options=options or {};options.actors=options.actors or rows;options.paused=paused
 speech.update(dt,options)
end
local function last(actor) return actor.frames[#actor.frames] end
local function allZero(pose) for _,track in ipairs(${literal(Object.keys(expressionTarget()))}) do assert(pose[track]==0,track) end end
`;
function run(body) {
  const vm=lauxlib.luaL_newstate();lualib.luaL_openlibs(vm);
  try {
    const status=lauxlib.luaL_dostring(vm,to_luastring(setup+body));
    assert.equal(status,lua.LUA_OK,status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(vm,-1)));
  } finally {lua.lua_close(vm);}
}
function wav(duration = 1) {
  const bytes=Buffer.concat([silentWav().subarray(0,44),Buffer.alloc(24000*2*duration)]);
  bytes.writeUInt32LE(bytes.length-8,4);bytes.writeUInt32LE(bytes.length-44,40);return bytes.toString('base64');
}

test('managed idle copies receive one subtle native expression each and retain no actor handles',()=>run(`
 tick(.1);assert(#a.frames==1 and #b.frames==1)
 -- October 8: the resting face is neutral; a smile needs a cue (bridge/emotion-selector.mjs).
 assert(last(a).lips_l_corner_up==0 and last(a).lips_l_corner_dn==0,last(a).lips_l_corner_up)
 assert(last(a).jaw_mid_open==nil and last(a).eye_l_blink==nil and last(a).HeadYaw==nil)
 for _,slot in pairs(face.expressions) do for _,value in pairs(slot) do assert(value~=a and value~=b and value~=player) end end
 tick(.1);assert(#a.frames==2 and #b.frames==2)
`));

test('Lua expression policy matches the pure policy and stops its clock while paused',()=>{
  const smoother=new ExpressionSmoother();const expected=smoother.update(expressionTarget(),.1);
  run(`tick(.1);local expected=${literal(expected)};for key,value in pairs(expected) do assert(math.abs(last(a)[key]-value)<1e-12,key) end
  local clock=face.expressionClock;paused=true;tick(10);assert(face.expressionClock==clock and #a.frames==1)
  paused=false;tick(.1);assert(face.expressionClock>clock and #a.frames==2)`);
});

test('new thinking or listening input retires a previous reaction before another reply',()=>run(`
 face.beginExpression(context,${literal(receipt('Joy',3,0))});face.endExpression(context,true);tick(.1)
 assert(last(a).lips_l_corner_up>0)
 tick(.1,{thinkingEntity=a.id,thinkingRequestId='next-input'});allZero(last(a));assert(face.expressions[a.id].emotion==nil)
 tick(.1);assert(last(a).lips_l_corner_up==0,'the retired reaction leaves the neutral rest')
 tick(.1,{listeningEntity=a.id});allZero(last(a))
`));

test('combat, injury, native dialogue and lost autonomy immediately suppress all optional expression deltas',()=>run(`
 local joys={${[1, 2, 3, 4].map(i => literal(receipt('Joy', 3, i))).join(',')}}
 for i,flag in ipairs({'combat','injured','dialogue','scene'}) do
  face.beginExpression(context,joys[i]);a[flag]=false;tick(.1);assert(last(a).lips_l_corner_up>0,flag)
  a[flag]=true;tick(.1);allZero(last(a));a[flag]=false
 end
 a.autonomous=false;tick(.1);allZero(last(a));a.autonomous=true
 tick(.1,{blocked=true});allZero(last(a))
`));

test('speaking composes one feature with unchanged accepted Omni contact/tongue weights',()=>{
  const line=buildFacialTimeline({audio:wav(),mouthCuesFormat:'rhubarb-phonetic-v1',
    mouthCues:[{start:0,end:.5,value:'A'},{start:.5,end:1,value:'G'}],expressionSignal:signal()},owner);
  // Compare the composed feature with the authored frame itself: the separate
  // local easing (motion) is covered by facial-playback tests.
  delete line.motion;
  const at=line.frames.find(frame=>frame[0]===.25);
  const expected=Object.fromEntries(SPEECH_TRACKS.map((track,i)=>[track,at[i+1]]));
  run(`tick(.1);speech.target=a
  assert(speech.start(context,{text='Hello.',audio={slot=0,event='convai_reply_0',duration=1},face=${literal(line)}}))
  local count=#a.frames;cursor=.25;tick(.1);assert(#a.frames==count+1 and #b.frames==2)
  local expected=${literal(expected)};for key,value in pairs(expected) do assert(last(a)[key]==value,key) end
  assert(last(a).lips_l_corner_up==0 and last(a).lips_together_up==.85)
  assert(last(a).eye_l_brows_raise_out>0)
  speech.stop('cancelled');tick(.1);assert(last(a).eye_l_brows_raise_out==0)
  `);
});

test('the final native writer suppresses a held smile on rounded phonemes without touching speech fields',()=>run(`
 face.beginExpression(context,${literal(receipt('Joy',3,0))});tick(.1)
 assert(last(a).lips_l_corner_up>0)
 local timeline={version=1,requestId=context.requestId,entity=a.id,duration=1,source='audio-envelope',
  tracks={'jaw_mid_open','lips_l_funnel','lips_r_funnel','lips_suck_up'},
  frames={{0,.27123,.32,.32,.05342},{1,.27123,.32,.32,.05342}}}
 assert(face.start(context,timeline,a,1));face.beginExpressionFrame(.1,{actors=rows});face.sync(a,.3,context.requestId)
 assert(last(a).lips_l_corner_up==0 and last(a).lips_r_corner_up==0)
 assert(last(a).jaw_mid_open==.27123 and last(a).lips_l_funnel==.32 and last(a).lips_suck_up==.05342)
`));

test('negative metadata replaces a smile, rejects cross-copy/generation/sequence receipts and expires after speech',()=>run(`
 face.beginExpression(context,${literal(receipt('Joy',3,0))});tick(.1)
 assert(last(a).lips_l_corner_up>0)
 local bad=${literal(receipt('Grief',3,1))};bad.entity='copy-b';assert(not face.acceptExpression(context,bad))
 bad.entity=context.entity;bad.generation=3;assert(not face.acceptExpression(context,bad))
 bad.generation=context.generation;assert(face.acceptExpression(context,bad));assert(not face.acceptExpression(context,bad))
 tick(.1);assert(last(a).lips_l_corner_up==0 and last(a).lips_l_corner_dn>0)
 assert(last(b).lips_l_corner_up==0 and last(b).lips_l_corner_dn==0,'the other copy rests neutral')
 face.endExpression(context,true);for i=1,79 do tick(.1) end
 assert(last(a).lips_l_corner_up==0 and last(a).lips_l_corner_dn>0,'the frown holds for 8 s')
 for _=1,30 do tick(.1) end;assert(last(a).lips_l_corner_up==0 and last(a).lips_l_corner_dn<.01,'then the face returns to neutral')
 assert(not face.acceptExpression(context,${literal(receipt('Joy',3,2))}))
`));

test('unload and dismissal retire every expression owner without native reads from abandon',()=>run(`
 tick(.1);speech.clearEntity(a.id);assert(face.expressions[a.id]==nil)
 a.attached=false;tick(.1);assert(face.expressions[a.id]==nil)
 local count=nativeCount;world=false;speech.abandon();assert(nativeCount==count and next(face.expressions)==nil)
`));

test('provider expression tracks share the accepted source times and never change speech frames',()=>{
  const result={duration:1,complete:true,facesFormat:'arkit61',facesTimebase:'audio-seconds',
    faces:Array.from({length:61},(_,i)=>({at:i/60,values:Array.from({length:61},(_,j)=>(i+j)%19/20)}))};
  const neutral=buildProviderFacialTimeline(result,owner);
  for (const expressionSignal of [signal(),signal('Grief'),signal('Unfamiliar')]) {
    const line=buildProviderFacialTimeline({...result,expressionSignal},owner);
    assert.deepEqual(line.frames,neutral.frames);assert.deepEqual(line.tracks,neutral.tracks);
    assert.deepEqual(line.providerExpressions.frames.map(f=>f[0]),line.frames.map(f=>f[0]));
  }
  const frame=neutral.providerExpressions.frames[15];
  run(`assert(face.updateContinuous(context,${literal(neutral)},a,1));face.beginExpressionFrame(.1,{actors=rows})
  face.sync(a,.25,context.requestId);assert(last(a).eye_l_brows_raise_in>0 and last(a).eye_l_brows_raise_out>0)
  assert(#a.frames==1 and face.position==.25)`);
  assert.equal(frame.length,10);
});

test('malformed optional curves and receipts cannot reject accepted speech or invent a happy mood',()=>{
  const line=buildFacialTimeline({audio:wav(),expressionSignal:signal('Unknown label')},owner);
  line.providerExpressions={version:1,format:'arkit61-expression9',frames:[[0,NaN]]};
  // Lua JSON fixtures cannot represent NaN; a wrong frame width exercises the
  // same optional-curve rejection without invalidating the speech document.
  line.providerExpressions.frames=[[0,1]];
  run(`speech.target=a;assert(speech.start(context,{text='Hello.',audio={slot=0,event='convai_reply_0',duration=1},face=${literal(line)}}))
  cursor=.3;tick(.1);assert(face.active and last(a).lips_l_corner_up==0 and face.providerExpressions==nil)
  assert(face.error==nil)`);
});

test('an Omni/envelope timeline cannot claim provider expression authority by adding a well-shaped curve',()=>{
  const line=buildFacialTimeline({audio:wav()},owner);
  line.providerExpressions={version:1,format:'arkit61-expression9',frames:line.frames.map(frame=>[frame[0],...Array(9).fill(1)])};
  run(`assert(face.start(context,${literal(line)},a,1));assert(face.providerExpressions==nil)
  face.beginExpressionFrame(.1,{actors=rows});face.sync(a,.3,context.requestId)
  assert(face.active and last(a).eye_l_brows_lower==0 and last(a).eye_l_brows_raise_out==0)`);
});

test('October 8: speech without any intent rests neutral, and a text cue shows at the live-tested strength', ()=>{
  const line=buildFacialTimeline({audio:wav(),mouthCuesFormat:'rhubarb-phonetic-v1',
    mouthCues:[{start:0,end:.5,value:'C'},{start:.5,end:1,value:'C'}]},owner);
  delete line.motion;
  const warm=buildFacialTimeline({audio:wav(),mouthCuesFormat:'rhubarb-phonetic-v1',
    mouthCues:[{start:0,end:.5,value:'C'},{start:.5,end:1,value:'C'}],expressionSignal:signal('Trust',2)},owner);
  delete warm.motion;
  const curious=buildFacialTimeline({audio:wav(),mouthCuesFormat:'rhubarb-phonetic-v1',
    mouthCues:[{start:0,end:.5,value:'C'},{start:.5,end:1,value:'C'}],expressionSignal:signal('Interest',2)},owner);
  delete curious.motion;
  run(`tick(.1);speech.target=a
  local function speak(timeline,id)
   local ctx=context
   assert(speech.start(ctx,{text='Hello.',audio={slot=0,event='convai_reply_0',duration=1},face=timeline}))
   for i=1,12 do cursor=.2+.03*i;tick(.1) end
   local frame=last(a);speech.stop('cancelled');for _=1,12 do tick(.1) end;return frame
  end
  -- No receipt: no smile while speaking (October 8: the resting warmth is gone).
  local none=speak(${literal(line)},'none')
  assert(none.lips_l_corner_up==0,none.lips_l_corner_up)
  -- A Trust scale-2 cue: the gentle smile.
  local trust=speak(${literal(warm)},'trust')
  assert(trust.lips_l_corner_up>=.12 and trust.lips_l_corner_up<=.17,'trust '..trust.lips_l_corner_up)
  -- Interest lifts the brows only.
  local interest=speak(${literal(curious)},'interest')
  assert(interest.eye_l_brows_raise_out>=.05 and interest.eye_l_brows_raise_out<=.11 and interest.lips_l_corner_up==0,'interest '..interest.eye_l_brows_raise_out..' '..interest.lips_l_corner_up)
  `);
});

test('the per-turn expression receipt publishes emotion, scale and the peak pose written while speaking', ()=>{
  const line=buildFacialTimeline({audio:wav(),mouthCuesFormat:'rhubarb-phonetic-v1',
    mouthCues:[{start:0,end:.5,value:'C'},{start:.5,end:1,value:'C'}],expressionSignal:signal('Sadness',3)},owner);
  delete line.motion;
  run(`tick(.1);speech.target=a
  assert(face.status().expressions.lastSpeech==nil)
  assert(speech.start(context,{text='Hello.',audio={slot=0,event='convai_reply_0',duration=1},face=${literal(line)}}))
  for i=1,10 do cursor=.2+.03*i;tick(.1) end
  local turn=face.status().expressions.lastSpeech
  assert(turn,'no receipt');assert(turn.entity==a.id,'entity');assert(turn.requestId==context.requestId,'request');assert(turn.frames>5,'frames '..turn.frames)
  assert(turn.emotion=='Sadness' and turn.family=='sadness' and turn.scale==3,tostring(turn.emotion))
  assert(turn.peak.lips_l_corner_dn>=.30 and turn.peak.eye_l_brows_raise_in>=.40 and turn.peak.lips_l_corner_up==0)
  speech.stop('cancelled');tick(.1)
  assert(face.status().expressions.lastSpeech==turn,'the receipt stays readable after speech')
  `);
});

// Mouth articulation outranks every expression: jaw, closures and rounding are
// written exactly as without an emotion, and expression mouth corners yield to
// closure and rounding after smoothing, at any feeling and strength.
test('lip closure, rounding and jaw frames are identical with or without an active expression', () => {
  const emotions = [['Joy', 3], ['Trust', 3], ['Sadness', 3], ['Anger', 3], ['Fear', 3], ['Disgust', 3], ['Surprise', 3]];
  const speechTracks = ['jaw_mid_open', 'lips_together_up', 'lips_together_dn', 'lips_l_funnel', 'lips_r_funnel',
    'lips_l_purse', 'lips_r_purse', 'lips_suck_up'];
  const timelineFor = id => ({version: 1, requestId: id, entity: 'copy-a', duration: 1, source: 'audio-envelope',
    tracks: speechTracks, frames: [
      [0, .30, 0, 0, 0, 0, 0, 0, 0], [.5, .30, 0, 0, 0, 0, 0, 0, 0],
      [.55, .10, .85, .85, 0, 0, 0, 0, 0], [.8, .10, .85, .85, 0, 0, 0, 0, 0],
      [.85, .20, 0, 0, .32, .32, .28, .28, .05], [1, .20, 0, 0, .32, .32, .28, .28, .05]]});
  const scenarios = [[null, 0], ...emotions].map(([label, scale], index) => ({id: `mouth-${index}`, label: label ?? 'none',
    receipt: label ? ownedExpressionReceipt(signal(label, scale, 0), {...owner, requestId: `mouth-${index}`}) : undefined}));
  run(`
   local function play(id,receipt,timeline)
    local ctx={requestId=id,entity=a.id,generation=4}
    if receipt then face.beginExpression(ctx,receipt) end
    assert(face.start(ctx,timeline,a,1),face.error)
    local out={}
    -- Saturate the smoothed expression on open-mouth speech, then hit the
    -- contact and rounding frames with it fully present.
    for i=1,14 do face.beginExpressionFrame(.1,{actors=rows});face.sync(a,.2+i*.01,id) end
    out.open=copy(last(a))
    face.beginExpressionFrame(.1,{actors=rows});face.sync(a,.65,id);out.closure=copy(last(a))
    face.beginExpressionFrame(.1,{actors=rows});face.sync(a,.95,id);out.round=copy(last(a))
    face.stop(a,'cancelled');if receipt then face.endExpression(ctx,false) end
    return out
   end
   local baseline
   local scenarios=${literal(scenarios)}
   local timelines=${literal(Object.fromEntries(scenarios.map(s => [s.id, timelineFor(s.id)])))}
   local speech=${literal(speechTracks)}
   local sawCornerOpen=false
   for _,s in ipairs(scenarios) do
    local out=play(s.id,s.receipt,timelines[s.id])
    if s.label=='none' then baseline=out
    else
     for _,phase in ipairs({'open','closure','round'}) do
      for _,track in ipairs(speech) do
       assert(out[phase][track]==baseline[phase][track],s.label..' changed '..track..' at '..phase)
      end
     end
     -- Pressed lips and full rounding remove mouth emotion entirely.
     for _,phase in ipairs({'closure','round'}) do
      for _,track in ipairs({'lips_l_corner_up','lips_r_corner_up','lips_l_corner_dn','lips_r_corner_dn'}) do
       assert(out[phase][track]==0,s.label..' leaked '..track..' at '..phase..' '..tostring(out[phase][track]))
      end
     end
     if (out.open.lips_l_corner_up or 0)>.05 or (out.open.lips_l_corner_dn or 0)>.05 then sawCornerOpen=true end
    end
   end
   assert(baseline,'baseline ran');assert(sawCornerOpen,'the expression was actually active on open-mouth frames')
  `);
});

// The visibility probe (mod/face-test.lua) runs through the same writer.
const probeSource = readFileSync(new URL('../mod/face-test.lua', import.meta.url), 'utf8');
function runProbe(body) {
  const fakeIo = `local files={}
   io.open=function(path,mode)
    if mode=='rb' and path=='face-test.lua' then return {close=function() end} end
    if mode=='rb' then local text=files[path];if not text then return nil end
     return {read=function() return text end,close=function() end} end
    local parts={};return {write=function(self,...) for _,v in ipairs({...}) do parts[#parts+1]=v end end,
     close=function() files[path]=(mode=='ab' and (files[path] or '') or '')..table.concat(parts) end}
   end
   json={encode=function(v) local function enc(x) if type(x)=='table' then local o={};for k,y in pairs(x) do o[#o+1]=tostring(k)..'='..enc(y) end;table.sort(o);return '{'..table.concat(o,',')..'}' end;return tostring(x) end;return enc(v) end}
   dofile=function(path) if path=='face-test.lua' then return (function() ${probeSource} end)() end;return nil end
  `;
  const patched = setup.replace('io.open=function() return nil end', () => fakeIo);
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const status = lauxlib.luaL_dostring(vm, to_luastring(patched + `
 rows={{entity=a.id,npc=a,profileKey='judy-alvarez',name='Judy'},{entity=b.id,npc=b,profileKey='johnny-silverhand',name='Johnny'}}
 local function request(text) files['runtime/face-test-request.txt']=text end
 ` + body));
    assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1)));
  } finally { lua.lua_close(vm); }
}

test('face-test probe: writer mode pushes an extreme smile through the single writer and never touches the mouth', () => runProbe(`
 assert(face.faceTest,'probe is loaded when face-test.lua exists')
 request('n1\\nface-test judy smile 2 writer');tick(.3)
 assert(files['runtime/face-test-response.txt']:find('n1',1,true) and files['runtime/face-test-response.txt']:find('ok=true',1,true),files['runtime/face-test-response.txt'])
 tick(.1);local frame=last(a)
 assert(frame.lips_l_corner_up==1 and frame.lips_r_corner_up==1 and frame.lips_l_corner_dn==0 and frame.eye_l_brows_raise_in==0)
 assert(last(b).lips_l_corner_up<.1,'only the requested companion is driven')
 assert(files['runtime/face-test.log']:find('frame',1,true),'logs what was written')
 for _=1,25 do tick(.1) end;tick(.1);assert(last(a).lips_l_corner_up<.25,'probe ends and the real policy resumes (warmth floor)')
`));

test('face-test probe: direct mode bypasses the writer with its own feature and logs the apply result', () => runProbe(`
 request('n2\\nface-test judy frown 2 direct');tick(.3)
 local count=#a.frames;tick(.1);assert(#a.frames==count+1,'one direct write per frame, writer skipped')
 assert(last(a).lips_l_corner_dn==1 and last(a).lips_l_corner_up==nil)
 assert(files['runtime/face-test.log']:find('applied=true',1,true),files['runtime/face-test.log'])
`));

test('face-test probe: policy mode shows a real scale-3 smile WHILE speaking, yielding to lip closure', () => {
  const timeline = {version: 1, requestId: 'expression-turn', entity: 'copy-a', duration: 1, source: 'audio-envelope',
    tracks: ['jaw_mid_open', 'lips_together_up', 'lips_together_dn'], frames: [[0, .3, 0, 0], [.5, .3, 0, 0], [.55, .1, .85, .85], [1, .1, .85, .85]]};
  runProbe(`
 request('n3\\nface-test judy smile 8 policy');tick(.3)
 assert(face.start(context,${literal(timeline)},a,1),face.error)
 for i=1,14 do face.beginExpressionFrame(.1,{actors=rows});face.sync(a,.2+i*.01,context.requestId) end
 local open=copy(last(a));assert(open.lips_l_corner_up>.3 and open.lips_l_corner_up<=.65,open.lips_l_corner_up)
 face.beginExpressionFrame(.1,{actors=rows});face.sync(a,.7,context.requestId)
 assert(last(a).lips_together_up==.85 and last(a).lips_l_corner_up==0,'closure wins over the smile')
 face.stop(a,'cancelled')
`);
});

test('face-test probe: ending or replacing a run clears the jaw and every other probe field', () => runProbe(`
 request('n4\\nface-test judy sweep 10 writer');tick(.3)
 -- Sweep steps: smile, frown, browsup, browsdown, jaw (2 s each).
 for _=1,85 do tick(.1) end
 assert(last(a).jaw_mid_open==.5,'jaw step is active: '..tostring(last(a).jaw_mid_open))
 request('n5\\nface-test judy ramp-smile 6 writer');tick(.3);tick(.1)
 assert((last(a).jaw_mid_open or 0)==0,'a new run clears the jaw: '..tostring(last(a).jaw_mid_open))
 request('n6\\nface-test judy custom:jaw_mid_open=.5 6 writer');tick(.3);tick(.1)
 assert(last(a).jaw_mid_open==.5)
 request('n7\\nface-test judy off');tick(.3);tick(.1)
 assert((last(a).jaw_mid_open or 0)==0,'off clears the jaw: '..tostring(last(a).jaw_mid_open))
 tick(.1);assert((last(a).jaw_mid_open or 0)==0)
`));

// Per-character warmth and gain come from the actor rows' profile keys (Lua only).
test('Judy and a cold character both rest neutral; Judy\'s corner gain and the squint follow a real smile', () => run(`
 rows[1].profileKey='judy-alvarez';rows[2].profileKey='adam-smasher'
 for _=1,40 do tick(.1) end
 local judy,cold=last(a),last(b)
 assert(judy.lips_l_corner_up==0 and judy.eye_l_oculi_squint_outer_lower==0,'judy rests neutral: '..judy.lips_l_corner_up)
 assert(cold.lips_l_corner_up==0 and cold.eye_l_oculi_squint_outer_lower==0,'a cold face stays flat')
 -- Joy at scale 3 on Judy: corners x1.5 capped at .65, squint capped at .30, brows ungained.
 face.beginExpression(context,${literal(receipt('Joy',3,0))});for _=1,40 do tick(.1) end
 assert(math.abs(last(a).lips_l_corner_up-.65)<.01,'judy joy: '..last(a).lips_l_corner_up)
 assert(math.abs(last(a).eye_l_oculi_squint_outer_lower-.35)<.01)
 assert(math.abs(last(a).eye_l_brows_raise_out-.20)<.01)
 face.endExpression(context,false)
`));

test('speaking with Interest or no emotion shows no smile, even for a warm character', () => {
  const lineFor = (emotion, id) => {
    const line = buildFacialTimeline({audio: wav(), mouthCuesFormat: 'rhubarb-phonetic-v1',
      mouthCues: [{start: 0, end: .5, value: 'C'}, {start: .5, end: 1, value: 'C'}],
      ...(emotion ? {expressionSignal: signal(emotion, 2)} : {})}, {...owner, requestId: id});
    delete line.motion; return line;
  };
  const interest = lineFor('Interest', 'warm-interest'), none = lineFor(null, 'warm-none');
  run(`tick(.1);speech.target=a
  rows[1].profileKey='judy-alvarez';rows[2].profileKey='adam-smasher'
  local function speak(timeline,target,actor)
   local ctx={requestId=timeline.requestId,entity=actor.id,generation=4}
   speech.target=actor
   assert(speech.start(ctx,{text='Hello.',audio={slot=0,event='convai_reply_0',duration=1},face=timeline}))
   for i=1,14 do cursor=.2+.03*i;tick(.1) end
   local frame=copy(last(actor));speech.stop('cancelled');for _=1,6 do tick(.1) end;return frame
  end
  local warm=speak(${literal(interest)},'x',a)
  assert(warm.lips_l_corner_up==0 and warm.eye_l_brows_raise_out>.03,'Interest = brows only '..warm.lips_l_corner_up)
  local plain=speak(${literal(none)},'x',a)
  assert(plain.lips_l_corner_up==0,'no emotion, no smile '..plain.lips_l_corner_up)
  `);
});

// ---- Expression track (multi-emotion timeline) in the real Lua writer --------
const trackKeys = [[0, 1, 0, 0, 0, 0, 0, 0, 0], [1.8, 1, 0, 0, 0, 0, 0, 0, 0], [2.1, 0, 0, 1, 0, 0, 0, 0, 0], [3.5, 0, 0, 1, 0, 0, 0, 0, 0]];
const trackLine = (id, extra = {}) => ({version: 1, requestId: id, entity: 'copy-a', duration: 3.5, source: 'audio-envelope',
  tracks: ['jaw_mid_open', 'lips_together_up', 'lips_together_dn', 'lips_l_funnel', 'lips_r_funnel', 'lips_l_purse', 'lips_r_purse'],
  frames: [[0, .3, 0, 0, 0, 0, 0, 0], [3.5, .3, 0, 0, 0, 0, 0, 0]],
  expressionTrack: {version: 1, format: 'emotion-mix-v1', families: ['joy', 'trust', 'sadness', 'anger', 'fear', 'disgust', 'surprise', 'anticipation'], keys: trackKeys},
  ...extra});

test('track playback: the expression follows the heard audio position, blends between phrases and never snaps', () => run(`
 speech.target=a
 local ctx={requestId='trk',entity=a.id,generation=4}
 assert(speech.start(ctx,{text='Hello.',audio={slot=0,event='convai_reply_0',duration=3.5},face=${literal(trackLine('trk'))}}),face.error)
 local function at(position) cursor=position;tick(.1);return copy(last(a)) end
 local joy
 for p=.1,1.7,.1 do joy=at(p) end
 assert(joy.lips_l_corner_up>.3 and joy.lips_l_corner_dn==0 and joy.eye_l_brows_raise_in<.05,'phrase one is a smile: '..joy.lips_l_corner_up)
 -- Phrase two (sadness) begins at 1.8-2.1 s of AUDIO time: before 1.8 s nothing has changed.
 assert(joy.eye_l_brows_raise_in<.05)
 local previous=joy.lips_l_corner_up-joy.lips_l_corner_dn
 local mid
 for p=1.8,2.6,.02 do
  cursor=p;tick(.02);local frame=copy(last(a));local net=frame.lips_l_corner_up-frame.lips_l_corner_dn
  -- continuous: a signed corner axis crossing zero, never a jump
  assert(math.abs(net-previous)<.08,'corner step at '..p..': '..tostring(net-previous))
  previous=net
  if math.abs(p-2.0)<.011 then mid=frame end
 end
 for p=2.6,3.4,.1 do at(p) end
 local sad=at(3.45)
 assert(sad.lips_l_corner_dn>.15 and sad.lips_l_corner_up==0 and sad.eye_l_brows_raise_in>.2,'phrase two is sad: '..sad.lips_l_corner_dn..' '..sad.eye_l_brows_raise_in)
 assert(sad.eye_l_oculi_squint_outer_lower<.02,'no squint without a smile')
`));

test('track playback: closure and rounding still zero the corners and leave every speech field identical to a no-track reply', () => {
  const closing = id => ({version: 1, requestId: id, entity: 'copy-a', duration: 1, source: 'audio-envelope',
    tracks: ['jaw_mid_open', 'lips_together_up', 'lips_together_dn', 'lips_l_funnel', 'lips_r_funnel', 'lips_l_purse', 'lips_r_purse', 'lips_suck_up'],
    frames: [[0, .3, 0, 0, 0, 0, 0, 0, 0], [.5, .3, 0, 0, 0, 0, 0, 0, 0], [.55, .1, .85, .85, 0, 0, 0, 0, 0], [.8, .1, .85, .85, 0, 0, 0, 0, 0],
      [.85, .2, 0, 0, .32, .32, .28, .28, .05], [1, .2, 0, 0, .32, .32, .28, .28, .05]]});
  const withTrack = {...closing('trk-mouth'), expressionTrack: {version: 1, format: 'emotion-mix-v1',
    families: ['joy', 'trust', 'sadness', 'anger', 'fear', 'disgust', 'surprise', 'anticipation'],
    keys: [[0, .6, .4, .3, 0, 0, 0, 0, 0], [1, .6, .4, .3, 0, 0, 0, 0, 0]]}};
  run(`
   speech.target=a
   local function play(timeline)
    local ctx={requestId=timeline.requestId,entity=a.id,generation=4}
    assert(speech.start(ctx,{text='Hello.',audio={slot=0,event='convai_reply_0',duration=1},face=timeline}),face.error)
    local out={}
    for i=1,14 do cursor=.2+i*.01;tick(.1) end
    out.open=copy(last(a))
    cursor=.65;tick(.1);out.closure=copy(last(a))
    cursor=.95;tick(.1);out.round=copy(last(a))
    speech.stop('cancelled');for _=1,10 do tick(.1) end
    return out
   end
   local base=play(${literal(closing('trk-base'))})
   local mixed=play(${literal(withTrack)})
   local speechTracks={'jaw_mid_open','lips_together_up','lips_together_dn','lips_l_funnel','lips_r_funnel','lips_l_purse','lips_r_purse','lips_suck_up'}
   for _,phase in ipairs({'open','closure','round'}) do
    for _,track in ipairs(speechTracks) do assert(mixed[phase][track]==base[phase][track],track..' changed at '..phase) end
   end
   for _,phase in ipairs({'closure','round'}) do
    for _,track in ipairs({'lips_l_corner_up','lips_r_corner_up','lips_l_corner_dn','lips_r_corner_dn'}) do
     assert(mixed[phase][track]==0,track..' leaked at '..phase..': '..mixed[phase][track])
    end
   end
   assert(mixed.open.lips_l_corner_up>.1 or mixed.open.eye_l_brows_raise_in>.05,'the blended mix was active on open-mouth frames')
  `);
});

test('track playback: an invalid or misaligned track is ignored and speech continues on the reply-level cue', () => {
  const bad = trackLine('trk-bad', {expressionTrack: {version: 1, format: 'emotion-mix-v1', families: ['joy'], keys: [[0, 1]]}});
  const unordered = trackLine('trk-order'); unordered.expressionTrack = {...unordered.expressionTrack, keys: [[1, ...Array(8).fill(0)], [0.5, ...Array(8).fill(0)]]};
  run(`
   speech.target=a
   for _,timeline in ipairs({${literal(bad)},${literal(unordered)}}) do
    local ctx={requestId=timeline.requestId,entity=a.id,generation=4}
    assert(speech.start(ctx,{text='Hello.',audio={slot=0,event='convai_reply_0',duration=3.5},face=timeline}),face.error)
    assert(face.expressionTrackKeys==nil,'invalid track rejected')
    cursor=.5;tick(.1);assert(last(a).jaw_mid_open==.3,'speech still plays')
    speech.stop('cancelled');for _=1,5 do tick(.1) end
   end
  `);
});

test('the post-speech hold: a held mix releases its brows within about 1.5 s while the corners keep the longer expiry', () => run(`
 speech.target=a
 rows[1].profileKey='some-fixer'
 face.beginExpression(context,${literal(receipt('Sadness', 3, 0))})
 face.expressions[a.id].holdMix={0,0,1,0,0,0,0,0}
 face.endExpression(context,true)
 for _=1,5 do tick(.1) end
 assert(last(a).eye_l_brows_raise_in>.3,'still concerned right after speech: '..last(a).eye_l_brows_raise_in)
 for _=1,25 do tick(.1) end   -- about 3 s after speech
 assert(last(a).eye_l_brows_raise_in<.08,'brows released: '..last(a).eye_l_brows_raise_in)
 for _=1,90 do tick(.1) end
 assert(last(a).eye_l_brows_raise_in<.001 and last(a).lips_l_corner_dn<.01,'fully back at rest after the expiry: '..last(a).eye_l_brows_raise_in..' '..last(a).lips_l_corner_dn)
`));

test('face-test probe: policy mode leaves no injected feeling or active flag behind after off', () => runProbe(`
 request('n9\\nface-test judy browsup 6 policy');tick(.3);for _=1,5 do tick(.1) end
 local slot=face.expressions[a.id];assert(slot.emotion=='Surprise','the policy run injected a feeling')
 assert(not slot.active,'the probe never marks the turn active')
 request('n10\\nface-test judy off');tick(.3);tick(.1)
 assert(slot.emotion==nil and slot.family==nil and slot.holdMix==nil,'off clears the injected feeling')
 for _=1,60 do tick(.1) end
 assert(last(a).eye_l_brows_raise_in<.001 and last(a).eye_l_brows_raise_out<.001,'brows are neutral at idle after the probe')
`));
