import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {LUA_HARNESS, WORLD, runLua} from './addon-lua-harness.mjs';

// The edges of the game side of the add-on API (mod/addons.lua): what a call into the API may carry, what an add-on's own code may do
// to it, and what it reads from the files around it. The ordinary paths are in addons-lua.test.mjs. A test marked `todo` asserts what
// the docs (docs/ADDON_API.md) promise and currently fails.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const lua = body => runLua(`${WORLD}\nM.attach(host)\n${body}`);
const REGISTER = `local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))`;

test('handle API: a wrong or oversized argument is refused with its reason, a number out of range is clamped, and nothing throws or leaks into the state', () => {
  lua(`
    ${REGISTER}
    local function why(...) local first, reason = ...; assert(first == false or first == nil, 'accepted: ' .. tostring(reason)); return reason end
    local big = string.rep('x', 5000)
    -- register
    assert(why(M.public.register(nil)) == 'register needs a table' and why(M.public.register('skippy')) == 'register needs a table')
    for _, id in ipairs({'', 'a', 'Bad', 'a b', '../x', string.rep('a', 25), 5}) do assert(why(M.public.register({id = id, name = 'X', requires = '1.0'})) == 'invalid id', tostring(id)) end
    assert(why(M.public.register({id = 'fine', name = '   ', requires = '1.0'})) == 'name is required')
    for _, requires in ipairs({'2.0', '1.1', '0.9', 'latest', '1', 5, true}) do
        assert(tostring(why(M.public.register({id = 'newer', name = 'N', requires = requires}))):find('^incompatible'), tostring(requires))
    end
    assert(not M.isSpeaker('addon-newer-x') and #M.settingsSections() == 0, 'a refused registration leaves nothing behind')
    -- speaker
    for _, def in ipairs({{}, {id = 'Gun', name = 'X'}, {id = '../x', name = 'X'}, {id = string.rep('a', 25), name = 'X'}, {id = 5, name = 'X'}}) do
        assert(why(handle:speaker(def)) == 'invalid speaker id')
    end
    assert(why(handle:speaker(nil)) == 'invalid speaker id' and why(handle:speaker('gun')) == 'invalid speaker id')
    assert(why(handle:speaker({id = 'a1'})) == 'speaker name is required' and why(handle:speaker({id = 'a1', name = '  '})) == 'speaker name is required')
    for _, anchor in ipairs({'sky', 5, true, {}}) do assert(why(handle:speaker({id = 'a1', name = 'A', anchor = anchor})) == 'anchor must be player, vehicle or a function') end
    for _, field in ipairs({'available', 'voiceFrom', 'showsReply', 'approach'}) do
        assert(why(handle:speaker({id = 'a1', name = 'A', [field] = 'yes'})) == field .. ' must be a function', field)
    end
    for _, face in ipairs({'rig', {}, {rig = 'no spaces allowed.rig'}, {rig = 'base\\\\x.mesh'}, {rig = string.rep('a', 200) .. '.rig'}}) do
        assert(why(handle:speaker({id = 'a1', name = 'A', face = face})) == 'face.rig must be a .rig path')
    end
    assert(not M.isSpeaker('addon-skippy-a1'), 'no refused speaker exists')
    -- speaker options are clamped: the gap runs from 2 to 600 s, the priority from 0 to 100, the scene tiers are real ones
    local function option(id, def) def.id, def.name = id, id; assert(handle:speaker(def)); return M._test.speakers['addon-skippy-' .. id] end
    assert(option('gap-default', {}).minGap == 8 and option('gap-low', {minGap = 0}).minGap == 2 and option('gap-high', {minGap = 99999}).minGap == 600)
    assert(option('gap-text', {minGap = 'soon'}).minGap == 8 and option('gap-nan', {minGap = 0/0}).minGap == 8)
    assert(option('prio-high', {talkPriority = 500}).talkPriority == 100 and option('prio-low', {talkPriority = -3}).talkPriority == 0)
    assert(table.concat(option('tiers-default', {}).sceneTiers, ',') == '1' and table.concat(option('tiers-empty', {sceneTiers = {}}).sceneTiers, ',') == '1')
    assert(table.concat(option('tiers-text', {sceneTiers = 'all'}).sceneTiers, ',') == '1' and table.concat(option('tiers-junk', {sceneTiers = {0, 6, 'x', true}}).sceneTiers, ',') == '1')
    assert(table.concat(option('tiers-mixed', {sceneTiers = {1, 9, 'x', 2, 5}}).sceneTiers, ',') == '1,2,5')
    local speaker = option('gun', {minGap = 2})
    -- remark: the speaker, the event name, the facts and the callbacks are checked; numbers are clamped
    assert(why(handle:remark('nobody', {event = 'x'})) == 'unknown speaker' and why(handle:remark(nil, {event = 'x'})) == 'unknown speaker' and why(handle:remark(5, {event = 'x'})) == 'unknown speaker')
    for _, event in ipairs({{}, {event = 5}, {event = ''}, {event = 'has space'}, {event = 'line' .. string.char(10) .. 'break'}, {event = string.rep('e', 49)}, 'kill', 5, true}) do
        assert(tostring(why(handle:remark('gun', event))):find('^event name is required'), tostring(event))
    end
    assert(why(handle:remark('gun', {event = 'e', facts = 5})) == 'facts must be a table' and why(handle:remark('gun', {event = 'e', facts = 'text'})) == 'facts must be a table')
    assert(why(handle:remark('gun', {event = 'e', facts = {note = big}})) == 'facts are too large')
    assert(why(handle:remark('gun', {event = 'e', hold = 3})) == 'hold must be a function' and why(handle:remark('gun', {event = 'e', menus = 'x'})) == 'menus must be true, false or a function')
    assert(#M._test.queue() == 0, 'no refused remark was queued')
    assert(handle:remark('gun', {event = 'e1', priority = 99, maxWords = 1000, ttl = -5, patience = 999, holdMax = 999, faceWait = 99, text = big, cooldown = 1e9}))
    assert(handle:remark('gun', {event = 'e2', priority = 0/0, maxWords = 0/0, ttl = 0/0, patience = 0/0}))
    assert(handle:remark('gun', {event = 'e3', priority = 2.7, maxWords = 2, ttl = 1e9}))
    assert(handle:remark('gun', {event = 'e4', priority = '5', maxWords = '9', ttl = '5'}))
    assert(handle:remark('gun', {event = 'e5', priority = 1/0, maxWords = 3.9}))
    local entries = {}
    for _, entry in ipairs(M._test.queue()) do entries[entry.event.event] = entry end
    local e1 = entries.e1
    assert(e1.event.priority == 5 and e1.event.maxWords == 60 and e1.ttl == 1 and e1.holdMax == 30 and e1.faceWait == 5 and e1.event.cooldown == 3600 and #e1.event.text == 600)
    assert(e1.patienceEnd - e1.at == 60 and e1.patient == true)
    assert(entries.e2.event.priority == 2 and entries.e2.event.maxWords == 14 and entries.e2.ttl == 3 and entries.e2.patient == false, 'NaN falls back to the defaults')
    assert(entries.e3.event.priority == 2 and entries.e3.event.maxWords == 3 and entries.e3.ttl == 30, 'a fraction rounds down, a minimum and a maximum hold')
    assert(entries.e4.event.priority == 2 and entries.e4.event.maxWords == 14 and entries.e4.ttl == 3, 'numbers given as text are not numbers')
    assert(entries.e5.event.priority == 5 and entries.e5.event.maxWords == 3)
    assert(handle:cancel('gun') and #M._test.queue() == 0)
    -- context blocks: key and text are bounded, nine blocks are one too many, an unknown tier is the default one
    for _, key in ipairs({5, '', 'bad key', string.rep('k', 41)}) do assert(why(handle:setContext('gun', key, 'text')) == 'invalid key') end
    assert(why(handle:setContext('nobody', 'k', 'text')) == 'unknown speaker')
    assert(handle:setContext('gun', 'big', big, 'now') and speaker.contexts.big:len() == 1500 and speaker.contextTiers.big == 'world')
    assert(handle:setContext('gun', 'vol', 'x', 'volatile') and speaker.contextTiers.vol == 'volatile')
    for index = 1, 6 do assert(handle:setContext('gun', 'k' .. index, 'x')) end
    assert(why(handle:setContext('gun', 'ninth', 'x')) == 'too many context blocks')
    assert(handle:setContext('gun', 'k1', 'changed'), 'a block that exists can still change at the limit')
    assert(handle:setContext('gun', 'never-set', nil), 'clearing a block that is not there is fine')
    assert(handle:setContext('gun', 'k1', '   ') and speaker.contexts.k1 == nil, 'blank text clears')
    for index = 1, 4 do assert(handle:setCompanionContext('c' .. index, 'x')) end
    assert(why(handle:setCompanionContext('c5', 'x')) == 'too many companion blocks' and why(handle:setCompanionContext('bad key', 'x')) == 'invalid key')
    assert(handle:setCompanionContext('c1', big) and #M._test.addons.skippy.companion.c1 == 600)
    -- state, mode, memory
    assert(why(handle:setState(5)) == 'state must be a table or nil' and why(handle:setState('x')) == 'state must be a table or nil')
    assert(why(handle:setState({note = big})) == 'state is too large' and handle:setState({ok = true}) and handle:setState(nil))
    for _, mode in ipairs({5, '', 'Bad Mode', string.rep('m', 25), '../x'}) do assert(why(handle:setMode('gun', mode)) == 'invalid mode id') end
    assert(why(handle:remember('gun', 5)) == 'memory text is required' and why(handle:remember('nobody', 'x')) == 'unknown speaker')
    for index = 1, 15 do assert(handle:remember('gun', 'memory ' .. index .. string.rep('m', 400))) end
    local memories = M._test.addons.skippy.memories
    assert(#memories == 12 and memories[1].text:sub(1, 8) == 'memory 4' and #memories[1].text == 300 and memories[12].text:sub(1, 9) == 'memory 15', 'the last twelve, each cut to 300')
    -- events
    assert(why(handle:on('nope', function() end)) == 'unknown event nope' and tostring(why(handle:on(nil, function() end))):find('^unknown event') and tostring(why(handle:on({}, function() end))):find('^unknown event'))
    assert(why(handle:on('combatStarted', nil)) == 'handler must be a function' and why(handle:on('combatStarted', 'run')) == 'handler must be a function')
    -- settings: ids, labels, kinds and element counts are checked; the section holds at most 24 items; a default is clamped into range
    local function item(id, extra) local out = {id = id, label = 'Label', kind = 'bool'}; for key, value in pairs(extra or {}) do out[key] = value end; return out end
    for _, section in ipairs({{}, {items = 'x'}, 'x'}) do assert(why(handle:settings(section)) == 'settings need items') end
    assert(why(handle:settings({items = {item('bad id')}})) == 'invalid setting id' and why(handle:settings({items = {item(string.rep('i', 33))}})) == 'invalid setting id')
    assert(why(handle:settings({items = {item(5)}})) == 'invalid setting id' and why(handle:settings({items = {'x'}})) == 'invalid setting id')
    assert(why(handle:settings({items = {item('speed', {label = '  '})}})) == 'setting speed needs a label')
    assert(why(handle:settings({items = {item('speed', {kind = 'select', elements = {'one'}})}})) == 'setting speed needs 2 to 12 elements')
    assert(why(handle:settings({items = {item('speed', {kind = 'select', elements = {'1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'}})}})) == 'setting speed needs 2 to 12 elements')
    assert(why(handle:settings({items = {item('speed', {kind = 'select', elements = {'a', ' '}})}})) == 'setting speed has an empty element')
    local many = {}
    for index = 1, 30 do many[index] = item('item' .. index, {label = string.rep('L', 100)}) end
    many[2] = item('pick', {kind = 'select', elements = {'a', 'b', 'c'}, default = 99})
    many[3] = item('pick_low', {kind = 'select', elements = {'a', 'b'}, default = 0})
    assert(handle:settings({title = string.rep('T', 100), description = string.rep('D', 1000), items = many}))
    local section = M.settingsSections()[1]
    assert(#section.title == 60, 'the title is cut to 60')
    local custom = {}
    for _, entry in ipairs(section.items) do if entry.mcmId:find('^addon:skippy:item') or entry.mcmId:find(':pick') then custom[#custom + 1] = entry end end
    assert(#custom == 24, 'at most 24 items: ' .. #custom)
    assert(#custom[1].label == 80, 'labels are cut to 80')
    assert(handle:setting('pick') == 3 and handle:setting('pick_low') == 1, 'a select default is clamped into its elements')
    assert(handle:setting('nothing') == nil and handle:setting(nil) == nil and handle:setting({}) == nil)
    -- notices: text only, cut to 200, one repeat within 10 s is dropped
    tick(); local base = #notices   -- the refused registrations above each said one thing already
    assert(handle:notify(nil) == false and handle:notify('') == false and handle:notify(5) == false and handle:notify({}) == false)
    assert(handle:notify(string.rep('n', 300)) == true)
    tick(); assert(#notices == base + 1 and #notices[base + 1] == 200)
    assert(handle:notify(string.rep('n', 300))); tick(2); assert(#notices == base + 1, 'a repeat within 10 s is dropped')
    tick(10); assert(handle:notify(string.rep('n', 300))); tick(); assert(#notices == base + 2)
    -- called with a dot, a wrong self or no self, no method throws
    local names = {}
    for name, fn in pairs(getmetatable(handle).__index) do if type(fn) == 'function' then names[#names + 1] = name end end
    assert(#names >= 20, 'the methods were found')
    for _, name in ipairs(names) do
        for _, self in ipairs({'', 'x', {}, {record = {}}}) do
            local ok, err = pcall(handle[name], self, 'gun', {event = 'x'}, 5, 6)
            assert(ok, name .. ' threw with a wrong self: ' .. tostring(err))
        end
        assert(pcall(handle[name]), name .. ' threw with no arguments' )
    end
    tick(3)
    assert(#submitted == 0 and #M._test.queue() == 0 and M._test.flight() == nil, 'none of it started a remark')
  `);
});

