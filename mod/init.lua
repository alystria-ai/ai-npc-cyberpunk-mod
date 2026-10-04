-- Cyberpunk Convai game adapter. It never renders an ImGui text field.
-- Owns native composers, targeted turns, party connections and live diagnostics.
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
local companions = dofile('companions.lua')
local movementLog = dofile('movement-log.lua')
local subtitles = dofile('subtitles.lua')
local speech = dofile('speech.lua')
local microphone = dofile('microphone.lua')
local characterCatalog = dofile('character-catalog.lua')
local groupChat = dofile('group-chat.lua')
groupChat.captureReply = speech.transcript
local manager = dofile('manager.lua')
local mcm = dofile('mcm.lua')
local phoneLayout = dofile('phone-layout.lua')
local phoneChatStyle = dofile('phone-chat-style.lua')
local phoneChat = dofile('phone-chat.lua')
local questContext = dofile('quest-context.lua')
local battleObserver = dofile('battle-observer.lua')
local battles = dofile('battle-reactions.lua').new()
convaiBattleReactions = battles
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
    if not force and signature == worldSessionSignature and worldSessionAt == now then return end
    local encoded, raw = pcall(json.encode, value); if not encoded then return end
    local path = 'runtime/world-session.json'
    local file = io.open(path .. '.tmp', 'wb'); if not file then return end
    local written, closed = file:write(raw), file:close(); if not written or not closed then return end
    if not os.rename(path .. '.tmp', path) then os.remove(path); if not os.rename(path .. '.tmp', path) then return end end
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

gameplayActions = dofile('gameplay-actions.lua').new({
    world = function()
        return {ready = knowledgeAllowed and knowledgeFrame ~= nil and knowledgeFrame.status == 'ready',
            worldToken = knowledgeFrame and knowledgeFrame.worldToken,
            generation = knowledgeFrame and knowledgeFrame.generation}
    end,
    offer = function(entity) return companions.chauffeurOffer(entity) end,
    queue = function(serial, offer, entity) return companions.queueChauffeur(serial, offer, entity) end,
    developerMode = manager.developerMode,
    feedback = function(state, reason)
        local player = Game.GetPlayer()
        if player then player:ConvaiPhoneFeedback(ui.t(reason or (state == 'queued'
            and 'Your companion is preparing to drive.' or 'The driving request could not be queued.'))) end
    end})
convaiGameplayActions = gameplayActions
microphone.captureActions = function(context) return gameplayActions.capture(context, 'private-voice') end

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
local function followUpQuestions()
    return type(manager.followUpQuestions) == 'function' and manager.followUpQuestions() == true
end
groupChat.captureFollowUpQuestions = followUpQuestions
microphone.captureFollowUpQuestions = followUpQuestions
phoneChat.captureJournal = questContext.capture
microphone.captureJournal = questContext.capture
groupChat.captureBattle = battles.capture
phoneChat.captureBattle = battles.capture
microphone.captureBattle = battles.capture
convaiPhoneChat = phoneChat
convaiGroupChat = groupChat
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
manager.configure(companions, profiles)
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
mcm.configure(manager, companions, dofile('manager-party.lua'), dofile('mcm-entry.lua'), invitations)
convaiManager = mcm
local catalog = characterCatalog.build(profiles)
for record, profile in pairs(characterCatalog.build(profiles).records) do
    local ok, id = pcall(function() return tostring(TweakDBID.new(record)) end)
    if ok then catalog.records[id] = profile end
end
convaiCompanions = companions
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
local lastPhoneInvitation = nil
local automatic, battleSample, battlePeople, battlePoll = nil, nil, {}, 0
local lastAutomatic = nil
local cancelAutomatic = function() end
local phoneCatalogReady = false
local function profileEnabled(player, key)
    return manager.profileEnabled(key)
end

