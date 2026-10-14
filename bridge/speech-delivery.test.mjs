import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {ConvaiAudioStream, encodePcmWav} from './convai-audio-stream.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const speechSource = readFileSync(new URL('../mod/speech.lua', import.meta.url), 'utf8');
const phoneSource = readFileSync(new URL('../mod/phone-chat.lua', import.meta.url), 'utf8');
const facialSource = readFileSync(new URL('../mod/facial-playback.lua', import.meta.url), 'utf8');
const groupSource = readFileSync(new URL('../mod/group-chat.lua', import.meta.url), 'utf8');
function run(setup, body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(setup + body));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}

const filesSetup = `
local files, values, serial, clock, writes = {}, {}, 0, 100, {}
local function clone(value)
 if type(value)~='table' then return value end
 local result={};for key,item in pairs(value)do result[key]=clone(item)end;return result
end
json={encode=function(value)serial=serial+1;local key=tostring(serial);values[key]=clone(value);return key end,
 decode=function(key)assert(values[key]);return clone(values[key])end}
io.open=function(path,mode)
 if mode=='rb' then if not files[path]then return nil end
  return {read=function()return files[path]end,close=function()end}
 end
 return {write=function(self,value)files[path]=value;writes[#writes+1]={path=path,value=clone(values[value])};return self end,
  close=function()return true end}
end
os.time=function()return clock end
os.remove=function(path)files[path]=nil;return true end
os.rename=function(a,b)if not files[a]then return nil end;files[b]=files[a];files[a]=nil;return true end
local function put(path,value)files[path]=json.encode(value)end
local function read(path)return files[path]and json.decode(files[path])end
`;

const speechSetup = filesSetup + `
local cursor, paused, voice, world, attached, alive, canStart = 0,false,true,true,true,true,true
local starts,stops,nativeCalls=0,0,0
local function native()nativeCalls=nativeCalls+1;assert(world,'native access after unload')end
local player={
 ConvaiManagerVoice=function()native();return voice end,
 GetEntityID=function()native();return {hash='V'}end,
 ConvaiSpeechStart=function()native();starts=starts+1;cursor=0;return canStart end,
 ConvaiSpeechStop=function()native();stops=stops+1 end,
 ConvaiSpeechPause=function()native()end,
 ConvaiSpeechPosition=function()native();return cursor end}
local actor={GetEntityID=function()native();return {hash='Judy-2'}end,
 IsAttached=function()native();return attached end,IsDeadNoStatPool=function()native();return not alive end}
Game={GetPlayer=function()return player end,GetAllBlackboardDefs=function()return {UI_System={}}end,
 GetBlackboardSystem=function()return {Get=function()return {GetBool=function()return paused end}end}end}
CName={new=function(value)return value end}
local captions={clear=function()end,show=function()end,clearEntity=function()end,
 enabled=function()return true end,beginTimed=function()end,syncTimed=function()end}
local face={status=function()return {}end,stop=function()end,start=function()end,pause=function()end,
 sync=function()end,abandon=function()end}
dofile=function(path)return path=='facial-playback.lua'and face or captions end
local function loadSpeech()return(function()${speechSource}end)()end
local speech=loadSpeech();speech.available=true;speech.target=actor
local context={entity='Judy-2',requestId='native-request-1',generation=7,name='Judy'}
local function chunk(index)
 return {index=index,text='Phrase '..index,audio={slot=index-1,event='convai_reply_'..(index-1),duration=2}}
end
local function begin(stream)
 local first=chunk(1)
 local reply={text='A reply',audio=first.audio}
 if stream then
  reply.stream={version=1,id='stream-1',total=2,firstText=first.text}
  put('runtime/speech-stream.json',{version=1,streamId='stream-1',requestId=context.requestId,
   entity=context.entity,generation=context.generation,total=2,complete=false,chunks={first}})
 end
 return speech.start(context,reply)
end
local function advance(value,delta)cursor=value;speech.update(delta or .1)end
local function state()return read('runtime/speech-state.json')end
local function manifest(changes)
 local value=read('runtime/speech-stream.json');for key,item in pairs(changes)do value[key]=item end
 put('runtime/speech-stream.json',value)
end
`;

