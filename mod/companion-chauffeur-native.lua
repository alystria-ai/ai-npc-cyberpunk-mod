-- Cyberpunk 2.31 NPC vehicle-AI boundary. The coordinator owns a temporary driving
-- lease; this adapter never spawns, deletes, unlocks or persists a player car.
local M={}
local DRIVE_CLASS='AIVehicleDriveToPointAutonomousCommand'
local UPDATE_CLASS='AIDriveToPointAutonomousUpdate' -- measured RTTI name, not its script alias
local MAX_SPEED,MIN_DISTANCE=8.0,5.0
local function entityID(value)
    if not value or value.hash==nil then return nil end
    local text=tostring(value.hash)
    if text:match('^0+[uUlL]*$') then return nil end
    return text
end
local function mappinID(value)
    if not value or value.value==nil then return nil end
    local text=tostring(value.value)
    if text:match('^0+[uUlL]*$') then return nil end
    return text
end
local function enum(value,kind,name) return value==Enum.new(kind,name) end
local function system()
    return Game.GetScriptableSystemsContainer():Get(CName.new('AutoDriveSystem'))
end
local function mounted(player,api) return api.mounting({npc=player}) end
local function samePoint(a,b)
    return a and b and math.abs(a.x-b.x)<0.25 and math.abs(a.y-b.y)<0.25 and math.abs(a.z-b.z)<0.25
end
local function sameDestination(a,b)
    if not a or not b or a.id~=b.id or a.destinationType~=b.destinationType then return false end
    -- Quest markers may follow a moving objective. A manually placed marker
    -- must stay at its captured world location even if the game reuses its ID.
    return a.destinationType=='Quest' or (a.destinationType=='PlayerTracked'
        and samePoint(a.markerPosition,b.markerPosition))
end
local function terminal(state)
    return state=='Success' or state=='Failure' or state=='Cancelled'
        or state=='Interrupted' or state=='Detached'
end
local function stateName(value)
    local label=tostring(value)
    return label:match('^AICommandState%s*:%s*(%w+)%s*%(%d+%)$') or label
end
local function className(value) return value and NameToString(value:GetClassName()) end
local function commandID(handle)
    local value=handle and tonumber(handle.id)
    if value and value>=0 and value<4294967295 and value==math.floor(value) then return value end
end
local function liveCar(car)
    local entity=car and Game.FindEntityByID(car.entityID)
    if not entity or not entity:IsAttached() or not entity:IsVehicle() or not entity:IsPlayerVehicle()
        or entityID(entity:GetEntityID())~=car.id
        or (car.record and tostring(entity:GetRecordID())~=car.record) then return nil end
    return entity
end
function M.driveReceipt(operation)
    if not operation then return nil end
    local receipt=operation.driveReceipt
    if not receipt and operation.handle then
        local value=commandID(operation.handle)
        if value and className(operation.handle)==DRIVE_CLASS then
            receipt={id=value,class=DRIVE_CLASS}; operation.driveReceipt=receipt
        end
    end
    if receipt then return {id=receipt.id,class=receipt.class,cancelRequested=operation.cancelRequested==true,
        stopSubmissions=operation.stopSubmissions or receipt.stopSubmissions or 0} end
