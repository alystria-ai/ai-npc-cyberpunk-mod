-- Read-only physics fit checks. Installed 2.31 REDmod source:
-- core/systems/spatialQueriesSystem.script, SpatialQueriesHelper.HasSpaceInFront;
-- cyberpunk/ai/Tasks/aiStatusEffectTask.script, HasSpaceToRecover.
-- Overlap takes HALF extents and EulerAngles; its Boolean means HIT, not success.
local M={}
local NATIVE='clearance' -- the convaiNative system name (kill switch, probe.log)
local groups={'Static','Dynamic','Vehicle','Terrain','Collider','Destructible'}
local humanoid={radius=.4,height=2.1,kind='humanoid'}
local large={radius=.9,height=3.0,kind='large-or-unknown'}
local budget
M.UPDATE_QUERY_LIMIT=192
function M.newBudget() return {limit=M.UPDATE_QUERY_LIMIT,used=0,deferred=0} end
-- dofile creates separate helper tables. The owner injects this SAME plain
-- budget object into walking, placement and vehicle adapters each CET update.
local announced=false
function M.useBudget(value)
    budget=value
    -- Once the plugin check has finished, ask for the switch so probe.log names the active path
    -- (convaiNative logs "Native core: clearance=native|lua" on every change).
    if not announced then
        local api=convaiNative
        if type(api)=='table' and api.pending~=true and type(api.use)=='function' then
            announced=true
            pcall(api.use,NATIVE)
        end
    end
end
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

-- Optional native path -----------------------------------------------------------------------
-- With the CyberpunkConvaiNative plugin loaded and its 'clearance' switch on, body, recheck,
-- segment, sightClear and floorZ run in C++ (native/core/src/systems/clearance): one CET call per
-- check instead of 14 per box (Vector4.new x2, CName.new x6, Overlap x6), and the plugin's own
-- query loop. Everything above is the original Lua and stays the fallback:
--   * kill switch: a line "clearance" in runtime/native-off.txt, or convaiNative.off('clearance')
--     in the CET console; three faults inside the plugin's natives also switch it off;
--   * a native call that fails or answers unreadably calls convaiNative.fail('clearance', ...):
--     this module stays on Lua for the session and probe.log says why;
--   * before the first use, the plugin runs its own queries in the world (SelfTest) and its box
--     orientation is compared with Quaternion.BuildFromDirectionVector/ToEulerAngles; any
--     difference keeps the Lua path;
--   * convaiNative.clearanceVerify = true (CET console) runs BOTH paths for every call, returns the
--     Lua answer and logs any difference to probe.log; convaiNative.clearanceStats counts the calls.
-- The per-update query budget stays a Lua table: the plugin is told what is left and reports the
-- queries it issued, which are added to budget.used here.
local BIG=1000000
local REASON='Scenery or a vehicle is blocking the companion position.'
local UNAVAILABLE='The game could not verify companion body clearance.'
local sightGroups={'Static','Dynamic','Terrain','Collider','Destructible','Vehicle'}
local luaBody,luaRecheck,luaSegment=M.body,M.recheck,M.segment

-- companions.lua visibleFromCrosshair, unchanged: six rays, each charged to the budget.
local function luaSight(from,to)
    local spatial=Game.GetSpatialQueriesSystem()
    if not spatial then return false end
    local start=Vector4.new(from.x,from.y,from.z,1)
    local finish=Vector4.new(to.x,to.y,to.z,1)
    for _,group in ipairs(sightGroups) do
        if not M.take(1) then return false end
        -- CET returns the out TraceResult. Boolean HIT is authoritative;
        -- nil/non-Boolean responses never certify an unobstructed ray.
        local hit=spatial:SyncRaycastByCollisionGroup(start,finish,CName.new(group),false,false)
        if type(hit)~='boolean' or hit then return false end
    end
    return true
end
-- companions.lua floorBelow, unchanged: the Static floor below a point. The caller already took
-- the one budget unit.
local function luaFloor(at,maxDrop)
    local hit,trace=Game.GetSpatialQueriesSystem():SyncRaycastByCollisionGroup(
        Vector4.new(at.x,at.y,at.z+.6,1),Vector4.new(at.x,at.y,at.z-.8,1),CName.new('Static'),false,false)
    if hit~=true or not trace or not trace.position then return nil end
    local drop=at.z-trace.position.z
    if drop<.05 or drop>(maxDrop or .35) then return nil end
    return trace.position.z
end

