import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// The mod's own key bindings (docs/KEY_BINDINGS.md): mod/key-bindings.lua (the decision half, under fengari with a stand-in player and the actions it would run),
// its wiring in mod/init.lua, and the shape of r6/scripts/CyberpunkConvai/KeyBinds.reds (the listener half, read as text: redscript has no runner here; its
// compile is checked with scripts/Compile-Redscript.ps1 for both games).
const moduleSource = readFileSync(new URL('../mod/key-bindings.lua', import.meta.url), 'utf8');
const initSource = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const readSource = name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const managerUiSource = readSource('../mod/manager-ui.lua');
const redsSource = readSource('../r6/scripts/CyberpunkConvai/KeyBinds.reds').replace(/^\s*\/\/.*$/gm, ''); // comments are not code
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

function run(program) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const result = lauxlib.luaL_dostring(vm, to_luastring(program));
    const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(result, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
  } finally { lua.lua_close(vm); }
}

// One player with the methods KeyBinds.reds adds, the module over stand-ins for what init.lua gives it, and a clock the test moves.
const fixture = `
local clock = 100
local kb = (function() ${moduleSource} end)()
kb.clock = function() return clock end
local saved = {}
local runs, logs, results, observer = {}, {}, {}, nil
local flags = {typing = false, observerFails = false, saveFails = false, cet = nil, cetAvailable = false, file = nil, observable = true}
local player = {queue = {}, captured = {}, list = '', ready = true, absent = false, configures = {}, captures = {}, calls = {}, inEvent = false,
  listening = false, keys = nil}
local function called(name) player.calls[name] = (player.calls[name] or 0) + 1 end
-- Registering or unregistering a key listener from inside the game's own key event is what froze game 2.31 (25 Oct): the stand-in refuses it.
local function outsideEvent(name) if player.inEvent then error(name .. ' called from inside a key event') end end
function player:ConvaiKeyBindsReady() called('Ready'); return self.ready end
function player:ConvaiKeyBindsActive() called('Active'); if self.absent then error('no such method') end return self.list end
function player:ConvaiKeyBindsConfigure(list) called('Configure'); outsideEvent('ConvaiKeyBindsConfigure')
  assert(type(list) == 'string', 'ConvaiKeyBindsConfigure takes a String')
  self.configures[#self.configures + 1] = list
  if not self.ready then return false end
  self.list = list; return true end
-- KeyBinds.reds ConvaiKeyBindsCapture(keys: String): the keys to listen to, '' stops (CET refuses a boolean for a String parameter).
function player:ConvaiKeyBindsCapture(keys) called('Capture'); outsideEvent('ConvaiKeyBindsCapture')
  if type(keys) ~= 'string' then error('ConvaiKeyBindsCapture takes a String, got ' .. type(keys)) end
  self.captures[#self.captures + 1] = keys ~= ''
  self.captured, self.listening, self.keys = {}, keys ~= '', keys ~= '' and keys or self.keys
  if keys ~= '' then self.heard = 0 end
  return true end
-- KeyBinds.reds ConvaiKeyBindCaptureHeard: the key events the capture's listener was handed since the Set began.
function player:ConvaiKeyBindCaptureHeard() called('Heard'); return self.heard or 0 end
function player:ConvaiKeyBindTake() called('Take'); return table.remove(self.queue, 1) or '' end
-- KeyBinds.reds ConvaiKeyBindsObservable: whether the key events call into Lua as they happen (GameVariant.reds: 2.5 yes, 2.31 no).
function player:ConvaiKeyBindsObservable() called('Observable'); return flags.observable end
function player:ConvaiKeyBindCaptureTake() called('CaptureTake'); outsideEvent('ConvaiKeyBindCaptureTake'); return table.remove(self.captured, 1) or '' end
-- What the redscript does when a bound key goes down or up, and tells the observer (inside the game's key event; game 2.31 tells nobody).
function player:push(token)
  self.queue[#self.queue + 1] = token
  if observer and flags.observable then self.inEvent = true; local ok, err = pcall(observer, self); self.inEvent = false; if not ok then error(err) end end
end
-- A key going down while a Set waits: the capture queues it and calls nothing (Lua reads it on its tick). Only a listed key is heard.
function player:key(name)
  if not self.listening then return end
  local listed = false
  for listedName in (self.keys or ''):gmatch('[^,]+') do if listedName == name then listed = true; break end end
  if listed then self.captured[#self.captured + 1] = 'k' .. name; self.heard = (self.heard or 0) + 1 end
end
kb.deps = {
  bindings = function() return saved end,
  save = function(action, name)
    if flags.saveFails then return false, 'The settings could not be saved. Nothing was changed.' end
    saved[action] = name; return true end,
  voice = function(action, down) runs[#runs + 1] = action .. (down and ':down' or ':up') end,
  tap = function(action) runs[#runs + 1] = action end,
  typing = function() return flags.typing end,
  observe = function(fn) if flags.observerFails then error('no such function') end observer = fn end,
  boundKey = function(id) return flags.cet, flags.cetAvailable end,
  readFile = function(path) return flags.file end,
  changed = function(result) results[#results + 1] = result end,
  player = function() return player end,
  log = function(line) logs[#logs + 1] = line end,
}
local function tick(seconds, ready)
  clock = clock + (seconds or 0.1)
  kb.tick(player, ready ~= false)
end
local function runList() return table.concat(runs, ',') end
local function logged(text) for _, line in ipairs(logs) do if line:find(text, 1, true) then return true end end return false end
local function lastResult() return results[#results] end
`;

// ---- the key names ----------------------------------------------------------------------------------------------------------------------------
test('key names: the keyboard and the controller buttons a player may choose, and nothing that would be taken for a shortcut or a stick', () => run(fixture + `
  local function words(name) local kind, word = kb.describe(name); return (kind or 'none') .. ':' .. (word or '') end
  assert(words('IK_F7') == 'key:F7' and words('IK_F24') == 'key:F24' and words('IK_A') == 'key:A' and words('IK_7') == 'key:7')
  assert(words('IK_Space') == 'key:Space' and words('IK_PageUp') == 'key:Page up' and words('IK_Up') == 'key:Up arrow')
  assert(words('IK_NumPad5') == 'key:Num 5' and words('IK_NumPlus') == 'key:Num +' and words('IK_Semicolon') == 'key:;')
  assert(words('IK_Pad_LeftShoulder') == 'pad:LB' and words('IK_Pad_LeftThumb') == 'pad:L3' and words('IK_Pad_DigitUp') == 'pad:D-pad up')
  assert(words('IK_Pad_A_CROSS') == 'pad:A' and words('IK_Pad_Start') == 'pad:Menu' and words('IK_Pad_Back_Select') == 'pad:View')
  for _, name in ipairs({'IK_Shift', 'IK_LShift', 'IK_RShift', 'IK_Ctrl', 'IK_LControl', 'IK_RControl', 'IK_Alt', 'IK_LeftMouse', 'IK_RightMouse',
      'IK_MouseWheelUp', 'IK_Pad_LeftAxisX', 'IK_Pad_RightAxisY', 'IK_Escape', 'IK_Joy1', 'IK_Unknown5B', 'IK_None', 'IK_Last', 42, false}) do
    assert(kb.describe(name) == nil and not kb.valid(name), tostring(name) .. ' must not be offered')
  end
  assert(kb.valid('IK_F7') and kb.valid('IK_Pad_RightTrigger') and not kb.valid('F7'))
`));

