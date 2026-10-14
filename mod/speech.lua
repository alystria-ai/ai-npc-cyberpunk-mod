-- One utterance owns playback. Its renderer's heard position drives faces and
-- captions: native Audioware for Omni, continuous browser PCM for Convai.
-- A temporary buffer gap never advances the group to another speaker.
local M = convaiSpeech or {heartbeat = 0, available = false}
local captions = dofile('subtitles.lua')
-- A speaker without a body (an add-on's voice, docs/ADDON_API.md) has no face: its per-utterance face calls do nothing, while
-- the shared expression frame and status calls still reach the facial player. M.voiceOnly is false for every ordinary reply.
local facial = dofile('facial-playback.lua')
local NO_FACE = {start = true, sync = true, pause = true, stop = true, hold = true, updateContinuous = true,
    beginExpression = true, acceptExpression = true, endExpression = true}
local function noFace() end
local face = setmetatable({}, {__index = function(_, key)
    if M.voiceOnly and NO_FACE[key] then return noFace end
    return facial[key]
end})
local continuous
local function continuousAdapter()
    if continuous then return continuous end
    local ok, value = pcall(dofile, 'continuous-speech.lua')
    if ok and type(value) == 'table' and value.version == 1 and value.available == true
        and type(value.start) == 'function' and type(value.update) == 'function' and type(value.stop) == 'function' then
        continuous = value
        M.continuousAvailable = true
    end
    return continuous
end

local function finite(value)
    return type(value) == 'number' and value == value and math.abs(value) < math.huge
end
-- Reading hold after the last heard sample, and the longest an Omni phrase stays
-- up while the next phrase is still rendering (its start replaces it at once).
local CAPTION_HOLD, PHRASE_HOLD = .6, 3
local function null(value)
    return value == nil or (json.null ~= nil and value == json.null)
end
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
        history = s.history, error = s.error, version = s.version, total = s.total, position = s.position}
end
local function publish()
    local f = io.open('runtime/speech-state.json', 'wb')
    if f then
        local r = receipt()
        f:write(json.encode({available = M.available, continuousAvailable = M.continuousAvailable == true,
            continuousFaceFile = M.continuousAvailable == true and continuous ~= nil and continuous.faceFile == true or nil,
            continuousFaceSegments = M.continuousAvailable == true and continuous ~= nil and continuous.faceSegments == true or nil,
            updated = os.time() * 1000,
            requestId = M.requestId, slot = M.slot, state = M.state or 'idle',
            position = M.position, paused = M.paused, error = M.error, face = face.status(),
            streamId = r and r.id, chunkIndex = r and r.index, completedChunk = r and r.completed,
            receivedChunks = r and r.received, chunks = r and r.history, streamError = r and r.error,
            streamVersion = r and r.version, totalChunks = r and r.total, utterancePosition = r and r.position,
            continuousId = M.continuousId, playbackBackend = M.continuous and 'browser-pcm' or nil,
            continuousControl = M.continuous and continuous and continuous.status() or nil,
            continuousFacePosition = M.continuousFaceCursor,
            continuousFaceLag = M.continuousFaceCursor and M.continuousFaceTarget
                and math.max(0, M.continuousFaceTarget - M.continuousFaceCursor) or nil,
            lastDelivery = M.lastDelivery}))
        f:close()
    end
end

local function completedDelivery()
    local context, stream = M.context, M.stream
    if not context or context.requestId ~= M.requestId
        or type(context.requestId) ~= 'string' or #context.requestId == 0 or #context.requestId > 160
        or type(context.entity) ~= 'string' or #context.entity == 0 or #context.entity > 120
        or type(context.generation) ~= 'number' or context.generation % 1 ~= 0
        or context.generation < 0 or context.generation > 2147483647 then return end
    local total = stream and stream.total or 1
    if stream then
        if not stream.manifest or not stream.manifest.complete or stream.error
            or stream.completed ~= total or stream.nativeCompleted ~= total then return end
    elseif M.continuous then
        if not M.continuousEnded then return end
    elseif not M.nativeCompleted then return end
    -- Keep one small, plain receipt after stop releases the native/request
    -- references. Polling the same receipt must never count as another delivery.
    M.deliverySequence = (M.deliverySequence or 0) + 1
    M.deliverySession = M.deliverySession or (tostring(os.time()) .. '-' .. tostring(math.random(100000000, 999999999)))
    M.lastDelivery = {version = 1, id = 'speech-' .. M.deliverySession .. '-' .. M.deliverySequence,
        sequence = M.deliverySequence, completedAt = os.time() * 1000.0,
        source = M.continuous and 'continuous-playback' or 'native-playback',
        backend = M.continuous and 'browser-pcm' or nil, state = 'completed', partial = false, cancelled = false,
        requestId = context.requestId, entity = context.entity, generation = context.generation,
        conversationGeneration = context.generation, totalChunks = total, completedChunks = total}
