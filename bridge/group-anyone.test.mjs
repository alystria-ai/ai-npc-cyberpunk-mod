import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {parseGroup, groupContext} from './group-context.mjs';
import {parseInput} from './protocol.mjs';

// Group chat takes ANY two or three people nearby that V can talk to (owner decision 2026-10-28, docs/GROUP_VOICE.md "Anyone nearby"):
// the one V faces first, then V's companions, the characters another mod placed, and the people of the street, the game's named
// characters and quest-bound people, nearest first, up to three. Strangers keep their own history per entity (the bridge side), a game-placed
// character gets talk, voice and face only, and the notice that sends V to the private key never prints an empty key.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const init = read('../mod/init.lua');
const groupSource = read('../mod/group-chat.lua');
const between = (from, to) => {
  const start = init.indexOf(from), end = init.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return init.slice(start, end);
};
function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

// ---- The game side: the key press's selection, cut out of init.lua ------------------------------------------------------------

const helpers = between('function convaiTalkFirstParty(', "-- The Johnny keys (docs/JOHNNY_IN_YOUR_HEAD.md)");
const selection = between('local function selectConversation(', 'local function voiceTargetValid');
const speakerStory = between('function convaiGroupSpeakerStory(', 'local function updateGroup(');

function selectionRun(body) {
  run(`
    local lines, notices, sent = {}, {}, {}
    function log(line) lines[#lines + 1] = line end
    Enum = {new = function(_, name) return name end}
    groupChat = (function() ${groupSource} end)()
    -- Everything the key press reads about a body: info[hash] = {key, name, distance, owned, spawned, story, quest, hostile, archetype}.
    local info = {}
    local function person(hash, distance, spec)
      spec.distance = distance; info[hash] = spec
      return {hash = hash,
        IsNPC = function() return true end, IsAttached = function() return true end, IsDeadNoStatPool = function() return false end,
        GetEntityID = function(self) return {hash = self.hash} end,
        GetWorldPosition = function(self) return {x = info[self.hash].distance, y = 0, z = 0} end,
        GetAttitudeAgent = function(self) return {GetAttitudeTowards = function() return info[self.hash].hostile and 'AIA_Hostile' or 'AIA_Friendly' end} end}
    end
    local player = {GetWorldPosition = function() return {x = 0, y = 0, z = 0} end, GetAttitudeAgent = function() return 'player' end}
    supportedProfiles = {['alex'] = true, ['judy-alvarez'] = true, ['rogue-amendiares'] = true, ['npc-street-resident-female'] = true,
      ['npc-street-resident-male'] = true, ['resident-female'] = true, ['off'] = true}
    archetypes = {keys = {['npc-street-resident-female'] = true, ['npc-street-resident-male'] = true}}
    characterCatalog = {describe = function(_, key) return {category = 'ordinary', base = key} end}
    local keyBindings = {}
    manager = {profileEnabled = function(key) return key ~= 'off' end, keyBindings = function() return keyBindings end}
    convaiKeyBinds = {describe = function(name)
      if name == 'IK_F7' then return 'key', 'F7' elseif name == 'IK_Pad_A_CROSS' then return 'pad', 'A' end
      return nil end}
    local boundText = nil
    ui = {boundKey = function() return boundText end,
      t = function(text, args)
        return (text:gsub('{([%a_]+)}', function(name) return args and args[name] ~= nil and tostring(args[name]) or '{' .. name .. '}' end))
      end}
    function profileIdentity(n)
      local row = info[n.hash]
      if not row or not row.key then return nil end
      return row.key, row.name or row.key, 'WomanAverage', row.archetype
    end
    function profileEnabled(_, key) return key ~= 'off' end
    local party = {}
    companions = {conversationCandidates = function() return party end, owns = function(n) return info[n.hash].owned == true end,
      partyInOrder = function() return {} end, seatedCandidates = function() return {} end}
    local busy = {}
    convaiWorldPolicy = {spawned = function(n) return info[n.hash].spawned == true end, story = function(n) return info[n.hash].story == true end,
      protected = function(n) return info[n.hash].story == true or info[n.hash].quest == true end}
    convaiWorldTalk = {PROJECTIONS = {}, runtimeQuest = function(n) return info[n.hash].quest == true end,
      refusal = function(_, n) return busy[n.hash] and 'scene' or nil end}
    convaiNpcNames = {nameFor = function(n) return 'Name ' .. n.hash end}
    function currentDistrict() return nil end
    manager.dynamicInfo = function() return false end
    convaiNotices = {send = function(_, id, text) notices[#notices + 1] = {id = id, text = text} end}
    convaiTalkTarget = {remember = function() end}
    convaiHolocall, convaiAddons, convaiCustomCharacters, convaiSpawnedPeople, convaiSpawnedCharacters = nil, nil, nil, nil, nil
    local faced, nativeList = nil, {}
    function targetAtCrosshair() convaiTalkNative = nativeList; return faced, faced == nil and 'Face a nearby character to talk.' or nil, {} end
    function logTalkTarget() end
    convaiStrangerRange = 6
    ${helpers}
    ${selection}
    ${body}
  `);
}

