-- The one place that decides which on-screen notices a player sees.
--
-- Every popup the mod shows (the game's neutral warning line, PlayerPuppet:ConvaiPhoneFeedback)
-- belongs to a catalog entry with a class:
--   player     shown to everyone: an intuitive wait (an invitation preparing, the microphone
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
    ['invite-board'] = {class = PLAYER},               -- joined / failed, one merged notice; progress (Preparing / Connecting / ready) is Developer mode only
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
    ['quota-exhausted'] = {class = PLAYER, repeatS = 86400}, -- the plan is used up or the player's own key is refused: once per game session
    -- Starting a conversation
    ['talk-no-target'] = {class = PLAYER, repeatS = 20},
    ['talk-no-profile'] = {class = PLAYER, repeatS = 20},
    ['group-needs-two'] = {class = PLAYER, repeatS = 20},
    ['talk-connecting'] = {class = PLAYER, repeatS = 10},
    ['mic-connecting'] = {class = PLAYER},
    ['mic-listening'] = {class = PLAYER},
    ['mic-finish-hint'] = {class = PLAYER, repeatS = 10},
    ['mic-error'] = {class = PLAYER, repeatS = 15},
    ['mic-timeout'] = {class = PLAYER, repeatS = 15},
    -- Voices and companion actions
    ['voice-fallback'] = {class = PLAYER, repeatS = 600},
    ['action-rejected'] = {class = PLAYER, repeatS = 15},
    ['party-stop-trip'] = {class = PLAYER, repeatS = 15},
    ['trip-failed'] = {class = PLAYER, repeatS = 15},

    -- Developer mode only
    ['invite-joining'] = {class = DEVELOPER},
    ['phone-invite-ack'] = {class = DEVELOPER},
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
    return ok and #texts or 0
end

-- One notice. Returns true when it was shown.
function M.send(player, id, text)
    return M.sendLines(player, {{id = id, text = text}}) > 0
end

convaiNotices = M
return M
