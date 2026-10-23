import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

const readinessSource = readFileSync(new URL('../mod/invitation-readiness.lua', import.meta.url), 'utf8');
const queueSource = readFileSync(new URL('../mod/manager-party.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

function run(body) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  try {
    const status = lauxlib.luaL_dostring(state, to_luastring(uiLocaleBootstrap + fixture + '\n' + body));
    assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1)));
  } finally { lua.lua_close(state); }
}

const fixture = String.raw`
local function copy(value)
    if type(value) ~= 'table' then return value end
    local out = {}; for key, child in pairs(value) do out[key] = copy(child) end; return out
end
local ms, world = 100000.0, {worldToken = 'lua-world-launch-a-1', generation = 1}
local files, encoded, writes, sequence = {}, {}, {}, 0
local failure, unknown = nil, nil
json = {
    encode = function(value)
        if failure == 'encode' then error('encode failed') end
        sequence = sequence + 1; local raw = 'json-' .. sequence; encoded[raw] = copy(value); return raw
    end,
    decode = function(raw) return copy(assert(encoded[raw], 'Invalid JSON fixture')) end}
io = {open = function(path, mode)
    if mode == 'rb' then
        if failure == 'read' or files[path] == nil then return nil end
        return {read = function() return files[path] end, close = function() return true end}
    end
    if failure == 'open' then return nil end
    return {write = function(_, raw)
        if failure == 'write' then return nil end
        files[path] = raw; return true
    end, close = function() return failure ~= 'close' end}
end}
os.time = function() return ms / 1000 end
os.rename = function(from, to)
    if failure == 'rename' or files[from] == nil or files[to] ~= nil then return nil end
    files[to], files[from] = files[from], nil
    writes[#writes + 1] = copy(json.decode(files[to])); return true
end
os.remove = function(path) files[path] = nil; return true end
local readinessFactory = (function() ${readinessSource} end)()
local queueFactory = (function() ${queueSource} end)()
local function makeReadiness(options)
    options = options or {}
    options.world = options.world or function() return world end
    options.isKnown = options.isKnown or function(key) return key ~= unknown and (key == 'judy-alvarez' or key == 'johnny-silverhand') end
    options.now = options.now or function() return ms end
    -- Read on every update unless a test exercises the production 250 ms throttle.
    options.readInterval = options.readInterval or 0
    return readinessFactory.new(options)
end
local readiness = makeReadiness()
local members, spawned, nextSerial = {}, {}, 0
local definitions = {
    judy = {name = 'Judy', id = 'Character.Judy', profileKey = 'judy-alvarez', profileName = 'Judy'},
    johnny = {name = 'Johnny', id = 'Character.Silverhand', profileKey = 'johnny-silverhand', profileName = 'Johnny'},
    raw = {name = 'Raw NPC', id = 'Character.Generic'}}
local companions = {
    definition = function(key) return definitions[key] end,
    list = function() return members end}
function companions.spawn(key, job)
    local status = readiness.status(job)
    assert(status.state == 'ready' or status.state == 'model-only', 'CreateEntity crossed preparation gate')
    nextSerial = nextSerial + 1
    spawned[#spawned + 1] = copy(job)
    members[#members + 1] = {serial = nextSerial, key = key, name = definitions[key].name,
        state = 'spawning', profileKey = definitions[key].profileKey}
    return nextSerial
end
function companions.setProfile(serial, key, name)
    for _, member in ipairs(members) do
        if member.serial == serial then member.profileKey, member.profileName = key, name; return true end
    end
    return false, 'Copy missing'
end
function companions.dismiss(serial)
    for index, member in ipairs(members) do if member.serial == serial then table.remove(members, index); return true end end
    return false, 'Copy missing'
end
local queue = queueFactory.new(companions, readiness)
queue.bind('player')
local function request()
    return json.decode(assert(files['runtime/companion-invitations.json'], 'No invitation publication'))
end
local function receipt(state, rowChanges, outerChanges)
    local value = request()
    value.bridgePid = 77
    for _, row in ipairs(value.invitations) do row.phase, row.state = nil, state end
    if rowChanges then for key, child in pairs(rowChanges) do value.invitations[1][key] = child end end
    if outerChanges then for key, child in pairs(outerChanges) do value[key] = child end end
    files['runtime/companion-invitations-state.json'] = json.encode(value)
    return copy(value)
end
`;

