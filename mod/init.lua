-- Start-up clock (probe.log "Start-up:" lines): when this file began, then the load, onInit and title-screen figures. A global, so no local slot.
pcall(function() convaiBoot = {t0 = os.clock(), frames = 0, worst = 0, total = 0, gapWorst = 0, slow = 0, slowSum = 0, big = {}, ownTotal = 0, ownWorst = 0} end)
-- AI NPC Cyberpunk Mod game adapter. It never renders an ImGui text field.
-- Owns native composers, targeted turns, party connections and live diagnostics.
-- probe.log and mcm.log are appended for ever (many thousands of lines over weeks of play): once per load, before the native core takes over io,
-- a file over its cap keeps only its last quarter, in place (a rewrite of the same file: Mod Organizer 2 never sees a new or deleted file).
-- LOG-TRIM-BEGIN
pcall(function()
    local function trim(path, maxBytes, keepBytes)
        local file = io.open(path, 'rb')
        if not file then return end
        local size = file:seek('end')
        if not size or size <= maxBytes then file:close(); return end
        file:seek('set', size - keepBytes)
        local tail = file:read(keepBytes)
        file:close()
        if not tail then return end
        local newline = tail:find('\n', 1, true)
        if newline then tail = tail:sub(newline + 1) end
        local out = io.open(path, 'wb')
        if not out then return end
        out:write(tail)
        out:close()
    end
    trim('runtime/probe.log', 1048576, 262144)
    trim('runtime/mcm.log', 262144, 65536)
end)
-- LOG-TRIM-END
-- Optional native core plugin: routes the bridge mailbox files through its worker thread when
-- present (native-core.lua). Without the plugin, io and os stay unchanged.
pcall(function() dofile('native-core.lua').install() end)
-- Developer-mode probe: count and time every hook and onUpdate (no effect otherwise).
pcall(function() dofile('perf-probe.lua').hookRegistrations() end)
-- The one way the whole mod asks for V (mod/player-guard.lua). Game is shared by every CET mod and one of them replaced Game.GetPlayer with a
-- table (error report aa500cce), which made every call below raise. Loaded right after the native io shim and the perf probe (neither asks for V), so the original Game.GetPlayer is captured before any other
-- mod's onInit. A global, so no function gains an upvalue; without the file it is the plain call.
do
    local loaded, guard = pcall(dofile, 'player-guard.lua')
    convaiPlayerGuard = loaded and type(guard) == 'table' and type(guard.get) == 'function' and guard or nil
    convaiPlayer = convaiPlayerGuard and convaiPlayerGuard.get or function() return Game.GetPlayer() end
end
-- Game 2.5 changed TargetingSystem.GetCrosshairData(owner) into GetCrosshairData(ownerID, owner). Every caller goes through this: it tries the 2.31
-- form once and keeps whichever form answers (both return the crosshair position and direction).
local crosshairForm = nil
function ConvaiCrosshairData(targeting, player)
    if crosshairForm == '2.5' then return targeting:GetCrosshairData(player:GetEntityID(), player) end
    if crosshairForm == '2.31' then return targeting:GetCrosshairData(player) end
    local ok, position, forward = pcall(targeting.GetCrosshairData, targeting, player)
    if ok then crosshairForm = '2.31'; return position, forward end
    position, forward = targeting:GetCrosshairData(player:GetEntityID(), player)
    crosshairForm = '2.5'
    return position, forward
end
-- Is the service still restoring the player's saved files (mod/state-restore.lua, docs/PACKAGING.md "Mod Organizer 2")? A global: the readers
-- of settings.json, phone-history.json, addon-settings.json and npc-names.json ask it only when their file is missing or empty. Absent, they
-- behave as they always did.
do
    local restoreLoaded, restoreModule = pcall(dofile, 'state-restore.lua')
    convaiStateRestore = restoreLoaded and type(restoreModule) == 'table' and restoreModule or nil
end
-- Add-on API (mod/addons.lua, docs/ADDON_API.md). A global, so no function here gains an upvalue. Until an add-on registers,
-- convaiAddons.live is false and every call below is skipped: the main mod behaves exactly as it does without the file.
-- Loaded before the catalogs (companions.lua, the roster below): a content pack's new names (mod/content-names.lua) ask it which packs are on.
do
    local loaded, module = pcall(dofile, 'addons.lua')
    convaiAddons = loaded and type(module) == 'table' and module or nil
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
-- The Conversation provider the player has chosen, for the requests and microphone commands the game writes (the bridge follows it for that turn). Settings
-- are cached; nothing is read from a file here.
local function chosenProvider()
    local ok, provider = pcall(function() return manager.conversationProvider() end)
    return ok and type(provider) == 'string' and provider or nil
end
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
local knowledgePhone = {capture = nil, receipts = {}}
local invitations
local knowledgeLaunch = 'lua-world-' .. tostring(os.time()) .. '-' .. tostring(math.random(100000000, 999999999))
local worldSessionState = {signature = nil, at = nil, token = nil, ready = nil}
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
    -- True only inside updateKnowledge, after this frame's session check: the scan then re-checks the journal only.
    sessionProven = function() return convaiHeartbeat ~= nil and convaiHeartbeat.sessionProven == true end,
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

local function publishWorldSession(frame, ready, force)
    local now = os.time()
    -- Unchanged and still leased (the common case, twice per frame): no table or string is built.
    if not force and frame and frame.worldToken == worldSessionState.token and (ready == true) == worldSessionState.ready
        and worldSessionState.at and now >= worldSessionState.at and now - worldSessionState.at < 2 then return end
    -- `loading`: a save is being loaded (set by the PlayerPuppet OnDetach observer just before the session is abandoned, whose forced write below carries it), no world yet. The service
    -- starts V's helper voice then (it waited out the title screen, which has a key press to answer) instead of once the world exists, so it is ready sooner. Cleared by the first
    -- ready write; a field of a table that already exists, one more key in a write that happens anyway, nothing per frame.
    local value = {version = 1, token = frame and frame.worldToken or (knowledgeLaunch .. '-' .. (knowledgeEpoch + 1)),
        generation = frame and frame.generation or (knowledgeEpoch + 1), ready = ready == true, updated = now * 1000,
        loading = ready ~= true and convaiHeartbeat.loading or nil}
    if ready == true then convaiHeartbeat.loading = nil end
    local signature = value.token .. ':' .. tostring(value.ready)
    -- Lease heartbeat: the bridge keeps world-session.json 5 s; refresh it every 2 s or on change.
    if not force and signature == worldSessionState.signature and worldSessionState.at and now >= worldSessionState.at
        and now - worldSessionState.at < 2 then return end
    if not force and signature == worldSessionState.signature and not convaiHeartbeatSlot() then return end
    local encoded, raw = pcall(json.encode, value); if not encoded then return end
    -- In place: one open instead of open+remove+rename (about 9 ms of the game
    -- thread every 2 s). readWorldSession retries a partial read 3 times, 15 ms apart.
    local file = io.open('runtime/world-session.json', 'wb'); if not file then return end
    local written, closed = file:write(raw), file:close(); if not written or not closed then return end
    worldSessionState.signature, worldSessionState.at = signature, now
    worldSessionState.token, worldSessionState.ready = frame and frame.worldToken or nil, ready == true
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
    knowledgeAllowed, knowledgeFrame, knowledgePhone.capture = false, nil, nil
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
    if not convaiHistoryWanted() then return end
    -- A history scan already under way (the first one after a load takes minutes when paced) finishes at full speed now.
    if not lanes and type(journalHistory.scanning) == 'function' and journalHistory:scanning('history') then
        lanes = {'active', 'history'}
    end
    pcall(journalHistory.demand, journalHistory, lanes or {'active'}, 0)
end
-- Whether the journal history is scanned and sent: Settings > Dynamic info > Quest and journal, or Johnny's remarks about a finished job (they
-- need the scan to see one). Off, the scan is not stepped and not asked for, and a request carries it as unavailable. The switches are the table
-- manager.lua publishes (convaiDynamicInfo; nil before the settings load: on). A global, like the callers below.
function convaiHistoryWanted()
    local flags = convaiDynamicInfo
    if flags == nil or flags.quest ~= false then return true end
    return manager.johnnyRemarks() ~= 'off' and manager.johnnyInHead()
end
local function updateKnowledge(delta)
    -- A journal change (JournalNotificationQueue.OnJournalUpdate, onInit) rescans everything once the burst settles;
    -- opening phone chat with a contact rescans before V's first message there.
    local dirty = worldKnowledge.journalChangedAt
    if dirty and os.clock() - dirty >= 1 then
        worldKnowledge.journalChangedAt = nil
        pcall(worldKnowledge.demand, worldKnowledge, 0)
        if convaiHistoryWanted() then pcall(journalHistory.demand, journalHistory, {'active', 'history'}, 0) end
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
    worldKnowledge:update(context)
    -- Quest and journal off: the journal scan is not stepped. Turned on again, it is asked for once at the first frame (a turn would otherwise
    -- find nothing until the scan's own next rest was over). With the switch on (the default) this is one table read and one comparison.
    local flags = convaiDynamicInfo
    if flags == nil or flags.quest ~= false or convaiHistoryWanted() then
        if convaiHistoryWas ~= nil then
            convaiHistoryWas = nil
            pcall(journalHistory.demand, journalHistory, {'active', 'history'}, 0)
        end
        journalHistory:update(context)
    else convaiHistoryWas = false end
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
        local historyOn = convaiHistoryWanted()
        if byRevision and knowledgeParts then
            local parts = {}
            local worldOk, worldHeader, worldPart = pcall(worldKnowledge.capturePart, worldKnowledge, binding)
            local historyOk, historyHeader, historyParts
            if historyOn then historyOk, historyHeader, historyParts = pcall(journalHistory.capturePart, journalHistory, binding)
            else historyOk, historyHeader, historyParts = true, knowledgeUnavailable('switched-off'), {} end
            if worldOk and historyOk and type(worldHeader) == 'table' and type(historyHeader) == 'table' then
                if worldPart then parts[#parts + 1] = worldPart end
                for _, part in ipairs(historyParts or {}) do parts[#parts + 1] = part end
                local ok, done = pcall(knowledgeParts.publish, parts)
                if ok and done then world, history, published = worldHeader, historyHeader, true end
            end
        end
        if not published then
            world = worldKnowledge:capture(binding)
            history = historyOn and journalHistory:capture(binding) or knowledgeUnavailable('switched-off')
        end
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
        -- A companion settled in V's flat can be asked to come along (mod/companion-settle.lua).
        local settled = convaiSettleOffer and convaiSettleOffer(entity, context)
        if settled then return settled end
        return adoption and adoption.offer(entity, conversationNpc(entity), context.profileKey, context.name) or nil
    end,
    leaveOffer = function(entity, context)
        -- A character another mod or a spawner created makes no offers about our party (docs/SPAWNED_CHARACTERS.md).
        local round = groupChat.round
        for _, person in ipairs(round and round.participants or {}) do
            if person.entity == entity and person.spawned then return nil end
        end
        local offer = adoption and adoption.leaveOffer(entity, context) or nil
        -- A housemate who lives in another of V's flats is asked first (mod/housemates.lua).
        if offer and convaiHousemateLeaveOffer then offer = convaiHousemateLeaveOffer(offer) end
        return offer
    end,
    queueFollow = function(offer, entity, requestId)
        if convaiSettleFollow and convaiSettleFollow(entity) then return true end
        if not adoption then return false, ui.t('That action is not available.') end
        return adoption.queueFollow(offer, entity, requestId)
    end,
    queueLeave = function(target, offer, entity, requestId, groupId)
        if not adoption then return false, ui.t('That action is not available.') end
        if convaiHousemateQueueLeave then
            return convaiHousemateQueueLeave(target, offer, entity, requestId, groupId,
                function(t, o, e, r, g) return adoption.queueLeave(t, o, e, r, g) end)
        end
        return adoption.queueLeave(target, offer, entity, requestId, groupId)
    end,
    -- Housemates: moving in and out, and calling the ones at home along (docs/HOUSEMATES.md).
    homeOffer = function(entity, context)
        if convaiStory and convaiStory.entity == entity then return nil end
        return convaiHousemateOffer and convaiHousemateOffer(entity, context) or nil
    end,
    groupHomeOffer = function(entity, context)
        return convaiHousemateGroupOffer and convaiHousemateGroupOffer(entity, context) or nil
    end,
    queueHome = function(home, offer, entity, requestId, groupId)
        if not convaiHousemateQueue then return false, ui.t('That action is not available.') end
        return convaiHousemateQueue(home, offer, entity, requestId, groupId)
    end,
    -- An ordinary world NPC's reaction to the conversation (docs/NPC_REACTIONS.md, mod/npc-reactions.lua): leave, call the police or
    -- attack. A global service, so these two lines add no upvalue. Nothing is offered or started when the module is missing.
    reactionOffer = function(entity, context)
        return convaiNpcReactions and convaiNpcReactions.offer(entity, context) or nil
    end,
    queueReaction = function(kind, offer, entity, requestId)
        if not convaiNpcReactions then return false, 'not-available' end
        return convaiNpcReactions.start(kind, offer, entity, requestId)
    end,
    -- A meeting V may ask for on a holocall (docs/IMMERSIVE_INVITATIONS.md, "Holocalls"): nothing is offered while Immersive invitations is Off.
    meetOffer = function(entity, context)
        return convaiMeetCallOffer and convaiMeetCallOffer(context) or nil
    end,
    queueMeet = function(kind, offer, profileKey, requestId)
        if not convaiMeetCallAccept then return false, 'not-available' end
        return convaiMeetCallAccept(profileKey, kind, offer)
    end,
    developerMode = manager.developerMode,
    feedback = function(state, reason)
        local player = convaiPlayer()
        -- A queued action with no text posts nothing: a queued drive has none.
        if state == 'queued' and (reason == nil or reason == '') then return end
        if player then convaiNotices.send(player, state == 'queued' and 'action-queued' or 'action-rejected',
            ui.t(reason or 'The driving request could not be queued.')) end
    end})
convaiGameplayActions = gameplayActions
microphone.captureActions = function(context)
    -- Eddies with characters (docs/EDDIES.md): the spoken turn's block, before any return below (a game-placed character talks about money too).
    if not context.reaction and not context.group then convaiEddiesAttach(context) end
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
    for _, prior in ipairs(knowledgePhone.receipts) do if prior.id == receipt.id then return end end
    local row = {version = 1, source = 'phone-ui', state = 'accepted', partial = false, cancelled = false}
    for _, key in ipairs({'id', 'requestId', 'profileKey', 'contact', 'world', 'binding', 'worldToken'}) do
        if type(receipt[key]) == 'string' and #receipt[key] <= 600 then row[key] = receipt[key] end
    end
    for _, key in ipairs({'sequence', 'completedAt', 'generation'}) do
        local value = receipt[key]
        if type(value) == 'number' and value == value and value >= 0 and value < math.huge then row[key] = value end
    end
    if not row.requestId or not row.profileKey or not row.world or not row.binding or not row.completedAt then return end
    knowledgePhone.receipts[#knowledgePhone.receipts + 1] = row
    if #knowledgePhone.receipts > 16 then table.remove(knowledgePhone.receipts, 1) end
    local ok, raw = pcall(json.encode, {version = 1, updated = os.time() * 1000, receipts = knowledgePhone.receipts})
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
-- Settings > Dynamic info: a kind that is off is not read from the game for a turn. The capture functions of the collectors are wrapped once, here,
-- so every caller (private text, voice, group, phone) is covered and a switch that is off costs one table lookup at send time, nothing per frame.
-- Quest and journal: the tracked quest. (V's gear and clothes and the recent game dialogue are wrapped where those modules are made, below.) Called
-- with or without self, so it fits a function and a method alike. A manager without the setting is on. The battle module's own capture is NOT wrapped:
-- battle reactions (mod/battle-reactions.lua) read it for their own subject and must always carry their fight; only the readers of a manual turn are
-- gated (battles.captureManual, below).
function convaiGateCapture(owner, name, kind)
    local original = type(owner) == 'table' and owner[name] or nil
    if type(original) ~= 'function' then return end
    owner[name] = function(...)
        local ask = manager.dynamicInfo
        if ask ~= nil and not ask(kind) then return nil end
        return original(...)
    end
end
convaiGateCapture(questContext, 'capture', 'quest')
-- Health, heat and fights: the last fight, for a manual turn (group, phone, microphone and typed text). A reaction's own fight is never gated.
function battles.captureManual()
    local ask = manager.dynamicInfo
    if ask ~= nil and not ask('condition') then return nil end
    return battles.capture()
end
groupChat.captureJournal = questContext.capture
phoneChat.captureJournal = questContext.capture
microphone.captureJournal = questContext.capture
groupChat.captureBattle = battles.captureManual
phoneChat.captureBattle = battles.captureManual
microphone.captureBattle = battles.captureManual
convaiPhoneChat = phoneChat
convaiGroupChat = groupChat
-- Phone Chat keeps the draft and shows this inline when no service can reply.
phoneChat.serviceBlocked = function() return (serviceCall('blockedMessage', os.time())) end
-- The characters in the party (a copy present or an invitation being prepared, not one on her way out), by profile key: the Chat list shows Dismiss for
-- these and Invite for the others (phone-chat.lua pushParty, asked only while the phone is open).
phoneChat.partyKeys = function()
    local queue = managerUi.party and managerUi.party()
    if not queue then return nil end
    local keys = {}
    for _, item in ipairs(queue.list()) do
        local key = item.profileKey or item.key
        if key and item.state ~= 'leaving' and item.state ~= 'failed' then keys[key] = true end
    end
    return keys
end
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
    local encodedOk, encoded = true, '{}'
    if preparation then encodedOk, encoded = pcall(json.encode, preparation) end   -- before the file is opened: a raise must not leave it emptied and open
    if not encodedOk then return end
    local f = io.open('runtime/group-prefetch.json', 'wb')
    if not f then return end
    f:write(encoded); f:close()
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
        -- Content packs (mod/content-names.lua): the new names of the packs that are on are laid over the rows here, once, so every reader of
        -- the roster (the catalog, the manager, the phone, the party) shows them; the old name stays an alias. A switch counts from the next game start.
        local namesLoaded, contentNames = pcall(dofile, 'content-names.lua')
        if namesLoaded and type(contentNames) == 'table' then pcall(contentNames.applyRows, profiles) end
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
            and function(key)
                local label = characterCatalog.archetypeLabel(archetypes, key)
                -- A content pack may rename an archetype too (mod/content-names.lua, loaded with the roster above): its name, else the shipped label.
                if type(convaiContentNames) == 'table' then label = convaiContentNames.label(key, label) end
                return label
            end or nil)
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
        knowledgePhone.capture = captureKnowledge({profileKey = key}, 'phone', true)
        return knowledgePhone.capture and knowledgePhone.capture.worldKnowledge or knowledgeUnavailable()
    end,
    captureJournalHistory = function()
        local captured = knowledgePhone.capture; knowledgePhone.capture = nil
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
                -- The copies from the Model browser take (or give back) the character they match.
                if type(convaiSettleCopyProfiles) == 'function' then convaiSettleCopyProfiles() end
                -- Each is also a character to invite (the Companion Manager) and a contact to text (the phone's Chat tab), under its own name: made, renamed or deleted, the lists follow.
                local rows = self.list()
                if type(manager.setCustomCharacters) == 'function' then pcall(manager.setCustomCharacters, rows) end
                if type(phoneChat.setContacts) == 'function' then pcall(phoneChat.setContacts, 'custom', #rows > 0 and rows or nil) end
            end})
        if created and type(service) == 'table' then
            convaiCustomCharacters = service
            -- A Chat with one of them is open only while Google Gemini, Local AI or Custom answers (asked when the chat is painted, never per frame).
            phoneChat.contactBlocked = function(key) return service.has(key) and not service.providerReady() end
            if type(manager.configureCustom) == 'function' then manager.configureCustom(function(key) return service.has(key) end) end
            pcall(service.refresh, true)
        else print('[CyberpunkConvai] custom-characters.lua failed: ' .. tostring(service)) end
    else print('[CyberpunkConvai] custom-characters.lua unavailable: ' .. tostring(module)) end
end
-- What the player chose for a character in the editor's "Look and moves" part (docs/CHARACTER_EDITOR.md): its look, its gestures and idle moves, whether it sits, whether it
-- comments on fights and loot. mod/character-options.lua reads runtime/character-options.json at load and, for two hours after the editor was opened, every few seconds from
-- the 10 Hz tick; a character with no choice is exactly as before. A global with no new upvalue; optional like the modules around it.
do
    local loaded, module = pcall(dofile, 'character-options.lua')
    if loaded and type(module) == 'table' and type(module.new) == 'function' then
        local created, service = pcall(module.new, {
            -- A saved look is worn soon, not at the next 20 s look at the party.
            onChange = function() if convaiOutfits and convaiOutfits.nudge then convaiOutfits.nudge() end end})
        if created and type(service) == 'table' then
            convaiCharacterOptions = service
            -- A character the player switched off in the editor is never a talk target or listener (manager.profileEnabled, one table lookup).
            manager.switchedOff = service.off
            pcall(service.refresh)
        else print('[CyberpunkConvai] character-options.lua failed: ' .. tostring(service)) end
    else print('[CyberpunkConvai] character-options.lua unavailable: ' .. tostring(module)) end
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
local gazeState = {candidate = nil, dwell = 0, lost = 0, poll = 0}
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
local archetypeFactMemo = {cache = {}, count = 0}
local function nameString(value)
    if type(value) == 'string' then return value end
    if value == nil then return nil end
    local ok, text = pcall(function() return Game.NameToString(value) end)
    if ok and type(text) == 'string' and text ~= '' and text ~= 'None' then return text end
    ok, text = pcall(tostring, value)
    return ok and type(text) == 'string' and text or nil
end
local function archetypeFacts(npc, entity, body)
    local cached = entity and archetypeFactMemo.cache[entity]
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
        if archetypeFactMemo.count >= 256 then archetypeFactMemo.cache, archetypeFactMemo.count = {}, 0 end
        archetypeFactMemo.cache[entity], archetypeFactMemo.count = facts, archetypeFactMemo.count + 1
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
    local managedKey, managedName, owned, serial, copyRecord, copyName, ready, carried = companions.identity(npc)
    local name = managedName or tostring(npc:GetTweakDBFullDisplayName(true) or 'NPC')
    local body = tostring(npc:GetBodyType() or '')
    -- Our own copy with no conversation profile is still one of the player's characters when its model matches one (docs/CHARACTER_EDITOR.md
    -- "Matching"); without any character made, or while it is still being created, it has no profile as before.
    if owned and not managedKey and not (ready and catalog.custom) then return nil, name, body end
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
    if owned then
        -- A copy of ours is found by the model it was made from (the original record, not the private clone the game spawned) and its name.
        actor.copy, actor.copyRecord, actor.copyName = true, copyRecord, copyName
    end
    if not managedKey and not owned and (forceFacts or (type(manager.archetypeConversations) == 'function' and manager.archetypeConversations())) then
        local idOk, entity = pcall(function() return tostring(npc:GetEntityID().hash) end)
        actor.facts = archetypeFacts(npc, idOk and entity or nil, body)
    end
    local key, canonical, archetype = characterCatalog.resolve(catalog, actor)
    -- The copy carries what it resolved to (party rows, connections, subtitles): only when that differs from what it carries now.
    if owned and ready and serial and key ~= carried then pcall(companions.settleProfile, serial, key, canonical) end
    return key, canonical, body, archetype
end

-- Every copy of ours against the player's characters: when the list changed and at each talk key press (a few table lookups on the few copies, never
-- per frame). A copy of a model that is not a roster character becomes the custom character it matches, and goes back to its own profile when that
-- character is deleted or Convai answers. A global, so no function here gains an upvalue.
function convaiSettleCopyProfiles()
    if type(companions.settleProfiles) ~= 'function' then return end
    pcall(companions.settleProfiles, function(baseKey, baseName, record, model)
        local key, name = characterCatalog.resolve(catalog, {managedKey = baseKey, copy = true, name = baseName, copyRecord = record, copyName = model})
        return key, name
    end)
end

-- Why a talk target ended with no profile, as the tail of the one probe-log line the talk key writes (a key press only, never per frame).
-- The catalogue gives a game-placed person no profile when the game owns them: a quest flag or a q/sq/mq record ("story-bound", the scene
-- extras of a quest) and a named roster character are never turned into a resident (docs/WORLD_CHARACTERS.md). Without this line "profile=nil"
-- cannot tell that from a classification gap. A global, so no function here gains an upvalue; every read is guarded.
function convaiUnprofiledWhy(npc)
    local ok, text = pcall(function()
        local idOk, entity = pcall(function() return tostring(npc:GetEntityID().hash) end)
        local facts = archetypeFacts(npc, idOk and entity or nil, tostring(npc:GetBodyType() or ''))
        local _, reason = characterCatalog.classify(archetypes, facts)
        local protected = characterCatalog.protectedReason(catalog, {record = facts.recordId or '',
            name = tostring(npc:GetTweakDBFullDisplayName(true) or ''), facts = facts})
        local record = tostring(facts.recordName or facts.recordId or '?'):sub(1, 80)
        return ' (classify=' .. tostring(reason) .. ' protected=' .. tostring(protected) .. ' crowd=' .. tostring(facts.crowd)
            .. ' quest=' .. tostring(facts.quest) .. ' record=' .. record .. ')'
    end)
    return ok and text or ''
end

-- The notice the talk key shows for a target that ends with no profile, in plain words (a key press only, never per frame). Every
-- person the game placed gets a conversation (character-catalog fallbackKey), so what is left is a story character while Talk to story
-- characters is off, Talk to ordinary NPCs switched off, a child, a machine or animal, or someone whose voice type cannot be told.
-- Returns the text, or nil when none of those fits (the caller then keeps the old line). A global, so no function here gains an upvalue.
function convaiUnprofiledNotice(npc, name)
    local ok, text = pcall(function()
        local idOk, entity = pcall(function() return tostring(npc:GetEntityID().hash) end)
        local body = tostring(npc:GetBodyType() or '')
        local facts = archetypeFacts(npc, idOk and entity or nil, body)
        local recordOk, record = pcall(function() return tostring(npc:GetRecordID()) end)
        local reason = characterCatalog.noProfileReason(catalog, {record = recordOk and record or '',
            name = tostring(npc:GetTweakDBFullDisplayName(true) or ''), facts = facts, bodyType = body})
        if reason == 'named' and not manager.storyConversations() then
            return ui.t('{name} is a story character. Turn on Talk to story characters in Esc > Mods.', {name = name})
        end
        if reason ~= 'named' and not manager.archetypeConversations() then
            return ui.t('Talk to ordinary NPCs is off. Turn it on in Esc > Mods.')
        end
        if reason == 'child' then return ui.t('{name} is a child and cannot be talked to.', {name = name}) end
        if reason == 'not-human' then return ui.t('{name} is not a person and cannot be talked to.', {name = name}) end
        if reason == 'no-gender' then return ui.t('{name} cannot be talked to: the mod cannot tell which voice fits.', {name = name}) end
        return nil
    end)
    return ok and text or nil
end

-- The identity the roster lookup saw, as the tail of the "Archetype conversation" log line (a talk key press only, never per frame): the record's hash
-- string (what characterCatalog.resolve compares first), its readable record name (facts.recordName, the second lookup) and the display name (the third).
-- Without it a named character that fell to an archetype cannot be told from a roster gap (2026-10-22 report: Panam talked to as npc-aldecaldos-female).
-- A global, so no function here gains an upvalue; every read is guarded and archetypeFacts is cached per entity.
function convaiArchetypeIdentity(npc)
    local ok, text = pcall(function()
        local idOk, entity = pcall(function() return tostring(npc:GetEntityID().hash) end)
        local facts = archetypeFacts(npc, idOk and entity or nil, tostring(npc:GetBodyType() or ''))
        local nameOk, display = pcall(function() return tostring(npc:GetTweakDBFullDisplayName(true) or '?') end)
        return ' recordId=' .. tostring(facts.recordId or '?'):sub(1, 80) .. ' recordName=' .. tostring(facts.recordName or '?'):sub(1, 80)
            .. ' name=' .. (nameOk and display or '?'):sub(1, 60)
    end)
    return ok and text or ''
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

-- What a conversation can do to an ordinary world NPC (docs/NPC_REACTIONS.md, mod/npc-reactions.lua): the person walks off, calls the
-- police (the game's own wanted stage rises by one) or turns hostile. A global, like the modules above. It is asked once when V's message
-- is admitted (the offer) and once when the NPC has finished speaking (the reaction); `update` is one nil check while nothing waits.
-- Never for our companions, another mod's characters, a named, story or quest character, or anyone while the game is in charge.
do
    local loaded, module = pcall(dofile, 'npc-reactions.lua')
    if loaded and type(module) == 'table' and type(module.new) == 'function' then
        local built, service = pcall(module.new, {
            player = function() return convaiPlayer() end,
            npcFor = function(entity) return conversationNpc(entity) end,
            policy = {
                ours = function(npc) return convaiWorldPolicy.ours(npc) end,
                spawned = function(npc) return convaiWorldPolicy.spawned(npc) end,
                protected = function(npc) return convaiWorldPolicy.protected(npc) end,
                story = function(npc) return convaiWorldPolicy.story(npc) end,
            },
            -- The quest flag of the person's record (the same read the catalog's story-bound rule uses, cached per entity), or the game's
            -- runtime quest flag (IsQuest, read fresh: a quest can mark a person on a generic record, a side job's witness or rescue
            -- target). Asked only when the offer is made or the reaction runs.
            storyFlag = function(npc, entity)
                local facts = archetypeFacts(npc, entity, tostring(npc:GetBodyType() or ''))
                local quest = facts.quest
                if quest == 'MainQuest' or quest == 'SideQuest' or quest == 'MinorQuest' then return true end
                return convaiWorldTalk ~= nil and convaiWorldTalk.runtimeQuest(npc) == true
            end,
            refusal = function(npc, player, entity) return convaiWorldTalk and convaiWorldTalk:refusal(npc, player, entity) or nil end,
            awaiting = function(requestId) return pending ~= nil and pending.requestId == requestId end,
            speaking = function(entity) return speech.requestId ~= nil and speech.context ~= nil and speech.context.entity == entity end,
            -- "NPCs react to threats and commands" (docs/NPC_THREATS_COMMANDS.md), off by default: read once per offer.
            threats = function() return type(manager.npcThreats) == 'function' and manager.npcThreats() == true end,
        })
        if built then convaiNpcReactions = service else print('[CyberpunkConvai] NPC reactions unavailable: ' .. tostring(service)) end
    elseif not loaded then print('[CyberpunkConvai] npc-reactions.lua unavailable: ' .. tostring(module)) end
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
            workspot = function(player) return Game.GetWorkspotSystem():IsActorInWorkspot(player) == true end,
            lines = function() return convaiGameDialogue and convaiGameDialogue.lines or nil end}) or false
        if not convaiJohnnyHead then print('[CyberpunkConvai] johnny-head.lua unavailable: ' .. tostring(module)) end
    end
    return convaiJohnnyHead or nil
end
-- Johnny speaks up (phase 2, mod/johnny-remarks.lua): loaded on the first event that finds both settings on (Johnny in your head, and
-- Johnny speaks up at Rare or Normal). The collectors that hand events over already run; with either setting off an event costs two
-- boolean reads here and nothing is loaded.
function convaiJohnnyRemarksService()
    if manager.johnnyRemarks() == 'off' or not manager.johnnyInHead() then return nil end
    if convaiJohnnyRemarks == nil then
        local loaded, module = pcall(dofile, 'johnny-remarks.lua')
        convaiJohnnyRemarksModule = loaded and type(module) == 'table' and type(module.new) == 'function' and module or nil
        convaiJohnnyRemarks = convaiJohnnyRemarksModule and module.new({level = function() return manager.johnnyRemarks() end, paced = true}) or false
        if not convaiJohnnyRemarks then print('[CyberpunkConvai] johnny-remarks.lua unavailable: ' .. tostring(module)) end
    end
    return convaiJohnnyRemarks or nil
end
-- The optional Johnny features that ride the 0.5 s battle sample (places, the fight watch) run under pcall: updateBattles
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
-- Is V seated in an ordinary seat right now? For the manager's shortcut (mod/nsui-entry.lua, mod/mcm-host.lua): asked only when the game's
-- scene tier is 3 or above, on a key press, one fresh observer sample. An answer of no is logged (at most every 5 s) with the controller's
-- verdict and the sample's scene facts, so a refusal on a seat that should have counted shows why in probe.log.
function convaiPlainSitting()
    local controller = convaiSeatedLook
    local player = convaiPlayer()
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
        -- Settings > Dynamic info > Location off: V's district is not read for him either (no arrival remarks).
        if manager.dynamicInfo ~= nil and not manager.dynamicInfo('location') then lastId, chain, tracker = nil, nil, nil; return end
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
-- How far from V an ordinary person, a named character or a quest-bound person still joins a group round (convaiTalkNearbyPeople): a
-- normal speaking distance. The faced person may be farther (the targeting query reaches 8 m).
convaiStrangerRange = 6

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
            if convaiTalkExcluded ~= nil and convaiTalkExcluded(row.npc) then
                stats.left[#stats.left + 1] = {who = key or ('entity ' .. tostring(row.entity)), reason = 'excluded', distance = row.distance}
            elseif not named or not key then
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
    -- Always on (the setting was removed 2026-10-20): no `enabled` option, so the recorder is on.
    -- Johnny speaks up (docs/JOHNNY_IN_YOUR_HEAD.md): a named character V just heard in person may get a remark from him later.
    onRow = function(row)
        if convaiJohnnyRemarkNote then convaiJohnnyRemarkNote('person', row) end
        -- Companions speak up (docs/COMPANION_SPEAK_UP.md): a scene she may comment on once it is over. A few table writes per scene line.
        if convaiSpeakUpScene then convaiSpeakUpScene(row) end
    end,
    -- Music and TV (Settings > Dynamic info): the last TV lines are kept only while the switch is on, for mod/media-context.lua (one boolean read per subtitle line).
    heardWanted = function() return manager.dynamicInfo == nil or manager.dynamicInfo('media') end,
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
    -- The decision ledger (docs/QUEST_DECISIONS.md 4.4): on unless settings.decisionLedger is turned off; read once per picked dialogue option.
    ledgerEnabled = function() return type(manager.decisionLedger) == 'function' and manager.decisionLedger() == true end,
    worldToken = function() return knowledgeFrame and knowledgeFrame.worldToken end,
    gameTime = function() return worldKnowledgeModule.nativeGameTime and worldKnowledgeModule.nativeGameTime() end,
    tracked = function() return questContext.trackedQuest and questContext.trackedQuest() end,
    present = function(radius)
        local keys = {}
        for _, person in ipairs(companions.conversationCandidates(convaiPlayer(), radius)) do keys[#keys + 1] = person.profileKey end
        return keys
    end}) or nil
