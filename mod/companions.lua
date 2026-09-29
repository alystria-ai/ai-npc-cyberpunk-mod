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

function M.spawn(key)
    local definition = records[key]
    if not definition then return nil, 'Unknown companion' end
    if #entries >= #slots then return nil, 'Your party has eight copies. Dismiss one first.' end
    local player = Game.GetPlayer()
    local system = Game.GetDynamicEntitySystem()
    if not player or not system or not system:IsReady() then return nil, 'World is not ready' end
    local recordID = definition.recordID or TweakDBID.new(definition.id)
    local recordOk, record = pcall(function() return TweakDB:GetRecord(recordID) end)
    if not recordOk or not record then return nil, 'This model is not available in your installation.' end
    local typeOk, character = pcall(function() return record:IsA('gamedataCharacter_Record') end)
    if not typeOk or not character then return nil, 'This record is not a character model.' end
    if #entries == 0 then
        local ok, _, view = pcall(function() return Game.GetTargetingSystem():GetCrosshairData(player) end)
        local forward = ok and view or player:GetWorldForward()
        if not forward then forward = player:GetWorldForward() end
        groupFrame = travel.new(space.copy(player:GetWorldPosition()), forward)
        commandCursor = 0
    end
    local occupied, lanes = {}, {}
    for _, entry in ipairs(entries) do occupied[entry.slot] = true; lanes[entry.lane or entry.slot] = true end
    local freeSlot, freeLane
    for slot = 1, #slots do
        if not occupied[slot] then freeSlot = slot; break end
    end
    for slot = 1, #slots do
        if not lanes[slot] then freeLane = slot; break end
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
    serial = serial + 1
    local entry = {
        serial = serial, key = key, name = definition.name, slot = freeSlot, lane = freeLane,
        profileKey = definition.profileKey, profileName = definition.profileName or definition.name,
        record = definition.id or tostring(recordID),
        spawnRecord = spawnRecordName or definition.id or tostring(recordID),
        entityID = entityID, system = system, state = 'spawning',
        requestedAt = os.time(), requestedClock = runtimeClock,
        spawnPosition = copyPosition(spawnPosition),
        person = behavior.new(serial),
    }
    entries[#entries + 1] = entry
    -- Start connection setup while the engine is attaching the new copy.
    if M.onPartyChanged then pcall(M.onPartyChanged) end
    return serial
end

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
    -- Remove reply-owned audio/captions while this exact entity is still live.
    -- Other copies of the same character keep their own dialogue state.
    if M.onBeforeRemove then pcall(M.onBeforeRemove, tostring(entry.entityID.hash)) end
    local checked, managed = pcall(function() return entry.system:IsManaged(entry.entityID) end)
    if checked and not managed then entry.removed = true; return true end
    local removed, result = pcall(function() return entry.system:DeleteEntity(entry.entityID) end)
    if removed and result ~= false then entry.removed = true; return true end
    return false
end


function M.dismiss(serialToDismiss)
    for index,entry in ipairs(entries) do
        if entry.serial==serialToDismiss then
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
            if not deleteOwnedCopy(entry) then
                entry.state,entry.error='failed','The game could not dismiss this copy. Try again after closing other menus.'
                return false,entry.error
            end
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
            focused=focused,focusLook=m.lookStyle=='full',ambientLook=m.lookStyle=='side',
            lookError=m.lookError,
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

function M.abandon()
    -- Native components may already be torn down. Dropping references is enough:
    -- these DynamicEntitySystem copies are explicitly nonpersistent.
    for _,entry in ipairs(entries) do
        if entry.motor then actuator.abandon(entry.motor) end
        if entry.equipment then equipment.abandon(entry.equipment) end
    end
    entries={}
    elapsed,runtimeClock,commandCursor=0,0,0
    groupFrame=nil
end

local function personalSpace(at,player,others,id)
    if space.ground(at,player)<0.72 then return false end
    for _,other in ipairs(others) do
        if other.id~=id and not other.reserved and space.distance(at,other.position)<0.65 then return false end
    end
    return true
end
local function yieldPoint(at,player,others,id)
    local nearest=player
    for _,other in ipairs(others) do
        if other.id~=id and not other.reserved
            and space.distance(at,other.position)<space.distance(at,nearest) then nearest=other.position end
    end
    return space.offset(at,space.bearing(nearest,at),0,0.5)
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
    if not groupFrame then return end
    local lastReversal=groupFrame.reversal

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

    local order,others,company={},{},{people={},focus=focusEntity}
    -- All people are sensed before anyone is planned: iteration order must not
    -- make later members react to partially updated group state.
    for _,entry in ipairs(entries) do
        if entry.state=='ready' then
            if not entry.npc:IsAttached() then
                entry.state='missing'; actuator.abandon(entry.motor)
                equipment.abandon(entry.equipment)
            elseif entry.npc:IsDeadNoStatPool() then
                entry.state='dead'; actuator.abandon(entry.motor)
                equipment.abandon(entry.equipment)
            else
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
                motion=entry.motor.feedback,travelTarget=travelTarget,restTarget=restTarget,
                comfortable=space.comfortable(entry.position,groupFrame,entry.lane,others,id),
                nearGroup=space.nearGroup(entry.position,groupFrame,entry.lane,others,id),
                personalSpace=personalSpace(entry.position,playerPosition,others,id),
                yieldTarget=yieldPoint(entry.position,playerPosition,others,id),others=others,
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
