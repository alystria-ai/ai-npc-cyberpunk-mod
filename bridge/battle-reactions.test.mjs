import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {parseBattle, parseReaction, battleContext, battleTrigger, reactionLeaseValid} from './battle-context.mjs';
import {parseInput} from './protocol.mjs';
import {conversationContext} from './quest-context.mjs';
import {inputIdentity} from './group-prefetch.mjs';
import {PhoneChat, parsePhoneState} from './phone-chat.mjs';

const source = readFileSync(new URL('../mod/battle-reactions.lua', import.meta.url), 'utf8');
const observer = readFileSync(new URL('../mod/battle-observer.lua', import.meta.url), 'utf8');
const group = readFileSync(new URL('../mod/group-chat.lua', import.meta.url), 'utf8');
const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
const adapter = init.slice(init.indexOf('local function sendRequest(context)'), init.indexOf('local function groupAudience(player)'));
const focusExpiry = init.slice(init.indexOf('    if focusUntil and not active'), init.indexOf('    if focusedCrowd and not focusedCrowd.checked'));
function run(code) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const status = lauxlib.luaL_dostring(vm, to_luastring(code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(status, lua.LUA_OK, error);
}
const fixture = `
local policy=(function() ${source} end)().new()
local now=1000
local people={{entity='1ULL',profileKey='judy-alvarez',distance=2,available=true},
  {entity='2ULL',profileKey='judy-alvarez',distance=3,available=true},
  {entity='3ULL',profileKey='alex',distance=4,available=true}}
local sample={available=true,blocked=false,combat=false,opponents={}}
local function tick(dt,combat,enabled)
  now=now+dt; sample.combat=combat
  policy.update(sample,dt,now,enabled~=false,people)
end
local function offer(busy) return policy.offer(busy,people,now) end
tick(0,false)
`;

test('battle pair settles combat, chooses distinct identities and starts cooldown at the confirmed end', () => run(fixture + `
tick(.5,true); tick(1,true); assert(not offer(false))
tick(1,true); local first=assert(offer(false)); assert(first.phase=='start' and first.person.entity=='1ULL')
assert(first.expiresAt%1==0); assert(policy.claim(first)); assert(not offer(false))
tick(1,false); assert(not policy.valid(first,now)); tick(2,false)
assert(policy.capture().status=='fighting')
tick(.5,true); assert(policy.capture().status=='fighting' and not offer(false))
tick(1,false); tick(4,false); local ended=now
assert(policy.capture().status=='ended' and policy.status().cooldownUntil==ended+600)
assert(not offer(false)); tick(4,false)
local closing=assert(offer(false)); assert(closing.phase=='end' and closing.person.profileKey=='alex')
policy.claim(closing); assert(not offer(false))
tick(1,true); assert(not policy.valid(closing,now)); tick(3,true); assert(not offer(false))
tick(1,false); tick(4,false); assert(policy.status().cooldownUntil==ended+600)
now=ended+601; tick(1,true); tick(2,true); assert(offer(false))
`));

test('reload baseline, disabled options and save changes do not replay an existing battle', () => run(fixture + `
policy.reset(); tick(0,true); tick(3,true); assert(not offer(false))
tick(1,false); tick(4,false); tick(4,false); assert(not offer(false))
tick(1,true,false); tick(3,true,true); assert(not offer(false))
policy.reset(); tick(0,false); tick(1,true); tick(3,true)
local event=assert(offer(false)); policy.claim(event)
tick(0,true,false); assert(not policy.valid(event,now) and not offer(false))
policy.reset(); tick(0,false); assert(policy.capture().status=='none' and policy.status().cooldownUntil==0)
tick(1,true); tick(3,true); assert(offer(false))
`));

test('manual activity, native dialogue, absent witnesses and expired windows stay silent', () => run(fixture + `
tick(1,true); tick(3,true); assert(not offer(true))
sample.blocked=true; tick(0,true); assert(not offer(false))
sample.blocked=false; tick(0,true); local event=assert(offer(false)); assert(policy.valid(event,now))
people[1].available=false; people[2].available=false; people[3].available=false
assert(not offer(false)); people={{entity='4ULL',profileKey='panam-palmer',distance=3,available=true}}
assert(not offer(false),'A newly arrived companion cannot comment as an old witness')
people={}; tick(5,true); tick(5,true); assert(not offer(false) and not policy.valid(event,now))
tick(1,false); tick(4,false)
for _=1,9 do tick(5,false) end
assert(not offer(false))
`));

test('observations are bounded and detached from native entities; recent facts expire', () => run(fixture + `
tick(1,true)
for i=1,20 do sample.opponents={{entity=tostring(i),name='Hostile',kind='Human'}}; tick(.1,true) end
local data=policy.capture()
assert(#data.opponents==1 and data.opponents[1].count==12 and #data.witnesses==2)
data.opponents[1].name='MUTATED'; assert(policy.capture().opponents[1].name=='Hostile')
tick(1,false); tick(4,false)
for _=1,181 do tick(5,false) end
assert(policy.capture().status=='none')
sample.available=false; tick(1,false); assert(policy.capture().status=='unavailable' and not offer(false))
`));

test('paused simulation never advances reaction windows and group questions keep one battle snapshot', () => run(fixture + `
tick(1,true); now=now+100; tick(0,true); assert(not offer(false))
tick(2,true); assert(offer(false))
local g=(function() ${group} end)(); g.captureBattle=policy.capture
g.start('group',{{entity='1ULL',profileKey='judy-alvarez',name='Judy',bodyType='WomanAverage'},
  {entity='3ULL',profileKey='alex',name='Alex',bodyType='WomanAverage'}},'Who did we fight?')
local live={['1ULL']=true,['3ULL']=true}
local first=g.next(1,1000,live); assert(first.battle.status=='fighting')
tick(1,false); tick(4,false)
g.received(first.requestId,'A reply',false,{'judy-alvarez','alex'}); g.completed(first.requestId,true)
assert(g.next(2,1001,live).battle.status=='fighting')
`));

const adapterFixture = fixture + `
local battles=policy
local generation,automatic,battleSample,battlePeople,battlePoll=0,nil,nil,{},0
local active,pending,focusUntil=nil,nil,nil
local cancelled,stopped,cleared=0,0,0
local speech={stop=function()stopped=stopped+1 end}
local subtitles={clear=function()cleared=cleared+1 end}
local microphone,groupChat,phoneChat={},{},{}
local supportedProfiles={['judy-alvarez']=true,alex=true}
local settings=true
local voice,captions=true,true
local player={ConvaiManagerVoice=function()return voice end,ConvaiManagerSubtitles=function()return captions end}
local manager={profileEnabled=function()return true end,battleReactions=function()return settings end}
local companions={conversationCandidates=function()return people end}
local speakerReady,speakerBusy=true,false
local battleObserver={sample=function()return sample end,canSpeak=function()return speakerReady,speakerReady and 'available' or 'native-dialogue',speakerBusy end}
local questContext={capture=function()return {version=1,status='untracked'}end}
local function log()end
local encoded,files={},{}
json={encode=function(value)
 local key='json-'..(#encoded+1); encoded[#encoded+1]=value;return key
end}
io={open=function(path)return {write=function(_,data)files[path]=data end,close=function()end}end}
os.time=function()return math.floor(now)end
os.remove=function(path)files[path]=nil end
os.rename=function(from,to)files[to],files[from]=files[from],nil;return true end
local cancelAutomatic
${adapter}
local function lastCancellation()
 local index=tonumber(files['runtime/battle-cancellations.json']:match('%d+'))
 local rows=encoded[index].events;return rows[#rows],rows
end
`;

test('actual game adapter owns the auto request lease and cancels only its own pending speech', () => run(adapterFixture + `
sample.combat=false; updateBattles(player,.5,true)
sample.combat=true; for _=1,6 do now=now+.5;updateBattles(player,.5,true)end
assert(automatic and pending==automatic and pending.reaction.phase=='start')
local request=automatic.requestId
assert(speech.target==people[1].npc and focusUntil==nil,'Automatic speech must not seize attention')
local leaseIndex=tonumber(files['runtime/reaction-lease.json']:match('%d+'))
assert(encoded[leaseIndex].requestId==request and encoded[leaseIndex].valid)
-- A prior manual focus grace period must not cancel this automatic request.
focusUntil=now-1;local function endFocus()end
${focusExpiry}
assert(pending==automatic and focusUntil==nil)
-- Simulate a manual input taking ownership before the next frame.
pending={requestId='manual'};active={};speech.requestId=request
now=now+.5;updateBattles(player,.5,true)
assert(automatic==nil and pending.requestId=='manual' and stopped==1)
local evidence=lastCancellation()
assert(evidence.reason=='manual-priority' and evidence.manual and evidence.manualActivity.text)
assert(evidence.guard.worldReady and evidence.guard.speaker.present and evidence.guard.speaker.distance==2)
leaseIndex=tonumber(files['runtime/reaction-lease.json']:match('%d+'))
assert(not encoded[leaseIndex].valid)
active,pending,speech.requestId=nil,nil,nil
-- A later battle is a fresh event; a blocked scene cancels it before delivery.
policy.reset(); sample.combat=false;updateBattles(player,.5,true)
sample.combat=true;for _=1,6 do now=now+.5;updateBattles(player,.5,true)end
assert(automatic and pending)
sample.blocked=true;now=now+.5;updateBattles(player,.5,true)
assert(not automatic and not pending)
evidence=lastCancellation();assert(evidence.reason=='scene-blocked' and evidence.guard.native.blocked)
-- Muting both outputs suppresses generation but retains manual combat context.
policy.reset();sample.blocked=false;sample.combat=false;voice,captions=false,false
updateBattles(player,.5,true)
sample.combat=true;for _=1,6 do now=now+.5;updateBattles(player,.5,true)end
assert(not automatic and not pending and battles.capture().status=='fighting')
voice=true;now=now+.5;updateBattles(player,.5,true);assert(automatic and pending)
voice=false;now=now+.5;updateBattles(player,.5,true)
evidence=lastCancellation()
assert(not automatic and evidence.reason=='outputs-disabled' and not evidence.guard.outputs.voice and not evidence.guard.outputs.subtitles)
-- Record why a sampled speaker drops out, independently of the player's gate.
policy.reset();sample.combat=false;voice=true;updateBattles(player,.5,true)
sample.combat=true;for _=1,6 do now=now+.5;updateBattles(player,.5,true)end
speakerReady=false;now=now+.5;updateBattles(player,.5,true)
evidence=lastCancellation()
assert(evidence.reason=='speaker-unavailable' and evidence.guard.speaker.present and not evidence.guard.speaker.available)
assert(evidence.guard.speaker.reason=='native-dialogue' and evidence.guard.speaker.distance==2)
-- A brief noncombat sample is visibly distinct from a missing actor or menu.
policy.reset();speakerReady=true;sample.combat=false;updateBattles(player,.5,true)
sample.combat=true;for _=1,6 do now=now+.5;updateBattles(player,.5,true)end
sample.combat=false;now=now+.5;updateBattles(player,.5,true)
evidence=lastCancellation()
assert(evidence.reason=='combat-quiet' and evidence.scheduler.quiet and evidence.scheduler.quietSeconds==0)
-- Unload and file-write diagnostics must contain only bounded plain state.
for i=1,35 do
 automatic={requestId='record-'..i,entity='1ULL',profileKey='judy-alvarez',text='PRIVATE TEXT',
   reaction={phase='start',encounter='battle-1',expiresAt=2000000}}
 cancelAutomatic('test-unload',true)
end
local rows;evidence,rows=lastCancellation();assert(#rows==32 and evidence.abandoning and evidence.requestId=='record-35')
assert(evidence.text==nil and evidence.name==nil and evidence.reaction==nil)
local function plain(value)
 assert(type(value)~='userdata' and type(value)~='function')
 if type(value)=='table' then for _,item in pairs(value)do plain(item)end end
end
plain(evidence)
`));

test('temporary native speech holds the same pending reaction and gates actual delivery without restarting generation', () => run(adapterFixture + `
sample.combat=false;updateBattles(player,.5,true)
sample.combat=true;for _=1,6 do now=now+.5;updateBattles(player,.5,true)end
local context=assert(automatic);local deadline=context.reaction.expiresAt;local sentGeneration=generation
speakerReady,speakerBusy=false,true;now=now+.5;updateBattles(player,.5,true)
assert(pending==context and automatic==context and context.waitingForSpeaker)
assert(not reactionCanDeliver(context,player),'Native speech must block audio, face and subtitles')
local lease=encoded[tonumber(files['runtime/reaction-lease.json']:match('%d+'))]
assert(lease.valid and lease.requestId==context.requestId)
speakerReady,speakerBusy=true,false
assert(reactionCanDeliver(context,player) and not context.waitingForSpeaker)
assert(pending==context and generation==sentGeneration and context.reaction.expiresAt==deadline)
-- Native dialogue can start between the observer sample and reply delivery.
speakerReady,speakerBusy=false,true
assert(not reactionCanDeliver(context,player) and pending==context)
assert(reactionCanDeliver({requestId='manual'},player),'Manual conversation policy is unchanged')
`));

test('a held reaction keeps its original expiry and yields to manual or native story interruption', () => run(adapterFixture + `
local function start()
 policy.reset();active=nil;speakerReady,speakerBusy=true,false
 sample.combat=false;updateBattles(player,.5,true)
 sample.combat=true;for _=1,6 do now=now+.5;updateBattles(player,.5,true)end
 assert(automatic);speakerReady,speakerBusy=false,true
 now=now+.5;updateBattles(player,.5,true);assert(automatic.waitingForSpeaker)
end
start();now=automatic.reaction.expiresAt/1000+1;updateBattles(player,.5,true)
assert(not pending and not automatic);assert(lastCancellation().reason=='admission-expired')
start();active={};now=now+.5;updateBattles(player,.5,true)
assert(not automatic and lastCancellation().reason=='manual-priority')
start();sample.blocked=true;now=now+.5;updateBattles(player,.5,true)
assert(not automatic and lastCancellation().reason=='scene-blocked');sample.blocked=false
start();speakerBusy=false;now=now+.5;updateBattles(player,.5,true)
assert(not automatic and lastCancellation().reason=='speaker-unavailable')
`));

test('native dialogue interrupting an admitted reaction still releases its playback', () => run(adapterFixture + `
sample.combat=false;updateBattles(player,.5,true)
sample.combat=true;for _=1,6 do now=now+.5;updateBattles(player,.5,true)end
automatic.playbackAt=now;automatic.shown=true;speech.requestId=automatic.requestId;pending=nil
speakerReady,speakerBusy=false,true;now=now+.5;updateBattles(player,.5,true)
assert(not automatic and stopped==1 and lastCancellation().reason=='speaker-unavailable')
`));

test('on-time speech may finish past admission expiry while gameplay interruption still wins', () => run(fixture + `
tick(1,true);tick(2,true);local event=assert(offer(false));policy.claim(event)
local started=event.expiresAt/1000-1
now=event.expiresAt/1000+2
assert(not policy.valid(event,now))
assert(policy.valid(event,now,started))
assert(not policy.valid(event,now,now),'Late speech must not be admitted')
sample.blocked=true;tick(0,true);assert(not policy.valid(event,now,started))
sample.blocked=false;tick(0,true);now=started+31;assert(not policy.valid(event,now,started))
`));

test('native guard ignores broad scene membership but blocks authored dialogue, calls, choices and vehicles', () => run(`
local dialogue,tier,call,choices,vehicle=false,1,nil,{},nil
local player={IsAttached=function()return true end,IsDeadNoStatPool=function()return false end,
  IsInCombat=function()return false end,GetEntityID=function()return 1 end,
  GetMountedVehicle=function()return vehicle end,IsReplacer=function()return false end}
PlayerPuppet={GetSceneTier=function()return tier end}
FromVariant=function(v)return v end; Enum={new=function(_,v)return v end}
Game={GetSceneSystem=function()return {GetScriptInterface=function()return {
  IsEntityInDialogue=function()return dialogue end,IsEntityInScene=function()return true end}end}end,
  GetAllBlackboardDefs=function()return {UI_ComDevice={PhoneCallInformation='call'},UIInteractions={DialogChoiceHubs='choices'}}end,
  GetBlackboardSystem=function()return {Get=function()return {GetVariant=function(_,field)
    if field=='call' then return call end;return {choiceHubs=choices}end}end}end}
local m=(function() ${observer} end)()
assert(not m.sample(player).blocked)
dialogue=true;assert(m.sample(player).blocked);dialogue=false
tier=2;assert(m.sample(player).blocked);tier=1
call={callPhase='StartCall'};assert(m.sample(player).blocked);call=nil
choices={1};assert(m.sample(player).blocked);choices={}
vehicle={};assert(m.sample(player).blocked);vehicle=nil
Game.GetSceneSystem=function()error('Unavailable')end
assert(m.sample(player).blocked and m.sample(player).error)
assert(not m.canSpeak(nil,'end'))
`));

test('native speaker eligibility reports the failing gate without exposing native error text', () => run(`
local attached,dead,dialogue,scene,combat,autonomous=true,false,false,false,false,true
local npc={IsAttached=function()return attached end,IsDeadNoStatPool=function()return dead end,
 GetEntityID=function()return 1 end,IsOnAutonomousAI=function()return autonomous end}
Game={GetSceneSystem=function()return {GetScriptInterface=function()return {
 IsEntityInDialogue=function()return dialogue end,IsEntityInScene=function()return scene end}end}end}
NPCPuppet={IsInCombat=function()return combat end}
local m=(function() ${observer} end)()
local ok,why=m.canSpeak(npc,'end');assert(ok and why=='available')
attached=false;ok,why=m.canSpeak(npc,'start');assert(not ok and why=='detached');attached=true
dead=true;ok,why=m.canSpeak(npc,'start');assert(not ok and why=='dead');dead=false
local waiting
dialogue=true;ok,why,waiting=m.canSpeak(npc,'start');assert(not ok and why=='native-dialogue' and waiting)
autonomous=false;ok,why,waiting=m.canSpeak(npc,'start');assert(not ok and why=='story-control' and not waiting)
autonomous=true;dialogue=false
scene=true;ok,why,waiting=m.canSpeak(npc,'start');assert(not ok and why=='native-scene' and waiting);scene=false
combat=true;ok,why=m.canSpeak(npc,'end');assert(not ok and why=='still-in-combat')
assert(m.canSpeak(npc,'start'))
Game.GetSceneSystem=function()error('native private details')end
ok,why,waiting=m.canSpeak(npc,'end');assert(not ok and why=='native-read-failed' and not waiting)
`));

const battle = {version: 1, status: 'ended', encounter: 'battle-1', ageSeconds: 8, durationSeconds: 25,
  opponents: [{name: 'Tyger Claw', kind: 'Human', count: 2}], witnesses: ['judy-alvarez']};
const input = {requestId: '1000-1-1ULL', generation: 1, entity: '1ULL', name: 'Judy', bodyType: 'WomanAverage',
  profileKey: 'judy-alvarez', text: 'Who was that?', battle};
test('combat protocol preserves only observations and rejects malformed automatic turns', () => {
  assert.deepEqual(parseBattle({...battle, claimedVictory: true}), battle);
  for (const invalid of [{}, {...battle, opponents: [{name: 'X', count: 999}]}, {...battle, witnesses: Array(9).fill('alex')}]) {
    assert.equal(parseBattle(invalid).status, 'unavailable');
    assert.equal(parseInput(JSON.stringify({...input, battle: invalid})).text, input.text);
  }
  const reaction = {kind: 'battle', phase: 'end', encounter: 'battle-1', expiresAt: 10000};
  assert.deepEqual(parseReaction(reaction, battle), reaction);
  assert.equal(parseInput(JSON.stringify({...input, reaction: {...reaction, phase: 'start'}})), null);
  assert.notEqual(inputIdentity(input), inputIdentity({...input, battle: {...battle, encounter: 'battle-2'}}));
  const context = conversationContext({...input, reaction});
  assert.match(context, /You were nearby/); assert.match(context, /does not establish victory/);
  assert.match(context, /not something V said/); assert.match(context, /No follow-up question/);
  assert.match(battleContext({...input, profileKey: 'panam-palmer'}), /presence.*not established/);
  assert.equal(parseBattle({version: 1, status: 'none', opponents: battle.opponents}).opponents, undefined);
});

test('automatic lease cannot authorize a late, superseded or cancelled reply; manual replies bypass it', () => {
  const auto = {...input, reaction: {kind: 'battle', phase: 'end', encounter: 'battle-1', expiresAt: 10000}};
  const lease = {requestId: input.requestId, valid: true, updated: 1000};
  assert.equal(reactionLeaseValid(auto, lease, 5000), true);
  for (const state of [null, {...lease, valid: false}, {...lease, requestId: 'different'}]) {
    assert.equal(reactionLeaseValid(auto, state, 5000), false);
  }
  assert.equal(reactionLeaseValid(auto, lease, 6001), false);
  assert.equal(reactionLeaseValid(auto, {...lease, updated: 11000}, 11000), false);
  const playing = {...lease, updated: 11000, playbackStartedAt: 9500};
  assert.equal(reactionLeaseValid(auto, playing, 11000), true);
  assert.equal(reactionLeaseValid(auto, {...playing, playbackStartedAt: 10500}, 11000), false);
  assert.equal(reactionLeaseValid(auto, {...playing, valid: false}, 11000), false);
  assert.equal(reactionLeaseValid(auto, {...playing, updated: 40000}, 40000), false);
  assert.equal(reactionLeaseValid(input, null, 99999), true);
});

test('event trigger carries observed facts and limits without pretending to be a player utterance', () => {
  const reaction = {kind: 'battle', phase: 'end', encounter: battle.encounter, expiresAt: 10000};
  const trigger = battleTrigger({...input, reaction});
  assert.match(trigger, /outcome is unknown/);
  assert.match(trigger, /Tyger Claw/);
  assert.match(trigger, /not total enemy numbers/);
  assert.match(trigger, /including a rhetorical question/);
  assert(!trigger.includes(input.text));
  assert.equal(battleTrigger(input), input.text);
  assert.throws(() => battleTrigger({...input, reaction: {...reaction, phase: 'start'}}));
});

test('phone shares recent combat as reported facts and preserves the actual message and session', async () => {
  const state = parsePhoneState(JSON.stringify({version: 1, world: 'save-1', updated: 100, active: true,
    request: {id: 'save-1-1', contact: 'panam', text: input.text, battle}}));
  const calls = [];
  const phone = new PhoneChat({contacts: [{contact: 'panam', key: 'panam-palmer'}], ids: {'panam-palmer': 'id'},
    now: () => 100, reply: async call => { calls.push(call); return {text: 'A reply', sessionID: 'session'}; }, publish: async () => {}});
  await phone.accept(state); await phone.active?.work;
  assert.equal(state.request.text, input.text);
  assert.match(calls[0].text, /Tyger Claw/); assert.match(calls[0].text, /presence.*not established/);
  assert(calls[0].text.endsWith(input.text)); assert.equal(calls[0].voice, false);
});
