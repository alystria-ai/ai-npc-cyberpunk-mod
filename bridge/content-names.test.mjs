import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runLua, addonsSource} from './addon-lua-harness.mjs';
import {run, managerFixture} from './manager-fixture.mjs';
import {fold as jsFold} from '../scripts/Build-NpcNamePools.mjs';

// Content packs, the game's half of the names (mod/content-names.lua): the bridge publishes runtime/content-names.json and
// runtime/content-name-pools.json (bridge/addon-content.mjs publish); the game lays the names of the packs that are switched on over its
// catalogs when they load, and uses a pack's name pools for the nameless pedestrians. The Lua runs in fengari with the real modules.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const contentSource = read('../mod/content-names.lua');
const catalogSource = read('../mod/character-catalog.lua');
const npcNamesSource = read('../mod/npc-names.lua');
const poolsSource = read('../mod/npc-name-pools.lua');

// The real add-on module is `M` (the switch of each pack is convaiAddons.contentEnabledFor); the other modules load through dofile as the game does.
const lua = body => runLua(`
local realDofile = dofile
local function contentFactory() ${contentSource}
end
local function catalogFactory() ${catalogSource}
end
local function namesFactory() ${npcNamesSource}
end
local function poolsFactory() ${poolsSource}
end
dofile = function(path)
  if path == 'content-names.lua' then return contentFactory() end
  if path == 'npc-name-pools.lua' then return poolsFactory() end
  if path == 'npc-names.lua' then return namesFactory() end
  return realDofile(path)
end
-- The add-on module reads its settings file once: a new instance reads what the test just wrote.
local function newAddons() return (function() ${addonsSource}
end)() end
convaiAddons = newAddons()
local function names(packs) files['runtime/content-names.json'] = json.encode({version = 1, packs = packs}) end
local function switch(values) files['runtime/addon-settings.json'] = json.encode({version = 1, addons = values}); convaiAddons = newAddons() end
local function eq(a, b, m) assert(a == b, (m or 'values differ') .. ': expected ' .. tostring(b) .. ', got ' .. tostring(a)) end
local function roster()
  return {
    {key = 'judy-alvarez', name = 'Judy Alvarez', aliases = {'Judy'}, records = {'Character.Judy'}},
    {key = 'panam-palmer', name = 'Panam Palmer', records = {'Character.Panam'}},
    {key = 'npc-maelstrom-male', name = 'Maelstrom Ganger Male'},
  }
end
${body}`);

test('no file, an empty file or damaged JSON: the rows come back untouched and nothing is written', () => {
  lua(`
    local cn = dofile('content-names.lua')
    local rows = roster()
    local copy = roster()
    -- Missing file.
    local _, changed = cn.applyRows(rows)
    eq(changed, 0)
    eq(rows[1].name, 'Judy Alvarez'); eq(rows[1].shippedName, nil); eq(#rows[1].aliases, 1); eq(rows[2].aliases, nil)
    eq(cn.nameFor('judy-alvarez'), nil); eq(cn.pools(), nil)
    -- An empty file, damaged JSON, a wrong version and a wrong shape.
    for _, content in ipairs({'', 'not json {', json.encode({version = 2, packs = {{id = 'medieval', names = {['judy-alvarez'] = 'X'}}}}),
        json.encode({version = 1, packs = 'oops'}), json.encode({version = 1, packs = {{id = 7, names = {}}, 'text', {id = 'a', names = 'no'}}})}) do
      files['runtime/content-names.json'], files['runtime/content-name-pools.json'] = content, content
      cn.reset()
      local again = roster()
      local _, n = cn.applyRows(again)
      eq(n, 0, 'changed for ' .. content:sub(1, 20)); eq(again[1].name, 'Judy Alvarez'); eq(again[2].aliases, nil)
      eq(cn.pools(), nil, 'pools for ' .. content:sub(1, 20))
    end
    for _, mode in ipairs(opened) do assert(mode:sub(1, 1) ~= 'w', 'something was written: ' .. mode) end
    eq(copy[1].name, 'Judy Alvarez')
  `);
});

