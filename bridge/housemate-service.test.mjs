import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {lua} from './housemate-fixture.mjs';

// The glue between init.lua and the housemates, against fake game dependencies.
const SERVICE = `
  local Service = dofile('housemate-service.lua')
  local registry = dofile('housemate-registry.lua')
  local facts = {}
  local notes, adopted, released, log_ = {}, {}, {}, {}
  local party = {}
  local companions = {
    visitors = function() return {} end, list = function() return {} end,
    definition = function(key) return {id = 'Character.' .. key, name = key} end,
    joinVisitor = function() return true end,
    releaseToHome = function(serial, apt) released[#released + 1] = {serial, apt}; return true end,
    partyMemberOf = function(key) return party[key] end,
    partyMember = function(entity) if entity == '1ULL' then return {serial = 1} end return nil end,
    residentNpc = function() return nil end,
    dismissVisitor = function() end, residentVisible = function() end,
  }
  local place = 'CorpoPlaza_Apartment'
  local deps
  deps = {
    load = dofile, companions = companions,
    queue = function() return nil end, catalog = function() return {} end, seating = function() return {native = {}} end,
    fact = function(name) return facts[name] or 0 end,
    place = function() return place end, hours = function() return 14 end, held = function() return nil end,
    vpos = function() return {x = 0, y = 0, z = 0} end,
    knownKeys = function() return {'judy-alvarez', 'panam-palmer', 'rogue'} end,
    eligible = function(key) return key ~= 'story-person' end,
    profileName = function(key) return key end,
    notify = function(text) notes[#notes + 1] = text end,
    t = function(text, vars) return (text:gsub('{(%w+)}', function(k) return tostring(vars and vars[k]) end)) end,
    log = function(line) log_[#log_ + 1] = line end, devLog = function() end,
    talking = function() return nil end, random = function() return 0.4 end,
    speak = function() return true end, speakStatus = function() return 'busy' end, speakCancel = function() end,
    greet = function() return true end, level = function() return 'rare' end, mayChat = function() return true end,
    outfits = function() return nil end,
    leave = function(serial, entity, key, name) adopted[#adopted + 1] = {serial, entity, key, name}; return true end,
    persist = nil, hookDistrict = function(fn) deps.hooked = true end,
    storeMode = function() return 'file' end,
  }
  -- a store in memory behind the file store
  local files = {}
  local fileStore = registry.fileStore('x.json', {open = function(path, mode)
    if mode == 'rb' then if not files[path] then return nil end return {read = function() return files[path] end, close = function() end} end
    return {write = function(self, text) files[path] = text end, close = function() end}
  end})
  json = {encode = function(value) local parts = {} for k, v in pairs(value.facts or {}) do parts[#parts + 1] = k .. '=' .. v end return 'F' .. table.concat(parts, ';') end,
    decode = function(text) local out = {facts = {}} for k, v in text:sub(2):gmatch('([^;=]+)=([^;]+)') do out.facts[k] = tonumber(v) end return out end}
  registry.fileStore = function() return fileStore end
  local service = Service.new(deps)
`;

test('nobody lives anywhere: the first tick reads the registry once, no controller is built, later ticks do nothing', () => {
  lua(`${SERVICE}
    service.tick(0.1)
    assert(service.controller == nil)
    for _ = 1, 50 do service.tick(0.1) end
    assert(service.controller == nil)
    assert(next(service.rows()) == nil)
  `);
});

test('somebody lives somewhere: the first tick builds the controller with her flat from the saved registry', () => {
  lua(`${SERVICE}
    registry.write(fileStore, 'judy-alvarez', 'corpo')
    service.tick(0.1)
    assert(service.controller, 'no controller')
    local rows = service.rows()
    assert(#rows == 1 and rows[1].key == 'judy-alvarez' and rows[1].apartment == 'corpo')
    assert(deps.hooked == true, 'the district hook was not asked for')
  `);
});

