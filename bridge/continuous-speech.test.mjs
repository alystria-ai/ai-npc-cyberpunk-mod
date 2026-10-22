import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {ConvaiContinuousSpeech} from './convai-continuous-speech.mjs';

const source = name => readFileSync(new URL(`../mod/${name}.lua`, import.meta.url), 'utf8');
const setup = `
local files,values,serial,wall={},{},0,1000
local function clone(v)if type(v)~='table'then return v end;local o={};for k,x in pairs(v)do o[k]=clone(x)end;return o end
json={encode=function(v)serial=serial+1;local k=tostring(serial);values[k]=clone(v);return k end,
 decode=function(k)return clone(assert(values[k]))end}
local controls,failWrite={},false
io.open=function(path,mode)
 if mode=='rb'then if not files[path]then return nil end;return {read=function()return files[path]end,close=function()return true end}end
 if failWrite then return nil end
 return {write=function(_,raw)files[path]=raw
  if path=='runtime/continuous-control.json'then controls[#controls+1]=json.decode(raw)end;return true end,close=function()return true end}
end
os.time=function()return math.floor(wall)end
os.remove=function(path)files[path]=nil;return true end
os.rename=function(a,b)
 if not files[a]then return nil end;files[b],files[a]=files[a],nil
 if b=='runtime/continuous-control.json'then controls[#controls+1]=json.decode(files[b])end
 return true
end
local function put(path,v)files[path]=json.encode(v)end
local function read(path)return files[path]and json.decode(files[path])end
local world,paused,voice,settings,master,dialogue=true,false,true,true,80,50
local nativeCalls,nativeStarts,nativeStops,nativeCursor,features=0,0,0,0,0
local function native()assert(world,'Native read during unload');nativeCalls=nativeCalls+1 end
local function actor(id,x,y)
 local a={id=id,attached=true,alive=true,owned=true,pos={x=x,y=y,z=0},applied={},resets=0}
 function a:GetEntityID()native();return {hash=self.id}end
 function a:IsAttached()native();return self.attached end
 function a:IsDeadNoStatPool()native();return not self.alive end
 function a:GetWorldPosition()native();return self.pos end
 function a:ConvaiFaceReady()native();return self.ready~=false end
 function a:ConvaiFaceReset()native();self.resets=self.resets+1;return true end
 function a:ConvaiFaceApply(f)native();self.applied[#self.applied+1]=clone(f);return true end
 return a
end
local player,judy=actor('V',0,0),actor('Judy-2',2,0)
function player:ConvaiManagerVoice()native();return voice end
function player:ConvaiSpeechStart()native();nativeStarts=nativeStarts+1;return true end
function player:ConvaiSpeechStop()native();nativeStops=nativeStops+1 end
function player:ConvaiSpeechPause()native()end
function player:ConvaiSpeechPosition()native();return nativeCursor end
local currentPlayer=player
Game={GetPlayer=function()return currentPlayer end,GetAllBlackboardDefs=function()return {UI_System={IsInMenu='menu'}}end,
 GetBlackboardSystem=function()return {Get=function()return {GetBool=function()return paused end}end}end,
 GetTargetingSystem=function()return {GetCrosshairData=function()native();return player.pos,{x=0,y=1,z=0}end}end,
 GetSettingsSystem=function()
  assert(settings,'No settings API');return {GetGroup=function(_,group)
   assert(group=='/audio/volume');return {GetVar=function(_,key)
    assert(key=='MasterVolume'or key=='DialogueVolume');return {GetValue=function()return key=='MasterVolume'and master or dialogue end}
   end}
  end}
 end}
CName={new=function(v)return v end}
NewObject=function(name)assert(name=='ConvaiFaceFeature');features=features+1;return {}end
convaiCompanions={owns=function(a)return a.owned end}
local captions={line=nil,timed=nil,clears=0,positions={},starts=0}
function captions.clear()captions.line,captions.timed=nil,nil;captions.clears=captions.clears+1 end
function captions.show(name,text)captions.line=text end
function captions.clearEntity()captions.clear()end
function captions.enabled()return true end
function captions.beginTimed(name,text,duration,a,entity)
 assert(a==judy and entity==judy.id);captions.timed={duration=duration};captions.line=text;captions.starts=captions.starts+1
end
function captions.reviseTimed(text,duration)captions.line=text;captions.timed.duration=duration;return true end
function captions.syncTimed(position)captions.positions[#captions.positions+1]=position end
local controller=(function()${source('continuous-speech')}end)()
controller.now=function()return wall end
local face=(function()${source('facial-playback')}end)()
dofile=function(path)
 if path=='continuous-speech.lua'then return controller end
 if path=='facial-playback.lua'then return face end
 if path=='subtitles.lua'then return captions end
 error('Unexpected module '..path)
end
local speech=(function()${source('speech')}end)()
local group=(function()${source('group-chat')}end)()
group.captureReply=speech.transcript
speech.available=true;speech.target=judy
local id='12345678-1234-1234-1234-123456789abc'
local context={requestId='conversation-1',entity=judy.id,generation=7,name='Judy'}
local function begin()
 speech.target=judy
 return speech.start(context,{text='Hello',continuous={version=1,id=id}})
end
local function snapshot(changes)
 local value={version=1,id=id,requestId=context.requestId,entity=context.entity,generation=context.generation,
  updated=wall*1000,state='playing',position=.2,bufferedDuration=2,text='Hello V.',textComplete=false,
  complete=false,ended=false,underruns=0}
 for k,v in pairs(changes or {})do value[k]=v end
 put('runtime/continuous-speech.json',value)
 return value
end
local function tick(delta)wall=wall+(delta or .05);speech.update(delta or .05)end
local function control()return controls[#controls]end
local function state()return read('runtime/speech-state.json')end
local function timeline(duration,complete)
 return {version=1,continuous=true,complete=complete,requestId=context.requestId,entity=context.entity,generation=context.generation,
  duration=duration,source='convai-arkit61',tracks={'jaw_mid_open'},frames={{0,.1},{duration,.2}}}
end
`;

