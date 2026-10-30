// Character bonds and story packs, the game half (mod/bonds.lua, docs/RELATIONSHIPS_AND_QUESTS.md): the block a turn carries, the short watch for the bridge's
// status file, the one notice per level change, the effects of a pack stage (her car, one-shot items, a look) and the Characters page's bond lines.
// Run on a fake game (a clock and files in memory); nothing here starts the game. The bridge half is bridge/bonds.test.mjs.
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

// The fake game: a clock, the files as text (`serialize` stands in for json, a Lua table literal), the notices shown, the items moved and the files read.
const harness = `
local M = (function() ${moduleSource} end)()
local function serialize(value)
  if type(value) == 'table' then
    local parts = {}
    for k, v in pairs(value) do parts[#parts + 1] = '[' .. serialize(k) .. ']=' .. serialize(v) end
    return '{' .. table.concat(parts, ',') .. '}'
  elseif type(value) == 'string' then return string.format('%q', value)
  else return tostring(value) end
end
local game = {on = true, packs = false, invitations = false, busy = false, now = 100, time = 50000, items = {}, giveFails = false}
local files, reads, writes, notices, logs, moves = {}, {}, {}, {}, {}, {}
local copies = {['7'] = 'party'}
local function count(path) return reads[path] or 0 end
local function setStatus(value) files[M.STATUS] = serialize(value) end
local function setEffects(value) files[M.EFFECTS] = serialize(value) end
local options = {
  enabled = function() return game.on end,
  storyPacks = function() return game.packs end,
  reach = function() return game.reach end,
  invitations = function() return game.invitations end,
  busy = function() return game.busy end,
  ownCopy = function(entity, profileKey) return copies[entity] end,
  clock = function() return game.now end,
  gameTime = function() return game.time end,
  read = function(path) reads[path] = (reads[path] or 0) + 1; return files[path] end,
  write = function(path, text) files[path] = text; writes[path] = (writes[path] or 0) + 1; return true end,
  encode = serialize,
  decode = function(text) return load('return ' .. text)() end,
  give = function(player, record, quantity)
    if game.giveFails then error('no such item') end
    game.items[record] = (game.items[record] or 0) + quantity; moves[#moves + 1] = 'give ' .. record .. ' ' .. quantity
  end,
  remove = function(player, record, quantity) game.items[record] = game.items[record] - quantity; moves[#moves + 1] = 'take ' .. record .. ' ' .. quantity end,
  quantity = function(player, record) return game.items[record] or 0 end,
  notice = function(player, text) notices[#notices + 1] = text end,
  log = function(line) logs[#logs + 1] = line end,
  t = function(text, vars) return (text:gsub('{(%w+)}', function(key) return vars and vars[key] ~= nil and tostring(vars[key]) or '{' .. key .. '}' end)) end,
}
local bonds = M.new(options)
local function tick(seconds) for _ = 1, seconds * 10 do game.now = game.now + 0.1; bonds.update('V') end end
`;
const withGame = code => run(`${harness}\n${code}`);

test('off: no block, nothing read, nothing watched, nothing blocked or worn', () => withGame(`
game.on = false
local context = {entity = '7', profileKey = 'judy-alvarez'}
assert(bonds.attach(context) == nil and context.bonds == nil)
assert(not bonds.pending() and next(reads) == nil)
tick(5); assert(next(reads) == nil and #notices == 0)
game.packs = true; setEffects({version = 1, blocked = {{profileKey = 'judy-alvarez'}}, outfits = {{profileKey = 'judy-alvarez'}}})
assert(bonds.vehicleBlocked('judy-alvarez') == false and bonds.outfitState('judy-alvarez') == nil and bonds.view('judy-alvarez') == nil)
assert(next(reads) == nil, 'the effects file was not even read')
`));

test('on: the block carries reach = true only while Characters text first is on (and nothing when there is no such option), whatever else is on', () => withGame(`
local context = {entity = '7', profileKey = 'judy-alvarez'}
bonds.attach(context); assert(context.bonds.reach == nil, 'off')
game.reach = true; context = {entity = '7', profileKey = 'judy-alvarez'}
bonds.attach(context); assert(context.bonds.reach == true and context.bonds.packs == nil, 'on, with Story packs off: the bridge ANDs them')
game.packs = true; context = {phone = true, profileKey = 'judy-alvarez'}
bonds.attach(context); assert(context.bonds.reach == true and context.bonds.packs == true, 'a Phone Chat message too')
game.reach = 'yes'; context = {entity = '7', profileKey = 'judy-alvarez'}
bonds.attach(context); assert(context.bonds.reach == nil, 'only a true')
options.reach = nil
local plain = M.new(options); context = {entity = '7', profileKey = 'judy-alvarez'}
plain.attach(context); assert(context.bonds.reach == nil)
`));

