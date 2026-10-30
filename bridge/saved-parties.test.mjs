import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, nsuiHarness, source, storage, savedPartiesSource, queueSource} from './manager-fixture.mjs';

// Saved parties: the Parties page of the Companion Manager (mod/saved-parties.lua for the data, the rows and the spawning in mod/manager-ui.lua,
// the one-body-per-flush rule in mod/manager-party.lua).
const everything = {
  'service-status.lua': source('service-status.lua'), 'character-editor.lua': source('character-editor.lua'),
  'convai-paid-tier.lua': source('convai-paid-tier.lua'), 'support-report.lua': source('support-report.lua'),
  'setup-check.lua': source('setup-check.lua'), 'custom-provider.lua': source('custom-provider.lua'),
};

// ---- mod/saved-parties.lua on its own -----------------------------------------------------------------------------------------------

const moduleHarness = `${storage}
  local function fresh() return (function() ${savedPartiesSource.replace(/^if type\(convaiSavedParties\).*\r?\n/m, '')} end)() end
  local parties = fresh()
  local function names(module) local out = {} for _, party in ipairs(module.list()) do out[#out + 1] = party.name end return table.concat(out, ',') end
  local judy, panam = {key = 'judy-alvarez', name = 'Judy Alvarez'}, {key = 'panam-palmer', name = 'Panam Palmer'}
`;

test('a saved party is written to runtime/saved-parties.json, read back by a new session, and named Party 1, Party 2 ... by default', () => run(`${moduleHarness}
  assert(parties.count() == 0 and parties.defaultName() == 'Party 1')
  local first, kept = parties.create({judy, judy, panam})
  assert(first and kept == true and first.name == 'Party 1' and #first.members == 3, 'two copies of Judy and Panam')
  local second = parties.create({panam})
  assert(second.name == 'Party 2' and second.id ~= first.id)
  assert(#fileWrites == 2 and fileWrites[2].path == 'runtime/saved-parties.json', 'one small write per change: ' .. #fileWrites)
  -- The gap is filled: Party 1 deleted, the next save is Party 1 again, and its id is never reused.
  assert(parties.remove(first.id) == true and parties.defaultName() == 'Party 1')
  local third = parties.create({judy})
  assert(third.name == 'Party 1' and third.id ~= first.id and third.id ~= second.id)
  -- A new session: only the file is left.
  local again = fresh()
  assert(names(again) == 'Party 2,Party 1', names(again))
  local restored = again.get(second.id)
  assert(restored and #restored.members == 1 and restored.members[1].key == 'panam-palmer')
  local fourth = again.create({judy})
  assert(fourth.id ~= third.id and fourth.id ~= second.id, 'ids are not reused after a restart: ' .. fourth.id)
`));

test('limits and refusals: nobody to save, a name another party has, too many parties, too many members, a name with nothing in it', () => run(`${moduleHarness}
  assert(select(2, parties.create({})) == 'empty' and select(2, parties.create({{key = 7}, 'x', {key = ''}})) == 'empty', 'nothing valid to save')
  local big = {}
  for index = 1, 40 do big[index] = {key = 'person-' .. index, name = 'Person ' .. index} end
  local party = parties.create(big)
  assert(#party.members == parties.MAX_MEMBERS, 'a saved party holds a bounded number of members: ' .. #party.members)
  assert(select(2, parties.create({judy}, 'party 1')) == 'name', 'case does not matter for a taken name')
  assert(select(2, parties.create({judy}, '  {}  ')) == 'name', 'a name that is only braces and spaces has nothing in it')
  for index = 2, parties.MAX_PARTIES do assert(parties.create({judy}), 'room for party ' .. index) end
  local none, reason = parties.create({judy})
  assert(none == nil and reason == 'full' and parties.count() == parties.MAX_PARTIES)
`));

