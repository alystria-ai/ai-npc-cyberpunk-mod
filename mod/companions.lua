-- Managed copies only. World and quest NPCs are never assigned a follower role.
-- A world character asked to follow joins as a managed copy placed where it
-- stood (invitation.adoption, docs/WORLD_COMPANIONS.md); the original is only
-- hidden and shown again by companion-adoption.lua, never given a role.
-- The crosshair on both game versions (init.lua ConvaiCrosshairData); the plain 2.31 call where init.lua is not loaded (tests).
local function crosshairData(targeting, player)
    if ConvaiCrosshairData then return ConvaiCrosshairData(targeting, player) end
    return targeting:GetCrosshairData(player)
end
local M = {}
local behavior = dofile('companion-behavior.lua')
local space = dofile('companion-space.lua')
local travel = dofile('companion-travel.lua')
local actuator = dofile('companion-actuator.lua')
-- Optional native tick (mod/companion-tick-native.lua, plugin system "actuator"). A missing module, a
-- missing plugin or a switched-off system keeps every read below exactly as the Lua wrote it.
local tickOk, tickNative = pcall(dofile, 'companion-tick-native.lua')
if not tickOk or type(tickNative) ~= 'table' then tickNative = nil end
if actuator.useNativeTick then actuator.useNativeTick(tickNative) end
local placement = dofile('companion-placement.lua')
local passage = dofile('companion-passage.lua')
local clearance = dofile('companion-clearance.lua')
local appearance = dofile('companion-appearance.lua')
local spawnRecords = dofile('companion-records.lua')
local equipment = dofile('companion-equipment.lua')
-- A combat-start weapon draw writes one 'Companion recovery weapon-draw' probe line per step (never per frame).
equipment.report = function(kind, fields) if M.recoveryLog then pcall(M.recoveryLog, kind, fields) end end
local vehicles = dofile('companion-vehicles.lua')
local vehicleNative = dofile('companion-vehicle-native.lua')
local fleet = vehicles.new(vehicleNative)
-- One probe.log line per boarding, seat and exit decision of the fleet: 'Companion recovery vehicle-boarding', 'vehicle-seat',
-- 'vehicle-settled', 'vehicle-exit-start' and 'vehicle-exit' (companion-vehicles.lua report). M.recoveryLog is set by init.lua.
fleet.report = function(kind, fields) if M.recoveryLog then pcall(M.recoveryLog, 'vehicle-' .. kind, fields) end end
-- The convoy follow A/B (companion-vehicle-native.lua, convoyMode) is a Developer-mode choice; init.lua sets M.developerMode.
vehicleNative.developerMode = function() return M.developerMode and M.developerMode() == true end
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
local spatialBudget,externalSpatialFrame,spatialInjected,spatialLimit
local function spatialFrame()
    -- One budget table for the whole session, reset in place: no new table per frame, and no re-injection once every adapter holds it.
    -- The adapters' useSpatialBudget also ask the native plugin for their switch (a log line) once its check has finished, so the
    -- injection repeats until a frame ran with the plugin check over (or no plugin) and then stops.
    if spatialInjected then
        spatialBudget.limit,spatialBudget.used,spatialBudget.deferred=spatialLimit,0,0
        return spatialBudget
    end
    spatialBudget=clearance.newBudget()
    spatialLimit=spatialBudget.limit
    clearance.useBudget(spatialBudget)
    actuator.useSpatialBudget(spatialBudget)
    placement.useSpatialBudget(spatialBudget)
    vehicleNative.useSpatialBudget(spatialBudget)
    spatialInjected=type(convaiNative)~='table' or convaiNative.pending~=true
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

-- Returns false when this mod's phone methods do not exist (its scripts did not compile, e.g. redscript missing): the setup
-- check already names that, so it is neither an error nor worth trying again this session.
function M.registerPhoneContacts(player)
    if type(player.ConvaiPhoneClearContacts) ~= 'function' then return false end
    player:ConvaiPhoneClearContacts()
    for id, contact in pairs(phoneContacts) do
        local key, reason = M.phoneContactKey(id)
        player:ConvaiPhoneRegisterContact(id, contact.name, key and '' or reason)
    end
    return true
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
        ..':'..tostring(fields.how or '')..':'..tostring(fields.retry or '')
    entry.notes=entry.notes or {}
    if runtimeClock-(entry.notes[key] or -math.huge)<8 then return end
    entry.notes[key]=runtimeClock
    fields.serial,fields.name=entry.serial,entry.name
    if entry.playerGap and not fields.gap then fields.gap=math.floor(entry.playerGap*10+.5)/10 end
    pcall(M.recoveryLog,kind,fields)
end
-- GetBodyType returns a CName; tostring() of one prints 'ToCName{ hash_lo = ..., hash_hi = ... --[[ WomanAverage --]] }'.
-- This gives the plain name ('WomanAverage'), or '' when there is none.
local function bodyName(value)
    if value == nil then return '' end
    if type(value) == 'string' then return value end
    if type(NameToString) == 'function' then
        local ok, name = pcall(NameToString, value)
        if ok and type(name) == 'string' and name ~= '' and name ~= 'None' then return name end
    end
    local raw = tostring(value)
    return raw:match('%-%-%[%[%s*(.-)%s*%-%-%]%]') or raw
end

