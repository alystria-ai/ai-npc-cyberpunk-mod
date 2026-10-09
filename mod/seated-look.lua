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

-- native: {seat() -> {path, anim, tier, vehicle}, queue(limits, set), delay(limits, set, seconds) -> id,
--   cancel(id), classify(path, anim) -> kind or nil, log(kind, fields)}.
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
        self.sitting = nil
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
        self.pending, self.sitting = nil, nil
        if id ~= nil then pcall(native.cancel, id) end
    end

    return self
end

-- Game wiring: Observe hooks on the player's Workspot state and on the scene
-- camera parameters. Returns the controller, or nil and a reason (the class or
-- hook missing in this build).
function M.install(options)
    options = options or {}
    local native = {classify = options.classify, log = options.log}
    function native.seat()
        local player = Game.GetPlayer()
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
    function native.queue(limits, set) Game.GetPlayer():QueueEvent(event(limits, set)) end
    function native.delay(limits, set, seconds)
        return Game.GetDelaySystem():DelayEvent(Game.GetPlayer(), event(limits, set), seconds, false)
    end
    function native.cancel(id) Game.GetDelaySystem():CancelDelay(id) end
    local controller = M.new(native)
    local hooked, reason = pcall(function()
        ObserveAfter('WorkspotEvents', 'OnEnter', function() controller.entered() end)
        ObserveAfter('WorkspotEvents', 'OnExit', function() controller.left() end)
        ObserveAfter('WorkspotEvents', 'OnForcedExit', function() controller.left() end)
        ObserveAfter('DefaultTransition', 'QueueSetCameraParamsEvent_Tier3Scene', function() controller.sceneCamera() end)
    end)
    if not hooked then return nil, tostring(reason) end
    return controller
end

return M
