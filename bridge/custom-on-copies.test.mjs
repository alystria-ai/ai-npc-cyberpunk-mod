// A character the player made (docs/CHARACTER_EDITOR.md, "Matching") also applies to a copy of ours that is not a roster character: the Model browser's
// copy of a generic model (an archetype profile or none at all) and a resident. The real companions.lua, character-catalog.lua, custom-characters.lua and
// the real profileIdentity / convaiFacingCharacter of init.lua run here against strict fakes of the game's objects.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = name => readFileSync(new URL(`../mod/${name}`, import.meta.url), 'utf8');
const initSource = read('init.lua');
const slice = (from, to) => {
  const start = initSource.indexOf(from), end = initSource.indexOf(to, start);
  assert(start >= 0 && end > start, `init.lua no longer contains ${from}`);
  return initSource.slice(start, end);
};
const identityCode = slice('local function profileIdentity(npc, forceFacts)', '-- Why a talk target ended with no profile');
const facingCode = slice('function convaiFacingCharacter()', '-- Talking with nobody in view goes to the party');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = companionEngine + `
    local characterCatalog = (function() ${read('character-catalog.lua')} end)()
    local customApi = (function() ${read('custom-characters.lua')} end)()
    local archetypes = characterCatalog.buildArchetypes(characterCatalog.ARCHETYPES)
    local catalog = characterCatalog.build({
      {key = 'judy-alvarez', name = 'Judy Alvarez', aliases = {'Judy'}, records = {'Character.Judy'}},
      {key = 'resident-female', name = 'Night City Resident Female', kind = 'ambient'}}, archetypes)
    local manager = {archetypeConversations = function() return true end, storyConversations = function() return false end}
    local function archetypeFacts() return {} end
    local parties, enabled, clock, text = 0, true, 1000, nil
    companions.onPartyChanged = function() parties = parties + 1 end
    json = {encode = function() return '' end, null = {}, decode = function(raw) return raw end}
    local revision = 0
    local service = customApi.new({read = function() return 'revision ' .. revision end,
      decode = function() return text end,
      hash = function(record) return '<' .. record .. '>' end, prefixes = characterCatalog.CLONE_PREFIXES,
      enabled = function() return enabled end, clock = function() return clock end,
      onChange = function(self) catalog.custom = self.count > 0 and self or nil; convaiSettleCopyProfiles() end})
    ${identityCode}
    ${facingCode}
    local current
    function targetAtCrosshair() return current end
    function nameString(value) return value end
    TDBID = {ToStringDEBUG = function(id) return id end}
    -- A strict fake of a spawned puppet: it answers exactly what profileIdentity and the facing query ask, nothing else.
    local function puppet(npc, live, display, body)
      function npc:GetRecordID() return live end
      function npc:GetTweakDBFullDisplayName() return display end
      function npc:GetBodyType() return body or 'WomanAverage' end
      function npc:GetResolvedGenderName() return 'Female' end
      return npc
    end
    companions.registerDefinition('model:ganger', {id = 'Character.Rebecca_Model', name = 'Street Doc', profileKey = 'npc-maelstrom-female', profileName = 'Maelstrom ganger'})
    companions.registerDefinition('model:plain', {id = 'Character.Plain_Face', name = 'Plain Face'})
    companions.registerDefinition('model:resident', {id = 'Character.Resident_Model', name = 'Passer-by', profileKey = 'resident-female', profileName = 'Night City Resident Female'})
    local rebecca = {key = 'custom-rebecca-k3j9', name = 'Rebecca', gender = 'female', records = {'Character.Rebecca_Model'}, names = {}}
    -- Publishes a list as the service would read it; the fake decode hands the table over, a changing revision makes it a new text.
    local function publish(rows)
      revision = revision + 1
      text = {version = 1, revision = revision, characters = rows}
      service.refresh(true)
    end
  ` + code;
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
}

test('without any character made, a copy keeps its own profile and a copy with no profile has none (as before)', () => run(`
  local ganger = puppet(spawn('model:ganger'), 'CyberpunkConvai.NonCrowd_Rebecca_Model', 'Street Doc')
  local plain = puppet(spawn('model:plain'), 'Character.Plain_Face', 'Plain Face')
  local before = parties
  local key, name = profileIdentity(ganger)
  assert(key == 'npc-maelstrom-female' and name == 'Maelstrom ganger', tostring(key))
  assert(profileIdentity(plain) == nil)
  assert(parties == before, 'nothing was reassigned')
`));

