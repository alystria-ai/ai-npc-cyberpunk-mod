// Native core, system "faces": the Lua shim of mod/facial-playback.lua against the plugin's contract.
//
// Lockstep parity (fengari):
//   run A  the Lua path alone, a fake actor whose feature object stores float32 like the game's.
//          It records every applied frame (the feature vector after ConvaiFaceApply) and its status.
//   run B  the same scenario with the shim on and a recording fake ConvaiNativeFaces. Each Frame call is
//          answered with run A's frame, so Lua's own state moves exactly as in the game; the call's
//          arguments (the control array and the speech vector) are what the C++ core must turn back into
//          run A's vectors. They are written to native/core/tests/fixtures/faces-frames.json, which
//          native/core/tests/faces_tests.cpp replays through the plugin's core.
//   A against B  everything Lua publishes (turn record, status pose, gaze drop, blink counts) must be
//          identical, and B must call Frame exactly where A applied a frame.
// With CONVAI_WRITE_FIXTURES=1 the fixture is rewritten; otherwise the test fails if it is stale.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import fengari from 'fengari';
import {ownedExpressionReceipt} from './companion-expressions.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const faceSource = readFileSync(new URL('../mod/facial-playback.lua', import.meta.url), 'utf8');
const speechSource = readFileSync(new URL('../mod/speech.lua', import.meta.url), 'utf8');
const redsSource = readFileSync(new URL('../r6/scripts/CyberpunkConvai/FaceFeature.reds', import.meta.url), 'utf8');
const fixtureUrl = new URL('../native/core/tests/fixtures/faces-frames.json', import.meta.url);

const FIELDS = [...redsSource.matchAll(/public let (\w+): Float;/g)].map(match => match[1]);
// Lua expressionTracks order (14 base tracks, then the nine extended ones).
const TRACKS = ['lips_l_corner_up', 'lips_r_corner_up', 'lips_l_corner_dn', 'lips_r_corner_dn',
  'eye_l_brows_raise_in', 'eye_r_brows_raise_in', 'eye_l_brows_raise_out', 'eye_r_brows_raise_out',
  'eye_l_brows_lower', 'eye_r_brows_lower', 'eye_l_oculi_squint_outer_lower', 'eye_r_oculi_squint_outer_lower',
  'eye_l_widen', 'eye_r_widen',
  'eye_l_brows_lateral', 'eye_r_brows_lateral', 'eye_l_oculi_squint_outer_upper', 'eye_r_oculi_squint_outer_upper',
  'eye_l_oculi_squint_inner', 'eye_r_oculi_squint_inner', 'nose_l_snear', 'nose_r_snear', 'lips_chin_raise'];
const EXTENDED = TRACKS.slice(14);
const FAMILIES = ['joy', 'trust', 'sadness', 'anger', 'fear', 'disgust', 'surprise', 'anticipation'];

const literal = value => Array.isArray(value) ? `{${value.map(literal).join(',')}}` : value && typeof value === 'object'
  ? `{${Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `[${JSON.stringify(k)}]=${literal(v)}`).join(',')}}`
  : value === null || value === undefined ? 'nil' : typeof value === 'number' ? (Number.isInteger(value) ? `${value}.0` : String(value)) : JSON.stringify(value);

// ---- Timelines -----------------------------------------------------------------------------------------------
const MOUTH = ['jaw_mid_open', 'lips_together_up', 'lips_together_dn', 'lips_l_funnel', 'lips_r_funnel', 'lips_l_purse',
  'lips_r_purse', 'lips_apart_up', 'lips_suck_dn', 'tongue_mid_tip_up', 'lips_puff_up', 'cheek_l_puff'];
