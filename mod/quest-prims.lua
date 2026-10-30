-- The primitives of round 1 of the bond quests (docs/QUEST_PRIMITIVES.md, BOND_QUESTS.md section 21): place, pin, timer, party, together, seat and cast.
-- Each one is a small table {interval, arm(ctx, spec, env) -> state, tick(ctx, spec, state, env), disarm(ctx, spec, state, env)}. The quest module
-- (mod/quest-play.lua) arms them when a stage begins, ticks each at its own interval (never faster than once a second) and has the ctx reap everything they
-- made when the stage ends. Pure: the game comes in through env.world (mod/quest-world.lua), so the tests run them on a fake game.
--
-- Entity handles are never kept: the world adapter hands back plain data (positions, flags) or opaque ids, and an entity is looked up again at each use.
-- A primitive only acts on the mod's own copies and its own tagged spawns, never on a character the game placed.
--
-- env: {places, world, clock, gameTime, log}. world: playerPosition(), copyOf(profileKey) -> {kind, serial, position} | nil, seated(profileKey) ->
-- {v, copy}, castSpawn(request) -> handle | nil, why, castLookup(handle) -> {position} | nil, castDelete(handle).
local M = {JOIN_TRIES = 6, SPAWN_DISTANCE = 150, SPAWN_TRIES = 5, SPAWN_RETRY = 3, TOGETHER_STEP = 10, TOGETHER_CLAMP = 600, LOST_AFTER = 2, NEVER_SEEN = 30}

local function finite(value) return type(value) == 'number' and value == value and math.abs(value) < 1e7 end
local function point(p) return type(p) == 'table' and finite(p.x) and finite(p.y) and finite(p.z) end
local function flat(a, b) local dx, dy = a.x - b.x, a.y - b.y; return math.sqrt(dx * dx + dy * dy) end
local function number(value, low, high, default)
    if type(value) ~= 'number' or value ~= value or value < low or value > high then return default end
    return value
end
local function eventId(value, default)
    if type(value) == 'string' and #value > 0 and #value <= 60 and value:match('^[%w][%w%.%-_]*$') then return value end
    return default
end

