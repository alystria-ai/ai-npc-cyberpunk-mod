import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import fengari from 'fengari';
import {KnowledgeRouter} from './conversation-knowledge.mjs';
import {multilingualTwins} from './multilingual.mjs';
import {RelationshipRouting} from './relationship-routing.mjs';
import {TIER1_KEYS} from '../scripts/Create-MultilingualProfiles.mjs';

// Night City Allies followers Lucy and Rita Wheeler (docs/NCA_FOLLOWERS_PLAN.md). Recognition is roster data only: NCA
// spawns its followers through the shared dynamic entity system, so the generic spawned-character path
// (docs/SPAWNED_CHARACTERS.md) already finds them, and the roster's records and names give them their own profile.
// Nothing of ours names NCA in code, so a player without NCA gets two unused catalog rows and nothing else.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const roster = JSON.parse(read('../characters/roster.json'));
const catalogSource = read('../mod/character-catalog.lua');
const row = key => roster.find(entry => entry.key === key);

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}
const luaString = value => JSON.stringify(String(value)).replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => `\\u{${hex}}`);
const luaList = values => `{${(values || []).map(luaString).join(', ')}}`;
// The committed roster as character-catalog.lua sees it (mod/init.lua builds the catalog from the same fields).
const profilesLua = `{${roster.map(entry => `{key = ${luaString(entry.key)}, name = ${luaString(entry.name)}, `
  + `aliases = ${luaList(entry.aliases)}, records = ${luaList(entry.records)}}`).join(',\n')}}`;
const withCatalog = code => run(`
  local api = (function() ${catalogSource} end)()
  local catalog = api.build(${profilesLua}, api.buildArchetypes(api.ARCHETYPES))
  local function who(actor) return (api.resolve(catalog, actor)) end
  ${code}`);

const NCA_LUCY = ['Character.EdgerunnersLucy_Merc', 'NCA.Character.EdgerunnersLucy_Merc', 'Character.EdgerunnersLucy'];
const NCA_RITA = ['Character.lizzies_bouncer', 'NCA.Character.lizzies_bouncer'];

test('the roster has Lucy and Rita Wheeler with the base records, the NCA clone records and safe names', () => {
  const lucy = row('lucy-kushinada'), rita = row('rita-wheeler');
  assert.ok(lucy && rita, 'both rows are in characters/roster.json');
  for (const record of NCA_LUCY) assert.ok(lucy.records.includes(record), `Lucy record ${record}`);
  for (const record of NCA_RITA) assert.ok(rita.records.includes(record), `Rita record ${record}`);
  assert.equal(lucy.gender, 'FEMALE'); assert.equal(rita.gender, 'FEMALE');
  // 2026-10-25 (owner): our own Rita is invitable from the menus (two Ritas with NCA are accepted); Lucy's records come only from other mods.
  assert.notEqual(rita.invite, false, 'Rita is invitable');
  assert.equal(lucy.invite, false, 'Lucy stays talk only');
  // Other game characters are called Lucy (Lucy Thackery), so the bare first name never resolves to her.
  const names = [lucy.name, ...(lucy.aliases || [])].map(name => name.toLowerCase());
  assert.ok(!names.includes('lucy'), 'never the bare name Lucy');
  assert.ok(names.includes('lucyna kushinada'), 'the full display name of the custom character');
  assert.ok([rita.name, ...(rita.aliases || [])].includes('Rita Wheeler'));
  // No other row claims their records.
  for (const entry of roster) {
    if (entry.key === 'lucy-kushinada' || entry.key === 'rita-wheeler') continue;
    for (const record of [...NCA_LUCY, ...NCA_RITA]) assert.ok(!(entry.records || []).includes(record), `${entry.key} ${record}`);
  }
});

