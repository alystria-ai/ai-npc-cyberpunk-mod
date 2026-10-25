-- Companions change outfits (Settings > Companion behavior > Companions change outfits, on by default; docs/COMPANION_OUTFITS.md).
--
-- A party copy of a curated character (mod/companion-outfits-data.lua) changes into another look of its own entity template: by the game's time of day
-- (a day look, a night look), now and then for variety, and into casual clothes while V is at home. Only our own spawned copies are touched; a character the
-- game placed is never given a new look. A change happens only while nobody is looking: when the game's own frustum test says the copy is outside V's view
-- (IsInCameraFrustum with the margins the game itself uses for "could be seen"), and never during a fight, a scene, a call, a ride, on a seat or while a command runs.
--
-- Cost. Nothing runs per frame. The 10 Hz tick of init.lua calls M.tick, which subtracts the elapsed time from one counter and returns; every CHECK_S
-- seconds it reads the party (a list of the curated copies, usually none or two), the game clock (one native read) and, when someone wants to change, the
-- world and the copy's view. A change itself is two native calls on one copy (prefetch the appearance, then schedule it a second later, still unseen) and a
-- read-back a few seconds after. Off, the tick is not called into this module at all and nothing is loaded (init.lua convaiOutfitTick).
-- No handle of a game object is kept between checks: a member remembers a serial, a name and numbers.
local M = {}

