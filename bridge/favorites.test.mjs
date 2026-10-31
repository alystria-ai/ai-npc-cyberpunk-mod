import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {run, nsuiHarness, source, storage, favoritesSource} from './manager-fixture.mjs';

// Favorites: the per-row Add to favorites / Remove from favorites buttons of Characters to invite and the Model browser (mod/favorites.lua, the
// page logic in mod/manager-ui.lua, drawn by both hosts, mod/nsui.lua and mod/mcm-host.lua).
const everything = {
  'service-status.lua': source('service-status.lua'), 'character-editor.lua': source('character-editor.lua'),
  'convai-paid-tier.lua': source('convai-paid-tier.lua'), 'support-report.lua': source('support-report.lua'),
  'setup-check.lua': source('setup-check.lua'), 'custom-provider.lua': source('custom-provider.lua'),
};

// ---- mod/favorites.lua on its own ---------------------------------------------------------------------------------------------------

const moduleHarness = `${storage}
  local favorites = (function() ${favoritesSource} end)()
  local function keys(list) local out = {} for _, item in ipairs(list) do out[#out + 1] = item.key end return table.concat(out, ',') end
  local people = {}
  for index = 1, 6 do people[index] = {key = 'k' .. index, name = 'Name ' .. index} end
`;

test('a favorite is saved in runtime/favorites.json and read back by a new session', () => run(`${moduleHarness}
  assert(favorites.count('characters') == 0)
  assert(favorites.set('characters', 'k4') == true)
  assert(favorites.set('characters', 'k2') == true)
  assert(favorites.set('models', 'k4') == true, 'the two pages keep their own favorites')
  assert(favorites.isFavorite('characters', 'k2') and not favorites.isFavorite('characters', 'k1'))
  assert(#fileWrites == 3 and fileWrites[3].path == 'runtime/favorites.json', 'one small write per press, in the mod folder: ' .. #fileWrites)
  -- A new session (the file is all that is left).
  local saved = files['runtime/favorites.json']
  assert(saved ~= nil)
  local again = (function() ${favoritesSource.replace(/^if type\(convaiFavorites\).*\r?\n/m, '')} end)()
  assert(again ~= favorites)
  assert(again.isFavorite('characters', 'k4') and again.isFavorite('characters', 'k2') and not again.isFavorite('characters', 'k1'))
  assert(again.isFavorite('models', 'k4') and again.count('models') == 1)
  -- Turned off again.
  local now, kept = again.set('characters', 'k4')
  assert(now == false and kept == true and again.count('characters') == 1)
`));

test('the revision changes with every change of the favorites and with nothing else', () => run(`${moduleHarness}
  local start = favorites.revision()
  assert(favorites.revision() == start, 'reading changes nothing')
  favorites.set('characters', 'k5')
  local after = favorites.revision()
  assert(after ~= start)
  favorites.set('characters', 'k5', true)
  assert(favorites.revision() == after, 'already a favorite: no change')
  favorites.set('characters', 'k5')
  assert(favorites.revision() ~= after)
`));

test('a missing, empty or damaged file is no favorites; a file that cannot be written keeps them for the session and says so', () => run(`${moduleHarness}
  assert(favorites.count('characters') == 0 and favorites.isFavorite('characters', 'k1') == false, 'no file')
  favorites.reset()
  files['runtime/favorites.json'] = ''
  assert(favorites.count('characters') == 0, 'empty')
  favorites.reset()
  files['runtime/favorites.json'] = 'this is not json'
  assert(favorites.count('characters') == 0 and favorites.count('models') == 0, 'damaged')
  favorites.reset()
  jsonFixtures['mixed'] = {version = 1, characters = {good = true, [''] = true, bad = 'yes', [7] = true}, models = 5}
  files['runtime/favorites.json'] = 'mixed'
  assert(favorites.count('characters') == 1 and favorites.isFavorite('characters', 'good') and favorites.count('models') == 0, 'only valid keys are taken')
  failSave = true
  local now, kept = favorites.set('characters', 'k1')
  assert(now == true and kept == false and favorites.isFavorite('characters', 'k1') and favorites.lastError() ~= nil, 'kept in memory, not on disk')
  assert(favorites.set('nowhere', 'k1') == nil and favorites.set('characters', '') == nil and favorites.set('characters', 5) == nil)
`));

