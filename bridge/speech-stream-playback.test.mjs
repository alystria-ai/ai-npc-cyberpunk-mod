import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const facial = readFileSync(new URL('../mod/facial-playback.lua', import.meta.url), 'utf8');
const speech = readFileSync(new URL('../mod/speech.lua', import.meta.url), 'utf8');
const setup = `
local cursor, paused, voice, world, starts, resets = 0, false, true, true, 0, 0
local shown, published, manifest = {}, {}, nil
local captionBindings, clearedEntities = {}, {}
local function native() assert(world, 'native call after unload') end
local player = {
 ConvaiManagerVoice=function() native(); return voice end,
 GetEntityID=function() native(); return {hash='V'} end,
 ConvaiSpeechStart=function() native(); starts=starts+1; cursor=0; return true end,
 ConvaiSpeechStop=function() native() end,
 ConvaiSpeechPause=function() native() end,
 ConvaiSpeechPosition=function() native(); return cursor end}
local actor = {
 GetEntityID=function() native(); return {hash='Judy-2'} end,
 IsAttached=function() native(); return true end, IsDeadNoStatPool=function() native(); return false end,
 ConvaiFaceReady=function() native(); return true end, ConvaiFaceApply=function() native(); return true end,
 ConvaiFaceReset=function() native(); resets=resets+1; return true end}
Game={GetPlayer=function() return player end, GetAllBlackboardDefs=function() return {UI_System={}} end,
 GetBlackboardSystem=function() return {Get=function() return {GetBool=function() return paused end} end} end}
CName={new=function(x) return x end}; NewObject=function() return {} end
convaiCompanions={owns=function(a) return a==actor end}
local function caption(name,text,owner,entity)
 shown[#shown+1]=text; captionBindings[#captionBindings+1]={owner=owner,entity=entity,name=name}
end
local captions={clear=function() end, show=caption,
 clearEntity=function(entity) clearedEntities[#clearedEntities+1]=entity end,
 enabled=function() return true end,
 beginTimed=function(name,text,duration,owner,entity) caption(name,text,owner,entity) end, syncTimed=function() end}
local function clone(value)
 if type(value)~='table' then return value end
 local copy={}; for key,item in pairs(value) do copy[key]=clone(item) end; return copy
end
local decodes=0
json={encode=function(value) published=value; return '' end, decode=function() decodes=decodes+1; return clone(manifest) end}
-- The text the file holds follows the manifest the test edits: a changed manifest is a changed text, as a real rewrite would be.
local function serialise(value)
 if type(value)~='table' then return tostring(value) end
 local keys={}; for key in pairs(value) do keys[#keys+1]=tostring(key) end; table.sort(keys)
 local parts={}; for _,key in ipairs(keys) do parts[#parts+1]=key..'='..serialise(value[key] ~= nil and value[key] or value[tonumber(key)]) end
 return '{'..table.concat(parts,',')..'}'
end
io.open=function(path,mode)
 if mode=='wb' then return {write=function() end,close=function() end} end
 if not manifest then return nil end
 return {read=function() return serialise(manifest) end,close=function() end}
end
local face=(function() ${facial} end)()
dofile=function(path) return path=='facial-playback.lua' and face or captions end
local speech=(function() ${speech} end)()
speech.available=true; speech.target=actor
local context={entity='Judy-2',requestId='one',generation=4,name='Judy'}
local function chunk(index)
 return {index=index,text='Phrase '..index,audio={slot=index-1,event='convai_reply_'..(index-1),duration=2},
  face={version=1,requestId='one',entity='Judy-2',duration=2,source='local-phonetic',
   tracks={'jaw_mid_open','lips_l_purse'},frames={{0,0,0},{1,.2,.2},{2,0,0}}}}
end
local function start()
 local first=chunk(1)
 manifest={version=1,streamId='stream-one',requestId='one',generation=4,entity='Judy-2',total=2,
  complete=false,chunks={first}}
 assert(speech.start(context,{text='Phrase 1 Phrase 2',audio=first.audio,face=first.face,
  stream={version=1,id='stream-one',total=2,firstText=first.text}}))
end
`;
function run(body) {
 const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
 const status = lauxlib.luaL_dostring(L, to_luastring(setup + body));
 const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1));
 lua.lua_close(L); assert.equal(status, lua.LUA_OK, error);
}

test('a delayed phrase retains the utterance owner and restarts face/subtitle timing from the new native cursor', () => run(`
 start(); cursor=.1; speech.update(.1); assert(shown[1]=='Phrase 1')
 cursor=2; speech.update(.1)
 assert(speech.requestId=='one' and speech.state=='buffering' and resets==1)
 assert(published.completedChunk==1 and starts==1)
 speech.update(.8); assert(starts==1 and speech.requestId=='one')
 manifest.chunks[2]=chunk(2); manifest.complete=true; speech.update(.1)
 assert(starts==2 and speech.state=='starting' and face.position==nil)
 cursor=.1; speech.update(.1)
 assert(shown[#shown]=='Phrase 2' and face.position==.1)
 assert(speech.stream.history[2].gapSeconds>=.8)
 cursor=2; speech.update(.1)
 assert(not speech.requestId and speech.state=='finished' and resets==2)
 assert(published.completedChunk==2 and published.streamId=='stream-one')
`));

