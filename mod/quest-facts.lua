-- The facts reader of the bond quests (docs/QUEST_PRIMITIVES.md section 10.9, bridge/quest-facts.mjs). A pack can require named game facts ("takemura-alive") before it
-- starts. The bridge puts what it wants read into the play file as factsWanted: [{id, names = {fact name...}, kind = 'bool' | 'enum', values = {...}}] and this module reads
-- them with the quest system and writes runtime/quest-facts.json {version = 1, at = game clock, facts = {id = value}}.
--
--   bool   true when any of the fact names is above 0, else false
--   enum   the value text of the first name that is above 0 (values[i] for names[i], else the name itself), "" when none is
--
-- When it reads: at session start (the first update after new() or reset()), after a world change (reset(), the init glue calls it on a load) and then every 300 seconds of
-- real time (EVERY, never faster), and only while the Story packs setting is on and the play file wants something. The file is written ONLY when a value differs from the last
-- one written (the file found at the first read counts as the last written). One read is a GetFactStr call per name, at most 32 facts of 8 names.
--
-- Cost: the init glue calls update(delta) from the quest tick. It adds the delta and looks at the clock once every 5 seconds, nothing else, so no per-frame work.
--
-- UNVERIFIED in the game: Game.GetQuestsSystem():GetFactStr(name) and that the real fact names (a pack's data) exist in this game. A name the game does not know reads 0.
--
-- options: enabled() -> bool, wanted() -> list | nil (quest-play factsWanted), clock() -> seconds, gameTime() -> game seconds | nil, fact(name) -> number | nil (default GetFactStr),
--   read(path), write(path, text), encode, decode, log(line).
local M = {FILE = 'runtime/quest-facts.json', EVERY = 300, LOOK = 5, MAX_FILE = 262144}

local function same(a, b)
    if type(a) ~= 'table' or type(b) ~= 'table' then return false end
    for key, value in pairs(a) do if b[key] ~= value then return false end end
    for key in pairs(b) do if a[key] == nil then return false end end
    return true
end

function M.new(options)
    options = options or {}
    local F = {}
    local acc, nextAt = M.LOOK, nil       -- a fresh reader looks at once: that is the session start
    local last, seeded = nil, false       -- the facts last written (or found in the file at the first read)
    local reads, writes = 0, 0

    local function log(line) if type(options.log) == 'function' then pcall(options.log, 'Quest facts: ' .. line) end end
    local function clock()
        local ok, value = pcall(options.clock or os.clock)
        return ok and type(value) == 'number' and value or os.clock()
    end
    local function enabled()
        if type(options.enabled) ~= 'function' then return false end
        local ok, value = pcall(options.enabled)
        return ok and value == true
    end
    local function wanted()
        if type(options.wanted) ~= 'function' then return nil end
        local ok, value = pcall(options.wanted)
        return ok and type(value) == 'table' and #value > 0 and value or nil
    end
    local function gameTime()
        if type(options.gameTime) ~= 'function' then return 0 end
        local ok, value = pcall(options.gameTime)
        return ok and type(value) == 'number' and value == value and value >= 0 and value or 0
    end
    local function decode(raw) local ok, value = pcall(options.decode or json.decode, raw); return ok and value or nil end
    local function encode(value) local ok, raw = pcall(options.encode or json.encode, value); return ok and type(raw) == 'string' and raw or nil end
    local function read(path)
        if type(options.read) == 'function' then local ok, raw = pcall(options.read, path); return ok and raw or nil end
        local file = io.open(path, 'rb')
        if not file then return nil end
        local raw = file:read(M.MAX_FILE + 1); file:close()
        return raw
    end
    local function write(path, text)
        if type(options.write) == 'function' then local ok, done = pcall(options.write, path, text); return ok and done ~= false end
        local file = io.open(path, 'wb')
        if not file then return false end
        local written, closed = file:write(text), file:close()
        return written and closed and true or false
    end
    local function fact(name)
        if type(options.fact) == 'function' then
            local ok, value = pcall(options.fact, name)
            return ok and type(value) == 'number' and value or 0
        end
        local ok, value = pcall(function() return Game.GetQuestsSystem():GetFactStr(name) end)
        return ok and type(value) == 'number' and value or 0
    end

    -- One fact's value from the rows of the play file.
    local function valueOf(row)
        if row.kind == 'bool' then
            for _, name in ipairs(row.names) do if fact(name) > 0 then return true end end
            return false
        end
        for index, name in ipairs(row.names) do
            if fact(name) > 0 then return (row.values and row.values[index]) or name end
        end
        return ''
    end

    -- The file found at the first read counts as written, so a restart with the same values does not write again.
    local function seed()
        if seeded then return end
        seeded = true
        local raw = read(M.FILE)
        local value = type(raw) == 'string' and raw ~= '' and #raw <= M.MAX_FILE and decode(raw) or nil
        if type(value) == 'table' and value.version == 1 and type(value.facts) == 'table' then
            last = {}
            for key, item in pairs(value.facts) do
                if type(key) == 'string' and (type(item) == 'boolean' or type(item) == 'string' or type(item) == 'number') then last[key] = item end
            end
        end
    end

    -- Reads every wanted fact now. Returns true when the file was written.
    function F.readNow()
        local rows = wanted()
        if not rows then return false end
        seed()
        reads = reads + 1
        local facts = {}
        for _, row in ipairs(rows) do
            if type(row) == 'table' and type(row.id) == 'string' and type(row.names) == 'table' then facts[row.id] = valueOf(row) end
        end
        if same(facts, last) then return false end
        local raw = encode({version = 1, at = gameTime(), facts = facts})
        if raw and write(M.FILE, raw) then
            last, writes = facts, writes + 1
            return true
        end
        log('the facts file could not be written, it is tried again at the next read')
        return false
    end

    -- From the quest tick (0.1 s): adds the delta and looks every 5 s whether a read is due.
    function F.update(delta)
        acc = acc + (tonumber(delta) or 0)
        if acc < M.LOOK then return end
        acc = 0
        if not enabled() or not wanted() then return end
        local now = clock()
        if nextAt ~= nil and now < nextAt then return end
        nextAt = now + M.EVERY
        F.readNow()
    end

    -- A world change (a load, a fast travel, a session start): the facts are read again at the next look.
    function F.reset()
        acc, nextAt = M.LOOK, nil
    end

    function F.status() return {reads = reads, writes = writes, nextIn = nextAt and math.max(0, nextAt - clock()) or 0} end

    return F
end

return M
