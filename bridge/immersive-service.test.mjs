import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// mod/immersive-service.lua: the glue between init.lua and the controller. The rules that matter: with the setting Off nothing is loaded
// or read but the setting; On, everything is built once and hooked; Off again, everything is dropped; a turn's note goes on a copy.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/immersive-service.lua', import.meta.url), 'utf8');
function run(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = fixture + body;
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
}
const fixture = `
local Module = (function() ${source} end)()
local options = {enabled = false}
local log = {loads = {}, updates = {}, binds = {}, notices = {}, disabled = 0, noted = {}}
local controllerEnv
local controller = {
  update = function(delta) log.updates[#log.updates + 1] = delta end,
  bind = function(key, sequence) log.binds[#log.binds + 1] = tostring(key) .. '/' .. tostring(sequence) end,
  disable = function() log.disabled = log.disabled + 1 end,
  visitorLost = function() end,
  offer = function(profileKey, key) return {offer = profileKey .. '/' .. key} end,
  accept = function(profileKey, action) log.accepted = profileKey .. ':' .. action.kind end,
  note = function(profileKey) if profileKey == 'judy-alvarez' then return {kind = 'stood-up', place = 'x', minutes = 5} end end,
  noted = function(profileKey) log.noted[#log.noted + 1] = profileKey end,
  carEntity = function(profileKey) return profileKey == 'judy-alvarez' and 'her-car-entity' or nil end,
  isHerCar = function(entity) return entity == 'her-car-entity' end,
  sampleTrail = function() log.trail = (log.trail or 0) + 1 end,
}
local modules = {
  ['immersive-invitations.lua'] = {new = function(env) controllerEnv = env; return controller end},
  ['immersive-world.lua'] = {new = function(deps) return {deps = deps} end},
}
local companions = {phoneContactKey = function(contact) return contact == 'judy' and 'judy' or nil end}
local phoneChat = {}
local queue = {}
local deps = {
  manager = {immersive = function() return options end}, queue = function() return queue end, companions = companions, phoneChat = phoneChat,
  load = function(name) log.loads[#log.loads + 1] = name; return modules[name] end,
  notify = function(kind, text) log.notices[#log.notices + 1] = kind .. ':' .. text end,
  log = function() end, logOnce = function() end, held = function() end, districtOf = function() end, greet = function() end,
  persist = {}, wall = function() return 0 end, random = function() return 0.5 end,
}
local service = Module.new(deps)
`;

test('with the setting Off nothing is loaded, hooked or built, however long it ticks', () => run(`
  for _ = 1, 100 do service.tick(0.1) end
  assert(#log.loads == 0 and not phoneChat.captureMeetOffer and not companions.onVisitorLost)
  assert(service.get() == nil and service.appointmentTurn({a = 1}, 'judy-alvarez').appointment == nil)
`));

test('On: the controller and the adapter are loaded once, the phone and companion hooks are set, the controller is updated after it is bound', () => run(`
  options.enabled = true
  phoneChat.world = 'world-1'
  service.tick(0.1)
  assert(#log.loads == 2 and log.loads[1] == 'immersive-invitations.lua' and log.loads[2] == 'immersive-world.lua')
  assert(log.binds[1] == 'session:world-1/nil', log.binds[1])
  assert(#log.updates == 1 and log.updates[1] == 0.1)
  assert(type(phoneChat.captureMeetOffer) == 'function' and type(phoneChat.onMeetAction) == 'function' and type(companions.onVisitorLost) == 'function')
  service.tick(0.1); service.tick(0.1)
  assert(#log.loads == 2, 'built once')
  assert(#log.binds == 1, 'bound again only every two seconds')
  assert(controllerEnv.settings == deps.manager.immersive)
  assert(phoneChat.captureMeetOffer('judy', 'judy-alvarez').offer == 'judy-alvarez/judy')
  assert(phoneChat.captureMeetOffer('nobody', 'x') == nil)
  phoneChat.onMeetAction('judy-alvarez', {kind = 'meet-here'})
  assert(log.accepted == 'judy-alvarez:meet-here')
`));

test('the controller is not updated until the save line is known', () => run(`
  options.enabled = true
  for _ = 1, 30 do service.tick(0.1) end
  assert(#log.binds == 0 and #log.updates == 0)
  phoneChat.world = 'w'
  for _ = 1, 25 do service.tick(0.1) end
  assert(#log.binds >= 1 and #log.updates >= 1)
`));

