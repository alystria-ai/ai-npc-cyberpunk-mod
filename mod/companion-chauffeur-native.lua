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
-- The car an immersive-invitation companion arrived in (docs/IMMERSIVE_INVITATIONS.md, "Her car"): a car the mod made for her, not one V
-- owns. convaiCompanionCar(profileKey) -> the live entity while it exists and stands near V; convaiCompanionCarIs(entity) -> whether an
-- entity is one of those cars. Both are nil while the setting is Off, so nothing else changes.
local function companionCarIs(entity)
    local check=convaiCompanionCarIs
    if type(check)~='function' then return false end
    local ok,result=pcall(check,entity)
    return ok and result==true
end
local function liveCar(car)
    local entity=car and Game.FindEntityByID(car.entityID)
    if not entity or not entity:IsAttached() or not entity:IsVehicle()
        or not (entity:IsPlayerVehicle() or (car.companionCar==true and companionCarIs(entity)))
        or entityID(entity:GetEntityID())~=car.id
        or (car.record and tostring(entity:GetRecordID())~=car.record) then return nil end
    return entity
end
-- The self-driving Delamain cab is the game's taxi, not a car V owns.
local function delamainCab(entity)
    local ok,found=pcall(function()
        local record=entity:GetRecordID()
        return record==TweakDBID.new('Vehicle.v_standard2_villefort_cortes_delamain_player')
            or record==TweakDBID.new('Vehicle.v_delamain_taxi')
    end)
    return ok and found==true
end
local function ownedCar(entity)
    if not entity or not entity:IsAttached() or not entity:IsVehicle() or not entity:IsPlayerVehicle()
        or entity:IsDestroyed() or delamainCab(entity) then return false end
    local record=entity:GetRecord()
    return record and enum(record:Type():Type(),'gamedataVehicleType','Car')
