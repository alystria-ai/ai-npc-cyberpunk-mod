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
  assert.deepEqual(JSON.parse(saved), {version: 1, addons: {skippy: {personality: 2, remarks: true, remarkGap: 4, remarkCap: 4}}});
});

test('remark pacing: the two settings, half the gap for priority 5, the cap with its reserved slot, and unheard remarks are free', () => {
  const saved = run(`${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    handle:speaker({id = 'gun', name = 'Skippy', minGap = 2})
    -- Every add-on with a speaker gets "Time between remarks" (default 10 s) and "Most remarks per fight" (default 30).
    local sections = M.settingsSections()
    local gap, cap = sections[1].items[1], sections[1].items[2]
    assert(#sections == 1 and sections[1].title == 'Skippy' and gap.mcmId == 'addon:skippy:remarkGap' and cap.mcmId == 'addon:skippy:remarkCap')
    assert(table.concat(gap.elements, ',') == '4 s,6 s,8 s,10 s,15 s,20 s,30 s,60 s' and gap.default == 4 and gap.value == 4)
    assert(table.concat(cap.elements, ',') == '5,10,20,30,50,No limit' and cap.default == 4 and cap.value == 4)
    assert(gap.description:find('about 20 seconds', 1, true), 'the help text names the Local AI default')
    for _, reserved in ipairs({'remarkGap', 'remarkCap', 'remarkRate'}) do
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
  assert.deepEqual([...new Set(calls)].sort(), ['attach', 'canDeliver', 'decorate', 'isSpeaker', 'participantLive', 'replyError', 'talkCandidates']);
  assert.match(init, /if key and not participants and convaiAddons and convaiAddons\.live and convaiAddons\.isSpeaker\(key\) then key = nil end/);
  assert.match(init, /if type\(reply\.errorCode\) == 'string' and reply\.errorCode:find\('\^addon%-'\) then\s+if convaiAddons and convaiAddons\.live then convaiAddons\.replyError\(pending, reply, player\) end\s+elseif keyId == 'key-memory'/);
  // The voice key never addresses an add-on voice (typed messages only for now), and no Convai warm-up or connect note is made for one.
  assert.match(init, /if voices and voices\[1\] and singleAction == 'cyberpunk_convai_voice' then[^]*?return nil\s+end\s+voices = nil\s+end/);
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
