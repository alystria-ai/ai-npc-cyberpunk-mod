import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {turnContext} from './turn-context.mjs';
import {parseInput} from './protocol.mjs';

// Characters another mod or a spawner created (docs/SPAWNED_CHARACTERS.md): generic recognition from the shared dynamic
// entity system, the talk path with their own roster profile, eye contact without fighting their AI, and nothing else.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const moduleSource = read('../mod/spawned-characters.lua');
const catalogSource = read('../mod/character-catalog.lua');
const init = read('../mod/init.lua');
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
const withModule = code => run(`local S = (function() ${moduleSource} end)()\n${code}`);

test('classify: managed and none of our tags is spawned; ours, quest-marked and game-placed characters are not', () => withModule(`
  assert(S.classify({managed = true, tags = {'SomeoneElse', 'Another'}}) == 'spawned')
  assert(S.classify({managed = true, tags = {}}) == 'spawned', 'a spawn with no tags at all')
  assert(S.classify({managed = true}) == 'spawned', 'tags that could not be read')
  assert(S.classify({managed = true, own = true}) == 'ours')
  assert(S.classify({managed = true, tags = {'Other', 'CyberpunkConvaiPartyVehicle'}}) == 'ours', 'any tag with our prefix')
  assert(S.classify({managed = true, tags = {'xCyberpunkConvai'}}) == 'spawned', 'only a prefix counts, not a substring')
  assert(S.classify({managed = true, tags = {}, quest = true}) == nil, 'a quest mod actor keeps the usual game rules')
  assert(S.classify({managed = false}) == nil and S.classify({}) == nil and S.classify(nil) == nil, 'game-placed characters')
`));

test('classify: a copy made by a record-cloning mod (clone) is spawned although the dynamic entity system or a quest flag says otherwise', () => withModule(`
  assert(S.classify({managed = false, clone = true}) == 'spawned', 'not managed, but a clone record (an NCA follower)')
  assert(S.classify({managed = true, clone = true, quest = true}) == 'spawned', 'a quest flag copied with the record does not make it a quest actor')
  assert(S.classify({managed = true, clone = true, own = true}) == 'ours', 'our own copy is still ours')
  assert(S.classify({managed = true, clone = true, tags = {'CyberpunkConvaiCompanion'}}) == 'ours')
  assert(S.classify({managed = false, clone = false}) == nil and S.classify({managed = false, quest = true}) == nil, 'no clone: unchanged')
`));

test('the service asks options.clone once per entity with the read, never changes the reader table, and treats a failing check as no clone', () => withModule(`
  local asked, shared = 0, {managed = false}
  local service = S.new({read = function() return shared end, clone = function(n) asked = asked + 1; return n.cloned == true end})
  local function npc(hash, cloned) return {hash = hash, cloned = cloned, GetEntityID = function(self) return {hash = self.hash} end} end
  assert(service:is(npc('1', true)) == true and service:kind(npc('1', true)) == 'spawned', 'a clone of a game record is spawned')
  assert(service:is(npc('2', false)) == false, 'a game-placed body is not')
  assert(shared.clone == nil, 'the reader table was changed')
  local before = asked
  for _ = 1, 10 do service:is(npc('1', true)); service:is(npc('2', false)) end
  assert(asked == before, 'the check is cached with the classification: ' .. asked .. ' vs ' .. before)
  local failing = S.new({read = function() return {managed = false} end, clone = function() error('no record') end})
  assert(failing:is(npc('3', true)) == false, 'an unreadable record is not a clone')
  -- Without the option nothing changes.
  assert(S.new({read = function() return {managed = false} end}):is(npc('4', true)) == false)
`));

test('read: the native lookups, our tags checked by name first, no answer before the system is ready', () => withModule(`
  local tagged, listed = {}, 0
  local system = {ready = true, managed = {}, tags = {}}
  function system:IsReady() return self.ready end
  function system:IsManaged(id) return self.managed[id.hash] == true end
  function system:IsTagged(id, tag) tagged[#tagged + 1] = tag.value; return (self.tags[id.hash] or {})[tag.value] == true end
  function system:GetTags(id)
    listed = listed + 1
    local out = {}
    for name in pairs(self.tags[id.hash] or {}) do out[#out + 1] = {value = name} end
    return out
  end
  Game = {GetDynamicEntitySystem = function() return system end, NameToString = function(name) return name.value end}
  CName = {new = function(text) return {value = text} end}
  local function npc(hash, quest)
    return {GetEntityID = function() return {hash = hash} end, IsQuest = function() return quest == true end}
  end
  system.managed = {['1'] = true, ['2'] = true, ['3'] = true}
  system.tags = {['1'] = {CyberpunkConvaiCompanion = true}, ['2'] = {SomeSpawnerTag = true}, ['3'] = {}}
  assert(S.classify(S.read(npc('1'))) == 'ours')
  assert(listed == 0, 'our companion tag answers before any tag list is read')
  assert(S.classify(S.read(npc('2'))) == 'spawned')
  assert(S.classify(S.read(npc('3', true))) == nil, 'quest-marked')
  assert(S.read(npc('9')).managed == false)
  for _, tag in ipairs(tagged) do assert(tag:sub(1, 15) == 'CyberpunkConvai', 'only our own tags are named: ' .. tag) end
  system.ready = false
  assert(S.read(npc('2')) == nil, 'not ready: no answer')
`));

test('the service caches per entity, retries an unanswered read, and forgets everything on a world change', () => withModule(`
  local reads, answer = 0, {}
  local service = S.new({read = function(n) reads = reads + 1; return answer[n.hash] end})
  local function npc(hash) return {hash = hash, GetEntityID = function(self) return {hash = self.hash} end} end
  answer = {['1'] = {managed = true, tags = {'Other'}}, ['2'] = {managed = false}}
  assert(service:is(npc('1')) == true and service:kind(npc('1')) == 'spawned')
  assert(service:is(npc('2')) == false and service:kind(npc('2')) == nil)
  local before = reads
  for _ = 1, 10 do service:is(npc('1')); service:is(npc('2')) end
  assert(reads == before, 'no repeated native reads, "neither" is cached too')
  assert(service:is(npc('3')) == false and service:is(npc('3')) == false and reads == before + 2, 'an unanswered read is asked again')
  assert(service:is(nil) == false)
  assert(service:is({GetEntityID = function() error('gone') end}) == false, 'an unreadable entity is not spawned')
  local failing = S.new({read = function() error('native failure') end})
  assert(failing:is(npc('1')) == false)
  service:reset()
  answer['1'] = {managed = true, own = true}
  assert(service:kind(npc('1')) == 'ours', 'after a reset the entity is read again')
  for i = 1, S.LIMIT + 5 do answer[tostring(i + 100)] = {managed = false}; service:kind(npc(tostring(i + 100))) end
  assert(service.count <= S.LIMIT, 'the cache is bounded')
`));

