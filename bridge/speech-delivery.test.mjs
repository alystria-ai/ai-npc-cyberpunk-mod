import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {runSpeech} from './speech-harness.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const phoneSource = readFileSync(new URL('../mod/phone-chat.lua', import.meta.url), 'utf8');
function run(setup, body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(setup + body));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}

// Delivery receipts of the continuous voice (mod/speech.lua with the real mod/continuous-speech.lua, bridge/speech-harness.mjs): the
// renderer's heard end is the only completion, and every other way a reply ends leaves no receipt behind.

test('only the renderer\'s drained end creates a persistent plain receipt retaining the finished owner', () => runSpeech(`
 assert(begin());assert(not state().lastDelivery)
 snapshot({position=.2});tick();snapshot({position=1.5});tick();assert(not state().lastDelivery)
 wall=1500
 finishPlayback()
 local receipt=state().lastDelivery
 assert(receipt and receipt.requestId==context.requestId and receipt.entity=='Judy-2')
 assert(receipt.generation==7 and receipt.conversationGeneration==7 and receipt.completedAt==1500000)
 assert(receipt.source=='continuous-playback' and receipt.backend=='browser-pcm' and receipt.state=='completed')
 assert(not receipt.partial and not receipt.cancelled)
 assert(receipt.totalChunks==1 and receipt.completedChunks==1 and receipt.sequence==1)
 assert(not speech.requestId and not speech.actor and not speech.context and state().state=='finished')
 assert(not receipt.actor and not receipt.player and not receipt.text)
 -- Polling the receipt, stopping again and later heartbeats never count another delivery.
 tick(2.1);speech.stop('cancelled');tick(2.1);tick(2.1)
 assert(state().lastDelivery.id==receipt.id and state().lastDelivery.sequence==1)
 assert(nativeStarts==0 and nativeStops==0)
`));

test('early loss of the speaker, an end the renderer never confirmed and an explicit finished stop do not claim full delivery', () => runSpeech(`
 -- Nearly all of it heard, the text complete, but the renderer never reported its drained end: the speaker is lost first.
 assert(begin());snapshot({complete=true,textComplete=true,position=1.96,bufferedDuration=2});tick()
 judy.attached=false;tick(.1)
 assert(not speech.requestId and state().state=='target-lost' and not state().lastDelivery)
 -- The provider's end of text without the device cursor at the end (position short of the buffered audio) is no end at all.
 judy.attached=true;assert(begin());snapshot({complete=true,textComplete=true,position=1.5,ended=false});tick()
 assert(speech.requestId and not state().lastDelivery)
 snapshot({complete=true,textComplete=true,position=1.5,ended=true,state='ended'});tick()
 assert(speech.requestId and not state().lastDelivery,'an ended state short of its audio was accepted')
 -- Stopping with reason finished is not a delivery either: only the renderer's end is.
 speech.stop('finished')
 assert(not speech.requestId and not state().lastDelivery)
 local t=speech.transcript(context.requestId,7,judy.id)
 assert(t.finished and not t.failed and not t.delivered)
`));

test('paused time, mute, target loss, startup failure and text fallback never fabricate completion', () => runSpeech(`
 -- A menu pauses: the renderer keeps reporting paused states for as long as it lasts, and none of that is delivery.
 assert(begin());snapshot();tick()
 paused=true
 for _=1,40 do snapshot({state='paused',position=.2});tick(.5) end
 assert(speech.requestId and speech.paused and not state().lastDelivery)
 paused=false;voice=false;snapshot();tick(.1);assert(not speech.requestId and speech.state=='muted' and not state().lastDelivery)
 -- No voice by the player's choice: the call is refused, nothing was ever playing.
 assert(not begin());assert(not state().lastDelivery and #captions.shows>=1)
 -- A reply with no continuous voice shows its text and returns false.
 voice=true;speech.target=judy
 assert(speech.start(context,{text='Written only.'})==false and captions.line=='Written only.' and not state().lastDelivery)
 -- The adapter refuses the start (the target is not the one the reply was for).
 local wrong=context.entity;context.entity='Wrong-copy'
 assert(not begin());assert(speech.state=='playback-failed' and speech.error and not state().lastDelivery and not control().allow)
 context.entity=wrong
 -- Target lost, and a target that died.
 assert(begin());snapshot();tick();judy.attached=false;tick(.1)
 assert(state().state=='target-lost' and not state().lastDelivery)
 judy.attached=true;assert(begin());snapshot();tick();judy.alive=false;tick(.1)
 assert(state().state=='target-lost' and not state().lastDelivery)
 judy.alive=true
 -- The voice breaks after it started: the text shows, no delivery.
 assert(begin());snapshot({position=.4,bufferedDuration=1});tick()
 snapshot({state='error',error='The voice stream stopped.',position=.4,bufferedDuration=1,textComplete=true});tick()
 assert(not speech.requestId and not state().lastDelivery)
 assert(nativeStarts==0 and nativeStops==0)
`));

