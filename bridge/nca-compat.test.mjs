import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {namedRecords} from '../scripts/Build-FacialGraphs.mjs';

// Night City Allies (NCA) compatibility for every follower, not only Lucy and Rita (docs/NCA_FOLLOWERS_PLAN.md, section 10).
// NCA spawns a follower from a copy of the character's record named "NCA.<original record>" ("NCA.<number>" when the original has
// no debug name). The copy keeps every flat, so it is the same person: a clone record resolves exactly like its original, for
// every roster character, current and future, with no per-row data. NCA still owns follow, combat and driving; we add talk, voice,
// face and memory, as for any character another mod spawned (docs/SPAWNED_CHARACTERS.md).
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const roster = JSON.parse(read('../characters/roster.json'));
const catalogSource = read('../mod/character-catalog.lua');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}
const luaString = value => JSON.stringify(String(value)).replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => `\\u{${hex}}`);
const luaList = values => `{${(values || []).map(luaString).join(', ')}}`;
const profilesLua = `{${roster.map(entry => `{key = ${luaString(entry.key)}, name = ${luaString(entry.name)}, `
  + `aliases = ${luaList(entry.aliases)}, records = ${luaList(entry.records)}}`).join(',\n')}}`;
const withCatalog = code => run(`
  local api = (function() ${catalogSource} end)()
  local catalog = api.build(${profilesLua}, api.buildArchetypes(api.ARCHETYPES))
  local function who(actor) return (api.resolve(catalog, actor)) end
  ${code}`);

test('every roster record also resolves as an NCA clone of it, to the same profile', () => {
  const rows = roster.flatMap(entry => (entry.records || []).filter(record => /^Character\./.test(record)).map(record => [entry.key, record]));
  assert.ok(rows.length >= 80, `${rows.length} base records`);
  withCatalog(`
    local checked = 0
    for _, row in ipairs({${rows.map(([key, record]) => `{${luaString(key)}, ${luaString(record)}}`).join(', ')}}) do
      local key, record = row[1], row[2]
      assert(catalog.records[record] and catalog.records[record].key == key, 'base ' .. record)
      assert(catalog.records['NCA.' .. record] and catalog.records['NCA.' .. record].key == key, 'clone of ' .. record)
      -- As a spawned body (NCA spawns through the dynamic entity system), by record alone and with a name that means nothing.
      assert(who({record = 'NCA.' .. record, name = 'Somebody Else', spawned = true, world = false}) == key, 'resolve ' .. record)
      checked = checked + 1
    end
    assert(checked == ${rows.length})
  `);
});

test('the clone rule is generic: any later roster row works without listing a clone, and an explicit clone row keeps its own owner', () => run(`
  local api = (function() ${catalogSource} end)()
  assert(api.CLONE_PREFIXES[1] == 'NCA.')
  local catalog = api.build({
    {key = 'future-person', name = 'Future Person', records = {'Character.future_person'}},
    {key = 'lucy-kushinada', name = 'Lucy Kushinada', records = {'Character.EdgerunnersLucy_Merc', 'NCA.Character.EdgerunnersLucy_Merc'}},
    {key = 'other', name = 'Other', records = {'Character.other'}},
  })
  assert(catalog.records['NCA.Character.future_person'].key == 'future-person')
  assert(catalog.records['NCA.Character.EdgerunnersLucy_Merc'].key == 'lucy-kushinada')
  -- Never a clone of a clone, a clone of a non-character record, or a bare prefix.
  assert(catalog.records['NCA.NCA.Character.future_person'] == nil)
  assert(catalog.records['NCA.Character'] == nil and catalog.records['NCA.'] == nil)
  assert(api.resolve(catalog, {record = 'NCA.Character.future_person', name = 'x', spawned = true, world = false}) == 'future-person')
  -- A record this roster does not know stays unknown, with or without the prefix.
  assert(api.resolve(catalog, {record = 'NCA.Character.nobody', name = 'x', spawned = true, world = false}) == nil)
  -- A game-placed body keeps the story rule: the clone prefix never lifts it.
  assert(api.resolve(catalog, {record = 'Character.future_person', name = 'x', world = true}) == nil)
  assert(api.resolve(catalog, {record = 'NCA.Character.future_person', name = 'x', world = true, story = true}) == 'future-person')
`));

test('isCloneRecord: a record a record-cloning mod made, by its prefix, numbered copies included', () => run(`
  local api = (function() ${catalogSource} end)()
  assert(api.isCloneRecord('NCA.Character.lizzies_bouncer') == true and api.isCloneRecord('NCA.Character.Judy') == true)
  assert(api.isCloneRecord('NCA.123456789') == true, 'a numbered copy')
  assert(api.isCloneRecord('Character.lizzies_bouncer') == false and api.isCloneRecord('Character.Judy') == false, 'the game own records')
  assert(api.isCloneRecord('NCA.') == false and api.isCloneRecord('') == false and api.isCloneRecord(nil) == false and api.isCloneRecord(5) == false)
  assert(api.isCloneRecord('Other.Character.Judy') == false, 'only a known prefix')
`));