function run(body) {
  const {lua,lauxlib,lualib,to_luastring,to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate();lualib.luaL_openlibs(vm);
  const status=lauxlib.luaL_dostring(vm,to_luastring(setup+'\n'+body));
  const error=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(vm,-1));
  lua.lua_close(vm);assert.equal(status,lua.LUA_OK,error);
}

test('explicit cadence seam returns only cached numerical playback data and clears with ownership',()=>run(`
  assert(speech.diagnosticCadence()==nil and controller.diagnosticCadence()==nil)
  assert(begin());local first=speech.diagnosticCadence()
  assert(first.reads==0 and first.acceptedReads==0 and first.updated==nil)
  snapshot({face=timeline(2,false),position=.25})
  tick(.02);assert(speech.diagnosticCadence().reads==0)
  tick(.02);local before=nativeCalls;local read=speech.diagnosticCadence()
  assert(nativeCalls==before and read.reads==1 and read.acceptedReads==1)
  assert(read.position==.25 and read.confirmedTarget==.25 and read.speechPosition==.25)
  assert(read.sourceFrames==2 and read.duration==2 and read.state=='playing')
  local allowed={reads=true,acceptedReads=true,updated=true,position=true,duration=true,
    sourceFrames=true,sourceComplete=true,state=true,wait=true,poll=true,
    confirmedTarget=true,faceCursor=true,speechPosition=true}
  for key,value in pairs(read)do
    assert(allowed[key],'unexpected cadence output '..tostring(key))
    assert(type(value)=='number'or type(value)=='boolean'or key=='state')
  end
  snapshot({position=-1});tick(.04);read=speech.diagnosticCadence()
  assert(read.reads==2 and read.acceptedReads==1 and read.position==.25)
  speech.stop('cancelled');assert(speech.diagnosticCadence()==nil and controller.diagnosticCadence()==nil)
  world=false;assert(speech.diagnosticCadence()==nil and controller.diagnosticCadence()==nil)
`));

// Exercise the actual JavaScript publisher/builder against the Lua consumer.
// Hand-built face fixtures alone missed a required ownership field on the wire.
const luaValue = value => Array.isArray(value) ? `{${value.map(luaValue).join(',')}}`
  : value && typeof value === 'object' ? `{${Object.entries(value).filter(([,v])=>v!==undefined)
    .map(([k,v])=>`[${JSON.stringify(k)}]=${luaValue(v)}`).join(',')}}`
  : value == null ? 'nil' : JSON.stringify(value);

test('real continuous publisher facial data is accepted by the actual Lua playback and rig owner', async()=>{
  const input={requestId:'conversation-1',entity:'Judy-2',generation:7};
  const token='12345678-1234-1234-1234-123456789abc';
  let wire,reply;
  const publisher=new ConvaiContinuousSpeech({input,profile:{key:'judy'},token,now:()=>1000000,
    current:async()=>true,readControl:async()=>'{}',
    writeState:async value=>{wire=structuredClone(value);return true;},
    writeReply:async value=>{reply=structuredClone(value);return true;}});
  const faces=Array.from({length:121},(_,index)=>{
    const values=Array(61).fill(0);values[17]=.4;
    values[29]=.5;values[30]=.25;values[31]=.3;
    values[18]=.25;values[39]=.4;values[40]=.2;values[32]=.1;values[37]=.5;values[38]=.2;
    return {at:index/60,values};
  });
  await publisher.frame({version:1,token,sampleRate:24000,channels:1,receivedFrames:48000,
    positionSeconds:.2,text:'Hello V.',textComplete:false,sourceComplete:false,ended:false,
    underruns:0,state:'playing',faces,facesFormat:'arkit61',facesTimebase:'audio-seconds'});
  assert(wire.face,'The production publisher must include its provider facial timeline');
  run(`
    assert(speech.start(context,${luaValue(reply)}))
    put('runtime/continuous-speech.json',${luaValue(wire)});tick()
    assert(face.active,'Production timeline rejected: '..tostring(face.error))
    assert(features==1 and #judy.applied==1 and judy.applied[1].jaw_mid_open>0)
    local native=judy.applied[1]
    assert(math.abs(native.lips_l_stretch-.07)<.000001)
    assert(math.abs(native.lips_l_corner_stretch-.1725)<.000001)
    assert(math.abs(native.lips_r_corner_stretch-.115)<.000001)
    assert(math.abs(native.lips_suck_dn-.06)<.000001)
    assert(math.abs(native.lips_together_up-.68)<.000001 and math.abs(native.lips_together_dn-.68)<.000001)
    assert(math.abs(native.lips_l_upper_raise-.0257)<.000001 and math.abs(native.lips_r_upper_raise-.015)<.000001)
    assert(math.abs(native.lips_suck_up-.0214)<.000001)
    assert(math.abs(native.lips_l_lower_raise-.06)<.000001 and math.abs(native.lips_r_lower_raise-.03)<.000001)
    assert(math.abs(native.jaw_mid_open-.3478)<.000001)
    assert(face.generation==context.generation and face.requestId==context.requestId)
    speech.stop('cancelled');assert(judy.resets==1 and not face.active)
  `);
});