test('only native completion creates a persistent plain receipt retaining the finished owner', () => run(speechSetup, `
 assert(begin());assert(not state().lastDelivery)
 advance(.1);advance(1.5);assert(not state().lastDelivery)
 clock=101;advance(2)
 local receipt=state().lastDelivery
 assert(receipt and receipt.requestId==context.requestId and receipt.entity=='Judy-2')
 assert(receipt.generation==7 and receipt.conversationGeneration==7 and receipt.completedAt==101000)
 assert(receipt.source=='native-playback'and receipt.state=='completed'and not receipt.partial and not receipt.cancelled)
 assert(receipt.totalChunks==1 and receipt.completedChunks==1 and receipt.sequence==1)
 assert(not speech.requestId and not speech.actor and not speech.context and state().state=='finished')
 assert(not receipt.actor and not receipt.player and not receipt.text)
 speech.update(1);speech.stop('cancelled');speech=loadSpeech();speech.update(1)
 assert(state().lastDelivery.id==receipt.id and state().lastDelivery.sequence==1)
`));

test('near-end cleanup, early emitter loss, and an explicit finished stop do not claim full delivery', () => run(speechSetup, `
 assert(begin());advance(.1);advance(1.96);advance(1.96,.3)
 assert(not speech.requestId and state().state=='finished'and not state().lastDelivery)
 assert(begin());advance(1.93);advance(-1)
 assert(not speech.requestId and not state().lastDelivery)
 assert(begin());advance(.5);speech.stop('finished')
 assert(not speech.requestId and not state().lastDelivery)
`));

test('stream acknowledgement waits for all played chunks and the matching final producer manifest', () => run(speechSetup, `
 assert(begin(true));advance(.1);advance(2)
 assert(speech.state=='buffering'and state().completedChunk==1 and not state().lastDelivery)
 manifest({chunks={chunk(1),chunk(2)}});speech.update(.1)
 assert(starts==2);advance(.1);advance(2)
 assert(speech.state=='buffering'and state().completedChunk==2 and not state().lastDelivery)
 manifest({complete=true});speech.update(.1)
 local receipt=state().lastDelivery
 assert(receipt and receipt.totalChunks==2 and receipt.completedChunks==2)
 assert(receipt.requestId==context.requestId and receipt.generation==7 and not speech.requestId)
 speech.update(2);assert(state().lastDelivery.id==receipt.id)
`));

test('a short chunk or producer failure prevents whole-stream delivery even after later audio plays', () => run(speechSetup, `
 assert(begin(true));manifest({chunks={chunk(1),chunk(2)},complete=true})
 advance(.1);advance(1.96);advance(1.96,.3)
 assert(starts==2);advance(.1);advance(2)
 assert(state().state=='finished'and state().completedChunk==2 and not state().lastDelivery)
 assert(begin(true));advance(.2)
 manifest({complete=true,error='generation stopped'});advance(2)
 assert(state().state=='stream-incomplete'and not state().lastDelivery)
 assert(begin(true));advance(.2);advance(2);speech.update(46)
 assert(state().state=='stream-incomplete'and not state().lastDelivery)
`));

test('foreign or stale stream manifests cannot confirm the current utterance', () => run(speechSetup, `
 assert(begin(true));advance(.2);advance(2)
 manifest({chunks={chunk(1),chunk(2)},complete=true,entity='Judy-1'});speech.update(.1)
 assert(starts==1 and not state().lastDelivery)
 manifest({entity='Judy-2',generation=8});speech.update(.1)
 assert(starts==1 and not state().lastDelivery)
 manifest({generation=7,requestId='another-turn'});speech.update(.1)
 assert(starts==1 and not state().lastDelivery)
 manifest({requestId=context.requestId});speech.update(.1);advance(.1);advance(2)
 assert(starts==2 and state().lastDelivery.requestId==context.requestId)
`));

test('paused time, mute, target loss, startup failure and text fallback never fabricate completion', () => run(speechSetup, `
 assert(begin());advance(.1);paused=true;advance(2,120)
 assert(speech.requestId and not state().lastDelivery)
 paused=false;voice=false;speech.update(.1);assert(not state().lastDelivery)
 assert(not begin());assert(not state().lastDelivery)
 voice=true;canStart=false;assert(not begin());assert(not state().lastDelivery)
 canStart=true;assert(begin());advance(.1);attached=false;advance(2)
 assert(state().state=='target-lost'and not state().lastDelivery)
 attached=true;assert(begin());advance(.1);alive=false;advance(2)
 assert(state().state=='target-lost'and not state().lastDelivery)
`));

