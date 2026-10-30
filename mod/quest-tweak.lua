-- Custom TweakDB records for the bond quests, made at runtime with Cyber Engine Tweaks (owner decision 29 Oct: no TweakXL). A record is cloned from a vanilla one
-- with TweakDB:CloneRecord(newName, baseRecord), then its flats are set with TweakDB:SetFlat(flatName, value) and the record is refreshed with TweakDB:Update.
-- It is done once per record, guarded (every native call is in a pcall), idempotent (a module-level done-set, and the record is looked up first, so a script
-- reload that runs the file again finds the clone already there and only sets the flats again, which is harmless) and logged, read-back included.
--
-- API (M.new(deps) -> T)
--   T.ensure(name, base, flats) -> true | false, why      flats: a list of {flat, value}. A flat that does not start with `name .. '.'` is taken as relative to the
--                                                         record. A value is a plain Lua value, {tdbid = 'Group.Record'} (a TweakDBID), or {cname = 'Text'} (a CName).
--   T.neutralVehicle(base) -> record name                 the neutral clone of a vehicle record (no police affiliation, no police marker), or `base` itself when the
--                                                         clone cannot be made. A nil base means M.DEFAULT_BASE. Never raises.
--   T.known() -> list of the names ensured so far
-- Other modules (gift items later) call T.ensure with their own name, base and flats. Nothing here runs per frame: ensure is a few native calls the first time a name
-- is asked for, and a table lookup after that.
--
-- UNVERIFIED in the game (offline-tested on a fake TweakDB only, the first live run must look at each):
--   CloneRecord / SetFlat / Update / GetRecord / GetFlat on a Vehicle record at runtime, a spawn of the clone through the dynamic entity system, the flat names and values
--   in M.CLONES below (affiliation and visualTags of a vehicle record are guesses from the TweakDB dumps), and that a clone of a police car is boardable and shows no
--   police marker on the minimap. The log lines "Quest tweak: ..." carry the read-back of every flat, which is what the live check reads.
local M = {
    -- The vanilla record a neutral car is cloned from when a quest names none (also the fallback car of mod/quest-world-drive.lua).
    DEFAULT_BASE = 'Vehicle.v_standard2_archer_hella_player',
    -- The clone name of a vehicle record: this prefix plus the base without its group.
    NEUTRAL_PREFIX = 'Vehicle.QuestNeutral_',
}

-- The clone specs, data only. `neutral-vehicle` is the chase car: the flats set on a clone of any vehicle record. The names are relative to the clone.
M.CLONES = {
    ['neutral-vehicle'] = {
        flats = {
            {'affiliation', {tdbid = 'Affiliation.Unaffiliated'}},   -- not NCPD, so the car is boardable and the game does not treat it as a police car
            {'visualTags', {}},                                      -- no Police visual tag, so no police marker on the minimap
        },
    },
}

-- What has been made in this run of the file: name -> true. A reload starts empty and finds the record in the TweakDB instead.
M.done = {}

local function global(key)
    local ok, value = pcall(function() return _G[key] end)
    if ok and value ~= nil then return value end
    ok, value = pcall(rawget, _G, key)
    return ok and value or nil
end

local function validName(text) return type(text) == 'string' and #text >= 3 and #text <= 120 and text:match('^[%a][%w_%.]*$') ~= nil end

-- deps: tweakdb (default the global TweakDB), id(text) -> TweakDBID (default TweakDBID.new), cname(text) -> CName (default CName.new), log(line).
function M.new(deps)
    deps = deps or {}
    local T = {}
    local failed = {}

    local function log(line) if type(deps.log) == 'function' then pcall(deps.log, 'Quest tweak: ' .. line) end end
    local function db() return deps.tweakdb or global('TweakDB') end
    local function makeId(text)
        if type(deps.id) == 'function' then return deps.id(text) end
        local ctor = global('TweakDBID')
        return ctor.new(text)
    end
    local function makeName(text)
        if type(deps.cname) == 'function' then return deps.cname(text) end
        local ctor = global('CName')
        return ctor.new(text)
    end
    local function value(raw)
        if type(raw) == 'table' then
            if type(raw.tdbid) == 'string' then return makeId(raw.tdbid) end
            if type(raw.cname) == 'string' then return makeName(raw.cname) end
        end
        return raw
    end
    local function exists(tweak, name)
        local ok, record = pcall(function() return tweak:GetRecord(name) end)
        return ok and record ~= nil
    end

    function T.ensure(name, base, flats)
        if not validName(name) then return false, 'bad record name' end
        if M.done[name] then return true end
        if failed[name] then return false, failed[name] end
        local function fail(why)
            failed[name] = why
            log(name .. ' not made: ' .. why)
            return false, why
        end
        local tweak = db()
        if tweak == nil then return fail('the TweakDB is not reachable') end
        if not validName(base) then return fail('bad base record') end
        if type(flats) ~= 'table' then return fail('no flats') end
        local present = exists(tweak, name)
        if not present then
            if not exists(tweak, base) then return fail('the base record ' .. base .. ' does not exist') end
            local ok, cloned = pcall(function() return tweak:CloneRecord(name, base) end)
            if not ok then return fail('CloneRecord raised: ' .. tostring(cloned)) end
            if cloned == false then return fail('CloneRecord refused') end
            if not exists(tweak, name) then return fail('the clone is not in the TweakDB after CloneRecord') end
            log(name .. ' cloned from ' .. base)
        else
            log(name .. ' is already in the TweakDB, its flats are set again')
        end
        local notes, bad = {}, nil
        for index, row in ipairs(flats) do
            if type(row) ~= 'table' or not validName(row[1]) then bad = 'flat ' .. index .. ' is malformed'; break end
            local flat = row[1]
            if flat:sub(1, #name + 1) ~= name .. '.' then flat = name .. '.' .. flat end
            local ok, set = pcall(function() return tweak:SetFlat(flat, value(row[2])) end)
            if not ok then bad = 'SetFlat ' .. flat .. ' raised: ' .. tostring(set); break end
            if set == false then bad = 'SetFlat ' .. flat .. ' refused'; break end
            local readOk, read = pcall(function() return tweak:GetFlat(flat) end)
            notes[#notes + 1] = flat .. ' read back ' .. (readOk and tostring(read) or 'unreadable')
        end
        if bad then return fail(bad) end
        local updated, why = pcall(function() return tweak:Update(name) end)
        if not updated then notes[#notes + 1] = 'Update raised: ' .. tostring(why) end
        M.done[name] = true
        log(name .. ' ready (' .. table.concat(notes, ', ') .. ')')
        return true
    end

    function T.neutralVehicle(base)
        if base == nil then base = M.DEFAULT_BASE end
        if not validName(base) then return M.DEFAULT_BASE end
        local name = M.NEUTRAL_PREFIX .. base:gsub('^[%w_]+%.', '')
        local ok, made = pcall(T.ensure, name, base, M.CLONES['neutral-vehicle'].flats)
        if ok and made == true then return name end
        return base
    end

    function T.known()
        local list = {}
        for name in pairs(M.done) do list[#list + 1] = name end
        table.sort(list)
        return list
    end

    return T
end

return M
