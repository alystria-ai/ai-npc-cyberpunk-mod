-- The RACE group of bond quest primitives (docs/QUEST_PRIMITIVES.md, BOND_QUESTS.md section 21): race and convoy. They are added to the registry of
-- mod/quest-prims.lua by install(R, env), which the primitive module calls through R.extend. Each one is a small table {interval, arm(ctx, spec, env) -> state,
-- tick(ctx, spec, state, env)}. Pure: every native read and command goes through env.world, and install adds the game's side of them from mod/quest-world-drive.lua
-- and mod/quest-world-race.lua when the world adapter does not have them yet, so the whole file runs on a fake game in the tests.
--
-- UNVERIFIED in the game: offline-tested on a fake game only. The natives are listed in mod/quest-world-race.lua and mod/quest-world-drive.lua, and the
-- behavior of a copy driving her own car (the seat calls, the drive command, a column of cars following each other) has never been seen running.
--
-- Cost: nothing here runs per frame. A race is stepped once a second while armed (V's vehicle, the copy's car, the heat read every second step). A convoy is stepped once a
-- second (one lookup per car) and sends the follow command of each follower every 2 s. Nothing is read before the stage arms it.
-- An entity handle is never kept across ticks: spawns are kept as the IDs of driveSpawn and looked up again at each step, used only once the game has attached them.
-- Only the mod's own copy and its own tagged cars are touched, never a character or a car the game placed. The ctx reaps everything (the copy gets out of her car first).
-- The car is a clone of a vanilla record with no police affiliation (request.neutral, mod/quest-tweak.lua), the vanilla record when the clone cannot be made.
--
--   race      race:<id>:started, :won, :lost, :void, :timeout, :stopped      (in: race:<id>:go)
--   convoy    convoy:<id>:started, :leg<N>, :arrived, :lost-one, :failed, :rerouted, :fallback      (in: convoy:<id>:go, convoy:<id>:reroute)
--
-- race: her car (a tagged car she drives, seated with the visitor seat calls, so she must be a copy placed through a cast, not a party member) waits at the line `from`
-- until race:<id>:go or `headStart` seconds after she sits in it (no `from`: she leaves as soon as she sits), then drives to `to` with the drive-to-point command while V drives.
-- Each side has arrived when its car is inside the finish place (a step across it between two samples counts), never by the command's own flag. First to arrive wins:
-- won when it is V, lost when it is her (a tie goes to V). reversed: the slowest to arrive wins, and a side that stands still for stillSeconds (default 5) before arriving loses:
-- race:<id>:stopped, then the won or lost event of the other side. Her speed is `speed` (14 m/s, 6 in a reversed race). heat: a wanted level voids it (race:<id>:void), as does
-- anything that stops the race from being run (the copy or her car is gone, she cannot get in, the car cannot drive). limitMinutes (game minutes from the start) is race:<id>:timeout.
--
-- convoy: a column of friendly tagged cars drives the legs of `route`: route[1] is where the column stands, route[2] on are the places it drives to, in order.
-- lead 'self' (default): the copy in her car leads and `cars` (default 2) spawned cars with nameless drivers (spec.driver, a Character record) follow. lead 'cars': a spawned
-- car with a driver leads and `cars` follow. Each follower is told to follow the car ahead of it every 2 s. convoy:<id>:leg<N> when the lead reaches the Nth place, convoy:<id>:arrived
-- at the last one. convoy:<id>:lost-one once for each follower that is destroyed, has a dead driver, or stays more than 120 m behind the car ahead for 20 s (the column goes on
-- without it). convoy:<id>:failed when the lead is lost, cannot be made, or limitMinutes passes. convoy:<id>:reroute (raised by the stage) replaces the legs still to drive
-- with spec.reroute (convoy:<id>:rerouted). fallback: when the followers cannot be driven in a column (a spawn fails five times, a driver cannot get in, the follow command is
-- refused four times in a row) they are removed, the lead goes on alone and convoy:<id>:fallback says so. Extra, optional field holdLegs (a list of leg numbers, 0 is the
-- start): the column stops there until convoy:<id>:go. The cars are made when V is within 150 m of route[1].
local M = {
    SPAWN_DISTANCE = 150, SPAWN_TRIES = 5, SPAWN_RETRY = 3, ATTACH_TIMEOUT = 20, MOUNT_TRIES = 3, MOUNT_RETRY = 4,
    SEAT_TRIES = 3, SEAT_RETRY = 4, NEVER_SEEN = 30, LOST_AFTER = 2, CAR_MISS = 3, FOLLOWER_MISS = 2,
    WAIT_CAP = 1200, HEAT_STEP = 2, STILL_SPEED = 0.8, STILL_GRACE = 3, STUCK_SECONDS = 6, MAX_RESENDS = 4, SEND_TRIES = 3, SEAT_LOST = 3,
    SEGMENT = 120, GAME_SECONDS_PER_SECOND = 30,
    RACE_SPEED = 14, REVERSED_SPEED = 6,
    CONVOY_SPEED = 12, CONVOY_SPACING = 10, CONVOY_GAP = 12, FOLLOW_STEP = 2, LAG_METRES = 120, LAG_SECONDS = 20, REFUSED_LIMIT = 4,
    DEFAULT_CARS = 2,
}

