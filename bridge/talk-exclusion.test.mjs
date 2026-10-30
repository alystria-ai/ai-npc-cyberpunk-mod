import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {run, managerLua, modSource} from './startup-lua-fixture.mjs';

// Who is never a talk target, a nearby listener or a group member (docs/CHARACTER_EDITOR.md, "Switching someone off"): the game's puppets (a hidden
// character, one that drives a remote controlled toy, a record of the deny list) and the people the player switched off in the editor. The real
// mod/talk-exclusion.lua and mod/character-options.lua run in fengari with stand-ins for the game; the selection functions are cut out of mod/init.lua.
const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
const between = (from, to) => {
  const start = init.indexOf(from), end = init.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return init.slice(start, end);
};
const lua = code => run(`
  local exclusionApi = (function() ${modSource('talk-exclusion.lua')} end)()
  local optionsApi = (function() ${modSource('character-options.lua')} end)()
  -- A character: what the game would answer for each read. reads counts the natives asked.
  local reads = {record = 0, appearance = 0, parent = 0, meshes = 0}
  local function npc(id, spec)
    spec = spec or {}
    spec.id = id
    spec.record = spec.record == nil and 'Character.Citizen_Street' or spec.record
    spec.look = spec.look == nil and 'ma_default_01' or spec.look
    spec.meshes = spec.meshes == nil and {total = 40, meshes = 6, shown = 6} or spec.meshes
    return spec
  end
  local clock = 0
  local logs = {}
  local off = {}
  local function build(extra)
    local o = {
      id = function(n) return n.id end,
      record = function(n) reads.record = reads.record + 1; if n.recordFails then error('unreadable') end return n.record end,
      appearance = function(n) reads.appearance = reads.appearance + 1; return n.look end,
      parentRecord = function(n) reads.parent = reads.parent + 1; return n.parent end,
      meshes = function(n) reads.meshes = reads.meshes + 1; if n.meshesFail then error('unreadable') end return n.meshes end,
      offRecord = function(record) return off[record] == true end,
      clock = function() return clock end,
      log = function(line) logs[#logs + 1] = line end}
    for k, v in pairs(extra or {}) do o[k] = v end
    return exclusionApi.new(o)
  end
  ${code}
`, {locale: false});

test('an ordinary visible person is a talk target: nothing is excluded', () => lua(`
  local x = build()
  assert(x.reason(npc('1')) == nil and x.excluded(npc('2')) == false)
  assert(x.reason(nil) == nil, 'no character, no verdict')
  assert(#logs == 0, 'nothing is logged for a person who may be talked to')
`));

test('a hidden or invisible character is left out: an invisible look, no mesh at all, no mesh shown', () => lua(`
  local x = build()
  assert(x.reason(npc('a', {look = 'invisible'})) == 'hidden look')
  assert(x.reason(npc('b', {look = 'Hidden_Default'})) == 'hidden look')
  assert(x.reason(npc('c', {look = 'ma_no_mesh_01'})) == 'hidden look')
  assert(x.reason(npc('d', {meshes = {total = 12, meshes = 0, shown = 0}})) == 'no mesh', 'components but not one mesh: nothing is drawn')
  assert(x.reason(npc('e', {meshes = {total = 40, meshes = 6, shown = 0}})) == 'mesh not shown', 'every mesh switched off')
  -- A person with one shown mesh among switched-off ones (a hat, glasses) is visible.
  assert(x.reason(npc('f', {meshes = {total = 40, meshes = 6, shown = 1}})) == nil)
  -- Unreadable is never evidence: no component list, an empty list, a failed read, a look that cannot be read.
  assert(x.reason(npc('g', {meshes = false})) == nil, 'no answer')
  assert(x.reason(npc('h', {meshes = {total = 0, meshes = 0, shown = 0}})) == nil, 'an empty list says nothing')
  assert(x.reason(npc('i', {meshesFail = true})) == nil, 'a read that fails')
  assert(x.reason(npc('j', {look = false})) == nil and x.reason(npc('k', {recordFails = true})) == nil)
`));