test('a copy of a generic model becomes the character that matches its original record, and every reader sees the custom key and name', () => run(`
  local ganger = puppet(spawn('model:ganger'), 'CyberpunkConvai.NonCrowd_Rebecca_Model', 'Street Doc')
  local before = parties
  publish({rebecca})
  assert(catalog.custom == service, 'the catalogue knows the character')
  -- The editor change swept the copies: no talk key press was needed.
  local row = companions.list()[1]
  assert(row.profileKey == 'custom-rebecca-k3j9' and row.profileName == 'Rebecca', tostring(row.profileKey))
  assert(parties == before + 1, 'the party was told once')
  -- The talk turn: the live record is the private clone's, the match is by the original record the copy remembers.
  local key, name = profileIdentity(ganger)
  assert(key == 'custom-rebecca-k3j9' and name == 'Rebecca', tostring(key))
  assert(service.match({record = 'CyberpunkConvai.NonCrowd_Rebecca_Model', name = 'Street Doc'}) == nil, 'the clone record alone would not match')
  -- The connections the bridge is told about and the conversation candidates.
  assert(companions.connectionProfiles()[1] == 'custom-rebecca-k3j9')
  assert(companions.conversationCandidates(Game.GetPlayer(), 1000)[1].profileKey == 'custom-rebecca-k3j9')
  -- Asked again from the scan: the same answer, no second reassignment.
  profileIdentity(ganger); profileIdentity(ganger)
  assert(parties == before + 1)
`));

test('the talk path settles a copy the sweep has not reached yet, once', () => run(`
  local ganger = puppet(spawn('model:ganger'), 'CyberpunkConvai.NonCrowd_Rebecca_Model', 'Street Doc')
  publish({rebecca})
  -- The change already swept the copy; put it back to what it was made with, to stand in for a sweep that never reached it.
  assert(companions.setProfile(companions.list()[1].serial, 'npc-maelstrom-female', 'Maelstrom ganger'))
  local before = parties
  local key = profileIdentity(ganger)
  assert(key == 'custom-rebecca-k3j9' and companions.list()[1].profileKey == 'custom-rebecca-k3j9' and parties == before + 1)
  profileIdentity(ganger)
  assert(parties == before + 1)
`));

test('a copy with no profile at all, and a resident, are found by the model record or the display name; a roster copy keeps its roster profile', () => run(`
  local plain = puppet(spawn('model:plain'), 'Character.Plain_Face', 'Plain Face')
  local resident = puppet(spawn('model:resident'), 'Character.Resident_Model', 'Passer-by')
  local judy = puppet(spawn('judy-alvarez'), 'Character.Judy', 'Judy Alvarez')
  publish({
    {key = 'custom-face-aaaa', name = 'Face', gender = 'female', records = {}, names = {'plain  FACE'}},
    {key = 'custom-walker-bbbb', name = 'Walker', gender = 'female', records = {'Character.Resident_Model'}, names = {}},
    {key = 'custom-fake-cccc', name = 'Fake Judy', gender = 'female', records = {'Character.Judy'}, names = {'Judy Alvarez'}}})
  assert(profileIdentity(plain) == 'custom-face-aaaa', 'a model with no profile, by its name')
  local key, name = profileIdentity(resident)
  assert(key == 'custom-walker-bbbb' and name == 'Walker', 'a resident copy, by its record')
  local roster = profileIdentity(judy)
  assert(roster == 'judy-alvarez', 'a roster profile always wins: ' .. tostring(roster))
  local rows = {}
  for _, row in ipairs(companions.list()) do rows[row.key] = row end
  assert(rows['model:plain'].profileKey == 'custom-face-aaaa' and rows['model:resident'].profileKey == 'custom-walker-bbbb' and rows['judy-alvarez'].profileKey == 'judy-alvarez')
`));

