-- Spawn only on reachable navigation ground close to V's current floor.
-- An offset from V can be empty air over a road, balcony edge or another floor.
local M = {}

local function distance(a, b)
    return math.sqrt((a.x-b.x)^2 + (a.y-b.y)^2 + (a.z-b.z)^2)
end

function M.find(player, preferred, occupied)
    local ok, point, reason = pcall(function()
        local nav, origin = Game.GetAINavigationSystem(), player:GetWorldPosition()
        local success = Enum.new('worldNavigationRequestStatus', 'OK')
        local source = nav:FindPointInSphereForCharacter(origin, 0.7, player)
        if not source or source.status ~= success or not source.point
            or math.abs(source.point.z-origin.z) > 0.65 then
            return nil, 'Move onto open, walkable ground to invite a companion here.'
        end
        local offsets = {{0,0},{0.6,0},{-0.6,0},{0,0.6},{0,-0.6},{0.6,0.6},{-0.6,-0.6}}
        for _, offset in ipairs(offsets) do
            local desired = Vector4.new(preferred.x+offset[1], preferred.y+offset[2], origin.z, 1)
            local found = nav:FindPointInSphereForCharacter(desired, 0.55, player)
            if found and found.status == success and found.point then
                local candidate = found.point
                local clear = math.abs(candidate.z-origin.z) <= 0.65
                    and distance(candidate, desired) <= 0.65 and distance(candidate, origin) >= 1.05
                for _, other in ipairs(occupied or {}) do
                    if distance(candidate, other) < 0.9 then clear = false; break end
                end
                if clear then
                    local route = nav:CalculatePathForCharacter(source.point, candidate, 0.3, player)
                    local points = route and route.path
                    if points and #points > 0 and distance(points[#points], candidate) <= 0.65
                        and route:CalculateLength() <= distance(source.point, candidate) + 3.0 then
                        -- Reject routes that briefly descend to the road and
                        -- return to a nearby but disconnected platform.
                        local sameFloor = true
                        for _, p in ipairs(points) do
                            if math.abs(p.z-origin.z) > 0.9 then sameFloor = false; break end
                        end
                        if sameFloor then return Vector4.new(candidate.x, candidate.y, candidate.z+0.1, 1) end
                    end
                end
            end
        end
        return nil, 'No reachable space beside you on this floor. Move to a wider spot and try again.'
    end)
    if not ok then return nil, 'The game could not verify a safe companion position.' end
    return point, reason
end

return M
