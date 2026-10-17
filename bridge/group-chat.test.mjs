import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {groupContext, parseGroup, conversationScope} from './group-context.mjs';
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/group-chat.lua', import.meta.url), 'utf8');
const adapterSource = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
const adapter = adapterSource.slice(adapterSource.indexOf('local function groupAudience(player)'),
  adapterSource.indexOf('local function captureDiagnostic()'));
function check(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const setup = `local group = (function() ${source} end)()
    local function p(key,id) return {profileKey=key, entity=id..'ULL', name=key, bodyType='test', npc=id} end
    local judy, panam, alex = p('judy',1), p('panam',2), p('alex',3)
    local live = {['1ULL']=true,['2ULL']=true,['3ULL']=true}`;
  const result = lauxlib.luaL_dostring(state, to_luastring(setup + '\n' + body));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}
test('addressed speaker first, duplicate copies count once, maximum three supported identities', () => check(`
  local chosen = group.choose(alex,{judy,p('judy',4),panam,p('unknown',5)},{judy=true,panam=true,alex=true})
  assert(#chosen==3 and chosen[1]==alex and chosen[2]==judy and chosen[3]==panam)
`));
test('live group audience retains exact actor and profile ownership across reassignment', () => {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const code = `local groupChat = (function() ${source} end)()
    local profiles={['1ULL']='judy',['2ULL']='panam',['3ULL']='alex'}
    local enabled={judy=true,panam=true,alex=true}
    local function npc(id)
      return {id=id, attached=true, IsAttached=function(self)return self.attached end,
        IsDeadNoStatPool=function()return false end,
        GetEntityID=function(self)return {hash=self.id} end,
        GetWorldPosition=function()return {x=0,y=0,z=0} end}
    end
    local judy,panam,alex=npc('1ULL'),npc('2ULL'),npc('3ULL')
    local function person(actor,key)return {npc=actor,entity=actor.id,profileKey=key,name=key}end
    local player={GetWorldPosition=function()return {x=0,y=0,z=0}end}
    local function profileIdentity(actor)return profiles[actor.id] end
    local function profileEnabled(_,key)return enabled[key]==true end
    local stopped,cleared,sent=0,0,{}
    local speech={state='idle',requestId=nil}
    function speech.stop()stopped=stopped+1;speech.requestId=nil end
    local subtitles={ownsUtterance=function()return false end,
      clearEntity=function()cleared=cleared+1 end}
    local microphone={cancellations=0}
    function microphone.cancel()microphone.cancellations=microphone.cancellations+1;microphone.context=nil end
    local pending,pendingKnowledgeOwner,generation,focusUntil,focusMode,focusEntity=nil,nil,0
    local function cancelVoice()error('text round used microphone cancellation')end
    local function gameplayCanAcquire()return true end
    local function sendRequest(input)sent[#sent+1]=input;pending=input;return true end
    local function beginFocus()return true end
    local function log()end
    ${adapter}
    -- Unchanged ownership admits the addressed copy and prepares the next.
    groupChat.start('normal',{person(judy,'judy'),person(panam,'panam')},'Hi')
    updateGroup(player);assert(#sent==1 and sent[1].profileKey=='judy')
    groupChat.received(sent[1].requestId,'Hi V',false,{'judy','panam'})
    pending=nil;speech.requestId=sent[1].requestId
    updateGroup(player);assert(groupChat.round and groupChat.round.prepared.profileKey=='panam')
    groupChat.cancel();speech.requestId=nil
    -- A disabled or dismissed current copy cancels its pending request without
    -- stopping another request that now owns speech.
    groupChat.start('disabled',{person(judy,'judy'),person(panam,'panam')},'Hi')
    updateGroup(player);local request=sent[#sent]
    speech.requestId='private-request';subtitles.entity='1ULL';enabled.judy=false;updateGroup(player)
    assert(groupChat.round==nil and pending==nil and stopped==0 and cleared==0
      and speech.requestId=='private-request')
    enabled.judy=true;speech.requestId=nil
    groupChat.start('dismissed',{person(judy,'judy'),person(panam,'panam')},'Hi')
    updateGroup(player);profiles['1ULL']=nil;updateGroup(player)
    assert(groupChat.round==nil and pending==nil and stopped==0)
    profiles['1ULL']='judy'
    -- The microphone lease is cancelled without touching an unrelated speaker.
    local voice=groupChat.startVoice('voice',{person(judy,'judy'),person(panam,'panam')},1,100)
    microphone.context=voice;speech.requestId='private-request'
    profiles['1ULL']='alex';updateGroup(player)
    assert(groupChat.round==nil and microphone.cancellations==1 and speech.requestId=='private-request')
    profiles['1ULL']='judy';speech.requestId=nil
    -- A reassigned current speaker must retire only this round's owned turn.
    groupChat.start('changed',{person(judy,'judy'),person(panam,'panam')},'Hi')
    updateGroup(player);request=sent[#sent]
    groupChat.received(request.requestId,'Old profile',false,{'judy','panam'})
    pending=nil;speech.requestId=request.requestId;subtitles.entity='1ULL'
    profiles['1ULL']='alex';updateGroup(player)
    assert(groupChat.round==nil and stopped==1 and cleared==1 and speech.requestId==nil)
    profiles['1ULL']='judy'
    -- A later reassigned copy is removed from listeners and never speaks.
    groupChat.start('later',{person(judy,'judy'),person(panam,'panam'),person(alex,'alex')},'Hi')
    updateGroup(player);request=sent[#sent]
    groupChat.received(request.requestId,'First',false,{'judy','panam','alex'})
    pending=nil;speech.requestId=request.requestId
    profiles['2ULL']='judy';updateGroup(player)
    assert(groupChat.round and groupChat.round.prepared.profileKey=='alex')
    assert(#groupChat.round.prepared.group.audience==2)
    speech.requestId=nil;updateGroup(player)
    assert(sent[#sent].profileKey=='alex' and sent[#sent].group.index==3)
    assert(groupChat.round.heard[1].listeners[1]=='judy' and groupChat.round.heard[1].listeners[2]=='alex')
    profiles['2ULL']='panam';pending=nil
    local function secondaryVoice(id)
      local first=groupChat.startVoice(id,{person(judy,'judy'),person(panam,'panam')},10,100)
      assert(groupChat.voiceSubmitted(first))
      assert(groupChat.received(first.requestId,'First',false,{'judy','panam'},nil,'Hello'))
      assert(groupChat.completed(first.requestId,true))
      local second=groupChat.next(11,101,{['1ULL']=true,['2ULL']=true})
      assert(second.profileKey=='panam' and groupChat.received(second.requestId,'Second',false,{'judy','panam'}))
      return second
    end
    -- Losing the primary during secondary playback clears the secondary's
    -- owned caption; a foreign speech owner remains untouched.
    local secondary=secondaryVoice('secondary-owned')
    speech.requestId=secondary.requestId;subtitles.entity='2ULL'
    profiles['1ULL']=nil;updateGroup(player)
    assert(groupChat.round==nil and stopped==2 and cleared==2 and speech.requestId==nil)
    profiles['1ULL']='judy'
    secondary=secondaryVoice('secondary-foreign')
    speech.requestId='private-request';subtitles.entity='2ULL'
    profiles['1ULL']=nil;updateGroup(player)
    assert(groupChat.round==nil and stopped==2 and cleared==2 and speech.requestId=='private-request')`;
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
});
test('an unconfigured addressed companion is never replaced by a different speaker', () => check(`
  local chosen, reason = group.choose(p('8ug8ear',4),{alex},{alex=true})
  assert(#chosen==0 and reason=='unsupported-primary')
  local nearby = group.choose(nil,{alex},{alex=true})
  assert(#nearby==1 and nearby[1]==alex)
`));

