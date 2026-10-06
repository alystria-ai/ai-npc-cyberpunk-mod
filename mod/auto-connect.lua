-- "Auto-connect nearby characters": decides which world characters (not part of
-- the party) get their conversation connection and local voice prepared before
-- the player speaks to them, and explains the wait when nothing was prepared.
--
-- Off (the default): nothing is prepared ahead. When the player starts talking
-- to a character that is not connected yet, talkNotice() returns the wait
-- notice, with a hint about this setting shown only twice per game session.
-- On: a character the player looks at for a moment, or stands near, is wanted.
-- At most two are kept warm, one new start every few seconds, never in combat
-- or scenes, with a cooldown after a release; an unused one is released after
-- a while. The wanted list is published to runtime/nearby-connections.json and
-- the bridge (bridge/nearby-warm.mjs) opens the connections and prepares the
-- voices. Nothing here touches the world, the party or a conversation.
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
local M = {version = 1}

M.DEFAULTS = {
    gazeDwell = 0.6,   -- seconds looking at one character before it is wanted
    radius = 5.0,      -- metres: standing this close also wants a character
    scanInterval = 1.0,
    maxWarm = 2,
    hold = 40,         -- seconds a character stays warm after it stops being wanted
    maxAge = 600,      -- the longest one character stays warm without a conversation
    cooldown = 20,     -- seconds before a released character may be warmed again
    ageCooldown = 180, -- ... after it was released for age
    stagger = 3,       -- seconds between two new warm-ups
    lookExpiry = 1.0,  -- a gaze sample older than this no longer counts
    heartbeat = 2,     -- the bridge treats a list older than a few seconds as empty
    hintLimit = 2,     -- how often the notice mentions the setting
}

local PATH = 'runtime/nearby-connections.json'
local STATE_PATH = 'runtime/party-connection-state.json'

local function readJson(path)
    local file = io.open(path, 'rb')
    if not file then return nil end
    local raw = file:read(262144); file:close()
    if type(raw) ~= 'string' or raw == '' then return nil end
    local ok, value = pcall(json.decode, raw)
    return ok and type(value) == 'table' and value or nil
end