test('a page holds at most 500 favorites', () => run(`${moduleHarness}
  for index = 1, 500 do assert(favorites.set('characters', 'key' .. index) == true) end
  local now, kept, why = favorites.set('characters', 'one-more')
  assert(now == false and kept == false and why == 'full' and favorites.count('characters') == 500)
  assert(favorites.set('characters', 'key1') == false, 'a favorite can still be removed')
  assert(favorites.set('characters', 'one-more') == true)
`));

// ---- Native Settings UI ---------------------------------------------------------------------------------------------------------------

const nsHarness = (options = {}) => nsuiHarness({modules: everything, ...options}) + `
  convaiNotices.configure(function() return manager.developerMode() end)
  local clock = 1000
  os.clock = function() return clock end
  local timeBase = os.time()
  os.time = function() return timeBase + math.floor(clock - 1000) end
  local function frames(count, step)
    for _ = 1, count or 6 do clock = clock + (step or 0.1); managerUi.update(player, true) end
    loaded = registered.loadMod('manager')
  end
  -- A button by its label and its text (a character has two rows of one name once she is in the party).
  local function button(label, text)
    for _, key in pairs(ns.data[ns.currentTab].keys) do
      for _, option in pairs(ns.data[ns.currentTab].subcategories[key].options) do
        if option.label == label and (text == nil or option.buttonText == text or option.buttonText:sub(1, #text + 1) == text .. ' ') then return option end
      end
    end
  end
  local function press(label, text)
    ns.interact.press(assert(button(label, text), 'no row: ' .. label .. ' / ' .. tostring(text))); frames(3); ns.verify()
  end
  local function outline() return table.concat(ns.outline(), ' | ') end
  -- The rows of a section as "label = button text".
  local function section(id)
    local out = {}
    for _, found in ipairs(ns.sections()) do
      if found.id == id then
        for _, option in ipairs(found.options) do
          if option.type == 'button' and option.buttonText ~= '' and option.buttonText ~= nil and option.label:sub(1, 5) ~= 'Page ' then
            out[#out + 1] = option.label .. ' = ' .. option.buttonText
          end
        end
      end
    end
    return table.concat(out, ' | ')
  end
  local function saved() return jsonFixtures[files['runtime/favorites.json']] end
  frames(3)
`;

test('Native Settings UI: a character not invited has one Invite row; once she is in the party the row is Add to favorites with Add copy right under it', () => run(`${nsHarness()}
  press('Main characters to invite')
  assert(not button('Add to favorites') and not ns.find('Favorites'), 'nothing to favorite before an invitation: ' .. outline())
  assert(section('characters'):find('Person 05 = Invite | Person 06 = Invite', 1, true), section('characters'))
  press('Person 05', 'Invite')
  local list = section('characters')
  assert(list:find('Person 04 = Invite | Person 05 = Add to favorites | Person 05 = Add copy (1) | Person 06 = Invite', 1, true), list)
  -- The old page button is gone: only Back is in the first section.
  assert(#ns.sections()[1].options == 1 and ns.sections()[1].options[1].label == 'Back to Companion Manager', outline())
`));

