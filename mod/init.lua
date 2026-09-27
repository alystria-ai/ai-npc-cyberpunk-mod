-- Cyberpunk Convai game adapter. It never renders an ImGui text field.
-- This first adapter records an in-game targeting and text-input probe.
local companions = dofile('companions.lua')
convaiCompanions = companions
local generation = 0
local active = nil
local pending = nil
local poll = 0
local diagnosticPoll = 0
local lastDiagnosticRequest = nil
local settingsRevision = nil
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
local phoneCatalogReady = false
local profileKeys = {'viktor-vektor', 'misty-olszewski', 'judy-alvarez', 'panam-palmer', 'resident-male', 'resident-female'}

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

local function rosterIndex(name, bodyType)
    local label = name:lower()
    if label:find('viktor', 1, true) or label:find('vektor', 1, true) then return 0 end
    if label:find('misty', 1, true) then return 1 end
    if label:find('judy', 1, true) then return 2 end
    if label:find('panam', 1, true) then return 3 end
    local body = bodyType:lower()
    if body:find('woman', 1, true) or body:find('female', 1, true) then return 5 end
    if body:find('man', 1, true) or body:find('male', 1, true) then return 4 end
    return nil
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
            local name = tostring(result:GetTweakDBFullDisplayName(true) or 'NPC')
            local body = tostring(result:GetBodyType() or '')
            local index = rosterIndex(name, body)
            if index and player:ConvaiManagerEnabled(index) then
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

local function beginText()
    local ok, err = pcall(function()
        local npc, reason = targetAtCrosshair()
        if not npc then log(reason); return end
        local player = Game.GetPlayer()
        local name = tostring(npc:GetTweakDBFullDisplayName(true) or 'NPC')
        local identity = tostring(npc:GetEntityID().hash)
        local bodyType = tostring(npc:GetBodyType() or '')
        local managedKey, managedName = companions.identity(npc)
        if managedName then name = managedName end
        local index = rosterIndex(name, bodyType)
        if not index then log('No companion profile matches ' .. name .. ' (' .. bodyType .. ')'); return end
        if not player:ConvaiManagerEnabled(index) then log('Companion disabled in manager: ' .. name); return end
        generation = generation + 1
        if not player:ConvaiOpenComposer(name) then
            log('Native composer unavailable (check redscript and Codeware)')
            return
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
            profileKey = managedKey or profileKeys[index + 1]}
        pending = nil
        log('Composer opened: generation=' .. generation .. ' actor=' .. identity .. ' name=' .. name)
    end)
    if not ok then log('Open failed: ' .. tostring(err)) end
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
    local ok, result = pcall(function()
        local player = Game.GetPlayer()
        if not player then return false end
        if player:ConvaiCloseManager() then return true end
        return player:ConvaiOpenManager()
    end)
    if ok and result then
        endFocus(Game.GetPlayer())
        focusMode = nil
        focusEntity = nil
        focusUntil = nil
        resetGaze()
    else
        log('Companion manager is unavailable; open it during gameplay')
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

local function readSettings()
    local file = io.open('runtime/settings.json', 'rb')
    if not file then return nil end
    local raw = file:read('*a')
    file:close()
    local ok, value = pcall(json.decode, raw)
    return ok and type(value) == 'table' and value or nil
end