test('continuous playback authorizes only its exact live actor, with verified game volume and camera-relative pan',()=>run(`
assert(begin());assert(control().allow and not control().paused and control().volumeKnown)
-- Pan is narrowed to 0.7 for headphones; the camera distance rides along for the bridge's low-pass.
assert(math.abs(control().volume-.4)<.00001 and control().pan==.7 and nativeStarts==0)
assert(type(control().distance)=='number' and control().distance>0)
assert(state().continuousAvailable and state().continuousId==id)
local sequence=control().sequence
-- Unchanged permission is refreshed every 150 ms (the bridge treats 400 ms as stale).
snapshot();tick();assert(control().sequence==sequence)
snapshot({updated=(wall+.05)*1000});tick(.16);assert(control().sequence>sequence and control().requestId==context.requestId)
judy.pos.x=-2;snapshot({updated=(wall+.05)*1000});tick();assert(control().pan==-.7)
judy.pos.x=18;snapshot({updated=(wall+.05)*1000});tick();assert(control().volume==0)
speech.stop('cancelled');assert(not control().allow and not speech.requestId and nativeStarts==0 and nativeStops==0)
context.entity='Wrong-copy';assert(not begin());assert(not control().allow)
`));

test('an add-on voice is heard from its own object (the gun Skippy lives in) and falls back to its anchor for good when that goes away',()=>run(`
captions.beginTimed=function(_,text,duration)captions.timed={duration=duration};captions.line=text end
local gun=actor('Gun',1,1)
local asked={}
speech.voiceSource=function(key,p)asked[#asked+1]=key;assert(p==player);return gun end
local skippy={requestId='addon-1',entity=player.id,generation=8,name='Skippy',voiceOnly=true,profileKey='addon-skippy-gun'}
local function snap(changes)
 local value={version=1,id=id,requestId=skippy.requestId,entity=skippy.entity,generation=skippy.generation,
  updated=(wall+.05)*1000,state='playing',position=.2,bufferedDuration=2,text='Hi.',textComplete=false,complete=false,ended=false,underruns=0}
 for k,v in pairs(changes or {})do value[k]=v end
 put('runtime/continuous-speech.json',value)
end
speech.target=player
assert(speech.start(skippy,{text='Hi.',continuous={version=1,id=id}}))
-- Asked once, with the speaker's profile; V (the anchor) is right under the camera, so only the gun gives the voice a side.
assert(#asked==1 and asked[1]=='addon-skippy-gun')
assert(control().allow and control().pan>.4 and control().pan<=.7 and controller.status().voiceFrom=='source')
local d=control().distance;assert(d>1.3 and d<1.5)
snap();tick(.16);assert(#asked==1)
-- The gun is not near the camera any more (holstered, dropped, a bad read): back to V, and never asked again for this reply.
gun.pos={x=40,y=0,z=0};snap();tick(.16)
assert(control().pan==0 and controller.status().voiceFrom=='dropped' and #asked==1)
gun.pos={x=1,y=1,z=0};snap();tick(.16);assert(control().pan==0)
speech.stop('cancelled');assert(controller.status().voiceFrom==nil)
-- An ordinary (not voice-only) reply never asks.
assert(begin());assert(#asked==1 and control().pan==.7)
speech.stop('cancelled')
-- A source that fails to resolve is simply the anchor.
speech.voiceSource=function()error('no weapon')end
speech.target=player;skippy.requestId='addon-2'
assert(speech.start(skippy,{text='Hi.',continuous={version=1,id=id}}))
assert(control().allow and control().pan==0 and controller.status().voiceFrom==nil)
`));

