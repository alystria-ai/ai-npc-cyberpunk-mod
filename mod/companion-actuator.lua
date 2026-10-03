-- Native execution boundary: one owned movement command and one look request.
-- A completed finite operation is never silently reissued while its feet coast.
local space=dofile('companion-space.lua')
local clearance=dofile('companion-clearance.lua')
local M={}
local recoveryPolicy={nearObstacle=6,travelHorizon=6,headingChange=45,
    planSpan=1.8,planRise=.2,escapeCommandSpan=2.2,travelCommandSpan=4,rollingGap=.35}
function M.useSpatialBudget(value) clearance.useBudget(value) end
local function vector(p) return Vector4.new(p.x,p.y,p.z or 0,p.w or 1) end
local function position(p)
    local world=WorldPosition.new(); world:SetVector4(vector(p))
    local spec=AIPositionSpec.new(); spec:SetWorldPosition(world); return spec
end
-- RED4ext.SDK Game Reflection: AI/CommandState.hpp. Native AIComponent keeps
-- NotExecuting in its active-command list, so it is never proof of cancellation.
local function stateName(label)
    return label:match('^AICommandState%s*:%s*(%w+)%s*%(%d+%)$') or label
end
local function active(label)
    local name=stateName(label)
    return name=='Executing' or name=='Enqueued' or name=='NotExecuting'
end
local function terminal(label)
    local name=stateName(label)
    return name=='Success' or name=='Failure' or name=='Cancelled' or name=='Interrupted'
end
function M.new(npc,shape)
    return {npc=npc,clearance=shape,clock=0,issued=false,lookStyle='none',feedback={},commands=0,events={}}
end
local function record(s,kind)
    if #s.events>=16 then table.remove(s.events,1) end
    s.events[#s.events+1]={at=s.clock,event=kind,ticket=s.ticket,kind=s.kind,
        commandID=s.command and tonumber(s.command.id) or nil,target=s.target and space.copy(s.target)}
end
local function currentCommandState(s)
    local ok,label=pcall(function()
        if not s.command or not s.npc or not s.npc:IsAttached() then return nil end
        return tostring(s.npc:GetAIControllerComponent():GetCommandState(s.command))
    end)
    return ok and label or nil
end
local function cancel(s)
    if not s.command then s.cancellation=nil; return true end
    local pending=s.cancellation
    if not pending or pending.command~=s.command then
        pending={command=s.command,requested=false}
        s.cancellation=pending
    end
    local ok,finished=pcall(function()
        if not s.npc or not s.npc:IsAttached() then error('Movement owner is unavailable') end
        local ai=s.npc:GetAIControllerComponent()
        local state=tostring(ai:GetCommandState(pending.command))
        pending.state=state
        if terminal(state) then return true end
        if not active(state) then error('Native movement command state unavailable') end
        if not pending.requested then
            -- Cancellation can complete asynchronously, or refuse/throw after
            -- a side effect. Retain this exact handle and send at most once.
            pending.requested=true
            local accepted
            if stateName(state)~='Executing' then accepted=ai:CancelCommand(pending.command)
            else accepted=ai:StopExecutingCommand(pending.command,true) end
            if accepted==false then error('Native movement cancellation refused') end
            pending.state=tostring(ai:GetCommandState(pending.command))
            return terminal(pending.state) and true or false
        end
        return false
    end)
    if not ok then pending.error=tostring(finished); return false end
    if not finished then return false end
    s.command,s.cancellation=nil,nil
    s.issued=false
    return true
end
local function clearLook(s)
    if s.look and s.npc and s.npc:IsAttached() then
        if s.clock<(s.lookRemoveRetryAt or 0) then return false,s.lookRemoveError end
        local ok,accepted=pcall(function() return LookAtRemoveEvent.QueueRemoveLookatEvent(s.npc,s.look) end)
        -- Keep the exact handle if removal fails; issuing a replacement while
        -- its previous owner is unknown can leave two native look requests.
        if not ok or accepted==false then
            s.lookRemoveRetryAt=s.clock+3
            s.lookRemoveError=ok and 'Native look removal refused' or tostring(accepted)
            return false,s.lookRemoveError
        end
    end
    s.look,s.lookStyle=nil,'none'
    s.lookHeight,s.lookStrength,s.lookSeated=nil,nil,nil
    s.lookRemoveRetryAt,s.lookRemoveError=nil,nil
    return true
end
function M.suspendHold(s)
    if s.cancellation then return false,'Owned movement cancellation is still pending' end
    local held=s.suspendedHold
    if not held then
        if s.kind~='hold' or not s.command then return false,'No owned idle hold to release' end
        held={command=s.command,ticket=s.ticket}
        s.suspendedHold=held
        s.command,s.issued=nil,false
        local ai=s.npc:GetAIControllerComponent()
        local state=tostring(ai:GetCommandState(held.command))
        local accepted
        if stateName(state)=='Enqueued' or stateName(state)=='NotExecuting' then accepted=ai:CancelCommand(held.command)
        elseif active(state) then accepted=ai:StopExecutingCommand(held.command,true) end
        if accepted==false then error('The native AI refused to release the owned idle hold') end
        record(s,'hold-suspended')
    end
    local state=tostring(s.npc:GetAIControllerComponent():GetCommandState(held.command))
    if active(state) then return false,'Waiting for the owned idle hold to stop' end
    if not terminal(state) then return false,'Owned idle hold state unavailable' end
    held.ready=true
    return true
end

function M.resumeHold(s)
    local held=s.suspendedHold
    if not held then return end
    if s.kind=='hold' and s.ticket==held.ticket and not s.command then
        -- If release never completed, keep ownership of that exact original
        -- command. Otherwise the next current decision creates a fresh hold at
        -- the actual stance, or proceeds directly to the newly requested move.
        s.command=not held.ready and held.command or nil
        s.issued=not held.ready
        s.feedback={}
    end
    s.suspendedHold=nil
    record(s,'hold-resumed')
end

function M.release(s)
    M.resumeHold(s)
    local released=cancel(s)
    local lookReleased,lookError=clearLook(s)
    s.lookError=not lookReleased and lookError or nil
    if released then
        s.feedback={}; s.issued=false
        s.blockedReason,s.blockedHolding,s.routeCheckedAt=nil,nil,nil
        s.routeProbe,s.candidateIndex,s.clearanceWaiting,s.clearanceHolding=nil,nil,nil,nil
        s.execution,s.executionTarget,s.detourSearch,s.blockedContext=nil,nil,nil,nil
        s.nativeRetryAt=nil
        s.nativeLegFailures=0
        s.recoveryTicket,s.completedEscapeTicket=nil,nil
        s.destinationProjection=nil
        s.followAdmission=nil
        s.lastRejection=nil
    end
    return released and lookReleased
end
function M.abandon(s)
    s.command,s.npc,s.look=nil,nil,nil
    s.cancellation=nil
    s.suspendedHold=nil
    s.lookStyle,s.lookHeight,s.lookStrength,s.lookSeated='none',nil,nil,nil
    s.lookRemoveRetryAt,s.lookRemoveError=nil,nil
    s.seatedAttention=nil
    s.blockedReason,s.blockedHolding,s.routeCheckedAt=nil,nil,nil
    s.sensedPosition,s.motionDirection=nil,nil
    s.routeProbe,s.candidateIndex,s.clearanceWaiting,s.clearanceHolding=nil,nil,nil,nil
    s.execution,s.executionTarget,s.detourSearch,s.blockedContext=nil,nil,nil,nil
    s.nativeRetryAt=nil
    s.nativeLegFailures=0
    s.recoveryTicket,s.completedEscapeTicket=nil,nil
    s.destinationProjection=nil
    s.followAdmission=nil
    s.lastRejection=nil
    s.feedback={}; s.issued=false
end
function M.ownsTravel(s,command)
    local travel=s.kind=='move' or s.kind=='follow' and s.execution and s.stage=='walking-leg'
    return travel and not s.face and s.command and command
        and s.command.id~=nil and s.command.id==command.id
end

