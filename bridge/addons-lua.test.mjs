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
    assert(#notices == 1 and notices[1] == 'Skippy needs a newer Cyberpunk Convai (add-on API 1.4; this version has 1.0). Update Cyberpunk Convai.', notices[1])
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
  assert.deepEqual([...new Set(calls)].sort(), ['attach', 'canDeliver', 'captionName', 'decorate', 'gameLine', 'isSpeaker', 'lineRulesWanted', 'matchLine', 'mutedLine', 'participantLive', 'replyError', 'talkCandidates']);
  // The game-line notice runs only for a live add-on: the dialogue module asks first (one function call per game subtitle line).
  assert.match(init, /onGameLineWanted = function\(\) return convaiAddons ~= nil and convaiAddons\.live == true end,\s+onGameLine = function\(seconds, kind, measured\) convaiAddons\.gameLine\(seconds, kind, measured\) end/);
  assert.match(init, /if key and not participants and convaiAddons and convaiAddons\.live and convaiAddons\.isSpeaker\(key\) then key = nil end/);
  assert.match(init, /if type\(reply\.errorCode\) == 'string' and reply\.errorCode:find\('\^addon%-'\) then\s+if convaiAddons and convaiAddons\.live then convaiAddons\.replyError\(pending, reply, player\) end\s+elseif keyId == 'key-memory'/);
  // The voice key addresses an add-on voice only on a computer that can recognise speech (asked on the key press); otherwise typed
  // messages only. No Convai warm-up or connect note is made for one.
  assert.match(init, /if voices and voices\[1\] and singleAction == 'cyberpunk_convai_voice' and not addonHears then[^]*?return nil\s+end\s+voices = nil\s+end/);
  assert.match(init, /if not person\.voiceOnly then audience\[#audience \+ 1\] = person\.profileKey end/);
  assert.match(init, /local connectNote = autoConnect and not participants and not primary\.voiceOnly and autoConnect\.talkNotice\(key, name\) or nil/);
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
  assert.match(speech, /if M\.voiceOnly and NO_FACE\[key\] then return noFace end\s+return facial\[key\]/);
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
