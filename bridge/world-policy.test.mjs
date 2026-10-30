import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// The mod never touches game-placed characters except the talk path for ordinary NPCs (docs/WORLD_COMPANIONS.md):
// the central predicate (convaiWorldPolicy in mod/init.lua) and the gates built on it.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
const catalogSource = readFileSync(new URL('../mod/character-catalog.lua', import.meta.url), 'utf8');
const between = (from, to) => {
  const start = init.indexOf(from), end = init.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return init.slice(start, end);
};
const policySource = between('local protectedCache, protectedCount', '-- Recent game dialogue');
const gazeSource = between('local function updateGaze(player, elapsed)', '-- One probe-log line per talk-key target decision');
const focusSource = between('local function beginFocus(player, npc)', 'local function gameplayCanAcquire');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

// A world with: the vanilla Judy, a quest-flagged ganger, a plain ganger, a pedestrian, and our spawned copy of Judy.
const world = `
  characterCatalog = (function() ${catalogSource} end)()
  local archetypes = characterCatalog.buildArchetypes(characterCatalog.ARCHETYPES)
  local profiles = {{key='judy-alvarez', name='Judy Alvarez', records={'Character.judy'}},
    {key='resident-female', name='Night City Resident Female'}}
  catalog = characterCatalog.build(profiles, archetypes)
  local function npc(hash, record, name, facts)
    local n = {hash = hash, record = record, name = name, facts = facts or {}}
    function n:GetEntityID() return {hash = self.hash} end
    function n:GetRecordID() return self.record end
    function n:GetTweakDBFullDisplayName() return self.name end
    function n:GetBodyType() return 'WomanAverage' end
    return n
  end
  vanillaJudy = npc('1', 'Character.judy', 'Judy Alvarez')
  questGoon = npc('2', 'Character.g1', 'Goon', {quest = 'SideQuest'})
  storyRecordGoon = npc('3', 'Character.g2', 'Goon', {recordName = 'Character.q101_goon'})
  goon = npc('4', 'Character.g3', 'Goon', {quest = 'None', recordName = 'Character.gang_maelstrom_01'})
  walker = npc('5', 'Character.walker', 'Pedestrian', {})
  copy = npc('6', 'Character.judy', 'Judy Alvarez')
  ownedHashes = {['6'] = true}
  reads = 0
  companions = {identity = function(n) if ownedHashes[n.hash] then return 'judy-alvarez', 'Judy Alvarez', true end return nil end,
    owns = function(n) return ownedHashes[n.hash] == true end}
  function archetypeFacts(n) reads = reads + 1; return n.facts end
`;

test('the central predicate: game-placed named and quest characters are protected, ordinary NPCs and our copies are not', () => run(`
  ${world}
  ${policySource}
  local P = convaiWorldPolicy
  assert(P.protected(vanillaJudy) == true, 'the real Judy')
  assert(P.protected(questGoon) == true, 'a quest-flagged ganger')
  assert(P.protected(storyRecordGoon) == true, 'a q### record')
  assert(P.protected(goon) == false and P.protected(walker) == false, 'ordinary NPCs are not protected')
  assert(P.protected(copy) == false, 'our spawned copy of Judy has the Judy record but is ours')
  assert(P.ours(copy) == true and P.ours(vanillaJudy) == false and P.ours(walker) == false)
  assert(P.protected(nil) == false)
  local before = reads
  for _ = 1, 5 do P.protected(vanillaJudy); P.protected(walker) end
  assert(reads == before, 'cached per entity, no repeated native reads')
  local broken = {GetEntityID = function() error('gone') end}
  assert(P.protected(broken) == false, 'an unreadable entity is not marked protected by accident')
`));

test('beginFocus: only our copies and a character the talk path resolved are turned toward V', () => run(`
  ${world}
  local focused = {}
  local player = {ConvaiBeginFocus = function(_, n) focused[#focused + 1] = n.hash; return true end}
  function endFocus() end
  convaiVanillaReactions = {focus = function(n) focused[#focused + 1] = 'quiet:' .. n.hash end}
  -- profileIdentity stub: the real Judy and the quest goons get no profile; the pedestrian talks.
  local talkable = {['5'] = 'resident-female', ['4'] = 'npc-maelstrom-male'}
  function profileIdentity(n) return talkable[n.hash] end
  function log() end
  ${focusSource.replace('local function beginFocus', 'function beginFocus')}
  assert(beginFocus(player, vanillaJudy) == false, 'the real Judy is never focused')
  assert(beginFocus(player, questGoon) == false and beginFocus(player, storyRecordGoon) == false)
  assert(#focused == 0, 'no look-at, no bark muting for them: ' .. table.concat(focused, ','))
  assert(beginFocus(player, walker) == true, 'an ordinary NPC in a conversation the player started')
  assert(focused[1] == 'quiet:5' or focused[2] == 'quiet:5', 'its barks are muted for the conversation')
  focused = {}
  assert(beginFocus(player, copy) == true and focused[1] == 'quiet:6', 'our copy keeps bark muting')
`));