test('provider EOF cannot complete group delivery before the device queue drains',()=>run(`
assert(begin());snapshot({complete=true,textComplete=true,position=.2});tick()
local t=speech.transcript(context.requestId,7,judy.id)
assert(t.streamVersion==2 and t.streamId==id and t.textComplete and not t.finished and not t.delivered)
assert(speech.requestId and not state().lastDelivery and nativeStarts==0)
snapshot({complete=true,textComplete=true,position=2,ended=true,state='finished'});tick()
local receipt=state().lastDelivery
assert(not speech.requestId and receipt and receipt.source=='continuous-playback' and receipt.backend=='browser-pcm')
assert(receipt.requestId==context.requestId and receipt.totalChunks==1 and receipt.completedChunks==1)
t=speech.transcript(context.requestId,7,judy.id);assert(t.finished and t.delivered and not t.failed)
assert(not control().allow and nativeStarts==0 and nativeStops==0)
speech.stop('cancelled');assert(state().lastDelivery.sequence==receipt.sequence)
`));

test('the actual group coordinator holds its next speaker until continuous playback is audibly drained',()=>run(`
local live={['Judy-2']=true,['Johnny-1']=true}
group.start('test-round',{{entity='Judy-2',profileKey='judy',name='Judy',npc=judy},
 {entity='Johnny-1',profileKey='johnny',name='Johnny',npc={}}},'Hello everyone')
context=group.next(7,wall,live)
assert(begin());group.received(context.requestId,'Hello',false,{'judy','johnny'},{version=2,id=id})
snapshot({textComplete=true,complete=true,position=.2});tick()
assert(not group.completed(context.requestId,true) and group.round.stage=='playing')
assert(not group.next(8,wall,live))
snapshot({textComplete=true,complete=true,position=2,ended=true,state='ended'});tick()
assert(group.completed(context.requestId,true))
local nextInput=group.next(8,wall,live)
assert(nextInput.entity=='Johnny-1' and #nextInput.group.heard==1 and nextInput.group.heard[1].text=='Hello V.')
`));

test('pause refreshes permission at zero delta and holds captions and face until heard audio resumes',()=>run(`
assert(begin());snapshot({face=timeline(2,false)});tick();assert(#judy.applied==1 and features==1)
local position=speech.position
paused=true;local sequence=control().sequence;snapshot({state='paused',face=timeline(2,false)});tick(0)
assert(control().paused and control().sequence>sequence and face.state=='paused' and speech.position==position)
assert(#judy.applied==1 and judy.resets==1)
speech.pauseForWorld();assert(control().paused and control().allow)
paused=false;snapshot({position=.6,bufferedDuration=3,face=timeline(3,false)});tick()
assert(not control().paused and features==1 and #judy.applied==2 and speech.position==.6)
assert(captions.positions[#captions.positions]==.6 and nativeStarts==0)
`));

test('stale or foreign browser snapshots cannot change the owner, face or completion receipt',()=>run(`
assert(begin());snapshot({requestId='old',ended=true,complete=true,textComplete=true,position=2});tick()
assert(speech.position==0 and not state().lastDelivery)
snapshot({generation=8,face=timeline(2,false)});tick();assert(#judy.applied==0)
snapshot({updated=(wall-10)*1000});tick(2.1)
assert(not speech.requestId and not control().allow and not state().lastDelivery)
assert(begin());snapshot({position=1});tick()
snapshot({position=.2,updated=(wall+.05)*1000});tick();assert(speech.position==1)
snapshot({position=2,ended=true,complete=false,textComplete=true});tick(2.1)
assert(not speech.requestId and not state().lastDelivery)
`));

test('mute, actor loss and world unload revoke playback without letting a late snapshot restart it',()=>run(`
assert(begin());snapshot();tick();voice=false;tick();assert(not speech.requestId and not control().allow)
voice=true;assert(begin());snapshot();tick();judy.attached=false;tick();assert(not speech.requestId and not control().allow)
judy.attached=true;assert(begin());snapshot();tick();local calls=nativeCalls
world=false;speech.abandon();assert(nativeCalls==calls and not control().allow and not speech.actor and not face.active)
world=true;snapshot({ended=true,complete=true,textComplete=true,position=2});tick()
assert(not speech.requestId and not state().lastDelivery and not control().allow)
`));

test('missing game volume fails silent and recovers on verified settings; failed permission writes cancel',()=>run(`
settings=false;assert(begin());assert(control().volume==0 and not control().volumeKnown)
assert(state().continuousControl.volumeKnown==false and state().continuousControl.volumeReason=='game-volume-unavailable')
settings=true;snapshot();tick(.5);assert(control().volumeKnown and math.abs(control().volume-.4)<.00001)
failWrite=true;tick(.16);assert(not speech.requestId and not state().lastDelivery)
`));

test('renderer admission, lease hold and device-draining states keep one pending utterance until actual end',()=>run(`
assert(begin())
for _,value in ipairs({'opening','awaiting-admission','lease-held','draining'})do
 snapshot({state=value});tick();assert(speech.requestId and speech.state==value and not state().lastDelivery)
end
snapshot({state='ended',position=2,textComplete=true,complete=true,ended=true});tick()
assert(not speech.requestId and state().lastDelivery and not control().allow)
`));

