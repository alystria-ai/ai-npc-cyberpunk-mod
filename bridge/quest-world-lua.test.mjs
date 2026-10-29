// The game calls behind the bond quest primitives (mod/quest-world.lua): a position, the ground ray, the map pin, the character's own copy, the seats, and the tagged
// cast. Run against a fake `Game` that records what is asked of it, on the success path and the failure path of each call that is not yet seen working in the real game.
// Nothing here starts the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, load, source, base} from './quest-lua-fixture.mjs';

const harness = `
local M = ${load('quest-world.lua')}
${base}
local game = {registered = {}, unregistered = {}, registerResult = 'MAPPIN1', registerError = false, rays = {}, hits = {}, spatial = true, created = {}, createResult = nil,
  createError = false, deleted = {}, managed = true, tagged = true, ready = true, taggedIds = {}, entities = {}, records = {['Character.Generic'] = true},
  invites = {}, inviteResult = {true, '', 'job1'}, visitors = {}, dismissed = {}, queueDismissed = {}, sitting = false, phases = {}}
Vector4 = {new = function(x, y, z, w) return {x = x, y = y, z = z, w = w} end}
CName = {new = function(s) return 'CName:' .. s end}
TweakDBID = {new = function(s) return 'TweakDBID:' .. s end}
Enum = {new = function(t, n) return t .. '.' .. n end}
Quaternion = {BuildFromDirectionVector = function(v) return {facing = v} end}
NewObject = function(name) return {__type = name} end
TweakDB = {GetRecord = function(_, id)
  local name = id:gsub('^TweakDBID:', '')
  if not game.records[name] then return nil end
  return {IsA = function(_, kind) return kind == 'gamedataCharacter_Record' end}
end}
local player = {GetWorldPosition = function() return {x = 1, y = 2, z = 3} end}
local dynamic = {
  IsReady = function() return game.ready end,
  CreateEntity = function(_, spec)
    if game.createError then error('boom') end
    game.created[#game.created + 1] = spec
    return game.createResult or {hash = '12345'}
  end,
  IsManaged = function() return game.managed end,
  IsTagged = function(_, id, tag) game.lastTag = tag; return game.tagged end,
  DeleteEntity = function(_, id) game.deleted[#game.deleted + 1] = id end,
  GetEntity = function(_, id) return game.entities[id.hash] end,
  GetTaggedIDs = function(_, tag) game.sweepTag = tag; return game.taggedIds end,
}
Game = {
  GetPlayer = function() return player end,
  GetMappinSystem = function() return {
    RegisterMappin = function(_, data, position)
      if game.registerError then error('no mappin system') end
      game.registered[#game.registered + 1] = {data = data, position = position}
      return game.registerResult
    end,
    UnregisterMappin = function(_, id) game.unregistered[#game.unregistered + 1] = id end} end,
  GetSpatialQueriesSystem = function()
    if not game.spatial then return nil end
    return {SyncRaycastByCollisionGroup = function(_, from, to, group)
      game.rays[#game.rays + 1] = {from = from, to = to, group = group}
      local hit = game.hits[group:gsub('^CName:', '')]
      if hit == 'error' then error('ray failed') end
      if hit then return true, {position = {z = hit}} end
      return false
    end} end,
  GetDynamicEntitySystem = function() return dynamic end,
}
local npcAt = function(x, y, z, attached) return {IsAttached = function() return attached ~= false end, IsDeadNoStatPool = function() return false end,
  GetWorldPosition = function() return {x = x, y = y, z = z} end} end
local companions = {
  conversationCandidates = function(p, radius)
    return {{profileKey = 'judy-alvarez', entity = '42', party = true, npc = npcAt(10, 0, 0)}, {profileKey = 'panam-palmer', entity = '77', party = false, npc = npcAt(30, 40, 5)},
      {profileKey = 'panam-palmer', entity = '78', party = true, npc = npcAt(300, 0, 0)}}
  end,
  ownCopy = function(entity, key) return entity == '77' and 'housemate' or nil end,
  identity = function(npc) return 'panam-palmer', 'Panam', true, 9 end,
  partyMemberOf = function(key) if key == 'panam-palmer' then return {serial = 9} end return nil end,
  visitors = function() return game.visitors end,
  dismissVisitor = function(serial, why) game.dismissed[#game.dismissed + 1] = serial .. ':' .. why end,
}
local queue = {invite = function(key, extra) game.invites[#game.invites + 1] = {key = key, extra = extra}; local u = table.unpack or unpack; return u(game.inviteResult) end,
  dismiss = function(id, quiet) game.queueDismissed[#game.queueDismissed + 1] = id end}
local seating = {sitting = function() return game.sitting end, phaseOf = function(serial) return game.phases[serial] end}
local world = M.new({companions = companions, queue = function() return queue end, seating = function() return seating end,
  district = function() return {district = 'Badlands', area = 'RockyRidge'} end, log = log})
`;
const withGame = code => run(`${harness}\n${code}`);