test('resolve: a spawned copy talks with its roster profile; a story-bound model falls back; the game-placed one talks too, a named one does not', () => run(`
  local api = (function() ${catalogSource} end)()
  local index = api.buildArchetypes(api.ARCHETYPES)
  local catalog = api.build({
    {key = 'judy-alvarez', name = 'Judy Alvarez', aliases = {'Judy'}, records = {'Character.Judy'}},
    {key = 'johnny-silverhand', name = 'Johnny Silverhand', records = {'Character.Silverhand'}},
    {key = 'resident-female', name = 'Night City Resident Female'},
    {key = 'resident-male', name = 'Night City Resident Male'}}, index)
  local function who(actor) return (api.resolve(catalog, actor)) end
  -- By record, and by display name when the spawner uses a record of its own.
  assert(who({world = false, spawned = true, name = 'Judy Alvarez', record = 'Character.Judy', bodyType = 'WomanAverage'}) == 'judy-alvarez')
  assert(who({world = false, spawned = true, name = 'Johnny Silverhand', record = 'Character.SomeSpawnerRecord', bodyType = 'ManAverage'}) == 'johnny-silverhand')
  -- The same character placed by the game is still refused.
  assert(who({world = true, name = 'Judy Alvarez', record = 'Character.Judy', bodyType = 'WomanAverage'}) == nil)
  -- A quest character's model that is not on the roster: its other facts, else a resident; never refused as story-bound.
  assert(who({world = false, spawned = true, name = 'Someone', record = 'Character.q101_x', bodyType = 'ManAverage',
    facts = {recordName = 'Character.q101_x', affiliation = 'Maelstrom', bodyType = 'ManAverage'}}) == 'npc-maelstrom-male')
  assert(who({world = false, spawned = true, name = 'Someone', record = 'Character.q101_y', bodyType = 'WomanAverage',
    facts = {recordName = 'Character.q101_y', quest = 'MainQuest'}}) == 'resident-female', 'the body type comes from the actor')
  assert(who({world = false, spawned = true, name = 'Little one', record = 'Character.q101_z',
    facts = {recordName = 'Character.q101_z', children = true, bodyType = 'WomanAverage'}}) == nil, 'never a child')
  -- The game-placed version of that quest character, with no roster profile, talks the same way since 2026-10-22 (every NPC V can target is talkable)...
  assert(who({world = true, name = 'Someone', record = 'Character.q101_x',
    facts = {recordName = 'Character.q101_x', affiliation = 'Maelstrom', bodyType = 'ManAverage'}}) == 'npc-maelstrom-male')
  -- ...but a named one is still refused.
  assert(who({world = true, name = 'Judy Alvarez', record = 'Character.Judy',
    facts = {recordName = 'Character.Judy', quest = 'MainQuest', bodyType = 'WomanAverage'}}) == nil)
`));

test('policy: a spawned character is not ours, is protected from tactics and renaming, and gets eye contact only', () => {
  const policySource = between('local protectedCache, protectedCount', '-- Recent game dialogue');
  const focusSource = between('local function beginFocus(player, npc)', 'local function gameplayCanAcquire');
  run(`
    characterCatalog = (function() ${catalogSource} end)()
    catalog = characterCatalog.build({{key = 'judy-alvarez', name = 'Judy Alvarez', records = {'Character.judy'}}},
      characterCatalog.buildArchetypes(characterCatalog.ARCHETYPES))
    local function npc(hash, record, name)
      local n = {hash = hash, record = record, name = name}
      function n:GetEntityID() return {hash = self.hash} end
      function n:GetRecordID() return self.record end
      function n:GetTweakDBFullDisplayName() return self.name end
      function n:GetBodyType() return 'WomanAverage' end
      return n
    end
    local spawnedJudy, copy, walker = npc('7', 'Character.judy', 'Judy Alvarez'), npc('6', 'Character.judy', 'Judy Alvarez'), npc('5', 'Character.w', 'Pedestrian')
    companions = {identity = function(n) if n.hash == '6' then return 'judy-alvarez', 'Judy Alvarez', true end return nil end,
      owns = function(n) return n.hash == '6' end}
    function archetypeFacts(n) return {} end
    local S = (function() ${moduleSource} end)()
    convaiSpawnedCharacters = S.new({read = function(n)
      if n.hash == '7' then return {managed = true, tags = {'SomeSpawnerTag'}} end
      if n.hash == '6' then return {managed = true, own = true} end
      return {managed = false}
    end})
    ${policySource}
    local P = convaiWorldPolicy
    assert(P.spawned(spawnedJudy) == true and P.ours(spawnedJudy) == false and P.protected(spawnedJudy) == true)
    assert(P.spawned(copy) == false and P.protected(copy) == false, 'our own copy keeps everything')
    assert(P.spawned(walker) == false and P.protected(walker) == false, 'an ordinary NPC is unchanged')
    assert(P.spawned(nil) == false)
    -- beginFocus: the spawned character gets the keep-AI focus (no hold, turn or chest twist); others the usual one.
    local calls = {}
    local player = {ConvaiBeginFocus = function(_, n, keepAI) calls[#calls + 1] = n.hash .. ':' .. tostring(keepAI); return true end}
    function endFocus() end
    convaiVanillaReactions = {focus = function() end}
    function profileIdentity(n) return ({['5'] = 'resident-female', ['7'] = 'judy-alvarez'})[n.hash] end
    function log() end
    Game = {GetWorkspotSystem = function() return {IsActorInWorkspot = function() return false end} end}
    ${focusSource.replace('local function beginFocus', 'function beginFocus')}
    assert(beginFocus(player, spawnedJudy) == true and calls[1] == '7:true', calls[1])
    assert(beginFocus(player, walker) == true and calls[2] == '5:nil', calls[2])
    -- Without the module (it failed to load) everything behaves as before.
    convaiSpawnedCharacters = nil
    assert(P.spawned(spawnedJudy) == false)
    assert(beginFocus(player, walker) == true and calls[3] == '5:nil')
  `);
});

