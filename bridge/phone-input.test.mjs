import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const phoneInput = readFileSync(new URL('../mod/phone-input.lua', import.meta.url), 'utf8');
const phoneChatReds = readFileSync(new URL('../r6/scripts/CyberpunkConvai/PhoneChat.reds', import.meta.url), 'utf8');
const composerReds = readFileSync(new URL('../r6/scripts/CyberpunkConvai/Composer.reds', import.meta.url), 'utf8');
const phoneChatLua = readFileSync(new URL('../mod/phone-chat.lua', import.meta.url), 'utf8');
const initLua = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');

function runLua(program) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(program));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}
const normalize = text => text.replace(/\r\n/g, '\n');

// The in-game menu controller's two input callbacks, driven with fake game input.
const setup = `
local clock = 0
os.clock = function() return clock end
local typing, open = false, false
local player = {ConvaiPhoneChatTyping = function() return typing end, ConvaiPhoneIsOpen = function() return open end}
Game = {GetPlayer = function() return player end}
-- action = {name=, kind='press'|'release', keys={}}
ListenerAction = {
  IsAction = function(a, n) return a.name == n end,
  IsButtonJustReleased = function(a) return a.kind == 'release' end,
  GetKey = function(a) return a.keys or {} end}
ListenerActionConsumer = {Consume = function(c) c.consumed = true end}
local overrides = {}
Override = function(class, method, fn) overrides[class .. '.' .. method] = fn end
convaiPhoneInput = nil
local m = (function() ${phoneInput} end)()
m.install()
local onAction = overrides['gameuiInGameMenuGameController.OnAction']
local onPointer = overrides['gameuiInGameMenuGameController.OnHandleMenuInput']
local function state(isTyping, isOpen) typing, open = isTyping, isOpen; clock = clock + 1 end
-- Returns: consumed by us, reached the game's own handler
local function action(name, kind, keys)
  local consumer, reached = {}, false
  onAction({}, {name = name, kind = kind, keys = keys}, consumer, function() reached = true; return true end)
  return consumer.consumed == true, reached
end
local function pointer(name)
  local event = {name = name, handled = false, consumed = false}
  function event:IsAction(n) return self.name == n end
  function event:Handle() self.handled = true end
  function event:Consume() self.consumed = true end
  local reached = false
  onPointer({}, event, function() reached = true; return true end)
  return event.handled and event.consumed, reached, event
end
`;

test('typing consumes every press but lets a movement key-up reach the game', () => runLua(setup + `
state(true, false)
for _, name in ipairs({'Right', 'MoveX', 'Forward', 'OpenPauseMenu', 'OpenJournalMenu', 'Sprint'}) do
  local consumed, reached = action(name, 'press')
  assert(consumed and not reached, name .. ' press must be consumed')
end
-- the key-up of a held movement key is not ours to swallow
for _, name in ipairs({'Right', 'MoveX', 'Forward', 'Back', 'Left', 'Sprint', 'Jump', 'Crouch'}) do
  local consumed, reached = action(name, 'release')
  assert(not consumed and reached, name .. ' release must reach the game')
end
`));

test('typing still swallows the key-up of every menu action so Esc and J do not open menus', () => runLua(setup + `
state(true, false)
for _, name in ipairs({'OpenPauseMenu', 'OpenMapMenu', 'OpenCraftingMenu', 'OpenJournalMenu', 'OpenPerksMenu',
    'OpenInventoryMenu', 'OpenHubMenu', 'QuickSave', 'QuickLoad', 'FastForward_Hold'}) do
  local consumed, reached = action(name, 'release')
  assert(consumed and not reached, name .. ' release must stay consumed while typing')
end
assert(m.blocked == 10)
`));

test('outside typing nothing is consumed, and an open phone keeps only the journal keys back', () => runLua(setup + `
state(false, false)
for _, kind in ipairs({'press', 'release'}) do
  local consumed, reached = action('OpenJournalMenu', kind)
  assert(not consumed and reached)
  consumed, reached = action('Right', kind); assert(not consumed and reached)
end
state(false, true)
for _, kind in ipairs({'press', 'release'}) do
  local consumed, reached = action('OpenJournalMenu', kind); assert(consumed and not reached)
  consumed, reached = action('Right', kind); assert(not consumed and reached)
  consumed, reached = action('Right', kind, {74}); assert(consumed and not reached)
  consumed, reached = action('Right', kind, {76}); assert(consumed and not reached)
end
`));

