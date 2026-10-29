local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end
-- One utterance owns playback. Its renderer's heard position (the continuous browser PCM the bridge feeds, mod/continuous-speech.lua)
-- drives faces and captions. A temporary buffer gap never advances the group to another speaker.
-- available: the continuous adapter loaded, the only way a reply is voiced (published in speech-state.json).
local M = convaiSpeech or {heartbeat = 0, available = false}
local captions = dofile('subtitles.lua')
-- A speaker without a body (an add-on's voice, docs/ADDON_API.md) has no face: its per-utterance face calls do nothing (unless it has
-- a face on a screen, below), while the shared expression frame and status calls still reach the facial player. M.voiceOnly is false
-- for every ordinary reply.
local facial = dofile('facial-playback.lua')
local NO_FACE = {start = true, sync = true, pause = true, stop = true, hold = true, updateContinuous = true,
    beginExpression = true, acceptExpression = true, endExpression = true}
local function noFace() end
-- An add-on speaker with a face on a screen (addons.lua faceActor, asked once per reply through M.faceSource: the Delamain cab's
-- seat-back screen NPC) gets its per-utterance face calls on that NPC instead, under that NPC's own entity: the reply's timeline is
-- re-addressed to it (a shallow copy of the table per start or new continuous revision, never per frame; the frame rows are shared).
-- Its expression calls stay off. Without such a face (every ordinary reply, every other add-on voice) nothing here runs.
local function screenTimeline(timeline)
    if type(timeline) ~= 'table' then return timeline end
    local copy = {}
    for key, value in pairs(timeline) do copy[key] = value end
    copy.entity = M.faceEntity
    return copy
end
local screenFace = {
    start = function(_, timeline, _, duration, expected)
        return facial.start(M.faceContext, screenTimeline(timeline), M.faceActor, duration, expected)
    end,
    updateContinuous = function(_, timeline, _, duration)
        return facial.updateContinuous(M.faceContext, screenTimeline(timeline), M.faceActor, duration)
    end,
    sync = function(_, position, requestId) return facial.sync(M.faceActor, position, requestId) end,
    pause = function() return facial.pause(M.faceActor) end,
    stop = function(_, reason) return facial.stop(M.faceActor, reason) end,
    hold = function(_, requestId) return facial.hold(M.faceActor, requestId) end,
}
-- The screen face may not exist yet when the reply starts: the Delamain cab's seat-back NPC is spawned by the game's scene as V sits,
-- after the held welcome was already written and voiced (live test 2026-10-15: the welcome's face was asked for 2 s before V sat and
-- never again, so only the later lines moved the face). M.faceSource then answers nil plus `pending` (the speaker has a watched screen
-- face that is not ready). Such a reply asks again every FACE_RETRY seconds while its voice plays (never while it is paused or held),
-- at most FACE_RETRIES times, and the face joins at the heard position. Every other reply never retries.
local FACE_RETRY, FACE_RETRIES = .25, 40
local function findScreenFace(profileKey, context)
    local ok, npc, pending = pcall(M.faceSource, profileKey, convaiPlayer())
    local known, entity = false, nil
    if ok and npc then known, entity = pcall(function() return tostring(npc:GetEntityID().hash) end) end
    if not (known and type(entity) == 'string' and entity:match('^%d+ULL$')) then return false, ok and pending == true end
    M.faceActor, M.faceEntity = npc, entity
    M.faceContext = {requestId = context.requestId, generation = context.generation, entity = entity, name = context.name}
    facial.screenEntity = entity
    return true
