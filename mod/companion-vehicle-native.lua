-- Native boundary for the party vehicle controller. Never called on quest NPCs.
local placement=dofile('companion-placement.lua')
local clearance=dofile('companion-clearance.lua')
local M={}
function M.useSpatialBudget(value)
    clearance.useBudget(value)
    placement.useSpatialBudget(value)
end
local TAG='CyberpunkConvaiPartyVehicle'
local function id(value)
    if not value then return nil end
    local hash=tostring(value.hash)
    if hash:match('^0+[uUlL]*$') then return nil end
    return hash
end
local function name(value)
    return NameToString(value)
end
local function vector(x,y,z) return Vector4.new(x,y,z,1) end
local function speed(entity)
    local velocity=entity:GetLinearVelocity()
    return math.sqrt(velocity.x^2+velocity.y^2+velocity.z^2)
end
local function describe(entity)
    return {id=id(entity:GetEntityID()),entity=entity,entityID=entity:GetEntityID()}
end
function M.player(player)
    local mounted=M.mounting({npc=player})
    if not mounted then return nil end
    local entity=Game.FindEntityByID(mounted.parent)
    if not entity or not entity:IsAttached() or not entity:IsVehicle() or entity:IsDestroyed() then return nil end
    local kind=entity:GetRecord():Type():Type()
    if kind~=Enum.new('gamedataVehicleType','Car') and kind~=Enum.new('gamedataVehicleType','Bike') then return nil end
    return describe(entity)
end
function M.mounting(entry)
    if not entry.npc or not entry.npc:IsAttached() then return nil end
    local info=Game.GetMountingFacility():GetMountingInfoSingleWithObjects(entry.npc)
    local parent=info and id(info.parentId)
    if not parent then return nil end
    return {vehicle=parent,parent=info.parentId,seat=name(info.slotId.id)}
end
function M.inspect(vehicle)
    local entity=vehicle.entity
    if not entity and vehicle.system then
        entity=vehicle.system:GetEntity(vehicle.entityID)
        vehicle.entity=entity
    end
    if not entity or not entity:IsAttached() then return {ready=false} end
    vehicle.everAttached=true
    if not entity:IsVehicle() then return {ready=false,invalid=true} end
    local destroyed=entity:IsDestroyed()
    local record=entity:GetRecord()
    local package=record and record:VehDataPackage()
    local set=package and package:VehSeatSet()
    local records=set and set:VehSeats() or {}
    local seats={}
    local ai=entity:GetAIComponent()
    -- AMM GetVehicleSeats explicitly restricts this shared record to three
    -- slots. Panam and Claire appearances use the same vehicle record.
    local mackinaw=entity:GetRecordID()==TweakDBID.new('Vehicle.v_standard3_thorton_mackinaw_ncu_player')
    for _,seatRecord in ipairs(records) do
        local seatName=seatRecord:SeatName()
        if entity:HasOccupantSlot(seatName) and not (mackinaw and name(seatName)=='seat_back_right') then
            local slot=NewObject('gamemountingMountingSlotId'); slot.id=seatName
            -- Explicit empty child ID preserves the native optional-argument order.
            local info=Game.GetMountingFacility():GetMountingInfoSingleWithIds(
                EntityID.new(),entity:GetEntityID(),slot)
            seats[#seats+1]={name=name(seatName),occupant=info and id(info.childId),
                reserved=ai and ai:IsSeatReserved(seatName) or false}
        end
    end
    if vehicle.owned and not ai then return {ready=false,error='Native vehicle AI has not attached.'} end
    return {ready=true,seats=seats,speed=speed(entity),ai=ai,invalid=destroyed,
        playerGap=math.sqrt(entity:GetDistanceToPlayerSquared()),
        playerMounted=entity:IsPlayerMounted(),scene=entity:IsPerformingSceneAnimation()}
