-- Favorites of the Companion Manager: the characters (Main and Side characters to invite, one set: a key is in one list only, and the phone's Chat
-- tab stars the same keys) and the game models (Model browser) the player starred. A
-- favorite is listed in the Favorites block at the top of its page, and first in the phone's Chat tab. Pure data:
-- the page logic is in manager-ui.lua (per-row buttons), the phone side in mod/phone-chat.lua.
--
-- Where it lives: runtime/favorites.json in the mod folder (CET lets the Lua open files only there), a player-state file like settings.json:
-- bridge/game-state.mjs copies it to <data>/game-state/ in %LOCALAPPDATA%\AiNpcCyberpunkMod\data while the service runs and puts it back
-- if the file is missing, and packaging/runtime-exchange.json class `state` means no package ever ships or replaces it, so an update never
-- touches the player's favorites. {version = 1, characters = {[key] = true}, models = {[key] = true}}.
--
-- Cost: nothing runs per frame. The file is read once, the first time a page asks; it is written only when the player presses a button.
--
-- Loaded by manager-ui.lua (pcall(dofile, 'favorites.lua')) and read through the global convaiFavorites, so no function there gains an
-- upvalue (LuaJIT limits them).
if type(convaiFavorites) == 'table' and convaiFavorites.version == 1 then return convaiFavorites end
local M = {version = 1}

local FILE = 'runtime/favorites.json'
local SCOPES = {characters = true, models = true}
local LIMIT = 500          -- favorites per page: a few hundred is a long list already, and the file stays small
local KEY_LIMIT = 160

local data = {characters = {}, models = {}}
local loaded = false
local revision = 0
local lastError
-- Replaceable for the tests.
M.files = nil   -- an io-like table (open); the global io when nil
M.codec = nil   -- a json-like table (decode, encode); the global json when nil

local function files() return M.files or io end
local function codec() return M.codec or json end

local function validKey(key) return type(key) == 'string' and key ~= '' and #key <= KEY_LIMIT end

local function readFile()
    local opened = files().open(FILE, 'rb')
    if not opened then return nil end
    local text = opened:read('*a')
    opened:close()
    return text
end

local function decode(text)
    if type(text) ~= 'string' or text == '' then return nil end
    local ok, value = pcall(codec().decode, text)
    if ok and type(value) == 'table' then return value end
    return nil
end

-- Reads the file once (again with force). A file that is missing, empty or damaged is no favorites; a damaged one is not written over
-- until the player changes a favorite, and then only with what is in memory.
function M.load(force)
    if loaded and not force then return end
    loaded = true
    data = {characters = {}, models = {}}
    local ok, text = pcall(readFile)
    local value = ok and decode(text) or nil
    if value then
        for scope in pairs(SCOPES) do
            local count = 0
            if type(value[scope]) == 'table' then
                for key, mark in pairs(value[scope]) do
                    if mark == true and validKey(key) and count < LIMIT then data[scope][key] = true; count = count + 1 end
                end
            end
        end
    end
    revision = revision + 1
end

local function save()
    local ok, encoded = pcall(codec().encode, {version = 1, characters = data.characters, models = data.models})
    if not ok or type(encoded) ~= 'string' then lastError = 'could not encode'; return false end
    local opened = files().open(FILE, 'wb')
    if not opened then lastError = 'could not open ' .. FILE; return false end
    local wrote, problem = opened:write(encoded)
    opened:close()
    if wrote == nil or wrote == false then lastError = tostring(problem or 'write failed'); return false end
    lastError = nil
    return true
end

function M.lastError() return lastError end
-- A number that changes whenever the favorites do: a page that shows them compares it.
function M.revision() M.load(); return revision end

function M.isFavorite(scope, key)
    if not SCOPES[scope] or not validKey(key) then return false end
    M.load()
    return data[scope][key] == true
end

function M.count(scope)
    if not SCOPES[scope] then return 0 end
    M.load()
    local count = 0
    for _ in pairs(data[scope]) do count = count + 1 end
    return count
end

-- The favorite keys of a page, in no order: a few at most (the file holds up to LIMIT). The Side characters page works from these instead of
-- from its whole list, so a page build costs the favorites and not the 557 side characters.
function M.keys(scope)
    local out = {}
    if not SCOPES[scope] then return out end
    M.load()
    for key in pairs(data[scope]) do out[#out + 1] = key end
    return out
end

-- Turns the favorite of `key` on or off (nil: the other way). Returns whether it is a favorite now, and false as the second value when the
-- change could not be kept (the list is full) or saved (it stays in memory for this session). The first value is nil for a key or a page
-- that does not exist.
function M.set(scope, key, on)
    if not SCOPES[scope] or not validKey(key) then return nil end
    M.load()
    local now = data[scope][key] == true
    if on == nil then on = not now end
    if on == now then return now, true end
    if on and M.count(scope) >= LIMIT then return now, false, 'full' end
    data[scope][key] = on and true or nil
    revision = revision + 1
    return on, save(), nil
end

-- The files and the codec go back to the game's own (the tests set both).
function M.reset()
    M.files, M.codec = nil, nil
    loaded, revision, lastError = false, 0, nil
    data = {characters = {}, models = {}}
end

convaiFavorites = M
return M
