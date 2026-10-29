local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end
-- The game side of the action primitives of the bond quests (mod/quest-prims-action.lua: squad, hostage, escortee). The native calls only, each one guarded by its
-- caller, none of them run per frame. They are asked at a checkpoint (a spawn) or once a second per member at most (a state read, an arm). Nothing here touches a
-- character the game placed: every call takes a handle this module made itself (an entity ID kept in `mine`) and the ones it is given are checked against that set.
--
-- Entity handles are never kept: a handle is {kind = 'extra', id = entityID} (plain data, the form mod/quest-world.lua castDelete reads too) and the entity is looked up
-- again from the id in each call and counted only when the game has attached it.
--
-- UNVERIFIED in the game (offline-tested on a fake game only, the first live run must look at each): the spawn spec's appearanceName, the health pool read and write
-- (StatPoolsSystem), god mode on a spawned extra, the reaction preset change on a spawned fighter, the shared threat (TargetTrackerComponent:AddThreat), the follower
-- role and the follow command on an ordinary extra, the health multiplier, the Fear and Relaxed high-level states for a bolt, and the AI teleport for the leash.
-- Every one of them is called under pcall, and a refusal comes back as false and a note, never as an error.
local M = {TAG = 'CyberpunkConvaiQuest', PROTECTION = 'CyberpunkConvaiQuestProtection', DOWN_PERCENT = 10, FULL_PERCENT = 100, LEASH_BEHIND = 2.5, LEASH_SIDE = 1.0}

local function finite(value) return type(value) == 'number' and value == value and math.abs(value) < 1e7 end
local function plain(p) return {x = p.x, y = p.y, z = p.z} end
local function nullHash(id) return not id or tostring(id.hash):match('^0+[uUlL]*$') ~= nil end
local function keyOf(id) return tostring(id.hash) end
local function idOf(handle)
    if type(handle) == 'table' and handle.kind == 'extra' then return handle.id end
    return nil
end