end
-- A pedestrian navigation point alone cannot establish clearance for a car.
-- Check a whole footprint on one floor, then a conservative 3.6 x 7.6 x 3.2 m
-- body volume. Native traffic routing owns the road path after this placement.
local function spawnPoint(primary,ordinal)
    local car=primary.entity
    if not car or not car:IsAttached() or speed(car)>0.8 then
        return nil,'Wait for your vehicle to stop before the next car joins.'
    end
    local origin,forward=car:GetWorldPosition(),car:GetWorldForward()
    local rotation=car:GetWorldOrientation()
    local spatial=Game.GetSpatialQueriesSystem()
    for _,back in ipairs({9,15,21,27}) do
        local along=-(back+(ordinal-1)*8)
        local center=vector(origin.x+forward.x*along,origin.y+forward.y*along,origin.z)
        local low,high,clear=nil,nil,true
        for _,offset in ipairs({{0,0},{-1.5,-3.3},{1.5,-3.3},{-1.5,3.3},{1.5,3.3}}) do
            local x=center.x-forward.y*offset[1]+forward.x*offset[2]
            local y=center.y+forward.x*offset[1]+forward.y*offset[2]
            local result
            for _,group in ipairs({'Static','Terrain'}) do
                if not clearance.take(1) then return nil,nil,true end
                local hit,trace=spatial:SyncRaycastByCollisionGroup(vector(x,y,origin.z+1.8),
                    vector(x,y,origin.z-2.0),group,false,false)
                if hit and trace and (not result or trace.position.z>result.position.z) then result=trace end
            end
            if not result or result.normal.z<0.92 then clear=false; break end
            local z=result.position.z
            low=math.min(low or z,z); high=math.max(high or z,z)
        end
        if clear and high-low<0.4 and math.abs(high-origin.z)<1.6 then
            local blocked=false
            for _,group in ipairs({'Static','Dynamic','Terrain','Collider','Destructible','Vehicle','Character'}) do
                if not clearance.take(1) then return nil,nil,true end
                if spatial:Overlap(vector(1.8,3.8,1.6),vector(center.x,center.y,high+1.85),
                    Quaternion.ToEulerAngles(rotation),CName.new(group)) then blocked=true; break end
            end
            if not blocked then return vector(center.x,center.y,high+0.35),rotation end
        end
    end
    return nil,'No clear, level vehicle space behind you. Stop on a wider road.'
end
function M.spawn(choice,player,primary,ordinal)
    local system=Game.GetDynamicEntitySystem()
    if not system or not system:IsReady() then return nil,'Vehicle world is not ready.' end
    local record=TweakDB:GetRecord(choice.record)
    if not record or not record:IsA('gamedataVehicle_Record') then return nil,'Vehicle record unavailable: '..choice.record end
    local position,rotation,deferred=spawnPoint(primary,ordinal)
    if deferred then return nil,nil,true end
    if not position then return nil,rotation end
    local spec=NewObject('DynamicEntitySpec')
    spec.recordID=TweakDBID.new(choice.record)
    if choice.appearance then spec.appearanceName=CName.new(choice.appearance) end
    spec.position,spec.orientation=position,rotation
    spec.active,spec.alwaysSpawned,spec.spawnInView=true,true,true
    spec.persistSpawn,spec.persistState=false,false
    spec.tags={CName.new(TAG)}
    local entityID=system:CreateEntity(spec)
    if not id(entityID) then return nil,'Could not create the party vehicle.' end
    return {id=id(entityID),entityID=entityID,system=system,owned=true,
        record=choice.record,appearance=choice.appearance,name=choice.name}
end
local function command(ai,handle,owner)
    local operation={ai=ai,handle=handle,owner=owner}
    -- Preserve the handle even when the binding throws after submission.
    local ok,accepted=pcall(function() return ai:SendCommand(handle) end)
    if not ok then operation.sendError=tostring(accepted) end
    if accepted==false then operation.refused=true end
    return operation
end
function M.mount(entry,vehicle,seat,unmount)
    local cmd=NewObject(unmount and 'AIUnmountCommand' or 'AIMountCommand')
    local data=NewObject('gameMountEventData')
    data.mountParentEntityId=vehicle.entityID
    data.slotName=CName.new(seat)
    data.isInstant=false
    data.setEntityVisibleWhenMountFinish=true
    data.removePitchRollRotationOnDismount=false
    data.ignoreHLS=false
    data.allowFailsafeTeleport=false
    data.mountEventOptions=NewObject('gameMountEventOptions')
    data.mountEventOptions.silentUnmount=false
    -- This ID describes an existing occupant for the stealing path, not the car.
    -- Seats are admitted only when empty; the actual car is mountParentEntityId.
    data.mountEventOptions.entityID=EntityID.new()
    data.mountEventOptions.alive=false
    data.mountEventOptions.occupiedByNonFriendly=false
    cmd.mountData=data
    return command(entry.npc:GetAIControllerComponent(),cmd:Copy(),entry.npc)
