import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {gearContext, parseGear} from './player-gear.mjs';

// Equipment-EX's active outfit as "what V visibly wears" (docs/PLAYER_GEAR_CONTEXT.md): mod/equipment-ex.lua reads the mod's OutfitSystem, and
// mod/player-gear.lua lists its items instead of the equipped clothes. Run in fengari with strict fakes: every call has the real signature
// (method calls pass self, slot ids are TweakDBID values compared with ==, the transaction system takes V and a slot id) and a wrong call raises.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r/g, '');
const exSource = read('../mod/equipment-ex.lua');
const gearSource = read('../mod/player-gear.lua');
const init = read('../mod/init.lua');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

const world = `
  local V = {name = 'V'}
  local counts = {lookups = 0, slotCalls = 0}
  -- TweakDBID: a value type, equal when the names are equal (like the game's).
  local idMeta = {__eq = function(a, b) return a.name == b.name end}
  TweakDBID = {new = function(name) assert(type(name) == 'string', 'TweakDBID.new takes a string'); return setmetatable({name = name, kind = 'TweakDBID'}, idMeta) end}
  CName = {new = function(text) assert(type(text) == 'string'); return {text = text, kind = 'CName'} end}
  local function cname(text) return {text = text, kind = 'CName'} end
  local installed, containerFails = true, false
  local outfit = {active = true, slots = {}, saved = {}, equipped = nil, fail = {}}
  local items = {}   -- slot name -> item (an ItemID stand-in)
  local function must(self, expected, method) assert(self == expected, method .. ' was called without self') end
  local system
  system = {
    IsActive = function(self) must(self, system, 'IsActive'); if outfit.fail.active then error('boom') end; return outfit.active end,
    GetUsedSlots = function(self) must(self, system, 'GetUsedSlots'); if outfit.fail.slots then error('boom') end
      local list = {}
      for _, name in ipairs(outfit.slots) do list[#list + 1] = TweakDBID.new(name) end
      return list end,
    GetOutfits = function(self) must(self, system, 'GetOutfits'); local list = {}
      for _, name in ipairs(outfit.saved) do list[#list + 1] = cname(name) end
      return list end,
    IsEquipped = function(self, name) must(self, system, 'IsEquipped'); assert(type(name) == 'table' and name.kind == 'CName', 'IsEquipped takes a CName')
      return name.text == outfit.equipped end,
  }
  local transactions
  transactions = {GetItemInSlot = function(self, player, slotID)
    must(self, transactions, 'GetItemInSlot'); assert(player == V, 'GetItemInSlot takes V')
    assert(type(slotID) == 'table' and slotID.kind == 'TweakDBID', 'GetItemInSlot takes a TweakDBID')
    counts.slotCalls = counts.slotCalls + 1
    local id = items[slotID.name]
    if id == nil then return nil end
    return {GetItemID = function(item) assert(type(item) == 'table', 'GetItemID needs self'); return id end}
  end}
  Game = {
    GetScriptableSystemsContainer = function()
      if containerFails then error('no container') end
      return {Get = function(self, name)
        assert(name.kind == 'CName', 'Get takes a CName'); counts.lookups = counts.lookups + 1
        if name.text == 'EquipmentEx.OutfitSystem' and installed then return system end
        return nil
      end}
    end,
    GetTransactionSystem = function() return transactions end,
    NameToString = function(value) assert(value.kind == 'CName'); return value.text end,
  }
  local lines = {}
  local function log(line) lines[#lines + 1] = line end
  local M = (function() ${exSource} end)()
  local function wear(list) outfit.slots = {}
    for _, row in ipairs(list) do outfit.slots[#outfit.slots + 1] = row[1]; items[row[1]] = {tdb = row[2]} end end
`;
const withWorld = code => run(`${world}\n${code}`);

test('an active outfit answers its items by category, in a fixed order, and names the saved outfit it matches', () => withWorld(`
  outfit.saved = {'Casual', 'Night out'}; outfit.equipped = 'Night out'
  wear({{'OutfitSlots.Feet', 'boots'}, {'AttachmentSlots.Torso', 'jacket'}, {'OutfitSlots.NecklaceShort', 'chain'}, {'AttachmentSlots.Head', 'cap'},
    {'OutfitSlots.NecklaceLong', 'pearls'}, {'OutfitSlots.TorsoInner', 'tee'}, {'OutfitSlots.LegsOuter', 'jeans'}, {'OutfitSlots.BodyOuter', 'cloak'}, {'OutfitSlots.Glasses', 'shades'}})
  local out = M.read(V, log, 1000)
  assert(out and out.name == 'Night out', 'name')
  local got = {}
  for _, part in ipairs(out.parts) do got[#got + 1] = part.slot .. '=' .. part.id.tdb end
  assert(table.concat(got, ',') == 'head=cap,face=shades,neck=chain,neck=pearls,outerTorso=jacket,innerTorso=tee,legs=jeans,feet=boots,outfit=cloak', table.concat(got, ','))
  assert(#lines == 1 and lines[1] == 'equipment-ex outfit=Night out parts=9', lines[1])
  M.read(V, log, 1010)
  assert(#lines == 1, 'the same reading is logged once')
  outfit.equipped = 'Casual'; M.read(V, log, 1020)
  assert(#lines == 2 and lines[2] == 'equipment-ex outfit=Casual parts=9', 'a change is logged')
`));