test('a character that rides or drives a toy vehicle is left out, one in an ordinary car is not', () => lua(`
  local x = build()
  assert(x.reason(npc('toy', {parent = {record = 'Vehicle.trauma_team_av_model_toy'}})) == 'toy vehicle', 'the toy AV of V\\'s flat')
  assert(x.reason(npc('drone', {parent = {record = 'Vehicle.mq001_little_bombus'}})) == 'toy vehicle', 'the toy drone')
  assert(x.reason(npc('word', {parent = {record = 'Vehicle.some_remote_control_car'}})) == 'toy vehicle', 'a remote controlled one by its name')
  assert(x.reason(npc('device', {parent = {record = nil, device = true}})) == 'attached to a device')
  assert(x.reason(npc('car', {parent = {record = 'Vehicle.v_sport2_quadra_type66', device = false}})) == nil, 'a passenger of an ordinary car')
  assert(x.reason(npc('free', {parent = nil})) == nil)
  assert(x.reason(npc('odd', {parent = {record = 'Vehicle.v_standard25_archer_hella'}})) == nil, 'a name with "toy" inside a longer word is not a toy')
  assert(x.reason(npc('toygun', {parent = {record = 'Vehicle.toygun_carrier'}})) == nil, 'toygun is one word')
`));

test('the deny list: a puppet record is left out whatever else is read', () => lua(`
  exclusionApi.PUPPET_RECORDS.some_puppet_01 = true
  local x = build()
  assert(x.reason(npc('p', {record = 'Character.Some_Puppet_01'})) == 'puppet record', 'case and the table prefix are ignored')
  assert(x.reason(npc('q', {record = 'Character.mws_toy_driver'})) == 'puppet record', 'a record made of the word toy')
  assert(x.reason(npc('r', {record = 'Character.Judy'})) == nil)
  assert(exclusionApi.TOY_VEHICLES.trauma_team_av_model_toy and exclusionApi.TOY_VEHICLES.mq001_little_bombus, 'the toy vehicles of the game data are listed')
  assert(exclusionApi.plain('Character.Mws_Wat_08_X') == 'mws_wat_08_x' and exclusionApi.plain('None') == nil and exclusionApi.plain(7) == nil)
`));

test('the signals are read once per character and kept for 30 seconds, so a scan costs nothing more', () => lua(`
  local x = build()
  local a = npc('a')
  for _ = 1, 50 do x.reason(a) end
  assert(reads.record == 1 and reads.appearance == 1 and reads.parent == 1 and reads.meshes == 1, 'one read of each for fifty asks')
  clock = 29
  x.reason(a); assert(reads.record == 1)
  clock = 31
  x.reason(a); assert(reads.record == 2 and reads.meshes == 2, 'read again after the cache time')
  -- A character that turns hidden (a quest hides it) is caught at the next read.
  a.look = 'invisible'
  assert(x.reason(a) == nil, 'cached until then')
  clock = 70
  assert(x.reason(a) == 'hidden look')
  -- The cache is bounded.
  for i = 1, 300 do x.reason(npc('n' .. i)) end
  local count = 0
  for _ in pairs(x.cache) do count = count + 1 end
  assert(count <= 96, 'bounded: ' .. count)
`));

test('a puppet is logged once, with its record, so the deny list can be extended', () => lua(`
  local x = build()
  local p = npc('hidden-1', {look = 'invisible', record = 'Character.Behnim_Akim'})
  for _ = 1, 10 do x.reason(p) end
  assert(#logs == 1, 'once, not per ask: ' .. #logs)
  assert(logs[1] == 'Talk exclusion: hidden look entity=hidden-1 record=behnim_akim', logs[1])
`));

test('people the player switched off are left out by their record, and come back when it is switched back on', () => lua(`
  local options = optionsApi.new({read = function() return 'x' end, decode = function() return {version = 1, characters = {}, records = {'Character.Wat_Lch_Ma_Citizen', 'wat_other_01', 7, 'bad name!', '../x'}} end})
  options.refresh()
  assert(options.offRecord('Character.wat_lch_ma_citizen') and options.offRecord('WAT_LCH_MA_CITIZEN') and options.offRecord('wat_other_01'), 'case and the table prefix do not matter')
  assert(not options.offRecord('Character.Judy') and not options.offRecord(nil) and not options.offRecord(7))
  assert(options.anyRecords() == true)
  local x = build({offRecord = options.offRecord})
  assert(x.reason(npc('a', {record = 'Character.Wat_Lch_Ma_Citizen'})) == 'switched off')
  assert(x.reason(npc('b', {record = 'Character.Judy'})) == nil)
  -- The list is consulted at every ask (it is a lookup): a record switched back on counts at once, though the signals stay cached.
  local a = npc('a', {record = 'Character.Wat_Lch_Ma_Citizen'})
  assert(x.reason(a) == 'switched off')
  local calls = reads.record
  options = optionsApi.new({read = function() return 'y' end, decode = function() return {version = 1, characters = {}} end}); options.refresh()
  x = build({offRecord = options.offRecord})
  assert(x.reason(a) == nil and options.anyRecords() == false)
`));