test('native Omni WAV playback still uses native start and completion and never grants a browser lease',()=>run(`
assert(speech.start(context,{text='Local voice',audio={slot=0,event='convai_reply_0',duration=2}}))
assert(nativeStarts==1 and #controls==0)
nativeCursor=.2;tick();nativeCursor=2;tick()
assert(state().lastDelivery.source=='native-playback' and not state().lastDelivery.backend)
assert(#controls==0 and nativeStops==1)
`));

for (const fps of [30, 60, 120]) {
  test(`confirmed past facial poses follow ${fps} FPS game frames rather than the 40 ms file poll`,()=>run(`
assert(begin());local base,lastHost,lastCursor=wall,-1,0
for index=1,${fps * 2} do
 local heard=math.floor((index/${fps}+1e-8)/.04)*.04
 if heard~=lastHost then
  snapshot({position=heard,updated=(base+heard)*1000,bufferedDuration=3,face=timeline(3,false)})
  lastHost=heard
 end
 tick(1/${fps})
 local cursor=speech.continuousFaceCursor
 if cursor then
  assert(cursor>=lastCursor-1e-8,'Facial cursor rewound')
  assert(cursor<=speech.position+1e-8,'Facial pose predicted unconfirmed audio')
  assert(speech.position-cursor<=.080001,'Confirmed-past lag exceeded its bound')
  lastCursor=cursor
 end
 if speech.position>0 then
  assert(captions.positions[#captions.positions]==speech.position,'Subtitle clock was changed by facial smoothing')
 end
end
assert(#judy.applied>=${fps === 30 ? 55 : fps === 60 ? 110 : 105},'Native application cadence still collapses to the file poll: '..#judy.applied)
assert(#judy.applied<=${fps === 30 ? 61 : 121},'Timeline publication bypassed the 60 Hz heard-cursor cap: '..#judy.applied)
-- A stationary speaker: the permission file is refreshed every 150 ms, not on every 40 ms state poll.
assert(#controls>=9 and #controls<=15,'Unchanged permission was rewritten too often or too rarely: '..#controls)
assert(nativeStarts==0 and nativeStops==0,'Convai facial smoothing must not change its PCM renderer')
`));
}

test('a separately published face is read only when its revision changes, at most every 200 ms, and only for its owner',()=>run(`
local open,faceReads=io.open,0
io.open=function(path,mode)if path=='runtime/continuous-face.json'then faceReads=faceReads+1 end;return open(path,mode)end
local function faceDoc(revision,duration,changes)
 local value={version=1,id=id,requestId=context.requestId,entity=context.entity,generation=context.generation,
  revision=revision,face=timeline(duration,false)}
 for k,v in pairs(changes or {})do value[k]=v end
 put('runtime/continuous-face.json',value)
end
assert(begin());assert(state().continuousFaceFile==true)
faceDoc(1,2);snapshot({faceRevision=1,position=.2});tick()
assert(face.active and #judy.applied==1 and faceReads==1 and face.timeline.duration==2)
snapshot({faceRevision=1,position=.3,updated=(wall+.05)*1000});tick()
assert(faceReads==1 and #judy.applied==2,'An unchanged revision was read again')
faceDoc(2,3);snapshot({faceRevision=2,position=.35,bufferedDuration=3,updated=(wall+.05)*1000});tick(.05)
assert(faceReads==1 and face.timeline.duration==2,'A new revision was read within 200 ms of the last read')
snapshot({faceRevision=2,position=.4,bufferedDuration=3,updated=(wall+.05)*1000});tick(.16)
assert(faceReads==2 and face.timeline.duration==3 and face.active)
faceDoc(3,4,{generation=8});snapshot({faceRevision=3,position=.5,bufferedDuration=4,updated=(wall+.05)*1000});tick(.25)
assert(faceReads==3 and face.timeline.duration==3 and face.active,'A foreign face file was accepted')
assert(speech.diagnosticCadence().sourceFrames==2)
speech.stop('cancelled');assert(not face.active)
`));

test('missing or stale snapshots cannot extrapolate the face beyond audio already confirmed heard',()=>run(`
assert(begin());snapshot({position=.2,face=timeline(2,false)});tick()
snapshot({position=1,updated=(wall+.05)*1000,face=timeline(2,false)});tick()
assert(speech.position==1 and speech.continuousFaceCursor>=.92 and speech.continuousFaceCursor<=1)
for index=1,60 do
 tick(1/60)
 assert(speech.position==1 and speech.continuousFaceCursor<=1,'Missing data advanced the heard clock')
end
assert(speech.continuousFaceCursor==1 and captions.positions[#captions.positions]==1)
tick(2.1)
assert(not speech.requestId and not control().allow and not state().lastDelivery)
assert(not speech.continuousFaceCursor and not speech.continuousFaceTarget and not face.active)
`));

