-- AI NPC Cyberpunk Mod game adapter. It never renders an ImGui text field.
-- Owns native composers, targeted turns, party connections and live diagnostics.
-- Optional native core plugin: routes the bridge mailbox files through its worker thread when
-- present (native-core.lua). Without the plugin, io and os stay unchanged.
pcall(function() dofile('native-core.lua').install() end)
-- Developer-mode probe: count and time every hook and onUpdate (no effect otherwise).
pcall(function() dofile('perf-probe.lua').hookRegistrations() end)
-- Is the service still restoring the player's saved files (mod/state-restore.lua, docs/PACKAGING.md "Mod Organizer 2")? A global: the readers
-- of settings.json, phone-history.json, addon-settings.json and npc-names.json ask it only when their file is missing or empty. Absent, they
-- behave as they always did.
do
    local restoreLoaded, restoreModule = pcall(dofile, 'state-restore.lua')
    convaiStateRestore = restoreLoaded and type(restoreModule) == 'table' and restoreModule or nil
end
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
-- Automatic error reports, game side (mod/error-reports.lua): a global, so this chunk gains no local.
pcall(function() dofile('error-reports.lua').configure(manager) end)
local managerUi = dofile('nsui.lua')
local phoneLayout = dofile('phone-layout.lua')
local phoneChatStyle = dofile('phone-chat-style.lua')
local phoneChat = dofile('phone-chat.lua')
-- Holocalls (mod/holocall.lua, docs/HOLOCALL.md). A global, so no function here gains an upvalue; nil if it cannot load.
do
    local loaded, module = pcall(dofile, 'holocall.lua')
    convaiHolocall = loaded and type(module) == 'table' and module or nil
end
local questContext = dofile('quest-context.lua')
local battleObserver = dofile('battle-observer.lua')
-- The observer's sample says whether V sits in an ordinary seat (sample.sitting): the sit's scene tier and choice flags are not a cutscene
-- (the seated-look module's M.plain). Read only while the seated-look controller (set in onInit, globals so onInit gains no upvalue) says V sits;
-- nothing per frame.
battleObserver.sitProbe = function(sample)
    local controller = convaiSeatedLook
    if not controller or not controller.sitting or not convaiSeatedLookModule then return false end
    return convaiSeatedLookModule.plain({kind = controller.sitting, at = controller.sitAt}, sample,
        convaiGameDialogue and convaiGameDialogue.lines or nil)
end
local battles = dofile('battle-reactions.lua').new()
convaiBattleReactions = battles
-- Companion tactics (Fight the marked target). The environment is
-- filled in below; see tacticEnv.
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
    owns = function() return false end, decide = function() return nil end,
    update = function() end, abandon = function() end, cancel = function() end})
companions.tactics = tactics
convaiCompanionTactics, convaiTargetMarking = tactics, marking
-- Add-on API (mod/addons.lua, docs/ADDON_API.md). A global, so no function here gains an upvalue. Until an add-on registers,
-- convaiAddons.live is false and every call below is skipped: the main mod behaves exactly as it does without the file.
do
    local loaded, module = pcall(dofile, 'addons.lua')
    convaiAddons = loaded and type(module) == 'table' and module or nil
end
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
local worldKnowledgeModule = dofile('world-knowledge.lua')
local worldKnowledge = worldKnowledgeModule.new({
    currentGeneration = function() return knowledgeFrame and knowledgeFrame.generation end,
    currentWorldToken = function() return knowledgeFrame and knowledgeFrame.worldToken end})
local journalHistory = dofile('journal-history.lua').new({
    currentGeneration = function() return knowledgeFrame and knowledgeFrame.generation end,
    currentWorldToken = function() return knowledgeFrame and knowledgeFrame.worldToken end})
convaiWorldKnowledge = worldKnowledge
-- Johnny speaks up (docs/JOHNNY_IN_YOUR_HEAD.md): a job the history scan newly finds finished, a romance fact newly set. Both callbacks
-- return at once while the setting is off (convaiJohnnyRemarkNote is defined further down).
journalHistory.onFinished = function(quests)
    if not convaiJohnnyRemarkNote then return end
    for _, quest in ipairs(quests) do convaiJohnnyRemarkNote('quest', quest) end
end
relationshipState.onFact = function(fact) if convaiJohnnyRemarkNote then convaiJohnnyRemarkNote('romance', fact) end end
-- V talks on their own (docs/V_TALKS.md): a finished job is one of its events too. convaiVTalkNote is defined further down and returns at once
-- while the setting is off (one settings read).
do
    local johnnyFinished = journalHistory.onFinished
    journalHistory.onFinished = function(quests)
        johnnyFinished(quests)
        if convaiVTalkNote then convaiVTalkNote('job', quests) end
    end
end
-- Requests name the world and journal parts by revision; each part is written once (docs/PERFORMANCE_NATIVE_PLAN.md 1b).
local partsLoaded, knowledgeParts = pcall(dofile, 'knowledge-parts.lua')
if not partsLoaded or type(knowledgeParts) ~= 'table' then knowledgeParts = nil end
-- Finished scans are encoded a few entries per frame so the first turn that needs them writes a ready string, and an
-- unrequested journal scan is paced (one page, then a rest) instead of taking a page every frame.
journalHistory.pace = true
if knowledgeParts and type(knowledgeParts.newEncoder) == 'function' then
    local function newEncoder(map) return knowledgeParts.newEncoder(map) end
    worldKnowledge.newEncoder, journalHistory.newEncoder = newEncoder, newEncoder
    -- A history scan still under way travels as a provisional part, its rows encoded while resting (journal-history.lua).
    journalHistory.encodeRow = function(value) return knowledgeParts.encode(value) end
end

-- Lease heartbeats (world-session, party-connections, relationship-state, companion-invitations,
-- nearby-connections, speech-state) are refreshed every 2 s and most counted whole os.time() seconds,
-- so they came due in the same frame: about 25 ms of file writes at once, a hitch every 2 s. An unchanged
-- heartbeat takes this frame's single slot or waits a frame; a change or a forced write never waits.
-- Globals (the modules read them; no new upvalue in onUpdate).
convaiHeartbeat = {frame = 0, used = -1}
convaiHeartbeatSlot = function()
    local state = convaiHeartbeat
    if state.used == state.frame then return false end
    state.used = state.frame
    return true
end

local worldSessionToken, worldSessionReady
local function publishWorldSession(frame, ready, force)
    local now = os.time()
    -- Unchanged and still leased (the common case, twice per frame): no table or string is built.
    if not force and frame and frame.worldToken == worldSessionToken and (ready == true) == worldSessionReady
        and worldSessionAt and now >= worldSessionAt and now - worldSessionAt < 2 then return end
    local value = {version = 1, token = frame and frame.worldToken or (knowledgeLaunch .. '-' .. (knowledgeEpoch + 1)),
        generation = frame and frame.generation or (knowledgeEpoch + 1), ready = ready == true, updated = now * 1000}
    local signature = value.token .. ':' .. tostring(value.ready)
    -- Lease heartbeat: the bridge keeps world-session.json 5 s; refresh it every 2 s or on change.
    if not force and signature == worldSessionSignature and worldSessionAt and now >= worldSessionAt
        and now - worldSessionAt < 2 then return end
    if not force and signature == worldSessionSignature and not convaiHeartbeatSlot() then return end
    local encoded, raw = pcall(json.encode, value); if not encoded then return end
    -- In place: one open instead of open+remove+rename (about 9 ms of the game
    -- thread every 2 s). readWorldSession retries a partial read 3 times, 15 ms apart.
    local file = io.open('runtime/world-session.json', 'wb'); if not file then return end
    local written, closed = file:write(raw), file:close(); if not written or not closed then return end
    worldSessionSignature, worldSessionAt = signature, now
    worldSessionToken, worldSessionReady = frame and frame.worldToken or nil, ready == true
end