test('the list the redscript takes: the five slots in order, - for none, and nothing at all when nothing is set', () => run(fixture + `
  assert(kb.list(nil) == '' and kb.list({}) == '')
  assert(kb.list({voice = 'IK_F7'}) == 'IK_F7,-,-,-,-')
  assert(kb.list({manager = 'IK_Pad_Start', text = 'IK_T', group_text = 'IK_Y', group_voice = 'IK_G', voice = 'IK_V'}) == 'IK_V,IK_T,IK_G,IK_Y,IK_Pad_Start')
  assert(kb.list({voice = 'not a key', text = 'IK_Escape'}) == '', 'a value that is not a key the player may choose is left out')
`));

test('Talk to Johnny: two more actions after the five, so the slots of an older list stay; the list grows only when one of them has a key', () => run(fixture + `
  assert(#kb.ACTIONS == 7 and kb.ACTIONS[6] == 'johnny_voice' and kb.ACTIONS[7] == 'johnny_text')
  assert(kb.CET_ID.johnny_voice == 'cyberpunk_convai_johnny_voice' and kb.CET_ID.johnny_text == 'cyberpunk_convai_johnny_text')
  assert(kb.HOLD.johnny_voice == true and kb.HOLD.johnny_text == nil and kb.HOLD.voice == true and kb.HOLD.text == nil)
  assert(kb.list({voice = 'IK_F7', johnny_voice = 'IK_J'}) == 'IK_F7,-,-,-,-,IK_J')
  assert(kb.list({johnny_text = 'IK_K'}) == '-,-,-,-,-,-,IK_K')
  assert(kb.list({voice = 'IK_F7', johnny_voice = 'IK_J', johnny_text = 'IK_K'}) == 'IK_F7,-,-,-,-,IK_J,IK_K')
  assert(kb.list({voice = 'IK_F7'}) == 'IK_F7,-,-,-,-', 'without a Johnny key the list is the one it always was')
  assert(kb.list({johnny_voice = 'not a key'}) == '')
`));

test('Talk to Johnny: the voice action is a hold (slot 6), the text action a tap (slot 7), and the CET line of both is read', () => run(fixture + `
  saved.johnny_voice, saved.johnny_text = 'IK_J', 'IK_K'
  tick()
  assert(player.list == '-,-,-,-,-,IK_J,IK_K', player.list)
  player:push('d6'); assert(runList() == 'johnny_voice:down')
  player:push('d6'); assert(runList() == 'johnny_voice:down', 'key repeat')
  player:push('u6'); assert(runList() == 'johnny_voice:down,johnny_voice:up')
  runs = {}
  player:push('d7'); assert(runList() == '', 'nothing on the press')
  clock = clock + 0.1; player:push('u7'); assert(runList() == 'johnny_text')
  local found = kb.decodeCet('{"AiNpcCyberpunkMod": {"cyberpunk_convai_johnny_voice": 33214047251857408, "cyberpunk_convai_johnny_text": 32932572275146752}}')
  assert(found.johnny_voice == 'F7' and found.johnny_text == 'F6')
  -- A key another action has is refused for them too.
  kb.beginCapture(player, 'johnny_text'); clock = clock + 0.5; player:key('IK_J'); tick()
  assert(results[#results].kind == 'duplicate' and results[#results].other == 'johnny_voice')
`));

// ---- Cyber Engine Tweaks' bindings.json --------------------------------------------------------------------------------------------------------
const slotsValue = (...codes) => codes.reduce((total, code, index) => total | (BigInt(code) << BigInt(48 - 16 * index)), 0n);

test('bindings.json: a stored number is four 16-bit slots, first key on top, read from the digits so a number above 2^53 keeps every bit', () => {
  const chord = slotsValue(0x75, 0x11, 0x4A, 0x12) + 0n;        // F6, Ctrl, J, Alt: every slot used, far above 2^53
  assert.ok(chord > 2n ** 53n);
  run(fixture + `
    local function codes(value) local list = kb.decodeBind(value) return list and table.concat(list, ',') or 'nil' end
    assert(codes('33214047251857408') == '118', 'F7 alone, from the real file')
    assert(codes('${chord}') == '117,17,74,18', 'four keys: ' .. codes('${chord}'))
    assert(codes('0') == '' and codes('abc') == 'nil' and codes(nil) == 'nil')
    assert(codes(4503947519721472) == '16,81', 'a small number is exact too: Shift + Q (the CET overlay key of the dev install)')
    assert(kb.bindText({117}) == 'F6' and kb.bindText({17, 74}) == 'Ctrl + J' and kb.bindText({0x70 + 11}) == 'F12' and kb.bindText({}) == nil)
    assert(kb.bindText({0x26}) == 'Up arrow' and kb.bindText({0x60}) == 'Num 0' and kb.bindText({0xBA}) == ';' and kb.bindText({0xFE}) == 'Key 254')
  `);
});

test('bindings.json: only this mod\'s five actions are read, wherever the mod\'s folder is called, and a missing or cleared action is left out', () => run(fixture + `
  local text = [[{
    "AiNpcCyberpunkMod": {
        "cyberpunk_convai_group_text": 33214047251857408,
        "cyberpunk_convai_group_voice": 32088147345014784,
        "cyberpunk_convai_manager": 32369622321725440,
        "cyberpunk_convai_text": 32932572275146752,
        "cyberpunk_convai_voice": 33495522228568064
    },
    "OtherMod": { "cyberpunk_convai_voice_extra": 33495522228568064, "elsewhere": 32932572275146752 },
    "cet": { "overlay_key": 4503947519721472 }
  }]]
  local found = kb.decodeCet(text)
  assert(found.voice == 'F8' and found.text == 'F6' and found.group_voice == 'F3' and found.group_text == 'F7' and found.manager == 'F4')
  local count = 0 for _ in pairs(found) do count = count + 1 end
  assert(count == 5, 'only the five of this mod, no overlay key and no other mod: ' .. count)
  local partial = kb.decodeCet('{"RenamedFolder": {"cyberpunk_convai_text": 32932572275146752, "cyberpunk_convai_voice": 0}}')
  assert(partial.text == 'F6' and partial.voice == nil and next(kb.decodeCet(nil)) == nil and next(kb.decodeCet('not json')) == nil)
`));

test('the Cyber Engine Tweaks line: CET\'s own live answer wins when CET answers, the file is read only without it, and at most every 5 s', () => run(fixture + `
  flags.cet, flags.cetAvailable = 'Ctrl + J', true
  assert(kb.cetBinding('text') == 'Ctrl + J')
  flags.cet = nil
  assert(kb.cetBinding('text') == nil, 'CET answers and says it is not bound: the file is not consulted')
  flags.cetAvailable = false
  assert(kb.cetBinding('text') == nil, 'no file')
  flags.file = '{"x": {"cyberpunk_convai_text": 32932572275146752}}'
  clock = clock + 1
  assert(kb.cetBinding('text') == nil, 'read less than 5 s ago')
  clock = clock + 5
  assert(kb.cetBinding('text') == 'F6' and kb.cetBinding('voice') == nil)
  flags.file = nil; clock = clock + 6
  assert(kb.cetBinding('text') == nil, 'read again later')
`));

// ---- Set -------------------------------------------------------------------------------------------------------------------------------------------
test('Set: the key that goes down after the grace is saved on the next tick, the redscript capture is switched off, and the page is told', () => run(fixture + `
  assert(kb.beginCapture(player, 'text') == true and kb.capturing() == 'text')
  assert(player.captures[1] == true and kb.observed() == true, 'capture on, the observer installed')
  player:key('IK_F7'); tick()
  assert(saved.text == nil and kb.capturing() == 'text', 'the key that chose Set (a held Enter repeating) is not the choice')
  clock = clock + 0.5; player:key('IK_F7')
  assert(saved.text == nil and kb.capturing() == 'text', 'nothing happens inside the key event')
  tick()
  assert(saved.text == 'IK_F7' and kb.capturing() == nil, 'saved on the tick')
  assert(player.list == '-,IK_F7,-,-,-' and #player.configures == 1, 'and registered on that tick, so the release of the key just chosen is heard')
  assert(player.captures[2] == false and not player.listening, 'the redscript stops listening')
  assert(#results == 1 and results[1].kind == 'bound' and results[1].action == 'text' and results[1].name == 'IK_F7')
  assert(logged('text: bound IK_F7'))
  tick(); tick()
  assert(#player.configures == 1 and player.list == '-,IK_F7,-,-,-', 'the tick keeps the new list (it does not put the old one back)')
`));