test('passive gaze: V merely looking at an ordinary NPC does not turn it; our companions still respond', () => run(`
  ${world}
  convaiAttentionProbe = nil
  local focusMode, focusEntity = nil, nil
  local gazeState = {candidate = nil, dwell = 0, lost = 0, poll = 0}
  local tactics = {busy = function() return false end}
  local looked
  local function gameplayCanAcquire() return true end
  local function targetAtCrosshair() return looked end
  local function resetGaze() gazeState.candidate, gazeState.dwell, gazeState.lost = nil, 0, 0 end
  local supportedProfiles = {['resident-female'] = true, ['judy-alvarez'] = true}
  local manager = {profileEnabled = function(k) return k ~= nil end}
  local function profileIdentity(n) return ({['5'] = 'resident-female', ['6'] = 'judy-alvarez'})[n.hash], n.name end
  local seen = {}
  local autoConnect = {look = function(k) seen[#seen + 1] = tostring(k) end}
  local begun = {}
  local function beginFocus(_, n) begun[#begun + 1] = n.hash; return true end
  local function endFocus() end
  local function log() end
  local player = {}
  ${gazeSource}
  looked = walker
  for _ = 1, 6 do updateGaze(player, 0.25) end
  assert(#begun == 0, 'an ordinary pedestrian is not focused by a look')
  assert(seen[1] == 'resident-female', 'auto-connect still counts the look (no game-side effect)')
  looked = vanillaJudy
  for _ = 1, 6 do updateGaze(player, 0.25) end
  assert(#begun == 0, 'the real Judy is never focused')
  assert(seen[#seen] == 'nil', 'and never counted by auto-connect: she has no profile')
  looked = copy
  for _ = 1, 6 do updateGaze(player, 0.25) end
  assert(begun[1] == '6', 'our spawned companion responds to a look as before')
`));

test('gaze scan: at the 10 Hz tick the native query runs on the half-way tick and the measuring on the next, with the gathered list handed over', () => run(`
  ${world}
  convaiAttentionProbe = nil
  local focusMode, focusEntity = nil, nil
  local gazeState = {candidate = nil, dwell = 0, lost = 0, poll = 0}
  local canAcquire = true
  local function gameplayCanAcquire() return canAcquire end
  local gathers, measures, handed = 0, 0, {}
  local function gatherTargets() gathers = gathers + 1; return {tag = gathers} end
  local function targetAtCrosshair(gathered) measures = measures + 1; handed[#handed + 1] = gathered and gathered.tag or 'none'; return nil end
  local function resetGaze() gazeState.candidate, gazeState.dwell, gazeState.lost = nil, 0, 0 end
  local supportedProfiles, manager = {}, {profileEnabled = function() return false end}
  local function profileIdentity() return nil end
  local function beginFocus() return true end
  local function endFocus() end
  local function log() end
  local player = {}
  ${gazeSource}
  updateGaze(player, 0.1); assert(gathers == 1 and measures == 0, 'half way: gather only')
  updateGaze(player, 0.1); assert(gathers == 1 and measures == 1 and handed[1] == 1, 'the measuring tick used the gathered list')
  assert(convaiGazeGather == nil, 'the list is taken, not kept')
  -- Nothing to gather while the scan could not run (a menu, the composer).
  canAcquire = false
  updateGaze(player, 0.1); updateGaze(player, 0.1)
  assert(gathers == 1 and measures == 1, 'no query while V cannot acquire a target')
  canAcquire = true
  -- A list that went stale (a long hitch between the ticks) is dropped and the scan queries for itself.
  updateGaze(player, 0.1)
  convaiGazeGather.at = os.clock() - 1
  updateGaze(player, 0.1)
  assert(handed[#handed] == 'none', 'a stale list was used')
  -- A frame that already holds a whole period (a slow frame, a test) scans at once, as before.
  updateGaze(player, 0.25); assert(measures == 3 and handed[#handed] == 'none')
`));