convaiGameDialogue = gameDialogue

-- Whether the Dark Future mod is installed: one lookup of its main system, else of its hydration system (docs/DYNAMIC_INFO.md, "Other mods' state"). A global:
-- the main chunk is near Lua's limit of locals.
convaiDarkFuturePresent = function()
    for _, name in ipairs({'DarkFuture.Main.DFMainSystem', 'DarkFuture.Needs.DFHydrationSystem'}) do
        local ok, system = pcall(function() return Game.GetScriptableSystemsContainer():Get(CName.new(name)) end)
        if ok and system ~= nil then return true end
    end
    return false
end

-- Whether the Flesh and Chrome and Injuries mods (Digital Vixen) are installed: one lookup of each main system (docs/DYNAMIC_INFO.md, "Other mods' state"). Answers two
-- booleans. Globals, like the Dark Future probe above.
convaiVixenPresent = function()
    local found = {}
    for key, name in pairs({fac = 'FleshAndChrome.FACSystem', inj = 'Injuries.InjuriesSystem'}) do
        local ok, system = pcall(function() return Game.GetScriptableSystemsContainer():Get(CName.new(name)) end)
        found[key] = ok and system ~= nil
    end
    return found.fac, found.inj
end
-- The baseline read of Flesh and Chrome's counts (mod/vixen-state.lua): its drink and cigarette counts are the save's lifetime totals, not what is in V's body, so a drink is
-- only known as a rise since an earlier read. Without one the first question of a session would take the count as the baseline and miss a drink had just before it (live
-- 2026-10-27, a new game). So one ordinary read of the reader is made once each time a save has loaded (convaiVixenBaselineDue, set here and by abandonSession), three seconds
-- after the world is ready, from the 0.5 second sample of updateBattles: a nil check while nothing is due, one read per load, nothing between. Only with Other mods' state on.
convaiVixenBaselineDue = true
convaiVixenBaseline = function(player, now)
    if convaiVixenBaselineAt == nil then convaiVixenBaselineAt = now + 3 end
    if now < convaiVixenBaselineAt then return end
    convaiVixenBaselineDue, convaiVixenBaselineAt = nil, nil
    if manager.dynamicInfo == nil or not manager.dynamicInfo('mods') then return end
    local options = convaiTurnContext and convaiTurnContext.options
    if options and type(options.vixen) == 'function' then pcall(options.vixen, player) end
end
-- Whether Equipment-EX is installed (one lookup of its outfit system): its outfit can hide V's real clothes, so with Other mods' state off, where the outfit is not read,
-- what V visibly wears is not known (mod/player-gear.lua nudity). Cached for a minute.
convaiEquipmentExPresent = function()
    local now = os.time()
    local at = convaiEquipmentExProbedAt
    if at ~= nil and now >= at and now - at < 60 then return convaiEquipmentExFound == true end
    convaiEquipmentExProbedAt = now
    local ok, system = pcall(function() return Game.GetScriptableSystemsContainer():Get(CName.new('EquipmentEx.OutfitSystem')) end)
    convaiEquipmentExFound = ok and system ~= nil
    return convaiEquipmentExFound
end