test('Set listens to the keys a player may choose and Escape, never to every key; a key outside them is not heard', () => run(fixture + `
  kb.beginCapture(player, 'voice')
  local keys = player.keys
  assert(type(keys) == 'string' and keys == kb.captureKeys() and rawequal(kb.captureKeys(), kb.captureKeys()), 'one list, made once')
  local listed, count = {}, 0
  for name in keys:gmatch('[^,]+') do listed[name] = true; count = count + 1 end
  assert(listed.IK_Escape and listed.IK_Pad_B_CIRCLE and listed.IK_F7 and listed.IK_A and listed.IK_Pad_LeftShoulder and listed.IK_NumPad0)
  for name in pairs(listed) do assert(name == 'IK_Escape' or kb.valid(name), name .. ' is not a key a player may choose') end
  assert(not listed.IK_LeftMouse and not listed.IK_Shift and not listed.IK_Pad_LeftAxisX, 'no mouse, modifier or stick')
  assert(count > 100 and count <= 256, 'the redscript takes at most 256: ' .. count)
  clock = clock + 1; player:key('IK_LeftMouse'); tick()
  assert(kb.capturing() == 'voice' and #results == 0)
`));

test('Set: the redscript capture that closes itself (too many key events, or too long) ends the Set as cancelled on the next tick', () => run(fixture + `
  kb.beginCapture(player, 'voice')
  clock = clock + 1
  player.captured[#player.captured + 1] = 'x'
  tick()
  assert(kb.capturing() == nil and lastResult().kind == 'cancelled' and saved.voice == nil)
  assert(player.captures[#player.captures] == false and not player.listening, 'unregistered from the tick')
  assert(logged('cancelled (the capture closed itself)'))
`));

test('Set: nothing that registers or unregisters a listener runs inside a key event, even while bound keys are pressed during the Set', () => run(fixture + `
  saved.voice, saved.text = 'IK_F8', 'IK_T'
  tick()
  kb.beginCapture(player, 'manager')
  clock = clock + 1
  player:key('IK_G')
  player:push('d1'); player:push('u1'); player:push('d2'); player:push('u2')
  assert(saved.manager == nil, 'a bound key event does not read the capture')
  tick()
  assert(saved.manager == 'IK_G' and player.list == 'IK_F8,IK_T,-,-,IK_G' and runList() == '')
`));

test('Set: Esc and the controller B cancel, a key that cannot be bound keeps waiting, and a key another action has is refused with its name', () => run(fixture + `
  saved.voice = 'IK_F8'
  kb.beginCapture(player, 'text'); clock = clock + 1
  -- Not on the capture's list, so the redscript never queues them; and should one arrive anyway, Lua ignores it too.
  for _, ignored in ipairs({'IK_LeftMouse', 'IK_Shift', 'IK_LControl', 'IK_Alt', 'IK_Pad_LeftAxisX', 'IK_Unknown5B', 'IK_Joy2'}) do
    player:key(ignored); player.captured[#player.captured + 1] = 'k' .. ignored end
  tick(); tick()
  assert(kb.capturing() == 'text' and #results == 0, 'still waiting')
  player:key('IK_Escape'); tick()
  assert(kb.capturing() == nil and lastResult().kind == 'cancelled' and saved.text == nil)
  kb.beginCapture(player, 'text'); clock = clock + 1
  player:key('IK_Pad_B_CIRCLE'); tick()
  assert(lastResult().kind == 'cancelled' and saved.text == nil)
  kb.beginCapture(player, 'text'); clock = clock + 1
  player:key('IK_F8'); tick()
  local result = lastResult()
  assert(result.kind == 'duplicate' and result.action == 'text' and result.name == 'IK_F8' and result.other == 'voice' and saved.text == nil and saved.voice == 'IK_F8')
  -- The same key for the action that already has it is no conflict (pressing Set again and choosing it again).
  kb.beginCapture(player, 'voice'); clock = clock + 1
  player:key('IK_F8'); tick()
  assert(lastResult().kind == 'bound' and saved.voice == 'IK_F8')
  -- A controller button works the same as a key.
  kb.beginCapture(player, 'manager'); clock = clock + 1
  player:key('IK_Pad_LeftShoulder'); tick()
  assert(saved.manager == 'IK_Pad_LeftShoulder')
`));

test('Set: a save that fails is reported and nothing is kept; a Set nobody answers ends after 12 s; Set again replaces a waiting one; leaving the page drops it silently', () => run(fixture + `
  flags.saveFails = true
  kb.beginCapture(player, 'text'); clock = clock + 1; player:key('IK_F6'); tick()
  assert(lastResult().kind == 'failed' and lastResult().reason == 'The settings could not be saved. Nothing was changed.' and saved.text == nil)
  flags.saveFails = false
  kb.beginCapture(player, 'text')
  for i = 1, 100 do tick(0.1) end
  assert(kb.capturing() == 'text', 'ten seconds: still waiting')
  for i = 1, 25 do tick(0.1) end
  assert(kb.capturing() == nil and lastResult().kind == 'timeout' and player.captures[#player.captures] == false)
  local before = #results
  kb.beginCapture(player, 'text'); kb.beginCapture(player, 'voice')
  assert(kb.capturing() == 'voice' and results[#results].kind == 'cancelled' and results[#results].action == 'text')
  local told = #results
  kb.abandonCapture(player)
  assert(kb.capturing() == nil and #results == told, 'nobody is told when the page was left')
  player.ready = false
  local ok, reason = kb.beginCapture(player, 'text')
  assert(ok == false and reason == 'codeware', 'no Codeware: the key cannot be heard')
  local ok2, reason2 = kb.beginCapture({}, 'text')
  assert(ok2 == false and reason2 == 'scripts', 'a player without the methods: the scripts did not load')
  local ok3, reason3 = kb.beginCapture(player, 'nonsense')
  assert(ok3 == false and reason3 == 'unknown')
`));

// ---- the keys at work ---------------------------------------------------------------------------------------------------------------------------
test('hold actions: down begins the turn, a key repeat is still one down, up ends it; a release with no down does nothing', () => run(fixture + `
  saved.voice, saved.group_voice = 'IK_F8', 'IK_F2'
  tick()
  player:push('u1'); assert(runList() == '', 'an up with no down')
  player:push('d1'); assert(runList() == 'voice:down')
  player:push('d1'); player:push('d1'); assert(runList() == 'voice:down', 'key repeat')
  assert(kb.held('voice') == true)
  player:push('u1'); assert(runList() == 'voice:down,voice:up' and kb.held('voice') == false)
  player:push('u1'); assert(runList() == 'voice:down,voice:up', 'one up')
  player:push('d3'); player:push('u3')
  assert(runList() == 'voice:down,voice:up,group_voice:down,group_voice:up')
  -- Both holds at once end each by itself.
  runs = {}
  player:push('d1'); player:push('d3'); player:push('u3'); player:push('u1')
  assert(runList() == 'voice:down,group_voice:down,group_voice:up,voice:up')
`));

