-- The game side of immersive invitations (docs/IMMERSIVE_INVITATIONS.md): V's position and what holds V, the meeting place and the
-- words for it, the map waypoint, and the hidden spot a visitor appears at. Everything here is read when an appointment asks (an
-- offer, a spot search, a step of a visitor), never per frame, and every game call is guarded: a failed read is "unknown", never an error
-- in the caller. mod/immersive-invitations.lua is the state machine that uses it.
local words = dofile('place-words.lua')
local M = {}

local HER_CAR_TAG = 'CyberpunkConvaiHerVehicle'
local ROAD_MAX_WALK = 60          -- a road end point this far on foot from V is still "a road nearby"
local TRAIL_LIMIT, TRAIL_STEP, TRAIL_SPEED = 40, 30, 6
local TRAIL_NEAR = 150            -- a road V drove along this close to V is a road nearby

local WAYPOINT_LANDMARK_RADIUS = 250   -- the nearest fast travel point within this far names the place
local WAYPOINT_NEAR_V = 150            -- a waypoint this close to V is worded with V's own district

local function point(p)
    if p == nil then return nil end
    local ok, value = pcall(function() return {x = p.x, y = p.y, z = p.z} end)
    if not ok or type(value.x) ~= 'number' or type(value.y) ~= 'number' or value.x ~= value.x or value.y ~= value.y
        or math.abs(value.x) > 1e7 or math.abs(value.y) > 1e7 then return nil end
    value.z = type(value.z) == 'number' and value.z == value.z and value.z or 0
    return value
end

local function localized(text)
    if type(text) ~= 'string' or text == '' then return nil end
    if text:match('^LocKey') then
        local ok, value = pcall(function() return GetLocalizedText(text) end)
        if not ok or type(value) ~= 'string' or value == '' or value:match('^LocKey') then return nil end
        return value
    end
    return text
end

