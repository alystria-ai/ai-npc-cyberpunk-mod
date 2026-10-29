-- The DRIVE group of bond quest primitives (docs/QUEST_PRIMITIVES.md, BOND_QUESTS.md section 21): ride, post, remote, runner, tail and check. They are added to
-- the registry of mod/quest-prims.lua by install(R, env), which the primitive module calls through R.extend. Each one is a small table {interval, arm(ctx, spec,
-- env) -> state, tick(ctx, spec, state, env), disarm}. Pure: every native read and command goes through env.world, and install adds the game's side of them
-- from mod/quest-world-drive.lua when the world adapter does not have them yet, so the whole file runs on a fake game in the tests.
--
-- Cost: nothing here runs per frame. While armed a primitive is stepped once a second at most (ride samples V's vehicle and position at 1 Hz, post every 2 s,
-- remote every second and every 5 s while V is far from its dead zone, runner and tail once a second, check not at all after its one read).
-- An entity handle is never kept across ticks: spawns are kept as IDs and looked up again at each step, used only once the game has attached them.
-- A primitive only acts on the mod's own copies and its own tagged spawns, never on a character or a car the game placed. The ctx reaps everything.
--
--   ride      ride:started, ride:checkpoint:<place>, ride:arrived, ride:timeout, ride:abandoned, ride:failed-heat
--   post      post:<id>:set, post:<id>:lost, post:<id>:released, post:<id>:fighting (in: post:<id>:fight and the spec's release event)
--   remote    remote:silenced, remote:resumed
--   runner    runner:<id>:stopped, runner:<id>:caught, runner:<id>:lost
--   tail      tail:<id>:noticed, tail:<id>:lost
--   check     check:<id>:<value> with a bounded vocabulary (in: check:<id>:go)
-- A runner or tail car asks for the neutral clone of its vehicle record (request.neutral, mod/quest-tweak.lua through the natives): boardable, no police marker.
local M = {
    RIDE_FOOT = 120,          -- real seconds V does not drive before the ride is abandoned
    RIDE_COPY_OUT = 20,       -- real seconds the copy is out of the car before the ride is abandoned
    RIDE_SEGMENT = 120,       -- a step of the car longer than this is a jump (a load, a fast travel), not a drive through a place
    HEAT_STEP = 2,
    SPAWN_DISTANCE = 150, SPAWN_TRIES = 5, SPAWN_RETRY = 3, ATTACH_TIMEOUT = 20, MOUNT_TRIES = 3, MOUNT_RETRY = 4,
    LOST_AFTER = 2, NEVER_SEEN = 30,
    POST_WALK_TIMEOUT = 90, POST_WALK_RETRY = 8, POST_MAX_WALKS = 8, POST_HOLD_REFRESH = 30, POST_DRIFT = 4, POST_MAX_DRIFTS = 3, POST_MOUNT_TRIES = 3, POST_MOUNT_RETRY = 6,
    RUNNER_LOST_METRES = 250, RUNNER_LOST_SECONDS = 5, RUNNER_RESEND = 6, RUNNER_MAX_RESENDS = 6, RUNNER_MISS = 3,
    TAIL_FOLLOW = 4, TAIL_FAR_SECONDS = 10, TAIL_BEHIND = 40,
    NEAR = 300, LEAVE_SLACK = 1.15, REMOTE_SLOW = 5,
    GAME_SECONDS_PER_SECOND = 30,
}

local STANCES = {stand = true, prone = true, car = true}
local WEATHER = {clear = true, cloudy = true, rain = true, ['heavy-rain'] = true, ['toxic-rain'] = true, fog = true, smog = true, sandstorm = true}
local SLOTS = {head = true, face = true, outerTorso = true, innerTorso = true, legs = true, feet = true, outfit = true}
local CHECKS = {hour = true, weather = true, heat = true, song = true, gear = true, item = true, district = true, radio = true}
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
local function eventName(value) return type(value) == 'string' and #value > 0 and #value <= 120 and value:match('^[%w][%w:%-_%.]*$') ~= nil end

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

    -- The game's side of the calls, from the native module, for every name the world adapter does not have yet (a test world has its own).
    if type(env.world) == 'table' and env.world.rideRead == nil and type(dofile) == 'function' then
        local loaded, module = pcall(dofile, 'quest-world-drive.lua')
        if loaded and type(module) == 'table' and type(module.new) == 'function' then
            local built, natives = pcall(module.new, {log = env.log})
            if built and type(natives) == 'table' then
                for key, fn in pairs(natives) do if env.world[key] == nil then env.world[key] = fn end end
            else
                log('the drive natives could not be built: ' .. tostring(natives))
            end
        else
            log('the drive natives could not be loaded: ' .. tostring(module))
        end
    end

    -- A spawned car or pedestrian, made lazily and kept as a handle of IDs. The spot is state.spawnAt (a point) or behind V by state.behind metres.
    -- Made only when V is within 150 m of a fixed spot, retried up to five times, and removed with the ctx.
    local function trySpawn(ctx, state, now, label)
        if state.handle then return true end
        if state.tries >= M.SPAWN_TRIES or now < state.nextTry then return false end
        local vpos = playerAt()
        if not vpos then return false end
        local request = {}
        for key, value in pairs(state.request) do request[key] = value end
        local from = state.spawnAt
        if from then
            if flat(vpos, from) > M.SPAWN_DISTANCE then return false end
            request.x, request.y, request.z, request.yaw = from.x, from.y, from.z, state.yaw
        else
            local behind = call('behindPlayer', state.behind)
            if not point(behind) then return false end
            request.x, request.y, request.z, request.yaw = behind.x, behind.y, behind.z, behind.yaw
        end
        state.tries, state.nextTry = state.tries + 1, now + M.SPAWN_RETRY
        local handle, why = call('driveSpawn', request)
        if handle then
            if ctx:track(label, handle, function(h) call('driveDelete', h) end) then
                state.handle, state.spawnedAt = handle, now
                return true
            end
            return false
        end
        log(label .. ' ' .. tostring(state.id) .. ' spawn try ' .. state.tries .. ' failed: ' .. tostring(why))
        return false
    end

    -- The driver of a car gets into the seat (tried up to three times, four seconds apart) and the caller verifies it with the lookup. Returns 'in', 'wait' or 'failed'.
    local function seatDriver(state, look, now)
        if look.driverIn == true then return 'in' end
        if state.mountTries >= M.MOUNT_TRIES and now >= state.nextMount then return 'failed' end
        if state.mountTries < M.MOUNT_TRIES and now >= state.nextMount then
            state.mountTries, state.nextMount = state.mountTries + 1, now + M.MOUNT_RETRY
            call('driveMountDriver', state.handle)
        end
        return 'wait'
    end

    local function finish(ctx, state, name)
        state.over = true
        ctx:emit(name)
    end

    -- ---- ride ---------------------------------------------------------------------------------------------------------------------------
    -- The stage's copy is V's passenger (the party copy mounted in the car V drives). Sampled at 1 Hz from one mounted-vehicle read: ride:started when the copy
    -- is aboard and V drives, nothing before. The checkpoints must be driven through in order, the arrival at `to` counts after the last one. A step between two
    -- samples counts as passing a place when the straight line crossed it. spec: to, checkpoints, limitMinutes (game minutes from the start), heat (a wanted level
    -- ends the ride: ride:failed-heat), hidden (the route is the player's to find: no pin is ever made here, the flag is only kept).
    R.defs.ride = {
        interval = 1,
        arm = function(ctx, spec)
            local to = placeOf(ctx, spec.to)
            if not to or not eventId(spec.to) then log('ride: place ' .. tostring(spec.to) .. ' is not in the stage'); return nil end
            local checkpoints = {}
            if spec.checkpoints ~= nil then
                if type(spec.checkpoints) ~= 'table' then log('ride: checkpoints is not a list'); return nil end
                for index, id in ipairs(spec.checkpoints) do
                    local place = placeOf(ctx, id)
                    if not place or not eventId(id) or index > 16 then log('ride: checkpoint ' .. tostring(id) .. ' is not in the stage'); return nil end
                    checkpoints[index] = {id = id, place = place}
                end
            end
            return {to = to, checkpoints = checkpoints, nextCheckpoint = 1, limit = number(spec.limitMinutes, 0.1, 1440, nil),
                heat = spec.heat == true, hidden = spec.hidden == true, started = false, over = false, prev = nil, nextHeat = 0}
        end,
        tick = function(ctx, spec, state)
            if state.over then return end
            local now = clock()
            local read = call('rideRead', ctx.character)
            if type(read) ~= 'table' then return end   -- a read that failed says nothing: it is never counted as leaving the car
            local driving = read.driving == true
            local aboard = read.copy == 'aboard'
            local at = point(read.at) and plain(read.at) or nil
            if not state.started then
                if not (driving and aboard) then return end
                state.started, state.startGame, state.startReal = true, gameTime(), now
                ctx:emit('ride:started')
                if ctx.reaped or state.over then return end
            end
            if driving then state.footSince = nil else state.footSince = state.footSince or now end
            if aboard then state.outSince = nil else state.outSince = state.outSince or now end
            -- Places driven through, in order. Only a car V drives with the copy aboard counts.
            if driving and aboard and at then
                local prev = state.prev
                if prev and flat(prev, at) > M.RIDE_SEGMENT then prev = nil end
                local function passes(place)
                    if env.places.inside(place, at) then return true end
                    return prev ~= nil and env.places.inside(place, closest(prev, at, place))
                end
                while state.nextCheckpoint <= #state.checkpoints and passes(state.checkpoints[state.nextCheckpoint].place) do
                    local cp = state.checkpoints[state.nextCheckpoint]
                    state.nextCheckpoint = state.nextCheckpoint + 1
                    ctx:emit('ride:checkpoint:' .. cp.id)
                    if ctx.reaped or state.over then return end
                end
                if state.nextCheckpoint > #state.checkpoints and passes(state.to) then
                    finish(ctx, state, 'ride:arrived')
                    return
                end
            end
            state.prev = at
            if state.limit then
                local game = gameTime()
                local elapsed
                if game and state.startGame then elapsed = game - state.startGame else elapsed = (now - state.startReal) * M.GAME_SECONDS_PER_SECOND end
                if elapsed >= state.limit * 60 then finish(ctx, state, 'ride:timeout'); return end
            end
            if state.heat and now >= state.nextHeat then
                state.nextHeat = now + M.HEAT_STEP
                local heat = call('readHeat')
                if type(heat) == 'number' and heat >= 1 then finish(ctx, state, 'ride:failed-heat'); return end
            end
            if (state.footSince and now - state.footSince >= M.RIDE_FOOT) or (state.outSince and now - state.outSince >= M.RIDE_COPY_OUT) then
                finish(ctx, state, 'ride:abandoned')
            end
        end,
    }

    -- ---- post ---------------------------------------------------------------------------------------------------------------------------
    -- The stage's copy walks to the spot of a place and holds it, with the visitor calls of the housemates (the copy must be one placed through a cast, a
    -- party member is moved by the party and cannot be posted: post:<id>:lost at once). stance: 'stand', 'prone' (the lowest stance the game has for an NPC)
    -- or 'car' (a stationary tagged car at the spot, the copy sits in it). spec.release names an event that frees her (post:<id>:released). With fightFrom the
    -- event post:<id>:fight asks companion tactics to engage from the post (post:<id>:fighting when they take it: the hold-position flag T.fightFrom, which gives her an
    -- aggressive reaction preset and leaves every move order to this primitive, which sends none while she fights). The release event and the ctx turn it off again.
    R.defs.post = {
        interval = 2,
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('post has no id'); return nil end
            local place = placeOf(ctx, spec.at)
            if not place then log('post ' .. id .. ': place ' .. tostring(spec.at) .. ' is not in the stage'); return nil end
            local stance = spec.stance == nil and 'stand' or spec.stance
            if not STANCES[stance] then log('post ' .. id .. ': bad stance'); return nil end
            local spot = env.places.snap(place)
            local state = {id = id, stance = stance, target = {x = spot.x, y = spot.y, z = spot.z}, arriveAt = math.max(1.5, math.min(place.radius, 3)),
                phase = 'walk', since = clock(), walkStart = clock(), walks = 0, nextWalk = 0, drifts = 0, miss = 0, seen = false, setDone = false,
                released = false, fighting = false, over = false, fightFrom = spec.fightFrom == true, holdAt = 0, mountTries = 0, nextMount = 0, carMiss = 0,
                tries = 0, nextTry = 0, request = {kind = 'car', vehicle = type(spec.vehicle) == 'string' and spec.vehicle or nil, tag = ctx.tag},
                spawnAt = stance == 'car' and {x = spot.x, y = spot.y, z = spot.z} or nil}
            local function release()
                if state.over or state.released then return end
                state.released = true
                if state.stance == 'car' and state.handle and state.serial then call('postCarMount', state.serial, state.handle, true) end
                if state.fightOn then state.fightOn = false; call('postFight', state.serial, false) end
                ctx:emit('post:' .. id .. ':released')
            end
            if eventName(spec.release) then ctx:on(spec.release, release) end
            if state.fightFrom then
                ctx:on('post:' .. id .. ':fight', function()
                    if state.over or state.released or state.fighting then return end
                    state.fighting = true
                    if call('postFight', state.serial, true) == true then
                        -- The flag is taken back whatever ends the post: the stage ending, a reload, the setting going off.
                        state.fightOn = true
                        ctx:track('post-fight', state, function(held)
                            if held.fightOn then held.fightOn = false; call('postFight', held.serial, false) end
                        end)
                        ctx:emit('post:' .. id .. ':fighting')
                    else
                        log('post ' .. id .. ': companion tactics did not take the fight from the post, she is free to fight on her own')
                    end
                end)
            end
            return state
        end,
        tick = function(ctx, spec, state)
            if state.over or state.released then return end
            local now = clock()
            local function lose(why)
                if why then log('post ' .. state.id .. ' lost: ' .. why) end
                finish(ctx, state, 'post:' .. state.id .. ':lost')
            end
            local copy = copyAt(ctx)
            if not copy then
                state.miss = state.miss + 1
                if (state.seen and state.miss >= M.LOST_AFTER) or (not state.seen and now - state.since >= M.NEVER_SEEN) then lose('the copy is gone') end
                return
            end
            state.seen, state.miss, state.serial = true, 0, copy.serial
            if copy.kind == 'party' then lose('she is in the party, a post needs a copy placed through a cast'); return end
            local gap = flat(copy.position, state.target)
            local near = gap <= state.arriveAt and math.abs(copy.position.z - state.target.z) <= 3
            if state.stance == 'car' then trySpawn(ctx, state, now, 'post-car') end
            if state.setDone and not state.fighting and not near and state.phase ~= 'walk' and gap > state.arriveAt + M.POST_DRIFT then
                -- Pushed off the spot: walk back, up to three times.
                state.drifts = state.drifts + 1
                if state.drifts > M.POST_MAX_DRIFTS then lose('she keeps leaving the spot'); return end
                state.phase, state.walkStart, state.nextWalk, state.walks = 'walk', now, 0, 0
            end
            if state.phase == 'walk' then
                if near then
                    state.phase = 'arrive'
                elseif now - state.walkStart > M.POST_WALK_TIMEOUT then lose('she did not reach the spot'); return
                elseif now >= state.nextWalk then
                    if state.walks >= M.POST_MAX_WALKS then lose('the walk keeps ending short'); return end
                    state.walks, state.nextWalk = state.walks + 1, now + M.POST_WALK_RETRY
                    call('postWalk', copy.serial, state.target, 'Walk')
                    return
                else
                    return
                end
            end
            if state.phase == 'arrive' then
                if state.stance == 'car' then
                    local look = state.handle and call('driveLookup', state.handle)
                    if type(look) ~= 'table' or look.attached ~= true then return end
                    if call('postCarMounted', copy.serial, state.handle) == true then
                        state.phase = 'held'
                    elseif state.mountTries < M.POST_MOUNT_TRIES then
                        if now >= state.nextMount then
                            state.mountTries, state.nextMount = state.mountTries + 1, now + M.POST_MOUNT_RETRY
                            call('postCarMount', copy.serial, state.handle, false)
                        end
                        return
                    elseif now >= state.nextMount then lose('she could not get into the car'); return
                    else return end
                else
                    call('postHold', copy.serial)
                    if state.stance == 'prone' then call('postStance', copy.serial, 'prone') end
                    state.holdAt, state.phase = now, 'held'
                end
                if not state.setDone then
                    state.setDone = true
                    ctx:emit('post:' .. state.id .. ':set')
                end
                return
            end
            -- Held: the hold command is renewed before it runs out, a car seat is checked.
            if state.stance == 'car' then
                if call('postCarMounted', copy.serial, state.handle) == true then state.carMiss = 0
                else
                    state.carMiss = state.carMiss + 1
                    if state.carMiss >= 3 then lose('she left the car'); return end
                end
            elseif not state.fighting and now - state.holdAt >= M.POST_HOLD_REFRESH then
                call('postHold', copy.serial)
                state.holdAt = now
            end
        end,
    }

    -- ---- remote -------------------------------------------------------------------------------------------------------------------------
    -- A marker: the stage's `say` rows with channel 'remote' play as a voice in V's ear (the lines module does that, the lease flag is its own). It adds the
    -- dead zone: spec.deadZone is a place of the stage. While V is inside, remote lines are held (the lines module's holdWhile hook) and delivered once V is out.
    -- remote:silenced on entering, remote:resumed on leaving. V's position is read every second, every 5 s while V is far away.
    local function insideZone(state, pos)
        return env.places.inside(state.zone, pos, state.silenced and M.LEAVE_SLACK or 1)
    end
    R.defs.remote = {
        interval = 1,
        arm = function(ctx, spec)
            local state = {silenced = false, nextRead = 0, zone = nil}
            if spec.deadZone ~= nil then
                local place = placeOf(ctx, spec.deadZone)
                if not place then log('remote: dead zone ' .. tostring(spec.deadZone) .. ' is not in the stage'); return state end
                state.zone = place
                local release = call('remoteHold', function() return state.silenced end)
                if type(release) == 'function' then
                    ctx:track('remote', release, function(fn) pcall(fn) end)
                else
                    log('remote: remote lines cannot be held yet, the dead zone only reports its events')
                end
            end
            return state
        end,
        tick = function(ctx, spec, state)
            if not state.zone then return end
            local now = clock()
            if now < state.nextRead then return end
            local pos = playerAt()
            if not pos then state.nextRead = now + M.REMOTE_SLOW; return end
            local here = insideZone(state, pos)
            local far = flat(pos, state.zone) > M.NEAR + state.zone.radius
            state.nextRead = now + (far and M.REMOTE_SLOW or 0)
            if here and not state.silenced then
                state.silenced = true
                ctx:emit('remote:silenced')
            elseif not here and state.silenced then
                state.silenced = false
                ctx:emit('remote:resumed')
            end
        end,
    }

    -- ---- runner -------------------------------------------------------------------------------------------------------------------------
    -- Someone V chases: a tagged car with a nameless driver (spec.vehicle a vehicle record) or a tagged pedestrian (spec.vehicle 'foot'), spawned at the first point of
    -- spec.route when V is within 150 m and driven along it in legs (the drive-to-point command, traffic cleared on the path, sent again when the runner stops).
    -- A leg is done when the runner passes within 15 m of its end (3 m on foot), never by the command's own flag. spec.driver is the Character record of the driver or
    -- the pedestrian. runner:<id>:stopped once it sat still for stoppedSeconds (default 4), runner:<id>:caught when V or the copy is within caughtMetres (default 12)
    -- while it is stopped or slower than 3 m/s, runner:<id>:lost at the route end or when it is more than 250 m from V for 5 s or is gone.
    local function resolveRoute(ctx, route)
        if type(route) ~= 'table' or #route < 2 or #route > 32 then return nil end
        local list = {}
        for index, item in ipairs(route) do
            if type(item) == 'string' then
                local place = placeOf(ctx, item)
                if not place then log('route place ' .. item .. ' is not in the stage'); return nil end
                local spot = env.places.snap(place)
                list[index] = {x = spot.x, y = spot.y, z = spot.z}
            elseif point(item) then
                list[index] = plain(item)
            else
                log('route point ' .. index .. ' is bad')
                return nil
            end
        end
        return list
    end

    R.defs.runner = {
        interval = 1,
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('runner has no id'); return nil end
            local route = resolveRoute(ctx, spec.route)
            if not route then log('runner ' .. id .. ' has no route of two points or more'); return nil end
            local kind = spec.vehicle == 'foot' and 'foot' or 'car'
            if kind == 'car' and type(spec.vehicle) ~= 'string' then log('runner ' .. id .. ' has no vehicle record'); return nil end
            local driver = type(spec.driver) == 'string' and spec.driver or (type(spec.record) == 'string' and spec.record or nil)
            if not driver then log('runner ' .. id .. ' has no driver record'); return nil end
            local dx, dy = route[2].x - route[1].x, route[2].y - route[1].y
            return {id = id, kind = kind, route = route, leg = 2, sentLeg = 0, speed = number(spec.speed, 1, 60, kind == 'car' and 14 or 3.5),
                caught = number(spec.caughtMetres, 2, 100, 12), stoppedAfter = number(spec.stoppedSeconds, 1, 120, 4),
                tries = 0, nextTry = 0, spawnAt = route[1], yaw = math.deg(atan2(-dx, dy)), mountTries = 0, nextMount = 0,
                request = {kind = kind, vehicle = kind == 'car' and spec.vehicle or nil, driver = driver, tag = ctx.tag, neutral = kind == 'car'},
                seen = false, miss = 0, moved = false, slowFor = 0, stopped = false, farFor = 0, resends = 0, lastSend = 0, over = false, prev = nil, prevAt = nil}
        end,
        tick = function(ctx, spec, state)
            if state.over then return end
            local now = clock()
            local name = function(what) return 'runner:' .. state.id .. ':' .. what end
            if not state.handle then
                if not trySpawn(ctx, state, now, 'runner') then
                    if state.tries >= M.SPAWN_TRIES then
                        log('runner ' .. state.id .. ' could not be made, it is called lost')
                        finish(ctx, state, name('lost'))
                    end
                    return
                end
                return
            end
            local look = call('driveLookup', state.handle)
            if type(look) ~= 'table' or look.attached ~= true or not point(look.position) then
                if state.seen then
                    state.miss = state.miss + 1
                    if state.miss >= M.RUNNER_MISS then finish(ctx, state, name('lost')) end
                elseif now - state.spawnedAt > M.ATTACH_TIMEOUT then
                    log('runner ' .. state.id .. ' never attached, it is called lost')
                    finish(ctx, state, name('lost'))
                end
                return
            end
            state.seen, state.miss = true, 0
            if state.kind == 'car' then
                local seat = seatDriver(state, look, now)
                if seat == 'failed' then
                    log('runner ' .. state.id .. ': the driver could not get into the car, it is called lost')
                    finish(ctx, state, name('lost'))
                    return
                elseif seat == 'wait' then
                    return
                end
            end
            local pos = plain(look.position)
            local dt = state.prevAt and now - state.prevAt or nil
            local speed = nil
            if state.prev and dt and dt > 0.2 then speed = flat(state.prev, pos) / dt end
            local prev = state.prev
            state.prev, state.prevAt = pos, now
            if speed then
                if speed > 1.0 then state.moved = true end
                if speed < 0.8 then state.slowFor = state.slowFor + dt else state.slowFor = 0 end
                if speed > 3 then state.stopped = false end
                if state.moved and not state.stopped and state.slowFor >= state.stoppedAfter then
                    state.stopped = true
                    ctx:emit(name('stopped'))
                    if ctx.reaped or state.over then return end
                end
            end
            -- Caught: V or the copy close to a runner that is stopped or slow (or dead).
            local vpos = playerAt()
            local slow = state.stopped or (speed ~= nil and speed < 3)
            local function close(p) return p ~= nil and flat(p, pos) <= state.caught and math.abs(p.z - pos.z) <= 10 end
            local caught = look.alive == false
            if not caught and slow then
                if close(vpos) then caught = true
                else
                    local copy = copyAt(ctx)
                    caught = copy ~= nil and close(copy.position)
                end
            end
            if caught then
                call('driveBrake', state.handle)
                finish(ctx, state, name('caught'))
                return
            end
            if vpos and flat(vpos, pos) > M.RUNNER_LOST_METRES then state.farFor = state.farFor + (dt or 1) else state.farFor = 0 end
            if state.farFor >= M.RUNNER_LOST_SECONDS then finish(ctx, state, name('lost')); return end
            -- The leg: sent once, judged by how near the runner came to its end, sent again when the runner stands still.
            local target = state.route[state.leg]
            if state.sentLeg ~= state.leg then
                state.sentLeg, state.lastSend, state.resends = state.leg, now, 0
                if call('driveTo', state.handle, target, state.speed) ~= true then log('runner ' .. state.id .. ': the drive command to leg ' .. state.leg .. ' was refused') end
                return
            end
            local reach = state.kind == 'car' and 15 or 3
            local nearest = prev and closest(prev, pos, target) or pos
            if flat(pos, target) <= reach or flat(nearest, target) <= reach then
                state.leg = state.leg + 1
                if state.leg > #state.route then finish(ctx, state, name('lost')) end
                return
            end
            if speed and speed < 0.8 and now - state.lastSend >= M.RUNNER_RESEND then
                state.resends, state.lastSend = state.resends + 1, now
                if state.resends > M.RUNNER_MAX_RESENDS then
                    log('runner ' .. state.id .. ' is stuck on leg ' .. state.leg .. ', the leg is skipped')
                    state.leg = state.leg + 1
                    if state.leg > #state.route then finish(ctx, state, name('lost')) end
                    return
                end
                call('driveTo', state.handle, target, state.speed)
            end
        end,
    }

    -- ---- tail ---------------------------------------------------------------------------------------------------------------------------
    -- The reverse of a runner: a tagged car that follows V at a gap (spec.gap, default 25 m) with the follow command, sent again every four seconds. It starts behind
    -- V (or at spec.at, a place of the stage). spec.vehicle is its record, spec.driver the Character record of its driver. tail:<id>:noticed when it stays within
    -- noticeMetres (default half the gap, at least 8) for two samples, tail:<id>:lost when it is farther than lostMetres (default six gaps, at least 150) for ten
    -- seconds or is gone.
    R.defs.tail = {
        interval = 1,
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('tail has no id'); return nil end
            local driver = type(spec.driver) == 'string' and spec.driver or (type(spec.record) == 'string' and spec.record or nil)
            if not driver then log('tail ' .. id .. ' has no driver record'); return nil end
            local gap = number(spec.gap, 5, 200, 25)
            local spawnAt
            if spec.at ~= nil then
                local place = placeOf(ctx, spec.at)
                if not place then log('tail ' .. id .. ': place ' .. tostring(spec.at) .. ' is not in the stage'); return nil end
                local spot = env.places.snap(place)
                spawnAt = {x = spot.x, y = spot.y, z = spot.z}
            end
            return {id = id, gap = gap, notice = number(spec.noticeMetres, 3, 200, math.max(8, gap / 2)), lostAt = number(spec.lostMetres, 20, 2000, math.max(150, gap * 6)),
                tries = 0, nextTry = 0, spawnAt = spawnAt, behind = gap + M.TAIL_BEHIND, mountTries = 0, nextMount = 0, nextFollow = 0, nearCount = 0, farFor = 0,
                noticed = false, seen = false, miss = 0, over = false, prevAt = nil,
                request = {kind = 'car', vehicle = type(spec.vehicle) == 'string' and spec.vehicle or nil, driver = driver, tag = ctx.tag, neutral = true}}
        end,
        tick = function(ctx, spec, state)
            if state.over then return end
            local now = clock()
            local name = function(what) return 'tail:' .. state.id .. ':' .. what end
            if not state.handle then
                if not trySpawn(ctx, state, now, 'tail') then
                    if state.tries >= M.SPAWN_TRIES then
                        log('tail ' .. state.id .. ' could not be made, it is called lost')
                        finish(ctx, state, name('lost'))
                    end
                end
                return
            end
            local look = call('driveLookup', state.handle)
            if type(look) ~= 'table' or look.attached ~= true or not point(look.position) then
                if state.seen then
                    state.miss = state.miss + 1
                    if state.miss >= M.RUNNER_MISS then finish(ctx, state, name('lost')) end
                elseif now - state.spawnedAt > M.ATTACH_TIMEOUT then
                    log('tail ' .. state.id .. ' never attached, it is called lost')
                    finish(ctx, state, name('lost'))
                end
                return
            end
            state.seen, state.miss = true, 0
            local seat = seatDriver(state, look, now)
            if seat == 'failed' then
                log('tail ' .. state.id .. ': the driver could not get into the car, it is called lost')
                finish(ctx, state, name('lost'))
                return
            elseif seat == 'wait' then
                return
            end
            if now >= state.nextFollow then
                state.nextFollow = now + M.TAIL_FOLLOW
                call('driveFollow', state.handle, state.gap)
            end
            local vpos = playerAt()
            if not vpos then return end
            local dt = state.prevAt and now - state.prevAt or 1
            state.prevAt = now
            local distance = flat(vpos, look.position)
            if distance <= state.notice then state.nearCount = state.nearCount + 1 else state.nearCount = 0 end
            if not state.noticed and state.nearCount >= 2 then
                state.noticed = true
                ctx:emit(name('noticed'))
                if ctx.reaped or state.over then return end
            end
            if distance > state.lostAt then state.farFor = state.farFor + dt else state.farFor = 0 end
            if state.farFor >= M.TAIL_FAR_SECONDS then finish(ctx, state, name('lost')) end
        end,
    }

    -- ---- check --------------------------------------------------------------------------------------------------------------------------
    -- One read at a checkpoint: when check:<id>:go arrives, or once on arm when spec.now. It emits check:<id>:<value> with a bounded vocabulary and nothing else.
    --   hour     night | day                (args.nightFrom 21, args.nightTo 5)
    --   weather  clear cloudy rain heavy-rain toxic-rain fog smog sandstorm
    --   heat     0 | 1-2 | 3-5
    --   song     silent | playing, or with args.match (a word or a list of words) match | other
    --   gear     args.weapon: armed | unarmed. args.slot (head face outerTorso innerTorso legs feet outfit): empty | worn, with args.match: empty | match | other
    --   item     args.item (an Items.* record): have | none (args.min, default 1)
--   district the district V is in (world.district) as one token: lowercase, spaces and other characters to hyphens, e.g. little-china
--   radio    the radio station playing (the song read) as one token: lowercase with hyphens, e.g. 89-7-growl-fm, or off
    --   anything that cannot be read or does not fit the vocabulary: unknown
    local function words(match)
        local list = {}
        if type(match) == 'string' then match = {match} end
        if type(match) ~= 'table' then return list end
        for index, word in ipairs(match) do
            if index > 8 then break end
            if type(word) == 'string' and #word > 0 and #word <= 40 then list[#list + 1] = word:lower() end
        end
        return list
    end
    local function contains(list, ...)
        for _, text in ipairs({...}) do
            if type(text) == 'string' then
                local lower = text:lower()
                for _, word in ipairs(list) do if lower:find(word, 1, true) then return true end end
            end
        end
        return false
    end

    -- A name as one event token: lowercase, every run of other characters one hyphen, none at the ends, 40 characters at most. nil when nothing is left.
    local function token(text)
        if type(text) ~= 'string' then return nil end
        local out = text:lower():gsub('[^%w]+', '-')
        out = out:gsub('^%-+', ''):gsub('%-+$', '')
        if #out > 40 then out = out:sub(1, 40):gsub('%-+$', '') end
        return #out > 0 and out or nil
    end

    local function classify(what, args)
        if what == 'hour' then
            local hour = call('readHour')
            if type(hour) ~= 'number' or hour < 0 or hour >= 24 then return nil end
            local from, to = number(args.nightFrom, 0, 23, 21), number(args.nightTo, 0, 23, 5)
            local night
            if from > to then night = hour >= from or hour < to else night = hour >= from and hour < to end
            return night and 'night' or 'day'
        elseif what == 'weather' then
            local kind = call('readWeather')
            return WEATHER[kind] and kind or nil
        elseif what == 'heat' then
            local heat = call('readHeat')
            if type(heat) ~= 'number' or heat ~= math.floor(heat) or heat < 0 or heat > 5 then return nil end
            return heat == 0 and '0' or (heat <= 2 and '1-2' or '3-5')
        elseif what == 'song' then
            local song = call('readSong')
            if type(song) ~= 'table' then return nil end
            if song.playing ~= true then return 'silent' end
            local list = words(args.match)
            if #list == 0 then return 'playing' end
            return contains(list, song.station, song.song) and 'match' or 'other'
        elseif what == 'district' then
            local where = call('district')
            if type(where) ~= 'table' then return nil end
            return token(where.district) or token(where.area)
        elseif what == 'radio' then
            local song = call('readSong')
            if type(song) ~= 'table' then return nil end
            if song.playing ~= true then return 'off' end
            return token(song.station) or 'unknown'
        elseif what == 'gear' then
            local gear = call('readGear')
            if type(gear) ~= 'table' then return nil end
            if args.weapon == true then return gear.hand ~= nil and 'armed' or 'unarmed' end
            if type(args.slot) == 'string' and SLOTS[args.slot] then
                local worn = type(gear.worn) == 'table' and gear.worn[args.slot] or nil
                if worn == nil then return 'empty' end
                local list = words(args.match)
                if #list == 0 then return 'worn' end
                return contains(list, worn) and 'match' or 'other'
            end
            return nil
        elseif what == 'item' then
            local item = args.item
            if type(item) ~= 'string' or #item > 80 or not item:match('^Items%.[%w_%.%-]+$') then return nil end
            local count = call('readItem', item)
            if type(count) ~= 'number' then return nil end
            return count >= number(args.min, 1, 1e9, 1) and 'have' or 'none'
        end
        return nil
    end

    R.defs.check = {
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('check has no id'); return nil end
            if not CHECKS[spec.what] then log('check ' .. id .. ': unknown kind ' .. tostring(spec.what)); return nil end
            local args = type(spec.args) == 'table' and spec.args or {}
            local function read()
                local ok, value = pcall(classify, spec.what, args)
                ctx:emit('check:' .. id .. ':' .. ((ok and value) or 'unknown'))
            end
            ctx:on('check:' .. id .. ':go', read)
            if spec.now == true then ctx:after(0, read, {real = true}) end
            return {id = id}
        end,
    }
end

return M
