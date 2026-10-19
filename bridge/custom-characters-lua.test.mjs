// The game side of the characters a player makes (docs/CHARACTER_EDITOR.md, "Your own characters"): mod/custom-characters.lua reads the list the
// service writes, mod/character-catalog.lua resolves a talk target against it, and mod/manager.lua enables the keys and says whether Mistral or
// the Local AI is answering. The real Lua modules run in fengari over a fake disk (bridge/startup-lua-fixture.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {run, managerLua, modSource} from './startup-lua-fixture.mjs';

const modules = `
  local customApi = (function() ${modSource('custom-characters.lua')} end)()
  local catalogApi = (function() ${modSource('character-catalog.lua')} end)()
  local reads, clock, changes, enabled, text = 0, 1000, 0, true, ''
  local function newService()
    return customApi.new({
      read = function() reads = reads + 1; return text end,
      decode = function(raw) return json.decode(raw) end,
      hash = function(record) return '<' .. record .. '>' end,
      prefixes = {'NCA.'},
      enabled = function() return enabled end,
      clock = function() return clock end,
      onChange = function() changes = changes + 1 end})
  end
  local function listing(rows) return json.encode({version = 1, revision = 1, characters = rows}) end
  local rebecca = {key = 'custom-rebecca-k3j9', name = 'Rebecca', gender = 'female', records = {'Character.Rebecca', 'NCA.1234567'}, names = {'Rebecca', 'Becca  Jones'}}
  local ray = {key = 'custom-ray-abcd', name = 'Ray', gender = 'male', records = {}, names = {'Ray'}}
`;
const lua = (code, options) => run(`${modules}\n${code}`, {locale: false, ...options});

test('with no character made and the editor never opened, a talk key press reads no file at all', () => {
  const out = lua(`
    local service = newService()
    assert(service.refresh(true) == false and service.size() == 0, 'an empty placeholder is nothing')
    local after = reads
    for i = 1, 20 do clock = clock + 10; service.refresh() end
    assert(reads == after, 'no read without characters or a watch: ' .. reads .. ' ' .. after)
    assert(service.match({record = 'Character.Rebecca', name = 'Rebecca'}) == nil)
    report('reads', reads)
  `);
  assert.equal(out.reads, 1, 'only the one read at load');
});

test('the list is read when it is due, only while there are characters or the editor was opened, and a changed list rebuilds the tables once', () => {
  const out = lua(`
    local service = newService()
    service.refresh(true)
    service.watch()
    text = listing({rebecca})
    clock = clock + 1; assert(service.refresh() == false, 'inside three seconds nothing is read')
    clock = clock + 3; assert(service.refresh() == true and service.size() == 1 and changes == 1, 'read and built: ' .. changes)
    assert(service.has('custom-rebecca-k3j9') and not service.has('custom-ray-abcd'))
    local settled = reads
    clock = clock + 4; assert(service.refresh() == false and reads == settled + 1 and changes == 1, 'the same text builds nothing again')
    text = listing({rebecca, ray})
    clock = clock + 4; assert(service.refresh() == true and service.size() == 2, 'a new character appears')
    text = listing({ray})
    clock = clock + 4; assert(service.refresh() == true and service.size() == 1 and not service.has('custom-rebecca-k3j9'), 'a deleted one goes')
    -- Past the two hours of the watch the list is still read while a character exists.
    clock = clock + 100000; local before = reads; service.refresh(); assert(reads == before + 1)
    -- A half-written file changes nothing and is read again at the next try.
    text = '{"version":1,"characters":[{"key":"custom-ra'
    clock = clock + 4; assert(service.refresh() == false and service.size() == 1, 'the old list stands')
    text = listing({ray, rebecca})
    clock = clock + 4; assert(service.refresh() == true and service.size() == 2)
    text = ''
    clock = clock + 4; assert(service.refresh() == true and service.size() == 0, 'an empty file is no characters')
    report('ok', true)
  `);
  assert.equal(out.ok, true);
});

