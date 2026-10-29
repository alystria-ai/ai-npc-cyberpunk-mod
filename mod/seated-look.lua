local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end
-- Free look while V sits (docs/COMPANION_SEATING.md, "Looking at her").
--
-- The game clamps V's first-person camera inside a workspot with a named
-- camera parameter set (fppCameraParamSets.Workspot: yaw +-15, pitch -15..0;
-- WorkspotUnlocked: yaw +-15, pitch -15..15). The native camera copies those
-- limits into V's FPPCameraComponent (yawMaxLeft, yawMaxRight, pitchMin,
-- pitchMax) when the player state machine enters its Workspot state.
--
-- Live finding (October 10): writing the TweakDB flats does not work. CET's
-- TweakDB:SetFlat fails in this install ("expected userdata, received nil"),
-- and TweakXL's TweakDBBatch writes the flats but the camera does not read them
-- again (a rewritten Workspot set and even Default still gave the old limits
-- through SetCameraParamsEvent), so the sets are cached natively at load. What
-- does work is the game's own SetCameraParamsWithOverridesEvent: queued on
-- the player with the four limits, it lands in the camera component at once.
--
-- Live finding 2 (October 10, user sits): V's chairs and couches are scene
-- sits at scene tier 3 with no readable workspot instance, and their camera
-- limits are the scene's own (60.9 left, -88.9 right, pitch -56.8..79.1 on the
-- couch). So the gate is: the Workspot state was entered and either the
-- workspot classifies as a seat (a named player workspot) or the scene tier
-- is 3 with no instance. The override goes out 0.4 s after the entry (a scene
-- ending flickers the state in and out within milliseconds, and the exit
-- cancels the delayed copy), and again whenever the scene resends its tier 3
-- camera limits while V sits (DefaultTransition.QueueSetCameraParamsEvent_Tier3Scene). Nothing runs per frame: the hooks
-- fire on state entry, exit and scene camera changes only.
--
local M = {}

M.limits = {
    yawMaxLeft = 130,   -- degrees, positive is left (a neighbour on the bench is about 90 off; 130 reaches over the shoulder)
    yawMaxRight = -130, -- negative is right
    pitchMax = 60,      -- looking up
    pitchMin = -65,     -- looking down
    sensitivityMultX = 1,
    sensitivityMultY = 1,
}
M.baseSet = 'WorkspotUnlocked' -- named set the overrides apply to in a plain workspot
M.sceneSet = 'Tier3Scene'      -- ... and in a scene (scene tier 3)
M.settle = .4                  -- seconds until the second copy of the event