test('an unsaved set of parts has no name, and the log line says so', () => withWorld(`
  outfit.saved = {'Casual'}
  wear({{'AttachmentSlots.Chest', 'tee'}})
  local out = M.read(V, log, 1)
  assert(out.name == '' and out.parts[1].slot == 'innerTorso')
  assert(lines[1] == 'equipment-ex outfit=unsaved parts=1', lines[1])
`));

test('no outfit active means no answer and one log line; not installed means no answer and one lookup a minute', () => withWorld(`
  outfit.active = false
  assert(M.read(V, log, 1) == nil and M.read(V, log, 2) == nil)
  assert(#lines == 1 and lines[1] == 'equipment-ex outfit=off', lines[1])
  assert(counts.slotCalls == 0, 'nothing is read from the slots')
  M.reset(); lines = {}; counts.lookups = 0; installed = false
  assert(M.read(V, log, 100) == nil and counts.lookups == 1)
  assert(M.read(V, log, 130) == nil and counts.lookups == 1, 'not again within a minute')
  assert(M.read(V, log, 161) == nil and counts.lookups == 2, 'again after a minute')
  installed = true; outfit.active = true; wear({{'AttachmentSlots.Head', 'cap'}})
  assert(M.read(V, log, 230) ~= nil, 'found once installed')
  assert(#lines == 1, 'absent costs no log line')
`));

test('every failure answers nothing and never raises', () => withWorld(`
  wear({{'AttachmentSlots.Head', 'cap'}})
  containerFails = true; assert(M.read(V, log, 1) == nil); containerFails = false
  outfit.fail.active = true; assert(M.read(V, log, 2) == nil); outfit.fail.active = false
  outfit.fail.slots = true; assert(M.read(V, log, 3) == nil); outfit.fail.slots = false
  assert(M.read(nil, log, 4) == nil, 'no player')
  assert(M.read(V, 'not a function', 5) ~= nil, 'a bad log is ignored')
  for _, line in ipairs(lines) do assert(#line < 200) end
  -- A class that changed shape: IsActive missing.
  system.IsActive = nil
  assert(M.read(V, log, 6) == nil)
`));

test('a slot without an item is skipped, an unknown slot is dropped, and nothing recognised means no answer', () => withWorld(`
  outfit.slots = {'AttachmentSlots.Head', 'OutfitSlots.Back', 'AttachmentSlots.Feet'}; items['AttachmentSlots.Head'] = {tdb = 'cap'}; items['AttachmentSlots.Feet'] = {tdb = 'boots'}
  local out = M.read(V, log, 1)
  assert(#out.parts == 2 and out.parts[1].slot == 'head' and out.parts[2].slot == 'feet')
  assert(lines[1] == 'equipment-ex outfit=unsaved parts=2', lines[1])
  M.reset(); lines = {}
  outfit.slots = {'Some.NewSlot'}; items['Some.NewSlot'] = {tdb = 'thing'}
  assert(M.read(V, log, 2) == nil, 'a build that renamed its slots must not hide the real clothes')
  assert(#lines == 1 and lines[1]:find('no slot recognised'), lines[1])
  -- An active outfit that shows nothing is an answer: V visibly wears nothing.
  M.reset(); outfit.slots = {}
  local empty = M.read(V, log, 3)
  assert(empty and #empty.parts == 0)
`));

test('at most the part limit is answered', () => withWorld(`
  local rows = {}
  for _, name in ipairs({'OutfitSlots.EarLeft', 'OutfitSlots.EarRight', 'OutfitSlots.Neckwear', 'OutfitSlots.NecklaceTight', 'OutfitSlots.NecklaceShort', 'OutfitSlots.NecklaceLong',
    'OutfitSlots.Back', 'OutfitSlots.Waist', 'OutfitSlots.ShoulderLeft', 'OutfitSlots.ShoulderRight', 'OutfitSlots.ElbowLeft', 'OutfitSlots.ElbowRight', 'OutfitSlots.Hands', 'OutfitSlots.HandLeft',
    'OutfitSlots.FingersLeft', 'OutfitSlots.FingersRight'}) do rows[#rows + 1] = {name, name} end
  wear(rows)
  assert(#M.read(V, log, 1).parts == 14)
`));