local function profileIdentity(npc)
    local managedKey, managedName, owned = companions.identity(npc)
    local name = managedName or tostring(npc:GetTweakDBFullDisplayName(true) or 'NPC')
    local body = tostring(npc:GetBodyType() or '')
    if owned and not managedKey then return nil, name, body end
    local recordOk, record = pcall(function() return tostring(npc:GetRecordID()) end)
    local crowdOk, crowd = pcall(function() return npc:IsCrowd() end)
    local key, canonical = characterCatalog.resolve(catalog, {managedKey = managedKey, name = name,
        bodyType = body, record = recordOk and record or '', crowd = crowdOk and crowd})
    return key, canonical, body
end

local function warmConversation(participants, key)
    local f = io.open('runtime/conversation-prewarm.json.tmp', 'wb')
    if not f then return end
    local hint = '{}'
    if key then
        local audience = {}
        if participants then
            for _, person in ipairs(participants) do audience[#audience + 1] = person.profileKey end
        else audience[1] = key end
        hint = json.encode({nonce = 'composer-' .. tostring(os.time()) .. '-' .. tostring(generation),
            audience = audience, group = participants ~= nil})
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
    local best, bestScore = nil, math.huge
    for _, npc in ipairs(candidates) do
        local valid, score = pcall(function()
            if not npc:IsNPC() or not npc:IsAttached() or npc:IsDeadNoStatPool() then return nil end
            local id = tostring(npc:GetEntityID().hash)
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
            elseif onFoot[id] then
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
            local pointScore = math.huge
            for _, point in ipairs(points) do
                local dx, dy, dz = point.x - playerPos.x, point.y - playerPos.y, point.z - playerPos.z
                local distance = math.sqrt(dx^2 + dy^2 + dz^2)
                if distance >= 0.1 and distance <= 8.0 and forwardLength >= 0.1 then
                    local cosine = (dx * forward.x + dy * forward.y + dz * forward.z) / (distance * forwardLength)
                    cosine = math.max(-1.0, math.min(1.0, cosine))
                    local angle = math.deg(math.acos(cosine))
                    if not onFoot[id] and lookedOk and looked and npc == looked then angle = 0.0 end
                    local value = angle / 32.0 + distance / 8.0
                    if angle <= 32.0 and value < pointScore and value < bestScore
                        and (not onFoot[id] or companions.visibleFromCrosshair(playerPos, point)) then
                        pointScore = value
                    end
                end
            end
            return pointScore < math.huge and pointScore or nil
        end)
        if valid and score and score < bestScore then best, bestScore = npc, score end
    end
    if not best then return nil, 'Face a nearby NPC within eight metres' end
    return best, nil
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
end

local function beginFocus(player, npc)
    endFocus(player)
    -- Owned companions arbitrate attention against locomotion themselves.
    -- The civilian path can add a second hold/turn independently of that state.
    if companions.owns(npc) then return true end
    local ok, focused = pcall(function() return player:ConvaiBeginFocus(npc) end)
    if not ok or not focused then return false, tostring(focused) end
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
    gazePoll = gazePoll + elapsed
    if gazePoll < 0.2 then return end
    local step = gazePoll
    gazePoll = 0
    local canFocus = gameplayCanAcquire(player)
    local npc, identity
    if canFocus then
        local found, result = pcall(targetAtCrosshair)
        if found and result then
            local key = profileIdentity(result)
            if manager.profileEnabled(key) then
                npc = result
                identity = tostring(result:GetEntityID().hash)
            end
        end
    end
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

local function selectConversation(player, groupMode, singleAction)
    local npc, reason = targetAtCrosshair()
    local candidates = groupMode and companions.conversationCandidates(player, 8) or {}
    if groupMode then
        local enabled = {}
        for _, candidate in ipairs(candidates) do
            if profileEnabled(player, candidate.profileKey) then enabled[#enabled + 1] = candidate end
        end
        candidates = enabled
    end
    if not npc and groupMode and candidates[1] then npc = candidates[1].npc end
    if not npc then player:ConvaiPhoneFeedback(ui.t(reason)); return nil end
    local key, name, bodyType = profileIdentity(npc)
    if not key or not supportedProfiles[key] then
        player:ConvaiPhoneFeedback(ui.t('{name} does not have a conversation profile configured yet.',{name=name}))
        log('Conversation unavailable: profile=' .. tostring(key))
        return nil
    end
    if not profileEnabled(player, key) then log('Companion disabled in manager: ' .. name); return nil end
    local primary = {npc = npc, name = name, entity = tostring(npc:GetEntityID().hash), bodyType = bodyType, profileKey = key}
    local participants = groupMode and groupChat.choose(primary, candidates, supportedProfiles) or nil
    if participants and #participants < 2 then
        local shortcut = ui.boundKey(singleAction)
        player:ConvaiPhoneFeedback(shortcut
            and ui.t('Group chat needs two characters nearby. Use {key} for one person.', {key = shortcut})
            or ui.t('Group chat needs two characters nearby. Use private chat for one person.'))
        return nil
    end
    return primary, participants
end

local function voiceTargetValid(npc, context)
    local player = Game.GetPlayer()
    if not npc or not player or tostring(npc:GetEntityID().hash) ~= context.entity
        or not npc:IsAttached() or npc:IsDeadNoStatPool() then return false end
    local pos, origin = npc:GetWorldPosition(), player:GetWorldPosition()
    return (pos.x - origin.x)^2 + (pos.y - origin.y)^2 + (pos.z - origin.z)^2 <= 144
end

microphone.onCancelled = function(context, reason)
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

local function acceptVoiceSubmission(context)
    if not context then return false end
    if context.group and not groupChat.voiceSubmitted(context) then
        microphone.cancel('stale-group'); return false
    end
    pending, pendingKnowledgeOwner = context, microphone.knowledgeOwner
    pending.sentAt, focusUntil = os.time(), os.time() + 90
    return true
end

local function beginText(groupMode)
    local ok, err = pcall(function()
        local player = Game.GetPlayer()
        if not player or not gameplayCanAcquire(player) then return end
        local primary, participants = selectConversation(player, groupMode, 'cyberpunk_convai_text')
        if not primary then return end
        local npc, key, name, bodyType, identity = primary.npc, primary.profileKey, primary.name, primary.bodyType, primary.entity
        generation = generation + 1
        if not player:ConvaiOpenComposer(name) then
            log('Native composer unavailable (check redscript and Codeware)')
            return
        end
        cancelAutomatic('manual-text')
        gameplayActions.revoke('new-conversation')
        speech.stop('new-conversation')
        microphone.cancel()
        groupChat.cancel()
        subtitles.clear()
        speech.target = npc
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
            profileKey = key, participants = participants}
        warmConversation(participants, key)
        pending = nil
        log('Composer opened: generation=' .. generation .. ' actor=' .. identity .. ' name=' .. name)
    end)
    if not ok then log('Open failed: ' .. tostring(err)) end
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
                player:ConvaiPhoneFeedback(shortcut
                    and ui.t('Use {key} to finish this recording.', {key = shortcut})
                    or (recordingMode == 'group'
                        and ui.t('Press your Group voice chat shortcut to finish recording.')
                        or ui.t('Press your Talk by voice shortcut to finish recording.')))
                return
            end
            if not gameplayCanAcquire(player) or (microphone.targetValid and not microphone.targetValid(microphone.context)) then
                cancelVoice('microphone-unavailable'); return
            end
            if microphone.state ~= 'reply' then acceptVoiceSubmission(microphone.finish(mode)) end
            return
        end
        if not gameplayCanAcquire(player) then return end
        local primary, participants = selectConversation(player, groupMode, 'cyberpunk_convai_voice')
        if not primary then return end
        local npc, key, name, body, entity = primary.npc, primary.profileKey, primary.name, primary.bodyType, primary.entity
        generation = generation + 1
        cancelAutomatic('microphone')
        gameplayActions.revoke('new-conversation')
        microphone.cancel('new-conversation')
        groupChat.cancel()
        warmConversation(participants, key)
        speech.stop('microphone'); subtitles.clear()
        speech.target = npc
        local context
        if groupMode then
            context = groupChat.startVoice('group-' .. tostring(os.time()) .. '-' .. tostring(generation), participants, generation, os.time())
        else
            context = {generation = generation, entity = entity, name = name, bodyType = body,
                profileKey = key, text = '[Microphone]', sentAt = os.time()}
            context.requestId = tostring(os.time()) .. '-' .. tostring(generation) .. '-' .. entity
        end
        active, pending, pendingKnowledgeOwner = nil, nil, nil
        if microphone.begin(context, function() return voiceTargetValid(npc, context) end) then
            beginFocus(player, npc)
            focusMode, focusEntity, focusUntil = 'chat', entity, os.time() + 120
            player:ConvaiPhoneFeedback(ui.t('Connecting microphone - wait for Listening'))
        else
            groupChat.cancel(); warmConversation(nil, nil)
        end
    end)
    if not ok then cancelVoice('microphone-error'); groupChat.cancel(); log('Microphone failed: ' .. tostring(err)) end