test('a person is a character by record (and its clone) or by display name, with spaces and ASCII case ignored; nothing else is', () => {
  lua(`
    text = listing({rebecca, ray, {key = 'judy-alvarez', name = 'Not custom', gender = 'female', names = {'Judy'}}, {key = 'custom-', name = 'Bad key', names = {'Bad'}}, 'nonsense'})
    local service = newService(); service.refresh(true)
    assert(service.size() == 2, 'only well formed rows with the reserved prefix: ' .. service.size())
    local function key(actor) local entry = service.match(actor); return entry and entry.key end
    assert(key({record = '<Character.Rebecca>', name = 'Someone'}) == 'custom-rebecca-k3j9', 'by the game id of the record')
    assert(key({record = '<NCA.Character.Rebecca>', name = 'Someone'}) == 'custom-rebecca-k3j9', 'her clone is hers too')
    assert(key({record = '<NCA.1234567>', name = 'Someone'}) == 'custom-rebecca-k3j9', 'a numbered copy listed by hand')
    assert(key({record = 'Character.Rebecca', name = ''}) == 'custom-rebecca-k3j9', 'and by the plain record name')
    assert(key({record = '<Character.Other>', name = '  becca   JONES '}) == 'custom-rebecca-k3j9', 'by display name')
    assert(key({record = '<Character.Other>', name = 'REBECCA'}) == 'custom-rebecca-k3j9')
    assert(key({record = '<NCA.Character.Other>', name = 'Ray'}) == 'custom-ray-abcd')
    assert(service.get('custom-ray-abcd').gender == 'MALE' and service.get('custom-rebecca-k3j9').gender == 'FEMALE')
    assert(key({record = '<Character.Other>', name = 'Rebecca X'}) == nil)
    assert(key({record = '', name = ''}) == nil and key({}) == nil and key(nil) == nil)
    assert(key({record = 7, name = nil}) == nil, 'odd values are nobody')
  `);
});

test('while Convai answers a character is not used, and the one skipped is named once for the talk key', () => {
  lua(`
    text = listing({rebecca}); local service = newService(); service.refresh(true)
    local actor = {record = '<Character.Rebecca>', name = 'Rebecca'}
    enabled = false; service.checkProvider()
    assert(service.match(actor) == nil and service.match({record = '<Character.Other>', name = 'Somebody'}) == nil)
    local skipped = service.takeSkipped()
    assert(skipped and skipped.key == 'custom-rebecca-k3j9' and skipped.name == 'Rebecca')
    assert(service.takeSkipped() == nil, 'taken once')
    service.match(actor); service.clearSkipped(); assert(service.takeSkipped() == nil)
    enabled = true; service.checkProvider()
    assert(service.match(actor).key == 'custom-rebecca-k3j9' and service.takeSkipped() == nil, 'answering again, nothing is skipped')
  `);
});

test('the provider is asked at load and on the talk key, never by looking at a character', () => {
  lua(`
    text = listing({rebecca}); local asked = 0
    local service = customApi.new({read = function() return text end, decode = function(raw) return json.decode(raw) end, hash = function(record) return '<' .. record .. '>' end,
      prefixes = {'NCA.'}, enabled = function() asked = asked + 1; return enabled end, clock = function() return clock end})
    service.refresh(true)
    assert(asked == 1, 'asked once when the list was read: ' .. asked)
    for _ = 1, 200 do service.match({record = '<Character.Rebecca>', name = 'Rebecca'}); service.match({record = '<Character.Other>', name = 'Somebody'}) end
    assert(asked == 1, 'a gaze poll and a nearby scan ask nothing: ' .. asked)
    enabled = false
    assert(service.match({record = '<Character.Rebecca>', name = 'Rebecca'}) ~= nil, 'the answer is the one of the last look, until the talk key asks again')
    service.checkProvider()
    assert(asked == 2 and service.match({record = '<Character.Rebecca>', name = 'Rebecca'}) == nil)
    -- A provider that cannot be read counts as Convai, and with no character nothing is asked at all.
    local broken = customApi.new({read = function() return text end, decode = function(raw) return json.decode(raw) end, enabled = function() error('no state') end, clock = function() return clock end})
    broken.refresh(true); assert(broken.match({record = 'Character.Rebecca', name = 'x'}) == nil and broken.takeSkipped().key == 'custom-rebecca-k3j9')
    local none = customApi.new({read = function() return '' end, enabled = function() asked = asked + 100; return true end, clock = function() return clock end})
    none.refresh(true); none.checkProvider(); none.match({name = 'Rebecca'}); assert(asked == 2, 'no character, no question')
  `);
});

