-- The one place that decides which on-screen notices a player sees.
--
-- Every popup the mod shows (the game's neutral warning line, PlayerPuppet:ConvaiPhoneFeedback)
-- belongs to a catalog entry with a class:
--   player     shown to everyone: an intuitive wait (the microphone
--              connecting) or a real failure the player has to act on. Short, friendly, and not
--              repeated: an identical notice inside its repeat window is dropped while Developer
--              mode is off.
--   developer  routine status, joins and dismissals, driving steps, diagnostics: shown only while
--              Developer mode is on.
--   removed    noise even for developers (it duplicates something already on screen): never shown.
-- docs/NOTIFICATIONS.md lists every entry with its text; bridge/notices.test.mjs fails when a call
-- site uses an id that is not here, when a raw ConvaiPhoneFeedback call appears outside this file,
-- or when this table and the document disagree. A notice with an unknown id is never shown.
--
-- Cost: a table lookup and a boolean per notice. Nothing here runs per frame.
local M = {version = 1}

local PLAYER, DEVELOPER, REMOVED = 'player', 'developer', 'removed'

-- repeatS: seconds in which an identical text of this id is not shown again (Developer mode off).
M.catalog = {
    -- Invitations
    ['invite-board'] = {class = PLAYER},               -- joined and failed, one merged notice; what a companion still waits for is a load-progress line, no other progress text
    ['party-joined'] = {class = PLAYER},               -- a joined outcome, merged into the board
    ['party-failed'] = {class = PLAYER},               -- could not prepare / could not join
    ['party-dismiss-failed'] = {class = PLAYER},
    ['phone-invite-reply'] = {class = PLAYER, repeatS = 20},
    ['phone-dismiss-reply'] = {class = PLAYER, repeatS = 20},
    ['phone-not-in-group'] = {class = PLAYER, repeatS = 20},
    ['phone-unavailable'] = {class = PLAYER, repeatS = 20},
    -- Add-ons (docs/ADDON_API.md): an add-on that needs a newer main mod or could not load, and an add-on's own notice
    ['addon-notice'] = {class = PLAYER, repeatS = 20},
    -- A character the player made, talked to while Convai answers: it speaks as an ordinary person (docs/CHARACTER_EDITOR.md)
    ['custom-needs-provider'] = {class = PLAYER, repeatS = 86400},
    ['phone-queue-refused'] = {class = PLAYER, repeatS = 20},
    -- Conversation service and replies
    ['service-down'] = {class = PLAYER},               -- once per failure
    ['setup-problem'] = {class = PLAYER},              -- the setup check's first-load notice: the first critical install problem, once per game session (mod/setup-check.lua)
    ['manager-needs-nsui'] = {class = PLAYER, repeatS = 10}, -- the Companion Manager key was pressed and Native Settings UI is missing or too old (mod/nsui.lua)
    ['manager-seated'] = {class = PLAYER, repeatS = 5}, -- the Companion Manager key was pressed while V sits: Mod Configuration Menu does not open in a scene sit, so stand up (mod/init.lua openManager)
    ['manager-in-mcm-list'] = {class = PLAYER, repeatS = 10}, -- the Companion Manager key opened Mod Configuration Menu, which hides Native Settings UI's Mods screen: the manager is chosen in its list (mod/nsui.lua)
    ['error-reports-on'] = {class = PLAYER},           -- error reports are sent automatically and where to turn them off: once, at the first load after updating (mod/error-reports.lua)
    ['service-blocked'] = {class = PLAYER, repeatS = 15},
    ['conversation-timeout'] = {class = PLAYER, repeatS = 15},
    ['reply-error'] = {class = PLAYER, repeatS = 15},
    ['key-memory'] = {class = PLAYER, repeatS = 86400},   -- a player's Convai plan has no room for conversation memory: companions go on without it
    ['quota-exhausted'] = {class = PLAYER, repeatS = 86400}, -- the plan is used up or the player's own key is refused: once per game session
    ['daily-limit'] = {class = PLAYER, repeatS = 86400},     -- the shared plan's daily allowance is used up: once per game session, only for a turn V asked for
    -- Convai paid tier (mod/convai-paid-tier.lua, docs/CONVAI_PAID_TIER.md): the outcome of a plan bought on the settings page
    ['paid-tier-active'] = {class = PLAYER, repeatS = 60},   -- Convai confirmed the plan; conversations moved to the player's own key
    ['paid-tier-pending'] = {class = PLAYER, repeatS = 60},  -- five minutes after the payment page opened, Convai still showed no new plan
    -- Mistral as the conversation provider: a turn V asked for fails (an automatic reaction just stops), and two one-time notices
    ['mistral-key'] = {class = PLAYER, repeatS = 60},       -- Mistral did not accept the saved key
    ['mistral-limit'] = {class = PLAYER, repeatS = 60},     -- Mistral's free limit (about one message a second, plus a monthly allowance) is reached
    ['mistral-model'] = {class = PLAYER, repeatS = 60},     -- the Mistral model is unavailable
    ['mistral-no-key'] = {class = PLAYER, repeatS = 86400}, -- Mistral is chosen but no key is saved, so Convai is used: once per game session
    ['mistral-voice'] = {class = PLAYER, repeatS = 86400},  -- the Convai cloud voice is chosen: a local voice speaks Mistral replies, once per game session
    -- Custom (OpenAI-compatible) as the conversation provider (mod/custom-provider.lua): the same shape as Mistral's
    ['custom-key'] = {class = PLAYER, repeatS = 60},        -- the endpoint did not accept the saved API key
    ['custom-credits'] = {class = PLAYER, repeatS = 60},    -- the account at the endpoint is out of credits
    ['custom-model'] = {class = PLAYER, repeatS = 60},      -- the endpoint does not know the saved model ID
    ['custom-limit'] = {class = PLAYER, repeatS = 60},      -- the endpoint is rate limiting the player
    ['custom-daily'] = {class = PLAYER, repeatS = 60},      -- the endpoint's daily allowance is used up (OpenRouter's free models); says when it resets if the endpoint did
    ['custom-reasoning'] = {class = PLAYER, repeatS = 60},  -- the model spent its whole reply on thinking, even with more room: choose a model that does not think first
    ['custom-unreachable'] = {class = PLAYER, repeatS = 60}, -- the endpoint did not answer
    ['custom-no-setup'] = {class = PLAYER, repeatS = 86400}, -- Custom is chosen but the endpoint URL or the model ID is missing, so Convai is used: once per game session
    ['custom-voice'] = {class = PLAYER, repeatS = 86400},   -- the Convai cloud voice is chosen: a local voice speaks Custom replies, once per game session
    ['voice-language'] = {class = PLAYER, repeatS = 86400}, -- a text provider replied in a language the chosen voice cannot speak (Pocket always, Voxtral for the languages it does not list): shown as text, OmniVoice speaks it; once per game session
    ['local-failed'] = {class = PLAYER, repeatS = 30},      -- a local turn could not be answered (no other provider ever takes it over): say so on every attempt, not more than twice a minute
    ['local-thinking'] = {class = PLAYER, repeatS = 30},    -- the player's own model server answered with only thinking, also when asked not to think: turn thinking off there or pick another model
    ['local-context'] = {class = PLAYER, repeatS = 30},     -- the player's own model server has a context too small for the character: raise it there
    ['local-restarted'] = {class = PLAYER, repeatS = 300},   -- the Local AI model server stopped by itself and was started again: about once per five minutes
    ['local-model-fallback'] = {class = PLAYER, repeatS = 60},    -- the Local AI model the player chose is missing, does not fit or did not start, so the largest model that fits was used (the bridge sends it once per choice)
    ['local-cpu'] = {class = PLAYER, repeatS = 86400},       -- the Local AI model is mostly on the processor (too little of it fits the graphics card beside the game): once per game session, with the next reply; a smaller model or the Custom provider is faster
    ['local-stepdown'] = {class = PLAYER, repeatS = 60},    -- Local AI's turns stalled (the game uses most of the graphics memory): a smaller model was loaded (the bridge sends it once per step)
    ['browser-failed'] = {class = PLAYER, repeatS = 60},    -- the browser for the conversation page was found but would not start (or there is none): says which and why, at most once a minute
    ['local-unavailable'] = {class = PLAYER, repeatS = 30}, -- Local AI is chosen and could not start (never handed to another provider; the next turn tries again): every attempt, at most twice a minute
    ['local-no-memory'] = {class = PLAYER, repeatS = 30},   -- the same, for want of free graphics memory: a smaller model is the cure
    -- Starting a conversation
    ['talk-no-target'] = {class = PLAYER, repeatS = 20},
    ['talk-no-profile'] = {class = PLAYER, repeatS = 20},
    ['talk-busy'] = {class = PLAYER, repeatS = 10},          -- a story character the game has in a scene, a fight or a ride is not talked to (mod/world-talk.lua)
    ['group-needs-two'] = {class = PLAYER, repeatS = 20},
    ['talk-connecting'] = {class = PLAYER, repeatS = 10},
    -- Holocalls (mod/holocall.lua, docs/HOLOCALL.md)
    ['holocall-refused'] = {class = PLAYER, repeatS = 10},      -- a holocall could not start (a game call, combat, a scene, calls blocked)
    ['holocall-ended'] = {class = PLAYER},                      -- the call ended for a reason other than V hanging up
    ['holocall-live-fallback'] = {class = PLAYER, repeatS = 60}, -- the experimental live picture could not be shown: the portrait is used
    ['message-lost'] = {class = PLAYER, repeatS = 5},         -- a typed message was dropped (empty text box confirmed, box closed without a result, request not written)
    ['voice-needs-convai'] = {class = PLAYER, repeatS = 15},   -- the voice key is pressed while Mistral is in use and this computer cannot recognise speech
    ['mic-connecting'] = {class = PLAYER},
    ['mic-listening'] = {class = PLAYER},
    ['mic-finish-hint'] = {class = PLAYER, repeatS = 10},
    ['mic-error'] = {class = PLAYER, repeatS = 15},
    ['mic-timeout'] = {class = PLAYER, repeatS = 15},
    ['mic-no-speech'] = {class = PLAYER, repeatS = 15},
    ['mic-silent'] = {class = PLAYER, repeatS = 15},
    ['mic-english-only'] = {class = PLAYER, repeatS = 86400}, -- voice input in another language that nothing on this setup recognises (Mistral transcription refused or not used, no multilingual pack): once per game session
    ['mic-heard'] = {class = PLAYER},
    -- Voices and companion actions
    ['voice-fallback'] = {class = PLAYER, repeatS = 600},
    ['action-rejected'] = {class = PLAYER, repeatS = 15},
    ['party-stop-trip'] = {class = PLAYER, repeatS = 15},
    ['trip-failed'] = {class = PLAYER, repeatS = 15},
    -- A slow component loading (the loading board below): one notice that stays up until the outcome replaces it, no repeat window
    ['load-progress'] = {class = PLAYER},              -- "Loading the OmniVoice voice…", "Local AI is warming up…", and a companion still being prepared: "Preparing Evelyn: waiting for the voice model to load…"
    ['load-ready'] = {class = PLAYER},                 -- the matching "… is ready." (only when the loading line was shown)
    ['load-failed'] = {class = PLAYER},                -- it could not load, and what to do

    -- Developer mode only
    ['phone-dismiss-ack'] = {class = DEVELOPER},
    ['party-dismissed'] = {class = DEVELOPER},
    ['trip-guidance'] = {class = DEVELOPER},
    ['action-queued'] = {class = DEVELOPER},
    ['tactic-outcome'] = {class = REMOVED},            -- the companion's own reply covers it; the outcome stays in probe.log (the user, 2026-10-18)
    ['voice-switched'] = {class = DEVELOPER},          -- the Settings status line already says it
    ['support-report-saved'] = {class = DEVELOPER},

    -- Never shown
    ['phone-queued'] = {class = REMOVED},              -- "{name}: invite queued." appeared after the phone closed and repeated the row text
}