const LIMIT = {jaw_mid_open: .7, lips_together_up: 1, lips_together_dn: 1, lips_suck_dn: .8, lips_puff_up: .45, cheek_l_puff: .35};
const clamp = (value, max) => Math.max(0, Math.min(max, value));
function mouth(t, phase) {
  const syllable = Math.sin(t * 11 + phase) ** 2;
  const slow = .5 + .5 * Math.sin(t * 2.3 + phase);
  const burst = power => Math.max(0, Math.sin(t * 7.3 + phase + 1)) ** power;
  const values = [
    .06 + .6 * syllable * (.5 + .5 * slow),            // jaw
    burst(8) * .95, burst(8) * .8,                     // closure
    burst(3) * .4 * slow, burst(3) * .3 * slow,        // funnel
    Math.max(0, Math.sin(t * 5.1 + phase)) ** 4 * .35, Math.max(0, Math.sin(t * 5.1 + phase)) ** 4 * .3, // purse
    .1 * syllable, .3 * burst(6), .2 * burst(4), .3 * burst(5), .25 * burst(5)];
  return values.map((value, index) => Math.round(clamp(value, LIMIT[MOUTH[index]] ?? .5) * 1e6) / 1e6);
}
const round = value => Math.round(value * 1e6) / 1e6;
function line({id, entity, source, duration, phase = 0, expression, mix, provider, upper, segment}) {
  const times = [];
  for (let t = 0; t < duration - 1e-9; t += .05) times.push(round(t));
  times.push(duration);
  const result = {version: 1, requestId: id, entity, duration, source, tracks: MOUTH,
    frames: times.map(t => [t, ...mouth(t, phase)])};
  if (source === 'local-jali') result.articulation = 'jali-audio-v1';
  if (expression) result.expression = expression;
  if (mix) result.expressionTrack = {version: 1, format: 'emotion-mix-v1', families: FAMILIES, keys: mix};
  if (provider) {
    result.providerExpressions = {version: 1, format: 'arkit61-expression9', frames: times.map(t => [t,
      ...Array.from({length: 9}, (_, i) => round(clamp(.5 + .5 * Math.sin(t * (1.1 + i * .37) + i), 1)))])};
  }
  if (upper) {
    result.modelExpressions = {version: 1, format: 'jali-upper-v1', frames: times.map(t => [t,
      round(clamp(.35 + .5 * Math.sin(t * 1.7 + phase), 1)), round(clamp(.4 + .4 * Math.sin(t * 2.9), 1))])};
  }
  if (segment) result.segment = segment;
  return result;
}
const owner = (id, entity) => ({requestId: id, entity, generation: 4});
const receiptFor = (id, entity, emotion, scale, sequence = 0) => ownedExpressionReceipt(
  {version: 1, correlated: true, emotion, scale, sequence}, owner(id, entity));
const mixKeys = (rows) => rows.map(([t, ...weights]) => [t, ...FAMILIES.map((_, i) => weights[i] ?? 0)]);

