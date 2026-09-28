-- Managed copies only. World and quest NPCs are never assigned a follower role.
local M = {}
local behavior = dofile('companion-behavior.lua')
local placement = dofile('companion-placement.lua')
local appearance = dofile('companion-appearance.lua')

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

local slots = {
    {-1.5, 0.05}, {1.5, 0.05},
    {-2.6, -1.35}, {2.6, -1.35},
    {-1.2, -2.65}, {1.2, -2.65},
    {-2.6, -3.9}, {2.6, -3.9},
}

local entries = {}
local serial = 0
local elapsed = 0
local runtimeClock = 0
local previousPlayerPosition = nil
local formationAngle = nil
local formationFrame = {moving = false, run = false, anchor = nil, quietFor = 0, movingFor = 0, fastFor = 0, slowFor = 0, epoch = 0}
local commandCursor = 0

local function copyPosition(p)
    return Vector4.new(p.x, p.y, p.z, p.w)
end

local function distance(a, b)
    return math.sqrt((a.x - b.x)^2 + (a.y - b.y)^2 + (a.z - b.z)^2)
end

local function atan2(y, x)
    if math.atan2 then return math.atan2(y, x) end
    if x > 0 then return math.atan(y / x) end
    if x < 0 then return math.atan(y / x) + (y >= 0 and math.pi or -math.pi) end
    if y > 0 then return math.pi / 2 end
    if y < 0 then return -math.pi / 2 end
    return 0
end

local function formationPosition(player, slot, anchor)
    local origin, forward = copyPosition(anchor or player:GetWorldPosition()), player:GetWorldForward()
    local length = math.sqrt(forward.x^2 + forward.y^2)
    if length < 0.001 and not formationAngle then return origin end
    local x = formationAngle and math.cos(formationAngle) or forward.x / length
    local y = formationAngle and math.sin(formationAngle) or forward.y / length
    local lateral, longitudinal = slots[slot][1], slots[slot][2]
    origin.x = origin.x - y * lateral + x * longitudinal
    origin.y = origin.y + x * lateral + y * longitudinal
    return origin
end

local function advanceFrame(player, position, step)
    local frame = formationFrame
    frame.justStopped = false
    local dx = previousPlayerPosition and position.x - previousPlayerPosition.x or 0
    local dy = previousPlayerPosition and position.y - previousPlayerPosition.y or 0
    local groundDistance = math.sqrt(dx * dx + dy * dy)
    local speed = groundDistance / step
    if not formationAngle then
        local forward = player:GetWorldForward()
        formationAngle = atan2(forward.y, forward.x)
    end
    if speed > 0.9 then
        frame.movingFor = frame.movingFor + step
        frame.quietFor = 0
    else
        frame.quietFor = frame.quietFor + step
        frame.movingFor = 0
    end
    local departureDistance = frame.anchor and distance(frame.anchor, position) or 0
    -- A person can step around a resting group to face a friend. Keep the
    -- group's places and heading until V actually leaves that small area.
    if not frame.moving and ((frame.movingFor >= 0.45 and departureDistance >= 1.15)
        or departureDistance > 2.2) then
        frame.moving = true
        frame.epoch = frame.epoch + 1
    elseif frame.moving and frame.quietFor >= 0.9 then
        frame.moving = false
        frame.justStopped = true
    end
    if frame.moving and groundDistance > 0.35 and speed > 0.8 then
        local travelAngle = atan2(dy, dx)
        local turn = (travelAngle - formationAngle + math.pi) % (2 * math.pi) - math.pi
        local limit = math.min(0.35, step * 0.7)
        formationAngle = formationAngle + math.max(-limit, math.min(limit, turn))
    end
    if speed > 2.6 then
        frame.fastFor = frame.fastFor + step
        frame.slowFor = 0
    elseif speed < 1.8 then
        frame.slowFor = frame.slowFor + step
        frame.fastFor = 0
    end
    if not frame.run and frame.fastFor >= 0.3 then frame.run = true end
    if frame.run and frame.slowFor >= 0.9 then frame.run = false end
    if frame.moving then
        -- Lead the moving target a fraction of a refresh interval, capped so
        -- an abrupt turn cannot send companions across the street.
        local lead = math.min(0.55, math.max(0.2, step * 0.5))
        local magnitude = math.min(1.2, groundDistance / step * lead)
        local anchor = copyPosition(position)
        if groundDistance > 0.01 then
            anchor.x = anchor.x + dx / groundDistance * magnitude
            anchor.y = anchor.y + dy / groundDistance * magnitude
        end
        frame.anchor = anchor
    elseif not frame.anchor or frame.justStopped then
        frame.anchor = copyPosition(position)
    end
    previousPlayerPosition = copyPosition(position)
    return frame, speed
end

