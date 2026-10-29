local M = {}
-- A reply this overdue is dropped by the next press so the player can speak again.
local RETRY_AFTER_S = 8
-- The words Convai has heard so far are shown at most this often (seconds).
local HEARD_EVERY_S = 0.3
M.clock = os.clock
local ui = (convaiUiLocale or dofile('ui-locale.lua'))

-- The two live signals the bridge's microphone tap (bridge/mic-tap.mjs) needs before any turn exists, one small file (runtime/microphone-live.json):
--   hold   the talk key went down / came up. The bridge opens the microphone at the key press and keeps what it hears, so the first word is never lost
--          while the conversation connection is still opening; the key release stops it on the spot.
--   listen Voice activation (mod/voice-activation.lua) wants the microphone open (a conversation is possible) or closed, or Speak dialogue choices
--          (mod/voice-choices.lua, live.choiceListen) wants it open for the choice list on screen: the file's `listen` is either of the two.
--   blocked  the game is in a menu, a loading screen, a scene, a dialogue with choices or a call. After a voice turn the bridge keeps the device open for about
--          15 s (the linger, bridge/mic-tap.mjs) so the next press of a conversation starts at once; while blocked it closes it at once and does not linger.
-- A write happens on a change only: the key's two edges (one write each), when listening or blocked changes. Never per frame.
local live = {holdId = nil, down = false, listen = false, choiceListen = false, blocked = false, writes = 0}

local function writeLive()
    live.writes = live.writes + 1
    local f = io.open('runtime/microphone-live.json', 'wb')
    if not f then return false end
    local ok = pcall(function()
        f:write(json.encode({n = live.writes, at = os.clock(), holdId = live.holdId, down = live.down, listen = live.listen or live.choiceListen, blocked = live.blocked}))
    end)
    f:close()
    return ok
end

-- A new id for each key press (the bridge tells a press from the one before it by it).
function M.newHoldId() return tostring(os.time()) .. '-' .. tostring(math.floor(os.clock() * 1000) % 100000) end

function M.holdKey(holdId)
    if type(holdId) ~= 'string' or holdId == '' then return false end
    live.holdId, live.down, live.blocked = holdId, true, false
    return writeLive()
end

function M.releaseKey(holdId)
    if holdId == nil or holdId ~= live.holdId or not live.down then return false end
    live.down = false
    return writeLive()
end

function M.listen(on)
    on = on == true
    if live.listen == on then return false end
    live.listen = on
    -- The file says listen while the choice list wants it too: nothing changed for the bridge, nothing is written.
    if live.choiceListen then return false end
    return writeLive()
end

-- The choice list on screen (mod/voice-choices.lua) wants the microphone open or closed. One write, on a change that the file would show.
function M.listenChoice(on)
    on = on == true
    if live.choiceListen == on then return false end
    live.choiceListen = on
    if live.listen then return false end
    return writeLive()
end

function M.listening() return live.listen end

function M.block(on)
    on = on == true
    if live.blocked == on then return false end
    live.blocked = on
    return writeLive()
end
function M.blocked() return live.blocked end
function M.holding() return live.down and live.holdId or nil end

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

-- `source` says what caused the command (press, release, cap, pending, cancel...). The bridge logs it, so a recording that does not
-- stop shows whether the stop reached it.
-- `hold` (start only): the id of the key press that opened the bridge's microphone tap ahead of this command (mod/microphone.lua, holdKey).
local function command(action, context, source, hold)
    local f = io.open('runtime/microphone-command.json', 'wb')
    if not f then return false end
    f:write(json.encode({nonce = tostring(os.time()) .. ':' .. tostring(os.clock()), action = action, source = source or 'unknown', hold = hold, input = context}))
    f:close()
    M.lastCommand = {action = action, requestId = context.requestId, source = source}
    if type(M.log) == 'function' then pcall(M.log, 'Microphone command: ' .. action .. ' source=' .. tostring(source or 'unknown')) end
    return true
end