test('a rename keeps the shipped name as an alias, once, and applying it again changes nothing', () => {
  lua(`
    names({{id = 'medieval', names = {['judy-alvarez'] = 'Judith of the Dreamweavers', ['npc-maelstrom-male'] = 'Reaver'}}})
    local cn = dofile('content-names.lua')
    local rows = roster()
    local _, changed = cn.applyRows(rows)
    eq(changed, 2)
    eq(rows[1].name, 'Judith of the Dreamweavers'); eq(rows[1].shippedName, 'Judy Alvarez')
    eq(table.concat(rows[1].aliases, '|'), 'Judy|Judy Alvarez')
    eq(rows[2].name, 'Panam Palmer', 'a character the pack does not name'); eq(rows[2].shippedName, nil)
    eq(rows[3].name, 'Reaver'); eq(table.concat(rows[3].aliases, '|'), 'Maelstrom Ganger Male', 'an archetype row without aliases gets one')
    local _, again = cn.applyRows(rows)
    eq(again, 0, 'idempotent'); eq(table.concat(rows[1].aliases, '|'), 'Judy|Judy Alvarez')
    eq(cn.nameFor('judy-alvarez'), 'Judith of the Dreamweavers'); eq(cn.nameFor('panam-palmer'), nil)
    eq(cn.label('npc-maelstrom-male', 'Maelstrom ganger'), 'Reaver'); eq(cn.label('npc-ncpd-male', 'NCPD officer'), 'NCPD officer')
    -- A row whose alias list already holds the shipped name (any spelling) does not get a duplicate; a row keyed by profileKey is found too.
    local rows2 = {{key = 'judy-alvarez', name = 'Judy Alvarez', aliases = {'  judy  alvarez '}}, {key = 'copy-1', profileKey = 'judy-alvarez', name = 'Judy Alvarez'}}
    cn.applyRows(rows2)
    eq(#rows2[1].aliases, 1); eq(rows2[2].name, 'Judith of the Dreamweavers')
    -- Rows that are no catalog rows are left alone.
    local odd = {'text', {key = 'judy-alvarez'}, {key = 'judy-alvarez', name = 'Judy Alvarez', kind = 'custom'}}
    cn.applyRows(odd); eq(odd[3].name, 'Judy Alvarez'); eq(odd[2].name, nil)
    eq(cn.applyRows(nil), nil)
  `);
});

test('the old name still finds the character: the catalog indexes name and aliases, and resolves to the new name', () => {
  lua(`
    names({{id = 'medieval', names = {['judy-alvarez'] = 'Judith of the Dreamweavers'}}})
    local cn = dofile('content-names.lua')
    local catalogApi = catalogFactory()
    local rows = roster()
    cn.applyRows(rows)
    local catalog = catalogApi.build(rows)
    local key, name = catalogApi.resolve(catalog, {name = ' JUDY ALVAREZ ', bodyType = 'WomanAverage', story = true})
    eq(key, 'judy-alvarez'); eq(name, 'Judith of the Dreamweavers', 'the name every consumer shows')
    eq((catalogApi.resolve(catalog, {name = 'Judith of the Dreamweavers'})), 'judy-alvarez')
    eq((catalogApi.resolve(catalog, {name = 'Judy'})), 'judy-alvarez', 'the shipped alias')
    eq((catalogApi.resolve(catalog, {record = 'Character.Judy'})), 'judy-alvarez')
    eq(catalog.keys['judy-alvarez'].name, 'Judith of the Dreamweavers')
  `);
});

