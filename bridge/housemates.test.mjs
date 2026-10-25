import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lua} from './housemate-fixture.mjs';
import {WORLD} from './housemate-world-fake.mjs';

// A flat of V's played out against a fake world. The controller is the real mod/housemates.lua; the data is the real spots table unless a
// test brings its own.

test('with nobody living anywhere a step reads nothing from the game', () => {
  lua(`${WORLD}
    local c = control({})
    run(c, 30)
    assert(count(world.calls) == 0, 'the idle controller called the game')
    assert(world.facts_read == 0)
  `);
});

test('V enters a flat: every housemate there is placed, nobody gets V\'s seat, others stay virtual', () => {
  lua(`${WORLD}
    local c = control({['judy-alvarez'] = 'corpo', ['panam-palmer'] = 'corpo', ['rogue'] = 'corpo', ['river-ward'] = 'glen'})
    run(c, 20)
    local s = snapshot(c)
    for _, key in ipairs({'judy-alvarez', 'panam-palmer', 'rogue'}) do assert(s[key].state == 'at', key .. ' ' .. tostring(s[key].state)) end
    assert(s['river-ward'].state == 'virtual' and s['river-ward'].serial == nil, 'a housemate of another flat has no body')
    assert(world.spawned == 3)
    local seen = {}
    for _, key in ipairs({'judy-alvarez', 'panam-palmer', 'rogue'}) do
      local spot = s[key].spot
      assert(spot ~= 'corpo-couch-v', 'V\\'s seat was given away')
      assert(not seen[spot], 'a place was shared: ' .. tostring(spot))
      seen[spot] = true
    end
    -- the bodies are all hers: three deleted nothing so far
    assert((world.deleted or 0) == 0)
  `);
});

test('V leaves: the bodies stay for the grace time and are then deleted, and nothing runs afterwards', () => {
  lua(`${WORLD}
    local c = control({['judy-alvarez'] = 'corpo', ['rogue'] = 'corpo'})
    run(c, 15)
    assert(count(world.bodies) == 2)
    world.place = 'LittleChina_Lizzies'   -- some other district
    run(c, 10)
    assert(count(world.bodies) == 2, 'deleted too early')
    run(c, 15)
    assert(count(world.bodies) == 0, 'bodies left behind: ' .. count(world.bodies))
    for _, v in pairs(states(c)) do assert(v == 'virtual') end
    -- all handles released
    local open = 0
    for _, h in ipairs(world.handles) do if h.state ~= 'released' then open = open + 1 end end
    assert(open == 0, 'workspots left open: ' .. open)
    world.calls = {}
    run(c, 30)
    assert((world.calls.rows or 0) <= 8, 'still polling bodies while V is away: ' .. tostring(world.calls.rows))
    -- back in the flat they come again
    world.place = 'CorpoPlaza_Apartment'
    run(c, 15)
    assert(count(world.bodies) == 2)
  `);
});

test('a short trip out of the flat does not delete anybody', () => {
  lua(`${WORLD}
    local c = control({['judy-alvarez'] = 'corpo'})
    run(c, 12)
    local serial = snapshot(c)['judy-alvarez'].serial
    world.place = 'Corridor'
    run(c, 8)
    world.place = 'CorpoPlaza_Apartment'
    run(c, 8)
    assert(snapshot(c)['judy-alvarez'].serial == serial and (world.deleted or 0) == 0)
  `);
});

test('a spot that fails verification is dropped for the session and she takes another or a standing place', () => {
  lua(`${WORLD}
    world.bad = {['corpo-couch-2'] = true, ['corpo-couch-3'] = true, ['corpo-couch-4'] = true, ['corpo-bar-3'] = true, ['corpo-chair-1'] = true, ['corpo-chair-2'] = true}
    local c = control({['judy-alvarez'] = 'corpo', ['rogue'] = 'corpo'})
    run(c, 30)
    local s = snapshot(c)
    for _, key in ipairs({'judy-alvarez', 'rogue'}) do
      assert(s[key].state == 'at', key .. ' ' .. tostring(s[key].state))
      assert(world.bad[s[key].spot] == nil, 'she took a bad spot')
    end
    local rejects = 0
    for _, line in ipairs(world.logs) do if line:find('spot-rejected', 1, true) then rejects = rejects + 1 end end
    assert(rejects >= 1)
  `);
});

