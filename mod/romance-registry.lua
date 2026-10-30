-- Who V is romantically involved with, per save (docs/SIDE_ROMANCE.md, bridge/romance-bond.mjs).
--
-- One saved quest fact per character, written into every save by the game itself, so a romance follows the save: a load of an older save brings back the older
-- state and a new game starts with none. It is the same technique as the housemates' registry (mod/housemate-registry.lua, whose hash this file borrows) and is
-- kept next to the game's own romance facts, which stay read-only.
--
--   name   cyberpunkconvai_rom_<fnv1a32(profileKey) as 8 hex digits>
--   value  1: together, 2: it ended, 0 or unset: nothing
--
-- Facts cannot be listed, so a list asks for the keys it is given (the characters V has talked to, from the bond status). Reads and writes happen at a turn or when
-- the Romantic relationships page opens, never per frame.
local housemates = dofile('housemate-registry.lua')
local M = {}

M.PREFIX = 'cyberpunkconvai_rom_'
M.TOGETHER, M.ENDED = 1, 2
local NAMES = {[1] = 'together', [2] = 'ended'}
local NUMBERS = {together = 1, ended = 2}

local function keyOf(profileKey) return type(profileKey) == 'string' and #profileKey <= 80 and profileKey:match('^[a-z0-9][a-z0-9-]*$') and profileKey or nil end

function M.factName(profileKey) return M.PREFIX .. housemates.hex(housemates.hash(profileKey)) end
-- The game's quest facts (the same store the housemates use; tests pass their own: store.get(name) -> number, store.set(name, number)).
function M.factStore() return housemates.factStore() end

-- 'together', 'ended' or nil for one character. A fact that holds any other number is ignored.
function M.read(store, profileKey)
    if not keyOf(profileKey) then return nil end
    local ok, value = pcall(store.get, M.factName(profileKey))
    return ok and NAMES[tonumber(value) or 0] or nil
end

-- Write one character's state ('together', 'ended', or nil to clear). Returns true, or false and a reason.
function M.write(store, profileKey, state)
    if not keyOf(profileKey) then return false, 'unknown character' end
    local number = state and NUMBERS[state] or nil
    if state and not number then return false, 'unknown state' end
    local ok, err = pcall(store.set, M.factName(profileKey), number or 0)
    if not ok then return false, tostring(err) end
    return true
end

-- {profileKey = state} for the keys given (only those with a state).
function M.list(store, keys)
    local out = {}
    for _, key in ipairs(keys) do
        local state = M.read(store, key)
        if state then out[key] = state end
    end
    return out
end

return M