test('a later pack wins per key, a pack that is switched off is ignored, and a switch is read from the add-on settings', () => {
  lua(`
    names({{id = 'a-medieval', names = {['judy-alvarez'] = 'Judith', ['panam-palmer'] = 'Pamela of the Wastes'}},
      {id = 'b-saga', names = {['judy-alvarez'] = 'Jodis the Skald'}}})
    local cn = dofile('content-names.lua')
    local rows = roster(); cn.applyRows(rows)
    eq(rows[1].name, 'Jodis the Skald', 'the second pack wins'); eq(rows[2].name, 'Pamela of the Wastes', 'the first still names what the second does not')
    eq(table.concat(rows[1].aliases, '|'), 'Judy|Judy Alvarez', 'the shipped name only, not the first pack\\'s')
    -- The second pack off: the first one's name.
    switch({['b-saga'] = {contentEnabled = false}})
    cn.reset()
    rows = roster(); cn.applyRows(rows)
    eq(rows[1].name, 'Judith'); eq(rows[2].name, 'Pamela of the Wastes')
    -- Both off: the shipped names, no alias added.
    switch({['b-saga'] = {contentEnabled = false}, ['a-medieval'] = {contentEnabled = false}})
    cn.reset()
    rows = roster(); local _, changed = cn.applyRows(rows)
    eq(changed, 0); eq(rows[1].name, 'Judy Alvarez'); eq(#rows[1].aliases, 1); eq(rows[1].shippedName, nil)
    -- Rows already renamed go back to the shipped name when the pack is off at the next application.
    switch({})
    cn.reset(); rows = roster(); cn.applyRows(rows); eq(rows[1].name, 'Jodis the Skald')
    switch({['a-medieval'] = {contentEnabled = false}, ['b-saga'] = {contentEnabled = false}})
    cn.reset(); cn.applyRows(rows); eq(rows[1].name, 'Judy Alvarez'); eq(rows[1].shippedName, nil)
    -- Without the add-on module a pack is on, as it is by default.
    convaiAddons = nil
    cn.reset(); rows = roster(); cn.applyRows(rows); eq(rows[1].name, 'Jodis the Skald')
  `);
});

test('the Companion Manager finds a renamed character by the new and by the old name, in the characters, the party and the model browser', () => {
  run(`${managerFixture}
    local originalDofile = dofile
    local contentSource = function() ${contentSource}
    end
    dofile = function(path) if path == 'content-names.lua' then return contentSource() end return originalDofile(path) end
    -- The names file as the bridge writes it (this fixture decodes only its own tokens).
    jsonFixtures.names = {version = 1, packs = {{id = 'medieval', names = {['person-3'] = 'Maple Quill', ['viktor-vektor'] = 'Victor the Leech'}}}}
    files['runtime/content-names.json'] = 'names'
    extras = {{key = 'viktor-vektor', name = 'Viktor Vektor', record = 'Character.Victor_Vector', profileKey = 'viktor-vektor'}}
    files['manager-characters.json'] = 'extras'
    local rows = {}
    for _, profile in ipairs(profiles) do rows[#rows + 1] = profile end
    for _, profile in ipairs(rows) do if profile.key == 'person-3' then profile.records = {'Character.Model_3'} end end
    -- What init.lua does with the roster, once, before it hands it to the manager.
    dofile('content-names.lua').applyRows(rows)
    manager.configure(api, rows); manager.prepare(player)
    assert(defs['viktor-vektor'].name == 'Victor the Leech', 'the manager-characters.json definition carries the new name: ' .. tostring(defs['viktor-vektor'].name))
    local function found(query)
      request('tab:characters'); request('search:' .. query)
      local labels = {}
      for _, row in ipairs(player.rows) do labels[#labels + 1] = row.label end
      return table.concat(labels, '|')
    end
    assert(found('maple quill') == 'Maple Quill', found('maple quill'))
    assert(found('Person 03') == 'Maple Quill', 'the old name finds it too: ' .. found('Person 03'))
    assert(found('person-3') :find('Maple Quill', 1, true), 'the key too')
    assert(found('nobody here') == '')
    -- The party tab: a copy invited as that character.
    request('search:')
    local serial = api.spawn('person-3'); members[#members].state = 'ready'
    request('tab:party'); request('search:Person 03')
    assert(#player.rows == 1 and player.rows[1].label:find('Maple Quill', 1, true), 'the party finds the copy by the old name')
    request('search:Maple'); assert(#player.rows == 1)
    -- The model browser: the model of Character.Model_3 is named by the profile (the new name) and still found by the old one.
    request('search:'); request('tab:models')
    for _ = 1, 130 do manager.update(player, 0.1) end
    request('search:Maple Quill'); assert(#player.rows == 1 and player.rows[1].label == 'Maple Quill', 'new name in the model browser')
    request('search:Person 03'); local count = 0
    for _, row in ipairs(player.rows) do if row.label == 'Maple Quill' then count = count + 1 end end
    assert(count == 1, 'the old name finds the model')
  `);
});

