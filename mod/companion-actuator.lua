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
    s.feedback={}; s.issued=false
end
function M.ownsTravel(s,command)
    return s.kind=='move' and not s.face and s.command and command
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
        if s.stage=='orient' then f.complete,f.failed=false,false end
        if s.kind=='move' and s.stage~='orient' and s.target and space.ground(at,s.target)>0.8 then
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
    local function reject(reason) s.routeProbe=nil; return false,reason end
    local probe=s.routeProbe
    if not probe or probe.following~=following or space.distance(probe.origin,c.position)>.35
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
    local clear,reason,deferred
    if not probe.body then
        clear,reason,deferred=clearance.body(probe.target,s.clearance)
        if deferred then return nil,nil,true end
        if not clear then return reject(reason) end
        probe.body=true
    end
    if not probe.legs then
        local ok,route=pcall(function()
            return Game.GetAINavigationSystem():CalculatePathForCharacter(vector(probe.origin),vector(probe.target),0.3,s.npc)
        end)
        if not ok then return reject('The game could not verify the walking route') end
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
            if not following and c.playerGap>1 and space.segmentDistance(c.frame.position,previous,point)<margin then
                return reject('The walking route crosses the player')
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
        clear,reason,deferred=clearance.segment(leg.from,leg.to,s.clearance,leg.progress)
        if deferred then return nil,nil,true end
        if not clear then return reject(reason) end
        probe.next=probe.next+1
    end
    if probe.at<s.clock then
        -- A resumed route rechecks both actual ends before movement can resume.
        clear,reason,deferred=clearance.body(c.position,s.clearance)
        if deferred then return nil,nil,true end
        if not clear then return reject(reason) end
        clear,reason,deferred=clearance.body(target,s.clearance)
        if deferred then return nil,nil,true end
        if not clear then return reject(reason) end
        if space.distance(probe.target,target)>.005 then
            clear,reason,deferred=clearance.segment(probe.target,target,s.clearance)
            if deferred then return nil,nil,true end
            if not clear then return reject(reason) end
        end
    end
    s.routeProbe=nil
    return true
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
        if ok and found and found.status==Enum.new('worldNavigationRequestStatus','OK') and found.point then
            local p=space.copy(found.point)
            if space.distance(p,desired)<0.8 and math.abs(p.z-c.position.z)<1.2
                and space.clear(p,c.frame.position,c.others,c.id,intent.face and 0.95 or 0.9,s.clearance) then
                local clear,reason,deferred=routeClear(s,c,p,false)
                if deferred then s.candidateIndex=index; return nil,nil,true end
                if clear then s.candidateIndex=nil; return p end
            end
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

local function block(s,reason)
    s.routeProbe,s.candidateIndex,s.clearanceWaiting,s.clearanceHolding=nil,nil,nil,nil
    if not s.blockedReason then
        s.blockedReason=reason or 'The walking route is obstructed'
        record(s,'route-rejected')
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

local function watchRoute(s,c,canPlan)
    if not s.command or not s.feedback.active or s.stage=='orient' or s.clearanceWaiting then return false end
    if s.clock>=(s.clearanceAt or 0) then
        s.clearanceAt=s.clock+0.2
        -- Check measured motion as well as the planned path: native avoidance
        -- and stop animations may stray from the route we accepted.
        if s.motionDirection and c.speed>0.18 then
            local distance=math.max(0.75,math.min(5,c.speed*0.65+0.35))
            local ahead=space.offset(c.position,s.motionDirection,0,distance)
            local clear,reason,deferred=clearance.segment(c.position,ahead,s.clearance)
            if deferred then waitForClearance(s); return false end
            if not clear then block(s,reason); return false end
        end
    end
    if canPlan and s.clock>=(s.routeCheckedAt or 0)+0.8 then
        s.routeCheckedAt=s.clock
        local target=s.kind=='follow' and c.frame.position or s.target
        local clear,reason,deferred=routeClear(s,c,target,s.kind=='follow')
        if deferred then waitForClearance(s)
        elseif not clear then block(s,reason) end
        return true
    end
    return false
end

local function walk(s,intent,c)
    local cmd=NewObject('AIMoveToCommand')
    cmd.movementTarget=position(s.target)
    cmd.rotateEntityTowardsFacingTarget=intent.face==true
    if intent.face then local facing=AIPositionSpec.new(); facing:SetEntity(c.player); cmd.facingTarget=facing end
    cmd.movementType=Enum.new('moveMovementType',intent.gait or 'Walk')
    cmd.desiredDistanceFromTarget=intent.face and 0.05 or 0.18
    cmd.finishWhenDestinationReached=intent.finish==true
    cmd.ignoreNavigation=false
    cmd.useStart=c.speed<0.18
    cmd.useStop=intent.finish==true
    s.stage='walking'; submit(s,cmd)
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
        s.target=nil
    end
    if intent.kind=='hold' then
        if s.issued and not s.feedback.complete and not s.feedback.failed then return false end
        if not cancel(s) then return false end
        local command=NewObject('AIHoldPositionCommand'); command.duration=40
        s.stage='holding'; submit(s,command); return false
    end
    if intent.kind=='follow' then
        if s.blockedReason then keepBlocked(s); return false end
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
            local clear,reason,deferred=routeClear(s,c,c.frame.position,true)
            s.routeCheckedAt=s.clock
            if deferred then waitForClearance(s); return canPlan end
            if not clear then block(s,reason); return canPlan end
        end
        if not cancel(s) then return canPlan end
        s.clearanceWaiting,s.clearanceHolding=nil,nil
        local command=NewObject('AIFollowTargetCommand')
        command.target=c.player
        command.desiredDistance=1.7+math.floor((c.slot-1)/2)*0.3
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

    if s.blockedReason then keepBlocked(s); return false end
    local planned=watchRoute(s,c,canPlan)
    if s.blockedReason then return planned end

    if s.stage=='orient' then
        local error=space.angle(c.direction,space.bearing(c.position,s.target))
        if (error<25 or s.clock-s.issuedAt>2.2) and canPlan then
            -- A parked vehicle may have moved into the route during the turn.
            local clear,reason,deferred=routeClear(s,c,s.target,false)
            s.routeCheckedAt=s.clock
            if deferred then waitForClearance(s)
            elseif not clear then block(s,reason)
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
    local target,err,deferred=validate(s,intent,c)
    s.routeCheckedAt=s.clock
    if deferred then waitForClearance(s); return true end
    if not target then block(s,err); return true end
    if not cancel(s) then return true end
    s.clearanceWaiting,s.clearanceHolding=nil,nil
    s.target,s.gait=target,intent.gait
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
