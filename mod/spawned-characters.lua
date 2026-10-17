-- Characters that another mod or a spawner created (docs/SPAWNED_CHARACTERS.md).
--
-- Recognition is generic and engine-level: an NPC that the shared dynamic entity system manages. The game itself never
-- creates characters through that system (story, quest, community and crowd actors come from the world and its spawners),
-- only mods do. Our own spawns carry tags that start with OWN_PREFIX and are excluded. No other mod's tag, record prefix,
-- template path or name is ever matched: a spawn from any spawner that uses the system is recognised the same way.
--
-- What such a character gets is decided in mod/init.lua (convaiWorldPolicy.spawned, profileIdentity): a conversation the
-- player starts, with its own roster profile, voice and memory, a speaking face and eye contact while it talks. Nothing of
-- ours moves, seats, equips, follows, mounts, hides or deletes it: the mod that created it owns its body.
--
-- Read on demand (a conversation start, the talk target's look at most 5 times a second), cached per entity, never per frame.
--
-- Phase 2 (group chat, battle and loot witnesses) needs to FIND such characters, which no list of ours can do: service:nearby
-- runs one targeting query for the NPCs around V and keeps only the spawned ones. It is asked on an event (a group key press, a
-- combat start, a pickup), the answer is reused for SCAN_SECONDS, and nothing runs without such an event. Reaction witnesses
-- are then remembered by entity ID only (service:watch), at most WATCH_LIMIT of them, for WATCH_SECONDS.
local M = {OWN_PREFIX = 'CyberpunkConvai', LIMIT = 256, SCAN_SECONDS = 3, WATCH_LIMIT = 3, WATCH_SECONDS = 180,
    -- The tags our NPC spawns carry, checked by name before any tag list is read (companion copies, holocall pictures).
    OWN_TAGS = {'CyberpunkConvaiCompanion', 'CyberpunkConvaiHolocall'}}

local function ownTag(text)
    return type(text) == 'string' and text:sub(1, #M.OWN_PREFIX) == M.OWN_PREFIX
end

-- Pure: 'ours', 'spawned' or nil from plain data. info = {managed = bool, own = bool, tags = {string...}, quest = bool}.
--   managed  the dynamic entity system manages this entity (it was created at runtime by a mod)
--   own      it carries one of OWN_TAGS
--   tags     its tag names as strings, when they could be read
--   quest    a quest has marked it (a quest mod's actor): the usual rules for game characters apply instead
function M.classify(info)
    if type(info) ~= 'table' or info.managed ~= true then return nil end
    if info.own == true then return 'ours' end
    for _, tag in ipairs(type(info.tags) == 'table' and info.tags or {}) do
        if ownTag(tag) then return 'ours' end
    end
    if info.quest == true then return nil end
    return 'spawned'
end

local function nameText(value)
    if type(value) == 'string' then return value end
    local ok, text = pcall(function() return Game.NameToString(value) end)
    if ok and type(text) == 'string' then return text end
    return nil
end

-- The native reads for one NPC, or nil when the dynamic entity system cannot answer yet (not cached, asked again later).
function M.read(npc)
    local system = Game.GetDynamicEntitySystem()
    if not system or not system:IsReady() then return nil end
    local id = npc:GetEntityID()
    if not system:IsManaged(id) then return {managed = false} end
    local info = {managed = true, tags = {}}
    for _, tag in ipairs(M.OWN_TAGS) do
        if system:IsTagged(id, CName.new(tag)) then info.own = true; return info end
    end
    local listed, tags = pcall(function() return system:GetTags(id) end)
    if listed and type(tags) == 'table' then
        for _, tag in ipairs(tags) do info.tags[#info.tags + 1] = nameText(tag) end
    end
    local marked, quest = pcall(function() return npc:IsQuest() end)
    info.quest = marked and quest == true
    return info
end

-- True while the dynamic entity system can answer (Codeware present and loaded). Without it nothing is ever spawned.
function M.ready()
    local ok, system = pcall(function() return Game.GetDynamicEntitySystem() end)
    if not ok or not system then return false end
    local asked, ready = pcall(function() return system:IsReady() end)
    return asked and ready == true
end

-- One targeting query: the NPCs within radius of V (the query the auto-connect scan makes). Plain entity list, no filtering.
function M.scan(player, radius)
    local query = TargetSearchQuery.new()
    query.searchFilter = Game['TSF_NPC;']()
    query.maxDistance = radius
    query.includeSecondaryTargets = false
    query.filterObjectByDistance = true
    query.ignoreInstigator = true
    query.testedSet = Enum.new('TargetingSet', 'Complete')
    local _, parts = Game.GetTargetingSystem():GetTargetParts(player, query)
    local found, seen = {}, {}
    for _, part in ipairs(parts or {}) do
        local component = TS_TargetPartInfo.GetComponent(part)
        local entity = component and component:GetEntity()
        if entity and entity:IsNPC() then
            local id = tostring(entity:GetEntityID().hash)
            if not seen[id] then seen[id] = true; found[#found + 1] = entity end
        end
    end
    return found
end

function M.find(id) return Game.FindEntityByID(id) end

-- options.read(npc) replaces M.read (tests); options.ready(), options.scan(player, radius), options.find(id) and
-- options.clock() replace the native ones (tests). The cache maps an entity hash to its kind, or false for "neither".
function M.new(options)
    options = type(options) == 'table' and options or {}
    local service = {cache = {}, count = 0, options = options, scanned = nil, watched = {}, watchedAt = nil}
    local function clock() return (options.clock or os.clock)() end
    function service:kind(npc)
        if not npc then return nil end
        local ok, key = pcall(function() return tostring(npc:GetEntityID().hash) end)
        if not ok or type(key) ~= 'string' then return nil end
        local cached = self.cache[key]
        if cached ~= nil then return cached or nil end
        local read, info = pcall(self.options.read or M.read, npc)
        if not read or type(info) ~= 'table' then return nil end
        local kind = M.classify(info)
        if self.count >= M.LIMIT then self.cache, self.count = {}, 0 end
        self.cache[key], self.count = kind or false, self.count + 1
        return kind
    end
    -- True for a character another mod or a spawner created (not ours, not a quest's).
    function service:is(npc) return self:kind(npc) == 'spawned' end
    -- True while the system that recognises spawned characters can answer; the callers skip every scan without it.
    function service:available() return (self.options.ready or M.ready)() == true end
    -- The spawned characters within radius of V, nearest first: {npc, id, entity, distance}. One scan answers again for
    -- SCAN_SECONDS. Never asked per frame: a group key press, a combat start or a pickup.
    function service:nearby(player, radius)
        local rows = {}
        if not player or not self:available() then return rows end
        local now = clock()
        local cached = self.scanned
        if not cached or now < cached.at or now - cached.at > M.SCAN_SECONDS or cached.radius < radius then
            cached = {at = now, radius = radius, rows = {}}
            local scanned, found = pcall(self.options.scan or M.scan, player, radius)
            local placed, origin = pcall(function() return player:GetWorldPosition() end)
            if scanned and placed and type(found) == 'table' then
                for _, npc in ipairs(found) do
                    local good, row = pcall(function()
                        if not npc:IsAttached() or npc:IsDeadNoStatPool() or self:kind(npc) ~= 'spawned' then return nil end
                        local at, id = npc:GetWorldPosition(), npc:GetEntityID()
                        return {npc = npc, id = id, entity = tostring(id.hash),
                            distance = math.sqrt((at.x - origin.x)^2 + (at.y - origin.y)^2 + (at.z - origin.z)^2)}
                    end)
                    if good and row then cached.rows[#cached.rows + 1] = row end
                end
                table.sort(cached.rows, function(a, b)
                    if a.distance == b.distance then return a.entity < b.entity end
                    return a.distance < b.distance
                end)
            end
            self.scanned = cached
        end
        for _, row in ipairs(cached.rows) do
            if row.distance <= radius then rows[#rows + 1] = row end
        end
        return rows
    end
    -- Remember the characters that may speak in a battle or loot reaction: identity facts the caller resolved
    -- ({id, entity, profileKey, name, bodyType}), no entity handle, at most WATCH_LIMIT, for WATCH_SECONDS.
    function service:watch(rows)
        local kept = {}
        for _, row in ipairs(type(rows) == 'table' and rows or {}) do
            if #kept >= M.WATCH_LIMIT then break end
            kept[#kept + 1] = {id = row.id, entity = row.entity, profileKey = row.profileKey, name = row.name,
                bodyType = row.bodyType}
        end
        self.watched, self.watchedAt = kept, #kept > 0 and clock() or nil
    end
    -- The watched characters that still exist, resolved now (attached, alive): the same rows plus npc. Nothing is asked
    -- while the list is empty or has expired; those that are gone are dropped.
    function service:watching()
        if #self.watched == 0 then return {} end
        local now = clock()
        if not self.watchedAt or now < self.watchedAt or now - self.watchedAt > M.WATCH_SECONDS then
            self.watched, self.watchedAt = {}, nil
            return {}
        end
        local rows, kept = {}, {}
        for _, row in ipairs(self.watched) do
            local found, npc = pcall(self.options.find or M.find, row.id)
            local alive = false
            if found and npc ~= nil then
                local asked, here = pcall(function() return npc:IsAttached() and not npc:IsDeadNoStatPool() end)
                alive = asked and here == true
            end
            if alive then
                kept[#kept + 1] = row
                rows[#rows + 1] = {npc = npc, id = row.id, entity = row.entity, profileKey = row.profileKey,
                    name = row.name, bodyType = row.bodyType}
            end
        end
        self.watched = kept
        if #kept == 0 then self.watchedAt = nil end
        return rows
    end
    -- A world change: entity hashes from the old session mean nothing now.
    function service:reset() self.cache, self.count, self.scanned, self.watched, self.watchedAt = {}, 0, nil, {}, nil end
    return service
end

return M