test('an offer builds the controller on demand; before the first read the registry is applied when it arrives', () => {
  lua(`${SERVICE}
    registry.write(fileStore, 'rogue', 'h10')
    -- a conversation turn comes before the world-ready read
    local offer = service.homeOffer('1ULL', {profileKey = 'judy-alvarez'})
    assert(offer and #offer.apartments >= 1)
    -- somebody who is not one of our copies (a game character, a person on the street) is offered nothing
    assert(service.homeOffer('999ULL', {profileKey = 'judy-alvarez'}) == nil)
    service.tick(0.1)
    assert(#service.rows() == 1 and service.rows()[1].key == 'rogue', 'the registry was not applied to the controller built early')
  `);
});

test('a leave packet: housemates at home are released, the others go through the old departure', () => {
  lua(`${SERVICE}
    registry.write(fileStore, 'judy-alvarez', 'corpo')
    service.tick(0.1)
    local departing = {}
    local adoption = function(target, offer, entity, requestId, groupId) departing[#departing + 1] = {target = target, offer = offer}; return true, 'Rogue is leaving your party.' end
    local offer = {available = true, actor = {id = '1ULL', key = 'judy-alvarez'}, members = {
      {serial = 1, id = '1ULL', key = 'judy-alvarez', name = 'Judy'}, {serial = 2, id = '2ULL', key = 'rogue', name = 'Rogue'}}}
    service.controller.update(0.1)
    party['judy-alvarez'] = {serial = 1, entityID = '1ULL'}
    local ok = service.queueLeave('all', offer, '1ULL', 'r1', nil, adoption)
    assert(ok == true)
    assert(#released == 1 and released[1][1] == 1 and released[1][2] == 'corpo')
    assert(#departing == 1 and #departing[1].offer.members == 1 and departing[1].offer.members[1].key == 'rogue')
    assert(notes[#notes] == 'Judy is back at home.', tostring(notes[#notes]))
  `);
});

test('with nobody living anywhere a leave packet is the old one, untouched', () => {
  lua(`${SERVICE}
    service.tick(0.1)
    local seen
    local adoption = function(target, offer, entity, requestId, groupId) seen = {target, offer}; return true end
    local offer = {available = true, actor = {id = '1ULL', key = 'rogue'}, members = {{serial = 2, id = '2ULL', key = 'rogue', name = 'Rogue'}}}
    assert(service.queueLeave('2ULL', offer, '1ULL', 'r1', nil, adoption) == true)
    assert(seen[1] == '2ULL' and seen[2] == offer)
    assert(service.decorateLeave(offer) == offer)
  `);
});

test('the turn note goes on a copy, only for housemates, and only once the controller exists', () => {
  lua(`${SERVICE}
    local snapshot = {clock = {hour = 10}}
    assert(service.turn(snapshot, 'judy-alvarez') == snapshot)
    registry.write(fileStore, 'judy-alvarez', 'corpo')
    service.tick(0.1)
    local noted = service.turn(snapshot, 'judy-alvarez')
    assert(noted ~= snapshot and noted.housemate.apartment == 'Corpo Plaza' and snapshot.housemate == nil)
    assert(service.turn(snapshot, 'rogue') == snapshot)
  `);
});

test('a world change drops the controller and the registry is read again for the next save', () => {
  lua(`${SERVICE}
    registry.write(fileStore, 'judy-alvarez', 'corpo')
    service.tick(0.1)
    assert(#service.rows() == 1)
    service.reset('load', false)
    assert(#service.rows() == 0)
    -- the next save has other facts
    registry.write(fileStore, 'judy-alvarez', nil)
    registry.write(fileStore, 'rogue', 'glen')
    service.tick(0.1)
    local rows = service.rows()
    assert(#rows == 1 and rows[1].key == 'rogue', 'the new save\\'s registry was not read')
    -- a fast travel keeps the registry
    service.reset('fast-travel', true)
    assert(#service.rows() == 1)
  `);
});

test('the phone offer and answer pass through', () => {
  lua(`${SERVICE}
    local offer = service.phoneOffer('judy-alvarez', 'judy-alvarez')
    assert(offer and offer.token:find('^home%-'))
    assert(service.phoneAction('judy-alvarez', {action = 'stay', apartment = 'h10', token = offer.token}) == true)
    assert(service.controller.homeOf('judy-alvarez') == 'h10')
  `);
});

