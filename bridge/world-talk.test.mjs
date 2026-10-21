import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Talking to the game's own named characters where they stand (docs/WORLD_CHARACTERS.md): the policy, the guard that keeps the
// mod out of scenes, fights and rides, the face and speech wiring, and everything that must NOT happen for such a character.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const moduleSource = read('../mod/world-talk.lua');
const catalogSource = read('../mod/character-catalog.lua');
const init = read('../mod/init.lua');
const between = (from, to, source = init) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return source.slice(start, end);
};
const identitySource = between('local function profileIdentity(npc, forceFacts)', '-- Characters another mod or a spawner created');
const policySource = between('local protectedCache, protectedCount', '-- Recent game dialogue');
const focusSource = between('local function beginFocus(player, npc)', 'local function gameplayCanAcquire');
const guardSource = between('speech.storyGuard = function', 'local function reactionLease');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}
const withModule = code => run(`local W = (function() ${moduleSource} end)()\n${code}`);

// ---------------------------------------------------------------------------------------------------------------------
// The guard: when the game is in charge of the character.

test('classify: every reason the game is in charge, in order; a fact that could not be read refuses', () => withModule(`
  local function facts(over)
    local f = {gone = false, hub = false, dialogue = false, driven = false, combat = false, hurt = false, mounted = false}
    for k, v in pairs(over or {}) do f[k] = v end
    return f
  end
  assert(W.classify(facts()) == nil, 'an idle character the game is not using')
  assert(W.classify(facts({gone = true})) == 'gone')
  assert(W.classify(facts({hub = true})) == 'hub', 'V is in a quest conversation, a phone call or a scene')
  assert(W.classify(facts({dialogue = true})) == 'dialogue', 'the character is in a scene or quest dialogue')
  assert(W.classify(facts({driven = true})) == 'driven', 'a scene or quest commands the AI')
  assert(W.classify(facts({combat = true})) == 'combat')
  assert(W.classify(facts({playerCombat = true})) == 'combat', 'V in a fight')
  assert(W.classify(facts({hurt = true})) == 'hurt', 'injured, defeated, unconscious, stunned or ragdolled')
  assert(W.classify(facts({mounted = true})) == 'vehicle')
  assert(W.classify(facts({gone = true, dialogue = true, combat = true})) == 'gone', 'the first reason wins')
  assert(W.classify(facts({hub = true, dialogue = true})) == 'hub')
  for _, name in ipairs({'gone', 'hub', 'dialogue', 'driven', 'combat', 'hurt', 'mounted'}) do
    local partial = facts(); partial[name] = nil
    assert(W.classify(partial) == 'unreadable', name .. ' unread must refuse (fail closed)')
  end
  assert(W.classify(nil) == 'unreadable' and W.classify({}) == 'unreadable')
`));

// A fake game: the natives the guard reads, with counters, so a test can say what was and was not asked.
const fakeGame = `
  local calls, state = {}, {attached = true, dead = false, autonomous = true, combat = false, dialogue = false, mounted = false, tags = {}}
  local function count(name) calls[name] = (calls[name] or 0) + 1 end
  local npc = {}
  function npc:IsAttached() count('attached'); return state.attached end
  function npc:IsDeadNoStatPool() return state.dead end
  function npc:IsOnAutonomousAI() count('autonomous'); return state.autonomous end
  function npc:GetEntityID() return {hash = '77'} end
  NPCPuppet = {IsInCombat = function() count('combat'); return state.combat end}
  StatusEffectSystem = {ObjectHasStatusEffectWithTag = function(_, tag) count('tag'); return state.tags[tag.value] == true end}
  CName = {new = function(text) return {value = text} end}
  local scene = {IsEntityInDialogue = function() count('dialogue'); return state.dialogue end,
    IsEntityInScene = function() count('inScene'); return true end}
  Game = {GetSceneSystem = function() return {GetScriptInterface = function() return scene end} end,
    GetMountingFacility = function() return {IsMountedToAnything = function() count('mounted'); return state.mounted end} end}
  local playerSample = {available = true, dialogue = false, choices = false, call = false, tier = 1, combat = false}
`;

test('read: the natives, the player-side quest conversation, and the broad scene flag is never read', () => withModule(`
  ${fakeGame}
  local function reason() return W.classify(W.read(npc, 'V', function() return playerSample end)) end
  assert(reason() == nil)
  assert(calls.inScene == nil, 'IsEntityInScene stays true in ordinary gameplay: it must never be read')
  state.dialogue = true; assert(reason() == 'dialogue'); state.dialogue = false
  state.autonomous = false; assert(reason() == 'driven'); state.autonomous = true
  state.combat = true; assert(reason() == 'combat'); state.combat = false
  state.mounted = true; assert(reason() == 'vehicle'); state.mounted = false
  state.attached = false; assert(reason() == 'gone'); state.attached = true
  state.dead = true; assert(reason() == 'gone'); state.dead = false
  for _, tag in ipairs({'Injured', 'Defeated', 'Unconscious', 'Stunned', 'Ragdoll'}) do
    state.tags[tag] = true; assert(reason() == 'hurt', tag); state.tags[tag] = nil
  end
  -- A dialogue choice on screen at scene tier 1, with V not in a dialogue and not on a call, is the game's "Talk" prompt on an idle
  -- character (a ripperdoc, a vendor, a door or terminal in view): it must not refuse (the "busy right now" bug of 2026-10-18).
  playerSample.choices = true; assert(reason() == nil, 'an interaction prompt alone is not a quest conversation')
  playerSample.tier = nil; assert(reason() == 'hub', 'a choice with the scene tier unknown fails closed'); playerSample.tier = 1
  playerSample.tier = 2; assert(reason() == nil, 'a choice at tier 2 (staged gameplay: Viktor, Misty) is the Talk prompt'); playerSample.tier = 1
  playerSample.tier = 3; assert(reason() == 'hub', 'a choice with V at tier 3 or above is a conversation'); playerSample.tier = 1
  playerSample.dialogue = true; assert(reason() == 'hub', 'a choice while V is in a dialogue'); playerSample.dialogue = false
  playerSample.call = true; assert(reason() == 'hub', 'a choice during a phone call'); playerSample.call = false
  playerSample.choices = false
  do
    local f = W.read(npc, 'V', function() return {available = true, dialogue = false, choices = true, call = false, tier = 3, combat = false} end)
    assert(f.hub == true and f.hubWhy == 'dialogue=false choices=true call=false tier=3', tostring(f.hubWhy))
  end
  playerSample.dialogue = true; assert(reason() == 'hub'); playerSample.dialogue = false
  playerSample.call = true; assert(reason() == 'hub', 'a phone call'); playerSample.call = false
  playerSample.tier = 2; assert(reason() == nil, 'V walking freely in a staged area (tier 2) is not a scene of her own'); playerSample.tier = 1
  playerSample.tier = 3; assert(reason() == 'hub', 'V in a scene of her own (scene tier 3 or above)'); playerSample.tier = 1
  playerSample.combat = true; assert(reason() == 'combat'); playerSample.combat = false
  playerSample.available = false; assert(reason() == 'unreadable', 'no player sample: refuse'); playerSample.available = true
  -- A native that is missing or throws leaves only its fact unread: the answer is a refusal, never a crash.
  NPCPuppet = nil
  assert(reason() == 'unreadable')
  assert(W.classify(W.read(nil, 'V', nil)) == 'gone' or W.classify(W.read(nil, 'V', nil)) == 'unreadable')
`));

