-- The target for companion tactics (Fight / Distract), chosen from the game's
-- own target marking. Nothing is bound or tagged by this mod. When a companion
-- request is admitted the choice is, in order:
--   1. the closest NPC V tagged in the scanner (focus mode) within tagRadius;
--   2. the NPC V is looking at (look-at, then closest to crosshair) within
--      aimRadius;
--   3. the closest eligible NPC within nearRadius.
-- Eligible means a living, combat-capable NPC that is not a companion: gang
-- members, police, corpo and military security, cyberpsychos, drones, mechs,
-- androids, anyone carrying a weapon, or anyone already hostile to V. Civilians,
-- children, vendors, named or quest-bound characters, invulnerable and
-- story-controlled NPCs, and friendly non-police NPCs are never targets.
-- Ambient gangers are very often crowd-flagged, so a crowd flag alone does not
-- disqualify an NPC V tagged or aimed at (a crowd NPC still needs positive
-- combat evidence). The nearest-NPC fallback never picks a crowd NPC: that
-- guess stays limited to ordinary combatants. Only plain identities and one
-- live handle are returned.
local M = {}
local DEFAULTS = {aimRadius = 30, nearRadius = 50, taggedRadius = 50, aimCone = 0.9781}

local function distance(a, b)
    if not a or not b then return math.huge end
    return math.sqrt((a.x - b.x)^2 + (a.y - b.y)^2 + (a.z - b.z)^2)
end