test('pause and nonplaying renderer states stop the past cursor; resume uses the current heard pose',()=>run(`
assert(begin());snapshot({position=.2,face=timeline(2,false)});tick()
snapshot({position=.5,updated=(wall+.05)*1000,face=timeline(2,false)});tick()
assert(speech.continuousFaceCursor<speech.position)
local applied,position=#judy.applied,speech.position
paused=true;tick(0)
assert(not speech.continuousFaceCursor and #judy.applied==applied and speech.position==position)
assert(control().paused and face.state=='paused')
paused=false
for _,value in ipairs({'buffering','paused','lease-held','waiting-control','awaiting-admission'})do
 snapshot({state=value,position=.5,updated=(wall+.05)*1000,face=timeline(2,false)});tick()
 tick(1/60)
 assert(not speech.continuousFaceCursor and #judy.applied==applied,'Held source replayed an old mouth movement')
end
snapshot({state='playing',position=.6,updated=(wall+.05)*1000,face=timeline(2,false)});tick()
assert(speech.continuousFaceCursor==.6 and speech.position==.6 and #judy.applied==applied+1)
assert(captions.positions[#captions.positions]==.6 and features==1)
`));

test('actor loss and unload retire the cached facial cursor even between file polls',()=>run(`
assert(begin());snapshot({position=.2,face=timeline(2,false)});tick()
snapshot({position=.5,updated=(wall+.05)*1000,face=timeline(2,false)});tick()
local applied=#judy.applied;judy.attached=false;tick(.001)
assert(not speech.requestId and not speech.continuousFaceCursor and not control().allow)
assert(#judy.applied==applied and not state().lastDelivery)
judy.attached=true;assert(begin());snapshot({position=.8,updated=(wall+.05)*1000,face=timeline(2,false)});tick()
assert(speech.continuousFaceCursor==.8)
local calls=nativeCalls;world=false;speech.abandon()
assert(nativeCalls==calls and not speech.continuousFaceCursor and not face.active and not control().allow)
world=true;snapshot({position=2,complete=true,textComplete=true,ended=true,state='ended'});tick()
assert(not speech.requestId and not state().lastDelivery)
`));

test('actual device drain resets the face immediately instead of delaying group completion for its past cursor',()=>run(`
assert(begin());snapshot({position=.2,face=timeline(2,false)});tick()
snapshot({position=.8,updated=(wall+.05)*1000,complete=true,textComplete=true,face=timeline(2,true)});tick()
assert(speech.continuousFaceCursor<speech.position and not state().lastDelivery)
snapshot({position=2,updated=(wall+.05)*1000,complete=true,textComplete=true,ended=true,state='ended',face=timeline(2,true)});tick()
assert(not speech.requestId and not speech.continuousFaceCursor and not speech.continuousFaceTarget)
assert(not face.active and judy.resets==1 and state().lastDelivery.source=='continuous-playback')
assert(not control().allow and nativeStarts==0 and nativeStops==0)
`));

// October 8 in game: a resident-male pedestrian on Pocket spoke with a still mouth.
// The face gate required a managed companion, so speech-state.json carried
// "Speaker has no prepared owned facial layer" for every ambient turn. The world
// NPC is the speech target, not a companion; its native layer is ready once
// ConvaiFaceService has prepared its face_rig (Face.reds OnWorldInitialize).
test('an ambient world NPC on continuous Pocket gets the separately published mouth timeline, like a companion',()=>run(`
judy.owned=false -- a crowd resident: convaiCompanions.owns() is false for it
local function faceDoc(revision,duration,complete)
 local timeline=timeline(duration,complete);timeline.source,timeline.articulation='local-jali','jali-audio-v1'
 put('runtime/continuous-face.json',{version=1,id=id,requestId=context.requestId,entity=context.entity,
  generation=context.generation,revision=revision,face=timeline})
end
assert(begin());faceDoc(1,2,false);snapshot({faceRevision=1,position=.2});tick()
assert(face.active and face.source=='local-jali' and not face.error,'Ambient face rejected: '..tostring(face.error))
assert(#judy.applied==1 and judy.applied[1].jaw_mid_open>0)
snapshot({faceRevision=1,position=.6,updated=(wall+.05)*1000});tick()
assert(#judy.applied==2 and face.state=='playing')
faceDoc(2,2,true)
snapshot({faceRevision=2,position=2,updated=(wall+.25)*1000,complete=true,textComplete=true,ended=true,state='ended'});tick(.25)
assert(not face.active and judy.resets==1 and state().lastDelivery.entity==judy.id)
-- The idle, thinking and listening pass stays on managed companions only.
local before=#judy.applied
speech.update(.05,{actors={{entity=judy.id,npc=judy}}})
assert(#judy.applied==before and face.expressions[judy.id]==nil,'An idle face was written to a world NPC')
-- An unprepared world NPC (unsupported rig, or the earlier native layer) keeps its voice and captions.
judy.ready=false;assert(begin());faceDoc(3,2,false);snapshot({faceRevision=3,position=.2,updated=(wall+.05)*1000});tick()
assert(not face.active and #judy.applied==before and speech.requestId==context.requestId and control().allow)
assert(tostring(face.error):find('no prepared facial layer',1,true))
`));

