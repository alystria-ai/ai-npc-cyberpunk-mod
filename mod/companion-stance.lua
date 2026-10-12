-- Companion stance: a managed companion crouches while V crouches and stands again
-- when V stands.
--
-- Mechanism (game scripts, NPCPuppet.ChangeStanceState and npcStateComponent): the
-- same call the game's own AI tasks use to crouch an NPC. It sets the NPC's stance
-- (gamedataNPCStanceState.Crouch / Stand), the 'stanceState' animation feature and
-- the 'inCrouch' anim wrapper, so the follower's own locomotion graph plays the
-- crouched pose and walk. No AI role, command or movement code is touched.
--
-- Trigger: V's stance changes only through PlayerPuppet.OnLocomotionStateChanged
-- (the game's own blackboard listener, fired on change and never per frame).
-- playerState() is that event: it stores one boolean and a dirty flag, with no
-- native call. The next 10 Hz companion tick applies it. While V is not crouched and
-- no companion is held crouched, tick() is a few comparisons and returns. While a
-- crouch is active it re-checks at most every 0.5 s (a handful of reads per
-- companion) so a companion also stands when combat, a vehicle, a lift or a
-- workspot takes her, and crouches again afterwards.
--
-- Not fighting the game's AI: a crouch is only issued when the companion's stance
-- reads Stand (never over cover, vehicle or swim), a stand only when it reads Crouch
-- (never over cover the combat AI chose). If the AI resets the crouch the module
-- re-issues it a few times per crouch and then gives up for that crouch.
-- Only the managed copies companions.lua hands in are ever touched.
local M = {}

-- gamePSMLocomotionStates: Default 0, Crouch 1, Sprint 2, Kereznikov 3, Jump 4, Vault 5, Dodge 6,
-- DodgeAir 7, Workspot 8, Slide 9, SlideFall 10, CrouchSprint 11, CrouchDodge 12. Jump, vault, dodge
-- and slide are short and end in Default or Crouch, so they change nothing.
local CROUCHED = {[1] = true, [11] = true, [12] = true}
local STANDING = {[0] = true, [2] = true, [8] = true}
-- gamedataNPCStanceState: Any 0, Cover 1, Crouch 2, Stand 3, Swim 4, Vehicle 5, VehicleWindow 6.
local STANCE = {[1] = 'Cover', [2] = 'Crouch', [3] = 'Stand', [4] = 'Swim', [5] = 'Vehicle', [6] = 'VehicleWindow'}

local DEFAULTS = {
    syncEvery = 0.5,    -- seconds between checks while a crouch is active (events apply at the next 10 Hz tick)
    verifyAfter = 0.6,  -- seconds before a crouch we issued is read back
    retryGap = 1.0,     -- seconds between re-issues after the game's AI reset a crouch
    maxRetries = 3,     -- re-issues per crouch before the module leaves that companion alone
    logGap = 1.0,       -- seconds between probe-log lines for one companion
}

-- CET adapter. Every read is a pcall and returns nil when the game will not say.
function M.nativeAdapter()
    local N = {}
    local function try(fn, ...)
        local ok, value = pcall(fn, ...)
        if ok then return value end
        return nil
    end
    function N.playerCrouched(player)
        return try(function()
            local defs = Game.GetAllBlackboardDefs().PlayerStateMachine
            local state = player:GetPlayerStateMachineBlackboard():GetInt(defs.Locomotion)
            if CROUCHED[state] then return true end
            if STANDING[state] then return false end
            return nil
        end)
    end
    function N.playerCombat(player) return try(function() return player:IsInCombat() == true end) end
    function N.combat(npc) return try(function() return NPCPuppet.IsInCombat(npc) == true end) end
    function N.workspot(npc) return try(function() return Game.GetWorkspotSystem():IsActorInWorkspot(npc) == true end) end
    -- 'Stand', 'Crouch', 'Cover', 'Swim', 'Vehicle', 'VehicleWindow', or nil.
    function N.stance(npc)
        return try(function()
            local defs = Game.GetAllBlackboardDefs().PuppetState
            return STANCE[npc:GetPuppetStateBlackboard():GetInt(defs.Stance)]
        end)
    end
    function N.set(npc, name)
        local ok, err = pcall(function()
            if not npc:IsA('NPCPuppet') then error('not an NPC puppet') end
            NPCPuppet.ChangeStanceState(npc, Enum.new('gamedataNPCStanceState', name))
        end)
        return ok, ok and nil or tostring(err)
    end
    return N
end

function M.new(options)
    options = options or {}
    local native = options.native or M.nativeAdapter()
    local log = options.log or function() end
    local cfg = {}
    for key, value in pairs(DEFAULTS) do cfg[key] = value end
    for key, value in pairs(options.config or {}) do cfg[key] = value end

    local T = {events = 0, applied = 0, stands = 0, retries = 0}
    local crouched = nil        -- V's last known crouch; nil until the first event or one read
    local dirty = false
    local holding = 0           -- companions currently held crouched by this module
    local clock, nextSync = 0, 0
    local episode = 0           -- bumped on every change of V's stance
    local records = {}          -- serial -> {at, retries, episode, gaveUp}
    local lastSay = {}

    local function label(entry) return tostring(entry.profileKey or entry.name or entry.serial) end
    -- One probe-log line per companion at most every logGap seconds; the lines in
    -- between are counted and mentioned on the next one.
    local function say(entry, text)
        local last = lastSay[entry.serial]
        if last and clock - last.at < cfg.logGap then
            last.skipped = last.skipped + 1
            return
        end
        local extra = last and last.skipped > 0 and (' (+' .. last.skipped .. ' not logged)') or ''
        lastSay[entry.serial] = {at = clock, skipped = 0}
        pcall(log, 'Companion stance: ' .. text .. ' (' .. label(entry) .. ')' .. extra)
    end

    -- The game's blackboard event for V's stance. No native call here.
    function T.playerState(state)
        state = tonumber(state)
        if not state then return end
        local value
        if CROUCHED[state] then value = true elseif STANDING[state] then value = false else return end
        T.events = T.events + 1
        if value == crouched then return end
        crouched = value
        episode = episode + 1
        dirty = true
    end

    local function release(entry, record, reason)
        records[entry.serial] = nil
        holding = holding - 1
        -- Stand only from the crouch this module set; cover or a vehicle seat
        -- chosen by the game's AI is left alone.
        local now = native.stance(entry.npc)
        if now == 'Crouch' or now == nil then
            local ok, err = native.set(entry.npc, 'Stand')
            if ok then
                T.stands = T.stands + 1
                say(entry, 'stand' .. (reason and (' - ' .. reason) or ''))
            else
                say(entry, 'stand failed: ' .. tostring(err))
            end
        else
            say(entry, 'stand not needed, stance is ' .. tostring(now))
        end
    end

    local function reconcile(entry, player, blocker)
        local record = records[entry.serial]
        local reason
        if crouched then
            reason = blocker and blocker(entry, player) or nil
            if not reason then
                if native.playerCombat(player) == true or native.combat(entry.npc) == true then reason = 'combat'
                elseif native.workspot(entry.npc) == true then reason = 'workspot' end
            end
        end
        if crouched and not reason then
            if not record then
                -- A companion the game's AI already has crouched or in cover, or that
                -- sits in a vehicle, is not ours to change.
                local now = native.stance(entry.npc)
                if now ~= nil and now ~= 'Stand' then return end
                local ok, err = native.set(entry.npc, 'Crouch')
                if not ok then say(entry, 'crouch failed: ' .. tostring(err)); return end
                records[entry.serial] = {at = clock, retries = 0, episode = episode}
                holding = holding + 1
                T.applied = T.applied + 1
                say(entry, 'crouch')
                return
            end
            if record.gaveUp or clock - record.at < cfg.verifyAfter then return end
            -- Read back what was issued: the game's AI may have stood her up again.
            if native.stance(entry.npc) == 'Stand' then
                if record.retries >= cfg.maxRetries then
                    record.gaveUp = true
                    say(entry, 'crouch not kept by the game')
                elseif clock - record.at >= cfg.retryGap then
                    local ok = native.set(entry.npc, 'Crouch')
                    record.retries, record.at = record.retries + 1, clock
                    T.retries = T.retries + 1
                    if ok then say(entry, 'crouch again') end
                end
            end
            return
        end
        if record then release(entry, record, crouched and reason or nil) end
    end

    -- Called from the companion update (10 Hz) with the ready managed copies.
    -- blocker(entry, player) returns a reason string while a copy must stand
    -- (vehicle, lift, leaving, ...), or nil.
    function T.tick(step, entries, player, blocker)
        clock = clock + (tonumber(step) or 0)
        if crouched == nil then
            -- No event yet (a reload while V is crouched): read V once.
            if not entries or #entries == 0 or not player then return end
            crouched = native.playerCrouched(player) == true
            dirty = crouched
        end
        if not (dirty or crouched or holding > 0) then return end
        if not dirty and clock < nextSync then return end
        dirty, nextSync = false, clock + cfg.syncEvery
        local present = {}
        for _, entry in ipairs(entries or {}) do
            present[entry.serial] = true
            local ok, err = pcall(reconcile, entry, player, blocker)
            if not ok then T.error = tostring(err) end
        end
        -- A copy that left the party (dismissed, lost) is gone, not stood up.
        for serial in pairs(records) do
            if not present[serial] then records[serial] = nil; holding = holding - 1 end
        end
    end

    function T.crouched() return crouched == true end
    function T.holding() return holding end
    -- A reload or world change: forget everything without a native call.
    function T.abandon()
        records, lastSay, holding, crouched, dirty = {}, {}, 0, nil, false
    end

    return T
end

-- Installs the one game hook. The callback only forwards the new state.
function M.install(stance, log)
    if M.installed then return true end
    local ok, err = pcall(function()
        ObserveAfter('PlayerPuppet', 'OnLocomotionStateChanged', function(_, state)
            stance.playerState(state)
        end)
    end)
    if not ok then
        if log then pcall(log, 'Companion stance hook failed: ' .. tostring(err)) end
        return false
    end
    M.installed = true
    return true
end

return M