test('a departed last speaker transfers final-speaker ownership and no turn carries the retired follow-up field', () => check(`
  group.start('off',{judy,panam,alex},'Hello')
  local first=group.next(1,100,live)
  assert(first.followUpQuestions==nil)
  group.received(first.requestId,'Hello V',false,{'judy','panam','alex'})
  local prepared=group.preview(2,101,live)
  assert(prepared.followUpQuestions==nil and prepared.group.index~=prepared.group.total)
  live['3ULL']=nil
  local last=group.preview(3,102,live)
  assert(last.requestId~=prepared.requestId and last.group.index==last.group.total)
  assert(last.followUpQuestions==nil)
  group.completed(first.requestId,true)
  assert(group.next(4,103,live).requestId==last.requestId)
  group.received(last.requestId,'See you',false,{'judy','panam'})
  group.completed(last.requestId,true)
  assert(group.next(5,104,live)==nil)
  group.start('on',{judy,panam},'Another message')
  assert(group.next(6,105,live).followUpQuestions==nil)
  group.cancel();assert(group.next(7,106,live)==nil)
`));
test('next speaker cannot start before playback completes; duplicate completions are harmless', () => check(`
  group.start('round',{judy,panam,alex},'Hello friends')
  local first = group.next(1,100,live)
  assert(first.profileKey=='judy' and first.group.index==1)
  assert(group.next(2,100,live)==nil)
  assert(group.received(first.requestId,'Hello V',false,{'judy','panam'}))
  assert(group.next(2,100,live)==nil)
  assert(not group.completed('stale',true))
  assert(group.completed(first.requestId,true))
  assert(not group.completed(first.requestId,true))
  local second = group.next(2,101,live)
  assert(second.profileKey=='panam' and #second.group.heard==1)
  group.received(second.requestId,'Hey',false,{'judy','panam'})
  group.completed(second.requestId,true)
  local third = group.next(3,102,live)
  assert(third.profileKey=='alex' and #third.group.heard==0)
`));
test('departed speakers are skipped, cancelled rounds and failed replies cannot advance stale work', () => check(`
  group.start('round',{judy,panam,alex},'Hello')
  live['1ULL']=nil
  local second = group.next(2,101,live)
  assert(second.profileKey=='panam')
  group.received(second.requestId,'unheard',true,{})
  local third = group.next(3,102,live)
  assert(#third.group.heard==0 and third.group.index==third.group.total)
  group.cancel()
  assert(not group.received(third.requestId,'late',false,{}))
  assert(group.next(4,103,live)==nil)
`));
test('preparing the next reply reserves its identity but never advances playback', () => check(`
  local published
  group.onPreparation=function(value) published=value end
  group.start('round',{judy,panam,alex},'Hello friends')
  local first=group.next(1,100,live)
  group.received(first.requestId,'Hello V',false,{'judy','panam','alex'})
  local prepared=group.preview(2,101,live)
  assert(published.sourceRequestId==first.requestId)
  assert(prepared.profileKey=='panam' and prepared.group.heard[1].text=='Hello V')
  assert(group.round.stage=='playing' and group.next(3,101,live)==nil)
  assert(group.preview(3,102,live)==prepared)
  group.completed(first.requestId,true)
  local actual=group.next(3,105,live)
  assert(actual.requestId==prepared.requestId and actual.generation==2 and actual.sentAt==105)
`));
test('a changed audience rebuilds preparation, cancellation and failed playback invalidate it', () => check(`
  local published
  group.onPreparation=function(value) published=value end
  group.start('round',{judy,panam,alex},'Hello')
  local first=group.next(1,100,live)
  group.received(first.requestId,'Hello V',false,{'judy','panam','alex'})
  local old=group.preview(2,101,live)
  live['3ULL']=nil
  local fresh=group.preview(3,102,live)
  assert(fresh.requestId~=old.requestId and #fresh.group.audience==2)
  assert(group.preview(4,103,live,true)==nil and published==nil)
  assert(group.round.stage=='playing')
  group.completed(first.requestId,false)
  assert(published==nil)
  local actual=group.next(4,105,live)
  assert(actual.requestId~=fresh.requestId and #actual.group.heard==0)
  group.cancel(); assert(published==nil)
`));
test('a listener who missed part of a line never receives it as completed heard context', () => check(`
  group.start('round',{judy,panam,alex},'Hello')
  local first=group.next(1,100,live)
  group.received(first.requestId,'Hello V',false,{'judy','panam','alex'})
  local old=group.preview(2,101,live)
  group.round.reply.listeners={'judy','alex'}
  local fresh=group.preview(3,102,live)
  assert(#fresh.group.heard==0 and fresh.requestId~=old.requestId)
  group.completed(first.requestId,true)
  assert(#group.next(4,103,live).group.heard==0)
`));