end
local face = setmetatable({}, {__index = function(_, key)
    if M.voiceOnly and NO_FACE[key] then return M.faceActor and screenFace[key] or noFace end
    return facial[key]
end})
-- Whether the voice is paused now. A game menu pauses it, unless the add-on remark asked to play through menus (M.menuRequest: the
-- Delamain cab's welcome while the destination map is open); an add-on remark held until its moment (M.holdRequest) stays paused.
-- Two field compares; both fields are nil without add-ons.
local function pausedFor(requestId, inMenu)
    if requestId and M.holdRequest == requestId then return true end
    if inMenu and requestId and M.menuRequest == requestId then return false end
    return inMenu
end
local continuous
local function continuousAdapter()
    if continuous then return continuous end
    local ok, value = pcall(dofile, 'continuous-speech.lua')
    if ok and type(value) == 'table' and value.version == 1 and value.available == true
        and type(value.start) == 'function' and type(value.update) == 'function' and type(value.stop) == 'function' then
        continuous = value
        M.continuousAvailable, M.available = true, true
    end
    return continuous
end

local function finite(value)
    return type(value) == 'number' and value == value and math.abs(value) < math.huge
end
-- Reading hold after the last heard sample.
local CAPTION_HOLD = .6
-- object:method() for a method without arguments, inside the caller's pcall: no closure per call.
local function invoke(object, method) return object[method](object) end
local function voiceEnabled(player)
    if not player then return false end
    local ok, enabled = pcall(invoke, player, 'ConvaiManagerVoice')
    return not ok or enabled
end
local function publish()
    local f = io.open('runtime/speech-state.json', 'wb')
    if f then
        f:write(json.encode({available = M.available, continuousAvailable = M.continuousAvailable == true,
            continuousFaceFile = M.continuousAvailable == true and continuous ~= nil and continuous.faceFile == true or nil,
            continuousFaceSegments = M.continuousAvailable == true and continuous ~= nil and continuous.faceSegments == true or nil,
            updated = os.time() * 1000,
            requestId = M.requestId, state = M.state or 'idle',
            position = M.position, paused = M.paused, error = M.error, face = face.status(),
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
    local context = M.context
    if not context or context.requestId ~= M.requestId
        or type(context.requestId) ~= 'string' or #context.requestId == 0 or #context.requestId > 160
        or type(context.entity) ~= 'string' or #context.entity == 0 or #context.entity > 120
        or type(context.generation) ~= 'number' or context.generation % 1 ~= 0
        or context.generation < 0 or context.generation > 2147483647 then return end
    if not M.continuous or not M.continuousEnded then return end
    -- Keep one small, plain receipt after stop releases the request
    -- references. Polling the same receipt must never count as another delivery.
    M.deliverySequence = (M.deliverySequence or 0) + 1
    M.deliverySession = M.deliverySession or (tostring(os.time()) .. '-' .. tostring(math.random(100000000, 999999999)))
    M.lastDelivery = {version = 1, id = 'speech-' .. M.deliverySession .. '-' .. M.deliverySequence,
        sequence = M.deliverySequence, completedAt = os.time() * 1000.0,
        source = 'continuous-playback', backend = 'browser-pcm', state = 'completed', partial = false, cancelled = false,
        requestId = context.requestId, entity = context.entity, generation = context.generation,
        conversationGeneration = context.generation, totalChunks = 1, completedChunks = 1}
end

local function finish()
    completedDelivery()
    M.stop('finished')
end

function M.stop(reason)
    -- The AI line is over: the game's own ambient barks may play again after a short tail (vanilla-reactions.lua). One event.
    if M.requestId and convaiVanillaReactions then pcall(convaiVanillaReactions.speechEnded) end
    local stoppedId = M.requestId
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
    if M.faceEntity then facial.clearExpression(M.faceEntity); facial.screenEntity = nil end
    M.faceActor, M.faceEntity, M.faceContext, M.faceRetry = nil, nil, nil, nil
    if M.requestId then
        -- Heard to the end: hold the last page briefly (it owns nothing, so the
        -- next speaker replaces it at once). Any other stop removes it now.
        if reason == 'finished' and type(captions.linger) == 'function' then captions.linger(CAPTION_HOLD)
        else captions.clear() end
    end
    M.captionHidden = nil
    M.context = nil
    M.continuous, M.continuousEnded, M.continuousId, M.continuousCaptions = nil, nil, nil, nil
    M.continuousFaceCursor, M.continuousFaceTarget, M.continuousFaceState, M.continuousHeardAll = nil, nil, nil, nil
    M.player, M.actor, M.requestId, M.duration = nil, nil, nil, nil
    M.state, M.position, M.paused = reason or 'idle', nil, false
    M.voiceOnly, M.holocall, M.head = false, false, false
    publish()
    -- A line that was playing has ended (reason 'finished': heard to its end): the speak-up scheduler's cue (mod/init.lua convaiSpeakUpStopped). Set by init.lua.
    if stoppedId and M.onStopped then pcall(M.onStopped, stoppedId, reason or 'idle') end
end

function M.transcript(requestId, generation, entity)
    local value = M.utterance
    if not value or value.requestId ~= requestId or value.generation ~= generation or value.entity ~= entity then return nil end
    return {requestId=value.requestId,generation=value.generation,entity=value.entity,text=value.text,
        streamVersion=value.streamVersion,streamId=value.streamId,textComplete=value.textComplete,
        finished=value.finished,failed=value.failed,delivered=value.delivered}
end

-- The written text of a reply that could not be voiced. The voice notice says replies show as text, so the text shows whatever the Subtitles setting
-- says (captions.showAnyway); an automatic reaction (a bark) keeps the setting, and a reply the player turned the voice off for is not a failure.
local function showUnvoiced(reaction, name, text, actor, entity)
    if not reaction and type(captions.showAnyway) == 'function' then return captions.showAnyway(name, text, actor, entity) end
    return captions.show(name, text, actor, entity)
end

local function fallback(reason, text)
    local name, actor, entity = M.speaker, M.actor, M.context and M.context.entity
    local heard = M.continuousHeardAll == true
    -- An automatic reaction, and a voice the player turned off while the reply played ('muted'), keep the Subtitles setting.
    local reaction = M.reactionReply == true or reason == 'muted'
    M.stop(reason)
    -- A reply that was already heard to its end (its last state said so) has nothing left to show: re-showing the whole written text
    -- after the voice is done would leave the subtitle on screen for its reading time.
    if heard then return end
    showUnvoiced(reaction, name, text, actor, entity)
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

-- One probe line per holocall reply (mod/holocall.lua): how her voice is played and its level, so a call whose voice was not
-- heard can be told from one that played. A few guarded reads once per reply, never per frame.
local function noteHolocallVoice(path, level)
    if not M.holocall or M.holocallNoted or type(M.log) ~= 'function' then return end
    M.holocallNoted = true
    local line = 'Holocall voice: path=' .. path
    if level then line = line .. string.format(' level=%.2f', level) end
    pcall(M.log, line)
end

function M.start(context, reply)
    M.stop()
    -- A named character of the game is voiced only while the game leaves it alone (mod/world-talk.lua, set by init.lua; nil for
    -- every other speaker): a scene or fight that began since V asked drops the reply before anything is heard or shown.
    local storyGuard = M.storyGuard
    if storyGuard and storyGuard(M.target, context, true) == true then return false end
    M.holocallNoted = nil
    M.reactionReply = context.reaction ~= nil and context.reaction ~= false
    M.voiceOnly = context.voiceOnly == true
    captions.voiceOnly = M.voiceOnly
    -- A holocall turn (mod/holocall.lua): full volume with no distance, and the call's subtitle line.
    M.holocall = type(context.holocall) == 'table'
    captions.holocall = M.holocall
    -- Johnny in V's head (mod/johnny-head.lua): V's own sound like a holocall, no face, and his ordinary dialogue line (voiceOnly).
    M.head = type(context.head) == 'table'
    captions.voiceProfile = M.voiceOnly and context.profileKey or nil
    -- An add-on remark whose speaker shows the text itself (addons.lua handle:speaker showsReply) is heard without a subtitle: asked once
    -- here, and every caption call below that follows the voice is skipped. A subtitle shown because the voice could not play (the
    -- captions.show calls) is never skipped, so the text is not lost. Anything that is not an add-on remark is never asked.
    M.captionHidden = nil
    if M.voiceOnly and not M.head and type(M.hideCaption) == 'function' then
        local ok, hidden = pcall(M.hideCaption, context.profileKey, context.requestId)
        if ok and hidden == true then M.captionHidden = true; captions.clear() end
    end
    -- An add-on speaker's face on a screen (see screenFace above), asked once for this reply; asked again while it plays when the
    -- face is not there yet (findScreenFace above).
    if M.voiceOnly and not M.holocall and type(M.faceSource) == 'function' then
        local found, pending = findScreenFace(context.profileKey, context)
        if not found and pending then
            M.faceRetry = {profileKey = context.profileKey, wait = 0, tries = 0, elapsed = 0,
                context = {requestId = context.requestId, generation = context.generation, name = context.name}}
        end
    end
    if type(reply.continuous) ~= 'table' then
        -- A reply without a continuous voice has none: its text shows as the voice notice promises (never played from reply.audio).
        local player = convaiPlayer()
        if voiceEnabled(player) then showUnvoiced(M.reactionReply, context.name, reply.text, M.target, context.entity)
        else captions.show(context.name, reply.text, M.target, context.entity) end
        return false
    end
    local controller, player, actor = continuousAdapter(), convaiPlayer(), M.target
    if not controller or not voiceEnabled(player) then
        -- No voice by the player's choice keeps the Subtitles setting; no voice engine to play it is a failure: the text shows.
        if voiceEnabled(player) then showUnvoiced(M.reactionReply, context.name, reply.text, actor, context.entity)
        else captions.show(context.name, reply.text, actor, context.entity) end
        return false
    end
    local paused = true
    pcall(function()
        local defs = Game.GetAllBlackboardDefs()
        paused = Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu)
    end)
    paused = pausedFor(context.requestId, paused)
    -- An add-on voice may be heard from its own object (addons.lua voiceFrom: Skippy's gun), asked once here for this reply.
    local source = nil
    if M.voiceOnly and not M.head and type(M.voiceSource) == 'function' then
        local ok, object = pcall(M.voiceSource, context.profileKey, player)
        source = ok and object or nil
    end
    local accepted, reason = controller.start(context, reply.continuous, player, actor, paused, source)
    if not accepted then
        M.state, M.error = 'playback-failed', reason
        showUnvoiced(M.reactionReply, context.name, reply.text, actor, context.entity); publish(); return false
    end
    M.player, M.actor, M.playerID = player, actor, tostring(player:GetEntityID().hash)
    if M.holocall then
        local known, status = pcall(controller.status)
        noteHolocallVoice('browser', known and type(status) == 'table' and status.volume or nil)
    end
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
    -- An AI line plays: the game's own ambient barks of the NPCs around V stay silent until it ends (vanilla-reactions.lua). One event.
    if convaiVanillaReactions then pcall(convaiVanillaReactions.speechStarted) end
    publish(); return true
end

function M.abandon()
    -- Unload callback: release Lua references without native calls.
    -- The page of an utterance that was being heard must not wait for the driver that is going away: hold it briefly (pure Lua state,
    -- no native call) and let the subtitle timer remove it.
    if M.requestId and type(captions.linger) == 'function' and captions.timed then captions.linger(CAPTION_HOLD) end
    if continuous then continuous.stop() end
    face.abandon()
    M.faceActor, M.faceEntity, M.faceContext, facial.screenEntity = nil, nil, nil, nil
    M.faceRetry = nil
    M.captionHidden = nil
    M.context, M.target = nil, nil
    M.utterance = nil
    M.continuous, M.continuousEnded, M.continuousId, M.continuousCaptions = nil, nil, nil, nil
    M.continuousFaceCursor, M.continuousFaceTarget, M.continuousFaceState, M.continuousHeardAll = nil, nil, nil, nil
    M.player, M.actor, M.playerID, M.requestId = nil, nil, nil, nil
    M.voiceOnly, M.holocall, M.head = false, false, false
    M.duration, M.position, M.paused = nil, 0, false
    M.state = 'idle'
    publish()
end

-- player: the V of this frame (nil asks the game).
local function syncUtterance(position, player)
    local s = M.continuousCaptions
    s.position = math.max(s.position or 0, position)
    if M.captionHidden or not captions.enabled(player) then return end
    -- Continuous speech carries audio-aligned cues (bridge/caption-cues.mjs);
    -- a new cue revision re-times the pages without redisplaying them.
    local cues = s.cues
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
    if problem then
        -- A voice that broke after the reply started: the bridge's error state carries the complete written reply, so the whole text shows.
        local complete = type(state) == 'table' and state.textComplete == true and type(state.text) == 'string' and state.text:find('%S')
        M.error=problem;fallback('playback-failed', complete and state.text or M.text);return
    end
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
        if state.position > 0 then syncUtterance(state.position, player) end
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

-- A screen face that was not there when the reply started (findScreenFace above): asked again every FACE_RETRY seconds of heard
-- playback. Once found, the reply's face starts with its next timeline update.
local function retryFace(delta)
    local retry = M.faceRetry
    local step = finite(delta) and math.max(0, delta) or 0
    retry.wait, retry.elapsed = retry.wait - step, retry.elapsed + step
    if retry.wait > 0 then return end
    retry.wait, retry.tries = FACE_RETRY, retry.tries + 1
    local found, pending = findScreenFace(retry.profileKey, retry.context)
    if found then
        M.faceRetry = nil
        if type(M.log) == 'function' then
            pcall(M.log, string.format('Screen face joined: %s %.1fs into the line', tostring(retry.profileKey), retry.elapsed))
        end
        return
    end
    if not pending or retry.tries >= FACE_RETRIES then
        M.faceRetry = nil
        if type(M.log) == 'function' then pcall(M.log, 'Screen face not found for this line: ' .. tostring(retry.profileKey)) end
    end
end

-- Who is speaking, and whether the voice is still allowed, cannot change faster than this: the player/actor identity test and the
-- voice-setting read run at 10 Hz (and at once for a new reply or speaker), not on every frame of a reply.
local IDENTITY_PERIOD = .1
local function identityDue(delta)
    local clock = os.clock()
    if M.identityFor ~= M.requestId or M.identityActor ~= M.actor or M.identityClock == nil or clock < M.identityClock then
        M.identityFor, M.identityActor, M.identityWait, M.identityClock = M.requestId, M.actor, 0, clock
        return true
    end
    -- A paused menu reports no simulation time, so the wall clock counts as well.
    M.identityWait = M.identityWait + delta
    if M.identityWait >= IDENTITY_PERIOD or clock - M.identityClock >= IDENTITY_PERIOD then
        M.identityWait, M.identityClock = 0, clock
        return true
    end
    return false
end

local function updateSpeech(delta, framePlayer)
    -- V is taken only on a frame that needs V: a reply in progress (the heartbeat needs nobody). init.lua passes the V it fetched
    -- for this frame (the session check), so those frames ask the game for nobody; a caller without it (a test) asks once. A quiet
    -- frame makes no native call (each Game.GetPlayer() through CET costs the game thread and leaves one more handle for the
    -- collector).
    local player = framePlayer
    M.heartbeat = M.heartbeat + delta
    -- speech-state.json lease: the bridge keeps it 5 s. Written in a frame no other heartbeat writes in.
    local slot = M.heartbeat >= 2 and convaiHeartbeatSlot
    local beat = M.heartbeat >= 2 and (type(slot) ~= 'function' or slot())
    -- Nothing is playing and no heartbeat is due (nearly every frame): no game call at all.
    if not beat and not M.requestId then return end
    if beat then
        M.heartbeat = 0
        -- M.available (the service reads it in speech-state.json to decide whether to make audio): the continuous adapter is loaded.
        M.available = continuousAdapter() ~= nil
        publish()
    end
    if not M.requestId then return end
    player = player or convaiPlayer()
    if not player then M.abandon(); return end
    local identity = identityDue(delta)
    if identity then
        if tostring(player:GetEntityID().hash) ~= M.playerID then M.abandon(); return end
        if not M.actor:IsAttached() or (not M.voiceOnly and M.actor:IsDeadNoStatPool()) then M.stop('target-lost'); return end
    end
    -- The same test while a named character's reply is heard (about twice a second, held inside the guard): a scene, a fight or
    -- a ride that starts ends the reply and releases the face. True when it did.
    local storyGuard = M.storyGuard
    if storyGuard and storyGuard(M.actor, M.context) == true then return end
    if identity and not voiceEnabled(player) then
        fallback('muted', M.text); return
    end
    -- UI_System.IsInMenu: init.lua's reader keeps the blackboard definition and its id (three native calls a frame, not seven);
    -- without it (a test) the definitions are read as before.
    local inMenu
    local menuFlag = convaiInMenu
    if type(menuFlag) == 'function' then inMenu = menuFlag()
    else
        local defs = Game.GetAllBlackboardDefs()
        inMenu = Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu)
    end
    local paused = pausedFor(M.requestId, inMenu)
    if paused ~= M.paused then M.paused = paused; publish() end
    if M.faceRetry and not paused then retryFace(delta) end
    updateContinuous(delta, player, paused)
end

-- init supplies current actor rows for this frame only. The speech cursor and
-- feature interpolation above keep their accepted timing; idle actors use the
-- same final writer after the current speaker has had its one write.
function M.update(delta,expressionContext,framePlayer)
    if face.beginExpressionFrame then face.beginExpressionFrame(delta,expressionContext) end
    updateSpeech(delta,framePlayer)
    if face.updateExpressions then face.updateExpressions(expressionContext) end
end

convaiSpeech = M
return M