test('rename keeps one line of at most 32 characters without braces, refuses a taken name, and update replaces the members', () => run(`${moduleHarness}
  local one = parties.create({judy})
  local two = parties.create({panam})
  assert(parties.cleanName('  Night\\n  crew {x}  ') == 'Night crew x')
  assert(parties.rename(one.id, 'Night crew') and one.name == 'Night crew')
  assert(select(2, parties.rename(two.id, 'night CREW')) == 'name' and two.name == 'Party 2')
  assert(select(2, parties.rename(two.id, '   ')) == 'name')
  assert(select(2, parties.rename('party-99', 'x')) == 'missing')
  local long = parties.rename(two.id, string.rep('a', 50))
  assert(#long.name == 32, #long.name)
  -- Never cut inside a UTF-8 character: 40 two-byte letters become 32 letters, 64 bytes.
  local wide = parties.rename(two.id, string.rep('\\xC3\\xA9', 40))
  assert(#wide.name == 64 and wide.name:sub(-2) == '\\xC3\\xA9', #wide.name)
  assert(parties.update(one.id, {panam, panam}) and #one.members == 2 and one.members[1].key == 'panam-palmer')
  assert(select(2, parties.update(one.id, {})) == 'empty' and #one.members == 2, 'an empty list never wipes a party')
`));

test('a missing, empty or damaged file is no saved parties; a file that cannot be written keeps them for the session and says so', () => run(`${moduleHarness}
  assert(parties.count() == 0)
  parties.reset()
  files['runtime/saved-parties.json'] = ''
  assert(parties.count() == 0)
  parties.reset()
  jsonFixtures['broken'] = nil
  files['runtime/saved-parties.json'] = 'broken'
  local ok = pcall(function() return parties.count() end)
  assert(ok and parties.count() == 0, 'a file nobody can decode is no saved parties')
  parties.reset()
  failSave = true
  local party, kept = parties.create({judy})
  assert(party and kept == false and parties.count() == 1 and parties.lastError() ~= nil, 'kept for the session, not written')
  failSave = false
  parties.reset()
  jsonFixtures['mixed'] = {version = 1, next = 7, parties = {
    {id = 'party-3', name = 'Crew', members = {{key = 'judy-alvarez', name = 'Judy'}, {key = false}, 'junk'}},
    {id = 'party-3', name = 'Duplicate id', members = {{key = 'a'}}},
    {id = 'bad id', name = 'Bad', members = {{key = 'a'}}},
    {id = 'party-4', name = '', members = {{key = 'a'}}},
    'junk'}}
  files['runtime/saved-parties.json'] = 'mixed'
  assert(names(parties) == 'Crew' and #parties.list()[1].members == 1, names(parties))
  assert(parties.create({judy}).id == 'party-7', 'the counter of the file is kept')
`));

// ---- the Parties page, over Native Settings UI --------------------------------------------------------------------------------------

const harness = (options = {}) => nsuiHarness({modules: everything, ...options}) + `
  convaiNotices.configure(function() return manager.developerMode() end)
  local clock = 1000
  os.clock = function() return clock end
  local timeBase = os.time()
  os.time = function() return timeBase + math.floor(clock - 1000) end
  local function frames(count, step)
    for _ = 1, count or 6 do clock = clock + (step or 0.1); managerUi.update(player, true) end
    loaded = registered.loadMod('manager')
  end
  -- A row by its label, and by its button text when one character has two rows (Add to favorites, then Add copy).
  local function button(label, text)
    for _, key in pairs(ns.data[ns.currentTab].keys) do
      for _, option in pairs(ns.data[ns.currentTab].subcategories[key].options) do
        if option.label == label and (option.buttonText == text or (option.buttonText or ''):sub(1, #text + 1) == text .. ' ') then return option end
      end
    end
  end
  local function press(label, text)
    local row = text and button(label, text) or ns.find(label)
    ns.interact.press(assert(row, 'no row: ' .. label .. ' / ' .. tostring(text))); frames(3); ns.verify()
  end
  local function shownOutline() return table.concat(ns.outline(), ' | ') end
  -- Everybody who was invited arrives (the fake game leaves a new copy 'spawning').
  local function arrive() for _, member in ipairs(members) do member.state = 'ready' end frames(3) end
  local function spawnedKeys() return table.concat(spawned, ',') end
  frames(3)
`;