test('replacement and unload retain only the last real receipt without touching old native handles', () => runSpeech(`
 assert(begin());snapshot({position=.2});tick();finishPlayback();local first=state().lastDelivery
 assert(first and first.sequence==1)
 -- A reply replaced by another one is cancelled, not delivered; the replacement is the one that delivers.
 context.requestId='cancelled-turn';assert(begin());snapshot();tick()
 context.requestId='replacement-turn';assert(begin());snapshot();tick();finishPlayback()
 local second=state().lastDelivery
 assert(second.sequence==2 and second.id~=first.id and second.requestId=='replacement-turn')
 -- A save unload makes no native call and keeps the receipt that was already earned.
 context.requestId='unloaded-turn';assert(begin());snapshot();tick()
 local before=nativeCalls;world=false;speech.abandon()
 assert(nativeCalls==before and not speech.player and not speech.actor and not speech.context and not speech.target)
 assert(state().lastDelivery.id==second.id and state().lastDelivery.sequence==2)
 -- A late finished state of the unloaded turn cannot make a receipt.
 world=true;snapshot({complete=true,textComplete=true,position=2,ended=true,state='ended'});tick(2.1)
 assert(not speech.requestId and state().lastDelivery.id==second.id)
`));

test('missing or malformed conversation ownership never becomes a durable delivery receipt', () => runSpeech(`
 for _,value in ipairs({-1,1.5,'7',2147483648})do
  context.generation=value
  assert(not begin(),'a reply for generation '..tostring(value)..' was accepted')
  assert(speech.state=='playback-failed' and not speech.requestId and not state().lastDelivery and #controls==0)
 end
 context.generation=nil;assert(not begin());assert(not state().lastDelivery and not speech.requestId)
 context.generation=7;context.requestId=string.rep('x',161)
 assert(not begin());assert(not state().lastDelivery and not speech.requestId)
 context.requestId=nil;assert(not begin());assert(not state().lastDelivery)
 context.requestId='conversation-1';context.entity=string.rep('y',121)
 assert(not begin());assert(not state().lastDelivery)
 -- The same owner, written right, is delivered.
 context.entity=judy.id;assert(begin());snapshot();tick();finishPlayback()
 assert(state().lastDelivery and state().lastDelivery.generation==7 and state().lastDelivery.sequence==1)
`));

test('a reply with an Audioware audio descriptor but no continuous voice is shown as text and starts nothing', () => runSpeech(`
 local reply={text='Heard the old way.',audio={slot=0,event='convai_reply_0',duration=2},
  stream={version=1,id='stream-1',total=2,firstText='Heard'}}
 speech.target=judy
 assert(speech.start(context,reply)==false)
 assert(captions.line=='Heard the old way.' and captions.bindings[#captions.bindings].owner==judy)
 assert(not speech.requestId and not speech.continuous and #controls==0)
 assert(nativeStarts==0 and nativeStops==0 and not state().lastDelivery)
 tick(2.1)
 assert(state().available==true and state().continuousAvailable==true,'the heartbeat publishes that the continuous voice is available')
 for _,key in ipairs({'slot','completedChunk','stream','streamId','nativeCompleted','phrases'})do
  assert(state()[key]==nil,'a removed field is still published: '..key)
 end
`));

