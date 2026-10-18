-- A CET reload can retire the Lua owner while its driver is still seated.
-- This receipt grants cleanup only, never a party, driving or spawn lease.
local M={}
local PATH='runtime/companion-chauffeur-cleanup.json'
local TAG='CyberpunkConvaiCompanion'
local PREFIX='CyberpunkConvaiCleanup_'
local MAX_BYTES,MAX_ATTEMPTS,WAIT_LIMIT=4096,3,3600
local function copy(value)
    if type(value)~='table' then return value end
    local result={}; for key,child in pairs(value) do result[key]=copy(child) end
    return result
end
local function id(value)
    return value and value.hash~=nil and tostring(value.hash) or nil
end
local function identifier(value)
    return type(value)=='string' and #value<=24 and value:match('^%d+[uUlL]*$')
        and not value:match('^0+[uUlL]*$')
end
local function text(value)
    return type(value)=='string' and #value>0 and #value<=256 and not value:find('[%c]')
end
local function commandReceipt(value)
    return value==nil or (type(value)=='table' and type(value.id)=='number'
        and value.id>=0 and value.id==math.floor(value.id) and value.id<=2147483647
        and (value.class=='AIMountCommand' or value.class=='AIUnmountCommand')
        and (value.cancelRequested==nil or type(value.cancelRequested)=='boolean'))
end
local function vehicleReceipt(value)
    return value==nil or type(value)=='table' and type(value.id)=='number'
        and value.id>=0 and value.id<4294967295 and value.id==math.floor(value.id)
        and value.class=='AIVehicleDriveToPointAutonomousCommand'
        and (value.cancelRequested==nil or type(value.cancelRequested)=='boolean')
        and (value.stopSubmissions==nil or type(value.stopSubmissions)=='number'
            and value.stopSubmissions>=0 and value.stopSubmissions<=MAX_ATTEMPTS
            and value.stopSubmissions==math.floor(value.stopSubmissions))
end
local function valid(value,now)
    return type(value)=='table' and (value.version==2 or value.version==3 and value.backend=='npc')
        and value.intent=='cleanup-only'
        and type(value.issuedAt)=='number' and value.issuedAt<=now+5
        and type(value.expiresAt)=='number' and value.expiresAt>now
        and value.expiresAt-value.issuedAt==WAIT_LIMIT
        and identifier(value.player) and type(value.actor)=='table' and identifier(value.actor.id)
        and text(value.actor.record) and type(value.tag)=='string'
        and value.tag:match('^'..PREFIX..'%d+_%d+$') and #value.tag<=96
        and type(value.car)=='table' and identifier(value.car.id) and text(value.car.record)
        and value.seat=='seat_front_left' and commandReceipt(value.command)
        and vehicleReceipt(value.vehicleCommand)
        and (value.attempts==nil or type(value.attempts)=='number' and value.attempts>=0
            and value.attempts<=MAX_ATTEMPTS and value.attempts==math.floor(value.attempts))
        and (value.deleteRequested==nil or type(value.deleteRequested)=='boolean')
end
local function terminal(state)
    return state=='Success' or state=='Failure' or state=='Cancelled'
        or state=='Interrupted' or state=='Detached'
end
local function safe(fn,...)
    local ok,a,b,c=pcall(fn,...)
    if not ok then return nil,tostring(a) end
    return a,b,c
end
local function store(value)
    local ok,raw=pcall(json.encode,value)
    if not ok or type(raw)~='string' or #raw>MAX_BYTES then return false end
    -- In place: the file ships empty and is only rewritten, never created, deleted or renamed
    -- (Mod Organizer 2 sends a new file to Overwrite). A torn write fails valid() in load.
    local file=io.open(PATH,'wb'); if not file then return false end
    local written,closed=file:write(raw),file:close()
    return written and closed and true or false
end
-- Empty means no cleanup pending (load treats an empty or missing file the same way).
local function erase() local file=io.open(PATH,'wb'); if file then file:write(''); file:close() end end
local function finish(s,phase,reason)
    s.phase,s.error,s.receipt,s.operation,s.carID,s.actorID=phase,reason,nil,nil,nil,nil
    s.vehicleOperation,s.vehicleCommandAt=nil,nil
    erase()
end