test('on: the block says the copy kind and what is on; a holocall, a phone message or a game-placed character has no copy; the first turn learns where the changes stand', () => withGame(`
setStatus({version = 1, revision = 5000, changes = {{id = 5000, profileKey = 'judy-alvarez', name = 'Judy Alvarez', from = 4, to = 5}}})
local context = {entity = '7', profileKey = 'judy-alvarez'}
local block = bonds.attach(context)
assert(block and context.bonds.version == 1 and context.bonds.on == true and context.bonds.copy == 'party')
assert(block.packs == nil and block.invitations == nil and block.busy == nil, 'only what is on is named')
local story = {entity = '9', profileKey = 'judy-alvarez'}; bonds.attach(story); assert(story.bonds.copy == nil)
local call = {entity = '7', profileKey = 'judy-alvarez', holocall = {contact = 'judy-alvarez'}}; bonds.attach(call); assert(call.bonds.copy == nil)
local phone = {entity = '7', phone = true, profileKey = 'judy-alvarez'}; bonds.attach(phone)
assert(phone.bonds.copy == nil and phone.bonds.on == true and phone.bonds.version == 1, 'a phone message has no body')
assert(bonds.pending())
-- The change from before this session's first turn is not shown again.
tick(3); assert(#notices == 0, notices[1])
`));

test('packs, invitations and busy are each named once, at the turn, as true', () => withGame(`
game.packs, game.invitations, game.busy = true, true, true
local group = {entity = '7', profileKey = 'judy-alvarez', group = {index = 2}}
local block = bonds.attach(group)
assert(block.packs == true and block.invitations == true and block.busy == true and block.copy == 'party', 'a group round turn carries its speaker\\'s own block')
game.busy = false; game.invitations = false
local second = bonds.attach({entity = '7', profileKey = 'judy-alvarez'})
assert(second.packs == true and second.invitations == nil and second.busy == nil)
-- A flag that raises is false.
options.busy = function() error('boom') end
local third = M.new(options).attach({entity = '7', profileKey = 'judy-alvarez'}); assert(third.busy == nil)
`));

test('a level change after the turn: one notice in the menu language, up and down; the watch ends 3 s after it or after 30 s', () => withGame(`
setStatus({version = 1, revision = 5000, changes = {}})
bonds.attach({entity = '7', profileKey = 'panam-palmer'})
tick(2); assert(#notices == 0)
setStatus({version = 1, revision = 5001, changes = {{id = 5001, profileKey = 'panam-palmer', name = 'Panam Palmer', from = 4, to = 5, title = 'Good friend'}}})
tick(2)
assert(#notices == 1 and notices[1] == 'Bond with Panam Palmer: level 5, Good friend', notices[1])
assert(bonds.pending(), 'it lingers a moment: the effects may be written right after')
tick(4); assert(not bonds.pending(), 'the watch ends after the change')
tick(5); assert(#notices == 1)
-- The next turn; a fall.
bonds.attach({entity = '7', profileKey = 'panam-palmer'})
setStatus({version = 1, revision = 5002, changes = {{id = 5001, profileKey = 'panam-palmer', name = 'Panam Palmer', from = 4, to = 5},
  {id = 5002, profileKey = 'panam-palmer', name = 'Panam Palmer', from = 5, to = 4}}})
tick(2)
assert(#notices == 2 and notices[2] == 'Bond with Panam Palmer fell: level 4, Friend', notices[2])
-- No change for 30 s: the watch ends and reading stops.
bonds.attach({entity = '7', profileKey = 'panam-palmer'})
tick(31); assert(not bonds.pending())
local before = count(M.STATUS); tick(10); assert(count(M.STATUS) == before, 'no reads once the watch is over')
-- At most one read a second while watching.
bonds.attach({entity = '7', profileKey = 'panam-palmer'})
before = count(M.STATUS); tick(10); assert(count(M.STATUS) - before <= 11, count(M.STATUS) - before)
`));

