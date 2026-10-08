import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';
import {parseInput} from './protocol.mjs';
import {CompanionActions, CompanionActionWindow, parseFollowOffer, parseLeaveOffer, parseFollowUnavailable,
  publishCompanionActionContext, followActionName, leaveActions, FOLLOW_ACTION, LEAVE_ACTION, LEAVE_ALL_ACTION,
  FOLLOW_UNAVAILABLE, chauffeurActionName} from './companion-actions.mjs';

// World characters joining V ("Follow V") and party members leaving ("Leave V's
// Party"), docs/WORLD_COMPANIONS.md. The model decides from the conversation;
// these tests pin the offers, the one-use transport and the game-side checks.

const judy = {serial: 3, id: '44ULL', key: 'judy-alvarez', name: 'Judy Alvarez'};
const panam = {serial: 4, id: '55ULL', key: 'panam-palmer', name: 'Panam Palmer'};
const follow = () => ({available: true, actor: {id: '44ULL', key: 'judy-alvarez'}, name: 'Judy Alvarez'});
const leave = (members = [judy]) => ({available: true, actor: {id: '44ULL', key: 'judy-alvarez'},
  members: members.map(member => ({...member}))});
const groupOf = (index = 1) => ({id: 'group-1', index, total: 2, audience: ['judy-alvarez', 'panam-palmer'], heard: []});
function prepared(extra = {}, {group, source = group ? 'group-text' : 'private-text'} = {}) {
  const channel = group ? 'group' : 'private';
  return {sendAllowed: true, identified: true, worldToken: 'world-fixture', generation: 2,
    remoteConfig: {endUserId: 'fixture-user'},
    route: {channel, transport: source.endsWith('-voice') ? 'microphone' : channel},
    input: {requestId: '100-4-44ULL', generation: 4, entity: '44ULL', profileKey: 'judy-alvarez', channel,
      name: 'Judy', bodyType: 'Woman', text: 'Come with me', ...(group ? {group} : {}), ...extra}};
}
function broker() {
  let sequence = 0; const files = [];
  const actions = new CompanionActions({now: () => 10000, createToken: () => 'drive-' + String(++sequence).padStart(20, '0'),
    publish: async (packet, options) => {
      if (options?.isCurrent && !await options.isCurrent()) return false;
      files.push(packet); return true;
    }});
  const options = source => ({source, isCurrent: async () => true, isCurrentSync: () => true});
  return {actions, files, options};
}

test('follow and leave offers are strict game snapshots and a malformed one never breaks the request', () => {
  assert.deepEqual(parseFollowOffer(follow()), follow());
  assert.deepEqual(parseLeaveOffer(leave([judy, panam])), leave([judy, panam]));
  for (const change of [o => o.available = false, o => o.actor.id = 'judy', o => o.actor.key = 'Judy Alvarez',
    o => o.name = '', o => o.name = 'bad\nname', o => o.extra = 1, o => o.actor.serial = 3]) {
    const bad = follow(); change(bad); assert.equal(parseFollowOffer(bad), null);
  }
  for (const change of [o => o.members = [], o => o.members = [judy, panam, judy, panam],
    o => o.members[0].serial = 0, o => o.members[0].serial = 1.5, o => o.members.push({...judy}),
    o => o.members.push({...panam, serial: 3}), o => o.members[0].extra = true, o => o.actor.id = 'x']) {
    const bad = leave(); change(bad); assert.equal(parseLeaveOffer(bad), null);
  }
  for (const reason of Object.keys(FOLLOW_UNAVAILABLE)) assert.equal(parseFollowUnavailable(reason), reason);
  assert.equal(parseFollowUnavailable('party-full'), null, 'the party has no size limit to refuse for');
  assert.equal(parseFollowUnavailable('because'), null);
  const parsed = parseInput(JSON.stringify(prepared({followOffer: follow(), leaveOffer: leave(), followUnavailable: 'quest'}).input));
  assert.deepEqual(parsed.followOffer, follow()); assert.deepEqual(parsed.leaveOffer, leave());
  assert.equal(parsed.followUnavailable, 'quest');
  const malformed = parseInput(JSON.stringify(prepared({followOffer: {available: true}, leaveOffer: 7,
    followUnavailable: 'because'}).input));
  assert.equal(malformed.requestId, '100-4-44ULL');
  assert.equal(malformed.followOffer, undefined); assert.equal(malformed.leaveOffer, undefined);
  assert.equal(malformed.followUnavailable, undefined);
});

test('a follow offer arms only the addressed world character and one delivery publishes the exact join', async () => {
  const {actions, files, options} = broker();
  const config = actions.admit(prepared({followOffer: follow()}), options('private-text'));
  assert.equal(config.drive, false); assert.deepEqual(config.follow, {name: 'Judy Alvarez'});
  assert.equal(config.leave, undefined); assert.equal(config.group, undefined);
  for (const message of [{version: 1, token: config.token}, {version: 1, token: config.token, follow: 'yes'},
    {version: 1, token: config.token, leave: 1}, {version: 1, token: 'drive-stalestalestalestale', follow: true},
    {version: 1, token: config.token, follow: true, extra: 1}])
    assert.equal(await actions.deliver(message), false);
  assert.deepEqual(await Promise.all([actions.deliver({version: 1, token: config.token, follow: true}),
    actions.deliver({version: 1, token: config.token, follow: true})]), [true, false]);
  const packet = files.find(row => row.action === 'companion-follow');
  assert.deepEqual(packet.followOffer, follow());
  assert.equal(packet.offer, undefined); assert.equal(packet.leaveOffer, undefined);
  assert.equal(packet.entity, '44ULL'); assert.equal(packet.source, 'private-text');
  assert.equal(packet.expiresAt - packet.createdAt, 5000);
  for (const change of [p => p.input.followOffer.actor.id = '99ULL', p => p.input.followOffer.actor.key = 'panam-palmer',
    p => p.input.reaction = {kind: 'battle'}, p => p.route.channel = 'phone', p => p.input.group = groupOf()]) {
    const fresh = broker(), p = prepared({followOffer: follow()}); change(p);
    assert.equal(fresh.actions.admit(p, fresh.options('private-text')), null);
  }
});