test('a character switched off by key: the options file carries off, and the manager says it is not enabled', () => {
  lua(`
    local options = optionsApi.new({read = function() return 'x' end, decode = function() return {version = 1, characters = {
      ['judy-alvarez'] = {off = true, talk = 'calm'}, ['panam-palmer'] = {off = false}, ['river-ward'] = {off = 'yes'}, ['rogue-amendiares'] = {sit = false}}} end})
    options.refresh()
    assert(options.off('judy-alvarez') == true)
    assert(options.get('judy-alvarez').talk == 'calm' and options.get('judy-alvarez').off == true, 'off sits beside the other choices')
    assert(options.off('panam-palmer') == false and options.get('panam-palmer') == nil, 'false is today\\'s behaviour: no row')
    assert(options.off('river-ward') == false and options.off('rogue-amendiares') == false and options.off('nobody') == false and options.off(nil) == false)
  `);
  run(`${managerLua}
    local manager = newManager()
    local player = newPlayer()
    manager.update(player, 0.1)
    assert(manager.profileEnabled('judy-alvarez') == true and manager.profileEnabled('panam-palmer') == true)
    local switched = {['judy-alvarez'] = true}
    manager.switchedOff = function(key) return switched[key] == true end
    assert(manager.profileEnabled('judy-alvarez') == false, 'switched off: never a talk target or listener')
    assert(manager.profileEnabled('panam-palmer') == true and manager.profileEnabled(nil) == false)
    switched['judy-alvarez'] = nil
    assert(manager.profileEnabled('judy-alvarez') == true, 'switched back on')
    manager.switchedOff = nil
    assert(manager.profileEnabled('judy-alvarez') == true, 'no hook, no change')
  `);
});

// ---- the selections, cut out of mod/init.lua -----------------------------------------------------------------------------------

const nearbySource = between('function convaiTalkNearbyPeople(', "-- The Johnny keys (docs/JOHNNY_IN_YOUR_HEAD.md)");
const targetSource = between('local function targetAtCrosshair(', 'local function resetGaze');
const exclusionBlock = between('-- True when this character is never a talk target or listener', '-- The entity id of an NPC as a string');

const selection = body => lua(`
  local lines = {}
  -- Every body the selections read: info[id] = {hash, distance, key, owned, ...}.
  local info = {}
  local function body(id, distance, spec)
    spec = spec or {}
    spec.distance = distance
    info[id] = spec
    local n = npc(id, spec)
    n.IsNPC = function() return true end; n.IsAttached = function() return true end; n.IsDeadNoStatPool = function() return false end
    n.GetEntityID = function(self) return {hash = self.id} end
    n.GetWorldPosition = function(self) return {x = info[self.id].distance, y = 0, z = 0} end
    n.GetAttitudeAgent = function() return {GetAttitudeTowards = function() return 'AIA_Friendly' end} end
    return n
  end
  Enum = {new = function(_, name) return name end}
  local player = {GetWorldPosition = function() return {x = 0, y = 0, z = 0} end, GetAttitudeAgent = function() return 'player' end,
    GetEntityID = function() return {hash = 'player'} end}
  supportedProfiles = {['npc-street-resident-female'] = true, ['npc-street-resident-male'] = true, ['judy-alvarez'] = true}
  archetypes = {keys = {['npc-street-resident-female'] = true, ['npc-street-resident-male'] = true}}
  characterCatalog = {describe = function(_, key) return {category = 'ordinary', base = key} end}
  manager = {profileEnabled = function() return true end}
  local switchedOff = {}
  companions = {owns = function(n) return info[n.id].owned == true end, visibleFromCrosshair = function() return true end}
  convaiWorldPolicy = {spawned = function() return false end, story = function() return false end, protected = function() return false end}
  convaiWorldTalk = {runtimeQuest = function() return false end, refusal = function() return nil end}
  function profileIdentity(n) return info[n.id].key, info[n.id].key, 'WomanAverage', nil end
  adoption = nil
  convaiTalkTarget = nil
  local toyParent = {record = 'Vehicle.trauma_team_av_model_toy'}
  local options = optionsApi.new({read = function() return 'x' end, decode = function() return {version = 1, characters = {}, records = {'Character.Wat_Switched_Off'}} end})
  options.refresh()
  convaiCharacterOptions = options
  local x = exclusionApi.new({id = function(n) return n.id end, record = function(n) return n.record end, appearance = function(n) return n.look end,
    parentRecord = function(n) return n.parent end, meshes = function(n) return n.meshes end,
    offRecord = function(record) return convaiCharacterOptions.offRecord(record) end, log = function(line) lines[#lines + 1] = line end})
  convaiTalkExclusion = x
  ${exclusionBlock}
  ${nearbySource}
  convaiPlayer = function() return player end
  local forward = {x = 1, y = 0, z = 0}
  Game = {GetTargetingSystem = function() return {GetCrosshairData = function() return {x = 0, y = 0, z = 0}, forward end} end}
  convaiHeadOutOfCone = function() return true end
  convaiHeadPoint = function() return nil end
  ${targetSource}
  ${body}
`);

