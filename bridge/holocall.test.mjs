import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {parseInput, parseHolocall} from './protocol.mjs';
import {turnContext, turnContextDiagnostic, MAX_CHARS} from './turn-context.mjs';
import {buildMessages} from './mistral-prompt.mjs';

// Holocalls (docs/HOLOCALL.md): the bridge words a call turn, mod/holocall.lua runs the call, Holocall.reds drives the
// game's call window without the game's call path.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const holocallSource = read('../mod/holocall.lua');
const reds = read('../r6/scripts/CyberpunkConvai/Holocall.reds');

const scene = (extra = {}) => ({version: 1, status: 'ready', hour: 2, minute: 10, district: 'Watson', area: 'Kabuki',
  gender: 'female', lifepath: 'streetkid', vehicle: false, motion: 'walking', health: 'hurt', heat: 3, money: 'rich',
  party: [{key: 'judy-alvarez', name: 'Judy'}, {key: 'panam-palmer', name: 'Panam'}], ...extra});
const turn = (extra = {}) => ({requestId: '100-1-11ULL', generation: 1, entity: '11ULL', profileKey: 'judy-alvarez',
  name: 'Judy', bodyType: '', text: 'Hey, you there?', ...extra});

// ---------------------------------------------------------------- bridge side
test('a holocall field is carried for a private turn and dropped when malformed or in a group', () => {
  assert.deepEqual(parseHolocall({version: 1, contact: 'judy', mode: 'audio'}), {contact: 'judy', mode: 'audio'});
  assert.deepEqual(parseHolocall({version: 1, contact: 'jackie_dead', mode: 'holo'}), {contact: 'jackie_dead', mode: 'holo'});
  for (const bad of [null, [], 'judy', {contact: 'judy', mode: 'audio'}, {version: 2, contact: 'judy', mode: 'audio'},
    {version: 1, contact: 'ju dy', mode: 'audio'}, {version: 1, contact: 'judy', mode: 'video'}, {version: 1, contact: '', mode: 'audio'}]) {
    assert.equal(parseHolocall(bad), null, JSON.stringify(bad));
  }
  const input = parseInput(JSON.stringify(turn({holocall: {version: 1, contact: 'judy', mode: 'audio'}})));
  assert.deepEqual(input.holocall, {contact: 'judy', mode: 'audio'});
  // A malformed call keeps the message: the turn is simply not a call.
  const kept = parseInput(JSON.stringify(turn({holocall: {version: 1, contact: 'x y', mode: 'audio'}})));
  assert.ok(kept && kept.holocall === undefined);
  assert.equal(parseInput(JSON.stringify(turn())).holocall, undefined);
});

test('a voice call says she is on a call and elsewhere, with nothing of V\'s company, heat, money or injury', () => {
  const text = turnContext(turn({holocall: {contact: 'judy', mode: 'audio'}, turnContext: scene()}));
  assert.ok(text.startsWith('Right now (from the game, this turn only): You are on a voice call with V on the phone, not talking to V in person; '
    + 'V is in Kabuki, Watson. You are somewhere else; where you are and what you are doing are not given. It is late night'), text);
  assert.match(text, /V is walking\./);
  assert.match(text, /Treat this as fact: you are on a call, not with V, and you do not know how near or far you are/);
  assert.doesNotMatch(text, /Also with V|Panam|police|MaxTac|rich|eddies|hurt|with V in person in|never claim to be anywhere else/);
  assert.ok(text.length <= MAX_CHARS && !text.includes('\n'), `${text.length} characters`);
});