test('Native Settings UI: Add to favorites moves her to the Favorites block at the top, her list row keeps Add copy, and Remove from favorites puts it back', () => run(`${nsHarness()}
  press('Main characters to invite')
  press('Person 05', 'Invite')
  press('Person 05', 'Add to favorites')
  assert(outline():find('is now a favorite', 1, true), outline())
  local sections = ns.sections()
  assert(sections[1].options[1].label == 'Back to Companion Manager' and sections[3].label == 'Favorites', 'the block is the first after Back and the Search section: ' .. outline())
  assert(section(sections[3].id) == 'Person 05 = Add copy (1) | Remove Person 05 from favorites = Remove', section(sections[3].id))
  local list = section(sections[4].id)
  assert(list:find('Person 04 = Invite | Person 05 = Add copy (1) | Person 06 = Invite', 1, true) and not list:find('Add to favorites', 1, true), list)
  assert(saved() and saved().characters['person-5'] == true and saved().version == 1, 'saved for the next session')
  -- Her Add copy row in the block works like the one in the list.
  press('Person 05', 'Add copy')
  assert(section(ns.sections()[4].id):find('Person 05 = Add copy (2)', 1, true), outline())
  press('Remove Person 05 from favorites')
  assert(not ns.find('Favorites') and #ns.sections() == 3, 'the block is gone with its last favorite: ' .. outline())
  assert(section(ns.sections()[3].id):find('Person 05 = Add to favorites | Person 05 = Add copy (2)', 1, true), 'back to the two rows: ' .. outline())
  assert(outline():find('is no longer a favorite', 1, true) and next(saved().characters) == nil)
`));

test('Native Settings UI: a favorite that is not invited has Invite in the block, the block is on page 1 only, and the page slider tells what a page holds', () => run(`${nsHarness()}
  files['runtime/favorites.json'] = 'seed'
  jsonFixtures['seed'] = {version = 1, characters = {['person-20'] = true, ['person-3'] = true}, models = {}}
  convaiFavorites.reset(); core.refresh(); frames(6)
  press('Main characters to invite')
  local block = section(ns.sections()[3].id)
  assert(ns.sections()[3].label == 'Favorites' and block:find('Remove Person 03 from favorites = Remove', 1, true), outline())
  assert(block:find('Person 03 = Invite | Remove Person 03 from favorites = Remove | Person 20 = Invite | Remove Person 20 from favorites = Remove', 1, true), block)
  -- The slider's description says where the player is, and the second page has no Favorites block.
  local function rangeHelp() return ns.find('Page 1 / 2') and ns.find('Page 1 / 2').desc or ns.find('Page 2 / 2').desc end
  assert(rangeHelp():find('Page 1 of 2: characters 1 to 12.', 1, true), rangeHelp())
  ns.interact.slide(ns.find('Page'), 2); frames(6); ns.verify()
  assert(not ns.find('Favorites') and #ns.sections() == 3, outline())
  assert(rangeHelp():find('Page 2 of 2: characters 13 to', 1, true), rangeHelp())
`));

test('Native Settings UI: favorites come back in a new session, and a favorite that cannot be saved still works until the game closes', () => run(`${nsHarness()}
  press('Main characters to invite')
  press('Person 09', 'Invite'); press('Person 09', 'Add to favorites')
  assert(saved().characters['person-9'] == true)
  -- The session ends; the file is all that is left.
  convaiFavorites.reset(); core.refresh(); frames(6)
  assert(ns.sections()[3].label == 'Favorites' and section(ns.sections()[3].id):find('Person 09 = Add copy (1)', 1, true), 'read back from the file: ' .. outline())
  failSave = true
  press('Person 07', 'Invite'); press('Person 07', 'Add to favorites')
  assert(section(ns.sections()[3].id):find('Person 07 = Add copy (1) | Remove Person 07 from favorites = Remove | Person 09', 1, true), 'in the order of the list: ' .. outline())
  assert(core.feedback():find('could not be saved', 1, true), core.feedback())
`));

test('Native Settings UI: the Model browser has the same rows', () => run(`${nsHarness()}
  press('Model browser')
  frames(130)
  ns.verify()
  assert(#ns.sections()[1].options == 1, 'no page button beside Back')
  local list = ns.sections()[#ns.sections()]
  local name
  for _, option in ipairs(list.options) do if option.type == 'button' and option.buttonText == 'Invite' then name = option.label; break end end
  assert(name, outline():sub(1, 400))
  press(name, 'Invite')
  assert(button(name, 'Add to favorites') and button(name, 'Add copy'), 'the rows once it is in the party')
  press(name, 'Add to favorites')
  assert(ns.sections()[2].label == 'Favorites', outline():sub(1, 400))
  local block = section(ns.sections()[2].id)
  assert(block:sub(1, #name + 15) == name .. ' = Add copy (1)' and block:find('| Remove ', 1, true) and block:find(' = Remove', 1, true) and not block:find('Remove from favorites = Remove', 1, true), block)
  assert(saved().models and next(saved().models) ~= nil and next(saved().characters) == nil, 'the model page keeps its own list')
  -- The next page of the list has no block.
  ns.interact.slide(ns.find('Page'), 2); frames(6)
  assert(not ns.find('Favorites'), 'the block is on page 1 only')
  local help
  for _, option in ipairs(ns.sections()[2].options) do if option.label:sub(1, 7) == 'Page 2 ' then help = option.desc end end
  assert(help and help:find('models 13 to 24', 1, true), tostring(help))
`));