end

local function sendRequest(context)
    if context.reaction then context.followUpQuestions = false
    elseif context.followUpQuestions == nil then context.followUpQuestions = followUpQuestions() end
    local owner = attachKnowledge(context)
    if not owner then return false end
    context.journal = context.journal or questContext.capture()
    -- Automatic turns have one subject. Manual conversations may still discuss
    -- recent combat and pickups together when V asks about them.
    if context.reaction and context.reaction.kind == 'loot' then context.battle = nil
    else context.battle = context.battle or battles.capture() end
    local current = knowledgeOwner(refreshKnowledgeFrame())
    if not knowledgeAllowed or current.paused or not sameKnowledgeOwner(owner, current) then return false end
    if not context.group and not context.reaction then gameplayActions.capture(context, 'private-text') end
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
        if accepted then log('World loot collected: ' .. item.record .. ' quantity=' .. item.quantity)
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
    local battleEvent = battles.offer(busy, battlePeople, now)
    local lootEvent = loot.offer(busy, battlePeople, now)
    if not mayFollow(battleEvent, 'battle') then battleEvent = nil end
    if not mayFollow(lootEvent, 'loot') then lootEvent = nil end
    -- Closing has the shorter admission window and normally goes first. Once
    -- a battle closing has had a turn, an eligible pickup gets the next turn.
    -- Neither event changes the other policy's receipts or cooldowns.
    local event
    if battleEvent and lootEvent and lastAutomatic and lastAutomatic.kind == 'battle'
        and lastAutomatic.phase == 'end' then event = lootEvent
    else event = battleEvent or lootEvent end
    if event == battleEvent and event then
        event.reaction = {kind = 'battle', encounter = event.encounter, phase = event.phase, expiresAt = event.expiresAt}
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
        else claimed = battles.claim(event) end
        if not claimed then cancelAutomatic('claim-failed'); return end
        speech.target = person.npc
        lastAutomatic = {at = now, requestId = context.requestId, kind = event.reaction.kind,
            phase = event.phase, encounter = event.encounter}
        log('Automatic ' .. event.reaction.kind .. ' reaction: ' .. tostring(event.phase or 'batch') .. ' speaker=' .. person.profileKey)
    else cancelAutomatic('request-write-failed') end
