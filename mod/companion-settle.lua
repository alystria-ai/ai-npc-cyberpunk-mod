-- Party companions settle in V's flat (docs/COMPANION_SETTLE.md). While V stays in one of V's own apartments the companions stop trailing V and
-- take a free seat or a standing place of the flat, spread out, and keep it until V leaves, goes far from them, drives off, or a scene or a fight
-- starts. The seats and spots are the housemates' data (mod/housemate-spots-data.lua, mod/housemate-plan.lua, mod/housemate-world.lua), but nothing
-- of the Housemates feature runs: this module is its own and works with that setting Off.
--
-- Cost: this module does not exist away from V's flats. mod/init.lua builds it when the game pushes a district change into one of the five flats
-- (ObserveAfter PreventionSystem.OnDistrictAreaEntered) and drops it on the next change out. Inside, tick() is driven by the companions' own body
-- animation tick (no timer of its own): one step every half second, one native read of V's position, a bounded number of raycasts to find the
-- real seats (mod/housemate-world.lua prepare, a few per step, only while a companion still waits for a place), and a district check every
-- few seconds as a net for a missed event. Seating and walking are done by mod/companion-seating.lua (the home API there).
--
-- deps: load(name) -> module (dofile); seating() -> the seating controller; vpos() -> {x, y, z} | nil; held() -> 'combat' | 'scene' | 'car' | nil
--       (V cannot settle now); district() -> the flat id V stands in now | nil; others(apt) -> the spots housemates hold {id, x, y, z}
--       (nil without housemates); member(entity) -> {serial, key, name} for a party member | nil; world() -> the spot preparer
--       (default: housemate-world.lua); log(kind, fields)
local M = {}

M.STEP = 0.5            -- seconds between two steps
M.STAY = 10             -- seconds in the flat before they settle: V is "staying"
M.QUIET = 3             -- ... and has not moved more than QUIET_RADIUS in the last QUIET seconds (V is not heading for the door)
M.QUIET_RADIUS = 1.0
M.PREP_AFTER = 3        -- seconds in the flat before the real seats are looked for
M.SIT_AFTER = 1.5       -- V sitting down settles them after this long in the flat
M.AGAIN = 6             -- quiet seconds needed to settle again after a scene, a fight or a car
M.FAR = 12              -- metres: V this far from the nearest settled companion ends it
M.FLOOR = 3.5           -- metres of height difference that does the same
M.RECHECK = 6           -- seconds between two district checks (a missed event)
M.RAYS = 24             -- surface reads one step may spend finding real seats (36 for the housemates)
M.NEAR_V = 1.0          -- a place this close to V is not given away
M.SPACING = 0.9         -- metres between two places (seats of one piece of furniture are closer, by design)
M.GROUP = 0.5
M.SIT_BIAS = 1.5        -- metres: a seat counts this much nearer than a standing place

local SIT = {couch = true, chair = true, bar = true, stool = true}
local STAND = {stand = true, window = true, lean = true}
local function flat(a, b) return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2) end
local atan2 = math.atan2 or math.atan
local function yawToward(from, to) return math.deg(atan2(-(to.x - from.x), to.y - from.y)) end