test('name pools: the last enabled pack that has some replaces the shipped pools; blocked names are folded as the build does', () => {
  lua(`
    local function pool(prefix)
      local cultures = {}
      for _, culture in ipairs({'african-american', 'arabic', 'chinese', 'corpo-anglo', 'filipino', 'french', 'german-nordic', 'haitian',
          'irish-working', 'japanese', 'korean', 'latino', 'nomad-american', 'slavic', 'south-asian', 'west-african'}) do
        cultures[culture] = {male = {prefix .. 'ric', prefix .. 'ran'}, female = {prefix .. 'owen', prefix .. 'aud'},
          surnames = {'Thatcher', 'Fletcher'}, handles = {'Stag', 'Raven'}}
      end
      local styles = {}
      for _, style in ipairs({'maelstrom', 'animals', 'moxes', 'valentinos', 'tyger-claws', 'voodoo-boys', '6th-street', 'scavengers', 'nomad', 'street-generic'}) do
        styles[style] = {'Hound', 'Wolf'}
      end
      return {version = 1, cultures = cultures, handleStyles = styles, blockedFullNames = {'Zoë Brandt', 'ÉMILE Zola', 'Bjørn Ø'}}
    end
    files['runtime/content-name-pools.json'] = json.encode({version = 1, packs = {{id = 'medieval', pools = pool('Al')}, {id = 'saga', pools = pool('Bo')}}})
    local cn = dofile('content-names.lua')
    local pools = cn.pools()
    eq(pools.cultures['latino'].male[1], 'Boric', 'the last enabled pack'); eq(pools.cultures['slavic'].surnames[2], 'Fletcher')
    eq(pools.styles['nomad'][1], 'Hound'); eq(pools.source, 'content-pack')
    -- The blocked list: the ASCII-lowered name and the accent-folded one, like scripts/Build-NpcNamePools.mjs luaSource.
    assert(pools.blocked['zoë brandt'] and pools.blocked['zoe brandt'], 'accent folded')
    assert(pools.blocked['Émile zola'] and pools.blocked['emile zola'], 'only ASCII letters are lowered, as in the build; the folded form is plain')
    assert(pools.blocked['bjørn Ø'], 'letters that do not decompose stay')
    eq(cn.fold('Zoë Brandt'), 'zoe brandt'); eq(cn.fold('Ångström'), 'angstrom'); eq(cn.fold('Cariño'), 'carino'); eq(cn.fold('Sirèn'), 'siren')
    -- The first pack alone when the second is off, the shipped pools (nil) when both are.
    switch({saga = {contentEnabled = false}}); cn.reset(); eq(cn.pools().cultures['latino'].male[1], 'Alric')
    switch({saga = {contentEnabled = false}, medieval = {contentEnabled = false}}); cn.reset(); eq(cn.pools(), nil)
    -- A pack whose pools cannot serve (no corpo-anglo, an empty list) is skipped for the one before it.
    local broken = pool('Cy'); broken.cultures['corpo-anglo'] = nil
    local empty = pool('Di'); empty.cultures['latino'].male = {}
    files['runtime/content-name-pools.json'] = json.encode({version = 1, packs = {{id = 'medieval', pools = pool('Al')}, {id = 'saga', pools = broken}}})
    switch({}); cn.reset(); eq(cn.pools().cultures['latino'].male[1], 'Alric')
    files['runtime/content-name-pools.json'] = json.encode({version = 1, packs = {{id = 'saga', pools = empty}}})
    cn.reset(); local p = cn.pools(); assert(p.cultures['latino'] == nil and p.cultures['slavic'] ~= nil, 'a culture without a first-name list is dropped, the others stay')
  `);
  // The Lua fold is the build's fold on the names the pools carry.
  for (const name of ['Zoë Brandt', 'ÉMILE Zola', 'Cariño', 'Sirèn', 'Toño', 'Élodie', 'Łukasz', 'Søren', 'Jürgen Müller', 'Mañuel']) {
    lua(`eq(dofile('content-names.lua').fold(${JSON.stringify(name)}), ${JSON.stringify(jsFold(name))}, ${JSON.stringify(name)})`);
  }
});