test('the service holds an answer for 0.4 s per character, forgets on reset and stays bounded', () => withModule(`
  ${fakeGame}
  local clock = 0
  local reads = 0
  local svc = W.new({clock = function() return clock end, sample = function() reads = reads + 1; return playerSample end})
  assert(svc:refusal(npc, 'V', '77') == nil and reads == 1)
  state.dialogue = true
  assert(svc:refusal(npc, 'V', '77') == nil and reads == 1, 'held: a poll that asks twice in a row costs one set of reads')
  clock = 0.3; assert(svc:refusal(npc, 'V', '77') == nil and reads == 1)
  clock = 0.5; assert(svc:refusal(npc, 'V', '77') == 'dialogue' and reads == 2, 'fresh after the hold')
  state.dialogue = false
  clock = 0.6; assert(svc:refusal(npc, 'V', '77') == 'dialogue' and reads == 2, 'the refusal is held too')
  -- No entity key: always read fresh (the talk key press).
  clock = 0.61; assert(svc:refusal(npc, 'V') == nil and reads == 3)
  clock = 0.62; assert(svc:refusal(npc, 'V') == nil and reads == 4)
  svc:reset(); assert(svc:refusal(npc, 'V', '77') == nil and reads == 5)
  -- A clock that goes backwards never serves a stale answer.
  clock = 0.1; assert(svc:refusal(npc, 'V', '77') == nil and reads == 6)
  -- Bounded.
  for i = 1, 100 do svc:refusal(npc, 'V', 'e' .. i) end
  local n = 0; for _ in pairs(svc.held) do n = n + 1 end
  assert(n <= W.LIMIT, 'held answers must stay bounded: ' .. n)
  assert(svc:refusal(nil, 'V', '9') == 'gone')
  -- A hub refusal keeps the player-side facts for the log line; any other answer clears them.
  playerSample.tier = 3
  assert(svc:refusal(npc, 'V') == 'hub' and svc.detail == 'dialogue=false choices=false call=false tier=3', tostring(svc.detail))
  playerSample.tier = 1
  assert(svc:refusal(npc, 'V') == nil and svc.detail == nil)
`));

// ---------------------------------------------------------------------------------------------------------------------
// Johnny Silverhand, a projection of V's head (a player's "busy right now" with no quest running, Nexus 2026-10-21): the game's own
// scenes, workspots and mounts command his AI and seat him in V's car in ambient moments, so "driven" and "mounted" say nothing about
// a quest for him. The facts that do say it still refuse.

test('projection: Johnny is not refused for a scene-commanded AI or a ride, and everyone else still is', () => withModule(`
  local function facts(over)
    local f = {gone = false, hub = false, dialogue = false, driven = false, combat = false, hurt = false, mounted = false}
    for k, v in pairs(over or {}) do f[k] = v end
    return f
  end
  assert(W.PROJECTIONS['johnny-silverhand'] == true and W.PROJECTIONS['judy-alvarez'] == nil, 'only Johnny')
  assert(W.classify(facts({driven = true})) == 'driven' and W.classify(facts({mounted = true})) == 'vehicle', 'others: unchanged')
  assert(W.classify(facts({driven = true}), false) == 'driven')
  assert(W.classify(facts({driven = true, mounted = true}), true) == nil, 'Johnny in a scene-driven seat of V\\'s car')
  -- The game's own conversation, a fight, V's scene, an injury and a missing body still refuse him.
  assert(W.classify(facts({dialogue = true, driven = true}), true) == 'dialogue', 'Johnny in a scene dialogue (a line of the game\\'s)')
  assert(W.classify(facts({hub = true, driven = true, mounted = true}), true) == 'hub', 'V in a quest conversation, a call or tier 3 or above')
  assert(W.classify(facts({combat = true, driven = true}), true) == 'combat')
  assert(W.classify(facts({playerCombat = true}), true) == 'combat')
  assert(W.classify(facts({hurt = true}), true) == 'hurt')
  assert(W.classify(facts({gone = true}), true) == 'gone')
  -- Every fact still has to be readable except the two that are not asked for him.
  for _, name in ipairs({'gone', 'hub', 'dialogue', 'combat', 'hurt'}) do
    local partial = facts(); partial[name] = nil
    assert(W.classify(partial, true) == 'unreadable', name .. ' unread must refuse for Johnny too')
  end
  local partial = facts(); partial.driven = nil; partial.mounted = nil
  assert(W.classify(partial, true) == nil and W.classify(partial, false) == 'unreadable', 'two unread facts do not matter for him')
`));

