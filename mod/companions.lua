-- Managed copies only. World and quest NPCs are never assigned a follower role.
local M = {}
local behavior = dofile('companion-behavior.lua')
local space = dofile('companion-space.lua')
local travel = dofile('companion-travel.lua')
local actuator = dofile('companion-actuator.lua')
local placement = dofile('companion-placement.lua')
local clearance = dofile('companion-clearance.lua')
local appearance = dofile('companion-appearance.lua')
local spawnRecords = dofile('companion-records.lua')
local equipment = dofile('companion-equipment.lua')
local vehicles = dofile('companion-vehicles.lua')
local vehicleNative = dofile('companion-vehicle-native.lua')
local fleet = vehicles.new(vehicleNative)
local reloadCleanupModule,reloadCleanup
local function cleanupOwner()
    if not reloadCleanup then
        reloadCleanupModule=reloadCleanupModule or dofile('companion-reload-cleanup.lua')
        reloadCleanup=reloadCleanupModule.new(nil,vehicleNative,dofile('companion-chauffeur-native.lua'),
            function(entity) if M.onBeforeRemove then pcall(M.onBeforeRemove,entity) end end)
    end
    return reloadCleanup
end
function M.initReloadCleanup()
    reloadCleanupModule=reloadCleanupModule or dofile('companion-reload-cleanup.lua')
    reloadCleanupModule.load(cleanupOwner())
end
function M.reloadCleanupSnapshot()
    return reloadCleanup and reloadCleanupModule.snapshot(reloadCleanup) or {active=false,phase='idle'}
end
local spatialBudget,externalSpatialFrame
local function spatialFrame()
    spatialBudget=clearance.newBudget()
    clearance.useBudget(spatialBudget)
    actuator.useSpatialBudget(spatialBudget)
    placement.useSpatialBudget(spatialBudget)
    vehicleNative.useSpatialBudget(spatialBudget)
    return spatialBudget
end
-- The CET owner calls this before draining queued invitations or updating UI.
-- Standalone/direct update callers receive the same bounded behavior below.
function M.beginSpatialFrame()
    externalSpatialFrame=true
    return spatialFrame()
end
function M.spatialQueryUsage()
    return spatialBudget and {limit=spatialBudget.limit,used=spatialBudget.used,deferred=spatialBudget.deferred}
end

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
        -- Release standing movement/gaze in this same handoff even when the
        -- equipment cancellation needs another frame. Mount owns feet/body
        -- only after BOTH independent controllers have actually released.
        local motorReleased=not entry.motor or actuator.release(entry.motor)
        local equipmentReleased=not entry.equipment or entry.equipment.phase=='released'
        return motorReleased and equipmentReleased
    end,
    resumed = function(entry)
        -- A failed gaze removal must keep its old owner alive until retry.
        -- The fleet catches this error and retains the transport handoff.
        if entry.motor then
            local released,reason=actuator.applyLook(entry.motor,'none')
            if not released then error(reason or 'Waiting for seated attention to release') end
        end
        entry.motor = actuator.new(entry.npc,entry.clearance)
        entry.equipment = equipment.new(entry.npc)
        entry.person = behavior.new(entry.serial)
        entry.position = nil
    end,
}
local function seatedMount(entry,playerMount)
    local transport=vehicles.snapshot(fleet,entry.serial)
    local person=transport.people[1]
    if (transport.phase~='boarding' and transport.phase~='riding') or not person
        or not person.owned or person.phase~='riding' or person.error then
        return nil,'Wait for completed boarding'
    end
    if not playerMount then return nil,'V is no longer mounted' end
    local mount=vehicleNative.mounting(entry)
    if not mount or mount.vehicle~=playerMount.vehicle or mount.seat==playerMount.seat
        or mount.vehicle~=person.vehicle or mount.seat~=person.seat then
        return nil,'Wait for an actual seat in V\'s current vehicle'
    end
    return mount
end
local function seatedAttention(entry,player,focusEntity,gazeSettings,step)
    local context={player=player,gazeSettings=gazeSettings,ready=false,
        selected=tostring(entry.entityID.hash)==focusEntity,reason='No selected seated attention'}
    local ok,err=pcall(function()
        if not context.selected then return end
        local mount,reason=seatedMount(entry,vehicleNative.mounting({npc=player}))
        if not mount then context.reason=reason; return end
        if NPCPuppet.IsInCombat(entry.npc) or player:IsInCombat() then
            context.reason='Native combat owns attention'; return
        end
        -- Installed 2.31 PlayerPuppet exposes its vehicle state directly.
        -- Mount links can already exist during entry and exit animations.
        local state=PlayerPuppet.GetCurrentVehicleState(player)
        if state~=Enum.new('gamePSMVehicle','Driving') and state~=Enum.new('gamePSMVehicle','Passenger') then
            context.reason='Wait for V to finish the vehicle transition'; return
        end
        local car=vehicleNative.player(player)
        if not car or car.id~=mount.vehicle then context.reason='Current vehicle unavailable'; return end
        local velocity=car.entity:GetLinearVelocity()
        context.speed=math.sqrt(velocity.x^2+velocity.y^2+velocity.z^2)
        context.ready,context.vehicle,context.seat=true,mount.vehicle,mount.seat
    end)
    if not ok then context.ready=false; context.reason='Seated attention state unavailable' end
    actuator.applySeatedLook(entry.motor,context,step)
    entry.motor.seatedAttention.error=not ok and tostring(err) or nil