test('wiring: identity marks spawned copies as not world, caches reset with the world, and the module ships', () => {
  assert.match(init, /local spawned = not owned and convaiSpawnedCharacters ~= nil and convaiSpawnedCharacters:is\(npc\) or nil/);
  assert.match(init, /world = managedKey == nil and not spawned, spawned = spawned,/);
  assert.match(init, /pcall\(dofile, 'spawned-characters\.lua'\)/);
  assert.equal([...init.matchAll(/if convaiSpawnedCharacters then convaiSpawnedCharacters:reset\(\) end/g)].length, 2,
    'a session release and the shutdown');
  // Nothing per frame: the module is only asked from identity, the policy and the focus start.
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onUpdate'") + 400);
  assert.doesNotMatch(update, /convaiSpawnedCharacters/);
  for (const plan of ['../packaging/release-plan.json', '../scripts/development-files.json']) {
    assert.match(read(plan), /mod\/spawned-characters\.lua/, plan);
  }
  // Engagement: the keep-AI focus sends no hold and no turn, and drives no chest.
  const engagement = read('../r6/scripts/CyberpunkConvai/Engagement.reds');
  assert.match(engagement, /public final func ConvaiBeginFocus\(npc: wref<NPCPuppet>, opt keepAI: Bool\) -> Bool/);
  assert.match(engagement, /if !keepAI && \(npc\.IsCrowd\(\) \|\| npc\.IsCharacterCivilian\(\)\) && !inWorkspot \{/);
  assert.match(engagement, /part\.weight = \(keepAI \|\| npc\.IsPlayerCompanion\(\)\) \? 0\.0 :/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Phase 2: group chat and battle and loot reactions (docs/SPAWNED_CHARACTERS.md).
const groupSource = read('../mod/group-chat.lua');
const battlePolicySource = read('../mod/battle-reactions.lua');
const lootPolicySource = read('../mod/loot-reactions.lua');

// A fake world for the service: npcs with positions, a scan that counts its calls, a clock the test moves.
const fakeWorld = `
  local now, scans, finds = 0, 0, 0
  local kinds, positions, alive, ready = {}, {}, {}, true
  local function npc(hash, x, kind)
    kinds[hash], positions[hash], alive[hash] = kind, x, true
    return {hash = hash,
      GetEntityID = function(self) return {hash = self.hash} end,
      IsAttached = function(self) return alive[self.hash] end,
      IsDeadNoStatPool = function() return false end,
      GetWorldPosition = function(self) return {x = positions[self.hash], y = 0, z = 0} end}
  end
  local player = {GetWorldPosition = function() return {x = 0, y = 0, z = 0} end}
  local scene = {}
  local service = S.new({clock = function() return now end, ready = function() return ready end,
    scan = function() scans = scans + 1; return scene end,
    find = function(id) finds = finds + 1; for _, n in ipairs(scene) do if n.hash == id.hash then return n end end return nil end,
    read = function(n)
      local kind = kinds[n.hash]
      if kind == 'game' then return {managed = false} end
      if kind == 'ours' then return {managed = true, own = true} end
      return {managed = true, tags = {'SomeSpawnerTag'}}
    end})
`;

test('nearby: one scan on demand finds spawned characters only, nearest first, and answers again for a few seconds', () => withModule(`${fakeWorld}
  scene[1], scene[2], scene[3], scene[4], scene[5] = npc('1', 6, 'spawned'), npc('2', 2, 'spawned'), npc('3', 3, 'game'),
    npc('4', 4, 'ours'), npc('5', 30, 'spawned')
  assert(scans == 0, 'nothing runs until it is asked')
  local rows = service:nearby(player, 8)
  assert(scans == 1 and #rows == 2, 'the game-placed, our own and the far one are left out: ' .. #rows)
  assert(rows[1].entity == '2' and rows[2].entity == '1' and rows[1].distance == 2 and rows[1].npc == scene[2], 'nearest first')
  assert(rows[1].id.hash == '2', 'the entity ID travels with the row')
  now = 2.9
  assert(#service:nearby(player, 8) == 2 and scans == 1, 'reused within the window')
  assert(#service:nearby(player, 3) == 1 and scans == 1, 'a smaller radius filters the same answer')
  assert(#service:nearby(player, 40) == 3 and scans == 2, 'a larger radius than the answer covers asks again')
  now = 6.5
  alive['1'] = false
  local later = service:nearby(player, 40)
  assert(scans == 3 and #later == 2, 'after the window: asked again, and a detached character is gone')
  now = 5 -- a clock that went backwards never serves an old answer
  service:nearby(player, 8); assert(scans == 4)
  ready = false
  assert(#service:nearby(player, 8) == 0 and scans == 4 and service:available() == false,
    'without the dynamic entity system nothing is scanned')
  ready = true
  local broken = S.new({clock = function() return 0 end, ready = function() return true end,
    scan = function() error('native failure') end})
  assert(#broken:nearby(player, 8) == 0, 'a failing scan is no answer, not an error')
  assert(#service:nearby(nil, 8) == 0)
`));

test('watch and watching: entity IDs only, at most three, resolved when asked, gone ones dropped, expiry, reset', () => withModule(`${fakeWorld}
  for i = 1, 5 do scene[i] = npc(tostring(i), i, 'spawned') end
  local rows = {}
  for i = 1, 5 do rows[i] = {id = {hash = tostring(i)}, entity = tostring(i), profileKey = 'k' .. i, name = 'N' .. i,
    bodyType = 'WomanAverage', npc = scene[i], extra = true} end
  assert(#service:watching() == 0 and finds == 0, 'nothing is read while nobody is watched')
  service:watch(rows)
  assert(#service.watched == S.WATCH_LIMIT and S.WATCH_LIMIT == 3)
  for _, row in ipairs(service.watched) do assert(row.npc == nil and row.extra == nil, 'no entity handle is kept') end
  local seen = service:watching()
  assert(#seen == 3 and finds == 3 and seen[1].npc == scene[1] and seen[1].profileKey == 'k1' and seen[3].entity == '3')
  alive['2'] = false
  seen = service:watching()
  assert(#seen == 2 and seen[2].entity == '3' and #service.watched == 2, 'a character that left is dropped for good')
  alive['2'] = true
  assert(#service:watching() == 2)
  now = S.WATCH_SECONDS + 1
  finds = 0
  assert(#service:watching() == 0 and finds == 0 and #service.watched == 0, 'expired: nothing is resolved')
  service:watch(rows); service:reset()
  assert(#service:watching() == 0 and service.scanned == nil)
  service:watch({}); assert(#service.watched == 0 and service.watchedAt == nil)
  service:watch(nil); assert(#service.watched == 0)
`));

// The adapter's side, cut out of init.lua: the global table, with stubs for what it reads.
const peopleSource = between('convaiSpawnedPeople = {', '-- Recent game dialogue');
function peopleRun(body) {
  run(`
    local S = (function() ${moduleSource} end)()
    Enum = {new = function(_, name) return name end}
    local now, scans, finds = 0, 0, 0
    local info, positions, attitude = {}, {}, {}
    local scene = {}
    local player = {GetWorldPosition = function() return {x = 0, y = 0, z = 0} end, GetAttitudeAgent = function() return 'player' end}
    local function npc(hash, x, key, name)
      info[hash] = {key = key, name = name}; positions[hash] = x; attitude[hash] = 'AIA_Friendly'
      return {hash = hash,
        GetEntityID = function(self) return {hash = self.hash} end,
        IsAttached = function() return true end, IsDeadNoStatPool = function() return false end,
        GetWorldPosition = function(self) return {x = positions[self.hash], y = 0, z = 0} end,
        GetAttitudeAgent = function(self) return {GetAttitudeTowards = function() return attitude[self.hash] end} end}
    end
    convaiSpawnedCharacters = S.new({clock = function() return now end, ready = function() return true end,
      scan = function() scans = scans + 1; return scene end,
      find = function(id) finds = finds + 1; for _, n in ipairs(scene) do if n.hash == id.hash then return n end end return nil end,
      read = function() return {managed = true, tags = {'SomeSpawnerTag'}} end})
    characterCatalog = {describe = function(_, key) return {category = 'ordinary', base = key} end}
    archetypes = {keys = {['npc-maelstrom-male'] = true, ['vendor'] = true}}
    supportedProfiles = {['judy-alvarez'] = true, ['panam-palmer'] = true, ['resident-male'] = true, ['npc-maelstrom-male'] = true,
      ['vendor'] = true, ['off'] = true}
    manager = {profileEnabled = function(key) return key ~= 'off' end}
    function profileIdentity(n)
      local row = info[n.hash]
      if not row then return nil end
      return row.key, row.name, 'WomanAverage'
    end
    ${peopleSource}
    ${body}
  `);
}

test('adapter nearby: spawned characters with an enabled profile; generic ones are flagged, reactions take roster only, unknowns never join', () => peopleRun(`
  scene[1], scene[2], scene[3], scene[4], scene[5], scene[6], scene[7] =
    npc('1', 5, 'judy-alvarez', 'Judy Alvarez'), npc('2', 2, 'panam-palmer', 'Panam Palmer'), npc('3', 3, 'resident-male', 'Pedestrian'),
    npc('4', 4, 'npc-maelstrom-male', 'Maelstrom'), npc('5', 1, 'off', 'Disabled'), npc('6', 1.5, nil, 'No profile'),
    npc('7', 6, 'vendor', 'Vendor')
  -- Group chat: every spawned character with an enabled profile, a roster one or a generic one.
  local rows = convaiSpawnedPeople.nearby(player, 8)
  assert(#rows == 5 and rows[1].profileKey == 'panam-palmer' and rows[2].profileKey == 'resident-male'
    and rows[3].profileKey == 'npc-maelstrom-male' and rows[4].profileKey == 'judy-alvarez' and rows[5].profileKey == 'vendor', #rows)
  assert(rows[1].spawned == true and rows[1].entity == '2' and rows[1].name == 'Panam Palmer' and rows[1].bodyType == 'WomanAverage'
    and rows[1].distance == 2 and rows[1].npc == scene[2] and rows[1].generic == nil,
    'the row shape of companions.conversationCandidates, plus spawned')
  assert(rows[2].generic == true and rows[2].archetype == nil and rows[3].generic == true and rows[3].archetype.base == 'npc-maelstrom-male',
    'a generic one is flagged and carries its archetype facts')
  local stats = convaiSpawnedPeople.stats
  assert(stats.found == 7 and stats.kept == 5 and stats.generic == 3 and stats.noProfile == 1 and stats.disabled == 1, 'what the key press logs')
  -- Reactions: roster characters only.
  rows = convaiSpawnedPeople.nearby(player, 8, {roster = true})
  assert(#rows == 2 and rows[1].profileKey == 'panam-palmer' and rows[2].profileKey == 'judy-alvarez', #rows)
  -- The caller's own native candidates count too, when the scan misses them (here: the scan sees nobody).
  local missed = npc('8', 3.5, 'panam-palmer', 'Panam Palmer')
  local seenByScan = scene[2]
  for i = #scene, 1, -1 do scene[i] = nil end
  scene[1] = seenByScan
  now = 100
  rows = convaiSpawnedPeople.nearby(player, 8, {extra = {missed, scene[1], npc('9', 12, 'judy-alvarez', 'Too far')}})
  assert(#rows == 2 and rows[1].entity == '2' and rows[2].entity == '8', 'extra: spawned and within range, once each: ' .. #rows)
  convaiSpawnedCharacters = nil
  assert(#convaiSpawnedPeople.nearby(player, 8) == 0, 'without the module nothing joins')
`));

test('adapter reactions: a fight start or a pickup asks once who is near; the watch list answers cheaply and drops enemies', () => peopleRun(`
  scene[1], scene[2], scene[3] = npc('1', 5, 'judy-alvarez', 'Judy Alvarez'), npc('2', 18, 'panam-palmer', 'Panam Palmer'),
    npc('3', 30, 'panam-palmer', 'Too far')
  local P = convaiSpawnedPeople
  assert(#P.reactionRows(player) == 0 and finds == 0 and scans == 0, 'nothing is read before the first event')
  -- Out of combat: no scan, however often the observer samples.
  for _ = 1, 50 do P.sample(player, {available = true, combat = false}, true) end
  assert(scans == 0)
  -- The fight starts: one scan. The rest of the fight is booleans.
  P.sample(player, {available = true, combat = true}, true)
  assert(scans == 1)
  for _ = 1, 50 do P.sample(player, {available = true, combat = true}, true) end
  assert(scans == 1, 'one scan per fight start')
  local rows = P.reactionRows(player)
  assert(#rows == 2 and rows[1].spawned == true and rows[1].profileKey == 'judy-alvarez' and rows[1].npc == scene[1]
    and rows[1].distance == 5 and rows[2].profileKey == 'panam-palmer' and rows[2].distance == 18, #rows)
  -- Someone who turns hostile, or walks off, is not a witness while that lasts.
  attitude['1'] = 'AIA_Hostile'; positions['2'] = 25
  assert(#P.reactionRows(player) == 0)
  attitude['1'] = 'AIA_Friendly'; positions['2'] = 18
  manager.profileEnabled = function(key) return key ~= 'judy-alvarez' end
  rows = P.reactionRows(player); assert(#rows == 1 and rows[1].profileKey == 'panam-palmer')
  manager.profileEnabled = function() return true end
  -- A new fight is a new edge; with both reactions off the edge costs nothing.
  P.sample(player, {available = true, combat = false}, true)
  now = 10; P.sample(player, {available = true, combat = true}, false)
  assert(scans == 1, 'the setting is off: no scan')
  P.sample(player, {available = true, combat = false}, false)
  now = 20; P.sample(player, {available = true, combat = true}, true)
  assert(scans == 2)
  -- A pickup asks too (the scan itself is reused for a few seconds).
  now = 21; P.watch(player); assert(scans == 2)
  now = 30; P.watch(player); assert(scans == 3)
  -- An unavailable observation is not a fight.
  P.sample(player, {available = false, combat = true}, true); assert(P.combat == false)
  P.sample(player, nil, true); assert(P.combat == false)
  convaiSpawnedCharacters = nil
  P.watch(player); assert(#P.reactionRows(player) == 0)
`));

test('reaction people: spawned witnesses join the observer list after our companions, one per profile, and battle and loot take them', () => {
  const reactionSource = between('local function reactionPeople(player, observation)', '-- Source callbacks obtain');
  run(`
    local policyModule = (function() ${battlePolicySource} end)()
    local lootModule = (function() ${lootPolicySource} end)()
    local available = {}
    battleObserver = {canSpeak = function(n, phase) available[#available + 1] = n.tag .. ':' .. phase; return true, 'available', false end}
    battles = {status = function() return {state = 'none'} end}
    supportedProfiles = {['judy-alvarez'] = true, ['panam-palmer'] = true, ['alex'] = true}
    manager = {profileEnabled = function() return true end}
    local ours = {npc = {tag = 'ours'}, entity = '1ULL', profileKey = 'judy-alvarez', name = 'Judy', bodyType = 'WomanAverage', distance = 2}
    companions = {conversationCandidates = function() return {ours} end}
    local rows = {}
    convaiSpawnedPeople = {reactionRows = function() return rows end}
    ${reactionSource}
    local player = {}
    -- Nobody watched: exactly the companions, no extra native call.
    local people, ok = reactionPeople(player, {combat = true})
    assert(ok and #people == 1 and #available == 1 and people[1] == ours, 'companions only')
    -- Watched: the spawned panam joins; the spawned judy is left out because our own Judy already speaks for that profile.
    rows = {{npc = {tag = 'spawned-judy'}, entity = '8ULL', profileKey = 'judy-alvarez', name = 'Judy Alvarez', bodyType = 'WomanAverage', distance = 4, spawned = true},
      {npc = {tag = 'spawned-panam'}, entity = '9ULL', profileKey = 'panam-palmer', name = 'Panam Palmer', bodyType = 'WomanAverage', distance = 6, spawned = true}}
    available = {}
    people = reactionPeople(player, {combat = true})
    assert(#people == 2 and people[2].entity == '9ULL' and people[2].spawned == true and people[2].available == true, 'merged: ' .. #people)
    assert(available[2] == 'spawned-panam:start', 'its speaking availability is asked like a companion: ' .. tostring(available[2]))
    people = reactionPeople(player, {combat = false})
    assert(available[#available] == 'spawned-panam:end', 'after the fight the phase is end: ' .. tostring(available[#available]))
    -- The battle policy takes them as witnesses by entity and profile, and offers them a turn.
    local policy = policyModule.new()
    local now = 1000
    local sample = {available = true, blocked = false, combat = false, opponents = {}}
    local function tick(dt, combat) now = now + dt; sample.combat = combat; policy.update(sample, dt, now, true, people) end
    tick(0, false); tick(.5, true); tick(3, true)
    local offer = assert(policy.offer(false, {people[2]}, now), 'battle offer')
    assert(offer.person.entity == '9ULL' and offer.person.profileKey == 'panam-palmer' and offer.phase == 'start', 'offer person')
    local names = table.concat(policy.capture().witnesses, ',')
    assert(names == 'judy-alvarez,panam-palmer', 'the spawned character is mentioned by profile: ' .. names)
    -- The loot policy takes the same rows: a pickup comment can come from the spawned character.
    local loot = lootModule.new()
    local lootNow = 1000
    local function lootTick(dt) lootNow = lootNow + dt; loot.update({available = true, blocked = false, paused = false, combat = false, holdForBattle = false}, dt, lootNow, true, people) end
    lootTick(0)
    local accepted = loot.acquire({acquisitionId = 'one', identity = 'hash-one', record = 'Items.Drink', name = 'NiCola', quantity = 1,
      quality = 'Common', category = 'Consumable', newlyAcquired = false, source = 'world', confirmed = true}, {people[2]}, lootNow)
    assert(accepted, 'a pickup seen by the spawned character is accepted')
    for _ = 1, 6 do lootTick(1) end
    local event = assert(loot.offer(false, people, lootNow), 'loot offer')
    assert(event.person.entity == '9ULL' and event.person.profileKey == 'panam-palmer' and event.reaction.kind == 'loot', 'loot person')
    -- Without the helper (an old install) nothing changes.
    convaiSpawnedPeople = nil
    people = reactionPeople(player, {combat = true}); assert(#people == 1, 'without helper')
  `);
});

test('turn context: the spawned characters of the group round are with V, with no activity; other turns are unchanged', () => {
  const partySource = between('        party = function(player, radius)', '        -- Music and TV, and other mods\' state').replace(/,\s*$/, '');
  run(`
    companions = {conversationCandidates = function() return {{profileKey = 'panam-palmer', name = 'Panam'}} end}
    groupChat = {round = nil}
    local party
    ${partySource.replace(/^\s*party = function/, 'party = function')}
    local rows = party({}, 15)
    assert(#rows == 1, 'no round: just the companions')
    groupChat.round = {participants = {{profileKey = 'judy-alvarez', name = 'Judy Alvarez', spawned = true},
      {profileKey = 'panam-palmer', name = 'Panam'}, {profileKey = 'alex', name = 'Alex'}}}
    rows = party({}, 15)
    assert(#rows == 2 and rows[2].profileKey == 'judy-alvarez' and rows[2].name == 'Judy Alvarez' and rows[2].activity == nil,
      'the spawned member joins the party rows without an activity; our own members are not repeated')
  `);
  // The bridge words it as company and claims nothing about what she is doing.
  const text = turnContext(parseInput(JSON.stringify({requestId: '100-1-11ULL', generation: 1, entity: '11ULL',
    profileKey: 'panam-palmer', name: 'Panam', bodyType: 'WomanAverage', text: 'Hi',
    group: {id: 'g1', index: 1, total: 2, audience: ['panam-palmer', 'judy-alvarez'], heard: []},
    turnContext: {version: 1, status: 'ready', hour: 14, minute: 5, district: 'Watson', gender: 'female', vehicle: false,
      party: [{key: 'judy-alvarez', name: 'Judy Alvarez'}]}})));
  assert.match(text, /Also with V: Judy Alvarez\./);
  assert.doesNotMatch(text, /following V|sitting|standing near/);
});

test('offers: a spawned speaker makes no leave offer about our party, in a group round or outside one', () => {
  const offerSource = between('    leaveOffer = function(entity, context)', '    queueFollow = function');
  run(`
    local asked = {}
    adoption = {leaveOffer = function(entity, context) asked[#asked + 1] = entity; return {members = {1}} end}
    groupChat = {round = nil}
    local options = {}
    ${offerSource.replace(/,\s*$/, '').replace(/^\s*leaveOffer = function/, 'options.leaveOffer = function')}
    assert(options.leaveOffer('1ULL', {}) ~= nil, 'no round: as before')
    groupChat.round = {participants = {{entity = '1ULL', spawned = true}, {entity = '2ULL'}}}
    assert(options.leaveOffer('1ULL', {}) == nil, 'the spawned first speaker offers nothing')
    assert(options.leaveOffer('2ULL', {}) ~= nil, 'our own companion still can')
    assert(#asked == 2)
  `);
});

test('wiring: group chat and reactions ask for spawned characters on events only, behind the setting and behind the module', () => {
  const selection = between('local function selectConversation(', 'local function voiceTargetValid');
  assert.match(selection, /if companionCount < 3 and convaiSpawnedPeople then\s+for _, row in ipairs\(convaiSpawnedPeople\.nearby\(player, 8, \{extra = convaiTalkNative\}\)\)/,
    'a group key press, after the companions, whoever V faces, never once three companions fill the round');
  assert.match(selection, /Group candidates: companions=/, 'the key press logs what it found, so a missing character can be told from a filtered one');
  assert.match(init, /convaiTalkNative = candidates/);
  assert.match(selection, /spawned = convaiWorldPolicy ~= nil and convaiWorldPolicy\.spawned\(npc\) or nil/);
  // Nothing in the group or reaction path writes into companions state.
  assert.doesNotMatch(peopleSource.split('\n').filter(line => !line.trim().startsWith('--')).join('\n'), /companions\./);
  // Reactions: the watch is asked at a fight start (the observer's own poll) and by a pickup, never by the per-poll list.
  assert.match(init, /if convaiSpawnedPeople then\s+convaiSpawnedPeople\.sample\(player, battleSample, manager\.battleReactions\(\) or manager\.lootReactions\(\)\)/);
  assert.match(init, /if convaiSpawnedPeople and manager\.lootReactions\(\) then convaiSpawnedPeople\.watch\(player\) end/);
  const reactionSource = between('local function reactionPeople(player, observation)', '-- Source callbacks obtain');
  assert.doesNotMatch(reactionSource, /\.watch\(|\.nearby\(|scan/, 'the half-second list never scans');
  assert.match(init, /if person\.spawned then pcall\(function\(\) return person\.npc:ConvaiFaceRequest\(\) end\) end/);
  assert.match(init, /groupChat\.onSpawned = function\(\) if convaiTurnContext then convaiTurnContext:reset\('group-spawned'\) end end/);
  // The scan is the auto-connect scan's own query; nothing in the module moves, equips, seats or renames anyone.
  assert.match(moduleSource, /query\.searchFilter = Game\['TSF_NPC;'\]\(\)/);
  const code = moduleSource.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /Teleport|Mount|Equip|SetName|Workspot|AIAction|ChangeAttitude/i);
  assert.match(groupSource, /row\.spawned = person\.spawned/);
  // Not per frame: the new calls are in no per-frame callback.
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onUpdate'") + 400);
  assert.doesNotMatch(update, /convaiSpawnedPeople/);
});

// The live bug (2026-10-17): V faces one of OUR companions, two characters another mod spawned stand nearby, and F7 said group
// chat needs two people. Spawned characters count whoever V faces, whether the scan sees them or not, and generic ones too.
function selectionRun(body) {
  const selection = between('local function selectConversation(', 'local function voiceTargetValid');
  peopleRun(`
    local scanSees, scanList = true, nil
    local lines, notices = {}, {}
    local world = {}
    function log(line) lines[#lines + 1] = line end
    groupChat = (function() ${groupSource} end)()
    local function body(hash, x) return {hash = hash, x = x,
      GetEntityID = function(self) return {hash = self.hash} end,
      IsAttached = function() return true end, IsDeadNoStatPool = function() return false end,
      GetWorldPosition = function(self) return {x = self.x, y = 0, z = 0} end,
      GetAttitudeAgent = function() return {GetAttitudeTowards = function() return 'AIA_Friendly' end} end} end
    -- Our companion Alex (entity C1) and two characters another mod spawned.
    local alex = body('C1', 2)
    local sA, sB = npc('S1', 4, 'judy-alvarez', 'Judy Alvarez'), npc('S2', 5, 'panam-palmer', 'Panam Palmer')
    supportedProfiles['alex'] = true
    info['C1'] = {key = 'alex', name = 'Alex'}
    local ours = {npc = alex, entity = 'C1', profileKey = 'alex', name = 'Alex', bodyType = 'ManAverage', distance = 2}
    companions = {conversationCandidates = function() return {ours} end}
    local function readOf(n) if n.hash == 'C1' then return {managed = true, own = true} end return {managed = true, tags = {'SomeSpawnerTag'}} end
    convaiSpawnedCharacters = S.new({clock = function() return now end, ready = function() return true end,
      scan = function() scans = scans + 1; if scanList then return scanList end; if scanSees then return {sA, sB, alex} end return {} end,
      find = function(id) return world[id.hash] end, read = readOf})
    for _, n in ipairs({alex, sA, sB}) do world[n.hash] = n end
    -- What the key press already gathered natively when V faces Alex.
    local faced, nativeList = alex, {alex, sA, sB}
    function targetAtCrosshair() convaiTalkNative = nativeList; return faced, nil, {} end
    function logTalkTarget() end
    function profileEnabled() return true end
    ui = {boundKey = function() return 'F7' end, t = function(text) return text end}
    convaiNotices = {send = function(_, id) notices[#notices + 1] = id end}
    convaiTalkTarget = {remember = function() end}
    function currentDistrict() return nil end
    convaiNpcNames = nil
    convaiWorldPolicy = {spawned = function(n) return n.hash:sub(1, 1) == 'S' end, story = function() return false end}
    convaiHolocall, convaiAddons = nil, nil
    ${selection}
    ${body}
  `);
}
test('facing one of our companions with two spawned characters nearby gives a three-person round (the F7 bug)', () => selectionRun(`
  local primary, participants = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(#notices == 0, 'no "needs two characters" notice: ' .. table.concat(notices, ','))
  assert(primary and primary.profileKey == 'alex' and primary.entity == 'C1')
  assert(participants and #participants == 3, 'three people: ' .. tostring(participants and #participants))
  assert(participants[1].profileKey == 'alex' and participants[2].profileKey == 'judy-alvarez' and participants[3].profileKey == 'panam-palmer')
  assert(participants[2].spawned == true and participants[3].spawned == true and participants[1].spawned == nil)
  assert(scans == 1, 'one query on the key press')
  assert(lines[#lines]:find('Group candidates: companions=1 spawned=2', 1, true), lines[#lines])
  -- Pressing again within three seconds reuses the scan.
  selectConversation(player, true, 'cyberpunk_convai_text'); assert(scans == 1)
  -- Facing a spawned character gives the same three.
  faced = sA
  local _, again = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(#again == 3 and again[1].profileKey == 'judy-alvarez')
  -- The scan finding nobody (a character outside what it reports) does not matter: the key press's own native candidates count.
  faced, scanSees, now = alex, false, 50
  local _, viaNative = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(#viaNative == 3, 'counted from the native candidates: ' .. #viaNative)
  -- Nobody spawned nearby: the notice, as before.
  world['S1'], world['S2'] = nil, nil -- both despawned: nobody is left to remember
  nativeList, now = {alex}, 100
  local none = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(none == nil and notices[#notices] == 'group-needs-two')
  -- Three companions fill the round: no query at all.
  nativeList, now, scans = {alex, sA, sB}, 200, 0
  local full = {ours, {npc = alex, entity = 'C2', profileKey = 'panam-palmer', name = 'P', distance = 3}, {npc = alex, entity = 'C3', profileKey = 'judy-alvarez', name = 'J', distance = 4}}
  companions.conversationCandidates = function() return full end
  local _, three = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(#three == 3 and scans == 0 and three[2].entity == 'C2', 'three companions: no scan')
`));

test('two generic spawned people (the same profile) and our companion are three people; the audience lists the profile once', () => selectionRun(`
  -- Two gangers another mod spawned share one generic profile.
  local g1, g2 = npc('S3', 3, 'resident-male', 'Pedestrian'), npc('S4', 4, 'resident-male', 'Pedestrian')
  nativeList = {alex, g1, g2}
  convaiSpawnedCharacters = S.new({clock = function() return now end, ready = function() return true end,
    scan = function() return {g1, g2, alex} end, read = readOf})
  local primary, participants = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(participants and #participants == 3 and participants[2].generic == true and participants[3].generic == true,
    'three people: ' .. tostring(participants and #participants))
  assert(participants[2].archetype and participants[2].archetype.category == 'resident' and participants[3].entity == 'S4')
  -- Facing a spawned generic person works the same.
  faced = g1
  local _, again = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(#again == 3 and again[1].generic == true and again[1].entity == 'S3' and again[2].entity == 'C1' and again[3].entity == 'S4',
    'the faced one first, then our companion, then the other generic person')
  -- The round's inputs list a shared profile once, and every body still speaks.
  groupChat.start('generic', participants, 'Hello')
  local live = {C1 = true, S3 = true, S4 = true}
  local first = groupChat.next(1, 100, live)
  assert(first.entity == 'C1' and #first.group.audience == 2 and first.group.audience[1] == 'alex'
    and first.group.audience[2] == 'resident-male' and first.group.total == 3, 'audience: ' .. table.concat(first.group.audience, ','))
  groupChat.received(first.requestId, 'Hi', false, {'alex', 'resident-male', 'resident-male'})
  groupChat.completed(first.requestId, true)
  local second = groupChat.next(2, 101, live)
  assert(second.entity == 'S3' and second.group.index == 2 and #second.group.heard == 1)
  groupChat.received(second.requestId, 'Yo', false, {'alex', 'resident-male', 'resident-male'})
  groupChat.completed(second.requestId, true)
  local third = groupChat.next(3, 102, live)
  assert(third.entity == 'S4' and third.group.index == 3 and #third.group.heard == 2, 'the third hears both')
  -- A named profile is still one voice per round.
  local chosen = groupChat.choose({entity = 'a', profileKey = 'alex'}, {{entity = 'b', profileKey = 'alex', spawned = true},
    {entity = 'c', profileKey = 'resident-male', generic = true}, {entity = 'd', profileKey = 'resident-male', generic = true}},
    {alex = true, ['resident-male'] = true})
  assert(#chosen == 3 and chosen[2].entity == 'c' and chosen[3].entity == 'd')
`));

// The live bug, second half (2026-10-17, 09:08:39): facing Alex with Jackie at about 5 m and Judy at about 1.7 m, only two answered.
// The key press's own queries (the scan and the native talk-target candidates) report only what the camera sees, so one spawned
// character was never a candidate. Every spawned character V's queries have ever reported is remembered by its ID and resolved on
// the key press, wherever V faces.
test('a spawned character outside the aim cone that no query reports now still counts, found from memory (the F7 bug, second half)', () => selectionRun(`
  -- Judy at 1.7 m, Panam at 5 m, both seen once (V looked at them while the other mod spawned them).
  positions['S1'], positions['S2'] = 1.7, 5
  local _, seenOnce = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(#seenOnce == 3 and lines[#lines]:find('via scan', 1, true), lines[#lines])
  -- V now faces Alex: the aim cone holds Alex only, and the scan reports Panam (at 5 m) but not Judy behind V.
  now = 50
  scanList, nativeList = {sB, alex}, {alex}
  local primary, round = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(#notices == 0 and primary.profileKey == 'alex')
  assert(round and #round == 3, 'three people: ' .. tostring(round and #round))
  assert(round[1].profileKey == 'alex' and round[2].profileKey == 'judy-alvarez' and round[3].profileKey == 'panam-palmer', 'nearest spawned first')
  assert(round[2].spawned == true and round[2].source == 'remembered' and round[3].source == 'scan')
  local line = lines[#lines]
  assert(line:find('Group candidates: companions=1 spawned=2', 1, true), line)
  assert(line:find('radius=8m', 1, true) and line:find('judy-alvarez d=1.7 via remembered', 1, true)
    and line:find('panam-palmer d=5.0 via scan', 1, true) and line:find('left out: none', 1, true), line)
  -- Facing a spawned character with the other one remembered: the same three.
  now, faced, scanList, nativeList = 100, sB, {sB}, {sB}
  local _, faced3 = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(#faced3 == 3 and faced3[1].profileKey == 'panam-palmer' and faced3[2].profileKey == 'alex' and faced3[3].profileKey == 'judy-alvarez')
  -- Facing Judy (native candidate) while Panam is remembered only.
  now, faced, scanList, nativeList = 150, sA, {}, {sA}
  local _, viaJudy = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(#viaJudy == 3 and viaJudy[1].profileKey == 'judy-alvarez', 'facing Judy, Panam from memory')
  assert(lines[#lines]:find('judy-alvarez d=1.7 via native', 1, true) and lines[#lines]:find('panam-palmer d=5.0 via remembered', 1, true), lines[#lines])
`));

test('a remembered character that walked beyond group range, despawned or never was seen is left out, and the log says why with distances', () => selectionRun(`
  positions['S1'], positions['S2'] = 1.7, 5
  selectConversation(player, true, 'cyberpunk_convai_text')
  scanList, nativeList, now = {alex}, {alex}, 50
  -- Judy walked 12 m away: out of range (still remembered), Panam is counted.
  positions['S1'] = 12
  local _, near = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(#near == 2 and near[2].profileKey == 'panam-palmer')
  local line = lines[#lines]
  assert(line:find('companions=1 spawned=1', 1, true) and line:find('left out: judy-alvarez d=12.0 out-of-range', 1, true), line)
  assert(convaiSpawnedCharacters.knownBy['S1'] ~= nil, 'still remembered: she may come back')
  positions['S1'], now = 2, 100
  local _, back = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(#back == 3, 'back within range: counted again')
  -- Panam despawned (the entity is gone): left out as gone, and forgotten.
  world['S2'], now = nil, 150
  local _, gone = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(#gone == 2 and lines[#lines]:find('panam-palmer gone', 1, true), lines[#lines])
  assert(convaiSpawnedCharacters.knownBy['S2'] == nil, 'forgotten')
  -- One that no query ever reported cannot be found (the documented limit): only Alex and the remembered Judy.
  convaiSpawnedCharacters:reset()
  now = 200
  local alone = selectConversation(player, true, 'cyberpunk_convai_text')
  assert(alone == nil and notices[#notices] == 'group-needs-two', 'nobody remembered, nobody reported: the notice, as before')
  assert(lines[#lines]:find('companions=1 spawned=0', 1, true) and lines[#lines]:find('counted: none; left out: none', 1, true), lines[#lines])
`));

test('remember and recall: IDs only, resolved on demand, bounded, nothing resolved while nothing is remembered', () => withModule(`${fakeWorld}
  local function row(n, key) return {id = {hash = n.hash}, entity = n.hash, key = key, name = 'N' .. n.hash} end
  assert(service.known and #service.known == 0 and S.KNOWN_LIMIT == 12)
  local a, b, c = npc('1', 3, 'spawned'), npc('2', 9, 'spawned'), npc('3', 40, 'spawned')
  scene[1], scene[2], scene[3] = a, b, c
  local rows, dropped = service:recall(player, 8)
  assert(#rows == 0 and #dropped == 0 and finds == 0, 'nothing remembered: nothing resolved')
  service:remember({row(a, 'judy'), row(b, 'panam'), row(c, 'kerry'), {entity = 'x'}, {id = {hash = 'y'}}, 'junk'})
  assert(#service.known == 3, 'a row needs an ID and an entity string')
  for _, entry in ipairs(service.known) do assert(entry.npc == nil, 'no entity handle is kept') end
  rows, dropped = service:recall(player, 8)
  assert(#rows == 1 and rows[1].entity == '1' and rows[1].source == 'remembered' and rows[1].key == 'judy' and rows[1].npc == a and rows[1].distance == 3)
  assert(#dropped == 2 and dropped[1].reason == 'out-of-range' and dropped[1].distance == 9 and dropped[2].distance == 40 and finds == 3)
  -- present and accept skip an entry before it is resolved.
  finds = 0
  rows = service:recall(player, 50, {['1'] = true}, function(entry) return entry.key ~= 'kerry' end)
  assert(#rows == 1 and rows[1].entity == '2' and finds == 1, 'one lookup: ' .. finds)
  -- A detached one is kept (it may stream back in), a gone one is forgotten.
  alive['1'] = false
  rows, dropped = service:recall(player, 50)
  assert(#rows == 2 and dropped[1].reason == 'detached' and #service.known == 3)
  scene[2] = {hash = 'zz'}
  rows, dropped = service:recall(player, 50)
  assert(dropped[#dropped].reason == 'gone' and #service.known == 2 and service.knownBy['2'] == nil)
  -- A character that no longer reads as spawned is forgotten too.
  kinds['3'] = 'game'; service.cache = {}; service.count = 0
  rows, dropped = service:recall(player, 50)
  assert(#service.known == 1 and service.knownBy['3'] == nil)
  -- Bounded: the one seen longest ago leaves first; seeing one again refreshes it.
  service:reset(); assert(#service.known == 0 and next(service.knownBy) == nil)
  for i = 1, S.KNOWN_LIMIT do now = i; service:remember({{id = {hash = 'k' .. i}, entity = 'k' .. i}}) end
  now = 20; service:remember({{id = {hash = 'k1'}, entity = 'k1', key = 'judy'}})
  now = 21; service:remember({{id = {hash = 'new'}, entity = 'new'}})
  assert(#service.known == S.KNOWN_LIMIT and service.knownBy['k1'] ~= nil and service.knownBy['k1'].key == 'judy'
    and service.knownBy['k2'] == nil and service.knownBy['new'] ~= nil, 'the oldest (k2) left, the refreshed k1 stayed')
  assert(#service:recall(nil, 8) == 0 and #service:recall(player, 8, nil) >= 0)
`));

test('adapter: nearby remembers each kept character with its profile key, and describe lists who counted and who did not', () => peopleRun(`
  scene[1], scene[2], scene[3], scene[4] = npc('1', 5, 'judy-alvarez', 'Judy Alvarez'), npc('2', 2, 'panam-palmer', 'Panam Palmer'),
    npc('5', 1, 'off', 'Disabled'), npc('7', 6, 'vendor', 'Vendor')
  local rows = convaiSpawnedPeople.nearby(player, 8)
  local service = convaiSpawnedCharacters
  assert(#rows == 3 and rows[1].source == 'scan')
  assert(service.knownBy['1'].key == 'judy-alvarez' and service.knownBy['1'].name == 'Judy Alvarez' and service.knownBy['2'].key == 'panam-palmer')
  local text = convaiSpawnedPeople.describe()
  assert(text:find('radius=8m', 1, true) and text:find('panam-palmer d=2.0 via scan', 1, true) and text:find('judy-alvarez d=5.0 via scan', 1, true), text)
  assert(text:find('off d=1.0 disabled', 1, true), 'a character left out for its profile says so: ' .. text)
  -- Many left out: the list is cut with a count, so the line stays short.
  for i = 1, 9 do scene[#scene + 1] = npc('9' .. i, 7, 'off', 'Disabled ' .. i) end
  now = 100
  convaiSpawnedPeople.nearby(player, 8)
  assert(convaiSpawnedPeople.describe():find('+4 more', 1, true), convaiSpawnedPeople.describe())
  -- The scan finding nobody now: Judy and Panam come back from memory with their keys.
  for i = #scene, 1, -1 do scene[i] = nil end
  scene[1] = npc('2', 2, 'panam-palmer', 'Panam Palmer'); scene[2] = npc('1', 5, 'judy-alvarez', 'Judy Alvarez')
  local keep = {scene[1], scene[2]}
  now = 200
  -- (the fake find resolves through scene, so keep them reachable but make the scan itself report nothing)
  convaiSpawnedCharacters = S.new({clock = function() return now end, ready = function() return true end, scan = function() return {} end,
    find = function(id) for _, n in ipairs(keep) do if n.hash == id.hash then return n end end return nil end,
    read = function() return {managed = true, tags = {'SomeSpawnerTag'}} end})
  convaiSpawnedCharacters:remember({{id = {hash = '1'}, entity = '1', key = 'judy-alvarez', name = 'Judy Alvarez'}})
  rows = convaiSpawnedPeople.nearby(player, 8)
  assert(#rows == 1 and rows[1].profileKey == 'judy-alvarez' and rows[1].source == 'remembered', 'from memory: ' .. #rows)
`));

test('wiring: remembered IDs are asked on a key press or in the once-a-second scan, never per frame; the log names the source', () => {
  assert.match(init, /convaiSpawnedPeople\.describe\(\)\)/);
  assert.match(init, /pcall\(convaiSpawnedCharacters\.remember, convaiSpawnedCharacters, \{\{id = npc:GetEntityID\(\), entity = primary\.entity, key = key, name = name\}\}\)/);
  const code = moduleSource.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  assert.match(code, /source = 'remembered'/);
  assert.match(code, /KNOWN_LIMIT = 12/);
  // The module keeps IDs, not handles: a known entry has no npc field.
  assert.doesNotMatch(code, /entry = \{[^}]*npc =/);
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onUpdate'") + 400);
  assert.doesNotMatch(update, /convaiSpawnedCharacters|recall|remember/);
});

test('any talk key press remembers the spawned characters among its native candidates, without a profile lookup', () => peopleRun(`
  scene[1], scene[2] = npc('1', 5, 'judy-alvarez', 'Judy Alvarez'), npc('2', 2, 'panam-palmer', 'Panam Palmer')
  local service = convaiSpawnedCharacters
  convaiSpawnedPeople.noteNative(nil); convaiSpawnedPeople.noteNative({})
  assert(#service.known == 0)
  convaiSpawnedPeople.noteNative({scene[1], scene[2], {GetEntityID = function() error('unreadable') end}})
  assert(#service.known == 2 and service.knownBy['1'] ~= nil and service.knownBy['1'].key == nil)
  local before = #service.known
  convaiSpawnedPeople.noteNative({scene[1]})
  assert(#service.known == before, 'the same character once')
  convaiSpawnedCharacters = nil
  convaiSpawnedPeople.noteNative({scene[1]})
`));
test('wiring: every talk key press notes its native candidates', () => {
  assert.match(init, /if convaiSpawnedPeople then convaiSpawnedPeople\.noteNative\(convaiTalkNative\) end/);
});
