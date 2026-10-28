import {test} from 'node:test';
import assert from 'node:assert/strict';
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
  press('Characters to invite')
  assert(not button('Add to favorites') and not ns.find('Favorites'), 'nothing to favorite before an invitation: ' .. outline())
  assert(section('characters'):find('Person 05 = Invite | Person 06 = Invite', 1, true), section('characters'))
  press('Person 05', 'Invite')
  local list = section('characters')
  assert(list:find('Person 04 = Invite | Person 05 = Add to favorites | Person 05 = Add copy (1) | Person 06 = Invite', 1, true), list)
  -- The old page button is gone: only Back is in the first section.
  assert(#ns.sections()[1].options == 1 and ns.sections()[1].options[1].label == 'Back to Companion Manager', outline())
`));

test('Native Settings UI: Add to favorites moves her to the Favorites block at the top, her list row keeps Add copy, and Remove from favorites puts it back', () => run(`${nsHarness()}
  press('Characters to invite')
  press('Person 05', 'Invite')
  press('Person 05', 'Add to favorites')
  assert(outline():find('is now a favorite', 1, true), outline())
  local sections = ns.sections()
  assert(sections[1].options[1].label == 'Back to Companion Manager' and sections[2].label == 'Favorites', 'the block is the first after Back: ' .. outline())
  assert(section(sections[2].id) == 'Person 05 = Add copy (1) | Remove from favorites = Remove', section(sections[2].id))
  local list = section(sections[3].id)
  assert(list:find('Person 04 = Invite | Person 05 = Add copy (1) | Person 06 = Invite', 1, true) and not list:find('Add to favorites', 1, true), list)
  assert(saved() and saved().characters['person-5'] == true and saved().version == 1, 'saved for the next session')
  -- Her Add copy row in the block works like the one in the list.
  press('Person 05', 'Add copy')
  assert(section(ns.sections()[3].id):find('Person 05 = Add copy (2)', 1, true), outline())
  press('Remove from favorites')
  assert(not ns.find('Favorites') and #ns.sections() == 2, 'the block is gone with its last favorite: ' .. outline())
  assert(section(ns.sections()[2].id):find('Person 05 = Add to favorites | Person 05 = Add copy (2)', 1, true), 'back to the two rows: ' .. outline())
  assert(outline():find('is no longer a favorite', 1, true) and next(saved().characters) == nil)
`));

test('Native Settings UI: a favorite that is not invited has Invite in the block, the block is on page 1 only, and the page slider tells what a page holds', () => run(`${nsHarness()}
  files['runtime/favorites.json'] = 'seed'
  jsonFixtures['seed'] = {version = 1, characters = {['person-20'] = true, ['person-3'] = true}, models = {}}
  convaiFavorites.reset(); core.refresh(); frames(6)
  press('Characters to invite')
  local block = section(ns.sections()[2].id)
  assert(ns.sections()[2].label == 'Favorites' and block:find('Remove from favorites = Remove', 1, true), outline())
  assert(block:find('Person 03 = Invite | Remove from favorites = Remove', 1, true), block)
  -- The slider's description says where the player is, and the second page has no Favorites block.
  local function rangeHelp() return ns.find('Page 1 / 2') and ns.find('Page 1 / 2').desc or ns.find('Page 2 / 2').desc end
  assert(rangeHelp():find('Page 1 of 2: characters 1 to 12.', 1, true), rangeHelp())
  ns.interact.slide(ns.find('Page'), 2); frames(6); ns.verify()
  assert(not ns.find('Favorites') and #ns.sections() == 2, outline())
  assert(rangeHelp():find('Page 2 of 2: characters 13 to', 1, true), rangeHelp())
`));

test('Native Settings UI: favorites come back in a new session, and a favorite that cannot be saved still works until the game closes', () => run(`${nsHarness()}
  press('Characters to invite')
  press('Person 09', 'Invite'); press('Person 09', 'Add to favorites')
  assert(saved().characters['person-9'] == true)
  -- The session ends; the file is all that is left.
  convaiFavorites.reset(); core.refresh(); frames(6)
  assert(ns.sections()[2].label == 'Favorites' and section(ns.sections()[2].id):find('Person 09 = Add copy (1)', 1, true), 'read back from the file: ' .. outline())
  failSave = true
  press('Person 07', 'Invite'); press('Person 07', 'Add to favorites')
  assert(section(ns.sections()[2].id):find('Person 07 = Add copy (1) | Remove from favorites = Remove | Person 09', 1, true), 'in the order of the list: ' .. outline())
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
  assert(block:sub(1, #name + 15) == name .. ' = Add copy (1)' and block:find('| Remove from favorites = Remove', 1, true), block)
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
  press('Characters to invite')
  assert(footerLabels() == 'Previous page | Next page | Back', footerLabels())
  press('invite:person-5')
  local text = rowsText()
  assert(text:find('favorite:add:person-5 = Add to favorites | invite:person-5 = Add copy (1)', 1, true), text)
  press('favorite:add:person-5')
  assert(categoryNames():find('^Companion Manager | Favorites | Characters to invite'), categoryNames())
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
  ns.interact.press(ns.find('Characters to invite')); frames(4)
  assert(not ns.find('Add to favorites') and ns.find('Back to Companion Manager') and ns.find('Person 01'), table.concat(ns.outline(), ' | '))
  ns.interact.press(ns.find('Person 05')); frames(4)
  assert(not ns.find('Add to favorites'), 'even in the party: ' .. table.concat(ns.outline(), ' | '))
`));
