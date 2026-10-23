import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// mod/voice-activation.lua (when the microphone may open, and starting a turn from the bridge's detector) and the one boolean that gates it in
// mod/init.lua (convaiVoiceActivationTick). Lua under fengari with stand-ins for the game and the bridge's state file.
const moduleSource = readFileSync(new URL('../mod/voice-activation.lua', import.meta.url), 'utf8');
const initSource = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

const fixture = `
local state = {}      -- what the bridge's state file says: {vad = {id, phase}}
json = {encode = function(v) return v end, decode = function(raw) return raw end}
io = {open = function(path, mode)
  if path == 'runtime/microphone-state.json' and state.file then return {read = function() return state.file end, close = function() return true end} end
  return nil
end}
local clock = 100
local va = (function() ${moduleSource} end)()
va.clock = function() return clock end
local listens, begun, notices = {}, {}, {}
local flags = {gameplay = true, voiceReady = true, conversation = true, busy = false, speaking = false, scene = false, began = true}
va.sceneBusy = function() return flags.scene end
va.deps = {
  enabled = function() return true end,
  listen = function(on) listens[#listens + 1] = on end,
  gameplay = function() return flags.gameplay end,
  conversation = function() return flags.conversation end,
  voiceReady = function() return flags.voiceReady end,
  busy = function() return flags.busy end,
  speaking = function() return flags.speaking end,
  begin = function(id) begun[#begun + 1] = id; return flags.began end,
  errorNotice = function() notices[#notices + 1] = 'error' end,
}
local player = {}
local function tick(seconds, ready)
  clock = clock + (seconds or 0.1)
  va.update(player, seconds or 0.1, ready ~= false)
end
local function vad(id, phase) state.file = {vad = {id = id, phase = phase}} end
local function lastListen() return listens[#listens] end
`;

function check(body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const program = fixture + '\n' + body;
    const result = lauxlib.luaL_dostring(vm, to_luastring(program));
    const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(result, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
  } finally { lua.lua_close(vm); }
}

test('the microphone opens only while a conversation is possible, and closes the moment it is not', () => {
  check(`
    tick(0.6); assert(lastListen() == true, 'a character is faced: listen')
    assert(#listens == 1, 'one write for the change, none while it stays')
    tick(0.6); tick(0.6); assert(#listens == 1)
    flags.conversation = false; tick(0.6); assert(lastListen() == false, 'nobody faced and no companion near: closed')
    flags.conversation = true; tick(0.6); assert(lastListen() == true)
    flags.scene = true; tick(0.6); assert(lastListen() == false, 'never during the game\\'s own scenes, dialogue choices or calls')
    flags.scene = false; tick(0.6); assert(lastListen() == true)
    flags.gameplay = false; tick(0.6); assert(lastListen() == false, 'a menu or an open text box closes it')
    flags.gameplay = true; tick(0.6); assert(lastListen() == true)
    flags.voiceReady = false; tick(0.6); assert(lastListen() == false, 'voice input not possible with this provider')
    flags.voiceReady = true; tick(0.6)
    assert(lastListen() == true)
    tick(0.6, false); assert(lastListen() == false, 'the world is not playable')
  `);
});

test('no AI line is ever picked up: the microphone is closed while one plays and for a moment after it ends', () => {
  check(`
    tick(0.6); assert(lastListen() == true)
    flags.speaking = true; tick(0.1); assert(lastListen() == false, 'closed in the very tick the voice starts')
    for i = 1, 20 do tick(0.1) end
    assert(lastListen() == false, 'still closed while it plays')
    flags.speaking = false
    tick(0.3); assert(lastListen() == false, 'the room echo and the tail of the voice have not died yet')
    tick(0.4); assert(lastListen() == false)
    tick(0.5); tick(0.6); assert(lastListen() == true, 'open again once the cooldown is over')
    flags.busy = true; tick(0.1); assert(lastListen() == false, 'a turn in flight closes it')
    flags.busy = false; tick(0.6); assert(lastListen() == true)
  `);
});

