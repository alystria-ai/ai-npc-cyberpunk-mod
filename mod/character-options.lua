-- What the player chose for a character in the character editor's "Look and moves" part (docs/CHARACTER_EDITOR.md): the clothes, which gestures and idle
-- moves it may use, whether it sits, and whether it comments on fights and loot.
--
-- The conversation service writes runtime/character-options.json (replaced in place, never shipped): {version, revision, characters = {[profile key] = {...}}}
-- holding only the choices that differ from today's behaviour. This module reads it into one table and answers get(key) with a table lookup. Nothing here
-- runs per frame and nothing polls on its own:
--   - the file is read when the mod loads;
--   - after the player opened the editor it is read again every REFRESH_EVERY seconds for two hours (watch), from the 10 Hz tick through tick(elapsed): one
--     subtraction per call, and a file read of a few hundred bytes every few seconds only while the editor was opened lately. Without a recent editor
--     visit the file is never read again, so a game that never uses the editor pays nothing.
--   - a character with no row behaves as it always did: get(key) is nil.
local M = {version = 1}

local FILE = 'runtime/character-options.json'
local REFRESH_EVERY = 5     -- seconds between two reads of the file while the editor was opened lately
local WATCH_FOR = 7200      -- seconds after the editor was opened

-- The values each choice may hold (anything else is ignored); the same lists as bridge/character-options.mjs OPTION_VALUES.
local TALK = {calm = true, lively = true, none = true}
local IDLE = {plain = true, none = true}

local function usable(row)
    if type(row) ~= 'table' then return nil end
    local out, any = {}, false
    if type(row.outfit) == 'string' and row.outfit:find('^[a-z0-9][a-z0-9_]*$') and #row.outfit <= 120 then out.outfit = row.outfit; any = true end
    if TALK[row.talk] then out.talk = row.talk; any = true end
    if IDLE[row.idle] then out.idle = row.idle; any = true end
    if row.nods == false then out.nods = false; any = true end
    if row.sit == false then out.sit = false; any = true end
    if row.react == false then out.react = false; any = true end
    return any and out or nil
end

-- options:
--   read()         the text of the file, or nil           (default: io.open FILE)
--   decode(text)   the table in it, or nil                 (default: json.decode)
--   clock()        seconds                                 (default: os.time)
--   onChange(self) called after the choices changed (the first read included: a file the editor has just created is a change too)
function M.new(options)
    options = options or {}
    local clock = options.clock or os.time
    local self = {rows = {}, outfits = 0, raw = nil, watchUntil = nil, wait = 0}

    local function readFile()
        local file = io.open(FILE, 'rb')
        if not file then return nil end
        local text = file:read('*a'); file:close()
        return text
    end
    local read = options.read or readFile
    local decode = options.decode or function(text) return json.decode(text) end

    -- Reads the file. Returns true when the choices changed. An unreadable or damaged file leaves the choices as they were.
    function self.refresh()
        local ok, text = pcall(read)
        if not ok or type(text) ~= 'string' then return false end
        if text == self.raw then return false end
        local blank = text:gsub('%s+', '') == ''
        local decoded = {}
        if not blank then
            local good, value = pcall(decode, text)
            if not good or type(value) ~= 'table' then return false end
            decoded = value
        end
        self.raw = text
        local rows, outfits = {}, 0
        for key, row in pairs(type(decoded.characters) == 'table' and decoded.characters or {}) do
            local cleaned = type(key) == 'string' and #key <= 80 and usable(row) or nil
            if cleaned then rows[key] = cleaned; if cleaned.outfit then outfits = outfits + 1 end end
        end
        self.rows, self.outfits = rows, outfits
        if options.onChange then pcall(options.onChange, self) end
        return true
    end

    -- The player opened the editor: a choice may be saved now, so the file is looked at every few seconds for a while.
    function self.watch()
        self.watchUntil = clock() + WATCH_FOR
        self.wait = 0
    end

    -- From the 10 Hz tick: nothing unless the editor was opened lately.
    function self.tick(elapsed)
        if not self.watchUntil then return end
        self.wait = self.wait - (tonumber(elapsed) or 0)
        if self.wait > 0 then return end
        self.wait = REFRESH_EVERY
        if clock() > self.watchUntil then self.watchUntil = nil; return end
        self.refresh()
    end

    -- The choices of a profile key, or nil (nothing chosen: today's behaviour). A table lookup.
    function self.get(key) return key ~= nil and self.rows[key] or nil end
    -- The look chosen for a profile key, or nil.
    function self.outfit(key) local row = key ~= nil and self.rows[key] or nil; return row and row.outfit or nil end
    -- True while any character has a chosen look (the outfit module runs for those even with the setting off).
    function self.hasOutfits() return self.outfits > 0 end

    return self
end

return M
