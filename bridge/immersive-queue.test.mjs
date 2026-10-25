import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, managerFixture, queueSource} from './manager-fixture.mjs';

// The party queue (mod/manager-party.lua) under an immersive-invitation appointment: a quiet job whose gate holds the spawn, hidden from the
// party list (the controller shows its own row), handed to the spawn with its appointment, cancelled without a copy ever being made.
test('an appointment job is hidden from the list, waits for its gate, spawns with its appointment and is gone from the queue afterwards', () => {
  run(`${managerFixture}
    manager.configure(api, profiles)
    local original, seen = api.spawn, nil
    api.spawn = function(key, job) seen = job; return original(key) end
    local queue = (function() ${queueSource} end)().new(api)
    queue.bind('player-1')
    local open = false
    local ok, _, id = queue.invite('johnny-silverhand', {quiet = true, appointment = {id = 5}, gate = function() return open end})
    assert(ok and id, 'the invitation is accepted')
    assert(#queue.list() == 0, 'the appointment shows as its own row, not as an invitation being prepared')
    assert(queue.hasJob(id) and queue.count() == 1)
    queue.flush(); queue.flush()
    assert(#spawned == 0 and queue.hasJob(id), 'a closed gate holds the spawn')
    open = true; queue.flush()
    assert(#spawned == 1 and seen.appointment.id == 5 and seen.quiet == true)
    assert(not queue.hasJob(id), 'a spawned job is no longer a job')
    assert(#queue.list() == 1, 'her copy is a party member now')
  `);
});

test('cancelling an appointment job removes it before any copy is made; an unknown id says so', () => {
  run(`${managerFixture}
    manager.configure(api, profiles)
    local queue = (function() ${queueSource} end)().new(api)
    queue.bind('player-1')
    local ok, _, id = queue.invite('johnny-silverhand', {quiet = true, appointment = {id = 6}, gate = function() return true end})
    assert(queue.hasJob(id))
    assert(queue.cancelJob(id) == true)
    assert(not queue.hasJob(id) and queue.count() == 0)
    queue.flush()
    assert(#spawned == 0, 'nothing was created')
    assert(queue.cancelJob(id) == false and queue.cancelJob('nope') == false)
    -- an ordinary invitation is still listed and cancelled by the old call
    local ordinary, _, plain = queue.invite('johnny-silverhand')
    assert(#queue.list() == 1 and not queue.hasJob('nope'))
    assert(queue.dismiss(plain))
  `);
});

test('a gate that cancels (nil and a reason) ends the job with the reason, as for an adopted character', () => {
  run(`${managerFixture}
    manager.configure(api, profiles)
    local queue = (function() ${queueSource} end)().new(api)
    queue.bind('player-1')
    local ok, _, id = queue.invite('johnny-silverhand', {quiet = true, appointment = {id = 7}, gate = function() return nil, 'cancelled' end})
    queue.flush()
    assert(#spawned == 0 and not queue.hasJob(id))
  `);
});

// probe.log 2026-10-25: a housemate's body that the game refused ("Scenery or a vehicle is blocking the companion position") was tried again every
// 77 seconds, and every try said "could not join" again. A resident's failure is shown once per character and reason.
test('a housemate body that cannot be made says so once per reason, however often it is tried again; an ordinary invitation says it every time', () => {
  run(`${managerFixture}
    manager.configure(api, profiles)
    api.spawn = function(key, job) return nil, 'Scenery or a vehicle is blocking the companion position.' end
    local queue = (function() ${queueSource} end)().new(api)
    queue.bind('player-1')
    local function attempt(extra)
      local ok, _, id = queue.invite('johnny-silverhand', extra)
      assert(ok and id)
      queue.flush(); queue.flush()
      local shown = {}
      for _, notice in ipairs(queue.takeNotices()) do if notice.id == 'party-failed' then shown[#shown + 1] = notice.message end end
      return shown
    end
    local resident = {quiet = true, resident = true, appointment = {id = 'hm:johnny-silverhand', position = {x = 0, y = 0, z = 0}, owner = 'housemates', home = 'corpo'}}
    local first = attempt(resident)
    assert(#first == 1 and first[1]:find('could not join', 1, true) and first[1]:find('blocking the companion position', 1, true), tostring(first[1]))
    for _ = 1, 3 do assert(#attempt(resident) == 0, 'the same failure was said again') end
    assert(queue.message():find('could not join', 1, true), 'the menu line still says it')
    -- another reason is another cause
    api.spawn = function(key, job) return nil, 'The game could not verify companion body clearance.' end
    assert(#attempt(resident) == 1)
    assert(#attempt(resident) == 0)
    -- a player's own invitation is always told
    assert(#attempt({}) == 1 and #attempt({}) == 1)
  `);
});