test('a malformed status or change shows nothing', () => withGame(`
setStatus({version = 1, revision = 1, changes = {}})
bonds.attach({entity = '7', profileKey = 'panam-palmer'})
for _, bad in ipairs({
  {version = 2, revision = 2, changes = {{id = 2, name = 'P', from = 1, to = 2}}},
  {version = 1, revision = 3, changes = {{id = 3, name = 'P', from = 1, to = 11}}},
  {version = 1, revision = 4, changes = {{id = 4, name = '', from = 1, to = 2}}},
  {version = 1, revision = 5, changes = {{id = 5, name = 'P', from = 2, to = 2}}},
}) do setStatus(bad); tick(2) end
assert(#notices == 0, notices[1])
`));

test('vehicleBlocked: read at the call, only with Story packs and Character bonds on, size-capped, a bad file is false, a later save clock is ignored', () => withGame(`
game.packs = true
assert(bonds.vehicleBlocked('panam-palmer') == false, 'no file: nothing blocked')
setEffects({version = 1, revision = 3, blocked = {{profileKey = 'panam-palmer', pack = 'panam-truck-ransom', since = 49000}, {profileKey = 'rogue-amendiares'}}})
local before = count(M.EFFECTS)
assert(bonds.vehicleBlocked('panam-palmer') == true and bonds.vehicleBlocked('rogue-amendiares') == true, 'a stamp of this save, and none')
assert(bonds.vehicleBlocked('judy-alvarez') == false and bonds.vehicleBlocked(nil) == false and bonds.vehicleBlocked('Bad Key') == false)
assert(count(M.EFFECTS) - before == 3, 'one read per ask that has a good key: ' .. (count(M.EFFECTS) - before))
-- A later clock than the save (plus 120 s of slack) is a save that was loaded away from.
setEffects({version = 1, blocked = {{profileKey = 'panam-palmer', since = 50120}, {profileKey = 'judy-alvarez', since = 50121}}})
assert(bonds.vehicleBlocked('panam-palmer') == true and bonds.vehicleBlocked('judy-alvarez') == false)
game.time = 1000; assert(bonds.vehicleBlocked('panam-palmer') == false, 'an earlier save is loaded now')
-- The entry going is the car returning.
game.time = 50000; setEffects({version = 1, blocked = {}}); assert(bonds.vehicleBlocked('panam-palmer') == false)
-- Settings and files.
setEffects({version = 1, blocked = {{profileKey = 'panam-palmer'}}})
game.packs = false; assert(bonds.vehicleBlocked('panam-palmer') == false, 'Story packs off')
game.packs = true; game.on = false; assert(bonds.vehicleBlocked('panam-palmer') == false, 'Character bonds off')
game.on = true
for _, bad in ipairs({'not a table at all (', '', string.rep('x', 70000), serialize({version = 2, blocked = {{profileKey = 'panam-palmer'}}}), serialize({version = 1, blocked = 'no'})}) do
  files[M.EFFECTS] = bad; assert(bonds.vehicleBlocked('panam-palmer') == false)
end
files[M.EFFECTS] = nil; assert(bonds.vehicleBlocked('panam-palmer') == false)
`));

test('items: a new effectsRevision makes one read; give and take move once, a take needs enough, ids are kept, the save clock guards', () => withGame(`
game.packs = true
setStatus({version = 1, revision = 10, effectsRevision = 1, changes = {}})
bonds.attach({entity = '7', profileKey = 'judy-alvarez'})
tick(2)
assert(count(M.EFFECTS) == 1, 'the first poll of a session reads the effects once')
game.items['Items.Wine'] = 2
setEffects({version = 1, revision = 2, items = {
  {id = 'dinner:gift', kind = 'giveItem', profileKey = 'judy-alvarez', pack = 'judy-dinner-dress', record = 'Items.Bottle', quantity = 1, since = 49990},
  {id = 'dinner:barter', kind = 'takeItem', profileKey = 'judy-alvarez', pack = 'judy-dinner-dress', record = 'Items.Wine', quantity = 2, since = 49990},
  {id = 'dinner:more', kind = 'takeItem', profileKey = 'judy-alvarez', pack = 'judy-dinner-dress', record = 'Items.Cake', quantity = 3},
}})
setStatus({version = 1, revision = 11, effectsRevision = 2, changes = {}})
bonds.attach({entity = '7', profileKey = 'judy-alvarez'})
local before = count(M.EFFECTS); tick(2)
assert(count(M.EFFECTS) - before == 1, 'read once for the new revision')
assert(table.concat(moves, ';') == 'give Items.Bottle 1;take Items.Wine 2', table.concat(moves, ';'))
assert(game.items['Items.Bottle'] == 1 and game.items['Items.Wine'] == 0 and not game.items['Items.Cake'], 'V had no cake: nothing was taken')
assert(writes[M.DONE] == 3, 'written once per moved or skipped item: ' .. tostring(writes[M.DONE]))
assert(bonds.pending(), 'the watch lingers 3 s'); tick(4); assert(not bonds.pending())
-- The same revision again, and the same items in a later revision: nothing moves twice.
bonds.attach({entity = '7', profileKey = 'judy-alvarez'})
setStatus({version = 1, revision = 12, effectsRevision = 3, changes = {}})
tick(2); assert(#moves == 2 and writes[M.DONE] == 3)
-- A new session (a fresh module) knows from the file.
local again = M.new(options)
again.attach({entity = '7', profileKey = 'judy-alvarez'})
setStatus({version = 1, revision = 13, effectsRevision = 4, changes = {}})
for _ = 1, 20 do game.now = game.now + 0.1; again.update('V') end
assert(#moves == 2, 'a reload does not give it twice')
-- Same id with another stamp is a new thing (the save was loaded back and the stage reached again).
setEffects({version = 1, items = {{id = 'dinner:gift', kind = 'giveItem', profileKey = 'judy-alvarez', record = 'Items.Bottle', quantity = 1, since = 49000}}})
again.attach({entity = '7', profileKey = 'judy-alvarez'})
setStatus({version = 1, revision = 14, effectsRevision = 5, changes = {}})
for _ = 1, 20 do game.now = game.now + 0.1; again.update('V') end
assert(#moves == 3 and game.items['Items.Bottle'] == 2)
`));