local function formationOrder()
    local sorted = {}
    for _, entry in ipairs(entries) do
        if entry.state == 'ready' then sorted[#sorted + 1] = entry end
    end
    table.sort(sorted, function(a, b) return a.serial < b.serial end)
    return sorted
end

local function stopAICommand(entry, command)
    if entry.npc and entry.npc:IsAttached() and command then
        local ai = entry.npc:GetAIControllerComponent()
        local ok = pcall(function()
            local state = tostring(ai:GetCommandState(command))
            if state:find('Executing', 1, true) then
                ai:StopExecutingCommand(command, true)
            elseif state:find('Enqueued', 1, true) then
                ai:CancelCommand(command)
            end
        end)
        if not ok then pcall(function() ai:CancelCommand(command) end) end
    end
end

local function cancelMovement(entry)
    stopAICommand(entry, entry.command)
    entry.command = nil
    entry.commandTarget = nil
    entry.commandRunning = nil
end

local function releaseHold(entry)
    stopAICommand(entry, entry.hold)
    entry.hold = nil
end

local ensureHold

local function releaseFocusTurn(entry)
    stopAICommand(entry, entry.focusTurn)
    entry.focusTurn = nil
    entry.focusTurnTarget = nil
    entry.focusTurnAt = nil
end

local function releaseFocusStep(entry)
    stopAICommand(entry, entry.focusStep)
    entry.focusStep = nil
    entry.focusStepAt = nil
end

local function releaseRouteTurn(entry)
    stopAICommand(entry, entry.routeTurn)
    entry.routeTurn, entry.routeTurnAt = nil, nil
end

local function clearFocusLook(entry)
    if not entry.focusLook then return end
    local event = entry.focusLook
    entry.focusLook = nil
    if entry.npc and entry.npc:IsAttached() then
        pcall(function() LookAtRemoveEvent.QueueRemoveLookatEvent(entry.npc, event) end)
    end
end

local function issueRotate(entry, target, speed)
    local world = WorldPosition.new()
    world:SetVector4(target)
    local spec = AIPositionSpec.new()
    spec:SetWorldPosition(world)
    local command = NewObject('AIRotateToCommand')
    command.target = spec
    command.angleTolerance = 7.0
    command.angleOffset = 0.0
    command.speed = speed
    entry.npc:GetAIControllerComponent():SendCommand(command)
    return command
end

local function headingError(npc, x, y)
    local forward = npc:GetWorldForward()
    local length = math.sqrt(x * x + y * y)
    local facingLength = math.sqrt(forward.x^2 + forward.y^2)
    if length < 0.1 or facingLength < 0.1 then return 0 end
    local dot = (forward.x * x + forward.y * y) / (facingLength * length)
    return math.deg(math.acos(math.max(-1, math.min(1, dot))))
end

local function stepIntoConversation(entry, player, playerPosition, at)
    if entry.focusStepDone then return false end
    if entry.focusStep then
        local ok, state = pcall(function()
            return tostring(entry.npc:GetAIControllerComponent():GetCommandState(entry.focusStep))
        end)
        entry.focusStepState = ok and state or tostring(state)
        if ok and (state:find('Executing', 1, true) or state:find('Enqueued', 1, true))
            and runtimeClock - (entry.focusStepAt or 0) < 2.5 then return true end
        if entry.focusStepStart then
            entry.focusStepDistance = distance(entry.focusStepStart, entry.npc:GetWorldPosition())
        end
        local current = entry.npc:GetWorldPosition()
        entry.focusStepFacingError = headingError(entry.npc,
            playerPosition.x - current.x, playerPosition.y - current.y)
        releaseFocusStep(entry)
        entry.focusStepDone = true
        entry.attentionStepAnchor = copyPosition(playerPosition)
        return false
    end
    local dx, dy = playerPosition.x - at.x, playerPosition.y - at.y
    local gap = math.sqrt(dx * dx + dy * dy)
    if formationFrame.moving or gap < 0.9 or gap > 3.0 then
        entry.focusStepDone = true
        return false
    end
    local advance = math.max(0.0, math.min(0.16, gap - 1.20))
    releaseHold(entry)
    local ok, command = pcall(function()
        local destination = Vector4.new(
            at.x + dx / gap * advance,
            at.y + dy / gap * advance,
            at.z, at.w)
        local world = WorldPosition.new()
        world:SetVector4(destination)
        local target = AIPositionSpec.new()
        target:SetWorldPosition(world)
        local facing = AIPositionSpec.new()
        facing:SetEntity(player)
        local move = NewObject('AIMoveToCommand')
        move.movementTarget = target
        move.facingTarget = facing
        -- Only the accepted 16 cm conversation step may face V while moving.
        move.rotateEntityTowardsFacingTarget = true
        move.movementType = Enum.new('moveMovementType', 'Walk')
        move.desiredDistanceFromTarget = 0.05
        move.finishWhenDestinationReached = true
        move.ignoreNavigation = false
        move.useStart = true
        move.useStop = true
        entry.npc:GetAIControllerComponent():SendCommand(move)
        return move
    end)
    if ok then
        entry.focusStep = command
        entry.focusStepAt = runtimeClock
        entry.focusStepStart = copyPosition(at)
        -- Claim this step before movement begins. Gaze targeting can briefly
        -- drop while the actor moves, and reacquisition must not send another.
        entry.attentionStepAnchor = copyPosition(playerPosition)
        return true
    end
    entry.focusStepError = tostring(command)
    entry.focusStepDone = true
    return false
end

local function turnTowardPlayer(entry, playerPosition)
    if entry.facingError and entry.facingError < 12 then
        releaseFocusTurn(entry)
        ensureHold(entry)
        return
    end
    if entry.focusTurn then
        local ok, state = pcall(function()
            return tostring(entry.npc:GetAIControllerComponent():GetCommandState(entry.focusTurn))
        end)
        entry.focusTurnState = ok and state or 'Unavailable'
        if ok and (state:find('Executing', 1, true) or state:find('Enqueued', 1, true))
            and runtimeClock - (entry.focusTurnAt or 0) < 3.0 then return end
        releaseFocusTurn(entry)
    end
    if (entry.focusTurnAttempts or 0) >= 3 then
        ensureHold(entry)
        return
    end
    releaseHold(entry)
    local ok, command = pcall(function()
        return issueRotate(entry, playerPosition, 95.0)
    end)
    if ok then
        entry.focusTurn = command
        entry.focusTurnAt = runtimeClock
        entry.focusTurnTarget = copyPosition(playerPosition)
        entry.focusTurnAttempts = (entry.focusTurnAttempts or 0) + 1
    else
        entry.focusTurnError = tostring(command)
        ensureHold(entry)
    end
end

ensureHold = function(entry)
    if entry.hold then
        local ok, state = pcall(function()
            return tostring(entry.npc:GetAIControllerComponent():GetCommandState(entry.hold))
        end)
        if ok and (state:find('Executing', 1, true) or state:find('Enqueued', 1, true)) then return end
        releaseHold(entry)
    end
    local ok, result = pcall(function()
        local command = NewObject('AIHoldPositionCommand')
        command.duration = 40.0
        entry.npc:GetAIControllerComponent():SendCommand(command)
        return command
    end)
    if ok then entry.hold = result else entry.holdError = tostring(result) end
end

local function clearAmbientLook(entry)
    if not entry.ambientLook then return end
    local event = entry.ambientLook
    entry.ambientLook = nil
    if not entry.npc or not entry.npc:IsAttached() then return end
    local ok, err = pcall(function()
        LookAtRemoveEvent.QueueRemoveLookatEvent(entry.npc, event)
    end)
    if not ok then
        entry.ambientLookDisabled = true
        entry.ambientLookError = tostring(err)
    end
end

local function ensureAmbientLook(entry, player)
    if entry.ambientLook or entry.ambientLookDisabled then return end
    local ok, result = pcall(function()
        local event = LookAtAddEvent.new()
        event:SetEntityTarget(player, CName.new('pla_default_tgt'), Vector4.new(0, 0, 0, 0))
        event:SetStyle(Enum.new('animLookAtStyle', 'Normal'))
        event.bodyPart = CName.new('Eyes')
        event.request.limits.softLimitDegrees = 60.0
        event.request.limits.hardLimitDegrees = 110.0
        event.request.limits.backLimitDegrees = 110.0
        event.request.limits.hardLimitDistance = 5.0
        local head = LookAtPartRequest.new()
        head.partName = CName.new('Head')
        head.weight = 0.05
        head.suppress = 1.0
        head.mode = 0
        local chest = LookAtPartRequest.new()
        chest.partName, chest.weight, chest.suppress, chest.mode = CName.new('Chest'), 0.0, 0.0, 0
        event:SetAdditionalPartsArray({head, chest})
        entry.npc:QueueEvent(event)
        return event
    end)
    if ok then
        entry.ambientLook = result
    else
        entry.ambientLookDisabled = true
        entry.ambientLookError = tostring(result)
    end
end

local function ensureFocusLook(entry, player)
    if entry.focusLook then return end
    local ok, result = pcall(function()
        local event = LookAtAddEvent.new()
        event:SetEntityTarget(player, CName.new('pla_default_tgt'), Vector4.new(0, 0, 0, 0))
        event:SetStyle(Enum.new('animLookAtStyle', 'Normal'))
        event.bodyPart = CName.new('Eyes')
        event.request.limits.softLimitDegrees = 360.0
        event.request.limits.hardLimitDegrees = 270.0
        event.request.limits.backLimitDegrees = 210.0
        event.request.limits.hardLimitDistance = 5.0
        event.request.calculatePositionInParentSpace = true
        local head, chest = LookAtPartRequest.new(), LookAtPartRequest.new()
        head.partName, head.weight, head.suppress, head.mode = CName.new('Head'), 0.1, 1.0, 0
        chest.partName, chest.weight, chest.suppress, chest.mode = CName.new('Chest'), 0.0, 0.0, 0
        event:SetAdditionalPartsArray({head, chest})
        entry.npc:QueueEvent(event)
        return event
    end)
    if ok then entry.focusLook = result else entry.focusLookError = tostring(result) end
end

local function inSideZone(entry, at, playerPosition)
    if not formationAngle then return false end
    local dx, dy = at.x - playerPosition.x, at.y - playerPosition.y
    local lateral = -math.sin(formationAngle) * dx + math.cos(formationAngle) * dy
    local longitudinal = math.cos(formationAngle) * dx + math.sin(formationAngle) * dy
    entry.relativeSide = lateral
    entry.relativeForward = longitudinal
    local desiredSide, desiredForward = slots[entry.slot][1], slots[entry.slot][2]
    return lateral * desiredSide > 0
        and math.abs(lateral) > (entry.slot <= 2 and 0.75 or 1.0)
        and math.abs(lateral) < math.abs(desiredSide) + 1.2
        and longitudinal > desiredForward - 1.4
        and longitudinal < desiredForward + 1.2
        and distance(at, playerPosition) < (entry.slot <= 2 and 3.3 or 4.8)
end

local function turnBeforeWalking(entry, target, remaining)
    local at = entry.npc:GetWorldPosition()
    local error = headingError(entry.npc, target.x-at.x, target.y-at.y)
    entry.routeFacingError = error
    -- Once a leg is walking, navigation owns steering. Do not interrupt it
    -- with another turn because a start/stop animation briefly changes yaw.
    -- A materially different destination or a new leg may turn again.
    if entry.command and entry.mode == 'side' and entry.commandTarget
        and distance(entry.commandTarget, target) < 0.9 then return false end
    if entry.routeTurn then
        if error <= 30.0 or remaining < 0.4 then
            releaseRouteTurn(entry)
            return false
        end
        if runtimeClock - entry.routeTurnAt > 2.5 then
            releaseRouteTurn(entry)
            -- A failed native rotation must not create an endless turn loop.
            entry.fallbackUntil = runtimeClock + 3.0
            return true
        end
        return true
    end
    -- Native short-path locomotion can choose a backward/strafe animation even
    -- without a look-at target. Face the route first for a substantial turn.
    if remaining < 0.6 or error < 65.0 then return false end
    if (entry.npcSpeed or 0) > 0.6 and (error < 110.0 or remaining > 4.0) then return false end
    cancelMovement(entry)
    releaseHold(entry)
    clearAmbientLook(entry)
    entry.routeTurn = issueRotate(entry, target, 120.0)
    entry.routeTurnAt = runtimeClock
    entry.mode = 'route-turn'
    return true
end

local function followPlayer(entry, player, running)
    local mode = running and 'run' or 'follow'
    if entry.mode == mode and entry.command then
        local ok, state = pcall(function() return entry.npc:GetAIControllerComponent():GetCommandState(entry.command) end)
        local label = ok and tostring(state) or ''
        if label:find('Executing', 1, true) or label:find('Enqueued', 1, true) then return false end
        if runtimeClock - (entry.lastCommandAt or 0) < 1.5 then return false end
    end
    cancelMovement(entry)
    local command = NewObject('AIFollowTargetCommand')
    command.target = player
    -- Path following owns heading. An entity look-at here persists throughout
    -- catch-up and competes with the later diagonal approach to a side lane.
    command.desiredDistance = 1.6 + math.floor((entry.slot - 1) / 2) * 0.4
    command.tolerance = 0.5
    -- FollowTarget remains active as V moves. Sprint is needed for a real
    -- catch-up animation; repeated world-point MoveTo commands restart gait.
    command.movementType = Enum.new('moveMovementType', running and 'Sprint' or 'Walk')
    command.matchSpeed = not running
    command.teleport = false
    command.stopWhenDestinationReached = false
    entry.npc:GetAIControllerComponent():SendCommand(command)
    entry.command = command
    entry.mode = mode
    entry.requestedGait = running and 'Sprint' or 'Walk'
    if running then entry.sprintRequests = (entry.sprintRequests or 0) + 1 end
    entry.lastCommandAt = runtimeClock
    return true
end

local function moveBeside(entry, target, running, allowCommand)
    local npc = entry.npc
    local at = npc:GetWorldPosition()
    local remaining = distance(at, target)
    if remaining < 0.4 then
        releaseRouteTurn(entry)
        if entry.mode ~= 'settled' then cancelMovement(entry) end
        entry.mode = 'settled'
        return false
    end
    if turnBeforeWalking(entry, target, remaining) then return false end
    local now = runtimeClock
    if entry.mode == 'side' and entry.commandTarget
        and entry.commandRunning == running
        and distance(entry.commandTarget, target) < 0.9
        and now - (entry.lastCommandAt or 0) < 2.0 then return false end
    if entry.mode == 'side' and entry.commandRunning == running
        and now - (entry.lastCommandAt or 0) < (running and 0.55 or 1.0) then return false end
    if not allowCommand then return false end
    cancelMovement(entry)
    local world = WorldPosition.new()
    world:SetVector4(target)
    local spec = AIPositionSpec.new()
    spec:SetWorldPosition(world)
    local command = NewObject('AIMoveToCommand')
    command.movementTarget = spec
    -- Explicitly disable strafe-facing. The native handler only replaces its
    -- facing entity for entity specs, so a world-point facing spec can leave V
    -- from a previous conversation step in the behavior's argument mapping.
    command.rotateEntityTowardsFacingTarget = false
    command.movementType = Enum.new('moveMovementType', running and 'Run' or 'Walk')
    command.desiredDistanceFromTarget = 0.15
    command.finishWhenDestinationReached = true
    command.ignoreNavigation = false
    command.useStart = true
    command.useStop = true
    -- Publish ownership before SendCommand; the native handler may run during
    -- that call. Its facing cleanup must match this exact command and copy.
    entry.command = command
    npc:GetAIControllerComponent():SendCommand(command)
    entry.commandTarget = target
    entry.commandRunning = running
    entry.requestedGait = running and 'Run' or 'Walk'
    if running then entry.sideRunRequests = (entry.sideRunRequests or 0) + 1 end
    entry.lastCommandAt = now
    entry.mode = 'side'
    return true
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
        -- Camera yaw can change without a world-position update. A new party
        -- takes its initial side lanes from the current view, not an old walk.
        local ok, _, view = pcall(function()
            return Game.GetTargetingSystem():GetCrosshairData(player)
        end)
        local forward = ok and view or player:GetWorldForward()
        if not forward or math.sqrt(forward.x^2 + forward.y^2) < 0.1 then
            forward = player:GetWorldForward()
        end
        formationAngle = atan2(forward.y, forward.x)
        previousPlayerPosition = copyPosition(player:GetWorldPosition())
        formationFrame = {moving = false, run = false, anchor = copyPosition(previousPlayerPosition), quietFor = 0, movingFor = 0, fastFor = 0, slowFor = 0, epoch = 0}
        commandCursor = 0
    end
    local occupied = {}
    for _, entry in ipairs(entries) do occupied[entry.slot] = true end
    local freeSlot
    for slot = 1, #slots do
        if not occupied[slot] then freeSlot = slot; break end
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
    local spawnPosition, placementError = placement.find(player, formationPosition(player, freeSlot), occupiedPositions)
    if not spawnPosition then return nil, placementError end
    local spec = NewObject('DynamicEntitySpec')
    spec.recordID = recordID
    spec.position = spawnPosition
    spec.orientation = player:GetWorldOrientation()
    spec.spawnInView = true
    spec.active = true
    spec.alwaysSpawned = true
    spec.persistState, spec.persistSpawn = false, false
    local created, entityID = pcall(function() return system:CreateEntity(spec) end)
    if not created or not entityID or tostring(entityID.hash):match('^0+[uUlL]*$') then
        return nil, 'The game could not create a copy of this model.'
    end
    serial = serial + 1
    local entry = {
        serial = serial, key = key, name = definition.name, slot = freeSlot,
        profileKey = definition.profileKey, profileName = definition.profileName or definition.name,
        record = definition.id or tostring(recordID),
        entityID = entityID, system = system, state = 'spawning',
        requestedAt = os.time(), requestedClock = runtimeClock,
        spawnPosition = copyPosition(spawnPosition),
        behavior = behavior.new(), behaviorTrace = {},
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
    local checked, managed = pcall(function() return entry.system:IsManaged(entry.entityID) end)
    if checked and not managed then entry.removed = true; return true end
    local removed, result = pcall(function() return entry.system:DeleteEntity(entry.entityID) end)
    if removed and result ~= false then entry.removed = true; return true end
    return false
end

function M.dismiss(serialToDismiss)
    for index, entry in ipairs(entries) do
        if entry.serial == serialToDismiss then
            clearAmbientLook(entry)
            clearFocusLook(entry)
            releaseFocusStep(entry)
            releaseFocusTurn(entry)
            releaseHold(entry)
            cancelMovement(entry)
            releaseRouteTurn(entry)
            if entry.npc and entry.npc:IsAttached() and entry.role then
                pcall(function()
                    local ai = entry.npc:GetAIControllerComponent()
                    entry.role:OnRoleCleared(entry.npc)
                    ai:SetAIRole(NewObject('AINoRole'))
                    ai:OnAttach()
                end)
            end
            if not deleteOwnedCopy(entry) then
                entry.state, entry.error = 'failed', 'The game could not dismiss this copy. Try again after closing other menus.'
                return false, entry.error
            end
            table.remove(entries, index)
            if #entries == 0 then
                formationAngle = nil
                previousPlayerPosition = nil
            end
            if M.onPartyChanged then pcall(M.onPartyChanged) end
            return true
        end
    end
    return false
end

function M.dismissAll()
    -- A failed engine deletion must not trap shutdown in an endless loop.
    local allRemoved = true
    for index = #entries, 1, -1 do
        if not M.dismiss(entries[index].serial) then allRemoved = false end
    end
    return allRemoved
end

function M.owns(npc)
    if not npc then return false end
    local ok, identity = pcall(function() return tostring(npc:GetEntityID().hash) end)
    if not ok then return false end
    for _, entry in ipairs(entries) do
        if entry.state == 'ready' and tostring(entry.entityID.hash) == identity then return true end
    end
    return false
end

function M.ownsTravelCommand(npc, command)
    if not npc or not command then return false end
    local identity = tostring(npc:GetEntityID().hash)
    for _, entry in ipairs(entries) do
        if entry.state == 'ready' and tostring(entry.entityID.hash) == identity
            and entry.command and entry.command.id ~= nil
            and entry.command.id == command.id then
            return true
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

function M.list()
    local copy = {}
    local totals, seen = {}, {}
    for _, entry in ipairs(entries) do totals[entry.key] = (totals[entry.key] or 0) + 1 end
    for _, entry in ipairs(entries) do
        seen[entry.key] = (seen[entry.key] or 0) + 1
        copy[#copy + 1] = {
            serial = entry.serial, key = entry.key,
            profileKey = entry.profileKey, profileName = entry.profileName, record = entry.record,
            slot = entry.slot,
            name = entry.name .. (totals[entry.key] > 1 and (' #' .. seen[entry.key]) or ''),
            state = entry.state, mode = entry.mode, error = entry.error,
            behavior = entry.behavior and entry.behavior.phase,
            behaviorReason = entry.behavior and entry.behavior.reason,
            behaviorTrace = entry.behaviorTrace,
            entityID = tostring(entry.entityID.hash),
            spawnZ = entry.spawnPosition and entry.spawnPosition.z,
            actualSpawnZ = entry.spawnActual and entry.spawnActual.z,
            phantomControllersDisabled = entry.phantomControllersDisabled,
            playerZ = entry.playerZ,
            npcZ = entry.lastPosition and entry.lastPosition.z,
            distanceToPlayer = entry.distanceToPlayer,
            distanceToSeat = entry.distanceToSeat,
            playerSpeed = entry.speed,
            npcSpeed = entry.npcSpeed,
            maxPlayerSpeed = entry.maxPlayerSpeed,
            maxNpcSpeed = entry.maxNpcSpeed,
            requestedGait = entry.requestedGait,
            playerRunning = formationFrame.run,
            sprintRequests = entry.sprintRequests or 0,
            sideRunRequests = entry.sideRunRequests or 0,
            holding = entry.hold ~= nil,
            holdError = entry.holdError,
            ambientLook = entry.ambientLook ~= nil,
            ambientLookError = entry.ambientLookError,
            focusLook = entry.focusLook ~= nil,
            focusLookError = entry.focusLookError,
            relativeSide = entry.relativeSide,
            relativeForward = entry.relativeForward,
            facingErrorDegrees = entry.facingError,
            focused = entry.focused,
            focusTurnAttempts = entry.focusTurnAttempts or 0,
            focusTurnError = entry.focusTurnError,
            -- list() is also read by paused menus and during load transitions.
            -- Never dereference an engine command from this snapshot path.
            focusTurnState = entry.focusTurnState,
            focusStepState = entry.focusStepState,
            focusStepDone = entry.focusStepDone,
            focusStepError = entry.focusStepError,
            focusStepDistance = entry.focusStepDistance,
            focusStepFacingError = entry.focusStepFacingError,
            routeFacingError = entry.routeFacingError,
            routeTurning = entry.routeTurn ~= nil,
            focusInitialError = entry.focusInitialError,
            focusBestError = entry.focusBestError,
            focusSeconds = entry.focusStartedAt and math.max(0, runtimeClock - entry.focusStartedAt) or nil,
            fallbackSeconds = math.max(0, (entry.fallbackUntil or 0) - runtimeClock),
        }
    end
    return copy
end

local function spotIsClear(entry, at, playerPosition)
    if distance(at, playerPosition) < 1.0 then return false end
    for _, other in ipairs(entries) do
        if other ~= entry and other.state == 'ready' and other.npc and other.npc:IsAttached()
            and distance(at, other.npc:GetWorldPosition()) < 0.85 then return false end
    end
    return true
end

-- Called while the engine unloads a world. Discard references only: cancelling
-- AI commands or deleting entities at this point can call an already torn-down
-- native controller. Nonpersistent owned entities are removed by Codeware.
function M.abandon()
    entries = {}
    elapsed, runtimeClock, commandCursor = 0, 0, 0
    previousPlayerPosition, formationAngle = nil, nil
    formationFrame = {moving = false, run = false, anchor = nil,
        quietFor = 0, movingFor = 0, fastFor = 0, slowFor = 0, epoch = 0}
end

local function observeProgress(entry, at, gap)
    if gap < 2.0 or entry.mode ~= 'side' then
        entry.progress = nil
        return
    end
    local sample = entry.progress
    if not sample or distance(sample.position, at) > 0.55 then
        entry.progress = {position = copyPosition(at), at = runtimeClock}
    elseif runtimeClock - sample.at > 3.5 then
        -- Repeated MoveTo requests cannot repair a blocked native route.
        -- Give the ordinary follower AI a quiet interval before another try.
        entry.fallbackUntil = runtimeClock + 4.0
        entry.progress = nil
    end
end

function M.update(player, delta, focusEntity)
    if not player then return end
    local dt = tonumber(delta) or 0
    runtimeClock = runtimeClock + dt
    elapsed = elapsed + dt
    if elapsed < 0.45 then return end
    local step = elapsed
    elapsed = 0
    local playerPosition = player:GetWorldPosition()
    local frame, speed = advanceFrame(player, playerPosition, step)

    for _, entry in ipairs(entries) do
        if entry.state == 'spawning' then
            if entry.system:IsSpawned(entry.entityID) then
                local ok, result, reason = pcall(attachFollower, entry, player)
                if not ok or result == false then
                    entry.state = 'failed'
                    entry.error = tostring(ok and reason or result)
                end
            end
            if entry.state == 'spawning' and runtimeClock - entry.requestedClock > 12 then
                entry.state = 'failed'
                entry.error = 'Spawn timed out'
            end
            if entry.state == 'failed' then
                -- Only the DynamicEntitySystem copy created above is removed.
                -- Keep its failed row so the manager can explain the failure.
                if not deleteOwnedCopy(entry) then
                    entry.error = entry.error .. ' The copy could not be removed; try Dismiss.'
                end
            end
        end
    end

    local order = formationOrder()
    if #order == 0 then return end
    -- A group needs one movement decision per member; serializing three
    -- companions over several frames makes the back of the party lag badly.
    local budget = math.min(4, #order)
    local first = commandCursor % #order
    commandCursor = (commandCursor + 1) % #order
    for i = 1, #order do
        local slot = (first + i - 1) % #order + 1
        local entry = order[slot]
        if not entry.npc:IsAttached() then
            entry.state = 'missing'
        else
            local ok, problem = pcall(function()
                local at = entry.npc:GetWorldPosition()
                local towardX, towardY = playerPosition.x - at.x, playerPosition.y - at.y
                local towardLength = math.sqrt(towardX^2 + towardY^2)
                if towardLength > 0.1 then
                    local facing = entry.npc:GetWorldForward()
                    local facingLength = math.sqrt(facing.x^2 + facing.y^2)
                    if facingLength > 0.1 then
                        local dot = (facing.x * towardX + facing.y * towardY) /
                            (facingLength * towardLength)
                        entry.facingError = math.deg(math.acos(math.max(-1, math.min(1, dot))))
                    end
                end
                entry.npcSpeed = entry.lastPosition and distance(entry.lastPosition, at) / step or 0
                entry.lastPosition = copyPosition(at)
                entry.maxNpcSpeed = math.max(entry.maxNpcSpeed or 0, entry.npcSpeed)
                entry.maxPlayerSpeed = math.max(entry.maxPlayerSpeed or 0, speed)
                entry.distanceToPlayer = distance(at, playerPosition)
                entry.playerZ = playerPosition.z
                entry.distanceToSeat = distance(at, formationPosition(player, entry.slot, frame.anchor))
                entry.speed = speed
                local naturalSide = inSideZone(entry, at, playerPosition)
                local playerShifted = entry.attentionStepAnchor
                    and distance(playerPosition, entry.attentionStepAnchor) > 0.45
                if playerShifted then entry.attentionStepAnchor = nil end
                if entry.epoch ~= frame.epoch then
                    entry.epoch = frame.epoch
                    entry.parked = nil
                    entry.attentionAnchor = nil
                    entry.attentionStepAnchor = nil
                    entry.progress = nil
                end
                if frame.moving then
                    entry.parked, entry.attentionAnchor = nil, nil
                end
                local focusRequested = tostring(entry.entityID.hash) == focusEntity
                if entry.focused and (not focusRequested or frame.moving or playerShifted) then
                    if not frame.moving and naturalSide and spotIsClear(entry, at, playerPosition) then
                        -- Accept the small conversation step instead of sending
                        -- the actor back to an exact mathematical seat.
                        entry.parked = copyPosition(at)
                        entry.attentionAnchor = copyPosition(playerPosition)
                    end
                end
                local seat = formationPosition(player, entry.slot, frame.anchor)
                if entry.attentionAnchor
                    and distance(playerPosition, entry.attentionAnchor) > 0.45 then
                    entry.attentionAnchor = nil
                end
                -- Keep a comfortable arrival for the whole stop. Revoking it
                -- for being off the exact seat caused a second correction.
                if not frame.moving
                    and (distance(at, seat) < 0.6 or naturalSide)
                    and spotIsClear(entry, at, playerPosition) then
                    -- Park only after the companion reaches the side seat.
                    -- A loose side zone avoids rigid position micro-adjustments.
                    entry.parked = entry.parked or copyPosition(at)
                end
                local goal = entry.parked or seat
                local gap = distance(at, goal)
                local playerGap = distance(at, playerPosition)
                observeProgress(entry, at, gap)
                local combatOk, fighting = pcall(function() return NPCPuppet.IsInCombat(entry.npc) end)
                entry.behavior = entry.behavior or behavior.new()
                local decision = behavior.decide(entry.behavior, {
                    combat = combatOk and fighting == true,
                    playerMoving = frame.moving, playerRunning = frame.run, playerSpeed = speed,
                    npcSpeed = entry.npcSpeed, playerGap = playerGap, seatGap = gap,
                    arrived = gap < 0.6 and spotIsClear(entry, at, playerPosition),
                    focusRequested = focusRequested, playerShifted = playerShifted,
                    facingError = entry.facingError or 180,
                    blocked = runtimeClock < (entry.fallbackUntil or 0),
                }, step)
                if decision.changed then
                    entry.behaviorTrace = entry.behaviorTrace or {}
                    if #entry.behaviorTrace >= 12 then table.remove(entry.behaviorTrace, 1) end
                    entry.behaviorTrace[#entry.behaviorTrace + 1] = {
                        at = runtimeClock, phase = decision.phase, reason = decision.reason,
                        playerGap = playerGap, seatGap = gap, npcSpeed = entry.npcSpeed}
                end

                -- Release all commands from the previous owner before the next
                -- phase submits anything. Gaze cannot leave a hold or turn alive
                -- underneath a follow/move command, including during combat.
                if decision.movement ~= 'attention' then
                    clearFocusLook(entry)
                    releaseFocusStep(entry)
                    releaseFocusTurn(entry)
                    entry.focused, entry.focusStartedAt = false, nil
                end
                if decision.look ~= 'side' then clearAmbientLook(entry) end
                if decision.movement ~= 'side' then releaseRouteTurn(entry) end

                if decision.movement == 'release' then
                    cancelMovement(entry)
                    releaseHold(entry)
                    entry.mode, entry.parked, entry.progress = 'combat', nil, nil
                    return
                elseif decision.movement == 'attention' then
                    cancelMovement(entry)
                    if not entry.focused then
                        entry.focused, entry.focusStartedAt = true, runtimeClock
                        entry.focusInitialError, entry.focusBestError = entry.facingError, entry.facingError
                        entry.focusTurnAttempts = 0
                        entry.focusStepDone = entry.attentionStepAnchor ~= nil
                        entry.focusStepDistance, entry.focusStepFacingError = nil, nil
                    end
                    entry.focusBestError = math.min(entry.focusBestError or 180, entry.facingError or 180)
                    entry.mode = 'busy'
                    ensureFocusLook(entry, player)
                    if stepIntoConversation(entry, player, playerPosition, at) then return end
                    turnTowardPlayer(entry, playerPosition)
                    return
                elseif decision.movement == 'hold' then
                    cancelMovement(entry)
                    entry.mode = 'settled'
                    ensureHold(entry)
                elseif decision.movement == 'follow' then
                    releaseHold(entry)
                    if budget > 0 then
                        if followPlayer(entry, player, decision.running) then budget = budget - 1 end
                    end
                elseif decision.movement == 'side' then
                    releaseHold(entry)
                    if moveBeside(entry, goal, decision.running, budget > 0) then budget = budget - 1 end
                end
                if decision.look == 'side' and not entry.routeTurn then ensureAmbientLook(entry, player) end
                entry.distanceToPlayer = playerGap
                entry.distanceToSeat = gap
                entry.speed = speed
            end)
            if not ok then entry.error = tostring(problem) end
        end
    end
end

return M