local developerOf
local lastShown, shownCount = {}, 0

-- fn() returns true while Developer mode is on. Without it the mod behaves as a player build.
function M.configure(fn) developerOf = type(fn) == 'function' and fn or nil end

local function developerMode()
    if not developerOf then return false end
    local ok, enabled = pcall(developerOf)
    return ok and enabled == true
end

function M.developerMode() return developerMode() end

function M.class(id)
    local entry = M.catalog[id]
    return entry and entry.class or nil
end

-- Whether a notice of this id may be shown now (unknown ids never are).
function M.visible(id, developer)
    local class = M.class(id)
    if class == PLAYER then return true end
    if class == DEVELOPER then
        if developer == nil then developer = developerMode() end
        return developer == true
    end
    return false
end

-- Identical text of an id inside its repeat window is dropped while Developer mode is off.
local function repeated(id, text, developer)
    local entry = M.catalog[id]
    local window = entry and entry.repeatS
    if developer or not window then return false end
    local now, key = os.time(), id .. '\n' .. text
    local last = lastShown[key]
    if last and now - last < window then return true end
    if not last then
        shownCount = shownCount + 1
        if shownCount > 48 then lastShown, shownCount = {}, 1 end
    end
    lastShown[key] = now
    return false
end

-- Whether this notice may be shown now: its class allows it and it is not an identical repeat.
-- Counts as shown, so call it once per notice and only when the notice will really be posted.
function M.permit(id, text)
    local developer = developerMode()
    return type(text) == 'string' and text ~= '' and M.visible(id, developer) and not repeated(id, text, developer)