test('an NCA follower resolves to her own profile by record (base or NCA clone) and by full display name', () => withCatalog(`
  for _, record in ipairs(${luaList(NCA_LUCY)}) do
    assert(who({record = record, name = 'Lucy', spawned = true, world = false}) == 'lucy-kushinada', record)
  end
  for _, record in ipairs(${luaList(NCA_RITA)}) do
    assert(who({record = record, name = 'Mox', spawned = true, world = false}) == 'rita-wheeler', record)
  end
  -- A record this build does not know (a later NCA clone scheme) still matches by the full display name.
  assert(who({record = 'NCA.12345', name = 'Lucyna Kushinada', spawned = true, world = false}) == 'lucy-kushinada')
  assert(who({record = 'NCA.67890', name = 'Rita Wheeler', spawned = true, world = false}) == 'rita-wheeler')
  -- The bare first name is someone else.
  assert(who({record = 'Character.sts_wat_kab_02_lucy', name = 'Lucy', spawned = true, world = false}) ~= 'lucy-kushinada')
`));

test('the game-placed Rita at Lizzie\'s follows the story-character rule: her profile only when story talk is allowed', () => withCatalog(`
  assert(who({record = 'Character.lizzies_bouncer', name = 'Rita Wheeler', world = true}) == nil, 'story talk off')
  assert(who({record = 'Character.lizzies_bouncer', name = 'Rita Wheeler', world = true, story = true}) == 'rita-wheeler')
  -- Our own managed copies keep their managed key (we never spawn these two; the rule is unchanged).
  assert(who({managedKey = 'judy-alvarez', record = 'Character.lizzies_bouncer', name = 'Judy'}) == 'judy-alvarez')
`));