test('a remarkDropped handler that asks for the same remark again while a scene is on must not spin the scheduler within one tick', () => {
  lua(`
    ${REGISTER}
    handle:speaker({id = 'gun', name = 'Skippy', minGap = 2})
    local calls = 0
    handle:on('remarkDropped', function()
        calls = calls + 1
        if calls < 100 then handle:remark('gun', {event = 'retry', priority = 2}) end   -- the cut-off stands for "forever"
    end)
    state.sample = {available = true, combat = false, tier = 1, dialogue = true}
    tick()
    assert(handle:remark('gun', {event = 'first', priority = 2}))
    tick()
    assert(calls < 10, 'the drop handler ran ' .. calls .. ' times in one tick')
  `);
});

test('add-ons that fail are isolated: every callback of one throwing changes nothing for another or for the main mod, the log stays bounded, and disabling or replacing an add-on is clean', () => {
  lua(`
    local bad = assert(M.public.register({id = 'bad', name = 'Bad', version = '1.0.0', requires = '1.0'}))
    local good = assert(M.public.register({id = 'good', name = 'Good', version = '1.0.0', requires = '1.0'}))
    local boom = function() error('boom') end
    bad:speaker({id = 'one', name = 'One', minGap = 2, available = boom, anchor = boom, voiceFrom = boom, showsReply = boom, approach = boom})
    bad:speaker({id = 'two', name = 'Two', minGap = 2, anchor = function() return {} end})
    good:speaker({id = 'voice', name = 'Voice', minGap = 2})
    assert(bad:replaceGameLines({name = 'Bad', match = boom, active = boom, silence = boom}))
    for _, event in ipairs({'sessionStarted', 'combatStarted', 'combatEnded', 'sceneStarted', 'turnStarted', 'speechStarted', 'remarkFinished', 'settingChanged'}) do bad:on(event, boom) end
    assert(bad:after(0.1, boom))
    assert(bad:remark('one', {event = 'a', priority = 3, hold = boom, menus = boom, relevant = boom, patience = 10}))
    assert(bad:remark('two', {event = 'b', priority = 3}))
    local start = #logs
    for index = 1, 100 do
        state.sample = {available = true, combat = index % 2 == 0, tier = 1}
        tick()
        assert(M.matchLine({}, {}) == nil and #M.talkCandidates(player, false) == 1, 'the main mod keeps working beside it')
        assert(M.voiceSource('addon-bad-one', player) == nil and M.faceActor('addon-bad-one', player) == nil)
    end
    local noisy = #logs - start
    assert(noisy <= 40, 'a failing add-on filled the log with ' .. noisy .. ' lines')
    for _ = 1, 200 do tick() end
    assert(#logs - start == noisy, 'once its handlers are removed it is silent: no line per tick')
    assert(good:remark('voice', {event = 'ok', priority = 3}))
    tick(3)
    local mine = 0
    for _, entry in ipairs(submitted) do if entry.context.profileKey == 'addon-good-voice' then mine = mine + 1 end end
    assert(mine == 1, 'the other add-on spoke')
    -- Disabling one add-on: its remark in flight is stopped, its waiting one dropped, nothing of the other is touched.
    local finished = {}
    good:on('remarkFinished', function(payload) finished[#finished + 1] = payload.reason end)
    local other = assert(M.public.register({id = 'other', name = 'Other', version = '1.0.0', requires = '1.0'}))
    other:speaker({id = 'voice', name = 'Other', minGap = 2})
    state.pendingId = nil; state.speechId = nil; tick(30); tick(5)
    assert(good:remark('voice', {event = 'one', priority = 3})); tick()
    assert(M._test.flight().speaker.addon.id == 'good')
    assert(other:remark('voice', {event = 'waiting', priority = 3}))
    good:setEnabled(false)
    assert(finished[#finished] == 'add-on-disabled' and dropped[#dropped].reason == 'add-on-disabled', tostring(finished[#finished]))
    assert(#M._test.queue() == 1 and M._test.queue()[1].speaker.addon.id == 'other', 'the other add-on\\'s waiting remark stays')
    assert(select(2, good:remark('voice', {event = 'two'})) == 'add-on disabled' and select(2, good:stock('voice', 'k', {text = 'x'})) == 'add-on disabled')
    assert(select(2, good:prepare('voice')) == 'speaker-unavailable')
    local keys = {}
    for _, candidate in ipairs(M.talkCandidates(player, false)) do keys[#keys + 1] = candidate.profileKey end
    assert(table.concat(keys, ',') == 'addon-other-voice', table.concat(keys, ','))
    assert(M.matchLine({}, {}) == nil)
    tick(3)
    assert(M._test.flight() and M._test.flight().speaker.addon.id == 'other', 'the other add-on speaks on')
    good:setEnabled(true)
    assert(#M.talkCandidates(player, false) == 2, 'enabled again, it is offered again')
    -- Registering the same id again replaces the earlier registration: the old handle does nothing any more, and the old handlers are gone.
    local oldCalls = 0
    other:on('combatStarted', function() oldCalls = oldCalls + 1 end)
    local fresh = assert(M.public.register({id = 'other', name = 'Other', version = '1.0.1', requires = '1.0'}))
    for _, result in ipairs({{other:remark('voice', {event = 'x'})}, {other:speaker({id = 'again', name = 'A'})}, {other:setMode('voice', 'calm')}, {other:setState({a = 1})},
        {other:on('combatEnded', function() end)}, {other:setEnabled(false)}, {other:settings({items = {}})}, {other:setCompanionContext('k', 't')}, {other:stock('voice', 'k', {text = 'x'})}}) do
        assert(result[1] == false or result[1] == nil, 'an old handle was served: ' .. tostring(result[2]))
    end
    assert(not M.isSpeaker('addon-other-voice'), 'the new registration starts with no speaker')
    state.sample = {available = true, combat = false, tier = 1}; tick()
    state.sample = {available = true, combat = true, tier = 1}; tick()
    assert(oldCalls == 0 and M._test.addons.other.enabled == true)
    assert(fresh:speaker({id = 'voice', name = 'Other'}) == 'addon-other-voice')
  `);
});