test('originalRecordName reads a clone as its original and refuses numbers and other families', () => run(`
  local api = (function() ${catalogSource} end)()
  assert(api.originalRecordName('Character.Judy') == 'Character.Judy')
  assert(api.originalRecordName('NCA.Character.Judy') == 'Character.Judy')
  assert(api.originalRecordName('NCA.Character.afterlife_merc_netrunner_w_medium') == 'Character.afterlife_merc_netrunner_w_medium')
  assert(api.originalRecordName('NCA.123456789') == nil, 'a numbered clone has no readable original')
  assert(api.originalRecordName('NCA.Item.Foo') == nil and api.originalRecordName('Item.Foo') == nil)
  assert(api.originalRecordName('Other.Character.Judy') == nil, 'only a known clone prefix')
  assert(api.originalRecordName(nil) == nil and api.originalRecordName('') == nil)
`));

// NCA's story companions (r6/scripts/NightCityAlliesModules/Characters/*.reds): the original records it clones.
const NCA_STORY = {
  'Character.Takemura': 'takemura', 'Character.Jackie': 'jackie-welles', 'Character.Judy': 'judy-alvarez', 'Character.Kerry': 'kerry-eurodyne',
  'Character.Misty': 'misty-olszewski', 'Character.Panam': 'panam-palmer', 'Character.Sobchak': 'river-ward', 'Character.Rogue': 'rogue-amendiares',
};
test('NCA story companions: the clone of each of their eight records resolves to the right profile', () => withCatalog(`
  for record, key in pairs({${Object.entries(NCA_STORY).map(([record, key]) => `[${luaString(record)}] = ${luaString(key)}`).join(', ')}}) do
    assert(who({record = 'NCA.' .. record, name = 'unreadable', spawned = true, world = false}) == key, record)
  end
`));

test('numbered NCA clones (no readable record) resolve by display name: full names only, the bare "Judy" is nobody', () => withCatalog(`
  local function numbered(name) return who({record = 'NCA.4294967296', name = name, spawned = true, world = false}) end
  assert(numbered('Judy Álvarez') == 'judy-alvarez')
  assert(numbered('Judy Alvarez') == 'judy-alvarez')
  assert(numbered('Panam Palmer') == 'panam-palmer')
  assert(numbered('Jackie Welles') == 'jackie-welles')
  assert(numbered('Kerry Eurodyne') == 'kerry-eurodyne')
  assert(numbered('Misty Olszewski') == 'misty-olszewski')
  assert(numbered('Rogue Amendiares') == 'rogue-amendiares')
  assert(numbered('River Ward') == 'river-ward')
  -- Bare first names that belong to other people or to nobody on the roster: never Judy, Jackie, Rogue or River.
  for _, name in ipairs({'Judy', 'Jackie', 'Rogue', 'River', 'Goro', 'Lucy', 'Rita', 'Judy Jones', 'Jackie Chan'}) do
    assert(numbered(name) == nil, name)
  end
`));

test('roster names a numbered clone can reach: no roster row answers to a bare "judy", "jackie", "rogue" or "river"', () => {
  const names = new Set(roster.flatMap(entry => [entry.name, ...(entry.aliases || [])]).map(name => name.toLowerCase()));
  for (const bare of ['judy', 'jackie', 'rogue', 'river', 'goro', 'lucy', 'rita']) assert.ok(!names.has(bare), bare);
});