-- Native IDs come from Codeware's unique-tag enumeration, mount parents or the
-- actual summoned-car blackboard. Never round-trip UInt64 IDs through doubles.
local function nativeApi(transport,chauffeur,beforeRemove)
    local api={}
    local function proof(player,receipt)
        if not player or not player:IsAttached() or player:IsDeadNoStatPool()
            or id(player:GetEntityID())~=receipt.player then return nil,'player-binding-changed',true end
        local system=Game.GetDynamicEntitySystem()
        if not system or not system:IsReady() then return nil,'world-not-ready' end
        local ids=system:GetTaggedIDs(CName.new(receipt.tag))
        if type(ids)~='table' or #ids~=1 or id(ids[1])~=receipt.actor.id then
            return nil,'native-cleanup-tag-missing',true
        end
        local entityID=ids[1]
        if not system:IsManaged(entityID) or not system:IsTagged(entityID,CName.new(TAG))
            or not system:IsTagged(entityID,CName.new(receipt.tag)) then
            return nil,'native-companion-ownership-changed',true
        end
        local npc=system:GetEntity(entityID)
        if not npc or not npc:IsAttached() then return nil,'driver-not-attached' end
        if id(npc:GetEntityID())~=receipt.actor.id or not npc:IsA('NPCPuppet') or npc:IsCrowd()
            or tostring(npc:GetRecordID())~=receipt.actor.record then return nil,'driver-binding-changed',true end
        local ai=npc:GetAIControllerComponent()
        local role=ai and ai:GetAIRole()
        if not role or not role:IsA('AIFollowerRole') then return nil,'driver-role-changed',true end
        return {entry={npc=npc,entityID=entityID,system=system},role=role}
    end
    function api.capture(player,entry,car,operation,tag,driveOperation)
        local system=entry.system
        if not player or not player:IsAttached() or not entry.npc or not entry.npc:IsAttached()
            or not system or not system:IsReady() or not system:IsManaged(entry.entityID)
            or not system:IsTagged(entry.entityID,CName.new(TAG))
            or id(entry.npc:GetEntityID())~=id(entry.entityID)
            or not car or car.owned~=false or not car.entity or not car.entity:IsAttached()
            or not car.entity:IsVehicle() or not car.entity:IsPlayerVehicle()
            or id(car.entity:GetEntityID())~=car.id then return nil,'cleanup-ownership-unavailable' end
        local receipt=operation and transport.commandReceipt(operation) or nil
        if not commandReceipt(receipt) then return nil,'cleanup-command-unavailable' end
        local vehicleCommand=driveOperation and chauffeur.driveReceipt(driveOperation) or nil
        if driveOperation and not vehicleCommand or not vehicleReceipt(vehicleCommand) then
            return nil,'cleanup-vehicle-command-unavailable'
        end
        local now=os.time()
        local value={version=3,backend='npc',intent='cleanup-only',issuedAt=now,expiresAt=now+WAIT_LIMIT,
            player=id(player:GetEntityID()),actor={id=id(entry.entityID),record=tostring(entry.npc:GetRecordID())},
            car={id=car.id,record=tostring(car.entity:GetRecordID())},tag=tag,
            seat='seat_front_left',command=receipt,vehicleCommand=vehicleCommand}
        system:AssignTag(entry.entityID,CName.new(tag))
        local checked=proof(player,value)
        if not checked then return nil,'cleanup-tag-unavailable' end
        return value
    end
    function api.seated(player,npc)
        local system=Game.GetDynamicEntitySystem()
        if not npc or not npc:IsAttached() or not npc:IsA('NPCPuppet') or npc:IsCrowd()
            or not system or not system:IsReady() then return nil,'driver-unavailable' end
        local entityID=npc:GetEntityID()
        local managed=system:GetEntity(entityID)
        if not system:IsManaged(entityID) or not system:IsTagged(entityID,CName.new(TAG))
            or not managed or not managed:IsAttached() or not managed:IsA('NPCPuppet')
            or id(managed:GetEntityID())~=id(entityID)
            or tostring(managed:GetRecordID())~=tostring(npc:GetRecordID()) then
            return nil,'native-companion-ownership-unavailable'
        end
        local role=npc:GetAIControllerComponent():GetAIRole()
        if not role or not role:IsA('AIFollowerRole') then return nil,'driver-role-changed' end
        local entry={npc=npc,entityID=entityID,system=system}
        local mount=transport.mounting(entry)
        if not mount or mount.seat~='seat_front_left' then return nil,'not-a-seated-driver' end
        local entity=Game.FindEntityByID(mount.parent)
        if not entity or not entity:IsAttached() or not entity:IsVehicle() or not entity:IsPlayerVehicle()
            or id(entity:GetEntityID())~=mount.vehicle then return nil,'borrowed-owned-car-unavailable' end
        local car={id=mount.vehicle,entityID=mount.parent,entity=entity,owned=false}
        -- Read only exact native mount handlers on this already proved copy.
        -- Matching the owned car/driver slot avoids cancelling unrelated AI.
        local ai=npc:GetAIControllerComponent()
        local operation
        for _,class in ipairs({'AIUnmountCommand','AIMountCommand'}) do
            local handle=ai:GetEnqueuedOrExecutingCommand(CName.new(class),false)
            if handle then
                local data=handle.mountData
                if not data or id(data.mountParentEntityId)~=car.id
                    or NameToString(data.slotName)~=mount.seat then return nil,'driver-command-binding-changed' end
                operation={ai=ai,handle=handle,owner=npc}; break
            end
        end
        return entry,car,operation
    end
    function api.sample(player,receipt,priorCarID,priorActorID)
        if receipt.deleteRequested then
            -- An accepted despawn can detach components before Codeware retires
            -- the ID. Poll only native registry metadata, never the actor/AI.
            if not player or not player:IsAttached() or id(player:GetEntityID())~=receipt.player then
                return nil,'player-binding-changed',true
            end
            local system=Game.GetDynamicEntitySystem()
            if not system or not system:IsReady() then return nil,'world-not-ready' end
            local nativeID=priorActorID
            if not nativeID then
                local ids=system:GetTaggedIDs(CName.new(receipt.tag))
                if type(ids)~='table' or #ids~=1 or id(ids[1])~=receipt.actor.id
                    or not system:IsTagged(ids[1],CName.new(TAG)) then
                    return nil,'native-cleanup-tag-missing',true
                end
                nativeID=ids[1]
            end
            if id(nativeID)~=receipt.actor.id then return nil,'driver-binding-changed',true end
            return {deleting=true,deleted=not system:IsManaged(nativeID),actorID=nativeID}
        end
        local bound,why,fatal=proof(player,receipt)
        if not bound then return nil,why,fatal end
        local pm=transport.mounting({npc=player})
        local dm=transport.mounting(bound.entry)
        if dm and (dm.vehicle~=receipt.car.id or dm.seat~=receipt.seat) then
            return nil,'driver-mount-changed',true
        end
        local nativeCarID=dm and dm.parent or pm and pm.vehicle==receipt.car.id and pm.parent or priorCarID
        if not nativeCarID then
            local defs=Game.GetAllBlackboardDefs().VehicleSummonData
            local candidate=Game.GetBlackboardSystem():Get(defs):GetEntityID(defs.SummonedVehicleEntityID)
            if id(candidate)==receipt.car.id then nativeCarID=candidate end
        end
        if not nativeCarID or id(nativeCarID)~=receipt.car.id then return nil,'borrowed-car-unavailable' end
        local car=Game.FindEntityByID(nativeCarID)
        if not car or not car:IsAttached() or not car:IsVehicle() or not car:IsPlayerVehicle()
            or id(car:GetEntityID())~=receipt.car.id or tostring(car:GetRecordID())~=receipt.car.record then
            return nil,'borrowed-car-binding-changed',true
        end
        bound.car={id=receipt.car.id,entityID=nativeCarID,entity=car,owned=false}
        bound.info=transport.inspect(bound.car)
        local auto=Game.GetScriptableSystemsContainer():Get(CName.new('AutoDriveSystem'))
        local active=auto:GetAutodriveVehicle()
        bound.autoEnabled=auto:GetAutodriveEnabled()
        bound.legacyAuto=receipt.version==2
        bound.autoMatches=not bound.autoEnabled or bound.legacyAuto and not auto:GetAutodriveIsDelamain()
            and active and id(active:GetEntityID())==receipt.car.id
        if type(chauffeur.inspectDrive)=='function' then
            local operation=receipt.vehicleCommand and {driveReceipt=receipt.vehicleCommand,carId=receipt.car.id}
            bound.drive=chauffeur.inspectDrive(bound.car,operation)
            bound.foreignVehicle=not bound.drive.known or bound.drive.foreign
            -- Legacy receipts can own that already-proved AutoDrive lease,
            -- but never a newly observed vehicle-AI command.
            if bound.legacyAuto and bound.autoEnabled and bound.autoMatches then
                bound.foreignVehicle=not bound.drive.known or bound.drive.currentId~=nil
            end
        elseif receipt.vehicleCommand then return nil,'vehicle-command-observation-unavailable' end
        bound.playerAboard=pm and pm.vehicle==receipt.car.id or bound.info.playerMounted==true
        bound.playerDriver=pm and pm.vehicle==receipt.car.id and pm.seat=='seat_front_left' or car:IsPlayerDriver()
        for _,seat in ipairs(bound.info.seats or {}) do
            if seat.name=='seat_front_left' and seat.occupant and seat.occupant~=receipt.actor.id then
                bound.foreignVehicle=true
            end
        end
        bound.driverMounted=dm~=nil
        bound.driverExiting=not bound.driverMounted and Game.GetWorkspotSystem():IsActorInWorkspot(bound.entry.npc)
        for _,seat in ipairs(bound.info.seats or {}) do
            if seat.name==receipt.seat and seat.occupant==receipt.actor.id and not bound.driverMounted then
                bound.driverExiting=true
            end
        end
        local scene=Game.GetSceneSystem():GetScriptInterface()
        bound.blocked=bound.info.scene or not bound.info.ready or bound.info.invalid
            or scene:IsEntityInScene(bound.entry.entityID) or scene:IsEntityInDialogue(bound.entry.entityID)
            or player:IsInCombat() or NPCPuppet.IsInCombat(bound.entry.npc)
        return bound
    end
    function api.stop(player,bound) return chauffeur.disable(player,bound.car,false,transport) end
    function api.brake(bound)
        local operation=bound.vehicleOperation
        if not operation and bound.driveReceipt then
            operation={driveReceipt=bound.driveReceipt,carId=bound.car.id,driverId=id(bound.entry.entityID)}
        end
        return chauffeur.brake(bound.car,operation,id(bound.entry.entityID))
    end
    function api.restoreVehicle(receipt,bound)
        local operation=transport.retiredCommand(receipt,bound.car.entity,true)
        operation.carId,operation.driverId=bound.car.id,id(bound.entry.entityID)
        operation.driveReceipt=receipt
        operation.stopSubmissions=receipt.stopSubmissions or 0
        transport.commandState(operation)
        if operation.handle and (NameToString(operation.handle:GetClassName())~=receipt.class
            or tonumber(operation.handle.id)~=receipt.id) then return nil,'cleanup-vehicle-command-binding-changed' end
        return operation
    end
    function api.cancelVehicle(operation,bound) return chauffeur.stop(operation,bound.car) end
    function api.vehicleReceipt(operation) return chauffeur.driveReceipt(operation) end
    function api.restore(receipt,bound)
        local operation=transport.retiredCommand(receipt,bound.entry.npc,false)
        transport.commandState(operation)
        if operation.handle then
            local mount=operation.handle.mountData
            if not mount or id(mount.mountParentEntityId)~=bound.car.id
                or NameToString(mount.slotName)~='seat_front_left' then
                return nil,'cleanup-command-binding-changed'
            end
        end
        return operation
    end
    api.commandState=transport.commandState
    api.cancel=transport.cancel
    api.commandReceipt=transport.commandReceipt
    function api.unmount(bound) return transport.mount(bound.entry,bound.car,'seat_front_left',true) end
    function api.delete(bound,requested)
        local entry=bound.entry
        if requested then return not entry.system:IsManaged(entry.entityID),true end
        if beforeRemove then pcall(beforeRemove,id(entry.entityID)) end
        local accepted=entry.system:DeleteEntity(entry.entityID)==true
        return accepted and not entry.system:IsManaged(entry.entityID),accepted
    end
    return api