local atan2 = math.atan2 or function(y, x) return math.atan(y, x) end

local function finite(value) return type(value) == 'number' and value == value and math.abs(value) < 1e7 end
local function point(p) return type(p) == 'table' and finite(p.x) and finite(p.y) and finite(p.z) end
local function plain(p) return {x = p.x, y = p.y, z = p.z} end
local function flat(a, b) local dx, dy = a.x - b.x, a.y - b.y; return math.sqrt(dx * dx + dy * dy) end
local function number(value, low, high, default)
    if type(value) ~= 'number' or value ~= value or value < low or value > high then return default end
    return value
end
local function eventId(value, default)
    if type(value) == 'string' and #value > 0 and #value <= 60 and value:match('^[%w][%w%.%-_]*$') then return value end
    return default
end

-- Closest approach of the flat segment a -> b to a centre, with the height interpolated: lets a car that crossed a place between two samples count.
local function closest(a, b, centre)
    local dx, dy = b.x - a.x, b.y - a.y
    local length2 = dx * dx + dy * dy
    local t = 0
    if length2 > 1e-6 then t = math.max(0, math.min(1, ((centre.x - a.x) * dx + (centre.y - a.y) * dy) / length2)) end
    return {x = a.x + t * dx, y = a.y + t * dy, z = a.z + t * (b.z - a.z)}
end