end

local function finish()
    completedDelivery()
    M.stop('finished')
end

function M.stop(reason)
    if M.context and M.utterance and M.utterance.requestId == M.requestId then
        local delivered = M.lastDelivery
        M.utterance.finished, M.utterance.failed = true, reason ~= 'finished'
        M.utterance.delivered = delivered ~= nil and delivered.requestId == M.requestId
            and delivered.entity == M.context.entity and delivered.generation == M.context.generation
            and delivered.sequence > M.utterance.startSequence
    end
    if continuous then continuous.stop() end
    if face.endExpression then face.endExpression(M.context,reason=='finished') end
    face.stop(M.actor, reason)
    if M.player and not M.continuous then pcall(function() M.player:ConvaiSpeechStop() end) end
    if M.requestId then
        -- Heard to the end: hold the last page briefly (it owns nothing, so the
        -- next speaker replaces it at once). Any other stop removes it now.
        if reason == 'finished' and type(captions.linger) == 'function' then captions.linger(CAPTION_HOLD)
        else captions.clear() end
    end
    M.streamReceipt = receipt()
    M.captionHidden = nil
    M.stream, M.context, M.nativeCompleted = nil, nil, nil
    M.continuous, M.continuousEnded, M.continuousId, M.continuousCaptions = nil, nil, nil, nil
    M.continuousFaceCursor, M.continuousFaceTarget, M.continuousFaceState, M.continuousHeardAll = nil, nil, nil, nil
    M.player, M.actor, M.requestId, M.slot, M.duration = nil, nil, nil, nil, nil
    M.state, M.position, M.paused = reason or 'idle', nil, false
    M.voiceOnly, M.holocall = false, false
    publish()
end

function M.transcript(requestId, generation, entity)
    local value = M.utterance
    if not value or value.requestId ~= requestId or value.generation ~= generation or value.entity ~= entity then return nil end
    return {requestId=value.requestId,generation=value.generation,entity=value.entity,text=value.text,
        streamVersion=value.streamVersion,streamId=value.streamId,textComplete=value.textComplete,
        finished=value.finished,failed=value.failed,delivered=value.delivered}
end

local function fallback(reason, text)
    local name, actor, entity = M.speaker, M.actor, M.context and M.context.entity
    local heard = M.continuousHeardAll == true
    M.stop(reason)
    -- A reply that was already heard to its end (its last state said so) has nothing left to show: re-showing the whole written text
    -- after the voice is done would leave the subtitle on screen for its reading time.
    if heard then return end
    captions.show(name, text, actor, entity)
end

function M.clearEntity(entity)
    if M.context and M.context.entity == entity then M.stop('target-dismissed') end
    if M.target then
        local ok, current = pcall(function() return tostring(M.target:GetEntityID().hash) end)
        if ok and current == entity then M.target = nil end
    end
    captions.clearEntity(entity)
    if face.clearExpression then face.clearExpression(entity) end
end