end

local function reactionCanDeliver(context, player)
    if not context.reaction then return true end
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
    beginFocus(player, actor)
    focusMode, focusEntity = 'chat', context.entity
    if not sendRequest(context) then groupChat.cancel(); log('Group request could not be written') end
end

local function captureDiagnostic()
    local ok, err = pcall(dofile, 'diagnostics.lua')
    if not ok then log('Diagnostic capture failed: ' .. tostring(err)) end
end

local function captureNpcDiagnostic()
    -- The diagnostic hotkey must not repeat the previous remote command.
    local nonce = 'npc-diagnostic:' .. tostring(os.time()) .. ':' .. tostring(os.clock())
    local request = io.open('runtime/diagnostic-request.txt', 'wb')
    if not request then
        log('NPC diagnostic request could not be written')
        return
    end
    request:write(nonce)
    request:close()
    lastDiagnosticRequest = nonce
    captureDiagnostic()
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
        player:ConvaiPhoneFeedback(reason)
        return
    end
    if join then
        local accepted, message = queue.invite(key)
        log(accepted and ('Phone preparation requested for ' .. key)
            or ('Phone join failed for ' .. key .. ': ' .. tostring(message)))
        if accepted then
            local party = queue.list()
            for index = #party, 1, -1 do
                if party[index].key == key and not party[index].serial then
                    lastPhoneInvitation = {id = party[index].id}
                    break
                end
            end
        end
        player:ConvaiPhoneFeedback(tostring(message))
        return
    end
    local party = queue.list()
    for index = #party, 1, -1 do
        if party[index].key == key then
            local accepted, message = queue.dismiss(party[index].id)
            if lastPhoneInvitation and lastPhoneInvitation.id == party[index].id then lastPhoneInvitation = nil end
            log('Phone dismissal requested for ' .. key)
            player:ConvaiPhoneFeedback(tostring(message))
            return
        end
    end
    log('Phone dismiss: no active copy of ' .. key)
    player:ConvaiPhoneFeedback(ui.t('{name} is not in your group.',{name=name}))