local function bound(value) return type(value)=='table' or type(value)=='userdata' end
local function unavailable() return false,UNAVAILABLE,nil,{unavailable=true} end
local function copyPoint(p) return {x=p.x,y=p.y,z=p.z} end
local function remaining()
    if not budget then return BIG end
    local left=budget.limit-budget.used
    if left<=0 then return 0 end
    return left>=BIG and BIG or math.floor(left)
end
M.remaining=remaining
-- The passage module runs its physics in the plugin and reports how many queries it issued; they are
-- charged to the same per-update budget the Lua take()/available() calls use.
function M.spend(used,deferred)
    if budget then
        if type(used)=='number' and used>0 then budget.used=budget.used+used end
        if deferred then budget.deferred=budget.deferred+1 end
    end
end
function M.spent()
    if not budget then return 0,0 end
    return budget.used,budget.deferred
end
local function note(line)
    pcall(function()
        local file=io.open('runtime/probe.log','a')
        if file then file:write(os.date('!%Y-%m-%dT%H:%M:%SZ'),' ',line,'\n'); file:close() end
    end)
end

-- "<status> <used> ..." from the plugin (the grammar is in ClearanceCore.hpp) as numbers, or nil.
local function split(text)
    if type(text)~='string' then return nil end
    local fields,count={},0
    for token in text:gmatch('%S+') do count=count+1; fields[count]=tonumber(token) end
    if count<2 or not fields[1] or not fields[2] then return nil end
    return fields
end
-- The tuple the original function returned: clear, reason, deferred, rejection.
local function decode(f,from,to,segment)
    local status=f[1]
    if status==0 then return true end
    if status==1 then
        local rejection={group=groups[f[3]],center={x=f[4],y=f[5],z=f[6]},
            halfExtents={x=f[7],y=f[8],z=f[9]},rotation={roll=f[10],pitch=f[11],yaw=f[12]}}
        if segment then
            rejection.box,rejection.boxes=f[13],f[14]
            rejection.from,rejection.to=copyPoint(from),copyPoint(to)
        end
        return false,REASON,nil,rejection
    end
    if status==2 then return nil,nil,true end
    if status==5 then
        return false,'The companion route has no verified walkable clearance.',nil,
            {geometryType=f[3]==1 and 'route-size' or 'step-slope',from=copyPoint(from),to=copyPoint(to),
            length=f[4],rise=f[5],deltaZ=f[6],allowedRise=f[7],boxes=f[8],maxBoxes=64}
    end
    return unavailable() -- status 3
end

-- Each native adapter returns: handled, used, extra, then the original function's results.
--   handled  true: the plugin answered; false: its game call failed (used = queries spent, extra = code);
--            'lua': arguments the plugin does not take (the original runs, nothing is switched off)
--   extra    segment only: the new progress.next (0 clears it), nil leaves it alone
local function natBody(class,left,feet,dimensions)
    local ok,size=pcall(function()
        if not point(feet) then error('Invalid companion position') end
        return shape(dimensions)
    end)
    if not ok then return true,0,nil,unavailable() end
    local f=split(class.Body(feet.x,feet.y,feet.z,size.radius,size.height,left))
    if not f then return false,0,'unreadable reply' end
    if f[1]==4 then return false,f[2],f[3] end
    return true,f[2],nil,decode(f)
end
local function natRecheck(class,left,rejection)
    local ok,center,extents,rotation=pcall(function()
        local center,extents=rejection.center,rejection.halfExtents
        if not point(center) or not point(extents) or extents.x<=0 or extents.y<=0 or extents.z<=0
            or extents.x>100 or extents.y>100 or extents.z>10 then error('Invalid rejected box') end
        local rotation=rejection.rotation or {}
        return center,extents,{rotation.roll or 0,rotation.pitch or 0,rotation.yaw or 0}
    end)
    if not ok then return true,0,nil,unavailable() end
    for index=1,3 do if not finite(rotation[index]) then return 'lua',0 end end
    local f=split(class.Box(center.x,center.y,center.z,extents.x,extents.y,extents.z,
        rotation[1],rotation[2],rotation[3],left))
    if not f then return false,0,'unreadable reply' end
    if f[1]==4 then return false,f[2],f[3] end
    return true,f[2],nil,decode(f)