test('the catalogue puts a custom character after every roster profile and before the archetypes and residents', () => {
  lua(`
    local archetypes = catalogApi.buildArchetypes(catalogApi.ARCHETYPES)
    local catalog = catalogApi.build({{key = 'judy-alvarez', name = 'Judy Alvarez', aliases = {'Judy'}, records = {'Character.Judy'}},
      {key = 'resident-female', name = 'Night City Resident Female'}}, archetypes)
    text = listing({rebecca, {key = 'custom-judy-zzzz', name = 'Fake Judy', gender = 'female', records = {'Character.Judy'}, names = {'Judy'}}})
    local service = newService(); service.refresh(true)
    -- Nobody has a custom profile yet: nothing changes for anyone.
    assert(catalogApi.resolve(catalog, {name = 'Rebecca', record = '<Character.Rebecca>', crowd = false}) == nil)
    local key = catalogApi.resolve(catalog, {name = 'Rebecca', bodyType = 'WomanAverage', crowd = true}); assert(key == 'resident-female')
    catalog.custom = service
    local key, name, archetype = catalogApi.resolve(catalog, {name = 'Rebecca', record = '<Character.Rebecca>', bodyType = 'WomanAverage', crowd = false})
    assert(key == 'custom-rebecca-k3j9' and name == 'Rebecca' and archetype == nil, tostring(key))
    -- A character another mod spawned, or one the game placed: the same rule, found by record or by the name the game shows.
    assert(catalogApi.resolve(catalog, {name = 'Rebecca', bodyType = 'WomanAverage', spawned = true, crowd = false}) == 'custom-rebecca-k3j9')
    assert(catalogApi.resolve(catalog, {name = 'Rebecca', bodyType = 'WomanAverage', world = true, crowd = true}) == 'custom-rebecca-k3j9')
    -- It beats an archetype and a resident, from facts that would have classified her as a Maelstrom ganger.
    local facts = {affiliation = 'Maelstrom', bodyType = 'WomanAverage', human = true}
    assert(catalogApi.resolve(catalog, {name = 'Other', facts = facts, crowd = false}) == 'npc-maelstrom-female')
    assert(catalogApi.resolve(catalog, {name = 'Rebecca', facts = facts, crowd = false}) == 'custom-rebecca-k3j9')
    -- A roster profile always wins, even when a custom row claims the same record or name.
    assert(catalogApi.resolve(catalog, {name = 'Judy', record = '<Character.Judy>'}) == 'judy-alvarez')
    assert(catalogApi.resolve(catalog, {name = 'Whoever', record = 'Character.Judy', spawned = true}) == 'judy-alvarez')
    -- The game's own named character stays unreachable: a roster record found in the world is refused, and a custom row cannot take it over.
    assert(catalogApi.resolve(catalog, {name = 'Whoever', record = 'Character.Judy', world = true}) == nil)
    -- Our own copy keeps its assigned profile.
    assert(catalogApi.resolve(catalog, {managedKey = 'judy-alvarez', name = 'Rebecca', record = '<Character.Rebecca>'}) == 'judy-alvarez')
    -- Convai answering: she is an ordinary person again, and the service remembers who it left out.
    enabled = false; service.checkProvider()
    assert(catalogApi.resolve(catalog, {name = 'Rebecca', bodyType = 'WomanAverage', crowd = true}) == 'resident-female')
    assert(service.takeSkipped().key == 'custom-rebecca-k3j9')
    assert(catalogApi.isCustomKey('custom-rebecca-k3j9') and not catalogApi.isCustomKey('judy-alvarez') and not catalogApi.isCustomKey('npc-maelstrom-male') and not catalogApi.isCustomKey(nil))
  `);
});