test('replacement and unload retain only the last real receipt without touching old native handles', () => run(speechSetup, `
 assert(begin());advance(.2);advance(2);local first=state().lastDelivery
 context.requestId='cancelled-turn';assert(begin());advance(.1)
 context.requestId='replacement-turn';assert(begin());advance(.2);advance(2)
 local second=state().lastDelivery
 assert(second.sequence==2 and second.id~=first.id and second.requestId=='replacement-turn')
 context.requestId='unloaded-turn';assert(begin());advance(.2)
 local before=nativeCalls;world=false;speech.abandon()
 assert(nativeCalls==before and not speech.player and not speech.actor and not speech.context and not speech.target)
 assert(state().lastDelivery.id==second.id and state().lastDelivery.sequence==2)
`));

test('missing or malformed conversation ownership never becomes a durable delivery receipt', () => run(speechSetup, `
 for _,value in ipairs({-1,1.5,'7',2147483648})do
  context.generation=value;assert(begin());advance(.1);advance(2);assert(not state().lastDelivery)
 end
 context.generation=nil;assert(begin());advance(.1);advance(2);assert(not state().lastDelivery)
 context.generation=7;context.requestId=string.rep('x',161)
 assert(begin());advance(.1);advance(2);assert(not state().lastDelivery)
`));

const dynamicSetup = speechSetup + `
local captionStarts,captionUpdates,captionPositions,captionClears={},{},{},0
captions.beginTimed=function(name,text,duration,owner,entity)
 assert(owner==actor and entity=='Judy-2')
 captionStarts[#captionStarts+1]={text=text,duration=duration};captions.timed={duration=duration}
end
captions.reviseTimed=function(text,duration,position)
 assert(captions.timed);captionUpdates[#captionUpdates+1]={text=text,duration=duration,position=position}
 captions.timed.duration=duration;return true
end
captions.syncTimed=function(position)captionPositions[#captionPositions+1]=position end
captions.clear=function()captionClears=captionClears+1;captions.timed=nil end
local function pcmChunk(index,duration,start,text)
 return {index=index,startSeconds=start,text=text or 'This is one continuous sentence.',
  audio={slot=(index-1)%8,event='convai_reply_'..((index-1)%8),duration=duration}}
end
local function beginDynamic(duration,text)
 local first=pcmChunk(1,duration or 1,0,text)
 local doc={version=2,streamId='pcm-live',requestId=context.requestId,generation=context.generation,
  entity=context.entity,captionMode='utterance',text=first.text,textComplete=false,complete=false,
  bufferedDuration=first.audio.duration,chunks={first}}
 put('runtime/speech-stream.json',doc)
 assert(speech.start(context,{text=first.text,audio=first.audio,stream={version=2,id='pcm-live',
  captionMode='utterance',firstText=first.text,textComplete=false,bufferedDuration=first.audio.duration}}))
 return first
end
local function grow(chunks,text,complete,err)
 local duration=0;for _,item in ipairs(chunks)do duration=duration+item.audio.duration end
 local value=read('runtime/speech-stream.json')
 value.chunks,value.text,value.complete,value.error=chunks,text,complete==true,err
 value.textComplete,value.bufferedDuration=complete==true,duration
 value.total=complete and #chunks or nil
 put('runtime/speech-stream.json',value)
end
`;

test('dynamic PCM starts before the final total and retains one utterance caption across segment boundaries', () => run(dynamicSetup, `
 local first=beginDynamic();advance(.2)
 assert(speech.state=='playing'and speech.stream.total==nil and #captionStarts==1 and captionClears==0)
 advance(1);assert(speech.state=='buffering'and captionClears==0 and not state().lastDelivery)
 grow({first,pcmChunk(2,2,1)},first.text,false);speech.update(.1)
 assert(starts==2);advance(.2)
 assert(#captionStarts==1 and #captionUpdates==0 and math.abs(captionPositions[#captionPositions]-1.2)<.001)
 advance(2);assert(speech.state=='buffering'and not state().lastDelivery and captionClears==0)
 grow({first,pcmChunk(2,2,1)},first.text,true);speech.update(.1)
 local receipt=state().lastDelivery
 assert(receipt and receipt.totalChunks==2 and receipt.completedChunks==2 and state().utterancePosition==3)
 assert(captionClears==1 and #captionStarts==1 and #captionUpdates==1)
 assert(captionUpdates[1].duration==3 and captionUpdates[1].position==3)
`));