// Two copies of Viktor and Johnny, invited the way a player does, and saved.
const withSavedParty = `
  press('Main characters to invite')
  press('Person 01'); frames(8)
  press('Johnny Silverhand'); frames(8)
  press('Person 01', 'Add copy'); frames(8)
  arrive()
  assert(spawnedKeys() == 'person-1,johnny-silverhand,person-1', spawnedKeys())
  press('Back to Companion Manager')
  press('Parties')
`;

test('Home calls the page Parties; its first section is still Current party, and a party can be saved only when somebody is in it', () => run(`${harness()}
  assert(ns.find('Parties') and not ns.find('Current party'), 'the Home row is Parties')
  press('Parties')
  assert(ns.sections()[2].label == 'Current party', ns.sections()[2].label)
  assert(ns.find('Your party is empty') and not ns.find('Save current party'), 'nobody to save: ' .. shownOutline())
`));

test('Save current party stores the characters with their copies as Party 1 and lists it under Current party with Spawn, Update, Rename and Delete', () => run(`${harness()}
  ${withSavedParty}
  assert(ns.find('Save current party'), shownOutline())
  local sections = ns.sections()
  assert(sections[2].label == 'Current party' and #sections == 2, 'no saved party yet: ' .. #sections)
  press('Save current party')
  sections = ns.sections()
  assert(#sections == 3 and sections[3].label == 'Saved party: Party 1', shownOutline())
  assert(sections[3].options[1].label == 'Person 01 (2), Johnny Silverhand', sections[3].options[1].label)
  local buttons = {}
  for index = 2, #sections[3].options do buttons[#buttons + 1] = sections[3].options[index].label .. '=' .. sections[3].options[index].buttonText end
  assert(table.concat(buttons, ' | ') == 'Spawn party=Spawn | Update with current party=Update | Rename party=Rename | Delete=Delete', table.concat(buttons, ' | '))
  assert(core.feedback():find('Saved as Party 1', 1, true), core.feedback())
  local saved = convaiSavedParties.list()
  assert(#saved == 1 and #saved[1].members == 3 and saved[1].members[2].key == 'johnny-silverhand')
  assert(files['runtime/saved-parties.json'] ~= nil, 'the file is written')
  -- Saved again: Party 2, even though nothing changed.
  press('Save current party')
  assert(#ns.sections() == 4 and ns.sections()[4].label == 'Saved party: Party 2', shownOutline())
`));

test('Spawn party adds the missing members and dismisses nobody: pressing it twice does not double the party, and a second copy is invited', () => run(`${harness()}
  ${withSavedParty}
  press('Save current party')
  -- Johnny leaves; the party is Viktor and a copy of Viktor.
  press('Back to Companion Manager'); press('Parties')
  local johnnyRow
  for _, option in ipairs(ns.sections()[2].options) do if option.label:find('Johnny', 1, true) then johnnyRow = option end end
  ns.interact.press(assert(johnnyRow)); frames(6)
  assert(#members == 2, 'Johnny was dismissed: ' .. #members)
  local before = #spawned
  press('Spawn party'); frames(8)
  assert(#spawned == before + 1 and spawned[#spawned] == 'johnny-silverhand', 'only the missing one is invited: ' .. spawnedKeys())
  arrive()
  assert(#members == 3)
  press('Spawn party'); frames(8)
  assert(#spawned == before + 1, 'pressed again: nobody is missing, nobody is invited: ' .. spawnedKeys())
  assert(#members == 3, 'nobody was dismissed')
  assert(core.feedback():find('Already with you: Person 01, Johnny Silverhand, Person 01', 1, true), core.feedback())
`));

test('Spawn party over an empty party invites everybody, with copies, one body per flush', () => run(`${harness()}
  ${withSavedParty}
  press('Save current party')
  -- Everybody leaves.
  for _ = 1, 3 do
    local row
    for _, option in ipairs(ns.sections()[2].options) do if option.buttonText == 'Dismiss' then row = option end end
    ns.interact.press(assert(row)); frames(6)
  end
  assert(#members == 0, #members)
  local before = #spawned
  press('Spawn party')
  -- Preparation is instant in the fake; each flush makes one body.
  local counts = {}
  for step = 1, 30 do
    local was = #spawned
    clock = clock + 0.26
    managerUi.update(player, true)
    counts[#counts + 1] = #spawned - was
    if #spawned - was > 1 then error('two bodies in one flush at step ' .. step) end
  end
  assert(#spawned - before == 3, 'all three came: ' .. spawnedKeys())
  assert(table.concat(spawned, ',', before + 1) == 'person-1,johnny-silverhand,person-1', table.concat(spawned, ',', before + 1))
`));

