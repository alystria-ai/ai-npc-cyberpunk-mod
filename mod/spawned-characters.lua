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
local M = {OWN_PREFIX = 'CyberpunkConvai', LIMIT = 256, SCAN_SECONDS = 3, WATCH_LIMIT = 3, WATCH_SECONDS = 180, KNOWN_LIMIT = 12,
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
    local service = {cache = {}, count = 0, options = options, scanned = nil, watched = {}, watchedAt = nil,
        known = {}, knownBy = {}, report = {dropped = {}}}
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
    -- Characters this service has seen spawned, by entity ID only (never a handle): the once-a-second auto-connect scan and every
    -- group key press add what their queries report. A targeting query (GetTargetParts) reports only what the camera can see,
    -- so a spawned character standing behind V, or beside V outside the aim cone, is missed by every query while V faces
    -- another way (2026-10-17 live round). Remembering the ID lets a later key press or scan resolve the entity directly
    -- (Game.FindEntityByID), wherever V faces. At most KNOWN_LIMIT, the one seen longest ago leaves first; an ID that no longer
    -- resolves, or no longer reads as spawned, is forgotten. rows: {id, entity, key?, name?}; key and name are for the log.
    function service:remember(rows)
        local now = clock()
        for _, row in ipairs(type(rows) == 'table' and rows or {}) do
            if row.id ~= nil and type(row.entity) == 'string' then
                local entry = self.knownBy[row.entity]
                if entry then
                    entry.id, entry.at = row.id, now
                    if row.key then entry.key, entry.name = row.key, row.name or entry.name end
                else
                    if #self.known >= M.KNOWN_LIMIT then
                        local oldest = 1
                        for index, other in ipairs(self.known) do if other.at < self.known[oldest].at then oldest = index end end
                        self.knownBy[self.known[oldest].entity] = nil
                        table.remove(self.known, oldest)
                    end
                    entry = {id = row.id, entity = row.entity, key = row.key, name = row.name, at = now}
                    self.known[#self.known + 1] = entry
                    self.knownBy[row.entity] = entry
                end
            end
        end
    end
    local function forget(self, entry)
        self.knownBy[entry.entity] = nil
        for index, other in ipairs(self.known) do
            if other == entry then table.remove(self.known, index); break end
        end
    end
    -- The remembered characters that are here now and within radius of V: rows {npc, id, entity, distance, key, name,
    -- source = 'remembered'}, nearest first, plus the list of those left out with the reason ('gone', 'dead', 'not-spawned',
    -- 'detached', 'out-of-range', each with its distance when known). `present` is a set of entity hashes the caller already has;
    -- accept(entry), when given, skips an entry before anything is resolved. One FindEntityByID, one attachment check and one
    -- position read per remembered character, and nothing at all while none is remembered. Never asked per frame.
    function service:recall(player, radius, present, accept)
        local rows, dropped = {}, {}
        if #self.known == 0 or not player then return rows, dropped end
        local placed, origin = pcall(function() return player:GetWorldPosition() end)
        if not placed or origin == nil then return rows, dropped end
        local entries = {}
        for _, entry in ipairs(self.known) do entries[#entries + 1] = entry end
        for _, entry in ipairs(entries) do
            if not (present and present[entry.entity]) and (accept == nil or accept(entry)) then
                local found, npc = pcall(self.options.find or M.find, entry.id)
                local reason, distance
                if not found or npc == nil then reason = 'gone'
                else
                    local asked, fact = pcall(function()
                        if npc:IsDeadNoStatPool() then return {reason = 'dead'} end
                        if not npc:IsAttached() then return {reason = 'detached'} end
                        if self:kind(npc) ~= 'spawned' then return {reason = 'not-spawned'} end
                        local at = npc:GetWorldPosition()
                        return {distance = math.sqrt((at.x - origin.x)^2 + (at.y - origin.y)^2 + (at.z - origin.z)^2)}
                    end)
                    if not asked or type(fact) ~= 'table' then reason = 'gone'
                    elseif fact.reason then reason = fact.reason
                    elseif fact.distance > radius then reason, distance = 'out-of-range', fact.distance
                    else
                        rows[#rows + 1] = {npc = npc, id = entry.id, entity = entry.entity, distance = fact.distance,
                            key = entry.key, name = entry.name, source = 'remembered'}
                    end
                end
                if reason then
                    dropped[#dropped + 1] = {entity = entry.entity, key = entry.key, reason = reason, distance = distance}
                    if reason == 'gone' or reason == 'dead' or reason == 'not-spawned' then forget(self, entry) end
                end
            end
        end
        table.sort(rows, function(a, b)
            if a.distance == b.distance then return a.entity < b.entity end
            return a.distance < b.distance
        end)
        return rows, dropped
    end
    -- The spawned characters within radius of V, nearest first: {npc, id, entity, distance, source}. Three sources, in this
    -- order of trust: 'scan' (one targeting query, answered again for SCAN_SECONDS), 'native' (`extra`: NPCs the caller already
    -- holds from its own native query, the talk-target candidates of the same key press) and 'remembered' (an ID seen earlier,
    -- resolved now: it counts wherever V is facing). Never asked per frame: a group key press, a combat start or a pickup.
    -- service.report.dropped says who was left out and why, with distances, for the probe log.
    function service:nearby(player, radius, extra)
        local rows, dropped = {}, {}
        self.report = {dropped = dropped}
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
                        return {npc = npc, id = id, entity = tostring(id.hash), source = 'scan',
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
        local present = {}
        for _, row in ipairs(cached.rows) do
            if row.distance <= radius then rows[#rows + 1] = row; present[row.entity] = true
            else dropped[#dropped + 1] = {entity = row.entity, reason = 'out-of-range', distance = row.distance} end
        end
        local placed, origin = pcall(function() return player:GetWorldPosition() end)
        local added = false
        if placed and type(extra) == 'table' then
            for _, npc in ipairs(extra) do
                local good, row = pcall(function()
                    local id = npc:GetEntityID()
                    local key = tostring(id.hash)
                    if present[key] or not npc:IsAttached() or npc:IsDeadNoStatPool() or self:kind(npc) ~= 'spawned' then return nil end
                    local at = npc:GetWorldPosition()
                    local distance = math.sqrt((at.x - origin.x)^2 + (at.y - origin.y)^2 + (at.z - origin.z)^2)
                    return {npc = npc, id = id, entity = key, distance = distance, source = 'native'}
                end)
                if good and row then
                    if row.distance > radius then dropped[#dropped + 1] = {entity = row.entity, reason = 'out-of-range', distance = row.distance}
                    else rows[#rows + 1] = row; present[row.entity] = true; added = true end
                end
            end
        end
        -- Remember what the queries reported, then add the characters remembered from earlier that no query reported now.
        self:remember(rows)
        local recalled, left = self:recall(player, radius, present)
        for _, row in ipairs(recalled) do rows[#rows + 1] = row; added = true end
        for _, item in ipairs(left) do dropped[#dropped + 1] = item end
        if added then
            table.sort(rows, function(a, b)
                if a.distance == b.distance then return a.entity < b.entity end
                return a.distance < b.distance
            end)
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
    function service:reset()
        self.cache, self.count, self.scanned, self.watched, self.watchedAt = {}, 0, nil, {}, nil
        self.known, self.knownBy, self.report = {}, {}, {dropped = {}}
    end
    return service
end

return M
