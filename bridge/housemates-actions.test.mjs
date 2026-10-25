import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lua} from './housemate-fixture.mjs';
import {WORLD} from './housemate-world-fake.mjs';

// Moving in, tagging along, resting, moving out: the offers the game leases and what each action does.
const PARTY = `
  -- a party member of V's: a body in the party list, in the flat
  local function inParty(key)
    local serial = world.nextSerial; world.nextSerial = serial + 1
    world.party[serial] = {serial = serial, profileKey = key, entityID = tostring(serial) .. 'ULL', state = 'ready'}
    return serial, tostring(serial) .. 'ULL'
  end
`;

test('the home offer lists only the flats V has, the flat V is in, and the housemates in earshot', () => {
  lua(`${WORLD}${PARTY}
    world.facts.dlc6_apart_hey_gle_purchased = 0   -- Glen is not bought; Corpo Plaza is
    local c = control({['judy-alvarez'] = 'corpo', ['rogue'] = 'corpo'})
    run(c, 12)
    local judy = snapshot(c)['judy-alvarez']
    local offer = c.homeOffer(world.bodies[judy.serial].entityID, {profileKey = 'judy-alvarez'})
    assert(offer and offer.available and offer.actor.key == 'judy-alvarez')
    local ids = {}
    for _, a in ipairs(offer.apartments) do ids[#ids + 1] = a.id end
    assert(table.concat(ids, ',') == 'h10,corpo', table.concat(ids, ','))
    assert(offer.here == 'corpo' and offer.lives.id == 'corpo' and offer.moveOut == true)
    assert(#offer.members == 2)
    for _, m in ipairs(offer.members) do assert(m.serial and m.id and m.key and m.name) end
    -- nobody who is not eligible gets the apartments, only the members
    local stranger = c.homeOffer('999ULL', {profileKey = 'nobody'})
    assert(stranger and #stranger.apartments == 0 and #stranger.members == 2 and stranger.moveOut == nil)
    -- no offer in a fight
    world.held = 'combat'
    assert(c.homeOffer('1ULL', {profileKey = 'judy-alvarez'}) == nil)
  `);
});

test('a group round offers the audience to recall or release, not the apartments', () => {
  lua(`${WORLD}
    local c = control({['judy-alvarez'] = 'corpo', ['rogue'] = 'corpo', ['panam-palmer'] = 'corpo', ['river-ward'] = 'corpo', ['kerry-eurodyne'] = 'corpo'})
    world.names = nil
    run(c, 20)
    local entity
    for _, b in pairs(world.bodies) do entity = b.entityID; break end
    local offer = c.groupOffer(entity, {profileKey = 'rogue'})
    assert(offer and #offer.apartments == 0 and offer.here == nil)
    assert(#offer.members >= 4, 'members ' .. #offer.members)
  `);
});

test('stay: a phone contact moves in, nothing is spawned, the registry fact is written, a flat V does not own is refused', () => {
  lua(`${WORLD}
    world.place = 'LittleChina_Street'
    local c = control({})
    local offer = c.homeOffer('1ULL', {profileKey = 'judy-alvarez'})
    assert(offer, 'no offer')
    local ok = c.queueHome({op = 'stay', apartment = 'glen'}, offer, '1ULL', 'r1')
    assert(ok == true)
    assert(c.homeOf('judy-alvarez') == 'glen')
    assert(values[registry.factName('judy-alvarez')] == 3)
    assert(world.spawned == nil, 'a body was made')
    assert(#world.notes == 1 and world.notes[1] == 'Judy moves into Heywood Glen.', world.notes[1])
    -- a flat that was not in the offer
    local refused, why = c.queueHome({op = 'stay', apartment = 'north'}, offer, '1ULL', 'r2')
    assert(refused == false)
    world.facts.dlc6_apart_wat_nid_purchased = 0
    local forged = {available = true, actor = {id = '1ULL', key = 'judy-alvarez'}, apartments = {{id = 'north', name = 'x'}}, members = {}}
    assert(c.queueHome({op = 'stay', apartment = 'north'}, forged, '1ULL', 'r3') == false)
    -- she can only live in one flat: moving house replaces it
    assert(c.queueHome({op = 'stay', apartment = 'h10'}, offer, '1ULL', 'r4') == true)
    assert(c.homeOf('judy-alvarez') == 'h10' and values[registry.factName('judy-alvarez')] == 1)
    -- the rows for the manager
    local rows = c.rows()
    assert(#rows == 1 and rows[1].apartmentName == 'Megabuilding H10' and rows[1].state == 'out')
  `);
});