test('dynamic group playback waits for final text before prefetch and stores the full completed utterance', () => check(`
  local published, observed
  group.onPreparation=function(value)published=value end
  group.captureReply=function(id,generation,entity)
    assert(id==observed.requestId and generation==observed.generation and entity==observed.entity)
    return observed
  end
  group.start('round',{judy,panam},'Hello friends');local first=group.next(1,100,live)
  observed={requestId=first.requestId,generation=first.generation,entity=first.entity,streamVersion=2,
    streamId='live-1',text='Early words',textComplete=false,finished=false,failed=false,delivered=false}
  group.received(first.requestId,'Early words',false,{'judy','panam'},{version=2,id='live-1'})
  assert(not group.preview(2,101,live)and not published)
  assert(not group.completed(first.requestId,true)and group.round.stage=='playing')
  observed.text='The full reply includes words that arrived after playback started.';observed.textComplete=true
  local prepared=group.preview(2,102,live)
  assert(prepared.group.heard[1].text==observed.text and group.round.stage=='playing')
  observed.finished=true;observed.delivered=true
  assert(group.completed(first.requestId,true))
  assert(group.round.heard[1].text==observed.text)
  local actual=group.next(3,104,live)
  assert(actual.requestId==prepared.requestId and actual.group.heard[1].text==observed.text)
`));