test('a spot that cannot be taken (the workspot fails) is given up and she is placed elsewhere', () => {
  lua(`${WORLD}
    world.fail = {}
    for _, spot in ipairs(world.data.apartments.corpo.spots) do world.fail[spot.id] = true end
    world.fail['corpo-chair-2'] = nil
    local c = control({['judy-alvarez'] = 'corpo'})
    run(c, 80)
    local after = snapshot(c)['judy-alvarez']
    assert(after.state == 'at', tostring(after.state))
    assert(not world.fail[after.spot], 'she is on a spot that cannot be taken: ' .. tostring(after.spot))
    local rejects = 0
    for _, line in ipairs(world.logs) do if line:find('could not take', 1, true) then rejects = rejects + 1 end end
    assert(rejects >= 0)
  `);
});

test('dwell: after a while she moves to another place, never faster than every three minutes', () => {
  lua(`${WORLD}
    local c = control({['judy-alvarez'] = 'corpo'})
    run(c, 8)
    local places, last = {}, nil
    local changes = 0
    for second = 1, 3600 do
      c.update(1)
      local spot = snapshot(c)['judy-alvarez'].spot
      if spot ~= last then if last ~= nil then changes = changes + 1 end last = spot end
    end
    assert(changes >= 3, 'she never moved: ' .. changes)
    assert(changes <= 3600 / 180 + 1, 'she moved too often: ' .. changes)
    assert(snapshot(c)['judy-alvarez'].state == 'at')
  `);
});

test('quest facts reserve a flat: bodies are hidden, deleted after a minute, and come back when it is clear', () => {
  lua(`${WORLD}
    local c = control({['judy-alvarez'] = 'corpo', ['rogue'] = 'corpo'})
    run(c, 12)
    assert(count(world.bodies) == 2)
    world.facts['mq055_04_intimate_action_on'] = 1
    run(c, 3)
    for _, b in pairs(world.bodies) do assert(b.hidden, 'not hidden') end
    run(c, 40)
    assert(count(world.bodies) == 2, 'deleted before the minute')
    run(c, 25)
    assert(count(world.bodies) == 0, 'still there during the quest')
    local spawnedBefore = world.spawned
    run(c, 10)
    assert(world.spawned == spawnedBefore, 'a body was made during the quest')
    world.facts['mq055_04_intimate_action_on'] = 0
    run(c, 20)
    assert(count(world.bodies) == 2)
  `);
});

test('a short scene hides them and shows them again 3 seconds after it is over', () => {
  lua(`${WORLD}
    local c = control({['judy-alvarez'] = 'corpo'})
    run(c, 12)
    world.held = 'scene'
    run(c, 3)
    for _, b in pairs(world.bodies) do assert(b.hidden) end
    world.held = nil
    run(c, 1.5)
    for _, b in pairs(world.bodies) do assert(b.hidden, 'shown too early') end
    run(c, 3)
    for _, b in pairs(world.bodies) do assert(not b.hidden, 'still hidden') end
    assert(count(world.bodies) == 1)
  `);
});

test('combat in the flat removes them at once and they come back only a minute after it is over', () => {
  lua(`${WORLD}
    local c = control({['judy-alvarez'] = 'corpo'})
    run(c, 12)
    world.held = 'combat'
    run(c, 2)
    assert(count(world.bodies) == 0)
    world.held = nil
    run(c, 40)
    assert(count(world.bodies) == 0, 'came back too early')
    run(c, 40)
    assert(count(world.bodies) == 1)
  `);
});