test('pointer key-ups: typing swallows only what the menu controller reacts to', () => runLua(setup + `
state(true, false)
for _, name in ipairs({'back', 'toggle_menu', 'toggle_inventory', 'toggle_perks', 'toggle_journal', 'toggle_map', 'toggle_crafting'}) do
  local swallowed, reached = pointer(name)
  assert(swallowed and not reached, name .. ' key-up must be swallowed while typing')
end
for _, name in ipairs({'right_button', 'navigate_right', 'MoveX', 'Right', 'click'}) do
  local swallowed, reached, event = pointer(name)
  assert(not swallowed and not event.handled and not event.consumed and not reached, name .. ' key-up must pass untouched')
end
state(false, true)
local swallowed, reached = pointer('toggle_journal'); assert(swallowed and not reached)
swallowed, reached = pointer('right_button'); assert(not swallowed and reached)
state(false, false)
swallowed, reached = pointer('toggle_journal'); assert(not swallowed and reached)
`));

test('a failing native query never blocks input', () => runLua(setup + `
player.ConvaiPhoneChatTyping = function() error('native not installed') end
player.ConvaiPhoneIsOpen = function() error('native not installed') end
state(false, false)
local consumed, reached = action('OpenPauseMenu', 'release'); assert(not consumed and reached)
local swallowed, pointerReached = pointer('toggle_journal'); assert(not swallowed and pointerReached)
`));