end
-- This is a fresh native observation, not a permission to adopt a command.
-- SetDriveToPointAutonomousUpdate has no handle parameter: its current command
-- must match our POST-SendCommand identity before every update.
function M.inspectDrive(car,operation)
    local ok,result=pcall(function()
        local entity=liveCar(car)
        if not entity then return {known=false,error='The borrowed car is unavailable.'} end
        local ai=entity:GetAIComponent()
        if not ai then return {known=false,error='Vehicle driving AI is unavailable.'} end
        local receipt=M.driveReceipt(operation)
        local current=ai:GetEnqueuedOrExecutingCommand(CName.new('AIVehicleCommand'),true)
        local direct=ai:GetEnqueuedOrExecutingCommand(CName.new(DRIVE_CLASS),false)
        local initial=ai:GetInitCmd()
        local function matches(handle)
            return receipt and handle and className(handle)==receipt.class and commandID(handle)==receipt.id
        end
        local executing=entity:IsExecutingAnyCommand()
        local automatic=entity:IsAutoDriveModeEnabled()
        local enabled=system():GetAutodriveEnabled()
        local commands=entity:CommandsFromDriverEnabled()
        local reservations=ai:GetReservedSeatsCount()
        if type(executing)~='boolean' or type(automatic)~='boolean' or type(enabled)~='boolean'
            or type(commands)~='boolean' or type(reservations)~='number' then
            return {known=false,error='Vehicle control information is unavailable.'}
        end
        local ownedActive=matches(direct)==true
        local foreign=current and not matches(current) or initial and not matches(initial)
            or automatic or enabled or executing and not ownedActive
        local status
        if operation then
            if operation.carId~=car.id or not receipt then
                return {known=false,error='The driving command identity is unavailable.'}
            end
            local handle=operation.handle or ownedActive and direct
            if handle and commandID(handle)==receipt.id and className(handle)==receipt.class then
                status=stateName(ai:GetCommandState(handle))
            elseif ai:IsCommandActive(receipt.id) then status='NotExecuting'
            else status='Cancelled' end
        end
        local result={known=true,ready=commands and not entity:IsPerformingSceneAnimation(),
            reservations=reservations,busy=current~=nil or initial~=nil or executing,
            foreign=foreign==true,ownedActive=ownedActive,state=status,
            commandId=receipt and receipt.id,currentId=commandID(current),currentClass=className(current),
            ai=ai,entity=entity}
        local telemetry,length,progress=pcall(function()
            return entity:GetCurrentSlotLocalPathLength(),entity:GetCurrentSlotLocalPathProgression()
        end)
        if telemetry and type(length)=='number' and type(progress)=='number' and length==length and progress==progress then
            result.remaining=math.max(0,length-progress)
        end
        return result
    end)
    return ok and result or {known=false,error=tostring(result)}
end
local function vehicleName(record,fallback)
    -- Installed Vehicle_Record.DisplayName() returns CName (unlike NPC record
    -- localization wrappers). Cosmetic lookup failure must not block an offer.
    local ok,text=pcall(function() return Game.GetLocalizedTextByKey(record:DisplayName()) end)
    if ok and type(text)=='string' and text~='' and not text:match('^LocKey') then return text end
    return fallback
end
local function routePosition(position)
    if not position then return nil end
    local result={}
    for _,key in ipairs({'x','y','z'}) do
        local value=position[key]
        if type(value)~='number' or value~=value or math.abs(value)>1e7 then return nil end
        result[key]=value
    end
    return result
end
local function destinationName(pin,isQuest)
    local fallback=isQuest and 'Selected quest destination' or 'Selected destination'
    local ok,name=pcall(function() return pin:GetDisplayName() end)
    if not ok or type(name)~='string' or name=='' then return fallback end
    if name:match('^LocKey') then
        local localized,text=pcall(function() return GetLocalizedText(name) end)
        if not localized or type(text)~='string' or text=='' or text:match('^LocKey') then return fallback end
        return text
    end
    return name
end
local function waypoint(auto,value,kind)
    -- The current native destination is authoritative for both a selected map
    -- pin and a tracked quest. Quest routes can have a zero manual tracker.
    local playerTracked=enum(kind,'gameAutodriveDestinationType','PlayerTracked')
    local questTracked=enum(kind,'gameAutodriveDestinationType','Quest')
    if not playerTracked and not questTracked then return nil end
    local maps=Game.GetMappinSystem()
    local id=mappinID(value)
    if not id then return nil end
    local pin=maps:GetMappin(value)
    if not pin then return nil end
    -- Identity is the selected mappin/type, not a frozen road projection. The
    -- native AI handler updates its target when GetAutodriveDestination()
    -- changes. Keep the marker separately to detect a moved manual map pin.
    local pos=routePosition(auto:GetAutodriveDestination())
    local marker=routePosition(pin:GetWorldPosition())
    if not pos or not marker then return nil end
    return {id=id,position=pos,name=destinationName(pin,questTracked),
        destinationType=questTracked and 'Quest' or 'PlayerTracked',markerPosition=marker}