test('two crowd women: facing one, a group round of both (the notice "needs two characters" is gone)', () => selectionRun(`
  local a = person('A', 2, {key = 'npc-street-resident-female', name = 'Pedestrian'})
  local b = person('B', 4, {key = 'npc-street-resident-female', name = 'Pedestrian'})
  faced, nativeList = a, {a, b}
  local primary, round = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(#notices == 0, 'no notice: ' .. tostring(notices[1] and notices[1].text))
  assert(primary and primary.entity == 'A' and primary.generic == true)
  assert(round and #round == 2 and round[1].entity == 'A' and round[2].entity == 'B', 'both of them: ' .. tostring(round and #round))
  assert(round[2].stranger == true and round[2].generic == true and round[2].archetype.base == 'npc-street-resident-female')
  -- Two strangers on one profile are two people; each gets its own Night City name (the later round input carries it).
  assert(round[1].name == 'Name A' and round[2].name == 'Name B', round[1].name .. '/' .. round[2].name)
  assert(round[2].archetype.npcName == 'Name B')
  assert(lines[#lines - 1] and lines[#lines - 1]:find('Group candidates: people=1', 1, true), table.concat(lines, '|'))
`));

test('facing nobody: the nearest stranger leads, three at most, the nearest first, nobody beyond speaking distance or fighting V', () => selectionRun(`
  local list = {
    person('far', 7.5, {key = 'npc-street-resident-male'}),
    person('c', 3, {key = 'npc-street-resident-female'}),
    person('a', 1, {key = 'npc-street-resident-female'}),
    person('hostile', 0.5, {key = 'npc-street-resident-male', hostile = true}),
    person('d', 5, {key = 'npc-street-resident-male'}),
    person('b', 2, {key = 'npc-street-resident-male'})}
  faced, nativeList = nil, list
  local primary, round = selectConversation(player, true, 'cyberpunk_convai_voice')
  assert(primary and primary.entity == 'a', 'the nearest leads')
  assert(#round == 3 and round[1].entity == 'a' and round[2].entity == 'b' and round[3].entity == 'c', 'the three nearest')
  assert(#notices == 0)
  assert(lines[#lines - 1]:find('far=1', 1, true), 'the one beyond 6 m is counted as far: ' .. lines[#lines - 1])
`));

test('a companion faced, strangers fill the round; our copies, other mods\' characters and people with no usable profile are never taken twice or at all', () => selectionRun(`
  local alex = person('C1', 2, {key = 'alex', owned = true})
  party[1] = {npc = alex, entity = 'C1', profileKey = 'alex', name = 'Alex', bodyType = 'ManAverage', distance = 2, party = true, order = 1}
  local s1 = person('S1', 1, {key = 'npc-street-resident-female'})
  local s2 = person('S2', 3, {key = 'npc-street-resident-male'})
  local s3 = person('S3', 4, {key = 'npc-street-resident-male'})
  local mine = person('OWN', 1, {key = 'judy-alvarez', owned = true})
  local mod = person('SPAWN', 1, {key = 'judy-alvarez', spawned = true})
  local none = person('NONE', 1, {})
  local off = person('OFF', 1, {key = 'off'})
  local unsupported = person('UNSUP', 1, {key = 'npc-unknown'})
  faced, nativeList = alex, {alex, s1, s2, s3, mine, mod, none, off, unsupported}
  local primary, round = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(primary.entity == 'C1' and #round == 3, 'the companion and two strangers: ' .. #round)
  assert(round[2].entity == 'S1' and round[3].entity == 'S2', 'nearest strangers first')
  assert(not round[1].stranger and round[2].stranger and round[3].stranger)
  -- Three companions fill the round: the people of the street are not even looked at.
  party[2] = {npc = alex, entity = 'C2', profileKey = 'judy-alvarez', name = 'J', distance = 3}
  party[3] = {npc = alex, entity = 'C3', profileKey = 'rogue-amendiares', name = 'R', distance = 4}
  lines = {}
  local _, three = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(#three == 3 and three[3].entity == 'C3' and not three[2].stranger)
  for _, line in ipairs(lines) do assert(not line:find('people=', 1, true), line) end
`));