end

-- The loading notice stays up instead of timing out after five seconds. The game's warning line (the HUD's
-- WarningMessageGameController) plays an intro and a jingle for every message it is given and hides it after the message's
-- own `duration`; PlayerPuppet:SetWarningMessage always asks for 5 s. A message with a long duration is therefore posted
-- straight to the same blackboard line (UI_Notifications.WarningMessage), once, and hidden on demand by a message with
-- isShown = false. HOLD_S is the safety net: if the mod is reloaded or stops while one is up it still goes away by itself.
-- screen.post returns 'native' (held), 'fallback' (the ordinary five-second notice, shown again by the board every
-- RESHOW_S, the pre-2026-10-13 behaviour, used when the blackboard line cannot be written) or false. Tests replace M.screen.
local LOADING_ID, HOLD_S = 'load-progress', 90
local neutralKind
local function messageKind()
    if neutralKind == nil then
        local ok, value = pcall(function() return Enum.new('SimpleMessageType', 'Neutral') end)
        if not ok or value == nil then ok, value = pcall(function() return SimpleMessageType.Neutral end) end
        neutralKind = ok and value or false
    end
    return neutralKind or nil
end
local function warningLine()
    local definitions = Game.GetAllBlackboardDefs()
    return Game.GetBlackboardSystem():Get(definitions.UI_Notifications), definitions.UI_Notifications.WarningMessage
