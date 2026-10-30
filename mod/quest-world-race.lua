-- The game side of the RACE group of bond quest primitives (mod/quest-prims-race.lua: race and convoy). It adds the few native calls those two ask for through
-- env.world. Everything else they need is already in mod/quest-world-drive.lua and is used from there: driveSpawn, driveLookup, driveMountDriver, driveTo,
-- driveBrake, driveDelete, readHeat, the visitor seat calls postCarMount and postCarMounted. Each function here is guarded by its caller (a raised error is an
-- unanswered question), none of them runs per frame, and none of them touches a character or a car the game placed.
--
-- Entity handles are never kept. A function hands back plain data or takes the opaque handle of driveSpawn (entity IDs only), and an entity is looked up from its
-- ID again at each use and counted only once the game has attached it.
--
-- UNVERIFIED in the game (offline-tested on a fake game only, the first live run must look at each):
--   raceRead         V's mounted vehicle and where it is, from the mounting facility. The driver seat is seat_front_left, a bike's seat name is a guess (Jackie's bike).
--   driveFollowCar   AIVehicleFollowCommand with a car as its target (the party car follow command aims at V, here the target is the car ahead in the column).
--   the neutral chase car that driveSpawn uses when a request asks for one is in mod/quest-tweak.lua, with its own list of what is unverified.
local M = {SEAT_DRIVER = {seat_front_left = true, seat_front = true}}

local function nullHash(id) return not id or tostring(id.hash):match('^0+[uUlL]*$') ~= nil end

local function nameText(value)
    if value == nil then return nil end
    if type(value) == 'string' then return value end
    local ok, text = pcall(function() return NameToString(value) end)
    if ok and type(text) == 'string' and text ~= '' and text ~= 'None' then return text end
    ok, text = pcall(tostring, value)
    if ok and type(text) == 'string' then return text:match('%-%-%[%[%s*(.-)%s*%-%-%]%]') or text end
    return nil
end

local function find(id)
    if nullHash(id) then return nil end
    local entity = Game.FindEntityByID(id)
    if entity and entity:IsAttached() then return entity end
    return nil
end

function M.new(deps)
    deps = deps or {}
    local W = {}

    -- {mounted, driving, at = {x, y, z}}: V's seat in a vehicle and where the vehicle is (V's own position when V is on foot or the car is not found).
    -- One facility read and one position read, no scan of the party. Never the quick-slot vehicle read.
    function W.raceRead()
        local player = Game.GetPlayer()
        if not player then return nil end
        local info = Game.GetMountingFacility():GetMountingInfoSingleWithObjects(player)
        local parent = info and info.parentId
        local mounted = not nullHash(parent)
        local seat = mounted and nameText(info.slotId.id) or nil
        local vehicle = mounted and find(parent) or nil
        local at = (vehicle or player):GetWorldPosition()
        return {mounted = mounted, driving = mounted and M.SEAT_DRIVER[seat] == true, at = {x = at.x, y = at.y, z = at.z}}
    end

    -- The follow command aimed at the car `ahead`: the car keeps behind it at between gap and gap + 12 metres, with its own driver. Both are handles of driveSpawn.
    function W.driveFollowCar(handle, ahead, gap)
        local car = handle and handle.entityID and find(handle.entityID)
        local target = ahead and ahead.entityID and find(ahead.entityID)
        local ai = car and car:GetAIComponent()
        if not ai or not target then return false end
        local command = NewObject('AIVehicleFollowCommand')
        if not command then return false end
        command.target = target
        command.distanceMin = tonumber(gap) or 12
        command.distanceMax = command.distanceMin + 12
        command.stopWhenTargetReached = false
        command.needDriver = true
        command.useTraffic = true
        command.trafficTryNeighborsForStart, command.trafficTryNeighborsForEnd = true, true
        command.useKinematic = false
        return ai:SendCommand(command:Copy()) ~= false
    end

    return W
end

return M