end
local function natSegment(class,left,from,to,dimensions,progress,projection)
    local ok,size=pcall(function()
        if not point(from) or not point(to) then error('Invalid companion route') end
        return shape(dimensions)
    end)
    if not ok then return true,0,nil,unavailable() end
    local start=progress and progress.next or 1
    if type(start)~='number' or start<1 or start>BIG or start~=math.floor(start) then return 'lua',0 end
    local f=split(class.Segment(from.x,from.y,from.z,to.x,to.y,to.z,size.radius,size.height,start,
        projection==true,left))
    if not f then return false,0,'unreadable reply' end
    if f[1]==4 then return false,f[2],f[3] end
    local extra
    if f[1]==2 then extra=f[3] elseif f[1]==0 then extra=0 end
    return true,f[2],extra,decode(f,from,to,true)
end
local function natSight(class,left,from,to)
    if not (bound(from) and bound(to)) then return 'lua',0 end
    if not (finite(from.x) and finite(from.y) and finite(from.z) and finite(to.x) and finite(to.y)
        and finite(to.z)) then return 'lua',0 end
    local f=split(class.Sight(from.x,from.y,from.z,to.x,to.y,to.z,left))
    if not f then return false,0,'unreadable reply' end
    if f[1]==4 then return false,f[2],f[3] end
    return true,f[2],nil,f[1]==0
end
local function natFloor(class,_,at,maxDrop)
    if not bound(at) then return 'lua',0 end
    if maxDrop==nil then maxDrop=.35 end
    if not (finite(at.x) and finite(at.y) and finite(at.z) and finite(maxDrop)) then return 'lua',0 end
    local f=split(class.Floor(at.x,at.y,at.z,maxDrop))
    if not f then return false,0,'unreadable reply' end
    if f[1]==-1 then return false,0,f[2] end
    -- the caller took its one budget unit already, so nothing is charged here
    return true,0,nil,f[1]==1 and f[2] or nil
end

-- Plugin class, resolved once. CET resolves a native class by its global name; before the
-- plugin is loaded (or if it is an older build) the name is nil.
local native
local function resolve()
    if native then return native end
    local ok,class=pcall(function() return ConvaiNativeClearance end)
    if ok and bound(class) then native=class end
    return native
end

-- The plugin's orientation of a horizontal direction against the game's own functions.
local SAMPLES={{0,1},{1,0},{0,-1},{-1,0},{.6,.8},{-.28,.96},{.8,-.6},{-.6,-.8}}
local function angleDiff(a,b)
    local d=(a-b)%360
    return d>180 and 360-d or d
end
local function orientationMatches(class)
    for _,s in ipairs(SAMPLES) do
        local game=Quaternion.ToEulerAngles(Quaternion.BuildFromDirectionVector(Vector4.new(s[1],s[2],0,0)))
        local roll,pitch,yaw=tostring(class.Orientation(s[1],s[2])):match('^(%S+) (%S+) (%S+)$')
        roll,pitch,yaw=tonumber(roll),tonumber(pitch),tonumber(yaw)
        if not (roll and pitch and yaw) then return false,'unreadable Orientation reply' end
        if angleDiff(roll,game.roll)>.01 or angleDiff(pitch,game.pitch)>.01 or angleDiff(yaw,game.yaw)>.01 then
            return false,('orientation of (%g, %g): plugin yaw %g, game yaw %g'):format(s[1],s[2],yaw,game.yaw)
        end
    end
    return true
end
-- true once the plugin's game access and orientation are proven in this session. 'wait' means
-- there is no world to query yet (the Lua path runs and the proof is retried in 2 s).
local function proven(class,api)
    if api.clearanceProven then return true end
    local now=os.clock()
    if api.clearanceRetry and now<api.clearanceRetry then return false end
    local ok,text=pcall(function() return class.SelfTest() end)
    text=ok and tostring(text) or ('error: '..tostring(text))
    if text:sub(1,4)=='wait' then
        -- No world yet, or a lookup that never works: five waits in a row count as a failure.
        api.clearanceWaits=(api.clearanceWaits or 0)+1
        if api.clearanceWaits>5 then api.fail(NATIVE,'self-test: '..text); return false end
        api.clearanceRetry=now+2
        return false
    end
    if text~='ok' then api.fail(NATIVE,'self-test: '..text); return false end
    local called,matches,why=pcall(orientationMatches,class)
    if not called then api.fail(NATIVE,'orientation check: '..tostring(matches)); return false end
    if not matches then api.fail(NATIVE,why); return false end
    api.clearanceProven=true
    note('Native core: clearance self-test passed (game queries and box orientation match)')
    return true
end

local function stats(api)
    local row=api.clearanceStats
    if type(row)~='table' then row={native=0,lua=0,fallback=0,compared=0,mismatches=0}; api.clearanceStats=row end
    return row