test('a private leave offer lets the companion send only itself away, by member number', async () => {
  const {actions, files, options} = broker();
  assert.equal(actions.admit(prepared({leaveOffer: leave()}), options('private-voice')), null,
    'a voice source needs the microphone route');
  const p = prepared({leaveOffer: leave()}, {source: 'private-voice'});
  const armed = actions.admit(p, options('private-voice'));
  assert.deepEqual(armed.leave, {members: [{name: 'Judy Alvarez', self: true}]});
  for (const target of ['all', 0, 2, '1', 1.5]) assert.equal(await actions.deliver({version: 1, token: armed.token, leave: target}), false);
  assert.equal(await actions.deliver({version: 1, token: armed.token, leave: 1}), true);
  const packet = files.find(row => row.action === 'companion-leave');
  assert.equal(packet.leave, '44ULL'); assert.deepEqual(packet.leaveOffer, leave());
  assert.equal(packet.source, 'private-voice');
});

test('only the first speaker of a manual group round can send companions away, and only through a leave offer', async () => {
  const {actions, files, options} = broker();
  const config = actions.admit(prepared({leaveOffer: leave([judy, panam])}, {group: groupOf()}), options('group-text'));
  assert.equal(config.group, true); assert.equal(config.drive, false);
  assert.deepEqual(config.leave.members, [{name: 'Judy Alvarez', self: true}, {name: 'Panam Palmer', self: false}]);
  assert.equal(await actions.deliver({version: 1, token: config.token, leave: 'all'}), true);
  const packet = files.find(row => row.action === 'companion-leave');
  assert.equal(packet.leave, 'all'); assert.equal(packet.source, 'group-text');
  const rejected = [
    [prepared({leaveOffer: leave([judy, panam])}, {group: groupOf(2)}), 'group-text'],
    [prepared({leaveOffer: leave([judy, panam])}, {group: groupOf()}), 'private-text'],
    [prepared({leaveOffer: leave([judy, panam])}), 'group-text'],
    [prepared({leaveOffer: leave(), followOffer: follow()}, {group: groupOf()}), 'group-text'],
    [prepared({leaveOffer: leave(), followUnavailable: 'quest'}, {group: groupOf()}), 'group-text'],
    [prepared({}, {group: groupOf()}), 'group-text'],
    [prepared({leaveOffer: leave()}, {group: groupOf(), source: 'group-text'}), 'group-voice'],
  ];
  for (const [p, source] of rejected) {
    const fresh = broker(); assert.equal(fresh.actions.admit(p, fresh.options(source)), null, source);
  }
  const voice = broker();
  assert.ok(voice.actions.admit(prepared({leaveOffer: leave()}, {group: groupOf(), source: 'group-voice'}),
    voice.options('group-voice')));
});

test('a refused follow arms no action; it only tells the character to decline in character', async () => {
  const {actions, files, options} = broker();
  const config = actions.admit(prepared({followUnavailable: 'quest'}), options('private-text'));
  assert.equal(config.followUnavailable, 'quest'); assert.equal(config.follow, undefined);
  for (const message of [{version: 1, token: config.token}, {version: 1, token: config.token, follow: true}])
    assert.equal(await actions.deliver(message), false);
  assert.equal(files.filter(row => row.action !== 'none').length, 0);
  const window = new CompanionActionWindow({now: () => 10000});
  assert.equal(window.open(config), true);
  assert.equal(window.accept({actions: [{name: followActionName(config)}]}), null);
  const text = CompanionActionWindow.contextText(config);
  assert.match(text, /cannot let you come along/); assert.match(text, /decline briefly in character/);
  assert.ok(text.includes(FOLLOW_UNAVAILABLE.quest));
  assert.equal(CompanionActionWindow.unavailableText(config), text, 'the advisory survives an unavailable action adapter');
  const sent = [], client = {isBotReady: true, room: {localParticipant: {sid: 'local',
    publishData: async bytes => sent.push(JSON.parse(new TextDecoder().decode(bytes)))}}};
  await publishCompanionActionContext(client, {text: 'context'}, config);
  assert.deepEqual(sent[0].data.action_config.actions, []);
  // A follow that is available never carries a refusal at the same time.
  assert.equal(window.open({...config, follow: {name: 'Judy'}}), false);
});

test('the browser window accepts only the advertised follow and leave names for its own token', () => {
  const now = 10000, window = new CompanionActionWindow({now: () => now});
  const token = 'drive-abcdefghijklmnop';
  const privateOffer = {version: 1, token, source: 'private-text', expiresAt: now + 90000, drive: false,
    follow: {name: 'Judy Alvarez'}};
  assert.equal(window.open({...privateOffer, group: true}), false, 'a private offer cannot claim a group');
  assert.equal(window.open(privateOffer), true);
  for (const action of [{name: FOLLOW_ACTION}, {name: followActionName(privateOffer), target: 'drive-stalestalestalestale'},
    {name: `${LEAVE_ACTION} ${token}`}, {name: chauffeurActionName(privateOffer)}])
    assert.equal(window.accept({actions: [action]}), null);
  assert.deepEqual(window.accept({actions: [{name: followActionName(privateOffer)}]}), {version: 1, token, follow: true});
  assert.equal(window.accept({actions: [{name: followActionName(privateOffer)}]}), null, 'one use');
  window.open(privateOffer);
  assert.deepEqual(window.accept({actions: [{name: FOLLOW_ACTION, target: token}]}), {version: 1, token, follow: true});

  const groupOffer = {version: 1, token, source: 'group-voice', expiresAt: now + 90000, drive: false, group: true,
    leave: {members: [{name: 'Judy Alvarez', self: true}, {name: 'Jackie', self: false}, {name: 'Jackie', self: false}]}};
  assert.deepEqual(leaveActions(groupOffer).map(row => row.base),
    [LEAVE_ACTION, "Jackie 2 Leaves V's Party", "Jackie 3 Leaves V's Party", LEAVE_ALL_ACTION]);
  assert.equal(window.open({...groupOffer, follow: {name: 'Judy'}}), false, 'a group round cannot join anyone');
  assert.equal(window.open({...groupOffer, source: 'group-text', group: undefined}), false);
  assert.equal(window.open({...groupOffer, leave: {members: [{name: 'A', self: true}, {name: 'B', self: true}]}}), false);
  assert.equal(window.open(groupOffer), true);
  assert.deepEqual(window.accept({actions: [{name: `Jackie 3 Leaves V's Party ${token}`}]}), {version: 1, token, leave: 3});
  window.open(groupOffer);
  assert.deepEqual(window.accept({actions: [{name: LEAVE_ALL_ACTION, target: token}]}), {version: 1, token, leave: 'all'});
  window.open({...groupOffer, leave: {members: [{name: 'Judy Alvarez', self: true}]}});
  assert.equal(window.accept({actions: [{name: `${LEAVE_ALL_ACTION} ${token}`}]}), null, 'no "everyone" for one member');
  assert.deepEqual(window.accept({actions: [{name: `${LEAVE_ACTION} ${token}`}]}), {version: 1, token, leave: 1});
});

