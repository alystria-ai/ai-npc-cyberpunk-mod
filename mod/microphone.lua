local M = {}
-- A second press this soon after "Listening" is a bouncing key or a double tap, not "I finished".
local MIN_RECORD_S = 0.7
-- A reply this overdue is dropped by the next press so the player can speak again.
local RETRY_AFTER_S = 8
-- The words Convai has heard so far are shown at most this often (seconds).
local HEARD_EVERY_S = 0.3
M.clock = os.clock
local ui = (convaiUiLocale or dofile('ui-locale.lua'))

local function sameOwner(a, b)
    return a and b and a.session == b.session and a.generation == b.generation and a.worldToken == b.worldToken
end

local function capture(context, prior)
    if not M.captureKnowledge then return true end
    local ok, value, reason = pcall(M.captureKnowledge, context)
    if ok and not value and reason == 'save-in-progress' then return false, reason end
    if not ok or type(value) ~= 'table' or type(value.owner) ~= 'table'
        or (prior and not sameOwner(prior, value.owner)) then return false end
    context.worldKnowledge, context.journalHistory = value.worldKnowledge, value.journalHistory
    M.knowledgeOwner = value.owner
    return true
end

local function currentOwner()
    if not M.currentKnowledgeOwner then return true end
    local ok, value = pcall(M.currentKnowledgeOwner)
    if not ok or not sameOwner(M.knowledgeOwner, value) then return false, 'world-changed' end
    if value.paused then return false, 'save-in-progress' end
    return true
end

local function command(action, context)
    local f = io.open('runtime/microphone-command.json', 'wb')
    if not f then return false end
    f:write(json.encode({nonce = tostring(os.time()) .. ':' .. tostring(os.clock()), action = action, input = context}))
    f:close()
    M.lastCommand = {action = action, requestId = context.requestId}
    return true
end

local function clear()
    M.context, M.state, M.started, M.knowledgeOwner, M.finishPending = nil, nil, nil, nil, nil
    M.targetValid, M.recordingAt, M.finishedAt = nil, nil, nil
    M.heardRaw, M.heardAt = nil, nil
end

function M.cancel(reason)
    local context = M.context
    if context then command('cancel', context) end
    clear()
    if context and type(M.onCancelled) == 'function' then M.onCancelled(context, reason or 'cancelled') end
end

-- Retire a submitted voice turn after the microphone itself has finished with
-- it (received() clears the context once the reply arrives, but the bridge keeps
-- streaming and the game keeps playing). The command file is one shared slot:
-- only cancel while it still names this exact request, never a newer recording.
function M.revoke(context)
    if not context or M.context == context then return false end
    local last = M.lastCommand
    if not last or last.requestId ~= context.requestId or last.action == 'cancel' then return false end
    return command('cancel', context)
end

function M.received(requestId)
    if not M.context or M.context.requestId ~= requestId or M.state ~= 'reply' then return false end
    clear()
    return true
end

-- What a press of the voice key means while a recording or its reply is in flight.
--   idle        nothing is running: begin a recording
--   connecting  the device is still opening: ignore it (finishing now would submit an empty recording)
--   bounce      the recording just began: ignore it
--   finish      end the recording and submit it
--   waiting     the reply is on its way: ignore it (a spammed key must not cancel a good reply)
--   retry       the reply is overdue: drop it so a fresh recording can begin
function M.press()
    if not M.context then return 'idle' end
    local state = M.state
    if state == 'starting' then return 'connecting' end
    if state == 'reply' then
        return os.time() - (M.finishedAt or os.time()) >= RETRY_AFTER_S and 'retry' or 'waiting'
    end
    if state == 'recording' and M.recordingAt and M.clock() - M.recordingAt < MIN_RECORD_S then return 'bounce' end
    return 'finish'
end

function M.begin(context, targetValid)
    M.cancel('replaced')
    if not capture(context) then return false end
    context.journal = M.captureJournal and M.captureJournal()
    context.battle = M.captureBattle and M.captureBattle()
    context.gameDialogue = M.captureGameDialogue and M.captureGameDialogue()
    context.gear = M.capturePlayerGear and M.capturePlayerGear()
    context.turnContext = M.captureTurnContext and M.captureTurnContext()
    if not currentOwner() then M.knowledgeOwner = nil; return false end
    -- The old microphone owner has already been cancelled. Capture optional
    -- gameplay capabilities immediately before the actual start publication.
    if type(M.captureActions) == 'function' then
        local captured = pcall(M.captureActions, context)
        if not captured then context.chauffeurOffer = nil end
    end
    if not command('start', context) then
        M.knowledgeOwner = nil
        if type(M.onCancelled) == 'function' then M.onCancelled(context, 'start-write-failed') end
        return false
    end
    M.context, M.state, M.started = context, 'starting', os.time()
    M.targetValid = targetValid
    return true