end
function M.canBoard(entry)
    if NPCPuppet.IsInCombat(entry.npc) then return false,'Waiting for combat to finish before boarding.' end
    -- Installed 2.31 ApproachVehicleDecorator refuses Alerted even when the
    -- puppet is not in combat. Repeated AIMount submissions cannot bypass it.
    -- Keep the exact animated command owner and wait for the native state to
    -- settle, rather than forcing a lower HLS or teleporting into the slot.
    local hls=entry.npc:GetHighLevelStateFromBlackboard()
    if hls==Enum.new('gamedataNPCHighLevelState','Alerted')
        or hls==Enum.new('gamedataNPCHighLevelState','Combat') then
        return false,'Waiting for your companion to settle before boarding.'
    end
    return true
end
function M.canResumeWalking(entry,vehicle,seat)
    if not entry.npc or not entry.npc:IsAttached() or entry.npc:IsDeadNoStatPool() then
        return false,'Waiting for the existing companion after vehicle exit.'
    end
    -- A mount link can disappear before the native door/exit workspot ends.
    -- Source: core/systems/workspotSystem.script; the existing reload cleanup
    -- uses this same IsActorInWorkspot gate before relinquishing the driver.
    if M.mounting(entry) then return false,'Waiting for the native vehicle mount to release.' end
    local inWorkspot=Game.GetWorkspotSystem():IsActorInWorkspot(entry.npc)
    if type(inWorkspot)~='boolean' then error('Vehicle exit workspot state is unavailable.') end
    if inWorkspot then return false,'Waiting for the native vehicle exit animation to finish.' end
    local info=vehicle and vehicle.info
    if info and info.ready then
        local actor=id(entry.entityID or entry.npc:GetEntityID())
        for _,slot in ipairs(info.seats or {}) do
            if slot.name==seat and slot.occupant==actor then
                return false,'Waiting for the native occupant slot to release.'
            end
        end
    end
    return true
end
local function stateName(value)
    local label=tostring(value)
    return label:match('^AICommandState%s*:%s*(%w+)%s*%(%d+%)$') or label
end
function M.commandState(operation)
    if operation.owner and not operation.owner:IsAttached() then return 'Detached' end
    if operation.refused then return 'Failure' end
    if operation.receipt then
        local receipt=operation.receipt
        if receipt.error then error(receipt.error) end
        local current=operation.ai:GetEnqueuedOrExecutingCommand(CName.new(receipt.class),false)
        if current and tonumber(current.id)==receipt.id then
            -- A newly acquired component supplies the current handle. Never
            -- reuse a command object captured before the loading transition.
            operation.handle=current
            return stateName(operation.ai:GetCommandState(current))
        end
        operation.handle=nil
        return operation.ai:IsCommandActive(receipt.id) and 'NotExecuting' or 'Cancelled'
    end
    return stateName(operation.ai:GetCommandState(operation.handle))
end
function M.cancel(operation)
    local state=M.commandState(operation)
    if state=='Success' or state=='Failure' or state=='Cancelled' or state=='Interrupted' or state=='Detached' then return true end
    if state~='Executing' and state~='Enqueued' and state~='NotExecuting' then return false end
    if not operation.handle then return false end
    if not operation.cancelRequested then
        operation.cancelRequested=true
        if state=='Executing' then operation.ai:StopExecutingCommand(operation.handle,true)
        else operation.ai:CancelCommand(operation.handle) end
    end
    state=M.commandState(operation)
    return state=='Success' or state=='Failure' or state=='Cancelled' or state=='Interrupted'
end
function M.commandReceipt(operation)
    if not operation then return nil end
    if operation.receipt then return operation.receipt end
    local ok,receipt=pcall(function()
        local commandID=tonumber(operation.handle.id)
        local class=NameToString(operation.handle:GetClassName())
        if not commandID or commandID<0 or type(class)~='string' or class=='' then
            error('The retiring native command could not be identified.')
        end
        return {id=commandID,class=class,cancelRequested=operation.cancelRequested==true}
    end)
    return ok and receipt or {error=tostring(receipt)}
end
function M.retiredCommand(receipt,owner,vehicle)
    if not receipt then return nil end
    return {receipt=receipt,owner=owner,cancelRequested=receipt.cancelRequested==true,
        ai=vehicle and owner:GetAIComponent() or owner:GetAIControllerComponent()}
