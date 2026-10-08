-- Game-owned permission for one continuous Convai PCM stream. The browser owns
-- the audio device; it may render only while this exact game lease is fresh.
-- No actor/player/native handle is retained here, including during teardown.
-- faceFile: this adapter reads the facial timeline from its own file
-- (runtime/continuous-face.json) when the bridge publishes faceRevision; an
-- inline `face` from an older bridge is still accepted.
local M = {version = 1, available = true, faceFile = true}
local owner, sequence, poll, wait, previous, lastUpdated, volumePoll, volume = nil, 0, 0, 0, nil, nil, 0, nil
local readSequence, acceptedSequence = 0, 0
-- Main-thread cost: every CET io.open/os.rename
-- costs about 1-3 ms in game. The permission file is rewritten when its
-- values change and otherwise every CONTROL_PERIOD (the bridge treats a lease
-- older than 400 ms as quiet). The facial timeline (up to ~100 KB) is read
-- and decoded only when its revision changes, at most every FACE_PERIOD.
local CONTROL_PERIOD, FACE_PERIOD = .15, .2
local written, faceTimeline, faceRevision, faceReadAt = nil, nil, nil, nil
-- Wall clock for the write and face timers (menus report zero delta). Tests replace it.
M.now = function() return os.clock() end
local states = {open=true, starting=true, ready=true, buffering=true, playing=true, paused=true,
    waiting=true, ['waiting-control']=true, ['awaiting-admission']=true, ['lease-held']=true,
    draining=true, opening=true, ended=true, finished=true, error=true, stopped=true, cancelled=true}
local function finite(value)
    return type(value) == 'number' and value == value and math.abs(value) < math.huge
end
local function integer(value, low, high)
    return finite(value) and value % 1 == 0 and value >= low and value <= high
end
local function null(value) return value == nil or (json.null ~= nil and value == json.null) end
local function uuid(value)
    return type(value) == 'string' and #value == 36
        and value:match('^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$') ~= nil
end
local function bounded(value, maximum)
    return type(value) == 'string' and #value > 0 and #value <= maximum and not value:find('%c')
end
local function identity(value)
    return type(value) == 'table' and bounded(value.requestId, 160)
        and bounded(value.entity, 120) and integer(value.generation, 0, 2147483647)
end
local function same(value)
    return owner and value.id == owner.id and value.requestId == owner.requestId
        and value.generation == owner.generation and value.entity == owner.entity
end

