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
 -- Visible, not the former invisible .025: the game's own authored smile is .10.
 assert(last(a).lips_l_corner_up>=.03 and last(a).lips_l_corner_up<=.10,last(a).lips_l_corner_up)
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
 tick(.1);assert(last(a).lips_l_corner_up>0)
 tick(.1,{listeningEntity=a.id});allZero(last(a))
`));

test('combat, injury, native dialogue and lost autonomy immediately suppress all optional expression deltas',()=>run(`
 for _,flag in ipairs({'combat','injured','dialogue','scene'}) do
  a[flag]=false;tick(.1);assert(last(a).lips_l_corner_up>0)
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
 assert(last(b).lips_l_corner_up>0 and last(b).lips_l_corner_dn==0)
 face.endExpression(context,true);for i=1,79 do tick(.1) end
 assert(last(a).lips_l_corner_up==0)
 tick(.1);tick(.1);assert(last(a).lips_l_corner_up>0)
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

test('October 6: speech without any intent still smiles, and a text cue shows at the live-tested strength', ()=>{
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
  -- No receipt: the resting smile now carries into speech (was zero).
  local none=speak(${literal(line)},'none')
  assert(none.lips_l_corner_up>=.07 and none.lips_l_corner_up<=.10,none.lips_l_corner_up)
  -- A Trust scale-2 cue (the default for warm characters): ~2x the resting smile.
  local trust=speak(${literal(warm)},'trust')
  assert(trust.lips_l_corner_up>=.12 and trust.lips_l_corner_up<=.17,'trust '..trust.lips_l_corner_up)
  -- Interest lifts the brows, not the mouth.
  local interest=speak(${literal(curious)},'interest')
  assert(interest.eye_l_brows_raise_out>=.15 and interest.lips_l_corner_up<.02,'interest '..interest.eye_l_brows_raise_out..' '..interest.lips_l_corner_up)
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
 for _=1,25 do tick(.1) end;tick(.1);assert(last(a).lips_l_corner_up<.1,'probe ends and the real policy resumes')
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
 local open=copy(last(a));assert(open.lips_l_corner_up>.3 and open.lips_l_corner_up<=.5,open.lips_l_corner_up)
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