test('tap actions run when the key comes back up, like a CET hotkey, and never on the press alone', () => run(fixture + `
  saved.text, saved.group_text, saved.manager = 'IK_T', 'IK_Y', 'IK_Pad_Start'
  tick()
  player:push('d2'); assert(runList() == '', 'nothing on the press')
  clock = clock + 0.1; player:push('u2'); assert(runList() == 'text')
  player:push('u2'); assert(runList() == 'text', 'an up with no down')
  clock = clock + 1
  player:push('d4'); player:push('u4'); player:push('d5'); player:push('u5')
  assert(runList() == 'text,group_text,manager')
`));

test('V typing in the phone chat: no key of the mod acts, press or release, and the next press works again', () => run(fixture + `
  saved.voice, saved.text = 'IK_F8', 'IK_T'
  tick()
  flags.typing = true
  player:push('d1'); player:push('u1'); player:push('d2'); player:push('u2')
  assert(runList() == '' and logged('press ignored (typing)'), runList())
  flags.typing = false
  player:push('d1'); player:push('u1'); clock = clock + 1; player:push('d2'); player:push('u2')
  assert(runList() == 'voice:down,voice:up,text')
  -- Typing that starts while a voice key is held does not stop its release.
  runs = {}
  player:push('d1'); flags.typing = true; player:push('u1')
  assert(runList() == 'voice:down,voice:up')
`));

test('one press runs a tap action once: a CET hotkey and an own key on the same key both fire as it comes up, in either order', () => run(fixture + `
  saved.text = 'IK_T'
  tick()
  -- CET first (init.lua asks convaiTapOnce before it runs the hotkey), then the own key.
  assert(kb.once('text') == true, 'the CET hotkey runs')
  player:push('d2'); player:push('u2')
  assert(runList() == '' and logged('also ran it from Cyber Engine Tweaks'), 'the own key stood back')
  -- The own key first, then CET.
  clock = clock + 1
  player:push('d2'); player:push('u2')
  assert(runList() == 'text')
  assert(kb.once('text') == false, 'the CET hotkey stood back')
  -- A real second press later runs again, and another action is not held back by the first.
  clock = clock + 0.5
  assert(kb.once('text') == true and kb.once('manager') == true)
  -- The hold actions need no such rule: they share the CET key id, and voiceKeyEdge ignores the second down and the second up of one key.
`));

test('while a key is being chosen, and for half a second after, the bound keys do nothing', () => run(fixture + `
  saved.voice, saved.text = 'IK_F8', 'IK_T'
  tick()
  kb.beginCapture(player, 'manager')
  player:push('d1'); player:push('d2'); player:push('u2'); player:push('u1')
  assert(runList() == '', 'a bound key pressed during Set is not an action')
  clock = clock + 1; player:key('IK_G'); tick()
  assert(saved.manager == 'IK_G')
  player:push('d1'); assert(runList() == '', 'the key just chosen is still down')
  player:push('u1')
  clock = clock + 0.6
  player:push('d1'); player:push('u1'); assert(runList() == 'voice:down,voice:up', 'after half a second it works')
`));


// ---- the tick: registering, a new player, no bindings --------------------------------------------------------------------------------------------
test('nothing saved and no Set in progress: the player is asked nothing and no observer is installed, tick after tick', () => run(fixture + `
  for i = 1, 40 do tick() end
  assert(next(player.calls) == nil and observer == nil and #logs == 0, 'the whole cost is one table check')
`));

test('saved keys are registered once, again for a new player after a load, again when they change, and cleared when none is left', () => run(fixture + `
  saved.voice, saved.manager = 'IK_F8', 'IK_Pad_LeftShoulder'
  tick(); tick(); tick()
  assert(#player.configures == 1 and player.configures[1] == 'IK_F8,-,-,-,IK_Pad_LeftShoulder' and observer ~= nil and kb.observed() == true)
  assert(player.calls.Ready == nil, 'nothing is asked about Codeware until a Set or a registration needs it')
  player.list = ''           -- the new player of a loaded save has nothing registered
  tick(); assert(#player.configures == 2 and player.list == 'IK_F8,-,-,-,IK_Pad_LeftShoulder')
  saved.text = 'IK_T'
  tick(); assert(#player.configures == 3 and player.configures[3] == 'IK_F8,IK_T,-,-,IK_Pad_LeftShoulder')
  saved.voice, saved.text, saved.manager = nil, nil, nil
  tick(); assert(#player.configures == 4 and player.configures[4] == '' and player.list == '', 'stopped')
  local asked = 0 for _, n in pairs(player.calls) do asked = asked + n end
  for i = 1, 20 do tick() end
  local after = 0 for _, n in pairs(player.calls) do after = after + n end
  assert(after == asked, 'and then the player is not asked anything again')
`));

test('the 10 Hz tick builds nothing while the keys stay the same, and asks the game for the queue only when the observer is not installed', () => run(fixture + `
  saved.voice, saved.manager = 'IK_F8', 'IK_Pad_LeftShoulder'
  tick()
  local first = kb.list(saved)
  assert(first == 'IK_F8,-,-,-,IK_Pad_LeftShoulder' and rawequal(first, kb.list(saved)), 'the same list string is handed back')
  saved.text = 'IK_T'
  assert(kb.list(saved) == 'IK_F8,IK_T,-,-,IK_Pad_LeftShoulder', 'a changed binding rebuilds it')
  saved.text = nil
  tick()
  local taken = player.calls.Take or 0
  for i = 1, 30 do tick() end
  assert((player.calls.Take or 0) == taken, 'the observer drains the queue; the tick does not ask the game')
  player.queue = {'d2', 'u2'}; observer(player)
  assert(runList() == 'text', 'a key event is still heard through the observer')
`));

test('a change of the keys while a hold is down ends the hold; a world that is not ready ends it too, and the keys are registered again afterwards', () => run(fixture + `
  saved.voice = 'IK_F8'
  tick(); player:push('d1'); assert(runList() == 'voice:down')
  saved.voice = 'IK_F9'
  tick(); assert(runList() == 'voice:down,voice:up', 'the old key is no longer ours')
  player:push('d1'); assert(runList() == 'voice:down,voice:up,voice:down')
  tick(0.1, false)
  assert(runList() == 'voice:down,voice:up,voice:down,voice:up', 'loading screen')
  player.list = ''
  tick(); assert(player.list == 'IK_F9,-,-,-,-', 'registered again')
`));

test('game 2.31: the key events never call into Lua, nothing is observed, and the tick reads the queue (a key acts on the next tick)', () => run(fixture + `
  flags.observable = false
  saved.voice, saved.text = 'IK_F8', 'IK_T'
  tick()
  assert(kb.observed() == false and observer == nil and logged('read on the tick'), 'no Observe at all')
  player:push('d1'); assert(runList() == '', 'nothing inside the key event')
  tick(); assert(runList() == 'voice:down')
  player:push('u1'); player:push('d2'); tick(); assert(runList() == 'voice:down,voice:up')
  clock = clock + 0.1; player:push('u2'); tick(); assert(runList() == 'voice:down,voice:up,text')
  -- A Set works the same way: read on the tick.
  kb.beginCapture(player, 'manager'); clock = clock + 1; player:key('IK_G'); tick()
  assert(saved.manager == 'IK_G')
`));

test('without the observer the 10 Hz tick reads the same queue', () => run(fixture + `
  flags.observerFails = true
  saved.text = 'IK_T'
  tick()
  assert(kb.observed() == false and logged('not installed'))
  player.queue = {'d2', 'u2'}
  tick(); assert(runList() == 'text')
`));

