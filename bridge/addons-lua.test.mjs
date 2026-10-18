import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LUA_HARNESS, WORLD, runLua} from './addon-lua-harness.mjs';

// The game side of the add-on API (mod/addons.lua): registration, speakers, the remark scheduler, events, settings and the
// main mod seams in init.lua, speech.lua, subtitles.lua, group-chat.lua and mcm.lua.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

const run = runLua;

test('loading the module touches nothing: no file, no global, not live, and the public API is ready for GetMod', () => {
  run(`
    assert(#opened == 0, 'a file was opened at load: ' .. tostring(opened[1]))
    assert(M.live == false)
    assert(M.public.version == '1.0' and M.public.major == 1 and M.public.minor == 0)
    assert(M.public.compatible('1.0') and not M.public.compatible('1.1') and not M.public.compatible('2.0') and not M.public.compatible(nil))
    assert(#M.talkCandidates({}, false) == 0 and M.isSpeaker('addon-x-y') == false)
    assert(#M.settingsSections() == 0 and M.signature() == '')
    M.reset('load')                      -- inert before any registration
    M.tick(nil, 0.1, true)               -- no host: nothing happens
    assert(#opened == 0)
    assert(convaiAddons == nil, 'the module never sets a global itself')
  `);
});

test('an add-on written for a newer API is refused with one notice for the player', () => {
  run(`${WORLD}
    M.attach(host)
    local handle, reason = M.public.register({id = 'skippy', name = 'Skippy', version = '1.2.0', requires = '1.4'})
    assert(handle == nil and reason:find('needs add%-on API 1.4'), tostring(reason))
    assert(M.live == true, 'live so the notice can be shown')
    tick(); tick()
    assert(#notices == 1 and notices[1] == 'Skippy needs a newer AI NPC Cyberpunk Mod (add-on API 1.4; this version has 1.0). Update AI NPC Cyberpunk Mod.', notices[1])
    assert(select(2, M.public.register({id = 'Bad Id', name = 'x', requires = '1.0'})) == 'invalid id')
    assert(select(2, M.public.register({id = 'ok', requires = '1.0'})) == 'name is required')
  `);
});

