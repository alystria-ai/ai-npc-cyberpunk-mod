-- Game-owned permission for one continuous Convai PCM stream. The browser owns
-- the audio device; it may render only while this exact game lease is fresh.
-- No actor/player/native handle is retained here, including during teardown.
local M = {version = 1, available = true}
local owner, sequence, poll, wait, previous, lastUpdated, volumePoll, volume = nil, 0, 0, 0, nil, nil, 0, nil
local readSequence, acceptedSequence = 0, 0
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

local function write(allow, paused, level, pan)
    if not owner then return false end
    sequence = sequence + 1
    local value = {version=1,id=owner.id,requestId=owner.requestId,generation=owner.generation,entity=owner.entity,
        updated=os.time()*1000,sequence=sequence,allow=allow==true,paused=paused==true,
        volume=level or 0,pan=pan or 0,volumeKnown=volume ~= nil,
        volumeReason=volume == nil and 'game-volume-unavailable' or nil}
    local ok, written = pcall(function()
        local file = io.open('runtime/continuous-control.json.tmp', 'wb')
        if not file then return false end
        local success, closed = file:write(json.encode(value)), file:close()
        if not success or not closed then return false end
        if os.rename('runtime/continuous-control.json.tmp', 'runtime/continuous-control.json') then return true end
        os.remove('runtime/continuous-control.json')
        return os.rename('runtime/continuous-control.json.tmp', 'runtime/continuous-control.json') ~= nil
    end)
    return ok and written == true
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
    -- No voice processing: only gentle distance gain and equal-power pan in
    -- the device renderer, with the same 2m near / 18m far range as Audioware.
    return (volume or 0)*(1-t*t*(3-2*t)), math.max(-1, math.min(1, pan))
end

function M.stop()
    write(false, true, 0, 0)
    owner, previous, lastUpdated, volume = nil, nil, nil, nil
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
    local timeline = previous and previous.face
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
    local authorized, level, pan = pcall(function()
        assert(validActors(player, actor), 'Continuous speech target unavailable')
        gameVolume()
        return spatial(player, actor)
    end)
    if not authorized then M.stop(); return false, 'Continuous speech target unavailable' end
    if not write(true, paused, level, pan) then M.stop(); return false, 'Continuous permission could not be written' end
    return true
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
        if not positioned or not write(true, paused, level, pan) then
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