test('scripts without the key methods are asked again only every 30 s and the problem is logged once; a game without Codeware says so once', () => run(fixture + `
  saved.voice = 'IK_F8'
  player.absent = true
  for i = 1, 50 do tick(0.1) end
  assert(player.calls.Active == 1, 'asked once in five seconds')
  local count = 0 for _, line in ipairs(logs) do if line:find('redscript half is not loaded', 1, true) then count = count + 1 end end
  assert(count == 1)
  clock = clock + 31; player.absent = false; player.ready = false
  tick(); tick()
  assert(#player.configures == 1 and player.list == '' and logged('Codeware is missing'), 'the registration was refused')
  clock = clock + 31; player.ready = true
  tick(); assert(player.list == 'IK_F8,-,-,-,-', 'later Codeware is there')
`));

test('stop(): holds end, a Set is dropped without a word, the listener is stopped once; with no player (the world is gone) only the Lua side is cleaned', () => run(fixture + `
  saved.voice = 'IK_F8'
  tick(); player:push('d1')
  kb.beginCapture(player, 'text')
  kb.stop(player)
  assert(runList() == 'voice:down,voice:up' and kb.capturing() == nil and #results == 0)
  assert(player.configures[#player.configures] == '' and player.captures[#player.captures] == false)
  local configured = #player.configures
  kb.stop(player); assert(#player.configures == configured, 'once')
  tick(); player:push('d1'); assert(runList() == 'voice:down,voice:up,voice:down')
  kb.stop(nil)
  assert(runList() == 'voice:down,voice:up,voice:down,voice:up' and #player.configures == configured + 1)
`));

// ---- the wiring in init.lua ------------------------------------------------------------------------------------------------------------------
function wiring() {
  const start = initSource.indexOf('function convaiKeyBindsModule()');
  assert.ok(start > 0, 'init.lua has the module loader');
  const tapOnce = initSource.indexOf('function convaiTapOnce(', start);
  return initSource.slice(start, initSource.indexOf('\nend\n', tapOnce) + 5);
}

test('init.lua: with no binding saved the module is never loaded; once one is, it loads once and is ticked; every tap goes through convaiTapOnce', () => run(`
  local bindings, loaded, ticks = {}, 0, {}
  manager = {keyBindings = function() return bindings end}
  function voiceKeyEdge() end
  function beginText() end
  function openManager() end
  function log() end
  dofile = function(name) assert(name == 'key-bindings.lua'); loaded = loaded + 1
    return {tick = function(p, ready) ticks[#ticks + 1] = ready end, once = function(action) return action ~= 'blocked' end} end
  ${wiring()}
  local player = {}
  convaiKeyBindsTick(player, true); convaiKeyBindsTick(player, true)
  assert(loaded == 0 and #ticks == 0, 'nothing saved: nothing loaded')
  assert(convaiTapOnce('text') == true and convaiTapOnce('blocked') == true, 'no module: a CET hotkey always runs')
  bindings = {voice = 'IK_F8'}
  convaiKeyBindsTick(player, true); convaiKeyBindsTick(player, false)
  assert(loaded == 1 and #ticks == 2 and ticks[2] == false, 'loaded once, ticked each time')
  assert(convaiTapOnce('text') == true and convaiTapOnce('blocked') == false, 'with the module the answer is the module\\'s')
  bindings = {}
  convaiKeyBindsTick(player, true)
  assert(#ticks == 3, 'cleared: the module is told through its own tick, so it can stop')
`));

test('init.lua: an own voice key runs the CET key\'s own code path under the CET key id, a text key runs beginText, the manager key openManager', () => run(`
  local calls, observed = {}, nil
  manager = {keyBindings = function() return {} end, setKeyBinding = function(who, action, name) calls[#calls + 1] = 'save:' .. action .. ':' .. tostring(name); return true end}
  function voiceKeyEdge(id, group, down, johnny) calls[#calls + 1] = id .. ':' .. tostring(group) .. ':' .. tostring(down) .. (johnny and ':johnny' or '') end
  function beginText(group, johnny) calls[#calls + 1] = 'text:' .. tostring(group) .. (johnny and ':johnny' or '') end
  function openManager() calls[#calls + 1] = 'manager' end
  function log() end
  Game = {GetPlayer = function() return 'the player' end}
  ui = {boundKey = function(id) return 'F9 for ' .. id end}
  managerUi = {keyBindResult = function(result) calls[#calls + 1] = 'result:' .. result.kind end}
  Observe = function(class, method, fn) observed = class .. '.' .. method end
  dofile = function(name) return (function() ${moduleSource} end)() end
  ${wiring()}
  local module = convaiKeyBindsModule()
  assert(convaiKeyBindsModule() == module, 'one module')
  module.deps.voice('voice', true); module.deps.voice('voice', false); module.deps.voice('group_voice', true)
  module.deps.tap('text'); module.deps.tap('group_text'); module.deps.tap('manager')
  module.deps.voice('johnny_voice', true); module.deps.voice('johnny_voice', false); module.deps.tap('johnny_text')
  assert(table.concat(calls, ',') == 'voice:false:true,voice:false:false,group_voice:true:true,text:false,text:true,manager,'
    .. 'johnny_voice:false:true:johnny,johnny_voice:false:false:johnny,text:false:johnny', table.concat(calls, ','))
  calls = {}
  assert(module.deps.save('text', 'IK_T') == true and calls[1] == 'save:text:IK_T')
  module.deps.changed({kind = 'bound'}); assert(calls[2] == 'result:bound')
  module.deps.observe(function() end); assert(observed == 'PlayerPuppet.ConvaiKeyBindNotify')
  IsBound = function() return true end
  local value, available = module.deps.boundKey('cyberpunk_convai_text')
  assert(value == 'F9 for cyberpunk_convai_text' and available == true)
  IsBound = nil
  local none, answers = module.deps.boundKey('cyberpunk_convai_text')
  assert(none == nil and answers == false, 'a CET without IsBound does not answer')
  local typing = module.deps.typing({ConvaiPhoneChatTyping = function() return true end})
  assert(typing == true)
`));