-- The default publisher: an atomic runtime/nearby-connections.json.
local function publishFile(profiles)
    local encoded = {}
    for _, key in ipairs(profiles) do encoded[#encoded + 1] = json.encode(key) end
    local file = io.open(PATH .. '.tmp', 'wb')
    if not file then return false end
    file:write('{"updated":' .. string.format('%.0f', os.time() * 1000) .. ',"profiles":[' .. table.concat(encoded, ',') .. ']}')
    file:close()
    os.remove(PATH)
    return os.rename(PATH .. '.tmp', PATH) ~= nil
end

-- True when the bridge reports this character's private connection ready.
local readCache = {at = nil, value = nil}
local function connectionReady(key)
    local now = os.time()
    if readCache.at ~= now then readCache = {at = now, value = readJson(STATE_PATH)} end
    local state = readCache.value
    if type(state) ~= 'table' or type(state.connections) ~= 'table' then return false end
    for _, connection in ipairs(state.connections) do
        if connection.profile == key and connection.scope == 'private' and connection.state == 'ready' then return true end
    end
    return false
end

function M.new(options)
    options = options or {}
    local cfg = {}
    for key, value in pairs(M.DEFAULTS) do cfg[key] = options[key] or value end
    local A = {}
    local clock, nextScan, lastStart = 0, 0, -math.huge
    local look = {}
    local active, cooling = {}, {}
    local lastSignature, lastPublish = nil, nil
    local hintsShown = 0
    local publish = options.publish or publishFile
    local ready = options.ready or connectionReady
    local wall = options.wall or os.time

    local function enabled()
        if type(options.enabled) ~= 'function' then return false end
        local ok, value = pcall(options.enabled)
        return ok and value == true
    end

    local function log(line)
        if type(options.log) == 'function' then pcall(options.log, line) end
    end

    local function keys()
        local result = {}
        for _, entry in ipairs(active) do result[#result + 1] = entry.key end
        return result
    end

    local function push(force)
        local list = keys()
        local signature = table.concat(list, ',')
        local now = wall()
        if not force and signature == lastSignature and lastPublish and now - lastPublish < cfg.heartbeat then return end
        if pcall(publish, list) then lastSignature, lastPublish = signature, now end
    end

    local function releaseAll(reason)
        if #active > 0 then log('Auto-connect released all: ' .. reason) end
        active = {}
    end

    -- A gaze sample, about every 0.2 s: the character V is facing (a profile
    -- that is enabled and not already in the party), or nil.
    function A.look(key, entity, name, dt)
        if not key or not entity then look = {}; return end
        if look.key ~= key or look.entity ~= entity then look = {key = key, entity = entity, name = name, dwell = 0} end
        look.dwell = look.dwell + (tonumber(dt) or 0)
        look.seen = clock
    end

    -- The notice for the wait at the start of a conversation, or nil when the
    -- character is already connected. The hint about this setting is shown
    -- only twice per game session and only while the setting is off.
    function A.talkNotice(key, name)
        if not key or ready(key) then return nil end
        if not enabled() and hintsShown < cfg.hintLimit then
            hintsShown = hintsShown + 1
            return ui.t('Preparing connection to {name}… (turn on Auto-connect to skip this wait)', {name = name})
        end
        return ui.t('Preparing connection to {name}…', {name = name})
    end

    -- Every frame, also while a menu pauses the game: keeps the list fresh for
    -- the bridge, which drops a list that stops being refreshed.
    function A.heartbeat()
        if #active > 0 or lastSignature ~= nil and lastSignature ~= '' then push(false) end
    end

    -- context: worldReady, blocked (combat, scene, call, vehicle), player,
    -- talking (the profile key of a conversation in progress, if any).
    function A.update(dt, context)
        context = context or {}
        if not enabled() then
            if #active > 0 or (lastSignature ~= nil and lastSignature ~= '') then
                releaseAll('setting off'); push(true)
            end
            look = {}
            return
        end
        if context.worldReady ~= true then return end
        clock = clock + (tonumber(dt) or 0)
        if look.key and clock - (look.seen or 0) > cfg.lookExpiry then look = {} end

        local wanted, order = {}, {}
        local function want(key, name, priority, distance)
            if not wanted[key] then
                wanted[key] = {key = key, name = name, priority = priority, distance = distance or 0}
                order[#order + 1] = wanted[key]
            elseif priority < wanted[key].priority then wanted[key].priority = priority end
        end
        if context.talking then want(context.talking, nil, 0, 0) end
        if look.key and look.dwell >= cfg.gazeDwell then want(look.key, look.name, 1, 0) end
        if not context.blocked and clock >= nextScan and type(options.scan) == 'function' then
            nextScan = clock + cfg.scanInterval
            local called, rows = pcall(options.scan, context.player, cfg.radius)
            if called and type(rows) == 'table' then
                for _, row in ipairs(rows) do want(row.key, row.name, 2, row.distance) end
            end
        end
        table.sort(order, function(a, b)
            if a.priority ~= b.priority then return a.priority < b.priority end
            if a.distance ~= b.distance then return a.distance < b.distance end
            return a.key < b.key
        end)

        -- Refresh what is wanted; release what has been idle or too long.
        for index = #active, 1, -1 do
            local entry = active[index]
            local item = wanted[entry.key]
            if item then
                entry.lastWanted = clock
                if item.priority == 0 then entry.since = clock end
            end
            local idle, age = clock - entry.lastWanted, clock - entry.since
            if idle > cfg.hold or age > cfg.maxAge then
                cooling[entry.key] = clock + (age > cfg.maxAge and cfg.ageCooldown or cfg.cooldown)
                log('Auto-connect released ' .. entry.key .. (age > cfg.maxAge and ' (unused too long)' or ' (idle)'))
                table.remove(active, index)
            end
        end

        -- Admit new characters, best first, within the limits.
        if not context.blocked then
            for _, item in ipairs(order) do
                local key = item.key
                local present = false
                for _, entry in ipairs(active) do if entry.key == key then present = true end end
                if not present and item.priority > 0 and (cooling[key] or 0) <= clock
                    and clock - lastStart >= cfg.stagger
                    and not (type(options.party) == 'function' and options.party(key)) then
                    if #active >= cfg.maxWarm then
                        -- A looked-at character may take the place of the idlest one
                        -- that nobody wants right now.
                        local idlest
                        for index, entry in ipairs(active) do
                            if not wanted[entry.key] and (not idlest or entry.lastWanted < active[idlest].lastWanted) then idlest = index end
                        end
                        if item.priority == 1 and idlest then
                            cooling[active[idlest].key] = clock + cfg.cooldown
                            log('Auto-connect released ' .. active[idlest].key .. ' (replaced)')
                            table.remove(active, idlest)
                        end
                    end
                    if #active < cfg.maxWarm then
                        active[#active + 1] = {key = key, name = item.name, since = clock, lastWanted = clock,
                            reason = item.priority == 1 and 'gaze' or 'near'}
                        lastStart = clock
                        log('Auto-connect warming ' .. key .. ' (' .. active[#active].reason .. ')')
                    end
                end
            end
        end
        push(false)
    end

    function A.reset()
        local had = #active > 0
        active, cooling, look = {}, {}, {}
        nextScan, lastStart = 0, -math.huge
        if had or (lastSignature ~= nil and lastSignature ~= '') then push(true) end
    end

    function A.active() return keys() end
    function A.inspect()
        local rows = {}
        for _, entry in ipairs(active) do
            rows[#rows + 1] = {key = entry.key, reason = entry.reason, since = entry.since, lastWanted = entry.lastWanted}
        end
        return {active = rows, hintsShown = hintsShown, clock = clock, look = look.key}
    end

    return A
end

return M
