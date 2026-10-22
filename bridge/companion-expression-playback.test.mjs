import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {buildFacialTimeline, buildProviderFacialTimeline, SPEECH_TRACKS} from './facial-timeline.mjs';
import {expressionTarget, ExpressionSmoother, ownedExpressionReceipt} from './companion-expressions.mjs';
import {silentWav} from './speech-audio.mjs';
import {selectEmotion, settleCarriedFeelings} from './emotion-selector.mjs';
import {attachExpressionTrack} from './expression-timeline.mjs';
import {planRange} from './emotion-analysis.mjs';

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
-- The voice is the continuous renderer: a fake controller reports the heard position (the test's cursor) and the reply's
-- face timeline as a continuous revision, exactly the state the real adapter (mod/continuous-speech.lua) hands speech.lua.
local live
local controller={version=1,available=true,start=function() return true end,stop=function() end,pause=function() return true end,
 status=function() return {} end,
 update=function(_,_,_,isPaused)
  if not live then return nil end
  local duration=live.duration
  local ended=live.complete and cursor>=duration and not isPaused
  return {position=cursor,bufferedDuration=duration,text=live.text,textComplete=live.complete,
   state=ended and 'ended' or 'playing',complete=live.complete,ended=ended,face=live.face,faceDuration=duration,
   expression=live.expression}
 end}
dofile=function(path) if path=='facial-playback.lua' then return face end;if path=='continuous-speech.lua' then return controller end;return captions end
local speech=(function() ${speechSource} end)();speech.available=true
-- Start a continuous reply whose face is the given timeline (the same document a native reply used to carry): the heard position
-- is the test's cursor, chased by speech.lua with at most 80 ms of lag. options.complete=false keeps the reply open-ended.
local function say(ctx,timeline,options)
 options=options or {}
 local line=copy(timeline);line.continuous=true;line.complete=options.complete~=false
 line.requestId,line.entity,line.generation=ctx.requestId,ctx.entity,ctx.generation
 live={duration=line.duration,text=options.text or 'Hello.',complete=line.complete,face=line,expression=options.stateExpression}
 return speech.start(ctx,{text=options.text or 'Hello.',continuous={version=1,id=ctx.requestId..'-voice'},expression=options.expression})
end
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

test('a holocall live-picture copy (not a party member) gets the same idle face while the holocall claims it',()=>run(`
 local holo=actor('holo-copy');holo.owned=false
 local holoRows={{entity=holo.id,npc=holo,profileKey='judy-alvarez'}}
 tick(.1,{actors=holoRows});assert(#holo.frames==0,'an unowned copy gets no idle face')
 local claimed=true
 convaiHolocall={ownsFace=function(actor) return claimed and actor==holo end}
 tick(.1,{actors=holoRows});assert(#holo.frames==1 and last(holo).lips_l_corner_up>0,'the resting smile')
 claimed=false;tick(.1,{actors=holoRows});assert(#holo.frames==1 and face.expressions[holo.id]==nil,'released with the picture')
 convaiHolocall=nil
`));

test('Lua expression policy matches the pure policy and stops its clock while paused',()=>{
  const smoother=new ExpressionSmoother();const expected=smoother.update(expressionTarget(),.1);
  run(`tick(.1);local expected=${literal(expected)};for key,value in pairs(expected) do assert(math.abs(last(a)[key]-value)<1e-12,key) end
  local clock=face.expressionClock;paused=true;tick(10);assert(face.expressionClock==clock and #a.frames==1)
  paused=false;tick(.1);assert(face.expressionClock>clock and #a.frames==2)`);
});

// October 9 (user): "her current emotion during idle becomes bland before the lip sync starts playing". Listening
// and thinking keep the idle face (resting smile, a lingering reaction); only the next reply's audio changes it.
test('new thinking or listening input keeps the idle face and a lingering reaction until the next reply is heard',()=>run(`
 face.beginExpression(context,${literal(receipt('Joy',3,0))});face.expressionHeard(context);face.endExpression(context,true);for _=1,15 do tick(.1) end
 local joy=last(a).lips_l_corner_up;assert(joy>.3,'the happy reaction lingers: '..joy)
 tick(.1,{thinkingEntity=a.id,thinkingRequestId='next-input'})
 assert(math.abs(last(a).lips_l_corner_up-joy)<.02 and face.expressions[a.id].emotion=='Joy','thinking keeps it')
 tick(.1,{listeningEntity=a.id});assert(math.abs(last(a).lips_l_corner_up-joy)<.02,'listening keeps it')
 -- After the reaction expires the resting smile shows while listening or thinking, as at idle.
 for _=1,60 do tick(.1,{listeningEntity=a.id}) end
 assert(math.abs(last(a).lips_l_corner_up-.12)<.01,'resting smile while listening: '..last(a).lips_l_corner_up)
 for _=1,10 do tick(.1,{thinkingEntity=a.id,thinkingRequestId='later'}) end
 assert(math.abs(last(a).lips_l_corner_up-.12)<.01,'resting smile while thinking')
`));

test('combat, injury, native dialogue and lost autonomy immediately suppress all optional expression deltas',()=>run(`
 local joys={${[1, 2, 3, 4].map(i => literal(receipt('Joy', 3, i))).join(',')}}
 for i,flag in ipairs({'combat','injured','dialogue','scene'}) do
  face.beginExpression(context,joys[i]);face.expressionHeard(context);a[flag]=false;tick(.1);assert(last(a).lips_l_corner_up>0,flag)
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
  const at=line.frames.find(frame=>Math.abs(frame[0]-.45)<1e-9);
  const expected=Object.fromEntries(SPEECH_TRACKS.map((track,i)=>[track,at[i+1]]));
  run(`tick(.1);speech.target=a
  assert(say(context,${literal(line)}))
  -- The closure holds for a while (the A cue, .45 s of it): the smile has had its release time by cursor .45.
  local count,bcount=#a.frames,#b.frames;cursor=.05;tick(.1)
  for i=1,24 do cursor=i==24 and .45 or .05+i/60;tick(1/60) end
  assert(#a.frames-count==#b.frames-bcount,'one write per tick on each copy')
  local expected=${literal(expected)};for key,value in pairs(expected) do assert(last(a)[key]==value,key) end
  assert(last(a).lips_l_corner_up==0 and last(a).lips_together_up==.85)
  assert(last(a).eye_l_brows_raise_out>0)
  speech.stop('cancelled');tick(.1);assert(last(a).eye_l_brows_raise_out==0)
  `);
});

test('the final native writer suppresses a held smile on rounded phonemes without touching speech fields',()=>run(`
 face.beginExpression(context,${literal(receipt('Joy',3,0))});face.expressionHeard(context);tick(.1)
 assert(last(a).lips_l_corner_up>0)
 local before=last(a).lips_l_corner_up
 local timeline={version=1,requestId=context.requestId,entity=a.id,duration=1,source='audio-envelope',
  tracks={'jaw_mid_open','lips_l_funnel','lips_r_funnel','lips_suck_up'},
  frames={{0,.27123,.32,.32,.05342},{1,.27123,.32,.32,.05342}}}
 assert(face.start(context,timeline,a,1));face.beginExpressionFrame(.1,{actors=rows});face.sync(a,.3,context.requestId)
 -- Rounded lips take the smile away over a few frames (a held rounding leaves none), never in one jump.
 local first=last(a).lips_l_corner_up
 for i=1,25 do face.beginExpressionFrame(1/60,{actors=rows});face.sync(a,.3+i/60,context.requestId) end
 assert(first>0 and first<before,'the first rounded frame starts taking it away, not all at once: '..first..' of '..before)
 assert(last(a).lips_l_corner_up==0 and last(a).lips_r_corner_up==0)
 assert(last(a).jaw_mid_open==.27123 and last(a).lips_l_funnel==.32 and last(a).lips_suck_up==.05342)
`));

test('negative metadata replaces a smile, rejects cross-copy/generation/sequence receipts and expires after speech',()=>run(`
 face.beginExpression(context,${literal(receipt('Joy',3,0))});face.expressionHeard(context);tick(.1)
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
  run(`speech.target=a;assert(say(context,${literal(line)}))
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
   assert(say(ctx,timeline))
   for i=1,12 do cursor=.2+.03*i;tick(.1) end
   local frame=last(a);speech.stop('cancelled');for _=1,12 do tick(.1) end;return frame
  end
  -- No receipt: no smile while speaking (October 8: the idle smile releases into speech, none is added).
  local none=speak(${literal(line)},'none')
  assert(none.lips_l_corner_up<.02,none.lips_l_corner_up)
  -- A Trust scale-2 cue: the gentle smile (October 9: Trust .35, was .25; .35 x .67 x smile multiplier 1.65 x speech .85 = .33; was 1.3 and .26 before the smile and surprise round).
  local trust=speak(${literal(warm)},'trust')
  assert(trust.lips_l_corner_up>=.29 and trust.lips_l_corner_up<=.37,'trust '..trust.lips_l_corner_up)
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
  assert(say(context,${literal(line)}))
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
  // The closure and the rounding are held long enough (.5 s and .9 s) for the mouth factors to have settled: they take
  // the mouth emotion away over a few frames (no snap), and a held closure or rounding leaves none.
  const timelineFor = id => ({version: 1, requestId: id, entity: 'copy-a', duration: 2, source: 'audio-envelope',
    tracks: speechTracks, frames: [
      [0, .30, 0, 0, 0, 0, 0, 0, 0], [.5, .30, 0, 0, 0, 0, 0, 0, 0],
      [.55, .10, .85, .85, 0, 0, 0, 0, 0], [1, .10, .85, .85, 0, 0, 0, 0, 0],
      [1.05, .20, 0, 0, .32, .32, .28, .28, .05], [2, .20, 0, 0, .32, .32, .28, .28, .05]]});
  const scenarios = [[null, 0], ...emotions].map(([label, scale], index) => ({id: `mouth-${index}`, label: label ?? 'none',
    receipt: label ? ownedExpressionReceipt(signal(label, scale, 0), {...owner, requestId: `mouth-${index}`}) : undefined}));
  run(`
   local function play(id,receipt,timeline)
    local ctx={requestId=id,entity=a.id,generation=4}
    if receipt then face.beginExpression(ctx,receipt) end
    assert(face.start(ctx,timeline,a,2),face.error)
    local out={}
    -- Saturate the smoothed expression on open-mouth speech, then hit the
    -- contact and rounding frames with it fully present.
    for i=1,14 do face.beginExpressionFrame(.1,{actors=rows});face.sync(a,.2+i*.01,id) end
    out.open=copy(last(a))
    face.beginExpressionFrame(.1,{actors=rows});face.sync(a,.6,id);out.first=copy(last(a))
    for i=1,24 do face.beginExpressionFrame(1/60,{actors=rows});face.sync(a,.6+i/60,id) end
    out.closure=copy(last(a))
    for i=1,54 do face.beginExpressionFrame(1/60,{actors=rows});face.sync(a,1.06+i/60,id) end
    out.round=copy(last(a))
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
   probeLoad=function() return (function() ${probeSource} end)() end
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

// October 9, scripted talk test: `say` submits V's line to a present character through the speech adapter's dev hook (the
// composer's real path), and `face-trace` keeps a bounded ring of what the writer actually WROTE per frame.
test('face-test probe: say submits through the speech adapter hook, face-trace records the written jaw in a bounded ring and dumps once', () => runProbe(`
 local said
 convaiSpeech=convaiSpeech or {}
 convaiSpeech.devSay=function(who,npc,text) said={npc=npc,text=text,player=who};return true,'req-1' end
 request('s1\\nsay judy hello there V');tick(.3)
 assert(said and said.npc==a and said.text=='hello there V' and said.player==player,'the line reaches the adapter hook')
 assert(files['runtime/face-test-response.txt']:find('ok=true',1,true) and files['runtime/face-test-response.txt']:find('req-1',1,true))
 convaiSpeech.devSay=function() return false,'developer mode is off' end
 request('s2\\nsay judy nope');tick(.3)
 assert(files['runtime/face-test-response.txt']:find('ok=false',1,true) and files['runtime/face-test-response.txt']:find('developer mode',1,true))
 request('s3\\nsay nobody hi');tick(.3);assert(files['runtime/face-test-response.txt']:find('ok=false',1,true))
 function a:ConvaiFaceStatus() return 'prepared:woman_average_sermo' end
 rows[1].profileKey='evelyn-parker';face.beginExpressionFrame(.1,{actors=rows});face.updateExpressions({actors=rows})
 request('t1\\nface-trace on evelyn');tick(.3)
 assert(files['runtime/face-test-response.txt']:find('ok=true',1,true) and face.faceTest.trace,'trace is on')
 local timeline={version=1,requestId=context.requestId,entity=a.id,duration=100,source='local-jali',articulation='jali-audio-v1',
  tracks={'jaw_mid_open','lips_together_up'},frames={{0,.12,0},{100,.12,.4}}}
 face.beginExpressionFrame(.1,{actors=rows})
 assert(face.start(context,timeline,a,100))
 local position=0
 for _=1,3700 do face.beginExpressionFrame(.02,{actors=rows});position=position+.02;face.sync(a,position,context.requestId) end
 local ring=face.faceTest.trace
 assert(ring.n>=3600 and #ring.clock==3600 and #ring.jaw_mid_open==3600,'the ring is preallocated at its bound and never grows: '..ring.n..' '..#ring.clock)
 local at=(ring.n-1)%3600+1
 assert(math.abs(ring.jaw_mid_open[at]-last(a).jaw_mid_open)<1e-9 and ring.jaw_mid_open[at]>.13,'it records the value the writer wrote')
 files['runtime/face-trace.json']=nil
 request('t2\\nface-trace dump lipcase');tick(.3)
 assert(files['runtime/lipcase.json'] and files['runtime/lipcase.json']:find('rows',1,true),'one dump file')
 assert(files['runtime/face-test-response.txt']:find('rows=3600',1,true),files['runtime/face-test-response.txt'])
 request('t3\\nface-trace off');tick(.3);assert(face.faceTest.trace==nil)
 local before=ring.n;face.beginExpressionFrame(.02,{actors=rows});position=position+.02;face.sync(a,position,context.requestId)
 assert(ring.n==before,'nothing is recorded once it is off')
`));

// face-stage (mod/face-test.lua): a companion is put .85 m in front of V's camera facing it with an AI teleport command (a
// transform teleport is undone by her locomotion), only while she is off the spot, for the hold; the character is
// invited through the party queue when absent, and dismissed on request (only probe-invited characters).
test('face-stage probe: reuses a present copy, invites a missing one, places it in front of the camera facing it, releases and dismisses', () => runProbe(`
 local moves={}
 local plain=NewObject
 NewObject=function(name) if name=='AITeleportCommand' or name=='AIHoldPositionCommand' then return {} end;return plain(name) end
 local holds=0
 -- A copy answers its AI controller: a teleport command moves it exactly to the commanded spot and yaw.
 local function body(npc,x,y,z,yaw,graph)
  npc.where={x=x,y=y,z=z};npc.yaw=yaw
  function npc:ConvaiFaceStatus() return graph or 'prepared:woman_average_sermo' end
  function npc:GetWorldPosition() return self.where end
  function npc:GetWorldYaw() return self.yaw end
  function npc:GetAIControllerComponent() return {SendCommand=function(_,command)
   if not command.position then holds=holds+1;return true end
   moves[#moves+1]={npc=npc,position=command.position,yaw=command.rotation}
   npc.where={x=command.position.x,y=command.position.y,z=command.position.z};npc.yaw=command.rotation;return true end} end
 end
 body(a,12,19,5,-30);body(b,0,0,0,0)
 Vector4={new=function(x,y,z,w) return {x=x,y=y,z=z,w=w} end}
 Game.GetTargetingSystem=function() return {GetCrosshairData=function() return {x=10,y=20,z=6.7},{x=0,y=1,z=-.1} end} end
 function player:GetWorldPosition() return {x=10,y=20,z=5} end
 local spawned,dismissed,live,inviteExtra,dismissQuiet
 convaiCompanions.list=function() return {} end
 convaiManager={party=function() return {
  invite=function(key,extra) spawned=key;inviteExtra=extra;live={{id='live:7',key=key}};return true,'preparing','queued:1' end,
  list=function() return live or {} end,
  dismiss=function(id,quiet) dismissed=id;dismissQuiet=quiet;return true,'leaving' end} end}
 a.serial=7;if rows[1] then rows[1].serial=7 end
 -- A present copy is reused: no invitation, placed in front of the camera, facing it.
 request('s1\\nface-stage judy 10');tick(.3)
 assert(files['runtime/face-test-response.txt']:find('ok=true',1,true) and spawned==nil,files['runtime/face-test-response.txt'])
 for _=1,10 do tick(.1) end
 assert(convaiCompanions.devQuiet and convaiCompanions.devQuiet[7],'the staged copy is silenced for the companion update')
 assert(#moves==1,'one AI teleport, then she stays: '..#moves)
 assert(holds==1 or holds==2,'told to hold position, re-sent only every 5 s: '..holds)
 local m=moves[#moves]
 assert(m.npc==a and math.abs(m.position.x-10)<1e-6 and math.abs(m.position.y-20.85)<1e-6 and m.position.z==5,'in front, on V s floor')
 assert(math.abs(m.yaw-180)<1e-6,'facing the camera: '..m.yaw)
 -- Her own movement drags her off: she is put back, at most every .25 s.
 a.where={x=12,y=22,z=5};for _=1,4 do tick(.1) end
 assert(#moves==2,'put back once she is off the spot: '..#moves)
 -- off stops the hold.
 request('s2\\nface-stage off');tick(.3);local count=#moves
 assert(convaiCompanions.devQuiet==nil,'off gives the copy back to the companion update')
 a.where={x=12,y=22,z=5};for _=1,10 do tick(.1) end
 assert(#moves==count,'no command after off')
 -- An absent character is invited through the party queue, waited for, then staged and later dismissed.
 rows={{entity=a.id,npc=a,profileKey='judy-alvarez',name='Judy'}}
 request('s3\\nface-stage evelyn-parker 5');tick(.3)
 assert(spawned=='evelyn-parker')
 count=#moves;for _=1,5 do tick(.1) end;assert(#moves==count,'nothing is placed before the copy is ready')
 local c=actor('copy-c');body(c,0,0,5,0);rows[#rows+1]={entity=c.id,npc=c,profileKey='evelyn-parker',name='Evelyn Parker'}
 for _=1,5 do tick(.1) end
 assert(moves[#moves].npc==c,'the new copy is staged')
 request('s4\\nface-stage dismiss');tick(.3)
 assert(dismissed=='live:7','dismisses what the probe invited')
 assert(dismissQuiet==true and inviteExtra and inviteExtra.quiet==true,'probe invitations and dismissals are quiet (no player notices)')
 -- The next character waits until the dismissed copy is really gone (never two on one spot), then is placed.
 count=#moves
 request('s4b\\nface-stage judy 10');tick(.3);for _=1,10 do tick(.1) end
 assert(#moves==count,'nothing is placed while the dismissed copy still stands: '..#moves)
 a.where={x=12,y=22,z=5};table.remove(rows)
 for _=1,10 do tick(.1) end
 assert(moves[#moves].npc==a and #moves>count,'once it is gone the next character is staged')
 -- Another owned companion on the spot: she is placed to the side instead, never on it.
 local other=actor('other');body(other,10,20.85,5,0);rows[#rows+1]={entity=other.id,npc=other,profileKey='someone-else',name='Someone'}
 request('s4c\\nface-stage judy 10');tick(.3);for _=1,10 do tick(.1) end
 local sidestep=moves[#moves].position
 assert(math.abs(sidestep.x-9.2)<1e-6 and math.abs(sidestep.y-20.85)<1e-6,'placed beside the occupied spot: '..sidestep.x..','..sidestep.y)
 table.remove(rows)
 request('s5\\nface-stage judy 10');tick(.3);dismissed=nil;request('s6\\nface-stage dismiss');tick(.3)
 assert(dismissed==nil,'never a character that was already there')
`));

// October 9 incident: a big body staged .55 m in front of V pushed V, the hold re-derived the spot from V's live camera,
// and both drifted until V fell through the floor. The spot is now fixed once (anchor), big bodies keep their distance,
// the stage aborts when V moves, and a stale request in the file is never run by a freshly loaded probe.
const stageBody = `
 local moves={}
 local plain=NewObject
 NewObject=function(name) if name=='AITeleportCommand' or name=='AIHoldPositionCommand' then return {} end;return plain(name) end
 local function body(npc,x,y,z,yaw,graph)
  npc.where={x=x,y=y,z=z};npc.yaw=yaw
  function npc:ConvaiFaceStatus() if graph=='throw' then error('no status') end;return graph or 'prepared:woman_average_sermo' end
  function npc:GetWorldPosition() return self.where end
  function npc:GetWorldYaw() return self.yaw end
  function npc:GetAIControllerComponent() return {SendCommand=function(_,command)
   if not command.position then return true end
   moves[#moves+1]={npc=npc,position=command.position,yaw=command.rotation}
   npc.where={x=command.position.x,y=command.position.y,z=command.position.z};npc.yaw=command.rotation;return true end} end
 end
 Vector4={new=function(x,y,z,w) return {x=x,y=y,z=z,w=w} end}
 local forward={x=0,y=1,z=-.1}
 Game.GetTargetingSystem=function() return {GetCrosshairData=function() return {x=10,y=20,z=6.7},forward end} end
 local playerAt={x=10,y=20,z=5}
 function player:GetWorldPosition() return playerAt end
 convaiCompanions.list=function() return {} end
 convaiManager={party=function() return {invite=function() return false,'no' end,list=function() return {} end,dismiss=function() return true end} end}
 a.serial=7;rows[1].serial=7
`;
test('face-stage probe: the spot is anchored once; a later camera turn or a push on V never moves it', () => runProbe(stageBody + `
 body(a,12,19,5,-30)
 request('a1\\nface-stage judy 10');tick(.3);for _=1,10 do tick(.1) end
 local first=moves[#moves];assert(first and math.abs(first.position.y-20.85)<1e-6,'placed .85 m ahead')
 -- V turns the camera (and is pushed .2 m, below the abort limit): the held spot does not follow.
 forward={x=1,y=0,z=0};playerAt={x=10,y=19.8,z=5}
 a.where={x=12,y=22,z=5};for _=1,6 do tick(.1) end
 local last=moves[#moves];assert(#moves>=2)
 assert(math.abs(last.position.x-10)<1e-6 and math.abs(last.position.y-20.85)<1e-6 and math.abs(last.yaw-180)<1e-6,
  'put back on the ORIGINAL spot, not one derived from the new camera: '..last.position.x..','..last.position.y)
`));

test('face-stage probe: the stage aborts when V moves, with no further placement and the kill switch off', () => runProbe(stageBody + `
 body(a,12,19,5,-30)
 request('b1\\nface-stage judy 30');tick(.3);for _=1,10 do tick(.1) end
 assert(convaiCompanions.devQuiet and convaiCompanions.devQuiet[7])
 local before=#moves
 playerAt={x=10.2,y=20.2,z=5} -- .28 m: still inside the limit
 a.where={x=12,y=22,z=5};for _=1,6 do tick(.1) end
 assert(#moves>before,'a small push on V keeps the hold')
 playerAt={x=10.4,y=20.4,z=5} -- .57 m: V is being moved
 for _=1,3 do tick(.1) end
 local count=#moves
 a.where={x=12,y=22,z=5};for _=1,20 do tick(.1) end
 assert(#moves==count,'no placement after the abort: '..#moves..' vs '..count)
 assert(convaiCompanions.devQuiet==nil,'the abort gives the copy back to the companion update')
 request('b2\\nface-stage status');tick(.3)
 local response=files['runtime/face-test-response.txt']
 assert(response:find('state=failed',1,true) and response:find('V moved',1,true),response)
 -- Falling or being lifted counts too.
 request('b3\\nface-stage judy 30');tick(.3);playerAt={x=10,y=20,z=5};for _=1,6 do tick(.1) end
 playerAt={x=10,y=20,z=4.2};for _=1,3 do tick(.1) end
 request('b4\\nface-stage status');tick(.3)
 assert(files['runtime/face-test-response.txt']:find('state=failed',1,true),files['runtime/face-test-response.txt'])
`));

test('face-stage probe: a big or unreadable body is never closer than 1.3 m, an ordinary one stays at .85 m, distance cannot go closer', () => runProbe(stageBody + `
 body(a,12,19,5,-30,'prepared:man_big_sermo')
 request('c1\\nface-stage judy 10');tick(.3);for _=1,10 do tick(.1) end
 assert(math.abs(moves[#moves].position.y-21.3)<1e-6,'man_big stands 1.3 m ahead: '..moves[#moves].position.y)
 request('c2\\nface-stage off');tick(.3)
 body(a,12,19,5,-30,'prepared:man_fat_sermo');moves={}
 request('c3\\nface-stage judy 10');tick(.3);for _=1,10 do tick(.1) end
 assert(math.abs(moves[#moves].position.y-21.3)<1e-6,'man_fat too')
 request('c4\\nface-stage off');tick(.3)
 body(a,12,19,5,-30,'throw');moves={}
 request('c5\\nface-stage judy 10');tick(.3);for _=1,10 do tick(.1) end
 assert(math.abs(moves[#moves].position.y-21.3)<1e-6,'an unreadable graph counts as big')
 request('c6\\nface-stage off');tick(.3)
 body(a,12,19,5,-30);moves={}
 request('c7\\nface-stage distance .4');tick(.3)
 assert(files['runtime/face-test-response.txt']:find('distance=.85',1,true) or files['runtime/face-test-response.txt']:find('distance=0.85',1,true),files['runtime/face-test-response.txt'])
 request('c8\\nface-stage judy 10');tick(.3);for _=1,10 do tick(.1) end
 assert(math.abs(moves[#moves].position.y-20.85)<1e-6,'an ordinary body at .85 m: '..moves[#moves].position.y)
 request('c9\\nface-stage off');tick(.3)
 request('c10\\nface-stage distance 1.1');tick(.3)
 request('c11\\nface-stage judy 10');tick(.3);for _=1,10 do tick(.1) end
 assert(math.abs(moves[#moves].position.y-21.1)<1e-6,'a chosen larger distance is kept: '..moves[#moves].position.y)
`));

test('face-stage probe: a freshly loaded probe never runs the stale request left in the file', () => runProbe(stageBody + `
 body(a,12,19,5,-30)
 -- A request from before a reload sits in the file; the probe module is loaded again (CET reload, save load).
 files['runtime/face-test-request.txt']='old-1\\nface-stage judy 30'
 convaiFaceTest.primed=nil;convaiFaceTest.lastNonce=nil;convaiFaceTest.stage=nil
 probeLoad()
 local before=#moves
 for _=1,20 do tick(.1) end
 assert(#moves==before and not convaiFaceTest.stage,'the old request was not run')
 request('old-2\\nface-stage judy 30');tick(.3);for _=1,10 do tick(.1) end
 assert(#moves>before and convaiFaceTest.stage,'a new request after the reload still runs')
`));

// October 9, lip sync on wider lips: the jaw weight was lifted per head type (the facial graph name), the identity at the
// validation ceiling and at zero, never for Judy's graph or a head whose graph is unknown.
// October 15: the lift was fitted before speech_owner handed the idle mouth over, so it now applies only to a graph without
// that input (an older archive). A model (local-jali) timeline is scaled towards the game's reach first (modelReach).
const HEADS = {woman_average: {q: 2, floor: .21}, man_average: {q: 1.5, floor: .17}, man_big: {q: 1.5, floor: .17}, man_fat: {q: 1.5, floor: .17}};
const REACH = {jaw_mid_open: 1.15, lips_l_purse: 1.35, lips_r_purse: 1.35, lips_l_corner_stretch: 1.45, lips_r_corner_stretch: 1.45,
  lips_l_stretch: 1.45, lips_r_stretch: 1.45, lips_l_lower_raise: 1.3, lips_r_lower_raise: 1.3, lips_l_upper_raise: 1.4, lips_r_upper_raise: 1.4};
const reachJaw = value => Math.min(value * REACH.jaw_mid_open, .7);
const liftJaw = (value, {q, floor}) => {
  const rest = 1 - value / .7, lifted = rest > 0 ? .7 * (1 - rest ** q) : .7, x = Math.min(1, (value - .02) / .05);
  return x <= 0 ? lifted : Math.max(lifted, floor * x * x * (3 - 2 * x));
};
// A face graph from before October 10: the feature has no speech_owner field (reading or writing it raises).
const OLD_GRAPH = `NewObject=function(name) assert(name=='ConvaiFaceFeature')
 return setmetatable({},{__index=function(_,k) if k=='speech_owner' then error('no speech_owner') end end,
  __newindex=function(t,k,v) if k=='speech_owner' then error('no speech_owner') end;rawset(t,k,v) end}) end`;
const jawBody = (status, jaw, check, extra = '') => `
 ${status === undefined ? '' : `function a:ConvaiFaceStatus() return ${JSON.stringify(status)} end`}
 ${extra}
 face.beginExpressionFrame(.1,{actors=rows})
 local timeline={version=1,requestId=context.requestId,entity=a.id,duration=1,source='local-jali',articulation='jali-audio-v1',
  tracks={'jaw_mid_open','lips_together_up'},frames={{0,${jaw},0},{1,${jaw},0}}}
 assert(face.start(context,timeline,a,1));face.beginExpressionFrame(.1,{actors=rows});face.sync(a,.3,context.requestId)
 local jawValue=last(a).jaw_mid_open
 ${check}`;
test('jaw lift: on a graph without speech_owner, woman_average opens low and mid jaw values (q 2), man heads moderately (q 1.5)', () => {
  for (const [graph, head] of Object.entries(HEADS)) {
    for (const jaw of [0, .0381, .06, .12, .2, .37, .66, .7]) {
      const want = liftJaw(reachJaw(jaw), head);
      run(jawBody(`prepared:${graph}_sermo`, jaw, `assert(math.abs(jawValue-${want})<1e-9,'${graph} ${jaw}: '..jawValue)`, OLD_GRAPH));
    }
  }
  assert.ok(liftJaw(.12, HEADS.woman_average) > .21 && liftJaw(.12, HEADS.woman_average) < .23
    && liftJaw(0, HEADS.woman_average) === 0 && liftJaw(.7, HEADS.woman_average) === .7);
});
test('jaw lift: with speech_owner (every prepared graph since October 10) every head writes the model jaw at its reach, unlifted', () => {
  for (const graph of [...Object.keys(HEADS), 'player_woman_photomode']) {
    for (const jaw of [0, .015, .06, .088, .12, .2, .37, .66, .7]) {
      run(jawBody(`prepared:${graph}_sermo`, jaw, `assert(math.abs(jawValue-${reachJaw(jaw)})<1e-9,'${graph} ${jaw}: '..jawValue)`));
    }
  }
});
// October 9, second round (Evelyn, "and fill it with exactly what they need to hear"): the model's jaw for f, th, l, w and
// a short i is .088-.111, which the curve alone writes at .17-.20, the edge where her lips part. On a graph without
// speech_owner a speaking frame is written at the floor or above, silence is untouched, and the map never dips.
test('jaw lift: low-jaw sounds in speech reach the floor, silence stays closed, and the map never dips', () => {
  const fillItWith = [.088, .096, .111, .099, .106];
  for (const jaw of fillItWith) {
    assert.ok(liftJaw(jaw, HEADS.woman_average) >= .21, `${jaw}: ${liftJaw(jaw, HEADS.woman_average)}`);
    run(jawBody('prepared:woman_average_sermo', jaw, `assert(jawValue>=.21 and jawValue<.3,'fill it with '..jawValue)`, OLD_GRAPH));
  }
  for (const head of Object.values(HEADS)) {
    let previous = -1;
    for (let jaw = 0; jaw <= .7001; jaw += .0025) {
      const value = liftJaw(jaw, head);
      assert.ok(value >= previous - 1e-12 && value >= jaw - 1e-12 && value <= .7, `${jaw}: ${value}`);
      previous = value;
    }
    assert.equal(liftJaw(0, head), 0); assert.ok(liftJaw(.02, head) < .045 && liftJaw(.03, head) < .08);
    assert.ok(liftJaw(.07, head) >= head.floor - 1e-12 && liftJaw(.7, head) === .7);
  }
  run(jawBody('prepared:woman_average_sermo', .015, `assert(jawValue<.04,'silence: '..jawValue)`, OLD_GRAPH));
  run(jawBody('prepared:player_woman_photomode_sermo', .09, `assert(math.abs(jawValue-${reachJaw(.09)})<1e-9,'Judy: '..jawValue)`, OLD_GRAPH));
});
test('jaw lift: Judy and an unknown or unreadable head keep the model jaw (at its reach) even on a graph without speech_owner', () => {
  for (const [status, extra] of [['prepared:player_woman_photomode_sermo', ''], ['unsupported-graph', ''], [undefined, ''],
    ['prepared:woman_average_sermo', "rows[1].profileKey='judy-alvarez';face.beginExpressionFrame(.1,{actors=rows});face.updateExpressions({actors=rows})"]]) {
    run(jawBody(status, .12, `assert(math.abs(jawValue-${reachJaw(.12)})<1e-9,'unchanged: '..tostring(jawValue))`, OLD_GRAPH + '\n' + extra));
  }
});
test('jaw lift: only the jaw is lifted, and the graph is read once per reply (no native read per frame)', () => {
  run(`
 ${OLD_GRAPH}
 local reads=0
 function a:ConvaiFaceStatus() reads=reads+1;return 'prepared:woman_average_sermo' end
 face.beginExpressionFrame(.1,{actors=rows})
 local timeline={version=1,requestId=context.requestId,entity=a.id,duration=2,source='local-jali',articulation='jali-audio-v1',
  tracks={'jaw_mid_open','lips_together_up','lips_l_funnel'},frames={{0,.12,.5,.3},{2,.12,.5,.3}}}
 assert(face.start(context,timeline,a,2))
 local position=0
 for _=1,12 do face.beginExpressionFrame(.1,{actors=rows});position=position+.1;face.sync(a,position,context.requestId) end
 assert(reads==1,'the graph is read once per reply: '..reads)
 assert(math.abs(last(a).jaw_mid_open-${liftJaw(reachJaw(.12), HEADS.woman_average)})<1e-9)
 assert(last(a).lips_together_up==.5 and last(a).lips_l_funnel==.3,'only the jaw is lifted')
`);
});
// October 15 (user: "not much variety in lipsync shapes"): the model reaches 66-75 % of the game's peaks on the shape
// controls, so a model timeline is scaled per control towards the game's reach and clamped to the validation bounds.
// Contacts, rolls, funnel, puffs and tongue keep the model's values, and other sources are never scaled.
test('model reach: a local-jali timeline scales jaw, purse, spread and lip raises, clamps at the bound, and leaves the rest', () => {
  const tracks = ['jaw_mid_open', 'lips_together_up', 'lips_together_dn', 'lips_l_funnel', 'lips_r_funnel', 'lips_l_purse', 'lips_r_purse',
    'lips_l_corner_stretch', 'lips_r_corner_stretch', 'lips_l_stretch', 'lips_r_stretch', 'lips_l_lower_raise', 'lips_r_lower_raise',
    'lips_l_upper_raise', 'lips_r_upper_raise', 'lips_suck_dn', 'tongue_mid_tip_up', 'cheek_l_puff'];
  const values = [.3, .6, .9, .2, .2, .2, .45, .1, .1, .12, .12, .08, .08, .05, .05, .4, .2, .1];
  const limit = {lips_together_up: 1, lips_together_dn: 1, lips_suck_dn: .8, jaw_mid_open: .7, cheek_l_puff: .35};
  for (const source of ['local-jali', 'convai-arkit61']) {
    const want = tracks.map((track, i) => source === 'local-jali' && REACH[track]
      ? Math.min(values[i] * REACH[track], limit[track] ?? .5) : values[i]);
    run(`
 local timeline={version=1,requestId=context.requestId,entity=a.id,duration=1,source='${source}',
  ${source === 'local-jali' ? "articulation='jali-audio-v1'," : ''}tracks=${literal(tracks)},frames={${literal([0, ...values])},${literal([1, ...values])}}}
 face.beginExpressionFrame(.1,{actors=rows})
 assert(face.start(context,timeline,a,1),face.error);face.beginExpressionFrame(.1,{actors=rows});face.sync(a,.3,context.requestId)
 local f=last(a)
 local want=${literal(want)}
 for i,track in ipairs(${literal(tracks)}) do
  assert(math.abs((f[track] or -1)-want[i])<1e-9,'${source} '..track..': '..tostring(f[track])..' want '..want[i])
 end`);
  }
});

// October 9, night (Evelyn on a sad reply: the jaw was written at .3-.5 and the lips still barely parted): the chin raise of
// sadness, anger and disgust lifts the lower lip into the upper. On a jaw-lifted head it now gives way as the jaw opens
// (gone from .10), and returns between words; Judy and an unknown head keep it exactly.
test('chin raise gives way to an opening jaw while a lifted head speaks, and not for Judy or an unknown head', () => {
  const chinBody = (status, jaw, check, extra = '') => `
 ${status === undefined ? '' : `function a:ConvaiFaceStatus() return ${JSON.stringify(status)} end`}
 ${extra}
 face.beginExpression(context,${literal(receipt('Anger', 3, 0))});face.expressionHeard(context)
 for _=1,30 do tick(.1) end
 local resting=last(a).lips_chin_raise
 assert(resting>.1,'the chin raise holds at rest: '..tostring(resting))
 local timeline={version=1,requestId=context.requestId,entity=a.id,duration=2,source='local-jali',articulation='jali-audio-v1',
  tracks={'jaw_mid_open','lips_together_up'},frames={{0,${jaw},0},{2,${jaw},0}}}
 assert(face.start(context,timeline,a,2),face.error)
 local position=0
 for _=1,14 do face.beginExpressionFrame(.1,{actors=rows});position=position+.1;face.sync(a,position,context.requestId) end
 local chin,jawValue=last(a).lips_chin_raise,last(a).jaw_mid_open
 ${check}`;
  run(chinBody('prepared:woman_average_sermo', .2, "assert(jawValue>=.2 and chin==0,'open jaw, no chin raise: '..chin)"));
  run(chinBody('prepared:man_average_sermo', .12, "assert(chin==0,'man_average open jaw: '..chin)"));
  run(chinBody('prepared:woman_average_sermo', .0, "assert(chin>.1 and chin<=resting,'closed jaw keeps the frown: '..chin..' of '..resting)"));
  run(chinBody('prepared:woman_average_sermo', .015, "assert(jawValue<.03 and chin>.5*resting,'silence keeps the frown: '..chin)"));
  run(chinBody('prepared:player_woman_photomode_sermo', .2, `assert(math.abs(jawValue-${reachJaw(.2)})<1e-9 and chin>.1,'Judy unchanged: '..chin)`));
  run(chinBody('unsupported-graph', .2, "assert(chin>.1,'unknown head unchanged: '..chin)"));
});

// Same night: the corner depressors of a sad or angry mouth stretch the lips thin (.3 halves Evelyn's gap, with the chin raise
// it seals it). They give way to the jaw (gone from .20), return between words, and Judy and unknown heads keep them.
// The brows and the lids keep reading through the jaw, and a smile's corner pull is left alone (it only widens the mouth).
test('corner depressors give way to an opening jaw while a lifted head speaks, the brows stay, Judy and a smile are untouched', () => {
  const dnBody = (emotion, status, jaw, check) => `
 function a:ConvaiFaceStatus() return ${JSON.stringify(status)} end
 face.beginExpression(context,${literal(receipt(emotion, 3, 0))});face.expressionHeard(context)
 for _=1,30 do tick(.1) end
 local resting=last(a)
 local rest={dn=resting.lips_l_corner_dn,up=resting.lips_l_corner_up,brow=resting.eye_l_brows_raise_in,lower=resting.eye_l_brows_lower}
 local timeline={version=1,requestId=context.requestId,entity=a.id,duration=2,source='local-jali',articulation='jali-audio-v1',
  tracks={'jaw_mid_open','lips_together_up'},frames={{0,${jaw},0},{2,${jaw},0}}}
 assert(face.start(context,timeline,a,2),face.error)
 local position=0
 for _=1,14 do face.beginExpressionFrame(.1,{actors=rows});position=position+.1;face.sync(a,position,context.requestId) end
 local f=last(a);local dn,jawValue=f.lips_l_corner_dn,f.jaw_mid_open
 ${check}`;
  run(dnBody('Sadness', 'prepared:woman_average_sermo', .2, "assert(rest.dn>.2 and jawValue>=.2 and dn==0 and f.lips_r_corner_dn==0,'open jaw, no corner depressors: '..dn..' of '..rest.dn); assert(f.eye_l_brows_raise_in>.5*rest.brow,'the inner brows still read: '..f.eye_l_brows_raise_in)"));
  run(dnBody('Sadness', 'prepared:man_average_sermo', .3, "assert(dn==0,'man_average: '..dn)"));
  run(dnBody('Sadness', 'prepared:woman_average_sermo', .0, "assert(dn>.5*rest.dn,'closed jaw keeps the corners: '..dn..' of '..rest.dn)"));
  run(dnBody('Sadness', 'prepared:woman_average_sermo', .1, "assert(jawValue>.1 and dn>0 and dn<.7*rest.dn,'in between, partly: '..dn..' at jaw '..jawValue)"));
  run(dnBody('Sadness', 'prepared:player_woman_photomode_sermo', .3, `assert(math.abs(jawValue-${reachJaw(.3)})<1e-9 and dn>.5*rest.dn,'Judy unchanged: '..dn)`));
  run(dnBody('Sadness', 'unsupported-graph', .3, "assert(dn>.5*rest.dn,'unknown head unchanged: '..dn)"));
  run(dnBody('Joy', 'prepared:woman_average_sermo', .3, "assert(rest.up>.1 and f.lips_l_corner_up>.5*rest.up,'the smile keeps its corner pull: '..f.lips_l_corner_up..' of '..rest.up)"));
});

// October 10 (user: "a bit of snapping when she speaks", "her mouth stays half open while the next line loads"). A saved
// Pocket reply replayed through the writer showed the smile corner dropping .35 to 0 in three frames at every rounded
// vowel, the frown pumping with the jaw, a one-frame close on a stream pause, and a stalled cursor holding the last jaw.
const pumpLine = (id, seconds = 4) => {
  const frames = [];
  for (let i = 0; i <= seconds * 60; i++) {
    const t = i / 60, jaw = .22 + .12 * Math.sin(t * 2 * Math.PI * 4), round = Math.max(0, Math.sin(t * 2 * Math.PI * 3)) > .5 ? .32 : 0;
    frames.push([t, Math.max(0, jaw), 0, 0, round, round]);
  }
  return {version: 1, requestId: id, entity: 'copy-a', generation: owner.generation, continuous: true, complete: false,
    duration: seconds, source: 'local-jali', articulation: 'jali-audio-v1',
    tracks: ['jaw_mid_open', 'lips_together_up', 'lips_together_dn', 'lips_l_funnel', 'lips_r_funnel'], frames};
};
const pumpBody = (emotion, scale, check) => `
 function a:ConvaiFaceStatus() return 'prepared:woman_average_sermo' end
 rows[1].profileKey='evelyn-parker'
 face.beginExpression(context,${literal(receipt(emotion, scale, 0))});face.expressionHeard(context)
 for _=1,60 do tick(1/60) end
 local line=${literal(pumpLine(owner.requestId))}
 assert(face.updateContinuous(context,line,a,line.duration),face.error)
 local rest,prior,worst,sum,count=last(a),nil,0,0,0
 for i=1,180 do
  face.beginExpressionFrame(1/60,{actors=rows});face.sync(a,i/60,context.requestId);face.updateExpressions({actors=rows})
  local f=last(a);local value=${check.track}
  if prior and i>40 then worst=math.max(worst,math.abs(value-prior));sum=sum+value;count=count+1 end
  prior=value
 end
 local mean=sum/count
 ${check.assert}`;

test('the smile and the frown follow the mouth with an attack and a release: no corner step over .09 per frame at syllable rate', () => {
  run(pumpBody('Joy', 3, {track: 'f.lips_l_corner_up',
    assert: "assert(worst<.09,'smile corner step per frame: '..worst);assert(mean>.05,'the smile is still there on average: '..mean)"}));
  run(pumpBody('Sadness', 3, {track: 'f.lips_l_corner_dn',
    assert: "assert(worst<.09,'frown corner step per frame: '..worst)"}));
});

test('a stream whose heard cursor stops while it still reports playing closes the mouth in about a third of a second instead of holding it', () => run(`
 function a:ConvaiFaceStatus() return 'prepared:woman_average_sermo' end
 local line=${literal(pumpLine(owner.requestId))}
 face.beginExpression(context,${literal(receipt('Anger', 3, 0))})
 for _=1,10 do tick(1/60) end
 assert(face.updateContinuous(context,line,a,line.duration),face.error)
 for i=1,60 do face.beginExpressionFrame(1/60,{actors=rows});face.sync(a,i/60,context.requestId);face.updateExpressions({actors=rows}) end
 local open=last(a).jaw_mid_open;assert(open>.1,'open mouth '..open)
 local held=last(a).eye_l_brows_lower
 -- The cursor stays at 1.0 s: first the mouth holds (a late report), then it eases shut and the idle writer takes over.
 local at={}
 for i=1,60 do
  face.beginExpressionFrame(1/60,{actors=rows});face.sync(a,1,context.requestId);face.updateExpressions({actors=rows})
  at[i]=last(a).jaw_mid_open or 0
 end
 assert(at[8]==open,'a short stall holds the mouth: '..at[8])
 local easing=false
 for i=9,30 do if at[i]>0 and at[i]<open then easing=true end end
 assert(easing,'the mouth eases shut, it does not jump')
 assert(at[30]==0 and at[60]==0,'the mouth is shut: '..at[30]..' '..at[60])
 for i=2,60 do assert(math.abs(at[i]-at[i-1])<=open*.15+1e-6,'no one-frame close at '..i) end
 assert(a.resets==0 and math.abs(last(a).eye_l_brows_lower-held)<.03,'the expression carries on: '..last(a).eye_l_brows_lower)
 assert(face.active,'the reply is still owned')
 -- Audio moves again: the mouth is back at once.
 face.beginExpressionFrame(1/60,{actors=rows});face.sync(a,1+1/60,context.requestId)
 assert(last(a).jaw_mid_open>0,'speaking again')
 face.beginExpressionFrame(1/60,{actors=rows});face.sync(a,1+2/60,context.requestId);face.updateExpressions({actors=rows})
 assert(last(a).jaw_mid_open>0)
`));

test('the speech-state turn record shows the peak written jaw, the open frames and the jaw lift in use', () => {
  for (const [extra, lift] of [['', 'false'], [OLD_GRAPH, '2']]) run(`
 ${extra}
 function a:ConvaiFaceStatus() return 'prepared:woman_average_sermo' end
 local line=${literal(pumpLine(owner.requestId, 2))}
 face.beginExpression(context,${literal(receipt('Joy', 3, 0))})
 assert(face.updateContinuous(context,line,a,line.duration),face.error)
 for i=1,60 do face.beginExpressionFrame(1/60,{actors=rows});face.sync(a,i/60,context.requestId);face.updateExpressions({actors=rows}) end
 local turn=face.status().expressions.lastSpeech
 assert(turn.jawPeak>.3 and turn.openFrames>20 and turn.jawLift==${lift},turn.jawPeak..' '..turn.openFrames..' '..tostring(turn.jawLift))
`);
});

// October 15: face-play replays a saved mouth timeline (the lip-sync captures) silently through the real writer, so the
// same line can be captured before and after a change to how the face is applied.
test('face-test probe: face-play replays a saved timeline through the writer, ends the reply at its end and refuses a missing file', () => runProbe(`
 local doc={tracks={'jaw_mid_open','lips_together_up','lips_l_purse'},frames={{0,.2,0,.1},{1,.2,0,.1}},duration=1}
 files['runtime/line-a.json']='LINE';json.decode=function(raw) assert(raw=='LINE');return doc end
 request('p1\\nface-play judy line-a');tick(.3)
 assert(files['runtime/face-test-response.txt']:find('ok=true',1,true),files['runtime/face-test-response.txt'])
 assert(face.active and face.faceTest.play,'playing')
 for _=1,6 do tick(.1) end
 local f=last(a)
 assert(math.abs(f.jaw_mid_open-.2*face.modelReach.jaw_mid_open)<1e-9,'the writer wrote the model jaw at its reach: '..tostring(f.jaw_mid_open))
 assert(math.abs(f.lips_l_purse-.1*face.modelReach.lips_l_purse)<1e-9,'and the purse: '..tostring(f.lips_l_purse))
 for _=1,15 do tick(.1) end
 assert(not face.faceTest.play and not face.active,'the replay ends and frees the face')
 request('p2\\nface-play judy missing');tick(.3)
 assert(files['runtime/face-test-response.txt']:find('ok=false',1,true),files['runtime/face-test-response.txt'])
 request('p3\\nface-play judy ../x');tick(.3)
 assert(files['runtime/face-test-response.txt']:find('ok=false',1,true),'no path outside runtime/')
`));

test('face-test probe: direct mode bypasses the writer with its own feature and logs the apply result', () => runProbe(`
 request('n2\\nface-test judy frown 2 direct');tick(.3)
 local count=#a.frames;tick(.1);assert(#a.frames==count+1,'one direct write per frame, writer skipped')
 assert(last(a).lips_l_corner_dn==1 and last(a).lips_l_corner_up==nil)
 assert(files['runtime/face-test.log']:find('applied=true',1,true),files['runtime/face-test.log'])
`));

test('face-test probe: policy mode shows a real scale-3 smile WHILE speaking, yielding to lip closure', () => {
  const timeline = {version: 1, requestId: 'expression-turn', entity: 'copy-a', duration: 2, source: 'audio-envelope',
    tracks: ['jaw_mid_open', 'lips_together_up', 'lips_together_dn'], frames: [[0, .3, 0, 0], [.5, .3, 0, 0], [.55, .1, .85, .85], [2, .1, .85, .85]]};
  runProbe(`
 request('n3\\nface-test judy smile 8 policy');tick(.3)
 assert(face.start(context,${literal(timeline)},a,2),face.error)
 for i=1,14 do face.beginExpressionFrame(.1,{actors=rows});face.sync(a,.2+i*.01,context.requestId) end
 local open=copy(last(a));assert(open.lips_l_corner_up>.3 and open.lips_l_corner_up<=.65,open.lips_l_corner_up)
 face.beginExpressionFrame(.1,{actors=rows});face.sync(a,.7,context.requestId)
 assert(last(a).lips_l_corner_up<open.lips_l_corner_up,'the smile starts giving way to the closure')
 for i=1,25 do face.beginExpressionFrame(1/60,{actors=rows});face.sync(a,.7+i/60,context.requestId) end
 assert(last(a).lips_together_up==.85 and last(a).lips_l_corner_up==0,'a held closure wins over the smile')
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
 -- Joy at scale 3 on Judy: corners .45 x her smile multiplier .7 x her gain 1.6 = .504 (October 9, "stretched" at .72), the
 -- squint .6 of the UNSCALED smile (.45 x 1.6, kept), brows ungained (.30 since October 9).
 face.beginExpression(context,${literal(receipt('Joy',3,0))});face.expressionHeard(context);for _=1,40 do tick(.1) end
 assert(math.abs(last(a).lips_l_corner_up-.504)<.01,'judy joy: '..last(a).lips_l_corner_up)
 assert(math.abs(last(a).eye_l_oculi_squint_outer_lower-.432)<.01)
 assert(math.abs(last(a).eye_l_brows_raise_out-.30)<.01)
 face.endExpression(context,false)
 -- A default head (smile multiplier 1.65, squint 1.3): joy .45 x 1.65 = .74, squint .6 x .45 x 1.3 = .35.
 rows[1].profileKey='evelyn-parker';for _=1,60 do tick(.1) end
 face.beginExpression(context,${literal(receipt('Joy',3,0))});face.expressionHeard(context);for _=1,40 do tick(.1) end
 assert(math.abs(last(a).lips_l_corner_up-.7425)<.01,'default joy: '..last(a).lips_l_corner_up)
 assert(math.abs(last(a).eye_l_oculi_squint_outer_lower-.351)<.01,'default squint: '..last(a).eye_l_oculi_squint_outer_lower)
 face.endExpression(context,false)
`));

test('Alt Cunningham rests at the dry level (.05) while the other cold characters stay flat', () => run(`
 rows[1].profileKey='alt-cunningham';rows[2].profileKey='adam-smasher'
 for _=1,40 do tick(.1) end
 local alt,cold=last(a),last(b)
 assert(math.abs(alt.lips_l_corner_up-.05)<.005,'alt rests at .05: '..alt.lips_l_corner_up)
 assert(cold.lips_l_corner_up==0,'a cold face stays flat')
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
   assert(say(ctx,timeline))
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
 assert(say(ctx,${literal(trackLine('trk'))}),face.error)
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
  assert(math.abs(net-previous)<.11,'corner step at '..p..': '..tostring(net-previous))
  previous=net
  if math.abs(p-2.0)<.011 then mid=frame end
 end
 for p=2.6,3.4,.1 do at(p) end
 local sad=at(3.45)
 assert(sad.lips_l_corner_dn>.15 and sad.lips_l_corner_up==0 and sad.eye_l_brows_raise_in>.2,'phrase two is sad: '..sad.lips_l_corner_dn..' '..sad.eye_l_brows_raise_in)
 assert(sad.eye_l_oculi_squint_outer_lower<.05,'no squint without a smile (the bigger joy squint is still easing out)')
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
   assert(say(ctx,timeline),face.error)
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
  const closing = id => ({version: 1, requestId: id, entity: 'copy-a', duration: 2, source: 'audio-envelope',
    tracks: ['jaw_mid_open', 'lips_together_up', 'lips_together_dn', 'lips_l_funnel', 'lips_r_funnel', 'lips_l_purse', 'lips_r_purse', 'lips_suck_up'],
    frames: [[0, .3, 0, 0, 0, 0, 0, 0, 0], [.5, .3, 0, 0, 0, 0, 0, 0, 0], [.55, .1, .85, .85, 0, 0, 0, 0, 0], [1, .1, .85, .85, 0, 0, 0, 0, 0],
      [1.05, .2, 0, 0, .32, .32, .28, .28, .05], [2, .2, 0, 0, .32, .32, .28, .28, .05]]});
  const withTrack = {...closing('trk-mouth'), expressionTrack: {version: 1, format: 'emotion-mix-v1',
    families: ['joy', 'trust', 'sadness', 'anger', 'fear', 'disgust', 'surprise', 'anticipation'],
    keys: [[0, .6, .4, .3, 0, 0, 0, 0, 0], [2, .6, .4, .3, 0, 0, 0, 0, 0]]}};
  run(`
   speech.target=a
   local function play(timeline)
    local ctx={requestId=timeline.requestId,entity=a.id,generation=4}
    assert(say(ctx,timeline),face.error)
    local out={}
    for i=1,14 do cursor=.2+i*.01;tick(.1) end
    out.open=copy(last(a))
    cursor=.6;tick(.1)
    for i=1,24 do cursor=.6+i/60;tick(1/60) end
    out.closure=copy(last(a))
    for i=1,54 do cursor=1.06+i/60;tick(1/60) end
    out.round=copy(last(a))
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
    assert(say(ctx,timeline),face.error)
    assert(face.expressionTrackKeys==nil,'invalid track rejected')
    cursor=.5;tick(.1);assert(last(a).jaw_mid_open==.3,'speech still plays')
    speech.stop('cancelled');for _=1,5 do tick(.1) end
   end
  `);
});

test('the post-speech hold: a held mix releases its brows within about 1.5 s while the corners keep the longer expiry', () => run(`
 speech.target=a
 rows[1].profileKey='some-fixer'
 face.beginExpression(context,${literal(receipt('Sadness', 3, 0))});face.expressionHeard(context)
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
  ...(source === 'local-jali' ? {articulation: 'jali-audio-v1'} : source === 'local-phonetic' ? {articulation: 'coarticulated-v5'} : {}),
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
   assert(say(ctx,${literal(flatLine(`blink-${source}`, source, 20))}),face.error)
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
    assert(f.jaw_mid_open==${source === 'local-jali' ? 'math.min(.3*face.modelReach.jaw_mid_open,.7)' : '.3'},'speech fields untouched')
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

// Item 4 of docs/PERFORMANCE_NATIVE_PLAN.md: a settled idle face sleeps. The native feature keeps its last applied
// frame, so the face a player sees (the last frame written) is the same with or without sleep; only the writes stop.
function runTrace(body) {
  const vm=lauxlib.luaL_newstate();lualib.luaL_openlibs(vm);
  try {
    const status=lauxlib.luaL_dostring(vm,to_luastring(setup+body));
    assert.equal(status,lua.LUA_OK,status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(vm,-1)));
    lua.lua_getglobal(vm,to_luastring('trace'));return to_jsstring(lua.lua_tostring(vm,-1));
  } finally {lua.lua_close(vm);}
}
test('a settled idle face sleeps between blinks: the held frame matches writing every frame, at a fraction of the writes', () => {
  const trace = sleep => runTrace(`${seeded(77)}
   face.idleSleep=${sleep}
   local out,start={},#a.frames
   for i=1,1800 do
    tick(1/30,i>900 and {listeningEntity=a.id} or nil);local f=last(a)
    out[#out+1]=string.format('%.6f,%.6f,%.6f',f.eye_l_blink or 0,f.lips_l_corner_up or 0,f.eye_l_widen or 0)
   end
   out[#out+1]='writes '..(#a.frames-start);trace=table.concat(out,';')`);
  const awake = trace(false).split(';'), asleep = trace(true).split(';');
  assert.equal(awake.pop(), 'writes 1800');
  const writes = Number(asleep.pop().split(' ')[1]);
  assert.ok(writes < 900, `a settled face writes far less often: ${writes} of 1800 frames`);
  // The ease toward the resting smile ends asymptotically: a face counts as settled once a frame moves every control
  // by less than 1e-4, so the held frame may trail the every-frame writer by a few frames of that tail (well under
  // 0.002 on a 0-1 rig control). Blinks start and end on the same frames.
  assert.equal(asleep.length, awake.length);
  asleep.forEach((row, i) => row.split(',').forEach((value, k) => {
    const expected = Number(awake[i].split(',')[k]);
    assert.ok(Math.abs(Number(value) - expected) < .002, `tick ${i + 1}, field ${k}: ${value} vs ${expected}`);
    if (k === 0) assert.equal(Number(value) > 0, expected > 0, `tick ${i + 1}: blink on the same frame`);
  }));
});

test('a sleeping face wakes at once for a reaction or a reply, re-checks every 0.25 s, and a blocked face is blank within 0.25 s', () => run(`${seeded(77)}
 for _=1,60 do tick(1/30) end
 local slot=face.expressions[a.id];assert(slot.sleepAt,'settled at idle')
 -- Asleep: at most one write per sleepRecheck (0.25 s) between blinks.
 local writes,since,gap=0,0,0
 for _=1,300 do local n=#a.frames;tick(1/30)
  if #a.frames>n then writes=writes+1;gap=math.max(gap,since);since=0 else since=since+1 end end
 assert(writes<150 and gap<=8,'re-checks: '..writes..' writes, longest gap '..gap..' frames')
 -- A reaction wakes the face on the next frame.
 local n=#a.frames
 face.beginExpression(context,${literal(receipt('Joy', 3, 0))});face.expressionHeard(context);face.endExpression(context,true)
 tick(1/30);assert(#a.frames==n+1,'the reaction is written at once')
 for _=1,30 do n=#a.frames;tick(1/30);assert(#a.frames==n+1,'a lingering reaction keeps writing') end
 -- Combat reaches a sleeping face at its next re-check at the latest.
 for _=1,900 do tick(1/30) end;assert(slot.sleepAt,'settled again')
 a.combat=true;local blank
 for i=1,8 do tick(1/30);if last(a).lips_l_corner_up==0 then blank=blank or i end end
 assert(blank,'blank within 0.25 s')
 a.combat=false
 for _=1,60 do tick(1/30) end
 face.idleSleep=false;n=#a.frames;tick(1/30);assert(#a.frames==n+1,'switch off: every frame writes')
`));

// Perf 2026-10-13: the development install loads mod/face-test.lua. Merely having the probe loaded used to keep every
// idle face awake (about 20 ms/s per companion in the live capture); it now matters only while a run, a trace or a leftover field exists.
test('a loaded but idle face-test probe lets the face sleep; a probe run (or its leftover fields) wakes it', () => runProbe(`${seeded(77)}
 for _=1,60 do tick(1/30) end
 local slot=face.expressions[a.id];assert(slot.sleepAt,'settled at idle with the probe loaded')
 local writes,n=0,0
 for _=1,300 do n=#a.frames;tick(1/30);if #a.frames>n then writes=writes+1 end end
 assert(writes<150,'the idle face sleeps with the probe loaded: '..writes..' of 300 frames')
 -- A run writes every frame (its hooks need each one).
 request('p1\\nface-test judy smile 4 writer');tick(1/30);tick(1/30)
 for _=1,20 do n=#a.frames;tick(1/30);assert(#a.frames==n+1,'a probe run keeps the face writing') end
 assert(last(a).lips_l_corner_up==1,'the run is written')
 -- Off: the leftover probe fields are cleared on the next frames, then the face settles and sleeps again.
 request('p2\\nface-test judy off');for _=1,12 do tick(1/30) end
 assert(next(face.faceTest.touched)==nil and last(a).lips_l_corner_up<.5,'the fields are cleared')
 for _=1,400 do tick(1/30) end;local woke=0;while not face.expressions[a.id].sleepAt and woke<60 do tick(1/30);woke=woke+1 end -- a blink may be in flight
 assert(face.expressions[a.id].sleepAt,'asleep again after the run')
`));

// Perf 2026-10-13: an idle copy writes only the controls that changed into its own feature object. Whatever was
// written last must still be what the object holds, through a feeling, a blink over widened eyes and the fall back.
test('an idle copy writes only changed controls, and its feature still holds exactly the written pose', () => run(`${seeded(5)}
 face.idleSleep=false
 local tracks=${literal(Object.keys(expressionTarget()))}
 local function check(why)
  local slot=face.expressions[a.id];local feature,written=slot.feature,slot.writtenPose
  for _,track in ipairs(tracks) do assert(feature[track]==written[track],why..' '..track..': '..tostring(feature[track])..' vs '..tostring(written[track])) end
  assert(feature.eye_l_blink==nil or feature.eye_l_blink>=0)
 end
 local sawBlinkOverWiden=false
 -- A held fear (no expiry): widened eyes that stay constant, so only a blink changes what is on the feature.
 face.beginExpression(context,${literal(receipt("Fear", 3, 0))});face.expressionHeard(context)
 for i=1,900 do
  tick(1/30);check('tick '..i)
  local f=last(a);if (f.eye_l_blink or 0)>.2 and (f.eye_l_widen or 0)>.01 and f.eye_l_widen<.4 then sawBlinkOverWiden=true end
 end
 assert(sawBlinkOverWiden,'a blink closed widened eyes in this run')
 `));

test('a settled idle copy writes almost nothing into its feature object: only the blink controls cross between full frames', () => run(`${seeded(5)}
 face.idleSleep=false
 for _=1,600 do tick(1/30) end
 local slot=face.expressions[a.id];local count=0
 local real=slot.feature;slot.feature=setmetatable({},{__index=real,__newindex=function(_,k,v) count=count+1;real[k]=v end})
 for _=1,300 do tick(1/30) end
 -- The proxy is a new object, so its first frame writes every control (25 writes); then blinks (two controls per frame).
 assert(count<25+300*2*.2,'only changed controls cross: '..count..' writes in 300 frames')
`));

test('a phrase boundary now and then brings a blink, and a separate phrase never ends on a half-closed lid', () => {
  const spans = [0.3, 2, 4, 6].map((start, i, all) => ({start, end: all[i + 1] ?? 8, from: 0, to: 1, dominant: null, tags: [], top: [], anchored: true}));
  const track = {version: 1, format: 'emotion-mix-v1', families: ['joy', 'trust', 'sadness', 'anger', 'fear', 'disgust', 'surprise', 'anticipation'],
    keys: [[0, 0, 0, 0, 0, 0, 0, 0, 0], [8, 0, 0, 0, 0, 0, 0, 0, 0]], segments: spans};
  run(`${blinkHelpers}
   face.blinkRandom=function() return .1 end   -- every boundary is taken; rhythm 2.4 s
   speech.target=a
   local ctx={requestId='phrases',entity=a.id,generation=4}
   assert(say(ctx,${literal(flatLine('phrases', 'local-jali', 8, {expressionTrack: track}))}),face.error)
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
     assert(say(ctx,${literal(line)}),face.error)
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
    ['joy', "You're such a dork, V. Okay, okay, I'll admit it.", {lips_l_corner_up: .18, eye_l_oculi_squint_outer_lower: .15, eye_l_brows_raise_out: .1}, ['lips_l_corner_dn']],
    ['warm', "Anytime. Whatever you need, I'm here.", {lips_l_corner_up: .14, eye_l_oculi_squint_outer_lower: .1}, ['lips_l_corner_dn']],
    ['surprise', "Wait, you found her? After all this time?", {eye_l_brows_raise_out: .3, eye_l_brows_raise_in: .2}, []],
    ['disgust', "Corpo errands for a sleazy fixer. Real classy.", {eye_l_brows_lower: .18, lips_l_corner_dn: .12}, ['lips_l_corner_up']],
  ];
  for (const [name, reply, minimum, absent] of cases) {
    const plan = selectEmotion({player: 'Hey.', reply, profile: 'judy-alvarez', marks: tagged(reply, [reply.split(' ')[0], name])});
    const peak = peaksWhileSpeaking('judy-alvarez', plan, `judy-${name}`);
    for (const [track, value] of Object.entries(minimum)) assert.ok((peak[track] ?? 0) >= value, `${name} ${track} ${peak[track]} < ${value}`);
    for (const track of absent) assert.ok((peak[track] ?? 0) < .02, `${name} shows ${track} ${peak[track]}`);
    assert.ok((peak.lips_l_corner_up ?? 0) <= 1 && (peak.lips_l_corner_dn ?? 0) <= 1 && (peak.eye_l_brows_lower ?? 0) <= .9, `${name} within the caps`);
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

// October 9 (user): "her current emotion during idle becomes bland before the lip sync starts playing; it should go
// bland once the lip sync starts". Her idle face (here Judy's resting smile) holds through V's message, her
// thinking, a reply being prepared, a stream buffering and an Omni phrase loading, on every route; the reply's sad
// face begins with its first heard frame and eases in with the usual smoothing.
test('the idle face holds until the reply is heard, through speech.lua and on a raw continuous face timeline', () => {
  const sadKeys = [[0, 0, 0, 1, 0, 0, 0, 0, 0], [3, 0, 0, 1, 0, 0, 0, 0, 0]];
  const track = {version: 1, format: 'emotion-mix-v1', families: ['joy', 'trust', 'sadness', 'anger', 'fear', 'disgust', 'surprise', 'anticipation'], keys: sadKeys};
  const sad = receipt('Sadness', 3, 0);
  const phrase = flatLine(owner.requestId, 'local-jali', 3, {expressionTrack: track, expression: sad});
  const stream = {...flatLine(owner.requestId, 'convai-arkit61', 3, {expressionTrack: track, expression: sad}), generation: owner.generation, continuous: true, complete: true};
  const prelude = `rows[1].profileKey='judy-alvarez';speech.target=a
   local rest
   local function holds(label,seconds,options)
    for _=1,math.floor(seconds*10+.5) do
     local count=#a.frames;tick(.1,options);assert(#a.frames<=count+1,label..': one write a frame at most (a settled face may sleep; the native keeps its last frame)')
     assert(math.abs(last(a).lips_l_corner_up-rest)<.01 and (last(a).lips_l_corner_dn or 0)==0,label..': '..last(a).lips_l_corner_up)
    end
   end
   for _=1,40 do tick(.1) end;rest=last(a).lips_l_corner_up;assert(math.abs(rest-.192)<.005,'idle smile '..rest)
   holds('V sends, she thinks',2.5,{thinkingEntity=a.id,thinkingRequestId=context.requestId})
   local function heard(step)
    local previous,turned=last(a).lips_l_corner_up-(last(a).lips_l_corner_dn or 0)
    for i=1,90 do step(i);local f=last(a);local net=f.lips_l_corner_up-f.lips_l_corner_dn
     assert(math.abs(net-previous)<.12,'smooth change '..(net-previous)..' at frame '..i);previous=net
     if not turned and f.lips_l_corner_dn>.15 and f.lips_l_corner_up==0 then turned=i end
    end
    assert(turned and turned<=60,'sad within a second of the first heard frame: '..tostring(turned))
   end`;
  // Through speech.lua: the continuous voice takes a while to start (the heard position stays at 0 until the first device report).
  run(`${prelude}
   assert(say(context,${literal(phrase)}),face.error)
   cursor=0;holds('phrase prepared, audio not started',2)
   heard(function(i) cursor=i/60;tick(1/60) end)
   speech.stop('finished')`);
  // Raw continuous face timeline: the speech owner begins the expression as the stream opens; the face timeline arrives and the
  // player pauses the face while the device has not reported heard audio yet.
  run(`${prelude}
   face.beginExpression(context,${literal(sad)})
   holds('stream opened, nothing buffered',1,{thinkingEntity=a.id,thinkingRequestId=context.requestId})
   assert(face.updateContinuous(context,${literal(stream)},a,3),face.error)
   for _=1,15 do face.pause(a);holds('stream buffering',.1) end
   heard(function(i) tick(1/60);face.sync(a,i/60,context.requestId) end)
   face.stop(a,'finished')`);
  // A reply cancelled before it was heard leaves the idle face as it was (no reset, no reaction).
  run(`${prelude}
   assert(say(context,${literal(phrase)}),face.error)
   cursor=0;holds('prepared',.5);speech.stop('cancelled');holds('cancelled before audio',1)`);
});

// October 10: the mouth that sometimes stayed shut under a streamed facial idle. While a reply is heard the writer
// raises speech_owner, which makes the graph fade the idle's jaw and lip controls (assets/facial/controls.json
// "owner"); it eases back to 0 once the idle writer takes over, and is 0 at once while blocked.
test('a heard reply owns the mouth (speech_owner eased to 1) and hands it back eased; an older feature without it still works', () => {
  const line = buildFacialTimeline({audio: wav(), mouthCuesFormat: 'rhubarb-phonetic-v1',
    mouthCues: [{start: 0, end: .5, value: 'A'}, {start: .5, end: 1, value: 'G'}], expressionSignal: signal()}, owner);
  delete line.motion;
  const start = `tick(.1);speech.target=a
   assert(say(context,${literal(line)}))`;
  run(`${start}
   assert(last(a).speech_owner==nil or last(a).speech_owner==0,'idle frames do not own the mouth')
   cursor=.02;tick(1/60);local first=last(a).speech_owner
   assert(first and first>0 and first<1,'eased in, not a step: '..tostring(first))
   for i=1,12 do cursor=.02+i/60;tick(1/60) end
   assert(last(a).speech_owner==1,'owned within ownRise: '..tostring(last(a).speech_owner))
   assert(last(a).jaw_mid_open~=nil,'the same frame carries the jaw')
   assert(face.ownerFace==true and face.status().expressions.lastSpeech.ownedFrames>0)
   -- Blocked (combat, a scene, native dialogue): the idle face is the game's, the owner drops with every other delta.
   cursor=.25;tick(1/60,{blocked=true});assert(last(a).speech_owner==0,'blocked frames never own the mouth: '..tostring(last(a).speech_owner))
   cursor=.3;tick(1/60);assert(last(a).speech_owner<1,'ownership restarts eased after a block')
   for i=1,12 do cursor=.3+i/60;tick(1/60) end
   assert(last(a).speech_owner==1)
   -- The reply ends: the idle writer (or the reset) hands the face back in the same call.
   speech.stop('cancelled');tick(.05);local fading=last(a).speech_owner
   assert(fading and fading>0 and fading<1,'the idle mouth returns eased, not as a pop: '..tostring(fading))
   for _=1,6 do tick(.05) end;assert(last(a).speech_owner==0,'handed back: '..tostring(last(a).speech_owner))
   local frames=#a.frames;tick(.05);assert(last(a).speech_owner==0 or last(a).speech_owner==nil)
  `);
  // An install whose FaceFeature lacks the field (older reds build) keeps speaking, without the field.
  run(`NewObject=function() return setmetatable({},{__newindex=function(t,k,v)
     if k=='speech_owner' then error('no such property '..k) end;rawset(t,k,v) end}) end
   ${start}
   for i=1,12 do cursor=.02+i/60;tick(1/60) end
   assert(face.ownerFace==false,'not detected')
   assert(rawget(last(a),'speech_owner')==nil and last(a).jaw_mid_open~=nil,'speech goes on without the field')
   assert(face.error==nil and face.expressionError==nil,tostring(face.error)..tostring(face.expressionError))
   speech.stop('cancelled');tick(.1)`);
});

// October 9 (evening): nine more native controls (brows pulled together, upper-lid lowering, inner squint, nose
// wrinkle, chin raise) need the new FaceFeature.reds; an install whose feature lacks them keeps the base controls.
test('extended controls are used when the feature has them, and an older feature keeps working without them', () => {
  run(`face.beginExpression(context,${literal(receipt('Anger',3,0))});face.expressionHeard(context)
   for _=1,30 do tick(.1) end
   local f=last(a);assert(face.extendedFace==true,'detected')
   assert(f.eye_l_brows_lateral>.6 and f.eye_l_oculi_squint_outer_upper>.4 and f.nose_l_snear>.1 and f.lips_chin_raise>.1,'anger uses the whole upper face')
   assert(f.eye_l_brows_lower>.6 and f.eye_l_oculi_squint_outer_lower>.3 and f.lips_l_corner_up==0)
   assert((f.eye_l_blink or 0)>=.2,'a held lid droop under the blink rhythm: '..tostring(f.eye_l_blink))`);
  run(`local unknown={lateral=true,snear=true,chin=true,outer_upper=true,squint_inner=true}
   NewObject=function() return setmetatable({},{__newindex=function(t,k,v)
     for part in pairs(unknown) do if k:find(part,1,true) then error('no such property '..k) end end
     rawset(t,k,v) end}) end
   face.beginExpression(context,${literal(receipt('Anger',3,0))});face.expressionHeard(context)
   for _=1,30 do tick(.1) end
   local f=last(a);assert(face.extendedFace==false,'not detected')
   assert(f.eye_l_brows_lower>.6 and f.eye_l_oculi_squint_outer_lower>.3 and rawget(f,'eye_l_brows_lateral')==nil,'base controls only')
   assert(face.expressionError==nil,tostring(face.expressionError))`);
});

test('a sad face drops its gaze a little below V, with hysteresis; other feelings keep eye contact', () => run(`
 assert(face.gazeDrop(a.id)==0)
 face.beginExpression(context,${literal(receipt('Sadness',3,0))});face.expressionHeard(context)
 for _=1,20 do tick(.1) end
 assert(face.gazeDrop(a.id)==-0.15,'sad looks down')
 face.endExpression(context,false);for _=1,20 do tick(.1) end
 assert(face.gazeDrop(a.id)==0,'back to eye contact')
 local ctx={requestId='angry',entity=a.id,generation=4}
 face.beginExpression(ctx,{version=1,entity=a.id,requestId='angry',generation=4,sequence=0,emotion='Anger',scale=3})
 face.expressionHeard(ctx);for _=1,20 do tick(.1) end
 assert(face.gazeDrop(a.id)==0,'anger holds the stare')
`));

// ---- October 9 (user: "sometimes the eyebrows flicker") ------------------------------------------------------------
// Omni plays one phrase at a time. Each phrase ended with face.stop -> ConvaiFaceReset, which zeroes the whole feature
// and (for that frame) kept the idle writer from writing: brows, lids, squints and corners showed ONE NEUTRAL FRAME and
// snapped back. The same happened when a reply ended, when a continuous stream underran and when a native phrase
// started late. A managed copy now hands over to its idle writer inside the same call.
const BROW_KEYS = ['eye_l_brows_lower', 'eye_l_brows_lateral', 'eye_l_oculi_squint_outer_upper', 'eye_l_oculi_squint_outer_lower',
  'eye_l_brows_raise_in', 'eye_l_brows_raise_out', 'eye_l_widen'];
// Plays a reply phrase by phrase the way mod/speech.lua plays a v1 stream: face.start, a synced frame per game frame,
// face.stop at the end of the phrase, `gapFrames` idle frames, then the next phrase. Returns the written brow controls
// per game frame (the native layer keeps the last write) and the native reset count per frame.
function playPhrases(plan, {gapFrames = 0, startFrames = 0, hold = 90, profile = 'evelyn-parker', fps = 30, pauseAt = 0, managed = true} = {}) {
  const lines = plan.segments.map((segment, index) => {
    const line = attachExpressionTrack(flatLine('steady', 'local-jali', segment.seconds), planRange(plan, segment.start, segment.end), {complete: true, decay: true});
    return {...line, expression: index === 0 ? receipt('Anger', 2, 0) : undefined};
  });
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const status = lauxlib.luaL_dostring(vm, to_luastring(setup + `
     rows[1].profileKey=${JSON.stringify(profile)}
     local ctx={requestId='steady',entity=a.id,generation=4}
     local keys=${literal(BROW_KEYS)}
     local series={}
     local dt=1/${fps}
     local managed=${managed}
     local function frame(play)
      face.beginExpressionFrame(dt,managed and {actors=rows} or nil)
      if play then play() end
      if managed then face.updateExpressions({actors=rows}) end
      local f=last(a) or {}
      local row={a.resets}
      for _,k in ipairs(keys) do row[#row+1]=string.format('%.5f',f[k] or 0) end
      series[#series+1]=table.concat(row,',')
     end
     local lines=${literal(lines)}
     face.beginExpressionFrame(0,managed and {actors=rows} or nil)
     for index,line in ipairs(lines) do
      assert(face.start(ctx,line,a,line.duration),face.error)
      for _=1,${startFrames} do frame() end
      local count=math.floor(line.duration*${fps})
      for i=1,count do
       frame(function() face.sync(a,i/${fps},ctx.requestId) end)
       if ${pauseAt}>0 and index==2 and i==${pauseAt} then for _=1,6 do face.pause(a);frame() end end
      end
      frame(function() face.sync(a,line.duration,ctx.requestId) end)
      face.stop(a,'chunk-finished')
      if index<#lines then for _=1,${gapFrames} do frame() end end
     end
     face.endExpression(ctx,true)
     for _=1,${hold} do frame() end
     RESULT=table.concat(series,'\\n')`));
    assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1)));
    lua.lua_getglobal(vm, to_luastring('RESULT'));
    const rows = to_jsstring(lua.lua_tostring(vm, -1)).split('\n').map(line => line.split(',').map(Number));
    const series = {resets: rows.map(row => row[0]), dt: 1 / fps};
    BROW_KEYS.forEach((key, i) => { series[key] = rows.map(row => row[i + 1]); });
    return series;
  } finally { lua.lua_close(vm); }
}
const planOf = list => ({baseline: {}, length: list.length * 10, segments: list.map(([family, weight, seconds], index) => ({
  start: index * 10, end: index * 10 + 10, seconds, weights: {[family]: weight}, dominant: family, mixed: false, tags: ['llm-emotion']}))});
// The fastest a control may move in one game frame (the writer's own attack is about 3 per second on a full brow).
const slewPerSecond = (values, dt) => Math.max(0, ...values.slice(1).map((value, i) => Math.abs(value - values[i]) / dt));
// The deepest down-and-up (or up-and-down) swing within `window` seconds, ignoring wiggles below `eps`.
function deepestReversal(values, dt, window, eps = .02) {
  const extremes = []; let high = 0, low = 0, mode = 0;
  values.forEach((value, i) => {
    if (value > values[high]) high = i;
    if (value < values[low]) low = i;
    if (mode >= 0 && values[high] - value > eps) { extremes.push([high, values[high]]); mode = -1; low = high = i; }
    else if (mode <= 0 && value - values[low] > eps) { extremes.push([low, values[low]]); mode = 1; low = high = i; }
  });
  let best = 0;
  for (let i = 2; i < extremes.length; i++) {
    const [a, b, c] = [extremes[i - 2], extremes[i - 1], extremes[i]];
    if ((c[0] - a[0]) * dt <= window) best = Math.max(best, Math.min(Math.abs(b[1] - a[1]), Math.abs(c[1] - b[1])));
  }
  return best;
}

test('October 9: a phrase hand-off, a late native start and the reply end keep the brows, lids and squints in place (no neutral frame)', () => {
  // The user's three-phrase anger reply: 0.535, 0.300, 0.467.
  const plan = planOf([['anger', .535, 1.1], ['anger', .3, 3.6], ['anger', .467, 3.6]]);
  for (const options of [{gapFrames: 0}, {gapFrames: 6, startFrames: 5}, {gapFrames: 20, startFrames: 15}, {gapFrames: 3, pauseAt: 45}]) {
    const series = playPhrases(plan, options), label = JSON.stringify(options);
    assert.ok(series.resets.every(count => count === 0), `${label}: the native face was reset ${series.resets.at(-1)} time(s)`);
    for (const key of BROW_KEYS) {
      const values = series[key];
      if (Math.max(...values) < .1) continue;
      assert.ok(slewPerSecond(values, series.dt) < 4, `${label} ${key}: moved ${slewPerSecond(values, series.dt).toFixed(1)}/s in one frame`);
    }
    // Once the brows are down they stay down for the whole reply (the lowest point is a held brow, not a dip to 0).
    const lower = series.eye_l_brows_lower, from = Math.round(1 / series.dt), until = from + Math.round(8 / series.dt);
    assert.ok(Math.min(...lower.slice(from, until)) > .3, `${label}: brows dipped to ${Math.min(...lower.slice(from, until))}`);
  }
});

test('October 9: without a frame context (an unmanaged speaker) the end of a phrase still resets the native face', () => {
  const series = playPhrases(planOf([['anger', .5, 1], ['anger', .5, 1]]), {managed: false, hold: 10});
  assert.ok(series.resets.at(-1) >= 2, `resets ${series.resets.at(-1)}`);
});

test('October 9: a continuous stream underrun (face.pause) keeps the held expression and the idle writer going', () => run(`
 local line=${literal({...flatLine('expression-turn', 'convai-arkit61', 3), generation: owner.generation, continuous: true, complete: false})}
 face.beginExpression(context,${literal(receipt('Anger', 3, 0))})
 face.beginExpressionFrame(1/60,{actors=rows})
 assert(face.updateContinuous(context,line,a,3),face.error)
 for i=1,90 do face.beginExpressionFrame(1/60,{actors=rows});face.sync(a,i/60,context.requestId);face.updateExpressions({actors=rows}) end
 local held=last(a).eye_l_brows_lower;assert(held>.4,'angry brows '..held)
 local jaw=last(a).jaw_mid_open or 0
 local opened=jaw
 assert(jaw>.05,'the mouth was open when the stream ran dry: '..jaw)
 for i=1,60 do
  face.beginExpressionFrame(1/60,{actors=rows});face.pause(a);face.updateExpressions({actors=rows})
  assert(a.resets==0,'no native reset on an underrun')
  local now=last(a).jaw_mid_open or 0
  -- The mouth eases shut over about .12 s (no one-frame close), then stays shut.
  assert(math.abs(now-jaw)<=opened*.15+1e-6,'the jaw falls by at most 15 % of its open value per frame: '..jaw..' to '..now)
  if i>=9 then assert(now==0,'mouth closed after the release: '..now) end
  jaw=now
  assert(math.abs(last(a).eye_l_brows_lower-held)<.03,'brows held: '..last(a).eye_l_brows_lower)
 end
 -- The game's menu pause is different: the clock stops and the plain reset applies.
 face.beginExpressionFrame(1/60,{actors=rows});face.sync(a,95/60,context.requestId);assert(face.state=='playing',face.state)
 face.beginExpressionFrame(1/60,{actors=rows,paused=true});face.pause(a);assert(a.resets==1,'a paused game resets: '..a.resets)
`));

test('October 9: a same-feeling stretch does not sag and lift the brows: no reversal over .09 within 8 s, while a change of feeling still reads', () => {
  // The user's anger reply (phrases of 1.1, 3.6 and 3.6 s at .535, .300, .467). Raw, the brow-down control sags by
  // .16 and climbs back by .12; planned through the selector's settle pass it moves by half as much.
  const raw = planOf([['anger', .535, 1.1], ['anger', .3, 3.6], ['anger', .467, 3.6]]);
  const settled = planOf([['anger', .535, 1.1], ['anger', .3, 3.6], ['anger', .467, 3.6]]);
  settleCarriedFeelings(settled.segments);
  const before = playPhrases(raw, {gapFrames: 3}), after = playPhrases(settled, {gapFrames: 3});
  for (const key of ['eye_l_brows_lower', 'eye_l_brows_lateral', 'eye_l_oculi_squint_outer_upper']) {
    const sag = deepestReversal(before[key], before.dt, 8), now = deepestReversal(after[key], after.dt, 8);
    assert.ok(sag > .1, `${key}: the raw plan was expected to reverse by more than .1, got ${sag}`);
    assert.ok(now <= .09, `${key}: reverses by ${now} within 8 s`);
    assert.ok(slewPerSecond(after[key], after.dt) < 4);
  }
  // The level still follows the plan: the settled brow is lower in the mild phrase than in the first, and not flat.
  const lower = after.eye_l_brows_lower, at = seconds => lower[Math.round(seconds / after.dt)];
  assert.ok(at(8) < at(1.0) - .03 && at(8) > at(1.0) - .15, `mild phrase ${at(8)} vs first ${at(1.0)}`);
  // Trust, then joy (the user's second reply): no reversal on any brow control.
  const warmPlan = planOf([['trust', .168, 2.5], ['joy', .495, 2.95]]);
  settleCarriedFeelings(warmPlan.segments);
  const calm = playPhrases(warmPlan, {gapFrames: 3});
  for (const key of BROW_KEYS) assert.ok(deepestReversal(calm[key], calm.dt, 8) <= .09, `${key} reverses`);
  // Anger, then joy: the brows come up out of the frown and lift, within about 2.5 s of the second phrase.
  const flip = planOf([['anger', .535, 2], ['joy', .5, 3]]);
  settleCarriedFeelings(flip.segments);
  const turn = playPhrases(flip, {gapFrames: 3}), later = Math.round((2 + 2.5) / turn.dt);
  assert.ok(turn.eye_l_brows_lower[Math.round(1.9 / turn.dt)] > .4, 'angry before the change');
  assert.ok(turn.eye_l_brows_lower[later] < .12 && turn.eye_l_brows_raise_out[later] > .12, `anger -> joy: lower ${turn.eye_l_brows_lower[later]} raise ${turn.eye_l_brows_raise_out[later]}`);
});

// ---- the per-frame face context (mod/init.lua convaiExpressionFrame): reused tables, combat sampled at the rows' 0.1 s cadence
const initSource = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
const frameSource = initSource.match(/do\r?\n    local EMPTY, SAMPLE = \{\}, 0\.1[\s\S]*?\r?\nend\r?\n(?=registerForEvent\('onUpdate')/)?.[0];
function runFrame(body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const program = `
local clock, combatCalls, combat, rowsCalls = 0, 0, false, 0
os.clock = function() return clock end
local rows = {{entity = 'a'}}
companions = {expressionActors = function() rowsCalls = rowsCalls + 1; return rows end}
microphone = {state = 'idle'}
local player = {IsInCombat = function() combatCalls = combatCalls + 1; if combat == 'error' then error('native') end; return combat == true end}
${frameSource}
${body}`;
  const result = lauxlib.luaL_dostring(vm, to_luastring(program));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}

test('the face context is one reused table: no new context or actors table per frame, and no upvalue added to onUpdate', () => {
  assert.ok(frameSource, 'the frame function was not found in init.lua');
  assert.match(initSource, /local expressionContext=convaiExpressionFrame\(menuPlayer,worldReady,pending\)/);
  const update = initSource.slice(initSource.indexOf("registerForEvent('onUpdate'"));
  assert.doesNotMatch(update.slice(0, update.indexOf("mark('init:speech')")), /local expressionContext=\{|expressionActors,expressionBlocked/);
  runFrame(`
local first = convaiExpressionFrame(player, true, nil)
for _ = 1, 50 do clock = clock + 0.016; local again = convaiExpressionFrame(player, true, nil); assert(again == first, 'a new context table') end
assert(first.actors == rows, 'the actor rows are the companion module cache itself')
local off = convaiExpressionFrame(player, false, nil)
assert(off == first and off.paused == true and off.blocked == true and next(off.actors) == nil, 'not ready: no rows, blocked')
local empty = off.actors
assert(convaiExpressionFrame(player, false, nil).actors == empty, 'the not-ready actors table is one shared table too')
`);
});

test('teardown: abandonSession resets the face context, so no cached actor row (an NPC handle) outlives the session', () => {
  assert.match(initSource, /resetGaze\(\)\r?\n    if convaiExpressionReset then convaiExpressionReset\(\) end/);
  runFrame(`
local ctx = convaiExpressionFrame(player, true, nil)
assert(ctx.actors == rows and rowsCalls == 1)
convaiExpressionReset()
assert(ctx.actors ~= rows and ctx.blocked == true and ctx.paused == true and next(ctx.actors) == nil, 'the rows were kept')
clock = clock + 0.001
local again = convaiExpressionFrame(player, true, nil)
assert(rowsCalls == 2 and again.actors == rows, 'the rows are read afresh in the next session')
`);
});

test('V\'s combat is sampled at the rows cadence (0.1 s), at once on a party change, and a face reacts within 0.1 s as before', () => {
  runFrame(`
local ctx = convaiExpressionFrame(player, true, nil)
assert(combatCalls == 1 and ctx.blocked == false)
-- 60 frames at 16 ms (about 1 s) sample about ten times, not sixty
for _ = 1, 60 do clock = clock + 0.016; convaiExpressionFrame(player, true, nil) end
assert(combatCalls >= 9 and combatCalls <= 11, 'IsInCombat calls in one second: ' .. combatCalls)
-- combat starts: the face layer is told blocked within 0.1 s
combat = true
local seen
for frame = 1, 8 do clock = clock + 0.016; seen = frame; if convaiExpressionFrame(player, true, nil).blocked then break end end
assert(convaiExpressionFrame(player, true, nil).blocked == true and seen <= 7, 'blocked after ' .. seen .. ' frames')
-- combat ends: unblocked within 0.1 s
combat = false
local freed
for frame = 1, 8 do clock = clock + 0.016; freed = frame; if not convaiExpressionFrame(player, true, nil).blocked then break end end
assert(convaiExpressionFrame(player, true, nil).blocked == false and freed <= 7, 'unblocked after ' .. freed .. ' frames')
-- a rebuilt rows table (the companion module's 0.1 s rebuild or a party change) is sampled at once
combat = true; rows = {{entity = 'a'}, {entity = 'b'}}
local before = combatCalls
assert(convaiExpressionFrame(player, true, nil).blocked == true and combatCalls == before + 1, 'a party change was not sampled at once')
`);
});

test('an unknown combat state blocks, a failed rows read gives no rows, and the first ready frame reads fresh', () => runFrame(`
combat = 'error'
local ctx = convaiExpressionFrame(player, true, nil)
assert(ctx.blocked == true, 'an unreadable combat state blocks the faces')
combat = false; clock = clock + 0.2
assert(convaiExpressionFrame(player, true, nil).blocked == false)
companions.expressionActors = function() error('native') end
clock = clock + 0.2
local failed = convaiExpressionFrame(player, true, nil)
assert(next(failed.actors) == nil and failed.blocked == false, 'a failed rows read: no actors, the sampled combat state stands')
local calls = combatCalls
for _ = 1, 5 do clock = clock + 0.016; convaiExpressionFrame(player, true, nil) end
assert(combatCalls == calls, 'the empty fallback is throttled by the clock, not read every frame')
-- loading screen: forgotten, so the first ready frame samples again
convaiExpressionFrame(player, false, nil)
companions.expressionActors = function() return rows end
local n = combatCalls; combat = true
assert(convaiExpressionFrame(player, true, nil).blocked == true and combatCalls == n + 1)
-- a clock that went backwards (a reload) does not freeze the sample
clock = 0
local m = combatCalls
convaiExpressionFrame(player, true, nil)
assert(combatCalls == m + 1)
`));

test('the thinking and listening owners still reach the face layer each frame, and clear again', () => runFrame(`
local ctx = convaiExpressionFrame(player, true, {entity = '7ULL', requestId = 'r-1'})
assert(ctx.thinkingEntity == '7ULL' and ctx.thinkingRequestId == 'r-1' and ctx.listeningEntity == nil)
microphone.state = 'recording'; microphone.context = {entity = '9ULL'}
ctx = convaiExpressionFrame(player, true, nil)
assert(not ctx.thinkingEntity and not ctx.thinkingRequestId and ctx.listeningEntity == '9ULL')
microphone.state = 'idle'
assert(convaiExpressionFrame(player, true, nil).listeningEntity == nil)
`));