test('wrong stream owners and partial or cancelled native playback never become heard group context', () => check(`
  local observed
  group.captureReply=function()return observed end
  group.start('round',{judy,panam},'Hello');local first=group.next(1,100,live)
  group.received(first.requestId,'Prefix',false,{'judy','panam'},{version=2,id='live-1'})
  observed={requestId=first.requestId,generation=first.generation,entity=panam.entity,streamVersion=2,
    streamId='live-1',text='Wrong copy',textComplete=true,finished=true,failed=false,delivered=true}
  assert(not group.preview(2,101,live))
  observed.entity=first.entity;observed.generation=2;assert(not group.preview(2,101,live))
  observed.generation=first.generation;observed.streamId='foreign';assert(not group.preview(2,101,live))
  observed.streamId='live-1';observed.text='Full generated text';observed.finished=false;observed.delivered=false
  assert(group.preview(2,102,live))
  observed.failed=true;observed.finished=true
  assert(not group.preview(3,103,live)and not group.round.prepared)
  assert(group.completed(first.requestId,true))
  assert(#group.next(4,104,live).group.heard==0)
  group.start('round-2',{judy,panam},'Hello');first=group.next(5,105,live)
  group.captureReply=nil
  group.received(first.requestId,'Prefix',false,{'judy','panam'},{version=2,id='missing-final'})
  assert(not group.preview(6,106,live))
  group.completed(first.requestId,true);assert(#group.next(6,107,live).group.heard==0)
`));
test('validate group metadata and isolate private and group session scopes', () => {
  const group = {id: 'round-1', index: 1, total: 3, audience: ['judy', 'panam'], heard: []};
  assert.ok(parseGroup(group));
  assert.equal(parseGroup({...group, total: 4}), null);
  assert.equal(parseGroup({...group, heard: Array(3).fill({speaker:'x',text:'y'})}), null);
  assert.notEqual(conversationScope({}), conversationScope({group}));
  assert.equal(conversationScope({group}), conversationScope({group:{...group,audience:['panam','judy']}}));
  assert.match(groupContext({group}), /Do not ask V a question/);
  assert.match(groupContext({group:{...group,index:3}}), /final speaker/);
});

test('voice round freezes its audience, owns the first microphone reply and forwards only recognized V text', () => check(`
  group.captureJournal=function()return {serial=1}end
  group.captureBattle=function()return {serial=1}end
  local participants={alex,judy,panam}
  local first=group.startVoice('voice-round',participants,9,100)
  assert(first.profileKey=='alex'and first.group.index==1 and first.group.total==3)
  assert(first.text=='[Microphone]'and first.followUpQuestions==nil)
  assert(group.round.stage=='recording'and group.next(10,101,live)==nil)
  assert(not group.received(first.requestId,'too early',false,{},nil,'Hello'))
  participants[1]=judy;alex.profileKey='changed'
  assert(group.round.participants[1].profileKey=='alex')
  assert(not group.voiceSubmitted({requestId='wrong'}))
  first.journal={serial=2};first.battle={serial=3}
  assert(group.voiceSubmitted(first)and group.round.stage=='waiting')
  assert(not group.voiceSubmitted(first)and group.next(10,101,live)==nil)
  assert(group.received(first.requestId,'Hi V',false,{'alex','judy','panam'},nil,'How was your night?'))
  local prepared=group.preview(10,102,live)
  assert(prepared.profileKey=='judy'and prepared.text=='How was your night?')
  assert(prepared.journal.serial==2 and prepared.battle.serial==3 and prepared.followUpQuestions==nil)
  assert(prepared.group.heard[1].text=='Hi V'and group.round.stage=='playing')
  assert(not group.received(first.requestId,'duplicate',false,{},nil,'Wrong text'))
  group.completed(first.requestId,true)
  assert(group.next(11,104,live).requestId==prepared.requestId)
`));

