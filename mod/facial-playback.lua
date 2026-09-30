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
    lips_l_upper_raise = true, lips_r_upper_raise = true,
    lips_l_corner_stretch = true, lips_r_corner_stretch = true,
}
local function finite(value)
    return type(value) == 'number' and value == value and value > -math.huge and value < math.huge
end
local function trackLimit(track)
    -- Native lip contact is a jaw corrective, with a different calibrated
    -- range. Do not raise the bound on other mouth, tongue or reserved tracks.
    return (track == 'lips_together_up' or track == 'lips_together_dn') and .85 or .5
end
local function owns(actor, entity)
    return actor and convaiCompanions and convaiCompanions.owns(actor)
        and tostring(actor:GetEntityID().hash) == (entity or M.entity)
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
    M.segment, M.generation = nil, nil
    M.continuous, M.timelineChanged = nil, nil
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

function M.start(context, timeline, actor, duration, expectedSegment)
    local segment, feature
    local ok, err = pcall(function()
        assert(type(timeline) == 'table', 'Facial timeline is unavailable')
        assert(timeline.version == 1 and timeline.requestId == context.requestId
            and timeline.entity == context.entity, 'Facial timeline belongs to another reply')
        assert(finite(duration) and duration > 0 and duration <= 120
            and finite(timeline.duration) and math.abs(timeline.duration - duration) < 0.001, 'Facial duration mismatch')
        assert(timeline.source == 'convai-arkit61' or timeline.source == 'audio-envelope'
            or timeline.source == 'local-phonetic', 'Unknown facial source')
        assert(type(timeline.tracks) == 'table' and #timeline.tracks > 0 and #timeline.tracks <= 21
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
                assert(finite(frame[i]) and frame[i] >= 0 and frame[i] <= trackLimit(timeline.tracks[i-1]), 'Invalid facial weight')
            end
            previous = frame[1]
        end
        assert(timeline.frames[1][1] == 0 and math.abs(previous - duration) < 0.001, 'Incomplete facial timeline')
        if timeline.segment ~= nil then
            local value = timeline.segment
            assert(type(value) == 'table' and value.version == 1 and finite(value.index)
                and value.index % 1 == 0 and value.index >= 1 and value.index <= 128
                and finite(value.startSeconds) and value.startSeconds >= 0 and value.startSeconds + duration <= 120.0001
                and type(value.first) == 'boolean' and value.first == (value.index == 1)
                and type(value.last) == 'boolean' and (not value.first or value.startSeconds == 0)
                and type(expectedSegment) == 'table' and expectedSegment.index == value.index
                and finite(expectedSegment.startSeconds) and math.abs(expectedSegment.startSeconds-value.startSeconds) < .0001,
                'Facial segment does not match its native audio')
            segment = {version=1,index=value.index,startSeconds=value.startSeconds,first=value.first,last=value.last}
        end
        assert(owns(actor, context.entity), 'Speaker has no prepared owned facial layer')
        feature = NewObject('ConvaiFaceFeature')
        assert(feature, 'Native facial feature is unavailable')
    end)
    local contiguous = ok and M.active and segment and M.segment and not M.segment.last
        and M.requestId == context.requestId and M.entity == context.entity and M.generation == context.generation
        and segment.index == M.segment.index + 1
        and math.abs(segment.startSeconds - (M.segment.startSeconds + M.timeline.duration)) < .0001
    if M.active and not contiguous then M.stop(actor, 'replaced') end
    M.abandon('unavailable')
    M.source, M.articulation, M.error, M.applied, M.position = nil, nil, nil, 0, nil
    if not ok then M.error = tostring(err); return false end
    M.entity, M.generation, M.segment, M.feature = context.entity, context.generation, segment, feature
    M.requestId, M.timeline, M.index = context.requestId, timeline, 1
    M.source, M.active, M.state = timeline.source, true, 'waiting-for-audio'
    M.articulation = timeline.articulation
    return true
end

-- Convai's live stream supplies one growing, absolute timeline. Updating the
-- data must not recreate/reset the native layer or advance it ahead of audio.
function M.updateContinuous(context, timeline, actor, duration)
    local sameOwner = type(context) == 'table' and M.active and M.continuous
        and M.requestId == context.requestId and M.entity == context.entity
        and M.generation == context.generation
    if M.active and not sameOwner then return false end
    if sameOwner and type(timeline) == 'table' and (timeline.requestId ~= context.requestId
        or timeline.entity ~= context.entity or timeline.generation ~= context.generation) then return false end
    local ok, err = pcall(function()
        assert(type(context) == 'table' and type(timeline) == 'table', 'Facial timeline is unavailable')
        assert(timeline.version == 1 and timeline.continuous == true and type(timeline.complete) == 'boolean'
            and type(context.requestId) == 'string' and #context.requestId > 0
            and type(context.entity) == 'string' and #context.entity > 0
            and timeline.requestId == context.requestId and timeline.entity == context.entity
            and finite(context.generation) and context.generation >= 0 and context.generation % 1 == 0
            and timeline.generation == context.generation, 'Facial timeline belongs to another reply')
        assert(finite(duration) and duration > 0 and duration <= 120
            and finite(timeline.duration) and math.abs(timeline.duration - duration) < .001,
            'Facial duration mismatch')
        assert(timeline.source == 'convai-arkit61' and timeline.segment == nil, 'Unknown continuous facial source')
        assert(type(timeline.tracks) == 'table' and #timeline.tracks > 0 and #timeline.tracks <= 21
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
            for index = 2, #frame do
                assert(finite(frame[index]) and frame[index] >= 0 and frame[index] <= trackLimit(timeline.tracks[index-1]), 'Invalid facial weight')
            end
            previous = frame[1]
        end
        assert(timeline.frames[1][1] == 0 and math.abs(previous - duration) < .001, 'Incomplete facial timeline')
        if sameOwner then
            assert(duration >= M.timeline.duration and (not M.timeline.complete or timeline.complete),
                'Continuous facial timeline moved backwards')
            assert(#timeline.tracks == #M.timeline.tracks, 'Continuous facial controls changed')
            for index, track in ipairs(timeline.tracks) do
                assert(track == M.timeline.tracks[index], 'Continuous facial controls changed')
            end
        end
        assert(owns(actor, context.entity), 'Speaker has no prepared owned facial layer')
    end)
    if not ok then
        M.error = tostring(err)
        if sameOwner then M.stop(actor, 'error') end
        return false
    end
    if not sameOwner then
        local created, feature = pcall(NewObject, 'ConvaiFaceFeature')
        if not created or not feature then M.error = 'Native facial feature is unavailable'; return false end
        M.feature, M.index, M.applied = feature, 1, 0
        M.requestId, M.entity, M.generation = context.requestId, context.entity, context.generation
        M.active, M.continuous, M.state = true, true, 'waiting-for-audio'
        M.lastPosition, M.position, M.segment, M.restored = nil, nil, nil, false
    end
    M.timeline, M.source, M.articulation = timeline, timeline.source, timeline.articulation
    M.error, M.timelineChanged = nil, true
    -- A live tail can be re-interpolated or compacted. Keep the playback index
    -- when its bracket remains valid; otherwise locate the current cursor in
    -- the replacement data without rewinding the visible pose.
    local at, frames = math.min(M.position or 0, duration), timeline.frames
    if M.index >= #frames or frames[M.index][1] > at or frames[M.index + 1][1] < at then
        local low, high = 1, #frames - 1
        while low < high do
            local middle = math.floor((low + high + 1) / 2)
            if frames[middle][1] <= at then low = middle else high = middle - 1 end
        end
        M.index = low
    end
    return true
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
        local continuousEnd = M.continuous and position >= M.timeline.duration
        if continuousEnd and M.timeline.complete then M.stop(actor, 'finished'); return end
        -- An exact 60 Hz step can subtract to a few ULPs below 1/60.
        -- A republished/growing continuous timeline is not a new audio tick.
        -- Native phrase handoffs retain their existing replacement semantics.
        if (M.continuous or not M.timelineChanged) and M.lastPosition
            and math.abs(position - M.lastPosition) < 1 / 60 - 1e-6
            and not (position >= M.timeline.duration and M.lastPosition < M.timeline.duration) then return end
        local frames, tracks = M.timeline.frames, M.timeline.tracks
        if position >= M.timeline.duration and not M.continuous
            and not (M.segment and not M.segment.last) then M.stop(actor, 'finished'); return end
        local heardPosition = position
        position = math.min(position, M.timeline.duration)
        if M.lastPosition and heardPosition < M.lastPosition then M.index = 1 end
        while M.index < #frames - 1 and frames[M.index + 1][1] <= position do M.index = M.index + 1 end
        local left, right = frames[M.index], frames[M.index + 1]
        local alpha = math.max(0, math.min(1, (position - left[1]) / (right[1] - left[1])))
        for i, track in ipairs(tracks) do
            M.feature[track] = left[i + 1] + (right[i + 1] - left[i + 1]) * alpha
        end
        assert(actor:ConvaiFaceApply(M.feature), 'Native facial layer rejected the frame')
        M.position, M.lastPosition = M.continuous and heardPosition or position, M.continuous and heardPosition or position
        M.timelineChanged = nil
        M.state = position >= M.timeline.duration and 'holding-boundary' or 'playing'
        M.applied = M.applied + 1
    end)
    if not ok then M.error = tostring(err); M.stop(actor, 'error') end
end

function M.hold(actor, requestId)
    if M.active and M.requestId == requestId and M.segment and not M.segment.last then
        M.sync(actor, M.timeline.duration, requestId)
        return M.active
    end
    M.stop(actor, 'chunk-finished')
    return false
end

function M.status()
    return {state = M.state or 'idle', source = M.source, articulation = M.articulation, position = M.position,
        applied = M.applied or 0, restored = M.restored, error = M.error}
end

convaiFacialPlayback = M
return M