// ---- The Lua harness -----------------------------------------------------------------------------------------
const harness = (mode, data, scenario, extra = {}) => `
local MODE=${JSON.stringify(mode)}
local DATA=${data ? literal(data) : 'nil'}
local FIELDS=${literal(FIELDS)}
local TRACKS=${literal(TRACKS)}
local LEGACY=${extra.legacy ? 'true' : 'false'}
local EXTENDED=${literal(Object.fromEntries(EXTENDED.map(name => [name, true])))}
local face,speech
local counts={method=0,read=0,write=0,native=0}
local function f32(x) return (string.unpack('<f',string.pack('<f',x))) end
local function copy(v) if type(v)~='table' then return v end;local o={};for k,x in pairs(v) do o[k]=copy(x) end;return o end
local allowed={};for _,name in ipairs(FIELDS) do allowed[name]=true end
if LEGACY then for name in pairs(EXTENDED) do allowed[name]=nil end;allowed.speech_owner=nil end
local featureSerial,featureStore=setmetatable({},{__mode='k'}),setmetatable({},{__mode='k'})
local serials=0
local function newFeature()
 serials=serials+1
 local store,object={},{}
 featureSerial[object]=serials;featureStore[object]=store
 return setmetatable(object,{
  __index=function(_,key) counts.read=counts.read+1;local v=store[key];if v==nil and allowed[key] then return 0 end;return v end,
  __newindex=function(_,key,value)
   counts.write=counts.write+1
   if not allowed[key] then error('unknown field '..tostring(key)) end
   store[key]=f32(value)
  end,
  __pairs=function() return next,store,nil end})
end
local function snapshot(feature) local store=featureStore[feature];local out={};for i,name in ipairs(FIELDS) do out[i]=store[name] or 0 end;return out end
local pending,TRACE={},{}
local world,paused,cursor=true,false,0
local function actor(id,graph)
 local a={id=id,owned=true,ready=true,alive=true,attached=true,autonomous=true,graph=graph,resets=0}
 local function cross() counts.method=counts.method+1 end
 function a:GetEntityID() cross();return {hash=self.id} end
 function a:IsAttached() cross();return self.attached end
 function a:IsDeadNoStatPool() cross();return not self.alive end
 function a:IsOnAutonomousAI() cross();return self.autonomous end
 function a:ConvaiFaceReady() cross();return self.ready end
 function a:ConvaiFaceStatus() cross();return self.graph and ('prepared:'..self.graph..'_sermo') or 'prepared:other' end
 function a:ConvaiFaceApply(feature) cross();pending[#pending+1]={actor=self.id,feature=featureSerial[feature],vector=snapshot(feature)};return true end
 function a:ConvaiFaceReset() cross();self.resets=self.resets+1;return true end
 return a
end
local a,b,player=actor('copy-a','woman_average'),actor('copy-b','woman_average'),actor('V')
function player:ConvaiManagerVoice() return true end
Game={GetPlayer=function() return player end,GetAllBlackboardDefs=function() return {UI_System={}} end,
 GetBlackboardSystem=function() return {Get=function() return {GetBool=function() return paused end} end} end,
 GetSceneSystem=function() counts.method=counts.method+1;return {GetScriptInterface=function() counts.method=counts.method+1;return {
  IsEntityInDialogue=function(_,id) counts.method=counts.method+1;return (id.hash=='copy-a' and a.dialogue) or false end,
  IsEntityInScene=function(_,id) counts.method=counts.method+1;return (id.hash=='copy-a' and a.scene) or false end} end} end}
NPCPuppet={IsInCombat=function(actor) counts.method=counts.method+1;return actor.combat or false end}
StatusEffectSystem={ObjectHasStatusEffectWithTag=function(actor,tag) counts.method=counts.method+1;return (actor.injured and tag=='Injured') or false end}
CName={new=function(v) return v end}
NewObject=function(name) assert(name=='ConvaiFaceFeature');return newFeature() end
io.open=function() return nil end
convaiCompanions={owns=function(actor) return actor.owned end}

-- The recording fake of the plugin (modes shim and exact) ---------------------------------------------------------
local EVENTS,callIndex,ENTITY_NID,NID_ENTITY={},0,{},{}
local K={on=true,failed=nil,frameResult=nil,log={}}
local checkpointNo,checkpointLive,TURN_NID=0,false,nil
if MODE~='lua' then
 convaiNative={use=function(name) return name=='faces' and K.on end,
  fail=function(name,why) K.failed=tostring(why);K.on=false;K.log[#K.log+1]='fail '..tostring(why) end}
 local function exactSafe(actor)
  if not actor.autonomous or actor.combat then return 0 end
  if actor.dialogue or actor.scene or actor.injured then return 0 end
  return 1
 end
 ConvaiNativeFaces={
  Check=function(c,v) return #c*1000+#v end,
  Speaker=function(actor,entity)
   counts.native=counts.native+1
   if MODE~='exact' then return -1 end
   return (actor.id==entity and actor.attached and actor.alive and actor.ready) and 1 or 0
  end,
  Safe=function(actor) counts.native=counts.native+1;counts.safe=(counts.safe or 0)+1;if MODE~='exact' then return -1 end;return exactSafe(actor) end,
  Frame=function(actor,feature,nid,c,v)
   counts.frames=(counts.frames or 0)+1
   counts.native=counts.native+1
   if K.frameResult then return K.frameResult(actor,feature,nid,c,v) end
   callIndex=callIndex+1
   local e=DATA.trace[callIndex]
   assert(e,'more native frames than the Lua path applied: '..callIndex)
   assert(e.actor==actor.id,'call '..callIndex..' is for '..actor.id..', the Lua path applied '..e.actor)
   assert(e.feature==featureSerial[feature],'call '..callIndex..' used another feature object')
   assert(#c==31,'control array length '..#c)
   for i=1,31 do assert(type(c[i])=='number' and c[i]==c[i] and c[i]~=math.huge and c[i]~=-math.huge,'control '..i..' at call '..callIndex) end
   local flags=c[3]
   assert((flags%2>=1)==(e.phase=='speaking'),'speaking flag at call '..callIndex)
   assert((flags%4>=2)==e.blocked,'blocked flag at call '..callIndex)
   local speech
   if flags%2>=1 then assert(#v==60,'speech vector length '..#v);speech=copy(v) end
   NID_ENTITY[nid],ENTITY_NID[actor.id]=actor.id,nid
   EVENTS[#EVENTS+1]={t='frame',nid=nid,feature=e.feature,ctl=copy(c),speech=speech,expected=e.vector,status=e.status}
   if MODE=='exact' then local store=featureStore[feature];for i,name in ipairs(FIELDS) do store[name]=e.vector[i] end end
   return e.status
  end,
  Turn=function(nid) if checkpointLive then TURN_NID=nid;return DATA.turn[checkpointNo] or '' end;return '' end,
  Applied=function(nid) if checkpointLive then return (DATA.applied[checkpointNo] or {})[NID_ENTITY[nid]] or '' end;return '' end,
  ZeroPose=function(nid) EVENTS[#EVENTS+1]={t='zero',nid=nid};return true end,
  NoteReset=function(nid) EVENTS[#EVENTS+1]={t='noteReset',nid=nid};return true end,
  Release=function(nid) EVENTS[#EVENTS+1]={t='release',nid=nid};return true end,
  Clear=function() EVENTS[#EVENTS+1]={t='clear'};return true end,
 }
end

face=(function() ${faceSource} end)()
local captions={clear=function() end,clearEntity=function() end,show=function() end,enabled=function() return false end,
 beginTimed=function() end,syncTimed=function() end}
dofile=function(path) if path=='facial-playback.lua' then return face end;return captions end
speech=(function() ${speechSource} end)();speech.available=true
do local seed=20261012.0;face.blinkRandom=function() seed=(seed*16807.0)%2147483647.0;return seed/2147483647.0 end end
local rows={{entity=a.id,npc=a,profileKey='default-woman'},{entity=b.id,npc=b,profileKey='judy-alvarez'}}
-- A reply's mouth, driven on the facial player directly the way a heard voice drives it: face.start with the reply's timeline,
-- then face.sync at the heard position every frame (here the test's cursor), and the one stop at its end. The frame's expression
-- work around it is what speech.update does (face.beginExpressionFrame, the speaking step, face.updateExpressions).
local V
local function vstop(reason)
 face.endExpression(V and V.ctx,reason=='finished')
 face.stop(V and V.actor,reason)
 V=nil
end
local function vstart(ctx,who,line,duration)
 vstop(nil)
 V={ctx={requestId=ctx.requestId,generation=ctx.generation,entity=ctx.entity,name=ctx.name},actor=who,id=ctx.requestId,
  duration=duration,playing=false}
 face.beginExpression(V.ctx,nil)
 assert(face.start(ctx,line,who,duration,nil),face.error)
end
local function vstep()
 if not V then return end
 local at=cursor
 if not V.playing and at>.001 then V.playing=true end
 if V.playing then face.sync(V.actor,at,V.id) end
 if at>=V.duration-.005 then vstop('finished') end
end
local function tick(dt,options)
 options=options or {};options.actors=options.actors or rows;options.paused=paused
 face.beginExpressionFrame(dt,options)
 vstep()
 face.updateExpressions(options)
end
local function statusOf(slot)
 local code=1
 if slot.settled then code=code+2 end
 local inner,down=slot.pose.eye_l_brows_raise_in or 0,slot.pose.lips_l_corner_dn or 0
 if inner<.2 then code=code+4 end
 if inner>.35 then code=code+8 end
 if down>.15 then code=code+16 end
 return code
end
local function finalize()
 for _,entry in ipairs(pending) do TRACE[#TRACE+1]=entry end
 pending={}
end
if MODE=='lua' then
 face._observe=function(entity,phase,blocked,slot)
  local entry=pending[#pending]
  assert(entry and entry.actor==entity,'observed frame without an apply')
  entry.phase,entry.blocked,entry.status=phase,blocked,statusOf(slot)
 end
end
local function step(dt,options) tick(dt,options);finalize() end

local function ser(v)
 local kind=type(v)
 if kind=='number' then return string.format('%.17g',v) end
 if kind=='boolean' then return tostring(v) end
 if kind=='string' then return '"'..v:gsub('[%c"\\\\]',function(c) return string.format('\\\\u%04x',c:byte()) end)..'"' end
 if kind=='table' then
  local n=#v
  if n>0 then local out={};for i=1,n do out[i]=ser(v[i]) end;return '['..table.concat(out,',')..']' end
  local keys={};for k in pairs(v) do keys[#keys+1]=tostring(k) end;table.sort(keys)
  local out={};for _,k in ipairs(keys) do local x=v[k];if x==nil then x=v[tonumber(k)] end;out[#out+1]=ser(k)..':'..ser(x) end
  return '{'..table.concat(out,',')..'}'
 end
 return 'null'
end
local CP,TURN_STR,APPLIED_STR={},{},{}
local function numbers(list) local out={};for i,x in ipairs(list) do out[i]=string.format('%.17g',x) end;return table.concat(out,' ') end
local function checkpoint(label)
 checkpointNo=checkpointNo+1
 local turn=face.lastSpeechExpression
 if MODE=='lua' then
  local list={turn and turn.jawPeak or 0,turn and turn.openFrames or 0}
  for i,track in ipairs(TRACKS) do list[2+i]=turn and turn.peak[track] or 0 end
  TURN_STR[checkpointNo]=numbers(list)
  local applied={}
  for _,id in ipairs({a.id,b.id}) do
   local slot=face.expressions[id]
   if slot and slot.appliedPose then
    local values={};for i,track in ipairs(TRACKS) do values[i]=slot.appliedPose[track] or 0 end
    applied[id]=numbers(values)
   end
  end
  APPLIED_STR[checkpointNo]=applied
 end
 checkpointLive=true;TURN_NID=nil
 local state=face.status()
 local result={label=label,state=state.state,applied=state.applied,blinks=state.blinks,restBlinks=state.restBlinks,
  lastSpeech=state.expressions.lastSpeech,
  poseA=face.expressionStatus(a.id),poseB=face.expressionStatus(b.id),gazeA=face.gazeDrop(a.id),gazeB=face.gazeDrop(b.id),
  clock=face.expressionClock}
 checkpointLive=false
 if MODE~='lua' then
  local entry={t='checkpoint',applied={}}
  local source=DATA.turn[checkpointNo]
  if source and turn and TURN_NID then
   local list={};for token in source:gmatch('%S+') do list[#list+1]=tonumber(token) end
   entry.nid=TURN_NID;entry.turn=list
  end
  for id,text in pairs(DATA.applied[checkpointNo] or {}) do
   local list={};for token in text:gmatch('%S+') do list[#list+1]=tonumber(token) end
   if ENTITY_NID[id] then entry.applied[#entry.applied+1]={nid=ENTITY_NID[id],values=list} end
  end
  EVENTS[#EVENTS+1]=entry
 end
 CP[#CP+1]=ser(result)
end

${scenario}
finalize()
return ser({trace=TRACE,turn=TURN_STR,applied=APPLIED_STR,checkpoints=CP,events=EVENTS,counts=counts,failed=K.failed,
 serials=serials,log=K.log})
`;

