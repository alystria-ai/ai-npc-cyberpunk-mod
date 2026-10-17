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

test('resolve: a spawned copy talks with its roster profile; a story-bound model falls back; the game-placed one still does not', () => run(`
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
  -- The game-placed version of that quest character stays refused.
  assert(who({world = true, name = 'Someone', record = 'Character.q101_x',
    facts = {recordName = 'Character.q101_x', affiliation = 'Maelstrom', bodyType = 'ManAverage'}}) == nil)
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

test('adapter nearby: spawned characters with an enabled roster profile; residents, archetypes and unknowns never join', () => peopleRun(`
  scene[1], scene[2], scene[3], scene[4], scene[5], scene[6], scene[7] =
    npc('1', 5, 'judy-alvarez', 'Judy Alvarez'), npc('2', 2, 'panam-palmer', 'Panam Palmer'), npc('3', 3, 'resident-male', 'Pedestrian'),
    npc('4', 4, 'npc-maelstrom-male', 'Maelstrom'), npc('5', 1, 'off', 'Disabled'), npc('6', 1.5, nil, 'No profile'),
    npc('7', 6, 'vendor', 'Vendor')
  local rows = convaiSpawnedPeople.nearby(player, 8)
  assert(#rows == 2 and rows[1].profileKey == 'panam-palmer' and rows[2].profileKey == 'judy-alvarez', #rows)
  assert(rows[1].spawned == true and rows[1].entity == '2' and rows[1].name == 'Panam Palmer' and rows[1].bodyType == 'WomanAverage'
    and rows[1].distance == 2 and rows[1].npc == scene[2], 'the row shape of companions.conversationCandidates, plus spawned')
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
  const partySource = between('        party = function(player, radius)', '        -- Read the game\'s dialogue volume').replace(/,\s*$/, '');
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
  assert.match(selection, /if #candidates < 3 and convaiSpawnedPeople then\s+for _, row in ipairs\(convaiSpawnedPeople\.nearby\(player, 8\)\)/,
    'a group key press, after the companions, never once three companions fill the round');
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