test('a speech start the detector reports begins one turn; old, repeated and unrelated states do not', () => {
  check(`
    vad('b:1', 'speech')          -- an old start, from before listening began
    tick(0.6); assert(lastListen() == true)
    tick(0.3); assert(#begun == 0, 'what the detector said before listening began is old')
    vad('b:2', 'speech'); tick(0.3)
    assert(#begun == 1 and begun[1] == 'b:2', 'the new start begins the turn once')
    tick(0.3); tick(0.3); assert(#begun == 1, 'the same start never begins twice')
    vad('b:3', 'ended'); tick(0.3); assert(#begun == 1, 'an end begins nothing')
  `);
});

test('a start that finds nobody to talk to is not retried at once, and two starts are never closer than two seconds', () => {
  check(`
    tick(0.6)
    flags.began = false
    vad('b:2', 'speech'); tick(0.3); assert(#begun == 1)
    -- the miss closes the microphone for a while: a sound that was not for anyone
    tick(0.3); assert(lastListen() == false, 'the microphone closes for the miss cooldown')
    for i = 1, 20 do tick(0.1) end
    assert(lastListen() == false)
    for i = 1, 20 do tick(0.1) end
    assert(lastListen() == true, 'and opens again after it')
    flags.began = true
    vad('b:3', 'speech'); tick(0.3); assert(#begun == 2)
  `);
});

test('the detector cannot open the microphone: one notice, then listening stops', () => {
  check(`
    tick(0.6); assert(lastListen() == true)
    vad('b:error', 'error'); tick(0.3)
    assert(#notices == 1 and lastListen() == false)
    vad('b:error', 'error'); tick(0.3); assert(#notices == 1, 'the same error is told once')
  `);
});

test('off() closes the microphone once and never listens again until the conditions come back', () => {
  check(`
    tick(0.6); assert(lastListen() == true)
    va.off(); assert(lastListen() == false and #listens == 2)
    assert(va.listening() == false)
  `);
});

// ---- the gate in init.lua: the detector runs only with the setting on ---------------------------------------------------------------------
function tickFunction() {
  const start = initSource.indexOf('function convaiVoiceActivationModule(');
  assert.ok(start > 0, 'init.lua has the module loader');
  const tick = initSource.indexOf('function convaiVoiceActivationTick(', start);
  const end = initSource.indexOf('\nend\n', tick) + 5;
  return initSource.slice(start, end);
}

test('with the setting off the detector is never updated, with it on it is updated each tick, and turning it off closes the microphone once', () => {
  const code = tickFunction();
  assert.match(code, /manager\.voiceActivation\(\)/);
  check(`
    local on, loaded, updates, offs = false, 0, 0, 0
    manager = {voiceActivation = function() return on end, voiceNeedsConvai = function() return false end}
    microphone = {context = nil, listen = function() end}
    pending, active, automatic, groupChat, phoneChat, speech, companions = nil, nil, nil, {}, {}, {}, {conversationCandidates = function() return {} end}
    function gameplayCanAcquire() return true end
    function toggleVoice() end
    convaiNotices = {mute = function() end, send = function() end}
    ui = {t = function(text) return text end}
    Game = {GetPlayer = function() return nil end}
    dofile = function(name) assert(name == 'voice-activation.lua'); loaded = loaded + 1
      return {update = function() updates = updates + 1 end, off = function() offs = offs + 1 end} end
    ${code}
    convaiVoiceActivationTick(player, 0.1, true); convaiVoiceActivationTick(player, 0.1, true)
    assert(updates == 0 and offs == 0, 'off: the detector never runs')
    on = true
    convaiVoiceActivationTick(player, 0.1, true); convaiVoiceActivationTick(player, 0.1, true)
    assert(loaded == 1 and updates == 2, 'on: loaded once, updated each tick')
    on = false
    convaiVoiceActivationTick(player, 0.1, true)
    assert(offs == 1 and updates == 2, 'turned off again: the microphone is told to close and nothing else runs')
  `);
});