test('re-registering an id forgets what the earlier registration had waiting', {
  todo: 'BUG: api.register for an id that exists drops the old speakers but leaves the old registration\'s queued remark; the next tick sends it for a profile key that M.isSpeaker no longer knows'
}, () => {
  lua(`
    local old = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    old:speaker({id = 'gun', name = 'Skippy', minGap = 2})
    assert(old:remark('gun', {event = 'kill', priority = 3}))
    assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.1', requires = '1.0'}))
    tick()
    assert(#submitted == 0, 'a remark of the replaced registration was sent for ' .. tostring(submitted[1] and submitted[1].context.profileKey))
  `);
});

test('files the game reads: addons-status.json says each problem once and nothing when empty or foreign; addon-settings.json that is empty, corrupt or out of range gives the defaults', () => {
  const notices = status => lua(`
    files['runtime/addons-status.json'] = ${status}
    ${REGISTER}
    M.tick(player, 0.1, false); M.tick(player, 0.1, false)
    assert(#notices == 0, 'nothing is read before the world is ready')
    tick(); tick(); tick()
    local first = #notices
    files['runtime/addons-status.json'] = json.encode({version = 1, addons = {{name = 'Later', status = 'invalid', reason = 'written after the first read'}}})
    tick(30); tick(30)
    assert(#notices == first, 'the file is read once per game start')
    return table.concat(notices, string.char(10))
  `);
  for (const empty of ["''", "'   '", "'{not json'", "json.encode({version = 2, addons = {{name = 'X', status = 'invalid', reason = 'bad'}}})", "json.encode({version = 1, addons = 'x'})",
    "json.encode({version = 1, addons = {'garbage', 42, {name = 'No reason', status = 'invalid'}, {id = 'skippy', status = 'ready'}}})"]) {
    assert.equal(notices(empty), '', `${empty} should say nothing`);
  }
  const said = notices(`json.encode({version = 1, addons = {
    {id = 'skippy', name = 'Skippy', status = 'ready'},
    {id = 'broke', name = 'Broken Mod', status = 'invalid', reason = 'schema must be 1'},
    {folder = 'TooNew', status = 'incompatible', reason = 'needs add-on API 1.9; this AI NPC Cyberpunk Mod has 1.0'},
    {name = 'Twin', status = 'duplicate', reason = 'another add-on uses this id'},
    {name = 'Huge', status = 'invalid', reason = string.rep('x', 500)}}})`).split('\n');
  assert.equal(said.length, 4, 'one notice for each add-on that is not ready, none for the ready one');
  assert.equal(said[0], 'Broken Mod could not load: schema must be 1');
  assert.equal(said[1], 'TooNew needs a newer AI NPC Cyberpunk Mod (needs add-on API 1.9; this AI NPC Cyberpunk Mod has 1.0). Update AI NPC Cyberpunk Mod.');
  assert.equal(said[2], 'Twin could not load: another add-on uses this id');
  assert.equal(said[3], `Huge could not load: ${'x'.repeat(160)}`, 'a long reason is cut');
  // The saved settings: defaults for anything unreadable, and a declared setting whose saved value has the wrong type or range is reset.
  const gaps = content => lua(`
    files['runtime/addon-settings.json'] = ${content}
    ${REGISTER}
    handle:speaker({id = 'gun', name = 'Skippy', minGap = 2})
    local gap, cap, mark = M.settingsSections()[1].items[1], M.settingsSections()[1].items[2], M.settingsSections()[1].items[3]
    return table.concat({gap.value, cap.value, tostring(mark.value)}, ',')
  `);
  for (const bad of ["''", "'  '", "'{not json'", "'null'", "json.encode({version = 2, addons = {skippy = {remarkGap = 1}}})", "json.encode({version = 1, addons = 5})",
    "json.encode({version = 1, addons = {skippy = 5}})", "json.encode({version = 1, addons = {skippy = {remarkGap = 99, remarkCap = 'x', markLines = 'no'}}})",
    "json.encode({version = 1, addons = {skippy = {remarkGap = 0, remarkCap = -1}}})"]) {
    assert.equal(gaps(bad), '4,4,true', bad);
  }
  assert.equal(gaps("json.encode({version = 1, addons = {skippy = {remarkGap = 2, remarkCap = 6, markLines = false}}})"), '2,6,false', 'valid saved values are kept');
  assert.equal(lua(`
    files['runtime/addon-settings.json'] = json.encode({version = 1, addons = {skippy = {personality = 99, remarks = 'yes', speed = 1.5, kept = 2}}})
    ${REGISTER}
    handle:settings({items = {
      {id = 'personality', label = 'P', kind = 'select', default = 2, elements = {'a', 'b'}}, {id = 'remarks', label = 'R', kind = 'bool', default = true},
      {id = 'speed', label = 'S', kind = 'select', default = 1, elements = {'a', 'b'}}, {id = 'kept', label = 'K', kind = 'select', default = 1, elements = {'a', 'b'}}}})
    return table.concat({handle:setting('personality'), tostring(handle:setting('remarks')), handle:setting('speed'), handle:setting('kept')}, ',')
  `), '2,true,1,2', 'out-of-range, wrong-typed and fractional saved values go back to the default; a valid one stays');
});