function M.new(d)
    local S = {state = 'idle', apt = nil}
    local plan = d.load('housemate-plan.lua')
    local data = d.load('housemate-spots-data.lua')
    local world
    local acc, age, sinceCheck = 0, 0, 0
    local still                 -- {at = {x, y}, quiet = seconds}: where V has been standing about
    local queue, prepared, bad = {}, {}, {}
    local claimed = {}          -- serial -> place
    local learned = {}          -- V's own seat roots seen in this visit
    local prepDone = false
    local members, unplaced = 0, 0
    local homeId

    local function log(kind, fields) if d.log then pcall(d.log, kind, fields) end end
    local function seating() return d.seating and d.seating() or nil end

    -- ---- the spots of this flat ---------------------------------------------------------------------------------------------------------
    local function ctx()
        local apartment = data.apartments[S.apt]
        local vslots, knownV = {}, false
        for _, l in ipairs(learned) do vslots[#vslots + 1] = l; knownV = true end
        for _, spot in ipairs(apartment and apartment.spots or {}) do
            if spot.vslot then vslots[#vslots + 1] = spot; knownV = true end
        end
        return {rejected = bad, knownV = knownV, vslots = vslots}
    end
    -- The places worth preparing, nearest to V first (a seat counts nearer).
    local function buildQueue()
        queue = {}
        local apartment = data.apartments[S.apt]
        if not apartment then return end
        local v = d.vpos and d.vpos() or nil
        for _, spot in ipairs(plan.usable(apartment, ctx())) do
            if SIT[spot.kind] or STAND[spot.kind] then
                spot.rank = (v and flat(spot, v) or 0) - (SIT[spot.kind] and M.SIT_BIAS or 0)
                queue[#queue + 1] = spot
            end
        end
        table.sort(queue, function(a, b)
            if a.rank ~= b.rank then return a.rank < b.rank end
            return a.id < b.id
        end)
    end
    local function worldFor()
        if world then return world end
        local seat = seating()
        if d.world then world = d.world(seat) else
            local World = d.load('housemate-world.lua')
            World.RAYS_PER_WINDOW = M.RAYS
            world = World.new({seating = {native = seat and seat.native}, catalog = {}, vpos = d.vpos,
                log = function(kind, fields) log(kind, fields) end})
        end
        return world
    end
    -- Find the real seat behind a few more spots (one step's worth of rays), only while somebody still needs a place.
    local function prepareSome()
        if prepDone then return end
        local seat = seating()
        local sits = seat and seat.canSit() ~= false
        -- Enough when every companion without a place has one waiting, and one more.
        local taken = {}
        for _, h in ipairs(seat and seat.homeHeld() or {}) do taken[h.id] = true end
        local free = 0
        for _, spot in ipairs(queue) do
            if prepared[spot.id] and not taken[spot.id] and (sits or not SIT[spot.kind]) then free = free + 1 end
        end
        if free >= unplaced + 1 then return end
        local w = worldFor()
        local done = 0
        for _, spot in ipairs(queue) do
            if prepared[spot.id] == nil and not bad[spot.id] and (sits or not SIT[spot.kind]) then
                local place, why, wait = w.prepare(spot, {key = 'settle:' .. tostring(S.apt)})
                if wait then return end
                if place then
                    place.id, place.group, place.face = spot.id, spot.group, spot.face
                    if place.yaw == nil and spot.yaw then place.yaw = spot.yaw end
                    prepared[spot.id] = place
                    log('settle-spot', {id = spot.id, kind = place.kind, x = place.x, y = place.y, yaw = place.yaw})
                else
                    prepared[spot.id] = false
                    bad[spot.id] = true
                    log('settle-spot-rejected', {id = spot.id, why = why})
                end
                done = done + 1
                free = free + (place and 1 or 0)
                if done >= 2 or free >= unplaced + 1 then return end
            end
        end
        prepDone = true
    end

    -- ---- giving a place --------------------------------------------------------------------------------------------------------------------
    local function held()
        local seat = seating()
        local list = {}
        for _, h in ipairs(seat and seat.homeHeld() or {}) do list[#list + 1] = h end
        return list
    end
    -- Is this place free of everyone: other companions, V's seat, V, the housemates?
    local function free(place, taken, v, vSeat, others)
        if bad[place.id] then return false end
        if v and flat(place, v) < M.NEAR_V and math.abs((place.z or 0) - (v.z or 0)) < 1.2 then return false end
        if vSeat and flat(place, vSeat) < 0.5 and math.abs((place.z or 0) - (vSeat.z or 0)) < 0.8 then return false end
        for _, t in ipairs(taken) do
            if t.id == place.id then return false end
            local mate = prepared[t.id]
            local limit = (place.group and mate and mate.group == place.group) and M.GROUP or M.SPACING
            if t.id == 'beside-v' then limit = M.GROUP end
            if flat(place, t) < limit and math.abs((place.z or 0) - (t.z or 0)) < 1.2 then return false end
        end
        for _, o in ipairs(others) do
            if o.id == place.id or (flat(place, o) < 0.6 and math.abs((place.z or 0) - (o.z or 0)) < 1.2) then return false end
        end
        return true
    end

    local function others()
        if not d.others then return {} end
        local ok, list = pcall(d.others, S.apt)
        return ok and type(list) == 'table' and list or {}
    end

    -- The seating controller asks, once a second per companion without a place.
    local function claim(entry)
        if S.state ~= 'settled' then return nil end
        local seat = seating()
        if not seat then return nil end
        local v = d.vpos and d.vpos() or nil
        local vSeat = seat.vSeat()
        local taken, other = held(), others()
        local sits = seat.canSit()
        local at = entry.position or v
        local best, bestScore
        for _, spot in ipairs(queue) do
            local place = prepared[spot.id]
            if place and (sits or not SIT[place.kind]) and free(place, taken, v, vSeat, other) then
                local score = (at and flat(at, place) or 0) - (SIT[place.kind] and M.SIT_BIAS or 0)
                if not bestScore or score < bestScore then best, bestScore = place, score end
            end
        end
        if not best and prepDone then
            -- No real place left: she stands somewhere in the room, away from V and the others (the housemates' procedural spots).
            local used = {}
            for _, t in ipairs(taken) do used[#used + 1] = t end
            for _, o in ipairs(other) do used[#used + 1] = o end
            local spot = worldFor().proc(data.apartments[S.apt] or {}, {key = 'settle:' .. tostring(entry.serial)}, used)
            if spot then
                local yaw = v and yawToward(spot, v) or 0
                best = {id = 'proc:' .. tostring(entry.serial), kind = 'stand', x = spot.x, y = spot.y, z = spot.z, yaw = yaw, procedural = true}
            end
        end
        if not best then return nil end
        claimed[entry.serial] = best
        log('settle-claim', {serial = entry.serial, id = best.id, kind = best.kind})
        return best
    end

    local function freed(place, isBad, reason, serial)
        claimed[serial] = nil
        if isBad and place and place.id and not place.procedural then
            bad[place.id] = true
            prepared[place.id] = false
        end
        log('settle-freed', {serial = serial, id = place and place.id, bad = isBad == true, reason = reason})
    end

    -- ---- the flat ----------------------------------------------------------------------------------------------------------------------------
    local function reset()
        acc, age, sinceCheck, still = 0, 0, 0, nil
        prepared, bad, claimed, prepDone, members, unplaced = {}, {}, {}, false, 0, 0
        homeId = nil
    end

    -- V is in this flat now.
    function S.enter(apt)
        if S.apt == apt then return end
        if S.apt then S.leave('moved') end
        if not data.apartments[apt] then return end
        S.apt, S.state = apt, 'watch'
        reset()
        buildQueue()
        log('settle-enter', {apt = apt, spots = #queue})
    end

    function S.leave(reason)
        local seat = seating()
        if homeId and seat then pcall(seat.clearHome, reason, false) end
        log('settle-leave', {apt = S.apt, reason = reason})
        S.apt, S.state = nil, 'idle'
        reset()
        queue = {}
    end

    local function stop(reason, instant)
        local seat = seating()
        if homeId and seat then pcall(seat.clearHome, reason, instant == true) end
        homeId, claimed = nil, {}
        S.state = 'watch'
        -- Settle again only after V has been quiet for a while.
        age = math.min(age, M.STAY - M.AGAIN)
        still = nil
        log('settle-stop', {apt = S.apt, reason = reason})
    end

    local function start()
        local seat = seating()
        if not seat then return end
        claimed = {}
        homeId = seat.setHome({claim = claim, freed = freed})
        S.state = 'settled'
        log('settle-start', {apt = S.apt, id = homeId, members = members, ready = (function() local n = 0 for _, p in pairs(prepared) do if p then n = n + 1 end end return n end)()})
    end

    -- V sat on a seat of this flat: never give that root away.
    function S.learnV(anchor)
        if not S.apt or not anchor then return end
        for _, l in ipairs(learned) do if flat(l, anchor) < 0.3 then return end end
        learned[#learned + 1] = {x = anchor.x, y = anchor.y, z = anchor.z}
        buildQueue()
    end

    -- Every companions tick (the body animation tick); a step of its own every M.STEP seconds.
    function S.tick(player, dt, rows)
        if S.state == 'idle' then return end
        acc = acc + (tonumber(dt) or 0)
        if acc < M.STEP then return end
        local elapsed = acc
        acc = 0
        age, sinceCheck = age + elapsed, sinceCheck + elapsed
        members = #(rows or {})
        if members == 0 then
            -- Nobody to settle (or nobody left): no read of V at all.
            if S.state == 'settled' then stop('no companions', false) end
            return
        end
        local v = d.vpos and d.vpos() or nil
        if not v then return end
        unplaced = members
        if S.state == 'settled' then
            local seat = seating()
            unplaced = 0
            for _, row in ipairs(rows) do
                if row.entry and not (seat and seat.placed(row.entry.serial)) then unplaced = unplaced + 1 end
            end
        end
        if sinceCheck >= M.RECHECK then
            sinceCheck = 0
            local here = S.apt
            if d.district then here = d.district() end
            if here ~= S.apt then S.leave('left the flat'); return end
        end
        local reason = d.held and d.held() or nil
        if S.state == 'watch' then
            if reason then age = math.min(age, M.STAY - M.AGAIN); still = nil; return end
            if not still or flat(v, still.at) > M.QUIET_RADIUS then still = {at = {x = v.x, y = v.y}, quiet = 0}
            else still.quiet = still.quiet + elapsed end
            local seat = seating()
            local sitting = seat and seat.sitting()
            -- Real seats are looked for once V has been in the flat a few seconds (not while passing through), or at once when V sits.
            if sitting or age >= M.PREP_AFTER then prepareSome() end
            if (sitting and age >= M.SIT_AFTER) or (age >= M.STAY and still.quiet >= M.QUIET) then start() end
            return
        end
        -- settled
        if reason then stop(reason, reason == 'combat'); return end
        local seat = seating()
        local nearest
        for _, row in ipairs(rows or {}) do
            local entry = row.entry
            if entry and entry.position and seat and seat.placed(entry.serial) then
                local gap = flat(entry.position, v)
                if not nearest or gap < nearest then nearest = gap end
                if math.abs((entry.position.z or 0) - (v.z or 0)) > M.FLOOR and gap > 2 then nearest = math.huge end
            end
        end
        if nearest and nearest > M.FAR then stop('far', false); return end
        prepareSome()
    end

    -- ---- "come with me" -----------------------------------------------------------------------------------------------------------------
    -- The follow offer of a conversation with a settled companion (the same offer the conversation actions know), and its execution.
    function S.followOffer(entity, context)
        if S.state ~= 'settled' or not d.member or type(entity) ~= 'string' or type(context) ~= 'table' then return nil end
        local member = d.member(entity)
        local seat = seating()
        if not member or not seat or not seat.placed(member.serial) then return nil end
        local label = type(context.name) == 'string' and context.name ~= '' and context.name or member.name or context.profileKey
        return {available = true, actor = {id = entity, key = context.profileKey}, name = label}
    end
    function S.follow(entity)
        local member = d.member and d.member(entity)
        local seat = seating()
        if S.state ~= 'settled' or not member or not seat then return false end
        log('settle-follow', {serial = member.serial})
        return seat.homeRelease(member.serial, 'follow', false) == true
    end

    -- The spots the settled companions hold in a flat, for the housemates to leave alone.
    function S.taken(apt)
        if apt ~= S.apt or S.state ~= 'settled' then return nil end
        local list = {}
        for _, h in ipairs(held()) do list[#list + 1] = {id = h.id, x = h.x, y = h.y, z = h.z} end
        return list
    end

    function S.snapshot()
        local ready, tried = 0, 0
        for _, place in pairs(prepared) do tried = tried + 1; if place then ready = ready + 1 end end
        return {state = S.state, apt = S.apt, age = age, spots = #queue, ready = ready, tried = tried, done = prepDone, members = members}
    end

    return S
end

return M