end
function M.sample(player,entry,leasedCar,api,operation)
    local auto=system()
    local destinationId=auto:GetAutodriveDestinationMappinID()
    local destinationType=auto:GetAutodriveDestinationType()
    local actorId=entityID(entry.entityID)
    local sample={actor={serial=entry.serial,id=actorId,key=entry.profileKey,name=entry.name},
        playerId=entityID(player:GetEntityID()),waypoint=waypoint(auto,destinationId,destinationType)}
    local npc=entry.npc
    local owner=entry.system or Game.GetDynamicEntitySystem()
    sample.actorAttached=npc and npc:IsAttached() or false
    sample.actorDead=sample.actorAttached and npc:IsDeadNoStatPool() or false
    sample.actorValid=sample.actorAttached and not sample.actorDead
        and entityID(npc:GetEntityID())==actorId and owner and owner:IsReady()
        and owner:IsManaged(entry.entityID) and owner:IsTagged(entry.entityID,CName.new('CyberpunkConvaiCompanion')) or false
    sample.actorCalm=sample.actorValid and not NPCPuppet.IsInCombat(npc) or false
    if sample.actorAttached then sample.driverMount=api.mounting(entry) end
    sample.playerMount=mounted(player,api)
    sample.playerPassenger=enum(PlayerPuppet.GetCurrentVehicleState(player),'gamePSMVehicle','Passenger')
    sample.playerCombat=player:IsInCombat()
    local defs=Game.GetAllBlackboardDefs().VehicleSummonData
    local bb=Game.GetBlackboardSystem():Get(defs)
    local summoned=bb:GetEntityID(defs.SummonedVehicleEntityID)
    sample.summonedId=entityID(summoned)
    local summonState=bb:GetUint(defs.SummonState)
    -- vehicleSystem.script declares Idle=0, EnRoute=1; this blackboard is Uint.
    sample.summonEnRoute=tonumber(summonState)==1
    local target=leasedCar and leasedCar.entityID or summoned
    local car=entityID(target) and Game.FindEntityByID(target) or nil
    if car and car:IsAttached() and car:IsVehicle() then
        local record=car:GetRecord()
        local recordId=tostring(car:GetRecordID())
        sample.car={id=entityID(car:GetEntityID()),entityID=car:GetEntityID(),entity=car,owned=false,
            record=recordId,name=vehicleName(record,recordId)}
        sample.carValid=car:IsPlayerVehicle() and not car:IsDestroyed()
            and enum(record:Type():Type(),'gamedataVehicleType','Car')
        sample.info=api.inspect(sample.car)
        sample.drive=M.inspectDrive(sample.car,operation)
        local distanceTarget=sample.waypoint and sample.waypoint.position or operation and operation.target
        if distanceTarget then
            local position=routePosition(car:GetWorldPosition())
            local target=distanceTarget
            if position then sample.drive.distance=math.sqrt((position.x-target.x)^2
                +(position.y-target.y)^2+(position.z-target.z)^2) end
        end
    else sample.info={ready=false} end
    local vehicle=auto:GetAutodriveVehicle()
    sample.auto={enabled=auto:GetAutodriveEnabled(),delamain=auto:GetAutodriveIsDelamain(),
        vehicleId=vehicle and entityID(vehicle:GetEntityID()),available=auto:GetAutodriveAvailable(),
        laneValid=enum(auto:CheckCurrentLaneValidity(),'gameAutodriveLaneValidityResult','OnValidLane'),
        destinationId=mappinID(destinationId),
        playerTracked=enum(destinationType,'gameAutodriveDestinationType','PlayerTracked'),
        questTracked=enum(destinationType,'gameAutodriveDestinationType','Quest'),
        freeRoam=auto:GetFreeRoamEnabled(),remaining=auto:GetDistanceToCurrentDestination()}
    return sample