local function rounded(value) return value and math.floor(value*10+.5)/10 or nil end
-- Copies the fleet gave up on (every unmount refused, still seated): dismissed at the start of the next tick, never inside the
-- fleet update that asked, because that update still holds this tick's list of ready copies.
local discardQueue = {}
local vehicleHooks = {
    discard = function(entry)
        discardQueue[#discardQueue+1] = entry.serial
        return true
    end,
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
    -- Live 2026-10-13: Judy did not look at V in a car and nothing said which gate held her back. One
    -- probe.log line when the seated attention changes (selected, the gate that failed, the style, the speed
    -- band or a look error), never per tick: the fields are compared, nothing is built unless one differs.
    local attention,motor=entry.motor.seatedAttention,entry.motor
    if entry.seatedGazePhase~=attention.phase or entry.seatedGazeReason~=attention.reason
        or entry.seatedGazeStyle~=attention.style or entry.seatedGazeError~=motor.lookError then
        entry.seatedGazePhase,entry.seatedGazeReason=attention.phase,attention.reason
        entry.seatedGazeStyle,entry.seatedGazeError=attention.style,motor.lookError
        note(entry,'seated-gaze',{reason=attention.reason,phase=attention.phase,style=attention.style or 'none',
            selected=context.selected==true,seat=context.seat and tostring(context.seat) or nil,
            speed=rounded(context.speed),error=motor.lookError or nil})
    end
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

-- A fresh copy is placed on the navmesh, which in some interiors stands 20-30 cm above the real floor (V's apartment:
-- navmesh 49.4-49.5, floor 49.2). An idle copy then stays at that height until she walks or leaves a workspot, so a
-- talk stance played in the meantime floated her up and dropped her at the exit (Round 5g, live). Lower her onto the
-- floor. Only a small drop (5-35 cm, the ground tolerance above), and only when a Static surface is found directly
-- below. Returns the drop in metres or nil. One raycast per call, charged to the shared spatial budget; returns false
-- (not nil) when the frame's budget is spent, so the caller retries on a later tick.
-- Live 2026-10-11 (Alt): a teleport made inside attachFollower is undone, because the AI role and `ai:OnAttach()` that
-- follow it put the copy back on the navmesh; she stayed at 49.50 for six seconds, then settled by herself when she
-- first turned. So the lowering runs a moment after attach (settleOnFloor), once the AI is set up.
-- The Static floor 5 cm to maxDrop (default 35 cm) below a point, or nil. false when the frame's budget is spent. One ray.
-- A spot the placement search returns is the navmesh point plus 10 cm, so a navmesh that stands 30 cm over the floor
-- leaves the floor 40 cm below it: those callers pass placeDrop.
local placeDrop = .45
local function floorBelow(at, maxDrop)
    if not clearance.take(1) then return false end
    -- The ray runs in companion-clearance.lua (floorZ), natively when the plugin is on.
    local ok, floor = pcall(clearance.floorZ, at, maxDrop)
    if not ok then return nil end
    return floor
end

local function lowerToFloor(entry, npc, actual)
    local floor = floorBelow(actual)
    if not floor then return floor end
    local ok, sent = pcall(function()
        -- An AI teleport command, not TeleportationFacility: a transform teleport on an AI-driven copy is undone by
        -- its own locomotion (companion-actuator.lua, Oct 5 trace; live again 2026-10-11: Alex and Judy were put back
        -- at 49.50 each time). nil: the previous command is still being cancelled, try again next tick.
        local angles = Quaternion.ToEulerAngles(npc:GetWorldOrientation())
        return actuator.teleport(entry.motor, Vector4.new(actual.x, actual.y, floor, 1), angles and angles.yaw or 0, 'floor-lowering')
    end)
    if not ok then return nil end
    if sent == nil then return false end
    if not sent then return nil end
    entry.floorTeleport = {z = floor, at = runtimeClock}
    return actual.z - floor
end

-- After attach (AI role set, OnAttach done) bring a copy that hovers above the floor down onto it: first try 0.5 s after
-- attach, one more 1 s later if she was moved and is still high; then stop. No work once finished (entry.floorFix nil).
local floorSettle = {first = .5, again = 1.0, tries = 2}
local function settleOnFloor(entry)
    local fix = entry.floorFix
    if not fix or runtimeClock < fix.at then return end
    local npc = entry.npc
    if not npc then entry.floorFix = nil; return end
    local lowered = lowerToFloor(entry, npc, npc:GetWorldPosition())
    if lowered == false then return end
    fix.tries = fix.tries + 1
    if lowered and fix.tries < floorSettle.tries then
        entry.loweredBy = (entry.loweredBy or 0) + lowered
        fix.at = runtimeClock + floorSettle.again
    else
        if lowered then entry.loweredBy = (entry.loweredBy or 0) + lowered end
        entry.floorFix = nil
    end
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
    entry.floorFix = {at = runtimeClock + floorSettle.first, tries = 0}
    -- Alt Cunningham's copy (companion-records.lua): invulnerable, once, no per-frame work. nil: not a protected model.
    entry.invulnerable = spawnRecords.protect(entry.entityID, entry.modelRecordID)
    -- Combat readiness (companion-records.lua): level scaling to V once, the attitude group read back once. A difference is
    -- read again 1 s later, once (the role may not have settled); then nothing more. No per-frame work.
    local prepared = select(2, pcall(spawnRecords.prepare, entry.system, entry.entityID, npc, player, entry.name))
    if type(prepared) == 'table' and prepared.attitude == 'mismatch' then
        entry.attitudeCheck = {at = runtimeClock + 1.0}
    end
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
        local ok, _, view = pcall(function() return crosshairData(Game.GetTargetingSystem(), player) end)
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
    local spawnRecord, recordError, spawnRecordName, spawnAppearance, spawnFallback = spawnRecords.resolve(recordID)
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
    -- The navmesh stands up to 30 cm above the real floor in some interiors; the AI undoes any later transform
    -- teleport, so a fresh copy is created on the floor itself when one ray finds it just below the navmesh point.
    local floorZ=floorBelow(spawnPosition, placeDrop)
    if floorZ==false then return nil,nil,true end
    spec.position = floorZ and Vector4.new(spawnPosition.x,spawnPosition.y,floorZ,1) or spawnPosition
    spec.orientation = adoption and adoption.orientation or player:GetWorldOrientation()
    spec.spawnInView = true
    spec.active = true
    spec.alwaysSpawned = true
    spec.persistState, spec.persistSpawn = false, false
    -- Native facial setup uses this tag before attachment. It never replaces
    -- an ambient or quest actor's graph based only on their character record.
    spec.tags = {CName.new('CyberpunkConvaiCompanion')}
    local created, entityID = pcall(function() return system:CreateEntity(spec) end)
    if (not created or not entityID or tostring(entityID.hash):match('^0+[uUlL]*$')) and spawnFallback then
        -- The private armed clone could not be spawned: use the record the character had before.
        if spawnRecords.log then pcall(spawnRecords.log, 'Companion spawn record: the armed clone could not be created; using the original record') end
        spec.recordID = spawnFallback
        created, entityID = pcall(function() return system:CreateEntity(spec) end)
    end
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
    -- Give the protection back once, while the entity still exists (companion-records.lua).
    if entry.invulnerable ~= nil and not entry.protectionReleased then
        entry.protectionReleased = true
        pcall(spawnRecords.unprotect, entry.entityID)
    end
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

-- A copy that failed (a spawn that timed out, a recovery after fast travel that could not finish, a refused attach): it is OUR spawned
-- copy, never a game character, so it is not left standing with a follower role. The role is cleared while the body still exists and the
-- delete is requested; the entry stays 'failed' (the manager shows why) with entry.removed once the game confirms it. A delete the game
-- accepted but has not finished is pending, not an error. Five refused attempts end the retries (Dismiss still works). Returns
-- removed, pending.
local function retireFailedCopy(entry)
    if entry.removed then return true,false end
    if (entry.cleanupTries or 0)>=5 then return false,false end
    if entry.role and entry.npc and not entry.roleCleared then
        entry.roleCleared=true
        pcall(function()
            if entry.npc:IsAttached() then
                local ai=entry.npc:GetAIControllerComponent()
                entry.role:OnRoleCleared(entry.npc)
                ai:SetAIRole(NewObject('AINoRole')); ai:OnAttach()
            end
        end)
    end
    local deleted,pending=deleteOwnedCopy(entry)
    if not deleted and not pending then entry.cleanupTries=(entry.cleanupTries or 0)+1 end
    return deleted==true,pending==true
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
                    bodyType = bodyName(entry.npc:GetBodyType()), distance = distance}
            end
        end
    end
    table.sort(result, function(a, b)
        if a.distance == b.distance then return a.entity < b.entity end
        return a.distance < b.distance
    end)
    return result
end

-- What each ready copy is doing right now, for a conversation turn (mod/turn-context.lua words it): the raw inputs, by profile
-- key, and how V is moving. Read on demand when a turn is built (never per frame); every read is guarded. `seats` maps a copy's
-- serial to its seating phase (init.lua passes the seating controller's snapshot).
function M.activityInputs(seats)
    local rows,motion={},nil
    local frame=groupFrame
    if frame then
        local speed=tonumber(frame.rawSpeed) or 0
        motion=speed<0.28 and 'still' or speed<3.2 and 'walking' or 'running'
    end
    local okTactic,tactic=pcall(function() return M.tactics and M.tactics.snapshot and M.tactics.snapshot() end)
    for _,entry in ipairs(entries) do
        if entry.state=='ready' and entry.profileKey then
            local okVehicle,snapshot=pcall(vehicles.snapshot,fleet,entry.serial)
            local transport=okVehicle and snapshot and snapshot.people and snapshot.people[1] or nil
            local owned=okTactic and tactic and tactic.active and tactic.serial==entry.serial
            rows[entry.profileKey]={transport=transport and {owned=transport.owned,phase=transport.phase,seat=transport.seat,
                mountedSeat=transport.mountedSeat} or nil,
                tactic=owned and {kind=tactic.kind,phase=tactic.phase} or nil,
                seating=type(seats)=='table' and seats[entry.serial] or nil,
                behavior=entry.person and entry.person.phase or nil}
        end
    end
    return {rows=rows,motion=motion}
end

-- The per-frame face writer's actor rows (init.lua onUpdate). conversationCandidates
-- costs about 0.1 ms of native reads per call (perf probe 2026-10-11, 45 calls/s), so
-- the rows are rebuilt at most every 0.1 s, or at once when the party list changes.
-- The writer re-checks ownership and attachment of every row it uses.
local expressionRows, expressionRowsAt, expressionRowsList, expressionRowsCount
function M.expressionActors(player)
    local now = os.clock()
    if expressionRows and expressionRowsList == entries and expressionRowsCount == #entries
        and now >= expressionRowsAt and now - expressionRowsAt < 0.1 then return expressionRows end
    expressionRows = M.conversationCandidates(player, 1000)
    -- A holocall's live-picture copy has the companions' face too (mod/holocall.lua faceRow), within 0.1 s of its picture.
    local holocall = convaiHolocall and convaiHolocall.faceRow and convaiHolocall.faceRow()
    if holocall then expressionRows[#expressionRows + 1] = holocall end
    expressionRowsAt, expressionRowsList, expressionRowsCount = now, entries, #entries
    return expressionRows
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
    -- The six rays run in companion-clearance.lua (sightClear), natively when the plugin is on.
    local ok,visible=pcall(clearance.sightClear,from,to)
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
            actualSpawnZ=e.spawnActual and e.spawnActual.z,spawnZ=e.spawnPosition.z,loweredBy=e.loweredBy,
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

-- The NPC handles the party holds right now, with their profile keys (init.lua abandonSession, at a world unload only, never per
-- frame): it watches them weakly through its one collect, while the world still exists, to find any that another holder keeps.
function M.heldActors()
    local out={}
    for _,entry in ipairs(entries) do
        if entry.npc then out[#out+1]={npc=entry.npc,key=entry.profileKey or entry.key} end
    end
    return out
end

function M.abandon(preserveTransit)
    -- Native components may already be torn down. Dropping references is enough:
    -- these DynamicEntitySystem copies are explicitly nonpersistent.
    -- The MoveTo observer (companion-locomotion.lua) reads the owner of every walking NPC's AI context while this is true. It is
    -- only refreshed by update(), which does not run until the next session is up, so switch it off here, before the world dies.
    if convaiLocomotion then convaiLocomotion.active=false end
    -- The face writer's cached actor rows hold every ready copy's (and every nearby talk candidate's) NPC handle.
    expressionRows,expressionRowsAt,expressionRowsList,expressionRowsCount=nil,nil,nil,nil
    if M.bodyAnimation and M.bodyAnimation.abandon then pcall(M.bodyAnimation.abandon,'companions-abandoned') end
    if M.stance and M.stance.abandon then pcall(M.stance.abandon) end
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
    passageState.riding,passageState.inCar,passageState.outSince,passageState.visitEnded=nil,nil,nil,nil
    passageState.carAnchor=nil
    riders={}; M.riders=nil
    vehicles.abandon(fleet)
    if reloadCleanup then reloadCleanupModule.abandon(reloadCleanup) end
end

-- Mod shutdown or CET reload with a live world: removes the overflow party cars, which no update would clean up again.
function M.destroyPartyCars() return vehicles.shutdown(fleet) end

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

-- Tactic hook: a tactic has ended and the copy may still hold a drawn weapon. Arms the equipment owner's holster
-- flow again (it holsters on its own once she is calm and relaxed). True when it was asked.
function M.rearmEquipment(entity)
    local entry=chauffeurEntry(entity)
    if not entry or not entry.equipment then return false end
    return equipment.rearm(entry.equipment)==true
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
    -- A second fast travel can start while the first one's recovery still runs (a copy in transit or spawning, up to 12 s). It takes
    -- over: copies already waiting in transit keep their receipts, the ones that came back become receipts again, and the fleet's
    -- suspended state stays the first travel's (it resumes once, when the last recovery ends).
    local previous=transit
    local party={}
    for _,entry in ipairs(entries) do
        local eligible=entry.state=='spawning'
        if previous and entry.state=='transit' then
            entry.retryAt=nil
            party[#party+1]=entry
        elseif entry.state=='ready' then
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
        -- A failed copy that is still standing goes with the party's receipts (retired again by update), never dropped without a delete.
        if entry.state=='failed' and not entry.removed and (entry.cleanupTries or 0)<5 then
            pcall(retireFailedCopy,entry)
            if not entry.removed then party[#party+1]=entry end
        end
        if entry.motor then actuator.abandon(entry.motor) end
        if entry.equipment then equipment.abandon(entry.equipment) end
    end
    transit={phase='loading',clock=0,fleet=previous and previous.fleet or vehicles.suspend(fleet)}
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
                        local removed,pending=retireFailedCopy(entry)
                        if not removed and not pending then
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
    unreachableDistance=6,unreachableAfter=4,watchedAfter=12,
    -- A stance the actuator's short step could not free (furniture right
    -- beside her): rejoin after 6 s from 2.5 m, still only out of view.
    stanceDistance=2.5,stanceAfter=6}
-- NPC sprint speed is capped by its animation (~5.4 m/s against V's ~8), so a
-- long sprint leaves followers behind. A follower more than 60 m back rejoins
-- out of view, placed behind V. If V can still see it (a long straight street),
-- it leaves after watchedAfter seconds anyway: a copy that far is a few pixels
-- tall when it vanishes, and the arrival spot is still checked to be hidden.
local catchUp={distance=60,after=2,watchedAfter=6,cooldown=8,behind=4}
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
    local following=motor.kind=='follow' and (motor.stage=='following' or motor.stage=='walking-leg')
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
    local ok,_,view=pcall(function() return crosshairData(Game.GetTargetingSystem(), player) end)
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
local setVisible
-- Who rides: a copy standing in the car with V when it departs (boarded this
-- visit, or within 1.6 m of where V stood). Her offset from V is kept.
local function boardRiders(s,now)
    riders={}
    for _,entry in ipairs(entries) do
        local at=entry.state=='ready' and entry.npc and entry.position
        -- Where V stood when the car left, or where V is now when the engine
        -- already moved her with the car (the first moving sample).
        local base=s.rideFrom
        if at and math.abs(at.z-now.z)<math.abs(at.z-base.z) then base=now end
        local walk=entry.carWalk
        local aboard=at and math.abs(at.z-base.z)<1 and (entry.carVisit==s.insideSince
            or walk and walk.purpose=='board' and walk.final and space.ground(at,walk.target)<1.2
            or space.ground(at,base)<1.6)
        if aboard then
            local ok,angles=pcall(function() return Quaternion.ToEulerAngles(entry.npc:GetWorldOrientation()) end)
            entry.carVisit,entry.carWalk,entry.carSearch=s.insideSince,nil,nil
            entry.riding,entry.rideDz,entry.carryError,entry.carryNoted=s.rideStarted,at.z-base.z,nil,nil
            entry.carrySent=0
            -- Live 2026-10-11: the per-frame carry never held her past the first
            -- second (lag 0.9 m after 1 s going down, "the lift phases through
            -- him"), and she was hidden only after that lag showed. She is hidden
            -- at departure, inside the shut car, and placed beside V at arrival
            -- (the hidden-rider path); no per-frame carry runs for her. Only
            -- when the hide cannot be queued is she carried as before.
            if setVisible(entry,false) then
                entry.rideHidden=runtimeClock
                note(entry,'lift-carry',{result='hidden',reason='departure',hidden=true})
            else
                -- The offset is kept from V's current position, which the carry follows.
                riders[#riders+1]={entry=entry,dx=at.x-now.x,dy=at.y-now.y,dz=at.z-base.z,
                    angles=ok and angles or EulerAngles.new(0,0,0)}
            end
        elseif at and math.abs(at.z-s.rideFrom.z)<1.5 and space.ground(at,s.rideFrom)<=separation.carDoorReach
            and not (M.departure and M.departure.owns(entry.serial))
            and not (M.tactics and M.tactics.owns(entry.serial)) then
            -- She tried to board this visit but is still outside: the car's
            -- doors are shut, so she vanishes from the landing and rides
            -- hidden, then appears in the car at arrival.
            entry.carWalk,entry.carSearch,entry.carRetry=nil,nil,nil
            entry.carVisit,entry.riding,entry.rideDz=s.insideSince,s.rideStarted,0
            entry.rideHidden=runtimeClock
            local hidden=setVisible(entry,false)
            note(entry,'lift-carry',{result='hidden',reason='not-aboard',hidden=hidden})
        end
    end
    M.riders=#riders>0 or nil
end
-- Called every frame by the owner, and only while M.riders is set: one
-- transform per rider for the length of the ride, nothing otherwise.
function M.carry(player)
    if not riders[1] then M.riders=nil; return end
    local v=player:GetWorldPosition()
    local found,facility=pcall(Game.GetTeleportationFacility)
    if not found or not facility then
        for _,r in ipairs(riders) do r.entry.carryError=tostring(facility or 'no teleport facility') end
        riders={}; M.riders=nil; return
    end
    for index=#riders,1,-1 do
        local r=riders[index]
        local npc=r.entry.state=='ready' and r.entry.npc
        local ok,err=false,'not ready'
        if npc then
            ok,err=pcall(function()
                facility:Teleport(npc,Vector4.new(v.x+r.dx,v.y+r.dy,v.z+r.dz,1),r.angles)
            end)
            if ok then
                r.entry.carrySent=(r.entry.carrySent or 0)+1
                -- Once per ride, not per frame: she is moved with V while the lift car moves.
                if not r.logged then
                    r.logged=true
                    local hook=rawget(_G,'convaiTeleportLog')
                    if hook then pcall(hook,{reason='lift-carry',actor=tostring(npc:GetEntityID().hash),
                        to={x=v.x+r.dx,y=v.y+r.dy,z=v.z+r.dz}}) end
                end
            end
        end
        if not ok then r.entry.carryError=tostring(err); table.remove(riders,index) end
    end
    if not riders[1] then M.riders=nil end
end
-- Live test 2026-10-08 20:07:59-20:08:10Z: the per-frame transform did not
-- move Judy at all (she stayed at z 8.3 while V rose to 49.2), which looked
-- like sinking through the car floor. A rider the carry does not hold within
-- 0.4 s (more than 0.35 m behind) is hidden for the rest of the ride (runtime visibility only, the
-- same event the phantom controller and adoption use) and is placed beside V
-- in the car at arrival, before the doors open; she is shown again once she
-- stands on V's floor, or after 40 s at the latest.
function setVisible(entry,visible)
    local ok,err=pcall(function()
        local event=NewObject('enteventsSetVisibility')
        event.visible=visible
        event.source=Enum.new('entVisibilityParamSource','PhantomEntitySystem')
        entry.npc:QueueEvent(event)
    end)
    if not ok then entry.visibilityError=tostring(err) end
    return ok
end
local function checkRiders(s,position)
    for _,entry in ipairs(entries) do
        if s.riding and entry.riding==s.rideStarted and not entry.rideHidden and entry.position then
            -- A held rider lags V by one frame at most (under 0.2 m at 10 m/s).
            local held=math.abs(entry.position.z-(position.z+(entry.rideDz or 0)))<.35
            if held and not entry.carryNoted and runtimeClock-s.rideStarted>=.4 then
                entry.carryNoted=true
                note(entry,'lift-carry',{result='held'})
            elseif not held and runtimeClock-s.rideStarted>=.4 then
                for index=#riders,1,-1 do if riders[index].entry==entry then table.remove(riders,index) end end
                if not riders[1] then M.riders=nil end
                entry.rideHidden=runtimeClock
                local hidden=setVisible(entry,false)
                note(entry,'lift-carry',{result='hidden',hidden=hidden,error=entry.carryError,sent=entry.carrySent,
                    lag=rounded(position.z+(entry.rideDz or 0)-entry.position.z)})
            end
        elseif entry.rideHidden and not s.riding and not entry.relocation and entry.position
            and (math.abs(entry.position.z-position.z)<1.5 or runtimeClock-entry.rideHidden>40) then
            entry.rideHidden=nil
            setVisible(entry,true)
            note(entry,'lift-carry',{result='shown'})
        end
    end
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
        local rawInside,moving=s.lift and s.lift.inside,s.lift and s.lift.moving
        -- One car visit survives a flicker of the inside flag. Live trace
        -- 2026-10-08 20:37:12Z: V stepped toward the doors inside the car and
        -- every boarding fallback, tied to the visit, was dropped silently.
        if rawInside then
            s.outSince=nil
            if not s.inCar then
                if not (s.visitEnded and runtimeClock-s.visitEnded<3 and s.carAnchor
                    and space.ground(position,s.carAnchor)<3 and math.abs(position.z-s.carAnchor.z)<1) then
                    s.insideSince,s.carAnchor=runtimeClock,space.copy(position)
                end
                s.inCar=true
            end
        elseif s.inCar then
            s.outSince=s.outSince or runtimeClock
            if runtimeClock-s.outSince>=1.5 then
                s.inCar,s.visitEnded,s.exitedAt=false,runtimeClock,runtimeClock
                s.carAnchor=space.copy(position)
            end
        end
        local inside=s.inCar
        -- A ride: the car's moving flag, or, until that flag has been seen
        -- set once (it is reflected, not yet seen live), V's height changing
        -- while V is in the car.
        if moving then s.movingFlagSeen=true end
        local riding=moving or (not s.movingFlagSeen and inside and runtimeClock<s.zMovingUntil) or false
        if riding and not s.riding then
            -- Who stood in the car is judged where the car stood, not where
            -- the first moving sample already finds V.
            s.rideStarted,s.rideFrom=runtimeClock,s.position or space.copy(position)
            boardRiders(s,position)
        end
        s.position=space.copy(position)
        if s.riding and not riding then s.arrivedAt=runtimeClock; riders={}; M.riders=nil end
        if riding and runtimeClock-s.rideStarted>90 then riders={}; M.riders=nil end
        -- Set before the riders are checked: a rider hidden at departure must
        -- not be shown again by the same sample (live 2026-10-11 07:20:23Z:
        -- hidden and shown in the same second, then hidden a second later).
        s.riding=riding
        checkRiders(s,position)
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
    entry.carExit,entry.carRetry=nil,nil
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
    -- A far straggler may leave while V watches it, but never arrives in view.
    local hideSpot=not watched or rule=='far'
    local plans={}
    if rule=='lift-board' then
        -- Beside V inside the car; the car floor can stand off the navmesh.
        local beside=copyPosition(space.offset(origin,forward,lateral>=0 and .9 or -.9,-.2))
        plans[#plans+1]={preferred=beside,accept=not watched and outOfView or nil,
            options={near=separation.carNear,sourceRadius=separation.carSource}}
    else
        local behind=copyPosition(space.offset(origin,forward,lateral,-catchUp.behind))
        plans[#plans+1]={preferred=behind,accept=outOfView}
        if watched and not hideSpot then plans[#plans+1]={preferred=behind} end
        -- V in a lift car: search from the walkable ground nearest V.
        if passageState.inCar then
            plans[#plans+1]={preferred=behind,accept=hideSpot and outOfView or nil,
                options={sourceRadius=separation.carSource}}
        end
        -- V's own recent footholds on this floor (a lobby, a doorway).
        for _,point in ipairs(passage.trailPoints(passageState.trail,origin,1.5,separation.trailReach,3)) do
            local foothold=Vector4.new(point.x,point.y,point.z,1)
            plans[#plans+1]={preferred=foothold,accept=hideSpot and outOfView or nil,
                options={origin=foothold},trail=true}
        end
    end
    local index=entry.placementPlan or 1
    if entry.placementRule~=rule or index>#plans then index=1 end
    entry.placementRule=rule
    local plan=plans[index]
    -- Recovery spots must be reachable by a swept walk from V's foothold, not only by a navmesh route.
    local options={sweepRoute=true}
    for key,value in pairs(plan.options or {}) do options[key]=value end
    local target,reason,deferred=placement.find(player,plan.preferred,occupiedPositions(entry),entry.clearance,
        plan.accept,options)
    if deferred then entry.placementPlan=index; return nil end
    if not target then
        if index<#plans then entry.placementPlan=index+1; return nil end
        entry.placementPlan=nil
        return false,reason or 'no-spot'
    end
    -- The same floor correction as a fresh copy: the spot is the navmesh height plus 10 cm, and an AI-driven copy stays at
    -- the height she is put at until she first walks (live 2026-10-11: relocated to 49.50 over a 49.20 floor, she stayed
    -- there for 10 s, and a stance played meanwhile floated her and dropped her at the exit). A lift car floor is not
    -- Static ground, so lift-board keeps the spot. If this frame's ray budget is spent, retry the same plan twice, then
    -- place her as found.
    if rule~='lift-board' then
        local floorZ=floorBelow(target,placeDrop)
        if floorZ==false and (entry.floorWaits or 0)<2 then
            entry.floorWaits=(entry.floorWaits or 0)+1
            entry.placementPlan=index
            return nil
        end
        entry.floorWaits=nil
        if floorZ then target=Vector4.new(target.x,target.y,floorZ,1) end
    end
    entry.placementPlan=nil
    local angles=Quaternion.ToEulerAngles(player:GetWorldOrientation())
    local sent=actuator.teleport(entry.motor,target,angles and angles.yaw or 0,'relocate:'..tostring(rule))
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
    local sent=actuator.teleport(entry.motor,spot,angles and angles.yaw or 0,'car:'..tostring(rule))
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
    -- Boarding hurries (V waits in the car); walking out keeps the old pace. A
    -- retry walks (it stops where it is told), and a native route to the doorway
    -- never sprints: a sprint stops loosely at the navmesh edge, off the line
    -- the straight leg into the car needs (live 2026-10-09 20:01Z).
    local gait=walk.gait
    if not gait then
        if walk.purpose~='board' then gait=gap>3 and 'Run' or 'Walk'
        else
            gait=passage.boardGait(gap)
            if gait=='Sprint' and (walk.navigate or walk.next) then gait='Run' end
        end
    end
    local startX,startY=from.x,from.y
    local sent=actuator.board(entry.motor,walk.target,{navigate=walk.navigate,gait=gait})
    if sent then
        stopPace(entry)
        -- Start of the whole walk (door leg and leg in count as one): the
        -- boarded line reports how long it took and how far she went.
        walk.t0,walk.from=walk.t0 or runtimeClock,walk.from or space.copy(from)
        walk.lastAt,walk.lastX,walk.lastY=runtimeClock,startX,startY
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
-- Already standing in the car: right beside V, or close to V with no
-- navmesh under her feet (the car floor carries none; the landing does).
local function carAboard(entry,flat)
    if flat<=1.3 then return true end
    if flat>2.2 then return false end
    local ok,found=pcall(function()
        return Game.GetAINavigationSystem():FindPointInSphereForCharacter(
            Vector4.new(entry.position.x,entry.position.y,entry.position.z,1),.3,entry.npc)
    end)
    if not ok then return false end
    local onNavmesh=found and found.status==Enum.new('worldNavigationRequestStatus','OK') and found.point
        and space.distance(found.point,entry.position)<=.35
    return not onNavmesh
end
-- The sweep of a straight leg into a car. Live 2026-10-11 (probe.log 07:18Z):
-- every leg from the doorway into the car was refused ("blocked") by the
-- 0.8 m wide, 2.2 m tall body box, also from 0.4 m beside V's own doorway
-- foothold, so she never walked in while V watched. The refusal is retried
-- with a slimmer body (a door frame and lintel are close to a body); the
-- rejection that stands is logged. Returns clear, deferred, tag, rejection.
local slimBody={radius=.25,height=1.9}
local function boardSweep(entry,from,to)
    local clear,_,deferred,rejection=clearance.segment(from,to,entry.clearance)
    if deferred then return nil,true end
    if clear then return true,nil,'clear' end
    local slim,_,slimDeferred=clearance.segment(from,to,slimBody)
    if slimDeferred then return nil,true end
    if slim then return true,nil,'slim',rejection end
    return false,nil,'blocked',rejection
end
local function blockedBy(rejection)
    if not rejection then return nil end
    local center=rejection.center
    return {by=rejection.group or rejection.geometryType,box=rejection.box,
        hit=center and {x=rounded(center.x),y=rounded(center.y),z=rounded(center.z)} or nil}
end
local function liftPassage(entry,player,v,rise,flat)
    local s=passageState
    local inside=s.inCar
    local walk=entry.carWalk
    if walk then
        -- A copy that moves faster than any gait (a sprint is 5.4 m/s) between
        -- two updates was warped by the engine, not walked: say so.
        local at=entry.position
        if walk.lastAt and walk.lastX then
            local dt=runtimeClock-walk.lastAt
            local moved=math.sqrt((at.x-walk.lastX)^2+(at.y-walk.lastY)^2)
            if moved>7*dt+.75 then
                note(entry,'lift-walk-jump',{metres=rounded(moved),secs=rounded(dt),purpose=walk.purpose})
            end
        end
        walk.lastAt,walk.lastX,walk.lastY=runtimeClock,at.x,at.y
        local gap=space.ground(entry.position,walk.target)
        local level=math.abs(entry.position.z-walk.target.z)<.6
        local reached=gap<(walk.exact and .3 or walk.navigate and .8 or .55) and level
        if not reached and gap<walk.best-.3 then walk.best,walk.bestAt=gap,runtimeClock end
        local ended=entry.motor.kind=='board' and (entry.motor.feedback.failed or entry.motor.feedback.complete)
        -- Live 2026-10-08 20:26:05Z: the native walk to the doorway ended 0.8 m
        -- short (V's doorway foothold is just off the navmesh) and the whole
        -- boarding was given up. Ending that close is arrival at the doorway.
        if not reached and walk.next and level and gap<1.5 and (ended or runtimeClock-walk.bestAt>=1) then reached=true end
        local stuck=runtimeClock>=walk.deadline or runtimeClock-walk.bestAt>=2.5 or ended and not reached
        local valid=walk.purpose~='board' or (inside and walk.visit==s.insideSince and not s.riding)
        if reached and walk.next and valid then
            -- The doorway reached on the navmesh: the straight leg into the car.
            local clear,deferred,_,rejection=boardSweep(entry,entry.position,walk.next)
            if deferred then return true end
            if not clear then walk.blocked=blockedBy(rejection) end
            if clear then
                local leg={purpose='board',target=walk.next,visit=walk.visit,final=true,gait=walk.gait,
                    t0=walk.t0,from=walk.from,blocked=walk.blocked}
                local sent=walkLeg(entry,leg,entry.position)
                if sent==nil then return true end
                if sent then entry.carWalk=leg; return true end
            end
            stuck,reached=true,false
        end
        if reached then
            entry.carWalk=nil
            note(entry,walk.purpose=='board' and 'lift-boarded' or 'lift-exited',{how='walked',
                secs=walk.t0 and rounded(runtimeClock-walk.t0) or nil,
                metres=walk.from and rounded(space.ground(walk.from,entry.position)) or nil})
            if walk.purpose~='board' then entry.carExit=nil; return false end
            entry.carVisit=walk.visit
        elseif not stuck and valid then
            return true
        else
            entry.carWalk=nil
            if walk.purpose=='board' then
                if not valid then return false end
                local spot=walk.spot or walk.next or walk.target
                note(entry,'lift-board-walk-failed',{walk=rounded(gap),navigate=walk.navigate==true,
                    retry=walk.retry==true,blocked=walk.blocked})
                -- One retry by another approach: straight (navmesh off) to the
                -- doorway V used, then straight in; or straight in from here.
                if not walk.retry then
                    local door=entry.carDoor
                    local legs={}
                    -- Live 2026-10-09 20:01Z: she stopped 0.5 m from the doorway
                    -- and the straight leg from there was blocked, so no door
                    -- leg was tried (it had to be over 0.6 m) and she was given
                    -- up. The door leg now goes exactly to the doorway foothold,
                    -- from anywhere past 0.3 m, and every retry leg walks.
                    if door and space.ground(entry.position,door)>.3 and space.ground(entry.position,door)<=separation.carDoorReach then
                        legs[#legs+1]={purpose='board',target=space.copy(door),next=space.copy(spot),spot=space.copy(spot),
                            visit=walk.visit,retry=true,exact=true,gait='Walk'}
                    end
                    legs[#legs+1]={purpose='board',target=space.copy(spot),spot=space.copy(spot),visit=walk.visit,
                        final=true,retry=true,gait='Walk'}
                    entry.carRetry={legs=legs,index=1,visit=walk.visit,spot=spot}
                    return true
                end
                -- Last resort, and never in view: wait for V to look away, at
                -- the latest until the car departs (then she rides hidden).
                entry.carSearch={visit=walk.visit,mode='hidden',spot=spot}
                return false
            end
            note(entry,'lift-exit-failed',{reason='walk-stalled',walk=rounded(gap)})
            return false
        end
    end
    local retry=entry.carRetry
    if retry then
        if not (inside and retry.visit==s.insideSince and not s.riding) then entry.carRetry=nil; return false end
        while retry.legs[retry.index] do
            local leg=retry.legs[retry.index]
            local clear,deferred=boardSweep(entry,entry.position,leg.target)
            if deferred then return true end
            if clear then
                local sent=walkLeg(entry,leg,entry.position)
                if sent==nil then return true end
                if sent then
                    entry.carRetry,entry.carWalk=nil,leg
                    note(entry,'lift-boarding',{how=leg.next and 'retry-door-then-walk' or 'retry-walk',
                        walk=rounded(space.ground(entry.position,leg.target))})
                    return true
                end
            end
            retry.index=retry.index+1
        end
        entry.carRetry=nil
        note(entry,'lift-boarding',{how='unseen-teleport',reason='no-clear-retry'})
        entry.carSearch={visit=retry.visit,mode='hidden',spot=retry.spot}
        return false
    end
    local search=entry.carSearch
    if search then
        if not (inside and search.visit==s.insideSince and not s.riding) then entry.carSearch=nil; return false end
        if search.mode=='hidden' and not search.spot then
            local towards=entry.carDoor or entry.position
            local spot,reason,pending=passage.carSpot(search,v,towards,occupiedPositions(entry),entry.clearance,clearance)
            if pending then return false end
            if not spot then
                entry.carSearch,entry.carNoFloor=nil,search.visit
                note(entry,'lift-car-spot',{reason=reason,mode='hidden'})
                return false -- the navmesh placement beside V, out of view
            end
            search.spot=spot
        end
        if search.mode=='hidden' then
            -- Placed the moment V's view leaves her and the spot.
            if runtimeClock<(search.checkAt or 0) then return false end
            search.checkAt=runtimeClock+.25
            if not unseen(player,entry,search.spot) then return false end
            local moved=carTeleport(entry,player,search.spot,search.visit,'lift-board','unseen')
            if moved==nil then return true end
            entry.carSearch=nil
            return moved
        end
        local spot,reason,pending=search.spot,nil,nil
        if not spot then
            -- Boarding: the side toward the doorway V used, a straight line in.
            -- A hidden arrival: behind V's view, where V does not see her appear.
            local towards=entry.position
            if search.mode=='board' and entry.carDoor then towards=entry.carDoor
            elseif entry.rideHidden then
                local forward=cameraForward(player)
                if forward then towards={x=v.x-forward.x*2,y=v.y-forward.y*2,z=v.z} end
            end
            spot,reason,pending=passage.carSpot(search,v,towards,occupiedPositions(entry),entry.clearance,clearance)
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
                local _,deferred,tag,rejection=boardSweep(entry,entry.position,spot)
                if deferred then return true end
                search.swept,search.blocked=tag,blockedBy(rejection)
            end
            -- Straight in, or the native route to the doorway V used first.
            local leg
            if search.swept~='blocked' and gap<=separation.carWalk then
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
                        walk=rounded(gap),swept=search.swept,blocked=search.blocked})
                    return true
                end
            end
            note(entry,'lift-boarding',{how='unseen-teleport',walk=rounded(gap),swept=search.swept,
                blocked=search.blocked})
            entry.carSearch={visit=search.visit,mode='hidden',spot=spot}
            return false
        end
        -- The car left without her: back in it only out of V's view. A
        -- hidden rider's own position is not seen; only the spot matters.
        if runtimeClock<(search.checkAt or 0) then return false end
        search.checkAt=runtimeClock+.25
        local clear=entry.rideHidden and hiddenFromPlayer(player,spot)==true or unseen(player,entry,spot)
        if not clear then
            note(entry,'lift-car-spot',{reason='in-view',mode=search.mode})
            return false
        end
        local moved=carTeleport(entry,player,spot,search.visit,'lift-arrival','car')
        if moved==nil then return true end
        entry.carSearch=nil
        return moved
    end
    local visit=entry.carVisit
    if visit then
        local sameVisit=inside and visit==s.insideSince
        local rider=s.riding and entry.riding==s.rideStarted
        if sameVisit and (rider or rise<1.5 and flat<=separation.carStay) then
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
        entry.rodeWithV=entry.riding==s.rideStarted
            or space.ground(entry.position,from)<separation.carGap and math.abs(entry.position.z-from.z)<1.2
        note(entry,'lift-departed',{withV=entry.rodeWithV,flat=rounded(flat)})
    end
    if s.arrivedAt and entry.arrivalSeen~=s.arrivedAt then
        entry.arrivalSeen=s.arrivedAt
        note(entry,'lift-arrived',{rise=rounded(rise),withV=entry.rodeWithV==true})
        -- She stood in the car but the car left without her: back beside V in
        -- the car, where V last saw her, before V steps out.
        if entry.rodeWithV and s.inCar and not s.riding and rise>separation.verticalGap
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
    local stanceStuck=not unreachable and actuator.unstuckRecently(entry.motor,20)
    if not blockedRecently or entry.playerGap<(unreachable and stranded.unreachableDistance
        or stanceStuck and stranded.stanceDistance or stranded.distance) then
        entry.strandedSince,entry.strandedAnchor=nil,nil
    else
        if not entry.strandedAnchor or space.distance(entry.strandedAnchor,entry.position)>1 then
            if not entry.strandedAnchor then
                note(entry,'stranded',{reason=rejection and rejection.stage or 'blocked',rise=rounded(rise)})
            end
            entry.strandedAnchor,entry.strandedSince=space.copy(entry.position),runtimeClock
        end
        stuckFor=runtimeClock-entry.strandedSince
        strandedReady=stuckFor>=(unreachable and stranded.unreachableAfter
            or stanceStuck and stranded.stanceAfter or stranded.after)
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
    -- V waits in a stopped car: every party member near it gets in. Not only
    -- a blocked one (live 20:37Z: V by the doors, she 1.6 m away outside).
    local carStop=s.inCar and not s.riding and s.insideSince and runtimeClock-s.insideSince>=separation.boardAfter
    local presence=carStop and rise<1.5 and flat<=separation.carDoorReach and entry.carVisit~=s.insideSince
        and not entry.carWalk and not entry.carSearch and not entry.carRetry
    -- No car floor found by physics: the navmesh placement beside V, out of view.
    local boardReady=presence and entry.carNoFloor==s.insideSince and entry.boardedVisit~=s.insideSince
    if entry.motor.kind=='follow' and entry.playerGap>catchUp.distance then
        entry.farSince=entry.farSince or runtimeClock
    else entry.farSince=nil end
    local farReady=entry.farSince~=nil and runtimeClock-entry.farSince>=catchUp.after
        and runtimeClock>=(entry.catchUpAt or 0)
    -- Just after fast travel: a copy the game left far away rejoins at once.
    local arriving=entry.arrivalUntil and runtimeClock<entry.arrivalUntil
    local arrivalReady=arriving and entry.playerGap>separation.arrivalGap
        and runtimeClock-entry.arrivalStart>=separation.arrivalAfter
    if presence and entry.carNoFloor~=s.insideSince and runtimeClock>=(entry.carCheckAt or 0) then
        entry.carCheckAt=runtimeClock+.5
        if carAboard(entry,flat) then
            entry.carVisit=s.insideSince
            note(entry,'lift-boarded',{how='aboard'})
            return liftPassage(entry,player,v,rise,flat)
        end
        if entry.carTried~=s.insideSince then
            -- First a walk in onto the car floor found by physics.
            entry.carTried=s.insideSince
            entry.carSearch={visit=s.insideSince,mode='board'}
            -- V's last foothold before the car: the doorway, on the walkable floor.
            -- The inside flag can lag V's steps, so footholds within 1.5 m of V
            -- (already in the car) do not count.
            entry.carDoor=passage.trailPoints(s.trail,v,1.5,6,1)[1]
        else
            -- The walks of this visit are spent: placed once V looks away, at
            -- the latest hidden from the landing as the car departs.
            entry.carSearch={visit=s.insideSince,mode='hidden'}
            note(entry,'lift-boarding',{how='unseen-teleport',reason='not-aboard'})
        end
        return liftPassage(entry,player,v,rise,flat)
    end
    local rule,watched
    if boardReady then rule,watched='lift-board',false
    elseif verticalReady then
        rule=liftArrival and 'lift-arrival' or 'floor-change'
        -- Never in view after a ride; only a long wait on another floor may.
        watched=verticalFor>=(liftArrival and stranded.watchedAfter or separation.floorWatchedAfter)
    elseif farReady then rule,watched='far',runtimeClock-entry.farSince>=catchUp.watchedAfter
    elseif arrivalReady then rule,watched='fast-travel',runtimeClock-entry.arrivalStart>=separation.arrivalWatchedAfter
    elseif strandedReady then
        rule,watched=unreachable and 'no-route' or stanceStuck and 'stance' or 'blocked',watchedTooLong
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
        -- No hidden spot behind V right now: look again in a few seconds, not twice a second.
        if rule=='far' then entry.strandedRetryAt=runtimeClock+stranded.retry end
    end
    return moved==true
end

-- Why a managed copy must stand although V crouches (companion-stance.lua): the transport, lift,
-- leaving and tactic owners, or a body animation, hold her body. In-memory flags only; nil = may crouch.
local function stanceBlocker(entry)
    if vehicles.owns(fleet,entry.serial) then return 'vehicle' end
    local s=passageState
    if s.riding or s.inCar or (s.lift and (s.lift.inside or s.lift.moving)) or entry.riding or entry.rideHidden
        or entry.relocation or entry.carWalk or entry.carSearch then return 'lift' end
    if M.departure and M.departure.owns(entry.serial) then return 'leaving' end
    if M.tactics and M.tactics.owns(entry.serial) then return 'tactic' end
    if M.bodyAnimation and M.bodyAnimation.owns and M.bodyAnimation.owns(entry) then return 'seated' end
    if entry.floorTeleport then return 'placing' end
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
    if #discardQueue>0 then
        local queued=discardQueue; discardQueue={}
        for _,serial in ipairs(queued) do
            local ok,done=pcall(M.dismiss,serial)
            -- A refused removal reopens the fleet's own retry (it asks again ten seconds later).
            if not ok or done==false then vehicles.discardRefused(fleet,serial) end
        end
    end
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
            if entry.state=='failed' then
                local removed,pending=retireFailedCopy(entry)
                entry.cleanupAt=runtimeClock+2
                if not removed and not pending then entry.error=entry.error..' The copy could not be removed; try Dismiss.' end
            end
        end
    end
    -- A failed copy that is still standing (a recovery that could not finish, a delete the game had not confirmed) is retired again every
    -- two seconds, at most five refusals: one clock comparison per failed entry, and nothing once it is gone.
    for _,entry in ipairs(entries) do
        if entry.state=='failed' and not entry.removed and runtimeClock>=(entry.cleanupAt or 0) and (entry.cleanupTries or 0)<5 then
            entry.cleanupAt=runtimeClock+2
            pcall(retireFailedCopy,entry)
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
            -- 0 missing, 1 dead, 2 alive. The native answers both checks in one call; nil asks the game from Lua.
            local life=tickNative and tickNative.life(entry.npc)
            if life==nil then life=entry.npc:IsAttached() and (entry.npc:IsDeadNoStatPool() and 1 or 2) or 0 end
            if life==0 then
                entry.state='missing'; actuator.abandon(entry.motor)
                equipment.abandon(entry.equipment); vehicles.remove(fleet,entry.serial)
            elseif life==1 then
                entry.state='dead'; actuator.abandon(entry.motor)
                equipment.abandon(entry.equipment); vehicles.remove(fleet,entry.serial)
            else ready[#ready+1]=entry end
        end
    end
    -- Development only: mod/face-test.lua (not in a player package) sets M.devQuiet while its face-stage probe places a
    -- character, and everything below (movement, turning, body animation, gestures, seated attention) then leaves that
    -- copy alone. Nil in the shipped mod: one nil check per tick, nothing per copy.
    local quiet=M.devQuiet
    if quiet then for i=#ready,1,-1 do if quiet[ready[i].serial] then table.remove(ready,i) end end end
    -- Crouch with V (companion-stance.lua): a few comparisons unless V crouches or a copy is held crouched.
    if M.stance then pcall(M.stance.tick,step,ready,player,stanceBlocker) end
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
        if entry.floorFix then pcall(settleOnFloor,entry) end
        if entry.attitudeCheck and runtimeClock >= entry.attitudeCheck.at then
            entry.attitudeCheck = nil
            if entry.npc then pcall(spawnRecords.attitudeRecheck, entry.npc, player, entry.name) end
        end
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
                -- One native call answers the reads and the maths below; nil runs the original lines.
                local tick=tickNative and tickNative.sense(entry,playerPosition,step)
                local at
                if tick then
                    at=tick.at
                    entry.speed=tick.speed
                    entry.position=at
                    entry.direction=tick.direction
                    entry.maxSpeed=math.max(entry.maxSpeed or 0,entry.speed)
                    entry.playerGap=tick.playerGap
                    entry.facingError=tick.facingError
                else
                    at=space.copy(entry.npc:GetWorldPosition())
                    entry.speed=entry.position and space.ground(entry.position,at)/step or 0
                    entry.position=at
                    local forward=entry.npc:GetWorldForward()
                    entry.direction=space.unit(forward.x,forward.y)
                    entry.maxSpeed=math.max(entry.maxSpeed or 0,entry.speed)
                    entry.playerGap=space.distance(at,playerPosition)
                    entry.facingError=space.angle(entry.direction,space.bearing(at,playerPosition))
                end
                entry.sensedCombat=tick and tick.combat -- nil: read below
                actuator.sense(entry.motor,at,entry.speed,step,tick)
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
            -- Seating owns its copy from the walk to the seat until she stands
            -- clear again (docs/COMPANION_SEATING.md): no recovery teleport then.
            local seated=M.bodyAnimation and M.bodyAnimation.owns and M.bodyAnimation.owns(entry)
            -- The AI teleport that lowers a fresh copy onto the floor runs before any new decision retires it.
            local lowering=entry.floorTeleport
            if lowering then
                if math.abs(entry.position.z-lowering.z)<.05 or runtimeClock-lowering.at>2 then entry.floorTeleport=nil
                else return end
            end
            if not tactic and not departing and not seated and recoverDistant(entry,player) then return end
            local id=tostring(entry.entityID.hash)
            local lane=travel.laneFrame(groupFrame,entry.lane)
            local travelTarget=space.offset(lane.position,lane.direction,slots[entry.lane][1],0)
            local choices=space.candidates(groupFrame,entry.lane)
            local restTarget=choices[1]
            for _,point in ipairs(choices) do
                if space.clear(point,playerPosition,others,id,nil,entry.clearance) then restTarget=point; break end
            end
            entry.targetGap=space.distance(entry.position,groupFrame.moving and travelTarget or restTarget)
            local fightingOk,fighting=true,entry.sensedCombat
            if fighting==nil then fightingOk,fighting=pcall(function() return NPCPuppet.IsInCombat(entry.npc) end) end
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
            -- Seating (docs/COMPANION_SEATING.md): a walk to a seat beside a
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
                local stance=M.stance
                local observed,holds=pcall(body.observe,entry,{idle=idle and not equipment.holdsMovement(entry.equipment),
                    phase=decision.phase,combat=context.combat,selected=context.selected,
                    -- V crouches, or this copy is held crouched / still being stood up: no gesture workspot
                    -- may start over the pose, and a running one leaves (companion-stance.lua).
                    crouched=stance~=nil and (stance.crouched() or stance.holds(entry.serial)) or false,
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
            -- The tactic draws for itself at the fight start; the equipment owner draws for any other combat.
            if entry.equipment then entry.equipment.noDraw,entry.equipment.label=tactic and true or nil,entry.name end
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
