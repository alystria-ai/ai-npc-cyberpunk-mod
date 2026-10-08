-- Managed copies only. World and quest NPCs are never assigned a follower role.
-- A world character asked to follow joins as a managed copy placed where it
-- stood (invitation.adoption, docs/WORLD_COMPANIONS.md); the original is only
-- hidden and shown again by companion-adoption.lua, never given a role.
local M = {}
local behavior = dofile('companion-behavior.lua')
local space = dofile('companion-space.lua')
local travel = dofile('companion-travel.lua')
local actuator = dofile('companion-actuator.lua')
local placement = dofile('companion-placement.lua')
local passage = dofile('companion-passage.lua')
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
-- Doors, lifts and floors (companion-passage.lua). Sampled a few times a
-- second; door searches only while a copy is stranded, every 2 s at most.
local separation={sampleEvery=.25,verticalStep=.3,verticalSettle=.75,
    verticalGap=3,verticalStall=2.5,verticalAfter=.75,verticalWatchedAfter=2.5,floorWatchedAfter=6,
    carGap=2.5,carNear=1.8,carSource=2.5,boardAfter=1,trailReach=14,
    -- Lift cars: walk onto the car floor from at most carWalk metres; stand
    -- beside V while within carStay; walk out to V's foothold within exitReach.
    carWalk=10,carWalkSpeed=.8,carStay=3.5,exitReach=8,carDoorReach=15,carHiddenWait=12,
    doorAfter=1.5,doorRetry=2,doorOpening=.8,replanEvery=4,replanGrace=3,
    arrivalWindow=15,arrivalGap=12,arrivalAfter=1,arrivalWatchedAfter=3}
local passageState={trail={},doorOpened={},sampledAt=-math.huge,zMovingUntil=-math.huge}
-- Lift riders: live trace 2026-10-08 08:51Z, a moving car does not carry an
-- NPC standing in it (Judy stayed at z 49.2 while V rode 41 m down). Each
-- rider is moved with V every frame, only while the car moves (M.carry).
local riders={}
-- One line per recovery decision in probe.log, at most once per kind and
-- reason every 8 s for each copy. Decisions are rare; nothing logs per frame.
local function note(entry,kind,fields)
    if not M.recoveryLog then return end
    fields=fields or {}
    local key=kind..':'..tostring(fields.rule or fields.reason or fields.result or '')
    entry.notes=entry.notes or {}
    if runtimeClock-(entry.notes[key] or -math.huge)<8 then return end
    entry.notes[key]=runtimeClock
    fields.serial,fields.name=entry.serial,entry.name
    if entry.playerGap and not fields.gap then fields.gap=math.floor(entry.playerGap*10+.5)/10 end
    pcall(M.recoveryLog,kind,fields)