test('projection: the service reads the same natives for Johnny, asks only the key press, and keeps every fact for the log line', () => withModule(`
  ${fakeGame}
  local clock = 0
  local svc = W.new({clock = function() return clock end, sample = function() return playerSample end})
  state.autonomous = false; state.mounted = true
  assert(svc:refusal(npc, 'V', nil, 'judy-alvarez') == 'driven', 'another story character in a scene')
  assert(svc.facts:find('driven=true', 1, true) and svc.facts:find('mounted=true', 1, true) and not svc.facts:find('projection', 1, true), svc.facts)
  assert(svc:refusal(npc, 'V', nil, nil) == 'driven', 'no key: the old rule')
  assert(svc:refusal(npc, 'V', nil, 'johnny-silverhand') == nil, 'Johnny: an ambient ride or a workspot is not a quest')
  assert(svc.facts == nil, 'an answer with no refusal keeps no text')
  -- The refusals that stay, with every fact in the log text (and nothing but plain facts in it).
  playerSample.tier = 3
  assert(svc:refusal(npc, 'V', nil, 'johnny-silverhand') == 'hub')
  assert(svc.facts == 'gone=false hub=true dialogue=false driven=true combat=false playerCombat=false hurt=false mounted=true projection=true', svc.facts)
  assert(svc.detail == 'dialogue=false choices=false call=false tier=3', svc.detail)
  playerSample.tier = 1
  state.dialogue = true
  assert(svc:refusal(npc, 'V', nil, 'johnny-silverhand') == 'dialogue' and svc.facts:find('dialogue=true', 1, true))
  state.dialogue = false
  state.combat = true
  assert(svc:refusal(npc, 'V', nil, 'johnny-silverhand') == 'combat'); state.combat = false
  -- A held answer (the recording poll, the reply guard) hands back its own facts, and a different key on the same entity is read afresh
  -- only after the hold: the key is the same character's for the whole conversation.
  clock = 10
  state.dialogue = true
  assert(svc:refusal(npc, 'V', '77', 'johnny-silverhand') == 'dialogue')
  local text = svc.facts
  svc.facts = nil
  clock = 10.2
  assert(svc:refusal(npc, 'V', '77', 'johnny-silverhand') == 'dialogue' and svc.facts == text, 'held: the same facts')
  -- No natives at all (the game gave nothing): still a refusal for him too.
  NPCPuppet = nil
  state.dialogue = false
  clock = 20
  assert(svc:refusal(npc, 'V', nil, 'johnny-silverhand') == 'unreadable' and svc.facts:find('combat=?', 1, true), svc.facts)
`));

test('describe: a refusal\'s facts are plain text, "?" for what was not read, and nothing is built for a missing table', () => withModule(`
  assert(W.describe(nil) == 'facts=none' and W.describe('x') == 'facts=none')
  assert(W.describe({gone = false, hub = true}) == 'gone=false hub=true dialogue=? driven=? combat=? playerCombat=? hurt=? mounted=?')
  assert(W.describe({}, true):find('projection=true$'))
`));

