// Romances that grew from talk (docs/SIDE_ROMANCE.md), the game half: the save's fact per character (mod/romance-registry.lua), the block a turn carries, the change the
// bridge announces (mod/bonds.lua), and the list for the Romantic relationships page (mod/manager-ui.lua). Run on a fake game; nothing here starts the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {run as runManager, nsuiHarness, source} from './manager-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

const registryHarness = `
local sources = {['housemate-registry.lua'] = [=====[${read('../mod/housemate-registry.lua')}]=====], ['romance-registry.lua'] = [=====[${read('../mod/romance-registry.lua')}]=====]}
local loaded = {}
function dofile(name)
  if loaded[name] == nil then loaded[name] = assert(load(sources[name], '@' .. name))() end
  return loaded[name]
end
local registry = dofile('romance-registry.lua')
local function newStore() local values = {}; return {values = values, get = function(name) return values[name] or 0 end, set = function(name, value) values[name] = value end} end
`;

test('romance registry: one saved fact per character, 1 together and 2 ended, nothing else counts, and an older save returns the older value', () => run(`${registryHarness}
local save = newStore()
assert(registry.read(save, 'takemura') == nil, 'a new game starts with none')
assert(registry.write(save, 'takemura', 'together'))
assert(save.values[registry.factName('takemura')] == 1 and registry.factName('takemura'):match('^cyberpunkconvai_rom_%x%x%x%x%x%x%x%x$'))
assert(registry.factName('takemura') ~= registry.factName('judy-alvarez'), 'one fact each')
assert(registry.factName('takemura') ~= dofile('housemate-registry.lua').factName('takemura'), 'not the fact of the housemates')
assert(registry.read(save, 'takemura') == 'together' and registry.read(save, 'judy-alvarez') == nil)
assert(registry.write(save, 'takemura', 'ended') and registry.read(save, 'takemura') == 'ended' and save.values[registry.factName('takemura')] == 2)
-- A different save (an older one, loaded) has its own facts: it brings back its own state.
local older = newStore(); older.values[registry.factName('takemura')] = 1
assert(registry.read(older, 'takemura') == 'together')
-- Clearing, bad input and numbers that mean nothing.
assert(registry.write(save, 'takemura', nil) and registry.read(save, 'takemura') == nil)
local ok, why = registry.write(save, 'takemura', 'married'); assert(ok == false and why == 'unknown state')
ok, why = registry.write(save, 'Bad Key', 'together'); assert(ok == false and why == 'unknown character')
save.values[registry.factName('takemura')] = 7; assert(registry.read(save, 'takemura') == nil)
assert(registry.read({get = function() error('no quest system') end}, 'takemura') == nil, 'a failing read is none')
assert(registry.write({set = function() error('no quest system') end}, 'takemura', 'together') == false)
registry.write(save, 'takemura', 'together'); registry.write(save, 'rogue-amendiares', 'ended')
local all = registry.list(save, {'takemura', 'rogue-amendiares', 'judy-alvarez'})
assert(all['takemura'] == 'together' and all['rogue-amendiares'] == 'ended' and all['judy-alvarez'] == nil)
`));

// The fake game of the bonds service: a clock and the status file as text (a Lua table literal stands in for json).
const bondsHarness = `
local M = (function() ${read('../mod/bonds.lua')} end)()
local function serialize(value)
  if type(value) == 'table' then
    local parts = {}
    for k, v in pairs(value) do parts[#parts + 1] = '[' .. serialize(k) .. ']=' .. serialize(v) end
    return '{' .. table.concat(parts, ',') .. '}'
  elseif type(value) == 'string' then return string.format('%q', value)
  else return tostring(value) end
end
local game = {now = 100, time = 50000}
local files = {}
local function setStatus(value) files[M.STATUS] = serialize(value) end
local saved, sets = {}, {}
local options = {
  enabled = function() return true end, storyPacks = function() return false end,
  ownCopy = function() return 'party' end, clock = function() return game.now end, gameTime = function() return game.time end,
  read = function(path) return files[path] end, write = function(path, text) files[path] = text; return true end,
  encode = serialize, decode = function(text) return load('return ' .. text)() end,
  notice = function() end, log = function() end,
  t = function(text, vars) return text end,
  romance = {get = function(key) return saved[key] end, set = function(key, state) sets[#sets + 1] = key .. '=' .. state; saved[key] = state; return true end},
}
`;