test('growing realtime text updates the current caption at its global audio cursor without restarting on every file', () => run(dynamicSetup, `
 local first=beginDynamic(1,'Night City looks different.');advance(.3)
 local full='Night City looks different from up here, with all those lights stretching beyond the skyline.'
 grow({first,pcmChunk(2,2,1,full)},full,false);advance(.5)
 assert(#captionStarts==1 and #captionUpdates==1 and captionUpdates[1].text==full)
 assert(captionUpdates[1].position==.5 and captionClears==0)
 advance(1);advance(.2);assert(#captionStarts==1 and #captionUpdates==1)
 grow({first,pcmChunk(2,2,1,full)},full,true);advance(.5)
 assert(#captionUpdates==2 and captionUpdates[2].duration==3 and captionUpdates[2].position==1.5)
 advance(2);assert(state().lastDelivery and #captionStarts==1)
`));

test('dynamic streams support a single short final segment and never acknowledge an error-completed stream', () => run(dynamicSetup, `
 local first=beginDynamic(.35);advance(.1)
 grow({first},first.text,true);advance(.35)
 assert(state().lastDelivery.totalChunks==1 and state().lastDelivery.completedChunks==1)
 local prior=state().lastDelivery.id
 context.requestId='failed-pcm';first=beginDynamic();advance(.1)
 grow({first},first.text,true,'Provider stopped');advance(1)
 assert(speech.state=='stream-incomplete'and state().lastDelivery.id==prior)
`));

test('dynamic buffer underrun waits without advancing captions; pause, cancellation and timeout remain bounded', () => run(dynamicSetup, `
 local first=beginDynamic();advance(.2);advance(1)
 local position=captionPositions[#captionPositions]
 speech.update(2);assert(speech.state=='buffering'and starts==1 and captionPositions[#captionPositions]==position)
 paused=true;grow({first,pcmChunk(2,2,1)},first.text,true);speech.update(60)
 assert(starts==1 and not state().lastDelivery)
 paused=false;speech.update(.1);assert(starts==2)
 speech.stop('cancelled');speech.update(.1);assert(not state().lastDelivery and not speech.requestId)
 context.requestId='underrun-timeout';first=beginDynamic();advance(.1);advance(1);speech.update(46)
 assert(speech.state=='stream-incomplete'and not state().lastDelivery)
`));

test('dynamic manifests reject discontinuities, changed admitted audio, unbounded totals and wrong owners', () => run(dynamicSetup, `
 local first=beginDynamic();advance(.2);advance(1)
 local second=pcmChunk(2,2,1)
 grow({first,second},first.text,false);local good=read('runtime/speech-stream.json')
 local bad=clone(good);bad.chunks[2].startSeconds=1.5;put('runtime/speech-stream.json',bad);speech.update(.1)
 assert(starts==1)
 bad=clone(good);bad.bufferedDuration=6;put('runtime/speech-stream.json',bad);speech.update(.1);assert(starts==1)
 bad=clone(good);bad.chunks[1].audio.slot=7;bad.chunks[1].audio.event='convai_reply_7'
 put('runtime/speech-stream.json',bad);speech.update(.1);assert(starts==1)
 bad=clone(good);bad.complete=true;bad.textComplete=true;bad.total=129
 put('runtime/speech-stream.json',bad);speech.update(.1);assert(starts==1)
 bad=clone(good);bad.generation=8;put('runtime/speech-stream.json',bad);speech.update(.1);assert(starts==1)
 bad=clone(good);bad.entity='Judy-1';put('runtime/speech-stream.json',bad);speech.update(.1);assert(starts==1)
 put('runtime/speech-stream.json',good);speech.update(.1);assert(starts==2)
 advance(.2);advance(2);grow({first,second},first.text,true);speech.update(.1)
 assert(state().lastDelivery and state().lastDelivery.totalChunks==2)
`));