end
function M.new(api,transport,chauffeur,beforeRemove)
    return {api=api or nativeApi(transport,chauffeur,beforeRemove),phase='idle',loaded=false,
        clock=0,pollAt=0,attempts=0,stopAttempts=0,brakeAttempts=0,probes=0}
end
function M.load(s)
    if s.loaded then return end
    s.loaded=true
    local file=io.open(PATH,'rb'); if not file then return end
    local raw=file:read(MAX_BYTES+1); file:close()
    if raw==nil or raw=='' then return end
    local ok,value=pcall(json.decode,raw or '')
    if not ok or type(raw)~='string' or #raw>MAX_BYTES or not valid(value,os.time()) then
        finish(s,'rejected','invalid-or-expired-receipt'); return
    end
    s.receipt,s.phase,s.attempts=value,'waiting-for-world',value.attempts or 0
end
function M.captureSeated(s,player,npc)
    M.load(s)
    if s.receipt then return false,'A previous driver cleanup is still pending.' end
    local entry,car,operation=safe(s.api.seated,player,npc)
    if not entry then return false,car or 'native-companion-ownership-unavailable' end
    return M.capture(s,player,entry,car,operation)
end
function M.capture(s,player,entry,car,operation,driveOperation)
    if s.receipt then return false,'A previous driver cleanup is still pending.' end
    local tag=PREFIX..tostring(os.time())..'_'..tostring(math.random(100000000,999999999))
    local value,why=safe(s.api.capture,player,entry,car,operation,tag,driveOperation)
    if not value or not valid(value,os.time()) then return false,why or 'cleanup-receipt-unavailable' end
    if not store(value) then return false,'cleanup-receipt-write-failed' end
    s.receipt,s.phase,s.loaded=value,'recorded-for-reload',true
    return true