test('position and district are plain data', () => withGame(`
local at = world.playerPosition()
assert(at.x == 1 and at.y == 2 and at.z == 3 and type(at) == 'table' and getmetatable(at) == nil)
assert(world.district().district == 'Badlands')
`));

test('the ground ray: one downward ray per floor group, the highest hit wins, no hit and no spatial system are nil', () => withGame(`
game.hits.Static = 4.0; game.hits.Terrain = 4.5
assert(world.rayDown(10, 20, 13, -10) == 4.5)
assert(#game.rays == 2 and game.rays[1].from.z == 13 and game.rays[1].to.z == -10 and game.rays[1].from.x == 10 and game.rays[1].group == 'CName:Static')
game.hits.Terrain = nil; assert(world.rayDown(10, 20, 13, -10) == 4.0)
game.hits.Static = nil; assert(world.rayDown(10, 20, 13, -10) == nil)
game.hits.Static = 'error'; assert(not pcall(world.rayDown, 10, 20, 13, -10), 'a raising ray reaches the caller, which guards it')
game.spatial = false; assert(world.rayDown(10, 20, 13, -10) == nil)
`));

test('a map pin: the mappin data of a static pin seen through walls, registered at the point, removed by the same id; a refusal is nil, a raise reaches the caller', () => withGame(`
local id = world.pinAdd(5, 6, 7)
assert(id == 'MAPPIN1' and #game.registered == 1)
local data, position = game.registered[1].data, game.registered[1].position
assert(data.__type == 'gamemappinsMappinData' and data.mappinType == 'TweakDBID:Mappins.DefaultStaticMappin' and data.variant == 'gamedataMappinVariant.CustomPositionVariant' and data.visibleThroughWalls == true)
assert(position.x == 5 and position.y == 6 and position.z == 7)
world.pinRemove(id); assert(game.unregistered[1] == 'MAPPIN1')
game.registerResult = nil; assert(world.pinAdd(1, 1, 1) == nil)
game.registerResult = false; assert(world.pinAdd(1, 1, 1) == nil)
game.registerError = true; assert(not pcall(world.pinAdd, 1, 1, 1))
`));

test('the copy of the character: the nearest one that speaks as the profile, its kind, serial and position as plain data, nil when she is not there', () => withGame(`
local copy = world.copyOf('panam-palmer')
assert(copy.kind == 'housemate' and copy.serial == 9 and copy.position.x == 30 and copy.position.z == 5 and getmetatable(copy.position) == nil)
assert(world.copyOf('judy-alvarez').kind == 'party')
assert(world.copyOf('nobody') == nil)
`));

test('seated: V sitting from the seating controller, the party copy by its seat phase, a world with no seating says no', () => withGame(`
local s = world.seated('panam-palmer'); assert(s.v == false and s.copy == false)
game.sitting = true; game.phases[9] = 'seated'; s = world.seated('panam-palmer'); assert(s.v == true and s.copy == true)
game.phases[9] = 'standing'; assert(world.seated('panam-palmer').copy == false)
assert(world.seated('judy-alvarez').copy == false, 'no party member of that profile')
local bare = M.new({companions = companions})
s = bare.seated('panam-palmer'); assert(s.v == false and s.copy == false)
`));

test('cast, an extra: the record is checked, the spec is nonpersistent and carries the shared tag and the quest tag, the id is the handle', () => withGame(`
local handle, why = world.castSpawn({id = 'pk:tom', who = 'extra', record = 'Character.Generic', x = 1, y = 2, z = 3, facing = {x = 0, y = 1}, tag = 'CyberpunkConvaiQuest:pk'})
assert(handle and handle.kind == 'extra' and handle.id.hash == '12345', tostring(why))
local spec = game.created[1]
assert(spec.__type == 'DynamicEntitySpec' and spec.recordID == 'TweakDBID:Character.Generic' and spec.position.z == 3)
assert(spec.persistState == false and spec.persistSpawn == false and spec.alwaysSpawned == false and spec.active == true)
assert(#spec.tags == 2 and spec.tags[1] == 'CName:CyberpunkConvaiQuest' and spec.tags[2] == 'CName:CyberpunkConvaiQuest:pk')
assert(spec.orientation.facing.y == 1)
-- The failure paths.
local h2, w2 = world.castSpawn({id = 'x', who = 'extra', record = 'Character.Nope', x = 1, y = 2, z = 3}); assert(h2 == nil and w2:find('unknown record'))
game.createResult = {hash = '0'}; local h3, w3 = world.castSpawn({id = 'x', who = 'extra', record = 'Character.Generic', x = 1, y = 2, z = 3}); assert(h3 == nil and w3:find('could not create'))
game.createResult = nil; game.createError = true; assert(world.castSpawn({id = 'x', who = 'extra', record = 'Character.Generic', x = 1, y = 2, z = 3}) == nil)
game.createError = false; game.ready = false; local h4, w4 = world.castSpawn({id = 'x', who = 'extra', record = 'Character.Generic', x = 1, y = 2, z = 3}); assert(h4 == nil and w4 == 'World is not ready')
assert(world.castSpawn({id = 'x', who = 'extra', record = 'Character.Generic', x = 'a', y = 2, z = 3}) == nil)
assert(world.castSpawn('nope') == nil)
`));