test('prompt guidance leaves the decision to the model and names the casual phrases that must not trigger', async () => {
  const token = 'drive-abcdefghijklmnop';
  const offer = {version: 1, token, source: 'private-text', expiresAt: 1, drive: false, follow: {name: 'Judy Alvarez'}};
  const followText = CompanionActionWindow.contextText(offer);
  assert.ok(followText.includes(JSON.stringify(followActionName(offer))));
  assert.match(followText, /clearly asks you to come with them now/);
  assert.match(followText, /"come with me", "follow me", "let's go"/);
  assert.match(followText, /request it right away in the same reply/);
  assert.match(followText, /If you would refuse in character, say so and request nothing/);
  assert.match(followText, /invitation for some later time/);
  assert.match(followText, /never say them aloud/);

  const own = {...offer, follow: undefined, leave: {members: [{name: 'Judy Alvarez', self: true}]}};
  const leaveText = CompanionActionWindow.contextText(own);
  assert.ok(leaveText.includes(JSON.stringify(`${LEAVE_ACTION} ${token}`)));
  assert.match(leaveText, /you can go, to go home, to get lost, that you two are done here/);
  for (const casual of ['"leave it"', '"leave me alone for a sec"', '"let\'s leave this place"', '"let\'s get out of here"'])
    assert.ok(leaveText.includes(casual), casual);
  assert.match(leaveText, /Do not request it for phrases that keep the company together/);
  assert.match(leaveText, /frustrated, teasing or unclear, nobody leaves/);
  assert.match(leaveText, /says a short goodbye that fits them/);

  const group = {...own, source: 'group-text', group: true,
    leave: {members: [{name: 'Judy Alvarez', self: true}, {name: 'Panam Palmer', self: false}]}};
  const groupText = CompanionActionWindow.contextText(group);
  assert.match(groupText, /Only the companion V addresses leaves/);
  assert.match(groupText, /for everyone only when V clearly sends all of them away/);
  assert.ok(groupText.includes(`"Panam Palmer Leaves V's Party ${token}" means "Panam Palmer" leaves V's party.`));
  assert.ok(groupText.includes(`"${LEAVE_ALL_ACTION} ${token}" means every companion listed leaves`));
  assert.match(CompanionActionWindow.unavailableText(group), /join or leave V's party/);

  const sent = [], client = {isBotReady: true, room: {localParticipant: {sid: 'local',
    publishData: async bytes => sent.push(JSON.parse(new TextDecoder().decode(bytes)))}}};
  await publishCompanionActionContext(client, {text: 'context'}, {...offer, leave: own.leave});
  assert.deepEqual(sent[0].data.action_config.actions, [followActionName(offer), `${LEAVE_ACTION} ${token}`]);
  assert.match(sent[0].data.action_config.objects[0].description, /^Your chance to come along with V, V's current party, bound/);
});

test('the game never infers a departure from V\'s words: without the model\'s action nothing is published', async () => {
  // The same casual or even explicit wording is only text to the bridge; only an
  // action response for the armed token reaches the game.
  for (const text of ['Leave it.', 'Leave me alone for a sec.', "Let's leave this place.", 'You can go home now.']) {
    const {actions, files, options} = broker();
    const config = actions.admit(prepared({text, leaveOffer: leave()}), options('private-text'));
    const window = new CompanionActionWindow({now: () => 10000});
    window.open(config);
    assert.equal(window.accept({actions: []}), null);
    assert.equal(window.accept({text}), null);
    window.finish();
    assert.equal(files.filter(row => row.action === 'companion-leave').length, 0, text);
  }
});

// ---- Lua: the lease in gameplay-actions.lua ---------------------------------
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
function runLua(program) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const status = lauxlib.luaL_dostring(vm, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(vm);
  assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
}
const actionsSource = readFileSync(new URL('../mod/gameplay-actions.lua', import.meta.url), 'utf8');
const leaseFixture = `
local now,raw,sequence=100000,nil,0
local packets,joined,left,feedback={},{},{},{}
local world={ready=true,worldToken='world-a',generation=1}
local followAnswer={available=true,actor={id='22ULL',key='judy'},name='Judy'}
local leaveAnswer={available=true,actor={id='22ULL',key='judy'},members={{serial=2,id='22ULL',key='judy',name='Judy'}}}
local groupLeave={available=true,actor={id='22ULL',key='judy'},members={{serial=2,id='22ULL',key='judy',name='Judy'},
  {serial=5,id='55ULL',key='panam',name='Panam'}}}
local function clone(value)
 if type(value)~='table'then return value end
 local result={};for k,v in pairs(value)do result[k]=clone(v)end;return result
end
local function context(id,group)return {requestId=id or 'request-1',generation=7,entity='22ULL',profileKey='judy',group=group}end
local function packet(input,action,extra)
 local value={version=1,action=action,actionId='action-'..(sequence+1),requestId=input.requestId,
  generation=input.generation,entity=input.entity,profileKey=input.profileKey,source=extra and extra.source or 'private-text',
  worldToken='world-a',worldGeneration=1,createdAt=now,expiresAt=now+5000}
 for k,v in pairs(extra or {})do if k~='source' then value[k]=v end end
 return value
end
local function publish(value)sequence=sequence+1;raw=tostring(sequence);packets[raw]=value end
local q=(function() ${actionsSource} end)().new({
 world=function()return world end,clock=function()return now end,normalizeOffer=clone,
 followOffer=function(entity,ctx)assert(entity=='22ULL' and ctx.profileKey=='judy');return clone(followAnswer)end,
 leaveOffer=function(entity,ctx)return clone(ctx.group and groupLeave or leaveAnswer)end,
 queueFollow=function(offer,entity,requestId)joined[#joined+1]={offer=offer,entity=entity,requestId=requestId};return true,'coming'end,
 queueLeave=function(target,offer,entity,requestId,group)left[#left+1]={target=target,offer=offer,entity=entity,requestId=requestId,group=group};return true,'leaving'end,
 read=function()return raw end,decode=function(value)return assert(packets[value])end,
 feedback=function(state,reason)feedback[#feedback+1]={state=state,reason=reason}end})
`;

test('a manual private turn leases follow and leave offers; each exact packet is used once', () => runLua(leaseFixture + `
 local input=context();assert(q.capture(input,'private-text'))
 assert(input.followOffer.name=='Judy' and input.leaveOffer.members[1].serial==2)
 local inspect=q.inspect();assert(inspect.follow and inspect.leave)
 local changed=packet(input,'companion-follow',{followOffer=clone(input.followOffer)});changed.followOffer.actor.id='99ULL'
 publish(changed);q.update(true);assert(#joined==0)
 publish(packet(input,'companion-leave',{leaveOffer=clone(input.leaveOffer),leave='55ULL'}));q.update(true);assert(#left==0,'unoffered member')
 publish(packet(input,'companion-follow',{followOffer=clone(input.followOffer),source='phone'}));q.update(true);assert(#joined==0)
 publish(packet(input,'companion-follow',{followOffer=clone(input.followOffer)}));q.update(true)
 assert(#joined==1 and joined[1].entity=='22ULL' and joined[1].requestId=='request-1')
 publish(packet(input,'companion-leave',{leaveOffer=clone(input.leaveOffer),leave='22ULL'}));q.update(true)
 assert(#left==0,'the first matching packet consumed the whole lease')
 input=context('request-2');assert(q.capture(input,'private-voice'))
 publish(packet(input,'companion-leave',{leaveOffer=clone(input.leaveOffer),leave='22ULL',source='private-voice'}));q.update(true)
 assert(#left==1 and left[1].target=='22ULL' and left[1].group==nil)
`));

test('only a group round\'s first speaker leases, and only a leave offer', () => runLua(leaseFixture + `
 local second=context('g-2',{id='round',index=2});assert(not q.capture(second,'group-text'))
 assert(not q.capture(context('g-0',{id='round',index=1}),'private-text'),'a group turn is never private')
 assert(not q.capture(context('g-x'),'group-text'),'a private turn is never a group turn')
 local input=context('g-1',{id='round',index=1});assert(q.capture(input,'group-voice'))
 assert(input.followOffer==nil and input.chauffeurOffer==nil and input.tacticOffer==nil)
 assert(#input.leaveOffer.members==2)
 publish(packet(input,'companion-leave',{leaveOffer=clone(input.leaveOffer),leave='all',source='group-voice'}));q.update(true)
 assert(#left==1 and left[1].target=='all' and left[1].group=='round')
`));

test('a refused follow passes only its reason code and leases nothing', () => runLua(leaseFixture + `
 followAnswer={available=false,reason='quest'};leaveAnswer=nil
 local input=context();assert(not q.capture(input,'private-text'))
 assert(input.followUnavailable=='quest' and input.followOffer==nil and not q.inspect().pending)
 assert(q.inspect().followUnavailable=='quest')
 followAnswer={available=false,reason='made-up'}
 input=context('request-2');q.capture(input,'private-text');assert(input.followUnavailable==nil)
`));

// ---- Lua: adoption end to end (real companions.lua and party queue) ----------
const partySource = readFileSync(new URL('../mod/manager-party.lua', import.meta.url), 'utf8');
const adoptionSource = readFileSync(new URL('../mod/companion-adoption.lua', import.meta.url), 'utf8');
const worldFixture = `
  local queue=(function() ${partySource} end)().new(companions,nil)
  queue.bind('world')
  local scenes={inScene=false}
  Game.GetSceneSystem=function() return {GetScriptInterface=function() return {
    IsEntityInScene=function() return scenes.inScene end, IsEntityInDialogue=function() return false end} end} end
  local mounted=nil
  Game.GetMountingFacility=function() return {GetMountingInfoSingleWithObjects=function()
    return mounted and {parentId={hash=mounted}} or nil end} end
  NPCPuppet.IsInCombat=function(npc) return npc.combat==true end
  function player:IsInCombat() return false end
  -- A world character: a native actor the mod does not own.
  local function worldNpc(id,x,y,flags)
    local npc={id={hash=id},pos=Vector4.new(x,y),flags=flags or {},events={},attached=true}
    function npc:GetEntityID() return self.id end
    function npc:IsAttached() return self.attached end
    function npc:IsDeadNoStatPool() return false end
    function npc:IsA(kind) return kind=='NPCPuppet' end
    function npc:GetWorldPosition() return self.pos end
    function npc:GetWorldOrientation() return {yaw=90} end
    function npc:GetCurrentAppearanceName() return self.flags.appearance or 'judy_default' end
    function npc:GetRecordID() return self.flags.record or 'Character.Judy' end
    function npc:IsCrowd() return self.flags.crowd==true end
    function npc:IsPrevention() return false end
    function npc:IsCharacterPolice() return self.flags.police==true end
    function npc:IsQuest() return self.flags.quest==true end
    function npc:IsOnAutonomousAI() return self.flags.story~=true end
    function npc:IsVendor() return self.flags.vendor==true end
    function npc:IsHostile() return self.flags.hostile==true end
    function npc:IsCharacterChildren() return false end
    function npc:IsPlayerCompanion() return false end
    function npc:GetAIControllerComponent() return {GetAIRole=function() return self.flags.role end} end
    function npc:QueueEvent(event) self.events[#self.events+1]=event; self.visible=event.visible end
    return npc
  end
  local busy,promoted,logs=true,{},{}
  local adoption=(function() ${adoptionSource} end)().new({companions=companions,
    party=function() return queue end, player=function() return player end,
    busy=function() return busy end, named=function(key) return key~='resident-female' end,
    groupEntities=function(context) return context.entities or {} end,
    promote=function(key) promoted[#promoted+1]=key end, log=function(line) logs[#logs+1]=line end})
  companions.departure=adoption
  local function copyOf(row) return entities[tonumber(row.entityID)] end
  local function step(seconds)
    for i=1,math.max(1,math.floor((seconds or .5)/.5)) do
      queue.flush(); companions.update(player,0.5); adoption.update(0.5)
    end
  end
  local function find(key)
    for _,row in ipairs(companions.list()) do if row.profileKey==key then return row end end
  end
`;
const runWorld = body => runLua(uiLocaleBootstrap + 'convaiUiLocale=uiLocaleFixture\n' + companionEngine + worldFixture + body);

test('a world character who follows joins as a managed copy in its place, after its reply, and its original is hidden', () => runWorld(`
  local judy=worldNpc('900',3,0)
  local offer=adoption.offer('900',judy,'judy-alvarez','Judy Alvarez')
  assert(offer.available and offer.actor.id=='900' and offer.actor.key=='judy-alvarez' and offer.name=='Judy Alvarez')
  local accepted,message=adoption.queueFollow(offer,'900','request-1')
  assert(accepted,message); assert(message:find('Judy Alvarez is coming with you',1,true))
  local listed=queue.list(); assert(#listed==1 and not listed[1].serial,'a reserved party place, not yet a copy')
  assert(queue.count()==1)
  step(2); assert(#companions.list()==0,'no copy while the reply is still being heard')
  assert(judy.visible==nil,'the original is untouched until its copy exists')
  busy=false; step(1)
  local row=find('judy-alvarez'); assert(row and row.state=='ready',row and row.state)
  assert(row.name=='Judy Alvarez' and row.key:find('^world%-900%-'))
  assert(judy.visible==false,'the original is hidden once the copy stands in its place')
  assert(adoption.hidden(judy) and adoption.hidden('900'))
  assert(promoted[1]=='judy-alvarez','a conversation partner leaves that role when it joins')
  -- A second Judy elsewhere in the world cannot also follow.
  local other=worldNpc('901',-3,0)
  local refused=adoption.offer('901',other,'judy-alvarez','Judy Alvarez')
  assert(refused.available==false and refused.reason=='already-here')
  -- Generic people are not one person: two residents may both come along.
  local resident=worldNpc('902',0,3,{appearance='woman_01'})
  assert(adoption.offer('902',resident,'resident-female','Pedestrian').available)
  -- The copy itself is a party member: it gets a leave offer, never a follow offer.
  assert(adoption.offer(row.entityID,{GetEntityID=function() return {hash=row.entityID} end},'judy-alvarez','Judy')==nil)
`));

test('the copy is created from the original\'s record, appearance and spot', () => runWorld(`
  local judy=worldNpc('900',3,1,{appearance='judy_casual'})
  local offer=adoption.offer('900',judy,'judy-alvarez','Judy Alvarez')
  local created
  local create=Game.GetDynamicEntitySystem().CreateEntity
  Game.GetDynamicEntitySystem().CreateEntity=function(self,spec) created=spec; return create(self,spec) end
  busy=false; assert(adoption.queueFollow(offer,'900','request-1')); step(1)
  assert(created and created.recordID=='Character.Judy' and created.appearanceName=='judy_casual')
  assert(created.orientation.yaw==90)
  assert(math.abs(created.position.x-3)<0.8 and math.abs(created.position.y-1)<0.8,
    'placed at the original spot: '..created.position.x..','..created.position.y)
  assert(find('judy-alvarez').state=='ready')
`));

test('quest, scene, police, vendor, hostile, combat, mounted and directed characters are refused', () => runWorld(`
  local cases={{flags={quest=true},reason='quest'},{flags={story=true},reason='quest'},
    {flags={police=true},reason='police'},{flags={vendor=true},reason='working'},
    {flags={hostile=true},reason='hostile'},{flags={role={IsA=function() return false end}},reason='busy'}}
  for index,case in ipairs(cases) do
    local npc=worldNpc(tostring(800+index),3,0,case.flags)
    local offer=adoption.offer(tostring(800+index),npc,'judy-alvarez','Judy')
    assert(offer.available==false and offer.reason==case.reason,index..': '..tostring(offer.reason))
    assert(not adoption.queueFollow({available=true,actor={id=tostring(800+index),key='judy-alvarez'},name='Judy'},
      tostring(800+index),'r'),'an offer the game refused cannot be queued')
  end
  local npc=worldNpc('810',3,0)
  scenes.inScene=true; assert(adoption.offer('810',npc,'judy-alvarez','Judy').reason=='scene'); scenes.inScene=false
  npc.combat=true; assert(adoption.offer('810',npc,'judy-alvarez','Judy').reason=='combat'); npc.combat=false
  mounted='77'; assert(adoption.offer('810',npc,'judy-alvarez','Judy').reason=='vehicle'); mounted=nil
  -- An unreadable signal is a refusal, never a guess that the character is free.
  npc.IsQuest=function() error('native read failed') end
  assert(adoption.offer('810',npc,'judy-alvarez','Judy').available==false)
  assert(#queue.list()==0)
`));

test('a character that becomes unavailable before its copy is placed is never adopted', () => runWorld(`
  local judy=worldNpc('900',3,0)
  local offer=adoption.offer('900',judy,'judy-alvarez','Judy Alvarez')
  assert(adoption.queueFollow(offer,'900','request-1'))
  judy.flags.quest=true; busy=false; step(1)
  assert(#companions.list()==0 and #queue.list()==0,'the reservation was released')
  assert(judy.visible==nil)
  local notices=queue.takeNotices(); assert(#notices==1 and notices[1].failed)
  assert(notices[1].message:find("can't come along",1,true),notices[1].message)
  -- Walking away from V cancels too.
  judy.flags.quest=false; busy=true
  local again=adoption.offer('900',judy,'judy-alvarez','Judy Alvarez'); assert(again.available)
  assert(adoption.queueFollow(again,'900','request-2'))
  judy.pos=Vector4.new(40,0); busy=false; step(1)
  assert(#companions.list()==0 and #queue.list()==0)
  assert(queue.takeNotices()[1].message:find('no longer nearby',1,true))
`));

test('the follow offer of an offer never made is refused, and a large party never refuses a follow', () => runWorld(`
  local judy=worldNpc('900',3,0)
  assert(not adoption.queueFollow({available=true,actor={id='900',key='judy-alvarez'},name='Judy'},'900','r'),
    'the game did not offer this follow')
  for index=1,8 do companions.registerDefinition('filler'..index,{id='Character.Filler',name='Filler'}); assert(queue.invite('filler'..index)) end
  -- The party has no size limit: nine members and invitations later, V can still be joined.
  local offer=adoption.offer('900',judy,'judy-alvarez','Judy Alvarez')
  assert(offer.available==true and offer.reason==nil, tostring(offer.reason))
  busy=false; assert(adoption.queueFollow(offer,'900','request-1'))
`));

test('a companion told to leave says goodbye first, then leaves through Dismiss; its original returns out of view', () => runWorld(`
  -- Judy stands right in front of V.
  local judy=worldNpc('900',0,3)
  local offer=adoption.offer('900',judy,'judy-alvarez','Judy Alvarez')
  busy=false; assert(adoption.queueFollow(offer,'900','request-1')); step(1)
  local row=find('judy-alvarez'); assert(row.state=='ready' and judy.visible==false)
  local leave=adoption.leaveOffer(row.entityID,{profileKey='judy-alvarez'})
  assert(leave.available and #leave.members==1 and leave.members[1].serial==row.serial and leave.members[1].id==row.entityID)
  busy=true
  local accepted,message=adoption.queueLeave(row.entityID,leave,row.entityID,'request-2')
  assert(accepted and message:find('Judy Alvarez is leaving your party',1,true))
  assert(adoption.leaveOffer(row.entityID,{profileKey='judy-alvarez'})==nil,'already leaving')
  step(2); assert(find('judy-alvarez'),'still here during the goodbye')
  busy=false; step(1)
  -- After the goodbye she walks away (home is her own spot here, too close: away from V) ...
  local copy=copyOf(row)
  local walk=last(copy,'AIMoveToCommand')
  local goal=walk and walk.movementTarget and walk.movementTarget.position
  assert(goal and goal.y>copy.pos.y+10,'walks away from V: '..tostring(goal and goal.y))
  assert(adoption.inspect().walking==1)
  step(5); assert(find('judy-alvarez'),'not removed while V watches her walk off')
  -- ... and is removed once out of view and far enough away.
  copy.pos=Vector4.new(0,30); player.forward=Vector4.new(1,0); step(2)
  assert(find('judy-alvarez')==nil,'removed out of view through the Dismiss path')
  -- V is looking away from the original's spot too, so she is back at once.
  assert(judy.visible==true,'the original is shown again out of view')
  assert(not adoption.hidden(judy))
  assert(adoption.offer('900',judy,'judy-alvarez','Judy Alvarez').available,'back to normal life: she can be asked again')
`));

// The walk away must work in a real street: most directions end in a wall, off
// the mesh, or in clearance the movement actuator refuses (2026-10-08: all six
// blind 35 m goals were refused within three seconds and Judy just stood).
const leaveSetup = `
  local judy=worldNpc('900',0,3)
  local offer=adoption.offer('900',judy,'judy-alvarez','Judy Alvarez')
  busy=false; assert(adoption.queueFollow(offer,'900','request-1')); step(1)
  local row=find('judy-alvarez'); assert(row.state=='ready')
  local copy=copyOf(row)
  local leave=adoption.leaveOffer(row.entityID,{profileKey='judy-alvarez'})
  local function navigation(accept)
    Game.GetAINavigationSystem=function() return {
      FindPointInSphereForCharacter=function(_,p,radius)
        if accept(p,radius) then return {status='OK',point=p} end
        return {status='Failed'}
      end,
      CalculatePathForCharacter=function(_,a,b)
        return {path={a,b},CalculateLength=function() return math.sqrt((a.x-b.x)^2+(a.y-b.y)^2+(a.z-b.z)^2) end}
      end} end
  end
  local function goal()
    local walk=last(copy,'AIMoveToCommand')
    return walk and walk.movementTarget and walk.movementTarget.position
  end
`;

test('a leaving companion walks to a point the mesh proves reachable, not blindly 35 m from V', () => runWorld(leaveSetup + `
  -- Only an east strip is walkable: straight away from V (north) is a wall.
  navigation(function(p) return p.x>=8 end)
  assert(adoption.queueLeave(row.entityID,leave,row.entityID,'request-2')); step(3)
  local g=goal(); assert(g,'she must walk: '..table.concat(logs,' / '))
  assert(g.x>=8,'goal is on the mesh: '..g.x..','..g.y)
  local gap=math.sqrt((g.x-copy.pos.x)^2+(g.y-copy.pos.y)^2)
  assert(gap>=40 and gap<=60,'a long first walk, 40 to 60 m: '..gap)
  assert(math.sqrt(g.x^2+g.y^2)>=12,'ends well away from V')
`));

test('a goal the movement actuator refuses is dropped for the next direction, and she keeps trying', () => runWorld(leaveSetup + `
  -- The leaving search accepts anything (wide radius); the actuator's exact
  -- check (0.55 m) only accepts the east strip: three refused goals first.
  navigation(function(p,radius) return radius>1 or p.x>=8 end)
  assert(adoption.queueLeave(row.entityID,leave,row.entityID,'request-2')); step(6)
  local g=goal(); assert(g and g.x>=8,'finally a goal the actuator accepts: '..tostring(g and g.x))
  local tries=0
  for _,cmd in ipairs(copy.ai.commands) do if cmd.kind=='AIMoveToCommand' then tries=tries+1 end end
  assert(tries>=1)
  assert(find('judy-alvarez'),'still walking, not removed while V watches')
`));

test('arriving while V can still see her, she takes the next goal farther from V, and keeps chaining', () => runWorld(leaveSetup + `
  navigation(function() return true end)
  player.forward=Vector4.new(0,1) -- V watches her
  assert(adoption.queueLeave(row.entityID,leave,row.entityID,'request-2')); step(3)
  local function away(g) return math.sqrt((g.x-player.pos.x)^2+(g.y-player.pos.y)^2) end
  local stood=0
  for round=1,3 do
    local g=goal(); assert(g,'round '..round..' has a goal: '..table.concat(logs,' / '))
    assert(away(g)>stood+5,'each goal farther from V: '..away(g)..' after '..stood)
    -- She arrives and the command succeeds; V has walked after her, so she is
    -- still in view and well inside the removal distance.
    copy.pos=Vector4.new(g.x,g.y); last(copy,'AIMoveToCommand').state='Success'
    player.pos=Vector4.new(g.x*0.7,g.y*0.7)
    player.forward=Vector4.new(g.x-player.pos.x,g.y-player.pos.y)
    stood=away(copy.pos)
    step(3)
    assert(find('judy-alvarez'),'not removed while V sees her: '..table.concat(logs,' / '))
  end
`));

test('a goal that gets her nowhere is replaced after a few seconds by a different direction', () => runWorld(leaveSetup + `
  navigation(function() return true end)
  player.forward=Vector4.new(0,1)
  assert(adoption.queueLeave(row.entityID,leave,row.entityID,'request-2')); step(3)
  local first=goal(); assert(first)
  step(6) -- the copy never moves: the first goal is given up
  local second=goal()
  assert(second and (second.x~=first.x or second.y~=first.y),'a different goal: '..first.x..','..first.y)
`));

test('a companion who cannot find or make headway is removed as soon as V cannot see her, never left standing', () => runWorld(leaveSetup + `
  navigation(function() return false end) -- no walkable ground anywhere
  player.forward=Vector4.new(1,0) -- V looks away from her
  assert(adoption.queueLeave(row.entityID,leave,row.entityID,'request-2')); step(1)
  assert(not goal(),'nowhere to walk')
  step(3); assert(find('judy-alvarez'),'given a moment first')
  step(4); assert(find('judy-alvarez')==nil,'removed out of view well before the 30 s safety: '..table.concat(logs,' / '))
  assert(table.concat(logs,' / '):find('stuck, out of view',1,true))
`));

test('a stuck companion V is looking at is never removed in view; she goes the moment V looks away', () => runWorld(leaveSetup + `
  navigation(function() return false end)
  player.forward=Vector4.new(0,1) -- V looks right at her
  assert(adoption.queueLeave(row.entityID,leave,row.entityID,'request-2')); step(1)
  step(120); assert(find('judy-alvarez'),'visible and stuck: still here after two minutes '..table.concat(logs,' / '))
  player.forward=Vector4.new(1,0); step(0.5)
  assert(find('judy-alvarez'),'not on the first look away')
  step(2); assert(find('judy-alvarez')==nil,'V has not seen her for a second: '..table.concat(logs,' / '))
`));

test('a stuck companion keeps trying other goals, including short hops, while V watches', () => runWorld(leaveSetup + `
  navigation(function() return true end)
  player.forward=Vector4.new(0,1)
  assert(adoption.queueLeave(row.entityID,leave,row.entityID,'request-2')); step(1)
  local seen,count={},0
  for i=1,120 do
    step(0.5)
    local g=goal()
    if g then local key=string.format('%.1f:%.1f',g.x,g.y); if not seen[key] then seen[key]=true; count=count+1 end end
  end
  assert(count>=6,'many different goals tried: '..count)
  assert(find('judy-alvarez'),'still here')
`));

test('V far away removes a stuck companion even in view', () => runWorld(leaveSetup + `
  navigation(function() return false end)
  player.forward=Vector4.new(0,1)
  assert(adoption.queueLeave(row.entityID,leave,row.entityID,'request-2')); step(3)
  assert(find('judy-alvarez'))
  player.pos=Vector4.new(0,-60); step(2)
  assert(find('judy-alvarez')==nil,'V is 60 m away: '..table.concat(logs,' / '))
`));

test('headway keeps a walking companion from being called stuck', () => runWorld(leaveSetup + `
  navigation(function() return true end)
  player.forward=Vector4.new(0,1)
  assert(adoption.queueLeave(row.entityID,leave,row.entityID,'request-2')); step(1)
  assert(goal())
  -- She keeps walking (moves 2 m every half second) for twelve seconds in view.
  for i=1,24 do copy.pos=Vector4.new(copy.pos.x,copy.pos.y+0.75); step(0.5) end
  assert(find('judy-alvarez'),'a walker making headway is not removed: '..table.concat(logs,' / '))
`));

test('a summoned companion can be sent away the same way, and a group round offers only its party members', () => runWorld(`
  companions.registerDefinition('panam',{id='Character.Panam',name='Panam Palmer',profileKey='panam-palmer'})
  assert(queue.invite('panam')); step(1)
  local panam=find('panam-palmer'); assert(panam and panam.state=='ready')
  local world=worldNpc('900',3,0)
  local leave=adoption.leaveOffer('900',{profileKey='judy-alvarez',group={id='round'},entities={'900',panam.entityID}})
  assert(#leave.members==1 and leave.members[1].id==panam.entityID,'the world speaker is not a party member')
  assert(adoption.leaveOffer('900',{profileKey='judy-alvarez'})==nil,'no leave offer for a world character')
  busy=false
  local at=copyOf(panam).pos
  player.forward=Vector4.new(at.x-player.pos.x,at.y-player.pos.y) -- V watches her
  assert(adoption.queueLeave('all',leave,'900','request-3','round')); step(1)
  assert(find('panam-palmer'),'walking away first')
  -- Never seen leaving view while V watches: she is not removed in plain sight.
  step(31)
  assert(find('panam-palmer'),'still here, V is looking at her')
  player.forward=Vector4.new(player.pos.x-at.x,player.pos.y-at.y); step(3) -- V turns away
  assert(find('panam-palmer')==nil,table.concat(logs,' / '))
  assert(not adoption.queueLeave(panam.entityID,leave,'900','request-4'),'already gone')
`));

test('a hidden crowd original is shown again once V has moved on, and a load clears everything without native calls', () => runWorld(`
  local person=worldNpc('950',3,0,{crowd=true,appearance='woman_02'})
  local offer=adoption.offer('950',person,'resident-female','Pedestrian')
  busy=false; assert(adoption.queueFollow(offer,'950','request-1')); step(1)
  assert(person.visible==false)
  player.pos=Vector4.new(80,0); step(.5)
  assert(person.visible==true,'pooled crowd people are never left hidden')
  assert(find('resident-female'),'the companion itself stays in the party')
  adoption.abandon(true); assert(#adoption.inspect().adoptions==1,'fast travel keeps the record')
  local events=#person.events
  adoption.abandon(false)
  assert(#adoption.inspect().adoptions==0 and #person.events==events)
`));

test('a copy that cannot be created frees its party place and the character can be asked again', () => runWorld(`
  local judy=worldNpc('900',3,0)
  local offer=adoption.offer('900',judy,'judy-alvarez','Judy Alvarez')
  local system=Game.GetDynamicEntitySystem()
  local create=system.CreateEntity
  system.CreateEntity=function() error('native refused') end
  busy=false; assert(adoption.queueFollow(offer,'900','request-1')); step(1)
  assert(#companions.list()==0 and judy.visible==nil)
  step(.5)
  assert(#queue.list()==0 and queue.count()==0,'the failed reservation no longer holds a place')
  local notices=queue.takeNotices(); assert(#notices>=1 and notices[1].failed)
  system.CreateEntity=create
  local again=adoption.offer('900',judy,'judy-alvarez','Judy Alvarez')
  assert(again.available,'not stuck as already-here: '..tostring(again.reason))
  local long=string.rep('é',70)
  local clipped=adoption.offer('900',judy,'judy-alvarez',long).name
  assert(#clipped<=120 and #clipped%2==0,'names are clipped on a UTF-8 boundary')
`));

// A pedestrian's record is crowd-flagged, so its copy is spawned from a private
// non-crowd clone (mod/companion-records.lua) and still wears the original look.
const crowdWorld = `
  local flats,clones={},{}
  TDBID={ToStringDEBUG=function(id) return id end}
  TweakDB={
    GetRecord=function(_,id)
      if id=='Character.Broken' then return {IsA=function() return true end,IsCrowd=function() return true end} end
      if clones[id] then return {IsA=function() return true end,IsCrowd=function() return flats[id..'.isCrowd']~=false end} end
      if tostring(id):find('^CyberpunkConvai%.') then return nil end
      return {IsA=function() return true end,IsCrowd=function() return id=='Character.CorpoWoman' end,
        IsLightCrowd=function() return false end}
    end,
    CloneRecord=function(_,name,source) if source=='Character.Broken' then return false end; clones[name]=source; return true end,
    SetFlat=function(_,name,value) flats[name]=value; return true end,
    GetFlat=function(_,name) return flats[name] end}
`;
test('a crowd pedestrian joins as a non-crowd clone of its record, keeping its appearance', () => runWorld(crowdWorld + `
  local person=worldNpc('960',3,0,{crowd=true,record='Character.CorpoWoman',appearance='corpo_woman_07'})
  local offer=adoption.offer('960',person,'resident-female','Corporate worker')
  assert(offer.available,'a crowd record can be copied: '..tostring(offer.reason))
  local created
  local system=Game.GetDynamicEntitySystem()
  local create=system.CreateEntity
  system.CreateEntity=function(self,spec) created=spec; return create(self,spec) end
  busy=false; assert(adoption.queueFollow(offer,'960','request-1')); step(1)
  assert(created.recordID=='CyberpunkConvai.NonCrowd_CorpoWoman','spawned from the clone: '..tostring(created.recordID))
  assert(clones['CyberpunkConvai.NonCrowd_CorpoWoman']=='Character.CorpoWoman')
  assert(flats['CyberpunkConvai.NonCrowd_CorpoWoman.isCrowd']==false)
  assert(created.appearanceName=='corpo_woman_07','the original look, not the clone default')
  local row=find('resident-female'); assert(row and row.state=='ready')
  assert(person.visible==false)
  -- A named record that is not crowd-flagged is spawned from itself.
  local judy=worldNpc('961',-3,0)
  assert(adoption.queueFollow(adoption.offer('961',judy,'judy-alvarez','Judy Alvarez'),'961','request-2')); step(1)
  assert(created.recordID=='Character.Judy')
`));

test('a record that cannot be copied is never offered, and a record that failed to join is not offered again', () => runWorld(crowdWorld + `
  local broken=worldNpc('970',3,0,{crowd=true,record='Character.Broken'})
  local offer=adoption.offer('970',broken,'resident-male','Pedestrian')
  assert(offer.available==false and offer.reason=='unavailable',tostring(offer.reason))
  -- A copy rejected at attachment (here: still a crowd member) marks its record.
  local person=worldNpc('971',3,0,{record='Character.Odd'})
  local system=Game.GetDynamicEntitySystem()
  local create=system.CreateEntity
  system.CreateEntity=function(self,spec)
    local id=create(self,spec); local npc=system:GetEntity(id); npc.IsCrowd=function() return true end; return id
  end
  busy=false; assert(adoption.queueFollow(adoption.offer('971',person,'resident-male','Pedestrian'),'971','request-1'))
  step(1); step(1)
  local notices=queue.takeNotices(); assert(#notices>=1 and notices[1].failed and notices[1].message:find('crowd',1,true))
  assert(person.visible==nil,'never hidden')
  local again=worldNpc('972',-3,0,{record='Character.Odd'})
  local refused=adoption.offer('972',again,'resident-male','Pedestrian')
  assert(refused.available==false and refused.reason=='unavailable','learned for the session: '..tostring(refused.reason))
`));