// Segmented face file (bridge/continuous-face-file.mjs): the game decodes only the segments whose line changed.
import {encodeSegmentedFace} from './continuous-face-file.mjs';
const SEGMENT_FACE_ID = '12345678-1234-1234-1234-123456789abc';
function segmentedFile(count, revision, {complete = false, mutate} = {}) {
  const face = {version: 1, continuous: true, complete, requestId: 'conversation-1', entity: 'Judy-2', generation: 7,
    duration: (count - 1) / 60, source: 'convai-arkit61', tracks: ['jaw_mid_open'],
    frames: Array.from({length: count}, (_, i) => [i / 60, ((i * 7) % 10) / 20]),
    modelExpressions: {version: 1, format: 'jali-upper-v1',
      frames: Array.from({length: count}, (_, i) => [i / 60, ((i * 3) % 10) / 20, 0])}};
  mutate?.(face);
  return {text: encodeSegmentedFace({version: 1, id: SEGMENT_FACE_ID, requestId: 'conversation-1', generation: 7, entity: 'Judy-2', revision, face}),
    duration: face.duration};
}
// A small real JSON parser: the other tests mock json by key, this one reads actual file text.
const realJson = `
local function realdecode(text)
 local pos=1
 local function ws()pos=text:find('%S',pos)or #text+1 end
 local value
 local function str()
  local stop=text:find('"',pos+1,true);local out=text:sub(pos+1,stop-1);pos=stop+1;return out
 end
 function value()
  ws();local c=text:sub(pos,pos)
  if c=='{'then
   local out={};pos=pos+1;ws()
   if text:sub(pos,pos)=='}'then pos=pos+1;return out end
   while true do ws();local k=str();ws();pos=pos+1;out[k]=value();ws()
    local d=text:sub(pos,pos);pos=pos+1;if d=='}'then return out end end
  elseif c=='['then
   local out,n={},0;pos=pos+1;ws()
   if text:sub(pos,pos)==']'then pos=pos+1;return out end
   while true do n=n+1;out[n]=value();ws();local d=text:sub(pos,pos);pos=pos+1;if d==']'then return out end end
  elseif c=='"'then return str()
  elseif text:sub(pos,pos+3)=='true'then pos=pos+4;return true
  elseif text:sub(pos,pos+4)=='false'then pos=pos+5;return false
  elseif text:sub(pos,pos+3)=='null'then pos=pos+4;return json.null
  else local s,e=text:find('^-?[%d%.eE%+%-]+',pos);local n=tonumber(text:sub(s,e));pos=e+1;return n end
 end
 local result=value();ws();assert(pos>#text,'trailing garbage in JSON');return result
end
local mockJson=json
json={encode=mockJson.encode,null=nil,decode=function(k)local v=values[k];if v~=nil then return clone(v)end;return realdecode(k)end}
`;
const luaText = text => `[==[${text}]==]`;

test('a segmented face file decodes only the segments that changed and the timeline stays exact', () => {
  const one = segmentedFile(40, 1), two = segmentedFace52();
  function segmentedFace52() { return segmentedFile(52, 2); }
  run(`${realJson}
local fileDecodes,tokens,realTonumber=0,0,tonumber
local function faceFile(text)files['runtime/continuous-face.json']=text end
assert(begin());assert(state().continuousFaceSegments==true)
faceFile(${luaText(one.text)});snapshot({faceRevision=1,position=.2,bufferedDuration=${one.duration}});tick()
assert(face.active and #face.timeline.frames==40 and #face.timeline.modelExpressions.frames==40,'first revision was not read')
local firstRow,secondSegmentRow,changedRow=face.timeline.frames[1],face.timeline.frames[17],face.timeline.frames[33]
assert(math.abs(face.timeline.frames[33][2]-((32*7)%10)/20)<1e-12 and math.abs(face.timeline.modelExpressions.frames[40][2]-((39*3)%10)/20)<1e-12)
tonumber=function(...)tokens=tokens+1;return realTonumber(...)end
faceFile(${luaText(two.text)});snapshot({faceRevision=2,position=.3,bufferedDuration=${two.duration},updated=(wall+.05)*1000});tick(.25)
tonumber=realTonumber
assert(face.timeline.duration==${two.duration} and #face.timeline.frames==52 and #face.timeline.modelExpressions.frames==52,'grown revision was not read')
assert(rawequal(face.timeline.frames[1],firstRow) and rawequal(face.timeline.frames[17],secondSegmentRow),'finished segments were decoded again')
assert(not rawequal(face.timeline.frames[33],changedRow),'the partly filled segment kept its old rows')
assert(math.abs(face.timeline.frames[52][2]-((51*7)%10)/20)<1e-12)
-- changed segments: frames 16+4 rows x 2 numbers, model 16+4 rows x 3 numbers, plus the skeleton; the whole file would be 52x2 + 52x3 + the skeleton
assert(tokens>0 and tokens<=130,'decoded '..tokens..' numbers for the changed segments only')
speech.stop('cancelled')
`);
});