test('cast, an extra: found only once the game has attached it (looked up fresh), deleted only when it is our own tagged spawn', () => withGame(`
local handle = world.castSpawn({id = 'pk:tom', who = 'extra', record = 'Character.Generic', x = 1, y = 2, z = 3, tag = 'CyberpunkConvaiQuest:pk'})
assert(world.castLookup(handle) == nil, 'not in the world yet')
game.entities['12345'] = npcAt(8, 9, 10, false); assert(world.castLookup(handle) == nil, 'created but not attached')
game.entities['12345'] = npcAt(8, 9, 10, true); local found = world.castLookup(handle)
assert(found.position.x == 8 and found.position.z == 10 and getmetatable(found.position) == nil)
game.managed = false; assert(world.castLookup(handle) == nil)
game.managed = true; world.castDelete(handle); assert(#game.deleted == 1 and game.lastTag == 'CName:CyberpunkConvaiQuest')
game.tagged = false; world.castDelete(handle); assert(#game.deleted == 1, 'a spawn that is not tagged as ours is left alone')
world.castDelete(nil); world.castLookup(nil)
`));

test('cast, one of our own copies: placed at a spot through the party queue as a visitor of the quest, found and removed by its appointment', () => withGame(`
local handle, why = world.castSpawn({id = 'pk:tom', who = 'self', profileKey = 'panam-palmer', x = 1, y = 2, z = 3, facing = {x = 0, y = 1}})
assert(handle and handle.kind == 'copy' and handle.appointment == 'quest:pk:tom' and handle.job == 'job1', tostring(why))
local call = game.invites[1]
assert(call.key == 'panam-palmer' and call.extra.quiet == true and call.extra.resident == true)
local a = call.extra.appointment
assert(a.id == 'quest:pk:tom' and a.owner == 'quest' and a.position.x == 1 and a.position.z == 3 and a.facing.y == 1 and a.flexible == true)
assert(world.castLookup(handle) == nil)
game.visitors = {{appointmentId = 'quest:pk:tom', state = 'spawning', serial = 31}}; assert(world.castLookup(handle) == nil, 'still spawning')
game.visitors = {{appointmentId = 'quest:pk:tom', state = 'visiting', serial = 31, position = {x = 4, y = 5, z = 6}}}
local found = world.castLookup(handle); assert(found.position.x == 4 and found.serial == 31)
world.castDelete(handle); assert(game.dismissed[1] == '31:module' and #game.queueDismissed == 0)
-- Not yet made: the invitation job is cancelled instead.
game.visitors = {}; world.castDelete(handle); assert(game.queueDismissed[1] == 'job1')
-- Refused by the queue, raising, or no queue.
game.inviteResult = {false, 'That character model is unavailable.'}
local h, w = world.castSpawn({id = 'b', who = 'judy-alvarez', profileKey = 'judy-alvarez', x = 1, y = 2, z = 3}); assert(h == nil and w == 'That character model is unavailable.')
queue.invite = function() error('queue broke') end
local h2, w2 = world.castSpawn({id = 'c', who = 'self', profileKey = 'panam-palmer', x = 1, y = 2, z = 3}); assert(h2 == nil and w2:find('queue broke'))
assert(M.new({companions = companions}).castSpawn({id = 'c', who = 'self', profileKey = 'panam-palmer', x = 1, y = 2, z = 3}) == nil)
`));

test('the sweep removes what an earlier session left under the shared tag, once, and survives a world that is not ready', () => withGame(`
game.taggedIds = {{hash = 'a'}, {hash = 'b'}}
assert(world.sweep() == 2 and #game.deleted == 2 and game.sweepTag == 'CName:CyberpunkConvaiQuest' and logged('removed 2'))
game.taggedIds = {}; assert(world.sweep() == 0)
game.ready = false; game.taggedIds = {{hash = 'a'}}; assert(world.sweep() == 0 and #game.deleted == 2)
game.ready = true; game.taggedIds = 'x'; assert(world.sweep() == 0)
`));

test('the file names no other mod and keeps to plain Lua 5.1', () => {
  const text = source('quest-world.lua');
  assert.ok(!/\bgoto\b|table\.unpack|bit32/.test(text));
  for (const line of text.split('\n')) assert.ok(!/--.*;/.test(line), 'no semicolon in a comment: ' + line);
});
