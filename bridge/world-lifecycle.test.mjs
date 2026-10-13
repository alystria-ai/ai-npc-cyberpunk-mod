import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

const source = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
const subtitlesSource = readFileSync(new URL('../mod/subtitles.lua', import.meta.url), 'utf8');
const subtitleOwnership = subtitlesSource.slice(subtitlesSource.indexOf('function M.ownsUtterance()'),
  subtitlesSource.indexOf('-- Keep normal sentences together.'));
const questSource = readFileSync(new URL('../mod/quest-context.lua', import.meta.url), 'utf8');
const invitationSource = readFileSync(new URL('../mod/invitation-readiness.lua', import.meta.url), 'utf8');
const partyQueueSource = readFileSync(new URL('../mod/manager-party.lua', import.meta.url), 'utf8');
const autoConnectSource = readFileSync(new URL('../mod/auto-connect.lua', import.meta.url), 'utf8');
const gameplayActionsSource = readFileSync(new URL('../mod/gameplay-actions.lua', import.meta.url), 'utf8');
const microphoneSource = readFileSync(new URL('../mod/microphone.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

// Execute the complete adapter and its real tracked-journal collector. Storage,
// actors, surrounding mod modules and native events stay inside this Lua VM.
// Traps record even prohibited calls swallowed by an adapter pcall.
function run(body) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  try {
    const program = `${fixture}\n(function()\n${source}\nend)()\n${body}\nassertClean()`;
    const result = lauxlib.luaL_dostring(state, to_luastring(uiLocaleBootstrap + program));
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
    end, close = function()
        -- world-session.json is written in place (no rename): a closed write is a publication.
        if path == 'runtime/world-session.json' and files[path] then
            local value = json.decode(files[path]); stats.publications[#stats.publications + 1] = value
            note('world-publication', value)
        end
        return true
    end}
end}
os.time = function() return clock end
os.clock = function() return clock end
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
function player:GetEntityID() nativeRead('GetEntityID'); return {hash='player'} end
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
local definitions = {UI_System = {IsInMenu = 'in-menu'},FastTRavelSystem={StartingPoint='starting-point'}}
local board = {GetBool = function() return player.phoneOpen end,GetVariant=function() return 'origin-point' end}
FromVariant=function(value) return value end
local fastTravelSystem={HasFastTravelPoint=function(_,point) return point.known==true end}
local function travelRequest(destination,known,actor)
    return {player=actor or player,pointData={known=known~=false,GetPointRecord=function() return destination end}}
end
local targeting = {GetTargetParts = function() return nil, {} end,
    GetObjectClosestToCrosshair = function() return nil end, GetLookAtObject = function() return nil end,
    GetCrosshairData = function() return {x = 0, y = 0, z = 0}, {x = 0, y = 1, z = 0} end}
Game = {
    GetPlayer = function() nativeRead('GetPlayer'); return player end,
    GetSystemRequestsHandler = function() nativeRead('GetSystemRequestsHandler'); return requests end,
    GetSettingsSystem = function()
        nativeRead('GetSettingsSystem')
        return {GetVar=function(_,group,key)
            assert(group=='/language' and key=='OnScreen')
            return {GetValue=function() return 'en-us' end}
        end}
    end,
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
local companions = {configure = noOp, beginSpatialFrame = noOp, connectionProfiles = function()
    local result = {}; for _, member in ipairs(members) do if member.profileKey then result[#result + 1] = member.profileKey end end
    return result
end, list = function() return copy(members) end,
    registerPhoneContacts = noOp, update = noOp, ownsTravelCommand = function() return true end,
    conversationCandidates = function() return {} end,
    abandon = noOp,
    dismissAll = function() note('companions-dismiss-all') end}
-- The real one caches conversationCandidates for 0.1 s; the fixture asks every frame.
function companions.expressionActors(player) return companions.conversationCandidates(player, 1000) end
function companions.definition(key)
    if key == 'judy-alvarez' then return {name = 'Judy', id = 'Character.Judy', profileKey = key, profileName = 'Judy'} end
    if key == 'johnny-silverhand' then return {name = 'Johnny', id = 'Character.Silverhand', profileKey = key, profileName = 'Johnny'} end
end
function companions.phoneContactKey(contact)
    if contact == 'judy' then return 'judy-alvarez', nil, 'Judy' end
    if contact == 'johnny' then return 'johnny-silverhand', nil, 'Johnny' end
end
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
do local M=subtitles;${subtitleOwnership}end
subtitles.clear=function() subtitles.line,subtitles.pages,subtitles.timed=nil,nil,nil end
local speech = {transcript = noOp, clearEntity = noOp, update = noOp,
    abandon = function() note('speech-abandon') end, stop = noOp,
    start = function(context) stats.starts[#stats.starts + 1] = context.requestId end}
local microphone = {state = 'reply', update = function() return nil end,
    cancel = function() note('microphone-cancel') end}
local group = {cancel = function() note('group-cancel') end,
    received = function(requestId) stats.received[#stats.received + 1] = requestId; return true end}
local phone = {configure = function(_, _, options) stats.phoneOptions = options end,
    update = noOp, abandon = function() note('phone-abandon') end}
local manager = {subtitleStyle = 'game', configure = noOp, interfaceLanguage = function() return 'auto' end, profileEnabled = function() return true end,
    voiceNeedsConvai = function() return stats.voiceNeedsConvai == true end, developerMode = function() return stats.developer == true end, battleReactions = function() return false end, lootReactions = function() return false end,
    update = noOp, reset = function() note('manager-reset') end}
local partyQueue
local mcm = {configure = function(_, suppliedCompanions, factory, _, readiness)
    partyQueue = factory.new(suppliedCompanions, readiness, {developerMode = function() return stats.developer == true end})
end, install = noOp, update = function(currentPlayer, worldReady)
    partyQueue.bind('fixture-player')
    if worldReady then
        partyQueue.flush()
        -- The real provider posts the queue's notices from this same update.
        for _, notice in ipairs(partyQueue.takeNotices()) do currentPlayer:ConvaiPhoneFeedback(notice.message) end
    end
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
    ['gameplay-actions.lua'] = (function() ${gameplayActionsSource} end)(),
    ['composer-input.lua'] = {install = noOp}, ['phone-input.lua'] = {install = noOp}, ['movement-log.lua'] = {update = noOp},
    ['relationship-state.lua'] = {new = function()
        return {update = function() note('relationship-capture') end,
            reset = function(_, reason) note('relationship-unavailable', reason) end}
    end},
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
    if path == 'invitation-readiness.lua' then
        -- Receipts written by a test are read on the next update (production waits up to 250 ms).
        local module = (function() ${invitationSource} end)()
        local new = module.new
        module.new = function(options) options = options or {}; options.readInterval = options.readInterval or 0; return new(options) end
        return module
    end
    if path == 'auto-connect.lua' then return (function() ${autoConnectSource} end)() end
    return assert(modules[path], 'Unexpected mod dependency: ' .. path)
end
files['conversation-characters.json'] = json.encode({{key = 'judy-alvarez', name = 'Judy'}, {key = 'johnny-silverhand', name = 'Johnny'}})
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
companions.beginFastTravel=function()
    note('companions-transit-start'); companions.inTransit=true; return true
end
companions.fastTravel=function()
    if not companions.inTransit then return false end
    note('companions-transit-finished'); companions.travelReturns=(companions.travelReturns or 0)+1
    return true
end
companions.abandon = function(preserveTransit)
    note('companions-abandon'); companions.session = nil
    if not preserveTransit then members = {}; companions.inTransit=nil end
end
speech.abandon = function() note('speech-abandon'); speech.requestId = nil end
subtitles.abandon = function() note('subtitles-abandon'); subtitles.line,subtitles.pages,subtitles.timed = nil,nil,nil end
microphone.cancel = function()
    note('microphone-cancel'); microphone.context, microphone.queued, microphone.knowledgeOwner = nil, nil, nil
end
group.cancel = function() note('group-cancel'); group.round = nil end
phone.abandon = function() note('phone-abandon'); phone.pending = nil end
local function assertSessionsCancelled()
    assert(companions.session == nil and speech.requestId == nil and subtitles.line == nil)
    assert(not subtitles.ownsUtterance())
    assert(microphone.context == nil and microphone.queued == nil and microphone.knowledgeOwner == nil)
    assert(group.round == nil and phone.pending == nil)
end
local function assertClean()
    assert(#stats.forbidden == 0, table.concat(stats.forbidden, ', '))
    for _, message in ipairs(stats.logs) do
        assert(not message:find('update failed', 1, true) and not message:find('observation skipped', 1, true), message)
    end
end
local function privateConversation()
    local actor={GetEntityID=function() return {hash='13ULL'} end,IsNPC=function() return true end,
        IsAttached=function() return true end,IsDeadNoStatPool=function() return false end,
        GetWorldPosition=function() return {x=0,y=3,z=0} end,GetBodyType=function() return 'Woman' end,
        GetRecordID=function() return 'Character.Judy' end,IsCrowd=function() return false end}
    targeting.GetObjectClosestToCrosshair=function() return actor end
    companions.identity=function() return 'judy-alvarez','Judy',true end
    modules['character-catalog.lua'].resolve=function(_,value) return value.managedKey,'Judy' end
    companions.owns=function() return true end
    companions.seatedCandidates=function() return {} end
    player.GetWorldPosition=function() return {x=0,y=0,z=0} end
    player.ConvaiOpenComposer=function() player.composerOpen=true; return true end
    player.ConvaiComposerOpen=function() return player.composerOpen==true end
    player.ConvaiHasSubmission=function() return player.submission~=nil end
    player.ConvaiTakeSubmission=function() local value=player.submission;player.submission=nil;return value end
    local offer={available=true,actor={serial=1,id='13ULL',key='judy-alvarez'},
        car={id='23ULL',record='Vehicle.Test',name='Test car'},waypoint={id='33ULL',name='Map pin',position={x=10,y=20,z=0}},
        passengerSeat='seat_front_right'}
    stats.driveOffers,stats.driveCalls=0,{}
    companions.chauffeurOffer=function(entity)
        nativeRead('chauffeur offer');assert(entity=='13ULL');stats.driveOffers=stats.driveOffers+1;return copy(offer)
    end
    companions.queueChauffeur=function(serial,value,entity)
        nativeRead('chauffeur queue');stats.driveCalls[#stats.driveCalls+1]={serial=serial,offer=copy(value),entity=entity}
        return true
    end
    companions.chauffeurSnapshot=function() return {active=false,phase='idle'} end
    return offer
end
local function drivePacket(input,source)
    local world=published()
    return {version=1,action='drive-to-waypoint',actionId='action:'..input.requestId,
        requestId=input.requestId,generation=input.generation,entity=input.entity,profileKey=input.profileKey,
        source=source or 'private-text',worldToken=world.token,worldGeneration=world.generation,
        createdAt=clock*1000,expiresAt=clock*1000+5000,offer=copy(input.chauffeurOffer)}
end
local function submitText()
    hotkeys.cyberpunk_convai_text()
    assert(player.composerOpen)
    player.composerOpen=false;player.submission='Please drive me to the map waypoint.'
    events.onUpdate(0.1)
    return json.decode(assert(files['runtime/last-input.json']))
end
`;

test('group playback waits for hidden text continuation and advances only after subtitle ownership releases', () => run(`
events.onInit();events.onUpdate(0)
player.GetWorldPosition=function() return {x=0,y=0,z=0} end
local actor={GetEntityID=function()return {hash='13ULL'}end,IsAttached=function()return true end,IsDeadNoStatPool=function()return false end,
 GetWorldPosition=function()return {x=0,y=3,z=0}end,GetBodyType=function()return 'Woman'end,
 GetRecordID=function()return 'Character.Judy'end,IsCrowd=function()return false end}
companions.identity=function()return 'judy-alvarez','Judy',true end
modules['character-catalog.lua'].resolve=function(_,value)return value.managedKey,'Judy' end
local round={requestId='text-round',mode='text',stage='playing',index=1,
 participants={{entity='13ULL',profileKey='judy-alvarez',npc=actor}}}
group.round=round
local completions=0
group.completed=function(request,delivered)
 assert(request=='text-round' and delivered);completions=completions+1;group.round=nil
end
subtitles.pages={'Already displayed overhead.','Still unread.'}
subtitles.line,subtitles.timed=nil,nil
events.onUpdate(.1)
assert(group.round==round and completions==0,'A hidden projected widget is not a completed group reply')
subtitles.clear();events.onUpdate(.1)
assert(group.round==nil and completions==1)
`));

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
-- Heartbeats due together write one per frame (init.lua convaiHeartbeatSlot).
clock = clock + 2; receipt('ready'); for _ = 1, 6 do events.onUpdate(0) end
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

const phoneNoticeFixture = `
events.onInit(); events.onUpdate(0)
local function feedback()
    local out = {}
    for _, item in ipairs(stats.trace) do if item.kind == 'feedback' then out[#out + 1] = item.value end end
    return out
end
player.phoneOpen, player.phoneRequest = true, '+judy'
events.onUpdate(0)
-- Let a second pass: a quick summon shows nothing, and neither does a slow one (no progress is posted).
local early = #feedback()
clock = clock + 4; events.onUpdate(0)
local request = json.decode(assert(files['runtime/companion-invitations.json']))
local job = request.invitations[1]
local function receipt(state)
    files['runtime/companion-invitations-state.json'] = json.encode({version = 1,
        worldToken = request.worldToken, generation = request.generation, updated = clock * 1000, bridgePid = 99,
        invitations = {{id = job.id, revision = job.revision, modelKey = job.modelKey, profileKey = job.profileKey, state = state}}})
end
`;

test('a phone dismissal confirmation is a Developer-mode popup; the phone already says it was queued', () => {
  const dismissal = `
local before = #feedback()
player.phoneOpen, player.phoneRequest = true, '-judy'; events.onUpdate(0)
local posted = #feedback() - before
`;
  run(`${phoneNoticeFixture}${dismissal}
assert(posted == 0, 'a routine dismissal confirmation popped up: ' .. tostring(posted))
`);
  run(`${phoneNoticeFixture}`.replace('events.onInit();', 'stats.developer = true; events.onInit();') + `${dismissal}
assert(posted == 1, 'Developer mode shows the dismissal confirmation: ' .. tostring(posted))
`);
});

test('a frame asks the game once whether V is attached and not in pre-game', () => run(`
events.onInit(); events.onUpdate(0); events.onUpdate(0.2)
local attached, handlers, pregame = 0, 0, 0
local isAttached, getRequests, isPreGame = player.IsAttached, Game.GetSystemRequestsHandler, requests.IsPreGame
player.IsAttached = function(self) attached = attached + 1; return isAttached(self) end
Game.GetSystemRequestsHandler = function() handlers = handlers + 1; return getRequests() end
requests.IsPreGame = function(...) pregame = pregame + 1; return isPreGame(...) end
events.onUpdate(0.001)
assert(attached == 1 and handlers == 1 and pregame == 1,
    'IsAttached ' .. attached .. ', GetSystemRequestsHandler ' .. handlers .. ', IsPreGame ' .. pregame)
`));

test('a frame asks the game once whether the phone is open and hands the answer to the layout and style refreshes', () => run(`
events.onInit(); events.onUpdate(0); events.onUpdate(0.2)
local asks, seen = 0, {}
local isOpen = player.ConvaiPhoneIsOpen
player.ConvaiPhoneIsOpen = function(self) asks = asks + 1; return isOpen(self) end
modules['phone-layout.lua'].refresh = function(force, who, open) seen.layout = {force, who, open} end
modules['phone-chat-style.lua'].refresh = function(force, who, open) seen.style = {force, who, open} end
events.onUpdate(0.01)
assert(asks == 1, 'ConvaiPhoneIsOpen was asked ' .. asks .. ' times in one frame')
for _, name in ipairs({'layout', 'style'}) do
    assert(seen[name][1] == false and seen[name][2] == player and seen[name][3] == false, name .. ' got the wrong frame answers')
end
player.phoneOpen = true
asks = 0; events.onUpdate(0.01)
assert(asks == 1 and seen.layout[3] == true and seen.style[3] == true, 'an open phone was not handed on')
`));

test('the phone request drain runs while the phone is open and just after, then once a second', () => run(`
events.onInit(); events.onUpdate(0); events.onUpdate(0.2)
local takes, take = 0, player.ConvaiPhoneTakeRequest
player.ConvaiPhoneTakeRequest = function(self) takes = takes + 1; return take(self) end
-- Closed for a long while: a hundred frames in one clock reading drain at most once.
clock = clock + 10
for _ = 1, 100 do events.onUpdate(0.01) end
assert(takes <= 1, 'a closed phone was drained ' .. takes .. ' times in 100 frames')
clock = clock + 1.1; takes = 0; events.onUpdate(0.01)
assert(takes == 1, 'the once-a-second backstop did not drain')
-- Open: every frame, so a press is taken at once (and the request is processed).
player.phoneOpen = true; takes = 0
for _ = 1, 5 do events.onUpdate(0.01) end
assert(takes == 5, 'an open phone was drained ' .. takes .. ' times in 5 frames')
-- Closed again: the request queued as it closed is still taken within the grace, every frame.
player.phoneOpen = false; clock = clock + 0.5; takes = 0
for _ = 1, 3 do events.onUpdate(0.01) end
assert(takes == 3, 'the grace after closing drained ' .. takes .. ' of 3 frames')
-- Past the grace the drain falls back to once a second.
clock = clock + 5; events.onUpdate(0.01); takes = 0
for _ = 1, 50 do events.onUpdate(0.01) end
assert(takes == 0, 'a long-closed phone was drained ' .. takes .. ' times')
`));

test('the party-connections look runs every quarter second, a party change publishes at once, and a refused slot retries next frame', () => run(`
events.onInit(); for _ = 1, 10 do events.onUpdate(0) end
local reads, profiles = 0, companions.connectionProfiles
companions.connectionProfiles = function() reads = reads + 1; return profiles() end
clock = clock + 1
for _ = 1, 60 do events.onUpdate(1 / 60) end
assert(reads <= 1, 'the party was derived ' .. reads .. ' times in a frozen clock')
reads = 0
for step = 1, 8 do clock = clock + 0.1; for _ = 1, 6 do events.onUpdate(1 / 60) end end
assert(reads >= 2 and reads <= 4, 'the party was derived ' .. reads .. ' times in 0.8 s')
-- A join is announced by companions.onPartyChanged and reaches the file in the same frame.
members[#members + 1] = {serial = 1, key = 'judy-alvarez', name = 'Judy', profileKey = 'judy-alvarez', state = 'ready'}
companions.onPartyChanged()
local token = files['runtime/party-connections.json']:match('%[(json%-fixture%-%d+)%]')
assert(token and json.decode(token) == 'judy-alvarez', 'a party change waited for the next look')
-- The heartbeat is still due every 2 s: a slot another heartbeat holds delays it a frame, not a quarter second.
local slot = convaiHeartbeatSlot
local writes = function()
    local count = 0
    for _, row in ipairs(stats.io) do if row.path == 'runtime/party-connections.json' and row.mode == 'wb' then count = count + 1 end end
    return count
end
clock = clock + 2.5
local taken = false
convaiHeartbeatSlot = function() if not taken then taken = true; return false end return slot() end
local before = writes()
for _ = 1, 3 do events.onUpdate(1 / 60) end
convaiHeartbeatSlot = slot
assert(writes() == before + 1, 'the refused heartbeat was not retried within a few frames: ' .. (writes() - before))
`));

test('the UI_System blackboard definition is read once, not every frame', () => run(`
local reads, definitions = 0, Game.GetAllBlackboardDefs
Game.GetAllBlackboardDefs = function() reads = reads + 1; return definitions() end
events.onInit(); for _ = 1, 20 do events.onUpdate(1 / 60) end
assert(reads <= 1, 'GetAllBlackboardDefs was called ' .. reads .. ' times in 20 frames')
`));

test('lease heartbeats due in the same second write one per frame, and each still refreshes within the second', () => run(`
events.onInit(); for _ = 1, 10 do events.onUpdate(0) end
local HEARTBEATS = {['runtime/world-session.json'] = true, ['runtime/party-connections.json'] = true,
    ['runtime/relationship-state.json.tmp'] = true, ['runtime/nearby-connections.json.tmp'] = true,
    ['runtime/companion-invitations.json'] = true, ['runtime/speech-state.json'] = true}
local seen, most = {}, 0
for second = 1, 6 do
    clock = clock + 1
    for _ = 1, 30 do
        local before = #stats.io
        events.onUpdate(1 / 30)
        local writes = 0
        for index = before + 1, #stats.io do
            local row = stats.io[index]
            if HEARTBEATS[row.path] and row.mode == 'wb' then writes = writes + 1; seen[row.path] = clock end
        end
        if writes > most then most = writes end
    end
end
assert(most == 1, 'heartbeat writes in one frame: ' .. most)
-- This harness runs these three (speech, relationship facts and auto-connect are stubbed here).
for _, path in ipairs({'runtime/world-session.json', 'runtime/party-connections.json', 'runtime/companion-invitations.json'}) do
    assert(seen[path] and clock - seen[path] <= 2, path .. ' was not refreshed: ' .. tostring(seen[path]))
end
`));

test('the NPC diagnostic hotkey is gone, but the request file still triggers a capture and a response', () => run(`
events.onInit(); events.onUpdate(0)
assert(hotkeys.cyberpunk_convai_diagnostic == nil, 'the diagnostic hotkey is still registered')
assert(hotkeys.cyberpunk_convai_text and hotkeys.cyberpunk_convai_manager)
files['runtime/diagnostic-request.txt'] = 'probe-1'
-- Developer mode off: the mailbox is read every 4 s, inside the request scripts' 8-10 s deadlines.
events.onUpdate(1)
assert((stats.loads['diagnostics.lua'] or 0) == 0, 'the mailbox was read within a second with Developer mode off')
events.onUpdate(3)
assert((stats.loads['diagnostics.lua'] or 0) == 1, 'the request file did not start a capture')
assert(files['runtime/diagnostic-response.txt'] == 'probe-1')
-- Developer mode on: within a second.
stats.developer = true
files['runtime/diagnostic-request.txt'] = 'probe-2'
events.onUpdate(1)
assert((stats.loads['diagnostics.lua'] or 0) == 2 and files['runtime/diagnostic-response.txt'] == 'probe-2')
`));

test('a phone invitation shows a player the preparing line once at any wait and nothing else; the acknowledgement is gone, and a failure waits for gameplay', () => run(`${phoneNoticeFixture}
-- The first sight of the invitation posts one preparing line; no other progress shows, however long it waits.
local prepared = 'Preparing connection to Judy…'
assert(#feedback() == 1 and feedback()[1] == prepared, 'no single preparing line: ' .. table.concat(feedback(), ' | '))
clock = clock + 7; receipt('memory'); events.onUpdate(0)
assert(#feedback() == 1, 'the preparing line repeated after a long wait')
events.onUpdate(0); assert(#feedback() == 1)
clock = clock + 4; receipt('connecting'); events.onUpdate(0)
assert(#feedback() == 1, 'Connecting showed to a player')
clock = clock + 4; receipt('ready'); events.onUpdate(0)
assert(#feedback() == 1, 'the ready line showed to a player')
assert(partyQueue.list()[1].state == 'ready-to-join')
-- Failure first seen while the phone is open: no popup, no consumed claim.
receipt('error'); events.onUpdate(0); events.onUpdate(0); events.onUpdate(0)
assert(partyQueue.list()[1].state == 'failed' and #feedback() == 1, 'the open phone consumed the failure notice')
player.phoneOpen = false; events.onUpdate(0.1)
local posted = feedback()
assert(#posted == 2 and posted[2]:find('could not prepare', 1, true), 'gameplay did not post the single failure notice')
for _ = 1, 3 do events.onUpdate(0.1); player.phoneOpen = true; events.onUpdate(0); player.phoneOpen = false end
assert(#feedback() == 2 and stats.spawned == 0, 'the failed attempt notified again')
`));

test('two phone invitations show their preparing lines once while they wait', () => run(`
events.onInit(); events.onUpdate(0)
local function feedback()
    local out = {}
    for _, item in ipairs(stats.trace) do if item.kind == 'feedback' then out[#out + 1] = item.value end end
    return out
end
local function receipt(state)
    local request = json.decode(assert(files['runtime/companion-invitations.json']))
    local rows = {}
    for _, job in ipairs(request.invitations) do
        rows[#rows + 1] = {id = job.id, revision = job.revision, modelKey = job.modelKey, profileKey = job.profileKey, state = state}
    end
    files['runtime/companion-invitations-state.json'] = json.encode({version = 1,
        worldToken = request.worldToken, generation = request.generation, updated = clock * 1000, bridgePid = 99, invitations = rows})
end
-- The bridge answers every two seconds: a receipt older than 2.5 s is ignored, and 15 s without one fails the preparation.
local function answer(state, seconds)
    for _ = 1, seconds / 2 do clock = clock + 2; receipt(state); events.onUpdate(0) end
end
player.phoneOpen, player.phoneRequest = true, '+judy'
events.onUpdate(0)
answer('memory', 4)
player.phoneRequest = '+johnny'; events.onUpdate(0)
receipt('memory'); events.onUpdate(0)
answer('memory', 12)
assert(#feedback() == 2, 'unexpected notices while two invitations waited: ' .. table.concat(feedback(), ' | '))
assert(feedback()[1] == 'Preparing connection to Judy…' and feedback()[2]:find('Judy', 1, true) and feedback()[2]:find('Johnny', 1, true), table.concat(feedback(), ' | '))
answer('connecting', 4)
answer('ready', 4)
assert(#feedback() == 2, 'the ready line showed to a player')
events.onUpdate(0); assert(#feedback() == 2)
`));

const worldCharacterFixture = `
events.onInit(); events.onUpdate(0)
local function feedback()
    local out = {}
    for _, item in ipairs(stats.trace) do if item.kind == 'feedback' then out[#out + 1] = item.value end end
    return out
end
privateConversation()
-- Judy met in the world: not one of V's copies, resolved by the character catalogue.
companions.owns = function() return false end
companions.identity = function() return nil, nil, false end
modules['character-catalog.lua'].resolve = function() return 'judy-alvarez', 'Judy' end
do
    local actor = targeting.GetObjectClosestToCrosshair()
    function actor:GetTweakDBFullDisplayName() return 'Judy' end
end
`;

test('with Auto-connect off, starting a conversation with a world character that is not connected explains the wait briefly, never mentioning the setting', () => run(`${worldCharacterFixture}
local function talk()
    hotkeys.cyberpunk_convai_text(); assert(player.composerOpen)
    player.composerOpen = false; events.onUpdate(0.1); clock = clock + 1
end
talk(); talk(); talk()
local posted = feedback()
-- The same wait notice is not repeated within 10 s (notices.lua), however often a conversation starts.
assert(#posted == 1, #posted)
assert(posted[1] == 'Preparing connection to Judy…', 'no hint about the setting')
clock = clock + 12; talk()
posted = feedback()
assert(#posted == 2 and posted[2] == posted[1], 'the wait notice did not return after its window')
-- Once the bridge reports the connection ready, nothing is said.
files['runtime/party-connection-state.json'] = json.encode({connections = {{profile = 'judy-alvarez', scope = 'private', state = 'ready'}}})
clock = clock + 12
talk(); assert(#feedback() == 2, 'a connected character still showed the wait notice')
`));

test('a party copy that is still connecting shows the wait notice when V starts talking, and nothing once it is ready', () => run(`${worldCharacterFixture}
companions.owns = function() return true end
local function talk()
    hotkeys.cyberpunk_convai_text(); assert(player.composerOpen)
    player.composerOpen = false; events.onUpdate(0.1); clock = clock + 12
end
talk()
assert(#feedback() == 1 and feedback()[1] == 'Preparing connection to Judy…', 'a connecting party copy showed no wait notice: ' .. table.concat(feedback(), ' | '))
files['runtime/party-connection-state.json'] = json.encode({connections = {{profile = 'judy-alvarez', scope = 'private', state = 'ready'}}})
talk()
assert(#feedback() == 1, 'a ready party copy showed the wait notice')
`));

test('with Auto-connect on, looking at a world character publishes it for the bridge and releasing publishes an empty list', () => run(`${worldCharacterFixture}
manager.autoConnectNearby = function() return true end
-- The fixture's json.encode returns tokens, so read the hand-written document directly.
local function published()
    local raw = files['runtime/nearby-connections.json']
    if not raw then return nil end
    local list = {}
    for token in raw:match('"profiles":%[(.-)%]'):gmatch('[^,]+') do list[#list + 1] = json.decode(token) end
    return {profiles = list, updated = tonumber(raw:match('"updated":(%d+)'))}
end
-- The crosshair target, held for a moment.
for _ = 1, 12 do events.onUpdate(0.1) end
local list = assert(published(), 'no nearby-connections publication')
assert(#list.profiles == 1 and list.profiles[1] == 'judy-alvarez')
assert(list.updated == clock * 1000)
-- With Auto-connect on a talk before the warm-up finishes shows the same wait notice (no hint, no warm-up notice).
local noticesBefore = #feedback()
hotkeys.cyberpunk_convai_text(); assert(player.composerOpen); player.composerOpen = false; events.onUpdate(0.1)
assert(#feedback() == noticesBefore + 1 and feedback()[#feedback()] == 'Preparing connection to Judy…',
    'a talk before the warm-up showed no wait notice: ' .. table.concat(feedback(), ' | '))
-- The setting off releases it at once.
manager.autoConnectNearby = function() return false end
events.onUpdate(0.1)
assert(#published().profiles == 0)
`));

test('with Auto-connect on, looking at a world character and warming her posts no notice, and a talk before she is ready posts exactly one', () => run(`${worldCharacterFixture}
manager.autoConnectNearby = function() return true end
for _ = 1, 60 do events.onUpdate(0.1); clock = clock + 0.1 end
assert(#feedback() == 0, 'the gaze or the warm-up posted a notice: ' .. table.concat(feedback(), ' | '))
hotkeys.cyberpunk_convai_text(); assert(player.composerOpen); player.composerOpen = false; events.onUpdate(0.1)
assert(#feedback() == 1 and feedback()[1] == 'Preparing connection to Judy…', 'the talk start posted: ' .. table.concat(feedback(), ' | '))
for _ = 1, 60 do events.onUpdate(0.1); clock = clock + 0.1 end
assert(#feedback() == 1, 'a notice was posted after the talk start without a new talk: ' .. table.concat(feedback(), ' | '))
`));

test('with Auto-connect on, a talk with a character who is already connected posts no notice', () => run(`${worldCharacterFixture}
manager.autoConnectNearby = function() return true end
for _ = 1, 30 do events.onUpdate(0.1); clock = clock + 0.1 end
files['runtime/party-connection-state.json'] = json.encode({connections = {{profile = 'judy-alvarez', scope = 'private', state = 'ready'}}})
clock = clock + 2
hotkeys.cyberpunk_convai_text(); assert(player.composerOpen); player.composerOpen = false; events.onUpdate(0.1)
assert(#feedback() == 0, 'a connected character showed a notice: ' .. table.concat(feedback(), ' | '))
`));

test('a phone invitation shows the same single preparing line with Developer mode on, and no acknowledgement or other progress', () => run(`${phoneNoticeFixture}
`.replace('events.onInit();', 'stats.developer = true; events.onInit();') + `
assert(early <= 1 and #feedback() == 1 and feedback()[1] == 'Preparing connection to Judy…', 'Developer mode changed the preparing line or added an acknowledgement: ' .. table.concat(feedback(), ' | '))
clock = clock + 4; receipt('connecting'); events.onUpdate(0)
assert(#feedback() == 1, 'Connecting showed to a developer: ' .. table.concat(feedback(), ' | '))
clock = clock + 4; receipt('ready'); events.onUpdate(0); events.onUpdate(0)
assert(#feedback() == 1, 'the ready line showed to a developer: ' .. table.concat(feedback(), ' | '))
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
assert(#stats.publications == publications, 'the 2 s heartbeat republished after one second')
clock = clock + 1; events.onUpdate(0)
local heartbeat = published()
assert(heartbeat.ready and heartbeat.token == first.token and heartbeat.generation == first.generation)
assert(heartbeat.updated == first.updated + 2000 and worldCollector.configurations == 1)
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

test('verified fast travel request preserves only transit intent through detach and waits for true completion', () => run(`
events.onInit(); events.onUpdate(0); primeSessions()
members={{serial=4,key='judy-alvarez',profileKey='panam-palmer',state='ready'}}
local first=published(); local callback=before['FastTravelSystem.OnPerformFastTravelRequest']
local finished=after['FastTravelSystem.OnLoadingScreenFinished']
assert(type(callback)=='function' and type(finished)=='function')
finished(nil,true); assert(companions.travelReturns==nil and published().ready)
callback(fastTravelSystem,travelRequest('origin-point')); assert(not companions.inTransit)
callback(fastTravelSystem,travelRequest('destination',false)); assert(not companions.inTransit)
callback(fastTravelSystem,travelRequest('destination',true,{})); assert(not companions.inTransit)
callback(fastTravelSystem,travelRequest('destination'))
assert(companions.inTransit and #members==1 and not published().ready)
assert(speech.requestId==nil and phone.pending==nil and microphone.context==nil)
local reads=stats.journalReads
tearingDown=true; before['PlayerPuppet.OnDetach'](); tearingDown=false
after['PlayerPuppet.OnGameAttached'](); events.onUpdate(0.1)
assert(companions.inTransit and #members==1 and stats.journalReads==reads and not published().ready)
finished(nil,false); events.onUpdate(0.1)
assert(companions.travelReturns==nil and not published().ready)
tearingDown=true; finished(nil,true); tearingDown=false
events.onUpdate(0)
assert(companions.travelReturns==1 and #members==1 and published().ready)
assert(published().token~=first.token and members[1].profileKey=='panam-palmer')
finished(nil,true); assert(companions.travelReturns==1,'late completion repeated recovery')
`));

test('save restoration and death always discard armed fast travel instead of recreating the party', () => run(`
events.onInit(); events.onUpdate(0)
local begin=before['FastTravelSystem.OnPerformFastTravelRequest']
local finish=after['FastTravelSystem.OnLoadingScreenFinished']
members={{serial=2,key='judy-alvarez',state='ready'}}
begin(fastTravelSystem,travelRequest('destination'))
tearingDown=true; after['PlayerSystem.OnGameRestored'](); tearingDown=false
finish(nil,true); events.onUpdate(0.1)
assert(#members==0 and not companions.inTransit and companions.travelReturns==nil and stats.spawned==0)
members={{serial=3,key='judy-alvarez',state='ready'}}
begin(fastTravelSystem,travelRequest('destination'))
tearingDown=true; before['PlayerPuppet.OnDeath'](); tearingDown=false
finish(nil,true); events.onUpdate(0.1)
assert(#members==0 and not companions.inTransit and companions.travelReturns==nil and not published().ready)
`));

test('unfinished fast travel expires without restoration or native teardown reads', () => run(`
events.onInit(); events.onUpdate(0)
members={{serial=3,key='judy-alvarez',state='ready'}}
before['FastTravelSystem.OnPerformFastTravelRequest'](fastTravelSystem,travelRequest('destination'))
clock=clock+121; events.onUpdate(0.1)
assert(#members==0 and not companions.inTransit and not published().ready)
after['FastTravelSystem.OnLoadingScreenFinished'](nil,true); events.onUpdate(0.1)
assert(companions.travelReturns==nil and not published().ready and stats.spawned==0)
`));

test('expression context samples current actors only in a ready world and listening requires active recording', () => run(`
local context,actorSamples=nil,0
speech.update=function(_,value) context=value end
companions.conversationCandidates=function(_,radius)
 nativeRead('expression actors'); actorSamples=actorSamples+1
 return {{entity='13ULL',profileKey='judy-alvarez'}}
end
player.IsInCombat=function() nativeRead('expression combat'); return false end
events.onInit(); events.onUpdate(0)
assert(context and not context.paused and not context.blocked and #context.actors==1)
microphone.state='recording'; microphone.context={entity='13ULL'}; events.onUpdate(0)
assert(context.listeningEntity=='13ULL')
microphone.state='reply'; events.onUpdate(0)
assert(context.listeningEntity==nil,'inactive microphone context made idle focus look like listening')
local beforeSamples=actorSamples
player.phoneOpen=true; events.onUpdate(0)
assert(context.paused and #context.actors==0 and actorSamples==beforeSamples)
player.phoneOpen=false; player.IsInCombat=function() error('combat state unavailable') end
events.onUpdate(0); assert(context.blocked and #context.actors==1)
tearingDown=true; before['PlayerPuppet.OnDetach'](); tearingDown=false
local lastContext=context; events.onUpdate(0)
assert(context==lastContext and actorSamples==beforeSamples+1)
`));

test('actual private text admission captures the offer and consumes one delayed action after streaming retires pending', () => run(`
events.onInit(); events.onUpdate(0); privateConversation()
hotkeys.cyberpunk_convai_text()
assert(stats.driveOffers==0 and not convaiGameplayActions.inspect().pending,'composer warmup offered an action')
player.composerOpen=false;player.submission='Drive me to my pin.';events.onUpdate(0.1)
local input=json.decode(assert(files['runtime/last-input.json']))
assert(input.chauffeurOffer and input.worldKnowledge.status=='ready' and stats.driveOffers==1)
replyFor(input);events.onUpdate(0.1)
assert(#stats.starts==1 and convaiGameplayActions.inspect().pending,'early reply retired the action lease')
files['runtime/companion-actions.json']=json.encode(drivePacket(input));events.onUpdate(0.1);events.onUpdate(0.1)
assert(#stats.driveCalls==1 and stats.driveCalls[1].serial==1 and stats.driveCalls[1].entity=='13ULL')
assert(not convaiGameplayActions.inspect().pending)
`));

const drivePreparingNotice = (developer) => `
events.onInit(); events.onUpdate(0); privateConversation()
stats.developer = ${developer}
local function notes()
    local out = {}
    for _, item in ipairs(stats.trace) do if item.kind == 'feedback' and string.find(item.value, 'driv') then out[#out + 1] = item.value end end
    return out
end
hotkeys.cyberpunk_convai_text()
player.composerOpen = false; player.submission = 'Drive me to my pin.'; events.onUpdate(0.1)
local input = json.decode(assert(files['runtime/last-input.json']))
replyFor(input); events.onUpdate(0.1)
files['runtime/companion-actions.json'] = json.encode(drivePacket(input)); events.onUpdate(0.1); events.onUpdate(0.1)
assert(#stats.driveCalls == 1, 'the driving request was not queued')
assert(#notes() == 0, 'a queued drive posted a driving notice: ' .. table.concat(notes(), ' | '))
`;
test('a queued driving request posts no preparing notice with Developer mode off', () => run(drivePreparingNotice(false)));
test('a queued driving request posts no preparing notice with Developer mode on', () => run(drivePreparingNotice(true)));

// 2026-10-13 live: two text boxes (generations 12 and 13) closed within seconds and no "Native input captured" line, no bridge turn and no
// word to the player followed. A text box that ends without a message now says how it ended (one probe.log line), and the ends where V
// has lost words also post one notice.
const composerEnds = `
events.onInit(); events.onUpdate(0); privateConversation()
local function logged(fragment) for _, line in ipairs(stats.logs) do if line:find(fragment, 1, true) then return line end end end
local function lostNotes()
    local out = {}
    for _, item in ipairs(stats.trace) do if item.kind == 'feedback' and item.value:find('was not sent', 1, true) then out[#out + 1] = item.value end end
    return out
end
local function openBox() hotkeys.cyberpunk_convai_text(); assert(player.composerOpen, 'the box did not open'); clock = clock + 3 end
local function closeWith(info) player.composerOpen = false; player.closeInfo = info; events.onUpdate(0.1) end
function player:ConvaiComposerClosedInfo() return self.closeInfo end
`;
test('a text box closed with an empty Enter or without a result says so once in probe.log and once to the player; Escape stays quiet', () => run(`${composerEnds}
openBox(); closeWith('empty')
assert(logged('Composer closed without a message: generation='), table.concat(stats.logs, ' | '))
assert(logged('result=empty open=3s'), logged('Composer closed'))
assert(#lostNotes() == 1 and lostNotes()[1] == 'Your message was not sent. Open the text box again and retype it.', table.concat(lostNotes(), ' | '))
openBox(); closeWith('closed:1')
assert(logged('result=closed:1'), 'Escape is logged')
assert(#lostNotes() == 1, 'Escape is a choice: no notice')
openBox(); closeWith('nodata')
assert(logged('result=nodata') and #lostNotes() == 2, 'a close without any result is a lost message')
assert(not logged('Native input captured'), 'nothing was captured')
assert(files['runtime/last-input.json'] == nil, 'no request was written')
`));

test('redscript without the close report still logs the end of a text box, and posts nothing it cannot be sure of', () => run(`${composerEnds.replace(/function player:ConvaiComposerClosedInfo[^\n]*\n/, '')}
openBox(); closeWith(nil)
assert(logged('result=unknown open=3s'), table.concat(stats.logs, ' | '))
assert(#lostNotes() == 0)
`));

test('a typed message that arrives after its character is gone is logged and the player is told', () => run(`${composerEnds}
openBox()
player.attached = false; events.onUpdate(0.1); player.attached = true
player.composerOpen = false; player.submission = 'Where were you last night?'; clock = clock + 1; events.onUpdate(0.1)
assert(logged('Late native input discarded after target loss'), table.concat(stats.logs, ' | '))
assert(logged('Message lost: target lost before the text arrived'))
assert(#lostNotes() == 1)
assert(files['runtime/last-input.json'] == nil, 'no request was written')
`));

test('a message whose request cannot be written is logged and the player is told; the next message still goes out', () => run(`${composerEnds}
local realOpen = io.open
local failing = true
io.open = function(path, mode)
    if failing and path == 'runtime/last-input.json.tmp' then return nil end
    return realOpen(path, mode)
end
openBox(); player.composerOpen = false; player.submission = 'Are you there?'; events.onUpdate(0.1)
assert(logged('Native input captured: generation='), table.concat(stats.logs, ' | '))
assert(logged('Message lost: request not sent generation='), table.concat(stats.logs, ' | '))
assert(#lostNotes() == 1)
assert(files['runtime/last-input.json'] == nil)
failing = false
clock = clock + 5
openBox(); player.composerOpen = false; player.submission = 'Hello again.'; events.onUpdate(0.1)
local input = json.decode(assert(files['runtime/last-input.json']))
assert(input.text == 'Hello again.' and input.generation == 2)
assert(#lostNotes() == 1, 'the second message was sent and posted nothing')
`));

test('actual new conversation, zero-delta menu, reply deadline and restored world each revoke late driving actions', () => run(`
events.onInit();events.onUpdate(0);privateConversation()
local input=submitText();local stale=drivePacket(input)
hotkeys.cyberpunk_convai_text();player.composerOpen=false
files['runtime/companion-actions.json']=json.encode(stale);events.onUpdate(0.1)
assert(#stats.driveCalls==0 and not convaiGameplayActions.inspect().pending)
input=submitText();stale=drivePacket(input);player.phoneOpen=true;events.onUpdate(0)
player.phoneOpen=false;files['runtime/companion-actions.json']=json.encode(stale);events.onUpdate(0.1)
assert(#stats.driveCalls==0)
input=submitText();clock=clock+90
files['runtime/companion-actions.json']=json.encode(drivePacket(input));events.onUpdate(0.1)
assert(#stats.driveCalls==0 and not convaiGameplayActions.inspect().pending,'expired pending action executed')
input=submitText();stale=drivePacket(input)
tearingDown=true;after['PlayerSystem.OnGameRestored']();tearingDown=false
files['runtime/companion-actions.json']=json.encode(stale);events.onUpdate(0.1)
assert(#stats.driveCalls==0 and not convaiGameplayActions.inspect().pending)
`));

test('an explicit reply failure takes priority over an action that arrives in the same gameplay update', () => run(`
events.onInit();events.onUpdate(0);privateConversation()
local input=submitText()
files['runtime/reply.json']=json.encode({requestId=input.requestId,generation=input.generation,entity=input.entity,error='Request failed'})
files['runtime/companion-actions.json']=json.encode(drivePacket(input));events.onUpdate(0.1)
assert(#stats.driveCalls==0 and not convaiGameplayActions.inspect().pending)
`));

test('actual private microphone start captures after cancellation and preserves its action through reply delivery', () => run(`
events.onInit();events.onUpdate(0);privateConversation()
local nativeMic=(function() ${microphoneSource} end)()
for _,key in ipairs({'captureKnowledge','currentKnowledgeOwner','captureJournal','captureBattle','captureFollowUpQuestions',
    'captureActions','onCancelled'})do nativeMic[key]=microphone[key] end
for _,key in ipairs({'begin','finish','cancel','update','received','press'})do
    local operation=nativeMic[key]
    microphone[key]=function(...)
        local result=operation(...)
        for _,field in ipairs({'context','state','knowledgeOwner','targetValid'})do microphone[field]=nativeMic[field] end
        return result
    end
end
hotkeys.cyberpunk_convai_voice()
local started=json.decode(assert(files['runtime/microphone-command.json']))
assert(started.action=='start' and started.input.chauffeurOffer and convaiGameplayActions.inspect().pending)
files['runtime/microphone-state.json']=json.encode({requestId=started.input.requestId,state='recording'});events.onUpdate(0.1);clock=clock+1
hotkeys.cyberpunk_convai_voice()
local finished=json.decode(files['runtime/microphone-command.json'])
assert(finished.action=='finish' and finished.input.chauffeurOffer and stats.driveOffers==1)
replyFor(finished.input);events.onUpdate(0.1)
assert(not microphone.context and convaiGameplayActions.inspect().pending)
files['runtime/companion-actions.json']=json.encode(drivePacket(finished.input,'private-voice'));events.onUpdate(0.1)
assert(#stats.driveCalls==1)
`));

test('the voice key says Convai is needed, and records nothing, only while the voice provider check asks for it', () => run(`
events.onInit();events.onUpdate(0);privateConversation()
local nativeMic=(function() ${microphoneSource} end)()
for _,key in ipairs({'captureKnowledge','currentKnowledgeOwner','captureJournal','captureBattle','captureFollowUpQuestions',
    'captureActions','onCancelled'})do nativeMic[key]=microphone[key] end
for _,key in ipairs({'begin','finish','cancel','update','received','press'})do
    local operation=nativeMic[key]
    microphone[key]=function(...)
        local result=operation(...)
        for _,field in ipairs({'context','state','knowledgeOwner','targetValid'})do microphone[field]=nativeMic[field] end
        return result
    end
end
local function feedback()
    local out = {}
    for _, item in ipairs(stats.trace) do if item.kind == 'feedback' then out[#out + 1] = item.value end end
    return out
end
stats.voiceNeedsConvai = true
hotkeys.cyberpunk_convai_voice()
assert(files['runtime/microphone-command.json'] == nil, 'no recording starts while voice needs Convai')
assert(#feedback() == 1, 'one notice, found ' .. #feedback())
assert(feedback()[1]:find('Convai', 1, true), 'the player is told why')
-- Local speech recognition (or the Convai provider) makes the same key work again.
stats.voiceNeedsConvai = false
clock = clock + 20
hotkeys.cyberpunk_convai_voice()
assert(files['runtime/microphone-command.json'], 'the key records again')
assert(json.decode(files['runtime/microphone-command.json']).action == 'start')
for _, text in ipairs(feedback()) do assert(text:find('Connecting microphone', 1, true) or text:find('needs Convai', 1, true)) end
assert(feedback()[#feedback()]:find('Connecting microphone', 1, true), 'the second press connects the microphone instead')
`));

test('native AutoDrive callbacks observe only an active live trip and detach shutdown performs no native reads', () => run(`
events.onInit();events.onUpdate(0);privateConversation()
local arrivals,toggles,prepared=0,0,0
companions.chauffeurSnapshot=function() return {active=true,phase='driving'} end
companions.chauffeurArrived=function(id)assert(id=='23ULL');arrivals=arrivals+1 end
companions.chauffeurAutodriveToggled=function(enabled)assert(enabled==false);toggles=toggles+1 end
companions.prepareChauffeurShutdown=function()nativeRead('chauffeur shutdown');prepared=prepared+1 end
local auto={GetAutodriveVehicle=function()nativeRead('autodrive car');return {GetEntityID=function()return {hash='23ULL'}end}end,
    GetAutodriveEnabled=function()nativeRead('autodrive enabled');return true end}
before['AutoDriveSystem.OnStopAutoDriveOnDestinationReachedRequest'](auto)
after['AutoDriveSystem.OnAutodriveToggled'](auto,false)
assert(arrivals==1 and toggles==1)
tearingDown=true;before['PlayerPuppet.OnDetach']()
before['AutoDriveSystem.OnStopAutoDriveOnDestinationReachedRequest'](auto)
after['AutoDriveSystem.OnAutodriveToggled'](auto,false)
events.onUpdate(0.1);events.onShutdown();tearingDown=false
assert(arrivals==1 and toggles==1 and prepared==0)
`));

test('phone contact mapping is built once per session, not while the phone is open, and rebuilt after a save load', () => run(`
local registrations = {}
companions.registerPhoneContacts = function(target) assert(target == player); registrations[#registrations + 1] = clock end
events.onInit()
for _ = 1, 3 do clock = clock + 1; events.onUpdate(0.1) end
assert(#registrations == 1, 'mapping is registered once for the session, found ' .. #registrations)
-- Opening Contacts, selecting rows and a contact unlocked meanwhile never rebuild it.
player.phoneOpen = true
for _ = 1, 5 do clock = clock + 1; events.onUpdate(0.1) end
player.phoneOpen = false
for _ = 1, 3 do clock = clock + 1; events.onUpdate(0.1) end
assert(#registrations == 1, 'open phone must not trigger rebuilds, found ' .. #registrations)
-- A save load replaces the native fields, so the next session maps again.
tearingDown = true; after['PlayerSystem.OnGameRestored'](); tearingDown = false
for _ = 1, 3 do clock = clock + 1; events.onUpdate(0.1) end
assert(#registrations == 2, 'new session must register again, found ' .. #registrations)
-- A failed registration (native part not installed) is retried until it succeeds.
companions.registerPhoneContacts = function() registrations[#registrations + 1] = clock; error('native unavailable') end
tearingDown = true; before['PlayerPuppet.OnDetach'](); tearingDown = false
after['PlayerPuppet.OnGameAttached']()
for _ = 1, 3 do clock = clock + 1; events.onUpdate(0.1) end
assert(#registrations == 5)
`));