function runLua(source) {
  const vm = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(vm);
  try {
    const status = lauxlib.luaL_dostring(vm, to_luastring(source));
    const text = to_jsstring(lua.lua_tostring(vm, -1));
    assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? '' : text);
    return JSON.parse(text);
  } finally { lua.lua_close(vm); }
}

// ---- The scenarios ---------------------------------------------------------------------------------------------
const reply = ({id, entity, who, source, duration, emotion, scale, mix, provider, upper, phase, segment}) => {
  const expression = emotion ? receiptFor(id, entity, emotion, scale) : undefined;
  return {id, entity, who, line: line({id, entity, source, duration, phase, expression, mix, provider, upper, segment})};
};
const play = (spec, extra = '') => `
 do
  local ctx={requestId=${JSON.stringify(spec.id)},entity=${JSON.stringify(spec.entity)},generation=4}
  vstart(ctx,${spec.who},${literal(spec.line)},${spec.line.duration})
  local t,total=0,${spec.line.duration}
  local STEP=1/30
  while t<total+.1 do
   t=t+STEP;cursor=math.min(t,total)
   ${extra}
   step(STEP)
  end
  vstop('finished')
 end`;

const mainScenario = () => {
  const r1 = reply({id: 'r1', entity: 'copy-a', who: 'a', source: 'convai-arkit61', duration: 2.4, emotion: 'Joy', scale: 3, provider: true, phase: .3});
  const r2 = reply({id: 'r2', entity: 'copy-a', who: 'a', source: 'local-jali', duration: 5, emotion: 'Sadness', scale: 2, upper: true, phase: 1.1,
    mix: mixKeys([[0, 0, 0, 1], [1, 0, 0, .6, .5], [2, 0, 0, 0, 1], [3, 0, 0, 0, .3, 0, .2, .9], [3.6, 0, 0, 0, 0, 0, 0, .3, .8],
      [4.2, .9, .3], [5, .4, .2, 0, 0, 0, 0, 0, 0]])});
  const r3 = reply({id: 'r3', entity: 'copy-b', who: 'b', source: 'convai-arkit61', duration: 2.8, emotion: 'Anger', scale: 3, provider: true, upper: true, phase: 2.2});
  const r4 = reply({id: 'r4', entity: 'copy-a', who: 'a', source: 'audio-envelope', duration: 3, emotion: 'Surprise', scale: 2, upper: true, phase: 3.3});
  const r5 = reply({id: 'r5', entity: 'copy-b', who: 'b', source: 'local-jali', duration: 2, emotion: 'Fear', scale: 3, phase: 4.4,
    mix: mixKeys([[0, 0, 0, 0, 0, .8], [1, .1, 0, .2, 0, .7, .2], [2, 0, 0, .3, .4]])});
  return `
 for _=1,25 do step(.1) end
 checkpoint('idle')
 for _=1,5 do step(.1,{listeningEntity=a.id}) end
 for _=1,5 do step(.1,{thinkingEntity=b.id,thinkingRequestId='next'}) end
 ${play(r1)}
 checkpoint('joy reply with provider brows')
 for _=1,40 do step(.1) end
 checkpoint('joy expiry')
 ${play(r2, `
   if t>1.5 and t<1.7 then a.combat=true else a.combat=false end
   if t>2.6 and t<3.2 then cursor=2.6 end
 `)}
 checkpoint('mixed sad reply, blocked and stalled')
 for _=1,30 do step(.1) end
 checkpoint('mood hold')
 ${play(r3)}
 checkpoint('anger reply (default trait of Judy)')
 for _=1,60 do step(.1) end
 step(.1,{paused=true});paused=true;for _=1,3 do step(.1) end;paused=false
 for _=1,3 do step(.1,{blocked=true}) end
 a.injured=true;for _=1,3 do step(.1) end;a.injured=false;for _=1,3 do step(.1) end
 checkpoint('paused, blocked, injured')
 ${play(r4)}
 checkpoint('surprise flick')
 do -- cancelled mid-reply: the plain reset path and the idle hand-over
  local ctx={requestId='r6',entity='copy-a',generation=4}
  vstart(ctx,a,${literal(reply({id: 'r6', entity: 'copy-a', who: 'a', source: 'local-jali', duration: 2, emotion: 'Joy', scale: 1, upper: true, phase: 5.5}).line)},2)
  for i=1,30 do cursor=i/30;step(1/30) end
  vstop('cancelled')
  for _=1,10 do step(.1) end
 end
 ${play(r5)}
 checkpoint('fear reply with a mix, trait of Judy')
 a.ready=false;for _=1,3 do step(.1) end;a.ready=true;for _=1,3 do step(.1) end
 speech.clearEntity(b.id)
 for _=1,10 do step(.1) end
 checkpoint('end')
`;
};

