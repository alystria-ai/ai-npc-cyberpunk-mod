-- The target for companion tactics (Fight), chosen from the game's own target
-- marking. Nothing is bound or tagged by this mod. When a companion request is
-- admitted the choice is, in order:
--   1. the best NPC V tagged in the scanner (focus mode) within taggedRadius
--      (100 m), ranked as described below; even a neutral, civilian or crowd NPC
--      can be taken when nothing better is tagged: the tag is V's decision.
--      A named, quest-bound or scene-controlled character is never taken.
--      Companions, children, vendors, invulnerable NPCs and friendly non-police
--      NPCs are never taken;
--   2. the NPC V is looking at (look-at, then closest to crosshair) within
--      aimRadius, when it shows combat evidence (see M.verdict);
--   3. the closest NPC within nearRadius that is already hostile to V.
-- Combat evidence means a gang member, police, corpo or military security,
-- cyberpsycho, drone, mech, android, an NPC carrying a weapon, or one hostile to
-- V. Civilians, children, vendors, named or quest-bound characters, invulnerable
-- and story-controlled NPCs and friendly non-police NPCs fail steps 2 and 3. A
-- crowd flag alone does not disqualify an NPC that was tagged or aimed at.
-- Only plain identities and one live handle are returned.
--
-- Which tagged NPC (2026-10-17, after a live test with two tags where the nearer one,
-- an ordinary bystander, was taken and never fought): every tagged NPC that passes
-- M.taggedVerdict is ranked, not just the nearest. Best first: (1) one that is hostile
-- to V or already in combat, then one that can fight (gang, police, cyberpsycho,
-- machine, armed), then any other (M.tier); (2) within a tier the NPC V is aiming at;
-- (3) then the most recently tagged (the game's tag list puts the newest tag first,
-- focusModeTagging.script RegisterObjectToBlackboard: Insert( 0, target ));
-- (4) then the nearest. A companion and a named, quest-bound or scene-controlled
-- character are never a target. The reason is logged and returned as info.why.
--
-- Where the candidates come from (2026-10-17, after a live test in which five
-- requests found only the companion herself): the game keeps every object V tagged
-- in the global blackboard TaggedObjectsList (FocusModeTaggingSystem, script dump
-- focusModeTagging.script), so that list is read first and an NPC on it is a
-- candidate whether or not the targeting search reports it. The targeting search
-- (GetTargetParts, tested set Complete) is only the second source and supplies the
-- untagged NPCs near V for the aimed and nearest steps; it evidently does not
-- return every NPC in range. Both are read once per request, never per frame.
--
-- The tag read tries each known reader and reports which one answered, or the
-- error. IsTaggedinFocusMode is the game's own spelling (GameObject asks the
-- ScanningController, the same place the tagging system writes to). Each request
-- writes one candidates line: how many NPCs were found within the tag radius,
-- how many tag reads failed, how many the tag list held and how many of those the
-- search had missed, and the nearest NPCs with tag=yes / no / err, so a tag that
-- never counted is visible in probe.log.
local M = {}
local DEFAULTS = {aimRadius = 30, nearRadius = 50, taggedRadius = 100, aimCone = 0.9781, listMax = 6}
-- GameObject tag readers, in the order tried. The first that answers with a boolean is used.
local TAG_METHODS = {'IsTaggedinFocusMode', 'IsTaggedInFocusMode'}

local function distance(a, b)
    if not a or not b then return math.huge end
    return math.sqrt((a.x - b.x)^2 + (a.y - b.y)^2 + (a.z - b.z)^2)
end

-- Pure decision over plain facts (see nativeAdapter.facts) for an aimed or the
-- nearest NPC. Returns true and 'combatant', or false and the reason the NPC is
-- not a target. A crowd NPC is rejected as 'crowd' only when explicit is not
-- true; an aimed crowd NPC is judged on the same evidence as anyone else.
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

