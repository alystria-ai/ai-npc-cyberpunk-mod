-- One utterance owns playback across all its phrases. Native audio position
-- drives the face/captions; a temporary buffer gap never advances group chat.
local M = convaiSpeech or {heartbeat = 0, available = false}
local captions = dofile('subtitles.lua')
local face = dofile('facial-playback.lua')

local function voiceEnabled(player)
    if not player then return false end
    local ok, enabled = pcall(function() return player:ConvaiManagerVoice() end)
    return not ok or enabled
end
local function validAudio(audio)
    return type(audio) == 'table' and type(audio.slot) == 'number'
        and audio.slot >= 0 and audio.slot <= 7 and audio.slot % 1 == 0
        and audio.event == 'convai_reply_' .. tostring(audio.slot)
        and type(audio.duration) == 'number' and audio.duration > 0 and audio.duration <= 120
end
local function receipt()
    local s = M.stream
    if not s then return M.streamReceipt end
    return {id = s.id, index = s.index, completed = s.completed, received = s.received,
        history = s.history, error = s.error}
end
local function publish()
    local f = io.open('runtime/speech-state.json', 'wb')
    if f then
        local r = receipt()
        f:write(json.encode({available = M.available, updated = os.time() * 1000,
            requestId = M.requestId, slot = M.slot, state = M.state or 'idle',
            position = M.position, paused = M.paused, error = M.error, face = face.status(),
            streamId = r and r.id, chunkIndex = r and r.index, completedChunk = r and r.completed,
            receivedChunks = r and r.received, chunks = r and r.history, streamError = r and r.error}))
        f:close()
    end
end

function M.stop(reason)
    face.stop(M.actor, reason)
    if M.player then pcall(function() M.player:ConvaiSpeechStop() end) end
    if M.requestId then captions.clear() end
    M.streamReceipt = receipt()
    M.stream, M.context = nil, nil
    M.player, M.actor, M.requestId, M.slot, M.duration = nil, nil, nil, nil, nil
    M.state, M.position, M.paused = reason or 'idle', nil, false
    publish()
end

local function fallback(reason, text)
    local name, actor, entity = M.speaker, M.actor, M.context and M.context.entity
    M.stop(reason)
    captions.show(name, text, actor, entity)
end

function M.clearEntity(entity)
    if M.context and M.context.entity == entity then M.stop('target-dismissed') end
    if M.target then
        local ok, current = pcall(function() return tostring(M.target:GetEntityID().hash) end)
        if ok and current == entity then M.target = nil end
    end
    captions.clearEntity(entity)
end

local function beginChunk(audio, text, timeline)
    local ok, started = pcall(function() return M.player:ConvaiSpeechStart(M.actor, CName.new(audio.event)) end)
    if not ok or not started then
        M.error = tostring(started)
        fallback('playback-failed', M.text); return false
    end
    M.slot, M.duration, M.chunkText = audio.slot, audio.duration, text
    M.state, M.position, M.waited, M.stalled = 'starting', 0, 0, 0
    face.start(M.context, timeline, M.actor, audio.duration)
    publish()
    return true
end

function M.start(context, reply)
    M.stop()
    M.streamReceipt = nil
    local audio = reply.audio
    if not voiceEnabled(Game.GetPlayer()) or not M.available or not validAudio(audio) then
        captions.show(context.name, reply.text, M.target, context.entity); return false
    end
    local descriptor = reply.stream
    if descriptor and (type(descriptor) ~= 'table' or descriptor.version ~= 1
        or type(descriptor.id) ~= 'string' or #descriptor.id > 80
        or type(descriptor.total) ~= 'number' or descriptor.total < 2 or descriptor.total > 32
        or descriptor.total % 1 ~= 0 or type(descriptor.firstText) ~= 'string') then
        captions.show(context.name, reply.text, M.target, context.entity); return false
    end
    local actor, player = M.target, Game.GetPlayer()
    if not actor or not player or tostring(actor:GetEntityID().hash) ~= context.entity then
        M.state = 'target-lost'; publish(); return false
    end
    M.player, M.actor = player, actor
    M.playerID = tostring(player:GetEntityID().hash)
    M.requestId, M.context = context.requestId, {requestId = context.requestId, generation = context.generation,
        entity = context.entity, name = context.name}
    M.speaker, M.text, M.error, M.paused = context.name, reply.text, nil, false
    if descriptor then
        M.stream = {id = descriptor.id, total = descriptor.total, index = 1, completed = 0,
            received = 1, history = {}, poll = 0, wait = 0, gap = 0}
    end
    return beginChunk(audio, descriptor and descriptor.firstText or reply.text, reply.face)
end

function M.abandon()
    -- Unload callback: release Lua references without calling native emitters.
    face.abandon()
    M.streamReceipt = receipt()
    M.stream, M.context, M.target = nil, nil, nil
    M.player, M.actor, M.playerID, M.requestId = nil, nil, nil, nil
    M.slot, M.duration, M.position, M.paused = nil, nil, 0, false
    M.state, M.available = 'idle', false
    publish()
