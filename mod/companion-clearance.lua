-- Read-only physics fit checks. Installed 2.31 REDmod source:
-- core/systems/spatialQueriesSystem.script, SpatialQueriesHelper.HasSpaceInFront;
-- cyberpunk/ai/Tasks/aiStatusEffectTask.script, HasSpaceToRecover.
-- Overlap takes HALF extents and EulerAngles; its Boolean means HIT, not success.
local M={}
local groups={'Static','Dynamic','Vehicle','Terrain','Collider','Destructible'}
local humanoid={radius=.4,height=2.1,kind='humanoid'}
local large={radius=.9,height=3.0,kind='large-or-unknown'}
local budget
M.UPDATE_QUERY_LIMIT=192
function M.newBudget() return {limit=M.UPDATE_QUERY_LIMIT,used=0,deferred=0} end
-- dofile creates separate helper tables. The owner injects this SAME plain
-- budget object into walking, placement and vehicle adapters each CET update.
function M.useBudget(value) budget=value end
function M.available(count)
    if not budget or budget.used+count<=budget.limit then return true end
    budget.deferred=budget.deferred+1
    return false
end
function M.take(count)
    if not M.available(count) then return false end
    if budget then budget.used=budget.used+count end
    return true
end

local function finite(value)
    return type(value)=='number' and value==value and math.abs(value)<10000000
end
local function point(value)
    return value and finite(value.x) and finite(value.y) and finite(value.z)
end
M.isPoint=point
local function shape(value)
    value=value or humanoid
    if not finite(value.radius) or not finite(value.height) or value.radius<.2
        or value.radius>3 or value.height<.5 or value.height>6 then
        error('Companion body dimensions are unavailable')
    end
    return value
end
function M.profile(definition,key)
    definition=definition or {}
    local label=(tostring(definition.id or definition.recordID or '')..' '
        ..tostring(key or definition.key or '')..' '..tostring(definition.profileKey or '')..' '
        ..tostring(definition.name or '')):lower()
    -- Record names, variant names, roster keys and model browser entries all
    -- reach this policy. A conversation assignment never shrinks a model.
    local known=definition.profileKey~=nil and not label:find('smasher',1,true)
    local value=known and humanoid or large
    return {radius=value.radius,height=value.height,kind=value.kind}