end

local function updatePhoneInvitationFeedback(player)
    if not lastPhoneInvitation then return end
    local queue = mcm.party and mcm.party()
    if not queue then return end
    for _, member in ipairs(queue.list()) do
        if member.id == lastPhoneInvitation.id then
            if member.state == lastPhoneInvitation.state and lastPhoneInvitation.localeRevision == ui.revision() then return end
            lastPhoneInvitation.state, lastPhoneInvitation.localeRevision = member.state, ui.revision()
            local message = ui.t('{name}: preparing memory...',{name=member.name})
            if member.state == 'connecting' then message = ui.t('{name}: connecting...',{name=member.name})
            elseif member.state == 'ready-to-join' then message = ui.t('{name} is ready. Close the phone to join.',{name=member.name})
            elseif member.state == 'failed' then message = ui.t('{name}: preparation failed. Cancel and invite again.',{name=member.name}) end
            if member.state == 'failed' and queue.claimPreparationFailure
                and not queue.claimPreparationFailure(member.id, member.revision) then return end
            pcall(function() player:ConvaiPhoneFeedback(message) end)
            return
        end
    end
    lastPhoneInvitation = nil
end

registerHotkey('cyberpunk_convai_text', 'Cyberpunk Convai: talk by text', function() beginText(false) end)
registerHotkey('cyberpunk_convai_group_text', 'Cyberpunk Convai: group text chat', function() beginText(true) end)
registerHotkey('cyberpunk_convai_voice', 'Cyberpunk Convai: talk by voice', function() toggleVoice(false) end)
registerHotkey('cyberpunk_convai_group_voice', 'Cyberpunk Convai: group voice chat', function() toggleVoice(true) end)
registerHotkey('cyberpunk_convai_diagnostic', 'Cyberpunk Convai: capture NPC diagnostic', captureNpcDiagnostic)
registerHotkey('cyberpunk_convai_manager', 'Cyberpunk Convai: companion manager', openManager)

local worldSuspended, sessionHasState = false, false
local fastTravelActive

