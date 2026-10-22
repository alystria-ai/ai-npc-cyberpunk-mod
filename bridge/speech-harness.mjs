// Shared by bridge/speech-delivery.test.mjs and bridge/speech-stream-playback.test.mjs: runs the real mod/speech.lua with the real
// mod/continuous-speech.lua and mod/facial-playback.lua (and mod/group-chat.lua) in fengari, with an in-memory file system, a fake
// game and recording subtitles. The renderer's state is written into runtime/continuous-speech.json with snapshot(). Not shipped.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = name => readFileSync(new URL(`../mod/${name}.lua`, import.meta.url), 'utf8');

export const speechHarness = `
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
local nativeCalls,nativeStarts,nativeStops,nativeCursor,features,players=0,0,0,0,0,0
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
-- The removed native path: a call to any of these is a failure.
function player:ConvaiSpeechStart()native();nativeStarts=nativeStarts+1;return true end
function player:ConvaiSpeechStop()native();nativeStops=nativeStops+1 end
function player:ConvaiSpeechPause()native()end
function player:ConvaiSpeechPosition()native();return nativeCursor end
local currentPlayer=player
Game={GetPlayer=function()players=players+1;return currentPlayer end,
 GetAllBlackboardDefs=function()return {UI_System={IsInMenu='menu'}}end,
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
-- Recording subtitles: shows (every unvoiced page), bindings (who owned each page that was shown or timed), cleared (entities).
local captions={line=nil,timed=nil,clears=0,positions={},starts=0,revisions=0,shows={},bindings={},cleared={}}
function captions.clear()captions.line,captions.timed=nil,nil;captions.clears=captions.clears+1 end
function captions.show(name,text,owner,entity)
 captions.line=text;captions.shows[#captions.shows+1]=text
 captions.bindings[#captions.bindings+1]={name=name,text=text,owner=owner,entity=entity,kind='show'}
end
function captions.clearEntity(entity)captions.cleared[#captions.cleared+1]=entity;captions.clear()end
function captions.enabled()return true end
function captions.beginTimed(name,text,duration,a,entity)
 captions.timed={duration=duration};captions.line=text;captions.starts=captions.starts+1
 captions.bindings[#captions.bindings+1]={name=name,text=text,owner=a,entity=entity,kind='timed'}
end
function captions.reviseTimed(text,duration)captions.line=text;captions.timed.duration=duration;captions.revisions=captions.revisions+1;return true end
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
-- The renderer's state for an owner (default: the current context), written as the browser would.
local function snapshotFor(owner,changes)
 local value={version=1,id=id,requestId=owner.requestId,entity=owner.entity,generation=owner.generation,
  updated=wall*1000,state='playing',position=.2,bufferedDuration=2,text='Hello V.',textComplete=false,
  complete=false,ended=false,underruns=0}
 for k,v in pairs(changes or {})do value[k]=v end
 put('runtime/continuous-speech.json',value)
 return value
end
local function snapshot(changes)return snapshotFor(context,changes)end
local function tick(delta)wall=wall+(delta or .05);speech.update(delta or .05)end
local function control()return controls[#controls]end
local function state()return read('runtime/speech-state.json')end
-- The renderer heard the whole reply and drained its device queue.
local function finishPlayback(changes)
 local value={complete=true,textComplete=true,position=2,bufferedDuration=2,ended=true,state='ended'}
 for k,v in pairs(changes or {})do value[k]=v end
 snapshot(value);tick()
end
`;

export function runSpeech(body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const status = lauxlib.luaL_dostring(vm, to_luastring(speechHarness + '\n' + body));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(status, lua.LUA_OK, error);
}