test('missing, malformed and oversized first microphone transcripts cancel the remainder without synthetic prompts', () => check(`
  local values={false,'','  ','[Microphone]',string.rep('a',1201),string.char(192,175),
    string.rep(string.char(240,159,152,128),601),string.char(237,160,128),'bad'..string.char(0)}
  for _,value in ipairs(values)do
    local first=group.startVoice('voice-round',{judy,panam},1,100)
    group.voiceSubmitted(first)
    assert(group.received(first.requestId,'First reply',false,{'judy','panam'},nil,value))
    assert(group.round==nil and group.next(2,101,live)==nil and group.preview(2,101,live)==nil)
  end
  local first=group.startVoice('error',{judy,panam},1,100)
  group.voiceSubmitted(first);group.received(first.requestId,'',true,{},nil,'Recognized but failed')
  assert(group.round==nil)
  first=group.startVoice('cancelled',{judy,panam},2,101)
  group.cancel();assert(not group.voiceSubmitted(first))
  assert(not group.received(first.requestId,'late',false,{},nil,'Late text'))
`));

test('recognized speech accepts the exact UTF-16 limit and a streamed first reply waits for final assistant text', () => check(`
  local text=string.rep(string.char(240,159,152,128),600)
  local first=group.startVoice('unicode',{judy,panam},1,100);group.voiceSubmitted(first)
  local observed={requestId=first.requestId,generation=first.generation,entity=first.entity,streamVersion=2,
    streamId='voice-stream',text='First phrase',textComplete=false,finished=false,failed=false,delivered=false}
  group.captureReply=function()return observed end
  group.received(first.requestId,'First phrase',false,{'judy','panam'},{version=2,id='voice-stream'},text)
  assert(group.round.text==text and not group.preview(2,101,live))
  observed.text='The whole first reply';observed.textComplete=true
  assert(group.preview(2,102,live).text==text)
  group.cancel();assert(not group.completed(first.requestId,true))
`));

test('roleOf tells the body gestures who is listening: members only, the speaker named while a reply is written or heard', () => check(`
  assert(group.roleOf('1ULL')==nil,'no round')
  group.start('text',{judy,panam,alex},'Hi')
  assert(group.roleOf('1ULL')=='between' and group.roleOf('2ULL')=='between','before the first speaker')
  assert(group.roleOf('9ULL')==nil and group.roleOf(nil)==nil,'not a member')
  local first=group.next(1,100,live)
  local role,speaker=group.roleOf('2ULL')
  assert(role=='reply' and speaker=='1ULL','waiting for the first reply: '..tostring(role)..' '..tostring(speaker))
  role,speaker=group.roleOf('1ULL');assert(role=='reply' and speaker=='1ULL')
  assert(group.received(first.requestId,'Hello there',false,{'judy','panam','alex'}))
  role,speaker=group.roleOf('3ULL');assert(role=='reply' and speaker=='1ULL','playing')
  assert(group.completed(first.requestId,true))
  assert(group.roleOf('3ULL')=='between','between speakers')
  local second=group.next(1,101,live)
  role,speaker=group.roleOf('3ULL');assert(role=='reply' and speaker=='2ULL','second speaker')
  group.cancel()
  assert(group.roleOf('1ULL')==nil,'round over')
`));

test('roleOf: recording for every member while V speaks the group utterance; an add-on voice is never a member', () => check(`
  local addon={profileKey='addon',entity='7ULL',name='addon',voiceOnly=true}
  local input=group.startVoice('voice',{judy,panam,addon},1,100)
  assert(group.roleOf('1ULL')=='recording' and group.roleOf('2ULL')=='recording')
  assert(group.roleOf('7ULL')==nil,'add-on voices have no body')
  assert(group.voiceSubmitted(input))
  local role,speaker=group.roleOf('2ULL')
  assert(role=='reply' and speaker=='1ULL','after the microphone, the first speaker is waited for')
`));