test('the gaze scan notes the faced character without any extra game call, and a start by voice activation never shows a notice', () => {
  assert.match(initSource, /if lookKey then convaiLookSeenAt = os\.clock\(\) end/);
  const code = tickFunction();
  assert.match(code, /convaiNotices\.mute\(true\)[\s\S]*toggleVoice, false, 'vad', nil, vadId[\s\S]*convaiNotices\.mute\(false\)/);
});

// ---- the shared "a conversation is possible" answer ---------------------------------------------------------------------------------------
test('sample: possible near someone, blocked in menus, loading screens, scenes and when voice input is impossible, asked at most twice a second', () => {
  check(`
    local asked = 0
    local counted = va.deps.conversation
    va.deps.conversation = function(...) asked = asked + 1; return counted(...) end
    local possible, blocked = va.sample(player, true); assert(possible == true and blocked == false, 'somebody is faced')
    va.sample(player, true); va.sample(player, true); assert(asked == 1, 'cached inside 0.5 s')
    clock = clock + 0.6; flags.conversation = false
    possible, blocked = va.sample(player, true); assert(possible == false and blocked == false, 'nobody near: not possible, but not blocked either')
    clock = clock + 0.6; flags.conversation = true; flags.scene = true
    possible, blocked = va.sample(player, true); assert(possible == false and blocked == true, 'a scene, a dialogue with choices or a call blocks')
    clock = clock + 0.6; flags.scene = false; flags.gameplay = false
    possible, blocked = va.sample(player, true); assert(possible == false and blocked == true, 'a menu or an open text box blocks')
    clock = clock + 0.6; flags.gameplay = true
    possible, blocked = va.sample(player, false); assert(possible == false and blocked == true, 'a world that is not playable (loading) blocks')
    clock = clock + 0.6; flags.voiceReady = false
    possible, blocked = va.sample(player, true); assert(possible == false and blocked == true, 'voice input impossible with this provider')
  `);
});

// ---- the linger check: the game tells the bridge when it is busy --------------------------------------------------------------------------
function lingerFunction() {
  const start = initSource.indexOf('MIC_LINGER_WATCH_S = 17');
  assert.ok(start > 0, 'init.lua has the linger tick');
  const end = initSource.indexOf('\nend\n', initSource.indexOf('function convaiMicLingerTick(', start)) + 5;
  return initSource.slice(start, end);
}

test('the linger tick looks only while a voice turn runs or ended less than 17 s ago, and tells the bridge whether the game is busy', () => {
  check(`
    local blocks, asked, clockNow, answer = {}, 0, 1000, false
    microphone = {context = nil, holding = function() return nil end, block = function(on) blocks[#blocks + 1] = on end}
    function convaiVoiceActivationModule() return {sample = function() asked = asked + 1; return false, answer end} end
    os.clock = function() return clockNow end
    ${lingerFunction()}
    for i = 1, 20 do clockNow = clockNow + 0.1; convaiMicLingerTick(player, true) end
    assert(asked == 0 and #blocks == 0, 'no voice turn yet: nothing is looked at')
    microphone.context = {}
    convaiMicLingerTick(player, true); assert(asked == 1 and blocks[1] == false, 'a turn runs: the game is not busy')
    microphone.context = nil
    answer = true; clockNow = clockNow + 5; convaiMicLingerTick(player, true); assert(blocks[2] == true, 'a menu or a scene during the linger: busy at once')
    answer = false; clockNow = clockNow + 5; convaiMicLingerTick(player, true); assert(blocks[3] == false)
    local before = asked
    clockNow = clockNow + 20; convaiMicLingerTick(player, true); assert(asked == before, 'past the linger window nothing is looked at again')
    microphone.holding = function() return 'k' end
    convaiMicLingerTick(player, true); assert(asked == before + 1, 'a held key opens the window again')
  `);
});
