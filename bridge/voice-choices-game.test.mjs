import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Speak dialogue choices, the game half (mod/voice-choices.lua, docs/VOICE_CHOICES.md) under fengari with stand-ins for the game's events: what it publishes when
// a list opens, changes and closes, that nothing runs while the setting is off, and the one notice when the bridge could not pick.
const moduleSource = readFileSync(new URL('../mod/voice-choices.lua', import.meta.url), 'utf8');
const initSource = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
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

const fixture = `
local clock, enabled = 100, true
local M = (function() ${moduleSource} end)()
M.clock = function() return clock end
-- json: a registry, the text is a key.
local registry, n = {}, 0
json = {encode = function(t) n = n + 1; local key = 'j' .. n; registry[key] = t; return key end, decode = function(s) return registry[s] end}
function FromVariant(v) return v end
local files, observers, listens, notices, logs = {}, {}, {}, {}, {}
local bb = {hubsNow = nil, active = 5, selected = 0}
local blackboardReads = 0
M.deps = {
  enabled = function() return enabled end,
  observe = function(class, method, fn) observers[#observers + 1] = class .. '.' .. method; observers[class .. '.' .. method] = fn end,
  hubsNow = function() return bb.hubsNow end,
  activeHub = function() blackboardReads = blackboardReads + 1; return bb.active end,
  selectedIndex = function() blackboardReads = blackboardReads + 1; return bb.selected end,
  localized = function(t) if t == 'LocKey#1' then return 'Resolved text' end return t end,
  unavailable = function(item) return item.grey == true end,
  write = function(path, text) files[path] = text; return true end,
  read = function(path) return files[path] end,
  listen = function(on) listens[#listens + 1] = on end,
  notice = function(kind) notices[#notices + 1] = kind end,
  log = function(line) logs[#logs + 1] = line end,
}
local function hub(id, names) local c = {}; for i, t in ipairs(names) do c[i] = type(t) == 'table' and t or {localizedName = t} end; return {id = id, choices = c} end
local function published() return registry[files['runtime/choice-hub.json']] end
`;

test('a list opens, changes and closes: the file, the fingerprint and the microphone request follow it', () => {
  run(fixture + `
M.tick()
assert(#observers >= 3, 'observers registered')
assert(observers['InteractionUIBase.OnDialogsData'] and observers['dialogWidgetGameController.OnDialogsSelectIndex'])
assert(files['runtime/choice-hub.json'] == nil, 'nothing is written for a game with no list')
observers['InteractionUIBase.OnDialogsData'](nil, {choiceHubs = {hub(5, {'Who are you?', 'LocKey#1', {localizedName = '<b>Grey</b> one', grey = true}, 'Never mind.'})}})
local p = published()
assert(p.open == true and p.hubId == 5 and #p.texts == 4, 'open with four captions')
assert(p.texts[1] == 'Who are you?' and p.texts[2] == 'Resolved text' and p.texts[3] == '' and p.texts[4] == 'Never mind.', 'plain captions, grey emptied')
assert(p.selected == 0 and p.fp:match('^5:4:%x+$'), 'selected and fingerprint')
assert(listens[#listens] == true, 'the microphone is asked for')
local first = p.fp
bb.selected = 2
observers['dialogWidgetGameController.OnDialogsSelectIndex'](nil, 2)
assert(published().selected == 2 and published().fp == first, 'the highlight moves, the fingerprint does not')
local writes = n
observers['dialogWidgetGameController.OnDialogsSelectIndex'](nil, 2)
assert(n == writes, 'the same state is never written twice')
observers['InteractionUIBase.OnDialogsData'](nil, {choiceHubs = {hub(5, {'Who are you?', 'Different now'})}})
assert(published().fp ~= first and #published().texts == 2, 'a changed list has another fingerprint')
observers['InteractionUIBase.OnDialogsData'](nil, {choiceHubs = {}})
assert(published().open == false and listens[#listens] == false, 'closed')
`);
});

test('a highlight change that no event reported is caught by the tick, only while a list is open', () => {
  run(fixture + `
M.tick()
local reads = blackboardReads
M.tick(); M.tick()
assert(blackboardReads == reads, 'no blackboard read while no list is open')
observers['InteractionUIBase.OnDialogsData'](nil, {choiceHubs = {hub(5, {'a', 'b', 'c'})}})
bb.selected = 1
M.tick()
assert(published().selected == 1, 'the tick publishes the new highlight')
`);
});

test('the setting off: no observer, no read; turned off while open, the list is closed once', () => {
  run(fixture + `
enabled = false
M.tick(); M.tick()
assert(#observers == 0 and blackboardReads == 0 and files['runtime/choice-hub.json'] == nil, 'nothing happens while the setting is off')
enabled = true
M.tick()
observers['InteractionUIBase.OnDialogsData'](nil, {choiceHubs = {hub(5, {'a', 'b'})}})
assert(published().open == true)
enabled = false
M.tick()
assert(published().open == false and listens[#listens] == false, 'turned off: closed and the microphone released')
local before = n
M.tick()
assert(n == before, 'closed once only')
`);
});

test('a result for the list on screen shows one notice, an old or foreign one shows none', () => {
  run(fixture + `
M.tick()
observers['InteractionUIBase.OnDialogsData'](nil, {choiceHubs = {hub(5, {'a', 'b'})}})
local fp = published().fp
local at = os.time() * 1000
local function result(id, status, fpv, when) files['runtime/choice-result.json'] = json.encode({id = id, status = status, fp = fpv, at = when}) end
clock = clock + 1
result('r1', 'pick', fp, at); M.tick()
assert(#notices == 0, 'a pick says nothing')
clock = clock + 1
result('r2', 'none', 'other:fp', at); M.tick()
assert(#notices == 0, 'another list')
clock = clock + 1
result('r3', 'none', fp, at - 60000); M.tick()
assert(#notices == 0, 'older than the list')
clock = clock + 1
result('r4', 'ambiguous', fp, at + 10); M.tick()
assert(#notices == 1 and notices[1] == 'ambiguous', 'one notice')
clock = clock + 0.5
result('r5', 'none', fp, at + 20); M.tick()
assert(#notices == 1, 'not again within the gap')
clock = clock + 5
result('r6', 'none', fp, at + 30); M.tick()
assert(#notices == 2 and notices[2] == 'unclear')
`);
});

test('wiring: init.lua reads the setting as one boolean per tick and loads the module only when on', () => {
  assert.match(initSource, /function convaiVoiceChoicesTick\(\)\n\s+if not manager\.voiceChoices\(\) then/);
  assert.match(initSource, /pcall\(convaiVoiceChoicesTick\)/);
  assert.match(initSource, /convaiVoiceChoices = dofile\('voice-choices\.lua'\)/);
});