-- deps: companions (mod/companions.lua), held() -> 'combat' | 'scene' | 'call' | nil, districtOf() -> {district, area} | nil (mod/init.lua)
function M.new(deps)
    local W = {}
    local trail = {}
    local carModule, sequencer, carApi

    -- Cars made for a companion by an earlier load of this mod (a CET reload) are removed once, now; nothing is known yet.
    pcall(function()
        local system = Game.GetDynamicEntitySystem()
        if not system or not system:IsReady() then return end
        local ids = system:GetTaggedIDs(CName.new(HER_CAR_TAG))
        if type(ids) ~= 'table' then return end
        for index = 1, #ids do
            local entity = Game.FindEntityByID(ids[index])
            local busy = false
            if entity then
                local ok, occupied = pcall(function() return entity:IsPlayerMounted() or entity:HasPassengers() end)
                busy = not ok or occupied == true
            end
            if not busy then system:DeleteEntity(ids[index]) end
        end
    end)

    local carsFailed = false
    local function cars()
        if not sequencer then
            -- One try: a car module that cannot be loaded is not read and compiled again at every step of an arrival.
            if carsFailed then return nil end
            local loaded, module = pcall(dofile, 'immersive-car.lua')
            if not loaded or type(module) ~= 'table' then carsFailed = true; return nil end
            carModule = module
            carApi = module.nativeApi({vehicle = deps.companions.vehicleAdapter, companions = deps.companions, tag = HER_CAR_TAG})
            sequencer = module.sequencer(carApi)
        end
        return sequencer
    end

    function W.state()
        local ok, player = pcall(Game.GetPlayer)
        if not ok or not player then return {running = false} end
        local position = point(player:GetWorldPosition())
        local held
        if deps.held then local called, value = pcall(deps.held); if called then held = value end end
        return {running = position ~= nil, position = position, held = held}
    end

    -- ---- the map waypoint -------------------------------------------------------------------------------------------------
    -- Only a pin the player set counts (the AutoDrive destination type PlayerTracked, as the chauffeur reads it); a tracked quest marker
    -- is never "the waypoint". Returns marker, road (the engine's road end point), the pin's own name.
    local function trackedWaypoint()
        local ok, marker, road, name = pcall(function()
            local auto = Game.GetScriptableSystemsContainer():Get(CName.new('AutoDriveSystem'))
            if not auto or auto:GetAutodriveDestinationType() ~= Enum.new('gameAutodriveDestinationType', 'PlayerTracked') then return nil end
            local pin = Game.GetMappinSystem():GetMappin(auto:GetAutodriveDestinationMappinID())
            if not pin then return nil end
            local label
            local named, display = pcall(function() return pin:GetDisplayName() end)
            if named then label = localized(display) end
            return point(pin:GetWorldPosition()), point(auto:GetAutodriveDestination()), label
        end)
        if not ok then return nil end
        return marker, road, name
    end

    function W.hasWaypoint()
        local marker = trackedWaypoint()
        return marker ~= nil
    end

    -- The nearest fast travel point's name and district, within the radius (FastTravelSystem rows; whether every point lists a position is
    -- a live check). nil when the game does not say.
    local function landmark(position)
        local ok, label = pcall(function()
            local system = Game.GetScriptableSystemsContainer():Get(CName.new('FastTravelSystem'))
            local rows = system and system:GetFastTravelPoints()
            if type(rows) ~= 'table' then return nil end
            local maps = Game.GetMappinSystem()
            local best, bestGap
            for _, row in ipairs(rows) do
                local at = row.mappinID and maps:GetMappin(row.mappinID)
                local where = at and point(at:GetWorldPosition())
                if where then
                    local gap = math.sqrt((where.x - position.x) ^ 2 + (where.y - position.y) ^ 2)
                    if gap <= WAYPOINT_LANDMARK_RADIUS and (not bestGap or gap < bestGap) then best, bestGap = row, gap end
                end
            end
            if not best then return nil end
            local name, district = localized(best:GetPointDisplayName()), localized(best:GetDistrictDisplayName())
            if name and district then return 'near ' .. name .. ' in ' .. district end
            if name then return 'near ' .. name end
            return district and ('near ' .. district) or nil
        end)
        return ok and label or nil
    end

    -- ---- the place -----------------------------------------------------------------------------------------------------
    local function hereWords()
        local called, district = false, nil
        if deps.districtOf then called, district = pcall(deps.districtOf) end
        if called and type(district) == 'table' then return words.text(district.district, district.area) end
        return nil
    end

    -- The game's own nearest road to V (the prevention system measures it for its police fallback): point, nil + a code word + the fields it
    -- showed. It is kept for the police logic, so on a calm walk it may be an empty struct (live 2026-10-25/26: Car asked outdoors by a road
    -- still walked, and nothing said why); every way it can fail has its own code, and the fields it did show go to the log with the first appointment.
    local function engineRoad(from)
        local ok, info = pcall(function()
            local system = Game.GetPreventionSpawnSystem()
            if not system then return false end
            return system:GetNearestRoadFromPlayerInfo()
        end)
        if not ok then return nil, 'call-failed', tostring(info):sub(1, 80) end
        if info == false then return nil, 'no-system' end
        if info == nil then return nil, 'no-info' end
        local seen, shown = {}, {}
        for _, name in ipairs({'point', 'pathLength', 'distance', 'length', 'isValid', 'valid'}) do
            local called, value = pcall(function() return info[name] end)
            if called and value ~= nil then
                seen[name] = value
                local at = name == 'point' and point(value)
                shown[#shown + 1] = name .. '=' .. (at and string.format('%.0f,%.0f,%.0f', at.x, at.y, at.z) or tostring(value):sub(1, 20))
            end
        end
        local note = #shown > 0 and table.concat(shown, ' ') or 'no-fields'
        if seen.isValid == false or seen.valid == false then return nil, 'invalid', note end
        local at = point(seen.point)
        if not at then return nil, 'no-point', note end
        if at.x == 0 and at.y == 0 then return nil, 'zero-point', note end
        local length = tonumber(seen.pathLength) or tonumber(seen.distance) or tonumber(seen.length)
        if length and length < 0 then return nil, 'no-path', note end
        local gap = math.sqrt((at.x - from.x) ^ 2 + (at.y - from.y) ^ 2)
        local far = length or gap
        if far > ROAD_MAX_WALK then return nil, string.format('far:%.0f', far), note end
        return at, nil, note
    end

    -- The point of V's recent drives that is nearest to V, within TRAIL_NEAR: a road for certain.
    local function trailRoad(from)
        local best, bestGap
        for _, at in ipairs(trail) do
            local gap = math.sqrt((at.x - from.x) ^ 2 + (at.y - from.y) ^ 2)
            if gap <= TRAIL_NEAR and (not bestGap or gap < bestGap) then best, bestGap = at, gap end
        end
        return best
    end
    -- Codes of an engine answer that says nothing (as opposed to "no road within reach"): the car then drives toward V's own spot and the
    -- engine's driving AI finds the road; a drive that cannot be made walks instead, with its own code.
    local UNREADABLE = {['call-failed'] = true, ['no-system'] = true, ['no-info'] = true, ['no-point'] = true, ['zero-point'] = true}

    -- road, how ('engine' | 'trail' | 'guess'), or nil + code, and the note on what the engine showed.
    local function findRoad(from)
        local at, why, note = engineRoad(from)
        if at then return at, 'engine', nil, note end
        local drove = trailRoad(from)
        if drove then return drove, 'trail', why, note end
        if UNREADABLE[why] then return {x = from.x, y = from.y, z = from.z}, 'guess', why, note end
        return nil, nil, why, note
    end

    -- {position, place, road} for 'here' (V's position now) or 'waypoint' (the player's pin), or nil + reason.
    function W.describe(kind, wantRoad)
        local state = W.state()
        if not state.position then return nil end
        if kind ~= 'waypoint' then
            local here = {position = state.position, place = hereWords() or 'where V is'}
            if wantRoad then
                local road, how, why, note = findRoad(state.position)
                here.road, here.roadHow, here.roadWhy, here.roadNote = road, how, why, note
            end
            return here
        end
        local marker, road, name = trackedWaypoint()
        if not marker then return nil end
        local gap = math.sqrt((marker.x - state.position.x) ^ 2 + (marker.y - state.position.y) ^ 2)
        local place = name
        local near = landmark(marker)
        if not place then
            if gap <= WAYPOINT_NEAR_V then
                local mine = hereWords()
                place = mine and ('near ' .. mine) or 'the spot you marked on the map'
            elseif near then place = near
            else
                local mine = hereWords()
                place = string.format('about %.1f km %s of %s', gap / 1000, words.compass(marker.x - state.position.x, marker.y - state.position.y),
                    mine or 'where you are')
            end
        elseif near and not place:find(near, 1, true) then
            place = place .. ', ' .. near
        end
        return {position = marker, place = place, road = road, roadHow = road and 'engine' or nil, roadWhy = (not road) and 'no-pin-road' or nil}
    end

    -- ---- spots -----------------------------------------------------------------------------------------------------------
    -- A hidden, walkable, reachable spot (mod/companions.lua findVisitorSpot spreads the search over several calls).
    function W.findSpot(a, mode)
        local relax = a.spotTries or 0
        local key = tostring(mode) .. ':' .. tostring(relax)
        if a.spotKey ~= key then a.spotKey, a.spotState = key, {} end
        if mode == 'car' then
            local ok, spot, reason, deferred = pcall(deps.companions.findCarSpot, a.key,
                {destination = a.road, goal = a.dest, trail = trail, relax = relax}, a.spotState)
            if not ok then return nil, tostring(spot) end
            return spot, reason, deferred
        end
        local request = {destination = a.dest, mode = mode, relax = relax, maxDistance = a.maxDistance}
        if mode == 'exit' then
            for _, row in ipairs(deps.companions.visitors()) do
                if row.serial == a.serial and row.position then request.from = row.position end
            end
        end
        if a.dest and a.dest.z and request.destination then
            request.destination = {x = a.dest.x, y = a.dest.y, z = a.dest.z or 0}
        end
        local others = {}
        for _, row in ipairs(deps.companions.visitors()) do
            if row.position and row.serial ~= a.serial then others[#others + 1] = row.position end
        end
        request.avoid = others
        local ok, spot, reason, deferred = pcall(deps.companions.findVisitorSpot, a.key, request, a.spotState)
        if not ok then return nil, tostring(spot) end
        return spot, reason, deferred
    end

    function W.hidden(position)
        local ok, hidden = pcall(deps.companions.hiddenFromPlayer, position)
        return ok and hidden or nil
    end

    function W.release(a)
        a.spotState, a.spotKey = nil, nil
    end

    -- ---- her car ---------------------------------------------------------------------------------------------------------
    -- Where V has driven lately (road points, newest last): the one place a road is known for certain. Sampled every two seconds by the
    -- glue while Car is the arrival method, only while V is in a moving vehicle.
    function W.sampleTrail()
        pcall(function()
            local player = Game.GetPlayer()
            local car = player and player:GetMountedVehicle()
            if not car then return end
            local speed = car:GetCurrentSpeed()
            if type(speed) ~= 'number' or math.abs(speed) < TRAIL_SPEED then return end
            local at = point(car:GetWorldPosition())
            local last = trail[#trail]
            if not at or (last and math.sqrt((at.x - last.x) ^ 2 + (at.y - last.y) ^ 2) < TRAIL_STEP) then return end
            trail[#trail + 1] = at
            if #trail > TRAIL_LIMIT then table.remove(trail, 1) end
        end)
    end

    function W.carChoice(a)
        local definition = deps.companions.definition(a.key)
        local catalog = dofile('companion-vehicle-catalog.lua')
        local choice = catalog.choose({{entry = {key = a.key, record = definition and definition.id}}})
        return choice
    end
    function W.carCreate(a)
        local sequence = cars()
        if not sequence then return nil, 'The car module is unavailable.' end
        return sequence.create({car = a.carSpot}, a.carChoice or W.carChoice(a))
    end
    function W.carReady(a, dt)
        local sequence = cars()
        if not sequence or not a.car then return 'bad', 'There is no car.', 'car-gone' end
        return sequence.ready(a.car, dt)
    end
    function W.carStep(a, dt)
        local sequence = cars()
        if not sequence or not a.car then return 'failed', 'There is no car.' end
        return sequence.step(a, dt)
    end
    function W.carHalt(a)
        local sequence = cars()
        return sequence and a.car and sequence.halt(a.car) == true or false
    end
    function W.carPosition(handle)
        return cars() and carApi.position(handle) or nil
    end
    function W.carDelete(handle)
        if not cars() then return true end
        return carApi.delete(handle)
    end
    -- The live car of a companion in V's group, while it stands within `radius` of V (the chauffeur's offer, mod/companion-chauffeur-native.lua).
    function W.carEntity(handle, radius)
        local ok, entity = pcall(function()
            local found = Game.FindEntityByID(handle.entityID)
            if not found or not found:IsAttached() or found:IsDestroyed() then return nil end
            local player = Game.GetPlayer()
            local from, to = player:GetWorldPosition(), found:GetWorldPosition()
            if math.sqrt((from.x - to.x) ^ 2 + (from.y - to.y) ^ 2) > (radius or 25) then return nil end
            return found
        end)
        return ok and entity or nil
    end
    function W.isCarEntity(entity, handle)
        local ok, same = pcall(function() return tostring(entity:GetEntityID().hash) == tostring(handle.entityID.hash) end)
        return ok and same == true
    end

    return W
end

return M