// ---- Mod Configuration Menu ---------------------------------------------------------------------------------------------------------------

const mcmHarness = () => nsuiHarness({modules: everything, mcm: {version: '0.10.5'}, screen: false}) + `
  convaiNotices.configure(function() return manager.developerMode() end)
  local clock = 1000
  os.clock = function() return clock end
  local timeBase = os.time()
  os.time = function() return timeBase + math.floor(clock - 1000) end
  local function frames(count, step)
    for _ = 1, count or 8 do clock = clock + (step or 0.1); managerUi.update(player, true); if mcm then mcm.update() end end
  end
  local function press(label)
    local ok, why = mcm.press(label)
    assert(ok, 'press ' .. label .. ': ' .. tostring(why))
    frames(2)
  end
  local function footerLabels()
    local list = {}
    for _, button in ipairs(mcm.layout().footer) do list[#list + 1] = button.label end
    return table.concat(list, ' | ')
  end
  -- The buttons of the page as "id = button text".
  local function rowsText()
    local list = {}
    for _, row in ipairs(mcm.rows()) do
      if row.type == 'action' then list[#list + 1] = row.id .. ' = ' .. tostring(row.value) end
    end
    return table.concat(list, ' | ')
  end
  local function categoryNames() return table.concat(mcm.categories(), ' | ') end
  local function saved() return jsonFixtures[files['runtime/favorites.json']] end
  frames(3)
  mcm.openScreen()
  frames(2)
`;

test('Mod Configuration Menu: the same rows, no favorite button in the footer, and the page buttons tell which page they go to', () => run(`${mcmHarness()}
  press('Main characters to invite')
  assert(footerLabels() == 'Previous page | Next page | Back', footerLabels())
  press('invite:person-5')
  local text = rowsText()
  assert(text:find('favorite:add:person-5 = Add to favorites | invite:person-5 = Add copy (1)', 1, true), text)
  press('favorite:add:person-5')
  assert(categoryNames():find('^Companion Manager | Search characters | Favorites | Main characters to invite'), categoryNames())
  text = rowsText()
  assert(text:find('invite:favorite:person-5 = Add copy (1) | favorite:remove:person-5 = Remove', 1, true), text)
  assert(saved().characters['person-5'] == true)
  -- The page buttons: the description panel says which page they go to.
  local nextHelp = mcm.row('ui:page:next').description
  assert(nextHelp:find('Page 1 of 2: characters 1 to 12.', 1, true) and nextHelp:find('Press to go to page 2 of 2: characters 13 to', 1, true), nextHelp)
  assert(mcm.row('ui:page:previous').description:find('This is the first page.', 1, true), mcm.row('ui:page:previous').description)
  press('ui:page:next')
  assert(mcm.row('ui:page:next').description:find('This is the last page.', 1, true), mcm.row('ui:page:next').description)
  assert(mcm.row('ui:page:previous').description:find('Press to go to page 1 of 2: characters 1 to 12.', 1, true), mcm.row('ui:page:previous').description)
  assert(not categoryNames():find('Favorites', 1, true), 'page 2 has no block')
`));

test('without mod/favorites.lua the two pages have no favorite rows and nothing else changes', () => run(`${nsuiHarness({modules: everything, absent: ['favorites.lua']})}
  local clock = 1000
  os.clock = function() return clock end
  local function frames(count) for _ = 1, count or 6 do clock = clock + 0.1; managerUi.update(player, true) end end
  frames(3)
  ns.interact.press(ns.find('Main characters to invite')); frames(4)
  assert(not ns.find('Add to favorites') and ns.find('Back to Companion Manager') and ns.find('Person 01'), table.concat(ns.outline(), ' | '))
  ns.interact.press(ns.find('Person 05')); frames(4)
  assert(not ns.find('Add to favorites'), 'even in the party: ' .. table.concat(ns.outline(), ' | '))
`));

