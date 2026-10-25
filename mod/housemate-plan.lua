-- What each housemate does and where (docs/HOUSEMATES.md, "Assignment across many housemates", "Routine state machine", "Sleeping").
--
-- Pure: no game calls, every random number and every clock comes in as an argument, so the tests can run any evening. The controller
-- (mod/housemates.lua) asks this module for decisions and carries them out.
local registry = dofile('housemate-registry.lua')
local M = {}

M.SIT_KINDS = {couch = true, chair = true, bar = true, stool = true}
-- Seats a tired housemate can doze in when there is no bed that fits two (the vanilla sleeping-in-a-chair workspot is for a chair).
M.DOZE_KINDS = {chair = true}
M.SPACING = 0.9          -- metres between two housemates' places (seats of one piece of furniture are closer, by design)
M.NEAR_V = 1.0           -- a place this close to V is not given away
M.STAND_EXTRA = 0.25     -- chance that one of several housemates stands although a seat is free
-- Weights of what a housemate wants to do in the daytime. Kinds the flat does not have are left out and the rest renormalised.
M.WEIGHTS = {sit = 0.62, window = 0.12, lean = 0.10, stand = 0.12}
M.DWELL = {sit = {360, 1080}, window = {120, 300}, lean = {120, 300}, stand = {150, 360}, sleep = {1e9, 1e9}}
M.NIGHT_FROM, M.NIGHT_TO = 22, 6

local function dist(a, b) return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2 + ((a.z or 0) - (b.z or 0)) ^ 2) end
local function flat(a, b) return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2) end

-- 'night' from 22:00 to 05:59 game time.
function M.period(hour)
    hour = (tonumber(hour) or 12) % 24
    return (hour >= M.NIGHT_FROM or hour < M.NIGHT_TO) and 'night' or 'day'
end

-- Bedtime in [23.0, 24.5) and wake time in [6.5, 8.5), hours, from the profile key only: the same person keeps the same habits and they do not
-- all fall asleep in the same minute.
function M.bedtime(key) return 23 + (registry.hash(key .. ':bed') % 150) / 100 end
function M.waketime(key) return 6.5 + (registry.hash(key .. ':wake') % 200) / 100 end

-- Should she be asleep at this game hour?
function M.sleepy(key, hours)
    local h = (tonumber(hours) or 12) % 24
    local t = h < 12 and h + 24 or h
    return t >= M.bedtime(key) and t < M.waketime(key) + 24
end

function M.dwell(kind, random)
    local range = M.DWELL[kind] or M.DWELL.stand
    local r = tonumber(random and random()) or 0.5
    return range[1] + (range[2] - range[1]) * r
end

-- The lateral and lying places of a bed that fits two. A bed spot has `anchor` (V's lying root), `across` (the heading of the line across
-- the bed, game yaw) and `sides` (offsets along it); each side is one slot beside V. `yaw` (the lying direction) defaults to across - 90.
function M.bedSlots(bed)
    local slots = {}
    if bed.kind ~= 'bed' or bed.usable == false or bed.fitsTwo ~= true or not bed.anchor then return slots end
    local across = math.rad(bed.across or 0)
    local lx, ly = -math.sin(across), math.cos(across)
    local yaw = bed.yaw or ((bed.across or 0) - 90)
    for index, offset in ipairs(bed.sides or {}) do
        slots[#slots + 1] = {id = bed.id .. ':' .. index, kind = 'bed', bed = bed.id, x = bed.anchor.x + lx * offset,
            y = bed.anchor.y + ly * offset, z = bed.anchor.z, yaw = yaw, conf = bed.conf, group = bed.id,
            side = offset < 0 and -1 or 1, lateral = {x = lx, y = ly}}
    end
    return slots
end

