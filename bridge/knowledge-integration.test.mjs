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
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

const fixture = `
local function copy(value)
 if type(value)~='table'then return value end
 local result={};for key,item in pairs(value)do result[key]=copy(item)end;return result
end
local files,encoded,serial,events,hooks,hotkeys={},{},0,{},{},{}
local allowNative,attached,dead,preGame,paused=false,true,false,false,false
local nativeCalls,versionReads,factReads,historyReads,stateUpdates=0,0,0,0,0
local now,gameVersion,factValue,journalVersion=1000,'2.31',1,1
local nativeMissing,afterSnapshot,failPath=false,nil,nil
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
os.rename=function(from,to)if not files[from]then return nil end;files[to],files[from]=files[from],nil;return true end
local function stored(path)return files[path]and json.decode(files[path])end
local function put(path,value)files[path]=json.encode(value)end
local profiles={{key='judy-alvarez',name='Judy',records={}}, {key='alex',name='Alex',records={}},
 {key='resident-male',name='Resident',records={}}}
put('conversation-characters.json',profiles)
put('world-knowledge.json',{version=1,gameVersions={'2.31'},factAllowlist={observed_fact={evidenceRefs={'reviewed-proof'}}},journalAllowlist={}})
local function frame(generation,branch)
 local activation=string.rep('a',32);branch=branch or string.rep('b',32)
 return {version=1,status='ready',generation=generation,worldToken=generation..':'..activation..':'..branch,
 identity={version=1,status='available',authoritative=true,confidence='native-live',generation=generation,
 activationId=activation,campaignId=string.rep('c',32),branchId=branch,branchEpoch=1,ledgerSequence=0,
 userId='10000000-1000-4000-8000-100000000001',localUserId='10000000-1000-4000-8000-100000000001',
 checkpointId='checkpoint-one'},inspection={generation=generation}}
end
local nativeFrame=frame(7)
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
local state={inspect=function()return nativeMissing and {status='unavailable'}or copy(nativeFrame.inspection)end,
 snapshot=function()
  local value=nativeMissing and {version=1,status='unavailable',reason='native-missing'}or copy(nativeFrame)
  if afterSnapshot then afterSnapshot()end
  return value
 end,update=function()stateUpdates=stateUpdates+1 end,
 invalidate=function(reason)record('knowledge:'..reason)end}
local modules={
 ['knowledge-state.lua']={new=function(options)return state end},
 ['world-knowledge.lua']={new=function(options)
  worldOptions=options
  options.now=function()return now end;options.cpuNow=function()return 0 end
  options.utcNow=function()return '2026-09-30T12:00:00Z'end
  options.adapter={isReady=function()return attached and not dead end,
   readFact=function()factReads=factReads+1;return factValue end,readJournal=function()return nil end,
   readLifepath=function()return 'nomad'end}
  return (function()${worldSource}end)().new(options)
 end},
 ['journal-history.lua']={new=function(options)
  historyOptions=options;options.now=function()return now end
  options.adapter={isReady=function()return attached and not dead end,
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
  dismissAll=noop,conversationCandidates=function()return{}end,registerPhoneContacts=noop,update=noop},
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
 assert(nativeCalls==0 and factReads==0 and historyReads==0 and stateUpdates==0)
 events.onInit();assert(nativeCalls==0 and versionReads==0)
 attached=false;allowNative=true;events.onUpdate(0)
 assert(factReads==0 and historyReads==0 and versionReads==0)
 assert(stored('runtime/world-session.json').ready==false)
 attached=true;events.onUpdate(0)
 assert(versionReads==1 and factReads==1 and historyReads==1)
 assert(worldOptions.currentGeneration()==7 and historyOptions.currentGeneration()==7)
 assert(worldOptions.currentWorldToken()==nativeFrame.worldToken)
`));