// ---- Side characters to invite (docs/SIDE_CHARACTERS.md) ------------------------------------------------------------------------------
// The Side characters page has the same Favorites block as the main list. The favorites are the same set ('characters': a key is in one list
// only, and the phone's Chat tab stars the same keys), and the block is worked out from the favorite keys, not from the 557 side characters.

const sideRoster = `
  local roster = {}
  for _, profile in ipairs(profiles) do roster[#roster + 1] = profile end
  for index = 1, 30 do
    roster[#roster + 1] = {key = 'side-' .. index, name = ({'Alan', 'Bea', 'Cora'})[(index - 1) // 10 + 1] .. ' Side ' .. string.format('%02d', index), kind = 'named',
      invite = true, minor = true, records = {'Character.side_' .. index}}
  end
  manager.configure(api, roster)
  core.refresh(); frames(4)
`;

test('Native Settings UI: a side character has Invite, then Add to favorites with Add copy under it, and a Favorites block above the list', () => run(`${nsHarness()}
  ${sideRoster}
  press('Side characters to invite')
  assert(not ns.find('Favorites') and #ns.sections() == 3, 'nothing to favorite before an invitation: ' .. outline())
  press('Alan Side 01', 'Invite')
  local list = section(ns.sections()[3].id)
  assert(list:find('Alan Side 01 = Add to favorites | Alan Side 01 = Add copy (1) | Alan Side 02 = Invite', 1, true), list)
  press('Alan Side 01', 'Add to favorites')
  assert(outline():find('is now a favorite', 1, true), outline())
  local sections = ns.sections()
  assert(sections[1].options[1].label == 'Back to Companion Manager' and sections[3].label == 'Favorites', 'the block follows Back and the Search section: ' .. outline())
  assert(section(sections[3].id) == 'Alan Side 01 = Add copy (1) | Remove Alan Side 01 = Remove', section(sections[3].id))
  local rest = section(sections[4].id)
  assert(rest:find('Alan Side 01 = Add copy (1) | Alan Side 02 = Invite', 1, true) and not rest:find('Add to favorites', 1, true), rest)
  assert(saved().characters['side-1'] == true and saved().version == 1, 'saved the way the main list saves')
  -- Her Add copy row in the block works like the one in the list; Remove puts the two rows back.
  press('Alan Side 01', 'Add copy')
  assert(section(ns.sections()[3].id):find('Alan Side 01 = Add copy (2)', 1, true), outline())
  press('Remove Alan Side 01')
  assert(not ns.find('Favorites') and #ns.sections() == 3, outline())
  assert(section(ns.sections()[3].id):find('Alan Side 01 = Add to favorites | Alan Side 01 = Add copy (2)', 1, true), outline())
  assert(next(saved().characters) == nil)
`));

test('Native Settings UI: side favorites come back in a new session, stay out of the main page, and a favorite that is not invited has Invite in the block', () => run(`${nsHarness()}
  ${sideRoster}
  files['runtime/favorites.json'] = 'seed'
  jsonFixtures['seed'] = {version = 1, characters = {['side-12'] = true, ['side-2'] = true, ['person-4'] = true}, models = {}}
  convaiFavorites.reset(); core.refresh(); frames(6)
  press('Main characters to invite')
  assert(section(ns.sections()[3].id) == 'Person 04 = Invite | Remove Person 04 from favorites = Remove', 'the main block holds only main characters: ' .. outline())
  press('Back to Companion Manager')
  press('Side characters to invite')
  local block = section(ns.sections()[3].id)
  assert(ns.sections()[3].label == 'Favorites', outline())
  assert(block == 'Alan Side 02 = Invite | Remove Alan Side 02 = Remove | Bea Side 12 = Invite | Remove Bea Side 12 = Remove', 'in list order: ' .. block)
  -- The block is on page 1 only.
  ns.interact.slide(ns.find('Page'), 2); frames(6)
  assert(not ns.find('Favorites') and #ns.sections() == 3, outline())
`));

