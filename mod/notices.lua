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
    ['invite-board'] = {class = PLAYER},               -- preparing connection (once per join), joined and failed, one merged notice; no other progress text
    ['party-joined'] = {class = PLAYER},               -- a joined outcome, merged into the board
    ['party-failed'] = {class = PLAYER},               -- could not prepare / could not join
    ['party-dismiss-failed'] = {class = PLAYER},
    ['phone-invite-reply'] = {class = PLAYER, repeatS = 20},
    ['phone-dismiss-reply'] = {class = PLAYER, repeatS = 20},
    ['phone-not-in-group'] = {class = PLAYER, repeatS = 20},
    ['phone-unavailable'] = {class = PLAYER, repeatS = 20},
    ['phone-queue-refused'] = {class = PLAYER, repeatS = 20},
    -- Conversation service and replies
    ['service-down'] = {class = PLAYER},               -- once per failure
    ['service-blocked'] = {class = PLAYER, repeatS = 15},
    ['conversation-timeout'] = {class = PLAYER, repeatS = 15},
    ['reply-error'] = {class = PLAYER, repeatS = 15},
    ['key-memory'] = {class = PLAYER, repeatS = 86400},   -- a player's Convai plan has no room for conversation memory: companions go on without it
    ['quota-exhausted'] = {class = PLAYER, repeatS = 86400}, -- the plan is used up or the player's own key is refused: once per game session
    ['daily-limit'] = {class = PLAYER, repeatS = 86400},     -- the shared plan's daily allowance is used up: once per game session, only for a turn V asked for
    -- Mistral as the conversation provider: a turn V asked for fails (an automatic reaction just stops), and two one-time notices
    ['mistral-key'] = {class = PLAYER, repeatS = 60},       -- Mistral did not accept the saved key
    ['mistral-limit'] = {class = PLAYER, repeatS = 60},     -- Mistral's free limit (about one message a second, plus a monthly allowance) is reached
    ['mistral-model'] = {class = PLAYER, repeatS = 60},     -- the Mistral model is unavailable
    ['mistral-no-key'] = {class = PLAYER, repeatS = 86400}, -- Mistral is chosen but no key is saved, so Convai is used: once per game session
    ['mistral-voice'] = {class = PLAYER, repeatS = 86400},  -- the Convai cloud voice is chosen: a local voice speaks Mistral replies, once per game session
    ['groq-key'] = {class = PLAYER, repeatS = 60},          -- Groq did not accept the key
    ['groq-limit'] = {class = PLAYER, repeatS = 60},        -- Groq's free limit is reached
    ['groq-model'] = {class = PLAYER, repeatS = 60},        -- the Groq model is unavailable
    ['groq-no-key'] = {class = PLAYER, repeatS = 86400},    -- Groq is chosen but no key is saved, so Convai is used: once per game session
    ['local-fallback'] = {class = PLAYER, repeatS = 86400}, -- Local AI is chosen but could not start, so Convai is used: once per game session
    ['local-failed'] = {class = PLAYER, repeatS = 30},      -- a local turn could not be answered and no cloud provider took it over: say so on every attempt, not more than twice a minute
    ['local-turn-fallback'] = {class = PLAYER, repeatS = 600}, -- a local turn was answered by the cloud provider instead: about once per ten minutes
    ['local-model-fallback'] = {class = PLAYER, repeatS = 60},    -- the Local AI model the player chose is missing or does not fit, so Auto chose (the bridge sends it once per choice)
    -- Starting a conversation
    ['talk-no-target'] = {class = PLAYER, repeatS = 20},
    ['talk-no-profile'] = {class = PLAYER, repeatS = 20},
    ['group-needs-two'] = {class = PLAYER, repeatS = 20},
    ['talk-connecting'] = {class = PLAYER, repeatS = 10},
    ['voice-needs-convai'] = {class = PLAYER, repeatS = 15},   -- the voice key is pressed while Mistral is in use and this computer cannot recognise speech
    ['mic-connecting'] = {class = PLAYER},
    ['mic-listening'] = {class = PLAYER},
    ['mic-finish-hint'] = {class = PLAYER, repeatS = 10},
    ['mic-error'] = {class = PLAYER, repeatS = 15},
    ['mic-timeout'] = {class = PLAYER, repeatS = 15},
    ['mic-no-speech'] = {class = PLAYER, repeatS = 15},
    ['mic-heard'] = {class = PLAYER},
    -- Voices and companion actions
    ['voice-fallback'] = {class = PLAYER, repeatS = 600},
    ['action-rejected'] = {class = PLAYER, repeatS = 15},
    ['party-stop-trip'] = {class = PLAYER, repeatS = 15},
    ['trip-failed'] = {class = PLAYER, repeatS = 15},
    -- A slow component loading (the loading board below): shown again every few seconds until it is ready, no repeat window
    ['load-progress'] = {class = PLAYER},              -- "Loading the OmniVoice voice…", "Local AI is warming up…"
    ['load-ready'] = {class = PLAYER},                 -- the matching "… is ready." (only when the loading line was shown)
    ['load-failed'] = {class = PLAYER},                -- it could not load, and what to do

    -- Developer mode only
    ['phone-dismiss-ack'] = {class = DEVELOPER},
    ['party-dismissed'] = {class = DEVELOPER},
    ['trip-guidance'] = {class = DEVELOPER},
    ['action-queued'] = {class = DEVELOPER},
    ['tactic-outcome'] = {class = DEVELOPER},
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