function M.install(R, env)
    local function log(line) if type(env.log) == 'function' then pcall(env.log, 'Quest primitive: ' .. line) end end
    local function clock()
        local ok, value = pcall(env.clock or os.clock)
        return ok and type(value) == 'number' and value or os.clock()
    end
    local function gameTime()
        if type(env.gameTime) ~= 'function' then return nil end
        local ok, value = pcall(env.gameTime)
        return ok and type(value) == 'number' and value == value and value or nil
    end
    local function call(name, ...)
        local fn = env.world and env.world[name]
        if type(fn) ~= 'function' then return nil end
        local ok, a, b = pcall(fn, ...)
        if not ok then return nil end
        return a, b
    end
    local function placeOf(ctx, id)
        local place = type(ctx.places) == 'table' and ctx.places[id] or nil
        if type(place) ~= 'table' or not (env.places and env.places.valid(place)) then return nil end
        return place
    end
    local function playerAt()
        local p = call('playerPosition')
        return point(p) and plain(p) or nil
    end
    local function copyAt(ctx)
        local copy = call('copyOf', ctx.character)
        if type(copy) ~= 'table' or not point(copy.position) then return nil end
        return {kind = copy.kind, serial = copy.serial, position = plain(copy.position)}
    end

    -- The game's side of the calls, from the native modules, for every name the world adapter does not have yet (a test world has its own).
    local function natives(probe, file)
        if type(env.world) ~= 'table' or env.world[probe] ~= nil or type(dofile) ~= 'function' then return end
        local loaded, module = pcall(dofile, file)
        if loaded and type(module) == 'table' and type(module.new) == 'function' then
            local built, found = pcall(module.new, {log = env.log})
            if built and type(found) == 'table' then
                for key, fn in pairs(found) do if env.world[key] == nil then env.world[key] = fn end end
            else
                log('the natives of ' .. file .. ' could not be built: ' .. tostring(found))
            end
        else
            log('the natives of ' .. file .. ' could not be loaded: ' .. tostring(module))
        end
    end
    natives('driveSpawn', 'quest-world-drive.lua')
    natives('raceRead', 'quest-world-race.lua')

    local function yawToward(from, to)
        return math.deg(atan2(-(to.x - from.x), to.y - from.y))
    end

    -- One car of a race or a convoy: {request, spawnAt, yaw, tries, nextTry, handle, ...}. The request is copied at each spawn try and gets the spot.
    local function newCar(request, spawnAt, yaw)
        return {request = request, spawnAt = spawnAt, yaw = yaw, tries = 0, nextTry = 0, handle = nil, spawnedAt = nil, seen = false, miss = 0,
            mountTries = 0, nextMount = 0, seatTries = 0, nextSeat = 0, seatSerial = nil, gotOut = false, prev = nil, prevAt = nil, speed = nil}
    end

    -- Makes the car when V is within 150 m of `gateAt` (any distance when nil), at most five tries three seconds apart. 'ok', 'wait' or 'failed'.
    -- The car is tracked on the ctx at once: its undo gets the copy out of it and deletes it.
    local function spawn(ctx, car, now, gateAt, label)
        if car.handle then return 'ok' end
        if car.tries >= M.SPAWN_TRIES then return 'failed' end
        if now < car.nextTry then return 'wait' end
        local vpos = playerAt()
        if not vpos then return 'wait' end
        if gateAt and flat(vpos, gateAt) > M.SPAWN_DISTANCE then return 'wait' end
        local request = {}
        for key, value in pairs(car.request) do request[key] = value end
        request.x, request.y, request.z, request.yaw = car.spawnAt.x, car.spawnAt.y, car.spawnAt.z, car.yaw
        car.tries, car.nextTry = car.tries + 1, now + M.SPAWN_RETRY
        local handle, why = call('driveSpawn', request)
        if handle then
            local tracked = ctx:track(label, handle, function(h)
                if car.seatSerial and not car.gotOut then call('postCarMount', car.seatSerial, h, true) end
                call('driveDelete', h)
            end)
            if tracked then
                car.handle, car.spawnedAt = handle, now
                return 'ok'
            end
            return 'wait'
        end
        log(label .. ' spawn try ' .. car.tries .. ' failed: ' .. tostring(why))
        if car.tries >= M.SPAWN_TRIES then return 'failed' end
        return 'wait'
    end

    -- A fresh look at the car: nil until the game has attached it (the caller counts the misses).
    local function lookAt(car)
        if not car.handle then return nil end
        local look = call('driveLookup', car.handle)
        if type(look) ~= 'table' or look.attached ~= true or not point(look.position) then return nil end
        return look
    end

    -- The driver of a spawned car gets into the seat (three tries four seconds apart), the caller verifies with the lookup. 'in', 'wait' or 'failed'.
    local function seatDriver(car, look, now)
        if look.driverIn == true then return 'in' end
        if car.mountTries >= M.MOUNT_TRIES and now >= car.nextMount then return 'failed' end
        if car.mountTries < M.MOUNT_TRIES and now >= car.nextMount then
            car.mountTries, car.nextMount = car.mountTries + 1, now + M.MOUNT_RETRY
            call('driveMountDriver', car.handle)
        end
        return 'wait'
    end

    -- The copy gets into the driver seat of her car (the visitor mount, three tries four seconds apart). 'in', 'wait' or 'failed'.
    local function seatCopy(car, serial, now)
        if call('postCarMounted', serial, car.handle) == true then return 'in' end
        if car.seatTries >= M.SEAT_TRIES and now >= car.nextSeat then return 'failed' end
        if car.seatTries < M.SEAT_TRIES and now >= car.nextSeat then
            car.seatTries, car.nextSeat, car.seatSerial = car.seatTries + 1, now + M.SEAT_RETRY, serial
            call('postCarMount', serial, car.handle, false)
        end
        return 'wait'
    end

    local function getOut(car)
        if car.seatSerial and not car.gotOut and car.handle then
            car.gotOut = true
            call('postCarMount', car.seatSerial, car.handle, true)
        end
    end

    -- Resolves route-like lists of places to {place, point}. nil when one is not in the stage.
    local function resolve(ctx, list, minimum, who)
        if type(list) ~= 'table' or #list < minimum or #list > 32 then return nil end
        local out = {}
        for index, id in ipairs(list) do
            local place = type(id) == 'string' and eventId(id) and placeOf(ctx, id) or nil
            if not place then log(who .. ': place ' .. tostring(id) .. ' is not in the stage'); return nil end
            local spot = env.places.snap(place)
            out[index] = {id = id, place = place, point = {x = spot.x, y = spot.y, z = spot.z}}
        end
        return out
    end

    -- Judges one side (V's vehicle or her car) at a sample: its speed, whether it stood still, whether it crossed the finish place.
    local function sample(side, pos, now, finish, counts)
        local prev = side.prev
        if prev and flat(prev, pos) > M.SEGMENT then prev = nil end
        local dt = side.prevAt and now - side.prevAt or nil
        if prev and dt and dt > 0.2 then
            local speed = flat(side.prev, pos) / dt
            side.speed = speed
            if speed > 1.0 then side.moved = true end
            if speed < M.STILL_SPEED then side.stillFor = side.stillFor + dt else side.stillFor = 0 end
        end
        if counts and not side.arrived then
            if env.places.inside(finish, pos) or (prev ~= nil and env.places.inside(finish, closest(prev, pos, finish))) then
                side.arrived, side.arrivedAt = true, now
            end
        end
        side.prev, side.prevAt = pos, now
    end

    -- ---- race ---------------------------------------------------------------------------------------------------------------------------
    R.defs.race = {
        interval = 1,
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('race has no id'); return nil end
            local to = placeOf(ctx, spec.to)
            if not to or not eventId(spec.to) then log('race ' .. id .. ': place ' .. tostring(spec.to) .. ' is not in the stage'); return nil end
            local from, spawnAt
            if spec.from ~= nil then
                from = placeOf(ctx, spec.from)
                if not from or not eventId(spec.from) then log('race ' .. id .. ': place ' .. tostring(spec.from) .. ' is not in the stage'); return nil end
                local spot = env.places.snap(from)
                spawnAt = {x = spot.x, y = spot.y, z = spot.z}
            end
            local finishSpot = env.places.snap(to)
            local finish = {x = finishSpot.x, y = finishSpot.y, z = finishSpot.z}
            local reversed = spec.reversed == true
            local state = {id = id, to = to, finish = finish, hasFrom = from ~= nil, reversed = reversed, heat = spec.heat == true,
                limit = number(spec.limitMinutes, 0.1, 1440, nil), headStart = number(spec.headStart, 0, 600, nil), still = number(spec.stillSeconds, 2, 120, 5),
                speed = number(spec.speed, 1, 100, reversed and M.REVERSED_SPEED or M.RACE_SPEED),
                phase = 'prepare', since = clock(), seen = false, miss = 0, go = false, over = false, nextHeat = 0, sendTries = 0, seatMiss = 0, carMiss = 0,
                resends = 0, lastSend = 0, sent = false,
                v = {stillFor = 0, moved = false, arrived = false}, c = {stillFor = 0, moved = false, arrived = false},
                car = newCar({kind = 'car', vehicle = type(spec.vehicle) == 'string' and spec.vehicle or nil, tag = ctx.tag, neutral = true}, spawnAt, spawnAt and yawToward(spawnAt, finish) or 0)}
            ctx:on('race:' .. id .. ':go', function() if not state.over then state.go = true end end)
            return state
        end,
        tick = function(ctx, spec, state)
            if state.over then return end
            local now = clock()
            local car = state.car
            local function name(what) return 'race:' .. state.id .. ':' .. what end
            -- The race is over: her car stops, she gets out, then the events (a listener may reap the ctx).
            local function conclude(...)
                state.over = true
                if car.handle then call('driveBrake', car.handle) end
                getOut(car)
                for _, event in ipairs({...}) do
                    ctx:emit(name(event))
                    if ctx.reaped then return end
                end
            end
            local function void(why)
                if why then log('race ' .. state.id .. ' void: ' .. why) end
                conclude('void')
            end
            if state.heat and now >= state.nextHeat then
                state.nextHeat = now + M.HEAT_STEP
                local heat = call('readHeat')
                if type(heat) == 'number' and heat >= 1 then void('a wanted level'); return end
            end

            if state.phase == 'prepare' then
                local copy = copyAt(ctx)
                if not copy then
                    state.miss = state.miss + 1
                    if (state.seen and state.miss >= M.LOST_AFTER) or (not state.seen and now - state.since >= M.NEVER_SEEN) then void('the copy is gone') end
                    return
                end
                state.seen, state.miss, state.serial = true, 0, copy.serial
                if copy.kind == 'party' then void('she is in the party, a race needs a copy placed through a cast'); return end
                if not car.spawnAt then
                    car.spawnAt = {x = copy.position.x, y = copy.position.y, z = copy.position.z}
                    car.yaw = yawToward(car.spawnAt, state.finish)
                end
                local made = spawn(ctx, car, now, car.spawnAt, 'race-car')
                if made == 'failed' then void('her car could not be made'); return end
                if made ~= 'ok' then return end
                local look = lookAt(car)
                if not look then
                    if now - car.spawnedAt > M.ATTACH_TIMEOUT then void('her car never attached') end
                    return
                end
                local seat = seatCopy(car, copy.serial, now)
                if seat == 'failed' then void('she could not get into the car'); return end
                if seat == 'wait' then return end
                state.phase, state.readyAt = 'wait', now
                return
            end

            local look = lookAt(car)
            if not look then
                state.carMiss = state.carMiss + 1
                if state.carMiss >= M.CAR_MISS then void('her car is gone') end
                return
            end
            state.carMiss = 0

            if state.phase == 'wait' then
                if state.go or not state.hasFrom or (state.headStart and now - state.readyAt >= state.headStart) then
                    state.phase = 'start'
                elseif now - state.readyAt > M.WAIT_CAP then
                    void('nobody gave the start')
                    return
                else
                    return
                end
            end

            if state.phase == 'start' then
                if call('driveTo', car.handle, state.finish, state.speed) == true then
                    state.phase, state.startedAt, state.startGame, state.lastSend = 'run', now, gameTime(), now
                    ctx:emit(name('started'))
                    return
                end
                state.sendTries = state.sendTries + 1
                log('race ' .. state.id .. ': the drive command was refused, try ' .. state.sendTries)
                if state.sendTries >= M.SEND_TRIES then void('her car cannot drive') end
                return
            end

            -- Running. She must still sit in her car.
            if call('postCarMounted', state.serial, car.handle) == true then state.seatMiss = 0
            else
                state.seatMiss = state.seatMiss + 1
                if state.seatMiss >= M.SEAT_LOST then void('she left the car'); return end
            end
            if state.limit then
                local game = gameTime()
                local elapsed
                if game and state.startGame then elapsed = game - state.startGame else elapsed = (now - state.startedAt) * M.GAME_SECONDS_PER_SECOND end
                if elapsed >= state.limit * 60 then conclude('timeout'); return end
            end
            local read = call('raceRead')
            if type(read) ~= 'table' and type(env.world.rideRead) == 'function' then read = call('rideRead', ctx.character) end
            local v, c = state.v, state.c
            if type(read) == 'table' and point(read.at) then sample(v, plain(read.at), now, state.to, read.driving == true) end
            sample(c, plain(look.position), now, state.to, true)
            if c.arrived and not state.braked then state.braked = true; call('driveBrake', car.handle) end

            if state.reversed then
                -- A side that stands still before it has arrived loses. V gets a short grace after the start, she counts once she has moved.
                local vStill = not v.arrived and v.stillFor >= state.still and now - state.startedAt >= M.STILL_GRACE
                local cStill = not c.arrived and c.moved and c.stillFor >= state.still
                if vStill then conclude('stopped', 'lost'); return end
                if cStill then conclude('stopped', 'won'); return end
                if v.arrived and c.arrived then
                    if v.arrivedAt >= c.arrivedAt then conclude('won') else conclude('lost') end
                    return
                end
            else
                if v.arrived or c.arrived then
                    if v.arrived and (not c.arrived or v.arrivedAt <= c.arrivedAt) then conclude('won') else conclude('lost') end
                    return
                end
            end
            -- Her car stands still on the way: the command is sent again, a few times.
            if c.speed and c.speed < M.STILL_SPEED and not c.arrived and now - state.lastSend >= M.STUCK_SECONDS and state.resends < M.MAX_RESENDS then
                state.resends, state.lastSend = state.resends + 1, now
                call('driveTo', car.handle, state.finish, state.speed)
            end
        end,
    }

    -- ---- convoy -------------------------------------------------------------------------------------------------------------------------
    R.defs.convoy = {
        interval = 1,
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('convoy has no id'); return nil end
            local route = resolve(ctx, spec.route, 2, 'convoy ' .. id)
            if not route then log('convoy ' .. id .. ' has no route of two places or more'); return nil end
            local reroute
            if spec.reroute ~= nil then
                reroute = resolve(ctx, spec.reroute, 1, 'convoy ' .. id)
                if not reroute then log('convoy ' .. id .. ': the reroute is dropped') end
            end
            local lead = spec.lead == 'cars' and 'cars' or 'self'
            local driver = type(spec.driver) == 'string' and spec.driver or (type(spec.record) == 'string' and spec.record or nil)
            local vehicle = type(spec.vehicle) == 'string' and spec.vehicle or nil
            local count = math.floor(number(spec.cars, 1, 3, M.DEFAULT_CARS))
            local start = route[1].point
            local first = route[2].point
            local dx, dy = first.x - start.x, first.y - start.y
            local length = math.sqrt(dx * dx + dy * dy)
            if length < 1 then dx, dy, length = 0, 1, 1 end
            local yaw = yawToward(start, first)
            local column = {}
            for index = 1, count + 1 do
                local back = (index - 1) * M.CONVOY_SPACING
                local spot = {x = start.x - dx / length * back, y = start.y - dy / length * back, z = start.z}
                local request = {kind = 'car', vehicle = vehicle, tag = ctx.tag, neutral = true}
                local role = index == 1 and 'lead' or 'follower'
                if driver and not (index == 1 and lead == 'self') then request.driver = driver end
                local car = newCar(request, spot, yaw)
                car.role, car.index = role, index
                car.needsDriver = not (index == 1 and lead == 'self')
                car.lagFor, car.refused, car.nextFollow = 0, 0, 0
                column[index] = car
            end
            local dests = {}
            for index = 2, #route do dests[#dests + 1] = route[index] end
            local holds = {}
            if type(spec.holdLegs) == 'table' then
                for _, leg in ipairs(spec.holdLegs) do if type(leg) == 'number' and leg >= 0 and leg <= 32 then holds[math.floor(leg)] = true end end
            end
            local state = {id = id, lead = lead, column = column, dests = dests, leg = 1, reached = 0, reroute = reroute, rerouteAsked = false, holds = holds,
                fallback = spec.fallback == true, limit = number(spec.limitMinutes, 0.1, 1440, nil), speed = number(spec.speed, 1, 60, M.CONVOY_SPEED),
                gate = {x = start.x, y = start.y, z = start.z}, phase = 'spawn', since = clock(), over = false, go = false, sentLeg = 0, resends = 0, lastSend = 0,
                seatMiss = 0, fellBack = false, leadPrev = nil, leadPrevAt = nil, rerouted = false, noDriver = driver == nil}
            -- Followers need nameless drivers. Without a record they cannot be driven at all (the first step says so).
            if driver == nil then log('convoy ' .. id .. ' has no driver record for its cars') end
            ctx:on('convoy:' .. id .. ':go', function() if not state.over then state.go = true end end)
            -- A reroute also releases a column that is held at a leg end.
            ctx:on('convoy:' .. id .. ':reroute', function()
                if state.over or state.rerouted then return end
                if not state.reroute then log('convoy ' .. id .. ': a reroute was asked and the stage has none'); return end
                state.rerouteAsked = true
                if state.phase == 'hold' then state.go = true end
            end)
            return state
        end,
        tick = function(ctx, spec, state)
            if state.over then return end
            local now = clock()
            local column = state.column
            local function name(what) return 'convoy:' .. state.id .. ':' .. what end
            local function leadCar() return column[1] end

            -- Every car stops, the copy gets out, then the event.
            local function conclude(event)
                state.over = true
                for _, car in ipairs(column) do
                    if car.handle and not car.lost then call('driveBrake', car.handle) end
                    getOut(car)
                end
                ctx:emit(name(event))
            end
            -- The followers cannot be driven in a column: with fallback they are removed and the lead goes on alone, else the convoy has failed.
            local function broken(why)
                log('convoy ' .. state.id .. ': the column cannot be driven (' .. why .. ')')
                if not state.fallback then conclude('failed'); return false end
                if state.fellBack then return true end
                state.fellBack = true
                for index = #column, 2, -1 do
                    local car = column[index]
                    if car.handle and type(ctx.untrack) == 'function' then ctx:untrack(car.handle, true) end
                    column[index] = nil
                end
                ctx:emit(name('fallback'))
                return not ctx.reaped and not state.over
            end
            local function failed(why)
                log('convoy ' .. state.id .. ' failed: ' .. why)
                conclude('failed')
            end

            if state.phase == 'spawn' or state.phase == 'assemble' then
                if state.noDriver and (state.lead == 'cars' or #column > 1) then
                    -- No driver record: a column cannot be made. The lead alone can only be the copy in her car.
                    if state.lead == 'cars' then failed('no driver record'); return end
                    if not broken('no driver record') then return end
                end
                if state.lead == 'self' then
                    local copy = copyAt(ctx)
                    if not copy then
                        state.miss = (state.miss or 0) + 1
                        if (state.seen and state.miss >= M.LOST_AFTER) or (not state.seen and now - state.since >= M.NEVER_SEEN) then failed('the copy is gone') end
                        return
                    end
                    state.seen, state.miss, state.serial = true, 0, copy.serial
                    if copy.kind == 'party' then failed('she is in the party, the lead needs a copy placed through a cast'); return end
                end
                -- Spawn in order, the lead first. A car that waits holds the cars behind it back this step.
                for index, car in ipairs(column) do
                    local made = spawn(ctx, car, now, state.gate, 'convoy-car')
                    if made == 'failed' then
                        if index == 1 then failed('the lead car could not be made'); return end
                        if not broken('a car could not be made') then return end
                        break
                    elseif made ~= 'ok' then
                        return
                    end
                end
                state.phase = 'assemble'
                -- Every car attached, every driver (or the copy) in the seat.
                local ready = true
                for index = 1, #column do
                    local car = column[index]
                    local look = lookAt(car)
                    local status
                    if not look then
                        status = (now - car.spawnedAt > M.ATTACH_TIMEOUT) and 'failed' or 'wait'
                    elseif car.needsDriver then
                        status = seatDriver(car, look, now)
                        if status == 'in' and look.alive == false then status = 'failed' end
                    else
                        status = seatCopy(car, state.serial, now)
                    end
                    if status == 'failed' then
                        if index == 1 then failed('the lead car could not be made ready'); return end
                        if not broken('a car could not be made ready') then return end
                        break
                    elseif status ~= 'in' then
                        ready = false
                    end
                end
                if not ready then return end
                state.phase = state.holds[0] and 'hold' or 'launch'
                state.readyAt = now
                if state.phase == 'hold' then return end
            end

            if state.phase == 'hold' then
                if not state.go then return end
                state.go, state.phase = false, state.startedAt and 'run' or 'launch'
            end

            if state.phase == 'launch' then
                state.phase, state.startedAt, state.startGame = 'run', now, gameTime()
                ctx:emit(name('started'))
                if ctx.reaped or state.over then return end
            end

            -- ---- running ----
            if state.limit then
                local game = gameTime()
                local elapsed
                if game and state.startGame then elapsed = game - state.startGame else elapsed = (now - state.startedAt) * M.GAME_SECONDS_PER_SECOND end
                if elapsed >= state.limit * 60 then failed('the time ran out'); return end
            end
            -- Look at every car. The lead lost ends the convoy, a follower lost is told once and the column goes on without it.
            local looks = {}
            for index, car in ipairs(column) do
                if not car.lost then
                    local look = lookAt(car)
                    if look and look.alive ~= false then
                        car.miss = 0
                        looks[index] = look
                    else
                        car.miss = car.miss + 1
                        local dead = look ~= nil and look.alive == false
                        if index == 1 then
                            if dead or car.miss >= M.CAR_MISS then failed('the lead is lost'); return end
                        elseif dead or car.miss >= M.FOLLOWER_MISS then
                            car.lost = true
                            ctx:emit(name('lost-one'))
                            if ctx.reaped or state.over then return end
                        end
                    end
                end
            end
            if not looks[1] then return end
            local leadLook = looks[1]
            if state.lead == 'self' then
                if call('postCarMounted', state.serial, column[1].handle) == true then state.seatMiss = 0
                else
                    state.seatMiss = state.seatMiss + 1
                    if state.seatMiss >= M.SEAT_LOST then failed('she left the car'); return end
                end
            end
            local leadPos = plain(leadLook.position)
            local prev = state.leadPrev
            if prev and flat(prev, leadPos) > M.SEGMENT then prev = nil end
            local dt = state.leadPrevAt and now - state.leadPrevAt or nil
            local leadSpeed
            if state.leadPrev and dt and dt > 0.2 then leadSpeed = flat(state.leadPrev, leadPos) / dt end
            state.leadPrev, state.leadPrevAt = leadPos, now

            -- A reroute asked by the stage replaces the legs still to drive.
            if state.rerouteAsked and not state.rerouted then
                state.rerouted, state.rerouteAsked = true, false
                for index = #state.dests, state.leg, -1 do state.dests[index] = nil end
                for _, item in ipairs(state.reroute) do state.dests[#state.dests + 1] = item end
                state.sentLeg = 0
                ctx:emit(name('rerouted'))
                if ctx.reaped or state.over then return end
            end

            -- Followers: told to follow the car ahead of them every two seconds. A follower far behind for 20 s is lost.
            local ahead = column[1]
            local aheadLook = leadLook
            for index = 2, #column do
                local car = column[index]
                if not car.lost and looks[index] then
                    local look = looks[index]
                    if aheadLook and flat(look.position, aheadLook.position) > M.LAG_METRES then car.lagFor = car.lagFor + (dt or 1) else car.lagFor = 0 end
                    if car.lagFor >= M.LAG_SECONDS then
                        car.lost = true
                        ctx:emit(name('lost-one'))
                        if ctx.reaped or state.over then return end
                    elseif now >= car.nextFollow then
                        car.nextFollow = now + M.FOLLOW_STEP
                        if call('driveFollowCar', car.handle, ahead.handle, M.CONVOY_GAP) == true then car.refused = 0
                        else
                            car.refused = car.refused + 1
                            if car.refused >= M.REFUSED_LIMIT then
                                if not broken('the follow command is refused') then return end
                                break
                            end
                        end
                    end
                    if not car.lost then ahead, aheadLook = car, look end
                end
            end
            if state.phase == 'hold' then return end

            -- The lead's leg: the drive command is sent once per leg, the leg is reached when the lead is inside the place (a step across it counts).
            local dest = state.dests[state.leg]
            if not dest then conclude('arrived'); return end
            if state.sentLeg ~= state.leg then
                state.sentLeg, state.lastSend, state.resends = state.leg, now, 0
                if call('driveTo', column[1].handle, dest.point, state.speed) ~= true then
                    log('convoy ' .. state.id .. ': the drive command to leg ' .. state.leg .. ' was refused')
                end
                return
            end
            if env.places.inside(dest.place, leadPos) or (prev ~= nil and env.places.inside(dest.place, closest(prev, leadPos, dest.place))) then
                state.reached = state.reached + 1
                local last = state.leg >= #state.dests
                ctx:emit(name('leg' .. state.reached))
                if ctx.reaped or state.over then return end
                if last then conclude('arrived'); return end
                state.leg = state.leg + 1
                if state.holds[state.reached] then
                    call('driveBrake', column[1].handle)
                    state.phase, state.go = 'hold', false
                end
                return
            end
            -- The lead stands still on the way: the command is sent again a few times, then the convoy has failed.
            if leadSpeed and leadSpeed < M.STILL_SPEED and now - state.lastSend >= M.STUCK_SECONDS then
                state.resends, state.lastSend = state.resends + 1, now
                if state.resends > M.MAX_RESENDS then failed('the lead is stuck on leg ' .. state.leg); return end
                call('driveTo', column[1].handle, dest.point, state.speed)
            end
        end,
    }
end

return M