test('init.lua: the CET hotkeys ask convaiTapOnce, the CET voice keys are unchanged, and the tick and the shutdown reach the module', () => {
  assert.match(initSource, /registerHotkey\('cyberpunk_convai_text'[^\n]*if convaiTapOnce\('text'\) then beginText\(false\) end/);
  assert.match(initSource, /registerHotkey\('cyberpunk_convai_group_text'[^\n]*if convaiTapOnce\('group_text'\) then beginText\(true\) end/);
  assert.match(initSource, /registerHotkey\('cyberpunk_convai_manager'[^\n]*if convaiTapOnce\('manager'\) then openManager\(\) end/);
  assert.match(initSource, /registerInput\('cyberpunk_convai_voice', 'AI NPC Cyberpunk Mod: talk by voice', function\(isDown\) voiceKeyEdge\('voice', false, isDown\) end\)/);
  assert.match(initSource, /registerInput\('cyberpunk_convai_group_voice', 'AI NPC Cyberpunk Mod: group voice chat', function\(isDown\) voiceKeyEdge\('group_voice', true, isDown\) end\)/);
  assert.match(initSource, /pcall\(convaiKeyBindsTick, player, worldReady\)/, 'ticked from the 10 Hz tick, not from onUpdate');
  assert.match(initSource, /if convaiKeyBinds then pcall\(convaiKeyBinds\.stop,/, 'stopped at shutdown');
  assert.match(initSource, /registerHotkey\('cyberpunk_convai_johnny_text'[^\n]*if convaiTapOnce\('johnny_text'\) then beginText\(false, true\) end/);
  assert.match(initSource, /registerInput\('cyberpunk_convai_johnny_voice', 'AI NPC Cyberpunk Mod: talk to Johnny by voice', function\(isDown\) voiceKeyEdge\('johnny_voice', false, isDown, true\) end\)/);
  const code = wiring();
  assert.match(code, /voiceKeyEdge\(action, action == 'group_voice', isDown, action == 'johnny_voice'\)/);
  assert.match(code, /Observe\('PlayerPuppet', 'ConvaiKeyBindNotify'/);
  assert.ok(!/OnUpdate|onUpdate|GetTimeSystem/.test(code), 'nothing per frame');
});

// ---- the redscript half, read as text ----------------------------------------------------------------------------------------------------------
// The body of one method or callback of KeyBinds.reds (the Codeware variant: the first one), up to the next top-level closing brace.
const redsBody = signature => {
  const start = redsSource.indexOf(signature);
  assert.ok(start >= 0, signature);
  return redsSource.slice(start, redsSource.indexOf('\n}\n', start) + 3);
};

test('KeyBinds.reds: Codeware key callbacks with a target for each key, for the bound keys and for the capture alike; no catch-all, never per frame', () => {
  assert.equal([...redsSource.matchAll(/RegisterCallback\(n"Input\/Key"/g)].length, 2, 'the bound keys and the capture, nothing else');
  const configure = redsBody('func ConvaiKeyBindsConfigure(list: String) -> Bool {');
  assert.match(configure, /OnConvaiBoundKey/);
  assert.match(configure, /AddTarget\(ConvaiKeyTarget\(this\.m_convaiKeySlots\[i\], EInputAction\.IACT_Press\)\)/);
  assert.match(configure, /if ConvaiKeyTargetsByAction\(\) \{\s*this\.m_convaiKeyHandler\.AddTarget\(ConvaiKeyTarget\(this\.m_convaiKeySlots\[i\], EInputAction\.IACT_Release\)\)/,
    'a release target only where the target filters by action');
  const capture = redsBody('func ConvaiKeyBindsCapture(keys: String) -> Bool {');
  assert.match(capture, /if StrLen\(keys\) == 0 \{ return true; \};[\s\S]*RegisterCallback\(n"Input\/Key", this, n"OnConvaiCaptureKey"\)/, 'an empty list only stops');
  assert.match(capture, /handler\.AddTarget\(ConvaiKeyTarget\(key, EInputAction\.IACT_Press\)\)/, 'a target for each listed key');
  assert.match(capture, /i < 256/, 'a bounded list');
  assert.match(capture, /if count == 0 \{\s*handler\.Unregister\(\);\s*return false;/, 'a list with no key the game knows is no capture');
  assert.match(redsSource, /m_convaiKeyHandler\.Unregister\(\)/);
  assert.match(redsSource, /m_convaiKeyCaptureHandler\.Unregister\(\)/);
  assert.ok(!/OnUpdate|OnTick|Tick\(|GetTimeSystem|DelayCallback/.test(redsSource), 'no per-frame work, no timers');
});

test('KeyBinds.reds: the capture calls nothing while the game delivers its key event, caps its events and its time, and guards against re-entry', () => {
  const handler = redsBody('cb func OnConvaiCaptureKey(');
  assert.match(handler, /^[\s\S]*?if this\.m_convaiKeyCaptureClosed \|\| this\.m_convaiKeyBusy \{ return; \};/, 'closed or re-entered: nothing');
  assert.match(handler, /this\.m_convaiKeyCaptureEvents > 64/);
  assert.match(handler, /age > 30\.0/);
  assert.match(handler, /this\.m_convaiKeyCaptureClosed = true;\s*ArrayPush\(this\.m_convaiKeyCaptured, "x"\);/);
  assert.match(handler, /size < 8/, 'its queue is bounded');
  assert.match(handler, /this\.m_convaiKeyBusy = false;\s*\}\s*$/, 'the guard is let go at the end');
  // No call out of the handler: not the notify Lua observes, not a register or unregister, not the bound keys' queue.
  assert.ok(!/ConvaiKeyBindNotify|ConvaiKeyBindPush|Unregister|RegisterCallback|ConvaiKeyBindsCapture|ConvaiKeyBindsConfigure/.test(handler), handler);
  const bound = redsBody('cb func OnConvaiBoundKey(');
  assert.match(bound, /if this\.m_convaiKeyBusy \{ return; \};\s*this\.m_convaiKeyBusy = true;/);
  assert.match(bound, /this\.m_convaiKeyBusy = false;\s*\}\s*$/);
  assert.equal([...bound.matchAll(/return;/g)].length, 2, 'no return between taking the guard and letting it go');
  const take = redsBody('public final func ConvaiKeyBindCaptureTake() -> String {');
  assert.match(take, /ArrayErase\(this\.m_convaiKeyCaptured, 0\)/);
});

test('KeyBinds.reds: a key with Shift, Ctrl or Alt held is not a binding, a repeat is not a second press, and the chosen key is not pressed again until it has come up', () => {
  const handler = redsSource.slice(redsSource.indexOf('cb func OnConvaiBoundKey('), redsSource.indexOf('cb func OnConvaiCaptureKey('));
  assert.match(handler, /evt\.IsShiftDown\(\)/); assert.match(handler, /evt\.IsControlDown\(\)/); assert.match(handler, /evt\.IsAltDown\(\)/);
  assert.match(handler, /!this\.m_convaiKeyDown\[i\]/);
  assert.match(handler, /NotEquals\(key, this\.m_convaiKeyChosen\)/);
  assert.match(handler, /Equals\(key, this\.m_convaiKeyChosen\) \{ this\.m_convaiKeyChosen = EInputKey\.IK_None; \}/);
  assert.match(handler, /IACT_Press/); assert.match(handler, /IACT_Release/);
  const capture = redsBody('cb func OnConvaiCaptureKey(');
  assert.match(capture, /this\.m_convaiKeyChosen = key;/, 'the capture remembers what was chosen');
  assert.match(capture, /Equals\(action, EInputAction\.IACT_Release\) && Equals\(key, this\.m_convaiKeyChosen\) \{ this\.m_convaiKeyChosen = EInputKey\.IK_None; \}/,
    'and forgets it when it comes up before its binding listens');
  // The events Lua reads: d<slot>, u<slot>, k<name>.
  assert.match(handler, /"d" \+ IntToString\(i \+ 1\)/); assert.match(handler, /"u" \+ IntToString\(i \+ 1\)/);
  assert.match(redsSource, /"k" \+ prefix \+ EnumValueToString\("EInputKey"/);
  assert.match(redsSource, /ArraySize\(this\.m_convaiKeyEvents\) >= 16/, 'the queue is bounded');
});

test('KeyBinds.reds compiles without Codeware: every method that needs it has a plain stand-in, and the player stops listening when it goes', () => {
  for (const method of ['ConvaiKeyBindsConfigure', 'ConvaiKeyBindsCapture', 'ConvaiKeyBindsRelease']) {
    assert.match(redsSource, new RegExp(`@if\\(ModuleExists\\("Codeware"\\)\\)\\s*@addMethod\\(PlayerPuppet\\)\\s*(public|private) final func ${method}\\(`), `${method} with Codeware`);
    assert.match(redsSource, new RegExp(`@if\\(!ModuleExists\\("Codeware"\\)\\)\\s*@addMethod\\(PlayerPuppet\\)\\s*(public|private) final func ${method}\\(`), `${method} without`);
  }
  assert.match(redsSource, /@if\(ModuleExists\("Codeware"\)\)\s*@addField\(PlayerPuppet\)\s*private let m_convaiKeyHandler: ref<CallbackSystemHandler>/);
  assert.match(redsSource, /wrapMethod\(PlayerPuppet\)\s*protected cb func OnDetach\(\) -> Bool \{\s*this\.ConvaiKeyBindsStop\(\);\s*return wrappedMethod\(\);/);
  assert.match(redsSource, /public final func ConvaiKeyBindNotify\(\) -> Void \{\s*\}/, 'the method Lua observes exists with or without Codeware');
  assert.match(redsSource, /\n@addMethod\(PlayerPuppet\)\s*public final func ConvaiKeyBindCaptureTake\(\) -> String \{/, 'and so does the capture queue Lua reads');
  assert.match(redsSource, /ConvaiKeyBindsStop\(\) -> Void \{\s*this\.ConvaiKeyBindsCapture\(""\);/);
});

test('GameVariant: both game builds say whether a key target filters by action (2.31 yes, 2.5 no)', () => {
  const v231 = readSource('../r6/scripts/CyberpunkConvai/GameVariant.reds');
  const v25 = readSource('../packaging/game-variants/2.5/r6/scripts/CyberpunkConvai/GameVariant.reds');
  assert.match(v231, /public func ConvaiKeyTargetsByAction\(\) -> Bool \{\s*return true;/);
  assert.match(v25, /public func ConvaiKeyTargetsByAction\(\) -> Bool \{\s*return false;/);
  // A key event calls into Lua as it happens on 2.5 only; neither needs Codeware for the answer.
  assert.match(v231, /\npublic func ConvaiKeyNotifyInEvent\(\) -> Bool \{\s*return false;/);
  assert.match(v25, /\npublic func ConvaiKeyNotifyInEvent\(\) -> Bool \{\s*return true;/);
  assert.match(redsSource, /ArrayPush\(this\.m_convaiKeyEvents, value\);\s*if ConvaiKeyNotifyInEvent\(\) \{ this\.ConvaiKeyBindNotify\(\); \};/);
  assert.match(redsSource, /public final func ConvaiKeyBindsObservable\(\) -> Bool \{\s*return ConvaiKeyNotifyInEvent\(\);/);
});

// 26 Oct triage: three installs of 0.3.1/0.3.2 logged "waiting for a key" and then nothing, not even the 12 s timeout. The page is a menu; a menu stops the
// game's clock, the 10 Hz tick is paced by the frame delta, so the tick that reads a Set never ran. The owner's own tests passed because the Manager popup he
// opens in the world does not pause the game.
test('Set in a menu: the manager\'s slow update reads it (captureTick) while the 10 Hz tick does not run, and a menu does not drop it', () => run(fixture + `
  assert(kb.beginCapture(player, 'text') == true)
  clock = clock + 0.5; player:key('IK_F7')
  -- No tick() at all: the game is paused in a menu. Only the slow update asks.
  kb.captureTick(player)
  assert(saved.text == 'IK_F7' and kb.capturing() == nil and lastResult().kind == 'bound', 'saved without the tick')
  assert(player.list == '-,IK_F7,-,-,-' and not player.listening, 'registered, and the capture switched off')
  -- The tick with the world not ready (a menu open) no longer throws a waiting Set away.
  kb.beginCapture(player, 'voice'); clock = clock + 0.5
  tick(0.1, false); tick(0.1, false)
  assert(kb.capturing() == 'voice', 'a menu is where a Set is made')
  player:key('IK_F9'); tick(0.1, false)
  assert(saved.voice == 'IK_F9' and kb.capturing() == nil, 'and the tick reads it there too')
  -- Nothing waits: captureTick costs nothing and touches nothing.
  local before = player.calls.CaptureTake or 0
  kb.captureTick(player); kb.captureTick(nil)
  assert((player.calls.CaptureTake or 0) == before)
`));

test('Set in a menu: it times out on the clock (12 s) from captureTick alone and says how many key events were heard; no player ends it', () => run(fixture + `
  kb.beginCapture(player, 'text')
  clock = clock + 11; kb.captureTick(player)
  assert(kb.capturing() == 'text', 'still waiting at 11 s')
  clock = clock + 2; kb.captureTick(player)
  assert(kb.capturing() == nil and lastResult().kind == 'timeout' and lastResult().heard == 0, 'no key event reached the listener at all')
  assert(logged('text: timeout (0 key events heard)'), table.concat(logs, '|'))
  assert(not player.listening, 'the listener is switched off')
  -- Keys heard, none usable: the page says so differently (heard is not 0).
  kb.beginCapture(player, 'text'); clock = clock + 1
  player.heard = 1
  clock = clock + 13; kb.captureTick(player)
  assert(lastResult().kind == 'timeout' and lastResult().heard == 1)
  -- V is gone (the save was left): the Set cannot be answered.
  kb.beginCapture(player, 'text')
  kb.captureTick(nil)
  assert(kb.capturing() == nil and lastResult().kind == 'cancelled' and logged('cancelled (no game is loaded)'))
  -- Redscript without the question: no number, no failure.
  function player:ConvaiKeyBindCaptureHeard() error('no such method') end
  kb.beginCapture(player, 'text'); clock = clock + 13; kb.captureTick(player)
  assert(lastResult().kind == 'timeout' and lastResult().heard == nil)
`));

test('Set at the main menu: no player means "world", not "the scripts did not load"; the refusals are logged', () => run(fixture + `
  local ok, reason = kb.beginCapture(nil, 'text')
  assert(ok == false and reason == 'world', tostring(reason))
  assert(logged('text: refused (no game is loaded)'))
  player.ready = false
  local ok2, reason2 = kb.beginCapture(player, 'text')
  assert(ok2 == false and reason2 == 'codeware' and logged('text: refused (Codeware is missing)'))
  local ok3, reason3 = kb.beginCapture({}, 'text')
  assert(ok3 == false and reason3 == 'scripts' and logged('text: refused (the redscript half is not loaded)'))
`));

test('the page reads a waiting Set from the manager\'s slow update, refuses a Set with no game loaded, and tells a Set that heard nothing', () => {
  const slow = managerUiSource.slice(managerUiSource.indexOf('function M.slowUpdate('));
  assert.match(slow.slice(0, 900), /convaiKeyBinds[\s\S]*capturing\(\)[\s\S]*pcall\(keys\.captureTick, currentPlayer\)/, 'slowUpdate drives the capture');
  assert.match(managerUiSource, /local currentPlayer = not noWorld and player\(\) or nil\s*if waiting then module\.abandonCapture/, 'no player at the main menu');
  assert.match(managerUiSource, /reason == 'world' then return false, ui\.t\('Load a save first\./);
  assert.match(managerUiSource, /result\.heard == 0 then actionFeedback = ui\.t\('No key press reached the mod/);
  assert.match(redsSource, /public final func ConvaiKeyBindCaptureHeard\(\) -> Int32 \{\s*return this\.m_convaiKeyCaptureEvents;/);
});

test('the shipped file lists carry both new files', () => {
  for (const file of ['../scripts/development-files.json', '../packaging/release-plan.json']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(text, /"source": "mod\/key-bindings\.lua"/, file);
    assert.match(text, /"source": "r6\/scripts\/CyberpunkConvai\/KeyBinds\.reds"/, file);
  }
});

// ---- key combinations (Shift, Ctrl or Alt held with a keyboard key) -------------------------------------------------------------------------------------

test('combinations: stored as modifier names then the key, in one order; a plain key keeps its single name; a controller button is never combined', () => run(fixture + `
  local function words(name) local kind, word, mods = kb.describe(name); return (kind or 'none') .. ':' .. (word or '') .. ':' .. table.concat(mods or {}, '+') end
  assert(words('IK_LShift+IK_F5') == 'key:F5:Shift' and words('IK_LControl+IK_T') == 'key:T:Ctrl' and words('IK_Alt+IK_Space') == 'key:Space:Alt')
  assert(words('IK_LControl+IK_Alt+IK_LShift+IK_NumPad0') == 'key:Num 0:Ctrl+Alt+Shift')
  assert(words('IK_F7') == 'key:F7:', 'a plain key is unchanged')
  for _, bad in ipairs({'IK_LShift+IK_LShift+IK_F5', 'IK_LShift+IK_LControl+IK_F5', 'IK_Alt+IK_LControl+IK_F5', 'IK_LShift+', '+IK_F5', 'IK_LShift+IK_Alt',
      'IK_LShift', 'IK_LShift+IK_Pad_A_CROSS', 'IK_RShift+IK_F5', 'IK_Shift+IK_F5', 'IK_LShift+IK_Escape', 'IK_LShift+IK_LeftMouse', 'Shift+F5', 'IK_LShift+IK_F5+'}) do
    assert(kb.describe(bad) == nil and not kb.valid(bad), bad .. ' must not be a key')
  end
  assert(kb.valid('IK_LShift+IK_F5') and kb.valid('IK_LControl+IK_Alt+IK_LShift+IK_A') and kb.valid('IK_Pad_LeftThumb'))
  assert(kb.compose({IK_LShift = true, IK_LControl = true}, 'IK_F5') == 'IK_LControl+IK_LShift+IK_F5' and kb.compose({}, 'IK_F7') == 'IK_F7')
  assert(kb.baseKey('IK_LControl+IK_LShift+IK_F5') == 'IK_F5' and kb.baseKey('IK_F7') == 'IK_F7' and kb.baseKey('IK_LShift') == nil)
`));

test('combinations: shown as Shift+F5 (every word through the translator), a controller button as before, nothing for a name that is no key', () => run(fixture + `
  local function tr(text, values) if values then return (text:gsub('{(%w+)}', values)) end return text end
  assert(kb.label('IK_LShift+IK_F5', tr) == 'Shift+F5' and kb.label('IK_LControl+IK_Alt+IK_LShift+IK_PageUp', tr) == 'Ctrl+Alt+Shift+Page up')
  assert(kb.label('IK_F7', tr) == 'F7' and kb.label('IK_Pad_LeftShoulder', tr) == 'Controller LB' and kb.label('IK_Nothing', tr) == nil and kb.label(nil, tr) == nil)
  local translated = kb.label('IK_LShift+IK_Space', function(text) return ({Shift = 'Umschalt', Space = 'Leertaste'})[text] or text end)
  assert(translated == 'Umschalt+Leertaste', translated)
  assert(kb.label('IK_LControl+IK_T') == 'Ctrl+T', 'works without a translator too')
`));

test('combinations: the redscript list carries the stored names as they are, and the same key with and without a modifier is two bindings', () => run(fixture + `
  assert(kb.list({voice = 'IK_F7', text = 'IK_LShift+IK_F5'}) == 'IK_F7,IK_LShift+IK_F5,-,-,-')
  assert(kb.list({text = 'IK_LShift+IK_Pad_A_CROSS'}) == '', 'a controller button with a modifier is left out')
  assert(kb.list({voice = 'IK_F5', group_voice = 'IK_LShift+IK_F5'}) == 'IK_F5,-,IK_LShift+IK_F5,-,-')
  saved.text = 'IK_LShift+IK_F5'; tick()
  assert(player.list == '-,IK_LShift+IK_F5,-,-,-', player.list)
`));

test('combinations: a Set that hears Shift+F5 saves that, Ctrl+Alt+Shift in one order, and a controller button without the keyboard modifier', () => run(fixture + `
  kb.beginCapture(player, 'text'); clock = clock + 1
  player.captured[#player.captured + 1] = 'kIK_LShift+IK_F5'; tick()
  assert(lastResult().kind == 'bound' and lastResult().name == 'IK_LShift+IK_F5' and saved.text == 'IK_LShift+IK_F5' and player.list == '-,IK_LShift+IK_F5,-,-,-')
  kb.beginCapture(player, 'voice'); clock = clock + 1
  player.captured[#player.captured + 1] = 'kIK_LControl+IK_Alt+IK_LShift+IK_F9'; tick()
  assert(saved.voice == 'IK_LControl+IK_Alt+IK_LShift+IK_F9')
  kb.beginCapture(player, 'manager'); clock = clock + 1
  player.captured[#player.captured + 1] = 'kIK_Alt+IK_LControl+IK_G'; tick()
  assert(saved.manager == 'IK_LControl+IK_Alt+IK_G', 'a different order is put in the stored order: ' .. tostring(saved.manager))
  kb.beginCapture(player, 'group_text'); clock = clock + 1
  player.captured[#player.captured + 1] = 'kIK_LShift+IK_Pad_LeftShoulder'; tick()
  assert(saved.group_text == 'IK_Pad_LeftShoulder', 'a controller button is single: ' .. tostring(saved.group_text))
`));

test('combinations: Esc cancels even with a modifier held, a modifier alone is never a binding, and the clash check is on the whole combination', () => run(fixture + `
  saved.text = 'IK_LShift+IK_F5'; saved.voice = 'IK_F5'
  kb.beginCapture(player, 'manager'); clock = clock + 1
  player.captured[#player.captured + 1] = 'kIK_LShift+IK_Escape'; tick()
  assert(kb.capturing() == nil and lastResult().kind == 'cancelled' and saved.manager == nil)
  kb.beginCapture(player, 'manager'); clock = clock + 1
  player.captured[#player.captured + 1] = 'kIK_LShift'; player.captured[#player.captured + 1] = 'kIK_LControl+IK_Alt'; tick(); tick()
  assert(kb.capturing() == 'manager' and saved.manager == nil, 'still waiting: a modifier alone is not a binding')
  player.captured[#player.captured + 1] = 'kIK_LShift+IK_F5'; tick()
  local result = lastResult()
  assert(result.kind == 'duplicate' and result.name == 'IK_LShift+IK_F5' and result.other == 'text' and saved.manager == nil)
  kb.beginCapture(player, 'manager'); clock = clock + 1
  player.captured[#player.captured + 1] = 'kIK_LControl+IK_F5'; tick()
  assert(saved.manager == 'IK_LControl+IK_F5', 'F5, Shift+F5 and Ctrl+F5 are three different bindings')
`));

test('combinations: the redscript matches the modifiers exactly on a press, reads them from the key event only, and adds one target for each key', () => {
  const handler = redsSource.slice(redsSource.indexOf('cb func OnConvaiBoundKey('), redsSource.indexOf('cb func OnConvaiCaptureKey('));
  assert.match(handler, /held == this\.m_convaiKeyMods\[i\]/, 'exactly the modifiers the binding names');
  assert.doesNotMatch(handler, /!evt\.IsShiftDown\(\) && !evt\.IsControlDown\(\)/, 'no longer "no modifier at all"');
  assert.match(handler, /if evt\.IsShiftDown\(\) \{ held \+= 1; \}/); assert.match(handler, /if evt\.IsControlDown\(\) \{ held \+= 2; \}/); assert.match(handler, /if evt\.IsAltDown\(\) \{ held \+= 4; \}/);
  assert.match(handler, /if pressed \{\s*if evt\.IsShiftDown/, 'the modifiers are read on a press only');
  const configure = redsSource.slice(redsSource.indexOf('func ConvaiKeyBindsConfigure(list: String) -> Bool {'), redsSource.indexOf('func ConvaiKeyBindsCapture(keys: String) -> Bool {'));
  assert.match(configure, /StrSplit\(names\[i\], "\+"\)/); assert.match(configure, /"IK_LShift"\) \{ mods \+= 1; \}/);
  assert.match(configure, /"IK_LControl"\) \{ mods \+= 2; \}/); assert.match(configure, /"IK_Alt"\) \{ mods \+= 4; \}/);
  assert.match(configure, /!ArrayContains\(added, this\.m_convaiKeySlots\[i\]\)/, 'one target for a key two bindings share');
  // No target is ever added for a modifier key: nothing runs when only a modifier is pressed.
  assert.doesNotMatch(redsSource, /AddTarget\([^)]*IK_(L|R)?(Shift|Control|Alt)/);
});
