-- Bounded development proof for the native facial layer. This does not hook
-- movement, turn an actor, play audio or change a shared facial resource.
local M = convaiFaceProbe or {}

local function playerReady()
    local player = Game.GetPlayer()
    if not player or not player:IsAttached() or player:IsDeadNoStatPool() then return nil end
    return player
end

local function actorFor(entity)
    local player = playerReady()
    if not player or tostring(player:GetEntityID().hash) ~= M.playerID then return nil end
    -- Keep only an ID between ticks. Live actor handles remain local to a tick.
    for _, candidate in ipairs(convaiCompanions.conversationCandidates(player, 100000)) do
        if candidate.entity == entity and convaiCompanions.owns(candidate.npc) then return candidate.npc end
    end
end

local function publish()
    local file = io.open('runtime/face-probe.json', 'wb')
    if file then
        file:write(json.encode({state = M.state, entity = M.entity, name = M.name,
            elapsed = M.elapsed, error = M.error, samples = M.samples, restored = M.restored}))
        file:close()
    end
end

function M.stop(reason)
    local actor = M.entity and actorFor(M.entity)
    M.restored = false
    if actor then
        local ok, restored = pcall(function() return actor:ConvaiFaceReset() end)
        M.restored = ok and restored == true
    end
    M.active, M.state = false, reason or 'cancelled'
    publish()
end

function M.start(profileKey)
    if M.active then M.stop('replaced') end
    local player = assert(playerReady(), 'Gameplay is unavailable')
    assert(not (convaiSpeech and convaiSpeech.requestId), 'Wait until current speech ends')
    local selected
    for _, candidate in ipairs(convaiCompanions.conversationCandidates(player, 8)) do
        if candidate.profileKey == profileKey and convaiCompanions.owns(candidate.npc) then selected = candidate; break end
    end
    assert(selected, 'No owned companion with this profile within eight metres')
    assert(selected.npc:ConvaiFaceReady(), 'Face layer is not ready: ' .. selected.npc:ConvaiFaceStatus())
    M.playerID = tostring(player:GetEntityID().hash)
    M.entity, M.name, M.samples, M.elapsed, M.interval = selected.entity, selected.name, {}, 0, 0
    M.error, M.restored, M.deadline = nil, false, os.time() + 12
    M.active, M.state = true, 'running'
    publish()
end

function M.update(delta)
    if not M.active then return end
    local ok, err = pcall(function()
        if os.time() >= M.deadline then M.stop('deadline'); return end
        local actor = actorFor(M.entity)
        if not actor then M.stop('target-lost'); return end
        local defs = Game.GetAllBlackboardDefs()
        if Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu)
            or (convaiSpeech and convaiSpeech.requestId) then M.stop('interrupted'); return end
        M.elapsed, M.interval = M.elapsed + math.max(0, delta), M.interval + math.max(0, delta)
        if M.elapsed >= 5 then M.stop('completed'); return end
        if M.interval < 1 / 30 then return end
        M.interval = M.interval % (1 / 30)
        local amount = 0.5 - 0.5 * math.cos(M.elapsed * 2 * math.pi / 2.5)
        local feature = NewObject('ConvaiFaceFeature')
        feature.jaw_mid_open = 0.35 * amount
        feature.lips_apart_up = 0.12 * amount
        feature.lips_apart_dn = 0.16 * amount
        assert(actor:ConvaiFaceApply(feature), 'Native facial layer rejected the frame')
        if #M.samples == 0 or M.elapsed - M.samples[#M.samples].at >= 0.2 then
            M.samples[#M.samples + 1] = {at = M.elapsed, jaw = feature.jaw_mid_open}
            publish()
        end
    end)
    if not ok then M.error = tostring(err); M.stop('error') end
end

if not M.registered then
    registerForEvent('onUpdate', function(delta) if convaiFaceProbe then convaiFaceProbe.update(delta) end end)
    registerForEvent('onShutdown', function() if convaiFaceProbe and convaiFaceProbe.active then convaiFaceProbe.stop('reload') end end)
    M.registered = true
end
convaiFaceProbe = M
return M