test('stay: a party member told to stay in the flat V stands in is released into its routine', () => {
  lua(`${WORLD}${PARTY}
    local c = control({})
    local serial, entity = inParty('judy-alvarez')
    local offer = c.homeOffer(entity, {profileKey = 'judy-alvarez'})
    assert(offer.here == 'corpo')
    assert(c.queueHome({op = 'stay', apartment = 'corpo'}, offer, entity, 'r1') == true)
    assert(#world.released == 1 and world.released[1][1] == serial and world.released[1][2] == 'corpo')
    assert(world.homeOutfit['judy-alvarez'] == true)
    run(c, 15)
    local s = snapshot(c)['judy-alvarez']
    assert(s.state == 'at' and s.serial == serial, tostring(s.state))
    assert(world.spawned == nil, 'a second body was made for a party member who already has one')
    assert(world.homeOutfit['judy-alvarez'] == true)
  `);
});

test('stay: a party member told to stay in a flat V is not in goes there on her own, and is virtual until V comes', () => {
  lua(`${WORLD}${PARTY}
    local c = control({})
    local serial, entity = inParty('judy-alvarez')
    local offer = c.homeOffer(entity, {profileKey = 'judy-alvarez'})
    assert(c.queueHome({op = 'stay', apartment = 'h10'}, offer, entity, 'r1') == true)
    assert(#world.left == 1 and world.left[1] == serial, 'she was not sent away')
    assert(#world.released == 0)
    world.party[serial] = nil   -- she has gone
    run(c, 10)
    assert(snapshot(c)['judy-alvarez'].state == 'virtual')
    assert(world.spawned == nil, 'a body was made in the wrong flat')
  `);
});

test('rest in her own flat releases her, rest in another flat asks first and a yes sends her home only after the answer', () => {
  lua(`${WORLD}${PARTY}
    local c = control({['judy-alvarez'] = 'glen', ['panam-palmer'] = 'corpo'})
    local judy, judyEntity = inParty('judy-alvarez')
    local panam, panamEntity = inParty('panam-palmer')
    local leave = {available = true, actor = {id = judyEntity, key = 'judy-alvarez'}, members = {
      {serial = judy, id = judyEntity, key = 'judy-alvarez', name = 'Judy'}, {serial = panam, id = panamEntity, key = 'panam-palmer', name = 'Panam'}}}
    c.decorateLeave(leave)
    local judyRow, panamRow = leave.members[1], leave.members[2]
    assert(judyRow.away == true and judyRow.homeName == 'Heywood Glen' and judyRow.hereName == 'Corpo Plaza' and judyRow.confirmed == nil)
    assert(panamRow.away == nil, 'a housemate at home is not asked')
    -- the first answer: Panam rests, Judy is refused (she must ask)
    local split = c.splitLeave('all', leave)
    assert(#split.rest == 1 and split.rest[1].key == 'panam-palmer' and #split.refused == 1 and #split.depart == 0)
    -- the next turn: the question was asked, so the offer is confirmed
    local again = {available = true, actor = {id = judyEntity, key = 'judy-alvarez'}, members = {{serial = judy, id = judyEntity, key = 'judy-alvarez', name = 'Judy'}}}
    c.decorateLeave(again)
    assert(again.members[1].confirmed == true)
    local second = c.splitLeave(judyEntity, again)
    assert(#second.depart == 1 and #second.refused == 0)
    -- and the home offer of that turn carries the question so "here" can be chosen
    local offer = c.homeOffer(judyEntity, {profileKey = 'judy-alvarez'})
    assert(offer.asked and offer.asked.from == 'glen' and offer.asked.here == 'corpo')
    assert(c.queueHome({op = 'stay', apartment = 'corpo'}, offer, judyEntity, 'r5') == true)
    assert(c.homeOf('judy-alvarez') == 'corpo')
    -- the ask expires after ten minutes
    local other = control({['judy-alvarez'] = 'glen'})
    local x = {available = true, actor = {id = '1ULL', key = 'judy-alvarez'}, members = {{serial = 1, id = '1ULL', key = 'judy-alvarez', name = 'Judy'}}}
    other.decorateLeave(x)
    other.update(700)
    local y = {available = true, actor = {id = '1ULL', key = 'judy-alvarez'}, members = {{serial = 1, id = '1ULL', key = 'judy-alvarez', name = 'Judy'}}}
    other.decorateLeave(y)
    assert(y.members[1].confirmed == nil)
  `);
});