test('bonds block: it carries the save\'s romance state of the character, a change from the bridge is written once, and a session never replays an old one', () => run(`${bondsHarness}
saved.takemura, saved['rogue-amendiares'] = 'together', 'ended'
local bonds = M.new(options)
local context = {entity = '7', profileKey = 'takemura'}
assert(bonds.attach(context).romance == 'together' and context.bonds.romance == 'together')
assert(bonds.attach({entity = '7', profileKey = 'rogue-amendiares'}).romance == 'ended')
assert(bonds.attach({entity = '7', profileKey = 'judy-alvarez'}).romance == nil, 'no fact, no field')
assert(bonds.attach({entity = '7', phone = true, profileKey = 'takemura'}).romance == 'together', 'Phone Chat too')
local plain = M.new({enabled = options.enabled, ownCopy = options.ownCopy, clock = options.clock, read = options.read, decode = options.decode})
assert(plain.attach({entity = '7', profileKey = 'takemura'}).romance == nil, 'a game with no romance store has none')
local failing = M.new({enabled = options.enabled, ownCopy = options.ownCopy, clock = options.clock, read = options.read, decode = options.decode,
  romance = {get = function() error('boom') end}})
assert(failing.attach({entity = '7', profileKey = 'takemura'}).romance == nil, 'a failing read is none')

-- The bridge announces a change in the status: written once, only when newer than what the session had at its first turn.
setStatus({version = 1, revision = 5000, changes = {}, romance = {revision = 7000, changes = {{id = 7000, profileKey = 'old-flame', state = 'together'}}}})
local fresh = M.new(options)
fresh.attach({entity = '7', profileKey = 'judy-alvarez'})
local function tick(seconds) for _ = 1, seconds * 10 do game.now = game.now + 0.1; fresh.update('V') end end
tick(2); assert(#sets == 0, 'a change from before the session is not replayed: ' .. table.concat(sets, ','))
setStatus({version = 1, revision = 5001, changes = {}, romance = {revision = 7004, changes = {{id = 7000, profileKey = 'old-flame', state = 'together'},
  {id = 7001, profileKey = 'judy-alvarez', state = 'together'}, {id = 7002, profileKey = 'takemura', state = 'ended'}, {id = 7003, profileKey = 'Bad Key', state = 'together'},
  {id = 7004, profileKey = 'nobody', state = 'married'}}}})
tick(2)
assert(table.concat(sets, ',') == 'judy-alvarez=together,takemura=ended', table.concat(sets, ','))
tick(3); assert(#sets == 2, 'once')
assert(saved.takemura == 'ended' and saved['judy-alvarez'] == 'together')
-- The next turn of the character carries the new state.
assert(fresh.attach({entity = '7', profileKey = 'judy-alvarez'}).romance == 'together')
`));