test('one person only: the notice names the key V can use, or the action when no key can be read', () => selectionRun(`
  local a = person('A', 2, {key = 'npc-street-resident-female'})
  faced, nativeList = a, {a}
  -- No key at all: the action's own name.
  local none = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(none == nil and notices[#notices].id == 'group-needs-two')
  assert(notices[#notices].text == 'Group chat needs two characters nearby. Use Talk by text for one person.', notices[#notices].text)
  selectConversation(player, true, 'cyberpunk_convai_voice')
  assert(notices[#notices].text:find('Use Talk by voice for one person.', 1, true), notices[#notices].text)
  -- CET's binding.
  boundText = 'Ctrl + J'
  selectConversation(player, true, 'cyberpunk_convai_text')
  assert(notices[#notices].text:find('Use Ctrl + J for one person.', 1, true), notices[#notices].text)
  -- A binding that reads as nothing (blank, no-break space, zero-width characters) is no key.
  for _, text in ipairs({' ', '', '\\194\\160', '\\226\\128\\139', ' \\226\\128\\139 '}) do
    boundText = text
    selectConversation(player, true, 'cyberpunk_convai_text')
    assert(notices[#notices].text:find('Use Talk by text for one person.', 1, true), 'blank key text ' .. #text .. ': ' .. notices[#notices].text)
  end
  -- The key set on the mod's own Key bindings page comes first, and a controller button is named as such.
  boundText, keyBindings.text, keyBindings.voice = 'Ctrl + J', 'IK_F7', 'IK_Pad_A_CROSS'
  selectConversation(player, true, 'cyberpunk_convai_text')
  assert(notices[#notices].text:find('Use F7 for one person.', 1, true), notices[#notices].text)
  selectConversation(player, true, 'cyberpunk_convai_voice')
  assert(notices[#notices].text:find('Use Controller A for one person.', 1, true), notices[#notices].text)
  for _, entry in ipairs(notices) do assert(not entry.text:find('Use  for', 1, true) and not entry.text:find('private chat', 1, true), entry.text) end
`));

test('the game\'s named characters and quest-bound people join like anybody; the ones the game is in charge of right now do not', () => selectionRun(`
  local a = person('A', 1, {key = 'npc-street-resident-female'})
  local story = person('STORY', 2, {key = 'judy-alvarez', story = true})
  local quest = person('QUEST', 3, {key = 'npc-street-resident-male', quest = true})
  faced, nativeList = a, {a, story, quest}
  local _, round = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(#round == 3 and round[2].entity == 'STORY' and round[2].story == true and round[2].guarded == nil, 'a named character, flagged story')
  assert(round[3].entity == 'QUEST' and round[3].guarded == true and round[3].story == nil, 'a quest-bound person, flagged guarded')
  -- In a scene: left out, the next person takes the place (here nobody: a round of the two others).
  busy['STORY'] = true
  local _, without = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(#without == 2 and without[2].entity == 'QUEST', 'busy is left out: ' .. #without)
  assert(lines[#lines - 1]:find('refused=1', 1, true), lines[#lines - 1])
  -- V faces the named character: it leads the round (no longer kept out of a group), unless the game has it.
  busy['STORY'] = nil
  faced = story
  local primary, led = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(primary.entity == 'STORY' and primary.story == true and #led == 3 and led[1].entity == 'STORY')
  busy['STORY'] = true
  local primary2, around = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(primary2 and primary2.entity ~= 'STORY' and #around == 2, 'faced but busy: the others, not a refusal of the whole round')
  assert(#notices == 0, 'and no notice')
`));

