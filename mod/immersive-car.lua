-- Her car (docs/IMMERSIVE_INVITATIONS.md, "Car arrival"): the sequence a visitor who comes by car goes through, and the game calls under it.
--
-- M.sequencer(api) is the pure part: create the car, wait until it stands on a road, let her board, drive to the road end point, brake, let her
-- out. It knows nothing of the engine: every game call goes through `api`, so the whole sequence runs in the tests with a fake. M.nativeApi(deps) is
-- the game-bound part: the party-car adapter (mod/companion-vehicle-native.lua) for the entity, and the same native driving command the
-- chauffeur uses (AIVehicleDriveToPointAutonomousCommand, mod/companion-chauffeur-native.lua) with the car's own AI component.
--
-- Nothing here runs per frame: the controller steps it every half second while a car arrival is under way.
local M = {}

M.CREATE_TIMEOUT = 12     -- seconds for the new car to attach
M.LANE_PATIENCE = 2       -- seconds a new car may take to report that it stands on a traffic lane
M.BOARD_TIMEOUT = 20
M.DRIVE_CAP = 240
M.STALL_WINDOW = 25       -- seconds without 2 m of progress on the road
M.STOP_DISTANCE = 14      -- she has arrived when the car is this close to the road end point and slower than STOP_SPEED
M.STOP_SPEED = 0.8
M.BRAKE_TIMEOUT = 8
M.EXIT_TIMEOUT = 16
M.FAILSAFE_AFTER = 8      -- the instant exit with its failsafe, after this long

local function ground(a, b) return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2) end

-- api: create(spec) -> handle | nil, why      spec = {position, yaw, choice}
--      status(handle) -> {attached, lane, speed, position} | nil
--      mount(serial, handle) -> true | false       (the animated boarding of the driver seat)
--      mounted(serial, handle) -> true | false     (she sits in the driver seat of this car)
--      unmount(serial, handle, instant) -> true | false
--      drive(handle, target) -> operation | nil, why
--      driveState(operation) -> 'running' | 'success' | 'failed'
--      brake(handle)
function M.sequencer(api)
    local S = {}

    -- A new car for this appointment: {handle, stage = 'created'}, or nil + why.
    function S.create(spot, choice)
        local handle, why = api.create({position = spot.car.position, yaw = spot.car.yaw, choice = choice})
        if not handle then return nil, why end
        return {handle = handle, stage = 'created', age = 0, laneAge = 0}
    end

    -- 'ready' once the car is attached on a traffic lane, 'wait', or 'bad' + why (it did not attach, or it does not stand on a road).
    function S.ready(car, dt)
        car.age = car.age + dt
        local status = api.status(car.handle)
        if not status then return 'bad', 'The car is gone.' end
        if not status.attached then
            if car.age > M.CREATE_TIMEOUT then return 'bad', 'The car did not attach.' end
            return 'wait'
        end
        if status.lane == true then return 'ready' end
        car.laneAge = car.laneAge + dt
        if status.lane == nil and car.laneAge >= M.LANE_PATIENCE then return 'ready' end
        if car.laneAge >= M.LANE_PATIENCE then return 'bad', 'The car does not stand on a road.' end
        return 'wait'
    end

    local function enter(car, stage, now)
        car.stage, car.stageAt, car.sent, car.attempts = stage, now, false, 0
    end

    -- One step of her trip. Returns true (going on), 'arrived' (she stands outside the car near the destination) or 'failed', why.
    function S.step(a, dt)
        local car = a.car
        car.clock = (car.clock or 0) + dt
        local now = car.clock
        if car.stage == 'created' then enter(car, 'boarding', now) end
        local status = api.status(car.handle)
        if not status or not status.attached then return 'failed', 'The car is gone.' end
        local elapsed = now - car.stageAt
        if car.stage == 'boarding' then
            if api.mounted(a.serial, car.handle) then
                enter(car, 'driving', now)
                car.driveStart, car.bestGap, car.bestAt = now, nil, now
                return true
            end
            if not car.sent then car.sent = api.mount(a.serial, car.handle) == true
            elseif elapsed > M.BOARD_TIMEOUT / 2 and car.attempts == 0 then car.attempts, car.sent = 1, false end
            if elapsed > M.BOARD_TIMEOUT then return 'failed', 'She could not get into the car.' end
            return true
        elseif car.stage == 'driving' then
            if not car.operation then
                local operation, why = api.drive(car.handle, a.road)
                if not operation then return 'failed', why or 'The car cannot drive.' end
                car.operation = operation
                return true
            end
            local state = api.driveState(car.operation)
            local gap = status.position and ground(status.position, a.road) or math.huge
            if state == 'success' or (gap <= M.STOP_DISTANCE and (status.speed or 0) <= M.STOP_SPEED) then
                enter(car, 'braking', now)
                return true
            end
            if state == 'failed' then return 'failed', 'The car could not drive there.' end
            if not car.bestGap or gap < car.bestGap - 2 then car.bestGap, car.bestAt = gap, now end
            if now - car.bestAt > M.STALL_WINDOW or now - car.driveStart > M.DRIVE_CAP then
                return 'failed', 'The car is stuck on the way.'
            end
            return true
        elseif car.stage == 'braking' then
            api.brake(car.handle)
            if (status.speed or 0) < 0.5 or elapsed > M.BRAKE_TIMEOUT then enter(car, 'exiting', now) end
            return true
        elseif car.stage == 'exiting' then
            if not api.mounted(a.serial, car.handle) then
                car.stage = 'parked'
                return 'arrived'
            end
            if not car.sent then car.sent = api.unmount(a.serial, car.handle, false) == true
            elseif elapsed >= M.FAILSAFE_AFTER and not car.failsafe then
                car.failsafe = true
                api.unmount(a.serial, car.handle, true)
            end
            if elapsed > M.EXIT_TIMEOUT then return 'failed', 'She could not get out of the car.' end
            return true
        end
        return 'arrived'
    end

    return S