end
local function writeLine(shown, text, instant, seconds)
    local board, id = warningLine()
    local message = SimpleScreenMessage.new()
    message.isShown, message.message, message.isInstant = shown, text, instant == true
    message.duration = shown and (seconds or HOLD_S) or 0
    local kind = messageKind()
    if kind ~= nil then message.type = kind end
    board:SetVariant(id, ToVariant(message), true)
end
M.screen = {
    post = function(player, text, instant)
        if pcall(writeLine, true, text, instant) then return 'native' end
        if M.ordinary(player, text) then return 'fallback' end
        return false
    end,
    clear = function() return pcall(writeLine, false, '', false) end,
    -- a notice that stays `seconds` after its frame has opened (the game's own timer, started when the intro ends), not the
    -- five seconds PlayerPuppet:SetWarningMessage always asks for
    timed = function(_, text, seconds) return (pcall(writeLine, true, text, false, seconds)) end,
    -- the message on the line now and whether it is shown (errors reach the caller's pcall)
    read = function()
        local board, id = warningLine()
        local message = FromVariant(board:GetVariant(id))
        return message.message, message.isShown == true
    end,
}

-- The ordinary notice: the game's neutral warning line for five seconds (the only call of the native method).
function M.ordinary(player, text)
    return (pcall(function() player:ConvaiPhoneFeedback(text) end))
end

-- Notices that stay longer than the ordinary five seconds: id -> seconds the notice stays after its frame has opened (the game
-- adds about 2.7 s of intro and 0.9 s of outro around it). The daily limit has two lines to read and a choice to make.
-- The setup check's first-load notice can carry two problems (one a line) and is written to the warning line without this mod's
-- scripts, which the ordinary notice needs (a missing redscript is one of the problems it reports).
-- Cost: one table lookup per permitted line of a notice. The loading notice may not cover such a notice before that time
-- plus the intro and outro has passed (lastSentWait).
M.showS = {['daily-limit'] = 9, ['setup-problem'] = 9}
local INTRO_OUTRO_S = 3.6

-- The notice held on screen: {text, at, mode, mask (which loads it lists), sig (the texts of the lines that change while their load goes on), matched, checkedAt, menu}, or nil.
local held
M.lastSentAt = -1000
M.clock = os.clock

local function hold(player, text, instant, mask, sig)
    local ok, mode = pcall(M.screen.post, player, text, instant)
    if not ok or not mode then return false end
    local now = M.clock()
    held = {text = text, at = now, mode = mode, mask = mask, sig = sig, matched = false, checkedAt = now, menu = false}
    M.lastSentAt, M.lastSentWait = now, nil
    return true
end

-- Take the held notice down, unless a newer notice already replaced it or is on screen (never hide someone else's).
function M.release(player)
    local was = held
    held = nil
    if not was or was.mode ~= 'native' or M.lastSentAt > was.at then return end
    if not M.verifyOff and M.screen.read then
        local ok, message, shown = pcall(M.screen.read)
        if ok and message ~= nil and (not shown or message ~= was.text) then return end
    end
    pcall(M.screen.clear, player)
end

-- lines: array of {id = ..., text = ...}. The permitted ones are shown together as one notice
-- (each notice replaces the previous one on screen). Returns how many lines were shown.
-- Lines of the loading id (text, instant, mask) are posted as the held notice instead; they wait when another notice is
-- shown in the same call (the board offers them again).
function M.sendLines(player, lines)
    if not player then return 0 end
    local texts, loading, loadingCount, instant, mask, sig, showS = {}, nil, 0, false, nil, nil, nil
    for _, line in ipairs(lines) do
        if M.permit(line.id, line.text) then
            local longer = M.showS[line.id]
            if longer and (not showS or longer > showS) then showS = longer end
            if line.id == LOADING_ID then
                loading, loadingCount = loading and (loading .. '\n' .. line.text) or line.text, loadingCount + 1
                instant, mask, sig = line.instant == true, line.mask, line.sig
            else
                texts[#texts + 1] = line.text
            end
        end
    end
    if #texts > 0 then
        local joined, ok, wait = table.concat(texts, '\n'), false, nil
        if showS then
            local posted, written = pcall(M.screen.timed, player, joined, showS)
            ok = posted and written == true
            if ok then wait = showS + INTRO_OUTRO_S end
        end
        if not ok then ok = M.ordinary(player, joined) end
        if ok then M.lastSentAt, M.lastSentWait = M.clock(), wait end
        return ok and #texts or 0
    end
    if loading then return hold(player, loading, instant, mask, sig) and loadingCount or 0 end
    return 0
end

-- One notice. Returns true when it was shown.
function M.send(player, id, text)
    return M.sendLines(player, {{id = id, text = text}}) > 0
end

-- The loading board. One notice per slow component set, held on screen from the first line until the outcome replaces it
-- (the "ready" line, or a failure line saying what to do): not repeated pop-ups. One entry per slow component (the
-- OmniVoice voice, Local AI ...), told by the caller as a state:
--   'loading'    in progress; the notice appears once the load has lasted LOADING_DELAY_S (a quick one shows nothing)
--   'ready'      done; the ready line shows once, and only when the loading line was shown
--   any other string (for example 'failed', 'no-memory') after 'loading': failed; the failure line shows once
--   nil          not loading, or no longer wanted (the player switched away, the service went quiet): the notice is taken down
-- Several loads are one notice with a line each; when the set changes the text is updated in place (isInstant: no intro).
-- Popups only show in gameplay, so an outcome reached in a menu waits for the first gameplay tick (END_MAX_AGE_S at most);
-- a notice held while a menu opens is posted again, instantly, when gameplay returns. A line is never put on top of another
-- notice of the mod before that one has had RESHOW_S (lastSentAt covers every notice), and after an outcome line the
-- remaining loads wait END_SHOW_S for it to finish. A game notice (loot, encumbrance) that replaces ours is waited out: the
-- line is read at most once a second and our notice is posted again once nothing is on screen. HOLD_S would hide the notice,
-- so it is refreshed (instantly) every REFRESH_S.
-- Cost: with nothing loading, one comparison per call and the state is read at most once a second (read is only called
-- then); while something loads it is read on every call, which the caller makes a few times a second, never per frame, and
-- the screen is touched only to post, change or take down the notice, plus one read a second to see that it is still up.
local RESHOW_S, LOADING_DELAY_S, IDLE_POLL_S, END_MAX_AGE_S = 3, 1.5, 1.0, 90
local END_SHOW_S, VERIFY_S, REFRESH_S = 5.5, 1.0, 80
local board, boardBusy, boardRunAt, lastEndAt = {}, false, -1000, -1000
local boardLines = {}

-- Whether the held notice has to be posted again: the screen shows something else, or nothing.
local function lostFromScreen(now)
    held.checkedAt = now
    if M.verifyOff or not M.screen.read then return false end
    local ok, message, shown = pcall(M.screen.read)
    if not ok or message == nil then return false end
    if shown and message == held.text then held.matched = true; return false end
    if shown then return false end                -- another notice is up: let it finish
    if not held.matched then M.verifyOff = true; return false end   -- never saw ours there: the read cannot be trusted
    return true
end

-- worldReady: popups are visible. keys: the components, in the order their lines are shown. read(): returns a table
-- key -> state; it may carry a table `revisions` (key -> text) for lines whose text changes while the load goes on, which the
-- notice then follows in place. describe(key, state) returns the text of a line. Returns lines, release. lines is an array of
-- {phase, key, text, instant, mask}, or nil when there is nothing to show now; phase is 'loading' (the notice to post or
-- update: all current loads, to be sent as the load-progress id), 'ready' or 'failed' (an outcome, shown once, as an
-- ordinary notice that replaces the held one). release is true when the held notice has to come down
-- (M.release, after the caller's own notices were sent).
function M.loading(worldReady, keys, read, describe)
    local now = M.clock()
    if not boardBusy and now - boardRunAt < IDLE_POLL_S then return nil end
    boardRunAt = now
    local ok, states = pcall(read)
    if not ok or type(states) ~= 'table' then states = {} end
    boardBusy = held ~= nil
    for _, key in ipairs(keys) do
        local item = board[key]
        if not item then item = {}; board[key] = item end
        local state = states[key]
        if state == 'loading' then
            if item.phase ~= 'loading' then item.phase, item.since, item.shown, item.ending = 'loading', now, false, nil end
        elseif item.phase == 'loading' then
            item.phase = nil
            if state == 'ready' then
                if item.shown then item.ending, item.state, item.endAt = 'ready', state, now end
            elseif type(state) == 'string' then
                item.ending, item.state, item.endAt = 'failed', state, now
            end
        end
        if item.phase == 'loading' or item.ending then boardBusy = true end
    end
    if not worldReady then
        if held then held.menu = true end
        return nil
    end
    local lines, count, ended = boardLines, 0, false
    for _, key in ipairs(keys) do
        local item = board[key]
        if item.ending then
            if now - item.endAt <= END_MAX_AGE_S then
                count, ended = count + 1, true
                local line = lines[count] or {}
                lines[count] = line
                line.phase, line.key, line.text, line.instant, line.mask, line.sig = item.ending, key, describe(key, item.state), nil, nil, nil
            end
            item.ending = nil
        end
    end
    if ended then held, lastEndAt = nil, now end   -- the outcome notice replaces the loading notice
    local mask, active, sig = 0, 0, nil
    local revisions = type(states.revisions) == 'table' and states.revisions or nil
    for index, key in ipairs(keys) do
        local item = board[key]
        if item.phase == 'loading' and now - item.since >= LOADING_DELAY_S then
            mask, active = mask + 2 ^ (index - 1), active + 1
            -- A line whose text changes while its load goes on (what a companion waits for) names its text in
            -- states.revisions[key]: a change is posted in place, like a change of the set.
            local revision = revisions and revisions[key]
            if revision ~= nil then sig = (sig or '') .. key .. '=' .. tostring(revision) .. '\n' end
        end
    end
    local release = false
    if active == 0 then
        release = held ~= nil
    elseif not ended then
        local quiet = now - M.lastSentAt >= (M.lastSentWait or RESHOW_S)
        local post, instant = false, false
        if not held then
            post = quiet and now - lastEndAt >= END_SHOW_S
        elseif M.lastSentAt > held.at or held.mode == 'fallback' then
            post = quiet                                      -- covered by another notice, or the ordinary notice has run its time
        elseif held.menu or held.mask ~= mask or held.sig ~= sig or now - held.at >= REFRESH_S then
            post, instant = true, true
        elseif now - held.checkedAt >= VERIFY_S then
            post = lostFromScreen(now)
        end
        if post then
            for index, key in ipairs(keys) do
                local item = board[key]
                if item.phase == 'loading' and now - item.since >= LOADING_DELAY_S then
                    item.shown = true
                    count = count + 1
                    local line = lines[count] or {}
                    lines[count] = line
                    line.phase, line.key, line.text, line.instant, line.mask, line.sig = 'loading', key, describe(key, 'loading'), instant, mask, sig
                end
            end
        end
    end
    if count == 0 then return nil, release end
    for index = count + 1, #lines do lines[index] = nil end
    return lines, release
end

-- Forget what is loading (a new save, a reset): nothing from the old session is announced.
function M.resetLoading()
    board, boardBusy, boardRunAt, lastEndAt, held = {}, false, -1000, -1000, nil
end
convaiNotices = M
return M
