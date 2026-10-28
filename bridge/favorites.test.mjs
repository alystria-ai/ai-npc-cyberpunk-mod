import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, nsuiHarness, source, storage, favoritesSource} from './manager-fixture.mjs';

// Favorites: the Add to favorites button of Characters to invite and the Model browser (mod/favorites.lua, the page logic in
// mod/manager-ui.lua, the row the player is on in mod/nsui.lua, the Search box fallback in mod/mcm-host.lua).
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

test('a favorite is saved in runtime/favorites.json, read back by a new session, and listed first with the others in their order', () => run(`${moduleHarness}
  assert(favorites.count('characters') == 0 and favorites.order('characters', people) == people, 'no favorites: the list itself comes back, nothing is copied')
  assert(favorites.set('characters', 'k4') == true)
  assert(favorites.set('characters', 'k2') == true)
  assert(favorites.set('models', 'k4') == true, 'the two pages keep their own favorites')
  assert(keys(favorites.order('characters', people)) == 'k2,k4,k1,k3,k5,k6', 'favorites first, each group in the list order: ' .. keys(favorites.order('characters', people)))
  assert(favorites.name('characters', 'k2', 'Name 2') == '* Name 2' and favorites.name('characters', 'k1', 'Name 1') == 'Name 1')
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
  assert(keys(again.order('characters', people)) == 'k2,k1,k3,k4,k5,k6')
`));

