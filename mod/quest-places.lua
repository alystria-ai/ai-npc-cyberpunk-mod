-- Places of a bond quest (docs/QUEST_PRIMITIVES.md, BOND_QUESTS.md section 21 `place` and `pin`): the geometry of a fixed spot, the watch that says when V
-- arrived at it and when V left it, and the map pin of a meeting point. Pure: every native call comes in through options.world (mod/quest-world.lua), so the
-- whole module runs on a fake game in the tests (bridge/quest-places-lua.test.mjs). Nothing here runs per frame.
--
--   M.inside(place, position, slack)   the place holds the position: flat distance within the radius (times slack) and a generous height band
--   P.watch(ctx, id, place, opts)      arm a watch for this quest's stage (opts.dwell: seconds V must stay inside). Events go through ctx:emit:
--                                      place:<id>:arrived once (after the dwell) and place:<id>:left once after that, then the watch is over
--   P.pin(ctx, id, place)              a map pin on the place, ONE handle per pin, gone on arrival, on every exit of the stage and with the ctx
--   P.unpin(ctx, id) / P.pinsLost()    P.pinsLost: a save was loaded, the game kept none of the pins: the handles are dropped without calling the system
--   P.update()                         from the quest module's one-second step. One nil check while nothing is watched or pinned
--   P.snap(place)                      the place with its z snapped to the ground by one downward ray (cached by position), or the stored z
--
-- options: world {playerPosition() -> {x,y,z} | nil, rayDown(x, y, top, bottom) -> z | nil, pinAdd(x, y, z) -> handle | nil, pinRemove(handle),
--   district() -> {district, area} | nil}, clock() -> seconds (a monotonic real clock), log(line).
--
-- Reads of V's position: every 1 s while a watched place is near (within NEAR metres, or V is in the place's district), every 5 s otherwise.
local M = {NEAR = 300, FAST = 1, SLOW = 5, LEAVE_SLACK = 1.15, MAX_WATCHES = 16, MAX_PINS = 4, PIN_TRIES = 5, MAX_GROUND = 64}

local function finite(value) return type(value) == 'number' and value == value and math.abs(value) < 1e7 end

local function valid(place)
    return type(place) == 'table' and finite(place.x) and finite(place.y) and finite(place.z)
        and type(place.radius) == 'number' and place.radius > 0 and place.radius <= 2000
end
M.valid = valid

-- Flat distance within the radius (times `slack`) and |dz| within a generous band (the radius, at least 12 m and at most 60 m): a place in a tower is not
-- reached from the street below it, and a hillside spot is reached from its own slope.
function M.inside(place, position, slack)
    if not valid(place) or type(position) ~= 'table' or not finite(position.x) or not finite(position.y) or not finite(position.z) then return false end
    local radius = place.radius * (slack or 1)
    local dx, dy = position.x - place.x, position.y - place.y
    if dx * dx + dy * dy > radius * radius then return false end
    local band = place.zBand
    if type(band) ~= 'number' or band <= 0 then band = math.min(60, math.max(12, place.radius)) end
    return math.abs(position.z - place.z) <= band
end

function M.distance(place, position)
    local dx, dy = position.x - place.x, position.y - place.y
    return math.sqrt(dx * dx + dy * dy)
end

