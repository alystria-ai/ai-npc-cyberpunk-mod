-- Cyberpunk Convai game adapter. It never renders an ImGui text field.
-- Owns native composers, targeted turns, party connections and live diagnostics.
local companions = dofile('companions.lua')
local subtitles = dofile('subtitles.lua')
local speech = dofile('speech.lua')
local microphone = dofile('microphone.lua')
local characterCatalog = dofile('character-catalog.lua')
local groupChat = dofile('group-chat.lua')
local manager = dofile('manager.lua')
local mcm = dofile('mcm.lua')
local phoneLayout = dofile('phone-layout.lua')
local phoneChatStyle = dofile('phone-chat-style.lua')
local phoneChat = dofile('phone-chat.lua')
local questContext = dofile('quest-context.lua')
local battleObserver = dofile('battle-observer.lua')
local battles = dofile('battle-reactions.lua').new()
convaiBattleReactions = battles
groupChat.captureJournal = questContext.capture
phoneChat.captureJournal = questContext.capture
microphone.captureJournal = questContext.capture
groupChat.captureBattle = battles.capture
phoneChat.captureBattle = battles.capture
microphone.captureBattle = battles.capture
convaiPhoneChat = phoneChat
convaiGroupChat = groupChat
groupChat.onPreparation = function(preparation)
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
phoneChat.configure(profiles, manager)
mcm.configure(manager, companions, dofile('manager-party.lua'), dofile('mcm-entry.lua'))
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
local pendingPhoneAction = nil
local automatic, battleSample, battlePeople, battlePoll = nil, nil, {}, 0
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
    local candidates = {}
    local _, parts = targeting:GetTargetParts(player, query)
    for _, part in ipairs(parts or {}) do
        local component = TS_TargetPartInfo.GetComponent(part)
        local entity = component and component:GetEntity()
        if entity then candidates[#candidates + 1] = entity end
    end
    local nearest = targeting:GetObjectClosestToCrosshair(player, query)
    if nearest then candidates[#candidates + 1] = nearest end
    local lookedOk, looked = pcall(function() return targeting:GetLookAtObject(player, true, true) end)
    if lookedOk and looked then candidates[#candidates + 1] = looked end
    local playerPos, forward = targeting:GetCrosshairData(player)
    local forwardLength = math.sqrt(forward.x^2 + forward.y^2 + forward.z^2)
    local best, bestScore = nil, math.huge
    for _, npc in ipairs(candidates) do
        local valid, score = pcall(function()
            if not npc:IsNPC() or not npc:IsAttached() or npc:IsDeadNoStatPool() then return nil end
            local pos = npc:GetWorldPosition()
            local dx, dy, dz = pos.x - playerPos.x, pos.y - playerPos.y, pos.z + 1.3 - playerPos.z
            local distance = math.sqrt(dx^2 + dy^2 + dz^2)
            if distance < 0.1 or distance > 8.0 or forwardLength < 0.1 then return nil end
            local cosine = (dx * forward.x + dy * forward.y + dz * forward.z) / (distance * forwardLength)
            cosine = math.max(-1.0, math.min(1.0, cosine))
            local angle = math.deg(math.acos(cosine))
            if lookedOk and looked and npc == looked then angle = 0.0 end
            if angle > 32.0 then return nil end
            return angle / 32.0 + distance / 8.0
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

local function beginText(groupMode)
    local ok, err = pcall(function()
        local player = Game.GetPlayer()
        if not player or not gameplayCanAcquire(player) then return end
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
        if not npc then log(reason); return end
        local key, name, bodyType = profileIdentity(npc)
        local identity = tostring(npc:GetEntityID().hash)
        if not key or not supportedProfiles[key] then
            player:ConvaiPhoneFeedback(name .. ' does not have a conversation profile configured yet.')
            log('Conversation unavailable: profile=' .. tostring(key))
            return
        end
        if not profileEnabled(player, key) then log('Companion disabled in manager: ' .. name); return end
        local primary = {npc = npc, name = name, entity = identity, bodyType = bodyType, profileKey = key}
        local participants = groupMode and groupChat.choose(primary, candidates, supportedProfiles) or nil
        if participants and #participants == 0 then player:ConvaiPhoneFeedback('No configured characters are nearby'); return end
        if participants and #participants < 2 then
            player:ConvaiPhoneFeedback('Group chat needs two characters nearby. Use F6 for one person.')
            return
        end
        generation = generation + 1
        if not player:ConvaiOpenComposer(name) then
            log('Native composer unavailable (check redscript and Codeware)')
            return
        end
        cancelAutomatic('manual-text')
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

local function toggleVoice()
    local player = Game.GetPlayer()
    if not player then return end
    if microphone.context and microphone.state ~= 'reply' then
        pending = microphone.finish()
        pending.sentAt = os.time()
        focusUntil = os.time() + 90
        return
    end
    if not gameplayCanAcquire(player) then return end
    local ok, err = pcall(function()
        local npc, reason = targetAtCrosshair()
        if not npc then player:ConvaiPhoneFeedback(reason); return end
        local key, name, body = profileIdentity(npc)
        if not key or not supportedProfiles[key] then
            player:ConvaiPhoneFeedback(name .. ' does not have a conversation profile configured yet.'); return
        end
        if not profileEnabled(player, key) then return end
        generation = generation + 1
        cancelAutomatic('microphone')
        groupChat.cancel()
        warmConversation(nil, nil)
        speech.stop('microphone'); subtitles.clear()
        speech.target = npc
        local entity = tostring(npc:GetEntityID().hash)
        local context = {generation = generation, entity = entity, name = name, bodyType = body,
            profileKey = key, text = '[Microphone]', sentAt = os.time()}
        context.requestId = tostring(os.time()) .. '-' .. tostring(generation) .. '-' .. entity
        if microphone.begin(context) then
            beginFocus(player, npc)
            focusMode, focusEntity, focusUntil = 'chat', entity, os.time() + 120
            active, pending = nil, nil
            player:ConvaiPhoneFeedback('Connecting microphone - wait for Listening')
        end
    end)
    if not ok then microphone.cancel(); log('Microphone failed: ' .. tostring(err)) end
end

local function sendRequest(context)
    context.journal = context.journal or questContext.capture()
    context.battle = context.battle or battles.capture()
    local file = io.open('runtime/last-input.json.tmp', 'wb')
    if not file then return false end
    file:write(json.encode(context)); file:close()
    os.remove('runtime/last-input.json')
    if not os.rename('runtime/last-input.json.tmp', 'runtime/last-input.json') then return false end
    pending = context
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
        manualActivity = manual, guard = reactionGuard, scheduler = battles.status()}
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

local function updateBattles(player, elapsed, worldReady)
    battlePoll = battlePoll + elapsed
    if not battleSample or battlePoll >= 0.5 then
        battlePoll = 0
        battleSample = battleObserver.sample(player)
        battleSampleAt = os.time() * 1000
        battlePeople = {}
        local ok, candidates = pcall(companions.conversationCandidates, player, 20)
        battleCandidatesOk = ok
        if ok then
            for _, person in ipairs(candidates) do
                if supportedProfiles[person.profileKey] and manager.profileEnabled(person.profileKey) then
                    person.available, person.availableReason, person.voiceBusy = battleObserver.canSpeak(person.npc, battleSample.combat and 'start' or 'end')
                    battlePeople[#battlePeople + 1] = person
                end
            end
        end
    end
    battles.update(battleSample, worldReady and elapsed or 0, os.time(), manager.battleReactions(), battlePeople)
    local manual = active ~= nil or groupChat.round ~= nil
        or (microphone.context ~= nil and microphone.state ~= 'reply') or phoneChat.pending ~= nil
    local outputs = reactionOutputs(player)
    if automatic then
        local speaker
        for _, person in ipairs(battlePeople) do
            if person.entity == automatic.entity then speaker = person; break end
        end
        captureReactionGuard(worldReady, outputs, speaker)
        local waiting = reactionSpeakerWait(speaker)
        local valid, invalidReason = battles.valid(automatic.reaction, os.time(), automatic.playbackAt)
        local reason = not worldReady and 'world-not-ready' or manual and 'manual-priority'
            or not outputs.enabled and 'outputs-disabled'
            or not speaker and 'speaker-missing' or (not speaker.available and not waiting) and 'speaker-unavailable'
            or not valid and (invalidReason or 'event-invalid')
        if reason then
            cancelAutomatic(reason)
        elseif not pending and not speech.requestId and not subtitles.line then
            cancelAutomatic('completed')
        elseif not reactionLease(true) then cancelAutomatic('lease-write-failed') end
    end
    local busy = not worldReady or manual or not outputs.enabled or pending ~= nil or speech.requestId ~= nil or subtitles.line ~= nil or automatic ~= nil
    local event = battles.offer(busy, battlePeople, os.time())
    if not event then return end
    generation = generation + 1
    local person = event.person
    local context = {generation = generation, entity = person.entity, name = person.name,
        bodyType = person.bodyType, profileKey = person.profileKey, battle = event.battle, sentAt = os.time(),
        text = event.phase == 'start' and 'Combat has begun. Give a brief in-character reaction.'
            or 'Combat has ended. Give a brief in-character reaction without assuming victory.',
        reaction = {kind = 'battle', encounter = event.encounter, phase = event.phase, expiresAt = event.expiresAt}}
    context.requestId = tostring(os.time()) .. '-' .. generation .. '-' .. context.entity
    automatic = context
    captureReactionGuard(worldReady, outputs, person)
    if reactionLease(true) and sendRequest(context) then
        speech.target = person.npc
        battles.claim(event)
        log('Automatic battle reaction: ' .. event.phase .. ' speaker=' .. person.profileKey)
    else cancelAutomatic('request-write-failed') end
end

local function reactionCanDeliver(context, player)
    if not context.reaction then return true end
    if not automatic or automatic.requestId ~= context.requestId then return false end
    -- A reply can become ready between the half-second observer samples. Read
    -- the owned speaker again before any audio, captions or facial playback.
    for _, person in ipairs(battlePeople) do
        if person.entity == context.entity then
            person.available, person.availableReason, person.voiceBusy = battleObserver.canSpeak(person.npc, context.reaction.phase)
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
            if not person.npc:IsAttached() or person.npc:IsDeadNoStatPool() then return false end
            local pos = person.npc:GetWorldPosition()
            return (pos.x-origin.x)^2 + (pos.y-origin.y)^2 + (pos.z-origin.z)^2 <= 144
        end)
        if ok and nearby then live[person.entity] = true; listeners[#listeners + 1] = person.profileKey end
    end
    return live, listeners
end

local function updateGroup(player)
    local round = groupChat.round
    if not round then return end
    if not player then groupChat.cancel(); return end
    local live = groupAudience(player)
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
    elseif round.stage == 'playing' and not speech.requestId and not subtitles.line then
        groupChat.completed(round.requestId, not deliveryFailed)
    end
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
    if player:ConvaiPhoneIsOpen() then return end
    if not pendingPhoneAction then
        local ok, request = pcall(function() return player:ConvaiPhoneTakeRequest() end)
        if not ok or not request or request == '' then return end
        pendingPhoneAction = request
    end
    -- Contact screens pause the world. Let the request run once gameplay
    -- resumes so entity creation and the first follower command have a frame.
    local menuOk, inMenu = pcall(function()
        local definitions = Game.GetAllBlackboardDefs()
        return Game.GetBlackboardSystem():Get(definitions.UI_System)
            :GetBool(definitions.UI_System.IsInMenu)
    end)
    if not menuOk or inMenu then return end
    local request = pendingPhoneAction
    pendingPhoneAction = nil
    local join, contactId = request:sub(1, 1) == '+', request:sub(2)
    local key, reason, name = companions.phoneContactKey(contactId)
    if not key then
        log('Phone request unavailable for ' .. contactId .. ': ' .. tostring(reason))
        player:ConvaiPhoneFeedback(reason)
        return
    end
    if join then
        local serial, err = companions.spawn(key)
        log(serial and ('Phone spawn requested for ' .. key .. ' #' .. serial)
            or ('Phone join failed for ' .. key .. ': ' .. tostring(err)))
        player:ConvaiPhoneFeedback(serial and (name .. ' is joining you.') or tostring(err))
        return
    end
    local party = companions.list()
    for index = #party, 1, -1 do
        if party[index].key == key then
            companions.dismiss(party[index].serial)
            log('Phone dismissed ' .. key .. ' #' .. party[index].serial)
            player:ConvaiPhoneFeedback(name .. ': dismissed one companion.')
            return
        end
    end
    log('Phone dismiss: no active copy of ' .. key)
    player:ConvaiPhoneFeedback(name .. ' is not in your group.')
end

registerHotkey('cyberpunk_convai_text', 'Cyberpunk Convai: talk by text', function() beginText(false) end)
registerHotkey('cyberpunk_convai_group_text', 'Cyberpunk Convai: group text chat (F8)', function() beginText(true) end)
registerHotkey('cyberpunk_convai_voice', 'Cyberpunk Convai: talk by voice (F7)', toggleVoice)
registerHotkey('cyberpunk_convai_diagnostic', 'Cyberpunk Convai: capture NPC diagnostic', captureNpcDiagnostic)
registerHotkey('cyberpunk_convai_manager', 'Cyberpunk Convai: companion manager', openManager)

local worldSuspended, sessionHasState = false, false

local function abandonSession(reason)
    -- Never touch NPC/player components during native world destruction.
    -- pcall cannot catch an access violation in an already unloaded component.
    cancelAutomatic(reason, true)
    battles.reset()
    battleSample, battlePeople, battlePoll = nil, {}, 0
    companions.abandon()
    mcm.resetSession()
    speech.abandon()
    subtitles.abandon()
    microphone.cancel()
    groupChat.cancel()
    phoneChat.abandon()
    active, pending, focusUntil, focusMode, focusEntity = nil, nil, nil, nil, nil
    focusedCrowd, releasedCrowd, pendingPhoneAction = nil, nil, nil
    phoneCatalogReady = false
    resetGaze()
    manager.reset()
    warmConversation(nil, nil)
    publishPartyConnections(true)
    sessionHasState, poll = false, 0
    log('Session references released: ' .. reason)
end

registerForEvent('onInit', function()
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
    ObserveBefore('PlayerPuppet', 'OnDetach', function()
        worldSuspended = true
        abandonSession('player detached')
    end)
    ObserveBefore('PlayerPuppet', 'OnDeath', function()
        worldSuspended = true
        abandonSession('player died')
    end)
    ObserveAfter('PlayerPuppet', 'OnGameAttached', function() worldSuspended = false end)
    ObserveAfter('PlayerPuppet', 'OnTakeControl', function() worldSuspended = false end)
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
    local menuPlayer = Game.GetPlayer()
    local sessionOk, sessionReady = pcall(function()
        return not worldSuspended and menuPlayer and menuPlayer:IsAttached()
            and not menuPlayer:IsDeadNoStatPool() and not Game.GetSystemRequestsHandler():IsPreGame()
    end)
    if not sessionOk or not sessionReady then
        if sessionHasState then abandonSession('world unavailable') end
        return
    end
    sessionHasState = true
    local worldOk, worldReady = pcall(function()
        if not menuPlayer or not menuPlayer:IsAttached() then return false end
        local definitions = Game.GetAllBlackboardDefs()
        return not Game.GetSystemRequestsHandler():IsGamePaused()
            and not Game.GetSystemRequestsHandler():IsPreGame()
            and not Game.GetBlackboardSystem():Get(definitions.UI_System):GetBool(definitions.UI_System.IsInMenu)
            and not menuPlayer:ConvaiComposerOpen()
    end)
    worldReady = worldOk and worldReady
    -- CET still calls onUpdate while native menus pause the simulation. The
    -- menu adapter needs these frames even when delta is zero; followers don't.
    local mcmOk, mcmError = pcall(mcm.update, menuPlayer, worldReady)
    if not mcmOk then log('MCM update failed: ' .. tostring(mcmError)) end
    local phoneOk, phoneError = pcall(phoneLayout.refresh)
    if not phoneOk then phoneLayout.lastError = tostring(phoneError) end
    local styleOk, styleError = pcall(phoneChatStyle.refresh)
    if not styleOk then phoneChatStyle.lastError = tostring(styleError) end
    local chatOk, chatError = pcall(phoneChat.update, menuPlayer, delta)
    if not chatOk then phoneChat.lastError = tostring(chatError) end
    local speechOk, speechError = pcall(speech.update, tonumber(delta) or 0)
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
    if voiceSubmission then
        pending = voiceSubmission; pending.sentAt = os.time(); focusUntil = os.time() + 90
    end
    if not player then
        groupChat.cancel()
        if active then warmConversation(nil, nil) end
        companions.dismissAll()
        publishPartyConnections(false)
        pendingPhoneAction = nil
        phoneCatalogReady = false
        manager.reset()
        active = nil; pending = nil; focusUntil = nil
        focusMode = nil; focusEntity = nil; endFocus(nil); resetGaze()
        return
    end
    if not phoneCatalogReady then
        local ok, err = pcall(companions.registerPhoneContacts, player)
        if not ok then log('Phone catalog registration failed: ' .. tostring(err)) end
        phoneCatalogReady = ok
    end
    processPhoneAction(player)
    local managerOk, managerError = pcall(manager.update, player, 0.1)
    if not managerOk then log('Manager update failed: ' .. tostring(managerError)) end
    if worldReady then companions.update(player, elapsedPoll, focusEntity) end
    publishPartyConnections(false)
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
    if focusUntil and not active and not speech.requestId and os.time() >= focusUntil then
        endFocus(player)
        focusUntil = nil
        focusMode = nil
        focusEntity = nil
        if pending and not pending.reaction then
            log('Reply timed out: generation=' .. pending.generation)
            pending = nil
        end
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
                        if not pending.reaction then player:ConvaiPhoneFeedback(reply.error) end
                    else speech.start(pending, reply) end
                end)
                if shown then
                    local _, listeners = groupAudience(player)
                    groupChat.received(pending.requestId, reply.text, reply.error ~= nil or (not speech.requestId and not subtitles.line), listeners)
                    log('Conversation result: generation=' .. pending.generation .. ' error=' .. tostring(reply.error ~= nil))
                    if automatic and pending.requestId == automatic.requestId then
                        automatic.shown = reply.error == nil
                        if automatic.shown and (speech.requestId or subtitles.line) then
                            automatic.playbackAt, automatic.leaseAt = os.time(), nil
                            reactionLease(true)
                        end
                    end
                    if not pending.reaction then focusUntil = os.time() + (speech.duration or 8) + 1 end
                    pending = nil
                end
            end
        end
        if pending and os.time() - pending.sentAt > 90 then
            if not pending.reaction then player:ConvaiPhoneFeedback('No reply arrived. Check that the Convai bridge is running.') end
            log('Conversation timed out: generation=' .. pending.generation)
            groupChat.received(pending.requestId, '', true, {})
            pending = nil
            focusUntil = os.time() + 1
        end
    end
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
    cancelAutomatic('shutdown')
    battles.reset()
    battleSample, battlePeople = nil, {}
    phoneChat.abandon()
    mcm.shutdown()
    groupChat.cancel()
    warmConversation(nil, nil)
    microphone.cancel()
    speech.stop('shutdown')
    subtitles.clear()
    active = nil
    companions.dismissAll()
    local player = Game.GetPlayer()
    if player then pcall(function() player:ConvaiCloseManager() end) end
    manager.reset()
    endFocus(player)
    focusMode = nil
    focusEntity = nil
    log('Game adapter shut down')
end)