let cached;
function scenarioRuns() {
  if (cached) return cached;
  const scenario = mainScenario();
  const luaRun = runLua(harness('lua', null, scenario));
  const data = {trace: luaRun.trace, turn: luaRun.turn, applied: luaRun.applied};
  const shimRun = runLua(harness('shim', data, scenario));
  const exactRun = runLua(harness('exact', data, scenario));
  cached = {luaRun, shimRun, exactRun, scenario};
  return cached;
}

const near = (actual, expected, path = '') => {
  if (typeof expected === 'number') {
    assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= 1e-9, `${path}: ${actual} !== ${expected}`);
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual) && actual.length === expected.length, `${path}: length`);
    expected.forEach((item, index) => near(actual[index], item, `${path}[${index}]`));
  } else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path}: keys`);
    for (const key of Object.keys(expected)) near(actual[key], expected[key], `${path}.${key}`);
  } else {
    assert.equal(actual, expected, path);
  }
};

test('the Lua FIELD table is the declaration order of FaceFeature.reds', () => {
  assert.equal(FIELDS.length, 60);
  const match = faceSource.match(/local FIELD=\{([^}]*)\}/);
  assert.ok(match, 'FIELD table');
  const table = Object.fromEntries([...match[1].matchAll(/(\w+)=(\d+)/g)].map(([, name, index]) => [name, Number(index)]));
  assert.deepEqual(Object.keys(table), FIELDS);
  FIELDS.forEach((name, index) => assert.equal(table[name], index + 1, name));
  assert.deepEqual(TRACKS.slice(0, 14).concat(EXTENDED), TRACKS);
  const extended = faceSource.match(/local extendedTracks = \{([^}]*)\}/s)[1].match(/'(\w+)'/g).map(text => text.slice(1, -1));
  assert.deepEqual(extended, EXTENDED);
});

test('the shim answers the Lua path frame for frame: same applied frames, same published state', () => {
  const {luaRun, shimRun, exactRun} = scenarioRuns();
  assert.ok(luaRun.trace.length > 400, `frames ${luaRun.trace.length}`);
  for (const run of [shimRun, exactRun]) {
    assert.equal(run.failed, undefined, 'the shim must not switch itself off');
    assert.equal(run.counts.frames, luaRun.trace.length, 'one Frame call per applied frame');
    assert.equal(run.events.filter(event => event.t === 'frame').length, luaRun.trace.length);
    assert.equal(run.serials, luaRun.serials, 'the same feature objects');
    near(run.checkpoints.map(text => JSON.parse(text)), luaRun.checkpoints.map(text => JSON.parse(text)), 'checkpoints');
  }
  // Both frame types were exercised.
  const speaking = luaRun.trace.filter(entry => entry.phase === 'speaking').length;
  assert.ok(speaking > 200 && luaRun.trace.length - speaking > 100, `speaking ${speaking} of ${luaRun.trace.length}`);
  assert.ok(luaRun.trace.some(entry => entry.blocked), 'a blocked frame');
  assert.ok(luaRun.trace.some(entry => entry.status & 2), 'a settled frame');
  assert.ok(luaRun.trace.some(entry => entry.status & 8) && luaRun.trace.some(entry => entry.status & 16), 'gaze bits both ways');
});

test('a Frame call replaces the property and method crossings of a frame', () => {
  const {luaRun, shimRun, exactRun} = scenarioRuns();
  const frames = luaRun.trace.length;
  const total = counts => counts.method + counts.read + counts.write + counts.native;
  const lua = total(luaRun.counts), exact = total(exactRun.counts), shim = total(shimRun.counts);
  console.log(`faces crossings per applied frame: Lua ${(lua / frames).toFixed(1)}, native ${(exact / frames).toFixed(1)} `
    + `(${frames} frames, native = Frame + Speaker + Safe calls and the one-time detection; with Lua-side checks ${(shim / frames).toFixed(1)})`);
  assert.ok(exact < lua * .12, `native ${exact} vs Lua ${lua}`);
  assert.ok(exact / frames < 8, `crossings per frame ${exact / frames}`);
  assert.ok(lua / frames > 40, `Lua crossings per frame ${lua / frames}`);
});

test('a plugin that cannot answer Safe (-1) is not asked on every frame: the Lua check decides, and the question comes back only now and then', () => {
  const {luaRun, shimRun, exactRun} = scenarioRuns();
  const frames = luaRun.trace.length;
  assert.ok(exactRun.counts.safe > frames * .5, `an exact plugin is asked about nearly every frame: ${exactRun.counts.safe} of ${frames}`);
  const clock = JSON.parse(shimRun.checkpoints.at(-1)).clock;
  assert.ok(clock > 30, `the scenario spans ${clock} s of expression time`);
  // One question per 30 s of expression time at most, plus the first.
  assert.ok(shimRun.counts.safe <= Math.ceil(clock / 30) + 1, `asked ${shimRun.counts.safe} times in ${clock} s over ${frames} frames`);
  assert.ok(shimRun.counts.safe >= 1);
});

test('the fixture for the C++ core is current', () => {
  const {luaRun, shimRun} = scenarioRuns();
  const fixture = {system: 'faces', source: 'mod/facial-playback.lua', cases: [
    {name: 'main', input: {fields: FIELDS, tracks: TRACKS, events: shimRun.events}, output: {frames: luaRun.trace.length}}]};
  const text = JSON.stringify(fixture);
  if (process.env.CONVAI_WRITE_FIXTURES === '1') {
    writeFileSync(fixtureUrl, text);
    return;
  }
  assert.ok(existsSync(fixtureUrl), 'fixture missing: run with CONVAI_WRITE_FIXTURES=1');
  assert.equal(readFileSync(fixtureUrl, 'utf8'), text, 'fixture is stale: run with CONVAI_WRITE_FIXTURES=1');
});

test('an older install without the extended controls and speech_owner keeps working natively', () => {
  const scenario = `
 for _=1,20 do step(.1) end
 ${play(reply({id: 'o1', entity: 'copy-a', who: 'a', source: 'local-jali', duration: 1.5, emotion: 'Anger', scale: 2, upper: true}))}
 for _=1,20 do step(.1) end
 checkpoint('legacy')`;
  const luaRun = runLua(harness('lua', null, scenario, {legacy: true}));
  const data = {trace: luaRun.trace, turn: luaRun.turn, applied: luaRun.applied};
  const shimRun = runLua(harness('shim', data, scenario, {legacy: true}));
  assert.equal(shimRun.failed, undefined);
  assert.equal(shimRun.counts.frames, luaRun.trace.length);
  for (const event of shimRun.events.filter(item => item.t === 'frame')) {
    assert.equal(event.ctl[2] % 512 >= 256, false, 'extended flag off');
    assert.equal(event.ctl[2] % 2048 >= 1024, false, 'owner flag off');
  }
});

// ---- Fallbacks and the kill switch -----------------------------------------------------------------------------
const quick = (mode, body, extra) => runLua(harness(mode, {trace: [], turn: {}, applied: {}}, body, extra));

test('every failure of the plugin hands the frame to the Lua path without losing it', () => {
  const idle = 'for _=1,3 do step(.1) end';
  // A Frame call that raises (a conversion error inside CET): the Lua path applies the frame, the system switches off.
  let result = quick('shim', `K.frameResult=function() error('cannot convert array') end
   ${idle}
   assert(K.on==false,'switched off');assert(#TRACE>=3,'Lua applied the frames: '..#TRACE)`);
  assert.match(result.failed, /cannot convert array/);
  // The game side is unavailable (-3): the same.
  result = quick('shim', `K.frameResult=function() return -3 end
   ${idle}
   assert(K.on==false);assert(#TRACE>=3)`);
  assert.match(result.failed, /unavailable/);
  // A malformed result.
  result = quick('shim', `K.frameResult=function() return 'x' end
   ${idle}
   assert(K.on==false);assert(#TRACE>=3)`);
  assert.match(result.failed, /unexpected result/);
  // The game rejected the frame (-1) and a fault (-2): like the Lua assert, the frame errors; nothing is applied twice.
  for (const code of [-1, -2]) {
    result = quick('shim', `K.frameResult=function() return ${code} end
     local count=0
     for _=1,3 do step(.1) end
     assert(face.expressionError~=nil,'the error is published');assert(#TRACE==0,'nothing applied by Lua')`);
    assert.equal(result.failed, undefined, 'a rejected frame is not a reason to switch off');
  }
  // The class is missing, or its arrays do not arrive intact.
  result = quick('shim', `ConvaiNativeFaces=nil;${idle};assert(K.on==false);assert(#TRACE>=3)`);
  assert.match(result.failed, /not registered/);
  result = quick('shim', `ConvaiNativeFaces.Check=function() return 7 end;${idle};assert(K.on==false);assert(#TRACE>=3)`);
  assert.match(result.failed, /array check failed/);
});

