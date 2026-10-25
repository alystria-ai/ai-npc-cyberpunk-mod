import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

const source = name => readFileSync(new URL(`../mod/${name}.lua`, import.meta.url), 'utf8');
// init.lua ends with the table CET hands to other mods (GetMod('AiNpcCyberpunkMod'), docs/ADDON_API.md). This harness runs the
// file inside a function and returns its own table after it, so that final return statement is left out here.
const initSource = source('init').replace(/\r?\nreturn \{addons = [^\n]*\s*$/, '\n');
assert.notEqual(initSource, source('init'), 'init.lua no longer ends with the add-on API return');
const microphoneSource = source('microphone');
const groupSource = source('group-chat');
const worldSource = source('world-knowledge');
const historySource = source('journal-history');
const partsSource = source('knowledge-parts');
const invitationSource = source('invitation-readiness');
const gameplayActionsSource = source('gameplay-actions');
const seatedLookSource = source('seated-look');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

const fixture = `
local function copy(value)
 if type(value)~='table'then return value end
 local result={};for key,item in pairs(value)do result[key]=copy(item)end;return result
end
local files,encoded,serial,events,hooks,hotkeys={},{},0,{},{},{}
local hotkeyLabels,logs,playbacks,commands,feedback={},{},{},{},{}
local allowNative,attached,dead,preGame,paused=false,true,false,false,false
local nativeCalls,versionReads,factReads,historyReads,saveIdentityReads,actionOfferReads=0,0,0,0,0,0
local now,gameVersion,factValue,journalVersion=1000,'2.31',1,1
local collectorReady,afterReady,failPath=true,nil,nil
local order={}
local function record(value)order[#order+1]=value end
local function noop()end
json={encode=function(value)serial=serial+1;local key='json-'..serial;encoded[key]=copy(value);return key end,
 decode=function(raw)assert(encoded[raw],raw);return copy(encoded[raw])end}
io={open=function(path,mode)
 if path==failPath then return nil end
 if mode=='rb'then
  if files[path]==nil then return nil end
  return {read=function(_,limit)local raw=files[path];return type(limit)=='number'and raw:sub(1,limit)or raw end,close=function()return true end}
 end
 return {write=function(_,...)
  local values={...};for i,value in ipairs(values)do values[i]=tostring(value)end
  files[path]=(mode=='a'and(files[path]or'')or'')..table.concat(values)
  if path=='runtime/microphone-command.json'then commands[#commands+1]=json.decode(files[path])end
  -- world-session.json is written in place: a written unavailable lease is the publication.
  if path=='runtime/world-session.json'then local ok,value=pcall(json.decode,files[path]);if ok and type(value)=='table'and value.ready==false then record('world:unavailable')end end
  return true
 end,close=function()return true end}
end}
os.time=function()return now end
os.clock=function()return now end
print=function(value)logs[#logs+1]=tostring(value)end
os.remove=function(path)files[path]=nil;return true end
os.rename=function(from,to)
 if not files[from]then return nil end;files[to],files[from]=files[from],nil
 if to=='runtime/world-session.json'and json.decode(files[to]).ready==false then record('world:unavailable')end
 return true
end
local function stored(path)return files[path]and json.decode(files[path])end
local function put(path,value)files[path]=json.encode(value)end
local profiles={{key='judy-alvarez',name='Judy',records={}}, {key='alex',name='Alex',records={}},
 {key='resident-male',name='Resident',records={}}}
put('conversation-characters.json',profiles)
put('world-knowledge.json',{version=1,gameVersions={'2.31'},factAllowlist={observed_fact={evidenceRefs={'reviewed-proof'}}},journalAllowlist={}})
local player=setmetatable({composer=false}, {__index=function()return noop end})
function player:IsAttached()return attached end
function player:IsDeadNoStatPool()return dead end
function player:ConvaiComposerOpen()return self.composer end
function player:ConvaiOpenComposer(name)self.composer=true;self.composerName=name;return true end
function player:ConvaiHasSubmission()return self.submission~=nil end
function player:ConvaiTakeSubmission()local value=self.submission;self.submission=nil;return value end
function player:ConvaiPhoneFeedback(value)feedback[#feedback+1]=value end
function player:GetWorldPosition()return {x=0,y=0,z=0}end
function player:GetEntityID()return {hash='player'}end
function player:ConvaiManagerVoice()return true end
function player:ConvaiManagerSubtitles()return true end
local function native()assert(allowNative,'init-time native call');nativeCalls=nativeCalls+1 end
Game={GetPlayer=function()native();return player end,
 GetSystemRequestsHandler=function()native();return {IsPreGame=function()return preGame end,
 IsGamePaused=function()return paused end,GetGameVersion=function()versionReads=versionReads+1;return gameVersion end}end,
 GetAllBlackboardDefs=function()native();return {UI_System={IsInMenu='menu'}}end,
 GetBlackboardSystem=function()native();return {Get=function()return {GetBool=function()return paused end}end}end}
local function actor(key,id,name)
 local npc={key=key,entity=tostring(id)..'ULL',name=name or key,attached=true,dead=false,pos={x=id,y=1,z=0}}
 function npc:GetEntityID()return {hash=self.entity}end
 function npc:IsNPC()return true end
 function npc:IsAttached()return self.attached end
 function npc:IsDeadNoStatPool()return self.dead end
 function npc:GetWorldPosition()return self.pos end
 function npc:GetBodyType()return 'WomanAverage'end
 function npc:GetRecordID()return 'Character.'..self.key end
 function npc:IsCrowd()return false end
 return npc
end
local judy,alex,resident=actor('judy-alvarez',1,'Judy'),actor('alex',2,'Alex'),actor('resident-male',3,'Resident')
local looked,people=nil,{}
local function person(npc)return {npc=npc,entity=npc.entity,profileKey=npc.key,name=npc.name,bodyType='WomanAverage'}end
local targeting={GetTargetParts=function()return nil,{}end,GetObjectClosestToCrosshair=function()return looked end,
 GetLookAtObject=function()return looked end,GetCrosshairData=function()return {x=0,y=0,z=1.3},{x=0,y=1,z=0}end}
Game.GetTargetingSystem=function()native();return targeting end
Game['TSF_NPC;']=function()return 'NPC'end
TargetSearchQuery={new=function()return {}end}
registerForEvent=function(key,fn)events[key]=fn end
registerHotkey=function(key,label,fn)hotkeys[key]=fn;hotkeyLabels[key]=label end
rawInputs={}
registerInput=function(key,label,fn)rawInputs[key]=fn;hotkeyLabels[key]=label end -- the talk keys are held, not tapped: talkDown / talkUp
local VOICE,GROUP='cyberpunk_convai_voice','cyberpunk_convai_group_voice'
local function talkDown(key)rawInputs[key](true)end
local function talkUp(key,held)now=now+(held or 1);rawInputs[key](false)end -- the key is held for 'held' seconds (1 by default), then let go
ObserveBefore=function(_,key,fn)hooks[key]=fn end
ObserveAfter=ObserveBefore
local phoneOptions,worldOptions,historyOptions
local microphone=(function()${microphoneSource}end)()
local group=(function()${groupSource}end)()
local function collectionReady()
 local ready=attached and not dead and collectorReady
 if afterReady then local callback=afterReady;afterReady=nil;callback()end
 return ready
end
local modules={
 ['gameplay-actions.lua']=(function()${gameplayActionsSource}end)(),
 ['relationship-state.lua']={new=function()return {update=function()end,reset=function()end}end},
 ['invitation-readiness.lua']=(function()${invitationSource}end)(),
 ['knowledge-state.lua']={new=function()
  saveIdentityReads=saveIdentityReads+1;error('The Lua world adapter must not load native save identity')
 end},
 ['knowledge-parts.lua']=withKnowledgeParts and (function()${partsSource}end)() or nil,
 ['world-knowledge.lua']={new=function(options)
  worldOptions=options
  options.now=function()return now end;options.cpuNow=function()return 0 end
  options.utcNow=function()return '2026-09-30T12:00:00Z'end
  options.adapter={isReady=collectionReady,
   readFact=function()factReads=factReads+1;return factValue end,readJournal=function()return nil end,
   readLifepath=function()return 'nomad'end}
  return (function()${worldSource}end)().new(options)
 end},
 ['journal-history.lua']={new=function(options)
  historyOptions=options;options.now=function()return now end
  -- the collector paces unrequested scans by the clock; these fixtures step fake seconds, so nothing waits
  options.restGap=0;options.restFactor=0
  options.adapter={isReady=collectionReady,
   roots=function(lane)
    historyReads=historyReads+1
    return {rows=lane=='active'and{{id='100',nativeId='q001',kind='quest',state='active',title='Current quest'}}or{},
     total=lane=='active'and 1 or 0,done=true}
   end,children=function()return {rows={},total=0,done=true}end,
   tracked=function()return {status='known',questId='100'}end}
  return (function()${historySource}end)().new(options)
 end},
 ['microphone.lua']=microphone,['group-chat.lua']=group,
 ['voice-activation.lua']={sample=function()return false,true end,update=noop,off=noop,deps=nil},
 ['companions.lua']={beginSpatialFrame=noop,connectionProfiles=function()return{}end,abandon=function()record('companions')end,
  dismissAll=function()record('dismiss-all')end,conversationCandidates=function()
   local result={};for _,npc in ipairs(people)do result[#result+1]=person(npc)end;return result
  end,seatedCandidates=function()return{}end,registerPhoneContacts=noop,update=noop,owns=function()return true end,
  chauffeurOffer=function()actionOfferReads=actionOfferReads+1;return {available=false}end,
  identity=function(npc)return npc.key,npc.name,true end},
 ['subtitles.lua']={configure=noop,install=noop,update=noop,clear=noop,ownsUtterance=function()return false end,abandon=function()record('subtitles')end},
 ['speech.lua']={clearEntity=noop,update=noop,stop=noop,abandon=function()record('speech')end},
 ['character-catalog.lua']={build=function()return {records={}}end,resolve=function(_,value)return value.managedKey,value.name end},
 ['manager.lua']={configure=noop,interfaceLanguage=function()return'auto'end,subtitleStyle=function()return'dialogue'end,profileEnabled=function()return true end,
  voiceNeedsConvai=function()return false end,voiceActivation=function()return false end,padTalk=function()return false end,companionOutfits=function()return false end,reset=noop,update=noop,developerMode=function()return false end,battleReactions=function()return false end,lootReactions=function()return false end},
 ['nsui.lua']={configure=noop,install=noop,update=noop,resetSession=noop,shutdown=noop},
 ['phone-layout.lua']={install=noop,refresh=noop},['phone-chat-style.lua']={install=noop,refresh=noop},
 ['phone-chat.lua']={configure=function(_,_,options)phoneOptions=options end,update=noop,abandon=function()record('phone')end},
 ['quest-context.lua']={capture=function()return {version=1,status='untracked',serial=journalVersion}end},
 ['battle-observer.lua']={sample=function()return {available=true,combat=false,blocked=false}end,canSpeak=function()return true end},
 ['battle-reactions.lua']={new=function()return {capture=function()return {version=1,status='none',serial=journalVersion}end,
  reset=noop,update=noop,status=function()return {state='idle'}end,closingWindow=noop,offer=noop}end},
 ['loot-observer.lua']={configure=noop,install=noop,reset=noop,update=noop,drain=function()return{}end},
 ['loot-reactions.lua']={new=function()return {reset=noop,update=noop,status=function()return {pending=0}end,offer=noop}end},
 ['seated-look.lua']=(function()${seatedLookSource}end)(),
 ['companion-seating.lua']={classify=function()return 'none'end,new=function()error('companion-seating is not loaded in this fixture')end},
 ['manager-party.lua']={},['companion-locomotion.lua']={install=noop},
 ['composer-input.lua']={install=noop},['phone-input.lua']={install=noop},['movement-log.lua']={update=noop}}
local speech=modules['speech.lua']
speech.start=function(input,reply)
 playbacks[#playbacks+1]={input=copy(input),reply=copy(reply)}
 speech.requestId,speech.state,speech.duration=input.requestId,'playing',5
end
speech.stop=function()speech.requestId=nil;speech.state='stopped'end
dofile=function(name)return assert(modules[name],'Unexpected module '..name)end
local runtime=(function()
${initSource}
return {send=sendRequest,capture=captureKnowledge,step=updateKnowledge,
 pending=function()return pending end,owner=function()return knowledgeOwner(knowledgeFrame)end}
end)()
local function start()
 events.onInit();allowNative=true;events.onUpdate(0)
 for _=1,8 do runtime.step(0)end
end
local function input(id,key)
 return {requestId=id,generation=999,entity='1ULL',profileKey=key or 'judy-alvarez',name='Judy',bodyType='WomanAverage',text='Hello',sentAt=now}
end
local function tick(delta)events.onUpdate(delta or 0.1)end
local function micState(value,id)
 put('runtime/microphone-state.json',{requestId=id or assert(microphone.context).requestId,state=value})
end
local function settle()micState('recording');tick();now=now+1 end
local function respond(context,userText,failed)
 put('runtime/reply.json',{requestId=context.requestId,generation=context.generation,entity=context.entity,
  text=failed and nil or 'Reply from '..context.name,error=failed and 'Microphone failed' or nil,userText=userText})
end
local function assertHotkeyClean()
 for _,line in ipairs(logs)do
  assert(not line:find('failed:',1,true)and not line:find('observation skipped:',1,true),line)
 end
end
`;

function run(body, prelude = '') {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const checkedBody = '\nlocal fixtureOk,fixtureError=pcall(function()\n' + body
    + '\nend)\nif not fixtureOk then error(tostring(fixtureError).."\\nFixture logs:\\n"..table.concat(logs,"\\n"))end';
  const result = lauxlib.luaL_dostring(vm, to_luastring(prelude + uiLocaleBootstrap + fixture + checkedBody));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}

test('actual module and onInit remain inert; collection starts only in attached gameplay', () => run(`
 assert(nativeCalls==0 and factReads==0 and historyReads==0 and saveIdentityReads==0)
 events.onInit();assert(nativeCalls==0 and versionReads==0)
 attached=false;allowNative=true;events.onUpdate(0)
 assert(factReads==0 and historyReads==0 and versionReads==0)
 assert(stored('runtime/world-session.json').ready==false)
 attached=true;events.onUpdate(0)
 assert(versionReads==1 and factReads==1 and historyReads==1)
 local live=stored('runtime/world-session.json')
 assert(live.ready and live.token:find('lua-world-',1,true)==1 and live.generation>=1)
 assert(worldOptions.currentGeneration()==live.generation and historyOptions.currentGeneration()==live.generation)
 assert(worldOptions.currentWorldToken()==live.token and historyOptions.currentWorldToken()==live.token)
 assert(saveIdentityReads==0)
`));

test('private sends use the fresh Lua world and audience, preserving battle and loot payloads', () => run(`
 start();local live=stored('runtime/world-session.json');local first=input('first')
 first.battle={version=1,status='ended'};first.loot={batch='loot-kept'}
 assert(runtime.send(first));local out=stored('runtime/last-input.json')
 assert(out.generation==999 and out.worldKnowledge.generation==live.generation)
 assert(out.worldKnowledge.worldToken==live.token and out.worldKnowledge.identity.status=='unknown')
 assert(out.worldKnowledge.identity.userId==nil and out.worldKnowledge.identity.campaignId==nil)
 assert(out.worldKnowledge.audience.channel=='private'and #out.worldKnowledge.audience.profileKeys==1)
 assert(out.worldKnowledge.audience.profileKeys[1]=='judy-alvarez' and out.worldKnowledge.facts.observed_fact.value==1)
 assert(out.journalHistory.generation==live.generation and out.journalHistory.worldToken==live.token)
 assert(out.battle.status=='ended'and out.loot.batch=='loot-kept'and out.reaction==nil)
 assert(actionOfferReads==1 and out.chauffeurOffer==nil,'a private send checks the unavailable driving offer')
 factValue=2;hooks.OnJournalUpdate();now=now+1;runtime.step(0);out.worldKnowledge.facts.observed_fact.value=999
 assert(runtime.send(input('second')))
 assert(stored('runtime/last-input.json').worldKnowledge.facts.observed_fact.value==2)
 assert(actionOfferReads==2 and not convaiGameplayActions.inspect().pending)
 assert(versionReads==1,'pack was repeatedly configured');assert(saveIdentityReads==0)
`));

test('real send, microphone and group adapters never send the retired follow-up field', () => run(`
 start()
 assert(runtime.send(input('plain')))
 assert(stored('runtime/last-input.json').followUpQuestions==nil)
 local reaction=input('reaction');reaction.reaction={kind='loot'}
 assert(runtime.send(reaction));assert(stored('runtime/last-input.json').followUpQuestions==nil)
 assert(microphone.begin(input('mic')))
 assert(stored('runtime/microphone-command.json').input.followUpQuestions==nil)
 assert(microphone.finish())
 assert(stored('runtime/microphone-command.json').input.followUpQuestions==nil)
 microphone.cancel()
 group.start('on',{{entity='1ULL',profileKey='judy-alvarez',name='Judy'}},'Hello')
 local next=group.next(1,now,{['1ULL']=true})
 assert(runtime.send(next)and stored('runtime/last-input.json').followUpQuestions==nil)
 group.cancel();assert(not group.round and not microphone.context)
`));

test('current facts do not require native save identity and transient world ownership rotates on load', () => run(`
 start();assert(runtime.send(input('no-native-identity')))
 local before=stored('runtime/world-session.json');local out=stored('runtime/last-input.json')
 assert(before.ready and before.token:find('lua-world-',1,true)==1)
 assert(out.worldKnowledge.status=='ready'and out.worldKnowledge.identity.status=='unknown')
 assert(out.worldKnowledge.worldToken==before.token and out.worldKnowledge.generation==before.generation)
 allowNative=false;hooks.OnDetach();assert(stored('runtime/world-session.json').ready==false)
 assert(runtime.pending()==nil and runtime.capture(input('late'))==nil)
 hooks.OnGameAttached();events.onUpdate(0)
 assert(stored('runtime/world-session.json').ready==false,'attach before the restore revived the world')
 hooks.OnGameRestored();allowNative=true;events.onUpdate(0)
 local after=stored('runtime/world-session.json')
 assert(after.ready and after.token~=before.token and after.generation>before.generation)
 assert(runtime.send(input('next-world')))
 assert(stored('runtime/last-input.json').worldKnowledge.identity.status=='unknown'and saveIdentityReads==0)
`));

test('unsupported live version fails closed for reviewed facts while ordinary chat still sends', () => run(`
 gameVersion='2.99';start();assert(runtime.send(input('unsupported')))
 assert(versionReads==1 and factReads==0)
 assert(stored('runtime/last-input.json').worldKnowledge.status=='unavailable')
`));

test('native collection stays bounded per frame and expired snapshots never reuse old facts', () => run(`
 local facts={};for i=1,100 do facts['fact_'..i]={evidenceRefs={'reviewed-proof'}}end
 put('world-knowledge.json',{version=1,gameVersions={'2.31'},factAllowlist=facts,journalAllowlist={}})
 events.onInit();allowNative=true;events.onUpdate(0)
 assert(factReads==32 and runtime.capture(input('partial')).worldKnowledge.status=='unavailable')
 for _=1,2 do local before=factReads;runtime.step(0);assert(factReads-before<=32)end
 assert(factReads==96 and runtime.capture(input('partial-two')).worldKnowledge.status=='unavailable')
 runtime.step(0);assert(factReads==100)
 assert(runtime.capture(input('complete')).worldKnowledge.status=='ready')
 now=now+46
 assert(runtime.capture(input('expired')).worldKnowledge.status=='unavailable')
`));

test('the knowledge collectors rest between scans and rescan on a journal change or before a turn', () => run(`
 start();local facts,history=factReads,historyReads
 for _=1,18 do now=now+0.5;tick() end
 assert(factReads==facts and historyReads==history,'resting: '..(factReads-facts)..' fact and '..(historyReads-history)..' history reads')
 -- A journal change rescans both once the burst settles (1 s).
 hooks.OnJournalUpdate();tick();assert(factReads==facts,'not within the same second')
 now=now+1;tick();assert(factReads>facts and historyReads>history,'rescanned after a journal change')
 -- The composer, phone chat and talk key demand a scan before the turn.
 facts=factReads;convaiDemandKnowledge();tick();assert(factReads>facts,'rescanned on demand')
 -- Opening a phone chat demands one; closing it (contact '') does not.
 for _=1,18 do now=now+0.5;tick() end
 facts=factReads;convaiPhoneChat.contact='judy';tick();assert(factReads>facts,'phone chat opening rescanned')
 for _=1,18 do now=now+0.5;tick() end
 facts=factReads;convaiPhoneChat.contact='';tick();assert(factReads==facts,'phone chat closing rescanned')
`));

test('text, voice and group turns name the world and journal parts by revision, written once beside the request', () => run(`
 start();local first=input('parts')
 assert(runtime.send(first));local out=stored('runtime/last-input.json')
 local world,active=stored('runtime/knowledge-world.json'),stored('runtime/knowledge-active.json')
 assert(out.worldKnowledge.facts==nil and out.worldKnowledge.ref.part=='world','the request names the world part')
 assert(world.part=='world' and world.revision==out.worldKnowledge.ref.revision and world.data.facts.observed_fact.value==1)
 assert(world.worldToken==out.worldKnowledge.worldToken and world.generation==out.worldKnowledge.generation)
 assert(out.journalHistory.lanes.active.ids[1]=='100' and active.data.quests['100'].title=='Current quest')
 local written=files['runtime/knowledge-world.json'];files['runtime/knowledge-world.json']='untouched'
 assert(runtime.send(input('parts-again')))
 assert(files['runtime/knowledge-world.json']=='untouched','an unchanged revision is not written again')
 files['runtime/knowledge-world.json']=written
 assert(microphone.begin(input('mic-parts')))
 assert(stored('runtime/microphone-command.json').input.worldKnowledge.ref.revision==world.revision)
 microphone.cancel()
`, 'withKnowledgeParts=true;'));

test('shared resident profiles never receive a verified knowledge identity', () => run(`
 start();assert(runtime.send(input('resident','resident-male')))
 assert(stored('runtime/last-input.json').worldKnowledge.identity.status=='unknown')
 local mixed=input('mixed');mixed.group={id='group',index=1,total=2,audience={'judy-alvarez','resident-male'},heard={}}
 assert(runtime.send(mixed));assert(stored('runtime/last-input.json').worldKnowledge.identity.status=='unknown')
`));

test('actual group preview and dispatch capture the exact current audience and refresh facts at send', () => run(`
 start()
 local people={{entity='1ULL',profileKey='judy-alvarez',name='Judy'}, {entity='2ULL',profileKey='alex',name='Alex'},
  {entity='3ULL',profileKey='resident-male',name='Resident'}}
 local live={['1ULL']=true,['2ULL']=true,['3ULL']=true}
 group.start('round',people,'Hello everyone')
 local first=group.next(1,now,live);assert(runtime.send(first))
 group.received(first.requestId,'Hello V',false,{'judy-alvarez','alex','resident-male'})
 live['3ULL']=nil
 local prepared=group.preview(2,now,live)
 local preview=stored('runtime/group-prefetch.json').input
 assert(preview.worldKnowledge.audience.channel=='group'and #preview.worldKnowledge.audience.profileKeys==2)
 assert(preview.worldKnowledge.audience.profileKeys[2]=='alex'and preview.worldKnowledge.identity.status=='unknown')
 assert(preview.worldKnowledge.worldToken==stored('runtime/world-session.json').token)
 hooks.OnJournalUpdate();now=now+1;factValue=3;runtime.step(0)
 group.completed(first.requestId,true);local next=group.next(3,now,live)
 assert(next.requestId==prepared.requestId and runtime.send(next))
 assert(stored('runtime/last-input.json').worldKnowledge.facts.observed_fact.value==3)
 assert(stored('runtime/last-input.json').group.heard[1].text=='Hello V')
`));

test('a world change during capture prevents request publication', () => run(`
 start();assert(runtime.send(input('before')));local prior=files['runtime/last-input.json']
 local before=stored('runtime/world-session.json')
 afterReady=function()hooks.OnGameRestored()end
 assert(runtime.send(input('racing'))==false)
 assert(files['runtime/last-input.json']==prior)
 assert(not stored('runtime/world-session.json').ready)
 events.onUpdate(0);local after=stored('runtime/world-session.json')
 assert(after.ready and after.token~=before.token and after.generation>before.generation)
`));

test('private and microphone sends recheck world ownership after existing journal capture hooks', () => run(`
 start()
 modules['quest-context.lua'].capture=function()hooks.OnGameRestored();return {version=1,status='untracked'}end
 assert(runtime.send(input('journal-race'))==false and files['runtime/last-input.json']==nil)
 events.onUpdate(0)
 microphone.captureJournal=function()hooks.OnGameRestored();return {version=1,status='untracked'}end
 assert(microphone.begin(input('mic-journal-race'))==false and files['runtime/microphone-command.json']==nil)
 microphone.captureJournal=function()return {version=1,status='untracked'}end
 events.onUpdate(0);assert(microphone.begin(input('mic-finish-race')))
 microphone.captureBattle=function()hooks.OnGameRestored();return {version=1,status='none'}end
 assert(microphone.finish()==nil and stored('runtime/microphone-command.json').action=='cancel')
`));

test('death retires the Lua world before actor cleanup, and shutdown publishes unavailable', () => run(`
 start();assert(runtime.send(input('pending')))
 order={};allowNative=false;hooks.OnDeath()
 assert(order[1]=='world:unavailable'and order[2]=='companions')
 assert(runtime.pending()==nil and not stored('runtime/world-session.json').ready)
 hooks.OnTakeControl();allowNative=true;events.onUpdate(0)
 order={};events.onShutdown()
 assert(order[1]=='world:unavailable'and not stored('runtime/world-session.json').ready)
`));

test('save restoration retires private, microphone and group work without dismissing actors', () => run(`
 start();assert(runtime.send(input('pending')))
 assert(microphone.begin(input('recording')))
 group.start('round',{{entity='1ULL',profileKey='judy-alvarez',name='Judy'}},'Hello')
 local before=stored('runtime/world-session.json')
 order={};hooks.OnGameRestored();events.onUpdate(0)
 assert(runtime.pending()==nil and microphone.context==nil and group.round==nil)
 for _,value in ipairs(order)do assert(value~='dismiss-all','loading a world deleted actors')end
 local after=stored('runtime/world-session.json')
 assert(after.ready and after.token~=before.token and after.generation>before.generation)
`));

test('phone callbacks share the Lua world and reject captured history after a save restore', () => run(`
 start();local live=stored('runtime/world-session.json');local binding=phoneOptions.captureBinding(player)
 assert(binding.generation==live.generation and binding.status=='unavailable'and binding.authoritative==false)
 assert(binding.localUserId==nil and binding.campaignId==nil)
 local world=phoneOptions.captureWorldKnowledge(player,'alex',binding)
 local history=phoneOptions.captureJournalHistory(player,'alex',binding)
 assert(world.audience.channel=='phone'and #world.audience.profileKeys==1 and world.audience.profileKeys[1]=='alex')
 assert(world.identity.status=='unknown'and world.worldToken==live.token)
 assert(history.generation==world.generation and history.worldToken==world.worldToken)
 phoneOptions.captureWorldKnowledge(player,'alex',binding);hooks.OnGameRestored()
 assert(phoneOptions.captureJournalHistory(player,'alex',binding).status=='unavailable')
`));

test('phone delivery publication is bounded, deduplicated and retains the original request world', () => run(`
 start();local live=stored('runtime/world-session.json');local original=live.token;hooks.OnGameRestored();events.onUpdate(0)
 for i=1,20 do phoneOptions.onDelivered({version=1,id='delivery-'..i,sequence=i,requestId='request-'..i,
  source='phone-ui',state='accepted',partial=false,cancelled=false,completedAt=now*1000,
  profileKey='alex',contact='alex',world='phone-world',binding='original-phone-binding',generation=live.generation,worldToken=original,
  text='not a receipt field',nativeHandle={bad=true}})end
 local value=stored('runtime/knowledge-phone-delivery.json')
 assert(#value.receipts==16 and value.receipts[1].id=='delivery-5')
 assert(value.receipts[16].generation==live.generation and value.receipts[16].worldToken==original)
 assert(stored('runtime/world-session.json').token~=original)
 assert(value.receipts[1].text==nil and value.receipts[1].nativeHandle==nil)
 local before=files['runtime/knowledge-phone-delivery.json']
 phoneOptions.onDelivered(value.receipts[16]);phoneOptions.onDelivered({id='invalid',source='other'})
 assert(files['runtime/knowledge-phone-delivery.json']==before)
`));

test('phone delivery receipts are written in place: no temp file, no remove, no rename of the exchange file', () => run(`
 start();local live=stored('runtime/world-session.json');local original=live.token;hooks.OnGameRestored();events.onUpdate(0)
 local removed,renamed=os.remove,os.rename
 os.remove=function(path) assert(not tostring(path):find('knowledge-phone-delivery',1,true),'removed '..path);return removed(path) end
 os.rename=function(from,to)
  assert(not tostring(from):find('knowledge-phone-delivery',1,true) and not tostring(to):find('knowledge-phone-delivery',1,true),'renamed '..from)
  return renamed(from,to)
 end
 files['runtime/knowledge-phone-delivery.json']=''
 phoneOptions.onDelivered({version=1,id='delivery-1',sequence=1,requestId='request-1',
  source='phone-ui',state='accepted',partial=false,cancelled=false,completedAt=now*1000,
  profileKey='alex',contact='alex',world='phone-world',binding='original-phone-binding',generation=live.generation,worldToken=original})
 assert(#stored('runtime/knowledge-phone-delivery.json').receipts==1)
 assert(files['runtime/knowledge-phone-delivery.json.tmp']==nil)
`));

test('microphone begin and finish capture fresh facts without changing request ownership', () => run(`
 start();local live=stored('runtime/world-session.json');local context=input('mic')
 assert(microphone.begin(context))
 local initial=stored('runtime/microphone-command.json')
 assert(initial.action=='start'and initial.input.worldKnowledge.facts.observed_fact.value==1)
 factValue=4;journalVersion=2;hooks.OnJournalUpdate();now=now+1;runtime.step(0)
 assert(microphone.finish()==context)
 local final=stored('runtime/microphone-command.json')
 assert(final.action=='finish'and final.input.worldKnowledge.facts.observed_fact.value==4)
 assert(final.input.requestId=='mic'and final.input.generation==999 and final.input.worldKnowledge.generation==live.generation)
 assert(final.input.worldKnowledge.worldToken==live.token and final.input.worldKnowledge.identity.status=='unknown')
 assert(final.input.journal.serial==2 and final.input.battle.status=='none')
`));

test('microphone recording cancels on world change or failed finish write without submitting stale facts', () => run(`
 start();assert(microphone.begin(input('mic-stale')));hooks.OnGameRestored()
 assert(microphone.finish()==nil and microphone.context==nil)
 assert(stored('runtime/microphone-command.json').action=='cancel')
 events.onUpdate(0);assert(microphone.begin(input('mic-write')))
 failPath='runtime/microphone-command.json'
 assert(microphone.finish()==nil and microphone.context==nil and microphone.knowledgeOwner==nil)
 failPath=nil;assert(microphone.begin(input('mic-update')))
 hooks.OnGameRestored();microphone.update(player)
 assert(microphone.context==nil and stored('runtime/microphone-command.json').action=='cancel')
`));

test('temporary collector unavailability preserves the Lua world and omits old facts until fresh capture recovers', () => run(`
 start();local context=input('saving-mic');assert(microphone.begin(context))
 local live=stored('runtime/world-session.json');collectorReady=false
 order={};runtime.step(0)
 local stalled=stored('runtime/world-session.json')
 assert(stalled.ready and stalled.token==live.token and stalled.generation==live.generation and #order==0)
 assert(microphone.update(player)==nil and microphone.context==context)
 assert(microphone.finish()==context)
 local unavailable=stored('runtime/microphone-command.json')
 assert(unavailable.action=='finish'and unavailable.input.worldKnowledge.status=='unavailable')
 assert(unavailable.input.worldKnowledge.facts==nil and unavailable.input.journalHistory.status=='unavailable')
 collectorReady=true;factValue=6;now=now+1;runtime.step(0)
 assert(microphone.begin(input('after-save'))and microphone.finish())
 local recovered=stored('runtime/microphone-command.json').input
 assert(recovered.worldKnowledge.status=='ready'and recovered.worldKnowledge.facts.observed_fact.value==6)
 assert(recovered.worldKnowledge.worldToken==live.token and recovered.worldKnowledge.generation==live.generation)
`));

test('real group voice hotkey freezes three distinct speakers, uses the first microphone reply once and sequences recognized text', () => run(`
 start();looked=resident;people={judy,actor('judy-alvarez',4,'Judy copy'),alex,resident}
 assert(hotkeyLabels.cyberpunk_convai_group_voice=='AI NPC Cyberpunk Mod: group voice chat')
 talkDown(GROUP)
 local context=microphone.context;local first=stored('runtime/microphone-command.json').input
 assert(context and group.round.stage=='recording'and runtime.pending()==nil)
 assert(first.profileKey=='resident-male'and first.group.index==1 and first.group.total==3)
 assert(table.concat(first.group.audience,',')=='resident-male,judy-alvarez,alex')
 assert(first.worldKnowledge.audience.channel=='group'and first.followUpQuestions==nil)
 tick();assert(files['runtime/last-input.json']==nil and #commands==1)
 micState('recording');tick();assert(#feedback==0,'a normal voice turn shows no notice: '..tostring(feedback[1]))
 looked=judy;people={alex};hooks.OnJournalUpdate();now=1002;journalVersion=2;factValue=2;runtime.step(0)
 talkDown(VOICE);talkUp(VOICE)
 assert(microphone.context==context and #commands==1 and group.round.stage=='recording','the other mode key does nothing to a recording')
 assert(#feedback==0,'and says nothing: '..tostring(feedback[1]))
 talkUp(GROUP)
 local finish=commands[#commands]
 assert(#commands==2 and finish.action=='finish'and finish.source=='release'and finish.input.requestId==first.requestId)
 assert(finish.input.profileKey=='resident-male'and #finish.input.group.audience==3)
 assert(finish.input.followUpQuestions==nil and finish.input.journal.serial==2 and finish.input.battle.serial==2)
 assert(finish.input.worldKnowledge.facts.observed_fact.value==2)
 assert(group.round.stage=='waiting'and runtime.pending()==context and not files['runtime/last-input.json'])
 talkDown(GROUP);talkUp(GROUP);assert(#commands==2,'a press while the reply is on its way changes nothing')
 respond(context,'What would you all like to do tonight?');tick()
 assert(#playbacks==1 and playbacks[1].input.entity==resident.entity and not microphone.context)
 assert(group.round.stage=='playing'and group.round.text=='What would you all like to do tonight?')
 tick();local preview=stored('runtime/group-prefetch.json').input
 assert(preview.profileKey=='judy-alvarez'and preview.group.index==2 and preview.group.total==3)
 assert(preview.text=='What would you all like to do tonight?'and preview.followUpQuestions==nil)
 assert(preview.journal.serial==2 and preview.battle.serial==2 and not files['runtime/last-input.json'])
 speech.requestId=nil;tick();local second=stored('runtime/last-input.json')
 assert(second.requestId==preview.requestId and second.entity==judy.entity and #playbacks==1)
 assert(second.text~='[Microphone]'and second.group.heard[1].speaker=='Resident')
 respond(second);tick();assert(#playbacks==2)
 speech.requestId=nil;tick();local third=stored('runtime/last-input.json')
 assert(third.profileKey=='alex'and third.group.index==third.group.total and third.followUpQuestions==nil)
 assert(third.text=='What would you all like to do tonight?'and #third.group.heard==2)
 respond(third);tick();speech.requestId=nil;tick()
 assert(#playbacks==3 and group.round==nil and #commands==2)
 assertHotkeyClean()
`));

test('the talk key is hold to talk: down begins at once, up finishes at once even while the bridge is still opening, a short hold is dropped silently, every edge is logged', () => run(`
 start();looked=judy;people={judy,alex}
 local checks=0;local function A(ok,message)checks=checks+1;if not ok then error('check '..checks..': '..tostring(message),2)end end
 local key=rawInputs[VOICE];A(key,'the talk key reports its press and release')
 local function lastCommand()return commands[#commands]end
 local function live()return stored('runtime/microphone-live.json')end
 -- key down then up before the bridge ever reports 'recording': start, then finish, in that order
 key(true)
 A(microphone.context and microphone.state=='starting' and #commands==1 and lastCommand().action=='start' and lastCommand().source=='press')
 A(type(lastCommand().hold)=='string' and lastCommand().hold~='','the start command carries the key press id')
 A(live().down==true and live().holdId==lastCommand().hold,'the live file shows the key down')
 local hold=lastCommand().hold
 now=now+1.5;key(false)
 A(#commands==2 and commands[1].action=='start' and lastCommand().action=='finish' and lastCommand().source=='release','release finished it while the bridge was still opening: '..#commands)
 A(live().down==false and live().holdId==hold,'the live file shows the key up')
 A(microphone.state=='reply' and #feedback==0,'no notice')
 respond(microphone.context);tick();A(not microphone.context and #feedback==0)
 -- a normal hold: down, the bridge says recording, up. Not one notice.
 now=now+3;key(true);A(microphone.state=='starting' and #commands==3)
 A(lastCommand().hold~=hold,'a new press has its own id')
 micState('recording');tick();A(microphone.state=='recording')
 now=now+2.5;key(false)
 A(#commands==4 and lastCommand().action=='finish' and lastCommand().source=='release','releasing the hold finished it')
 A(microphone.state=='reply' and #feedback==0,'a normal turn sends no notice at all: '..tostring(feedback[1]))
 respond(microphone.context);tick();A(not microphone.context and #feedback==0)
 -- a 100 ms hold is a bounce: start, then cancel, never a finish, no notice
 now=now+3;key(true);A(microphone.state=='starting' and #commands==5 and lastCommand().action=='start')
 now=now+0.1;key(false)
 A(#commands==6 and lastCommand().action=='cancel' and lastCommand().source=='tap' and not microphone.context,'the bounce was cancelled')
 A(#feedback==0,'silently: '..tostring(feedback[1]))
 A(live().down==false)
 -- key repeat while held is one press, a press while recording changes nothing, a release without a press is harmless
 now=now+3;key(true);key(true);key(true);A(#commands==7 and lastCommand().action=='start')
 micState('recording');tick();A(microphone.state=='recording')
 local other=rawInputs[GROUP];other(true);other(false);A(#commands==7 and microphone.context and not microphone.context.group,'the other mode key does nothing')
 now=now+1;key(false);key(false);A(#commands==8 and lastCommand().action=='finish' and lastCommand().source=='release')
 A(#feedback==0)
 local logged=table.concat(logs,' | ')
 A(logged:find('Voice key voice down: recording idle -> starting (this press began it)',1,true))
 A(logged:find('Voice key voice up after 1500 ms: hold: finish',1,true),logged)
 A(logged:find('Voice key voice up after 2500 ms: hold: finish',1,true))
 A(logged:find('Voice key voice up after 100 ms: tap: dropped',1,true))
 A(logged:find('Microphone command: finish source=release',1,true))
 A(logged:find('Microphone command: cancel source=tap',1,true))
`));

test('a recording that is already running keeps its owner when the same key is pressed again, and an overdue reply is dropped by the next press', () => run(`
 start();looked=judy;people={judy,alex}
 local key=rawInputs[VOICE]
 key(true);local context=microphone.context
 -- the key is lost (focus change) and comes down again after a quiet moment: still one recording
 now=now+1;key(true);assert(microphone.context==context and #commands==1)
 micState('recording');tick();now=now+1;key(false)
 assert(microphone.state=='reply' and #commands==2)
 -- a press while the reply is on its way changes nothing, a press once it is overdue starts a fresh recording
 now=now+3;key(true);key(false);assert(microphone.context==context and #commands==2 and #feedback==0)
 now=now+8;key(true)
 assert(microphone.context and microphone.context~=context and microphone.state=='starting')
 assert(commands[#commands].action=='start' and commands[#commands-1].action=='cancel' and commands[#commands-1].input.requestId==context.requestId)
 now=now+1;key(false);assert(commands[#commands].action=='finish')
 assertHotkeyClean()
`));

test('registered action names respect live CET chords and no recording hint names a key', () => run(`
 start();looked=judy;people={judy,alex}
 local bindings={cyberpunk_convai_group_voice='Ctrl + H',cyberpunk_convai_voice='Alt + Num 5'}
 IsBound=function(id)return bindings[id]~=nil end
 GetBind=function(id)return bindings[id]or'Unbound'end
 for _,label in pairs(hotkeyLabels)do assert(not label:match('F%d+'),'hardcoded function key in an action label')end
 talkDown(GROUP);micState('recording');tick()
 assert(#feedback==0,'no Listening line, whatever the chord: '..tostring(feedback[1]))
 bindings.cyberpunk_convai_group_voice='Shift + K'
 talkDown(VOICE);talkUp(VOICE)
 assert(#feedback==0,'no finish hint from the other mode key: '..tostring(feedback[1]))
 bindings.cyberpunk_convai_group_voice=nil;talkDown(VOICE);talkUp(VOICE)
 assert(#feedback==0 and #commands==1,'nothing at all: '..tostring(feedback[1]))
 talkUp(GROUP);assert(commands[#commands].action=='finish')
`));

test('private and group text/voice share the explicitly addressed primary and unsupported targets never redirect', () => run(`
 start();people={judy,alex,resident};looked=alex
 hotkeys.cyberpunk_convai_text();assert(player.composerName=='Alex')
 player.composer=false;tick()
 hotkeys.cyberpunk_convai_group_text();assert(player.composerName=='Alex')
 player.submission='Text group';player.composer=false;tick();tick()
 local input=stored('runtime/last-input.json');assert(input.profileKey=='alex'and input.group.index==1)
 talkDown(VOICE);assert(microphone.context.profileKey=='alex'and not microphone.context.group)
 local original=microphone.context;local count=#commands;local shown=#feedback
 talkDown(GROUP);talkUp(GROUP)
 assert(microphone.context==original and #commands==count and #feedback==shown,'the other mode key does nothing and shows no hint')
 micState('recording');tick();assert(#feedback==shown,'no Listening line')
 talkUp(VOICE);respond(microphone.context);tick();assert(not microphone.context)
 looked=actor('not-configured',4,'Unconfigured');count=#commands
 for _,key in ipairs({'cyberpunk_convai_text','cyberpunk_convai_group_text','cyberpunk_convai_voice','cyberpunk_convai_group_voice'})do
  if rawInputs[key]then talkDown(key);talkUp(key)else hotkeys[key]()end
  assert(#commands==count and not player.composer)
  assert(feedback[#feedback]:find('Unconfigured does not have',1,true))
 end
 looked=judy;people={judy,actor('judy-alvarez',4,'Second Judy')}
 talkDown(GROUP);talkUp(GROUP);assert(#commands==count and not microphone.context)
 assert(feedback[#feedback]=='Group chat needs two characters nearby. Use private chat for one person.')
 looked=nil;people={alex,judy};talkDown(GROUP)
 assert(microphone.context.profileKey=='alex'and microphone.context.group.index==1)
 assertHotkeyClean()
`));

test('group voice missing transcript, first error and stale recognized replies never submit later speakers', () => run(`
 start();looked=judy;people={judy,alex}
 for _,kind in ipairs({'missing','empty','placeholder','error'})do
  talkDown(GROUP);local context=microphone.context
  settle();talkUp(GROUP)
  local recognized=kind=='empty'and ''or kind=='placeholder'and '[Microphone]'or nil
  respond(context,recognized,kind=='error');tick()
  assert(not group.round and not microphone.context and not files['runtime/last-input.json'])
  speech.requestId=nil;tick();tick()
  assert(not files['runtime/last-input.json'])
  local count=#playbacks;respond(context,'A late recognized message');tick()
  assert(#playbacks==count and not group.round)
 end
 assertHotkeyClean()
`));

test('group voice pause cancels at zero delta, save callbacks cancel ownership and old results cannot revive the round', () => run(`
 start();looked=judy;people={judy,alex}
 -- A menu ends a recording that is still opening or running. A turn already sent (waiting for its reply) completes like a typed one.
 do
  talkDown(GROUP);local context=microphone.context
  local plays=#playbacks
  paused=true;tick(0)
  assert(not group.round and not microphone.context and runtime.pending()==nil and not speech.requestId)
  paused=false;talkUp(GROUP);respond(context,'Late reply');tick();tick()
  assert(#playbacks==plays and not files['runtime/last-input.json'])
 end
 do
  talkDown(GROUP);local context=microphone.context
  settle();talkUp(GROUP)
  paused=true;tick(0)
  assert(group.round and group.round.stage=='waiting' and microphone.context==context and runtime.pending()==context, 'a sent turn survives the menu')
  paused=false;respond(context,'Spoken while the menu was open');tick();tick()
  assert(#playbacks==1 and group.round and group.round.text=='Spoken while the menu was open', 'the reply plays when V is back')
  group.cancel();speech.requestId=nil
 end
 talkDown(GROUP);local context=microphone.context
 settle();talkUp(GROUP);hooks.OnGameRestored()
 assert(not microphone.context and not group.round and not runtime.pending())
 local plays=#playbacks;respond(context,'Old save message');tick();tick()
 assert(#playbacks==plays and not group.round and not files['runtime/last-input.json'])
 assertHotkeyClean()
`));

test('group voice losing the frozen primary cancels at every stage and never substitutes the current camera target', () => run(`
 start();people={judy,alex,resident}
 for _,stage in ipairs({'recording','waiting','playing'})do
  judy.attached=true;looked=judy
  talkDown(GROUP);local context=microphone.context
  if stage~='recording'then settle();talkUp(GROUP)end
  if stage=='playing'then respond(context,'Recognized question');tick()end
  local plays=#playbacks
  judy.attached=false;looked=alex;tick()
  assert(not group.round and not microphone.context and not runtime.pending())
  respond(context,'Late question');tick();tick()
  assert(#playbacks==plays and not files['runtime/last-input.json'])
  if stage=='recording'then talkUp(GROUP)end
 end
 assertHotkeyClean()
`));

test('group voice microphone device failure and automatic 30 second finish keep exact request ownership', () => run(`
 start();looked=judy;people={judy,alex}
 talkDown(GROUP);local first=microphone.context
 micState('error');tick();talkUp(GROUP)
 assert(not microphone.context and not group.round and not runtime.pending())
 respond(first,'Stale device request');tick();assert(#playbacks==0)
 talkDown(GROUP);local second=microphone.context
 micState('recording');tick();now=now+30;tick()
 assert(runtime.pending()==second and group.round.stage=='waiting')
 assert(commands[#commands].action=='finish'and commands[#commands].input.requestId==second.requestId)
 respond(second,'A bounded microphone question');tick()
 assert(#playbacks==1 and group.round.text=='A bounded microphone question')
 assertHotkeyClean()
`));

test('group voice retires microphone and group exactly at the reply deadline before late results, then accepts a fresh recording', () => run(`
 start();looked=judy;people={judy,alex}
 talkDown(GROUP);local expired=microphone.context
 settle();talkUp(GROUP)
 assert(microphone.state=='reply'and group.round.stage=='waiting'and runtime.pending()==expired)
 now=expired.sentAt+89;tick()
 assert(runtime.pending()==expired and microphone.context==expired and group.round.stage=='waiting')
 assert(#commands==2 and not speech.requestId)
 now=expired.sentAt+90;respond(expired,'Arrived at the deadline');tick()
 assert(not runtime.pending()and not microphone.context and not group.round and #playbacks==0)
 assert(commands[#commands].action=='cancel'and commands[#commands].input.requestId==expired.requestId)
 assert(feedback[#feedback]:find('No reply arrived.',1,true))
 assert(files['runtime/group-prefetch.json']=='{}')
 now=now+1;respond(expired,'Late recognized text');tick();tick()
 assert(#playbacks==0 and not runtime.pending()and not group.round and #commands==3)
 talkDown(GROUP);local fresh=microphone.context
 assert(fresh and fresh.requestId~=expired.requestId and group.round.stage=='recording')
 assert(commands[#commands].action=='start'and commands[#commands].input.requestId==fresh.requestId)
 settle();talkUp(GROUP);tick()
 assert(runtime.pending()==fresh and #playbacks==0 and group.round.stage=='waiting')
 respond(fresh,'The current spoken question');tick()
 assert(#playbacks==1 and playbacks[1].input.requestId==fresh.requestId)
 assert(group.round.text=='The current spoken question'and not microphone.context)
 assertHotkeyClean()
`));

test('group voice later-speaker timeout retires its group without restarting the completed microphone request', () => run(`
 start();looked=judy;people={judy,alex}
 talkDown(GROUP);local first=microphone.context
 settle();talkUp(GROUP);respond(first,'Actual group question');tick()
 speech.requestId=nil;tick();local expired=runtime.pending()
 assert(expired and expired.profileKey=='alex'and not microphone.context and #playbacks==1)
 now=expired.sentAt+90;respond(expired,'Late text from another speaker');tick()
 assert(not runtime.pending()and not group.round and not microphone.context and #playbacks==1)
 assert(#commands==2 and not speech.requestId and files['runtime/group-prefetch.json']=='{}')
 now=now+1;tick();assert(#playbacks==1)
 talkDown(GROUP)
 assert(microphone.context and group.round.stage=='recording'and #commands==3)
 assertHotkeyClean()
`));
