-- The game side of revenge ambushes (docs/AMBUSHES.md): the native calls mod/revenge-ambush.lua asks for, each one guarded, none of them run per frame.
-- They are read or made only when the ambush module asks: a look every 30 s while the setting is on (world), a spot search (four steps of the invitation
-- code's own search), a spawn, and one step a second while a squad exists.
--
-- Nothing here touches a character of the game. The fighters are new copies the mod creates itself (DynamicEntitySystem, nonpersistent, tagged
-- CyberpunkConvaiAmbusher so the mod treats them as its own and never as someone else's spawn), made hostile to V with the two calls the NPC reactions
-- already use (mod/npc-reactions.lua makeHostile and startCombat), and deleted when the squad is over.
local M = {TAG = 'CyberpunkConvaiAmbusher', BODY_KEY = 'judy-alvarez'}

local function finite(value) return type(value) == 'number' and value == value and math.abs(value) < 1e7 end
local function nameText(value)
    if value == nil then return nil end
    if type(value) == 'string' then return value end
    local ok, text = pcall(function() return value.value end)
    if ok and type(text) == 'string' and text ~= '' then return text end
    ok, text = pcall(function() return Game.NameToString(value) end)
    if ok and type(text) == 'string' and text ~= '' and text ~= 'None' then return text end
    return nil
end

-- deps: companions (findVisitorSpot, hiddenFromPlayer), groups (affiliation name -> gang base, revenge-ambush.lua GROUPS), log(line)
function M.new(deps)
    local W = {}
    local companions = deps.companions

    -- V in ordinary play, as the mod's other quiet features read it (battle observer sample), plus the three things an ambush also avoids: a wanted level
    -- (the police have V), an interior (flats, shops, clubs) and a safe zone (NoCombat). nil: fine; else the reason.
    function W.world(sample, wanted)
        if type(sample) ~= 'table' or sample.available ~= true then return 'unreadable' end
        if sample.combat then return 'combat' end
        if sample.blocked then return sample.vehicle and 'vehicle' or sample.call and 'call' or 'scene' end
        if sample.vehicle then return 'vehicle' end
        local player = Game.GetPlayer()
        if not player then return 'unreadable' end
        local okHeat, heat = pcall(wanted)
        if not okHeat then return 'unreadable' end
        if tonumber(heat) ~= 0 then return 'wanted' end
        local interiorOk, inside = pcall(function()
            if Game ~= nil and type(Game.IsEntityInInteriorArea) == 'function' then return Game.IsEntityInInteriorArea(player) end
            return IsEntityInInteriorArea(player)
        end)
        if not interiorOk or type(inside) ~= 'boolean' then return 'unreadable' end
        if inside then return 'interior' end
        local safeOk, safe = pcall(function() return StatusEffectSystem.ObjectHasStatusEffectWithTag(player, CName.new('NoCombat')) == true end)
        if safeOk and safe then return 'safe-zone' end
        return nil
    end

    -- The record of an NPC V killed, as 'Character.name' (the same read the archetype classifier makes), or nil.
    function W.recordOf(npc)
        local ok, text = pcall(function() return TDBID.ToStringDEBUG(npc:GetRecordID()) end)
        if not ok or type(text) ~= 'string' then return nil end
        local name = text:match('Character%.[%w_]+')
        return name
    end

    -- A record the squad may use: the game has it, it is a human character, not a crowd person, and its affiliation is this gang's.
    function W.verify(record, group)
        if type(record) ~= 'string' then return false end
        local ok, good = pcall(function()
            local found = TweakDB:GetRecord(TweakDBID.new(record))
            if not found or not found:IsA('gamedataCharacter_Record') then return false end
            if found:IsCrowd() == true then return false end
            local affiliation = nameText(found:Affiliation():EnumName())
            return deps.groups[affiliation] == group
        end)
        return ok and good == true
    end

    -- A hidden, walkable spot V can be reached from: the invitation code's own search (45 m out, then nearer), a few queries a step.
    function W.findSpot(state, relax)
        local player = Game.GetPlayer()
        if not player then return nil, 'World is not ready' end
        local at = player:GetWorldPosition()
        return companions.findVisitorSpot(M.BODY_KEY, {destination = {x = at.x, y = at.y, z = at.z}, mode = 'walk', relax = relax, maxDistance = 70}, state)
    end

    -- One fighter at the spot (a pace to the side for each after the first, on walkable ground). Returns the entity ID, or nil + why.
    function W.create(record, spot, index, count)
        local player = Game.GetPlayer()
        local system = Game.GetDynamicEntitySystem()
        if not player or not system or not system:IsReady() then return nil, 'World is not ready' end
        local position = spot.position
        if type(position) ~= 'table' or not finite(position.x) or not finite(position.y) or not finite(position.z) then return nil, 'bad spot' end
        local facing = spot.facing or {x = 1, y = 0}
        local x, y = position.x, position.y
        if index > 1 then
            -- Side by side across the line of sight: 1.6 m apart, alternating right and left.
            local side = (index % 2 == 0 and 1 or -1) * math.ceil((index - 1) / 2) * 1.6
            x, y = x - (facing.y or 0) * side, y + (facing.x or 0) * side
            local okNav, found = pcall(function() return Game.GetAINavigationSystem():FindPointInSphereForCharacter(Vector4.new(x, y, position.z, 1), 1.2, player) end)
            if okNav and found and found.status == Enum.new('worldNavigationRequestStatus', 'OK') and finite(found.point.x) then
                x, y = found.point.x, found.point.y
            else
                x, y = position.x, position.y
            end
        end
        local spec = NewObject('DynamicEntitySpec')
        spec.recordID = TweakDBID.new(record)
        spec.position = Vector4.new(x, y, position.z, 1)
        local okFace, orientation = pcall(function() return Quaternion.BuildFromDirectionVector(Vector4.new(facing.x or 0, facing.y or 0, 0, 0)) end)
        if okFace and orientation then spec.orientation = orientation end
        spec.spawnInView = true
        spec.active = true
        spec.alwaysSpawned = false
        spec.persistState, spec.persistSpawn = false, false
        spec.tags = {CName.new(M.TAG)}
        local created, id = pcall(function() return system:CreateEntity(spec) end)
        if not created or not id or tostring(id.hash):match('^0+[uUlL]*$') then return nil, 'The game could not create the fighter.' end
        return id
    end

    -- The fighter once the game has attached it, else nil (it is not in the world yet).
    function W.entity(handle)
        local ok, npc = pcall(function()
            local system = Game.GetDynamicEntitySystem()
            if not system or not system:IsReady() or not system:IsManaged(handle) then return nil end
            local entity = system:GetEntity(handle)
            if entity and entity:IsAttached() and entity:IsA('NPCPuppet') then return entity end
            return nil
        end)
        return ok and npc or nil
    end

    function W.alive(npc)
        local ok, dead = pcall(function() return npc:IsDeadNoStatPool() end)
        return ok and dead == false
    end

    function W.playerNear(npc)
        local ok, metres = pcall(function()
            local a, b = npc:GetWorldPosition(), Game.GetPlayer():GetWorldPosition()
            return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2 + (a.z - b.z) ^ 2)
        end)
        return ok and finite(metres) and metres or nil
    end

    -- Hostile to V at the agent level (never the attitude group), then the person's own combat start against V, then the forced fight state: the three
    -- asks mod/npc-reactions.lua makes for an attack (live-checked there 2026-10-21). True when it reads back hostile and one fight ask was accepted.
    function W.arm(npc)
        local player = Game.GetPlayer()
        if not player then return false end
        local hostile = pcall(function()
            npc:GetAttitudeAgent():SetAttitudeTowards(player:GetAttitudeAgent(), Enum.new('EAIAttitude', 'AIA_Hostile'))
            if tostring(npc:GetAttitudeAgent():GetAttitudeTowards(player:GetAttitudeAgent())):find('AIA_Hostile', 1, true) == nil then
                error('the attitude did not read back as hostile')
            end
        end)
        if not hostile then return false end
        local started = pcall(function() npc:GetStimReactionComponent():TriggerCombat(player) end)
        if not started then
            started = pcall(function() if AIActionHelper.TryStartCombatWithTarget(npc, player) == false then error('refused') end end)
        end
        local state = pcall(function() NPCPuppet.ChangeHighLevelState(npc, Enum.new('gamedataNPCHighLevelState', 'Combat')) end)
        return started or state
    end

    function W.hidden(npc)
        local ok, value = pcall(function() return companions.hiddenFromPlayer(npc:GetWorldPosition()) end)
        if ok then return value end
        return nil
    end

    function W.delete(handle)
        pcall(function() Game.GetDynamicEntitySystem():DeleteEntity(handle) end)
    end

    -- Fighters a session before this one left behind (a CET reload keeps the game running), found by their tag and removed once, when the module is built.
    function W.sweep()
        local ok, count = pcall(function()
            local system = Game.GetDynamicEntitySystem()
            if not system or not system:IsReady() then return 0 end
            local ids = system:GetTaggedIDs(CName.new(M.TAG))
            if type(ids) ~= 'table' then return 0 end
            for index = 1, #ids do system:DeleteEntity(ids[index]) end
            return #ids
        end)
        return ok and count or 0
    end

    return W
end

return M