end
local function rounded(value) return value and math.floor(value*10+.5)/10 or nil end
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
    -- The party has no size limit: the lowest unused place and formation lane,
    -- however many members already stand in the group.
    local slot=1
    while not freeSlot do
        if not occupied[slot] then freeSlot = slot end
        slot = slot + 1
    end
    slot=1
    while not freeLane do
        if not lanes[slot] then freeLane = slot end
        slot = slot + 1
    end
    local body=returning and returning.clearance or placement.profile(definition,key)
    -- An adopted world character's copy takes the original's place when that
    -- spot passes the same checks; otherwise the usual nearby search applies.
    local adoption=not returning and invitation and type(invitation.adoption)=='table' and invitation.adoption or nil
    local preferred=adoption and clearance.isPoint(adoption.position) and copyPosition(adoption.position)
        or formationPosition(player, freeLane)
    local spawnPosition, placementError, deferred = placement.find(player, preferred,occupiedPositions(),body)
    if deferred then return nil,nil,true end
    if not spawnPosition then return nil, placementError end
    local spawnRecord, recordError, spawnRecordName, spawnAppearance = spawnRecords.resolve(recordID)
    if not spawnRecord then return nil, recordError end
    local spec = NewObject('DynamicEntitySpec')
    spec.recordID = spawnRecord
    -- A copy of a world character wears the original's current appearance. A
    -- private spawn record with its own physical appearance (Johnny) keeps it;
    -- a non-crowd clone of a pedestrian's record (companion-records.lua) does not.
    local appearance=returning and returning.appearance or (adoption and type(adoption.appearance)=='string'
        and adoption.appearance~='' and adoption.appearance) or nil
    if appearance and spawnRecordName and spawnAppearance then appearance=nil end
    if appearance then spec.appearanceName = CName.new(appearance)
    elseif spawnAppearance then spec.appearanceName = CName.new(spawnAppearance) end
    spec.position = spawnPosition
    spec.orientation = adoption and adoption.orientation or player:GetWorldOrientation()
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
        clearance = body, appearance = appearance,
        person = behavior.new(returning and returning.serial or serial),
        transitRecreated = returning ~= nil,
    }
    if returning then
        for index,prior in ipairs(entries) do if prior==returning then entries[index]=entry; break end end
    else entries[#entries + 1] = entry end
    if convaiLocomotion then convaiLocomotion.active=true end
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

-- The exact ready party member at this entity, for a leave offer. A driver
-- mid-trip cannot leave (dismissal is refused until the trip has ended).
-- True when a copy can be spawned from this character record (a crowd
-- record needs its private non-crowd clone, companion-records.lua).
function M.copyable(recordID)
    local ok,record=pcall(spawnRecords.resolve,recordID)
    return ok and record~=nil
end

function M.partyMember(entity)
    if type(entity)~='string' then return nil end
    for _,entry in ipairs(entries) do
        if entry.state=='ready' and entry.profileKey and tostring(entry.entityID.hash)==entity then
            local allowed=vehicles.canDismissChauffeurDriver(fleet,entry.serial)
            return {serial=entry.serial,id=entity,key=entry.profileKey,name=entry.profileName or entry.name,
                driving=allowed~=true}
        end
    end
    return nil
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
            holster=entry.equipment and {phase=movementText(entry.equipment.phase),reason=movementText(entry.equipment.reason),
                stop=entry.equipment.stopWanted==true,armed=entry.equipment.armed==true} or nil,
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
            serial=e.serial,key=e.key,baseName=e.name,name=e.name..(totals[e.key]>1 and (' #'..seen[e.key]) or ''),
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
    passageState.trail,passageState.doorOpened,passageState.lift,passageState.z={},{},nil,nil
    passageState.position,passageState.rideFrom=nil,nil
    passageState.sampledAt,passageState.zMovingUntil=-math.huge,-math.huge
    passageState.rideStarted,passageState.arrivedAt,passageState.exitedAt,passageState.insideSince=nil,nil,nil,nil
    passageState.riding=nil
    riders={}; M.riders=nil
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

-- Current party "game voice" (manager-party.lua): the live entity of one ready
-- copy, looked up only when the player asked for it, never retained.
function M.actor(serialToFind)
    for _,entry in ipairs(entries) do
        if entry.serial==serialToFind and entry.state=='ready' and entry.npc then return entry.npc end
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
                appearance=entry.appearance,
                phantomControllersDisabled=entry.phantomControllersDisabled,
                retiredCommands=commands,
                transitError=entry.motor and entry.motor.look and 'The previous gaze request could not be released.' or nil}
        end
        if entry.motor then actuator.abandon(entry.motor) end
        if entry.equipment then equipment.abandon(entry.equipment) end
    end
    transit={phase='loading',clock=0,fleet=vehicles.suspend(fleet)}
    entries=party; groupFrame=nil; elapsed=0
    passageState.trail,passageState.lift,passageState.z={},nil,nil
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
    for _,entry in ipairs(entries) do
        if entry.state=='ready' then
            ready[#ready+1]=entry
            -- The game normally brings a follower along. A copy it left far
            -- away or behind a wall rejoins near V (recoverDistant).
            entry.arrivalStart,entry.arrivalUntil=runtimeClock,runtimeClock+separation.arrivalWindow
            local ok,gap=pcall(function() return space.distance(entry.npc:GetWorldPosition(),player:GetWorldPosition()) end)
            entry.playerGap=ok and gap or nil
            note(entry,'fast-travel-reacquired',{respawned=(entry.spawnAttempts or 0)>0})
        elseif entry.state=='failed' or entry.state=='dead' then
            note(entry,'fast-travel-lost',{reason=entry.error,state=entry.state})
        end
    end
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
    local lastLane=0
    for _,entry in ipairs(order) do lastLane=math.max(lastLane,entry.lane or 0) end
    for pair=1,math.ceil(lastLane/2) do
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
-- A body-check obstruction used to need 30 m before this fired, so a
-- companion held 11-25 m back at V's building door and lobby gate waited
-- forever (live trace 2026-10-08). Blocked and not moving for 8 s, 10 m
-- back, is enough; it still never leaves while V is watching it.
local stranded={distance=10,after=8,retry=3,fieldOfView=60,
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
-- Who rides: a copy standing in the car with V when it departs (boarded this
-- visit, or within 1.6 m of where V stood). Her offset from V is kept.
local function boardRiders(s)
    riders={}
    for _,entry in ipairs(entries) do
        local at=entry.state=='ready' and entry.npc and entry.position
        local walk=entry.carWalk
        local aboard=at and math.abs(at.z-s.rideFrom.z)<1 and (entry.carVisit==s.insideSince
            or walk and walk.purpose=='board' and walk.final and space.ground(at,walk.target)<1.2
            or space.ground(at,s.rideFrom)<1.6)
        if aboard then
            local ok,angles=pcall(function() return Quaternion.ToEulerAngles(entry.npc:GetWorldOrientation()) end)
            riders[#riders+1]={entry=entry,dx=at.x-s.rideFrom.x,dy=at.y-s.rideFrom.y,dz=at.z-s.rideFrom.z,
                angles=ok and angles or EulerAngles.new(0,0,0)}
            entry.carVisit,entry.carWalk,entry.carSearch=s.insideSince,nil,nil
            entry.riding=s.rideStarted
        end
    end
    M.riders=#riders>0 or nil
end
-- Called every frame by the owner, and only while M.riders is set: one
-- transform per rider for the length of the ride, nothing otherwise.
function M.carry(player)
    if not riders[1] then M.riders=nil; return end
    local v=player:GetWorldPosition()
    local facility=Game.GetTeleportationFacility()
    for index=#riders,1,-1 do
        local r=riders[index]
        local npc=r.entry.state=='ready' and r.entry.npc
        local ok=npc and pcall(function()
            facility:Teleport(npc,Vector4.new(v.x+r.dx,v.y+r.dy,v.z+r.dz,1),r.angles)
        end)
        if not ok then table.remove(riders,index) end
    end
    if not riders[1] then M.riders=nil end
end
-- V's lift state, vertical motion and recent footholds, sampled a few times a
-- second for the whole party (companion-passage.lua).
local function samplePassage(player,position)
    local s=passageState
    if runtimeClock-s.sampledAt>=separation.sampleEvery then
        local step=runtimeClock-s.sampledAt
        s.sampledAt=runtimeClock
        local previous=s.lift
        s.lift=passage.liftState(player)
        if s.z and step<1 and math.abs(position.z-s.z)>separation.verticalStep then
            s.zMovingUntil=runtimeClock+separation.verticalSettle
        end
        s.z=position.z
        local inside,moving=s.lift and s.lift.inside,s.lift and s.lift.moving
        if inside and not (previous and previous.inside) then s.insideSince=runtimeClock end
        -- A ride: the car's moving flag, or, until that flag has been seen
        -- set once (it is reflected, not yet seen live), V's height changing
        -- while V is in the car.
        if moving then s.movingFlagSeen=true end
        local riding=moving or (not s.movingFlagSeen and inside and runtimeClock<s.zMovingUntil) or false
        if riding and not s.riding then
            -- Who stood in the car is judged where the car stood, not where
            -- the first moving sample already finds V.
            s.rideStarted,s.rideFrom=runtimeClock,s.position or space.copy(position)
            boardRiders(s)
        end
        s.position=space.copy(position)
        if s.riding and not riding then s.arrivedAt=runtimeClock; riders={}; M.riders=nil end
        if riding and runtimeClock-s.rideStarted>90 then riders={}; M.riders=nil end
        s.riding=riding
        if previous and previous.inside and not inside then s.exitedAt=runtimeClock end
    end
    passage.trailPush(s.trail,position,runtimeClock,s.lift and s.lift.inside)
end
-- Bookkeeping after an AI teleport was sent. Planning pauses until the copy
-- is seen at the destination; the next sample senses the new feet.
local function teleported(entry,target,rule,fields)
    stopPace(entry)
    entry.relocation={target=space.copy(target),at=runtimeClock,rule=rule,carVisit=fields.carVisit}
    fields.carVisit=nil
    fields.rule,fields.from,fields.to=rule,space.copy(entry.position),space.copy(target)
    note(entry,'relocated',fields)
    entry.position=nil
    entry.strandedSince,entry.strandedAnchor,entry.lastBlockedAt,entry.farSince=nil,nil,nil,nil
    entry.verticalSince,entry.progressAnchor,entry.progressAt=nil,nil,nil
    entry.carWalk,entry.carSearch,entry.carVisit,entry.riseBest,entry.riseAt=nil,nil,nil,nil,nil
    entry.carExit=nil
end
-- Returns true when teleported, nil when it should retry shortly, or false
-- and a reason. Each placement plan runs on its own update so one recovery
-- never spends the whole shared physics budget; a failed plan moves on.
local function relocate(entry,player,rule,watched,lift)
    local forward=cameraForward(player)
    if not forward then return false,'camera-unavailable' end
    local origin=space.copy(player:GetWorldPosition())
    local lateral=slots[entry.lane] and slots[entry.lane][1] or 0
    -- Never appear on screen: only spots behind the camera's view qualify,
    -- unless this rule may be seen (a lift car, a long wait in view).
    local outOfView=function(point)
        return space.angle(forward,space.bearing(origin,point))>stranded.fieldOfView
    end
    local plans={}
    if rule=='lift-board' then
        -- Beside V inside the car; the car floor can stand off the navmesh.
        local beside=copyPosition(space.offset(origin,forward,lateral>=0 and .9 or -.9,-.2))
        plans[#plans+1]={preferred=beside,accept=not watched and outOfView or nil,
            options={near=separation.carNear,sourceRadius=separation.carSource}}
    else
        local behind=copyPosition(space.offset(origin,forward,lateral,-catchUp.behind))
        plans[#plans+1]={preferred=behind,accept=outOfView}
        if watched then plans[#plans+1]={preferred=behind} end
        -- V in a lift car: search from the walkable ground nearest V.
        if lift and lift.inside then
            plans[#plans+1]={preferred=behind,accept=not watched and outOfView or nil,
                options={sourceRadius=separation.carSource}}
        end
        -- V's own recent footholds on this floor (a lobby, a doorway).
        for _,point in ipairs(passage.trailPoints(passageState.trail,origin,1.5,separation.trailReach,3)) do
            local foothold=Vector4.new(point.x,point.y,point.z,1)
            plans[#plans+1]={preferred=foothold,accept=not watched and outOfView or nil,
                options={origin=foothold},trail=true}
        end
    end
    local index=entry.placementPlan or 1
    if entry.placementRule~=rule or index>#plans then index=1 end
    entry.placementRule=rule
    local plan=plans[index]
    local target,reason,deferred=placement.find(player,plan.preferred,occupiedPositions(entry),entry.clearance,
        plan.accept,plan.options)
    if deferred then entry.placementPlan=index; return nil end
    if not target then
        if index<#plans then entry.placementPlan=index+1; return nil end
        entry.placementPlan=nil
        return false,reason or 'no-spot'
    end
    entry.placementPlan=nil
    local angles=Quaternion.ToEulerAngles(player:GetWorldOrientation())
    local sent=actuator.teleport(entry.motor,target,angles and angles.yaw or 0)
    if sent==nil then return nil end
    if not sent then return false,'teleport-refused' end
    teleported(entry,target,rule,{plan=index,trail=plan.trail==true,watched=watched==true,
        rise=rounded(math.abs(entry.position.z-origin.z)),
        -- A spot found beside V in a stopped car: she stands in it with V.
        carVisit=rule=='lift-board' and passageState.insideSince or nil})
    return true
end
-- Lift cars (companion-passage.lua). The car floor carries no navmesh, so
-- ordinary walking cannot enter or leave it: a companion near the door walks
-- in on a swept straight line (a teleport into the car if that walk does not
-- arrive), stands beside V while V stays in the car, and walks out to where V
-- stepped off. Returns true while this owns the copy's feet this update.
local function carTeleport(entry,player,spot,visit,rule,how)
    local angles=Quaternion.ToEulerAngles(player:GetWorldOrientation())
    -- Never in view: the teleport is the last resort of a walk.
    local sent=actuator.teleport(entry.motor,spot,angles and angles.yaw or 0)
    if sent==nil then return nil end
    if not sent then
        note(entry,'relocation-failed',{rule=rule,reason='teleport-refused'})
        return false
    end
    teleported(entry,spot,rule,{how=how,watched=false,carVisit=visit})
    return true
end
local function unseen(player,entry,spot)
    return hiddenFromPlayer(player,entry.position)==true and hiddenFromPlayer(player,spot)==true
end
-- One owned walk leg: straight (navmesh off) or native. Returns nil while a
-- cancellation is pending, else whether it was sent.
local function walkLeg(entry,walk,from)
    local gap=space.ground(from,walk.target)
    local sent=actuator.board(entry.motor,walk.target,{navigate=walk.navigate,gait=gap>3 and 'Run' or 'Walk'})
    if sent then
        stopPace(entry)
        walk.deadline=runtimeClock+gap/separation.carWalkSpeed+3
        walk.best,walk.bestAt=gap,runtimeClock
    end
    return sent
end
-- Straight leg candidates out of the car: V's newest foothold on her floor,
-- the doorway V used, then a few metres toward V.
local function exitCandidates(entry,v)
    local list={}
    local trail=passage.exitPoint(passageState.trail,entry.position,separation.exitReach)
    if trail then list[#list+1]=trail end
    local door=entry.carDoor
    if door and space.ground(door,entry.position)<=separation.exitReach then
        list[#list+1]={x=door.x,y=door.y,z=entry.position.z}
    end
    local flat=space.ground(entry.position,v)
    if flat>1 and math.abs(v.z-entry.position.z)<1 then
        local step=math.min(3,flat-.8)
        local b=space.bearing(entry.position,v)
        list[#list+1]={x=entry.position.x+b.x*step,y=entry.position.y+b.y*step,z=entry.position.z}
    end
    return list
end
local function liftPassage(entry,player,v,rise,flat)
    local s,lift=passageState,passageState.lift
    local inside=lift and lift.inside
    local walk=entry.carWalk
    if walk then
        local gap=space.ground(entry.position,walk.target)
        local reached=gap<(walk.navigate and .8 or .55) and math.abs(entry.position.z-walk.target.z)<.6
        if not reached and gap<walk.best-.3 then walk.best,walk.bestAt=gap,runtimeClock end
        local stuck=runtimeClock>=walk.deadline or runtimeClock-walk.bestAt>=2.5
            or (entry.motor.kind=='board' and entry.motor.feedback.failed)
        local valid=walk.purpose~='board' or (inside and walk.visit==s.insideSince and not s.riding)
        if reached and walk.next and valid then
            -- The doorway reached on the navmesh: the straight leg into the car.
            local clear,_,deferred=clearance.segment(entry.position,walk.next,entry.clearance)
            if deferred then return true end
            if clear then
                local leg={purpose='board',target=walk.next,visit=walk.visit,final=true}
                local sent=walkLeg(entry,leg,entry.position)
                if sent==nil then return true end
                if sent then entry.carWalk=leg; return true end
            end
            stuck,reached=true,false
        end
        if reached then
            entry.carWalk=nil
            note(entry,walk.purpose=='board' and 'lift-boarded' or 'lift-exited',{how='walked'})
            if walk.purpose~='board' then entry.carExit=nil; return false end
            entry.carVisit=walk.visit
        elseif not stuck and valid then
            return true
        else
            entry.carWalk=nil
            if walk.purpose=='board' then
                if not valid then return false end
                -- Last resort, and never in view: wait for V to look away.
                note(entry,'lift-board-walk-failed',{walk=rounded(gap),navigate=walk.navigate==true})
                entry.carSearch={visit=walk.visit,mode='hidden',spot=walk.spot or walk.next or walk.target,
                    untilAt=runtimeClock+separation.carHiddenWait}
                return false
            end
            note(entry,'lift-exit-failed',{reason='walk-stalled',walk=rounded(gap)})
            return false
        end
    end
    local search=entry.carSearch
    if search then
        if not (inside and search.visit==s.insideSince and not s.riding) then entry.carSearch=nil; return false end
        if search.mode=='hidden' then
            if runtimeClock>=search.untilAt then entry.carSearch=nil; return false end
            if runtimeClock<(search.checkAt or 0) then return false end
            search.checkAt=runtimeClock+.5
            if not unseen(player,entry,search.spot) then return false end
            local moved=carTeleport(entry,player,search.spot,search.visit,'lift-board','unseen')
            if moved==nil then return true end
            entry.carSearch=nil
            return moved
        end
        local spot,reason,pending=search.spot,nil,nil
        if not spot then
            spot,reason,pending=passage.carSpot(search,v,entry.position,occupiedPositions(entry),entry.clearance,clearance)
        end
        if pending then return true end
        if not spot then
            entry.carSearch=nil
            note(entry,'lift-car-spot',{reason=reason,mode=search.mode})
            return false -- the navmesh placement rules take over
        end
        search.spot=spot
        if search.mode=='board' then
            entry.boardedVisit=search.visit
            local gap=space.ground(entry.position,spot)
            if not search.swept then
                local clear,_,deferred=clearance.segment(entry.position,spot,entry.clearance)
                if deferred then return true end
                search.swept=clear and 'clear' or 'blocked'
            end
            -- Straight in, or the native route to the doorway V used first.
            local leg
            if search.swept=='clear' and gap<=separation.carWalk then
                leg={purpose='board',target=space.copy(spot),visit=search.visit,final=true}
            elseif entry.carDoor and space.ground(entry.position,entry.carDoor)<=separation.carDoorReach then
                leg={purpose='board',target=entry.carDoor,navigate=true,next=space.copy(spot),
                    spot=space.copy(spot),visit=search.visit}
            end
            if leg then
                local sent=walkLeg(entry,leg,entry.position)
                if sent==nil then return true end
                if sent then
                    entry.carSearch,entry.carWalk=nil,leg
                    note(entry,'lift-boarding',{how=leg.navigate and 'door-then-walk' or 'walk',
                        walk=rounded(gap),swept=search.swept})
                    return true
                end
            end
            note(entry,'lift-boarding',{how='unseen-teleport',walk=rounded(gap),swept=search.swept})
            entry.carSearch={visit=search.visit,mode='hidden',spot=spot,untilAt=runtimeClock+separation.carHiddenWait}
            return false
        end
        -- The car left without her: back in it only while V cannot see it.
        entry.carSearch=nil
        if not unseen(player,entry,spot) then
            note(entry,'lift-car-spot',{reason='in-view',mode=search.mode})
            return false
        end
        local moved=carTeleport(entry,player,spot,search.visit,'lift-arrival','car')
        if moved==nil then entry.carSearch=search; return true end
        return moved
    end
    local visit=entry.carVisit
    if visit then
        local sameVisit=inside and visit==s.insideSince
        if sameVisit and rise<1.5 and flat<=separation.carStay then
            -- In the car with V: stand still; a moving car takes her along (M.carry).
            entry.carExit=nil
            actuator.stay(entry.motor); return true
        end
        if sameVisit and rise>=1.5 then return false end -- the car left without her
        -- V stepped out (or walked off inside the lift's area): walk out after V.
        local exit=entry.carExit
        if not exit then exit={list=exitCandidates(entry,v),index=1}; entry.carExit=exit end
        while exit.list[exit.index] do
            local target=exit.list[exit.index]
            if space.ground(target,entry.position)<=.6 then exit.index=exit.index+1
            else
                local clear,_,deferred=clearance.segment(entry.position,target,entry.clearance)
                if deferred then return true end
                if clear then
                    local leg={purpose='exit',target=target}
                    local sent=walkLeg(entry,leg,entry.position)
                    if sent==nil then return true end
                    if sent then entry.carWalk,entry.carVisit=leg,nil; return true end
                end
                exit.index=exit.index+1
            end
        end
        entry.carVisit,entry.carExit=nil,nil
        note(entry,'lift-exit-failed',{reason='no-clear-exit'})
    end
    return false
end
local function recoverDistant(entry,player)
    local pending=entry.relocation
    if pending then
        -- Count a relocation only once the engine reports the copy there.
        if space.distance(entry.position,pending.target)<2 then
            entry.relocations,entry.relocation=(entry.relocations or 0)+1,nil
            entry.carVisit=pending.carVisit
        elseif runtimeClock-pending.at>2.5 then
            entry.relocationFailures,entry.relocation=(entry.relocationFailures or 0)+1,nil
            note(entry,'relocation-failed',{rule=pending.rule,reason='teleport-not-performed'})
        else
            -- A new decision would retire the AI teleport before it runs.
            return true
        end
    end
    if equipment.holdsMovement(entry.equipment) then
        entry.strandedSince,entry.strandedAnchor,entry.farSince,entry.verticalSince=nil,nil,nil,nil
        entry.carWalk,entry.carSearch=nil,nil
        return false
    end
    local s,lift=passageState,passageState.lift
    local v=space.copy(player:GetWorldPosition())
    local rise=math.abs(entry.position.z-v.z)
    local flat=space.ground(entry.position,v)
    if s.rideStarted and entry.rideSeen~=s.rideStarted then
        -- Whoever stands in the car with V when it departs rides along; if the
        -- engine leaves them behind, they rejoin as soon as the car arrives.
        entry.rideSeen=s.rideStarted
        local from=s.rideFrom or v
        entry.rodeWithV=space.ground(entry.position,from)<separation.carGap and math.abs(entry.position.z-from.z)<1.2
        note(entry,'lift-departed',{withV=entry.rodeWithV,flat=rounded(flat)})
    end
    if s.arrivedAt and entry.arrivalSeen~=s.arrivedAt then
        entry.arrivalSeen=s.arrivedAt
        note(entry,'lift-arrived',{rise=rounded(rise),withV=entry.rodeWithV==true})
        -- She stood in the car but the car left without her: back beside V in
        -- the car, where V last saw her, before V steps out.
        if entry.rodeWithV and lift and lift.inside and not s.riding and rise>separation.verticalGap
            and not entry.carSearch and not entry.carWalk then
            entry.carSearch={visit=s.insideSince,mode='arrival'}
        end
    end
    if liftPassage(entry,player,v,rise,flat) then return true end
    -- Never relocate while V's floor is still moving (a lift ride, a fall).
    if s.riding or runtimeClock<s.zMovingUntil then
        entry.strandedSince,entry.strandedAnchor,entry.verticalSince=nil,nil,nil
        entry.riseBest,entry.riseAt=nil,nil
        return false
    end
    -- Progress: real displacement, independent of the motor's own story.
    if not entry.progressAnchor or space.distance(entry.progressAnchor,entry.position)>1 then
        entry.progressAnchor,entry.progressAt=space.copy(entry.position),runtimeClock
    end
    local stalledFor=runtimeClock-entry.progressAt
    -- V walking on re-plans a blocked follower, briefly clearing its block.
    -- Stranded means recently blocked and not actually getting anywhere.
    if entry.motor.blockedReason then entry.lastBlockedAt=runtimeClock end
    local rejection=entry.motor.lastRejection
    local unreachable=rejection and rejection.stage=='navigation'
    local blockedRecently=runtimeClock-(entry.lastBlockedAt or -math.huge)<=2
        or runtimeClock-(entry.replannedAt or -math.huge)<=separation.replanGrace
    local strandedReady,watchedTooLong,stuckFor=false,false,0
    if not blockedRecently
        or entry.playerGap<(unreachable and stranded.unreachableDistance or stranded.distance) then
        entry.strandedSince,entry.strandedAnchor=nil,nil
    else
        if not entry.strandedAnchor or space.distance(entry.strandedAnchor,entry.position)>1 then
            if not entry.strandedAnchor then
                note(entry,'stranded',{reason=rejection and rejection.stage or 'blocked',rise=rounded(rise)})
            end
            entry.strandedAnchor,entry.strandedSince=space.copy(entry.position),runtimeClock
        end
        stuckFor=runtimeClock-entry.strandedSince
        strandedReady=stuckFor>=(unreachable and stranded.unreachableAfter or stranded.after)
        watchedTooLong=unreachable and stuckFor>=stranded.watchedAfter
    end
    -- A closed door V walked through: open it the way V did, then let the
    -- follower verify a fresh route before any teleport is considered.
    if entry.doorReplanAt and runtimeClock>=entry.doorReplanAt then
        entry.doorReplanAt=nil
        if actuator.replan(entry.motor) then entry.replannedAt=runtimeClock end
    end
    if entry.strandedSince and stuckFor>=separation.doorAfter and rise<passage.policy.doorRise
        and runtimeClock>=(entry.doorCheckAt or 0) then
        entry.doorCheckAt=runtimeClock+separation.doorRetry
        local door,info=passage.findDoor(player,entry.position,v)
        if door then
            if runtimeClock>=(s.doorOpened[info.id] or -math.huge) then
                s.doorOpened[info.id]=runtimeClock+passage.policy.doorReopen
                local opened,result=passage.openDoor(player,door)
                note(entry,'door',{result=result,door=info.id,at=info.position})
                if opened then
                    -- Give the door time to slide open and the walk time to start.
                    entry.doorReplanAt=runtimeClock+separation.doorOpening
                    entry.strandedSince=runtimeClock
                    return false
                end
            end
        else
            note(entry,'door-none',{reason=info})
        end
    end
    -- Native navigation can change under a still V (a door opened by someone
    -- else). Reverify a no-route follower now and then; cheap and bounded.
    if unreachable and entry.strandedSince and not entry.doorReplanAt and stuckFor>=1
        and runtimeClock-(entry.replannedAt or -math.huge)>=separation.replanEvery then
        if actuator.replan(entry.motor) then entry.replannedAt=runtimeClock end
    end
    -- A different floor: a lift ride without the companion, or stairs or a
    -- drop the companion is making no progress on. A follower still climbing
    -- toward V is left to walk.
    local liftArrival=(s.arrivedAt and runtimeClock-s.arrivedAt<10) or (s.exitedAt and runtimeClock-s.exitedAt<10)
    -- Across floors, progress means the height gap closing. A follower that
    -- walks about without climbing toward V for stranded.after seconds
    -- rejoins like a stalled one.
    if rise<=separation.verticalGap then entry.riseBest,entry.riseAt=nil,nil
    elseif not entry.riseBest or rise<entry.riseBest-.75 then entry.riseBest,entry.riseAt=rise,runtimeClock end
    local climbStalled=entry.riseAt~=nil and runtimeClock-entry.riseAt>=stranded.after
    local vertical=rise>separation.verticalGap and (liftArrival or stalledFor>=separation.verticalStall or climbStalled)
    if vertical then entry.verticalSince=entry.verticalSince or runtimeClock else entry.verticalSince=nil end
    local verticalFor=vertical and runtimeClock-entry.verticalSince or 0
    local verticalReady=vertical and verticalFor>=(entry.rodeWithV and 0 or separation.verticalAfter)
    -- V waits in a stopped car while the companion cannot get in.
    local boardReady=lift and lift.inside and not s.riding and rise<1.5
        and s.insideSince and runtimeClock-s.insideSince>=separation.boardAfter
        and ((blockedRecently and flat>separation.carNear) or (stalledFor>=separation.boardAfter and flat>separation.carGap))
        and entry.boardedVisit~=s.insideSince and not entry.carVisit
    if entry.motor.kind=='follow' and entry.playerGap>catchUp.distance then
        entry.farSince=entry.farSince or runtimeClock
    else entry.farSince=nil end
    local farReady=entry.farSince~=nil and runtimeClock-entry.farSince>=catchUp.after
        and runtimeClock>=(entry.catchUpAt or 0)
    -- Just after fast travel: a copy the game left far away rejoins at once.
    local arriving=entry.arrivalUntil and runtimeClock<entry.arrivalUntil
    local arrivalReady=arriving and entry.playerGap>separation.arrivalGap
        and runtimeClock-entry.arrivalStart>=separation.arrivalAfter
    if boardReady and entry.carTried~=s.insideSince then
        -- First the car floor itself (physics), then the navmesh beside V.
        entry.carTried=s.insideSince
        entry.carSearch={visit=s.insideSince,mode='board'}
        -- V's last foothold before the car: the doorway, on the walkable floor.
        entry.carDoor=passage.exitPoint(s.trail,v,6)
        return liftPassage(entry,player,v,rise,flat)
    end
    local rule,watched
    if boardReady then rule,watched='lift-board',false
    elseif verticalReady then
        rule=liftArrival and 'lift-arrival' or 'floor-change'
        -- Never in view after a ride; only a long wait on another floor may.
        watched=verticalFor>=(liftArrival and stranded.watchedAfter or separation.floorWatchedAfter)
    elseif farReady then rule,watched='far',false
    elseif arrivalReady then rule,watched='fast-travel',runtimeClock-entry.arrivalStart>=separation.arrivalWatchedAfter
    elseif strandedReady then rule,watched=unreachable and 'no-route' or 'blocked',watchedTooLong
    end
    if not rule or runtimeClock<(entry.strandedRetryAt or 0) then return false end
    local quick=rule=='far' or rule=='fast-travel' or rule:find('lift',1,true)
    entry.strandedRetryAt=runtimeClock+(quick and .5 or stranded.retry)
    -- The destination is always out of view where possible; only these
    -- waits may let the copy leave while V is looking at it.
    if not watched and not hiddenFromPlayer(player,entry.position) then
        note(entry,'waiting-in-view',{rule=rule})
        return false
    end
    local moved,reason=relocate(entry,player,rule,watched,lift)
    if moved==nil then entry.strandedRetryAt=runtimeClock+.3 end
    if moved then
        entry.catchUpAt=runtimeClock+catchUp.cooldown
        if rule=='lift-board' then entry.boardedVisit=s.insideSince end
        if rule=='fast-travel' then entry.arrivalUntil=nil end
    elseif moved==false then
        -- One attempt per car visit: a car without walkable floor keeps the
        -- companion outside, and the arrival rule brings them up instead.
        if rule=='lift-board' then entry.boardedVisit=s.insideSince end
        note(entry,'relocation-failed',{rule=rule,reason=reason})
    end
    return moved==true
end

function M.update(player,delta,focusEntity)
    if not externalSpatialFrame then spatialFrame() end
    -- The MoveTo observer (companion-locomotion.lua) skips all work without a managed copy.
    if convaiLocomotion then convaiLocomotion.active=#entries>0 end
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
    samplePassage(player,playerPosition)
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
            -- A companion leaving the party walks away on its own (M.departure,
            -- companion-adoption.lua): no tactic, catch-up or teleport recovery.
            local departing=M.departure and M.departure.owns(entry.serial)
            local tactic=not departing and M.tactics and M.tactics.owns(entry.serial)
            if not tactic and not departing and recoverDistant(entry,player) then return end
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
                id=id,slot=entry.lane,frame=groupFrame,player=player,npc=entry.npc,clearance=entry.clearance,
                position=entry.position,direction=entry.direction,speed=entry.speed,
                playerGap=entry.playerGap,targetGap=entry.targetGap,facingError=entry.facingError,
                selected=id==focusEntity,combat=fightingOk and fighting==true,
                gazeSettings=gazeSettings,
                motion=entry.motor.feedback,travelTarget=travelTarget,restTarget=restTarget,
                comfortable=space.comfortable(entry.position,groupFrame,entry.lane,others,id,entry.clearance),
                nearGroup=space.nearGroup(entry.position,groupFrame,entry.lane,others,id,entry.clearance),
                yieldTarget=peerYieldPoint(entry.position,others,id,entry.clearance),others=others,
            }
            -- Sit with you (docs/COMPANION_SEATING.md): a walk to a seat beside a
            -- seated V, then a hold while the sit workspot owns the body.
            local seat=not departing and not tactic and M.bodyAnimation and M.bodyAnimation.steer
                and M.bodyAnimation.steer(entry,context,step) or nil
            local decision=departing and M.departure.decide(entry.serial,context,step)
                or tactic and M.tactics.decide(entry.serial,context,step)
                or seat or behavior.decide(entry.person,context,step)
            -- A drawn weapon after combat is holstered although V keeps moving:
            -- the equipment owner asks for a brief stand-still (bounded there).
            -- Only the ordinary follow behaviour yields; a departure, a tactic
            -- or a body animation keeps its own say.
            local holsterStop=not departing and not tactic and not seat and equipment.wantsStop(entry.equipment)
            if holsterStop then
                decision={phase='holster',reason='Stand still so the drawn weapon can be holstered',
                    operation={ticket='holster:'..id..':'..tostring(entry.equipment.episode),kind='hold'},look='none'}
            end
            -- Braking is already a committed stop. Never choose an alternative
            -- behind the actor if its original stop point becomes unavailable.
            if decision.phase=='approach' or decision.phase=='obstructed'
                and entry.person.obstructedPhase=='approach' then context.alternatives=choices end
            -- Admission requires stopped feet. Once admitted, a small native
            -- holster root motion is allowed; player departure or a new walking
            -- decision still ends the handoff immediately.
            local stopped=decision.operation and decision.operation.kind=='hold' and entry.motor.kind=='hold'
            local idle=(entry.speed<0.18 or equipment.holdsMovement(entry.equipment))
                and not groupFrame.moving and (groupFrame.rawSpeed or 0)<0.28 and stopped
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
            -- Holstering needs her own feet still, not V's: a requested stand-still
            -- counts although V is walking on.
            local holsterIdle=holsterStop and stopped and entry.speed<0.18 and not bodyHolds
            equipment.update(entry.equipment,player,step,(idle and not bodyHolds) or holsterIdle,function() return actuator.suspendHold(entry.motor) end)
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