test('items: only valid records and counts, only this save, only with Story packs on, every call guarded, at most 60 ids kept', () => withGame(`
game.packs = true
local function item(id, fields)
  local row = {id = id, kind = 'giveItem', profileKey = 'judy-alvarez', record = 'Items.Bottle', quantity = 1}
  for k, v in pairs(fields or {}) do row[k] = v end
  return row
end
local revision = 100
local function deliver(rows)
  revision = revision + 1
  setEffects({version = 1, items = rows})
  setStatus({version = 1, revision = revision, effectsRevision = revision, changes = {}})
  bonds.attach({entity = '7', profileKey = 'judy-alvarez'})
  tick(2)
end
deliver({item('a', {record = 'Items.money; rm'}), item('b', {record = 'Weapons.Pistol'}), item('c', {quantity = 0}), item('d', {quantity = 11}), item('e', {quantity = 1.5}),
  item('f', {kind = 'sell'}), item('g', {id = 'bad id!'}), item('h', {profileKey = 'Bad Key'}), item('i', {since = 50121}), item('j', {since = -1}), item('k', {record = 'Items.'})})
assert(#moves == 0 and writes[M.DONE] == nil, 'nothing valid: nothing moved or written: ' .. table.concat(moves, ';'))
game.packs = false; deliver({item('x')}); assert(#moves == 0, 'Story packs off')
game.packs = true; game.giveFails = true; deliver({item('boom')}); assert(#moves == 0 and writes[M.DONE] == 1, 'a failed call is guarded and not tried again')
game.giveFails = false
for n = 1, 70 do deliver({item('many' .. n)}) end
local stored = load('return ' .. files[M.DONE])()
assert(#stored.ids == 60 and stored.ids[60] == 'many70@' and stored.ids[1] == 'many11@', #stored.ids .. ' ' .. tostring(stored.ids[1]))
-- With no game clock a stamped item waits and an unstamped one goes.
game.time = nil
deliver({item('stamped', {since = 10}), item('plain')})
assert(game.items['Items.Bottle'] == 71, 'the unstamped one moved: ' .. tostring(game.items['Items.Bottle']))
`));