local function refreshKnowledgeFrame()
    if not knowledgeAllowed then return knowledgeUnavailable() end
    -- The frame is a pure function of the epoch: reuse it instead of building a table and a token string every call.
    local held = knowledgeFrame
    if held and held.status == 'ready' and held.generation == knowledgeEpoch + 1 then
        publishWorldSession(held, true)
        return held
    end
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
    -- The reviewed pack is 9 MB (the bridge's sources, evidence and rules); the collector needs only the allowlist
    -- selectors, which loadPack keeps in runtime/knowledge-pack-lua.json after the first session (a ~220 ms decode
    -- on the first frame, every session, before).
    local pack
    if type(worldKnowledge.loadPack) == 'function' then
        local okPack, loaded = pcall(worldKnowledge.loadPack, {open = io.open, decode = json.decode, encode = json.encode,
            source = 'world-knowledge.json', cache = 'runtime/knowledge-pack-lua.json'})
        if okPack then pack = loaded end
    else
        local file = io.open('world-knowledge.json', 'rb')
        if not file then return end
        local raw = file:read(16 * 1024 * 1024 + 1); file:close()
        if type(raw) ~= 'string' or #raw > 16 * 1024 * 1024 then return end
        local decoded, whole = pcall(json.decode, raw)
        if decoded then pack = whole end
    end
    local versionOk, version = pcall(function() return Game.GetSystemRequestsHandler():GetGameVersion() end)
    if type(pack) == 'table' and versionOk and type(version) == 'string' then
        worldKnowledge:configure(pack, {gameVersion = version})
    end
end

-- The collectors rest between scans (world 30 s, active quests 10 s, history 300 s) and scan at once when a turn
-- is coming or the journal changed. A global, so callers deep in onUpdate add no upvalue.
convaiDemandKnowledge = function(lanes)
    pcall(worldKnowledge.demand, worldKnowledge, 0)
    -- A history scan already under way (the first one after a load takes minutes when paced) finishes at full speed now.
    if not lanes and type(journalHistory.scanning) == 'function' and journalHistory:scanning('history') then
        lanes = {'active', 'history'}
    end
    pcall(journalHistory.demand, journalHistory, lanes or {'active'}, 0)
end
local function updateKnowledge(delta)
    -- A journal change (JournalNotificationQueue.OnJournalUpdate, onInit) rescans everything once the burst settles;
    -- opening phone chat with a contact rescans before V's first message there.
    local dirty = worldKnowledge.journalChangedAt
    if dirty and os.clock() - dirty >= 1 then
        worldKnowledge.journalChangedAt = nil
        pcall(worldKnowledge.demand, worldKnowledge, 0); pcall(journalHistory.demand, journalHistory, {'active', 'history'}, 0)
    end
    local phone = convaiPhoneChat and convaiPhoneChat.contact or nil
    if phone ~= worldKnowledge.phoneContact then
        worldKnowledge.phoneContact = phone
        if phone and phone ~= '' then convaiDemandKnowledge() end
    end
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

local function captureKnowledge(context, channel, byRevision)
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
        -- byRevision: the bridge rebuilds the snapshots from runtime/knowledge-*.json (bridge/knowledge-parts.mjs), so the
        -- request carries headers and row ids, not ~800 KB of copies. Any failure falls back to the full snapshots.
        local published = false
        if byRevision and knowledgeParts then
            local parts = {}
            local worldOk, worldHeader, worldPart = pcall(worldKnowledge.capturePart, worldKnowledge, binding)
            local historyOk, historyHeader, historyParts = pcall(journalHistory.capturePart, journalHistory, binding)
            if worldOk and historyOk and type(worldHeader) == 'table' and type(historyHeader) == 'table' then
                if worldPart then parts[#parts + 1] = worldPart end
                for _, part in ipairs(historyParts or {}) do parts[#parts + 1] = part end
                local ok, done = pcall(knowledgeParts.publish, parts)
                if ok and done then world, history, published = worldHeader, historyHeader, true end
            end
        end
        if not published then world, history = worldKnowledge:capture(binding), journalHistory:capture(binding) end
    end
    local after = refreshKnowledgeFrame()
    if not knowledgeAllowed or not sameKnowledgeOwner(owner, knowledgeOwner(after)) then return nil end
    if after.status == 'paused' then return nil, 'save-in-progress' end
    return {worldKnowledge = world, journalHistory = history, owner = owner}
end

local function attachKnowledge(context)
    local ok, captured = pcall(captureKnowledge, context, nil, true)
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
    leaveOffer = function(entity, context)
        -- A character another mod or a spawner created makes no offers about our party (docs/SPAWNED_CHARACTERS.md).
        local round = groupChat.round
        for _, person in ipairs(round and round.participants or {}) do
            if person.entity == entity and person.spawned then return nil end
        end
        return adoption and adoption.leaveOffer(entity, context) or nil
    end,
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
    -- No actions for a game-placed story character (docs/WORLD_CHARACTERS.md): it is not a party member, so nothing is offered
    -- and it is not even told what it cannot do.
    -- Nor for Johnny in V's head (docs/JOHNNY_IN_YOUR_HEAD.md): he has no body to follow, fight or drive with.
    if type(context.head) == 'table' then return false end
    if convaiStory and convaiStory.entity == context.entity then return false end
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
    -- In place (the file ships as an empty placeholder under Mod Organizer 2): the bridge reads it with a
    -- try/catch and ignores a partial or empty file until the next publication.
    local file = io.open(path, 'wb'); if not file then return end
    file:write(raw); file:close()
end

microphone.captureKnowledge = function(context) return captureKnowledge(context, nil, true) end
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
-- How long a sent phone message waits for its reply (phone-chat.lua asks once per message): the provider's own turn budget plus a margin, so
-- the bridge's explanation (Local AI 80 s, a custom endpoint up to 120 s, a cold model load included) arrives before the draft is given back.
-- Convai and Mistral answer or fail well inside the 45 s default.
phoneChat.replyWait = function()
    local ok, state = pcall(manager.mistral)
    local provider = ok and type(state) == 'table' and state.effective or nil
    if provider == 'local' then return 95 elseif provider == 'custom' then return 125 end
    return 45
end
groupChat.onPreparation = function(preparation)
    if preparation and not attachKnowledge(preparation.input) then preparation = nil end
    -- Written in place (the shipped placeholder is replaced, never created or deleted: Mod Organizer 2).
    local f = io.open('runtime/group-prefetch.json', 'wb')
    if not f then return end
    f:write(preparation and json.encode(preparation) or '{}'); f:close()
end
groupChat.onPreparation(nil)
local supportedProfiles = {}
local profiles = {}
do
    local f = io.open('conversation-characters.json', 'rb')
    if f then
        local ok, decoded = pcall(json.decode, f:read('*a')); f:close()
        if ok and type(decoded) == 'table' then profiles = decoded end
        -- The roster carries the bridge's research text (backstory, sources, speaking style, uncertainty notes, native
        -- intrinsics: about 1.1 MB of the 1.4 MB file) that no game-side code reads. Dropped once here, so the session keeps
        -- about 0.25 MB of roster tables in the shared Lua heap instead of about 1.3 MB (deliverables/perf/LUA_HEAP.md).
        local bridgeOnly = {'backstory', 'sources', 'speakingStyleDescription', 'speakingStyleSampleDialogues', 'uncertainty',
            'nativeIntrinsic'}
        for _, profile in ipairs(profiles) do
            supportedProfiles[profile.key] = true
            if type(profile) == 'table' then for _, field in ipairs(bridgeOnly) do profile[field] = nil end end
        end
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
-- mark: an add-on speaker's own caption carries a small tag when its "Mark our lines" is on (mod/addons.lua captionName).
subtitles.configure({style = manager.subtitleStyle, mark = function(profileKey, name)
    if convaiAddons and convaiAddons.live then return convaiAddons.captionName(profileKey, name) end
    return name
end})
companions.onBeforeRemove = speech.clearEntity
phoneChat.configure(profiles, manager, {
    captureBinding = capturePhoneBinding,
    captureWorldKnowledge = function(_, key)
        -- By revision: the phone request (rewritten into phone-chat-input.json every 3 s while it waits) stays small.
        knowledgePhoneCapture = captureKnowledge({profileKey = key}, 'phone', true)
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
        -- The held frame itself (read for its worldToken and generation only; it is reused, not rebuilt, every frame).
        return knowledgeFrame
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
managerUi.configure(manager, companions, dofile('manager-party.lua'), invitations)
-- The second host of the manager's page: Mod Configuration Menu 0.10.5 or newer, through its public API (mod/mcm-host.lua). It shares
-- the page logic of the Native Settings UI host, registers itself when that MCM is installed, and costs a clock comparison otherwise.
do
    local attached, attachError = pcall(function() managerUi.attach(dofile('mcm-host.lua')) end)
    if not attached then convaiNoticeLog('Manager: the Mod Configuration Menu host did not load: ' .. tostring(attachError)) end
end
convaiManager = managerUi
local catalog = characterCatalog.build(profiles, archetypes)
-- The record IDs of a record-cloning mod's copies ("NCA.Character.Judy", characterCatalog.CLONE_PREFIXES): a global table, read by
-- the spawned-character check below (an NCA follower counts as spawned whatever the dynamic entity system answers for it).
convaiCloneRecordIds = {}
for record, profile in pairs(characterCatalog.build(profiles).records) do
    local ok, id = pcall(function() return tostring(TweakDBID.new(record)) end)
    if ok then
        catalog.records[id] = profile
        if characterCatalog.isCloneRecord(record) then convaiCloneRecordIds[id] = true end
    end
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
-- Characters the player made (docs/CHARACTER_EDITOR.md, "Your own characters"): mod/custom-characters.lua reads runtime/custom-characters.json
-- when the mod loads and again on a talk key press when that is due, and catalog.custom answers characterCatalog.resolve with two table lookups.
-- Their keys are supported profiles while they exist and are enabled without being in the manager (manager.configureCustom). A global, so no
-- function here gains an upvalue; optional like the modules below: without it nothing changes.
do
    local loaded, module = pcall(dofile, 'custom-characters.lua')
    if loaded and type(module) == 'table' and type(module.new) == 'function' then
        local created, service = pcall(module.new, {
            hash = function(record)
                local ok, id = pcall(function() return tostring(TweakDBID.new(record)) end)
                return ok and id or nil
            end,
            prefixes = characterCatalog.CLONE_PREFIXES,
            -- Mistral or the Local AI answers: Convai has no character for this one (read only when somebody matched).
            enabled = function() return type(manager.textProviderActive) == 'function' and manager.textProviderActive() end,
            onChange = function(self)
                for key in pairs(supportedProfiles) do
                    if type(characterCatalog.isCustomKey) == 'function' and characterCatalog.isCustomKey(key) then supportedProfiles[key] = nil end
                end
                for key in pairs(self.keys) do supportedProfiles[key] = true end
                -- With no character made the catalogue is exactly as it was: resolve never calls into this module.
                catalog.custom = self.count > 0 and self or nil
            end})
        if created and type(service) == 'table' then
            convaiCustomCharacters = service
            if type(manager.configureCustom) == 'function' then manager.configureCustom(function(key) return service.has(key) end) end
            pcall(service.refresh, true)
        else print('[CyberpunkConvai] custom-characters.lua failed: ' .. tostring(service)) end
    else print('[CyberpunkConvai] custom-characters.lua unavailable: ' .. tostring(module)) end
end
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
-- Developer mode: onUpdate marks its own segments ('init:' rows in perf-probe.json). A global, not an upvalue.
convaiPerfMark = type(convaiPerfProbe) == 'table' and type(convaiPerfProbe.mark) == 'function' and convaiPerfProbe.mark
    or function() end
local generation = 0
local active = nil
local pending = nil
local pendingKnowledgeOwner = nil
local poll = 0
-- While a reply is due, reply.json's revision is checked every 30 ms (see the probe before the 0.1 s throttle in onUpdate).
-- replyRaw / replyDecoded: the last reply.json text and its decoded value, so an unchanged file is not decoded on every tick.
local replyProbe, replyRevision, replyRaw, replyDecodeOk, replyDecoded = 0, nil, nil, false, nil
local diagnosticPoll = 0
-- Developer mailboxes (runtime/diagnostic-request.txt here, face-test and gesture-probe requests in their probes):
-- each poll is one CET io.open (1-3 ms of the game thread). They answer within a second with Developer mode on and
-- every 4 s otherwise, which the request scripts' 8-10 s deadlines still cover. A global: the probes read it.
convaiDevMailboxPeriod = function() return manager.developerMode() and 1 or 4 end
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
        -- A record-cloning mod's copy ("NCA.Character.x") reads as the original record, so its tokens and quest prefix still count.
        return characterCatalog.originalRecordName(TDBID.ToStringDEBUG(recordId))
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

-- forceFacts: read the TweakDB facts even when "Talk to ordinary NPCs" is off (the scanner names, mod/npc-names.lua).
local function profileIdentity(npc, forceFacts)
    local managedKey, managedName, owned = companions.identity(npc)
    local name = managedName or tostring(npc:GetTweakDBFullDisplayName(true) or 'NPC')
    local body = tostring(npc:GetBodyType() or '')
    if owned and not managedKey then return nil, name, body end
    -- Our own glitching copy of Johnny (mod/johnny-hologram.lua) is a picture, not a character: no profile, no talk.
    if convaiJohnnyHologram and convaiJohnnyHologram.visit and convaiJohnnyHologram:owns(tostring(npc:GetEntityID().hash)) then return nil, name, body end
    local recordOk, record = pcall(function() return tostring(npc:GetRecordID()) end)
    local crowdOk, crowd = pcall(function() return npc:IsCrowd() end)
    -- spawned: a character another mod or a spawner created (mod/spawned-characters.lua, docs/SPAWNED_CHARACTERS.md). It is
    -- player-made, not a quest actor, so it talks with its own roster profile like our copies (nothing of ours moves it).
    local spawned = not owned and convaiSpawnedCharacters ~= nil and convaiSpawnedCharacters:is(npc) or nil
    -- world: the game's own character, not a copy the mod spawned. A named story character there gets no
    -- conversation profile at all (character-catalog.lua resolve); only the spawned copy talks.
    -- story: the player allows talking to the game's own named characters (Settings > Talk to story characters,
    -- docs/WORLD_CHARACTERS.md). It only lets a roster record or name resolve for a character the game placed: it stays
    -- world, so a story-bound character without a roster profile still never falls back to an archetype or a resident.
    local story = managedKey == nil and not spawned and convaiWorldTalk ~= nil
        and type(manager.storyConversations) == 'function' and manager.storyConversations() or nil
    local actor = {managedKey = managedKey, name = name, world = managedKey == nil and not spawned, spawned = spawned,
        story = story, bodyType = body, record = recordOk and record or '', crowd = crowdOk and crowd}
    if not managedKey and (forceFacts or (type(manager.archetypeConversations) == 'function' and manager.archetypeConversations())) then
        local idOk, entity = pcall(function() return tostring(npc:GetEntityID().hash) end)
        actor.facts = archetypeFacts(npc, idOk and entity or nil, body)
    end
    local key, canonical, archetype = characterCatalog.resolve(catalog, actor)
    return key, canonical, body, archetype
end

-- Characters another mod or a spawner created (docs/SPAWNED_CHARACTERS.md): recognised from the shared dynamic entity
-- system, never from another mod's names. A global, so no function here gains an upvalue; optional like the modules below.
do
    local loaded, module = pcall(dofile, 'spawned-characters.lua')
    -- clone(npc): the body was made from a record-cloning mod's copy of a record (Night City Allies: "NCA.Character.x"), by the
    -- hash of the record or, when the engine can name it, by its debug name. Asked once per entity (the classification is cached).
    local function clone(npc)
        local ok, recordId = pcall(function() return npc:GetRecordID() end)
        if not ok or recordId == nil then return false end
        if convaiCloneRecordIds[tostring(recordId)] then return true end
        local named, text = pcall(function() return TDBID.ToStringDEBUG(recordId) end)
        return named and characterCatalog.isCloneRecord(text) == true
    end
    convaiSpawnedCharacters = loaded and type(module) == 'table' and type(module.new) == 'function' and module.new({clone = clone}) or nil
end

-- May V talk to the game's own named characters right now (docs/WORLD_CHARACTERS.md)? A global, loaded like the module above:
-- read on a talk key press, a recording's validity poll and twice a second while such a reply is heard, never per frame.
do
    local loaded, module = pcall(dofile, 'world-talk.lua')
    convaiWorldTalk = loaded and type(module) == 'table' and type(module.new) == 'function'
        and module.new({sample = function(player) return battleObserver.sample(player) end}) or nil
end

-- Johnny in your head (docs/JOHNNY_IN_YOUR_HEAD.md, mod/johnny-head.lua): with the setting on, the private talk keys that find nobody
-- in front of V address Johnny as the voice in V's head. Globals, like the modules above. Nothing is loaded while the setting is off:
-- the module is read from disk on the first talk key press (or draw of the settings page) that asks for it with the setting on.
function convaiJohnnyHeadService()
    if not manager.johnnyInHead() then return nil end
    if convaiJohnnyHead == nil then
        local loaded, module = pcall(dofile, 'johnny-head.lua')
        convaiJohnnyHead = loaded and type(module) == 'table' and type(module.new) == 'function' and module.new({
            sample = function(player) return battleObserver.sample(player) end,
            lines = function() return convaiGameDialogue and convaiGameDialogue.lines or nil end}) or false
        if not convaiJohnnyHead then print('[CyberpunkConvai] johnny-head.lua unavailable: ' .. tostring(module)) end
    end
    return convaiJohnnyHead or nil
end
-- His standing for the settings page (mod/manager-ui.lua johnnyStandingRow), read once per draw of that page.
function convaiJohnnyStanding()
    local service = convaiJohnnyHeadService()
    return service and service:standing() or nil
end
-- Johnny speaks up (phase 2, mod/johnny-remarks.lua): loaded on the first event that finds both settings on (Johnny in your head, and
-- Johnny speaks up at Rare or Normal). The collectors that hand events over already run; with either setting off an event costs two
-- boolean reads here and nothing is loaded.
function convaiJohnnyRemarksService()
    if manager.johnnyRemarks() == 'off' or not manager.johnnyInHead() then return nil end
    if convaiJohnnyRemarks == nil then
        local loaded, module = pcall(dofile, 'johnny-remarks.lua')
        convaiJohnnyRemarksModule = loaded and type(module) == 'table' and type(module.new) == 'function' and module or nil
        convaiJohnnyRemarks = convaiJohnnyRemarksModule and module.new({level = function() return manager.johnnyRemarks() end}) or false
        if not convaiJohnnyRemarks then print('[CyberpunkConvai] johnny-remarks.lua unavailable: ' .. tostring(module)) end
    end
    return convaiJohnnyRemarks or nil
end
-- The optional Johnny features that ride the 0.5 s battle sample (places, the fight watch, the hologram) run under pcall: updateBattles
-- itself is called under pcall and a fault there would reset the battle sample and cancel automatic reactions every frame. A fault is
-- logged once per feature and the feature carries on at its next call.
function convaiJohnnyGuarded(name, work, ...)
    local ok, problem = pcall(work, ...)
    if ok then return end
    convaiJohnnyFaults = convaiJohnnyFaults or {}
    if not convaiJohnnyFaults[name] then
        convaiJohnnyFaults[name] = true
        if convaiLogLine then convaiLogLine('Johnny ' .. name .. ' failed (carrying on): ' .. tostring(problem)) end
    end
end
-- One event from a collector: 'person' (a game-dialogue row), 'quest' (a finished job from the history scan), 'romance' (a fact name),
-- 'place' (a place row from the district sample below), 'relic' (the end of an episode of the Relic's sickness, the watch below) or
-- 'fight' (the end of a fight that counts, the fight watch below).
function convaiJohnnyRemarkNote(kind, value)
    local remarks = convaiJohnnyRemarksService()
    local module = convaiJohnnyRemarksModule
    if not remarks or not module then return end
    local subject, facts, cooldown
    if kind == 'person' then subject, facts = module.personEvent(value)
    elseif kind == 'quest' then subject, facts = module.questEvent(value)
    elseif kind == 'romance' then subject, facts = module.romanceEvent(value)
    elseif kind == 'relic' then subject, facts, cooldown = module.relicEvent(value)
    elseif kind == 'fight' then subject, facts, cooldown = module.fightEvent(value)
    elseif kind == 'place' then
        subject, facts, cooldown = module.placeEvent(value)
        -- The second note needs facts and journal entries of this save: read once per arrival (a few native reads, hours apart), here.
        if subject and value.alt and module.altMet(value, function(name) return Game.GetQuestsSystem():GetFactStr(name) end,
            function(path, class)
                local journal = Game.GetJournalManager()
                local entry = journal:GetEntryByString(path, class)
                if not entry or not entry:IsA(class) then return nil end
                return journal:GetEntryState(entry) == Enum.new('gameJournalEntryState', 'Succeeded') and 'succeeded' or 'other'
            end) then facts.alt = true end
    end
    -- convaiLogLine, not log: this function is defined above `local function log`, where a bare log is an undefined global.
    if subject and remarks:note(kind, subject, facts, os.time(), cooldown) and convaiLogLine then convaiLogLine('Johnny speaks up: noted ' .. subject) end
end
-- The Relic watch (Johnny speaks up, step 3, mod/johnny-relic.lua): created once both settings are on, by the district sample below (its
-- gate runs every PLACE_SECONDS), because its two observers have to exist before an episode starts. They cannot be removed, so they stay
-- registered for the session and return at once while the watch is switched off. Nothing is loaded with either setting off.
function convaiJohnnyRelicEnsure()
    if convaiJohnnyRelic == nil then
        local loaded, module = pcall(dofile, 'johnny-relic.lua')
        convaiJohnnyRelic = loaded and type(module) == 'table' and type(module.new) == 'function' and module.new({
            onEvent = function(event) convaiJohnnyRemarkNote('relic', event) end,
            log = function(line) if convaiLogLine then convaiLogLine(line) end end}) or false
        if not convaiJohnnyRelic then print('[CyberpunkConvai] johnny-relic.lua unavailable: ' .. tostring(module)) end
    end
    if convaiJohnnyRelic then convaiJohnnyRelic:enable() end
end
-- The fight watch (Johnny speaks up, step 4): a tracker made by the district sample's gate below once both settings are on, fed by the
-- 0.5 s battle sample (convaiJohnnyFightSample: one nil check while it does not exist). It reads four of the game's own counters (quest
-- facts) when a fight starts and when it ends, nothing per hit. Dropped when either setting goes off and at every world change.
function convaiJohnnyFightCounters()
    local module, quests = convaiJohnnyRemarksModule, Game.GetQuestsSystem()
    local counters = {}
    for _, name in ipairs(module.FIGHT_COUNTERS) do
        local value = quests:GetFactStr(name)
        if type(value) ~= 'number' then return nil end
        counters[name] = value
    end
    return counters
end
function convaiJohnnyFightSample(sample)
    local tracker = convaiJohnnyFight
    if not tracker or not sample or sample.available ~= true then return end
    local event = tracker:observe(sample.combat == true, os.clock(), convaiJohnnyFightCounters)
    if event then
        if convaiLogLine then
            convaiLogLine('Johnny speaks up: fight over seconds=' .. event.seconds .. ' dead=' .. event.dead .. ' alive=' .. event.alive)
        end
        convaiJohnnyRemarkNote('fight', event)
    end
end
-- Johnny's hologram (phase 3, mod/johnny-hologram.lua): loaded on the first sit that finds both settings on (Johnny in your head, and
-- Johnny's hologram); with either off a sit costs two boolean reads. The look is Johnny's (M.DEFAULT_LOOK, his own glitch effects).
function convaiJohnnyHologramService()
    if not manager.johnnyHologram() or not manager.johnnyInHead() then return nil end
    if convaiJohnnyHologram == nil then
        local loaded, module = pcall(dofile, 'johnny-hologram.lua')
        convaiJohnnyHologram = loaded and type(module) == 'table' and type(module.new) == 'function' and module.new({
            enabled = function() return manager.johnnyHologram() and manager.johnnyInHead() end,
            story = function() local head = convaiJohnnyHeadService(); return head and head:story() or 'unreadable' end,
            lines = function() return convaiGameDialogue and convaiGameDialogue.lines or nil end,
            -- He stays while V sits: the seat hook's own answer (nil while V stands), asked on the 0.5 s sample only while he is there.
            seated = function() return convaiSeatedLook ~= nil and convaiSeatedLook.sitting ~= nil end,
            log = function(line) if convaiLogLine then convaiLogLine(line) end end}) or false
        if convaiJohnnyHologram then pcall(convaiJohnnyHologram.sweep, convaiJohnnyHologram)
        else print('[CyberpunkConvai] johnny-hologram.lua unavailable: ' .. tostring(module)) end
    end
    return convaiJohnnyHologram or nil
end
-- Is V seated in an ordinary seat right now? For the manager's shortcut (mod/nsui-entry.lua, mod/mcm-host.lua): asked only when the game's
-- scene tier is 3 or above, on a key press, one fresh observer sample. An answer of no is logged (at most every 5 s) with the controller's
-- verdict and the sample's scene facts, so a refusal on a seat that should have counted shows why in probe.log.
function convaiPlainSitting()
    local controller = convaiSeatedLook
    local player = Game.GetPlayer()
    local ok, sample = false, nil
    if player then ok, sample = pcall(battleObserver.sample, player) end
    local plain = ok and type(sample) == 'table' and controller ~= nil and controller.sitting ~= nil and sample.sitting == true
    if not plain and (convaiPlainSitLogAt == nil or os.clock() - convaiPlainSitLogAt >= 5) then
        convaiPlainSitLogAt = os.clock()
        local facts = ok and type(sample) == 'table' and (' dialogue=' .. tostring(sample.dialogue) .. ' choices=' .. tostring(sample.choices)
            .. ' tier=' .. tostring(sample.tier) .. ' call=' .. tostring(sample.call) .. ' combat=' .. tostring(sample.combat)) or ' unreadable'
        if convaiLogLine then convaiLogLine('Plain sit check: no (seated-look sitting=' .. tostring(controller and controller.sitting) .. facts .. ')') end
    end
    return plain
end
-- V sat down (the seated-look module's onSit): one table write in the service. V stood up (onStand): he goes at once.
function convaiJohnnyHologramMoment(kind, seat)
    local service = convaiJohnnyHologramService()
    if service then service:moment('sit', kind, seat) end
end
function convaiJohnnyHologramStand()
    if convaiJohnnyHologram then convaiJohnnyHologram:stand() end
end
-- Places (Johnny speaks up, step 2): the existing 0.5 s battle sample calls this. It reads at most every PLACE_SECONDS, and only while
-- both settings are on (two boolean reads otherwise): the id of the district V is in (three native calls). The record and its parents
-- are resolved only when that id changed. Nothing per frame and no hook: the game's own district event (PlayerPuppet OnDistrictChanged,
-- queued by DistrictManager when a district is entered, not when one is left) would need an observer that stays registered with the
-- settings off. A save load starts a new baseline (convaiJohnnyPlaceReset in abandonSession). Globals, so updateBattles gains no upvalue.
do
    local nextAt, lastId, chain, tracker = nil, nil, nil, nil
    local function districtChain(id)
        local names, record, guard = {}, TweakDBInterface.GetDistrictRecord(id), 0
        while record and guard < 8 do
            names[#names + 1] = nameString(record:EnumName())
            record, guard = record:ParentDistrict(), guard + 1
        end
        return names
    end
    function convaiJohnnyPlaceSample(worldReady, mounted)
        local at = os.clock()
        if not worldReady or (nextAt and at < nextAt) then return end
        local module = convaiJohnnyRemarksModule
        nextAt = at + (module and module.PLACE_SECONDS or 6)
        if manager.johnnyRemarks() == 'off' or not manager.johnnyInHead() then
            lastId, chain, tracker = nil, nil, nil
            convaiJohnnyFight = nil
            if convaiJohnnyRelic then convaiJohnnyRelic:disable() end
            return
        end
        if not convaiJohnnyRemarksService() then return end
        convaiJohnnyRelicEnsure()
        module = convaiJohnnyRemarksModule
        if not convaiJohnnyFight then convaiJohnnyFight = module.fightTracker() end
        local ok, key, id = pcall(function()
            local system = Game.GetScriptableSystemsContainer():Get('PreventionSystem')
            local district = system and system:GetCurrentDistrict()
            local value = district and district:GetDistrictID()
            if not value then return nil end
            return tostring(value.hash) .. '_' .. tostring(value.length), value
        end)
        if not ok then return end
        if key ~= lastId then
            local resolved, names = true, {}
            if id then resolved, names = pcall(districtChain, id) end
            lastId, chain = key, resolved and names or {}
        end
        tracker = tracker or module.placeTracker()
        local row = tracker:observe(chain, mounted)
        if row then convaiJohnnyRemarkNote('place', row) end
    end
    function convaiJohnnyPlaceReset() nextAt, lastId, chain, tracker = nil, nil, nil, nil end
end

-- The one rule for characters the game placed (docs/WORLD_COMPANIONS.md, "The mod never touches game characters"):
--   ours(npc)      a copy the mod spawned: the full feature set.
--   spawned(npc)   a character another mod or a spawner created: the talk path with its own roster profile, a speaking
--                  face and eye contact while it talks; nothing that moves, seats, equips or targets it (that mod owns it).
--   protected(npc) a named, story or quest character of the game, or a spawned one: no mod system touches it at all
--                  outside a conversation the player starts (the talk path decides that one through profileIdentity).
--   story(npc)     a named character of the game that the player may talk to (Settings > Talk to story characters, on by
--                  default): its roster profile and voice, and while it speaks its mouth and face. No gaze, bark muting, turn,
--                  idle, gesture, movement, action, party, attitude, equipment or scanner name, ever (docs/WORLD_CHARACTERS.md).
--                  It is still protected(npc) for every other system.
--   everyone else  an ordinary world NPC: only the talk path (a conversation the player starts) acts on it.
-- Read on demand (a request, a conversation start), cached per entity, never per frame.
local protectedCache, protectedCount = {}, 0
convaiWorldPolicy = {
    ours = function(npc)
        local ok, _, _, owned = pcall(companions.identity, npc)
        return ok and owned == true
    end,
    spawned = function(npc)
        if not npc or convaiSpawnedCharacters == nil then return false end
        local ok, _, _, owned = pcall(companions.identity, npc)
        if ok and owned == true then return false end
        return convaiSpawnedCharacters:is(npc) == true
    end,
    story = function(npc)
        if not npc or convaiWorldTalk == nil then return false end
        if type(manager.storyConversations) ~= 'function' or not manager.storyConversations() then return false end
        local identified, _, _, owned = pcall(companions.identity, npc)
        if identified and owned == true then return false end
        if convaiSpawnedCharacters ~= nil and convaiSpawnedCharacters:is(npc) then return false end
        -- A roster profile that is not an archetype or a resident: the game's own named character (by record or name).
        local resolved, key = pcall(profileIdentity, npc)
        return resolved and type(key) == 'string' and convaiSpawnedPeople ~= nil and convaiSpawnedPeople.named(key) == true
    end,
    protected = function(npc)
        if not npc then return false end
        local ok, _, _, owned = pcall(companions.identity, npc)
        if ok and owned == true then return false end
        -- Another mod's character is never a tactic target unless it fights V, and never renamed (mod/npc-names.lua).
        if convaiSpawnedCharacters ~= nil and convaiSpawnedCharacters:is(npc) then return true end
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

-- How far from V a spawned character still counts: the range group chat uses for the companions (companions.conversationCandidates).
convaiSpawnedRange = 8

-- The profile keys of the group round that is running (nil outside one), for auto-connect: every speaker of a round has
-- talked, not only the one V addressed. Read by auto-connect only while a conversation partner exists; no native call.
function convaiRoundKeys()
    local round = groupChat.round
    if not round or type(round.participants) ~= 'table' then return nil end
    local keys = {}
    for _, person in ipairs(round.participants) do
        if type(person.profileKey) == 'string' then keys[#keys + 1] = person.profileKey end
    end
    return keys
end

-- Characters another mod or a spawner created, in group chat and in battle and loot reactions (phase 2,
-- docs/SPAWNED_CHARACTERS.md). A global table, so no function here gains an upvalue. Nothing in it runs per frame: 'nearby'
-- answers a group key press, 'watch' a combat start or a pickup (both one targeting query, reused for a few seconds),
-- 'sample' is a boolean compare at the observer's own half-second poll, and 'reactionRows' reads only the (at most
-- three) characters 'watch' remembered, by entity ID, and nothing while there are none. They never enter 'companions'.
-- Group chat takes every spawned character with an enabled profile, a roster character or a generic one (a resident or an
-- archetype, flagged generic = true: two of them are two people although they share a profile). Reactions take roster
-- characters only. Our own copy of the same roster profile always comes first, so the spawned copy is the one skipped.
convaiSpawnedPeople = {
    stats = {},
    combat = false,
    named = function(key)
        return type(key) == 'string' and not archetypes.keys[key] and key ~= 'resident-male' and key ~= 'resident-female'
            and not key:match('^npc%-')
    end,
    -- Rows for the spawned characters within radius that have an enabled profile, nearest first. Same row shape as
    -- companions.conversationCandidates, plus spawned = true (and generic = true with its archetype facts for a resident or
    -- an archetype). options.roster keeps roster characters only (reactions); options.extra is a list of NPCs the caller
    -- already holds from its own native query. convaiSpawnedPeople.stats says what the last call found and why it dropped some.
    nearby = function(player, radius, options)
        local rows, service = {}, convaiSpawnedCharacters
        -- radius: the range asked. via: who was counted and how it was found ('scan', 'native' or 'remembered', with its distance).
        -- left: who was not and why (a service reason such as out-of-range or gone, or noProfile, unsupported, disabled).
        local stats = {found = 0, kept = 0, generic = 0, noProfile = 0, unsupported = 0, disabled = 0, generated = 0,
            radius = radius, via = {}, left = {}}
        convaiSpawnedPeople.stats = stats
        if service == nil or not player or not service:available() then return rows end
        options = type(options) == 'table' and options or {}
        local ok, found = pcall(service.nearby, service, player, radius, options.extra)
        if not ok or type(found) ~= 'table' then return rows end
        stats.found = #found
        local report = type(service.report) == 'table' and service.report.dropped or {}
        for _, item in ipairs(report) do
            stats.left[#stats.left + 1] = {who = item.key or ('entity ' .. tostring(item.entity)), reason = item.reason, distance = item.distance}
        end
        local seen = {}
        for _, row in ipairs(found) do
            local named, key, name, body, archetype = pcall(profileIdentity, row.npc)
            if not named or not key then
                stats.noProfile = stats.noProfile + 1
                stats.left[#stats.left + 1] = {who = 'entity ' .. tostring(row.entity), reason = 'noProfile', distance = row.distance}
            elseif not supportedProfiles[key] then
                stats.unsupported = stats.unsupported + 1
                stats.left[#stats.left + 1] = {who = key, reason = 'unsupported', distance = row.distance}
            elseif not manager.profileEnabled(key) then
                stats.disabled = stats.disabled + 1
                stats.left[#stats.left + 1] = {who = key, reason = 'disabled', distance = row.distance}
            else
                local roster = convaiSpawnedPeople.named(key)
                -- A character the player made talks and joins group chat; the game asks it for no battle or loot reaction.
                if roster and options.roster and type(characterCatalog.isCustomKey) == 'function' and characterCatalog.isCustomKey(key) then roster = false end
                if roster or not options.roster then
                    seen[#seen + 1] = {id = row.id, entity = row.entity, key = key, name = name}
                    stats.via[#stats.via + 1] = {who = key, source = row.source or 'scan', distance = row.distance}
                    local entry = {npc = row.npc, id = row.id, entity = row.entity, profileKey = key, name = name,
                        bodyType = body, distance = row.distance, spawned = true, source = row.source}
                    if not roster then
                        entry.generic = true
                        if not archetype and archetypes.keys[key] and type(characterCatalog.describe) == 'function' then
                            archetype = characterCatalog.describe(archetypes, key, {})
                        end
                        entry.archetype = archetype
                        stats.generic = stats.generic + 1
                    end
                    rows[#rows + 1] = entry
                    stats.kept = stats.kept + 1
                end
            end
        end
        -- The profile key and name go with each remembered ID (for the log and for the auto-connect lane).
        if #seen > 0 then pcall(service.remember, service, seen) end
        return rows
    end,
    -- Remember the spawned characters among the native candidates of a talk key press (any key: private or group), by entity ID.
    -- Key press only; the classification is cached per entity, so this adds no native read for a character already looked at.
    noteNative = function(list)
        local service = convaiSpawnedCharacters
        if service == nil or type(list) ~= 'table' then return end
        local rows = {}
        for _, npc in ipairs(list) do
            local ok, row = pcall(function()
                if not service:is(npc) then return nil end
                local id = npc:GetEntityID()
                return {id = id, entity = tostring(id.hash)}
            end)
            if ok and row then rows[#rows + 1] = row end
        end
        if #rows > 0 then pcall(service.remember, service, rows) end
    end,
    -- The probe-log tail of a nearby() call: the range, who counted and how each was found, who did not and why.
    describe = function()
        local stats = convaiSpawnedPeople.stats or {}
        local function metres(distance) return type(distance) == 'number' and string.format(' d=%.1f', distance) or '' end
        local function list(items, text)
            local parts = {}
            for index, item in ipairs(items or {}) do
                if index > 6 then parts[#parts + 1] = '+' .. (#items - 6) .. ' more'; break end
                parts[#parts + 1] = text(item)
            end
            return #parts > 0 and table.concat(parts, ', ') or 'none'
        end
        return ' radius=' .. tostring(stats.radius) .. 'm; counted: '
            .. list(stats.via, function(item) return item.who .. metres(item.distance) .. ' via ' .. item.source end)
            .. '; left out: '
            .. list(stats.left, function(item) return item.who .. metres(item.distance) .. ' ' .. item.reason end)
    end,
    -- Remember who is near V for the reactions of the next minutes (a combat start, a pickup).
    watch = function(player)
        local service = convaiSpawnedCharacters
        if service == nil or not player then return end
        pcall(service.watch, service, convaiSpawnedPeople.nearby(player, 20, {roster = true}))
    end,
    -- The observer's half-second sample: the start of a fight is the edge that asks for a watch (never while off).
    sample = function(player, observation, enabled)
        local combat = type(observation) == 'table' and observation.available == true and observation.combat == true
        if not combat then convaiSpawnedPeople.combat = false; return end
        if convaiSpawnedPeople.combat then return end
        convaiSpawnedPeople.combat = true
        if enabled then convaiSpawnedPeople.watch(player) end
    end,
    -- The remembered characters that are still here, friendly to V and within 20 m: {npc, entity, profileKey, name,
    -- bodyType, distance, spawned = true}. The caller adds who can speak right now.
    reactionRows = function(player)
        local service = convaiSpawnedCharacters
        if service == nil or not player then return {} end
        local ok, watched = pcall(service.watching, service)
        if not ok or type(watched) ~= 'table' or #watched == 0 then return {} end
        local rows = {}
        local placed, origin = pcall(function() return player:GetWorldPosition() end)
        if not placed then return rows end
        for _, row in ipairs(watched) do
            local good, distance = pcall(function()
                if not manager.profileEnabled(row.profileKey) or not supportedProfiles[row.profileKey] then return nil end
                -- One that turned hostile is an enemy, not a witness.
                if row.npc:GetAttitudeAgent():GetAttitudeTowards(player:GetAttitudeAgent())
                    == Enum.new('EAIAttitude', 'AIA_Hostile') then return nil end
                local at = row.npc:GetWorldPosition()
                return math.sqrt((at.x - origin.x)^2 + (at.y - origin.y)^2 + (at.z - origin.z)^2)
            end)
            if good and distance and distance <= 20 then
                rows[#rows + 1] = {npc = row.npc, entity = row.entity, profileKey = row.profileKey, name = row.name,
                    bodyType = row.bodyType, distance = distance, spawned = true}
            end
        end
        return rows
    end,
    -- Spawned roster characters riding in V's own vehicle (another mod seats its follower there: Night City Allies' Lucy or
    -- Rita, docs/NCA_FOLLOWERS_PLAN.md): rows {profileKey, name, spawned = true} for the turn context's party, and
    -- convaiSpawnedPeople.seats[profileKey] = the seat name, which the activity callback turns into 'passenger' or 'driving'.
    -- Asked only when a turn's context is read (turn-context.lua, cached 5 s), never per frame. Nothing is read unless V sits
    -- in a vehicle and a spawned character is remembered; then one recall (spawned-characters.lua) and one mount read per
    -- remembered roster character (at most 12). The seat is a fact the engine reports; nothing of ours moves or seats her.
    riders = function(player, radius)
        local seats = {}
        convaiSpawnedPeople.seats = seats
        local service = convaiSpawnedCharacters
        if service == nil or not player or type(service.known) ~= 'table' or #service.known == 0 then return {} end
        local inCar, car = pcall(function() return player:GetMountedVehicle() end)
        if not inCar or car == nil then return {} end
        local carRead, carId = pcall(function() return tostring(car:GetEntityID().hash) end)
        if not carRead or type(carId) ~= 'string' then return {} end
        local recalled, found = pcall(service.recall, service, player, radius, nil,
            function(entry) return entry.key == nil or convaiSpawnedPeople.named(entry.key) end)
        if not recalled or type(found) ~= 'table' then return {} end
        local rows = {}
        for _, row in ipairs(found) do
            local mounted, seat = pcall(function()
                local info = Game.GetMountingFacility():GetMountingInfoSingleWithObjects(row.npc)
                if not info or tostring(info.parentId.hash) ~= carId then return nil end
                return NameToString(info.slotId.id)
            end)
            if mounted and type(seat) == 'string' and seat ~= '' and seat ~= 'None' then
                local named, key, name = pcall(profileIdentity, row.npc)
                if named and key and convaiSpawnedPeople.named(key) and supportedProfiles[key] and manager.profileEnabled(key)
                    and seats[key] == nil then
                    seats[key] = seat
                    rows[#rows + 1] = {profileKey = key, name = name, spawned = true}
                end
            end
        end
        return rows
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
    -- Johnny speaks up (docs/JOHNNY_IN_YOUR_HEAD.md): a named character V just heard in person may get a remark from him later.
    onRow = function(row) if convaiJohnnyRemarkNote then convaiJohnnyRemarkNote('person', row) end end,
    -- A game voice is speaking: add-on remarks that asked to be patient wait for it (mod/addons.lua gameLine). Skipped until an add-on registers.
    onGameLineWanted = function() return convaiAddons ~= nil and convaiAddons.live == true end,
    onGameLine = function(seconds, kind, measured) convaiAddons.gameLine(seconds, kind, measured) end,
    -- Game lines an add-on replaces (docs/ADDON_API.md, "Replacing the game's own lines"): asked for every subtitle line, one boolean
    -- read until an add-on has declared a rule.
    matchWanted = function() return convaiAddons ~= nil and convaiAddons.live == true and convaiAddons.lineRulesWanted() end,
    matchLine = function(line, context) return convaiAddons.matchLine(line, context) end,
    onMuted = function(rule, info) convaiAddons.mutedLine(rule, info) end,
    resolve = function(speaker)
        if not speaker:IsNPC() then return nil end
        local key, canonical = profileIdentity(speaker)
        return key, canonical
    end,
    resolveName = function(name) return (characterCatalog.resolve(catalog, {name = name, crowd = false})) end,
    contactKey = function(contact) return (companions.phoneContactKey(contact)) end,
    -- The decision ledger (docs/QUEST_DECISIONS.md 4.4): off unless settings.decisionLedger; read once per picked dialogue option.
    ledgerEnabled = function() return type(manager.decisionLedger) == 'function' and manager.decisionLedger() == true end,
    worldToken = function() return knowledgeFrame and knowledgeFrame.worldToken end,
    gameTime = function() return worldKnowledgeModule.nativeGameTime and worldKnowledgeModule.nativeGameTime() end,
    tracked = function() return questContext.trackedQuest and questContext.trackedQuest() end,
    present = function(radius)
        local keys = {}
        for _, person in ipairs(companions.conversationCandidates(Game.GetPlayer(), radius)) do keys[#keys + 1] = person.profileKey end
        return keys
    end}) or nil
convaiGameDialogue = gameDialogue

-- Witness receipts (docs/QUEST_DECISIONS.md 4.3): off unless settings.witnessReceipts. When a world scan sees a quest fact or journal entry
-- change, who stood within 15 m is written to runtime/witness-receipts.json. One boolean check per scan; optional like the modules above.
do
    local loaded, module = pcall(dofile, 'witness-receipts.lua')
    convaiWitnessReceipts = loaded and type(module) == 'table' and type(module.new) == 'function' and module.new({
        enabled = function() return type(manager.witnessReceipts) == 'function' and manager.witnessReceipts() == true end,
        worldToken = function() return knowledgeFrame and knowledgeFrame.worldToken end,
        gameTime = function() return worldKnowledgeModule.nativeGameTime and worldKnowledgeModule.nativeGameTime() end,
        near = function(radius)
            local keys = {}
            for _, person in ipairs(companions.conversationCandidates(Game.GetPlayer(), radius)) do keys[#keys + 1] = person.profileKey end
            return keys
        end}) or nil
    if convaiWitnessReceipts then
        worldKnowledge.edgesWanted = function() return convaiWitnessReceipts:on() end
        worldKnowledge.onEdges = function(edges) convaiWitnessReceipts:record(edges) end
    end
end
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

-- What is going on around V right now (game clock, district, who is with V, vehicle, V's gender and lifepath), attached to
-- manual turns and worded first in the context by the bridge (bridge/turn-context.mjs). Read on demand when a turn is built,
-- cached for a few seconds, never per frame. Optional: the adapter keeps working unchanged if this module is absent.
do
    local loaded, module = pcall(dofile, 'turn-context.lua')
    convaiTurnContext = loaded and type(module) == 'table' and type(module.new) == 'function' and module.new({
        place = function() return currentDistrict() end,
        party = function(player, radius)
            local rows = companions.conversationCandidates(player, radius)
            -- The spawned characters of the group round this turn belongs to are with V too (they were chosen within 8 m).
            -- They carry no activity: nothing of ours knows what another mod's character is doing.
            local round = groupChat.round
            for _, person in ipairs(round and round.participants or {}) do
                if person.spawned then rows[#rows + 1] = {profileKey = person.profileKey, name = person.name} end
            end
            -- A spawned roster character in V's own vehicle is with V as well, and the engine says which seat she has
            -- (convaiSpawnedPeople.riders; the activity callback below words it). Nothing is read while V is on foot.
            local ridersRead, riders = pcall(function() return convaiSpawnedPeople.riders(player, radius) end)
            for _, person in ipairs(ridersRead and riders or {}) do rows[#rows + 1] = person end
            return rows
        end,
        -- Read the game's dialogue volume only while V's voice for typed lines is on (the bridge plays V at that level).
        wantVolume = function() return manager.vVoiceActive() == true end,
        -- What each companion is doing and how V moves: the companion modules' own state, read once per turn window.
        activity = function()
            local seats = {}
            local ok, snapshot = pcall(function() return convaiSeating and convaiSeating.snapshot() end)
            for _, row in ipairs(ok and snapshot and snapshot.companions or {}) do seats[row.serial] = row.phase end
            local info = companions.activityInputs(seats)
            -- The seats the party callback just read for spawned riders (our own copy of a profile keeps its own state).
            if type(info) == 'table' and type(info.rows) == 'table' then
                for key, seat in pairs(convaiSpawnedPeople and convaiSpawnedPeople.seats or {}) do
                    if info.rows[key] == nil then info.rows[key] = {mounted = {seat = seat}} end
                end
            end
            return info
        end}) or nil
    microphone.captureTurnContext = function() return convaiTurnContext and convaiTurnContext:capture() or nil end
    -- A group round with a character another mod or a spawner created in it needs a party row for that character: read it
    -- afresh rather than reuse a snapshot a private turn took a moment earlier (nothing else changes for other rounds).
    groupChat.onSpawned = function() if convaiTurnContext then convaiTurnContext:reset('group-spawned') end end
    -- A phone chat reads it once per message too (mod/phone-chat.lua, when the message is sent).
    phoneChat.captureTurnContext = microphone.captureTurnContext
end

-- entity: the addressed character's ID ("<hash>ULL") for a private conversation. A generic resident or archetype
-- has no connection without its body, so the bridge opens that NPC's own route while V types or speaks.
local function warmConversation(participants, key, entity)
    -- A holocall that rings or is connected keeps its caller's connection asked for (a closed text box or a cancelled
    -- recording would otherwise drop it), and marks the hint as a call, which the bridge opens at once even on a plan
    -- that pre-opens nothing (bridge/party-connections.mjs): the call rings until it is open (mod/holocall.lua).
    local call = not participants and convaiHolocall and convaiHolocall.call or nil
    if call and not key then key, entity = call.key, call.entity end
    call = call ~= nil and key == call.key
    local hint = '{}'
    -- An add-on voice never has a Convai connection to warm (docs/ADDON_API.md: Mistral or the local AI only). The hint still says a
    -- typed line may follow, so the bridge warms V's voice for it (docs/V_VOICE.md); it opens no connection for it.
    local voiceOnly = false
    if key and not participants and convaiAddons and convaiAddons.live and convaiAddons.isSpeaker(key) then key, voiceOnly = nil, true end
    if voiceOnly then hint = json.encode({nonce = 'composer-' .. tostring(os.time()) .. '-' .. tostring(generation), voiceOnly = true}) end
    if key then
        local audience = {}
        if participants then
            for _, person in ipairs(participants) do
                if not person.voiceOnly then audience[#audience + 1] = person.profileKey end
            end
            -- Generic people can share a profile; the hint's audience is a set of profiles.
            local listed, unique = {}, {}
            for _, key in ipairs(audience) do
                if not listed[key] then listed[key] = true; unique[#unique + 1] = key end
            end
            audience = unique
        else audience[1] = key end
        hint = json.encode({nonce = 'composer-' .. tostring(os.time()) .. '-' .. tostring(generation),
            audience = audience, group = participants ~= nil,
            entity = participants == nil and type(entity) == 'string' and entity or nil, call = call or nil})
    end
    -- In place, after the hint is built (the old code opened the temp file first so a failed open skipped the work).
    local f = io.open('runtime/conversation-prewarm.json', 'wb')
    if not f then return end
    f:write(hint); f:close()
end
warmConversation(nil, nil)

local lastPartyHint, lastPartyHeartbeat = nil, 0
-- The per-frame call re-derives the party's profile list (a table and a concat per frame). A change reaches the
-- bridge through companions.onPartyChanged (forced); this look only backs it up, so it runs every PARTY_LOOK
-- seconds of wall clock. A heartbeat refused its slot below retries on the next frame.
local PARTY_LOOK = 0.25
local partyLookAt, partyRetry = nil, false
local function publishPartyConnections(force)
    if not force and not partyRetry then
        local wall = os.clock()
        if partyLookAt and wall >= partyLookAt and wall - partyLookAt < PARTY_LOOK then return end
        partyLookAt = wall
    end
    partyRetry = false
    local keys, encoded = {}, {}
    for _, key in ipairs(companions.connectionProfiles()) do
        if manager.profileEnabled(key) then keys[#keys + 1] = key end
    end
    local signature, now = table.concat(keys, ','), os.time()
    if not force and signature == lastPartyHint and now - lastPartyHeartbeat < 2 then return end
    if not force and signature == lastPartyHint and not convaiHeartbeatSlot() then partyRetry = true; return end
    for _, key in ipairs(keys) do encoded[#encoded + 1] = json.encode(key) end
    -- In place (one open, not open+remove+rename): the bridge ignores a partial
    -- read (PartyConnections.ingest rejects it) and keeps the last snapshot.
    local f = io.open('runtime/party-connections.json', 'wb')
    if not f then return end
    local written = f:write('{"updated":' .. tostring(now * 1000) .. ',"profiles":[' .. table.concat(encoded, ',') .. ']}')
    if f:close() and written then lastPartyHint, lastPartyHeartbeat = signature, now end
end
companions.onPartyChanged = function() publishPartyConnections(true) end
publishPartyConnections(true)

-- probe.log is appended in batches (docs/PERFORMANCE_NATIVE_PLAN.md item 13): a CET io.open costs 1-3 ms of the game thread,
-- and it used to be paid per line. Lines wait in convaiLog and go out together
--   * at most one second after the first waiting line (convaiLogTick, from the top of onUpdate: one field read while empty),
--   * at once when 8 KB or 64 lines are waiting,
--   * at once for a line that reports a failure, an abandon or a shutdown (the lines a crash investigation reads first),
--   * before a world is abandoned (the native teardown that can take the game down), and in onShutdown (CET reload and exit).
-- Globals, so no function gains an upvalue. The console print stays immediate. Lines keep their own UTC stamps.
convaiLog = {lines = {}, n = 0, bytes = 0, at = 0}
convaiLogFlush = function()
    local state = convaiLog
    local count = state.n
    if count == 0 then return end
    local text = table.concat(state.lines, '', 1, count)
    for index = count, 1, -1 do state.lines[index] = nil end
    state.n, state.bytes = 0, 0
    local file = io.open('runtime/probe.log', 'a')
    if file then
        file:write(text)
        file:close()
    end
end
convaiLogTick = function()
    local state = convaiLog
    if state.n > 0 and os.clock() - state.at >= 1 then convaiLogFlush() end
end
-- probe.log only, no console line: for what a developer reads back from a report and a player has no use for in the CET console.
convaiLogFile = function(line)
    local state = convaiLog
    local entry = os.date('!%Y-%m-%dT%H:%M:%SZ') .. ' ' .. line .. '\n'
    local count = state.n + 1
    state.lines[count], state.n, state.bytes = entry, count, state.bytes + #entry
    if count == 1 then state.at = os.clock() end
    if count >= 64 or state.bytes >= 8192 or entry:find('[Ff]ail') or entry:find('[Ee]rror') or entry:find('[Aa]bandon')
        or entry:find('[Ss]hut') or entry:find('[Cc]rash') then convaiLogFlush() end
end
local function log(line)
    convaiLogFile(line)
    print('[CyberpunkConvai] ' .. line)
end
-- A failure that can come round again (every tick, every key press, every attempt) is one console and probe.log line per key and game
-- session: the first one. Later ones are counted, and probe.log (not the console) gets one "repeated N times" line at 10, 100, 1000 ...
-- so a failure that keeps happening can still be seen in a report. At most 64 keys are kept, so a message that varies cannot grow it.
-- A global, so no function gains an upvalue (the main chunk is near Lua's limit of locals).
convaiLogSeen = {n = 0}
convaiLogOnce = function(key, line)
    line = line or key
    local seen = convaiLogSeen
    local entry = seen[key]
    if not entry then
        if seen.n >= 64 then return false end
        seen[key], seen.n = {count = 1, next = 10}, seen.n + 1
        log(line)
        return true
    end
    entry.count = entry.count + 1
    if entry.count >= entry.next then
        entry.next = entry.next * 10
        convaiLogFile('(repeated ' .. entry.count .. ' times: ' .. tostring(line):sub(1, 160) .. ')')
    end
    return false
end
microphone.log = log
-- For the functions defined above this point (the Johnny services): a bare `log` there would be an undefined global.
convaiLogLine = log
-- A hook installer that raises must not stop onInit: every line after it (the Native Settings UI registration among them) would
-- never run, and a player whose scripts did not compile (the hooks below name methods those scripts add) would see nothing of this
-- mod at all. One failure line per installer, once per load. A global, so onInit gains no upvalue.
convaiGuarded = function(label, fn, ...)
    local ok, result = pcall(fn, ...)
    if not ok then log(label .. ' failed: ' .. tostring(result)) end
    return ok, result
end
-- A talk start whose speaker's face will not move: one line with the status (Face.reds ConvaiFaceRequest), what it means, and the
-- facts that name a replaced model (kind, record, appearance, entity template, face graph and rig, the mod's own graphs). A speaking
-- face ("prepared:...") writes nothing. Called once per talk start (text, voice, group speaker), never per frame.
function convaiFaceRequestLog(actor, identity, ok, status)
    local facial = convaiFacialPlayback
    -- Once per session, at the first talk start: the state of the mod's own face graphs (13 loaded when convai_facial.archive is mounted).
    if not convaiFaceGraphsNoted and type(facial) == 'table' and type(facial.graphReport) == 'function' then
        convaiFaceGraphsNoted = true
        local reported, report = pcall(facial.graphReport)
        log('Face graphs: ' .. (reported and tostring(report) or ('not readable (' .. tostring(report) .. ')')))
    end
    if type(facial) == 'table' and type(facial.faceNeedsLine) == 'function' then
        if not facial.faceNeedsLine(ok, status) then return end
    elseif ok and (status == 'managed' or tostring(status):find('^prepared')) then
        return
    end
    local note = ''
    if type(facial) == 'table' and type(facial.faceNote) == 'function' then
        local noted, text = pcall(facial.faceNote, ok and actor or nil, status)
        if noted and type(text) == 'string' then note = text end
    end
    log('Face request: actor=' .. tostring(identity) .. ' status=' .. tostring(status) .. note)
end
-- On-demand Lua heap report (mod/lua-heap-probe.lua writes runtime/lua-heap.json): runs once per 'lua-heap:<nonce>' request in
-- the developer mailbox (scripts/Request-LuaHeap.ps1), never per frame, and the probe file is not kept loaded. The roots are the
-- tables this file keeps only as locals; the probe adds the mod's convai* globals. A global, so onUpdate gains no upvalue.
do
    local loadedAt = os.time()
    convaiLuaHeapReport = function(nonce)
        local loaded, probe = pcall(dofile, 'lua-heap-probe.lua')
        if not loaded or type(probe) ~= 'table' or type(probe.run) ~= 'function' then
            log('Lua heap report failed to load: ' .. tostring(probe))
            return false
        end
        local roots = {{'profiles', profiles}, {'catalog', catalog}, {'archetypes', archetypes},
            {'supportedProfiles', supportedProfiles}, {'companions', companions}, {'manager', manager},
            {'speech', speech}, {'subtitles', subtitles}, {'microphone', microphone}, {'groupChat', groupChat},
            {'phoneChat', phoneChat}, {'questContext', questContext}, {'battles', battles}, {'tactics', tactics},
            {'relationshipState', relationshipState}, {'worldKnowledge', worldKnowledge}, {'journalHistory', journalHistory},
            {'movementLog', movementLog}, {'characterCatalog', characterCatalog}, {'invitations', invitations}}
        local ok, report = pcall(probe.run, {nonce = nonce, roots = roots, environment = _G, loadedAt = loadedAt,
            sentinel = companions})
        if not ok or type(report) ~= 'table' then
            log('Lua heap report failed: ' .. tostring(report))
            return false
        end
        local function mb(kb) return type(kb) == 'number' and string.format('%.1f MB', kb / 1024) or '-' end
        log('Lua heap: ' .. mb(report.heapBeforeKB) .. ' before, ' .. mb(report.heapAfterKB) .. ' after a full collect ('
            .. string.format('%.0f ms', report.collectMs or 0) .. '); this mod about ' .. mb(report.modKB) .. '; loads alive '
            .. tostring(report.loadsAlive or '-') .. ' (runtime/lua-heap.json)')
        return true
    end
end
-- Names for nameless ordinary NPCs (docs/NPC_NAMES.md, mod/npc-names.lua). One generator serves the scanner and the talk path.
-- The gate is the rule above: not ours, not protected (named, quest-bound, story record), a resolved ordinary profile (an archetype
-- or the two residents), an adult human. Read on demand (a scan, a conversation start), never per frame.
do
    local loaded, module = pcall(dofile, 'npc-names.lua')
    if loaded and type(module) == 'table' and type(module.new) == 'function' then
        local built, service = pcall(module.new, {
            entity = function(npc)
                local ok, id = pcall(function() return tostring(npc:GetEntityID().hash) end)
                return ok and id or nil
            end,
            inCombat = function(npc)
                local ok, fighting = pcall(function() return NPCPuppet.IsInCombat(npc) end)
                return ok and fighting == true
            end,
            inspect = function(npc)
                return module.ordinary({
                    ours = convaiWorldPolicy.ours, protected = convaiWorldPolicy.protected,
                    identify = function(target)
                        local key, _, body, archetype = profileIdentity(target, true)
                        local idOk, entity = pcall(function() return tostring(target:GetEntityID().hash) end)
                        return key, archetype, archetypeFacts(target, idOk and entity or nil, body)
                    end,
                    ordinaryKey = function(key) return archetypes.keys[key] ~= nil or key == 'resident-male' or key == 'resident-female' end,
                    gender = function(facts) return type(characterCatalog.gender) == 'function' and characterCatalog.gender(facts) or nil end,
                    appearance = function(target)
                        local ok, appearance = pcall(function() return nameString(target:GetCurrentAppearanceName()) end)
                        return ok and appearance or nil
                    end,
                }, npc)
            end,
            apply = function(npc, name)
                local ok, applied = pcall(function() return npc:ConvaiApplyScannerName(name) end)
                return ok and applied == true
            end,
            log = function(line) log(line) end,
        })
        if built then convaiNpcNames = service else log('NPC names unavailable: ' .. tostring(service)) end
    end
end

-- Managed companions crouch and stand with V (mod/companion-stance.lua). The hook is installed in onInit.
local stanceModule, stanceBuilt = nil, nil
do
    local loaded, module = pcall(dofile, 'companion-stance.lua')
    if loaded and type(module) == 'table' then
        local built, value = pcall(module.new, {log = log})
        if built and type(value) == 'table' then stanceModule, stanceBuilt = module, value; companions.stance = value
        else log('Companion stance unavailable: ' .. tostring(value)) end
    else log('Companion stance unavailable: ' .. tostring(module)) end
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
if convaiTurnContext then convaiTurnContext.options.log = log end
-- Continue from game dialogue: one line the first time each of its four hooks fires in a session (mod/game-dialogue.lua).
if gameDialogue then gameDialogue.options.log = log end
if convaiWitnessReceipts then convaiWitnessReceipts.options.log = log end
-- Doors, lifts, fast travel and stranded followers: one line per recovery
-- decision (companions.lua note(), throttled per kind; never per frame).
companions.developerMode = function() return manager.developerMode() end
companions.recoveryLog = function(kind, fields)
    local ok, text = pcall(json.encode, fields or {})
    log('Companion recovery ' .. tostring(kind) .. ' ' .. (ok and text or ''))
end
-- Every place the mod puts a companion's feet somewhere (AI teleport, lift carry, vehicle exit
-- placement) reports here with its reason, so no move of her can go unlogged (live 2026-10-13:
-- "teleported" with no relocation line). Rare events, never per frame.
convaiTeleportLog = function(fields)
    local ok, text = pcall(json.encode, fields or {})
    log('Companion teleport ' .. (ok and text or ''))
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
            party = function() return managerUi.party and managerUi.party() or nil end,
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
    local spawnedLost, rosterNoted, rosterNotedCount = {}, {}, 0
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
        local rows, seen, spawnedSeen = {}, {}, {}
        for _, part in ipairs(parts or {}) do
            local component = TS_TargetPartInfo.GetComponent(part)
            local entity = component and component:GetEntity()
            if entity and entity:IsNPC() and entity:IsAttached() and not entity:IsDeadNoStatPool()
                and not companions.owns(entity) and not (adoption and adoption.hidden(entity)) then
                local id = tostring(entity:GetEntityID().hash)
                if not seen[id] then
                    seen[id] = true
                    local key, name = profileIdentity(entity)
                    local named = key ~= nil and convaiSpawnedPeople ~= nil and convaiSpawnedPeople.named(key)
                    if key and supportedProfiles[key] and manager.profileEnabled(key) then
                        local position = entity:GetWorldPosition()
                        -- A roster character another mod or a spawner created gets its own warm place (auto-connect.lua `spawned`);
                        -- the classification is cached per entity (spawned-characters.lua), so this adds no query to the scan.
                        local spawned = convaiSpawnedPeople ~= nil and convaiSpawnedPeople.named(key)
                            and convaiWorldPolicy ~= nil and convaiWorldPolicy.spawned(entity) == true
                        -- Once per entity: a roster character counted as the game's own (not spawned), with what decided it, so a
                        -- follower that should have joined the lane (Rita, 2026-10-18) shows its record and managed answer in the log.
                        if named and not spawned and not rosterNoted[id] then
                            if rosterNotedCount >= 64 then rosterNoted, rosterNotedCount = {}, 0 end
                            rosterNoted[id], rosterNotedCount = true, rosterNotedCount + 1
                            pcall(function()
                                local system = Game.GetDynamicEntitySystem()
                                log('Roster character counted as game-placed: ' .. key .. ' entity=' .. id .. ' record='
                                    .. tostring(TDBID.ToStringDEBUG(entity:GetRecordID())) .. ' managed='
                                    .. tostring(system ~= nil and system:IsManaged(entity:GetEntityID())))
                            end)
                        end
                        -- Any spawned character seen here is remembered by its ID (spawned-characters.lua remember): the query only
                        -- reports what the camera sees, and the lane and the group key press must still know the ones behind V.
                        if convaiSpawnedCharacters ~= nil and (spawned or (not named and convaiSpawnedCharacters:is(entity) == true)) then
                            spawnedSeen[#spawnedSeen + 1] = {id = entity:GetEntityID(), entity = id, key = key, name = name}
                        end
                        rows[#rows + 1] = {key = key, name = name, entity = id, spawned = spawned or nil,
                            distance = math.sqrt((position.x - origin.x)^2 + (position.y - origin.y)^2 + (position.z - origin.z)^2)}
                    end
                end
            end
        end
        -- Spawned roster characters this scan did not report (behind V, outside the view) but that are still here, within the
        -- group chat range: the same lane, so a connection is not dropped because V looked the other way. One lookup per
        -- remembered character, in this once-a-second scan only (spawned-characters.lua recall).
        local service = convaiSpawnedCharacters
        if service ~= nil then
            if #spawnedSeen > 0 then pcall(service.remember, service, spawnedSeen) end
            local good, recalled, dropped = pcall(service.recall, service, player, convaiSpawnedRange, seen, function(entry)
                return entry.key ~= nil and convaiSpawnedPeople ~= nil and convaiSpawnedPeople.named(entry.key)
            end)
            -- Why a remembered spawned character is not counted (gone, detached, out of range ...), logged when the reason changes.
            for _, item in ipairs(good and type(dropped) == 'table' and dropped or {}) do
                if spawnedLost[item.entity] ~= item.reason then
                    spawnedLost[item.entity] = item.reason
                    log('Spawned character not counted: ' .. tostring(item.key or item.entity) .. ' ' .. tostring(item.reason)
                        .. (type(item.distance) == 'number' and string.format(' d=%.1f', item.distance) or ''))
                end
            end
            for _, row in ipairs(good and recalled or {}) do
                spawnedLost[row.entity] = nil
                if supportedProfiles[row.key] and manager.profileEnabled(row.key) then
                    rows[#rows + 1] = {key = row.key, name = row.name or row.key, entity = row.entity, spawned = true, distance = row.distance}
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
            -- A partner that is a spawned roster character (another mod): when it stops being a partner while it still stands
            -- near V it goes back to the spawned lane with its connection open (auto-connect.lua backToLane). The entity was
            -- read at the conversation; the classification is cached.
            spawned = function(partner)
                if convaiSpawnedPeople == nil or not convaiSpawnedPeople.named(partner.key) then return false end
                local service = convaiSpawnedCharacters
                if service ~= nil and type(partner.id) == 'string' and service.knownBy[partner.id] ~= nil then return true end
                return partner.entity ~= nil and convaiWorldPolicy ~= nil and convaiWorldPolicy.spawned(partner.entity) == true
            end,
            -- Every speaker of a running group round counts as an exchange for a partner (convaiRoundKeys).
            roundKeys = function() return convaiRoundKeys() end,
            -- Mistral, the local AI or a custom OpenAI-compatible endpoint answers turns: no Convai connection is opened or waited for,
            -- so no "Preparing connection" notice. The bridge's applied provider (runtime/mistral-state.json, read at most every 1.5 s),
            -- asked only on a talk start.
            noConnection = function()
                local ok, state = pcall(manager.mistral)
                return ok and type(state) == 'table' and (state.effective == 'mistral' or state.effective == 'local' or state.effective == 'custom')
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
        -- Group rounds: the other members listen (nod now and then, keep the stance) while one speaks.
        group = function(entity) return groupChat.roleOf(entity) end,
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
        -- The gesture catalogue (1.4 MB of generated Lua) is compiled and held once, shared with the gesture controller.
        catalog = controller and type(controller.catalog) == 'table' and controller.catalog or nil,
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
    -- The native candidates of this key press, for a group round to count spawned characters among (selectConversation).
    convaiTalkNative = candidates
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
    -- turned toward V or have their barks muted. A named or story character of the game is left untouched, even when V
    -- talks to it (docs/WORLD_CHARACTERS.md): it keeps its own gaze, pose and barks, and only its voice and face are driven.
    if convaiWorldPolicy ~= nil and convaiWorldPolicy.story(npc) == true then return false, 'story character: voice and face only' end
    if not companions.owns(npc) and not (profileIdentity(npc)) then return false, 'not ours and not a conversation' end
    -- Owned companions arbitrate attention against locomotion themselves.
    -- The civilian path can add a second hold/turn independently of that state.
    local quiet = convaiVanillaReactions
    if companions.owns(npc) then
        if quiet then pcall(quiet.focus, npc, 'focus') end
        return true
    end
    -- Another mod's character (docs/SPAWNED_CHARACTERS.md) keeps its own AI: eye contact only, no hold, turn or chest twist,
    -- so its follow and pose commands are never fought.
    local policy = convaiWorldPolicy
    local keepAI = policy ~= nil and policy.spawned(npc) == true
    local ok, focused = pcall(function()
        if keepAI then return player:ConvaiBeginFocus(npc, true) end
        return player:ConvaiBeginFocus(npc)
    end)
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

-- UI_System.IsInMenu. The blackboard definition and its id are script constants (the blackboard is found by
-- that id on every read), so they are read once, not with GetAllBlackboardDefs and two property reads per call.
-- A global, so onUpdate's closure gains no upvalue.
convaiInMenu = function()
    local cache = convaiHeartbeat
    if not cache.menuDefinition then
        local definition = Game.GetAllBlackboardDefs().UI_System
        cache.menuFlag, cache.menuDefinition = definition.IsInMenu, definition
    end
    return Game.GetBlackboardSystem():Get(cache.menuDefinition):GetBool(cache.menuFlag)
end

local function gameplayCanAcquire(player)
    local ok, inMenu = pcall(convaiInMenu)
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
    gazePoll = gazePoll + elapsed
    if gazePoll < 0.2 then return end
    local step = gazePoll
    gazePoll = 0
    local canFocus = gameplayCanAcquire(player)
    local npc, identity
    local lookKey, lookEntity, lookName, lookSpawned
    if canFocus then
        local found, result = pcall(targetAtCrosshair)
        if found and result then
            local key, canonical = profileIdentity(result)
            if key and supportedProfiles[key] and manager.profileEnabled(key) and not companions.owns(result) then
                lookKey, lookName, lookEntity = key, canonical, tostring(result:GetEntityID().hash)
                -- The cached classification (spawned-characters.lua): a roster character another mod made is wanted for the spawned
                -- lane by the gaze too, since the scan that says so runs only once a second (it put Rita in a slot, 2026-10-18).
                lookSpawned = convaiSpawnedCharacters ~= nil and convaiSpawnedPeople ~= nil and convaiSpawnedPeople.named(key)
                    and convaiSpawnedCharacters:is(result) == true
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
    if autoConnect then pcall(autoConnect.look, lookKey, lookEntity, lookName, step, lookSpawned) end
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

-- A character in V's own car, or one of V's companions (key press only: it walks the few managed companions).
local function companionOrPassenger(player, npc)
    if type(companions.owns) == 'function' and companions.owns(npc) == true then return true end
    local ok, id = pcall(function() return tostring(npc:GetEntityID().hash) end)
    if not ok then return false end
    for _, seat in ipairs(companions.seatedCandidates(player)) do
        local same, seatId = pcall(function() return tostring(seat:GetEntityID().hash) end)
        if same and seatId == id then return true end
    end
    return false
end

-- The character V faces, for the character editor's "Use the character I'm facing" (mod/character-editor.lua): {record, name, gender}, or nil.
-- One targeting query, asked once when the player chooses Settings > Edit characters > Open: never per frame and never on a timer. It is only
-- text for a form: nothing is stored, and it leaves the game as part of the command file the editor opens with.
function convaiFacingCharacter()
    local found, npc = pcall(targetAtCrosshair)
    if not found or not npc then return nil end
    local function read(fn)
        local ok, value = pcall(fn)
        if ok and type(value) == 'string' and value ~= '' and value ~= 'None' then return value end
        return nil
    end
    local debugName = read(function() return TDBID.ToStringDEBUG(npc:GetRecordID()) end)
    -- The original of a record-cloning mod's copy ("NCA.Character.X" is "Character.X": the editor's rule finds both), else the readable name.
    local record = debugName and (characterCatalog.originalRecordName(debugName)
        or (debugName:find('^[%w_][%w_%.%-]+$') and debugName or nil)) or nil
    local name = read(function() return tostring(npc:GetTweakDBFullDisplayName(true) or '') end)
    local body = read(function() return tostring(npc:GetBodyType() or '') end)
    local gender = type(characterCatalog.gender) == 'function'
        and characterCatalog.gender({gender = read(function() return nameString(npc:GetResolvedGenderName()) end), bodyType = body}) or nil
    if not record and not name then return nil end
    return {record = record, name = name, gender = gender == 'FEMALE' and 'female' or gender == 'MALE' and 'male' or nil}
end

-- addonHears: this computer can recognise speech locally (manager.speechRecognitionReady), which an add-on voice needs to answer the
-- voice keys; the caller asks it on the key press only, and only while an add-on is live.
local function selectConversation(player, groupMode, singleAction, addonHears)
    -- A character the player made may have been saved since the last look: the list is read if it is due (at most every 3 s, and only while
    -- there are characters or the editor was opened lately: mod/custom-characters.lua).
    if convaiCustomCharacters then pcall(convaiCustomCharacters.refresh); pcall(convaiCustomCharacters.checkProvider) end
    -- On a connected holocall the private talk keys address the caller wherever V is (mod/holocall.lua).
    local caller = convaiHolocall and convaiHolocall.partner(player, groupMode) or nil
    if caller then log('Holocall conversation: profile=' .. caller.profileKey .. ' mode=' .. caller.holocall.mode); return caller end
    local npc, reason, decision = targetAtCrosshair()
    logTalkTarget(decision)
    if convaiSpawnedPeople then convaiSpawnedPeople.noteNative(convaiTalkNative) end
    -- A story character of the game takes private talk only (docs/WORLD_CHARACTERS.md): aimed at with a group key it is not a
    -- member of the round, which is then built from the characters with V, as when V aims at nothing.
    if groupMode and npc and convaiWorldPolicy ~= nil and convaiWorldPolicy.story(npc) == true then
        npc, reason = nil, 'Group chat needs two characters nearby. Use private chat for one person.'
    end
    local candidates = groupMode and companions.conversationCandidates(player, 8) or {}
    if groupMode then
        local enabled = {}
        for _, candidate in ipairs(candidates) do
            if profileEnabled(player, candidate.profileKey) then enabled[#enabled + 1] = candidate end
        end
        candidates = enabled
        -- Characters another mod or a spawner created join after V's own companions (docs/SPAWNED_CHARACTERS.md, phase 2):
        -- one targeting query on this key press, and none once three companions already fill the round.
        -- Whoever V faces (a companion or a spawned character), the same rule: every spawned character within group range that
        -- this key press can find: the scan's answer, the native candidates this key press already gathered, and the characters
        -- remembered by entity ID from earlier queries (the queries report only what the camera sees, so one behind V or outside
        -- the aim cone is found from memory). The log line says how each was found and why any was left out.
        local companionCount = #candidates
        if companionCount < 3 and convaiSpawnedPeople then
            for _, row in ipairs(convaiSpawnedPeople.nearby(player, 8, {extra = convaiTalkNative})) do candidates[#candidates + 1] = row end
            local stats = convaiSpawnedPeople.stats or {}
            log('Group candidates: companions=' .. companionCount .. ' spawned=' .. (#candidates - companionCount)
                .. ' (found=' .. tostring(stats.found) .. ' generic=' .. tostring(stats.generic) .. ' noProfile=' .. tostring(stats.noProfile)
                .. ' unsupported=' .. tostring(stats.unsupported) .. ' disabled=' .. tostring(stats.disabled) .. ')'
                .. convaiSpawnedPeople.describe())
        end
    end
    -- An installed add-on's voice (docs/ADDON_API.md: a talking gun in V's hand, a cab's voice) answers the talk keys while it
    -- is available and no character with a profile is under the crosshair; in a group it joins the nearby companions.
    local voices = convaiAddons and convaiAddons.live and convaiAddons.talkCandidates(player, groupMode) or nil
    -- An add-on voice hears V through the bridge's local speech recognition (its answer comes from Mistral or the local AI, never
    -- Convai). On a computer without it the voice keys leave add-on voices out and they answer typed messages only.
    if voices and voices[1] and singleAction == 'cyberpunk_convai_voice' and not addonHears then
        local aimed = npc and profileIdentity(npc)
        if not groupMode and (not aimed or not supportedProfiles[aimed] or not profileEnabled(player, aimed)) then
            local shortcut = ui.boundKey('cyberpunk_convai_text')
            convaiNotices.send(player, 'addon-notice', shortcut
                and ui.t('{name} answers typed messages only for now. Use {key}.', {name = voices[1].name, key = shortcut})
                or ui.t('{name} answers typed messages only for now.', {name = voices[1].name}))
            return nil
        end
        voices = nil
    end
    if voices and voices[1] then
        if groupMode then for _, voice in ipairs(voices) do candidates[#candidates + 1] = voice end end
        local aimed = npc and profileIdentity(npc)
        local characterAimed = aimed and supportedProfiles[aimed] and profileEnabled(player, aimed)
        -- V sits in the vehicle a voice is anchored to (a cab's AI): only a character in that car with V, or one of V's companions,
        -- takes the key from it. A pedestrian drifting through the windscreen's cone does not (resolved here, on the key press).
        if characterAimed and voices[1].vehicle and not companionOrPassenger(player, npc) then characterAimed = false end
        if not characterAimed then
            local voice = voices[1]
            local together = groupMode and groupChat.choose(voice, candidates, supportedProfiles) or nil
            if together and #together < 2 then
                local shortcut = ui.boundKey(singleAction)
                convaiNotices.send(player, 'group-needs-two', shortcut
                    and ui.t('Group chat needs two characters nearby. Use {key} for one person.', {key = shortcut})
                    or ui.t('Group chat needs two characters nearby. Use private chat for one person.'))
                return nil
            end
            log('Add-on voice conversation: profile=' .. voice.profileKey)
            return voice, together
        end
    end
    if not npc and groupMode and candidates[1] and not candidates[1].voiceOnly then npc = candidates[1].npc end
    -- Johnny in your head (docs/JOHNNY_IN_YOUR_HEAD.md): with nobody in front of V, private talk addresses Johnny while the story has
    -- him in V's head and the game does not have the floor. Not in V's head (or the setting off): the notice below, as before.
    if not npc and not groupMode then
        local head = type(convaiJohnnyHeadService) == 'function' and convaiJohnnyHeadService() or nil
        local why = head and head:refusal(player) or nil
        if head and why == nil and supportedProfiles[head.key] and profileEnabled(player, head.key) then
            local partner = head:partner(player)
            if partner then
                convaiHeadTalk = {entity = partner.entity}
                log('Johnny in your head: conversation stage=' .. tostring(partner.head.stage))
                return partner
            end
        elseif head and why ~= nil and why ~= 'before' and why ~= 'after' and why ~= 'unreadable' then
            log('Johnny in your head: refused reason=' .. why)
            convaiNotices.send(player, 'talk-busy', ui.t('{name} is busy right now.', {name = head.name}))
            return nil
        elseif head then
            log('Johnny in your head: not in V\'s head (' .. tostring(why or 'muted') .. ')')
        end
    end
    if not npc then convaiNotices.send(player, 'talk-no-target', ui.t(reason)); return nil end
    if convaiCustomCharacters then convaiCustomCharacters.clearSkipped() end
    local key, name, bodyType, archetype = profileIdentity(npc)
    -- One of the player's own characters, left out because Convai is answering: it talks as an ordinary person, and the player is told once.
    local skipped = convaiCustomCharacters and convaiCustomCharacters.takeSkipped() or nil
    if skipped then
        convaiCustomNoted = convaiCustomNoted or {}
        if not convaiCustomNoted[skipped.key] then
            convaiCustomNoted[skipped.key] = true
            convaiNotices.send(player, 'custom-needs-provider',
                ui.t('{name} is one of your own characters. They need Mistral or Local AI, so with Convai they talk as an ordinary person.', {name = skipped.name}))
        end
    end
    if not key or not supportedProfiles[key] then
        convaiNotices.send(player, 'talk-no-profile', ui.t('{name} does not have a conversation profile configured yet.',{name=name}))
        log('Conversation unavailable: profile=' .. tostring(key))
        return nil
    end
    if not profileEnabled(player, key) then log('Companion disabled in manager: ' .. name); return nil end
    local primary = {npc = npc, name = name, entity = tostring(npc:GetEntityID().hash), bodyType = bodyType, profileKey = key,
        spawned = convaiWorldPolicy ~= nil and convaiWorldPolicy.spawned(npc) or nil}
    -- A named character of the game (docs/WORLD_CHARACTERS.md) is talked to only while the game is not in charge of it: not in a
    -- scene or quest dialogue, not while V is in a quest conversation, not under a scene's or quest's AI, in a fight, hurt or
    -- riding. Read fresh on this key press; the same test then guards the recording and the reply. Nothing of the character
    -- is touched: a refusal is a notice and a log line.
    primary.story = convaiWorldPolicy ~= nil and convaiWorldPolicy.story(npc) == true or nil
    convaiStory = primary.story and {entity = primary.entity, key = key, name = name} or nil
    -- The face writer then judges this one speaker by the story rules (no scene flag: it stays true in ordinary gameplay).
    if convaiFacialPlayback then convaiFacialPlayback.storyEntity = convaiStory and convaiStory.entity or nil end
    if primary.story then
        local why = convaiWorldTalk:refusal(npc, player)
        if why then
            convaiStory = nil
            log('World conversation refused: profile=' .. key .. ' reason=' .. why
                .. (convaiWorldTalk.detail and (' (' .. convaiWorldTalk.detail .. ')') or ''))
            convaiNotices.send(player, 'talk-busy', ui.t('{name} is busy right now.', {name = name}))
            return nil
        end
        log('World conversation: profile=' .. key .. ' (voice and face only)')
    end
    -- A spawned character V talks to is remembered by its ID (key press only), so a later group round counts it wherever V faces.
    if primary.spawned and convaiSpawnedCharacters ~= nil then
        pcall(convaiSpawnedCharacters.remember, convaiSpawnedCharacters, {{id = npc:GetEntityID(), entity = primary.entity, key = key, name = name}})
    end
    -- An archetype or resident learns which kind of NPC it is and where it stands
    -- (a summoned archetype copy from its profile key alone).
    if not archetype and archetypes.keys[key] and type(characterCatalog.describe) == 'function' then
        archetype = characterCatalog.describe(archetypes, key, {})
    end
    if archetype or key == 'resident-male' or key == 'resident-female' then
        primary.generic = true
        primary.archetype = archetype or {category = 'resident'}
        local place = currentDistrict()
        if place then primary.archetype.district, primary.archetype.area = place.district, place.area end
        -- A nameless ordinary NPC gets its Night City name (the same one the scanner shows); the caption, the composer and the
        -- bridge's "Your name is ..." line use it. Nil with the setting off or for anyone the gate refuses.
        local generated = convaiNpcNames and convaiNpcNames.nameFor(npc, 'talk') or nil
        if generated then primary.name, primary.archetype.npcName = generated, generated end
        log('Archetype conversation: profile=' .. key .. ' base=' .. tostring(primary.archetype.base)
            .. ' district=' .. tostring(primary.archetype.district))
    end
    local participants = groupMode and groupChat.choose(primary, candidates, supportedProfiles) or nil
    -- A generic spawned person in the round learns where it stands and gets its Night City name, like a generic primary.
    for _, person in ipairs(participants or {}) do
        if person ~= primary and person.spawned and person.generic then
            person.archetype = person.archetype or {category = 'resident'}
            local place = currentDistrict()
            if place then person.archetype.district, person.archetype.area = place.district, place.area end
            local generated = convaiNpcNames and convaiNpcNames.nameFor(person.npc, 'talk') or nil
            if generated then person.name, person.archetype.npcName = generated, generated end
        end
    end
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

-- An add-on speaker's context blocks go with its spoken turn, as they do with a typed one (sendRequest).
microphone.decorate = function(context)
    if context.voiceOnly and not context.holocall and convaiAddons and convaiAddons.live then convaiAddons.decorate(context) end
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
    if context.holocall and convaiHolocall then convaiHolocall.touch() end
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
    convaiLogOnce('Conversation service unavailable: ' .. tostring(kind))
    return true
end

-- The text box is where a typed message can vanish without a trace: the box closes (Esc, Enter on an empty box, the game closing it),
-- its words arrive after their owner is gone, or the request cannot be written. Every such end is one probe.log line, and the ones
-- where V has probably lost words also get one notice ('message-lost'). A global table, so onUpdate reaches it without a new upvalue.
-- It runs when a box opens or closes and when a message is dropped, never per frame.
convaiComposerWatch = {}
function convaiComposerWatch.opened(generation)
    convaiComposerWatch.generation, convaiComposerWatch.openedAt = generation, os.time()
end
function convaiComposerWatch.notify(player)
    convaiNotices.send(player, 'message-lost', ui.t('Your message was not sent. Open the text box again and retype it.'))
end
-- The box closed and nothing was taken from it. `result` is how the game says it closed (Composer.reds ConvaiComposerClosedInfo):
-- an Enter on an empty box and a close without a result are the cases where V believes a message was sent.
function convaiComposerWatch.closed(player, context)
    local ok, info = pcall(function() return player:ConvaiComposerClosedInfo() end)
    local result = ok and type(info) == 'string' and info ~= '' and info or 'unknown'
    local opened = convaiComposerWatch.generation == context.generation and convaiComposerWatch.openedAt or nil
    log('Composer closed without a message: generation=' .. tostring(context.generation) .. ' result=' .. result
        .. (opened and (' open=' .. math.floor(os.time() - opened) .. 's') or ''))
    if result == 'empty' or result == 'nodata' then convaiComposerWatch.notify(player) end
end
-- A message that was typed and then dropped on this side (`why` names the cause).
function convaiComposerWatch.lost(player, why, context)
    log('Message lost: ' .. why .. (context and (' generation=' .. tostring(context.generation)) or ''))
    convaiComposerWatch.notify(player)
end

-- The scripts refused to open the text box: it is Codeware's (Composer.reds answers false when they were compiled without its UI
-- part). One probe.log line per game session, with what is known of the requirement; and the player is told each time the talk key
-- is pressed, in the words of the setup check (a key press, never per frame). A global, so nothing gains an upvalue.
convaiComposerRefused = function(player)
    local beat, check = convaiHeartbeat, convaiSetupCheck
    local known, text = false, nil
    if type(check) == 'table' and type(check.requirement) == 'function' then
        known = select(2, pcall(check.requirement, 'codeware-ui', player)) == false
        if known and type(check.codewareNotice) == 'function' then text = select(2, pcall(check.codewareNotice)) end
    end
    if not beat.composerRefusedLogged then
        beat.composerRefusedLogged = true
        log(known and 'Native composer unavailable: these scripts were compiled without the UI part of Codeware (Codeware missing or too old)'
            or 'Native composer unavailable (check redscript and Codeware)')
    end
    if type(text) == 'string' and text ~= '' then convaiNotices.send(player, 'setup-problem', text) end
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
        -- A character that is not connected yet makes V wait: say so (mod/auto-connect.lua). An add-on voice has no connection; Johnny in
        -- V's head has his own.
        local connectNote = autoConnect and not participants and (not primary.voiceOnly or primary.head) and autoConnect.talkNotice(key, name) or nil
        generation = generation + 1
        local speedAtOpen = playerSpeedText(player)
        local moveAtOpen = moveStateText(player)
        if not player:ConvaiOpenComposer(name) then
            convaiComposerRefused(player)
            return
        end
        cancelAutomatic('manual-text')
        gameplayActions.revoke('new-conversation')
        speech.stop('new-conversation')
        microphone.cancel()
        groupChat.cancel()
        subtitles.clear()
        speech.target = npc
        -- An ordinary world NPC's face carries the gated speech layer from its spawn (Face.reds OnWorldInitialize); ConvaiFaceRequest reports it and runs the talk-time guards. An add-on's voice has no face or gaze.
        if not primary.voiceOnly then
            local faceOk, faceStatus = pcall(function() return npc:ConvaiFaceRequest() end)
            convaiFaceRequestLog(npc, identity, faceOk, faceStatus)
            -- A holocall's live-picture copy is far away and held still: it never turns to V.
            if focusEntity ~= identity and not primary.holocall and not primary.story then
                local focused, reason = beginFocus(player, npc)
                if not focused then
                    log('NPC focus unavailable: ' .. tostring(reason))
                else
                    focusEntity = identity
                end
            end
        end
        focusMode = 'chat'
        resetGaze()
        focusUntil = os.time() + 45
        active = {generation = generation, entity = identity, name = name, bodyType = bodyType,
            profileKey = key, participants = participants, archetype = primary.archetype, voiceOnly = primary.voiceOnly,
            holocall = primary.holocall, head = primary.head}
        warmConversation(participants, key, identity)
        convaiDemandKnowledge() -- fresh world and journal by the time V sends
        if connectNote then convaiNotices.send(player, 'talk-connecting', connectNote) end
        pending = nil
        convaiComposerWatch.opened(generation)
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

-- source: 'press' (the key went down: begin, or finish a recording) or 'release' (the key came back up after a hold: finish only).
local function toggleVoice(groupMode, source)
    source = source or 'press'
    local player = Game.GetPlayer()
    if not player then return end
    local ok, err = pcall(function()
        local mode = groupMode and 'group' or 'private'
        if microphone.context then
            local recordingMode = microphone.context.group and 'group' or 'private'
            if recordingMode ~= mode then
                if source == 'release' then return end
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
            if source == 'release' then
                -- A held key that began this recording ends it when let go. Anything else about the recording is left alone.
                if press == 'finish' and gameplayCanAcquire(player) and not (microphone.targetValid and not microphone.targetValid(microphone.context)) then
                    acceptVoiceSubmission(microphone.finish(mode, 'release'))
                end
                return
            end
            if press ~= 'retry' then
                -- Spamming the key is safe: a press while the device is still opening, right after
                -- "Listening", or while a reply is on its way changes nothing (mod/microphone.lua press).
                if press == 'connecting' then
                    convaiNotices.send(player, 'mic-connecting', ui.t('Connecting microphone - wait for Listening'))
                elseif press == 'finish' then
                    if not gameplayCanAcquire(player) or (microphone.targetValid and not microphone.targetValid(microphone.context)) then
                        cancelVoice('microphone-unavailable'); return
                    end
                    acceptVoiceSubmission(microphone.finish(mode, 'press'))
                end
                return
            end
            -- The reply is overdue: drop it and fall through to begin a fresh recording.
            cancelVoice('voice-retry')
        end
        if source == 'release' then return end
        -- Mistral cannot take a spoken message until this computer can recognise speech: say so instead of recording into nothing. One cheap
        -- boolean, asked only here, when the voice key is pressed.
        if manager.voiceNeedsConvai() then
            convaiNotices.send(player, 'voice-needs-convai',
                ui.t('Speaking to companions needs Convai for now. Set Conversation provider to Convai free tier in Settings > Conversation provider, or type your message.'))
            return
        end
        if not gameplayCanAcquire(player) then return end
        local addonHears = convaiAddons ~= nil and convaiAddons.live == true and manager.speechRecognitionReady() or false
        local primary, participants = selectConversation(player, groupMode, 'cyberpunk_convai_voice', addonHears)
        if not primary then return end
        if conversationServiceBlocked(player) then return end
        local npc, key, name, body, entity = primary.npc, primary.profileKey, primary.name, primary.bodyType, primary.entity
        local connectNote = autoConnect and not participants and autoConnect.talkNotice(key, name) or nil
        generation = generation + 1
        cancelAutomatic('microphone')
        gameplayActions.revoke('new-conversation')
        microphone.cancel('new-conversation')
        groupChat.cancel()
        warmConversation(participants, key, entity)
        speech.stop('microphone'); subtitles.clear()
        speech.target = npc
        -- An ordinary world NPC's face carries the gated speech layer from its spawn (Face.reds OnWorldInitialize); ConvaiFaceRequest reports it and runs the talk-time guards. An add-on's voice has no face.
        if not primary.voiceOnly then
            local faceOk, faceStatus = pcall(function() return npc:ConvaiFaceRequest() end)
            convaiFaceRequestLog(npc, entity, faceOk, faceStatus)
        end
        local context
        if groupMode then
            context = groupChat.startVoice('group-' .. tostring(os.time()) .. '-' .. tostring(generation), participants, generation, os.time())
        else
            context = {generation = generation, entity = entity, name = name, bodyType = body,
                profileKey = key, text = '[Microphone]', sentAt = os.time(), archetype = primary.archetype,
                voiceOnly = primary.voiceOnly, holocall = primary.holocall, head = primary.head}
            context.requestId = tostring(os.time()) .. '-' .. tostring(generation) .. '-' .. entity
        end
        active, pending, pendingKnowledgeOwner = nil, nil, nil
        convaiDemandKnowledge() -- fresh by the time the recording finishes (its second capture)
        local function targetValid()
            -- A holocall's caller stays valid while that call is connected, wherever V is.
            if primary.holocall then return convaiHolocall ~= nil and convaiHolocall.partnerValid(context) end
            -- Johnny in V's head stays valid while the story keeps him there and the game does not take the floor (held 0.4 s).
            if primary.head then
                local head = type(convaiJohnnyHeadService) == 'function' and convaiJohnnyHeadService() or nil
                return head ~= nil and head:refusal(Game.GetPlayer()) == nil
            end
            if primary.voiceOnly then return convaiAddons ~= nil and convaiAddons.participantLive(primary, Game.GetPlayer()) end
            if primary.story and convaiWorldTalk:refusal(npc, Game.GetPlayer(), entity) then return false end
            return voiceTargetValid(npc, context)
        end
        if microphone.begin(context, targetValid, 'press') then
            if not primary.voiceOnly and not primary.holocall and not primary.story then beginFocus(player, npc) end
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
    if not context.reaction and convaiTurnContext then context.turnContext = context.turnContext or convaiTurnContext:capture() end
    -- Automatic turns have one subject. Manual conversations may still discuss
    -- recent combat and pickups together when V asks about them.
    if context.reaction and (context.reaction.kind == 'loot' or context.reaction.kind == 'head') then context.battle = nil
    else context.battle = context.battle or battles.capture() end
    local current = knowledgeOwner(refreshKnowledgeFrame())
    if not knowledgeAllowed or current.paused or not sameKnowledgeOwner(owner, current) then return false end
    if context.holocall then
        -- A holocall's caller is not here (mod/holocall.lua): no gameplay actions (follow, fight, drive) are offered.
    elseif context.head then
        -- Johnny in V's head has no body (docs/JOHNNY_IN_YOUR_HEAD.md): no gameplay actions, no add-on blocks.
    elseif context.voiceOnly then
        -- An add-on's voice (docs/ADDON_API.md) cannot follow, fight or drive: no gameplay actions, and its context blocks.
        if convaiAddons and convaiAddons.live then convaiAddons.decorate(context) end
    elseif convaiStory and convaiStory.entity == context.entity and not context.group then
        -- A game-placed story character gets no action offers or advisories (docs/WORLD_CHARACTERS.md).
    elseif not context.group and not context.reaction then gameplayActions.capture(context, 'private-text')
    elseif context.group and context.group.index == 1 and not context.reaction then
        gameplayActions.capture(context, 'group-text')
    end
    -- In place over the shipped placeholder (Mod Organizer 2 never sees a new or deleted file). The bridge retries a
    -- half-written read on the file's next change; an empty file means "no request".
    local file = io.open('runtime/last-input.json', 'wb')
    if not file then gameplayActions.revoke('request-write-failed', context.requestId); return false end
    file:write(json.encode(context)); file:close()
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
        if sent and context.holocall and convaiHolocall then convaiHolocall.touch() end
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

-- Holocalls (mod/holocall.lua, docs/HOLOCALL.md). These run on the call's own 0.25 s tick or once per call event.
if convaiHolocall then
    convaiHolocall.configure({
        log = log,
        supported = function(key) return supportedProfiles[key] ~= nil end,
        profileEnabled = function(key) return manager.profileEnabled(key) end,
        -- The caller's connection warms while the call rings, like the text box warms it on opening.
        warm = function(key, entity) generation = generation + 1; warmConversation(nil, key, entity) end,
        -- The caller's conversation is ready: the same check as the "Preparing connection" notice (mod/auto-connect.lua).
        ready = function(key) return autoConnect == nil or autoConnect.ready(key) end,
        liveImage = function() return type(manager.holocallLiveImage) == 'function' and manager.holocallLiveImage() end,
        -- A turn with the caller is being typed, recorded, answered or spoken: the call is not idle.
        busy = function()
            return (active ~= nil and active.holocall ~= nil) or (pending ~= nil and pending.holocall ~= nil)
                or (microphone.context ~= nil and microphone.context.holocall ~= nil) or speech.holocall == true
        end,
        -- The call ended: the caller stops talking and nothing more of that call is sent or played.
        onEnded = function(_, reason)
            local stop = 'holocall-' .. tostring(reason)
            if microphone.context and microphone.context.holocall then cancelVoice(stop) end
            if pending and pending.holocall then
                if requestFileId == pending.requestId then requestFileId = nil; do local f = io.open('runtime/last-input.json', 'wb'); if f then f:close() end end end
                pending, pendingKnowledgeOwner = nil, nil
            end
            if active and active.holocall then active = nil end
            if speech.holocall then speech.stop(stop); subtitles.clear() end
            warmConversation(nil, nil)
        end,
    })
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
    end
    if owner.source == 'voice' then microphone.revoke(owner.context) end
    if pending and pending.requestId == requestId then pending, pendingKnowledgeOwner = nil, nil end
    -- The bridge owns a text request through this file: once it is empty (written in place, never deleted: Mod
    -- Organizer 2) there is no further audio, subtitles, face or memory for it. Never blank a newer one.
    if requestFileId == requestId then requestFileId = nil; do local f = io.open('runtime/last-input.json', 'wb'); if f then f:close() end end end
    if speech.requestId == requestId then pcall(speech.stop, reason)
    elseif captionsOnly then pcall(subtitles.clearEntity, entity) end
    if focusEntity == entity then focusUntil = os.time() + 1 end
    log('Private reply retired: ' .. tostring(reason))
    return true
end

-- A named character of the game is voiced only while the game leaves it alone (docs/WORLD_CHARACTERS.md, mod/world-talk.lua).
-- speech.lua asks when the reply is about to start (starting = true, nothing to retire yet) and while it plays, about twice a
-- second (the answer is held 0.4 s). True when the reply was ended: its voice, subtitle and face stop at once, so the game's own
-- animation resumes, and the bridge's request is dropped. Anyone who is not the story character V is talking to: false at once.
speech.storyGuard = function(actor, context, starting)
    -- Johnny in V's head (docs/JOHNNY_IN_YOUR_HEAD.md): a scene, a call, a fight or a game line of his that starts ends his reply as
    -- well. The pending context carries `head` when the reply starts; while it plays, speech.head says it is his.
    local headTalk = convaiHeadTalk
    if headTalk and type(context) == 'table' and context.entity == headTalk.entity
        and (type(context.head) == 'table' or (not starting and speech.head == true)) then
        local head = type(convaiJohnnyHeadService) == 'function' and convaiJohnnyHeadService() or nil
        local why = head == nil and 'off' or head:refusal(Game.GetPlayer())
        if not why then return false end
        log('Johnny in your head: reply ended reason=' .. why .. (starting and ' (before the reply began)' or ''))
        if starting then return true end
        retirePrivateReply(context.entity, 'head-' .. why)
        return true
    end
    local story = convaiStory
    if not story or convaiWorldTalk == nil or type(context) ~= 'table' or context.entity ~= story.entity then return false end
    local why = convaiWorldTalk:refusal(actor, Game.GetPlayer(), story.entity)
    if not why then return false end
    log('World conversation ended: profile=' .. story.key .. ' reason=' .. why .. (starting and ' (before the reply began)' or ''))
    if starting then return true end
    retirePrivateReply(context.entity, 'story-' .. why)
    return true
end

local function reactionLease(valid)
    if not automatic then return false end
    local now = os.time()
    if valid and automatic.leaseAt == now then return true end
    -- In place: the bridge keeps its last good lease when it reads a partial file (bridge/battle-lease.mjs).
    local file = io.open('runtime/reaction-lease.json', 'wb')
    if not file then return false end
    file:write(json.encode({requestId = automatic.requestId, valid = valid, updated = now * 1000,
        playbackStartedAt = automatic.playbackAt and automatic.playbackAt * 1000})); file:close()
    automatic.leaseAt = now
    return true
end

local reactionGuard, reactionEvidence = nil, {}
-- After a merged closing fails to claim its pickups, send the closing alone
-- for a moment instead of retrying the same merge every frame.
local mergeSuppressedUntil = 0
-- A closing waits for pickups still being collected, but never longer than
-- this many seconds after combat was confirmed over (its own window is 40).
local CLOSING_LOOT_WAIT = 14
local battleCandidatesOk, battleSampleAt = nil, nil
-- The voice and subtitle flags only change from a menu: read with each battle sample (every 0.5 s), not every tick.
local battleOutputs = nil

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
    local file = io.open('runtime/battle-cancellations.json', 'wb')
    if not file then return end
    file:write(json.encode({version = 1, updated = record.at, events = reactionEvidence})); file:close()
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
    -- A Johnny remark nobody heard gives its rate slot back (mod/johnny-remarks.lua).
    if automatic.reaction.kind == 'head' and convaiJohnnyRemarks then
        pcall(convaiJohnnyRemarks.release, convaiJohnnyRemarks, convaiJohnnyRemarks.current, automatic.playbackAt ~= nil)
    end
    -- A V talk step nobody heard gives its rate slot back and takes V's subtitle down; one that was heard to its end lets the exchange go on
    -- to its second part (mod/v-talks.lua stepEnded). A world change (abandoning) ends the exchange with the queue (reset).
    if automatic.reaction.kind == 'vtalk' then
        if not abandoning and not automatic.shown then pcall(subtitles.clear) end
        if convaiVTalks then
            pcall(convaiVTalks.stepEnded, convaiVTalks, automatic.reaction.exchange, automatic.playbackAt ~= nil,
                reason == 'completed' and automatic.playbackAt ~= nil, os.time())
        end
    end
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
    -- Characters another mod or a spawner created that were near V when the fight began or a pickup was made
    -- (convaiSpawnedPeople, docs/SPAWNED_CHARACTERS.md). Nothing is read while none are remembered; our own copy of a
    -- profile always keeps its place, and the spawned one of that profile is left out.
    local nearby = convaiSpawnedPeople and convaiSpawnedPeople.reactionRows(player) or {}
    if #nearby > 0 then
        local present = {}
        for _, person in ipairs(people) do present[person.profileKey] = true end
        for _, person in ipairs(nearby) do
            if not present[person.profileKey] then
                present[person.profileKey] = true
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
    -- A pickup is the event that asks who is near (spawned characters are found by a scan, reused for a few seconds).
    if convaiSpawnedPeople and manager.lootReactions() then convaiSpawnedPeople.watch(player) end
    return {available = observation.available, blocked = observation.blocked,
        worldReady = ready, enabled = manager.lootReactions(), now = os.time(),
        people = reactionPeople(player, observation)}
end

-- Johnny's hologram on the 0.5 s battle sample, only while a sit is waiting or he is there. A global, so updateBattles gains no
-- upvalue. talking: V types, records, talks in a group or on the phone, or any reply or reaction is playing.
function convaiJohnnyHologramTick(player, sample, worldReady)
    local service = convaiJohnnyHologram
    if not service then return end
    local talking = active ~= nil or groupChat.round ~= nil or microphone.context ~= nil or phoneChat.pending ~= nil
        or automatic ~= nil or speech.requestId ~= nil
    service:tick(player, sample, worldReady, talking)
end

-- Johnny speaks up (docs/JOHNNY_IN_YOUR_HEAD.md, phase 2), on the 0.1 s game tick inside updateBattles. A global, so updateBattles gains
-- no upvalue. With nothing queued it is one length check. `owned`: a head remark is the automatic turn now (keep it or release it);
-- otherwise it may start one when nothing else is going on (busy false) and mayFollow allows a new automatic turn.
function convaiJohnnyRemarkTick(player, now, worldReady, outputs, manual, busy, mayFollow)
    local remarks = convaiJohnnyRemarks
    if automatic and automatic.reaction.kind == 'head' then
        -- Kept or released once per tick, by the first call (the offer call passes busy, and an owned turn means busy).
        if busy ~= nil then return false end
        local head = convaiJohnnyHeadService()
        local reason = not worldReady and 'world-not-ready' or manual and 'manual-priority' or not outputs.enabled and 'outputs-disabled'
            or (convaiJohnnyRemarksService() == nil or head == nil) and 'off'
            or (not automatic.playbackAt and now * 1000 > automatic.reaction.expiresAt) and 'expired'
            or head:refusal(player)
        if reason then cancelAutomatic('head-' .. reason)
        elseif not pending and not speech.requestId and not subtitles.ownsUtterance() then cancelAutomatic('completed')
        elseif not reactionLease(true) then cancelAutomatic('lease-write-failed') end
        return true
    end
    if busy or not remarks or not remarks:pending() then return false end
    local head = convaiJohnnyRemarksService() and convaiJohnnyHeadService() or nil
    if not head or head:refusal(player) then return false end
    local entry = remarks:offer(now)
    if not entry or not mayFollow(entry, 'head') then return false end
    local partner = head:partner(player)
    if not partner then return false end
    generation = generation + 1
    local context = {generation = generation, entity = partner.entity, name = partner.name, bodyType = '',
        profileKey = partner.profileKey, voiceOnly = true, head = partner.head, sentAt = now,
        text = 'Johnny speaks up unprompted. Give one brief in-character remark.',
        reaction = {kind = 'head', event = entry.kind, facts = entry.facts,
            expiresAt = math.floor((now + convaiJohnnyRemarksModule.SEND_SECONDS) * 1000)}}
    context.requestId = tostring(os.time()) .. '-' .. generation .. '-' .. context.entity
    automatic = context
    captureReactionGuard(worldReady, outputs, nil)
    if reactionLease(true) and sendRequest(context) then
        remarks:claim(entry, now)
        speech.target = player
        convaiHeadTalk = {entity = partner.entity}
        lastAutomatic = {at = now, requestId = context.requestId, kind = 'head'}
        log('Automatic head reaction: ' .. entry.subject .. ' stage=' .. tostring(partner.head.stage))
    else cancelAutomatic('request-write-failed') end
    return true
end

-- V talks on their own (docs/V_TALKS.md, mod/v-talks.lua). The service exists only while the setting is Rare or Normal and V's voice for typed
-- lines is on (V's lines are spoken with it; without it the feature stays silent), and is dropped when either goes off. Globals, so
-- updateBattles and its callers gain no upvalue.
function convaiVTalksService()
    if manager.vTalks() == 'off' or not manager.vVoiceActive() then
        convaiVTalks = nil
        return nil
    end
    if convaiVTalks == nil then
        local loaded, module = pcall(dofile, 'v-talks.lua')
        convaiVTalksModule = loaded and type(module) == 'table' and type(module.new) == 'function' and module or nil
        -- The service says why it does not start (one line per reason and waiting spell: probe.log).
        convaiVTalks = convaiVTalksModule and module.new({level = function() return manager.vTalks() end,
            log = function(line) log('V talks on their own: ' .. line) end}) or false
        if not convaiVTalks then print('[CyberpunkConvai] v-talks.lua unavailable: ' .. tostring(module)) end
    end
    return convaiVTalks or nil
end
-- V's place, read only when a calm spell begins and when a calm talk is about to be offered (a handful of times an hour).
function convaiVTalkWhere()
    local position = Game.GetPlayer():GetWorldPosition()
    return {x = position.x, y = position.y, z = position.z}
end
-- One event from a collector: 'job' (the jobs the history scan newly found finished).
function convaiVTalkNote(kind, value)
    if manager.vTalks() == 'off' then return end
    local talks, module = convaiVTalksService(), convaiVTalksModule
    if not talks or not module or kind ~= 'job' then return end
    for _, quest in ipairs(value) do
        local subject, facts = module.jobEvent(quest)
        if subject and talks:note('job', subject, facts, os.time()) then log('V talks on their own: noted ' .. subject) end
    end
end
-- The fresh 0.5 s observer sample (updateBattles): the service is made or dropped here, a calm spell is followed and a fight that ended is
-- noted. One settings read per sample while the setting is off.
function convaiVTalkObserve(sample)
    local talks, module = convaiVTalksService(), convaiVTalksModule
    if not talks or not module or not sample then return end
    local now = os.time()
    talks:watch(module.busy(sample) == nil, now, convaiVTalkWhere)
    local status = battles.status()
    if status.state == 'ended' and status.encounter ~= talks.fightSeen then
        talks.fightSeen = status.encounter
        -- A fight that does not count says why, once per encounter (fightSeen is set above).
        local subject, facts, prefer = module.fightEvent(battles.capture())
        if subject then
            if talks:note('fight', subject, facts, now, prefer) then log('V talks on their own: noted ' .. subject) end
        elseif type(facts) == 'string' then log('V talks on their own: fight ' .. facts) end
    end
end
-- Under pcall, like the tick: a fault is logged once and never reaches updateBattles.
function convaiVTalkSample(sample)
    local ok, result = pcall(convaiVTalkObserve, sample)
    if not ok and not convaiVTalkFaulted then convaiVTalkFaulted = true; log('V talks on their own failed (carrying on): ' .. tostring(result)) end
end

-- On the 0.1 s game tick inside updateBattles. With nothing waiting it is a few comparisons. owned: a V talk step is the automatic turn now (keep
-- it or release it, once per tick, by the first call); otherwise an exchange or its next step may start when nothing else is going on.
function convaiVTalkRun(player, now, worldReady, outputs, manual, busy, mayFollow)
    local talks, module = convaiVTalksService(), convaiVTalksModule
    local owned = automatic ~= nil and automatic.reaction.kind == 'vtalk'
    if not talks or not module then
        if owned then cancelAutomatic('vtalk-off') end
        return false
    end
    if owned then
        if busy ~= nil then return false end
        local speaker
        for _, person in ipairs(battlePeople) do
            if person.entity == automatic.entity and person.profileKey == automatic.profileKey then speaker = person; break end
        end
        captureReactionGuard(worldReady, outputs, speaker)
        local waiting = reactionSpeakerWait(speaker)
        local reason = not worldReady and 'world-not-ready' or manual and 'manual-priority' or not outputs.enabled and 'outputs-disabled'
            or (not automatic.playbackAt and now * 1000 > automatic.reaction.expiresAt) and 'expired'
            or not speaker and 'speaker-missing' or (not speaker.available and not waiting) and 'speaker-unavailable'
            or module.busy(battleSample)
        if reason then cancelAutomatic('vtalk-' .. reason)
        elseif not pending and not speech.requestId and not subtitles.ownsUtterance() then cancelAutomatic('completed')
        elseif not reactionLease(true) then cancelAutomatic('lease-write-failed') end
        return true
    end
    -- Nothing waiting: the spell of waiting (and what was said about it) is over. A decline below is logged once per reason and spell, so
    -- an event that has to wait says why it waits and never fills the log (docs/V_TALKS.md, "Why it did not start").
    if not talks:waiting(now) then talks:settled(); return false end
    if busy then return talks:decline('another turn is in progress (a reply, a reaction, or V typing or talking)') end
    if not talks.exchange then
        local allowed, limit = talks:allowed(now)
        if not allowed then return talks:decline(limit) end
    end
    -- The game has the floor, or a game line is still going on: an exchange between its parts is over, an event waits for its time to live.
    local theFloor = module.busy(battleSample)
    if theFloor then talks:finish(); return talks:decline('the game has the floor (' .. theFloor .. ')') end
    if module.recentLine(convaiGameDialogue and convaiGameDialogue.lines, now, module.LINE_SECONDS) then
        return talks:decline('a game line was shown in the last ' .. module.LINE_SECONDS .. ' s')
    end
    local exchange = talks:continuing(now)
    local entry
    if exchange then
        -- The next part, only when nothing else spoke since the last one.
        if not lastAutomatic or lastAutomatic.requestId ~= exchange.requestId then
            talks:finish()
            return talks:decline('something else spoke between the two parts: the exchange is over')
        end
    else
        if talks.exchange then return false end
        -- Not right after another automatic reaction (a battle line, a pickup, a remark of Johnny's), and only with a companion in reach.
        if lastAutomatic and now - (lastAutomatic.finishedAt or lastAutomatic.at) < module.AFTER_REACTION then
            return talks:decline('another automatic reaction (' .. tostring(lastAutomatic.kind) .. ') ended less than ' .. module.AFTER_REACTION .. ' s ago')
        end
        if not mayFollow(true, 'vtalk') then return talks:decline('the previous reaction is still being handed over') end
        if not module.pickSpeaker(battlePeople) then
            return talks:decline('no party companion within ' .. module.SPEAKER_RANGE .. ' m who can speak')
        end
        local why
        entry, why = talks:offer(now, {ride = battleSample.vehicle == true, where = convaiVTalkWhere})
        if not entry then
            if why then talks:decline(why) end
            return false
        end
    end
    local person = module.pickSpeaker(battlePeople, exchange and {keep = exchange.speaker}
        or {prefer = entry.prefer, last = talks.lastSpeaker})
    if not person then
        if exchange then talks:finish() end
        return false
    end
    exchange = exchange or talks:open(entry, now)
    generation = generation + 1
    local snapshot = convaiTurnContext and convaiTurnContext:capture() or nil
    local line = talks:line(exchange, module.tone(snapshot))
    local context = {generation = generation, entity = person.entity, name = person.name, bodyType = person.bodyType,
        profileKey = person.profileKey, sentAt = now, text = line, turnContext = snapshot,
        reaction = {kind = 'vtalk', exchange = exchange.id, step = exchange.step, steps = exchange.steps, event = exchange.kind,
            facts = exchange.facts, expiresAt = math.floor((now + module.SEND_SECONDS) * 1000)}}
    context.requestId = tostring(os.time()) .. '-' .. generation .. '-' .. context.entity
    automatic = context
    captureReactionGuard(worldReady, outputs, person)
    if reactionLease(true) and sendRequest(context) then
        talks:started(exchange, now, {entity = person.entity, profileKey = person.profileKey}, context.requestId)
        talks.lastSpeaker = person.profileKey
        speech.target = person.npc
        lastAutomatic = {at = now, requestId = context.requestId, kind = 'vtalk'}
        -- V's line shows as V's subtitle at once, as a typed line does (the bridge speaks it; the reply's caption replaces it).
        pcall(subtitles.showTyped, line)
        log('V talks on their own: ' .. exchange.kind .. ' part ' .. exchange.step .. ' of ' .. exchange.steps .. ' speaker=' .. person.profileKey)
    else
        talks:abandon(exchange)
        cancelAutomatic('request-write-failed')
    end
    return true
end
-- The tick under pcall: updateBattles is itself called under pcall, and a fault here must neither reset the battle sample nor cancel the
-- other automatic reactions every tick. It is logged once and the feature carries on at its next call.
function convaiVTalkTick(player, now, worldReady, outputs, manual, busy, mayFollow)
    local ok, result = pcall(convaiVTalkRun, player, now, worldReady, outputs, manual, busy, mayFollow)
    if ok then return result end
    if not convaiVTalkFaulted then convaiVTalkFaulted = true; log('V talks on their own failed (carrying on): ' .. tostring(result)) end
    if automatic and automatic.reaction.kind == 'vtalk' then cancelAutomatic('vtalk-error') end
    return false
end
-- The reply of a step is about to be heard: the game must still have left the floor to V (read fresh: a scene, a call or a fight can start
-- between samples), the service must still be on, and the companion must still be there and able to speak. A vehicle is fine.
function convaiVTalkCanDeliver(context, player)
    local talks, module = convaiVTalksService(), convaiVTalksModule
    local why = (not talks or not module) and 'off' or module.busy(battleObserver.sample(player))
    if why then cancelAutomatic('vtalk-' .. why); return false end
    for _, person in ipairs(battlePeople) do
        if person.entity == context.entity and person.profileKey == context.profileKey then
            person.available, person.availableReason, person.voiceBusy = battleObserver.canSpeak(person.npc, 'end')
            captureReactionGuard(true, reactionOutputs(player), person)
            local waiting = reactionSpeakerWait(person)
            if not person.available and not waiting then cancelAutomatic('speaker-unavailable') end
            return person.available == true
        end
    end
    cancelAutomatic('speaker-missing')
    return false
end

local function updateBattles(player, elapsed, worldReady)
    battlePoll = battlePoll + elapsed
    if not battleSample or battlePoll >= 0.5 then
        battlePoll = 0
        battleSample = battleObserver.sample(player)
        battleSampleAt = os.time() * 1000
        -- V talks on their own: one settings read per sample while it is off (the service is made, followed and dropped inside).
        if convaiVTalkSample then convaiVTalkSample(battleSample) end
        if convaiSpawnedPeople then
            convaiSpawnedPeople.sample(player, battleSample, manager.battleReactions() or manager.lootReactions())
        end
        battlePeople, battleCandidatesOk = reactionPeople(player, battleSample)
        battleOutputs = reactionOutputs(player)
        if convaiJohnnyPlaceSample then convaiJohnnyGuarded('place sample', convaiJohnnyPlaceSample, worldReady, battleSample.vehicle == true) end
        if convaiJohnnyFight then convaiJohnnyGuarded('fight watch', convaiJohnnyFightSample, battleSample) end
        if convaiJohnnyHologram and convaiJohnnyHologram:active() then
            convaiJohnnyGuarded('hologram', convaiJohnnyHologramTick, player, battleSample, worldReady)
        end
        -- A Johnny probe acting over time (Developer mode, mod/johnny-probe.lua); nil otherwise.
        if convaiJohnnyProbeTick then pcall(convaiJohnnyProbeTick) end
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
    local outputs = battleOutputs or reactionOutputs(player)
    if automatic and automatic.reaction.kind == 'vtalk' then
        convaiVTalkTick(player, now, worldReady, outputs, manual)
    elseif automatic and automatic.reaction.kind == 'head' then
        convaiJohnnyRemarkTick(player, now, worldReady, outputs, manual)
    elseif automatic then
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
    -- V talks on their own, when no battle or loot reaction is due (an owned turn of any kind is `busy` here); a Johnny remark due on the same tick
    -- waits behind it (mod/v-talks.lua), and starts after it. One nil check while the setting is off.
    if not event and convaiVTalks then convaiVTalkTick(player, now, worldReady, outputs, manual, busy, mayFollow) end
    -- Battle and loot reactions first; then a waiting Johnny remark (one length check while nothing is queued).
    if not event then
        if convaiJohnnyRemarks then convaiJohnnyRemarkTick(player, now, worldReady, outputs, manual, busy, mayFollow) end
        return
    end
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
        -- A character another mod or a spawner created speaks with the face it was prepared with at spawn.
        if person.spawned then pcall(function() return person.npc:ConvaiFaceRequest() end) end
        lastAutomatic = {at = now, requestId = context.requestId, kind = event.reaction.kind,
            phase = event.phase, encounter = event.encounter}
        log('Automatic ' .. event.reaction.kind .. ' reaction: ' .. tostring(event.phase or 'batch') .. ' speaker=' .. person.profileKey
            .. (event.loot and (' items=' .. #event.loot.items .. ' exceptional=' .. tostring(event.loot.exceptional)) or ''))
    else cancelAutomatic('request-write-failed') end
end

-- The bridge adds errorCode to a failed reply when Convai refused it for the plan or the key (bridge/convai-quota.mjs), and
-- keyNotice to the first reply that ran without long-term memory on a limited plan (bridge/convai-key.mjs). The text says
-- what to do; it never names where the shared key comes from.
-- The shared plan's daily allowance is used up (bridge/shared-key-guard.mjs). The game's warning line shows this in upper case
-- at 35 pt, wraps it at 800 px and draws a frame sized for one or two lines, so the notice has a forced break ("\n", which the
-- warning text honours): the first sentence on line 1 (one rendered line, at most 770 px of upper-case Rajdhani Semi-Bold), the
-- detailed Mistral / Local AI sentence starting on a fresh line 2, which may wrap to a third line (at most three rendered lines in
-- all; bridge/daily-notice-fit.test.mjs); it stays 9 s (notices.showS).
-- Phone Chat has room for the long version and keeps it (phone-chat.lua), which says where the details are.
-- The turns used are the limit the backend set, read the way the settings page reads it (manager.ownKey().daily.limit), never a number
-- written here; without it the line says "Today’s Convai turns". Mistral's about 5,000 a day is the conservative bound of its free
-- plan (an estimated 1B tokens a month over about 6,650 tokens for a full turn, about 150,000 turns a month).
local function dailyLimitText()
    local ok, own = pcall(manager.ownKey)
    local limit = ok and type(own) == 'table' and type(own.daily) == 'table' and own.daily.limit or nil
    if type(limit) == 'number' then
        return ui.t('Today’s {limit} Convai turns are used.\nTry Mistral (free key, ~5,000 a day) or Local AI (unlimited).', {limit = limit})
    end
    return ui.t('Today’s Convai turns are used.\nTry Mistral (free key, ~5,000 a day) or Local AI (unlimited).')
end

local function keyNoticeText(code)
    if code == 'quota-shared' then
        return ui.t('The conversation limit has been reached. Try again later, or add a free Mistral key and set Conversation provider to Mistral in Settings > Conversation provider.')
    elseif code == 'quota-own' then
        return ui.t('Your Convai API key has reached its plan limit. Try again later or add a different key in Settings > Conversation provider.')
    elseif code == 'key-rejected' then
        return ui.t('Convai did not accept your API key. Check it in Settings > Conversation provider.')
    elseif code == 'key-memory-needed' then
        return ui.t('Your Convai plan cannot hold the memory these conversations need. Free a memory user in your Convai account or use another key.')
    end
    return nil
end

-- What a failed Local AI turn was waiting for, in the bridge's own words ("no first word from the model after 60 s"): one short plain English phrase, shown in
-- brackets after the translated sentence as data, like any provider's error text (it is not a translation key). Anything that is not short printable ASCII is
-- ignored, and so is a reply without one.
local function localFailureSuffix(reply)
    local detail = reply.errorDetail
    if type(detail) ~= 'string' or detail == '' or #detail > 140 or detail:find('[%c\128-\255]') then return '' end
    return '\n(' .. detail .. ')'
end

-- id and text of the notice a reply calls for, or nil for an ordinary reply.
local function keyReplyNotice(reply)
    if reply.errorCode == 'key-memory' or reply.keyNotice == 'memory-off' then
        return 'key-memory', ui.t('Your Convai plan has no room for conversation memory, so companions will not remember past talks.')
    end
    if reply.errorCode == 'daily-limit' then return 'daily-limit', dailyLimitText() end
    -- Mistral: three failures the bridge names, and two one-time notices on the first reply.
    if reply.errorCode == 'mistral-key' then
        return 'mistral-key', ui.t('Mistral did not accept your key. Check it in Settings > Conversation provider.')
    elseif reply.errorCode == 'mistral-limit' then
        return 'mistral-limit', ui.t('Mistral’s free limit is reached for now. Try again in a moment.')
    elseif reply.errorCode == 'mistral-model' then
        return 'mistral-model', ui.t('The Mistral model is unavailable right now. Try again in a minute.')
    end
    -- Custom (OpenAI-compatible): five failures the bridge names (the same sentences as mod/custom-provider.lua's notice(), which a test
    -- keeps equal), and two one-time notices on the first reply.
    if reply.errorCode == 'custom-key' then
        return 'custom-key', ui.t('The custom provider did not accept your key. Check it in Settings > Conversation provider.')
    elseif reply.errorCode == 'custom-credits' then
        return 'custom-credits', ui.t('The custom provider says your account is out of credits. Add credits there, then try again.')
    elseif reply.errorCode == 'custom-model' then
        return 'custom-model', ui.t('The custom provider does not know that model ID. Check it in Settings.')
    elseif reply.errorCode == 'custom-limit' then
        return 'custom-limit', ui.t('The custom provider is rate limiting you. Try again in a moment.')
    elseif reply.errorCode == 'custom-daily' then
        -- The free daily limit of a model (OpenRouter): when it resets on this computer's clock (the bridge sends "HH:MM"), if the endpoint said.
        local at = reply.errorResetTime
        if type(at) == 'string' and at:match('^%d%d:%d%d$') then
            return 'custom-daily', ui.t('The free daily limit for this model was reached. It resets at {time}.', {time = at})
        end
        return 'custom-daily', ui.t('The free daily limit for this model was reached. Try again after it resets.')
    elseif reply.errorCode == 'custom-reasoning' then
        return 'custom-reasoning', ui.t('This model spends its reply on thinking. Choose a non-reasoning model in Settings.')
    elseif reply.errorCode == 'custom-unreachable' then
        return 'custom-unreachable', ui.t('The custom provider did not answer. Check its address in Settings, or try again.')
    end
    -- Local AI is chosen and could not start, and nobody took the turn over (no Mistral key, Convai's free turns for today used): its own reason,
    -- never the Convai limit the player did not choose (bridge/convai-bridge.mjs providerFailureCode).
    if reply.errorCode == 'local-no-memory' then
        return 'local-no-memory', ui.t('Not enough free graphics memory to start Local AI. Try a smaller model in Settings.')
    elseif reply.errorCode == 'local-unavailable' then
        return 'local-unavailable', ui.t('Local AI could not start. Check Local AI in Settings > Conversation provider.')
    end
    -- Local AI could not start, so the bridge used Convai: the same line whether it rode on a failed turn or on the first reply.
    if reply.errorCode == 'local-fallback' or reply.keyNotice == 'local-fallback' then
        return 'local-fallback', ui.t('Local AI could not start, so a cloud provider is used. Check Local AI in Settings > Conversation provider.')
    end
    -- The browser for the conversation page was found but would not start (bridge/system-browser.mjs): name it, the detail says which and why.
    if reply.errorCode == 'browser-failed' then
        return 'browser-failed', ui.t('The browser for the conversation page would not start. Try again, or use another Chromium browser.') .. localFailureSuffix(reply)
    end
    -- A turn the local AI could not answer, with no cloud provider to take it over: say so (the next turn tries again).
    if reply.errorCode == 'local-failed' then
        return 'local-failed', ui.t('Local AI could not answer that. Try again in a moment.') .. localFailureSuffix(reply)
    end
    -- A turn the local AI could not answer and the player's cloud provider did: the reply carries this one-line note.
    if reply.keyNotice == 'local-turn-fallback' then
        return 'local-turn-fallback', ui.t('Local AI could not answer that one, so a cloud provider did.')
    end
    -- The Local AI model the player chose is missing, does not fit or did not start, and another was used (the reply names it): said once per choice.
    if reply.keyNotice == 'local-model-fallback' then
        local used = reply.keyNoticeModel
        if type(used) ~= 'string' or used == '' or #used > 80 or used:find('%c') then used = ui.t('another model') end
        return 'local-model-fallback', ui.t('The Local AI model you chose is missing, does not fit in the free graphics memory or did not start, so {model} was used instead.', {model = used})
    end
    if reply.keyNotice == 'mistral-no-key' then
        return 'mistral-no-key', ui.t('Mistral has no key yet, so Convai is used. Add your key in Settings > Conversation provider.')
    elseif reply.keyNotice == 'mistral-voice' then
        return 'mistral-voice', ui.t('Mistral replies are spoken by a local voice instead of the Convai cloud voice.')
    elseif reply.keyNotice == 'custom-no-setup' then
        return 'custom-no-setup', ui.t('The custom provider is not set up, so Convai is used. Add its URL and model ID in Settings.')
    elseif reply.keyNotice == 'custom-voice' then
        return 'custom-voice', ui.t('Custom provider replies are spoken by a local voice instead of the Convai cloud voice.')
    end
    local text = keyNoticeText(reply.errorCode)
    if text then return 'quota-exhausted', text end
    return nil
end

-- The one-time information the bridge puts on the first reply of a game session when Mistral or Custom is chosen.
local function sendProviderNotice(player, keyId, keyText)
    if keyId == 'mistral-no-key' then convaiNotices.send(player, 'mistral-no-key', keyText)
    elseif keyId == 'mistral-voice' then convaiNotices.send(player, 'mistral-voice', keyText)
    elseif keyId == 'custom-no-setup' then convaiNotices.send(player, 'custom-no-setup', keyText)
    elseif keyId == 'custom-voice' then convaiNotices.send(player, 'custom-voice', keyText)
    elseif keyId == 'local-fallback' then convaiNotices.send(player, 'local-fallback', keyText)
    elseif keyId == 'local-turn-fallback' then convaiNotices.send(player, 'local-turn-fallback', keyText)
    elseif keyId == 'local-model-fallback' then convaiNotices.send(player, 'local-model-fallback', keyText) end
end

local function reactionCanDeliver(context, player)
    if not context.reaction then return true end
    if context.reaction.kind == 'addon' then return convaiAddons ~= nil and convaiAddons.canDeliver(context, player) end
    if not automatic or automatic.requestId ~= context.requestId then return false end
    -- A Johnny remark is heard only while he is still in V's head and the game does not have the floor (read fresh, held 0.4 s).
    if context.reaction.kind == 'head' then
        local head = convaiJohnnyHeadService()
        local why = head == nil and 'off' or head:refusal(player)
        if why then cancelAutomatic('head-' .. why); return false end
        return true
    end
    -- A V talk step: the game must have left the floor to V (a vehicle is fine), read fresh; the companion must still be there.
    if context.reaction.kind == 'vtalk' then return convaiVTalkCanDeliver(context, player) end
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

-- Development only: shows one notice on demand, so its wording can be looked at in game without real Convai use. It runs from the
-- diagnostic mailbox's existing poll (never per frame), only for a new "notice:<id>:<stamp>" request, and only with Developer mode on:
-- for a player the request is read and dropped. Writes the notice the same way a failed reply does (same text, same repeat rules).
speech.devNotice = function(request)
    if not manager.developerMode() then return false, 'developer mode is off' end
    local id = type(request) == 'string' and request:match('^notice:([%w%-]+)') or nil
    local player = Game.GetPlayer()
    if id ~= 'daily-limit' or not player then log('Developer notice request ignored: ' .. tostring(id)); return false, 'unknown notice or no player' end
    convaiNotices.send(player, 'daily-limit', dailyLimitText())
    log('Developer notice shown: ' .. id)
    return true
end

-- Development only: a Johnny probe (mod/johnny-probe.lua, docs/JOHNNY_IN_YOUR_HEAD.md "Live check owed"), from the same mailbox poll,
-- only for a new "johnny-probe:<feature>:<action>:<stamp>" request and only with Developer mode on. Loaded on the first such request.
function convaiJohnnyProbeRun(request)
    if not manager.developerMode() then return false end
    local ok, probe = pcall(dofile, 'johnny-probe.lua')
    if not ok or type(probe) ~= 'table' then log('Johnny probe unavailable: ' .. tostring(probe)); return false end
    return probe.run(request)
end

local function groupAudience(player)
    local live, listeners = {}, {}
    if not groupChat.round or not player then return live, listeners end
    local origin = player:GetWorldPosition()
    for _, person in ipairs(groupChat.round.participants) do
        local ok, nearby = pcall(function()
            if person.voiceOnly then return convaiAddons ~= nil and convaiAddons.participantLive(person, player) end
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
    -- An ordinary world NPC's face carries the gated speech layer from its spawn (Face.reds OnWorldInitialize); ConvaiFaceRequest reports it and runs the talk-time guards. An add-on's voice has no face.
    if not context.voiceOnly then
        local faceOk, faceStatus = pcall(function() return actor:ConvaiFaceRequest() end)
        convaiFaceRequestLog(actor, context.entity, faceOk, faceStatus)
        beginFocus(player, actor)
    end
    focusMode, focusEntity = 'chat', context.entity
    if not sendRequest(context) then groupChat.cancel(); log('Group request could not be written') end
end

local function captureDiagnostic()
    local ok, err = pcall(dofile, 'diagnostics.lua')
    if not ok then log('Diagnostic capture failed: ' .. tostring(err)) end
end

-- The manager's shortcut (a CET hotkey: it runs when the key comes back up). Every press logs two lines: that the handler was entered, and
-- the outcome (opened, or the refusal with its reason and kind, or the error), so a press that did nothing can be told from one that never
-- arrived (2026-10-20: F4 on a couch left no line at all). A refusal because V sits is the one the player is told about: Mod Configuration
-- Menu declines to open while a scene tier of 3 holds, and a couch or chair is one (mod/mcm-host.lua, refusal), so there is a short
-- notice ('manager-seated', at most every 5 s: it shows for five seconds). The other refusals stay in the log, as before.
-- (The count is a global: the main chunk is near Lua's limit of local variables.)
local function openManager()
    convaiManagerPresses = (convaiManagerPresses or 0) + 1
    local press = convaiManagerPresses
    log('Companion manager shortcut: press ' .. press .. ' (handler entered)')
    local ok, result, reason, kind = pcall(managerUi.open)
    if ok and result then
        log('Companion manager shortcut: press ' .. press .. ' opened (requested from the settings host)')
        gameplayActions.revoke('menu')
        endFocus(Game.GetPlayer())
        focusMode = nil
        focusEntity = nil
        focusUntil = nil
        resetGaze()
    else
        local why = tostring(ok and (reason or result) or result or 'Open it during gameplay.')
        log('Companion manager: ' .. why)
        log('Companion manager shortcut: press ' .. press .. (ok and ' refused' or ' failed') .. ' (kind=' .. tostring(ok and kind or nil) .. ')')
        if ok and kind == 'seated' then
            pcall(function()
                local player = Game.GetPlayer()
                if player then convaiNotices.send(player, 'manager-seated', ui.t('Stand up to open the Companion Manager')) end
            end)
        end
    end
end

-- The phone queues a request only while it is open, so the per-frame ConvaiPhoneTakeRequest read waits for an open
-- phone (and a short while after it closes, so a request queued as it closes is still taken). A closed phone is
-- still drained once a second, as a backstop for a request left from before a CET reload.
local PHONE_DRAIN_GRACE, PHONE_DRAIN_IDLE = 1.5, 1.0
local phoneSeenAt, phoneDrainedAt = nil, nil
local function phoneDrainDue(phoneOpen)
    local wall = os.clock()
    if phoneOpen then phoneSeenAt = wall
    elseif phoneSeenAt and wall >= phoneSeenAt and wall - phoneSeenAt < PHONE_DRAIN_GRACE then phoneDrainedAt = wall
    elseif phoneDrainedAt and wall >= phoneDrainedAt and wall - phoneDrainedAt < PHONE_DRAIN_IDLE then return false end
    phoneDrainedAt = wall
    return true
end
local function processPhoneAction(player)
    local queue = managerUi.party and managerUi.party()
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
        -- arrives, and what she still waits for ("Preparing Evelyn: waiting for the voice model to load…") is one
        -- of the loading notice's lines, held until she has spawned (manager-party.lua waiting(), manager-ui.lua). A refusal is always
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
    local queue = managerUi.party and managerUi.party()
    local board = queue and type(queue.board) == 'function' and queue.board() or nil
    if not board then return end
    local note = board.take(worldReady == true)
    if note and convaiNotices.send(player, 'invite-board', note.message) then note.commit() end
end

-- Fight tactic environment: the player, the ready companion by entity, the marked target, and developer
-- notices. Nothing here sends a request or plays a line.
tacticEnv.player = function() return Game.GetPlayer() end
tacticEnv.actor = function(entity) return companions.readyActor(entity) end
tacticEnv.rearm = function(entity) return companions.rearmEquipment(entity) end
tacticEnv.marked = function(player) return marking.current(player) end
-- Squadmates pulled into a fight: never a named, story or spawned character, and never one of our own copies.
tacticEnv.protected = function(npc) return convaiWorldPolicy ~= nil and convaiWorldPolicy.protected(npc) == true end
tacticEnv.owned = function(npc) return companions.owns(npc) or (convaiCompanionAdoption ~= nil and convaiCompanionAdoption.hidden(npc)) end
tacticEnv.feedback = function(message)
    local player = Game.GetPlayer()
    if player then convaiNotices.send(player, 'tactic-outcome', ui.t(message)) end
end
tacticEnv.log = function(line) log(line) end

-- A copy's conversation profile can be reassigned (companions.setProfile).
companions.onProfileChanged = function(entity) retirePrivateReply(entity, 'profile-reassigned') end

-- The main mod seams the add-on API uses (docs/ADDON_API.md, "Main mod seams"). Plain functions over state this file already
-- keeps; none runs unless an add-on has registered, and none runs per frame.
if convaiAddons then
    local seams = {log = function(line) log(line) end, native = function() return convaiNative end,
        player = function() return Game.GetPlayer() end, outputs = function(player) return reactionOutputs(player) end,
        sample = function(player) return battleObserver.sample(player) end,
        nextGeneration = function() generation = generation + 1; return generation end,
        registerProfile = function(key) supportedProfiles[key] = true end,
        -- The first replaceGameLines rule installs the subtitle filter; without one nothing is hooked for it.
        installLineRules = function() if gameDialogue then gameDialogue:installMute() end end,
        partyProfiles = function() return companions.connectionProfiles() end,
        notify = function(player, text) convaiNotices.send(player, 'addon-notice', text) end}
    -- What is going on now, read once per add-on tick.
    seams.state = function()
        return {active = active ~= nil, microphone = microphone.context ~= nil, group = groupChat.round ~= nil,
            phone = phoneChat.pending ~= nil, automatic = automatic ~= nil,
            pendingId = pending and pending.requestId or nil, pendingProfile = pending and pending.profileKey or nil,
            pendingReaction = pending and pending.reaction and pending.reaction.kind or nil,
            speechId = speech.requestId, speechName = speech.speaker, captions = subtitles.ownsUtterance() == true,
            -- Why the last voice stopped (speech.lua: 'finished', 'playback-failed', 'target-lost', 'muted', ...) and its error, for the
            -- add-on log line of a remark whose voice ended early. Plain strings, read with the rest of this table.
            speechStop = not speech.requestId and speech.state or nil, speechError = not speech.requestId and speech.error or nil,
            sample = battleSample}
    end
    -- Where an add-on voice is heard from (addons.lua voiceFrom), asked by speech.lua once per add-on reply.
    speech.voiceSource = function(profileKey, player) return convaiAddons.live and convaiAddons.voiceSource(profileKey, player) or nil end
    -- An add-on speaker's face on a screen (addons.lua faceActor: an NPC filmed for a screen), asked once per add-on reply.
    -- Two answers: the face NPC, or nil and whether the speaker's screen face is only not ready yet (speech.lua asks again).
    speech.faceSource = function(profileKey, player)
        if not convaiAddons.live then return nil end
        return convaiAddons.faceActor(profileKey, player)
    end
    speech.log = log
    -- A remark held silent until its moment, and one that plays on while a game menu is open (addons.lua hold / menus): the request id
    -- speech.lua compares when it decides whether the voice is paused. Plain fields, set on the add-on tick.
    seams.hold = function(requestId) speech.holdRequest = requestId end
    seams.menus = function(requestId) speech.menuRequest = requestId end
    -- The face service (Face.reds), for an add-on's screen-face watch: one call per watch change, never per frame.
    seams.faceService = function()
        -- Without Codeware the service and its container's lookup do not exist: nothing to watch, and no error.
        if Game.GetScriptableServiceContainer == nil then return nil end
        return Game.GetScriptableServiceContainer():GetService(CName.new('ConvaiFaceService'))
    end
    -- An add-on remark whose speaker shows the text itself goes without a subtitle (addons.lua hideCaption), asked once per reply.
    speech.hideCaption = function(profileKey, requestId) return convaiAddons.live and convaiAddons.hideCaption(profileKey, requestId) or false end
    -- An automatic add-on remark: the same request file, reply path and playback as every other turn.
    seams.submit = function(context, anchor)
        if active or pending or automatic or microphone.context or groupChat.round then return false end
        local sent = sendRequest(context)
        if sent then speech.target = anchor end
        return sent
    end
    -- A remark the add-on scheduler withdrew: forget its request and stop its voice or caption, never a newer turn's.
    seams.drop = function(requestId, reason, entity)
        if pending and pending.requestId == requestId then pending, pendingKnowledgeOwner = nil, nil end
        if privateReply and privateReply.requestId == requestId then privateReply = nil end
        if requestFileId == requestId then requestFileId = nil; do local f = io.open('runtime/last-input.json', 'wb'); if f then f:close() end end end
        if speech.requestId == requestId then pcall(speech.stop, reason)
        elseif not speech.requestId and entity and subtitles.entity == entity and subtitles.ownsUtterance() then
            pcall(subtitles.clearEntity, entity)
        end
    end
    -- Companion joined/left events: wrap the party callback the first time an add-on asks.
    seams.watchParty = function(fn)
        if seams.partyWatched then return end
        seams.partyWatched = true
        local previous = companions.onPartyChanged
        companions.onPartyChanged = function(...)
            if previous then previous(...) end
            pcall(fn)
        end
    end
    convaiAddons.attach(seams)
end

registerHotkey('cyberpunk_convai_text', 'AI NPC Cyberpunk Mod: talk by text', function() beginText(false) end)
registerHotkey('cyberpunk_convai_group_text', 'AI NPC Cyberpunk Mod: group text chat', function() beginText(true) end)
-- The talk keys are inputs, not hotkeys: a hotkey runs its function only when the key comes back UP (docs/COMPANION_HOTKEY_INPUT.md), so a held
-- key did nothing until it was let go, and a press meant to stop a recording was only seen a moment late. An input reports both edges:
--   tap (up within HOLD_S)  toggles: the press began the recording, the next press finishes it
--   hold (up after HOLD_S)  when this very press began the recording, letting go finishes it (hold to talk)
-- Every edge and what it did is logged.
local HOLD_S = 0.3
local voiceKeys = {}
local function voiceKeyEdge(id, groupMode, isDown)
    local now = os.clock()
    local ok, err = pcall(function()
        local key = voiceKeys[id]
        if isDown then
            -- Key repeat while held repeats the down; a release that never came (focus lost) is forgotten after a quiet moment.
            if key and now - key.seen < 3 then key.seen = now; return end
            key = {at = now, seen = now}
            voiceKeys[id] = key
            local before = microphone.context and tostring(microphone.state) or 'idle'
            toggleVoice(groupMode, 'press')
            local after = microphone.context and tostring(microphone.state) or 'idle'
            key.began = before ~= 'starting' and after == 'starting'
            log('Voice key ' .. id .. ' down: recording ' .. before .. ' -> ' .. after .. (key.began and ' (this press began it)' or ''))
        else
            if not key then log('Voice key ' .. id .. ' up without a down'); return end
            voiceKeys[id] = nil
            local held = now - key.at
            local result = 'tap'
            if held >= HOLD_S and key.began then
                if microphone.context and microphone.state == 'recording' then
                    toggleVoice(groupMode, 'release')
                    result = 'hold: finish'
                else
                    result = 'hold: the device is still opening, press again to finish'
                end
            end
            log(string.format('Voice key %s up after %d ms: %s', id, math.floor(held * 1000 + 0.5), result))
        end
    end)
    if not ok then log('Voice key ' .. id .. ' failed: ' .. tostring(err)) end
end
registerInput('cyberpunk_convai_voice', 'AI NPC Cyberpunk Mod: talk by voice', function(isDown) voiceKeyEdge('voice', false, isDown) end)
registerInput('cyberpunk_convai_group_voice', 'AI NPC Cyberpunk Mod: group voice chat', function(isDown) voiceKeyEdge('group_voice', true, isDown) end)
registerHotkey('cyberpunk_convai_manager', 'AI NPC Cyberpunk Mod: companion manager', openManager)
local worldSuspended, sessionHasState = false, false
local fastTravelActive

-- Companion handles another holder still kept at a world unload (abandonSession below). They are never released: the last
-- reference to an NPC whose world is gone must not be dropped, because the puppet's destructor then releases its AI
-- component, which points into the freed world (crash dumps of 18 Oct 13:14 and 13:19 and of 23 Sep: CET's finalizer ->
-- NPCPuppet destructor -> ScriptedPuppet.aiController -> access violation). A few puppets per load, kept until the game exits.
convaiUnloadPins = convaiUnloadPins or {}
-- A weak-valued table of the party's handles (1..n) with their profile keys ('key1'..), or nil. Its own function, so the strong
-- list it reads from dies with this call's frame and is not still on abandonSession's stack during the collect.
function convaiWatchParty()
    if type(companions.heldActors) ~= 'function' then return nil end
    local ok, held = pcall(companions.heldActors)
    if not ok or type(held) ~= 'table' or #held == 0 then return nil end
    local watch = setmetatable({}, {__mode = 'v'})
    for index, row in ipairs(held) do watch[index] = row.npc; watch['key' .. index] = row.key end
    return watch
end

-- worldAlive: the old world still exists (the player's detach or death), so one collect here lets the engine destroy what the mod
-- held while it can. After the world is gone (a save restored, a world that became unavailable) nothing is collected: a finalizer
-- run then destroys a puppet of the freed world.
local function abandonSession(reason,preserveTransit,worldAlive)
    -- Never touch NPC/player components during native world destruction.
    -- pcall cannot catch an access violation in an already unloaded component.
    -- Whatever was logged so far goes to disk first: a crash in the work below must not take the lines before it along.
    if convaiLogFlush then convaiLogFlush() end
    invalidateKnowledge(reason)
    -- The party's own handles, watched weakly through the collect at the end (world alive only, never on fast travel).
    local watch = (worldAlive == true and preserveTransit ~= true) and convaiWatchParty() or nil
    -- Development probe (mod/face-test.lua): its stage keeps a companion handle (and a look-at event aimed at V) between frames.
    local faceTest = convaiFacialPlayback and convaiFacialPlayback.faceTest
    if faceTest and type(faceTest.abandon) == 'function' then pcall(faceTest.abandon, reason) end
    cancelAutomatic(reason, true)
    battles.reset()
    loot.reset(); lootObserver.reset(); lastAutomatic, mergeSuppressedUntil = nil, 0
    if convaiVTalks then convaiVTalks:reset() end
    battleSample, battlePeople, battlePoll = nil, {}, 0
    if tactics then tactics.abandon() end
    if marking then marking.abandon() end
    companions.abandon(preserveTransit==true)
    if adoption then pcall(adoption.abandon, preserveTransit==true) end
    managerUi.resetSession()
    speech.abandon()
    subtitles.abandon()
    -- A load, death or detach ends the scene; fast travel keeps the last lines.
    if preserveTransit ~= true and convaiGameDialogue then convaiGameDialogue:reset(reason) end
    if playerGear then playerGear:reset(reason) end
    if convaiTurnContext then convaiTurnContext:reset(reason) end
    microphone.cancel()
    groupChat.cancel()
    phoneChat.abandon()
    active, pending, focusUntil, focusMode, focusEntity = nil, nil, nil, nil, nil
    pendingKnowledgeOwner = nil
    if convaiTalkGate then convaiTalkGate.waiting = nil end
    if convaiAddons and convaiAddons.live then pcall(convaiAddons.reset, reason) end
    if convaiHolocall then pcall(convaiHolocall.abandon, reason) end
    focusedCrowd, releasedCrowd = nil, nil
    if convaiVanillaReactions then pcall(convaiVanillaReactions.clear) end
    -- The last crosshair search's NPC handles (targetAtCrosshair, refreshed by the gaze every 0.2 s): the whole on-foot party
    -- and every NPC near V. Kept until the next search, so without this every one of them outlived the unload (18 Oct 09:10
    -- detach: Jackie's and Johnny's handles were still held after the collect).
    convaiTalkNative = nil
    if convaiSpawnedCharacters then convaiSpawnedCharacters:reset() end
    convaiStory = nil
    if convaiFacialPlayback then convaiFacialPlayback.storyEntity = nil end
    if convaiWorldTalk then convaiWorldTalk:reset() end
    convaiHeadTalk = nil
    if convaiJohnnyHead then convaiJohnnyHead:reset() end
    if convaiJohnnyRemarks then convaiJohnnyRemarks:reset() end
    if convaiJohnnyPlaceReset then convaiJohnnyPlaceReset() end
    if convaiJohnnyRelic then convaiJohnnyRelic:reset() end
    convaiJohnnyFight = nil
    if convaiJohnnyHologram then convaiJohnnyHologram:abandon(reason) end
    -- The face service decides at each NPC's spawn, so the setting is handed over before the next world loads.
    if convaiFacialPlayback and type(convaiFacialPlayback.applyStoryTalk) == 'function' then
        pcall(convaiFacialPlayback.applyStoryTalk, manager.storyConversations())
    end
    phoneCatalogReady = false
    resetGaze()
    if convaiExpressionReset then convaiExpressionReset() end
    manager.reset()
    warmConversation(nil, nil)
    if autoConnect then pcall(autoConnect.reset) end
    publishPartyConnections(true)
    sessionHasState, poll = false, 0
    log('Session references released: ' .. reason)
    -- Every handle the mod held is dropped above; collect them now, while the engine still owns the objects, so no Lua
    -- finalizer releases a puppet or vehicle later, in the middle of the world unload or of the next session's start. A
    -- fast travel is collected too (the request, before anything moves): its old surroundings are streamed out a moment later,
    -- and a finalizer that then dropped the last reference to one of those NPCs crashed the game 50 s after a fast travel
    -- (18 Oct 16:02, the same stack as 13:14 and 13:19). The party's receipts are strong references, so they survive the collect.
    -- A world already gone is left alone (see worldAlive above). Runs once per unload or fast travel, never per frame.
    if worldAlive == true then
        pcall(collectgarbage)
        -- A companion handle that survived the collect is still referenced somewhere: pin it for good (see convaiUnloadPins).
        if watch then
            local kept = {}
            for index = 1, 64 do
                local npc = watch[index]
                if npc ~= nil then
                    convaiUnloadPins[#convaiUnloadPins + 1] = npc
                    kept[#kept + 1] = tostring(watch['key' .. index])
                end
            end
            if #kept > 0 then
                log('Unload: ' .. #kept .. ' companion handle(s) still referenced after the collect, kept alive so no finalizer destroys them after the world is gone: '
                    .. table.concat(kept, ', ') .. ' (pinned in total: ' .. #convaiUnloadPins .. ')')
            end
        end
    end
end

registerForEvent('onInit', function()
    -- The native core plugin's classes are bound by now, not when init.lua first ran.
    if convaiNative and convaiNative.pending then pcall(convaiNative.redetect, 'onInit') end
    -- Development switch for the ordinary-NPC face comparison (runtime/crowd-face-mode.txt, docs/FACIAL_ANIMATION.md). Once per
    -- load, only when the file exists; a missing file leaves the shipping mode (gated) and logs nothing.
    if convaiFacialPlayback and type(convaiFacialPlayback.applyCrowdMode) == 'function' then
        local okMode, requested, applied, problem = pcall(convaiFacialPlayback.applyCrowdMode)
        if not okMode then log('Crowd face mode failed: ' .. tostring(requested))
        elseif requested or problem then
            log('Crowd face mode: requested=' .. tostring(requested) .. ' applied=' .. tostring(applied) .. (problem and (' problem=' .. tostring(problem)) or ''))
        end
    end
    -- Talk to story characters (docs/WORLD_CHARACTERS.md): the face service prepares a named character's face at its spawn, so
    -- it is told the setting before the world loads (and again each time a world is released).
    if convaiFacialPlayback and type(convaiFacialPlayback.applyStoryTalk) == 'function' then
        local okStory, appliedStory = pcall(convaiFacialPlayback.applyStoryTalk, manager.storyConversations())
        if not okStory or appliedStory ~= true then
            log('Story character faces: setting not handed to the face service (' .. tostring(appliedStory) .. ')')
        end
    end
    -- Disk receipts grant only interrupted cleanup authority. Native unique
    -- tags are checked later in gameplay; no party/save restoration occurs.
    if type(companions.initReloadCleanup)=='function' then
        local ok,error=pcall(companions.initReloadCleanup)
        if not ok then log('Interrupted driver cleanup initialization failed: '..tostring(error)) end
    end
    convaiGuarded('Subtitle hooks', subtitles.install)
    -- Free look while V sits (docs/COMPANION_SEATING.md): one Observe pair on
    -- the player's Workspot state; widens the camera limits once per sit.
    local lookLoaded, lookResult, lookReason = pcall(function()
        convaiSeatedLookModule = dofile('seated-look.lua')
        return convaiSeatedLookModule.install({
            classify = dofile('companion-seating.lua').classify,
            -- Johnny's hologram hears of a sit and of V standing up (both do nothing while its setting is off).
            onSit = function(kind, seat) convaiJohnnyHologramMoment(kind, seat) end,
            onStand = function() convaiJohnnyHologramStand() end,
            -- False from the player's detach until the next session is up: the exit hooks then make no native call.
            live = function() return not worldSuspended end,
            log = function(kind, fields)
                if manager.developerMode() then
                    local ok, text = pcall(json.encode, fields)
                    log('Seating ' .. kind .. ' ' .. (ok and text or ''))
                end
            end,
        })
    end)
    if not lookLoaded then log('Seated free look failed: ' .. tostring(lookResult))
    elseif not lookResult then log('Seated free look unavailable: ' .. tostring(lookReason))
    else convaiSeatedLook = lookResult end
    if convaiGameDialogue then
        local hooked, installed = convaiGuarded('Game dialogue hooks', function() return convaiGameDialogue:install() end)
        if hooked and not installed then log('Game dialogue capture unavailable') end
    end
    -- Journal changes wake the resting knowledge collectors (updateKnowledge). The quest HUD's notification queue
    -- is the game's own journal listener; it fires on entry state changes only, never per frame.
    local journalHooked, journalHookError = pcall(ObserveAfter, 'JournalNotificationQueue', 'OnJournalUpdate', function()
        worldKnowledge.journalChangedAt = os.clock()
        -- Resting caches are no longer known current (see the collectors' eventDriven rule).
        if type(worldKnowledge.markChanged) == 'function' then worldKnowledge:markChanged() end
        if type(journalHistory.markChanged) == 'function' then journalHistory:markChanged() end
    end)
    if not journalHooked then log('Journal change hook unavailable: ' .. tostring(journalHookError))
    else worldKnowledge.eventDriven, journalHistory.eventDriven = true, true end
    lootObserver.configure({captureContext = captureLootContext, enabled = function() return manager.lootReactions() end})
    convaiGuarded('Loot observer hooks', lootObserver.install)
    if convaiVanillaReactions then
        local hooked, hookError = pcall(convaiVanillaReactions.install)
        if not hooked then log('Vanilla reaction hooks failed: ' .. tostring(hookError)) end
    end
    convaiGuarded('Locomotion hooks', function()
        convaiLocomotion = dofile('companion-locomotion.lua')
        convaiLocomotion.install(function(npc, command)
            return companions.ownsTravelCommand(npc, command)
        end)
    end)
    if stanceModule then convaiGuarded('Stance hooks', function() stanceModule.install(stanceBuilt, log) end) end
    if convaiNpcNames then
        local hooked, hookError = pcall(convaiNpcNames.install, ObserveAfter)
        if not hooked then log('NPC name scanner hook failed: ' .. tostring(hookError)) end
    end
    convaiGuarded('Text box hooks', function() dofile('composer-input.lua').install() end)
    convaiGuarded('Phone input hooks', function() dofile('phone-input.lua').install() end)
    convaiGuarded('Phone layout hooks', phoneLayout.install)
    convaiGuarded('Phone chat style hooks', phoneChatStyle.install)
    local ok, err = pcall(managerUi.install)
    if not ok then log('Manager registration failed: ' .. tostring(err)) end
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
        -- worldAlive: nothing has moved yet, so the collect at the end of abandonSession releases the dropped NPC handles
        -- while the engine still owns those NPCs (see the comment there).
        abandonSession('fast travel started',true,true)
    end)
    ObserveAfter('FastTravelSystem','OnLoadingScreenFinished',function(_,finished)
        if finished~=true or not fastTravelActive then return end
        fastTravelActive.finished=true
        companions.fastTravel()
        worldSuspended=false
    end)
    ObserveBefore('PlayerPuppet', 'OnDetach', function()
        worldSuspended = true
        if not fastTravelActive then
            -- A load (or a quit to the menu) has begun. The new V attaches seconds before the save is restored, while the old
            -- world is still being torn down; until OnGameRestored the mod stays suspended (18 Oct 13:32 crash: a probe's kept
            -- handle of the old Johnny was sent an AI command 4 s after this detach, from onUpdate).
            convaiHeartbeat.restoreWait, convaiHeartbeat.restoreAttached = os.clock(), nil
            abandonSession('player detached', false, true)
        elseif not fastTravelActive.finished then
            -- The teleport's own detach: the handles other hooks wrapped since the request (a callback's NPC argument is a
            -- strong reference until the next collect) are released now, while the old surroundings still exist.
            pcall(collectgarbage)
        end
    end)
    ObserveBefore('PlayerPuppet', 'OnDeath', function()
        fastTravelActive=nil
        worldSuspended = true
        abandonSession('player died', false, true)
    end)
    local function playerAttached()
        if convaiHeartbeat.restoreWait then
            convaiHeartbeat.restoreAttached = convaiHeartbeat.restoreAttached or os.clock()
            return
        end
        if not fastTravelActive or fastTravelActive.finished then worldSuspended=false end
    end
    ObserveAfter('PlayerPuppet', 'OnGameAttached', playerAttached)
    ObserveAfter('PlayerPuppet', 'OnTakeControl', playerAttached)
    ObserveAfter('PlayerSystem', 'OnGameRestored', function()
        -- Observed on a real load in the read-only probe. This clears old
        -- transient references without writing anything into the save.
        fastTravelActive=nil
        convaiHeartbeat.restoreWait, convaiHeartbeat.restoreAttached = nil, nil
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

-- onUpdate's native checks as plain functions that take what they read: a pcall(function() ... end) inside onUpdate built a
-- new closure (and boxed the locals it captured) on every frame. Globals, so the onUpdate closure gains no upvalue.
-- V attached, alive and past the main menu: true and the requests handler (the pause check reuses it), or false.
convaiSessionReady = function(player, suspended)
    if suspended or not player or not player:IsAttached() or player:IsDeadNoStatPool() then return false end
    local requests = Game.GetSystemRequestsHandler()
    return not requests:IsPreGame(), requests
end
-- The game runs, no menu is open and the composer is closed.
convaiWorldReady = function(requests, player)
    return not requests:IsGamePaused() and not convaiInMenu() and not player:ConvaiComposerOpen()
end
-- object:method() for a method without arguments, called inside the caller's pcall (no closure per call).
convaiInvoke = function(object, method) return object[method](object) end

-- The face layer's per-frame context (speech.update -> facial-playback beginExpressionFrame / updateExpressions). It was a new table
-- plus a new actors table every frame and an IsInCombat call in a pcall closure every frame (init:expressionContext about 1.1 ms/s).
-- Now ONE context table is refilled each frame (its readers only look at it during the call and keep no reference), the actor rows
-- already come from companions.expressionActors (rebuilt at most every 0.1 s), and V's combat state is sampled at that same 0.1 s
-- cadence, or at once when the party's rows were rebuilt, so a face still reacts to combat within 0.1 s. Not ready: no rows, blocked,
-- and the sample is forgotten so the first ready frame reads fresh. A global function, so onUpdate's closure gains no upvalue.
do
    local EMPTY, SAMPLE = {}, 0.1
    local context = {paused = true, actors = EMPTY, blocked = true}
    local state = {rows = nil, at = nil, blocked = true}
    -- abandonSession: the cached rows hold NPC handles, and onUpdate (which would clear them) does not run until the next session.
    convaiExpressionReset = function()
        state.rows, state.at, state.blocked = nil, nil, true
        context.actors, context.blocked, context.paused = EMPTY, true, true
        context.thinkingEntity, context.thinkingRequestId, context.listeningEntity = nil, nil, nil
    end
    convaiExpressionFrame = function(menuPlayer, worldReady, pending)
        context.paused = not worldReady
        context.thinkingEntity = pending and pending.entity
        context.thinkingRequestId = pending and pending.requestId
        context.listeningEntity = microphone.state == 'recording' and microphone.context and microphone.context.entity or nil
        if not worldReady then
            state.rows, state.at, state.blocked = nil, nil, true
            context.actors, context.blocked = EMPTY, true
            return context
        end
        local sampled, rows = pcall(companions.expressionActors, menuPlayer)
        if not sampled or type(rows) ~= 'table' then rows = EMPTY end
        local now = os.clock()
        -- A fresh rows table is the 0.1 s rebuild (or a party change); the clock check covers a failed or empty rows read.
        if rows ~= state.rows or not state.at or now < state.at or now - state.at >= SAMPLE then
            local known, inCombat = pcall(function() return menuPlayer:IsInCombat() end)
            state.blocked = not known or inCombat == true
            state.rows, state.at = rows, now
        end
        context.actors, context.blocked = rows, state.blocked
        return context
    end
end
registerForEvent('onUpdate', function(delta)
    -- Last chance for the native core plugin to bind (a global, so this closure gains no upvalue).
    if convaiNative and convaiNative.pending then pcall(convaiNative.redetect, 'onUpdate') end
    convaiHeartbeat.frame = convaiHeartbeat.frame + 1
    -- Waiting probe.log lines go out within a second of the first (see log()); an empty buffer costs one field read.
    if convaiLog.n > 0 then convaiLogTick() end
    -- A missing completion must not keep a stale travel intent armed for a
    -- later unrelated load. Expiration only drops receipts; it never restores.
    if fastTravelActive and not fastTravelActive.finished and os.time()-fastTravelActive.started>120 then
        fastTravelActive=nil; abandonSession('fast travel timed out')
    end
    -- A detach that no save restore followed (a new game started from the menu): two minutes after the new V attached, the mod resumes.
    local restoreAttached = convaiHeartbeat.restoreAttached
    if restoreAttached and os.clock() - restoreAttached > 120 then
        convaiHeartbeat.restoreWait, convaiHeartbeat.restoreAttached = nil, nil
        worldSuspended = false
    end
    if worldSuspended then return end
    -- One shared physics budget covers queued spawns, vehicle placement and
    -- walking queries in this frame, including work flushed by the manager.
    companions.beginSpatialFrame()
    local mark = convaiPerfMark
    mark('init:session')
    local menuPlayer = Game.GetPlayer()
    -- Each native call through CET costs the game thread; the world check below reuses this frame's answers.
    local sessionOk, sessionReady, requests = pcall(convaiSessionReady, menuPlayer, worldSuspended)
    if not sessionOk or not sessionReady then
        if sessionHasState then abandonSession('world unavailable',fastTravelActive~=nil) end
        if not knowledgeInvalidated then invalidateKnowledge('world unavailable') end
        -- No world (the main menu, a loading screen): the manager's page still has to answer its buttons here. The Settings page and the
        -- rest of the Mods screen work without a save; one quarter-second slow tick and a few comparisons, never in gameplay.
        local titleOk, titleError = pcall(managerUi.update, nil, false)
        if not titleOk and convaiHeartbeat.titleManagerError ~= tostring(titleError) then
            convaiHeartbeat.titleManagerError = tostring(titleError)
            log('Manager update failed without a world: ' .. tostring(titleError))
        end
        return
    end
    if fastTravelActive and fastTravelActive.finished then fastTravelActive=nil end
    sessionHasState = true
    knowledgeAllowed, knowledgeInvalidated = true, false
    mark('init:knowledge')
    local knowledgeOk = pcall(updateKnowledge, delta)
    if not knowledgeOk then invalidateKnowledge('knowledge-update-failed') end
    mark('init:worldReady')
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
    -- The session check above found V attached and not in pre-game this frame.
    local worldOk, worldReady = pcall(convaiWorldReady, requests, menuPlayer)
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
    mark('init:ui')
    ui.configure(manager.interfaceLanguage())
    local localeChanged = ui.update(tonumber(delta) or 0)
    -- The bridge's speech recognition needs the language to expect (runtime/ui-language.txt): written on a change and once at the start.
    if localeChanged or not convaiUiLanguageSent then convaiUiLanguageSent = true; pcall(microphone.publishLanguage, ui.current()) end
    if menuPlayer and convaiComposerInput then
        if convaiComposerInput.update then pcall(convaiComposerInput.update)
        elseif localeChanged and convaiComposerInput.refresh then pcall(convaiComposerInput.refresh) end
    end
    mark('init:manager')
    local managerOk, managerError = pcall(managerUi.update, menuPlayer, worldReady)
    if not managerOk then convaiLogOnce('Manager update failed: ' .. tostring(managerError)) end
    mark('init:invitations')
    -- One phone-open read per frame, shared by the request drain and the layout and style refreshes (each used to
    -- fetch the player and ask again). A failed read counts as closed, as it did for them.
    local phoneRead, phoneOpen = pcall(convaiInvoke, menuPlayer, 'ConvaiPhoneIsOpen')
    phoneOpen = phoneRead and phoneOpen == true
    local phoneActionOk, phoneActionError = true, nil
    if phoneDrainDue(phoneOpen) then
        phoneActionOk, phoneActionError = pcall(processPhoneAction, menuPlayer)
        -- A holocall asked for on the phone (mod/holocall.lua) is taken on the same drain.
        if convaiHolocall then pcall(convaiHolocall.drain, menuPlayer) end
    end
    if not phoneActionOk then convaiLogOnce('Phone action failed: ' .. tostring(phoneActionError)) end
    local invitationOk, invitationError = pcall(invitations.update)
    if not invitationOk then convaiLogOnce('Invitation preparation failed: ' .. tostring(invitationError)) end
    updatePhoneInvitationFeedback(menuPlayer, worldReady)
    -- Retain prepared and attached party connections while game time is paused.
    mark('init:partyConnections')
    publishPartyConnections(false)
    if autoConnect then pcall(autoConnect.heartbeat) end
    mark('init:phone')
    local phoneOk, phoneError = pcall(phoneLayout.refresh, false, menuPlayer, phoneOpen)
    if not phoneOk then phoneLayout.lastError = tostring(phoneError) end
    local styleOk, styleError = pcall(phoneChatStyle.refresh, false, menuPlayer, phoneOpen)
    if not styleOk then phoneChatStyle.lastError = tostring(styleError) end
    local chatOk, chatError = pcall(phoneChat.update, menuPlayer, delta)
    if not chatOk then phoneChat.lastError = tostring(chatError) end
    mark('init:expressionContext')
    local expressionContext=convaiExpressionFrame(menuPlayer,worldReady,pending)
    mark('init:speech')
    local speechOk, speechError = pcall(speech.update, tonumber(delta) or 0,expressionContext,menuPlayer)
    if not speechOk then
        convaiLogOnce('Speech update failed: ' .. tostring(speechError))
        speech.stop('error')
    end
    local subtitlesOk, subtitlesError = pcall(subtitles.update, tonumber(delta) or 0, menuPlayer)
    if not subtitlesOk then
        convaiLogOnce('Subtitle update failed: ' .. tostring(subtitlesError))
        subtitles.clear()
    end
    mark('init:poll')
    diagnosticPoll = diagnosticPoll + (tonumber(delta) or 0)
    if diagnosticPoll >= convaiDevMailboxPeriod() then -- developer mailbox; each CET io.open costs 1-3 ms
        diagnosticPoll = 0
        local request = io.open('runtime/diagnostic-request.txt', 'rb')
        if request then
            local nonce = request:read('*a')
            request:close()
            if nonce and #nonce > 0 and nonce ~= lastDiagnosticRequest then
                lastDiagnosticRequest = nonce
                -- "lua-heap:<nonce>" writes the Lua heap report (runtime/lua-heap.json, see convaiLuaHeapReport), "notice:<id>:<nonce>"
                -- shows one notice on demand (Developer mode only), "johnny-probe:..." runs a Johnny probe (mod/johnny-probe.lua,
                -- Developer mode only); anything else is a diagnostic capture.
                if nonce:find('^lua%-heap:') then pcall(convaiLuaHeapReport, nonce)
                elseif nonce:find('^notice:') then pcall(speech.devNotice, nonce)
                elseif nonce:find('^johnny%-probe:') then pcall(convaiJohnnyProbeRun, nonce)
                else captureDiagnostic() end
                local response = io.open('runtime/diagnostic-response.txt', 'wb')
                if response then response:write(nonce); response:close() end
            end
        end
    end
    poll = poll + (tonumber(delta) or 0)
    -- A reply due: the native plugin's copy of reply.json is checked every 30 ms (one revision number: no disk access, no
    -- decode), and a new reply runs this tick at once instead of up to 0.1 s later (about 40 ms sooner on average, on every
    -- reply). Without the plugin (revision() is nil) nothing changes: a CET io.open costs 1-3 ms, too much for 30 ms.
    if pending and poll < 0.1 and convaiNative and convaiNative.revision then
        replyProbe = replyProbe + (tonumber(delta) or 0)
        if replyProbe >= 0.03 then
            replyProbe = 0
            local revision = convaiNative.revision('reply.json')
            if revision and revision ~= replyRevision then replyRevision = revision; poll = 0.1 end
        end
    end
    if poll < 0.1 then return end
    local elapsedPoll = poll
    poll = 0
    mark('init:tick')
    -- This frame's V (the session check above found it attached): the tick does not ask the game a second time.
    local player = menuPlayer
    local voiceSubmission = microphone.update(player)
    if voiceSubmission then acceptVoiceSubmission(voiceSubmission) end
    if not player then
        abandonSession('world unavailable during update')
        return
    end
    if not phoneCatalogReady then
        -- A player without this mod's phone methods (the scripts did not compile) fails this on every tick, and the failure line
        -- used to be a file write ten times a second: it is retried on every tick as before, and logged once until it succeeds.
        local ok, err = pcall(companions.registerPhoneContacts, player)
        if ok then
            convaiHeartbeat.phoneCatalogFailed = nil
        elseif not convaiHeartbeat.phoneCatalogFailed then
            convaiHeartbeat.phoneCatalogFailed = true
            log('Phone catalog registration failed: ' .. tostring(err))
        end
        phoneCatalogReady = ok
    end
    if worldReady then
        -- Once per failure: a service that cannot start is reported before the player tries to talk.
        local notice = serviceCall('notice', os.time())
        if notice then convaiNotices.send(player, 'service-down', notice) end
    end
    local managerOk, managerError = pcall(manager.update, player, 0.1)
    if not managerOk then convaiLogOnce('Manager update failed: ' .. tostring(managerError)) end
    if worldReady then companions.update(player, elapsedPoll, focusEntity) end
    -- The global keeps this callback's upvalue count unchanged (LuaJIT limits upvalues).
    if worldReady and convaiCompanionAdoption then
        local adoptionOk, adoptionError = pcall(convaiCompanionAdoption.update, elapsedPoll)
        if not adoptionOk then convaiLogOnce('Companion adoption update failed: ' .. tostring(adoptionError)) end
    end
    local tacticOk, tacticError = pcall(tactics.update, player, elapsedPoll, worldReady)
    if not tacticOk then tactics.cancel('update-error'); convaiLogOnce('Companion tactic update failed: ' .. tostring(tacticError)) end
    movementLog.update(worldReady and manager.developerMode(), elapsedPoll, companions.movementSnapshot)
    mark('init:group')
    updateGroup(player)
    mark('init:battles')
    local battleOk, battleError = pcall(updateBattles, player, elapsedPoll, worldReady)
    if not battleOk then
        cancelAutomatic('observation-error')
        battleSample, battlePeople = nil, {}
        if os.time() >= (battles.errorAt or 0) then
            battles.errorAt = os.time() + 30
            log('Battle observation skipped: ' .. tostring(battleError))
        end
    end
    -- A holocall (mod/holocall.lua): only while one is asked for or running, or its switched-off camera still waits to
    -- be deleted; it ends itself on combat or a scene.
    local holocall = convaiHolocall
    if holocall and (holocall.call or holocall.request or holocall.lenses) then
        local callOk, callError = pcall(holocall.update, player, elapsedPoll, worldReady, battleSample)
        if not callOk then convaiLogOnce('Holocall update failed: ' .. tostring(callError)); pcall(holocall.finish, player, 'error') end
    end
    -- Add-ons (docs/ADDON_API.md): only once one has registered.
    if convaiAddons and convaiAddons.live then
        local addonOk, addonError = pcall(convaiAddons.tick, player, elapsedPoll, worldReady)
        if not addonOk then convaiLogOnce('Add-on update failed: ' .. tostring(addonError)) end
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
    mark('init:gaze')
    updateGaze(player, 0.1)
    if autoConnect then
        local blocked = battleSample == nil or not battleSample.available or battleSample.blocked == true
            or battleSample.combat == true
        local talking = (active and active.profileKey) or (pending and pending.profileKey)
            or (microphone.context and microphone.context.profileKey) or nil
        -- A scripted scene (or game dialogue) ends a conversation partnership.
        local scene = battleSample ~= nil and battleSample.available == true
            and (battleSample.tier ~= 1 or battleSample.dialogue == true)
        -- sceneReal: a scripted scene proper (scene tier 3 or above, as the talk refusal counts it). Tier 2 is staged gameplay,
        -- which an interaction prompt raises (a follower mod's own menu among them), and a dialogue flag or a choice hub alone is
        -- no scene: for a spawned character (a follower another mod made) only sceneReal ends the partner role (auto-connect.lua).
        local ok, err = pcall(autoConnect.update, elapsedPoll, {worldReady = worldReady == true, blocked = blocked,
            player = player, talking = talking, talkingEntity = active and speech.target or nil, scene = scene,
            sceneReal = battleSample ~= nil and battleSample.available == true and (tonumber(battleSample.tier) or 0) >= 3,
            talkingId = (active and active.entity) or (pending and pending.entity)
                or (microphone.context and microphone.context.entity) or nil})
        if not ok then convaiLogOnce('Auto-connect update failed: ' .. tostring(err)) end
    end
    mark('init:reply')
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
            -- The service is up: what it did with this turn (never taken, Local AI still loading or too slow, Convai in place of a Local AI
            -- that was not ready), read once now (mod/service-status.lua noReplyMessage), instead of guessing that it is not running.
            if not explained then
                local stateOk, providerState = pcall(manager.mistral)
                explained = serviceCall('noReplyMessage', expired.requestId, stateOk and providerState or nil, 90)
            end
            convaiNotices.send(player, 'conversation-timeout', explained or ui.t('No reply arrived. The conversation service may not be running.'))
        end
        local expiredLine = (serviceLost and 'Conversation retired after the service exited: generation=' or 'Conversation timed out: generation=')
            .. expired.generation
        -- An automatic reaction (a battle line, a pickup, a remark) that nobody answers comes round again and again while the service is down:
        -- one line for those, a line for each turn V asked for.
        if expired.reaction then convaiLogOnce('automatic reaction without a reply: ' .. (serviceLost and 'retired' or 'timed out'), expiredLine)
        else log(expiredLine) end
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
            -- The same text (a waiting turn reads the previous reply on every tick) is decoded once.
            if raw ~= replyRaw then replyRaw = raw; replyDecodeOk, replyDecoded = pcall(json.decode, raw) end
            local valid, reply = replyDecodeOk, replyDecoded
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
                        -- V's line could not be spoken (bridge/convai-bridge.mjs, V talks on their own): no notice, and no new exchange for a while.
                        if type(reply.errorCode) == 'string' and reply.errorCode:find('^vtalk%-') then
                            if convaiVTalks then pcall(convaiVTalks.silenced, convaiVTalks, os.time()) end
                        -- An add-on speaker's turn (docs/ADDON_API.md): no Mistral key or Local AI pack (one notice), or a remark
                        -- that repeated a recent line (silent). The add-on file decides; nothing else is shown.
                        elseif type(reply.errorCode) == 'string' and reply.errorCode:find('^addon%-') then
                            if convaiAddons and convaiAddons.live then convaiAddons.replyError(pending, reply, player) end
                        elseif keyId == 'key-memory' then convaiNotices.send(player, 'key-memory', keyText)
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
                        -- Custom (OpenAI-compatible) failures: the same rule.
                        elseif keyId == 'custom-key' then
                            if not pending.reaction then convaiNotices.send(player, 'custom-key', keyText) end
                        elseif keyId == 'custom-credits' then
                            if not pending.reaction then convaiNotices.send(player, 'custom-credits', keyText) end
                        elseif keyId == 'custom-model' then
                            if not pending.reaction then convaiNotices.send(player, 'custom-model', keyText) end
                        elseif keyId == 'custom-limit' then
                            if not pending.reaction then convaiNotices.send(player, 'custom-limit', keyText) end
                        elseif keyId == 'custom-daily' then
                            if not pending.reaction then convaiNotices.send(player, 'custom-daily', keyText) end
                        elseif keyId == 'custom-reasoning' then
                            if not pending.reaction then convaiNotices.send(player, 'custom-reasoning', keyText) end
                        elseif keyId == 'custom-unreachable' then
                            if not pending.reaction then convaiNotices.send(player, 'custom-unreachable', keyText) end
                        -- Local AI could not start and the turn failed: the notice for a turn V asked for, like the Mistral failures.
                        elseif keyId == 'local-fallback' then
                            if not pending.reaction then convaiNotices.send(player, 'local-fallback', keyText) end
                        -- The browser for the conversation page would not start: the same rule, with the browser named.
                        elseif keyId == 'browser-failed' then
                            if not pending.reaction then convaiNotices.send(player, 'browser-failed', keyText) end
                        -- A local turn failed and nothing took it over: the same rule, its own notice.
                        elseif keyId == 'local-failed' then
                            if not pending.reaction then convaiNotices.send(player, 'local-failed', keyText) end
                        -- Local AI could not start and nobody took the turn over: the same rule, with Local AI's own reason.
                        elseif keyId == 'local-unavailable' then
                            if not pending.reaction then convaiNotices.send(player, 'local-unavailable', keyText) end
                        elseif keyId == 'local-no-memory' then
                            if not pending.reaction then convaiNotices.send(player, 'local-no-memory', keyText) end
                        elseif keyId == 'mistral-no-key' or keyId == 'mistral-voice' or keyId == 'custom-no-setup' or keyId == 'custom-voice' then
                            sendProviderNotice(player, keyId, keyText)
                            if not pending.reaction then convaiNotices.send(player, 'reply-error', reply.error) end
                        elseif keyId then convaiNotices.send(player, 'quota-exhausted', keyText)
                        elseif not pending.reaction then convaiNotices.send(player, 'reply-error', reply.error) end
                    else
                        -- The first reply that runs without memory on a limited plan says so once.
                        local keyId, keyText = keyReplyNotice(reply)
                        if keyId == 'key-memory' then convaiNotices.send(player, 'key-memory', keyText) end
                        sendProviderNotice(player, keyId, keyText)
                        -- An add-on remark's text goes to its remarkStarted event (docs/ADDON_API.md): one table write, no native call.
                        if pending.reaction and pending.reaction.kind == 'addon' and convaiAddons and convaiAddons.live then
                            pcall(convaiAddons.replyText, pending, reply.text)
                        end
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
                    if type(microphone.received) == 'function' then microphone.received(pending.requestId) end
                    -- One line per reply: did speech start, and does the speaker's face carry
                    -- the speech layer (an ordinary world NPC gets it at its spawn, Face.reds OnWorldInitialize).
                    local faceState, faceNote = 'none', ''
                    if speech.actor then
                        local faceOk, faceReady, faceStatus = pcall(function()
                            return speech.actor:ConvaiFaceReady(), speech.actor:ConvaiFaceStatus() end)
                        faceState = faceOk and (tostring(faceReady) .. '/' .. tostring(faceStatus)) or 'unavailable'
                        -- A reply whose speaker's mouth will not move says why, with the facts that name a replaced model.
                        if not (faceOk and faceReady == true) and convaiFacialPlayback and convaiFacialPlayback.faceNote then
                            local noted, text = pcall(convaiFacialPlayback.faceNote, speech.actor, faceOk and faceStatus or 'unavailable')
                            if noted and type(text) == 'string' then faceNote = text end
                        end
                    end
                    -- A voice that could not start says why (speech.lua keeps the reason in speech.error), once, on the same line.
                    local why = speech.state == 'playback-failed' and speech.error and (' why=' .. tostring(speech.error):sub(1, 160)) or ''
                    local resultLine = 'Conversation result: generation=' .. pending.generation .. ' error=' .. tostring(reply.error ~= nil)
                        .. ' speech=' .. tostring(speech.state) .. ' face=' .. faceState .. why .. faceNote
                    -- A failed turn that fails the same way every time (Local AI not installed, no browser, a key refused) is one console line per
                    -- failure code and session, the rest counted in probe.log; the notice on screen still shows each one (notices.lua repeat windows).
                    if reply.error ~= nil then convaiLogOnce('result-error:' .. tostring(reply.errorCode or ''), resultLine) else log(resultLine) end
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
    local ok, ready = pcall(convaiInvoke, player, 'ConvaiHasSubmission')
    if not ok or not ready then
        if active then
            local openOk, composerOpen = pcall(convaiInvoke, player, 'ConvaiComposerOpen')
            if openOk and not composerOpen then
                pcall(convaiComposerWatch.closed, player, active)
                active = nil
                warmConversation(nil, nil)
                focusUntil = os.time() + 1
            end
        end
        return
    end
    local taken, message = pcall(convaiInvoke, player, 'ConvaiTakeSubmission')
    if taken and type(message) == 'string' and #message > 0 then
        local context = active
        if context then
            local sent = true
            if context.participants then
                groupChat.start('group-' .. tostring(os.time()) .. '-' .. tostring(context.generation), context.participants, message)
            else
                context.requestId = tostring(os.time()) .. '-' .. tostring(context.generation) .. '-' .. context.entity
                context.text = message
                context.sentAt = os.time()
                sent = sendRequest(context)
            end
            log('Native input captured: generation=' .. context.generation .. ' bytes=' .. #message)
            -- What V types is V's line: shown in the cinematic subtitles as V's own (docs/V_VOICE.md, "V's subtitle"), whether or not V's
            -- voice speaks it, and replaced by the reply's caption. Once per sent line; nothing per frame. A refused or off subtitle is silent.
            if sent ~= false then pcall(subtitles.showTyped, message) end
            -- The request could not be written (the world changed, a save is running, the request file is locked): V must know.
            if sent == false then pcall(convaiComposerWatch.lost, player, 'request not sent', context) end
        else
            log('Late native input discarded after target loss')
            pcall(convaiComposerWatch.lost, player, 'target lost before the text arrived')
        end
    elseif not taken then
        -- The game said a message was ready and reading it failed (an empty or non-text result is just "nothing taken").
        pcall(convaiComposerWatch.lost, player, 'submission unreadable (' .. tostring(message) .. ')', active)
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
    if convaiHolocall then
        if liveWorld then pcall(convaiHolocall.finish, Game.GetPlayer(), 'shutdown') else pcall(convaiHolocall.abandon, 'shutdown') end
    end
    managerUi.shutdown(liveWorld)
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
    if convaiSpawnedCharacters then convaiSpawnedCharacters:reset() end
    pcall(movementLog.flush) -- buffered Developer movement trace
    if convaiAddons and convaiAddons.live then pcall(convaiAddons.reset, 'shutdown') end
    focusMode = nil
    focusEntity = nil
    log('Game adapter shut down')
    convaiLogFlush() -- the buffered probe.log lines (a CET reload or exit follows)
    -- The Developer-mode perf probe wraps json, io and os functions (perf-probe.lua). They are put back here, so no wrapper (and
    -- through it this load's whole environment, about 15 MB) can stay reachable from a table CET keeps across a reload
    -- (deliverables/perf/LUA_HEAP.md). Nothing runs after onShutdown, so nothing else changes.
    if type(convaiPerfProbe) == 'table' and type(convaiPerfProbe.uninstall) == 'function' then pcall(convaiPerfProbe.uninstall) end
end)

-- GetMod('AiNpcCyberpunkMod') returns this table to other CET mods. `addons` is the add-on API (docs/ADDON_API.md).
return {addons = convaiAddons and convaiAddons.public or nil}
