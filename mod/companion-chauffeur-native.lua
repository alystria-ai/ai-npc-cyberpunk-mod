-- Cyberpunk 2.31 AutoDrive boundary. The coordinator owns a temporary driving
-- lease; this adapter never spawns, deletes, unlocks or persists a player car.
local M={}
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
function M.sample(player,entry,leasedCar,api)
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
function M.enable(player,entry,car,pin,seat,api)
    local sample=M.sample(player,entry,car,api)
    local pm,dm=sample.playerMount,sample.driverMount
    if not sample.actorValid or not sample.actorCalm or sample.playerCombat or not sample.carValid
        or not sample.info.ready or sample.info.scene
        or sample.summonedId~=car.id or not pm or pm.vehicle~=car.id or pm.seat~=seat
        or not sample.playerPassenger or not dm or dm.vehicle~=car.id or dm.seat~='seat_front_left'
        or not sameDestination(sample.waypoint,pin) or not samePoint(sample.waypoint.position,pin.position)
        or sample.auto.enabled or not sample.auto.available or not (sample.auto.playerTracked or sample.auto.questTracked)
        or sample.auto.destinationId~=pin.id then return false,'The car, seats or destination changed before departure.' end
    local request=NewObject('EnableAutoDriveRequest'); request.isDelamain=false
    system():QueueRequest(request)
    return true
end
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
function M.brake(car)
    local entity=Game.FindEntityByID(car.entityID)
    if not entity or not entity:IsAttached() or not entity:IsVehicle() or not entity:IsPlayerVehicle()
        or entityID(entity:GetEntityID())~=car.id then return false,'The borrowed car is unavailable.' end
    if entity:IsPlayerDriver() or entity:IsPerformingSceneAnimation() then return false,'V or a scene has taken vehicle control.' end
    entity:ForceBrakesUntilStoppedOrFor(10.0)
    return true
end
return M
