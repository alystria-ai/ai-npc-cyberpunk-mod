-- Real quests for the story packs (docs/REAL_QUESTS.md), the Lua half. The bridge writes a journal block into the play file (bridge/quest-journal.mjs):
-- one row per pack in progress and per recently finished pack. mod/quest-play.lua hands it here every time it applies a play file, and this module tells the
-- game's quest log (r6/scripts/CyberpunkConvai/QuestLog.reds) what changed: a new quest, a new objective, an ending, a quest that went away.
--
--   J.apply(rows, opts)  opts {startup = bool, fresh = function(since) -> bool}. startup: a session start or a load, so a quest found now is not "new" (it
--                        takes the tracker only when nothing is tracked). fresh: drops a row stamped later than the loaded save, as the quest stages are.
--   J.clear(reason)      nothing is shown any more (Story packs went off, the play file is gone): the entries and their waypoints are removed
--   J.reset()            the world ended (a load, the main menu): the game's side forgets everything without asking the map (the pins went with the world).
--                        The next apply, from the restore of the new world, rebuilds the list from the bridge state
--   J.holding()          whether any quest is shown
--   J.status()           what is held, and the game side's own line
--
-- Event driven: nothing here runs per frame or on a timer. A play file applied with an unchanged journal block costs one string compare per row.
--
-- options: world {set(row, track) -> bool, remove(id) -> bool, clear(forget) -> bool, status() -> string | nil} (M.gameWorld below in the game),
--   read(path), decode(text) (the capture file, for a pack place measured in the game), log(line).
local M = {MAX_ROWS = 24, CAPTURE = 'runtime/quest-place-capture.json', MAX_FILE = 262144, MAX_TEXT = 600, LIMIT = 100000}
local STATES = {active = 0, succeeded = 1, failed = 2}

local function plainId(value) return type(value) == 'string' and #value > 0 and #value <= 80 and value:match('^[%w][%w%.:_%-]*$') ~= nil end
local function finite(value) return type(value) == 'number' and value == value and value > -M.LIMIT and value < M.LIMIT end
local function text(value, max)
    if type(value) ~= 'string' then return '' end
    if #value <= max then return value end
    return (value:sub(1, max):gsub('[\192-\255][\128-\191]*$', ''))
end

-- How a pin got its position, in words for the log: the stage's own place, the last place of an earlier stage, the quest's first place, a named place of its words, a landmark of
-- the character, or a place the developer probe measured in this game.
local ANCHORS = {stage = 'the stage\'s place', earlier = 'the place of an earlier stage', first = 'the quest\'s first place', named = 'a named place in its words',
    landmark = 'a landmark of the character', measured = 'a place measured in the game'}
function M.anchorText(anchor) return ANCHORS[anchor] or 'a known place' end

