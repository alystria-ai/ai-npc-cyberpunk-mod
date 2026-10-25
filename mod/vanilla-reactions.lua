-- Quiet vanilla reactions on an NPC the mod is addressing.
--
-- A world NPC the mod talks to must not also bark its vanilla reaction at V
-- ("what you looking at", "back off") while the AI reply plays. Talking means
-- facing the NPC from close by, and that is exactly what the vanilla reaction
-- system answers. In the game scripts (ReactionManagerComponent) these are:
--   OnProximityLookatEvent, OnRepeatLookatEvent, OnDisturbingComfortZoneEvent
--   and OnBumpEvent call TriggerFacialLookAtReaction, which turns the face to an
--   emotion, looks at V and plays the 'greeting' or 'fear_foll' voiceset line.
--   OnAreaEnter (a ganger's comfort zone) plays 'stlh_curious_grunt' and two
--   seconds later OnDistrurbComfortZoneAggressiveEvent sends a Provoke stimulus.
--   OnBumpEvent plays 'bump', starts the Bump reaction and escalates with Provoke.
--   OnLookedAtEvent and OnSenseVisibilityEvent send AskToFollowOrder (a guard's
--   "keep moving" reprimand); the comfort zone sends CrowdIllegalAction.
-- While an NPC is addressed, install() skips those handlers for that NPC only,
-- and drops the Provoke, CrowdIllegalAction, AskToFollowOrder and Bump stimuli
-- sent to it (OnEventReceived). Every other NPC, every other stimulus (Combat,
-- gunshots, aiming, fear), vehicle bumps (the NPC still dodges a car) and all
-- scene and quest dialogue pass through unchanged. An NPC in combat or in
-- scene dialogue is never quieted.
--
-- Addressed: the NPC the mod focuses (the gaze hold before a talk and the
-- conversation itself, see beginFocus/endFocus in init.lua), every participant
-- of a running group chat, and a short grace after either ends. Holds are kept
-- by entity hash; they expire on their own, and a load or detach clears them.
-- Ambient barks (the bark window): the game's own greeting, grunt and bump voice lines of any NPC within 15 m of V are dropped
-- while V talks to an NPC, while an AI line plays and for a quiet tail after it (the gaps between turns; r6 Engagement.reds ConvaiBarkGate wraps GameObject.PlayVoiceOver). This
-- file only opens and closes that window on conversation events (R.barkHold, R.barkRelease, R.speechStarted, R.speechEnded):
-- one native call per event, never per frame and never a poll; the window also ends by itself. See R.barkHold.
-- Each suppression writes "Suppressed vanilla reaction <kind> for <entity>"
-- to the mod log (at most once every few seconds per NPC and kind), and
-- status() counts them for the CET console:
--   print(json.encode(convaiVanillaReactions.status()))
local M = {version = 1}

M.DEFAULTS = {
    grace = 6,        -- seconds an NPC stays quiet after the mod stops addressing it
    maxPinned = 900,  -- a focus older than this is no longer trusted (a missed release)
    logEvery = 3,     -- seconds between two log lines for one NPC and kind
    talkHold = 120,   -- bark window: V pressed the talk key (the composer or the microphone is open, V may take a while to write)
    requestHold = 45, -- bark window: V's line was sent and the reply is on its way (a slow model, a queue)
    speechHold = 90,  -- bark window: an AI line starts to play (its end shortens the window to lineTail, this only caps a missed end)
    lineTail = 25,    -- bark window: seconds kept after an AI line ends: the gap before V's next turn, a group's next speaker, a follow-up
    idleTail = 25,    -- bark window: seconds kept after the conversation's focus ran out by itself (V went quiet, nothing playing)
    endGrace = 3,     -- bark window: seconds kept after V closes the conversation on purpose (the manager opens)
}

-- Stimuli the reaction system turns into stare, proximity and bump reactions.
M.STIMS = {'Provoke', 'CrowdIllegalAction', 'AskToFollowOrder', 'Bump'}

local function nativeEntity(object)
    if object == nil then return nil end
    local ok, id = pcall(function() return tostring(object:GetEntityID().hash) end)
    return ok and id or nil
end

local function nativeOwner(component)
    if component == nil then return nil end
    local ok, owner = pcall(function() return component:GetOwner() end)
    return ok and owner or nil
end

local stimValues
local function nativeStim(event)
    if stimValues == nil then
        stimValues = {}
        for _, name in ipairs(M.STIMS) do
            local ok, value = pcall(function() return Enum.new('gamedataStimType', name) end)
            if ok and value ~= nil then stimValues[#stimValues + 1] = {name = name, value = value} end
        end
    end
    local ok, kind = pcall(function() return event:GetStimType() end)
    if not ok or kind == nil then return nil end
    for _, row in ipairs(stimValues) do if kind == row.value then return row.name end end
    return nil
end

-- Combat and scene dialogue keep every vanilla reaction.
local function nativeEligible(object)
    local combatOk, combat = pcall(function() return NPCPuppet.IsInCombat(object) end)
    if combatOk and combat == true then return false end
    local dialogueOk, dialogue = pcall(function()
        return Game.GetSceneSystem():GetScriptInterface():IsEntityInDialogue(object:GetEntityID())
    end)
    if dialogueOk and dialogue == true then return false end
    return true
end

-- The bark window lives on the player (Engagement.reds): hold(seconds) never shortens it, release(seconds) ends it that long from now.
local function nativeBarkGate()
    return {
        hold = function(seconds) Game.GetPlayer():ConvaiBarkHold(seconds) end,
        release = function(seconds) Game.GetPlayer():ConvaiBarkRelease(seconds) end,
    }
end

local function nativeMounted(event)
    local ok, mounted = pcall(function() return event.isMounted end)
    if not ok then return nil end
    return mounted == true
end

function M.new(options)
    options = options or {}
    local cfg = {}
    for key, value in pairs(M.DEFAULTS) do cfg[key] = value end
    for key, value in pairs(options.config or {}) do cfg[key] = value end
    local clock = options.clock or os.time
    local entityOf = options.entity or nativeEntity
    local ownerOf = options.owner or nativeOwner
    local stimOf = options.stim or nativeStim
    local eligible = options.eligible or nativeEligible
    local mountedOf = options.mounted or nativeMounted
    local round = options.round
    local barkGate = options.barkGate or nativeBarkGate()
    local log = options.log or function() end
    local holds, logged, counts, installed = {}, {}, {}, {}
    -- No hold is active after this clock value: the latest moment any hold can still count (a pinned one until maxPinned, a timed
    -- one until its end). R.idle uses it so that holds which have all run out stop the hooks' per-NPC work (see R.idle).
    local quietAfter = -math.huge
    local function extend(hold)
        local last = hold.pinned and hold.since + cfg.maxPinned or hold.untilAt
        if last > quietAfter then quietAfter = last end
    end
    local R = {}
    -- The bark window as the game side knows it (this clock), the line that opened it, and whether an AI line holds it.
    local barkUntil, barkSpeaking, barkMissing, barkCalls = -math.huge, false, false, 0

    local function currentRound()
        if type(round) ~= 'function' then return nil end
        local ok, value = pcall(round)
        if ok and type(value) == 'table' and type(value.participants) == 'table' then return value end
        return nil
    end

    local function participant(hash)
        local value = currentRound()
        if not value then return false end
        for _, person in ipairs(value.participants) do
            if type(person) == 'table' and person.entity == hash then return true end
        end
        return false
    end

    local function hashOf(target)
        if type(target) == 'string' then return target ~= '' and target or nil end
        return entityOf(target)
    end

    -- True while the mod addresses this NPC (entity hash string).
    function R.addressed(hash)
        if hash == nil then return false end
        local hold, now = holds[hash], clock()
        if hold then
            if hold.pinned and now - hold.since <= cfg.maxPinned then return true end
            if not hold.pinned and now < hold.untilAt then return true end
            holds[hash] = nil
        end
        if participant(hash) then
            -- A group participant keeps the grace after the round ends.
            holds[hash] = {pinned = false, since = now, untilAt = now + cfg.grace, reason = 'group'}
            extend(holds[hash])
            return true
        end
        return false
    end

    -- Nothing addressed: every hook returns to vanilla at once. A hold that has run out is dropped only when its own NPC is next
    -- checked (R.addressed), and an NPC V talked to and walked away from is never checked again: once every hold has run out they
    -- are all dropped here, as R.addressed would drop each, so every other NPC's stimulus, look-at and bump is vanilla again
    -- without a stimulus read or an owner lookup (before, one finished conversation kept that work on for the rest of the session).
    function R.idle()
        if next(holds) ~= nil then
            -- The hooks call this unprotected: a clock that fails means "not idle", and the protected checks decide.
            local ok, now = pcall(clock)
            if not ok or now <= quietAfter then return false end
            holds = {}
        end
        return currentRound() == nil
    end

    -- The mod starts addressing an NPC (an entity or its hash) until release().
    function R.focus(target, reason)
        local hash = hashOf(target)
        if not hash then return false end
        R.ensureHooks()
        holds[hash] = {pinned = true, since = clock(), reason = reason or 'focus'}
        extend(holds[hash])
        return true
    end

    -- A timed hold (seconds), never shortening a longer one.
    function R.hold(target, seconds, reason)
        local hash = hashOf(target)
        if not hash then return false end
        R.ensureHooks()
        local now = clock()
        local untilAt = now + (tonumber(seconds) or cfg.grace)
        local hold = holds[hash]
        if hold and (hold.pinned or hold.untilAt >= untilAt) then return true end
        holds[hash] = {pinned = false, since = now, untilAt = untilAt, reason = reason or 'hold'}
        extend(holds[hash])
        return true
    end

    -- The mod stops addressing: every hold keeps only the grace.
    function R.release(grace)
        local untilAt = clock() + (tonumber(grace) or cfg.grace)
        quietAfter = -math.huge
        for _, hold in pairs(holds) do
            if hold.pinned or hold.untilAt > untilAt then hold.pinned, hold.untilAt = false, untilAt end
            extend(hold)
        end
    end

    -- A load, detach or shutdown: nothing stays quiet.
    function R.clear()
        holds, logged = {}, {}
        quietAfter = -math.huge
        if barkUntil > -math.huge and not barkMissing then pcall(barkGate.release, 0) end
        barkUntil, barkSpeaking = -math.huge, false
    end

    local function quiet(kind, object)
        local hash = entityOf(object)
        if not R.addressed(hash) then return false end
        local ok, allowed = pcall(eligible, object)
        if ok and allowed == false then return false end
        counts[kind] = (counts[kind] or 0) + 1
        local key, now = hash .. '|' .. kind, clock()
        if not logged[key] or now - logged[key] >= cfg.logEvery then
            logged[key] = now
            log('Suppressed vanilla reaction ' .. kind .. ' for ' .. hash)
        end
        return true
    end

    -- Each returns true when the vanilla handler must be skipped.
    function R.stimulus(component, event)
        if R.idle() then return false end
        local kind = stimOf(event)
        if not kind then return false end
        return quiet('stim:' .. kind, ownerOf(component))
    end

    function R.reaction(kind, component)
        if R.idle() then return false end
        return quiet(kind, ownerOf(component))
    end

    function R.bump(component, event)
        if R.idle() then return false end
        -- A vehicle bump (or an unreadable event) keeps the dodge.
        if mountedOf(event) ~= false then return false end
        return quiet('bump', ownerOf(component))
    end

    -- Opens (or extends, never shortens) the ambient-bark window for `seconds`. One native call, and none when the window already
    -- covers the time asked for (a repeat event is a number compare). A game without the redscript part (not restarted after the
    -- update) answers with an error once; the window is then left alone for the session and nothing else is affected.
    function R.barkHold(seconds, reason)
        seconds = tonumber(seconds) or cfg.talkHold
        if barkMissing or seconds <= 0 then return false end
        local ok, now = pcall(clock)
        if not ok or type(now) ~= 'number' then return false end
        local untilAt = now + seconds
        if untilAt <= barkUntil then return true end
        local opened = now >= barkUntil
        local called, err = pcall(barkGate.hold, seconds)
        if not called then
            barkMissing = true
            log('Ambient bark window unavailable: ' .. tostring(err))
            return false
        end
        barkUntil, barkCalls = untilAt, barkCalls + 1
        if opened then log('Ambient barks held for ' .. tostring(seconds) .. ' s (' .. tostring(reason or 'conversation') .. ')') end
        return true
    end

    -- Ends the window `grace` seconds from now (also when it was longer), only when one is open. One probe line says why.
    function R.barkRelease(grace, reason)
        if barkMissing then return false end
        local ok, now = pcall(clock)
        if not ok or type(now) ~= 'number' or now >= barkUntil then barkUntil = -math.huge; return false end
        grace = tonumber(grace) or cfg.endGrace
        local called = pcall(barkGate.release, grace)
        if not called then return false end
        barkUntil, barkCalls = now + grace, barkCalls + 1
        log('Ambient barks released in ' .. tostring(grace) .. ' s (' .. tostring(reason or 'conversation end') .. ')')
        return true
    end

    -- The conversation's focus ran out by itself: the quiet tail, then the barks may play again.
    function R.barkIdle() return R.barkRelease(cfg.idleTail, 'quiet') end

    -- V pressed the talk key (the composer or the microphone opened), and V's line was sent.
    function R.talkPressed() return R.barkHold(cfg.talkHold, 'talk key') end
    function R.requestSent() return R.barkHold(cfg.requestHold, 'request sent') end

    -- An AI line starts to play: the window stays open until it ends.
    function R.speechStarted()
        barkSpeaking = true
        return R.barkHold(cfg.speechHold, 'AI line')
    end

    -- An AI line ended (or was cut): the quiet tail (V's next turn or a follow-up refreshes it), then the barks may play again. Only a line that held the window shortens it,
    -- so a stop with nothing playing never ends the conversation's own window.
    function R.speechEnded()
        if not barkSpeaking then return false end
        barkSpeaking = false
        return R.barkRelease(cfg.lineTail, 'line ended')
    end

    function R.status()
        local addressed = {}
        for hash, hold in pairs(holds) do
            local row = {entity = hash, reason = hold.reason, pinned = hold.pinned == true}
            if not hold.pinned then row.remaining = math.max(0, hold.untilAt - clock()) end
            addressed[#addressed + 1] = row
        end
        local copy = {}
        for kind, count in pairs(counts) do copy[kind] = count end
        return {addressed = addressed, suppressed = copy, hooks = installed,
            bark = {open = barkUntil > clock(), speaking = barkSpeaking, calls = barkCalls, unavailable = barkMissing}}
    end

    -- Registers the CET overrides (once per onInit; a CET reload registers again).
    -- ReactionManagerComponent.OnEventReceived runs for every stimulus sent to
    -- every NPC; even an early-returning CET Override costs main-thread time on
    -- each call. In the game (no override passed) the hooks are registered only
    -- when an NPC is first addressed (focus/hold), so a session without a
    -- conversation never pays for them. An explicit override installs at once.
    local deferred
    local function installNow(override)
        installed = {}
        if type(override) ~= 'function' then return false end
        -- A failing check never blocks the vanilla handler.
        local function skip(check, ...)
            local ok, result = pcall(check, ...)
            return ok and result == true
        end
        local function hook(method, handler)
            local ok, err = pcall(override, 'ReactionManagerComponent', method, handler)
            if ok then installed[#installed + 1] = method
            else log('Vanilla reaction hook unavailable: ' .. method .. ' ' .. tostring(err)) end
        end
        -- Nothing addressed (the usual state): straight back to vanilla, without the protected call, the varargs or the
        -- stimulus read. R.idle is the same test the checks below start with, so the verdict is unchanged.
        hook('OnEventReceived', function(self, event, wrapped)
            if R.idle() then return wrapped(event) end
            if skip(R.stimulus, self, event) then return false end
            return wrapped(event)
        end)
        hook('TriggerFacialLookAtReaction', function(self, forceFear, playVO, wrapped)
            if R.idle() then return wrapped(forceFear, playVO) end
            if skip(R.reaction, 'lookat', self) then return end
            return wrapped(forceFear, playVO)
        end)
        hook('OnAreaEnter', function(self, trigger, wrapped)
            if R.idle() then return wrapped(trigger) end
            if skip(R.reaction, 'comfort-zone', self) then return false end
            return wrapped(trigger)
        end)
        hook('OnDistrurbComfortZoneAggressiveEvent', function(self, event, wrapped)
            if R.idle() then return wrapped(event) end
            if skip(R.reaction, 'comfort-zone-provoke', self) then return false end
            return wrapped(event)
        end)
        hook('OnBumpEvent', function(self, event, wrapped)
            if R.idle() then return wrapped(event) end
            if skip(R.bump, self, event) then return false end
            return wrapped(event)
        end)
        log('Vanilla reaction hooks: ' .. table.concat(installed, ', '))
        return #installed > 0
    end
    function R.install(override)
        if override ~= nil then deferred = nil; return installNow(override) end
        if type(Override) ~= 'function' then return false end
        deferred = Override
        return true
    end
    -- Registers deferred hooks once; called when the mod first addresses an NPC.
    function R.ensureHooks()
        if not deferred then return #installed > 0 end
        local override = deferred
        deferred = nil
        return installNow(override)
    end

    return R
end

return M
