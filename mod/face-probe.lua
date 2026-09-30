-- Bounded development proof for the native facial layer. This does not hook
-- movement, turn an actor, play audio or change a shared facial resource.
local M = convaiFaceProbe or {}

-- The silent articulation proof compares lip shapes with a fixed jaw. Values
-- stay deliberately small and symmetric; individual upper raisers, emotion,
-- gaze, movement and provider requests are outside this diagnostic.
local articulationTracks = {'jaw_mid_open', 'lips_apart_up', 'lips_apart_dn',
    'lips_l_funnel', 'lips_r_funnel', 'lips_l_purse', 'lips_r_purse',
    'lips_l_corner_stretch', 'lips_r_corner_stretch', 'lips_l_stretch', 'lips_r_stretch'}
local baseline = {0.14, 0.08, 0.10, 0, 0, 0, 0, 0, 0, 0, 0}
local rounded = {0.14, 0.08, 0.10, 0.32, 0.32, 0.28, 0.28, 0, 0, 0, 0}
local wide = {0.14, 0.14, 0.18, 0, 0, 0, 0, 0.23, 0.23, 0.14, 0.14}
local neutral = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
local articulationKeys = {{0, neutral}, {0.4, baseline}, {1.8, baseline},
    {2.2, rounded}, {3.8, rounded}, {4.2, wide}, {5.8, wide},
    {6.4, neutral}, {7.5, neutral}}

local function articulationAt(at)
    local phase = at < 1.8 and 'baseline' or at < 3.8 and 'rounded'
        or at < 5.8 and 'wide' or 'neutral'
    local left, right = articulationKeys[1], articulationKeys[#articulationKeys]
    for index = 2, #articulationKeys do
        right = articulationKeys[index]
        if at <= right[1] then break end
        left = right
    end
    local fraction = math.min(1, math.max(0, (at - left[1]) / (right[1] - left[1])))
    local blend = fraction * fraction * (3 - 2 * fraction)
    local values = {}
    for index, track in ipairs(articulationTracks) do
        values[track] = left[2][index] + (right[2][index] - left[2][index]) * blend
    end
    return values, phase
end

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
        -- Exact entity/player ownership stays internal. The report needs only
        -- known phase labels and numeric controls for the shape comparison.
        file:write(json.encode({version = 1, state = M.state, mode = M.mode,
            phase = M.phase, duration = M.duration, elapsed = M.elapsed,
            error = M.error, samples = M.samples, restored = M.restored}))
        file:close()
    end
end

local function unhook()
    local hook = M.hook
    if not hook then return end
    for _, key in ipairs({'update', 'stop', 'abandon'}) do
        if hook.owner[key] == hook.wrapped[key] then hook.owner[key] = hook.original[key] end
    end
    M.hook = nil
end

function M.abandon(reason)
    -- Called before native teardown; do not resolve or reset a disappearing NPC.
    M.active, M.state, M.restored = false, reason or 'unloaded', false
    M.entity, M.playerID = nil, nil
    unhook()
    publish()
end

function M.stop(reason)
    -- Native resolution can fail during a world transition. Cleanup and
    -- delegate restoration must still happen even when resetting is unsafe.
    M.restored = M.restored == true
    if M.active then
        local ok, restored = pcall(function()
            local actor = M.entity and actorFor(M.entity)
            return actor and actor:ConvaiFaceReset() or false
        end)
        M.restored = ok and restored == true
    end
    M.active, M.state = false, reason or 'cancelled'
    unhook()
    publish()
end

local function hookUpdates()
    -- Reuse the existing adapter tick. CET event registration belongs to init,
    -- not to a diagnostic loaded later. Restore these temporary delegates when
    -- the proof ends, and retain no live actor or component in the callbacks.
    local owner = assert(convaiSpeech, 'Speech lifecycle is unavailable')
    local hook = {owner = owner, original = {}, wrapped = {}}
    for _, key in ipairs({'update', 'stop', 'abandon'}) do
        assert(type(owner[key]) == 'function', 'Missing adapter lifecycle: ' .. key)
        hook.original[key] = owner[key]
    end
    hook.wrapped.update = function(delta)
        -- Reset an interrupted proof before the real speech update applies its
        -- frame, and preserve every result returned by the existing delegate.
        if M.active then M.update(delta) end
        return hook.original.update(delta)
    end
    hook.wrapped.stop = function(reason)
        if M.active then M.stop(reason == 'shutdown' and 'shutdown' or 'interrupted') end
        return hook.original.stop(reason)
    end
    hook.wrapped.abandon = function()
        M.abandon('unloaded')
        return hook.original.abandon()
    end
    M.hook = hook
    for key, callback in pairs(hook.wrapped) do owner[key] = callback end
end

function M.start(profileKey, mode)
    mode = mode or 'jaw'
    assert(mode == 'jaw' or mode == 'articulation', 'Unknown facial probe mode')
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
    M.mode, M.phase, M.duration = mode, mode == 'articulation' and 'baseline' or 'jaw',
        mode == 'articulation' and 7.5 or 5
    M.error, M.restored, M.deadline = nil, false, os.time() + 12
    hookUpdates()
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
        assert(type(delta) == 'number' and delta == delta and math.abs(delta) < math.huge,
            'Invalid facial probe frame delta')
        M.elapsed, M.interval = M.elapsed + math.max(0, delta), M.interval + math.max(0, delta)
        if M.elapsed >= M.duration then M.stop('completed'); return end
        if M.interval < 1 / 30 then return end
        M.interval = M.interval % (1 / 30)
        local feature = NewObject('ConvaiFaceFeature')
        local controls
        if M.mode == 'articulation' then
            controls, M.phase = articulationAt(M.elapsed)
            for track, value in pairs(controls) do feature[track] = value end
        else
            local amount = 0.5 - 0.5 * math.cos(M.elapsed * 2 * math.pi / 2.5)
            feature.jaw_mid_open = 0.35 * amount
            feature.lips_apart_up = 0.12 * amount
            feature.lips_apart_dn = 0.16 * amount
        end
        assert(actor:ConvaiFaceApply(feature), 'Native facial layer rejected the frame')
        if #M.samples == 0 or M.elapsed - M.samples[#M.samples].at >= 0.2 then
            M.samples[#M.samples + 1] = {at = M.elapsed, phase = M.phase,
                jaw = feature.jaw_mid_open, controls = controls}
            publish()
        end
    end)
    if not ok then M.error = tostring(err); M.stop('error') end
end

convaiFaceProbe = M
return M
