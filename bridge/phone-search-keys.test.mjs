import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Discord report of 31 Oct 2026: the Chat list's search keys (O and /) could clash with the mods that let V move while the phone is open. The keys are now live only on the
// Chat list itself with V not moving on foot, a click on the bar always works, and a text box never takes the keyboard while a movement key may be down
// (docs/PHONE_CHAT.md, "Search keys and a V who walks"). The game is not available offline: the Lua runs against fakes, the redscript is checked as text.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const text = name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/^﻿/, '');
const strip = source => source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
const search = strip(text('../r6/scripts/CyberpunkConvai/PhoneChatSearch.reds'));
const tabs = strip(text('../r6/scripts/CyberpunkConvai/PhoneChatTabs.reds'));
const chatReds = strip(text('../r6/scripts/CyberpunkConvai/PhoneChat.reds'));
const initLua = text('../mod/init.lua');
const body = (source, signature) => {
  const at = source.indexOf(signature);
  assert.ok(at >= 0, 'missing: ' + signature);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  assert.fail('unbalanced: ' + signature);
};

function runLua(program) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}
const chatModule = `
  json = {decode = function(raw) return raw end, encode = function(v) return v end}
  io.open = function(path, mode) if mode == 'rb' then return nil end return {write = function() return true end, close = function() return true end} end
  os.rename, os.remove = function() return true end, function() return true end
  NewObject = function() return {} end
  os.time = function() return 100 end
  local chat = (function() ${text('../mod/phone-chat.lua')} end)()
`;

test('Lua: the foot-moving answer reaches the game only when it changes, false when the phone closes, and a script without the method is given up on once', () => runLua(`
  ${chatModule}
  local sent, moving = {}, false
  local player = {ConvaiPhoneChatFootMoving = function(_, value) sent[#sent + 1] = value end}
  chat.footMoving = function() return moving end
  chat.pushFootMoving(player, false)
  assert(#sent == 1 and sent[1] == false, 'a closed phone says not moving once')
  chat.pushFootMoving(player, false); assert(#sent == 1)
  chat.pushFootMoving(player, true); assert(#sent == 1, 'open and still: nothing new')
  moving = true
  chat.pushFootMoving(player, true); assert(#sent == 2 and sent[2] == true)
  for _ = 1, 20 do chat.pushFootMoving(player, true) end
  assert(#sent == 2, 'a steady answer costs one comparison')
  chat.pushFootMoving(player, false); assert(#sent == 3 and sent[3] == false, 'closing the phone clears it')
  moving = true
  chat.footMoving = function() error('the game would not say') end
  chat.pushFootMoving(player, true); assert(#sent == 3, 'an unreadable answer is not moving, and it was already false')
  local old, calls = {}, 0
  setmetatable(old, {__index = function() calls = calls + 1; error('no such method') end})
  chat.footMovingSent, chat.footMovingMissing = nil, nil
  chat.pushFootMoving(old, true); chat.pushFootMoving(old, true); chat.pushFootMoving(old, false)
  assert(chat.footMovingMissing == true and calls == 1, 'older scripts are asked once: ' .. calls)
`));

test('Lua: init.lua answers "moving on foot" with the talk gate reading, never in a vehicle, and a stale held axis with V standing does not count', () => {
  const at = initLua.indexOf('phoneChat.footMoving = function(player)');
  assert.ok(at > 0, 'init.lua sets phoneChat.footMoving');
  const end = initLua.indexOf('\nend\n', at) + 5;
  const source = initLua.slice(at, end).replace('phoneChat.footMoving =', 'footMoving =');
  runLua(`
    TALK_MOVING_SPEED = 0.35
    local busy, speed, car = nil, 0, nil
    talkBusy = function() return busy, speed end
    ${source.replace(/local /g, '')}
    local player = {GetMountedVehicle = function() return car end}
    assert(footMoving(player) == false, 'standing')
    busy, speed = 'axis', 2.5; assert(footMoving(player) == true, 'a key held and V moving')
    busy, speed = 'axis', 0.0; assert(footMoving(player) == false, 'a stale held reading with V standing')
    busy, speed = 'axis', nil; assert(footMoving(player) == false, 'speed unknown')
    busy, speed = 'moving', 1.2; assert(footMoving(player) == true, 'still moving after the release')
    car = {}; assert(footMoving(player) == false, 'in a vehicle')
  `);
});

test('redscript: O and / start the search only on the Chat list itself, on the screen, with V not moving on foot', () => {
  const key = body(search, 'private final func ConvaiSearchKey(key: EInputKey) -> Bool');
  assert.match(key, /IK_O\) \|\| Equals\(key, EInputKey\.IK_Slash\) \{\s*[^]*?if !this\.ConvaiSearchKeysLive\(\) \{ return false; \};\s*this\.ConvaiSearchOpen\(\);/);
  const live = body(search, 'private final func ConvaiSearchKeysLive() -> Bool');
  assert.match(live, /NotEquals\(this\.m_convaiChatState, ConvaiPhoneChatState\.List\)/, 'the Chat list is the phone\'s state');
  assert.match(live, /!this\.ConvaiSearchOnScreen\(\)/, 'the list is shown, no menu over it');
  assert.match(live, /return !this\.m_player\.ConvaiPhoneChatIsFootMoving\(\);/, 'V is not moving on foot');
  // A pad has none of this: ConvaiSearchOpen keeps its keyboard test.
  assert.match(body(search, 'private final func ConvaiSearchOpen() -> Void'), /!this\.m_player\.PlayerLastUsedKBM\(\)/);
});

