-- Characters text first (docs/QUEST_PRIMITIVES.md section 10.7, bridge/reach-outs.mjs): a character texts, calls or (Johnny) speaks up in V's head at a prepared moment, with
-- a fixed line. The bridge decides WHICH reach-outs may fire (it writes them into the play file's `reach` block: items, perHour, perDay, enabled) and this module decides
-- WHEN, at moments that already exist, and delivers. Nothing here is a model call.
--
--   R.setBlock(block)       the play file's reach block, cleaned by mod/quest-play.lua (P.reach, and options.onReach on the owner side). An empty list or a block that is
--                           not enabled cancels the timer. A new block keeps the ids already delivered while it still lists them.
--   R.districtChanged()     the game pushed a district change (the PreventionSystem hook init.lua already has): one evaluation, at most one per 5 s
--   R.sample(fighting)      the 0.5 s battle sample's verdict (init.lua updateBattles): the end of a fight is the fall from true to false, one evaluation with a snapshot of
--                           V's health, the heat and the district at that moment (kept 120 s, so a busy refusal at the moment gets two more chances, at the ticks)
--   R.update()              from the 0.1 s tick: ONE nil check while the timer does not run. While it runs: a clock compare, once a second the setting is looked at, and
--                           every 60 s (real time) the tick: refresh the play file, read what the items need (hour, weather, heat, district, song, V's place) and evaluate
--   R.reset(reason)         the world ended or the setting went off: the timer, the fight snapshot, the dwell and the idle watch, the delivered ids and the fired stamps go
--   R.status()              what the module holds
--
-- The timer runs ONLY while the block lists an item and the setting is on. It is this module's one timer, owned here (no ctx: a reach-out belongs to no quest), and it is
-- cancelled by reset, by an empty or disabled block and by the setting going off. Nothing is persisted: the fired stamps live in memory (game seconds), a loaded older save
-- starts a new module state anyway (init.lua resets on every world change) and a stamp later than the clock is dropped.
--
-- Caps (the game's own, the bridge hides the list while it counts the same): at most perHour (1) delivery per game hour and perDay (3) per game day, across all characters.
-- No game clock means no delivery. Never while options.busy() says so (init.lua: the same test the scripted line player uses, convaiQuestLineBusy: a scene, a quest
-- dialogue, a game call, a fight or a chase, V talking, a reply on its way).
--
-- Conditions (bridge/reach-outs.mjs), each false when what it needs cannot be read (never silently true):
--   (absent)                         the next evaluation that passes the busy test
--   weather {is}                     the weather kind (clear, cloudy, rain, heavy-rain, toxic-rain, fog, smog, sandstorm). "rain" also holds for heavy and toxic rain, "dust" and
--                                    "sand" mean sandstorm, "sun" clear, "mist" fog
--   hours {from, to, idle?}          the game hour in [from, to), a window may wrap midnight (22 to 5). idle: true = V has not moved (3 m) between two ticks, a number = V has
--                                    stood there for that many game minutes (position is read at the tick, only while an item asks for idle)
--   district {is, minutes?}          V is in that district or area (names compare without case, spaces or underscores, any part of an area name counts), minutes = V has been
--                                    in the district for that many game minutes (counted from the first time this module saw V there, so never early)
--   fight-end {healthBelow?, heatAtLeast?, district?}   at the end of a fight (the snapshot above): V's health percent below, the heat stage at least, the district as above
--   heat {atLeast}                   the police heat stage (0 to 5) at least
--   song {contains?}                 a song or station is playing (the radio of the car or the pocket radio), containing the text (case-insensitive) if one is given
--
-- Delivery: via 'text' = a Phone Chat message from the character (options.text(profileKey, text, image), init.lua convaiQuestPhone: the path a `text` row of a quest takes),
-- via 'call' = options.call(item) when mod/quest-calls.lua provides convaiQuestCallIn (it answers nil when absent), else the same text (the pack's English text, no words added),
-- via 'voice' = options.voice(item): Johnny in V's head, only while his route is free (mod/johnny-head.lua refusal), his fixed text as a caption, no model.
-- A delivered item raises reach:<id> (options.emit, mod/quest-play.lua P.emitReach) and is not delivered again while the block still lists it.
--
-- UNVERIFIED in the game (offline-tested on a fake game only): the district hook (PreventionSystem OnDistrictAreaEntered, the one init.lua already uses), the reads (hour,
-- weather, heat and song come from mod/quest-world-drive.lua, health is the stat pool percent, the district is init.lua's currentDistrict, V's place is GetWorldPosition),
-- the Phone Chat delivery and its notice, Johnny's caption, and the "call me" path through convaiQuestCallIn (its signature is a guess: convaiQuestCallIn(profileKey, text, id)).
local M = {TICK = 60, CHECK = 1, SLACK = 120, HOUR = 3600, DAY = 86400, DISTRICT_GAP = 5, FIGHT_WINDOW = 120, PER_HOUR = 1, PER_DAY = 3, MAX_STAMPS = 24,
    STILL_METRES = 3, TRIES = 3}

local function norm(text) return type(text) == 'string' and text:lower():gsub('[^%w]', '') or '' end

-- Weather words a reach-out may use, mapped to the kinds of the turn context.
local WEATHER = {rain = {rain = true, ['heavy-rain'] = true, ['toxic-rain'] = true}, dust = {sandstorm = true}, sand = {sandstorm = true}, ['dust-storm'] = {sandstorm = true},
    sun = {clear = true}, sunny = {clear = true}, mist = {fog = true}, storm = {['heavy-rain'] = true, sandstorm = true}}
local function weatherHolds(want, kind)
    if type(want) ~= 'string' or type(kind) ~= 'string' then return false end
    want = want:lower()
    if want == kind then return true end
    local set = WEATHER[want]
    return set ~= nil and set[kind] == true
end

-- V is in the district: the wanted name equals the top district or the area, or one of their parts split at underscores (Westbrook_Japantown holds Japantown).
local function districtHolds(want, where)
    if type(want) ~= 'string' or type(where) ~= 'table' then return false end
    local wanted = norm(want)
    if wanted == '' then return false end
    for _, name in ipairs({where.district, where.area}) do
        if type(name) == 'string' then
            if norm(name) == wanted then return true end
            for part in name:gmatch('[^_]+') do if norm(part) == wanted then return true end end
        end
    end
    return false
end

local function number(value, low, high) return type(value) == 'number' and value == value and value >= low and value <= high end

function M.new(options)
    options = options or {}
    local R = {}
    local reads = type(options.read) == 'table' and options.read or {}
    local items, caps = {}, {perHour = M.PER_HOUR, perDay = M.PER_DAY}
    local tickAt, checkAt = nil, 0           -- the one timer (real clock seconds), nil = not running
    local stamps, delivered = {}, {}          -- game seconds of the deliveries, ids delivered and still listed
    local wasFighting, fightEnd = nil, nil    -- the battle sample's last verdict, {at, health, heat, district} of the last fight end
    local entered, still, districtAt = nil, nil, nil   -- the district dwell {key, at}, the idle watch {x, y, z, since, count}, the real clock of the last district evaluation
    local needIdle, needDwell, needFight = false, false, false   -- what the listed items ask for (set by setBlock): the idle watch, the district dwell, the fight-end snapshot
    local logged = {}

    local function log(line) if type(options.log) == 'function' then pcall(options.log, 'Reach-outs: ' .. line) end end
    local function logOnce(key, line) if not logged[key] then logged[key] = true; log(line) end end
    local function clock()
        local ok, value = pcall(options.clock or os.clock)
        return ok and type(value) == 'number' and value or os.clock()
    end
    local function gameTime()
        if type(options.gameTime) ~= 'function' then return nil end
        local ok, value = pcall(options.gameTime)
        return ok and type(value) == 'number' and value == value and value >= 0 and value or nil
    end
    local function enabled()
        if type(options.enabled) ~= 'function' then return false end
        local ok, value = pcall(options.enabled)
        return ok and value == true
    end

    -- Stop everything the module started: the timer and what it watches. `all` also forgets the deliveries (a world change).
    local function stop(all)
        tickAt, checkAt = nil, 0
        items, wasFighting, fightEnd, entered, still, districtAt = {}, nil, nil, nil, nil, nil
        needIdle, needDwell, needFight = false, false, false
        delivered = {}
        if all then stamps = {} end
    end

    -- ---- caps ------------------------------------------------------------------------------------------------------------------------
    local function capsAllow(now)
        local kept, hour, day = {}, 0, 0
        for _, at in ipairs(stamps) do
            if at <= now + M.SLACK and at > now - M.DAY then
                kept[#kept + 1] = at
                day = day + 1
                if at > now - M.HOUR then hour = hour + 1 end
            end
        end
        stamps = kept
        return hour < caps.perHour and day < caps.perDay
    end

    -- ---- reads (memoised for one evaluation, each guarded: an unreadable value is false) ---------------------------------------------------
    local function newReader()
        local cache = {}
        return function(name)
            local held = cache[name]
            if held == nil then
                held = false
                local fn = reads[name]
                if type(fn) == 'function' then
                    local ok, a, b, c = pcall(fn)
                    if ok and a ~= nil then held = {a, b, c} end
                end
                cache[name] = held
            end
            if held == false then return nil end
            return held[1], held[2], held[3]
        end
    end

    local function noteDistrict(where, now)
        if type(where) ~= 'table' then return end
        local key = norm(where.district ~= nil and where.district or where.area)
        if key == '' then return end
        if entered == nil or entered.key ~= key then entered = {key = key, at = now} end
    end

    -- ---- conditions ------------------------------------------------------------------------------------------------------------------
    local function holds(when, now, read)
        if when == nil then return true end
        if type(when) ~= 'table' then return false end
        local kind = when.kind
        if kind == 'weather' then
            return weatherHolds(when.is, read('weather'))
        elseif kind == 'hours' then
            local hour, minute = read('hour')
            if not number(hour, 0, 24) or not number(minute or 0, 0, 59.999) then return false end
            local at = hour + (minute or 0) / 60
            if not number(when.from, 0, 24) or not number(when.to, 0, 24) or when.from == when.to then return false end
            local inside
            if when.from < when.to then inside = at >= when.from and at < when.to else inside = at >= when.from or at < when.to end
            if not inside then return false end
            if when.idle == nil then return true end
            if still == nil or still.count < 1 then return false end
            if when.idle == true then return true end
            if not number(when.idle, 1, 120) or now == nil then return false end
            return now - still.since >= when.idle * 60
        elseif kind == 'district' then
            local where = read('district')
            if not districtHolds(when.is, where) then return false end
            if when.minutes == nil then return true end
            if not number(when.minutes, 1, 120) or entered == nil or now == nil then return false end
            return now - entered.at >= when.minutes * 60
        elseif kind == 'fight-end' then
            local fight = fightEnd
            if fight == nil then return false end
            if when.healthBelow ~= nil and not (number(when.healthBelow, 0, 100) and number(fight.health, 0, 100) and fight.health < when.healthBelow) then return false end
            if when.heatAtLeast ~= nil and not (number(when.heatAtLeast, 0, 5) and number(fight.heat, 0, 5) and fight.heat >= when.heatAtLeast) then return false end
            if when.district ~= nil and not districtHolds(when.district, fight.district) then return false end
            return true
        elseif kind == 'heat' then
            local heat = read('heat')
            return number(when.atLeast, 0, 5) and number(heat, 0, 5) and heat >= when.atLeast
        elseif kind == 'song' then
            local song = read('song')
            if type(song) ~= 'table' or song.playing ~= true then return false end
            if when.contains == nil then return true end
            if type(when.contains) ~= 'string' or when.contains == '' then return false end
            local wanted = when.contains:lower()
            for _, text in ipairs({song.song, song.station}) do
                if type(text) == 'string' and text:lower():find(wanted, 1, true) then return true end
            end
            return false
        end
        return false   -- a kind this module does not know
    end

    -- ---- delivery --------------------------------------------------------------------------------------------------------------------
    local function deliver(item)
        local ok, done = false, false
        if item.via == 'voice' then
            if type(options.voice) == 'function' then ok, done = pcall(options.voice, item) end
        else
            if item.via == 'call' and type(options.call) == 'function' then
                local callOk, answer = pcall(options.call, item)
                if callOk and answer ~= nil then return answer == true end   -- nil: no call system, the text goes instead
            end
            if type(options.text) == 'function' then ok, done = pcall(options.text, item.character, item.text, item.image) end
        end
        if not ok then logOnce('deliver:' .. item.id, 'delivery of ' .. item.id .. ' failed: ' .. tostring(done)) end
        return ok and done == true
    end

    -- The character stands beside V (options.near, init.lua: one of V's copies within talking distance). Asked only for an item that is otherwise ready.
    local function beside(profileKey)
        if type(options.near) ~= 'function' then return false end
        local ok, near = pcall(options.near, profileKey)
        return ok and near == true
    end

    -- One evaluation at a moment ('tick', 'district' or 'fight-end'). Returns the id delivered, or nil and why.
    local function consider(moment)
        if tickAt == nil then return nil, 'off' end
        if not enabled() then stop(false); return nil, 'setting' end
        local now = gameTime()
        if now == nil then return nil, 'no-clock' end
        if not capsAllow(now) then return nil, 'caps' end
        if fightEnd and clock() - fightEnd.at > M.FIGHT_WINDOW then fightEnd = nil end
        local read = newReader()
        if needDwell then noteDistrict(read('district'), now) end
        local ready = {}
        for _, item in ipairs(items) do
            -- A text or a call from someone who stands beside V is odd: it waits (still listed, tried again at the next tick) until she is not near.
            if not delivered[item.id] and holds(item.when, now, read) and not (item.via ~= 'voice' and beside(item.character)) then ready[#ready + 1] = item end
        end
        if #ready == 0 then return nil, 'no-match' end
        local busy = true
        if type(options.busy) == 'function' then
            local ok, value = pcall(options.busy)
            busy = not ok or value ~= false
        end
        if busy then return nil, 'busy' end
        for index, item in ipairs(ready) do
            if index > M.TRIES then break end
            if deliver(item) then
                delivered[item.id] = true
                stamps[#stamps + 1] = now
                if #stamps > M.MAX_STAMPS then table.remove(stamps, 1) end
                fightEnd = nil
                if type(options.emit) == 'function' then
                    local ok, err = pcall(options.emit, item.id)
                    if not ok then logOnce('emit:' .. item.id, 'the event reach:' .. item.id .. ' could not be raised: ' .. tostring(err)) end
                end
                log('delivered ' .. item.id .. ' via ' .. item.via .. ' at ' .. moment)
                return item.id
            end
        end
        return nil, 'not-delivered'
    end

    -- The idle watch: V's place at each tick (only while an item asks for idle). Unmoved since the last tick counts one, moving starts over.
    local function watchStill(now)
        if not needIdle then still = nil; return end
        local ok, place = pcall(reads.position or function() return nil end)
        if not ok or type(place) ~= 'table' or not number(place.x, -1e7, 1e7) or not number(place.y, -1e7, 1e7) then still = nil; return end
        if still ~= nil then
            local dx, dy = place.x - still.x, place.y - still.y
            if dx * dx + dy * dy <= M.STILL_METRES * M.STILL_METRES then still.count = still.count + 1; return end
        end
        still = {x = place.x, y = place.y, since = now or 0, count = 0}
    end

    local function tick()
        if type(options.refresh) == 'function' then pcall(options.refresh) end
        if tickAt == nil then return end   -- the refreshed play file had nothing left to watch
        watchStill(gameTime())
        consider('tick')
    end

    -- ---- entry points ----------------------------------------------------------------------------------------------------------------
    function R.setBlock(block)
        local list = type(block) == 'table' and type(block.items) == 'table' and block.enabled == true and block.items or nil
        if list == nil or #list == 0 then stop(false); return false end
        local listed = {}
        for _, item in ipairs(list) do listed[item.id] = true end
        for id in pairs(delivered) do if not listed[id] then delivered[id] = nil end end
        items = list
        caps = {perHour = number(block.perHour, 1, 6) and block.perHour or M.PER_HOUR, perDay = number(block.perDay, 1, 12) and block.perDay or M.PER_DAY}
        needIdle, needDwell, needFight = false, false, false
        for _, item in ipairs(items) do
            local when = item.when
            if type(when) == 'table' then
                if when.kind == 'hours' and when.idle ~= nil then needIdle = true end
                if when.kind == 'district' and when.minutes ~= nil then needDwell = true end
                if when.kind == 'fight-end' then needFight = true end
            end
        end
        if tickAt == nil and enabled() then
            tickAt, checkAt = clock() + M.TICK, 0
            logged = {}
        end
        return tickAt ~= nil
    end

    function R.districtChanged()
        if tickAt == nil then return end
        local now = clock()
        if districtAt ~= nil and now >= districtAt and now - districtAt < M.DISTRICT_GAP then return end
        districtAt = now
        consider('district')
    end

    function R.sample(fighting)
        if tickAt == nil then wasFighting = nil; return end
        if fighting == true then wasFighting = true; return end
        if wasFighting ~= true then return end
        wasFighting = false
        if not needFight then return end
        local read = newReader()
        local where = read('district')
        fightEnd = {at = clock(), health = read('health'), heat = read('heat'), district = type(where) == 'table' and where or nil}
        consider('fight-end')
    end

    function R.update()
        if tickAt == nil then return end
        local now = clock()
        -- Once a second: is the setting still on (a switch turned off cancels the timer within a second).
        if now >= checkAt or checkAt - now > M.CHECK then
            checkAt = now + M.CHECK
            if not enabled() then stop(false); return end
        end
        if now >= tickAt then
            -- Every 60 s of real time, counted from the schedule (not from when the tick ran), unless the game stalled for longer than a period.
            tickAt = tickAt + M.TICK
            if tickAt <= now then tickAt = now + M.TICK end
            local ok, err = pcall(tick)
            if not ok then logOnce('tick', 'the tick failed: ' .. tostring(err)) end
        end
    end

    function R.reset(reason)
        stop(true)
        logged = {}
    end

    function R.active() return tickAt ~= nil end

    function R.status()
        return {running = tickAt ~= nil, items = #items, delivered = (function() local n = 0 for _ in pairs(delivered) do n = n + 1 end return n end)(),
            stamps = #stamps, perHour = caps.perHour, perDay = caps.perDay, fightEnd = fightEnd ~= nil, idleWatch = needIdle,
            nextTickIn = tickAt and math.max(0, tickAt - clock()) or nil}
    end

    return R
end

return M