-- Pure decision over plain facts (see nativeAdapter.facts). Returns true and
-- 'combatant', or false and the reason the NPC is not a target. A crowd NPC is
-- rejected as 'crowd' only when explicit is not true (the nearest-NPC guess);
-- a tagged or aimed crowd NPC is judged on the same evidence as anyone else.
function M.verdict(facts, explicit)
    local f = facts or {}
    if f.companion then return false, 'companion' end
    if f.crowd and explicit ~= true then return false, 'crowd' end
    if f.civilian then return false, 'civilian' end
    if f.children then return false, 'children' end
    if f.vendor then return false, 'vendor' end
    if f.invulnerable then return false, 'invulnerable' end
    if f.story then return false, 'story-controlled' end
    if f.friendly and not f.police then return false, 'friendly' end
    if f.ganger or f.police or f.cyberpsycho or f.machine or f.armed or f.hostile then return true, 'combatant' end
    return false, 'not-combat-capable'
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
    -- Where the camera looks: origin and unit-ish forward as plain numbers, or nil.
    function N.crosshair(player)
        local origin, forward = Game.GetTargetingSystem():GetCrosshairData(player)
        if not origin or not forward then return nil end
        return {x = origin.x, y = origin.y, z = origin.z}, {x = forward.x, y = forward.y, z = forward.z}
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
    -- The game's own tag, set with the scanner (focus mode).
    function N.tagged(npc) return npc:IsTaggedinFocusMode() == true end
    function N.nearby(player, radius)
        local query = npcQuery(radius)
        query.testedSet = Enum.new('TargetingSet', 'Complete')
        local _, parts = Game.GetTargetingSystem():GetTargetParts(player, query)
        local result, seen = {}, {}
        for _, part in ipairs(parts or {}) do
            local component = TS_TargetPartInfo.GetComponent(part)
            local entity = component and component:GetEntity()
            if entity and entity:IsNPC() then
                local key = tostring(entity:GetEntityID().hash)
                if not seen[key] then seen[key] = true; result[#result + 1] = entity end
            end
        end
        return result
    end
    -- Plain facts about one NPC. A signal that errors is left nil (and listed in
    -- facts.unreadable); an unreadable exclusion never blocks a target, but a
    -- target still needs positive evidence of combat capability.
    function N.facts(npc, player)
        local f, unreadable = {}, {}
        local function read(name, fn)
            local ok, value = pcall(fn)
            if ok then f[name] = value == true else unreadable[#unreadable + 1] = name end
        end
        read('companion', function() return npc:IsPlayerCompanion() end)
        read('crowd', function() return npc:IsCrowd() end)
        read('civilian', function() return npc:IsCharacterCivilian() end)
        read('children', function() return npc:IsCharacterChildren() end)
        read('vendor', function() return npc:IsVendor() end)
        read('invulnerable', function()
            return npc:IsInvulnerable()
                or Game.GetStatsSystem():GetStatBoolValue(npc:GetEntityID(), Enum.new('gamedataStatType', 'IsInvulnerable'))
        end)
        -- Not on autonomous AI: a scripted scene or quest owns the NPC.
        read('story', function() return not npc:IsOnAutonomousAI() end)
        read('friendly', function()
            return tostring(npc:GetAttitudeAgent():GetAttitudeTowards(player:GetAttitudeAgent())):find('AIA_Friendly', 1, true) ~= nil
        end)
        read('hostile', function()
            return tostring(npc:GetAttitudeAgent():GetAttitudeTowards(player:GetAttitudeAgent())):find('AIA_Hostile', 1, true) ~= nil
        end)
        read('ganger', function() return npc:IsCharacterGanger() end)
        read('police', function() return npc:IsCharacterPolice() end)
        read('cyberpsycho', function() return npc:IsCharacterCyberpsycho() end)
        read('machine', function()
            local kind = npc:GetNPCType()
            for _, name in ipairs({'Android', 'Mech', 'Drone'}) do
                if kind == Enum.new('gamedataNPCType', name) then return true end
            end
            return false
        end)
        read('armed', function() return ScriptedPuppet.GetWeaponRight(npc) ~= nil end)
        f.unreadable = unreadable
        return f
    end
    return N
end

function M.new(options)
    options = options or {}
    local K, native, owned = {}, options.native or M.nativeAdapter(), options.owned or function() return false end
    local settings = {}
    for key, value in pairs(DEFAULTS) do settings[key] = options[key] or value end
    local log = options.log

    local function guarded(fn, ...)
        local ok, value = pcall(fn, ...)
        return ok and value or nil
    end

    -- Returns true, or false and the rejection reason; the plain facts follow when they were read.
    -- explicit: V tagged or aimed at this NPC, so the crowd flag alone is no reason to refuse it.
    local function eligible(npc, player, explicit)
        if npc == nil then return false, 'missing' end
        if guarded(native.valid, npc) ~= true then return false, 'invalid' end
        if guarded(owned, npc) then return false, 'companion' end
        -- A named or quest-bound game character is never a target (mod/character-catalog.lua protectedReason).
        if guarded(options.protected, npc) then return false, 'story-character' end
        local facts = guarded(native.facts, npc, player)
        if type(facts) ~= 'table' then return false, 'unreadable' end
        local ok, reason = M.verdict(facts, explicit)
        return ok, reason, facts
    end

    -- Drop any handle without native calls (world teardown). Nothing is held
    -- between requests, so this only exists for the shared teardown path.
    function K.abandon() end

    local function describe(npc, source, playerAt)
        local id = guarded(native.key, npc)
        if not id then return nil end
        return npc, {id = id, name = guarded(native.name, npc) or 'NPC', source = source,
            distance = distance(playerAt, guarded(native.position, npc))}
    end

    -- The eligible NPC whose torso is closest to the crosshair line, within the cone.
    local function inCrosshair(player, playerAt, pool)
        if type(native.crosshair) ~= 'function' then return nil end
        local ok, origin, forward = pcall(native.crosshair, player)
        if not ok or type(origin) ~= 'table' or type(forward) ~= 'table' then return nil end
        local flen = math.sqrt(forward.x^2 + forward.y^2 + forward.z^2)
        if flen < 0.01 then return nil end
        local best, bestDot
        for _, row in ipairs(pool) do
            if row.gap <= settings.aimRadius and row.at then
                local vx, vy, vz = row.at.x - origin.x, row.at.y - origin.y, row.at.z + 1.0 - origin.z
                local vlen = math.sqrt(vx * vx + vy * vy + vz * vz)
                if vlen >= 0.5 then
                    local dot = (vx * forward.x + vy * forward.y + vz * forward.z) / (vlen * flen)
                    if dot >= settings.aimCone and (not bestDot or dot > bestDot) then best, bestDot = row.npc, dot end
                end
            end
        end
        return best
    end

    local function factList(facts)
        local names = {}
        for name, value in pairs(facts or {}) do if value == true then names[#names + 1] = name end end
        table.sort(names)
        return table.concat(names, '+')
    end

    -- Returns the live target and {id, name, source, distance}, or nil.
    function K.current(player)
        if not player then return nil end
        local playerAt = guarded(native.position, player)
        local rejected, notes = {}, {}
        local function reject(reason) rejected[reason] = (rejected[reason] or 0) + 1 end

        local nearest, nearestAt, tagged, taggedAt
        local pool = {}
        local radius = math.max(settings.nearRadius, settings.taggedRadius)
        for _, npc in ipairs(guarded(native.nearby, player, radius) or {}) do
            local ok, reason, facts = eligible(npc, player, true)
            if not ok then
                reject(reason)
                -- A rejected mark is the one thing worth explaining: say who and why.
                if #notes < 3 and reason ~= 'invalid' and reason ~= 'missing' and guarded(native.tagged, npc) == true then
                    notes[#notes + 1] = 'tagged ' .. (guarded(native.name, npc) or 'NPC') .. ' rejected: ' .. reason
                        .. (facts and (' [' .. factList(facts) .. ']') or '')
                end
            else
                local at = guarded(native.position, npc)
                local gap = distance(playerAt, at)
                pool[#pool + 1] = {npc = npc, at = at, gap = gap}
                -- A crowd NPC is a target only when V marked it, never by being the closest.
                if gap <= settings.nearRadius and facts.crowd ~= true and (not nearestAt or gap < nearestAt) then
                    nearest, nearestAt = npc, gap
                end
                if gap <= settings.taggedRadius and guarded(native.tagged, npc) == true
                    and (not taggedAt or gap < taggedAt) then tagged, taggedAt = npc, gap end
            end
        end

        local choice, source
        if tagged then choice, source = tagged, 'tagged' end
        if not choice then
            local aimedNpc = guarded(native.aimed, player, settings.aimRadius)
            if aimedNpc ~= nil then
                local ok, reason, facts = eligible(aimedNpc, player, true)
                if not ok then
                    reject('aimed-' .. reason)
                    if #notes < 3 and reason ~= 'invalid' and reason ~= 'missing' then
                        notes[#notes + 1] = 'aimed ' .. (guarded(native.name, aimedNpc) or 'NPC') .. ' rejected: ' .. reason
                            .. (facts and (' [' .. factList(facts) .. ']') or '')
                    end
                elseif distance(playerAt, guarded(native.position, aimedNpc)) <= settings.aimRadius then
                    choice, source = aimedNpc, 'aimed'
                end
            end
        end
        -- The game's look-at can land on a companion standing in the line of sight: look along the crosshair instead.
        if not choice then
            local centred = inCrosshair(player, playerAt, pool)
            if centred ~= nil then choice, source = centred, 'aimed' end
        end
        if not choice and nearest then choice, source = nearest, 'nearest' end

        local npc, info
        if choice then npc, info = describe(choice, source, playerAt) end
        if log then
            local parts = {}
            for reason, count in pairs(rejected) do parts[#parts + 1] = reason .. '=' .. count end
            table.sort(parts)
            pcall(log, 'Tactic target: ' .. (info and (info.source .. ' ' .. info.name .. ' ' .. info.id
                .. ' at ' .. string.format('%.0f', info.distance) .. 'm') or 'none')
                .. (#parts > 0 and ('; skipped ' .. table.concat(parts, ' ')) or '')
                .. (#notes > 0 and ('; ' .. table.concat(notes, '; ')) or ''))
        end
        return npc, info
    end

    return K
end

return M
