import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

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