local function beginChunk(audio, text, timeline, startSeconds)
    -- A holocall reply is heard through the phone: the sound plays on V at full volume (the live picture's copy, which
    -- still gets the face, is far away). Every other reply plays on its speaker.
    local emitter = M.holocall and M.player or M.actor
    local ok, started = pcall(function() return M.player:ConvaiSpeechStart(emitter, CName.new(audio.event)) end)
    if not ok or not started then
        M.error = tostring(started)
        fallback('playback-failed', M.text); return false
    end
    M.slot, M.duration, M.chunkText = audio.slot, audio.duration, text
    if M.stream and M.stream.version == 2 then M.stream.chunkStart = startSeconds or 0 end
    M.state, M.position, M.waited, M.stalled = 'starting', 0, 0, 0
    local expected = M.stream and M.stream.version == 2
        and {index = M.stream.index, startSeconds = M.stream.chunkStart} or nil
    face.start(M.context, timeline, M.actor, audio.duration, expected)
    publish()
    return true
end

-- Lip sync delay (Bluetooth), resolved by the bridge (bridge/audio-delay.mjs):
-- audio heard after the Windows mix. The browser voices apply it in their own
-- clock; the native Omni phrases subtract it here from the Audioware cursor
-- for the face and subtitles. Read once per utterance, never per frame.
local function readOutputDelay()
    local ok, value = pcall(function()
        local file = io.open('runtime/audio-delay.json', 'rb')
        if not file then return 0 end
        local raw = file:read(512); file:close()
        local doc = json.decode(raw)
        local delay = type(doc) == 'table' and tonumber(doc.delayMs) or 0
        return delay == delay and math.max(0, math.min(500, delay)) / 1000 or 0
    end)
    return ok and value or 0
end