local function applySettings(player)
    local saved = readSettings()
    if not saved then return end
    pcall(function()
        if type(saved.selected) == 'number' then player:ConvaiManagerSelect(saved.selected) end
        if type(saved.voice) == 'boolean' then player:ConvaiManagerSetVoice(saved.voice) end
        if type(saved.subtitles) == 'boolean' then player:ConvaiManagerSetSubtitles(saved.subtitles) end
        if type(saved.enabled) == 'table' then
            for i = 1, math.min(6, #saved.enabled) do
                if type(saved.enabled[i]) == 'boolean' then player:ConvaiManagerSetEnabled(i - 1, saved.enabled[i]) end
            end
        end
    end)
end

local function saveSettings(player)
    local ok, state = pcall(function()
        local value = {
            selected = player:ConvaiManagerSelected(),
            voice = player:ConvaiManagerVoice(),
            subtitles = player:ConvaiManagerSubtitles(),
            enabled = {},
        }
        for i = 0, 5 do value.enabled[i + 1] = player:ConvaiManagerEnabled(i) end
        return value
    end)
    if not ok then return end
    local file = io.open('runtime/settings.json.tmp', 'wb')
    if not file then return end
    file:write(json.encode(state))
    file:close()
    os.remove('runtime/settings.json')
    os.rename('runtime/settings.json.tmp', 'runtime/settings.json')
end

registerHotkey('cyberpunk_convai_text', 'Cyberpunk Convai: talk by text', beginText)
registerHotkey('cyberpunk_convai_diagnostic', 'Cyberpunk Convai: capture NPC diagnostic', captureNpcDiagnostic)
registerHotkey('cyberpunk_convai_manager', 'Cyberpunk Convai: companion manager', openManager)

registerForEvent('onInit', function()
    dofile('phone-input.lua').install()
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
    poll = 0
    local player = Game.GetPlayer()
    if not player then
        companions.dismissAll()
        pendingPhoneAction = nil
        phoneCatalogReady = false
        active = nil; pending = nil; settingsRevision = nil; focusUntil = nil
        focusMode = nil; focusEntity = nil; endFocus(nil); resetGaze()
        return
    end
    if not phoneCatalogReady then
        local ok, err = pcall(companions.registerPhoneContacts, player)
        if not ok then log('Phone catalog registration failed: ' .. tostring(err)) end
        phoneCatalogReady = ok
    end
    processPhoneAction(player)
    companions.update(player, 0.1, focusEntity)
    if focusUntil and not active and os.time() >= focusUntil then
        endFocus(player)
        focusUntil = nil
        focusMode = nil
        focusEntity = nil
        if pending then
            log('Reply timed out: generation=' .. pending.generation)
            pending = nil
        end
    end
    local settingsOk, revision = pcall(function() return player:ConvaiManagerRevision() end)
    if settingsOk then
        if settingsRevision == nil then
            applySettings(player)
            settingsRevision = player:ConvaiManagerRevision()
            saveSettings(player)
        elseif settingsRevision ~= revision then
            settingsRevision = revision
            saveSettings(player)
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
                and (type(reply.text) == 'string' or type(reply.error) == 'string') then
                local shown = pcall(function()
                    if reply.error then player:ConvaiPhoneFeedback(reply.error)
                    else player:ConvaiShowReply(pending.name, reply.text:sub(1, 1200)) end
                end)
                if shown then
                    log('Conversation result: generation=' .. pending.generation .. ' error=' .. tostring(reply.error ~= nil))
                    focusUntil = os.time() + 8
                    pending = nil
                end
            end
        end
        if pending and os.time() - pending.sentAt > 40 then
            player:ConvaiPhoneFeedback('No reply arrived. Check that the Convai bridge is running.')
            log('Conversation timed out: generation=' .. pending.generation)
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
                focusUntil = os.time() + 1
            end
        end
        return
    end
    local taken, message = pcall(function() return player:ConvaiTakeSubmission() end)
    if taken and type(message) == 'string' and #message > 0 then
        local context = active
        if context then
            local file = io.open('runtime/last-input.json.tmp', 'wb')
            if file then
                context.requestId = tostring(os.time()) .. '-' .. tostring(context.generation) .. '-' .. context.entity
                context.text = message
                context.sentAt = os.time()
                file:write(json.encode(context))
                file:close()
                os.remove('runtime/last-input.json')
                os.rename('runtime/last-input.json.tmp', 'runtime/last-input.json')
                pending = context
                focusUntil = os.time() + 40
                player:ConvaiPhoneFeedback(context.name .. ' is thinking...')
            end
            log('Native input captured: generation=' .. context.generation .. ' bytes=' .. #message)
        else
            log('Late native input discarded after target loss')
        end
    end
    active = nil
end)

registerForEvent('onShutdown', function()
    active = nil
    companions.dismissAll()
    local player = Game.GetPlayer()
    endFocus(player)
    focusMode = nil
    focusEntity = nil
    log('Game adapter shut down')
end)
