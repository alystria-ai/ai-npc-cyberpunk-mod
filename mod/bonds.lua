-- Character bonds (docs/RELATIONSHIPS_AND_QUESTS.md, bridge/bonds.mjs). Settings > Gameplay > Character bonds, Off by default.
--
-- The game half is small: the bridge keeps the bond and words it for the character; the game only says the setting is on and how V stands with the
-- character, and shows one notice when a level changes.
--   attach(context)  once per private turn V sends to a named character (typed, spoken or on a holocall), while the setting is On: a `bonds` block
--                    {version = 1, on = true, copy = 'party' | 'visitor' | 'housemate' | nil} and a short watch for the bridge's status file.
--   update(player)   from the 10 Hz tick, nothing unless a watch is armed: runtime/bonds-status.json is read at most once a second for 30 s after a
--                    turn, and a level change newer than the last one seen is shown as one notice ("Bond with Judy: level 5, Good friend"). The
--                    watch ends at the first change or after 30 s.
-- No per-frame work: Off, attach returns at the first check and update at a nil check. Nothing is written by the game.
local M = {version = 1}
M.STATUS = 'runtime/bonds-status.json'
local WATCH_SECONDS, POLL_SECONDS, MAX_FILE = 30, 1, 65536
local COPIES = {party = true, visitor = true, housemate = true}

-- options: enabled() -> bool; ownCopy(entity, profileKey) -> 'party' | 'visitor' | 'housemate' | nil; clock() -> seconds (os.clock);
-- read(path) -> text | nil; decode (json); notice(player, text); t(text, vars) (mod/ui-locale.lua); log(line).
function M.new(options)
    options = options or {}
    local P = {}
    local watchUntil, pollAt, seen, lastRaw = nil, 0, nil, nil
    local function call(fn, ...)
        if type(fn) ~= 'function' then return false, nil end
        return pcall(fn, ...)
    end
    local function log(line) if type(options.log) == 'function' then pcall(options.log, 'Bonds: ' .. line) end end
    -- The game's translations (mod/ui-locale.lua, given as options.t); every text below is a literal so the UI catalogue finds it.
    local ui = {t = function(text, vars)
        if type(options.t) == 'function' then
            local ok, value = pcall(options.t, text, vars)
            if ok and type(value) == 'string' then return value end
        end
        return (text:gsub('{(%w+)}', function(key) return vars and vars[key] ~= nil and tostring(vars[key]) or '{' .. key .. '}' end))
    end}
    local function clock() local ok, value = call(options.clock); return ok and type(value) == 'number' and value or os.clock() end
    local function enabled() local ok, value = call(options.enabled); return ok and value == true end
    local function decode(raw) local ok, value = pcall(options.decode or json.decode, raw); return ok and value or nil end
    local function read(path)
        if type(options.read) == 'function' then local ok, raw = pcall(options.read, path); return ok and raw or nil end
        local file = io.open(path, 'rb')
        if not file then return nil end
        local raw = file:read(MAX_FILE + 1); file:close()
        return raw
    end
    local function status()
        local raw = read(M.STATUS)
        if type(raw) ~= 'string' or raw == '' or #raw > MAX_FILE then return nil, raw end
        local value = decode(raw)
        if type(value) ~= 'table' or value.version ~= 1 or type(value.revision) ~= 'number' then return nil, raw end
        return value, raw
    end

    -- The level titles, in the menu language (bridge/bonds.mjs LEVELS holds the same English titles).
    local function title(level)
        if level == 1 then return ui.t('Acquaintance') elseif level == 2 then return ui.t('Familiar face')
        elseif level == 3 then return ui.t('Friendly') elseif level == 4 then return ui.t('Friend')
        elseif level == 5 then return ui.t('Good friend') elseif level == 6 then return ui.t('Close friend')
        elseif level == 7 then return ui.t('Trusted') elseif level == 8 then return ui.t('Confidant')
        elseif level == 9 then return ui.t('Family') elseif level == 10 then return ui.t('Ride or die') end
        return nil
    end
    M.title = title

    local function whole(value, low, high)
        return type(value) == 'number' and value == value and value == math.floor(value) and value >= low and value <= high
    end

    -- The words of one change, or nil for a malformed one.
    function P.text(change)
        if type(change) ~= 'table' or not whole(change.to, 1, 10) or not whole(change.from, 1, 10) or change.to == change.from then return nil end
        local name = type(change.name) == 'string' and change.name ~= '' and #change.name <= 80 and not change.name:find('%c') and change.name or nil
        if not name then return nil end
        local vars = {name = name, level = change.to, title = title(change.to)}
        if change.to > change.from then return ui.t('Bond with {name}: level {level}, {title}', vars) end
        return ui.t('Bond with {name} fell: level {level}, {title}', vars)
    end

    -- A private turn V sends to a named character: its block, while the setting is On.
    function P.attach(context)
        if type(context) ~= 'table' or not enabled() then return nil end
        local copy = nil
        if not context.holocall then
            local ok, value = call(options.ownCopy, context.entity, context.profileKey)
            copy = ok and COPIES[value] and value or nil
        end
        context.bonds = {version = 1, on = true, copy = copy}
        -- The first turn of a session learns where the changes stand, so a change from before it is not shown again.
        if seen == nil then
            local value, raw = status()
            seen, lastRaw = value and value.revision or 0, raw
        end
        watchUntil, pollAt = clock() + WATCH_SECONDS, 0
        return context.bonds
    end

    function P.pending() return watchUntil ~= nil end

    -- From the 0.1 s tick, only while a watch is armed.
    function P.update(player)
        if not watchUntil then return end
        local now = clock()
        if now > watchUntil or not enabled() then watchUntil = nil; return end
        if now < pollAt then return end
        pollAt = now + POLL_SECONDS
        local value, raw = status()
        if raw == lastRaw then return end
        lastRaw = raw
        if not value or type(value.changes) ~= 'table' then return end
        local newest, shown = seen or 0, false
        for _, change in ipairs(value.changes) do
            if type(change) == 'table' and type(change.id) == 'number' and change.id > (seen or 0) then
                if change.id > newest then newest = change.id end
                local text = P.text(change)
                if text and type(options.notice) == 'function' then
                    pcall(options.notice, player, text); shown = true
                    log('person=' .. tostring(change.profileKey) .. ' level=' .. tostring(change.from) .. '->' .. tostring(change.to))
                end
            end
        end
        seen = newest
        if shown then watchUntil = nil end
    end

    return P
end

return M