end
function M.start(player,entry,car,pin,seat,api)
    local sample=M.sample(player,entry,car,api)
    local pm,dm=sample.playerMount,sample.driverMount
    if not sample.actorValid or not sample.actorCalm or sample.playerCombat or not sample.carValid
        or not sample.info.ready or sample.info.scene
        or sample.summonedId~=car.id or not pm or pm.vehicle~=car.id or pm.seat~=seat
        or not sample.playerPassenger or not dm or dm.vehicle~=car.id or dm.seat~='seat_front_left'
        or not sameDestination(sample.waypoint,pin) or not samePoint(sample.waypoint.position,pin.position)
        or sample.auto.enabled or not sample.auto.laneValid or sample.auto.destinationId~=pin.id
        or not sample.drive or not sample.drive.known or not sample.drive.ready or sample.drive.foreign
        or sample.drive.busy or sample.drive.reservations~=0 then
        return nil,'The car, seats, road or destination changed before departure.'
    end
    if not NewObject(UPDATE_CLASS) then return nil,'Native destination updates are unavailable.' end
    local command=NewObject(DRIVE_CLASS)
    if not command then return nil,'Native NPC driving is unavailable.' end
    command.targetPosition=Vector3.new(pin.position.x,pin.position.y,pin.position.z)
    command.maxSpeed,command.minSpeed=MAX_SPEED,-1.0
    command.minimumDistanceToTarget,command.forcedStartSpeed=MIN_DISTANCE,-1.0
    command.needDriver,command.useKinematic=true,false
    command.clearTrafficOnPath,command.driveDownTheRoadIndefinitely=false,false
    local operation={handle=command:Copy(),ai=sample.drive.ai,owner=sample.drive.entity,
        carId=car.id,driverId=entityID(entry.entityID),playerId=sample.playerId,passengerSeat=seat,
        target={x=pin.position.x,y=pin.position.y,z=pin.position.z}}
    local ok,accepted=pcall(function() return operation.ai:SendCommand(operation.handle) end)
    operation.refused=ok and accepted==false
    operation.sendError=not ok and tostring(accepted) or nil
    -- Unsigned -1 (4294967295) is the constructor's unassigned sentinel.
    -- Capture identity only AFTER submission, including a throw after side effect.
    local receipt=M.driveReceipt(operation)
    if operation.refused and not receipt then return nil,'The native driving command was refused.' end
    return operation,operation.sendError or operation.refused and 'The native driving command was refused.' or nil
end
function M.retarget(operation,car,pin)
    local drive=M.inspectDrive(car,operation)
    if not drive.known or drive.foreign or not drive.ownedActive or terminal(drive.state)
        or drive.entity:IsPlayerDriver() or drive.entity:IsPerformingSceneAnimation() then
        return false,drive.error or 'The owned driving command is unavailable for a destination update.'
    end
    local player=Game.GetPlayer()
    if not player or entityID(player:GetEntityID())~=operation.playerId
        or not enum(PlayerPuppet.GetCurrentVehicleState(player),'gamePSMVehicle','Passenger') then
        return false,'V left the reserved passenger seat.'
    end
    local facility=Game.GetMountingFacility()
    for _,lease in ipairs({{seat='seat_front_left',occupant=operation.driverId},
        {seat=operation.passengerSeat,occupant=operation.playerId}}) do
        local slot=NewObject('gamemountingMountingSlotId'); slot.id=CName.new(lease.seat)
        local mount=facility:GetMountingInfoSingleWithIds(EntityID.new(),car.entityID,slot)
        if not mount or entityID(mount.childId)~=lease.occupant then return false,'The driver or passenger changed seats.' end
    end
    local point=pin and routePosition(pin.position)
    if not point then return false,'The selected destination is unavailable.' end
    local update=NewObject(UPDATE_CLASS)
    if not update then return false,'Native destination updates are unavailable.' end
    update.targetPosition=Vector4.new(point.x,point.y,point.z,1)
    update.maxSpeed,update.minSpeed=MAX_SPEED,-1.0
    update.minimumDistanceToTarget=MIN_DISTANCE
    update.clearTrafficOnPath,update.driveDownTheRoadIndefinitely=false,false
    drive.ai:SetDriveToPointAutonomousUpdate(update)
    operation.target=point
    return true
