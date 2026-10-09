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
-- So this module reacts to the state machine entering Workspot (an Observe on
-- WorkspotEvents.OnEnter, once per sit) and, when the workspot is a seat,
-- queues that event right away and once more 0.4 s later in case the native
-- parameters land after the script hook. The delayed copy is cancelled on exit.
-- Cost: nothing per frame; a few native calls per sit.
--
-- Only seats are touched (couch, bench, chair, bar stool, free stool: the same
-- classification the companion seating uses): locked workspots (takedowns,
-- trunk disposal), beds, cars and scenes are never changed.
local M = {}

M.limits = {
    yawMaxLeft = 90,    -- degrees, positive is left (a neighbour on the bench is about 90 off)
    yawMaxRight = -90,  -- negative is right
    pitchMax = 45,      -- looking up
    pitchMin = -50,     -- looking down
    sensitivityMultX = 1,
    sensitivityMultY = 1,
}
M.baseSet = 'WorkspotUnlocked' -- named set the overrides apply to
M.settle = .4                  -- seconds until the second copy of the event

-- native: {seat() -> path, anim, queue(limits), delay(limits, seconds) -> id,
--   cancel(id), classify(path, anim) -> kind or nil, log(kind, fields)}.
function M.new(native)
    local self = {native = native, pending = nil, sits = 0, widened = 0}
    local function log(kind, fields)
        if native.log then pcall(native.log, kind, fields) end
    end

    -- The player state machine entered Workspot.
    function self.entered()
        self.sits = self.sits + 1
        local ok, path, anim = pcall(native.seat)
        if not ok then log('seated-look-error', {stage = 'seat', error = tostring(path)}); return false end
        local classified, kind = pcall(native.classify, path, anim)
        kind = classified and kind or nil
        if not kind then
            log('seated-look-skip', {path = path, anim = anim, reason = path and 'not a seat' or 'no workspot instance'})
            return false
        end
        local queued, queueError = pcall(native.queue, M.limits)
        local delayed, id = pcall(native.delay, M.limits, M.settle)
        if delayed then self.pending = id end
        self.widened = self.widened + 1
        log('seated-look', {path = path, anim = anim, kind = kind, queued = queued, delayed = delayed,
            error = (not queued and tostring(queueError)) or (not delayed and tostring(id)) or nil})
        return queued or delayed
    end

    -- The state machine left Workspot: the second copy must not land on a V
    -- who already stands.
    function self.left()
        local id = self.pending
        self.pending = nil
        if id ~= nil then pcall(native.cancel, id) end
    end

    return self
end

-- Game wiring: one Observe pair on the player's Workspot state. Returns the
-- controller, or nil and a reason (the class or hook missing in this build).
function M.install(options)
    options = options or {}
    local classify = options.classify
    local native = {classify = classify, log = options.log}
    function native.seat()
        local player = Game.GetPlayer()
        local instance = Game.GetWorkspotSystem():GetWorkspotInstance(player:GetEntityID())
        if not instance then return nil, nil end
        local path, anim
        pcall(function() anim = NameToString(instance.idleAnim) .. ' ' .. NameToString(instance.animName) end)
        pcall(function() path = ResRef.ToString(instance.resource.path) end)
        if not path or path == '' then pcall(function() path = tostring(instance.resource.path) end) end
        return path, anim
    end
    local function event(limits)
        local ev = SetCameraParamsWithOverridesEvent.new()
        ev.paramsName = CName.new(M.baseSet)
        for key, value in pairs(limits) do ev[key] = value end
        return ev
    end
    function native.queue(limits) Game.GetPlayer():QueueEvent(event(limits)) end
    function native.delay(limits, seconds)
        return Game.GetDelaySystem():DelayEvent(Game.GetPlayer(), event(limits), seconds, false)
    end
    function native.cancel(id) Game.GetDelaySystem():CancelDelay(id) end
    local controller = M.new(native)
    local hooked, reason = pcall(function()
        ObserveAfter('WorkspotEvents', 'OnEnter', function() controller.entered() end)
        ObserveAfter('WorkspotEvents', 'OnExit', function() controller.left() end)
        ObserveAfter('WorkspotEvents', 'OnForcedExit', function() controller.left() end)
    end)
    if not hooked then return nil, tostring(reason) end
    return controller
end

return M
