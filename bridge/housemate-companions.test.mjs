import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';
import {run as runManager, managerFixture, queueSource} from './manager-fixture.mjs';

// The housemates' bodies in the real mod/companions.lua (the fixture of the immersive visitors): a visiting copy that belongs to the
// housemates, hidden from the party list, released to home from the party and joined back without a respawn.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(companionEngine + code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(status, lua.LUA_OK, error);
}

const resident = `
  local function live(key, home)
    local serial = companions.spawn(key, {profileKey = key, profileName = key, appointment = {id = 'hm:' .. key,
      position = Vector4.new(10, 10, 0), facing = {x = 0, y = 1}, owner = 'housemates', home = home or 'corpo'}})
    tick()
    return serial, entities[sequence]
  end
`;

test('a housemate\'s body is a visiting copy that carries its owner and its flat, in the list and in the visitor rows', () => run(`${resident}
  local serial, npc = live('judy-alvarez', 'glen')
  local rows = companions.list()
  assert(#rows == 1 and rows[1].state == 'visiting' and rows[1].owner == 'housemates' and rows[1].home == 'glen')
  local visitors = companions.visitors()
  assert(#visitors == 1 and visitors[1].owner == 'housemates' and visitors[1].home == 'glen' and visitors[1].appointmentId == 'hm:judy-alvarez')
  assert(visitors[1].entityID == tostring(npc.id.hash), tostring(visitors[1].entityID))
  assert(companions.residentNpc(serial) == npc and companions.residentNpc(999) == nil)
  assert(companions.identity(npc) == 'judy-alvarez', 'she can be talked to')
  assert(companions.partyMemberOf('judy-alvarez') == nil, 'a resident is not a party member')
`));

test('the module that owns the body is told when she is lost, the immersive module for its visitors', () => run(`${resident}
  local resident_, visitor_ = {}, {}
  companions.onResidentLost = function(serial, reason) resident_[#resident_ + 1] = serial .. ':' .. reason end
  companions.onVisitorLost = function(serial, reason) visitor_[#visitor_ + 1] = serial .. ':' .. reason end
  local a = live('judy-alvarez')
  local b = companions.spawn('panam-palmer', {profileKey = 'panam-palmer', appointment = {id = 5, position = Vector4.new(30, 30, 0)}}); tick()
  companions.dismissVisitor(a, 'module')
  companions.dismissVisitor(b, 'module')
  assert(#resident_ == 1 and resident_[1] == a .. ':module', tostring(resident_[1]))
  assert(#visitor_ == 1 and visitor_[1] == b .. ':module', tostring(visitor_[1]))
`));

test('a fast travel deletes the bodies of the housemates and says why', () => run(`${resident}
  local lost = {}
  companions.onResidentLost = function(serial, reason) lost[#lost + 1] = reason end
  live('judy-alvarez')
  companions.beginFastTravel()
  assert(lost[1] == 'fast-travel')
`));

test('tagging along: the same body gets the follower role, loses its owner and its flat, and is a party member', () => run(`${resident}
  local serial, npc = live('judy-alvarez', 'corpo')
  assert(companions.joinVisitor(serial))
  local rows = companions.list()
  assert(#rows == 1 and rows[1].state == 'ready' and rows[1].owner == nil and rows[1].home == nil)
  assert(npc.ai.role.kind == 'AIFollowerRole')
  local member = companions.partyMemberOf('judy-alvarez')
  assert(member and member.serial == serial and member.entityID == tostring(npc.id.hash))
`));

test('resting at home: the party member loses the follower role and becomes a resident of that flat on the same body', () => run(`${resident}
  local serial, npc = live('judy-alvarez', 'corpo')
  companions.joinVisitor(serial)
  tick(5)
  assert(npc.ai.role.kind == 'AIFollowerRole')
  local ok, why = companions.releaseToHome(serial, 'corpo')
  assert(ok == true, tostring(why))
  assert(npc.ai.role.kind == 'AINoRole', 'the follow behaviour is removed')
  local rows = companions.list()
  assert(#rows == 1 and rows[1].state == 'visiting' and rows[1].owner == 'housemates' and rows[1].home == 'corpo')
  assert(companions.visitors()[1].appointmentId == 'hm:judy-alvarez')
  assert(companions.partyMemberOf('judy-alvarez') == nil)
  assert(entities[sequence] == npc, 'no second body')
  -- the party loop leaves her alone now
  local before = #npc.ai.commands
  tick(10)
  assert(#npc.ai.commands == before, 'a command was sent to a resident by the party loop')
  assert(companions.releaseToHome(serial, 'corpo') == false, 'she is not in the party any more')
`));