// Phase 2 of characters spawned by another mod or a spawner (docs/SPAWNED_CHARACTERS.md): they join as speakers, never as party.
test('spawned characters follow the companions, one body is never two speakers, one profile is one voice', () => check(`
  local function spawned(key,id) local row=p(key,id); row.spawned=true; return row end
  local supported={judy=true,panam=true,alex=true}
  -- Companions fill the round first; a spawned character takes the free place after them.
  local sp=spawned('alex',5)
  local chosen=group.choose(judy,{panam,sp},supported)
  assert(#chosen==3 and chosen[1]==judy and chosen[2]==panam and chosen[3]==sp and chosen[3].spawned==true)
  -- The addressed spawned character comes first, and our own copy of its profile is the one that is skipped later.
  local spJudy=spawned('judy',6)
  chosen=group.choose(spJudy,{judy,panam},supported)
  assert(#chosen==2 and chosen[1]==spJudy and chosen[2]==panam,'one Judy: the addressed body')
  chosen=group.choose(judy,{spJudy,panam},supported)
  assert(#chosen==2 and chosen[1]==judy and chosen[2]==panam,'our copy keeps its place; the spawned copy of the same profile is skipped')
  -- The same body reached twice (the crosshair target is also in the scan) is one speaker.
  local again=spawned('alex',5)
  chosen=group.choose(sp,{again,panam},supported)
  assert(#chosen==2 and chosen[1]==sp and chosen[2]==panam)
  -- A spawned character the manager does not support never joins; the cap of three still holds.
  chosen=group.choose(judy,{spawned('ghost',7),panam,spawned('alex',8),spawned('nobody',9)},supported)
  assert(#chosen==3 and chosen[2]==panam and chosen[3].entity=='8ULL')
  -- Nobody but the spawned characters: a round of two spawned characters is a round.
  chosen=group.choose(nil,{spawned('judy',10),spawned('panam',11)},supported)
  assert(#chosen==2)
`));

test('a round keeps the spawned flag on its frozen rows and tells the adapter only when one is in it', () => check(`
  local told={}
  group.onSpawned=function(round) told[#told+1]=round.id end
  local sp=p('alex',3); sp.spawned=true
  group.start('with',{judy,sp},'Hello')
  assert(#told==1 and told[1]=='with')
  assert(group.round.participants[2].spawned==true and group.round.participants[1].spawned==nil)
  group.start('without',{judy,panam},'Hello')
  assert(#told==1,'a round of our own companions never calls it')
  group.onSpawned=function() error('adapter failure') end
  group.start('broken',{judy,sp},'Hello')
  assert(group.round and group.round.id=='broken','a failing hook never breaks the round')
  group.onSpawned=nil
  local input=group.startVoice('voice',{judy,sp},1,100)
  assert(input and group.round.participants[2].spawned==true)
`));

