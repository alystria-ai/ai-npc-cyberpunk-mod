import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {buildFacialTimeline, buildProviderFacialTimeline, SPEECH_TRACKS} from './facial-timeline.mjs';
import {expressionTarget, ExpressionSmoother, ownedExpressionReceipt} from './companion-expressions.mjs';
import {silentWav} from './speech-audio.mjs';
import {selectEmotion} from './emotion-selector.mjs';
import {attachExpressionTrack} from './expression-timeline.mjs';

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
 -- Idle: a light resting smile (default .12), easing in; the game's own authored smile is .10.
 assert(last(a).lips_l_corner_up>.03 and last(a).lips_l_corner_up<=.12 and last(a).lips_l_corner_dn==0,last(a).lips_l_corner_up)
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
 tick(.1);assert(last(a).lips_l_corner_up>0,'a retired happy reaction leaves the resting smile')
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
 assert(last(b).lips_l_corner_up>0 and last(b).lips_l_corner_dn==0,'the other copy keeps its resting smile')
 face.endExpression(context,true);for i=1,79 do tick(.1) end
 assert(last(a).lips_l_corner_up==0 and last(a).lips_l_corner_dn>0,'the frown holds for 8 s')
 for _=1,30 do tick(.1) end;assert(last(a).lips_l_corner_up==0 and last(a).lips_l_corner_dn<.01,'then a neutral face, no smile yet')
 -- The sad turn holds the resting smile off for a minute, then it eases back.
 for _=1,450 do tick(.1) end;assert(last(a).lips_l_corner_up==0,'still neutral after 56 s')
 for _=1,120 do tick(.1) end;assert(last(a).lips_l_corner_up>.1,'the resting smile is back '..last(a).lips_l_corner_up)
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
  -- No receipt: no smile while speaking (October 8: the idle smile releases into speech, none is added).
  local none=speak(${literal(line)},'none')
  assert(none.lips_l_corner_up<.02,none.lips_l_corner_up)
  -- A Trust scale-2 cue: the gentle smile (October 9: Trust .35, was .25; .35 x .67 x speech .85 = .20).
  local trust=speak(${literal(warm)},'trust')
  assert(trust.lips_l_corner_up>=.17 and trust.lips_l_corner_up<=.22,'trust '..trust.lips_l_corner_up)
  -- Interest lifts the brows only.
  local interest=speak(${literal(curious)},'interest')
  assert(interest.eye_l_brows_raise_out>=.05 and interest.eye_l_brows_raise_out<=.11 and interest.lips_l_corner_up<.02,'interest '..interest.eye_l_brows_raise_out..' '..interest.lips_l_corner_up)
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
 -- These cases step 0.1-0.3 s; production polls the mailbox once a second.
 if face.faceTest then face.faceTest.pollPeriod=.25 end
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
test('Judy idles at about .19 with the corner gain, a cold character stays flat, and a squint follows', () => run(`
 rows[1].profileKey='judy-alvarez';rows[2].profileKey='adam-smasher'
 for _=1,40 do tick(.1) end
 local judy,cold=last(a),last(b)
 assert(math.abs(judy.lips_l_corner_up-.192)<.005,'judy rests at .192: '..judy.lips_l_corner_up)
 assert(cold.lips_l_corner_up==0 and cold.eye_l_oculi_squint_outer_lower==0,'a cold face stays flat')
 assert(math.abs(judy.eye_l_oculi_squint_outer_lower-.115)<.005,'the squint follows the smile: '..judy.eye_l_oculi_squint_outer_lower)
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
  assert(warm.lips_l_corner_up<.02 and warm.eye_l_brows_raise_out>.03,'Interest = brows only '..warm.lips_l_corner_up)
  local plain=speak(${literal(none)},'x',a)
  assert(plain.lips_l_corner_up<.02,'no emotion, no smile '..plain.lips_l_corner_up)
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

// October 8 (user): Judy keeps her light smile while idle, but never on a sad topic: the Evelyn conversation is
// smile-free while she speaks and right after; the resting smile comes back once the mood has decayed (a minute
// of no conversation, or about 15 s after a later calm turn).
test('idle smile: present at rest, absent during and after the Evelyn reply, back after the mood decays', () => {
  const sadPlan = selectEmotion({player: 'How are you holding up since Evelyn died?', profile: 'judy-alvarez',
    reply: "She was beautiful, V. I loved her so much. Thanks for asking, really."});
  const calmPlan = selectEmotion({player: 'Where should we meet?', profile: 'judy-alvarez', reply: "Lizzie's, around nine."});
  const line = (id, plan) => attachExpressionTrack(trackLine(id, {expressionTrack: undefined}), plan);
  const sad = line('evelyn', sadPlan), calm = line('calm', calmPlan), again = line('evelyn-2', sadPlan);
  assert.equal(sad.expressionTrack.format, 'emotion-mix-v1');
  run(`rows[1].profileKey='judy-alvarez';speech.target=a
  local function idle(seconds) local peak=0;for _=1,math.floor(seconds*10+.5) do tick(.1);peak=math.max(peak,last(a).lips_l_corner_up) end;return peak end
  local function speak(id,timeline)
   local ctx={requestId=id,entity=a.id,generation=4}
   assert(speech.start(ctx,{text='Hello.',audio={slot=0,event='convai_reply_0',duration=3.5},face=timeline}),face.error)
   local late=0
   for i=1,34 do cursor=.1*i;tick(.1);if i>8 then late=math.max(late,last(a).lips_l_corner_up) end end
   speech.stop('finished');return late
  end
  idle(4);assert(math.abs(last(a).lips_l_corner_up-.192)<.01,'idle resting smile '..last(a).lips_l_corner_up)
  assert(speak('evelyn',${literal(sad)})<.01,'no smile while she talks about Evelyn')
  assert(idle(50)<.01,'no smile for the next 50 s')
  assert(idle(20)>.15,'the resting smile is back after about a minute')
  -- A later calm turn shortens the hold: smile back about 15 s after it, not a minute.
  assert(speak('evelyn-2',${literal(again)})<.01);assert(idle(5)<.01)
  speak('calm',${literal(calm)})
  assert(idle(8)<.01,'still neutral just after the calm turn')
  assert(idle(10)>.15,'back about 15 s after the calm turn '..last(a).lips_l_corner_up)
  `);
});

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

// ---- October 9: natural blinking through speech --------------------------------------------------------------
// The game's own dialogue lipsync carries a talking face's blinks on eye_l/r_blinkLipsyncPoseOutput (about 19 a
// minute in 800 extracted lines); our speech replaces that animation and the face graph's only other blink is the
// look-at controller's (on a gaze shift), so a companion holding eye contact never blinked while she spoke.
const seeded = value => `do local seed=${value}.0;face.blinkRandom=function() seed=(seed*16807.0)%2147483647.0;return seed/2147483647.0 end end`;
const flatLine = (id, source, duration, extra = {}) => ({version: 1, requestId: id, entity: 'copy-a', duration, source,
  ...(source === 'local-jali' ? {articulation: 'jali-audio-v1'} : {}),
  tracks: ['jaw_mid_open', 'lips_together_up', 'lips_together_dn', 'lips_l_funnel', 'lips_r_funnel', 'lips_l_purse', 'lips_r_purse'],
  frames: [[0, .3, 0, 0, 0, 0, 0, 0], [duration, .3, 0, 0, 0, 0, 0, 0]], ...extra});
const blinkHelpers = `
 local function onsets(frames,from,step)
  local out,previous={},0
  for i,f in ipairs(frames) do local v=f.eye_l_blink or 0;if v>.3 and previous<=.3 then out[#out+1]=from+(i-1)*step end;previous=v end
  return out
 end
`;

test('blinks continue through a reply on every voice route: every 2-6 s, short, symmetric, game-shaped', () => {
  for (const source of ['local-jali', 'convai-arkit61', 'local-phonetic', 'audio-envelope']) run(`${seeded(4242)}${blinkHelpers}
   speech.target=a
   local ctx={requestId='blink-${source}',entity=a.id,generation=4}
   assert(speech.start(ctx,{text='Hello.',audio={slot=0,event='convai_reply_0',duration=20},face=${literal(flatLine(`blink-${source}`, source, 20))}}),face.error)
   local frames={}
   for i=1,594 do cursor=i/30;tick(1/30);frames[#frames+1]=copy(last(a)) end
   local times=onsets(frames,1/30,1/30)
   assert(#times>=4 and #times<=11,'${source}: '..#times..' blinks in 20 s')
   assert(times[1]<2.6,'the first blink comes soon: '..times[1])
   for i=2,#times do local gap=times[i]-times[i-1];assert(gap>=.55 and gap<=6.3,'${source} gap '..gap) end
   local open,peak=0,0
   for _,f in ipairs(frames) do
    assert(f.eye_l_blink==f.eye_r_blink,'both eyes together')
    local v=f.eye_l_blink or 0;peak=math.max(peak,v);if v<.02 then open=open+1 end
    assert(f.jaw_mid_open==.3,'speech fields untouched')
   end
   assert(peak>=.6 and peak<=.96,'peak like the game (.62-.95): '..peak)
   assert(open/#frames>.85,'eyes open most of the time: '..open/#frames)
   speech.stop('finished')
  `);
});

// In-game follow-up (October 9): she did not blink at idle either. Every facial graph's only blinks are animations
// streamed into its FacialMixerSlot (scenes, workspots, dialogue lipsync) and that slot's look-at blinks, played on
// a gaze transition; an idle copy has neither, so this writer blinks for its own copies at all times.
test('blinks run at idle, listening and thinking too: every 2-6 s idle, a little more often while listening; a blocked face never blinks', () => run(`${seeded(77)}${blinkHelpers}
 local function gaps(times) local out={};for i=2,#times do out[#out+1]=times[i]-times[i-1] end;return out end
 local function mean(list) local sum=0;for _,v in ipairs(list) do sum=sum+v end;return sum/#list end
 local idle,listen={},{}
 for _=1,2700 do tick(1/30);idle[#idle+1]=copy(last(b)) end
 for _=1,2700 do tick(1/30,{listeningEntity=b.id});listen[#listen+1]=copy(last(b)) end
 local idleGaps,listenGaps=gaps(onsets(idle,0,1/30)),gaps(onsets(listen,0,1/30))
 assert(#idleGaps>=12 and #idleGaps<=40,'idle blinks in 90 s: '..(#idleGaps+1))
 for _,g in ipairs(idleGaps) do assert(g>=1.9 and g<=6.1,'idle gap '..g) end
 for _,g in ipairs(listenGaps) do assert(g>=1.7 and g<=5.3,'listening gap '..g) end
 assert(mean(listenGaps)<mean(idleGaps),'listening blinks more often: '..mean(listenGaps)..' vs '..mean(idleGaps))
 for _,f in ipairs(idle) do assert((f.eye_l_blink or 0)==(f.eye_r_blink or 0) and (f.eye_l_blink or 0)<=.96) end
 local frames={}
 for _=1,300 do tick(1/30,{thinkingEntity=a.id});frames[#frames+1]=copy(last(a)) end
 assert(#onsets(frames,0,1/30)>=2,'thinking blinks')
 -- Idle blinks stay on the eyelids: the resting expression is the same as without them.
 assert(last(b).lips_l_corner_up>0 and last(b).jaw_mid_open==nil,'idle expression and speech fields unchanged')
 -- Combat (or a native scene/dialogue, which streams its own blinks) suppresses every optional delta, blinks included.
 a.combat=true
 for _=1,300 do tick(1/30);assert(last(a).eye_l_blink==0,'blocked') end
 a.combat=false
`));

test('a phrase boundary now and then brings a blink, and a separate phrase never ends on a half-closed lid', () => {
  const spans = [0.3, 2, 4, 6].map((start, i, all) => ({start, end: all[i + 1] ?? 8, from: 0, to: 1, dominant: null, tags: [], top: [], anchored: true}));
  const track = {version: 1, format: 'emotion-mix-v1', families: ['joy', 'trust', 'sadness', 'anger', 'fear', 'disgust', 'surprise', 'anticipation'],
    keys: [[0, 0, 0, 0, 0, 0, 0, 0, 0], [8, 0, 0, 0, 0, 0, 0, 0, 0]], segments: spans};
  run(`${blinkHelpers}
   face.blinkRandom=function() return .1 end   -- every boundary is taken; rhythm 2.4 s
   speech.target=a
   local ctx={requestId='phrases',entity=a.id,generation=4}
   assert(speech.start(ctx,{text='Hello.',audio={slot=0,event='convai_reply_0',duration=8},face=${literal(flatLine('phrases', 'local-jali', 8, {expressionTrack: track}))}}),face.error)
   local frames={}
   for i=1,470 do cursor=i/60;tick(1/60);frames[#frames+1]=copy(last(a)) end
   local times=onsets(frames,1/60,1/60)
   -- The first blink comes from the rhythm (.6 + .16 s), then one just after each later phrase start (2, 4, 6 s).
   local function near(t) for _,x in ipairs(times) do if x>=t and x<=t+.15 then return true end end return false end
   assert(near(2) and near(4) and near(6),'boundary blinks: '..table.concat(times,','))
   assert(times[1]<1,'rhythm blink first: '..times[1])
   speech.stop('finished')
  `);
  // A phrase of a phrase-streamed reply (Omni) holds its last frame until the next phrase plays: a blink due in its
  // last .35 s waits and starts with the next phrase instead.
  run(`
   face.blinkRandom=function() return .1 end   -- the first blink is due .76 s after speech starts
   local ctx={requestId='omni',entity=a.id,generation=4}
   local first=${literal({...flatLine('omni', 'local-jali', 1), segment: {version: 1, index: 1, startSeconds: 0, first: true, last: false}})}
   local second=${literal({...flatLine('omni', 'local-jali', 1), segment: {version: 1, index: 2, startSeconds: 1, first: false, last: true}})}
   face.beginExpressionFrame(0,{actors=rows})
   assert(face.start(ctx,first,a,1,{index=1,startSeconds=0}),face.error)
   local peak=0
   for i=1,60 do face.beginExpressionFrame(1/60,{actors=rows});face.sync(a,i/60,'omni');peak=math.max(peak,last(a).eye_l_blink or 0) end
   assert(peak==0,'no blink starts in the phrase tail: '..peak)
   for _=1,12 do face.beginExpressionFrame(1/60,{actors=rows});face.hold(a,'omni') end
   assert(face.start(ctx,second,a,1,{index=2,startSeconds=1}),face.error)
   local started
   for i=1,30 do face.beginExpressionFrame(1/60,{actors=rows});face.sync(a,i/60,'omni');if not started and (last(a).eye_l_blink or 0)>0 then started=i/60 end end
   assert(started and started<=.05,'the waiting blink starts with the next phrase: '..tostring(started))
   face.stop(a,'finished')
  `);
});

// ---- October 9: expressions visible while speaking -----------------------------------------------------------
// The real selector plan, aligned to a mouth timeline (open jaw, no closures: the mouth budget is speech's 85 %),
// played through the real Lua writer; returns the peak of every written control while she speaks.
function peaksWhileSpeaking(profile, plan, id = 'range') {
  const line = attachExpressionTrack(flatLine(id, 'local-jali', 6), plan, {complete: true, decay: true});
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const status = lauxlib.luaL_dostring(vm, to_luastring(setup + `
     rows[1].profileKey=${JSON.stringify(profile)};speech.target=a
     local ctx={requestId=${JSON.stringify(id)},entity=a.id,generation=4}
     assert(speech.start(ctx,{text='Hello.',audio={slot=0,event='convai_reply_0',duration=6},face=${literal(line)}}),face.error)
     local peak={}
     for i=1,174 do cursor=i/30;tick(1/30);for k,v in pairs(last(a)) do if type(v)=='number' and v>(peak[k] or 0) then peak[k]=v end end end
     speech.stop('finished')
     local parts={};for k,v in pairs(peak) do parts[#parts+1]=string.format('%q:%.5f',k,v) end
     RESULT='{'..table.concat(parts,',')..'}'`));
    assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1)));
    lua.lua_getglobal(vm, to_luastring('RESULT'));
    return JSON.parse(to_jsstring(lua.lua_tostring(vm, -1)));
  } finally { lua.lua_close(vm); }
}
const tagged = (reply, ...tags) => tags.map(([word, name, strength]) => ({at: reply.indexOf(word), name, strength: strength ?? 'subtle'}));

// Minimum visible deltas per emotion with Expressive emotions on (one subtle tag) for Judy, a reserved manner with
// her corner gain: the Judy face-test calibration (a smile reads from about .15, clearly at .35-.5) and the game's
// own authored frown (corners .20 + brows .32). Before October 9 a subtle tag on Judy gave corners .07-.16 and
// brows .11-.16.
test('October 9: each tagged feeling moves Judy\'s brows, eyes and corners visibly while she speaks', () => {
  const cases = [
    ['sadness', "Every day. I keep thinking about that call.", {lips_l_corner_dn: .2, eye_l_brows_raise_in: .25}, ['lips_l_corner_up']],
    ['anger', "That greedy little rat. I'll make her pay.", {eye_l_brows_lower: .25, lips_l_corner_dn: .12}, ['lips_l_corner_up']],
    ['fear', "Are you okay? Stay close to me tonight.", {eye_l_brows_raise_in: .25, eye_l_brows_raise_out: .15}, ['lips_l_corner_up']],
    ['joy', "You're such a dork, V. Okay, okay, I'll admit it.", {lips_l_corner_up: .25, eye_l_oculi_squint_outer_lower: .15, eye_l_brows_raise_out: .1}, ['lips_l_corner_dn']],
    ['warm', "Anytime. Whatever you need, I'm here.", {lips_l_corner_up: .18, eye_l_oculi_squint_outer_lower: .1}, ['lips_l_corner_dn']],
    ['surprise', "Wait, you found her? After all this time?", {eye_l_brows_raise_out: .3, eye_l_brows_raise_in: .2}, []],
    ['disgust', "Corpo errands for a sleazy fixer. Real classy.", {eye_l_brows_lower: .18, lips_l_corner_dn: .12}, ['lips_l_corner_up']],
  ];
  for (const [name, reply, minimum, absent] of cases) {
    const plan = selectEmotion({player: 'Hey.', reply, profile: 'judy-alvarez', marks: tagged(reply, [reply.split(' ')[0], name])});
    const peak = peaksWhileSpeaking('judy-alvarez', plan, `judy-${name}`);
    for (const [track, value] of Object.entries(minimum)) assert.ok((peak[track] ?? 0) >= value, `${name} ${track} ${peak[track]} < ${value}`);
    for (const track of absent) assert.ok((peak[track] ?? 0) < .02, `${name} shows ${track} ${peak[track]}`);
    assert.ok((peak.lips_l_corner_up ?? 0) <= .65 && (peak.lips_l_corner_dn ?? 0) <= .65 && (peak.eye_l_brows_lower ?? 0) <= .55, `${name} within the caps`);
  }
  // A plain reply stays neutral: no feeling, no face (the voice-synced brows of the model are not in this line).
  const plain = selectEmotion({player: 'What are you working on?', reply: 'Just tweaking a braindance edit. The audio sync is off.', profile: 'judy-alvarez'});
  const rest = peaksWhileSpeaking('judy-alvarez', plain, 'judy-plain');
  for (const track of ['lips_l_corner_up', 'lips_l_corner_dn', 'eye_l_brows_raise_in', 'eye_l_brows_raise_out', 'eye_l_brows_lower'])
    assert.ok((rest[track] ?? 0) < .02, `plain reply ${track} ${rest[track]}`);
});

test('October 9: the face changes within a reply, the text can deepen a tagged feeling, and text cues read without tags', () => {
  // Two tags: a smile, then sadness. The corners cross from up to down within the reply.
  const reply = "Haha, you remembered. But she never got to see this place.";
  const turn = selectEmotion({player: 'I brought the photos.', reply, profile: 'judy-alvarez',
    marks: tagged(reply, ['Haha', 'joy'], ['But', 'sadness'])});
  assert.ok(turn.segments[0].weights.joy > .4 && turn.segments.at(-1).weights.sadness > .4);
  assert.ok(!turn.segments.at(-1).weights.joy, 'the sad phrase has no smile under it');
  // One subtle {sadness} tag over a reply whose last phrase is the saddest: that phrase is stronger.
  const regret = "Every damn day. I walked out on her. Too late now.";
  const held = selectEmotion({player: 'Do you regret what happened with Alt?', reply: regret, profile: 'johnny-silverhand',
    marks: tagged(regret, ['Every', 'sadness'])});
  const weights = held.segments.map(segment => segment.weights.sadness ?? 0);
  assert.ok(Math.max(...weights) > Math.min(...weights) + .15, `the text deepens the tag: ${weights}`);
  // Without tags, the text alone: a strong phrase on Judy clears the visible minimum.
  const angry = selectEmotion({player: 'Maiko sold us out.', reply: "That greedy little rat. I swear, I'll make her pay for this.", profile: 'judy-alvarez'});
  const peak = peaksWhileSpeaking('judy-alvarez', angry, 'judy-angry-text');
  assert.ok(peak.eye_l_brows_lower >= .3 && peak.lips_l_corner_dn >= .15, `text anger ${peak.eye_l_brows_lower} ${peak.lips_l_corner_dn}`);
});

test('October 9: Johnny stays more reserved than Panam on the same words, but is not frozen', () => {
  for (const [name, reply, track] of [['anger', "Those bastards. I'll find them and make them pay.", 'eye_l_brows_lower'],
    ['sadness', "Yeah. Every single day. I wish he could see this.", 'eye_l_brows_raise_in'],
    ['joy', "Hell yeah! That's preem news, choom.", 'lips_l_corner_up']]) {
    for (const strength of ['subtle', 'strong']) {
      const marks = tagged(reply, [reply.split(' ')[0], name, strength]);
      const johnny = peaksWhileSpeaking('johnny-silverhand', selectEmotion({reply, profile: 'johnny-silverhand', marks}), 'johnny');
      const panam = peaksWhileSpeaking('panam-palmer', selectEmotion({reply, profile: 'panam-palmer', marks}), 'panam');
      assert.ok(johnny[track] < panam[track], `${name}/${strength}: Johnny ${johnny[track]} vs Panam ${panam[track]}`);
      assert.ok(johnny[track] >= .6 * panam[track] && johnny[track] >= .15, `${name}/${strength}: Johnny is not frozen ${johnny[track]}`);
    }
  }
});

test('October 9: grief still never smiles through the writer, with or without a tag, and still looks sad', () => {
  const player = 'How are you holding up since Evelyn died?';
  const reply = "She was beautiful, V. I loved her so much. Thanks for asking, really, I'm glad you're here.";
  for (const marks of [undefined, tagged(reply, ['She', 'sadness'])]) {
    const peak = peaksWhileSpeaking('judy-alvarez', selectEmotion({player, reply, profile: 'judy-alvarez', marks}), 'evelyn-range');
    assert.ok((peak.lips_l_corner_up ?? 0) < .02, `grief smiles ${peak.lips_l_corner_up}`);
    assert.ok((peak.eye_l_oculi_squint_outer_lower ?? 0) < .02, 'no smiling eyes either');
    assert.ok(peak.lips_l_corner_dn >= .15 && peak.eye_l_brows_raise_in >= .2, `grief reads sad ${peak.lips_l_corner_dn} ${peak.eye_l_brows_raise_in}`);
  }
});
