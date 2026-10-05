-- Navmesh is ground/reachability evidence, not proof that a body fits there.
local clearance=dofile('companion-clearance.lua')
local M={profile=clearance.profile}
function M.useSpatialBudget(value) clearance.useBudget(value) end
local function distance(a,b)
    return math.sqrt((a.x-b.x)^2+(a.y-b.y)^2+(a.z-b.z)^2)
end
local function ground(a,b) return math.sqrt((a.x-b.x)^2+(a.y-b.y)^2) end
local function finite(value)
    return type(value)=='number' and value==value and math.abs(value)<10000000
end
local function point(value)
    return value and finite(value.x) and finite(value.y) and finite(value.z)
end
local function separated(candidate,origin,occupied,body)
    local radius=body and body.radius or .4
    if ground(candidate,origin)<math.max(1.05,radius+.55) then return false end
    for _,other in ipairs(occupied or {}) do
        local position=other.position or other
        local otherRadius=other.clearance and other.clearance.radius or .4
        if not point(position) or ground(candidate,position)<radius+otherRadius+.1 then return false end
    end
    return true
end
-- Recheck the actual engine position before assigning a follower role. The
-- native spawn can move within its accepted ground tolerance, or a car can
-- arrive between the invitation and asynchronous entity attachment.
function M.verify(player,actual,occupied,body)
    local ok,clear,reason,deferred=pcall(function()
        if not point(actual) or not separated(actual,player:GetWorldPosition(),occupied,body) then
            return false,'The game placed this copy too close to someone. Invitation cancelled.'
        end
        local ground=Game.GetAINavigationSystem():FindPointInSphereForCharacter(actual,.45,player)
        if not ground or ground.status~=Enum.new('worldNavigationRequestStatus','OK') or not point(ground.point)
            or distance(ground.point,actual)>.35 then
            return false,'The game placed this copy away from the verified ground. Invitation cancelled.'
        end
        return clearance.body(actual,body)
    end)
    if not ok then return false,'The game could not verify a safe companion position.' end
    return clear,reason,deferred
end
local function candidates(origin,preferred)
    local result={}
    for _,offset in ipairs({{0,0},{.6,0},{-.6,0},{0,.6},{0,-.6},{.6,.6},{-.6,-.6}}) do
        result[#result+1]=Vector4.new(preferred.x+offset[1],preferred.y+offset[2],origin.z,1)
    end
    -- A whole preferred side can be occupied by V's car. Search the other
    -- sides as well, with a fixed 23-candidate cap and no unsafe fallback.
    local dx,dy=preferred.x-origin.x,preferred.y-origin.y
    local length=math.sqrt(dx*dx+dy*dy)
    if length<.001 then dx,dy=1,0 else dx,dy=dx/length,dy/length end
    for _,radius in ipairs({2.2,3.5}) do
        for index=0,7 do
            local co,si=math.cos(index*math.pi/4),math.sin(index*math.pi/4)
            result[#result+1]=Vector4.new(origin.x+(dx*co-dy*si)*radius,
                origin.y+(dy*co+dx*si)*radius,origin.z,1)
        end
    end
    return result
end
-- A standing body can fit in a pocket that no walking body can leave. Sweep
-- the native route's first metres back toward V, as walking will.
local exitLength=1.5
local function exitClear(points,body)
    local remaining=exitLength
    for index=#points,2,-1 do
        local from,to=points[index],points[index-1]
        if not point(from) or not point(to) then return false end
        local length=ground(from,to)
        if length>remaining then
            local t=remaining/length
            to=Vector4.new(from.x+(to.x-from.x)*t,from.y+(to.y-from.y)*t,from.z+(to.z-from.z)*t,1)
        end
        local clear,why,pending=clearance.segment(from,to,body)
        if pending or not clear then return clear,why,pending end
        remaining=remaining-length
        if remaining<=0 then break end
    end
    return true
end
-- accept(candidate), when given, can refuse an otherwise valid spot.
function M.find(player,preferred,occupied,body,accept)
    local ok,result,reason,deferred=pcall(function()
        local nav,origin=Game.GetAINavigationSystem(),player:GetWorldPosition()
        local success=Enum.new('worldNavigationRequestStatus','OK')
        if not point(origin) or not point(preferred) then error('Invalid invitation position') end
        local source=nav:FindPointInSphereForCharacter(origin,.7,player)
        if not source or source.status~=success or not point(source.point)
            or math.abs(source.point.z-origin.z)>.65 or distance(source.point,origin)>.8 then
            return nil,'Move onto open, walkable ground to invite a companion here.'
        end
        local seen={}
        for _,desired in ipairs(candidates(origin,preferred)) do
            local found=nav:FindPointInSphereForCharacter(desired,.55,player)
            if found and found.status==success and point(found.point) then
                local candidate=found.point
                local signature=string.format('%.2f:%.2f:%.2f',candidate.x,candidate.y,candidate.z)
                local clear=not seen[signature] and math.abs(candidate.z-origin.z)<=.65
                    and distance(candidate,desired)<=.65 and distance(candidate,origin)<=6
                    and separated(candidate,origin,occupied,body)
                seen[signature]=true
                if clear then
                    local fits,why,pending=clearance.body(candidate,body)
                    if pending then return nil,nil,true end
                    if not fits and why and why:find('could not verify',1,true) then return nil,why end
                    if fits then
                        local route=nav:CalculatePathForCharacter(source.point,candidate,.3,player)
                        local points=route and route.path
                        if points and #points>0 and point(points[#points])
                            and distance(points[#points],candidate)<=.65
                            and route:CalculateLength()<=distance(source.point,candidate)+3 then
                            local sameFloor=true
                            for _,p in ipairs(points) do
                                if not point(p) or math.abs(p.z-origin.z)>.9 then sameFloor=false; break end
                            end
                            if sameFloor then
                                local free,exitWhy,exitPending=exitClear(points,body)
                                if exitPending then return nil,nil,true end
                                if not free and exitWhy and exitWhy:find('could not verify',1,true) then return nil,exitWhy end
                                if free and (not accept or accept(candidate)) then
                                    return Vector4.new(candidate.x,candidate.y,candidate.z+.1,1)
                                end
                            end
                        end
                    end
                end
            end
        end
        return nil,'No clear, reachable companion space on this floor. Move to a wider spot and try again.'
    end)
    if not ok then return nil,'The game could not verify a safe companion position.' end
    return result,reason,deferred
end
return M