// ---- init.lua is wired in every place the design names -------------------------------------------------------------------------------------------
const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');

test('init.lua: the tick, the reset, the offers, the turn note, the talk hook, the seat hook and the spoken lines are wired', () => {
  assert.match(init, /pcall\(convaiHousemateTick, elapsedPoll\)/);
  assert.match(init, /convaiHousemateReset\(reason, preserveTransit == true\)/);
  assert.match(init, /homeOffer = function\(entity, context\)/);
  assert.match(init, /groupHomeOffer = function\(entity, context\)/);
  assert.match(init, /queueHome = function\(home, offer, entity, requestId, groupId\)/);
  assert.match(init, /convaiHousemateQueueLeave\(target, offer, entity, requestId, groupId,/);
  assert.match(init, /offer = convaiHousemateLeaveOffer\(offer\)/);
  assert.match(init, /context\.turnContext = convaiHousemateTurn\(context\.turnContext, context\.profileKey\)/);
  assert.match(init, /onSettled = function\(anchor, forward, kind\)/);
  assert.match(init, /elseif automatic and automatic\.reaction\.kind == 'house' then\s+convaiHouseTick\(player, now, worldReady, outputs, manual\)/);
  assert.match(init, /if not automatic and \(convaiHouseWaiting or convaiHouseCurrent\) then/);
  assert.match(init, /context\.reaction\.kind == 'house' then context\.battle = nil end/);
  assert.match(init, /pending\.reaction\.kind == 'house' and convaiHouseReplyText/);
  assert.match(init, /ObserveAfter\('PreventionSystem', 'OnDistrictAreaEntered'/);
  assert.match(init, /phoneChat\.captureHomeOffer = function\(contact, profileKey\)/);
  assert.match(init, /'housemate-notice'/);
});

test('init.lua: a housemate keeps her seat during a talk (eyes and head only) and a talk wakes her', () => {
  assert.match(init, /convaiResidentNpc ~= nil and convaiHousemates ~= nil and convaiResidentNpc\(npc\)/);
  assert.match(init, /if convaiHouseWaiting then convaiHouseSpeakCancel\(\) end/);
});

test('the housemates add no per-frame work: nothing in them is called from a frame callback', () => {
  const service = readFileSync(new URL('../mod/housemate-service.lua', import.meta.url), 'utf8');
  const controller = readFileSync(new URL('../mod/housemates.lua', import.meta.url), 'utf8');
  for (const text of [service, controller]) assert.doesNotMatch(text, /onUpdate|GameSession\.|Cron\./);
  // the tick is called from the world-ready part of the 10 Hz poll, next to the immersive tick
  assert.ok(init.indexOf('pcall(convaiHousemateTick, elapsedPoll)') > init.indexOf('pcall(convaiImmersiveTick, elapsedPoll)'));
});

// Performance: the chat module is loaded from the 0.1 s tick; a file that cannot be loaded must not be read and compiled again on every tick.
test('a pair chat module that cannot be loaded is tried once, then again only after the chat is switched Off and On', () => {
  lua(`${SERVICE}
    registry.write(fileStore, 'judy-alvarez', 'corpo')
    local loads, chatOn = 0, true
    local inner = deps.load
    deps.load = function(name)
      if name == 'housemate-chat.lua' then loads = loads + 1; error('syntax error near x') end
      return inner(name)
    end
    deps.chatOn = function() return chatOn end
    service = Service.new(deps)
    for _ = 1, 60 do service.tick(0.1) end
    assert(service.controller, 'no controller')
    assert(loads == 1, 'the chat file was loaded ' .. loads .. ' times')
    local says = 0
    for _, line in ipairs(log_) do if line:find('Housemate chat is unavailable', 1, true) then says = says + 1 end end
    assert(says == 1, 'the failure was logged ' .. says .. ' times')
    chatOn = false; service.tick(0.1)
    chatOn = true; for _ = 1, 5 do service.tick(0.1) end
    assert(loads == 2, 'switching the chat Off and On did not try again: ' .. loads)
  `);
});