test('the group list (convaiTalkNearbyPeople) leaves out the toy AV puppet, a hidden person and a switched-off person', () => selection(`
  local ok = body('A', 2, {key = 'npc-street-resident-female'})
  local toy = body('TOY', 1, {key = 'npc-street-resident-male', parent = toyParent, look = 'invisible'})
  local hidden = body('HID', 1.5, {key = 'npc-street-resident-male', look = 'Invisible_01'})
  local mesh = body('MESH', 2, {key = 'npc-street-resident-male', meshes = {total = 20, meshes = 0, shown = 0}})
  local driver = body('DRV', 2, {key = 'npc-street-resident-male', parent = toyParent})
  local off = body('OFF', 3, {key = 'npc-street-resident-male', record = 'Character.Wat_Switched_Off'})
  local b = body('B', 4, {key = 'npc-street-resident-male'})
  convaiTalkNative = {toy, hidden, mesh, driver, off, ok, b}
  local rows = convaiTalkNearbyPeople(player, {}, 3, 6)
  assert(#rows == 2 and rows[1].entity == 'A' and rows[2].entity == 'B', 'only the two people who are there: ' .. #rows)
  -- Switched back on (the editor saved a new list): the person is a listener again.
  options = optionsApi.new({read = function() return 'y' end, decode = function() return {version = 1, characters = {}} end}); options.refresh()
  convaiCharacterOptions = options
  local again = convaiTalkNearbyPeople(player, {}, 4, 6)
  assert(#again == 3 and again[2].entity == 'OFF', 'switched back on: ' .. #again)
`));

test('the crosshair target (targetAtCrosshair) never picks the toy puppet, even when it is the only one in front of V', () => selection(`
  local toy = body('TOY', 2, {key = 'npc-street-resident-male', parent = toyParent})
  local a = body('A', 5, {key = 'npc-street-resident-female'})
  local gathered = {candidates = {toy, a}, seated = {}, onFoot = {}, lookedOk = true, looked = toy}
  local chosen, why, decision = targetAtCrosshair(gathered)
  assert(chosen == a, 'the person is chosen, not the puppet the camera looks at')
  assert(#decision.rows == 1)
  local alone = targetAtCrosshair({candidates = {toy}, seated = {}, onFoot = {}, lookedOk = true, looked = toy})
  assert(alone == nil, 'nobody to talk to rather than the toy')
  -- A person switched off in the editor is not a target either, a companion of ours is never filtered as a puppet.
  local off = body('OFF', 2, {key = 'npc-street-resident-male', record = 'Character.Wat_Switched_Off'})
  assert(targetAtCrosshair({candidates = {off}, seated = {}, onFoot = {}, lookedOk = true, looked = off}) == nil)
  local mine = body('MINE', 2, {key = 'judy-alvarez', owned = true, look = 'invisible', meshes = {total = 9, meshes = 0, shown = 0}})
  assert(targetAtCrosshair({candidates = {mine}, seated = {}, onFoot = {}, lookedOk = true, looked = mine}) == mine, 'one of ours is never a puppet')
`));

test('the auto-connect scan and the spawned list call the same filter, and the manager is hooked to the options', () => {
  assert.match(between('local function scanNearbyCharacters(', 'local loaded, module = pcall(dofile, \'auto-connect.lua\')'), /convaiTalkExcluded/);
  assert.match(between('nearby = function(player, radius, options)', 'The profile key and name go with each remembered ID'), /convaiTalkExcluded/);
  assert.match(init, /manager\.switchedOff = service\.off/);
});