test('the main mod does not depend on an add-on: init.lua starts without addons.lua, no shipped file names an add-on, and the API surface is what the docs list', () => {
  // init.lua's loading block, run with an addons.lua that is missing, throws, or is not a module: the main mod goes on with no add-on API.
  const init = read('../mod/init.lua');
  const block = /do\n\s+local loaded, module = pcall\(dofile, 'addons\.lua'\)\n\s+convaiAddons = [^\n]+\nend/.exec(init)?.[0];
  assert.ok(block, 'the loading block is still in init.lua');
  const returned = /\nreturn \{addons = convaiAddons and convaiAddons\.public or nil\}\s*$/.test(init);
  assert.ok(returned);
  for (const loader of ["function() error('cannot open addons.lua') end", "function() error({}) end", "function() return nil end", "function() return 'not a table' end", "function() return 42 end"]) {
    runLua(`dofile = ${loader}
      ${block}
      assert(convaiAddons == nil, 'a broken addons.lua must leave no add-on API')
      local result = {addons = convaiAddons and convaiAddons.public or nil}
      assert(result.addons == nil and next(result) == nil)`);
  }
  runLua(`dofile = function() return {live = false, public = {version = '1.0'}} end
    ${block}
    assert(convaiAddons.live == false and convaiAddons.public.version == '1.0', 'a working module loads')`);
  // No file that ships with the main mod names an add-on, its CET folder or its repository, or reaches into addons/.
  const roots = ['../mod', '../bridge', '../r6/scripts/CyberpunkConvai'];
  const named = /AiNpcCyberpunkMod(?:Skippy|Delamain|Example)|addon-(?:skippy|delamain|example)-|delamain-cab|ai-npc-cyberpunk-mod-(?:skippy|delamain)|['"\/]addons\/(?:skippy|delamain|example)|from ['"][^'"]*addons\/|dofile\('addons\//;
  const offenders = [];
  const visit = (dir, base) => {
    for (const entry of readdirSync(new URL(`${dir}/`, import.meta.url), {withFileTypes: true})) {
      if (entry.isDirectory()) { visit(`${dir}/${entry.name}`, base); continue; }
      if (!/\.(lua|mjs|reds|js)$/.test(entry.name) || /\.test\.mjs$/.test(entry.name) || /^addon-(?:eval|lua-harness)/.test(entry.name)) continue;
      if (named.test(read(`${dir}/${entry.name}`))) offenders.push(`${dir}/${entry.name}`);
    }
  };
  for (const root of roots) visit(root);
  assert.deepEqual(offenders, [], 'the main mod must run, and pass its tests, with no add-on installed');
  // The API surface: the public table, and every handle method against docs/ADDON_API.md, in both directions.
  const docs = read('../docs/ADDON_API.md');
  const documented = new Set([...docs.matchAll(/\bhandle:(\w+)/g)].map(match => match[1]));
  const surface = runLua(`${WORLD}
    M.attach(host)
    ${REGISTER}
    local names, keys = {}, {}
    for name, fn in pairs(getmetatable(handle).__index) do if type(fn) == 'function' then names[#names + 1] = name end end
    for key in pairs(M.public) do keys[#keys + 1] = key end
    table.sort(names); table.sort(keys)
    return table.concat(keys, ',') .. '|' .. table.concat(names, ',')`);
  const [keys, names] = surface.split('|').map(part => part.split(','));
  assert.deepEqual(keys, ['compatible', 'major', 'minor', 'register', 'version'], 'nothing else is public to an add-on');
  assert.deepEqual(names.filter(name => !documented.has(name)), [], 'a handle method the docs never mention');
  assert.deepEqual([...documented].filter(name => !names.includes(name)), [], 'a handle method the docs promise and the API lacks');
  // The events in the docs are the events handle:on accepts, and the ones the docs say do not exist are refused.
  const table = /### Events\n([\s\S]*?)\n## /.exec(docs)[1];
  const events = [...table.matchAll(/^\| ((?:`\w+`(?: \/ )?)+) \|/gm)].flatMap(match => [...match[1].matchAll(/`(\w+)`/g)].map(item => item[1]));
  assert.equal(events.length, 18);
  assert.equal(runLua(`${WORLD}
    M.attach(host)
    ${REGISTER}
    local accepted, refused = {}, {}
    for _, name in ipairs({${events.map(name => `'${name}'`).join(',')}}) do if not handle:on(name, function() end) then refused[#refused + 1] = name end end
    for _, name in ipairs({'onUpdate', 'frame', 'tick', 'kill', 'headshot', 'damage', 'enemyKilled', 'playerHit'}) do if handle:on(name, function() end) then accepted[#accepted + 1] = name end end
    return table.concat(refused, ',') .. '|' .. table.concat(accepted, ',')`), '|', 'every documented event is accepted and no per-frame or combat-detail event exists');
});