test('real Lua invitations publish during pause, await memory and connection, and keep their reservation through attachment', () => run(`
assert(queue.invite('judy'))
local reserved = request()
assert(reserved.version == 1 and reserved.updated == ms and #reserved.invitations == 1)
local job = reserved.invitations[1]
assert(job.phase == 'preparing' and job.revision == 1 and job.modelKey == 'judy' and job.profileKey == 'judy-alvarez')
assert(queue.count() == 1 and queue.list()[1].state == 'preparing-memory' and #spawned == 0)
queue.flush(); assert(#spawned == 0)
receipt('memory'); readiness.update(); queue.flush(); assert(#spawned == 0)
receipt('connecting'); readiness.update(); queue.flush()
assert(queue.list()[1].state == 'connecting' and #spawned == 0)
receipt('ready'); readiness.update()
assert(queue.list()[1].state == 'ready-to-join' and #spawned == 0, 'paused preparation spawned an actor')
ms = ms + 2000; receipt('ready'); readiness.update()
assert(request().updated == ms and request().invitations[1].phase == 'preparing' and #spawned == 0)
queue.flush()
assert(#spawned == 1 and spawned[1].id == job.id and spawned[1].revision == job.revision)
assert(spawned[1].profileKey == job.profileKey and members[1].profileKey == job.profileKey)
assert(request().invitations[1].phase == 'spawned' and queue.count() == 1)
assert(not queue.message():find('joined your group', 1, true))
queue.flush(); assert(#spawned == 1 and #request().invitations == 1)
members[1].state = 'ready'; queue.flush()
assert(#request().invitations == 0 and queue.message():find('joined your group', 1, true))
queue.flush(); assert(#spawned == 1 and #queue.takeNotices() == 1)
`));

test('cancel and profile reassignment invalidate earlier ready receipts before spawning', () => run(`
assert(queue.invite('judy'))
local old = receipt('ready')
readiness.update()
local id = queue.list()[1].id
assert(queue.assign(id, 'johnny-silverhand', 'Johnny'))
local revised = request().invitations[1]
assert(revised.id == id and revised.revision == 2 and revised.profileKey == 'johnny-silverhand')
readiness.update(); queue.flush()
assert(#spawned == 0 and queue.list()[1].state == 'preparing-memory')
receipt('ready'); readiness.update(); queue.flush()
assert(#spawned == 1 and spawned[1].revision == 2 and spawned[1].profileKey == 'johnny-silverhand')
assert(queue.dismiss('live:1') and #request().invitations == 0)
queue.flush(); assert(#members == 0 and #spawned == 1)
assert(queue.invite('judy')); id = queue.list()[1].id
receipt('ready'); readiness.update(); assert(queue.dismiss(id))
assert(queue.count() == 0 and #request().invitations == 0)
files['runtime/companion-invitations-state.json'] = json.encode(old)
readiness.update(); queue.flush()
assert(#spawned == 1, 'cancelled reservation consumed a late completion')
`));

test('same-owner world changes clear jobs and launch tokens fence CET reloads and rebuilt queues', () => run(`
assert(queue.invite('judy'))
local old = receipt('ready')
local oldId = queue.list()[1].id
readiness.update()
world = {worldToken = 'lua-world-launch-a-2', generation = 2}
readiness.update()
assert(queue.bind('player') == true and queue.count() == 0)
assert(#request().invitations == 0 and request().worldToken == world.worldToken)
assert(queue.invite('judy') and queue.list()[1].id ~= oldId)
files['runtime/companion-invitations-state.json'] = json.encode(old)
readiness.update(); queue.flush(); assert(#spawned == 0)
world = {worldToken = 'lua-world-launch-b-1', generation = 1}
readiness = makeReadiness()
queue = queueFactory.new(companions, readiness); queue.bind('player')
assert(queue.invite('judy') and queue.list()[1].id ~= oldId)
readiness.update(); queue.flush(); assert(#spawned == 0, 'earlier CET launch unlocked a new actor')
local freshId = queue.list()[1].id
queue.bind(nil)
queue = queueFactory.new(companions, readiness); queue.bind('player')
assert(queue.invite('judy') and queue.list()[1].id ~= freshId, 'same-world queue rebuild reused an ID')
world = nil; readiness.update(); queue.flush()
assert(queue.count() == 0 and queue.invite('judy') == false and #spawned == 0)
`));

