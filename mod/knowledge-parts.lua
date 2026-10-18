-- The world facts and journal inventory a turn carries, published once per revision instead of inside every request
-- (docs/PERFORMANCE_NATIVE_PLAN.md item 1b). A request used to hold ~800 KB of them (643 KB journal, 151 KB facts),
-- so every turn JSON-encoded and wrote that much on the game thread (a 26-81 ms hitch, twice for a voice turn). Now
-- each part (world, active, history) is written to runtime/knowledge-<part>.json only when a turn needs a revision
-- not written yet, and the request names {part, revision}. The bridge (bridge/knowledge-parts.mjs) reads a part the
-- first time a request names it and keeps it. Runs only when a turn is captured; no per-frame work.
local M = {}
local NAMES = {world = true, active = true, history = true}

M.open = io.open
M.encode = function(value) return json.encode(value) end
-- name -> 'revision:generation:worldToken' of the content on disk.
M.written = {}

-- Incremental map encoder. A collector hands it a finished table keyed by strings and calls step(n) a few times per
-- frame; once done, text is the JSON object of the map, entry by entry, equal in content to encoding the map whole.
-- The first turn that needs the part then writes a ready string instead of encoding 150-650 KB on its own frame.
-- failed is set (and the caller drops the encoder) if an entry cannot be encoded.
local Encoder = {}; Encoder.__index = Encoder
local PLAIN_KEY = '^[%w_:%-%.#/@+]+$'
function M.newEncoder(map, encode)
    local keys = {}
    for name in pairs(map) do keys[#keys + 1] = name end
    pcall(table.sort, keys) -- a stable order (every key is a string)
    local encodeValue = encode or M.encode
    return setmetatable({map = map, keys = keys, index = 1, pieces = {}, done = false, failed = false,
        encodeValue = encodeValue}, Encoder)
end
function Encoder:step(count)
    if self.done or self.failed then return end
    for _ = 1, count or 1 do
        local name = self.keys[self.index]
        if name == nil then
            self.text = '{' .. table.concat(self.pieces, ',') .. '}'; self.pieces, self.done = nil, true
            return
        end
        local okValue, value = pcall(self.encodeValue, self.map[name])
        local label = type(name) == 'string' and name:match(PLAIN_KEY) and ('"' .. name .. '"')
        if not label then
            local okKey, encodedKey = pcall(self.encodeValue, tostring(name)); label = okKey and encodedKey or nil
        end
        if not okValue or type(value) ~= 'string' or type(label) ~= 'string' then self.failed = true; return end
        self.pieces[#self.pieces + 1] = label .. ':' .. value
        self.index = self.index + 1
    end
end

local function key(part)
    return tostring(part.revision) .. ':' .. tostring(part.generation) .. ':' .. tostring(part.worldToken)
end

-- Writes every part whose revision is not on disk yet. In place: the bridge reads a part only after the request that
-- names it, which is written after this returns, and checks the revision and world binding it finds.
function M.publish(parts)
    for _, part in ipairs(parts or {}) do
        if type(part) ~= 'table' or not NAMES[part.name] or type(part.revision) ~= 'number' or type(part.data) ~= 'table' then
            return false
        end
        local id = key(part)
        if M.written[part.name] ~= id then
            M.written[part.name] = nil
            local header = {version = 1, part = part.name, revision = part.revision,
                generation = part.generation, worldToken = part.worldToken}
            local ok, raw
            if type(part.encoded) == 'string' then
                -- data was encoded ahead of time (newEncoder): splice it into the encoded header.
                ok, raw = pcall(M.encode, header)
                if ok and type(raw) == 'string' and #raw > 2 and raw:sub(-1) == '}' then
                    raw = raw:sub(1, -2) .. ',"data":' .. part.encoded .. '}'
                else ok = false end
            end
            if not ok then
                -- strict: a provisional part whose data table is not the rows (mod/journal-history.lua capturePart).
                if part.strict then return false end
                header.data = part.data
                ok, raw = pcall(M.encode, header)
            end
            if not ok or type(raw) ~= 'string' then return false end
            local file = M.open('runtime/knowledge-' .. part.name .. '.json', 'wb')
            if not file then return false end
            local written = file:write(raw)
            local closed = file:close()
            if not written or not closed then return false end
            M.written[part.name] = id
        end
    end
    return true
end

-- A new world or a reload: nothing on disk can be trusted to match the next revision numbers.
function M.reset() M.written = {} end

return M