end
function M.update(s,player,delta,worldReady)
    M.load(s)
    if not s.receipt or not worldReady then return end
    local step=tonumber(delta) or 0
    if step~=step or step<0 then step=0 end
    s.clock=s.clock+math.min(step,1)
    if s.clock<s.pollAt then return end
    s.pollAt=s.clock+.5; s.probes=s.probes+1
    if os.time()>=s.receipt.expiresAt or s.probes>7200 then finish(s,'expired','cleanup-window-expired'); return end
    local bound,why,fatal=safe(s.api.sample,player,s.receipt,s.carID,s.actorID)
    if not bound then
        s.error=why
        if fatal then finish(s,'rejected',why) end
        return
    end
    if bound.deleting then
        s.actorID=bound.actorID
        if bound.deleted then finish(s,'complete') else s.phase='waiting-for-despawn' end
        return
    end
    s.carID=bound.car.entityID
    s.actorID=bound.entry and bound.entry.entityID or s.actorID
    -- Retire the lead-car command while V is still a passenger. Waiting for V
    -- to leave first would leave an old Lua owner's route driving unattended.
    -- Scene/foreign-control checks still precede every cleanup mutation.
    if s.receipt.vehicleCommand then
        bound.driveReceipt=s.receipt.vehicleCommand
        if bound.blocked then s.phase,s.error='waiting-for-safe-exit','native-scene-or-combat'; return end
        if not s.vehicleOperation then
            s.vehicleOperation,why=safe(s.api.restoreVehicle,s.receipt.vehicleCommand,bound)
            if not s.vehicleOperation then finish(s,'rejected',why or 'cleanup-vehicle-command-unavailable'); return end
            s.vehicleCommandAt=s.clock
        end
        bound.vehicleOperation=s.vehicleOperation
        local state=safe(s.api.commandState,s.vehicleOperation)
        if not terminal(state) then
            s.phase='cancelling-retired-vehicle-command'
            safe(s.api.cancelVehicle,s.vehicleOperation,bound)
            if not bound.playerDriver and not bound.foreignVehicle and not bound.autoEnabled
                and s.brakeAttempts<MAX_ATTEMPTS and s.clock>=(s.brakeAt or 0) then
                s.brakeAttempts=s.brakeAttempts+1; s.brakeAt=s.clock+4; safe(s.api.brake,bound)
            end
            local receipt=safe(s.api.vehicleReceipt or s.api.commandReceipt,s.vehicleOperation)
            if vehicleReceipt(receipt) then s.receipt.vehicleCommand=receipt; store(s.receipt) end
            if s.clock-s.vehicleCommandAt>12 then s.error='native-vehicle-command-did-not-stop' end
            return
        end
        -- A terminal command can leave an owned car rolling. Keep its plain
        -- fixed-car stop receipt until stopped evidence, including with V still
        -- in a passenger seat. Braking never inherits foreign/V-driver control.
        if bound.playerDriver or bound.foreignVehicle or bound.autoEnabled then
            s.phase,s.error='waiting-for-native-stop','another-vehicle-owner'; return
        end
        if type(bound.info.speed)~='number' or bound.info.speed~=bound.info.speed or bound.info.speed>.25 then
            s.phase='waiting-for-stopped-car'
            if s.brakeAttempts<MAX_ATTEMPTS and s.clock>=(s.brakeAt or 0) then
                s.brakeAttempts=s.brakeAttempts+1; s.brakeAt=s.clock+4; safe(s.api.brake,bound)
            end
            return
        end
        s.vehicleOperation,s.vehicleCommandAt,s.receipt.vehicleCommand=nil,nil,nil
        if not store(s.receipt) then finish(s,'failed','cleanup-progress-write-failed'); return end
    end
    if bound.foreignVehicle then s.phase,s.error='waiting-for-native-stop','another-vehicle-command-owner'; return end
    if bound.playerDriver or bound.playerAboard then s.phase,s.error='waiting-for-player-exit',nil; return end
    if not bound.autoMatches then s.phase,s.error='waiting-for-native-stop','another-autodrive-owner'; return end
    if bound.autoEnabled then
        s.phase='waiting-for-native-stop'
        if s.stopAttempts<MAX_ATTEMPTS and s.clock>=(s.stopAt or 0) then
            s.stopAttempts=s.stopAttempts+1; s.stopAt=s.clock+1
            local done,reason=safe(s.api.stop,player,bound); if not done then s.error=reason end
        end
        return
    end
    if bound.blocked then s.phase,s.error='waiting-for-safe-exit','native-scene-or-combat'; return end
    if not bound.info.speed or bound.info.speed>.25 then
        s.phase='waiting-for-stopped-car'
        if s.brakeAttempts<MAX_ATTEMPTS and s.clock>=(s.brakeAt or 0) then
            s.brakeAttempts=s.brakeAttempts+1; s.brakeAt=s.clock+4; safe(s.api.brake,bound)
        end
        return
    end
    if s.receipt.command then
        if not s.operation then
            s.operation,why=safe(s.api.restore,s.receipt.command,bound)
            if not s.operation then finish(s,'rejected',why or 'cleanup-command-unavailable'); return end
            s.commandAt=s.clock
        end
        local state=safe(s.api.commandState,s.operation)
        if not terminal(state) then
            -- A current/recovered unmount is allowed to finish its animation.
            -- Mount handlers are retired immediately; unmount handlers retire
            -- after the real seat link clears, or at the bounded timeout.
            if s.receipt.command.class=='AIUnmountCommand' and bound.driverMounted
                and s.clock-s.commandAt<=12 then s.phase='unmounting-driver'; return end
            s.phase='cancelling-retired-command'
            safe(s.api.cancel,s.operation)
            local receipt=safe(s.api.commandReceipt,s.operation)
            if commandReceipt(receipt) then s.receipt.command=receipt; store(s.receipt) end
            if s.clock-s.commandAt>12 then s.phase,s.error='failed','native-command-did-not-stop'; s.receipt=nil; erase() end
            return
        end
        s.operation,s.receipt.command,s.commandAt=nil,nil,nil
        if not store(s.receipt) then finish(s,'failed','cleanup-progress-write-failed'); return end
    end
    if bound.driverMounted then
        if s.attempts>=MAX_ATTEMPTS then finish(s,'failed','native-unmount-did-not-complete'); return end
        s.attempts=s.attempts+1
        s.receipt.attempts=s.attempts
        local operation,reason=safe(s.api.unmount,bound)
        local receipt=operation and safe(s.api.commandReceipt,operation)
        if not operation or not receipt or not commandReceipt(receipt) then
            finish(s,'failed',reason or 'native-unmount-receipt-unavailable'); return
        end
        s.operation,s.receipt.command,s.commandAt=operation,receipt,s.clock
        s.phase='unmounting-driver'
        if not store(s.receipt) then finish(s,'failed','cleanup-progress-write-failed') end
        return
    end
    if bound.driverExiting then s.phase='waiting-for-driver-exit'; return end
    local deleted,accepted=safe(s.api.delete,bound,s.receipt.deleteRequested==true)
    if deleted then finish(s,'complete'); return end
    if accepted then
        s.receipt.deleteRequested=true; s.phase='waiting-for-despawn'
        if not store(s.receipt) then finish(s,'failed','cleanup-progress-write-failed') end
    else finish(s,'failed','native-driver-deletion-not-accepted') end
end
function M.abandon(s)
    -- Save/death/world detach invalidates this transient authority. No native
    -- component reads or mutations belong in a destruction callback.
    finish(s,'abandoned','world-changed'); s.loaded=true
end
function M.snapshot(s)
    return {active=s.receipt~=nil,phase=s.phase,error=s.error,attempts=s.attempts,
        stopAttempts=s.stopAttempts,brakeAttempts=s.brakeAttempts,probes=s.probes}
end
return M