test('receipt identities, ages, process, states, unknown profiles and malformed rows fence entity creation', () => run(`
assert(queue.invite('judy'))
local good = receipt('ready')
local function reject(mutator)
    local value = copy(good); mutator(value)
    files['runtime/companion-invitations-state.json'] = json.encode(value)
    readiness.update(); queue.flush()
    assert(#spawned == 0 and queue.list()[1].state ~= 'ready-to-join')
end
reject(function(v) v.worldToken = 'another-world' end)
reject(function(v) v.generation = 2 end)
reject(function(v) v.version = 2 end)
reject(function(v) v.bridgePid = nil end)
reject(function(v) v.updated = ms - 2501 end)
reject(function(v) v.updated = ms + 1001 end)
reject(function(v) v.invitations[1].id = 'obsolete-id' end)
reject(function(v) v.invitations[1].revision = 0 end)
reject(function(v) v.invitations[1].revision = 2 end)
reject(function(v) v.invitations[1].modelKey = 'johnny' end)
reject(function(v) v.invitations[1].modelKey = '../invalid-model' end)
reject(function(v) v.invitations[1].profileKey = 'johnny-silverhand' end)
reject(function(v) v.invitations[1].state = 'timeout-success' end)
reject(function(v) v.invitations[2] = copy(v.invitations[1]) end)
reject(function(v) v.invitations['extra'] = copy(v.invitations[1]) end)
reject(function(v) v.invitations[2], v.invitations[1] = v.invitations[1], nil end)
reject(function(v) v.invitations = 'ready' end)
unknown = 'judy-alvarez'
files['runtime/companion-invitations-state.json'] = json.encode(good)
readiness.update(); assert(queue.list()[1].state == 'failed')
-- The gameplay flush says why once and drops the failed invitation: it never spawns and never stays listed as a pending one.
queue.flush(); assert(#spawned == 0 and #queue.list() == 0 and #queue.takeNotices() == 1)
unknown = nil
assert(queue.invite('judy') and queue.list()[1].state ~= 'failed')
unknown = 'judy-alvarez'
readiness.update(); assert(queue.list()[1].state == 'failed' and queue.list()[1].error == 'That conversation profile is unavailable.')
-- Until the flush, a valid receipt for the old revision cannot revive it, and a new revision does start a fresh attempt.
unknown = nil
readiness.update(); assert(#spawned == 0 and queue.list()[1].state == 'failed')
-- Only an explicit retry (a new revision) starts a fresh preparation attempt.
assert(queue.assign(queue.list()[1].id, 'judy-alvarez', 'Judy') and queue.list()[1].state == 'preparing-memory')
files['runtime/companion-invitations-state.json'] = 'corrupt'
readiness.update(); queue.flush(); assert(#spawned == 0)
ms = ms + 59000; readiness.update(); queue.flush()
assert(queue.list()[1].state == 'preparing-memory' and #spawned == 0, 'a service still starting failed before a minute of silence')
ms = ms + 1000; readiness.update()
assert(queue.list()[1].state == 'failed' and queue.list()[1].error:find('did not answer', 1, true) and #spawned == 0)
assert(queue.assign(queue.list()[1].id, 'judy-alvarez', 'Judy'))
receipt('error', {error = 'Preparation timed out'}); readiness.update()
assert(queue.list()[1].state == 'failed' and queue.list()[1].error == 'Preparation timed out' and #spawned == 0)
queue.flush(); assert(#queue.list() == 0 and queue.count() == 0, 'a failed preparation stayed listed after its notice')
`));