-- One row of the journal block, cleaned: nil when it is not usable.
function M.cleanRow(row)
    if type(row) ~= 'table' or not plainId(row.pack) or STATES[row.state] == nil then return nil end
    local title = text(row.title, 120)
    if title == '' then return nil end
    local out = {id = row.pack, title = title, description = text(row.description, M.MAX_TEXT), objective = text(row.objective, 160),
        state = row.state, since = (type(row.since) == 'number' and row.since >= 0 and row.since < 2e9) and math.floor(row.since) or nil}
    local place = row.place
    if type(place) == 'table' then
        out.placeId = plainId(place.id) and place.id or nil
        if finite(place.x) and finite(place.y) and finite(place.z) then out.x, out.y, out.z = place.x, place.y, place.z end
        -- Where the pin falls back to when the place has no position and the game never measured it (the bridge's chain, bridge/quest-journal.mjs pinPlace): the quest's
        -- earlier place, its first place, a named place in its words or a landmark of the character. Every started quest gets a pin.
        local fallback = place.fallback
        if type(fallback) == 'table' and finite(fallback.x) and finite(fallback.y) and finite(fallback.z) then
            out.fx, out.fy, out.fz, out.fallbackAnchor = fallback.x, fallback.y, fallback.z, text(fallback.anchor, 20)
        end
        out.anchor = type(place.anchor) == 'string' and text(place.anchor, 20) or nil
        out.hasPlace = true
    end
    return out
end

-- What the game side is told of a row: when this changes, the row is sent again.
local function signature(row)
    return table.concat({row.state, row.title, row.description, row.objective, tostring(row.since), tostring(row.x), tostring(row.y), tostring(row.z)}, '\31')
end

function M.new(options)
    options = options or {}
    local J = {}
    local world = options.world or {}
    local held = {}          -- id -> {signature, state}
    local count = 0
    local logged = {}

    local function log(line) if type(options.log) == 'function' then pcall(options.log, '[QuestJournal] ' .. line) end end
    local function logOnce(key, line) if not logged[key] then logged[key] = true; log(line) end end
    local function call(name, ...)
        local fn = world[name]
        if type(fn) ~= 'function' then return false end
        local ok, result = pcall(fn, ...)
        if not ok then logOnce('call:' .. name, name .. ' failed: ' .. tostring(result)); return false end
        return result ~= false
    end

    -- A pack place with no position takes the one the developer probe captured in this game (runtime/quest-place-capture.json, keyed by the place id),
    -- as the quest stages do. Read at most once per apply, and only when a row needs it.
    local capture = nil
    local function captured(id)
        if capture == nil then
            capture = false
            local okRead, raw = false, nil
            if type(options.read) == 'function' then okRead, raw = pcall(options.read, M.CAPTURE)
            else
                okRead, raw = pcall(function()
                    local file = io.open(M.CAPTURE, 'rb')
                    if not file then return nil end
                    local body = file:read(M.MAX_FILE + 1); file:close()
                    return body
                end)
            end
            local decode = options.decode or (type(json) == 'table' and json.decode) or nil
            if okRead and type(raw) == 'string' and raw ~= '' and #raw <= M.MAX_FILE and type(decode) == 'function' then
                local okDecode, value = pcall(decode, raw)
                if okDecode and type(value) == 'table' and type(value.places) == 'table' then capture = value.places end
            end
        end
        local got = capture and capture[id] or nil
        if type(got) == 'table' and finite(got.x) and finite(got.y) and finite(got.z) then return got end
        return nil
    end

    local function forgetAll()
        held, count = {}, 0
    end

    function J.apply(rows, opts)
        opts = opts or {}
        capture = nil
        -- A session start or a load: whatever the game side still holds belongs to the world before (its pins went with it). Forgotten, then rebuilt below.
        if opts.startup == true then
            call('clear', true)
            forgetAll()
        end
        if type(rows) ~= 'table' then
            if count > 0 then J.clear('no journal') end
            return 0
        end
        local wanted, order = {}, {}
        for _, raw in ipairs(rows) do
            if #order >= M.MAX_ROWS then break end
            local row = M.cleanRow(raw)
            if row and not wanted[row.id] and (type(opts.fresh) ~= 'function' or row.since == nil or opts.fresh(row.since)) then
                if row.hasPlace and row.x == nil and row.placeId then
                    local got = captured(row.placeId)
                    if got then row.x, row.y, row.z, row.anchor = got.x, got.y, got.z, 'measured' end
                end
                -- Still no position: the bridge's fallback, so the quest has a pin from the start.
                if row.hasPlace and row.x == nil and row.fx ~= nil then row.x, row.y, row.z, row.anchor = row.fx, row.fy, row.fz, row.fallbackAnchor or 'fallback' end
                wanted[row.id] = row
                order[#order + 1] = row
            end
        end
        -- Gone first: a quest the bridge no longer holds (rewound by a load, forgotten, finished by the story) leaves the journal and the map.
        local gone = {}
        for id in pairs(held) do if not wanted[id] then gone[#gone + 1] = id end end
        table.sort(gone)
        for _, id in ipairs(gone) do
            call('remove', id)
            held[id], count = nil, count - 1
        end
        local sent, startupTrack = 0, opts.startup == true
        for _, row in ipairs(order) do
            local sig = signature(row)
            local before = held[row.id]
            if not before or before.signature ~= sig then
                -- Who gets the tracker: a pack that just started takes it (the game side keeps a main job's); at a session start the newest quest in progress
                -- is tracked only if nothing else is.
                local track = 0
                -- (A hangout played again turns a finished row active: it starts again, so it counts as new.)
                if row.state == 'active' and (not before or before.state ~= 'active') then
                    if opts.startup then
                        if startupTrack then track = 1; startupTrack = false end
                    else track = 2 end
                end
                if call('set', row, track) then
                    if not before then count = count + 1 end
                    -- Only a pin at the stage's own place (the bridge's position or a measured one) counts as its waypoint: a fallback pin must not stop the pin primitive adding its own.
                    held[row.id] = {signature = sig, state = row.state, placeId = row.placeId, marked = row.x ~= nil and (row.anchor == nil or row.anchor == 'stage' or row.anchor == 'measured')}
                    sent = sent + 1
                    if not before or before.state ~= row.state then log(string.format('%s %s', row.id, row.state)) end
                    -- A quest that just started cannot be missed: besides the journal entry, the tracker line (when the tracker is free) and the map pin, a notice says it
                    -- is there (live 31 Oct 2026: a started pack showed nothing the owner noticed, because a main job held the tracker and nobody opened the journal).
                    if row.state == 'active' and (not before or before.state ~= 'active') and not opts.startup then
                        log(string.format('%s started: journal entry made, tracker %s, map pin %s, notice shown', row.id, track == 2 and 'taken when free' or 'not taken', row.x ~= nil and ('placed (' .. M.anchorText(row.anchor) .. ')') or 'none (the bridge named no place and no landmark)'))
                        if type(options.notice) == 'function' then
                            local okNotice, err = pcall(options.notice, row)
                            if not okNotice then logOnce('notice', 'the start notice failed: ' .. tostring(err)) end
                        end
                    end
                end
            end
        end
        return sent
    end

    function J.clear(reason)
        if count == 0 and next(held) == nil then return end
        call('clear', false)
        forgetAll()
        log('cleared' .. (reason and (' (' .. tostring(reason) .. ')') or ''))
    end

    function J.reset()
        call('clear', true)
        forgetAll()
    end

    function J.holding() return count > 0 end

    -- Whether the journal entry of `pack` marks its place `placeId` on the map now (the stage's waypoint): the pin primitive then adds no second pin.
    function J.waypoint(pack, placeId)
        local item = type(pack) == 'string' and held[pack] or nil
        return item ~= nil and item.state == 'active' and item.placeId == placeId and item.marked == true
    end

    function J.status()
        local ids = {}
        for id, item in pairs(held) do ids[#ids + 1] = id .. ':' .. item.state end
        table.sort(ids)
        local okStatus, line = false, nil
        if type(world.status) == 'function' then okStatus, line = pcall(world.status) end
        return {quests = count, held = table.concat(ids, ' '), game = okStatus and line or nil}
    end

    return J
end

-- The game side (r6/scripts/CyberpunkConvai/QuestLog.reds): the player's methods, each guarded. Scripts that did not compile have no such method, and then
-- nothing is shown (the quest still plays as talk and texts, as before).
function M.gameWorld(getPlayer)
    local function player()
        local ok, value = pcall(getPlayer)
        if ok and value ~= nil and value.ConvaiQuestLogSet ~= nil then return value end
        return nil
    end
    return {
        set = function(row, track)
            local p = player()
            if not p then return false end
            return p:ConvaiQuestLogSet(row.id, row.title, row.description, row.objective, STATES[row.state] or 0, row.since or -1,
                row.x ~= nil, row.x or 0, row.y or 0, row.z or 0, track or 0) == true
        end,
        remove = function(id)
            local p = player()
            return p ~= nil and p:ConvaiQuestLogRemove(id) == true
        end,
        clear = function(forget)
            local p = player()
            return p ~= nil and p:ConvaiQuestLogClear(forget == true) == true
        end,
        status = function()
            local p = player()
            return p and p:ConvaiQuestLogStatus() or nil
        end,
    }
end

return M