test('outfits: wear while the entry stands, restore after it goes, done when the copy shows its own look; a later clock is ignored; nothing is read per tick', () => withGame(`
game.packs = true
assert(bonds.anyOutfit() == false and bonds.outfitState('judy-alvarez') == nil)
setEffects({version = 1, outfits = {{profileKey = 'judy-alvarez', pack = 'judy-dinner-dress', since = 49000}, {profileKey = 'panam-palmer', since = 99999}}})
setStatus({version = 1, revision = 20, effectsRevision = 1, changes = {}})
bonds.attach({entity = '7', profileKey = 'judy-alvarez'}); tick(2)
assert(bonds.outfitState('judy-alvarez') == 'wear' and bonds.outfitWanted('judy-alvarez') == true)
assert(bonds.outfitState('panam-palmer') == nil, 'a later save clock')
local before = count(M.EFFECTS)
assert(bonds.anyOutfit() == true); for _ = 1, 50 do bonds.anyOutfit(); bonds.outfitState('judy-alvarez') end
assert(count(M.EFFECTS) == before, 'no file read when asked')
-- The stage ends: the entry goes.
setEffects({version = 1, outfits = {}})
setStatus({version = 1, revision = 21, effectsRevision = 2, changes = {}})
bonds.attach({entity = '7', profileKey = 'judy-alvarez'}); tick(2)
assert(bonds.outfitState('judy-alvarez') == 'restore' and bonds.outfitWanted('judy-alvarez') == false and bonds.anyOutfit() == true)
bonds.outfitDone('judy-alvarez')
assert(bonds.outfitState('judy-alvarez') == nil and bonds.anyOutfit() == false)
-- A restore nobody finishes (her copy is gone) is dropped after ten minutes.
setEffects({version = 1, outfits = {{profileKey = 'judy-alvarez'}}})
setStatus({version = 1, revision = 22, effectsRevision = 3, changes = {}}); bonds.attach({entity = '7', profileKey = 'judy-alvarez'}); tick(2)
setEffects({version = 1, outfits = {}})
setStatus({version = 1, revision = 23, effectsRevision = 4, changes = {}}); bonds.attach({entity = '7', profileKey = 'judy-alvarez'}); tick(2)
assert(bonds.anyOutfit() == true)
game.now = game.now + 601; assert(bonds.anyOutfit() == false and bonds.outfitState('judy-alvarez') == nil)
-- Settings off: nothing asked.
setEffects({version = 1, outfits = {{profileKey = 'judy-alvarez'}}})
setStatus({version = 1, revision = 24, effectsRevision = 5, changes = {}}); bonds.attach({entity = '7', profileKey = 'judy-alvarez'}); tick(2)
assert(bonds.outfitWanted('judy-alvarez') == true)
game.packs = false; assert(bonds.outfitState('judy-alvarez') == nil and bonds.anyOutfit() == false)
`));

test('the watch lives long enough for the effects: a late reply is caught by the next turn, and an unchanged revision reads nothing', () => withGame(`
game.packs = true
setStatus({version = 1, revision = 30, effectsRevision = 1, changes = {}})
bonds.attach({entity = '7', profileKey = 'judy-alvarez'}); tick(2)
-- The reply (and the stage change) comes after the 30 s watch has ended.
tick(40); assert(not bonds.pending())
setEffects({version = 1, outfits = {{profileKey = 'judy-alvarez'}}})
setStatus({version = 1, revision = 31, effectsRevision = 2, changes = {}})
tick(5); assert(bonds.outfitState('judy-alvarez') == nil, 'nobody was watching')
bonds.attach({entity = '7', profileKey = 'judy-alvarez'}); tick(2)
assert(bonds.outfitState('judy-alvarez') == 'wear', 'the next turn catches it')
local before = count(M.EFFECTS)
bonds.attach({entity = '7', profileKey = 'judy-alvarez'}); tick(31)
assert(count(M.EFFECTS) == before, 'the same revision is not read again')
`));

test('the Characters page: the level and title in the menu language, the story only with Story packs on, read at most every 5 s, nothing while off', () => withGame(`
setStatus({version = 1, revision = 40, levels = {['judy-alvarez'] = {level = 6, title = 'Close friend'}, ['panam-palmer'] = {level = 11}},
  packs = {['judy-alvarez'] = {id = 'judy-dinner-dress', title = 'Dressed for Dinner', stage = 'invite'}}, changes = {}})
local view = bonds.view('judy-alvarez')
assert(view.level == 6 and view.title == 'Close friend' and view.story == nil, 'Story packs is off')
game.packs = true
local before = count(M.STATUS)
view = bonds.view('judy-alvarez'); assert(view.story == 'Dressed for Dinner')
for _ = 1, 20 do bonds.view('judy-alvarez') end
assert(count(M.STATUS) == before, 'cached for five seconds')
game.now = game.now + 5.1; bonds.view('judy-alvarez'); assert(count(M.STATUS) == before + 1)
assert(bonds.view('panam-palmer') == nil and bonds.view('rogue-amendiares') == nil and bonds.view(nil) == nil and bonds.view('Bad Key') == nil)
local ru = M.new({enabled = function() return true end, storyPacks = function() return true end, read = options.read, decode = options.decode, clock = options.clock,
  t = function(text) return text == 'Close friend' and 'Близкий друг' or text end})
assert(ru.view('judy-alvarez').title == 'Близкий друг')
game.on = false; assert(bonds.view('judy-alvarez') == nil)
`));