test('a failure read through the paused snapshots keeps its one notice until the gameplay flush posts it', () => run(`
assert(queue.invite('judy'))
local id = queue.list()[1].id
receipt('error', {error = 'Provider unavailable'}); readiness.update()
-- The manager banner, the popup sampler and the phone read these while paused.
for _ = 1, 3 do
    assert(queue.list()[1].state == 'failed' and queue.preparationFeedback().failed and queue.invitationFeedback(id).failed)
end
assert(#queue.takeNotices() == 0 and #spawned == 0, 'a paused read posted the failure notice')
queue.flush()
local notices = queue.takeNotices()
assert(#notices == 1 and notices[1].failed and notices[1].invitationId == id
    and notices[1].message == 'Judy could not prepare: Provider unavailable')
-- The notice said it: the failed invitation left the list (no Cancel invitation row that looks pending forever).
assert(#queue.list() == 0 and queue.count() == 0 and queue.preparationFeedback(id) == nil)
assert(queue.claimPreparationFailure(id, 1) == false, 'the gameplay flush left the failure claimable')
for _ = 1, 3 do readiness.update(); queue.flush(); queue.list(); queue.preparationFeedback() end
assert(#queue.takeNotices() == 0 and #spawned == 0, 'the failed attempt notified or spawned again')
-- A claim taken by another gameplay reporter (popup or phone) is the one notice.
assert(queue.invite('judy')); id = queue.list()[1].id
receipt('error', {error = 'Provider unavailable again'}); readiness.update()
assert(queue.list()[1].state == 'failed' and queue.claimPreparationFailure(id, 1) == true)
queue.flush()
assert(#queue.takeNotices() == 0, 'a claimed failure also produced the queue notice')
assert(queue.claimPreparationFailure(id, 1) == false)
`));

test('whole-second CET time accepts Date.now receipts from that second and rejects larger skew', () => run(`
readiness = makeReadiness({now = function() return math.floor(ms / 1000) * 1000.0 end})
queue = queueFactory.new(companions, readiness); queue.bind('player')
assert(queue.invite('judy'))
receipt('connecting', nil, {updated = ms + 750}); readiness.update()
assert(queue.list()[1].state == 'connecting' and #spawned == 0)
receipt('ready', nil, {updated = ms + 750}); readiness.update()
assert(queue.list()[1].state == 'ready-to-join' and #spawned == 0)
receipt('ready', nil, {updated = ms + 1001}); readiness.update(); queue.flush()
assert(#spawned == 0 and queue.list()[1].state ~= 'ready-to-join')
receipt('ready', nil, {updated = ms - 2500}); readiness.update(); queue.flush()
assert(#spawned == 1)
`));

test('publication failures stay visible and cancellable and block profiled and model-only copies', () => run(`
for _, mode in ipairs({'open', 'write', 'close', 'encode'}) do
    failure = mode
    assert(queue.invite('judy') == false)
    assert(queue.count() == 1 and queue.list()[1].state == 'failed' and queue.list()[1].error)
    failure = nil
    -- Visible and removable until the gameplay flush; the notice is then the record and the invitation leaves the list.
    if mode == 'open' or mode == 'write' then assert(queue.dismiss(queue.list()[1].id) and queue.count() == 0)
    else queue.flush(); assert(#spawned == 0 and queue.count() == 0 and #queue.takeNotices() == 1) end
    queue.takeNotices()
end
failure = 'open'
assert(queue.invite('raw') == false and queue.list()[1].state == 'failed')
failure = nil
queue.flush(); assert(#spawned == 0 and queue.count() == 0)
assert(queue.invite('raw') and queue.list()[1].state == 'ready-to-join')
assert(#spawned == 0, 'model-only readiness spawned during a paused action')
queue.flush()
assert(#spawned == 1 and members[1].profileKey == nil and request().invitations[1].phase == 'spawned')
members[1].state = 'failed'; members[1].error = 'Actor attachment failed'
queue.flush()
assert(#request().invitations == 0 and queue.message():find('Actor attachment failed', 1, true))
`));