test('the Romantic relationships page lists the characters the save holds a romance with: kept for five seconds, dropped by a write, none with Character bonds off', () => run(`${bondsHarness}
saved = {takemura = 'together', ['judy-alvarez'] = 'together', ['panam-palmer'] = 'ended'}
setStatus({version = 1, revision = 5002, levels = {}, changes = {}, characters = {
  {profileKey = 'takemura', name = 'Goro Takemura', level = 6}, {profileKey = 'judy-alvarez', name = 'Judy Alvarez', level = 6}, {profileKey = 'panam-palmer', name = 'Panam Palmer', level = 3}}})
local page = M.new(options)
local rows = page.romances()
assert(#rows == 2 and rows[1].profileKey == 'takemura' and rows[1].name == 'Goro Takemura' and rows[2].profileKey == 'judy-alvarez', #rows)
saved['judy-alvarez'] = nil; assert(#page.romances() == 2, 'kept for five seconds')
game.now = game.now + 5.1; rows = page.romances(); assert(#rows == 1 and rows[1].profileKey == 'takemura')
local off = M.new({enabled = function() return false end, clock = options.clock, read = options.read, decode = options.decode, romance = options.romance})
assert(#off.romances() == 0, 'Off: none')
`));

// The page itself, on the real host (mod/nsui.lua over mod/manager-ui.lua): the five of the game, then one row per romance of the save, and the Conversations button
// that opens the page is there for a romance alone.
const everything = {
  'service-status.lua': source('service-status.lua'), 'character-editor.lua': source('character-editor.lua'),
  'convai-paid-tier.lua': source('convai-paid-tier.lua'), 'support-report.lua': source('support-report.lua'),
  'setup-check.lua': source('setup-check.lua'), 'custom-provider.lua': source('custom-provider.lua'),
};
const pageHarness = (romances) => nsuiHarness({modules: everything}) + `
  local clock = 1000
  os.clock = function() return clock end
  local function frames(count) for _ = 1, count or 6 do clock = clock + 0.1; managerUi.update(player, true) end end
  local function press(label) ns.interact.press(assert(ns.find(label), 'no row: ' .. label)); frames(3); ns.verify() end
  convaiBondsRomances = function() return ${romances} end
  frames(3)
`;

test('Settings > Romantic relationships: a romance from talk is one more row below the five, and a native character is not listed twice', () => runManager(`${pageHarness(`{
    {profileKey = 'takemura', name = 'Goro Takemura'}, {profileKey = 'judy-alvarez', name = 'Judy Alvarez'}, {profileKey = 'rogue-amendiares', name = 'Rogue Amendiares'}}`)}
  press('Settings')
  press('Romantic relationships')
  assert(ns.sections()[2].label == 'Romantic relationships')
  assert(ns.find('Judy Alvarez') and ns.find('Panam Palmer') and ns.find('Goro Takemura') and ns.find('Rogue Amendiares'))
  local count = 0
  for _, option in ipairs(ns.sections()[2].options) do if option.label == 'Judy Alvarez' then count = count + 1 end end
  assert(count == 1, 'Judy is in the list of the game already: ' .. count)
  local row = ns.find('Goro Takemura')
  assert(row.buttonText == 'Together' and row.desc:find('Goro Takemura', 1, true) and row.desc:find('To end it, tell them', 1, true), tostring(row.desc))
`));

test('Settings > Romantic relationships: with no romance from talk the page is the five of the game, as before', () => runManager(`${pageHarness('{}')}
  press('Settings')
  press('Romantic relationships')
  assert(ns.find('Judy Alvarez') and not ns.find('Goro Takemura'))
  press('Back to settings')
  convaiBondsRomances = function() error('the bond service is not there') end
  press('Romantic relationships')
  assert(ns.find('Judy Alvarez') and not ns.find('Goro Takemura'), 'a failing list is no list')
`));

test('the game wires the romance facts into the bonds service and the page asks for them', () => {
  const init = read('../mod/init.lua'), ui = read('../mod/manager-ui.lua');
  assert.match(init, /romance = \(function\(\)\s+local registryLoaded, registry = pcall\(dofile, 'romance-registry\.lua'\)/);
  assert.match(init, /function convaiBondsRomances\(\)/);
  assert.match(ui, /ok, list = pcall\(convaiBondsRomances\)/);
  assert.match(ui, /readonly\('romance:' \.\. item\.profileKey, item\.name, 'Together',/);
});
