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
-- True for the self-driving Delamain cab (patch 2.3). Policy treats it as a taxi, not a convoy leader.
local TAXI_RECORDS={'Vehicle.v_standard2_villefort_cortes_delamain_player','Vehicle.v_delamain_taxi'}
function M.isTaxi(vehicle)
    local entity=type(vehicle)=='table' and vehicle.entity
    if not entity then return false end
    local ok,found=pcall(function()
        if not entity:IsAttached() then return false end
        local record=entity:GetRecordID()
        for _,name in ipairs(TAXI_RECORDS) do
            if record==TweakDBID.new(name) then return true end
        end
        return false
    end)
    return ok and found==true
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
    if not entity or not entity:IsAttached() then
        -- Streaming can replace the native handle while the exact entity ID
        -- remains valid. Never keep polling a detached cached handle forever.
        if vehicle.system then entity=vehicle.system:GetEntity(vehicle.entityID)
        else entity=Game.FindEntityByID(vehicle.entityID) end
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
    -- This shared record has only three usable
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
    if not car or not car:IsAttached() then
        return nil,'Your vehicle is not available for another car to join.'
    end
    if speed(car)>0.8 then
        return nil,'Wait for your vehicle to stop before the next car joins.',true
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
-- Convoy follow A/B (Developer mode only). 'default' is the confirmed convoy: the game's traffic system on,
-- kinematic driving off, 8 m more room per car. 'smooth' is the other candidate: no traffic system, kinematic
-- driving, and 3 m per stacked bike instead of 8. Both still follow V's car. Chosen by the one word in
-- runtime/convoy-follow-mode.txt ('default' or 'smooth'; a missing, unreadable or unknown file is 'default')
-- while Developer mode is on; read once per follow request, never per frame. M.developerMode is set by
-- companions.lua.
local CONVOY_MODE_FILE='runtime/convoy-follow-mode.txt'
M.developerMode=nil
function M.convoyMode()
    local gate=M.developerMode
    if type(gate)~='function' then return 'default' end
    local gated,on=pcall(gate)
    if not gated or on~=true then return 'default' end
    local opener=io and io.open
    local file=opener and opener(CONVOY_MODE_FILE,'rb')
    if not file then return 'default' end
    local text=file:read('*a')
    file:close()
    -- PowerShell writes a byte-order mark with Set-Content/Out-File -Encoding utf8.
    if type(text)=='string' then text=text:gsub('^\239\187\191','') end
    local word=type(text)=='string' and text:match('^%s*(%a+)') or nil
    return word and word:lower()=='smooth' and 'smooth' or 'default'
end
-- The command settings for a mode: whether the game's traffic system and kinematic driving are used, and the
-- extra minimum distance each stacked vehicle adds (a bike needs less than a car).
function M.convoyProfile(mode,bike)
    if mode=='smooth' then
        return {mode='smooth',useTraffic=false,useKinematic=true,step=bike and 3 or 8}
    end
    return {mode='default',useTraffic=true,useKinematic=false,step=8}
end
local function isBike(entity)
    local ok,bike=pcall(function()
        return entity:GetRecord():Type():Type()==Enum.new('gamedataVehicleType','Bike')
    end)
    return ok and bike==true
end
function M.follow(vehicle,target,ordinal)
    local ai=vehicle.entity:GetAIComponent()
    if not ai then return nil,'This vehicle has no native driving AI.' end
    local mode=M.convoyMode()
    -- The bike test is one extra native read, made only for the A/B mode.
    local profile=M.convoyProfile(mode,mode=='smooth' and isBike(vehicle.entity))
    local cmd=NewObject('AIVehicleFollowCommand')
    cmd.target=target
    cmd.distanceMin=10+ordinal*profile.step
    cmd.distanceMax=cmd.distanceMin+12
    cmd.stopWhenTargetReached=false
    cmd.needDriver=true
    cmd.useTraffic=profile.useTraffic
    cmd.trafficTryNeighborsForStart=profile.useTraffic
    cmd.trafficTryNeighborsForEnd=profile.useTraffic
    cmd.useKinematic=profile.useKinematic
    vehicle.followMode=profile.mode
    return command(ai,cmd:Copy(),vehicle.entity)
