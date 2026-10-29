-- The game side of the DRIVE group of bond quest primitives (mod/quest-prims-drive.lua: ride, post, remote, runner, tail, check). It adds native reads and
-- commands that the pure primitives ask for through env.world. Each function is guarded by its caller (a raised error is an unanswered question), none of them
-- runs per frame, and none of them touches a character the game placed: they read V, the mod's own copies, and spawn or command only tagged characters and
-- cars of the quest.
--
-- Entity handles are never kept. A function hands back plain data (numbers, flags, text) or an opaque handle that holds entity IDs only, and an entity is
-- looked up from its ID again at each use and counted only once the game has attached it.
--
-- UNVERIFIED in the game (offline-tested on a fake game only, the first live run must look at each):
--   rideRead      V's mounted vehicle from the mounting facility (the driver seat is seat_front_left, a bike's seat name is a guess), the party copy's mount.
--   readHeat, readWeather, readHour, readItem   the same reads the turn context makes, here asked on their own so a Dynamic info switch does not hide them.
--   readSong      the radio station and the cached song event. readGear: the gear snapshot read.
--   driveSpawn, driveMountDriver, driveTo, driveFollow, driveBrake, driveDelete   a tagged car with a nameless driver, the drive-to-point and follow commands,
--                 and a pedestrian walking a route with the move command.
--   postWalk, postHold, postStance, postCar*   the visitor calls of mod/companions.lua for a copy placed through a cast, and a stationary tagged car for a post.
--   remoteHold    needs the hook holdWhile(channel, fn) on mod/quest-lines.lua, absent today: it answers nil and the dead zone only reports its events.
local M = {TAG = 'CyberpunkConvaiQuest', SEAT = 'seat_front_left', DRIVER_SEATS = {seat_front_left = true, seat_front = true},
    FALLBACK_CAR = 'Vehicle.v_standard2_archer_hella_player'}

local atan2 = math.atan2 or function(y, x) return math.atan(y, x) end

local function finite(value) return type(value) == 'number' and value == value and math.abs(value) < 1e7 end
local function plain(p) return {x = p.x, y = p.y, z = p.z} end
local function nullHash(id) return not id or tostring(id.hash):match('^0+[uUlL]*$') ~= nil end
local function idText(id) if nullHash(id) then return nil end return tostring(id.hash) end

-- A global of the mod's environment (init.lua sets them), read guarded.
local function global(key)
    local ok, value = pcall(function() return _G[key] end)
    if ok and value ~= nil then return value end
    ok, value = pcall(rawget, _G, key)
    return ok and value or nil
end

-- A CName or enum as plain text, nil when unreadable.
local function nameText(value)
    if value == nil then return nil end
    if type(value) == 'string' then return value end
    local ok, text = pcall(function() return NameToString(value) end)
    if ok and type(text) == 'string' and text ~= '' and text ~= 'None' then return text end
    ok, text = pcall(function() return Game.NameToString(value) end)
    if ok and type(text) == 'string' and text ~= '' and text ~= 'None' then return text end
    ok, text = pcall(tostring, value)
    if ok and type(text) == 'string' then return text:match('%-%-%[%[%s*(.-)%s*%-%-%]%]') or text end
    return nil
end

local function vector(x, y, z) return Vector4.new(x, y, z, 1) end