test('the speaker\'s turn: a game-placed speaker gets the story rules for its face and a busy one is skipped; others clear them', () => run(`
  local lines = {}
  function log(line) lines[#lines + 1] = line end
  local busy = false
  convaiWorldTalk = {PROJECTIONS = {['johnny-silverhand'] = true}, detail = nil, refusal = function() return busy and 'scene' or nil end}
  convaiFacialPlayback = {}
  convaiStory = nil
  ${speakerStory}
  local player = {}
  assert(convaiGroupSpeakerStory(player, {entity = '9ULL', profileKey = 'judy-alvarez', name = 'Judy', story = true}) == true)
  assert(convaiStory.entity == '9ULL' and convaiStory.key == 'judy-alvarez' and not convaiStory.idle and convaiStory.projection == nil)
  assert(convaiFacialPlayback.storyEntity == '9ULL' and convaiFacialPlayback.storyProjection == false)
  assert(convaiGroupSpeakerStory(player, {entity = '8ULL', profileKey = 'johnny-silverhand', name = 'Johnny', story = true}) == true)
  assert(convaiStory.projection == true and convaiFacialPlayback.storyProjection == true)
  assert(convaiGroupSpeakerStory(player, {entity = '7ULL', profileKey = 'npc-street-resident-male', name = 'Guard', guarded = true}) == true)
  assert(convaiStory.idle == true and convaiFacialPlayback.storyEntity == '7ULL', 'a quest-bound person is judged while it idles at a workspot')
  busy = true
  assert(convaiGroupSpeakerStory(player, {entity = '6ULL', profileKey = 'judy-alvarez', name = 'Judy', story = true}) == false, 'the game is in charge: skipped')
  assert(lines[#lines]:find('World conversation refused: group speaker profile=judy-alvarez reason=scene', 1, true), lines[#lines])
  busy = false
  -- An ordinary speaker clears whatever the speaker before it set.
  assert(convaiGroupSpeakerStory(player, {entity = '5ULL', profileKey = 'alex', name = 'Alex'}) == true)
  assert(convaiStory == nil and convaiFacialPlayback.storyEntity == nil and convaiFacialPlayback.storyProjection == nil)
`));

// ---- The round (mod/group-chat.lua): names, listeners and the frozen flags ----------------------------------------------------

test('a round with strangers names its people to the first speaker, lets same-profile strangers hear each other, and keeps the flags', () => run(`
  local group = (function() ${groupSource} end)()
  local people = {
    {entity = '1ULL', profileKey = 'npc-street-resident-female', name = 'Rosa Vega', generic = true, stranger = true, archetype = {npcName = 'Rosa Vega'}},
    {entity = '2ULL', profileKey = 'npc-street-resident-female', name = 'Ines Park', generic = true, stranger = true, archetype = {npcName = 'Ines Park'}},
    {entity = '3ULL', profileKey = 'judy-alvarez', name = 'Judy', story = true, stranger = true}}
  local chosen = group.choose(people[1], {people[2], people[3]}, {['npc-street-resident-female'] = true, ['judy-alvarez'] = true})
  assert(#chosen == 3, 'two strangers on one profile and a named character are three people')
  group.start('anyone', chosen, 'Hello')
  assert(group.round.participants[3].story == true and group.round.participants[1].stranger == true and group.round.participants[1].guarded == nil)
  local live = {['1ULL'] = true, ['2ULL'] = true, ['3ULL'] = true}
  local first = group.next(1, 100, live)
  assert(first.entity == '1ULL' and first.archetype.npcName == 'Rosa Vega')
  assert(#first.group.people == 3 and first.group.people[1] == 'Rosa Vega' and first.group.people[2] == 'Ines Park' and first.group.people[3] == 'Judy')
  assert(#first.group.audience == 2, 'the audience still lists a shared profile once')
  group.received(first.requestId, 'Hi.', false, {'npc-street-resident-female', 'judy-alvarez'})
  group.completed(first.requestId, true)
  local second = group.next(2, 101, live)
  assert(second.entity == '2ULL' and #second.group.heard == 1 and second.group.heard[1].speaker == 'Rosa Vega', 'the second stranger hears the first')
  group.received(second.requestId, 'Yo.', false, {'npc-street-resident-female', 'judy-alvarez'})
  group.completed(second.requestId, true)
  local third = group.next(3, 102, live)
  assert(third.entity == '3ULL' and #third.group.heard == 2)
  -- A round of companions only carries no list of names: its requests are as they always were.
  group.cancel()
  group.start('plain', {{entity = '4ULL', profileKey = 'alex', name = 'Alex'}, {entity = '5ULL', profileKey = 'judy-alvarez', name = 'Judy'}}, 'Hello')
  local plain = group.next(4, 103, {['4ULL'] = true, ['5ULL'] = true})
  assert(plain.group.people == nil)
`));

