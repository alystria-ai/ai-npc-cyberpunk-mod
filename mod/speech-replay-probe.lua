-- Development-only playback of an already paired local WAV and mapped face.
-- No provider request, input/history write, event hook or independent clock.
-- The normal speech adapter owns pause, target loss, reset and world teardown.
local M = convaiSpeechReplayProbe or {sequence = 0, used = {}}
local limit, maxDuration = 2097152, 15
local allowed = {
    jaw_mid_open=true, lips_apart_up=true, lips_apart_dn=true,
    lips_together_up=true, lips_together_dn=true,
    lips_l_funnel=true, lips_r_funnel=true, lips_l_purse=true, lips_r_purse=true,
    lips_l_stretch=true, lips_r_stretch=true, lips_l_lower_raise=true, lips_r_lower_raise=true,
    lips_tighten_up=true, lips_tighten_dn=true, lips_suck_dn=true, lips_suck_up=true, tongue_mid_tip_up=true,
    lips_l_upper_raise=true, lips_r_upper_raise=true, lips_l_corner_stretch=true, lips_r_corner_stretch=true,
}
local function finite(value)
    return type(value) == 'number' and value == value and math.abs(value) < math.huge
end
local function check(ok, status)
    if not ok then error({status=status}, 0) end
end
local function read(path, bound, status)
    local file = io.open(path, 'rb')
    if not file then return nil end
    local raw = file:read(bound + 1); file:close()
    check(type(raw) == 'string' and #raw <= bound, status)
    local ok, value = pcall(json.decode, raw)
    check(ok and type(value) == 'table', status)
    return value
end
local function validOwner(value)
    return type(value) == 'table' and type(value.requestId) == 'string'
        and #value.requestId > 0 and #value.requestId <= 160
        and type(value.entity) == 'string' and #value.entity > 0 and #value.entity <= 120
        and finite(value.generation) and value.generation >= 0
        and value.generation <= 2147483647 and value.generation % 1 == 0
end
local function sameOwner(a, b)
    return validOwner(a) and validOwner(b) and a.requestId == b.requestId
        and a.entity == b.entity and a.generation == b.generation
end
local function pendingGuards()
    -- These are observable admission checks, not access to init's private
    -- pending state. Run with the bridge stopped; newer user speech still wins
    -- through speech.start/stop. Never consume or rewrite these mailboxes.
    local input = read('runtime/last-input.json', limit, 'blocked-reply')
    local reply = read('runtime/reply.json', limit, 'blocked-reply')
    check((not input and not reply) or sameOwner(input, reply), 'blocked-reply')
    local command = read('runtime/microphone-command.json', limit, 'blocked-microphone')
    if not command or command.action == 'cancel' then return end
    check((command.action == 'start' or command.action == 'finish') and validOwner(command.input), 'blocked-microphone')
    local state = read('runtime/microphone-state.json', 65536, 'blocked-microphone')
    check(state and state.requestId == command.input.requestId
        and (state.state == 'off' or state.state == 'error'), 'blocked-microphone')
end
local function fixture(profile, nonce)
    local doc = read('runtime/speech-fixture.json', limit, 'fixture-invalid')
    check(doc and doc.version == 1, 'fixture-invalid')
    check(doc.nonce == nonce and doc.profileKey == profile, 'fixture-stale')
    local now = os.time()
    check(finite(doc.expiresAt) and doc.expiresAt % 1 == 0
        and doc.expiresAt > now and doc.expiresAt <= now + 120, 'fixture-expired')
    local count = 0
    for key, expiry in pairs(M.used) do
        if expiry <= now then M.used[key] = nil else count = count + 1 end
    end
    check(not M.used[nonce] and count < 32, 'fixture-consumed')
    local audio, face = doc.audio, doc.face
    check(doc.stream == nil and doc.continuous == nil and type(audio) == 'table'
        and finite(audio.slot) and audio.slot % 1 == 0 and audio.slot >= 0 and audio.slot <= 7
        and audio.event == 'convai_reply_' .. tostring(audio.slot)
        and finite(audio.duration) and audio.duration >= .05 and audio.duration <= maxDuration, 'fixture-audio')
    check(type(face) == 'table' and face.version == 1 and face.segment == nil and not face.continuous
        and finite(face.duration) and math.abs(face.duration - audio.duration) < .001
        and (face.source == 'convai-arkit61' or face.source == 'local-phonetic' or face.source == 'audio-envelope')
        and type(face.tracks) == 'table' and #face.tracks > 0 and #face.tracks <= 22
        and type(face.frames) == 'table' and #face.frames >= 2 and #face.frames <= 902, 'fixture-face')
    local mapped = {version=1, source=face.source, duration=audio.duration, tracks={}, frames={}}
    if face.articulation ~= nil then
        check(type(face.articulation) == 'string' and #face.articulation <= 80
            and face.articulation:match('^[%w_.%-]+$'), 'fixture-face')
        mapped.articulation = face.articulation
    end
    local used, previous = {}, -1
    for index, track in ipairs(face.tracks) do
        check(allowed[track] and not used[track], 'fixture-face')
        used[track], mapped.tracks[index] = true, track
    end
    for index, frame in ipairs(face.frames) do
        check(type(frame) == 'table' and #frame == #face.tracks + 1
            and finite(frame[1]) and frame[1] >= 0 and frame[1] <= audio.duration
            and frame[1] > previous, 'fixture-face')
        local copied = {frame[1]}
        for i = 2, #frame do
            local track = face.tracks[i-1]
            local cap = (track == 'lips_together_up' or track == 'lips_together_dn') and .85
                or track == 'lips_suck_up' and .06 or .5
            check(finite(frame[i]) and frame[i] >= 0 and frame[i] <= cap, 'fixture-face')
            copied[i] = frame[i]
        end
        mapped.frames[index], previous = copied, frame[1]
    end
    check(mapped.frames[1][1] == 0 and math.abs(previous-audio.duration) < .001, 'fixture-face')
    return {text='Local speech replay', audio={slot=audio.slot, event=audio.event, duration=audio.duration}, face=mapped}, doc.expiresAt
end
local function speaker(profile)
    local speech, player = convaiSpeech, Game.GetPlayer()
    check(speech and speech.available == true and type(speech.start) == 'function', 'blocked-adapter')
    check(not speech.requestId and not speech.context and not speech.stream and not (convaiSubtitles and convaiSubtitles.line)
        and not (convaiFaceProbe and convaiFaceProbe.active), 'blocked-speech')
    check(not (convaiGroupChat and convaiGroupChat.round)
        and not (convaiPhoneChat and convaiPhoneChat.pending), 'blocked-conversation')
    check(player and player:IsAttached() and not player:IsDeadNoStatPool(), 'blocked-world')
    local defs, requests = Game.GetAllBlackboardDefs(), Game.GetSystemRequestsHandler()
    check(not requests:IsPreGame() and not requests:IsGamePaused()
        and not Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu), 'blocked-world')
    check(not player:ConvaiComposerOpen() and not player:ConvaiHasSubmission()
        and not player:ConvaiManagerIsOpen() and not player:ConvaiPhoneIsOpen(), 'blocked-ui')
    check(player:ConvaiManagerVoice() == true, 'blocked-muted')
    pendingGuards()
    local observer = dofile('battle-observer.lua')
    local world = observer.sample(player)
    check(world and world.available == true and world.blocked == false and world.combat == false, 'blocked-world')
    check(convaiCompanions and type(convaiCompanions.conversationCandidates) == 'function', 'blocked-companion')
    for _, candidate in ipairs(convaiCompanions.conversationCandidates(player, 8)) do
        if candidate.profileKey == profile and finite(candidate.distance) and candidate.distance <= 8
            and candidate.distance >= 0 and candidate.npc and convaiCompanions.owns(candidate.npc)
            and tostring(candidate.npc:GetEntityID().hash) == candidate.entity
            and candidate.npc:ConvaiFaceReady() and observer.canSpeak(candidate.npc, 'end') then
            return speech, player, candidate
        end
    end
    check(false, 'blocked-companion')
end
local function owns(speech, owner)
    return speech and owner and speech.requestId == owner.requestId and sameOwner(speech.context, owner)
end
local function cancel(nonce)
    local owner, speech = M.owner, convaiSpeech
    check(owner and owner.nonce == nonce, 'cancel-not-owned')
    if not owns(speech, owner) then M.owner = nil; return 'inactive' end
    local ok, alive = pcall(function()
        local player = Game.GetPlayer()
        return player and player:IsAttached() and tostring(player:GetEntityID().hash) == owner.playerID
    end)
    if ok and alive then speech.stop('diagnostic-cancelled') else speech.abandon() end
    M.owner = nil
    return 'cancelled'
end
function M.run(command)
    local report = {status='invalid-command'}
    local ok, status = pcall(function()
        check(type(command) == 'string' and #command <= 180, 'invalid-command')
        local profile, nonce = command:match('^speech%-fixture:([%w%-]+):([%w_%-]+)$')
        check(profile and #profile <= 80 and #nonce >= 8 and #nonce <= 80, 'invalid-command')
        if profile == 'cancel' then return cancel(nonce) end
        local reply, expires = fixture(profile, nonce)
        local speech, player, person = speaker(profile)
        check(M.sequence < 2147483647, 'sequence-exhausted')
        M.sequence = M.sequence + 1
        local context = {requestId='fixture-' .. nonce, generation=M.sequence, entity=person.entity, name=person.name}
        check(validOwner(context) and type(context.name) == 'string' and #context.name <= 160, 'blocked-companion')
        reply.face.requestId, reply.face.entity, reply.face.generation = context.requestId, context.entity, context.generation
        -- Consume before invoking native playback: a failed start must not be
        -- silently retried using a slot that may have been replaced since then.
        M.used[nonce] = expires
        M.owner = {requestId=context.requestId, generation=context.generation, entity=context.entity,
            playerID=tostring(player:GetEntityID().hash), nonce=nonce}
        speech.target = person.npc
        local started, accepted = pcall(speech.start, context, reply)
        if not started or accepted ~= true then
            if owns(speech, M.owner) then pcall(speech.stop, 'diagnostic-failed') end
            M.owner = nil
            check(false, 'playback-failed')
        end
        report.duration, report.source, report.format = reply.audio.duration, reply.face.source, 'native-wav'
        return 'started'
    end)
    report.status = ok and status or (type(status) == 'table' and status.status or 'native-unavailable')
    local file = io.open('runtime/speech-fixture-result.json', 'wb')
    if file then file:write(json.encode(report)); file:close() end
    return ok, report.status
end
convaiSpeechReplayProbe = M
return M
