-- Managed copies only. World and quest NPCs are never assigned a follower role.
local M = {}
local behavior = dofile('companion-behavior.lua')
local space = dofile('companion-space.lua')
local travel = dofile('companion-travel.lua')
local actuator = dofile('companion-actuator.lua')
local placement = dofile('companion-placement.lua')
local appearance = dofile('companion-appearance.lua')
local spawnRecords = dofile('companion-records.lua')
local equipment = dofile('companion-equipment.lua')
local vehicles = dofile('companion-vehicles.lua')
local vehicleNative = dofile('companion-vehicle-native.lua')
local fleet = vehicles.new(vehicleNative)

local records = {
    ['viktor-vektor'] = {id = 'Character.Victor_Vector', name = 'Viktor Vektor'},
    ['misty-olszewski'] = {id = 'Character.Misty', name = 'Misty Olszewski'},
    ['judy-alvarez'] = {id = 'Character.Judy', name = 'Judy Alvarez'},
    ['panam-palmer'] = {id = 'Character.Panam', name = 'Panam Palmer'},
}
for key, definition in pairs(records) do definition.profileKey = key end

-- Conversation profiles and spawnable phone contacts are separate catalogs.
-- Every spawned entry is still a new managed copy, never a quest-world actor.
local phoneContacts = {}
do
    local file = io.open('phone-contacts.json', 'rb')
    if file then
        local raw = file:read('*a')
        file:close()
        local ok, catalog = pcall(json.decode, raw)
        if ok and type(catalog) == 'table' then
            for _, contact in ipairs(catalog) do
                if type(contact.contact) == 'string' then
                    phoneContacts[contact.contact] = contact
                    if type(contact.key) == 'string' and type(contact.record) == 'string' then
                        records[contact.key] = {id = contact.record, name = contact.name, profileKey = contact.key}
                    end
                end
            end
        end
    end
end

-- A model and a conversation identity are independent. Only definitions with
-- an explicit profileKey participate in conversation routing or connections.
function M.registerDefinition(key, definition)
    if type(key) ~= 'string' or key == '' or type(definition) ~= 'table' then
        return false, 'Invalid companion definition.'
    end
    local id = definition.id or definition.record
    if (type(id) ~= 'string' or id == '') and not definition.recordID then
        return false, 'This model has no character record.'
    end
    if definition.profileKey ~= nil and (type(definition.profileKey) ~= 'string' or definition.profileKey == '') then
        return false, 'Invalid conversation profile.'
    end
    records[key] = {id = id, recordID = definition.recordID,
        name = tostring(definition.name or id or key),
        profileKey = definition.profileKey, profileName = definition.profileName}
    return true
end

function M.definition(key)
    local value = records[key]
    if not value then return nil end
    return {id = value.id, recordID = value.recordID, name = value.name,
        profileKey = value.profileKey, profileName = value.profileName}
end

function M.phoneContactKey(contactId)
    local contact = phoneContacts[contactId]
    if not contact then return nil, 'This contact has no companion mapping yet.' end
    if contact.unavailable then return nil, contact.unavailable end
    if not TweakDB:GetRecord(contact.record) then return nil, 'Character unavailable in this game installation.' end
    return contact.key, nil, contact.name
end

function M.registerPhoneContacts(player)
    player:ConvaiPhoneClearContacts()
    for id, contact in pairs(phoneContacts) do
        local key, reason = M.phoneContactKey(id)
        player:ConvaiPhoneRegisterContact(id, contact.name, key and '' or reason)
    end
end


local slots = space.slots
local entries, serial = {}, 0
local elapsed, runtimeClock, commandCursor = 0, 0, 0
local groupFrame
local transit
local vehicleHooks = {
    release = function(entry)
        equipment.release(entry.equipment)
        if entry.equipment and entry.equipment.phase ~= 'released' then return false end
        return not entry.motor or actuator.release(entry.motor)
    end,
    resumed = function(entry)
        entry.motor = actuator.new(entry.npc)
        entry.equipment = equipment.new(entry.npc)
        entry.person = behavior.new(entry.serial)
        entry.position = nil
    end,
}
local function distance(a,b) return space.distance(a,b) end
local function copyPosition(p) return Vector4.new(p.x,p.y,p.z,p.w or 1) end
local function formationPosition(player,slot)
    local direction=groupFrame and groupFrame.direction or player:GetWorldForward()
    local point=space.offset(space.copy(player:GetWorldPosition()),direction,slots[slot][1],slots[slot][2])
    return copyPosition(point)