function M.sense(s,at,speed,dt)
    s.clock=s.clock+dt
    if s.sensedPosition and space.ground(s.sensedPosition,at)>0.02 then
        s.motionDirection=space.bearing(s.sensedPosition,at)
    elseif speed<0.18 then s.motionDirection=nil end
    s.sensedPosition=space.copy(at)
    local f={ticket=s.ticket,kind=s.kind,target=s.target and space.copy(s.target),
        age=s.clock-(s.issuedAt or s.clock),stage=s.stage,waiting=not s.issued,
        commands=s.commands,error=s.error}
    f.rejection=s.lastRejection
    f.destinationProjection=s.destinationProjection
    f.afterEscape=s.completedEscapeTicket~=nil and s.completedEscapeTicket==s.ticket
    if s.execution then
        f.route={kind='waypoints',index=s.execution.index,total=#s.execution.points,
            mode=s.execution.mode,phase=s.execution.phase,target=s.executionTarget and space.copy(s.executionTarget)}
    elseif s.detourSearch then
        f.route={kind='detour-search',candidate=s.detourSearch.index,total=#s.detourSearch.candidates}
    elseif s.followAdmission then
        f.route={kind='follow-admission',phase=s.followAdmission.handoffPhase or 'preparing'}
        f.waiting,f.complete=true,false
    end
    if s.suspendedHold then
        f.state,f.stage,f.suspended='SuspendedForEquipment','equipment',true
        f.commandID=tonumber(s.suspendedHold.command.id)
        f.active,f.complete,f.failed=false,false,false
        s.feedback=f
        return f
    end
    if s.command then
        local ok,label=pcall(function() return tostring(s.npc:GetAIControllerComponent():GetCommandState(s.command)) end)
        f.state=ok and label or 'Unavailable'
        f.commandID=tonumber(s.command.id)
        f.active=ok and active(label) and true or false
        f.failed=not ok or label:find('Failure',1,true)~=nil
            or label:find('Cancelled',1,true)~=nil or label:find('Interrupted',1,true)~=nil
            or (label:find('NotExecuting',1,true)~=nil and f.age>1.5)
        f.complete=ok and stateName(label)=='Success'
        if s.execution and s.execution.index<#s.execution.points then f.complete=false end
        if s.execution and (s.execution.mode~='travel' or s.execution.phase=='handoff'
            or s.execution.phase=='orienting' or s.execution.following) then
            f.complete=false
        end
        if s.stage=='orient' then f.complete,f.failed=false,false end
        local progressTarget=s.executionTarget or s.target
        if (s.kind=='move' or s.execution) and s.stage~='orient' and progressTarget
            and space.ground(at,progressTarget)>0.8 then
            if not s.progress or space.ground(s.progress.position,at)>0.3 then
                s.progress={position=space.copy(at),at=s.clock}
            end
            f.stalled=f.active and s.clock-s.progress.at>2.8 and speed<0.2
        else s.progress=nil end
    elseif s.failed then f.failed=true; f.error=s.error end
    if s.blockedReason then
        -- A safety hold owns the body while the requested walking operation
        -- reports failure. It must never look like a successful arrival.
        f.failed,f.complete,f.blocked=true,false,true
        f.error=s.blockedReason
    end
    if s.clearanceWaiting then f.waiting,f.complete,f.failed=true,false,false end
    if s.cancellation then
        f.cancelling=true
        f.error=s.cancellation.error or 'Waiting for native movement cancellation'
    end
    s.feedback=f
    return f
end

local function bounded(value,low,high,fallback)
    return type(value)=='number' and value==value and value>=low and value<=high and value or fallback
end
local function look(s,style,player,settings,seated)
    seated=seated==true
    local height=bounded(settings and settings.eyeContactHeight,-0.10,0.10,0)
    local strength=bounded(settings and settings.headFollowStrength,0,1.5,1)
    if style=='none' and not s.look then return end
    if style~='none' and s.look and s.lookStyle==style and s.lookHeight==height
        and s.lookStrength==strength and s.lookSeated==seated then return end
    if style=='none' then
        local cleared,err=clearLook(s)
        if not cleared then error(err) end
        return
    end
    -- Prepare before retiring the old request. SetEntityTarget's third
    -- argument is targetOffsetEntity (local). Height must stay world-vertical,
    -- so use the provider's separate worldOffset rather than tilting with an
    -- attachment/camera. At zero, make exactly the accepted native request.
    local event=LookAtAddEvent.new()
    event:SetEntityTarget(player,CName.new('pla_default_tgt'),Vector4.new(0,0,0,0))
    if height~=0 then
        if not event.targetPositionProvider then error('Native eye-contact target provider unavailable') end
        event.targetPositionProvider:SetWorldOffset(Vector4.new(0,0,height,0))
    end
    event:SetStyle(Enum.new('animLookAtStyle','Normal'))
    event.bodyPart=CName.new('Eyes')
    event.request.limits.softLimitDegrees=style=='full' and 70 or 45
    event.request.limits.hardLimitDegrees=style=='full' and 120 or 100
    event.request.limits.backLimitDegrees=120
    event.request.limits.hardLimitDistance=5
    local head=LookAtPartRequest.new()
    head.partName,head.weight,head.suppress,head.mode=CName.new('Head'),(style=='full' and 0.18 or 0.05)*strength,1,0
    local parts={head}
    -- Native 2.31 ActivateReactionLookAt(inVehicle=true) omits Chest. A part's
    -- zero stiffness still admits it into the solver and can rotate the torso
    -- against the passenger animation's hand-on-knee constraints.
    if not seated then
        local chest=LookAtPartRequest.new()
        chest.partName,chest.weight,chest.suppress,chest.mode=CName.new('Chest'),0,0,0
        parts[#parts+1]=chest
    end
    event:SetAdditionalPartsArray(parts)
    local cleared,err=clearLook(s)
    if not cleared then error(err) end
    -- Claim before QueueEvent: a native exception may follow its side effect.
    -- A retry must retire this exact event before adding another.
    s.look=event
    local accepted=s.npc:QueueEvent(event)
    if accepted==false then error('Native look request refused') end
    s.lookStyle,s.lookHeight,s.lookStrength,s.lookSeated=style,height,strength,seated
end

-- This boundary cannot sense, cancel or issue any native locomotion command.
-- Vehicle seating owns the body while the same exact look owner follows V.
function M.applyLook(s,style,player,settings,seated)
    if style~='none' and s.clock<(s.lookRetryAt or 0) then return false,s.lookError end
    local ok,err=pcall(look,s,style,player,settings,seated)
    s.lookError=not ok and tostring(err) or nil
    if not ok then s.lookRetryAt=s.clock+3 end
    return ok,s.lookError
end

function M.applySeatedLook(s,c,dt)
    dt=math.max(0,tonumber(dt) or 0)
    s.clock=s.clock+dt
    local attention=s.seatedAttention or {stableFor=0}
    s.seatedAttention=attention
    local ready=c.ready==true and c.vehicle~=nil and c.seat~=nil
    local reason=c.reason or 'Wait for stable seating'
    if ready and c.seat=='seat_front_left' then
        local speed=bounded(c.speed,0,math.huge,nil)
        if not speed or speed>0.5 then ready=false; reason='Driver watches the road' end
    end
    if ready then
        if attention.vehicle~=c.vehicle or attention.seat~=c.seat then attention.stableFor=0
        else attention.stableFor=attention.stableFor+dt end
        attention.vehicle,attention.seat=c.vehicle,c.seat
    else
        attention.vehicle,attention.seat=nil,nil
        attention.stableFor=0
    end
    local style=ready and attention.stableFor>=0.5 and c.selected==true and 'full' or 'none'
    attention.phase=style=='full' and 'seated-attend' or 'seated-idle'
    attention.reason=style=='full' and 'Attend with eyes and head while seated'
        or (ready and attention.stableFor>=0.5 and 'No selected seated attention' or reason)
    attention.speed=c.speed
    return M.applyLook(s,style,c.player,c.gazeSettings,true)
end

local function routeClear(s,c,target,following,options)
    options=options or {}
    local requested=space.copy(target)
    local projection
    local function reject(reason,stage,metadata,leg)
        local probe=s.routeProbe
        local receipt=metadata or {}
        receipt.stage,receipt.leg=stage or 'navigation',leg
        receipt.at,receipt.ticket=s.clock,s.ticket
        receipt.origin=probe and space.copy(probe.origin) or receipt.origin or space.copy(c.position)
        receipt.target=probe and space.copy(probe.target) or receipt.target or space.copy(target)
        if projection then receipt.projection=projection end
        s.lastRejection=receipt
        s.routeProbe=nil
        return false,reason,nil,receipt
    end
    if following and not options.horizon and not options.resolved then
        -- V's root Z belongs to V's location. The radial endpoint can be on a
        -- different part of a sidewalk/kerb. Resolve that endpoint through the
        -- same bounded native navigation query used for ordinary side stances.
        local ok,found=pcall(function()
            return Game.GetAINavigationSystem():FindPointInSphereForCharacter(vector(requested),.55,s.npc)
        end)
        if not ok or not found or found.status~=Enum.new('worldNavigationRequestStatus','OK')
            or not clearance.isPoint(found.point) or space.distance(found.point,requested)>=.8 then
            s.routeProbe=nil
            return reject('No clear navigation route','projection',
                {geometryType='navigation-projection',unavailable=not ok,requested=requested,
                projectionRadius=.55,maxProjectionShift=.8,
                point=found and clearance.isPoint(found.point) and space.copy(found.point) or nil})
        end
        target=space.copy(found.point)
        projection={requested=requested,point=space.copy(target),radius=.55,maxShift=.8,
            shift=space.distance(requested,target),lateralShift=space.ground(requested,target)}
    end
    local probe=s.routeProbe
    if not probe or probe.following~=following or probe.horizon~=options.horizon
        or space.distance(probe.origin,c.position)>.02
        or (not options.stablePlayer and not following
            and (not probe.playerPosition or space.distance(probe.playerPosition,c.frame.position)>.02))
        or (not options.horizon and space.distance(probe.target,target)>(following and 1.5 or .01))
        or (options.horizon and space.angle(probe.goalDirection,space.bearing(c.position,target))>recoveryPolicy.headingChange) then
        probe={origin=space.copy(c.position),target=space.copy(target),following=following,at=s.clock,
            playerPosition=space.copy(c.frame.position),horizon=options.horizon,
            goalDirection=space.bearing(c.position,target),projection=projection}
        s.routeProbe=probe
    end
    probe.projection=projection
    if s.clock-probe.at>3 then
        -- A busy frame can age a partial receipt. Refresh it while held; quota
        -- pressure is never reported as a geometry/native command failure.
        s.routeProbe=nil
        return nil,nil,true
    end
    local clear,reason,deferred,rejection
    if not probe.body and not options.horizon then
        clear,reason,deferred,rejection=clearance.body(probe.target,s.clearance)
        if deferred then return nil,nil,true end
        if not clear then return reject(reason,'destination',rejection) end
        probe.body=true
    end
    if not probe.legs then
        local ok,route=pcall(function()
            return Game.GetAINavigationSystem():CalculatePathForCharacter(vector(probe.origin),vector(probe.target),0.3,s.npc)
        end)
        if not ok then return reject('The game could not verify the walking route','navigation',{unavailable=true}) end
        local points=route and route.path
        local direct=space.distance(probe.origin,probe.target)
        local allowance=following and math.max(12,direct) or 5
        local measured,length=pcall(function() return route:CalculateLength() end)
        if not points or #points==0 or #points>128 or not clearance.isPoint(points[#points])
            or space.distance(points[#points],probe.target)>=0.65
            or not measured or type(length)~='number' or not (length>=0 and length<direct+allowance) then
            return reject('No clear navigation route')
        end
        if options.horizon then
            local clipped,previous,remaining={},probe.origin,options.horizon
            for _,point in ipairs(points) do
                if not clearance.isPoint(point) then return reject('No clear navigation route') end
                local distance=space.distance(previous,point)
                local t=distance>.005 and math.min(1,remaining/distance) or 1
                local next={x=previous.x+(point.x-previous.x)*t,y=previous.y+(point.y-previous.y)*t,
                    z=previous.z+(point.z-previous.z)*t,w=1}
                clipped[#clipped+1]=next
                remaining=remaining-distance
                previous=point
                if remaining<=.005 then break end
            end
            points=clipped
            probe.target=space.copy(points[#points])
        end
        local previous=probe.origin
        local legs,boxes={},1
        local function leg(point,index)
            -- Equal first/last navmesh points need no extra native box.
            if space.distance(previous,point)>.005 then
                boxes=boxes+clearance.segmentBoxes(previous,point)
                legs[#legs+1]={from=space.copy(previous),to=space.copy(point),progress={},navPoint=index}
            end
            previous=point
        end
        for index,point in ipairs(points) do
            if not clearance.isPoint(point) then return reject('No clear navigation route') end
            if not following and math.abs(point.z-probe.origin.z)>1.4 then
                return reject('The local walking route leaves this floor','path',
                    {geometryType='floor',from=space.copy(probe.origin),to=space.copy(point),
                    rise=math.abs(point.z-probe.origin.z),allowedRise=1.4})
            end
            leg(point,index)
        end
        leg(probe.target)
        -- A single operation cannot retain an arbitrarily old clearance
        -- receipt. Larger/denser routes wait for a closer navigable approach.
        if boxes>64 then return reject('No clear navigation route','path',
            {geometryType='route-size',boxes=boxes,maxBoxes=64,from=space.copy(probe.origin),to=space.copy(probe.target)}) end
        probe.legs,probe.next=legs,1
    end
    -- V can move while a fixed local route spends several frames on physics.
    -- Recheck exclusion in Lua on EVERY continuation, without discarding the
    -- expensive verified prefix. These checks never grant movement by themselves.
    local margin=math.max(.75,(s.clearance and s.clearance.radius or .4)+.35)
    for index,leg in ipairs(probe.legs) do
        local distance=space.segmentDistance(c.frame.position,leg.from,leg.to)
        if c.playerGap>1 and distance<margin then
            return reject('The walking route crosses the player','player',
                {playerPosition=space.copy(c.frame.position),from=space.copy(leg.from),to=space.copy(leg.to),
                distance=distance,margin=margin,navPoint=leg.navPoint},index)
        end
    end
    if not probe.body then
        clear,reason,deferred,rejection=clearance.body(probe.target,s.clearance)
        if deferred then return nil,nil,true end
        if not clear then return reject(reason,'destination',rejection) end
        probe.body=true
    end
    while probe.next<=#probe.legs do
        local leg=probe.legs[probe.next]
        clear,reason,deferred,rejection=clearance.segment(leg.from,leg.to,s.clearance,leg.progress)
        if deferred then return nil,nil,true end
        if not clear then return reject(reason,'path',rejection,probe.next) end
        probe.next=probe.next+1
    end
    if probe.at<s.clock then
        -- A checked prefix can acquire a parked/moving obstacle while quota
        -- defers the suffix. Recheck the imminent 1.8 m in this actual update;
        -- checking only the two body endpoints admits that newly occupied leg.
        local remaining,previous=1.8,c.position
        for index,leg in ipairs(probe.legs) do
            if remaining<=.005 then break end
            local distance=space.distance(previous,leg.to)
            local t=distance>.005 and math.min(1,remaining/distance) or 1
            local point={x=previous.x+(leg.to.x-previous.x)*t,y=previous.y+(leg.to.y-previous.y)*t,
                z=previous.z+(leg.to.z-previous.z)*t,w=1}
            clear,reason,deferred,rejection=clearance.segment(previous,point,s.clearance)
            if deferred then return nil,nil,true end
            if not clear then
                if rejection then rejection.resumedPrefix=true end
                return reject(reason,'path',rejection,index)
            end
            remaining=remaining-distance
            previous=point
        end
        -- A resumed route rechecks both actual ends before movement can resume.
        clear,reason,deferred,rejection=clearance.body(c.position,s.clearance)
        if deferred then return nil,nil,true end
        if not clear then return reject(reason,'origin',rejection) end
        local currentTarget=options.horizon and probe.target or target
        clear,reason,deferred,rejection=clearance.body(currentTarget,s.clearance)
        if deferred then return nil,nil,true end
        if not clear then return reject(reason,'destination',rejection) end
        if not options.horizon and space.distance(probe.target,target)>.005 then
            local distance=space.segmentDistance(c.frame.position,probe.target,target)
            if c.playerGap>1 and distance<margin then
                return reject('The walking route crosses the player','player',
                    {playerPosition=space.copy(c.frame.position),from=space.copy(probe.target),to=space.copy(target),
                    distance=distance,margin=margin})
            end
            clear,reason,deferred,rejection=clearance.segment(probe.target,target,s.clearance)
            if deferred then return nil,nil,true end
            if not clear then return reject(reason,'connector',rejection) end
            probe.legs[#probe.legs+1]={from=space.copy(probe.target),to=space.copy(target),progress={}}
            probe.target=space.copy(target)
        end
    end
    s.routeProbe=nil
    return true,nil,nil,probe
end

local function validate(s,intent,c)
    local candidates={intent.goal}
    if not intent.face then
        for _,point in ipairs(c.alternatives or {}) do candidates[#candidates+1]=point end
    end
    for index=s.candidateIndex or 1,#candidates do
        local desired=candidates[index]
        local ok,found=pcall(function()
            return Game.GetAINavigationSystem():FindPointInSphereForCharacter(vector(desired),0.55,s.npc)
        end)
        if ok and found and found.status==Enum.new('worldNavigationRequestStatus','OK')
            and clearance.isPoint(found.point) then
            local p=space.copy(found.point)
            if space.distance(p,desired)<0.8 and math.abs(p.z-c.position.z)<1.2
                and space.clear(p,c.frame.position,c.others,c.id,intent.face and 0.95 or 0.9,s.clearance) then
                local clear,reason,deferred,route=routeClear(s,c,p,false)
                if deferred then s.candidateIndex=index; return nil,nil,true end
                if clear then s.candidateIndex=nil; return p,nil,nil,route end
            else
                local margin=math.max(intent.face and .95 or .9,(s.clearance and s.clearance.radius or .4)+.5)
                local playerDistance=space.ground(p,c.frame.position)
                local playerBlocked=space.distance(p,desired)<.8 and math.abs(p.z-c.position.z)<1.2
                    and playerDistance<margin
                s.lastRejection={stage=playerBlocked and 'player' or 'stance',
                    origin=space.copy(c.position),target=space.copy(desired),at=s.clock,ticket=s.ticket,
                    playerPosition=playerBlocked and space.copy(c.frame.position) or nil,
                    to=playerBlocked and space.copy(p) or nil,distance=playerBlocked and playerDistance or nil,
                    margin=playerBlocked and margin or nil}
            end
        else
            s.lastRejection={stage='navigation',unavailable=not ok,
                origin=space.copy(c.position),target=desired and space.copy(desired),at=s.clock,ticket=s.ticket}
        end
    end
    s.candidateIndex=nil
    return nil,'No clear local walking route'
end

local function submit(s,command)
    if not cancel(s) then return false end
    s.command=command -- Claim ownership before the native callback can run.
    local accepted=s.npc:GetAIControllerComponent():SendCommand(command)
    if accepted==false then s.command=nil; error('The native AI refused the movement command') end
    s.issued,s.issuedAt=true,s.clock
    s.commands=s.commands+1
    s.failed,s.error,s.progress=false,nil,nil
    record(s,'submit')
    return true
end

local function keepBlocked(s)
    if s.blockedHolding and s.command and s.clock-s.issuedAt<35
        and active(currentCommandState(s) or '') then return end
    if not cancel(s) then return end
    local reason=s.blockedReason
    local command=NewObject('AIHoldPositionCommand'); command.duration=40
    s.stage='blocked'
    if submit(s,command) then s.blockedHolding=true end
    s.failed,s.error=true,reason
end

local function followDistance(s,c)
    return math.max(1.7+math.floor(((c.slot or 1)-1)/2)*.3,
        (s.clearance and s.clearance.radius or .4)+1.1)
end
local function followGoal(s,c)
    -- A native follower stops outside V's body. Certify that free endpoint,
    -- not the occupied player centre (or a car immediately behind it).
    -- Match the native follower's radial stop. A lane/old gathering anchor
    -- would certify a different path than the AIFollowTargetCommand executes.
    local distance=followDistance(s,c)
    return space.offset(c.frame.position,space.bearing(c.position,c.frame.position),0,-distance)
end

local function detourCandidates(origin,target,rejection,dimensions,localPrefix)
    local direction=space.bearing(origin,target)
    local centre=rejection and rejection.center or origin
    local along=math.max(0,(centre.x-origin.x)*direction.x+(centre.y-origin.y)*direction.y)
    local gap=space.ground(origin,target)
    local radius=dimensions and dimensions.radius or .4
    local candidates={}
    -- Unknown obstacle dimensions are discovered by clearance, never guessed
    -- into a permit. Each candidate has a bounded escape and far-side bend.
    for _,width in ipairs({radius+1.1,radius+2.4,radius+4.2,radius+5.6}) do
        for _,advance in ipairs({3,6}) do
            for _,sign in ipairs({-1,1}) do
                local side=width*sign
                local candidate={space.offset(origin,direction,side,-.35),
                    space.offset(origin,direction,side,math.min(gap+1,along+advance))}
                if not localPrefix then candidate[#candidate+1]=space.copy(target) end
                candidates[#candidates+1]=candidate
            end
        end
    end
    return candidates
end

local function block(s,reason,c,target,following)
    s.routeProbe,s.candidateIndex,s.clearanceWaiting,s.clearanceHolding=nil,nil,nil,nil
    s.execution,s.executionTarget=nil,nil
    s.followAdmission=nil
    if not s.blockedReason then
        s.blockedReason=reason or 'The walking route is obstructed'
        record(s,'route-rejected')
    end
    if c and target and not s.blockedContext then
        local rejection=s.lastRejection
        s.blockedContext={origin=space.copy(c.position),target=space.copy(target),following=following,
            rejection=rejection,rejections={},nextCheck=s.clock+1,index=1,
            playerPosition=space.copy(c.frame.position),nextPlayerCheck=s.clock+1}
        if rejection and rejection.nativeLegFailure then
            s.nativeLegFailures=(s.nativeLegFailures or 0)+1
            s.blockedContext.retryAt=s.clock+math.min(6,s.nativeLegFailures*2)
            if rejection.geometry and rejection.geometry.center then
                s.blockedContext.rejections[1]=rejection.geometry
            end
        end
        if rejection and rejection.center then s.blockedContext.rejections[1]=rejection end
        if not s.face and rejection and rejection.group and rejection.stage=='path'
            and math.abs(target.z-c.position.z)<1.2 then
            local localPrefix=following or s.kind=='move' and not s.finish
            local mode=localPrefix and 'escape' or 'travel'
            local candidates=detourCandidates(c.position,target,rejection,s.clearance,localPrefix)
            if localPrefix and space.ground(c.position,rejection.center)>recoveryPolicy.nearObstacle then
                -- Approach only a freshly verified short horizon before a far
                -- obstacle. Do not walk an entire remote detour at escape pace.
                local direction=space.bearing(c.position,target)
                local along=(rejection.center.x-c.position.x)*direction.x+(rejection.center.y-c.position.y)*direction.y
                candidates={{space.offset(c.position,direction,0,math.min(recoveryPolicy.travelHorizon,math.max(.8,along-2)))}}
                mode='advance'
            end
            s.recoveryTicket=s.ticket
            s.detourSearch={origin=space.copy(c.position),target=space.copy(target),following=following,
                mode=mode,candidates=candidates,index=1,leg=1,legs={}}
            s.clearanceWaiting=true
        end
    end
    s.failed,s.error=true,s.blockedReason
    -- These copies have AIFollowerRole. Releasing our command alone would let
    -- native autonomous following walk through the rejected route anyway.
    keepBlocked(s)
end

local function waitForClearance(s)
    s.clearanceWaiting=true
    if s.clearanceHolding and s.command and s.clock-s.issuedAt<35
        and active(currentCommandState(s) or '') then return end
    if not cancel(s) then return end
    local command=NewObject('AIHoldPositionCommand'); command.duration=40
    s.stage='clearance-wait'
    if submit(s,command) then s.clearanceHolding=true; s.issued=false end
end

local function unblocked(s)
    s.blockedReason,s.blockedHolding,s.blockedContext,s.detourSearch=nil,nil,nil,nil
    s.clearanceWaiting,s.clearanceHolding,s.routeProbe,s.candidateIndex=nil,nil,nil,nil
    s.failed,s.error,s.issued=false,nil,false
end

local function execution(route,origin,target,following,mode)
    local points,previous={},space.copy(origin)
    for _,leg in ipairs(route.legs) do
        local distance=space.distance(previous,leg.to)
        if distance>.05 then
            local count=math.max(1,math.ceil(space.ground(previous,leg.to)/recoveryPolicy.planSpan),
                math.ceil(math.abs(previous.z-leg.to.z)/recoveryPolicy.planRise))
            local start=previous
            for index=1,count do
                local t=index/count
                points[#points+1]={x=start.x+(leg.to.x-start.x)*t,y=start.y+(leg.to.y-start.y)*t,
                    z=start.z+(leg.to.z-start.z)*t,w=1}
            end
        end
        previous=space.copy(leg.to)
    end
    if #points==0 or #points>96 then return nil end
    return {points=points,index=1,from=space.copy(origin),target=space.copy(target),following=following,
        mode=mode or 'travel',phase='moving'}
end

local function curved(route)
    for _,leg in ipairs(route.legs) do
        if space.segmentDistance(leg.to,route.origin,route.target)>.35 then return true end
    end
    return false
end

local function blockedRoute(s,intent,c,canPlan)
    keepBlocked(s)
    if not canPlan or s.cancellation then return false end
    local held=s.blockedContext
    if not held then return false end
    local desired=intent.kind=='follow' and followGoal(s,c) or intent.goal
    local search=s.detourSearch
    local localPrefix=search and (search.mode=='escape' or search.mode=='advance')
    if desired and ((not localPrefix and space.distance(held.target,desired)>1.5)
        or space.distance(held.origin,c.position)>(localPrefix and .02 or .75)) then
        -- Movement by V (not camera yaw) invalidates the rejected goal. The
        -- safety command remains owned until a replacement has been verified.
        s.nativeLegFailures=0
        unblocked(s); return true
    end
    if localPrefix and desired then
        -- The local escape geometry stays fixed while the distant group moves.
        -- Current V exclusion is checked separately for every retained leg.
        search.target,held.target=space.copy(desired),space.copy(desired)
    end
    local refreshPlayer=held.rejection and held.rejection.stage=='player'
    local refreshGeometry=held.rejection and held.rejection.geometryType~=nil
    local refreshDestination=held.following and held.rejection and held.rejection.stage=='destination'
    if not search and (refreshPlayer or refreshGeometry or refreshDestination) then
        if refreshPlayer and space.distance(held.playerPosition,c.frame.position)>.02
            or refreshGeometry and space.distance(held.origin,c.position)>.02 then
            -- A player crossing is geometry owned by V, not by the side goal.
            -- Small V moves can clear it without shifting that frozen goal by
            -- 1.5 m. Keep the exact hold and ticket until fresh admission.
            s.nativeLegFailures=0
            unblocked(s); return true
        end
        if not held.playerChecking and not held.geometryChecking and s.clock<held.nextPlayerCheck then return false end
        local clear,reason,deferred
        if intent.kind=='move' then
            local target
            target,reason,deferred=validate(s,intent,c)
            clear=target~=nil
        else clear,reason,deferred=routeClear(s,c,desired,true) end
        if deferred then
            held.playerChecking=refreshPlayer; held.geometryChecking=refreshGeometry or refreshDestination; s.clearanceWaiting=true
            return true
        end
        held.playerChecking,held.geometryChecking,s.clearanceWaiting=nil,nil,nil
        held.nextPlayerCheck=s.clock+1
        if clear then unblocked(s); return true end
        local rejection=s.lastRejection
        if rejection and (rejection.stage=='player' or rejection.geometryType
            or held.following and rejection.stage=='destination') then
            -- Native navigation itself may change while V and the goal stay
            -- still. Reverify at most once per second, preserving the hold.
            held.rejection,held.playerPosition,held.origin=rejection,space.copy(c.frame.position),space.copy(c.position)
        else
            -- A current physics/availability failure has its own recovery
            -- policy; do not keep labeling that new rejection as a V crossing.
            s.blockedContext=nil
            block(s,reason,c,desired,held.following)
        end
        return true
    end
    if not search then
        if held.rejection and held.rejection.nativeLegFailure and (s.nativeLegFailures or 0)<3 then
            if s.clock<held.retryAt then return false end
            -- A native leg can fail transiently while its geometry stays
            -- clear. Retry it at most twice, rebuilding all route checks.
            unblocked(s); return true
        end
        if s.clock<held.nextCheck then return false end
        held.nextCheck=s.clock+1
        if (held.unavailable or held.rejection and held.rejection.unavailable)
            and s.clock>=(s.nativeRetryAt or 0) then
            -- Native availability may recover without a geometry change.
            -- Preserve this backoff across attempts, and retry verification.
            s.nativeRetryAt=s.clock+5
            unblocked(s); return true
        end
        local rejection=held.rejections[held.index]
        if rejection then
            local clear,_,deferred=clearance.recheck(rejection)
            if deferred then held.nextCheck=s.clock; return true end
            held.index=held.index % #held.rejections+1
            if clear then s.nativeLegFailures=0; unblocked(s); return true end
        end
        return true
    end
    s.clearanceWaiting=true
    if c.speed>.4 then return true end -- finish the old command's physical stop
    local function nextCandidate(rejection)
        if rejection and rejection.unavailable then
            -- Losing the native adapter does not mean every geometric detour
            -- failed. Resume this search only after verification is available.
            s.detourSearch,s.clearanceWaiting=nil,nil
            held.unavailable=true; s.nativeRetryAt=s.clock+5
            return
        end
        if rejection and rejection.center and #held.rejections<17 then
            held.rejections[#held.rejections+1]=rejection
        end
        search.index,search.leg,search.legs=search.index+1,1,{}
        search.mapped=nil; s.routeProbe=nil
        if search.index>#search.candidates then
            s.detourSearch,s.clearanceWaiting=nil,nil
            s.lastRejection=held.rejection
            record(s,'detours-exhausted')
        end
    end
    if not search.originClear then
        local clear,reason,deferred,rejection=clearance.body(c.position,s.clearance)
        if deferred then return true end
        if not clear then
            if rejection then rejection.stage='origin'; s.lastRejection=rejection end
            s.detourSearch,s.clearanceWaiting=nil,nil
            held.rejection=s.lastRejection
            held.rejections=rejection and rejection.center and {rejection} or {}
            s.error=reason
            return true
        end
        search.originClear=true
    end
    local candidate=search.candidates[search.index]
    if not search.mapped then
        search.mapped={}
        for index,point in ipairs(candidate) do
            if search.mode=='travel' and index==#candidate then search.mapped[index]=space.copy(search.target)
            else
                local ok,found=pcall(function()
                    return Game.GetAINavigationSystem():FindPointInSphereForCharacter(vector(point),.55,s.npc)
                end)
                if not ok or not found or found.status~=Enum.new('worldNavigationRequestStatus','OK')
                    or not clearance.isPoint(found.point) or space.distance(found.point,point)>.8
                    or math.abs(found.point.z-search.origin.z)>1.2
                    or not space.clear(found.point,c.frame.position,c.others,c.id,.9,s.clearance) then
                    nextCandidate(not ok and {stage='navigation',unavailable=true} or nil); return true
                end
                search.mapped[index]=space.copy(found.point)
            end
        end
    end
    local anchor=search.leg==1 and search.origin or search.mapped[search.leg-1]
    local context={position=anchor,frame=c.frame,playerGap=c.playerGap,others=c.others,id=c.id}
    local clear,reason,deferred,route=routeClear(s,context,search.mapped[search.leg],true,{stablePlayer=true,resolved=true})
    if deferred then return true end
    if not clear then nextCandidate(route); return true end
    for _,leg in ipairs(route.legs) do search.legs[#search.legs+1]=leg end
    search.leg=search.leg+1
    if search.leg<=#search.mapped then return true end
    local boxes,length=1,0
    for _,leg in ipairs(search.legs) do
        boxes=boxes+clearance.segmentBoxes(leg.from,leg.to)
        length=length+space.distance(leg.from,leg.to)
    end
    if boxes>64 or length>space.distance(search.origin,search.target)+16 then
        nextCandidate(); return true
    end
    local plan=execution({legs=search.legs},search.origin,search.target,search.following,search.mode)
    if not plan then nextCandidate(); return true end
    local target=space.copy(search.target)
    plan.rejection=held.rejection
    unblocked(s)
    s.execution,s.target=plan,target
    record(s,'detour-ready')
    return true
end

local function watchRoute(s,c,canPlan)
    if not s.command or not s.feedback.active or s.clearanceWaiting
        or (s.stage~='walking' and s.stage~='following' and s.stage~='walking-leg') then return false end
    if s.clock>=(s.clearanceAt or 0) then
        s.clearanceAt=s.clock+0.2
        -- Check measured motion as well as the planned path: native avoidance
        -- and stop animations may stray from the route we accepted.
        if s.motionDirection and c.speed>0.18 then
            local distance=math.max(0.75,math.min(5,c.speed*0.65+0.35))
            if s.executionTarget then distance=math.min(distance,space.ground(c.position,s.executionTarget)+.15) end
            local ahead=space.offset(c.position,s.motionDirection,0,distance)
            local clear,reason,deferred,rejection=clearance.segment(c.position,ahead,s.clearance)
            if deferred then waitForClearance(s); return false end
            if not clear then
                if rejection then rejection.stage='motion'; s.lastRejection=rejection end
                block(s,reason,c,s.target or followGoal(s,c),s.kind=='follow'); return false
            end
        end
    end
    -- Waypoint execution already checks its certified corridor, current motion
    -- and every successor leg. Restarting a full path proof while those feet
    -- move invalidates it each frame and turns quota deferral into idle/run.
    if not s.execution and canPlan and s.clock>=(s.routeCheckedAt or 0)+0.8 then
        s.routeCheckedAt=s.clock
        local target=s.executionTarget or (s.kind=='follow' and followGoal(s,c) or s.target)
        local clear,reason,deferred,route=routeClear(s,c,target,s.kind=='follow' and not s.execution,
            {stablePlayer=s.execution~=nil})
        if deferred then waitForClearance(s)
        elseif not clear then block(s,reason,c,s.target or target,s.kind=='follow') end
        if clear and route.projection then
            s.destinationProjection,s.target=route.projection,space.copy(route.target)
            if route.projection.lateralShift>.02 then
                -- A radial follower cannot promise a laterally changed endpoint.
                -- The new point's clear route does not certify its old radial
                -- route. Retire that exact owner now, then keep a safety hold
                -- while the point coordinator awaits fresh admission/budget.
                s.execution=execution(route,c.position,route.target,true,'travel')
                if not s.execution then block(s,'The verified route exceeds bounded waypoint execution',c,route.target,true) end
                if s.execution then s.recoveryTicket=s.ticket;waitForClearance(s) end
            end
        end
        return true
    end
    return false
end

local function walk(s,intent,c)
    local cmd=NewObject('AIMoveToCommand')
    local waypoint=s.execution and s.executionTarget
    local final=not waypoint or s.execution.index==#s.execution.points
    cmd.movementTarget=position(waypoint or s.target)
    cmd.rotateEntityTowardsFacingTarget=not waypoint and intent.face==true
    if not waypoint and intent.face then local facing=AIPositionSpec.new(); facing:SetEntity(c.player); cmd.facingTarget=facing end
    -- Escape stays cautious; travel retains measured intent pace. Intermediate
    -- checkpoints are not new social arrivals, stop animations or facing requests.
    local gait=waypoint and s.execution.mode=='escape' and 'Walk' or intent.gait or 'Walk'
    cmd.movementType=Enum.new('moveMovementType',gait)
    cmd.desiredDistanceFromTarget=intent.face and 0.05 or 0.18
    cmd.finishWhenDestinationReached=not waypoint and intent.finish==true
        or waypoint and final and s.execution.mode=='travel' and not s.execution.following and intent.finish==true
    cmd.ignoreNavigation=false
    cmd.useStart=c.speed<0.18
    cmd.useStop=final and cmd.finishWhenDestinationReached
    s.gait,s.stage=gait,waypoint and 'walking-leg' or 'walking'; submit(s,cmd)
end

local function follow(s,intent,c)
    local command=NewObject('AIFollowTargetCommand')
    command.target=c.player;command.desiredDistance=followDistance(s,c);command.tolerance=.6
    command.movementType=Enum.new('moveMovementType',intent.gait or 'Run')
    command.matchSpeed=intent.gait=='Walk';command.teleport=false;command.stopWhenDestinationReached=false
    s.gait,s.stage=intent.gait,'following';return submit(s,command)
end

local function actualContext(s,c)
    local current={};for key,value in pairs(c) do current[key]=value end
    current.position=space.copy(s.npc:GetWorldPosition())
    current.frame={};for key,value in pairs(c.frame) do current.frame[key]=value end
    current.frame.position=space.copy(c.player:GetWorldPosition())
    current.playerGap=space.distance(current.position,current.frame.position)
    return current
end
local function samePosition(a,b)
    return a and b and a.x==b.x and a.y==b.y and (a.z or 0)==(b.z or 0)
end
local function rememberAdmission(s,plan,c,goal,target,route,horizon)
    plan.verifiedAdmission={clock=s.clock,origin=space.copy(c.position),player=space.copy(c.frame.position),
        goal=space.copy(goal),target=space.copy(target),route=route,horizon=horizon}
end
local function takeAdmission(s,plan,c,goal)
    local proof=plan.verifiedAdmission
    plan.verifiedAdmission=nil
    -- Cancellation may complete synchronously without changing this frame.
    -- Only that exact snapshot can reuse its already complete physics checks.
    if proof and proof.clock==s.clock and samePosition(proof.origin,c.position)
        and samePosition(proof.player,c.frame.position) and samePosition(proof.goal,goal) then return proof end
end

local function preserveOwner(s)
    local label=currentCommandState(s)
    -- Feedback is sampled before apply; native success can arrive between
    -- those calls. Unknown/cancelling handles retain exact ownership through
    -- cancel(), rather than overlapping a new hold or trusting a stale sample.
    if not label or not active(label) then waitForClearance(s) end
end

local function certifiedCorridor(plan,point,radius)
    local nearest=math.huge
    for _,leg in ipairs(plan.commandRoute or {}) do
        nearest=math.min(nearest,space.segmentDistance(point,leg.from,leg.to))
    end
    return nearest<=radius+.25
end

local function chooseWaypoint(plan,c,index)
    local horizon=plan.mode=='escape' and recoveryPolicy.escapeCommandSpan or recoveryPolicy.travelCommandSpan
    local selected=index
    for next=index+1,#plan.points do
        if space.ground(c.position,plan.points[next])>horizon then break end
        if math.abs(plan.points[next].z-c.position.z)>1.2 then break end
        selected=next
    end
    return selected
end

local function commitWaypoint(s,plan,intent,c,index,minimum)
    -- Preparation leaves an active current lease intact. Only a completely
    -- certified successor can begin retiring that exact native handle.
    local clear,reason,deferred,route
    if not plan.pendingIndex then
        if not plan.trialIndex then plan.trialIndex,plan.minimumIndex=index,minimum or index end
        index=plan.trialIndex
        local target=plan.points[index]
        clear,reason,deferred,route=routeClear(s,c,target,false,{stablePlayer=true})
        if deferred then preserveOwner(s);return true end
        if not clear then
            if index>plan.minimumIndex then
                plan.trialIndex=index-1
                preserveOwner(s)
                return true
            end
            plan.trialIndex,plan.minimumIndex=nil,nil
            if s.command and s.feedback.active and s.stage=='walking-leg' and plan.phase=='moving' then
                -- An early shortcut at a bend may be unsafe while the current
                -- certified leg remains safe. Finish it; do not cut the bend.
                plan.rollRetryAt=s.clock+.2
                preserveOwner(s)
                return true
            end
            block(s,reason,c,s.target,plan.following);return true
        end
        rememberAdmission(s,plan,c,target,target,route)
        plan.pendingIndex,plan.pendingPhase=index,'retiring'
    end
    index=plan.pendingIndex
    local target=plan.points[index]
    if plan.pendingPhase=='retiring' then
        if not cancel(s) then return true end
        plan.pendingPhase='admitting'
    elseif not cancel(s) then return true end -- retire only a temporary safety hold
    -- Cancellation can be asynchronous or invoke native callbacks. The prior
    -- preparation is not permission to move after it: reread actual feet/V and
    -- revalidate before committing. Quota deferral owns a safety hold.
    local current=actualContext(s,c)
    local proof=takeAdmission(s,plan,current,target)
    if proof then clear,route=true,proof.route
    else clear,reason,deferred,route=routeClear(s,current,target,false,{stablePlayer=true}) end
    if deferred then waitForClearance(s);return true end
    if not clear then block(s,reason,current,s.target,plan.following);return true end
    plan.index,plan.pendingIndex,plan.from=index,nil,space.copy(current.position)
    plan.pendingPhase=nil
    plan.trialIndex,plan.minimumIndex=nil,nil
    plan.commandRoute,plan.phase=route.legs,'moving'
    s.executionTarget,s.clearanceWaiting,s.clearanceHolding=space.copy(target),nil,nil
    s.routeCheckedAt=s.clock
    if plan.index==1 and not plan.orientationAt and current.speed<.18 and space.ground(current.position,target)>1
        and space.angle(current.direction,space.bearing(current.position,target))>100 then
        local command=NewObject('AIRotateToCommand')
        command.target=position(target);command.angleTolerance=8;command.angleOffset=0;command.speed=110
        plan.phase,plan.orientationAt='orienting',s.clock
        s.stage='orient';submit(s,command)
    else walk(s,intent,current) end
    return true
end

local function destination(s,plan,intent,c)
    local target=intent.kind=='follow' and followGoal(s,c) or intent.goal
    if intent.kind=='follow' then
        -- Recovery uses a bounded certified travel horizon when the group is
        -- remote. A moving far endpoint cannot starve several frames of quota,
        -- and only that verified prefix is granted to a movement command.
        local horizon=s.recoveryTicket==s.ticket
            and space.distance(c.position,target)>recoveryPolicy.travelHorizon and recoveryPolicy.travelHorizon or nil
        local clear,reason,deferred,route=routeClear(s,c,target,true,{horizon=horizon,stablePlayer=true})
        return clear and route.target or nil,reason,deferred,route,horizon
    end
    return validate(s,intent,c)
end

local function handoff(s,plan,intent,c,canPlan)
    -- The prefix owner remains active until preparation completes. Unexpected
    -- terminal success or exhausted quota instead keeps an owned safety hold.
    if not canPlan then preserveOwner(s);return false end
    local target,reason,deferred,route,horizon
    if not plan.handoffPhase then
        target,reason,deferred,route,horizon=destination(s,plan,intent,c)
        if deferred then preserveOwner(s);return true end
        if not target then block(s,reason,c,intent.kind=='follow' and followGoal(s,c) or intent.goal,plan.following);return true end
        rememberAdmission(s,plan,c,intent.kind=='follow' and followGoal(s,c) or intent.goal,target,route,horizon)
        plan.handoffPhase='retiring'
    end
    if plan.handoffPhase=='retiring' then
        if not cancel(s) then return true end
        plan.handoffPhase='admitting'
    elseif not cancel(s) then return true end -- stationary hold from a quota continuation
    local current=actualContext(s,c)
    local proof=takeAdmission(s,plan,current,intent.kind=='follow' and followGoal(s,current) or intent.goal)
    if proof then target,route,horizon=proof.target,proof.route,proof.horizon
    else target,reason,deferred,route,horizon=destination(s,plan,intent,current) end
    if deferred then waitForClearance(s);return true end
    if not target then block(s,reason,current,intent.kind=='follow' and followGoal(s,current) or intent.goal,plan.following);return true end
    if plan.mode=='escape' then s.completedEscapeTicket=s.ticket end
    s.followAdmission=nil
    s.execution,s.executionTarget,s.clearanceWaiting,s.clearanceHolding=nil,nil,nil,nil
    s.target=space.copy(horizon and followGoal(s,current) or target)
    s.destinationProjection=route.projection
    if horizon or curved(route) or route.projection and route.projection.lateralShift>.02 then
        s.execution=execution(route,current.position,s.target,plan.following,horizon and 'advance' or 'travel')
        if not s.execution then block(s,'The verified route exceeds bounded waypoint execution',current,target,plan.following);return true end
        s.recoveryTicket=s.ticket
        s.execution.rejection=plan.rejection
        return commitWaypoint(s,s.execution,intent,current,chooseWaypoint(s.execution,current,1),1)
    elseif intent.kind=='follow' then
        if follow(s,intent,current) then s.recoveryTicket=nil end
    else walk(s,intent,current) end
    record(s,'recovery-handoff')
    return true
end

local function execute(s,intent,c,canPlan)
    local plan=s.execution
    if not plan then return false end
    local desired=intent.kind=='follow' and followGoal(s,c) or intent.goal
    if desired and space.distance(desired,plan.target)>1.5 then
        if plan.mode=='escape' or plan.mode=='advance' then
            plan.target,s.target=space.copy(desired),space.copy(desired)
        else plan.refreshGoal=true end
    end
    if plan.phase=='handoff' then
        local monitored=watchRoute(s,c,false)
        if s.blockedReason then return monitored end
        return handoff(s,plan,intent,c,canPlan)
    end
    if plan.pendingIndex then
        if not canPlan then preserveOwner(s);return false end
        return commitWaypoint(s,plan,intent,c,plan.pendingIndex)
    end
    if plan.phase=='orienting' then
        if not canPlan then preserveOwner(s);return false end
        if space.angle(c.direction,space.bearing(c.position,s.executionTarget))>=25
            and s.clock-plan.orientationAt<=2.2 then preserveOwner(s);return false end
        if not cancel(s) then return false end
        s.issued=false;plan.phase='moving'
    elseif s.stage=='walking-leg' and s.command then
        if s.feedback.failed or s.feedback.stalled then
            s.lastRejection={stage='execution',nativeLegFailure=true,geometry=plan.rejection,
                origin=space.copy(c.position),target=space.copy(s.target),leg=plan.index,at=s.clock,ticket=s.ticket}
            block(s,'The owned detour leg did not complete',c,s.target,plan.following)
            return false
        end
        if stateName(s.feedback.state or '')=='Success' then
            if space.ground(c.position,s.executionTarget)>.65 then
                s.lastRejection={stage='execution',nativeLegFailure=true,geometry=plan.rejection,
                    origin=space.copy(c.position),target=space.copy(s.target),leg=plan.index,at=s.clock,ticket=s.ticket}
                block(s,'The detour command finished outside its verified waypoint',c,s.target,plan.following)
                return false
            end
            if plan.index==#plan.points then
                if plan.mode~='travel' or plan.following or not intent.finish then
                    plan.phase='handoff';return handoff(s,plan,intent,c,canPlan)
                end
                plan.complete=true;return false
            end
            if plan.refreshGoal then plan.phase='handoff';return handoff(s,plan,intent,c,canPlan) end
            plan.index=plan.index+1
            plan.from=space.copy(c.position)
            s.executionTarget,s.issued=nil,false
        else
            -- Native movement may replan even a short AIMoveTo. A replan is
            -- never allowed to cut across the certified corridor unnoticed.
            if not certifiedCorridor(plan,c.position,s.clearance and s.clearance.radius or .4) then
                s.lastRejection={stage='execution',nativeLegFailure=true,geometry=plan.rejection,
                    origin=space.copy(c.position),target=space.copy(s.target),leg=plan.index,at=s.clock,ticket=s.ticket}
                block(s,'Native steering left the verified detour corridor',c,s.target,plan.following)
                return false
            end
            local monitored=watchRoute(s,c,canPlan)
            if s.blockedReason or s.clearanceWaiting then return monitored end
            local gap=space.ground(c.position,s.executionTarget)
            if plan.index==#plan.points and gap<=.3 and (plan.mode~='travel' or plan.following or not intent.finish) then
                plan.phase='handoff';return handoff(s,plan,intent,c,canPlan) or monitored
            end
            if plan.index<#plan.points and gap<=recoveryPolicy.rollingGap and s.clock>=(plan.rollRetryAt or 0) then
                if plan.refreshGoal then plan.phase='handoff';return handoff(s,plan,intent,c,canPlan) or monitored end
                if canPlan then
                    return commitWaypoint(s,plan,intent,c,chooseWaypoint(plan,c,plan.index+1),plan.index+1) or monitored
                end
            end
            preserveOwner(s)
            return monitored
        end
    end
    if not canPlan then preserveOwner(s);return false end
    while plan.index<#plan.points and space.distance(c.position,plan.points[plan.index])<.22 do
        plan.index=plan.index+1
    end
    return commitWaypoint(s,plan,intent,c,chooseWaypoint(plan,c,plan.index),plan.index)
end

function M.apply(s,decision,c,canPlan)
    if s.suspendedHold then return false end
    local intent=decision.operation
    if not intent then return false end
    s.finish=intent.finish
    local style=decision.look or 'none'
    M.applyLook(s,style,c.player,c.gazeSettings)
    if intent.kind=='release' then
        if M.release(s) then s.ticket=intent.ticket; s.kind='release' end
        return false
    end
    if s.cancellation and not cancel(s) then return false end
    local changed=s.ticket~=intent.ticket
    if changed and intent.kind=='move' and not canPlan then
        -- Keep the last owned stance while this member waits its turn in the
        -- planning budget. An unowned gap would release AIFollowerRole.
        if not s.command or terminal(s.feedback.state or '') then
            local command=NewObject('AIHoldPositionCommand'); command.duration=40
            s.stage='planning-wait'; submit(s,command)
        elseif not s.blockedReason and (s.kind=='move' or s.kind=='follow') then
            watchRoute(s,c,false)
        end
        preserveOwner(s)
        return false
    end
    if changed then
        if not cancel(s) then return false end
        local recovering=s.recoveryTicket~=nil or s.execution~=nil
        s.ticket,s.kind,s.face=intent.ticket,intent.kind,intent.face
        s.issued,s.failed,s.error,s.stage=false,false,nil,nil
        s.blockedReason,s.blockedHolding,s.routeCheckedAt,s.clearanceAt=nil,nil,nil,nil
        s.routeProbe,s.candidateIndex,s.clearanceWaiting,s.clearanceHolding=nil,nil,nil,nil
        s.execution,s.executionTarget,s.detourSearch,s.blockedContext=nil,nil,nil,nil
        s.nativeLegFailures=0
        -- Carry only the need for bounded recovery admission through the
        -- settling hold/next departure. Commands and geometry are reset above.
        s.recoveryTicket=recovering and intent.ticket or nil
        s.completedEscapeTicket=nil
        s.destinationProjection=nil
        s.followAdmission=nil
        s.orientationAt=nil
        s.target=nil
    end
    if s.blockedReason and (intent.kind=='move' or intent.kind=='follow') then
        local planned=blockedRoute(s,intent,c,canPlan)
        if s.blockedReason then return planned end
        if s.execution then return execute(s,intent,c,canPlan) or planned end
        if planned then return true end -- verification restarts next planning turn
    end
    if s.execution then
        local planned=execute(s,intent,c,canPlan)
        if s.execution or s.blockedReason then return planned end
    end
    if s.followAdmission then
        return handoff(s,s.followAdmission,intent,c,canPlan or not s.issued)
    end
    if intent.kind=='hold' then
        if s.issued and not s.feedback.complete and not s.feedback.failed then return false end
        if not cancel(s) then return false end
        local command=NewObject('AIHoldPositionCommand'); command.duration=40
        s.stage='holding'; submit(s,command); return false
    end
    if intent.kind=='follow' then
        local planned=watchRoute(s,c,canPlan)
        if s.blockedReason then return planned end
        if planned and s.clearanceWaiting then return planned end
        if s.issued and s.feedback.failed then return false end
        if s.issued and s.feedback.active and (s.gait==intent.gait or s.clock-s.issuedAt<0.9) then return planned end
        if s.issued and s.clock-s.issuedAt<0.65 then return planned end
        -- Initial following remains prompt for the whole party. Its one route
        -- check belongs to the operation transition; ongoing checks and gait
        -- replacements use the shared planning budget.
        if not canPlan and s.issued then return planned end
        local transaction={mode='normal-follow',following=true,target=followGoal(s,c)}
        if not s.command then transaction.handoffPhase='admitting' end
        s.followAdmission=transaction
        return handoff(s,transaction,intent,c,canPlan or not s.issued)
    end
    if intent.kind=='turn' then
        if s.issued or s.failed then return false end
        if not cancel(s) then return false end
        local command=NewObject('AIRotateToCommand')
        command.target=position(intent.goal)
        command.angleTolerance=8; command.angleOffset=0; command.speed=95
        s.target,s.stage=space.copy(intent.goal),'turning'; submit(s,command); return false
    end
    if intent.kind~='move' then error('Unknown movement operation '..tostring(intent.kind)) end

    local planned=watchRoute(s,c,canPlan)
    if s.blockedReason then return planned end

    if s.stage=='orient' then
        local error=space.angle(c.direction,space.bearing(c.position,s.target))
        local started=s.orientationAt or s.issuedAt
        if (error<25 or s.clock-started>2.2) and canPlan then
            -- A parked vehicle may have moved into the route during the turn.
            local clear,reason,deferred=routeClear(s,c,s.target,false)
            s.routeCheckedAt=s.clock
            if deferred then waitForClearance(s)
            elseif not clear then block(s,reason,c,s.target,false)
            elseif cancel(s) then s.orientationAt=nil;walk(s,intent,c) end
            return true
        end
        preserveOwner(s)
        s.stage,s.orientationAt='orient',started
        return false
    end
    if s.issued and intent.finish then return planned end
    if s.failed then return planned end
    if s.issued then
        local age=s.clock-s.issuedAt
        local shifted=space.ground(s.target,intent.goal)
        if age<0.65 or (shifted<1.15 and s.gait==intent.gait and s.feedback.active) then return planned end
    end
    if not canPlan or planned then return planned end
    local target,err,deferred,route=validate(s,intent,c)
    s.routeCheckedAt=s.clock
    if deferred then waitForClearance(s); return true end
    if not target then block(s,err,c,intent.goal,false); return true end
    if not cancel(s) then return true end
    s.clearanceWaiting,s.clearanceHolding=nil,nil
    s.target,s.gait=target,intent.gait
    if not intent.face and curved(route) then
        s.execution=execution(route,c.position,target,false)
        if s.execution then s.recoveryTicket=s.ticket;return execute(s,intent,c,canPlan) end
        block(s,'The verified route exceeds bounded waypoint execution',c,target,false); return true
    end
    if not s.issued and intent.finish and not intent.face and c.speed<0.18
        and space.ground(c.position,target)>1.0
        and space.angle(c.direction,space.bearing(c.position,target))>100 then
        local command=NewObject('AIRotateToCommand')
        command.target=position(target); command.angleTolerance=8; command.angleOffset=0; command.speed=110
        s.orientationAt=s.clock
        s.stage='orient'; submit(s,command)
    else walk(s,intent,c) end
    return true
end
return M