test('rest while V is on the street: the housemate just leaves, no question', () => {
  lua(`${WORLD}${PARTY}
    world.place = 'Watson_Street'
    local c = control({['judy-alvarez'] = 'glen'})
    local judy, entity = inParty('judy-alvarez')
    local leave = {available = true, actor = {id = entity, key = 'judy-alvarez'}, members = {{serial = judy, id = entity, key = 'judy-alvarez', name = 'Judy'}}}
    c.decorateLeave(leave)
    assert(leave.members[1].away == nil)
    local split = c.splitLeave('all', leave)
    assert(#split.depart == 1 and #split.rest == 0 and #split.refused == 0)
  `);
});

test('tag along: she gets up, joins the party on the same body, changes out of home clothes, and is not a resident until released', () => {
  lua(`${WORLD}
    local c = control({['judy-alvarez'] = 'corpo', ['rogue'] = 'corpo'})
    run(c, 15)
    local judy = snapshot(c)['judy-alvarez']
    local offer = c.homeOffer(world.bodies[judy.serial].entityID, {profileKey = 'rogue'})
    assert(#offer.members == 2, 'members ' .. #offer.members)
    local target
    for _, m in ipairs(offer.members) do if m.key == 'judy-alvarez' then target = m.id end end
    local okJoin, whyJoin = c.queueHome({op = 'join', target = target}, offer, 'x', 'r1')
    assert(okJoin == true, tostring(whyJoin) .. ' target=' .. tostring(target))
    run(c, 6)
    assert(world.joined[1] == judy.serial, 'she did not join')
    assert(snapshot(c)['judy-alvarez'].state == 'party')
    assert(world.homeOutfit['judy-alvarez'] == false)
    assert(snapshot(c)['rogue'].state == 'at', 'the other one was moved')
    -- everyone at once
    local fresh = c.homeOffer(world.bodies[snapshot(c)['rogue'].serial].entityID, {profileKey = 'rogue'})
    assert(c.queueHome({op = 'join', target = 'all'}, fresh, 'x', 'r2') == true)
    run(c, 6)
    assert(#world.joined == 2)
    -- all workspots she used were let go
    for _, h in ipairs(world.handles) do assert(h.state == 'released' or h.state == 'releasing') end
    -- a forged target is refused
    assert(c.queueHome({op = 'join', target = '999ULL'}, fresh, 'x', 'r3') == false)
  `);
});

test('a group release: the first speaker\'s choice reaches everyone addressed even when most of them never reply', () => {
  lua(`${WORLD}${PARTY}
    local c = control({['judy-alvarez'] = 'corpo', ['panam-palmer'] = 'corpo', ['rogue'] = 'corpo', ['river-ward'] = 'corpo', ['kerry-eurodyne'] = 'corpo'})
    local members = {}
    for _, key in ipairs({'judy-alvarez', 'panam-palmer', 'rogue', 'river-ward', 'kerry-eurodyne'}) do
      local serial, entity = inParty(key)
      members[#members + 1] = {serial = serial, id = entity, key = key, name = key}
    end
    local leave = {available = true, actor = {id = members[1].id, key = 'judy-alvarez'}, members = members}
    c.decorateLeave(leave)
    local split = c.splitLeave('all', leave)
    assert(#split.rest == 5 and #split.depart == 0 and #split.refused == 0)
    for _, m in ipairs(split.rest) do assert(c.restHere(m.serial, m.key)) end
    assert(#world.released == 5)
    run(c, 30)
    local at = 0
    for _, r in pairs(snapshot(c)) do if r.state == 'at' then at = at + 1 end end
    assert(at == 5, 'at ' .. at)
  `);
});