end

local function attachFollower(entry, player)
    local npc = entry.system:GetEntity(entry.entityID)
    if not npc or not npc:IsAttached() then return nil, 'Awaiting entity attachment' end
    if not npc:IsA('NPCPuppet') then return false, 'This model is not a controllable NPC.' end
    if npc:IsCrowd() then return false, 'Managed copy unexpectedly joined the crowd' end
    local actual = npc:GetWorldPosition()
    entry.spawnActual = copyPosition(actual)
    if math.abs(actual.z-entry.spawnPosition.z) > 0.9 or distance(actual, entry.spawnPosition) > 2.0 then
        return false, 'The game placed this copy away from the verified ground. Invitation cancelled.'
    end
    local ai = npc:GetAIControllerComponent()
    if not ai then return false, 'This model has no companion-compatible AI controller.' end
    local current = ai:GetAIRole()
    if current and not current:IsA('AINoRole') then
        entry.state = 'failed'
        entry.error = 'This model requires its authored AI role and cannot follow safely.'
        return false, entry.error
    end
    entry.phantomControllersDisabled = appearance.prepare(npc)
    local role = NewObject('AIFollowerRole')
    role.followerRef = Game.CreateEntityReference('#player', {})
    ai:SetAIRole(role)
    ai:OnAttach()
    npc.isPlayerCompanionCachedTimeStamp = 0
    entry.npc = npc
    entry.role = role
    entry.state = 'ready'
    entry.motor = actuator.new(npc)
    entry.equipment = equipment.new(npc)
    entry.person = behavior.new(entry.serial)
    entry.lane = entry.lane or entry.slot
    -- The formation decision below chooses the first command. Starting an
    -- unconditional follow here makes a correctly placed spawn walk into V.
    return true
end

