import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const source = name => readFileSync(new URL(`../mod/${name}.lua`, import.meta.url), 'utf8');
const initSource = source('init');
const microphoneSource = source('microphone');
const groupSource = source('group-chat');
const worldSource = source('world-knowledge');
const historySource = source('journal-history');
const invitationSource = source('invitation-readiness');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

const fixture = `
local function copy(value)
 if type(value)~='table'then return value end
 local result={};for key,item in pairs(value)do result[key]=copy(item)end;return result
end
local files,encoded,serial,events,hooks,hotkeys={},{},0,{},{},{}
local allowNative,attached,dead,preGame,paused=false,true,false,false,false
local nativeCalls,versionReads,factReads,historyReads,saveIdentityReads=0,0,0,0,0
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
  files[path]=(mode=='a'and(files[path]or'')or'')..table.concat(values);return true
 end,close=function()return true end}
end}
os.time=function()return now end
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
local player=setmetatable({}, {__index=function()return noop end})
function player:IsAttached()return attached end
function player:IsDeadNoStatPool()return dead end
function player:ConvaiComposerOpen()return false end
function player:GetEntityID()return {hash='player'}end
function player:ConvaiManagerVoice()return true end
function player:ConvaiManagerSubtitles()return true end
local function native()assert(allowNative,'init-time native call');nativeCalls=nativeCalls+1 end
Game={GetPlayer=function()native();return player end,
 GetSystemRequestsHandler=function()native();return {IsPreGame=function()return preGame end,
 IsGamePaused=function()return paused end,GetGameVersion=function()versionReads=versionReads+1;return gameVersion end}end,
 GetAllBlackboardDefs=function()native();return {UI_System={IsInMenu='menu'}}end,
 GetBlackboardSystem=function()native();return {Get=function()return {GetBool=function()return paused end}end}end}
registerForEvent=function(key,fn)events[key]=fn end
registerHotkey=function(key,_,fn)hotkeys[key]=fn end
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
 ['invitation-readiness.lua']=(function()${invitationSource}end)(),
 ['knowledge-state.lua']={new=function()
  saveIdentityReads=saveIdentityReads+1;error('The Lua world adapter must not load native save identity')
 end},
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
 ['companions.lua']={connectionProfiles=function()return{}end,abandon=function()record('companions')end,
  dismissAll=function()record('dismiss-all')end,conversationCandidates=function()return{}end,registerPhoneContacts=noop,update=noop},
 ['subtitles.lua']={configure=noop,install=noop,update=noop,clear=noop,abandon=function()record('subtitles')end},
 ['speech.lua']={clearEntity=noop,update=noop,stop=noop,abandon=function()record('speech')end},
 ['character-catalog.lua']={build=function()return {records={}}end},
 ['manager.lua']={configure=noop,subtitleStyle=function()return'dialogue'end,profileEnabled=function()return true end,
  reset=noop,update=noop,battleReactions=function()return false end,lootReactions=function()return false end},
 ['mcm.lua']={configure=noop,install=noop,update=noop,resetSession=noop,shutdown=noop},
 ['phone-layout.lua']={install=noop,refresh=noop},['phone-chat-style.lua']={install=noop,refresh=noop},
 ['phone-chat.lua']={configure=function(_,_,options)phoneOptions=options end,update=noop,abandon=function()record('phone')end},
 ['quest-context.lua']={capture=function()return {version=1,status='untracked',serial=journalVersion}end},
 ['battle-observer.lua']={sample=function()return {available=true,combat=false,blocked=false}end},
 ['battle-reactions.lua']={new=function()return {capture=function()return {version=1,status='none'}end,reset=noop}end},
 ['loot-observer.lua']={configure=noop,install=noop,reset=noop},
 ['loot-reactions.lua']={new=function()return {reset=noop}end},
 ['manager-party.lua']={},['mcm-entry.lua']={},['companion-locomotion.lua']={install=noop},
 ['composer-input.lua']={install=noop},['phone-input.lua']={install=noop}}
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
`;

function run(body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(fixture + '\n' + body));
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
 first.battle={version=1,status='ended'};first.loot={batch='loot-kept'};first.reaction={kind='loot'}
 assert(runtime.send(first));local out=stored('runtime/last-input.json')
 assert(out.generation==999 and out.worldKnowledge.generation==live.generation)
 assert(out.worldKnowledge.worldToken==live.token and out.worldKnowledge.identity.status=='unknown')
 assert(out.worldKnowledge.identity.userId==nil and out.worldKnowledge.identity.campaignId==nil)
 assert(out.worldKnowledge.audience.channel=='private'and #out.worldKnowledge.audience.profileKeys==1)
 assert(out.worldKnowledge.audience.profileKeys[1]=='judy-alvarez' and out.worldKnowledge.facts.observed_fact.value==1)
 assert(out.journalHistory.generation==live.generation and out.journalHistory.worldToken==live.token)
 assert(out.battle.status=='ended'and out.loot.batch=='loot-kept'and out.reaction.kind=='loot')
 factValue=2;now=now+1;runtime.step(0);out.worldKnowledge.facts.observed_fact.value=999
 assert(runtime.send(input('second')))
 assert(stored('runtime/last-input.json').worldKnowledge.facts.observed_fact.value==2)
 assert(versionReads==1,'pack was repeatedly configured');assert(saveIdentityReads==0)
`));

test('real send, microphone and group adapters snapshot follow-up settings without reopening conversations', () => run(`
 start();local enabled=false
 modules['manager.lua'].followUpQuestions=function()return enabled end
 assert(runtime.send(input('off')))
 assert(stored('runtime/last-input.json').followUpQuestions==false)
 enabled=true;assert(runtime.send(input('on')))
 assert(stored('runtime/last-input.json').followUpQuestions==true)
 local reaction=input('reaction');reaction.reaction={kind='loot'};reaction.followUpQuestions=true
 assert(runtime.send(reaction));assert(stored('runtime/last-input.json').followUpQuestions==false)
 assert(microphone.begin(input('mic-on')))
 assert(stored('runtime/microphone-command.json').input.followUpQuestions==true)
 enabled=false;assert(microphone.finish())
 assert(stored('runtime/microphone-command.json').input.followUpQuestions==true)
 microphone.cancel()
 assert(microphone.begin(input('mic-off')))
 assert(stored('runtime/microphone-command.json').input.followUpQuestions==false)
 enabled=true;assert(microphone.finish())
 assert(stored('runtime/microphone-command.json').input.followUpQuestions==false)
 microphone.cancel()
 group.start('on',{{entity='1ULL',profileKey='judy-alvarez',name='Judy'}},'Hello')
 enabled=false;local next=group.next(1,now,{['1ULL']=true})
 assert(runtime.send(next)and stored('runtime/last-input.json').followUpQuestions==true)
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
 hooks.OnGameAttached();allowNative=true;events.onUpdate(0)
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
 now=now+6
 assert(runtime.capture(input('expired')).worldKnowledge.status=='unavailable')
`));

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
 now=now+1;factValue=3;runtime.step(0)
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

test('microphone begin and finish capture fresh facts without changing request ownership', () => run(`
 start();local live=stored('runtime/world-session.json');local context=input('mic')
 assert(microphone.begin(context))
 local initial=stored('runtime/microphone-command.json')
 assert(initial.action=='start'and initial.input.worldKnowledge.facts.observed_fact.value==1)
 factValue=4;journalVersion=2;now=now+1;runtime.step(0)
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
