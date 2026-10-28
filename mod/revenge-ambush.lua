-- Revenge ambushes (Settings > Gameplay > Revenge ambushes, off by default; docs/AMBUSHES.md).
--
-- A gang that V keeps killing may send a small squad after V, rarely, with a short threat of its own (an AI line through the mod's voice route). This file is
-- only the decisions: it holds a grudge per gang, decides when a squad comes, and runs the squad's life. Everything the game does (find a spot, create the
-- fighters, make them hostile, read them, delete them, say the line) is a function in `options`, made in mod/revenge-ambush-world.lua and mod/init.lua.
--
-- The game has no system of its own for this (docs/AMBUSHES.md): its gang chases are scripted into single gigs and quests, and its prevention system is the
-- police only. So the squad is built from what the mod already uses: a hidden, reachable spot from the invitation code, a DynamicEntitySystem spawn, and the
-- attack the NPC reactions use.
--
-- FPS: no update function and no hook of its own. The grudge is fed by the Street reputation recorder's deeds (one table update per kill V makes). tick() is
-- called from the mod's 0.1 s tick, subtracts the elapsed time from one counter and does nothing else until its period is up: 30 s while nothing happens,
-- 1 s only while a squad is being placed or fights (a few minutes in an hour at most).
local M = {version = 1}

M.PATH = 'runtime/ambush-state.json'
M.THRESHOLD = 6          -- grudge points a gang needs before it may come (six witnessed kills; a defeat counts 0.4, an unseen kill 0.25)
M.MAX_POINTS = 30
M.HALF_LIFE_DAYS = 14    -- game days, the same memory as the Street reputation deeds
M.AFTER_SPENT = 0.5      -- the share of the grudge left once a squad was sent (revenge taken)
M.CHECK = 30             -- seconds between two looks while nothing happens
M.STEP = 1               -- seconds between two steps while a squad is placed or fights
M.COOLDOWN = 2700        -- seconds (45 minutes of play) between two squads, whichever gang
M.RETRY_COOLDOWN = 600   -- the cooldown left after a squad could not be placed
M.AFTER_READY = 240      -- seconds of play after a load before the first squad may come
M.CALM = 90              -- seconds V must have been out of a fight before a squad may come
M.CHANCE = 0.25          -- the chance at each look once a gang is over the threshold, plus CHANCE_STEP for each point above it
M.CHANCE_STEP = 0.02
M.CHANCE_MAX = 0.6
M.SEARCH_STEPS = 12      -- steps a spot search may take (a few queries each)
M.ARM_TRIES = 4
M.BARK_RANGE = 28        -- metres: a member this close to V says the line, once
M.BARK_GIVE_UP = 20      -- seconds after the first member is armed before the line is given up
M.ACTIVE_MAX = 240       -- seconds a squad may last
M.FAR = 170              -- metres: V has left the squad behind
M.CORPSE_KEEP = 120      -- seconds a fallen member stays before it is removed
M.STATE_MAX_AGE = 60 * 86400
M.FLUSH_EVERY = 300
M.DAY = 86400

-- The game's affiliation names (TweakDB enum, as the NPC archetypes read them) -> the archetype base the bridge and the voices know.
M.GROUPS = {
    Maelstrom = 'maelstrom', MaelstromAndroid = 'maelstrom',
    TygerClaws = 'tyger-claws',
    Valentinos = 'valentinos',
    SixthStreet = 'sixth-street', SixthStreetAndroid = 'sixth-street',
    Animals = 'animals',
    VoodooBoys = 'voodoo-boys',
    Scavengers = 'scavengers', ScavengersAndroid = 'scavengers',
    Wraiths = 'wraiths', WraithsAndroid = 'wraiths',
    TheMox = 'mox',
    Aldecaldos = 'aldecaldos',
    Barghest = 'barghest',
}