test('the sorted list is kept while the list and the favorites stay the same, and made again when either changes', () => run(`${moduleHarness}
  favorites.set('characters', 'k5')
  local first = favorites.order('characters', people)
  assert(first ~= people and keys(first) == 'k5,k1,k2,k3,k4,k6')
  assert(favorites.order('characters', people) == first, 'turning a page sorts nothing')
  favorites.set('characters', 'k6')
  local second = favorites.order('characters', people)
  assert(second ~= first and keys(second) == 'k5,k6,k1,k2,k3,k4', 'a new favorite sorts again')
  people[#people + 1] = {key = 'k7', name = 'Name 7'}
  assert(keys(favorites.order('characters', people)) == 'k5,k6,k1,k2,k3,k4,k7', 'a longer list sorts again')
  local other = {people[3], people[5], people[1]}
  assert(keys(favorites.order('characters', other)) == 'k5,k3,k1', 'another list is sorted on its own')
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

// ---- Native Settings UI: the row the player is on ------------------------------------------------------------------------------------

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
  local function press(label)
    ns.interact.press(assert(ns.find(label), 'no row: ' .. label)); frames(3); ns.verify()
  end
  local function hover(label) ns.interact.hover(assert(ns.find(label), 'no row: ' .. label)); frames(3); ns.verify() end
  local function outline() return table.concat(ns.outline(), ' | ') end
  -- The rows of the list: the options of the second section that are buttons with a text (Invite, Add copy ...).
  local function listed()
    local out = {}
    for _, option in ipairs(ns.sections()[2].options) do
      if option.type == 'button' and option.buttonText ~= '' and option.buttonText ~= nil and option.label:sub(1, 5) ~= 'Page ' then out[#out + 1] = option.label end
    end
    return out
  end
  local function saved() return jsonFixtures[files['runtime/favorites.json']] end
  frames(3)
`;

test('Native Settings UI: the button sits right after Back, acts on the last list row the player was on, and marks it and lists it first', () => run(`${nsHarness()}
  press('Characters to invite')
  local nav = ns.sections()[1].options
  assert(nav[1].label == 'Back to Companion Manager' and nav[2].label == 'Add to favorites' and nav[2].buttonText == 'Add', outline())
  local base = listed()
  -- Pressed before the player was on any row: nothing happens but a line that says what to do.
  ns.interact.press(nav[2]); frames(3)
  assert(outline():find('Move onto an entry in the list first', 1, true), outline())
  assert(saved() == nil, 'nothing was written')
  -- The pointer goes over Person 05, then to the button (which is a row too, but not a list row).
  hover('Person 05')
  hover('Add to favorites')
  press('Add to favorites')
  assert(listed()[1] == '* Person 05' and listed()[2] == base[1], 'the favorite is first and marked: ' .. table.concat(listed(), ', '))
  assert(ns.find('Remove from favorites') and ns.find('Remove from favorites').buttonText == 'Remove', 'the label flips')
  assert(outline():find('is now a favorite', 1, true), outline())
  assert(saved() and saved().characters['person-5'] == true and saved().version == 1, 'saved for the next session')
  -- Another row (not a favorite) changes the label back; the favorite brings it forward again.
  hover('Person 06')
  assert(ns.find('Add to favorites') and not ns.find('Remove from favorites'), 'Person 06 is not a favorite')
  hover('* Person 05')
  assert(ns.find('Remove from favorites'), 'Person 05 is')
  press('Remove from favorites')
  assert(listed()[1] == base[1] and not outline():find('* Person 05', 1, true), 'taken out again: ' .. table.concat(listed(), ', '))
  assert(next(saved().characters) == nil)
`));

test('Native Settings UI: a row on another page is not the target, hovering the button leaves the target alone, and other pages report nothing', () => run(`${nsHarness()}
  press('Characters to invite')
  hover('Person 02')
  local slider = ns.find('Page')
  ns.interact.slide(slider, 2); frames(6); ns.verify()
  ns.interact.press(ns.find('Add to favorites')); frames(3)
  assert(outline():find('Move onto an entry in the list first', 1, true), 'the row was on the first page: ' .. outline())
  assert(saved() == nil)
  hover('Person 20')
  press('Add to favorites')
  assert(saved().characters['person-20'] == true)
  -- The favorite is on the first page now.
  ns.interact.slide(ns.find('Page'), 1); frames(6)
  assert(listed()[1] == '* Person 20', table.concat(listed(), ', '))
  -- Another page: a hover on a row there does not change anything.
  press('Back to Companion Manager'); press('Settings')
  local before = core.pageId()
  for _, option in ipairs(ns.sections()[2].options) do if option.type == 'button' then ns.interact.hover(option) end end
  frames(3)
  assert(core.pageId() == before and saved().characters['person-20'] == true)
`));

test('Native Settings UI: favorites come back in a new session, and a favorite that cannot be saved still works until the game closes', () => run(`${nsHarness()}
  press('Characters to invite')
  hover('Person 09'); press('Add to favorites')
  assert(saved().characters['person-9'] == true)
  -- The session ends; the file is all that is left.
  convaiFavorites.reset(); core.refresh(); frames(6)
  assert(listed()[1] == '* Person 09', 'read back from the file: ' .. table.concat(listed(), ', '))
  failSave = true
  hover('Person 07'); press('Add to favorites')
  assert(listed()[1] == '* Person 07' and listed()[2] == '* Person 09', 'favorites first, in the order of the list: ' .. table.concat(listed(), ', '))
  assert(core.feedback():find('could not be saved', 1, true), core.feedback())
`));

test('Native Settings UI: the Model browser has the same button, and its favorites are listed first on page 1', () => run(`${nsHarness()}
  press('Model browser')
  frames(130)
  ns.verify()
  local nav = ns.sections()[1].options
  assert(nav[2].label == 'Add to favorites', outline():sub(1, 400))
  local fifth = listed()[5]
  assert(fifth and fifth:sub(1, 2) ~= '* ')
  hover(fifth)
  press('Add to favorites')
  assert(listed()[1] == '* ' .. fifth, table.concat(listed(), ', '))
  assert(saved().models and next(saved().models) ~= nil and next(saved().characters) == nil, 'the model page keeps its own list')
  -- The next page of the list does not hold it again.
  ns.interact.slide(ns.find('Page'), 2); frames(6)
  for _, label in ipairs(listed()) do assert(label ~= '* ' .. fifth and label ~= fifth) end
`));

test('Native Settings UI: a hover costs a lookup on the two list pages and nothing on the others, and a tab that is not on screen reports nothing', () => run(`${nsHarness()}
  press('Characters to invite')
  hover('Person 03')
  ns.closeScreen()
  -- With the screen closed the hook ignores the event (no controller to ask).
  local ok = pcall(function() ns.fire('SettingsMainGameController.OnSettingHoverOver', nil, {GetCurrentTarget = function() error('asked') end}) end)
  assert(ok, 'the hook does not touch the event when the tab is not on screen')
`));

// ---- Mod Configuration Menu: the Search box --------------------------------------------------------------------------------------------

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
  local function inviteLabels()
    local list = {}
    for _, row in ipairs(mcm.rows()) do if row.id and row.id:sub(1, 7) == 'invite:' then list[#list + 1] = row.label end end
    return table.concat(list, ' | ')
  end
  local function headings()
    local list = {}
    for _, row in ipairs(mcm.layout().rows) do if row.kind == 'heading' then list[#list + 1] = row.label end end
    return table.concat(list, ' | ')
  end
  local function typed(text) mcm.search(text); frames(8) end
  local function saved() return jsonFixtures[files['runtime/favorites.json']] end
  frames(3)
  mcm.openScreen()
  frames(2)
`;

test('Mod Configuration Menu cannot say which row the player is on, so the button acts on the first entry the Search box leaves', () => run(`${mcmHarness()}
  press('Characters to invite')
  assert(core.view() == 'characters' and mcm.config().navigation.searchMode == 'provider', 'the box is the host\\'s on this page')
  assert(footerLabels() == 'Previous page | Next page | Add to favorites | Back', footerLabels())
  -- No text in the box: a line that says what to do, nothing saved.
  local refused, why = mcm.press('Add to favorites'); frames(2)
  assert(refused == false and tostring(why):find('Type a name in the Search box first', 1, true), tostring(refused) .. ' / ' .. tostring(why))
  assert(saved() == nil)
  typed('person 07')
  assert(inviteLabels() == 'Person 07', inviteLabels())
  assert(headings():find('1 matching characters', 1, true), 'the heading says it: ' .. headings())
  press('Add to favorites')
  assert(mcm.status():find('Person 07 is now a favorite', 1, true), mcm.status())
  assert(saved().characters['person-7'] == true)
  assert(footerLabels():find('Remove from favorites', 1, true), 'the button flips for the entry the search leaves: ' .. footerLabels())
  typed('')
  assert(inviteLabels():find('^%* Person 07 | '), 'listed first: ' .. inviteLabels())
  assert(footerLabels():find('Add to favorites', 1, true), 'no search: no target, the plain label')
  -- Taken out again by the same search.
  typed('person 07')
  press('Remove from favorites')
  assert(mcm.status():find('no longer a favorite', 1, true) and next(saved().characters) == nil, mcm.status())
  -- Several entries left: the first one is the target.
  typed('person 1')
  press('Add to favorites')
  assert(saved().characters['person-1'] == true or saved().characters['person-10'] == true, 'the first match')
  local count = 0 for _ in pairs(saved().characters) do count = count + 1 end
  assert(count == 1)
`));

test('Mod Configuration Menu: the Model browser favorites work the same way, and the box is emptied when the player changes page', () => run(`${mcmHarness()}
  press('Model browser'); frames(140)
  assert(footerLabels():find('Add to favorites', 1, true), footerLabels())
  typed('model_9')
  press('Add to favorites')
  assert(next(saved().models) ~= nil and next(saved().characters) == nil)
  typed('')
  assert(inviteLabels():sub(1, 2) == '* ', 'the favorite model is first: ' .. inviteLabels():sub(1, 60))
  press('Back to Companion Manager')
  press('Characters to invite')
  assert(mcm.searchText() == '' and core.search() == '', 'the box does not follow the player to the other list')
`));

test('without mod/favorites.lua the two pages have no button and nothing else changes', () => run(`${nsuiHarness({modules: everything, absent: ['favorites.lua']})}
  local clock = 1000
  os.clock = function() return clock end
  local function frames(count) for _ = 1, count or 6 do clock = clock + 0.1; managerUi.update(player, true) end end
  frames(3)
  ns.interact.press(ns.find('Characters to invite')); frames(4)
  assert(not ns.find('Add to favorites') and ns.find('Back to Companion Manager') and ns.find('Person 01'), table.concat(ns.outline(), ' | '))
`));
