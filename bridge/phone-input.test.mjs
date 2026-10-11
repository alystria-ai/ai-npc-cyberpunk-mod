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
  assert.match(init, /local speedAtOpen = playerSpeedText\(player\)\s+if not player:ConvaiOpenComposer\(name\) then/);
  assert.match(init, /log\('Composer opened: generation=' \.\. generation \.\. ' actor=' \.\. identity \.\. ' name=' \.\. name\s+\.\. ' speed=' \.\. speedAtOpen\)/);
  assert.match(init, /phoneChat\.typingOpened = function\(player, contact\)\s+log\('Phone chat typing opened: contact='/);
  // edge-triggered inside the existing 10 Hz phone tick, and only while a chat is open
  assert.match(chat, /if contact ~= '' then\s+local readable, value = pcall\(function\(\) return player:ConvaiPhoneChatTyping\(\) end\)/);
  assert.match(chat, /if typing and not M\.typingSeen and type\(M\.typingOpened\) == 'function'/);
  // no input-flush API is verifiable for the composer close path, so none may be called
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