// ---- The bridge side ----------------------------------------------------------------------------------------------------------

const group = extra => ({id: 'g-1', index: 1, total: 3, audience: ['npc-street-resident-female', 'judy-alvarez'], heard: [], ...extra});

test('parseGroup keeps a list of two or three names and drops anything malformed without refusing the round', () => {
  assert.deepEqual(parseGroup(group({people: ['Rosa Vega', ' Ines Park ', 'Judy']})).people, ['Rosa Vega', 'Ines Park', 'Judy']);
  assert.equal(parseGroup(group()).people, undefined);
  for (const bad of ['Rosa', ['Rosa'], ['a', 'b', 'c', 'd'], ['Rosa', 7], ['Rosa', ''], ['Rosa', 'x'.repeat(61)], ['Rosa', 'line\nbreak'], ['Rosa', 'a b']]) {
    const parsed = parseGroup(group({people: bad}));
    assert.ok(parsed, 'the round stands');
    assert.equal(parsed.people, undefined, JSON.stringify(bad));
  }
});

test('the group context tells every speaker who is in the round, and a round without names reads as before', () => {
  const plain = groupContext({group: parseGroup(group({index: 1, total: 2}))});
  assert.match(plain, /Another companion speaks after you\./);
  assert.doesNotMatch(plain, /The people in this conversation/);
  const named = groupContext({group: parseGroup(group({people: ['Rosa Vega', 'Ines Park', 'Judy']}))});
  assert.match(named, /Another person speaks after you\./);
  assert.match(named, /The people in this conversation, in speaking order: Rosa Vega, Ines Park, Judy\./);
  assert.match(named, /"audience":\["npc-street-resident-female","judy-alvarez"\]/);
  assert.match(groupContext({group: parseGroup(group({index: 3, people: ['Rosa Vega', 'Ines Park', 'Judy']}))}), /final speaker/);
});

test('a request of a stranger in a group round parses with its names, entity and archetype', () => {
  const input = parseInput(JSON.stringify({requestId: '100-9-13ULL', generation: 9, entity: '13ULL', name: 'Rosa Vega', bodyType: 'WomanAverage',
    profileKey: 'npc-street-resident-female', text: 'Hello you two', archetype: {base: 'npc-street-resident-female', category: 'ordinary', npcName: 'Rosa Vega'},
    group: group({people: ['Rosa Vega', 'Ines Park']})}));
  assert.ok(input);
  assert.deepEqual(input.group.people, ['Rosa Vega', 'Ines Park']);
  assert.equal(input.archetype.npcName, 'Rosa Vega');
  assert.equal(input.entity, '13ULL');
});

// ---- Wiring ---------------------------------------------------------------------------------------------------------------------

test('wiring: the people are looked for on the key press only, from the key press\'s own native query, and the notice never prints an empty key', () => {
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onShutdown'"));
  assert.doesNotMatch(update, /convaiTalkNearbyPeople|convaiKeyHint|convaiGroupSpeakerStory/, 'nothing per frame');
  assert.match(selection, /convaiTalkNearbyPeople\(player, taken, 3 - count, convaiStrangerRange or 6\)/);
  assert.match(helpers, /local list = convaiTalkNative/, 'no query of its own: what the talk target already gathered');
  assert.doesNotMatch(helpers, /GetTargetParts|TargetSearchQuery/);
  assert.equal((selection.match(/convaiKeyHint\(singleAction\)/g) ?? []).length, 2, 'both group-needs-two notices name the key through the one helper');
  assert.doesNotMatch(selection, /Use private chat for one person/);
  // A group speaker\'s story state is set where the round hands over to the next speaker, once per speaker.
  assert.match(init, /if not convaiGroupSpeakerStory\(player, round\.participants\[round\.index\]\) then\s+groupChat\.received\(context\.requestId, '', true, \{\}\)/);
  // The mid-reply guard ends a group speaker\'s line, not the round.
  assert.match(init, /if type\(context\.group\) == 'table' and groupChat\.round ~= nil and groupChat\.round\.requestId == context\.requestId then/);
});