test('the straight step, the turn in place and the show/hide act on a resident only', () => run(`${resident}
  local serial, npc = live('judy-alvarez')
  local member = spawn('panam-palmer')
  assert(companions.visitorStep(serial, Vector4.new(11, 10, 0)) == true)
  local move = last(npc, 'AIMoveToCommand')
  assert(move and move.ignoreNavigation == true, 'a straight step, not a route')
  assert(companions.visitorFace(serial, Vector4.new(11, 10, 0), 90) == true)
  local turn = last(npc, 'AITeleportCommand')
  assert(turn and turn.rotation == 90 and turn.doNavTest == false)
  assert(companions.residentVisible(serial, false) == true)
  assert(companions.visitorStep(9999, Vector4.new(0, 0, 0)) == false)
`));

test('an unknown serial cannot be released to a flat', () => run(`${resident}
  local serial = live('judy-alvarez')
  companions.joinVisitor(serial)
  local ok = companions.releaseToHome(9999, 'corpo')
  assert(ok == false)
`));

// ---- the party queue -------------------------------------------------------------------------------------------------------------------------
test('a resident job needs no preparation, takes her profile as she spawns, and is not a party copy in the list or the count', () => {
  runManager(`${managerFixture}
    manager.configure(api, profiles)
    local seen
    local original = api.spawn
    api.spawn = function(key, job) seen = job; return original(key) end
    local queue = (function() ${queueSource} end)().new(api)
    queue.bind('player-1')
    local ok, _, id = queue.invite('johnny-silverhand', {quiet = true, resident = true, appointment = {id = 'hm:johnny-silverhand', owner = 'housemates', home = 'h10'}})
    assert(ok and id)
    queue.flush()
    assert(#spawned == 1, 'the copy is created at once, nothing to prepare')
    assert(seen.profileKey == nil and seen.attachProfileKey == 'johnny-silverhand', 'the profile is assigned as she spawns')
    assert(seen.appointment.owner == 'housemates')
  `);
});

test('a flexible body (a housemate\'s) is made at her spot, or beside it when the spot is blocked, never at V\'s side (owner, 2026-10-26)', () => run(`
  local function flexible(key, x)
    local serial = companions.spawn(key, {profileKey = key, profileName = key, appointment = {id = 'hm:' .. key, flexible = true,
      position = Vector4.new(x, 10, 0), facing = {x = 0, y = 1}, owner = 'housemates', home = 'corpo'}})
    tick()
    return serial, entities[sequence]
  end
  local _, npc = flexible('judy-alvarez', 10)
  local at = npc:GetWorldPosition()
  assert(math.abs(at.x - 10) < 4 and math.abs(at.y - 10) < 4, 'not near her spot: ' .. at.x .. ',' .. at.y)
`));

// Live 2026-10-26: at home every housemate answered "what weapon do you have?" with none. activityInputs only had rows for ready party copies, so the turn
// context never got the weapon of a visiting body (the housemate at home), although the game read it.
test('a housemate at home still has a row with the weapon she carries, and no activity', () => run(`${resident}
  local carried = {{GetID = function() return {record = 'Items.Chao', hash = 'c'} end}}
  RPGManager = {IsItemWeapon = function() return true end}
  Game.GetTransactionSystem = function() return {GetItemList = function() return true, carried end} end
  TweakDBInterface = {GetItemRecord = function(r) return {DisplayName = function() return 'Satara' end} end,
    GetCharacterRecord = function() return {PrimaryEquipment = function() return {GetEquipmentItemsCount = function() return 0 end} end} end}
  ItemID = {IsValid = function(id) return id ~= nil end, GetCombinedHash = function(id) return id.hash end, GetTDBID = function(id) return id.record end}
  ScriptedPuppet = {GetWeaponRight = function(n) return n.weapon end, GetWeaponLeft = function() return nil end}
  WeaponObject = {IsFists = function() return false end}
  Game.GetLocalizedTextByKey = function(key) return key end
  local serial, npc = live('judy-alvarez', 'corpo')
  function npc:GetRecordID() return 'Character.Judy' end
  assert(companions.list()[1].state == 'visiting')
  local row = companions.activityInputs({}).rows['judy-alvarez']
  assert(row, 'a visiting copy has a row')
  assert(row.visitor == true and row.holding == 'holstered' and row.weapon == 'Satara', tostring(row.holding) .. tostring(row.weapon))
  assert(row.transport == nil and row.seating == nil and row.behavior == nil, 'nothing is claimed about what she is doing')
  Game.GetTransactionSystem = function() error('unreadable') end
  TweakDBInterface.GetCharacterRecord = function() error('unreadable') end
  os.clock = function() return 1e6 end
  assert(companions.activityInputs({}).rows['judy-alvarez'] == nil, 'a read that cannot say gives no row')
`));