-- deps (set by init.lua; every call is guarded here):
--   enabled()              the setting
--   rows()                 the curated copies that are ready: {serial, key, record, npc}; the module keeps no npc beyond the call
--   current(row)           the appearance name the copy wears now, or nil
--   prefetch(row, name)    ask the game to load the appearance (no visible change)
--   apply(row, name)       schedule the change and remember it for a recreated copy
--   remember(row, name)    forget a change that did not take (the name a recreated copy should use)
--   gameHours()            the game clock as absolute hours (days * 24 + hour + minutes / 60), or nil
--   place()                the game's district record name where V is (the specific one, e.g. 'LittleChina_VApartment'), or nil
--   world()                nil when ordinary gameplay is open, else a reason (combat, scene, call, vehicle, menu)
--   busy(row)              nil when the copy is walking or standing with V, else a reason (a fight, a seat, a car, a lift, a command)
--   frustum(npc)           the game's own test: true when the copy may be seen by the camera, false when not, nil when it cannot say
--   angle(npc, player)     degrees between the camera's direction and the copy, or nil
--   random()               a number in [0, 1) (optional: the module's own generator is used without it)
--   log(line)
M.deps = nil
M.data = nil

local CHECK_S = 20          -- real seconds between looks at the party
local STAGE_S = 1.0         -- real seconds between the prefetch and the change, and between read-backs
local GIVE_UP_S = 20.0      -- a change that never shows is given up, and that look is not tried again this session
local MIN_DWELL_H = 4       -- game hours between two changes made for variety
local VARIETY_CHANCE = 0.3  -- per hour change, once the dwell has passed
local NIGHT_FROM, NIGHT_TO = 19, 6
local OUT_OF_VIEW_DEG = 75  -- the fallback when the frustum test is unavailable: a copy this far off the camera's direction is not on screen

-- The district records the game reports for V's apartments (the same five bridge/place-names.mjs HOME_PLACES lists; checked in final.redscripts 2026-10-14).
M.HOME_PLACES = {LittleChina_VApartment = true, Northside_Apartment = true, JapanTown_Apartment = true, Glen_Apartment = true, CorpoPlaza_Apartment = true}

local state = {members = {}, home = {}, wait = 0, lastHour = nil}

-- The module's own small generator (a Lehmer sequence): the game's shared math.random is never seeded or consumed here. Seeded from the clocks when the module loads.
local seed = (os.time() + math.floor(os.clock() * 1000)) % 2147483646 + 1
function M.random()
    seed = (seed * 48271) % 2147483647
    return seed / 2147483647
end

local function say(line)
    local deps = M.deps
    if deps and deps.log then pcall(deps.log, line) end
end

local function wanted()
    local deps = M.deps
    if not deps or type(deps.enabled) ~= 'function' then return false end
    local ok, on = pcall(deps.enabled)
    return ok and on == true
end

local function data()
    if M.data == nil then
        local ok, loaded = pcall(dofile, 'companion-outfits-data.lua')
        M.data = ok and type(loaded) == 'table' and loaded or false
        if not M.data then say('Companion outfits: the outfit list could not be loaded') end
    end
    return M.data or nil
end

-- The curated entry of a model record, or nil.
function M.character(record)
    local all = data()
    return all and all.characters and type(record) == 'string' and all.characters[record] or nil
end

function M.known(record) return M.character(record) ~= nil end

local function kindOf(character, name)
    for _, row in ipairs(character.outfits) do
        if row[1] == name then return row[2] end
    end
    return nil
end
M.kindOf = function(record, name)
    local character = M.character(record)
    return character and kindOf(character, name) or nil
end

local function hasHome(character)
    for _, row in ipairs(character.outfits) do
        if row[2] == 'home' then return true end
    end
    return false
end
function M.hasHomeOutfit(record)
    local character = M.character(record)
    return character ~= nil and hasHome(character)
end

-- 'night' from 19:00 to 05:59 game time, 'day' otherwise.
function M.period(hour)
    hour = tonumber(hour) or 12
    return (hour >= NIGHT_FROM or hour < NIGHT_TO) and 'night' or 'day'
end

-- May this kind of outfit be worn now? At home only the home outfits (a character without one keeps its ordinary rotation), away from home never a home outfit.
local function allowed(kind, period, home)
    if home then return kind == 'home' end
    if kind == 'home' then return false end
    return kind == 'any' or kind == period
end

local function pick(list, random)
    if #list == 0 then return nil end
    local r = tonumber(random and random()) or 0
    local index = math.floor(r * #list) + 1
    if index > #list then index = #list end
    if index < 1 then index = 1 end
    return list[index]
end

-- The decision, a pure function. ctx = {period, home, hours, changedAt, hourChanged, bad = {name = true}, random}.
-- Returns the name to change into and why ('required': the look worn is not allowed now; 'variety'), or nil.
function M.choose(character, current, ctx)
    if type(character) ~= 'table' or type(current) ~= 'string' then return nil end
    -- A look the list does not hold (a world character's copy in the clothes the original wore, a look another mod set) is left alone.
    if kindOf(character, current) == nil then return nil end
    local home = ctx.home == true and hasHome(character)
    local candidates = {}
    for _, row in ipairs(character.outfits) do
        if allowed(row[2], ctx.period, home) and not (ctx.bad and ctx.bad[row[1]]) then candidates[#candidates + 1] = row[1] end
    end
    if #candidates == 0 then return nil end
    local others = {}
    local worn = false
    for _, name in ipairs(candidates) do
        if name == current then worn = true else others[#others + 1] = name end
    end
    if not worn then return pick(others, ctx.random), 'required' end
    if #others == 0 or not ctx.hourChanged then return nil end
    if ctx.changedAt and ctx.hours and ctx.hours - ctx.changedAt < MIN_DWELL_H then return nil end
    local roll = tonumber(ctx.random and ctx.random()) or 1
    if roll >= VARIETY_CHANCE then return nil end
    return pick(others, ctx.random), 'variety'
end

-- ---------------------------------------------------------------------------------------------------------------------
-- Home: V's apartment, found by the game's district or set by name by another feature (docs/COMPANION_OUTFITS.md "Home outfit API").

-- key: a profile key ('judy-alvarez') or a model record ('Character.Judy'). on: true wears home clothes, false never, nil follows V's whereabouts.
function M.setHome(key, on)
    if type(key) ~= 'string' or key == '' then return false end
    if on ~= nil and type(on) ~= 'boolean' then return false end
    state.home[key] = on
    -- A decision is owed at the next look, not at the next hour change.
    state.wait = math.min(state.wait, STAGE_S)
    return true
end

-- true when V stands in one of V's apartments, false when elsewhere, nil when the game cannot say.
function M.vAtHome()
    local deps = M.deps
    if not deps or type(deps.place) ~= 'function' then return nil end
    local ok, place = pcall(deps.place)
    if not ok or type(place) ~= 'string' then return nil end
    return M.HOME_PLACES[place] == true
end

function M.isHome(key, record)
    local explicit = state.home[key]
    if explicit == nil and record ~= nil then explicit = state.home[record] end
    return explicit
end

-- ---------------------------------------------------------------------------------------------------------------------
-- Members: what the module knows about one copy (by serial).

local function member(row, current)
    local m = state.members[row.serial]
    if not m then
        m = {serial = row.serial, bad = {}}
        state.members[row.serial] = m
    end
    m.key, m.record = row.key, row.record
    if current then m.current = current end
    return m
end

-- 'home' when the copy wears its home clothes, 'changed' when it wears another look than its own base look, nil otherwise.
-- Read when a conversation turn is built (companions.activityInputs), never per frame; a copy this module never saw is nil.
function M.status(serial)
    local m = state.members[serial]
    if not m or not m.current then return nil end
    local character = M.character(m.record)
    if not character then return nil end
    if m.current == character.base then return nil end
    local kind = kindOf(character, m.current)
    if kind == nil then return nil end
    return kind == 'home' and 'home' or 'changed'
end

-- ---------------------------------------------------------------------------------------------------------------------
-- Not while V looks.

-- true: the copy may be on screen (or nobody can tell); false: it is out of view.
function M.inView(row, player)
    local deps = M.deps
    local ok, seen = pcall(deps.frustum, row.npc)
    if ok and type(seen) == 'boolean' then return seen end
    if not state.frustumLogged then
        state.frustumLogged = true
        say('Companion outfits: the frustum test of the game gave ' .. (ok and tostring(seen) or ('an error (' .. tostring(seen):sub(1, 100) .. ')')) .. ', the camera angle decides')
    end
    if deps.angle then
        local okAngle, angle = pcall(deps.angle, row.npc, player)
        if okAngle and type(angle) == 'number' then return angle < OUT_OF_VIEW_DEG end
    end
    return true
end

local function currentName(row)
    local ok, name = pcall(M.deps.current, row)
    return ok and type(name) == 'string' and name ~= '' and name or nil
end

local function describe(m) return tostring(m.key or m.record or m.serial) end

-- One copy, one look: read back a started change, schedule a prefetched one, or begin one that is due.
local function step(row, player, ctx)
    local deps = M.deps
    local character = M.character(row.record)
    if not character then return end
    local now = ctx.now
    local live = currentName(row)
    local m = member(row, nil)

    if m.pending then
        local p = m.pending
        if live == p.name then
            m.current, m.changedAt, m.pending = p.name, ctx.hours, nil
            say('Companion outfits: ' .. describe(m) .. ' now wears ' .. p.name .. ' (' .. p.why .. ')')
        elseif now - p.at >= GIVE_UP_S then
            m.bad[p.name], m.pending = true, nil
            pcall(deps.remember, row, p.from)
            say('Companion outfits: ' .. describe(m) .. ' did not change into ' .. p.name .. ' (still ' .. tostring(live) .. '); that look is not tried again')
        end
        return
    end

    -- What the copy wears is whatever the game says.
    if live then m.current = live end
    if not m.current then return end

    if m.stage then
        -- The look has been loading for at least STAGE_S: schedule it if it is still unseen and still safe, otherwise start over at the next look.
        local stage = m.stage
        if now - stage.at < STAGE_S then return end
        m.stage = nil
        if ctx.world() or (deps.busy and deps.busy(row)) or M.inView(row, player) then return end
        local ok, err = pcall(deps.apply, row, stage.name)
        if not ok then
            m.bad[stage.name] = true
            say('Companion outfits: ' .. describe(m) .. ' could not be changed into ' .. stage.name .. ' (' .. tostring(err):sub(1, 120) .. ')')
            return
        end
        m.pending = {name = stage.name, why = stage.why, at = now, from = m.current}
        return
    end

    local home = M.isHome(m.key, m.record)
    if home == nil then home = ctx.atHome == true end
    local target, why = M.choose(character, m.current, {
        period = ctx.period, home = home, hours = ctx.hours, changedAt = m.changedAt,
        hourChanged = ctx.hourChanged, bad = m.bad, random = deps.random or M.random})
    if not target then m.waiting = nil; return end
    local blocked = ctx.world()
    if blocked then
        if m.waiting ~= target then m.waiting = target; say('Companion outfits: ' .. describe(m) .. ' wants ' .. target .. ' (' .. why .. '), waiting for open gameplay (' .. tostring(blocked) .. ')') end
        return
    end
    if deps.busy and deps.busy(row) then return end
    if M.inView(row, player) then
        if m.waiting ~= target then m.waiting = target; say('Companion outfits: ' .. describe(m) .. ' wants ' .. target .. ' (' .. why .. '), waiting until nobody is looking') end
        return
    end
    m.waiting = nil
    local ok, err = pcall(deps.prefetch, row, target)
    if not ok then
        m.bad[target] = true
        say('Companion outfits: ' .. describe(m) .. ' could not prepare ' .. target .. ' (' .. tostring(err):sub(1, 120) .. ')')
        return
    end
    m.stage = {name = target, why = why, at = now}
end

-- Called on the game's 10 Hz tick. elapsed: seconds since the previous call. ready: ordinary gameplay (a world, V attached).
function M.tick(player, elapsed, ready)
    if ready ~= true or not wanted() then return end
    state.wait = state.wait - (tonumber(elapsed) or 0)
    if state.wait > 0 then return end
    local deps = M.deps
    state.wait = CHECK_S

    local okRows, rows = pcall(deps.rows)
    if not okRows or type(rows) ~= 'table' or #rows == 0 then return end
    local okHours, hours = pcall(deps.gameHours)
    if not okHours or type(hours) ~= 'number' then return end
    local hour = math.floor(hours) % 24
    local ctx = {hours = hours, hour = hour, period = M.period(hour), hourChanged = state.lastHour ~= nil and state.lastHour ~= hour,
        now = (M.clock or os.clock)()}
    state.lastHour = hour
    -- V's whereabouts only matter when a copy has a home look.
    for _, row in ipairs(rows) do
        if M.hasHomeOutfit(row.record) then ctx.atHome = M.vAtHome(); break end
    end
    -- The world is asked once, and only when a copy wants to change (or has a change to finish).
    local asked, reason
    function ctx.world()
        if not asked then
            asked = true
            local okWorld, blocked = pcall(deps.world)
            reason = (not okWorld) and 'unreadable' or blocked
        end
        return reason
    end
    local follow = false
    for _, row in ipairs(rows) do
        local ok, err = pcall(step, row, player, ctx)
        if not ok then say('Companion outfits: ' .. tostring(err):sub(1, 160)) end
        local m = state.members[row.serial]
        if m and (m.stage or m.pending) then follow = true end
    end
    -- A started change is followed up quickly; a copy that only waits for the camera to look away is looked at again in CHECK_S.
    if follow then state.wait = STAGE_S end
end

-- A new copy, at creation (key: its profile key, for a home setting made by name): the appearance to create it with, or nil to leave it as the game and companion-records.lua make it. The copy appears in
-- front of V, so nothing is changed in view: it simply comes in the right clothes (casual at home, the night look at night).
function M.spawnAppearance(record, key)
    if not wanted() then return nil end
    local character = M.character(record)
    if not character then return nil end
    local deps = M.deps
    local okHours, hours = pcall(deps.gameHours)
    if not okHours or type(hours) ~= 'number' then return character.explicit and character.base or nil end
    local home = M.isHome(key, record)
    if home == nil then home = M.hasHomeOutfit(record) and M.vAtHome() == true end
    local target = M.choose(character, character.base, {
        period = M.period(math.floor(hours) % 24), home = home, hours = hours, hourChanged = false, bad = {}, random = deps.random or M.random})
    if target and target ~= character.base then return target end
    if character.explicit then return character.base end
    return nil
end

-- A copy created with this appearance wears it from the start: the member begins with it (no change to make, no change to flag).
function M.created(serial, key, record, name)
    if not serial then return end
    local m = state.members[serial] or {serial = serial, bad = {}}
    state.members[serial] = m
    -- A copy made without a named look wears its base look (the next check reads the live name either way).
    m.key, m.record, m.current = key, record, name
end

function M.forget(serial) state.members[serial] = nil end

-- A new session (a load, a death, the main menu): nothing carries over. Fast travel keeps the members (init.lua abandonSession).
function M.reset()
    state.members, state.home, state.wait, state.lastHour, state.frustumLogged = {}, {}, 0, nil, nil
end

-- For the tests and the support report: what the module holds.
function M.snapshot()
    local out = {}
    for serial, m in pairs(state.members) do
        out[#out + 1] = {serial = serial, key = m.key, record = m.record, current = m.current, waiting = m.waiting,
            staged = m.stage and m.stage.name or nil, pending = m.pending and m.pending.name or nil}
    end
    table.sort(out, function(a, b) return tostring(a.serial) < tostring(b.serial) end)
    return out
end

return M