test('move out: the registry entry and the body go, the character stays as she is otherwise', () => {
  lua(`${WORLD}
    local c = control({['judy-alvarez'] = 'corpo'})
    run(c, 12)
    assert(count(world.bodies) == 1)
    local entity
    for _, b in pairs(world.bodies) do entity = b.entityID end
    local offer = c.homeOffer(entity, {profileKey = 'judy-alvarez'})
    assert(offer.moveOut == true)
    assert(c.queueHome({op = 'move-out'}, offer, entity, 'r1') == true)
    assert(c.homeOf('judy-alvarez') == nil and count(world.bodies) == 0)
    assert(values[registry.factName('judy-alvarez')] == 0)
    -- somebody who does not live there cannot move out
    assert(c.queueHome({op = 'move-out'}, offer, entity, 'r2') == false)
    assert(c.moveOut('judy-alvarez') == false)
  `);
});

test('the phone offer carries a one-use token, and the answer is checked against it', () => {
  lua(`${WORLD}
    world.place = 'Watson_Street'
    local c = control({})
    local offer = c.phoneOffer('judy-alvarez')
    assert(offer and offer.token:find('^home%-') and #offer.apartments == 3)
    assert(c.phoneAction('judy-alvarez', {action = 'stay', apartment = 'corpo', token = 'home-forged'}) == false)
    assert(c.phoneAction('judy-alvarez', {action = 'stay', apartment = 'corpo', token = offer.token}) == true)
    assert(c.homeOf('judy-alvarez') == 'corpo')
    -- one use
    assert(c.phoneAction('judy-alvarez', {action = 'move-out', token = offer.token}) == false)
    local again = c.phoneOffer('judy-alvarez')
    assert(again.moveOut == true and again.lives.id == 'corpo')
    assert(c.phoneOffer('nobody') == nil)
  `);
});

test('the turn note says where she lives, whether she is home, who else lives there, and that she has just moved in', () => {
  lua(`${WORLD}
    local c = control({['judy-alvarez'] = 'corpo', ['rogue'] = 'corpo'})
    local note = c.note('judy-alvarez')
    assert(note.apartment == 'Corpo Plaza' and note.atHome == true and note.others[1] == 'Rogue')
    assert(c.note('nobody') == nil)
    local offer = c.homeOffer('1ULL', {profileKey = 'panam-palmer'})
    c.queueHome({op = 'stay', apartment = 'corpo'}, offer, '1ULL', 'r1')
    assert(c.note('panam-palmer').moved == 'now')
    c.noted('panam-palmer'); c.noted('panam-palmer'); c.noted('panam-palmer')
    assert(c.note('panam-palmer').moved == nil)
  `);
});

test('V sits on a seat: it is learned, a housemate on it gets up and nobody is given it again', () => {
  lua(`${WORLD}
    world.data = {reservedFacts = {any = {}}, apartments = {corpo = {id = 'corpo', spots = {
      {id = 'a', kind = 'couch', x = 0, y = 0, z = 0, maybeV = true}, {id = 'b', kind = 'couch', x = 3, y = 0, z = 0},
    }}}}
    local c = control({['judy-alvarez'] = 'corpo'})
    run(c, 15)
    assert(snapshot(c)['judy-alvarez'].spot == 'b', tostring(snapshot(c)['judy-alvarez'].spot))
    c.learnV({x = 3.1, y = 0.1, z = 0}, {x = 0, y = 1}, 'couch')
    run(c, 30)
    local s = snapshot(c)['judy-alvarez']
    assert(s.spot ~= 'b', 'she stayed on V\\'s seat')
    assert(#c.learnedList() == 1)
    -- the same seat twice is one lesson
    c.learnV({x = 3.12, y = 0.1, z = 0}, {x = 0, y = 1}, 'couch')
    assert(#c.learnedList() == 1)
  `);
});

test('a fast travel keeps the registry and drops the bodies; a load drops both until the world is ready again', () => {
  lua(`${WORLD}
    local c = control({['judy-alvarez'] = 'corpo'})
    run(c, 12)
    c.reset('fast-travel', true)
    assert(c.homeOf('judy-alvarez') == 'corpo' and snapshot(c)['judy-alvarez'].state == 'virtual' and snapshot(c)['judy-alvarez'].serial == nil)
    c.reset('load', false)
    assert(c.homeOf('judy-alvarez') == nil and c.count() == 0)
  `);
});