test('the generator names new pedestrians from the pack pools while the pack is on, and from the shipped pools when it is off', () => {
  lua(`
    local function pool(prefix)
      local cultures = {}
      for _, culture in ipairs({'african-american', 'arabic', 'chinese', 'corpo-anglo', 'filipino', 'french', 'german-nordic', 'haitian',
          'irish-working', 'japanese', 'korean', 'latino', 'nomad-american', 'slavic', 'south-asian', 'west-african'}) do
        cultures[culture] = {male = {prefix .. 'ric', prefix .. 'ran'}, female = {prefix .. 'owen', prefix .. 'aud'},
          surnames = {'Thatcher', 'Fletcher'}, handles = {'Stag', 'Raven'}}
      end
      local styles = {}
      for _, style in ipairs({'maelstrom', 'animals', 'moxes', 'valentinos', 'tyger-claws', 'voodoo-boys', '6th-street', 'scavengers', 'nomad', 'street-generic'}) do
        styles[style] = {'Hound', 'Wolf'}
      end
      return {version = 1, cultures = cultures, handleStyles = styles, blockedFullNames = {}}
    end
    files['runtime/content-name-pools.json'] = json.encode({version = 1, packs = {{id = 'medieval', pools = pool('Al')}}})
    local npcNames = dofile('npc-names.lua')
    local function service()
      return npcNames.new({entity = function(npc) return npc.id end, inspect = function() return {gender = 'MALE', base = 'merc', category = 'faction'} end,
        storePath = 'runtime/npc-names.json', legacyPath = false, waiting = function() return false end})
    end
    local shippedPools = poolsFactory()
    local function expected(pools, id) return npcNames.generate(pools, {gender = 'MALE', base = 'merc', category = 'faction'}, id .. '|').name end
    -- On: the pack's names.
    local on = service()
    local name = on.nameFor({id = '9001ULL'}, 'talk')
    assert(name:find('^Al') and (name:find('Thatcher') or name:find('Fletcher')), 'a pack name: ' .. tostring(name))
    local first = name
    -- Off: the shipped pools; the same entity gets the name the shipped generator makes.
    switch({medieval = {contentEnabled = false}})
    dofile('content-names.lua').reset()
    local off = service()
    local shippedName = off.nameFor({id = '9001ULL'}, 'talk')
    eq(shippedName, expected(shippedPools, '9001ULL'), 'shipped pools when off')
    assert(not shippedName:find('^Al') and shippedName ~= first)
    -- No pools file at all: the shipped pools, unchanged.
    files['runtime/content-name-pools.json'] = nil
    switch({}); dofile('content-names.lua').reset()
    eq(service().nameFor({id = '9001ULL'}, 'talk'), shippedName)
    -- An explicit loader (the tests of the service, an embedder) is never replaced by a pack.
    files['runtime/content-name-pools.json'] = json.encode({version = 1, packs = {{id = 'medieval', pools = pool('Al')}}})
    dofile('content-names.lua').reset()
    local explicit = npcNames.new({entity = function(npc) return npc.id end, inspect = function() return {gender = 'MALE', base = 'merc', category = 'faction'} end,
      loadPools = function() return shippedPools end})
    eq(explicit.nameFor({id = '9001ULL'}, 'talk'), shippedName)
  `);
});