-- The cold-start cue (the bridge says the device was not open at the press): "Opening microphone…", then "Speak now" in place the moment the first audio
-- arrives, gone 1.5 s after that, at the key release, or when the turn ends. Nothing when the device was already open (the linger) and for Voice activation.
local CUE_READY_S, CUE_MAX_S = 1.5, 8
function M.endCue(player)
    if M.cueAt == nil then return end
    M.cueAt = nil
    if convaiNotices and convaiNotices.cueEnd then convaiNotices.cueEnd(player) end
end

local function clear()
    M.context, M.state, M.started, M.knowledgeOwner, M.finishPending = nil, nil, nil, nil, nil
    M.finishPendingSource = nil
    M.targetValid, M.recordingAt, M.finishedAt = nil, nil, nil
    M.heardRaw, M.heardAt = nil, nil
    M.source, M.vadId, M.beganAt, M.noteShown = nil, nil, nil, nil
    M.endCue()
    M.holdKeyId, M.cueSeen, M.cueAt, M.cueReadyAt = nil, nil, nil, nil
end

function M.cancel(reason)
    local context = M.context
    if context then command('cancel', context, reason or 'cancel') end
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
    return command('cancel', context, 'revoke')
end

function M.received(requestId)
    if not M.context or M.context.requestId ~= requestId or M.state ~= 'reply' then return false end
    clear()
    return true
end

-- What a press of the voice key means while a recording or its reply is in flight. The key is hold-to-talk: it records from the press until it
-- is let go, so a second press while a recording is running is only a key repeat or a second key.
--   idle     nothing is running: begin a recording
--   busy     a recording is opening or running: ignore it
--   waiting  the reply is on its way: ignore it (a spammed key must not cancel a good reply)
--   retry    the reply is overdue: drop it so a fresh recording can begin
function M.press()
    if not M.context then return 'idle' end
    if M.state == 'reply' then
        return os.time() - (M.finishedAt or os.time()) >= RETRY_AFTER_S and 'retry' or 'waiting'
    end
    return 'busy'
end