test('deleting the character, or Convai answering, gives the copy its own profile back; a manual assignment ends the match', () => run(`
  local ganger = puppet(spawn('model:ganger'), 'CyberpunkConvai.NonCrowd_Rebecca_Model', 'Street Doc')
  local plain = puppet(spawn('model:plain'), 'Character.Plain_Face', 'Plain Face')
  publish({rebecca, {key = 'custom-face-aaaa', name = 'Face', gender = 'female', records = {}, names = {'Plain Face'}}})
  local function carried() local out = {}; for _, row in ipairs(companions.list()) do out[row.key] = row.profileKey end; return out end
  assert(carried()['model:ganger'] == 'custom-rebecca-k3j9' and carried()['model:plain'] == 'custom-face-aaaa')
  -- Convai answers: they are ordinary again (the base profile, or none).
  enabled = false; service.checkProvider(); convaiSettleCopyProfiles()
  assert(carried()['model:ganger'] == 'npc-maelstrom-female' and carried()['model:plain'] == nil, tostring(carried()['model:ganger']))
  assert(companions.list()[1].profileName == 'Maelstrom ganger')
  assert(profileIdentity(ganger) == 'npc-maelstrom-female' and profileIdentity(plain) == nil)
  enabled = true; service.checkProvider(); convaiSettleCopyProfiles()
  assert(carried()['model:ganger'] == 'custom-rebecca-k3j9' and carried()['model:plain'] == 'custom-face-aaaa')
  -- A character renamed keeps the copy, with the new name.
  publish({{key = 'custom-rebecca-k3j9', name = 'Becca', gender = 'female', records = {'Character.Rebecca_Model'}, names = {}}})
  local renamed
  for _, row in ipairs(companions.list()) do if row.key == 'model:ganger' then renamed = row end end
  assert(renamed.profileKey == 'custom-rebecca-k3j9' and renamed.profileName == 'Becca' and carried()['model:plain'] == nil)
  -- The player assigns a roster profile in the Companion Manager: the match is over for that copy.
  assert(companions.setProfile(renamed.serial, 'judy-alvarez', 'Judy Alvarez'))
  convaiSettleCopyProfiles()
  assert(carried()['model:ganger'] == 'judy-alvarez' and profileIdentity(ganger) == 'judy-alvarez')
  -- Deleted: nothing of the character is left on any copy.
  publish({})
  assert(catalog.custom == nil)
  assert(carried()['model:ganger'] == 'judy-alvarez' and carried()['model:plain'] == nil)
`));

test('a custom copy whose character is deleted returns to the profile it was made with', () => run(`
  local ganger = puppet(spawn('model:ganger'), 'CyberpunkConvai.NonCrowd_Rebecca_Model', 'Street Doc')
  publish({rebecca})
  assert(companions.list()[1].profileKey == 'custom-rebecca-k3j9')
  publish({})
  assert(companions.list()[1].profileKey == 'npc-maelstrom-female' and companions.list()[1].profileName == 'Maelstrom ganger')
  assert(companions.identity(ganger) == 'npc-maelstrom-female')
`));

test("Use the character I'm facing on a copy fills the model's own record, not the private clone's, and that record matches the copy", () => run(`
  local ganger = puppet(spawn('model:ganger'), 'CyberpunkConvai.NonCrowd_Rebecca_Model', 'Street Doc')
  current = ganger
  local facing = convaiFacingCharacter()
  assert(facing.record == 'Character.Rebecca_Model' and facing.name == 'Street Doc' and facing.gender == 'female', tostring(facing.record))
  -- The form saves that record: the copy is then that character (the whole round trip).
  publish({{key = 'custom-made-dddd', name = 'Made', gender = 'female', records = {facing.record}, names = {facing.name}}})
  assert(profileIdentity(ganger) == 'custom-made-dddd')
  -- A name the game does not give is the model's name.
  function ganger:GetTweakDBFullDisplayName() return '' end
  assert(convaiFacingCharacter().name == 'Street Doc')
  -- A person that is not ours is read as before: a clone of another mod's copy gives its original, a plain record itself.
  current = puppet({}, 'NCA.Character.Someone', 'Someone')
  assert(convaiFacingCharacter().record == 'Character.Someone')
  current = puppet({}, 'Character.Other', 'Other')
  assert(convaiFacingCharacter().record == 'Character.Other')
  current = nil
  assert(convaiFacingCharacter() == nil)
`));

test('the copy branch costs one comparison without a character, and the sweep runs on the list change and the talk key press only', () => {
  const code = initSource.replace(/--.*$/gm, '');
  const catalog = read('character-catalog.lua').replace(/--.*$/gm, '');
  assert.match(catalog, /local custom = \(not profile or profile\.kind == 'ambient'\) and catalog\.custom\s*if custom then/);
  // The definition, the list change and the talk key press.
  assert.equal(code.split('convaiSettleCopyProfiles()').length - 1, 3);
  assert.equal(code.split('function convaiSettleCopyProfiles').length - 1, 1);
});