local function spawnCopy(key, invitation, returning)
    local definition = returning and {id=returning.record,recordID=returning.modelRecordID,
        name=returning.name,profileKey=returning.profileKey,profileName=returning.profileName} or records[key]
    if not definition then return nil, 'Unknown companion' end
    -- Production installs a preparation guard. Keep the engine mutation behind
    -- the exact invitation even if an older menu or diagnostic calls spawn.
    if not returning and M.canSpawn then
        local checked, allowed, reason = pcall(M.canSpawn, key, invitation)
        if not checked or allowed ~= true then
            return nil, checked and reason or 'Companion preparation is unavailable.'
        end
    end
    if not returning and #entries >= #slots then return nil, 'Your party has eight copies. Dismiss one first.' end
    local player = Game.GetPlayer()
    local system = Game.GetDynamicEntitySystem()
    if not player or not system or not system:IsReady() then return nil, 'World is not ready' end
    local recordID = definition.recordID or TweakDBID.new(definition.id)
    local recordOk, record = pcall(function() return TweakDB:GetRecord(recordID) end)
    if not recordOk or not record then return nil, 'This model is not available in your installation.' end
    local typeOk, character = pcall(function() return record:IsA('gamedataCharacter_Record') end)
    if not typeOk or not character then return nil, 'This record is not a character model.' end
    if not groupFrame then
        local ok, _, view = pcall(function() return Game.GetTargetingSystem():GetCrosshairData(player) end)
        local forward = ok and view or player:GetWorldForward()
        if not forward then forward = player:GetWorldForward() end
        groupFrame = travel.new(space.copy(player:GetWorldPosition()), forward)
        commandCursor = 0
    end
    local occupied, lanes = {}, {}
    for _, entry in ipairs(entries) do occupied[entry.slot] = true; lanes[entry.lane or entry.slot] = true end
    local freeSlot, freeLane=returning and returning.slot,returning and returning.lane
    for slot = 1, #slots do
        if not freeSlot and not occupied[slot] then freeSlot = slot; break end
    end
    for slot = 1, #slots do
        if not freeLane and not lanes[slot] then freeLane = slot; break end
    end
    if not freeSlot then return nil, 'Party is full' end
    local occupiedPositions = {}
    for _, member in ipairs(entries) do
        if member.state == 'ready' and member.npc and member.npc:IsAttached() then
            occupiedPositions[#occupiedPositions + 1] = member.npc:GetWorldPosition()
        elseif member.state == 'spawning' then
            occupiedPositions[#occupiedPositions + 1] = member.spawnPosition
        end
    end
    local spawnPosition, placementError = placement.find(player, formationPosition(player, freeLane), occupiedPositions)
    if not spawnPosition then return nil, placementError end
    local spawnRecord, recordError, spawnRecordName = spawnRecords.resolve(recordID)
    if not spawnRecord then return nil, recordError end
    local spec = NewObject('DynamicEntitySpec')
    spec.recordID = spawnRecord
    spec.position = spawnPosition
    spec.orientation = player:GetWorldOrientation()
    spec.spawnInView = true
    spec.active = true
    spec.alwaysSpawned = true
    spec.persistState, spec.persistSpawn = false, false
    -- Native facial setup uses this tag before attachment. It never replaces
    -- an ambient or quest actor's graph based only on their character record.
    spec.tags = {CName.new('CyberpunkConvaiCompanion')}
    local created, entityID = pcall(function() return system:CreateEntity(spec) end)
    if not created or not entityID or tostring(entityID.hash):match('^0+[uUlL]*$') then
        return nil, 'The game could not create a copy of this model.'
    end
    if not returning then serial = serial + 1 end
    local assignedKey, assignedName = definition.profileKey, definition.profileName or definition.name
    if invitation then assignedKey, assignedName = invitation.profileKey, invitation.profileName or definition.name end
    local entry = {
        serial = returning and returning.serial or serial, key = key, name = definition.name, slot = freeSlot, lane = freeLane,
        profileKey = assignedKey, profileName = assignedName,
        record = definition.id or tostring(recordID),
        modelRecordID = recordID,
        spawnRecord = spawnRecordName or definition.id or tostring(recordID),
        entityID = entityID, system = system, state = 'spawning',
        requestedAt = os.time(), requestedClock = runtimeClock,
        spawnPosition = copyPosition(spawnPosition),
        person = behavior.new(returning and returning.serial or serial),
        transitRecreated = returning ~= nil,
    }
    if returning then
        for index,prior in ipairs(entries) do if prior==returning then entries[index]=entry; break end end
    else entries[#entries + 1] = entry end
    -- Transfer the invitation's prepared connection to the attaching copy.
    if M.onPartyChanged then pcall(M.onPartyChanged) end
    return entry.serial
end
function M.spawn(key,invitation) return spawnCopy(key,invitation) end

function M.setProfile(serialToAssign, key, name)
    if key ~= nil and (type(key) ~= 'string' or key == '') then
        return false, 'Invalid conversation profile.'
    end
    for _, entry in ipairs(entries) do
        if entry.serial == serialToAssign then
            entry.profileKey = key
            entry.profileName = key and (name or key) or entry.name
            if M.onPartyChanged then pcall(M.onPartyChanged) end
            return true
        end
    end
    return false, 'That companion is no longer in your party.'
end

local function deleteOwnedCopy(entry)
    if entry.removed then return true end
    local ready,available=pcall(function() return entry.system:IsReady() end)
    if not ready or not available then return false end
    local checked, managed = pcall(function() return entry.system:IsManaged(entry.entityID) end)
    if checked and not managed then entry.removed = true; return true end
    if not checked then return false end
    local tagged,ours=pcall(function() return entry.system:IsTagged(entry.entityID,CName.new('CyberpunkConvaiCompanion')) end)
    if not tagged or not ours then return false end
    -- Notify exactly once while the managed entity still exists, before its
    -- asynchronous despawn. Completion polls must not touch retired playback.
    if not entry.removalNotified then
        entry.removalNotified=true
        if M.onBeforeRemove then pcall(M.onBeforeRemove,tostring(entry.entityID.hash)) end
    end
    if entry.deleteRequested then return false,true end
    local removed, result = pcall(function() return entry.system:DeleteEntity(entry.entityID) end)
    if removed and result == true then
        entry.deleteRequested=true
        local confirmed,remaining=pcall(function() return entry.system:IsManaged(entry.entityID) end)
        if confirmed and not remaining then entry.removed=true; return true end
        return false,true
    end
    return false
end


function M.dismiss(serialToDismiss)
    for index,entry in ipairs(entries) do
        if entry.serial==serialToDismiss then
            local checked,managed,ours=pcall(function()
                if not entry.system or not entry.system:IsReady() then error('World is not ready') end
                local managed=entry.system:IsManaged(entry.entityID)
                return managed,not managed or entry.system:IsTagged(entry.entityID,CName.new('CyberpunkConvaiCompanion'))
            end)
            if not checked or not ours then
                entry.error='Companion ownership could not be confirmed. Dismissal was not sent.'
                return false,entry.error
            end
            if managed then
                if entry.equipment then equipment.release(entry.equipment) end
                if entry.motor and entry.npc and entry.npc:IsAttached() then
                    pcall(actuator.release,entry.motor)
                end
                if entry.npc and entry.npc:IsAttached() and entry.role then
                    pcall(function()
                        local ai=entry.npc:GetAIControllerComponent()
                        entry.role:OnRoleCleared(entry.npc)
                        ai:SetAIRole(NewObject('AINoRole')); ai:OnAttach()
                    end)
                end
            end
            local deleted,pending=deleteOwnedCopy(entry)
            if pending then
                entry.state,entry.error='leaving',nil
                vehicles.removing(fleet,entry.serial)
                return true
            end
            if not deleted then
                entry.state,entry.error='failed','The game could not dismiss this copy. Try again after closing other menus.'
                return false,entry.error
            end
            vehicles.remove(fleet, entry.serial)
            table.remove(entries,index)
            if #entries==0 then groupFrame=nil end
            if M.onPartyChanged then pcall(M.onPartyChanged) end
            return true
        end
    end
    return false
end
function M.dismissAll()
    local result=true
    for index=#entries,1,-1 do if not M.dismiss(entries[index].serial) then result=false end end
    return result
end
function M.owns(npc)
    if not npc then return false end
    local ok,id=pcall(function() return tostring(npc:GetEntityID().hash) end)
    if not ok then return false end
    for _,entry in ipairs(entries) do
        if entry.state=='ready' and tostring(entry.entityID.hash)==id then return true end
    end
    return false
end
function M.ownsTravelCommand(npc,command)
    if not npc or not command then return false end
    local id=tostring(npc:GetEntityID().hash)
    for _,entry in ipairs(entries) do
        if entry.state=='ready' and tostring(entry.entityID.hash)==id and entry.motor then
            return actuator.ownsTravel(entry.motor,command) and true or false
        end
    end
    return false
end

function M.identity(npc)
    if not npc then return nil end
    local ok, identity = pcall(function() return tostring(npc:GetEntityID().hash) end)
    if not ok then return nil end
    for _, entry in ipairs(entries) do
        if tostring(entry.entityID.hash) == identity then
            return entry.state == 'ready' and entry.profileKey or nil,
                entry.profileKey and entry.profileName or entry.name, true
        end
    end
    return nil
end

function M.connectionProfiles()
    local ordered, result, seen = {}, {}, {}
    for _, entry in ipairs(entries) do ordered[#ordered + 1] = entry end
    table.sort(ordered, function(a, b) return a.slot < b.slot end)
    for _, entry in ipairs(ordered) do
        local alive = entry.state == 'spawning'
        if entry.state == 'ready' then
            local ok, attached = pcall(function()
                return entry.npc:IsAttached() and not entry.npc:IsDeadNoStatPool()
            end)
            alive = ok and attached
        end
        if alive and entry.profileKey and not seen[entry.profileKey] then
            result[#result + 1] = entry.profileKey
            seen[entry.profileKey] = true
        end
    end
    return result
end

function M.conversationCandidates(player, radius)
    local result = {}
    if not player then return result end
    local origin = player:GetWorldPosition()
    for _, entry in ipairs(entries) do
        if entry.profileKey and entry.state == 'ready' and entry.npc and entry.npc:IsAttached() and not entry.npc:IsDeadNoStatPool() then
            local pos = entry.npc:GetWorldPosition()
            local distance = math.sqrt((pos.x-origin.x)^2 + (pos.y-origin.y)^2 + (pos.z-origin.z)^2)
            if distance <= radius then
                result[#result + 1] = {npc = entry.npc, entity = tostring(entry.entityID.hash),
                    profileKey = entry.profileKey, name = entry.profileName,
                    bodyType = tostring(entry.npc:GetBodyType() or ''), distance = distance}
            end
        end
    end
    table.sort(result, function(a, b)
        if a.distance == b.distance then return a.entity < b.entity end
        return a.distance < b.distance
    end)
    return result
end


-- Menu snapshots read cached values only. Never query native command handles here.
function M.list()
    local rows,totals,seen={},{},{}
    for _,e in ipairs(entries) do totals[e.key]=(totals[e.key] or 0)+1 end
    for _,e in ipairs(entries) do
        seen[e.key]=(seen[e.key] or 0)+1
        local p,m=e.person or {},e.motor or {}
        local f=m.feedback or {}
        local phase=p.phase
        local focused=phase and phase:find('attend',1,true)~=nil or false
        rows[#rows+1]={
            serial=e.serial,key=e.key,name=e.name..(totals[e.key]>1 and (' #'..seen[e.key]) or ''),
            profileKey=e.profileKey,profileName=e.profileName,record=e.record,slot=e.slot,lane=e.lane,
            spawnRecord=e.spawnRecord,
            entityID=tostring(e.entityID.hash),state=e.state,error=e.error,
            behavior=phase,behaviorReason=p.reason,behaviorTrace=p.trace,
            mode=m.stage=='orient' and 'route-turn' or (focused and 'busy' or phase),
            playerSpeed=groupFrame and groupFrame.rawSpeed or 0,
            playerRunning=groupFrame and groupFrame.running or false,
            playerMoving=groupFrame and groupFrame.moving or false,
            groupIntent=groupFrame and (groupFrame.localInteraction and 'local-interaction'
                or (groupFrame.moving and 'travelling' or 'resting')) or 'resting',
            travelDirection=groupFrame and space.copy(groupFrame.direction) or nil,
            playerPosition=groupFrame and space.copy(groupFrame.position) or nil,
            stopID=groupFrame and groupFrame.stop or 0,
            npcSpeed=e.speed,maxNpcSpeed=e.maxSpeed,maxPlayerSpeed=e.maxPlayerSpeed,
            distanceToPlayer=e.playerGap,distanceToSeat=e.targetGap,facingErrorDegrees=e.facingError,
            actualSpawnZ=e.spawnActual and e.spawnActual.z,spawnZ=e.spawnPosition.z,
            npcZ=e.position and e.position.z,playerZ=groupFrame and groupFrame.position.z,
            phantomControllersDisabled=e.phantomControllersDisabled,
            equipment=equipment.snapshot(e.equipment),
            transport=vehicles.snapshot(fleet,e.serial).people[1],
            focused=focused,focusLook=m.lookStyle=='full',ambientLook=m.lookStyle=='side',
            lookError=m.lookError,
            eyeContactHeight=m.lookHeight,headFollowStrength=m.lookStrength,
            holding=m.kind=='hold',requestedGait=m.gait,routeTurning=m.stage=='orient',
            focusStepDone=p.attentionAnchor~=nil,
            acceptedPosition=p.parked and space.copy(p.parked),
            arrivalGoal=p.arrivalGoal and space.copy(p.arrivalGoal),
            operation={ticket=f.ticket,kind=f.kind,state=f.state,stage=f.stage,
                target=f.target,active=f.active,complete=f.complete,failed=f.failed,
                stalled=f.stalled,suspended=f.suspended,error=f.error,commands=m.commands,commandID=f.commandID},
            commandTrace=m.events,
        }
    end
    return rows
end

function M.abandon(preserveTransit)
    -- Native components may already be torn down. Dropping references is enough:
    -- these DynamicEntitySystem copies are explicitly nonpersistent.
    for _,entry in ipairs(entries) do
        if entry.motor then actuator.abandon(entry.motor) end
        if entry.equipment then equipment.abandon(entry.equipment) end
    end
    if not preserveTransit then entries={}; transit=nil end
    elapsed,runtimeClock,commandCursor=0,0,0
    groupFrame=nil
    vehicles.abandon(fleet)
end

function M.vehicleSnapshot() return vehicles.snapshot(fleet) end

function M.beginFastTravel()
    if transit then return false end
    local party={}
    for _,entry in ipairs(entries) do
        local eligible=entry.state=='spawning'
        if entry.state=='ready' then
            local ok,alive=pcall(function() return entry.npc:IsAttached() and not entry.npc:IsDeadNoStatPool() end)
            eligible=ok and alive
        end
        if eligible then
            -- This runs before TeleportToNode. Cancellation is allowed here;
            -- OnDetach itself only discards references.
            if entry.equipment then pcall(equipment.release,entry.equipment) end
            if entry.motor then pcall(actuator.release,entry.motor) end
            local commands={}
            for _,owner in ipairs({entry.equipment or {},entry.motor or {}}) do
                if owner.command then
                    commands[#commands+1]=vehicleNative.commandReceipt({handle=owner.command,
                        cancelRequested=owner.cancellation and owner.cancellation.requested==true})
                end
            end
            party[#party+1]={serial=entry.serial,key=entry.key,name=entry.name,slot=entry.slot,lane=entry.lane,
                profileKey=entry.profileKey,profileName=entry.profileName,record=entry.record,
                modelRecordID=entry.modelRecordID,spawnRecord=entry.spawnRecord,entityID=entry.entityID,
                state='transit',spawnPosition=space.copy(entry.spawnPosition),
                retiredCommands=commands,
                transitError=entry.motor and entry.motor.look and 'The previous gaze request could not be released.' or nil}
        end
        if entry.motor then actuator.abandon(entry.motor) end
        if entry.equipment then equipment.abandon(entry.equipment) end
    end
    transit={phase='loading',clock=0,fleet=vehicles.suspend(fleet)}
    entries=party; groupFrame=nil; elapsed=0
    return true
end

function M.fastTravel()
    -- Loading-screen callbacks without the matching before-request are inert.
    if not transit or transit.phase~='loading' then return false end
    transit.phase='recovering'
    return true
end

local function recoverTransit(player,step)
    if not transit then return false end
    if transit.phase~='recovering' then return true end
    transit.clock=transit.clock+step
    local system=Game.GetDynamicEntitySystem()
    if not system or not system:IsReady() then return true end
    if not groupFrame then groupFrame=travel.new(space.copy(player:GetWorldPosition()),player:GetWorldForward()) end
    local waiting=false
    for _,entry in ipairs(entries) do
        if entry.state=='transit' and transit.clock>=(entry.retryAt or 0) then
            local ok,err=pcall(function()
                entry.system=system
                if not system:IsManaged(entry.entityID) then
                    -- A transit receipt is the only internal admission token.
                    -- The ordinary public spawn still requires preparation.
                    if (entry.spawnAttempts or 0)>=3 then
                        entry.state,entry.error='failed',entry.error or 'This copy could not return after fast travel.'; return
                    end
                    entry.spawnAttempts=(entry.spawnAttempts or 0)+1; entry.retryAt=transit.clock+2
                    local created,reason=spawnCopy(entry.key,{profileKey=entry.profileKey,profileName=entry.profileName},entry)
                    if not created then entry.error=reason end
                    return
                end
                if not system:IsTagged(entry.entityID,CName.new('CyberpunkConvaiCompanion')) then
                    entry.state,entry.error='failed','Companion ownership changed during fast travel.'; return
                end
                local npc=system:GetEntity(entry.entityID)
                if not npc or not npc:IsAttached() then
                    entry.error='Waiting for the existing copy after fast travel.'
                    if transit.clock>=12 then entry.state='failed' end
                    return
                end
                entry.npc,entry.system=npc,system
                if npc:IsDeadNoStatPool() then entry.state='dead'; entry.error='This copy died during fast travel.'; return end
                if entry.transitError then entry.state,entry.error='failed',entry.transitError; return end
                local ai=npc:GetAIControllerComponent()
                if not ai or not npc:IsA('NPCPuppet') or npc:IsCrowd() then
                    entry.state,entry.error='failed','The existing copy cannot safely follow after fast travel.'; return
                end
                for _,receipt in ipairs(entry.retiredCommands) do
                    local operation=vehicleNative.retiredCommand(receipt,npc,false)
                    if not vehicleNative.cancel(operation) then
                        receipt.cancelRequested=operation.cancelRequested==true
                        entry.error='Waiting for the previous companion command to stop.'
                        if transit.clock>=12 then entry.state='failed' end
                        return
                    end
                end
                local role=ai:GetAIRole()
                if role and not role:IsA('AIFollowerRole') and not role:IsA('AINoRole') then
                    entry.state,entry.error='failed','This copy now has another native AI role.'; return
                end
                if not role or role:IsA('AINoRole') then
                    role=NewObject('AIFollowerRole'); role.followerRef=Game.CreateEntityReference('#player',{})
                    ai:SetAIRole(role); ai:OnAttach()
                end
                entry.role=role; vehicleHooks.resumed(entry)
                entry.state,entry.error,entry.retiredCommands='ready',nil,nil
            end)
            if not ok then
                entry.error=tostring(err)
                if transit.clock>=12 then entry.state='failed' end
            end
        end
        if entry.state=='transit' or entry.state=='spawning' then waiting=true end
    end
    if waiting then return true end
    local ready={}
    for _,entry in ipairs(entries) do if entry.state=='ready' then ready[#ready+1]=entry end end
    vehicles.resume(fleet,transit.fleet,ready,system)
    transit=nil
    if M.onPartyChanged then pcall(M.onPartyChanged) end
    return false
end

local function peerYieldPoint(at,others,id)
    -- V can deliberately come close to inspect a face or talk. That is not a
    -- request to retreat. Only overlapping owned companions need separation;
    -- spawning and all new route destinations still use ordinary clearance.
    local nearest,gap=nil,0.65
    for _,other in ipairs(others) do
        if other.id~=id and not other.reserved then
            local distance=space.distance(at,other.position)
            if distance<gap then nearest,gap=other.position,distance end
        end
    end
    return nearest and space.offset(at,space.bearing(nearest,at),0,0.5) or nil
end
local function reassignReversal(order)
    -- On an actual sustained U-turn, friends can trade left/right virtual lanes
    -- instead of crossing through V to preserve a mathematical slot.
    for pair=1,4 do
        local left,right
        for _,entry in ipairs(order) do
            if entry.lane==pair*2-1 then left=entry end
            if entry.lane==pair*2 then right=entry end
        end
        if left and right then
            local a=space.candidates(groupFrame,left.lane,groupFrame.position)[1]
            local b=space.candidates(groupFrame,right.lane,groupFrame.position)[1]
            local keep=space.ground(left.position,a)+space.ground(right.position,b)
            local swap=space.ground(left.position,b)+space.ground(right.position,a)
            if swap+0.8<keep then left.lane,right.lane=right.lane,left.lane end
        end
    end
end

function M.update(player,delta,focusEntity)
    if not player then return end
    local dt=tonumber(delta) or 0
    elapsed,runtimeClock=elapsed+dt,runtimeClock+dt
    if elapsed<0.1 then return end
    local step=elapsed; elapsed=0
    local playerPosition=space.copy(player:GetWorldPosition())
    local gazeSettings=M.gazeSettings and M.gazeSettings() or nil

    for _,entry in ipairs(entries) do
        if entry.state=='spawning' then
            if entry.system:IsSpawned(entry.entityID) then
                local ok,result,reason=pcall(attachFollower,entry,player)
                if not ok or result==false then entry.state,entry.error='failed',tostring(ok and reason or result) end
            end
            if entry.state=='spawning' and runtimeClock-entry.requestedClock>12 then
                entry.state,entry.error='failed','Spawn timed out'
            end
            if entry.state=='failed' and not deleteOwnedCopy(entry) then
                entry.error=entry.error..' The copy could not be removed; try Dismiss.'
            end
        end
    end
    for index=#entries,1,-1 do
        local entry=entries[index]
        if entry.state=='leaving' then
            local deleted,pending=deleteOwnedCopy(entry)
            if deleted then
                vehicles.remove(fleet,entry.serial); table.remove(entries,index)
                if M.onPartyChanged then pcall(M.onPartyChanged) end
            elseif not pending then entry.state,entry.error='failed','The game could not dismiss this copy.' end
        end
    end
    if #entries==0 then groupFrame=nil end

    if recoverTransit(player,step) then return end

    local ready={}
    for _,entry in ipairs(entries) do
        if entry.state=='ready' then
            if not entry.npc:IsAttached() then
                entry.state='missing'; actuator.abandon(entry.motor)
                equipment.abandon(entry.equipment); vehicles.remove(fleet,entry.serial)
            elseif entry.npc:IsDeadNoStatPool() then
                entry.state='dead'; actuator.abandon(entry.motor)
                equipment.abandon(entry.equipment); vehicles.remove(fleet,entry.serial)
            else ready[#ready+1]=entry end
        end
    end
    -- Service empty fleets too: the last dismissal can leave a car waiting for
    -- native cancellation/empty-seat confirmation after walking has no frame.
    vehicles.update(fleet,player,ready,step,vehicleHooks)
    if not groupFrame then return end
    local lastReversal=groupFrame.reversal
    local order,others,company={},{},{people={},focus=focusEntity}
    -- All people are sensed before anyone is planned: iteration order must not
    -- make later members react to partially updated group state.
    for _,entry in ipairs(ready) do
        if not vehicles.owns(fleet,entry.serial) then
                local at=space.copy(entry.npc:GetWorldPosition())
                entry.speed=entry.position and space.ground(entry.position,at)/step or 0
                entry.position=at
                local forward=entry.npc:GetWorldForward()
                entry.direction=space.unit(forward.x,forward.y)
                entry.maxSpeed=math.max(entry.maxSpeed or 0,entry.speed)
                entry.playerGap=space.distance(at,playerPosition)
                entry.facingError=space.angle(entry.direction,space.bearing(at,playerPosition))
                actuator.sense(entry.motor,at,entry.speed,step)
                order[#order+1]=entry
                company.people[#company.people+1]={id=tostring(entry.entityID.hash),position=at,
                    phase=entry.person.phase}
                others[#others+1]={id=tostring(entry.entityID.hash),position=at}
        end
    end
    travel.update(groupFrame,playerPosition,step,company)
    if #order==0 then return end
    if lastReversal~=groupFrame.reversal then reassignReversal(order) end
    for _,entry in ipairs(order) do
        entry.maxPlayerSpeed=math.max(entry.maxPlayerSpeed or 0,groupFrame.rawSpeed)
        if entry.motor.target and entry.motor.kind=='move' and not entry.motor.face
            and not entry.motor.feedback.complete and not entry.motor.feedback.failed then
            others[#others+1]={id=tostring(entry.entityID.hash),position=space.copy(entry.motor.target),reserved=true}
        end
    end
    local budget=2
    local first=commandCursor % #order
    commandCursor=commandCursor+1
    for i=1,#order do
        local entry=order[(first+i-1)%#order+1]
        local ok,err=pcall(function()
            local id=tostring(entry.entityID.hash)
            local lane=travel.laneFrame(groupFrame,entry.lane)
            local travelTarget=space.offset(lane.position,lane.direction,slots[entry.lane][1],0)
            local choices=space.candidates(groupFrame,entry.lane)
            local restTarget=choices[1]
            for _,point in ipairs(choices) do
                if space.clear(point,playerPosition,others,id) then restTarget=point; break end
            end
            entry.targetGap=space.distance(entry.position,groupFrame.moving and travelTarget or restTarget)
            local fightingOk,fighting=pcall(function() return NPCPuppet.IsInCombat(entry.npc) end)
            local context={
                id=id,slot=entry.lane,frame=groupFrame,player=player,
                position=entry.position,direction=entry.direction,speed=entry.speed,
                playerGap=entry.playerGap,targetGap=entry.targetGap,facingError=entry.facingError,
                selected=id==focusEntity,combat=fightingOk and fighting==true,
                gazeSettings=gazeSettings,
                motion=entry.motor.feedback,travelTarget=travelTarget,restTarget=restTarget,
                comfortable=space.comfortable(entry.position,groupFrame,entry.lane,others,id),
                nearGroup=space.nearGroup(entry.position,groupFrame,entry.lane,others,id),
                yieldTarget=peerYieldPoint(entry.position,others,id),others=others,
            }
            local decision=behavior.decide(entry.person,context,step)
            -- Braking is already a committed stop. Never choose an alternative
            -- behind the actor if its original stop point becomes unavailable.
            if decision.phase=='approach' then context.alternatives=choices end
            -- Admission requires stopped feet. Once admitted, a small native
            -- holster root motion is allowed; player departure or a new walking
            -- decision still ends the handoff immediately.
            local idle=(entry.speed<0.18 or equipment.holdsMovement(entry.equipment))
                and not groupFrame.moving and (groupFrame.rawSpeed or 0)<0.28
                and decision.operation and decision.operation.kind=='hold' and entry.motor.kind=='hold'
            equipment.update(entry.equipment,player,step,idle,function() return actuator.suspendHold(entry.motor) end)
            if not equipment.holdsMovement(entry.equipment) then
                actuator.resumeHold(entry.motor)
                if actuator.apply(entry.motor,decision,context,budget>0) then budget=budget-1 end
            end
            entry.error=nil
        end)
        if not ok then entry.error=tostring(err) end
    end
end
return M