test('a proactive remark: queued, written as an automatic request with a lease, delivered, heard and released', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    local key = handle:speaker({id = 'gun', name = 'Skippy', anchor = 'player', minGap = 5})
    assert(key == 'addon-skippy-gun' and M.isSpeaker(key))
    assert(handle:setContext('gun', 'mode', 'Puppy-Loving Pacifist mode.'))
    local events = {}
    for _, name in ipairs({'remarkStarted', 'remarkFinished', 'turnStarted', 'turnEnded'}) do
        handle:on(name, function(payload) events[#events + 1] = name end)
    end
    assert(handle:remark('gun', {event = 'kill', text = 'V took down an enemy.', facts = {enemies = 2}, priority = 3, maxWords = 9}))
    tick()
    assert(#submitted == 1, 'one request')
    local context = submitted[1].context
    assert(submitted[1].anchor == player)
    assert(context.voiceOnly == true and context.profileKey == key and context.entity == '77ULL' and context.name == 'Skippy')
    assert(context.reaction.kind == 'addon' and context.reaction.addon == 'skippy' and context.reaction.speaker == 'gun'
        and context.reaction.event == 'kill' and context.reaction.priority == 3 and context.reaction.expiresAt > now * 1000)
    assert(context.addon.event == 'kill' and context.addon.maxWords == 9 and context.addon.facts.enemies == 2)
    assert(context.addon.blocks[1].key == 'mode' and context.addon.blocks[1].text == 'Puppy-Loving Pacifist mode.')
    assert(context.requestId == tostring(now) .. '-1-77ULL')
    local first = lease()
    assert(first.requestId == context.requestId and first.valid == true and first.updated == now * 1000)
    -- Waiting for the reply: the lease is refreshed about once a second.
    tick(); now = now + 1; tick(1)
    assert(M.canDeliver(context, player) == true)
    -- Heard: the main mod's speech owns the request now.
    state.pendingId, state.speechId = nil, context.requestId
    tick()
    assert(lease().playbackStartedAt == now * 1000)
    state.speechId = nil
    tick()
    assert(M._test.flight() == nil)
    assert(lease().valid == false, 'the finished remark invalidates its lease')
    assert(#dropped == 0, 'a finished remark stops nothing')
    assert(table.concat(events, ',') == 'turnStarted,remarkStarted,turnEnded,remarkFinished', table.concat(events, ','))
    -- The speaker's own gap holds the next remark back.
    assert(select(2, handle:remark('gun', {event = 'kill'})) == 'speaker-cooldown')
  `);
});

test('the exchange files (addon-state.json, reaction-lease.json) are written in place, the saved settings keep their protected swap', () => {
  run(`${WORLD}
    M.attach(host)
    local removed, renamed = {}, {}
    local remove, rename = os.remove, os.rename
    os.remove = function(path) removed[#removed + 1] = path; return remove(path) end
    os.rename = function(from, to) renamed[#renamed + 1] = from .. '>' .. to; return rename(from, to) end
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'gun', name = 'Skippy', anchor = 'player', minGap = 5})
    assert(handle:setCompanionContext('ride', 'You are riding in a cab.'))
    assert(handle:remark('gun', {event = 'kill', text = 'V took down an enemy.', priority = 3}))
    tick(); now = now + 1; tick(1)
    assert(files['runtime/addon-state.json'] ~= nil and files['runtime/reaction-lease.json'] ~= nil)
    for _, entry in ipairs(opened) do
      if entry:find('wb ', 1, true) == 1 then
        assert(not entry:find('.tmp', 1, true) and not entry:find('.previous', 1, true), 'a side file was written: ' .. entry)
      end
    end
    assert(#removed == 0 and #renamed == 0, 'an exchange file was removed or swapped: ' .. table.concat(removed, ',') .. '|' .. table.concat(renamed, ','))
    -- The player's saved settings are state, not an exchange file: they keep the temporary file and the swap.
    handle:settings({title = 'Skippy', items = {{id = 'remarks', label = 'Combat remarks', kind = 'bool', default = true}}})
    assert(M.stageSetting('addon:skippy:remarks', false) and M.commitSettings())
    assert(files['runtime/addon-settings.json'] ~= nil and files['runtime/addon-settings.json.tmp'] == nil)
    assert(#removed == 1 and removed[1] == 'runtime/addon-settings.json' and renamed[1] == 'runtime/addon-settings.json.tmp>runtime/addon-settings.json',
      table.concat(removed, ',') .. '|' .. table.concat(renamed, ','))
  `);
});

test('remarkStarted carries the reply text of the remark that is heard, and no other', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'gun', name = 'Skippy', anchor = 'player', minGap = 2})
    local started = {}
    handle:on('remarkStarted', function(payload) started[#started + 1] = payload end)
    assert(handle:remark('gun', {event = 'kill', priority = 3}))
    tick()
    local context = submitted[1].context
    -- A stale or foreign context is ignored; the right one keeps the text (control letters cleaned, at most 400 letters).
    M.replyText({requestId = 'other'}, 'not this one')
    M.replyText(context, 'Headshot.\\1 Textbook.' .. string.rep('!', 600))
    assert(M.canDeliver(context, player) == true)
    state.pendingId, state.speechId = nil, context.requestId
    tick()
    assert(#started == 1 and started[1].event == 'kill' and started[1].speaker == 'gun')
    assert(started[1].text:sub(1, 21) == 'Headshot.  Textbook.!' and #started[1].text == 400, tostring(started[1].text))
    state.speechId = nil
    tick()
    -- The next remark starts without the old text.
    now = now + 20; tick(10)
    assert(handle:remark('gun', {event = 'kill', priority = 3}))
    tick()
    local second = submitted[2].context
    assert(M.canDeliver(second, player) == true)
    state.pendingId, state.speechId = nil, second.requestId
    tick()
    assert(#started == 2 and started[2].text == nil, 'a remark whose reply text was not reported has none')
    M.replyText(nil, 'x'); M.replyText(second, 42)
  `);
});

test('a reply the game accepts says "playing" in the lease at once, and the deadline allows for whole-second os.time()', () => {
  // probe.log 2026-10-14: companion-kill was played and released in the same second; the bridge cut it ("Continuous speech owner
  // changed") because its lease still had no playback time when the request's deadline passed.
  run(`${WORLD}
    -- The lease is an exchange file that ships as a placeholder (Mod Organizer 2): rewritten in place, never renamed over or removed.
    local fileMoves = {}
    local realRemove, realRename = os.remove, os.rename
    os.remove = function(path) fileMoves[#fileMoves + 1] = 'remove ' .. path; return realRemove(path) end
    os.rename = function(from, to) fileMoves[#fileMoves + 1] = 'rename ' .. from .. ' ' .. to; return realRename(from, to) end
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'gun', name = 'Skippy', anchor = 'player', minGap = 2})
    -- A remark that waited most of its ttl: 0.3 s left when it is sent.
    assert(handle:remark('gun', {event = 'companion-kill', priority = 2, ttl = 3}))
    M.tick(player, 2.7, true)
    assert(#submitted == 1)
    local context = submitted[1].context
    assert(context.reaction.expiresAt == (now + 1 + 1) * 1000,
        'the 1 s floor plus a second for the whole-second clock: ' .. tostring(context.reaction.expiresAt))
    -- The reply arrives and the game takes it: the lease says playing before any tick.
    now = now + 1
    assert(M.canDeliver(context, player) == true)
    local accepted = lease()
    assert(accepted.valid == true and accepted.requestId == context.requestId and accepted.playbackStartedAt == now * 1000)
    assert(accepted.playbackStartedAt <= context.reaction.expiresAt, 'the bridge reads it as playing')
    -- The voice starts on the next tick: no second write of the same playback time.
    local writes = 0
    for _, entry in ipairs(opened) do if entry == 'wb runtime/reaction-lease.json' then writes = writes + 1 end end
    state.pendingId, state.speechId = nil, context.requestId
    now = now + 1
    tick()
    local after = 0
    for _, entry in ipairs(opened) do if entry == 'wb runtime/reaction-lease.json' then after = after + 1 end end
    assert(lease().playbackStartedAt == (now - 1) * 1000, 'the playback time is the moment it was accepted')
    assert(after - writes <= 1, 'at most the regular refresh')
    assert(writes >= 1, 'the lease was written in place')
    for _, move in ipairs(fileMoves) do assert(not move:find('reaction-lease', 1, true), move) end
    for _, entry in ipairs(opened) do assert(not entry:find('reaction-lease.json.tmp', 1, true), entry) end
  `);
});

test('a remark whose voice stopped early says why in its release line; one heard to its end does not', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'gun', name = 'Skippy', anchor = 'player', minGap = 0})
    local function play(stop, err)
        tick(20)
        assert(handle:remark('gun', {event = 'kill', priority = 3}))
        tick(3)
        local context = submitted[#submitted].context
        assert(M.canDeliver(context, player))
        state.pendingId, state.speechId = nil, context.requestId
        tick()
        state.speechId, state.speechStop, state.speechError = nil, stop, err
        tick()
        state.speechStop, state.speechError = nil, nil
        return logs[#logs]
    end
    local cut = play('playback-failed', 'Continuous playback cancelled')
    assert(cut:find('reason=finished spoken=true voice%-stopped=playback%-failed %(Continuous playback cancelled%)'), cut)
    local heard = play('finished', nil)
    assert(heard:find('reason=finished spoken=true$'), heard)
  `);
});

test('voiceFrom: a speaker can be heard from its own object; only an attached one counts, and a bad definition is refused', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    assert(select(2, handle:speaker({id = 'bad', name = 'Bad', voiceFrom = 'gun'})) == 'voiceFrom must be a function')
    local gun = {attached = true}
    function gun:IsAttached() return self.attached end
    local asked = nil
    local key = handle:speaker({id = 'gun', name = 'Skippy', anchor = 'player', voiceFrom = function(p) asked = p; return gun end})
    local plain = handle:speaker({id = 'plain', name = 'Plain', anchor = 'player'})
    assert(M.voiceSource(key, player) == gun and asked == player)
    gun.attached = false
    assert(M.voiceSource(key, player) == nil)
    assert(M.voiceSource(plain, player) == nil and M.voiceSource('addon-x-y', player) == nil and M.voiceSource(key, nil) == nil)
    handle:speaker({id = 'boom', name = 'Boom', voiceFrom = function() error('no weapon') end})
    assert(M.voiceSource('addon-skippy-boom', player) == nil)
  `);
});

test('arbitration: nothing is submitted while anything else talks, a manual turn wins, and a scene or a lost anchor stops a remark', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'cab', name = 'Delamain', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'voice', name = 'Delamain', anchor = 'vehicle', minGap = 2})
    local dropReasons = {}
    handle:on('remarkDropped', function(payload) dropReasons[#dropReasons + 1] = payload.reason end)
    -- Not in a car: the anchor is missing.
    handle:remark('voice', {event = 'greet', ttl = 10})
    tick()
    assert(#submitted == 0 and dropReasons[1] == 'speaker-unavailable', tostring(dropReasons[1]))
    player.vehicle = car
    for _, busy in ipairs({'active', 'microphone', 'group', 'phone', 'automatic', 'speechId', 'captions'}) do
        state[busy] = true
        handle:remark('voice', {event = 'greet', ttl = 10})
        tick()
        assert(#submitted == 0, busy .. ' did not hold the remark back')
        state[busy] = nil
    end
    -- Two seconds of quiet after any speech.
    state.speechId = 'other'; tick(); state.speechId = nil; tick()
    assert(#submitted == 0, 'the quiet gap after speech')
    tick(2)
    assert(#submitted == 1 and submitted[1].context.entity == '88ULL')
    -- The player starts a conversation: the remark is withdrawn at once.
    state.active = true
    tick()
    assert(dropped[1].reason == 'manual-priority' and dropped[1].requestId == submitted[1].context.requestId and dropped[1].entity == '88ULL')
    assert(lease().valid == false)
    state.active = nil
    -- A game scene drops waiting remarks and stops one in flight.
    tick(3)
    handle:remark('voice', {event = 'greet2'})
    state.sample = {available = true, tier = 1, dialogue = true}
    tick()
    assert(dropReasons[#dropReasons] == 'scene', dropReasons[#dropReasons])
    state.sample = {available = true, tier = 1}
    tick(3)
    handle:remark('voice', {event = 'greet3'})
    tick()
    assert(#submitted == 2)
    player.vehicle = nil
    assert(M.canDeliver(submitted[2].context, player) == false, 'the anchor changed before playback')
    assert(dropped[#dropped].reason == 'speaker-unavailable' or dropped[#dropped].reason == 'anchor-changed')
    -- An expired remark is dropped, never played late.
    player.vehicle = car
    tick(3)
    state.speechId = 'other'
    handle:remark('voice', {event = 'late', ttl = 1})
    tick(1.5)
    assert(dropReasons[#dropReasons] == 'expired', dropReasons[#dropReasons])
  `);
});

test('patience: a remark waits out a game scene or dialogue line and goes after a short gap if it still fits; one without patience is dropped as before', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'cab', name = 'Delamain', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'voice', name = 'Delamain', anchor = 'vehicle', minGap = 2})
    player.vehicle = car
    local dropReasons = {}
    handle:on('remarkDropped', function(payload) dropReasons[#dropReasons + 1] = payload.event .. ':' .. payload.reason end)
    -- No scene, no wait: the remark goes at once.
    assert(handle:remark('voice', {event = 'quiet', patience = 20})); tick()
    assert(#submitted == 1 and submitted[1].context.addon.event == 'quiet')
    state.pendingId = nil; tick(); tick(5)
    -- A scene is on: the patient remark is kept (its ttl does not run down meanwhile), the hasty one is dropped.
    state.sample = {available = true, tier = 1, dialogue = true}
    assert(handle:remark('voice', {event = 'patient', ttl = 3, patience = 20}))
    tick(); tick(5); tick(5)
    assert(#submitted == 1 and #M._test.queue() == 1, 'still waiting after 10 s although its ttl is 3 s')
    assert(handle:remark('voice', {event = 'hasty', ttl = 3, priority = 5}))
    tick()
    assert(dropReasons[#dropReasons] == 'hasty:scene', tostring(dropReasons[#dropReasons]))
    -- The scene ends: a gap of 1.2 s of quiet first, then it goes with a fresh clock.
    state.sample = {available = true, tier = 1}
    tick(0.5); tick(0.5)
    assert(#submitted == 1)
    tick(0.5); tick(0.5)
    assert(#submitted == 2 and submitted[2].context.addon.event == 'patient', 'sent after the gap')
    assert(submitted[2].context.reaction.expiresAt > os.time() * 1000, 'its ttl starts when it is sent')
    local started
    for _, line in ipairs(logs) do if line:find('Remark: ', 1, true) and line:find('event=patient', 1, true) then started = line end end
    assert(started and started:find('waited=1', 1, true), tostring(started))
    -- A scene that starts again during the gap restarts the gap.
    state.pendingId = nil; tick(); tick(10)
    state.sample = {available = true, tier = 3, dialogue = true}
    assert(handle:remark('voice', {event = 'again', patience = 20})); tick()
    state.sample = {available = true, tier = 1}; tick(1)
    state.sample = {available = true, tier = 3, choices = true}; tick(1)
    state.sample = {available = true, tier = 1}; tick(1); tick(0.1)
    assert(#submitted == 2, 'the gap starts over')
    tick(1.2)
    assert(#submitted == 3 and submitted[3].context.addon.event == 'again')
  `);
});

test('patience: a remark whose moment has passed (relevant says no) is dropped, and one that waited past its patience is not spoken late', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'cab', name = 'Delamain', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'voice', name = 'Delamain', anchor = 'vehicle', minGap = 2})
    player.vehicle = car
    local dropReasons = {}
    handle:on('remarkDropped', function(payload) dropReasons[#dropReasons + 1] = payload.event .. ':' .. payload.reason end)
    state.sample = {available = true, tier = 1, dialogue = true}
    local fits = true
    assert(handle:remark('voice', {event = 'fits', patience = 20, relevant = function() return fits end}))
    tick()
    fits = false
    tick(1); assert(#M._test.queue() == 1, 'a flicker is forgiven')
    fits = true; tick(1); fits = false
    tick(1); tick(1); tick(1); tick(1)
    assert(#M._test.queue() == 0 and dropReasons[#dropReasons] == 'fits:irrelevant', tostring(dropReasons[#dropReasons]))
    state.sample = {available = true, tier = 1}; tick(5)
    assert(#submitted == 0, 'nothing is said for a moment that has gone')
    -- It no longer fits at the moment of sending: it keeps waiting rather than speaking.
    state.sample = {available = true, tier = 1, dialogue = true}
    fits = true
    assert(handle:remark('voice', {event = 'late', patience = 6, relevant = function() return fits end})); tick()
    state.sample = {available = true, tier = 1}; fits = false
    tick(0.5); tick(0.5); tick(0.5); tick(0.5)
    assert(#submitted == 0)
    -- Past its patience (6 s) a scene is not waited for any more.
    fits = true
    state.sample = {available = true, tier = 1, dialogue = true}; tick(10)
    assert(dropReasons[#dropReasons] == 'late:expired', tostring(dropReasons[#dropReasons]))
    assert(select(2, handle:remark('voice', {event = 'x', patience = 'soon'})) == nil, 'a bad patience is just no patience')
  `);
});

test('a patient remark in flight that meets a scene is taken back and written again after it (twice at most); nothing heard costs nothing', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'cab', name = 'Delamain', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'voice', name = 'Delamain', anchor = 'vehicle', minGap = 6})
    player.vehicle = car
    local finished = {}
    handle:on('remarkFinished', function(payload) finished[#finished + 1] = payload.reason .. ':' .. tostring(payload.requeued) .. ':' .. tostring(payload.spoken) end)
    assert(handle:remark('voice', {event = 'greet', patience = 60, ttl = 5})); tick()
    assert(#submitted == 1)
    for round = 1, 3 do
      state.sample = {available = true, tier = 1, dialogue = true}; tick()
      state.sample = {available = true, tier = 1}
      for _ = 1, 5 do tick(0.5) end
      if round <= 2 then assert(#submitted == round + 1, 'written again, round ' .. round) end
    end
    assert(#submitted == 3, 'the third scene is final: ' .. #submitted)
    assert(finished[1] == 'scene:true:false' and finished[2] == 'scene:true:false' and finished[3] == 'scene:false:false', table.concat(finished, ' '))
    -- A scene that waits for the speaker's gap is not charged to the remark: the speaker was not heard, so no cooldown is owed.
    assert(M._test.speakers['addon-cab-voice'].lastAt ~= nil)
    -- A remark without patience in flight is simply released.
    tick(10)
    assert(handle:remark('voice', {event = 'hasty'})); tick()
    local count = #submitted
    state.sample = {available = true, tier = 1, dialogue = true}; tick()
    state.sample = {available = true, tier = 1}; tick(5)
    assert(#submitted == count and #M._test.queue() == 0)
  `);
});

test('a request nobody answers is withdrawn after its ttl and 2 s so it cannot block the later remarks; a patient remark is asked for again', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'cab', name = 'Delamain', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'voice', name = 'Delamain', anchor = 'vehicle', minGap = 2})
    player.vehicle = car
    local finished = {}
    handle:on('remarkFinished', function(payload) finished[#finished + 1] = payload.reason .. ':' .. tostring(payload.requeued) end)
    -- Without patience: given up, nothing asked again.
    assert(handle:remark('voice', {event = 'hasty', ttl = 4})); tick()
    assert(#submitted == 1)
    tick(5); assert(handle:state().remark == 'voice', 'still within ttl + 2 s')
    tick(2)
    assert(handle:state().remark == nil and finished[1] == 'stale:false' and dropped[1].reason == 'stale', table.concat(finished, ' '))
    tick(10); assert(#submitted == 1 and #M._test.queue() == 0)
    -- With patience: asked once more, with a fresh clock, and spoken when the second request is answered.
    assert(handle:remark('voice', {event = 'greet', ttl = 4, patience = 30})); tick()
    assert(#submitted == 2)
    tick(5); tick(2)
    assert(finished[2] == 'stale:true' and #M._test.queue() == 1, table.concat(finished, ' '))
    tick(3)
    assert(#submitted == 3 and submitted[3].context.addon.event == 'greet', 'asked again')
    local id = state.pendingId
    state.pendingId, state.speechId = nil, id; tick()
    assert(handle:state().remark == 'voice')
  `);
});

test('game lines: only a remark with patience waits for the game subtitle line; the scene gate alone applies to the others', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'cab', name = 'Delamain', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'voice', name = 'Delamain', anchor = 'vehicle', minGap = 2})
    player.vehicle = car
    tick()
    M.gameLine(4, 'Regular', true)
    assert(handle:remark('voice', {event = 'hasty'})); tick()
    assert(#submitted == 1, 'a remark without patience is not held by a game line')
    state.pendingId = nil; tick(); tick(5)
    M.gameLine(3, 'Regular', false)
    assert(handle:remark('voice', {event = 'patient', patience = 20})); tick()
    assert(#submitted == 1)
    local log
    for _, line in ipairs(logs) do if line:find('Remark held', 1, true) then log = line end end
    assert(log and log:find('reason=game-line', 1, true) and log:find('signals=subtitle', 1, true), tostring(log))
    tick(3); tick(0.5); tick(0.5)
    assert(#submitted == 1)
    tick(0.5)
    assert(#submitted == 2 and submitted[2].context.addon.event == 'patient')
    -- A longer line extends the wait, a shorter one does not shorten it; absurd values are bounded.
    state.pendingId = nil; tick(); tick(10)
    M.gameLine(8, 'Radio'); M.gameLine(1, 'Regular'); M.gameLine(1e9, 'Regular')
    assert(handle:remark('voice', {event = 'later', patience = 60})); tick(); tick(14)
    assert(#submitted == 2, 'bounded to fifteen seconds, not forever')
    tick(1); tick(1.5)
    assert(#submitted == 3)
    -- A game line seen while the add-on is dormant or reset is forgotten.
    M.reset('load')
    assert(M._test.flight() == nil)
  `);
});

test('replacing the game\'s own lines: validated rules, the per-add-on switch, one log line per muted line, and the scene it belongs to does not close the gate', () => {
  run(`${WORLD}
    M.attach(host)
    local installs = 0
    host.installLineRules = function() installs = installs + 1 end
    local handle = assert(M.public.register({id = 'cab', name = 'Delamain', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'voice', name = 'Delamain', anchor = 'vehicle', minGap = 2, playThrough = true})
    assert(M.lineRulesWanted() == false and M.matchLine({}, {}) == nil, 'nothing is asked until a rule exists')
    -- A rule must be a plain, bounded declaration.
    assert(select(2, handle:replaceGameLines({})) == 'match must be a function')
    assert(select(2, handle:replaceGameLines({match = function() end, active = 3})) == 'active must be a function')
    assert(select(2, handle:replaceGameLines({match = function() end, audio = {'a', 'b', 'c', 'd', 'e'}})) == 'audio must be a list of at most 4 event names')
    assert(select(2, handle:replaceGameLines({match = function() end, audio = {'bad name!'}})) == 'invalid audio event name')
    assert(installs == 0 and M.lineRulesWanted() == false)
    local here = true
    assert(handle:replaceGameLines({name = 'Delamain', match = function(line) return line.speakerName == 'Delamain' end,
        active = function() return here end, audio = {'vo_cab'}, audioVerified = true}))
    assert(installs == 1 and M.lineRulesWanted() == true)
    local rule, replace = M.matchLine({speakerName = 'Delamain'}, {})
    assert(rule and rule.name == 'Delamain' and replace == true, 'on by default')
    assert(M.matchLine({speakerName = 'Judy'}, {}) == nil, 'only the own test of the add-on decides')
    here = false
    assert(M.matchLine({speakerName = 'Delamain'}, {}) == nil, 'inactive: not even matched')
    here = true
    -- The player\'s switch is a saved setting of the add-on.
    local sections = M.settingsSections()
    local labels = {}
    for _, item in ipairs(sections[1].items) do labels[#labels + 1] = item.label end
    assert(table.concat(labels, '|') == 'Time between remarks|Most remarks per fight|Replace the game' .. string.char(39) .. 's own lines|Mark our lines in the subtitles', table.concat(labels, '|'))
    assert(M.stageSetting('addon:cab:replaceGameLines', false) and M.commitSettings())
    assert(select(2, M.matchLine({speakerName = 'Delamain'}, {})) == false)
    assert(M.stageSetting('addon:cab:replaceGameLines', true) and M.commitSettings())
    -- The marker on the add-on speaker\'s own captions.
    assert(M.captionName('addon-cab-voice', 'Delamain') == 'Delamain (AI)')
    assert(M.stageSetting('addon:cab:markLines', false) and M.commitSettings())
    assert(M.captionName('addon-cab-voice', 'Delamain') == 'Delamain' and M.captionName('judy-alvarez', 'Judy') == 'Judy')
    assert(M.stageSetting('addon:cab:markLines', true) and M.commitSettings())
    -- A muted line: one log line, and a patient remark still waits for it (the voice stop is verified here, so only briefly).
    player.vehicle = car
    tick()
    state.sample = {available = true, combat = false, tier = 1, vehicle = true, dialogue = true}
    M.mutedLine(rule, {seconds = 6, measured = true, id = '000042', subtitle = 'filtered', audio = 'stop-sent(vo_cab)'})
    local muted
    for _, line in ipairs(logs) do if line:find('muted game line', 1, true) then muted = line end end
    assert(muted and muted:find('muted game line: Delamain 000042 (subtitle=filtered audio=stop-sent(vo_cab) 6.0s)', 1, true), tostring(muted))
    assert(handle:remark('voice', {event = 'after', patience = 20})); tick()
    assert(#submitted == 0, 'held for the muted line itself')
    tick(1); tick(1.5)
    assert(#submitted == 1 and submitted[1].context.addon.event == 'after', 'the dialogue flag of the silenced scene did not keep it waiting')
    -- A call still closes the gate for a silenced scene.
    state.pendingId = nil; tick(); tick(5)
    M.mutedLine(rule, {seconds = 6, measured = true, id = '000043', subtitle = 'filtered', audio = 'stop-sent(vo_cab)'})
    state.sample = {available = true, combat = false, tier = 1, vehicle = true, dialogue = true, call = true}
    assert(handle:remark('voice', {event = 'call'})); tick()
    assert(#submitted == 1, 'a call is never talked over')
  `);
});

test('a muted line\'s voice stop is sent again on the add-on tick at 0.3, 0.8 and 1.6 seconds, only for a rule with a voice event, and never after a reset', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'cab', name = 'Delamain', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'voice', name = 'Delamain', anchor = 'vehicle', minGap = 2, playThrough = true})
    assert(handle:replaceGameLines({name = 'Delamain', match = function(line) return line.speakerName == 'Delamain' end, audio = {'vo_3d', 'vo_2d'}}))
    local silent = assert(handle:replaceGameLines({name = 'Quiet', match = function(line) return line.speakerName == 'Quiet' end}))
    player.vehicle = car
    tick()
    local rule = M.matchLine({speakerName = 'Delamain'}, {})
    local quiet = M.matchLine({speakerName = 'Quiet'}, {})
    local sent = 0
    M.mutedLine(rule, {seconds = 6, measured = true, id = '000001', subtitle = 'filtered', audio = 'stop-sent(vo_3d,vo_2d)', repeatStop = function() sent = sent + 1 end})
    assert(sent == 0, 'the first stop is sent by the muting itself; the repeats come later')
    tick(0.1); tick(0.1)
    assert(sent == 0, 'not yet')
    tick(0.1); assert(sent == 1, 'at 0.3 s: ' .. sent)
    for _ = 1, 6 do tick(0.1) end; assert(sent == 2, 'at 0.8 s: ' .. sent)
    for _ = 1, 8 do tick(0.1) end
    assert(sent == 3, 'at 1.6 s: ' .. sent)
    for _ = 1, 30 do tick(0.1) end
    assert(sent == 3, 'three repeats in all')
    -- A rule with no voice event repeats nothing; a failing stop is contained.
    local silentSent = 0
    M.mutedLine(quiet, {seconds = 3, measured = true, id = '000002', subtitle = 'filtered', audio = 'no-event-known', repeatStop = function() silentSent = silentSent + 1 end})
    M.mutedLine(rule, {seconds = 3, measured = true, id = '000003', subtitle = 'filtered', audio = 'x', repeatStop = function() error('boom') end})
    for _ = 1, 20 do tick(0.1) end
    assert(silentSent == 0)
    -- Never more than a handful tracked at once, and a reset (a load, a death) forgets them all.
    local late = 0
    for index = 1, 10 do M.mutedLine(rule, {seconds = 3, measured = true, id = '1' .. index, subtitle = 'filtered', audio = 'x', repeatStop = function() late = late + 1 end}) end
    M.reset('load')
    for _ = 1, 30 do tick(0.1) end
    assert(late == 0, 'nothing is sent into a world that is gone')
  `);
});

test('playThrough: a speaker that plays through finishes a started line over an ordinary scene; a call, Johnny or a cinematic tier still stops it', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'cab', name = 'Delamain', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'through', name = 'Delamain', anchor = 'vehicle', minGap = 2, playThrough = true})
    handle:speaker({id = 'plain', name = 'Skippy', anchor = 'player', minGap = 2})
    player.vehicle = car
    local function play(speaker)
      tick(3)
      assert(handle:remark(speaker, {event = 'line'})); tick()
      local id = state.pendingId
      state.pendingId, state.speechId = nil, id; tick()
      assert(handle:state().remark == speaker)
    end
    play('through')
    state.sample = {available = true, tier = 2, dialogue = true}; tick(); tick(3)
    assert(handle:state().remark == 'through' and #dropped == 0, 'plays on')
    state.sample = {available = true, tier = 1, choices = true}; tick()
    assert(handle:state().remark == 'through', 'a choice menu is an ordinary scene')
    state.sample = {available = true, tier = 5, dialogue = true}; tick()
    assert(handle:state().remark == nil and dropped[#dropped].reason == 'scene')
    state.sample = {available = true, tier = 1}; tick(30)
    play('through')
    state.sample = {available = true, tier = 1, replacer = true}; tick()
    assert(handle:state().remark == nil, 'Johnny stops it')
    tick(30); state.sample = {available = true, tier = 1}
    play('through')
    state.sample = {available = true, tier = 1, call = true}; tick()
    assert(handle:state().remark == nil, 'a call stops it')
    tick(30); state.sample = {available = true, tier = 1}
    -- The default is unchanged: any scene stops a line.
    play('plain')
    state.sample = {available = true, tier = 1, dialogue = true}; tick()
    assert(handle:state().remark == nil and dropped[#dropped].reason == 'scene')
    -- A player's own turn still wins over a line that plays through.
    tick(30); state.sample = {available = true, tier = 1}
    play('through')
    state.active = true; tick()
    assert(handle:state().remark == nil and dropped[#dropped].reason == 'manual-priority')
  `);
});

test('priority, interruption, replacement and cooldowns', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'gun', name = 'Skippy', minGap = 2})
    -- The same event name keeps one waiting remark, with the newest facts.
    state.speechId = 'busy'
    handle:remark('gun', {event = 'ammo', facts = {left = 5}})
    handle:remark('gun', {event = 'ammo', facts = {left = 2}})
    assert(#M._test.queue() == 1 and M._test.queue()[1].event.facts.left == 2)
    for index = 1, 5 do assert(handle:remark('gun', {event = 'e' .. index, priority = 2})) end
    assert(#M._test.queue() == 6)
    assert(select(2, handle:remark('gun', {event = 'low', priority = 1})) == 'queue-full')
    assert(handle:remark('gun', {event = 'high', priority = 5}))
    assert(#M._test.queue() == 6)
    state.speechId = nil
    tick(3)
    assert(submitted[1].context.reaction.event == 'high', 'the highest priority goes first')
    -- An interrupting remark only stops a remark of a lower priority.
    assert(handle:remark('gun', {event = 'urgent', priority = 5, interrupt = true}))
    tick()
    assert(#dropped == 0 and M._test.flight().event == 'high', 'an equal priority never interrupts')
    -- Cancel clears the speaker's queue and stops its remark.
    assert(handle:cancel('gun'))
    assert(#M._test.queue() == 0 and M._test.flight() == nil and dropped[#dropped].reason == 'cancelled')
    state.pendingId = nil
    local other = assert(M.public.register({id = 'other', name = 'Other', version = '1.0.0', requires = '1.0'}))
    other:speaker({id = 'v', name = 'V2', minGap = 2})
    assert(other:remark('v', {event = 'calm', priority = 2, cooldown = 30}))
    tick(3)
    assert(submitted[#submitted].context.reaction.event == 'calm')
    assert(handle:remark('gun', {event = 'urgent', priority = 4, interrupt = true}))
    tick()
    assert(dropped[#dropped].reason == 'interrupted', tostring(dropped[#dropped].reason))
    tick(2)
    assert(submitted[#submitted].context.reaction.event == 'urgent')
    -- An event cooldown.
    assert(select(2, other:remark('v', {event = 'calm', cooldown = 30})) == 'event-cooldown')
    assert(select(2, handle:remark('gun', {})) ~= nil and select(2, handle:remark('nobody', {event = 'x'})) == 'unknown speaker')
  `);
});

test('events: combat, vehicle, scene, turns, speech and companions joining or leaving, all from the existing tick', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    local seen = {}
    for _, name in ipairs({'sessionStarted', 'combatStarted', 'combatEnded', 'vehicleEntered', 'vehicleExited', 'sceneStarted', 'sceneEnded',
        'speechStarted', 'speechEnded', 'companionJoined', 'companionLeft', 'sessionEnded'}) do
        assert(handle:on(name, function(payload) seen[#seen + 1] = name .. (payload.profileKey and (':' .. payload.profileKey) or '') end))
    end
    assert(handle:on('nope', function() end) == false)
    tick()
    state.sample = {available = true, combat = true, tier = 1, vehicle = false}; tick()
    state.sample = {available = true, combat = false, tier = 1, vehicle = true}; player.vehicle = car; tick()
    state.sample = {available = true, combat = false, tier = 2, vehicle = true}; tick()
    state.sample = {available = true, combat = false, tier = 1, vehicle = false}; player.vehicle = nil; tick()
    state.speechId = 'r1'; tick(); state.speechId = nil; tick()
    party = {'judy-alvarez'}; partyCallback(); tick()
    party = {}; partyCallback(); tick()
    M.reset('load')
    assert(table.concat(seen, ',') == 'sessionStarted,combatStarted,combatEnded,vehicleEntered,sceneStarted,vehicleExited,sceneEnded,'
        .. 'speechStarted,speechEnded,companionJoined:judy-alvarez,companionLeft:judy-alvarez,sessionEnded', table.concat(seen, ','))
  `);
});

test('handle:party() reads the companions following V on demand and never throws', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'delamain-cab', name = 'Delamain Cab', version = '1.0.0', requires = '1.0'}))
    assert(#handle:party() == 0, 'no party yet')
    party = {'judy-alvarez', 'panam-palmer', 42}
    local list = handle:party()
    assert(#list == 2 and list[1] == 'judy-alvarez' and list[2] == 'panam-palmer', 'only profile keys')
    host.partyProfiles = function() error('party unavailable') end
    assert(#handle:party() == 0, 'a failing read gives an empty list')
    host.partyProfiles = nil
    assert(#handle:party() == 0)
  `);
});

test('a handler that keeps failing is removed after three failures; the others keep running', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    local good, bad = 0, 0
    handle:on('combatStarted', function() bad = bad + 1; error('boom') end)
    handle:on('combatStarted', function() good = good + 1 end)
    tick()
    for _ = 1, 5 do
        state.sample = {available = true, combat = true, tier = 1}; tick()
        state.sample = {available = true, combat = false, tier = 1}; tick()
    end
    assert(bad == 3 and good == 5, bad .. ' ' .. good)
  `);
});

test('companion context and add-on state reach the bridge file, and a session end clears them', () => {
  const doc = run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'cab', name = 'Delamain', version = '1.0.0', requires = '1.0'}))
    assert(handle:setCompanionContext('ride', 'You are riding in a Delamain cab with V.'))
    assert(handle:setState({ride = true}))
    tick()
    local written = files['runtime/addon-state.json']
    M.reset('load')
    local cleared = files['runtime/addon-state.json']
    return written .. '\\n' .. cleared
  `);
  const [written, cleared] = doc.split('\n').map(line => JSON.parse(line));
  assert.deepEqual(written.addons, {cab: {companionContext: [{key: 'ride', text: 'You are riding in a Delamain cab with V.'}], state: {ride: true}}});
  assert.equal(written.version, 1);
  assert.equal(written.updated, 1000000000);
  assert.deepEqual(cleared.addons, [], 'nothing left after a load (an empty table)');
});

test('settings: one section per add-on, checked changes held until Apply, saved to the settings file, told on the next tick', () => {
  const saved = run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    assert(handle:settings({title = 'Skippy', items = {
        {id = 'personality', label = 'Personality', kind = 'select', default = 1, elements = {'Stone Cold Killer', 'Puppy-Loving Pacifist'}},
        {id = 'remarks', label = 'Combat remarks', kind = 'bool', default = true}}}))
    assert(handle:setting('personality') == 1 and handle:setting('remarks') == true)
    local sections = M.settingsSections()
    assert(#sections == 1 and sections[1].id == 'addon-skippy' and sections[1].items[1].mcmId == 'addon:skippy:personality')
    assert(M.signature() == 'addon:skippy:personality=1,addon:skippy:remarks=true', M.signature())
    local changed = {}
    handle:on('settingChanged', function(payload) changed[#changed + 1] = payload.id .. '=' .. tostring(payload.value) end)
    assert(select(2, M.stageSetting('addon:skippy:personality', 3)) == 'Choose one of the listed options.')
    assert(select(2, M.stageSetting('addon:skippy:remarks', 1)) == 'This setting must be on or off.')
    assert(select(2, M.stageSetting('addon:nobody:x', true)) ~= nil)
    assert(M.stageSetting('addon:skippy:personality', 2))
    M.discardSettings()
    assert(M.commitSettings() == true and files['runtime/addon-settings.json'] == nil, 'a discarded change saves nothing')
    assert(M.stageSetting('addon:skippy:personality', 2))
    assert(M.commitSettings())
    assert(handle:setting('personality') == 2)
    assert(#changed == 0, 'never inside the menu callback')
    tick()
    assert(changed[1] == 'personality=2')
    assert(select(2, handle:settings({items = {{id = 'x', label = 'X', kind = 'slider'}}})) == 'setting kind must be bool or select')
    return files['runtime/addon-settings.json']
  `);
  assert.deepEqual(JSON.parse(saved), {version: 1, addons: {skippy: {personality: 2, remarks: true, remarkGap: 4, remarkCap: 4, replaceGameLines: true, markLines: true}}});
});

test('remark pacing: the two settings, half the gap for priority 5, the cap with its reserved slot, and unheard remarks are free', () => {
  const saved = run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'gun', name = 'Skippy', minGap = 2})
    -- Every add-on with a speaker gets "Time between remarks" (default 10 s) and "Most remarks per fight" (default 30).
    local sections = M.settingsSections()
    local gap, cap = sections[1].items[1], sections[1].items[2]
    assert(#sections == 1 and sections[1].title == 'Skippy' and gap.mcmId == 'addon:skippy:remarkGap' and cap.mcmId == 'addon:skippy:remarkCap' and sections[1].items[3].mcmId == 'addon:skippy:markLines')
    assert(table.concat(gap.elements, ',') == '4 s,6 s,8 s,10 s,15 s,20 s,30 s,60 s' and gap.default == 4 and gap.value == 4)
    assert(table.concat(cap.elements, ',') == '5,10,20,30,50,No limit' and cap.default == 4 and cap.value == 4)
    assert(gap.description:find('about 20 seconds', 1, true), 'the help text names the Local AI default')
    for _, reserved in ipairs({'remarkGap', 'remarkCap', 'remarkRate', 'markLines', 'replaceGameLines'}) do
        assert(select(2, handle:settings({items = {{id = reserved, label = 'X', kind = 'bool'}}})) ~= nil, reserved .. ' is reserved')
    end
    local function hear()
        tick()
        local id = submitted[#submitted].context.requestId
        state.pendingId, state.speechId = nil, id; tick(); state.speechId = nil; tick()
    end
    -- The default 10 s gap, counted from the end of the last remark; priority 5 needs 5 s.
    state.sample = {available = true, combat = true, tier = 1}; tick()
    assert(handle:remark('gun', {event = 'first-kill', priority = 4})); hear()
    tick(4)
    assert(select(2, handle:remark('gun', {event = 'kill', priority = 3})) == 'addon-gap')
    tick(1)
    assert(handle:remark('gun', {event = 'near-death', priority = 5}), 'priority 5 needs only half the gap'); hear()
    tick(10)
    assert(handle:remark('gun', {event = 'kill', priority = 3})); hear()
    -- 4 s and at most 5 a fight: the fifth is kept for priority 4 or 5.
    assert(M.stageSetting('addon:skippy:remarkGap', 1) and M.stageSetting('addon:skippy:remarkCap', 1) and M.commitSettings())
    state.sample = {available = true, combat = false, tier = 1}; tick()
    state.sample = {available = true, combat = true, tier = 1}; tick(4)
    local before = #submitted
    for index = 1, 4 do assert(handle:remark('gun', {event = 'kill' .. index, priority = 3})); hear(); tick(4) end
    assert(#submitted == before + 4)
    assert(select(2, handle:remark('gun', {event = 'kill5', priority = 3})) == 'episode-budget')
    assert(handle:remark('gun', {event = 'streak', priority = 4})); hear(); tick(4)
    assert(select(2, handle:remark('gun', {event = 'fight-end', priority = 5})) == 'episode-budget', 'five a fight')
    -- A remark that was never heard (dropped as a repeat) does not spend the cap or start the gap.
    assert(M.stageSetting('addon:skippy:remarkCap', 6) and M.commitSettings())
    state.sample = {available = true, combat = false, tier = 1}; tick()
    state.sample = {available = true, combat = true, tier = 1}; tick(4)
    assert(handle:remark('gun', {event = 'first-kill', priority = 4})); tick()
    state.pendingId = nil; tick()
    assert(M._test.flight() == nil)
    tick(2.5)
    assert(handle:remark('gun', {event = 'kill', priority = 3}), 'no gap after an unheard remark'); hear()
    -- No limit.
    for index = 1, 12 do tick(4); assert(handle:remark('gun', {event = 'k' .. index, priority = 2})); hear() end
    -- Outside combat the cap counts a rolling five minutes.
    assert(M.stageSetting('addon:skippy:remarkCap', 1) and M.commitSettings())
    state.sample = {available = true, combat = false, tier = 1}; tick(301)
    for index = 1, 4 do tick(4); assert(handle:remark('gun', {event = 'calm' .. index, priority = 3})); hear() end
    tick(4)
    assert(select(2, handle:remark('gun', {event = 'calm5', priority = 3})) == 'episode-budget')
    tick(301)
    assert(handle:remark('gun', {event = 'calm6', priority = 3}))
    return files['runtime/addon-settings.json']
  `);
  const values = JSON.parse(saved).addons.skippy;
  assert.equal(values.remarkGap, 1);
  assert.equal(values.remarkGapChosen, true, 'a picked gap is kept on every provider; the bridge sees it');
});

test('one remark at a time: nothing builds up behind a remark in flight, a late reply is dropped, and the local AI can ask for a pause', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'gun', name = 'Skippy', minGap = 2})
    local dropReasons, finished = {}, {}
    handle:on('remarkDropped', function(payload) dropReasons[#dropReasons + 1] = payload.event .. ':' .. payload.reason end)
    handle:on('remarkFinished', function(payload) finished[#finished + 1] = payload.reason end)
    assert(M.stageSetting('addon:skippy:remarkGap', 1) and M.commitSettings())
    tick()
    assert(handle:remark('gun', {event = 'first-kill', priority = 4})); tick()
    local context = submitted[1].context
    -- While it is written: one waiting remark at most, the strongest (a tie goes to the newer moment).
    assert(handle:remark('gun', {event = 'kill', priority = 2}))
    assert(handle:remark('gun', {event = 'streak', priority = 3}))
    assert(#M._test.queue() == 1 and M._test.queue()[1].event.event == 'streak' and dropReasons[1] == 'kill:replaced')
    assert(select(2, handle:remark('gun', {event = 'kill2', priority = 1})) == 'busy')
    tick(); tick()
    assert(#submitted == 1, 'nothing starts while a remark is in flight')
    -- The reply arrives after the moment has passed (about 3 s): dropped, never played late.
    tick(3)
    assert(M.canDeliver(context, player) == false and finished[1] == 'stale' and dropped[1].reason == 'stale')
    tick()
    assert(dropReasons[#dropReasons] == 'streak:expired', 'the waiting remark has expired too')
    -- The local AI asks for a pause (it keeps the default gap at about 20 s): no remark until it is over.
    tick(5)
    assert(handle:remark('gun', {event = 'kill3', priority = 3})); tick()
    M.replyError(submitted[2].context, {errorCode = 'addon-pace', error = '', retryAfter = 8})
    state.pendingId = nil; tick(); tick(2.5)
    assert(select(2, handle:remark('gun', {event = 'kill4', priority = 5})) == 'addon-gap')
    tick(8)
    assert(handle:remark('gun', {event = 'kill4', priority = 3}))
    assert(#notices == 0, 'a pause is silent')
  `);
});

test('modes, memories and warm-ups travel to the bridge; a missing provider is told once and pauses remarks', () => {
  const doc = run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'gun', name = 'Skippy', minGap = 2})
    assert(handle:setMode('gun', 'puppy'))
    assert(select(2, handle:setMode('gun', 'Bad Mode')) == 'invalid mode id')
    assert(handle:remember('gun', 'V spared the Tyger Claw who begged.'))
    assert(handle:remember('gun', 'V spared the Tyger Claw who begged.'), 'a repeat is accepted and ignored')
    assert(select(2, handle:remember('gun', '')) == 'memory text is required')
    assert(handle:prepare('gun'))
    assert(#warmed == 0, 'no Convai warm-up for an add-on speaker')
    assert(handle:remark('gun', {event = 'kill', priority = 3}))
    tick()
    local context = submitted[1].context
    assert(context.addon.mode == 'puppy', 'the turn carries the mode')
    local talk = {profileKey = 'addon-skippy-gun', text = 'hi'}
    M.decorate(talk)
    assert(talk.addon.mode == 'puppy')
    -- The bridge says neither Mistral nor the local AI is set up: one notice, then quiet for two minutes.
    M.replyError(context, {errorCode = 'addon-provider', error = 'Skippy needs a free Mistral key or the Local AI pack.'})
    state.pendingId = nil; tick(); tick()
    assert(#notices == 1 and notices[1] == 'Skippy needs a free Mistral key or the Local AI pack.', tostring(notices[1]))
    tick(5)
    assert(select(2, handle:remark('gun', {event = 'kill', priority = 5})) == 'no-provider')
    tick(120)
    assert(handle:remark('gun', {event = 'kill', priority = 3}))
    tick()
    M.replyError(submitted[2].context, {errorCode = 'addon-provider', error = 'Skippy needs a free Mistral key or the Local AI pack.'})
    tick(11)
    assert(#notices == 1, 'once per session for remarks')
    M.replyError(talk, {errorCode = 'addon-provider', error = 'Skippy needs a free Mistral key or the Local AI pack.'})
    tick()
    assert(#notices == 2, 'a message V typed always gets it')
    M.replyError(context, {errorCode = 'addon-duplicate', error = ''})
    tick()
    assert(#notices == 2, 'a dropped repeat is silent')
    return files['runtime/addon-state.json']
  `);
  const state = JSON.parse(doc);
  assert.deepEqual(state.addons.skippy.modes, {gun: 'puppy'});
  assert.deepEqual(state.addons.skippy.memories, [{speaker: 'gun', text: 'V spared the Tyger Claw who begged.', at: 1000000000}]);
  assert.equal(state.addons.skippy.warm.speaker, 'gun');
});

test('talk keys and group rounds: an available speaker is offered as a voice-only participant; decorate adds its blocks', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'cab', name = 'Delamain', version = '1.0.0', requires = '1.0'}))
    local open = true
    handle:speaker({id = 'voice', name = 'Delamain', anchor = 'vehicle', group = true, available = function() return open end})
    assert(#M.talkCandidates(player, false) == 0, 'not in a car')
    player.vehicle = car
    local list = M.talkCandidates(player, false)
    assert(#list == 1 and list[1].voiceOnly == true and list[1].entity == '88ULL' and list[1].npc == car and list[1].profileKey == 'addon-cab-voice')
    assert(list[1].vehicle == true, 'a vehicle-anchored voice is flagged for the talk-target rule')
    assert(#M.talkCandidates(player, true) == 1)
    assert(M.participantLive(list[1], player))
    open = false
    assert(not M.participantLive(list[1], player) and #M.talkCandidates(player, false) == 0)
    handle:setContext('voice', 'route', 'Driving to Lizzie\\'s Bar.')
    local context = {profileKey = 'addon-cab-voice', text = 'hi'}
    M.decorate(context)
    assert(context.addon.id == 'cab' and context.addon.speaker == 'voice' and context.addon.blocks[1].text == "Driving to Lizzie's Bar.")
    local other = {profileKey = 'judy-alvarez'}
    M.decorate(other)
    assert(other.addon == nil)
    assert(handle:prepare('voice') == false, 'not available, no warm-up')
    open = true
    player.vehicle = nil
    assert(handle:prepare('voice') == false, 'no anchor, no warm-up')
    player.vehicle = car
    assert(handle:prepare('voice') == true and #warmed == 0, 'warmed by the bridge from the state file, never a Convai warm-up')
    tick()
    assert(files['runtime/addon-state.json']:find('"warm":{"at":', 1, true), files['runtime/addon-state.json'])
    handle:setEnabled(false)
    assert(#M.talkCandidates(player, false) == 0, 'a disabled add-on is never offered')
  `);
});

test('the native facade works with and without the plugin', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    local native = handle:native()
    assert(native.present() == false and native.use('x') == false and native.revision('reply.json') == nil)
    host.native = function() return {present = true, use = function() return true end, revision = function() return 4 end, status = function() return {ok = true} end} end
    assert(native.present() == true and native.use('senses') == true and native.revision('reply.json') == 4 and native.status().ok)
    host.native = function() return {present = true, use = function() error('boom') end} end
    assert(native.use('x') == false)
  `);
});

// ---- The main mod seams ----------------------------------------------------------------------------------------------------

const code = name => read(`../mod/${name}`).split('\n').map(line => line.replace(/^\s*--.*$/, '')).join('\n');

test('init.lua: every call into the add-on API is skipped until an add-on is live', () => {
  const init = code('init.lua');
  assert.match(init, /local loaded, module = pcall\(dofile, 'addons\.lua'\)\s+convaiAddons = loaded and type\(module\) == 'table' and module or nil/);
  const calls = [...init.matchAll(/convaiAddons\.(\w+)\(/g)].map(match => match[1]);
  assert.deepEqual([...new Set(calls)].sort(), ['attach', 'canDeliver', 'captionName', 'decorate', 'faceActor', 'gameLine', 'hideCaption', 'isSpeaker', 'lineRulesWanted', 'matchLine', 'mutedLine', 'participantLive', 'replyError', 'talkCandidates', 'voiceSource']);
  // Where an add-on voice is heard from: asked by speech.lua once per voice-only reply, and only while an add-on is live.
  assert.match(init, /speech\.voiceSource = function\(profileKey, player\) return convaiAddons\.live and convaiAddons\.voiceSource\(profileKey, player\) or nil end/);
  // An add-on remark whose speaker shows the text itself goes without a subtitle: asked by speech.lua once per voice-only reply, only while live.
  assert.match(init, /speech\.hideCaption = function\(profileKey, requestId\) return convaiAddons\.live and convaiAddons\.hideCaption\(profileKey, requestId\) or false end/);
  // The game-line notice runs only for a live add-on: the dialogue module asks first (one function call per game subtitle line).
  assert.match(init, /onGameLineWanted = function\(\) return convaiAddons ~= nil and convaiAddons\.live == true end,\s+onGameLine = function\(seconds, kind, measured\) convaiAddons\.gameLine\(seconds, kind, measured\) end/);
  assert.match(init, /if key and not participants and convaiAddons and convaiAddons\.live and convaiAddons\.isSpeaker\(key\) then key, voiceOnly = nil, true end/);
  assert.match(init, /if type\(reply\.errorCode\) == 'string' and reply\.errorCode:find\('\^addon%-'\) then\s+if convaiAddons and convaiAddons\.live then convaiAddons\.replyError\(pending, reply, player\) end\s+elseif keyId == 'key-memory'/);
  // The voice key addresses an add-on voice only on a computer that can recognise speech (asked on the key press); otherwise typed
  // messages only. No Convai warm-up or connect note is made for one.
  assert.match(init, /if voices and voices\[1\] and singleAction == 'cyberpunk_convai_voice' and not addonHears then[^]*?return nil\s+end\s+voices = nil\s+end/);
  assert.match(init, /if not person\.voiceOnly then audience\[#audience \+ 1\] = person\.profileKey end/);
  // Johnny in V's head (docs/JOHNNY_IN_YOUR_HEAD.md) is voice only but has his own connection, so the typed path says when it is not ready.
  assert.match(init, /local connectNote = autoConnect and not participants and \(not primary\.voiceOnly or primary\.head\) and autoConnect\.talkNotice\(key, name\) or nil/);
  assert.doesNotMatch(init, /seams\.warm/);
  // attach only stores functions; the other calls are guarded where they are made.
  assert.match(init, /convaiAddons and convaiAddons\.live and convaiAddons\.talkCandidates\(player, groupMode\)/);
  assert.match(init, /if convaiAddons and convaiAddons\.live then convaiAddons\.decorate\(context\) end/);
  assert.match(init, /if context\.reaction\.kind == 'addon' then return convaiAddons ~= nil and convaiAddons\.canDeliver\(context, player\) end/);
  // participantLive runs only for a voice-only participant, which exists only with an add-on.
  for (const match of init.matchAll(/convaiAddons\.participantLive/g)) {
    const line = init.slice(init.lastIndexOf('\n', match.index), init.indexOf('\n', match.index));
    assert.match(line, /voiceOnly/, line);
  }
  // pcall'd calls (tick, reset) are guarded by live too.
  for (const name of ['tick', 'reset']) {
    const uses = [...init.matchAll(new RegExp(`pcall\\(convaiAddons\\.${name}`, 'g'))];
    assert(uses.length >= 1, name);
    for (const match of uses) {
      const before = init.slice(init.lastIndexOf('\n', init.lastIndexOf('\n', match.index) - 1), match.index);
      assert.match(before, /convaiAddons and convaiAddons\.live/, `${name}: ${before}`);
    }
  }
  assert.match(read('../mod/init.lua'), /\nreturn \{addons = convaiAddons and convaiAddons\.public or nil\}\s*$/);
  // The face, gaze and gameplay actions are never touched for a voice.
  assert.match(init, /if not primary\.voiceOnly then\s+local faceOk, faceStatus = pcall\(function\(\) return npc:ConvaiFaceRequest\(\) end\)/);
  assert.match(init, /if not context\.voiceOnly then\s+local faceOk, faceStatus = pcall\(function\(\) return actor:ConvaiFaceRequest\(\) end\)/);
  assert.match(init, /if context\.voiceOnly then[^]*?elseif not context\.group and not context\.reaction then gameplayActions\.capture/);
});

test('speech, subtitles, continuous speech, group chat and the manager change nothing for an ordinary reply', () => {
  const speech = code('speech.lua'), subtitles = code('subtitles.lua'), continuous = code('continuous-speech.lua');
  assert.match(speech, /if M\.voiceOnly and NO_FACE\[key\] then return M\.faceActor and screenFace\[key\] or noFace end\s+return facial\[key\]/);
  assert.match(speech, /M\.voiceOnly = context\.voiceOnly == true\s+captions\.voiceOnly = M\.voiceOnly/);
  assert.match(speech, /\(not M\.voiceOnly and M\.actor:IsDeadNoStatPool\(\)\)/);
  assert.match(subtitles, /if M\.voiceOnly == true then\s+M\.mode, M\.fallback = 'dialogue', 'voice-only'/);
  assert.match(continuous, /\(owner\.voiceOnly or not actor:IsDeadNoStatPool\(\)\)/);
  const group = code('group-chat.lua');
  assert.match(group, /'archetype', 'voiceOnly'\}\) do row\[key\] = person\[key\] end/);
  // An add-on voice is heard by companions but never joins their routing audience (it has no Convai character).
  assert.match(group, /if not participant\.voiceOnly or participant == speaker then audience\[#audience \+ 1\] = participant\.profileKey end/);
  const mcm = code('mcm.lua');
  for (const match of mcm.matchAll(/convaiAddons\.(\w+)\(/g)) {
    const window = mcm.slice(Math.max(0, match.index - 900), match.index);
    assert.match(window, /convaiAddons and convaiAddons\.live|addonChanges > 0/, `mcm.lua ${match[1]} is not guarded`);
  }
});

test('the face proxy forwards every facial call for an ordinary reply and drops per-utterance calls for a voice', () => {
  const speechSource = read('../mod/speech.lua');
  const head = speechSource.slice(0, speechSource.indexOf('local continuous'));
  run(`
    local calls = {}
    local facial = setmetatable({}, {__index = function(_, key) return function() calls[#calls + 1] = key end end})
    dofile = function(name) if name == 'facial-playback.lua' then return facial end; return {} end
    convaiSpeech = {heartbeat = 0}
    ${head}
    face.start(); face.sync(); face.updateExpressions()
    assert(table.concat(calls, ',') == 'start,sync,updateExpressions')
    M.voiceOnly = true
    face.start(); face.sync(); face.pause(); face.stop(); face.hold(); face.beginExpression(); face.endExpression(); face.updateExpressions()
    assert(table.concat(calls, ',') == 'start,sync,updateExpressions,updateExpressions', table.concat(calls, ','))
  `);
});

test('settings fixed by the add-on: the two on/off built-ins are not offered, cannot be changed, and apply as fixed whatever was saved', () => {
  run(`${WORLD}
    M.attach(host)
    -- An older install saved the player's choices for the built-ins.
    files['runtime/addon-settings.json'] = json.encode({version = 1, addons = {skippy = {replaceGameLines = false, markLines = true}, cab = {replaceGameLines = false, markLines = false}}})
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'gun', name = 'Skippy', anchor = 'player', minGap = 2})
    assert(handle:replaceGameLines({name = 'Skippy', match = function(line) return line.speakerName == 'Skippy' end}))
    -- Before the add-on declares anything, nothing is fixed: the saved choices apply and both are offered.
    assert(select(2, M.matchLine({speakerName = 'Skippy'}, {})) == false)
    assert(M.captionName('addon-skippy-gun', 'Skippy') == 'Skippy (AI)')
    local function labels(index)
        local out = {}
        for _, item in ipairs(M.settingsSections()[index or 1].items) do out[#out + 1] = item.label end
        return table.concat(out, '|')
    end
    assert(labels():find('Replace the game', 1, true) and labels():find('Mark our lines', 1, true))
    assert(handle:settings({title = 'Skippy', fixed = {replaceGameLines = true, markLines = false, nonsense = true}, items = {
        {id = 'personality', label = 'Personality', kind = 'select', default = 1, elements = {'A', 'B'}}}}))
    assert(labels() == 'Time between remarks|Most remarks per fight|Personality', labels())
    assert(select(2, M.matchLine({speakerName = 'Skippy'}, {})) == true, 'fixed on, whatever was saved')
    assert(M.captionName('addon-skippy-gun', 'Skippy') == 'Skippy', 'fixed off, whatever was saved')
    assert(M.stageSetting('addon:skippy:replaceGameLines', false) == false and M.stageSetting('addon:skippy:markLines', true) == false)
    assert(M.stageSetting('addon:skippy:personality', 2) and M.commitSettings())
    assert(select(2, M.matchLine({speakerName = 'Skippy'}, {})) == true)
    -- One fixed value does not hide the other built-in.
    local cab = assert(M.public.register({id = 'cab', name = 'Delamain', version = '1.0.0', requires = '1.0'}))
    cab:speaker({id = 'voice', name = 'Delamain', anchor = 'vehicle', minGap = 2})
    assert(cab:replaceGameLines({name = 'Delamain', match = function(line) return line.speakerName == 'Delamain' end}))
    assert(cab:settings({fixed = {markLines = false}, items = {}}))
    local text = labels(2)
    assert(text:find('Replace the game', 1, true) and not text:find('Mark our lines', 1, true), text)
    assert(M.captionName('addon-cab-voice', 'Delamain') == 'Delamain')
    assert(M.stageSetting('addon:cab:replaceGameLines', true) and M.commitSettings())
    -- An add-on that fixes nothing keeps both switches, as before.
    local plain = assert(M.public.register({id = 'plain', name = 'Plain', version = '1.0.0', requires = '1.0'}))
    plain:speaker({id = 'one', name = 'Plain', anchor = 'player', minGap = 2})
    assert(plain:settings({items = {{id = 'x', label = 'X', kind = 'bool', default = true}}}))
    assert(labels(3):find('Mark our lines', 1, true))
    assert(M.captionName('addon-plain-one', 'Plain') == 'Plain (AI)')
  `);
});

test('showsReply: an add-on that shows a remark itself is asked once per remark, and the main mod then hides that remark\'s subtitle', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    assert(select(2, handle:speaker({id = 'gun', name = 'Skippy', showsReply = 3})) == 'showsReply must be a function')
    local asked, answer = {}, true
    handle:speaker({id = 'gun', name = 'Skippy', anchor = 'player', minGap = 2,
        showsReply = function(text, event) asked[#asked + 1] = event .. ':' .. text; if answer == 'error' then error('boom') end; return answer end})
    handle:speaker({id = 'plain', name = 'Plain', anchor = 'player', minGap = 2})
    assert(M.hideCaption('addon-skippy-gun', 'nothing') == false, 'no remark, no answer')
    assert(handle:remark('gun', {event = 'kill', priority = 3}))
    tick()
    local context = submitted[1].context
    assert(M.hideCaption('addon-skippy-gun', context.requestId) == false, 'not asked until the reply text arrives')
    M.replyText({requestId = 'other'}, 'not this one')
    assert(#asked == 0)
    M.replyText(context, 'Headshot.')
    assert(#asked == 1 and asked[1] == 'kill:Headshot.')
    assert(M.hideCaption('addon-skippy-gun', context.requestId) == true)
    assert(M.hideCaption('addon-skippy-gun', 'another') == false and M.hideCaption('addon-skippy-plain', context.requestId) == false
        and M.hideCaption('judy-alvarez', context.requestId) == false and M.hideCaption(nil, nil) == false)
    -- It is for this remark only: the next one is asked again, and a refusal or an error keeps the subtitle and says so once.
    assert(M.canDeliver(context, player) == true)
    state.pendingId, state.speechId = nil, context.requestId
    tick()
    state.speechId = nil
    tick()
    answer = false
    now = now + 20; tick(10)
    assert(handle:remark('gun', {event = 'kill', priority = 3}))
    tick()
    local second = submitted[2].context
    M.replyText(second, 'Another.')
    assert(#asked == 2 and M.hideCaption('addon-skippy-gun', second.requestId) == false, 'a refusal keeps the subtitle')
    local kept = 0
    for _, line in ipairs(logs) do if line:find('Remark subtitle kept', 1, true) then kept = kept + 1 end end
    assert(kept == 1, kept)
    assert(M.canDeliver(second, player) == true)
    state.pendingId, state.speechId = nil, second.requestId
    tick(); state.speechId = nil; tick()
    answer = 'error'
    now = now + 20; tick(10)
    assert(handle:remark('gun', {event = 'kill', priority = 3}))
    tick()
    local third = submitted[3].context
    M.replyText(third, 'Third.')
    assert(M.hideCaption('addon-skippy-gun', third.requestId) == false, 'a failing add-on never loses the line')
    -- A speaker without showsReply is never asked and keeps its subtitle.
    assert(M.canDeliver(third, player) == true)
    state.pendingId, state.speechId = nil, third.requestId
    tick(); state.speechId = nil; tick()
    -- The answer is dropped with the remark.
    answer = true
    now = now + 20; tick(10)
    assert(handle:remark('gun', {event = 'kill', priority = 3}))
    tick()
    local fourth = submitted[4].context
    M.replyText(fourth, 'Fourth.')
    assert(M.hideCaption('addon-skippy-gun', fourth.requestId) == true and M.hideCaption('addon-skippy-gun', third.requestId) == false)
  `);
});

test('silence: an add-on\'s own extra silencing runs with the muted line and repeats on the tick, even for a rule with no voice event', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'gun', name = 'Skippy', anchor = 'player', minGap = 2})
    assert(select(2, handle:replaceGameLines({match = function() end, silence = 3})) == 'silence must be a function')
    assert(handle:replaceGameLines({name = 'Skippy', match = function(line) return line.speakerName == 'Skippy' end,
        silence = function() return 'did it', function() end end}))
    local rule = M.matchLine({speakerName = 'Skippy'}, {})
    assert(type(rule.silence) == 'function' and #rule.audio == 0)
    local sent = 0
    M.mutedLine(rule, {seconds = 3, measured = true, id = '000007', subtitle = 'filtered', audio = 'no-event-known+did it', repeatStop = function() sent = sent + 1 end})
    for _ = 1, 30 do tick(0.1) end
    assert(sent == 3, 'repeated at 0.3, 0.8 and 1.6 s: ' .. sent)
  `);
});

// ---- 2026-10-14: fixed built-ins, held remarks, remarks that play through menus, and a face on a screen (the Delamain cab) ----

test('fixed built-ins: the add-on sets "Replace the game\'s own lines" and "Mark our lines" for good, the toggles are gone and old saved values are ignored', () => {
  run(`${WORLD}
    M.attach(host)
    files['runtime/addon-settings.json'] = json.encode({version = 1, addons = {cab = {replaceGameLines = false, markLines = true}}})
    local handle = assert(M.public.register({id = 'cab', name = 'Delamain', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'voice', name = 'Delamain', anchor = 'vehicle'})
    assert(handle:replaceGameLines({name = 'Delamain', match = function(line) return line.speakerName == 'Delamain' end}))
    -- Before the add-on fixes them, the saved choices apply (as always).
    assert(select(2, M.matchLine({speakerName = 'Delamain'}, {})) == false)
    assert(M.captionName('addon-cab-voice', 'Delamain') == 'Delamain (AI)')
    assert(handle:settings({title = 'Delamain Cab', remarkCap = false, fixed = {replaceGameLines = true, markLines = false, other = true},
        items = {{id = 'enabled', label = 'Enabled', kind = 'bool', default = true}}}))
    local rule, replace = M.matchLine({speakerName = 'Delamain'}, {})
    assert(rule and replace == true, 'always replaced, whatever was saved')
    assert(M.captionName('addon-cab-voice', 'Delamain') == 'Delamain', 'never marked')
    local labels = {}
    for _, item in ipairs(M.settingsSections()[1].items) do labels[#labels + 1] = item.label end
    assert(table.concat(labels, '|') == 'Time between remarks|Enabled', table.concat(labels, '|'))
    assert(M.stageSetting('addon:cab:replaceGameLines', false) == false and M.stageSetting('addon:cab:markLines', true) == false)
    -- A non-boolean fixed value is no fixed value.
    assert(handle:settings({title = 'Delamain Cab', fixed = {replaceGameLines = 'yes'}, items = {}}))
    assert(select(2, M.matchLine({speakerName = 'Delamain'}, {})) == false)
  `);
});

const CAB = `
    M.attach(host)
    local holds, menus = {}, {}
    host.hold = function(id) holds[#holds + 1] = id or 'nil' end
    host.menus = function(id) menus[#menus + 1] = id or 'nil' end
    local handle = assert(M.public.register({id = 'cab', name = 'Delamain', version = '1.0.0', requires = '1.0'}))
    local cab = car
    local key = handle:speaker({id = 'voice', name = 'Delamain', anchor = 'vehicle', minGap = 2, playThrough = true,
        approach = function() return cab end})
    local events = {}
    for _, name in ipairs({'remarkStarted', 'remarkFinished', 'remarkDropped'}) do
        handle:on(name, function(payload) events[#events + 1] = name .. ':' .. tostring(payload.reason or payload.event)
            .. (payload.spoken ~= nil and (':' .. tostring(payload.spoken)) or '') end)
    end
    local seated = false
`;

test('a held remark is written and voiced before its moment (anchored on the approached cab), kept silent, and plays when hold() turns false', () => {
  run(`${WORLD}${CAB}
    assert(select(2, handle:remark('voice', {event = 'x', hold = 3})) == 'hold must be a function')
    assert(select(2, handle:remark('voice', {event = 'x', menus = 'yes'})) == 'menus must be true, false or a function')
    assert(handle:remark('voice', {event = 'boarded', priority = 4, ttl = 15, hold = function() return not seated end, holdMax = 20}))
    tick()
    assert(#submitted == 1, 'sent while V is not in the cab yet')
    local context = submitted[1].context
    assert(submitted[1].anchor == cab and context.entity == '88ULL', 'the approach object is the anchor')
    assert(holds[1] == context.requestId, 'speech.lua is told to keep it paused')
    assert(M.canDeliver(context, player) == true)
    state.pendingId, state.speechId = nil, context.requestId
    tick(); tick(1)
    assert(M._test.flight().stage == 'held' and #events == 0, 'voiced but not heard: no remarkStarted')
    -- V sits: the hold ends on the next tick, the line is heard from there.
    player.vehicle = cab; seated = true
    tick()
    assert(holds[#holds] == 'nil')
    tick()
    assert(events[1] == 'remarkStarted:boarded', tostring(events[1]))
    state.speechId = nil
    tick()
    assert(events[2] == 'remarkFinished:finished:true', tostring(events[2]))
    assert(#menus == 0, 'no menus option: speech.lua is never told about menus')
  `);
});

test('a held remark plays at once on handle:releaseHold, is given up unheard after holdMax, and the cab must still be the one V boards', () => {
  run(`${WORLD}${CAB}
    assert(handle:remark('voice', {event = 'boarded', priority = 4, ttl = 15, hold = function() return not seated end}))
    tick()
    local context = submitted[1].context
    assert(M.canDeliver(context, player))
    state.pendingId, state.speechId = nil, context.requestId
    tick()
    assert(handle:releaseHold('voice') == true and holds[#holds] == 'nil', 'released without waiting for a tick')
    assert(handle:releaseHold('voice') == false, 'nothing held any more')
    tick()
    assert(events[1] == 'remarkStarted:boarded')
    state.speechId = nil; tick()
    -- Never seated: given up after holdMax, unheard, its voice stopped.
    now = now + 30; tick(30)
    assert(handle:remark('voice', {event = 'boarded2', priority = 4, ttl = 15, hold = function() return true end, holdMax = 5}))
    tick()
    local second = submitted[2].context
    assert(M.canDeliver(second, player))
    state.pendingId, state.speechId = nil, second.requestId
    tick(); tick(3)
    assert(M._test.flight() ~= nil)
    tick(2.5)
    assert(M._test.flight() == nil and dropped[#dropped].reason == 'hold-expired' and dropped[#dropped].requestId == second.requestId)
    assert(events[#events] == 'remarkFinished:hold-expired:false', tostring(events[#events]))
    assert(holds[#holds] == 'nil')
    -- V got into another car before the reply arrived: not this cab's line any more.
    now = now + 30; tick(30)
    assert(handle:remark('voice', {event = 'boarded3', priority = 4, ttl = 15, hold = function() return true end}))
    tick()
    tick(3)   -- the quiet gap after the stopped voice
    local third = submitted[3].context
    player.vehicle = {hash = '99ULL', IsAttached = function() return true end, GetEntityID = function(self) return {hash = self.hash} end}
    assert(M.canDeliver(third, player) == false and dropped[#dropped].reason == 'anchor-changed')
  `);
});

test('approach is for held remarks only: an ordinary remark and talk still need V in the cab', () => {
  run(`${WORLD}${CAB}
    assert(handle:remark('voice', {event = 'plain', priority = 3}))
    tick()
    assert(#submitted == 0 and events[1] == 'remarkDropped:speaker-unavailable', tostring(events[1]))
    assert(#M.talkCandidates(player, false) == 0, 'talk never uses approach')
    -- A held remark whose moment has already come is not held at all.
    seated = true; player.vehicle = cab
    assert(handle:remark('voice', {event = 'late', priority = 4, hold = function() return not seated end}))
    tick()
    assert(#submitted == 1 and #holds == 0 and submitted[1].context.entity == '88ULL')
  `);
});

test('menus: speech.lua is told which remark plays on while a menu is open, for as long as the add-on says so', () => {
  run(`${WORLD}${CAB}
    player.vehicle = cab
    local waiting = true
    assert(handle:remark('voice', {event = 'boarded', priority = 4, menus = function() return waiting end}))
    tick()
    local context = submitted[1].context
    assert(menus[1] == context.requestId)
    assert(M.canDeliver(context, player))
    state.pendingId, state.speechId = nil, context.requestId
    tick()
    assert(#menus == 1, 'told once, not every tick')
    waiting = false
    tick()
    assert(menus[2] == 'nil')
    waiting = true; tick()
    assert(menus[3] == context.requestId)
    state.speechId = nil; tick()
    assert(menus[4] == 'nil', 'the release clears it')
  `);
});

test('a face on a screen: validated, watched through the face service only while the add-on asks, released after a reset, and only that NPC is returned', () => {
  run(`${WORLD}
    M.attach(host)
    local watched, calls = {}, {}
    local npc = {hash = '55ULL', ready = true}
    function npc:IsAttached() return true end
    function npc:GetEntityID() return {hash = self.hash} end
    function npc:ConvaiFaceReady() return self.ready end
    local service = {}
    function service:WatchScreenFace(rig, on) calls[#calls + 1] = rig .. '=' .. tostring(on); watched[rig] = on or nil end
    function service:ScreenFace(rig) return {hash = watched[rig] and '55ULL' or '0ULL'} end
    host.faceService = function() return service end
    Game = {FindEntityByID = function(id) return id.hash == '55ULL' and npc or nil end}
    local RIG = 'base\\\\characters\\\\main_npc\\\\delamain\\\\h0_001_ma_c__delamain\\\\h0_001_ma_c__delamain_skeleton.rig'
    local handle = assert(M.public.register({id = 'cab', name = 'Delamain', version = '1.0.0', requires = '1.0'}))
    assert(select(2, handle:speaker({id = 'bad', name = 'X', face = {rig = 'not a rig'}})) == 'face.rig must be a .rig path')
    assert(select(2, handle:speaker({id = 'bad', name = 'X', approach = 3})) == 'approach must be a function')
    local key = handle:speaker({id = 'voice', name = 'Delamain', anchor = 'vehicle', face = {rig = RIG}})
    local plain = handle:speaker({id = 'other', name = 'Other', anchor = 'vehicle'})
    assert(select(2, handle:watchFace('other', true)) == 'speaker has no face')
    assert(M.faceActor(key, player) == nil, 'not watched: no face')
    assert(handle:watchFace('voice', true) and calls[1] == RIG .. '=true')
    assert(handle:watchFace('voice', true) and #calls == 1, 'one service call per change')
    assert(M.faceActor(key, player) == npc and M.faceActor(plain, player) == nil and M.faceActor('judy-alvarez', player) == nil)
    npc.ready = false
    assert(M.faceActor(key, player) == nil, 'a face that no longer runs the gated graph is not used')
    npc.ready = true
    -- A save load: the watch is released on the next gameplay tick (M.reset never calls the game) unless the add-on watches again.
    M.reset('load')
    assert(#calls == 1 and M.faceActor(key, player) == nil)
    tick()
    assert(calls[2] == RIG .. '=false' and watched[RIG] == nil)
    assert(handle:watchFace('voice', true) and calls[3] == RIG .. '=true')
    M.reset('load')
    assert(handle:watchFace('voice', true) and calls[4] == RIG .. '=true')
    tick()
    assert(#calls == 4, 'watched again before the tick: not released')
    -- Switching the add-on off ends the watch.
    assert(handle:setEnabled(false) and calls[5] == RIG .. '=false')
    assert(handle:watchFace('voice', true) and #calls == 5, 'a disabled add-on watches nothing')
  `);
});

test('speech.lua: a screen face gets the voice\'s face calls under its own entity, and hold / menus decide the pause; without them nothing changes', () => {
  const speechSource = read('../mod/speech.lua');
  const head = speechSource.slice(0, speechSource.indexOf('local continuous'));
  run(`
    local calls = {}
    local facial = setmetatable({}, {__index = function(_, key) return function(...) calls[#calls + 1] = {key, ...} end end})
    dofile = function(name) if name == 'facial-playback.lua' then return facial end; return {} end
    convaiSpeech = {heartbeat = 0}
    ${head}
    local screen = {}
    M.voiceOnly, M.faceActor, M.faceEntity = true, screen, '55ULL'
    M.faceContext = {requestId = 'r1', generation = 3, entity = '55ULL', name = 'Delamain'}
    local timeline = {version = 1, requestId = 'r1', entity = '88ULL', frames = {{0, 0}, {1, 0}}}
    face.start({entity = '88ULL'}, timeline, 'cab', 1, nil)
    local start = calls[1]
    assert(start[1] == 'start' and start[2] == M.faceContext and start[4] == screen and start[5] == 1)
    assert(start[3] ~= timeline and start[3].entity == '55ULL' and start[3].frames == timeline.frames and timeline.entity == '88ULL',
        'a re-addressed copy; the reply timeline itself is untouched')
    face.updateContinuous({}, timeline, 'cab', 1)
    assert(calls[2][1] == 'updateContinuous' and calls[2][3].entity == '55ULL' and calls[2][4] == screen)
    face.sync('cab', .5, 'r1'); face.pause('cab'); face.hold('cab', 'r1'); face.stop('cab', 'finished')
    assert(calls[3][2] == screen and calls[3][3] == .5 and calls[4][2] == screen and calls[5][2] == screen and calls[6][2] == screen)
    local before = #calls
    face.beginExpression(); face.acceptExpression(); face.endExpression()
    assert(#calls == before, 'no expression calls for a screen face')
    -- Pause rules: a menu pauses (as always) unless this request plays through menus; a held request stays paused.
    assert(pausedFor('r1', true) == true and pausedFor('r1', false) == false and pausedFor(nil, true) == true)
    M.menuRequest = 'r1'
    assert(pausedFor('r1', true) == false and pausedFor('r2', true) == true)
    M.holdRequest = 'r1'
    assert(pausedFor('r1', false) == true and pausedFor('r1', true) == true and pausedFor('r2', false) == false)
  `);
  // The wiring: asked once per reply, cleared with the reply, and the pause uses it every frame for the native and the browser voice.
  assert.match(speechSource, /if M\.voiceOnly and not M\.holocall and type\(M\.faceSource\) == 'function' then/);
  assert.match(speechSource, /if M\.faceEntity then facial\.clearExpression\(M\.faceEntity\); facial\.screenEntity = nil end/);
  assert.match(speechSource, /local paused = pausedFor\(M\.requestId, inMenu\)/);
  assert.match(speechSource, /paused = pausedFor\(context\.requestId, paused\)/);
  assert.match(speechSource, /if started and M\.requestId and pausedFor\(M\.requestId, false\) then/);
  const init = read('../mod/init.lua');
  // Both answers of faceActor reach speech.lua (an `a and b or nil` would drop the second, "not ready yet").
  assert.match(init, /speech\.faceSource = function\(profileKey, player\)\s+if not convaiAddons\.live then return nil end\s+return convaiAddons\.faceActor\(profileKey, player\)\s+end/);
  assert.match(init, /speech\.log = log/);
  assert.match(init, /seams\.hold = function\(requestId\) speech\.holdRequest = requestId end/);
  assert.match(init, /seams\.menus = function\(requestId\) speech\.menuRequest = requestId end/);
  const facialSource = read('../mod/facial-playback.lua');
  assert.match(facialSource, /local function safeExpressionActor\(actor,entity\)\s+if entity~=nil and entity==M\.screenEntity then return true end/);
  assert.match(facialSource, /not safeExpressionActor\(actor,entity\)/);
});

// ---- 2026-10-15: the welcome's screen face (live test: the face moved for later lines, not for the held welcome) ----

const FACE_CAB = `
    local npc = {hash = '55ULL', ready = false}
    function npc:IsAttached() return true end
    function npc:GetEntityID() return {hash = self.hash} end
    function npc:ConvaiFaceReady() return self.ready end
    local spawned = false
    local service = {}
    function service:WatchScreenFace() end
    function service:ScreenFace() return {hash = spawned and '55ULL' or '0ULL'} end
    host.faceService = function() return service end
    Game = {FindEntityByID = function(id) return id.hash == '55ULL' and npc or nil end}
    local RIG = 'base\\\\characters\\\\main_npc\\\\delamain\\\\h0_001_ma_c__delamain\\\\h0_001_ma_c__delamain_skeleton.rig'
    local faced = handle:speaker({id = 'face', name = 'Delamain', anchor = 'vehicle', minGap = 2, playThrough = true,
        approach = function() return cab end, face = {rig = RIG}})
    assert(handle:watchFace('face', true))
`;

test('faceActor says when a watched screen face is only not ready yet; an unwatched or faceless speaker gets a plain nil', () => {
  run(`${WORLD}${CAB}${FACE_CAB}
    local npcOut, pending = M.faceActor(faced, player)
    assert(npcOut == nil and pending == true, 'not spawned yet: pending')
    spawned = true
    npcOut, pending = M.faceActor(faced, player)
    assert(npcOut == nil and pending == true, 'spawned, its face graph not ready: pending')
    npc.ready = true
    assert(M.faceActor(faced, player) == npc)
    npcOut, pending = M.faceActor(key, player)
    assert(npcOut == nil and pending == nil, 'a speaker without a face is never pending')
    handle:watchFace('face', false)
    npcOut, pending = M.faceActor(faced, player)
    assert(npcOut == nil and pending == nil, 'not watched: never pending')
  `);
});

test('faceWait: a held remark whose moment came stays silent until its screen face is ready, at most faceWait seconds', () => {
  run(`${WORLD}${CAB}${FACE_CAB}
    assert(handle:remark('face', {event = 'boarded', priority = 4, ttl = 15, hold = function() return not seated end, faceWait = 1.5}))
    assert(M._test.queue()[1].faceWait == 1.5)
    tick()
    local context = submitted[1].context
    assert(M.canDeliver(context, player))
    state.pendingId, state.speechId = nil, context.requestId
    tick()
    -- V sits; the game's scene has not spawned the screen NPC yet.
    seated, player.vehicle = true, cab
    assert(handle:releaseHold('face') == true)
    assert(holds[#holds] == context.requestId and M._test.flight().holding, 'still held: the face is not there')
    tick(.1); tick(.1)
    assert(M._test.flight().holding and #events == 0)
    spawned, npc.ready = true, true
    tick(.1)
    assert(holds[#holds] == 'nil' and not M._test.flight().holding, 'released the tick the face is ready')
    tick()
    assert(events[1] == 'remarkStarted:boarded')
    state.speechId = nil; tick()
    -- The face never comes: played after faceWait, the face joins later (speech.lua).
    now = now + 30; tick(30)
    spawned, npc.ready = false, false
    seated = false
    assert(handle:remark('face', {event = 'boarded2', priority = 4, ttl = 15, hold = function() return not seated end, faceWait = 1.5}))
    tick()
    local second = submitted[2].context
    assert(M.canDeliver(second, player))
    state.pendingId, state.speechId = nil, second.requestId
    tick()
    seated = true
    tick(.1)
    assert(M._test.flight().holding, 'hold() turned false: the face wait starts')
    tick(1); assert(M._test.flight().holding)
    tick(.6)
    assert(not M._test.flight().holding and holds[#holds] == 'nil', 'faceWait is a ceiling')
    -- Bounds: faceWait is 0 to 5 s; without it nothing waits.
    state.speechId = nil; tick(); now = now + 30; tick(30)
    assert(handle:remark('face', {event = 'boarded3', priority = 4, hold = function() return true end, faceWait = 60}))
    assert(M._test.queue()[1].faceWait == 5)
  `);
});

test('speech.lua: a screen face that is not there when the line starts is asked again while the line plays, and joins at the heard position', () => {
  const speechSource = read('../mod/speech.lua');
  const head = speechSource.slice(0, speechSource.indexOf('local continuous'));
  const finite = speechSource.slice(speechSource.indexOf('local function finite'), speechSource.indexOf('local function null'));
  const retry = speechSource.slice(speechSource.indexOf('local function retryFace'), speechSource.indexOf('local function updateSpeech'));
  run(`
    local calls = {}
    local facial = setmetatable({}, {__index = function(_, key) return function(...) calls[#calls + 1] = {key, ...} end end})
    dofile = function(name) if name == 'facial-playback.lua' then return facial end; return {} end
    convaiSpeech = {heartbeat = 0}
    local npc = {hash = '55ULL'}
    function npc:GetEntityID() return {hash = self.hash} end
    local ready, asked = false, 0
    Game = {GetPlayer = function() return {} end}
    ${head}
    ${finite}
    ${retry}
    local logs = {}
    M.log = function(line) logs[#logs + 1] = line end
    M.faceSource = function(profileKey) asked = asked + 1; if ready then return npc end; return nil, profileKey == 'addon-cab-face' end
    -- Not there at the start: armed (M.start does exactly this).
    local context = {requestId = 'r1', generation = 3, name = 'Delamain', entity = '88ULL'}
    local found, pending = findScreenFace('addon-cab-face', context)
    assert(found == false and pending == true and M.faceActor == nil)
    local plainFound, plainPending = findScreenFace('addon-cab-gun', context)
    assert(plainFound == false and plainPending == false, 'a speaker without a screen face is never retried')
    M.voiceOnly, M.context, M.actor, M.state = true, context, 'cab', 'playing'
    M.faceRetry = {profileKey = 'addon-cab-face', wait = 0, tries = 0, elapsed = 0, context = context}
    local timeline = {version = 1, requestId = 'r1', entity = '88ULL', frames = {{0, 0}, {1, 0}}}
    M.faceChunk = {timeline = timeline, duration = 1, expected = nil}
    retryFace(1 / 60)
    assert(asked == 3 and M.faceRetry.tries == 1 and #calls == 0, 'asked at once, nothing started')
    for _ = 1, 10 do retryFace(1 / 60) end
    assert(asked == 3, 'not every frame: every 0.25 s')
    retryFace(.1)
    assert(asked == 4)
    ready = true
    retryFace(.25)
    assert(M.faceRetry == nil and M.faceChunk == nil and M.faceActor == npc and M.faceEntity == '55ULL' and facial.screenEntity == '55ULL')
    local start = calls[1]
    assert(start[1] == 'start' and start[2] == M.faceContext and start[3].entity == '55ULL' and start[4] == npc and start[5] == 1,
        'the playing phrase starts on the screen face')
    assert(logs[1]:find('Screen face joined: addon-cab-face', 1, true), logs[1])
    -- Never found: given up after the last try, with one log line.
    M.faceActor, M.faceEntity, M.faceContext = nil, nil, nil
    ready = false
    M.faceRetry = {profileKey = 'addon-cab-face', wait = 0, tries = 0, elapsed = 0, context = context}
    local tries = 0
    while M.faceRetry and tries < 100 do retryFace(.25); tries = tries + 1 end
    assert(tries == 40, tostring(tries))
    assert(M.faceRetry == nil and logs[2]:find('Screen face not found', 1, true))
    -- Between native phrases (buffering) or on the browser voice the face is not started here: the next phrase or update does it.
    ready = true
    calls = {}
    M.state = 'buffering'
    M.faceRetry = {profileKey = 'addon-cab-face', wait = 0, tries = 0, elapsed = 0, context = context}
    M.faceChunk = {timeline = timeline, duration = 1}
    retryFace(.25)
    assert(M.faceActor == npc and #calls == 0)
  `);
  // The wiring: armed at the start only when the face is pending, retried only while not paused, the phrase kept while waiting,
  // and cleared with the reply.
  assert.match(speechSource, /local found, pending = findScreenFace\(context\.profileKey, context\)\s+if not found and pending then\s+M\.faceRetry = /);
  assert.match(speechSource, /if M\.faceRetry and not paused then retryFace\(delta\) end\s+if M\.continuous then updateContinuous/);
  assert.match(speechSource, /if M\.faceRetry then M\.faceChunk = \{timeline = timeline, duration = audio\.duration, expected = expected\} end/);
  assert.match(speechSource, /M\.faceActor, M\.faceEntity, M\.faceContext, M\.faceRetry, M\.faceChunk = nil, nil, nil, nil, nil/);
  assert.match(speechSource, /M\.faceRetry, M\.faceChunk = nil, nil\s+M\.captionHidden = nil/);
});

test('Face.reds: the screen-face watch is checked only while a rig is watched, before the crowd mode, and keeps the gate', () => {
  const reds = read('../r6/scripts/CyberpunkConvai/Face.reds');
  const world = reds.slice(reds.indexOf('private cb func OnWorldInitialize'), reds.indexOf('// A watched screen face'));
  assert.match(world, /let screens = ArraySize\(this\.m_screenRigs\) > 0;\s+if this\.m_crowdMode == 0 && !screens \{ return; \};/);
  assert.match(world, /if index >= 0 && screens && this\.PrepareScreenFace\(npc, face, index\) \{ return; \};[\s\S]+?if index < 0 \{ return; \};\s+if this\.m_crowdMode == 0 \{ return; \};/);
  const prepare = reds.slice(reds.indexOf('private func PrepareScreenFace'), reds.indexOf('private func ScreenSlot'));
  assert.match(prepare, /this\.CheckRig\(face\)/);
  assert.match(prepare, /let graph = this\.m_crowdGated\[index\];/, 'the gated graph, never the ungated one');
  assert.doesNotMatch(prepare, /m_crowdPlain/);
  assert.match(reds, /public func WatchScreenFace\(rig: String, watch: Bool\) -> Int32/);
  assert.match(reds, /ArraySize\(this\.m_screenRigs\) < 4 && StrEndsWith\(rig, "\.rig"\)/);
  assert.match(reds, /public func ScreenFace\(rig: String\) -> EntityID/);
});

test('repeatOk: a remark may be said although it repeats a recent line; the option reaches the bridge request and nothing else changes', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'gun', name = 'Skippy', anchor = 'player', minGap = 0})
    assert(handle:remark('gun', {event = 'welcome', text = 'V sat down.', priority = 4, maxWords = 20, repeatOk = true}))
    assert(M._test.queue()[1].event.repeatOk == true)
    tick()
    assert(submitted[1].context.addon.repeatOk == true, 'the request carries it')
    state.pendingId, state.speechId = nil, submitted[1].context.requestId
    tick(); state.speechId = nil; tick(); now = now + 30; tick(30)
    assert(handle:remark('gun', {event = 'plain', text = 'Something.', priority = 4, maxWords = 20}))
    tick()
    assert(submitted[2].context.addon.repeatOk == nil, 'an ordinary remark is dropped for a repeat, as before')
    assert(handle:remark('gun', {event = 'other', text = 'Something.', priority = 4, repeatOk = 'yes'}) ~= nil)
    assert(M._test.queue()[1] == nil or M._test.queue()[1].event.repeatOk == false)
  `);
});

test('replaces: a remark standing in for a muted game line is written while that line plays, kept silent until it is over, and plays right after it', () => {
  run(`${WORLD}${CAB}
    player.vehicle = cab
    tick()
    -- The game's line is muted (its voice cannot be stopped): five seconds of it still play.
    local rule = {name = 'Delamain', audio = {'vo_3d'}, audioVerified = false, addon = M._test.addonOf and M._test.addonOf('cab') or nil}
    M.gameLine(5, 'Delamain', true)
    assert(handle:remark('voice', {event = 'arrival', priority = 5, ttl = 12, patience = 25, replaces = true, repeatOk = true})); tick()
    assert(#submitted == 1, 'asked for at once, not after the game line')
    local context = submitted[1].context
    assert(holds[1] == context.requestId, 'kept silent while the game line plays')
    state.pendingId, state.speechId = nil, context.requestId
    tick(); tick(2)
    assert(M._test.flight().stage == 'held' and #events == 0, 'voiced, not heard')
    tick(2.5)
    assert(M._test.flight().stage == 'held', 'the line is still playing (plus the short gap)')
    tick(0.6)
    assert(holds[#holds] == 'nil', 'released a moment after the game line')
    tick()
    assert(events[1] == 'remarkStarted:arrival', tostring(events[1]))
    -- Without replaces the same remark waits for the line first and is written only after it (as before).
    state.speechId = nil; tick(); tick(30)
    M.gameLine(5, 'Delamain', true)
    assert(handle:remark('voice', {event = 'plain', priority = 5, ttl = 12, patience = 25})); tick()
    assert(#submitted == 1, 'an ordinary patient remark is not written before the line is over')
  `);
});

test('replaces: asked for before the game line was seen, the remark in flight is kept silent as soon as the line is seen', () => {
  run(`${WORLD}${CAB}
    player.vehicle = cab
    tick()
    assert(handle:remark('voice', {event = 'ride-start', priority = 4, ttl = 12, patience = 20, replaces = true})); tick()
    assert(#submitted == 1 and holds[1] == nil, 'no game line seen yet: nothing to hold for')
    local id = submitted[1].context.requestId
    M.gameLine(3, 'Delamain', true)
    tick()
    assert(holds[1] == id, 'held from the moment the line is seen')
    state.pendingId, state.speechId = nil, id
    tick(); assert(M._test.flight().stage == 'held')
    tick(3.5)
    assert(holds[#holds] == 'nil')
    tick()
    assert(events[1] == 'remarkStarted:ride-start', tostring(events[1]))
  `);
});

test('replaces: the speaker\'s gap does not refuse a line that stands in for the game\'s own; an ordinary remark is still refused inside it', () => {
  run(`${WORLD}${CAB}
    player.vehicle = cab
    tick()
    assert(handle:remark('voice', {event = 'first', priority = 4, ttl = 12})); tick()
    state.pendingId, state.speechId = nil, submitted[1].context.requestId
    tick(); state.speechId = nil; tick()
    local ok, why = handle:remark('voice', {event = 'plain', priority = 4})
    assert(ok == false and why == 'speaker-cooldown', tostring(why))
    local made, reason = handle:remark('voice', {event = 'ride-start', priority = 4, ttl = 12, replaces = true})
    assert(made, 'inside the gap: ' .. tostring(reason))
    tick(); tick(3)
    assert(#submitted == 2 and submitted[2].context.addon.event == 'ride-start', 'and it is sent in the gap too')
  `);
});

test('handle:after: runs a function once on the add-on tick, bounded to eight pending, forgotten by a reset, an error is logged and harms nothing', () => {
  run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'cab', name = 'Delamain', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'voice', name = 'Delamain', anchor = 'vehicle'})
    local ran = {}
    assert(select(2, handle:after(1, 'no')) == 'fn must be a function')
    assert(handle:after(2, function() ran[#ran + 1] = 'two' end))
    assert(handle:after(0.5, function() ran[#ran + 1] = 'half' end))
    assert(handle:after(0.5, function() error('boom') end))
    assert(handle:after(0.5, function() ran[#ran + 1] = 'after-error' end))
    tick(0.3)
    assert(#ran == 0, 'not before its time')
    tick(0.3)
    assert(table.concat(ran, ',') == 'half,after-error', table.concat(ran, ','))
    local failed = false
    for _, line in ipairs(logs) do if line:find('after() callback of cab failed', 1, true) then failed = true end end
    assert(failed, 'the error is logged')
    tick(0.3); tick(1.5)
    assert(table.concat(ran, ',') == 'half,after-error,two', 'once, in its turn')
    tick(5)
    assert(#ran == 3, 'never again')
    for index = 1, 8 do assert(handle:after(5, function() ran[#ran + 1] = 'x' end), tostring(index)) end
    local ok, why = handle:after(5, function() end)
    assert(ok == false and why == 'too-many', tostring(why))
    M.reset('load')
    tick(10)
    assert(#ran == 3, 'a session reset forgets the pending ones')
  `);
});

const UNLESS_LINE = `${WORLD}${CAB}
    player.vehicle = car
    tick()
    handle:replaceGameLines({name = 'Delamain', match = function(line) return line.speakerName == 'Delamain' end, audio = {'vo_3d'}, audioVerified = false})
    local rule = M.matchLine({speakerName = 'Delamain'}, {})
    local function muted(id) M.mutedLine(rule, {seconds = 2, measured = true, id = id, subtitle = 'filtered', audio = 'stop-sent(vo_3d)'}) end
`;

test('unlessGameLine: a muted game line whose voice stop is not verified counts as heard; the remark asked after it is refused, one asked within 3 s too, one asked later is not', () => {
  run(`${UNLESS_LINE}
    muted('000009')
    local ok, why = handle:remark('voice', {event = 'arrival', priority = 5, ttl = 12, replaces = true, unlessGameLine = true})
    assert(ok == false and why == 'game-line', tostring(why))
    -- Without the option the same remark is made as before.
    assert(handle:remark('voice', {event = 'plain', priority = 5, ttl = 12, replaces = true}))
    M._test.queue()[1] = nil
    tick(2.9)
    ok, why = handle:remark('voice', {event = 'arrival', priority = 5, ttl = 12, replaces = true, unlessGameLine = true})
    assert(ok == false and why == 'game-line', 'still inside the look-back: ' .. tostring(why))
    tick(0.3)
    assert(handle:remark('voice', {event = 'arrival', priority = 5, ttl = 12, replaces = true, unlessGameLine = true}), 'a later moment has its own line')
  `);
});

test('unlessGameLine: the line seen while the remark waits or is written drops it; the remark that already plays is not cut; a verified stop never counts', () => {
  run(`${UNLESS_LINE}
    -- Queued, not sent yet: dropped when the line is seen.
    state.automatic = true
    assert(handle:remark('voice', {event = 'ride-start', priority = 4, ttl = 12, replaces = true, unlessGameLine = true}))
    assert(#M._test.queue() == 1)
    muted('000005')
    assert(#M._test.queue() == 0 and events[1] == 'remarkDropped:game-line-heard', tostring(events[1]))
    state.automatic = false
    tick(5)
    -- Being written: released unheard, nothing is spoken.
    assert(handle:remark('voice', {event = 'arrival', priority = 5, ttl = 12, replaces = true, unlessGameLine = true})); tick()
    assert(#submitted == 1 and M._test.flight().stage == 'pending')
    muted('000009')
    assert(M._test.flight() == nil, 'taken back before a word')
    assert(events[#events] == 'remarkFinished:game-line-heard:false', tostring(events[#events]))
    tick(5)
    -- Playing already: left to finish.
    assert(handle:remark('voice', {event = 'ride-start', priority = 4, ttl = 12, replaces = true, unlessGameLine = true})); tick()
    local context = submitted[#submitted].context
    state.pendingId, state.speechId = nil, context.requestId
    tick(); tick()
    assert(M._test.flight().stage == 'playing')
    muted('000010')
    assert(M._test.flight() ~= nil and M._test.flight().stage == 'playing', 'a line that has started is not cut')
  `);
  run(`${WORLD}${CAB}
    player.vehicle = car
    tick()
    handle:replaceGameLines({name = 'Delamain', match = function() return true end, audio = {'vo_3d'}, audioVerified = true})
    local rule = M.matchLine({speakerName = 'Delamain'}, {})
    M.mutedLine(rule, {seconds = 2, measured = true, id = '000001', subtitle = 'filtered', audio = 'stop-sent(vo_3d)'})
    assert(handle:remark('voice', {event = 'arrival', priority = 5, ttl = 12, replaces = true, unlessGameLine = true}), 'the voice really stopped: ours may play')
    M.mutedLine(rule, {seconds = 2, measured = true, id = '000002', subtitle = 'filtered', audio = 'stop-sent(vo_3d)'})
    assert(#M._test.queue() == 1, 'and a later muted line does not take it back')
  `);
});
