-- Saved parties of the Companion Manager (Parties page): a party the player saved from the current one, with a name, to be invited again with
-- one press. Pure data: the page logic and the invitations are in manager-ui.lua.
--
-- What a saved party keeps: the members in the order they joined, each {key = the character (or custom character) key the invitation
-- takes, name = the name as the party showed it}. A character that is in the party twice is two entries (a copy is a second invitation of
-- the same key). Nothing else is kept because nothing else of an invitation is the player's choice: the conversation profile of a copy is the
-- character's own, and everything a character has (voice, outfit, behaviour) is saved by character in the settings already.
--
-- Where it lives: runtime/saved-parties.json in the mod folder (CET lets the Lua open files only there), a player-state file like
-- favorites.json: bridge/game-state.mjs copies it to <data>/game-state/ while the service runs and puts it back if the file is missing, and
-- packaging/runtime-exchange.json class `state` means no package ever ships or replaces it. {version = 1, next = n, parties = {{id, name, members}}}.
-- It belongs to the player, not to a save: the same parties are there in every save.
--
-- Cost: nothing runs per frame. The file is read once, the first time a page asks; it is written only when the player presses a button.
--
-- Loaded by manager-ui.lua (pcall(dofile, 'saved-parties.lua')) and read through the global convaiSavedParties, so no function there gains an
-- upvalue (LuaJIT limits them).
if type(convaiSavedParties) == 'table' and convaiSavedParties.version == 1 then return convaiSavedParties end
local M = {version = 1}

local FILE = 'runtime/saved-parties.json'
M.MAX_PARTIES = 12      -- saved parties: a dozen is a long list on a settings page
M.MAX_MEMBERS = 16      -- members of one saved party
M.MAX_NAME = 32         -- characters in a party's name
local KEY_LIMIT, MEMBER_NAME_LIMIT = 160, 60

local parties = {}
local nextNumber = 1
local loaded = false
local revision = 0
local lastError
local armed

-- Replaceable for the tests.
M.files = nil   -- an io-like table (open); the global io when nil
M.codec = nil   -- a json-like table (decode, encode); the global json when nil

local function files() return M.files or io end
local function codec() return M.codec or json end

-- At most `limit` characters of `text`, never cutting a UTF-8 sequence in the middle.
local function cut(text, limit)
    local count, index, size = 0, 1, #text
    while index <= size do
        local byte = text:byte(index)
        if byte < 128 or byte >= 192 then
            count = count + 1
            if count > limit then return text:sub(1, index - 1) end
        end
        index = index + 1
    end
    return text
end

