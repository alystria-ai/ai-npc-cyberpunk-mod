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
local M = {OWN_PREFIX = 'CyberpunkConvai', LIMIT = 256,
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

-- options.read(npc) replaces M.read (tests). The cache maps an entity hash to its kind, or false for "neither".
function M.new(options)
    options = type(options) == 'table' and options or {}
    local service = {cache = {}, count = 0, options = options}
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
    -- A world change: entity hashes from the old session mean nothing now.
    function service:reset() self.cache, self.count = {}, 0 end
    return service
end

return M
