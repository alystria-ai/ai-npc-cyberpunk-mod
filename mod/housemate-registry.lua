-- Who lives where: the housemates' registry (docs/HOUSEMATES.md, "Persistence").
--
-- One saved quest fact per housemate, written into every save by the game itself, so the registry follows the save: a load of an older
-- save brings back the older registry and a new game starts empty. Nothing else is stored (a party seat, a spot and the time of day are
-- not). Facts cannot be listed, so the keys to look for are the profile keys the mod knows (the roster and the player's own characters).
--
--   name   cyberpunkconvai_hm_<fnv1a32(profileKey) as 8 hex digits>
--   value  the flat's number, 1..5 (APARTMENTS below), 0 or unset: she does not live at V's place
--
-- This file is small on purpose: it is the only housemate code that runs for a player who has nobody living at V's place (one pass of fact
-- reads when a world is ready). The bigger modules (mod/housemates.lua and its helpers) are loaded only when someone lives somewhere.
--
-- The fallback store keeps the same table in a file for the session. It exists for the day the facts turn out not to survive a load (the
-- first live check, docs/HOUSEMATES.md), and is selected by M.mode.
local M = {}

M.PREFIX = 'cyberpunkconvai_hm_'
M.APARTMENTS = {'h10', 'corpo', 'glen', 'japan', 'north'}
M.mode = 'facts'   -- 'facts' (the game's saved facts) or 'file' (this session, runtime/housemates.json)

local NUMBER = {}
for index, id in ipairs(M.APARTMENTS) do NUMBER[id] = index end
function M.number(id) return NUMBER[id] end
function M.id(number) return M.APARTMENTS[tonumber(number) or 0] end

-- FNV-1a over the bytes of a profile key, 32 bits, in plain arithmetic (a double holds 2^53; the product of two 32-bit numbers does not
-- fit, so the multiply by 16777619 = 2^24 + 403 is split).
local function xor8(a, b)
    local result, bit = 0, 1
    for _ = 1, 8 do
        if (a % 2) ~= (b % 2) then result = result + bit end
        a, b, bit = math.floor(a / 2), math.floor(b / 2), bit * 2
    end
    return result
end
function M.hash(text)
    local h = 2166136261
    for index = 1, #text do
        local low = h % 256
        h = h - low + xor8(low, text:byte(index))
        h = ((h % 256) * 16777216 + h * 403) % 4294967296
    end
    return h
end
-- Hex by halves: %x takes a 32-bit integer in some Lua builds and the hash needs all 32 bits as an unsigned number.
function M.hex(h) return string.format('%04x%04x', math.floor(h / 65536), h % 65536) end
function M.factName(profileKey) return M.PREFIX .. M.hex(M.hash(profileKey)) end
M.SCHEMA_FACT = M.PREFIX .. 'v1'

-- ---- the stores --------------------------------------------------------------------------------------------------------------------
-- store.get(name) -> number, store.set(name, number). The facts store is the game's quest facts; tests and the fallback pass their own.
function M.factStore()
    return {
        get = function(name)
            local quests = Game.GetQuestsSystem()
            return quests and tonumber(quests:GetFactStr(name)) or 0
        end,
        set = function(name, value)
            local quests = Game.GetQuestsSystem()
            if not quests then error('The quest system is not ready.') end
            quests:SetFactStr(name, value)
        end}
end

-- A table in memory with a file behind it (runtime/housemates.json): the session fallback. `path` and `io` are replaceable for the tests.
function M.fileStore(path, files)
    files = files or io
    local values = {}
    local function load()
        local file = files.open(path or 'runtime/housemates.json', 'rb')
        if not file then return end
        local raw = file:read('*a'); file:close()
        local ok, decoded = pcall(json.decode, raw)
        if ok and type(decoded) == 'table' and type(decoded.facts) == 'table' then
            for name, value in pairs(decoded.facts) do if type(value) == 'number' then values[name] = value end end
        end
    end
    local loaded = false
    return {
        get = function(name) if not loaded then loaded = true; load() end return values[name] or 0 end,
        set = function(name, value)
            if not loaded then loaded = true; load() end
            values[name] = value
            local ok, encoded = pcall(json.encode, {version = 1, facts = values})
            if not ok then return end
            local file = files.open(path or 'runtime/housemates.json', 'wb')
            if file then file:write(encoded); file:close() end
        end}
end

-- ---- reading and writing -----------------------------------------------------------------------------------------------------------
-- keys: every profile key the mod knows. Returns {profileKey = apartmentId}, at most one flat each. A fact that holds a number outside
-- 1..5 is ignored.
function M.read(store, keys)
    local homes = {}
    for _, key in ipairs(keys) do
        local ok, value = pcall(store.get, M.factName(key))
        local id = ok and M.id(value) or nil
        if id then homes[key] = id end
    end
    return homes
end

-- Write one housemate (id nil or false: she moves out). Returns true, or false and a reason.
function M.write(store, profileKey, id)
    local number = id and NUMBER[id] or nil
    if id and not number then return false, 'unknown apartment' end
    number = number or 0
    local ok, err = pcall(store.set, M.factName(profileKey), number)
    if not ok then return false, tostring(err) end
    if number > 0 then pcall(store.set, M.SCHEMA_FACT, 1) end
    return true
end

return M