end
function M.stop(operation,car)
    if not operation then return true end
    local drive=M.inspectDrive(car,operation)
    if not drive.known then return false,drive.error end
    if drive.entity:IsPerformingSceneAnimation() then return false,'A scene has taken vehicle control.' end
    if terminal(drive.state) then return true end
    local receipt=M.driveReceipt(operation)
    local handle=operation.handle
    if not handle or commandID(handle)~=receipt.id or className(handle)~=receipt.class then
        return false,'The exact driving command could not be retired.'
    end
    if not drive.ownedActive then return false,'The exact driving command is no longer current.' end
    if not operation.stopAcknowledged then
        operation.stopSubmissions=operation.stopSubmissions or receipt.stopSubmissions or 0
        if operation.stopSubmissions>=3 then return false,'The owned driving command did not accept retirement.' end
        operation.stopSubmissions=operation.stopSubmissions+1
        operation.cancelRequested=true
        local ok,accepted=pcall(function()
            if drive.state=='Executing' then return drive.ai:StopExecutingCommand(handle,false) end
            return drive.ai:CancelCommand(handle)
        end)
        operation.stopAcknowledged=ok and accepted==true
        operation.stopError=not ok and tostring(accepted) or accepted~=true and 'Native retirement was not acknowledged.' or nil
    end
    local current=M.inspectDrive(car,operation)
    return current.known and terminal(current.state),current.error or operation.stopError
end
-- Kept only to retire pre-NPC-backend reload receipts. New trips never enable
-- or disable AutoDrive, and never borrow its arrival/toggle events.
function M.disable(player,car,pending,api)
    local auto=system()
    if auto:GetAutodriveEnabled() then
        local active=auto:GetAutodriveVehicle()
        if auto:GetAutodriveIsDelamain() or not active or entityID(active:GetEntityID())~=car.id then
            return false,'Another AutoDrive journey has control.'
        end
    elseif not pending then return true end
    -- A pending enable has no native receipt. Queue its disable behind it only
    -- while V is still in the exact leased car; never target another journey.
    if pending then
        local mount=mounted(player,api)
        if not mount or mount.vehicle~=car.id then return false,'Pending departure lost its vehicle binding.' end
    end
    system():QueueRequest(NewObject('DisableAutoDriveRequest'))
    return true
end
function M.brake(car,operation,expectedDriver)
    local drive=M.inspectDrive(car,operation)
    if not drive.known or drive.foreign then return false,drive.error or 'Another vehicle activity has control.' end
    local entity=drive.entity
    if entity:IsPlayerDriver() or entity:IsPerformingSceneAnimation() then return false,'V or a scene has taken vehicle control.' end
    local driver=operation and operation.driverId or expectedDriver
    if driver then
        local slot=NewObject('gamemountingMountingSlotId'); slot.id=CName.new('seat_front_left')
        local mount=Game.GetMountingFacility():GetMountingInfoSingleWithIds(EntityID.new(),car.entityID,slot)
        local occupant=mount and entityID(mount.childId)
        if occupant and occupant~=driver then return false,'Another driver has taken the car.' end
    end
    entity:ForceBrakesUntilStoppedOrFor(3.0)
    return true
end
return M
