-- Native execution boundary: one owned movement command and one look request.
-- A completed finite operation is never silently reissued while its feet coast.
local space=dofile('companion-space.lua')
local M={}
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
function M.new(npc)
    return {npc=npc,clock=0,issued=false,lookStyle='none',feedback={},commands=0,events={}}
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
    s.lookHeight,s.lookStrength=nil,nil
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
    if released then s.feedback={}; s.issued=false end
    return released and lookReleased
end
function M.abandon(s)
    s.command,s.npc,s.look=nil,nil,nil
    s.cancellation=nil
    s.suspendedHold=nil
    s.lookStyle,s.lookHeight,s.lookStrength='none',nil,nil
    s.lookRemoveRetryAt,s.lookRemoveError=nil,nil
    s.seatedAttention=nil
    s.feedback={}; s.issued=false
end
function M.ownsTravel(s,command)
    return s.kind=='move' and not s.face and s.command and command
        and s.command.id~=nil and s.command.id==command.id
end

function M.sense(s,at,speed,dt)
    s.clock=s.clock+dt
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
local function look(s,style,player,settings)
    local height=bounded(settings and settings.eyeContactHeight,-0.10,0.10,0)
    local strength=bounded(settings and settings.headFollowStrength,0,1.5,1)
    if style=='none' and not s.look then return end
    if style~='none' and s.look and s.lookStyle==style and s.lookHeight==height and s.lookStrength==strength then return end
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
    local head,chest=LookAtPartRequest.new(),LookAtPartRequest.new()
    head.partName,head.weight,head.suppress,head.mode=CName.new('Head'),(style=='full' and 0.18 or 0.05)*strength,1,0
    chest.partName,chest.weight,chest.suppress,chest.mode=CName.new('Chest'),0,0,0
    event:SetAdditionalPartsArray({head,chest})
    local cleared,err=clearLook(s)
    if not cleared then error(err) end
    -- Claim before QueueEvent: a native exception may follow its side effect.
    -- A retry must retire this exact event before adding another.
    s.look=event
    local accepted=s.npc:QueueEvent(event)
    if accepted==false then error('Native look request refused') end
    s.lookStyle,s.lookHeight,s.lookStrength=style,height,strength
end

-- This boundary cannot sense, cancel or issue any native locomotion command.
-- Vehicle seating owns the body while the same exact look owner follows V.
function M.applyLook(s,style,player,settings)
    if style~='none' and s.clock<(s.lookRetryAt or 0) then return false,s.lookError end
    local ok,err=pcall(look,s,style,player,settings)
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
    return M.applyLook(s,style,c.player,c.gazeSettings)
end

local function validate(s,intent,c)
    local nav=Game.GetAINavigationSystem()
    local candidates={intent.goal}
    if not intent.face then
        for _,point in ipairs(c.alternatives or {}) do candidates[#candidates+1]=point end
    end
    for _,desired in ipairs(candidates) do
        local found=nav:FindPointInSphereForCharacter(vector(desired),0.55,s.npc)
        if found and found.status==Enum.new('worldNavigationRequestStatus','OK') and found.point then
            local p=space.copy(found.point)
            if space.distance(p,desired)<0.8 and math.abs(p.z-c.position.z)<1.2
                and space.clear(p,c.frame.position,c.others,c.id,intent.face and 0.95 or 0.9) then
                local route=nav:CalculatePathForCharacter(vector(c.position),vector(p),0.3,s.npc)
                local points=route and route.path
                if points and #points>0 and space.distance(points[#points],p)<0.65
                    and route:CalculateLength()<space.distance(c.position,p)+5 then
                    local clear=true
                    for i=2,#points do
                        if math.abs(points[i].z-c.position.z)>1.4 then clear=false; break end
                        if c.playerGap>1.0 and space.segmentDistance(c.frame.position,points[i-1],points[i])<0.75 then
                            clear=false; break
                        end
                    end
                    if clear then return p end
                end
            end
        end
    end
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
    if changed then
        if not cancel(s) then return false end
        s.ticket,s.kind,s.face=intent.ticket,intent.kind,intent.face
        s.issued,s.failed,s.error,s.stage=false,false,nil,nil
        s.target=nil
    end
    if intent.kind=='hold' then
        if s.issued and not s.feedback.complete and not s.feedback.failed then return false end
        if not cancel(s) then return false end
        local command=NewObject('AIHoldPositionCommand'); command.duration=40
        s.stage='holding'; submit(s,command); return false
    end
    if intent.kind=='follow' then
        if s.issued and s.feedback.failed then return false end
        if s.issued and s.feedback.active and (s.gait==intent.gait or s.clock-s.issuedAt<0.9) then return false end
        if s.issued and s.clock-s.issuedAt<0.65 then return false end
        if not cancel(s) then return false end
        local command=NewObject('AIFollowTargetCommand')
        command.target=c.player
        command.desiredDistance=1.7+math.floor((c.slot-1)/2)*0.3
        command.tolerance=0.6
        command.movementType=Enum.new('moveMovementType',intent.gait or 'Run')
        command.matchSpeed=intent.gait=='Walk'
        command.teleport=false; command.stopWhenDestinationReached=false
        s.gait,s.stage=intent.gait,'following'; submit(s,command); return false
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

    if s.stage=='orient' then
        local error=space.angle(c.direction,space.bearing(c.position,s.target))
        if (error<25 or s.clock-s.issuedAt>2.2) and cancel(s) then walk(s,intent,c) end
        return false
    end
    if s.issued and intent.finish then return false end
    if s.failed then return false end
    if s.issued then
        local age=s.clock-s.issuedAt
        local shifted=space.ground(s.target,intent.goal)
        if age<0.65 or (shifted<1.15 and s.gait==intent.gait and s.feedback.active) then return false end
    end
    if not canPlan then return false end
    local target,err=validate(s,intent,c)
    if not target then s.failed,s.error=true,err; record(s,'route-rejected'); return true end
    if not cancel(s) then return true end
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
