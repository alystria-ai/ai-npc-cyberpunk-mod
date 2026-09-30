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
 return {write=function(_,raw)files[path]=raw;return true end,close=function()return true end}
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
 function a:ConvaiFaceReady()native();return true end
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
    assert(math.abs(native.lips_l_stretch-.06)<.000001)
    assert(math.abs(native.lips_l_corner_stretch-.04)<.000001)
    assert(math.abs(native.lips_r_corner_stretch-.02)<.000001)
    assert(math.abs(native.lips_suck_dn-.06)<.000001)
    assert(native.lips_l_upper_raise==0 and native.lips_r_upper_raise==0)
    assert(face.generation==context.generation and face.requestId==context.requestId)
    speech.stop('cancelled');assert(judy.resets==1 and not face.active)
  `);
});

test('continuous playback authorizes only its exact live actor, with verified game volume and camera-relative pan',()=>run(`
assert(begin());assert(control().allow and not control().paused and control().volumeKnown)
assert(math.abs(control().volume-.4)<.00001 and control().pan==1 and nativeStarts==0)
assert(state().continuousAvailable and state().continuousId==id)
local sequence=control().sequence
snapshot();tick();assert(control().sequence>sequence and control().requestId==context.requestId)
judy.pos.x=-2;snapshot({updated=(wall+.05)*1000});tick();assert(control().pan==-1)
judy.pos.x=18;snapshot({updated=(wall+.05)*1000});tick();assert(control().volume==0)
speech.stop('cancelled');assert(not control().allow and not speech.requestId and nativeStarts==0 and nativeStops==0)
context.entity='Wrong-copy';assert(not begin());assert(not control().allow)
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
failWrite=true;tick();assert(not speech.requestId and not state().lastDelivery)
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
assert(#controls>=49 and #controls<=51,'The 40 ms control poll discarded its game-frame remainder')
assert(nativeStarts==0 and nativeStops==0,'Convai facial smoothing must not change its PCM renderer')
`));
}

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
