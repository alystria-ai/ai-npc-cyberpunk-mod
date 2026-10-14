-- Companion stance: a managed companion crouches while V crouches and stands again
-- when V stands.
--
-- Mechanism (game scripts, NPCPuppet.ChangeStanceState and npcStateComponent): the
-- same call the game's own AI tasks use to crouch an NPC. It sets the NPC's stance
-- (gamedataNPCStanceState.Crouch / Stand), the 'stanceState' animation feature and
-- the 'inCrouch' anim wrapper. No AI role, command or movement code is touched.
--
-- Why that alone did nothing outside combat (live 2026-10-14: the log said "crouch hls=Relaxed",
-- the blackboard read Crouch, Evelyn stood): the NPC's locomotion graph plays the crouched walk
-- inside the high-level state's locomotion wrapper (npcStateComponent: Alerted -> 'alertedLocomotion',
-- Combat -> 'combatLocomotion', Stealth -> 'stealthLocomotion', Relaxed -> none). In Relaxed the
-- 'inCrouch' wrapper has no crouched locomotion to blend into (the likely cause, not yet proven in
-- game; the head reading below decides it). Vanilla followers crouch with V only in stealth, where
-- their own AI has put them in the Stealth high-level state.
--
-- So a crouch is now two steps, the way the game does it: first NPCPuppet.ChangeHighLevelState(Stealth)
-- (the call AIFollowerTakedownCommandHandler and the 'alwaysUseStealth' move commands make; no senses
-- preset change, no prevention registration, and AIFollowerRole barks only with a hostile threat), then
-- 0.15 s later the stance call (two state-change signals in one frame could overwrite each other). The
-- fallback is Alerted, used only when the head slot shows the Stealth crouch did not come down. A state the
-- game chose itself is never changed (only Relaxed is raised), and a state we raised is put back to Relaxed
-- when V stands (stance call first, then the high-level call), but only while it still reads the level
-- we set. Gestures and the holster handoff require Relaxed, so it must come back: it is read back and
-- re-issued like the stand.
--
-- Read-back, in three layers, each on a bounded timer: the stance and high-level blackboards (did the
-- request stick), and the Head slot height above her feet (did the body really go down: one slot read
-- per check, compared with her standing height read before the crouch). Every method line in probe.log
-- names the method and the result: 'crouch issued via stealth ...', then 'crouch confirmed via stealth:
-- head down 0.40 m' or 'crouch NOT visible via stealth ...; trying alerted'. A stand ends in
-- 'stand confirmed ... head back' or 'stand not kept by the game'.
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
-- A stand is read back the same way (live 2026-10-13: a stand that was logged left her
-- crouched), re-issued a few times while the stance still reads Crouch, and V crouching
-- again during that window adopts the crouch that is still there instead of ignoring it.
--
-- A body-animation workspot (the idle and talk gestures in companion-gestures.lua) takes
-- the pose. Gestures never start while V crouches or a companion is held crouched, and
-- leave when V crouches, so the crouch waits for the workspot to end and is never taken
-- apart by it (live: a gesture start forced a stand, then a crouch, then the gesture
-- exited 'not relaxed'). A seat or scene workspot still stands her.
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
    standRetryGap = 0.6, -- seconds between re-issues of a stand the game ignored (the stand path stays quick)
    maxRetries = 3,     -- re-issues per crouch before the module leaves that companion alone
    logGap = 1.0,       -- seconds between probe-log lines for one companion
    stanceGap = 0.15,   -- seconds between the high-level call and the stance call (one signal per frame)
    seenWithin = 2.0,   -- seconds after the stance call in which the head must come down, or the next method runs
    seenDrop = 0.2,     -- metres the Head slot must drop below her standing height to count as crouched
    standRise = 0.12,   -- metres below her standing height the head may stay once she stands
    -- Methods in order. 'stealth' and 'alerted' raise that high-level state before the stance call.
    -- Remove both to get the stance call alone.
    methods = {'stealth', 'alerted'},
}
-- Method name -> gamedataNPCHighLevelState it raises.
local LEVEL = {stealth = 'Stealth', alerted = 'Alerted'}

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
    -- 'Relaxed', 'Stealth', 'Alerted', ... (nil when unreadable).
    function N.highLevel(npc)
        return try(function()
            local state = npc:GetHighLevelStateFromBlackboard()
            return tostring(state.value or state)
        end)
    end
    -- NPCPuppet.ChangeHighLevelState: the call the game's follower and move-command tasks make
    -- (queues one NPCStateChangeSignal; returns early when the blackboard already matches).
    function N.setHighLevel(npc, name)
        local ok, err = pcall(function()
            if not npc:IsA('NPCPuppet') then error('not an NPC puppet') end
            NPCPuppet.ChangeHighLevelState(npc, Enum.new('gamedataNPCHighLevelState', name))
        end)
        return ok, ok and nil or tostring(err)
    end
    -- Head slot height above her feet in metres, or nil. One slot read; same call as init.lua's
    -- seated measure. Standing about 1.6-1.7, crouched about 1.0-1.2.
    function N.headRise(npc)
        return try(function()
            local slot = npc:GetSlotComponent()
            if not slot then return nil end
            local found, transform = slot:GetSlotTransform(CName.new('Head'))
            if not found or not transform then return nil end
            local head = WorldPosition.ToVector4(WorldTransform.GetWorldPosition(transform))
            local feet = npc:GetWorldPosition()
            if not head or not feet or type(head.z) ~= 'number' or type(feet.z) ~= 'number' then return nil end
            return head.z - feet.z
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

    local T = {events = 0, applied = 0, stands = 0, retries = 0, escalations = 0}
    local crouched = nil        -- V's last known crouch; nil until the first event or one read
    local dirty = false
    local holding = 0           -- companions currently held crouched by this module
    local clock, nextSync = 0, 0
    local episode = 0           -- bumped on every change of V's stance
    -- serial -> {at, stanceAt, retries, episode, gaveUp, method, label, raised, stanceDue, baseline, settled}
    local records = {}
    -- serial -> {at, retries, stand, level, hlsSent, baseline}: a stand issued and not yet read back,
    -- and/or a raised high-level state not yet put back
    local pending = {}
    local pendingCount = 0
    local waiting = {}          -- serial -> reason a wanted crouch is held back (logged once per reason)
    local failedIn = {}         -- serial -> episode in which the stance call raised an error: not tried again until V's stance changes
    local lastSay = {}

    local function label(entry) return tostring(entry.profileKey or entry.name or entry.serial) end
    -- One probe-log line per companion at most every logGap seconds; the lines in
    -- between are counted and mentioned on the next one. Method and result lines are
    -- forced: they are what a live test is read from.
    local function say(entry, text, force)
        local last = lastSay[entry.serial]
        if not force and last and clock - last.at < cfg.logGap then
            last.skipped = last.skipped + 1
            return
        end
        local extra = last and last.skipped > 0 and (' (+' .. last.skipped .. ' not logged)') or ''
        lastSay[entry.serial] = {at = clock, skipped = 0}
        pcall(log, 'Companion stance: ' .. text .. ' (' .. label(entry) .. ')' .. extra)
    end

    local function fmt(value) return string.format('%.2f', tonumber(value) or 0) end
    local function wake(after) nextSync = math.min(nextSync, clock + after) end
    local function hlsRead(entry) return native.highLevel and native.highLevel(entry.npc) or nil end
    -- ' stance=Crouch hls=Stealth': what the blackboards read now (two cheap reads).
    local function stateText(entry)
        local hls = hlsRead(entry)
        return ' stance=' .. tostring(native.stance(entry.npc)) .. (hls and (' hls=' .. tostring(hls)) or '')
    end
    local function clearPending(serial)
        if pending[serial] then pending[serial] = nil; pendingCount = pendingCount - 1 end
    end
    local function setPending(serial, p)
        if not pending[serial] then pendingCount = pendingCount + 1 end
        pending[serial] = p
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

    -- Puts a high-level state this module raised back to Relaxed, but only while it still
    -- reads the level we set (never over combat, fear, unconscious or anything the game chose).
    local function dropRaise(entry, record)
        local level = record.raised
        if not level then return end
        record.raised = nil
        if hlsRead(entry) == level and native.setHighLevel then native.setHighLevel(entry.npc, 'Relaxed') end
    end

    -- Takes the next method that can run: raises the high-level state (Stealth, then Alerted)
    -- the way the game's own follower tasks do (NPCPuppet.ChangeHighLevelState), without
    -- touching the stance yet. Only from Relaxed (or from the level we raised ourselves): a
    -- state the game chose is never changed. Returns the method name, or nil when none is left
    -- (the stance call alone, as before).
    local function pickMethod(entry, record)
        while true do
            record.method = record.method + 1
            local name = cfg.methods[record.method]
            if not name then break end
            local level = LEVEL[name]
            if level and native.setHighLevel and native.highLevel then
                local cur = native.highLevel(entry.npc)
                if cur == nil or (cur ~= 'Relaxed' and cur ~= record.raised) then break end
                local ok, err = native.setHighLevel(entry.npc, level)
                if ok then
                    record.raised, record.label, record.at = level, name, clock
                    record.from = record.from or cur
                    return name
                end
                say(entry, 'high-level ' .. level .. ' failed: ' .. tostring(err), true)
            end
        end
        record.label = 'stance'
        return nil
    end

    -- The stance call. With a raised high-level state it follows the raise by stanceGap: two
    -- state-change signals in one frame could overwrite each other.
    local function issueCrouch(entry, record, first)
        local ok, err = native.set(entry.npc, 'Crouch')
        if not ok then
            say(entry, 'crouch failed: ' .. tostring(err), true)
            failedIn[entry.serial] = episode
            dropRaise(entry, record)
            if records[entry.serial] == record then records[entry.serial] = nil; holding = holding - 1 end
            return false
        end
        record.stanceDue = false
        record.at, record.stanceAt = clock, clock
        wake(cfg.verifyAfter)
        if first then
            T.applied = T.applied + 1
            say(entry, 'crouch issued via ' .. record.label .. (record.raised
                and (' (hls ' .. tostring(record.from) .. ' -> ' .. record.raised .. ', then stance Crouch)') or '')
                .. stateText(entry), true)
        end
        return true
    end

    local function beginCrouch(entry, inherited)
        local record = {at = clock, retries = 0, episode = episode, method = 0, label = 'stance',
            stanceDue = true, raised = inherited}
        record.baseline = native.headRise and native.headRise(entry.npc) or nil
        records[entry.serial] = record
        holding = holding + 1
        if pickMethod(entry, record) then
            wake(cfg.stanceGap)         -- the stance call follows on the next short timer
            return
        end
        issueCrouch(entry, record, true)
    end

    local function release(entry, record, reason)
        records[entry.serial] = nil
        holding = holding - 1
        local p = {at = clock, retries = 0, stand = false, level = record.raised, baseline = record.baseline}
        local before = pending[entry.serial]
        if not p.level and before then p.level = before.level end
        -- Stand only from the crouch this module set; cover or a vehicle seat
        -- chosen by the game's AI is left alone.
        local now = native.stance(entry.npc)
        local line
        if now == 'Crouch' or now == nil then
            local ok, err = native.set(entry.npc, 'Stand')
            if ok then
                T.stands = T.stands + 1
                p.stand = true
                line = 'stand issued' .. (reason and (' - ' .. reason) or '') .. ' via stance'
                    .. (p.level and (', then hls ' .. p.level .. ' -> Relaxed') or '')
            else
                say(entry, 'stand failed: ' .. tostring(err), true)
            end
        else
            say(entry, 'stand not needed, stance is ' .. tostring(now), true)
        end
        if p.stand or p.level then
            -- Read back later: the request can be ignored without any error.
            setPending(entry.serial, p)
            wake(p.level and cfg.stanceGap or cfg.verifyAfter)
            if line then say(entry, line .. stateText(entry), true) end
        end
    end

    -- A stand we issued, and/or a raised high-level state: put the state back after the stance
    -- call, read both back, and re-issue what the game ignored.
    local function verifyStand(entry, p)
        if p.level and not p.hlsSent then
            if clock - p.at < cfg.stanceGap then return end
            if hlsRead(entry) == p.level then
                local ok, err = native.setHighLevel(entry.npc, 'Relaxed')
                if not ok then say(entry, 'hls Relaxed failed: ' .. tostring(err), true) end
                p.hlsSent, p.at = true, clock
                wake(cfg.verifyAfter)
                return
            end
            p.level = nil               -- the game moved it on (combat, ...): not ours to restore
        end
        if clock - p.at < cfg.verifyAfter then return end
        local stanceBad = p.stand and native.stance(entry.npc) == 'Crouch'
        local hlsBad = p.level ~= nil and hlsRead(entry) == p.level
        if not stanceBad and not hlsBad then
            local headText = ''
            if p.baseline and native.headRise then
                local rise = native.headRise(entry.npc)
                if rise then
                    local low = p.baseline - rise
                    if low > cfg.standRise then
                        if clock - p.at < cfg.seenWithin then wake(cfg.syncEvery); return end
                        clearPending(entry.serial)
                        say(entry, 'stand: blackboards read Stand but the head is still down ' .. fmt(low) .. ' m'
                            .. stateText(entry), true)
                        return
                    end
                    headText = ', head back (' .. fmt(low) .. ' m below standing)'
                end
            end
            clearPending(entry.serial)
            say(entry, 'stand confirmed' .. stateText(entry) .. headText, true)
            return
        end
        if p.retries >= cfg.maxRetries then
            clearPending(entry.serial)
            say(entry, 'stand not kept by the game' .. stateText(entry), true)
        elseif clock - p.at >= cfg.standRetryGap then
            p.retries, p.at = p.retries + 1, clock
            T.retries = T.retries + 1
            if stanceBad then
                if native.set(entry.npc, 'Stand') then say(entry, 'stand again', true) end
            elseif native.setHighLevel(entry.npc, 'Relaxed') then
                say(entry, 'hls Relaxed again', true)
            end
            wake(cfg.standRetryGap)
        end
    end

    -- The head slot did not come down although the blackboards say Crouch: the next method, or none.
    local function escalate(entry, record, low)
        local name = record.label
        local text = 'crouch NOT visible via ' .. name .. ': head down only ' .. fmt(low) .. ' m' .. stateText(entry)
        T.escalations = T.escalations + 1
        if record.raised and pickMethod(entry, record) then
            record.stanceAt = clock     -- the stance is already Crouch; only the high-level state changes
            wake(cfg.verifyAfter)
            say(entry, text .. '; trying ' .. record.label, true)
            return
        end
        record.settled = true
        dropRaise(entry, record)
        say(entry, text .. '; no method left' .. (name ~= 'stance' and ', hls back to Relaxed' or ''), true)
    end

    -- Read back a crouch we hold: the game's AI may have stood her up or reset the high-level
    -- state, and the head tells whether the pose is really down.
    local function checkCrouch(entry, record)
        if record.gaveUp or clock - record.at < cfg.verifyAfter then return end
        if native.stance(entry.npc) == 'Stand' then
            if record.retries >= cfg.maxRetries then
                record.gaveUp = true
                dropRaise(entry, record)
                say(entry, 'crouch not kept by the game', true)
            elseif clock - record.at >= cfg.retryGap then
                local ok = native.set(entry.npc, 'Crouch')
                record.retries, record.at = record.retries + 1, clock
                T.retries = T.retries + 1
                if ok then say(entry, 'crouch again') end
            end
            return
        end
        if record.raised and hlsRead(entry) == 'Relaxed' then
            -- The game's AI put the high-level state back: raise it again, a few times.
            if record.retries >= cfg.maxRetries then
                record.gaveUp, record.raised = true, nil
                say(entry, 'crouch: the game keeps resetting hls to Relaxed after ' .. record.label, true)
            else
                record.retries, record.at = record.retries + 1, clock
                T.retries = T.retries + 1
                native.setHighLevel(entry.npc, record.raised)
                say(entry, 'crouch: hls fell back to Relaxed, raised again (' .. record.label .. ')', true)
            end
            return
        end
        if record.settled then return end
        local rise = record.baseline and native.headRise and native.headRise(entry.npc) or nil
        if not rise then
            record.settled = true
            say(entry, 'crouch confirmed via ' .. record.label .. ' by the blackboards only (no head reading)'
                .. stateText(entry), true)
            return
        end
        local low = record.baseline - rise
        if low >= cfg.seenDrop then
            record.settled = true
            say(entry, 'crouch confirmed via ' .. record.label .. ': head down ' .. fmt(low) .. ' m' .. stateText(entry), true)
        elseif clock - record.stanceAt >= cfg.seenWithin then
            escalate(entry, record, low)
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
            waiting[entry.serial] = nil
            if not record then
                local now = native.stance(entry.npc)
                local p = pending[entry.serial]
                if p and now == 'Crouch' then
                    -- V crouched again before the last stand took effect: the crouch is
                    -- still there and is ours, so hold it and stand it with V next time.
                    clearPending(entry.serial)
                    local adopted = {at = clock, stanceAt = clock, retries = 0, episode = episode, method = 0,
                        label = 'stance', settled = true}
                    if p.level and hlsRead(entry) == p.level then adopted.raised, adopted.label = p.level, p.level:lower() end
                    records[entry.serial] = adopted
                    holding = holding + 1
                    return
                end
                -- A companion the game's AI already has crouched or in cover, or that
                -- sits in a vehicle, is not ours to change.
                if now ~= nil and now ~= 'Stand' then
                    if p and not p.level then clearPending(entry.serial) end
                    return
                end
                -- The stance call itself raised an error in this crouch of V's: the same call is not repeated every sync.
                if failedIn[entry.serial] == episode then return end
                -- A raised state not yet put back stays ours: this crouch takes it over.
                local inherited = p and p.level or nil
                clearPending(entry.serial)
                beginCrouch(entry, inherited)
                return
            end
            if record.stanceDue then
                if not record.raised or clock - record.at >= cfg.stanceGap then issueCrouch(entry, record, true) end
                return
            end
            checkCrouch(entry, record)
            return
        end
        if record then release(entry, record, crouched and reason or nil); return end
        if crouched then
            -- V crouches and this copy may not yet: say why, once per reason, so a late crouch is explained.
            if waiting[entry.serial] ~= reason then
                waiting[entry.serial] = reason
                say(entry, 'crouch waiting - ' .. tostring(reason), true)
            end
        else
            waiting[entry.serial] = nil
        end
        local p = pending[entry.serial]
        if p then verifyStand(entry, p) end
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
        if not (dirty or crouched or holding > 0 or pendingCount > 0) then return end
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
        for serial in pairs(pending) do
            if not present[serial] then clearPending(serial) end
        end
        for serial in pairs(waiting) do
            if not present[serial] then waiting[serial] = nil end
        end
        for serial in pairs(failedIn) do
            if not present[serial] then failedIn[serial] = nil end
        end
    end

    function T.crouched() return crouched == true end
    function T.holding() return holding end
    -- True while this module holds the copy crouched or is still standing her up. The gesture owner
    -- reads it (a table lookup) so no workspot starts over the pose.
    function T.holds(serial) return records[serial] ~= nil or pending[serial] ~= nil end
    -- A reload or world change: forget everything without a native call.
    function T.abandon()
        records, lastSay, holding, crouched, dirty = {}, {}, 0, nil, false
        pending, pendingCount, waiting, failedIn = {}, 0, {}, {}
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
