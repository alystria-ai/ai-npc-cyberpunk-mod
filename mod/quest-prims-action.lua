-- The action primitives of the bond quests (docs/QUEST_PRIMITIVES.md, BOND_QUESTS.md section 21): squad, hostage and escortee. Round 2, the action group.
-- It plugs into mod/quest-prims.lua through R.extend: install(R, env) adds the three definitions to R.defs and the native calls they need to env.world (the ones
-- not already there come from mod/quest-world-action.lua). Pure: every native call goes through env.world, so the tests run all of it on a fake game
-- (bridge/quest-prims-action-lua.test.mjs).
--
-- Each one is a table {interval, arm(ctx, spec, env) -> state, tick(ctx, spec, state, env), disarm(ctx, spec, state, env)}, ticked by the quest module once a second
-- at most. NOTHING runs per frame. Cost while armed: before the spawn one position read a second (every 5 s when V is more than 400 m away), then one position read
-- and one state read per member a second, plus one arm per member a second that is hostile and not yet in combat. Spawns happen at checkpoints only.
--
-- Every spawn is registered on the ctx (ctx:track) with the shared tag CyberpunkConvaiQuest and the quest's own tag, so ONE reap removes it. An entity is kept as
-- an id only and looked up again by the world adapter in each call (it counts only once the game has attached it). A character the game placed is never touched:
-- these primitives only act on their own spawns.
--
-- Events (all go through ctx:emit):
--   squad:<id>:spawned, :hostile, :wave<N>, :down, :fled        and listened: squad:<id>:go (a relaxed squad turns hostile), squad:<id>:stand-down (no more waves,
--                                                               the hold-until primitive of mod/quest-prims-scene.lua says it once its hour is reached)
--   hostage:<id>:down, :freed, :dead                            and listened: hostage:<id>:exposed (the pack's timer lifts her protection), spec.on (frees her)
--   escortee:<id>:arrived, :bolted, :back, :lost                and listened: escortee:<id>:bolt, :calm, :swap
local M = {SPAWN_DISTANCE = 150, FLED_DISTANCE = 200, FLED_AFTER = 60, SIGHT_PATIENCE = 20, SIGHT_NEAR = 25, SIGHT_FORCE = 40, UNSEEN_MIN = 60,
    SLOW_DISTANCE = 400, SLOW_STEP = 5, ATTACH_WAIT = 12, SPAWN_TRIES = 5, SPAWN_RETRY = 3, RESPAWNS = 2, VANISH_MISSES = 2, MAX_COUNT = 8, MAX_MEMBERS = 24,
    MAX_WAVES = 6, HOSTAGE_HOLD = 5, HOSTAGE_METRES = 3, DRAIN_DELAY = 0.5, VERIFY_DELAY = 0.4, DOWN_MAX_PERCENT = 30, REDRAIN_PERCENT = 60, REDRAIN_EVERY = 5,
    DRAIN_TRIES = 3, CONFIGURE_TRIES = 3, ESCORT_BONUS = 1.5, LEASH_METRES = 25, LEASH_EVERY = 5, FOLLOW_EVERY = 8, FOLLOW_FAR = 8, MEMORY_KEEP = 600, MAX_MEMORY = 32,
    FRESH_RING = 12}

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
local function eventName(value) return type(value) == 'string' and #value > 0 and #value <= 120 and value:match('^[%w][%w:%-_%.]*$') ~= nil end
local function unit(fromX, fromY, toX, toY)
    local dx, dy = toX - fromX, toY - fromY
    local length = math.sqrt(dx * dx + dy * dy)
    if length < 0.01 then return {x = 1, y = 0} end
    return {x = dx / length, y = dy / length}
end

function M.install(R, env)
    env.world = env.world or {}
    local world0 = env.world

    local function log(line) if type(env.log) == 'function' then pcall(env.log, 'Quest primitive: ' .. line) end end
    local function clock()
        local ok, value = pcall(env.clock or os.clock)
        return ok and type(value) == 'number' and value or os.clock()
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

    -- ---- the native calls --------------------------------------------------------------------------------------------------------------
    -- Whatever the game adapter does not have yet comes from mod/quest-world-action.lua (built here with the ambush module's group table). A world that already has
    -- a function by that name (a test's fake) keeps it. If the file cannot be loaded the primitives still arm and every call answers nothing.
    local ambush = env.ambush
    if ambush == nil and type(dofile) == 'function' then
        local ok, module = pcall(dofile, 'revenge-ambush.lua')
        if ok and type(module) == 'table' then ambush = module end
    end
    local natives = env.actionNatives
    if natives == nil and type(dofile) == 'function' then
        local ok, module = pcall(dofile, 'quest-world-action.lua')
        if ok and type(module) == 'table' and type(module.new) == 'function' then
            local built, W = pcall(module.new, {groups = ambush and ambush.GROUPS or nil, hidden = env.hidden, log = env.log})
            if built then natives = W end
        end
    end
    if type(natives) == 'table' then
        for name, fn in pairs(natives) do
            if type(fn) == 'function' and world0[name] == nil then world0[name] = fn end
        end
    end

    -- The cast extras of the stage, by the id the cast primitive gave them (pack:castId), so a hostage or an escortee can be one of them. The cast primitive's
    -- spawn is wrapped once: it still does exactly what it did.
    local castHandles, castCount = {}, 0
    local castSpawn = world0.castSpawn
    if type(castSpawn) == 'function' and not R.actionWrapped then
        R.actionWrapped = true
        world0.castSpawn = function(request)
            local handle, why = castSpawn(request)
            if handle ~= nil and type(request) == 'table' and type(request.id) == 'string' then
                if castCount >= M.MAX_MEMORY * 2 then castHandles, castCount = {}, 0 end
                if castHandles[request.id] == nil then castCount = castCount + 1 end
                castHandles[request.id] = handle
            end
            return handle, why
        end
    end
    local hostages = {}      -- pack:id -> the hostage's state while the stage is armed (so an escortee can take her over when she is freed)
    local memory = {}        -- pack:id -> {record, appearance, at}: what a fresh copy of an escortee needs (plain data, never a handle)
    local memoryCount = 0
    local verified = {}      -- record|group -> true | false

    -- ---- shared: tracked spawns and the appearance rule -------------------------------------------------------------------------------------
    -- One tracked spawn: the ctx removes it on every exit, and it is removed here at once (a flight, a swap) without being removed twice.
    local function track(ctx, kind, handle)
        local rec = {deleted = false, handle = handle}
        ctx:track(kind, handle, function(h)
            if rec.deleted then return end
            rec.deleted = true
            world('actorDelete', h)
        end)
        return rec
    end
    local function release(rec)
        if not rec or rec.deleted then return end
        rec.deleted = true
        world('actorDelete', rec.handle)
    end

    -- May something appear at `at` now? V within 150 m and the spot out of V's sight. When the sight cannot be told, only when V is 60 m or more away. Failing both,
    -- after V has been in range for 20 s and is 25 m or more away, and at last after 40 s whatever the distance, so a stage can never wait for ever on an empty look.
    local function mayAppear(holder, at, vpos, distance, now)
        if distance > M.SPAWN_DISTANCE then holder.inRangeSince = nil; return false end
        holder.inRangeSince = holder.inRangeSince or now
        local hidden = world('hiddenFromPlayer', at.x, at.y, at.z + 1.2)
        if hidden == true then return true end
        if hidden == nil and distance >= M.UNSEEN_MIN then return true end
        local waited = now - holder.inRangeSince
        return (waited >= M.SIGHT_PATIENCE and distance >= M.SIGHT_NEAR) or waited >= M.SIGHT_FORCE
    end

    local function snapped(x, y, z)
        local at = env.places.snap({x = x, y = y, z = z, radius = 1})
        return type(at) == 'table' and finite(at.z) and at.z or z
    end

    -- ====================================================================================================================================
    -- squad
    -- ====================================================================================================================================
    -- spec: id, at (a place of the stage), faction (a group of mod/revenge-ambush.lua, by its base name or the game's affiliation name), kinds (optional list: 'Character.x'
    -- records or words that pick records of the faction), count 1-8, hostile (false), shared (false: an injected shared threat when it turns hostile, for a squad that
    -- must react as one), waves ({afterSeconds | whenDown = true, count} list), alertAfterSeconds, points (optional explicit {x, y, z} list).

    local function factionBase(name)
        if type(name) ~= 'string' or type(ambush) ~= 'table' then return nil end
        local base = type(ambush.GROUPS) == 'table' and ambush.GROUPS[name] or nil
        if base then return base end
        if type(ambush.groupKnown) == 'function' and ambush.groupKnown(name) then return name end
        return nil
    end

    -- The records a squad of this faction may use, in order, each checked against the game once (a name this build lacks is skipped).
    local function records(state)
        local seeds = type(ambush.SEEDS) == 'table' and ambush.SEEDS[state.group] or {}
        local wanted = {}
        local function add(record) for _, known in ipairs(wanted) do if known == record then return end end wanted[#wanted + 1] = record end
        for _, kind in ipairs(state.kinds) do
            if kind:match('^Character%.[%w_]+$') then add(kind)
            else
                local word = kind:lower()
                for _, record in ipairs(seeds) do if record:lower():find(word, 1, true) then add(record) end end
            end
        end
        if #wanted == 0 then for _, record in ipairs(seeds) do add(record) end end
        local good = {}
        for _, record in ipairs(wanted) do
            local key = record .. '|' .. state.group
            if verified[key] == nil then verified[key] = world('squadVerify', record, state.group) == true end
            if verified[key] then good[#good + 1] = record end
        end
        return good
    end

    local function squadEmit(ctx, state, suffix) ctx:emit('squad:' .. state.id .. ':' .. suffix) end

    -- The points of a group: explicit ones cycled, else a ring around the place (the first group on the place, a wave on the side away from V), each on the ground.
    local function squadPoints(state, wave, count, vpos)
        local points = {}
        if #state.points > 0 then
            for index = 1, count do
                local p = state.points[((index - 1) % #state.points) + 1]
                points[index] = {x = p.x, y = p.y, z = snapped(p.x, p.y, p.z)}
            end
            return points
        end
        local radius = math.min(state.place.radius * 0.5, 1.2 + 0.7 * count)
        local first = 0
        if wave > 0 and point(vpos) then first = math.atan2 and math.atan2(state.at.y - vpos.y, state.at.x - vpos.x) or math.atan(state.at.y - vpos.y, state.at.x - vpos.x) end
        for index = 1, count do
            local x, y = state.at.x, state.at.y
            if count > 1 or wave > 0 then
                local angle = first + (index - 1) * 2 * math.pi / math.max(count, 1)
                x, y = x + radius * math.cos(angle), y + radius * math.sin(angle)
            end
            points[index] = {x = x, y = y, z = snapped(x, y, state.at.z)}
        end
        return points
    end

    local function trySpawn(ctx, state, group, m, vpos, now)
        if m.tries >= M.SPAWN_TRIES then m.lost = true; return end
        m.tries = m.tries + 1
        m.nextTry = now + M.SPAWN_RETRY
        local facing = point(vpos) and unit(m.x, m.y, vpos.x, vpos.y) or {x = 1, y = 0}
        local handle, why = world('squadSpawn', {id = ctx.pack .. ':' .. state.id .. ':' .. m.n, who = 'extra', record = m.record, faction = state.group,
            x = m.x, y = m.y, z = m.z, facing = facing, tag = ctx.tag})
        if handle ~= nil then
            m.handle, m.spawnedAt, m.rec = handle, now, track(ctx, 'squad', handle)
        else
            log('squad ' .. state.id .. ' member ' .. m.n .. ' spawn try ' .. m.tries .. ' failed: ' .. tostring(why))
            if m.tries >= M.SPAWN_TRIES then m.lost = true end
        end
    end

    local function startGroup(ctx, state, wave, count, vpos, now)
        local total = 0
        for _, g in ipairs(state.groups) do total = total + #g.members end
        count = math.min(count, M.MAX_MEMBERS - total)
        if count < 1 then return nil end
        local group = {wave = wave, members = {}, emitted = false}
        local points = squadPoints(state, wave, count, vpos)
        for index = 1, count do
            local p = points[index]
            local m = {n = total + index, record = state.records[((total + index - 1) % #state.records) + 1], x = p.x, y = p.y, z = p.z,
                tries = 0, nextTry = 0, seen = false, down = false, lost = false, miss = 0}
            group.members[index] = m
            trySpawn(ctx, state, group, m, vpos, now)
        end
        state.groups[#state.groups + 1] = group
        return group
    end

    local function becomeHostile(ctx, state, reason)
        if state.hostile then return end
        state.hostile, state.reason = true, reason
        if state.spawnedEmitted and not state.hostileEmitted then
            state.hostileEmitted = true
            squadEmit(ctx, state, 'hostile')
        end
    end

    local function despawn(state)
        for _, group in ipairs(state.groups) do
            for _, m in ipairs(group.members) do release(m.rec) end
        end
    end

    local function squadLive(ctx, state, vpos, now)
        local rows = {}
        local alive, pending, nearest = 0, 0, nil
        for _, group in ipairs(state.groups) do
            for _, m in ipairs(group.members) do
                if not (m.lost or m.down) then
                    if not m.handle then
                        if now >= m.nextTry then
                            trySpawn(ctx, state, group, m, vpos, now)
                        end
                        if not m.lost then pending = pending + 1 end
                    else
                        local read = world('actorState', m.handle)
                        if read == nil then
                            if m.seen then
                                m.miss = m.miss + 1
                                if m.miss >= M.VANISH_MISSES then m.down = true end    -- seen once, then gone: counts as down
                            elseif now - m.spawnedAt > M.ATTACH_WAIT then
                                -- Never attached: removed, and made again (a try), then given up.
                                release(m.rec)
                                m.handle, m.rec = nil, nil
                                if m.tries > M.RESPAWNS then m.lost = true; log('squad ' .. state.id .. ' member ' .. m.n .. ' never attached, given up') end
                            end
                            if not (m.lost or m.down) then pending = pending + 1 end
                        else
                            m.miss = 0
                            local gone = read.dead == true or read.defeated == true or (finite(read.health) and read.health <= 0)
                            if not m.seen then
                                if not gone then m.seen = true
                                elseif now - m.spawnedAt > M.ATTACH_WAIT then m.lost = true; log('squad ' .. state.id .. ' member ' .. m.n .. ' never read alive, given up') end
                            end
                            if m.seen and gone then m.down = true end
                            if m.seen and not m.down then
                                alive = alive + 1
                                rows[#rows + 1] = {m = m, combat = read.combat == true}
                                if finite(read.x) and finite(read.y) and point(vpos) then
                                    local d = flat(vpos, read)
                                    if not nearest or d < nearest then nearest = d end
                                end
                                if read.combat == true and not state.hostile then becomeHostile(ctx, state, 'combat') end
                            elseif not (m.seen or m.lost) then
                                pending = pending + 1
                            end
                        end
                    end
                end
            end
        end
        state.alive, state.pending = alive, pending

        -- Groups that are placed: spawned (the first) or wave<N>, once every member was attached or given up.
        for _, group in ipairs(state.groups) do
            if not group.emitted then
                local resolved, anySeen = true, false
                for _, m in ipairs(group.members) do
                    if m.seen then anySeen = true elseif not m.lost then resolved = false end
                end
                if resolved then
                    group.emitted = true
                    if anySeen then
                        state.seenAny = true
                        if group.wave == 0 then
                            state.spawnedEmitted = true
                            squadEmit(ctx, state, 'spawned')
                            if state.alert then ctx:after(state.alert, function() becomeHostile(ctx, state, 'alert') end) end
                        else
                            squadEmit(ctx, state, 'wave' .. group.wave)
                        end
                    elseif group.wave == 0 then
                        log('squad ' .. state.id .. ': nobody could be placed')
                    end
                end
            end
        end
        if state.hostile and state.spawnedEmitted and not state.hostileEmitted then
            state.hostileEmitted = true
            squadEmit(ctx, state, 'hostile')
        end

        -- The hostile recipe, asked again about once a second for every live member that is not in combat yet.
        if state.hostile then
            for _, row in ipairs(rows) do
                if not row.combat then
                    local ok, notes = world('squadArm', row.m.handle, {shared = state.shared})
                    if ok ~= true and not row.m.armLogged then
                        row.m.armLogged = true
                        log('squad ' .. state.id .. ' member ' .. row.m.n .. ' could not be made hostile' .. ((notes and notes ~= '') and (': ' .. tostring(notes)) or ''))
                    end
                end
            end
        end

        -- Break off: V 200 m away (from the place and from every live member) for 60 s.
        local away = point(vpos) and flat(vpos, state.at) > M.FLED_DISTANCE and (nearest == nil or nearest > M.FLED_DISTANCE)
        if away then
            state.awaySince = state.awaySince or now
            if now - state.awaySince >= M.FLED_AFTER then
                despawn(state)
                state.over = true
                squadEmit(ctx, state, 'fled')
                return
            end
        else
            state.awaySince = nil
        end

        -- Waves.
        local priorSpawned = true
        for _, wave in ipairs(state.waves) do
            if not wave.spawned and not state.standDown then
                local fire = false
                if wave.whenDown then
                    fire = priorSpawned and state.seenAny and alive == 0 and pending == 0
                else
                    fire = wave.due == true
                end
                if fire then
                    wave.spawned = true
                    startGroup(ctx, state, wave.n, wave.count, vpos, now)
                    break
                end
            end
            priorSpawned = priorSpawned and wave.spawned == true
        end

        local wavesLeft = false
        for _, wave in ipairs(state.waves) do if not wave.spawned and not state.standDown then wavesLeft = true end end
        if state.seenAny and not wavesLeft and alive == 0 and pending == 0 then
            local settled = true
            for _, group in ipairs(state.groups) do if not group.emitted then settled = false end end
            if settled then
                state.over = true
                squadEmit(ctx, state, 'down')
            end
        end
    end

    -- The live squads of the armed stages by pack:id, and a read-only view of their members for a primitive that only looks (the unseen primitive of
    -- mod/quest-prims-scene.lua): the handles of the members that were seen and are neither down nor given up, as the world gave them (plain data, never an entity).
    local squads = {}
    function R.squadMembers(pack, id)
        local state = squads[tostring(pack) .. ':' .. tostring(id)]
        local list = {}
        if not state then return list end
        for _, group in ipairs(state.groups) do
            for _, m in ipairs(group.members) do
                if m.handle ~= nil and m.seen and not (m.down or m.lost) then list[#list + 1] = m.handle end
            end
        end
        return list
    end

    R.defs.squad = {
        interval = 1,
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('squad has no id'); return nil end
            local place = placeOf(ctx, spec.at)
            if not place then log('squad ' .. id .. ': place ' .. tostring(spec.at) .. ' is not in the stage'); return nil end
            local group = factionBase(spec.faction)
            if not group then log('squad ' .. id .. ': unknown faction ' .. tostring(spec.faction)); return nil end
            local at = env.places.snap(place)
            local state = {id = id, place = place, at = {x = at.x, y = at.y, z = at.z}, group = group, kinds = {}, points = {}, waves = {}, groups = {},
                count = math.floor(number(spec.count, 1, M.MAX_COUNT, 3)), hostile = spec.hostile == true, shared = spec.shared == true, phase = 'wait',
                alert = number(spec.alertAfterSeconds, 0, 86400, nil), nextCheck = 0}
            if type(spec.kinds) == 'table' then
                for _, kind in ipairs(spec.kinds) do if type(kind) == 'string' and #kind > 0 and #kind <= 100 and #state.kinds < 8 then state.kinds[#state.kinds + 1] = kind end end
            end
            if type(spec.points) == 'table' then
                for _, p in ipairs(spec.points) do if point(p) and #state.points < M.MAX_COUNT then state.points[#state.points + 1] = {x = p.x, y = p.y, z = p.z} end end
            end
            if type(spec.waves) == 'table' then
                for _, wave in ipairs(spec.waves) do
                    if type(wave) == 'table' and #state.waves < M.MAX_WAVES then
                        local row = {n = #state.waves + 1, count = math.floor(number(wave.count, 1, M.MAX_COUNT, 2)), whenDown = wave.whenDown == true}
                        row.after = number(wave.afterSeconds, 0, 86400 * 30, nil)
                        if row.whenDown or row.after then state.waves[#state.waves + 1] = row end
                    end
                end
            end
            ctx:on('squad:' .. id .. ':go', function()
                if state.over then return end
                if state.phase == 'live' then becomeHostile(ctx, state, 'go') else state.hostile, state.reason = true, 'go' end
            end)
            -- No more waves (hold-until says it when its hour is reached). The members already placed stay as they are.
            ctx:on('squad:' .. id .. ':stand-down', function() state.standDown = true end)
            squads[ctx.pack .. ':' .. id] = state
            return state
        end,
        disarm = function(ctx, spec, state)
            if state and squads[ctx.pack .. ':' .. state.id] == state then squads[ctx.pack .. ':' .. state.id] = nil end
        end,
        tick = function(ctx, spec, state)
            if state.over then return end
            local now = clock()
            if state.phase == 'wait' then
                if now < state.nextCheck then return end
                local vpos = world('playerPosition')
                if not point(vpos) then return end
                local distance = flat(vpos, state.at)
                state.nextCheck = distance > M.SLOW_DISTANCE and (now + M.SLOW_STEP) or 0
                if distance > M.SPAWN_DISTANCE then state.inRangeSince = nil; return end
                if not mayAppear(state, state.at, vpos, distance, now) then return end
                state.records = records(state)
                if #state.records == 0 then
                    log('squad ' .. state.id .. ': no fighter record found for ' .. state.group)
                    state.over = true
                    return
                end
                state.phase = 'live'
                startGroup(ctx, state, 0, state.count, vpos, now)
                for _, wave in ipairs(state.waves) do
                    if wave.after then ctx:after(wave.after, function() wave.due = true end) end
                end
                return
            end
            squadLive(ctx, state, world('playerPosition'), now)
        end,
    }

    -- ====================================================================================================================================
    -- hostage
    -- ====================================================================================================================================
    -- spec: id, at (a place of the stage), kind 'floor' (the only form built), and who she is: cast (the id of a cast extra of the stage) or record (a Character
    -- record the primitive spawns itself). hold (5 s) and metres (3): V that close for that long frees her. on: an event that frees her at once (an interaction).
    -- She is spawned friendly and configured, and about half a second later her health pool is drained (god mode on, so she cannot die), checked a moment later:
    -- hostage:<id>:down. The pack's timer lifts her protection with hostage:<id>:exposed. Freed: hostage:<id>:freed, and she can become an escortee.

    local function hostageKey(ctx, id) return ctx.pack .. ':' .. id end

    local function hostageTick(ctx, state, now)
        local handle = state.handle
        if handle == nil then
            if state.castId then
                handle = castHandles[ctx.pack .. ':' .. state.castId]
                if handle == nil then return end
                if type(handle) == 'table' and handle.kind == 'copy' then log('hostage ' .. state.id .. ': a copy of a character cannot be held down (only extras)'); state.over = true; return end
                state.handle, state.since = handle, now
            else
                local vpos = world('playerPosition')
                if not point(vpos) then return end
                local distance = flat(vpos, state.at)
                if not mayAppear(state, state.at, vpos, distance, now) then return end
                if state.tries >= M.SPAWN_TRIES then state.over = true; return end
                if now < state.nextTry then return end
                state.tries, state.nextTry = state.tries + 1, now + M.SPAWN_RETRY
                local spawned, why = world('actorSpawn', {id = ctx.pack .. ':hostage:' .. state.id, who = 'extra', record = state.record, friendly = true,
                    x = state.at.x, y = state.at.y, z = state.at.z, facing = {x = 1, y = 0}, tag = ctx.tag})
                if spawned == nil then
                    log('hostage ' .. state.id .. ' spawn try ' .. state.tries .. ' failed: ' .. tostring(why))
                    return
                end
                state.handle, state.since, state.rec = spawned, now, track(ctx, 'hostage', spawned)
            end
            return
        end

        local read = world('actorState', state.handle)
        if read == nil then
            if state.seen then
                state.miss = state.miss + 1
                if state.miss >= M.VANISH_MISSES and not state.freed then state.over = true; ctx:emit('hostage:' .. state.id .. ':dead') end
            elseif now - state.since > M.ATTACH_WAIT then
                if state.rec then
                    release(state.rec)
                    state.handle, state.rec = nil, nil
                    if state.tries >= M.RESPAWNS + 1 then state.over = true; log('hostage ' .. state.id .. ' never attached, given up') end
                else
                    state.over = true
                    log('hostage ' .. state.id .. ': the cast extra never attached, given up')
                end
            end
            return
        end
        state.miss = 0
        local x, y, z, health = read.x, read.y, read.z, read.health
        local gone = read.dead == true or read.defeated == true or (finite(health) and health <= 0)
        if gone and state.seen then
            state.over = true
            ctx:emit('hostage:' .. state.id .. ':dead')
            return
        end
        if gone then
            if now - state.since > M.ATTACH_WAIT then state.over = true; ctx:emit('hostage:' .. state.id .. ':dead') end
            return
        end
        state.seen = true

        -- Configure once, when she is attached and alive.
        if state.phase == 'attach' then
            local ok, notes = world('hostageConfigure', state.handle)
            state.configureTries = state.configureTries + 1
            if ok ~= true then log('hostage ' .. state.id .. ' configure: ' .. tostring(notes)) end
            if ok == true or state.configureTries >= M.CONFIGURE_TRIES then
                state.phase, state.configuredAt = 'configured', now
                if state.exposed then state.unprotected = world('hostageProtect', state.handle, false) == true end
            end
            return
        end
        -- About half a second after the configuration: the drain.
        if state.phase == 'configured' and now - state.configuredAt >= M.DRAIN_DELAY then
            state.drainTries = state.drainTries + 1
            state.drainOk = world('hostageDrain', state.handle) == true
            state.phase, state.drainedAt, state.lastDrain = 'drained', now, now
            return
        end
        -- About 0.4 s later: checked. Not down yet: drained again, a few times.
        if state.phase == 'drained' and now - state.drainedAt >= M.VERIFY_DELAY then
            local low = finite(health) and health <= M.DOWN_MAX_PERCENT
            if low or (not finite(health) and state.drainOk) then
                state.phase = 'down'
                ctx:emit('hostage:' .. state.id .. ':down')
            elseif state.drainTries >= M.DRAIN_TRIES then
                state.phase = 'failed'
                log('hostage ' .. state.id .. ' could not be put down')
            else
                state.phase, state.configuredAt = 'configured', now - M.DRAIN_DELAY
            end
            return
        end
        if state.phase ~= 'down' and state.phase ~= 'failed' then return end

        -- Kept down: if she gets up (the pool refills) she is drained again, at most every few seconds.
        if state.phase == 'down' and not state.freeing and finite(health) and health > M.REDRAIN_PERCENT and now - state.lastDrain >= M.REDRAIN_EVERY then
            state.lastDrain = now
            world('hostageDrain', state.handle)
        end
        if state.exposed and not state.unprotected then state.unprotected = world('hostageProtect', state.handle, false) == true end

        -- Freed: V close for the hold, or the event the stage names.
        local free = state.freeRequested
        if not free then
            local vpos = world('playerPosition')
            local px, py = finite(x) and x or state.at.x, finite(y) and y or state.at.y
            if point(vpos) and flat(vpos, {x = px, y = py}) <= state.metres then
                state.nearSince = state.nearSince or now
                free = now - state.nearSince >= state.hold
            else
                state.nearSince = nil
            end
        end
        if free then
            if not state.unprotected then world('hostageProtect', state.handle, false) end
            world('hostageRaise', state.handle)
            state.freed, state.over = true, true
            ctx:emit('hostage:' .. state.id .. ':freed')
        end
    end

    R.defs.hostage = {
        interval = 1,
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('hostage has no id'); return nil end
            local kind = spec.kind or 'floor'
            if kind ~= 'floor' then log('hostage ' .. id .. ': form ' .. tostring(kind) .. ' is not built (only floor)'); return nil end
            local place = placeOf(ctx, spec.at)
            if not place then log('hostage ' .. id .. ': place ' .. tostring(spec.at) .. ' is not in the stage'); return nil end
            local castId = eventId(spec.cast, nil)
            local record = type(spec.record) == 'string' and spec.record:match('^Character%.[%w_]+$') and spec.record or nil
            if not castId and not record then log('hostage ' .. id .. ' needs a cast id or a record'); return nil end
            local at = env.places.snap(place)
            local state = {id = id, place = place, at = {x = at.x, y = at.y, z = at.z}, castId = castId, record = record, phase = 'attach', tries = 0, nextTry = 0,
                miss = 0, seen = false, configureTries = 0, drainTries = 0, hold = number(spec.hold, 0, 600, M.HOSTAGE_HOLD),
                metres = number(spec.metres, 1, 30, M.HOSTAGE_METRES)}
            ctx:on('hostage:' .. id .. ':exposed', function()
                state.exposed = true
                if state.handle and state.configuredAt and not state.unprotected then state.unprotected = world('hostageProtect', state.handle, false) == true end
            end)
            if eventName(spec.on) then ctx:on(spec.on, function() state.freeRequested = true end) end
            hostages[hostageKey(ctx, id)] = state
            return state
        end,
        tick = function(ctx, spec, state)
            if state.over then return end
            hostageTick(ctx, state, clock())
        end,
        disarm = function(ctx, spec, state)
            if state and hostages[hostageKey(ctx, state.id)] == state then hostages[hostageKey(ctx, state.id)] = nil end
        end,
    }

    -- ====================================================================================================================================
    -- escortee
    -- ====================================================================================================================================
    -- spec: id, from (a freed hostage's id, a cast extra's id, or nothing when this escortee was escorted in an earlier stage: a fresh copy with the same appearance is
    -- made out of V's sight), record (a fallback for that copy), to (a place of the stage: escortee:<id>:arrived when she stands inside it), bonus (a health multiplier,
    -- 1.5), boltOn and calmOn (event names besides the default escortee:<id>:bolt and :calm). She follows calmly. Leash: moved to V's side at 25 m, only when not
    -- mounted and out of V's sight. The event escortee:<id>:swap replaces her with a fresh copy with the same appearance (a body held still can never be mounted).

    local function remember(ctx, state, now)
        local info = world('actorInfo', state.handle)
        if type(info) ~= 'table' or type(info.record) ~= 'string' then return end
        local key = ctx.pack .. ':' .. state.id
        if memory[key] == nil then
            if memoryCount >= M.MAX_MEMORY then memory, memoryCount = {}, 0 end
            memoryCount = memoryCount + 1
        end
        memory[key] = {record = info.record, appearance = type(info.appearance) == 'string' and info.appearance or nil, at = now}
    end

    -- Takes a handle over and configures it. Returns false while the configuration is still being tried.
    local function escorteeAdopt(ctx, state, handle, rec, now, seen)
        state.handle, state.rec, state.since, state.phase, state.seen, state.miss = handle, rec, now, 'attach', seen == true, 0
    end

    local function escorteeResolve(ctx, state, now)
        local pack = ctx.pack
        if state.from then
            local h = hostages[pack .. ':' .. state.from]
            if h then
                if h.freed and h.handle then escorteeAdopt(ctx, state, h.handle, nil, now, true); return end
                if h.over and not h.freed then state.over = true; ctx:emit('escortee:' .. state.id .. ':lost'); return end
                return    -- she is not freed yet
            end
            local cast = castHandles[pack .. ':' .. state.from]
            if cast ~= nil then
                if type(cast) == 'table' and cast.kind == 'copy' then log('escortee ' .. state.id .. ': a copy of a character is escorted by the party, not here'); state.over = true; return end
                escorteeAdopt(ctx, state, cast, nil, now)
                return
            end
        end
        -- A fresh copy: what an earlier stage remembered, else the record named here. Made out of V's sight on a ring around V, and moved to V's side at once.
        local saved = memory[pack .. ':' .. state.id]
        if saved and now - saved.at > M.MEMORY_KEEP then saved = nil end
        local record, appearance = saved and saved.record or state.record, saved and saved.appearance or nil
        if not record then return end
        local vpos = world('playerPosition')
        if not point(vpos) then return end
        if now < state.nextTry then return end
        state.nextTry = now + 1
        state.inRangeSince = state.inRangeSince or now
        state.ringIndex = (state.ringIndex or 0) % 4 + 1
        local angle = (state.ringIndex - 1) * math.pi / 2
        local x, y = vpos.x + M.FRESH_RING * math.cos(angle), vpos.y + M.FRESH_RING * math.sin(angle)
        local z = snapped(x, y, vpos.z)
        local spot = {x = x, y = y, z = z}
        local hidden = world('hiddenFromPlayer', x, y, z + 1.2)
        if not (hidden == true or now - state.inRangeSince >= M.SIGHT_PATIENCE) then return end
        if state.tries >= M.SPAWN_TRIES then state.over = true; log('escortee ' .. state.id .. ' could not be made'); return end
        state.tries = state.tries + 1
        local handle, why = world('actorSpawn', {id = pack .. ':escortee:' .. state.id, who = 'extra', record = record, appearance = appearance, friendly = true,
            x = spot.x, y = spot.y, z = spot.z, facing = unit(spot.x, spot.y, vpos.x, vpos.y), tag = ctx.tag})
        if handle == nil then log('escortee ' .. state.id .. ' spawn try ' .. state.tries .. ' failed: ' .. tostring(why)); return end
        escorteeAdopt(ctx, state, handle, track(ctx, 'escortee', handle), now)
        state.fresh = true
    end

    local function escorteeTick(ctx, state, now)
        if state.handle == nil then escorteeResolve(ctx, state, now); return end
        local read = world('actorState', state.handle)
        if read == nil then
            if state.seen then
                state.miss = state.miss + 1
                if state.miss >= M.VANISH_MISSES then state.over = true; ctx:emit('escortee:' .. state.id .. ':lost') end
            elseif now - state.since > M.ATTACH_WAIT then
                if state.rec then release(state.rec) end
                state.handle, state.rec = nil, nil
                if state.tries >= M.RESPAWNS + 1 then state.over = true; log('escortee ' .. state.id .. ' never attached, given up') end
            end
            return
        end
        state.miss = 0
        local health = read.health
        if read.dead == true or read.defeated == true or (finite(health) and health <= 0) then
            if state.seen or now - state.since > M.ATTACH_WAIT then state.over = true; ctx:emit('escortee:' .. state.id .. ':lost') end
            return
        end
        state.seen = true
        local x, y, z, mounted = read.x, read.y, read.z, read.mounted == true
        if finite(x) and finite(y) and finite(z) then state.lastX, state.lastY, state.lastZ = x, y, z end

        if state.phase == 'attach' then
            local ok, notes = world('escorteeConfigure', state.handle, {bonus = state.bonus})
            state.configureTries = state.configureTries + 1
            if ok ~= true then log('escortee ' .. state.id .. ' configure: ' .. tostring(notes)) end
            if ok == true or state.configureTries >= M.CONFIGURE_TRIES then
                state.phase, state.followAt, state.leashAt = 'follow', now, now
                state.configureTries = 0
                remember(ctx, state, now)
                if state.fresh then
                    state.fresh = false
                    if world('escorteeLeash', state.handle) == true then state.leashAt = now end
                end
                if state.replacing then
                    -- The fresh copy is in: the old body goes.
                    release(state.replacing)
                    state.replacing = nil
                end
            end
            return
        end

        local vpos = world('playerPosition')
        local distance = nil
        if point(vpos) and finite(x) and finite(y) then distance = flat(vpos, {x = x, y = y}) end

        if state.to and not state.arrived and finite(x) and finite(y) and finite(z) and env.places.inside(state.to, {x = x, y = y, z = z}) then
            state.arrived = true
            ctx:emit('escortee:' .. state.id .. ':arrived')
            if state.over then return end
        end
        if state.bolted or mounted or distance == nil then return end

        -- The leash: far from V, not mounted and out of V's sight, she is moved to V's side.
        if distance >= M.LEASH_METRES and now - state.leashAt >= M.LEASH_EVERY then
            if world('hiddenFromPlayer', x, y, (finite(z) and z or 0) + 1.2) == true then
                state.leashAt = now
                world('escorteeLeash', state.handle)
                return
            end
        end
        -- The follow is asked again every few seconds while she is not close.
        if distance > M.FOLLOW_FAR and now - state.followAt >= M.FOLLOW_EVERY then
            state.followAt = now
            world('escorteeFollow', state.handle)
        end
    end

    local function escorteeSwap(ctx, state)
        if state.handle == nil or state.replacing or state.phase ~= 'follow' or not finite(state.lastX) then return end
        local now = clock()
        local fresh, why = world('actorReplace', state.handle, {id = ctx.pack .. ':escortee:' .. state.id, who = 'extra', friendly = true,
            x = state.lastX, y = state.lastY, z = state.lastZ, facing = {x = 1, y = 0}, tag = ctx.tag})
        if fresh == nil then log('escortee ' .. state.id .. ' swap failed: ' .. tostring(why)); return end
        -- The old body is released once the fresh copy is attached and configured (escorteeTick). A hostage's or a cast extra's body is deleted by the world call
        -- (the ctx removes it once more, which finds nothing).
        state.replacing = {deleted = false, handle = state.handle}
        escorteeAdopt(ctx, state, fresh, track(ctx, 'escortee', fresh), now)
        state.fresh = false
    end

    R.defs.escortee = {
        interval = 1,
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('escortee has no id'); return nil end
            local from = eventId(spec.from, nil)
            local record = type(spec.record) == 'string' and spec.record:match('^Character%.[%w_]+$') and spec.record or nil
            local saved = memory[ctx.pack .. ':' .. id]
            if not from and not record and not saved then log('escortee ' .. id .. ' has nothing to follow from'); return nil end
            local to
            if spec.to ~= nil then
                to = placeOf(ctx, spec.to)
                if not to then log('escortee ' .. id .. ': place ' .. tostring(spec.to) .. ' is not in the stage') end
            end
            local state = {id = id, from = from, record = record, to = to, phase = 'resolve', tries = 0, nextTry = 0, miss = 0, seen = false, configureTries = 0,
                bonus = number(spec.bonus, 1, 5, M.ESCORT_BONUS), bolted = false, arrived = false, leashAt = 0, followAt = 0}
            local function bolt()
                if state.over or state.bolted or not state.handle or state.phase ~= 'follow' then return end
                state.bolted = true
                world('escorteeBolt', state.handle)
                ctx:emit('escortee:' .. id .. ':bolted')
            end
            local function calm()
                if state.over or not state.bolted or not state.handle then return end
                state.bolted = false
                state.followAt = clock()
                world('escorteeCalm', state.handle)
                ctx:emit('escortee:' .. id .. ':back')
            end
            ctx:on('escortee:' .. id .. ':bolt', bolt)
            ctx:on('escortee:' .. id .. ':calm', calm)
            if eventName(spec.boltOn) then ctx:on(spec.boltOn, bolt) end
            if eventName(spec.calmOn) then ctx:on(spec.calmOn, calm) end
            ctx:on('escortee:' .. id .. ':swap', function() if not state.over then escorteeSwap(ctx, state) end end)
            return state
        end,
        tick = function(ctx, spec, state)
            if state.over then return end
            escorteeTick(ctx, state, clock())
        end,
    }

    return true
end

return M