test('redscript: the key callbacks only watch, nothing is consumed and no movement or other key is swallowed outside typing', () => {
  const callback = body(tabs, 'private cb func OnConvaiChatListKey(evt: ref<KeyInputEvent>) -> Void');
  assert.doesNotMatch(callback, /Consume|\.Handle\(|DontSendReleaseEvent/, 'an observer never consumes');
  assert.doesNotMatch(body(search, 'private final func ConvaiSearchKey(key: EInputKey) -> Bool'), /Consume|\.Handle\(|DontSendReleaseEvent/);
  // The only swallowing is while the box has the keyboard, and a release other than the phone's own click actions passes (a key that was down when typing began).
  const swallows = body(search, 'private final func ConvaiSearchSwallows(action: ListenerAction) -> Bool');
  assert.match(swallows, /if !this\.ConvaiSearchTyping\(\) \{ return false; \};/);
  assert.doesNotMatch(swallows, /Move|walk|Forward|Back"|sprint|jump/i, 'no movement action is named');
  const chat = body(chatReds, 'private final func ConvaiChatSwallowsAction(action: ListenerAction) -> Bool');
  assert.match(chat, /if !ListenerAction\.IsButtonJustReleased\(action\) \{ return true; \};/);
  assert.doesNotMatch(chat, /Move|walk|Forward|sprint|jump/i);
});

test('redscript: a click on the bar always opens the search, and with V moving the box takes the keyboard a moment later, when the keys are up', () => {
  const open = body(search, 'private final func ConvaiSearchOpen() -> Void');
  assert.ok(open.indexOf('ConvaiPhoneChatIsFootMoving') > open.indexOf('ConvaiSearchRowShow(true)'), 'the movement test comes after the row is open');
  assert.match(open, /ConvaiSearchRowShow\(true\)[^]*?ConvaiSearchRowLook\(true[^]*?if this\.m_player\.ConvaiPhoneChatIsFootMoving\(\) \{\s*this\.m_convaiSearchWantFocus = true;[^]*?return;\s*\};\s*this\.m_convaiSearchWantFocus = false;\s*this\.ConvaiSearchBoxFocus\(true\);/);
  assert.match(search, /public class ConvaiSearchOpenEvent extends Event/);
  assert.match(search, /private cb func OnConvaiSearchOpenEvent\(evt: ref<ConvaiSearchOpenEvent>\) -> Bool \{\s*this\.ConvaiSearchOpen\(\);/, 'the click is not gated by the key rule');
  const tick = body(search, 'public final func ConvaiSearchTick() -> Void');
  assert.match(tick, /if this\.m_convaiSearchWantFocus \{[^]*?if !this\.m_player\.ConvaiPhoneChatIsFootMoving\(\) \{\s*this\.m_convaiSearchWantFocus = false;[^]*?this\.ConvaiSearchBoxFocus\(true\);\s*\};\s*return;/);
  assert.ok(tick.indexOf('m_convaiSearchWantFocus') < tick.indexOf('m_convaiSearchIdle += 1'), 'waiting for the keys is not an idle search');
  assert.match(body(search, 'private final func ConvaiSearchEnd(rebuild: Bool, later: Bool) -> Void'), /m_convaiSearchWantFocus = false;/);
  assert.match(body(search, 'public final func ConvaiSearchReset() -> Void'), /m_convaiSearchWantFocus = false;/);
});

test('redscript: the chat box does not take the keyboard while V moves on foot, asks again on the tick, and Enter does not open it then', () => {
  const auto = body(chatReds, 'private final func ConvaiChatAutoFocus() -> Void');
  assert.match(auto, /if IsDefined\(player\) && player\.ConvaiPhoneChatIsFootMoving\(\) \{ return; \};\s*this\.m_convaiChatAutoFocus = false;/, 'the ask stays until it is given');
  assert.match(body(chatReds, 'public final func ConvaiChatAdvanceGuard() -> Void'), /if this\.m_convaiChatAutoFocus \{ this\.ConvaiChatAutoFocus\(\); \};/);
  const key = body(chatReds, 'private cb func OnConvaiChatKey(evt: ref<KeyInputEvent>) -> Void');
  assert.match(key, /mover\.ConvaiPhoneChatIsFootMoving\(\) \{ return; \};\s*\/\/ Set focus|mover\.ConvaiPhoneChatIsFootMoving\(\) \{ return; \};\s*this\.m_convaiChatEscape = true;/);
  // The flag exists on the player and the Lua tick pushes it before the redscript tick runs.
  assert.match(search, /public final func ConvaiPhoneChatFootMoving\(moving: Bool\) -> Void/);
  assert.match(search, /public final func ConvaiPhoneChatIsFootMoving\(\) -> Bool/);
  const lua = text('../mod/phone-chat.lua');
  assert.ok(lua.indexOf('M.pushFootMoving(player, phoneOpen)') < lua.indexOf('player:ConvaiPhoneChatTick()'));
});

test('redscript: no new per-frame work, no new input registration, and only calls the scripts already use', () => {
  for (const source of [search, chatReds]) assert.doesNotMatch(source, /OnUpdate|DelaySystem|RegisterInputListener\(/);
  assert.doesNotMatch(search, /GetVelocity|IsMountedToVehicle|Length2D/, 'the movement reading is Lua\'s, so no new game call can break the compile');
  // The search file still holds no Input/Key registration of its own.
  assert.doesNotMatch(search, /Input\/Key/);
});
