-- Who is never a talk target, a nearby listener or a member of a group round (docs/CHARACTER_EDITOR.md, "Switching someone off").
--
-- Two kinds of people are left out:
--   * puppets of the game: a character nobody can see, or one that rides or drives a remote controlled toy. The game drives the toy in V's flat
--     with a hidden character who walks a loop with it at his feet, and talking near the toy got an answer from "the toy" in his voice (player report,
--     2026-10-30). Left out: an invisible or hidden look, no mesh that is shown, a seat in a toy vehicle or another remote controlled device, and the
--     records of the small deny lists below (a backstop for a puppet the other signals miss).
--   * the ordinary people the player switched off in the character editor, by the game record they are built from (mod/character-options.lua offRecord).
--     A named character the player switched off is left out through manager.profileEnabled instead.
--
-- Evaluated when a target is chosen, never per frame: the verdict about the game's puppet signals is cached per entity for CACHE_FOR seconds (a few
-- native reads once per entity, not per scan), and the switched-off check is a lookup of the cached lower-case record. Every read is guarded, and an
-- unreadable signal never excludes anybody: only positive evidence does.
local M = {version = 1}

local CACHE_FOR = 30     -- seconds a verdict about one entity is kept
local CACHE_MAX = 96     -- entities remembered; the cache starts over past this

-- Records (lower case, no table prefix) of vehicles that are remote controlled toys: whoever sits in or drives one is not a person to talk to.
M.TOY_VEHICLES = {
    trauma_team_av_model_toy = true,   -- the toy AV in V's flat (mws_wat_08, the Trauma Team prize)
    mq001_little_bombus = true,        -- the toy drone of the Aldecaldo child's story (mq001)
}
-- Records (lower case, no table prefix) of puppet characters. The signals above find the toy's driver on their own; a record is added here when
-- the log line "Talk exclusion" names one that slipped through.
M.PUPPET_RECORDS = {}
-- A vehicle or character record made of these whole words marks a toy or a puppet.
local TOY_WORDS = {toy = true, remote = true, rc = true}
local PUPPET_WORDS = {toy = true, puppet = true}
-- A look whose name says it is not drawn.
local HIDDEN_LOOKS = {invisible = true, hidden = true, nomesh = true}

local function words(text)
    local out = {}
    for part in tostring(text):lower():gmatch('[%a%d]+') do out[#out + 1] = part end
    return out
end

-- "Character.Mws_Wat_08_X" -> "mws_wat_08_x": lower case, the table prefix dropped. nil for anything that is not a name.
local function plain(text)
    if type(text) ~= 'string' then return nil end
    local name = text:lower():gsub('^%s+', ''):gsub('%s+$', '')
    name = name:gsub('^character%.', ''):gsub('^vehicle%.', '')
    if name == '' or name == 'none' then return nil end
    return name
end
M.plain = plain

local function hasWord(text, set)
    for _, part in ipairs(words(text)) do if set[part] then return true end end
    return false
end

-- options:
--   record(npc)        the record name of the character, or nil
--   parentRecord(npc)  what the character is mounted to or attached to: nil (nothing), or {record = name or nil, device = true when it is a device}
--   appearance(npc)    the name of the character's current look, or nil
--   meshes(npc)        {total = components, meshes = mesh components, shown = mesh components that are enabled}, or nil when unreadable
--   id(npc)            the entity id as text
--   offRecord(record)  true when the player switched off the people of this (lower-case) record
--   clock()            seconds (default os.clock)
--   log(line)          once per excluded entity (developer-facing; it names the record so the deny list can be extended)
function M.new(options)
    options = options or {}
    local clock = options.clock or os.clock
    local self = {cache = {}, count = 0, logged = {}, loggedCount = 0}
    local function guard(fn, ...)
        if type(fn) ~= 'function' then return nil end
        local ok, value = pcall(fn, ...)
        if ok then return value end
        return nil
    end

    -- The puppet signals of one entity: a reason, or nil. Reads only what is needed, cheapest first.
    local function puppetReason(npc, record)
        if record and (M.PUPPET_RECORDS[record] or hasWord(record, PUPPET_WORDS)) then return 'puppet record' end
        local look = guard(options.appearance, npc)
        if type(look) == 'string' and look ~= '' then
            local lowered = look:lower()
            if hasWord(lowered, HIDDEN_LOOKS) or lowered:find('invisible', 1, true) or lowered:find('no_mesh', 1, true) then return 'hidden look' end
        end
        local parent = guard(options.parentRecord, npc)
        if type(parent) == 'table' then
            local name = plain(parent.record)
            if name and (M.TOY_VEHICLES[name] or hasWord(name, TOY_WORDS)) then return 'toy vehicle' end
            if parent.device == true then return 'attached to a device' end
        end
        local read = guard(options.meshes, npc)
        if type(read) == 'table' and (tonumber(read.total) or 0) >= 1 then
            if (tonumber(read.meshes) or 0) == 0 then return 'no mesh' end
            if (tonumber(read.shown) or 0) == 0 then return 'mesh not shown' end
        end
        return nil
    end

    local function note(id, reason, record)
        if not options.log or self.logged[id] == reason then return end
        if self.loggedCount >= 48 then self.logged, self.loggedCount = {}, 0 end
        if self.logged[id] == nil then self.loggedCount = self.loggedCount + 1 end
        self.logged[id] = reason
        guard(options.log, 'Talk exclusion: ' .. reason .. ' entity=' .. tostring(id) .. ' record=' .. tostring(record))
    end

    -- Why this character is never a talk target or listener, or nil when it may be one. The game's own signals are cached per entity; the
    -- switched-off check is a lookup of the cached record.
    function self.reason(npc)
        if npc == nil then return nil end
        local id = guard(options.id, npc)
        if id == nil then return nil end
        local now = clock()
        local entry = self.cache[id]
        if entry == nil or now - entry.at >= CACHE_FOR then
            if entry == nil then
                if self.count >= CACHE_MAX then self.cache, self.count = {}, 0 end
                self.count = self.count + 1
            end
            local record = plain(guard(options.record, npc))
            entry = {at = now, record = record, why = puppetReason(npc, record)}
            self.cache[id] = entry
        end
        if entry.why then note(id, entry.why, entry.record); return entry.why end
        if entry.record and options.offRecord and guard(options.offRecord, entry.record) == true then return 'switched off' end
        return nil
    end

    function self.excluded(npc) return self.reason(npc) ~= nil end

    -- A clean slate (a caller that wants every verdict read again).
    function self.reset() self.cache, self.count = {}, 0 end

    return self
end

return M
