-- The game side of immersive invitations (docs/IMMERSIVE_INVITATIONS.md): V's position and what holds V, the meeting place and the
-- words for it, the map waypoint, and the hidden spot a visitor appears at. Everything here is read when an appointment asks (an
-- offer, a spot search, a step of a visitor), never per frame, and every game call is guarded: a failed read is "unknown", never an error
-- in the caller. mod/immersive-invitations.lua is the state machine that uses it.
local words = dofile('place-words.lua')
local M = {}

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

    -- {position, place, road} for 'here' (V's position now) or 'waypoint' (the player's pin), or nil + reason.
    function W.describe(kind)
        local state = W.state()
        if not state.position then return nil, 'V is not in the world.' end
        if kind ~= 'waypoint' then
            return {position = state.position, place = hereWords() or 'where V is'}
        end
        local marker, road, name = trackedWaypoint()
        if not marker then return nil, 'No waypoint is set.' end
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
        return {position = marker, place = place, road = road}
    end

    -- ---- spots -----------------------------------------------------------------------------------------------------------
    -- A hidden, walkable, reachable spot (mod/companions.lua findVisitorSpot spreads the search over several calls).
    function W.findSpot(a, mode)
        local relax = a.spotTries or 0
        local key = tostring(mode) .. ':' .. tostring(relax)
        if a.spotKey ~= key then a.spotKey, a.spotState = key, {} end
        local request = {destination = a.dest, mode = mode == 'car' and 'walk' or mode, relax = relax, maxDistance = a.maxDistance}
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

    return W
end

return M