-- Music and TV, the song (mod/media-song.lua): the game's own song-change events, cached for mod/media-context.lua. Loaded and hooked only
-- while the switch is on: at start (onInit) when it is on then, else the first time a turn is built with it on. Once hooked, a callback with
-- the switch off returns after one boolean read. A failed load is not retried. Globals: the main chunk is near Lua's limit of locals.
convaiMediaSongInstall = function()
    if convaiMediaSong ~= nil then return end
    if manager.dynamicInfo ~= nil and not manager.dynamicInfo('media') then return end
    local loaded, module = pcall(dofile, 'media-song.lua')
    if not loaded or type(module) ~= 'table' or type(module.new) ~= 'function' then
        convaiMediaSong = false
        convaiLogOnce('media-song-load', 'Media song: not loaded: ' .. tostring(module))
        return
    end
    convaiMediaSong = module.new({observe = ObserveAfter, wanted = function() return manager.dynamicInfo == nil or manager.dynamicInfo('media') end})
    local hooked = convaiMediaSong:install()
    -- convaiLogLine, not log: this runs before the local log is defined in the chunk.
    if convaiLogLine then convaiLogLine('Media song: ' .. tostring(hooked) .. ' of ' .. #module.HOOKS .. ' song events hooked') end
end

-- Witness receipts (docs/QUEST_DECISIONS.md 4.3): on unless settings.witnessReceipts is turned off. When a world scan sees a quest fact or journal entry
-- change, who stood within 15 m is written to runtime/witness-receipts.json. One boolean check per scan; optional like the modules above.
do
    local loaded, module = pcall(dofile, 'witness-receipts.lua')
    convaiWitnessReceipts = loaded and type(module) == 'table' and type(module.new) == 'function' and module.new({
        enabled = function() return type(manager.witnessReceipts) == 'function' and manager.witnessReceipts() == true end,
        worldToken = function() return knowledgeFrame and knowledgeFrame.worldToken end,
        gameTime = function() return worldKnowledgeModule.nativeGameTime and worldKnowledgeModule.nativeGameTime() end,
        near = function(radius)
            local keys = {}
            for _, person in ipairs(companions.conversationCandidates(convaiPlayer(), radius)) do keys[#keys + 1] = person.profileKey end
            return keys
        end}) or nil
    if convaiWitnessReceipts then
        worldKnowledge.edgesWanted = function() return convaiWitnessReceipts:on() end
        worldKnowledge.onEdges = function(edges) convaiWitnessReceipts:record(edges) end
    end
end
-- Recent game dialogue (Settings > Dynamic info): off, nothing is captured for a turn. The recorder itself stays on: Johnny's remarks and the
-- add-ons hear the game's lines through it, and it works only when the game shows a line, never per frame.
convaiGateCapture(gameDialogue, 'capture', 'dialogue')
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
-- V's gear and clothes (Settings > Dynamic info): off, the equipment is not read.
convaiGateCapture(playerGear, 'capture', 'gear')
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
        -- Settings > Dynamic info: a kind that is off is not read from the game (mod/turn-context.lua).
        enabled = function(kind) return manager.dynamicInfo == nil or manager.dynamicInfo(kind) end,
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
        -- Music and TV, and other mods' state (Settings > Dynamic info): the readers are loaded the first time a turn is built with their switch on,
        -- so nothing is loaded while a switch is off or the module is absent. Each answers a plain table or nothing (mod/media-context.lua, mod/mod-state.lua).
        media = function(player)
            if convaiMediaSong == nil then convaiMediaSongInstall() end
            if convaiMediaContext == nil then
                local loaded, module = pcall(dofile, 'media-context.lua')
                convaiMediaContext = loaded and type(module) == 'table' and type(module.read) == 'function' and module or false
            end
            return convaiMediaContext and convaiMediaContext.read(player) or nil
        end,
        -- Other mods' state: Dark Future's own classes are looked up before anything is loaded (docs/DYNAMIC_INFO.md, "Other mods' state"). One
        -- class name or two, pcall'd. Absent: mod-state.lua is never read from disk, and the probe is repeated at most once a minute (it may
        -- not exist yet during a loading screen), so a player without the mod pays one failed lookup a minute while talking and nothing else.
        -- Present: the module is loaded once (a failed load is not retried) and read per turn window.
        -- The second answer is the compact note of what the read found ("installed=yes read=ok stage=hydration0,nutrition1,..."): it rides the snapshot so the
        -- bridge's probe line of the turn (df: ...) can say what the game side saw, also when nothing was worth sending.
        mods = function(player)
            if convaiModState == nil then
                local now = os.time()
                local probedAt = convaiModStateProbedAt
                if probedAt ~= nil and now >= probedAt and now - probedAt < 60 then return nil end
                convaiModStateProbedAt = now
                if not convaiDarkFuturePresent() then return nil end
                local loaded, module = pcall(dofile, 'mod-state.lua')
                convaiModState = loaded and type(module) == 'table' and type(module.read) == 'function' and module or false
                if convaiLogLine then convaiLogLine('Mod state: Dark Future found, reader ' .. (convaiModState and 'loaded' or 'failed to load')) end
            end
            if not convaiModState then return nil, 'installed=yes read=load-failed stage=-' end
            local state = convaiModState.read(player, function(line) if convaiLogLine then convaiLogLine(line) end end)
            return state, type(convaiModState.note) == 'function' and convaiModState.note() or nil
        end,
        -- Other mods' state switched OFF (it is off by default): nothing of Dark Future is read, loaded or told, whatever V asks. When Dark Future is installed a turn of
        -- the session says so in one probe line, so a missing remark is not mistaken for a failed read. A class lookup at most once a minute and three times a session
        -- (none after the line is written); no state is read.
        modsOff = function()
            if convaiModOffNoted then return end
            local now = os.time()
            local at = convaiModOffProbedAt
            if at ~= nil and now >= at and now - at < 60 then return end
            convaiModOffProbedAt, convaiModOffProbes = now, (convaiModOffProbes or 0) + 1
            if convaiDarkFuturePresent() then
                convaiModOffNoted = true
                if convaiLogLine then
                    convaiLogLine("df: installed=yes read=skipped stage=- switch=off asked=? sent=none(Other mods' state is off in Settings > Dynamic info: nothing is read or told, whatever V asks)")
                end
            elseif convaiModOffProbes >= 3 then
                convaiModOffNoted = true
            end
        end,
        -- Other mods' state, the Digital Vixen mods Flesh and Chrome and Injuries (mod/vixen-state.lua): the same gate as above. Their class names are looked up before
        -- anything is loaded; absent: the module is never read from disk and the probe is repeated at most once a minute. Present: loaded once, read per turn window.
        -- The second answer is {fac =, inj =}, the compact notes of what each read found, for the probe lines of the turn (fac: ..., inj: ...).
        vixen = function(player)
            if convaiVixenState == nil then
                local now = os.time()
                local probedAt = convaiVixenProbedAt
                if probedAt ~= nil and now >= probedAt and now - probedAt < 60 then return nil end
                convaiVixenProbedAt = now
                local fac, inj = convaiVixenPresent()
                if not (fac or inj) then return nil end
                local loaded, module = pcall(dofile, 'vixen-state.lua')
                convaiVixenState = loaded and type(module) == 'table' and type(module.read) == 'function' and module or false
                if convaiLogLine then convaiLogLine('Mod state: ' .. (fac and 'Flesh and Chrome ' or '') .. (inj and 'Injuries ' or '') .. 'found, reader ' .. (convaiVixenState and 'loaded' or 'failed to load')) end
            end
            if not convaiVixenState then return nil end
            return convaiVixenState.read(player, function(line) if convaiLogLine then convaiLogLine(line) end end)
        end,
        -- The same mods with the switch OFF: one probe line each, once a session, when the mod is there (nothing is read, loaded or told). At most three class lookups.
        vixenOff = function()
            if convaiVixenOffNoted then return end
            local now = os.time()
            local at = convaiVixenOffProbedAt
            if at ~= nil and now >= at and now - at < 60 then return end
            convaiVixenOffProbedAt, convaiVixenOffProbes = now, (convaiVixenOffProbes or 0) + 1
            local fac, inj = convaiVixenPresent()
            for key, present in pairs({fac = fac, inj = inj}) do
                if present and convaiLogLine then
                    convaiLogLine(key .. ": installed=yes read=skipped state=- switch=off asked=? sent=none(Other mods' state is off in Settings > Dynamic info: nothing is read or told, whatever V asks)")
                end
            end
            if fac or inj or convaiVixenOffProbes >= 3 then convaiVixenOffNoted = true end
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
    microphone.captureTurnContext = function(profileKey)
        local snapshot = convaiTurnContext and convaiTurnContext:capture() or nil
        if snapshot and convaiAppointmentTurn then snapshot = convaiAppointmentTurn(snapshot, profileKey) end
        return snapshot
    end
    -- A group round with a character another mod or a spawner created in it needs a party row for that character: read it
    -- afresh rather than reuse a snapshot a private turn took a moment earlier (nothing else changes for other rounds).
    groupChat.onSpawned = function() if convaiTurnContext then convaiTurnContext:reset('group-spawned') end end
    -- A phone chat or a holocall with a character whose body is beside V (bridge/turn-context.mjs `near`): her party row says so when she is one of our companions within
    -- NEAR_RADIUS, 10 m (the companion list's own distance); a character another mod or a spawner placed is found by the one targeting query a group key press uses, asked only
    -- when a message is sent or a call line is built, never per frame, and only for a character the snapshot does not already list. The snapshot may be shared and cached,
    -- so the row goes on a copy. Nothing is added while Dynamic info's company switch is off, and a failed query leaves the snapshot as it was.
    function convaiNearbyTurn(snapshot, profileKey)
        if type(snapshot) ~= 'table' or type(profileKey) ~= 'string' or convaiSpawnedPeople == nil then return snapshot end
        for _, row in ipairs(type(snapshot.party) == 'table' and snapshot.party or {}) do
            if type(row) == 'table' and row.key == profileKey then return snapshot end
        end
        if manager.dynamicInfo ~= nil and not manager.dynamicInfo('company') then return snapshot end
        local player = convaiPlayer()
        if not player then return snapshot end
        local ok, rows = pcall(convaiSpawnedPeople.nearby, player, 10, {})
        if not ok or type(rows) ~= 'table' then return snapshot end
        for _, row in ipairs(rows) do
            if row.profileKey == profileKey and type(row.name) == 'string' and row.name ~= '' then
                local copy, party = {}, {}
                for key, value in pairs(snapshot) do copy[key] = value end
                for _, item in ipairs(type(snapshot.party) == 'table' and snapshot.party or {}) do party[#party + 1] = item end
                party[#party + 1] = {key = profileKey, name = row.name, near = true}
                copy.party = party
                return copy
            end
        end
        return snapshot
    end
    -- A phone chat reads it once per message too (mod/phone-chat.lua, when the message is sent).
    phoneChat.captureTurnContext = function(profileKey)
        local snapshot = microphone.captureTurnContext(profileKey)
        local ok, nearby = pcall(convaiNearbyTurn, snapshot, profileKey)
        return ok and nearby or snapshot
    end
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

local partyLink = {lastHint = nil, lastHeartbeat = 0, lookAt = nil, retry = false, LOOK = 0.25}
-- The per-frame call re-derives the party's profile list (a table and a concat per frame). A change reaches the
-- bridge through companions.onPartyChanged (forced); this look only backs it up, so it runs every partyLink.LOOK
-- seconds of wall clock. A heartbeat refused its slot below retries on the next frame.
local function publishPartyConnections(force)
    if not force and not partyLink.retry then
        local wall = os.clock()
        if partyLink.lookAt and wall >= partyLink.lookAt and wall - partyLink.lookAt < partyLink.LOOK then return end
        partyLink.lookAt = wall
    end
    partyLink.retry = false
    local keys, encoded = {}, {}
    for _, key in ipairs(companions.connectionProfiles()) do
        if manager.profileEnabled(key) then keys[#keys + 1] = key end
    end
    local signature, now = table.concat(keys, ','), os.time()
    if not force and signature == partyLink.lastHint and now - partyLink.lastHeartbeat < 2 then return end
    if not force and signature == partyLink.lastHint and not convaiHeartbeatSlot() then partyLink.retry = true; return end
    for _, key in ipairs(keys) do encoded[#encoded + 1] = json.encode(key) end
    -- In place (one open, not open+remove+rename): the bridge ignores a partial
    -- read (PartyConnections.ingest rejects it) and keeps the last snapshot.
    local f = io.open('runtime/party-connections.json', 'wb')
    if not f then return end
    local written = f:write('{"updated":' .. tostring(now * 1000) .. ',"profiles":[' .. table.concat(encoded, ',') .. ']}')
    if f:close() and written then partyLink.lastHint, partyLink.lastHeartbeat = signature, now end
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
    -- A line that only says nothing failed ("error=false", "failed:0") is not a failure: it waits for the batch like any other.
    local scan = entry
    if entry:find('error=false', 1, true) or entry:find('failed:0', 1, true) then scan = (entry:gsub('error=false', ''):gsub('failed:0', '')) end
    if count >= 64 or state.bytes >= 8192 or scan:find('[Ff]ail') or scan:find('[Ee]rror') or scan:find('[Aa]bandon')
        or scan:find('[Ss]hut') or scan:find('[Cc]rash') then convaiLogFlush() end
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
-- The face request of a talk start (Face.reds ConvaiFaceRequest): returns what pcall returns. For Johnny Silverhand (convaiStory.projection,
-- mod/world-talk.lua PROJECTIONS) the puppet is first told so (ConvaiFaceProjection), so his commanded AI (a ride in V's car, a scene seat) does
-- not shut his mouth; scripts from before that method just answer an error, which is ignored. A global, so no function here gains an upvalue.
function convaiFaceRequestFor(npc, entity)
    local story = convaiStory
    if story and story.projection == true and entity ~= nil and story.entity == entity then
        pcall(function() npc:ConvaiFaceProjection(true) end)
    end
    return pcall(function() return npc:ConvaiFaceRequest() end)
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
-- The redscript's account of opening a chat (PhoneChat.reds, PhoneChatTabs.reds): the press, the page, the focus. A few lines per opening; at most 120 a session.
phoneChat.traced = 0
phoneChat.trace = function(line)
    if phoneChat.traced >= 120 then return end
    phoneChat.traced = phoneChat.traced + 1
    log('Phone chat: ' .. tostring(line))
end
phoneChat.typingOpened = function(player, contact)
    log('Phone chat typing opened: contact=' .. tostring(contact) .. ' speed=' .. playerSpeedText(player))
end
-- V's gear: one line per real read (bridge/player-gear.mjs logs the other half per reply), so a test shows what was built.
if playerGear then playerGear.options.log = log end
if playerGear then playerGear.options.nudityLog = log end
-- A wardrobe outfit of Equipment-EX shows instead of V's equipped clothes in that gear (docs/PLAYER_GEAR_CONTEXT.md). Only while Settings > Dynamic info >
-- Other mods' state is on: off, the module is never loaded and nothing is read from that mod. Called inside the gear's cached read, once per window.
if playerGear then
    local equipmentEx
    -- With Other mods' state off the outfit is not read; when Equipment-EX is installed its outfit may be hiding V's real clothes, so the reader is told what V visibly
    -- wears is not known (it then never says V is topless or naked: mod/player-gear.lua).
    playerGear.options.outfitUnread = function()
        if manager.dynamicInfo and manager.dynamicInfo('mods') then return false end
        return convaiEquipmentExPresent()
    end
    playerGear.options.outfit = function(player)
        if not (manager.dynamicInfo and manager.dynamicInfo('mods')) then return nil end
        if equipmentEx == nil then
            local loaded, module = pcall(dofile, 'equipment-ex.lua')
            equipmentEx = loaded and type(module) == 'table' and type(module.read) == 'function' and module or false
        end
        return equipmentEx and equipmentEx.read(player, log) or nil
    end
end
if convaiTurnContext then convaiTurnContext.options.log = log end
if convaiNpcReactions then convaiNpcReactions.options.log, convaiNpcReactions.options.logOnce = log, convaiLogOnce end
-- Street reputation (docs/REPUTATION_DESIGN.md, mod/reputation.lua): the module is loaded and its hooks registered only once the setting is
-- on (at start, at the next load, from the game's update after the menu turned it on, or at the next turn). While it is off convaiReputation
-- stays nil: no file is loaded, no hook registered, nothing written, and requests carry no `reputation`. Globals, so no function here gains
-- an upvalue.
-- The deed recorder also feeds Revenge ambushes (Settings > Gameplay, mod/revenge-ambush.lua): it runs when either setting is on, and a request carries
-- the reputation snapshot only while Street reputation itself is on (convaiReputationAttach).
function convaiDeedsWanted()
    if type(manager.reputation) == 'function' and manager.reputation() then return true end
    return type(manager.revengeAmbushes) == 'function' and manager.revengeAmbushes() == true
end
function convaiReputationWanted()
    if not convaiDeedsWanted() then return nil end
    if convaiReputation then return convaiReputation end
    local loaded, module = pcall(dofile, 'reputation.lua')
    if not loaded or type(module) ~= 'table' or type(module.new) ~= 'function' then
        log('Street reputation unavailable: ' .. tostring(module)); return nil
    end
    local built, service = pcall(module.new, {
        enabled = convaiDeedsWanted,
        onDeed = function(row, npc) if convaiAmbush then convaiAmbush.deed(row, npc) end end,
        observe = ObserveAfter,
        player = function() return convaiPlayer() end,
        gameTime = worldKnowledgeModule.nativeGameTime,
        lifepath = worldKnowledgeModule.nativeAdapter.readLifepath,
        district = currentDistrict,
        -- Our companions, other mods' characters, named, story and quest people are never recorded: the quest facts carry theirs.
        ordinary = function(npc)
            local policy = convaiWorldPolicy
            if policy.ours(npc) or policy.spawned(npc) or policy.protected(npc) or policy.story(npc) then return false end
            return not (convaiWorldTalk ~= nil and convaiWorldTalk.runtimeQuest(npc) == true)
        end,
        stat = function(name)
            local player = convaiPlayer()
            return Game.GetStatsSystem():GetStatValue(player:GetEntityID(), Enum.new('gamedataStatType', name))
        end,
        log = log,
    })
    if not built then log('Street reputation unavailable: ' .. tostring(service)); return nil end
    convaiReputation = service
    service.install()
    if convaiNpcReactions then
        convaiNpcReactions.options.onReaction = function(kind, who)
            if convaiReputation and manager.reputation() then convaiReputation.reaction(kind, who) end
        end
    end
    -- The squad's module exists before the first kill is recorded, or that kill would be lost.
    if type(manager.revengeAmbushes) == 'function' and manager.revengeAmbushes() then pcall(convaiAmbushModule) end
    return service
end
-- An ordinary NPC's private turn carries the reputation snapshot (V's Street Cred, level, clock and the ring of deeds). Never a story,
-- named or companion character, a group round, a holocall, Johnny, an add-on voice or an automatic reaction.
function convaiReputationAttach(context)
    if convaiReputationPending then convaiReputationPending = nil; pcall(convaiReputationWanted) end
    local service = convaiReputation
    if not service or not service.on() or type(context) ~= 'table' or type(context.archetype) ~= 'table' then return end
    if type(manager.reputation) ~= 'function' or not manager.reputation() then return end
    local key = context.profileKey
    if type(key) ~= 'string' or not (key:match('^npc%-[a-z0-9%-]+$') or key == 'resident-male' or key == 'resident-female') then return end
    if context.group or context.reaction or context.holocall or context.head or context.voiceOnly then return end
    if convaiStory and convaiStory.entity == context.entity then return end
    context.reputation = service.capture()
end
-- A load, a quit, a death, a fast travel or shutdown: the deeds still waiting are written (behind a loading screen), the new world starts empty.
function convaiReputationReset(reason)
    if convaiReputation then pcall(convaiReputation.reset, reason) end
end
-- The lease writes one line when a reaction offer ends early or its packet is refused (mod/gameplay-actions.lua), never per frame.
if gameplayActions and gameplayActions.options then gameplayActions.options.log = log end
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
            player = function() return convaiPlayer() end,
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
                and not companions.owns(entity) and not (adoption and adoption.hidden(entity)) and not (convaiTalkExcluded ~= nil and convaiTalkExcluded(entity)) then
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
            enabled = function() return true end,   -- always on (the setting was removed 2026-10-20)
            scan = scanNearbyCharacters,
            -- Tier-1 named, other named, generic: the tie-breaker before distance for nearby characters.
            prominence = function(key) return module.prominence(catalogued[key]) end,
            -- A conversation partner's distance from V in metres; nil once it is gone, false when unknown.
            locate = function(partner)
                local npc = partner.entity
                if not npc then return false end
                if not npc:IsAttached() or npc:IsDeadNoStatPool() then return nil end
                local player = convaiPlayer()
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
                return ok and type(state) == 'table' and (state.effective == 'mistral' or state.effective == 'local' or state.effective == 'custom' or state.effective == 'gemini')
            end,
            log = function(line) log(line) end})
        -- convaiAutoConnect.promote(key): a conversation partner asked to follow leaves the partner role.
        if built and type(value) == 'table' then autoConnect = value; convaiAutoConnect = value
        else print('[CyberpunkConvai] auto-connect.lua unavailable: ' .. tostring(value)) end
    else print('[CyberpunkConvai] auto-connect.lua unavailable: ' .. tostring(module)) end
end

-- Body gestures (docs/COMPANION_GESTURES.md): always on (the setting was removed 2026-10-20); the controller is always loaded. The development
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
        enabled = function() return true end,   -- always on (the setting was removed 2026-10-20)
        speech = speechFor,
        listening = function() return convaiFacialPlayback and convaiFacialPlayback.listeningEntity end,
        thinking = function() return convaiFacialPlayback and convaiFacialPlayback.thinkingEntity end,
        -- The player's choices for this copy (character editor, Look and moves): talking gestures, nods, idle moves. A table lookup by profile key.
        prefs = function(entry) local chosen = convaiCharacterOptions; return chosen and entry and chosen.get(entry.profileKey) or nil end,
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
        -- The player's choices for this copy (character editor, Look and moves): sit = false keeps it on its feet beside V.
        prefs = function(entry) local chosen = convaiCharacterOptions; return chosen and entry and chosen.get(entry.profileKey) or nil end,
        -- V settled on a seat: its root is learned so that no housemate is given it (mod/housemates.lua).
        onSettled = function(anchor, forward, kind)
            if convaiHousemateLearn then convaiHousemateLearn(anchor, forward, kind) end
            if convaiSettleSat then convaiSettleSat(anchor) end
        end,
        -- The first party tick of a world (a save made at home, fast travel into a flat): is V in one of V's flats? (mod/companion-settle.lua)
        onWorld = function() if convaiSettleWake then convaiSettleWake() end end,
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
            -- Settling in V's flat (mod/companion-settle.lua): a nil global away from home.
            local z = convaiSettle
            if z then pcall(z.tick, player, step, rows) end
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
        -- A change of clothes on a home place (mod/companion-outfits.lua): stand up, take no place for `hold` seconds.
        standUp = function(serial, hold)
            local s = currentSeating()
            if not s or not s.homeStandUp then return nil end
            local ok, result = pcall(s.homeStandUp, serial, hold)
            return ok and result or nil
        end,
        -- The change of clothes is over: the flat gives her a place again after `delay` seconds.
        sitAgain = function(serial, delay)
            local s = currentSeating()
            if not s or not s.homeSitAgain then return nil end
            local ok, result = pcall(s.homeSitAgain, serial, delay)
            if ok then return result end
            return nil
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

-- Who is never a talk target, a nearby listener or a group member (mod/talk-exclusion.lua, docs/CHARACTER_EDITOR.md "Switching someone off"): a character
-- nobody can see, one that rides or drives a remote controlled toy (the toy AV in V's flat answered as an NPC), and the ordinary people the player switched
-- off in the character editor. Asked when a target is chosen, never per frame: the game's signals are read once per entity and cached for 30 s. Optional:
-- without the module nobody is left out. A global function, so no function here gains an upvalue.
do
    local function recordOf(npc)
        local ok, text = pcall(function() return TDBID.ToStringDEBUG(npc:GetRecordID()) end)
        if not ok or type(text) ~= 'string' or text == '' then return nil end
        return characterCatalog.originalRecordName(text) or text
    end
    local loaded, module = pcall(dofile, 'talk-exclusion.lua')
    if loaded and type(module) == 'table' and type(module.new) == 'function' then
        local created, service = pcall(module.new, {
            id = function(npc) return tostring(npc:GetEntityID().hash) end,
            record = recordOf,
            appearance = function(npc) return nameString(npc:GetCurrentAppearanceName()) end,
            -- What the character is mounted to or attached to (the toy vehicle it drives): the parent's record, and whether the parent is a device.
            parentRecord = function(npc)
                local info = Game.GetMountingFacility():GetMountingInfoSingleWithObjects(npc)
                local parent = info and info.parentId
                if not parent or parent.hash == nil or tostring(parent.hash):match('^0+[uUlL]*$') ~= nil then return nil end
                local entity = Game.FindEntityByID(parent)
                if not entity then return nil end
                local name = recordOf(entity)
                local device = false
                pcall(function() device = entity:IsA('Device') == true end)
                return {record = name, device = device}
            end,
            -- The mesh components of the character and how many are shown: a puppet with no mesh drawn is not somebody V can see.
            meshes = function(npc)
                local list = npc:GetComponents()
                if type(list) ~= 'table' then return nil end
                local total, meshes, shown = 0, 0, 0
                for _, component in ipairs(list) do
                    total = total + 1
                    local isMesh = false
                    pcall(function() isMesh = component:IsA('entMeshComponent') or component:IsA('entSkinnedMeshComponent') end)
                    if isMesh then
                        meshes = meshes + 1
                        local on, enabled = pcall(function() return component:IsEnabled() end)
                        if not on or enabled ~= false then shown = shown + 1 end
                    end
                end
                return {total = total, meshes = meshes, shown = shown}
            end,
            offRecord = function(record) local chosen = convaiCharacterOptions; return chosen ~= nil and chosen.offRecord(record) end,
            log = function(line) log(line) end})
        if created and type(service) == 'table' then convaiTalkExclusion = service
        else print('[CyberpunkConvai] talk-exclusion.lua failed: ' .. tostring(service)) end
    else print('[CyberpunkConvai] talk-exclusion.lua unavailable: ' .. tostring(module)) end
end
-- True when this character is never a talk target or listener (see above). Guarded: a failed read leaves the character in.
function convaiTalkExcluded(npc)
    local service = convaiTalkExclusion
    if service == nil then return false end
    -- A copy of ours is never a puppet (a party member out of sight in a car is still the player's companion).
    local mine, owned = pcall(companions.owns, npc)
    if mine and owned == true then return false end
    local ok, why = pcall(service.reason, npc)
    return ok and why ~= nil
end
-- The entity id of an NPC as a string (a global function: no closure per candidate).
convaiEntityKey = function(npc) return tostring(npc:GetEntityID().hash) end
-- The Head slot point of an NPC, or nil (a global function: no closure per candidate).
convaiHeadPoint = function(npc)
    local slot = npc:GetSlotComponent()
    if not slot then return nil end
    local found, transform = slot:GetSlotTransform(CName.new('Head'))
    if not found or not transform then return nil end
    local point = WorldPosition.ToVector4(WorldTransform.GetWorldPosition(transform))
    if not point or type(point.x) ~= 'number' or type(point.y) ~= 'number'
        or type(point.z) ~= 'number' then return nil end
    return point
end
-- True when the Head slot of an NPC standing at `pos` cannot pass the 32 degree cone either, so its two slot reads are skipped.
-- The chest aim point (pos + 1.3 m up) and the head are at most 1.5 m apart, which moves the angle by at most asin(1.5 / distance):
-- an NPC farther out than the cone plus that is outside whichever point is measured. Unknown geometry says false (read the head).
convaiHeadOutOfCone = function(pos, playerPos, forward, forwardLength)
    if forwardLength < 0.1 then return false end
    local dx, dy, dz = pos.x - playerPos.x, pos.y - playerPos.y, pos.z + 1.3 - playerPos.z
    local distance = math.sqrt(dx^2 + dy^2 + dz^2)
    if distance < 0.1 then return false end
    if distance > 9.5 then return true end
    local cosine = math.max(-1.0, math.min(1.0, (dx * forward.x + dy * forward.y + dz * forward.z) / (distance * forwardLength)))
    return math.deg(math.acos(cosine)) > 32.0 + math.deg(math.asin(math.min(1.0, 1.5 / distance)))
end

-- Phase 1 of the target search: the native query and the candidate lists (nothing here depends on where the crosshair is now).
-- The 5 Hz gaze runs it one tick before the measuring phase so no single frame carries the whole scan (updateGaze).
local function gatherTargets(player)
    local query = TargetSearchQuery.new()
    query.searchFilter = Game['TSF_NPC;']()
    query.maxDistance = 8.0
    local targeting = Game.GetTargetingSystem()
    query.includeSecondaryTargets = false
    query.filterObjectByDistance = true
    query.ignoreInstigator = true
    local candidates, seated, onFoot, nativeIds = {}, {}, {}, {}
    local function nativeCandidate(npc)
        -- One entity, one candidate: its other parts (and the nearest and looked-at objects) were each measured, and dropped as a
        -- repeat, after their NPC, attached and dead reads. The first copy stays the one measured.
        local ok, id = pcall(convaiEntityKey, npc)
        if ok then
            if nativeIds[id] then return end
            nativeIds[id] = true
        end
        candidates[#candidates + 1] = npc
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
    return {candidates = candidates, seated = seated, onFoot = onFoot, lookedOk = lookedOk, looked = looked}
end

-- Phase 2: measure the candidates against the crosshair now and choose. `gathered` is a gatherTargets result from the tick before.
local function targetAtCrosshair(gathered)
    local player = convaiPlayer()
    if not player then return nil, 'Player unavailable' end
    local targeting = Game.GetTargetingSystem()
    local gather = gathered or gatherTargets(player)
    local candidates, seated, onFoot, lookedOk, looked = gather.candidates, gather.seated, gather.onFoot, gather.lookedOk, gather.looked
    -- ConvaiCrosshairData is nil only where this function runs without the top of init.lua (tests): the plain 2.31 call then.
    local playerPos, forward
    if ConvaiCrosshairData then playerPos, forward = ConvaiCrosshairData(targeting, player) else playerPos, forward = targeting:GetCrosshairData(player) end
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
            if convaiTalkExcluded ~= nil and convaiTalkExcluded(npc) then return nil end
            local id = tostring(npc:GetEntityID().hash)
            if measured[id] then return nil end
            measured[id] = true
            local pos = npc:GetWorldPosition()
            local points = {{x = pos.x, y = pos.y, z = pos.z + 1.3}}
            local isLooked = not onFoot[id] and lookedOk and looked and npc == looked or false
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
                -- Skipped for an NPC well outside the cone, whose head could not pass it either.
                local headOk, head = false, nil
                if isLooked or not convaiHeadOutOfCone(pos, playerPos, forward, forwardLength) then
                    headOk, head = pcall(convaiHeadPoint, npc)
                end
                if headOk and head then points[#points + 1] = head end
            end
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
    gazeState.candidate = nil
    gazeState.dwell = 0
    gazeState.lost = 0
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
-- The conversation is over: when its focus ran out by itself (quiet = true) the ambient-bark window keeps a quiet tail, when V closed
-- it (the manager opened) a short grace (vanilla-reactions.lua). A global, so onUpdate gains no upvalue. A line that still plays keeps
-- the window until it ends.
convaiBarkEnd = function(quiet)
    if convaiVanillaReactions and not (convaiSpeech and convaiSpeech.requestId) then
        if quiet then pcall(convaiVanillaReactions.barkIdle) else pcall(convaiVanillaReactions.barkRelease, nil, 'closed') end
    end
end
-- An ordinary NPC that reacts (walks off, attacks) first lets go of the conversation's hold and look-at, the same release.
if convaiNpcReactions then convaiNpcReactions.options.release = function(player) endFocus(player) end end
-- The conversation's own focus on a walking crowd person, for a get down or a cower that keeps it (live test 6, 2026-10-27: a hold of our own
-- never ran on a crowd person, the conversation's does): {age = seconds since it began, hold = its AIHoldPositionCommand when readable}, or nil
-- when the conversation is not focused on this person.
if convaiNpcReactions then
    convaiNpcReactions.options.focusOf = function(npc)
        local current = focusedCrowd
        if not current or not npc then return nil end
        local same = tostring(current.npc:GetEntityID().hash) == tostring(npc:GetEntityID().hash)
        if not same then return nil end
        local hold
        pcall(function() hold = convaiPlayer().m_convaiFocusHold end)
        return {age = os.time() - (current.at or os.time()), hold = hold}
    end
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
    -- A housemate keeps her seat or her bed: eyes and head only, no hold or turn (mod/housemates.lua).
    if not keepAI and convaiResidentNpc ~= nil and convaiHousemates ~= nil and convaiResidentNpc(npc) then
        keepAI = true
        if convaiHousemateTalk then pcall(convaiHousemateTalk, tostring(npc:GetEntityID().hash)) end
    end
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
-- Live test 7 (2026-10-27): by the time a "get down" starts (once the reply has been heard) the conversation has let go, and a move command
-- does not stop a walking crowd person either. What stops one is this focus (ConvaiBeginFocus: its 40 s hold and the turn to V).
-- keepFocus(npc, seconds): the focus on that crowd person outlasts the end of the talk for `seconds` (the end-of-talk timeout waits); true
-- when the focus is on it. refocus(player, npc, seconds): this same focus begun again for that person and kept `seconds`. The pin is a
-- global (the main chunk is near Lua's limit of local variables), compared by the focus record itself: nothing is read per frame.
if convaiNpcReactions then
    convaiNpcReactions.options.keepFocus = function(npc, seconds)
        local current = focusedCrowd
        if not current or not npc then return false end
        if tostring(current.npc:GetEntityID().hash) ~= tostring(npc:GetEntityID().hash) then return false end
        convaiFocusKept = {crowd = current, untilAt = os.time() + math.ceil(seconds or 0)}
        return true
    end
    convaiNpcReactions.options.refocus = function(player, npc, seconds)
        local began, why = beginFocus(player, npc)
        if not began then return false, why end
        local current = focusedCrowd
        if not current then return false, 'not a crowd focus' end
        convaiFocusKept = {crowd = current, untilAt = os.time() + math.ceil(seconds or 0)}
        focusUntil = os.time() + math.ceil(seconds or 0)
        if focusMode == nil then focusMode = 'chat' end
        return true, 'begun'
    end
end

-- UI_System.IsInMenu. The blackboard definition and its id are script constants (the blackboard is found by
-- that id on every read), so they are read once, not with GetAllBlackboardDefs and two property reads per call.
-- A global, so onUpdate's closure gains no upvalue.
convaiInMenu = function()
    local cache = convaiHeartbeat
    -- One read per frame (the frame's flags from ConvaiFrameFlags seed it): the world-ready check, the reply's pause test and the
    -- other readers of a frame share it.
    if cache.menuFrame == cache.frame then return cache.menuValue end
    if not cache.menuDefinition then
        local definition = Game.GetAllBlackboardDefs().UI_System
        cache.menuFlag, cache.menuDefinition = definition.IsInMenu, definition
    end
    local value = Game.GetBlackboardSystem():Get(cache.menuDefinition):GetBool(cache.menuFlag)
    cache.menuFrame, cache.menuValue = cache.frame, value
    return value
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
    gazeState.poll = gazeState.poll + elapsed
    if gazeState.poll < 0.2 then
        -- Half way to a scan: its native candidate query runs now, on a tick of its own, so the measuring tick below carries only
        -- the per-candidate reads (no single frame holds the whole scan). Nothing is gathered when the scan could not run anyway.
        if gazeState.poll >= 0.1 and convaiGazeGather == nil and gameplayCanAcquire(player) then
            local gathered, result = pcall(gatherTargets, player)
            if gathered and type(result) == 'table' then result.at = os.clock(); convaiGazeGather = result end
        end
        return
    end
    local step = gazeState.poll
    gazeState.poll = 0
    local gather = convaiGazeGather
    convaiGazeGather = nil
    if gather and os.clock() - gather.at > 0.35 then gather = nil end
    local canFocus = gameplayCanAcquire(player)
    local npc, identity
    local lookKey, lookEntity, lookName, lookSpawned
    if canFocus then
        local found, result = pcall(targetAtCrosshair, gather)
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
    -- Voice activation (mod/voice-activation.lua) asks whether somebody is faced: one clock read on this scan, nothing more.
    if lookKey then convaiLookSeenAt = os.clock() end
    if focusMode == 'gaze' then
        if identity == focusEntity then gazeState.lost = 0; return end
        gazeState.lost = gazeState.lost + step
        if gazeState.lost < 1.5 then return end
        endFocus(player)
        focusMode = nil
        focusEntity = nil
        resetGaze()
    end
    if not npc then resetGaze(); return end
    if gazeState.candidate ~= identity then
        gazeState.candidate = identity
        gazeState.dwell = 0
        return
    end
    gazeState.dwell = gazeState.dwell + step
    if gazeState.dwell < 0.2 then return end
    local focused, reason = beginFocus(player, npc)
    if focused then
        focusMode = 'gaze'
        focusEntity = identity
        gazeState.lost = 0
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
    -- A copy of ours (the Model browser's, an invitation's) is spawned from a private clone of its model's record for a crowd or an unarmed
    -- model ("CyberpunkConvai.NonCrowd_X", "CyberpunkConvai.Armed_X"): the record that finds it later is the model's own, which the copy remembers.
    -- The model's name is what the catalogue matches a copy by, so it fills the name when the game gives none.
    local identified, _, _, owned, _, copyRecord, copyName = pcall(companions.identity, npc)
    if identified and owned == true then
        if type(copyRecord) == 'string' and copyRecord:find('^[%w_][%w_%.%-]+$') then debugName = copyRecord end
    else
        copyName = nil
    end
    -- The original of a record-cloning mod's copy ("NCA.Character.X" is "Character.X": the editor's rule finds both), else the readable name.
    local record = debugName and (characterCatalog.originalRecordName(debugName)
        or (debugName:find('^[%w_][%w_%.%-]+$') and debugName or nil)) or nil
    local name = read(function() return tostring(npc:GetTweakDBFullDisplayName(true) or '') end) or read(function() return copyName end)
    local body = read(function() return tostring(npc:GetBodyType() or '') end)
    local gender = type(characterCatalog.gender) == 'function'
        and characterCatalog.gender({gender = read(function() return nameString(npc:GetResolvedGenderName()) end), bodyType = body}) or nil
    if not record and not name then return nil end
    return {record = record, name = name, gender = gender == 'FEMALE' and 'female' or gender == 'MALE' and 'male' or nil}
end

-- Talking with nobody in view goes to the party (docs/TALK_FALLBACK.md), decided once on the key press, never polled. Global functions: the
-- main chunk is at Lua's limit of local variables.
-- Private talk: the first party member, in the Companion Manager's Current party order, who is within talk range and whose
-- profile can answer. nil when there is none.
function convaiTalkFirstParty(player)
    if type(companions.partyInOrder) ~= 'function' then return nil end
    local ok, rows = pcall(companions.partyInOrder, player, 8)
    if not ok or type(rows) ~= 'table' then return nil end
    for _, row in ipairs(rows) do
        if supportedProfiles[row.profileKey] and profileEnabled(player, row.profileKey) then return row end
    end
    return nil
end

-- Group talk: the first party member, then two more picked at random from the rest of the party (fewer when the party is
-- smaller), then the unchosen party members and everyone else in the list (visiting housemates, spawned characters), who fill
-- the round only when the party cannot (groupChat.choose takes three). nil when no party member is in the list.
function convaiTalkGroupFromParty(candidates, random)
    local party, others = {}, {}
    for _, candidate in ipairs(candidates) do
        if candidate.party then party[#party + 1] = candidate else others[#others + 1] = candidate end
    end
    if #party == 0 then return nil end
    table.sort(party, function(a, b) return (a.order or 0) < (b.order or 0) end)
    random = random or math.random
    local list = {table.remove(party, 1)}
    for _ = 1, 2 do
        if #party == 0 then break end
        list[#list + 1] = table.remove(party, random(#party))
    end
    for _, candidate in ipairs(party) do list[#list + 1] = candidate end
    for _, candidate in ipairs(others) do list[#list + 1] = candidate end
    return list
end

-- The key that answers one person, for a notice that points the player to it ("Use {key} for one person."): the key set on the mod's own Key
-- bindings page, else CET's binding of the action, and when neither gives text that can be read (no key, or a binding whose text is blank or
-- invisible) the action's own name ("Talk by text"), so the sentence is never "Use  for one person." action: 'cyberpunk_convai_text' or
-- 'cyberpunk_convai_voice'. Key press only. A global, so no function here gains an upvalue.
function convaiKeyHint(action)
    local own = type(action) == 'string' and action:match('^cyberpunk_convai_(%a+)$') or nil
    local function readable(text)
        if type(text) ~= 'string' then return false end
        -- Whitespace, no-break space, zero-width and format characters are not a key's name.
        local visible = text:gsub('\226\128[\139-\143\168-\175]', ''):gsub('\194\160', ''):gsub('\239\187\191', '')
        return visible:find('%S') ~= nil
    end
    if own and convaiKeyBinds and type(convaiKeyBinds.label) == 'function' and type(manager.keyBindings) == 'function' then
        local ok, text = pcall(function()
            local bindings = manager.keyBindings()
            local name = type(bindings) == 'table' and bindings[own] or nil
            return convaiKeyBinds.label(name, ui.t)
        end)
        if ok and readable(text) then return text end
    end
    local cet = ui.boundKey(action)
    if readable(cet) then return cet end
    return ui.t(own == 'voice' and 'Talk by voice' or 'Talk by text')
end

-- Group talk takes anyone nearby that V can talk to, not only companions and characters another mod placed: the ordinary people of the
-- street (strangers), the game's named characters (while Talk to story characters is on) and quest-bound people, after the ones V faces and
-- V's companions. Rows for the NPCs of this key press's own native query (convaiTalkNative: what the camera sees within 8 m, already gathered
-- for the talk target), nearest first, at most `limit`, within `radius` metres, same row shape as companions.conversationCandidates plus
-- stranger = true (and generic/archetype for an ordinary person, story or guarded for a game-placed character). `taken` is the set of
-- entity IDs already in the round. A game-placed person is treated as the private talk treats it (docs/WORLD_CHARACTERS.md): talk, voice and
-- face only, and left out while the game is in charge of them (the same refusal as "{name} is busy right now."). Key press only; no query of
-- its own. A global, so no function here gains an upvalue.
function convaiTalkNearbyPeople(player, taken, limit, radius)
    local rows, stats = {}, {seen = 0, noProfile = 0, unsupported = 0, disabled = 0, refused = 0, far = 0}
    local list = convaiTalkNative
    if type(list) ~= 'table' or not player or limit < 1 then return rows, stats end
    local okOrigin, origin = pcall(function() return player:GetWorldPosition() end)
    if not okOrigin or not origin then return rows, stats end
    local measured, seen = {}, {}
    for _, npc in ipairs(list) do
        pcall(function()
            if not npc:IsNPC() or not npc:IsAttached() or npc:IsDeadNoStatPool() then return end
            if adoption and adoption.hidden(npc) then return end
            if convaiTalkExcluded ~= nil and convaiTalkExcluded(npc) then return end
            local id = tostring(npc:GetEntityID().hash)
            if seen[id] or taken[id] then return end
            seen[id] = true
            local at = npc:GetWorldPosition()
            local distance = math.sqrt((at.x - origin.x)^2 + (at.y - origin.y)^2 + (at.z - origin.z)^2)
            if distance > radius then stats.far = stats.far + 1; return end
            measured[#measured + 1] = {npc = npc, entity = id, distance = distance}
        end)
    end
    table.sort(measured, function(a, b)
        if a.distance == b.distance then return a.entity < b.entity end
        return a.distance < b.distance
    end)
    local hostile = Enum ~= nil and Enum.new('EAIAttitude', 'AIA_Hostile') or nil
    for _, item in ipairs(measured) do
        if #rows >= limit then break end
        stats.seen = stats.seen + 1
        pcall(function()
            local npc = item.npc
            -- Our own copies and the characters another mod placed are the other lists' (companions, convaiSpawnedPeople.nearby).
            if companions.owns(npc) == true then return end
            if convaiWorldPolicy ~= nil and convaiWorldPolicy.spawned(npc) == true then return end
            -- Somebody who is fighting V is not a person to chat with.
            if hostile ~= nil then
                local read, attitude = pcall(function() return npc:GetAttitudeAgent():GetAttitudeTowards(player:GetAttitudeAgent()) end)
                if read and attitude == hostile then return end
            end
            local key, name, body, archetype = profileIdentity(npc)
            if not key then stats.noProfile = stats.noProfile + 1; return end
            if not supportedProfiles[key] then stats.unsupported = stats.unsupported + 1; return end
            if not manager.profileEnabled(key) then stats.disabled = stats.disabled + 1; return end
            local story = convaiWorldPolicy ~= nil and convaiWorldPolicy.story(npc) == true or false
            local guarded = false
            if not story and convaiWorldTalk ~= nil and convaiWorldPolicy ~= nil
                and (convaiWorldPolicy.protected(npc) == true or convaiWorldTalk.runtimeQuest(npc) == true) then guarded = true end
            if story or guarded then
                local why = convaiWorldTalk:refusal(npc, player, nil, key, guarded or nil)
                if why then stats.refused = stats.refused + 1; return end
            end
            local row = {npc = npc, entity = item.entity, profileKey = key, name = name, bodyType = body,
                distance = item.distance, stranger = true, story = story or nil, guarded = guarded or nil}
            if not archetype and archetypes.keys[key] and type(characterCatalog.describe) == 'function' then
                archetype = characterCatalog.describe(archetypes, key, {})
            end
            if archetype or key == 'resident-male' or key == 'resident-female' then
                row.generic = true
                row.archetype = archetype
            end
            rows[#rows + 1] = row
        end)
    end
    return rows, stats
end

-- The Johnny keys (docs/JOHNNY_IN_YOUR_HEAD.md): Johnny as the voice in V's head, wherever V faces, while the story has him there and
-- the game does not have the floor. Otherwise a notice says why and nothing starts.
function convaiTalkJohnny(player)
    local head = type(convaiJohnnyHeadService) == 'function' and convaiJohnnyHeadService() or nil
    if not head then
        convaiNotices.send(player, 'talk-johnny-off', ui.t('Johnny in your head is off. Turn it on in Settings > Conversations.'))
        return nil
    end
    local why = head:refusal(player)
    if why == nil and supportedProfiles[head.key] and profileEnabled(player, head.key) then
        local partner = head:partner(player)
        if partner then
            convaiHeadTalk = {entity = partner.entity}
            log('Johnny in your head: conversation stage=' .. tostring(partner.head.stage))
            return partner
        end
    elseif why ~= nil and why ~= 'before' and why ~= 'after' and why ~= 'unreadable' then
        log('Johnny in your head: refused reason=' .. why .. ' facts[' .. head:detail() .. ']')
        convaiNotices.send(player, 'talk-busy', ui.t('{name} is busy right now.', {name = head.name}))
        return nil
    end
    log('Johnny in your head: not in V\'s head (' .. tostring(why or 'muted') .. ')')
    convaiNotices.send(player, 'talk-johnny-away', ui.t('{name} is not in your head right now.', {name = head.name}))
    return nil
end

-- addonHears: this computer can recognise speech locally (manager.speechRecognitionReady), which an add-on voice needs to answer the
-- voice keys; the caller asks it on the key press only, and only while an add-on is live.
-- talkJohnny: the Johnny keys (Talk to Johnny by voice or text): Johnny, whoever V faces.
local function selectConversation(player, groupMode, singleAction, addonHears, talkJohnny)
    if talkJohnny then return convaiTalkJohnny(player) end
    -- A character the player made may have been saved since the last look: the list is read if it is due (at most every 3 s, and only while
    -- there are characters or the editor was opened lately: mod/custom-characters.lua).
    if convaiCustomCharacters then
        pcall(convaiCustomCharacters.refresh); pcall(convaiCustomCharacters.checkProvider)
        convaiSettleCopyProfiles()
    end
    -- On a connected holocall the private talk keys address the caller wherever V is (mod/holocall.lua).
    local caller = convaiHolocall and convaiHolocall.partner(player, groupMode) or nil
    if caller then log('Holocall conversation: profile=' .. caller.profileKey .. ' mode=' .. caller.holocall.mode); return caller end
    local npc, reason, decision = targetAtCrosshair()
    logTalkTarget(decision)
    if convaiSpawnedPeople then convaiSpawnedPeople.noteNative(convaiTalkNative) end
    -- A named character of the game, or a quest-bound person, takes part in a group round like anybody else (talk, voice and face only,
    -- docs/WORLD_CHARACTERS.md) while the game leaves them alone. Aimed at while the game is in charge of them ("busy right now"), they are
    -- not a member of the round, which is then built from the people around, as when V aims at nothing.
    if groupMode and npc and convaiWorldTalk ~= nil and convaiWorldPolicy ~= nil and not companions.owns(npc)
        and not convaiWorldPolicy.spawned(npc) then
        local story = convaiWorldPolicy.story(npc) == true
        if story or convaiWorldPolicy.protected(npc) == true or convaiWorldTalk.runtimeQuest(npc) == true then
            local faced = profileIdentity(npc)
            local why = faced and convaiWorldTalk:refusal(npc, player, nil, faced, not story or nil) or nil
            if why then
                log('World conversation refused: group chat leaves out the faced person, reason=' .. why)
                npc, reason = nil, 'Face a nearby character to talk.'
            end
        end
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
        -- Anyone else V could talk to fills the round (up to three people in all): the ordinary people of the street, the game's named
        -- characters and quest-bound people, nearest first, from the native query this key press already made (convaiTalkNearbyPeople).
        if convaiTalkNearbyPeople then
            local taken, count = {}, 0
            local function take(entity) if entity ~= nil and not taken[entity] then taken[entity] = true; count = count + 1 end end
            if npc then pcall(function() take(tostring(npc:GetEntityID().hash)) end) end
            for _, candidate in ipairs(candidates) do take(candidate.entity) end
            if count < 3 then
                local others, found = convaiTalkNearbyPeople(player, taken, 3 - count, convaiStrangerRange or 6)
                for _, row in ipairs(others) do candidates[#candidates + 1] = row end
                log('Group candidates: people=' .. #others .. ' of ' .. tostring(found.seen) .. ' looked at (noProfile=' .. found.noProfile
                    .. ' unsupported=' .. found.unsupported .. ' disabled=' .. found.disabled .. ' refused=' .. found.refused
                    .. ' far=' .. found.far .. ')')
            end
        end
        -- Nobody faced: the first party member leads and two more come at random from the party (fewer in a smaller party).
        if not npc then
            local ordered = convaiTalkGroupFromParty(candidates)
            if ordered then
                candidates = ordered
                log('Talk fallback: group of the party, first=' .. tostring(ordered[1].profileKey)
                    .. ' then=' .. tostring(ordered[2] and ordered[2].profileKey) .. ',' .. tostring(ordered[3] and ordered[3].profileKey))
            end
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
                convaiNotices.send(player, 'group-needs-two',
                    ui.t('Group chat needs two characters nearby. Use {key} for one person.', {key = convaiKeyHint(singleAction)}))
                return nil
            end
            log('Add-on voice conversation: profile=' .. voice.profileKey)
            return voice, together
        end
    end
    if not npc and groupMode and candidates[1] and not candidates[1].voiceOnly then npc = candidates[1].npc end
    -- Nobody faced (docs/TALK_FALLBACK.md): private talk goes to the first party member in range. Without a party, the notice below.
    -- Johnny has his own keys (Talk to Johnny, convaiTalkJohnny above): facing nobody no longer reaches him.
    local fallback = nil
    if not npc and not groupMode then
        local member = convaiTalkFirstParty(player)
        if member then
            npc, fallback = member.npc, true
            log('Talk fallback: first party member ' .. tostring(member.profileKey))
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
                ui.t('{name} is one of your own characters. They need Google Gemini, Local AI or Custom, so with Convai they talk as an ordinary person.', {name = skipped.name}))
        end
    end
    if not key or not supportedProfiles[key] then
        local told = key == nil and convaiUnprofiledNotice and convaiUnprofiledNotice(npc, name) or nil
        convaiNotices.send(player, 'talk-no-profile', told or ui.t('{name} does not have a conversation profile configured yet.',{name=name}))
        log('Conversation unavailable: profile=' .. tostring(key) .. (key == nil and convaiUnprofiledWhy and convaiUnprofiledWhy(npc) or ''))
        return nil
    end
    if not profileEnabled(player, key) then log('Companion disabled in manager: ' .. name); return nil end
    local primary = {npc = npc, name = name, entity = tostring(npc:GetEntityID().hash), bodyType = bodyType, profileKey = key,
        spawned = convaiWorldPolicy ~= nil and convaiWorldPolicy.spawned(npc) or nil, fallback = fallback}
    -- A named character of the game (docs/WORLD_CHARACTERS.md) is talked to only while the game is not in charge of it: not in a
    -- scene or quest dialogue, not while V is in a quest conversation, not under a scene's or quest's AI, in a fight, hurt or
    -- riding. Read fresh on this key press; the same test then guards the recording and the reply. Nothing of the character
    -- is touched: a refusal is a notice and a log line.
    primary.story = convaiWorldPolicy ~= nil and convaiWorldPolicy.story(npc) == true or nil
    -- projection: Johnny Silverhand, whom the game's scenes and mounts command all the time (sitting in V's car): his face is asked for and
    -- written without the commanded-AI refusal (Face.reds TalkRefusal, mod/facial-playback.lua luaActorSafe). His own scene dialogue,
    -- a fight and an injury still keep his mouth to the game.
    local projection = primary.story and convaiWorldTalk ~= nil and convaiWorldTalk.PROJECTIONS ~= nil
        and convaiWorldTalk.PROJECTIONS[key] == true or nil
    convaiStory = primary.story and {entity = primary.entity, key = key, name = name, projection = projection} or nil
    -- The face writer then judges this one speaker by the story rules (no scene flag: it stays true in ordinary gameplay).
    if convaiFacialPlayback then
        convaiFacialPlayback.storyEntity = convaiStory and convaiStory.entity or nil
        convaiFacialPlayback.storyProjection = projection == true
    end
    if primary.story then
        local why = convaiWorldTalk:refusal(npc, player, nil, key)
        if why then
            convaiStory = nil
            -- The facts behind the refusal (a refusal only, once per key press): every game fact read, V's scene facts, the record and
            -- the quest flag. A player's "busy right now" with no quest running is told apart from a real scene by exactly these.
            log('World conversation refused: profile=' .. key .. ' reason=' .. why
                .. (convaiWorldTalk.detail and (' (' .. convaiWorldTalk.detail .. ')') or '')
                .. (convaiWorldTalk.facts and (' facts[' .. convaiWorldTalk.facts .. ']') or '')
                .. (convaiUnprofiledWhy and convaiUnprofiledWhy(npc) or ''))
            convaiNotices.send(player, 'talk-busy', ui.t('{name} is busy right now.', {name = name}))
            return nil
        end
        log('World conversation: profile=' .. key .. ' (voice and face only)')
    end
    -- A quest-bound person with no roster profile (a receptionist in a main quest's building, a bouncer, a worker of a quest area) talks as
    -- their archetype like anyone else, but the game's own checks still apply while it has them: V in a quest conversation, a call or a
    -- scene, the person in a scene dialogue, a fight, an injury or a ride (mod/world-talk.lua). Standing or idling at a workspot is
    -- not a scene: `idle` (the fifth argument) lets a commanded AI through while the person is in a workspot. Read fresh on this key
    -- press, cached per entity (protected), and the same test then guards the recording and the reply (convaiStory).
    if not primary.story and not primary.spawned and convaiWorldTalk ~= nil and convaiWorldPolicy ~= nil
        and not companions.owns(npc) and (convaiWorldPolicy.protected(npc) == true or convaiWorldTalk.runtimeQuest(npc) == true) then
        local why = convaiWorldTalk:refusal(npc, player, nil, key, true)
        if why then
            log('World conversation refused: profile=' .. key .. ' reason=' .. why .. ' (quest-bound)'
                .. (convaiWorldTalk.detail and (' (' .. convaiWorldTalk.detail .. ')') or '')
                .. (convaiWorldTalk.facts and (' facts[' .. convaiWorldTalk.facts .. ']') or '')
                .. (convaiUnprofiledWhy and convaiUnprofiledWhy(npc) or ''))
            convaiNotices.send(player, 'talk-busy', ui.t('{name} is busy right now.', {name = name}))
            return nil
        end
        primary.guarded = true
        convaiStory = {entity = primary.entity, key = key, name = name, idle = true}
        if convaiFacialPlayback then
            convaiFacialPlayback.storyEntity = primary.entity
            convaiFacialPlayback.storyProjection = false
        end
        log('World conversation: profile=' .. key .. ' (quest-bound, archetype)')
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
        -- Settings > Dynamic info > Location: off, an ordinary NPC is not told where it stands either.
        local place = (manager.dynamicInfo == nil or manager.dynamicInfo('location')) and currentDistrict() or nil
        if place then primary.archetype.district, primary.archetype.area = place.district, place.area end
        -- A nameless ordinary NPC gets its Night City name (the same one the scanner shows); the caption, the composer and the
        -- bridge's "Your name is ..." line use it. Nil with the setting off or for anyone the gate refuses.
        local generated = convaiNpcNames and convaiNpcNames.nameFor(npc, 'talk') or nil
        if generated then primary.name, primary.archetype.npcName = generated, generated end
        log('Archetype conversation: profile=' .. key .. ' base=' .. tostring(primary.archetype.base)
            .. ' district=' .. tostring(primary.archetype.district) .. (convaiArchetypeIdentity and convaiArchetypeIdentity(npc) or ''))
    end
    local participants = groupMode and groupChat.choose(primary, candidates, supportedProfiles) or nil
    -- A generic spawned person in the round learns where it stands and gets its Night City name, like a generic primary.
    for _, person in ipairs(participants or {}) do
        if person ~= primary and (person.spawned or person.stranger) and person.generic then
            person.archetype = person.archetype or {category = 'resident'}
            local place = (manager.dynamicInfo == nil or manager.dynamicInfo('location')) and currentDistrict() or nil
            if place then person.archetype.district, person.archetype.area = place.district, place.area end
            local generated = convaiNpcNames and convaiNpcNames.nameFor(person.npc, 'talk') or nil
            if generated then person.name, person.archetype.npcName = generated, generated end
        end
    end
    if participants and #participants < 2 then
        convaiNotices.send(player, 'group-needs-two',
            ui.t('Group chat needs two characters nearby. Use {key} for one person.', {key = convaiKeyHint(singleAction)}))
        return nil
    end
    -- The ongoing conversation keeps this partner on the next talk key press.
    if convaiTalkTarget then pcall(convaiTalkTarget.remember, primary.entity) end
    return primary, participants
end

local function voiceTargetValid(npc, context)
    local player = convaiPlayer()
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
    if convaiReputation or convaiReputationPending then pcall(convaiReputationAttach, context) end
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
    -- A spoken line is V talking too: nothing prepared ahead survives it, and a reply to it may get a follow-on (docs/COMPANION_SPEAK_UP.md).
    if convaiSpeakUpManualSent then pcall(convaiSpeakUpManualSent, context) end
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
local function beginTextNow(groupMode, waited, talkJohnny)
    local ok, err = pcall(function()
        local player = convaiPlayer()
        if not player or not gameplayCanAcquire(player) then return end
        local primary, participants = selectConversation(player, groupMode, 'cyberpunk_convai_text', nil, talkJohnny)
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
            local faceOk, faceStatus = convaiFaceRequestFor(npc, identity)
            convaiFaceRequestLog(npc, identity, faceOk, faceStatus)
            -- A holocall's live-picture copy is far away and held still: it never turns to V.
            if focusEntity ~= identity and not primary.holocall and not (primary.story or primary.guarded) then
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
        -- The talk key was pressed: the game's own greeting and grunt barks (V's target and the NPCs around V) stay silent from here
        -- (vanilla-reactions.lua barkHold); a late one that already started cannot be taken back.
        if convaiVanillaReactions then pcall(convaiVanillaReactions.talkPressed) end
        active = {generation = generation, entity = identity, name = name, bodyType = bodyType,
            profileKey = key, participants = participants, archetype = primary.archetype, voiceOnly = primary.voiceOnly,
            holocall = primary.holocall, head = primary.head}
        -- Facing nobody, the first party member took the line (selectConversation): the hand-off says so in probe.log (a global, not in the request).
        convaiTalkFallbackGeneration = primary.fallback and not participants and generation or nil
        warmConversation(participants, key, identity)
        convaiDemandKnowledge() -- fresh world and journal by the time V sends
        -- V types for seconds: the history rows of a scan under way are encoded now, a few per frame, not on the send frame.
        if type(journalHistory.preEncode) == 'function' then pcall(journalHistory.preEncode, journalHistory, 30) end
        if connectNote then convaiNotices.send(player, 'talk-connecting', connectNote) end
        pending = nil
        convaiComposerWatch.opened(generation)
        log('Composer opened: generation=' .. generation .. ' actor=' .. identity .. ' name=' .. name
            .. ' speed=' .. speedAtOpen .. ' moveAxis=' .. moveAtOpen
            .. (waited and string.format(' waited=%.2f', waited) or ''))
    end)
    if not ok then log('Open failed: ' .. tostring(err)) end
end

local function beginText(groupMode, talkJohnny)
    local player = convaiPlayer()
    local gate = convaiTalkGate
    if player and gate and moveStateText(player) == 'held' then
        -- A second press while waiting only updates which chat was asked for.
        local waiting = gate.waiting
        gate.waiting = {group = groupMode, johnny = talkJohnny, waited = waiting and waiting.waited or 0}
        if not waiting then log('Talk box waits for the movement keys to be released') end
        return
    end
    if gate then gate.waiting = nil end
    beginTextNow(groupMode, nil, talkJohnny)
end

-- Called from onUpdate (a nil check per frame while nobody is waiting). Opens the
-- box once the axes are released, when the wait runs out, or drops the request when
-- the world is not playable any more.
convaiTalkGate = {}
function convaiTalkGate.update(delta, worldReady)
    local waiting = convaiTalkGate.waiting
    if not waiting then return end
    if not worldReady then convaiTalkGate.waiting = nil; return end
    local player = convaiPlayer()
    if not player then convaiTalkGate.waiting = nil; return end
    waiting.waited = waiting.waited + (tonumber(delta) or 0)
    local stillHeld = moveStateText(player) == 'held'
    if stillHeld and waiting.waited < TALK_WAIT_MAX then return end
    convaiTalkGate.waiting = nil
    -- A reading that never cleared is probably an unseen key-up: forget it so the
    -- next talk request is not delayed by it, then open the box anyway.
    if stillHeld then pcall(function() player:ConvaiMoveForget() end) end
    beginTextNow(waiting.group, waiting.waited, waiting.johnny)
end

-- Hold to talk: the voice key records from the moment it goes down until it comes up, and V's turn ends there (docs/VOICE_INPUT.md).
-- source: 'press' (the key went down: begin a recording), 'release' (the key came back up: finish it, even while the bridge is still opening)
-- or 'vad' (Voice activation heard V start speaking: begin, with no key; mod/voice-activation.lua).
-- holdId: this key press's id, already told to the bridge (mod/microphone.lua holdKey) so its microphone tap is open. vadId: the detector's id for the start.
-- No notice is shown for a normal turn: no "connecting", no "listening", no "finished". Only a real failure speaks (no microphone, no connection).
local function toggleVoice(groupMode, source, holdId, vadId, talkJohnny)
    source = source or 'press'
    local player = convaiPlayer()
    if not player then return end
    local ok, err = pcall(function()
        local mode = groupMode and 'group' or 'private'
        if microphone.context then
            local recordingMode = microphone.context.group and 'group' or 'private'
            -- The other voice key's recording: this key does nothing to it.
            if recordingMode ~= mode then return end
            local press = microphone.press()
            if source == 'release' then
                -- The key that began this recording is let go: V's turn ends now, whether the bridge is still opening or already recording.
                -- Anything else about the recording is left alone.
                if press == 'busy' and gameplayCanAcquire(player) and not (microphone.targetValid and not microphone.targetValid(microphone.context)) then
                    acceptVoiceSubmission(microphone.finish(mode, 'release'))
                end
                return
            end
            -- A press while a recording runs (a key repeat, a second key) or while a reply is on its way changes nothing (mod/microphone.lua press).
            if press ~= 'retry' then return end
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
        local primary, participants = selectConversation(player, groupMode, 'cyberpunk_convai_voice', addonHears, talkJohnny)
        if not primary then return end
        if conversationServiceBlocked(player) then return end
        -- The target is known: the bridge opens the microphone now and keeps what it hears, before the preparation below and the connection
        -- behind it. Whatever V says from here on is not lost, however long they take.
        if holdId then microphone.holdKey(holdId) end
        local npc, key, name, body, entity = primary.npc, primary.profileKey, primary.name, primary.bodyType, primary.entity
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
            local faceOk, faceStatus = convaiFaceRequestFor(npc, entity)
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
                return head ~= nil and head:refusal(convaiPlayer()) == nil
            end
            if primary.voiceOnly then return convaiAddons ~= nil and convaiAddons.participantLive(primary, convaiPlayer()) end
            if (primary.story or primary.guarded) and convaiWorldTalk:refusal(npc, convaiPlayer(), entity, primary.profileKey, primary.guarded) then return false end
            return voiceTargetValid(npc, context)
        end
        context.provider = chosenProvider()
        if microphone.begin(context, targetValid, source == 'vad' and 'vad' or 'press', {hold = holdId, vadId = vadId}) then
            if not primary.voiceOnly and not primary.holocall and not (primary.story or primary.guarded) then beginFocus(player, npc) end
            focusMode, focusEntity, focusUntil = 'chat', entity, os.time() + 120
            if convaiVanillaReactions then pcall(convaiVanillaReactions.talkPressed) end
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
    local speakUp = context.reaction ~= nil and context.reaction.kind == 'speakup'
    -- A housemate's welcome when V comes home is a talk with V: it carries the game clock (and the right-now facts) so the bridge can word how long it
    -- has been since V last talked to her (bridge/last-talk.mjs). A housemates' chat line between two of them is not.
    local houseWelcome = context.reaction ~= nil and context.reaction.kind == 'house' and context.reaction.event == 'welcome'
    if (not context.reaction or (speakUp and context.reaction.event == 'scene')) and convaiGameDialogue then
        context.gameDialogue = context.gameDialogue or convaiGameDialogue:capture()
    end
    if not context.reaction and convaiPlayerGear then context.gear = context.gear or convaiPlayerGear:capture() end
    if (not context.reaction or speakUp or houseWelcome) and convaiTurnContext then context.turnContext = context.turnContext or convaiTurnContext:capture() end
    if not context.reaction and context.turnContext and convaiAppointmentTurn then context.turnContext = convaiAppointmentTurn(context.turnContext, context.profileKey) end
    -- A holocall line to a character standing beside V (convaiNearbyTurn): she is told so, as a phone chat's character is.
    if context.holocall and context.turnContext and convaiNearbyTurn then
        local ok, nearby = pcall(convaiNearbyTurn, context.turnContext, context.profileKey)
        if ok then context.turnContext = nearby end
    end
    -- Housemates: where she lives, whether she is home, who else lives there (bridge/turn-context.mjs `housemate`).
    if not context.reaction and context.turnContext and convaiHousemateTurn then context.turnContext = convaiHousemateTurn(context.turnContext, context.profileKey) end
    -- Street reputation (docs/REPUTATION_DESIGN.md): nil checks only while the setting is off.
    if convaiReputation or convaiReputationPending then pcall(convaiReputationAttach, context) end
    -- Automatic turns have one subject. Manual conversations may still discuss
    -- recent combat and pickups together when V asks about them.
    if context.reaction and (context.reaction.kind == 'loot' or context.reaction.kind == 'head' or speakUp) then context.battle = nil
    -- A battle reaction already carries its own fight (battles.offer); a manual turn reads it through battles.captureManual (Health, heat and
    -- fights off: nothing). The module's own capture is the reaction's and is never gated.
    else context.battle = context.battle or (battles.captureManual or battles.capture)() end
    -- A greeting at a meeting (immersive invitations) has one subject too.
    if context.reaction and context.reaction.kind == 'meet' then context.battle = nil end
    -- So has a housemates' chat line or greeting (mod/housemates.lua).
    if context.reaction and context.reaction.kind == 'house' then context.battle = nil end
    local current = knowledgeOwner(refreshKnowledgeFrame())
    if not knowledgeAllowed or current.paused or not sameKnowledgeOwner(owner, current) then return false end
    if context.holocall then
        -- A holocall's caller is not here (mod/holocall.lua): no follow, fight or drive is offered. The one thing a call can ask for is a meeting
        -- (immersive invitations): gameplay-actions.lua leases only that for a call, and only while the setting is On.
        if not context.reaction then gameplayActions.capture(context, 'private-text') end
    elseif context.head then
        -- Johnny in V's head has no body (docs/JOHNNY_IN_YOUR_HEAD.md): no gameplay actions, no add-on blocks.
    elseif context.voiceOnly then
        -- An add-on's voice (docs/ADDON_API.md) cannot follow, fight or drive: no gameplay actions, and its context blocks.
        if convaiAddons and convaiAddons.live then convaiAddons.decorate(context) end
    elseif convaiStory and convaiStory.entity == context.entity then
        -- A game-placed story character gets no action offers or advisories (docs/WORLD_CHARACTERS.md).
    elseif not context.group and not context.reaction then gameplayActions.capture(context, 'private-text')
    elseif context.group and context.group.index == 1 and not context.reaction then
        gameplayActions.capture(context, 'group-text')
    end
    -- In place over the shipped placeholder (Mod Organizer 2 never sees a new or deleted file). The bridge retries a
    -- half-written read on the file's next change; an empty file means "no request".
    -- Encoded first: an encoder that raises after the file was opened for writing left it emptied, its handle open, and the error escaping the caller.
    local providerOk, provider = pcall(function() return chosenProvider() end)
    context.provider = providerOk and provider or nil
    -- Eddies with characters (docs/EDDIES.md): one boolean while it is off.
    if not context.reaction and not context.group then convaiEddiesAttach(context) end
    local encodedOk, encoded = pcall(json.encode, context)
    if not encodedOk then
        gameplayActions.revoke('request-write-failed', context.requestId)
        convaiLogOnce('Request could not be encoded', 'Request could not be encoded: ' .. tostring(encoded))
        return false
    end
    local file = io.open('runtime/last-input.json', 'wb')
    if not file then gameplayActions.revoke('request-write-failed', context.requestId); return false end
    file:write(encoded); file:close()
    pending = context
    pendingKnowledgeOwner = owner
    if not context.reaction then
        focusUntil = os.time() + 90
        -- V's line is sent: the reply is on its way, the window stays open until its own line takes over (speech.lua).
        if convaiVanillaReactions then pcall(convaiVanillaReactions.requestSent) end
    end
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
        if sent and not context.reaction and convaiSpeakUpManualSent then pcall(convaiSpeakUpManualSent, context) end
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
        -- A Chat row the journal has no contact for (a character the player made, Rita Wheeler and the roster) can be called too: the window shows
        -- her name and the unknown-caller picture. A character the player made needs Google Gemini, Local AI or Custom, as her Chat does.
        -- The record of her game definition (the invite list's, or the roster's), when she has one, is the body filmed for a video call.
        chatRow = function(contact)
            local row = convaiPhoneChat and convaiPhoneChat.callRow(contact) or nil
            if row and convaiCompanions and type(convaiCompanions.definition) == 'function' then
                local asked, definition = pcall(convaiCompanions.definition, row.key)
                if asked and type(definition) == 'table' and type(definition.id) == 'string' and definition.id ~= '' then row.record = definition.id end
            end
            return row
        end,
        blocked = function(key)
            local chat = convaiPhoneChat
            return chat ~= nil and type(chat.contactBlocked) == 'function' and chat.contactBlocked(key) == true
        end,
        liveImage = function() return true end,   -- always on (the setting was removed 2026-10-20); the call still goes on with the portrait when the picture cannot be shown
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
        local why = head == nil and 'off' or head:refusal(convaiPlayer())
        if not why then return false end
        log('Johnny in your head: reply ended reason=' .. why .. (starting and ' (before the reply began)' or '')
            .. ' facts[' .. (head and head:detail() or 'off') .. ']')
        if starting then return true end
        retirePrivateReply(context.entity, 'head-' .. why)
        return true
    end
    local story = convaiStory
    if not story or convaiWorldTalk == nil or type(context) ~= 'table' or context.entity ~= story.entity then return false end
    local why = convaiWorldTalk:refusal(actor, convaiPlayer(), story.entity, story.key, story.idle)
    if not why then return false end
    log('World conversation ended: profile=' .. story.key .. ' reason=' .. why .. (starting and ' (before the reply began)' or '')
        .. (convaiWorldTalk.detail and (' (' .. convaiWorldTalk.detail .. ')') or '')
        .. (convaiWorldTalk.facts and (' facts[' .. convaiWorldTalk.facts .. ']') or ''))
    -- A speaker of a group round: the round goes on without it (its line is dropped, the next speaker comes), instead of a private reply being retired.
    if type(context.group) == 'table' and groupChat.round ~= nil and groupChat.round.requestId == context.requestId then
        if starting then
            groupChat.received(context.requestId, '', true, {})
            if pending and pending.requestId == context.requestId then pending = nil end
            return true
        end
        pcall(speech.stop, 'story-' .. why)
        groupChat.completed(context.requestId, false)
        return true
    end
    if starting then return true end
    retirePrivateReply(context.entity, 'story-' .. why)
    return true
end

local function reactionLease(valid)
    if not automatic then return false end
    local now = os.time()
    if valid and automatic.leaseAt == now then return true end
    -- In place: the bridge keeps its last good lease when it reads a partial file (bridge/battle-lease.mjs).
    local encodedOk, encoded = pcall(json.encode, {requestId = automatic.requestId, valid = valid, updated = now * 1000,
        playbackStartedAt = automatic.playbackAt and automatic.playbackAt * 1000})
    if not encodedOk then return false end
    local file = io.open('runtime/reaction-lease.json', 'wb')
    if not file then return false end
    file:write(encoded); file:close()
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
    if lastAutomatic and lastAutomatic.requestId == automatic.requestId then
        lastAutomatic.finishedAt = os.time()
    end
    -- An unprompted line (a companion's speak-up, Johnny's remark or follow-on) gives the floor back to the scheduler; one nobody heard does not count.
    local hold = convaiSpeakUpState and convaiSpeakUpState.hold
    if hold and hold.requestId == automatic.requestId then
        convaiSpeakUpState.hold = nil
        if convaiSpeakUp then pcall(convaiSpeakUp.release, convaiSpeakUp, hold.who, automatic.playbackAt ~= nil) end
    end
    -- A line of a party round tells the round how it ended (convaiPartyLineEnded).
    if automatic.party and convaiPartyLineEnded then pcall(convaiPartyLineEnded, automatic, reason) end
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
            -- (A character the player told in the editor not to comment on fights and loot is left out; Look and moves.)
            local chosen = convaiCharacterOptions and convaiCharacterOptions.get(person.profileKey)
            if supportedProfiles[person.profileKey] and manager.profileEnabled(person.profileKey) and not (chosen and chosen.react == false) then
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
            local chosen = convaiCharacterOptions and convaiCharacterOptions.get(person.profileKey)
            if not present[person.profileKey] and not (chosen and chosen.react == false) then
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

-- ---- Immersive invitations (docs/IMMERSIVE_INVITATIONS.md) ---------------------------------------------------------------------
-- The controller (mod/immersive-invitations.lua) exists only while Settings > Immersive invitations is On, and the tick below is one table
-- read per 0.1 s while it is Off. Globals and one do-block: the main chunk is near Lua's limit of locals.
convaiImmersiveService = nil
convaiMeetGreetingWaiting, convaiMeetGreetingCurrent = nil, nil
do
    local function held()
        local sample = battleSample
        if type(sample) ~= 'table' then return nil end
        if sample.combat then return 'combat' end
        -- IsEntityInScene stays true in ordinary tier-one gameplay (mod/battle-observer.lua): the scene tier, a dialogue or a choice is a scene.
        if (sample.tier ~= nil and sample.tier ~= 1) or sample.dialogue or sample.choices then return 'scene' end
        if sample.call or (convaiHolocall and convaiHolocall.call) then return 'call' end
        return nil
    end
    local function notify(kind, text)
        local player = convaiPlayer()
        if not player or type(text) ~= 'string' or text == '' then return end
        if kind == 'text' then convaiNotices.send(player, 'immersive-text', text)
        elseif kind == 'on-the-way' then convaiNotices.send(player, 'immersive-on-the-way', text) end
    end
    local path = 'runtime/immersive-invitations.json'
    local persist = {
        load = function()
            local file = io.open(path, 'rb')
            if not file then return nil end
            local raw = file:read('*a'); file:close()
            local ok, value = pcall(json.decode, raw)
            return ok and type(value) == 'table' and value or nil
        end,
        store = function(value)
            local ok, encoded = pcall(json.encode, value)
            if not ok then error(encoded) end
            local file = io.open(path, 'wb')
            if not file then error('The appointments file cannot be written.') end
            file:write(encoded); file:close()
        end}
    -- The glue module is loaded on the first tick with the setting On; with it Off nothing but the setting is ever read.
    -- One try per load: a glue that cannot be loaded or built is not read, compiled and run again on every 0.1 s tick.
    local failed = false
    local function service()
        if convaiImmersiveService then return convaiImmersiveService end
        if failed then return nil end
        local loaded, module = pcall(dofile, 'immersive-service.lua')
        local built, glue = false, module
        if loaded and type(module) == 'table' and type(module.new) == 'function' then
            built, glue = pcall(module.new, {
                manager = manager, queue = function() return managerUi.party and managerUi.party() end, companions = companions,
                phoneChat = phoneChat, load = dofile, notify = notify, log = log, logOnce = convaiLogOnce, held = held,
                districtOf = currentDistrict, greet = convaiMeetGreeting, persist = persist, wall = os.clock, random = math.random,
                nowMs = function() return os.time() * 1000 end,
                -- bridge/call-off.mjs: a plain call-off V said to a character who is here (read at most once a second, only while a meeting stands).
                readCallOff = function()
                    local file = io.open('runtime/call-off.json', 'rb')
                    if not file then return nil end
                    local raw = file:read('*a')
                    file:close()
                    local decoded, row = pcall(json.decode, raw)
                    return decoded and type(row) == 'table' and row or nil
                end})
        end
        if not built then
            failed = true
            convaiLogOnce('immersive-service', 'Immersive invitations are unavailable: ' .. tostring(glue))
            return nil
        end
        convaiImmersiveService = glue
        return glue
    end
    -- The controller for the manager's Invite button and the Contacts J key: nil while the setting is Off (the old instant path applies).
    function convaiImmersiveGet()
        local options = manager.immersive and manager.immersive()
        if not options or not options.enabled then return nil end
        local glue = service()
        return glue and glue.get() or nil
    end
    -- Every 0.1 s of play time, from the world-ready part of onUpdate.
    function convaiImmersiveTick(delta)
        local options = manager.immersive and manager.immersive()
        if (not options or not options.enabled) and not convaiImmersiveService then return end
        local glue = service()
        if glue then glue.tick(delta) end
        -- Switched Off: the controller was dropped by the tick above; the glue goes too, so nothing stays loaded.
        if not (manager.immersive and manager.immersive().enabled) then convaiMeetGreetingWaiting, convaiImmersiveService = nil, nil end
    end
    function convaiImmersiveReset(reason, preserve)
        convaiMeetGreetingWaiting, convaiMeetGreetingCurrent = nil, nil
        if convaiImmersiveService then convaiImmersiveService.reset(reason, preserve) end
    end
    function convaiAppointmentTurn(snapshot, profileKey)
        if not convaiImmersiveService then return snapshot end
        return convaiImmersiveService.appointmentTurn(snapshot, profileKey)
    end
    -- A holocall line: the meeting V could ask for on the call (nil while the setting is Off), and the bridge's answer to it, checked against that offer.
    function convaiMeetCallOffer(context)
        local options = manager.immersive and manager.immersive()
        if not options or not options.enabled then return nil end
        convaiImmersiveGet()
        return convaiImmersiveService and convaiImmersiveService.callOffer(context) or nil
    end
    function convaiMeetCallAccept(profileKey, kind, offer)
        if not convaiImmersiveService then return false, 'off' end
        return convaiImmersiveService.callAccept(profileKey, kind, offer)
    end
    -- The greeting when V reaches her: one automatic reaction turn by her, spoken like any reply. It waits for the channel to be free
    -- (at most 20 s) and falls back to a notice with a plain line when no reply could be played.
    function convaiMeetGreeting(info)
        convaiMeetGreetingWaiting = {info = info, at = os.time()}
    end
    local function greetingFallback(info)
        local player = convaiPlayer()
        if player then
            convaiNotices.send(player, 'immersive-greeting', ui.t('{name}: Good to see you. Let us go.', {name = tostring(info.name)}))
        end
    end
    function convaiMeetGreetingTick(player, now, worldReady, outputs, manual)
        local current = convaiMeetGreetingCurrent
        if automatic and automatic.reaction.kind == 'meet' then
            if automatic.playbackAt then convaiMeetGreetingCurrent = nil end
            local reason = not worldReady and 'world-not-ready' or manual and 'manual-priority' or not outputs.enabled and 'outputs-disabled'
                or (not automatic.playbackAt and now * 1000 > automatic.reaction.expiresAt) and 'expired'
            if reason then cancelAutomatic('meet-' .. reason)
            elseif not pending and not speech.requestId and not subtitles.ownsUtterance() then cancelAutomatic('completed')
            elseif not reactionLease(true) then cancelAutomatic('lease-write-failed') end
            return true
        end
        if current then
            -- Her greeting ended without being heard: the plain line instead.
            convaiMeetGreetingCurrent = nil
            greetingFallback(current)
        end
        local waiting = convaiMeetGreetingWaiting
        if not waiting or automatic then return false end
        if os.time() - waiting.at > 20 then
            convaiMeetGreetingWaiting = nil
            greetingFallback(waiting.info)
            return false
        end
        if not worldReady or manual or not outputs.enabled or pending ~= nil or speech.requestId ~= nil or subtitles.ownsUtterance() then return false end
        local info = waiting.info
        local npc = companions.actor(info.serial)
        local entity
        for _, row in ipairs(companions.list()) do if row.serial == info.serial then entity = row.entityID end end
        if not npc or not entity then return false end
        local available = battleObserver.canSpeak(npc, 'start')
        if not available then return false end
        generation = generation + 1
        local context = {generation = generation, entity = entity, name = info.name, bodyType = '', profileKey = info.profileKey, sentAt = now,
            text = 'You have just met V at the place you agreed on. Give a brief in-character greeting.',
            reaction = {kind = 'meet', event = 'greeting', place = info.place, waitedMinutes = info.waitedMinutes,
                expiresAt = math.floor((now + 20) * 1000)}}
        context.requestId = tostring(os.time()) .. '-' .. generation .. '-' .. context.entity
        automatic = context
        captureReactionGuard(worldReady, outputs, nil)
        convaiMeetGreetingWaiting = nil
        if reactionLease(true) and sendRequest(context) then
            speech.target = npc
            lastAutomatic = {at = now, requestId = context.requestId, kind = 'meet'}
            convaiMeetGreetingCurrent = info
            log('Automatic meet greeting: speaker=' .. tostring(info.profileKey))
        else
            cancelAutomatic('request-write-failed')
            greetingFallback(info)
        end
        return true
    end
end

-- ---- Housemates (docs/HOUSEMATES.md) -------------------------------------------------------------------------------------------------------
-- Characters V told "you can stay at my place" live in V's flats. Settings > Gameplay > Housemates (Off by default) switches it all: while it is
-- Off the tick below is one table read, nothing is offered or listed, and no housemate module is loaded. With it On the glue
-- (mod/housemate-service.lua) is loaded on the first world-ready tick; the controller, the game adapter, the chat scheduler and the spot data only
-- when somebody lives somewhere or a conversation offer asks. Nothing runs per frame. Globals and one do-block: the main chunk is near Lua's limit
-- of locals.
convaiHousemates = nil
convaiHouseWaiting, convaiHouseCurrent, convaiHouseResult, convaiHouseText, convaiHousePrepared = nil, nil, nil, nil, nil
do
    local districtHooked = false
    local lastWelcomeLine
    local function held()
        local sample = battleSample
        if type(sample) ~= 'table' then return nil end
        if sample.combat then return 'combat' end
        -- Tier 2 is staged gameplay (V still walks): it does not hold the flat, so the bodies are not hidden for it. The second value is written
        -- on the probe line of the hold, to read which flag held (tier, dialogue, choices) when a body vanished.
        if (tonumber(sample.tier) or 1) >= 3 or sample.dialogue or sample.choices then
            -- V sitting, sleeping or washing at home plays as a scene of tier 3 or 4: V's own interaction, not a quest scene.
            if not sample.dialogue and not sample.choices then
                local ok, inside = pcall(function() return Game.GetWorkspotSystem():IsActorInWorkspot(convaiPlayer()) == true end)
                if ok and inside then return nil end
            end
            return 'scene', 'tier=' .. tostring(sample.tier) .. ',dialogue=' .. tostring(sample.dialogue == true) .. ',choices=' .. tostring(sample.choices == true)
        end
        if sample.call or (convaiHolocall and convaiHolocall.call) then return 'call' end
        return nil
    end
    local function mayChat()
        if held() then return false end
        if active ~= nil or groupChat.round ~= nil or phoneChat.pending ~= nil or pending ~= nil or automatic ~= nil then return false end
        if speech.requestId ~= nil or subtitles.ownsUtterance() then return false end
        if microphone.context ~= nil and microphone.state ~= 'reply' then return false end
        if type(battleSample) == 'table' and (battleSample.vehicle or battleSample.combat) then return false end
        return true
    end
    local function notify(text)
        local player = convaiPlayer()
        if player and type(text) == 'string' and text ~= '' then convaiNotices.send(player, 'housemate-notice', text) end
    end
    -- Settings > Gameplay > Housemates: one table read.
    local function on()
        local options = manager.housemates and manager.housemates()
        return options ~= nil and options.enabled == true
    end
    companions.housematesOn = on
    local function gameHours()
        local system = Game.GetTimeSystem()
        local stamp = system and system:GetGameTime()
        if stamp == nil then return nil end
        local ok, value = pcall(function()
            return GameTime.Days(stamp) * 24 + GameTime.Hours(stamp) + GameTime.Minutes(stamp) / 60
        end)
        if ok and type(value) == 'number' then return value end
        local okSeconds, seconds = pcall(function() return stamp.seconds end)
        if okSeconds and tonumber(seconds) then return tonumber(seconds) / 3600 end
        return nil
    end
    local learnedPath = 'runtime/housemate-learned.json'
    local persist = {
        load = function()
            local file = io.open(learnedPath, 'rb')
            if not file then return nil end
            local raw = file:read('*a'); file:close()
            local ok, value = pcall(json.decode, raw)
            return ok and type(value) == 'table' and value or nil
        end,
        store = function(value)
            local ok, encoded = pcall(json.encode, value)
            if not ok then return end
            local file = io.open(learnedPath, 'wb')
            if file then file:write(encoded); file:close() end
        end}
    local function eligible(key)
        if type(key) ~= 'string' or not companions.definition(key) then return false end
        for _, profile in ipairs(profiles) do
            if profile.key == key then return profile.invite ~= false end
        end
        return true
    end
    local function knownKeys()
        local list, seen = {}, {}
        for _, profile in ipairs(profiles) do
            if type(profile.key) == 'string' and not seen[profile.key] then seen[profile.key] = true; list[#list + 1] = profile.key end
        end
        for key in pairs(supportedProfiles) do
            if type(key) == 'string' and not seen[key] and key ~= 'resident-male' and key ~= 'resident-female' and not key:match('^npc%-') then
                seen[key] = true; list[#list + 1] = key
            end
        end
        return list
    end
    local function build()
        local loaded, module = pcall(dofile, 'housemate-service.lua')
        if not loaded or type(module) ~= 'table' then
            convaiLogOnce('housemate-service', 'Housemates are unavailable: ' .. tostring(module))
            return nil
        end
        local built, value = pcall(module.new, {
            load = dofile, companions = companions,
            queue = function() return managerUi.party and managerUi.party() end,
            catalog = function() return convaiGestures and convaiGestures.catalog or nil end,
            seating = function() return convaiSeating end,
            fact = function(name)
                local quests = Game.GetQuestsSystem()
                return quests and tonumber(quests:GetFactStr(name)) or 0
            end,
            place = function()
                local district = currentDistrict()
                return district and (district.area or district.district) or nil
            end,
            hours = gameHours, held = held,
            vpos = function()
                local player = convaiPlayer()
                local at = player and player:GetWorldPosition()
                return at and {x = at.x, y = at.y, z = at.z} or nil
            end,
            knownKeys = knownKeys, eligible = eligible,
            profileName = function(key)
                local definition = companions.definition(key)
                return definition and (definition.profileName or definition.name) or nil
            end,
            notify = notify, t = function(text, vars) return ui.t(text, vars) end, log = log,
            devLog = function(kind, fields)
                if manager.developerMode() then
                    local ok, text = pcall(json.encode, fields)
                    log('Housemates ' .. kind .. ' ' .. (ok and text or ''))
                end
            end,
            -- speech.target is never cleared: it is V's talk only while a conversation is in flight, and never a housemate's own chat line or
            -- greeting (that would keep its speaker "engaged", out of the settled people, and the chat would stop after its first line).
            talking = function()
                local npc = speech.target
                if not npc then return nil end
                if automatic and automatic.reaction and automatic.reaction.kind == 'house' then return nil end
                if not (active or pending or speech.requestId or subtitles.ownsUtterance()) then return nil end
                local ok, id = pcall(function() return tostring(npc:GetEntityID().hash) end)
                return ok and id or nil
            end,
            random = math.random,
            speak = convaiHouseSpeak, speakStatus = convaiHouseSpeakStatus, speakCancel = convaiHouseSpeakCancel,
            speakPrepare = convaiHouseSpeakPrepare, speakUnprepare = convaiHouseSpeakUnprepare,
            greet = convaiHouseGreeting,
            level = function() return manager.companionSpeakUp and manager.companionSpeakUp() or 'rare' end,
            -- "Housemates talk to each other" (Settings > Housemates): the pair chat is loaded only while it is On.
            chatOn = function()
                local options = manager.housemates and manager.housemates()
                return options == nil or options.chat ~= false
            end,
            mayChat = mayChat,
            -- Settings > Housemates > Move-in apartment: 'ask' or an apartment id (used only when V owns it).
            moveIn = function() local options = manager.housemates and manager.housemates(); return options and options.moveIn or 'ask' end,
            -- Settings > Housemates: the pause after a chat (seconds) and how many housemates join one chat.
            chatCooldown = function() local options = manager.housemates and manager.housemates(); return options and options.chatCooldown or 120 end,
            chatSize = function() local options = manager.housemates and manager.housemates(); return options and options.chatSize or 2 end,
            -- The shared arbiter of unprompted lines (Johnny, companions speaking up) when that feature is installed; nil: only the cooldown.
            -- Plain global reads: CET gives this mod an environment without _G (rawget(_G, ...) throws there).
            limiter = convaiProactive,
            outfits = function() return convaiOutfitApi end,
            leave = function(serial, entity, key, name)
                local departure = convaiCompanionAdoption
                if not departure then return false end
                local offer = {available = true, actor = {id = entity, key = key}, members = {{serial = serial, id = entity, key = key, name = name}}}
                return departure.queueLeave(entity, offer, entity, nil, nil)
            end,
            persist = persist,
            -- Party companions settled in a flat (mod/companion-settle.lua) hold places the housemates leave alone.
            reserved = function(apt) return convaiSettleTaken and convaiSettleTaken(apt) or nil end,
            hookDistrict = function()
                if districtHooked then return end
                districtHooked = true
                -- The game pushes a district when V crosses a district volume (a door of the flat): the one event that wakes the idle controller.
                local ok, err = pcall(function()
                    ObserveAfter('PreventionSystem', 'OnDistrictAreaEntered', function() convaiHousemateWake() end)
                end)
                if not ok then log('Housemates: the district hook could not be installed: ' .. tostring(err)) end
            end,
            storeMode = function() return nil end})
        if not built then
            convaiLogOnce('housemate-build', 'Housemates are unavailable: ' .. tostring(value))
            return nil
        end
        convaiHousemates = value
        return value
    end
    -- One build per load: a failed one is not retried every 0.1 s (that would load and compile the module again on every tick).
    local function service()
        if not on() then return nil end
        if convaiHousemates then return convaiHousemates end
        if convaiHousematesFailed then return nil end
        local ok, glue = pcall(build)
        if ok and glue then return glue end
        convaiHousematesFailed = true
        if not ok then convaiLogOnce('housemate-build', 'Housemates are unavailable: ' .. tostring(glue)) end
        return nil
    end
    -- The district hook cannot be removed once installed: while the setting is Off its callback does nothing.
    function convaiHousemateWake()
        local glue = convaiHousemates
        if glue and glue.controller and on() then glue.controller.wake() end
    end
    -- Switched Off: her line is dropped, the controller goes (the bodies are removed quietly, the seats let go) and so does the glue, so nothing stays
    -- loaded. The saved flats stay where they are: switching On again builds the service on the next tick and the housemates come back.
    local function switchOff()
        local glue = convaiHousemates
        convaiHousemates, convaiHousematesFailed = nil, nil
        if convaiHouseWaiting or convaiHouseCurrent then pcall(convaiHouseSpeakCancel) end
        pcall(convaiHouseSpeakUnprepare)
        convaiHouseWaiting, convaiHouseCurrent, convaiHouseResult, convaiHouseText = nil, nil, nil, nil
        if glue then pcall(glue.disable) end
    end
    -- Every 0.1 s of play time, from the world-ready part of onUpdate. Off: one table read.
    function convaiHousemateTick(delta)
        if not on() then
            if convaiHousemates or convaiHousematesFailed then switchOff() end
            return
        end
        local glue = convaiHousemates or service()
        if glue then glue.tick(delta) end
    end
    function convaiHousemateReset(reason, preserve)
        pcall(convaiHouseSpeakUnprepare)
        convaiHouseWaiting, convaiHouseCurrent, convaiHouseResult, convaiHouseText = nil, nil, nil, nil
        if convaiHousemates then convaiHousemates.reset(reason, preserve) end
    end
    -- Offers for a conversation turn (mod/gameplay-actions.lua): in person, and the first speaker of a group round.
    function convaiHousemateOffer(entity, context)
        local glue = service()
        return glue and glue.homeOffer(entity, context) or nil
    end
    function convaiHousemateGroupOffer(entity, context)
        local glue = service()
        return glue and glue.groupHomeOffer(entity, context) or nil
    end
    function convaiHousemateQueue(home, offer, entity, requestId, groupId)
        local glue = service()
        if not glue then log('Housemates failed:no-service'); return false, 'That action is not available.' end
        return glue.queueHome(home, offer, entity, requestId, groupId)
    end
    function convaiHousemateLeaveOffer(offer)
        if not convaiHousemates or not on() then return offer end
        return convaiHousemates.decorateLeave(offer)
    end
    function convaiHousemateQueueLeave(target, offer, entity, requestId, groupId, adoptionQueue)
        if not convaiHousemates or not on() then return adoptionQueue(target, offer, entity, requestId, groupId) end
        return convaiHousemates.queueLeave(target, offer, entity, requestId, groupId, adoptionQueue)
    end
    function convaiHousemateTurn(snapshot, profileKey)
        if not convaiHousemates or not on() then return snapshot end
        return convaiHousemates.turn(snapshot, profileKey)
    end
    function convaiHousemateTalk(entity)
        -- A chat line that is only waiting for the channel gives way to V's talk at once, and so does the one written ahead behind the line in the air.
        if convaiHouseWaiting then convaiHouseSpeakCancel() end
        pcall(convaiHouseSpeakUnprepare)
        if convaiHousemates and on() then convaiHousemates.talkStarted(entity) end
    end
    function convaiHousemateLearn(anchor, forward, kind)
        if convaiHousemates and on() then convaiHousemates.learnV(anchor, forward, kind) end
    end
    -- The manager's page: the housemates and a Move out for each.
    function convaiHousemateRows()
        if not convaiHousemates or not on() then return {} end
        return convaiHousemates.rows()
    end
    -- Settings > Housemates: the apartments V owns (the Move-in list) and Evict all housemates. Empty / 0 while Housemates is Off.
    function convaiHousemateOwned()
        if not convaiHousemates or not on() then return {} end
        return convaiHousemates.ownedApartments()
    end
    function convaiHousemateEvictAll()
        if not convaiHousemates or not on() then return 0 end
        return convaiHousemates.evictAll()
    end
    function convaiHousemateMoveOut(key)
        return convaiHousemates ~= nil and on() and convaiHousemates.moveOut(key) == true
    end
    -- Is this body one of the housemates' own? (A talk with her keeps her workspot: eyes and head only.)
    function convaiResidentNpc(npc)
        if not on() then return false end
        local ok, id = pcall(function() return tostring(npc:GetEntityID().hash) end)
        if not ok then return false end
        for _, row in ipairs(companions.visitors()) do
            if row.owner == 'housemates' and row.entityID == id then return true end
        end
        return false
    end
    -- The phone: a contact who may live at V's place (mod/phone-chat.lua captureHomeOffer / onHomeAction).
    phoneChat.captureHomeOffer = function(contact, profileKey)
        local glue = service()
        local key = companions.phoneContactKey(contact)
        return glue and key and glue.phoneOffer(key, profileKey) or nil
    end
    phoneChat.onHomeAction = function(profileKey, action)
        if convaiHousemates and on() then convaiHousemates.phoneAction(profileKey, action) end
    end

    -- The spoken lines (a chat line, a greeting): one automatic reaction of kind 'house' at a time, spoken like any reply. It waits for the
    -- channel to be free (at most 45 s) and gives way to anything V does.
    local function finish(status, text)
        -- A line written ahead that never went out: the bridge drops the held one.
        if convaiHouseWaiting and convaiHouseWaiting.context then pcall(convaiSpeakUpPublish, nil) end
        convaiHouseWaiting, convaiHouseCurrent = nil, nil
        convaiHouseResult = {status = status, text = text}
    end
    -- The context of a chat line as the bridge is given it. A line written ahead is this very table, made while the line before it was in the air.
    local function houseChatContext(request, now, seconds)
        generation = generation + 1
        local reaction = {kind = 'house', event = 'chat', partner = request.partner.name, partnerKey = request.partner.key, others = request.others or {},
            place = convaiHousePlaceName(), n = request.n, of = request.of, topic = request.topic, lines = request.lines or {},
            expiresAt = math.floor((now + seconds) * 1000)}
        local context = {generation = generation, entity = request.speaker.entity, name = request.speaker.name, bodyType = '',
            profileKey = request.speaker.key, sentAt = now, reaction = reaction,
            text = 'You are talking with ' .. tostring(request.partner.name) .. ' at V\'s place. Say your next line.'}
        context.requestId = tostring(os.time()) .. '-' .. generation .. '-' .. context.entity
        return context
    end
    function convaiHouseSpeak(request)
        if convaiHouseWaiting or convaiHouseCurrent or type(request) ~= 'table' then return false end
        local waiting = {request = request, at = os.time()}
        -- Written ahead (convaiHouseSpeakPrepare) and still the line that was meant: it goes out as it is, after the beat the chat asked for.
        local held = convaiHousePrepared
        if held then
            convaiHousePrepared = nil
            if request.prepared == true and held.request.speaker.key == request.speaker.key and held.request.n == request.n then
                waiting.context = held.context
                waiting.notBefore = os.clock() + (tonumber(request.gap) or 0.3)
            else
                pcall(convaiSpeakUpPublish, nil)
            end
        end
        convaiHouseWaiting = waiting
        convaiHouseText = nil
        convaiHouseResult = {status = 'waiting'}
        return true
    end
    -- 'waiting' (queued, nothing sent), 'busy' (sent, being written or said; the text once it is known), 'done', 'failed' or 'cancelled'.
    function convaiHouseSpeakStatus()
        local result = convaiHouseResult
        if not result then return nil end
        if result.status == 'busy' then return 'busy', convaiHouseText end
        return result.status, result.text
    end
    -- The next line of a chat is written while the one in the air is still being said (docs/HOUSEMATES.md, "Pair chat"): its request is published for the
    -- bridge to run now and hold back (runtime/group-prefetch.json, kind 'ahead', the same hold-and-claim as a companion's after-scene line), and sent as
    -- it is when the line has been heard. A bridge or plan that cannot run two lines at once simply takes it as an ordinary request at that moment.
    function convaiHouseSpeakPrepare(request)
        if convaiHousePrepared or type(request) ~= 'table' or not convaiHouseCurrent or convaiHouseCurrent.kind == 'welcome' then return false end
        if not (automatic and automatic.reaction.kind == 'house') then return false end
        local now = os.time()
        local context = houseChatContext(request, now, 90)
        context.journal = questContext.capture()
        if not convaiSpeakUpPublish({kind = 'ahead', input = context}) then return false end
        convaiHousePrepared = {request = request, context = context}
        return true
    end
    -- Withdrawn: the chat stopped, V talks, or the line it was written for did not turn out as expected (the bridge drops the held line).
    function convaiHouseSpeakUnprepare()
        if not convaiHousePrepared then return end
        convaiHousePrepared = nil
        pcall(convaiSpeakUpPublish, nil)
    end
    function convaiHouseSpeakCancel()
        if automatic and automatic.reaction.kind == 'house' then cancelAutomatic('house-cancelled') end
        finish('cancelled')
    end
    function convaiHouseGreeting(info)
        if type(info) ~= 'table' then return false end
        return convaiHouseSpeak({kind = 'welcome', speaker = {key = info.key, name = info.name, serial = info.serial, entity = info.entity},
            place = info.place, awayHours = info.awayHours, others = info.others})
    end
    -- One unprompted speaker at a time (docs/COMPANION_SPEAK_UP.md): a housemate line or chat (also between two lines of it) and an arrival greeting
    -- that is waiting for the channel or being said count as the floor being held, for the speak-up arbiter. Global reads and one call, only asked
    -- while a speak-up list is on.
    function convaiUnpromptedBusy()
        if convaiPartyState and convaiPartyState.chat then return true end
        if convaiHouseWaiting or convaiHouseCurrent or convaiMeetGreetingWaiting or convaiMeetGreetingCurrent then return true end
        local glue = convaiHousemates
        local controller = glue and glue.controller
        return controller ~= nil and controller.chatActive ~= nil and controller.chatActive() == true
    end
    function convaiHouseReplyText(replyPending, text)
        if replyPending and replyPending.reaction and replyPending.reaction.kind == 'house' then convaiHouseText = text end
    end
    local function placeName()
        local glue = convaiHousemates
        local controller = glue and glue.controller
        return controller and controller.placeName and controller.placeName() or ''
    end
    convaiHousePlaceName = placeName
    function convaiHouseTick(player, now, worldReady, outputs, manual)
        if automatic and automatic.reaction.kind == 'house' then
            if automatic.playbackAt then convaiHouseWaiting = nil end
            local reason = not worldReady and 'world-not-ready' or manual and 'manual-priority' or not outputs.enabled and 'outputs-disabled'
                or (not automatic.playbackAt and now * 1000 > automatic.reaction.expiresAt) and 'expired'
            local shown = automatic.shown == true
            if reason then
                cancelAutomatic('house-' .. reason)
                finish(reason == 'manual-priority' and 'cancelled' or 'failed')
            elseif not pending and not speech.requestId and not subtitles.ownsUtterance() then
                cancelAutomatic('completed')
                finish(shown and 'done' or 'failed', convaiHouseText)
                -- The chat reads the end of the line now, not at its next step, and asks for the next one at once.
                local controller = convaiHousemates and convaiHousemates.controller
                if controller and controller.chatPoke then pcall(controller.chatPoke) end
            elseif not reactionLease(true) then
                cancelAutomatic('lease-write-failed')
                finish('failed')
            end
            return true
        end
        if convaiHouseCurrent then
            -- Her line ended without being heard.
            finish('failed')
        end
        local waiting = convaiHouseWaiting
        if not waiting or automatic then return false end
        if os.time() - waiting.at > 45 then finish('failed'); return false end
        if not worldReady or manual or not outputs.enabled or pending ~= nil or speech.requestId ~= nil or subtitles.ownsUtterance() then return false end
        -- A line written ahead waits out its short beat after the one before it (a fraction of a second, counted on the 0.1 s tick).
        if waiting.notBefore and os.clock() < waiting.notBefore then return false end
        local request = waiting.request
        local npc = companions.residentNpc(request.speaker.serial)
        if not npc then finish('failed'); return false end
        local available = battleObserver.canSpeak(npc, 'start')
        if not available then return false end
        local context, reaction = waiting.context, nil
        if context then
            reaction = context.reaction
        elseif request.kind == 'welcome' then
            generation = generation + 1
            reaction = {kind = 'house', event = 'welcome', place = request.place or placeName(), awayHours = request.awayHours or 0,
                others = request.others or {}, expiresAt = math.floor((now + 25) * 1000)}
            context = {generation = generation, entity = request.speaker.entity, name = request.speaker.name, bodyType = '',
                profileKey = request.speaker.key, sentAt = now, reaction = reaction,
                text = 'V has just come home. Give a brief in-character greeting.'}
            context.requestId = tostring(os.time()) .. '-' .. generation .. '-' .. context.entity
        else
            context = houseChatContext(request, now, 30)
            reaction = context.reaction
        end
        automatic = context
        captureReactionGuard(worldReady, outputs, nil)
        convaiHouseWaiting = nil
        if reactionLease(true) and sendRequest(context) then
            speech.target = npc
            lastAutomatic = {at = now, requestId = context.requestId, kind = 'house'}
            convaiHouseCurrent = request
            convaiHouseResult = {status = 'busy'}
            log('Automatic house line: speaker=' .. tostring(request.speaker.key) .. ' event=' .. reaction.event .. (waiting.context and ' (written ahead)' or ''))
        else
            cancelAutomatic('request-write-failed')
            finish('failed')
        end
        return true
    end
end

-- ---- Revenge ambushes (docs/AMBUSHES.md) --------------------------------------------------------------------------------------------------
-- A gang V keeps killing may send a small squad, rarely (mod/revenge-ambush.lua decides; mod/revenge-ambush-world.lua holds the native calls). Built on first use
-- and not at all while Settings > Gameplay > Revenge ambushes is off: the tick below is one boolean then. The grudge is fed by the Street reputation recorder's
-- deeds (convaiReputationWanted). Globals and one block, so the main chunk gains no local.
convaiAmbush, convaiAmbushFailed, convaiAmbushSpeaker = nil, nil, nil
function convaiAmbushModule()
    if convaiAmbush then return convaiAmbush end
    if convaiAmbushFailed then return nil end
    local loaded, module = pcall(dofile, 'revenge-ambush.lua')
    local worldLoaded, worldModule = pcall(dofile, 'revenge-ambush-world.lua')
    if not loaded or type(module) ~= 'table' or not worldLoaded or type(worldModule) ~= 'table' then
        convaiAmbushFailed = true
        convaiLogOnce('ambush-load', 'Revenge ambushes are unavailable: ' .. tostring(loaded and worldModule or module))
        return nil
    end
    local world = worldModule.new({companions = companions, groups = module.GROUPS, log = log})
    -- A fighter a session before this one left (a CET reload keeps the game running) is removed once.
    local swept = world.sweep()
    if swept > 0 then log('Revenge ambushes: removed ' .. swept .. ' fighter(s) left by an earlier session') end
    convaiAmbush = module.new({
        enabled = function() return manager.revengeAmbushes() end,
        gameTime = worldKnowledgeModule.nativeGameTime,
        -- Ordinary play only: no fight, scene, call, vehicle, interior, safe zone or wanted level (the battle observer's read, once per look).
        world = function()
            return world.world(battleObserver.sample(convaiPlayer()), function()
                local system = Game.GetScriptableSystemsContainer():Get('PreventionSystem')
                if system == nil then error('no prevention system') end
                local okHeat, value = pcall(function() return system:GetHeatStageAsInt() end)
                if not okHeat or tonumber(value) == nil then value = EnumInt(system:GetHeatStage()) end
                return value
            end)
        end,
        recordOf = world.recordOf, verify = world.verify, findSpot = world.findSpot, create = world.create, entity = world.entity,
        alive = world.alive, playerNear = world.playerNear, arm = world.arm, hidden = world.hidden, delete = world.delete,
        bark = function(npc, info) return convaiAmbushBark(npc, info) end,
        log = log,
    })
    return convaiAmbush
end
function convaiAmbushTick(player, elapsed, ready)
    if type(manager.revengeAmbushes) ~= 'function' or not manager.revengeAmbushes() then
        if convaiAmbush then convaiAmbush.tick(elapsed, ready) end   -- turned off: the squad that stands is removed, once
        return
    end
    local module = convaiAmbushModule()
    if module then module.tick(elapsed, ready) end
end
-- The request of the taunt: a private automatic turn of an ordinary NPC of the gang (its archetype profile and voice, bridge/ambush-context.mjs). Nil when the
-- profile or the person cannot be told (the squad then fights without a line).
function convaiAmbushContext(npc, info)
    local entity = tostring(npc:GetEntityID().hash)
    local body = tostring(npc:GetBodyType() or '')
    local facts = archetypeFacts(npc, entity, body)
    local female = characterCatalog.gender(facts) == 'FEMALE'
    local key = 'npc-' .. tostring(info.group) .. (female and '-female' or '-male')
    if not archetypes.keys[key] then return nil end
    local archetype = characterCatalog.describe(archetypes, key, facts)
    if not archetype or archetype.base ~= info.group then return nil end
    local place = (manager.dynamicInfo == nil or manager.dynamicInfo('location')) and currentDistrict() or nil
    if place then archetype.district, archetype.area = place.district, place.area end
    local name = type(characterCatalog.archetypeLabel) == 'function' and characterCatalog.archetypeLabel(archetypes, key) or archetype.title or key
    local generated = convaiNpcNames and convaiNpcNames.nameFor(npc, 'talk') or nil
    if generated then name, archetype.npcName = generated, generated end
    generation = generation + 1
    local now = os.time()
    local context = {generation = generation, entity = entity, name = name, bodyType = body, profileKey = key, sentAt = now, archetype = archetype,
        text = 'You are one of a squad sent after V. Give one brief threat.',
        reaction = {kind = 'ambush', event = 'taunt', group = info.group, count = info.count, toll = info.toll, expiresAt = math.floor((now + 20) * 1000)}}
    context.requestId = tostring(now) .. '-' .. generation .. '-' .. entity
    return context
end
-- The line, when the channel is free (the module asks again for twenty seconds): nothing else is being said or written, V is not talking, and the player has
-- not asked for ordinary people to stay silent (Settings > Conversations > Talk to ordinary NPCs).
function convaiAmbushBark(npc, info)
    if automatic ~= nil or pending ~= nil or speech.requestId ~= nil or subtitles.ownsUtterance() then return false end
    if active ~= nil or groupChat.round ~= nil or phoneChat.pending ~= nil or (microphone.context ~= nil and microphone.state ~= 'reply') then return false end
    if type(manager.archetypeConversations) == 'function' and not manager.archetypeConversations() then return false end
    local player = convaiPlayer()
    if not player then return false end
    local outputs = battleOutputs or reactionOutputs(player)
    if not outputs.enabled then return false end
    local built, context = pcall(convaiAmbushContext, npc, info)
    if not built or type(context) ~= 'table' then
        if not built then convaiLogOnce('ambush-context', 'Ambush taunt could not be built: ' .. tostring(context)) end
        return false
    end
    automatic = context
    captureReactionGuard(true, outputs, nil)
    if reactionLease(true) and sendRequest(context) then
        speech.target = npc
        convaiAmbushSpeaker = {requestId = context.requestId, npc = npc}
        lastAutomatic = {at = os.time(), requestId = context.requestId, kind = 'ambush'}
        log('Automatic ambush taunt: speaker=' .. tostring(context.profileKey) .. ' group=' .. tostring(info.group) .. ' count=' .. tostring(info.count))
        return true
    end
    cancelAutomatic('request-write-failed')
    return false
end
function convaiAmbushSpeakerHere(requestId)
    local speaker = convaiAmbushSpeaker
    if not speaker or speaker.requestId ~= requestId or speaker.npc == nil then return false end
    local ok, here = pcall(function() return speaker.npc:IsAttached() and not speaker.npc:IsDeadNoStatPool() end)
    return ok and here == true
end
-- Each tick of the half second while the taunt is in the air: it ends when it was said, when V or the world needs the channel, when it is late, or when
-- its speaker is gone.
function convaiAmbushBarkTick(player, now, worldReady, outputs, manual)
    local reaction = automatic.reaction
    local reason = not worldReady and 'world-not-ready' or manual and 'manual-priority' or not outputs.enabled and 'outputs-disabled'
        or (not automatic.playbackAt and now * 1000 > reaction.expiresAt) and 'expired'
        or not convaiAmbushSpeakerHere(automatic.requestId) and 'speaker-gone'
    if reason then
        cancelAutomatic('ambush-' .. reason)
    elseif not pending and not speech.requestId and not subtitles.ownsUtterance() then
        cancelAutomatic('completed')
    elseif not reactionLease(true) then
        cancelAutomatic('lease-write-failed')
    end
end

-- ---- Companions settle in V's flat (docs/COMPANION_SETTLE.md) -------------------------------------------------------------------------------
-- While V stays in one of V's own apartments the party takes seats and standing places of the flat instead of trailing V. Nothing of it exists
-- away from home: mod/companion-settle.lua is built when the game pushes a district change into one of the five flats (the hook in onInit) and is
-- dropped on the next change out. It is driven by the companions' own body animation tick, so there is no timer of its own. No setting: away from
-- home it is one global that is nil. Globals and one do-block (the main chunk is near Lua's limit of locals).
convaiSettle = nil
do
    local FLATS = {LittleChina_VApartment = 'h10', CorpoPlaza_Apartment = 'corpo', Glen_Apartment = 'glen',
        JapanTown_Apartment = 'japan', Northside_Apartment = 'north'}
    local failed = false
    local function flatNow()
        local where = currentDistrict()
        local place = where and (where.area or where.district) or nil
        return place and FLATS[place] or nil
    end
    -- V cannot settle now: a fight, a vehicle, or a scene or call that is not V's own sitting, sleeping or washing at home.
    local function busy()
        local sample = battleSample
        if type(sample) ~= 'table' then return nil end
        if sample.combat then return 'combat' end
        if sample.vehicle then return 'car' end
        if (sample.tier ~= nil and sample.tier ~= 1) or sample.dialogue or sample.choices then
            if not sample.dialogue and not sample.choices then
                local ok, inside = pcall(function() return Game.GetWorkspotSystem():IsActorInWorkspot(convaiPlayer()) == true end)
                if ok and inside then return nil end
            end
            return 'scene'
        end
        return nil
    end
    local function build()
        if failed or not convaiSeating or not convaiSeating.setHome then return nil end
        local loaded, module = pcall(dofile, 'companion-settle.lua')
        if not loaded or type(module) ~= 'table' then
            failed = true
            convaiLogOnce('settle-load', 'Settling in the flat is unavailable: ' .. tostring(module))
            return nil
        end
        local built, value = pcall(module.new, {
            load = dofile,
            seating = function() return convaiSeating end,
            vpos = function()
                local player = convaiPlayer()
                local at = player and player:GetWorldPosition()
                return at and {x = at.x, y = at.y, z = at.z} or nil
            end,
            held = busy,
            district = flatNow,
            -- The housemates' places (only while that feature is On and has someone in this flat).
            others = function(apt)
                local glue = convaiHousemates
                local controller = glue and glue.controller
                return controller and controller.takenSpots and controller.takenSpots(apt) or nil
            end,
            member = function(entity) return companions.partyMember(entity) end,
            log = function(kind, fields)
                if manager.developerMode() then
                    local ok, text = pcall(json.encode, fields)
                    log('Settle ' .. kind .. ' ' .. (ok and text or ''))
                end
            end})
        if not built then
            failed = true
            convaiLogOnce('settle-build', 'Settling in the flat is unavailable: ' .. tostring(value))
            return nil
        end
        return value
    end
    -- The game pushed a district change (or the party's first tick of a world, or V sat down at home): is V in one of the flats now?
    function convaiSettleWake()
        local ok, flat = pcall(flatNow)
        flat = ok and flat or nil
        if flat then
            if not convaiSettle then convaiSettle = build() end
            if convaiSettle then convaiSettle.enter(flat) end
        elseif convaiSettle then
            local settle = convaiSettle
            convaiSettle = nil
            pcall(settle.leave, 'left the flat')
        end
    end
    -- V sat on a seat (once per sit): it is never given away, and a missed district event is made up for.
    function convaiSettleSat(anchor)
        if not convaiSettle then convaiSettleWake() end
        if convaiSettle then convaiSettle.learnV(anchor) end
    end
    -- The world ended or V fast travelled: the seating controller has let go of its places already (no native calls here).
    function convaiSettleReset(reason, preserve)
        convaiSettle = nil
    end
    -- "Come with me" to a settled companion: the follow offer of the conversation actions, and its execution.
    function convaiSettleOffer(entity, context)
        return convaiSettle and convaiSettle.followOffer(entity, context) or nil
    end
    function convaiSettleFollow(entity)
        return convaiSettle ~= nil and convaiSettle.follow(entity) == true
    end
    -- The spots the settled party holds in a flat (the housemates leave them alone).
    function convaiSettleTaken(apt)
        return convaiSettle and convaiSettle.taken(apt) or nil
    end
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
    -- Starting one is the speak-up scheduler's job (convaiSpeakUpOffer below): it lets Johnny's queued remark and the companions compete.
    return false
end

-- Companions and Johnny speak up on their own (docs/COMPANION_SPEAK_UP.md). One scheduler (mod/speak-up.lua) paces both by target rates and
-- lets one unprompted speaker talk at a time; this block is the game side: who may speak (a party companion's calm moment, a companion after a
-- scene she was in, Johnny's queued remarks), the request each one sends, and Johnny's follow-on to a line that is playing, which is written and
-- voiced ahead (bridge/group-lookahead.mjs: runtime/group-prefetch.json) and submitted the moment that line has been heard. Everything runs on the
-- 0.1 s game tick inside updateBattles, on a game event (a recorded scene line, the end of a line of speech) or on demand; nothing per frame, and
-- nothing is loaded while both lists are Off. Globals, so updateBattles and the callbacks gain no upvalues.
convaiSpeakUpState = {plan = nil, hold = nil, scene = nil, lastManual = nil, lastManualAt = -1000, calmFor = 0, withFor = 0,
    decided = {}, decidedCount = 0, lastPerson = nil, people = {}, peopleAt = nil}
-- QUIET: seconds after V's last manual turn before a companion speaks up on her own. CALM: seconds of calm play (and of a companion being with V)
-- before a calm line. SCENE_*: a scene is over after SCENE_QUIET seconds without a line; her line is prepared from SCENE_PREP on. LINE_MAX: the
-- longest line Johnny follows up (the bridge compares it with the whole source text). SEND: seconds a line has to be heard once sent.
convaiSpeakUpConfig = {QUIET = 45, CALM = 20, SCENE_QUIET = 6, SCENE_PREP = 2.5, SCENE_TTL = 120, SCENE_MIN_LINES = 2, PLAN_TTL = 120,
    LINE_MAX = 500, SEND = 60, FOLLOW_SEND = 120}

function convaiSpeakUpService()
    -- A manager without these settings (an old or partial one) counts as Off.
    local askCompanion, askHead = manager.companionSpeakUp, manager.johnnyInHead
    local companion = askCompanion and askCompanion() or 'off'
    local johnny = askHead and askHead() and manager.johnnyRemarks() or 'off'
    if companion == 'off' and johnny == 'off' then
        -- Unload what is not used: the scheduler goes with the last list that was on.
        if convaiSpeakUp then convaiSpeakUpReset('off'); convaiSpeakUp = nil end
        return nil
    end
    if convaiSpeakUp == nil then
        local loaded, module = pcall(dofile, 'speak-up.lua')
        convaiSpeakUp = loaded and type(module) == 'table' and type(module.new) == 'function' and module.new({
            companionLevel = function() return manager.companionSpeakUp() end,
            johnnyLevel = function() if manager.johnnyInHead() then return manager.johnnyRemarks() end return 'off' end}) or false
        if not convaiSpeakUp then print('[CyberpunkConvai] speak-up.lua unavailable: ' .. tostring(module)) end
    end
    return convaiSpeakUp or nil
end

-- Withdraw whatever was prepared ahead (the bridge drops the held line) and give the floor back unheard.
function convaiSpeakUpWithdraw(reason)
    local st, sched = convaiSpeakUpState, convaiSpeakUp
    local plan = st.plan
    if not plan then return end
    st.plan = nil
    pcall(convaiSpeakUpPublish, nil)
    -- An 'ahead' plan holds the floor from the moment it was prepared; a follow-on takes it only when it is submitted.
    local hold = st.hold
    if plan.kind == 'ahead' and hold and hold.requestId == plan.context.requestId then
        st.hold = nil
        if sched then pcall(sched.release, sched, hold.who, false) end
    end
    if convaiLogLine then convaiLogLine('Speak up: prepared line withdrawn (' .. tostring(reason) .. ') kind=' .. tostring(plan.kind)) end
end

-- A world change, a save load or both lists turned Off: nothing is kept.
function convaiSpeakUpReset(reason)
    local st = convaiSpeakUpState
    if convaiPartyState and convaiPartyState.chat then convaiPartyAbort('reset-' .. tostring(reason)) end
    pcall(convaiSpeakUpWithdraw, reason)
    st.hold, st.scene, st.lastManual, st.calmFor, st.withFor, st.decided, st.decidedCount = nil, nil, nil, 0, 0, {}, 0
    if convaiSpeakUp then pcall(convaiSpeakUp.reset, convaiSpeakUp) end
end

-- The prediction file (the one the bridge's look-ahead reads): {kind = 'follow', sourceRequestId, input} or {kind = 'ahead', input}; nil writes {}.
function convaiSpeakUpPublish(command)
    local encoded = '{}'
    if command then
        if not attachKnowledge(command.input) then return false end
        local ok, text = pcall(json.encode, command)
        if not ok then return false end
        encoded = text
    end
    local file = io.open('runtime/group-prefetch.json', 'wb')
    if not file then return false end
    file:write(encoded); file:close()
    return true
end

-- The party companions that may speak up: our own copies (never a character another mod spawned, never Johnny), cached per battle sample.
function convaiSpeakUpPeople()
    local st = convaiSpeakUpState
    if st.peopleAt ~= battleSampleAt then
        st.peopleAt = battleSampleAt
        local list = {}
        for _, person in ipairs(battlePeople) do
            if not person.spawned and person.profileKey ~= 'johnny-silverhand' then list[#list + 1] = person end
        end
        st.people = list
    end
    return st.people
end

-- A calm moment: the game is ours (open gameplay), nothing is playing, V is not talking or typing and has not for a while.
function convaiSpeakUpEligible(now, worldReady, manual, outputs)
    if not worldReady or manual or not outputs.enabled then return false end
    local sample = battleSample
    if not sample or sample.available ~= true or sample.blocked or sample.combat then return false end
    if automatic ~= nil or pending ~= nil or speech.requestId ~= nil or subtitles.ownsUtterance() then return false end
    if convaiUnpromptedBusy and convaiUnpromptedBusy() then return false end
    if convaiHolocall ~= nil and convaiHolocall.call ~= nil then return false end
    if battles.fighting() then return false end
    if convaiPartyState.chat then return false end
    return now - convaiSpeakUpState.lastManualAt >= convaiSpeakUpConfig.QUIET
end

-- The scheduler's clock, once per tick: the eligible time only. Returns the scheduler, or nil while both lists are Off.
function convaiSpeakUpAdvance(now, elapsed, worldReady, manual, outputs)
    local sched = convaiSpeakUpService()
    if not sched then return nil end
    local st = convaiSpeakUpState
    local eligible = convaiSpeakUpEligible(now, worldReady, manual, outputs)
    local step = elapsed < 1 and elapsed or 1
    st.calmFor = eligible and st.calmFor + step or 0
    st.withFor = (eligible and #convaiSpeakUpPeople() > 0) and st.withFor + step or 0
    sched:tick(elapsed, eligible)
    return sched
end

-- A recorded game line (mod/game-dialogue.lua onRow): the scene a companion was in. Event-driven, a few table writes.
function convaiSpeakUpScene(row)
    if type(row) ~= 'table' or row.channel ~= 'scene' then return end
    if (manager.companionSpeakUp and manager.companionSpeakUp() or 'off') == 'off' or not manager.dynamicInfo('dialogue') then return end
    local st, at = convaiSpeakUpState, os.clock()
    local scene = st.scene
    if not scene or at - scene.lastAt > convaiSpeakUpConfig.SCENE_TTL then
        scene = {count = 0, present = {}, failed = false}
        st.scene = scene
    end
    scene.lastAt, scene.count = at, scene.count + 1
    for _, key in ipairs(type(row.present) == 'table' and row.present or {}) do
        if type(key) == 'string' then scene.present[key] = true end
    end
    if type(row.profileKey) == 'string' then scene.present[row.profileKey] = true end
end

-- Who of the party may speak now, and about what: a companion who was in a scene that has just ended (event 'scene', with how long it has been
-- quiet), else any companion at a calm moment (event 'calm'). nil when nobody may.
function convaiSpeakUpCompanion()
    if (manager.companionSpeakUp and manager.companionSpeakUp() or 'off') == 'off' then return nil end
    local st, cfg = convaiSpeakUpState, convaiSpeakUpConfig
    local people = convaiSpeakUpPeople()
    if #people == 0 then return nil end
    local scene = st.scene
    if scene then
        local quiet = os.clock() - scene.lastAt
        if quiet > cfg.SCENE_TTL then st.scene = nil
        elseif scene.count >= cfg.SCENE_MIN_LINES and not scene.failed and quiet >= cfg.SCENE_PREP then
            local pool = {}
            for _, person in ipairs(people) do
                if person.available == true and person.voiceBusy ~= true and scene.present[person.profileKey] then pool[#pool + 1] = person end
            end
            if #pool > 0 then return pool[math.random(#pool)], 'scene', quiet end
        end
    end
    if st.calmFor >= cfg.CALM and st.withFor >= cfg.CALM then
        local pool = {}
        for _, person in ipairs(people) do
            if person.available == true and person.voiceBusy ~= true and (#people == 1 or person.profileKey ~= st.lastPerson) then pool[#pool + 1] = person end
        end
        if #pool > 0 then return pool[math.random(#pool)], 'calm', 0 end
    end
    return nil
end

-- The request of a companion's speak-up: a reaction like a battle line, with the tracked quest, the right-now facts and (after a scene) the
-- scene's lines. The text is a placeholder; the bridge writes the trigger (bridge/speakup-context.mjs).
function convaiSpeakUpBuild(person, event, now)
    generation = generation + 1
    local context = {generation = generation, entity = person.entity, name = person.name, bodyType = person.bodyType,
        profileKey = person.profileKey, sentAt = now, text = 'A companion speaks up unprompted. Give one brief in-character line.',
        reaction = {kind = 'speakup', event = event, facts = {v = 1}, expiresAt = math.floor((now + convaiSpeakUpConfig.SEND) * 1000)}}
    context.requestId = tostring(os.time()) .. '-' .. generation .. '-' .. context.entity
    -- Captured here so a request prepared ahead is the very request that is sent later (the bridge compares them).
    context.journal = questContext.capture()
    if event == 'scene' and convaiGameDialogue then context.gameDialogue = convaiGameDialogue:capture() end
    if convaiTurnContext then context.turnContext = convaiTurnContext:capture() end
    return context
end

-- Send an unprompted request now: the floor is already claimed by `who`. person is nil for Johnny.
-- keepFloor: a line of a party round (convaiParty*): the round holds the floor, not the line.
function convaiSpeakUpSubmit(player, now, worldReady, outputs, context, person, who, label, keepFloor)
    local st, sched = convaiSpeakUpState, convaiSpeakUp
    automatic = context
    captureReactionGuard(worldReady, outputs, person)
    if reactionLease(true) and sendRequest(context) then
        speech.target = person and person.npc or player
        if not keepFloor then st.hold = {who = who, requestId = context.requestId} end
        lastAutomatic = {at = now, requestId = context.requestId, kind = context.reaction.kind == 'head' and 'head' or 'speakup'}
        log('Speak up: ' .. label)
        return true
    end
    cancelAutomatic('request-write-failed')
    if sched and not keepFloor then pcall(sched.release, sched, who, false) end
    return false
end

-- Johnny's own queued remark (a person, a job, a place...): the request of mod/johnny-remarks.lua, now paced by the scheduler.
function convaiSpeakUpStartJohnny(player, now, worldReady, outputs, entry, head)
    local partner = head:partner(player)
    if not partner then return false end
    generation = generation + 1
    local context = {generation = generation, entity = partner.entity, name = partner.name, bodyType = '',
        profileKey = partner.profileKey, voiceOnly = true, head = partner.head, sentAt = now,
        text = 'Johnny speaks up unprompted. Give one brief in-character remark.',
        reaction = {kind = 'head', event = entry.kind, facts = entry.facts,
            expiresAt = math.floor((now + convaiJohnnyRemarksModule.SEND_SECONDS) * 1000)}}
    context.requestId = tostring(os.time()) .. '-' .. generation .. '-' .. context.entity
    if not convaiSpeakUpSubmit(player, now, worldReady, outputs, context, nil, 'johnny', 'Johnny ' .. entry.subject .. ' stage=' .. tostring(partner.head.stage)) then
        return false
    end
    convaiJohnnyRemarks:claim(entry, now)
    convaiHeadTalk = {entity = partner.entity}
    return true
end

-- The unprompted turn of the tick: Johnny's queued remark and the companions' candidate compete; the scheduler says who (or nobody).
function convaiSpeakUpOffer(player, now, worldReady, outputs, manual, busy, mayFollow)
    local sched, st = convaiSpeakUp, convaiSpeakUpState
    if not sched or busy or st.plan then return end
    local entry, remarks = nil, convaiJohnnyRemarks
    if remarks and remarks:pending() then
        local head = convaiJohnnyHeadService()
        if head and not head:refusal(player) then entry = remarks:offer(now) end
    end
    -- Nobody is due: no candidate list is built and no table made on this tick (the companions' timer is due about twice an hour).
    if entry == nil and not sched:ready('companion') then return end
    local person, event, quiet
    if sched:ready('companion') then person, event, quiet = convaiSpeakUpCompanion() end
    local who = sched:pick({companion = person ~= nil, johnny = entry ~= nil})
    if who == 'johnny' then
        if not mayFollow(entry, 'head') or not sched:claim('johnny') then return end
        local head = convaiJohnnyHeadService()
        if not head or not convaiSpeakUpStartJohnny(player, now, worldReady, outputs, entry, head) then
            if sched:holder() == 'johnny' then sched:release('johnny', false) end
        end
    elseif who == 'companion' then
        if not mayFollow(true, 'speakup') or not sched:claim('companion') then return end
        st.lastPerson = person.profileKey
        -- Two or more party companions near: most of the time a short chat among up to three of them (convaiPartyStart); else her single line.
        if event == 'calm' and convaiPartyStart(person) then return end
        local context = convaiSpeakUpBuild(person, event, now)
        if event == 'scene' and quiet < convaiSpeakUpConfig.SCENE_QUIET then
            -- The scene's last line may still be playing: write and voice her line now, say it once the scene is over (or drop it).
            st.hold = {who = 'companion', requestId = context.requestId}
            if convaiSpeakUpPublish({kind = 'ahead', input = context}) then
                st.plan = {kind = 'ahead', context = context, person = person, createdAt = now, sceneStamp = st.scene.lastAt}
                log('Speak up: companion scene line prepared speaker=' .. person.profileKey)
            else
                st.hold = nil
                sched:release('companion', false)
                st.scene.failed = true
            end
            return
        end
        if event == 'scene' then st.scene = nil end
        convaiSpeakUpSubmit(player, now, worldReady, outputs, context, person, 'companion', 'companion ' .. event .. ' speaker=' .. person.profileKey)
    end
end

-- A companion's unprompted line that is on its way or playing: kept, or released when the game takes the floor back.
function convaiSpeakUpManage(player, now, worldReady, outputs, manual)
    local speaker
    for _, person in ipairs(battlePeople) do
        if person.entity == automatic.entity and person.profileKey == automatic.profileKey then speaker = person; break end
    end
    captureReactionGuard(worldReady, outputs, speaker)
    local waiting = reactionSpeakerWait(speaker)
    local sample = battleSample or {}
    local reason = not worldReady and 'world-not-ready' or manual and 'manual-priority' or not outputs.enabled and 'outputs-disabled'
        or not speaker and 'speaker-missing' or (not speaker.available and not waiting) and 'speaker-unavailable'
        or sample.combat and 'combat' or sample.blocked and 'scene-blocked'
        or (not automatic.playbackAt and now * 1000 > automatic.reaction.expiresAt) and 'expired'
    if reason then cancelAutomatic(reason)
    elseif not pending and not speech.requestId and not subtitles.ownsUtterance() then cancelAutomatic('completed')
    elseif not reactionLease(true) then cancelAutomatic('lease-write-failed') end
end

-- Johnny follows a line that is playing: decided and prepared once the line's whole text is known (his turn is written and voiced ahead and held),
-- submitted by convaiSpeakUpStopped when the line has been heard to its end.
function convaiSpeakUpPlanFollow(player, now)
    local sched, st = convaiSpeakUp, convaiSpeakUpState
    if not sched or st.plan or not sched:ready('johnny') then return end
    local rid = speech.requestId
    if not rid or st.decided[rid] then return end
    local via, name
    if automatic and automatic.requestId == rid and automatic.reaction and automatic.reaction.kind == 'speakup'
        and st.hold and st.hold.who == 'companion' and st.hold.requestId == rid then
        via, name = 'companion', automatic.name
    else
        local manual = st.lastManual
        if manual and manual.requestId == rid and manual.eligible then via, name = 'talk', manual.name end
    end
    if not via then return end
    local spoken = speech.context
    local transcript = type(spoken) == 'table' and speech.transcript(rid, spoken.generation, spoken.entity) or nil
    if not transcript or transcript.textComplete ~= true or type(transcript.text) ~= 'string' then return end
    if st.decidedCount >= 8 then st.decided, st.decidedCount = {}, 0 end
    st.decided[rid], st.decidedCount = true, st.decidedCount + 1
    local text = transcript.text
    if #text < 4 or #text > convaiSpeakUpConfig.LINE_MAX or type(name) ~= 'string' or #name < 1 or #name > 60 then return end
    if not sched:followOn(via == 'companion' and 'companion' or 'talk', {during = via == 'companion'}) then return end
    local head = convaiJohnnyHeadService()
    if not head or head:refusal(player) then return end
    local partner = head:partner(player)
    if not partner then return end
    generation = generation + 1
    local context = {generation = generation, entity = partner.entity, name = partner.name, bodyType = '',
        profileKey = partner.profileKey, voiceOnly = true, head = partner.head, sentAt = now,
        text = 'Johnny speaks up unprompted. Give one brief in-character remark.',
        reaction = {kind = 'head', event = 'follow', facts = {who = name, line = text, via = via},
            expiresAt = math.floor((now + convaiSpeakUpConfig.FOLLOW_SEND) * 1000)}}
    context.requestId = tostring(os.time()) .. '-' .. generation .. '-' .. context.entity
    context.journal = questContext.capture()
    if not convaiSpeakUpPublish({kind = 'follow', sourceRequestId = rid, input = context}) then return end
    st.plan = {kind = 'follow', context = context, sourceRequestId = rid, createdAt = now, via = via}
    log('Speak up: Johnny follow-on prepared via=' .. via)
end

-- Johnny's prepared follow-on: the source line has been heard to its end, so the very request that was prepared is sent now.
function convaiSpeakUpSubmitFollow(plan)
    local st, sched = convaiSpeakUpState, convaiSpeakUp
    local player = convaiPlayer()
    local head = convaiJohnnyHeadService()
    local outputs = battleOutputs or (player and reactionOutputs(player)) or {enabled = true}
    if not sched or not player or not head or head:refusal(player) or pending ~= nil or automatic ~= nil or not outputs.enabled then
        return convaiSpeakUpWithdraw('follow-not-possible')
    end
    if not sched:claim('johnny', {follow = true}) then return convaiSpeakUpWithdraw('follow-refused') end
    st.plan = nil
    local context = plan.context
    if convaiSpeakUpSubmit(player, os.time(), true, outputs, context, nil, 'johnny', 'Johnny follow-on via=' .. tostring(plan.via)) then
        convaiHeadTalk = {entity = context.entity}
    end
end

-- A line of speech ended (mod/speech.lua M.stop, reason 'finished' when it was heard to its end): a companion's unprompted line is over at
-- once (not when its caption has faded), and a prepared follow-on to it, or to a conversation reply, starts.
function convaiSpeakUpStopped(requestId, reason)
    local st = convaiSpeakUpState
    if automatic and automatic.requestId == requestId and automatic.reaction and automatic.reaction.kind == 'speakup' and reason == 'finished' then
        cancelAutomatic('finished', true)
    end
    local plan = st.plan
    if plan and plan.kind == 'follow' and plan.sourceRequestId == requestId then
        if reason == 'finished' then convaiSpeakUpSubmitFollow(plan)
        else convaiSpeakUpWithdraw('source-' .. tostring(reason)) end
    end
end
speech.onStopped = function(requestId, reason)
    if convaiSpeakUp or convaiSpeakUpState.plan then pcall(convaiSpeakUpStopped, requestId, reason) end
end

-- V sent a line of their own: it cancels anything prepared, and a reply to it may get a follow-on from Johnny.
function convaiSpeakUpManualSent(context)
    local st = convaiSpeakUpState
    if convaiPartyState.chat then convaiPartyAbort('talk') end
    st.lastManualAt = os.time()
    st.calmFor = 0
    if st.plan then convaiSpeakUpWithdraw('manual') end
    local key = context.profileKey
    local ordinary = type(key) ~= 'string' or key:find('^resident%-') or key:find('^npc%-') or key:find('^addon%-') or key:find('^custom%-')
        or key == 'johnny-silverhand'
    st.lastManual = {requestId = context.requestId, name = context.name, profileKey = key,
        eligible = not ordinary and not context.group and not context.holocall and not context.head and not context.voiceOnly and not context.archetype}
end

-- The prepared line and the plan, once per tick: dropped when V talks or the game takes the floor; an 'ahead' line is sent when its scene is over.
function convaiSpeakUpPlanTick(player, now, worldReady, outputs, manual)
    local st = convaiSpeakUpState
    local plan = st.plan
    if not plan then return end
    local sched, sample = convaiSpeakUp, battleSample or {}
    local why
    if not sched then why = 'off'
    elseif not worldReady then why = 'world-not-ready'
    elseif manual then why = 'manual'
    elseif not outputs.enabled then why = 'outputs-disabled'
    elseif now - plan.createdAt > convaiSpeakUpConfig.PLAN_TTL then why = 'stale' end
    if not why and plan.kind == 'follow' then
        local head = convaiJohnnyHeadService()
        why = head == nil and 'head-off' or head:refusal(player)
        if why then why = 'head-' .. why end
    elseif not why then
        local scene = st.scene
        if not scene or scene.lastAt ~= plan.sceneStamp then why = 'scene-continued'
        elseif sample.combat then why = 'combat'
        elseif sample.blocked then why = 'scene-blocked'
        elseif automatic ~= nil or pending ~= nil or speech.requestId ~= nil then why = 'busy' end
        if not why and os.clock() - scene.lastAt >= convaiSpeakUpConfig.SCENE_QUIET then
            local person
            for _, candidate in ipairs(battlePeople) do
                if candidate.entity == plan.person.entity and candidate.profileKey == plan.person.profileKey then person = candidate; break end
            end
            if not person or person.available ~= true then why = 'speaker-unavailable'
            else
                st.plan, st.scene = nil, nil
                convaiSpeakUpSubmit(player, now, worldReady, outputs, plan.context, person, 'companion',
                    'companion scene speaker=' .. person.profileKey .. ' (prepared ahead)')
                return
            end
        end
        if why and scene then scene.failed = true end
    end
    if why then convaiSpeakUpWithdraw(why) end
end

-- Companions speak up together (docs/COMPANION_SPEAK_UP.md, "Group speak-up"). When a calm speak-up comes due and two or more party companions (our own
-- copies, ready, within RANGE metres of V) could speak, most of the time it becomes a short chat among up to three of them instead of one line: the first
-- speaks, the others answer in turn (3 to 5 lines in all), one voice at a time, then nothing until the next speak-up. The turn order, the beat between
-- lines, the line written while the one before it plays and the ending are the engine of the housemates' chat (mod/housemate-chat.lua, started by its owner:
-- env.startOnly); this block is the game side of it for the party: the people, the request of a line (reaction kind 'speakup', event 'party') and the lines
-- in the air. A line is an ordinary speak-up line for everything else (convaiSpeakUpManage ends it for combat, a scene, V talking, a missing speaker...).
-- Nothing runs while no round is on: one nil check on the 0.1 s tick. The engine is made when a round starts and dropped when it ends.
convaiPartyState = {chat = nil, opening = false, waiting = nil, current = nil, result = nil, text = nil, prepared = nil, gateOk = false, cancelling = false}
-- RANGE: metres from V at which a companion can start or join a round; STAY: how far she may wander before she drops out. CHANCE: how often a speak-up
-- that could be a group one is. WAIT: seconds a line may wait for the channel or its speaker. SEND / AHEAD: seconds a line has to be heard once sent / when
-- it was written ahead. LINES: the planned length for two and for three people (one of the two numbers, at random); MAX: the engine's hard stop.
convaiPartyConfig = {RANGE = 15, STAY = 25, CHANCE = 0.75, WAIT = 15, SEND = 45, AHEAD = 90, MAX = 5, LINES = {[2] = {3, 4}, [3] = {4, 5}}}
convaiPartyModule = nil

-- The party members who are still part of the round, as the engine's rows ({key, name, entity, bodyType}): ready party copies near V.
function convaiPartyRows()
    local list = {}
    for _, person in ipairs(convaiSpeakUpPeople()) do
        if person.party == true and person.distance <= convaiPartyConfig.STAY then
            list[#list + 1] = {key = person.profileKey, name = person.name, entity = person.entity, bodyType = person.bodyType}
        end
    end
    return list
end

-- The context of one line as the bridge is given it. A line written ahead is this very table, made while the line before it was in the air.
function convaiPartyContext(request, now, seconds)
    generation = generation + 1
    local speaker = request.speaker
    local reaction = {kind = 'speakup', event = 'party', facts = {v = 1}, partner = request.partner.name, partnerKey = request.partner.key,
        others = request.others or {}, n = request.n, of = request.of, lines = request.lines or {}, expiresAt = math.floor((now + seconds) * 1000)}
    local context = {generation = generation, entity = speaker.entity, name = speaker.name, bodyType = speaker.bodyType or '', profileKey = speaker.key,
        sentAt = now, reaction = reaction, text = 'You are chatting with your fellow companions while out with V. Say your next line.'}
    context.requestId = tostring(os.time()) .. '-' .. generation .. '-' .. context.entity
    -- Captured here so a line prepared ahead is the very request that is sent later (the bridge compares them).
    context.journal = questContext.capture()
    if convaiTurnContext then context.turnContext = convaiTurnContext:capture() end
    return context
end

-- The engine's seams. A line: 'waiting' (queued, nothing sent), 'busy' (sent, being written or said; the text once known), 'done', 'failed' or 'cancelled'.
function convaiPartySpeak(request)
    local st = convaiPartyState
    if st.waiting or st.current or type(request) ~= 'table' then return false end
    local waiting = {request = request, at = os.time()}
    -- Written ahead (convaiPartyPrepare) and still the line that was meant: it goes out as it is, after the beat the chat asked for.
    local held = st.prepared
    if held then
        st.prepared = nil
        if request.prepared == true and held.request.speaker.key == request.speaker.key and held.request.n == request.n then
            waiting.context = held.context
            waiting.notBefore = os.clock() + (tonumber(request.gap) or 0.3)
        else
            pcall(convaiSpeakUpPublish, nil)
        end
    end
    st.waiting, st.text, st.result = waiting, nil, {status = 'waiting'}
    return true
end

function convaiPartyStatus()
    local st = convaiPartyState
    local result = st.result
    if not result then return nil end
    if result.status == 'busy' then return 'busy', st.text end
    return result.status, result.text
end

-- The next line is written while the one in the air is still being said: published for the bridge to run now and hold back (the same hold-and-claim as the
-- housemates' chat), sent as it is when the line has been heard. A plan or provider that cannot run two lines at once takes it as an ordinary request then.
function convaiPartyPrepare(request)
    local st = convaiPartyState
    if st.prepared or type(request) ~= 'table' or not st.current or not (automatic and automatic.party) or convaiSpeakUpState.plan then return false end
    local context = convaiPartyContext(request, os.time(), convaiPartyConfig.AHEAD)
    if not convaiSpeakUpPublish({kind = 'ahead', input = context}) then return false end
    st.prepared = {request = request, context = context}
    return true
end

-- Withdrawn: the round stopped, V talks, or the line it was written for did not turn out as expected (the bridge drops the held line).
function convaiPartyUnprepare()
    local st = convaiPartyState
    if not st.prepared then return end
    st.prepared = nil
    pcall(convaiSpeakUpPublish, nil)
end

function convaiPartyCancel()
    local st = convaiPartyState
    st.cancelling = true
    if automatic and automatic.party then cancelAutomatic('party-cancelled') end
    if st.waiting and st.waiting.context then pcall(convaiSpeakUpPublish, nil) end
    st.waiting, st.current, st.result = nil, nil, {status = 'cancelled'}
    st.cancelling = false
end

-- The reply text of a line, as soon as it is known (the next speaker's context).
function convaiPartyReplyText(replyPending, text)
    local reaction = replyPending and replyPending.reaction
    if reaction and reaction.kind == 'speakup' and reaction.event == 'party' then convaiPartyState.text = text end
end

-- cancelAutomatic ends every automatic line; a party line's end is the engine's answer for it.
function convaiPartyLineEnded(line, reason)
    local st = convaiPartyState
    if not st.chat or st.cancelling then return end
    st.current = nil
    if (reason == 'finished' or reason == 'completed') and line.shown == true then
        st.result = {status = 'done', text = st.text}
        -- The next line is requested now, not at the engine's next step.
        pcall(st.chat.poke)
    elseif reason == 'manual-priority' or reason == 'manual-text' or reason == 'microphone' then
        st.result = {status = 'cancelled'}
    else
        st.result = {status = 'failed'}
    end
end

-- The round is over (the engine's `ended`): the floor goes back to the scheduler, heard if any line was.
function convaiPartyEnded(reason, spoken)
    local st = convaiPartyState
    if st.opening then return end
    if st.waiting and st.waiting.context or st.prepared then pcall(convaiSpeakUpPublish, nil) end
    st.chat, st.waiting, st.current, st.result, st.text, st.prepared = nil, nil, nil, nil, nil, nil
    local sched = convaiSpeakUp
    if sched then pcall(sched.release, sched, 'companion', (tonumber(spoken) or 0) > 0) end
    log('Speak up: party round ended (' .. tostring(reason) .. ') lines=' .. tostring(spoken))
end

function convaiPartyMayGo() return convaiPartyState.gateOk == true end

-- Stop a round now (V talks, the world changes, the list is turned Off): the line in the air is cut the way a single speak-up is.
function convaiPartyAbort(reason)
    local chat = convaiPartyState.chat
    if chat then pcall(chat.interrupt, reason, true) end
end

-- A calm speak-up is due and `first` (a party companion) was chosen to speak: make it a round when two or more party companions are near, most of the
-- time. false: the caller says the single line as before.
function convaiPartyStart(first)
    local st, cfg = convaiPartyState, convaiPartyConfig
    if st.chat or first.party ~= true or first.distance > cfg.RANGE or math.random() >= cfg.CHANCE then return false end
    local group = {{key = first.profileKey, name = first.name, entity = first.entity, bodyType = first.bodyType}}
    -- The people come nearest first (companions.conversationCandidates).
    for _, person in ipairs(convaiSpeakUpPeople()) do
        if #group >= 3 then break end
        if person.party == true and person.entity ~= first.entity and person.available == true and person.voiceBusy ~= true and person.distance <= cfg.RANGE then
            group[#group + 1] = {key = person.profileKey, name = person.name, entity = person.entity, bodyType = person.bodyType}
        end
    end
    if #group < 2 then return false end
    if not convaiPartyModule then
        local loaded, module = pcall(dofile, 'housemate-chat.lua')
        if not loaded or type(module) ~= 'table' or type(module.new) ~= 'function' then
            print('[CyberpunkConvai] housemate-chat.lua unavailable: ' .. tostring(module))
            return false
        end
        convaiPartyModule = module
    end
    local sized = cfg.LINES[#group]
    local chat = convaiPartyModule.new({startOnly = true, label = 'Party chat', maxLines = cfg.MAX, random = math.random,
        people = convaiPartyRows, mayStart = convaiPartyMayGo, level = function() return 'normal' end,
        speak = convaiPartySpeak, status = convaiPartyStatus, cancelSpeak = convaiPartyCancel,
        prepare = convaiPartyPrepare, unprepare = convaiPartyUnprepare, ended = convaiPartyEnded, log = log})
    st.chat, st.opening, st.gateOk = chat, true, true
    st.waiting, st.current, st.result, st.text, st.prepared = nil, nil, nil, nil, nil
    local started = chat.start(group, {of = sized[math.random(#sized)]})
    st.opening = false
    if not started then
        st.chat, st.waiting, st.current, st.result = nil, nil, nil, nil
        return false
    end
    log('Speak up: companion party round speakers=' .. #group)
    return true
end

-- Once per tick while a round is on: the gates of a speak-up, the next line sent when the channel and its speaker are free, and the engine's step.
function convaiPartyTick(player, now, worldReady, outputs, manual, elapsed)
    local st, cfg = convaiPartyState, convaiPartyConfig
    local chat = st.chat
    if not chat then return end
    local sample = battleSample or {}
    local why = not worldReady and 'world-not-ready' or manual and 'manual' or not outputs.enabled and 'outputs-disabled'
        or sample.available ~= true and 'unavailable' or sample.blocked and 'scene-blocked' or sample.combat and 'combat'
        or battles.fighting() and 'combat' or (convaiHolocall ~= nil and convaiHolocall.call ~= nil) and 'call'
        or (manager.companionSpeakUp and manager.companionSpeakUp() or 'off') == 'off' and 'off' or nil
    st.gateOk = why == nil
    if why then return convaiPartyAbort(why) end
    local waiting = st.waiting
    if waiting and not automatic then
        if os.time() - waiting.at > cfg.WAIT then
            st.waiting, st.result = nil, {status = 'failed'}
            if waiting.context then pcall(convaiSpeakUpPublish, nil) end
        elseif pending == nil and speech.requestId == nil and not subtitles.ownsUtterance()
            and not (waiting.notBefore and os.clock() < waiting.notBefore) then
            local request, person = waiting.request, nil
            for _, candidate in ipairs(battlePeople) do
                if candidate.entity == request.speaker.entity and candidate.profileKey == request.speaker.key then person = candidate; break end
            end
            if not person then
                st.waiting, st.result = nil, {status = 'failed'}
                if waiting.context then pcall(convaiSpeakUpPublish, nil) end
            elseif person.available == true and person.voiceBusy ~= true then
                st.waiting = nil
                local context = waiting.context or convaiPartyContext(request, now, cfg.SEND)
                if convaiSpeakUpSubmit(player, now, worldReady, outputs, context, person, 'companion',
                    'companion party line ' .. tostring(request.n) .. ' speaker=' .. person.profileKey .. (waiting.context and ' (written ahead)' or ''), true) then
                    automatic.party = true
                    st.current, st.result = request, {status = 'busy'}
                else
                    st.result = {status = 'failed'}
                end
            end
        end
    end
    if st.chat then pcall(st.chat.update, elapsed) end
end

-- Other features' proactive exchanges (the housemates' chat and welcome) share the pace and the gaps. Always present; with both speak-up
-- lists Off there is nothing to merge with, so everything is allowed and nothing is kept.
convaiProactive = {
    allow = function(kind, lines)
        local sched = convaiSpeakUp
        if not sched then return true end
        local ok, allowed = pcall(sched.externalAllowed, sched)
        return not ok or allowed == true
    end,
    note = function(kind, lines)
        local sched = convaiSpeakUp
        if sched then pcall(sched.external, sched, kind, lines) end
    end}


local function updateBattles(player, elapsed, worldReady)
    battlePoll = battlePoll + elapsed
    if not battleSample or battlePoll >= 0.5 then
        battlePoll = 0
        battleSample = battleObserver.sample(player)
        battleSampleAt = os.time() * 1000
        if convaiVixenBaselineDue and worldReady then pcall(convaiVixenBaseline, player, os.time()) end
        if convaiSpawnedPeople then
            convaiSpawnedPeople.sample(player, battleSample, manager.battleReactions() or manager.lootReactions())
        end
        battlePeople, battleCandidatesOk = reactionPeople(player, battleSample)
        battleOutputs = reactionOutputs(player)
        if convaiJohnnyPlaceSample then convaiJohnnyGuarded('place sample', convaiJohnnyPlaceSample, worldReady, battleSample.vehicle == true) end
        if convaiJohnnyFight then convaiJohnnyGuarded('fight watch', convaiJohnnyFightSample, battleSample) end
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
    -- Companions and Johnny speak up: the scheduler's clock counts calm time only; a prepared line is kept or dropped (one nil check while none).
    if convaiPerfMark then convaiPerfMark('init:speakUp') end -- Developer mode: its own row in perf-probe.json; the battle work below returns to 'init:battles'
    local speakUpOn = convaiSpeakUpAdvance(now, elapsed, worldReady, manual, outputs)
    if convaiSpeakUpState.plan then convaiSpeakUpPlanTick(player, now, worldReady, outputs, manual) end
    if speakUpOn and not convaiSpeakUpState.plan then convaiSpeakUpPlanFollow(player, now) end
    if convaiPartyState.chat then convaiPartyTick(player, now, worldReady, outputs, manual, elapsed) end
    if convaiPerfMark then convaiPerfMark('init:battles') end
    if automatic and automatic.reaction.kind == 'meet' then
        convaiMeetGreetingTick(player, now, worldReady, outputs, manual)
    elseif automatic and automatic.reaction.kind == 'house' then
        convaiHouseTick(player, now, worldReady, outputs, manual)
    elseif automatic and automatic.reaction.kind == 'head' then
        convaiJohnnyRemarkTick(player, now, worldReady, outputs, manual)
    elseif automatic and automatic.reaction.kind == 'speakup' then
        convaiSpeakUpManage(player, now, worldReady, outputs, manual)
    elseif automatic and automatic.reaction.kind == 'ambush' then
        convaiAmbushBarkTick(player, now, worldReady, outputs, manual)
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
    if not automatic and (convaiMeetGreetingWaiting or convaiMeetGreetingCurrent) then
        convaiMeetGreetingTick(player, now, worldReady, outputs, manual)
    end
    if not automatic and (convaiHouseWaiting or convaiHouseCurrent) then
        convaiHouseTick(player, now, worldReady, outputs, manual)
    end
    -- One unprompted floor: an open holocall (V's own call, between its turns), a housemate line or chat (also between two lines of it) and a greeting
    -- waiting for the channel hold a fight's or a pickup's comment back, as they hold a companion's speak-up (convaiSpeakUpEligible).
    local busy = not worldReady or manual or not outputs.enabled or pending ~= nil or speech.requestId ~= nil or subtitles.ownsUtterance() or automatic ~= nil
        or (convaiHolocall ~= nil and convaiHolocall.call ~= nil) or (convaiUnpromptedBusy ~= nil and convaiUnpromptedBusy())
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
    -- Battle and loot reactions first; then a waiting Johnny remark (one length check while nothing is queued).
    if not event then
        if speakUpOn then convaiSpeakUpOffer(player, now, worldReady, outputs, manual, busy or (convaiUnpromptedBusy ~= nil and convaiUnpromptedBusy()), mayFollow) end
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
    -- When the turns come back, on this computer's clock (next 00:00 UTC, ui.dailyResetClock), if the clock can be read.
    local at = type(ui.dailyResetClock) == 'function' and ui.dailyResetClock() or nil
    if at then
        if type(limit) == 'number' then
            return ui.t('Today’s {limit} Convai turns are used.\nIt resets at {time}. Try Local AI (unlimited) or Google Gemini (your own key).', {limit = limit, time = at})
        end
        return ui.t('Today’s Convai turns are used.\nIt resets at {time}. Try Local AI (unlimited) or Google Gemini (your own key).', {time = at})
    end
    if type(limit) == 'number' then
        return ui.t('Today’s {limit} Convai turns are used.\nTry Local AI (unlimited) or Google Gemini (your own key).', {limit = limit})
    end
    return ui.t('Today’s Convai turns are used.\nTry Local AI (unlimited) or Google Gemini (your own key).')
end

local function keyNoticeText(code)
    if code == 'quota-shared' then
        return ui.t('The conversation limit has been reached. Try again later, or choose Local AI or Google Gemini in Settings > Conversation provider.')
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
local function localFailureSuffix(reply, field)
    local detail = reply[field or 'errorDetail']
    if type(detail) ~= 'string' or detail == '' or #detail > 140 or detail:find('[%c\128-\255]') then return '' end
    return '\n(' .. detail .. ')'
end

-- id and text of the notice a reply calls for, or nil for an ordinary reply.
local function keyReplyNotice(reply)
    if reply.errorCode == 'key-memory' or reply.keyNotice == 'memory-off' then
        return 'key-memory', ui.t('Your Convai plan has no room for conversation memory, so companions will not remember past talks.')
    end
    if reply.errorCode == 'daily-limit' then return 'daily-limit', dailyLimitText() end
    -- The shared Convai account could not be signed in to (the sign-in backend did not answer, refused, or the package has none): a turn V asked for says so.
    if reply.errorCode == 'convai-unavailable' then
        return 'convai-unavailable', ui.t('Convai could not sign in. Try again in a moment, or choose Google Gemini or Local AI in Settings > Conversation provider.')
    end
    -- Mistral: three failures the bridge names, and two one-time notices on the first reply.
    if reply.errorCode == 'mistral-key' then
        return 'mistral-key', ui.t('Mistral did not accept your key. Check it in Settings > Conversation provider.')
    elseif reply.errorCode == 'mistral-limit' then
        return 'mistral-limit', ui.t('Mistral’s limit is reached for now. Try again in a moment.')
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
    -- Google Gemini: seven failures the bridge names, in Google's own terms (the same sentences as mod/custom-provider.lua's notice(), which a test keeps equal).
    if reply.errorCode == 'gemini-key' then
        return 'gemini-key', ui.t('Google did not accept your Gemini key. Check it in Google AI Studio and add it again.')
    elseif reply.errorCode == 'gemini-daily' then
        -- The free allowance of the day: when it comes back on this computer's clock (the bridge sends "HH:MM", Google resets at midnight Pacific).
        local at = reply.errorResetTime
        if type(at) == 'string' and at:match('^%d%d:%d%d$') then
            return 'gemini-daily', ui.t('Your free Gemini allowance for today is used up. It resets at {time}. Use Convai or Local AI.', {time = at})
        end
        return 'gemini-daily', ui.t('Your free Gemini allowance for today is used up. It resets tomorrow. Use Convai or Local AI.')
    elseif reply.errorCode == 'gemini-limit' then
        return 'gemini-limit', ui.t('Google Gemini is rate limiting you. Wait a minute, then try again.')
    elseif reply.errorCode == 'gemini-region' then
        return 'gemini-region', ui.t('Google Gemini is not available in your region. Use Convai or Local AI.')
    elseif reply.errorCode == 'gemini-server' then
        return 'gemini-server', ui.t('Google Gemini is busy or had an error. Wait a minute, then try again.')
    elseif reply.errorCode == 'gemini-unreachable' then
        return 'gemini-unreachable', ui.t('Google Gemini could not be reached. Check your internet connection, then try again.')
    elseif reply.errorCode == 'gemini-model' then
        return 'gemini-model', ui.t('The Gemini model is not available right now. Try again later or use Local AI.')
    end
    -- Local AI is chosen and could not start: its own reason, and the next turn tries again. No other provider ever takes the turn over
    -- (bridge/convai-bridge.mjs providerFailureCode).
    if reply.errorCode == 'local-no-memory' then
        return 'local-no-memory', ui.t('Not enough free graphics memory to start Local AI. Try a smaller model in Settings.') .. localFailureSuffix(reply)
    elseif reply.errorCode == 'local-unavailable' then
        return 'local-unavailable', ui.t('Local AI could not start. Check Local AI in Settings > Conversation provider.') .. localFailureSuffix(reply)
    end
    -- An older bridge's code for Local AI that could not start (it said a cloud provider takes over, which never happens now): the same line as local-unavailable.
    if reply.errorCode == 'local-fallback' or reply.keyNotice == 'local-fallback' then
        return 'local-unavailable', ui.t('Local AI could not start. Check Local AI in Settings > Conversation provider.') .. localFailureSuffix(reply)
    end
    -- The browser for the conversation page was found but would not start (bridge/system-browser.mjs): name it, the detail says which and why.
    if reply.errorCode == 'browser-failed' then
        return 'browser-failed', ui.t('The browser for the conversation page would not start. Try again, or use another Chromium browser.') .. localFailureSuffix(reply)
    end
    -- A turn the local AI could not answer, with no cloud provider to take it over: say so (the next turn tries again).
    if reply.errorCode == 'local-failed' then
        return 'local-failed', ui.t('Local AI could not answer that. Try again in a moment.') .. localFailureSuffix(reply)
    end
    -- A model on the player's own server that only thought, also when asked not to think, or a context there that is too small for the character: what to change.
    if reply.errorCode == 'local-thinking' then
        return 'local-thinking', ui.t("Your model only thought and didn't answer. Turn thinking off for it in your model server, or pick a non-thinking model.")
    elseif reply.errorCode == 'local-context' then
        return 'local-context', ui.t("Your model server's context is too small for this character. Raise the context length in your server (8192 or more).")
    end
    -- The Local AI model server stopped working by itself and was started again (bridge/local-llm-server.mjs): said once, with the next reply.
    if reply.keyNotice == 'local-restarted' then
        return 'local-restarted', ui.t('Local AI stopped working and was restarted.')
    end
    -- The Local AI model is mostly on the processor (too little of it fits the graphics card beside the game): said once, with the next reply; the bridge's few words say what is faster.
    if reply.keyNotice == 'local-cpu' then
        return 'local-cpu', ui.t('Local AI runs mostly on your processor here, so replies will be slow.') .. localFailureSuffix(reply, 'keyNoticeDetail')
    end
    -- The player allowed partial offload to RAM (Settings): the chosen model did not fit the free graphics memory and was kept with part of it in system memory. Said once per model, with the next reply.
    if reply.keyNotice == 'local-offload' then
        local used = reply.keyNoticeModel
        if type(used) ~= 'string' or used == '' or #used > 80 or used:find('%c') then used = ui.t('another model') end
        return 'local-offload', ui.t('Local AI is keeping {model} as you allowed, with part of it in system memory. Replies will be slower.', {model = used})
    end
    -- The Local AI model had gone into shared system memory (or partly onto the processor) and is whole on the graphics card again (bridge/local-llm-server.mjs, 'returned-to-card'): said once, with the next reply.
    if reply.keyNotice == 'local-gpu' then
        return 'local-gpu', ui.t('Local AI is back on your graphics card, so replies are faster again.')
    end
    -- Windows draws its yellow capture border around the game for the "Companions can see" pictures (docs/COMPANION_VISION.md): said once, with the next reply.
    if reply.keyNotice == 'vision-border' then
        return 'vision-border', ui.t('The yellow border is Windows showing a capture. Turn off Companions can see to stop it.')
    end
    -- Companions can see is on and the Local AI model cannot take pictures (no vision file beside it, or none that fits the graphics card): said once per model, with the next reply.
    if reply.keyNotice == 'vision-local-no-model' then
        return 'vision-local-no-model', ui.t('This Local AI model cannot see pictures, so replies use only your words.')
    end
    -- Companions can see is on and the Local AI model can see with its vision file, which is not installed (a separate download, the vision folder of local-ai or mature on Hugging Face): said once per model, with the next reply.
    if reply.keyNotice == 'vision-local-no-file' then
        local folder = reply.keyNoticeFolder == 'mature' and 'mature' or 'local-ai'
        return 'vision-local-no-file', ui.t('This model can see pictures with its vision file, from {folder}/vision on Hugging Face.', {folder = folder})
    end
    -- Companions can see is on and the Custom endpoint refused a picture (a model with no vision): none is sent to it again this session, said once.
    if reply.keyNotice == 'vision-custom-no-images' then
        return 'vision-custom-no-images', ui.t('Your Custom endpoint does not accept pictures, so replies use only your words.')
    end
    -- The Local AI model the player chose is missing, does not fit or did not start, and another was used (the reply names it): said once per choice.
    if reply.keyNotice == 'local-model-fallback' then
        local used = reply.keyNoticeModel
        if type(used) ~= 'string' or used == '' or #used > 80 or used:find('%c') then used = ui.t('another model') end
        -- A model that did not fit: how much graphics memory it needs and how much is available for it beside the game (MiB from the bridge, shown as MB to the nearest 100).
        local need, available = reply.keyNoticeNeedMiB, reply.keyNoticeAvailableMiB
        if type(need) == 'number' and type(available) == 'number' and need > 0 and need < 1000000 and available >= 0 and available < 1000000 then
            local function megabytes(mib) return math.floor(mib * 1.048576 / 100 + 0.5) * 100 end
            return 'local-model-fallback', ui.t('The Local AI model you chose needs about {need} MB of graphics memory, but only {available} MB are available for it beside the game, so {model} was used instead.', {need = megabytes(need), available = megabytes(available), model = used})
        end
        return 'local-model-fallback', ui.t('The Local AI model you chose is missing, does not fit in the free graphics memory or did not start, so {model} was used instead.', {model = used})
    end
    -- Local AI's turns stalled because the game uses most of the graphics memory: the bridge loaded the next smaller model (the reply names it; an older bridge may
    -- send none). Said once per step (bridge/local-llm-server.mjs, 'model-stepdown'). With no smaller model left Local AI fails with local-no-memory instead.
    if reply.keyNotice == 'local-stepdown' then
        local used = reply.keyNoticeModel
        if type(used) ~= 'string' or used == '' or #used > 80 or used:find('%c') then used = ui.t('another model') end
        return 'local-stepdown', ui.t('Local AI switched to {model}: the game is using most of your graphics memory.', {model = used})
    end
    -- A text provider answered in a language the chosen voice cannot speak (Pocket is English only; Voxtral lists some languages): the reply showed as text. Said once per game session.
    if reply.keyNotice == 'voice-language' then
        return 'voice-language', ui.t('Replies in some languages show as text: this voice does not speak them. OmniVoice speaks them all, and Voxtral most of them.')
    end
    -- The PocketTTS model for a language is installed, but the multilingual pack it clones from is not: that language's replies show as text. Said once per language per game session.
    if reply.keyNotice == 'pocket-language-pack' then
        local names = {fr = ui.t('French'), it = ui.t('Italian'), de = ui.t('German'), es = ui.t('Spanish'), pt = ui.t('Portuguese')}
        local language = names[reply.keyNoticeLanguage]
        if language then
            return 'pocket-pack-' .. reply.keyNoticeLanguage, ui.t('{language} replies show as text: the {language} multilingual pack is missing.', {language = language})
        end
    end
    if reply.keyNotice == 'mistral-no-key' then
        return 'mistral-no-key', ui.t('Mistral has no key yet, so Convai is used. Add your key in Settings > Conversation provider.')
    elseif reply.keyNotice == 'mistral-voice' then
        return 'mistral-voice', ui.t('Mistral replies are spoken by a local voice instead of the Convai cloud voice.')
    elseif reply.keyNotice == 'custom-no-setup' then
        return 'custom-no-setup', ui.t('The custom provider is not set up, so Convai is used. Add its URL and model ID in Settings.')
    elseif reply.keyNotice == 'custom-voice' then
        return 'custom-voice', ui.t('Custom provider replies are spoken by a local voice instead of the Convai cloud voice.')
    elseif reply.keyNotice == 'gemini-no-key' then
        return 'gemini-no-key', ui.t('Google Gemini has no key yet, so Convai is used. Add your key in Settings > Conversation provider.')
    elseif reply.keyNotice == 'gemini-voice' then
        return 'gemini-voice', ui.t('Google Gemini replies are spoken by a local voice instead of the Convai cloud voice.')
    end
    local text = keyNoticeText(reply.errorCode)
    if text then return 'quota-exhausted', text end
    return nil
end

-- The text of a reply that failed, in the menu language. The bridge words its generic failures in English (bridge/convai-bridge.mjs); each one is mapped here to
-- its catalogue sentence so it is translated like every other notice. Anything else is a provider's own text and stays as it came.
local function replyErrorText(reply)
    local text = reply.error
    if text == 'The conversation service could not reply. Please try again.' then
        return ui.t('The conversation service could not reply. Please try again.')
    elseif text == 'Voice conversation failed. Check your microphone and try again.' then
        return ui.t('Voice conversation failed. Check your microphone and try again.')
    elseif reply.errorCode == 'custom-provider' and type(text) == 'string' then
        local name = text:match('^(.-) is one of your own characters%.')
        if name and name ~= '' and #name <= 160 and not name:find('%c') then
            return ui.t('{name} is one of your own characters. They need Google Gemini, Local AI or Custom: choose one under Conversation provider in the settings.', {name = name})
        end
    elseif type(text) == 'string' then
        local name = text:match('^(.-) does not have a conversation profile configured yet%.$')
        if name and name ~= '' and #name <= 160 and not name:find('%c') then
            return ui.t('{name} does not have a conversation profile configured yet.', {name = name})
        end
    end
    return text
end

-- The reason a phone contact cannot be invited, in the menu language (mod/companions.lua phoneContactKey words them in English).
local function phoneReasonText(reason)
    if reason == 'This contact has no companion mapping yet.' then return ui.t('This contact has no companion mapping yet.') end
    if reason == 'Character unavailable in this game installation.' then return ui.t('Character unavailable in this game installation.') end
    return tostring(reason)
end

-- The one-time information the bridge puts on the first reply of a game session when Mistral or Custom is chosen.
local function sendProviderNotice(player, keyId, keyText)
    if keyId == 'mistral-no-key' then convaiNotices.send(player, 'mistral-no-key', keyText)
    elseif keyId == 'mistral-voice' then convaiNotices.send(player, 'mistral-voice', keyText)
    elseif keyId == 'custom-no-setup' then convaiNotices.send(player, 'custom-no-setup', keyText)
    elseif keyId == 'custom-voice' then convaiNotices.send(player, 'custom-voice', keyText)
    elseif keyId == 'gemini-no-key' then convaiNotices.send(player, 'gemini-no-key', keyText)
    elseif keyId == 'gemini-voice' then convaiNotices.send(player, 'gemini-voice', keyText)
    elseif keyId == 'local-restarted' then convaiNotices.send(player, 'local-restarted', keyText)
    elseif keyId == 'local-cpu' then convaiNotices.send(player, 'local-cpu', keyText)
    elseif keyId == 'local-gpu' then convaiNotices.send(player, 'local-gpu', keyText)
    elseif keyId == 'local-offload' then convaiNotices.send(player, 'local-offload', keyText)
    elseif keyId == 'vision-border' then convaiNotices.send(player, 'vision-border', keyText)
    elseif keyId == 'vision-local-no-model' then convaiNotices.send(player, 'vision-local-no-model', keyText)
    elseif keyId == 'vision-local-no-file' then convaiNotices.send(player, 'vision-local-no-file', keyText)
    elseif keyId == 'vision-custom-no-images' then convaiNotices.send(player, 'vision-custom-no-images', keyText)
    elseif keyId == 'voice-language' then convaiNotices.send(player, 'voice-language', keyText)
    elseif keyId == 'pocket-pack-fr' then convaiNotices.send(player, 'pocket-pack-fr', keyText)
    elseif keyId == 'pocket-pack-it' then convaiNotices.send(player, 'pocket-pack-it', keyText)
    elseif keyId == 'pocket-pack-de' then convaiNotices.send(player, 'pocket-pack-de', keyText)
    elseif keyId == 'pocket-pack-es' then convaiNotices.send(player, 'pocket-pack-es', keyText)
    elseif keyId == 'pocket-pack-pt' then convaiNotices.send(player, 'pocket-pack-pt', keyText)
    elseif keyId == 'local-model-fallback' then convaiNotices.send(player, 'local-model-fallback', keyText)
    elseif keyId == 'local-stepdown' then convaiNotices.send(player, 'local-stepdown', keyText) end
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
    -- An ambusher's taunt is said in the middle of the fight it belongs to: only its speaker must still be there (mod/revenge-ambush.lua).
    if context.reaction.kind == 'ambush' then
        if convaiAmbushSpeakerHere(context.requestId) then return true end
        cancelAutomatic('ambush-speaker-missing')
        return false
    end
    -- A reply can become ready between the half-second observer samples. Read
    -- player scene/combat state and the owned speaker before playback.
    for _, person in ipairs(battlePeople) do
        if person.entity == context.entity and person.profileKey == context.profileKey then
            person.available, person.availableReason, person.voiceBusy = battleObserver.canDeliver(player, person.npc, context.reaction.phase or 'end')
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
    local player = convaiPlayer()
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

-- A game-placed person in a group round (a named character, or a quest-bound person that joined by being nearby) is judged by the game's
-- own checks as its turn comes (a scene, a call, a fight, an injury, a ride: mod/world-talk.lua), and while it speaks its mouth is let through
-- the story rules exactly as in private talk. Returns false when the game is in charge of it right now: its turn is skipped and the round goes
-- on with the others. Any other speaker clears the story state of the speaker before. Once per speaker, never per frame. A global, so
-- updateGroup gains no upvalue.
function convaiGroupSpeakerStory(player, person)
    local facial = convaiFacialPlayback
    if person and (person.story or person.guarded) and convaiWorldTalk ~= nil then
        local why = convaiWorldTalk:refusal(person.npc, player, nil, person.profileKey, person.guarded and true or nil)
        if why then
            log('World conversation refused: group speaker profile=' .. tostring(person.profileKey) .. ' reason=' .. why
                .. (convaiWorldTalk.detail and (' (' .. convaiWorldTalk.detail .. ')') or ''))
            return false
        end
        local projection = person.story and convaiWorldTalk.PROJECTIONS ~= nil and convaiWorldTalk.PROJECTIONS[person.profileKey] == true or nil
        convaiStory = {entity = person.entity, key = person.profileKey, name = person.name, projection = projection,
            idle = person.guarded and true or nil}
        if facial then facial.storyEntity, facial.storyProjection = person.entity, projection == true end
        return true
    end
    -- The speaker is not game-placed: whatever the speaker before it set no longer applies. A round with a story character as its primary
    -- set the state at the key press for that one; it is set again here at its turn.
    if convaiStory ~= nil then
        convaiStory = nil
        if facial then facial.storyEntity, facial.storyProjection = nil, nil end
    end
    return true
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
    -- Whoever of the round the game is in charge of right now does not speak: its turn is skipped (a story character, a quest-bound person).
    if round.stage == 'next' then
        for index = round.index + 1, #round.participants do
            local later = round.participants[index]
            if later.story or later.guarded then
                local why = live[later.entity] and convaiWorldTalk ~= nil
                    and convaiWorldTalk:refusal(later.npc, player, nil, later.profileKey, later.guarded and true or nil) or nil
                if why then live[later.entity] = nil end
            end
        end
    end
    local context, actor = groupChat.next(generation, os.time(), live)
    if not context then focusUntil = os.time() + 1; return end
    if not convaiGroupSpeakerStory(player, round.participants[round.index]) then
        groupChat.received(context.requestId, '', true, {})
        return
    end
    speech.target = actor
    -- An ordinary world NPC's face carries the gated speech layer from its spawn (Face.reds OnWorldInitialize); ConvaiFaceRequest reports it and runs the talk-time guards. An add-on's voice has no face.
    if not context.voiceOnly then
        local faceOk, faceStatus = pcall(function() return actor:ConvaiFaceRequest() end)
        convaiFaceRequestLog(actor, context.entity, faceOk, faceStatus)
        -- A game-placed person (story or quest-bound) keeps its own gaze, pose and AI: voice and face only, as in private talk.
        local placed = round.participants[round.index]
        if not (placed and (placed.story or placed.guarded)) then beginFocus(player, actor) end
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
        endFocus(convaiPlayer())
        if convaiBarkEnd then convaiBarkEnd() end
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
                local player = convaiPlayer()
                if player then convaiNotices.send(player, 'manager-seated', ui.t('Stand up to open the Companion Manager')) end
            end)
        end
    end
end

-- The phone queues a request only while it is open, so the per-frame ConvaiPhoneTakeRequest read waits for an open
-- phone (and a short while after it closes, so a request queued as it closes is still taken). A closed phone is
-- still drained once a second, as a backstop for a request left from before a CET reload.
local phoneDrain = {GRACE = 1.5, IDLE = 1.0, seenAt = nil, drainedAt = nil}
local function phoneDrainDue(phoneOpen)
    local wall = os.clock()
    if phoneOpen then phoneDrain.seenAt = wall
    elseif phoneDrain.seenAt and wall >= phoneDrain.seenAt and wall - phoneDrain.seenAt < phoneDrain.GRACE then phoneDrain.drainedAt = wall
    elseif phoneDrain.drainedAt and wall >= phoneDrain.drainedAt and wall - phoneDrain.drainedAt < phoneDrain.IDLE then return false end
    phoneDrain.drainedAt = wall
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
        convaiNotices.send(player, 'phone-unavailable', phoneReasonText(reason))
        return
    end
    if join then
        -- With Settings > Immersive invitations On, Invite is an appointment: she travels there (mod/immersive-invitations.lua).
        local immersive = convaiImmersiveGet and convaiImmersiveGet() or nil
        if immersive then
            local taken, why = immersive.requestInvite(key)
            if taken ~= nil then
                log('Phone appointment ' .. (taken and 'requested' or 'refused') .. ' for ' .. key)
                if not taken then convaiNotices.send(player, 'phone-invite-reply', tostring(why)) end
                return
            end
        end
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
tacticEnv.player = function() return convaiPlayer() end
tacticEnv.actor = function(entity) return companions.readyActor(entity) end
tacticEnv.rearm = function(entity) return companions.rearmEquipment(entity) end
tacticEnv.marked = function(player) return marking.current(player) end
-- Squadmates pulled into a fight: never a named, story or spawned character, and never one of our own copies.
tacticEnv.protected = function(npc) return convaiWorldPolicy ~= nil and convaiWorldPolicy.protected(npc) == true end
tacticEnv.owned = function(npc) return companions.owns(npc) or (convaiCompanionAdoption ~= nil and convaiCompanionAdoption.hidden(npc)) end
tacticEnv.feedback = function(message)
    local player = convaiPlayer()
    if player then convaiNotices.send(player, 'tactic-outcome', ui.t(message)) end
end
tacticEnv.log = function(line) log(line) end

-- A copy's conversation profile can be reassigned (companions.setProfile).
companions.onProfileChanged = function(entity) retirePrivateReply(entity, 'profile-reassigned') end

-- The main mod seams the add-on API uses (docs/ADDON_API.md, "Main mod seams"). Plain functions over state this file already
-- keeps; none runs unless an add-on has registered, and none runs per frame.
if convaiAddons then
    local seams = {log = function(line) log(line) end, native = function() return convaiNative end,
        player = function() return convaiPlayer() end, outputs = function(player) return reactionOutputs(player) end,
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

registerHotkey('cyberpunk_convai_text', 'AI NPC Cyberpunk Mod: talk by text', function() if convaiTapOnce('text') then beginText(false) end end)
registerHotkey('cyberpunk_convai_group_text', 'AI NPC Cyberpunk Mod: group text chat', function() if convaiTapOnce('group_text') then beginText(true) end end)
-- The talk keys are inputs, not hotkeys: a hotkey runs its function only when the key comes back UP (docs/COMPANION_HOTKEY_INPUT.md), so a held
-- key did nothing until it was let go. An input reports both edges, which is what hold-to-talk needs (docs/VOICE_INPUT.md):
--   down  the recording begins at once (the bridge's microphone opens for the press, the connection follows, nothing said is lost)
--   up    V's turn ends and the reply is asked for
-- A hold shorter than HOLD_S is a bounce or an accidental tap: the recording is dropped without a word. Every edge and what it did is logged.
local HOLD_S = 0.2
local voiceKeys = {}
local function voiceKeyEdge(id, groupMode, isDown, talkJohnny)
    local now = os.clock()
    local ok, err = pcall(function()
        local key = voiceKeys[id]
        if isDown then
            -- Key repeat while held repeats the down; a release that never came (focus lost) is forgotten after a quiet moment.
            if key and now - key.seen < 3 then key.seen = now; return end
            key = {at = now, seen = now, holdId = microphone.newHoldId()}
            voiceKeys[id] = key
            local before = microphone.context and tostring(microphone.state) or 'idle'
            toggleVoice(groupMode, 'press', key.holdId, nil, talkJohnny)
            local after = microphone.context and tostring(microphone.state) or 'idle'
            key.began = before ~= 'starting' and after == 'starting'
            log('Voice key ' .. id .. ' down: recording ' .. before .. ' -> ' .. after .. (key.began and ' (this press began it)' or ''))
        else
            if not key then log('Voice key ' .. id .. ' up without a down'); return end
            voiceKeys[id] = nil
            local held = now - key.at
            local result = 'nothing to end'
            -- The bridge closes its microphone at this very moment, also for a press that never began a recording.
            microphone.releaseKey(key.holdId)
            if key.began then
                if held < HOLD_S then
                    if microphone.context and microphone.state ~= 'reply' then cancelVoice('tap') end
                    result = 'tap: dropped'
                elseif microphone.context and microphone.state ~= 'reply' then
                    toggleVoice(groupMode, 'release')
                    result = 'hold: finish'
                else
                    result = 'hold: already ended'
                end
            end
            log(string.format('Voice key %s up after %d ms: %s', id, math.floor(held * 1000 + 0.5), result))
        end
    end)
    if not ok then log('Voice key ' .. id .. ' failed: ' .. tostring(err)) end
end
registerInput('cyberpunk_convai_voice', 'AI NPC Cyberpunk Mod: talk by voice', function(isDown) voiceKeyEdge('voice', false, isDown) end)
registerInput('cyberpunk_convai_group_voice', 'AI NPC Cyberpunk Mod: group voice chat', function(isDown) voiceKeyEdge('group_voice', true, isDown) end)
-- Johnny has his own keys (docs/TALK_FALLBACK.md): the talk keys with nobody faced go to the party, so the voice in V's head is asked for by name.
registerHotkey('cyberpunk_convai_johnny_text', 'AI NPC Cyberpunk Mod: talk to Johnny by text', function() if convaiTapOnce('johnny_text') then beginText(false, true) end end)
registerInput('cyberpunk_convai_johnny_voice', 'AI NPC Cyberpunk Mod: talk to Johnny by voice', function(isDown) voiceKeyEdge('johnny_voice', false, isDown, true) end)

-- The talk key's microphone device is opened by the key press and stays open, unread, for about 15 s after a voice turn so the next press of a
-- conversation starts at once (docs/VOICE_INPUT.md; the bridge times it, bridge/mic-tap.mjs). This tick tells the bridge when the game is BUSY (a menu, a
-- loading screen, a scene, a dialogue with choices, a call): the device then closes at once and does not linger. It looks only while a voice turn
-- is in flight or ended less than MIC_LINGER_WATCH_S ago, so a player who never uses the voice key pays one clock compare per tick. A global function,
-- so onUpdate reaches it without a new upvalue.
MIC_LINGER_WATCH_S = 17
function convaiMicLingerTick(player, ready)
    local now = os.clock()
    if microphone.context ~= nil or microphone.holding() then convaiMicLingerUntil = now + MIC_LINGER_WATCH_S end
    if convaiMicLingerUntil == nil or now > convaiMicLingerUntil then return end
    local _, blocked = convaiVoiceActivationModule().sample(player, ready)
    microphone.block(blocked)
end

-- Voice activation: talk with no key (docs/VOICE_INPUT.md). A global function, so onUpdate reaches it without a new upvalue.
-- Off (the default): one boolean per tick, no module, no microphone. On: mod/voice-activation.lua opens the bridge's microphone only while a
-- conversation is possible and begins V's turn when the bridge's detector hears V start speaking. Private talk only.
-- The module and its dependencies (loaded on first use: the warm-up tick below and Voice activation both ask it whether a conversation is possible).
function convaiVoiceActivationModule()
    if convaiVoiceActivation then return convaiVoiceActivation end
    convaiVoiceActivation = dofile('voice-activation.lua')
    convaiVoiceActivation.deps = {
        enabled = function() return manager.voiceActivation() end,
        listen = function(on) return microphone.listen(on) end,
        gameplay = function(who) return gameplayCanAcquire(who) end,
        -- A profiled character faced (the gaze scan, every 0.2 s) or one of V's companions near.
        conversation = function(who)
            if convaiLookSeenAt and os.clock() - convaiLookSeenAt < 1.2 then return true end
            return companions.conversationCandidates(who, 8)[1] ~= nil
        end,
        voiceReady = function() return not manager.voiceNeedsConvai() end,
        busy = function()
            return microphone.context ~= nil or pending ~= nil or active ~= nil or automatic ~= nil or groupChat.round ~= nil or phoneChat.pending ~= nil
        end,
        speaking = function() return speech.requestId ~= nil or speech.context ~= nil end,
        -- The same start as the talk key's, with every notice held back: a sound that was not for anyone says nothing.
        begin = function(vadId)
            convaiNotices.mute(true)
            local ran = pcall(toggleVoice, false, 'vad', nil, vadId)
            convaiNotices.mute(false)
            return ran and microphone.context ~= nil
        end,
        errorNotice = function()
            convaiNotices.send(convaiPlayer(), 'mic-vad-error', ui.t('Voice activation could not open the microphone. Check your Windows input device.'))
        end,
    }
    return convaiVoiceActivation
end

function convaiVoiceActivationTick(player, elapsed, ready)
    if not manager.voiceActivation() then
        -- Turned off after being on: the bridge releases the device and the detector (one write, once).
        if convaiVoiceActivation then convaiVoiceActivation.off() end
        return
    end
    convaiVoiceActivationModule().update(player, elapsed, ready)
end
-- Speak dialogue choices (Settings > Gameplay, off by default; docs/VOICE_CHOICES.md): while the game shows its own dialogue choice list, the player can say a
-- choice and it is picked. mod/voice-choices.lua publishes the list when it opens, changes or closes (the HUD's own events) and shows one notice when the bridge
-- could not pick; the bridge hears, matches and presses the keys. One boolean per tick while the setting is off; the module is not even loaded then. A global
-- function, so onUpdate reaches it without a new upvalue.
function convaiVoiceChoicesModule()
    if convaiVoiceChoices then return convaiVoiceChoices end
    convaiVoiceChoices = dofile('voice-choices.lua')
    local function board() local defs = Game.GetAllBlackboardDefs(); return Game.GetBlackboardSystem():Get(defs.UIInteractions), defs.UIInteractions end
    convaiVoiceChoices.deps = {
        enabled = function() return manager.voiceChoices() end,
        observe = function(class, method, fn) ObserveAfter(class, method, fn) end,
        hubsNow = function() local bb, def = board(); return FromVariant(bb:GetVariant(def.DialogChoiceHubs)) end,
        activeHub = function() local bb, def = board(); return bb:GetInt(def.ActiveChoiceHubID) end,
        selectedIndex = function() local bb, def = board(); return bb:GetInt(def.SelectedIndex) end,
        localized = function(text)
            if type(text) == 'string' and text:match('^LocKey#') then return GetLocalizedText(text) end
            return text
        end,
        -- Greyed-out lines (the game cannot apply them): never picked by voice.
        unavailable = function(item)
            local kind = item.type
            return ChoiceTypeWrapper.IsType(kind, Enum.new('gameinteractionsChoiceType', 'Inactive'))
                or ChoiceTypeWrapper.IsType(kind, Enum.new('gameinteractionsChoiceType', 'CheckFailed'))
        end,
        write = function(path, text)
            local file = io.open(path, 'wb')
            if not file then return false end
            file:write(text); file:close()
            return true
        end,
        read = function(path)
            local file = io.open(path, 'rb')
            if not file then return nil end
            local text = file:read('*a'); file:close()
            return text
        end,
        listen = function(on) return microphone.listenChoice(on) end,
        notice = function(kind)
            local text = kind == 'ambiguous' and ui.t('Two options fit. Say its number.')
                or kind == 'unavailable' and ui.t('Speaking a choice needs speech recognition on this PC.')
                or ui.t('No option matched. Say its number.')
            convaiNotices.send(convaiPlayer(), 'voice-choice', text)
        end,
        log = log,
    }
    return convaiVoiceChoices
end

function convaiVoiceChoicesTick()
    if type(manager.voiceChoices) ~= 'function' or not manager.voiceChoices() then
        -- Turned off after being on: the list is forgotten and the bridge releases the microphone (once; the module's tick returns at its first line otherwise).
        if convaiVoiceChoices then convaiVoiceChoices.tick() end
        return
    end
    convaiVoiceChoicesModule().tick()
end

-- A typed line was handed to the service (convaiTalkReceipt, set where the composer's submission is sent): 2 s later one probe.log line says whether the
-- service took it, from the bridge's own status (mod/service-status.lua receipt), so a request that is never read shows in a report (game 2.31, 25 Oct: a
-- typed line had no reply and nothing said where it stopped). Not yet taken: one more look at 6 s, then the line says what the service last wrote.
-- Codes only. At most two looks at two small files per typed line; a global, so onUpdate reaches it without a new upvalue.
function convaiTalkReceiptTick()
    local watch = convaiTalkReceipt
    local elapsed = os.clock() - watch.at
    if elapsed < (watch.again and 6 or 2) and elapsed >= 0 then return end
    local status = convaiServiceStatus
    if type(status) ~= 'table' or type(status.receipt) ~= 'function' then convaiTalkReceipt = nil; return end
    local received, state, statusAge, serviceAge = status.receipt(watch.requestId)
    if not received and not watch.again then watch.again = true; return end
    convaiTalkReceipt = nil
    if received then
        log('Talk request received by the service: generation=' .. tostring(watch.generation) .. ' state=' .. tostring(state) .. (watch.again and ' (after 2 s)' or ''))
    else
        log('Talk request not received by the service within 6 s: generation=' .. tostring(watch.generation) .. ' service=' .. tostring(state)
            .. ' written=' .. tostring(statusAge) .. 's heartbeat=' .. tostring(serviceAge) .. 's')
    end
end

-- The mod's own key bindings (Companion Manager > Key bindings, docs/KEY_BINDINGS.md): a key or controller button the player chose for talk by voice, talk by text,
-- group voice chat, group text chat or the Companion Manager. mod/key-bindings.lua decides whether the moment is allowed and runs the code path the CET key of
-- the same action runs (voiceKeyEdge under the same key id, beginText, openManager), so the gating is the same; the redscript half (KeyBinds.reds) hears the keys.
-- Event driven: nothing here runs per frame, and while no binding is saved the module is not even loaded. Global functions, so onUpdate reaches them without a
-- new upvalue.
function convaiKeyBindsModule()
    if convaiKeyBinds then return convaiKeyBinds end
    -- One load per session: a file that fails to load is not read and compiled again on every 0.1 s tick (callers get nil).
    if convaiKeyBindsFailed then return nil end
    local loaded, module = pcall(dofile, 'key-bindings.lua')
    if not loaded or type(module) ~= 'table' then
        convaiKeyBindsFailed = true
        convaiLogOnce('key-bindings-load', 'Key bindings are unavailable: ' .. tostring(module))
        return nil
    end
    convaiKeyBinds = module
    convaiKeyBinds.deps = {
        bindings = function() return manager.keyBindings() end,
        save = function(action, name) return manager.setKeyBinding(convaiPlayer(), action, name) end,
        voice = function(action, isDown) voiceKeyEdge(action, action == 'group_voice', isDown, action == 'johnny_voice') end,
        tap = function(action)
            if action == 'text' then beginText(false) elseif action == 'group_text' then beginText(true)
            elseif action == 'johnny_text' then beginText(false, true) else openManager() end
        end,
        -- The phone's chat box: V types there with the game's controls still live. The text box and the menus are refused by the actions themselves.
        typing = function(who) return who:ConvaiPhoneChatTyping() end,
        observe = function(fn) Observe('PlayerPuppet', 'ConvaiKeyBindNotify', function(this) fn(this) end) end,
        boundKey = function(id)
            if type(IsBound) ~= 'function' then return nil, false end
            return ui.boundKey(id), true
        end,
        readFile = function(path)
            local file = io.open(path, 'rb')
            if not file then return nil end
            local text = file:read('*a')
            file:close()
            return text
        end,
        changed = function(result) managerUi.keyBindResult(result) end,
        player = function() return convaiPlayer() end,
        log = log,
    }
    return convaiKeyBinds
end

function convaiKeyBindsTick(player, ready)
    if next(manager.keyBindings()) == nil then
        -- Nothing saved: the module (if the page was opened) ends a Set that nobody answered and lets go of what it listened to; otherwise this is the whole cost.
        if convaiKeyBinds then convaiKeyBinds.tick(player, ready) end
        return
    end
    local module = convaiKeyBindsModule()
    if module then module.tick(player, ready) end
end

-- A tap action runs once for one press of a key: a CET hotkey and an own binding on the same key both fire when it comes up. Nothing to compare while no own
-- binding was ever loaded.
function convaiTapOnce(action)
    return convaiKeyBinds == nil or convaiKeyBinds.once(action)
end
registerHotkey('cyberpunk_convai_manager', 'AI NPC Cyberpunk Mod: companion manager', function() if convaiTapOnce('manager') then openManager() end end)
-- Companions change outfits (Settings > Gameplay, off by default; docs/COMPANION_OUTFITS.md): a party copy of a curated character changes into another
-- look of its own template by the game's time of day, now and then for variety and into casual clothes at home, only while it is out of V's view. Our own
-- copies only. The module is loaded on first use and not at all while the setting is off; its 10 Hz tick subtracts the elapsed time from one counter and looks
-- at the party every 20 s. No per-frame work, no handle kept. Global functions, so onUpdate reaches them without a new upvalue.
function convaiOutfitModule()
    if convaiOutfits then return convaiOutfits end
    -- One load per session (the setting is on by default): a file that fails to load is not read and compiled again on every 0.1 s tick.
    if convaiOutfitsFailed then return nil end
    local loaded, module = pcall(dofile, 'companion-outfits.lua')
    if not loaded or type(module) ~= 'table' then
        convaiOutfitsFailed = true
        convaiLogOnce('outfits-load', 'Companion outfits are unavailable: ' .. tostring(module))
        return nil
    end
    convaiOutfits = module
    convaiOutfits.deps = {
        enabled = function() return manager.companionOutfits() end,
        -- The look the player chose for a character in the editor (Look and moves), worn all the time and even with the setting off.
        pinned = function(key) local chosen = convaiCharacterOptions; return chosen and chosen.outfit(key) or nil end,
        anyPinned = function() local chosen = convaiCharacterOptions; return chosen ~= nil and chosen.hasOutfits() end,
        rows = function() return companions.outfitRows(convaiOutfits.known) end,
        current = function(row) return NameToString(row.npc:GetCurrentAppearanceName()) end,
        prefetch = function(row, name) return companions.changeAppearance(row.serial, name, 'prefetch') end,
        apply = function(row, name) return companions.changeAppearance(row.serial, name, 'apply') end,
        remember = function(row, name) return companions.changeAppearance(row.serial, name, 'forget') end,
        gameHours = function()
            local seconds = worldKnowledgeModule.nativeGameTime and worldKnowledgeModule.nativeGameTime()
            return seconds and seconds / 3600 or nil
        end,
        place = function() local where = currentDistrict(); return where and (where.area or where.district) or nil end,
        -- Ordinary gameplay: no fight, scene, call, vehicle or V as a replacer (battle-observer's read, once per check that has a change to make).
        world = function()
            local sample = battleObserver.sample(convaiPlayer())
            if sample.available ~= true then return 'unreadable' end
            if sample.combat then return 'combat' end
            if sample.blocked then
                return sample.vehicle and 'vehicle' or sample.call and 'call' or sample.sitting and 'v-seated' or 'scene'
            end
            return nil
        end,
        busy = function(row) return companions.outfitBusy(row.serial) end,
        standUp = function(row, hold) return companions.outfitStandUp(row.serial, hold) end,
        sitAgain = function(row, delay) return companions.outfitSitAgain(row.serial, delay) end,
        -- The game's own "could be seen" test, with the margins its reaction and vehicle code uses for it.
        frustum = function(npc) return Game.GetCameraSystem():IsInCameraFrustum(npc, 2.0, 0.75) end,
        -- A wall between V's eyes and her (the same line-of-sight test the invitation spot search uses): true hidden, false visible, nil cannot say.
        hidden = function(npc) return companions.hiddenFromPlayer(npc:GetWorldPosition()) end,
        angle = function(npc, who)
            local forward = Game.GetCameraSystem():GetActiveCameraForward()
            local a, b = who:GetWorldPosition(), npc:GetWorldPosition()
            local dx, dy, dz = b.x - a.x, b.y - a.y, b.z - a.z
            local length = math.sqrt(dx * dx + dy * dy + dz * dz)
            if length < 0.01 then return 0 end
            local dot = (dx * forward.x + dy * forward.y + dz * forward.z) / length
            return math.deg(math.acos(math.max(-1, math.min(1, dot))))
        end,
        log = log,
    }
    return convaiOutfits
end

function convaiOutfitTick(player, elapsed, ready)
    -- The character choices file is looked at every few seconds, but only for two hours after the editor was opened (mod/character-options.lua).
    local chosen = convaiCharacterOptions
    if chosen then chosen.tick(elapsed) end
    if not manager.companionOutfits() and not (chosen and chosen.hasOutfits()) then return end
    local module = convaiOutfitModule()
    if module then module.tick(player, elapsed, ready) end
end

-- ---- Eddies with characters (docs/EDDIES.md, mod/eddies.lua) ------------------------------------------------------------------------------
-- Built on the first private turn sent with the setting On; Off, a turn pays one boolean and the tick one nil check. Globals and one do-block:
-- the main chunk is near Lua's limit of locals.
convaiEddies = nil
do
    local failed = false
    local function service()
        if convaiEddies then return convaiEddies end
        if failed then return nil end
        local loaded, module = pcall(dofile, 'eddies.lua')
        local built, value = false, module
        if loaded and type(module) == 'table' and type(module.new) == 'function' then
            built, value = pcall(module.new, {
                enabled = function() return manager.characterEddies() end,
                ownCopy = function(entity, profileKey) return companions.ownCopy(entity, profileKey) end,
                player = function() return convaiPlayer() end,
                -- V's game clock stamps each ledger entry; a load from before an entry forgets it (the game took those eddies back).
                gameTime = function() return worldKnowledgeModule.nativeGameTime and worldKnowledgeModule.nativeGameTime() end,
                -- The transfer waits for the reply to be over and for V to be free: no reply due or playing, no fight, scene or choice, no pause,
                -- menu, text box or phone (Composer.reds ConvaiFrameFlags bits 8, 16, 32 and 64).
                busy = function(player)
                    if pending or speech.requestId ~= nil or subtitles.ownsUtterance() then return true end
                    local sample = battleSample
                    if type(sample) == 'table' and (sample.combat or sample.dialogue or sample.choices or (sample.tier ~= nil and sample.tier ~= 1)) then return true end
                    local ok, flags = pcall(function() return player:ConvaiFrameFlags() end)
                    return ok and type(flags) == 'number' and flags % 128 >= 8
                end,
                notice = function(player, text) convaiNotices.send(player, 'eddies-transfer', text) end,
                t = function(text, vars) return ui.t(text, vars) end,
                log = function(line) log(line) end,
            })
        end
        if not built then
            failed = true
            convaiLogOnce('eddies', 'Eddies with characters is unavailable: ' .. tostring(value))
            return nil
        end
        convaiEddies = value
        return value
    end
    -- A private turn to a named character (typed or spoken): its `eddies` block, while the setting is On (bridge/eddies.mjs parseEddies).
    function convaiEddiesAttach(context)
        if type(context) ~= 'table' or type(manager.characterEddies) ~= 'function' or not manager.characterEddies() then return end
        local eddies = service()
        if not eddies then return end
        local ok, block = pcall(eddies.block, context)
        if ok and block then context.eddies = block
        elseif not ok then convaiLogOnce('eddies-block', 'Eddies block failed: ' .. tostring(block)) end
    end
    -- From the 0.1 s tick: nothing unless a proposal is awaited or shown.
    function convaiEddiesTick(player)
        if not convaiEddies or not player or not convaiEddies.pending() then return end
        local ok, problem = pcall(convaiEddies.update, player)
        if not ok then convaiLogOnce('eddies-tick', 'Eddies update failed: ' .. tostring(problem)) end
    end
end

-- What a new copy is created in, what it was created in, and what it wears (for the talk context): the three hooks of companions.lua.
companions.spawnOutfit = function(record, key)
    local chosen = convaiCharacterOptions
    if not manager.companionOutfits() and not (chosen and chosen.hasOutfits()) then return nil end
    local module = convaiOutfitModule()
    return module and module.spawnAppearance(record, key) or nil
end
companions.outfitCreated = function(serial, key, record, name)
    if convaiOutfits then convaiOutfits.created(serial, key, record, name) end
end
companions.outfitForget = function(serial) if convaiOutfits then convaiOutfits.forget(serial) end end
companions.outfitStatus = function(serial) return convaiOutfits and convaiOutfits.status(serial) or nil end

-- The home outfit API for other features (docs/COMPANION_OUTFITS.md "Home outfit API"): convaiOutfitApi.setHome('judy-alvarez', true) puts that companion
-- in casual home clothes (where the character has them) the next time nobody is looking; false keeps them out of home clothes; nil goes back to following
-- whether V is in an apartment. Safe to call at any time, with the setting off too (it then only remembers the answer for the session).
convaiOutfitApi = {
    setHome = function(key, on) local module = convaiOutfitModule(); return module and module.setHome(key, on) or false end,
    isHome = function(key) local module = convaiOutfitModule(); if module then return module.isHome(key) end return nil end,
    hasHomeOutfit = function(record) local module = convaiOutfitModule(); return module ~= nil and module.hasHomeOutfit(record) end,
}
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
    -- Street reputation: the deeds still waiting are written now, behind the loading screen (a nil check while the setting is off).
    if convaiReputation then convaiReputationReset(reason) end
    -- Revenge ambushes: the grudge is written and every reference dropped, with no native call (the world may be going away).
    if convaiAmbush then pcall(convaiAmbush.reset, reason) end
    convaiAmbushSpeaker = nil
    -- The party's own handles, watched weakly through the collect at the end (world alive only, never on fast travel).
    local watch = (worldAlive == true and preserveTransit ~= true) and convaiWatchParty() or nil
    -- Development probe (mod/face-test.lua): its stage keeps a companion handle (and a look-at event aimed at V) between frames.
    local faceTest = convaiFacialPlayback and convaiFacialPlayback.faceTest
    if faceTest and type(faceTest.abandon) == 'function' then pcall(faceTest.abandon, reason) end
    cancelAutomatic(reason, true)
    battles.reset()
    loot.reset(); lootObserver.reset(); lastAutomatic, mergeSuppressedUntil = nil, 0
    battleSample, battlePeople, battlePoll = nil, {}, 0
    if tactics then tactics.abandon() end
    if marking then marking.abandon() end
    companions.abandon(preserveTransit==true)
    -- Immersive invitations: the references are dropped after the party's own, with no call into the game (mod/immersive-invitations.lua bind).
    if convaiImmersiveReset then convaiImmersiveReset(reason, preserveTransit == true) end
    -- Housemates: the registry is read again from the save that loads next; a fast travel keeps it (the bodies were deleted before it).
    if convaiHousemateReset then convaiHousemateReset(reason, preserveTransit == true) end
    if convaiSettleReset then convaiSettleReset(reason, preserveTransit == true) end
    -- A new session forgets which look each copy wears and any home answers; fast travel keeps them (the copies are made again in the same clothes).
    if convaiOutfits and preserveTransit ~= true then pcall(convaiOutfits.reset) end
    -- Another save: what the Flesh and Chrome reader watched belongs to the old one; a new baseline read follows once the world is ready (mod/vixen-state.lua).
    if preserveTransit ~= true then
        convaiVixenBaselineDue, convaiVixenBaselineAt = true, nil
        if convaiVixenState and type(convaiVixenState.reset) == 'function' then pcall(convaiVixenState.reset) end
    end
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
    convaiFocusKept = nil
    if convaiAddons and convaiAddons.live then pcall(convaiAddons.reset, reason) end
    if convaiHolocall then pcall(convaiHolocall.abandon, reason) end
    focusedCrowd, releasedCrowd = nil, nil
    if convaiVanillaReactions then pcall(convaiVanillaReactions.clear) end
    -- The last crosshair search's NPC handles (targetAtCrosshair, refreshed by the gaze every 0.2 s): the whole on-foot party
    -- and every NPC near V. Kept until the next search, so without this every one of them outlived the unload (18 Oct 09:10
    -- detach: Jackie's and Johnny's handles were still held after the collect).
    convaiTalkNative, convaiGazeGather = nil, nil
    if convaiSpawnedCharacters then convaiSpawnedCharacters:reset() end
    convaiStory = nil
    if convaiFacialPlayback then convaiFacialPlayback.storyEntity, convaiFacialPlayback.storyProjection = nil, nil end
    if convaiWorldTalk then convaiWorldTalk:reset() end
    if convaiNpcReactions then convaiNpcReactions.reset() end
    convaiHeadTalk = nil
    if convaiJohnnyHead then convaiJohnnyHead:reset() end
    if convaiSpeakUpReset then pcall(convaiSpeakUpReset, 'world-change') end
    if convaiJohnnyRemarks then convaiJohnnyRemarks:reset() end
    if convaiJohnnyPlaceReset then convaiJohnnyPlaceReset() end
    if convaiJohnnyRelic then convaiJohnnyRelic:reset() end
    convaiJohnnyFight = nil
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
    local initStart = os.clock()
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
    -- Music and TV: the song-change events, only with the switch on (convaiMediaSongInstall; with it off nothing is loaded or hooked).
    convaiGuarded('Media song hooks', convaiMediaSongInstall)
    -- Free look while V sits (docs/COMPANION_SEATING.md): one Observe pair on
    -- the player's Workspot state; widens the camera limits once per sit.
    local lookLoaded, lookResult, lookReason = pcall(function()
        convaiSeatedLookModule = dofile('seated-look.lua')
        return convaiSeatedLookModule.install({
            classify = dofile('companion-seating.lua').classify,
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
    -- Street reputation: its hooks only when the setting is on (docs/REPUTATION_DESIGN.md); off, nothing is loaded or registered. The same recorder feeds
    -- Revenge ambushes, so it also starts when only that setting is on (convaiDeedsWanted).
    if convaiDeedsWanted() then pcall(convaiReputationWanted) end
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
    -- Companions settle in V's flat (mod/companion-settle.lua): the game pushes a district change when V crosses into or out of a flat, and that
    -- is the one thing that wakes the module. Away from home the callback finds nothing to do.
    -- The housemates are woken by it too: their own hook (housemate-service.lua hookDistrict) is installed after onInit and is not relied on.
    -- With Housemates Off convaiHousemateWake is one global read.
    convaiGuarded('Settle district hook', function()
        ObserveAfter('PreventionSystem', 'OnDistrictAreaEntered', function()
            if not worldSuspended and convaiSettleWake then convaiSettleWake() end
            if not worldSuspended and convaiHousemateWake then convaiHousemateWake() end
        end)
    end)
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
            local current=convaiPlayer()
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
            convaiHeartbeat.loading = true
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
    convaiBoot.init = os.clock()
    log(string.format('Start-up: onInit ran in %.0f ms, %.1f s after init.lua began', (convaiBoot.init - initStart) * 1000, convaiBoot.init - convaiBoot.t0))
    -- Requests are one-shot commands. A CET reload must not replay a spawn or
    -- other game mutation left in the request file by an earlier session.
    local request = io.open('runtime/diagnostic-request.txt', 'rb')
    if request then
        lastDiagnosticRequest = request:read('*a')
        request:close()
    end
end)

-- The 120 s timeout of a fast travel whose loading screen never reported its end (called from onUpdate, once, when it expires): with V in
-- the world it finishes the travel the way the loading screen's end does, so the party recovers and the mod resumes; with V still gone it
-- drops the receipts and the attach hooks resume the mod. A global, so the onUpdate closure gains no upvalue and builds no closure.
convaiFastTravelExpired = function()
    local attached = false
    pcall(function() local player = convaiPlayer(); attached = player ~= nil and player:IsAttached() == true end)
    if attached then
        log('Fast travel completion did not arrive within 120 s: recovering the party and resuming')
        fastTravelActive.finished = true
        pcall(companions.fastTravel)
        worldSuspended = false
    else
        fastTravelActive=nil; abandonSession('fast travel timed out')
    end
end
-- onUpdate's native checks as plain functions that take what they read: a pcall(function() ... end) inside onUpdate built a
-- new closure (and boxed the locals it captured) on every frame. Globals, so the onUpdate closure gains no upvalue.
-- V attached, alive and past the main menu: true and the requests handler (the pause check reuses it), or false.
-- The frame's world facts come from ONE redscript call, ConvaiFrameFlags (Composer.reds), a bit mask: attached 1, dead 2, pre-game 4,
-- game paused 8, in a menu 16, composer open 32, phone open 64. That replaces about eleven native calls a frame (the session and
-- world checks and the phone read). Scripts without the method (an old install, a failed compile) keep the separate calls, tried
-- again after 1200 frames.
convaiSessionReady = function(player, suspended)
    if suspended or not player then return false end
    local state = convaiHeartbeat
    local flagsOk, flags
    if state.frame >= (state.flagsRetryAt or 0) then
        flagsOk, flags = pcall(convaiInvoke, player, 'ConvaiFrameFlags')
        if flagsOk and type(flags) == 'number' then
            state.flags, state.flagsFrame, state.menuFrame, state.menuValue = flags, state.frame, state.frame, flags % 32 >= 16
            -- Second result: the state table itself, which convaiWorldReady and the phone read recognise.
            return flags % 2 >= 1 and flags % 4 < 2 and flags % 8 < 4, state
        end
    end
    if not player:IsAttached() or player:IsDeadNoStatPool() then return false end
    local requests = Game.GetSystemRequestsHandler()
    -- The separate calls worked where the flags call did not: the method is missing.
    if flagsOk ~= nil then state.flagsRetryAt = state.frame + 1200 end
    return not requests:IsPreGame(), requests
end
-- The game runs, no menu is open and the composer is closed.
convaiWorldReady = function(requests, player)
    local state = convaiHeartbeat
    if requests == state then return state.flagsFrame == state.frame and state.flags % 64 < 8 end
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
    -- Start-up probe: when this frame began (until the first world frame; a global, so this closure gains no local or upvalue).
    if convaiBoot and not convaiBoot.reported then convaiBoot.top = os.clock() end
    convaiHeartbeat.frame = convaiHeartbeat.frame + 1
    -- Waiting probe.log lines go out within a second of the first (see log()); an empty buffer costs one field read.
    if convaiLog.n > 0 then convaiLogTick() end
    -- A completion that never arrived must neither keep a stale travel intent armed for a later unrelated load nor leave the mod
    -- suspended with the party's copies alive and uncontrolled. With V in the world the timeout finishes the travel the way the
    -- loading screen's end does (the party recovers on the next tick and the mod resumes); with V still gone the receipts are dropped
    -- and the attach hooks resume the mod.
    if fastTravelActive and not fastTravelActive.finished and os.time()-fastTravelActive.started>120 then convaiFastTravelExpired() end
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
    local menuPlayer = convaiPlayer()
    -- Each native call through CET costs the game thread; the world check below reuses this frame's answers.
    local sessionOk, sessionReady, requests = pcall(convaiSessionReady, menuPlayer, worldSuspended)
    if not sessionOk or not sessionReady then
        if sessionHasState then abandonSession('world unavailable',fastTravelActive~=nil) end
        if not knowledgeInvalidated then invalidateKnowledge('world unavailable') end
        -- No world (the main menu, a loading screen): the manager's page still has to answer its buttons here. The Settings page and the
        -- rest of the Mods screen work without a save; one quarter-second slow tick and a few comparisons, never in gameplay.
        local titleStart = os.clock()
        local titleOk, titleError = pcall(managerUi.update, nil, false)
        -- What the mod spent in the title and loading frames (reported with the first world frame, below): the count, the worst, the sum.
        local boot = convaiBoot
        if boot and not boot.reported then
            local finished = os.clock()
            local spent = finished - titleStart
            boot.frames, boot.total = boot.frames + 1, boot.total + spent
            if spent > boot.worst then boot.worst, boot.worstAt = spent, finished - boot.t0 end
            convaiBootFrame(boot, finished)
            -- Once, 45 s after onInit (the time the title screen waits for a key press): the same figures, so a player who quits there leaves them too.
            if not boot.interim and boot.init and finished - boot.init >= 45 then
                boot.interim = true
                log(string.format('Start-up: title screen 45 s after onInit, %d frames; %s', boot.frames, convaiBootGaps(boot)))
            end
        end
        if not titleOk and convaiHeartbeat.titleManagerError ~= tostring(titleError) then
            convaiHeartbeat.titleManagerError = tostring(titleError)
            log('Manager update failed without a world: ' .. tostring(titleError))
        end
        return
    end
    if fastTravelActive and fastTravelActive.finished then fastTravelActive=nil end
    local boot = convaiBoot
    if boot and not boot.reported then
        boot.reported = true
        log(string.format('Start-up: first world frame %.1f s after init.lua began (onInit at %.1f s); %d title frames, the mod used %.1f ms in them, worst %.2f ms at %.1f s; %s',
            os.clock() - boot.t0, (boot.init or boot.t0) - boot.t0, boot.frames, boot.total * 1000, boot.worst * 1000, boot.worstAt or 0, convaiBootGaps(boot)))
    end
    sessionHasState = true
    knowledgeAllowed, knowledgeInvalidated = true, false
    mark('init:knowledge')
    convaiHeartbeat.sessionProven = true
    local knowledgeOk = pcall(updateKnowledge, delta)
    convaiHeartbeat.sessionProven = false
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
    -- Only a recording that is still opening or running ends here; a spoken turn whose reply is pending (microphone state 'reply', or a group
    -- voice round past its recording) completes like a typed one and the reply plays when V is back.
    if not worldReady then
        gameplayActions.revoke('menu')
        local round = groupChat.round
        if (microphone.context ~= nil and microphone.state ~= 'reply') or (round and round.mode == 'voice' and round.stage == 'recording') then
            cancelVoice('menu')
        end
    end
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
    local phoneRead, phoneOpen
    if convaiHeartbeat.flagsFrame == convaiHeartbeat.frame then phoneRead, phoneOpen = true, convaiHeartbeat.flags % 128 >= 64
    else phoneRead, phoneOpen = pcall(convaiInvoke, menuPlayer, 'ConvaiPhoneIsOpen') end
    phoneOpen = phoneRead and phoneOpen == true
    -- The phone was just opened: the player's own characters are read again (rate-limited by the service; a character made a moment ago is in the Chat tab). Once per opening, on the edge.
    if phoneOpen ~= convaiPhoneWasOpen then
        convaiPhoneWasOpen = phoneOpen
        if phoneOpen and convaiCustomCharacters then pcall(convaiCustomCharacters.refresh) end
    end
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
    local chatOk, chatError = pcall(phoneChat.update, menuPlayer, delta, phoneOpen)
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
    -- Voice activation (Settings > Voices, off by default): one boolean while it is off; the module is not even loaded then.
    local vaOk, vaError = pcall(convaiVoiceActivationTick, player, elapsedPoll, worldReady)
    if not vaOk then convaiLogOnce('Voice activation failed: ' .. tostring(vaError)) end
    -- Speak dialogue choices (Settings > Gameplay, off by default): one boolean per tick while it is off; the module is not even loaded then.
    local vcOk, vcError = pcall(convaiVoiceChoicesTick)
    if not vcOk then convaiLogOnce('Speak dialogue choices failed: ' .. tostring(vcError)) end
    -- Developer mode: the next two features (keys, outfits) are their own 'init:features' row in perf-probe.json, the rest of the tick goes back to 'init:tick'.
    mark('init:features')
    -- The mod's own key bindings (Companion Manager > Key bindings): one table check per tick while none is saved; the module is not even loaded then.
    local keysOk, keysError = pcall(convaiKeyBindsTick, player, worldReady)
    if not keysOk then convaiLogOnce('Key bindings failed: ' .. tostring(keysError)) end
    -- Companions change outfits (Settings > Gameplay, off by default): one boolean per tick while it is off; the module is not even loaded then.
    local outfitOk, outfitError = pcall(convaiOutfitTick, player, elapsedPoll, worldReady)
    if not outfitOk then convaiLogOnce('Companion outfits failed: ' .. tostring(outfitError)) end
    -- Revenge ambushes (Settings > Gameplay, off by default): one boolean per tick while it is off; the module is not even loaded then.
    local ambushOk, ambushError = pcall(convaiAmbushTick, player, elapsedPoll, worldReady)
    if not ambushOk then convaiLogOnce('ambush-tick', 'Revenge ambushes failed: ' .. tostring(ambushError)) end
    -- Eddies with characters (off by default): one nil check per tick unless a proposal is awaited or its pop-up is open.
    if convaiEddies and worldReady then convaiEddiesTick(player) end
    mark('init:tick')
    -- The talk key's microphone lingers after a voice turn unless the game is busy: a clock compare per tick.
    local warmOk, warmError = pcall(convaiMicLingerTick, player, worldReady)
    if not warmOk then convaiLogOnce('Microphone linger check failed: ' .. tostring(warmError)) end
    if voiceSubmission then acceptVoiceSubmission(voiceSubmission) end
    if not player then
        abandonSession('world unavailable during update')
        return
    end
    if not phoneCatalogReady then
        -- A player without this mod's phone methods (the scripts did not compile) fails this on every tick, and the failure line
        -- used to be a file write ten times a second: it is retried on every tick as before, and logged once until it succeeds.
        local ok, err = pcall(companions.registerPhoneContacts, player)
        -- false: no phone methods at all (the scripts did not compile); the setup check reports it, so stop here quietly.
        if ok and err == false then
            phoneCatalogReady = true
        elseif ok then
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
    if worldReady then
        mark('init:homes')
        local immersiveOk, immersiveError = pcall(convaiImmersiveTick, elapsedPoll)
        if not immersiveOk then convaiLogOnce('immersive-tick', 'Immersive invitations failed: ' .. tostring(immersiveError)) end
        local housemateOk, housemateError = pcall(convaiHousemateTick, elapsedPoll)
        if not housemateOk then convaiLogOnce('housemate-tick', 'Housemates failed: ' .. tostring(housemateError)) end
        mark('init:tick')
    end
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
    elseif convaiAddons and convaiAddons.noticePending then
        -- No add-on registered: one check at the first gameplay tick for an add-on or content pack the bridge could not load (mod/addons.lua idleTick).
        pcall(convaiAddons.idleTick, player, worldReady)
    end
    -- A "get down" or a cower keeps the focus on its person past the talk (convaiFocusKept: options.keepFocus above).
    if focusUntil and not active and not pending and not speech.requestId and os.time() >= focusUntil
        and not (convaiFocusKept and convaiFocusKept.crowd == focusedCrowd and os.time() < convaiFocusKept.untilAt) then
        endFocus(player)
        if convaiBarkEnd then convaiBarkEnd(true) end
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
        -- With the native plugin an unchanged reply.json (its revision, one number) is not opened again: the text of the last read is
        -- checked against this turn, so a reply that could not be delivered yet (reactionCanDeliver) is still picked up on a later tick.
        -- The file is read again at least once a second; without the plugin (no revision) every tick reads as before. The fields live
        -- on the global heartbeat table, so onUpdate gains no upvalue.
        local raw = nil
        local revision = convaiNative and convaiNative.revision and convaiNative.revision('reply.json') or nil
        local clock = os.clock()
        if revision and revision > 0 and revision == convaiHeartbeat.replyReadRevision and replyRaw
            and clock >= convaiHeartbeat.replyReadAt and clock - convaiHeartbeat.replyReadAt < 1 then
            raw = replyRaw
        else
            local replyFile = io.open('runtime/reply.json', 'rb')
            if replyFile then
                raw = replyFile:read('*a')
                replyFile:close()
                convaiHeartbeat.replyReadRevision, convaiHeartbeat.replyReadAt = revision, clock
            end
        end
        if raw then
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
                        -- An add-on speaker's turn (docs/ADDON_API.md): no Mistral key or Local AI pack (one notice), or a remark
                        -- that repeated a recent line (silent). The add-on file decides; nothing else is shown.
                        if type(reply.errorCode) == 'string' and reply.errorCode:find('^addon%-') then
                            if convaiAddons and convaiAddons.live then convaiAddons.replyError(pending, reply, player) end
                        elseif keyId == 'key-memory' then convaiNotices.send(player, 'key-memory', keyText)
                        -- The daily allowance: a turn V asked for says so once; an automatic reaction just stops.
                        elseif keyId == 'daily-limit' then
                            if not pending.reaction then convaiNotices.send(player, 'daily-limit', keyText) end
                        -- Convai sign-in failed: the same rule.
                        elseif keyId == 'convai-unavailable' then
                            if not pending.reaction then convaiNotices.send(player, 'convai-unavailable', keyText) end
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
                        -- Google Gemini failures: the same rule.
                        elseif keyId == 'gemini-key' then
                            if not pending.reaction then convaiNotices.send(player, 'gemini-key', keyText) end
                        elseif keyId == 'gemini-daily' then
                            if not pending.reaction then convaiNotices.send(player, 'gemini-daily', keyText) end
                        elseif keyId == 'gemini-limit' then
                            if not pending.reaction then convaiNotices.send(player, 'gemini-limit', keyText) end
                        elseif keyId == 'gemini-region' then
                            if not pending.reaction then convaiNotices.send(player, 'gemini-region', keyText) end
                        elseif keyId == 'gemini-server' then
                            if not pending.reaction then convaiNotices.send(player, 'gemini-server', keyText) end
                        elseif keyId == 'gemini-unreachable' then
                            if not pending.reaction then convaiNotices.send(player, 'gemini-unreachable', keyText) end
                        elseif keyId == 'gemini-model' then
                            if not pending.reaction then convaiNotices.send(player, 'gemini-model', keyText) end
                        -- The browser for the conversation page would not start: the same rule, with the browser named.
                        elseif keyId == 'browser-failed' then
                            if not pending.reaction then convaiNotices.send(player, 'browser-failed', keyText) end
                        -- A local turn failed and nothing took it over: the same rule, its own notice.
                        elseif keyId == 'local-failed' then
                            if not pending.reaction then convaiNotices.send(player, 'local-failed', keyText) end
                        -- The player's own model server only thinks, or has too small a context: the same rule, its own notices.
                        elseif keyId == 'local-thinking' then
                            if not pending.reaction then convaiNotices.send(player, 'local-thinking', keyText) end
                        elseif keyId == 'local-context' then
                            if not pending.reaction then convaiNotices.send(player, 'local-context', keyText) end
                        -- Local AI could not start and the turn failed: the same rule, with Local AI's own reason.
                        elseif keyId == 'local-unavailable' then
                            if not pending.reaction then convaiNotices.send(player, 'local-unavailable', keyText) end
                        elseif keyId == 'local-no-memory' then
                            if not pending.reaction then convaiNotices.send(player, 'local-no-memory', keyText) end
                        elseif keyId == 'mistral-no-key' or keyId == 'mistral-voice' or keyId == 'custom-no-setup' or keyId == 'custom-voice' or keyId == 'gemini-no-key' or keyId == 'gemini-voice' or keyId == 'local-restarted' or keyId == 'local-cpu' or keyId == 'local-gpu' or keyId == 'local-offload' or keyId == 'local-stepdown' or keyId == 'vision-border' or keyId == 'vision-local-no-model' or keyId == 'vision-local-no-file' or keyId == 'vision-custom-no-images' then
                            sendProviderNotice(player, keyId, keyText)
                            if not pending.reaction then convaiNotices.send(player, 'reply-error', replyErrorText(reply)) end
                        -- A plan limit or a refused key: a turn V asked for says so; an automatic reaction (battle, loot) just stops.
                        elseif keyId then
                            if not pending.reaction then convaiNotices.send(player, 'quota-exhausted', keyText) end
                        elseif not pending.reaction then convaiNotices.send(player, 'reply-error', replyErrorText(reply)) end
                    else
                        -- The first reply that runs without memory on a limited plan says so once.
                        local keyId, keyText = keyReplyNotice(reply)
                        if keyId == 'key-memory' then convaiNotices.send(player, 'key-memory', keyText) end
                        sendProviderNotice(player, keyId, keyText)
                        -- An add-on remark's text goes to its remarkStarted event (docs/ADDON_API.md): one table write, no native call.
                        if pending.reaction and pending.reaction.kind == 'addon' and convaiAddons and convaiAddons.live then
                            pcall(convaiAddons.replyText, pending, reply.text)
                        end
                        -- A housemate's chat line: its text is the next speaker's context (mod/housemate-chat.lua).
                        if pending.reaction and pending.reaction.kind == 'house' and convaiHouseReplyText then
                            pcall(convaiHouseReplyText, pending, reply.text)
                        end
                        -- A party round's line (the group speak-up): its text is the next speaker's context.
                        if pending.reaction and pending.reaction.kind == 'speakup' and pending.reaction.event == 'party' and convaiPartyReplyText then
                            pcall(convaiPartyReplyText, pending, reply.text)
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
                    -- Dark Future's state in this turn (the bridge's probe line: what the game side found, the switch, whether V's words asked about themself, where the
                    -- state went), next to the result so one grep shows the whole story. Absent unless the game side found Dark Future.
                    if type(reply.df) == 'string' and reply.df:sub(1, 4) == 'df: ' and #reply.df <= 320 and not pending.reaction then log(reply.df) end
                    for _, key in ipairs({'fac', 'inj'}) do
                        local line = reply[key]
                        if type(line) == 'string' and line:sub(1, #key + 2) == key .. ': ' and #line <= 320 and not pending.reaction then log(line) end
                    end
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
    -- A reaction an ordinary NPC is waiting to start once its reply has been heard (one nil check while none waits).
    if convaiNpcReactions then convaiNpcReactions.update() end
    -- A typed line handed to the service: whether the service took it (one nil check while none waits).
    if convaiTalkReceipt then pcall(convaiTalkReceiptTick) end
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
                if sent then
                    -- A few seconds from now one probe line says whether the service took it (convaiTalkReceiptTick).
                    convaiTalkReceipt = {requestId = context.requestId, generation = context.generation, at = os.clock()}
                    if convaiTalkFallbackGeneration == context.generation then
                        log('Talk fallback: request handed to the service: generation=' .. context.generation)
                    end
                end
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
    if convaiReputation then convaiReputationReset('shutdown') end
    if convaiAmbush then pcall(convaiAmbush.reset, 'shutdown') end
    cancelAutomatic('shutdown')
    battles.reset()
    loot.reset(); lootObserver.reset(); lastAutomatic, mergeSuppressedUntil = nil, 0
    battleSample, battlePeople = nil, {}
    phoneChat.abandon()
    if convaiHolocall then
        if liveWorld then pcall(convaiHolocall.finish, convaiPlayer(), 'shutdown') else pcall(convaiHolocall.abandon, 'shutdown') end
    end
    managerUi.shutdown(liveWorld)
    groupChat.cancel()
    warmConversation(nil, nil)
    if autoConnect then pcall(autoConnect.reset) end
    microphone.cancel()
    if convaiVoiceActivation then pcall(convaiVoiceActivation.off) end
    if convaiKeyBinds then pcall(convaiKeyBinds.stop, liveWorld and convaiPlayer() or nil) end
    if liveWorld then speech.stop('shutdown'); subtitles.clear()
    else speech.abandon(); subtitles.abandon() end
    active = nil
    if liveWorld then companions.dismissAll() else companions.abandon() end
    if liveWorld then pcall(companions.destroyPartyCars) end -- overflow party cars: no update runs again to remove them
    local player = liveWorld and convaiPlayer() or nil
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

pcall(function()
    -- Title-frame stall probe. Per title frame (no world yet): the wait between the end of the previous onUpdate and the start of this one is time the
    -- game, CET, other mods or the machine spent (a frame that did not come: a Space press in it is late); the mod's own part is the onUpdate
    -- itself, start to end of the title branch. A stall with a small own part is not this mod's Lua. Two os.clock reads a frame, no allocation but the
    -- rare (at most six) entry of a stall of 250 ms or more.
    convaiBootFrame = function(boot, finished)
        local top = boot.top
        if not top then return end
        local last = boot.last
        boot.last = finished
        if boot.cut then return end
        if last then
            local gap = top - last
            -- A freeze of 3 s or more is a save loading (or a real stall): the figures stop there, and it is named once with the mod's part of that frame.
            if gap >= 3 then boot.cut = string.format('first freeze of 3 s or more: %.0f ms at %.1f s (began %s UTC), own part of that frame %.1f ms', gap * 1000, top - boot.t0, os.date('!%H:%M:%S', os.time() - math.floor(gap)), (finished - top) * 1000); return end
            if gap > boot.gapWorst then boot.gapWorst, boot.gapWorstAt = gap, top - boot.t0 end
            if gap >= 0.1 then
                boot.slow, boot.slowSum = boot.slow + 1, boot.slowSum + gap
                -- The wall-clock second the gap began (UTC, the clock of probe.log and of the service's [Timeline] lines), so a stall can be lined up with what the service did.
                local began = os.time() - math.floor(gap)
                if gap >= boot.gapWorst then boot.gapWorstWall = began end
                if gap >= 0.25 and #boot.big < 6 then boot.big[#boot.big + 1] = string.format('%.1f+%.0f@%s', top - boot.t0, gap * 1000, os.date('!%H:%M:%S', began)) end
            end
        end
        local own = finished - top
        boot.ownTotal = boot.ownTotal + own
        if own > boot.ownWorst then boot.ownWorst = own end
    end
    -- The stall figures as one tail for a Start-up line: gaps of 100 ms or more (count, their total, the worst and when), the stalls of 250 ms or
    -- more as seconds-since-init.lua-began + milliseconds, and the mod's whole onUpdate in those frames (total, worst).
    convaiBootGaps = function(boot)
        local worstWall = boot.gapWorstWall and os.date('!%H:%M:%S', boot.gapWorstWall) or '-'
        return string.format('frame gaps over 100 ms: %d (%.0f ms in all), worst %.0f ms at %.1f s (began %s UTC), over 250 ms at [%s]; own whole title onUpdate %.1f ms, worst %.2f ms; %s',
            boot.slow, boot.slowSum * 1000, boot.gapWorst * 1000, boot.gapWorstAt or 0, worstWall, table.concat(boot.big, ' '), boot.ownTotal * 1000, boot.ownWorst * 1000,
            boot.cut or 'no freeze of 3 s or more yet')
    end
end)
convaiBoot.loaded = os.clock()
log(string.format('Start-up: init.lua loaded in %.0f ms', (convaiBoot.loaded - convaiBoot.t0) * 1000))

-- GetMod('AiNpcCyberpunkMod') returns this table to other CET mods. `addons` is the add-on API (docs/ADDON_API.md).
return {addons = convaiAddons and convaiAddons.public or nil}