-- Is V sitting in an ordinary seat right now, as far as the game's own scene flags can say? V's chairs and couches are SCENE sits (scene tier 3;
-- live 2026-10-19: a plain couch sit was refused as "dialogue", so the dialogue or the choice-hub flag is up while V
-- sits, and the manager's shortcut refused at tier 3). So tier 3 with those flags is what an ordinary sit looks like, and only what the scene
-- does on top of it tells a real cutscene apart: a game line that is not the crowd's since V sat down, a phone call, a fight, V replaced or
-- mounted, scene tier 4 or above.
--   sit     {kind, at}: what this module's controller holds while V sits (kind: couch, bench, scene ..., at: os.time seconds of the sit)
--   sample  the battle observer's player-side sample (mod/battle-observer.lua)
--   lines   the game-dialogue rows (newest last; {at = os.time seconds, channel}), or nil
-- Pure. The observer calls it through its sitProbe hook and puts the answer in sample.sitting.
function M.plain(sit, sample, lines)
    if type(sit) ~= 'table' or sit.kind == nil or type(sample) ~= 'table' or sample.available ~= true then return false end
    if sample.call == true or sample.combat == true or sample.replacer == true or sample.vehicle == true then return false end
    local tier = tonumber(sample.tier)
    if tier == nil or tier > 3 then return false end
    if type(lines) == 'table' and type(sit.at) == 'number' then
        for index = #lines, math.max(1, #lines - 39), -1 do
            local row = lines[index]
            if type(row) == 'table' and type(row.at) == 'number' then
                if row.at < sit.at then break end
                if row.channel ~= 'ambient' then return false end
            end
        end
    end
    return true
end

-- native: {seat() -> {path, anim, tier, vehicle}, queue(limits, set), delay(limits, set, seconds) -> id,
--   cancel(id), classify(path, anim) -> kind or nil, log(kind, fields), now() (optional: os.time
--   seconds, for the controller's sitAt)}.
-- The controller's sitting (the seat kind, or nil) and sitAt (when V sat) are what M.plain reads.
function M.new(native)
    local self = {native = native, pending = nil, sitting = nil, sits = 0, widened = 0}
    local function log(kind, fields)
        if native.log then pcall(native.log, kind, fields) end
    end

    -- now = queue at once (behind a scene's own camera event); otherwise only the
    -- delayed copy goes out. The Workspot state flickers OnForcedExit / OnEnter a
    -- few milliseconds apart when a scene ends (live, tier 4), so an entry never
    -- sends at once: the delayed copy is cancelled by the exit that follows, and
    -- no stray event can land after V stands.
    local function send(set, note, now)
        local queued, queueError = true, nil
        if now then queued, queueError = pcall(native.queue, M.limits, set) end
        local delayed, id = pcall(native.delay, M.limits, set, M.settle)
        if delayed then self.pending = id end
        log('seated-look', {kind = self.sitting, set = set, queued = queued, delayed = delayed, note = note,
            error = (not queued and tostring(queueError)) or (not delayed and tostring(id)) or nil})
        return delayed or (now == true and queued)
    end

    -- The player state machine entered Workspot. V's sits are either a named
    -- workspot (path readable, classified like the companion seating does) or
    -- a scene sit at scene tier 3 with no workspot instance at all (every chair
    -- and couch in the October 10 live runs).
    function self.entered()
        self.sits = self.sits + 1
        self.sitting, self.sitAt = nil, nil
        local ok, seat = pcall(native.seat)
        if not ok or type(seat) ~= 'table' then log('seated-look-error', {stage = 'seat', error = tostring(seat)}); return false end
        if seat.vehicle and seat.vehicle ~= 0 then log('seated-look-skip', {reason = 'in a vehicle'}); return false end
        local classified, kind = pcall(native.classify, seat.path, seat.anim)
        kind = classified and kind or nil
        local set = M.baseSet
        if not kind and not seat.path and seat.tier == 3 then kind, set = 'scene', M.sceneSet end
        if not kind then
            log('seated-look-skip', {path = seat.path, anim = seat.anim, tier = seat.tier,
                reason = seat.path and 'not a seat' or 'no workspot instance outside scene tier 3'})
            return false
        end
        self.sitting, self.set = kind, set
        self.sitAt = (native.now or os.time)()
        self.widened = self.widened + 1
        log('seated-look-enter', {path = seat.path, anim = seat.anim, tier = seat.tier, kind = kind})
        return send(set, 'enter', false)
    end

    -- A scene sent its own tier 3 camera limits (the narrow ones) while V sits:
    -- the override goes in behind them.
    function self.sceneCamera()
        if not self.sitting then return false end
        return send(self.set, 'scene camera', true)
    end

    -- The state machine left Workspot: the second copy must not land on a V
    -- who already stands.
    function self.left()
        local id = self.pending
        self.pending, self.sitting, self.sitAt = nil, nil, nil
        if id ~= nil then pcall(native.cancel, id) end
    end

    -- The session was released (a load, a detach, a death): drop the state without a native call. The delayed event died
    -- with the old world, and a CancelDelay on the engine's delay system now is a call into something being destroyed.
    function self.forget()
        self.pending, self.sitting, self.sitAt = nil, nil, nil
    end

    return self
end

-- Game wiring: Observe hooks on the player's Workspot state and on the scene
-- camera parameters. Returns the controller, or nil and a reason (the class or
-- hook missing in this build).
function M.install(options)
    options = options or {}
    local native = {classify = options.classify, log = options.log, now = options.now}
    function native.seat()
        local player = convaiPlayer()
        local seat = {}
        pcall(function()
            local defs = Game.GetAllBlackboardDefs().PlayerStateMachine
            local board = Game.GetBlackboardSystem():GetLocalInstanced(player:GetEntityID(), defs)
            seat.tier, seat.vehicle = board:GetInt(defs.SceneTier), board:GetInt(defs.Vehicle)
        end)
        pcall(function()
            local instance = Game.GetWorkspotSystem():GetWorkspotInstance(player:GetEntityID())
            if not instance then return end
            pcall(function() seat.anim = NameToString(instance.idleAnim) .. ' ' .. NameToString(instance.animName) end)
            pcall(function() seat.path = ResRef.ToString(instance.resource.path) end)
            if not seat.path or seat.path == '' then pcall(function() seat.path = tostring(instance.resource.path) end) end
        end)
        return seat
    end
    local function event(limits, set)
        local ev = SetCameraParamsWithOverridesEvent.new()
        ev.paramsName = CName.new(set)
        for key, value in pairs(limits) do ev[key] = value end
        return ev
    end
    function native.queue(limits, set) convaiPlayer():QueueEvent(event(limits, set)) end
    function native.delay(limits, set, seconds)
        return Game.GetDelaySystem():DelayEvent(convaiPlayer(), event(limits, set), seconds, false)
    end
    function native.cancel(id) Game.GetDelaySystem():CancelDelay(id) end
    local controller = M.new(native)
    -- options.live() is false while the main mod has released its session (a save load tears the player's state machine down
    -- and exits the Workspot state with a delayed copy still pending): the exit hooks then only forget it, and make no call
    -- into the delay system. Entering is never gated: the player state machine cannot enter a state during a teardown,
    -- and a save loaded while V sits must still be widened.
    local live = options.live
    local function left() if not live or live() then controller.left() else controller.forget() end end
    local hooked, reason = pcall(function()
        ObserveAfter('WorkspotEvents', 'OnEnter', function() controller.entered() end)
        ObserveAfter('WorkspotEvents', 'OnExit', left)
        ObserveAfter('WorkspotEvents', 'OnForcedExit', left)
        ObserveAfter('DefaultTransition', 'QueueSetCameraParamsEvent_Tier3Scene', function() controller.sceneCamera() end)
    end)
    if not hooked then return nil, tostring(reason) end
    return controller
end

return M