function M.new(options)
    options = options or {}
    local world = options.world or {}
    local P = {valid = valid, inside = M.inside, distance = M.distance}
    local watches, pins = {}, {}
    local pinCount, pinRetry = 0, 0
    local nextRead, nextDistrict, nextPin = 0, 0, 0
    local districtName, areaName = nil, nil
    local ground, groundCount = {}, 0

    local function clock()
        local ok, value = pcall(options.clock or os.clock)
        return ok and type(value) == 'number' and value or os.clock()
    end
    local function log(line) if type(options.log) == 'function' then pcall(options.log, 'Quest places: ' .. line) end end
    local function call(name, ...)
        local fn = world[name]
        if type(fn) ~= 'function' then return false, nil end
        return pcall(fn, ...)
    end

    -- One downward ray from 3 m above to 20 m below the stored z. Only a hit at or below z + 0.5 is a floor of this place (a roof above it is not).
    -- Cached by position, so a place is looked at once per session. A failed or silly read keeps the stored z.
    function P.snap(place)
        if not valid(place) then return place end
        local key = string.format('%.1f,%.1f,%.1f', place.x, place.y, place.z)
        local z = ground[key]
        if z == nil then
            z = place.z
            local ok, hit = call('rayDown', place.x, place.y, place.z + 3, place.z - 20)
            if ok and finite(hit) and hit <= place.z + 0.5 and hit >= place.z - 20 then z = hit end
            if groundCount >= M.MAX_GROUND then ground, groundCount = {}, 0 end
            ground[key], groundCount = z, groundCount + 1
        end
        if z == place.z then return place end
        local snapped = {}
        for k, v in pairs(place) do snapped[k] = v end
        snapped.z = z
        return snapped
    end

    -- ---- the watch ----------------------------------------------------------------------------------------------------------------------
    local function drop(list, record)
        for index = #list, 1, -1 do if list[index] == record then table.remove(list, index) end end
    end

    function P.watch(ctx, id, place, opts)
        if type(id) ~= 'string' or id == '' or not valid(place) then return nil end
        for _, w in ipairs(watches) do if w.ctx == ctx and w.id == id then return w end end
        if #watches >= M.MAX_WATCHES then log('too many watches'); return nil end
        local dwell = opts and tonumber(opts.dwell) or 0
        if dwell ~= dwell or dwell < 0 or dwell > 3600 then dwell = 0 end
        local w = {ctx = ctx, id = id, place = P.snap(place), dwell = dwell, arrived = false, insideSince = nil}
        watches[#watches + 1] = w
        nextRead = 0
        if ctx and ctx.track then ctx:track('watch', w, function() drop(watches, w) end) end
        return w
    end

    function P.unwatch(ctx, id)
        for index = #watches, 1, -1 do
            local w = watches[index]
            if w.ctx == ctx and (id == nil or w.id == id) then table.remove(watches, index) end
        end
    end

    local function emit(w, name)
        if w.ctx and w.ctx.emit then pcall(w.ctx.emit, w.ctx, name) end
    end

    -- The district V is in matches a watched place's `district` (read at most every 5 s, only when no watch is near by distance).
    local function inDistrict(w)
        local want = w.place.district
        if type(want) ~= 'string' or want == '' then return false end
        return want == districtName or want == areaName
    end

    local function readDistrict(now)
        if now < nextDistrict or type(world.district) ~= 'function' then return end
        nextDistrict = now + M.SLOW
        local ok, value = pcall(world.district)
        if ok and type(value) == 'table' then districtName, areaName = value.district, value.area
        else districtName, areaName = nil, nil end
    end

    local function watchStep(now)
        if #watches == 0 or now < nextRead then return end
        local ok, position = call('playerPosition')
        if not ok or type(position) ~= 'table' or not finite(position.x) or not finite(position.y) or not finite(position.z) then
            nextRead = now + M.SLOW
            return
        end
        -- Copy: an event can end a watch (a stage change reaps it).
        local list, near, events = {}, false, {}
        for index, w in ipairs(watches) do list[index] = w end
        for _, w in ipairs(list) do
            local here = M.inside(w.place, position, w.arrived and M.LEAVE_SLACK or 1)
            if not w.arrived then
                if here then
                    w.insideSince = w.insideSince or now
                    if now - w.insideSince >= w.dwell then
                        w.arrived = true
                        events[#events + 1] = {w, 'place:' .. w.id .. ':arrived'}
                    end
                else
                    w.insideSince = nil
                end
            elseif not here then
                events[#events + 1] = {w, 'place:' .. w.id .. ':left'}
                w.over = true
            end
            if not w.over and M.distance(w.place, position) <= M.NEAR + w.place.radius then near = true end
        end
        if not near then
            readDistrict(now)
            for _, w in ipairs(list) do
                if not w.over and inDistrict(w) then near = true; break end
            end
        end
        for index = #watches, 1, -1 do if watches[index].over then table.remove(watches, index) end end
        nextRead = now + (near and M.FAST or M.SLOW)
        for _, event in ipairs(events) do emit(event[1], event[2]) end
    end

    -- ---- the pin ------------------------------------------------------------------------------------------------------------------------
    -- A place the quest's journal entry already marks (mod/quest-journal.lua: the stage's waypoint, a quest pin of QuestLog.reds) gets no second pin: the
    -- record stands for it (pinned() is true) and nothing is registered or removed for it here.
    local JOURNAL = {}
    local function register(rec)
        if type(options.journalPin) == 'function' then
            local okJournal, marked = pcall(options.journalPin, rec.ctx, rec.id)
            if okJournal and marked == true then rec.handle = JOURNAL; return true end
        end
        local ok, handle = call('pinAdd', rec.place.x, rec.place.y, rec.place.z)
        if ok and handle ~= nil and handle ~= false then rec.handle = handle; return true end
        return false
    end

    function P.pin(ctx, id, place)
        if type(id) ~= 'string' or id == '' or not valid(place) then return nil end
        local key = tostring(ctx and ctx.pack or '') .. '/' .. id
        if pins[key] then return pins[key] end
        if pinCount >= M.MAX_PINS then log('too many pins'); return nil end
        local rec = {key = key, ctx = ctx, id = id, place = P.snap(place), tries = 0}
        pins[key], pinCount = rec, pinCount + 1
        rec.tries = 1
        if not register(rec) then pinRetry = pinRetry + 1; nextPin = clock() + M.SLOW end
        if ctx and ctx.track then ctx:track('pin', rec, function() P.unpin(ctx, id) end) end
        return rec
    end

    function P.unpin(ctx, id)
        local key = tostring(ctx and ctx.pack or '') .. '/' .. tostring(id)
        local rec = pins[key]
        if not rec then return false end
        pins[key], pinCount = nil, pinCount - 1
        if rec.handle ~= nil then
            local handle = rec.handle
            rec.handle = nil
            if handle ~= JOURNAL then call('pinRemove', handle) end
        elseif rec.tries < M.PIN_TRIES then
            pinRetry = math.max(0, pinRetry - 1)
        end
        return true
    end

    function P.pinned(ctx, id)
        local rec = pins[tostring(ctx and ctx.pack or '') .. '/' .. tostring(id)]
        return rec ~= nil and rec.handle ~= nil
    end

    -- A save was loaded: the game kept none of the pins. The handles are forgotten WITHOUT asking the system to remove them (they are dead), and a
    -- pin that is still wanted is made again by the stage that wants it (the quest module reaps and restores from the saved stage).
    function P.pinsLost()
        for _, rec in pairs(pins) do
            if rec.handle ~= nil then rec.handle = nil end
        end
        ground, groundCount = {}, 0
        districtName, areaName = nil, nil
        nextRead, nextDistrict = 0, 0
    end

    -- The world ended: no watch and no pin is kept, and the system is not asked about any of them.
    function P.forget()
        watches, pins, pinCount, pinRetry = {}, {}, 0, 0
        P.pinsLost()
    end

    local function pinStep(now)
        if pinRetry <= 0 or now < nextPin then return end
        nextPin = now + M.SLOW
        local waiting = 0
        for _, rec in pairs(pins) do
            if rec.handle == nil and rec.tries < M.PIN_TRIES then
                rec.tries = rec.tries + 1
                if not register(rec) then
                    if rec.tries < M.PIN_TRIES then waiting = waiting + 1 else log('pin ' .. rec.id .. ' could not be registered') end
                end
            end
        end
        pinRetry = waiting
    end

    -- From the quest module's one-second step.
    function P.update()
        if #watches == 0 and pinRetry <= 0 then return end
        local now = clock()
        watchStep(now)
        pinStep(now)
    end

    -- True while anything is watched or pinned (the quest module stays armed for it).
    function P.active() return #watches > 0 or pinCount > 0 end
    function P.status()
        local list = {}
        for _, w in ipairs(watches) do list[#list + 1] = {id = w.id, pack = w.ctx and w.ctx.pack, arrived = w.arrived} end
        local pinList = {}
        for _, rec in pairs(pins) do pinList[#pinList + 1] = {id = rec.id, pack = rec.ctx and rec.ctx.pack, registered = rec.handle ~= nil} end
        table.sort(pinList, function(a, b) return a.id < b.id end)
        return {watches = list, pins = pinList}
    end

    return P
end

return M