end
local function overlap(extents,center,rotation)
    -- Never certify part of a box. Retry that box next update if there is not
    -- room for every collision group, with no geometry failure or native call.
    if not M.available(#groups) then return nil,nil,true end
    local spatial=Game.GetSpatialQueriesSystem()
    if not spatial then error('Spatial queries are unavailable') end
    for _,group in ipairs(groups) do
        if not M.take(1) then return nil,nil,true end
        local hit=spatial:Overlap(extents,center,rotation,CName.new(group))
        if type(hit)~='boolean' then error('Spatial overlap returned no Boolean') end
        -- A trace can be absent for a hit or populated for no hit. Native code
        -- uses this Boolean, so never infer free space from trace contents.
        if hit then
            return false,'Scenery or a vehicle is blocking the companion position.',nil,
                {group=group,center={x=center.x,y=center.y,z=center.z},
                halfExtents={x=extents.x,y=extents.y,z=extents.z},
                rotation={roll=rotation.roll,pitch=rotation.pitch,yaw=rotation.yaw}}
        end
    end
    return true
end
local function checked(action)
    local ok,clear,reason,deferred,rejection=pcall(action)
    if not ok then
        return false,'The game could not verify companion body clearance.',nil,{unavailable=true}
    end
    return clear,reason,deferred,rejection
end
function M.body(feet,dimensions)
    return checked(function()
        if not point(feet) then error('Invalid companion position') end
        local size=shape(dimensions)
        local half=size.height*.5
        return overlap(Vector4.new(size.radius,size.radius,half,0),
            Vector4.new(feet.x,feet.y,feet.z+half+.1,1),EulerAngles.new(0,0,0))
    end)
end
-- A rejected box is a bounded geometry-change sensor, not a movement permit.
-- Every successful retry still rebuilds the native route and checks its body.
function M.recheck(rejection)
    return checked(function()
        local center,extents=rejection.center,rejection.halfExtents
        if not point(center) or not point(extents) or extents.x<=0 or extents.y<=0 or extents.z<=0
            or extents.x>100 or extents.y>100 or extents.z>10 then error('Invalid rejected box') end
        local rotation=rejection.rotation or {}
        return overlap(Vector4.new(extents.x,extents.y,extents.z,0),
            Vector4.new(center.x,center.y,center.z,1),
            EulerAngles.new(rotation.roll or 0,rotation.pitch or 0,rotation.yaw or 0))
    end)
end
function M.segmentBoxes(from,to)
    local length=math.sqrt((to.x-from.x)^2+(to.y-from.y)^2)
    return math.max(1,math.ceil(length/2),math.ceil(math.abs(to.z-from.z)/.2))
end
function M.segment(from,to,dimensions,progress,nativeOriginProjection)
    return checked(function()
        if not point(from) or not point(to) then error('Invalid companion route') end
        local size=shape(dimensions)
        local dx,dy,dz=to.x-from.x,to.y-from.y,to.z-from.z
        local length=math.sqrt(dx*dx+dy*dy)
        -- Bound work even for a malformed/native long path leg. Dividing at
        -- changes in height keeps a sloping nav path from becoming one box
        -- through the floor. Native navigation still supplies the walk route.
        local count=M.segmentBoxes(from,to)
        local allowedRise=math.max(.35,length*.8)
        -- A caller can certify only the first native path point as an origin
        -- projection. Keep the ordinary step rule for every other leg.
        local strictNativeConnector=nativeOriginProjection==true and length<=.02
            and dz>0 and dz<=.65
        local projectedOrigin=strictNativeConnector and dz>.35
        if count>64 or (math.abs(dz)>allowedRise and not projectedOrigin) then
            return false,'The companion route has no verified walkable clearance.',nil,
                {geometryType=count>64 and 'route-size' or 'step-slope',
                from={x=from.x,y=from.y,z=from.z},to={x=to.x,y=to.y,z=to.z},
                length=length,rise=math.abs(dz),deltaZ=dz,allowedRise=allowedRise,
                boxes=count,maxBoxes=64}
        end
        local rotation=length>.001 and Quaternion.ToEulerAngles(
            Quaternion.BuildFromDirectionVector(Vector4.new(dx/length,dy/length,0,0))) or EulerAngles.new(0,0,0)
        for index=progress and progress.next or 1,count do
            local a=(index-1)/count; local b=index/count
            local low=math.min(from.z+dz*a,from.z+dz*b)
            local high=math.max(from.z+dz*a,from.z+dz*b)
            -- Walking may step onto a kerb/stair. Check the continuous swept
            -- body above that .35m step band, including the higher head end.
            -- Standing destinations separately use body() down to .1m.
            -- For that one projected connector, sweep from the reported root +.1
            -- through the higher navmesh body. Intervening floor planes must
            -- block; ordinary walking retains its original .35 m step band.
            local bottom=low+(strictNativeConnector and .1 or .35)
            local top=high+size.height+.1
            local half=(top-bottom)*.5
            local middle=(a+b)*.5
            local clear,reason,deferred,rejection=overlap(Vector4.new(size.radius,length/(2*count)+size.radius,half,0),
                Vector4.new(from.x+dx*middle,from.y+dy*middle,bottom+half,1),rotation)
            if deferred then
                if progress then progress.next=index end
                return nil,nil,true
            end
            if not clear then
                if rejection then
                    rejection.box,rejection.boxes=index,count
                    rejection.from={x=from.x,y=from.y,z=from.z}
                    rejection.to={x=to.x,y=to.y,z=to.z}
                end
                return false,reason,nil,rejection
            end
        end
        if progress then progress.next=nil end
        return true
    end)
end
return M