-- deps: groups (affiliation name -> gang base, revenge-ambush.lua GROUPS), hidden(x, y, z) -> true | false | nil (optional, the invitation code's out-of-sight test),
-- log(line).
function M.new(deps)
    deps = deps or {}
    local W = {}
    local mine = {}            -- entity id key -> true: the spawns of this module (nothing else is ever acted on)
    local protected = {}       -- entity id key -> true while this module holds god mode on it
    local commands = {}        -- entity id key -> the follow command last sent (to cancel it)
    local roles = {}           -- entity id key -> 'role' | 'command'

    local function log(line) if type(deps.log) == 'function' then pcall(deps.log, 'Quest action world: ' .. line) end end
    local function player() return convaiPlayer() end
    local function attitude(name) return Enum.new('EAIAttitude', name) end

    -- The entity once the game has attached it, else nil (it is not in the world yet, or it is not ours).
    local function entity(handle)
        local id = idOf(handle)
        if id == nil or not mine[keyOf(id)] then return nil end
        local ok, npc = pcall(function()
            local system = Game.GetDynamicEntitySystem()
            if not system or not system:IsReady() or not system:IsManaged(id) then return nil end
            local found = system:GetEntity(id)
            if found and found:IsAttached() and found:IsA('NPCPuppet') then return found end
            return nil
        end)
        return ok and npc or nil
    end

    -- ---- spawn and read ------------------------------------------------------------------------------------------------------------------
    -- request: {id, record, x, y, z, facing, tag, appearance}. Returns an opaque handle, or nil and why. The spawn is tagged with the shared tag and the quest's own.
    function W.actorSpawn(request)
        if type(request) ~= 'table' or not finite(request.x) or not finite(request.y) or not finite(request.z) then return nil, 'bad place' end
        if type(request.record) ~= 'string' or not request.record:match('^Character%.[%w_]+$') then return nil, 'bad record' end
        local system = Game.GetDynamicEntitySystem()
        if not system or not system:IsReady() then return nil, 'World is not ready' end
        local known = pcall(function()
            local found = TweakDB:GetRecord(TweakDBID.new(request.record))
            if not found or not found:IsA('gamedataCharacter_Record') then error('not a character record') end
        end)
        if not known then return nil, 'unknown record ' .. request.record end
        local facing = type(request.facing) == 'table' and request.facing or {x = 1, y = 0}
        local spec = NewObject('DynamicEntitySpec')
        spec.recordID = TweakDBID.new(request.record)
        spec.position = Vector4.new(request.x, request.y, request.z, 1)
        local okFace, orientation = pcall(function() return Quaternion.BuildFromDirectionVector(Vector4.new(facing.x or 0, facing.y or 0, 0, 0)) end)
        if okFace and orientation then spec.orientation = orientation end
        if type(request.appearance) == 'string' and request.appearance ~= '' then
            pcall(function() spec.appearanceName = CName.new(request.appearance) end)   -- unverified
        end
        spec.spawnInView = true
        spec.active = true
        spec.alwaysSpawned = false
        spec.persistState, spec.persistSpawn = false, false
        local tags = {CName.new(M.TAG)}
        if type(request.tag) == 'string' and request.tag ~= '' then tags[2] = CName.new(request.tag) end
        spec.tags = tags
        local created, id = pcall(function() return system:CreateEntity(spec) end)
        if not created or nullHash(id) then return nil, 'The game could not create the character.' end
        mine[keyOf(id)] = true
        return {kind = 'extra', id = id}
    end
    W.squadSpawn = W.actorSpawn

    -- One read of one member: nil while the game has not attached it (or it is gone), else plain data. health is the pool in percent (nil when unreadable).
    function W.actorState(handle)
        local npc = entity(handle)
        if npc == nil then return nil end
        local out = {}
        local okDead, dead = pcall(function() return npc:IsDeadNoStatPool() == true end)
        out.dead = okDead and dead or false
        local okDefeated, defeated = pcall(function() return ScriptedPuppet.IsDefeated(npc) == true end)
        out.defeated = okDefeated and defeated or false
        local okHealth, health = pcall(function()
            return Game.GetStatPoolsSystem():GetStatPoolValue(npc:GetEntityID(), Enum.new('gamedataStatPoolType', 'Health'), true)   -- unverified
        end)
        out.health = okHealth and finite(health) and health or nil
        local okCombat, combat = pcall(function() return NPCPuppet.IsInCombat(npc) == true end)
        out.combat = okCombat and combat or false
        local okMount, mounted = pcall(function() return Game.GetMountingFacility():IsMountedToAnything(npc:GetEntityID()) == true end)
        out.mounted = okMount and mounted or false
        local okAt, at = pcall(function() return plain(npc:GetWorldPosition()) end)
        if okAt and finite(at.x) then out.x, out.y, out.z = at.x, at.y, at.z end
        return out
    end

    -- What a fresh copy needs to look the same: {record, appearance}. Read once, when the character is configured.
    function W.actorInfo(handle)
        local npc = entity(handle)
        if npc == nil then return nil end
        local ok, info = pcall(function()
            local text = TDBID.ToStringDEBUG(npc:GetRecordID())
            local record = type(text) == 'string' and text:match('Character%.[%w_]+') or nil
            local appearance = nil
            pcall(function() appearance = Game.NameToString(npc:GetCurrentAppearanceName()) end)   -- unverified
            return {record = record, appearance = appearance}
        end)
        return ok and info or nil
    end

    function W.actorDelete(handle)
        local id = idOf(handle)
        if id == nil or not mine[keyOf(id)] then return end
        local key = keyOf(id)
        if protected[key] then pcall(W.hostageProtect, handle, false) end
        pcall(function()
            local system = Game.GetDynamicEntitySystem()
            if system and system:IsReady() and system:IsManaged(id) and system:IsTagged(id, CName.new(M.TAG)) then system:DeleteEntity(id) end
        end)
        mine[key], protected[key], commands[key], roles[key] = nil, nil, nil, nil
    end
    W.squadDelete = W.actorDelete

    -- A fresh copy at the same spot with the same appearance (the old one is deleted by the caller once this one is attached). nil and why on a refusal.
    function W.actorReplace(handle, request)
        local info = W.actorInfo(handle)
        if type(info) ~= 'table' or not info.record then return nil, 'the old one cannot be read' end
        local copy = {}
        for k, v in pairs(type(request) == 'table' and request or {}) do copy[k] = v end
        copy.record, copy.appearance = info.record, info.appearance
        return W.actorSpawn(copy)
    end

    -- ---- sight -----------------------------------------------------------------------------------------------------------------------------
    -- Out of V's sight now? true / false, or nil when it cannot be told. The invitation code's test when it is given, else the view cone and one ray.
    function W.hiddenFromPlayer(x, y, z)
        if not finite(x) or not finite(y) or not finite(z) then return nil end
        if type(deps.hidden) == 'function' then
            local ok, value = pcall(deps.hidden, {x = x, y = y, z = z})
            if ok and type(value) == 'boolean' then return value end
        end
        local ok, value = pcall(function()
            local p = player()
            if not p then return nil end
            local at, forward = p:GetWorldPosition(), p:GetWorldForward()
            local dx, dy = x - at.x, y - at.y
            local length = math.sqrt(dx * dx + dy * dy)
            if length < 0.5 then return false end
            local fl = math.sqrt(forward.x * forward.x + forward.y * forward.y)
            if fl > 0 and (dx * forward.x + dy * forward.y) / (length * fl) < 0.34 then return true end   -- more than about 70 degrees off the view
            local spatial = Game.GetSpatialQueriesSystem()
            if not spatial then return nil end
            local hit = spatial:SyncRaycastByCollisionGroup(Vector4.new(at.x, at.y, at.z + 1.6, 1), Vector4.new(x, y, z + 1.2, 1), CName.new('Static'), false, false)
            return hit == true
        end)
        if ok and type(value) == 'boolean' then return value end
        return nil
    end

    -- ---- hostile ---------------------------------------------------------------------------------------------------------------------------
    local PRESETS = {'Ganger_Aggressive', 'Mercenary_Aggressive', 'Corpo_Aggressive'}
    local function aggressivePreset()
        for _, name in ipairs(PRESETS) do
            local record = TweakDBInterface.GetReactionPresetRecord(TweakDBID.new('ReactionPresets.' .. name))
            if record and record:IsAggressive() == true then return record end
        end
        return nil
    end

    -- A record the squad may use: the game has it, it is a human character, not a crowd person, and its affiliation is this gang's.
    function W.squadVerify(record, group)
        if type(record) ~= 'string' or type(deps.groups) ~= 'table' then return false end
        local ok, good = pcall(function()
            local found = TweakDB:GetRecord(TweakDBID.new(record))
            if not found or not found:IsA('gamedataCharacter_Record') then return false end
            if found:IsCrowd() == true then return false end
            local name = found:Affiliation():EnumName()
            local text = type(name) == 'string' and name or (name and name.value) or tostring(name)
            return deps.groups[text] == group
        end)
        return ok and good == true
    end

    -- The hostile recipe, in this order: the attitude both ways (read back), a live AI role, an aggressive reaction preset, then the trigger into combat (and the forced
    -- combat state), then the shared threat for a squad that reacts as one. Asked again about once a second while the squad is hostile, so every step is safe to repeat.
    -- Returns true when the attitude reads back hostile and one fight ask was accepted, and a note on what was refused.
    function W.squadArm(handle, options)
        local npc = entity(handle)
        local p = player()
        if npc == nil or not p then return false, 'not attached' end
        local notes = {}
        local function note(text) notes[#notes + 1] = text end
        local hostile = pcall(function()
            npc:GetAttitudeAgent():SetAttitudeTowards(p:GetAttitudeAgent(), attitude('AIA_Hostile'))
            p:GetAttitudeAgent():SetAttitudeTowards(npc:GetAttitudeAgent(), attitude('AIA_Hostile'))
            if tostring(npc:GetAttitudeAgent():GetAttitudeTowards(p:GetAttitudeAgent())):find('AIA_Hostile', 1, true) == nil then
                error('the attitude did not read back as hostile')
            end
        end)
        if not hostile then note('attitude') end
        local roleOk = pcall(function()
            local role = npc:GetAIControllerComponent():GetAIRole()
            if role == nil or role:IsA('AINoRole') then error('no live AI role') end
        end)
        if not roleOk then note('role') end
        local presetOk = pcall(function()
            local component = npc:GetStimReactionComponent()
            local current = component:GetReactionPreset()
            if current and current:IsAggressive() == true then return end
            local wanted = aggressivePreset()
            if not wanted then error('no aggressive preset') end
            component:SetReactionPreset(wanted)
        end)
        if not presetOk then note('preset') end
        local started = pcall(function() npc:GetStimReactionComponent():TriggerCombat(p) end)
        if not started then
            started = pcall(function() if AIActionHelper.TryStartCombatWithTarget(npc, p) == false then error('refused') end end)
        end
        local forced = pcall(function() NPCPuppet.ChangeHighLevelState(npc, Enum.new('gamedataNPCHighLevelState', 'Combat')) end)
        if not started and not forced then note('combat') end
        if type(options) == 'table' and options.shared == true then
            -- unverified: a threat injected into the member's own tracker, so the whole squad reacts as one.
            local threat = pcall(function() npc:GetTargetTrackerComponent():AddThreat(p, true, p:GetWorldPosition(), 1.0, 30.0, false) end)
            if not threat then note('threat') end
        end
        return hostile and (started or forced), table.concat(notes, ',')
    end

    -- ---- hostage ---------------------------------------------------------------------------------------------------------------------------
    local function setHealth(npc, percent)
        Game.GetStatPoolsSystem():RequestSettingStatPoolValue(npc:GetEntityID(), Enum.new('gamedataStatPoolType', 'Health'), percent, nil, true)   -- unverified
    end
    local function godMode(npc, handle, on)
        local system = Game.GetGodModeSystem()
        if not system then error('no god mode system') end
        local mode = Enum.new('gameGodModeType', 'Invulnerable')
        local id = npc:GetEntityID()
        if on then
            system:AddGodMode(id, mode, CName.new(M.PROTECTION))
            if system:HasGodMode(id, mode) ~= true then error('readback is false') end
            protected[keyOf(idOf(handle))] = true
        else
            system:RemoveGodMode(id, mode, CName.new(M.PROTECTION))
            protected[keyOf(idOf(handle))] = nil
        end
    end

    -- Friendly to V, god mode on (so the drain below can never kill her). Called once when she is attached. true when both held, and what was refused.
    function W.hostageConfigure(handle)
        local npc, p = entity(handle), player()
        if npc == nil or not p then return false, 'not attached' end
        local notes = {}
        local friendly = pcall(function()
            npc:GetAttitudeAgent():SetAttitudeTowards(p:GetAttitudeAgent(), attitude('AIA_Friendly'))
            p:GetAttitudeAgent():SetAttitudeTowards(npc:GetAttitudeAgent(), attitude('AIA_Friendly'))
        end)
        if not friendly then notes[#notes + 1] = 'attitude' end
        local safe = pcall(godMode, npc, handle, true)
        if not safe then notes[#notes + 1] = 'godmode' end
        return friendly and safe, table.concat(notes, ',')
    end

    -- About half a second after the configuration: the health pool is drained to a low floor (never zero), so she lies wounded. The pack reads it back later.
    function W.hostageDrain(handle)
        local npc = entity(handle)
        if npc == nil then return false end
        return (pcall(setHealth, npc, M.DOWN_PERCENT))
    end

    function W.hostageProtect(handle, on)
        local npc = entity(handle)
        if npc == nil then return false end
        return (pcall(godMode, npc, handle, on == true))
    end

    -- Freed: the pool is filled again so she can stand.
    function W.hostageRaise(handle)
        local npc = entity(handle)
        if npc == nil then return false end
        return (pcall(setHealth, npc, M.FULL_PERCENT))
    end

    -- ---- escortee --------------------------------------------------------------------------------------------------------------------------
    local function follow(npc, key, p)
        local ai = npc:GetAIControllerComponent()
        local role = ai:GetAIRole()
        if role == nil or role:IsA('AINoRole') then
            -- The follower role of the party code (unverified on an ordinary extra), set once.
            if roles[key] ~= 'role' then
                local newRole = NewObject('AIFollowerRole')
                newRole.followerRef = Game.CreateEntityReference('#player', {})
                ai:SetAIRole(newRole)
                ai:OnAttach()
                roles[key] = 'role'
            end
            return 'role'
        end
        -- The extra has a role of its own: the follow command of the party code, sent again by the caller every few seconds.
        local command = NewObject('AIFollowTargetCommand')
        command.target = p
        command.desiredDistance = 3.0
        command.tolerance = 0.8
        command.movementType = Enum.new('moveMovementType', 'Walk')
        command.matchSpeed = true
        command.teleport = false
        command.stopWhenDestinationReached = false
        if commands[key] then pcall(function() ai:CancelCommand(commands[key]) end) end
        if ai:SendCommand(command) == false then error('the follow command was refused') end
        commands[key], roles[key] = command, 'command'
        return 'command'
    end

    -- Calm, friendly to V, a health bonus (a multiplier on the health stat, then the pool filled), and following. true when the follow was accepted.
    function W.escorteeConfigure(handle, options)
        local npc, p = entity(handle), player()
        if npc == nil or not p then return false, 'not attached' end
        local notes = {}
        if not pcall(function()
            npc:GetAttitudeAgent():SetAttitudeTowards(p:GetAttitudeAgent(), attitude('AIA_Friendly'))
            p:GetAttitudeAgent():SetAttitudeTowards(npc:GetAttitudeAgent(), attitude('AIA_Friendly'))
        end) then notes[#notes + 1] = 'attitude' end
        local bonus = type(options) == 'table' and tonumber(options.bonus) or nil
        if bonus and bonus > 1 then
            if not pcall(function()   -- unverified
                local health, kind = Enum.new('gamedataStatType', 'Health'), Enum.new('gameStatModifierType', 'Multiplier')
                Game.GetStatsSystem():AddModifier(npc:GetEntityID(), RPGManager.CreateStatModifier(health, kind, bonus))
                setHealth(npc, M.FULL_PERCENT)
            end) then notes[#notes + 1] = 'bonus' end
        end
        local key = keyOf(idOf(handle))
        local followed = pcall(follow, npc, key, p)
        if not followed then notes[#notes + 1] = 'follow' end
        return followed, table.concat(notes, ',')
    end

    function W.escorteeFollow(handle)
        local npc, p = entity(handle), player()
        if npc == nil or not p then return false end
        return (pcall(follow, npc, keyOf(idOf(handle)), p))
    end

    -- Bolts: the follow is dropped and the person is afraid (the high-level state the NPC reactions use for fear). true when the fear was accepted.
    function W.escorteeBolt(handle)
        local npc = entity(handle)
        if npc == nil then return false end
        local key = keyOf(idOf(handle))
        pcall(function()
            local ai = npc:GetAIControllerComponent()
            if roles[key] == 'command' and commands[key] then ai:CancelCommand(commands[key]) end
            if roles[key] == 'role' then ai:SetAIRole(NewObject('AINoRole')); ai:OnAttach() end
            commands[key], roles[key] = nil, nil
        end)
        return (pcall(function() NPCPuppet.ChangeHighLevelState(npc, Enum.new('gamedataNPCHighLevelState', 'Fear')) end))
    end

    -- Talked back: calm again, and following.
    function W.escorteeCalm(handle)
        local npc = entity(handle)
        if npc == nil then return false end
        pcall(function() NPCPuppet.ChangeHighLevelState(npc, Enum.new('gamedataNPCHighLevelState', 'Relaxed')) end)
        return W.escorteeFollow(handle)
    end

    -- Moved to V's side (an AI teleport command, as the party code does, a transform teleport on an AI-driven body is undone). The caller has judged that the
    -- person is out of sight and not mounted. true when the command was accepted.
    function W.escorteeLeash(handle)
        local npc, p = entity(handle), player()
        if npc == nil or not p then return false end
        return (pcall(function()
            local at, forward = p:GetWorldPosition(), p:GetWorldForward()
            local fl = math.sqrt(forward.x * forward.x + forward.y * forward.y)
            if fl < 0.01 then forward, fl = {x = 1, y = 0}, 1 end
            local fx, fy = forward.x / fl, forward.y / fl
            local x = at.x - fx * M.LEASH_BEHIND - fy * M.LEASH_SIDE
            local y = at.y - fy * M.LEASH_BEHIND + fx * M.LEASH_SIDE
            local z = at.z
            local okNav, found = pcall(function() return Game.GetAINavigationSystem():FindPointInSphereForCharacter(Vector4.new(x, y, z, 1), 1.5, p) end)
            if okNav and found and found.status == Enum.new('worldNavigationRequestStatus', 'OK') and finite(found.point.x) then
                x, y, z = found.point.x, found.point.y, found.point.z
            end
            local command = NewObject('AITeleportCommand')
            command.position = Vector4.new(x, y, z, 1)
            command.rotation = 0
            command.doNavTest = false
            if npc:GetAIControllerComponent():SendCommand(command) == false then error('refused') end
        end))
    end

    -- How many spawns this module holds (the leftovers of an earlier session are swept by the shared tag, mod/quest-world.lua sweep).
    function W.actionSpawns()
        local n = 0
        for _ in pairs(mine) do n = n + 1 end
        return n
    end

    return W
end

return M
