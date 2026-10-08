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
-- Each suppression writes "Suppressed vanilla reaction <kind> for <entity>"
-- to the mod log (at most once every few seconds per NPC and kind), and
-- status() counts them for the CET console:
--   print(json.encode(convaiVanillaReactions.status()))
local M = {version = 1}

M.DEFAULTS = {
    grace = 6,        -- seconds an NPC stays quiet after the mod stops addressing it
    maxPinned = 900,  -- a focus older than this is no longer trusted (a missed release)
    logEvery = 3,     -- seconds between two log lines for one NPC and kind
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
    local log = options.log or function() end
    local holds, logged, counts, installed = {}, {}, {}, {}
    local R = {}

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
            return true
        end
        return false
    end

    -- Nothing addressed: every hook returns to vanilla at once.
    function R.idle() return next(holds) == nil and currentRound() == nil end

    -- The mod starts addressing an NPC (an entity or its hash) until release().
    function R.focus(target, reason)
        local hash = hashOf(target)
        if not hash then return false end
        holds[hash] = {pinned = true, since = clock(), reason = reason or 'focus'}
        return true
    end

    -- A timed hold (seconds), never shortening a longer one.
    function R.hold(target, seconds, reason)
        local hash = hashOf(target)
        if not hash then return false end
        local now = clock()
        local untilAt = now + (tonumber(seconds) or cfg.grace)
        local hold = holds[hash]
        if hold and (hold.pinned or hold.untilAt >= untilAt) then return true end
        holds[hash] = {pinned = false, since = now, untilAt = untilAt, reason = reason or 'hold'}
        return true
    end

    -- The mod stops addressing: every hold keeps only the grace.
    function R.release(grace)
        local untilAt = clock() + (tonumber(grace) or cfg.grace)
        for _, hold in pairs(holds) do
            if hold.pinned or hold.untilAt > untilAt then hold.pinned, hold.untilAt = false, untilAt end
        end
    end

    -- A load, detach or shutdown: nothing stays quiet.
    function R.clear()
        holds, logged = {}, {}
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

    function R.status()
        local addressed = {}
        for hash, hold in pairs(holds) do
            local row = {entity = hash, reason = hold.reason, pinned = hold.pinned == true}
            if not hold.pinned then row.remaining = math.max(0, hold.untilAt - clock()) end
            addressed[#addressed + 1] = row
        end
        local copy = {}
        for kind, count in pairs(counts) do copy[kind] = count end
        return {addressed = addressed, suppressed = copy, hooks = installed}
    end

    -- Registers the CET overrides (once per onInit; a CET reload registers again).
    function R.install(override)
        override = override or Override
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
        hook('OnEventReceived', function(self, event, wrapped)
            if skip(R.stimulus, self, event) then return false end
            return wrapped(event)
        end)
        hook('TriggerFacialLookAtReaction', function(self, forceFear, playVO, wrapped)
            if skip(R.reaction, 'lookat', self) then return end
            return wrapped(forceFear, playVO)
        end)
        hook('OnAreaEnter', function(self, trigger, wrapped)
            if skip(R.reaction, 'comfort-zone', self) then return false end
            return wrapped(trigger)
        end)
        hook('OnDistrurbComfortZoneAggressiveEvent', function(self, event, wrapped)
            if skip(R.reaction, 'comfort-zone-provoke', self) then return false end
            return wrapped(event)
        end)
        hook('OnBumpEvent', function(self, event, wrapped)
            if skip(R.bump, self, event) then return false end
            return wrapped(event)
        end)
        log('Vanilla reaction hooks: ' .. table.concat(installed, ', '))
        return #installed > 0
    end

    return R
end

return M