// ---------------------------------------------------------------- the gear reader
const gearWorld = `${world}
  local G = (function() ${gearSource} end)()
  local equipped = {['Head#0'] = {name = 'Hat'}, ['OuterChest#0'] = {name = 'Jacket'}, ['InnerChest#0'] = {name = 'Tee'}, ['Legs#0'] = {name = 'Jeans'},
    ['Feet#0'] = {name = 'Boots'}, ['Outfit#0'] = {name = 'Suit'}, ['Weapon#0'] = {name = 'Kyubi'}, ['ArmsCW#0'] = {name = 'Mantis Blades'}}
  local N = {
    player = function() return V end, ready = function() return true end, data = function() return {} end,
    area = function(name) return name end, visual = function() return nil end,
    equipped = function(_, area, index) return equipped[area .. '#' .. index] end,
    hand = function() return nil end,
    valid = function(id) return type(id) == 'table' and (id.name ~= nil or id.tdb ~= nil) end,
    name = function(id) return id.name or ('Display ' .. id.tdb) end}
  local function names(list) local out = {}; for _, row in ipairs(list or {}) do out[#out + 1] = row.slot .. '=' .. row.name end; return table.concat(out, ',') end
  local REAL = 'head=Hat,outerTorso=Jacket,innerTorso=Tee,legs=Jeans,feet=Boots,outfit=Suit'
  local function reader(options) options.native = N; options.now = function() return 1 end; return G.new(options) end
`;

test('the gear reader lists the outfit instead of the equipped clothes and keeps weapons and cyberware', () => run(`${gearWorld}
  wear({{'AttachmentSlots.Torso', 'coat'}, {'OutfitSlots.Mask', 'mask'}})
  local gear = reader({outfit = function(player) assert(player == V); return M.read(player, log, 1) end})
  local snap = gear:capture()
  assert(names(snap.clothing) == 'face=Display mask,outerTorso=Display coat', names(snap.clothing))
  assert(snap.layered == true and names(reader({}):capture().clothing) == REAL and reader({}):capture().layered == nil, 'only an outfit is layered')
  assert(names(snap.cyberware) == 'arms=Mantis Blades' and names(snap.weapons) == 'slot1=Kyubi', 'the rest is unchanged')
`));

test('without the option, with no answer, with an error, or without a name, the real clothes are read as before', () => run(`${gearWorld}
  assert(names(reader({}):capture().clothing) == REAL)
  assert(names(reader({outfit = function() return nil end}):capture().clothing) == REAL)
  assert(names(reader({outfit = function() error('another mod changed') end}):capture().clothing) == REAL)
  assert(names(reader({outfit = function() return 'junk' end}):capture().clothing) == REAL)
  -- An outfit whose items have no name drops them, like any unnamed item; an outfit that shows nothing hides the real clothes.
  local bare = reader({outfit = function() return {name = '', parts = {{slot = 'head', id = {}}}} end}):capture()
  assert(bare.clothing == nil and names(bare.cyberware) == 'arms=Mantis Blades')
  local none = reader({outfit = function() return {name = '', parts = {}} end}):capture()
  assert(none.clothing == nil)
`));

test('init.lua reads Equipment-EX only while the Other mods state switch is on, and loads the module lazily', () => {
  const block = /playerGear\.options\.outfit = function\(player\)([\s\S]*?)\n    end\n/.exec(init)?.[1] ?? '';
  assert.ok(block, 'the option is wired');
  assert.match(block, /manager\.dynamicInfo and manager\.dynamicInfo\('mods'\)/);
  assert.ok(block.indexOf("dynamicInfo('mods')") < block.indexOf("dofile, 'equipment-ex.lua'"), 'the switch is checked before anything is loaded');
  assert.ok(!/^local .*equipment-ex/m.test(init), 'not loaded at start');
  // No timer, hook or per-frame work in the module.
  assert.ok(!/registerForEvent|Observe\(|Override\(|DelaySystem|onUpdate/.test(exSource));
});

// ---------------------------------------------------------------- the bridge words it
test('the bridge words outfit categories and keeps two items of one category', () => {
  const gear = {version: 1, status: 'ready', layered: true, clothing: [{slot: 'head', name: 'Cap'}, {slot: 'neck', name: 'Chain'}, {slot: 'neck', name: 'Pearls'},
    {slot: 'neck', name: 'Chain'}, {slot: 'hands', name: 'Gloves'}, {slot: 'back', name: 'Cape'}]};
  assert.equal(parseGear(gear).clothing.length, 5, 'an exact repeat is still dropped');
  assert.equal(parseGear({...gear, layered: undefined}).clothing.length, 4, 'without the flag a slot keeps its first item');
  assert.match(gearContext({gear}), /wearing: head: Cap, neck: Chain, neck: Pearls, hands: Gloves, back: Cape\./);
  assert.deepEqual(parseGear({version: 1, status: 'ready', clothing: [{slot: 'tail', name: 'Tail'}]}), {version: 1, status: 'unavailable'}, 'unknown slots still fail closed');
  assert.deepEqual(parseGear({version: 1, status: 'ready', weapons: [{slot: 'hand', name: 'A'}, {slot: 'hand', name: 'B'}]}).weapons, [{slot: 'hand', name: 'A'}], 'weapons keep one per slot');
});