-- lines: array of {id = ..., text = ...}. The permitted ones are shown together as one notice
-- (each notice replaces the previous one on screen). Returns how many lines were shown.
function M.sendLines(player, lines)
    if not player then return 0 end
    local texts = {}
    for _, line in ipairs(lines) do
        if M.permit(line.id, line.text) then texts[#texts + 1] = line.text end
    end
    if #texts == 0 then return 0 end
    local ok = pcall(function() player:ConvaiPhoneFeedback(table.concat(texts, '\n')) end)
    if ok then M.lastSentAt = M.clock() end
    return ok and #texts or 0
end

-- One notice. Returns true when it was shown.
function M.send(player, id, text)
    return M.sendLines(player, {{id = id, text = text}}) > 0
end

-- The loading board. A notice is gone after a few seconds and the next one replaces it, so "stays on screen until it is
-- ready" is the same line shown again every RESHOW_S, and then replaced by the "ready" line (or a failure line saying what
-- to do). One entry per slow component (the OmniVoice voice, Local AI ...), told by the caller as a state:
--   'loading'    in progress; the line appears once the load has lasted LOADING_DELAY_S (a quick one shows nothing)
--   'ready'      done; the ready line shows once, and only when the loading line was shown
--   any other string (for example 'failed', 'no-memory') after 'loading': failed; the failure line shows once
--   nil          not loading, or no longer wanted (the player switched away, the service went quiet): nothing is shown
-- Popups only show in gameplay, so an outcome reached in a menu waits for the first gameplay tick (END_MAX_AGE_S at most).
-- A line is never put on top of another notice before that one has had RESHOW_S (lastSentAt covers every notice).
-- Cost: with nothing loading, one comparison per call and the state is read at most once a second (read is only called
-- then); while something loads it is read on every call, which the caller makes a few times a second, never per frame.
local RESHOW_S, LOADING_DELAY_S, IDLE_POLL_S, END_MAX_AGE_S = 3, 1.5, 1.0, 90
M.lastSentAt = -1000
M.clock = os.clock
local board, boardBusy, boardRunAt = {}, false, -1000
local boardLines = {}

-- worldReady: popups are visible. keys: the components, in the order their lines are shown. read(): returns a table
-- key -> state. describe(key, state) returns the text of a line. Returns an array of {phase, key, text}, or nil when
-- there is nothing to show now; phase is 'loading', 'ready' or 'failed'. The caller shows the lines (sendLines) as one notice.
function M.loading(worldReady, keys, read, describe)
    local now = M.clock()
    if not boardBusy and now - boardRunAt < IDLE_POLL_S then return nil end
    boardRunAt = now
    local ok, states = pcall(read)
    if not ok or type(states) ~= 'table' then states = {} end
    boardBusy = false
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
    if not worldReady then return nil end
    local lines, count, ended = boardLines, 0, false
    for _, key in ipairs(keys) do
        local item = board[key]
        if item.ending then
            if now - item.endAt <= END_MAX_AGE_S then
                count, ended = count + 1, true
                local line = lines[count] or {}
                lines[count] = line
                line.phase, line.key, line.text = item.ending, key, describe(key, item.state)
            end
            item.ending = nil
        end
    end
    local quiet = now - M.lastSentAt >= RESHOW_S
    if ended or quiet then
        for _, key in ipairs(keys) do
            local item = board[key]
            if item.phase == 'loading' and now - item.since >= LOADING_DELAY_S then
                item.shown = true
                count = count + 1
                local line = lines[count] or {}
                lines[count] = line
                line.phase, line.key, line.text = 'loading', key, describe(key, 'loading')
            end
        end
    end
    if count == 0 then return nil end
    for index = count + 1, #lines do lines[index] = nil end
    return lines
end

-- Forget what is loading (a new save, a reset): nothing from the old session is announced.
function M.resetLoading()
    board, boardBusy, boardRunAt = {}, false, -1000
end
convaiNotices = M
return M
