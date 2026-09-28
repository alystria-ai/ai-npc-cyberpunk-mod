-- The speech owner supplies its actor only for the current tick. Retain no
-- world entity/component handles, and make no native calls during abandon.
local M = convaiFacialPlayback or {}
local allowed = {
    jaw_mid_open = true, lips_apart_up = true, lips_apart_dn = true,
    lips_together_up = true, lips_together_dn = true,
    lips_l_funnel = true, lips_r_funnel = true, lips_l_purse = true,
    lips_r_purse = true, lips_l_stretch = true, lips_r_stretch = true,
    lips_l_lower_raise = true, lips_r_lower_raise = true,
    lips_tighten_up = true, lips_tighten_dn = true, lips_suck_dn = true, tongue_mid_tip_up = true,
}
local function finite(value)
    return type(value) == 'number' and value == value and value > -math.huge and value < math.huge
end
local function owns(actor)
    return actor and convaiCompanions and convaiCompanions.owns(actor)
        and tostring(actor:GetEntityID().hash) == M.entity
        and actor:IsAttached() and not actor:IsDeadNoStatPool() and actor:ConvaiFaceReady()
end
local function reset(actor)
    local ok, done = pcall(function()
        return owns(actor) and actor:ConvaiFaceReset()
    end)
    M.restored = ok and done == true
end
local function clear()
    M.active, M.requestId, M.timeline, M.feature, M.lastPosition = false, nil, nil, nil, nil
end

function M.abandon(reason)
    clear()
    M.state, M.entity, M.restored = reason or 'unloaded', nil, false
end

function M.stop(actor, reason)
    if M.active then reset(actor) end
    clear()
    M.state = reason or 'idle'
end

function M.start(context, timeline, actor, duration)
    M.abandon('unavailable')
    M.source, M.error, M.applied, M.position = nil, nil, 0, nil
    if type(timeline) ~= 'table' then return false end
    local ok, err = pcall(function()
        assert(timeline.version == 1 and timeline.requestId == context.requestId
            and timeline.entity == context.entity, 'Facial timeline belongs to another reply')
        assert(finite(duration) and duration > 0 and duration <= 120
            and finite(timeline.duration) and math.abs(timeline.duration - duration) < 0.001, 'Facial duration mismatch')
        assert(timeline.source == 'convai-arkit61' or timeline.source == 'audio-envelope'
            or timeline.source == 'local-phonetic', 'Unknown facial source')
        assert(type(timeline.tracks) == 'table' and #timeline.tracks > 0 and #timeline.tracks <= 17
            and type(timeline.frames) == 'table' and #timeline.frames >= 2 and #timeline.frames <= 7202,
            'Invalid facial timeline size')
        local used, previous = {}, -1
        for _, track in ipairs(timeline.tracks) do
            assert(allowed[track] and not used[track], 'Unknown or duplicate facial control')
            used[track] = true
        end
        for _, frame in ipairs(timeline.frames) do
            assert(type(frame) == 'table' and #frame == #timeline.tracks + 1
                and finite(frame[1]) and frame[1] >= 0 and frame[1] <= duration
                and frame[1] > previous, 'Invalid facial frame time')
            for i = 2, #frame do
                assert(finite(frame[i]) and frame[i] >= 0 and frame[i] <= 0.5, 'Invalid facial weight')
            end
            previous = frame[1]
        end
        assert(timeline.frames[1][1] == 0 and math.abs(previous - duration) < 0.001, 'Incomplete facial timeline')
        M.entity = context.entity
        assert(owns(actor), 'Speaker has no prepared owned facial layer')
        M.feature = NewObject('ConvaiFaceFeature')
        assert(M.feature, 'Native facial feature is unavailable')
        M.requestId, M.timeline, M.index = context.requestId, timeline, 1
        M.source, M.active, M.state = timeline.source, true, 'waiting-for-audio'
    end)
    if not ok then clear(); M.state, M.error = 'unavailable', tostring(err) end
    return ok
end

function M.pause(actor)
    if not M.active or M.state == 'paused' then return end
    reset(actor)
    M.state, M.lastPosition = 'paused', nil
end

function M.sync(actor, position, requestId)
    if not M.active or requestId ~= M.requestId then return end
    local ok, err = pcall(function()
        assert(owns(actor), 'Facial playback owner changed')
        assert(finite(position) and position >= 0, 'Invalid audio cursor')
        if M.lastPosition and math.abs(position - M.lastPosition) < 1 / 60 then return end
        local frames, tracks = M.timeline.frames, M.timeline.tracks
        if position >= M.timeline.duration then M.stop(actor, 'finished'); return end
        if M.lastPosition and position < M.lastPosition then M.index = 1 end
        while M.index < #frames - 1 and frames[M.index + 1][1] <= position do M.index = M.index + 1 end
        local left, right = frames[M.index], frames[M.index + 1]
        local alpha = math.max(0, math.min(1, (position - left[1]) / (right[1] - left[1])))
        for i, track in ipairs(tracks) do
            M.feature[track] = left[i + 1] + (right[i + 1] - left[i + 1]) * alpha
        end
        assert(actor:ConvaiFaceApply(M.feature), 'Native facial layer rejected the frame')
        M.position, M.lastPosition, M.state = position, position, 'playing'
        M.applied = M.applied + 1
    end)
    if not ok then M.error = tostring(err); M.stop(actor, 'error') end
end

function M.status()
    return {state = M.state or 'idle', source = M.source, position = M.position,
        applied = M.applied or 0, restored = M.restored, error = M.error}
end

convaiFacialPlayback = M
return M
