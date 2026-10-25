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
