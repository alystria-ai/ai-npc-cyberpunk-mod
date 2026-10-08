-- Doors, lifts and floor changes between a companion and V.
-- Live reflection (2026-10-08, Codeware) on 2.31:
--   PlayerStateMachineDef.IsPlayerInsideElevator / IsPlayerInsideMovingElevator
--   are Bools on V's local PlayerStateMachine blackboard; inside is true only
--   in a lift car. Reading them is a blackboard lookup, no hook.
--   Door.whoOpened is V's handle after V walks through an AUTOMATIC door.
--   DoorControllerPS:ActionToggleOpen() queued through
--   PersistencySystem:QueuePSDeviceEvent opens a closed door; the door closes
--   itself again (automaticallyClosesItself). ActionDoorOpeningToken() returned
--   nil, so companions are not given opening tokens.
-- Every engine call is wrapped; an unavailable answer is never treated as
-- evidence that a door or lift is absent.
local M={}
M.policy={
    -- A door counts as "between" when it stands this close to the straight
    -- line from the companion to V.
    doorLane=4,doorRise=2.5,doorSearch=30,
    -- The same door is not reopened more often than this.
    doorReopen=6,
    -- Trail: V's recent footholds, used when no spot around V itself works
    -- (V standing in a lift car or a doorway with no navmesh underfoot).
    trailSpacing=1.5,trailLength=16,
}

local function ground(a,b) return math.sqrt((a.x-b.x)^2+(a.y-b.y)^2) end
local function copy(p) return {x=p.x,y=p.y,z=p.z} end

-- Plain V lift state: {inside=bool,moving=bool}, or nil when unreadable.
function M.liftState(player)
    local ok,inside,moving=pcall(function()
        local defs=Game.GetAllBlackboardDefs().PlayerStateMachine
        local board=Game.GetBlackboardSystem():GetLocalInstanced(player:GetEntityID(),defs)
        if not board then return nil end
        return board:GetBool(defs.IsPlayerInsideElevator)==true,
            board:GetBool(defs.IsPlayerInsideMovingElevator)==true
    end)
    if not ok or inside==nil then return nil end
    return {inside=inside,moving=moving==true}
end

-- Distance from point p to segment a-b on the ground plane.
function M.laneDistance(p,a,b)
    local dx,dy=b.x-a.x,b.y-a.y
    local length=dx*dx+dy*dy
    local t=length>1e-6 and math.max(0,math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/length)) or 0
    return math.sqrt((p.x-(a.x+dx*t))^2+(p.y-(a.y+dy*t))^2)
end

local function playerHash(player)
    local ok,value=pcall(function() return tostring(player:GetEntityID().hash) end)
    return ok and value or nil
end

-- The closest closed door V itself opened, standing between the companion
-- at `from` and V at `to`. Locked, sealed and lift doors are never chosen:
-- a lift door belongs to its car and V could not open the others either.
-- Returns door,info or nil,reason.
function M.findDoor(player,from,to)
    local own=playerHash(player)
    if not own then return nil,'player-unavailable' end
    local ok,parts=pcall(function()
        local query=TargetSearchQuery.new()
        query.testedSet=TargetingSet.Complete
        query.maxDistance=math.min(M.policy.doorSearch,ground(from,to)+4)
        query.filterObjectByDistance=true
        query.ignoreInstigator=true
        local _,found=Game.GetTargetingSystem():GetTargetParts(player,query)
        return found
    end)
    if not ok then return nil,'query-unavailable' end
    local best,bestInfo,bestDistance,skipped=nil,nil,math.huge,nil
    local seen={}
    for _,part in ipairs(parts or {}) do
        local read,door,info=pcall(function()
            local entity=part:GetComponent():GetEntity()
            if not entity or not entity:IsA('Door') then return nil end
            local id=tostring(entity:GetEntityID().hash)
            if seen[id] then return nil end
            seen[id]=true
            local at=entity:GetWorldPosition()
            if M.laneDistance(at,from,to)>M.policy.doorLane or math.abs(at.z-from.z)>M.policy.doorRise then return nil end
            local ps=entity:GetDevicePS()
            local row={id=id,position=copy(at),open=ps:IsOpen()==true,locked=ps:IsLocked()==true,
                sealed=ps:IsSealed()==true,lift=ps:IsLiftDoor()==true}
            local who=entity.whoOpened
            row.openedByV=who~=nil and tostring(who:GetEntityID().hash)==own
            return entity,row
        end)
        if read and door then
            if info.locked or info.sealed or info.lift or not info.openedByV then
                skipped=info.lift and 'lift-door' or info.locked and 'locked' or info.sealed and 'sealed' or 'not-opened-by-V'
            else
                local distance=ground(info.position,from)
                if distance<bestDistance then best,bestInfo,bestDistance=door,info,distance end
            end
        end
    end
    if best then return best,bestInfo end
    return nil,skipped or 'no-door'
end

-- Opens a closed door with the same ToggleOpen action V's interaction uses.
function M.openDoor(player,door)
    local ok,result=pcall(function()
        local ps=door:GetDevicePS()
        if ps:IsOpen() then return 'already-open' end
        if ps:IsLocked() or ps:IsSealed() then return 'locked' end
        local action=ps:ActionToggleOpen()
        if not action then return 'no-action' end
        action:SetExecutor(player)
        Game.GetPersistencySystem():QueuePSDeviceEvent(action)
        return 'opened'
    end)
    if not ok then return false,'unavailable' end
    return result=='opened' or result=='already-open',result
end

-- V's recent footholds, newest last. Points taken inside a lift car are
-- skipped: the car leaves with V.
function M.trailPush(trail,position,clock,excluded)
    if excluded then return end
    local last=trail[#trail]
    if last and ground(last,position)<M.policy.trailSpacing and math.abs(last.z-position.z)<.5 then return end
    trail[#trail+1]={x=position.x,y=position.y,z=position.z,at=clock}
    if #trail>M.policy.trailLength then table.remove(trail,1) end
end
-- Newest footholds on V's floor, between `near` and `far` metres from V.
function M.trailPoints(trail,position,near,far,limit)
    local result={}
    for index=#trail,1,-1 do
        local point=trail[index]
        local gap=ground(point,position)
        if math.abs(point.z-position.z)<1 and gap>=near and gap<=far then
            result[#result+1]=point
            if #result>=limit then break end
        end
    end
    return result
end
return M