-- A name as it is kept: one line, single spaces, no braces (they stand for values in the menu's texts), at most MAX_NAME characters.
-- Returns nil for a name with nothing left.
function M.cleanName(text, limit)
    if type(text) ~= 'string' then return nil end
    local clean = text:gsub('%c', ' '):gsub('[{}]', ''):gsub('%s+', ' ')
    clean = cut(clean:match('^%s*(.-)%s*$'), limit or M.MAX_NAME)
    clean = clean:match('^%s*(.-)%s*$')
    if clean == '' then return nil end
    return clean
end

local function cleanMembers(list)
    local out = {}
    if type(list) ~= 'table' then return out end
    for _, member in ipairs(list) do
        if #out >= M.MAX_MEMBERS then break end
        if type(member) == 'table' and type(member.key) == 'string' and member.key ~= '' and #member.key <= KEY_LIMIT then
            out[#out + 1] = {key = member.key, name = M.cleanName(member.name, MEMBER_NAME_LIMIT) or member.key}
        end
    end
    return out
end

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

-- Reads the file once (again with force). A file that is missing, empty or damaged is no parties; a damaged one is not written over until
-- the player saves a party, and then only with what is in memory.
function M.load(force)
    if loaded and not force then return end
    loaded = true
    parties, nextNumber, armed = {}, 1, nil
    local ok, text = pcall(readFile)
    local value = ok and decode(text) or nil
    if value and type(value.parties) == 'table' then
        local seen = {}
        for _, entry in ipairs(value.parties) do
            if #parties >= M.MAX_PARTIES then break end
            local name = type(entry) == 'table' and M.cleanName(entry.name) or nil
            local id = type(entry) == 'table' and entry.id or nil
            if name and type(id) == 'string' and id:match('^party%-%d+$') and not seen[id] then
                seen[id] = true
                parties[#parties + 1] = {id = id, name = name, members = cleanMembers(entry.members)}
                nextNumber = math.max(nextNumber, tonumber(id:match('%d+')) + 1)
            end
        end
        nextNumber = math.max(nextNumber, math.floor(tonumber(value.next) or 1))
    end
    revision = revision + 1
end

local function save()
    local ok, encoded = pcall(codec().encode, {version = 1, next = nextNumber, parties = parties})
    if not ok or type(encoded) ~= 'string' then lastError = 'could not encode'; return false end
    local opened = files().open(FILE, 'wb')
    if not opened then lastError = 'could not open ' .. FILE; return false end
    local wrote, problem = opened:write(encoded)
    opened:close()
    if wrote == nil or wrote == false then lastError = tostring(problem or 'write failed'); return false end
    lastError = nil
    return true
end

local function changed()
    revision = revision + 1
    return save()
end

function M.lastError() return lastError end
-- A number that changes whenever the saved parties do: the page that shows them compares it.
function M.revision() M.load(); return revision end

-- The saved parties, in the order they were saved. The table is the module's own: read it, never change it.
function M.list() M.load(); return parties end
function M.count() M.load(); return #parties end

function M.get(id)
    M.load()
    for index, party in ipairs(parties) do
        if party.id == id then return party, index end
    end
    return nil
end

-- "Party 1", "Party 2" ...: the lowest number whose name no saved party has.
function M.defaultName(word)
    M.load()
    word = word or 'Party'
    local used = {}
    for _, party in ipairs(parties) do used[party.name:lower()] = true end
    local number = 1
    while used[(word .. ' ' .. number):lower()] do number = number + 1 end
    return word .. ' ' .. number
end

-- Whether another saved party has this name (case does not matter).
function M.nameTaken(name, exceptId)
    M.load()
    local wanted = tostring(name):lower()
    for _, party in ipairs(parties) do
        if party.id ~= exceptId and party.name:lower() == wanted then return true end
    end
    return false
end

-- Saves `members` ({key, name} each) as a new party called `name` (the default "Party n" when none is given). Returns the party and whether
-- it was written to the file; or nil and a reason: 'full' (MAX_PARTIES kept), 'empty' (nobody to save), 'name' (a party has that name).
function M.create(members, name, word)
    M.load()
    if #parties >= M.MAX_PARTIES then return nil, 'full' end
    local kept = cleanMembers(members)
    if #kept == 0 then return nil, 'empty' end
    local clean
    if name ~= nil then clean = M.cleanName(name) else clean = M.defaultName(word) end
    if not clean then return nil, 'name' end
    if M.nameTaken(clean) then return nil, 'name' end
    local party = {id = 'party-' .. nextNumber, name = clean, members = kept}
    nextNumber = nextNumber + 1
    parties[#parties + 1] = party
    return party, changed()
end

-- Replaces the members of a saved party with `members`. Returns the party and whether it was written; nil and a reason ('missing', 'empty').
function M.update(id, members)
    local party = M.get(id)
    if not party then return nil, 'missing' end
    local kept = cleanMembers(members)
    if #kept == 0 then return nil, 'empty' end
    party.members = kept
    return party, changed()
end

-- Gives a saved party another name. Returns the party and whether it was written; nil and a reason ('missing', 'name' for an empty name or
-- a name another party has).
function M.rename(id, name)
    local party = M.get(id)
    if not party then return nil, 'missing' end
    local clean = M.cleanName(name)
    if not clean or M.nameTaken(clean, id) then return nil, 'name' end
    if clean == party.name then return party, true end
    party.name = clean
    return party, changed()
end

-- Deletes a saved party. Returns whether it existed, and whether the file was written.
function M.remove(id)
    local party, index = M.get(id)
    if not party then return false end
    table.remove(parties, index)
    armed = nil
    return true, changed()
end

-- Delete asks twice: the first press arms it (the row says so), the second one, with nothing else pressed between, deletes.
function M.arm(id) armed = id end
function M.armed() return armed end
function M.disarm() armed = nil end

-- The files and the codec go back to the game's own (the tests set both).
function M.reset()
    M.files, M.codec = nil, nil
    loaded, revision, lastError, armed = false, 0, nil, nil
    parties, nextNumber = {}, 1
end

convaiSavedParties = M
return M