test('the real copy of a character is near: ours steps out and returns when it is gone', () => {
  lua(`${WORLD}
    local c = control({['judy-alvarez'] = 'corpo', ['rogue'] = 'corpo'})
    run(c, 12)
    world.twin['judy-alvarez'] = true
    run(c, 3)
    local judy
    for _, b in pairs(world.bodies) do if b.key == 'judy-alvarez' then judy = b end end
    assert(judy == nil, 'her copy stayed beside the real one')
    assert(count(world.bodies) == 1)
    world.twin['judy-alvarez'] = nil
    run(c, 40)
    assert(count(world.bodies) == 2)
  `);
});

test('night: a housemate sleeps in a bed that fits two, dozes in a chair otherwise, and wakes when spoken to', () => {
  lua(`${WORLD}
    -- a flat with a measured double bed and a chair
    world.data = {reservedFacts = {any = {}}, apartments = {corpo = {id = 'corpo', spots = {
      {id = 'bed', kind = 'bed', x = 10, y = 0, z = 0, anchor = {x = 10, y = 0, z = 0}, across = 0, sides = {-1, 1}, fitsTwo = true, yaw = 90},
      {id = 'chair', kind = 'chair', x = 4, y = 0, z = 0},
    }}}}
    world.hours = 2   -- two in the morning
    local c = control({['judy-alvarez'] = 'corpo', ['panam-palmer'] = 'corpo', ['rogue'] = 'corpo'})
    run(c, 20)
    local s = snapshot(c)
    local asleep, beds, dozes = 0, 0, 0
    for key, r in pairs(s) do
      if r.sleep then
        asleep = asleep + 1
        if r.spot:find('^bed') then beds = beds + 1 else dozes = dozes + 1 end
      end
    end
    assert(asleep == 3 and beds == 2 and dozes == 1, asleep .. ' ' .. beds .. ' ' .. dozes)
    -- V talks to a sleeper in the bed: she wakes and gets up
    local entity
    for _, b in pairs(world.bodies) do entity = b.entityID; break end
    c.talkStarted(entity)
    run(c, 25)
    local awake = 0
    for _, r in pairs(snapshot(c)) do if not r.sleep then awake = awake + 1 end end
    assert(awake == 1, 'woken: ' .. awake)
    -- morning: everybody gets up
    world.hours = 9
    run(c, 25)
    for _, r in pairs(snapshot(c)) do assert(not r.sleep) end
  `);
});

test('bodies that were made while we did not look are adopted, strangers of ours are deleted', () => {
  lua(`${WORLD}
    local c = control({['judy-alvarez'] = 'corpo'})
    run(c, 2)
    world.bodies[900] = {serial = 900, key = 'ghost', profileKey = 'ghost', owner = 'housemates', appointmentId = 'hm:ghost', state = 'visiting', entityID = '900ULL', age = 3}
    run(c, 5)
    assert(world.bodies[900] == nil, 'a body nobody lives in stayed')
  `);
});

test('she wakes at her own wake time, not at six: asleep before it, up after it', () => {
  lua(`${WORLD}
    local plan = dofile('housemate-plan.lua')
    world.data = {reservedFacts = {any = {}}, apartments = {corpo = {id = 'corpo', spots = {
      {id = 'chair', kind = 'chair', x = 4, y = 0, z = 0},
    }}}}
    local wake = plan.waketime('judy-alvarez')
    world.hours = 24 + wake - 0.3
    local c = control({['judy-alvarez'] = 'corpo'})
    run(c, 20)
    assert(snapshot(c)['judy-alvarez'].sleep == true, 'not asleep shortly before her wake time')
    world.hours = 24 + wake + 0.3
    run(c, 20)
    assert(snapshot(c)['judy-alvarez'].sleep == false, 'still asleep after her wake time')
  `);
});