function M.start(context, reply)
    M.stop()
    M.voiceOnly = context.voiceOnly == true
    captions.voiceOnly = M.voiceOnly
    -- A holocall turn (mod/holocall.lua): full volume with no distance, and the call's subtitle line.
    M.holocall = type(context.holocall) == 'table'
    captions.holocall = M.holocall
    captions.voiceProfile = M.voiceOnly and context.profileKey or nil
    -- An add-on remark whose speaker shows the text itself (addons.lua handle:speaker showsReply) is heard without a subtitle: asked once
    -- here, and every caption call below that follows the voice is skipped. A subtitle shown because the voice could not play (the
    -- captions.show calls) is never skipped, so the text is not lost. Anything that is not an add-on remark is never asked.
    M.captionHidden = nil
    if M.voiceOnly and type(M.hideCaption) == 'function' then
        local ok, hidden = pcall(M.hideCaption, context.profileKey, context.requestId)
        if ok and hidden == true then M.captionHidden = true; captions.clear() end
    end
    M.outputDelay = readOutputDelay()
    M.streamReceipt = nil
    if reply.continuous ~= nil then
        local controller, player, actor = continuousAdapter(), Game.GetPlayer(), M.target
        if not controller or not voiceEnabled(player) then
            captions.show(context.name, reply.text, actor, context.entity); return false
        end
        local paused = true
        pcall(function()
            local defs = Game.GetAllBlackboardDefs()
            paused = Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu)
        end)
        -- An add-on voice may be heard from its own object (addons.lua voiceFrom: Skippy's gun), asked once here for this reply.
        local source = nil
        if M.voiceOnly and type(M.voiceSource) == 'function' then
            local ok, object = pcall(M.voiceSource, context.profileKey, player)
            source = ok and object or nil
        end
        local accepted, reason = controller.start(context, reply.continuous, player, actor, paused, source)
        if not accepted then
            M.state, M.error = 'playback-failed', reason
            captions.show(context.name, reply.text, actor, context.entity); publish(); return false
        end
        M.player, M.actor, M.playerID = player, actor, tostring(player:GetEntityID().hash)
        M.requestId, M.context = context.requestId, {requestId=context.requestId,generation=context.generation,
            entity=context.entity,name=context.name}
        if face.beginExpression then face.beginExpression(M.context,reply.expression) end
        M.speaker, M.text, M.error, M.paused = context.name, reply.text, nil, paused
        M.continuous, M.continuousId, M.continuousEnded = true, reply.continuous.id, false
        M.continuousFaceCursor, M.continuousFaceTarget, M.continuousFaceState = nil, nil, nil
        M.state, M.position, M.duration = 'starting', 0, 0
        M.continuousCaptions = {text=reply.text,bufferedDuration=0,position=0,final=false}
        -- Version 2 transcript semantics mean one evolving utterance, not a
        -- sequence of text-generation calls or independent audio clips.
        M.utterance = {requestId=context.requestId,generation=context.generation,entity=context.entity,text=reply.text,
            streamVersion=2,streamId=reply.continuous.id,textComplete=false,finished=false,failed=false,
            delivered=false,startSequence=M.deliverySequence or 0}
        publish(); return true
    end
    local audio = reply.audio
    if not voiceEnabled(Game.GetPlayer()) or not M.available or not validAudio(audio) then
        captions.show(context.name, reply.text, M.target, context.entity); return false
    end
    local descriptor = reply.stream
    if descriptor and (type(descriptor) ~= 'table' or (descriptor.version ~= 1 and descriptor.version ~= 2)
        or type(descriptor.id) ~= 'string' or #descriptor.id > 80
        or type(descriptor.firstText) ~= 'string' or #descriptor.firstText > 12000
        or (descriptor.version == 1 and (not finite(descriptor.total) or descriptor.total < 2
            or descriptor.total > 32 or descriptor.total % 1 ~= 0))
        or (descriptor.version == 2 and (not null(descriptor.total) or descriptor.captionMode ~= 'utterance'
            or not descriptor.firstText:find('%S') or type(descriptor.textComplete) ~= 'boolean'
            or not finite(descriptor.bufferedDuration) or descriptor.bufferedDuration < audio.duration
            or descriptor.bufferedDuration > 120 or audio.duration < .05 or audio.duration > 4.05))) then
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
    if face.beginExpression then face.beginExpression(M.context,reply.expression) end
    M.speaker, M.text, M.error, M.paused = context.name, reply.text, nil, false
    M.utterance = {requestId=context.requestId,generation=context.generation,entity=context.entity,
        text=reply.text,streamVersion=descriptor and descriptor.version,streamId=descriptor and descriptor.id,
        textComplete=not descriptor or descriptor.version~=2 or descriptor.textComplete==true,
        finished=false,failed=false,delivered=false,startSequence=M.deliverySequence or 0}
    if descriptor then
        M.stream = {id = descriptor.id, version = descriptor.version,
            total = descriptor.version == 1 and descriptor.total or nil, index = 1, completed = 0,
            nativeCompleted = 0, received = 1, history = {}, poll = 0, wait = 0, gap = 0}
        if descriptor.version == 2 then
            M.stream.text, M.stream.bufferedDuration = descriptor.firstText, descriptor.bufferedDuration
            M.stream.position, M.stream.chunkStart = 0, 0
            M.stream.firstAudio = {slot = audio.slot, event = audio.event, duration = audio.duration}
        end
    end
    return beginChunk(audio, descriptor and descriptor.firstText or reply.text, reply.face)
end

function M.abandon()
    -- Unload callback: release Lua references without calling native emitters.
    -- The page of an utterance that was being heard must not wait for the driver that is going away: hold it briefly (pure Lua state,
    -- no native call) and let the subtitle timer remove it.
    if M.requestId and type(captions.linger) == 'function' and captions.timed then captions.linger(CAPTION_HOLD) end
    if continuous then continuous.stop() end
    face.abandon()
    M.captionHidden = nil
    M.streamReceipt = receipt()
    M.stream, M.context, M.target, M.nativeCompleted = nil, nil, nil, nil
    M.utterance = nil
    M.continuous, M.continuousEnded, M.continuousId, M.continuousCaptions = nil, nil, nil, nil
    M.continuousFaceCursor, M.continuousFaceTarget, M.continuousFaceState, M.continuousHeardAll = nil, nil, nil, nil
    M.player, M.actor, M.playerID, M.requestId = nil, nil, nil, nil
    M.voiceOnly, M.holocall = false, false
    M.slot, M.duration, M.position, M.paused = nil, nil, 0, false
    M.state, M.available = 'idle', false
    publish()
end

local function refreshManifest()
    local s = M.stream
    local dynamic = s.version == 2
    local f = io.open('runtime/speech-stream.json', 'rb')
    if not f then return end
    local raw = f:read(4000001); f:close()
    if not raw or #raw > 4000000 then return end
    local ok, doc = pcall(json.decode, raw)
    if not ok or type(doc) ~= 'table' or doc.version ~= (s.version or 1) or doc.streamId ~= s.id
        or doc.requestId ~= M.requestId or doc.entity ~= M.context.entity
        or doc.generation ~= M.context.generation
        or type(doc.complete) ~= 'boolean' or type(doc.chunks) ~= 'table'
        or #doc.chunks < s.received or #doc.chunks > (dynamic and 128 or s.total) then return end
    if dynamic then
        if doc.captionMode ~= 'utterance' or type(doc.text) ~= 'string' or #doc.text > 12000 or not doc.text:find('%S')
            or type(doc.textComplete) ~= 'boolean' or not finite(doc.bufferedDuration)
            or (not doc.complete and not null(doc.total))
            or (doc.complete and (not finite(doc.total) or doc.total % 1 ~= 0 or doc.total < 1
                or doc.total ~= #doc.chunks or (not doc.error and not doc.textComplete)))
            or (s.final and (not doc.complete or doc.total ~= s.total or doc.text ~= s.text or doc.error ~= s.error))
            or (not null(doc.error) and (not doc.complete or type(doc.error) ~= 'string' or #doc.error > 240)) then return end
    elseif doc.total ~= s.total then return end
    local duration = 0
    for index, chunk in ipairs(doc.chunks) do
        if type(chunk) ~= 'table' or chunk.index ~= index or not validAudio(chunk.audio)
            or type(chunk.text) ~= 'string' or #chunk.text > 12000 then return end
        if dynamic then
            if not finite(chunk.startSeconds) or math.abs(chunk.startSeconds - duration) > .0001
                or chunk.audio.duration < .05 or chunk.audio.duration > 4.05 then return end
            -- Already admitted files cannot change underneath the native ring
            -- buffer. The initial descriptor owns chunk one before any poll.
            local previous = s.manifest and s.manifest.chunks[index]
            local oldAudio = previous and previous.audio or (index == 1 and s.firstAudio)
            if oldAudio and (oldAudio.slot ~= chunk.audio.slot or oldAudio.event ~= chunk.audio.event
                or math.abs(oldAudio.duration - chunk.audio.duration) > .0001
                or (previous and (previous.startSeconds ~= chunk.startSeconds or previous.text ~= chunk.text))) then return end
        end
        duration = duration + chunk.audio.duration
    end
    if duration > 120 or (not dynamic and doc.complete and #doc.chunks ~= s.total and type(doc.error) ~= 'string') then return end
    if dynamic and math.abs(duration - doc.bufferedDuration) > .0001 then return end
    if dynamic then
        s.total, s.final, s.text, s.bufferedDuration = doc.complete and doc.total or nil, doc.complete, doc.text, duration
        M.text = doc.text
        M.utterance.text, M.utterance.textComplete, M.utterance.failed = doc.text, doc.textComplete, doc.error ~= nil
    end
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
        beginChunk(nextChunk.audio, nextChunk.text, nextChunk.face, nextChunk.startSeconds)
    elseif doc.complete then
        if doc.error then fallback('stream-incomplete', M.text) else finish() end
    end
end

local function syncUtterance(position)
    local s = M.stream or M.continuousCaptions
    s.position = math.max(s.position or 0, position)
    if M.captionHidden or not captions.enabled() then return end
    -- Continuous speech carries audio-aligned cues (bridge/caption-cues.mjs);
    -- a new cue revision re-times the pages without redisplaying them.
    local cues = M.continuousCaptions == s and s.cues or nil
    local revision = type(cues) == 'table' and cues.revision or nil
    local changed = s.captionText ~= s.text or s.captionFinal ~= s.final or s.captionRevision ~= revision
    if changed or not captions.timed then
        local words, chars = 0, 0
        for _ in s.text:gmatch('%S+') do words = words + 1 end
        for _ in s.text:gmatch('[%z\1-\127\194-\244][\128-\191]*') do chars = chars + 1 end
        -- Text can finish before audio arrives. Until final PCM duration is
        -- known, use one conservative utterance estimate, not chunk lengths.
        local duration = s.final and s.bufferedDuration
            or math.min(120, math.max(s.bufferedDuration, words / 2.5, chars / 14) + .5)
        local revised = captions.timed and type(captions.reviseTimed) == 'function'
            and captions.reviseTimed(s.text, duration, s.position, cues)
        if not revised then
            captions.beginTimed(M.speaker, s.text, duration, M.actor, M.context.entity, cues)
        end
        s.captionText, s.captionFinal, s.captionRevision = s.text, s.final, revision
    end
    captions.syncTimed(s.position)
end

function M.pauseForWorld()
    if M.continuous and continuous and not continuous.pause() then M.abandon() end
end

-- A live-loaded diagnostic can inspect this explicit cached seam without
-- inspecting Lua closure internals or retaining an actor/controller handle.
function M.diagnosticCadence()
    if not M.requestId or not M.continuous or not continuous
        or type(continuous.diagnosticCadence) ~= 'function' then return nil end
    local value = continuous.diagnosticCadence()
    if not value then return nil end
    value.confirmedTarget, value.faceCursor = M.continuousFaceTarget, M.continuousFaceCursor
    value.speechPosition = M.position
    return value
end

local function updateContinuous(delta, player, paused)
    local state, problem = continuous.update(delta, player, M.actor, paused)
    if problem then M.error=problem;fallback('playback-failed', M.text);return end
    if paused then M.continuousFaceCursor=nil;face.pause(M.actor);return end
    if state then
        -- The source/audio/subtitle position remains the exact device report.
        M.position, M.duration, M.text, M.state = state.position, state.bufferedDuration, state.text, state.state
        M.utterance.text, M.utterance.textComplete = state.text, state.textComplete
        if face.acceptExpression then face.acceptExpression(M.context,state.expression) end
        local caption = M.continuousCaptions
        caption.text, caption.bufferedDuration, caption.final = state.text, state.bufferedDuration, state.complete
        caption.cues = type(state.captions) == 'table' and state.captions or nil
        if type(state.face) == 'table' and state.bufferedDuration > 0 and type(face.updateContinuous) == 'function' then
            -- A separately published timeline (faceDuration) may trail the buffered audio by one refresh.
            face.updateContinuous(M.context, state.face, M.actor, state.faceDuration or state.bufferedDuration)
        end
        M.continuousFaceTarget = math.max(M.continuousFaceTarget or 0, state.position)
        M.continuousFaceState = state.state
        M.continuousHeardAll = state.complete == true and state.textComplete == true and state.bufferedDuration > 0
            and state.position >= state.bufferedDuration - .3
        if state.position > 0 then syncUtterance(state.position) end
        if state.ended then
            -- EOF alone cannot confirm delivery: the renderer must have drained
            -- the one audio queue and reported the heard device cursor as well.
            M.continuousEnded = true
            finish();return
        end
    end
    local target = M.continuousFaceTarget
    if not target or target <= 0 then return end
    if M.continuousFaceState ~= 'playing' and M.continuousFaceState ~= 'draining' then
        M.continuousFaceCursor=nil;face.pause(M.actor);return
    end
    -- Device reports arrive about every 40 ms; native facial poses must not be
    -- limited to that file cadence. Chase only confirmed, already-heard audio
    -- each game frame, with at most 80 ms of deliberate past lag. This never
    -- predicts future samples: absent reports stop the cursor at the known
    -- target, even if the browser has paused/underrun since its last report.
    local step = finite(delta) and math.max(0, math.min(.08, delta)) or 0
    local cursor = M.continuousFaceCursor or target
    cursor = math.min(target, math.max(cursor, target-.08) + step)
    M.continuousFaceCursor = cursor
    face.sync(M.actor, cursor, M.requestId)
end

local function updateSpeech(delta)
    local player = Game.GetPlayer()
    M.heartbeat = M.heartbeat + delta
    -- speech-state.json lease: the bridge keeps it 5 s. Written in a frame no other heartbeat writes in.
    local slot = M.heartbeat >= 2 and convaiHeartbeatSlot
    if M.heartbeat >= 2 and (type(slot) ~= 'function' or slot()) then
        M.heartbeat = 0
        continuousAdapter()
        if not M.continuous then M.available = player ~= nil and pcall(function() player:ConvaiSpeechPosition() end) end
        publish()
    end
    if not M.requestId then return end
    if not player or tostring(player:GetEntityID().hash) ~= M.playerID then M.abandon(); return end
    if not M.actor:IsAttached() or (not M.voiceOnly and M.actor:IsDeadNoStatPool()) then M.stop('target-lost'); return end
    if not voiceEnabled(player) then
        fallback('muted', M.text); return
    end
    local defs = Game.GetAllBlackboardDefs()
    local paused = Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu)
    if paused ~= M.paused then
        if not M.continuous then M.player:ConvaiSpeechPause(paused) end
        M.paused = paused; publish()
    end
    if M.continuous then updateContinuous(delta, player, paused);return end
    if paused then face.pause(M.actor); return end
    local s = M.stream
    if s then
        s.poll = s.poll + delta
        if s.poll >= .075 then s.poll = 0; refreshManifest() end
        if M.state == 'buffering' or M.state == 'starting' then s.gap = s.gap + delta end
        if M.state == 'buffering' then
            s.wait = s.wait + delta
            if s.version == 2 and s.wait > .2 then face.stop(M.actor, 'buffering') end
            if s.version == 2 then syncUtterance(s.position) end
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
    if s and s.version == 2 and M.state == 'starting' and M.waited > .2 and pos <= 0 then face.pause(M.actor) end
    if pos > (M.position or 0) + .001 then
        M.stalled = 0
        if M.state == 'starting' then
            M.state = 'playing'
            if not M.captionHidden and (not s or s.version ~= 2) then captions.beginTimed(M.speaker, M.chunkText, M.duration, M.actor, M.context.entity) end
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
        -- The face and subtitles follow the heard cursor (Lip sync delay setting).
        local heard = math.max(0, pos - (M.outputDelay or 0))
        if s and s.version == 2 then syncUtterance(s.chunkStart + heard)
        else
            if not M.captionHidden then
                if captions.enabled() and not captions.timed then captions.beginTimed(M.speaker, M.chunkText, M.duration, M.actor, M.context.entity) end
                captions.syncTimed(heard)
            end
        end
        face.sync(M.actor, heard, M.requestId)
    end
    local ended = pos >= M.duration - .005
        or (pos < 0 and previous and previous >= M.duration - .1)
        or (M.stalled > .25 and pos >= M.duration - .05)
    if ended then
        -- Near-end stalls/negative cursors still release an emitter as before,
        -- but only an observed final native cursor can confirm full delivery.
        local nativeCompleted = M.state == 'playing' and (pos >= M.duration - .005
            or (pos < 0 and previous and previous >= M.duration - .005))
        if not s then M.nativeCompleted = nativeCompleted; finish(); return end
        if s.version == 2 and type(face.hold) == 'function' then face.hold(M.actor, M.requestId)
        else face.stop(M.actor, 'chunk-finished') end
        M.player:ConvaiSpeechStop()
        -- One Omni phrase is over: keep it up until the next phrase is heard.
        if not s or s.version ~= 2 then
            if type(captions.linger) == 'function' then captions.linger(PHRASE_HOLD) else captions.clear() end
        end
        if nativeCompleted then s.nativeCompleted = (s.nativeCompleted or 0) + 1 end
        s.completed, s.wait, s.gap = s.index, 0, 0
        M.state, M.slot, M.position = 'buffering', nil, 0
        publish(); refreshManifest(); advanceStream()
    elseif M.stalled > 3 then
        M.error = 'Native speech playback did not advance'
        fallback('playback-failed', M.text)
    end
end

-- init supplies current actor rows for this frame only. The speech cursor and
-- feature interpolation above keep their accepted timing; idle actors use the
-- same final writer after the current speaker has had its one write.
function M.update(delta,expressionContext)
    if face.beginExpressionFrame then face.beginExpressionFrame(delta,expressionContext) end
    updateSpeech(delta)
    if face.updateExpressions then face.updateExpressions(expressionContext) end
end

convaiSpeech = M
return M