test('wiring: the log line of a refusal carries the facts, and Johnny\'s key reaches every place that asks', () => {
  const select = between('local function selectConversation(', 'local function voiceTargetValid');
  assert.match(select, /log\('World conversation refused: profile=' \.\. key \.\. ' reason=' \.\. why[\s\S]*?convaiWorldTalk\.facts[\s\S]*?convaiUnprofiledWhy\(npc\)/);
  assert.match(init, /convaiWorldTalk:refusal\(actor, Game\.GetPlayer\(\), story\.entity, story\.key, story\.idle\)/);
  assert.match(init, /log\('World conversation ended: profile=' \.\. story\.key[\s\S]*?convaiWorldTalk\.facts/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Who may be talked to: the catalog and the policy.

const world = `
  characterCatalog = (function() ${catalogSource} end)()
  local archetypes = characterCatalog.buildArchetypes(characterCatalog.ARCHETYPES)
  local profiles = {{key='judy-alvarez', name='Judy Alvarez', records={'Character.Judy'}},
    {key='jackie-welles', name='Jackie Welles', records={'Character.Jackie'}},
    {key='resident-female', name='Night City Resident Female'}}
  catalog = characterCatalog.build(profiles, archetypes)
  local function npc(hash, record, name, facts)
    local n = {hash = hash, record = record, name = name, facts = facts or {}}
    function n:GetEntityID() return {hash = self.hash} end
    function n:GetRecordID() return self.record end
    function n:GetTweakDBFullDisplayName() return self.name end
    function n:GetBodyType() return 'WomanAverage' end
    function n:IsCrowd() return self.facts.crowd == true end
    return n
  end
  worldJudy = npc('1', 'Character.Judy', 'Judy Alvarez')
  worldJackie = npc('2', 'Character.Jackie', 'Jackie Welles')
  questGoon = npc('3', 'Character.g1', 'Goon', {quest = 'SideQuest'})
  storyGoon = npc('4', 'Character.q101_goon', 'Goon', {recordName = 'Character.q101_goon', quest = 'None'})
  walker = npc('5', 'Character.walker', 'Pedestrian', {crowd = true})
  copy = npc('6', 'Character.Judy', 'Judy Alvarez')
  spawnedJudy = npc('7', 'Character.Judy', 'Judy Alvarez')
  namesake = npc('8', 'Character.vendor1', 'Judy Alvarez')
  ownedHashes = {['6'] = true}
  spawnedHashes = {['7'] = true}
  companions = {identity = function(n) if ownedHashes[n.hash] then return 'judy-alvarez', 'Judy Alvarez', true end return nil end,
    owns = function(n) return ownedHashes[n.hash] == true end}
  reads = 0
  function archetypeFacts(n) reads = reads + 1; return n.facts end
  convaiSpawnedCharacters = {is = function(_, n) return spawnedHashes[n.hash] == true end}
  storyOn, archetypesOn = true, true
  manager = {archetypeConversations = function() return archetypesOn end, storyConversations = function() return storyOn end}
  convaiWorldTalk = {}
`;

test('resolve: the story flag lets a roster record resolve for a world character and changes nothing else', () => run(`
  ${world}
  local function key(actor) return (characterCatalog.resolve(catalog, actor)) end
  assert(key({record = 'Character.Judy', name = 'Judy Alvarez', world = true}) == nil, 'before: a world Judy has no profile')
  assert(key({record = 'Character.Judy', name = 'Judy Alvarez', world = true, story = true}) == 'judy-alvarez')
  assert(key({record = 'Character.Judy', name = 'Judy Alvarez', world = true, story = false}) == nil)
  -- A story-bound world character with no roster profile talks as an ordinary person, story flag or not (2026-10-22), except one
  -- whose gender cannot be told.
  local facts = {quest = 'MainQuest', recordName = 'Character.q101_goon', human = true, gender = 'Female'}
  assert(key({record = 'Character.q101_goon', name = 'Goon', world = true, story = true, facts = facts, bodyType = 'WomanAverage'}) == 'resident-female')
  assert(key({record = 'Character.q101_goon', name = 'Goon', world = true, story = false, facts = facts, bodyType = 'WomanAverage'}) == 'resident-female')
  assert(key({record = 'Character.g1', name = 'Goon', world = true, story = true, facts = {quest = 'SideQuest'}}) == nil)
  -- The unchanged paths: a managed copy, a spawned Judy and an ordinary resident.
  assert(key({managedKey = 'judy-alvarez', name = 'Judy Alvarez'}) == 'judy-alvarez')
  assert(key({record = 'Character.Judy', name = 'Judy Alvarez', spawned = true}) == 'judy-alvarez')
  assert(key({record = 'Character.walker', name = 'Pedestrian', world = true, story = true, crowd = true, bodyType = 'WomanAverage'}) == 'resident-female')
`));

test('identity and policy: the game\'s own Judy and Jackie talk with the setting on; nothing else changes about them', () => run(`
  ${world}
  ${identitySource}
  ${policySource}
  local P = convaiWorldPolicy
  local function key(n) return (profileIdentity(n)) end
  -- Setting on (the default): the named characters resolve, the quest-bound and unnamed ones do not.
  assert(key(worldJudy) == 'judy-alvarez' and key(worldJackie) == 'jackie-welles')
  assert(key(questGoon) == 'resident-female' and key(storyGoon) == 'resident-female', 'no roster profile and story-bound: an ordinary person')
  assert(key(walker) == 'resident-female', 'ordinary NPCs unchanged')
  assert(key(copy) == 'judy-alvarez' and key(spawnedJudy) == 'judy-alvarez')
  assert(P.story(worldJudy) == true and P.story(worldJackie) == true, 'named game characters are story characters')
  assert(P.story(walker) == false, 'an ordinary NPC is not')
  assert(P.story(questGoon) == false and P.story(storyGoon) == false, 'an ordinary person, not a story character')
  assert(P.protected(questGoon) == true and P.protected(storyGoon) == true, 'but still protected from every other system')
  assert(P.story(copy) == false, 'our own copy keeps the full feature set, it is not a story character')
  assert(P.story(spawnedJudy) == false, 'another mod\\'s Judy keeps the spawned-character rules')
  assert(P.story(nil) == false)
  -- Still protected for every other system: no tactic target, no scanner name, no focus.
  assert(P.protected(worldJudy) == true and P.protected(worldJackie) == true)
  assert(P.ours(worldJudy) == false and P.spawned(worldJudy) == false)
  -- Setting off: exactly as before this feature.
  storyOn = false
  assert(key(worldJudy) == nil and key(worldJackie) == nil, 'off: no profile for the game\\'s own characters')
  assert(P.story(worldJudy) == false)
  assert(key(walker) == 'resident-female' and key(copy) == 'judy-alvarez', 'the other paths are unaffected')
  storyOn = true
  -- The module did not load: the feature is off whatever the setting says.
  convaiWorldTalk = nil
  assert(key(worldJudy) == nil and P.story(worldJudy) == false)
  convaiWorldTalk = {}
  -- An unreadable entity is never a story character by accident.
  local broken = {GetEntityID = function() error('gone') end}
  assert(P.story(broken) == false)
`));

test('a pedestrian the game binds to a quest (crowd body, quest flag or q-record) talks as a resident, and the log line says why', () => run(`
  ${world}
  ${identitySource}
  local function key(n) return (profileIdentity(n)) end
  -- Scene extras of a quest ("Customer" at a bar a quest owns) look like crowd people; the quest flag keeps them out of the residents
  -- (live 2026-10-20: three such "Customer"s beside V, unprofiled in every session, the same log line at every try).
  local minor = npc('21', 'Character.customer_a', 'Customer', {crowd = true, quest = 'MinorQuest', recordName = 'Character.customer_a', human = true})
  local record = npc('22', 'Character.q003_customer', 'Customer', {crowd = true, quest = 'NotQuest', recordName = 'Character.q003_customer', human = true})
  local plain = npc('23', 'Character.customer_b', 'Customer', {crowd = true, quest = 'NotQuest', recordName = 'Character.customer_b', human = true})
  assert(key(minor) == 'resident-female' and key(record) == 'resident-female', 'story-bound but unnamed: a resident, story setting on or not')
  assert(key(plain) == 'resident-female', 'the same person without the quest binding talks')
  local why = convaiUnprofiledWhy(minor)
  assert(why:find('classify=story-bound', 1, true) and why:find('protected=quest', 1, true) and why:find('crowd=true', 1, true)
    and why:find('quest=MinorQuest', 1, true) and why:find('record=Character.customer_a', 1, true), why)
  why = convaiUnprofiledWhy(record)
  assert(why:find('classify=story-bound', 1, true) and why:find('protected=story-record', 1, true), why)
  -- A person who is no crowd member at all is named as such, and an unreadable one gives an empty tail instead of an error.
  local seated = npc('24', 'Character.seated', 'Customer', {quest = 'NotQuest', recordName = 'Character.seated', human = true})
  assert(convaiUnprofiledWhy(seated):find('classify=unclassified protected=nil crowd=nil', 1, true), convaiUnprofiledWhy(seated))
  assert(convaiUnprofiledWhy({GetEntityID = function() error('gone') end}) == '')
  assert(convaiUnprofiledWhy(nil) == '')
`));
{
  const code = init.replace(/--.*$/gm, '');
  test('the talk key writes the reason with the unavailable line, from a global function (no new upvalue for the selector)', () => {
    assert.match(code, /log\('Conversation unavailable: profile=' \.\. tostring\(key\) \.\. \(key == nil and convaiUnprofiledWhy and convaiUnprofiledWhy\(npc\) or ''\)\)/);
    assert.match(code, /\nfunction convaiUnprofiledWhy\(npc\)/);
  });
}

test('beginFocus: a story character gets no look-at, no hold and no bark muting, even in a conversation V started', () => run(`
  ${world}
  ${identitySource}
  ${policySource}
  local calls = {}
  local player = {ConvaiBeginFocus = function(_, n) calls[#calls + 1] = 'focus:' .. n.hash; return true end}
  function endFocus() end
  convaiVanillaReactions = {focus = function(n) calls[#calls + 1] = 'quiet:' .. n.hash end}
  function log() end
  Game = {GetWorkspotSystem = function() return {IsActorInWorkspot = function() return false end} end}
  ${focusSource.replace('local function beginFocus', 'function beginFocus')}
  local ok, why = beginFocus(player, worldJudy)
  assert(ok == false and why:find('voice and face only', 1, true), tostring(why))
  assert(#calls == 0, 'no look-at, no bark muting: ' .. table.concat(calls, ','))
  -- An ordinary NPC in a conversation, our copy and a spawned character keep their usual focus.
  assert(beginFocus(player, walker) == true and calls[1] == 'focus:5')
  assert(beginFocus(player, copy) == true)
  assert(beginFocus(player, spawnedJudy) == true)
  -- With the setting off the game's Judy is refused as before (no profile).
  calls = {}; storyOn = false
  assert(beginFocus(player, worldJudy) == false and #calls == 0)
`));

test('the speech guard ends a story reply and says nothing for anyone else', () => run(`
  ${world}
  local clock, retired, logs, nextReason = 0, {}, {}, nil
  local refusals = 0
  convaiWorldTalk = {refusal = function(_, actor, player, entity) refusals = refusals + 1; return nextReason end}
  Game = {GetPlayer = function() return 'V' end}
  local speech = {}
  function log(text) logs[#logs + 1] = text end
  function retirePrivateReply(entity, why) retired[#retired + 1] = entity .. ':' .. why end
  convaiStory = nil
  ${guardSource}
  local guard = speech.storyGuard
  -- Not talking to a story character: false at once, nothing read.
  assert(guard({}, {entity = '77'}) == false and refusals == 0)
  convaiStory = {entity = '77', key = 'judy-alvarez', name = 'Judy Alvarez'}
  assert(guard({}, {entity = '88'}) == false and refusals == 0, 'another speaker')
  assert(guard({}, nil) == false)
  -- A story reply while nothing is wrong.
  assert(guard({}, {entity = '77'}) == false and refusals == 1 and #retired == 0)
  -- A scene begins while it plays: the reply is retired (voice, subtitle, face, bridge request).
  nextReason = 'dialogue'
  assert(guard({}, {entity = '77'}) == true)
  assert(retired[1] == '77:story-dialogue', retired[1])
  assert(logs[#logs]:find('World conversation ended', 1, true) and logs[#logs]:find('dialogue', 1, true))
  -- A reply about to start is dropped without retiring anything (the caller still holds the pending turn).
  retired = {}
  nextReason = 'combat'
  assert(guard({}, {entity = '77'}, true) == true and #retired == 0)
  assert(logs[#logs]:find('before the reply began', 1, true))
  convaiWorldTalk = nil
  assert(guard({}, {entity = '77'}) == false, 'without the module nothing is guarded')
`));

// ---------------------------------------------------------------------------------------------------------------------
// Wiring: what the source must do, and what it must never do.

test('wiring: refusal on the key press, private talk only, no gaze, the guard on the recording and the reply', () => {
  const select = between('local function selectConversation(', 'local function voiceTargetValid');
  assert.match(select, /convaiWorldPolicy\.story\(npc\) == true then\s+npc, reason = nil,/, 'a group key on a story character builds the round without it');
  assert.match(select, /primary\.story = convaiWorldPolicy ~= nil and convaiWorldPolicy\.story\(npc\) == true or nil/);
  assert.match(select, /convaiWorldTalk:refusal\(npc, player, nil, key\)/, 'a fresh read on the key press, with the profile key');
  assert.match(select, /convaiNotices\.send\(player, 'talk-busy', ui\.t\('\{name\} is busy right now\.'/);
  assert.match(select, /convaiFacialPlayback\.storyEntity = convaiStory and convaiStory\.entity or nil/);
  // No gaze: both talk paths skip the focus for a story character.
  assert.match(init, /not primary\.holocall and not primary\.story then\s+local focused, reason = beginFocus\(player, npc\)/);
  assert.match(init, /if not primary\.voiceOnly and not primary\.holocall and not primary\.story then beginFocus\(player, npc\) end/);
  assert.match(init, /if \(primary\.story or primary\.guarded\) and convaiWorldTalk:refusal\(npc, Game\.GetPlayer\(\), entity, primary\.profileKey, primary\.guarded\) then return false end/);
  // No actions: neither the typed nor the spoken path offers or even mentions follow, fight, drive or leave for a story character.
  assert.match(init, /if convaiStory and convaiStory\.entity == context\.entity then return false end\s+return gameplayActions\.capture\(context, context\.group and 'group-voice' or 'private-voice'\)/);
  assert.match(init, /elseif convaiStory and convaiStory\.entity == context\.entity and not context\.group then\s+-- A game-placed story character gets no action offers or advisories[^\r\n]*\s+elseif not context\.group and not context\.reaction then gameplayActions\.capture\(context, 'private-text'\)/);
  // The speech hooks.
  const speech = read('../mod/speech.lua');
  assert.match(speech, /local storyGuard = M\.storyGuard\s+if storyGuard and storyGuard\(M\.target, context, true\) == true then return false end/);
  assert.match(speech, /local storyGuard = M\.storyGuard\s+if storyGuard and storyGuard\(M\.actor, M\.context\) == true then return end/);
  // The face writer judges the story speaker without the broad scene flag, and only that one speaker.
  const facial = read('../mod/facial-playback.lua');
  assert.match(facial, /if entity~=nil and entity==M\.storyEntity then\s+local ok,ready=pcall\(luaActorSafe,actor,true\)/);
  assert.match(facial, /\(not sceneAllowed and scene:IsEntityInScene\(id\)\)/);
  assert.match(facial, /return service:SetStoryTalk\(enabled==true\)/);
  // Started where a session starts and ends, and the setting is handed over then.
  assert.match(init, /pcall\(dofile, 'world-talk\.lua'\)/);
  assert.match(init, /pcall\(convaiFacialPlayback\.applyStoryTalk, manager\.storyConversations\(\)\)/);
});

test('wiring: nothing of the story talk runs per frame, and a story character is never given another system', () => {
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onShutdown'"));
  assert.doesNotMatch(update, /convaiWorldTalk|convaiStory|storyConversations|world-talk/, 'onUpdate is untouched');
  // The module reads only on the key press, the validity poll and the reply guard; it has no update entry point.
  assert.doesNotMatch(moduleSource, /registerForEvent|onUpdate|function [A-Za-z.:]*update\b/);
  // Never touched: the module reads and decides, it writes nothing to the character.
  assert.doesNotMatch(moduleSource, /:Set[A-Z]\w*\(|:Apply\w*\(|:Play\w*\(|:Queue\w*\(|:Send\w*\(/, 'read-only module');
  // The policy keeps every other system out: tactic targets, scanner names and perception still ask protected().
  assert.match(init, /protected = function\(npc\) return convaiWorldPolicy ~= nil and convaiWorldPolicy\.protected\(npc\) == true end/);
  assert.match(read('../mod/npc-names.lua'), /if deps\.protected\(npc\) then return nil, 'protected' end/);
  // A story character is not a party entry or an adoption: no companion call mentions the story flag.
  for (const file of ['companions.lua', 'companion-adoption.lua', 'companion-marking.lua', 'companion-tactics.lua', 'group-chat.lua']) {
    assert.doesNotMatch(read(`../mod/${file}`), /convaiStory|convaiWorldTalk|world-talk|storyConversations|policy\.story/, file);
  }
});

test('the face service: named characters are prepared at spawn on any graph, guarded at talk time, never altered otherwise (Face.reds)', () => {
  const face = read('../r6/scripts/CyberpunkConvai/Face.reds');
  assert.match(face, /private let m_storyTalk: Bool;/);
  assert.match(face, /this\.m_storyTalk = false;/);
  assert.match(face, /public func SetStoryTalk\(on: Bool\) -> Bool \{\s+this\.m_storyTalk = on;\s+return this\.m_storyTalk;/);
  // At spawn: after the screen face (which needs its slot), before the crowd-graph return, and only for roster records.
  const spawn = between('private cb func OnWorldInitialize', 'private func PrepareStoryFace', face);
  assert.ok(spawn.indexOf('PrepareScreenFace(npc, face, index)') < spawn.indexOf('PrepareStoryFace(npc, face)'));
  assert.ok(spawn.indexOf('PrepareStoryFace(npc, face)') < spawn.indexOf('if index < 0 { return; };'));
  assert.match(spawn, /if this\.m_storyTalk && this\.m_crowdMode != 0 && this\.PrepareStoryFace\(npc, face\) \{ return; \};/);
  const story = between('private func PrepareStoryFace', 'public func SetStoryTalk', face);
  assert.match(story, /ArrayContains\(this\.m_named, record\)/, 'only the roster');
  assert.match(story, /this\.PrepareSpawnedFace\(face\)/, 'the same preparation as a spawned character: gated crowd copy or companion graph');
  assert.doesNotMatch(story, /ScheduleAppearanceChange|ResetFacial|SelectFacialEmotion|\.graph = /, 'no rebuild, no direct graph write here');
  // Talk time: a dialogue refuses (first check), then only a commanded AI; the quest flag and quest-named record do not.
  const refusal = between('public func TalkRefusal', 'private func PrepareSpawnedFace', face);
  assert.ok(refusal.indexOf('IsEntityInDialogue') < refusal.indexOf('m_storyTalk'));
  assert.match(refusal, /if this\.m_storyTalk && ArrayContains\(this\.m_named, npc\.GetRecordID\(\)\) \{\s+if !npc\.IsOnAutonomousAI\(\) \{ return "skipped:driven"; \};\s+return "";/);
  // Without the setting everything is as before: the named roster stays skipped.
  assert.match(face, /if named \{ return "skipped:named"; \};/);
});

test('shipping: the module ships and installs, the notice exists, the setting has its row and all locales', () => {
  for (const plan of ['../packaging/release-plan.json', '../scripts/development-files.json']) {
    assert.match(read(plan), /"source": "mod\/world-talk\.lua",\s+"target": "bin\/x64\/plugins\/cyber_engine_tweaks\/mods\/AiNpcCyberpunkMod\/world-talk\.lua"/, plan);
  }
  assert.match(read('../mod/notices.lua'), /\['talk-busy'\] = \{class = PLAYER, repeatS = 10\}/);
  assert.match(read('../mod/manager-ui.lua'), /setting\('storyConversations', 'Talk to story characters', 'bool', snapshot\.settings.storyConversations == true, false,/);
  const en = JSON.parse(read('../localization/en.json'));
  const text = JSON.stringify(en);
  for (const key of ['Talk to story characters', '{name} is busy right now.']) assert.ok(text.includes(JSON.stringify(key)), `en.json: ${key}`);
  const keys = ['Talk to story characters', '{name} is busy right now.'];
  for (const locale of ['cs', 'de', 'es', 'fr', 'hu', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'tr', 'uk', 'zh-cn', 'zh-tw']) {
    const source = read(`../mod/locales/${locale}.lua`);
    for (const key of keys) assert.ok(source.includes(`["${key}"] =`), `${locale}: ${key}`);
    assert.ok(source.includes('["The game’s own named characters, such as Judy, Jackie, Panam and Rogue,'), `${locale}: the setting's help text`);
  }
});

test('the docs, README and player README state the policy', () => {
  const docs = read('../docs/WORLD_CHARACTERS.md');
  for (const needle of ['Talk to story characters', 'convaiWorldPolicy.story', 'voice and face', 'never touched', 'IsEntityInScene']) {
    assert.ok(docs.includes(needle), `docs/WORLD_CHARACTERS.md: ${needle}`);
  }
  assert.match(read('../README.md'), /Talk to story characters/);
  assert.match(read('../packaging/PLAYER_README.md'), /story characters/i);
});

// ---------------------------------------------------------------------------------------------------------------------
// 2026-10-22: a quest-bound person with no roster profile (the Afterlife bouncer Emmerick, a receptionist) talks as an archetype. The
// game's own checks still apply while the game has them; standing at a workspot is not a scene.

test('classify idle: a commanded AI at a workspot is not a scene, and every other reason still refuses', () => withModule(`
  local function facts(over)
    local f = {gone = false, hub = false, dialogue = false, driven = false, combat = false, hurt = false, mounted = false}
    for k, v in pairs(over or {}) do f[k] = v end
    return f
  end
  -- The Emmerick facts of the 21 Oct log: no scene, no dialogue, standing at his post (workspot=true), the quest commands his AI.
  local emmerick = facts({driven = true, workspot = true})
  assert(W.classify(emmerick, false, true) == nil, 'idle at a workspot: not refused')
  assert(W.classify(emmerick) == 'driven', 'a named character keeps the old rule')
  assert(W.classify(facts({driven = true, workspot = false}), false, true) == 'driven', 'a commanded AI away from a workspot is a scene')
  assert(W.classify(facts({driven = true}), false, true) == 'driven', 'workspot unread: refuse')
  -- Everything that says the game has the floor still refuses an idle person.
  assert(W.classify(facts({driven = true, workspot = true, hub = true}), false, true) == 'hub', 'V in a quest conversation, a call or a scene')
  assert(W.classify(facts({driven = true, workspot = true, dialogue = true}), false, true) == 'dialogue')
  assert(W.classify(facts({workspot = true, combat = true}), false, true) == 'combat')
  assert(W.classify(facts({workspot = true, playerCombat = true}), false, true) == 'combat')
  assert(W.classify(facts({workspot = true, hurt = true}), false, true) == 'hurt')
  assert(W.classify(facts({workspot = true, mounted = true}), false, true) == 'vehicle')
`));

test('read: the workspot is asked only for an idle (quest-bound, unnamed) person, and describe lists it only when read', () => withModule(`
  ${fakeGame}
  local asked = 0
  Game.GetWorkspotSystem = function() return {IsActorInWorkspot = function() asked = asked + 1; return true end} end
  local plain = W.read(npc, 'V', function() return playerSample end)
  assert(asked == 0 and plain.workspot == nil, 'a story character: the workspot is not read')
  assert(not W.describe(plain):find('workspot', 1, true))
  local idle = W.read(npc, 'V', function() return playerSample end, true)
  assert(asked == 1 and idle.workspot == true)
  assert(W.describe(idle):find('workspot=true', 1, true))
  state.autonomous = false
  local service = W.new({sample = function() return playerSample end, clock = function() return 0 end})
  assert(service:refusal(npc, 'V', nil, 'npc-merc-male', true) == nil, 'the bouncer at his post: no refusal')
  assert(service:refusal(npc, 'V', nil, 'npc-merc-male') == 'driven')
  playerSample.tier = 3
  assert(service:refusal(npc, 'V', nil, 'npc-merc-male', true) == 'hub', 'V in a scene refuses an idle person too')
`));

test('wiring: a quest-bound person with no roster profile is guarded like a story character but keeps the ordinary behaviour', () => {
  const select = between('local function selectConversation(', 'local function voiceTargetValid');
  assert.match(select, /convaiWorldPolicy\.protected\(npc\) == true then\s+local why = convaiWorldTalk:refusal\(npc, player, nil, key, true\)/);
  assert.match(select, /primary\.guarded = true\s+convaiStory = \{entity = primary\.entity, key = key, name = name, idle = true\}/);
  assert.match(select, /\(quest-bound\)[\s\S]*?convaiNotices\.send\(player, 'talk-busy'/, 'the same busy notice and a log line');
  // The guarded person is not a story character: it is still faced toward V and still gets an archetype conversation.
  assert.doesNotMatch(select.slice(select.indexOf('primary.guarded = true')), /primary\.story = /);
  assert.match(init, /not primary\.holocall and not primary\.story then\s+local focused, reason = beginFocus\(player, npc\)/);
});

// ---------------------------------------------------------------------------------------------------------------------
// 2026-10-22 live test: every person V can target is talkable, and the few who are not are told in plain words.

test('profileIdentity + notice: the receptionist, WorkerMaleDE and Emmerick talk; Rogue with the story setting off is told so', () => run(`
  ${world}
  ${identitySource}
  ${policySource}
  ui = {t = function(text, values) return (text:gsub('{(%w+)}', function(name) return values and tostring(values[name]) or '' end)) end}
  local function key(n) return (profileIdentity(n)) end
  -- log: classify=story-bound protected=quest crowd=true quest=MainQuest record=Character.dlc6_dtn_receptionist
  local receptionist = npc('30', 'Character.dlc6_dtn_receptionist', 'Receptionist', {crowd = true, quest = 'MainQuest',
    recordName = 'Character.dlc6_dtn_receptionist', human = true, gender = 'Female'})
  assert(key(receptionist) == 'npc-corpo-resident-female', tostring(key(receptionist)))
  -- an earlier report: classify=unclassified record=Character.WorkerMaleDE
  local worker = npc('31', 'Character.WorkerMaleDE', 'Worker', {recordName = 'Character.WorkerMaleDE', human = true, gender = 'Male'})
  assert(key(worker) == 'npc-worker-resident-male', tostring(key(worker)))
  -- the Afterlife bouncer: affiliation AfterlifeMercs, talked to as npc-merc-male before and after
  local emmerick = npc('32', 'Character.Emmerick', 'Emmerick Bronson', {recordName = 'Character.Emmerick', human = true, gender = 'Male',
    affiliation = 'AfterlifeMercs'})
  assert(key(emmerick) == 'npc-merc-male', tostring(key(emmerick)))
  -- they are still protected from every other system, and none is a story character
  local P = convaiWorldPolicy
  assert(P.story(receptionist) == false and P.story(worker) == false and P.story(emmerick) == false)
  assert(P.protected(receptionist) == true, 'quest-bound: protected')
  assert(P.protected(worker) == false and P.protected(emmerick) == false, 'no quest flag: an ordinary person')
  -- Rogue (a roster character) with the setting off: no profile, and the notice says why and where to turn it on.
  catalog = characterCatalog.build({{key = 'rogue-amendiares', name = 'Rogue Amendiares', records = {'Character.Rogue'}}}, characterCatalog.buildArchetypes(characterCatalog.ARCHETYPES))
  local rogue = npc('33', 'Character.Rogue', 'Rogue Amendiares', {recordName = 'Character.Rogue', human = true, gender = 'Female', affiliation = 'AfterlifeMercs'})
  storyOn = false
  assert(key(rogue) == nil, 'story setting off: no profile')
  local told = convaiUnprofiledNotice(rogue, 'Rogue Amendiares')
  assert(told == 'Rogue Amendiares is a story character, and Talk to story characters is off. Turn it on in Esc > Mods > AI NPC Cyberpunk Mod.', tostring(told))
  storyOn = true
  assert(key(rogue) == 'rogue-amendiares', 'the setting on: her own profile')
  -- the other plain-word notices
  local kid = npc('34', 'Character.kid', 'Kid', {recordName = 'Character.kid', human = true, children = true, gender = 'Male'})
  assert(key(kid) == nil and convaiUnprofiledNotice(kid, 'Kid') == 'Kid is a child and cannot be talked to.')
  local bot = npc('35', 'Character.bot', 'Bot', {recordName = 'Character.bot', human = false, gender = 'Male'})
  assert(key(bot) == nil and convaiUnprofiledNotice(bot, 'Bot') == 'Bot is not a person and cannot be talked to.')
  local odd = npc('36', 'Character.odd', 'Odd', {recordName = 'Character.odd', human = true})
  odd.GetBodyType = function() return 'Mech' end
  assert(key(odd) == nil and convaiUnprofiledNotice(odd, 'Odd') == 'Odd cannot be talked to: the mod cannot tell which voice fits.')
  -- Talk to ordinary NPCs off: a person who is no crowd member is told which setting; a roster character is still told it is a story character.
  archetypesOn = false
  assert(key(worker) == nil, 'the setting off: facts are not read, a non-crowd person has no profile')
  assert(convaiUnprofiledNotice(worker, 'Worker') == 'Talk to ordinary NPCs is off. Turn it on in Esc > Mods > AI NPC Cyberpunk Mod.')
  storyOn = false
  assert(convaiUnprofiledNotice(rogue, 'Rogue Amendiares'):find('story character', 1, true))
  -- A person nothing explains keeps the old line (the caller's fallback), and an unreadable one gives nil instead of an error.
  storyOn, archetypesOn = true, true
  assert(convaiUnprofiledNotice({GetEntityID = function() error('gone') end}, 'x') == nil)
`));

{
  const code = init.replace(/--.*$/gm, '');
  test('the talk key tells why in words, from a global function, and keeps the old line for any other case', () => {
    assert.match(code, /local told = key == nil and convaiUnprofiledNotice and convaiUnprofiledNotice\(npc, name\) or nil\s+convaiNotices\.send\(player, 'talk-no-profile', told or ui\.t\('\{name\} does not have a conversation profile configured yet\.',\{name=name\}\)\)/);
    assert.match(code, /\nfunction convaiUnprofiledNotice\(npc, name\)/);
    // The three sentences the owner asked for, with the menu path.
    assert.match(init, /ui\.t\('\{name\} is a story character, and Talk to story characters is off\. Turn it on in Esc > Mods > AI NPC Cyberpunk Mod\.'/);
  });
}