test('a round with a spawned character runs through the same adapter: face request, eye contact, one audience, shared heard lines', () => {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const code = `local groupChat = (function() ${source} end)()
    local profiles={['4ULL']='judy',['2ULL']='panam'}
    local faces={}
    local function npc(id)
      return {id=id, IsAttached=function()return true end, IsDeadNoStatPool=function()return false end,
        GetEntityID=function(self)return {hash=self.id} end, GetWorldPosition=function()return {x=0,y=0,z=0} end,
        ConvaiFaceRequest=function(self) faces[#faces+1]=self.id; return 'prepared:crowd' end}
    end
    local spawnedJudy,panam=npc('4ULL'),npc('2ULL')
    local function person(actor,key,spawned)return {npc=actor,entity=actor.id,profileKey=key,name=key,spawned=spawned}end
    local player={GetWorldPosition=function()return {x=0,y=0,z=0}end}
    local function profileIdentity(actor)return profiles[actor.id] end
    local function profileEnabled()return true end
    local speech={state='idle',requestId=nil}
    function speech.stop()speech.requestId=nil end
    local subtitles={ownsUtterance=function()return false end,clearEntity=function()end}
    local microphone={}
    function microphone.cancel()end
    local pending,pendingKnowledgeOwner,generation,focusUntil,focusMode,focusEntity=nil,nil,0
    local function cancelVoice()end
    local function gameplayCanAcquire()return true end
    local sent,focused={},{}
    local function sendRequest(input)sent[#sent+1]=input;pending=input;return true end
    local function beginFocus(_,actor)focused[#focused+1]=actor.id;return true end
    local function log()end
    ${adapter}
    groupChat.start('mixed',{person(spawnedJudy,'judy',true),person(panam,'panam')},'Hi both')
    updateGroup(player)
    assert(#sent==1 and sent[1].profileKey=='judy' and sent[1].entity=='4ULL')
    assert(faces[1]=='4ULL' and focused[1]=='4ULL','the spawned speaker gets the face request and the eye contact')
    assert(speech.target==spawnedJudy)
    local audience=sent[1].group.audience
    assert(#audience==2 and audience[1]=='judy' and audience[2]=='panam','one audience, by profile')
    groupChat.received(sent[1].requestId,'Hi V',false,{'judy','panam'})
    pending=nil;speech.requestId=sent[1].requestId
    updateGroup(player)
    assert(groupChat.round.prepared and groupChat.round.prepared.profileKey=='panam')
    speech.requestId=nil;updateGroup(player)
    updateGroup(player)
    assert(#sent==2 and sent[2].profileKey=='panam' and sent[2].group.index==2)
    assert(#sent[2].group.heard==1 and sent[2].group.heard[1].text=='Hi V','the companion hears the spawned character')
    assert(groupChat.roleOf('4ULL')=='reply','a spawned member is a round member like any other')
    -- The spawned character leaving mid-round retires only this round, like any speaker.
    groupChat.cancel()
    groupChat.start('lost',{person(spawnedJudy,'judy',true),person(panam,'panam')},'Hi')
    updateGroup(player)
    profiles['4ULL']=nil
    updateGroup(player)
    assert(groupChat.round==nil,'a spawned speaker that stops resolving to its profile ends the round')
  `;
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
});

// The look-ahead needs the game to publish the next speaker's turn while the current one is heard (runtime/group-prefetch.json). A
// round with a character another mod or a spawner created in it publishes the same predictions as a round of our own companions,
// whether the spawned character speaks first, second or last, and the prepared turn is the one later submitted.
test('a spawned speaker, before or after our companion, gets the same prediction and the same prepared turn', () => check(`
  local published, count = nil, 0
  group.onPreparation=function(value) published=value; count=count+1 end
  local sp=p('alex',5); sp.spawned=true
  -- Our companions first, the spawned character last (the order choose() gives).
  group.start('after',{judy,panam,sp},'Hello friends')
  live['5ULL']=true
  local first=group.next(1,100,live)
  group.received(first.requestId,'Hello V',false,{'judy','panam','alex'})
  local prepared=group.preview(2,101,live)
  assert(published and published.sourceRequestId==first.requestId and prepared.profileKey=='panam')
  group.completed(first.requestId,true)
  local second=group.next(3,102,live)
  assert(second.requestId==prepared.requestId,'the prepared turn of the companion is the submitted one')
  group.received(second.requestId,'Hey',false,{'judy','panam','alex'})
  local afterSecond=group.preview(4,103,live)
  assert(afterSecond.profileKey=='alex' and afterSecond.entity=='5ULL' and afterSecond.group.heard[#afterSecond.group.heard].text=='Hey',
    'the prediction for the spawned character is published while the companion is heard')
  assert(published.input==afterSecond and published.sourceRequestId==second.requestId)
  group.completed(second.requestId,true)
  local third=group.next(5,104,live)
  assert(third.requestId==afterSecond.requestId and third.generation==afterSecond.generation and third.entity=='5ULL')
  -- The spawned character first (it was the addressed one): our companion is predicted while it is heard.
  published=nil
  group.start('before',{sp,judy,panam},'Hello friends')
  local lead=group.next(6,200,live)
  assert(lead.entity=='5ULL' and lead.group.index==1)
  group.received(lead.requestId,'Hi V',false,{'alex','judy','panam'})
  local ahead=group.preview(7,201,live)
  assert(published and published.sourceRequestId==lead.requestId and ahead.profileKey=='judy' and ahead.group.heard[1].speaker=='alex')
  group.completed(lead.requestId,true)
  assert(group.next(8,202,live).requestId==ahead.requestId)
`));