test('twelve reservations retain independent copy membership and returned rows cannot mutate jobs or actors', () => run(`
for _ = 1, 12 do assert(queue.invite('judy')) end
assert(queue.count() == 12 and #request().invitations == 12)
local copies = queue.list()
local firstId, secondId = copies[1].id, copies[2].id
assert(firstId ~= secondId)
copies[1].id, copies[1].profileKey, copies[1].revision = 'changed', 'johnny-silverhand', 100
assert(queue.list()[1].id == firstId and queue.list()[1].profileKey == 'judy-alvarez')
assert(queue.assign(secondId, 'johnny-silverhand', 'Johnny'))
assert(request().invitations[1].revision == 1 and request().invitations[2].revision == 2)
assert(queue.dismiss(firstId) and queue.count() == 11 and #request().invitations == 11)
assert(queue.invite('raw') and queue.count() == 12)
receipt('ready'); readiness.update(); queue.flush()
assert(#spawned == 12 and #members == 12 and #request().invitations == 12)
assert(members[1].profileKey == 'johnny-silverhand' and members[2].profileKey == 'judy-alvarez')
local liveCopy = queue.list()[1]; liveCopy.profileKey, liveCopy.state = nil, 'failed'
assert(members[1].profileKey == 'johnny-silverhand' and members[1].state == 'spawning')
for _, member in ipairs(members) do member.state = 'ready' end
queue.flush(); assert(#request().invitations == 0 and queue.count() == 12)
assert(queue.dismiss('live:1') and queue.count() == 11)
assert(queue.invite('raw') and queue.count() == 12)
-- Undoing a dismissal is never refused for the size of the party.
assert(queue.undoDismiss('live:1') == true and queue.count() == 13)
queue.flush()
assert(#members == 13 and #spawned == 13)
`));

test('injected file and codec fixtures and runtime directory use the same reservation protocol', () => run(`
local customFiles, customWrites = {}, {}
readiness = makeReadiness({runtimeDir = 'fixture-runtime/',
    read = function(path) return customFiles[path] end,
    write = function(path, raw) customFiles[path] = raw; customWrites[#customWrites + 1] = path; return true end,
    encode = json.encode, decode = json.decode})
queue = queueFactory.new(companions, readiness); queue.bind('player')
assert(queue.invite('judy'))
local value = json.decode(customFiles['fixture-runtime/companion-invitations.json'])
assert(#value.invitations == 1 and value.worldToken == world.worldToken and customWrites[#customWrites] == 'fixture-runtime/companion-invitations.json')
value.bridgePid = 88; value.invitations[1].state = 'ready'
customFiles['fixture-runtime/companion-invitations-state.json'] = json.encode(value)
readiness.update(); queue.flush(); assert(#spawned == 1)
`));

test('production update reads the receipt file at most every 250 ms of wall clock', () => run(`
local wall, reads = 10, 0
local open = io.open
io.open = function(path, mode)
    if path == 'runtime/companion-invitations-state.json' then reads = reads + 1 end
    return open(path, mode)
end
local throttled = makeReadiness({readInterval = .25, tick = function() return wall end})
local throttledQueue = queueFactory.new(companions, throttled)
throttledQueue.bind('player')
assert(throttledQueue.invite('judy'))
throttled.update(); local first = reads
assert(first == 1, 'first update did not read the receipt')
for _ = 1, 10 do wall = wall + .016; throttled.update() end
assert(reads == first, 'receipt was read again within 250 ms: ' .. reads)
wall = wall + .1; throttled.update(); assert(reads == first + 1)
`));

// What a preparing companion waits for reaches the player as a notice line (manager-party.lua waiting(), manager-ui.lua): the
// adapter names the step from the bridge's receipt, and a service that is only slow is a wait, never a failure.
test('the wait is named from the receipt: service not answering yet, then the memory service, the voice model, the connection', () => run(`
assert(queue.invite('judy'))
local id = queue.list()[1].id
local function wait() return queue.preparationFeedback(id).wait end
assert(wait() == 'bridge' and queue.preparationFeedback(id).state == 'memory', 'no receipt yet is the service not answering')
receipt('memory', {stage = 'memory'}); readiness.update(); assert(wait() == 'memory')
receipt('memory', {stage = 'queued'}); readiness.update(); assert(wait() == 'queued', 'the queue wait is told to the game, which words it as memory')
receipt('memory', {stage = 'voice'}); readiness.update(); assert(wait() == 'voice')
receipt('memory', {stage = 'somewhere-else'}); readiness.update(); assert(wait() == 'voice', 'an unknown stage was believed')
receipt('memory'); readiness.update(); assert(wait() == 'voice', 'a receipt without a stage forgot the last one')
receipt('connecting'); readiness.update(); assert(wait() == 'connection' and queue.preparationFeedback(id).state == 'connecting')
receipt('ready'); readiness.update(); assert(wait() == nil and queue.preparationFeedback(id).state == 'ready')
`));