test('a vendor that already has a saved name keeps it; the pack pools name the vendors made after', () => {
  lua(`
    local function pool(prefix)
      local cultures = {}
      for _, culture in ipairs({'corpo-anglo', 'latino', 'japanese', 'slavic'}) do
        cultures[culture] = {male = {prefix .. 'ric'}, female = {prefix .. 'owen'}, surnames = {'Thatcher'}, handles = {'Stag'}}
      end
      return {version = 1, cultures = cultures, handleStyles = {['street-generic'] = {'Hound'}}, blockedFullNames = {}}
    end
    local vendor = function() return {gender = 'FEMALE', base = 'food-vendor', category = 'vendor', memoryKey = 'Character.food_01'} end
    local newVendor = function() return {gender = 'FEMALE', base = 'food-vendor', category = 'vendor', memoryKey = 'Character.food_02'} end
    local npcNames = dofile('npc-names.lua')
    local current = vendor
    local function service()
      return npcNames.new({entity = function(npc) return npc.id end, inspect = function() return current() end,
        storePath = 'runtime/npc-names.json', legacyPath = false, waiting = function() return false end})
    end
    -- A vendor named before the pack: its name is kept in the file.
    local before = service().nameFor({id = '1ULL'}, 'talk')
    assert(not before:find('^Al'))
    files['runtime/content-name-pools.json'] = json.encode({version = 1, packs = {{id = 'medieval', pools = pool('Al')}}})
    dofile('content-names.lua').reset()
    eq(service().nameFor({id = '1ULL'}, 'talk'), before, 'the saved name stays')
    current = newVendor
    local after = service().nameFor({id = '2ULL'}, 'talk')
    assert(after:find('^Alowen') and after:find('Thatcher'), 'a vendor made after gets a pack name: ' .. after)
  `);
});

test('the load sites hand their rows to the module: the roster, the archetype label, the phone contacts, the holocall catalog and the manager', () => {
  const init = read('../mod/init.lua'), companions = read('../mod/companions.lua'), holocall = read('../mod/holocall.lua'), manager = read('../mod/manager.lua');
  // The add-on module is loaded before the catalogs, so the switch can be read when they load.
  assert.ok(init.indexOf("pcall(dofile, 'addons.lua')") > 0 && init.indexOf("pcall(dofile, 'addons.lua')") < init.indexOf("dofile('companions.lua')"), 'addons.lua loads before companions.lua');
  assert.match(init, /pcall\(dofile, 'content-names\.lua'\)[\s\S]{0,200}pcall\(contentNames\.applyRows, profiles\)/, 'the roster');
  assert.match(init, /convaiContentNames\.label\(key, label\)/, 'the archetype labels');
  assert.match(companions, /contentNames\.applyRows, rows/, 'the phone contacts and built-in definitions');
  assert.match(holocall, /contentNames\.applyRows, rows/, 'the holocall contacts');
  assert.match(manager, /contentNames\.applyRows, extras/, 'manager-characters.json');
  // The packaged file lists carry the module.
  for (const list of ['../packaging/release-plan.json', '../scripts/development-files.json']) assert.match(read(list), /mod\/content-names\.lua/, list);
  assert.match(read('../packaging/runtime-exchange.json'), /"content-names\.json"[\s\S]*"content-name-pools\.json"|"content-name-pools\.json"[\s\S]*"content-names\.json"/);
});
