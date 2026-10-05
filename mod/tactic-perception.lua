-- While a companion distracts someone, that target and the NPCs around it barely
-- notice V. Native mechanism: each NPC's SenseComponent keeps a per-observed-
-- entity detection multiplier (SetDetectionMultiplier(entityID, value)); vanilla
-- RefreshCombatDetectionMultiplier rewrites it to 1/2/10/100 on visibility
-- events, so it is re-asserted on a short period. Beyond a short range the
-- detection meter for V is also reset, so they only notice V up close.
-- The distraction must not start a fight either: NPCs here that are hostile
-- toward the companion (or it toward them) are set to neutral at agent level.
-- Every change is recorded per NPC and restored, or simply forgotten if the
-- world is torn down.
local M = {}
local DEFAULTS = {radius = 12, multiplier = 0.15, shortRange = 4, maxTracked = 16,
    reassertEvery = 0.25, scanEvery = 1.0}

local function distance(a, b)
    if not a or not b then return math.huge end
    return math.sqrt((a.x - b.x)^2 + (a.y - b.y)^2 + (a.z - b.z)^2)
end

function M.nativeAdapter()
    local N = {}
    local function attitude(name) return Enum.new('EAIAttitude', name) end
    function N.key(object) return tostring(object:GetEntityID().hash) end
    function N.valid(npc) return npc ~= nil and npc:IsAttached() and not npc:IsDeadNoStatPool() end
    function N.position(object) local p = object:GetWorldPosition(); return {x = p.x, y = p.y, z = p.z} end
    function N.inCombat(npc) return NPCPuppet.IsInCombat(npc) == true end
    function N.near(target, radius)
        local query = TargetSearchQuery.new()
        query.testedSet = Enum.new('TargetingSet', 'Complete')
        query.searchFilter = Game['TSF_NPC;']()
        query.maxDistance = radius
        query.filterObjectByDistance = true
        query.includeSecondaryTargets = false
        query.ignoreInstigator = false
        local _, parts = Game.GetTargetingSystem():GetTargetParts(target, query)
        local result = {}
        for _, part in ipairs(parts or {}) do
            local component = TS_TargetPartInfo.GetComponent(part)
            local entity = component and component:GetEntity()
            if entity and entity:IsNPC() then result[#result + 1] = entity end
        end
        return result
    end
    function N.getMultiplier(npc, player) return npc:GetSensesComponent():GetDetectionMultiplier(player:GetEntityID()) end
    function N.setMultiplier(npc, player, value) npc:GetSensesComponent():SetDetectionMultiplier(player:GetEntityID(), value) end
    function N.detection(npc, player) return npc:GetSensesComponent():GetDetection(player:GetEntityID()) end
    function N.resetDetection(npc, player) npc:GetSensesComponent():ResetDetection(player:GetEntityID()) end
    function N.attitude(from, to)
        local value = from:GetAttitudeAgent():GetAttitudeTowards(to:GetAttitudeAgent())
        local text = tostring(value)
        for _, name in ipairs({'AIA_Hostile', 'AIA_Neutral', 'AIA_Friendly'}) do
            if text:find(name, 1, true) then return name end
        end
        return nil
    end
    function N.setAttitude(from, to, name) from:GetAttitudeAgent():SetAttitudeTowards(to:GetAttitudeAgent(), attitude(name)) end
    return N
end

function M.new(options)
    options = options or {}
    local P, native = {}, options.native or M.nativeAdapter()
    local settings = {}
    for key, value in pairs(DEFAULTS) do settings[key] = options[key] or value end
    local state

    local function call(fn, ...)
        local ok, value = pcall(fn, ...)
        return ok, value
    end
    local function get(fn, ...)
        local ok, value = pcall(fn, ...)
        if ok then return value end
    end

    local function track(npc)
        if #state.order >= settings.maxTracked then return end
        local ok, key = call(native.key, npc)
        if not ok or not key or state.rows[key] or key == state.companionKey or key == state.playerKey then return end
        local row = {npc = npc, key = key}
        local got, prior = call(native.getMultiplier, npc, state.player)
        -- Never record our own value as the NPC's original.
        row.priorMultiplier = (got and type(prior) == 'number' and prior > settings.multiplier + 0.001) and prior or 1.0
        if state.companion then
            local toOk, toward = call(native.attitude, npc, state.companion)
            if toOk and toward == 'AIA_Hostile' and call(native.setAttitude, npc, state.companion, 'AIA_Neutral') then
                row.npcToCompanion = toward
            end
            local fromOk, from = call(native.attitude, state.companion, npc)
            if fromOk and from == 'AIA_Hostile' and call(native.setAttitude, state.companion, npc, 'AIA_Neutral') then
                row.companionToNpc = from
            end
        end
        state.rows[key] = row
        state.order[#state.order + 1] = row
    end

    local function scan()
        local ok, found = call(native.near, state.target, settings.radius)
        track(state.target)
        if ok and type(found) == 'table' then for _, npc in ipairs(found) do track(npc) end end
    end

    local function reassert()
        local playerAt = get(native.position, state.player)
        for _, row in ipairs(state.order) do
            local valid = get(native.valid, row.npc)
            if valid then
                call(native.setMultiplier, row.npc, state.player, settings.multiplier)
                local fighting = get(native.inCombat, row.npc)
                if not fighting then
                    local at = get(native.position, row.npc)
                    if distance(at, playerAt) > settings.shortRange then
                        local ok, meter = call(native.detection, row.npc, state.player)
                        -- A fully detected V (100) is the game's decision; leave it.
                        if ok and type(meter) == 'number' and meter > 0 and meter < 100 then
                            call(native.resetDetection, row.npc, state.player)
                            state.resets = state.resets + 1
                        end
                    end
                end
            end
        end
    end

    function P.active() return state ~= nil end

    function P.begin(target, player, companion)
        P.restore()
        state = {target = target, player = player, companion = companion, rows = {}, order = {},
            reassertIn = 0, scanIn = settings.scanEvery, resets = 0}
        state.companionKey = companion and get(native.key, companion) or nil
        state.playerKey = get(native.key, player)
        scan(); reassert()
        return #state.order
    end

    function P.update(dt)
        if not state then return end
        local step = tonumber(dt) or 0
        state.scanIn = state.scanIn - step
        if state.scanIn <= 0 then
            state.scanIn = settings.scanEvery
            if get(native.valid, state.target) then scan() end
        end
        state.reassertIn = state.reassertIn - step
        if state.reassertIn <= 0 then state.reassertIn = settings.reassertEvery; reassert() end
    end

    -- Restore every recorded change on NPCs that still exist.
    function P.restore()
        if not state then return 0 end
        local prior, restored = state, 0
        state = nil
        for _, row in ipairs(prior.order) do
            if get(native.valid, row.npc) then
                call(native.setMultiplier, row.npc, prior.player, row.priorMultiplier)
                if row.npcToCompanion and prior.companion then call(native.setAttitude, row.npc, prior.companion, row.npcToCompanion) end
                if row.companionToNpc and prior.companion then call(native.setAttitude, prior.companion, row.npc, row.companionToNpc) end
                restored = restored + 1
            end
        end
        return restored
    end

    -- World teardown: forget every handle without touching native components.
    function P.abandon() state = nil end

    function P.snapshot()
        if not state then return {active = false} end
        local neutralized = 0
        for _, row in ipairs(state.order) do if row.npcToCompanion or row.companionToNpc then neutralized = neutralized + 1 end end
        return {active = true, tracked = #state.order, neutralized = neutralized, resets = state.resets,
            multiplier = settings.multiplier, shortRange = settings.shortRange, radius = settings.radius}
    end
    return P
end

return M