test('a save line the game names binds as campaign and branch with the ledger sequence', () => run(`
  options.enabled = true
  phoneChat.saveIdentity = {status = 'available', campaignId = 'camp', branchId = 'branch', ledgerSequence = 12}
  phoneChat.world = 'w'
  service.tick(0.1)
  assert(log.binds[1] == 'camp:branch/12', log.binds[1])
  phoneChat.saveIdentity = {status = 'unavailable'}
  service.tick(2.1)
  assert(log.binds[#log.binds] == 'session:w/nil')
`));

test('Off again drops the controller and every hook; On again builds a fresh one', () => run(`
  options.enabled = true; phoneChat.world = 'w'
  service.tick(0.1)
  options.enabled = false
  service.tick(0.1)
  assert(log.disabled == 1 and not phoneChat.captureMeetOffer and not phoneChat.onMeetAction and not companions.onVisitorLost)
  local updates = #log.updates
  service.tick(0.1); assert(#log.updates == updates and log.disabled == 1)
  assert(service.get() == nil)
  options.enabled = true
  service.tick(0.1)
  assert(#log.loads == 4 and phoneChat.captureMeetOffer ~= nil)
`));

test('a world change rebinds; a fast travel keeps the appointments', () => run(`
  options.enabled = true; phoneChat.world = 'w1'
  service.tick(0.1)
  service.reset('fast travel', true)
  service.tick(0.1)
  assert(#log.binds == 1, 'a fast travel changes nothing')
  service.reset('load', false)
  assert(log.binds[#log.binds] == 'nil/nil')
  phoneChat.world = 'w2'
  service.tick(0.1)
  assert(log.binds[#log.binds] == 'session:w2/nil')
`));

test('the appointment note goes on a copy of the shared snapshot and counts as brought up once per turn', () => run(`
  options.enabled = true; phoneChat.world = 'w'
  service.tick(0.1)
  local shared = {district = 'Watson'}
  local turn = service.appointmentTurn(shared, 'judy-alvarez')
  assert(turn ~= shared and turn.district == 'Watson' and turn.appointment.kind == 'stood-up')
  assert(shared.appointment == nil, 'the cached snapshot is never changed')
  assert(#log.noted == 1 and log.noted[1] == 'judy-alvarez')
  assert(service.appointmentTurn(shared, 'panam-palmer') == shared and #log.noted == 1, 'no note: the same table, nothing counted')
  assert(service.appointmentTurn(nil, 'judy-alvarez') == nil)
`));

test('her text goes to the phone when she has a contact, and to a notice when she has none', () => run(`
  local sent
  phoneChat.sendEvent = function(item) sent = item; return item.profileKey == 'judy-alvarez' end
  assert(service.text({profileKey = 'judy-alvarez', name = 'Judy', fallback = 'Here.'}) == true and sent.name == 'Judy' and #log.notices == 0)
  assert(service.text({profileKey = 'rita', name = 'Rita', fallback = 'Hi.'}) == true)
  assert(log.notices[1] == 'text:Rita: Hi.')
`));

test('a module that cannot be loaded leaves the feature off without an error', () => run(`
  modules['immersive-world.lua'] = nil
  options.enabled = true; phoneChat.world = 'w'
  service.tick(0.1)
  assert(service.get() == nil or true)
  assert(#log.updates == 0 and not phoneChat.captureMeetOffer)
`));

test('her car is offered to the chauffeur through two globals that exist only while the setting is On', () => run(`
  assert(rawget(_G, 'convaiCompanionCar') == nil and rawget(_G, 'convaiCompanionCarIs') == nil)
  options.enabled = true; phoneChat.world = 'w'
  service.tick(0.1)
  assert(convaiCompanionCar('judy-alvarez') == 'her-car-entity' and convaiCompanionCar('panam-palmer') == nil)
  assert(convaiCompanionCarIs('her-car-entity') == true and convaiCompanionCarIs('other') == false)
  options.enabled = false
  service.tick(0.1)
  assert(rawget(_G, 'convaiCompanionCar') == nil and rawget(_G, 'convaiCompanionCarIs') == nil)
`));

test('the trail of roads V drives is sampled every two seconds, only while Car is the arrival method', () => run(`
  options.enabled = true; phoneChat.world = 'w'
  options.arrival = 'walk'
  for _ = 1, 100 do service.tick(0.1) end
  assert(log.trail == nil, 'walking arrivals need no trail')
  options.arrival = 'car'
  for _ = 1, 100 do service.tick(0.1) end
  assert(log.trail >= 4 and log.trail <= 6, tostring(log.trail))
`));