-- Who the squad is made of: the fighters V actually killed (their TweakDB records are remembered per gang, up to six, from the deeds), else the game's own
-- retaliation fighters (the `gang_retaliation_enemies_*` characters its gang car chases are made of, tuned to hunt V), else an ordinary grunt of the gang.
-- Each record is checked against the game before use (verify), so a name the build lacks is skipped. A gang with none sends no squad (logged once).
M.SEEDS = {
    maelstrom = {'Character.gang_retaliation_enemies_maelstrom_ranged1_lexington_ma_kab_02', 'Character.gang_retaliation_enemies_maelstrom_ranged2_copperhead_wa_kab_02',
        'Character.maelstrom_grunt1_ranged1_lexington_ma'},
    ['tyger-claws'] = {'Character.gang_retaliation_enemies_tygerclaws_gangster2_ranged2_copperhead_ma', 'Character.gang_retaliation_enemies_tygerclaws_gangster2_ranged2_sidewinder_wa',
        'Character.gang_retaliation_enemies_tygerclaws_biker2_melee2_baseball_ma', 'Character.tyger_claws_gang3_katana_wa', 'Character.tyger_claws_biker1_melee1_baseball_wa'},
    valentinos = {'Character.gang_retaliation_enemies_valentinos_ranged1_nova_wa_rey_02', 'Character.gang_retaliation_enemies_valentinos_ranged1_nue_ma_rey_02',
        'Character.valentinos_grunt_ma', 'Character.valentinos_grunt2_ma'},
    ['sixth-street'] = {'Character.gang_retaliation_enemies_sixthstreet_ranged1_saratoga_ma', 'Character.gang_retaliation_enemies_sixthstreet_ranged2_ajax_wa',
        'Character.gang_retaliation_enemies_sixthstreet_melee2_baton_wa'},
    animals = {'Character.gang_retaliation_enemies_animals_ranged1_nova_mb_dtn_03', 'Character.gang_retaliation_enemies_animals_melee2_machete_mb_dtn_03'},
    wraiths = {'Character.gang_retaliation_enemies_wraiths_ranged1_nova_ma', 'Character.gang_retaliation_enemies_wraiths_ranged1_pulsar_wa',
        'Character.gang_retaliation_enemies_wraiths_melee2_crowbar_wa'},
    aldecaldos = {'Character.aldecaldos_grunt'},
}
M.RECORDS_KEPT = 6
-- Records that are not an ordinary fighter of the gang (a boss, a netrunner, a machine, a quest actor) are never copied into a squad.
M.NOT_A_GRUNT = {'boss', 'psycho', 'netrunner', 'sniper', 'heavy', 'mech', 'android', 'drone', 'vendor', 'quest', 'sts_', 'mq0', 'sq0', 'q10', 'q11', 'q20', 'dog', 'turret', 'crowd', 'civ'}