test('a member that cannot come is named with the reason, the others still come, and a party with nobody who can come says so', () => run(`${harness()}
  ${withSavedParty}
  press('Save current party')
  for _ = 1, 3 do
    local row
    for _, option in ipairs(ns.sections()[2].options) do if option.buttonText == 'Dismiss' then row = option end end
    ns.interact.press(assert(row)); frames(6)
  end
  -- Johnny's model is gone (a custom character was deleted, a pack removed).
  defs['johnny-silverhand'] = nil
  local before = #spawned
  local result = registered.invokeAction('manager', 'party:spawn:' .. convaiSavedParties.list()[1].id)
  frames(8)
  assert(result.ok == true)
  assert(table.concat(spawned, ',', before + 1) == 'person-1,person-1', table.concat(spawned, ',', before + 1))
  local feedback = core.feedback()
  assert(feedback:find('Could not invite: Johnny Silverhand (that character model is unavailable)', 1, true), feedback)
  assert(feedback:find('inviting Person 01, Person 01', 1, true), feedback)
  -- Pressed again: the two who came are present, Johnny is still left out.
  local again = registered.invokeAction('manager', 'party:spawn:' .. convaiSavedParties.list()[1].id)
  assert(again.ok == true and #spawned - before == 2, 'nobody is invited twice')
  assert(core.feedback():find('Already with you: Person 01, Person 01.', 1, true) and core.feedback():find('Could not invite: Johnny', 1, true), core.feedback())
  -- Nobody can come at all.
  arrive()
  while #members > 0 do table.remove(members) end
  defs['person-1'] = nil
  local none = registered.invokeAction('manager', 'party:spawn:' .. convaiSavedParties.list()[1].id)
  assert(none.ok == false and #spawned - before == 2, 'nothing to invite')
  assert(core.feedback() == 'Could not invite: Person 01 (that character model is unavailable); Johnny Silverhand (that character model is unavailable); Person 01 (that character model is unavailable).', core.feedback())
`));

test('Delete asks twice, and any other button or page cancels the first press', () => run(`${harness()}
  ${withSavedParty}
  press('Save current party')
  local label = function()
    for _, section in ipairs(ns.sections()) do for _, option in ipairs(section.options) do if option.buttonText == 'Press again' then return option end end end
  end
  press('Delete')
  assert(label() and #convaiSavedParties.list() == 1, 'armed, not deleted: ' .. shownOutline())
  press('Save current party')
  assert(not label() and #convaiSavedParties.list() == 2, 'saving another party disarmed it')
  press('Back to Companion Manager'); press('Parties')
  local deletes = {}
  for _, section in ipairs(ns.sections()) do for _, option in ipairs(section.options) do if option.buttonText == 'Delete' then deletes[#deletes + 1] = option end end end
  ns.interact.press(deletes[1]); frames(3)
  assert(label(), 'armed again')
  ns.interact.press(label()); frames(3)
  assert(#convaiSavedParties.list() == 1 and convaiSavedParties.list()[1].name == 'Party 2', 'the second press deletes Party 1 only')
  assert(#members == 3, 'the party in the game is untouched')
`));