end
local function distance(a,b) return space.distance(a,b) end
local function copyPosition(p) return Vector4.new(p.x,p.y,p.z,p.w or 1) end
local function formationPosition(player,slot)
    local direction=groupFrame and groupFrame.direction or player:GetWorldForward()
    local point=space.offset(space.copy(player:GetWorldPosition()),direction,slots[slot][1],slots[slot][2])
    return copyPosition(point)
end
local function occupiedPositions(except)
    local result={}
    for _,member in ipairs(entries) do
        if member~=except then
            local position
            if member.state=='ready' and member.npc and member.npc:IsAttached() then
                position=member.npc:GetWorldPosition()
            elseif member.state=='spawning' then position=member.spawnPosition end
            if position then result[#result+1]={position=position,clearance=member.clearance} end
        end
    end
    return result
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
    local fits,clearanceError,deferred=placement.verify(player,actual,occupiedPositions(entry),entry.clearance)
    if deferred then return nil,nil,true end
    if not fits then return false,clearanceError end
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
    entry.motor = actuator.new(npc,entry.clearance)
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
    local body=returning and returning.clearance or placement.profile(definition,key)
    local spawnPosition, placementError, deferred = placement.find(player, formationPosition(player, freeLane),occupiedPositions(),body)
    if deferred then return nil,nil,true end
    if not spawnPosition then return nil, placementError end
    local spawnRecord, recordError, spawnRecordName, spawnAppearance = spawnRecords.resolve(recordID)
    if not spawnRecord then return nil, recordError end
    local spec = NewObject('DynamicEntitySpec')
    spec.recordID = spawnRecord
    if spawnAppearance then spec.appearanceName = CName.new(spawnAppearance) end
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
        clearance = body,
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
            local previous = entry.profileKey
            entry.profileKey = key
            entry.profileName = key and (name or key) or entry.name
            -- A reply already requested under the old identity must not be
            -- delivered by this copy as the new one. Name the exact actor.
            if previous ~= key and M.onProfileChanged then
                pcall(M.onProfileChanged, tostring(entry.entityID.hash), previous, key)
            end
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
            -- Removing a seated driver can make the native passenger state
            -- switch V into that seat. Retain the actor and role until the
            -- chauffeur controller has confirmed the trip cleanup.
            local allowed,reason=vehicles.canDismissChauffeurDriver(fleet,entry.serial)
            if not allowed then return false,reason end
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
                if M.bodyAnimation and M.bodyAnimation.release then pcall(M.bodyAnimation.release,entry,'dismissed') end
                if entry.equipment then equipment.release(entry.equipment) end
                if entry.pace and entry.npc and entry.npc:IsAttached() then
                    -- Catch-up pace (see paceFollower) must not outlive the follower.
                    pcall(function()
                        if entry.npc:HasIndividualTimeDilation(CName.new('ConvaiCatchUp')) then
                            entry.npc:UnsetIndividualTimeDilation(CName.new('KereznikovDodgeEaseOut'))
                        end
                    end)
                    entry.pace=nil
                end
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

-- Native targeting can omit occupants. Admit only current managed passengers
-- whose real mount agrees with the transport controller and V's current car.
function M.seatedCandidates(player)
    local result={}
    local ok,playerMount=pcall(vehicleNative.mounting,{npc=player})
    if not ok or not playerMount then return result end
    for _,entry in ipairs(entries) do
        if entry.state=='ready' then
            local valid,mount=pcall(seatedMount,entry,playerMount)
            if valid and mount then result[#result+1]=entry.npc end
        end
    end
    return result
end

-- Some managed models (including visible Johnny copies) have no native target
-- parts. A fallback may use only a current owned copy with a KNOWN empty mount.
-- A nil native MountingInfo is unavailable information, not evidence of on foot.
function M.onFootCandidates()
    local result={}
    for _,entry in ipairs(entries) do
        local ok,eligible=pcall(function()
            local npc,owner=entry.npc,entry.system
            if entry.state~='ready' or not npc or not owner or not owner:IsReady()
                or not npc:IsNPC() or not npc:IsAttached() or npc:IsDeadNoStatPool()
                or tostring(npc:GetEntityID().hash)~=tostring(entry.entityID.hash)
                or not owner:IsManaged(entry.entityID)
                or not owner:IsTagged(entry.entityID,CName.new('CyberpunkConvaiCompanion')) then return false end
            local facility=Game.GetMountingFacility()
            local info=facility and facility:GetMountingInfoSingleWithObjects(npc)
            local parent=info and info.parentId
            return parent and parent.hash~=nil and tostring(parent.hash):match('^0+[uUlL]*$')~=nil
        end)
        if ok and eligible then result[#result+1]=entry.npc end
    end
    return result
end

local sightGroups={'Static','Dynamic','Terrain','Collider','Destructible','Vehicle'}
function M.visibleFromCrosshair(from,to)
    if not spatialBudget or not clearance.isPoint(from) or not clearance.isPoint(to)
        or not clearance.available(#sightGroups) then return false end
    local ok,visible=pcall(function()
        local spatial=Game.GetSpatialQueriesSystem()
        if not spatial then return false end
        local start=Vector4.new(from.x,from.y,from.z,1)
        local finish=Vector4.new(to.x,to.y,to.z,1)
        for _,group in ipairs(sightGroups) do
            if not clearance.take(1) then return false end
            -- CET returns the out TraceResult. Boolean HIT is authoritative;
            -- nil/non-Boolean responses never certify an unobstructed ray.
            local hit=spatial:SyncRaycastByCollisionGroup(start,finish,CName.new(group),false,false)
            if type(hit)~='boolean' or hit then return false end
        end
        return true
    end)
    return ok and visible==true
end


-- Menu snapshots read cached values only. Never query native command handles here.
-- Developer trace reads the same cache for every tracked copy, including copies
-- beyond the conversation radius. No native handle or provider identity escapes.
local function movementNumber(value)
    return type(value)=='number' and value==value and math.abs(value)<1000000000000000 and value or nil
end
local function movementText(value)
    return type(value)=='string' and (value:sub(1,120):gsub('%c',' ')) or nil
end
local function movementPoint(value)
    if not value then return nil end
    local x,y,z=movementNumber(value.x),movementNumber(value.y),movementNumber(value.z)
    return x and y and z and {x=x,y=y,z=z} or nil
end
local function movementRejection(value)
    if type(value)~='table' then return nil end
    local geometry=type(value.geometry)=='table' and value.geometry or nil
    return {group=movementText(value.group or geometry and geometry.group),
        stage=movementText(value.stage),geometryType=movementText(value.geometryType),
        ticket=movementText(value.ticket),leg=movementNumber(value.leg),
        from=movementPoint(value.from),to=movementPoint(value.to),
        origin=movementPoint(value.origin),target=movementPoint(value.target),
        center=movementPoint(value.center or geometry and geometry.center),
        box=movementNumber(value.box),boxes=movementNumber(value.boxes),
        unavailable=value.unavailable==true,nativeLegFailure=value.nativeLegFailure==true}
end
function M.movementSnapshot()
    local frame=groupFrame
    local snapshot={version=1,clock=movementNumber(runtimeClock),
        player=frame and {position=movementPoint(frame.position),
            speed=movementNumber(frame.speed),rawSpeed=movementNumber(frame.rawSpeed),
            moving=frame.moving==true,running=frame.running==true,
            stop=movementNumber(frame.stop),epoch=movementNumber(frame.epoch),
            justStopped=frame.justStopped==true,justDeparted=frame.justDeparted==true} or nil,
        queryBudget=spatialBudget and {used=movementNumber(spatialBudget.used),
            limit=movementNumber(spatialBudget.limit),deferred=movementNumber(spatialBudget.deferred)} or nil,
        copies={}}
    for _,entry in ipairs(entries) do
        local person,motor=entry.person or {},entry.motor or {}
        local feedback=motor.feedback or {}
        local operation=person.operation or {}
        local execution=motor.execution or {}
        local guard=execution.motionGuard or {}
        local route=feedback.route or {}
        local event=motor.events and motor.events[#motor.events] or nil
        -- One sample can hide several command transitions behind lastEvent.
        local recentEvents={}
        for index=math.max(1,#(motor.events or {})-3),#(motor.events or {}) do
            local item=motor.events[index]
            recentEvents[#recentEvents+1]={at=movementNumber(item.at),event=movementText(item.event),
                commandID=movementNumber(item.commandID)}
        end
        local projection=motor.destinationProjection or feedback.destinationProjection
        snapshot.copies[#snapshot.copies+1]={
            serial=movementNumber(entry.serial),key=movementText(entry.key),
            name=movementText(entry.name),profileKey=movementText(entry.profileKey),
            state=movementText(entry.state),lane=movementNumber(entry.lane),
            strandedFor=entry.strandedSince and movementNumber(runtimeClock-entry.strandedSince) or nil,
            relocations=movementNumber(entry.relocations),
            relocationFailures=movementNumber(entry.relocationFailures),
            pace=movementNumber(entry.pace),
            recentEvents=recentEvents,
            actor={position=movementPoint(entry.position),speed=movementNumber(entry.speed),
                playerGap=movementNumber(entry.playerGap),targetGap=movementNumber(entry.targetGap)},
            brain={phase=movementText(person.phase),reason=movementText(person.reason),
                ticket=movementText(operation.ticket),kind=movementText(operation.kind),
                gait=movementText(operation.gait),goal=movementPoint(operation.goal),
                finish=operation.finish==true},
            command={ticket=movementText(feedback.ticket or motor.ticket),
                kind=movementText(feedback.kind or motor.kind),stage=movementText(feedback.stage or motor.stage),
                gait=movementText(motor.gait),state=movementText(feedback.state),
                target=movementPoint(feedback.target or motor.target),
                active=feedback.active==true,complete=feedback.complete==true,
                failed=feedback.failed==true,stalled=feedback.stalled==true,
                waiting=feedback.waiting==true,blocked=feedback.blocked==true,
                cancelling=feedback.cancelling==true,suspended=feedback.suspended==true,
                commandID=movementNumber(feedback.commandID),
                clearanceWaiting=motor.clearanceWaiting==true,
                route={kind=movementText(route.kind),mode=movementText(route.mode or execution.mode),
                    phase=movementText(route.phase or execution.phase),
                    index=movementNumber(route.index or execution.index),
                    total=movementNumber(route.total or execution.points and #execution.points),
                    candidate=movementNumber(route.candidate),
                    progress=movementNumber(guard.progress),
                    projectedAt=movementPoint(guard.position),
                    target=movementPoint(route.target or motor.executionTarget)},
                projection=projection and {requested=movementPoint(projection.requested),
                    point=movementPoint(projection.point),radius=movementNumber(projection.radius),
                    maxShift=movementNumber(projection.maxShift),
                    lateralShift=movementNumber(projection.lateralShift)} or nil,
                lastRejection=movementRejection(motor.lastRejection or feedback.rejection),
                lastEvent=event and {at=movementNumber(event.at),event=movementText(event.event),
                    ticket=movementText(event.ticket),kind=movementText(event.kind),
                    commandID=movementNumber(event.commandID),target=movementPoint(event.target)} or nil}}
    end
    return snapshot
end

function M.list()
    local rows,totals,seen={},{},{}
    for _,e in ipairs(entries) do totals[e.key]=(totals[e.key] or 0)+1 end
    for _,e in ipairs(entries) do
        seen[e.key]=(seen[e.key] or 0)+1
        local p,m=e.person or {},e.motor or {}
        local f=m.feedback or {}
        local attention=m.seatedAttention
        local phase=attention and attention.phase or p.phase
        local focused=phase and phase:find('attend',1,true)~=nil or false
        rows[#rows+1]={
            serial=e.serial,key=e.key,name=e.name..(totals[e.key]>1 and (' #'..seen[e.key]) or ''),
            profileKey=e.profileKey,profileName=e.profileName,record=e.record,slot=e.slot,lane=e.lane,
            spawnRecord=e.spawnRecord,
            entityID=tostring(e.entityID.hash),state=e.state,error=e.error,
            behavior=phase,behaviorReason=attention and attention.reason or p.reason,behaviorTrace=p.trace,
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
            seatedAttention=attention and {phase=attention.phase,reason=attention.reason,error=attention.error,
                vehicle=attention.vehicle,seat=attention.seat,stableFor=attention.stableFor,speed=attention.speed},
            eyeContactHeight=m.lookHeight,headFollowStrength=m.lookStrength,
            holding=m.kind=='hold',requestedGait=m.gait,routeTurning=m.stage=='orient',
            focusStepDone=p.attentionAnchor~=nil,
            acceptedPosition=p.parked and space.copy(p.parked),
            arrivalGoal=p.arrivalGoal and space.copy(p.arrivalGoal),
            operation={ticket=f.ticket,kind=f.kind,state=f.state,stage=f.stage,
                target=f.target,active=f.active,complete=f.complete,failed=f.failed,
                stalled=f.stalled,suspended=f.suspended,waiting=f.waiting,blocked=f.blocked,
                afterEscape=f.afterEscape,destinationProjection=f.destinationProjection,
                rejection=f.rejection,route=f.route,error=f.error,commands=m.commands,commandID=f.commandID},
            commandTrace=m.events,
        }
    end
    return rows
end

function M.abandon(preserveTransit)
    -- Native components may already be torn down. Dropping references is enough:
    -- these DynamicEntitySystem copies are explicitly nonpersistent.
    if M.bodyAnimation and M.bodyAnimation.abandon then pcall(M.bodyAnimation.abandon,'companions-abandoned') end
    for _,entry in ipairs(entries) do
        if entry.motor then actuator.abandon(entry.motor) end
        if entry.equipment then equipment.abandon(entry.equipment) end
    end
    if not preserveTransit then entries={}; transit=nil end
    elapsed,runtimeClock,commandCursor=0,0,0
    groupFrame=nil
    vehicles.abandon(fleet)
    if reloadCleanup then reloadCleanupModule.abandon(reloadCleanup) end
end

function M.vehicleSnapshot()
    local value=vehicles.snapshot(fleet)
    value.reloadCleanup=M.reloadCleanupSnapshot()
    return value
end

local function chauffeurEntry(entity,serialToFind)
    if type(entity)~='string' then return nil end
    for _,entry in ipairs(entries) do
        if entry.state=='ready' and tostring(entry.entityID.hash)==entity
            and (serialToFind==nil or entry.serial==serialToFind) then return entry end
    end
end

-- Tactic hook (mod/companion-tactics.lua): read-only lookup of a ready copy on
-- foot. M.tactics, when set, may own one copy's movement decision via
-- owns(serial) and decide(serial,context,step); the actuator still issues it.
function M.readyActor(entity)
    local entry=chauffeurEntry(entity)
    if not entry or vehicles.owns(fleet,entry.serial) then return nil end
    return {serial=entry.serial,npc=entry.npc,profileKey=entry.profileKey,name=entry.profileName}
end

-- Offers and queue admission run only from gameplay. Menu callers use the
-- cached snapshot and retain the exact serial/entity pair in their intent.
function M.chauffeurOffer(entity)
    if M.reloadCleanupSnapshot().active then
        return {available=false,reason='Step out and wait for the previous driver cleanup to finish.'}
    end
    local entry=chauffeurEntry(entity)
    if not entry then return {available=false,reason='Choose a ready companion from your party.'} end
    return vehicles.chauffeurOffer(fleet,Game.GetPlayer(),entry)
end

function M.queueChauffeur(serialToDrive,expectedOffer,entity)
    if M.reloadCleanupSnapshot().active then return false,'Step out and wait for the previous driver cleanup to finish.' end
    if type(serialToDrive)~='number' or serialToDrive<=0 then return false,'Choose a ready companion from your party.' end
    local entry=chauffeurEntry(entity,serialToDrive)
    if not entry then return false,'That companion is no longer ready to drive.' end
    return vehicles.queueChauffeur(fleet,Game.GetPlayer(),entry,expectedOffer)
end

function M.cancelChauffeur(reason) return vehicles.cancelChauffeur(fleet,reason) end
function M.chauffeurSnapshot() return vehicles.chauffeurSnapshot(fleet) end
function M.prepareChauffeurShutdown(reason)
    local trip=fleet.chauffeur
    local done,why,receipt=vehicles.prepareChauffeurShutdown(fleet,reason)
    if not done and trip then
        local owner=cleanupOwner()
        if not owner.receipt then
            local person=fleet.people[trip.serial]
            local captured,error=reloadCleanupModule.capture(owner,Game.GetPlayer(),trip.entry,trip.car,
                person and person.command,trip.operation)
            if not captured then why=tostring(why)..' Cleanup receipt: '..tostring(error) end
        end
    end
    return done,why,receipt
end
-- An explicit diagnostic can hand off a legacy seated copy only after CURRENT
-- native ownership proof. It never adds the actor to entries or a trip owner.
function M.captureInterruptedDriver(npc)
    if M.owns(npc) then return false,'This driver still belongs to the current companion controller. Stop the trip normally.' end
    local owner=cleanupOwner()
    return reloadCleanupModule.captureSeated(owner,Game.GetPlayer(),npc)
end
function M.chauffeurAutodriveToggled(enabled) return vehicles.chauffeurAutodriveToggled(fleet,enabled) end
function M.chauffeurArrived(entity) return vehicles.chauffeurArrived(fleet,entity) end

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
            if M.bodyAnimation and M.bodyAnimation.release then pcall(M.bodyAnimation.release,entry,'fast-travel') end
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
                state='transit',spawnPosition=space.copy(entry.spawnPosition),clearance=entry.clearance,
                phantomControllersDisabled=entry.phantomControllersDisabled,
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
                    local created,reason,deferred=spawnCopy(entry.key,{profileKey=entry.profileKey,profileName=entry.profileName},entry)
                    if deferred then return end
                    entry.spawnAttempts=(entry.spawnAttempts or 0)+1; entry.retryAt=transit.clock+2
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
                -- A copy can enter transit between creation and attachFollower.
                -- Only nil means its physical appearance setup is outstanding;
                -- zero is the completed result for an ordinary nonphantom NPC.
                if entry.phantomControllersDisabled==nil then
                    local prepared,result=pcall(appearance.prepare,npc)
                    if not prepared then
                        entry.state,entry.error='failed',tostring(result)
                        if not deleteOwnedCopy(entry) then
                            entry.error=entry.error..' The copy could not be removed; try Dismiss.'
                        end
                        return
                    end
                    entry.phantomControllersDisabled=result
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

local function peerYieldPoint(at,others,id,shape)
    -- V can deliberately come close to inspect a face or talk. That is not a
    -- request to retreat. Only overlapping owned companions need separation;
    -- spawning and all new route destinations still use ordinary clearance.
    local nearest,gap=nil,math.huge
    for _,other in ipairs(others) do
        if other.id~=id and not other.reserved then
            local required=math.max(.65,(shape and shape.radius or .35)
                +(other.clearance and other.clearance.radius or .35)-.15)
            local distance=space.distance(at,other.position)
            if distance<required and distance<gap then nearest,gap=other.position,distance end
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

-- A walker held by an obstruction that no detour resolves would wait there
-- forever while V leaves. Only when it is far away and out of V's view is it
-- re-placed near V, through the same placement checks a new invitation uses.
local stranded={distance=30,after=6,retry=3,fieldOfView=60,
    -- No native route at all (V hopped a railing): a companion cannot vault,
    -- so it rejoins sooner and at short range, even if watched for long.
    unreachableDistance=6,unreachableAfter=4,watchedAfter=12}
-- NPC sprint speed is capped by its animation (~5.4 m/s against V's ~8), so a
-- long sprint leaves followers behind. Like vanilla followers, a follower more
-- than 25 m back rejoins out of view, placed behind V.
local catchUp={distance=60,after=2,cooldown=8,behind=4}
-- Vanilla followers raise their individual time dilation with distance to
-- their destination (FollowerTasks.script, AIFollowerInterpolateFollowingSpeed).
-- These copies do not run that behavior task, so apply the same ramp here.
local pace={reason='ConvaiCatchUp',near=6,far=30,max=1.6,close=3,rate=.6,
    easeOut='KereznikovDodgeEaseOut',native={Sprint=5.4,Run=3.6,Walk=1.5}}
-- A person keeping up with a running friend matches their speed and only
-- runs harder while behind; they do not slow down just because they arrived.
local function paceTarget(entry,frame)
    local motor=entry.motor
    -- Close followers travel alongside V in their lane (a move at V's gait),
    -- not by native follow; both are pacing V while V moves.
    local following=motor.kind=='follow' and motor.stage=='following'
    local alongside=motor.kind=='move' and (motor.stage=='walking' or motor.stage=='walking-leg')
        and frame and frame.moving
    if not (following or alongside) or not entry.playerGap then return 1 end
    local native=pace.native[motor.gait] or pace.native.Sprint
    local match=math.min(pace.max,math.max(1,(frame and frame.speed or 0)/native))
    if entry.playerGap<pace.close then return match end
    local alpha=math.max(0,math.min(1,(entry.playerGap-pace.near)/(pace.far-pace.near)))
    return math.max(match,1+alpha*(pace.max-1))
end
local function paceFollower(entry,frame,step)
    local npc,reason=entry.npc,CName.new(pace.reason)
    local mine=npc:HasIndividualTimeDilation(reason)
    -- Never override another effect's dilation (slow motion, hit reactions).
    if not mine and npc:HasIndividualTimeDilation() then entry.pace=nil; return end
    local current=mine and entry.pace or 1
    local target=paceTarget(entry,frame)
    -- Speed up and ease off smoothly, as legs would.
    local limit=pace.rate*math.max(step or 0,0)
    local value=current+math.max(-limit,math.min(limit,target-current))
    if value<=1.001 then
        if mine then npc:UnsetIndividualTimeDilation(CName.new(pace.easeOut)) end
        entry.pace=nil
        return
    end
    if not mine or not entry.pace or math.abs(entry.pace-value)>.01 then
        npc:SetIndividualTimeDilation(reason,value,-1.0,CName.new(''),CName.new(''))
    end
    entry.pace=value
end
local function stopPace(entry)
    if not entry.pace or not entry.npc then return end
    entry.pace=nil
    pcall(function()
        if entry.npc:HasIndividualTimeDilation(CName.new(pace.reason)) then
            entry.npc:UnsetIndividualTimeDilation(CName.new(pace.easeOut))
        end
    end)
end
local function cameraForward(player)
    local ok,_,view=pcall(function() return Game.GetTargetingSystem():GetCrosshairData(player) end)
    local forward=ok and view or player:GetWorldForward()
    return forward and space.unit(forward.x,forward.y) or nil
end
local function hiddenFromPlayer(player,at)
    local forward=cameraForward(player)
    local origin=space.copy(player:GetWorldPosition())
    if forward and space.angle(forward,space.bearing(origin,at))>stranded.fieldOfView then
        return true
    end
    -- An unavailable query is not evidence that the copy is out of sight.
    if not clearance.available(#sightGroups) then return nil end
    return not M.visibleFromCrosshair(Vector4.new(origin.x,origin.y,origin.z+1.6,1),
        Vector4.new(at.x,at.y,at.z+1.2,1))
end
-- Returns true when teleported, nil when it should retry shortly.
local function relocate(entry,player)
    local forward=cameraForward(player)
    if not forward then return false end
    local origin=space.copy(player:GetWorldPosition())
    local lateral=slots[entry.lane] and slots[entry.lane][1] or 0
    local preferred=copyPosition(space.offset(origin,forward,lateral,-catchUp.behind))
    -- Never appear on screen: only spots behind the camera's view qualify.
    local outOfView=function(point)
        return space.angle(forward,space.bearing(origin,point))>stranded.fieldOfView
    end
    local target,_,deferred=placement.find(player,preferred,occupiedPositions(entry),entry.clearance,outOfView)
    if deferred then return nil end
    if not target then return false end
    local angles=Quaternion.ToEulerAngles(player:GetWorldOrientation())
    local sent=actuator.teleport(entry.motor,target,angles and angles.yaw or 0)
    if sent==nil then return nil end
    if not sent then return false end
    stopPace(entry)
    -- Planning pauses until the copy is seen at the destination; the next
    -- sample senses the new feet with zero speed.
    entry.relocation={target=space.copy(target),at=runtimeClock}
    entry.position=nil
    entry.strandedSince,entry.strandedAnchor,entry.lastBlockedAt,entry.farSince=nil,nil,nil,nil
    return true
end
local function recoverDistant(entry,player)
    local pending=entry.relocation
    if pending then
        -- Count a relocation only once the engine reports the copy there.
        if space.distance(entry.position,pending.target)<2 then
            entry.relocations,entry.relocation=(entry.relocations or 0)+1,nil
        elseif runtimeClock-pending.at>2.5 then
            entry.relocationFailures,entry.relocation=(entry.relocationFailures or 0)+1,nil
        else
            -- A new decision would retire the AI teleport before it runs.
            return true
        end
    end
    if equipment.holdsMovement(entry.equipment) then
        entry.strandedSince,entry.strandedAnchor,entry.farSince=nil,nil,nil; return false
    end
    -- V walking on re-plans a blocked follower, briefly clearing its block.
    -- Stranded means recently blocked and not actually getting anywhere.
    if entry.motor.blockedReason then entry.lastBlockedAt=runtimeClock end
    local rejection=entry.motor.lastRejection
    local unreachable=rejection and rejection.stage=='navigation'
    local strandedReady,watchedTooLong=false,false
    if runtimeClock-(entry.lastBlockedAt or -math.huge)>2
        or entry.playerGap<(unreachable and stranded.unreachableDistance or stranded.distance) then
        entry.strandedSince,entry.strandedAnchor=nil,nil
    else
        if not entry.strandedAnchor or space.distance(entry.strandedAnchor,entry.position)>1 then
            entry.strandedAnchor,entry.strandedSince=space.copy(entry.position),runtimeClock
        end
        local stuckFor=runtimeClock-entry.strandedSince
        strandedReady=stuckFor>=(unreachable and stranded.unreachableAfter or stranded.after)
        watchedTooLong=unreachable and stuckFor>=stranded.watchedAfter
    end
    if entry.motor.kind=='follow' and entry.playerGap>catchUp.distance then
        entry.farSince=entry.farSince or runtimeClock
    else entry.farSince=nil end
    local farReady=entry.farSince~=nil and runtimeClock-entry.farSince>=catchUp.after
        and runtimeClock>=(entry.catchUpAt or 0)
    if not (strandedReady or farReady) or runtimeClock<(entry.strandedRetryAt or 0) then return false end
    entry.strandedRetryAt=runtimeClock+(farReady and .5 or stranded.retry)
    -- The destination is always out of view; only a copy stuck with no route
    -- for a long time may leave while V is looking at it.
    if not watchedTooLong and not hiddenFromPlayer(player,entry.position) then return false end
    local moved=relocate(entry,player)
    if moved==nil then entry.strandedRetryAt=runtimeClock+.3 end
    if moved then entry.catchUpAt=runtimeClock+catchUp.cooldown end
    return moved==true
end

function M.update(player,delta,focusEntity)
    if not externalSpatialFrame then spatialFrame() end
    if not player then return end
    local dt=tonumber(delta) or 0
    if reloadCleanup then reloadCleanupModule.update(reloadCleanup,player,dt,true) end
    elapsed,runtimeClock=elapsed+dt,runtimeClock+dt
    if elapsed<0.1 then return end
    local step=elapsed; elapsed=0
    local playerPosition=space.copy(player:GetWorldPosition())
    local gazeSettings=M.gazeSettings and M.gazeSettings() or nil

    for _,entry in ipairs(entries) do
        if entry.state=='spawning' then
            if entry.system:IsSpawned(entry.entityID) then
                local ok,result,reason,deferred=pcall(attachFollower,entry,player)
                if deferred then entry.requestedClock=entry.requestedClock+step end
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
    if M.bodyAnimation and M.bodyAnimation.tick then
        -- Ready copies plus whether transport owns each one; the body owner
        -- releases any copy it did not observe in a settled stance last tick.
        local rows={}
        for _,entry in ipairs(ready) do rows[#rows+1]={entry=entry,transport=vehicles.owns(fleet,entry.serial)} end
        local ticked,tickError=pcall(M.bodyAnimation.tick,player,step,rows)
        if not ticked then M.bodyAnimationError=tostring(tickError) end
    end
    for _,entry in ipairs(ready) do
        if vehicles.owns(fleet,entry.serial) then stopPace(entry) end
        if vehicles.allowsSeatedAttention(fleet,entry.serial) then
            seatedAttention(entry,player,focusEntity,gazeSettings,step)
        elseif vehicles.owns(fleet,entry.serial) then
            -- Entry/exit owns the body. Retire only an existing exact look and
            -- advance its removal retry clock; never admit a new seated gaze.
            actuator.applySeatedLook(entry.motor,{ready=false,selected=false,player=player,
                gazeSettings=gazeSettings,reason='Transport owns vehicle entry'},step)
        end
    end
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
                others[#others+1]={id=tostring(entry.entityID.hash),position=at,clearance=entry.clearance}
        end
    end
    travel.update(groupFrame,playerPosition,step,company)
    if #order==0 then return end
    if lastReversal~=groupFrame.reversal then reassignReversal(order) end
    for _,entry in ipairs(order) do
        entry.maxPlayerSpeed=math.max(entry.maxPlayerSpeed or 0,groupFrame.rawSpeed)
        if entry.motor.target and entry.motor.kind=='move' and not entry.motor.face
            and not entry.motor.feedback.complete and not entry.motor.feedback.failed then
            others[#others+1]={id=tostring(entry.entityID.hash),position=space.copy(entry.motor.target),reserved=true,
                clearance=entry.clearance}
        end
    end
    local budget=2
    local first=commandCursor % #order
    commandCursor=commandCursor+1
    -- Existing detour motion gets its current collision check before another
    -- member can spend the shared physics budget preparing a new route. This
    -- keeps planning work from repeatedly stopping a safe post-vehicle walker.
    -- Transport ownership has already excluded seated/boarding entries above.
    for i=1,#order do
        local entry=order[(first+i-1)%#order+1]
        if entry.motor.execution and not equipment.holdsMovement(entry.equipment) then
            local ok,err=pcall(function()
                actuator.guardMotion(entry.motor,{position=entry.position,direction=entry.direction,
                    speed=entry.speed,playerGap=entry.playerGap,frame=groupFrame,player=player,
                    slot=entry.lane,id=tostring(entry.entityID.hash),others=others})
            end)
            if not ok then entry.error=tostring(err) end
        end
    end
    for i=1,#order do
        local entry=order[(first+i-1)%#order+1]
        local ok,err=pcall(function()
            local tactic=M.tactics and M.tactics.owns(entry.serial)
            if not tactic and recoverDistant(entry,player) then return end
            local id=tostring(entry.entityID.hash)
            local lane=travel.laneFrame(groupFrame,entry.lane)
            local travelTarget=space.offset(lane.position,lane.direction,slots[entry.lane][1],0)
            local choices=space.candidates(groupFrame,entry.lane)
            local restTarget=choices[1]
            for _,point in ipairs(choices) do
                if space.clear(point,playerPosition,others,id,nil,entry.clearance) then restTarget=point; break end
            end
            entry.targetGap=space.distance(entry.position,groupFrame.moving and travelTarget or restTarget)
            local fightingOk,fighting=pcall(function() return NPCPuppet.IsInCombat(entry.npc) end)
            local context={
                id=id,slot=entry.lane,frame=groupFrame,player=player,clearance=entry.clearance,
                position=entry.position,direction=entry.direction,speed=entry.speed,
                playerGap=entry.playerGap,targetGap=entry.targetGap,facingError=entry.facingError,
                selected=id==focusEntity,combat=fightingOk and fighting==true,
                gazeSettings=gazeSettings,
                motion=entry.motor.feedback,travelTarget=travelTarget,restTarget=restTarget,
                comfortable=space.comfortable(entry.position,groupFrame,entry.lane,others,id,entry.clearance),
                nearGroup=space.nearGroup(entry.position,groupFrame,entry.lane,others,id,entry.clearance),
                yieldTarget=peerYieldPoint(entry.position,others,id,entry.clearance),others=others,
            }
            local decision=tactic and M.tactics.decide(entry.serial,context,step)
                or behavior.decide(entry.person,context,step)
            -- Braking is already a committed stop. Never choose an alternative
            -- behind the actor if its original stop point becomes unavailable.
            if decision.phase=='approach' or decision.phase=='obstructed'
                and entry.person.obstructedPhase=='approach' then context.alternatives=choices end
            -- Admission requires stopped feet. Once admitted, a small native
            -- holster root motion is allowed; player departure or a new walking
            -- decision still ends the handoff immediately.
            local idle=(entry.speed<0.18 or equipment.holdsMovement(entry.equipment))
                and not groupFrame.moving and (groupFrame.rawSpeed or 0)<0.28
                and decision.operation and decision.operation.kind=='hold' and entry.motor.kind=='hold'
            -- Optional body-animation owner (docs/COMPANION_GESTURES.md). It sees
            -- the same settled-stance predicate and, while it holds the body,
            -- movement waits exactly as it does for the native holster handoff.
            local body,bodyHolds=M.bodyAnimation,false
            if body then
                local observed,holds=pcall(body.observe,entry,{idle=idle and not equipment.holdsMovement(entry.equipment),
                    phase=decision.phase,combat=context.combat,selected=context.selected,
                    -- Settled without the copy's own speed: a workspot entry
                    -- slide is not a decision to walk.
                    settled=not groupFrame.moving and (groupFrame.rawSpeed or 0)<0.28
                        and decision.operation~=nil and decision.operation.kind=='hold'
                        and not equipment.holdsMovement(entry.equipment),
                    suspendHold=function() return actuator.suspendHold(entry.motor) end,
                    resumeHold=function() actuator.resumeHold(entry.motor) end},step)
                bodyHolds=observed and holds==true
                if not observed then entry.bodyError=tostring(holds) end
            end
            equipment.update(entry.equipment,player,step,idle and not bodyHolds,function() return actuator.suspendHold(entry.motor) end)
            if not equipment.holdsMovement(entry.equipment) and not bodyHolds then
                actuator.resumeHold(entry.motor)
                if actuator.apply(entry.motor,decision,context,budget>0) then budget=budget-1 end
                local paced,paceError=pcall(paceFollower,entry,groupFrame,step)
                entry.paceError=not paced and tostring(paceError) or nil
            end
            entry.error=nil
        end)
        if not ok then entry.error=tostring(err) end
    end
end
return M