-- Pure decision for an NPC V tagged in the scanner. No combat evidence is
-- needed: a neutral, civilian or crowd NPC is a target because V marked it. A
-- named or quest-bound character (protected, by the character catalog) or a
-- scene-controlled one (story) is never taken, hostile or not: a fight with one
-- can break a quest.
function M.taggedVerdict(facts, protected)
    local f = facts or {}
    if f.companion then return false, 'companion' end
    if f.children then return false, 'children' end
    if f.vendor then return false, 'vendor' end
    if f.invulnerable then return false, 'invulnerable' end
    if protected then return false, 'story-character' end
    if f.story then return false, 'story-controlled' end
    if f.friendly and not f.police then return false, 'friendly' end
    return true, 'tagged'
end

-- How likely a tagged NPC is to fight back, from the same plain facts: 1 hostile to V or already in combat,
-- 2 able to fight (gang, police, cyberpsycho, machine, armed), 3 anyone else (a civilian, a bystander). Returns the
-- number and its name.
local TIER_NAMES = {'hostile', 'fighter', 'bystander'}
function M.tier(facts)
    local f = facts or {}
    local tier = 3
    if f.hostile or f.combat then tier = 1
    elseif not f.civilian and (f.ganger or f.police or f.cyberpsycho or f.machine or f.armed) then tier = 2 end
    return tier, TIER_NAMES[tier]
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
    -- The game's own tag, set with the scanner (focus mode). Returns true or false
    -- and the reader that answered; raises with the last error when no reader worked.
    function N.tagRead(npc)
        local failure
        for _, method in ipairs(TAG_METHODS) do
            local ok, value = pcall(function() return npc[method](npc) end)
            if ok and type(value) == 'boolean' then return value, method end
            failure = ok and (method .. ' returned ' .. type(value)) or tostring(value)
        end
        error(failure or 'no tag reader')
    end
    function N.hostile(npc, player)
        return tostring(npc:GetAttitudeAgent():GetAttitudeTowards(player:GetAttitudeAgent())):find('AIA_Hostile', 1, true) ~= nil
    end
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
    -- Every NPC on the game's own tagged-object list (the blackboard the focus-mode tagging system keeps), anywhere in the
    -- world. Raises when the blackboard or the variant cannot be read; an empty or invalid list is an empty table.
    function N.taggedList()
        local defs = Game.GetAllBlackboardDefs()
        local board = Game.GetBlackboardSystem():Get(defs.TaggedObjectsList)
        local variant = board:GetVariant(defs.TaggedObjectsList.taggedObjectsList)
        local list = variant ~= nil and FromVariant(variant) or nil
        local result = {}
        for _, object in ipairs(type(list) == 'table' and list or {}) do
            if object ~= nil and object:IsNPC() then result[#result + 1] = object end
        end
        return result
    end
    -- Plain facts about one NPC. A signal that errors is left nil (and listed in
    -- facts.unreadable); an unreadable exclusion never blocks a target, but an
    -- aimed or nearest target still needs positive evidence of combat capability.
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
        read('hostile', function() return N.hostile(npc, player) end)
        read('combat', function() return NPCPuppet.IsInCombat(npc) == true end)
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

    -- Tag state of one NPC: true, false, or nil with the error text when it could not be read.
    local function readTag(npc)
        local reader = native.tagRead or native.tagged
        if type(reader) ~= 'function' then return nil, 'no tag reader' end
        local ok, state, how = pcall(reader, npc)
        if not ok then return nil, (tostring(state):gsub('^.-:%d+:%s*', ''):gsub('%s+', ' '):sub(1, 80)) end
        if type(state) ~= 'boolean' then return nil, 'tag read returned ' .. type(state) end
        return state, how
    end

    -- Facts for one NPC, or false and the reason it cannot be considered at all.
    local function inspect(npc, player)
        if npc == nil then return false, 'missing' end
        if guarded(native.valid, npc) ~= true then return false, 'invalid' end
        if guarded(owned, npc) then return false, 'companion' end
        local facts = guarded(native.facts, npc, player)
        if type(facts) ~= 'table' then return false, 'unreadable' end
        return facts
    end

    -- Aimed or nearest NPC: true, or false and the rejection reason; the plain facts follow when read.
    -- explicit: V aimed at this NPC, so the crowd flag alone is no reason to refuse it.
    local function eligible(npc, player, explicit)
        local facts, why = inspect(npc, player)
        if not facts then return false, why end
        -- A named or quest-bound game character is never an aimed or nearest target (mod/character-catalog.lua protectedReason).
        if guarded(options.protected, npc) then return false, 'story-character', facts end
        local ok, reason = M.verdict(facts, explicit)
        return ok, reason, facts
    end

    -- Tagged NPC: true, or false and the reason.
    local function taggedEligible(npc, player)
        local facts, why = inspect(npc, player)
        if not facts then return false, why end
        local protected = guarded(options.protected, npc) == true
        local ok, reason = M.taggedVerdict(facts, protected)
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

    -- The NPCs whose torso is near the crosshair line, within the cone, best first.
    local function crosshairOrder(player, rows)
        if type(native.crosshair) ~= 'function' then return {} end
        local ok, origin, forward = pcall(native.crosshair, player)
        if not ok or type(origin) ~= 'table' or type(forward) ~= 'table' then return {} end
        local flen = math.sqrt(forward.x^2 + forward.y^2 + forward.z^2)
        if flen < 0.01 then return {} end
        local ordered = {}
        for _, row in ipairs(rows) do
            if row.gap <= settings.aimRadius and row.at then
                local vx, vy, vz = row.at.x - origin.x, row.at.y - origin.y, row.at.z + 1.0 - origin.z
                local vlen = math.sqrt(vx * vx + vy * vy + vz * vz)
                if vlen >= 0.5 then
                    local dot = (vx * forward.x + vy * forward.y + vz * forward.z) / (vlen * flen)
                    if dot >= settings.aimCone then ordered[#ordered + 1] = {npc = row.npc, dot = dot} end
                end
            end
        end
        table.sort(ordered, function(a, b) return a.dot > b.dot end)
        return ordered
    end

    local function factList(facts)
        local names = {}
        for name, value in pairs(facts or {}) do if value == true then names[#names + 1] = name end end
        table.sort(names)
        return table.concat(names, '+')
    end

    local function tagWord(row)
        if row.tag == true then return 'yes' end
        if row.tag == false then return 'no' end
        return 'err'
    end

    -- One line per request: what was found and what each tag read said.
    local function logCandidates(rows, failures, how, tagList)
        if not log then return end
        local tagged = 0
        for _, row in ipairs(rows) do if row.tag == true then tagged = tagged + 1 end end
        local parts, listed = {}, 0
        -- Tagged NPCs first, then unreadable ones (what this line exists for), then the nearest.
        for _, pass in ipairs({'yes', 'err', 'rest'}) do
            for _, row in ipairs(rows) do
                if listed < settings.listMax and not row.listed and (pass == 'rest' or tagWord(row) == pass) then
                    row.listed, listed = true, listed + 1
                    parts[#parts + 1] = (guarded(native.name, row.npc) or 'NPC') .. ' ' .. string.format('%.0f', row.gap)
                        .. 'm tag=' .. tagWord(row)
                end
            end
        end
        local extra = {}
        if failures.count > 0 then extra[#extra + 1] = failures.count .. ' tag reads failed (' .. tostring(failures.first) .. ')' end
        if how then extra[#extra + 1] = 'via ' .. how end
        if tagList and tagList.error then extra[#extra + 1] = 'tag list unreadable (' .. tagList.error .. ')'
        elseif tagList and tagList.count > 0 then
            extra[#extra + 1] = 'tag list ' .. tagList.count .. ' (' .. tagList.missed .. ' missed by the search, ' .. tagList.far .. ' beyond ' .. settings.taggedRadius .. 'm)'
        end
        pcall(log, 'Tactic candidates: ' .. #rows .. ' NPCs within ' .. settings.taggedRadius .. 'm, ' .. tagged .. ' tagged'
            .. (#extra > 0 and (', ' .. table.concat(extra, ', ')) or '')
            .. (#parts > 0 and ('; ' .. table.concat(parts, '; ')) or ''))
    end

    -- Returns the live target and {id, name, source, distance}, or nil.
    function K.current(player)
        if not player then return nil end
        local playerAt = guarded(native.position, player)
        local rejected, notes = {}, {}
        local function reject(reason) rejected[reason] = (rejected[reason] or 0) + 1 end
        local function note(prefix, npc, reason, facts)
            if #notes < 3 and reason ~= 'invalid' and reason ~= 'missing' then
                notes[#notes + 1] = prefix .. ' ' .. (guarded(native.name, npc) or 'NPC') .. ' rejected: ' .. reason
                    .. (facts and (' [' .. factList(facts) .. ']') or '')
            end
        end

        -- Every NPC the game reports within the tag radius, nearest first, each with its tag read.
        local rows, failures, via = {}, {count = 0}, nil
        local radius = math.max(settings.nearRadius, settings.taggedRadius)
        for _, npc in ipairs(guarded(native.nearby, player, radius) or {}) do
            local at = guarded(native.position, npc)
            local tag, how = readTag(npc)
            if tag == nil then
                failures.count = failures.count + 1
                failures.first = failures.first or how
            elseif how and not via then via = how end
            rows[#rows + 1] = {npc = npc, at = at, gap = distance(playerAt, at), tag = tag}
        end
        -- The game's tagged list: a tagged NPC the targeting search did not report is a candidate all the same.
        local tagList = {count = 0, missed = 0, far = 0}
        if type(native.taggedList) == 'function' then
            local found = {}
            for _, row in ipairs(rows) do local key = guarded(native.key, row.npc); if key then found[key] = row end end
            local ok, list = pcall(native.taggedList, player)
            if ok and type(list) == 'table' then
                for _, npc in ipairs(list) do
                    tagList.count = tagList.count + 1
                    local key = guarded(native.key, npc)
                    local row = key and found[key]
                    if row then
                        -- An unreadable tag read is settled by the list; a read that says no outweighs a stale list entry.
                        if row.tag == nil then row.tag = true end
                        -- The list holds the newest tag first: its position is how recently V tagged this NPC.
                        row.order = row.order or tagList.count
                    else
                        local at = guarded(native.position, npc)
                        local gap = distance(playerAt, at)
                        if gap > settings.taggedRadius then
                            tagList.far = tagList.far + 1
                        else
                            tagList.missed = tagList.missed + 1
                            local tag, how = readTag(npc)
                            if tag == nil then tag = true end
                            if tag then
                                rows[#rows + 1] = {npc = npc, at = at, gap = gap, tag = true, order = tagList.count}
                                if key then found[key] = rows[#rows] end
                            end
                        end
                    end
                end
            else
                tagList.error = (tostring(list):gsub('^.-:%d+:%s*', ''):gsub('%s+', ' '):sub(1, 80))
            end
        end
        table.sort(rows, function(a, b) return a.gap < b.gap end)
        logCandidates(rows, failures, via, tagList)

        local choice, source, why
        -- 1. Tagged: every NPC V marked that passes the identity rules, ranked (M.tier, aimed, newest tag, nearest).
        local candidates = {}
        for _, row in ipairs(rows) do
            if row.tag == true and row.gap <= settings.taggedRadius then
                local ok, reason, facts = taggedEligible(row.npc, player)
                if ok then
                    row.tier, row.tierName = M.tier(facts)
                    row.facts = facts
                    candidates[#candidates + 1] = row
                else
                    reject(reason)
                    note('tagged', row.npc, reason, facts)
                end
            end
        end
        if #candidates > 0 then
            -- The NPC V is aiming at only matters when there is a choice. A look-at that lands on a companion is
            -- replaced by the NPC nearest the crosshair line.
            local aimedKey
            if #candidates > 1 then
                local aimedNpc = guarded(native.aimed, player, settings.aimRadius)
                aimedKey = aimedNpc ~= nil and guarded(native.key, aimedNpc) or nil
                local isCandidate = false
                for _, row in ipairs(candidates) do if aimedKey and guarded(native.key, row.npc) == aimedKey then isCandidate = true end end
                if not isCandidate then
                    aimedKey = nil
                    for _, ordered in ipairs(crosshairOrder(player, candidates)) do
                        aimedKey = guarded(native.key, ordered.npc); break
                    end
                end
            end
            for _, row in ipairs(candidates) do row.aimed = aimedKey ~= nil and guarded(native.key, row.npc) == aimedKey end
            table.sort(candidates, function(a, b)
                if a.tier ~= b.tier then return a.tier < b.tier end
                if a.aimed ~= b.aimed then return a.aimed end
                local ao, bo = a.order or math.huge, b.order or math.huge
                if ao ~= bo then return ao < bo end
                return a.gap < b.gap
            end)
            local best, runnerUp = candidates[1], candidates[2]
            choice, source = best.npc, 'tagged'
            if not runnerUp then why = 'the only valid tag'
            elseif best.tier ~= runnerUp.tier then why = best.tierName .. ' over ' .. runnerUp.tierName
            elseif best.aimed ~= runnerUp.aimed then why = 'aimed at'
            elseif (best.order or math.huge) ~= (runnerUp.order or math.huge) then why = 'tagged most recently'
            else why = 'nearest' end
            if log then
                -- Best first, then what each one is (the plain facts), so a name like "NC Resident" can be told apart
                -- from a civilian record in the next log.
                local seen, who = {}, {}
                for _, row in ipairs(candidates) do
                    local name = guarded(native.name, row.npc) or 'NPC'
                    seen[#seen + 1] = name .. ' ' .. row.tierName
                        .. (row.aimed and ' aimed' or '') .. (row.order and (' tag#' .. row.order) or '')
                        .. ' ' .. string.format('%.0f', row.gap) .. 'm'
                    who[#who + 1] = name .. ' [' .. factList(row.facts) .. ']'
                end
                pcall(log, 'Tactic tagged choice: ' .. table.concat(seen, ' > ') .. '; facts: ' .. table.concat(who, ', '))
            end
        end

        -- 2. Aimed, with combat evidence.
        if not choice then
            local aimedNpc = guarded(native.aimed, player, settings.aimRadius)
            if aimedNpc ~= nil then
                local ok, reason, facts = eligible(aimedNpc, player, true)
                if not ok then
                    reject('aimed-' .. reason)
                    note('aimed', aimedNpc, reason, facts)
                elseif distance(playerAt, guarded(native.position, aimedNpc)) <= settings.aimRadius then
                    choice, source = aimedNpc, 'aimed'
                end
            end
        end
        -- The game's look-at can land on a companion standing in the line of sight: look along the crosshair instead.
        if not choice then
            for _, candidate in ipairs(crosshairOrder(player, rows)) do
                local ok, reason = eligible(candidate.npc, player, true)
                if ok then choice, source = candidate.npc, 'aimed'; break end
                reject('aimed-' .. reason)
            end
        end

        -- 3. The closest NPC already hostile to V.
        if not choice then
            for _, row in ipairs(rows) do
                if row.gap > settings.nearRadius then break end
                local hostile = true
                if type(native.hostile) == 'function' then hostile = guarded(native.hostile, row.npc, player) == true end
                if hostile then
                    local ok, reason, facts = eligible(row.npc, player, true)
                    if ok and facts.hostile == true then choice, source = row.npc, 'nearest'; break end
                    if not ok then reject(reason) end
                end
            end
        end

        local npc, info
        if choice then npc, info = describe(choice, source, playerAt) end
        if info then info.why = why or (source == 'aimed' and 'aimed at, combat evidence' or 'nearest hostile to V') end
        if log then
            local parts = {}
            for reason, count in pairs(rejected) do parts[#parts + 1] = reason .. '=' .. count end
            table.sort(parts)
            pcall(log, 'Tactic target: ' .. (info and (info.source .. ' ' .. info.name .. ' ' .. info.id
                .. ' at ' .. string.format('%.0f', info.distance) .. 'm, because ' .. info.why) or 'none')
                .. (#parts > 0 and ('; skipped ' .. table.concat(parts, ' ')) or '')
                .. (#notes > 0 and ('; ' .. table.concat(notes, '; ')) or ''))
        end
        return npc, info
    end

    return K
end

return M