end
function M.rebindVehicle(receipt,system)
    if receipt.owned and not system:IsManaged(receipt.entityID) then return nil end
    if receipt.owned and not receipt.deleteRequested
        and not system:IsTagged(receipt.entityID,CName.new(TAG)) then return nil end
    local entity
    if not receipt.deleteRequested then
        entity=receipt.owned and system:GetEntity(receipt.entityID) or Game.FindEntityByID(receipt.entityID)
    end
    return {id=receipt.id,entityID=receipt.entityID,owned=receipt.owned,system=receipt.owned and system or nil,
        entity=entity,record=receipt.record,appearance=receipt.appearance,name=receipt.name,
        ordinal=receipt.ordinal,driver=receipt.driver,everAttached=receipt.everAttached,
        deleteRequested=receipt.deleteRequested==true,
        pendingCommand=receipt.command,retired=true,createdAt=0,followAttempts=0}
end
function M.follow(vehicle,player,ordinal)
    local ai=vehicle.entity:GetAIComponent()
    if not ai then return nil,'This vehicle has no native driving AI.' end
    local cmd=NewObject('AIVehicleFollowCommand')
    cmd.target=player
    cmd.distanceMin=10+ordinal*8
    cmd.distanceMax=cmd.distanceMin+12
    cmd.stopWhenTargetReached=false
    cmd.needDriver=true
    cmd.useTraffic=true
    cmd.trafficTryNeighborsForStart=true
    cmd.trafficTryNeighborsForEnd=true
    cmd.useKinematic=false
    return command(ai,cmd:Copy(),vehicle.entity)
end
function M.brake(vehicle)
    if vehicle.owned and vehicle.entity and vehicle.entity:IsAttached() and not vehicle.entity:IsPlayerMounted() then
        vehicle.entity:ForceBrakesUntilStoppedOrFor(5)
        return true
    end
    return false
end
function M.destroy(vehicle)
    if not vehicle.owned or not vehicle.system then return false,'Unowned vehicle.' end
    if not vehicle.system:IsReady() then return false,'Vehicle world is not ready.' end
    if not vehicle.system:IsManaged(vehicle.entityID) then return true end
    if not vehicle.system:IsTagged(vehicle.entityID,CName.new(TAG)) then return false,'Vehicle ownership tag changed.' end
    -- Codeware returns true when despawn is accepted. The entity can remain
    -- managed for later frames, and its components may already be detaching.
    -- Poll only the system receipt once accepted; never resubmit or inspect
    -- the retiring vehicle handle while waiting for removal confirmation.
    if vehicle.deleteRequested then return false,'Waiting for the party car to finish despawning.' end
    local info=M.inspect(vehicle)
    if info.ready then
        if info.playerMounted then return false,'V is using this party vehicle.' end
        for _,seat in ipairs(info.seats) do if seat.occupant then return false,'A passenger remains in this car.' end end
    elseif vehicle.entity and vehicle.entity:IsAttached() then
        -- A destroyed but attached car can still contain occupants.
        if vehicle.entity:HasPassengers() then return false,'Passengers remain in the damaged car.' end
    elseif vehicle.everAttached then
        return false,'Vehicle detached before its occupants could be checked.'
    end
    if vehicle.system:DeleteEntity(vehicle.entityID)~=true then
        return false,'The game did not accept party car deletion.'
    end
    vehicle.deleteRequested,vehicle.retired=true,true
    if vehicle.system:IsReady() and not vehicle.system:IsManaged(vehicle.entityID) then return true end
    return false,'Waiting for the party car to finish despawning.'
end
function M.recover(entry,player,occupied)
    if not entry.npc or not entry.npc:IsAttached() or entry.npc:IsDeadNoStatPool() then
        return false,'The existing companion is not attached after fast travel.'
    end
    local point=player:GetWorldPosition()
    local forward=player:GetWorldForward()
    local lane=(entry.slot or 1)
    local side=lane%2==1 and -1.5 or 1.5
    local behind=1+math.floor((lane-1)/2)*1.2
    local desired=vector(point.x-forward.y*side-forward.x*behind,
        point.y+forward.x*side-forward.y*behind,point.z)
    local target,reason,deferred=placement.find(player,desired,occupied,entry.clearance)
    if deferred then return nil,nil,true end
    if not target then return false,reason end
    Game.GetTeleportationFacility():Teleport(entry.npc,target,Quaternion.ToEulerAngles(entry.npc:GetWorldOrientation()))
    occupied[#occupied+1]={position=target,clearance=entry.clearance}
    return true
end
return M