test('real facial playback hands contiguous native segments over without reset and releases long buffer holds', () => run(dynamicSetup, `
 local poses,resets={},0
 convaiCompanions={owns=function(value)return value==actor end}
 NewObject=function()return {}end
 actor.ConvaiFaceReady=function()native();return true end
 actor.ConvaiFaceApply=function(_,feature)native();poses[#poses+1]=feature.jaw_mid_open;return true end
 actor.ConvaiFaceReset=function()native();resets=resets+1;return true end
 face=(function()${facialSource}end)();speech=loadSpeech();speech.available=true;speech.target=actor
 local function timeline(index,last,a,b)
  return {version=1,requestId=context.requestId,entity=context.entity,duration=1,source='convai-arkit61',
   segment={version=1,index=index,startSeconds=index-1,first=index==1,last=last},
   tracks={'jaw_mid_open'},frames={{0,a},{1,b}}}
 end
 local function startFace()
  local first=pcmChunk(1,1,0);first.face=timeline(1,false,.1,.2)
  put('runtime/speech-stream.json',{version=2,streamId='pcm-live',requestId=context.requestId,generation=context.generation,
   entity=context.entity,captionMode='utterance',text=first.text,textComplete=false,complete=false,bufferedDuration=1,chunks={first}})
  assert(speech.start(context,{text=first.text,audio=first.audio,face=first.face,
   stream={version=2,id='pcm-live',captionMode='utterance',firstText=first.text,textComplete=false,bufferedDuration=1}}))
  return first
 end
 local first=startFace();local second=pcmChunk(2,1,1);second.face=timeline(2,true,.2,0)
 grow({first,second},first.text,true);advance(.4);advance(.996)
 assert(starts==2 and resets==0 and math.abs(poses[#poses]-.2)<.0001)
 advance(.05,.3);assert(resets==0 and math.abs(poses[#poses]-.19)<.0001)
 advance(1);assert(resets==1 and state().lastDelivery.totalChunks==2)
 context.requestId='buffered-face';first=startFace();advance(.5);advance(1)
 assert(face.active and resets==1)
 speech.update(.25);assert(not face.active and resets==2 and speech.state=='buffering')
 speech.stop('cancelled');assert(resets==2)
`));

test('final native transcript updates group history without replaying subtitles or borrowing another request', () => run(dynamicSetup, `
 local group=(function()${groupSource}end)()
 group.captureReply=speech.transcript
 local judy={entity='Judy-2',profileKey='judy',name='Judy',bodyType='test',npc=actor}
 local panam={entity='Panam-1',profileKey='panam',name='Panam',bodyType='test',npc={}}
 local live={['Judy-2']=true,['Panam-1']=true}
 group.start('group-live',{judy,panam},'Hello');context=group.next(7,100,live)
 local first=beginDynamic(1,'Only the beginning.');advance(.2)
 group.received(context.requestId,first.text,false,{'judy','panam'},{version=2,id='pcm-live'})
 assert(not group.preview(8,101,live))
 local full='Only the beginning. The complete answer arrives while these audio files continue playing.'
 grow({first,pcmChunk(2,1,1,full)},full,true);advance(.5)
 local prepared=group.preview(8,101,live)
 assert(prepared.group.heard[1].text==full)
 assert(not group.completed(context.requestId,true))
 advance(1);advance(.5);advance(1)
 local count=#captionStarts+#captionUpdates
 local transcript=speech.transcript(context.requestId,7,'Judy-2')
 assert(transcript.text==full and transcript.delivered and transcript.finished)
 transcript.text='caller changed a copy'
 assert(speech.transcript(context.requestId,7,'Judy-2').text==full)
 assert(not speech.transcript(context.requestId,7,'Judy-1')and not speech.transcript(context.requestId,8,'Judy-2'))
 assert(group.completed(context.requestId,true))
 local next=group.next(9,103,live)
 assert(next.requestId==prepared.requestId and next.group.heard[1].text==full)
 assert(#captionStarts+#captionUpdates==count and #captionStarts==1)
 speech.abandon();assert(not speech.transcript(context.requestId,7,'Judy-2'))
`));