test('private sends use fresh native world generation and audience, preserving battle and loot payloads', () => run(`
 start();local first=input('first')
 first.battle={version=1,status='ended'};first.loot={batch='loot-kept'};first.reaction={kind='loot'}
 assert(runtime.send(first));local out=stored('runtime/last-input.json')
 assert(out.generation==999 and out.worldKnowledge.generation==7)
 assert(out.worldKnowledge.worldToken==nativeFrame.worldToken and out.worldKnowledge.identity.status=='verified')
 assert(out.worldKnowledge.audience.channel=='private'and #out.worldKnowledge.audience.profileKeys==1)
 assert(out.worldKnowledge.audience.profileKeys[1]=='judy-alvarez' and out.worldKnowledge.facts.observed_fact.value==1)
 assert(out.journalHistory.generation==7 and out.journalHistory.worldToken==nativeFrame.worldToken)
 assert(out.battle.status=='ended'and out.loot.batch=='loot-kept'and out.reaction.kind=='loot')
 factValue=2;now=now+1;runtime.step(0);out.worldKnowledge.facts.observed_fact.value=999
 assert(runtime.send(input('second')))
 assert(stored('runtime/last-input.json').worldKnowledge.facts.observed_fact.value==2)
 assert(versionReads==1,'pack was repeatedly configured')
`));

test('anonymous fallback supports current facts and rotates only transient scope on explicit load', () => run(`
 nativeMissing=true;start();assert(runtime.send(input('anonymous')))
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
 assert(stored('runtime/last-input.json').worldKnowledge.identity.status=='unknown')
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
 assert(preview.worldKnowledge.audience.profileKeys[2]=='alex'and preview.worldKnowledge.identity.status=='verified')
 now=now+1;factValue=3;runtime.step(0)
 group.completed(first.requestId,true);local next=group.next(3,now,live)
 assert(next.requestId==prepared.requestId and runtime.send(next))
 assert(stored('runtime/last-input.json').worldKnowledge.facts.observed_fact.value==3)
 assert(stored('runtime/last-input.json').group.heard[1].text=='Hello V')
`));

test('a world change during capture prevents request publication', () => run(`
 start();assert(runtime.send(input('before')));local prior=files['runtime/last-input.json']
 afterSnapshot=function()nativeFrame=frame(8);afterSnapshot=nil end
 assert(runtime.send(input('racing'))==false)
 assert(files['runtime/last-input.json']==prior)
 assert(stored('runtime/world-session.json').token==nativeFrame.worldToken)
`));

test('private and microphone sends recheck world ownership after existing journal capture hooks', () => run(`
 start()
 modules['quest-context.lua'].capture=function()nativeFrame=frame(8);return {version=1,status='untracked'}end
 assert(runtime.send(input('journal-race'))==false and files['runtime/last-input.json']==nil)
 nativeFrame=frame(7);runtime.step(0)
 microphone.captureJournal=function()nativeFrame=frame(8);return {version=1,status='untracked'}end
 assert(microphone.begin(input('mic-journal-race'))==false and files['runtime/microphone-command.json']==nil)
 microphone.captureJournal=function()return {version=1,status='untracked'}end
 runtime.step(0);assert(microphone.begin(input('mic-finish-race')))
 microphone.captureBattle=function()nativeFrame=frame(9);return {version=1,status='none'}end
 assert(microphone.finish()==nil and stored('runtime/microphone-command.json').action=='cancel')
`));

test('detach and death invalidate identity before actor cleanup, and shutdown publishes unavailable', () => run(`
 start();assert(runtime.send(input('pending')))
 order={};allowNative=false;hooks.OnDeath()
 assert(order[1]=='knowledge:player died'and order[2]=='companions')
 assert(runtime.pending()==nil and not stored('runtime/world-session.json').ready)
 hooks.OnTakeControl();allowNative=true;events.onUpdate(0)
 order={};events.onShutdown()
 assert(order[1]=='knowledge:shutdown'and not stored('runtime/world-session.json').ready)
`));

test('a branch change cancels pending private, microphone and group work without dismissing actors', () => run(`
 start();assert(runtime.send(input('pending')))
 assert(microphone.begin(input('recording')))
 group.start('round',{{entity='1ULL',profileKey='judy-alvarez',name='Judy'}},'Hello')
 order={};nativeFrame=frame(7,string.rep('e',32));events.onUpdate(0)
 assert(runtime.pending()==nil and microphone.context==nil and group.round==nil)
 for _,value in ipairs(order)do assert(value~='companions','activation change removed actor ownership')end
 assert(stored('runtime/world-session.json').token==nativeFrame.worldToken)
`));

