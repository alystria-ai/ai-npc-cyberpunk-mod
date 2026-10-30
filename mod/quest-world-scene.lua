-- The game side of the SCENE group of bond quest primitives (mod/quest-prims-scene.lua: bout, hold-until, apart, unseen, dead-zone, workspot, npc-react) and of the gap
-- idle (mod/quest-lines.lua). The native calls only, each one guarded by its caller. None of them runs per frame: a state read is asked once a second at most per
-- fighter, a workspot step once a second until the pose plays, an outcome never polled.
--
-- Entity handles are never kept. A handle is plain data: {kind = 'extra', id = EntityID} for a tagged spawn of the quest (the cast primitive's), or {kind = 'copy',
-- profileKey = ...} for one of the mod's own copies (looked up through the companion table each time). The entity is found again in every call and counts only once the
-- game has attached it. A tagged spawn must carry the shared tag, a copy must be one of companions.conversationCandidates (the mod's own). Nothing here touches a character
-- the game placed.
--
-- UNVERIFIED in the game (offline-tested on a fake game only, the first live run must look at each):
--   fighterRead     the health pool read (StatPoolsSystem), IsInCombat on an extra and on a copy.
--   boutArm         attitude both ways between the two fighters (never V), the bare-hands equip command, TriggerCombat at the other fighter, the Combat high-level state.
--                   That the AI fights only the other fighter and ignores V is the main open question, so is a copy (a companion with tactics of its own) taking part.
--   boutStand       attitude back to friendly between them, the Relaxed high-level state.
--   fighterHealth   the health pool write (the handicap).
--   playerInCombat  player:IsInCombat() (the call the other modules use).
--   workspotBegin, workspotStep, workspotEnd   the gestures' invisible device (gesture-workspot.lua), a component of the gesture archive (idle or seat) played on a body
--                   that is not in a workspot of its own. A seat component played away from its furniture sits the body in the air.
--   entityKey, npcOutcomeHook   the entity hash text npc-reactions.lua keys a person by, and the global list convaiQuestNpcSinks that mod/init.lua fires from the reaction module.
--   gapIdle         a standing idle of the archive on the copy for the length of a talk gap.
local M = {TAG = 'CyberpunkConvaiQuest', FISTS = 'Items.w_melee_004__fists_a', PLAY_GRACE = 3, IDLE_TRIES = 30}

local function finite(value) return type(value) == 'number' and value == value and math.abs(value) < 1e7 end
local function nullHash(id) return not id or tostring(id.hash):match('^0+[uUlL]*$') ~= nil end

-- A global of the mod's environment (init.lua sets them), read guarded.
local function global(key)
    local ok, value = pcall(function() return _G[key] end)
    if ok and value ~= nil then return value end
    ok, value = pcall(rawget, _G, key)
    return ok and value or nil
end

-- deps: companions (conversationCandidates), workspot (gesture-workspot.lua, a test's fake), catalog() -> the gesture catalog, clock(), log(line).
function M.new(deps)
    deps = deps or {}
    local W = {}
    local companions = deps.companions or {}
    local workspot = deps.workspot
    local catalogCache

    local function log(line) if type(deps.log) == 'function' then pcall(deps.log, 'Quest scene world: ' .. line) end end
    local function clock()
        local ok, value = pcall(deps.clock or os.clock)
        return ok and type(value) == 'number' and value or os.clock()
    end
    local function player() return Game.GetPlayer() end
    local function attitude(name) return Enum.new('EAIAttitude', name) end
    local function spots()
        if workspot == nil and type(dofile) == 'function' then
            local ok, module = pcall(dofile, 'gesture-workspot.lua')
            workspot = ok and type(module) == 'table' and module or false
        end
        return workspot or nil
    end
    -- The gesture catalog, from the gesture controller when it is loaded (its table is the one in memory), else read once. Plain tables: idleComponents, seatComponents, device.
    local function catalog()
        if catalogCache then return catalogCache end
        local found
        if type(deps.catalog) == 'function' then
            local ok, value = pcall(deps.catalog)
            found = ok and value or nil
        end
        if type(found) ~= 'table' then
            local controller = global('convaiGestures')
            found = type(controller) == 'table' and controller.catalog or nil
        end
        if type(found) ~= 'table' and type(dofile) == 'function' then
            local ok, module = pcall(dofile, 'gesture-catalog.lua')
            found = ok and type(module) == 'table' and module or nil
        end
        if type(found) == 'table' and type(found.device) == 'string' then catalogCache = found end
        return catalogCache
    end

    -- ---- who is who ------------------------------------------------------------------------------------------------------------------------
    -- The puppet of a handle once the game has attached it, else nil. A tagged spawn of the quest, or one of the mod's own copies.
    local function npcOf(handle)
        if type(handle) ~= 'table' then return nil end
        if handle.kind == 'extra' then
            local ok, npc = pcall(function()
                local system = Game.GetDynamicEntitySystem()
                if not system or not system:IsReady() or not system:IsManaged(handle.id) or not system:IsTagged(handle.id, CName.new(M.TAG)) then return nil end
                local found = system:GetEntity(handle.id)
                if found and found:IsAttached() and found:IsA('NPCPuppet') then return found end
                return nil
            end)
            return ok and npc or nil
        end
        if handle.kind == 'copy' and type(handle.profileKey) == 'string' and type(companions.conversationCandidates) == 'function' then
            local ok, npc = pcall(function()
                local p = player()
                if not p then return nil end
                for _, row in ipairs(companions.conversationCandidates(p, 100000)) do
                    if row.profileKey == handle.profileKey then return row.npc end
                end
                return nil
            end)
            return ok and npc or nil
        end
        return nil
    end

    function W.entityKey(handle)
        if type(handle) == 'table' and handle.kind == 'extra' and handle.id ~= nil then
            local ok, key = pcall(function() return tostring(handle.id.hash) end)
            return ok and key or nil
        end
        local npc = npcOf(handle)
        if npc == nil then return nil end
        local ok, key = pcall(function() return tostring(npc:GetEntityID().hash) end)
        return ok and key or nil
    end

    -- ---- reads -------------------------------------------------------------------------------------------------------------------------
    function W.playerInCombat()
        local p = player()
        if not p then return nil end
        local ok, value = pcall(function() return p:IsInCombat() == true end)
        if not ok then return nil end
        return value
    end

    -- One read of one fighter: nil while the game has not attached it (or it is gone), else plain data. health is the pool in percent (nil when unreadable).
    function W.fighterRead(handle)
        local npc = npcOf(handle)
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
        local okAt, at = pcall(function() return npc:GetWorldPosition() end)
        if okAt and at and finite(at.x) then out.x, out.y, out.z = at.x, at.y, at.z end
        return out
    end

    -- ---- the bout ----------------------------------------------------------------------------------------------------------------------
    local function hostileTo(from, to)
        from:GetAttitudeAgent():SetAttitudeTowards(to:GetAttitudeAgent(), attitude('AIA_Hostile'))
        if tostring(from:GetAttitudeAgent():GetAttitudeTowards(to:GetAttitudeAgent())):find('AIA_Hostile', 1, true) == nil then
            error('the attitude did not read back as hostile')
        end
    end
    local function fists(npc)
        local command = NewObject('AIEquipCommand')
        command.slotId = TweakDBID.new('AttachmentSlots.WeaponRight')
        command.itemId = TweakDBID.new(M.FISTS)
        pcall(function() command.failIfItemNotFound = false end)
        if npc:GetAIControllerComponent():SendCommand(command) == false then error('the game refused the fists command') end
    end
    local function engage(npc, target)
        local started = pcall(function() npc:GetStimReactionComponent():TriggerCombat(target) end)
        local state = pcall(function() NPCPuppet.ChangeHighLevelState(npc, Enum.new('gamedataNPCHighLevelState', 'Combat')) end)
        if not started and not state then error('neither the combat start nor the combat state was accepted') end
    end

    -- Two fighters of the quest, hostile to each other only, bare hands, each asked to fight the other. V is not touched. true when the attitude read back hostile both ways
    -- and one fight ask was accepted by each, and a note on what was refused.
    function W.boutArm(handleA, handleB)
        local a, b = npcOf(handleA), npcOf(handleB)
        if a == nil or b == nil then return false, 'not attached' end
        local notes = {}
        local hostile = pcall(function() hostileTo(a, b); hostileTo(b, a) end)
        if not hostile then notes[#notes + 1] = 'attitude' end
        if not pcall(fists, a) then notes[#notes + 1] = 'fists a' end
        if not pcall(fists, b) then notes[#notes + 1] = 'fists b' end
        local fighting = pcall(function() engage(a, b); engage(b, a) end)
        if not fighting then notes[#notes + 1] = 'combat' end
        return hostile and fighting, table.concat(notes, ',')
    end

    -- Both stand down: friendly to each other again, relaxed. Idempotent, safe when one of them is gone.
    function W.boutStand(handleA, handleB)
        local a, b = npcOf(handleA), npcOf(handleB)
        local done = false
        if a ~= nil and b ~= nil then
            done = pcall(function()
                a:GetAttitudeAgent():SetAttitudeTowards(b:GetAttitudeAgent(), attitude('AIA_Friendly'))
                b:GetAttitudeAgent():SetAttitudeTowards(a:GetAttitudeAgent(), attitude('AIA_Friendly'))
            end)
        end
        for _, npc in ipairs({a, b}) do
            if npc ~= nil then pcall(function() NPCPuppet.ChangeHighLevelState(npc, Enum.new('gamedataNPCHighLevelState', 'Relaxed')) end) end
        end
        return done
    end

    -- The health pool to `percent` (the handicap's give back).
    function W.fighterHealth(handle, percent)
        local npc = npcOf(handle)
        if npc == nil or not finite(percent) then return false end
        return (pcall(function()
            Game.GetStatPoolsSystem():RequestSettingStatPoolValue(npc:GetEntityID(), Enum.new('gamedataStatPoolType', 'Health'), math.max(1, math.min(100, percent)), nil, true)   -- unverified
        end))
    end

    -- ---- npc outcomes ------------------------------------------------------------------------------------------------------------------
    -- The NPC reaction module reports through mod/init.lua into the list convaiQuestNpcSinks (a global the init glue owns). A sink is fn(entityKey, kind). Returns the removal.
    function W.npcOutcomeHook(fn)
        local list = global('convaiQuestNpcSinks')
        if type(list) ~= 'table' or type(fn) ~= 'function' then return nil end
        list[#list + 1] = fn
        return function()
            for index = #list, 1, -1 do if list[index] == fn then table.remove(list, index) end end
        end
    end

    -- ---- workspots ---------------------------------------------------------------------------------------------------------------------
    -- The body is there (attached) and may be posed: {position}. nil while it is not.
    function W.workspotReady(handle)
        local npc = npcOf(handle)
        if npc == nil then return nil end
        local ok, at = pcall(function() local p = npc:GetWorldPosition(); return {x = p.x, y = p.y, z = p.z} end)
        if not ok or not at or not finite(at.x) then return nil end
        return {position = at}
    end

    -- Starts a pose: spawns the gestures' invisible device where the body stands. request = {idle = key} or {seat = key}. Returns a session (plain: the target handle, the
    -- device's EntityID and the component name), or nil and why ('busy' = a workspot of someone else holds the body: it is never taken over, 'no component' = the installed
    -- archive does not carry the pose).
    function W.workspotBegin(handle, request)
        local native, cat = spots(), catalog()
        if not native or not cat then return nil, 'no gesture archive' end
        if type(request) ~= 'table' then return nil, 'bad request' end
        local component
        if type(request.idle) == 'string' then component = cat.idleComponents and cat.idleComponents[request.idle]
        elseif type(request.seat) == 'string' then component = cat.seatComponents and cat.seatComponents[request.seat] end
        if type(component) ~= 'string' then return nil, 'no component' end
        local npc = npcOf(handle)
        if npc == nil then return nil, 'not attached' end
        if native.inWorkspot(npc) ~= false then return nil, 'busy' end
        local ok, id = native.spawnDevice(npc, cat.device)
        if not ok then return nil, 'device ' .. tostring(id) end
        return {target = handle, device = id, component = component, phase = 'spawned', startedAt = clock()}
    end

    -- One step of a pose: 'wait' (the device is not there or not at the body yet), 'playing', 'lost' (it played and the body is out of it) or 'failed'. Safe to call every second.
    function W.workspotStep(session)
        if type(session) ~= 'table' then return 'failed', 'no session' end
        local native = spots()
        if not native then return 'failed', 'no gesture archive' end
        local npc = npcOf(session.target)
        if session.phase == 'spawned' then
            if npc == nil then return 'wait' end
            local device = native.deviceEntity(session.device)
            if device == false then return 'failed', 'the device is gone' end
            if device == nil then return 'wait' end
            local has = true
            pcall(function() has = device:FindComponentByName(CName.new(session.component)) ~= nil end)
            if not has then return 'failed', 'the archive has no ' .. session.component end
            if not session.moved then native.moveDevice(device, npc); session.moved = true end
            local placed = native.devicePlaced(device, npc)
            if placed == false then native.moveDevice(device, npc); return 'wait' end
            local ok, result = native.play(device, npc, session.component)
            if not ok then return 'failed', tostring(result) end
            session.phase, session.playedAt = 'playing', clock()
            return 'wait'
        end
        if session.phase == 'playing' then
            if npc == nil then return 'lost' end
            local inside = native.inWorkspot(npc)
            if inside == true then session.settled = true; return 'playing' end
            if inside == false and clock() - session.playedAt < M.PLAY_GRACE then return 'wait' end
            return 'lost'
        end
        return 'failed', 'ended'
    end

    -- The pose ends: the native fast exit first (never StopNpcInWorkspot), then the device goes. Idempotent, safe when the body is gone.
    function W.workspotEnd(session)
        if type(session) ~= 'table' or session.ended then return end
        session.ended = true
        local native = spots()
        if not native then return end
        local npc = npcOf(session.target)
        if npc ~= nil and session.phase == 'playing' then pcall(native.exit, npc, false) end
        pcall(native.deleteDevice, session.device)
    end

    -- ---- the gap idle ------------------------------------------------------------------------------------------------------------------
    -- mod/quest-lines.lua asks once when a talk gap opens (on = true) and once when it closes (on = false). Only a standing idle the archive carries is played (a seat kind is
    -- left to the seating code: off its furniture it would sit the body in the air). Returns, on start, a step function the line player calls once a second until it answers
    -- true (the pose plays, or it cannot): never per frame, and a failure is silent.
    local idles = {}      -- profileKey -> {session}: the idle each copy holds for its gap
    function W.gapIdle(profileKey, idleKey, on, situation)
        if type(profileKey) ~= 'string' then return nil end
        local held = idles[profileKey]
        idles[profileKey] = nil
        if held and held.session then pcall(W.workspotEnd, held.session) end
        if on ~= true or type(idleKey) ~= 'string' then return nil end
        local cat = catalog()
        if not (cat and type(cat.idleComponents) == 'table' and cat.idleComponents[idleKey]) then return nil end
        local target = {kind = 'copy', profileKey = profileKey}
        local entry, tries = {}, 0
        idles[profileKey] = entry
        return function()
            if idles[profileKey] ~= entry then return true end   -- the gap ended, or another idle took over
            tries = tries + 1
            if entry.session == nil then
                entry.session = W.workspotBegin(target, {idle = idleKey})
                if entry.session == nil then return tries >= M.IDLE_TRIES end
            end
            local status = W.workspotStep(entry.session)
            if status == 'playing' then return true end
            if status == 'failed' or status == 'lost' then
                idles[profileKey] = nil
                pcall(W.workspotEnd, entry.session)
                return true
            end
            return tries >= M.IDLE_TRIES
        end
    end

    return W
end

return M
