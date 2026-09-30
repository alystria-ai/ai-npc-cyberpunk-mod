import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const source = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
const questSource = readFileSync(new URL('../mod/quest-context.lua', import.meta.url), 'utf8');
const invitationSource = readFileSync(new URL('../mod/invitation-readiness.lua', import.meta.url), 'utf8');
const partyQueueSource = readFileSync(new URL('../mod/manager-party.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

// Execute the complete adapter and its real tracked-journal collector. Storage,
// actors, surrounding mod modules and native events stay inside this Lua VM.
// Traps record even prohibited calls swallowed by an adapter pcall.
function run(body) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  try {
    const program = `${fixture}\n(function()\n${source}\nend)()\n${body}\nassertClean()`;
    const result = lauxlib.luaL_dostring(state, to_luastring(program));
    const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(result, lua.LUA_OK, error + (line ? `\n${program.split('\n')[line - 1]}` : ''));
  } finally { lua.lua_close(state); }
}

const fixture = `
local function copy(value)
    if type(value) ~= 'table' then return value end
    local result = {}; for key, child in pairs(value) do result[key] = copy(child) end; return result
end
local clock, tearingDown = 1790760000.0, false
local events, before, after, hotkeys, files, encoded, modules = {}, {}, {}, {}, {}, {}, {}
local stats = {forbidden = {}, trace = {}, publications = {}, loads = {}, logs = {}, io = {}, starts = {}, received = {}, journalReads = 0, spawned = 0}
local function note(kind, value) stats.trace[#stats.trace + 1] = {kind = kind, value = copy(value)} end
local function deny(kind)
    stats.forbidden[#stats.forbidden + 1] = kind
    error('Forbidden native memory access: ' .. kind)
end
local function nativeRead(kind)
    if tearingDown then deny('unloaded actor read: ' .. kind) end
end
local function prohibited(path)
    for _, fragment in ipairs({'save-identity', 'fact-identity', 'knowledge-state', 'knowledge-command',
        'knowledge-binding', 'knowledge-activation', 'knowledge-fact'}) do
        if path:find(fragment, 1, true) then return true end
    end
    return false
end
local sequence = 0
json = {
    encode = function(value)
        sequence = sequence + 1
        local key = 'json-fixture-' .. sequence; encoded[key] = copy(value); return key
    end,
    decode = function(value) return copy(assert(encoded[value], 'Unexpected JSON input: ' .. tostring(value))) end}
io = {open = function(path, mode)
    stats.io[#stats.io + 1] = {path = path, mode = mode}
    if prohibited(path) then deny('file ' .. path .. ':' .. mode) end
    if mode == 'rb' then
        if files[path] == nil then return nil end
        return {read = function() return files[path] end, close = function() return true end}
    end
    local raw = mode == 'a' and (files[path] or '') or ''
    return {write = function(_, ...)
        for index = 1, select('#', ...) do raw = raw .. tostring(select(index, ...)) end
        files[path] = raw; return true
    end, close = function() return true end}
end}
os.time = function() return clock end
os.date = function() return '2026-09-30T12:00:00Z' end
os.rename = function(from, to)
    if prohibited(from) or prohibited(to) then deny('rename ' .. from .. ' -> ' .. to) end
    -- Windows rename may require removing an existing publication first.
    if files[from] == nil or files[to] ~= nil then return nil end
    files[to], files[from] = files[from], nil
    if to == 'runtime/world-session.json' then
        local value = json.decode(files[to]); stats.publications[#stats.publications + 1] = value
        note('world-publication', value)
    end
    return true
end
os.remove = function(path)
    if prohibited(path) then deny('remove ' .. path) end
    files[path] = nil; return true
end
print = function(value) stats.logs[#stats.logs + 1] = tostring(value) end
registerForEvent = function(name, callback) assert(not events[name]); events[name] = callback end
registerHotkey = function(name, _, callback) hotkeys[name] = callback end
ObserveBefore = function(class, method, callback) before[class .. '.' .. method] = callback end
ObserveAfter = function(class, method, callback) after[class .. '.' .. method] = callback end

local player = {attached = true, dead = false, phoneOpen = false, phoneRequest = ''}
function player:IsAttached() nativeRead('IsAttached'); return self.attached end
function player:IsDeadNoStatPool() nativeRead('IsDeadNoStatPool'); return self.dead end
function player:ConvaiComposerOpen() return false end
function player:ConvaiHasSubmission() return false end
function player:ConvaiPhoneIsOpen() return self.phoneOpen end
function player:ConvaiPhoneTakeRequest() local value = self.phoneRequest; self.phoneRequest = ''; return value end
function player:ConvaiManagerVoice() return true end
function player:ConvaiManagerSubtitles() return true end
function player:ConvaiPhoneFeedback(value) note('feedback', value) end
function player:ConvaiEndFocus() note('end-focus') end
function player:ConvaiCloseManager() note('close-manager') end
local requests = {IsPreGame = function() nativeRead('IsPreGame'); return false end,
    IsGamePaused = function() return player.phoneOpen end, GetGameVersion = function() return '2.31' end}
local definitions = {UI_System = {IsInMenu = 'in-menu'}}
local board = {GetBool = function() return player.phoneOpen end}
local targeting = {GetTargetParts = function() return nil, {} end,
    GetObjectClosestToCrosshair = function() return nil end, GetLookAtObject = function() return nil end,
    GetCrosshairData = function() return {x = 0, y = 0, z = 0}, {x = 0, y = 1, z = 0} end}
Game = {
    GetPlayer = function() nativeRead('GetPlayer'); return player end,
    GetSystemRequestsHandler = function() nativeRead('GetSystemRequestsHandler'); return requests end,
    GetAllBlackboardDefs = function() return definitions end,
    GetBlackboardSystem = function() return {Get = function() return board end} end,
    GetTargetingSystem = function() return targeting end,
    ['TSF_NPC;'] = function() return 'NPC' end,
    GetQuestsSystem = function() deny('quest fact system') end,
    GetScriptableSystemsContainer = function() deny('native save identity container') end,
    GetFact = function() deny('native fact read') end,
    SetFact = function() deny('native fact write') end}
TargetSearchQuery = {new = function() return {} end}
TweakDBID = {new = function(value) return value end}
Enum = {new = function(_, value) return value end}
JournalRequestStateFilter = {new = function(value) return value end}
GetLocalizedText = function(value) return value end
NewObject = function(kind) deny('native object ' .. tostring(kind)) end
setmetatable(Game, {__index = function(_, key) return function() deny('unexpected Game.' .. tostring(key)) end end})

local journal
local function setJournal(title, text)
    local quest = {id = 1, class = 'gameJournalQuest', text = title, state = 'Active', children = {}}
    local objective = {id = 2, class = 'gameJournalQuestObjectiveBase', text = text, state = 'Active', parent = quest, children = {}}
    quest.children[1] = objective
    for _, node in ipairs({quest, objective}) do
        function node:IsA(class) return self.class == class end
        function node:GetTitle() return self.text end
        function node:GetDescription() return self.text end
        function node:HasCounter() return false end
    end
    journal = {
        GetTrackedEntry = function() stats.journalReads = stats.journalReads + 1; return objective end,
        GetEntryState = function(_, node) return node.state end,
        GetEntryHash = function(_, node) return node.id end,
        GetParentEntry = function(_, node) return node.parent end,
        GetChildren = function(_, node, filter)
            assert(filter.active and not filter.inactive and not filter.succeeded and not filter.failed)
            return node.children
        end,
        GetIsObjectiveOptional = function() return false end}
end
setJournal('Initial revealed quest', 'Meet Judy at the current entrance.')
Game.GetJournalManager = function() nativeRead('GetJournalManager'); return journal end

local function noOp() end
local members = {}
local companions = {configure = noOp, connectionProfiles = function()
    local result = {}; for _, member in ipairs(members) do if member.profileKey then result[#result + 1] = member.profileKey end end
    return result
end, list = function() return copy(members) end,
    registerPhoneContacts = noOp, update = noOp, ownsTravelCommand = function() return true end,
    conversationCandidates = function() return {} end,
    abandon = noOp,
    dismissAll = function() note('companions-dismiss-all') end}
function companions.definition(key)
    if key == 'judy-alvarez' then return {name = 'Judy', id = 'Character.Judy', profileKey = key, profileName = 'Judy'} end
end
function companions.phoneContactKey(contact) if contact == 'judy' then return 'judy-alvarez', nil, 'Judy' end end
function companions.spawn(key, job)
    local allowed, reason = companions.canSpawn(key, job); assert(allowed, reason)
    stats.spawned = stats.spawned + 1
    members[#members + 1] = {serial = stats.spawned, key = key, name = 'Judy', profileKey = job.profileKey, state = 'ready'}
    if companions.onPartyChanged then companions.onPartyChanged() end
    return stats.spawned
end
function companions.setProfile(serial, key, name)
    for _, member in ipairs(members) do if member.serial == serial then member.profileKey, member.profileName = key, name; return true end end
end
function companions.dismiss(serial)
    for index, member in ipairs(members) do if member.serial == serial then table.remove(members, index); return true end end
end
local subtitles = {configure = noOp, install = noOp, update = noOp,
    abandon = function() note('subtitles-abandon') end, clear = noOp}
local speech = {transcript = noOp, clearEntity = noOp, update = noOp,
    abandon = function() note('speech-abandon') end, stop = noOp,
    start = function(context) stats.starts[#stats.starts + 1] = context.requestId end}
local microphone = {state = 'reply', update = function() return nil end,
    cancel = function() note('microphone-cancel') end}
local group = {cancel = function() note('group-cancel') end,
    received = function(requestId) stats.received[#stats.received + 1] = requestId; return true end}
local phone = {configure = function(_, _, options) stats.phoneOptions = options end,
    update = noOp, abandon = function() note('phone-abandon') end}
local manager = {subtitleStyle = 'game', configure = noOp, profileEnabled = function() return true end,
    battleReactions = function() return false end, lootReactions = function() return false end,
    update = noOp, reset = function() note('manager-reset') end}
local partyQueue
local mcm = {configure = function(_, suppliedCompanions, factory, _, readiness)
    partyQueue = factory.new(suppliedCompanions, readiness)
end, install = noOp, update = function(_, worldReady)
    partyQueue.bind('fixture-player'); if worldReady then partyQueue.flush() end
end, party = function() return partyQueue end, shutdown = function() partyQueue.bind(nil) end,
    resetSession = function() note('mcm-reset'); partyQueue.bind(nil) end}
local battles = {capture = function() return {version = 1, status = 'unavailable'} end,
    reset = function() note('battles-reset') end, update = noOp,
    status = function() return {state = 'idle'} end, closingWindow = function() return nil end,
    offer = function() return nil end}
local loot = {reset = function() note('loot-reset') end, update = noOp,
    status = function() return {pending = 0} end, offer = function() return nil end}
local lootObserver = {configure = noOp, install = noOp, update = noOp, drain = function() return {} end,
    reset = function() note('loot-observer-reset') end}
local worldOptions, historyOptions, worldCollector, historyCollector
local function collector(kind, options)
    local value = {updates = {}, resets = 0, configurations = 0}
    function value:configure(pack, environment)
        assert(pack.id == 'lifecycle-reviewed-pack' and environment.gameVersion == '2.31')
        self.configurations = self.configurations + 1; return true
    end
    function value:reset(_, reason) self.resets = self.resets + 1; note(kind .. '-reset', reason) end
    function value:update(binding)
        assert(options.currentGeneration() == binding.generation and options.currentWorldToken() == binding.worldToken)
        self.updates[#self.updates + 1] = copy(binding)
    end
    function value:capture(binding)
        assert(options.currentGeneration() == binding.generation and options.currentWorldToken() == binding.worldToken)
        return {version = 1, status = 'ready', generation = binding.generation, worldToken = binding.worldToken,
            audience = copy(binding.audience), identity = copy(binding.identity)}
    end
    return value
end
modules = {
    ['companions.lua'] = companions, ['subtitles.lua'] = subtitles, ['speech.lua'] = speech,
    ['microphone.lua'] = microphone, ['group-chat.lua'] = group, ['phone-chat.lua'] = phone,
    ['manager.lua'] = manager, ['mcm.lua'] = mcm, ['phone-layout.lua'] = {install = noOp, refresh = noOp},
    ['phone-chat-style.lua'] = {install = noOp, refresh = noOp},
    ['character-catalog.lua'] = {build = function() return {records = {}} end},
    ['battle-observer.lua'] = {sample = function() return {available = true, blocked = false, combat = false} end},
    ['battle-reactions.lua'] = {new = function() return battles end},
    ['loot-reactions.lua'] = {new = function() return loot end}, ['loot-observer.lua'] = lootObserver,
    ['manager-party.lua'] = (function() ${partyQueueSource} end)(), ['mcm-entry.lua'] = {}, ['companion-locomotion.lua'] = {install = noOp},
    ['composer-input.lua'] = {install = noOp}, ['phone-input.lua'] = {install = noOp},
    ['world-knowledge.lua'] = {new = function(options)
        worldOptions = options; worldCollector = collector('world-collector', options); return worldCollector
    end},
    ['journal-history.lua'] = {new = function(options)
        historyOptions = options; historyCollector = collector('history-collector', options); return historyCollector
    end}}
dofile = function(path)
    stats.loads[path] = (stats.loads[path] or 0) + 1
    if prohibited(path) then deny('module ' .. path) end
    if path == 'quest-context.lua' then return (function() ${questSource} end)() end
    if path == 'invitation-readiness.lua' then return (function() ${invitationSource} end)() end
    return assert(modules[path], 'Unexpected mod dependency: ' .. path)
end
files['conversation-characters.json'] = json.encode({{key = 'judy-alvarez', name = 'Judy'}})
files['world-knowledge.json'] = json.encode({id = 'lifecycle-reviewed-pack'})

local function published() return json.decode(assert(files['runtime/world-session.json'])) end
local function queueVoice(requestId)
    local captured = assert(microphone.captureKnowledge({profileKey = 'judy-alvarez'}, 'private'))
    local input = {requestId = requestId, generation = 71, entity = '13ULL', profileKey = 'judy-alvarez', text = '[Microphone]'}
    microphone.knowledgeOwner = copy(captured.owner)
    microphone.queued = input
    microphone.update = function()
        local result = microphone.queued; microphone.queued = nil; return result
    end
    return input, copy(captured.owner)
end
local function replyFor(input)
    files['runtime/reply.json'] = json.encode({requestId = input.requestId, generation = input.generation,
        entity = input.entity, text = 'A reply for ' .. input.requestId})
end
local function primeSessions()
    companions.session, speech.requestId, subtitles.line = 'old-party', 'old-playback', 'old-caption'
    microphone.context, group.round, phone.pending = {id = 'old-microphone'}, {stage = 'waiting', participants = {}}, {id = 'old-phone'}
end
companions.abandon = function() note('companions-abandon'); companions.session = nil; members = {} end
speech.abandon = function() note('speech-abandon'); speech.requestId = nil end
subtitles.abandon = function() note('subtitles-abandon'); subtitles.line = nil end
microphone.cancel = function()
    note('microphone-cancel'); microphone.context, microphone.queued, microphone.knowledgeOwner = nil, nil, nil
end
group.cancel = function() note('group-cancel'); group.round = nil end
phone.abandon = function() note('phone-abandon'); phone.pending = nil end
local function assertSessionsCancelled()
    assert(companions.session == nil and speech.requestId == nil and subtitles.line == nil)
    assert(microphone.context == nil and microphone.queued == nil and microphone.knowledgeOwner == nil)
    assert(group.round == nil and phone.pending == nil)
end
local function assertClean()
    assert(#stats.forbidden == 0, table.concat(stats.forbidden, ', '))
    for _, message in ipairs(stats.logs) do
        assert(not message:find('update failed', 1, true) and not message:find('observation skipped', 1, true), message)
    end
end
`;

test('phone Invite prepares during zero-delta pause and creates no actor until memory and connection are ready', () => run(`
events.onInit(); events.onUpdate(0)
player.phoneOpen, player.phoneRequest = true, '+judy'
events.onUpdate(0)
local request = json.decode(assert(files['runtime/companion-invitations.json']))
assert(request.version == 1 and #request.invitations == 1)
local job = request.invitations[1]
assert(job.profileKey == 'judy-alvarez' and job.modelKey == 'judy-alvarez')
assert(stats.spawned == 0 and partyQueue.count() == 1)
local function receipt(state)
    files['runtime/companion-invitations-state.json'] = json.encode({version = 1,
        worldToken = request.worldToken, generation = request.generation, updated = clock * 1000, bridgePid = 99,
        invitations = {{id = job.id, revision = job.revision, modelKey = job.modelKey, profileKey = job.profileKey, state = state}}})
end
receipt('memory'); events.onUpdate(0); assert(stats.spawned == 0)
receipt('connecting'); events.onUpdate(0); assert(stats.spawned == 0)
assert(partyQueue.list()[1].state == 'connecting')
receipt('ready'); events.onUpdate(0); assert(stats.spawned == 0)
assert(partyQueue.list()[1].state == 'ready-to-join')
local heartbeat = published()
clock = clock + 2; receipt('ready'); events.onUpdate(0)
assert(published().updated > heartbeat.updated and stats.spawned == 0)
assert(files['runtime/party-connections.json']:find('"updated":' .. tostring(clock * 1000), 1, true))
player.phoneOpen = false; events.onUpdate(0.1)
assert(stats.spawned == 1 and #members == 1)
assert(members[1].profileKey == 'judy-alvarez')
events.onUpdate(0.1); events.onUpdate(0.1)
assert(stats.spawned == 1 and #json.decode(files['runtime/companion-invitations.json']).invitations == 0)
local allowed = companions.canSpawn('judy-alvarez', nil)
assert(allowed == false, 'a legacy direct spawn bypassed preparation')
`));

test('phone cancellation and save restoration reject earlier ready invitation receipts', () => run(`
events.onInit(); events.onUpdate(0)
player.phoneOpen, player.phoneRequest = true, '+judy'; events.onUpdate(0)
local original = json.decode(files['runtime/companion-invitations.json'])
local job = original.invitations[1]
local obsolete = {version = 1, worldToken = original.worldToken, generation = original.generation,
    updated = clock * 1000, bridgePid = 99,
    invitations = {{id = job.id, revision = job.revision, modelKey = job.modelKey, profileKey = job.profileKey, state = 'ready'}}}
player.phoneRequest = '-judy'; events.onUpdate(0)
assert(partyQueue.count() == 0 and stats.spawned == 0)
files['runtime/companion-invitations-state.json'] = json.encode(obsolete)
player.phoneOpen = false; events.onUpdate(0.1); assert(stats.spawned == 0)
player.phoneOpen, player.phoneRequest = true, '+judy'; events.onUpdate(0)
assert(partyQueue.count() == 1 and stats.spawned == 0)
after['PlayerSystem.OnGameRestored'](); events.onUpdate(0)
assert(partyQueue.count() == 0 and stats.spawned == 0)
player.phoneRequest = '+judy'; events.onUpdate(0)
local current = json.decode(files['runtime/companion-invitations.json'])
assert(current.worldToken ~= original.worldToken and current.generation > original.generation)
assert(current.invitations[1].id ~= job.id)
files['runtime/companion-invitations-state.json'] = json.encode(obsolete)
player.phoneOpen = false; events.onUpdate(0.1)
assert(stats.spawned == 0 and partyQueue.count() == 1)
`));

test('real init installs world lifecycle hooks and current tracked quest capture without persistent native identity', () => run(`
assert(type(events.onInit) == 'function' and type(events.onUpdate) == 'function')
assert(stats.loads['quest-context.lua'] == 1)
assert(group.captureJournal == convaiQuestContext.capture and phone.captureJournal == convaiQuestContext.capture)
assert(microphone.captureJournal == convaiQuestContext.capture)
assert(worldOptions.currentGeneration() == nil and historyOptions.currentWorldToken() == nil)
events.onInit()
assert(type(before['PlayerPuppet.OnDetach']) == 'function')
assert(type(after['PlayerSystem.OnGameRestored']) == 'function')
events.onUpdate(0)
local first = published()
assert(first.version == 1 and first.ready == true and first.generation == 1 and first.updated == clock * 1000)
assert(type(first.token) == 'string' and #first.token > 0)
assert(worldOptions.currentGeneration() == first.generation and worldOptions.currentWorldToken() == first.token)
assert(historyOptions.currentGeneration() == first.generation and historyOptions.currentWorldToken() == first.token)
assert(worldCollector.configurations == 1 and #worldCollector.updates == 1 and #historyCollector.updates == 1)
local captured = assert(microphone.captureKnowledge({profileKey = 'judy-alvarez'}, 'private'))
assert(captured.owner.worldToken == first.token and captured.worldKnowledge.identity.status == 'unknown')
for _, capture in ipairs({group.captureJournal, phone.captureJournal, microphone.captureJournal}) do
    local quest = capture()
    assert(quest.status == 'active' and quest.quest.title == 'Initial revealed quest')
    assert(quest.quest.objectives[1].text == 'Meet Judy at the current entrance.' and quest.quest.objectives[1].tracked)
end
assert(convaiQuestContext.lastError == nil)
local publications = #stats.publications
events.onUpdate(0)
assert(#stats.publications == publications, 'same-second frame repeated the same heartbeat')
clock = clock + 1; events.onUpdate(0)
local heartbeat = published()
assert(heartbeat.ready and heartbeat.token == first.token and heartbeat.generation == first.generation)
assert(heartbeat.updated == first.updated + 1000 and worldCollector.configurations == 1)
`));

test('actual restored callback retires the old lease before cleanup, rotates on admission and rejects an old pending reply', () => run(`
events.onInit(); events.onUpdate(0)
local old = published()
local input, owner = queueVoice('old-world-reply'); events.onUpdate(0.1)
assert(#stats.starts == 0)
primeSessions()
local traceAt, readsAt = #stats.trace, stats.journalReads
tearingDown = true; after['PlayerSystem.OnGameRestored'](); tearingDown = false
local retired = published()
assert(retired.ready == false and retired.token == old.token and retired.generation == old.generation)
assert(stats.trace[traceAt + 1].kind == 'world-publication' and stats.trace[traceAt + 1].value.ready == false,
    'world was not retired before cleanup')
assertSessionsCancelled()
assert(stats.journalReads == readsAt, 'restore callback read journal handles during teardown')
assert(microphone.currentKnowledgeOwner() == nil)
assert(worldOptions.currentGeneration() == nil and historyOptions.currentWorldToken() == nil)
setJournal('Restored revealed quest', 'Visit the new current objective.')
replyFor(input); events.onUpdate(0.1)
local current = published()
assert(current.ready == true and current.generation == old.generation + 1 and current.token ~= old.token)
assert(current.updated == old.updated, 'same-second reload did not replace the retired heartbeat')
assert(#stats.starts == 0, 'reply from the retired pending turn was played')
local newOwner = assert(microphone.currentKnowledgeOwner())
assert(newOwner.session == owner.session + 1 and newOwner.worldToken == current.token)
assert(newOwner.generation == current.generation)
local quest = microphone.captureJournal()
assert(quest.status == 'active' and quest.quest.title == 'Restored revealed quest')
assert(quest.quest.objectives[1].text == 'Visit the new current objective.')
local fresh = queueVoice('current-world-reply'); replyFor(fresh); events.onUpdate(0.1)
assert(#stats.starts == 1 and stats.starts[1] == 'current-world-reply', 'current-world polling stopped working')
assert(#stats.received == 1 and stats.received[1] == 'current-world-reply')
`));

test('actual detach callback cancels owned sessions and blocks heartbeat revival until attach or take-control', () => run(`
events.onInit(); events.onUpdate(0)
local initial = published()
local input = queueVoice('detached-world-reply'); events.onUpdate(0.1); primeSessions()
local traceAt, readsAt = #stats.trace, stats.journalReads
tearingDown = true; before['PlayerPuppet.OnDetach'](); tearingDown = false
local retired = published()
assert(not retired.ready and retired.token == initial.token and retired.generation == initial.generation)
assert(stats.trace[traceAt + 1].kind == 'world-publication' and not stats.trace[traceAt + 1].value.ready)
assertSessionsCancelled(); assert(stats.journalReads == readsAt)
replyFor(input)
local publications = #stats.publications
for _ = 1, 4 do events.onUpdate(0.1) end
assert(#stats.publications == publications and not published().ready,
    'apparently attached actor revived a suspended world before its lifecycle attach')
assert(#stats.starts == 0 and microphone.currentKnowledgeOwner() == nil)
after['PlayerPuppet.OnGameAttached'](); events.onUpdate(0)
local attached = published()
assert(attached.ready and attached.token ~= initial.token and attached.generation == initial.generation + 1)
before['PlayerPuppet.OnDetach'](); events.onUpdate(0)
assert(not published().ready)
after['PlayerPuppet.OnTakeControl'](); events.onUpdate(0)
local controlled = published()
assert(controlled.ready and controlled.token ~= attached.token and controlled.generation == attached.generation + 1)
local captured = assert(microphone.captureKnowledge({profileKey = 'judy-alvarez'}, 'private'))
assert(captured.owner.worldToken == controlled.token and captured.worldKnowledge.identity.status == 'unknown')
assert(worldCollector.configurations == 1 and convaiQuestContext.capture().status == 'active')
`));