test('a service that answered keeps its last step while receipts are late, and fails only after a minute of silence', () => run(`
assert(queue.invite('judy'))
local id = queue.list()[1].id
receipt('memory', {stage = 'voice'}); readiness.update(); assert(queue.preparationFeedback(id).wait == 'voice')
-- Its receipts stop (a busy service loading models): the step stands and nothing fails.
ms = ms + 3000; readiness.update()
assert(queue.preparationFeedback(id).wait == 'voice' and not queue.preparationFeedback(id).failed)
ms = ms + 56000; readiness.update()
assert(queue.preparationFeedback(id).wait == 'voice' and not queue.preparationFeedback(id).failed, 'failed before a minute of silence')
-- A fresh receipt restarts the silence.
-- (A receipt counts when the status is read, which the notice board does on every frame it has an invitation.)
receipt('memory', {stage = 'voice'}); readiness.update(); queue.preparationFeedback(id); ms = ms + 59000; readiness.update()
assert(not queue.preparationFeedback(id).failed, 'the silence was not restarted by a fresh receipt')
ms = ms + 1000; readiness.update()
local failed = queue.preparationFeedback(id)
assert(failed.failed and queue.list()[1].error:find('did not answer', 1, true), tostring(queue.list()[1].error))
queue.flush()
local notices = queue.takeNotices()
assert(#notices == 1 and notices[1].message:find('Judy could not prepare: The conversation service did not answer', 1, true), notices[1] and notices[1].message)
-- A service that never answered waits just as long, with the same wait named.
assert(queue.count() == 0, 'the failed invitation stayed listed after its notice')
assert(queue.invite('judy')); id = queue.list()[1].id
assert(queue.preparationFeedback(id).wait == 'bridge')
ms = ms + 59000; readiness.update(); assert(not queue.preparationFeedback(id).failed)
ms = ms + 1000; readiness.update(); assert(queue.preparationFeedback(id).failed)
`));

test('a bridge failure is worded by its kind: what failed and what to do; an unknown kind keeps the bridge text', () => run(`
local reasons = {
    {'voice', 'The voice model did not load. Check the voice in Settings or choose another one, then invite again.'},
    {'memory', 'The memory service did not respond. Check your connection, then invite again.'},
    {'connection', 'The conversation connection did not open. Check your connection, then invite again.'},
    {'signin', 'Convai sign-in is busy right now. Wait a few minutes, then invite again.'},
    {'daily', 'The Convai daily limit is used up. Choose another provider in Settings, or invite again tomorrow.'}}
for _, case in ipairs(reasons) do
    assert(queue.invite('judy'))
    local id = queue.list()[1].id
    receipt('error', {error = 'Bridge wording that is replaced', errorKind = case[1]}); readiness.update()
    assert(queue.list()[1].error == case[2], case[1] .. ': ' .. tostring(queue.list()[1].error))
    queue.flush()
    local notices = queue.takeNotices()
    assert(#notices == 1 and notices[1].message == 'Judy could not prepare: ' .. case[2], notices[1] and notices[1].message)
    assert(queue.count() == 0)
end
assert(queue.invite('judy'))
receipt('error', {error = 'The party has no free conversation connection.', errorKind = 'capacity'}); readiness.update()
assert(queue.list()[1].error == 'The party has no free conversation connection.')
assert(queue.dismiss(queue.list()[1].id))
assert(queue.invite('judy'))
receipt('error', {error = 'Made-up failure', errorKind = 'made-up'}); readiness.update()
assert(queue.list()[1].error == 'Made-up failure', 'an unknown kind replaced the bridge text')
`));