test('final transcript updates group history without replaying subtitles or borrowing another request', () => runSpeech(`
 local panam={entity='Panam-1',profileKey='panam',name='Panam',bodyType='test',npc={}}
 local live={['Judy-2']=true,['Panam-1']=true}
 group.start('group-live',{{entity='Judy-2',profileKey='judy',name='Judy',bodyType='test',npc=judy},panam},'Hello')
 context=group.next(7,100,live)
 assert(begin());snapshot({text='Only the beginning.',position=.2,bufferedDuration=1});tick()
 group.received(context.requestId,'Only the beginning.',false,{'judy','panam'},{version=2,id=id})
 assert(not group.preview(8,101,live))
 local full='Only the beginning. The complete answer arrives while the audio continues playing.'
 snapshot({text=full,textComplete=true,complete=true,position=.5,bufferedDuration=2});tick()
 local prepared=group.preview(8,101,live)
 assert(prepared.group.heard[1].text==full)
 assert(not group.completed(context.requestId,true))
 snapshot({text=full,textComplete=true,complete=true,position=1.5,bufferedDuration=2});tick()
 snapshot({text=full,textComplete=true,complete=true,position=2,bufferedDuration=2,ended=true,state='ended'});tick()
 local count=captions.starts+captions.revisions
 local transcript=speech.transcript(context.requestId,7,'Judy-2')
 assert(transcript.text==full and transcript.delivered and transcript.finished and not transcript.failed)
 transcript.text='caller changed a copy'
 assert(speech.transcript(context.requestId,7,'Judy-2').text==full)
 assert(not speech.transcript(context.requestId,7,'Judy-1') and not speech.transcript(context.requestId,8,'Judy-2'))
 assert(group.completed(context.requestId,true))
 local following=group.next(9,103,live)
 assert(following.requestId==prepared.requestId and following.group.heard[1].text==full)
 assert(captions.starts+captions.revisions==count and captions.starts==1,'the final transcript replayed the subtitle')
 speech.abandon();assert(not speech.transcript(context.requestId,7,'Judy-2'))
`));

test('an add-on remark whose speaker shows the text itself plays without a subtitle; a failed voice still shows it, and no other reply is asked', () => runSpeech(`
 local asked,hide=0,true
 speech.hideCaption=function(key,requestId)asked=asked+1;assert(key=='addon-x-gun' and requestId==context.requestId);return hide end
 local addon={entity=judy.id,requestId=context.requestId,generation=context.generation,name='Gun',voiceOnly=true,profileKey='addon-x-gun'}
 local reply={text='A reply',continuous={version=1,id=id}}
 -- Hidden: the voice plays and ends, and no caption call follows it.
 assert(speech.start(addon,reply))
 assert(speech.captionHidden==true and asked==1)
 snapshotFor(addon,{position=.2});tick();snapshotFor(addon,{position=1});tick()
 assert(speech.state=='playing' and speech.position==1)
 snapshotFor(addon,{complete=true,textComplete=true,position=2,ended=true,state='ended'});tick()
 assert(captions.starts==0 and #captions.positions==0 and #captions.shows==0,'no subtitle at any point of a hidden remark')
 assert(not speech.requestId and speech.captionHidden==nil and state().lastDelivery,'the flag ends with the reply')
 -- The voice cannot start: the text is shown as a subtitle so the line is not lost.
 local wrong=addon.entity;addon.entity='Wrong-copy'
 assert(not speech.start(addon,reply))
 assert(#captions.shows==1 and captions.shows[1]=='A reply','a failed voice falls back to the subtitle')
 addon.entity=wrong
 -- The speaker did not agree (no hologram): the subtitle follows the voice as always.
 hide=false
 assert(speech.start(addon,reply))
 assert(speech.captionHidden==nil)
 snapshotFor(addon,{position=.2});tick();snapshotFor(addon,{position=1});tick()
 assert(captions.starts>=1 and #captions.positions>=1)
 speech.stop('cancelled')
 -- An ordinary reply (not voiceOnly) is never asked.
 asked=0
 assert(begin())
 assert(asked==0 and speech.captionHidden==nil)
`));

