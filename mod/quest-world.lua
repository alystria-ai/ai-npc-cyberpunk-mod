-- The game side of the bond quest primitives (docs/QUEST_PRIMITIVES.md): the native calls mod/quest-places.lua and mod/quest-prims.lua ask for, each one
-- guarded by its caller, none of them run per frame. They are made only when a primitive asks (a position read at 1 Hz or slower, one ray per place, a pin,
-- a spawn, a sweep). Nothing here touches a character the game placed: it reads and spawns the mod's own copies and its own tagged spawns.
--
-- Entity handles are never kept: every function hands back plain data (positions, flags) or an opaque id (an entity ID, an appointment name), and an
-- entity is looked up again from that id at each use and counted only when the game has attached it.
--
-- UNVERIFIED in the game (offline-tested on a fake game only, and the first live run must look at each): the mappin registration (pinAdd, pinRemove),
-- the ground ray (rayDown, the same query form the seating and clearance code use), a copy placed at a spot through the party queue's appointment (the form
-- the housemates use), and the tagged extra (the same spec the ambush squad uses).
local M = {TAG = 'CyberpunkConvaiQuest'}

local function finite(value) return type(value) == 'number' and value == value and math.abs(value) < 1e7 end
local function plain(p) return {x = p.x, y = p.y, z = p.z} end
local function nullHash(id) return not id or tostring(id.hash):match('^0+[uUlL]*$') ~= nil end