test('Native Settings UI: the side Favorites block follows the Starts with group and the search', () => run(`${nsHarness()}
  ${sideRoster}
  files['runtime/favorites.json'] = 'seed'
  jsonFixtures['seed'] = {version = 1, characters = {['side-1'] = true, ['side-12'] = true, ['side-23'] = true}, models = {}}
  convaiFavorites.reset(); core.refresh(); frames(6)
  press('Side characters to invite')
  local function names()
    local out = {}
    for name in section(ns.sections()[3].id):gmatch('([^|]-) = Invite') do out[#out + 1] = name:gsub('^%s+', '') end
    return table.concat(out, ' | ')
  end
  assert(names() == 'Alan Side 01 | Bea Side 12 | Cora Side 23', names())
  assert(core.setUi('ui:group', 3)); frames(4)
  assert(ns.sections()[3].label == 'Favorites' and names() == 'Bea Side 12', 'only the letter B: ' .. names())
  assert(core.setUi('ui:group', 4)); frames(4)
  assert(names() == 'Cora Side 23', names())
  assert(core.setSearch('side 01')); frames(4)
  assert(ns.sections()[3].label == 'Favorites' and names() == 'Alan Side 01', 'a search covers all letters: ' .. names())
  assert(core.setSearch('nobody')); frames(4)
  assert(not ns.find('Favorites'), 'no favorite matches: ' .. outline())
`));

test('the side Favorites block is worked out from the favorite keys: it reads the favorites\' own entries of a 557 long list, never the list', () => run(`${nsHarness()}
  local reads, store, position, all = 0, {}, {}, {}
  for index = 1, 557 do store[index] = {key = 'side-' .. index, name = 'Name ' .. index}; position['side-' .. index] = index end
  setmetatable(all, {__index = function(_, index) reads = reads + 1; return store[index] end, __len = function() return #store end})
  for _, key in ipairs({'side-400', 'side-12', 'side-300', 'person-1'}) do convaiFavorites.set('characters', key) end
  local picked = core.sideFavorites(all, {index = position}, false, nil)
  assert(#picked == 3 and picked[1].key == 'side-12' and picked[2].key == 'side-300' and picked[3].key == 'side-400', 'list order, side characters only')
  assert(reads == 3, 'three reads for three favorites, not 557: ' .. reads)
  reads = 0
  assert(#core.sideFavorites(all, {index = position}, false, 'Z') == 0 and reads == 3, 'a letter group is checked on the favorites only')
  -- No favorites: nothing is read at all.
  for _, key in ipairs({'side-400', 'side-12', 'side-300', 'person-1'}) do convaiFavorites.set('characters', key, false) end
  reads = 0
  assert(#core.sideFavorites(all, {index = position}, false, nil) == 0 and reads == 0)
`));

test('Mod Configuration Menu: the side list has the same favorite rows, a Favorites category above the list, and no block on page 2', () => run(`${mcmHarness()}
  ${sideRoster}
  press('Side characters to invite')
  press('invite:side-1')
  assert(rowsText():find('favorite:add:side-1 = Add to favorites | invite:side-1 = Add copy (1)', 1, true), rowsText())
  press('favorite:add:side-1')
  assert(categoryNames():find('^Companion Manager | Search characters | Favorites | Side characters to invite'), categoryNames())
  assert(rowsText():find('invite:favorite:side-1 = Add copy (1) | favorite:remove:side-1 = Remove', 1, true), rowsText())
  assert(saved().characters['side-1'] == true)
  press('ui:page:next')
  assert(not categoryNames():find('Favorites', 1, true), 'page 2 has no block')
`));