test('NCA mercenaries and roamers are ordinary people: never a named character, a resident when no archetype knows them', () => withCatalog(`
  local function person(facts, extra)
    local actor = {record = 'NCA.7', name = 'Merc', spawned = true, world = false, bodyType = facts.bodyType, facts = facts}
    for name, value in pairs(extra or {}) do actor[name] = value end
    return api.resolve(catalog, actor)
  end
  -- A faction with an archetype takes it (by affiliation: a clone copies the record's flats, so the affiliation survives).
  assert(person({human = true, affiliation = 'AfterlifeMercs', bodyType = 'Man Average'}) == 'npc-merc-male')
  assert(person({human = true, affiliation = 'AfterlifeMercs', bodyType = 'Woman Average'}) == 'npc-merc-female')
  assert(person({human = true, affiliation = 'Maelstrom', bodyType = 'Man Big'}) == 'npc-maelstrom-male')
  -- The clone's debug name (read as the original record name) still lets a record token classify.
  assert(person({human = true, recordName = 'Character.afterlife_merc_netrunner_w_medium', bodyType = 'Woman Average'}) == 'npc-merc-female')
  -- A faction no archetype covers (and no record token) is a resident by body, not "no profile".
  assert(person({human = true, affiliation = 'SomeNewFaction', bodyType = 'Man Average'}) == 'resident-male')
  assert(person({human = true, bodyType = 'Woman Average'}) == 'resident-female')
  assert(person({human = true, gender = 'Female'}) == 'resident-female')
  -- A quest-record clone (NCA's "Sword Mox" is sq024_...) is a spawned copy of a model: its faction, else a resident.
  assert(person({human = true, quest = 'SideQuest', recordName = 'Character.sq024_pacifica_race_lizzie_female_racer', affiliation = 'TheMox',
    bodyType = 'Woman Average'}) == 'npc-mox-female')
  assert(person({human = true, quest = 'MainQuest', recordName = 'Character.q003_maelstrom_netrunner', bodyType = 'Man Average'}) == 'resident-male')
  -- Never a child, never a machine (a Wyvern drone), never a body with no gender.
  assert(person({human = true, children = true, bodyType = 'Man Average'}) == nil)
  assert(person({human = false, bodyType = 'Man Average'}) == nil)
  assert(person({human = true}) == nil)
  -- A named character wins before any of this: NCA's Judy is Judy even with a mercenary-looking affiliation.
  assert(person({human = true, affiliation = 'AfterlifeMercs', bodyType = 'Woman Average'}, {record = 'NCA.Character.Judy', name = 'Merc'}) == 'judy-alvarez')
  -- A game-placed unclassified person also falls back since 2026-10-22 (every NPC V can target is talkable): a resident by body.
  assert(person({human = true, bodyType = 'Man Average'}, {spawned = false, world = true}) == 'resident-male')
  assert(person({human = true, children = true, bodyType = 'Man Average'}, {spawned = false, world = true}) == nil)
`));

test('none of NCA\'s merc, roamer or location records is a roster record, except the named characters it also offers', () => {
  // The record list is NCA 1.6.9's Mercs, Characters and Locations modules (extracted to a temp folder for this check, never run).
  const mercs = ['Character.Brick', 'Character.Royce', 'Character.Totentanz_Bouncer', 'Character.afterlife_merc_netrunner_w_medium',
    'Character.the_mox_1_ranged1_lexington_wa', 'Character.sq024_pacifica_race_lizzie_female_racer', 'Character.tyger_claws_biker1_melee1_baseball_wa',
    'Character.nid_maelstrom_drone_wyvern_easy', 'Character.arr_valentinos_grunt1_ranged1_nova_ma', 'Character.sts_wat_nid_01_lizzie'];
  const records = new Set(roster.flatMap(entry => entry.records || []));
  // Character.Royce became a named roster character with the 2026-10-18 cast expansion and Character.Brick with the 2026-10-19 one:
  // NCA's Royce and Brick are those characters and talk as them (a record NCA.<X> resolves as <X>). Every other record of the list
  // is still no roster record.
  const named = new Set(['Character.Royce', 'Character.Brick']);
  for (const record of mercs) {
    if (named.has(record)) assert.ok(records.has(record), record + ' is the named roster character');
    else assert.ok(!records.has(record) && !records.has('NCA.' + record), record);
  }
});

// ---------------------------------------------------------------- face and memory, wiring
const faceSource = read('../r6/scripts/CyberpunkConvai/Face.reds');
const init = read('../mod/init.lua');

test('face: a spawned clone is prepared from its live graph, never from a record list, so no record needs to name its clone', () => {
  const start = faceSource.indexOf('private cb func OnWorldInitialize');
  const body = faceSource.slice(start, faceSource.indexOf('private func PrepareStoryFace'));
  const managed = body.indexOf('if dynamic.IsManaged(npc.GetEntityID()) {');
  assert.ok(managed > 0);
  // The managed (spawned elsewhere) branch returns before any use of the named-record list.
  assert.ok(managed < body.indexOf('ArrayContains(this.m_named'), 'the managed branch comes before the roster list');
  const branch = body.slice(managed, body.indexOf('let face = npc.FindComponentByName', managed));
  assert.match(branch, /this\.PrepareSpawnedFace\(spawnedFace\)/);
  assert.doesNotMatch(branch, /m_named|GetRecordID/);
  const prepare = faceSource.slice(faceSource.indexOf('private func PrepareSpawnedFace'), faceSource.indexOf('public static func SpawnedElsewhere'));
  assert.doesNotMatch(prepare, /m_named|GetRecordID|TDBID/, 'the spawned face is chosen by the graph path alone');
  // TalkRefusal's spawned branch looks at the quest flag only.
  const refusal = faceSource.slice(faceSource.indexOf('public func TalkRefusal'), faceSource.indexOf('private func PrepareSpawnedFace'));
  assert.match(refusal, /if spawned \{\s*if npc\.IsQuest\(\) \{ return "skipped:quest"; \};\s*return "";\s*\};/);
});