end

function M.finish(mode)
    local context = M.context
    if not context or M.state == 'reply' or (mode and mode ~= (context.group and 'group' or 'private')) then return nil end
    local captured, reason = capture(context, M.knowledgeOwner)
    if not captured then
        if reason == 'save-in-progress' then M.finishPending = true else M.cancel() end
        return nil
    end
    M.finishPending = nil
    context.journal = M.captureJournal and M.captureJournal()
    context.battle = M.captureBattle and M.captureBattle()
    context.gameDialogue = M.captureGameDialogue and M.captureGameDialogue()
    context.gear = M.capturePlayerGear and M.capturePlayerGear()
    context.turnContext = M.captureTurnContext and M.captureTurnContext()
    if M.context ~= context then return nil end
    local current, problem = currentOwner()
    if not current then
        if problem == 'save-in-progress' then M.finishPending = true else M.cancel() end
        return nil
    end
    if not command('finish', context) then M.cancel('finish-write-failed'); return nil end
    M.state, M.finishedAt = 'reply', os.time()
    return context
end

-- While V talks (and until the reply starts) the bridge writes what Convai's speech recognition has heard so far to
-- runtime/microphone-heard.json. It is read on this existing poll only, parsed only when it changed, and shown as the
-- game's notice line, so nothing runs per frame and a quiet recording costs one small file read per poll.
local function showHeard(player)
    local f = io.open('runtime/microphone-heard.json', 'rb')
    if not f then return end
    local raw = f:read('*a'); f:close()
    if raw == M.heardRaw then return end
    local now = M.clock()
    if M.heardAt and now - M.heardAt < HEARD_EVERY_S then return end
    M.heardRaw = raw
    local ok, value = pcall(json.decode, raw)
    if not ok or type(value) ~= 'table' or value.requestId ~= M.context.requestId
        or type(value.text) ~= 'string' or value.text == '' then return end
    M.heardAt = now
    -- V's line in the cinematic subtitles when they are on (the caller replaces it in place); the notice line otherwise.
    local shown = false
    if type(M.onHeard) == 'function' then
        local called, result = pcall(M.onHeard, value.text)
        shown = called and result == true
    end
    if not shown then convaiNotices.send(player, 'mic-heard', ui.t('You: {text}', {text = value.text})) end
end

function M.update(player)
    if not M.context then return nil end
    if not player then M.cancel(); return nil end
    if M.currentKnowledgeOwner then
        local ok, current = pcall(M.currentKnowledgeOwner)
        if not ok or not sameOwner(M.knowledgeOwner, current) then M.cancel(); return nil end
    end
    local defs = Game.GetAllBlackboardDefs()
    if Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) then
        M.cancel('menu'); return nil
    end
    if type(M.targetValid) == 'function' then
        local ok, valid = pcall(M.targetValid, M.context)
        if not ok or not valid then M.cancel('target-lost'); return nil end
    end
    local f = io.open('runtime/microphone-state.json', 'rb')
    if f then
        local ok, value = pcall(json.decode, f:read('*a')); f:close()
        if ok and value.requestId == M.context.requestId then
            if value.state == 'recording' and M.state == 'starting' then
                M.state = 'recording'; M.started = os.time(); M.recordingAt = M.clock()
                local shortcut = ui.boundKey(M.context.group
                    and 'cyberpunk_convai_group_voice' or 'cyberpunk_convai_voice')
                convaiNotices.send(player, 'mic-listening', shortcut
                    and ui.t('Listening - press {key} again to finish', {key = shortcut})
                    or ui.t('Listening - press the same voice chat shortcut again to finish'))
            elseif value.state == 'no-speech' then
                convaiNotices.send(player, 'mic-no-speech', ui.t('No speech was heard. Wait for Listening, then speak before you finish.'))
                M.cancel('no-speech')
            elseif value.state == 'error' then
                convaiNotices.send(player, 'mic-error', ui.t('Microphone unavailable. Check your Windows input device.'))
                M.cancel('microphone-error')
            end
        end
    end
    if M.context and (M.state == 'recording' or M.state == 'reply') then showHeard(player) end
    if M.context and M.finishPending then return M.finish() end
    if M.context and M.state == 'recording' and os.time() - M.started >= 30 then return M.finish() end
    if M.context and M.state == 'starting' and os.time() - M.started >= 35 then
        M.cancel(); convaiNotices.send(player, 'mic-timeout', ui.t('Microphone connection timed out. Please try again.'))
    end
    return nil
end

return M