test('the wiring: three send sites attach (group rounds too, never a reaction or Johnny in the head), the phone request carries the block, the tick checks, the settings, the file ships', () => {
  const init = read('../mod/init.lua');
  assert.equal(init.match(/if not context\.reaction and not context\.head then convaiBondsAttach\(context\) end/g)?.length, 2, 'typed and spoken turns, group rounds included');
  assert.doesNotMatch(init, /if not context\.reaction and not context\.group then convaiBondsAttach/);
  assert.match(init, /function convaiBondsAttach\(context\)\n\s*if type\(context\) ~= 'table' or type\(manager\.characterBonds\) ~= 'function' or not manager\.characterBonds\(\) then return end/);
  assert.match(init, /if convaiBonds and worldReady then convaiBondsTick\(player\) end/);
  assert.match(init, /convaiNotices\.send\(player, 'bond-level', text\)/);
  assert.match(init, /phoneChat\.captureBonds = function\(profileKey\) return convaiBondsPhone and convaiBondsPhone\(profileKey\) or nil end/);
  assert.match(read('../mod/phone-chat.lua'), /M\.pending\.bonds = capture\(M\.captureBonds, key\)/);
  assert.match(init, /storyPacks = function\(\) return type\(manager\.storyPacks\) == 'function' and manager\.storyPacks\(\) end/);
  assert.match(init, /invitations = function\(\) return manager\.immersive\(\)\.enabled == true end/);
  assert.match(init, /companions\.vehicleBlocked = function\(profileKey\) return convaiBondsVehicleBlocked\(profileKey\) end/);
  assert.match(init, /story = function\(key\) return convaiBonds and convaiBonds\.outfitState\(key\) or nil end/);
  assert.match(init, /not \(convaiBonds and convaiBonds\.anyOutfit\(\)\) then return end/);
  assert.match(read('../mod/notices.lua'), /\['bond-level'\] = \{class = PLAYER, repeatS = 10\}/);
  const manager = read('../mod/manager.lua');
  assert.match(manager, /if type\(settings\.characterBonds\) ~= 'boolean' then settings\.characterBonds, settingsNeedSave = false, true end/);
  assert.match(manager, /function M\.characterBonds\(\)\n\s*loadSettings\(\)\n\s*return settings\.characterBonds == true/);
  assert.match(manager, /if type\(settings\.storyPacks\) ~= 'boolean' then settings\.storyPacks, settingsNeedSave = false, true end/);
  assert.match(manager, /function M\.storyPacks\(\)\n\s*loadSettings\(\)\n\s*return settings\.storyPacks == true and M\.storyPacksAvailable\(\)/);
  assert.match(manager, /storyPacks = M\.storyPacks\(\),/);
  assert.match(manager, /elseif key == 'storyPacks' then\n\s*if type\(value\) ~= 'boolean' then return false, 'This setting must be on or off\.' end\n\s*nextSettings\.storyPacks = value/);
  const ui = read('../mod/manager-ui.lua');
  assert.match(ui, /setting\('characterBonds', 'Character bonds', 'bool', snapshot\.settings\.characterBonds == true, false,/);
  assert.match(ui, /setting\('storyPacks', 'Story packs', 'bool', snapshot\.settings\.storyPacks == true, false,/);
  assert(ui.indexOf("setting('characterBonds'") > ui.indexOf("settingsPages['settings-companions']"), 'in Settings > Companions');
  assert.equal(ui.indexOf("setting('storyPacks'") > ui.indexOf("setting('characterBonds'"), true, 'right after Character bonds');
  assert(ui.indexOf("setting('storyPacks'") < ui.indexOf("setting('companionReactions'"), 'and before the next row');
  assert.match(ui, /elseif key == 'storyPacks' then values\.storyPacks = change\.value/);
  assert.match(ui, /ui\.t\('Bond: level \{level\}, \{title\}'/);
  assert.match(ui, /ui\.t\('Story: \{title\}'/);
  assert.match(read('../packaging/release-plan.json'), /"source": "mod\/bonds\.lua"/);
  assert.match(read('../scripts/Extract-UiCatalog.mjs'), /'mod\/bonds\.lua'/);
});

test('the Relationships page list: the characters in the bridge order, localized titles, stories only with Story packs on, one cached read, nothing while off', () => withGame(`
local judy = {profileKey = 'judy-alvarez', name = 'Judy Alvarez', level = 5, title = 'Good friend', points = 262, from = 240, next = 350, warm = 120, hurt = 12, hurtDays = 6,
  story = 150, talk = 112, arcDone = 6, arcTotal = 9, lastAt = 1761750000000.0,
  packs = {{id = 'judy-dinner-dress', title = 'Dressed for Dinner', state = 'active', label = 'She wants your honest eye on a dress'},
    {id = 'x', title = 'Old Story', state = 'done', label = '', ending = 'repaid'}}}
local panam = {profileKey = 'panam-palmer', name = 'Panam Palmer', level = 10, title = 'Ride or die', points = 3000, from = 2500, warm = 10, hurt = 0, packs = {}}
setStatus({version = 1, revision = 50, levels = {}, changes = {}, characters = {judy, panam}})
game.packs = false
local list = bonds.characters()
assert(#list == 2 and list[1].name == 'Judy Alvarez' and list[2].name == 'Panam Palmer', 'the order the bridge wrote')
assert(list[1].level == 5 and list[1].title == 'Good friend' and list[1].points == 262 and list[1].next == 350 and list[1].warm == 120 and list[1].hurt == 12)
assert(list[1].hurtDays == 6 and list[1].story == 150 and list[1].talk == 112 and list[1].arcDone == 6 and list[1].arcTotal == 9 and list[1].lastAt == 1761750000000)
assert(list[1].packs == nil and list[2].packs == nil, 'Story packs is off: no stories')
assert(list[2].level == 10 and list[2].next == nil)
game.packs = true
list = bonds.characters()
assert(#list[1].packs == 2 and list[1].packs[1].title == 'Dressed for Dinner' and list[1].packs[1].state == 'active' and list[1].packs[1].label == 'She wants your honest eye on a dress')
assert(list[1].packs[2].state == 'done' and list[1].packs[2].label == nil, 'an empty label is none')
assert(#list[2].packs == 0)
-- One read serves every call for five seconds, the Characters page's view included.
local before = count(M.STATUS)
for _ = 1, 20 do bonds.characters(); bonds.view('judy-alvarez') end
assert(count(M.STATUS) == before, 'cached for five seconds')
game.now = game.now + 5.1; bonds.characters(); assert(count(M.STATUS) == before + 1)
-- The titles are in the menu language.
local ru = M.new({enabled = function() return true end, storyPacks = function() return true end, read = options.read, decode = options.decode, clock = options.clock,
  t = function(text) return text == 'Good friend' and 'Хороший друг' or text end})
assert(ru.characters()[1].title == 'Хороший друг')
-- Off: nil, and the file is not even read.
game.on = false
local reads = count(M.STATUS)
game.now = game.now + 60
assert(bonds.characters() == nil and count(M.STATUS) == reads)
`));

test('the Relationships page list guards every field: a bad entry is dropped, a bad field is left out, a missing or foreign file is nothing, and it is capped', () => withGame(`
game.packs = true
setStatus({version = 1, revision = 51, characters = {
  'junk', 7, {}, {name = ''}, {name = 'Bad\\nName'},
  {name = 'Strings', level = '5', title = 'x', points = 'a', next = {}, warm = -3, hurt = 1e30, hurtDays = 'no', story = true, talk = false, arcDone = {}, arcTotal = 'q', lastAt = 'never', packs = 'none'},
  {name = 'Level 11', level = 11, profileKey = 'Bad Key', packs = {'x', {title = 'No state'}, {title = 'Bad state', state = 'paused'}, {state = 'active'}, {title = 'Good', state = 'active', label = 5}}},
  {name = 'Fractions', level = 3.5, points = 12.9, next = 100.2},
}})
local list = bonds.characters()
assert(#list == 3, 'only the three entries with a plain name: ' .. #list)
local strings = list[1]
assert(strings.name == 'Strings' and strings.level == nil and strings.title == nil and strings.points == nil and strings.next == nil and strings.warm == nil)
assert(strings.hurt == nil and strings.hurtDays == nil and strings.story == nil and strings.talk == nil and strings.arcDone == nil and strings.arcTotal == nil and strings.lastAt == nil)
assert(#strings.packs == 0, 'a packs field that is not a list is no stories')
local eleven = list[2]
assert(eleven.level == nil and eleven.profileKey == nil, 'level 11 and an invalid key are left out')
assert(#eleven.packs == 1 and eleven.packs[1].title == 'Good' and eleven.packs[1].label == nil, 'only the pack with a title and a state')
assert(list[3].level == nil and list[3].points == 12 and list[3].next == 100, 'whole numbers only for levels; figures are floored')
-- No file, an unreadable one, a foreign version or a file without the new field.
files[M.STATUS] = nil; game.now = game.now + 6
assert(bonds.characters() == nil, 'no file')
files[M.STATUS] = 'not a table'; game.now = game.now + 6
assert(bonds.characters() == nil)
setStatus({version = 2, revision = 1, characters = {{name = 'X'}}}); game.now = game.now + 6
assert(bonds.characters() == nil, 'a version this game does not know')
setStatus({version = 1, revision = 2, levels = {}}); game.now = game.now + 6
local none = bonds.characters(); assert(type(none) == 'table' and #none == 0, 'a file without characters is an empty list')
-- Capped, with at most ten stories each.
local many, packs = {}, {}
for index = 1, 400 do many[index] = {name = 'P' .. index} end
for index = 1, 30 do packs[index] = {title = 'S' .. index, state = 'active'} end
many[1].packs = packs
setStatus({version = 1, revision = 3, characters = many}); game.now = game.now + 6
list = bonds.characters(); assert(#list == 300 and #list[1].packs == 10)
`));

test('the wiring of the Relationships page: Home entry right after the Model browser, one global list function, nothing per frame', () => {
  const ui = read('../mod/manager-ui.lua');
  assert.match(ui, /\{'models', 'Model browser'\}, \{'bonds', 'Relationships'\}, \{'editor'\}/);
  assert.match(ui, /bonds = 'home'/);
  assert.match(ui, /bonds = true,/);
  assert.match(ui, /elseif view == 'bonds' then/);
  assert.match(ui, /pcall\(convaiBondsList\)/);
  assert.match(ui, /ui\.t\('Level \{level\}'/);
  assert.match(ui, /ui\.t\('Last talked: \{days\} days ago'/);
  const branch = ui.slice(ui.indexOf("elseif view == 'bonds' then"), ui.indexOf("elseif view == 'memory' then"));
  assert.doesNotMatch(branch, /os\.clock|io\.open|\.update\(|\.tick\(/, 'the page build reads one list and nothing else');
  const init = read('../mod/init.lua');
  assert.match(init, /function convaiBondsList\(\)\n\s*if type\(manager\.characterBonds\) ~= 'function' or not manager\.characterBonds\(\) then return nil end\n\s*local bonds = service\(\)\n\s*if not bonds then return nil end\n\s*local ok, list = pcall\(bonds\.characters\)/);
  assert.match(read('../mod/bonds.lua'), /function P\.characters\(\)\n\s*if not enabled\(\) then return nil end\n\s*local value = viewStatus\(\)/);
  for (const code of ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko']) {
    const locale = read(`../mod/locales/${code}.lua`);
    for (const text of ['Nobody yet', 'Level {level}', 'Warmth: {points}', '{points} of {needed} points to level {to}', 'Their quests: {done} of {total} finished', 'No story yet']) {
      assert(locale.includes(`[${JSON.stringify(text)}] =`), `${code}: ${text}`);
    }
  }
});

test('Characters text first: OFF by default in the settings file (30 Oct, reversing 29 Oct), read as off unless true, a row right after Story packs with its own default, set only by a boolean, in the bonds block', () => {
  const manager = read('../mod/manager.lua');
  assert.match(manager, /if type\(settings\.reachOuts\) ~= 'boolean' then settings\.reachOuts, settingsNeedSave = false, true end/);
  assert.match(manager, /function M\.reachOuts\(\)\n\s*loadSettings\(\)\n\s*return settings\.reachOuts == true and M\.storyPacksAvailable\(\)/);
  assert.match(manager, /reachOuts = M\.reachOuts\(\),/);
  assert.match(manager, /elseif key == 'reachOuts' then\n\s*if type\(value\) ~= 'boolean' then return false, 'This setting must be on or off\.' end\n\s*nextSettings\.reachOuts = value/);
  const ui = read('../mod/manager-ui.lua');
  assert.match(ui, /setting\('reachOuts', 'Characters text first', 'bool', snapshot\.settings\.reachOuts == true, false,/);
  assert(ui.indexOf("setting('reachOuts'") > ui.indexOf("setting('storyPacks'") && ui.indexOf("setting('reachOuts'") < ui.indexOf("setting('companionReactions'"), 'right after Story packs');
  assert.match(ui, /elseif key == 'reachOuts' then values\.reachOuts = change\.value/);
  assert.match(read('../mod/init.lua'), /reach = function\(\) return type\(manager\.reachOuts\) == 'function' and manager\.reachOuts\(\) end,/);
});
