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
  // Only the phone button's hold during the mod's own call is kept from the game (it would open the phone on its menu
  // after hanging up); it hangs up. Every other action reaches the game's handler.
  const consumed = [...onAction.matchAll(/ListenerActionConsumer\.Consume\(consumer\);/g)];
  assert.equal(consumed.length, 1, 'one consumed action');
  assert.match(onAction, /if Equals\(type, gameinputActionType\.BUTTON_HOLD_COMPLETE\) \{\s*this\.m_convaiCallHeld = true;\s*this\.m_player\.ConvaiHolocallEvent\("hangup"\);\s*ListenerActionConsumer\.Consume\(consumer\);\s*return true;/);
  assert.match(onAction, /^\s*if this\.m_convaiCallActive && !this\.m_convaiCallPreempted && IsDefined\(this\.m_player\)\s*&& !IsDefined\(this\.m_contactListLogicController\) \{\s*let name[^]*?if Equals\(name, n"PhoneInteract"\)/);
  // The live picture's black backing sits behind the window's holocall image only while the mod's holocall shows, and
  // goes when the call ends or a game call takes the window.
  assert.match(code, /ConvaiHolocallBacking\(Equals\(this\.m_convaiCallWanted, EHudPhoneFunction\.Holocall\)\);\s*this\.m_holoAudioCallLogicController\.Show\(\);/);
  assert.match(code, /public final func ConvaiCallEnd\(\) -> Void \{[^]*?ConvaiHolocallBacking\(false\);[^]*?ShowEndCallContact/);
  assert.match(onPhoneCall, /this\.m_convaiCallPreempted = true;[^]*ConvaiHolocallBacking\(false\)/);
  assert.match(code, /rect\.Reparent\(parent, index\);/);
  assert.match(code, /public final func ConvaiHolocallHasBacking\(\) -> Bool \{\s*return true;/);
  // A call never starts while the game has one or blocks calls.
  assert.match(code, /if this\.ConvaiCallGameBusy\(\) \{ return "quest-call"; \};/);
  assert.match(code, /IsCallingEnabled\(\)/);
  // Only a contact registered for the Chat tab (the mod's own characters) can be called; Lua refuses Johnny and the rest.
  assert.match(code, /!this\.ConvaiPhoneChatHasContact\(contact\)/);
});

test('the game\'s own phone is untouched; a holocall starts only from the mod\'s Chat tab', () => {
  const all = ['Holocall', 'PhoneChat', 'PhoneChatTabs', 'PhoneContacts'].map(name => read('../r6/scripts/CyberpunkConvai/' + name + '.reds'))
    .join('\n').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  // No wrap or replacement of any of the game's call functions: the Contacts Call action ends in the game's own code.
  assert.doesNotMatch(all, /(?:wrapMethod|replaceMethod)\([^)]*\)\s*\n(?:public|protected|private) (?:cb )?func (CallSelectedContact|CallContact|TryCallContact)\b/);
  assert.ok(!/func CallSelectedContact|func TryCallContact|func CallContact/.test(all), 'a game call function is redefined');
  // The Chat-tab wraps of the shared phone functions act only while the Chat tab is showing (state not Off) or the open
  // popup is a mod chat, and otherwise reach the game's function.
  const tabs = read('../r6/scripts/CyberpunkConvai/PhoneChatTabs.reds');
  // R (the secondary action) opens the chat on the list, as it always did; it never calls.
  assert.match(tabs, /public func AlternativeAcceptAction\(\) -> Void \{\s*if NotEquals\(this\.m_convaiChatState, ConvaiPhoneChatState\.Off\) \{\s*this\.ConvaiOpenChat[^]*?wrappedMethod\(\);\s*\}/);
  // The call has its own key on the list: the game's `call` action (V, Triangle), listened for with the list's inputs
  // and acted on only on the Chat list; Triangle's showAll means nothing there and is swallowed.
  assert.match(tabs, /public func EnableContactsInput\(\) -> Void \{\s*wrappedMethod\(\);\s*if IsDefined\(this\.m_player\) \{ this\.m_player\.RegisterInputListener\(this, n"call"\); \};/);
  assert.match(tabs, /public func DisableContactsInput\(\) -> Void \{\s*if IsDefined\(this\.m_player\) \{ this\.m_player\.UnregisterInputListener\(this, n"call"\); \};\s*wrappedMethod\(\);/);
  assert.match(tabs, /if Equals\(this\.m_convaiChatState, ConvaiPhoneChatState\.List\) \{[^]*?Equals\(name, n"call"\)[^]*?ConvaiChatListHolocall\([^;]*\);[^]*?Equals\(name, n"showAll"\)/);
  // The game's own hints are rebound to `call` on Chat rows and bottom bar only, and put back from what they showed.
  assert.match(tabs, /ConvaiHintBinding\.Rebind\(inkWidgetRef\.Get\(this\.m_action2ButtonWidget\), n"call"\)/);
  assert.match(tabs, /ConvaiHintBinding\.Rebind\(inkWidgetRef\.Get\(this\.m_action2ButtonWidget\), this\.m_convaiCallHintAction\)/);
  assert.match(tabs, /ConvaiHintBinding\.Rebind\(inkWidgetRef\.Get\(this\.m_callInputHint\), n"call"\)/);
  assert.match(tabs, /ConvaiHintBinding\.Rebind\(inkWidgetRef\.Get\(this\.m_callInputHint\), this\.m_convaiCallHintAction\)/);
  assert.match(tabs, /SetLocalizedTextScript\(this\.m_action2ButtonLabel, "LocKey#22196"\);\s*inkWidgetRef\.SetVisible\(this\.m_action2ButtonWidget, true\);/);
  // The row's chat hint (the envelope) shows the key the bottom bar's Chat hint shows (`proceed`: F, Enter, Cross), and
  // goes back to the game's action on any other row.
  assert.match(tabs, /ConvaiHintBinding\.Rebind\(inkWidgetRef\.Get\(this\.m_chatInputHint\), n"proceed"\)/);
  assert.match(tabs, /ConvaiHintBinding\.Rebind\(inkWidgetRef\.Get\(this\.m_chatInputHint\), this\.m_convaiChatHintAction\)/);
  // F opens the chat on the list: its `click` reaches AcceptAction, which opens the chat while the Chat tab shows.
  assert.match(tabs, /public func AcceptAction\(\) -> Void \{\s*if NotEquals\(this\.m_convaiChatState, ConvaiPhoneChatState\.Off\) \{\s*this\.ConvaiOpenChat/);
  // The row shows both icons: call and chat (the envelope), with the separator.
  assert.match(tabs, /SetVisible\(this\.m_callInputHint, true\);\s*inkWidgetRef\.SetVisible\(this\.m_chatInputHint, true\);\s*inkWidgetRef\.SetVisible\(this\.m_separtor, true\);/);
  // The conversation shows no Call hint (the user's live test: it spoiled the composer layout); the game's own hint
  // stays hidden too. The Call key still starts the call while the chat has focus.
  const chat = read('../r6/scripts/CyberpunkConvai/PhoneChat.reds');
  assert.match(chat, /inkWidgetRef\.SetVisible\(this\.m_hintCall, false\);/);
  assert.doesNotMatch(chat, /inputDisplayLabelFlex|ConvaiChatCallHint|OnConvaiChatCallClick|"V  Call"/);
  assert.match(chat, /Equals\(ListenerAction\.GetName\(action\), n"call"\) && this\.m_isFocused\s*&& Equals\(ListenerAction\.GetType\(action\), gameinputActionType\.BUTTON_PRESSED\) \{\s*this\.ConvaiChatHolocall\(\);\s*\};\s*ListenerActionConsumer\.Consume\(consumer\);\s*return false;/);
  // Typing swallows the key first: a V typed into the message never calls.
  assert.match(chat, /if this\.ConvaiChatTyping\(\) \{\s*if this\.ConvaiChatSwallowsAction\(action\)/);
  // The message box has no placeholder text.
  assert.match(chat, /input\.SetDefaultText\(""\);/);
  assert.doesNotMatch(chat, /Write a message/);
  // Both entry points end in the one request, which refuses anything that is not a Chat contact.
  const code = read('../r6/scripts/CyberpunkConvai/Holocall.reds');
  assert.match(code, /public final func ConvaiChatHolocall\(\) -> Void \{[^]*?player\.ConvaiHolocallRequest\(this\.m_contactEntry\.GetId\(\)\);/);
  assert.match(code, /public final func ConvaiChatListHolocall\(contact: wref<ContactData>\) -> Void \{[^]*?this\.m_player\.ConvaiHolocallRequest\(contact\.id\);/);
});

test('the live picture setting is a Conversations setting, not a developer one', () => {
  const mcm = read('../mod/manager-ui.lua');
  const conversations = mcm.slice(mcm.indexOf("category('conversation-controls'"), mcm.indexOf("category('companion-behavior'"));
  const development = mcm.slice(mcm.indexOf("category('development'"), mcm.indexOf("category('help', 'Help'"));
  assert.match(conversations, /setting\('holocallLiveImage', 'Live holocall picture'/);
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
function player:ConvaiHolocallHasBacking() if game.noBacking then error('no such method') end return true end
local enabled, busy, live = {['judy-alvarez'] = true, ['johnny-silverhand'] = true}, false, false
-- The bridge's readiness of each character's conversation (nil: every one is ready).
local readyKeys = nil
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
  ready = function(key) return readyKeys == nil or readyKeys[key] == true end,
  onConnected = function(call) connected[#connected + 1] = call.contact end,
  onEnded = function(call, reason) ended[#ended + 1] = call.contact .. ':' .. reason end,
})
holocall.sweepDue = false
-- The scenarios below film her on far studios too (a roof 20 m above V, ground 10 m down) to cover the whole search; the
-- default (no far picture, the portrait instead) has its own test.
holocall.FAR_PICTURE = true
`;

test('idle costs nothing, and a phone request rings, connects as a voice call and routes the talk keys to the caller', () => run(`
  holocall.update(player, 0.1, true, open)
  assert(holocall.call == nil and game.began == nil)
  game.requests = {'judy'}
  holocall.drain(player)
  assert(holocall.request and holocall.request.contact == 'judy' and logged('requested contact=judy'))
  -- Nothing starts while the world is not playable (the phone is still open).
  holocall.update(player, 0.1, false, open)
  assert(holocall.call == nil and holocall.request)
  holocall.update(player, 0.1, true, open)
  assert(game.began == 'judy' and holocall.call.state == 'dialing')
  assert(warmed[1] == 'judy-alvarez@7ULL', 'the connection warms while the call rings')
  assert(logged('state=dialing contact=judy profile=judy%-alvarez mode=audio cast=video hud=ok'))
  assert(holocall.partner(player, false) == nil, 'nobody answers before the call connects')
  tick(1.6)
  assert(holocall.connected() and game.connects[1] == false)
  assert(logged('state=connected contact=judy mode=audio window=audiocall'))
  assert(#notices == 0, 'a connected call shows no notice: its window is the cue')
  assert(connected[1] == 'judy')
  -- 20 m away her face would not move: no face row for this studio.
  assert(holocall.faceRow() == nil)
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
  assert(#notices == 0, 'V hanging up shows no notice')
  assert(not holocall.partnerValid({entity = '7ULL', holocall = {contact = 'judy', mode = 'audio'}}))
  call(); game.events = {'quest-call'}; tick(0.3)
  assert(ended[2] == 'judy:quest-call' and #notices == 0, 'the game call shows its own window')
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

// A world for the live picture: V at (10, 20, 30) under a roof slab at z = 50 (x 0..20, y 10..30) when `roof` is set;
// raycasts hit the slab's plane inside its bounds (Static only). `ground` (a z) adds an unbounded floor plane and `wall`
// (an x) a wall plane that blocks any segment crossing it. Entities spawn at once; every native call is recorded.
const world = `
  local created, deleted, toggles, played, forced, looks, removed, lamps = {}, {}, {}, {}, {}, {}, {}, {}
  local entities, roof, ground, wall, lower, records = {}, true, nil, nil, nil, {['Character.Judy'] = true, ['Character.wat_lch_melee_01'] = true}
  local function entity(id, name, spec)
    local p = spec.position
    local e = {id = id, name = name, attached = true, position = {x = p.x, y = p.y, z = p.z}}
    function e:GetEntityID() return {hash = id, id = id} end
    function e:IsAttached() return self.attached end
    function e:GetWorldPosition() return self.position end
    function e:ConvaiFaceRequest() self.face = true; return 'managed' end
    function e:QueueEvent(event) looks[#looks + 1] = {npc = name, event = event}; return true end
    function e:FindComponentByName()
      e.component = e.component or {Toggle = function(self, on)
        toggles[#toggles + 1] = name .. ':' .. tostring(on); self.cutWhenOn = self.cutWhenOn or (on and self.depthCutDistance) end}
      return e.component
    end
    if name == 'lamp' then
      -- The game's corridor light: a mesh, a collider and a point light driven by its script API.
      local lamp = {id = id, mesh = true, collider = true, on = false}
      lamps[#lamps + 1] = lamp
      local function part(class, fields) fields.GetClassName = function() return class end; return fields end
      e.parts = {
        part('entMeshComponent', {Toggle = function(_, on) lamp.mesh = on end}),
        part('entColliderComponent', {Toggle = function(_, on) lamp.collider = on end}),
        part('gameLightComponent', {ToggleLight = function(_, on) lamp.on = on end, SetIntensity = function(_, v) lamp.lumen = v end,
          SetRadius = function(_, v) lamp.radius = v end, SetColor = function(_, c) lamp.color = c end,
          IsOn = function() return lamp.on end}),
      }
      function e:GetComponents() return self.parts end
    end
    return e
  end
  local dynamic = {}
  function dynamic:IsReady() return true end
  function dynamic:CreateEntity(spec) local id = tostring(9000 + #created) .. 'ULL'; created[#created + 1] = spec
    local kind = spec.recordID and 'copy' or (tostring(spec.templatePath):find('corridor_light', 1, true) and 'lamp' or 'camera')
    entities[id] = entity(id, kind, spec); return {hash = id, id = id} end
  function dynamic:IsSpawned(id) return entities[id.id] ~= nil end
  function dynamic:IsManaged() return true end
  function dynamic:IsTagged() return true end
  function dynamic:DeleteEntity(id) deleted[#deleted + 1] = id.id end
  function dynamic:GetTaggedIDs() return {} end
  local spatial = {rays = 0}
  function spatial:SyncRaycastByCollisionGroup(a, b, group)
    self.rays = self.rays + 1
    if group ~= 'Static' then return false, {} end
    local best
    local function consider(t, p) if t >= 0 and t <= 1 and (not best or t < best.t) then best = {t = t, position = p} end end
    local function horizontal(z, bounded)
      if (a.z - z) * (b.z - z) > 0 or a.z == b.z then return end
      local t = (a.z - z) / (a.z - b.z)
      local x, y = a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t
      if bounded and (x < 0 or x > 20 or y < 10 or y > 30) then return end
      consider(t, {x = x, y = y, z = z})
    end
    if roof then horizontal(50, true) end
    if ground then horizontal(ground, false) end
    if lower then horizontal(lower, false) end
    if wall and (a.x - wall) * (b.x - wall) < 0 then
      local t = (a.x - wall) / (a.x - b.x)
      consider(t, {x = wall, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t})
    end
    if not best then return false, {} end
    return true, {position = best.position}
  end
  local animation = {}
  function animation:SetForcedVisible(id, on) forced[#forced + 1] = id.id .. ':' .. tostring(on) end
  Game = {GetDynamicEntitySystem = function() return dynamic end, FindEntityByID = function(id) return entities[id.id] end,
    GetSpatialQueriesSystem = function() return spatial end, GetAnimationSystem = function() return animation end}
  TweakDB = {GetRecord = function(_, id) if records[id] then return {IsA = function(_, class) return class == 'gamedataCharacter_Record' end} end end}
  CName = {new = function(v) return v end}
  NameToString = function(v) return v end
  Color = {new = function(t) return t end}
  Enum = {new = function(_, v) return v end}
  NewObject = function() return {} end
  TweakDBID = {new = function(v) return v end}
  Vector4 = {new = function(x, y, z) return {x = x, y = y, z = z} end}
  EulerAngles = {new = function(r, p, y) return {ToQuat = function() return {yaw = y, pitch = p} end} end}
  LookAtAddEvent = {new = function() local e = {request = {limits = {}}}
    function e:SetEntityTarget(target, slot) self.target, self.slot = target, slot end
    function e:SetStyle(style) self.style = style end
    function e:SetAdditionalPartsArray(parts) self.parts = parts end
    return e end}
  LookAtPartRequest = {new = function() return {} end}
  LookAtRemoveEvent = {QueueRemoveLookatEvent = function(npc, event) removed[#removed + 1] = event end}
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
  local function near(a, b) return math.abs(a - b) < 1e-3 end
  live = true
`;

test('a staged character gets the live picture: a hidden floor above V, the copy held and animated there, and the game camera framing her', () => run(world + `
  game.window = 'holocall'
  game.requests = {'judy'}; holocall.drain(player); tick(0.1)
  assert(logged('state=dialing contact=judy profile=judy%-alvarez mode=holo cast=video hud=ok'))
  assert(#created == 0, 'nothing is spawned before a floor is found')
  -- The seventeen near columns (straight above or below V and two rings round V, a floor within 10 m of V's feet) find
  -- nothing first, three per step.
  tick(1.3)
  assert(#created == 0 and logged('state=dialing'), 'the near columns come first')
  tick(0.5)
  assert(#created == 5, 'a copy, a camera and three lamps are created once the floor above V is found')
  local copy, camera = created[1], created[2]
  -- The copy stands on the roof 20 m above V, out of V's sight, with her own record.
  assert(copy.recordID == 'Character.Judy' and near(copy.position.x, 10) and near(copy.position.y, 20) and near(copy.position.z, 50))
  assert(copy.persistState == false and copy.persistSpawn == false and copy.alwaysSpawned == true)
  -- Her body faces the camera squarely: the spot faces yaw 0 and the camera stands 20.4 degrees round it.
  assert(near(copy.orientation.yaw, 20.4), copy.orientation.yaw)
  assert(copy.tags[1] == 'CyberpunkConvaiCompanion' and copy.tags[2] == 'CyberpunkConvaiHolocall')
  -- The game's own holocall camera, at the game's framing: 0.79 m in front, 20.4 degrees round, 1.6 m up, level, looking back.
  assert(camera.templatePath == 'base\\\\cinematics\\\\cameras\\\\holocall_camera.ent' and camera.tags[1] == 'CyberpunkConvaiHolocall')
  assert(near(camera.position.x, 9.72362) and near(camera.position.y, 20.74317) and near(camera.position.z, 51.6), camera.position.x .. ' ' .. camera.position.y)
  assert(near(camera.orientation.yaw, 200.4) and camera.orientation.pitch == 0)
  assert(logged('holo spawn contact=judy record=Character.Judy floor=%+20.0m away=20.0m yaw=0 body=20.4 lens=0.79m'))
  -- The light rig, as the game lights its studio actor: a warm key in front and above on the camera's side, a weaker
  -- fill on the other side, a cool rim behind, all round her at the game's own lamp, tagged and transient.
  local key, fill, rim = created[3], created[4], created[5]
  for _, lamp in ipairs({key, fill, rim}) do
    assert(lamp.templatePath == 'base\\\\gameplay\\\\devices\\\\lighting\\\\residential\\\\corridor_light\\\\corridor_light_a.ent')
    assert(lamp.tags[1] == 'CyberpunkConvaiHolocall' and lamp.persistState == false and lamp.alwaysSpawned == true)
  end
  -- Yaw 0 faces +y; bearing 55 puts the key to her front left (x < 10), the fill front right, the rim behind (y < 20).
  assert(key.position.x < 10 and key.position.y > 20 and near(key.position.z, 52), key.position.x .. ' ' .. key.position.y)
  assert(fill.position.x > 10 and fill.position.y > 20 and near(fill.position.z, 51.45))
  assert(rim.position.y < 20 and near(rim.position.z, 52.05))
  tick(2)
  -- Each lamp is switched on with its role's settings, its fixture mesh and collider off; the key is strongest.
  assert(#lamps == 3)
  for _, lamp in ipairs(lamps) do assert(lamp.on and not lamp.mesh and not lamp.collider and lamp.radius == 2.5 and lamp.color.Alpha == 255) end
  assert(lamps[1].lumen > lamps[3].lumen and lamps[3].lumen > lamps[2].lumen, 'key, then rim, then fill')
  assert(logged('lights=3/3'))
  assert(forced[1] == '9000ULL:true', 'the copy keeps animating off screen')
  assert(played[1] == 'convai_talk_judy' and toggles[1] == 'camera:true')
  -- The black backdrop: before the camera is switched on, it is told to draw nothing beyond 0.9 m behind her (the
  -- window's black backing shows there).
  local lens = entities['9001ULL'].component
  assert(near(lens.cutWhenOn, 0.25 / math.tan(math.rad(17.5)) + 0.9), tostring(lens.cutWhenOn))
  assert(logged('backdrop=true'))
  -- She looks into the lens (the camera entity) as the game's holocall scenes aim their caller: eyes leading, the head
  -- and the chest turned with it (chest weight 2), nothing suppressed, at the game's holocall look speed.
  local look = looks[1]
  assert(look and look.npc == 'copy' and look.event.target.name == 'camera' and look.event.bodyPart == 'Eyes')
  assert(look.event.request.transitionSpeed == 80 and #look.event.parts == 2)
  assert(look.event.parts[1].partName == 'Head' and look.event.parts[1].weight == 0.3 and look.event.parts[1].suppress == 0)
  assert(look.event.parts[2].partName == 'Chest' and look.event.parts[2].weight == 2 and look.event.parts[2].suppress == 0)
  assert(logged('holo ready contact=judy held=yes camera=on animated=true look=true'))
  assert(holocall.connected() and game.connects[#game.connects] == true and logged('state=connected contact=judy mode=holo window=holocall'))
  local caller = holocall.partner(player, false)
  assert(caller.entity == '9000ULL' and caller.voiceOnly == nil and caller.holocall.mode == 'holo' and caller.npc.face)
  assert(holocall.partnerValid({entity = '9000ULL', holocall = {contact = 'judy', mode = 'holo'}}))
  -- The look is asked for again every few seconds, the old one retired first; a lamp the game switched off is relit then.
  local before = #looks
  lamps[2].on = false
  tick(5.1)
  assert(#looks == before + 1 and removed[#removed] == looks[before].event)
  assert(lamps[2].on, 'the rig is checked on the look beat')
  -- Hang up: look retired, animation released, camera off at once and deleted only after a delay, copy deleted.
  local rays = spatial.rays
  holocall.finish(player, 'hangup')
  assert(forced[#forced] == '9000ULL:false' and toggles[#toggles] == 'camera:false' and removed[#removed] == looks[#looks].event)
  -- The lamps go out and are deleted with the copy; the camera waits.
  for _, lamp in ipairs(lamps) do assert(not lamp.on) end
  assert(#deleted == 4 and deleted[1] == '9002ULL' and deleted[2] == '9003ULL' and deleted[3] == '9004ULL' and deleted[4] == '9000ULL')
  assert(holocall.lenses and #holocall.lenses == 1)
  tick(1.0); assert(#deleted == 4, 'the switched-off camera is not freed in the next frames')
  tick(0.6); assert(#deleted == 5 and deleted[5] == '9001ULL' and holocall.lenses == nil)
  tick(1); assert(spatial.rays == rays, 'nothing runs after the call')
`));

test('without the black backing in the window (an older Holocall.reds) the camera cuts nothing out of the picture', () => run(world + `
  game.window = 'holocall'; game.noBacking = true
  game.requests = {'judy'}; holocall.drain(player); tick(2.5)
  assert(holocall.connected() and holocall.call.mode == 'holo')
  local lens = entities['9001ULL'].component
  assert(lens.depthCutDistance == nil and lens.cutWhenOn == nil and logged('backdrop=false'))
  holocall.finish(player, 'hangup')
`));

test('the live picture falls back to the portrait when the copy moves, when there is no floor, and for an unknown record', () => run(world + `
  game.window = 'holocall'
  game.requests = {'judy'}; holocall.drain(player); tick(2.5)
  assert(holocall.connected() and holocall.call.mode == 'holo')
  -- The copy falls: the call goes on with the portrait.
  entities['9000ULL'].position = {x = 10, y = 20, z = 40}
  game.window = 'audiocall'; tick(0.3)
  assert(holocall.connected() and holocall.call.mode == 'audio' and game.connects[#game.connects] == false)
  assert(logged('holo failed contact=judy reason=copy%-lost fallback=audio') and lastNotice().id == 'holocall-live-fallback')
  assert(deleted[4] == '9000ULL' and toggles[#toggles] == 'camera:false' and forced[#forced] == '9000ULL:false')
  assert(deleted[1] == '9002ULL' and not lamps[1].on, 'the lamps go with the picture')
  assert(holocall.partner(player, false).entity == '7ULL')
  tick(2); assert(deleted[5] == '9001ULL', 'the camera is deleted after its delay, the call still on')
  holocall.finish(player, 'hangup')
  -- Open sky above, around and below V: nothing to stand on, so the portrait, after three candidates per tick (50
  -- columns), with the count of reasons in the log.
  roof = false; created = {}
  game.requests = {'judy'}; holocall.drain(player); tick(4.5)
  assert(#created == 0 and holocall.call.state == 'dialing', 'fifty candidates, three per tick')
  tick(0.9)
  assert(logged('reason=no%-studio%-spot %(no%-floor=50%)') and holocall.connected() and holocall.call.mode == 'audio')
  holocall.finish(player, 'hangup'); roof = true
  -- A record the game does not have: never spawned (it would crash), the portrait instead.
  records['Character.Judy'] = nil
  game.requests = {'judy'}; holocall.drain(player); tick(2)
  assert(#created == 0 and logged('reason=record%-unavailable') and holocall.connected() and holocall.call.mode == 'audio')
  holocall.finish(player, 'hangup'); records['Character.Judy'] = true
  -- No catalogue talk pose: the portrait.
  dofile = function(path) if path == 'gesture-workspot.lua' then return false end; return {families = {}} end
  holocall.workspot, holocall.gestures = nil, nil
  game.requests = {'judy'}; holocall.drain(player); tick(2.5)
  assert(holocall.connected() and holocall.call.mode == 'audio' and logged('reason=no%-talk%-pose'))
`));

test('with nothing above V (a high apartment) the copy is placed on the ground below, behind a wall out of V\'s sight', () => run(world + `
  game.window = 'holocall'
  -- No roof above; ground 10 m below V's feet level; a wall at x = 11 between V (x = 10) and everything east of it.
  roof = false; ground = 20; wall = 11
  game.requests = {'judy'}; holocall.drain(player); tick(0.3)
  assert(#created == 0, 'the near and the above columns find nothing; three candidates per tick')
  -- The near rings behind the wall have floor, but 11.2 and 12.8 m from V (5 and 8 m round, 10 m down): past FACE_RANGE,
  -- where the game stops animating a face, so they are skipped for the farther search.
  tick(2.5)
  assert(#created == 5, 'the first hidden ring column behind the wall gets the copy, the camera and the lamps')
  local copy = created[1]
  assert(copy.recordID == 'Character.Judy' and near(copy.position.x, 22) and near(copy.position.y, 20) and near(copy.position.z, 20), copy.position.x .. ' ' .. copy.position.z)
  assert(logged('holo spawn contact=judy record=Character.Judy floor=%-10.0m'))
  tick(2)
  assert(holocall.connected() and holocall.call.mode == 'holo' and game.connects[#game.connects] == true)
  -- A ring column in plain view of V is never used: without the wall every spot is seen.
  holocall.finish(player, 'hangup'); wall = nil; created = {}
  game.requests = {'judy'}; holocall.drain(player); tick(5.4)
  assert(#created == 0 and logged('no%-studio%-spot %(in%-view=41, no%-floor=9%)') and holocall.call.mode == 'audio')
  holocall.finish(player, 'hangup')
  -- A floor 5 m below V behind the wall: the near ring finds it 7.1 m from V, close enough for her face to move, and it
  -- is taken before any farther column is tried.
  ground = 25; wall = 11; created = {}
  game.requests = {'judy'}; holocall.drain(player); tick(0.8)
  assert(#created == 5, 'the near ring column behind the wall is used at once')
  copy = created[1]
  assert(near(copy.position.x, 14.61940) and near(copy.position.y, 21.91342) and near(copy.position.z, 25), copy.position.x .. ' ' .. copy.position.y)
  assert(logged('floor=%-5.0m away=7.1m'))
  -- Within the face range, the connected copy is a row of the face layer (the companions' idle face and emotions), one
  -- table for the call, and the face layer's ownership check knows her.
  assert(holocall.faceRow() == nil, 'no face row while the call rings')
  tick(2)
  local row = holocall.faceRow()
  assert(row and row.entity == entities[row.entity].id and row.npc == entities[row.entity] and row.profileKey == 'judy-alvarez' and row.name == 'Judy Alvarez')
  -- The call face mirrors her face in the world: the row carries nothing that would draw it stronger or reshape it.
  local keys = {}; for key in pairs(row) do keys[#keys + 1] = key end; table.sort(keys)
  assert(table.concat(keys, ',') == 'entity,name,npc,profileKey', 'face row fields: ' .. table.concat(keys, ','))
  assert(holocall.faceRow() == row and holocall.ownsFace(row.npc) and not holocall.ownsFace(player))
  holocall.finish(player, 'hangup')
  assert(holocall.faceRow() == nil and not holocall.ownsFace(row.npc), 'gone at the hang-up')
`));

test('on a terrace (V\'s own floor all round, in view) the storey under V\'s floor is tried, so her face is within range', () => run(world + `
  game.window = 'holocall'
  -- No roof; V stands on an open floor at z = 30 that runs everywhere (in view from V); a storey under it at z = 26.5.
  roof = false; ground = 30; lower = 26.5
  game.requests = {'judy'}; holocall.drain(player); tick(0.3)
  -- Straight below V: V's own floor (in view), then the floor under it, hidden by V's floor, 3.5 m from V.
  assert(#created == 5, 'the floor under V is used at once')
  local copy = created[1]
  assert(near(copy.position.x, 10) and near(copy.position.y, 20) and near(copy.position.z, 26.5), copy.position.x .. ' ' .. copy.position.z)
  assert(logged('floor=%-3.5m away=3.5m'))
  tick(2)
  assert(holocall.connected() and holocall.call.mode == 'holo' and holocall.faceRow() ~= nil, 'near enough for the face row')
  holocall.finish(player, 'hangup')
  -- Without the storey under V, each near column finds V's own floor (in view) and nothing under it (two candidates
  -- each), and the search goes on outward; a column's reason is the floor that was judged, not the empty rest.
  lower = nil; created = {}
  game.requests = {'judy'}; holocall.drain(player); tick(6.6)
  assert(#created == 0 and holocall.call.state == 'dialing', 'sixty-seven candidates, three per tick')
  tick(0.6)
  assert(#created == 0 and logged('no%-studio%-spot %(in%-view=41, no%-floor=9%)'), logs[#logs])
  holocall.finish(player, 'hangup')
`));

test('by default a studio past FACE_RANGE is not used: the call goes on with the portrait; a near floor still gets the picture', () => run(world + `
  holocall.FAR_PICTURE = false
  game.window = 'holocall'
  -- Only the roof 20 m above V: past FACE_RANGE, where her face would be still and coarse (live, 2026-10-18: a roof
  -- 84.5 m away). The seventeen near columns are tried (the roof is out of their range), nothing farther, nothing spawned.
  game.requests = {'judy'}; holocall.drain(player); tick(2)
  assert(#created == 0, 'nothing is spawned for a far roof')
  assert(logged('holo failed contact=judy reason=no%-studio%-spot %(no%-floor=17%) fallback=audio'), logs[#logs])
  assert(holocall.connected() and holocall.call.mode == 'audio' and game.connects[#game.connects] == false)
  assert(lastNotice().id == 'holocall-live-fallback')
  local caller = holocall.partner(player, false)
  assert(caller.npc == player and caller.voiceOnly == true and caller.holocall.mode == 'audio')
  holocall.finish(player, 'hangup')
  -- The terrace: the storey under V's floor, 3.5 m from V, is within range, so the picture is used as before.
  roof = false; ground = 30; lower = 26.5; created = {}
  game.requests = {'judy'}; holocall.drain(player); tick(2.4)
  assert(#created == 5 and logged('floor=%-3.5m away=3.5m'))
  assert(holocall.connected() and holocall.call.mode == 'holo' and holocall.faceRow() ~= nil)
  holocall.finish(player, 'hangup')
`));

test('the call rings until the caller\'s conversation is ready, then connects; after READY_MAX it connects anyway', () => run(world + `
  game.window = 'holocall'
  readyKeys = {}
  game.requests = {'judy'}; holocall.drain(player); tick(2.4)
  -- The picture is ready (the floor above V), but her conversation is not: still ringing, nothing answers.
  assert(#created == 5 and holocall.call.holo.ready and holocall.call.state == 'dialing' and not holocall.connected())
  assert(holocall.partner(player, false) == nil and holocall.faceRow() == nil)
  tick(3)
  assert(holocall.call.state == 'dialing', 'still ringing while she is not ready')
  readyKeys['judy-alvarez'] = true; tick(0.3)
  assert(holocall.connected() and holocall.call.mode == 'holo' and logged('state=connected contact=judy mode=holo window=holocall ready=yes ring='))
  holocall.finish(player, 'hangup')
  -- Never ready: the call connects at READY_MAX seconds of ringing, and says so.
  readyKeys = {}; logs = {}
  game.requests = {'judy'}; holocall.drain(player); tick(holocall.READY_MAX - 0.6)
  assert(holocall.call.state == 'dialing')
  tick(0.9)
  assert(holocall.connected() and logged('ready=timeout ring=1[78]%.%ds'), logs[#logs])
  holocall.finish(player, 'hangup')
  -- A hang-up while it rings ends it as usual.
  game.requests = {'judy'}; holocall.drain(player); tick(3)
  game.events = {'hangup'}; tick(0.3)
  assert(holocall.call == nil and logged('state=ended contact=judy reason=hangup'))
`));

test('a character the game has no holocall setup for gets the portrait voice call, as in the game, with nothing spawned', () => run(world + `
  holocall.catalog.trainer_fred = {contact = 'trainer_fred', key = 'judy-alvarez', name = 'Coach Fred', record = 'Character.wat_lch_melee_01'}
  game.requests = {'trainer_fred'}; holocall.drain(player); tick(2)
  assert(logged('state=dialing contact=trainer_fred profile=judy%-alvarez mode=audio cast=voice hud=ok'))
  assert(holocall.connected() and holocall.call.mode == 'audio' and game.connects[1] == false)
  assert(#created == 0 and spatial.rays == 0 and #notices == 0, 'no spawn, no search, no fallback notice')
  holocall.finish(player, 'hangup')
  -- With the setting off a staged character is a voice call too.
  live = false
  game.requests = {'judy'}; holocall.drain(player); tick(2)
  assert(logged('contact=judy profile=judy%-alvarez mode=audio cast=video') and #created == 0 and spatial.rays == 0)
  -- A load forgets a camera still waiting to be deleted (it died with the world).
  holocall.lenses = {{id = {id = 'x'}, wait = 1}}
  holocall.abandon('save restored')
  assert(holocall.lenses == nil and holocall.call == nil)
`));

test("the staged list names only the mod's own phone contacts with a character record, never Johnny, and no quest path is used", () => {
  const block = /M\.STAGED = \{([^]*?)\n\}/.exec(holocallSource)[1];
  const keys = [...block.matchAll(/(?:^|[\s,])(?:\['([^']+)'\]|([a-z0-9_]+)) = '/g)].map(m => m[1] || m[2]);
  assert.ok(keys.length >= 50, `${keys.length} staged contacts`);
  const rows = new Map(JSON.parse(read('../characters/phone-contacts.json')).map(row => [row.contact, row]));
  for (const key of keys) {
    const row = rows.get(key);
    assert.ok(row, `${key} is a phone contact`);
    assert.match(row.record || '', /^Character\./, `${key} has a character record`);
    assert.doesNotMatch(row.record + row.key + key, /johnny|silverhand/i);
  }
  const code = holocallSource.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  for (const forbidden of ['GetQuestsSystem', 'SetFact', 'PhoneSystem', 'Blackboard', 'questTriggerCallRequest', 'JournalManager']) {
    assert.ok(!code.includes(forbidden), `holocall.lua uses ${forbidden}`);
  }
  // Nothing per frame: the module is driven from the 0.1 s tick only while something is due, and the camera delete waits.
  const init = read('../mod/init.lua');
  assert.match(init, /if holocall and \(holocall\.call or holocall\.request or holocall\.lenses\) then/);
});