end
-- Followers another mod seats in V's car (docs/COMPANION_VEHICLES_DESIGN.md, "Other mods' riders"): characters the shared dynamic
-- entity system manages that are not ours, near V, alive, standing outside every vehicle, and either following V (the engine's
-- follower role, which Night City Allies gives every follower it spawns, squad member or not) or friendly to V in V's own
-- attitude group. The mod that made them mounts them the moment V gets in, or the engine's follower AI does, picking seats
-- without looking at who sits where, so the policy keeps our companions out of their way. Nothing of theirs is read beyond
-- identity, attitude and mount state, and nothing is sent. Asked once when boarding starts, never per frame; the service
-- (init.lua's spawned-character service) does one targeting query and one lookup per remembered ID.
-- Returns the count and a report {ids = {EntityID...}, rows = {{who, distance, counted, why}...}} for probe.log and for
-- M.foreignPending. 0 when that service is missing, on a bike (nobody rides a bike's seats) or when none counts.
local FOREIGN_RADIUS=50
local function machine(npc)
    local ok,value=pcall(function() return npc:IsMech() or npc:IsDrone() end)
    return ok and value==true
end
-- init.lua sets the service as a global of this mod's environment; a bare read finds it, rawget(_G) is the second try.
local function spawnedService()
    local ok,service=pcall(function() return convaiSpawnedCharacters end)
    if ok and service then return service end
    return rawget(_G,'convaiSpawnedCharacters')
end
local function plainDistance(value) return type(value)=='number' and math.floor(value*10+.5)/10 or nil end
function M.foreignRiders(player,vehicle)
    local report={ids={},rows={}}
    local service=spawnedService()
    if not service then report.why='no spawned-character service'; return 0,report end
    if not player or not vehicle or not vehicle.entity then report.why='no vehicle'; return 0,report end
    if isBike(vehicle.entity) then report.why='bike'; return 0,report end
    local asked,rows=pcall(service.nearby,service,player,FOREIGN_RADIUS)
    if not asked then error(rows) end
    if type(rows)~='table' then report.why='no rows'; return 0,report end
    local own=player:GetAttitudeAgent()
    local group=NameToString(own:GetAttitudeGroup())
    local pending=0
    for _,row in ipairs(rows) do
        local line={who=row.key or row.entity and tostring(row.entity) or '?',distance=plainDistance(row.distance)}
        local read,why,id=pcall(function()
            local npc=row.npc
            if not npc or not npc:IsAttached() then return 'detached' end
            if npc:IsDeadNoStatPool() then return 'dead' end
            if machine(npc) then return 'machine' end
            if M.mounting({npc=npc}) then return 'mounted' end
            local follower=select(2,pcall(function() return npc:IsPlayerCompanion() end))==true
            local agent=npc:GetAttitudeAgent()
            local friendly=tostring(agent:GetAttitudeTowards(own)):find('AIA_Friendly',1,true)~=nil
            local sameGroup=NameToString(agent:GetAttitudeGroup())==group
            if follower then return 'follower',npc:GetEntityID() end
            if friendly and sameGroup then return 'friendly-group',npc:GetEntityID() end
            return friendly and 'other-group' or 'not-friendly'
        end)
        line.why=read and why or 'unreadable'
        line.counted=read and (why=='follower' or why=='friendly-group')
        if line.counted then pending=pending+1; report.ids[#report.ids+1]=id end
        report.rows[#report.rows+1]=line
    end
    return pending,report
end
-- Of the characters foreignRiders counted (their entity IDs), how many still stand outside every vehicle: the policy waits
-- for them to take their seats. Called only while that wait lasts, twice a second, a lookup and a mount read each.
function M.foreignPending(ids)
    local pending=0
    for _,id in ipairs(ids or {}) do
        local read,waiting=pcall(function()
            local npc=Game.FindEntityByID(id)
            if not npc or not npc:IsAttached() or npc:IsDeadNoStatPool() then return false end
            return M.mounting({npc=npc})==nil
        end)
        if read and waiting==true then pending=pending+1 end
    end
    return pending
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
    local target,reason,deferred=placement.find(player,desired,occupied,entry.clearance,nil,{sweepRoute=true})
    if deferred then return nil,nil,true end
    if not target then return false,reason end
    local hook=rawget(_G,'convaiTeleportLog')
    if hook then
        local from=entry.npc:GetWorldPosition()
        pcall(hook,{reason='vehicle-exit-recover',actor=tostring(entry.npc:GetEntityID().hash),
            from={x=from.x,y=from.y,z=from.z},to={x=target.x,y=target.y,z=target.z}})
    end
    Game.GetTeleportationFacility():Teleport(entry.npc,target,Quaternion.ToEulerAngles(entry.npc:GetWorldOrientation()))
    occupied[#occupied+1]={position=target,clearance=entry.clearance}
    return true
end
-- Optional native path -----------------------------------------------------------------------
-- With the CyberpunkConvaiNative plugin loaded and its 'vehicles' switch on, M.inspect and the
-- not-mounted answer of M.mounting run in C++ (native/core/src/systems/vehicles): one CET call
-- instead of about 58 calls and 35 property reads per car. Everything above is the original Lua
-- and stays the fallback:
--   * kill switch: a line "vehicles" in runtime/native-off.txt (the plugin re-reads it about once a
--     second; the CET console cannot reach convaiNative, each CET mod has its own environment);
--     three faults inside the plugin's natives also switch it off;
--   * a native call that answers "" (a game function was missing, the entity was not readable) runs
--     the original for that call; 20 empty answers in a row, or an unreadable answer, call
--     convaiNative.fail('vehicles', ...) and this module stays on Lua for the session;
--   * a detached entity (status 3) and every mounted answer run the original: the re-resolve of a
--     detached handle and the parent EntityID object of a mount are CET objects;
--   * the first VERIFY answers of each call run BOTH paths and compare them; any difference calls
--     convaiNative.fail and logs both answers to probe.log. A line "vehicles" in
--     runtime/native-verify.txt compares every call (and so does the test hook
--     convaiNative.vehiclesVerify = true, set from Lua); convaiNative.vehiclesStats counts the calls.
-- Wire format: VehiclesCore.hpp.
local NATIVE='vehicles' -- the convaiNative system name (kill switch, probe.log)
local VERIFY=8
local EMPTY_LIMIT=20
local luaInspect,luaMounting,luaUseSpatialBudget=M.inspect,M.mounting,M.useSpatialBudget

local function bound(value) return type(value)=='table' or type(value)=='userdata' end
local nativeClass
local function resolve()
    if nativeClass then return nativeClass end
    local ok,class=pcall(function() return ConvaiNativeVehicles end)
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
    local row=api.vehiclesStats
    if type(row)~='table' then
        row={native=0,lua=0,fallback=0,empty=0,emptyRun_inspect=0,emptyRun_mounting=0,verified=0,verifiedMounting=0,compared=0,mismatches=0}
        api.vehiclesStats=row
    end
    return row
end
-- The plugin writes entity hashes as plain decimal digits; CET prints them with a type suffix
-- ("123ULL"). The suffix is read once from a real entity hash.
local suffix
local function idSuffix(entity)
    if suffix then return suffix end
    local ok,text=pcall(function() return tostring(entity:GetEntityID().hash) end)
    local found=ok and type(text)=='string' and text:match('^%d+([uUlL]*)$')
    if found then suffix=found end
    return suffix
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

-- "V ..." as the table the original returns, 'detached' (the original must run), or nil (unreadable).
local function decodeInspect(text,tail)
    local t=words(text)
    if t[1]~='V' then return nil end
    local status=tonumber(t[2])
    if status==0 then return {ready=false,invalid=true} end
    if status==1 then return {ready=false,error='Native vehicle AI has not attached.'} end
    if status==3 then return 'detached' end
    if status~=2 or #t<9 then return nil end
    local count=tonumber(t[9])
    if not count or count<0 or #t~=9+3*count then return nil end
    local speed,gap=number(t[7]),number(t[8])
    if not speed or not gap then return nil end
    local seats={}
    for index=1,count do
        local base=9+(index-1)*3
        local occupant=t[base+2]
        seats[index]={name=t[base+1],occupant=occupant~='0' and (occupant..tail) or nil,reserved=t[base+3]=='1'}
    end
    return {ready=true,seats=seats,speed=speed,invalid=t[3]=='1',playerGap=gap,
        playerMounted=t[5]=='1',scene=t[6]=='1'},t[4]=='1'
end
local function sameInspect(native,aiPresent,lua)
    if native.ready~=lua.ready then return false end
    if not native.ready then return native.invalid==lua.invalid and native.error==lua.error end
    if (lua.ai~=nil)~=aiPresent or native.invalid~=lua.invalid or native.playerMounted~=lua.playerMounted
        or native.scene~=lua.scene or not sameNumber(native.speed,lua.speed)
        or not sameNumber(native.playerGap,lua.playerGap) or #native.seats~=#lua.seats then return false end
    for index,seat in ipairs(native.seats) do
        local other=lua.seats[index]
        if seat.name~=other.name or seat.occupant~=other.occupant or seat.reserved~=other.reserved then return false end
    end
    return true
end
local function describeInspect(info)
    if type(info)~='table' then return tostring(info) end
    if not info.ready then return ('{ready=false invalid=%s error=%s}'):format(tostring(info.invalid),tostring(info.error)) end
    local seats={}
    for _,seat in ipairs(info.seats or {}) do
        seats[#seats+1]=('%s=%s%s'):format(tostring(seat.name),tostring(seat.occupant),seat.reserved and '*' or '')
    end
    return ('{speed=%s gap=%s mounted=%s scene=%s invalid=%s ai=%s seats=[%s]}'):format(tostring(info.speed),
        tostring(info.playerGap),tostring(info.playerMounted),tostring(info.scene),tostring(info.invalid),
        tostring(info.ai~=nil),table.concat(seats,' '))
end

-- The plugin, when it is on for this call; else nil (the caller runs the original).
local function active()
    local api=convaiNative
    if type(api)~='table' or type(api.use)~='function' or api.use(NATIVE)~=true then return nil end
    local class=resolve()
    if not class then api.fail(NATIVE,'ConvaiNativeVehicles is not registered'); return nil end
    return api,class
end
-- A call that answered "": count it, and give up on the plugin when it never answers.
local function empty(api,row,name)
    -- The run is counted per call: a good answer of one must not hide a call that is never answered.
    local key='emptyRun_'..name
    row.empty=row.empty+1
    row[key]=(row[key] or 0)+1
    if row[key]>=EMPTY_LIMIT then api.fail(NATIVE,name..' keeps answering unavailable') end
end
local function mismatch(api,row,name,detail)
    row.mismatches=row.mismatches+1
    note('Native core: vehicles MISMATCH in '..name..': '..detail)
    api.fail(NATIVE,name..' differs from the Lua')
end

function M.inspect(vehicle)
    local api,class=active()
    local entity=api and type(vehicle)=='table' and vehicle.entity
    if not entity then return luaInspect(vehicle) end
    local row=stats(api)
    local tail=idSuffix(entity)
    if not tail then api.fail(NATIVE,'entity hash text is not digits and a suffix'); return luaInspect(vehicle) end
    local ok,text=pcall(class.Inspect,entity,vehicle.owned==true)
    if not ok then
        api.fail(NATIVE,'inspect: '..tostring(text)); row.fallback=row.fallback+1
        return luaInspect(vehicle)
    end
    if text=='' then empty(api,row,'inspect'); row.lua=row.lua+1; return luaInspect(vehicle) end
    row.emptyRun_inspect=0
    local info,aiPresent
    if type(text)=='string' then info,aiPresent=decodeInspect(text,tail) end
    if info==nil then
        api.fail(NATIVE,'inspect: unreadable reply '..tostring(text)); row.fallback=row.fallback+1
        return luaInspect(vehicle)
    end
    if info=='detached' then row.lua=row.lua+1; return luaInspect(vehicle) end
    local always=api.vehiclesVerify==true
    -- api.verifying answers from a value it re-checks about once a second and never raises.
    if not always and type(api.verifying)=='function' then always=api.verifying(NATIVE)==true end
    local verify=always or row.verified<VERIFY
    if verify then
        local lua=luaInspect(vehicle)
        row.compared=row.compared+1
        if not sameInspect(info,aiPresent,lua) then
            mismatch(api,row,'inspect','plugin '..describeInspect(info)..' ('..text..'), Lua '..describeInspect(lua))
            return lua
        end
        row.verified=row.verified+1
        if row.verified==VERIFY then note('Native core: vehicles inspect matched the Lua '..VERIFY..' times, now native') end
        return lua
    end
    row.native=row.native+1
    vehicle.everAttached=true
    if info.ready and aiPresent then
        local ok2,ai=pcall(function() return entity:GetAIComponent() end)
        info.ai=ok2 and ai or nil
    end
    return info
end

function M.mounting(entry)
    local api,class=active()
    local npc=api and type(entry)=='table' and entry.npc
    if not npc then return luaMounting(entry) end
    local row=stats(api)
    local ok,text=pcall(class.Mounting,npc)
    if not ok then
        api.fail(NATIVE,'mounting: '..tostring(text)); row.fallback=row.fallback+1
        return luaMounting(entry)
    end
    if text=='' then empty(api,row,'mounting'); row.lua=row.lua+1; return luaMounting(entry) end
    row.emptyRun_mounting=0
    local t=type(text)=='string' and words(text) or {}
    if t[1]~='M' or not t[2] or (t[2]~='-' and (#t~=3 or not t[2]:match('^%d+$'))) then
        api.fail(NATIVE,'mounting: unreadable reply '..tostring(text)); row.fallback=row.fallback+1
        return luaMounting(entry)
    end
    if t[2]=='-' then
        local always=api.vehiclesVerify==true
        if not always and type(api.verifying)=='function' then always=api.verifying(NATIVE)==true end
        if always or (row.verifiedMounting or 0)<VERIFY then
            local lua=luaMounting(entry)
            row.compared=row.compared+1
            if lua~=nil then
                mismatch(api,row,'mounting','plugin says not mounted, Lua says '..tostring(lua.vehicle)..' '..tostring(lua.seat))
                return lua
            end
            row.verifiedMounting=(row.verifiedMounting or 0)+1
            if row.verifiedMounting==VERIFY then note('Native core: vehicles mounting matched the Lua '..VERIFY..' times, now native') end
            return nil
        end
        row.native=row.native+1
        return nil
    end
    -- Mounted: the parent EntityID is a CET object, so the original builds the answer. The plugin's
    -- answer is checked against it every time (it costs nothing extra).
    row.lua=row.lua+1
    local lua=luaMounting(entry)
    row.compared=row.compared+1
    local tail=idSuffix(npc)
    if tail and (not lua or lua.vehicle~=(t[2]..tail) or lua.seat~=t[3]) then
        mismatch(api,row,'mounting','plugin '..text..', Lua '..tostring(lua and lua.vehicle)..' '..tostring(lua and lua.seat))
    end
    return lua
end

-- companions.lua calls this every update: once the plugin check has finished, ask for the switch
-- so probe.log names the active path (convaiNative logs "Native core: vehicles=native|lua").
local announced=false
function M.useSpatialBudget(value)
    luaUseSpatialBudget(value)
    if not announced then
        local api=convaiNative
        if type(api)=='table' and api.pending~=true and type(api.use)=='function' then
            announced=true
            pcall(api.use,NATIVE)
        end
    end
end

-- Developer mode (perf-probe) times each entry point as vehicles.<name>, so the two paths can be
-- compared by adding and removing the line "vehicles" in runtime/native-off.txt.
local probe=convaiPerfProbe
if type(probe)=='table' and type(probe.watch)=='function' then
    for _,name in ipairs({'inspect','mounting'}) do
        pcall(probe.watch,M,name,'vehicles.'..name)
    end
end
return M
