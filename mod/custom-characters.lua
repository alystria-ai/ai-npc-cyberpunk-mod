-- Characters the player made in the character editor (docs/CHARACTER_EDITOR.md, "Your own characters"): which in-game character is which.
--
-- The conversation service writes runtime/custom-characters.json (replaced in place, shipped empty): for each character a key, a name, a gender
-- and the rule that finds it, record names and display names. This module reads it into two tables, one by the game's id of a record and one by
-- display name, and answers "is this one of them?" with two table lookups. Nothing here runs per frame and nothing polls:
--   - the file is read when the mod loads, and again when somebody is about to be talked to, if that is due (refresh): at most every 3 seconds,
--     and only while there are characters or the player opened the editor in the last two hours (watch). With none of that, a talk key press
--     costs no file read at all.
--   - match() is asked wherever a character's profile is resolved (character-catalog.lua resolve); with no character made it is one comparison.
--   - a record is compared by its id (hash and length), never by the whole id string: the game's text of an id carries the record's readable
--     name only when the scripting layer knows that name at the moment it is printed (`ToTweakDBID{ hash = 0x9ECAADC2, length = 28 --[[ Character.X --]] }`).
--     A record another mod creates while the game starts (a spawn menu's or a record-cloning mod's copy) has no readable name yet when this
--     file is first read, so the same record printed later, from the spawned person, did not compare equal (idKey).
--
-- A character is used only while Mistral or the Local AI is answering (`enabled`): Convai has no character for it. Otherwise match() answers
-- nothing, so the game treats the person as an ordinary one, and remembers the character it would have been (takeSkipped) so the talk key
-- can say so once. The provider is asked at load and at each talk key press (checkProvider), never from match(): looking at a character (the
-- gaze poll, the nearby scan) only compares names and reads nothing.
local M = {version = 1}

local FILE = 'runtime/custom-characters.json'
local REFRESH_EVERY = 3        -- seconds between two reads of the file
local WATCH_FOR = 7200         -- seconds the file is watched after the editor was opened

local function normalized(value)
    local text = tostring(value or ''):lower():gsub('%s+', ' '):gsub('^%s+', ''):gsub('%s+$', '')
    return text
end
M.normalized = normalized