end

local function refreshManifest()
    local s = M.stream
    local f = io.open('runtime/speech-stream.json', 'rb')
    if not f then return end
    local raw = f:read(4000001); f:close()
    if not raw or #raw > 4000000 then return end
    local ok, doc = pcall(json.decode, raw)
    if not ok or type(doc) ~= 'table' or doc.version ~= 1 or doc.streamId ~= s.id
        or doc.requestId ~= M.requestId or doc.entity ~= M.context.entity
        or doc.generation ~= M.context.generation or doc.total ~= s.total
        or type(doc.complete) ~= 'boolean' or type(doc.chunks) ~= 'table'
        or #doc.chunks < s.received or #doc.chunks > s.total then return end
    local duration = 0
    for index, chunk in ipairs(doc.chunks) do
        if type(chunk) ~= 'table' or chunk.index ~= index or not validAudio(chunk.audio)
            or type(chunk.text) ~= 'string' or #chunk.text > 12000 then return end
        duration = duration + chunk.audio.duration
    end
    if duration > 120 or (doc.complete and #doc.chunks ~= s.total and type(doc.error) ~= 'string') then return end
    s.manifest, s.received, s.error = doc, #doc.chunks, doc.error
end

local function advanceStream()
    local s = M.stream
    if not s or M.state ~= 'buffering' then return end
    local doc = s.manifest
    if not doc then return end
    local nextChunk = doc.chunks[s.completed + 1]
    if nextChunk then
        s.index, s.wait = nextChunk.index, 0
        beginChunk(nextChunk.audio, nextChunk.text, nextChunk.face)
    elseif doc.complete then
        if doc.error then fallback('stream-incomplete', M.text) else M.stop('finished') end
    end
end

function M.update(delta)
    local player = Game.GetPlayer()
    M.heartbeat = M.heartbeat + delta
    if M.heartbeat >= 1 then
        M.heartbeat = 0
        M.available = player ~= nil and pcall(function() player:ConvaiSpeechPosition() end)
        publish()
    end
    if not M.requestId then return end
    if not player or tostring(player:GetEntityID().hash) ~= M.playerID then M.abandon(); return end
    if not M.actor:IsAttached() or M.actor:IsDeadNoStatPool() then M.stop('target-lost'); return end
    if not voiceEnabled(player) then
        fallback('muted', M.text); return
    end
    local defs = Game.GetAllBlackboardDefs()
    local paused = Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu)
    if paused ~= M.paused then
        M.player:ConvaiSpeechPause(paused); M.paused = paused; publish()
    end
    if paused then face.pause(M.actor); return end
    local s = M.stream
    if s then
        s.poll = s.poll + delta
        if s.poll >= .075 then s.poll = 0; refreshManifest() end
        if M.state == 'buffering' or M.state == 'starting' then s.gap = s.gap + delta end
        if M.state == 'buffering' then
            s.wait = s.wait + delta
            advanceStream()
            if M.state ~= 'buffering' then return end
            if s.wait > 45 then
                M.error = 'Next speech phrase did not arrive'
                fallback('stream-incomplete', M.text)
            end
            return
        end
    end
    local pos = M.player:ConvaiSpeechPosition()
    M.waited = M.waited + delta
    if pos > (M.position or 0) + .001 then
        M.stalled = 0
        if M.state == 'starting' then
            M.state = 'playing'
            captions.beginTimed(M.speaker, M.chunkText, M.duration, M.actor, M.context.entity)
            if s then
                s.history[#s.history + 1] = {index = s.index, slot = M.slot, duration = M.duration,
                    firstCursor = pos, gapSeconds = s.completed > 0 and math.max(0, s.gap - pos) or 0,
                    startedAt = os.time() * 1000, faceSource = face.source}
                s.gap = 0
            end
            publish()
        end
    else M.stalled = M.stalled + delta end
    local previous = M.position
    M.position = pos
    if M.state == 'playing' and pos >= 0 then
        if captions.enabled() and not captions.timed then captions.beginTimed(M.speaker, M.chunkText, M.duration, M.actor, M.context.entity) end
        captions.syncTimed(pos)
        face.sync(M.actor, pos, M.requestId)
    end
    local ended = pos >= M.duration - .005
        or (pos < 0 and previous and previous >= M.duration - .1)
        or (M.stalled > .25 and pos >= M.duration - .05)
    if ended then
        if not s then M.stop('finished'); return end
        face.stop(M.actor, 'chunk-finished')
        M.player:ConvaiSpeechStop(); captions.clear()
        s.completed, s.wait, s.gap = s.index, 0, 0
        M.state, M.slot, M.position = 'buffering', nil, 0
        publish(); refreshManifest(); advanceStream()
    elseif M.stalled > 3 then
        M.error = 'Native speech playback did not advance'
        fallback('playback-failed', M.text)
    end
end

convaiSpeech = M
return M