test('face: the generated named-record list is the game-placed roster; it is not extended with clones', () => {
  const generated = [...read('../r6/scripts/CyberpunkConvai/FaceFeature.reds').match(/NamedRecords\(\) -> array<String> \{\s*return \[([^\]]*)\]/)[1]
    .matchAll(/"([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(generated, namedRecords());
  // Only Lucy's and Rita's explicit NCA rows are in it (data already shipped); the rest is original records.
  assert.deepEqual(generated.filter(record => record.startsWith('NCA.')).sort(),
    roster.flatMap(entry => entry.records || []).filter(record => record.startsWith('NCA.')).sort());
});

test('memory and voice follow the profile key, so a clone shares them with the original character and with our copy', () => {
  // The conversation, memory and voice choice are addressed by the resolved profile key alone (init.lua profileIdentity ->
  // convai-bridge turn). No entity, record or spawner name is part of a memory key.
  // (A copy of ours may carry the player's character it resolved to, settleProfile: still the resolved key and nothing else.)
  assert.match(init, /local key, canonical, archetype = characterCatalog\.resolve\(catalog, actor\)(?:\s*--[^\n]*)*\s*if owned and ready and serial and key ~= carried then pcall\(companions\.settleProfile, serial, key, canonical\) end\s*return key, canonical, body, archetype/);
  assert.match(init, /return characterCatalog\.originalRecordName\(TDBID\.ToStringDEBUG\(recordId\)\)/);
});

test('no refusal for NCA followers: the "busy" gate belongs to game-placed story characters only', () => {
  // story = a game-placed named character. A spawned one (NCA) is excluded in the identity, the policy and the talk start.
  assert.match(init, /local story = managedKey == nil and not spawned and convaiWorldTalk ~= nil/);
  const policyStart = init.indexOf('    story = function(npc)');
  const policy = init.slice(policyStart, init.indexOf('    protected = function(npc)', policyStart));
  assert.match(policy, /if convaiSpawnedCharacters ~= nil and convaiSpawnedCharacters:is\(npc\) then return false end/);
  assert.match(init, /if primary\.story then\s*local why = convaiWorldTalk:refusal\(npc, player, nil, key, nil, mission\)/);
  assert.match(init, /if \(primary\.story or primary\.guarded\) and convaiWorldTalk:refusal\(npc, convaiPlayer()\(\), entity, primary\.profileKey, primary\.guarded, primary\.story and convaiStory ~= nil and convaiStory\.mission or nil\) then return false end/);
  // The world-talk module itself reads facts only; it never commands anything.
  const worldTalk = read('../mod/world-talk.lua');
  assert.doesNotMatch(worldTalk, /SendCommand|AIMountCommand|AIHoldPositionCommand|QueueEvent|Teleport|Workspot\(\):Play|LookAt/);
});

test('talking to an NCA follower sends no command beyond eyes and head', () => {
  const engagement = read('../r6/scripts/CyberpunkConvai/Engagement.reds');
  const begin = engagement.slice(engagement.indexOf('public final func ConvaiBeginFocus'), engagement.indexOf('private final func ConvaiTurnCivilian'));
  // The hold and the turn sit behind !keepAI; the chest weight is zero for keepAI; the one event queued is the look-at.
  assert.match(begin, /if !keepAI && \(npc\.IsCrowd\(\) \|\| npc\.IsCharacterCivilian\(\)\) && !inWorkspot \{[\s\S]*?AIComponent\.SendCommand\(npc, hold\);[\s\S]*?ConvaiTurnCivilian\(npc\);\s*\};/);
  assert.match(begin, /part\.weight = \(keepAI \|\| npc\.IsPlayerCompanion\(\)\) \? 0\.0/);
  assert.equal(begin.split('SendCommand(').length - 1, 1, 'the only command in the focus start is the guarded hold');
  assert.equal(begin.split('QueueEvent(').length - 1, 1, 'the only event is the look-at');
  // The caller passes keepAI for any character another mod spawned.
  assert.match(init, /local keepAI = policy ~= nil and policy\.spawned\(npc\) == true/);
  assert.match(init, /if keepAI then return player:ConvaiBeginFocus\(npc, true\) end/);
});

test('soft dependency: the clone rule is data in the catalog; no code names NCA\'s mod, tag or namespace', () => {
  assert.doesNotMatch(catalogSource, /NightCityAllies|NCA_Companion|GetMod\(/);
  assert.doesNotMatch(init, /NightCityAllies|NCA_Companion|GetMod\(\s*['"]NightCityAllies/);
  // The only mention is the clone prefix constant, one line.
  assert.equal(catalogSource.split('\n').filter(line => /NCA\./.test(line) && !/^\s*--/.test(line)).length, 1);
});