end

-- ---- the game side --------------------------------------------------------------------------------------------------------------
-- deps: companions (visitorMount, visitorMounted), vehicle (mod/companion-vehicle-native.lua instance with its query budget set),
--       catalog (mod/companion-vehicle-catalog.lua), tag
local DRIVE_CLASS = 'AIVehicleDriveToPointAutonomousCommand'
local DRIVE_SPEED, DRIVE_STOP = 12.0, 6.0

function M.nativeApi(deps)
    local api = {}
    local vehicle, companions = deps.vehicle, deps.companions

    function api.create(spec)
        local ok, car, why = pcall(vehicle.spawnAt, spec.choice, spec.position, spec.yaw, deps.tag)
        if not ok then return nil, tostring(car) end
        return car, why
    end

    function api.status(handle)
        local ok, status = pcall(function()
            local entity = Game.FindEntityByID(handle.entityID)
            if not entity or not entity:IsAttached() or entity:IsDestroyed() then return nil end
            local position = entity:GetWorldPosition()
            local lane
            local asked, value = pcall(function() return entity:IsInTrafficLane() end)
            if asked and type(value) == 'boolean' then lane = value end
            local speed = 0
            local measured, current = pcall(function() return entity:GetCurrentSpeed() end)
            if measured and type(current) == 'number' then speed = math.abs(current) end
            handle.entity = entity
            return {attached = true, lane = lane, speed = speed, position = {x = position.x, y = position.y, z = position.z}}
        end)
        if not ok then return nil end
        if status == nil then
            -- Not attached yet is not gone: a car created this very step has no entity to find.
            local managed = false
            pcall(function() managed = handle.system:IsManaged(handle.entityID) == true end)
            return managed and {attached = false} or nil
        end
        return status
    end

    function api.mount(serial, handle) return companions.visitorMount(serial, handle, 'seat_front_left', false) == true end
    function api.mounted(serial, handle) return companions.visitorMounted(serial, handle) == true end
    function api.unmount(serial, handle, instant) return companions.visitorMount(serial, handle, 'seat_front_left', true, instant) == true end

    function api.drive(handle, target)
        local ok, operation, why = pcall(function()
            local entity = handle.entity or Game.FindEntityByID(handle.entityID)
            local ai = entity and entity:GetAIComponent()
            if not ai then return nil, 'This car has no driving AI.' end
            local command = NewObject(DRIVE_CLASS)
            if not command then return nil, 'Native NPC driving is unavailable.' end
            command.targetPosition = Vector3.new(target.x, target.y, target.z or 0)
            command.maxSpeed, command.minSpeed = DRIVE_SPEED, -1.0
            command.minimumDistanceToTarget, command.forcedStartSpeed = DRIVE_STOP, -1.0
            command.needDriver, command.useKinematic = true, false
            command.clearTrafficOnPath, command.driveDownTheRoadIndefinitely = false, false
            local handleCopy = command:Copy()
            local sent = ai:SendCommand(handleCopy)
            if sent == false then return nil, 'The driving command was refused.' end
            return {ai = ai, handle = handleCopy}
        end)
        if not ok then return nil, tostring(operation) end
        return operation, why
    end

    function api.driveState(operation)
        local ok, label = pcall(function() return tostring(operation.ai:GetCommandState(operation.handle)) end)
        if not ok then return 'failed' end
        local name = label:match('^AICommandState%s*:%s*(%w+)%s*%(%d+%)$') or label
        if name == 'Success' then return 'success' end
        if name == 'Failure' or name == 'Cancelled' or name == 'Interrupted' then return 'failed' end
        return 'running'
    end

    function api.brake(handle)
        pcall(function()
            local entity = handle.entity or Game.FindEntityByID(handle.entityID)
            if entity and entity:IsAttached() and not entity:IsPlayerMounted() then entity:ForceBrakesUntilStoppedOrFor(3.0) end
        end)
    end

    function api.position(handle)
        local ok, position = pcall(function()
            local entity = Game.FindEntityByID(handle.entityID)
            if not entity or not entity:IsAttached() then return nil end
            local at = entity:GetWorldPosition()
            return {x = at.x, y = at.y, z = at.z}
        end)
        return ok and position or nil
    end

    -- true once the car is gone; false and a reason while something still holds it (V sits in it, a passenger, a despawn in progress).
    function api.delete(handle)
        local ok, done, why = pcall(vehicle.destroy, handle)
        if not ok then return false, tostring(done) end
        return done == true, why
    end

    return api
end

return M