function M.new(options)
    options = options or {}
    local R = {defs = {}}
    local env = {places = options.places, world = options.world or {}, clock = options.clock, gameTime = options.gameTime, log = options.log}
    R.env = env

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
    local function world(name, ...)
        local fn = env.world[name]
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

    -- ---- place --------------------------------------------------------------------------------------------------------------------------
    R.defs.place = {
        arm = function(ctx, spec)
            local id = spec.at
            local place = placeOf(ctx, id)
            if not place then log('place ' .. tostring(id) .. ' is not in the stage'); return nil end
            env.places.watch(ctx, id, place, {dwell = number(spec.dwell, 0, 3600, 0)})
            return {id = id}
        end,
        disarm = function(ctx, spec, state) if state then env.places.unwatch(ctx, state.id) end end,
    }

    -- ---- pin ----------------------------------------------------------------------------------------------------------------------------
    -- A map pin on a place. It is taken away when V arrives there (the arrived event of the same place), and by the ctx on every other exit.
    R.defs.pin = {
        arm = function(ctx, spec)
            local id = spec.at
            local place = placeOf(ctx, id)
            if not place then log('pin: place ' .. tostring(id) .. ' is not in the stage'); return nil end
            if not env.places.pin(ctx, id, place) then return nil end
            ctx:on('place:' .. id .. ':arrived', function() env.places.unpin(ctx, id) end)
            return {id = id}
        end,
        disarm = function(ctx, spec, state) if state then env.places.unpin(ctx, state.id) end end,
    }

    -- ---- timer --------------------------------------------------------------------------------------------------------------------------
    -- timer:<id> after `seconds` GAME seconds (spec.clock = 'real' for real seconds).
    R.defs.timer = {
        arm = function(ctx, spec)
            local id = eventId(spec.id, 'timer')
            local seconds = number(spec.seconds, 0, 86400 * 30, nil)
            if not seconds then log('timer ' .. id .. ' has no seconds'); return nil end
            ctx:after(seconds, function() ctx:emit('timer:' .. id) end, {real = spec.clock == 'real'})
            return {id = id}
        end,
    }

    -- ---- party --------------------------------------------------------------------------------------------------------------------------
    -- The stage's character copy follows V. The copy is the one the party already has (nothing is spawned here). party:lost once when it is gone
    -- (not found twice in a row after it was seen, or never found for 30 s).
    R.defs.party = {
        interval = 5,
        arm = function(ctx) return {seen = false, miss = 0, lost = false, since = clock(), joins = 0} end,
        tick = function(ctx, spec, state)
            local copy = world('copyOf', ctx.character)
            -- The quest's own visiting copy joins V's party here (a few tries), the way an invited friend does when V reaches her. unverified in the game.
            if type(copy) == 'table' and copy.kind == 'visitor' and copy.serial ~= nil and state.joins < M.JOIN_TRIES then
                state.joins = state.joins + 1
                if world('partyJoin', copy.serial) then copy = world('copyOf', ctx.character) end
            end
            if type(copy) == 'table' and copy.kind == 'party' then
                state.seen, state.miss = true, 0
                if state.lost then state.lost = false end
                return
            end
            state.miss = state.miss + 1
            if state.lost then return end
            if (state.seen and state.miss >= M.LOST_AFTER) or (not state.seen and clock() - state.since >= M.NEVER_SEEN) then
                state.lost = true
                ctx:emit('party:lost')
            end
        end,
    }

    -- ---- together -----------------------------------------------------------------------------------------------------------------------
    -- V and the copy within `metres` (5) for `minutes` GAME minutes, sampled every 10 s, paused while apart. Apart for `breakSeconds` (90, real seconds)
    -- is together:<id>:broken. `seated`: both seated. `at`: both inside that place. Done or broken ends the primitive.
    R.defs.together = {
        interval = M.TOGETHER_STEP,
        arm = function(ctx, spec)
            return {id = eventId(spec.id, 'together'), need = number(spec.minutes, 0.1, 1440, 10) * 60, metres = number(spec.metres, 1, 100, 5),
                breakAfter = number(spec.breakSeconds, 5, 3600, 90), accrued = 0, lastGame = gameTime(), apartSince = nil, over = false}
        end,
        tick = function(ctx, spec, state)
            if state.over then return end
            local vpos = world('playerPosition')
            local copy = world('copyOf', ctx.character)
            local together = point(vpos) and type(copy) == 'table' and point(copy.position)
                and flat(vpos, copy.position) <= state.metres and math.abs(vpos.z - copy.position.z) <= math.max(3, state.metres)
            if together and spec.seated == true then
                local seat = world('seated', ctx.character)
                together = type(seat) == 'table' and seat.v == true and seat.copy == true
            end
            if together and type(spec.at) == 'string' then
                local place = placeOf(ctx, spec.at)
                together = place ~= nil and env.places.inside(place, vpos) and env.places.inside(place, copy.position)
            end
            local game, now = gameTime(), clock()
            if together then
                state.apartSince = nil
                if game and state.lastGame then
                    local step = game - state.lastGame
                    if step > 0 then state.accrued = state.accrued + math.min(step, M.TOGETHER_CLAMP) end
                elseif not game then
                    state.accrued = state.accrued + M.TOGETHER_STEP
                end
                if state.accrued >= state.need then
                    state.over = true
                    ctx:emit('together:' .. state.id .. ':done')
                end
            else
                state.apartSince = state.apartSince or now
                if now - state.apartSince >= state.breakAfter then
                    state.over = true
                    ctx:emit('together:' .. state.id .. ':broken')
                end
            end
            state.lastGame = game
        end,
    }

    -- ---- seat ---------------------------------------------------------------------------------------------------------------------------
    -- seat:seated when V and the copy are both seated, seat:stood when one of them stood up after that. Read at 1 Hz from the seating controller's state
    -- (no event hook of its own: the controller already knows).
    R.defs.seat = {
        interval = 1,
        arm = function() return {both = false} end,
        tick = function(ctx, spec, state)
            local seat = world('seated', ctx.character)
            local both = type(seat) == 'table' and seat.v == true and seat.copy == true
            if both and not state.both then
                state.both = true
                ctx:emit('seat:seated')
            elseif not both and state.both then
                state.both = false
                ctx:emit('seat:stood')
            end
        end,
    }

    -- ---- cast ---------------------------------------------------------------------------------------------------------------------------
    -- A tagged character for the stage. who: 'self' (the pack's character), a profile key (another character's copy), or 'extra' (a nameless ordinary
    -- NPC made from spec.record, a Character record). It is made lazily when V is within 150 m of its place (spec.at, a place of the stage, or spec.x/y/z),
    -- retried up to five times, used only once the game has attached it (cast:<id>:arrived), and deleted with the ctx.
    R.defs.cast = {
        interval = 2,
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('cast has no id'); return nil end
            local who = spec.who or 'self'
            if who ~= 'self' and who ~= 'extra' and not (type(who) == 'string' and who:match('^[a-z0-9][a-z0-9%-]*$')) then log('cast ' .. id .. ': bad who'); return nil end
            if who == 'extra' and type(spec.record) ~= 'string' and type(spec.archetype) ~= 'string' then log('cast ' .. id .. ': an extra needs a record'); return nil end
            local at
            if type(spec.at) == 'string' then
                local place = placeOf(ctx, spec.at)
                if place then at = env.places.snap(place) end
            elseif point(spec) then
                at = env.places.snap({x = spec.x, y = spec.y, z = spec.z, radius = 1})
            end
            if not at then log('cast ' .. id .. ' has no place'); return nil end
            -- carry: the cast member stays through the next stages of the quest (a companion who walks with V after meeting V) and is removed when the quest ends.
            local key = ctx.pack .. ':' .. id
            local kept = spec.carry == true and R.carried[key] or nil
            if kept then
                R.carried[key] = nil
                ctx:track('cast', kept, function(h) if ctx.final then world('castDelete', h) else R.carried[key] = h end end)
                return {id = id, who = who, at = {x = at.x, y = at.y, z = at.z}, handle = kept, arrived = true, tries = 0, nextTry = 0, carry = true}
            end
            return {id = id, who = who, at = {x = at.x, y = at.y, z = at.z}, facing = type(spec.facing) == 'table' and spec.facing or nil,
                record = spec.record or spec.archetype, tries = 0, nextTry = 0, handle = nil, arrived = false, carry = spec.carry == true}
        end,
        tick = function(ctx, spec, state)
            if state.arrived then return end
            if not state.handle then
                if state.tries >= M.SPAWN_TRIES then return end
                local now = clock()
                if now < state.nextTry then return end
                local vpos = world('playerPosition')
                if not point(vpos) or flat(vpos, state.at) > M.SPAWN_DISTANCE then return end
                state.tries, state.nextTry = state.tries + 1, now + M.SPAWN_RETRY
                local profileKey = state.who == 'self' and ctx.character or (state.who ~= 'extra' and state.who or nil)
                local handle, why = world('castSpawn', {id = ctx.pack .. ':' .. state.id, who = state.who, profileKey = profileKey, record = state.record,
                    x = state.at.x, y = state.at.y, z = state.at.z, facing = state.facing, tag = ctx.tag})
                if handle then
                    state.handle = handle
                    local key = ctx.pack .. ':' .. state.id
                    ctx:track('cast', handle, function(h)
                        if state.carry and not ctx.final then R.carried[key] = h else world('castDelete', h) end
                    end)
                else
                    log('cast ' .. state.id .. ' spawn try ' .. state.tries .. ' failed: ' .. tostring(why))
                end
                return
            end
            -- Looked up fresh at each tick: the entity must be attached before it counts.
            local found = world('castLookup', state.handle)
            if type(found) == 'table' then
                state.arrived = true
                ctx:emit('cast:' .. state.id .. ':arrived')
            end
        end,
    }

    -- Cast members that carry on into the next stage (spec.carry), by pack:id. The quest module drops them when the quest ends.
    R.carried = {}
    function R.dropCarried(pack)
        for key, handle in pairs(R.carried) do
            if key:sub(1, #pack + 1) == pack .. ':' then R.carried[key] = nil; world('castDelete', handle) end
        end
    end

    function R.get(name) return R.defs[name] end
    -- Later primitives live in their own files (mod/quest-prims-action.lua, mod/quest-prims-drive.lua): each exports install(R, env) and adds its defs to R.defs
    -- (and its own native calls to env.world). A file that is missing or fails to load leaves its primitives out, which the quest module logs once as unknown.
    function R.extend(module)
        if type(module) ~= 'table' or type(module.install) ~= 'function' then return false end
        return pcall(module.install, R, env)
    end
    return R
end

return M
