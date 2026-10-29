-- The SCENE group of bond quest primitives (docs/QUEST_PRIMITIVES.md, BOND_QUESTS.md sections 19.1 and 21): bout, hold-until, apart, unseen, dead-zone, workspot
-- and npc-react. install(R, env) adds the seven definitions to R.defs (mod/quest-prims.lua calls it through R.extend) and the native calls they need to env.world
-- (the ones the world adapter does not have yet come from mod/quest-world-scene.lua). Pure: every native call goes through env.world, so bridge/quest-prims-scene-lua.test.mjs
-- runs all of it on a fake game.
--
-- Each one is a table {interval, arm(ctx, spec, env) -> state, tick(ctx, spec, state, env), disarm}, ticked by the quest module once a second at most. NOTHING runs per frame.
-- Cost while armed: bout one pair of state reads a second while it is fought (nothing at all before bout:<id>:go and when it is staged), hold-until one clock read a second,
-- apart and dead-zone one position read a second (dead-zone every 5 s while V is more than 300 m away), unseen one read of V's combat flag and one state read per
-- squad member every 1.5 s, workspot one native step a second until the pose plays and then one workspot read a second, npc-react nothing (it listens to the NPC reaction module).
--
-- Entity handles are never kept. A fighter, a posed copy or a person is a plain handle of the world adapter ({kind = 'extra', id = ...} for a tagged spawn, {kind = 'copy',
-- profileKey = ...} for one of the mod's own copies), looked up again by the adapter in each call and used only when the game has attached it. A primitive here acts only on
-- the mod's own copies ('self' = the stage's copy) and on cast extras of the stage (the cast primitive's tagged spawns), never on a character the game placed. Everything a
-- primitive makes (a stand down, a hold, a posed device, a listener) is registered on the ctx (ctx:track), so one reap undoes it.
--
-- Events (all go through ctx:emit):
--   bout        bout:<id>:started, :round<N>, :a-down, :b-down, :stopped, :ended      listens bout:<id>:go (starts the bout), bout:<id>:stop (halts it)
--   hold-until  hold-until:<id>:reached, :failed                                      listens hostage:<witness>:dead and escortee:<witness>:lost, tells squad:<squad>:stand-down
--   apart       apart:<id>:done, :near, :far, :broken
--   unseen      unseen:<id>:spotted, :reached                                         listens squad:<squad>:hostile (the pack turned the squad on)
--   dead-zone   dead-zone:<id>:entered, :left                                         holds the lines of the remote channel while V is inside (the lines module's holdWhile)
--   workspot    workspot:<id>:set, :fallback, :lost
--   npc-react   npc:<id>:leave, :call-police, :attack, :cower, :brawl, :obey
--
-- bout in detail. Two fighters, each 'self' (the stage's copy) or the id of a cast of the stage, never V. It waits for bout:<id>:go. A real bout makes the two hostile to each
-- EACH OTHER only, with bare hands (never V, never a weapon), and reads both health pools once a second. Round N starts at (N - 1) * roundSeconds after the start
-- (round1 with started). It stops when a fighter is at or under `floor` percent (default 25): <that fighter>-down, then stopped, then ended. It stops when all rounds are over:
-- stopped, ended (no one is down). bout:<id>:stop halts it: stopped only. A fighter that disappears halts it too: stopped only. `handicap` (percent, default 0) is the share of
-- the damage the copy takes that is given back to it at each sample, so a handicap 30 copy loses 70 percent of what hits it ('self' is the handicapped fighter, else a). It is the
-- copy that is held back in this sense: the pack writes the fight so that a handicapped copy loses slowly, never so that it cannot lose.
-- `staged`: nobody is hit, the events come from timers and `winner` (a | b | random, default random) is the one left standing: the other goes down when the last round
-- ends. A real bout that cannot be armed (the natives are missing, refuse or the fighters never attach in 30 s) falls back to staged by itself and says so once in the log.
--
-- hold-until: the game clock (env.gameTime, game seconds, the hour is (seconds mod 86400) / 3600) is watched once a second. `hour` is the next time the clock shows that hour, a clock
-- that is less than two game hours past it already counts as reached, midnight wraps (22:00 to 06:00 waits eight hours). The witness (an escortee or hostage id of the stage) dying
-- first is hold-until:<id>:failed. On reached the stage's squad is told to stop sending waves (squad:<squad>:stand-down, mod/quest-prims-action.lua honours it).
--
-- UNVERIFIED in the game (offline-tested on a fake game only): every native of mod/quest-world-scene.lua, listed in its header. The pose table below says which paths are guesses.
local M = {BOUT_ROUNDS = 3, BOUT_ROUND_SECONDS = 60, BOUT_FLOOR = 25, BOUT_PATIENCE = 30, BOUT_MISSES = 2,
    HOLD_PAST = 7200, DAY = 86400, TOGETHER_CLAMP = 600,
    APART_INNER = 12, APART_OUTER = 60, APART_BREAK = 120,
    UNSEEN_STEP = 1.5, NEAR = 300, ZONE_SLOW = 5, LEAVE_SLACK = 1.15,
    WORKSPOT_ARRIVE = 30, WORKSPOT_GIVE_UP = 60, WORKSPOT_FALLBACK = 'generic_arms_crossed', MAX_CASTS = 64}

-- The poses of the workspot primitive. `idle`: a key of assets/gestures/gestures.json idleWorkspots (a workspot the gesture archive already carries as the component
-- convai_idle_<key>), `seat`: a key of seatWorkspots (the component convai_sit_<key>). `path` is the vanilla workspot resource the component was built from, kept here for the
-- record (the archive is what the game plays). guess = true: the pose is the nearest thing known, not the pose itself, and the first live run must look at it. A pose with
-- no idle and no seat has no known workspot yet: it plays the fallback idle and says workspot:<id>:fallback (the line still plays).
M.POSES = {
    ['arms-crossed'] = {idle = 'generic_arms_crossed', path = 'base\\workspots\\common\\ground\\generic__stand_ground_arms_crossed__stand_around__02.workspot'},
    drink = {idle = 'panam_beer', path = 'base\\workspots\\common\\ground\\generic__stand_ground_bottle__drink__01.workspot'},
    smoke = {idle = 'johnny_smoke', path = 'base\\workspots\\main_characters\\johnny\\johnny__stand_ground_cigarette__idle__01.workspot', guess = true},   -- Johnny's rig, a woman's copy may look wrong
    lean = {seat = 'lean', path = 'base\\workspots\\common\\bar\\generic__stand_bar_lean_front__stand_around__01.workspot'},
    rail = {seat = 'lean', path = 'base\\workspots\\common\\bar\\generic__stand_bar_lean_front__stand_around__01.workspot', guess = true},
    ['sit-ledge'] = {seat = 'stool', path = 'base\\workspots\\common\\barstool\\generic__sit_barstool__sit_around__01.workspot', guess = true},
    ['sit-ground'] = {seat = 'chair', path = 'base\\workspots\\common\\chair\\generic__sit_chair__sit_around__01.workspot', guess = true},
    guitar = {note = 'no known workspot path'},
    dance = {note = 'no known workspot path'},
    ['lie-back'] = {note = 'no known workspot path'},
    kneel = {note = 'no known workspot path'},
    mechanic = {note = 'no known workspot path'},
    cook = {note = 'no known workspot path'},
    weights = {note = 'no known workspot path'},
    ['prone-rifle'] = {note = 'no known workspot path'},
}

-- npc-react: what the NPC reaction module calls a kind, in the quest's words. The three commands V can give are one outcome: the person obeyed.
M.OUTCOMES = {leave = 'leave', ['call-police'] = 'call-police', attack = 'attack', cower = 'cower', brawl = 'brawl',
    ['get-down'] = 'obey', stop = 'obey', ['exit-vehicle'] = 'obey'}

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

function M.install(R, env)
    env.world = env.world or {}
    local world0 = env.world

    local function log(line) if type(env.log) == 'function' then pcall(env.log, 'Quest primitive: ' .. line) end end
    local logged = {}
    local function logOnce(key, line)
        if logged[key] then return end
        logged[key] = true
        log(line)
    end
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
        local ok, a, b, c = pcall(fn, ...)
        if not ok then return nil end
        return a, b, c
    end
    local function placeOf(ctx, id)
        local place = type(ctx.places) == 'table' and ctx.places[id] or nil
        if type(place) ~= 'table' or not (env.places and env.places.valid(place)) then return nil end
        return place
    end
    local function playerAt()
        local p = world('playerPosition')
        return point(p) and plain(p) or nil
    end
    local function random()
        local ok, value = pcall(env.random or math.random)
        return ok and type(value) == 'number' and value or 0.5
    end

    -- ---- the native calls ----------------------------------------------------------------------------------------------------------------
    -- Whatever the game adapter does not have yet comes from mod/quest-world-scene.lua (built with the companion table the init glue puts on the env). A world that
    -- already has a function by that name (a test's fake) keeps it. If the file cannot be loaded the primitives still arm and every call answers nothing, which each
    -- primitive treats as its own fallback (bout stages itself, workspot gives up quietly, unseen reads nothing but V).
    local natives = env.sceneNatives
    if natives == nil and type(dofile) == 'function' then
        local ok, module = pcall(dofile, 'quest-world-scene.lua')
        if ok and type(module) == 'table' and type(module.new) == 'function' then
            local built, W = pcall(module.new, {companions = env.companions, log = env.log})
            if built then natives = W end
        end
    end
    if type(natives) == 'table' then
        for name, fn in pairs(natives) do
            if type(fn) == 'function' and world0[name] == nil then world0[name] = fn end
        end
    end

    -- ---- who is who ------------------------------------------------------------------------------------------------------------------------
    -- The cast extras and cast copies of the stage by cast id (pack:castId), from the cast primitive's spawn (wrapped once: it still does exactly what it did). Handles
    -- are plain data. 'self' is the pack's character, the copy the party or the visitor queue already has.
    local casts, castCount = {}, 0
    local castSpawn = world0.castSpawn
    if type(castSpawn) == 'function' and not R.sceneWrapped then
        R.sceneWrapped = true
        world0.castSpawn = function(request)
            local handle, why = castSpawn(request)
            if handle ~= nil and type(request) == 'table' and type(request.id) == 'string' then
                if castCount >= M.MAX_CASTS then casts, castCount = {}, 0 end
                if casts[request.id] == nil then castCount = castCount + 1 end
                casts[request.id] = handle
            end
            return handle, why
        end
    end
    local function targetOf(ctx, who)
        if who == nil or who == 'self' then return {kind = 'copy', profileKey = ctx.character, self = true} end
        local id = eventId(who, nil)
        if not id then return nil end
        return casts[ctx.pack .. ':' .. id]
    end
    local function whoOk(value)
        return value == 'self' or eventId(value, nil) ~= nil
    end

    -- ====================================================================================================================================
    -- bout
    -- ====================================================================================================================================
    local function boutStand(state)
        if state.real and not state.stood then
            state.stood = true
            world('boutStand', state.ta, state.tb)
        end
    end

    local function boutFinish(ctx, state, reason, loser)
        if state.phase == 'over' then return end
        boutStand(state)
        state.phase = 'over'
        if loser == 'a' then ctx:emit('bout:' .. state.id .. ':a-down') elseif loser == 'b' then ctx:emit('bout:' .. state.id .. ':b-down') end
        ctx:emit('bout:' .. state.id .. ':stopped')
        if reason ~= 'halted' then ctx:emit('bout:' .. state.id .. ':ended') end
    end

    -- The rounds, from the elapsed real seconds: round1 comes with started, round N when (N - 1) rounds have passed.
    local function boutRounds(ctx, state, elapsed)
        local due = math.min(state.rounds, math.floor(elapsed / state.roundSeconds) + 1)
        while state.roundNo < due and state.phase ~= 'over' do
            state.roundNo = state.roundNo + 1
            ctx:emit('bout:' .. state.id .. ':round' .. state.roundNo)
        end
    end

    local function boutBegin(ctx, state, now, real)
        state.real, state.startedAt, state.roundNo = real, now, 1
        state.phase = real and 'fighting' or 'staged'
        if real then
            ctx:track('bout', state, function() boutStand(state) end)
        else
            local winner = state.winner
            if winner ~= 'a' and winner ~= 'b' then winner = random() < 0.5 and 'a' or 'b' end
            state.winnerIs = winner
        end
        ctx:emit('bout:' .. state.id .. ':started')
        if state.phase ~= 'over' then ctx:emit('bout:' .. state.id .. ':round1') end
    end

    local function boutStaged(ctx, state, now, why)
        if why then logOnce('bout:' .. ctx.pack .. ':' .. state.id, 'bout ' .. state.id .. ' is played staged: ' .. why) end
        boutBegin(ctx, state, now, false)
    end

    local function healthOf(read)
        if type(read) ~= 'table' then return nil end
        if read.dead == true or read.defeated == true then return 0 end
        return finite(read.health) and read.health or nil
    end

    local function boutReady(ctx, state, now)
        if state.staged then return boutStaged(ctx, state, now, nil) end
        if type(env.world.fighterRead) ~= 'function' or type(env.world.boutArm) ~= 'function' then
            return boutStaged(ctx, state, now, 'the game side has no fight calls')
        end
        state.ta = state.ta or targetOf(ctx, state.a)
        state.tb = state.tb or targetOf(ctx, state.b)
        if state.ta and state.tb and world('fighterRead', state.ta) ~= nil and world('fighterRead', state.tb) ~= nil then
            local ok, notes = world('boutArm', state.ta, state.tb)
            if ok ~= true then
                return boutStaged(ctx, state, now, 'the fighters could not be armed' .. ((notes and notes ~= '') and (' (' .. tostring(notes) .. ')') or ''))
            end
            state.armedNotes = notes
            return boutBegin(ctx, state, now, true)
        end
        if now - state.readySince >= M.BOUT_PATIENCE then
            return boutStaged(ctx, state, now, 'the fighters did not attach in ' .. M.BOUT_PATIENCE .. ' s')
        end
    end

    local function boutFight(ctx, state, now)
        local ra, rb = world('fighterRead', state.ta), world('fighterRead', state.tb)
        if ra == nil or rb == nil then
            state.misses = state.misses + 1
            if state.misses >= M.BOUT_MISSES then
                logOnce('bout-gone:' .. ctx.pack .. ':' .. state.id, 'bout ' .. state.id .. ': a fighter is gone, the bout is halted')
                boutFinish(ctx, state, 'halted', nil)
            end
            return
        end
        state.misses = 0
        local ha, hb = healthOf(ra), healthOf(rb)
        -- The handicap: the held back fighter gets back a share of the damage taken since the last sample.
        if state.handicap > 0 then
            local side = state.slow
            local h = side == 'a' and ha or hb
            if h ~= nil and state.prevSlow ~= nil and h < state.prevSlow and h > 0 then
                local back = math.min(100, h + (state.prevSlow - h) * state.handicap / 100)
                world('fighterHealth', side == 'a' and state.ta or state.tb, back)
                h = back
                if side == 'a' then ha = h else hb = h end
            end
            state.prevSlow = h
        end
        local elapsed = now - state.startedAt
        boutRounds(ctx, state, elapsed)
        -- A fighter at the floor ends it (the lower one when both are).
        local aDown = ha ~= nil and ha <= state.floor
        local bDown = hb ~= nil and hb <= state.floor
        if aDown or bDown then
            local loser = (aDown and bDown) and ((ha or 0) <= (hb or 0) and 'a' or 'b') or (aDown and 'a' or 'b')
            return boutFinish(ctx, state, 'floor', loser)
        end
        if elapsed >= state.rounds * state.roundSeconds then return boutFinish(ctx, state, 'time', nil) end
    end

    R.defs.bout = {
        interval = 1,
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('bout has no id'); return nil end
            if not whoOk(spec.a) or not whoOk(spec.b) or spec.a == spec.b then log('bout ' .. id .. ' needs two different fighters, self or a cast id of the stage'); return nil end
            local state = {id = id, a = spec.a, b = spec.b, phase = 'wait', misses = 0,
                rounds = math.floor(number(spec.rounds, 1, 5, M.BOUT_ROUNDS)), roundSeconds = number(spec.roundSeconds, 10, 300, M.BOUT_ROUND_SECONDS),
                floor = number(spec.floor, 5, 60, M.BOUT_FLOOR), handicap = number(spec.handicap, 0, 60, 0), staged = spec.staged == true,
                winner = (spec.winner == 'a' or spec.winner == 'b') and spec.winner or 'random'}
            state.slow = (spec.b == 'self') and 'b' or 'a'
            ctx:on('bout:' .. id .. ':go', function()
                if state.phase == 'wait' then state.phase, state.readySince = 'ready', clock() end
            end)
            ctx:on('bout:' .. id .. ':stop', function()
                if state.phase == 'wait' then state.phase = 'over'
                elseif state.phase ~= 'over' then boutFinish(ctx, state, 'halted', nil) end
            end)
            return state
        end,
        tick = function(ctx, spec, state)
            local now = clock()
            if state.phase == 'ready' then
                boutReady(ctx, state, now)
            elseif state.phase == 'fighting' then
                boutFight(ctx, state, now)
            elseif state.phase == 'staged' then
                local elapsed = now - state.startedAt
                boutRounds(ctx, state, elapsed)
                if elapsed >= state.rounds * state.roundSeconds then
                    boutFinish(ctx, state, 'time', state.winnerIs == 'a' and 'b' or 'a')
                end
            end
        end,
        disarm = function(ctx, spec, state) if state then boutStand(state) end end,
    }

    -- ====================================================================================================================================
    -- hold-until
    -- ====================================================================================================================================
    -- The game second at which the clock next shows `hour`. A clock that is under two hours past it already shows it (reached at once), else tomorrow's.
    local function holdTarget(now, hour)
        local day = math.floor(now / M.DAY)
        local target = day * M.DAY + hour * 3600
        if target <= now then
            if now - target <= M.HOLD_PAST then return now end
            target = target + M.DAY
        end
        return target
    end
    M.holdTarget = holdTarget

    R.defs['hold-until'] = {
        interval = 1,
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('hold-until has no id'); return nil end
            local hour = number(spec.hour, 0, 24, nil)
            if not hour then log('hold-until ' .. id .. ' has no hour'); return nil end
            local state = {id = id, hour = hour, squad = eventId(spec.squad, nil), witness = eventId(spec.witness, nil), over = false}
            state.target = (gameTime() and holdTarget(gameTime(), hour)) or nil
            local function fail()
                if state.over then return end
                state.over = true
                ctx:emit('hold-until:' .. id .. ':failed')
            end
            -- The witness may be a hostage or an escortee: either one's loss fails the hold.
            if state.witness then
                ctx:on('hostage:' .. state.witness .. ':dead', fail)
                ctx:on('escortee:' .. state.witness .. ':lost', fail)
            end
            return state
        end,
        tick = function(ctx, spec, state)
            if state.over then return end
            local game = gameTime()
            if not game then logOnce('hold-clock:' .. ctx.pack .. state.id, 'hold-until ' .. state.id .. ': the game clock cannot be read'); return end
            if not state.target then state.target = holdTarget(game, state.hour) end
            if game >= state.target then
                state.over = true
                -- The squad stops its waves first: the reached event may end the stage and with it the ctx.
                if state.squad then ctx:emit('squad:' .. state.squad .. ':stand-down') end
                ctx:emit('hold-until:' .. state.id .. ':reached')
            end
        end,
    }

    -- ====================================================================================================================================
    -- apart
    -- ====================================================================================================================================
    -- V between `inner` and `outer` metres of a place accrues game minutes (the clock's step, at most 600 s per sample, real time when the game clock cannot be read).
    -- near: V came inside the inner ring, far: V went outside the outer one (each once per crossing, nothing for the first sample). Outside the ring for breakSeconds of
    -- real time is apart:<id>:broken.
    R.defs.apart = {
        interval = 1,
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('apart has no id'); return nil end
            local place = placeOf(ctx, spec.at)
            if not place then log('apart ' .. id .. ': place ' .. tostring(spec.at) .. ' is not in the stage'); return nil end
            local inner = number(spec.inner, 3, 100, M.APART_INNER)
            local outer = number(spec.outer, 10, 400, M.APART_OUTER)
            if outer <= inner then outer = inner + 1 end
            return {id = id, place = place, inner = inner, outer = outer, need = number(spec.minutes, 0.1, 1440, 10) * 60,
                breakAfter = number(spec.breakSeconds, 5, 3600, M.APART_BREAK), accrued = 0, zone = nil, outsideSince = nil, lastGame = gameTime(), lastClock = clock(), over = false}
        end,
        tick = function(ctx, spec, state)
            if state.over then return end
            local pos = playerAt()
            local game, now = gameTime(), clock()
            local step = now - state.lastClock
            state.lastClock = now
            if not pos then state.lastGame = game; return end
            local d = flat(pos, state.place)
            local zone = d < state.inner and 'near' or (d > state.outer and 'far' or 'ring')
            if state.zone ~= nil and state.zone ~= zone then
                if zone == 'near' then ctx:emit('apart:' .. state.id .. ':near') elseif zone == 'far' then ctx:emit('apart:' .. state.id .. ':far') end
                if state.over then return end
            end
            state.zone = zone
            if zone == 'ring' then
                state.outsideSince = nil
                if game and state.lastGame then
                    local delta = game - state.lastGame
                    if delta > 0 then state.accrued = state.accrued + math.min(delta, M.TOGETHER_CLAMP) end
                elseif not game then
                    state.accrued = state.accrued + math.max(0, math.min(step, M.TOGETHER_CLAMP))
                end
                if state.accrued >= state.need then
                    state.over = true
                    ctx:emit('apart:' .. state.id .. ':done')
                end
            else
                state.outsideSince = state.outsideSince or now
                if now - state.outsideSince >= state.breakAfter then
                    state.over = true
                    ctx:emit('apart:' .. state.id .. ':broken')
                end
            end
            state.lastGame = game
        end,
    }

    -- ====================================================================================================================================
    -- unseen
    -- ====================================================================================================================================
    -- Spotted: any member of the stage's squad (the squad primitive keeps them: R.squadMembers) is in combat, V is in combat, or the squad turned hostile
    -- (squad:<squad>:hostile, the pack's own go or alert). Reached: V inside `at` first. Read every 1.5 s: V's combat flag, V's position (only with an `at`) and one
    -- state per live member, members are looked up by the world adapter by id each time.
    R.defs.unseen = {
        interval = M.UNSEEN_STEP,
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('unseen has no id'); return nil end
            local place
            if spec.at ~= nil then
                place = placeOf(ctx, spec.at)
                if not place then log('unseen ' .. id .. ': place ' .. tostring(spec.at) .. ' is not in the stage') end
            end
            local state = {id = id, squad = eventId(spec.squad, nil), place = place, over = false}
            local function spotted()
                if state.over then return end
                state.over = true
                ctx:emit('unseen:' .. id .. ':spotted')
            end
            state.spot = spotted
            if state.squad then ctx:on('squad:' .. state.squad .. ':hostile', spotted) end
            return state
        end,
        tick = function(ctx, spec, state)
            if state.over then return end
            if world('playerInCombat') == true then return state.spot() end
            if state.squad and type(R.squadMembers) == 'function' then
                for _, handle in ipairs(R.squadMembers(ctx.pack, state.squad)) do
                    local read = world('actorState', handle)
                    if type(read) == 'table' and read.combat == true then return state.spot() end
                end
            end
            if state.place then
                local pos = playerAt()
                if pos and env.places.inside(state.place, pos) then
                    state.over = true
                    ctx:emit('unseen:' .. state.id .. ':reached')
                end
            end
        end,
    }

    -- ====================================================================================================================================
    -- dead-zone
    -- ====================================================================================================================================
    -- A place that silences the remote voice while V is inside: the lines of channel 'remote' wait (the lines module's holdWhile, through the world call remoteHold) and play
    -- once V is out. dead-zone:<id>:entered on the way in, :left on the way out (V must be 15 percent past the radius to leave, so the edge does not flicker).
    R.defs['dead-zone'] = {
        interval = 1,
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('dead-zone has no id'); return nil end
            local place = placeOf(ctx, spec.at)
            if not place then log('dead-zone ' .. id .. ': place ' .. tostring(spec.at) .. ' is not in the stage'); return nil end
            local state = {id = id, place = place, inside = false, nextRead = 0}
            local release = world('remoteHold', function() return state.inside end)
            if type(release) == 'function' then
                ctx:track('dead-zone', release, function(fn) pcall(fn) end)
            else
                logOnce('dead-hold:' .. ctx.pack .. id, 'dead-zone ' .. id .. ': remote lines cannot be held, the zone only reports its events')
            end
            return state
        end,
        tick = function(ctx, spec, state)
            local now = clock()
            if now < state.nextRead then return end
            local pos = playerAt()
            if not pos then state.nextRead = now + M.ZONE_SLOW; return end
            local here = env.places.inside(state.place, pos, state.inside and M.LEAVE_SLACK or 1)
            state.nextRead = now + ((flat(pos, state.place) > M.NEAR + state.place.radius) and M.ZONE_SLOW or 0)
            if here and not state.inside then
                state.inside = true
                ctx:emit('dead-zone:' .. state.id .. ':entered')
            elseif not here and state.inside then
                state.inside = false
                ctx:emit('dead-zone:' .. state.id .. ':left')
            end
        end,
    }

    -- ====================================================================================================================================
    -- workspot
    -- ====================================================================================================================================
    -- A pose on the stage's copy ('self') or a cast member, at a place when given (it waits up to 30 s for the body to stand inside it, then plays where she is). The pose
    -- is a key of M.POSES, one with no known workspot, or one the archive cannot play, plays spec.fallback (an idle key, default generic_arms_crossed) and says
    -- workspot:<id>:fallback. The device is the gestures' invisible one (workspotBegin, workspotStep and workspotEnd of mod/quest-world-scene.lua): the pose is started once,
    -- stepped once a second until it plays (a few steps) and then read once a second, workspot:<id>:set when it plays, :lost when the body leaves it, and the ctx ends it.
    local function workspotRequest(pose)
        if type(pose) ~= 'table' then return nil end
        if pose.idle then return {idle = pose.idle} end
        if pose.seat then return {seat = pose.seat} end
        return nil
    end

    local function workspotStart(ctx, state, request, now)
        local session, why = world('workspotBegin', state.target, request)
        if session == nil then
            state.why = why
            return false
        end
        state.session, state.request, state.startedAt = session, request, now
        ctx:track('workspot', session, function(s) world('workspotEnd', s) end)
        return true
    end

    local function workspotEnd(ctx, state)
        if state.session then
            local session = state.session
            state.session = nil
            ctx:untrack(session, true)
        end
    end

    local function workspotFallback(ctx, state, now, why)
        if state.fellBack then return false end
        state.fellBack = true
        logOnce('workspot-fb:' .. ctx.pack .. state.id, 'workspot ' .. state.id .. ' (' .. tostring(state.key) .. ') plays ' .. state.fallback .. ' instead' .. (why and (': ' .. tostring(why)) or ''))
        ctx:emit('workspot:' .. state.id .. ':fallback')
        if ctx.reaped then return false end
        return workspotStart(ctx, state, {idle = state.fallback}, now)
    end

    local function workspotGiveUp(ctx, state, why)
        state.phase = 'over'
        workspotEnd(ctx, state)
        logOnce('workspot-lost:' .. ctx.pack .. state.id, 'workspot ' .. state.id .. ' could not be played: ' .. tostring(why))
        ctx:emit('workspot:' .. state.id .. ':lost')
    end

    R.defs.workspot = {
        interval = 1,
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('workspot has no id'); return nil end
            local key = spec.key
            if type(key) ~= 'string' then log('workspot ' .. id .. ' has no pose'); return nil end
            local who = spec.who == nil and 'self' or spec.who
            if not whoOk(who) then log('workspot ' .. id .. ': bad who'); return nil end
            local place
            if spec.at ~= nil then
                place = placeOf(ctx, spec.at)
                if not place then log('workspot ' .. id .. ': place ' .. tostring(spec.at) .. ' is not in the stage') end
            end
            local fallback = type(spec.fallback) == 'string' and spec.fallback:match('^[%w_%-]+$') and spec.fallback or M.WORKSPOT_FALLBACK
            return {id = id, key = key, who = who, place = place, fallback = fallback, pose = M.POSES[key], phase = 'wait', since = clock(), setEmitted = false}
        end,
        tick = function(ctx, spec, state)
            if state.phase == 'over' then return end
            local now = clock()
            state.target = state.target or targetOf(ctx, state.who)
            if state.phase == 'wait' then
                local ready = state.target ~= nil and world('workspotReady', state.target) or nil
                if type(ready) ~= 'table' then
                    if now - state.since >= M.WORKSPOT_GIVE_UP then workspotGiveUp(ctx, state, 'the body never attached') end
                    return
                end
                if state.place and point(ready.position) and not env.places.inside(state.place, ready.position) and now - state.since < M.WORKSPOT_ARRIVE then return end
                state.phase = 'begin'
            end
            if state.phase == 'begin' then
                local request = workspotRequest(state.pose)
                if request == nil then
                    if workspotFallback(ctx, state, now, state.pose and state.pose.note or 'no such pose') then state.phase = 'step' else workspotGiveUp(ctx, state, state.why or 'no fallback') end
                    return
                end
                if workspotStart(ctx, state, request, now) then state.phase = 'step'; return end
                if state.why == 'busy' and now - state.since < M.WORKSPOT_GIVE_UP then return end   -- another workspot owns the body: wait for it
                if workspotFallback(ctx, state, now, state.why) then state.phase = 'step' else workspotGiveUp(ctx, state, state.why or 'refused') end
                return
            end
            -- 'step': the pose starts (a few steps), then it is watched.
            local status, why = world('workspotStep', state.session)
            if status == 'playing' then
                if not state.setEmitted then
                    state.setEmitted = true
                    ctx:emit('workspot:' .. state.id .. ':set')
                end
            elseif status == 'lost' then
                workspotEnd(ctx, state)
                state.phase = 'over'
                ctx:emit('workspot:' .. state.id .. ':lost')
            elseif status == 'failed' or status == nil then
                if status == nil and now - (state.startedAt or now) < 10 then return end   -- no answer yet (not attached): a little patience
                workspotEnd(ctx, state)
                if state.setEmitted then
                    state.phase = 'over'
                    ctx:emit('workspot:' .. state.id .. ':lost')
                elseif not workspotFallback(ctx, state, now, why) then
                    workspotGiveUp(ctx, state, why or 'refused')
                end
            end
        end,
    }

    -- ====================================================================================================================================
    -- npc-react
    -- ====================================================================================================================================
    -- Reports what the cast extra did after what V said: the NPC reaction module (mod/npc-reactions.lua) tells a sink when a reaction starts (leave, call-police, attack,
    -- cower, brawl, or one of the three commands), keyed by the person's entity. The sink compares that key with the cast member's (read when the outcome arrives, never
    -- kept) and emits npc:<id>:<kind>. Nothing is polled: this primitive has no tick.
    R.defs['npc-react'] = {
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            local castId = eventId(spec.cast, nil)
            if not id or not castId then log('npc-react needs an id and a cast id'); return nil end
            local state = {id = id, cast = castId, seen = {}}
            local sink = function(key, kind)
                local outcome = M.OUTCOMES[kind]
                if not outcome or key == nil then return end
                local handle = casts[ctx.pack .. ':' .. castId]
                if handle == nil then return end
                local mine = world('entityKey', handle)
                if mine == nil or tostring(mine) ~= tostring(key) then return end
                if state.seen[outcome] then return end
                state.seen[outcome] = true
                ctx:emit('npc:' .. id .. ':' .. outcome)
            end
            local release = world('npcOutcomeHook', sink)
            if type(release) == 'function' then
                ctx:track('npc-react', release, function(fn) pcall(fn) end)
            else
                logOnce('npc-hook', 'npc-react: the outcome of an NPC reaction cannot be heard in this game')
            end
            return state
        end,
    }

    return true
end

return M