-- Who a puppet or vehicle is mounted in: {parent = the vehicle's EntityID, id = its hash as text, seat = the slot name}, or nil when it is mounted nowhere.
local function mountOf(entity)
    local info = Game.GetMountingFacility():GetMountingInfoSingleWithObjects(entity)
    local parent = info and info.parentId
    if nullHash(parent) then return nil end
    return {parent = parent, id = tostring(parent.hash), seat = nameText(info.slotId.id)}
end

local function find(id)
    if nullHash(id) then return nil end
    local entity = Game.FindEntityByID(id)
    if entity and entity:IsAttached() then return entity end
    return nil
end

-- deps: companions (the companions module, else the global convaiCompanions), log(line).
function M.new(deps)
    deps = deps or {}
    local W = {}
    local heatMethod, weatherMethod, rainTypeMethod, rainMethod
    local turnContext

    local function log(line) if type(deps.log) == 'function' then pcall(deps.log, 'Quest drive: ' .. line) end end
    local function companions() return deps.companions or global('convaiCompanions') end
    -- The pure classifiers of the turn context (weatherKind, heatStage), loaded once when a check asks.
    local function classifiers()
        if turnContext == nil then
            local ok, module = pcall(dofile, 'turn-context.lua')
            turnContext = ok and type(module) == 'table' and module or false
        end
        return turnContext or nil
    end
    local function firstMethod(memo, object, names)
        if memo[1] then return object[memo[1]](object), memo[1] end
        local lastError
        for _, method in ipairs(names) do
            local ok, value = pcall(function() return object[method](object) end)
            if ok and value ~= nil then memo[1] = method; return value, method end
            if not ok then lastError = value end
        end
        error(lastError or 'no candidate answered', 0)
    end

    -- ---- ride ---------------------------------------------------------------------------------------------------------------------------
    -- {mounted, driving, vehicleId, at = {x, y, z}, copy = 'aboard' | 'outside' | 'gone'} from the mounting reads (never the quick-slot vehicle read).
    -- `at` is the vehicle's position while V is mounted, else V's. The copy is the party copy that speaks as the profile.
    function W.rideRead(profileKey)
        local player = Game.GetPlayer()
        if not player then return nil end
        local mine = mountOf(player)
        local out = {mounted = mine ~= nil, driving = mine ~= nil and M.DRIVER_SEATS[mine.seat] == true, vehicleId = mine and mine.id, copy = 'gone'}
        local vehicle = mine and find(mine.parent)
        out.at = plain((vehicle or player):GetWorldPosition())
        local c = companions()
        if c and type(c.conversationCandidates) == 'function' then
            for _, row in ipairs(c.conversationCandidates(player, 100000)) do
                if row.profileKey == profileKey and row.party then
                    local theirs = mine and mountOf(row.npc)
                    out.copy = (theirs and theirs.id == mine.id) and 'aboard' or 'outside'
                    break
                end
            end
        end
        return out
    end

    -- ---- reads for check, heat and the song ------------------------------------------------------------------------------------------------
    function W.readHeat()
        local system = Game.GetScriptableSystemsContainer():Get('PreventionSystem')
        if system == nil then return nil end
        local memo = {heatMethod}
        local value = firstMethod(memo, system, {'GetHeatStageAsInt', 'GetHeatStage'})
        heatMethod = memo[1]
        local tc = classifiers()
        if tc then return tc.heatStage(value) end
        value = tonumber(value)
        return value and value >= 0 and value <= 5 and value == math.floor(value) and value or nil
    end

    function W.readHour()
        local system = Game.GetTimeSystem()
        local stamp = system and system:GetGameTime()
        if stamp == nil then return nil end
        local okHour, hour = pcall(function() return GameTime.Hours(stamp) end)
        local okMinute, minute = pcall(function() return GameTime.Minutes(stamp) end)
        if okHour and okMinute and tonumber(hour) and tonumber(minute) then return tonumber(hour), tonumber(minute) end
        local seconds = tonumber(stamp.seconds)
        if not seconds or seconds < 0 then return nil end
        seconds = math.floor(seconds) % 86400
        return math.floor(seconds / 3600), math.floor(seconds % 3600 / 60)
    end

    -- The weather kind the turn context knows (clear, cloudy, rain, heavy-rain, toxic-rain, fog, smog, sandstorm), or nil.
    function W.readWeather()
        local system = Game.GetWeatherSystem()
        if system == nil then return nil end
        local stateText, rainValue
        local stateMemo = {weatherMethod}
        local okState, state = pcall(firstMethod, stateMemo, system, {'GetWeatherState', 'GetActiveWeatherState', 'GetWeatherStateName', 'GetCurrentWeatherState'})
        weatherMethod = stateMemo[1]
        if okState and state ~= nil then
            stateText = nameText(state)
            if stateText == nil or stateText:find('^userdata') or stateText:find('^table') then
                local okField, field = pcall(function() return state.name end)
                stateText = okField and nameText(field) or stateText
            end
        end
        local typeMemo = {rainTypeMethod}
        local okType, rainType = pcall(firstMethod, typeMemo, system, {'GetRainIntensityType'})
        rainTypeMethod = typeMemo[1]
        if okType and rainType ~= nil then rainValue = nameText(rainType) end
        if rainValue == nil then
            local rainMemo = {rainMethod}
            local okRain, rain = pcall(firstMethod, rainMemo, system, {'GetRainIntensity'})
            rainMethod = rainMemo[1]
            if okRain and rain ~= nil then rainValue = tonumber(rain) or nameText(rain) end
        end
        if stateText == nil and rainValue == nil then return nil end
        local tc = classifiers()
        return tc and tc.weatherKind(stateText, rainValue) or nil
    end

    -- {playing = false} with the radio off, else {playing = true, station = text, song = text | nil}.
    function W.readSong()
        local player = Game.GetPlayer()
        if not player then return nil end
        local station
        local vehicle = player:GetMountedVehicle()
        if vehicle ~= nil then
            if vehicle:IsRadioReceiverActive() == true then station = vehicle:GetRadioReceiverStationName() end
        else
            local radio = player:GetPocketRadio()
            if radio ~= nil and radio:IsActive() == true then station = radio:GetStationName() end
        end
        if station == nil then return {playing = false} end
        local stationText = nameText(station)
        local song
        local media = global('convaiMediaSong')
        if type(media) == 'table' and type(media.song) == 'function' then
            local ok, found = pcall(media.song, media, stationText)
            if ok and found ~= nil then song = nameText(found) end
        end
        return {playing = true, station = stationText, song = song}
    end

    -- {worn = {slot = name}, hand = name | nil} from the gear snapshot (the cached one, else one read).
    function W.readGear()
        local gear = global('convaiPlayerGear')
        if type(gear) ~= 'table' then return nil end
        local snapshot = gear:capture()
        if snapshot == nil and type(gear.read) == 'function' then
            local ok, read = pcall(gear.read, gear)
            snapshot = ok and read or nil
        end
        if type(snapshot) ~= 'table' then return nil end
        local worn, hand = {}, nil
        for _, row in ipairs(snapshot.clothing or {}) do worn[row.slot] = row.name end
        for _, row in ipairs(snapshot.weapons or {}) do if row.slot == 'hand' then hand = row.name end end
        return {worn = worn, hand = hand}
    end

    function W.readItem(id)
        local player = Game.GetPlayer()
        if not player or type(id) ~= 'string' then return nil end
        local count = Game.GetTransactionSystem():GetItemQuantity(player, ItemID.FromTDBID(TweakDBID.new(id)))
        return tonumber(count)
    end

    -- ---- remote -------------------------------------------------------------------------------------------------------------------------
    -- A hold on the lines of one channel while fn() answers true, through the hook holdWhile(channel, fn) -> release of mod/quest-lines.lua. Nil when the
    -- hook does not exist (the dead zone then reports its events but holds nothing).
    function W.remoteHold(fn)
        local lines = global('convaiQuestLines')
        if type(lines) ~= 'table' or type(lines.holdWhile) ~= 'function' then return nil end
        local ok, release = pcall(lines.holdWhile, 'remote', fn)
        if ok and type(release) == 'function' then return release end
        return nil
    end

    -- ---- post: a copy placed through a cast, moved by the visitor calls of mod/companions.lua -------------------------------------------------------
    function W.postWalk(serial, target, gait)
        local c = companions()
        return c ~= nil and c.visitorWalk(serial, target, gait or 'Walk') == true
    end

    function W.postHold(serial)
        local c = companions()
        return c ~= nil and c.visitorHold(serial) == true
    end

    -- 'prone' has no NPC stance in the game: the lowest one it has (Crouch) is asked for. 'stand' changes nothing.
    function W.postStance(serial, stance)
        if stance ~= 'prone' then return true end
        local c = companions()
        local npc = c and type(c.residentNpc) == 'function' and c.residentNpc(serial)
        if not npc then return false end
        NPCPuppet.ChangeStanceState(npc, Enum.new('gamedataNPCStanceState', 'Crouch'))
        return true
    end

    -- A fight from the post goes through companion tactics once they have a hold-position flag (they have none yet): true only when that hook exists.
    function W.postFight(serial, on)
        local c = companions()
        local tactics = c and c.tactics
        if type(tactics) == 'table' and type(tactics.fightFrom) == 'function' then return tactics.fightFrom(serial, on == true) == true end
        return false
    end

    -- The copy sits in a stationary car at the post (the handle of driveSpawn with no driver). mount and unmount are the animated ones of the invitation car.
    function W.postCarMount(serial, handle, unmount)
        local c = companions()
        return c ~= nil and c.visitorMount(serial, handle, M.SEAT, unmount == true, false) == true
    end

    function W.postCarMounted(serial, handle)
        local c = companions()
        return c ~= nil and c.visitorMounted(serial, handle) == true
    end

    -- ---- runner and tail: a tagged car with a nameless driver, or a tagged pedestrian --------------------------------------------------------------
    local function create(system, record, appearance, x, y, z, yaw, tags)
        local found = TweakDB:GetRecord(TweakDBID.new(record))
        if not found then return nil, 'unknown record ' .. tostring(record) end
        local spec = NewObject('DynamicEntitySpec')
        spec.recordID = TweakDBID.new(record)
        if type(appearance) == 'string' then spec.appearanceName = CName.new(appearance) end
        spec.position = vector(x, y, z)
        if finite(yaw) then spec.orientation = EulerAngles.ToQuat(EulerAngles.new(0, 0, yaw)) end
        spec.active, spec.alwaysSpawned, spec.spawnInView = true, true, true
        spec.persistSpawn, spec.persistState = false, false
        local names = {}
        for index, tag in ipairs(tags) do names[index] = CName.new(tag) end
        spec.tags = names
        local id = system:CreateEntity(spec)
        if nullHash(id) then return nil, 'The game could not create ' .. tostring(record) end
        return id
    end

    -- request: {kind = 'car' | 'foot', vehicle = record, appearance, driver = record (a car with no driver: nil), x, y, z, yaw, tag}.
    -- The handle holds IDs only: {kind, system, entityID, id (the car's), driverID}. A car with the same fields is what the visitor mount calls take.
    function W.driveSpawn(request)
        if type(request) ~= 'table' or not finite(request.x) or not finite(request.y) or not finite(request.z) then return nil, 'bad place' end
        local system = Game.GetDynamicEntitySystem()
        if not system or not system:IsReady() then return nil, 'World is not ready' end
        local tags = {M.TAG}
        if type(request.tag) == 'string' and request.tag ~= '' then tags[2] = request.tag end
        local handle = {kind = request.kind == 'foot' and 'foot' or 'car', system = system}
        if handle.kind == 'car' then
            local carId, why = create(system, request.vehicle or M.FALLBACK_CAR, request.appearance, request.x, request.y, request.z, request.yaw, tags)
            if not carId then return nil, why end
            handle.entityID, handle.id = carId, idText(carId)
        end
        if type(request.driver) == 'string' then
            local offset = handle.kind == 'car' and 3 or 0
            local driverId, why = create(system, request.driver, nil, request.x + offset, request.y, request.z, request.yaw, tags)
            if not driverId then
                if handle.entityID then pcall(function() system:DeleteEntity(handle.entityID) end) end
                return nil, why
            end
            handle.driverID = driverId
        end
        return handle
    end

    -- {attached, position, driverIn, alive}: the car (or the pedestrian) once the game has attached everything it needs.
    function W.driveLookup(handle)
        if type(handle) ~= 'table' then return nil end
        local out = {attached = false, driverIn = false, alive = true}
        local car = handle.entityID and find(handle.entityID)
        local driver = handle.driverID and find(handle.driverID)
        if handle.kind == 'car' then
            if not car or car:IsDestroyed() then return out end
            out.position = plain(car:GetWorldPosition())
            if handle.driverID then
                if not driver then return out end
                local mount = mountOf(driver)
                out.driverIn = mount ~= nil and mount.id == handle.id
                out.alive = not driver:IsDeadNoStatPool()
            end
            out.attached = true
        else
            if not driver then return out end
            out.position = plain(driver:GetWorldPosition())
            out.alive = not driver:IsDeadNoStatPool()
            out.attached = true
        end
        return out
    end

    -- The driver is told to get into the driver seat (the animated mount of the party cars). The caller verifies with driveLookup.driverIn.
    function W.driveMountDriver(handle)
        local driver = handle and handle.driverID and find(handle.driverID)
        if not driver or not handle.entityID then return false end
        local command = NewObject('AIMountCommand')
        local data = NewObject('gameMountEventData')
        data.mountParentEntityId = handle.entityID
        data.slotName = CName.new(M.SEAT)
        data.isInstant = false
        data.setEntityVisibleWhenMountFinish = true
        data.removePitchRollRotationOnDismount = false
        data.ignoreHLS = false
        data.allowFailsafeTeleport = false
        data.mountEventOptions = NewObject('gameMountEventOptions')
        data.mountEventOptions.silentUnmount = false
        data.mountEventOptions.entityID = EntityID.new()
        data.mountEventOptions.alive = false
        data.mountEventOptions.occupiedByNonFriendly = false
        command.mountData = data
        return driver:GetAIControllerComponent():SendCommand(command:Copy()) ~= false
    end

    local function gaitFor(speed)
        if speed >= 5.5 then return 'Sprint' end
        if speed >= 2.5 then return 'Run' end
        return 'Walk'
    end

    -- One leg: the car by the drive-to-point command with traffic cleared on the path (the invitation car's command), the pedestrian by the move command.
    function W.driveTo(handle, target, speed)
        if type(handle) ~= 'table' or type(target) ~= 'table' then return false end
        speed = tonumber(speed) or 12
        if handle.kind == 'car' then
            local car = find(handle.entityID)
            local ai = car and car:GetAIComponent()
            if not ai then return false end
            local command = NewObject('AIVehicleDriveToPointAutonomousCommand')
            if not command then return false end
            command.targetPosition = Vector3.new(target.x, target.y, target.z or 0)
            command.maxSpeed, command.minSpeed = speed, -1.0
            command.minimumDistanceToTarget, command.forcedStartSpeed = 3.0, -1.0
            command.needDriver, command.useKinematic = true, false
            command.clearTrafficOnPath, command.driveDownTheRoadIndefinitely = true, false
            return ai:SendCommand(command:Copy()) ~= false
        end
        local driver = find(handle.driverID)
        if not driver then return false end
        local world = WorldPosition.new()
        world:SetVector4(vector(target.x, target.y, target.z or 0))
        local spec = AIPositionSpec.new()
        spec:SetWorldPosition(world)
        local command = NewObject('AIMoveToCommand')
        command.movementTarget = spec
        command.rotateEntityTowardsFacingTarget = false
        command.movementType = Enum.new('moveMovementType', gaitFor(speed))
        command.desiredDistanceFromTarget = 1.5
        command.finishWhenDestinationReached = true
        command.ignoreNavigation = false
        command.useStart, command.useStop = true, true
        return driver:GetAIControllerComponent():SendCommand(command:Copy()) ~= false
    end

    -- The follow command of the party cars, at a gap: the car keeps behind V at between gap and gap + 12 metres.
    function W.driveFollow(handle, gap)
        local car = handle and handle.entityID and find(handle.entityID)
        local ai = car and car:GetAIComponent()
        local player = Game.GetPlayer()
        if not ai or not player then return false end
        local command = NewObject('AIVehicleFollowCommand')
        command.target = player
        command.distanceMin = tonumber(gap) or 25
        command.distanceMax = command.distanceMin + 12
        command.stopWhenTargetReached = false
        command.needDriver = true
        command.useTraffic = true
        command.trafficTryNeighborsForStart, command.trafficTryNeighborsForEnd = true, true
        command.useKinematic = false
        return ai:SendCommand(command:Copy()) ~= false
    end

    function W.driveBrake(handle)
        if type(handle) ~= 'table' then return false end
        if handle.kind == 'car' then
            local car = find(handle.entityID)
            if car and not car:IsPlayerMounted() then car:ForceBrakesUntilStoppedOrFor(5.0); return true end
            return false
        end
        local driver = find(handle.driverID)
        if not driver then return false end
        local command = NewObject('AIHoldPositionCommand')
        command.duration = 30
        return driver:GetAIControllerComponent():SendCommand(command:Copy()) ~= false
    end

    -- Deletes the driver and the car, only entities that carry the quest tag. A car V is sitting in is left (a vehicle goes only while V is on foot): the
    -- session start sweep takes it later. Returns true when everything is gone.
    function W.driveDelete(handle)
        if type(handle) ~= 'table' then return true end
        local system = Game.GetDynamicEntitySystem()
        if not system or not system:IsReady() then return false end
        local done = true
        local tag = CName.new(M.TAG)
        if handle.entityID and system:IsManaged(handle.entityID) then
            local car = Game.FindEntityByID(handle.entityID)
            local held = car and car:IsPlayerMounted() == true
            if held then
                log('a quest car is left in place: V sits in it')
                done = false
            elseif system:IsTagged(handle.entityID, tag) then
                system:DeleteEntity(handle.entityID)
            end
        end
        if handle.driverID and system:IsManaged(handle.driverID) and system:IsTagged(handle.driverID, tag) then
            system:DeleteEntity(handle.driverID)
        end
        return done
    end

    -- A spot behind V along the way V faces, `metres` back: {x, y, z, yaw}. For a tail car that has no place of its own.
    function W.behindPlayer(metres)
        local player = Game.GetPlayer()
        if not player then return nil end
        local at, forward = player:GetWorldPosition(), player:GetWorldForward()
        metres = tonumber(metres) or 60
        return {x = at.x - forward.x * metres, y = at.y - forward.y * metres, z = at.z, yaw = math.deg(atan2(-forward.x, forward.y))}
    end

    return W
end

return M