local function abandonSession(reason,preserveTransit)
    -- Never touch NPC/player components during native world destruction.
    -- pcall cannot catch an access violation in an already unloaded component.
    invalidateKnowledge(reason)
    cancelAutomatic(reason, true)
    battles.reset()
    loot.reset(); lootObserver.reset(); lastAutomatic = nil
    battleSample, battlePeople, battlePoll = nil, {}, 0
    companions.abandon(preserveTransit==true)
    mcm.resetSession()
    speech.abandon()
    subtitles.abandon()
    microphone.cancel()
    groupChat.cancel()
    phoneChat.abandon()
    active, pending, focusUntil, focusMode, focusEntity = nil, nil, nil, nil, nil
    pendingKnowledgeOwner = nil
    focusedCrowd, releasedCrowd, lastPhoneInvitation = nil, nil, nil
    phoneCatalogReady = false
    resetGaze()
    manager.reset()
    warmConversation(nil, nil)
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
    lootObserver.configure({captureContext = captureLootContext})
    lootObserver.install()
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
    -- Menu updates can have zero simulation delta. Cancel recording/group work
    -- here, before the slower gameplay poll, so pause cannot submit a late turn.
    if not worldReady then gameplayActions.revoke('menu'); cancelVoice('menu') end
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
    updatePhoneInvitationFeedback(menuPlayer)
    -- Retain prepared and attached party connections while game time is paused.
    publishPartyConnections(false)
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
    if diagnosticPoll >= 0.5 then
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
    local managerOk, managerError = pcall(manager.update, player, 0.1)
    if not managerOk then log('Manager update failed: ' .. tostring(managerError)) end
    if worldReady then companions.update(player, elapsedPoll, focusEntity) end
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
    if pending and os.time() - pending.sentAt >= 90 then
        -- The request owns its deadline. Focus expiry must never discard only
        -- pending while leaving a microphone/group waiting forever. Retire it
        -- before reading replies so a result at/after the deadline stays late.
        local expired = pending
        gameplayActions.revoke('reply-timeout', expired.requestId)
        if not expired.reaction then player:ConvaiPhoneFeedback(ui.t('No reply arrived. Check that the Convai bridge is running.')) end
        log('Conversation timed out: generation=' .. expired.generation)
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
                        if not pending.reaction then player:ConvaiPhoneFeedback(reply.error) end
                    else speech.start(pending, reply) end
                end)
                if shown then
                    local _, listeners = groupAudience(player)
                    -- Continuous Convai PCM shares evolving-utterance delivery
                    -- semantics with stream v2, without native WAV chunking.
                    local utterance = reply.stream or (type(reply.continuous) == 'table'
                        and {version=2,id=reply.continuous.id} or nil)
                    groupChat.received(pending.requestId, reply.text, reply.error ~= nil or (not speech.requestId and not subtitles.ownsUtterance()), listeners, utterance, reply.userText)
                    if type(microphone.received) == 'function' then microphone.received(pending.requestId) end
                    log('Conversation result: generation=' .. pending.generation .. ' error=' .. tostring(reply.error ~= nil))
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
    loot.reset(); lootObserver.reset(); lastAutomatic = nil
    battleSample, battlePeople = nil, {}
    phoneChat.abandon()
    mcm.shutdown(liveWorld)
    groupChat.cancel()
    warmConversation(nil, nil)
    microphone.cancel()
    if liveWorld then speech.stop('shutdown'); subtitles.clear()
    else speech.abandon(); subtitles.abandon() end
    active = nil
    if liveWorld then companions.dismissAll() else companions.abandon() end
    local player = liveWorld and Game.GetPlayer() or nil
    if player then pcall(function() player:ConvaiCloseManager() end) end
    manager.reset()
    if liveWorld then endFocus(player) else focusedCrowd, releasedCrowd = nil, nil end
    focusMode = nil
    focusEntity = nil
    log('Game adapter shut down')
end)
