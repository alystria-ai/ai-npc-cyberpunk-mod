-- One utterance owns its native emitter and captions. No guessed wall clock
-- drives captions: the native sound's playback cursor is authoritative.
local M = convaiSpeech or {heartbeat = 0, available = false}
local captions = dofile('subtitles.lua')

local function voiceEnabled(player)
    if not player then return false end
    local ok, enabled = pcall(function() return player:ConvaiManagerVoice() end)
    return not ok or enabled
end

local function publish()
    local f = io.open('runtime/speech-state.json', 'wb')
    if f then
        f:write(json.encode({available = M.available, updated = os.time() * 1000,
            requestId = M.requestId, slot = M.slot, state = M.state or 'idle',
            position = M.position, error = M.error}))
        f:close()
    end
end

function M.stop(reason)
    if M.player then pcall(function() M.player:ConvaiSpeechStop() end) end
    if M.requestId then captions.clear() end
    M.player, M.actor, M.requestId, M.slot, M.duration = nil, nil, nil, nil, nil
    M.state, M.position, M.paused = reason or 'idle', nil, false
    publish()
end

function M.start(context, reply)
    M.stop()
    local audio = reply.audio
    if not voiceEnabled(Game.GetPlayer()) or not M.available or type(audio) ~= 'table' then
        captions.show(context.name, reply.text); return false
    end
    if type(audio.slot) ~= 'number' or audio.slot < 0 or audio.slot > 7 or audio.slot % 1 ~= 0
        or audio.event ~= 'convai_reply_' .. tostring(audio.slot)
        or type(audio.duration) ~= 'number' or audio.duration <= 0 or audio.duration > 120 then
        captions.show(context.name, reply.text); return false
    end
    local actor = M.target
    local player = Game.GetPlayer()
    if not actor or not player or tostring(actor:GetEntityID().hash) ~= context.entity then return false end
    local ok, started = pcall(function() return player:ConvaiSpeechStart(actor, CName.new(audio.event)) end)
    if not ok or not started then
        M.error = tostring(started); captions.show(context.name, reply.text); publish(); return false
    end
    M.player, M.actor = player, actor
    M.playerID = tostring(player:GetEntityID().hash)
    M.requestId, M.slot, M.duration = context.requestId, audio.slot, audio.duration
    M.state, M.position, M.waited, M.stalled, M.paused = 'starting', 0, 0, 0, false
    M.speaker, M.text, M.error = context.name, reply.text, nil
    publish()
    return true
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
    -- CET can return different Lua wrappers for the same engine object.
    -- Compare the stable entity ID, never wrapper identity.
    if not player or tostring(player:GetEntityID().hash) ~= M.playerID
        or not M.actor:IsAttached() or M.actor:IsDeadNoStatPool() then M.stop('target-lost'); return end
    if not voiceEnabled(player) then
        local speaker, text = M.speaker, M.text
        M.stop('muted')
        captions.show(speaker, text)
        return
    end
    local defs = Game.GetAllBlackboardDefs()
    local paused = Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu)
    if paused ~= M.paused then M.player:ConvaiSpeechPause(paused); M.paused = paused end
    if paused then return end
    local pos = M.player:ConvaiSpeechPosition()
    M.waited = M.waited + delta
    if pos > (M.position or 0) + 0.001 then
        M.stalled = 0
        if M.state == 'starting' then
            M.state = 'playing'
            captions.beginTimed(M.speaker, M.text, M.duration)
        end
    else M.stalled = M.stalled + delta end
    M.position = pos
    if M.state == 'playing' then
        -- Re-enabling captions joins the current audio position rather than
        -- restarting the line or the sound.
        if captions.enabled() and not captions.timed then
            captions.beginTimed(M.speaker, M.text, M.duration)
        end
        captions.syncTimed(pos)
    end
    if pos >= M.duration - 0.025 then M.stop('finished')
    elseif M.stalled > 3 then
        local name, text = M.speaker, M.text
        M.error = 'Native speech playback did not advance'
        M.stop('playback-failed')
        captions.show(name, text)
    end
end

convaiSpeech = M
return M
