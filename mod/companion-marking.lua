-- V's marked target for companion tactics. The player aims at an NPC and
-- presses the Mark target binding; pressing it again on the same NPC clears the
-- mark. The game's own focus-mode tag is applied as the visible confirmation,
-- and when nothing was marked explicitly, exactly one scanner-tagged NPC nearby
-- also counts. Only plain identities and one live handle are retained.
local M = {}
local DEFAULTS = {aimDistance = 60, keepDistance = 90, taggedRadius = 50}

local function distance(a, b)
    if not a or not b then return math.huge end
    return math.sqrt((a.x - b.x)^2 + (a.y - b.y)^2 + (a.z - b.z)^2)
end

-- CET adapter. Every call is guarded by the caller; nothing here caches natives.
function M.nativeAdapter()
    local N = {}
    local function npcQuery(maxDistance)
        local query = TargetSearchQuery.new()
        query.searchFilter = Game['TSF_NPC;']()
        query.maxDistance = maxDistance
        query.includeSecondaryTargets = false
        query.filterObjectByDistance = true
        query.ignoreInstigator = true
        return query
    end
    function N.aimed(player, maxDistance)
        local targeting = Game.GetTargetingSystem()
        local ok, looked = pcall(function() return targeting:GetLookAtObject(player, true, true) end)
        if ok and looked and looked:IsNPC() then return looked end
        local nearestOk, nearest = pcall(function() return targeting:GetObjectClosestToCrosshair(player, npcQuery(maxDistance)) end)
        if nearestOk and nearest and nearest:IsNPC() then return nearest end
        return nil
    end
    function N.key(npc) return tostring(npc:GetEntityID().hash) end
    function N.valid(npc)
        return npc ~= nil and npc:IsNPC() and npc:IsAttached() and not npc:IsDeadNoStatPool()
            and not ScriptedPuppet.IsDefeated(npc)
    end
    function N.position(object)
        local p = object:GetWorldPosition(); return {x = p.x, y = p.y, z = p.z}
    end
    function N.name(npc) return tostring(npc:GetTweakDBFullDisplayName(true) or 'NPC') end
    function N.tagged(npc) return npc:IsTaggedinFocusMode() == true end
    function N.tag(npc) GameObject.TagObject(npc) end
    function N.untag(npc) GameObject.UntagObject(npc) end
    function N.nearbyTagged(player, radius)
        local query = npcQuery(radius)
        query.testedSet = Enum.new('TargetingSet', 'Complete')
        local _, parts = Game.GetTargetingSystem():GetTargetParts(player, query)
        local result, seen = {}, {}
        for _, part in ipairs(parts or {}) do
            local component = TS_TargetPartInfo.GetComponent(part)
            local entity = component and component:GetEntity()
            if entity and entity:IsNPC() then
                local key = tostring(entity:GetEntityID().hash)
                if not seen[key] and entity:IsTaggedinFocusMode() then seen[key] = true; result[#result + 1] = entity end
            end
        end
        return result
    end
    return N
end

function M.new(options)
    options = options or {}
    local K, native, owned = {}, options.native or M.nativeAdapter(), options.owned or function() return false end
    local settings = {}
    for key, value in pairs(DEFAULTS) do settings[key] = options[key] or value end
    local mark -- {npc, id, name, taggedByUs}

    local function guarded(fn, ...)
        local ok, value = pcall(fn, ...)
        return ok and value or nil
    end
    local function eligible(npc)
        return npc ~= nil and guarded(native.valid, npc) == true and not guarded(owned, npc)
    end

    function K.clear(reason)
        local prior = mark
        mark = nil
        if prior and prior.taggedByUs then pcall(native.untag, prior.npc) end
        return prior ~= nil
    end

    -- Drop the handle without native calls (world teardown).
    function K.abandon() mark = nil end

    function K.mark(player)
        if not player then return false, 'Player unavailable' end
        local npc = guarded(native.aimed, player, settings.aimDistance)
        if not eligible(npc) then
            if mark then K.clear('cleared'); return true, 'Target mark cleared.' end
            return false, 'Aim at a person to mark them for your companions.'
        end
        local id = guarded(native.key, npc)
        if not id then return false, 'That target cannot be marked.' end
        if mark and mark.id == id then K.clear('toggled'); return true, 'Target mark cleared.' end
        K.clear('replaced')
        local wasTagged = guarded(native.tagged, npc) == true
        if not wasTagged then pcall(native.tag, npc) end
        mark = {npc = npc, id = id, name = guarded(native.name, npc) or 'NPC', taggedByUs = not wasTagged}
        return true, 'Marked ' .. mark.name .. ' for your companions.', mark.name
    end

    -- Returns the current live target, its identity and how it was chosen.
    function K.current(player)
        if mark then
            local far = player and distance(guarded(native.position, player), guarded(native.position, mark.npc)) or math.huge
            if not eligible(mark.npc) or guarded(native.key, mark.npc) ~= mark.id or far > settings.keepDistance then
                K.clear('target-lost')
            else
                return mark.npc, {id = mark.id, name = mark.name, source = 'marked'}
            end
        end
        if not player then return nil end
        local tagged = guarded(native.nearbyTagged, player, settings.taggedRadius) or {}
        local found
        for _, npc in ipairs(tagged) do
            if eligible(npc) then
                if found then return nil, {ambiguous = true} end
                found = npc
            end
        end
        if not found then return nil end
        local id = guarded(native.key, found)
        if not id then return nil end
        return found, {id = id, name = guarded(native.name, found) or 'NPC', source = 'tagged'}
    end

    function K.snapshot()
        return {marked = mark ~= nil, id = mark and mark.id, name = mark and mark.name}
    end
    return K
end

return M
