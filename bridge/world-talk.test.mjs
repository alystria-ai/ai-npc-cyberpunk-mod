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
  playerSample.choices = true; assert(reason() == 'hub', 'a quest conversation choice hub'); playerSample.choices = false
  playerSample.dialogue = true; assert(reason() == 'hub'); playerSample.dialogue = false
  playerSample.call = true; assert(reason() == 'hub', 'a phone call'); playerSample.call = false
  playerSample.tier = 3; assert(reason() == 'hub', 'V in a scene of her own (scene tier above 1)'); playerSample.tier = 1
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
`));

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
  -- A story-bound world character with no roster profile never falls back, story flag or not.
  local facts = {quest = 'MainQuest', recordName = 'Character.q101_goon', human = true, gender = 'Female'}
  assert(key({record = 'Character.q101_goon', name = 'Goon', world = true, story = true, facts = facts, bodyType = 'WomanAverage'}) == nil)
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
  assert(key(questGoon) == nil and key(storyGoon) == nil, 'no roster profile and story-bound: never a resident')
  assert(key(walker) == 'resident-female', 'ordinary NPCs unchanged')
  assert(key(copy) == 'judy-alvarez' and key(spawnedJudy) == 'judy-alvarez')
  assert(P.story(worldJudy) == true and P.story(worldJackie) == true, 'named game characters are story characters')
  assert(P.story(walker) == false, 'an ordinary NPC is not')
  assert(P.story(questGoon) == false and P.story(storyGoon) == false, 'no profile, so not talkable')
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
  assert.match(select, /convaiWorldTalk:refusal\(npc, player\)/, 'a fresh read on the key press');
  assert.match(select, /convaiNotices\.send\(player, 'talk-busy', ui\.t\('\{name\} is busy right now\.'/);
  assert.match(select, /convaiFacialPlayback\.storyEntity = convaiStory and convaiStory\.entity or nil/);
  // No gaze: both talk paths skip the focus for a story character.
  assert.match(init, /not primary\.holocall and not primary\.story then\s+local focused, reason = beginFocus\(player, npc\)/);
  assert.match(init, /if not primary\.voiceOnly and not primary\.holocall and not primary\.story then beginFocus\(player, npc\) end/);
  assert.match(init, /if primary\.story and convaiWorldTalk:refusal\(npc, Game\.GetPlayer\(\), entity\) then return false end/);
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
  const refusal = between('public func TalkRefusal', 'public static func QuestBound', face);
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
  assert.match(read('../mod/mcm.lua'), /setting\('storyConversations', 'Talk to story characters', 'bool', snapshot\.settings.storyConversations == true, false,/);
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