test('a live-picture holocall says they see and hear each other, and the diagnostic names the call', () => {
  const input = turn({holocall: {contact: 'judy', mode: 'holo'}, turnContext: scene()});
  const text = turnContext(input);
  assert.match(text, /^Right now \(from the game, this turn only\): You are on a holocall with V \(a video call on the phone\): you see and hear each other, but you are not with V in person; V is in Kabuki, Watson\. You are somewhere else;/);
  assert.doesNotMatch(text, /Also with V|Panam/);
  assert.match(turnContextDiagnostic(input), /^Turn context: \d+ facts, \d+ chars holocall=holo$/);
  assert.doesNotMatch(turnContextDiagnostic(turn({turnContext: scene()})), /holocall/);
  // A group turn or a phone text chat is never worded as a call.
  assert.match(turnContext(turn({holocall: {contact: 'judy', mode: 'audio'}, channel: 'phone', turnContext: scene()})), /messaging V by text/);
  // An in-person turn is unchanged.
  assert.match(turnContext(turn({turnContext: scene()})), /You are with V in person in Kabuki, Watson\./);
});

test('Mistral repeats the call sentence right before V\'s words, with the remote reminder', () => {
  const now = turnContext(turn({holocall: {contact: 'judy', mode: 'audio'}, turnContext: scene()}));
  const messages = buildMessages({persona: {name: 'Judy', ambient: false, backstory: 'A braindance editor.', style: 'Warm.', samples: ['V: Hi. Judy: Hey.']}, contextParts: {now, notes: '', world: '', volatile: ''}, text: 'Hey'});
  const last = messages.at(-1).content;
  assert.match(last, /\[YOU, RIGHT NOW: You are on a voice call with V on the phone[^\]]*You are not with V; never say you are there, close or nearby/);
  assert.doesNotMatch(last, /That is all you are doing/);
});