-- The language the mod resolved for its interface (the game's own language under Automatic), for the bridge's speech recognition
-- (bridge/speech-language.mjs reads runtime/ui-language.txt when a recording opens). Written when it changes: the caller passes it from
-- the one place that already learns of a change, never per frame. A failed write is ignored (the bridge then assumes English).
local publishedLanguage
function M.publishLanguage(language)
    if type(language) ~= 'string' or language == '' or language == publishedLanguage then return false end
    local f = io.open('runtime/ui-language.txt', 'wb')
    if not f then return false end
    f:write(language); f:close()
    publishedLanguage = language
    return true
end

-- source: 'press' (the key went down) or 'vad' (Voice activation heard the player start speaking; `extra.vadId` is the detector's id for that start).
-- extra.hold: the key press's hold id (the bridge's microphone tap is already open for it).
function M.begin(context, targetValid, source, extra)
    M.cancel('replaced')
    if not capture(context) then return false end
    context.journal = M.captureJournal and M.captureJournal()
    context.battle = M.captureBattle and M.captureBattle()
    context.gameDialogue = M.captureGameDialogue and M.captureGameDialogue()
    context.gear = M.capturePlayerGear and M.capturePlayerGear()
    context.turnContext = M.captureTurnContext and M.captureTurnContext(context.profileKey)
    if type(M.decorate) == 'function' then pcall(M.decorate, context) end
    if not currentOwner() then M.knowledgeOwner = nil; return false end
    -- The old microphone owner has already been cancelled. Capture optional
    -- gameplay capabilities immediately before the actual start publication.
    if type(M.captureActions) == 'function' then
        local captured = pcall(M.captureActions, context)
        if not captured then context.chauffeurOffer = nil end
    end
    if not command('start', context, source or 'press', extra and extra.hold or nil) then
        M.knowledgeOwner = nil
        if type(M.onCancelled) == 'function' then M.onCancelled(context, 'start-write-failed') end
        return false
    end
    M.context, M.state, M.started = context, 'starting', os.time()
    M.beganAt = M.started
    M.source, M.vadId = source or 'press', extra and extra.vadId or nil
    M.holdKeyId = extra and extra.hold or nil
    M.targetValid = targetValid
    return true
end

function M.finish(mode, source)
    local context = M.context
    if not context or M.state == 'reply' or (mode and mode ~= (context.group and 'group' or 'private')) then return nil end
    local captured, reason = capture(context, M.knowledgeOwner)
    if not captured then
        if reason == 'save-in-progress' then M.finishPending = true; M.finishPendingSource = M.finishPendingSource or source else M.cancel() end
        return nil
    end
    M.finishPending = nil
    context.journal = M.captureJournal and M.captureJournal()
    context.battle = M.captureBattle and M.captureBattle()
    context.gameDialogue = M.captureGameDialogue and M.captureGameDialogue()
    context.gear = M.capturePlayerGear and M.capturePlayerGear()
    context.turnContext = M.captureTurnContext and M.captureTurnContext(context.profileKey)
    if type(M.decorate) == 'function' then pcall(M.decorate, context) end
    if M.context ~= context then return nil end
    local current, problem = currentOwner()
    if not current then
        if problem == 'save-in-progress' then M.finishPending = true; M.finishPendingSource = M.finishPendingSource or source else M.cancel() end
        return nil
    end
    if not command('finish', context, M.finishPendingSource and (M.finishPendingSource .. '-delayed') or source or 'press') then M.cancel('finish-write-failed'); return nil end
    M.finishPendingSource = nil
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
    -- A menu or a target out of reach ends a recording that is opening or running. Once V has finished speaking (state 'reply') the turn is
    -- the bridge's and completes like a typed one: the reply shows or plays when V is back (a world change above, the 90 s deadline and the
    -- player's next press still end it).
    if M.state ~= 'reply' then
        local defs = Game.GetAllBlackboardDefs()
        if Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) then
            M.cancel('menu'); return nil
        end
        if type(M.targetValid) == 'function' then
            local ok, valid = pcall(M.targetValid, M.context)
            if not ok or not valid then M.cancel('target-lost'); return nil end
        end
    end
    local f = io.open('runtime/microphone-state.json', 'rb')
    if f then
        local ok, value = pcall(json.decode, f:read('*a')); f:close()
        -- An empty placeholder (or a half-written file) decodes to nothing: no state yet.
        if ok and type(value) == 'table' then
            -- Voice activation (mod/voice-activation.lua): the bridge's detector says the player stopped speaking. It rides on whatever state the file holds,
            -- so it is read before the turn's own state is matched to this request.
            local cue = type(value.cue) == 'table' and value.cue or nil
            if cue and M.source == 'press' and M.holdKeyId and cue.hold == M.holdKeyId and cue.id ~= M.cueSeen and M.state ~= 'reply' then
                M.cueSeen = cue.id
                if cue.phase == 'opening' then
                    if convaiNotices.cue and convaiNotices.cue(player, 'mic-cue', ui.t('Opening microphone…')) then M.cueAt = M.clock() end
                elseif cue.phase == 'ready' and M.cueAt ~= nil then
                    if convaiNotices.cue then convaiNotices.cue(player, 'mic-cue', ui.t('Speak now')) end
                    M.cueReadyAt = M.clock()
                end
            end
            local vad = type(value.vad) == 'table' and value.vad or nil
            if M.source == 'vad' and vad and vad.phase == 'ended' and vad.id ~= M.vadId and M.state ~= 'reply' and not M.finishPending then
                M.finishPending, M.finishPendingSource = true, 'vad-end'
            end
            if value.requestId == M.context.requestId then
                if value.state == 'recording' then
                    if M.state == 'starting' then M.state = 'recording'; M.started = os.time(); M.recordingAt = M.clock() end
                    -- A turn is not announced ("Listening" is gone: the key is already recording). Only a language this setup cannot hear is
                    -- told, once per game session, because the words will not come out as said.
                    if value.note and not M.noteShown then
                        M.noteShown = true
                        if value.note == 'english-only' then
                            -- The language is not English and nothing on this setup recognises it (bridge/speech-language.mjs).
                            convaiNotices.send(player, 'mic-english-only', ui.t('Voice input only understands English for now. Typing works in any language.'))
                        elseif value.note == 'mic-device-gone' then
                            -- The input chosen in Settings > Voices > Microphone is not connected: the Windows default input opened instead (bridge/local-stt-capture.mjs).
                            convaiNotices.send(player, 'mic-device-gone', ui.t('The microphone you chose in Settings is not connected, so the Windows default input is used.'))
                        elseif value.note == 'mic-loopback' then
                            -- The Windows default input looks like a loopback or virtual one (Stereo Mix, CABLE Output, a mixer's Out) and the player has not chosen another:
                            -- it may carry the far side of a call. Said once per session (bridge/mic-match.mjs).
                            convaiNotices.send(player, 'mic-loopback', ui.t('{name} looks like it carries PC sound, such as a call, not only your voice. Choose your real microphone in Settings > Voices > Microphone.', {name = tostring(value.device or '?'):sub(1, 80)}))
                        elseif value.note == 'pack-available' then
                            -- The same, but an optional microphone pack hears this language and is not installed: the notice says where the help is.
                            convaiNotices.send(player, 'mic-english-only', ui.t('Voice input in this language needs the optional Microphone pack from the mod page. Typing works in any language.'))
                        end
                    end
                elseif value.state == 'no-speech' then
                    -- Voice activation starts on a sound that may not have been speech: that turn ends quietly.
                    if M.source ~= 'vad' then
                        convaiNotices.send(player, 'mic-no-speech', ui.t('No speech was heard. Hold the talk key while you speak.'))
                    end
                    M.cancel('no-speech')
                    return nil
                elseif value.state == 'silent' then
                    -- The device sent no sound at all (a muted, dead or wrong Windows input): name it instead of "no speech".
                    local name = type(value.device) == 'string' and value.device ~= '' and value.device:sub(1, 80) or '?'
                    convaiNotices.send(player, 'mic-silent', ui.t('The microphone {name} sends no sound. Check your Windows input device.', {name = name}))
                    M.cancel('microphone-silent')
                    return nil
                elseif value.state == 'error' and value.reason == 'language' then
                    -- Mistral could not take a recording in another language and nothing local could read it (bridge/local-stt-capture.mjs).
                    convaiNotices.send(player, 'mic-english-only', ui.t('Voice input only understands English for now. Typing works in any language.'))
                    M.cancel('microphone-language')
                    return nil
                elseif value.state == 'error' and value.reason == 'connection' then
                    -- Convai's media server or the network did not answer at the start of the turn (bridge/realtime-host.mjs, microphoneConnectionFailure): the microphone is fine, the next press opens a fresh connection.
                    convaiNotices.send(player, 'mic-connection', ui.t('Voice input could not reach Convai. Hold the voice key again, or type.'))
                    M.cancel('microphone-connection')
                    return nil
                elseif value.state == 'error' then
                    convaiNotices.send(player, 'mic-error', ui.t('Microphone unavailable. Check your Windows input device.'))
                    M.cancel('microphone-error')
                    return nil
                end
            end
        end
    end
    if M.cueAt ~= nil and (M.state == 'reply' or (M.cueReadyAt and M.clock() - M.cueReadyAt >= CUE_READY_S) or M.clock() - M.cueAt >= CUE_MAX_S) then M.endCue(player) end
    if M.context and (M.state == 'starting' or M.state == 'recording' or M.state == 'reply') then showHeard(player) end
    if M.context and M.finishPending then return M.finish(nil, M.finishPendingSource == 'vad-end' and 'vad' or 'pending') end
    -- 30 s from the press, however far the bridge has got.
    if M.context and M.state ~= 'reply' and M.beganAt and os.time() - M.beganAt >= 30 then return M.finish(nil, 'cap') end
    if M.context and M.state == 'starting' and os.time() - M.started >= 35 then
        M.cancel(); convaiNotices.send(player, 'mic-timeout', ui.t('Microphone connection timed out. Please try again.'))
    end
    return nil
end

return M