-- options (all optional but enabled/clock; a missing native function means that step is skipped):
--   enabled()                the setting (manager.revengeAmbushes)           clock()      seconds (os.clock)
--   gameTime()               game seconds or nil                              random()     [0,1)
--   world()                  nil when V is in ordinary play, else why not ('combat', 'scene', 'call', 'vehicle', 'interior', 'wanted', 'unreadable')
--   playerNear(npc)          metres from V to the NPC, or nil                 alive(npc)   true while it lives
--   recordOf(npc)            the TweakDB record name of an NPC V killed ('Character.x') or nil
--   verify(record, group)    true when the game has that character record and it belongs to that gang
--   findSpot(state, relax)   spot {position, facing} | nil, why | nil, nil, true (ask again)
--   create(record, spot, index, count) -> handle | nil, why                  entity(handle) -> npc or nil (not attached yet)
--   arm(npc) -> true when it is hostile to V and fights                       hidden(npc) -> true | false | nil
--   delete(handle)           bark(npc, info) -> true when the line went out   read(path) -> text | nil     write(path, text) -> bool
--   log(line)
function M.new(options)
    options = type(options) == 'table' and options or {}
    local S = {options = options, groups = {}, phase = 'idle', acc = 0, ready = 0, calm = 0, dirty = false, loaded = false,
        cleanup = {}, spent = 0, logged = {}, lastFlush = nil, lastAt = nil, counts = {looks = 0, squads = 0, failed = 0}}
    local clock = options.clock or os.clock
    local random = options.random or math.random

    local function call(fn, ...)
        if type(fn) ~= 'function' then return nil end
        local ok, value, second, third = pcall(fn, ...)
        if ok then return value, second, third end
        S.lastError = tostring(value)
        return nil
    end
    local function say(key, line)
        if S.logged[key] then return end
        S.logged[key] = true
        if type(options.log) == 'function' then pcall(options.log, line) end
    end
    function S.on()
        local ok, value = pcall(options.enabled or function() return false end)
        return ok and value == true
    end

    local function decayed(group, now)
        local points = group.points
        if now and group.t and now > group.t then points = points * 0.5 ^ ((now - group.t) / (M.HALF_LIFE_DAYS * M.DAY)) end
        return points
    end
    -- The grudge of one gang right now (decayed to the game clock).
    function S.points(name)
        local group = S.groups[name]
        if not group then return 0 end
        return decayed(group, call(options.gameTime))
    end

    -- ---- the grudge ---------------------------------------------------------------------------------------------------------
    -- One deed of the Street reputation recorder (mod/reputation.lua: kill, defeat, heat, react; the row has the affiliation a, police p, crowd c, witnessed w,
    -- game second t). Only what V did to a gang's people counts. Called once per kill V makes: a table update, no native read.
    local function grunt(record)
        if type(record) ~= 'string' or not record:match('^Character%.[%w_]+$') then return false end
        local lower = record:lower()
        for _, token in ipairs(M.NOT_A_GRUNT) do if lower:find(token, 1, true) then return false end end
        return true
    end
    function S.deed(row, npc)
        if not S.on() or type(row) ~= 'table' then return false end
        if row.k ~= 'kill' and row.k ~= 'defeat' then return false end
        if row.p == true or row.c == true then return false end
        local name = M.GROUPS[row.a]
        if not name then return false end
        local weight = row.k == 'kill' and (row.w == true and 1 or 0.25) or (row.w == true and 0.4 or 0.1)
        local now = tonumber(row.t) or call(options.gameTime)
        local group = S.groups[name] or {points = 0, t = now}
        group.points = math.min(M.MAX_POINTS, decayed(group, now) + weight)
        group.t = now
        group.records = group.records or {}
        -- The fighter V killed is what the gang sends back: its record, newest last, each once.
        local record = npc ~= nil and call(options.recordOf, npc) or nil
        if grunt(record) then
            for index, known in ipairs(group.records) do if known == record then table.remove(group.records, index); break end end
            group.records[#group.records + 1] = record
            while #group.records > M.RECORDS_KEPT do table.remove(group.records, 1) end
        end
        S.groups[name] = group
        S.dirty = true
        return true
    end

    -- ---- the saved grudge ---------------------------------------------------------------------------------------------------
    -- runtime/ambush-state.json: {version, groups = {name = {p, t}}}. A load can only forget: a grudge stamped later than the game clock now (an older save, or
    -- another playthrough) or older than 60 game days is dropped, the same guard as the reputation deeds.
    local function loadState()
        if S.loaded then return end
        local now = call(options.gameTime)
        if type(now) ~= 'number' then return end
        S.loaded = true
        local raw = call(options.read, M.PATH)
        if type(raw) ~= 'string' or raw == '' then return end
        local ok, data = pcall(json.decode, raw)
        if not ok or type(data) ~= 'table' or data.version ~= 1 or type(data.groups) ~= 'table' then return end
        for name, row in pairs(data.groups) do
            local points, t = type(row) == 'table' and tonumber(row.p) or nil, type(row) == 'table' and tonumber(row.t) or nil
            if M.groupKnown(name) and points and t and points > 0 and t <= now + 3600 and now - t <= M.STATE_MAX_AGE then
                local existing = S.groups[name]
                if not existing then
                    local records = {}
                    for _, record in ipairs(type(row.r) == 'table' and row.r or {}) do
                        if grunt(record) and #records < M.RECORDS_KEPT then records[#records + 1] = record end
                    end
                    S.groups[name] = {points = math.min(M.MAX_POINTS, points), t = t, records = records}
                end
            end
        end
    end
    function S.flush(reason)
        if not S.dirty then return false end
        local out = {}
        for name, group in pairs(S.groups) do
            local points = decayed(group, call(options.gameTime))
            if points >= 0.5 then out[name] = {p = math.floor(points * 100 + 0.5) / 100, t = group.t, r = group.records or {}} end
        end
        local encoded, raw = pcall(function() return json.encode({version = 1, groups = out}) end)
        if not encoded or type(raw) ~= 'string' then return false end
        local written = false
        if type(options.write) == 'function' then
            local ok, result = pcall(options.write, M.PATH, raw)
            written = ok and result ~= false
        else
            local okOpen, file = pcall(io.open, M.PATH, 'wb')
            if okOpen and file then
                written = pcall(function() file:write(raw) end)
                pcall(function() file:close() end)
            end
        end
        if written then S.dirty, S.lastFlush = false, clock(); say('flush:' .. tostring(reason), 'Ambushes: grudges written (' .. tostring(reason) .. ')') end
        return written
    end

    -- ---- removing what the squad left ---------------------------------------------------------------------------------------
    local function remove(handle) if handle ~= nil then call(options.delete, handle) end end
    local function sweep(now, force)
        local keep = {}
        for _, item in ipairs(S.cleanup) do
            local gone = false
            if now >= item.due then
                local npc = not force and call(options.entity, item.handle) or nil
                -- A live member goes only out of V's sight (a vanishing in front of V is worse than a late one), or after three tries.
                if npc ~= nil and call(options.alive, npc) == true and call(options.hidden, npc) == false and (item.tries or 0) < 3 then
                    item.tries = (item.tries or 0) + 1
                    item.due = now + M.CHECK
                else
                    remove(item.handle); gone = true
                end
            end
            if not gone then keep[#keep + 1] = item end
        end
        S.cleanup = keep
    end
    local function release(members, now, immediately)
        for _, member in ipairs(members) do
            S.cleanup[#S.cleanup + 1] = {handle = member.handle, due = now + (immediately and 0 or (member.dead and M.CORPSE_KEEP or 0))}
        end
    end

    -- ---- looking: should a squad come now ------------------------------------------------------------------------------------
    local function strongest()
        local best, bestPoints
        local now = call(options.gameTime)
        for name, group in pairs(S.groups) do
            local points = decayed(group, now)
            if points >= M.THRESHOLD and not (S.skip and S.skip[name]) and (not bestPoints or points > bestPoints) then
                best, bestPoints = name, points
            end
        end
        return best, bestPoints
    end
    -- The records a squad of this gang may be made of, newest kill first, each checked against the game.
    function S.fighters(name)
        local group, out, seen = S.groups[name], {}, {}
        local function add(record)
            if seen[record] then return end
            seen[record] = true
            if call(options.verify, record, name) == true then out[#out + 1] = record end
        end
        local learned = group and group.records or {}
        for index = #learned, 1, -1 do add(learned[index]) end
        if #out == 0 then for _, record in ipairs(M.SEEDS[name] or {}) do add(record) end end
        return out
    end
    function S.consider(now)
        S.counts.looks = S.counts.looks + 1
        local reason = call(options.world)
        if reason ~= nil then S.calm = 0; return 'world:' .. tostring(reason) end
        S.calm = S.calm + M.CHECK
        if S.dirty and (not S.lastFlush or now - S.lastFlush >= M.FLUSH_EVERY) then S.flush('periodic') end
        if S.ready < M.AFTER_READY then return 'after-load' end
        if S.calm < M.CALM then return 'calm' end
        if S.lastAt and now - S.lastAt < (S.cooldown or M.COOLDOWN) then return 'cooldown' end
        local name, points = strongest()
        if not name then return 'no-grudge' end
        local chance = math.min(M.CHANCE_MAX, M.CHANCE + M.CHANCE_STEP * (points - M.THRESHOLD))
        if random() >= chance then return 'not-now' end
        local records = S.fighters(name)
        if #records == 0 then
            S.skip = S.skip or {}
            S.skip[name] = true
            say('norecord:' .. name, 'Ambushes: no fighter record found for ' .. name .. ', that gang will not send a squad this session')
            return 'no-record'
        end
        local count = 2 + (points >= 10 and 1 or 0) + (points >= 16 and 1 or 0)
        S.plan = {group = name, points = points, count = count, records = records, toll = points >= 12 and 'many' or 'few', relax = 0, steps = 0}
        S.spotState = {}
        S.phase = 'search'
        S.acc = 0
        say('plan:' .. tostring(S.counts.looks), 'Ambush planned: ' .. name .. ' x' .. count .. ' (grudge ' .. string.format('%.1f', points) .. ')')
        return 'planned'
    end

    -- ---- placing the squad ---------------------------------------------------------------------------------------------------
    local function giveUp(now, why)
        S.counts.failed = S.counts.failed + 1
        say('giveup:' .. S.counts.failed, 'Ambush not placed: ' .. tostring(why))
        S.plan, S.spotState, S.phase = nil, nil, 'idle'
        -- Soon, not never: the grudge is untouched; the next try is after the retry cooldown.
        S.lastAt, S.cooldown = now, M.RETRY_COOLDOWN
    end
    function S.search(now)
        local plan = S.plan
        if not plan then S.phase = 'idle'; return 'no-plan' end
        if call(options.world) ~= nil then
            S.plan, S.spotState, S.phase = nil, nil, 'idle'
            return 'world-changed'
        end
        plan.steps = plan.steps + 1
        if plan.steps > M.SEARCH_STEPS then giveUp(now, 'no spot after ' .. M.SEARCH_STEPS .. ' steps'); return 'gave-up' end
        local spot, why, again = call(options.findSpot, S.spotState, plan.relax)
        if spot == nil and again ~= true then
            -- This rung found nothing: the next one accepts nearer spots, then a spot in sight.
            if plan.relax >= 2 then giveUp(now, why); return 'gave-up' end
            plan.relax, S.spotState = plan.relax + 1, {}
            return 'relaxed'
        end
        if spot == nil then return 'searching' end
        local members = {}
        for index = 1, plan.count do
            local record = plan.records[((index - 1) % #plan.records) + 1]
            local handle = call(options.create, record, spot, index, plan.count)
            if handle ~= nil then members[#members + 1] = {handle = handle, armedTries = 0} end
        end
        if #members == 0 then giveUp(now, 'the game created nobody'); return 'gave-up' end
        local group = S.groups[plan.group]
        if group then group.points, group.t = decayed(group, call(options.gameTime)) * M.AFTER_SPENT, call(options.gameTime) or group.t; S.dirty = true end
        S.active = {group = plan.group, count = #members, toll = plan.toll, members = members, startedAt = now, barked = false}
        S.counts.squads = S.counts.squads + 1
        S.lastAt, S.cooldown = now, M.COOLDOWN
        S.plan, S.spotState, S.phase = nil, nil, 'active'
        S.flush('squad')
        if type(options.log) == 'function' then
            pcall(options.log, 'Ambush sent: ' .. plan.group .. ' x' .. #members .. ' relax=' .. plan.relax)
        end
        return 'sent'
    end

    -- ---- the squad's life ------------------------------------------------------------------------------------------------------
    function S.manage(now)
        local squad = S.active
        if not squad then S.phase = 'idle'; return 'no-squad' end
        local alive, nearest, nearestAt = 0, nil, nil
        for _, member in ipairs(squad.members) do
            if not member.dead and not member.lost then
                local npc = call(options.entity, member.handle)
                if npc == nil then
                    -- Not attached yet; a member that never appears is let go after ten seconds.
                    member.waited = (member.waited or 0) + M.STEP
                    if member.waited > 10 then member.lost = true end
                else
                    member.npc = npc
                    if call(options.alive, npc) ~= true then
                        member.dead, member.npc = true, nil
                    else
                        alive = alive + 1
                        if not member.armed and member.armedTries < M.ARM_TRIES then
                            member.armedTries = member.armedTries + 1
                            if call(options.arm, npc) == true then
                                member.armed = true
                                squad.firstArmedAt = squad.firstArmedAt or now
                            end
                        end
                        local distance = call(options.playerNear, npc)
                        if member.armed and type(distance) == 'number' and (not nearest or distance < nearest) then nearest, nearestAt = distance, npc end
                    end
                end
            end
        end
        -- The line: once, from the member closest to V, when one is within range (or soon after the first is armed, so a squad that stops short still speaks).
        if not squad.barked and squad.firstArmedAt and nearestAt ~= nil then
            local late = now - squad.firstArmedAt > M.BARK_GIVE_UP
            if late then squad.barked = true
            elseif nearest <= M.BARK_RANGE then
                if call(options.bark, nearestAt, {group = squad.group, count = squad.count, toll = squad.toll}) == true then squad.barked = true end
            end
        end
        local farAway = nearest ~= nil and nearest > M.FAR
        if alive == 0 or now - squad.startedAt >= M.ACTIVE_MAX or farAway then
            release(squad.members, now, alive > 0)
            S.active, S.phase = nil, 'idle'
            -- A fight with no one left to fight: the dead stay for a while; the living (timed out, or left behind) go out of sight.
            return alive == 0 and 'finished' or (farAway and 'left-behind' or 'timed-out')
        end
        return 'fighting'
    end

    -- ---- the tick ---------------------------------------------------------------------------------------------------------------
    -- Called from the mod's 0.1 s tick (mod/init.lua convaiAmbushTick) with the seconds since the last call and whether the world is ready.
    function S.tick(dt, ready)
        if not S.on() then
            if S.phase ~= 'idle' or #S.cleanup > 0 then S.stop('off') end
            return nil
        end
        if ready ~= true then S.ready, S.calm = 0, 0; return nil end
        dt = tonumber(dt) or 0
        S.ready = S.ready + dt
        S.acc = S.acc + dt
        local period = S.phase == 'idle' and M.CHECK or M.STEP
        if S.acc < period then return nil end
        S.acc = 0
        loadState()
        local now = clock()
        if #S.cleanup > 0 then sweep(now) end
        if S.phase == 'idle' then return S.consider(now) end
        if S.phase == 'search' then return S.search(now) end
        return S.manage(now)
    end

    -- A world ends (a load, a fast travel, a death, shutdown): the grudge is written and every reference is dropped, with NO native call (the world may be
    -- going away: mod/init.lua abandonSession). The fighters are nonpersistent and not always-spawned, so the game removes them with the world or when V
    -- is far enough; the next session also removes any tagged leftover once (revenge-ambush-world.lua sweep).
    function S.reset(reason)
        S.flush(reason or 'reset')
        S.cleanup, S.active, S.plan, S.spotState, S.phase = {}, nil, nil, nil, 'idle'
        S.acc, S.ready, S.calm, S.loaded = 0, 0, 0, false
        S.groups = {}
    end
    -- The setting was turned off in the menu: the squad is removed now (the world is alive).
    function S.stop(reason)
        local now = clock()
        if S.active then release(S.active.members, now, true) end
        for _, item in ipairs(S.cleanup) do item.due = now end
        sweep(now + 1000, true)
        S.cleanup, S.active, S.plan, S.spotState, S.phase, S.acc = {}, nil, nil, nil, 'idle', 0
        S.flush(reason or 'stop')
    end

    function S.status()
        local points = {}
        for name in pairs(S.groups) do points[name] = math.floor(S.points(name) * 10 + 0.5) / 10 end
        return {enabled = S.on(), phase = S.phase, points = points, looks = S.counts.looks, squads = S.counts.squads, failed = S.counts.failed,
            active = S.active and {group = S.active.group, count = S.active.count, barked = S.active.barked} or nil, cleanup = #S.cleanup}
    end
    return S
end

function M.groupKnown(name)
    for _, base in pairs(M.GROUPS) do if base == name then return true end end
    return false
end

return M