-- Camera-to-speaker distance from the latest spatial() call, sent with the
-- lease for the bridge's distance low-pass (docs/DIALOGUE_LEVEL.md).
local speakerDistance = nil
-- Headphone-friendly pan width: a speaker at V's side is mostly, not only, in
-- one ear (about 12 dB down on the far side, like Audioware's own emitters).
local PAN_WIDTH = .7

local function write(allow, paused, level, pan)
    if not owner then return false end
    sequence = sequence + 1
    written = {at = M.now(), allow = allow == true, paused = paused == true, level = level or 0, pan = pan or 0}
    local value = {version=1,id=owner.id,requestId=owner.requestId,generation=owner.generation,entity=owner.entity,
        updated=os.time()*1000,sequence=sequence,allow=allow==true,paused=paused==true,
        volume=level or 0,pan=pan or 0,distance=allow and speakerDistance or nil,volumeKnown=volume ~= nil,
        volumeReason=volume == nil and 'game-volume-unavailable' or nil}
    -- In place: one open instead of open+rename+remove+rename (Windows rename
    -- cannot replace a file). The bridge keeps its last good lease when it
    -- reads a partial file.
    local ok, done = pcall(function()
        local file = io.open('runtime/continuous-control.json', 'wb')
        if not file then return false end
        local success, closed = file:write(json.encode(value)), file:close()
        return (success and closed) and true or false
    end)
    return ok and done == true
end

-- True when the game's permission differs enough from the last write, or the lease needs a refresh.
local function due(allow, paused, level, pan)
    local last = written
    return not last or last.allow ~= (allow == true) or last.paused ~= (paused == true)
        or math.abs(last.level - (level or 0)) >= .02 or math.abs(last.pan - (pan or 0)) >= .05
        or M.now() - last.at >= CONTROL_PERIOD or M.now() < last.at
end

local function validActors(player, actor)
    return player and actor and tostring(player:GetEntityID().hash) == owner.player
        and player:IsAttached() and not player:IsDeadNoStatPool()
        and tostring(actor:GetEntityID().hash) == owner.entity and actor:IsAttached() and not actor:IsDeadNoStatPool()
end

local function gameVolume()
    -- Verified against installed Audioware/Listener.reds: ConfigVarInt values
    -- in /audio/volume, 0..100. Missing API/settings fail silent, never guessed.
    local ok, level = pcall(function()
        local group = Game.GetSettingsSystem():GetGroup(CName.new('/audio/volume'))
        local master = group:GetVar(CName.new('MasterVolume')):GetValue()
        local dialogue = group:GetVar(CName.new('DialogueVolume')):GetValue()
        assert(finite(master) and master >= 0 and master <= 100
            and finite(dialogue) and dialogue >= 0 and dialogue <= 100)
        return master * dialogue / 10000
    end)
    volume = ok and level or nil
end

local function spatial(player, actor)
    local position = actor:GetWorldPosition()
    local origin, forward = Game.GetTargetingSystem():GetCrosshairData(player)
    local dx, dy, dz = position.x-origin.x, position.y-origin.y, position.z-origin.z
    assert(finite(dx) and finite(dy) and finite(dz) and finite(forward.x) and finite(forward.y))
    local distance, horizontal, direction = math.sqrt(dx*dx+dy*dy+dz*dz), math.sqrt(dx*dx+dy*dy), math.sqrt(forward.x^2+forward.y^2)
    local pan = horizontal > .001 and direction > .001 and (dx*forward.y-dy*forward.x)/(horizontal*direction) or 0
    local t = math.max(0, math.min(1, (distance-2)/16))
    -- Gentle distance gain and equal-power pan in the device renderer, with the
    -- same 2m near / 18m far range as Audioware. The bridge adds the dialogue
    -- level and a distance low-pass (docs/DIALOGUE_LEVEL.md).
    speakerDistance = math.floor(distance * 100 + .5) / 100
    return (volume or 0)*(1-t*t*(3-2*t)), math.max(-1, math.min(1, pan)) * PAN_WIDTH
end

function M.stop()
    write(false, true, 0, 0)
    owner, previous, lastUpdated, volume, speakerDistance = nil, nil, nil, nil, nil
    written, faceTimeline, faceRevision, faceReadAt = nil, nil, nil, nil
    readSequence, acceptedSequence = 0, 0
end

function M.pause()
    -- Used before a world/save pause's early return. Do not read native state.
    return not owner or write(true, true, 0, 0)
end

function M.status()
    return {volumeKnown=volume ~= nil,volume=volume or 0,
        volumeReason=volume == nil and 'game-volume-unavailable' or nil}
end

-- Cached numerical diagnostics only. Do not return the actor/owner, text,
-- timeline or controller itself, and do not add file/native reads here.
function M.diagnosticCadence()
    if not owner then return nil end
    local timeline = faceTimeline
    return {reads = readSequence, acceptedReads = acceptedSequence,
        updated = previous and previous.updated, position = previous and previous.position,
        duration = previous and previous.bufferedDuration,
        sourceFrames = type(timeline) == 'table' and type(timeline.frames) == 'table' and #timeline.frames or nil,
        sourceComplete = previous and previous.complete or false,
        state = previous and previous.state, wait = wait, poll = poll}
end

function M.start(context, descriptor, player, actor, paused)
    M.stop()
    if not identity(context) or type(descriptor) ~= 'table' or descriptor.version ~= 1 or not uuid(descriptor.id) then
        return false, 'Invalid continuous speech owner'
    end
    local ok, playerID = pcall(function() return tostring(player:GetEntityID().hash) end)
    if not ok or not bounded(playerID, 120) then return false, 'Continuous speech player unavailable' end
    owner = {id=descriptor.id,requestId=context.requestId,generation=context.generation,entity=context.entity,player=playerID}
    poll, wait, volumePoll = 0, 0, 0
    written, faceTimeline, faceRevision, faceReadAt = nil, nil, nil, nil
    local authorized, level, pan = pcall(function()
        assert(validActors(player, actor), 'Continuous speech target unavailable')
        gameVolume()
        return spatial(player, actor)
    end)
    if not authorized then M.stop(); return false, 'Continuous speech target unavailable' end
    if not write(true, paused, level, pan) then M.stop(); return false, 'Continuous permission could not be written' end
    return true
end

-- The timeline file carries the same owner and a revision that only grows.
local function readFace()
    local file = io.open('runtime/continuous-face.json', 'rb')
    if not file then return nil end
    local raw = file:read(4000001); file:close()
    if type(raw) ~= 'string' or #raw > 4000000 then return nil end
    local ok, value = pcall(json.decode, raw)
    if not ok or type(value) ~= 'table' or value.version ~= 1 or not same(value)
        or not integer(value.revision, 1, 2147483647) or (faceRevision and value.revision <= faceRevision)
        or type(value.face) ~= 'table' or not finite(value.face.duration) then return nil end
    faceRevision, faceTimeline = value.revision, value.face
    return value.face
end

local function read()
    readSequence = readSequence + 1
    local file = io.open('runtime/continuous-speech.json', 'rb')
    if not file then return nil end
    local raw = file:read(4000001); file:close()
    if type(raw) ~= 'string' or #raw > 4000000 then return nil end
    local ok, value = pcall(json.decode, raw)
    if not ok or type(value) ~= 'table' or value.version ~= 1 or not same(value) then return nil end
    if not finite(value.updated) or value.updated < (os.time()-2)*1000 or value.updated > (os.time()+2)*1000
        or (lastUpdated and value.updated < lastUpdated) or not states[value.state]
        or not finite(value.position) or value.position < 0 or not finite(value.bufferedDuration)
        or value.bufferedDuration < 0 or value.bufferedDuration > 120 or value.position > value.bufferedDuration+.001
        or type(value.text) ~= 'string' or #value.text > 12000 or not value.text:find('%S') or type(value.textComplete) ~= 'boolean'
        or type(value.complete) ~= 'boolean' or type(value.ended) ~= 'boolean'
        or not integer(value.underruns, 0, 1000000)
        or (not null(value.error) and (type(value.error) ~= 'string' or #value.error > 240)) then return nil end
    if value.ended and (not value.complete or not value.textComplete or value.bufferedDuration <= 0
        or value.position < value.bufferedDuration-.025 or not null(value.error)) then return nil end
    if previous and (value.position < previous.position-.001 or value.bufferedDuration < previous.bufferedDuration-.001
        or (previous.textComplete and (not value.textComplete or value.text ~= previous.text))
        or (previous.complete and (not value.complete or value.bufferedDuration ~= previous.bufferedDuration))
        or (previous.ended and not value.ended)) then return nil end
    if null(value.error) then value.error = nil end
    if value.face ~= nil then
        faceTimeline = value.face
    elseif value.faceRevision ~= nil then
        if not integer(value.faceRevision, 1, 2147483647) then return nil end
        local now = M.now()
        if value.faceRevision ~= faceRevision and (not faceReadAt or now - faceReadAt >= FACE_PERIOD or now < faceReadAt) then
            faceReadAt = now
            local face = readFace()
            if face then value.face, value.faceDuration = face, face.duration end
        end
    end
    acceptedSequence = acceptedSequence + 1
    return value
end

function M.update(delta, player, actor, paused)
    if not owner then return nil, 'Continuous speech was cancelled' end
    delta = finite(delta) and math.max(0, math.min(5, delta)) or 0
    poll, wait, volumePoll = poll+delta, wait+delta, volumePoll+delta
    local ok, valid = pcall(validActors, player, actor)
    if not ok or not valid then M.stop(); return nil, 'Continuous speech target unavailable' end
    -- Paused menus can report zero simulation delta; still refresh the small
    -- permission file so they cannot accidentally resume stale audio later.
    if poll >= .04 or paused then
        -- Preserve the remainder: resetting to zero quantized 40 ms into
        -- three frames at 60 FPS (50 ms), or two at 30 FPS (66.7 ms).
        poll = paused and 0 or poll % .04
        if volumePoll >= .5 then volumePoll=0;gameVolume() end
        local positioned, level, pan = pcall(spatial, player, actor)
        if not positioned or (due(true, paused, level, pan) and not write(true, paused, level, pan)) then
            M.stop(); return nil, 'Continuous permission lost'
        end
    else return nil end
    local state = read()
    if state then
        if state.updated ~= lastUpdated then wait = 0 end
        previous, lastUpdated = state, state.updated
        if state.error or state.state == 'error' or state.state == 'cancelled' or state.state == 'stopped' then
            M.stop(); return state, state.error or 'Continuous playback cancelled'
        end
        return state
    end
    if wait > 2 or (lastUpdated and lastUpdated < (os.time()-2)*1000) then
        M.stop(); return nil, 'Continuous playback state is unavailable or stale'
    end
    return nil
end

return M
