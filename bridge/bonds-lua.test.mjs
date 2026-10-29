// Character bonds, the game half (mod/bonds.lua, docs/RELATIONSHIPS_AND_QUESTS.md): the block a turn carries, the short watch for the bridge's status file and
// the one notice per level change. Run on a fake game (a clock and files in memory); nothing here starts the game. The bridge half is bridge/bonds.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const moduleSource = read('../mod/bonds.lua');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

// The fake game: a clock, the status file as a Lua table the fake decoder hands back, the notices shown and the files read.
const harness = `
local M = (function() ${moduleSource} end)()
local on, now, statusValue, reads, notices = true, 100, nil, 0, {}
local copies = {['7'] = 'party'}
local bonds = M.new({
  enabled = function() return on end,
  ownCopy = function(entity, profileKey) return copies[entity] end,
  clock = function() return now end,
  read = function(path) assert(path == 'runtime/bonds-status.json', path); reads = reads + 1; return statusValue and ('raw' .. tostring(statusValue.revision) .. '#' .. tostring(#(statusValue.changes or {}))) or nil end,
  decode = function(raw) return statusValue end,
  notice = function(player, text) notices[#notices + 1] = text end,
  t = function(text, vars) return (text:gsub('{(%w+)}', function(key) return vars and vars[key] ~= nil and tostring(vars[key]) or '{' .. key .. '}' end)) end,
})
local function tick(seconds) for _ = 1, seconds * 10 do now = now + 0.1; bonds.update('V') end end
`;

test('off: no block, nothing read, nothing watched', () => run(`${harness}
on = false
local context = {entity = '7', profileKey = 'judy-alvarez'}
assert(bonds.attach(context) == nil and context.bonds == nil)
assert(not bonds.pending() and reads == 0)
tick(5); assert(reads == 0 and #notices == 0)
`));

test('on: the block says the copy kind; a holocall or a game-placed character has none; the first turn learns where the changes stand', () => run(`${harness}
statusValue = {version = 1, revision = 5000, changes = {{id = 5000, profileKey = 'judy-alvarez', name = 'Judy Alvarez', from = 4, to = 5}}}
local context = {entity = '7', profileKey = 'judy-alvarez'}
local block = bonds.attach(context)
assert(block and context.bonds.version == 1 and context.bonds.on == true and context.bonds.copy == 'party')
local story = {entity = '9', profileKey = 'judy-alvarez'}; bonds.attach(story); assert(story.bonds.copy == nil)
local call = {entity = '7', profileKey = 'judy-alvarez', holocall = {contact = 'judy-alvarez'}}; bonds.attach(call); assert(call.bonds.copy == nil)
assert(bonds.pending())
-- The change from before this session's first turn is not shown again.
tick(3); assert(#notices == 0, notices[1])
`));

test('a level change after the turn: one notice in the menu language, up and down; the watch ends at the change or after 30 s', () => run(`${harness}
statusValue = {version = 1, revision = 5000, changes = {}}
bonds.attach({entity = '7', profileKey = 'panam-palmer'})
tick(2); assert(#notices == 0)
statusValue = {version = 1, revision = 5001, changes = {{id = 5001, profileKey = 'panam-palmer', name = 'Panam Palmer', from = 4, to = 5, title = 'Good friend'}}}
tick(2)
assert(#notices == 1 and notices[1] == 'Bond with Panam Palmer: level 5, Good friend', notices[1])
assert(not bonds.pending(), 'the watch ends at the change')
tick(5); assert(#notices == 1)
-- The next turn; a fall.
bonds.attach({entity = '7', profileKey = 'panam-palmer'})
statusValue = {version = 1, revision = 5002, changes = {{id = 5001, profileKey = 'panam-palmer', name = 'Panam Palmer', from = 4, to = 5},
  {id = 5002, profileKey = 'panam-palmer', name = 'Panam Palmer', from = 5, to = 4}}}
tick(2)
assert(#notices == 2 and notices[2] == 'Bond with Panam Palmer fell: level 4, Friend', notices[2])
-- No change for 30 s: the watch ends and reading stops.
bonds.attach({entity = '7', profileKey = 'panam-palmer'})
tick(31); assert(not bonds.pending())
local before = reads; tick(10); assert(reads == before, 'no reads once the watch is over')
-- At most one read a second while watching.
bonds.attach({entity = '7', profileKey = 'panam-palmer'})
before = reads; tick(10); assert(reads - before <= 11, reads - before)
`));

test('a malformed status or change shows nothing', () => run(`${harness}
statusValue = {version = 1, revision = 1, changes = {}}
bonds.attach({entity = '7', profileKey = 'panam-palmer'})
for _, bad in ipairs({
  {version = 2, revision = 2, changes = {{id = 2, name = 'P', from = 1, to = 2}}},
  {version = 1, revision = 3, changes = {{id = 3, name = 'P', from = 1, to = 11}}},
  {version = 1, revision = 4, changes = {{id = 4, name = '', from = 1, to = 2}}},
  {version = 1, revision = 5, changes = {{id = 5, name = 'P', from = 2, to = 2}}},
}) do statusValue = bad; tick(2) end
assert(#notices == 0, notices[1])
`));

test('the wiring: both send sites attach, the tick checks, the notice kind, the setting is off by default and in Gameplay, the file ships', () => {
  const init = read('../mod/init.lua');
  assert.equal(init.match(/if not context\.reaction and not context\.group then convaiBondsAttach\(context\) end/g)?.length, 2, 'typed and spoken turns');
  assert.match(init, /function convaiBondsAttach\(context\)\n\s*if type\(context\) ~= 'table' or type\(manager\.characterBonds\) ~= 'function' or not manager\.characterBonds\(\) then return end/);
  assert.match(init, /if convaiBonds and worldReady then convaiBondsTick\(player\) end/);
  assert.match(init, /convaiNotices\.send\(player, 'bond-level', text\)/);
  assert.match(read('../mod/notices.lua'), /\['bond-level'\] = \{class = PLAYER, repeatS = 10\}/);
  const manager = read('../mod/manager.lua');
  assert.match(manager, /if type\(settings\.characterBonds\) ~= 'boolean' then settings\.characterBonds, settingsNeedSave = false, true end/);
  assert.match(manager, /function M\.characterBonds\(\)\n\s*loadSettings\(\)\n\s*return settings\.characterBonds == true/);
  const ui = read('../mod/manager-ui.lua');
  assert.match(ui, /setting\('characterBonds', 'Character bonds', 'bool', snapshot\.settings\.characterBonds == true, false,/);
  assert(ui.indexOf("setting('characterBonds'") > ui.indexOf("category('gameplay'"), 'in Settings > Gameplay');
  assert.match(read('../packaging/release-plan.json'), /"source": "mod\/bonds\.lua"/);
  assert.match(read('../scripts/Extract-UiCatalog.mjs'), /'mod\/bonds\.lua'/);
});