test('pause while buffering neither starts a ready chunk nor times out, then resumes exactly once', () => run(`
 start(); cursor=.2; speech.update(.1); cursor=2; speech.update(.1)
 paused=true; manifest.chunks[2]=chunk(2); manifest.complete=true
 speech.update(60); assert(starts==1 and speech.requestId=='one' and published.paused)
 paused=false; speech.update(.1); assert(starts==2)
 cursor=.1; speech.update(.1); assert(speech.state=='playing' and starts==2)
`));

test('stale owners, duplicate indices, invalid audio and truncated manifests never substitute another chunk', () => run(`
 start(); cursor=.2; speech.update(.1); cursor=2; speech.update(.1)
 manifest.chunks[2]=chunk(2); manifest.complete=true
 manifest.entity='Judy-1'; speech.update(.1); assert(starts==1)
 manifest.entity='Judy-2'; manifest.generation=3; speech.update(.1); assert(starts==1)
 manifest.generation=4; manifest.chunks[2].index=1; speech.update(.1); assert(starts==1)
 manifest.chunks[2]=chunk(2); manifest.chunks[2].audio.event='anything'; speech.update(.1); assert(starts==1)
 manifest.chunks[2]=chunk(2); speech.update(.1); assert(starts==2)
`));

test('mute, cancellation and save unload stop a stream and ignore later manifests', () => run(`
 start(); cursor=.1; speech.update(.1); voice=false; speech.update(.1)
 assert(not speech.requestId and speech.state=='muted' and published.streamId=='stream-one')
 manifest.chunks[2]=chunk(2); manifest.complete=true; speech.update(.1); assert(starts==1)
 voice=true; start(); speech.stop('new-conversation'); speech.update(.1); assert(starts==2)
 start(); world=false; speech.abandon()
 assert(not speech.requestId and not speech.stream and not speech.actor and not speech.target)
`));

test('partial production failure finishes the played portion and shows the full written reply', () => run(`
 start(); cursor=.2; speech.update(.1)
 manifest.complete=true; manifest.error='Worker stopped'
 cursor=2; speech.update(.1)
 assert(not speech.requestId and speech.state=='stream-incomplete')
 assert(shown[#shown]=='Phrase 1 Phrase 2' and starts==1)
`));

test('native captions keep the exact copy through playback, mute and partial-stream fallbacks', () => run(`
 start(); cursor=.2; speech.update(.1)
 assert(captionBindings[#captionBindings].owner==actor and captionBindings[#captionBindings].entity=='Judy-2')
 voice=false; speech.update(.1)
 assert(speech.state=='muted' and captionBindings[#captionBindings].owner==actor)
 assert(captionBindings[#captionBindings].entity=='Judy-2')
 voice=true; start(); cursor=.2; speech.update(.1)
 manifest.complete=true; manifest.error='Worker stopped'; cursor=2; speech.update(.1)
 assert(speech.state=='stream-incomplete' and captionBindings[#captionBindings].owner==actor)
 assert(captionBindings[#captionBindings].entity=='Judy-2')
`));

test('text-only replies retain their target and dismissing another copy does not stop the speaker', () => run(`
 voice=false
 assert(not speech.start(context,{text='Hello V'}))
 assert(captionBindings[1].owner==actor and captionBindings[1].entity=='Judy-2')
 voice=true; start(); cursor=.2; speech.update(.1)
 speech.clearEntity('Judy-1'); assert(speech.requestId=='one' and speech.target==actor)
 speech.clearEntity('Judy-2')
 assert(not speech.requestId and not speech.target and speech.state=='target-dismissed')
 assert(clearedEntities[#clearedEntities]=='Judy-2')
`));

test('an unchanged manifest is decoded once, not on every poll, and polling stops when every phrase has arrived', () => run(`
 start()
 local base=decodes
 for step=1,30 do cursor=step*.05; speech.update(.1) end
 assert(decodes-base==1, 'decoded '..(decodes-base)..' times for one unchanged manifest')
 manifest.chunks[2]=chunk(2); manifest.complete=true
 cursor=1.6; speech.update(.1)
 assert(decodes-base==2, 'a changed manifest is decoded once more: '..(decodes-base))
 cursor=1.7; for _=1,5 do speech.update(.1) end
 assert(decodes-base==2, 'decoded again after every phrase was known: '..(decodes-base))
`));

test('a manifest that was refused is not decoded again until its text changes, and is accepted once it is right', () => run(`
 start(); cursor=.2; speech.update(.1); cursor=2; speech.update(.1)
 manifest.chunks[2]=chunk(2); manifest.complete=true; manifest.entity='Judy-1'
 local before=decodes
 for _=1,20 do speech.update(.1) end
 assert(starts==1 and decodes-before==1, 'a refused manifest was decoded '..(decodes-before)..' times')
 manifest.entity='Judy-2'; speech.update(.1)
 assert(starts==2, 'the corrected manifest was not taken')
`));