test('soft dependency: no code of ours names NCA or its tags; recognition is data only', () => {
  const files = [
    ...readdirSync(new URL('../mod/', import.meta.url)).filter(name => name.endsWith('.lua')).map(name => `../mod/${name}`),
    ...readdirSync(new URL('../r6/scripts/CyberpunkConvai/', import.meta.url)).filter(name => name.endsWith('.reds'))
      .map(name => `../r6/scripts/CyberpunkConvai/${name}`),
  ];
  for (const file of files) {
    if (file.endsWith('/diagnostics.lua')) continue;
    // FaceFeature.reds is generated from the roster (scripts/Build-FacialGraphs.mjs NamedRecords): data, not code that names NCA.
    const generated = file.endsWith('/FaceFeature.reds');
    const source = read(file);
    assert.doesNotMatch(source, /NightCityAllies|NCA_Companion|GetMod\(\s*['"]NightCityAllies/, file);
    if (!generated) assert.doesNotMatch(source, /EdgerunnersLucy|lizzies_bouncer/, `${file}: records belong in characters/roster.json`);
  }
});

// ---------------------------------------------------------------- riding in V's car (the companion context for a car ride)
const turnContextSource = read('../mod/turn-context.lua');
const init = read('../mod/init.lua');
const ridersStart = init.indexOf('    riders = function(player, radius)');
const ridersEnd = init.indexOf('\n    end,\n}', ridersStart);
const ridersSource = init.slice(ridersStart + '    riders = '.length, ridersEnd + '\n    end'.length);

test('turn context: a seat another mod gave a spawned character reads as passenger or driving', () => run(`
  local api = (function() ${turnContextSource} end)()
  assert(api.classify({mounted = {seat = 'seat_back_left'}}) == 'passenger')
  assert(api.classify({mounted = {seat = 'seat_front_right'}}) == 'passenger')
  assert(api.classify({mounted = {seat = 'seat_front_left'}}) == 'driving', 'NCA chauffeur: she drives V')
  assert(api.classify({mounted = {}}) == 'following', 'no seat name, no claim')
  -- Our own copy's transport state still wins.
  assert(api.classify({transport = {owned = true, phase = 'boarding'}, mounted = {seat = 'seat_back_left'}}) == 'boarding')
`));

const ridersHarness = body => run(`
  local reads = {recall = 0, mount = 0, identity = 0}
  local car = {GetEntityID = function() return {hash = 'car-1'} end}
  local player = {inCar = true, GetMountedVehicle = function(self) return self.inCar and car or nil end}
  local function npc(parent, seat, key, name) return {parent = parent, seat = seat, key = key, name = name} end
  local people = {}
  convaiSpawnedCharacters = {known = {}, recall = function(self, who, radius, present, accept)
    reads.recall = reads.recall + 1
    local rows = {}
    for _, person in ipairs(people) do if accept == nil or accept({key = person.key}) then rows[#rows + 1] = {npc = person} end end
    return rows
  end}
  Game = {GetMountingFacility = function() return {GetMountingInfoSingleWithObjects = function(_, who)
    reads.mount = reads.mount + 1
    if not who.parent then return nil end
    return {parentId = {hash = who.parent}, slotId = {id = who.seat}}
  end} end}
  NameToString = function(value) return value end
  local function profileIdentity(who) reads.identity = reads.identity + 1; return who.key, who.name end
  local supportedProfiles = {['lucy-kushinada'] = true, ['rita-wheeler'] = true, ['judy-alvarez'] = true}
  local manager = {profileEnabled = function(key) return key ~= 'judy-alvarez' end}
  local convaiSpawnedPeople = {named = function(key) return type(key) == 'string' and not key:match('^npc%-') end}
  convaiSpawnedPeople.riders = ${ridersSource}
  ${body}`);

test('riders: only spawned roster characters seated in V\'s own vehicle, with their seat; nothing read on foot or when none is known', () => ridersHarness(`
  -- Nobody remembered: not even V's vehicle is read.
  local rows = convaiSpawnedPeople.riders(player, 15)
  assert(#rows == 0 and reads.recall == 0 and next(convaiSpawnedPeople.seats) == nil)
  convaiSpawnedCharacters.known = {{entity = '1'}}
  people = {npc('car-1', 'seat_front_right', 'lucy-kushinada', 'Lucy Kushinada'),
    npc('car-1', 'seat_front_left', 'rita-wheeler', 'Rita Wheeler'),
    npc('car-2', 'seat_back_left', 'lucy-kushinada', 'Lucy Kushinada'),   -- another car: not with V
    npc(nil, nil, 'rita-wheeler', 'Rita Wheeler'),                           -- on foot
    npc('car-1', 'seat_back_left', 'judy-alvarez', 'Judy Alvarez'),          -- disabled profile
    npc('car-1', 'seat_back_right', 'npc-mox-female', 'Mox')}                -- a generic body: skipped before any read
  -- V on foot: nothing is recalled.
  player.inCar = false
  assert(#convaiSpawnedPeople.riders(player, 15) == 0 and reads.recall == 0)
  player.inCar = true
  rows = convaiSpawnedPeople.riders(player, 15)
  assert(#rows == 2, 'got ' .. #rows)
  assert(rows[1].profileKey == 'lucy-kushinada' and rows[1].spawned == true and rows[1].name == 'Lucy Kushinada')
  assert(rows[2].profileKey == 'rita-wheeler')
  assert(convaiSpawnedPeople.seats['lucy-kushinada'] == 'seat_front_right')
  assert(convaiSpawnedPeople.seats['rita-wheeler'] == 'seat_front_left')
  assert(convaiSpawnedPeople.seats['judy-alvarez'] == nil)
  assert(reads.recall == 1 and reads.mount == 5, 'one recall, one mount read per remembered roster body: ' .. reads.mount)
  -- A failing native read drops that one row, never the turn.
  Game = {GetMountingFacility = function() error('no facility') end}
  rows = convaiSpawnedPeople.riders(player, 15)
  assert(#rows == 0 and next(convaiSpawnedPeople.seats) == nil)
`));

test('wiring: riders feed the turn context party and activity only, never a per-frame path', () => {
  const party = init.slice(init.indexOf('        party = function(player, radius)'), init.indexOf('        wantVolume = function()'));
  assert.match(party, /pcall\(function\(\) return convaiSpawnedPeople\.riders\(player, radius\) end\)/);
  const activity = init.slice(init.indexOf('        activity = function()'), init.indexOf('microphone.captureTurnContext = function()'));
  assert.match(activity, /convaiSpawnedPeople\.seats/);
  assert.match(activity, /if info\.rows\[key\] == nil then info\.rows\[key\] = \{mounted = \{seat = seat\}\}/, 'our own copy keeps its state');
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"));
  assert.doesNotMatch(update.slice(0, update.indexOf('\nend)') + 5), /convaiSpawnedPeople\.(?:riders|seats)/);
  assert.equal(init.split('convaiSpawnedPeople.riders(').length - 1, 1, 'one caller: the turn context party callback');
});

// ---- Convai characters and routing on every provider (the user's decision D1, 2026-10-18) -------------------------------------

const KEYS = ['lucy-kushinada', 'rita-wheeler'];
const releaseIds = JSON.parse(read('../packaging/release-data/characters.json'));
const releaseTwins = JSON.parse(read('../packaging/release-data/multilingual-profiles.json'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('Convai characters: both have an original and a multilingual twin in the release data, distinct from every other character', () => {
  const voiceMap = JSON.parse(read('../characters/multilingual-voice-map.json'));
  const all = [...Object.values(releaseIds), ...Object.values(releaseTwins.characters).map(entry => entry.multilingualCharacterId)];
  for (const key of KEYS) {
    assert.match(releaseIds[key], UUID, key + ' original ID');
    const twin = releaseTwins.characters[key];
    assert.ok(twin, key + ' twin row');
    assert.equal(twin.originalCharacterId, releaseIds[key], key + ' twin points at its own original');
    assert.match(twin.multilingualCharacterId, UUID);
    assert.notEqual(twin.multilingualCharacterId, releaseIds[key]);
    assert.equal(twin.verified, true); assert.equal(twin.phase, 'verified');
    assert.equal(twin.name, row(key).name + ' Multilingual');
    assert.equal(twin.voiceType, voiceMap.assignments[key].voice, 'the twin carries the mapped voice');
    assert.deepEqual(twin.languageCodes, ['en-US']);
    assert.equal(all.filter(id => id === releaseIds[key]).length, 1, 'original ID is unique');
    assert.equal(all.filter(id => id === twin.multilingualCharacterId).length, 1, 'twin ID is unique');
  }
  // Until the language box is unticked in the Convai dashboard a twin is left out (and logged); it never breaks the plain profile.
  for (const key of KEYS) if (releaseTwins.characters[key].languageBoxOff !== true) {
    assert.ok(multilingualTwins(releaseTwins, {ordinaryIds: releaseIds}).skipped.includes(key));
  }
});

test('Convai characters: both are tier-1 (pre-open lane priority) and the release plan lists both local voices', () => {
  for (const key of KEYS) assert.ok(TIER1_KEYS.includes(key), key + ' in TIER1_KEYS');
  const auto = read('../mod/auto-connect.lua');
  for (const key of KEYS) assert.ok(auto.includes(`'${key}'`), key + ' in M.TIER1');
  const plan = JSON.parse(read('../packaging/release-plan.json'));
  assert.ok(plan.voice.localProfiles.includes('rita-wheeler'));
  assert.ok(plan.voice.localProfiles.includes('lucy-kushinada'), 'Lucy has a web-clip reference since 2026-10-18');
  assert.equal(plan.voice.registry.preparedLocalProfiles, plan.voice.localProfiles.length);
  assert.ok(JSON.parse(read('../characters/world-knowledge.json')).profileKeys.includes('rita-wheeler'));
});

test('routing: with their IDs both profiles pass the gate of every provider (Convai, Mistral and the local AI), and the plain route names the Convai ID', async () => {
  // Convai: the provider ID is the character ID (a twin only while the language box is off and the setting is on).
  const routing = new RelationshipRouting({ordinaryIds: releaseIds, multilingual: multilingualTwins(releaseTwins, {ordinaryIds: releaseIds}).twins});
  for (const key of KEYS) assert.equal(routing.providerIds[key], releaseIds[key]);
  // Mistral and the local AI: the bridge's only per-profile gates are the roster lookup and the ID check; after them a turn is
  // addressed by profile key and name alone (local memory is runtime/local-memory/player/<key>.json), so IDs are all that was missing.
  const bridge = read('../bridge/convai-bridge.mjs');
  assert.equal(bridge.split('!ids[profile.key]').length - 1, 2, 'the two turn gates are the only ID checks for a roster profile');
  const localTurn = bridge.slice(bridge.indexOf('function localTurn('), bridge.indexOf('let observed ='));
  assert.match(localTurn, /profileKey: input\.profileKey/);
  assert.doesNotMatch(localTurn, /(?:^|[^A-Za-z])ids(?:[^A-Za-z]|$)|characterId/, 'a local or Mistral turn needs no Convai ID');
  // The knowledge route (shared by all three providers) accepts both keys as a private audience and as a group member.
  const identity = {status: 'verified', authoritative: true, userId: 'u', campaignId: 'c', playthroughId: 'c', branchId: 'b',
    worldGeneration: 7, generation: 4, activationId: 'a', worldToken: '4:a:b'};
  const guard = {epoch: 1, userId: 'u', branchId: 'b', worldGeneration: 7, generation: 4, activationId: 'a', remoteGeneration: 1};
  const service = {saveIdentity: identity, guard: () => guard, isCurrent: () => true, async current() { return true; },
    configFor: () => null, async project() { return {knowledgeContext: '', saveIdentity: identity, guard, remoteConfig: null}; },
    ledger: {contextFor: ({characterKey, channel}) => ({status: 'unavailable', characterKey, channel})}};
  const router = new KnowledgeRouter({service, now: () => Date.now()});
  for (const key of KEYS) {
    const worldKnowledge = {version: 1, status: 'ready', gameVersion: '2.31', generation: 7, worldToken: identity.worldToken,
      capturedAt: new Date().toISOString(), identity: {status: 'unknown'}, audience: {channel: 'private', profileKeys: [key]}, facts: {}, journal: {}};
    const prepared = await router.prepare({requestId: '1-1-1ULL', generation: 1, entity: '1ULL', profileKey: key, name: row(key).name, text: 'Hi', worldKnowledge});
    assert.equal(prepared.route.profileKey, key); assert.deepEqual(prepared.route.audience, [key]);
    assert.ok(router.configFor(key, 'group:lucy-kushinada,rita-wheeler') !== undefined);
  }
});

// ---- The installed voice configs (skipped where the ignored runtime folder is absent) -----------------------------

const voiceConfigs = ['pocket-voices.autobest.json', 'local-voices.autobest-short.json', 'local-voices.autobest-long.json'];
const voicesInstalled = voiceConfigs.every(name => existsSync(new URL('../runtime/' + name, import.meta.url)));
test('installed voice configs: both followers are ready with a reference that matches its hash, within the length limits', {skip: !voicesInstalled && 'runtime voice configs absent'}, () => {
  for (const name of voiceConfigs) {
    const cfg = JSON.parse(readFileSync(new URL('../runtime/' + name, import.meta.url), 'utf8').replace(/^﻿/, ''));
    for (const key of KEYS) {
      const entry = cfg.voices[key];
      assert.equal(entry.status, 'ready', `${name}: ${key} is ready`);
      const file = new URL('../' + entry.reference, import.meta.url);
      assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), entry.sha256, `${name}: ${key} reference hash`);
      assert.equal(createHash('sha256').update(entry.transcript, 'utf8').digest('hex'), entry.transcriptSha256, `${name}: ${key} transcript hash`);
      const limit = name.includes('short') ? 10 : 18;   // omni-short at most 10 s, the long set and Pocket at most 18 s (Omni's hard limit is 20 s)
      assert.ok(entry.pick.seconds > 5 && entry.pick.seconds <= limit, `${name}: ${key} is ${entry.pick.seconds} s`);
    }
  }
});