end
local function sameResult(n1,n3,n4,l1,l3,l4)
    if type(n1)=='number' and type(l1)=='number' then
        if math.abs(n1-l1)>1e-4 then return false end
    elseif n1~=l1 then return false end
    if (n3==true)~=(l3==true) then return false end
    if type(n4)~='table' and type(l4)~='table' then return true end
    if type(n4)~='table' or type(l4)~='table' then return false end
    return n4.unavailable==l4.unavailable and n4.geometryType==l4.geometryType and n4.group==l4.group
        and n4.box==l4.box and n4.boxes==l4.boxes
end
local function describe(...)
    local parts={}
    for index=1,select('#',...) do
        local value=select(index,...)
        if type(value)=='table' then
            value=('{group=%s box=%s unavailable=%s geometry=%s}'):format(tostring(value.group),
                tostring(value.box),tostring(value.unavailable),tostring(value.geometryType))
        end
        parts[#parts+1]=tostring(value)
    end
    return table.concat(parts,', ')
end

-- Runs nat on the plugin when it is on and proven, else lua. progress (segment only) is the
-- caller's cursor, updated here only when the plugin's answer is used.
local function route(name,nat,lua,progress,...)
    local api=convaiNative
    if type(api)~='table' or type(api.use)~='function' or api.use(NATIVE)~=true then return lua(...) end
    local class=resolve()
    if not class then api.fail(NATIVE,'ConvaiNativeClearance is not registered'); return lua(...) end
    if not proven(class,api) then return lua(...) end
    local row=stats(api)
    local before=budget and budget.used or 0
    local ok,handled,used,extra,r1,r2,r3,r4=pcall(nat,class,remaining(),...)
    if not ok then
        api.fail(NATIVE,name..': '..tostring(handled))
        row.fallback=row.fallback+1
        return lua(...)
    end
    if handled=='lua' then row.lua=row.lua+1; return lua(...) end
    if handled~=true then
        -- The plugin's game call failed. Queries it already made still count against this update.
        if budget and type(used)=='number' then budget.used=budget.used+used end
        api.fail(NATIVE,name..': game query failed (code '..tostring(extra)..')')
        row.fallback=row.fallback+1
        return lua(...)
    end
    if api.clearanceVerify==true then
        local l1,l2,l3,l4=lua(...)
        row.compared=row.compared+1
        local spent=(budget and budget.used or 0)-before
        local nextBox=progress and progress.next
        local same=sameResult(r1,r3,r4,l1,l3,l4) and spent==used
        if same and progress then same=(extra==nil and true) or (extra==0 and nextBox==nil) or extra==nextBox end
        if not same then
            row.mismatches=row.mismatches+1
            if row.mismatches<=20 then
                note(('Native core: clearance MISMATCH in %s: plugin [%s] used %s, Lua [%s] used %s'):format(name,
                    describe(r1,r2,r3,r4),tostring(used),describe(l1,l2,l3,l4),tostring(spent)))
            end
        end
        if row.compared%250==0 then
            note(('Native core: clearance verify %d calls, %d mismatches'):format(row.compared,row.mismatches))
        end
        return l1,l2,l3,l4
    end
    row.native=row.native+1
    if budget then
        budget.used=budget.used+used
        if r3==true then budget.deferred=budget.deferred+1 end
    end
    if progress and extra~=nil then progress.next=extra~=0 and extra or nil end
    return r1,r2,r3,r4
end

function M.body(feet,dimensions) return route('body',natBody,luaBody,nil,feet,dimensions) end
function M.recheck(rejection) return route('recheck',natRecheck,luaRecheck,nil,rejection) end
function M.segment(from,to,dimensions,progress,nativeOriginProjection)
    return route('segment',natSegment,luaSegment,progress,from,to,dimensions,progress,nativeOriginProjection)
end
-- companions.lua calls these inside its own pcall; they raise on a game error like the code they replaced.
function M.sightClear(from,to) return route('sight',natSight,luaSight,nil,from,to) end
function M.floorZ(at,maxDrop) return route('floor',natFloor,luaFloor,nil,at,maxDrop) end

-- Developer mode (perf-probe) times each entry point as clearance.<name>, so the two paths can be
-- compared with convaiNative.off('clearance') / convaiNative.on('clearance').
local probe=convaiPerfProbe
if type(probe)=='table' and type(probe.watch)=='function' then
    for _,name in ipairs({'body','recheck','segment','sightClear','floorZ'}) do
        pcall(probe.watch,M,name,'clearance.'..name)
    end
end
return M
