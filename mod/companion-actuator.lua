-- Native execution boundary: one owned movement command and one look request.
-- A completed finite operation is never silently reissued while its feet coast.
local space=dofile('companion-space.lua')
local clearance=dofile('companion-clearance.lua')
local M={}
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
    if s.execution then
        f.route={kind='waypoints',index=s.execution.index,total=#s.execution.points,
            target=s.executionTarget and space.copy(s.executionTarget)}
    elseif s.detourSearch then
        f.route={kind='detour-search',candidate=s.detourSearch.index,total=#s.detourSearch.candidates}
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

local function routeClear(s,c,target,following)
    local function reject(reason,stage,metadata,leg)
        local probe=s.routeProbe
        local receipt=metadata or {}
        receipt.stage,receipt.leg=stage or 'navigation',leg
        receipt.at,receipt.ticket=s.clock,s.ticket
        receipt.origin,receipt.target=probe and space.copy(probe.origin),probe and space.copy(probe.target)
        s.lastRejection=receipt
        s.routeProbe=nil
        return false,reason,nil,receipt
    end
    local probe=s.routeProbe
    if not probe or probe.following~=following or space.distance(probe.origin,c.position)>.02
        or space.distance(probe.target,target)>(following and 1.5 or .01) then
        probe={origin=space.copy(c.position),target=space.copy(target),following=following,at=s.clock}
        s.routeProbe=probe
    end
    if s.clock-probe.at>3 then
        -- A busy frame can age a partial receipt. Refresh it while held; quota
        -- pressure is never reported as a geometry/native command failure.
        s.routeProbe=nil
        return nil,nil,true
    end
    local clear,reason,deferred,rejection
    if not probe.body then
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
        if not points or #points==0 or #points>128 or space.distance(points[#points],probe.target)>=0.65
            or not measured or type(length)~='number' or not (length>=0 and length<direct+allowance) then
            return reject('No clear navigation route')
        end
        local previous=probe.origin
        local legs,boxes={},1
        local function leg(point)
            -- Equal first/last navmesh points need no extra native box.
            if space.distance(previous,point)>.005 then
                boxes=boxes+clearance.segmentBoxes(previous,point)
                legs[#legs+1]={from=space.copy(previous),to=space.copy(point),progress={}}
            end
            previous=point
        end
        for _,point in ipairs(points) do
            if not clearance.isPoint(point) then return reject('No clear navigation route') end
            if not following and math.abs(point.z-probe.origin.z)>1.4 then
                return reject('The local walking route leaves this floor')
            end
            local margin=math.max(.75,(s.clearance and s.clearance.radius or .4)+.35)
            if c.playerGap>1 and space.segmentDistance(c.frame.position,previous,point)<margin then
                return reject('The walking route crosses the player','player')
            end
            leg(point)
        end
        leg(probe.target)
        -- A single operation cannot retain an arbitrarily old clearance
        -- receipt. Larger/denser routes wait for a closer navigable approach.
        if boxes>64 then return reject('No clear navigation route') end
        probe.legs,probe.next=legs,1
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
        clear,reason,deferred,rejection=clearance.body(target,s.clearance)
        if deferred then return nil,nil,true end
        if not clear then return reject(reason,'destination',rejection) end
        if space.distance(probe.target,target)>.005 then
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
                s.lastRejection={stage='stance',origin=space.copy(c.position),target=space.copy(desired),
                    at=s.clock,ticket=s.ticket}
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
        and not terminal(s.feedback.state or '') then return end
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

local function detourCandidates(origin,target,rejection,dimensions)
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
                candidates[#candidates+1]={space.offset(origin,direction,side,-.35),
                    space.offset(origin,direction,side,math.min(gap+1,along+advance)),space.copy(target)}
            end
        end
    end
    return candidates
end

local function block(s,reason,c,target,following)
    s.routeProbe,s.candidateIndex,s.clearanceWaiting,s.clearanceHolding=nil,nil,nil,nil
    s.execution,s.executionTarget=nil,nil
    if not s.blockedReason then
        s.blockedReason=reason or 'The walking route is obstructed'
        record(s,'route-rejected')
    end
    if c and target and not s.blockedContext then
        local rejection=s.lastRejection
        s.blockedContext={origin=space.copy(c.position),target=space.copy(target),following=following,
            rejection=rejection,rejections={},nextCheck=s.clock+1,index=1}
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
            s.detourSearch={origin=space.copy(c.position),target=space.copy(target),following=following,
                candidates=detourCandidates(c.position,target,rejection,s.clearance),index=1,leg=1,legs={}}
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
        and not terminal(s.feedback.state or '') then return end
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

local function execution(route,origin,target,following)
    local points,previous={},space.copy(origin)
    for _,leg in ipairs(route.legs) do
        local distance=space.distance(previous,leg.to)
        if distance>.05 then
            local count=math.max(1,math.ceil(space.ground(previous,leg.to)/1.8),
                math.ceil(math.abs(previous.z-leg.to.z)/.2))
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
    return {points=points,index=1,from=space.copy(origin),target=space.copy(target),following=following}
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
    if desired and (space.distance(held.target,desired)>1.5 or space.distance(held.origin,c.position)>.75) then
        -- Movement by V (not camera yaw) invalidates the rejected goal. The
        -- safety command remains owned until a replacement has been verified.
        s.nativeLegFailures=0
        unblocked(s); return true
    end
    local search=s.detourSearch
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
            if index==#candidate then search.mapped[index]=space.copy(search.target)
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
    local clear,reason,deferred,route=routeClear(s,context,search.mapped[search.leg],true)
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
    local plan=execution({legs=search.legs},search.origin,search.target,search.following)
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
    if canPlan and s.clock>=(s.routeCheckedAt or 0)+0.8 then
        s.routeCheckedAt=s.clock
        local target=s.executionTarget or (s.kind=='follow' and followGoal(s,c) or s.target)
        local clear,reason,deferred=routeClear(s,c,target,s.kind=='follow' and not s.execution)
        if deferred then waitForClearance(s)
        elseif not clear then block(s,reason,c,s.target or target,s.kind=='follow') end
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
    -- Walk through the bounded local detour. Stop only at the final stance;
    -- intermediate waypoints are not new social arrivals or facing requests.
    cmd.movementType=Enum.new('moveMovementType',waypoint and 'Walk' or intent.gait or 'Walk')
    cmd.desiredDistanceFromTarget=intent.face and 0.05 or 0.18
    cmd.finishWhenDestinationReached=waypoint~=nil or intent.finish==true
    cmd.ignoreNavigation=false
    cmd.useStart=c.speed<0.18
    cmd.useStop=final and (waypoint~=nil or intent.finish==true)
    s.stage=waypoint and 'walking-leg' or 'walking'; submit(s,cmd)
end

local function execute(s,intent,c,canPlan)
    local plan=s.execution
    if not plan then return false end
    local desired=intent.kind=='follow' and followGoal(s,c) or intent.goal
    if desired and space.distance(desired,plan.target)>1.5 then
        -- V has actually moved away. Keep the actuator owner while discarding
        -- the old frozen route, and validate a route to the new destination.
        if not cancel(s) then return false end
        s.execution,s.executionTarget=nil,nil
        s.issued,s.routeCheckedAt=false,nil
        return false
    end
    if s.stage=='orient' then
        if not canPlan then return false end
        if space.angle(c.direction,space.bearing(c.position,s.executionTarget))>=25
            and s.clock-s.issuedAt<=2.2 then return false end
        if not cancel(s) then return false end
        s.issued=false
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
            if plan.index==#plan.points then plan.complete=true; return false end
            plan.index=plan.index+1
            plan.from=space.copy(c.position)
            s.executionTarget,s.issued=nil,false
        else
            -- Native movement may replan even a short AIMoveTo. A replan is
            -- never allowed to cut across the certified corridor unnoticed.
            local margin=(s.clearance and s.clearance.radius or .4)+.25
            if space.segmentDistance(c.position,plan.from,s.executionTarget)>margin then
                s.lastRejection={stage='execution',nativeLegFailure=true,geometry=plan.rejection,
                    origin=space.copy(c.position),target=space.copy(s.target),leg=plan.index,at=s.clock,ticket=s.ticket}
                block(s,'Native steering left the verified detour corridor',c,s.target,plan.following)
                return false
            end
            return watchRoute(s,c,canPlan)
        end
    end
    if not canPlan then waitForClearance(s); return false end
    while plan.index<#plan.points and space.distance(c.position,plan.points[plan.index])<.22 do
        plan.index=plan.index+1
    end
    local target=plan.points[plan.index]
    -- Recheck the actual short route now, rather than reusing a multi-frame
    -- planner's earlier receipt. Moving and foreign cars remain collision groups.
    local clear,reason,deferred=routeClear(s,c,target,false)
    if deferred then waitForClearance(s); return true end
    if not clear then block(s,reason,c,s.target,plan.following); return true end
    if not cancel(s) then return true end
    s.clearanceWaiting,s.clearanceHolding=nil,nil
    s.executionTarget=space.copy(target)
    plan.from=space.copy(c.position)
    if plan.index==1 and c.speed<.18 and space.ground(c.position,target)>1
        and space.angle(c.direction,space.bearing(c.position,target))>100 then
        local command=NewObject('AIRotateToCommand')
        command.target=position(target); command.angleTolerance=8; command.angleOffset=0; command.speed=110
        s.stage='orient'; submit(s,command)
    else walk(s,intent,c) end
    return true
end

function M.apply(s,decision,c,canPlan)
    if s.suspendedHold then return false end
    local intent=decision.operation
    if not intent then return false end
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
        return false
    end
    if changed then
        if not cancel(s) then return false end
        s.ticket,s.kind,s.face=intent.ticket,intent.kind,intent.face
        s.issued,s.failed,s.error,s.stage=false,false,nil,nil
        s.blockedReason,s.blockedHolding,s.routeCheckedAt,s.clearanceAt=nil,nil,nil,nil
        s.routeProbe,s.candidateIndex,s.clearanceWaiting,s.clearanceHolding=nil,nil,nil,nil
        s.execution,s.executionTarget,s.detourSearch,s.blockedContext=nil,nil,nil,nil
        s.nativeLegFailures=0
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
        if not planned then
            local goal=followGoal(s,c)
            local clear,reason,deferred,route=routeClear(s,c,goal,true)
            s.routeCheckedAt=s.clock
            if deferred then waitForClearance(s); return canPlan end
            if not clear then block(s,reason,c,goal,true); return canPlan end
            if curved(route) then
                s.execution=execution(route,c.position,goal,true)
                if s.execution then s.target=space.copy(goal); return execute(s,intent,c,canPlan) end
                block(s,'The verified route exceeds bounded waypoint execution',c,goal,true); return canPlan
            end
        end
        if not cancel(s) then return canPlan end
        s.clearanceWaiting,s.clearanceHolding=nil,nil
        local command=NewObject('AIFollowTargetCommand')
        command.target=c.player
        command.desiredDistance=followDistance(s,c)
        command.tolerance=0.6
        command.movementType=Enum.new('moveMovementType',intent.gait or 'Run')
        command.matchSpeed=intent.gait=='Walk'
        command.teleport=false; command.stopWhenDestinationReached=false
        s.gait,s.stage=intent.gait,'following'; submit(s,command); return canPlan
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
        if (error<25 or s.clock-s.issuedAt>2.2) and canPlan then
            -- A parked vehicle may have moved into the route during the turn.
            local clear,reason,deferred=routeClear(s,c,s.target,false)
            s.routeCheckedAt=s.clock
            if deferred then waitForClearance(s)
            elseif not clear then block(s,reason,c,s.target,false)
            elseif cancel(s) then walk(s,intent,c) end
            return true
        end
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
        if s.execution then return execute(s,intent,c,canPlan) end
        block(s,'The verified route exceeds bounded waypoint execution',c,target,false); return true
    end
    if not s.issued and intent.finish and not intent.face and c.speed<0.18
        and space.ground(c.position,target)>1.0
        and space.angle(c.direction,space.bearing(c.position,target))>100 then
        local command=NewObject('AIRotateToCommand')
        command.target=position(target); command.angleTolerance=8; command.angleOffset=0; command.speed=110
        s.stage='orient'; submit(s,command)
    else walk(s,intent,c) end
    return true
end
return M