test('a segmented face file that cannot be read line by line falls back to a whole decode, and a broken one is refused', () => {
  const good = segmentedFile(40, 1), grown = segmentedFile(52, 2);
  // Every row of one document on one line: valid JSON, but no line starts a segment.
  const flatLine = JSON.stringify(JSON.parse(grown.text));
  const broken = segmentedFile(60, 3).text.replace('0.05,', 'x,');
  run(`${realJson}
local function faceFile(text)files['runtime/continuous-face.json']=text end
assert(begin())
faceFile(${luaText(good.text)});snapshot({faceRevision=1,position=.2,bufferedDuration=${good.duration}});tick()
assert(face.active and #face.timeline.frames==40)
faceFile(${luaText(flatLine)});snapshot({faceRevision=2,position=.3,bufferedDuration=${grown.duration},updated=(wall+.05)*1000});tick(.25)
assert(face.active and #face.timeline.frames==52 and #face.timeline.modelExpressions.frames==52 and face.timeline.duration==${grown.duration},'whole-document fallback failed')
faceFile(${luaText(broken)});snapshot({faceRevision=3,position=.4,bufferedDuration=${segmentedFile(60, 3).duration},updated=(wall+.1)*1000});tick(.25)
assert(face.active and #face.timeline.frames==52,'a damaged file replaced the timeline')
speech.stop('cancelled')
`);
});

test('a changed earlier segment and a shrinking list are both decoded correctly', () => {
  const a = segmentedFile(64, 1);
  const b = segmentedFile(64, 2, {mutate: face => { face.frames[19][1] = 0.25; face.complete = false; }});
  run(`${realJson}
local function faceFile(text)files['runtime/continuous-face.json']=text end
assert(begin())
faceFile(${luaText(a.text)});snapshot({faceRevision=1,position=.2,bufferedDuration=${a.duration}});tick()
local keep,edited=face.timeline.frames[1],face.timeline.frames[20]
faceFile(${luaText(b.text)});snapshot({faceRevision=2,position=.3,bufferedDuration=${b.duration},updated=(wall+.05)*1000});tick(.25)
assert(rawequal(face.timeline.frames[1],keep) and not rawequal(face.timeline.frames[20],edited))
assert(face.timeline.frames[20][2]==.25,'the edited row was not read')
speech.stop('cancelled')
`);
});

test('a reply heard to its end whose state then goes stale is not re-shown as a written caption; a half-heard one still is',()=>run(`
-- Heard to the end (the last state said complete, text complete, position at the end), then the state file stops updating.
assert(begin());snapshot({complete=true,textComplete=true,position=2,bufferedDuration=2,text='Hello V, all of it.'});tick()
assert(captions.timed and speech.requestId)
local clears=captions.clears
for _=1,6 do tick(.5) end
assert(not speech.requestId,'the stale state ended the utterance')
assert(captions.line==nil and captions.timed==nil,'the finished reply leaves no caption behind')
assert(captions.clears>clears)
-- Half heard: the written reply is still shown so nothing is lost.
captions.line=nil
assert(begin());snapshot({complete=true,textComplete=true,position=.8,bufferedDuration=2,text='Hello V, half of it.'});tick()
for _=1,6 do tick(.5) end
assert(not speech.requestId and captions.line=='Hello V, half of it.','a half-heard reply keeps its written fallback')
`));

test('abandoning the speech hands the page it was showing to the subtitle timer instead of leaving it forever',()=>run(`
local lingered
function captions.linger(seconds)lingered=seconds;captions.timed=nil;return true end
assert(begin());snapshot({position=.5,bufferedDuration=2});tick()
assert(captions.timed and speech.requestId)
speech.abandon()
assert(lingered and lingered>0 and captions.timed==nil,'the page is held briefly, then removed by the subtitle timer')
-- Nothing playing: abandon touches no caption.
lingered=nil;speech.abandon();assert(lingered==nil)
`));

test('a voice that breaks after the reply started: the error state carries the whole written reply and that is what shows, once',()=>run(`
-- The first sentence is heard, then the bridge writes the error state with the COMPLETE text (bridge/convai-continuous-speech.mjs failToText).
assert(begin());snapshot({position=.4,bufferedDuration=1,text='First sentence.',textComplete=false});tick()
assert(speech.requestId and captions.timed)
captions.line=nil
snapshot({state='error',error='The voice stream stopped.',position=.4,bufferedDuration=1,text='First sentence. And the rest of the reply.',textComplete=true});tick()
assert(not speech.requestId,'the broken stream ends the utterance')
assert(captions.line=='First sentence. And the rest of the reply.','the complete written reply is shown, not the first sentence: '..tostring(captions.line))
assert(tostring(speech.error):find('voice stream stopped',1,true),'the game keeps the reason for its one voice-ended notice')
-- A broken stream whose text is not complete (the old behaviour) still shows what was known.
captions.line=nil
assert(begin());snapshot({position=.4,bufferedDuration=1,text='Known so far.',textComplete=false});tick()
snapshot({state='error',error='The voice stream stopped.',position=.4,bufferedDuration=1,text='Known so far.',textComplete=false});tick()
assert(captions.line=='Known so far.')
`));