test('redscript phone popup consumes presses, passes plain key-ups, and keeps menu key-ups consumed', () => {
  const source = normalize(phoneChatReds);
  const onAction = source.slice(source.indexOf('protected cb func OnAction(action: ListenerAction'));
  const body = onAction.slice(0, onAction.indexOf('@wrapMethod(PhoneMessagePopupGameController)', 20));
  // the typing branch consumes only through the predicate, never unconditionally
  assert.match(body, /if this\.ConvaiChatTyping\(\) \{\s*if this\.ConvaiChatSwallowsAction\(action\) \{ ListenerActionConsumer\.Consume\(consumer\); \};\s*return false;/);
  const predicate = source.slice(source.indexOf('func ConvaiChatSwallowsAction'));
  const head = predicate.slice(0, predicate.indexOf('\n}\n'));
  assert.match(head, /if !ListenerAction\.IsButtonJustReleased\(action\) \{ return true; \};/);
  for (const name of ['OpenPauseMenu', 'cancel', 'phone_open_journal', 'click', 'call']) assert.ok(head.includes(`n"${name}"`), name);
  const pointer = source.slice(source.indexOf('protected cb func OnHandleMenuInput'));
  const pointerBody = pointer.slice(0, pointer.indexOf('\n}\n'));
  assert.match(pointerBody, /if this\.ConvaiChatSwallowsRelease\(evt\) \{ evt\.Handle\(\); evt\.Consume\(\); \};\s*return false;/);
  assert.doesNotMatch(pointerBody, /if this\.ConvaiChatTyping\(\) \{ evt\.Handle\(\); evt\.Consume\(\); return false; \};/);
  const release = source.slice(source.indexOf('func ConvaiChatSwallowsRelease'));
  const releaseHead = release.slice(0, release.indexOf('\n}\n'));
  for (const name of ['cancel', 'phone_open_journal', 'up_button', 'down_button', 'click']) {
    assert.ok(releaseHead.includes(`n"${name}"`), name);
  }
});

test('the talk box and phone typing log V speed once per opening, with no per-frame work', () => {
  const init = normalize(initLua), chat = normalize(phoneChatLua);
  assert.match(init, /local speedAtOpen = playerSpeedText\(player\)\s+local moveAtOpen = moveStateText\(player\)\s+if not player:ConvaiOpenComposer\(name\) then/);
  assert.match(init, /log\('Composer opened: generation=' \.\. generation \.\. ' actor=' \.\. identity \.\. ' name=' \.\. name\s+\.\. ' speed=' \.\. speedAtOpen \.\. ' moveAxis=' \.\. moveAtOpen/);
  assert.match(init, /phoneChat\.typingOpened = function\(player, contact\)\s+log\('Phone chat typing opened: contact='/);
  // edge-triggered inside the existing 10 Hz phone tick, and only while a chat is open
  assert.match(chat, /if contact ~= '' then\s+local readable, value = pcall\(function\(\) return player:ConvaiPhoneChatTyping\(\) end\)/);
  assert.match(chat, /if typing and not M\.typingSeen and type\(M\.typingOpened\) == 'function'/);
  // no input-flush API is verifiable for the composer close path, so none may be called: the fix avoids
  // opening the box while a movement key is down instead (see the movement tests below)
  assert.doesNotMatch(composerReds, /ReleaseAllInput|FakeReleaseButton|FakeInputRelease/);
});

test('speed text comes from the player velocity and degrades to n/a', () => {
  const source = normalize(initLua).match(/local function playerSpeedText\(player\)[\s\S]*?\nend\n/)[0];
  runLua(`
${source}
assert(playerSpeedText({GetVelocity = function() return {x = 3, y = 4, z = 9} end}) == '5.00')
assert(playerSpeedText({GetVelocity = function() return {x = 0, y = 0, z = 0} end}) == '0.00')
assert(playerSpeedText({GetVelocity = function() error('no such method') end}) == 'n/a')
assert(playerSpeedText({GetVelocity = function() return nil end}) == 'n/a')
assert(playerSpeedText({GetVelocity = function() return {} end}) == 'n/a')
`);
});

test('phone chat reports a typing session once, on its rising edge, and again after it ends', () => {
  const chat = normalize(phoneChatLua);
  const edge = chat.match(/-- One evidence hook per typing session[\s\S]*?M\.typingSeen = typing\n/)[0];
  runLua(`
local M = {}
local contact, typingNow, seen = 'judy', false, {}
local player = {ConvaiPhoneChatTyping = function() return typingNow end}
M.typingOpened = function(p, c) seen[#seen + 1] = c end
local function tick()
  local contact = contact
  ${edge}
end
tick(); assert(#seen == 0)
typingNow = true; tick(); tick(); tick(); assert(#seen == 1 and seen[1] == 'judy')
typingNow = false; tick(); typingNow = true; tick(); assert(#seen == 2)
contact = ''; tick(); typingNow = true; tick(); assert(#seen == 2, 'a closed chat never reports')
`);
});

test('redscript tracks only the MoveX and MoveY axes, from change events, with no per-frame work', () => {
  const source = normalize(composerReds);
  const watch = source.slice(source.indexOf('public class ConvaiMoveWatch'));
  const body = watch.slice(0, watch.indexOf('\n}\n'));
  assert.match(body, /protected cb func OnAction\(action: ListenerAction, consumer: ListenerActionConsumer\) -> Bool/);
  assert.match(body, /Equals\(name, n"MoveX"\)[\s\S]*this\.x = ListenerAction\.GetValue\(action\)/);
  assert.match(body, /Equals\(name, n"MoveY"\)[\s\S]*this\.y = ListenerAction\.GetValue\(action\)/);
  // the listener never swallows an input event
  assert.doesNotMatch(body, /Consume\(/);
  // exactly two named registrations; a nameless registration would see every input event
  const registrations = source.match(/RegisterInputListener\([^)]*\)/g);
  assert.deepEqual(registrations, ['RegisterInputListener(this.m_convaiMoveWatch, n"MoveX")',
    'RegisterInputListener(this.m_convaiMoveWatch, n"MoveY")']);
  assert.match(source, /@wrapMethod\(PlayerPuppet\)\s+protected cb func OnGameAttached\(\) -> Bool \{\s+let result: Bool = wrappedMethod\(\);\s+this\.ConvaiMoveWatchStart\(\);/);
  assert.match(source, /@wrapMethod\(PlayerPuppet\)\s+protected cb func OnDetach\(\) -> Bool \{\s+if IsDefined\(this\.m_convaiMoveWatch\) \{\s+this\.UnregisterInputListener\(this\.m_convaiMoveWatch\);/);
  // no timers, polling or update hooks
  assert.doesNotMatch(source, /DelayCallback|OnUpdate|Tick\(/);
});

// The Lua half: the talk key waits for a held movement axis and never drops the request.
const gateSource = () => {
  const text = normalize(initLua);
  const start = text.indexOf('local TALK_WAIT_MAX = 1.5');
  const end = text.indexOf('local function toggleVoice(groupMode, source, holdId, vadId, talkJohnny)');
  assert.ok(start > 0 && end > start);
  const code = text.slice(start, end);
  // beginTextNow itself needs the whole game adapter; the gate tests replace it with a recorder
  const open = code.indexOf('local function beginTextNow');
  const gate = code.indexOf('local function beginText(groupMode, talkJohnny)');
  assert.ok(open > 0 && gate > open);
  return {state: code.slice(0, open), gate: code.slice(gate)};
};

const gateHarness = (held, extra = '') => `
local logs = {}
local function log(line) logs[#logs + 1] = line end
local opened = {}
local held = ${held}
local forgotten = 0
local player = {ConvaiMoveHeld = function() return held end, ConvaiMoveForget = function() forgotten = forgotten + 1; held = false end}
Game = {GetPlayer = function() return player end}
${gateSource().state}
local function beginTextNow(groupMode, waited, talkJohnny) opened[#opened + 1] = {group = groupMode, waited = waited, johnny = talkJohnny} end
${gateSource().gate}
${extra}
`;

test('talk key opens at once when no movement axis is held, or the tracker is missing', () => {
  runLua(gateHarness('false', `
beginText(false)
assert(#opened == 1 and opened[1].group == false and opened[1].waited == nil)
assert(convaiTalkGate.waiting == nil)
player.ConvaiMoveHeld = nil
beginText(true)
assert(#opened == 2 and opened[2].group == true, 'missing redscript opens immediately')
player.ConvaiMoveHeld = function() error('no such method') end
beginText(false)
assert(#opened == 3, 'a failing query opens immediately')
`));
});

test('talk key waits for the held axis to be released, then opens once', () => {
  runLua(gateHarness('true', `
beginText(false)
assert(#opened == 0 and convaiTalkGate.waiting, 'held axis defers the box')
convaiTalkGate.update(0.1, true); convaiTalkGate.update(0.1, true)
assert(#opened == 0, 'still held and under the cap')
held = false
convaiTalkGate.update(0.016, true)
assert(#opened == 1 and opened[1].group == false)
assert(math.abs(opened[1].waited - 0.216) < 1e-9)
assert(convaiTalkGate.waiting == nil and forgotten == 0)
convaiTalkGate.update(0.016, true)
assert(#opened == 1, 'opens exactly once')
`));
});

test('talk key opens anyway at the cap, forgets the stuck reading, and the next press is not delayed', () => {
  runLua(gateHarness('true', `
beginText(true)
for i = 1, 14 do convaiTalkGate.update(0.1, true) end
assert(#opened == 0, '1.4 s is still waiting')
convaiTalkGate.update(0.1, true)
assert(#opened == 1 and opened[1].group == true and opened[1].waited >= 1.5)
assert(forgotten == 1 and convaiTalkGate.waiting == nil)
beginText(false)
assert(#opened == 2 and opened[2].waited == nil, 'forgotten reading does not delay the next press')
`));
});

test('a second press while waiting changes the chat asked for without restarting the wait', () => {
  runLua(gateHarness('true', `
beginText(false)
convaiTalkGate.update(0.9, true)
beginText(true)
assert(math.abs(convaiTalkGate.waiting.waited - 0.9) < 1e-9 and convaiTalkGate.waiting.group == true)
held = false
convaiTalkGate.update(0.01, true)
assert(#opened == 1 and opened[1].group == true)
local waits = 0
for _, line in ipairs(logs) do if line:find('waits for the movement keys', 1, true) then waits = waits + 1 end end
assert(waits == 1, 'one log line per wait')
`));
});

test('the Johnny text key waits like the others and stays the Johnny chat; a plain press while waiting asks for the plain chat', () => {
  runLua(gateHarness('true', `
beginText(false, true)
held = false
convaiTalkGate.update(0.01, true)
assert(#opened == 1 and opened[1].group == false and opened[1].johnny == true, 'opened as the Johnny chat')
held = true
beginText(false, true)
beginText(false)
held = false
convaiTalkGate.update(0.01, true)
assert(#opened == 2 and opened[2].johnny == nil, 'the last press decides')
beginText(false, true)
assert(#opened == 3 and opened[3].johnny == true and opened[3].waited == nil, 'no wait when the axes are free')
`));
});

test('a waiting request is dropped when the world stops being playable', () => {
  runLua(gateHarness('true', `
beginText(false)
convaiTalkGate.update(0.1, false)
assert(convaiTalkGate.waiting == nil)
held = false
convaiTalkGate.update(0.1, true)
assert(#opened == 0, 'nothing opens after the world paused')
`));
});

test('init.lua services the gate only while a request is waiting, and clears it with the session', () => {
  const init = normalize(initLua);
  assert.match(init, /local talkGate = convaiTalkGate\s+if talkGate and talkGate\.waiting then\s+local gateOk, gateError = pcall\(talkGate\.update, delta, worldReady\)/);
  assert.match(init, /pendingKnowledgeOwner = nil\s+if convaiTalkGate then convaiTalkGate\.waiting = nil end/);
  assert.match(init, /registerHotkey\('cyberpunk_convai_text'[^\n]*beginText\(false\)/);
  assert.match(init, /registerHotkey\('cyberpunk_convai_group_text'[^\n]*beginText\(true\)/);
});
