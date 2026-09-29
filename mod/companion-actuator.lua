-- Native execution boundary: one owned movement command and one look request.
-- A completed finite operation is never silently reissued while its feet coast.
local space=dofile('companion-space.lua')
local M={}
local function vector(p) return Vector4.new(p.x,p.y,p.z or 0,p.w or 1) end
local function position(p)
    local world=WorldPosition.new(); world:SetVector4(vector(p))
    local spec=AIPositionSpec.new(); spec:SetWorldPosition(world); return spec
end
local function active(label)
    return label:find('Executing',1,true) and not label:find('NotExecuting',1,true)
        or label:find('Enqueued',1,true)
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
    if s.command and s.npc and s.npc:IsAttached() then
        local ai=s.npc:GetAIControllerComponent()
        local ok,state=pcall(function() return tostring(ai:GetCommandState(s.command)) end)
        if ok and state:find('Enqueued',1,true) then ai:CancelCommand(s.command)
        elseif ok and active(state) then ai:StopExecutingCommand(s.command,true) end
    end
    s.command=nil
end
local function clearLook(s)
    if s.look and s.npc and s.npc:IsAttached() then
        pcall(function() LookAtRemoveEvent.QueueRemoveLookatEvent(s.npc,s.look) end)
    end
    s.look,s.lookStyle=nil,'none'
end
function M.suspendHold(s)
    local held=s.suspendedHold
    if not held then
        if s.kind~='hold' or not s.command then return false,'No owned idle hold to release' end
        held={command=s.command,ticket=s.ticket}
        s.suspendedHold=held
        s.command,s.issued=nil,false
        local ai=s.npc:GetAIControllerComponent()
        local state=tostring(ai:GetCommandState(held.command))
        local accepted
        if state:find('Enqueued',1,true) then accepted=ai:CancelCommand(held.command)
        elseif active(state) then accepted=ai:StopExecutingCommand(held.command,true) end
        if accepted==false then error('The native AI refused to release the owned idle hold') end
        record(s,'hold-suspended')
    end
    local state=tostring(s.npc:GetAIControllerComponent():GetCommandState(held.command))
    if active(state) then return false,'Waiting for the owned idle hold to stop' end
    if not (state:find('Success',1,true) or state:find('Failure',1,true)
        or state:find('Cancelled',1,true) or state:find('Interrupted',1,true)
        or state:find('NotExecuting',1,true)) then return false,'Owned idle hold state unavailable' end
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
    cancel(s); clearLook(s); s.feedback={}; s.issued=false
end
function M.abandon(s)
    s.command,s.npc,s.look=nil,nil,nil
    s.suspendedHold=nil
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
        f.complete=ok and (label:find('Success',1,true)~=nil or label:find('Succeeded',1,true)~=nil)
        if s.stage=='orient' then f.complete,f.failed=false,false end
        if s.kind=='move' and s.stage~='orient' and s.target and space.ground(at,s.target)>0.8 then
            if not s.progress or space.ground(s.progress.position,at)>0.3 then
                s.progress={position=space.copy(at),at=s.clock}
            end
            f.stalled=f.active and s.clock-s.progress.at>2.8 and speed<0.2
        else s.progress=nil end
    elseif s.failed then f.failed=true; f.error=s.error end
    s.feedback=f
    return f
end

local function look(s,style,player)
    if s.lookStyle==style then return end
    clearLook(s)
    if style=='none' then return end
    local event=LookAtAddEvent.new()
    event:SetEntityTarget(player,CName.new('pla_default_tgt'),Vector4.new(0,0,0,0))
    event:SetStyle(Enum.new('animLookAtStyle','Normal'))
    event.bodyPart=CName.new('Eyes')
    event.request.limits.softLimitDegrees=style=='full' and 70 or 45
    event.request.limits.hardLimitDegrees=style=='full' and 120 or 100
    event.request.limits.backLimitDegrees=120
    event.request.limits.hardLimitDistance=5
    local head,chest=LookAtPartRequest.new(),LookAtPartRequest.new()
    head.partName,head.weight,head.suppress,head.mode=CName.new('Head'),style=='full' and 0.18 or 0.05,1,0
    chest.partName,chest.weight,chest.suppress,chest.mode=CName.new('Chest'),0,0,0
    event:SetAdditionalPartsArray({head,chest})
    s.npc:QueueEvent(event); s.look,s.lookStyle=event,style
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
    cancel(s)
    s.command=command -- Claim ownership before the native callback can run.
    local accepted=s.npc:GetAIControllerComponent():SendCommand(command)
    if accepted==false then s.command=nil; error('The native AI refused the movement command') end
    s.issued,s.issuedAt=true,s.clock
    s.commands=s.commands+1
    s.failed,s.error,s.progress=false,nil,nil
    record(s,'submit')
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
    if style=='none' or s.clock>=(s.lookRetryAt or 0) then
        local ok,err=pcall(look,s,style,c.player)
        s.lookError=not ok and tostring(err) or nil
        if not ok then s.lookRetryAt=s.clock+3 end
    end
    if intent.kind=='release' then M.release(s); s.ticket=intent.ticket; s.kind='release'; return false end
    local changed=s.ticket~=intent.ticket
    if changed then
        cancel(s)
        s.ticket,s.kind,s.face=intent.ticket,intent.kind,intent.face
        s.issued,s.failed,s.error,s.stage=false,false,nil,nil
        s.target=nil
    end
    if intent.kind=='hold' then
        if s.issued and not s.feedback.complete and not s.feedback.failed then return false end
        local command=NewObject('AIHoldPositionCommand'); command.duration=40
        s.stage='holding'; submit(s,command); return false
    end
    if intent.kind=='follow' then
        if s.issued and s.feedback.failed then return false end
        if s.issued and s.feedback.active and (s.gait==intent.gait or s.clock-s.issuedAt<0.9) then return false end
        if s.issued and s.clock-s.issuedAt<0.65 then return false end
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
        local command=NewObject('AIRotateToCommand')
        command.target=position(intent.goal)
        command.angleTolerance=8; command.angleOffset=0; command.speed=95
        s.target,s.stage=space.copy(intent.goal),'turning'; submit(s,command); return false
    end
    if intent.kind~='move' then error('Unknown movement operation '..tostring(intent.kind)) end

    if s.stage=='orient' then
        local error=space.angle(c.direction,space.bearing(c.position,s.target))
        if error<25 or s.clock-s.issuedAt>2.2 then walk(s,intent,c) end
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