test('an add-on voice with its own object passes it to the adapter as the source; an ordinary reply, a head voice and a failing lookup do not', () => runSpeech(`
 local gun=actor('Gun',1,1)
 local sources,asked={},{}
 local start=controller.start
 controller.start=function(ctx,descriptor,p,a,pausedNow,source)sources[#sources+1]=source or false;return start(ctx,descriptor,p,a,pausedNow,source)end
 local source=gun
 speech.voiceSource=function(key,p)asked[#asked+1]=key;assert(p==player);if source=='error' then error('no weapon') end;return source end
 local addon={requestId='addon-1',entity=judy.id,generation=8,name='Skippy',voiceOnly=true,profileKey='addon-skippy-gun'}
 local reply={text='Hi.',continuous={version=1,id=id}}
 speech.target=judy
 assert(speech.start(addon,reply))
 assert(#asked==1 and asked[1]=='addon-skippy-gun' and sources[1]==gun)
 assert(controller.status().voiceFrom=='source')
 speech.stop('cancelled')
 -- An ordinary reply never asks and passes no source, even when a source function exists.
 assert(begin());assert(#asked==1 and sources[2]==false and controller.status().voiceFrom==nil)
 speech.stop('cancelled')
 -- Johnny in V's head has no place in the world: no source is asked for.
 local head={requestId='head-1',entity=judy.id,generation=9,name='Johnny',voiceOnly=true,head={},profileKey='johnny-head'}
 assert(speech.start(head,reply));assert(#asked==1 and sources[3]==false)
 speech.stop('cancelled')
 -- No object to come from, or a lookup that fails: the voice plays from its anchor.
 source=nil;addon.requestId='addon-2'
 assert(speech.start(addon,reply));assert(#asked==2 and sources[4]==false and controller.status().voiceFrom==nil and control().allow)
 speech.stop('cancelled')
 source='error';addon.requestId='addon-3'
 assert(speech.start(addon,reply));assert(#asked==3 and sources[5]==false and control().allow)
 speech.stop('cancelled')
`));

test('a holocall reply and Johnny\'s head voice reach the lease as a voice with no place in the world; an ordinary reply keeps its pan and distance', () => runSpeech(`
 local logs={}
 speech.log=function(line)logs[#logs+1]=line end
 -- In person: Judy stands 2 m to the side, so the voice is panned and has a distance.
 assert(begin());assert(control().pan==.7 and control().distance>0 and #logs==0)
 speech.stop('cancelled')
 -- A holocall (mod/holocall.lua): full level, centred, no distance, and one probe line for the reply.
 speech.target=judy
 local call={requestId='call-1',entity=judy.id,generation=5,name='Judy',holocall={contact='judy'}}
 assert(speech.start(call,{text='Hello V',continuous={version=1,id=id}}))
 assert(speech.holocall==true and captions.holocall==true)
 assert(control().allow and control().pan==0 and control().distance==0 and math.abs(control().volume-.4)<.00001)
 assert(#logs==1 and logs[1]:find('Holocall voice: path=browser',1,true) and logs[1]:find('level=0.40',1,true),tostring(logs[1]))
 snapshotFor(call,{position=.2});tick(.16);assert(control().pan==0 and #logs==1)
 speech.stop('cancelled');assert(speech.holocall==false)
 -- Johnny in V's head: heard the same way, with no probe line (only a holocall has one).
 local head={requestId='head-1',entity=judy.id,generation=6,name='Johnny',voiceOnly=true,head={},profileKey='johnny-head'}
 assert(speech.start(head,{text='Listen, V.',continuous={version=1,id=id}}))
 assert(speech.head==true and control().allow and control().pan==0 and control().distance==0 and #logs==1)
 speech.stop('cancelled');assert(speech.head==false)
 -- The next ordinary reply is spatial again.
 assert(begin());assert(control().pan==.7 and control().distance>0)
`));

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