// ---------------------------------------------------------------- native side
test('Holocall.reds drives only the call window: no quest call, quest fact or call blackboard, and the game\'s handler always runs', () => {
  const code = reds.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  for (const forbidden of ['questTriggerCallRequest', 'TriggerCall', 'SetPhoneFact', 'TalkingTriggerRequest', 'SetTalkingTrigger(',
    'PhoneCallInformation, ', 'SetVariant', 'PickupPhoneRequest', 'UsePhoneRequest', 'QueueRequest']) {
    assert.ok(!code.includes(forbidden), `Holocall.reds uses ${forbidden}`);
  }
  // Every wrapped call handler reaches wrappedMethod on every path: a mod call never blocks a game call.
  const onPhoneCall = /protected cb func OnPhoneCall\(value: Variant\) -> Bool \{([^]*?)\n\}/.exec(code)[1];
  const returns = [...onPhoneCall.matchAll(/return ([^;]+);/g)].map(match => match[1]);
  assert.ok(returns.length >= 3 && returns.every(value => value === 'wrappedMethod(value)' || value === 'result'), returns.join(' | '));
  assert.match(onPhoneCall, /this\.m_convaiCallPreempted = true;[^]*ConvaiHolocallEvent\("quest-call"\)[^]*return wrappedMethod\(value\);/);
  const onAction = /protected cb func OnAction\(action: ListenerAction, consumer: ListenerActionConsumer\) -> Bool \{([^]*?)\n\}/.exec(code)[1];
  assert.match(onAction, /return wrappedMethod\(action, consumer\);\s*$/);
  assert.ok(!/Consume\(/.test(onAction), 'hang-up must not consume the phone button');
  // A call never starts while the game has one or blocks calls.
  assert.match(code, /if this\.ConvaiCallGameBusy\(\) \{ return "quest-call"; \};/);
  assert.match(code, /IsCallingEnabled\(\)/);
  // Only a contact Lua registered (the mod's own characters, never Johnny) can be called.
  assert.match(code, /!this\.ConvaiHolocallHasContact\(contact\)/);
  assert.ok(!code.includes('ConvaiPhoneChatHasContact'), 'the call list is its own, not the Chat list');
});

test('a holocall starts from the ordinary Contacts call, only for registered mod contacts; every other contact calls as before', () => {
  const code = reds.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  // The one hook: the function that would send the game's call request, after the game's own checks (callable, calls enabled).
  const wrapped = [...code.matchAll(/@wrapMethod\((\w+)\)\s*\n(?:public|protected|private) (?:cb )?func (CallSelectedContact|CallContact|AcceptAction|AlternativeAcceptAction|OnContactListAction)\b/g)]
    .map(m => m[1] + '.' + m[2]);
  assert.deepEqual(wrapped, ['NewHudPhoneGameController.CallSelectedContact']);
  const hook = /public func CallSelectedContact\(contactData: wref<ContactData>\) -> Void \{([^]*?)\n\}/.exec(code)[1];
  // The mod's own request is the only early return; everything else reaches the game's function with the same argument.
  assert.match(hook, /^\s*if IsDefined\(contactData\) && !contactData\.convaiChat && IsDefined\(this\.m_player\)\s*&& this\.m_player\.ConvaiHolocallRequest\(contactData\.contactId\) \{\s*return;\s*\};\s*wrappedMethod\(contactData\);\s*$/);
  assert.equal([...hook.matchAll(/return/g)].length, 1);
  // The request is refused (so the game's call runs) unless the contact was registered by Lua.
  const request = /public final func ConvaiHolocallRequest\(contact: String\) -> Bool \{([^]*?)\n\}/.exec(code)[1];
  assert.match(request, /if StrLen\(contact\) == 0 \|\| !this\.ConvaiHolocallHasContact\(contact\) \{ return false; \};/);
  // Nothing in the Chat list or inside a chat offers or starts a call any more.
  for (const file of ['PhoneChatTabs.reds', 'PhoneChat.reds']) {
    assert.doesNotMatch(read('../r6/scripts/CyberpunkConvai/' + file), /[Hh]olocall/, file);
  }
  const tabs = read('../r6/scripts/CyberpunkConvai/PhoneChatTabs.reds');
  assert.match(tabs, /inkWidgetRef\.SetVisible\(this\.m_action2ButtonWidget, false\);/);
  assert.match(tabs, /inkWidgetRef\.SetVisible\(this\.m_callInputHint, false\);[^]*inkWidgetRef\.SetVisible\(this\.m_separtor, false\);/);
  assert.match(tabs, /public func AlternativeAcceptAction\(\) -> Void \{\s*if NotEquals\(this\.m_convaiChatState, ConvaiPhoneChatState\.Off\) \{\s*this\.ConvaiOpenChat/);
  const chat = read('../r6/scripts/CyberpunkConvai/PhoneChat.reds');
  assert.match(chat, /inkWidgetRef\.SetVisible\(this\.m_hintCall, false\);/);
  // The Call key inside a chat is swallowed and does nothing.
  assert.match(chat, /n"phone_open_journal"\)\) \{\s*\/\/[^\n]*\n\s*ListenerActionConsumer\.Consume\(consumer\);\s*return false;/);
});

test('the live picture setting is a Conversations setting, not a developer one', () => {
  const mcm = read('../mod/mcm.lua');
  const conversations = mcm.slice(mcm.indexOf("category('conversation-controls'"), mcm.indexOf("category('companion-behavior'"));
  const development = mcm.slice(mcm.indexOf("category('development'"), mcm.indexOf("category('help', 'Help'"));
  assert.match(conversations, /setting\('holocallLiveImage', 'Live holocall picture \(experimental\)'/);
  assert.doesNotMatch(development, /holocall/i);
  assert.match(mcm, /key == 'holocallLiveImage'/);
});

// ---------------------------------------------------------------- Lua state machine
function run(body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const program = 'local holocall\n' + fixture + '\nholocall = (function() ' + holocallSource + ' end)()\n' + setup + '\n' + body;
    const status = lauxlib.luaL_dostring(vm, to_luastring(program));
    const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
  } finally { lua.lua_close(vm); }
}

const fixture = `
local logs, notices, warmed, ended, connected = {}, {}, {}, {}, {}
convaiNotices = {send = function(_, id, text) notices[#notices + 1] = {id = id, text = text}; return true end}
convaiUiLocale = {revision = function() return 1 end, t = function(text, args)
  return (text:gsub('{([%w_]+)}', function(key) return args and args[key] and tostring(args[key]) or '{' .. key .. '}' end)) end}
local function logged(pattern) for _, line in ipairs(logs) do if line:find(pattern) then return line end end end
local function lastNotice() return notices[#notices] end
-- The game: one player with the native methods Holocall.reds adds.
local game = {begin = 'ok', window = 'audiocall', events = {}, requests = {}, ends = 0, connects = {}, labels = {}}
local player = {}
function player:GetEntityID() return {hash = '7ULL'} end
function player:ConvaiHolocallTakeRequest() return table.remove(game.requests, 1) or '' end
function player:ConvaiHolocallBegin(contact) game.began = contact; return game.begin end
function player:ConvaiHolocallConnect(live) game.connects[#game.connects + 1] = live; return game.window end
function player:ConvaiHolocallEnd() game.ends = game.ends + 1 end
function player:ConvaiHolocallTakeEvent() return table.remove(game.events, 1) or '' end
function player:ConvaiHolocallClearContacts() game.registered = {} end
function player:ConvaiHolocallRegisterContact(contact) game.registered[#game.registered + 1] = contact end
local enabled, busy, live = {['judy-alvarez'] = true, ['johnny-silverhand'] = true}, false, false
local open = {available = true, combat = false, tier = 1, dialogue = false, choices = false, call = false, replacer = false}
local function sample(extra) local s = {} for k, v in pairs(open) do s[k] = v end for k, v in pairs(extra or {}) do s[k] = v end return s end
local function tick(seconds, s) local left = seconds; while left > 0 do holocall.update(player, 0.1, true, s or open); left = left - 0.1 end end
`;
const setup = `
holocall.configure({
  log = function(line) logs[#logs + 1] = line end,
  contacts = function() return {
    {contact = 'judy', key = 'judy-alvarez', name = 'Judy Alvarez', record = 'Character.Judy'},
    {contact = 'johnny', key = 'johnny-silverhand', name = 'Johnny', record = 'Character.Johnny'},
    {contact = 'silver', key = 'judy-alvarez', name = 'Copy', record = 'Character.Silverhand_Default'},
    {contact = 'bad', key = 'Bad Key', name = 'Bad'}} end,
  supported = function(key) return key == 'judy-alvarez' or key == 'johnny-silverhand' end,
  profileEnabled = function(key) return enabled[key] == true end,
  warm = function(key, entity) warmed[#warmed + 1] = key .. '@' .. tostring(entity) end,
  liveImage = function() return live end,
  busy = function() return busy end,
  onConnected = function(call) connected[#connected + 1] = call.contact end,
  onEnded = function(call, reason) ended[#ended + 1] = call.contact .. ':' .. reason end,
})
holocall.sweepDue = false
`;

test('idle costs nothing, and a phone request rings, connects as a voice call and routes the talk keys to the caller', () => run(`
  holocall.update(player, 0.1, true, open)
  assert(holocall.call == nil and game.began == nil)
  game.requests = {'judy'}
  holocall.drain(player)
  -- The drain registers the callable contacts once: the catalogue rows, never Johnny, a Silverhand record or a bad key.
  assert(#game.registered == 1 and game.registered[1] == 'judy', 'only judy is registered')
  assert(holocall.request and holocall.request.contact == 'judy' and logged('requested contact=judy'))
  -- Nothing starts while the world is not playable (the phone is still open).
  holocall.update(player, 0.1, false, open)
  assert(holocall.call == nil and holocall.request)
  holocall.update(player, 0.1, true, open)
  assert(game.began == 'judy' and holocall.call.state == 'dialing')
  assert(warmed[1] == 'judy-alvarez@7ULL', 'the connection warms while the call rings')
  assert(logged('state=dialing contact=judy profile=judy%-alvarez mode=audio hud=ok'))
  assert(holocall.partner(player, false) == nil, 'nobody answers before the call connects')
  tick(1.6)
  assert(holocall.connected() and game.connects[1] == false)
  assert(logged('state=connected contact=judy mode=audio window=audiocall'))
  assert(lastNotice().id == 'holocall-connected' and lastNotice().text == 'Holocall with Judy Alvarez. Tap the phone button to hang up.')
  assert(connected[1] == 'judy')
  local caller = holocall.partner(player, false)
  assert(caller.npc == player and caller.entity == '7ULL' and caller.profileKey == 'judy-alvarez' and caller.voiceOnly == true)
  assert(caller.name == 'Judy Alvarez' and caller.holocall.version == 1 and caller.holocall.contact == 'judy' and caller.holocall.mode == 'audio')
  assert(holocall.partner(player, true) == nil, 'group chat keeps its nearby partners')
  assert(holocall.partnerValid({entity = '7ULL', holocall = {contact = 'judy', mode = 'audio'}}))
  assert(not holocall.partnerValid({entity = '7ULL'}) and not holocall.partnerValid({entity = '7ULL', holocall = {contact = 'panam', mode = 'audio'}}))
`));

test('hanging up, a game call, combat, a scene and a quiet while each end the call once, with one probe line', () => run(`
  local function call() game.requests = {'judy'}; holocall.drain(player); tick(2); assert(holocall.connected()) end
  call(); game.events = {'hangup'}; tick(0.3)
  assert(holocall.call == nil and game.ends == 1 and ended[1] == 'judy:hangup' and logged('state=ended contact=judy reason=hangup'))
  assert(lastNotice().id == 'holocall-connected', 'V hanging up shows no notice')
  assert(not holocall.partnerValid({entity = '7ULL', holocall = {contact = 'judy', mode = 'audio'}}))
  call(); game.events = {'quest-call'}; tick(0.3)
  assert(ended[2] == 'judy:quest-call' and lastNotice().id == 'holocall-connected', 'the game call shows its own window')
  call(); tick(0.3, sample({combat = true}))
  assert(ended[3] == 'judy:combat' and lastNotice().id == 'holocall-ended' and lastNotice().text == 'Holocall ended: combat started.')
  call(); tick(0.3, sample({tier = 3}))
  assert(ended[4] == 'judy:scene' and lastNotice().text == 'Holocall with Judy Alvarez ended.')
  call(); tick(0.3, sample({call = true}))
  assert(ended[5] == 'judy:quest-call')
  call(); busy = true; tick(200); assert(holocall.connected(), 'a call in use never times out')
  busy = false; holocall.touch(); tick(179); assert(holocall.connected())
  tick(2); assert(ended[6] == 'judy:idle')
  call(); enabled['judy-alvarez'] = false; tick(0.3); assert(ended[7] == 'judy:disabled')
  assert(game.ends == 7)
`));

test('events left in the queue by an earlier HUD teardown or game call do not hang up the next call', () => run(`
  game.events = {'hud-lost', 'quest-call', 'hangup'}
  game.requests = {'judy'}; holocall.drain(player); tick(2)
  assert(holocall.connected(), 'the old events were cleared before the call began')
  assert(#game.events == 0 and ended[1] == nil)
  game.events = {'hangup'}; tick(0.3)
  assert(ended[1] == 'judy:hangup', 'a hang-up during the call still ends it')
`));

test('a call is refused for a quest call, combat, a non-mod contact, Johnny and a disabled profile', () => run(`
  local function ask(contact, s) game.requests = {contact}; holocall.drain(player); holocall.update(player, 0.1, true, s or open) end
  ask('johnny'); assert(holocall.call == nil and logged('refused contact=johnny reason=not%-a%-mod%-character'))
  ask('silver'); assert(holocall.call == nil, 'a Silverhand record is never called')
  ask('bad'); assert(holocall.call == nil)
  ask('panam'); assert(holocall.call == nil and lastNotice().text == 'This contact cannot take a holocall.')
  ask('judy', sample({combat = true})); assert(holocall.call == nil and lastNotice().text == 'Calls are not available during combat.')
  ask('judy', sample({dialogue = true})); assert(holocall.call == nil and lastNotice().text == 'Calls are not available right now.')
  game.begin = 'quest-call'; ask('judy'); assert(holocall.call == nil and lastNotice().id == 'holocall-refused' and lastNotice().text == 'You are already on a call.')
  game.begin = 'calling-disabled'; ask('judy'); assert(holocall.call == nil and logged('refused contact=judy reason=calling%-disabled'))
  game.begin = 'ok'; enabled['judy-alvarez'] = false; ask('judy')
  assert(holocall.call == nil and lastNotice().text == 'Conversations are disabled for this contact.')
  assert(game.ends == 0 and #warmed == 0)
`));

test('calling the same character again hangs up; a load forgets the call without native calls', () => run(`
  game.requests = {'judy'}; holocall.drain(player); tick(2); assert(holocall.connected())
  game.requests = {'judy'}; holocall.drain(player); tick(0.1)
  assert(holocall.call == nil and ended[1] == 'judy:replaced' and game.ends == 1)
  game.requests = {'judy'}; holocall.drain(player); tick(2); assert(holocall.connected())
  holocall.abandon('save restored')
  assert(holocall.call == nil and game.ends == 1 and holocall.sweepDue == true and logged('reason=save restored'))
  -- The HUD lost before connecting ends the call.
  game.requests = {'judy'}; holocall.drain(player); game.window = 'ended'; tick(2)
  assert(holocall.call == nil and ended[#ended] == 'judy:hud-lost' and logged('reason=hud%-lost'))
`));

test('the experimental live picture places a held copy and a switched-on camera, and falls back to the portrait', () => run(`
  local created, deleted, toggles, played = {}, {}, {}, {}
  local entities = {}
  local function entity(id, name)
    local e = {id = id, name = name, attached = true, position = {x = 10, y = 20, z = 70}}
    function e:GetEntityID() return {hash = id} end
    function e:IsAttached() return self.attached end
    function e:GetWorldPosition() return self.position end
    function e:ConvaiFaceRequest() self.face = true; return 'managed' end
    function e:FindComponentByName() return {Toggle = function(_, on) toggles[#toggles + 1] = name .. ':' .. tostring(on) end} end
    return e
  end
  local dynamic = {}
  function dynamic:IsReady() return true end
  function dynamic:CreateEntity(spec) local id = tostring(9000 + #created) .. 'ULL'; created[#created + 1] = spec
    entities[id] = entity(id, spec.recordID and 'copy' or 'camera'); return {hash = id, id = id} end
  function dynamic:IsSpawned(id) return entities[id.id] ~= nil end
  function dynamic:IsManaged() return true end
  function dynamic:IsTagged() return true end
  function dynamic:DeleteEntity(id) deleted[#deleted + 1] = id.id end
  function dynamic:GetTaggedIDs() return {} end
  Game = {GetDynamicEntitySystem = function() return dynamic end, FindEntityByID = function(id) return entities[id.id] end}
  CName = {new = function(v) return v end}
  NewObject = function() return {} end
  TweakDBID = {new = function(v) return v end}
  Vector4 = {new = function(x, y, z) return {x = x, y = y, z = z} end}
  EulerAngles = {new = function(r, p, y) return {ToQuat = function() return {yaw = y} end} end}
  function player:GetWorldPosition() return {x = 10, y = 20, z = 30} end
  dofile = function(path)
    if path == 'gesture-catalog.lua' then return {device = 'device.ent', families = {on_sides = {component = 'talk_on_sides'},
      judy_own = {component = 'convai_talk_judy'}}, characters = {['Character.Judy'] = {talk = 'judy_own', rig = 'woman_base'}}} end
    if path == 'gesture-workspot.lua' then return {
      spawnDevice = function() return true, {id = 'device'} end, deviceEntity = function() return {} end,
      play = function(_, npc, component) played[#played + 1] = component; return true end,
      exit = function() end, deleteDevice = function() end} end
    error('unexpected ' .. path)
  end
  live = true
  game.window = 'holocall'
  game.requests = {'judy'}; holocall.drain(player); tick(0.1)
  assert(logged('mode=holo') and #created == 2, 'a copy and a camera are created')
  local copy, camera = created[1], created[2]
  assert(copy.recordID == 'Character.Judy' and copy.position.z == 70 and copy.persistState == false and copy.persistSpawn == false)
  assert(copy.tags[1] == 'CyberpunkConvaiCompanion' and copy.tags[2] == 'CyberpunkConvaiHolocall')
  assert(camera.templatePath == 'base\\\\cinematics\\\\cameras\\\\holocall_camera.ent' and camera.tags[1] == 'CyberpunkConvaiHolocall')
  assert(math.abs(camera.position.y - 20.9) < 1e-6 and math.abs(camera.position.z - 71.62) < 1e-6 and camera.orientation.yaw == 180 and copy.orientation.yaw == 0)
  tick(2)
  assert(played[1] == 'convai_talk_judy' and toggles[1] == 'camera:true' and logged('holo ready contact=judy held=yes camera=on'))
  assert(holocall.connected() and game.connects[#game.connects] == true and logged('state=connected contact=judy mode=holo window=holocall'))
  local caller = holocall.partner(player, false)
  assert(caller.entity == '9000ULL' and caller.voiceOnly == nil and caller.holocall.mode == 'holo' and caller.npc.face)
  assert(holocall.partnerValid({entity = '9000ULL', holocall = {contact = 'judy', mode = 'holo'}}))
  -- The copy falls: the call goes on with the portrait.
  entities['9000ULL'].position = {x = 10, y = 20, z = 60}
  game.window = 'audiocall'; tick(0.3)
  assert(holocall.connected() and holocall.call.mode == 'audio' and game.connects[#game.connects] == false)
  assert(logged('holo failed contact=judy reason=copy%-lost fallback=audio') and lastNotice().id == 'holocall-live-fallback')
  assert(#deleted == 2 and toggles[#toggles] == 'camera:false', 'the copy and the camera are removed')
  assert(holocall.partner(player, false).entity == '7ULL')
  holocall.finish(player, 'hangup')
  -- No catalogue talk pose: the portrait from the start.
  dofile = function(path) if path == 'gesture-workspot.lua' then return false end; return {families = {}} end
  holocall.workspot = nil
  game.requests = {'judy'}; holocall.drain(player); tick(2)
  assert(holocall.connected() and holocall.call.mode == 'audio' and logged('reason=no%-talk%-pose'))
`));

test('callable contacts are registered once per world, again after a load, and retried while the native side is missing', () => run(`
  game.requests = {}
  holocall.drain(player); holocall.drain(player)
  assert(game.registered and #game.registered == 1 and game.registered[1] == 'judy')
  game.registered = nil; holocall.drain(player)
  assert(game.registered == nil, 'registered once per world: no repeated native calls')
  holocall.abandon('save restored'); holocall.drain(player)
  assert(game.registered and game.registered[1] == 'judy', 'a load registers again on the new player')
  -- Staged Lua before the native script is installed: the calls fail, nothing breaks, and the drain retries.
  local bare = {ConvaiHolocallTakeRequest = function() return '' end}
  holocall.abandon('reload'); holocall.drain(bare); assert(holocall.registered == nil)
  holocall.drain(player); assert(holocall.registered == true)
`));