function toLua(value) {
  if (value === undefined || value === null) return 'nil';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `{${value.map(toLua).join(',')}}`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => `[${toLua(key)}]=${toLua(item)}`).join(',')}}`;
}

test('real PCM WAV segments published by the realtime adapter follow the dynamic native receipt contract', async () => {
  const manifests = [], pcmDurations = [];
  const input = {requestId: 'native-request-1', generation: 7, entity: 'Judy-2'};
  const stream = new ConvaiAudioStream({input, streamId: 'actual-pcm', now: () => 100000,
    current: async () => true, writeManifest: async doc => manifests.push(structuredClone(doc)),
    readState: async () => ({streamId: 'actual-pcm', requestId: input.requestId, state: 'playing', updated: 100000, completedChunk: 0}),
    slots: {begin: async () => {}, write: async (_, index, audio) => {
      const wav = Buffer.from(audio, 'base64');
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
      const duration = wav.readUInt32LE(40) / wav.readUInt32LE(28); pcmDurations.push(duration);
      return {slot: index - 1, event: `convai_reply_${index - 1}`, duration};
    }}});
  const text = 'These two native files contain one continuous spoken reply.';
  for (const [offset, duration] of [[0, 1], [1, 1.1]]) {
    const pcm = Float32Array.from({length: Math.round(8000 * duration)}, (_, n) => .15 * Math.sin(n / 15));
    await stream.append({version: 1, index: manifests.length + 1, startSeconds: offset, duration,
      audio: encodePcmWav(pcm, 8000), text, textComplete: true});
  }
  const descriptor = stream.descriptor();
  await stream.finish({streamed: true, text, stream: {chunks: 2, duration: 2.1}});
  assert.deepEqual(pcmDurations, [1, 1.1]);
  run(dynamicSetup, `
 local initial=${toLua(manifests[0])};local final=${toLua(manifests.at(-1))}
 put('runtime/speech-stream.json',initial)
 assert(speech.start(context,{text=initial.text,audio=initial.chunks[1].audio,stream=${toLua(descriptor)}}))
 advance(.25);advance(1);assert(speech.state=='buffering'and not state().lastDelivery)
 put('runtime/speech-stream.json',${toLua(manifests[1])});speech.update(.1)
 advance(.2);advance(1.1);assert(speech.state=='buffering'and not state().lastDelivery)
 put('runtime/speech-stream.json',final);speech.update(.1)
 assert(state().lastDelivery.totalChunks==2 and state().lastDelivery.completedChunks==2)
 assert(starts==2 and #captionStarts==1 and math.abs(state().utterancePosition-2.1)<.0001)
 `);
});

const phoneSetup = filesSetup + `
NewObject=function()return {}end
put('phone-contacts.json',{{contact='judy',key='judy-alvarez'},{contact='panam',key='panam-palmer'}})
local phone=(function()${phoneSource}end)()
local binding={version=1,status='available',authoritative=true,confidence='native-live',localUserId='user-1',
 campaignId=string.rep('a',32),branchId=string.rep('b',32),branchEpoch=1,ledgerSequence=10,generation=3,activationId=string.rep('c',32)}
local contact,draft,submission='judy','',nil
local callbacks,painted={},nil
local knowledge={version=1,status='ready',generation=3,worldToken='original-world-token'}
local player={ConvaiPhoneChatContact=function()return contact end,ConvaiPhoneChatTick=function()end,
 ConvaiPhoneChatClearContacts=function()end,ConvaiPhoneChatRegisterContact=function()end,
 ConvaiPhoneChatDraft=function()return {contact=contact,text=draft}end,
 ConvaiPhoneChatTakeSubmission=function()local value=submission;submission=nil;return value end,
 ConvaiPhoneChatPresent=function(_,key,lines,status,value,enabled,busy,reset)painted=key;if reset then draft=value end end}
phone.configure({{key='judy-alvarez'},{key='panam-palmer'}},{profileEnabled=function()return true end},
 {captureBinding=function()return binding end,captureWorldKnowledge=function()return knowledge end,onDelivered=function(receipt)
  assert(not phone.pending and phone.history[receipt.contact][2].text=='Accepted reply')
  local store=read('runtime/phone-history.json')
  assert(store.buckets[phone.scope].history[receipt.contact][2].text=='Accepted reply')
  callbacks[#callbacks+1]=clone(receipt)
  receipt.saveIdentity.branchId='mutated by receiver'
 end})
local function update()for i=1,8 do phone.update(player,0)end end
local function send()
 draft='Hello';submission={contact='judy',text=draft};update();assert(phone.pending);return clone(phone.pending)
end
local function reply(pending,changes)
 local value={world=phone.world,binding=phone.bindingKey,id=pending.id,contact=pending.contact,state='reply',text='Accepted reply'}
 for key,item in pairs(changes or {})do value[key]=item end
 put('runtime/phone-chat-output.json',value)
end
update()
`;

test('phone acceptance fires once after the exact scoped history accepts the reply, including other selected contacts', () => run(phoneSetup, `
 local pending=send();assert(#callbacks==0)
 knowledge.generation=99;knowledge.worldToken='later-world-token'
 contact='panam';reply(pending);update()
 assert(#callbacks==1 and painted=='panam'and not phone.pending)
 local receipt=callbacks[1]
 assert(receipt.source=='phone-ui'and receipt.state=='accepted'and not receipt.partial and not receipt.cancelled)
 assert(receipt.requestId==pending.id and receipt.contact=='judy'and receipt.profileKey=='judy-alvarez')
 assert(receipt.world==phone.world and receipt.binding==phone.bindingKey and receipt.saveIdentity.generation==3)
 assert(receipt.generation==3 and receipt.worldToken=='original-world-token')
 assert(receipt.saveIdentity.branchId==string.rep('b',32)and phone.saveIdentity.branchId==string.rep('b',32))
 assert(receipt.id and receipt.sequence==1 and receipt.completedAt==100000 and not receipt.text)
 update();clock=101;update();assert(#callbacks==1)
`));

test('queued, wrong-scope, wrong-contact, cancelled and timed-out phone replies cannot confirm acceptance', () => run(phoneSetup, `
 local pending=send()
 for _,changes in ipairs({{state='sending'},{text=' '},{world='old-world'},{binding='other-branch'},
  {id='other-request'},{contact='panam'}})do reply(pending,changes);update();assert(#callbacks==0 and phone.pending)end
 reply(pending,{state='error',error='Unavailable'});update();assert(#callbacks==0 and not phone.pending)
 pending=send();binding.generation=4;binding.activationId=string.rep('d',32);update()
 reply(pending);update();assert(#callbacks==0 and not phone.pending)
 pending=send();clock=147;update();reply(pending);update();assert(#callbacks==0 and not phone.pending)
 pending=send();phone.abandon();reply(pending);update();assert(#callbacks==0)
`));

test('a failing optional phone delivery callback cannot undo acceptance or deliver it twice', () => run(phoneSetup, `
 local attempts=0;phone.onDelivered=function()attempts=attempts+1;error('receipt sink failed')end
 local pending=send();reply(pending);update()
 assert(attempts==1 and not phone.pending and phone.history.judy[2].text=='Accepted reply')
 update();assert(attempts==1)
`));

test('phone journal history is captured beside world knowledge under the original submission binding', () => run(phoneSetup, `
 local order={}
 phone.captureWorldKnowledge=function(p,key,b)
  assert(p==player and key=='judy-alvarez'and b.branchId==binding.branchId)
  order[#order+1]='world';return knowledge
 end
 phone.captureJournalHistory=function(p,key,b)
  assert(p==player and key=='judy-alvarez'and b.generation==3 and order[1]=='world')
  order[#order+1]='history';return {version=1,status='ready',generation=b.generation,worldToken=knowledge.worldToken}
 end
 local pending=send()
 assert(order[2]=='history'and pending.journalHistory.generation==3)
 assert(pending.journalHistory.worldToken=='original-world-token')
 phone.catalog.judy='a-different-profile';reply(pending);update()
 assert(callbacks[1].profileKey=='judy-alvarez')
`));

test('an add-on remark whose speaker shows the text itself plays without a subtitle; a failed voice still shows it, and no other reply is asked', () => run(speechSetup, `
 local calls = {show = 0, begin = 0, sync = 0, clear = 0, asked = 0}
 captions.show = function() calls.show = calls.show + 1 end
 captions.beginTimed = function() calls.begin = calls.begin + 1 end
 captions.syncTimed = function() calls.sync = calls.sync + 1 end
 captions.clear = function() calls.clear = calls.clear + 1 end
 local hide = true
 speech.hideCaption = function(key, requestId) calls.asked = calls.asked + 1; assert(key == 'addon-x-gun' and requestId == context.requestId); return hide end
 local addon = {entity = context.entity, requestId = context.requestId, generation = context.generation, name = 'Gun', voiceOnly = true, profileKey = 'addon-x-gun'}
 local reply = {text = 'A reply', audio = chunk(1).audio}
 -- Hidden: the voice plays and ends, and no caption call follows it.
 assert(speech.start(addon, reply))
 assert(speech.captionHidden == true and calls.asked == 1)
 advance(.1); advance(1); advance(.5)
 assert(speech.state == 'playing')
 advance(2)
 assert(calls.begin == 0 and calls.sync == 0 and calls.show == 0, 'no subtitle at any point of a hidden remark')
 assert(not speech.requestId and speech.captionHidden == nil, 'the flag ends with the reply')
 -- The voice cannot start: the text is shown as a subtitle so the line is not lost.
 canStart = false
 assert(not speech.start(addon, reply))
 assert(calls.show == 1, 'a failed voice falls back to the subtitle')
 canStart = true
 -- The speaker did not agree (no hologram): the subtitle follows the voice as always.
 hide = false
 assert(speech.start(addon, reply))
 assert(speech.captionHidden == nil)
 advance(.1); advance(1)
 assert(calls.begin >= 1 and calls.sync >= 1)
 speech.stop('cancelled')
 -- An ordinary reply (not voiceOnly) is never asked.
 calls.asked = 0
 assert(speech.start(context, reply))
 assert(calls.asked == 0 and speech.captionHidden == nil)
`));

test('an add-on voice anchored to V is heard from its own object (Audioware refuses V as an emitter); without one it fails with a reason and shows the text', () => run(speechSetup, `
 local emitters, shown = {}, 0
 player.ConvaiSpeechStart = function(_, object, event) native(); emitters[#emitters + 1] = tostring(object:GetEntityID().hash); cursor = 0; return true end
 captions.show = function() shown = shown + 1 end
 local gun = {GetEntityID = function() native(); return {hash = 'GUN'} end}
 local source, asked = gun, 0
 speech.voiceSource = function(key, p) asked = asked + 1; assert(key == 'addon-x-gun' and p == player); return source end
 speech.target = player
 local addon = {entity = 'V', requestId = 'req-v', generation = 3, name = 'Gun', voiceOnly = true, profileKey = 'addon-x-gun'}
 local reply = {text = 'A reply', audio = chunk(1).audio}
 -- The gun in V's hand is the emitter, not V.
 assert(speech.start(addon, reply))
 assert(#emitters == 1 and emitters[1] == 'GUN' and asked == 1, 'the voice comes from the gun: ' .. table.concat(emitters, ','))
 assert(speech.state == 'starting' or speech.state == 'playing')
 speech.stop('cancelled')
 assert(speech.emitter == nil)
 -- No object to come from: V would be the emitter, which Audioware refuses, so the call is not made and the text is shown.
 source = nil
 emitters, shown = {}, 0
 assert(not speech.start(addon, reply))
 assert(#emitters == 0, 'V is never registered as an emitter')
 assert(speech.state == 'playback-failed' and tostring(speech.error):find('Audioware cannot play on V'), tostring(speech.error))
 assert(shown == 1, 'the subtitle shows the text of a voice that cannot play')
 -- An ordinary speaker (and an add-on with a body) plays on itself and never asks for a source.
 asked = 0
 speech.target = actor
 assert(speech.start(context, reply))
 assert(asked == 0, 'only a voice without a body asks')
 speech.stop('cancelled')
`));

test('a holocall reply (and a V-anchored voice with no object of its own) plays on something of V\'s, never on V; with nothing to play on it fails with the reason', () => run(speechSetup, `
 local emitters, shown = {}, 0
 player.ConvaiSpeechStart = function(_, object, event) native(); emitters[#emitters + 1] = tostring(object:GetEntityID().hash); cursor = 0; return true end
 captions.show = function() shown = shown + 1 end
 local function thing(hash, attachedNow) return {GetEntityID = function() native(); return {hash = hash} end, IsAttached = function() return attachedNow end} end
 local weapon, chest = thing('WEAPON', true), thing('CHEST', true)
 local held = weapon
 ScriptedPuppet = {GetActiveWeapon = function(p) assert(p == player); return held end}
 TweakDBID = {new = function(name) return name end}
 local worn = chest
 Game.GetTransactionSystem = function() return {GetItemInSlot = function(_, p, slot) assert(p == player and slot == 'AttachmentSlots.Chest'); return worn end} end
 speech.target = player
 local call = {entity = 'V', requestId = 'req-h', generation = 4, name = 'Judy', holocall = {contact = 'judy'}}
 local reply = {text = 'Hello V', audio = chunk(1).audio}
 -- A holocall: through the phone, from the weapon in V's hands (not from V, which Audioware refuses).
 assert(speech.start(call, reply))
 assert(#emitters == 1 and emitters[1] == 'WEAPON', table.concat(emitters, ','))
 speech.stop('cancelled')
 -- No weapon in hand: the chest item V wears.
 held = nil
 emitters = {}
 assert(speech.start(call, reply))
 assert(#emitters == 1 and emitters[1] == 'CHEST', table.concat(emitters, ','))
 speech.stop('cancelled')
 -- A weapon that is not attached is no emitter either.
 held = thing('WEAPON', false)
 emitters = {}
 assert(speech.start(call, reply))
 assert(emitters[1] == 'CHEST')
 speech.stop('cancelled')
 -- Nothing of V's to play on: no call with V, the reason is kept, and the call's text is shown.
 held, worn = nil, nil
 emitters, shown = {}, 0
 assert(not speech.start(call, reply))
 assert(#emitters == 0 and shown == 1)
 assert(speech.state == 'playback-failed' and tostring(speech.error):find('nothing of V'), tostring(speech.error))
 -- The object is found once for the reply: the next phrase of a long reply plays from the same one.
 held = weapon
 emitters = {}
 assert(speech.start(call, reply))
 assert(emitters[1] == 'WEAPON' and speech.emitter == weapon)
 speech.stop('cancelled')
 assert(speech.emitter == nil)
`));