test('the first native Safe answers are compared with the Lua check: a plugin that says safe in combat puts faces on Lua, an agreeing one is trusted', () => {
  // Until the plugin could read the combat flag it answered -1 and the Lua check decided every frame, so Safe's other checks
  // (scene, dialogue, injury) never ran in the game: its first 40 answers are checked, and the Lua answer is the one used.
  const wrong = quick('shim', `
   a.combat=true
   ConvaiNativeFaces.Safe=function() counts.safeAsked=(counts.safeAsked or 0)+1;return 1 end
   K.frameResult=function() return 1 end
   for _=1,6 do step(.1) end
   assert(K.on==false,'switched off');assert(counts.safeAsked>=1)`);
  assert.match(wrong.failed, /Safe answered 1 where the Lua check says false/);
  const right = quick('shim', `
   ConvaiNativeFaces.Safe=function(actor) counts.safeAsked=(counts.safeAsked or 0)+1;return actor.combat and 0 or 1 end
   K.frameResult=function() return 1 end
   local combatReads,real=0,NPCPuppet.IsInCombat
   NPCPuppet.IsInCombat=function(x) combatReads=combatReads+1;return real(x) end
   for _=1,120 do step(.1) end
   assert(K.on==true,'still native');assert(counts.safeAsked>=45,'asked '..tostring(counts.safeAsked))
   local settled=combatReads
   assert(settled>=40,'the first answers were compared with the Lua check: '..settled)
   for _=1,40 do step(.1) end
   -- after the 40 compared answers the Lua check is no longer run beside the plugin: no more IsInCombat reads
   assert(combatReads==settled,'trusted: '..combatReads..' reads, '..settled..' before')`);
  assert.equal(right.failed, undefined);
});