test('Update with current party replaces the members, and an empty party never wipes a saved one', () => run(`${harness()}
  ${withSavedParty}
  press('Save current party')
  for _ = 1, 3 do
    local row
    for _, option in ipairs(ns.sections()[2].options) do if option.buttonText == 'Dismiss' then row = option end end
    ns.interact.press(assert(row)); frames(6)
  end
  local result = registered.invokeAction('manager', 'party:update:' .. convaiSavedParties.list()[1].id)
  assert(#convaiSavedParties.list()[1].members == 3, 'with nobody in the party the saved one stays')
  press('Back to Companion Manager'); press('Main characters to invite')
  press('Johnny Silverhand'); frames(8); arrive()
  press('Back to Companion Manager'); press('Parties')
  press('Update with current party')
  local party = convaiSavedParties.list()[1]
  assert(#party.members == 1 and party.members[1].key == 'johnny-silverhand', 'now only Johnny')
  assert(ns.sections()[3].options[1].label == 'Johnny Silverhand', ns.sections()[3].options[1].label)
`));

test('Rename needs a text box: Native Settings UI has none and says so, the name stays', () => run(`${harness()}
  ${withSavedParty}
  press('Save current party')
  press('Rename party')
  assert(convaiSavedParties.list()[1].name == 'Party 1')
  assert(core.feedback():find('no text box', 1, true), core.feedback())
`));

test('the saved parties are the same in the next session', () => run(`${harness()}
  ${withSavedParty}
  press('Save current party')
  assert(files['runtime/saved-parties.json'])
  -- A new session: the module reads its file again.
  convaiSavedParties.reset()
  local list = convaiSavedParties.list()
  assert(#list == 1 and list[1].name == 'Party 1' and #list[1].members == 3 and list[1].members[3].key == 'person-1')
  press('Back to Companion Manager'); press('Parties')
  assert(ns.sections()[3].label == 'Saved party: Party 1', shownOutline())
`));

test('with Immersive invitations On the first invitation of a character is an appointment and her second copy is a plain invitation', () => run(`${harness()}
  ${withSavedParty}
  press('Save current party')
  while #members > 0 do table.remove(members) end
  local requested = {}
  convaiImmersiveGet = function()
    return {rows = function() return {} end,
      requestInvite = function(key)
        requested[#requested + 1] = key
        if key == 'johnny-silverhand' then return nil end
        return true, '', 'meeting:' .. #requested
      end}
  end
  local before = #spawned
  local result = registered.invokeAction('manager', 'party:spawn:' .. convaiSavedParties.list()[1].id)
  frames(8)
  assert(result.ok == true)
  assert(table.concat(requested, ',') == 'person-1,johnny-silverhand', 'a character is asked of the appointments once: ' .. table.concat(requested, ','))
  assert(table.concat(spawned, ',', before + 1) == 'johnny-silverhand,person-1', 'Johnny and the copy are plain invitations: ' .. table.concat(spawned, ',', before + 1))
`));

test('without mod/saved-parties.lua the page is the one it was: no Save row, no sections', () => run(`${harness({absent: ['saved-parties.lua']})}
  press('Main characters to invite')
  press('Person 01'); frames(8); arrive()
  press('Back to Companion Manager'); press('Parties')
  assert(not ns.find('Save current party') and #ns.sections() == 2, shownOutline())
`));

test('the queue creates the bodies of a saved party one per flush, and the bodies of any other invitation together', () => {
  run(`
  ${storage}
  local M = (function() ${queueSource} end)()
  local spawnedKeys, members = {}, {}
  local companions = {}
  function companions.definition(key) return {id = 'Character.' .. key, name = key} end
  function companions.list() return members end
  function companions.spawn(key)
    spawnedKeys[#spawnedKeys + 1] = key
    members[#members + 1] = {serial = #members + 1, key = key, name = key, state = 'ready'}
    return #members
  end
  function companions.setProfile() return true end
  local Q = M.new(companions, nil, {})
  Q.bind('player-1')
  Q.invite('a', {stagger = true}); Q.invite('b', {stagger = true}); Q.invite('c', {stagger = true})
  Q.flush()
  assert(#spawnedKeys == 1 and spawnedKeys[1] == 'a', 'one body in the first flush: ' .. #spawnedKeys)
  Q.flush(); Q.flush()
  assert(#spawnedKeys == 3, 'one more each flush: ' .. #spawnedKeys)
  Q.invite('d'); Q.invite('e')
  Q.flush()
  assert(#spawnedKeys == 5, 'plain invitations are not staggered: ' .. #spawnedKeys)
  `);
});
