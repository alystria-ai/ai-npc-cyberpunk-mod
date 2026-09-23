-- Loaded by the adapter on demand. The output stays in this mod's runtime directory.
local requestFile = io.open('runtime/diagnostic-request.txt', 'rb')
local request = requestFile and requestFile:read('*a') or ''
if requestFile then requestFile:close() end
if request:match('^party%-mappin%-preflight:') then
    local ok, result = pcall(function()
        local names = {
            'Mappins.DefaultStaticMappin',
            'Mappins.DefaultDynamicMappin',
            'Mappins.QuestDynamicMappinDefinition',
            'Mappins.QuestStaticMappinDefinition',
        }
        local lines = {}
        for _, name in ipairs(names) do
            lines[#lines + 1] = name .. '=' .. tostring(TweakDB:GetRecord(name) ~= nil)
        end
        for _, name in ipairs({'NPCVariant', 'ChangeToFriendlyVariant', 'DefaultVariant'}) do
            local valid, value = pcall(function() return Enum.new('gamedataMappinVariant', name) end)
            lines[#lines + 1] = name .. '=' .. tostring(valid and value or valid)
        end
        return table.concat(lines, '\n')
    end)
    local file = io.open('runtime/party-mappin-preflight.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^lookat%-preflight:') then
    local attempts = {}
    local constructors = {
        {'NewObject(LookAtAddEvent)', function() return NewObject('LookAtAddEvent') end},
        {'LookAtAddEvent.new', function() return LookAtAddEvent.new() end},
        {'LookAtAddEvent()', function() return LookAtAddEvent() end},
        {'NewObject(gameLookAtAddEvent)', function() return NewObject('gameLookAtAddEvent') end},
        {'configured glance', function()
            local event = LookAtAddEvent.new()
            event:SetStyle(Enum.new('animLookAtStyle', 'Normal'))
            event.request.transitionSpeed = 66.6
            event.bodyPart = CName.new('Head')
            return event
        end},
        {'ambient entity look', function()
            local event = LookAtAddEvent.new()
            event:SetEntityTarget(Game.GetPlayer(), CName.new('pla_default_tgt'), Vector4.new(0, 0, 0, 0))
            event:SetStyle(Enum.new('animLookAtStyle', 'Normal'))
            event.bodyPart = CName.new('Eyes')
            local head = LookAtPartRequest.new()
            head.partName = CName.new('Head')
            head.weight = 0.05
            head.suppress = 1.0
            head.mode = 0
            event:SetAdditionalPartsArray({head})
            return event
        end},
    }
    for _, candidate in ipairs(constructors) do
        local ok, value = pcall(candidate[2])
        attempts[#attempts + 1] = candidate[1] .. ' ok=' .. tostring(ok)
            .. ' value=' .. tostring(value)
    end
    local file = io.open('runtime/lookat-preflight.txt', 'wb')
    if file then file:write(table.concat(attempts, '\n')); file:close() end
    return
end
if request:match('^party%-hotpatch:') then
    local ok, result = pcall(function()
        if not convaiCompanions then return 'Companion runtime missing' end
        if #convaiCompanions.list() > 0 then return 'Dismiss the active party first' end
        local replacement = dofile('companions.lua')
        for name, value in pairs(replacement) do convaiCompanions[name] = value end
        return 'Companion runtime refreshed in place'
    end)
    local file = io.open('runtime/party-hotpatch.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^party%-spawn:') then
    local key = request:match('^party%-spawn:([^:]+)')
    local ok, result = pcall(function()
        if not convaiCompanions then return 'Companion manager not loaded' end
        local serial, err = convaiCompanions.spawn(key)
        return serial and ('spawn_requested=' .. tostring(serial) .. ' key=' .. tostring(key)) or ('error=' .. tostring(err))
    end)
    local file = io.open('runtime/party-spawn.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^party%-dismiss:') then
    local serial = tonumber(request:match('^party%-dismiss:(%d+)'))
    local ok, result = pcall(function()
        return convaiCompanions and convaiCompanions.dismiss(serial)
    end)
    local file = io.open('runtime/party-dismiss.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^party%-list:') then
    local ok, result = pcall(function()
        return json.encode(convaiCompanions and convaiCompanions.list() or {})
    end)
    local file = io.open('runtime/party-list.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^viktor%-record%-search:') then
    local ok, result = pcall(function()
        local records = TweakDB:GetRecords('gamedataCharacter_Record')
        local matches = {}
        for _, record in ipairs(records or {}) do
            local id = tostring(record:GetID())
            if id:lower():find('viktor', 1, true) or id:lower():find('victor', 1, true)
                or id:lower():find('ripperdoc', 1, true) then
                matches[#matches + 1] = id
            end
        end
        return 'total=' .. tostring(#(records or {})) .. ' matches=' .. table.concat(matches, ', ')
    end)
    local file = io.open('runtime/viktor-record-search.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^follower%-preflight:') then
    local ok, result = pcall(function()
        local role = NewObject('AIFollowerRole')
        role.followerRef = Game.CreateEntityReference('#player', {})
        return 'role=' .. tostring(role ~= nil) .. ' ref=' .. tostring(role.followerRef)
    end)
    local file = io.open('runtime/follower-preflight.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^orientation%-preflight:') then
    local ok, result = pcall(function()
        local player = Game.GetPlayer()
        local angle = EulerAngles.new(0.0, 0.0, player:GetWorldYaw() + 180.0)
        local quat = EulerAngles.ToQuat(angle)
        return 'yaw=' .. tostring(player:GetWorldYaw()) .. ' quat=' .. tostring(quat)
    end)
    local file = io.open('runtime/orientation-preflight.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^owned%-spawn%-preflight:') then
    local ok, result = pcall(function()
        local system = Game.GetDynamicEntitySystem()
        local spec = NewObject('DynamicEntitySpec')
        local record = TweakDB:GetRecord('Character.Judy')
        return 'system=' .. tostring(system ~= nil)
            .. ' ready=' .. tostring(system and system:IsReady())
            .. ' spec=' .. tostring(spec ~= nil)
            .. ' record=' .. tostring(record ~= nil)
    end)
    local file = io.open('runtime/owned-spawn-preflight.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^owned%-spawn%-test:') then
    local ok, result = pcall(function()
        local defs = Game.GetAllBlackboardDefs()
        if Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) then return 'Menu open' end
        local player = Game.GetPlayer()
        local system = Game.GetDynamicEntitySystem()
        if not player or not system or not system:IsReady() then return 'Player or dynamic entity system unavailable' end
        if convaiOwnedSpawnProbe then return 'Previous owned spawn probe still active' end
        local spec = NewObject('DynamicEntitySpec')
        spec.recordID = TweakDBID.new('Character.Judy')
        local position, forward = player:GetWorldPosition(), player:GetWorldForward()
        position.x = position.x + forward.x * 0.5 - forward.y * 1.5
        position.y = position.y + forward.y * 0.5 + forward.x * 1.5
        spec.position = position
        spec.orientation = EulerAngles.ToQuat(EulerAngles.new(0.0, 0.0, player:GetWorldYaw() - 90.0))
        spec.spawnInView = true
        spec.active = true
        local id = system:CreateEntity(spec)
        convaiOwnedSpawnProbe = {id = id, system = system, createdAt = os.time(), position = position}
        return 'requested Judy clone id=' .. tostring(id.hash)
    end)
    local file = io.open('runtime/owned-spawn-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^owned%-spawn%-status:') then
    local ok, result = pcall(function()
        local probe = convaiOwnedSpawnProbe
        if not probe then return 'No owned spawn probe' end
        local spawned = probe.system:IsSpawned(probe.id)
        local entity = probe.system:GetEntity(probe.id)
        local role = entity and entity:GetAIControllerComponent():GetAIRole()
        local player = Game.GetPlayer()
        local moved, distance, commandState, sideDistance = 'n/a', 'n/a', 'n/a', 'n/a'
        if entity then
            local at = entity:GetWorldPosition()
            local start = probe.position
            if start then moved = math.sqrt((at.x - start.x)^2 + (at.y - start.y)^2 + (at.z - start.z)^2) end
            if player then
                local origin = player:GetWorldPosition()
                distance = math.sqrt((at.x - origin.x)^2 + (at.y - origin.y)^2 + (at.z - origin.z)^2)
            end
            if probe.command then commandState = entity:GetAIControllerComponent():GetCommandState(probe.command) end
            if probe.sideTarget then
                local side = probe.sideTarget
                sideDistance = math.sqrt((at.x - side.x)^2 + (at.y - side.y)^2 + (at.z - side.z)^2)
            end
        end
        return 'spawned=' .. tostring(spawned)
            .. ' entity=' .. tostring(entity)
            .. ' crowd=' .. tostring(entity and entity:IsCrowd())
            .. ' role=' .. tostring(role)
            .. ' companion=' .. tostring(entity and entity:IsPlayerCompanion())
            .. ' metres_moved=' .. tostring(moved)
            .. ' distance_to_v=' .. tostring(distance)
            .. ' command=' .. tostring(commandState)
            .. ' side_distance=' .. tostring(sideDistance)
            .. ' elapsed=' .. tostring(os.time() - probe.createdAt)
    end)
    local file = io.open('runtime/owned-spawn-status.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^owned%-follow%-test:') then
    local ok, result = pcall(function()
        local probe = convaiOwnedSpawnProbe
        local npc = probe and probe.system:GetEntity(probe.id)
        local player = Game.GetPlayer()
        if not npc or not player or npc:IsCrowd() then return 'No managed non-crowd NPC to follow' end
        local ai = npc:GetAIControllerComponent()
        local previous = ai:GetAIRole()
        if previous and not previous:IsA('AINoRole') then return 'Skipping clone with authored AI role: ' .. tostring(previous) end
        local follower = NewObject('AIFollowerRole')
        follower.followerRef = Game.CreateEntityReference('#player', {})
        ai:SetAIRole(follower)
        ai:OnAttach()
        npc.isPlayerCompanionCachedTimeStamp = 0
        probe.follower = follower
        local command = NewObject('AIFollowTargetCommand')
        command.target = player
        command.lookAtTarget = player
        command.desiredDistance = 1.0
        command.tolerance = 0.25
        command.movementType = Enum.new('moveMovementType', 'Walk')
        command.matchSpeed = true
        command.teleport = false
        command.stopWhenDestinationReached = false
        ai:SendCommand(command)
        probe.command = command
        return 'follower role applied to owned clone; command=' .. tostring(command)
    end)
    local file = io.open('runtime/owned-follow-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^owned%-side%-test:') then
    local ok, result = pcall(function()
        local probe = convaiOwnedSpawnProbe
        local npc = probe and probe.system:GetEntity(probe.id)
        local player = Game.GetPlayer()
        if not npc or not player or not probe.follower then return 'No owned follower' end
        local ai = npc:GetAIControllerComponent()
        if probe.command then ai:CancelCommand(probe.command) end
        local position, forward = player:GetWorldPosition(), player:GetWorldForward()
        position.x = position.x + forward.x * 1.0 - forward.y * 1.4
        position.y = position.y + forward.y * 1.0 + forward.x * 1.4
        local world = WorldPosition.new()
        world:SetVector4(position)
        local spec = AIPositionSpec.new()
        spec:SetWorldPosition(world)
        local command = NewObject('AIMoveToCommand')
        command.movementTarget = spec
        command.movementType = Enum.new('moveMovementType', 'Walk')
        command.desiredDistanceFromTarget = 0.3
        command.finishWhenDestinationReached = true
        command.ignoreNavigation = false
        command.useStart = true
        command.useStop = true
        ai:SendCommand(command)
        probe.command = command
        probe.sideTarget = position
        return 'side move sent; target=' .. tostring(position)
    end)
    local file = io.open('runtime/owned-side-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^owned%-spawn%-cleanup:') then
    local ok, result = pcall(function()
        local probe = convaiOwnedSpawnProbe
        if not probe then return 'No owned spawn probe' end
        local npc = probe.system:GetEntity(probe.id)
        if npc and probe.follower then
            local ai = npc:GetAIControllerComponent()
            if probe.command then ai:CancelCommand(probe.command) end
            probe.follower:OnRoleCleared(npc)
            ai:SetAIRole(NewObject('AINoRole'))
            ai:OnAttach()
        end
        local deleted = probe.system:DeleteEntity(probe.id)
        convaiOwnedSpawnProbe = nil
        return 'deleted=' .. tostring(deleted)
    end)
    local file = io.open('runtime/owned-spawn-cleanup.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^companion%-records:') then
    local names = {
        'Character.Judy', 'Character.judy', 'Character.Panam',
        'Character.panam', 'Character.Misty', 'Character.misty',
        'Character.Viktor', 'Character.viktor',
    }
    local lines = {}
    for _, name in ipairs(names) do
        local ok, record = pcall(function() return TweakDB:GetRecord(name) end)
        lines[#lines + 1] = name .. ' ok=' .. tostring(ok) .. ' exists=' .. tostring(record ~= nil)
    end
    local file = io.open('runtime/companion-records.txt', 'wb')
    if file then file:write(table.concat(lines, '\n'), '\n'); file:close() end
    return
end
if request:match('^attention%-test:') then
    local ok, result = pcall(function()
        local defs = Game.GetAllBlackboardDefs()
        if Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) then return 'Menu open' end
        local player = Game.GetPlayer()
        if not player then return 'No player' end
        local query = TargetSearchQuery.new()
        query.searchFilter = Game['TSF_NPC;']()
        query.maxDistance = 8.0
        local npc = Game.GetTargetingSystem():GetObjectClosestToCrosshair(player, query)
        if not npc or not npc:IsAttached() or npc:IsDeadNoStatPool() or not npc:IsCrowd() then
            return 'No living crowd NPC within eight metres of crosshair'
        end
        local body = tostring(npc:GetBodyType() or ''):lower()
        if body:find('child', 1, true) or body:find('kid', 1, true) then return 'Skipped child NPC' end
        local workspot = Game.GetWorkspotSystem():IsActorInWorkspot(npc)
        if workspot then return 'Skipped NPC in workspot' end
        local broadcaster = player:GetStimBroadcasterComponent()
        if not broadcaster then return 'Player stimulus broadcaster unavailable' end
        pcall(function() player:ConvaiEndFocus() end)
        convaiAttentionProbe = {npc = npc, position = npc:GetWorldPosition(), startedAt = os.time(), expires = os.time() + 8}
        local sent, sendError = pcall(function()
            broadcaster:SendDrirectStimuliToTarget(player, Enum.new('gamedataStimType', 'Attention'), npc)
        end)
        if not sent then convaiAttentionProbe = nil; return 'Attention send failed: ' .. tostring(sendError) end
        return 'actor=' .. tostring(npc:GetEntityID().hash)
            .. ' name=' .. tostring(npc:GetTweakDBFullDisplayName(true))
            .. ' body=' .. body
            .. ' moving_before=' .. tostring(npc:GetCrowdMemberComponent():CheckIsMoving())
            .. ' attention_sent=true'
    end)
    local file = io.open('runtime/attention-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^attention%-status:') then
    local ok, result = pcall(function()
        local probe = convaiAttentionProbe
        if not probe then return 'No live attention probe' end
        local npc = probe.npc
        if not npc or not npc:IsAttached() then return 'NPC streamed out' end
        local pos, start = npc:GetWorldPosition(), probe.position
        local moved = math.sqrt((pos.x - start.x)^2 + (pos.y - start.y)^2 + (pos.z - start.z)^2)
        return 'actor=' .. tostring(npc:GetEntityID().hash)
            .. ' elapsed_seconds=' .. tostring(os.time() - probe.startedAt)
            .. ' metres_moved=' .. tostring(moved)
            .. ' moving=' .. tostring(npc:GetCrowdMemberComponent():CheckIsMoving())
    end)
    local file = io.open('runtime/attention-status.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^role%-callability:') then
    local ok, result = pcall(function()
        local player = Game.GetPlayer()
        if not player then return 'No player' end
        local query = TargetSearchQuery.new()
        query.searchFilter = Game['TSF_NPC;']()
        query.maxDistance = 20.0
        local npc = Game.GetTargetingSystem():GetObjectClosestToCrosshair(player, query)
        if not npc then return 'No NPC near crosshair' end
        local ai = npc:GetAIControllerComponent()
        local role = ai and ai:GetCurrentRole()
        local created = NewObject('AIFollowerRole')
        return 'actor=' .. tostring(npc:GetEntityID().hash)
            .. ' crowd=' .. tostring(npc:IsCrowd())
            .. ' moving=' .. tostring(npc:GetCrowdMemberComponent():CheckIsMoving())
            .. ' role=' .. tostring(role)
            .. ' role_enum=' .. (role and tostring(role:GetRoleEnum()) or 'none')
            .. ' companion=' .. tostring(npc:IsPlayerCompanion())
            .. ' new_follower_role=' .. tostring(created)
    end)
    local file = io.open('runtime/role-callability.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^hold%-test:') then
    local player = Game.GetPlayer()
    local query = TargetSearchQuery.new()
    query.searchFilter = Game['TSF_NPC;']()
    query.maxDistance = 8.0
    local npc = player and Game.GetTargetingSystem():GetObjectClosestToCrosshair(player, query)
    local ok, result = pcall(function()
        if not npc or not npc:IsCrowd() then return 'No crowd target' end
        local hold = NewObject('AIHoldPositionCommand')
        hold.duration = 12.0
        AIComponent.SendCommand(npc, hold)
        convaiProbeHold = hold
        convaiProbeNpc = npc
        convaiProbePosition = npc:GetWorldPosition()
        return 'Sent 12-second hold to ' .. tostring(npc:GetEntityID().hash)
    end)
    local file = io.open('runtime/hold-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^hold%-status:') then
    local npc, hold = convaiProbeNpc, convaiProbeHold
    local ok, result = pcall(function()
        if not npc or not hold then return 'No live hold probe' end
        local ai = npc:GetAIControllerComponent()
        local state = ai:GetCommandState(hold)
        local position = npc:GetWorldPosition()
        local start = convaiProbePosition
        local moved = math.sqrt((position.x - start.x)^2 + (position.y - start.y)^2 + (position.z - start.z)^2)
        return 'actor=' .. tostring(npc:GetEntityID().hash) .. ' state=' .. tostring(state) .. ' metres_moved=' .. tostring(moved)
    end)
    local file = io.open('runtime/hold-status.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^traffic%-test:') then
    local ok, result = pcall(function()
        local defs = Game.GetAllBlackboardDefs()
        if Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) then return 'Menu open' end
        local player = Game.GetPlayer()
        local query = TargetSearchQuery.new()
        query.searchFilter = Game['TSF_NPC;']()
        query.maxDistance = 8.0
        local npc = player and Game.GetTargetingSystem():GetObjectClosestToCrosshair(player, query)
        if not npc or not npc:IsCrowd() then return 'No crowd NPC at crosshair' end
        local crowd = npc:GetCrowdMemberComponent()
        if not crowd then return 'Crowd component unavailable' end
        local before = crowd:CheckIsMoving()
        return 'actor=' .. tostring(npc:GetEntityID().hash) .. ' moving=' .. tostring(before)
    end)
    local file = io.open('runtime/traffic-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^traffic%-resume%-test:') then
    local ok, result = pcall(function()
        local player = Game.GetPlayer()
        local query = TargetSearchQuery.new()
        query.searchFilter = Game['TSF_NPC;']()
        query.maxDistance = 8.0
        local npc = player and Game.GetTargetingSystem():GetObjectClosestToCrosshair(player, query)
        if not npc or not npc:IsCrowd() then return 'No crowd NPC at crosshair' end
        local crowd = npc:GetCrowdMemberComponent()
        if not crowd then return 'Crowd component unavailable' end
        local before = crowd:CheckIsMoving()
        local blocked = crowd:IsBlockedInTraffic()
        convaiResumeNpc = npc
        convaiResumePosition = npc:GetWorldPosition()
        crowd:TryChangeMovementDirection()
        return 'actor=' .. tostring(npc:GetEntityID().hash) .. ' moving_before=' .. tostring(before)
            .. ' blocked=' .. tostring(blocked) .. ' moving_after=' .. tostring(crowd:CheckIsMoving())
    end)
    local file = io.open('runtime/traffic-resume-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^traffic%-resume%-status:') then
    local ok, result = pcall(function()
        local npc = convaiResumeNpc
        if not npc or not npc:IsAttached() then return 'No attached NPC from resume probe' end
        local current = npc:GetWorldPosition()
        local start = convaiResumePosition
        local moved = math.sqrt((current.x - start.x)^2 + (current.y - start.y)^2 + (current.z - start.z)^2)
        return 'actor=' .. tostring(npc:GetEntityID().hash) .. ' metres_moved=' .. tostring(moved)
            .. ' moving=' .. tostring(npc:GetCrowdMemberComponent():CheckIsMoving())
    end)
    local file = io.open('runtime/traffic-resume-status.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^traffic%-join%-test:') then
    local ok, result = pcall(function()
        local npc = convaiResumeNpc
        if not npc or not npc:IsAttached() then return 'No attached NPC from resume probe' end
        local command = NewObject('AIJoinCrowdCommand')
        AIComponent.SendCommand(npc, command)
        convaiJoinCommand = command
        convaiResumePosition = npc:GetWorldPosition()
        return 'actor=' .. tostring(npc:GetEntityID().hash) .. ' join command sent'
    end)
    local file = io.open('runtime/traffic-join-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^traffic%-join%-status:') then
    local ok, result = pcall(function()
        local npc = convaiResumeNpc
        if not npc or not npc:IsAttached() then return 'No attached NPC from resume probe' end
        local current = npc:GetWorldPosition()
        local start = convaiResumePosition
        local moved = math.sqrt((current.x - start.x)^2 + (current.y - start.y)^2 + (current.z - start.z)^2)
        local state = npc:GetAIControllerComponent():GetCommandState(convaiJoinCommand)
        return 'actor=' .. tostring(npc:GetEntityID().hash) .. ' join_state=' .. tostring(state)
            .. ' metres_moved=' .. tostring(moved)
    end)
    local file = io.open('runtime/traffic-join-status.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^time%-callability:') then
    local ok, result = pcall(function()
        local npc = convaiResumeNpc
        if not npc or not npc:IsAttached() then return 'No attached NPC from resume probe' end
        npc:SetIndividualTimeDilation(CName.new('ConvaiProbe'), 0.5, 3.0, CName.new(''), CName.new(''), false, true)
        return 'actor=' .. tostring(npc:GetEntityID().hash)
            .. ' has_probe=' .. tostring(npc:HasIndividualTimeDilation(CName.new('ConvaiProbe')))
            .. ' dilation=' .. tostring(npc:GetTimeDilationValue())
    end)
    local file = io.open('runtime/time-callability.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^teleport%-callability:') then
    local ok, result = pcall(function()
        local npc = convaiResumeNpc
        if not npc or not npc:IsAttached() then return 'No attached NPC from resume probe' end
        local position = npc:GetWorldPosition()
        local rotation = EulerAngles.new(0.0, 0.0, npc:GetWorldYaw())
        Game.GetTeleportationFacility():Teleport(npc, position, rotation)
        return 'actor=' .. tostring(npc:GetEntityID().hash) .. ' yaw=' .. tostring(npc:GetWorldYaw())
    end)
    local file = io.open('runtime/teleport-callability.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^movement%-params:') then
    local ok, result = pcall(function()
        local player = Game.GetPlayer()
        local query = TargetSearchQuery.new()
        query.searchFilter = Game['TSF_NPC;']()
        query.maxDistance = 8.0
        local npc = player and Game.GetTargetingSystem():GetObjectClosestToCrosshair(player, query)
        if not npc then return 'No NPC at crosshair' end
        local ai = npc:GetAIControllerComponent()
        local walk = ai:GetMovementParams(Enum.new('moveMovementType', 'Walk'))
        local run = ai:GetMovementParams(Enum.new('moveMovementType', 'Run'))
        return 'actor=' .. tostring(npc:GetEntityID().hash)
            .. ' walk_speed=' .. tostring(walk.maxSpeed) .. ' walk_accel=' .. tostring(walk.acceleration)
            .. ' run_speed=' .. tostring(run.maxSpeed) .. ' run_accel=' .. tostring(run.acceleration)
    end)
    local file = io.open('runtime/movement-params.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^parts%-test:') then
    local ok, result = pcall(function()
        local player = Game.GetPlayer()
        local query = TargetSearchQuery.new()
        query.searchFilter = Game['TSF_NPC;']()
        query.maxDistance = 8.0
        query.includeSecondaryTargets = true
        local targeting = Game.GetTargetingSystem()
        local found, parts = targeting:GetTargetParts(player, query)
        local position, direction = targeting:GetCrosshairData(player)
        local rows = {'found=' .. tostring(found) .. ' count=' .. tostring(parts and #parts or 0)
            .. ' crosshair_types=' .. type(position) .. ',' .. type(direction)
            .. ' direction=' .. tostring(direction and direction.x) .. ',' .. tostring(direction and direction.y)
            .. ',' .. tostring(direction and direction.z)}
        for i = 1, math.min(parts and #parts or 0, 6) do
            local component = TS_TargetPartInfo.GetComponent(parts[i])
            local entity = component and component:GetEntity()
            rows[#rows + 1] = 'actor=' .. tostring(entity and entity:GetEntityID().hash)
                .. ' name=' .. tostring(entity and entity:GetTweakDBFullDisplayName(true))
        end
        return table.concat(rows, '; ')
    end)
    local file = io.open('runtime/parts-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^policy%-callability:') then
    local ok, result = pcall(function()
        local npc = convaiResumeNpc
        if not npc or not npc:IsAttached() then return 'No attached NPC from resume probe' end
        local component = npc:GetMovePolicesComponent()
        if not component then return 'No move policies component' end
        local policy = NewObject('MovePolicies')
        policy:SetDestinationPosition(npc:GetWorldPosition())
        policy:SetDistancePolicy(0.0, 0.1)
        component:AddPolicies(policy)
        local top = component:GetTopPolicies()
        component:PopPolicies(policy)
        return 'actor=' .. tostring(npc:GetEntityID().hash) .. ' top_is_test=' .. tostring(top == policy)
    end)
    local file = io.open('runtime/policy-callability.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^character%-records:') then
    local lines = {}
    for _, id in ipairs({'Character.Judy', 'Character.Panam', 'Character.Viktor', 'Character.Misty'}) do
        local ok, record = pcall(function() return TweakDB:GetRecord(id) end)
        lines[#lines + 1] = id .. ' exists=' .. tostring(ok and record ~= nil)
    end
    local file = io.open('runtime/character-records.txt', 'wb')
    if file then file:write(table.concat(lines, '\n'), '\n'); file:close() end
    return
end
if request:match('^contacts:') then
    local lines = {}
    local ok, err = pcall(function()
        local contacts = Game.GetJournalManager():GetContactDataArray(false, false)
        lines[#lines + 1] = 'count=' .. tostring(#contacts)
        for index, contact in ipairs(contacts) do
            local name = tostring(contact.localizedName or '')
            local okLocalized, localized = pcall(function() return GetLocalizedText(contact.localizedName) end)
            local display = okLocalized and tostring(localized) or name
            if index <= 10 then
                lines[#lines + 1] = 'sample id=' .. tostring(contact.id) .. ' name=' .. name .. ' display=' .. display
            end
            if display:lower():find('judy', 1, true) or display:lower():find('panam', 1, true)
                or display:lower():find('misty', 1, true) or display:lower():find('viktor', 1, true)
                or display:lower():find('vektor', 1, true) then
                lines[#lines + 1] = 'id=' .. tostring(contact.id) .. ' name=' .. display .. ' callable=' .. tostring(contact.isCallable)
            end
        end
    end)
    if not ok then lines[#lines + 1] = 'error=' .. tostring(err) end
    local file = io.open('runtime/phone-contacts.txt', 'wb')
    if file then file:write(table.concat(lines, '\n'), '\n'); file:close() end
    return
end
if request:match('^manager%-close:') then
    local player = Game.GetPlayer()
    local ok, result = pcall(function() return player and player:ConvaiCloseManager() end)
    local resultFile = io.open('runtime/manager-status.txt', 'wb')
    if resultFile then
        resultFile:write('request=', request, '\nclose_ok=', tostring(ok), '\nclosed=', tostring(result), '\n')
        resultFile:close()
    end
    return
end
if request:match('^manager:') then
    local player = Game.GetPlayer()
    local opened = player and player:ConvaiOpenManager()
    local resultFile = io.open('runtime/manager-status.txt', 'wb')
    if resultFile then
        resultFile:write('request=', request, '\nplayer=', tostring(player ~= nil), '\nopened=', tostring(opened), '\n')
        resultFile:close()
    end
    print('[CyberpunkConvai] Companion manager request: ' .. tostring(opened))
    return
end

local out = { 'Cyberpunk Convai NPC diagnostic v1', os.date('!UTC %Y-%m-%dT%H:%M:%SZ') }
local function add(key, value)
    local s = tostring(value == nil and '<none>' or value):gsub('[\r\n]', ' ')
    out[#out + 1] = key .. ': ' .. s:sub(1, 240)
end
local function get(label, fn)
    local ok, value = pcall(fn)
    if ok then add(label, value); return value end
    add(label, '<unavailable: ' .. tostring(value):sub(1, 120) .. '>')
    return nil
end

local player = get('player', function() return Game.GetPlayer() end)
if player then
    local query = TargetSearchQuery.new()
    query.searchFilter = Game['TSF_NPC;']()
    query.maxDistance = 50.0
    local npc = get('crosshair target', function()
        return Game.GetTargetingSystem():GetObjectClosestToCrosshair(player, query)
    end)
    if npc then
        get('display name', function() return npc:GetTweakDBFullDisplayName(true) end)
        get('entity ID hash', function() return npc:GetEntityID().hash end)
        get('record ID', function() return npc:GetRecordID() end)
        get('body type', function() return npc:GetBodyType() end)
        get('gender', function() return npc:GetGender() end)
        get('appearance', function() return npc:GetCurrentAppearanceName() end)
        get('is NPC', function() return npc:IsNPC() end)
        get('is attached', function() return npc:IsAttached() end)
        get('is dead', function() return npc:IsDeadNoStatPool() end)
        get('is civilian', function() return npc:IsCharacterCivilian() end)
        get('is crowd', function() return npc:IsCrowd() end)
        get('is in workspot', function() return Game.GetWorkspotSystem():IsActorInWorkspot(npc) end)
        get('AI controller', function() return npc:GetAIControllerComponent() end)
        get('hold constructor', function() return NewObject('AIHoldPositionCommand') end)

        local components = get('component array', function() return npc:GetComponents() end)
        if components then
            local okCount, count = pcall(function() return #components end)
            add('component count', okCount and count or '<unavailable>')
            for i = 1, okCount and math.min(count, 100) or 0 do
                local okComponent, component = pcall(function() return components[i] end)
                if okComponent and component then
                local okName, name = pcall(function() return component:GetName() end)
                local okClass, class = pcall(function() return component:GetClassName() end)
                add('component ' .. i, (okName and tostring(name) or '?') .. ' / ' .. (okClass and tostring(class) or '?'))
                end
            end
        end
        for _, name in ipairs({'face', 'facial', 'facialRig', 'facialAnimation', 'animationController', 'characterEntityAnimationSetup'}) do
            local component = get('component lookup ' .. name, function() return npc:FindComponentByName(name) end)
            if component then
                get(name .. ' class', function() return component:GetClassName() end)
            end
        end
    end
end

local path = 'runtime/npc-diagnostic-' .. os.date('!%Y%m%d-%H%M%S') .. '.txt'
local file, err = io.open(path, 'wb')
if not file then
    print('[CyberpunkConvai] Diagnostic save failed: ' .. tostring(err))
else
    file:write(table.concat(out, '\n'), '\n')
    file:close()
    print('[CyberpunkConvai] NPC diagnostic saved: ' .. path)
end