test('the kill switch returns to the Lua path and back, and restarts the pose from neutral on each flip', () => {
  const result = quick('shim', `
   K.frameResult=function(actor,feature,nid,c,v) counts.fake=(counts.fake or 0)+1;return 1 end
   for _=1,12 do step(.1) end
   local native=counts.fake;assert(native>0 and #TRACE==0,'native frames only: '..native..' '..#TRACE)
   K.on=false
   step(.1);local slot=face.expressions[a.id]
   assert(#TRACE>=1,'Lua frames after the switch is off')
   for _,v in pairs(slot.pose) do assert(v<.06,'restarted near neutral: '..v) end
   local lua=#TRACE;for _=1,12 do step(.1) end
   assert(#TRACE>lua,'Lua keeps applying')
   K.on=true
   local before=counts.fake;for _=1,12 do step(.1) end
   assert(counts.fake>before,'native again')
   local clears=0;for _,e in ipairs(EVENTS) do if e.t=='clear' then clears=clears+1 end end
   assert(clears==3,'cleared on enabling and on each flip: '..clears)`);
  assert.equal(result.failed, undefined);
});

test('Lua-side calls to the native core carry the slot id and never break the Lua path', () => {
  const result = quick('shim', `
   K.frameResult=function() return 1 end
   for _=1,3 do step(.1) end
   face.endExpression({requestId='x',generation=0,entity=a.id},false)
   speech.clearEntity(a.id)
   local kinds={};for _,e in ipairs(EVENTS) do kinds[e.t]=(kinds[e.t] or 0)+1 end
   assert(kinds.release==1,'released the slot')
   ConvaiNativeFaces.ZeroPose=function() error('x') end
   ConvaiNativeFaces.Release=function() error('x') end
   for _=1,3 do step(.1) end;speech.clearEntity(b.id)`);
  assert.equal(result.failed, undefined);
});