// ---- The real roster (owner's live test 31 Oct: "Favorites missing on the side list") -----------------------------------------------------
// The fixtures above use 30 made-up side characters. This runs the page over the shipped game roster (characters/game-roster.json, 557 side
// characters, long names, characters with several records) in both hosts, so what the owner meets in the game is what is tested: the side list
// shows Add to favorites for a side character who has joined, the Favorites block above the list holds her on page 1, and the block follows
// her to the same place in a new session.
const luaText = value => "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
const realRoster = JSON.parse(readFileSync(new URL('../characters/game-roster.json', import.meta.url), 'utf8')).map(row => {
  const records = (row.records ?? []).map(luaText).join(', ');
  return `{key = ${luaText(row.key)}, name = ${luaText(row.name)}, kind = ${luaText(row.kind ?? 'named')}, records = {${records}}, invite = ${row.invite === false ? 'false' : 'true'}, minor = ${row.minor === true}}`;
});
const useRealRoster = `
  local roster = {${realRoster.join(',\n')}}
  manager.configure(api, roster)
  core.refresh(); frames(4)
  local sideCount = 0
  for _, profile in ipairs(roster) do if profile.minor and profile.invite then sideCount = sideCount + 1 end end
  assert(sideCount == 557, sideCount)
`;

test('real roster, Mod Configuration Menu: a side character who has joined has Add to favorites, then the Favorites block, on the first page and on a later page', () => run(`${mcmHarness()}
  ${useRealRoster}
  press('Side characters to invite')
  assert(categoryNames():find('Side characters to invite · 557 matching characters', 1, true), categoryNames())
  assert(not rowsText():find('favorite:', 1, true), 'nothing to favorite before anyone has joined: ' .. rowsText())
  press('invite:aiko-harada')
  assert(rowsText():find('favorite:add:aiko-harada = Add to favorites | invite:aiko-harada = Add copy (1)', 1, true), rowsText())
  press('favorite:add:aiko-harada')
  assert(categoryNames():find('^Companion Manager | Search characters | Favorites | Side characters to invite'), categoryNames())
  assert(rowsText():find('invite:favorite:aiko-harada = Add copy (1) | favorite:remove:aiko-harada = Remove', 1, true), rowsText())
  assert(saved().characters['aiko-harada'] == true)
  -- A later page has no block, and a character who joined on a later page gets the rows there.
  press('ui:page:next'); press('ui:page:next')
  assert(not categoryNames():find('Favorites', 1, true), categoryNames())
  local invitable
  for _, row in ipairs(mcm.rows()) do if row.type == 'action' and row.id:find('^invite:') and row.value == 'Invite' then invitable = row.id; break end end
  assert(invitable, rowsText())
  press(invitable)
  assert(rowsText():find('favorite:add:' .. invitable:sub(8) .. ' = Add to favorites', 1, true), rowsText())
  press('ui:page:previous'); press('ui:page:previous')
  assert(categoryNames():find('Favorites', 1, true) and rowsText():find('invite:favorite:aiko-harada', 1, true), 'back on page 1 the block is there')
`));

test('real roster, Native Settings UI: a side character who has joined has Add to favorites, then the Favorites block above the list', () => run(`${nsHarness()}
  ${useRealRoster}
  press('Side characters to invite')
  assert(not ns.find('Favorites') and #ns.sections() == 3, 'nothing to favorite before anyone has joined: ' .. outline())
  press('Aiko Harada', 'Invite')
  assert(button('Aiko Harada', 'Add to favorites') and button('Aiko Harada', 'Add copy'), outline():sub(1, 600))
  press('Aiko Harada', 'Add to favorites')
  local sections = ns.sections()
  assert(sections[3].label == 'Favorites', outline():sub(1, 600))
  -- Native Settings fits the label to the row: "Remove Aiko Harada from favorites" is too wide there, so it reads "Remove Aiko Harada".
  assert(section(sections[3].id) == 'Aiko Harada = Add copy (1) | Remove Aiko Harada = Remove', section(sections[3].id))
  assert(saved().characters['aiko-harada'] == true)
  -- The same favorite in a new session, with the page built again from the file.
  convaiFavorites.reset(); core.refresh(); frames(6)
  assert(ns.sections()[3].label == 'Favorites' and section(ns.sections()[3].id):find('Aiko Harada = Add copy (1)', 1, true), outline():sub(1, 600))
`));