test('a greeting when V comes home after a long absence, once, from someone close and awake', () => {
  lua(`${WORLD}
    local greeted = {}
    env.greet = function(info) greeted[#greeted + 1] = info; return true end
    local c = control({['judy-alvarez'] = 'corpo', ['rogue'] = 'corpo'})
    run(c, 20)
    assert(#greeted == 0, 'greeted on the first entry')
    world.place = 'Street'
    world.hours = world.hours
    run(c, 30)
    world.hours = world.hours + 9
    world.place = 'CorpoPlaza_Apartment'
    world.vpos = {x = -1602, y = 356, z = 49.2}
    run(c, 25)
    assert(#greeted == 1, 'greetings ' .. #greeted)
    assert(greeted[1].awayHours >= 9 and greeted[1].place == 'Corpo Plaza' and #greeted[1].others == 1)
    -- not again on the next short trip out and in
    world.place = 'Street'; run(c, 30); world.place = 'CorpoPlaza_Apartment'; run(c, 25)
    assert(#greeted == 1)
  `);
});

test('a scene fact holds the flat for the offer too: no offer of it, nobody leaves the party for it; a free-roaming V mid-quest can move someone in', () => {
  lua(`${WORLD}${PARTY}
    local c = control({})
    local serial, entity = inParty('panam-palmer')
    local function ids(offer) local out = {} for _, a in ipairs(offer.apartments) do out[#out + 1] = a.id end return table.concat(out, ',') end
    -- the persistent "the chain is active" flags are not a scene
    for _, name in ipairs({'mq055_02_active', 'mq055_02_downtown_active', 'web_apartment_website_start', 'dlc6_apart_cct_dtn_purchase'}) do
      world.facts[name] = 1
      local offer = c.homeOffer(entity, {profileKey = 'panam-palmer'})
      assert(offer.unavailable == nil and ids(offer) == 'h10,corpo,glen', name .. ' held the offer: ' .. ids(offer))
      world.facts[name] = 0
    end
    -- every scene fact of the shared list and of this flat: offer and hold agree
    local data = world.data.reservedFacts
    for _, list in ipairs({data.any, data.corpo}) do
      for _, name in ipairs(list) do
        world.facts[name] = 1
        local offer = c.homeOffer(entity, {profileKey = 'panam-palmer'})
        assert(offer.unavailable == 'quest-reserved' and ids(offer) == 'h10,glen', name .. ': ' .. ids(offer))
        local ok = c.queueHome({op = 'stay', apartment = 'corpo'}, {actor = {key = 'panam-palmer'}, apartments = {{id = 'corpo'}}}, entity, 'r')
        assert(ok == false and c.homeOf('panam-palmer') == nil and world.party[serial], name .. ' took her out of the party')
        world.facts[name] = 0
      end
    end
    -- facts of another flat do not hold this one
    for _, name in ipairs(data.h10) do
      world.facts[name] = 1
      assert(c.homeOffer(entity, {profileKey = 'panam-palmer'}).unavailable == nil, name)
      world.facts[name] = 0
    end
    -- with only the chain flag set she moves in and is released into the flat (not held)
    world.facts['mq055_02_active'] = 1
    local offer = c.homeOffer(entity, {profileKey = 'panam-palmer'})
    assert(c.queueHome({op = 'stay', apartment = 'corpo'}, offer, entity, 'r2') == true and c.homeOf('panam-palmer') == 'corpo')
  `);
});

test('the hold-facts probe line is written once per change', () => {
  lua(`${WORLD}
    local c = control({['judy-alvarez'] = 'corpo'})
    run(c, 12)
    local function lines() local n, last = 0, nil for _, l in ipairs(world.logs) do if l:find('Housemates hold-facts', 1, true) then n = n + 1; last = l end end return n, last end
    local n, last = lines()
    assert(n == 1 and last == 'Housemates hold-facts apt=corpo facts=-', tostring(last))
    run(c, 10); assert(lines() == 1)
    world.facts['mq055_04_intimate_action_on'] = 1
    run(c, 4)
    n, last = lines()
    assert(n == 2 and last == 'Housemates hold-facts apt=corpo facts=mq055_04_intimate_action_on', tostring(last))
  `);
});