test('phone callbacks share one captured world and reject stale history after a branch change', () => run(`
 start();local binding=phoneOptions.captureBinding(player)
 assert(binding.generation==7 and binding.localUserId)
 local world=phoneOptions.captureWorldKnowledge(player,'alex',binding)
 local history=phoneOptions.captureJournalHistory(player,'alex',binding)
 assert(world.audience.channel=='phone'and #world.audience.profileKeys==1 and world.audience.profileKeys[1]=='alex')
 assert(history.generation==world.generation and history.worldToken==world.worldToken)
 phoneOptions.captureWorldKnowledge(player,'alex',binding);nativeFrame=frame(7,string.rep('d',32))
 assert(phoneOptions.captureJournalHistory(player,'alex',binding).status=='unavailable')
`));

test('phone delivery publication is bounded, deduplicated and retains the original request world', () => run(`
 start();local original=nativeFrame.worldToken;nativeFrame=frame(8)
 for i=1,20 do phoneOptions.onDelivered({version=1,id='delivery-'..i,sequence=i,requestId='request-'..i,
  source='phone-ui',state='accepted',partial=false,cancelled=false,completedAt=now*1000,
  profileKey='alex',contact='alex',world='phone-world',binding='original-phone-binding',generation=7,worldToken=original,
  text='not a receipt field',nativeHandle={bad=true}})end
 local value=stored('runtime/knowledge-phone-delivery.json')
 assert(#value.receipts==16 and value.receipts[1].id=='delivery-5')
 assert(value.receipts[16].generation==7 and value.receipts[16].worldToken==original)
 assert(value.receipts[1].text==nil and value.receipts[1].nativeHandle==nil)
 local before=files['runtime/knowledge-phone-delivery.json']
 phoneOptions.onDelivered(value.receipts[16]);phoneOptions.onDelivered({id='invalid',source='other'})
 assert(files['runtime/knowledge-phone-delivery.json']==before)
`));

test('microphone begin and finish capture fresh facts without changing request ownership', () => run(`
 start();local context=input('mic')
 assert(microphone.begin(context))
 local initial=stored('runtime/microphone-command.json')
 assert(initial.action=='start'and initial.input.worldKnowledge.facts.observed_fact.value==1)
 factValue=4;journalVersion=2;now=now+1;runtime.step(0)
 assert(microphone.finish()==context)
 local final=stored('runtime/microphone-command.json')
 assert(final.action=='finish'and final.input.worldKnowledge.facts.observed_fact.value==4)
 assert(final.input.requestId=='mic'and final.input.generation==999 and final.input.worldKnowledge.generation==7)
 assert(final.input.journal.serial==2 and final.input.battle.status=='none')
`));

test('microphone recording cancels on world change or failed finish write without submitting stale facts', () => run(`
 start();assert(microphone.begin(input('mic-stale')));nativeFrame=frame(8)
 assert(microphone.finish()==nil and microphone.context==nil)
 assert(stored('runtime/microphone-command.json').action=='cancel')
 runtime.step(0);assert(microphone.begin(input('mic-write')))
 failPath='runtime/microphone-command.json'
 assert(microphone.finish()==nil and microphone.context==nil and microphone.knowledgeOwner==nil)
 failPath=nil;assert(microphone.begin(input('mic-update')))
 nativeFrame=frame(9);microphone.update(player)
 assert(microphone.context==nil and stored('runtime/microphone-command.json').action=='cancel')
`));

test('brief same-world autosave preserves ownership and defers microphone finish until fresh capture is safe', () => run(`
 start();assert(microphone.begin(input('saving-mic')))
 local token=nativeFrame.worldToken;nativeFrame.status='paused';nativeFrame.reason='save-in-progress'
 order={};events.onUpdate(0)
 assert(stored('runtime/world-session.json').ready and stored('runtime/world-session.json').token==token)
 assert(runtime.send(input('save-blocked'))==false and #order==0)
 assert(microphone.finish()==nil and microphone.context and microphone.finishPending)
 assert(stored('runtime/microphone-command.json').action=='start')
 nativeFrame.status='ready';runtime.step(0)
 assert(microphone.update(player).requestId=='saving-mic')
 assert(stored('runtime/microphone-command.json').action=='finish'and not microphone.finishPending)
`));