-- The spots a flat offers now. ctx: rejected = {spotId = true} (failed verification this session), knownV = true when V's own seats in
-- this flat are known, learned = {{x, y, z}} the seat roots V sat on, vslots = {{x, y, z}} recorded roots.
function M.usable(apartment, ctx)
    ctx = ctx or {}
    local out = {}
    local roots = {}
    for _, root in ipairs(ctx.learned or {}) do roots[#roots + 1] = root end
    for _, root in ipairs(ctx.vslots or {}) do roots[#roots + 1] = root end
    for _, spot in ipairs(apartment.spots or {}) do
        local ok = spot.usable ~= false and not spot.vslot and not (ctx.rejected and ctx.rejected[spot.id])
        if ok and spot.maybeV and not ctx.knownV then ok = false end
        if ok and spot.kind ~= 'bed' then
            for _, root in ipairs(roots) do
                if flat(spot, root) < 0.45 and math.abs((spot.z or 0) - (root.z or 0)) < 0.8 then ok = false; break end
            end
        end
        if ok then
            if spot.kind == 'bed' then
                for _, slot in ipairs(M.bedSlots(spot)) do out[#out + 1] = slot end
            else
                out[#out + 1] = spot
            end
        end
    end
    return out
end

local function weightedKind(weights, available, random)
    local total = 0
    for kind, weight in pairs(weights) do if available[kind] then total = total + weight end end
    if total <= 0 then return nil end
    local r = (tonumber(random and random()) or 0.5) * total
    -- A fixed order, so the same random number always gives the same kind.
    for _, kind in ipairs({'sit', 'window', 'lean', 'stand'}) do
        local weight = weights[kind]
        if weight and available[kind] then
            if r < weight then return kind end
            r = r - weight
        end
    end
    return nil
end

local function kindClass(kind)
    if M.SIT_KINDS[kind] then return 'sit' end
    if kind == 'window' or kind == 'lean' or kind == 'stand' then return kind end
    return nil
end

local function free(spot, taken, others, v)
    if taken[spot.id] then return false end
    if v and dist(spot, v) < M.NEAR_V then return false end
    for _, other in ipairs(others) do
        local limit = (spot.group and other.group == spot.group) and 0.5 or M.SPACING
        if flat(spot, other) < limit and math.abs((spot.z or 0) - (other.z or 0)) < 1.2 then return false end
    end
    return true
end

-- Places for the residents in `req.residents` ({key, canBed, canDoze}); everyone else already stands where `req.fixed` ({key = spot}) says.
--   req.spots     the usable spots (M.usable)
--   req.sleepers  {key = true} for the ones who should be asleep now
--   req.random    a function giving [0, 1)
--   req.v         V's position (a place close to V is not given away)
--   req.day       a number that changes with the game day (seats are re-dealt each day, not each visit)
-- Returns {key = {spot = <table or nil>, kind = 'couch'|...|'stand', sleep = bool}}. spot == nil: stand on a procedural place.
function M.assign(req)
    local random = req.random or function() return 0.5 end
    local taken, others = {}, {}
    for _, spot in pairs(req.fixed or {}) do
        if spot.id then taken[spot.id] = true end
        others[#others + 1] = spot
    end
    local order = {}
    for _, resident in ipairs(req.residents) do order[#order + 1] = resident end
    table.sort(order, function(a, b)
        local ha, hb = registry.hash(a.key .. ':' .. tostring(req.day or 0)), registry.hash(b.key .. ':' .. tostring(req.day or 0))
        if ha == hb then return a.key < b.key end
        return ha < hb
    end)
    local result = {}
    local function give(resident, spot, extra)
        result[resident.key] = {spot = spot, kind = spot and spot.kind or 'stand', sleep = extra and extra.sleep or false}
        if spot then
            taken[spot.id] = true
            others[#others + 1] = spot
        end
    end
    -- 1. Sleepers: a bed slot beside V's, else a seat to doze in.
    local waiting = {}
    for _, resident in ipairs(order) do
        if req.sleepers and req.sleepers[resident.key] then
            local chosen
            if resident.canBed ~= false then
                for _, spot in ipairs(req.spots) do
                    if spot.kind == 'bed' and free(spot, taken, others, nil) then chosen = spot; break end
                end
            end
            if not chosen and resident.canDoze ~= false then
                for _, spot in ipairs(req.spots) do
                    if M.DOZE_KINDS[spot.kind] and free(spot, taken, others, req.v) then chosen = spot; break end
                end
            end
            if chosen then give(resident, chosen, {sleep = true}) else waiting[#waiting + 1] = resident end
        else
            waiting[#waiting + 1] = resident
        end
    end
    -- 2. How many sit: as many as there are seats, and now and then one stands although a seat is free.
    local seats = {}
    for _, spot in ipairs(req.spots) do
        if M.SIT_KINDS[spot.kind] and free(spot, taken, others, req.v) then seats[#seats + 1] = spot end
    end
    local sitters = math.min(#waiting, #seats)
    if #waiting >= 3 and sitters == #waiting and random() < M.STAND_EXTRA then sitters = sitters - 1 end
    local standKinds = {}
    for _, spot in ipairs(req.spots) do
        local class = kindClass(spot.kind)
        if class and class ~= 'sit' then standKinds[class] = true end
    end
    for index, resident in ipairs(waiting) do
        if index <= sitters then
            -- The sitter takes the first seat that is still free, starting at a place that depends on her (the same person tends to the same corner).
            local count = #seats
            local start = registry.hash(resident.key .. ':seat') % math.max(count, 1)
            local chosen
            for step = 0, count - 1 do
                local candidate = seats[((start + step) % count) + 1]
                if free(candidate, taken, others, req.v) then chosen = candidate; break end
            end
            if chosen then give(resident, chosen) else give(resident, nil) end
        else
            local class = weightedKind(M.WEIGHTS, {window = standKinds.window, lean = standKinds.lean, stand = true}, random)
            local chosen
            if class and class ~= 'stand' then
                for _, spot in ipairs(req.spots) do
                    if kindClass(spot.kind) == class and free(spot, taken, others, req.v) then chosen = spot; break end
                end
            end
            if not chosen then
                for _, spot in ipairs(req.spots) do
                    if spot.kind == 'stand' and free(spot, taken, others, req.v) then chosen = spot; break end
                end
            end
            give(resident, chosen)
        end
    end
    return result
end

-- A new place for one resident who has been in hers long enough (the others stay where they are). Never the same spot; her wish is drawn from
-- the day weights among what the flat still offers (so she does not always take the seat). nil spot means "stand on a procedural place".
-- req = {resident, spots, fixed, current, sleep, random, v, day}
function M.next(req)
    local random = req.random or function() return 0.5 end
    local fixed = {}
    for key, spot in pairs(req.fixed or {}) do if key ~= req.resident.key then fixed[key] = spot end end
    local spots = {}
    for _, spot in ipairs(req.spots) do
        if not (req.current and spot.id == req.current.id) then spots[#spots + 1] = spot end
    end
    if req.sleep then
        local single = M.assign({residents = {req.resident}, spots = spots, fixed = fixed, random = random, v = req.v, day = req.day,
            sleepers = {[req.resident.key] = true}})
        return single[req.resident.key]
    end
    local taken, others = {}, {}
    for _, spot in pairs(fixed) do taken[spot.id or ''] = true; others[#others + 1] = spot end
    local byClass, available = {}, {stand = true}
    for _, spot in ipairs(spots) do
        local class = kindClass(spot.kind)
        if class and free(spot, taken, others, req.v) then
            byClass[class] = byClass[class] or {}
            byClass[class][#byClass[class] + 1] = spot
            available[class] = true
        end
    end
    local class = weightedKind(M.WEIGHTS, available, random)
    local list = class and byClass[class]
    if not list then
        return {spot = nil, kind = 'stand', sleep = false}
    end
    local r = tonumber(random()) or 0.5
    local spot = list[math.min(#list, math.floor(r * #list) + 1)]
    return {spot = spot, kind = spot.kind, sleep = false}
end

return M