end
local function nearbyOwnedCar(player)
    -- The garage stores records, not live entity IDs. The native target parts
    -- include the attached player car restored from a save without a summon.
    local query=TSQ_ALL()
    query.testedSet=Enum.new('TargetingSet','Complete')
    query.maxDistance=20
    query.filterObjectByDistance=true
    query.ignoreInstigator=true
    query.includeSecondaryTargets=true
    local _,parts=Game.GetTargetingSystem():GetTargetParts(player,query)
    local candidates,seen={},{}
    local origin=player:GetWorldPosition()
    for _,part in ipairs(parts or {}) do
        local ok,entity=pcall(function()
            local component=TS_TargetPartInfo.GetComponent(part)
            local value=component and component:GetEntity()
            if not ownedCar(value) then return nil end
            local position=value:GetWorldPosition()
            local gap=math.sqrt((position.x-origin.x)^2+(position.y-origin.y)^2+(position.z-origin.z)^2)
            if gap==gap and gap<=20 then return value end
        end)
        local id=ok and entity and entityID(entity:GetEntityID())
        if id and not seen[id] then seen[id]=true; candidates[#candidates+1]=entity end
    end
    local ok,activeRecord=pcall(function()
        return tostring(Game.GetVehicleSystem():GetActivePlayerVehicle(Enum.new('gamedataVehicleType','Car')).recordID)
    end)
    local matching={}
    if ok then
        for _,entity in ipairs(candidates) do
            if tostring(entity:GetRecordID())==activeRecord then matching[#matching+1]=entity end
        end
    end
    if #matching==1 then return matching[1] end
    if #candidates==1 then return candidates[1] end
    return nil,#candidates>1 and 'ambiguous' or 'missing'
end
local function summonUnchanged(car,sample)
    local baseline=car and car.summonBaseline
    if baseline then
        return sample.summonedId==baseline.id and not (sample.summonEnRoute and baseline.state~=1)
    end
    -- Compatibility for an old explicitly summoned lease; a restored car gets
    -- its actual (possibly empty) baseline captured by queue before movement.
    return sample.summonedId==car.id and not sample.summonEnRoute
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
local function nameFrom(name,isQuest)
    local fallback=isQuest and 'Selected quest destination' or 'Selected destination'
    if type(name)~='string' or name=='' then return fallback end
    if name:match('^LocKey') then
        local localized,text=pcall(function() return GetLocalizedText(name) end)
        if not localized or type(text)~='string' or text=='' or text:match('^LocKey') then return fallback end
        return text
    end
    return name
end
local function destinationName(pin,isQuest)
    local ok,name=pcall(function() return pin:GetDisplayName() end)
    return nameFrom(ok and name or nil,isQuest)
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
    sample.summonState=tonumber(summonState)
    -- vehicleSystem.script declares Idle=0, EnRoute=1; this blackboard is Uint.
    sample.summonEnRoute=tonumber(summonState)==1
    local car
    if leasedCar then
        -- Never rediscover or change the borrowed car during an admitted trip.
        car=liveCar(leasedCar)
    elseif sample.playerMount and sample.playerMount.parent then
        -- Seated drive: V sits in a vehicle, so the only candidate is that exact vehicle, and only when it is one of V's own
        -- cars. No summon blackboard or nearby search can substitute another car for the one V is sitting in; a foreign
        -- vehicle, a bike or the Delamain cab leaves `car` nil and the offer says so.
        local seatedIn=Game.FindEntityByID(sample.playerMount.parent)
        if ownedCar(seatedIn) then car=seatedIn; sample.carSource='mounted' end
    else
        car=entityID(summoned) and Game.FindEntityByID(summoned) or nil
        if ownedCar(car) then sample.carSource='summoned'
        else
            car,sample.carSelectionError=nearbyOwnedCar(player)
            sample.carSource=car and 'nearby-owned' or nil
        end
        -- No car of V's own to use: the car this companion arrived in, while it stands near.
        if not car then
            local hook=convaiCompanionCar
            local called,found=false,nil
            if type(hook)=='function' then called,found=pcall(hook,entry.profileKey or entry.key) end
            if called and found and found:IsAttached() and found:IsVehicle() then
                car,sample.carSource,sample.carSelectionError=found,'companion',nil
            end
        end
    end
    if car and car:IsAttached() and car:IsVehicle() then
        local record=car:GetRecord()
        local recordId=tostring(car:GetRecordID())
        local hers=sample.carSource=='companion' or (leasedCar and leasedCar.companionCar==true) or nil
        sample.car={id=entityID(car:GetEntityID()),entityID=car:GetEntityID(),entity=car,owned=false,
            record=recordId,name=vehicleName(record,recordId),companionCar=hers}
        sample.carValid=(car:IsPlayerVehicle() or (hers and companionCarIs(car))) and not car:IsDestroyed()
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
        or not summonUnchanged(car,sample) or not pm or pm.vehicle~=car.id or pm.seat~=seat
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

-- Optional native path -----------------------------------------------------------------------
-- With the CyberpunkConvaiNative plugin loaded and its 'chauffeur' switch on, the two hot reads of a
-- leased trip run in C++ (native/core/src/systems/chauffeur): M.sample (80-120 CET calls, ten times a
-- second while a companion trip runs) becomes one plugin call plus about a dozen calls that stay in
-- Lua, and M.inspectDrive (about 30 calls, also behind retarget, stop and brake) becomes one plugin
-- call plus the entity lookup. Everything above is the original Lua and stays the fallback:
--   * kill switch: a line "chauffeur" in runtime/native-off.txt (the plugin re-reads it about once a
--     second; the CET console cannot reach convaiNative, each CET mod has its own environment);
--     three faults inside the plugin's natives also switch it off;
--   * only a sample for a LEASED car goes native (the start-of-trip selection of the owned car, with
--     its targeting query, stays Lua), and only for a companion the mod spawned: the entities are
--     always the ones the trip already holds;
--   * what stays in Lua on purpose: the blackboard summon reads, the mounting reads (the vehicles
--     plugin answers those), the car's display name (cached per record), the record-id check of the
--     lease, the localized waypoint name, and IsCommandActive;
--   * an answer of "", or one with a section the plugin could not read ("X !"), runs the original for
--     that call; 20 such answers in a row, or an unreadable answer, call convaiNative.fail('chauffeur',
--     ...) and this module stays on Lua for the session;
--   * the first VERIFY answers of each entry point run BOTH paths and compare them; any difference
--     calls convaiNative.fail and logs the first differing field to probe.log (the original's answer is
--     used). A line "chauffeur" in runtime/native-verify.txt compares every call (and so does the test
--     hook convaiNative.chauffeurVerify = true, set from Lua); convaiNative.chauffeurStats counts the calls.
-- Wire format: ChauffeurCore.hpp.
local NATIVE='chauffeur' -- the convaiNative system name (kill switch, probe.log)
local VERIFY=8
local EMPTY_LIMIT=20
local luaSample,luaInspectDrive=M.sample,M.inspectDrive
local STATE_NAMES={[0]='NotExecuting','Enqueued','Executing','Cancelled','Interrupted','Success','Failure'}
local DRIVE_ERRORS={[0]='Vehicle driving AI is unavailable.','Vehicle control information is unavailable.',
    'The driving command identity is unavailable.'}

local function bound(value) return type(value)=='table' or type(value)=='userdata' end
local nativeClass
local function resolve()
    if nativeClass then return nativeClass end
    local ok,class=pcall(function() return ConvaiNativeChauffeur end)
    if ok and bound(class) then nativeClass=class end
    return nativeClass
end
local function note(line)
    pcall(function()
        local file=io.open('runtime/probe.log','a')
        if file then file:write(os.date('!%Y-%m-%dT%H:%M:%SZ'),' ',line,'\n'); file:close() end
    end)
end
local function stats(api)
    local row=api.chauffeurStats
    if type(row)~='table' then
        row={native=0,lua=0,fallback=0,empty=0,emptySample=0,emptyDrive=0,verifiedSample=0,verifiedDrive=0,compared=0,
            mismatches=0}
        api.chauffeurStats=row
    end
    return row
end
-- The plugin writes hashes as plain decimal digits; CET prints them with a type suffix ("123ULL").
-- The suffix is read once from a real entity hash.
local suffix
local function idSuffix(entity)
    if suffix then return suffix end
    local ok,text=pcall(function() return tostring(entity:GetEntityID().hash) end)
    local found=ok and type(text)=='string' and text:match('^%d+([uUlL]*)$')
    if found then suffix=found end
    return suffix
end
local function plain(text)
    if text==nil then return nil end
    local digits=tostring(text):gsub('[uUlL]+$','')
    if digits:match('^%d+$') then return digits end
end
local function number(token)
    if token=='nan' then return 0/0 end
    if token=='inf' then return math.huge end
    if token=='-inf' then return -math.huge end
    return tonumber(token)
end
local function words(text)
    local list={}
    for token in text:gmatch('%S+') do list[#list+1]=token end
    return list
end
local function sameNumber(a,b)
    if a~=a and b~=b then return true end
    if a==b then return true end
    if type(a)~='number' or type(b)~='number' or a~=a or b~=b then return false end
    return math.abs(a-b)<=1e-9*(1+math.abs(a))
end
local function flagOf(token) if token=='1' then return true elseif token=='0' then return false end end

-- The plugin, when it is on for this call; else nil (the caller runs the original).
local function active()
    local api=convaiNative
    if type(api)~='table' or type(api.use)~='function' or api.use(NATIVE)~=true then return nil end
    local class=resolve()
    if not class then api.fail(NATIVE,'ConvaiNativeChauffeur is not registered'); return nil end
    return api,class
end
-- The run of empty answers is counted per entry point: a good drive answer must not hide a sample that
-- never gets answered.
local function empty(api,row,name,key)
    row.empty=row.empty+1
    row[key]=row[key]+1
    if row[key]>=EMPTY_LIMIT then api.fail(NATIVE,name..' keeps answering unavailable') end
end
local function unreadable(api,row,name,text)
    api.fail(NATIVE,name..': unreadable reply '..tostring(text))
    row.fallback=row.fallback+1
end

-- ---- decoding ----------------------------------------------------------------------------------
-- "D ..." fields (the tokens after the tag) as the drive table the original builds, without the
-- game objects; nil when unreadable. state '?' means IsCommandActive still has to be asked.
local function decodeDrive(t)
    local status=tonumber(t[1])
    if status and status<=2 and #t==1 then return {known=false,error=DRIVE_ERRORS[status]} end
    if status~=3 or #t~=11 then return nil end
    local ready,busy,foreign,owned=flagOf(t[2]),flagOf(t[4]),flagOf(t[5]),flagOf(t[6])
    local reservations=number(t[3])
    if ready==nil or busy==nil or foreign==nil or owned==nil or not reservations then return nil end
    local drive={known=true,ready=ready,reservations=reservations,busy=busy,foreign=foreign,ownedActive=owned}
    local state=t[7]
    if state=='?' then drive.pendingState=true
    elseif state~='-' then
        drive.state=STATE_NAMES[tonumber(state)]
        if not drive.state then return nil end
    end
    if t[8]~='-' then drive.commandId=number(t[8]); if not drive.commandId then return nil end end
    if t[9]~='-' then drive.currentId=number(t[9]); if not drive.currentId then return nil end end
    if t[10]~='-' then drive.remaining=number(t[10]); if not drive.remaining then return nil end end
    if t[11]~='-' then drive.currentClass=t[11] end
    return drive
end

-- The sections of a sample answer as arrays of tokens by tag; a failed section ("X !") is nil.
-- The W section is last and its name is the rest of the text. Returns nil when unreadable and 'failed'
-- when a section could not be read.
local function decodeSample(text)
    local head,waypoint=text:match('^(.-) W (.*)$')
    if not head then return nil end
    local sections,tag,failed={}
    for token in head:gmatch('%S+') do
        if #token==1 and token:match('^[APCDU]$') then tag=token; sections[tag]={}
        elseif tag then local list=sections[tag]; list[#list+1]=token
        else return nil end
    end
    for _,name in ipairs({'A','P','C','U'}) do
        local list=sections[name]
        if not list then return nil end
        if #list==1 and list[1]=='!' then failed=true end
    end
    if sections.D and #sections.D==1 and sections.D[1]=='!' then failed=true end
    if waypoint=='!' then failed=true end
    if failed then return 'failed' end
    local A,P,C,U,D=sections.A,sections.P,sections.C,sections.U,sections.D
    if #A~=4 or #P~=3 or #C~=7 or #U~=9 then return nil end
    local decoded={A=A,P=P,C=C,U=U}
    if flagOf(C[1]) and not D then return nil end
    if D then decoded.D=decodeDrive(D); if not decoded.D then return nil end end
    if waypoint=='0' then decoded.W=false
    else
        local id,px,py,pz,mx,my,mz,quest,name=waypoint:match('^1 (%d+) (%S+) (%S+) (%S+) (%S+) (%S+) (%S+) ([01]) (.*)$')
        if not id then return nil end
        decoded.W={id=id,px=number(px),py=number(py),pz=number(pz),mx=number(mx),my=number(my),mz=number(mz),
            quest=quest=='1',name=name~='-' and name or nil}
        for _,key in ipairs({'px','py','pz','mx','my','mz'}) do if not decoded.W[key] then return nil end end
    end
    return decoded
end

-- ---- comparison with the original ---------------------------------------------------------------
local function difference(path,a,b)
    if type(a)=='number' or type(b)=='number' then
        if not sameNumber(a,b) then return path..' '..tostring(a)..' vs '..tostring(b) end
    elseif a~=b then return path..' '..tostring(a)..' vs '..tostring(b) end
end
local DRIVE_KEYS={'known','error','ready','reservations','busy','foreign','ownedActive','state','commandId','currentId',
    'currentClass','remaining','distance'}
local function driveDifference(native,lua)
    if not native or not lua then
        if native==lua then return nil end
        return 'drive '..tostring(native~=nil)..' vs '..tostring(lua~=nil)
    end
    for _,key in ipairs(DRIVE_KEYS) do
        local found=difference('drive.'..key,native[key],lua[key])
        if found then return found end
    end
    return difference('drive.ai',native.ai~=nil,lua.ai~=nil) or difference('drive.entity',native.entity~=nil,lua.entity~=nil)
end
local function pointDifference(path,a,b)
    if not a or not b then return difference(path,a~=nil,b~=nil) end
    return difference(path..'.x',a.x,b.x) or difference(path..'.y',a.y,b.y) or difference(path..'.z',a.z,b.z)
end
local SAMPLE_KEYS={'playerId','actorAttached','actorDead','actorValid','actorCalm','playerPassenger','playerCombat',
    'summonedId','summonState','summonEnRoute','carValid'}
local AUTO_KEYS={'enabled','delamain','vehicleId','available','laneValid','destinationId','playerTracked',
    'questTracked','freeRoam','remaining'}
local function sampleDifference(native,lua)
    for _,key in ipairs(SAMPLE_KEYS) do
        local found=difference(key,native[key],lua[key])
        if found then return found end
    end
    for _,key in ipairs({'id','key','name','serial'}) do
        local found=difference('actor.'..key,native.actor[key],lua.actor[key])
        if found then return found end
    end
    local a,b=native.car,lua.car
    if (a~=nil)~=(b~=nil) then return 'car '..tostring(a~=nil)..' vs '..tostring(b~=nil) end
    if a then
        for _,key in ipairs({'id','record','name','owned'}) do
            local found=difference('car.'..key,a[key],b[key])
            if found then return found end
        end
    end
    if native.info~=nil and lua.info~=nil then
        local found=difference('info.ready',native.info.ready,lua.info.ready)
        if found then return found end
    end
    local found=driveDifference(native.drive,lua.drive)
    if found then return found end
    for _,key in ipairs(AUTO_KEYS) do
        found=difference('auto.'..key,native.auto[key],lua.auto[key])
        if found then return found end
    end
    local w,x=native.waypoint,lua.waypoint
    if (w~=nil)~=(x~=nil) then return 'waypoint '..tostring(w~=nil)..' vs '..tostring(x~=nil) end
    if w then
        for _,key in ipairs({'id','name','destinationType'}) do
            found=difference('waypoint.'..key,w[key],x[key])
            if found then return found end
        end
        return pointDifference('waypoint.position',w.position,x.position) or
            pointDifference('waypoint.markerPosition',w.markerPosition,x.markerPosition)
    end
end

-- ---- the cosmetic car name, cached per record -----------------------------------------------------
local names={}
local function cachedName(car,recordId)
    local name=names[recordId]
    if name then return name end
    local ok,record=pcall(function() return car:GetRecord() end)
    name=vehicleName(ok and record or nil,recordId)
    names[recordId]=name
    return name
end

-- ---- the drive table from a decoded D section --------------------------------------------------------
-- Adds the game objects and settles a pending state. Mirrors the tail of the original inspectDrive,
-- including its pcall: a failure becomes {known=false, error=...}.
local function finishDrive(decoded,entity,receipt)
    if not decoded.known then return decoded end
    local ok,result=pcall(function()
        local ai=entity:GetAIComponent()
        if not ai then return {known=false,error=DRIVE_ERRORS[0]} end
        if decoded.pendingState then
            if ai:IsCommandActive(receipt.id) then decoded.state='NotExecuting' else decoded.state='Cancelled' end
            decoded.pendingState=nil
        end
        decoded.ai=ai
        decoded.entity=entity
        return decoded
    end)
    return ok and result or {known=false,error=tostring(result)}
end

-- The receipt facts the plugin needs for one drive read.
local function receiptFacts(car,operation)
    if not operation then return false,false,0,'' end
    local receipt=M.driveReceipt(operation)
    local hasReceipt=receipt~=nil and operation.carId==car.id
    return true,hasReceipt,hasReceipt and receipt.id or 0,hasReceipt and receipt.class or '',receipt
end

local bypass=false -- true while the original sample runs for a comparison: its inner inspectDrive stays Lua

function M.inspectDrive(car,operation)
    local api,class=active()
    if type(car)=='table' and car.companionCar==true then return luaInspectDrive(car,operation) end
    if bypass or not api or type(car)~='table' or car.entityID==nil or type(car.id)~='string' or not plain(car.id) then
        return luaInspectDrive(car,operation)
    end
    local row=stats(api)
    local function fallback() row.lua=row.lua+1; return luaInspectDrive(car,operation) end
    local looked,entity=pcall(function() return Game.FindEntityByID(car.entityID) end)
    if not looked then return fallback() end
    if not entity then return {known=false,error='The borrowed car is unavailable.'} end
    local ok,text,receipt=pcall(function()
        local hasOperation,hasReceipt,receiptId,receiptClass,found=receiptFacts(car,operation)
        return class.Drive(entity,plain(car.id),operation and operation.handle or nil,hasOperation,hasReceipt,
            receiptId,receiptClass),found
    end)
    if not ok then
        api.fail(NATIVE,'inspectDrive: '..tostring(text)); row.fallback=row.fallback+1
        return luaInspectDrive(car,operation)
    end
    if text=='' then empty(api,row,'inspectDrive','emptyDrive'); return fallback() end
    row.emptyDrive=0
    local drive
    if text=='0' then drive={known=false,error='The borrowed car is unavailable.'}
    elseif type(text)=='string' and text:sub(1,2)=='1 ' then
        local decoded=decodeDrive(words((text:sub(3):gsub('^D%s+',''))))
        if decoded then
            -- the lease's record check of the original liveCar
            local recordOk=true
            if car.record then
                local good,record=pcall(function() return tostring(entity:GetRecordID()) end)
                recordOk=good and record==car.record
            end
            drive=recordOk and finishDrive(decoded,entity,receipt) or {known=false,error='The borrowed car is unavailable.'}
        end
    end
    if drive==nil then unreadable(api,row,'inspectDrive',text); return luaInspectDrive(car,operation) end
    local always=api.chauffeurVerify==true
    -- api.verifying answers from a value it re-checks about once a second and never raises.
    if not always and type(api.verifying)=='function' then always=api.verifying(NATIVE)==true end
    if always or row.verifiedDrive<VERIFY then
        local lua=luaInspectDrive(car,operation)
        row.compared=row.compared+1
        local found=driveDifference(drive,lua)
        if found then
            row.mismatches=row.mismatches+1
            note('Native core: chauffeur MISMATCH in inspectDrive: '..found..' (plugin '..text..')')
            api.fail(NATIVE,'inspectDrive differs from the Lua')
        else
            row.verifiedDrive=row.verifiedDrive+1
            if row.verifiedDrive==VERIFY then note('Native core: chauffeur inspectDrive matched the Lua '..VERIFY..' times, now native') end
        end
        return lua
    end
    row.native=row.native+1
    return drive
end

-- Builds the sample table from a decoded answer (the leased-car path of the original).
local function buildSample(decoded,player,entry,leasedCar,carEntity,api,operation,tail)
    local A,P,C,U=decoded.A,decoded.P,decoded.C,decoded.U
    local actorId=entityID(entry.entityID)
    local function id(token) if token~='0' then return token..tail end end
    local sample={actor={serial=entry.serial,id=actorId,key=entry.profileKey,name=entry.name},playerId=id(P[1])}
    local w=decoded.W
    if w then
        sample.waypoint={id=id(w.id),position={x=w.px,y=w.py,z=w.pz},name=nameFrom(w.name,w.quest),
            destinationType=w.quest and 'Quest' or 'PlayerTracked',markerPosition={x=w.mx,y=w.my,z=w.mz}}
    end
    sample.actorAttached,sample.actorDead,sample.actorValid,sample.actorCalm=A[1]=='1',A[2]=='1',A[3]=='1',A[4]=='1'
    -- "?": the plugin could not read the combat flag (it found no route to it in this game build). That one field is the
    -- original's own read, made here; the rest of the section stays the plugin's.
    if A[4]=='?' then sample.actorCalm=sample.actorValid and not NPCPuppet.IsInCombat(entry.npc) or false end
    if sample.actorAttached then sample.driverMount=api.mounting(entry) end
    sample.playerMount=mounted(player,api)
    sample.playerPassenger=P[2]=='1'
    sample.playerCombat=P[3]=='1'
    local defs=Game.GetAllBlackboardDefs().VehicleSummonData
    local bb=Game.GetBlackboardSystem():Get(defs)
    local summoned=bb:GetEntityID(defs.SummonedVehicleEntityID)
    sample.summonedId=entityID(summoned)
    local summonState=bb:GetUint(defs.SummonState)
    sample.summonState=tonumber(summonState)
    sample.summonEnRoute=tonumber(summonState)==1
    local car=C[1]=='1' and carEntity or nil
    if car and leasedCar.record then
        -- the lease's record check of the original liveCar
        local ok,record=pcall(function() return tostring(car:GetRecordID()) end)
        if not ok or record~=leasedCar.record then car=nil end
    end
    if car then
        local recordId=leasedCar.record or tostring(car:GetRecordID())
        sample.car={id=leasedCar.id,entityID=leasedCar.entityID,entity=car,owned=false,record=recordId,
            name=cachedName(car,recordId)}
        sample.carValid=C[3]=='1'
        sample.info=api.inspect(sample.car)
        local receipt=select(5,receiptFacts(leasedCar,operation))
        sample.drive=finishDrive(decoded.D,car,receipt)
        local target=sample.waypoint and sample.waypoint.position or operation and operation.target
        if target and C[4]=='1' then
            local x,y,z=number(C[5]),number(C[6]),number(C[7])
            sample.drive.distance=math.sqrt((x-target.x)^2+(y-target.y)^2+(z-target.z)^2)
        end
    else sample.info={ready=false} end
    sample.auto={enabled=U[1]=='1',delamain=U[2]=='1',vehicleId=id(U[8]),available=U[3]=='1',laneValid=U[4]=='1',
        destinationId=id(U[9]),playerTracked=U[5]=='1',questTracked=U[5]=='2',freeRoam=U[6]=='1',remaining=number(U[7])}
    return sample
end

function M.sample(player,entry,leasedCar,api,operation)
    local nativeApi,class=active()
    if type(leasedCar)=='table' and leasedCar.companionCar==true then
        return luaSample(player,entry,leasedCar,api,operation)
    end
    if not nativeApi or not leasedCar or type(leasedCar)~='table' or type(entry)~='table' or not bound(player)
        or type(api)~='table' or type(api.mounting)~='function' or type(api.inspect)~='function'
        or leasedCar.entityID==nil or not plain(leasedCar.id) then
        return luaSample(player,entry,leasedCar,api,operation)
    end
    local row=stats(nativeApi)
    local tail=idSuffix(player)
    if not tail then
        nativeApi.fail(NATIVE,'entity hash text is not digits and a suffix')
        return luaSample(player,entry,leasedCar,api,operation)
    end
    local actorId=entityID(entry.entityID)
    local ok,text,carEntity=pcall(function()
        local owner=entry.system or Game.GetDynamicEntitySystem()
        local entity=Game.FindEntityByID(leasedCar.entityID)
        local hasOperation,hasReceipt,receiptId,receiptClass=receiptFacts(leasedCar,operation)
        return class.Sample(entry.npc,player,entity,owner,operation and operation.handle or nil,plain(actorId) or '',
            plain(leasedCar.id),hasOperation,hasReceipt,receiptId,receiptClass),entity
    end)
    if not ok then
        nativeApi.fail(NATIVE,'sample: '..tostring(text)); row.fallback=row.fallback+1
        return luaSample(player,entry,leasedCar,api,operation)
    end
    if text=='' then empty(nativeApi,row,'sample','emptySample'); row.lua=row.lua+1; return luaSample(player,entry,leasedCar,api,operation) end
    local decoded=type(text)=='string' and decodeSample(text) or nil
    if decoded=='failed' then
        empty(nativeApi,row,'sample','emptySample'); row.lua=row.lua+1
        return luaSample(player,entry,leasedCar,api,operation)
    end
    if not decoded then
        unreadable(nativeApi,row,'sample',text)
        return luaSample(player,entry,leasedCar,api,operation)
    end
    row.emptySample=0
    local built,sample=pcall(buildSample,decoded,player,entry,leasedCar,carEntity,api,operation,tail)
    if not built then
        nativeApi.fail(NATIVE,'sample: '..tostring(sample)); row.fallback=row.fallback+1
        return luaSample(player,entry,leasedCar,api,operation)
    end
    local always=nativeApi.chauffeurVerify==true
    if not always and type(nativeApi.verifying)=='function' then always=nativeApi.verifying(NATIVE)==true end
    if always or row.verifiedSample<VERIFY then
        bypass=true
        local good,lua=pcall(luaSample,player,entry,leasedCar,api,operation)
        bypass=false
        if not good then error(lua,0) end
        row.compared=row.compared+1
        local found=sampleDifference(sample,lua)
        if found then
            row.mismatches=row.mismatches+1
            note('Native core: chauffeur MISMATCH in sample: '..found..' (plugin '..text..')')
            nativeApi.fail(NATIVE,'sample differs from the Lua')
        else
            row.verifiedSample=row.verifiedSample+1
            if row.verifiedSample==VERIFY then note('Native core: chauffeur sample matched the Lua '..VERIFY..' times, now native') end
        end
        return lua
    end
    row.native=row.native+1
    return sample
end

-- Developer mode (perf-probe) times each entry point as chauffeur.<name>, so the two paths can be
-- compared by adding and removing the line "chauffeur" in runtime/native-off.txt.
local probe=convaiPerfProbe
if type(probe)=='table' and type(probe.watch)=='function' then
    for _,name in ipairs({'sample','inspectDrive'}) do
        pcall(probe.watch,M,name,'chauffeur.'..name)
    end
end
return M
