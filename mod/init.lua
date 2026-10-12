-- Cyberpunk Convai game adapter. It never renders an ImGui text field.
-- Owns native composers, targeted turns, party connections and live diagnostics.
-- Developer-mode probe: count and time every hook and onUpdate (no effect otherwise).
pcall(function() dofile('perf-probe.lua').hookRegistrations() end)
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
-- The single gate for on-screen notices (notices.lua, docs/NOTIFICATIONS.md). If it cannot load, nothing is shown.
local noticesLoaded, noticesModule = pcall(dofile, 'notices.lua')
if not noticesLoaded or type(noticesModule) ~= 'table' then
    local none = function() return false end
    convaiNotices = convaiNotices or {send = none, sendLines = function() return 0 end, visible = none,
        class = function() return nil end, configure = function() end, developerMode = none}
end
-- Optional: explains a missing or starting conversation service. The adapter
-- keeps working unchanged if this module is absent.
local serviceStatusLoaded, serviceStatus = pcall(dofile, 'service-status.lua')
if not serviceStatusLoaded or type(serviceStatus) ~= 'table' then serviceStatus = nil end
local function serviceCall(name, ...)
    if not serviceStatus or type(serviceStatus[name]) ~= 'function' then return nil end
    local ok, first, second = pcall(serviceStatus[name], ...)
    if ok then return first, second end
    return nil
end
local companions = dofile('companions.lua')
local movementLog = dofile('movement-log.lua')
local subtitles = dofile('subtitles.lua')
local speech = dofile('speech.lua')
local microphone = dofile('microphone.lua')
local characterCatalog = dofile('character-catalog.lua')
local groupChat = dofile('group-chat.lua')
groupChat.captureReply = speech.transcript
local manager = dofile('manager.lua')
convaiNotices.configure(function() return manager.developerMode() end)
local mcm = dofile('mcm.lua')
local phoneLayout = dofile('phone-layout.lua')
local phoneChatStyle = dofile('phone-chat-style.lua')
local phoneChat = dofile('phone-chat.lua')
local questContext = dofile('quest-context.lua')
local battleObserver = dofile('battle-observer.lua')
local battles = dofile('battle-reactions.lua').new()
convaiBattleReactions = battles
-- Companion tactics (Fight / Distract the marked target). The environment is
-- filled in after sendRequest exists; see tacticEnv below.
local tacticEnv = {}
local function tacticModule(path, options, fallback)
    local ok, module = pcall(dofile, path)
    if ok and type(module) == 'table' and type(module.new) == 'function' then
        local built, value = pcall(module.new, options)
        if built and type(value) == 'table' then return value end
        module = value
    end
    print('[CyberpunkConvai] ' .. path .. ' unavailable: ' .. tostring(module))
    return fallback
end
-- A hidden adopted original (companion-adoption.lua) is never a target either.
-- A named or quest-bound game character is never a tactic target (convaiWorldPolicy, set below profileIdentity).
local marking = tacticModule('companion-marking.lua', {owned = function(npc)
        return companions.owns(npc) or (convaiCompanionAdoption ~= nil and convaiCompanionAdoption.hidden(npc)) end,
    protected = function(npc) return convaiWorldPolicy ~= nil and convaiWorldPolicy.protected(npc) == true end,
    log = function(line) if tacticEnv.log then tacticEnv.log(line) end end},
    {current = function() return nil end, abandon = function() end})
local tactics = tacticModule('companion-tactics.lua', {env = tacticEnv}, {
    offer = function() return {available = false} end, start = function() return false, 'Companion tactics are unavailable.' end,
    owns = function() return false end, decide = function() return nil end, busy = function() return false end,
    canDeliver = function() return false end, received = function() return false end, interrupt = function() end,
    update = function() end, abandon = function() end, cancel = function() end})
companions.tactics = tactics
convaiCompanionTactics, convaiTargetMarking = tactics, marking
local lootObserver = dofile('loot-observer.lua')
local loot = dofile('loot-reactions.lua').new()
convaiLootObserver, convaiLootReactions = lootObserver, loot
-- World tokens cancel old work after reloads. The bridge owns the one persistent
-- player ID; collecting game context never creates or changes that ID.
local knowledgeAllowed, knowledgeEpoch, knowledgeInvalidated = false, 0, false
local knowledgeFrame, knowledgeChanged, knowledgeConfigured = nil, false, false
local gameplayActions
local relationshipState = dofile('relationship-state.lua').new({
    currentWorld = function() return knowledgeFrame end})
local knowledgePhoneCapture, knowledgePhoneReceipts = nil, {}
local invitations
local knowledgeLaunch = 'lua-world-' .. tostring(os.time()) .. '-' .. tostring(math.random(100000000, 999999999))
local worldSessionSignature, worldSessionAt = nil, nil
local function knowledgeUnavailable(reason)
    return {version = 1, status = 'unavailable', reason = reason or 'world-unavailable'}
end
local function knowledgeOwner(frame)
    return {session = knowledgeEpoch, generation = frame and frame.generation, worldToken = frame and frame.worldToken,
        paused = frame and frame.status == 'paused' or false}
end
local function sameKnowledgeOwner(a, b)
    return a and b and a.session == b.session and a.generation == b.generation and a.worldToken == b.worldToken
end
local worldKnowledge = dofile('world-knowledge.lua').new({
    currentGeneration = function() return knowledgeFrame and knowledgeFrame.generation end,
    currentWorldToken = function() return knowledgeFrame and knowledgeFrame.worldToken end})
local journalHistory = dofile('journal-history.lua').new({
    currentGeneration = function() return knowledgeFrame and knowledgeFrame.generation end,
    currentWorldToken = function() return knowledgeFrame and knowledgeFrame.worldToken end})
convaiWorldKnowledge = worldKnowledge

local function publishWorldSession(frame, ready, force)
    local now = os.time()
    local value = {version = 1, token = frame and frame.worldToken or (knowledgeLaunch .. '-' .. (knowledgeEpoch + 1)),
        generation = frame and frame.generation or (knowledgeEpoch + 1), ready = ready == true, updated = now * 1000}
    local signature = value.token .. ':' .. tostring(value.ready)
    -- Lease heartbeat: the bridge keeps world-session.json 5 s; refresh it every 2 s or on change.
    if not force and signature == worldSessionSignature and worldSessionAt and now >= worldSessionAt
        and now - worldSessionAt < 2 then return end
    local encoded, raw = pcall(json.encode, value); if not encoded then return end
    local path = 'runtime/world-session.json'
    local file = io.open(path .. '.tmp', 'wb'); if not file then return end
    local written, closed = file:write(raw), file:close(); if not written or not closed then return end
    -- Windows rename cannot replace a file: remove first (one file operation fewer each second).
    os.remove(path); if not os.rename(path .. '.tmp', path) then return end
    worldSessionSignature, worldSessionAt = signature, now
end

local function refreshKnowledgeFrame()
    if not knowledgeAllowed then return knowledgeUnavailable() end
    local frame = {version = 1, status = 'ready', generation = knowledgeEpoch + 1,
        worldToken = knowledgeLaunch .. '-' .. (knowledgeEpoch + 1)}
    if knowledgeFrame and not sameKnowledgeOwner(knowledgeOwner(knowledgeFrame), knowledgeOwner(frame)) then
        knowledgeChanged = true
        worldKnowledge:reset(nil, 'world-binding-changed'); journalHistory:reset()
    end
    knowledgeFrame = frame
    publishWorldSession(frame, true)
    return frame
end

local function invalidateKnowledge(reason)
    -- No native reads here: teardown must publish unavailable before any actor
    -- cleanup. The local epoch is a cancellation guard, never a save identity.
    local before = knowledgeFrame
    if gameplayActions then gameplayActions.revoke(reason) end
    knowledgeAllowed, knowledgeFrame, knowledgePhoneCapture = false, nil, nil
    publishWorldSession(before, false, true)
    relationshipState:reset(reason)
    if invitations then invitations.bind(nil) end
    knowledgeEpoch, knowledgeChanged = knowledgeEpoch + 1, false
    knowledgeInvalidated = true
    worldKnowledge:reset(nil, reason); journalHistory:reset()
end

local function configureKnowledge()
    if knowledgeConfigured then return end
    knowledgeConfigured = true
    local file = io.open('world-knowledge.json', 'rb')
    if not file then return end
    local raw = file:read(16 * 1024 * 1024 + 1); file:close()
    if type(raw) ~= 'string' or #raw > 16 * 1024 * 1024 then return end
    local decoded, pack = pcall(json.decode, raw)
    local versionOk, version = pcall(function() return Game.GetSystemRequestsHandler():GetGameVersion() end)
    if decoded and type(pack) == 'table' and versionOk and type(version) == 'string' then
        worldKnowledge:configure(pack, {gameVersion = version})
    end
end

local function updateKnowledge(delta)
    local before = refreshKnowledgeFrame()
    if before.status == 'paused' then return end
    if before.status ~= 'ready' then
        relationshipState:reset(before.reason)
        worldKnowledge:reset(nil, before.reason); journalHistory:reset(); return
    end
    configureKnowledge()
    relationshipState:update(before)
    local context = {generation = before.generation, worldToken = before.worldToken}
    -- Each collector enforces its own per-frame work and age limits. A second
    -- inspection rejects any native transition that occurred during its reads.
    worldKnowledge:update(context); journalHistory:update(context)
    refreshKnowledgeFrame()
end