-- deps: companions (conversationCandidates, ownCopy, identity, partyMemberOf, visitors, dismissVisitor), queue() -> the party queue (invite, dismiss),
-- seating() -> the seating controller (sitting, phaseOf), district() -> {district, area} | nil, log(line).
function M.new(deps)
    deps = deps or {}
    local W = {}
    local companions = deps.companions or {}

    local function log(line) if type(deps.log) == 'function' then pcall(deps.log, 'Quest world: ' .. line) end end

    function W.playerPosition()
        local player = Game.GetPlayer()
        if not player then return nil end
        return plain(player:GetWorldPosition())
    end

    function W.district()
        if type(deps.district) ~= 'function' then return nil end
        return deps.district()
    end

    -- The highest floor surface between `top` and `bottom` over (x, y): one ray per collision group the mod's other code uses for floors.
    function W.rayDown(x, y, top, bottom)
        local spatial = Game.GetSpatialQueriesSystem()
        if not spatial then return nil end
        local best
        for _, group in ipairs({'Static', 'Terrain'}) do
            local hit, trace = spatial:SyncRaycastByCollisionGroup(Vector4.new(x, y, top, 1), Vector4.new(x, y, bottom, 1), CName.new(group), false, false)
            if hit == true and trace and trace.position and finite(trace.position.z) and (not best or trace.position.z > best) then best = trace.position.z end
        end
        return best
    end

    -- ---- map pins -----------------------------------------------------------------------------------------------------------------------
    -- unverified: the game keeps no pin of the mod over a load, and the variant that suits a meeting point is to look at in game.
    function W.pinAdd(x, y, z)
        local data = NewObject('gamemappinsMappinData')
        data.mappinType = TweakDBID.new('Mappins.DefaultStaticMappin')
        data.variant = Enum.new('gamedataMappinVariant', 'CustomPositionVariant')
        data.visibleThroughWalls = true
        local id = Game.GetMappinSystem():RegisterMappin(data, Vector4.new(x, y, z, 1))
        if id == nil or id == false then return nil end
        return id
    end

    function W.pinRemove(id)
        Game.GetMappinSystem():UnregisterMappin(id)
    end

    -- ---- the character's copy -----------------------------------------------------------------------------------------------------------
    -- The nearest copy of the mod that speaks as this profile: {kind = 'party' | 'visitor' | 'housemate', serial, position}. Looked up on each call.
    function W.copyOf(profileKey)
        local player = Game.GetPlayer()
        if not player or type(companions.conversationCandidates) ~= 'function' then return nil end
        for _, row in ipairs(companions.conversationCandidates(player, 100000)) do
            if row.profileKey == profileKey then
                local kind = row.party and 'party' or companions.ownCopy(row.entity, profileKey) or 'visitor'
                local _, _, _, serial = companions.identity(row.npc)
                return {kind = kind, serial = serial, position = plain(row.npc:GetWorldPosition())}
            end
        end
        return nil
    end

    -- V seated, and the party copy seated with V, from the seating controller's state (one cheap getter each).
    function W.seated(profileKey)
        local seating = type(deps.seating) == 'function' and deps.seating() or nil
        if not seating then return {v = false, copy = false} end
        local v = seating.sitting() == true
        local copy = false
        local member = type(companions.partyMemberOf) == 'function' and companions.partyMemberOf(profileKey) or nil
        if member and type(seating.phaseOf) == 'function' then copy = seating.phaseOf(member.serial) == 'seated' end
        return {v = v, copy = copy}
    end

    -- ---- cast ---------------------------------------------------------------------------------------------------------------------------
    local function visitorRow(appointment)
        for _, row in ipairs(type(companions.visitors) == 'function' and companions.visitors() or {}) do
            if row.appointmentId == appointment then return row end
        end
        return nil
    end

    -- request: {id, who, profileKey, record, x, y, z, facing, tag}. Returns an opaque handle, or nil and why.
    function W.castSpawn(request)
        if type(request) ~= 'table' or not finite(request.x) or not finite(request.y) or not finite(request.z) then return nil, 'bad place' end
        local facing = type(request.facing) == 'table' and request.facing or {x = 1, y = 0}
        if request.who == 'extra' then
            local system = Game.GetDynamicEntitySystem()
            if not system or not system:IsReady() then return nil, 'World is not ready' end
            local known = pcall(function()
                local found = TweakDB:GetRecord(TweakDBID.new(request.record))
                if not found or not found:IsA('gamedataCharacter_Record') then error('not a character record') end
            end)
            if not known then return nil, 'unknown record ' .. tostring(request.record) end
            local spec = NewObject('DynamicEntitySpec')
            spec.recordID = TweakDBID.new(request.record)
            spec.position = Vector4.new(request.x, request.y, request.z, 1)
            local okFace, orientation = pcall(function() return Quaternion.BuildFromDirectionVector(Vector4.new(facing.x or 0, facing.y or 0, 0, 0)) end)
            if okFace and orientation then spec.orientation = orientation end
            spec.spawnInView = true
            spec.active = true
            spec.alwaysSpawned = false
            spec.persistState, spec.persistSpawn = false, false
            local tags = {CName.new(M.TAG)}
            if type(request.tag) == 'string' and request.tag ~= '' then tags[2] = CName.new(request.tag) end
            spec.tags = tags
            local created, id = pcall(function() return system:CreateEntity(spec) end)
            if not created or nullHash(id) then return nil, 'The game could not create the character.' end
            return {kind = 'extra', id = id}
        end
        -- One of the mod's own copies (the pack's character, or another one), placed at the spot through the party queue's appointment form.
        local queue = type(deps.queue) == 'function' and deps.queue() or nil
        if not queue or type(request.profileKey) ~= 'string' then return nil, 'no party queue' end
        local appointment = 'quest:' .. tostring(request.id)
        local ok, accepted, message, job = pcall(queue.invite, request.profileKey, {quiet = true, resident = true,
            appointment = {id = appointment, position = {x = request.x, y = request.y, z = request.z}, facing = {x = facing.x or 0, y = facing.y or 0},
                owner = 'quest', flexible = true}})
        if not ok then return nil, tostring(accepted) end
        if not accepted then return nil, tostring(message) end
        return {kind = 'copy', appointment = appointment, job = job, profileKey = request.profileKey}
    end

    -- A visiting copy of the quest joins V's party (the same call the invitations make when V reaches her). false + why when she cannot.
    function W.partyJoin(serial)
        if serial == nil or type(companions.joinVisitor) ~= 'function' then return false, 'no join call' end
        local ok, done, why = pcall(companions.joinVisitor, serial)
        if not ok then return false, tostring(done) end
        return done == true, why
    end

    -- The cast member once the game has attached it ({position}), else nil.
    function W.castLookup(handle)
        if type(handle) ~= 'table' then return nil end
        if handle.kind == 'extra' then
            local ok, found = pcall(function()
                local system = Game.GetDynamicEntitySystem()
                if not system or not system:IsReady() or not system:IsManaged(handle.id) then return nil end
                local entity = system:GetEntity(handle.id)
                if entity and entity:IsAttached() then return plain(entity:GetWorldPosition()) end
                return nil
            end)
            return ok and found and {position = found} or nil
        end
        local row = visitorRow(handle.appointment)
        if row and row.state == 'visiting' and row.position then return {position = row.position, serial = row.serial} end
        return nil
    end

    function W.castDelete(handle)
        if type(handle) ~= 'table' then return end
        if handle.kind == 'extra' then
            pcall(function()
                local system = Game.GetDynamicEntitySystem()
                if system and system:IsReady() and system:IsManaged(handle.id) and system:IsTagged(handle.id, CName.new(M.TAG)) then system:DeleteEntity(handle.id) end
            end)
            return
        end
        local row = visitorRow(handle.appointment)
        if row then pcall(companions.dismissVisitor, row.serial, 'module') end
        -- A copy that joined V's party since is V's companion now like any invited friend: V dismisses her, the quest does not.
        if not row and handle.profileKey and type(companions.partyMemberOf) == 'function' then
            local okMember, member = pcall(companions.partyMemberOf, handle.profileKey)
            if okMember and member then return end
        end
        local queue = type(deps.queue) == 'function' and deps.queue() or nil
        if queue and handle.job and not row then pcall(queue.dismiss, handle.job, true) end
    end

    -- Characters a session before this one left behind (a CET reload keeps the game running), found by the tag and removed once, when the module is built.
    function W.sweep()
        local ok, count = pcall(function()
            local system = Game.GetDynamicEntitySystem()
            if not system or not system:IsReady() then return 0 end
            local ids = system:GetTaggedIDs(CName.new(M.TAG))
            if type(ids) ~= 'table' then return 0 end
            for index = 1, #ids do system:DeleteEntity(ids[index]) end
            return #ids
        end)
        if ok and count > 0 then log('removed ' .. count .. ' tagged character(s) left by an earlier session') end
        return ok and count or 0
    end

    return W
end

return M