test('a catalogue with no custom list is exactly as before: the same answer for every kind of target', () => {
  lua(`
    local archetypes = catalogApi.buildArchetypes(catalogApi.ARCHETYPES)
    local catalog = catalogApi.build({{key = 'judy-alvarez', name = 'Judy Alvarez', records = {'Character.Judy'}}, {key = 'resident-male', name = 'Resident'}}, archetypes)
    assert(catalog.custom == nil)
    for _, actor in ipairs({{name = 'Judy Alvarez'}, {name = 'X', record = 'Character.Judy', world = true}, {name = 'X', crowd = true, bodyType = 'ManAverage'},
        {name = 'X', facts = {affiliation = 'Maelstrom', bodyType = 'ManAverage'}}, {name = 'X'}}) do
      local a, b = catalogApi.resolve(catalog, actor)
      catalog.custom = nil
      local c, d = catalogApi.resolve(catalog, actor)
      assert(a == c and b == d)
    end
  `);
});

test('the manager enables the keys of custom characters and says whether Mistral or the Local AI is answering', () => {
  const out = run(`${managerLua}
    local manager = newManager()
    local player = newPlayer()
    manager.update(player, 0.1)
    assert(manager.profileEnabled('judy-alvarez') == true)
    assert(manager.profileEnabled('custom-rebecca-k3j9') == false, 'a key the manager does not know is not enabled')
    manager.configureCustom(function(key) return key == 'custom-rebecca-k3j9' end)
    assert(manager.profileEnabled('custom-rebecca-k3j9') == true and manager.profileEnabled('custom-ray-abcd') == false and manager.profileEnabled('judy-alvarez') == true)
    manager.configureCustom(nil)
    assert(manager.profileEnabled('custom-rebecca-k3j9') == false)
    -- The bridge's applied provider: Convai unless it says Mistral or local; read at most every 1.5 s.
    assert(manager.textProviderActive() == false, 'no status file: Convai')
    files['runtime/mistral-state.json'] = json.encode({version = 1, effective = 'local', provider = 'local'})
    advance(2); assert(manager.textProviderActive() == true)
    files['runtime/mistral-state.json'] = json.encode({version = 1, effective = 'mistral', provider = 'mistral'})
    advance(2); assert(manager.textProviderActive() == true)
    files['runtime/mistral-state.json'] = json.encode({version = 1, effective = 'convai', provider = 'local'})
    advance(0.3); assert(manager.textProviderActive() == true, 'the status is not read again inside 1.5 s')
    advance(2); assert(manager.textProviderActive() == false, 'a Local AI that fell back to Convai is not a text provider')
    files['runtime/mistral-state.json'] = '{broken'
    advance(2); assert(manager.textProviderActive() == false)
    report('ok', true)
  `);
  assert.equal(out.ok, true);
});

test('init.lua refreshes the list on the talk key, keeps the player\'s own characters out of battle and loot reactions, and the editor module stays free of native calls', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  const code = init.replace(/--.*$/gm, '');
  assert.match(code, /pcall\(convaiCustomCharacters\.refresh\); pcall\(convaiCustomCharacters\.checkProvider\) end\s*\r?\n/, 'selectConversation reads the list when it is due and asks which provider answers');
  assert.match(code, /convaiCustomCharacters\.clearSkipped\(\)\s*end\s*\r?\n\s*local key, name, bodyType, archetype = profileIdentity\(npc\)/, 'the skipped character is cleared and taken around the one resolution of the talk target');
  assert.match(code, /if roster and options\.roster and type\(characterCatalog\.isCustomKey\) == 'function' and characterCatalog\.isCustomKey\(key\) then roster = false end/, 'no reaction rows for custom characters');
  assert.match(code, /catalog\.custom = self\.count > 0 and self or nil/, 'the catalogue knows the list only while a character exists');
  // The one targeting query for "the character I'm facing" is a global function asked from the editor's Open, never from an update.
  assert.match(code, /function convaiFacingCharacter\(\)/);
  const host = readFileSync(new URL('../mod/manager-ui.lua', import.meta.url), 'utf8');
  assert.match(host, /facing = function\(\) return type\(convaiFacingCharacter\) == 'function' and convaiFacingCharacter\(\) or nil end/);
  const catalog = readFileSync(new URL('../mod/character-catalog.lua', import.meta.url), 'utf8').replace(/--.*$/gm, '');
  assert(catalog.indexOf('local custom = catalog.custom') > catalog.indexOf('if actor.world == true and actor.story ~= true then return nil, actor.name end'), 'after the roster block');
  assert(catalog.indexOf('local custom = catalog.custom') < catalog.indexOf('if catalog.archetypes and type(actor.facts)'), 'before the archetypes');
});