-- The id part of the game's text of a record id ("ToTweakDBID{ hash = 0x9ECAADC2, length = 28 --[[ Character.X --]] }" -> "0x9ecaadc2:28"),
-- or the text itself when it is not such a text (a record name, a test's plain string). The readable name in the comment is left out.
local function idKey(text)
    if type(text) ~= 'string' then return nil end
    local hash, length = text:match('hash%s*=%s*(0[xX]%x+)%s*,%s*length%s*=%s*(%d+)')
    if hash then return hash:lower() .. ':' .. length end
    return text
end
M.idKey = idKey

-- options:
--   read()         the text of the file, or nil           (default: io.open FILE)
--   decode(text)   the table in it, or nil                 (default: json.decode)
--   hash(record)   the game's id string of a record name   (init.lua: tostring(TweakDBID.new(record))); nil when unavailable
--   prefixes       the clone prefixes of character-catalog.lua ("NCA.")
--   enabled()      true while Mistral or the Local AI answers
--   clock()        seconds                                 (default: os.time)
--   onChange(self) called after the characters changed
function M.new(options)
    options = options or {}
    local clock = options.clock or os.time
    local self = {keys = {}, records = {}, names = {}, count = 0, raw = nil, readAt = nil, watchUntil = nil, skipped = nil}
    local providerOk = nil   -- the last answer of options.enabled(); nil until asked (and while no character exists)

    local function readFile()
        local file = io.open(FILE, 'rb')
        if not file then return nil end
        local text = file:read('*a'); file:close()
        return text
    end
    local read = options.read or readFile
    local decode = options.decode or function(text) return json.decode(text) end

    local function usable(row)
        return type(row) == 'table' and type(row.key) == 'string' and row.key:find('^custom%-[a-z0-9%-]+$') ~= nil
            and type(row.name) == 'string' and row.name ~= ''
    end

    local function build(value)
        local keys, records, names, count = {}, {}, {}, 0
        for _, row in ipairs(type(value) == 'table' and type(value.characters) == 'table' and value.characters or {}) do
            if usable(row) and not keys[row.key] then
                local entry = {key = row.key, name = row.name, gender = row.gender == 'female' and 'FEMALE' or 'MALE'}
                keys[row.key] = entry
                count = count + 1
                for _, record in ipairs(type(row.records) == 'table' and row.records or {}) do
                    if type(record) == 'string' and record ~= '' then
                        local variants = {record}
                        -- "Character.X" is also the original of a record-cloning mod's copy ("NCA.Character.X"): no row lists its clone.
                        if record:find('^Character%.') then
                            for _, prefix in ipairs(options.prefixes or {}) do variants[#variants + 1] = prefix .. record end
                        end
                        for _, variant in ipairs(variants) do
                            local id = idKey(options.hash and options.hash(variant) or variant)
                            if id and records[id] == nil then records[id] = entry end
                            if records[variant] == nil then records[variant] = entry end
                        end
                    end
                end
                for _, name in ipairs(type(row.names) == 'table' and row.names or {}) do
                    local key = normalized(name)
                    if key ~= '' and names[key] == nil then names[key] = entry end
                end
            end
        end
        return keys, records, names, count
    end

    -- Reads the file when it is due. force: now, whatever the time (load, tests). Returns true when the characters changed.
    function self.refresh(force)
        local now = clock()
        if not force then
            if self.readAt and now - self.readAt < REFRESH_EVERY then return false end
            if self.count == 0 and not (self.watchUntil and now <= self.watchUntil) then return false end
        end
        self.readAt = now
        local ok, text = pcall(read)
        if not ok or type(text) ~= 'string' then return false end
        if text == self.raw then return false end
        local blank = text:gsub('%s+', '') == ''
        -- An empty file is no characters (the shipped placeholder); a file that cannot be read is nothing yet: the list stands and the next try reads it again.
        local decoded = {}
        if not blank then
            local good, value = pcall(decode, text)
            if not good or type(value) ~= 'table' then return false end
            decoded = value
        end
        local first = self.raw == nil
        self.raw = text
        if first and blank then return false end
        local keys, records, names, count = build(decoded)
        self.keys, self.records, self.names, self.count = keys, records, names, count
        self.checkProvider()
        if options.onChange then pcall(options.onChange, self) end
        return true
    end

    -- Asks whether Mistral or the Local AI is answering now, and remembers the answer for match(). Called at load and at each talk key press;
    -- with no character made it asks nothing.
    function self.checkProvider()
        if self.count == 0 then providerOk = nil; return end
        local ok, answer = pcall(function() return not options.enabled or options.enabled() == true end)
        providerOk = ok and answer == true
    end

    -- The player opened the editor: a character may be made now, so the file is worth a look at the next talk key press.
    function self.watch() self.watchUntil = clock() + WATCH_FOR end

    function self.has(key) return self.keys[key] ~= nil end
    function self.get(key) return self.keys[key] end
    function self.size() return self.count end

    -- The character this person is, or nil. actor = {record, name, facts} as character-catalog.lua resolve gets them: the record's id, then its
    -- readable name (facts.recordName, when the facts were read), then the display name.
    function self.match(actor)
        if self.count == 0 or type(actor) ~= 'table' then return nil end
        local facts = type(actor.facts) == 'table' and actor.facts or nil
        local entry = (type(actor.record) == 'string' and self.records[idKey(actor.record)])
            or (facts and type(facts.recordName) == 'string' and self.records[facts.recordName])
            or self.names[normalized(actor.name)]
        if not entry then return nil end
        if providerOk == nil then self.checkProvider() end
        if providerOk ~= true then self.skipped = entry; return nil end
        return entry
    end

    -- A match that was left out because Convai is answering: set by match(), read and cleared around one resolution on a talk key press.
    function self.clearSkipped() self.skipped = nil end
    function self.takeSkipped() local entry = self.skipped; self.skipped = nil; return entry end

    return self
end

return M