local function captureKnowledge(context, channel)
    if not knowledgeAllowed then return nil end
    local before = refreshKnowledgeFrame()
    if before.status == 'paused' then return nil, 'save-in-progress' end
    local owner = knowledgeOwner(before)
    local audience = {channel = channel or (context.group and 'group' or 'private'), profileKeys = {}}
    if context.group then
        for _, key in ipairs(context.group.audience or {}) do audience.profileKeys[#audience.profileKeys + 1] = key end
    elseif context.profileKey then audience.profileKeys[1] = context.profileKey end
    -- Canonical decisions come from the current world. A provider's recalled
    -- conversation is never proof that this save took a particular branch.
    local identity = {status = 'unknown'}
    local world, history = knowledgeUnavailable(before.reason), knowledgeUnavailable(before.reason)
    if before.status == 'ready' then
        local binding = {generation = before.generation, worldToken = before.worldToken, audience = audience, identity = identity}
        world, history = worldKnowledge:capture(binding), journalHistory:capture(binding)
    end
    local after = refreshKnowledgeFrame()
    if not knowledgeAllowed or not sameKnowledgeOwner(owner, knowledgeOwner(after)) then return nil end
    if after.status == 'paused' then return nil, 'save-in-progress' end
    return {worldKnowledge = world, journalHistory = history, owner = owner}
end

local function attachKnowledge(context)
    local ok, captured = pcall(captureKnowledge, context)
    if not ok or not captured then return nil end
    context.worldKnowledge, context.journalHistory = captured.worldKnowledge, captured.journalHistory
    return captured.owner
end

-- World characters joining V and party members leaving (docs/WORLD_COMPANIONS.md).
-- Created after the conversation state it reads; see companion-adoption.lua.
local adoption
-- The native actor of the conversation that owns this entity, if any.
local function conversationNpc(entity)
    local npc = speech.target
    local ok, id = pcall(function() return npc and tostring(npc:GetEntityID().hash) end)
    return ok and id == entity and npc or nil
end
gameplayActions = dofile('gameplay-actions.lua').new({
    world = function()
        return {ready = knowledgeAllowed and knowledgeFrame ~= nil and knowledgeFrame.status == 'ready',
            worldToken = knowledgeFrame and knowledgeFrame.worldToken,
            generation = knowledgeFrame and knowledgeFrame.generation}
    end,
    offer = function(entity) return companions.chauffeurOffer(entity) end,
    queue = function(serial, offer, entity) return companions.queueChauffeur(serial, offer, entity) end,
    tacticOffer = function(entity) return tactics.offer(entity) end,
    queueTactic = function(kind, offer, entity) return tactics.start(kind, offer, entity) end,
    followOffer = function(entity, context)
        return adoption and adoption.offer(entity, conversationNpc(entity), context.profileKey, context.name) or nil
    end,
    leaveOffer = function(entity, context) return adoption and adoption.leaveOffer(entity, context) or nil end,
    queueFollow = function(offer, entity, requestId)
        if not adoption then return false, ui.t('That action is not available.') end
        return adoption.queueFollow(offer, entity, requestId)
    end,
    queueLeave = function(target, offer, entity, requestId, groupId)
        if not adoption then return false, ui.t('That action is not available.') end
        return adoption.queueLeave(target, offer, entity, requestId, groupId)
    end,
    developerMode = manager.developerMode,
    feedback = function(state, reason)
        local player = Game.GetPlayer()
        -- A queued action with no text posts nothing: a queued drive has none.
        if state == 'queued' and (reason == nil or reason == '') then return end
        if player then convaiNotices.send(player, state == 'queued' and 'action-queued' or 'action-rejected',
            ui.t(reason or 'The driving request could not be queued.')) end
    end})
convaiGameplayActions = gameplayActions
microphone.captureActions = function(context)
    return gameplayActions.capture(context, context.group and 'group-voice' or 'private-voice')
end

local function capturePhoneBinding()
    local frame = refreshKnowledgeFrame()
    if frame.status ~= 'ready' then return knowledgeUnavailable(frame.reason) end
    -- Local display history follows the single-player policy across saves.
    -- This hint grants no native identity/cloud authority: provider routing
    -- still uses the bridge's player ID and exact live-world generation.
    return {version = 1, status = 'unavailable', authoritative = false,
        generation = frame.generation, historyScope = 'local-player-v1'}
end

local function publishPhoneDelivery(receipt)
    if type(receipt) ~= 'table' or receipt.source ~= 'phone-ui' or receipt.state ~= 'accepted'
        or receipt.partial ~= false or receipt.cancelled ~= false or type(receipt.id) ~= 'string'
        or #receipt.id == 0 or #receipt.id > 240 or type(receipt.completedAt) ~= 'number' then return end
    for _, prior in ipairs(knowledgePhoneReceipts) do if prior.id == receipt.id then return end end
    local row = {version = 1, source = 'phone-ui', state = 'accepted', partial = false, cancelled = false}
    for _, key in ipairs({'id', 'requestId', 'profileKey', 'contact', 'world', 'binding', 'worldToken'}) do
        if type(receipt[key]) == 'string' and #receipt[key] <= 600 then row[key] = receipt[key] end
    end
    for _, key in ipairs({'sequence', 'completedAt', 'generation'}) do
        local value = receipt[key]
        if type(value) == 'number' and value == value and value >= 0 and value < math.huge then row[key] = value end
    end
    if not row.requestId or not row.profileKey or not row.world or not row.binding or not row.completedAt then return end
    knowledgePhoneReceipts[#knowledgePhoneReceipts + 1] = row
    if #knowledgePhoneReceipts > 16 then table.remove(knowledgePhoneReceipts, 1) end
    local ok, raw = pcall(json.encode, {version = 1, updated = os.time() * 1000, receipts = knowledgePhoneReceipts})
    if not ok or #raw > 32768 then return end
    local path = 'runtime/knowledge-phone-delivery.json'
    local file = io.open(path .. '.tmp', 'wb'); if not file then return end
    local written, closed = file:write(raw), file:close()
    if not written or not closed then return end
    if not os.rename(path .. '.tmp', path) then os.remove(path); os.rename(path .. '.tmp', path) end
end

microphone.captureKnowledge = captureKnowledge
microphone.currentKnowledgeOwner = function()
    if not knowledgeAllowed then return nil end
    return knowledgeOwner(refreshKnowledgeFrame())
end
groupChat.captureJournal = questContext.capture
phoneChat.captureJournal = questContext.capture
microphone.captureJournal = questContext.capture
groupChat.captureBattle = battles.capture
phoneChat.captureBattle = battles.capture
microphone.captureBattle = battles.capture
convaiPhoneChat = phoneChat
convaiGroupChat = groupChat
-- Phone Chat keeps the draft and shows this inline when no service can reply.
phoneChat.serviceBlocked = function() return (serviceCall('blockedMessage', os.time())) end
groupChat.onPreparation = function(preparation)
    if preparation and not attachKnowledge(preparation.input) then preparation = nil end
    local f = io.open('runtime/group-prefetch.json.tmp', 'wb')
    if not f then return end
    f:write(preparation and json.encode(preparation) or '{}'); f:close()
    os.remove('runtime/group-prefetch.json')
    os.rename('runtime/group-prefetch.json.tmp', 'runtime/group-prefetch.json')
end
groupChat.onPreparation(nil)
local supportedProfiles = {}
local profiles = {}
do
    local f = io.open('conversation-characters.json', 'rb')
    if f then
        local ok, decoded = pcall(json.decode, f:read('*a')); f:close()
        if ok and type(decoded) == 'table' then profiles = decoded end
        for _, profile in ipairs(profiles) do supportedProfiles[profile.key] = true end
    end
end
-- Generic NPC archetypes (docs/NPC_ARCHETYPES.md): talk-only profiles chosen
-- from an unnamed NPC's TweakDB facts. They are not listed as companions.
local archetypes = type(characterCatalog.buildArchetypes) == 'function'
    and characterCatalog.buildArchetypes(characterCatalog.ARCHETYPES) or {keys = {}, records = {}}
for key in pairs(archetypes.keys) do supportedProfiles[key] = true end
manager.configure(companions, profiles)
if type(manager.configureArchetypes) == 'function' then
    manager.configureArchetypes(archetypes.keys,
        type(characterCatalog.classifyRecord) == 'function'
            and function(facts) return (characterCatalog.classifyRecord(archetypes, facts)) end or nil,
        type(characterCatalog.archetypeLabel) == 'function'
            and function(key) return characterCatalog.archetypeLabel(archetypes, key) end or nil)
end
subtitles.configure({style = manager.subtitleStyle})
companions.onBeforeRemove = speech.clearEntity
phoneChat.configure(profiles, manager, {
    captureBinding = capturePhoneBinding,
    captureWorldKnowledge = function(_, key)
        knowledgePhoneCapture = captureKnowledge({profileKey = key}, 'phone')
        return knowledgePhoneCapture and knowledgePhoneCapture.worldKnowledge or knowledgeUnavailable()
    end,
    captureJournalHistory = function()
        local captured = knowledgePhoneCapture; knowledgePhoneCapture = nil
        if captured and sameKnowledgeOwner(captured.owner, knowledgeOwner(refreshKnowledgeFrame())) then
            return captured.journalHistory
        end
        return knowledgeUnavailable('phone-world-changed')
    end,
    onDelivered = publishPhoneDelivery})
invitations = dofile('invitation-readiness.lua').new({
    world = function()
        if not knowledgeAllowed or not knowledgeFrame or knowledgeFrame.status ~= 'ready' then return nil end
        return {worldToken = knowledgeFrame.worldToken, generation = knowledgeFrame.generation}
    end,
    isKnown = function(key) return supportedProfiles[key] == true end})
convaiInvitations = invitations
companions.canSpawn = function(key, job)
    if type(job) ~= 'table' or job.key ~= key then
        return false, 'Invite this character from the phone or Companion Manager first.'
    end
    local state = invitations.status(job)
    if state.state == 'ready' or state.state == 'model-only' then return true end
    return false, 'Memory and connection preparation must finish before this character can join.'
end
-- Every posted invitation notice (and each stage regression the board ignored)
-- is logged to runtime/mcm.log, so a notice that flashed by can be read back.
convaiNoticeLog = function(message)
    local file = io.open('runtime/mcm.log', 'a')
    if file then file:write(os.date('!%Y-%m-%dT%H:%M:%SZ'), ' ', tostring(message), '\n'); file:close() end
end
mcm.configure(manager, companions, dofile('manager-party.lua'), dofile('mcm-entry.lua'), invitations)
convaiManager = mcm
local catalog = characterCatalog.build(profiles, archetypes)
for record, profile in pairs(characterCatalog.build(profiles).records) do
    local ok, id = pcall(function() return tostring(TweakDBID.new(record)) end)
    if ok then catalog.records[id] = profile end
end
do -- archetype crowd/vendor record names, also by TweakDBID string
    local named = {}
    for record, base in pairs(archetypes.records) do named[record] = base end
    for record, base in pairs(named) do
        local ok, id = pcall(function() return tostring(TweakDBID.new(record)) end)
        if ok then archetypes.records[id] = archetypes.records[id] or base end
    end
end
convaiCompanions = companions
-- Developer-mode frame-cost probe (runtime/perf-probe.json). It wraps module
-- table fields from outside, so the onUpdate closure gains no upvalue.
pcall(function() dofile('perf-probe.lua').install(companions, function() return manager.developerMode() end) end)
pcall(function()
    local probe = convaiPerfProbe
    probe.watch(manager, 'update', 'manager.update'); probe.watch(tactics, 'update', 'tactics.update')
    probe.watch(microphone, 'update', 'microphone.update'); probe.watch(movementLog, 'update', 'movementLog.update')
    probe.watch(worldKnowledge, 'update', 'worldKnowledge.update'); probe.watch(journalHistory, 'update', 'journalHistory.update')
    probe.watch(relationshipState, 'update', 'relationshipState.update')
end)
local generation = 0
local active = nil
local pending = nil
local pendingKnowledgeOwner = nil
local poll = 0
local diagnosticPoll = 0
local lastDiagnosticRequest = nil
local focusUntil = nil
local focusMode = nil
local focusEntity = nil
local gazeCandidate = nil
local gazeDwell = 0
local gazeLost = 0
local gazePoll = 0
local focusedCrowd = nil
local releasedCrowd = nil
local automatic, battleSample, battlePeople, battlePoll = nil, nil, {}, 0
local lastAutomatic = nil
local cancelAutomatic = function() end
local phoneCatalogReady = false
local function profileEnabled(player, key)
    return manager.profileEnabled(key)
end

-- Plain TweakDB facts of an unnamed NPC for archetype classification. Each
-- read is guarded; an unreadable fact is simply absent. Cached per entity
-- (a record never changes for a spawned actor); the cache is small and reset
-- when full. Confirm each read in game: docs/NPC_ARCHETYPES.md.
local archetypeFactCache, archetypeFactCount = {}, 0
local function nameString(value)
    if type(value) == 'string' then return value end
    if value == nil then return nil end
    local ok, text = pcall(function() return Game.NameToString(value) end)
    if ok and type(text) == 'string' and text ~= '' and text ~= 'None' then return text end
    ok, text = pcall(tostring, value)
    return ok and type(text) == 'string' and text or nil
end
local function archetypeFacts(npc, entity, body)
    local cached = entity and archetypeFactCache[entity]
    if cached then return cached end
    local facts = {bodyType = body}
    local function read(name, fn)
        local ok, value = pcall(fn)
        if ok and value ~= nil then facts[name] = value end
    end
    local recordId
    read('recordId', function() recordId = npc:GetRecordID(); return tostring(recordId) end)
    read('recordName', function()
        local text = TDBID.ToStringDEBUG(recordId)
        return type(text) == 'string' and text:find('^Character%.') and text or nil
    end)
    read('crowd', function() return npc:IsCrowd() == true end)
    read('children', function() return npc:IsCharacterChildren() == true end)
    read('police', function() return npc:IsCharacterPolice() == true end)
    read('vendor', function() return npc:IsVendor() == true end)
    read('human', function() return npc:GetNPCType() == Enum.new('gamedataNPCType', 'Human') end)
    read('affiliation', function() return nameString(npc:GetAffiliation()) end)
    read('gender', function() return nameString(npc:GetResolvedGenderName()) end)
    local record
    read('quest', function()
        record = TweakDBInterface.GetCharacterRecord(recordId)
        local quest = record and record:Quest()
        return quest and nameString(quest:EnumName()) or nil
    end)
    if facts.vendor then
        read('vendorType', function()
            record = record or TweakDBInterface.GetCharacterRecord(recordId)
            local vendor = record and record:VendorID()
            local kind = vendor and vendor:VendorType()
            return kind and nameString(kind:EnumName()) or nil
        end)
    end
    if entity then
        if archetypeFactCount >= 256 then archetypeFactCache, archetypeFactCount = {}, 0 end
        archetypeFactCache[entity], archetypeFactCount = facts, archetypeFactCount + 1
    end
    return facts
end

-- The district V is in (top-level and the most specific known), for archetype
-- and resident context. Nil when the prevention system cannot say.
local function currentDistrict()
    local ok, top, local_ = pcall(function()
        local system = Game.GetScriptableSystemsContainer():Get('PreventionSystem')
        local district = system and system:GetCurrentDistrict()
        local record = district and TweakDBInterface.GetDistrictRecord(district:GetDistrictID())
        if not record then return nil end
        local specific = nameString(record:EnumName())
        local root, guard = record, 0
        while root and root:ParentDistrict() and guard < 6 do root, guard = root:ParentDistrict(), guard + 1 end
        return nameString(root:EnumName()), specific
    end)
    if not ok or type(top) ~= 'string' then return nil end
    return {district = top, area = local_ ~= top and local_ or nil}
end

local function profileIdentity(npc)
    local managedKey, managedName, owned = companions.identity(npc)
    local name = managedName or tostring(npc:GetTweakDBFullDisplayName(true) or 'NPC')
    local body = tostring(npc:GetBodyType() or '')
    if owned and not managedKey then return nil, name, body end
    local recordOk, record = pcall(function() return tostring(npc:GetRecordID()) end)
    local crowdOk, crowd = pcall(function() return npc:IsCrowd() end)
    -- world: the game's own character, not a copy the mod spawned. A named story character there gets no
    -- conversation profile at all (character-catalog.lua resolve); only the spawned copy talks.
    local actor = {managedKey = managedKey, name = name, world = managedKey == nil,
        bodyType = body, record = recordOk and record or '', crowd = crowdOk and crowd}
    if not managedKey and type(manager.archetypeConversations) == 'function' and manager.archetypeConversations() then
        local idOk, entity = pcall(function() return tostring(npc:GetEntityID().hash) end)
        actor.facts = archetypeFacts(npc, idOk and entity or nil, body)
    end
    local key, canonical, archetype = characterCatalog.resolve(catalog, actor)
    return key, canonical, body, archetype
end

-- The one rule for characters the game placed (docs/WORLD_COMPANIONS.md, "The mod never touches game characters"):
--   ours(npc)      a copy the mod spawned: the full feature set.
--   protected(npc) a named, story or quest character of the game: no mod system touches it at all.
--   everyone else  an ordinary world NPC: only the talk path (a conversation the player starts) acts on it.
-- Read on demand (a request, a conversation start), cached per entity, never per frame.
local protectedCache, protectedCount = {}, 0
convaiWorldPolicy = {
    ours = function(npc)
        local ok, _, _, owned = pcall(companions.identity, npc)
        return ok and owned == true
    end,
    protected = function(npc)
        if not npc then return false end
        local ok, _, _, owned = pcall(companions.identity, npc)
        if ok and owned == true then return false end
        local idOk, entity = pcall(function() return tostring(npc:GetEntityID().hash) end)
        if not idOk then return false end
        local cached = protectedCache[entity]
        if cached ~= nil then return cached end
        local recordOk, record = pcall(function() return tostring(npc:GetRecordID()) end)
        local nameOk, name = pcall(function() return tostring(npc:GetTweakDBFullDisplayName(true) or '') end)
        local bodyOk, body = pcall(function() return tostring(npc:GetBodyType() or '') end)
        local reason = characterCatalog.protectedReason(catalog, {record = recordOk and record or '',
            name = nameOk and name or '', facts = archetypeFacts(npc, entity, bodyOk and body or '')})
        if protectedCount >= 256 then protectedCache, protectedCount = {}, 0 end
        protectedCache[entity], protectedCount = reason ~= nil, protectedCount + 1
        return reason ~= nil
    end,
}

-- Recent game dialogue (subtitled scene lines and V's chosen options), attached
-- to manual turns so a reply follows on from what was just said in the game.
-- See docs/GAME_DIALOGUE_CONTEXT.md. The bridge scopes it to the addressee.
-- Optional: the adapter keeps working unchanged if this module is absent.
local gameDialogueLoaded, gameDialogueModule = pcall(dofile, 'game-dialogue.lua')
local gameDialogue = gameDialogueLoaded and type(gameDialogueModule) == 'table'
    and type(gameDialogueModule.new) == 'function' and gameDialogueModule.new({
    enabled = function() return type(manager.gameDialogueContext) ~= 'function' or manager.gameDialogueContext() == true end,
    resolve = function(speaker)
        if not speaker:IsNPC() then return nil end
        local key, canonical = profileIdentity(speaker)
        return key, canonical
    end,
    resolveName = function(name) return (characterCatalog.resolve(catalog, {name = name, crowd = false})) end,
    contactKey = function(contact) return (companions.phoneContactKey(contact)) end,
    present = function(radius)
        local keys = {}
        for _, person in ipairs(companions.conversationCandidates(Game.GetPlayer(), radius)) do keys[#keys + 1] = person.profileKey end
        return keys
    end}) or nil
convaiGameDialogue = gameDialogue
local function captureGameDialogue() return gameDialogue and gameDialogue:capture() or nil end
groupChat.captureGameDialogue = captureGameDialogue
phoneChat.captureGameDialogue = captureGameDialogue
microphone.captureGameDialogue = captureGameDialogue

-- What V is wearing and carrying, attached to manual turns (docs/PLAYER_GEAR_CONTEXT.md). Read on demand when a turn
-- is built, cached for a few seconds, never per frame. The bridge words it and tells the character not to bring it up
-- unless it matters. Optional: the adapter keeps working unchanged if this module is absent.
local playerGearLoaded, playerGearModule = pcall(dofile, 'player-gear.lua')
local playerGear = playerGearLoaded and type(playerGearModule) == 'table'
    and type(playerGearModule.new) == 'function' and playerGearModule.new({}) or nil
convaiPlayerGear = playerGear
local function capturePlayerGear() return playerGear and playerGear:capture() or nil end
groupChat.capturePlayerGear = capturePlayerGear
microphone.capturePlayerGear = capturePlayerGear

-- entity: the addressed character's ID ("<hash>ULL") for a private conversation. A generic resident or archetype
-- has no connection without its body, so the bridge opens that NPC's own route while V types or speaks.
local function warmConversation(participants, key, entity)
    local f = io.open('runtime/conversation-prewarm.json.tmp', 'wb')
    if not f then return end
    local hint = '{}'
    if key then
        local audience = {}
        if participants then
            for _, person in ipairs(participants) do audience[#audience + 1] = person.profileKey end
        else audience[1] = key end
        hint = json.encode({nonce = 'composer-' .. tostring(os.time()) .. '-' .. tostring(generation),
            audience = audience, group = participants ~= nil,
            entity = participants == nil and type(entity) == 'string' and entity or nil})
    end
    f:write(hint); f:close()
    os.remove('runtime/conversation-prewarm.json')
    os.rename('runtime/conversation-prewarm.json.tmp', 'runtime/conversation-prewarm.json')
end
warmConversation(nil, nil)

local lastPartyHint, lastPartyHeartbeat = nil, 0
local function publishPartyConnections(force)
    local keys, encoded = {}, {}
    for _, key in ipairs(companions.connectionProfiles()) do
        if manager.profileEnabled(key) then keys[#keys + 1] = key end
    end
    local signature, now = table.concat(keys, ','), os.time()
    if not force and signature == lastPartyHint and now - lastPartyHeartbeat < 2 then return end
    for _, key in ipairs(keys) do encoded[#encoded + 1] = json.encode(key) end
    local f = io.open('runtime/party-connections.json.tmp', 'wb')
    if not f then return end
    f:write('{"updated":' .. tostring(now * 1000) .. ',"profiles":[' .. table.concat(encoded, ',') .. ']}')
    f:close()
    os.remove('runtime/party-connections.json')
    if os.rename('runtime/party-connections.json.tmp', 'runtime/party-connections.json') then
        lastPartyHint, lastPartyHeartbeat = signature, now
    end
end
companions.onPartyChanged = function() publishPartyConnections(true) end
publishPartyConnections(true)

local function log(line)
    local file = io.open('runtime/probe.log', 'a')
    if file then
        file:write(os.date('!%Y-%m-%dT%H:%M:%SZ'), ' ', line, '\n')
        file:close()
    end
    print('[CyberpunkConvai] ' .. line)
end
-- V's horizontal speed in m/s, read once when a text box takes the keyboard. If V
-- keeps walking after typing (a key-up the game never saw), the log line shows
-- whether V was already moving at that moment. 'n/a' when the game will not say.
local function playerSpeedText(player)
    local ok, velocity = pcall(function() return player:GetVelocity() end)
    if not ok or velocity == nil then return 'n/a' end
    local okRead, speed = pcall(function() return math.sqrt(velocity.x ^ 2 + velocity.y ^ 2) end)
    if not okRead or type(speed) ~= 'number' or speed ~= speed then return 'n/a' end
    return string.format('%.2f', speed)
end
-- Phone chat typing opened (mod/phone-chat.lua, 10 Hz tick, one line per typing session).
phoneChat.typingOpened = function(player, contact)
    log('Phone chat typing opened: contact=' .. tostring(contact) .. ' speed=' .. playerSpeedText(player))
end
-- V's gear: one line per real read (bridge/player-gear.mjs logs the other half per reply), so a test shows what was built.
if playerGear then playerGear.options.log = log end
-- Doors, lifts, fast travel and stranded followers: one line per recovery
-- decision (companions.lua note(), throttled per kind; never per frame).
companions.recoveryLog = function(kind, fields)
    local ok, text = pcall(json.encode, fields or {})
    log('Companion recovery ' .. tostring(kind) .. ' ' .. (ok and text or ''))
end

-- An NPC the mod addresses keeps quiet about V staring or standing close
-- (mod/vanilla-reactions.lua). Reached through the global from beginFocus,
-- endFocus and the lifecycle hooks; a missing module only removes the feature.
do
    local loaded, module = pcall(dofile, 'vanilla-reactions.lua')
    local built, value = false, module
    if loaded and type(module) == 'table' and type(module.new) == 'function' then
        built, value = pcall(module.new, {round = function() return groupChat.round end, log = log})
    end
    if built and type(value) == 'table' then convaiVanillaReactions = value
    else convaiVanillaReactions = nil; print('[CyberpunkConvai] vanilla-reactions.lua unavailable: ' .. tostring(value)) end
end

-- Talk-key target decisions (mod/talk-target.lua), reached through the global
-- from targetAtCrosshair and selectConversation; a missing module keeps the
-- original nearest-to-centre ranking.
do
    local loaded, module = pcall(dofile, 'talk-target.lua')
    local built, value = false, module
    if loaded and type(module) == 'table' and type(module.new) == 'function' then built, value = pcall(module.new) end
    if built and type(value) == 'table' then convaiTalkTarget = value
    else convaiTalkTarget = nil; print('[CyberpunkConvai] talk-target.lua unavailable: ' .. tostring(value)) end
end

-- World characters asked to follow join as managed copies; party members asked
-- to leave are dismissed after their goodbye (docs/WORLD_COMPANIONS.md). A
-- missing module only removes the two actions.
do
    local named = {}
    for _, profile in ipairs(profiles) do named[profile.key] = profile.kind == nil or profile.kind == 'named' end
    local loaded, module = pcall(dofile, 'companion-adoption.lua')
    local built, value = false, module
    if loaded and type(module) == 'table' and type(module.new) == 'function' then
        built, value = pcall(module.new, {companions = companions,
            party = function() return mcm.party and mcm.party() or nil end,
            player = function() return Game.GetPlayer() end,
            -- The reply that requested the action is still being written or heard.
            busy = function(requestId, groupId)
                if groupId and groupChat.round and groupChat.round.id == groupId then return true end
                if pending and pending.requestId == requestId then return true end
                if microphone.context and microphone.context.requestId == requestId then return true end
                return speech.requestId ~= nil and speech.requestId == requestId
            end,
            -- Two copies of one named character are refused; generic people (residents and
            -- archetypes, bridge/protocol.mjs isAmbientProfile) are not one person.
            named = function(key)
                if key == 'resident-male' or key == 'resident-female' or tostring(key):match('^npc%-') then return false end
                return named[key] ~= false
            end,
            groupEntities = function(context)
                local round, result = groupChat.round, {}
                if not round or not context.group or round.id ~= context.group.id then return result end
                for _, person in ipairs(round.participants) do result[#result + 1] = person.entity end
                return result
            end,
            -- A conversation partner who joins the party leaves the partner role.
            promote = function(key)
                if convaiAutoConnect and type(convaiAutoConnect.promote) == 'function' then convaiAutoConnect.promote(key) end
            end,
            log = log})
    end
    -- It also owns the walk of a companion leaving the party (companions.lua M.departure).
    if built and type(value) == 'table' then adoption = value; convaiCompanionAdoption = value; companions.departure = value
    else print('[CyberpunkConvai] companion-adoption.lua unavailable: ' .. tostring(value)) end
end

-- Auto-connect nearby characters (docs/MANAGER_UI.md). Off by default, and a
-- missing module only removes the feature. The module decides which world
-- characters to prepare; the bridge opens their connection and local voice.
local autoConnect
do
    local function scanNearbyCharacters(player, radius)
        local query = TargetSearchQuery.new()
        query.searchFilter = Game['TSF_NPC;']()
        query.maxDistance = radius
        query.includeSecondaryTargets = false
        query.filterObjectByDistance = true
        query.ignoreInstigator = true
        query.testedSet = Enum.new('TargetingSet', 'Complete')
        local _, parts = Game.GetTargetingSystem():GetTargetParts(player, query)
        local origin = player:GetWorldPosition()
        local rows, seen = {}, {}
        for _, part in ipairs(parts or {}) do
            local component = TS_TargetPartInfo.GetComponent(part)
            local entity = component and component:GetEntity()
            if entity and entity:IsNPC() and entity:IsAttached() and not entity:IsDeadNoStatPool()
                and not companions.owns(entity) and not (adoption and adoption.hidden(entity)) then
                local id = tostring(entity:GetEntityID().hash)
                if not seen[id] then
                    seen[id] = true
                    local key, name = profileIdentity(entity)
                    if key and supportedProfiles[key] and manager.profileEnabled(key) then
                        local position = entity:GetWorldPosition()
                        rows[#rows + 1] = {key = key, name = name, entity = id,
                            distance = math.sqrt((position.x - origin.x)^2 + (position.y - origin.y)^2 + (position.z - origin.z)^2)}
                    end
                end
            end
        end
        return rows
    end
    local loaded, module = pcall(dofile, 'auto-connect.lua')
    if loaded and type(module) == 'table' and type(module.new) == 'function' then
        local catalogued = {}
        for _, profile in ipairs(profiles) do catalogued[profile.key] = profile end
        for key in pairs(archetypes.keys) do catalogued[key] = {key = key, kind = 'archetype'} end
        local built, value = pcall(module.new, {
            enabled = function() return type(manager.autoConnectNearby) == 'function' and manager.autoConnectNearby() == true end,
            scan = scanNearbyCharacters,
            -- Tier-1 named, other named, generic: the tie-breaker before distance for nearby characters.
            prominence = function(key) return module.prominence(catalogued[key]) end,
            -- A conversation partner's distance from V in metres; nil once it is gone, false when unknown.
            locate = function(partner)
                local npc = partner.entity
                if not npc then return false end
                if not npc:IsAttached() or npc:IsDeadNoStatPool() then return nil end
                local player = Game.GetPlayer()
                if not player then return false end
                local a, b = npc:GetWorldPosition(), player:GetWorldPosition()
                return math.sqrt((a.x - b.x)^2 + (a.y - b.y)^2 + (a.z - b.z)^2)
            end,
            party = function(key)
                for _, member in ipairs(companions.connectionProfiles()) do if member == key then return true end end
                return false
            end,
            log = function(line) log(line) end})
        -- convaiAutoConnect.promote(key): a conversation partner asked to follow leaves the partner role.
        if built and type(value) == 'table' then autoConnect = value; convaiAutoConnect = value
        else print('[CyberpunkConvai] auto-connect.lua unavailable: ' .. tostring(value)) end
    else print('[CyberpunkConvai] auto-connect.lua unavailable: ' .. tostring(module)) end
end

-- Body gestures (docs/COMPANION_GESTURES.md): the controller is always loaded
-- and does nothing while the setting is Off (the default). The development
-- probe, when installed, takes precedence for copies it is driving.
do
    local function speechFor(entity)
        local face = convaiFacialPlayback
        if not face or not face.active or face.entity ~= entity or not face.timeline then return nil end
        local offset = face.segment and face.segment.startSeconds or 0
        local slot = face.expressions and face.expressions[entity]
        -- Phrase timing for gesture starts: the segment offset (local voices
        -- stream one phrase per segment) and the expression track's spans
        -- (timeline seconds), passed by reference, never copied.
        local track = face.timeline.expressionTrack
        return {requestId = face.requestId, knownEnd = offset + (face.timeline.duration or 0),
            at = offset + (face.position or 0), family = slot and slot.family, scale = slot and slot.scale,
            offset = offset, segmented = face.segment ~= nil,
            phrases = type(track) == 'table' and type(track.segments) == 'table' and track.segments or nil}
    end
    local options = {
        enabled = function() return manager.bodyGestures() end,
        speech = speechFor,
        listening = function() return convaiFacialPlayback and convaiFacialPlayback.listeningEntity end,
        thinking = function() return convaiFacialPlayback and convaiFacialPlayback.thinkingEntity end,
        log = function(kind, fields)
            if manager.developerMode() then
                local ok, text = pcall(json.encode, fields)
                log('Gestures ' .. kind .. ' ' .. (ok and text or ''))
            end
        end,
    }
    local loaded, controller = pcall(function() return dofile('companion-gestures.lua').new(options) end)
    if not loaded then log('Gesture controller failed to load: ' .. tostring(controller)); controller = nil end
    convaiGestures = controller
    -- Seating (docs/COMPANION_SEATING.md): companions always take a free seat
    -- beside a seated V (no setting). It owns the body before gestures do.
    convaiSeatingOptions = {
        gazeSettings = function() return companions.gazeSettings and companions.gazeSettings() or nil end,
        log = function(kind, fields)
            if manager.developerMode() then
                local ok, text = pcall(json.encode, fields)
                log('Seating ' .. kind .. ' ' .. (ok and text or ''))
            end
        end,
    }
    local seatingLoaded, seating = pcall(function() return dofile('companion-seating.lua').new(convaiSeatingOptions) end)
    if not seatingLoaded then log('Seating controller failed to load: ' .. tostring(seating)); seating = nil end
    convaiSeating = seating
    local probe
    local probeFile = io.open('gesture-probe.lua', 'rb')
    if probeFile then
        probeFile:close()
        local probeLoaded, value = pcall(dofile, 'gesture-probe.lua')
        if probeLoaded and type(value) == 'table' then probe = value
        else log('Gesture probe failed to load: ' .. tostring(value)) end
    end
    -- Dispatch through the globals at call time, so the probe's reload and
    -- reload-controller commands can swap either without a CET reload (which
    -- despawns companions).
    local function current() return convaiGestures end
    local function currentProbe() return convaiGestureProbe or probe end
    local function currentSeating() return convaiSeating end
    companions.bodyAnimation = {
        tick = function(player, step, rows)
            local c, p, s = current(), currentProbe(), currentSeating()
            if s then pcall(s.tick, player, step, rows) end
            if c then pcall(c.tick, player, step, rows) end
            if p then return p.tick(player, step, rows) end
        end,
        -- Seating owns the copy: companions.lua skips its distant/stranded recovery.
        owns = function(entry)
            local s = currentSeating()
            if not s or not s.owns then return false end
            local ok, owned = pcall(s.owns, entry)
            return ok and owned == true
        end,
        -- Decision override before behavior (a walk to a seat, then a hold).
        steer = function(entry, context, step)
            local s = currentSeating()
            if not s then return nil end
            local ok, decision = pcall(s.steer, entry, context, step)
            return ok and decision or nil
        end,
        observe = function(entry, context, step)
            local c, p, s = current(), currentProbe(), currentSeating()
            if p and p.observe(entry, context, step) then return true end
            if s and s.observe(entry, context, step) then return true end
            if c then return c.observe(entry, context, step) end
            return false
        end,
        release = function(entry, reason)
            local c, p, s = current(), currentProbe(), currentSeating()
            if p then pcall(p.release, entry, reason) end
            if s then pcall(s.release, entry, reason) end
            if c then return c.release(entry, reason) end
        end,
        abandon = function(reason)
            local c, p, s = current(), currentProbe(), currentSeating()
            if p then pcall(p.abandon, reason) end
            if s then pcall(s.abandon, reason) end
            if c then return c.abandon(reason) end
        end,
    }
    convaiGestureOptions = options
end

local function targetAtCrosshair()
    local player = Game.GetPlayer()
    if not player then return nil, 'Player unavailable' end
    local query = TargetSearchQuery.new()
    query.searchFilter = Game['TSF_NPC;']()
    query.maxDistance = 8.0
    local targeting = Game.GetTargetingSystem()
    query.includeSecondaryTargets = false
    query.filterObjectByDistance = true
    query.ignoreInstigator = true
    local candidates, seated, onFoot, nativeIds = {}, {}, {}, {}
    local function nativeCandidate(npc)
        candidates[#candidates + 1] = npc
        local ok, id = pcall(function() return tostring(npc:GetEntityID().hash) end)
        if ok then nativeIds[id] = true end
    end
    local _, parts = targeting:GetTargetParts(player, query)
    for _, part in ipairs(parts or {}) do
        local component = TS_TargetPartInfo.GetComponent(part)
        local entity = component and component:GetEntity()
        if entity then nativeCandidate(entity) end
    end
    local nearest = targeting:GetObjectClosestToCrosshair(player, query)
    if nearest then nativeCandidate(nearest) end
    local lookedOk, looked = pcall(function() return targeting:GetLookAtObject(player, true, true) end)
    if lookedOk and looked then nativeCandidate(looked) end
    -- Vehicle occupants can be absent from native target parts. This fallback
    -- admits only actual managed seats in V's current vehicle.
    for _, npc in ipairs(companions.seatedCandidates(player)) do
        candidates[#candidates + 1] = npc
        seated[tostring(npc:GetEntityID().hash)] = true
    end
    -- Preserve ordinary native selection and the accepted same-car fallback.
    -- Only absent managed on-foot copies need our own geometry/visibility gate.
    local standing = type(companions.onFootCandidates) == 'function' and companions.onFootCandidates() or {}
    for _, npc in ipairs(standing) do
        local id = tostring(npc:GetEntityID().hash)
        if not nativeIds[id] and not seated[id] then
            candidates[#candidates + 1] = npc
            onFoot[id] = true
        end
    end
    local playerPos, forward = targeting:GetCrosshairData(player)
    local forwardLength = math.sqrt(forward.x^2 + forward.y^2 + forward.z^2)
    -- Measure every candidate once: its best aim point (torso, or the actual
    -- Head slot for a close face-to-face talk), the angle to the crosshair and
    -- the distance. mod/talk-target.lua then decides between them (an ongoing
    -- conversation keeps its partner; a centred party member beats ambient NPCs).
    local rows, measured = {}, {}
    for _, npc in ipairs(candidates) do
        local valid, row = pcall(function()
            if not npc:IsNPC() or not npc:IsAttached() or npc:IsDeadNoStatPool() then return nil end
            if adoption and adoption.hidden(npc) then return nil end
            local id = tostring(npc:GetEntityID().hash)
            if measured[id] then return nil end
            measured[id] = true
            local pos = npc:GetWorldPosition()
            local points = {{x = pos.x, y = pos.y, z = pos.z + 1.3}}
            if seated[id] then
                -- Installed NPCPuppet.HasHeadUnderwater uses the Head slot and
                -- this world conversion. CET returns its out transform; the
                -- live seated probe confirms GetSlotTransform takes one input.
                local slot = npc:GetSlotComponent()
                if not slot then return nil end
                local found, transform = slot:GetSlotTransform(CName.new('Head'))
                if not found or not transform then return nil end
                pos = WorldPosition.ToVector4(WorldTransform.GetWorldPosition(transform))
                points = {pos}
            else
                -- Keep torso aim usable. The actual Head slot is a second aim
                -- point for close face-to-face conversations, when available.
                local headOk, head = pcall(function()
                    local slot = npc:GetSlotComponent()
                    if not slot then return nil end
                    local found, transform = slot:GetSlotTransform(CName.new('Head'))
                    if not found or not transform then return nil end
                    local point = WorldPosition.ToVector4(WorldTransform.GetWorldPosition(transform))
                    if not point or type(point.x) ~= 'number' or type(point.y) ~= 'number'
                        or type(point.z) ~= 'number' then return nil end
                    return point
                end)
                if headOk and head then points[#points + 1] = head end
            end
            local isLooked = not onFoot[id] and lookedOk and looked and npc == looked or false
            local measures = {}
            for _, point in ipairs(points) do
                local dx, dy, dz = point.x - playerPos.x, point.y - playerPos.y, point.z - playerPos.z
                local distance = math.sqrt(dx^2 + dy^2 + dz^2)
                if distance >= 0.1 and distance <= 8.0 and forwardLength >= 0.1 then
                    local cosine = (dx * forward.x + dy * forward.y + dz * forward.z) / (distance * forwardLength)
                    cosine = math.max(-1.0, math.min(1.0, cosine))
                    local angle = math.deg(math.acos(cosine))
                    if isLooked or angle <= 32.0 then
                        measures[#measures + 1] = {point = point, angle = angle, distance = distance}
                    end
                end
            end
            table.sort(measures, function(a, b) return a.angle < b.angle end)
            for _, m in ipairs(measures) do
                if not onFoot[id] or companions.visibleFromCrosshair(playerPos, m.point) then
                    return {id = id, npc = npc, angle = m.angle, distance = m.distance, looked = isLooked,
                        party = type(companions.owns) == 'function' and companions.owns(npc) == true}
                end
            end
            return nil
        end)
        if valid and row then rows[#rows + 1] = row end
    end
    local chooser = convaiTalkTarget
    local chosen, why
    if chooser and type(chooser.choose) == 'function' then
        local ok, row, reason = pcall(chooser.choose, rows)
        if ok then chosen, why = row, reason end
    end
    if not chosen and why == nil then
        -- No chooser loaded: the original ranking.
        local bestScore = math.huge
        for _, row in ipairs(rows) do
            local value = (row.looked and 0 or row.angle) / 32.0 + row.distance / 8.0
            if value < bestScore then chosen, bestScore = row, value end
        end
        why = 'nearest-to-centre'
    end
    local decision = {rows = rows, chosen = chosen, reason = why}
    if not chosen then return nil, 'Face a nearby character to talk.', decision end
    return chosen.npc, nil, decision
end

local function resetGaze()
    gazeCandidate = nil
    gazeDwell = 0
    gazeLost = 0
end

local function endFocus(player)
    if focusedCrowd then
        local ok, position = pcall(function() return focusedCrowd.npc:GetWorldPosition() end)
        if ok then releasedCrowd = {npc = focusedCrowd.npc, position = position, at = os.time()} end
        focusedCrowd = nil
    end
    if player then pcall(function() player:ConvaiEndFocus() end) end
    if convaiVanillaReactions then pcall(convaiVanillaReactions.release) end
end

local function beginFocus(player, npc)
    endFocus(player)
    -- Only our spawned copies and a character the talk path resolved (a conversation the player started) are ever
    -- turned toward V or have their barks muted. A named or story character of the game is left untouched.
    if not companions.owns(npc) and not (profileIdentity(npc)) then return false, 'not ours and not a conversation' end
    -- Owned companions arbitrate attention against locomotion themselves.
    -- The civilian path can add a second hold/turn independently of that state.
    local quiet = convaiVanillaReactions
    if companions.owns(npc) then
        if quiet then pcall(quiet.focus, npc, 'focus') end
        return true
    end
    local ok, focused = pcall(function() return player:ConvaiBeginFocus(npc) end)
    if not ok or not focused then return false, tostring(focused) end
    if quiet then pcall(quiet.focus, npc, 'focus') end
    local managed = companions.owns(npc)
    log('Focus ownership: actor=' .. tostring(npc:GetEntityID().hash) .. ' managed=' .. tostring(managed))
    local probeOk, probeResult = pcall(function()
        local crowd = npc:IsCrowd()
        local civilian = npc:IsCharacterCivilian()
        local workspot = Game.GetWorkspotSystem():IsActorInWorkspot(npc)
        log('Focus class: actor=' .. tostring(npc:GetEntityID().hash) .. ' crowd=' .. tostring(crowd) .. ' civilian=' .. tostring(civilian) .. ' workspot=' .. tostring(workspot))
        if not crowd then return 'not crowd' end
        focusedCrowd = {npc = npc, position = npc:GetWorldPosition(), at = os.time(), checked = false}
        return 'crowd focus started'
    end)
    log('Crowd focus begin: ' .. (probeOk and tostring(probeResult) or 'failed: ' .. tostring(probeResult)))
    return true
end

local function gameplayCanAcquire(player)
    local ok, inMenu = pcall(function()
        local definitions = Game.GetAllBlackboardDefs()
        return Game.GetBlackboardSystem():Get(definitions.UI_System)
            :GetBool(definitions.UI_System.IsInMenu)
    end)
    if not ok or inMenu then return false end
    local composerOk, composerOpen = pcall(function() return player:ConvaiComposerOpen() end)
    return composerOk and not composerOpen
end

local function updateGaze(player, elapsed)
    local attentionProbe = convaiAttentionProbe
    if attentionProbe then
        if focusMode == 'gaze' then
            endFocus(player)
            focusMode = nil
            focusEntity = nil
            resetGaze()
        end
        if os.time() <= attentionProbe.expires then return end
        convaiAttentionProbe = nil
    end
    if focusMode == 'chat' then return end
    -- A distraction target keeps facing the companion, not V's crosshair.
    if tactics.busy() then
        if focusMode == 'gaze' then endFocus(player); focusMode, focusEntity = nil, nil; resetGaze() end
        return
    end
    gazePoll = gazePoll + elapsed
    if gazePoll < 0.2 then return end
    local step = gazePoll
    gazePoll = 0
    local canFocus = gameplayCanAcquire(player)
    local npc, identity
    local lookKey, lookEntity, lookName
    if canFocus then
        local found, result = pcall(targetAtCrosshair)
        if found and result then
            local key, canonical = profileIdentity(result)
            if key and supportedProfiles[key] and manager.profileEnabled(key) and not companions.owns(result) then
                lookKey, lookName, lookEntity = key, canonical, tostring(result:GetEntityID().hash)
            end
            -- The passive gaze response (turning toward V) is for our own companions only; an ordinary NPC is
            -- faced toward V when the player starts a conversation with it, not when V merely looks at it.
            if manager.profileEnabled(key) and companions.owns(result) then
                npc = result
                identity = tostring(result:GetEntityID().hash)
            end
        end
    end
    -- Auto-connect counts how long V keeps facing one profiled character.
    if autoConnect then pcall(autoConnect.look, lookKey, lookEntity, lookName, step) end
    if focusMode == 'gaze' then
        if identity == focusEntity then gazeLost = 0; return end
        gazeLost = gazeLost + step
        if gazeLost < 1.5 then return end
        endFocus(player)
        focusMode = nil
        focusEntity = nil
        resetGaze()
    end
    if not npc then resetGaze(); return end
    if gazeCandidate ~= identity then
        gazeCandidate = identity
        gazeDwell = 0
        return
    end
    gazeDwell = gazeDwell + step
    if gazeDwell < 0.2 then return end
    local focused, reason = beginFocus(player, npc)
    if focused then
        focusMode = 'gaze'
        focusEntity = identity
        gazeLost = 0
        log('NPC responded to gaze: actor=' .. identity)
    else
        log('NPC gaze focus failed: ' .. tostring(reason))
    end
    resetGaze()
end

-- One probe-log line per talk-key target decision (mod/talk-target.lua).
local function logTalkTarget(decision)
    local chooser = convaiTalkTarget
    if not decision or not chooser or type(chooser.describe) ~= 'function' then return end
    local ok, line = pcall(chooser.describe, decision.rows, decision.chosen, decision.reason, function(row)
        local key = profileIdentity(row.npc)
        return key or 'unprofiled'
    end)
    if ok then log(line) end
end

local function selectConversation(player, groupMode, singleAction)
    local npc, reason, decision = targetAtCrosshair()
    logTalkTarget(decision)
    local candidates = groupMode and companions.conversationCandidates(player, 8) or {}
    if groupMode then
        local enabled = {}
        for _, candidate in ipairs(candidates) do
            if profileEnabled(player, candidate.profileKey) then enabled[#enabled + 1] = candidate end
        end
        candidates = enabled
    end
    if not npc and groupMode and candidates[1] then npc = candidates[1].npc end
    if not npc then convaiNotices.send(player, 'talk-no-target', ui.t(reason)); return nil end
    local key, name, bodyType, archetype = profileIdentity(npc)
    if not key or not supportedProfiles[key] then
        convaiNotices.send(player, 'talk-no-profile', ui.t('{name} does not have a conversation profile configured yet.',{name=name}))
        log('Conversation unavailable: profile=' .. tostring(key))
        return nil
    end
    if not profileEnabled(player, key) then log('Companion disabled in manager: ' .. name); return nil end
    local primary = {npc = npc, name = name, entity = tostring(npc:GetEntityID().hash), bodyType = bodyType, profileKey = key}
    -- An archetype or resident learns which kind of NPC it is and where it stands
    -- (a summoned archetype copy from its profile key alone).
    if not archetype and archetypes.keys[key] and type(characterCatalog.describe) == 'function' then
        archetype = characterCatalog.describe(archetypes, key, {})
    end
    if archetype or key == 'resident-male' or key == 'resident-female' then
        primary.archetype = archetype or {category = 'resident'}
        local place = currentDistrict()
        if place then primary.archetype.district, primary.archetype.area = place.district, place.area end
        log('Archetype conversation: profile=' .. key .. ' base=' .. tostring(primary.archetype.base)
            .. ' district=' .. tostring(primary.archetype.district))
    end
    local participants = groupMode and groupChat.choose(primary, candidates, supportedProfiles) or nil
    if participants and #participants < 2 then
        local shortcut = ui.boundKey(singleAction)
        convaiNotices.send(player, 'group-needs-two', shortcut
            and ui.t('Group chat needs two characters nearby. Use {key} for one person.', {key = shortcut})
            or ui.t('Group chat needs two characters nearby. Use private chat for one person.'))
        return nil
    end
    -- The ongoing conversation keeps this partner on the next talk key press.
    if convaiTalkTarget then pcall(convaiTalkTarget.remember, primary.entity) end
    return primary, participants
end

local function voiceTargetValid(npc, context)
    local player = Game.GetPlayer()
    if not npc or not player or tostring(npc:GetEntityID().hash) ~= context.entity
        or not npc:IsAttached() or npc:IsDeadNoStatPool() then return false end
    local pos, origin = npc:GetWorldPosition(), player:GetWorldPosition()
    return (pos.x - origin.x)^2 + (pos.y - origin.y)^2 + (pos.z - origin.z)^2 <= 144
end

-- V's recognised words while speaking by voice: V's line in the cinematic subtitles, replaced in place as the words grow
-- (event-driven from mod/microphone.lua's poll, nothing per frame). false makes the microphone use the notice line.
local heardFallbackLogged = {}
local function heardFallback(reason)
    if not heardFallbackLogged[reason] then
        heardFallbackLogged[reason] = true
        log('Live words: using the notice line (' .. reason .. ')')
    end
    return false
end
microphone.onHeard = function(text)
    if not subtitles.enabled() then return heardFallback('game subtitles are off') end
    local ok, shown = pcall(subtitles.showLive, 'V', text)
    if not ok then return heardFallback('subtitle error: ' .. tostring(shown):sub(1, 200)) end
    if shown ~= true then return heardFallback('subtitle line refused') end
    return true
end

microphone.onCancelled = function(context, reason)
    if subtitles.live then subtitles.clear() end
    gameplayActions.revoke(reason or 'microphone-cancelled', context.requestId)
    if pending and pending.requestId == context.requestId then pending, pendingKnowledgeOwner = nil, nil end
    local round = groupChat.round
    if round and context.group and round.id == context.group.id then groupChat.cancel() end
    warmConversation(nil, nil)
end

local function cancelVoice(reason)
    local round = groupChat.round
    local ownsRound = round and round.mode == 'voice'
    if not microphone.context and not ownsRound then return end
    if ownsRound and pending and pending.group and pending.group.id == round.id then
        pending, pendingKnowledgeOwner = nil, nil
    end
    microphone.cancel(reason)
    if ownsRound then groupChat.cancel() end
    speech.stop(reason); subtitles.clear()
    warmConversation(nil, nil)
    focusUntil = os.time() + 1
end

-- The one private (non-group) request whose reply is requested, streaming or
-- playing, and the request file the bridge currently owns. Filled in by
-- claimPrivateReply (defined after sendRequest) and used by retirePrivateReply.
local privateReply, requestFileId, claimPrivateReply = nil, nil, nil

local function acceptVoiceSubmission(context)
    if not context then return false end
    if context.group and not groupChat.voiceSubmitted(context) then
        microphone.cancel('stale-group'); return false
    end
    claimPrivateReply(context, 'voice')
    pending, pendingKnowledgeOwner = context, microphone.knowledgeOwner
    pending.sentAt, focusUntil = os.time(), os.time() + 90
    return true
end

-- Explain an unavailable conversation service before the player types or
-- speaks. Without any service evidence the conversation proceeds as before.
local function conversationServiceBlocked(player)
    local message, kind = serviceCall('blockedMessage', os.time())
    if type(message) ~= 'string' then return false end
    convaiNotices.send(player, 'service-blocked', message)
    log('Conversation service unavailable: ' .. tostring(kind))
    return true
end

-- Talk box start gate. The game's popup takes the keyboard, so a movement key
-- released while it is open is never seen by gameplay and V keeps walking after it
-- closes (a Codeware popup cannot hand the key-up back). Composer.reds tracks the
-- MoveX/MoveY axes from the game's own change events, so the talk key only has to ask
-- one native bool. When a direction is held the box opens as soon as it is released,
-- or after TALK_WAIT_MAX seconds at the latest: a talk request is never dropped.
local TALK_WAIT_MAX = 1.5
-- 'held', 'free', or 'n/a' when the redscript tracker is not installed.
local function moveStateText(player)
    local ok, held = pcall(function() return player:ConvaiMoveHeld() end)
    if not ok or type(held) ~= 'boolean' then return 'n/a' end
    return held and 'held' or 'free'
end
local function beginTextNow(groupMode, waited)
    local ok, err = pcall(function()
        local player = Game.GetPlayer()
        if not player or not gameplayCanAcquire(player) then return end
        local primary, participants = selectConversation(player, groupMode, 'cyberpunk_convai_text')
        if not primary then return end
        if conversationServiceBlocked(player) then return end
        local npc, key, name, bodyType, identity = primary.npc, primary.profileKey, primary.name, primary.bodyType, primary.entity
        -- A character that is not connected yet makes V wait: say so (mod/auto-connect.lua).
        local connectNote = autoConnect and not participants and autoConnect.talkNotice(key, name) or nil
        generation = generation + 1
        local speedAtOpen = playerSpeedText(player)
        local moveAtOpen = moveStateText(player)
        if not player:ConvaiOpenComposer(name) then
            log('Native composer unavailable (check redscript and Codeware)')
            return
        end
        cancelAutomatic('manual-text')
        tactics.interrupt('manual-text')
        gameplayActions.revoke('new-conversation')
        speech.stop('new-conversation')
        microphone.cancel()
        groupChat.cancel()
        subtitles.clear()
        speech.target = npc
        -- A world NPC's face gets the speech layer on demand (Face.reds ConvaiFaceRequest).
        local faceOk, faceStatus = pcall(function() return npc:ConvaiFaceRequest() end)
        if not faceOk or (faceStatus ~= 'managed' and not tostring(faceStatus):find('^prepared')) then
            log('Face request: actor=' .. tostring(identity) .. ' status=' .. tostring(faceStatus))
        end
        if focusEntity ~= identity then
            local focused, reason = beginFocus(player, npc)
            if not focused then
                log('NPC focus unavailable: ' .. tostring(reason))
            else
                focusEntity = identity
            end
        end
        focusMode = 'chat'
        resetGaze()
        focusUntil = os.time() + 45
        active = {generation = generation, entity = identity, name = name, bodyType = bodyType,
            profileKey = key, participants = participants, archetype = primary.archetype}
        warmConversation(participants, key, identity)
        if connectNote then convaiNotices.send(player, 'talk-connecting', connectNote) end
        pending = nil
        log('Composer opened: generation=' .. generation .. ' actor=' .. identity .. ' name=' .. name
            .. ' speed=' .. speedAtOpen .. ' moveAxis=' .. moveAtOpen
            .. (waited and string.format(' waited=%.2f', waited) or ''))
    end)
    if not ok then log('Open failed: ' .. tostring(err)) end
end

local function beginText(groupMode)
    local player = Game.GetPlayer()
    local gate = convaiTalkGate
    if player and gate and moveStateText(player) == 'held' then
        -- A second press while waiting only updates which chat was asked for.
        local waiting = gate.waiting
        gate.waiting = {group = groupMode, waited = waiting and waiting.waited or 0}
        if not waiting then log('Talk box waits for the movement keys to be released') end
        return
    end
    if gate then gate.waiting = nil end
    beginTextNow(groupMode)
end

-- Called from onUpdate (a nil check per frame while nobody is waiting). Opens the
-- box once the axes are released, when the wait runs out, or drops the request when
-- the world is not playable any more.
convaiTalkGate = {}
function convaiTalkGate.update(delta, worldReady)
    local waiting = convaiTalkGate.waiting
    if not waiting then return end
    if not worldReady then convaiTalkGate.waiting = nil; return end
    local player = Game.GetPlayer()
    if not player then convaiTalkGate.waiting = nil; return end
    waiting.waited = waiting.waited + (tonumber(delta) or 0)
    local stillHeld = moveStateText(player) == 'held'
    if stillHeld and waiting.waited < TALK_WAIT_MAX then return end
    convaiTalkGate.waiting = nil
    -- A reading that never cleared is probably an unseen key-up: forget it so the
    -- next talk request is not delayed by it, then open the box anyway.
    if stillHeld then pcall(function() player:ConvaiMoveForget() end) end
    beginTextNow(waiting.group, waiting.waited)
end

local function toggleVoice(groupMode)
    local player = Game.GetPlayer()
    if not player then return end
    local ok, err = pcall(function()
        local mode = groupMode and 'group' or 'private'
        if microphone.context then
            local recordingMode = microphone.context.group and 'group' or 'private'
            if recordingMode ~= mode then
                local shortcut = ui.boundKey(recordingMode == 'group'
                    and 'cyberpunk_convai_group_voice' or 'cyberpunk_convai_voice')
                convaiNotices.send(player, 'mic-finish-hint', shortcut
                    and ui.t('Use {key} to finish this recording.', {key = shortcut})
                    or (recordingMode == 'group'
                        and ui.t('Press your Group voice chat shortcut to finish recording.')
                        or ui.t('Press your Talk by voice shortcut to finish recording.')))
                return
            end
            local press = microphone.press()
            if press ~= 'retry' then
                -- Spamming the key is safe: a press while the device is still opening, right after
                -- "Listening", or while a reply is on its way changes nothing (mod/microphone.lua press).
                if press == 'connecting' then
                    convaiNotices.send(player, 'mic-connecting', ui.t('Connecting microphone - wait for Listening'))
                elseif press == 'finish' then
                    if not gameplayCanAcquire(player) or (microphone.targetValid and not microphone.targetValid(microphone.context)) then
                        cancelVoice('microphone-unavailable'); return
                    end
                    acceptVoiceSubmission(microphone.finish(mode))
                end
                return
            end
            -- The reply is overdue: drop it and fall through to begin a fresh recording.
            cancelVoice('voice-retry')
        end
        -- Mistral cannot take a spoken message until this computer can recognise speech: say so instead of recording into nothing. One cheap
        -- boolean, asked only here, when the voice key is pressed.
        if manager.voiceNeedsConvai() then
            convaiNotices.send(player, 'voice-needs-convai',
                ui.t('Speaking to companions needs Convai for now. Set Conversation provider to Convai in Settings > Development, or type your message.'))
            return
        end
        if not gameplayCanAcquire(player) then return end
        local primary, participants = selectConversation(player, groupMode, 'cyberpunk_convai_voice')
        if not primary then return end
        if conversationServiceBlocked(player) then return end
        local npc, key, name, body, entity = primary.npc, primary.profileKey, primary.name, primary.bodyType, primary.entity
        local connectNote = autoConnect and not participants and autoConnect.talkNotice(key, name) or nil
        generation = generation + 1
        cancelAutomatic('microphone')
        tactics.interrupt('microphone')
        gameplayActions.revoke('new-conversation')
        microphone.cancel('new-conversation')
        groupChat.cancel()
        warmConversation(participants, key, entity)
        speech.stop('microphone'); subtitles.clear()
        speech.target = npc
        -- A world NPC's face gets the speech layer on demand (Face.reds ConvaiFaceRequest).
        local faceOk, faceStatus = pcall(function() return npc:ConvaiFaceRequest() end)
        if not faceOk or (faceStatus ~= 'managed' and not tostring(faceStatus):find('^prepared')) then
            log('Face request: actor=' .. tostring(entity) .. ' status=' .. tostring(faceStatus))
        end
        local context
        if groupMode then
            context = groupChat.startVoice('group-' .. tostring(os.time()) .. '-' .. tostring(generation), participants, generation, os.time())
        else
            context = {generation = generation, entity = entity, name = name, bodyType = body,
                profileKey = key, text = '[Microphone]', sentAt = os.time(), archetype = primary.archetype}
            context.requestId = tostring(os.time()) .. '-' .. tostring(generation) .. '-' .. entity
        end
        active, pending, pendingKnowledgeOwner = nil, nil, nil
        if microphone.begin(context, function() return voiceTargetValid(npc, context) end) then
            beginFocus(player, npc)
            focusMode, focusEntity, focusUntil = 'chat', entity, os.time() + 120
            local micNote = ui.t('Connecting microphone - wait for Listening')
            convaiNotices.sendLines(player, {{id = 'talk-connecting', text = connectNote}, {id = 'mic-connecting', text = micNote}})
        else
            groupChat.cancel(); warmConversation(nil, nil)
        end
    end)
    if not ok then cancelVoice('microphone-error'); groupChat.cancel(); log('Microphone failed: ' .. tostring(err)) end
end

local function sendRequest(context)
    local owner = attachKnowledge(context)
    if not owner then return false end
    context.journal = context.journal or questContext.capture()
    -- Manual turns only: an automatic reaction has its own single subject.
    if not context.reaction and convaiGameDialogue then
        context.gameDialogue = context.gameDialogue or convaiGameDialogue:capture()
    end
    if not context.reaction and convaiPlayerGear then context.gear = context.gear or convaiPlayerGear:capture() end
    -- Automatic turns have one subject. Manual conversations may still discuss
    -- recent combat and pickups together when V asks about them.
    if context.reaction and context.reaction.kind == 'loot' then context.battle = nil
    else context.battle = context.battle or battles.capture() end
    local current = knowledgeOwner(refreshKnowledgeFrame())
    if not knowledgeAllowed or current.paused or not sameKnowledgeOwner(owner, current) then return false end
    if not context.group and not context.reaction then gameplayActions.capture(context, 'private-text')
    elseif context.group and context.group.index == 1 and not context.reaction then
        gameplayActions.capture(context, 'group-text')
    end
    local file = io.open('runtime/last-input.json.tmp', 'wb')
    if not file then gameplayActions.revoke('request-write-failed', context.requestId); return false end
    file:write(json.encode(context)); file:close()
    os.remove('runtime/last-input.json')
    if not os.rename('runtime/last-input.json.tmp', 'runtime/last-input.json') then
        gameplayActions.revoke('request-write-failed', context.requestId); return false
    end
    pending = context
    pendingKnowledgeOwner = owner
    if not context.reaction then focusUntil = os.time() + 90 end
    return true
end

-- A managed copy can be reassigned (companions.setProfile) while its private
-- reply is on the way. That reply was asked of the old character and must never
-- be heard or shown as the new one. Group rounds retire in updateGroup instead.
claimPrivateReply = function(context, source)
    if context.group then privateReply = nil; return end
    privateReply = {requestId = context.requestId, entity = context.entity, source = source,
        reaction = context.reaction and context.reaction.kind or nil}
    if source == 'voice' then privateReply.context = context end
end
do
    local submit = sendRequest
    sendRequest = function(context)
        local sent = submit(context)
        if sent then requestFileId = context.requestId; claimPrivateReply(context, 'text') end
        return sent
    end
end

-- Development only (mod/face-test.lua `say`, never reachable from a player package): submits `text` as V's private line to
-- a present character exactly as the composer's submission does (the same context, sendRequest, claimPrivateReply and
-- bridge route), so a scripted conversation exercises the real reply path (speech, face, captions). It runs once per
-- request file, never per frame. No native composer window is opened and nothing is typed.
speech.devSay = function(player, npc, text)
    if not manager.developerMode() then return false, 'developer mode is off' end
    if type(text) ~= 'string' or #text == 0 or #text > 400 then return false, 'text must be 1 to 400 characters' end
    local key, name, bodyType = profileIdentity(npc)
    if not key or not supportedProfiles[key] then return false, 'no conversation profile for ' .. tostring(name) end
    local identity = tostring(npc:GetEntityID().hash)
    generation = generation + 1
    cancelAutomatic('manual-text')
    tactics.interrupt('manual-text')
    gameplayActions.revoke('new-conversation')
    speech.stop('new-conversation')
    microphone.cancel()
    groupChat.cancel()
    subtitles.clear()
    speech.target = npc
    pcall(function() return npc:ConvaiFaceRequest() end)
    local context = {generation = generation, entity = identity, name = name, bodyType = bodyType, profileKey = key}
    warmConversation(nil, key, identity)
    pending = nil
    context.requestId = tostring(os.time()) .. '-' .. tostring(context.generation) .. '-' .. context.entity
    context.text = text
    context.sentAt = os.time()
    local sent = sendRequest(context)
    log('Native input captured (scripted): generation=' .. context.generation .. ' bytes=' .. #text .. ' sent=' .. tostring(sent))
    return sent == true, sent and context.requestId or 'the request was not sent'
end

local function retirePrivateReply(entity, reason)
    local retired = false
    -- Not yet a reply: an open text box or a recording that would still be
    -- submitted under the old identity.
    if active and not active.participants and active.entity == entity then
        active, retired = nil, true
        warmConversation(nil, nil)
    end
    local context = microphone.context
    if context and not context.group and context.entity == entity then
        microphone.cancel(reason); retired = true
    end
    local owner = privateReply
    if not owner or owner.entity ~= entity then return retired end
    local requestId = owner.requestId
    local waiting = pending ~= nil and pending.requestId == requestId
    local playing = speech.requestId == requestId
    local captionsOnly = speech.requestId == nil and not groupChat.round and subtitles.entity == entity
        and subtitles.ownsUtterance()
    -- A reply that was fully delivered has nothing left to retire.
    if not (waiting or playing or captionsOnly) then return retired end
    privateReply = nil
    gameplayActions.revoke(reason, requestId)
    if automatic and automatic.requestId == requestId then
        cancelAutomatic(reason)   -- also invalidates the reaction lease the bridge reads
    elseif owner.reaction == 'distraction' then
        tacticEnv.writeLease(requestId, false)
    end
    if owner.source == 'voice' then microphone.revoke(owner.context) end
    if pending and pending.requestId == requestId then pending, pendingKnowledgeOwner = nil, nil end
    -- The bridge owns a text request through this file: once it is gone there is
    -- no further audio, subtitles, face or memory for it. Never remove a newer one.
    if requestFileId == requestId then requestFileId = nil; os.remove('runtime/last-input.json') end
    if speech.requestId == requestId then pcall(speech.stop, reason)
    elseif captionsOnly then pcall(subtitles.clearEntity, entity) end
    if focusEntity == entity then focusUntil = os.time() + 1 end
    log('Private reply retired: ' .. tostring(reason))
    return true
end

local function reactionLease(valid)
    if not automatic then return false end
    local now = os.time()
    if valid and automatic.leaseAt == now then return true end
    local file = io.open('runtime/reaction-lease.json.tmp', 'wb')
    if not file then return false end
    file:write(json.encode({requestId = automatic.requestId, valid = valid, updated = now * 1000,
        playbackStartedAt = automatic.playbackAt and automatic.playbackAt * 1000})); file:close()
    os.remove('runtime/reaction-lease.json')
    local written = os.rename('runtime/reaction-lease.json.tmp', 'runtime/reaction-lease.json')
    if written then automatic.leaseAt = now end
    return written ~= nil
end

local reactionGuard, reactionEvidence = nil, {}
-- After a merged closing fails to claim its pickups, send the closing alone
-- for a moment instead of retrying the same merge every frame.
local mergeSuppressedUntil = 0
-- A closing waits for pickups still being collected, but never longer than
-- this many seconds after combat was confirmed over (its own window is 40).
local CLOSING_LOOT_WAIT = 14
local battleCandidatesOk, battleSampleAt = nil, nil

local function reactionManualActivity()
    return {text = active ~= nil, group = groupChat.round ~= nil,
        microphone = microphone.context ~= nil and microphone.state ~= 'reply', phone = phoneChat.pending ~= nil}
end

local function reactionOutputs(player)
    local voiceOk, voice = pcall(function() return player:ConvaiManagerVoice() end)
    local captionsOk, captions = pcall(function() return player:ConvaiManagerSubtitles() end)
    local state = {voiceKnown = voiceOk and type(voice) == 'boolean',
        subtitlesKnown = captionsOk and type(captions) == 'boolean'}
    if state.voiceKnown then state.voice = voice end
    if state.subtitlesKnown then state.subtitles = captions end
    -- Unknown settings retain the existing fallback behavior. Only an explicit
    -- Off/Off pair suppresses automatic turns; battle observations still update.
    state.enabled = not (state.voice == false and state.subtitles == false)
    return state
end

local function captureReactionGuard(worldReady, outputs, person)
    local previous = reactionGuard and reactionGuard.speaker
    local speaker = {present = person ~= nil, available = person ~= nil and person.available == true,
        temporarilyBusy = person ~= nil and person.voiceBusy == true,
        reason = person and (person.availableReason or 'unclassified')
            or (battleCandidatesOk == false and 'candidate-read-failed' or 'not-in-nearby-enabled-party')}
    if person then
        speaker.distance, speaker.lastSeenAt = person.distance, os.time() * 1000
    elseif previous then
        speaker.lastDistance, speaker.lastSeenAt = previous.distance or previous.lastDistance, previous.lastSeenAt
    end
    local sample = battleSample or {}
    reactionGuard = {worldReady = worldReady == true, outputs = outputs, speaker = speaker,
        sampledAt = battleSampleAt, native = {available = sample.available, combat = sample.combat,
            blocked = sample.blocked, reason = sample.reason, tier = sample.tier,
            scene = sample.scene, dialogue = sample.dialogue, choices = sample.choices,
            call = sample.call, vehicle = sample.vehicle, replacer = sample.replacer}}
end

local function recordReactionCancellation(reason, abandoning)
    local manual = reactionManualActivity()
    if reason == 'manual-text' then manual.text = true end
    if reason == 'microphone' then manual.microphone = true end
    local event = automatic.reaction or {}
    local record = {at = os.time() * 1000, reason = reason, abandoning = abandoning == true,
        requestId = automatic.requestId, entity = automatic.entity, profile = automatic.profileKey,
        phase = event.phase, encounter = event.encounter, expiresAt = event.expiresAt,
        playbackAt = automatic.playbackAt and automatic.playbackAt * 1000,
        pending = pending ~= nil and pending.requestId == automatic.requestId,
        playing = speech.requestId == automatic.requestId, shown = automatic.shown == true,
        waitingForSpeaker = automatic.waitingForSpeaker == true,
        manual = manual.text or manual.group or manual.microphone or manual.phone,
        manualActivity = manual, guard = reactionGuard, scheduler = battles.status(),
        kind = automatic.reaction.kind, loot = loot.status()}
    reactionEvidence[#reactionEvidence + 1] = record
    if #reactionEvidence > 32 then table.remove(reactionEvidence, 1) end
    -- This bounded ledger is diagnostic data only. No text, native object,
    -- conversation session or credential is retained, including during unload.
    local file = io.open('runtime/battle-cancellations.json.tmp', 'wb')
    if not file then return end
    file:write(json.encode({version = 1, updated = record.at, events = reactionEvidence})); file:close()
    os.remove('runtime/battle-cancellations.json')
    os.rename('runtime/battle-cancellations.json.tmp', 'runtime/battle-cancellations.json')
end

cancelAutomatic = function(reason, abandoning)
    if not automatic then return end
    pcall(recordReactionCancellation, reason, abandoning)
    reactionLease(false)
    if pending and pending.requestId == automatic.requestId then pending = nil end
    if not abandoning then
        if speech.requestId == automatic.requestId then speech.stop(reason)
        elseif automatic.shown then subtitles.clear() end
    end
    log('Automatic reaction released: ' .. tostring(reason))
    if automatic.reaction.kind == 'loot' then loot.release(automatic.reaction) end
    if lastAutomatic and lastAutomatic.requestId == automatic.requestId then
        lastAutomatic.finishedAt = os.time()
    end
    automatic, reactionGuard = nil, nil
end

local function reactionSpeakerWait(person)
    local waiting = person ~= nil and person.voiceBusy == true and not automatic.playbackAt
    if waiting and not automatic.waitingForSpeaker then
        log('Automatic reaction waiting for native speech: ' .. tostring(person.availableReason))
    elseif not waiting and automatic.waitingForSpeaker then
        log('Automatic reaction speaker ready again')
    end
    automatic.waitingForSpeaker = waiting
    return waiting
end

local function reactionPeople(player, observation)
    local people = {}
    local combat = observation.combat or battles.status().state == 'fighting'
    local ok, candidates = pcall(companions.conversationCandidates, player, 20)
    if ok then
        for _, person in ipairs(candidates) do
            if supportedProfiles[person.profileKey] and manager.profileEnabled(person.profileKey) then
                person.available, person.availableReason, person.voiceBusy = battleObserver.canSpeak(person.npc, combat and 'start' or 'end')
                people[#people + 1] = person
            end
        end
    end
    return people, ok
end

-- Source callbacks obtain current gates and witnesses before the transfer.
-- The collector copies only plain identities; no saved NPC references.
local function captureLootContext(player)
    local observation = battleObserver.sample(player)
    local ready = false
    pcall(function()
        local defs = Game.GetAllBlackboardDefs()
        ready = not Game.GetSystemRequestsHandler():IsGamePaused()
            and not Game.GetSystemRequestsHandler():IsPreGame()
            and not Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu)
            and not player:ConvaiComposerOpen()
    end)
    return {available = observation.available, blocked = observation.blocked,
        worldReady = ready, enabled = manager.lootReactions(), now = os.time(),
        people = reactionPeople(player, observation)}
end

local function updateBattles(player, elapsed, worldReady)
    battlePoll = battlePoll + elapsed
    if not battleSample or battlePoll >= 0.5 then
        battlePoll = 0
        battleSample = battleObserver.sample(player)
        battleSampleAt = os.time() * 1000
        battlePeople, battleCandidatesOk = reactionPeople(player, battleSample)
    end
    local now = os.time()
    battles.update(battleSample, worldReady and elapsed or 0, now, manager.battleReactions(), battlePeople)
    loot.update({available = battleSample.available, blocked = battleSample.blocked,
        paused = not worldReady, combat = battleSample.combat or battles.status().state == 'fighting'},
        worldReady and elapsed or 0, now, manager.lootReactions(), battlePeople)
    -- Drain already confirmed receipts before suspending source collection in
    -- a menu. Pausing freezes their policy timer; story/disabled gates discard.
    for _, item in ipairs(lootObserver.drain()) do
        local accepted, reason = loot.acquire(item, item.witnesses, now)
        if accepted then
            log('World loot collected: ' .. item.record .. ' quantity=' .. item.quantity
                .. ' quality=' .. item.quality .. ' category=' .. item.category
                .. ' type=' .. tostring(item.itemType) .. ' new=' .. tostring(item.newlyAcquired))
        else log('World loot skipped: ' .. tostring(reason)) end
    end
    lootObserver.update({available = battleSample.available, blocked = battleSample.blocked,
        worldReady = worldReady, enabled = manager.lootReactions(), now = now, people = battlePeople})
    local manual = active ~= nil or groupChat.round ~= nil
        or (microphone.context ~= nil and microphone.state ~= 'reply') or phoneChat.pending ~= nil
    local outputs = reactionOutputs(player)
    if automatic then
        local speaker
        for _, person in ipairs(battlePeople) do
            if person.entity == automatic.entity and person.profileKey == automatic.profileKey then speaker = person; break end
        end
        captureReactionGuard(worldReady, outputs, speaker)
        local waiting = reactionSpeakerWait(speaker)
        local owner = automatic.reaction.kind == 'loot' and loot or battles
        local valid, invalidReason = owner.valid(automatic.reaction, now, automatic.playbackAt)
        local reason = not worldReady and 'world-not-ready' or manual and 'manual-priority'
            or not outputs.enabled and 'outputs-disabled'
            or not speaker and 'speaker-missing' or (not speaker.available and not waiting) and 'speaker-unavailable'
            or not valid and (invalidReason or 'event-invalid')
        if reason then
            cancelAutomatic(reason)
        elseif not pending and not speech.requestId and not subtitles.ownsUtterance() then
            cancelAutomatic('completed')
        elseif not reactionLease(true) then cancelAutomatic('lease-write-failed') end
    end
    local busy = not worldReady or manual or not outputs.enabled or pending ~= nil or speech.requestId ~= nil or subtitles.ownsUtterance() or automatic ~= nil
        or (tactics ~= nil and tactics.busy())
    local function mayFollow(event, kind)
        if not event or busy then return false end
        if not lastAutomatic then return true end
        -- A generation, native bark wait, audio track or subtitle still owns
        -- the previous turn until cancelAutomatic releases it. Count the small
        -- handoff pause from that release, not from the earlier request write.
        if not lastAutomatic.finishedAt or now - lastAutomatic.finishedAt < 2 then return false end
        if now - lastAutomatic.at >= 30 or kind ~= lastAutomatic.kind then return true end
        return kind == 'battle' and event.phase == 'end' and lastAutomatic.phase == 'start'
            and lastAutomatic.encounter == event.encounter
    end
    -- One reply after a fight. Pickups collected during the fight or before the
    -- closing request is written travel in that closing request (one request,
    -- one speaker, exact-copy witnesses). The closing prefers a speaker who also
    -- saw them, and waits for pickups still being collected, at most
    -- CLOSING_LOOT_WAIT seconds after combat was confirmed over. A pickup made
    -- after the closing was requested stays a separate pickup comment.
    local battleEvent = battles.offer(busy, battlePeople, now, function(person)
        return loot.mergeable(person, now) ~= nil
    end)
    local lootEvent = loot.offer(busy, battlePeople, now)
    if not mayFollow(battleEvent, 'battle') then battleEvent = nil end
    if not mayFollow(lootEvent, 'loot') then lootEvent = nil end
    if battleEvent and battleEvent.phase == 'end' and now >= mergeSuppressedUntil then
        local merge = loot.mergeable(battleEvent.person, now)
        if merge and merge.collecting and (battleEvent.battle.ageSeconds or 0) < CLOSING_LOOT_WAIT then
            battleEvent = nil
        elseif merge then
            battleEvent.loot = loot.attach(battleEvent.person, now)
        end
    end
    -- While the closing is still ahead, a ready pickup waits for it so the
    -- fight's end and its pickups share one reply. This never holds a pickup
    -- for longer than the closing needs to become offerable, and not at all
    -- without an eligible witness for the closing.
    if lootEvent and not battleEvent and battles.closingDue(battlePeople) then lootEvent = nil end
    -- Once a battle closing has had a turn, an eligible pickup gets the next
    -- turn. A merged closing already consumed what it carried.
    local event
    if battleEvent and lootEvent and lastAutomatic and lastAutomatic.kind == 'battle'
        and lastAutomatic.phase == 'end' then event = lootEvent
    else event = battleEvent or lootEvent end
    if event == battleEvent and event then
        event.reaction = {kind = 'battle', encounter = event.encounter, phase = event.phase, expiresAt = event.expiresAt,
            batch = event.loot and event.loot.batch or nil}
    end
    if not event then return end
    generation = generation + 1
    local person
    for _, candidate in ipairs(battlePeople) do
        if candidate.entity == event.person.entity and candidate.profileKey == event.person.profileKey then person = candidate; break end
    end
    if not person then return end
    local context = {generation = generation, entity = person.entity, name = person.name,
        bodyType = person.bodyType, profileKey = person.profileKey, battle = event.battle, loot = event.loot, sentAt = now,
        text = event.reaction.kind == 'loot' and 'V has collected world loot. Give a brief in-character reaction.'
            or event.phase == 'start' and 'Combat has begun. Give a brief in-character reaction.'
            or 'Combat has ended. Give a brief in-character reaction without assuming victory.',
        reaction = event.reaction}
    context.requestId = tostring(os.time()) .. '-' .. generation .. '-' .. context.entity
    automatic = context
    captureReactionGuard(worldReady, outputs, person)
    if reactionLease(true) and sendRequest(context) then
        local claimed
        if event.reaction.kind == 'loot' then claimed = loot.claim(event, now)
        else
            claimed = true
            -- The carried pickups are consumed first: a failure leaves the
            -- closing unclaimed, to be sent alone after a short pause.
            if event.loot then
                local merged, mergeReason = loot.claimMerged(event, now)
                if not merged then
                    claimed, mergeSuppressedUntil = false, now + 3
                    log('Closing could not carry pickups: ' .. tostring(mergeReason))
                end
            end
            if claimed then claimed = battles.claim(event) end
        end
        if not claimed then cancelAutomatic('claim-failed'); return end
        speech.target = person.npc
        lastAutomatic = {at = now, requestId = context.requestId, kind = event.reaction.kind,
            phase = event.phase, encounter = event.encounter}
        log('Automatic ' .. event.reaction.kind .. ' reaction: ' .. tostring(event.phase or 'batch') .. ' speaker=' .. person.profileKey
            .. (event.loot and (' items=' .. #event.loot.items .. ' exceptional=' .. tostring(event.loot.exceptional)) or ''))
    else cancelAutomatic('request-write-failed') end
end

-- The bridge adds errorCode to a failed reply when Convai refused it for the plan or the key (bridge/convai-quota.mjs), and
-- keyNotice to the first reply that ran without long-term memory on a limited plan (bridge/convai-key.mjs). The text says
-- what to do; it never names where the shared key comes from.
-- The shared plan's daily allowance is used up (bridge/shared-key-guard.mjs). Phone Chat words the same line (phone-chat.lua).
local function dailyLimitText()
    return ui.t('You’ve reached today’s free conversation limit. Convai (better quality responses) is back tomorrow. To keep talking now, add a free Mistral key and set Conversation provider to Mistral in Settings > Development. A fully local option is coming.')
end

local function keyNoticeText(code)
    if code == 'quota-shared' then
        return ui.t('The conversation limit has been reached. Try again later, or add a free Mistral key and set Conversation provider to Mistral in Settings > Development.')
    elseif code == 'quota-own' then
        return ui.t('Your Convai API key has reached its plan limit. Try again later or add a different key in Settings > Development.')
    elseif code == 'key-rejected' then
        return ui.t('Convai did not accept your API key. Check it in Settings > Development.')
    elseif code == 'key-memory-needed' then
        return ui.t('Your Convai plan cannot hold the memory these conversations need. Free a memory user in your Convai account or use another key.')
    end
    return nil
end

-- id and text of the notice a reply calls for, or nil for an ordinary reply.
local function keyReplyNotice(reply)
    if reply.errorCode == 'key-memory' or reply.keyNotice == 'memory-off' then
        return 'key-memory', ui.t('Your Convai plan has no room for conversation memory, so companions will not remember past talks.')
    end
    if reply.errorCode == 'daily-limit' then return 'daily-limit', dailyLimitText() end
    -- Mistral: three failures the bridge names, and two one-time notices on the first reply.
    if reply.errorCode == 'mistral-key' then
        return 'mistral-key', ui.t('Mistral did not accept your key. Check it in Settings > Development.')
    elseif reply.errorCode == 'mistral-limit' then
        return 'mistral-limit', ui.t('Mistral’s free limit is reached for now. Try again in a moment.')
    elseif reply.errorCode == 'mistral-model' then
        return 'mistral-model', ui.t('The Mistral model is unavailable right now. Try again in a minute.')
    end
    if reply.keyNotice == 'mistral-no-key' then
        return 'mistral-no-key', ui.t('Mistral has no key yet, so Convai is used. Add your key in Settings > Development.')
    elseif reply.keyNotice == 'mistral-voice' then
        return 'mistral-voice', ui.t('Mistral replies are spoken by a local voice instead of the Convai cloud voice.')
    end
    local text = keyNoticeText(reply.errorCode)
    if text then return 'quota-exhausted', text end
    return nil
end

-- The one-time information the bridge puts on the first reply of a game session when Mistral is chosen.
local function sendProviderNotice(player, keyId, keyText)
    if keyId == 'mistral-no-key' then convaiNotices.send(player, 'mistral-no-key', keyText)
    elseif keyId == 'mistral-voice' then convaiNotices.send(player, 'mistral-voice', keyText) end
end

local function reactionCanDeliver(context, player)
    if not context.reaction then return true end
    if context.reaction.kind == 'distraction' then return tactics ~= nil and tactics.canDeliver(context) end
    if not automatic or automatic.requestId ~= context.requestId then return false end
    -- A reply can become ready between the half-second observer samples. Read
    -- player scene/combat state and the owned speaker before playback.
    for _, person in ipairs(battlePeople) do
        if person.entity == context.entity and person.profileKey == context.profileKey then
            person.available, person.availableReason, person.voiceBusy = battleObserver.canDeliver(player, person.npc, context.reaction.phase)
            captureReactionGuard(true, reactionOutputs(player), person)
            local waiting = reactionSpeakerWait(person)
            if not person.available and not waiting then cancelAutomatic('speaker-unavailable') end
            return person.available == true
        end
    end
    cancelAutomatic('speaker-missing')
    return false
end

local function groupAudience(player)
    local live, listeners = {}, {}
    if not groupChat.round or not player then return live, listeners end
    local origin = player:GetWorldPosition()
    for _, person in ipairs(groupChat.round.participants) do
        local ok, nearby = pcall(function()
            if not person.npc:IsAttached() or person.npc:IsDeadNoStatPool()
                or tostring(person.npc:GetEntityID().hash) ~= person.entity then return false end
            -- Keep the actor/profile frozen at admission. A managed copy can
            -- be reassigned or dismissed while its old group round is paused.
            if profileIdentity(person.npc) ~= person.profileKey
                or not profileEnabled(player, person.profileKey) then return false end
            local pos = person.npc:GetWorldPosition()
            return (pos.x-origin.x)^2 + (pos.y-origin.y)^2 + (pos.z-origin.z)^2 <= 144
        end)
        if ok and nearby then live[person.entity] = true; listeners[#listeners + 1] = person.profileKey end
    end
    return live, listeners
end

local function retireGroupRound(round, speaker, reason)
    local requestId = round.requestId
    local speechOwner = speech.requestId
    if round.mode == 'voice' and microphone.context and microphone.context.requestId == requestId then
        microphone.cancel(reason)
    end
    if pending and pending.requestId == requestId then pending, pendingKnowledgeOwner = nil, nil end
    if speechOwner == requestId then speech.stop(reason) end
    if round.stage == 'playing' and speaker and subtitles.entity == speaker.entity
        and (speechOwner == nil or speechOwner == requestId) then subtitles.clearEntity(speaker.entity) end
    if groupChat.round == round then groupChat.cancel() end
    focusUntil = os.time() + 1
end

local function updateGroup(player)
    local round = groupChat.round
    if not round then return end
    if not player then groupChat.cancel(); return end
    local live = groupAudience(player)
    local current = round.participants[round.index]
    if round.mode == 'voice' then
        if not live[round.participants[1].entity] then
            retireGroupRound(round, current or round.participants[1], 'group-primary-lost'); return
        end
        if round.stage == 'recording' then
            if not microphone.context or microphone.context.requestId ~= round.requestId then cancelVoice('recording-cancelled') end
            return
        end
    end
    if current and (round.stage == 'waiting' or round.stage == 'playing') and not live[current.entity] then
        -- Retire only this round. A private or phone turn must not lose its
        -- output if it has since acquired the shared speech channel.
        retireGroupRound(round, current, 'group-speaker-lost')
        return
    end
    local deliveryFailed = speech.state == 'target-lost' or speech.state == 'error'
        or speech.state == 'playback-failed'
    if round.stage == 'playing' and round.reply then
        local kept = {}
        for _, listener in ipairs(round.reply.listeners) do
            for _, candidate in ipairs(round.participants) do
                if candidate.profileKey == listener and live[candidate.entity] then kept[#kept + 1] = listener; break end
            end
        end
        round.reply.listeners = kept
        local prepared = groupChat.preview(generation + 1, os.time(), live, deliveryFailed)
        if prepared then generation = math.max(generation, prepared.generation) end
    end
    local person = round.participants[round.index]
    if round.stage == 'waiting' and person and not live[person.entity] then
        groupChat.received(round.requestId, '', true, {})
        if pending and pending.requestId == round.requestId then pending = nil end
    elseif round.stage == 'playing' and not speech.requestId and not subtitles.ownsUtterance() then
        groupChat.completed(round.requestId, not deliveryFailed)
    end
    if groupChat.round ~= round then return end
    if round.stage ~= 'next' or not gameplayCanAcquire(player) then return end
    generation = generation + 1
    local context, actor = groupChat.next(generation, os.time(), live)
    if not context then focusUntil = os.time() + 1; return end
    speech.target = actor
    -- A world NPC's face gets the speech layer on demand (Face.reds ConvaiFaceRequest).
    local faceOk, faceStatus = pcall(function() return actor:ConvaiFaceRequest() end)
    if not faceOk or (faceStatus ~= 'managed' and not tostring(faceStatus):find('^prepared')) then
        log('Face request: actor=' .. tostring(context.entity) .. ' status=' .. tostring(faceStatus))
    end
    beginFocus(player, actor)
    focusMode, focusEntity = 'chat', context.entity
    if not sendRequest(context) then groupChat.cancel(); log('Group request could not be written') end
end

local function captureDiagnostic()
    local ok, err = pcall(dofile, 'diagnostics.lua')
    if not ok then log('Diagnostic capture failed: ' .. tostring(err)) end
end

local function openManager()
    local ok, result, reason = pcall(mcm.open)
    if ok and result then
        gameplayActions.revoke('menu')
        endFocus(Game.GetPlayer())
        focusMode = nil
        focusEntity = nil
        focusUntil = nil
        resetGaze()
    else
        log('Companion manager: ' .. tostring(reason or result or 'Open it during gameplay.'))
    end
end

local function processPhoneAction(player)
    local queue = mcm.party and mcm.party()
    if not queue then return end
    -- Reading a request and reserving preparation are safe while Contacts pauses
    -- simulation. Only the shared queue's gameplay flush may create an entity.
    local ok, request = pcall(function() return player:ConvaiPhoneTakeRequest() end)
    if not ok or not request or request == '' then return end
    local join, contactId = request:sub(1, 1) == '+', request:sub(2)
    local key, reason, name = companions.phoneContactKey(contactId)
    if not key then
        log('Phone request unavailable for ' .. contactId .. ': ' .. tostring(reason))
        convaiNotices.send(player, 'phone-unavailable', tostring(reason))
        return
    end
    if join then
        local accepted, message, invitationId = queue.invite(key)
        log(accepted and ('Phone preparation requested for ' .. key)
            or ('Phone join failed for ' .. key .. ': ' .. tostring(message)))
        if accepted then
            local party = queue.list()
            for index = #party, 1, -1 do
                if party[index].key == key and not party[index].serial then
                    local board = type(queue.board) == 'function' and queue.board() or nil
                    if board then board.track(party[index].id, 'phone') end
                    break
                end
            end
        end
        -- An accepted invitation is not acknowledged: the notice board posts "joined" when the companion
        -- arrives, and no progress text is shown in any mode (manager-party.lua). A refusal is always
        -- shown, except a failed preparation: that is queued as the single gameplay notice for the
        -- attempt, so it is not posted again here while the phone is open.
        if accepted or invitationId then return end
        convaiNotices.send(player, 'phone-invite-reply', tostring(message))
        return
    end
    -- One copy per request: the queue picks it by the character it speaks as.
    local accepted, message, dismissedId = queue.dismissCharacter(key)
    if accepted ~= nil then
        log('Phone dismissal ' .. (accepted and 'requested' or 'refused') .. ' for ' .. key)
        -- The phone already says "dismiss queued", so the confirmation is a Developer-mode popup; a refusal is shown.
        convaiNotices.send(player, accepted and 'phone-dismiss-ack' or 'phone-dismiss-reply', tostring(message))
        return
    end
    log('Phone dismiss: no active copy of ' .. key)
    convaiNotices.send(player, 'phone-not-in-group', ui.t('{name} is not in your group.',{name=name}))
end

-- Phone invitations follow the same notice board as the manager's, so several
-- companions invited together share one compact, in-place notice. A failure is
-- delivered with the queue's own outcome notice once gameplay resumes, never
-- while the paused phone could hide and consume it.
local function updatePhoneInvitationFeedback(player, worldReady)
    local queue = mcm.party and mcm.party()
    local board = queue and type(queue.board) == 'function' and queue.board() or nil
    if not board then return end
    local note = board.take(worldReady == true)
    if note and convaiNotices.send(player, 'invite-board', note.message) then note.commit() end
end

-- Distraction lines use the ordinary automatic-turn path: one request at a
-- time, the shared reaction lease, speech, subtitles and lip-sync.
tacticEnv.player = function() return Game.GetPlayer() end
tacticEnv.actor = function(entity) return companions.readyActor(entity) end
tacticEnv.marked = function(player) return marking.current(player) end
tacticEnv.identify = function(npc) return profileIdentity(npc) end
tacticEnv.protected = function(npc) return convaiWorldPolicy ~= nil and convaiWorldPolicy.protected(npc) == true end
tacticEnv.converses = function(key) return supportedProfiles[key] == true and manager.profileEnabled(key) end
tacticEnv.nextGeneration = function() generation = generation + 1; return generation end
tacticEnv.idle = function()
    return not pending and not speech.requestId and not subtitles.ownsUtterance() and not automatic and not active
        and not groupChat.round and not (microphone.context and microphone.state ~= 'reply') and not phoneChat.pending
end
tacticEnv.send = function(context, npc) speech.target = npc; return sendRequest(context) end
tacticEnv.pendingId = function() return pending and pending.requestId end
tacticEnv.speaking = function(requestId) return speech.requestId == requestId or subtitles.ownsUtterance() end
tacticEnv.transcript = function(requestId, turnGeneration, entity) return speech.transcript(requestId, turnGeneration, entity) end
tacticEnv.stopTurn = function(requestId)
    if pending and pending.requestId == requestId then pending, pendingKnowledgeOwner = nil, nil end
    if speech.requestId == requestId then speech.stop('tactic-cancelled') end
end
tacticEnv.writeLease = function(requestId, valid, playbackAt)
    local file = io.open('runtime/reaction-lease.json.tmp', 'wb')
    if not file then return false end
    file:write(json.encode({requestId = requestId, valid = valid == true, updated = os.time() * 1000,
        playbackStartedAt = playbackAt})); file:close()
    os.remove('runtime/reaction-lease.json')
    return os.rename('runtime/reaction-lease.json.tmp', 'runtime/reaction-lease.json') ~= nil
end
tacticEnv.now = function() return os.time() * 1000 end
tacticEnv.feedback = function(message)
    local player = Game.GetPlayer()
    if player then convaiNotices.send(player, 'tactic-outcome', ui.t(message)) end
end
tacticEnv.log = function(line) log(line) end

-- A copy's conversation profile can be reassigned (companions.setProfile).
companions.onProfileChanged = function(entity) retirePrivateReply(entity, 'profile-reassigned') end

registerHotkey('cyberpunk_convai_text', 'Cyberpunk Convai: talk by text', function() beginText(false) end)
registerHotkey('cyberpunk_convai_group_text', 'Cyberpunk Convai: group text chat', function() beginText(true) end)
registerHotkey('cyberpunk_convai_voice', 'Cyberpunk Convai: talk by voice', function() toggleVoice(false) end)
registerHotkey('cyberpunk_convai_group_voice', 'Cyberpunk Convai: group voice chat', function() toggleVoice(true) end)
registerHotkey('cyberpunk_convai_manager', 'Cyberpunk Convai: companion manager', openManager)

local worldSuspended, sessionHasState = false, false
local fastTravelActive

local function abandonSession(reason,preserveTransit)
    -- Never touch NPC/player components during native world destruction.
    -- pcall cannot catch an access violation in an already unloaded component.
    invalidateKnowledge(reason)
    cancelAutomatic(reason, true)
    battles.reset()
    loot.reset(); lootObserver.reset(); lastAutomatic, mergeSuppressedUntil = nil, 0
    battleSample, battlePeople, battlePoll = nil, {}, 0
    if tactics then tactics.abandon() end
    if marking then marking.abandon() end
    companions.abandon(preserveTransit==true)
    if adoption then pcall(adoption.abandon, preserveTransit==true) end
    mcm.resetSession()
    speech.abandon()
    subtitles.abandon()
    -- A load, death or detach ends the scene; fast travel keeps the last lines.
    if preserveTransit ~= true and convaiGameDialogue then convaiGameDialogue:reset(reason) end
    if playerGear then playerGear:reset(reason) end
    microphone.cancel()
    groupChat.cancel()
    phoneChat.abandon()
    active, pending, focusUntil, focusMode, focusEntity = nil, nil, nil, nil, nil
    pendingKnowledgeOwner = nil
    if convaiTalkGate then convaiTalkGate.waiting = nil end
    focusedCrowd, releasedCrowd = nil, nil
    if convaiVanillaReactions then pcall(convaiVanillaReactions.clear) end
    phoneCatalogReady = false
    resetGaze()
    manager.reset()
    warmConversation(nil, nil)
    if autoConnect then pcall(autoConnect.reset) end
    publishPartyConnections(true)
    sessionHasState, poll = false, 0
    log('Session references released: ' .. reason)
end

registerForEvent('onInit', function()
    -- Disk receipts grant only interrupted cleanup authority. Native unique
    -- tags are checked later in gameplay; no party/save restoration occurs.
    if type(companions.initReloadCleanup)=='function' then
        local ok,error=pcall(companions.initReloadCleanup)
        if not ok then log('Interrupted driver cleanup initialization failed: '..tostring(error)) end
    end
    subtitles.install()
    -- Free look while V sits (docs/COMPANION_SEATING.md): one Observe pair on
    -- the player's Workspot state; widens the camera limits once per sit.
    local lookLoaded, lookResult, lookReason = pcall(function()
        return dofile('seated-look.lua').install({
            classify = dofile('companion-seating.lua').classify,
            log = function(kind, fields)
                if manager.developerMode() then
                    local ok, text = pcall(json.encode, fields)
                    log('Seating ' .. kind .. ' ' .. (ok and text or ''))
                end
            end,
        })
    end)
    if not lookLoaded then log('Seated free look failed: ' .. tostring(lookResult))
    elseif not lookResult then log('Seated free look unavailable: ' .. tostring(lookReason)) end
    if convaiGameDialogue and not convaiGameDialogue:install() then log('Game dialogue capture unavailable') end
    lootObserver.configure({captureContext = captureLootContext})
    lootObserver.install()
    if convaiVanillaReactions then
        local hooked, hookError = pcall(convaiVanillaReactions.install)
        if not hooked then log('Vanilla reaction hooks failed: ' .. tostring(hookError)) end
    end
    convaiLocomotion = dofile('companion-locomotion.lua')
    convaiLocomotion.install(function(npc, command)
        return companions.ownsTravelCommand(npc, command)
    end)
    dofile('composer-input.lua').install()
    dofile('phone-input.lua').install()
    phoneLayout.install()
    phoneChatStyle.install()
    local ok, err = pcall(mcm.install)
    if not ok then log('MCM registration failed: ' .. tostring(err)) end
    ObserveAfter('AutoDriveSystem', 'OnAutodriveToggled', function(_, enabled)
        if not worldSuspended and sessionHasState then companions.chauffeurAutodriveToggled(enabled) end
    end)
    ObserveBefore('AutoDriveSystem', 'OnStopAutoDriveOnDestinationReachedRequest', function(system)
        if worldSuspended or not sessionHasState or not companions.chauffeurSnapshot().active then return end
        -- The original callback disables AutoDrive and clears its car. Capture
        -- only its exact car while the live controller still owns it.
        pcall(function()
            local car = system:GetAutodriveVehicle()
            if system:GetAutodriveEnabled() and car then
                companions.chauffeurArrived(tostring(car:GetEntityID().hash))
            end
        end)
    end)
    -- Native FastTravelSystem.PerformFastTravel tests HasFastTravelPoint and
    -- distinct StartingPoint/DestinationPoint before TeleportToNode. Observe
    -- the request BEFORE that call: SetFastTravelStarted is already too late
    -- to protect a PlayerPuppet.OnDetach emitted by native teleportation.
    ObserveBefore('FastTravelSystem','OnPerformFastTravelRequest',function(system,request)
        if fastTravelActive or worldSuspended or not sessionHasState then return end
        local valid,travelling=pcall(function()
            local current=Game.GetPlayer()
            if not request or not request.player or not current or not request.pointData
                or not system:HasFastTravelPoint(request.pointData) then return false end
            if tostring(request.player:GetEntityID().hash)~=tostring(current:GetEntityID().hash) then return false end
            local defs=Game.GetAllBlackboardDefs().FastTRavelSystem
            local board=Game.GetBlackboardSystem():Get(defs)
            local origin=FromVariant(board:GetVariant(defs.StartingPoint))
            local destination=request.pointData:GetPointRecord()
            return origin~=nil and destination~=nil and tostring(origin)~=tostring(destination)
        end)
        if not valid or not travelling then return end
        local prepared,accepted=pcall(companions.beginFastTravel)
        if not prepared or not accepted then log('Party fast travel could not start: '..tostring(accepted)); return end
        fastTravelActive={started=os.time(),finished=false}
        worldSuspended=true
        abandonSession('fast travel started',true)
    end)
    ObserveAfter('FastTravelSystem','OnLoadingScreenFinished',function(_,finished)
        if finished~=true or not fastTravelActive then return end
        fastTravelActive.finished=true
        companions.fastTravel()
        worldSuspended=false
    end)
    ObserveBefore('PlayerPuppet', 'OnDetach', function()
        worldSuspended = true
        if not fastTravelActive then abandonSession('player detached') end
    end)
    ObserveBefore('PlayerPuppet', 'OnDeath', function()
        fastTravelActive=nil
        worldSuspended = true
        abandonSession('player died')
    end)
    local function playerAttached()
        if not fastTravelActive or fastTravelActive.finished then worldSuspended=false end
    end
    ObserveAfter('PlayerPuppet', 'OnGameAttached', playerAttached)
    ObserveAfter('PlayerPuppet', 'OnTakeControl', playerAttached)
    ObserveAfter('PlayerSystem', 'OnGameRestored', function()
        -- Observed on a real load in the read-only probe. This clears old
        -- transient references without writing anything into the save.
        fastTravelActive=nil
        abandonSession('save restored')
        worldSuspended = false
    end)
    log('Game adapter initialized; press the bound talk-by-text key while facing an NPC')
    -- Requests are one-shot commands. A CET reload must not replay a spawn or
    -- other game mutation left in the request file by an earlier session.
    local request = io.open('runtime/diagnostic-request.txt', 'rb')
    if request then
        lastDiagnosticRequest = request:read('*a')
        request:close()
    end
end)

registerForEvent('onUpdate', function(delta)
    -- A missing completion must not keep a stale travel intent armed for a
    -- later unrelated load. Expiration only drops receipts; it never restores.
    if fastTravelActive and not fastTravelActive.finished and os.time()-fastTravelActive.started>120 then
        fastTravelActive=nil; abandonSession('fast travel timed out')
    end
    if worldSuspended then return end
    -- One shared physics budget covers queued spawns, vehicle placement and
    -- walking queries in this frame, including work flushed by the manager.
    companions.beginSpatialFrame()
    local menuPlayer = Game.GetPlayer()
    local sessionOk, sessionReady = pcall(function()
        return not worldSuspended and menuPlayer and menuPlayer:IsAttached()
            and not menuPlayer:IsDeadNoStatPool() and not Game.GetSystemRequestsHandler():IsPreGame()
    end)
    if not sessionOk or not sessionReady then
        if sessionHasState then abandonSession('world unavailable',fastTravelActive~=nil) end
        if not knowledgeInvalidated then invalidateKnowledge('world unavailable') end
        return
    end
    if fastTravelActive and fastTravelActive.finished then fastTravelActive=nil end
    sessionHasState = true
    knowledgeAllowed, knowledgeInvalidated = true, false
    local knowledgeOk = pcall(updateKnowledge, delta)
    if not knowledgeOk then invalidateKnowledge('knowledge-update-failed') end
    -- Autosave freezes the native cursor briefly. Keep the exact owner and
    -- queued native input, but do not capture/send/apply UI changes until ready.
    if knowledgeFrame and knowledgeFrame.status == 'paused' then
        gameplayActions.revoke('world-paused')
        if type(speech.pauseForWorld) == 'function' then speech.pauseForWorld() end
        return
    end
    if knowledgeChanged then
        -- A changed lease/branch can happen without an NPC detach (for example
        -- initial bridge activation). Cancel conversation ownership, not actors.
        knowledgeChanged = false
        gameplayActions.revoke('knowledge-world-changed')
        cancelAutomatic('knowledge-world-changed', true)
        microphone.cancel(); groupChat.cancel(); phoneChat.abandon()
        speech.abandon(); subtitles.abandon()
        active, pending, pendingKnowledgeOwner = nil, nil, nil
        warmConversation(nil, nil)
    end
    local worldOk, worldReady = pcall(function()
        if not menuPlayer or not menuPlayer:IsAttached() then return false end
        local definitions = Game.GetAllBlackboardDefs()
        return not Game.GetSystemRequestsHandler():IsGamePaused()
            and not Game.GetSystemRequestsHandler():IsPreGame()
            and not Game.GetBlackboardSystem():Get(definitions.UI_System):GetBool(definitions.UI_System.IsInMenu)
            and not menuPlayer:ConvaiComposerOpen()
    end)
    worldReady = worldOk and worldReady
    local talkGate = convaiTalkGate
    if talkGate and talkGate.waiting then
        local gateOk, gateError = pcall(talkGate.update, delta, worldReady)
        if not gateOk then talkGate.waiting = nil; log('Talk gate failed: ' .. tostring(gateError)) end
    end
    -- Menu updates can have zero simulation delta. Cancel recording/group work
    -- here, before the slower gameplay poll, so pause cannot submit a late turn.
    if not worldReady then gameplayActions.revoke('menu'); cancelVoice('menu') end
    -- A companion riding a lift car with V moves with V every frame, only
    -- while the car moves (companions.lua M.carry); otherwise one field check.
    if worldReady and companions.riders then pcall(companions.carry, menuPlayer) end
    -- CET still calls onUpdate while native menus pause the simulation. The
    -- menu adapter needs these frames even when delta is zero; followers don't.
    ui.configure(manager.interfaceLanguage())
    local localeChanged = ui.update(tonumber(delta) or 0)
    if menuPlayer and convaiComposerInput then
        if convaiComposerInput.update then pcall(convaiComposerInput.update)
        elseif localeChanged and convaiComposerInput.refresh then pcall(convaiComposerInput.refresh) end
    end
    local mcmOk, mcmError = pcall(mcm.update, menuPlayer, worldReady)
    if not mcmOk then log('MCM update failed: ' .. tostring(mcmError)) end
    local phoneActionOk, phoneActionError = pcall(processPhoneAction, menuPlayer)
    if not phoneActionOk then log('Phone action failed: ' .. tostring(phoneActionError)) end
    local invitationOk, invitationError = pcall(invitations.update)
    if not invitationOk then log('Invitation preparation failed: ' .. tostring(invitationError)) end
    updatePhoneInvitationFeedback(menuPlayer, worldReady)
    -- Retain prepared and attached party connections while game time is paused.
    publishPartyConnections(false)
    if autoConnect then pcall(autoConnect.heartbeat) end
    local phoneOk, phoneError = pcall(phoneLayout.refresh)
    if not phoneOk then phoneLayout.lastError = tostring(phoneError) end
    local styleOk, styleError = pcall(phoneChatStyle.refresh)
    if not styleOk then phoneChatStyle.lastError = tostring(styleError) end
    local chatOk, chatError = pcall(phoneChat.update, menuPlayer, delta)
    if not chatOk then phoneChat.lastError = tostring(chatError) end
    local expressionActors,expressionBlocked={},true
    if worldReady then
        local sampled,rows=pcall(companions.conversationCandidates,menuPlayer,1000)
        if sampled and type(rows)=='table' then expressionActors=rows end
        local combatKnown,inCombat=pcall(function() return menuPlayer:IsInCombat() end)
        expressionBlocked=not combatKnown or inCombat==true
    end
    local expressionContext={paused=not worldReady,actors=expressionActors,blocked=expressionBlocked,
        thinkingEntity=pending and pending.entity,thinkingRequestId=pending and pending.requestId,
        listeningEntity=microphone.state=='recording' and microphone.context and microphone.context.entity or nil}
    local speechOk, speechError = pcall(speech.update, tonumber(delta) or 0,expressionContext)
    if not speechOk then
        log('Speech update failed: ' .. tostring(speechError))
        speech.stop('error')
    end
    local subtitlesOk, subtitlesError = pcall(subtitles.update, tonumber(delta) or 0)
    if not subtitlesOk then
        log('Subtitle update failed: ' .. tostring(subtitlesError))
        subtitles.clear()
    end
    diagnosticPoll = diagnosticPoll + (tonumber(delta) or 0)
    if diagnosticPoll >= 1 then -- developer mailbox; each CET io.open costs 1-2 ms
        diagnosticPoll = 0
        local request = io.open('runtime/diagnostic-request.txt', 'rb')
        if request then
            local nonce = request:read('*a')
            request:close()
            if nonce and #nonce > 0 and nonce ~= lastDiagnosticRequest then
                lastDiagnosticRequest = nonce
                captureDiagnostic()
                local response = io.open('runtime/diagnostic-response.txt', 'wb')
                if response then response:write(nonce); response:close() end
            end
        end
    end
    poll = poll + (tonumber(delta) or 0)
    if poll < 0.1 then return end
    local elapsedPoll = poll
    poll = 0
    local player = Game.GetPlayer()
    local voiceSubmission = microphone.update(player)
    if voiceSubmission then acceptVoiceSubmission(voiceSubmission) end
    if not player then
        abandonSession('world unavailable during update')
        return
    end
    if not phoneCatalogReady then
        local ok, err = pcall(companions.registerPhoneContacts, player)
        if not ok then log('Phone catalog registration failed: ' .. tostring(err)) end
        phoneCatalogReady = ok
    end
    if worldReady then
        -- Once per failure: a service that cannot start is reported before the player tries to talk.
        local notice = serviceCall('notice', os.time())
        if notice then convaiNotices.send(player, 'service-down', notice) end
    end
    local managerOk, managerError = pcall(manager.update, player, 0.1)
    if not managerOk then log('Manager update failed: ' .. tostring(managerError)) end
    if worldReady then companions.update(player, elapsedPoll, focusEntity) end
    -- The global keeps this callback's upvalue count unchanged (LuaJIT limits upvalues).
    if worldReady and convaiCompanionAdoption then
        local adoptionOk, adoptionError = pcall(convaiCompanionAdoption.update, elapsedPoll)
        if not adoptionOk then log('Companion adoption update failed: ' .. tostring(adoptionError)) end
    end
    local tacticOk, tacticError = pcall(tactics.update, player, elapsedPoll, worldReady)
    if not tacticOk then tactics.cancel('update-error'); log('Companion tactic update failed: ' .. tostring(tacticError)) end
    movementLog.update(worldReady and manager.developerMode(), elapsedPoll, companions.movementSnapshot)
    updateGroup(player)
    local battleOk, battleError = pcall(updateBattles, player, elapsedPoll, worldReady)
    if not battleOk then
        cancelAutomatic('observation-error')
        battleSample, battlePeople = nil, {}
        if os.time() >= (battles.errorAt or 0) then
            battles.errorAt = os.time() + 30
            log('Battle observation skipped: ' .. tostring(battleError))
        end
    end
    if focusUntil and not active and not pending and not speech.requestId and os.time() >= focusUntil then
        endFocus(player)
        focusUntil = nil
        focusMode = nil
        focusEntity = nil
    end
    if focusedCrowd and not focusedCrowd.checked and os.time() > focusedCrowd.at then
        focusedCrowd.checked = true
        local positionOk, displacement = pcall(function()
            local current = focusedCrowd.npc:GetWorldPosition()
            local start = focusedCrowd.position
            return math.sqrt((current.x - start.x)^2 + (current.y - start.y)^2 + (current.z - start.z)^2)
        end)
        log('Crowd focus after one second: metres_moved=' .. (positionOk and tostring(displacement) or 'unavailable'))
    end
    if releasedCrowd and os.time() > releasedCrowd.at + 2 then
        local prior = releasedCrowd
        releasedCrowd = nil
        local ok, result = pcall(function()
            if not prior.npc:IsAttached() then return 'NPC streamed out' end
            local current = prior.npc:GetWorldPosition()
            local start = prior.position
            local moved = math.sqrt((current.x - start.x)^2 + (current.y - start.y)^2 + (current.z - start.z)^2)
            return 'actor=' .. tostring(prior.npc:GetEntityID().hash) .. ' metres_moved=' .. tostring(moved)
        end)
        log('Crowd movement after gaze release: ' .. (ok and tostring(result) or 'unavailable: ' .. tostring(result)))
    end
    updateGaze(player, 0.1)
    if autoConnect then
        local blocked = battleSample == nil or not battleSample.available or battleSample.blocked == true
            or battleSample.combat == true or tactics.busy()
        local talking = (active and active.profileKey) or (pending and pending.profileKey)
            or (microphone.context and microphone.context.profileKey) or nil
        -- A scripted scene (or game dialogue) ends a conversation partnership.
        local scene = battleSample ~= nil and battleSample.available == true
            and (battleSample.tier ~= 1 or battleSample.dialogue == true)
        local ok, err = pcall(autoConnect.update, elapsedPoll, {worldReady = worldReady == true, blocked = blocked,
            player = player, talking = talking, talkingEntity = active and speech.target or nil, scene = scene,
            talkingId = (active and active.entity) or (pending and pending.entity)
                or (microphone.context and microphone.context.entity) or nil})
        if not ok then log('Auto-connect update failed: ' .. tostring(err)) end
    end
    if pending then
        local currentOwner = knowledgeOwner(refreshKnowledgeFrame())
        if currentOwner.paused then return end
        if pendingKnowledgeOwner and not sameKnowledgeOwner(pendingKnowledgeOwner, currentOwner) then
            gameplayActions.revoke('knowledge-world-changed', pending.requestId)
            cancelAutomatic('knowledge-world-changed', true)
            pending, pendingKnowledgeOwner = nil, nil
            microphone.cancel(); groupChat.cancel()
        end
    end
    -- The supervisor reports when the bridge holding this request has exited;
    -- its reply can no longer arrive, so retire the request now, not at 90 s.
    local serviceLost = pending and serviceCall('lostSince', pending.sentAt, os.time()) or nil
    if pending and (os.time() - pending.sentAt >= 90 or serviceLost) then
        -- The request owns its deadline. Focus expiry must never discard only
        -- pending while leaving a microphone/group waiting forever. Retire it
        -- before reading replies so a result at/after the deadline stays late.
        local expired = pending
        gameplayActions.revoke('reply-timeout', expired.requestId)
        if not expired.reaction then
            local explained = serviceLost or serviceCall('blockedMessage', os.time())
            convaiNotices.send(player, 'conversation-timeout', explained or ui.t('No reply arrived. The conversation service may not be running.'))
        end
        log((serviceLost and 'Conversation retired after the service exited: generation=' or 'Conversation timed out: generation=')
            .. expired.generation)
        local round = groupChat.round
        if expired.reaction then
            cancelAutomatic('reply-timeout')
        elseif (microphone.context and microphone.context.requestId == expired.requestId)
            or (round and round.mode == 'voice' and expired.group and round.id == expired.group.id) then
            -- Publishes cancel for the native microphone owner as well as
            -- retiring the Lua round and any prepared next-speaker response.
            cancelVoice('reply-timeout')
        else
            groupChat.received(expired.requestId, '', true, {})
        end
        pending, pendingKnowledgeOwner = nil, nil
        focusUntil = os.time() + 1
    end
    if pending then
        local replyFile = io.open('runtime/reply.json', 'rb')
        if replyFile then
            local raw = replyFile:read('*a')
            replyFile:close()
            local valid, reply = pcall(json.decode, raw)
            if valid and type(reply) == 'table'
                and reply.requestId == pending.requestId
                and reply.generation == pending.generation
                and reply.entity == pending.entity
                and (type(reply.text) == 'string' or type(reply.error) == 'string')
                and reactionCanDeliver(pending, player) then
                local shown = pcall(function()
                    if reply.error then
                        gameplayActions.revoke('reply-error', pending.requestId)
                        local keyId, keyText = keyReplyNotice(reply)
                        if keyId == 'key-memory' then convaiNotices.send(player, 'key-memory', keyText)
                        -- The daily allowance: a turn V asked for says so once; an automatic reaction just stops.
                        elseif keyId == 'daily-limit' then
                            if not pending.reaction then convaiNotices.send(player, 'daily-limit', keyText) end
                        -- Mistral failures: a turn V asked for says so; an automatic reaction (battle, loot) just stops.
                        elseif keyId == 'mistral-key' then
                            if not pending.reaction then convaiNotices.send(player, 'mistral-key', keyText) end
                        elseif keyId == 'mistral-limit' then
                            if not pending.reaction then convaiNotices.send(player, 'mistral-limit', keyText) end
                        elseif keyId == 'mistral-model' then
                            if not pending.reaction then convaiNotices.send(player, 'mistral-model', keyText) end
                        elseif keyId == 'mistral-no-key' or keyId == 'mistral-voice' then
                            sendProviderNotice(player, keyId, keyText)
                            if not pending.reaction then convaiNotices.send(player, 'reply-error', reply.error) end
                        elseif keyId then convaiNotices.send(player, 'quota-exhausted', keyText)
                        elseif not pending.reaction then convaiNotices.send(player, 'reply-error', reply.error) end
                    else
                        -- The first reply that runs without memory on a limited plan says so once.
                        local keyId, keyText = keyReplyNotice(reply)
                        if keyId == 'key-memory' then convaiNotices.send(player, 'key-memory', keyText) end
                        sendProviderNotice(player, keyId, keyText)
                        speech.start(pending, reply)
                    end
                end)
                if shown then
                    local _, listeners = groupAudience(player)
                    -- Continuous Convai PCM shares evolving-utterance delivery
                    -- semantics with stream v2, without native WAV chunking.
                    local utterance = reply.stream or (type(reply.continuous) == 'table'
                        and {version=2,id=reply.continuous.id} or nil)
                    groupChat.received(pending.requestId, reply.text, reply.error ~= nil or (not speech.requestId and not subtitles.ownsUtterance()), listeners, utterance, reply.userText)
                    tactics.received(pending.requestId, reply)
                    if type(microphone.received) == 'function' then microphone.received(pending.requestId) end
                    -- One line per reply: did speech start, and does the speaker's face carry
                    -- the speech layer (world NPCs get it on demand, Face.reds ConvaiFaceRequest).
                    local faceState = 'none'
                    if speech.actor then
                        local faceOk, faceReady, faceStatus = pcall(function()
                            return speech.actor:ConvaiFaceReady(), speech.actor:ConvaiFaceStatus() end)
                        faceState = faceOk and (tostring(faceReady) .. '/' .. tostring(faceStatus)) or 'unavailable'
                        -- A rebuilt world NPC (a vendor at its stall): workspot before>after the rebuild, once per reply.
                        local noteOk, note = pcall(function() return speech.actor:ConvaiFaceWorkspotNote() end)
                        if noteOk and type(note) == 'string' and note ~= '' then faceState = faceState .. ' workspot=' .. note end
                    end
                    log('Conversation result: generation=' .. pending.generation .. ' error=' .. tostring(reply.error ~= nil)
                        .. ' speech=' .. tostring(speech.state) .. ' face=' .. faceState)
                    if automatic and pending.requestId == automatic.requestId then
                        automatic.shown = reply.error == nil
                        if automatic.shown and (speech.requestId or subtitles.ownsUtterance()) then
                            automatic.playbackAt, automatic.leaseAt = os.time(), nil
                            reactionLease(true)
                        end
                    end
                    if not pending.reaction then focusUntil = os.time() + (speech.duration or 8) + 1 end
                    pending = nil
                end
            end
        end
    end
    -- Streaming speech can retire pending before its final action arrives.
    -- The captured lease owns this deadline independently of reply playback.
    -- Process an explicit reply failure first so it cannot admit an action.
    gameplayActions.update(worldReady)
    local ok, ready = pcall(function() return player:ConvaiHasSubmission() end)
    if not ok or not ready then
        if active then
            local openOk, composerOpen = pcall(function() return player:ConvaiComposerOpen() end)
            if openOk and not composerOpen then
                active = nil
                warmConversation(nil, nil)
                focusUntil = os.time() + 1
            end
        end
        return
    end
    local taken, message = pcall(function() return player:ConvaiTakeSubmission() end)
    if taken and type(message) == 'string' and #message > 0 then
        local context = active
        if context then
            if context.participants then
                groupChat.start('group-' .. tostring(os.time()) .. '-' .. tostring(context.generation), context.participants, message)
            else
                context.requestId = tostring(os.time()) .. '-' .. tostring(context.generation) .. '-' .. context.entity
                context.text = message
                context.sentAt = os.time()
                sendRequest(context)
            end
            log('Native input captured: generation=' .. context.generation .. ' bytes=' .. #message)
        else
            log('Late native input discarded after target loss')
        end
    end
    active = nil
end)

registerForEvent('onShutdown', function()
    local liveWorld = not worldSuspended and sessionHasState
    if liveWorld then
        local ok,done,reason=pcall(companions.prepareChauffeurShutdown,'Mod shutdown stopped the trip.')
        if not ok then log('Interrupted driver cleanup capture failed: '..tostring(done))
        elseif not done then log('Interrupted driver cleanup pending: '..tostring(reason)) end
    end
    invalidateKnowledge('shutdown')
    cancelAutomatic('shutdown')
    battles.reset()
    loot.reset(); lootObserver.reset(); lastAutomatic, mergeSuppressedUntil = nil, 0
    battleSample, battlePeople = nil, {}
    phoneChat.abandon()
    mcm.shutdown(liveWorld)
    groupChat.cancel()
    warmConversation(nil, nil)
    if autoConnect then pcall(autoConnect.reset) end
    microphone.cancel()
    if liveWorld then speech.stop('shutdown'); subtitles.clear()
    else speech.abandon(); subtitles.abandon() end
    active = nil
    if liveWorld then companions.dismissAll() else companions.abandon() end
    local player = liveWorld and Game.GetPlayer() or nil
    if player then pcall(function() player:ConvaiCloseManager() end) end
    manager.reset()
    if liveWorld then endFocus(player) else focusedCrowd, releasedCrowd = nil, nil end
    if convaiVanillaReactions then pcall(convaiVanillaReactions.clear) end
    pcall(movementLog.flush) -- buffered Developer movement trace
    focusMode = nil
    focusEntity = nil
    log('Game adapter shut down')
end)
