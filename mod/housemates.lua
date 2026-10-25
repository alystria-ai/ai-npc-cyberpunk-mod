-- Housemates: characters who live in V's apartments (docs/HOUSEMATES.md).
--
-- The controller. A housemate is a character V told "you can stay at my place". The registry (mod/housemate-registry.lua, a saved quest fact
-- each) says who lives where. Her body exists only while V is in her flat (or has just left it): it is a managed copy in the "visiting" state
-- (mod/companions.lua, the same copy the immersive invitations use), placed on a seat, at a window or a counter, or asleep, moved by AI commands
-- and workspots only. Away from the flat she is two table entries and nothing else; nothing here runs per frame.
--
-- Pure with injected seams (`env`, below), so the whole life of a flat can be played in the tests. The game side is mod/housemate-world.lua.
--
-- env seams (each guarded; the ones marked * are needed):
--   data()                  the flats and their spots (mod/housemate-spots-data.lua), loaded when first asked for
--   place()                 the district record V is in, or nil           hours()  the game clock in hours (days * 24 + hour), or nil
--   ready()                 true when gameplay is open and V is attached      held()  nil, or why the game is busy ('scene', 'combat', 'call')
--   fact(name)              a quest fact                                      vpos()  V's position {x, y, z}
--   eligible(key) *         may this profile live at V's (it can be invited, it is not a game character)
--   profileName(key)        her display name                                  store *  the registry store (get/set of facts)
--   bodies *                {spawn(r, spot) -> ok, err; rows() -> list; delete(serial); hide(serial, hidden)}
--   seats *                 {prepare(spot, r) -> spot | nil, 'bad' | nil, nil, 'wait'; occupy(serial, spot, opts) -> handle;
--                            status(handle) -> 'busy' | 'ready' | 'failed' | 'released'; release(handle, instant)}
--   proc(apartment, r, used) a procedural standing place {x, y, z}, or nil, 'wait'
--   companions *            {join(serial); releaseToHome(serial, apartment); partyMember(key) -> {serial, entityID, name} | nil; leave(serial)}
--   outfits                 {setHome(key, on)}
--   notify(text)  t(text, vars)  log(line)  random()  talking() -> the entity V is talking to, or nil
--   chat                    the pair chat seams (mod/housemate-chat.lua); nil: no chat
--   greet(info)             a housemate greets V who has come home
--   twin(r)                 true when the game's own copy of this character stands near V
--   ours(entity)            true when this entity is one of our own copies (party member, visitor, housemate)
--   reserved(apt)           the places party companions hold in this flat ({id, x, y, z} list, mod/companion-settle.lua): not given to a housemate
local plan = dofile('housemate-plan.lua')
local registry = dofile('housemate-registry.lua')
local chatModule

local M = {}

M.STEP = 1.0              -- seconds between steps while everything is settled
M.STEP_BUSY = 0.25        -- ... while anybody is walking, spawning or changing place
M.STEP_AWAY = 5           -- ... while nobody has a body and V is not in a flat (only the district is looked at; a district event wakes it at once)
M.LEAVE_GRACE = 20        -- seconds after V leaves the flat before the bodies are deleted
M.HELD_DELETE = 60        -- seconds of a scene before the bodies are deleted (until then they are only hidden)
M.CLEAR_FOR = 3           -- seconds a scene must be over before they are shown again
M.COMBAT_RETURN = 60      -- seconds after a fight before anybody comes back
M.SPAWN_TIMEOUT = 45
M.SPAWN_MISSES = 2        -- spawn timeouts at the same spot before it is given up for the session
M.OCCUPY_TIMEOUT = 40
M.JOIN_WAIT = 3
M.REST_ASK_TTL = 600      -- seconds a "stay here or go home?" question stays open
M.WELCOME_AWAY = 6        -- game hours away before a housemate greets V
M.WELCOME_NEAR = 10       -- metres: V this close to one of them
M.WELCOME_GAP = 1800      -- seconds between two greetings
M.MEMBERS = 12            -- most housemates named in one offer
M.EARSHOT = 25            -- metres: who can be called to the party by one message
M.MIN_MOVE = 180          -- seconds between two changes of place by one housemate
M.WAKE_STAY = 600         -- seconds a woken housemate stays up

M.DISTRICTS = {LittleChina_VApartment = 'h10', CorpoPlaza_Apartment = 'corpo', Glen_Apartment = 'glen',
    JapanTown_Apartment = 'japan', Northside_Apartment = 'north'}
M.NAMES = {h10 = 'Megabuilding H10', corpo = 'Corpo Plaza', glen = 'Heywood Glen', japan = 'Westbrook Japantown', north = 'Watson Northside'}
M.FACTS = {corpo = 'dlc6_apart_cct_dtn_purchased', glen = 'dlc6_apart_hey_gle_purchased', japan = 'dlc6_apart_wbr_jpn_purchased',
    north = 'dlc6_apart_wat_nid_purchased'}
M.ORDER = {'h10', 'corpo', 'glen', 'japan', 'north'}
-- Body types that have no vanilla double-bed sleeping animation (checked in the archive: woman_base, man_base and man_fat only).
M.NO_BED_RIG = {manbig = true, womanmassive = true, manmassive = true, child = true}

local function flat(a, b) return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2) end
local function copyPoint(p) return p and {x = p.x, y = p.y, z = p.z} or nil end

function M.new(env)
    local C = {}
    local clock = 0
    local acc = 0
    local homes = {}          -- profileKey -> flat id
    local rec = {}            -- profileKey -> resident record
    local data                -- the spots data, while loaded
    local rejected = {}       -- spot id -> true: failed verification this session
    local learned = {}        -- {x, y, z, apt}: seats V sat on (world constants)
    local zone, zoneSince, leftAt
    local heldSince, clearSince, combatUntil
    local restAsk = {}        -- profileKey -> {from, here, at}
    local phoneTokens = {}    -- profileKey -> token of the last phone offer
    local lastHome = {}       -- flat id -> game hours when V last stood in it
    local welcome, lastWelcomeAt
    local rowCache, rowsBySerial = {}, {}
    local chat, noData
    local busy = false
    local counter = 0

    local function log(line) if env.log then pcall(env.log, line) end end
    -- One probe line per event of the pipeline, codes and names only, so that a live run shows where it stopped: offer-shown, action-received,
    -- registered, flat-entered, spot-chosen, body-spawned, placed, held, flat-left and failed:<code>. Each is written when its event happens, never per step.
    local function stage(kind, fields)
        local parts, names = {'Housemates ' .. kind}, {}
        for name in pairs(fields or {}) do names[#names + 1] = name end
        table.sort(names)
        for _, name in ipairs(names) do parts[#parts + 1] = name .. '=' .. tostring(fields[name]) end
        log(table.concat(parts, ' '))
    end
    local offerShown = {}     -- profileKey -> the last offer written to the log (one line per change, not one per turn)
    local factsShown          -- the hold facts last written to the log (hold-facts: one line per change)
    local function translate(text, vars) if env.t then return env.t(text, vars) end if vars then return (text:gsub('{(%w+)}', function(k) return tostring(vars[k]) end)) end return text end
    -- `ui.t('literal')` so that scripts/Extract-UiCatalog.mjs finds every text of this file.
    local ui = {t = translate}
    local function aptName(id)
        if id == 'h10' then return ui.t('Megabuilding H10')
        elseif id == 'corpo' then return ui.t('Corpo Plaza')
        elseif id == 'glen' then return ui.t('Heywood Glen')
        elseif id == 'japan' then return ui.t('Westbrook Japantown')
        elseif id == 'north' then return ui.t('Watson Northside') end
        return tostring(id)
    end
    local function say(text) if env.notify and text and text ~= '' then pcall(env.notify, text) end end
    local function random() return env.random and env.random() or 0.5 end
    local function guard(fn, ...) if type(fn) ~= 'function' then return nil end local ok, a, b, c = pcall(fn, ...) if ok then return a, b, c end return nil end
    local function hours() return guard(env.hours) end
    local function loadData()
        if data == nil and env.data then local ok, value = pcall(env.data); data = ok and type(value) == 'table' and value or false end
        return data or nil
    end

    local function aptOf(place) return place and M.DISTRICTS[place] or nil end
    local function hereId() return aptOf(guard(env.place)) end

    local function newRecord(key, apt)
        local r = {key = key, apt = apt, state = 'virtual', name = guard(env.profileName, key) or key, fails = 0}
        rec[key] = r
        return r
    end

    -- ---- ownership ---------------------------------------------------------------------------------------------------------------------
    function C.owned()
        local out = {}
        for _, id in ipairs(M.ORDER) do
            if id == 'h10' then out[id] = true
            else out[id] = (tonumber(guard(env.fact, M.FACTS[id])) or 0) > 0 end
        end
        return out
    end
    local function ownedList()
        local owned, list = C.owned(), {}
        for _, id in ipairs(M.ORDER) do if owned[id] then list[#list + 1] = {id = id, name = M.NAMES[id]} end end
        return list
    end
    -- The apartments V owns now, in page order: [{id, name}] (the settings page lists them for the move-in default).
    function C.ownedApartments() return ownedList() end

    -- ---- the registry -----------------------------------------------------------------------------------------------------------------
    function C.setHomes(map)
        homes = {}
        for key, apt in pairs(map or {}) do
            homes[key] = apt
            rec[key] = rec[key] or newRecord(key, apt)
            rec[key].apt = apt
        end
        for key in pairs(rec) do if not homes[key] then rec[key] = nil end end
    end
    function C.homes() return homes end
    function C.count() local n = 0 for _ in pairs(homes) do n = n + 1 end return n end
    function C.homeOf(key) return homes[key] end
    function C.apartmentName(id) return M.NAMES[id] end
    function C.hasWork()
        if next(homes) ~= nil then return true end
        return next(rec) ~= nil
    end

    -- ---- bodies ---------------------------------------------------------------------------------------------------------------------------
    local function pollRows()
        rowCache, rowsBySerial = {}, {}
        local rows = guard(env.bodies.rows) or {}
        for _, row in ipairs(rows) do
            if row.owner == 'housemates' then rowCache[#rowCache + 1] = row; rowsBySerial[row.serial] = row end
        end
        return rowCache
    end

    local function dropBody(r, why)
        if r.serial then guard(env.bodies.delete, r.serial) end
        if r.handle and env.seats and env.seats.release then guard(env.seats.release, r.handle, true) end
        r.serial, r.entity, r.handle, r.spot, r.sleep, r.nextSpot = nil, nil, nil, nil, false, nil
        if r.state ~= 'party' then r.state = 'virtual' end
        r.gone = why
    end

    local function anyBodies()
        for _, r in pairs(rec) do if r.serial then return true end end
        return false
    end

    local function ctxFor(apt)
        local a = data and data.apartments[apt]
        local vslots, knownV = {}, false
        for _, l in ipairs(learned) do if l.apt == apt then vslots[#vslots + 1] = l; knownV = true end end
        if a then for _, s in ipairs(a.spots or {}) do if s.vslot then vslots[#vslots + 1] = s; knownV = true end end end
        return {rejected = rejected, knownV = knownV, vslots = vslots}
    end

    local function fixedSpots(apt, except)
        local fixed = {}
        for key, r in pairs(rec) do
            if r.apt == apt and key ~= except and r.spot and (r.serial or r.state == 'planning' or r.state == 'spawning') then fixed[key] = r.spot end
        end
        -- Party companions settled in this flat hold places too (they are never given to a housemate).
        for index, spot in ipairs(guard(env.reserved, apt) or {}) do fixed['party:' .. index] = spot end
        return fixed
    end

    -- The places the housemates hold in a flat (their spot, or the one they are walking to): party companions settling in V's flat leave them alone.
    function C.takenSpots(apt)
        local list = {}
        for _, r in pairs(rec) do
            if (apt == nil or r.apt == apt) and r.spot and r.spot.x and (r.serial or r.state == 'planning' or r.state == 'spawning') then
                list[#list + 1] = {id = r.spot.id, x = r.spot.x, y = r.spot.y, z = r.spot.z}
            end
        end
        return list
    end

    local function usableSpots(apt)
        local d = loadData()
        local a = d and d.apartments[apt]
        if not a then return {} end
        return plan.usable(a, ctxFor(apt))
    end

    local function rigOk(r)
        local rig = r.rig
        if rig == nil and env.rig then rig = guard(env.rig, r); r.rig = rig or false end
        return not M.NO_BED_RIG[tostring(rig or '')]
    end
    local function sleepWanted(r)
        local h = hours()
        return h ~= nil and plan.sleepy(r.key, h) and not (r.wakeUntil and clock < r.wakeUntil)
    end
    local function day() local h = hours() return h and math.floor(h / 24) or 0 end

    -- ---- reserved flats --------------------------------------------------------------------------------------------------------------
    -- The scene facts above 0 for this flat (names). The hold in the step and the offer/move-in both ask this one list: when the flat is
    -- held she is neither offered the flat nor taken out of the party for it, so nobody accepts and then vanishes.
    local function reservedFacts(apt)
        local out = {}
        local d = loadData()
        if not d or not d.reservedFacts then return out end
        for _, list in ipairs({d.reservedFacts.any or {}, d.reservedFacts[apt] or {}}) do
            for _, name in ipairs(list) do
                if (tonumber(guard(env.fact, name)) or 0) > 0 then out[#out + 1] = name end
            end
        end
        return out
    end
    local function reservedReason(apt) return reservedFacts(apt)[1] end

    -- ---- placing --------------------------------------------------------------------------------------------------------------------------
    local function planResidents(apt)
        local pending = {}
        for key, r in pairs(rec) do
            if r.apt == apt and r.state == 'virtual' and not (r.retryAt and clock < r.retryAt) and not r.serial then
                pending[#pending + 1] = {key = key, canBed = rigOk(r), canDoze = true}
            end
        end
        if #pending == 0 then return end
        table.sort(pending, function(a, b) return a.key < b.key end)
        local sleepers = {}
        for _, p in ipairs(pending) do if sleepWanted(rec[p.key]) then sleepers[p.key] = true end end
        local result = plan.assign{residents = pending, spots = usableSpots(apt), sleepers = sleepers, fixed = fixedSpots(apt),
            random = random, v = guard(env.vpos), day = day()}
        for _, p in ipairs(pending) do
            local r, choice = rec[p.key], result[p.key]
            r.spot = choice and choice.spot or nil
            r.sleep = choice and choice.sleep or false
            r.state, r.tries, r.since = 'planning', 0, clock
        end
    end

    local function replanTo(r, choice)
        r.nextSpot = choice and choice.spot or nil
        r.nextSleep = choice and choice.sleep or false
        r.wantProc = (choice == nil) or choice.spot == nil
    end

    -- The next place of one resident who has a body (her dwell is over, it is bedtime, or her spot failed).
    local function chooseNext(r, forceSleep)
        local sleep = forceSleep
        if sleep == nil then sleep = sleepWanted(r) end
        local choice = plan.next{resident = {key = r.key, canBed = rigOk(r), canDoze = true}, spots = usableSpots(r.apt),
            fixed = fixedSpots(r.apt, r.key), current = r.spot, sleep = sleep, random = random, v = guard(env.vpos), day = day()}
        replanTo(r, choice)
        if sleep and not (choice and choice.sleep) then r.nextSleep = false end
        r.state = 'replanning'
        r.tries = 0
    end

    local procUsed = {}
    local function procedural(r)
        local used = {}
        for key, other in pairs(rec) do if key ~= r.key and other.apt == r.apt and other.spot and other.spot.procedural then used[#used + 1] = other.spot end end
        local spot, why = nil, nil
        if env.proc then
            local ok, a, b = pcall(env.proc, r.apt, r, used)
            if ok then spot, why = a, b end
        end
        if spot then spot.procedural, spot.kind, spot.id = true, 'stand', spot.id or ('proc:' .. r.key) end
        return spot, why
    end

    local function dwellFor(r)
        local kind = r.sleep and 'sleep' or (r.spot and (plan.SIT_KINDS[r.spot.kind] and 'sit' or r.spot.kind)) or 'stand'
        r.dwellUntil = clock + plan.dwell(kind, random)
        r.settledAt = clock
    end

    -- ---- one resident's step ----------------------------------------------------------------------------------------------------------
    local function stepResident(r, here)
        local row = r.serial and rowsBySerial[r.serial] or nil
        if r.serial and (not row or row.lost or row.state == 'failed' or row.state == 'missing') then
            if row and row.state == 'failed' then guard(env.bodies.delete, r.serial) end
            stage('failed:body-lost', {key = r.key, state = row and row.state or 'missing'})
            r.serial, r.entity, r.handle, r.spot, r.nextSpot = nil, nil, nil, nil, nil
            if r.state ~= 'party' then r.state = 'virtual' end
            r.retryAt = clock + 10
            return
        end
        local state = r.state
        if state == 'planning' then
            if not r.spot then
                local spot, why = procedural(r)
                if not spot then
                    if why ~= 'wait' then r.tries = r.tries + 1 end
                    if r.tries > 5 then r.state, r.retryAt = 'virtual', clock + 30; stage('failed:no-spot', {key = r.key, apt = r.apt, why = why}) end
                    return
                end
                r.spot = spot
            end
            local snapped, why, wait = env.seats.prepare(r.spot, r)
            if wait then return end
            if not snapped then
                if r.spot.id and not r.spot.procedural then rejected[r.spot.id] = true end
                stage('spot-rejected', {key = r.key, id = r.spot.id, why = why})
                r.tries = r.tries + 1
                if r.tries > 6 then r.state, r.retryAt, r.spot = 'virtual', clock + 30, nil; stage('failed:no-spot', {key = r.key, apt = r.apt}); return end
                local choice = plan.next{resident = {key = r.key, canBed = rigOk(r), canDoze = true}, spots = usableSpots(r.apt),
                    fixed = fixedSpots(r.apt, r.key), sleep = r.sleep, random = random, v = guard(env.vpos), day = day()}
                r.spot = choice and choice.spot or nil
                r.sleep = choice and choice.sleep or false
                return
            end
            snapped.id = r.spot.id; snapped.procedural = r.spot.procedural
            r.spot = snapped
            stage('spot-chosen', {key = r.key, id = snapped.id, kind = snapped.kind, sleep = r.sleep == true})
            if r.serial then
                -- She already has a body (a party member released into the flat): she walks to her place, nothing is created.
                r.state, r.handle = 'placing', nil
                return
            end
            -- Casual clothes from the first frame (the outfits module dresses a new copy by this setting).
            if env.outfits then guard(env.outfits.setHome, r.key, true) end
            local ok, err = env.bodies.spawn(r, snapped)
            if ok then r.state, r.spawnedAt = 'spawning', clock
            else
                stage('failed:spawn', {key = r.key, why = tostring(err):sub(1, 80)})
                r.state, r.retryAt = 'virtual', clock + 30
            end
        elseif state == 'spawning' then
            for _, b in ipairs(rowCache) do
                if b.profileKey == r.key and b.appointmentId == 'hm:' .. r.key and b.state == 'visiting' and not b.lost then
                    r.serial, r.entity = b.serial, b.entityID
                    r.state = 'placing'
                    stage('body-spawned', {key = r.key, serial = b.serial})
                end
            end
            if r.state == 'spawning' and clock - (r.spawnedAt or clock) > M.SPAWN_TIMEOUT then
                stage('failed:spawn-timeout', {key = r.key, after = M.SPAWN_TIMEOUT})
                -- The game refused the body (probe.log 2026-10-25: "Scenery or a vehicle is blocking the companion position" at corpo-bar-2, four
                -- times in a row, the same spot chosen again each time): a spot that fails twice for her is given up for the session.
                local id = r.spot and r.spot.id
                if id and not r.spot.procedural then
                    r.spawnMiss = (r.spawnMissId == id and r.spawnMiss or 0) + 1
                    r.spawnMissId = id
                    if r.spawnMiss >= M.SPAWN_MISSES then rejected[id] = true; stage('spot-rejected', {key = r.key, id = id, why = 'no body could be made there'}) end
                end
                r.spot = nil
                r.state, r.retryAt = 'virtual', clock + 30
                for _, b in ipairs(rowCache) do if b.appointmentId == 'hm:' .. r.key then guard(env.bodies.delete, b.serial) end end
            end
        elseif state == 'placing' then
            if not r.handle then
                r.handle = env.seats.occupy(r.serial, r.spot, {sleep = r.sleep})
                r.placingAt = clock
                if not r.handle then
                    stage('failed:occupy', {key = r.key, id = r.spot and r.spot.id})
                    r.fails = r.fails + 1; r.spot = nil; r.sleep = false; chooseNext(r, false); return
                end
            end
            local status = env.seats.status(r.handle)
            if status == 'ready' then
                -- The first place this body takes (her later changes of place are not written).
                if r.placed ~= r.serial then r.placed = r.serial; stage('placed', {key = r.key, id = r.spot and r.spot.id, kind = r.spot and r.spot.kind}) end
                r.state = 'at'; r.fails = 0
                dwellFor(r)
            elseif status == 'failed' or clock - (r.placingAt or clock) > M.OCCUPY_TIMEOUT then
                if r.spot and r.spot.id then rejected[r.spot.id] = true end
                stage('failed:place', {key = r.key, id = r.spot and r.spot.id, why = status == 'failed' and 'failed' or 'timeout'})
                guard(env.seats.release, r.handle, true)
                r.handle = nil
                r.fails = r.fails + 1
                r.spot = nil; r.sleep = false
                if r.fails > 4 then r.retryAt = clock + 60; dropBody(r, 'failed') return end
                chooseNext(r, false)
            end
        elseif state == 'at' then
            local talking = guard(env.talking)
            if r.entity and talking == r.entity then r.engagedUntil = clock + 20 end
            if r.engagedUntil and clock < r.engagedUntil then return end
            if chat and chat.involves and chat.involves(r.key) then return end
            local want = sleepWanted(r)
            if want ~= (r.sleep == true) and (clock - (r.settledAt or 0)) > 5 then
                chooseNext(r, want)
            elseif clock >= (r.dwellUntil or 1e18) and clock - (r.settledAt or 0) >= M.MIN_MOVE and not r.sleep then
                chooseNext(r, false)
            end
        elseif state == 'replanning' then
            if r.wantProc or not r.nextSpot then
                local spot, why = procedural(r)
                if not spot then if why ~= 'wait' then r.tries = r.tries + 1 end if r.tries > 5 then r.state = 'at'; dwellFor(r) end return end
                r.nextSpot = spot
            end
            local snapped, why, wait = env.seats.prepare(r.nextSpot, {key = r.key, apt = r.apt, sleep = r.nextSleep == true})
            if wait then return end
            if not snapped then
                if r.nextSpot.id then rejected[r.nextSpot.id] = true end
                r.nextSpot, r.wantProc = nil, true
                r.tries = r.tries + 1
                if r.tries > 5 then r.state = 'at'; dwellFor(r) end
                return
            end
            snapped.id = r.nextSpot.id; snapped.procedural = r.nextSpot.procedural
            r.nextSpot = snapped
            if r.handle then guard(env.seats.release, r.handle, false) end
            r.state, r.leftAt = 'moving', clock
        elseif state == 'moving' then
            local status = r.handle and env.seats.status(r.handle) or 'released'
            if status == 'released' or status == 'failed' or clock - (r.leftAt or clock) > 8 then
                if r.handle then guard(env.seats.release, r.handle, true) end
                r.handle = nil
                r.spot, r.sleep, r.nextSpot = r.nextSpot, r.nextSleep == true, nil
                r.state = 'placing'
            end
        elseif state == 'joining' then
            local status = r.handle and env.seats.status(r.handle) or 'released'
            if status == 'released' or status == 'failed' or clock - (r.joinStart or clock) > M.JOIN_WAIT then
                if r.handle then guard(env.seats.release, r.handle, true) end
                r.handle = nil
                local serial = r.serial
                local ok, err = env.companions.join(serial)
                if ok then
                    if env.outfits then guard(env.outfits.setHome, r.key, false) end
                    r.state, r.serial, r.entity, r.spot = 'party', nil, nil, nil
                    say(ui.t('{name} joins you.', {name = r.name}))
                else
                    stage('failed:join', {key = r.key, why = tostring(err):sub(1, 80)})
                    r.state = 'placing'; r.handle = nil
                end
            end
        end
    end

    -- ---- held (scenes, quests, fights) --------------------------------------------------------------------------------------------
    local function hideAll(hidden)
        for _, r in pairs(rec) do
            if r.serial then guard(env.bodies.hide, r.serial, hidden) end
        end
    end

    local function applyHeld(reason, apt)
        if reason == 'combat' then
            if anyBodies() then
                for _, r in pairs(rec) do if r.serial then dropBody(r, 'combat') end end
                if chat and chat.interrupt then chat.interrupt('combat', true) end
            end
            combatUntil = clock + M.COMBAT_RETURN
            return
        end
        if chat and chat.interrupt then chat.interrupt(reason, true) end
        if not heldSince then
            heldSince = clock
            stage('held', {apt = apt, reason = reason})
            if anyBodies() then hideAll(true) end
        end
        clearSince = nil
        if clock - heldSince >= M.HELD_DELETE then
            for _, r in pairs(rec) do if r.serial then dropBody(r, 'held') end end
        end
    end

    local function clearHeld()
        if not heldSince then return end
        clearSince = clearSince or clock
        if clock - clearSince >= M.CLEAR_FOR then
            hideAll(false)
            heldSince, clearSince = nil, nil
        end
    end

    -- ---- the step --------------------------------------------------------------------------------------------------------------------------
    local function unload()
        for _, r in pairs(rec) do if r.state ~= 'party' and (r.serial or r.state ~= 'virtual') then dropBody(r, 'left') end end
        if chat and chat.reset then chat.reset() end
        data = nil
        procUsed = {}
        welcome = nil
    end

    local function settledPeople()
        local people = {}
        for key, r in pairs(rec) do
            if r.state == 'at' and not r.sleep and r.serial and rowsBySerial[r.serial] and rowsBySerial[r.serial].position
                and not (r.engagedUntil and clock < r.engagedUntil) then
                local p = rowsBySerial[r.serial].position
                people[#people + 1] = {key = key, name = r.name, serial = r.serial, entity = r.entity, x = p.x, y = p.y, z = p.z}
            end
        end
        table.sort(people, function(a, b) return a.key < b.key end)
        return people
    end

    function C.update(dt)
        clock = clock + (tonumber(dt) or 0)
        if not C.hasWork() then return end
        acc = acc - (tonumber(dt) or 0)
        if acc > 0 then return end
        acc = busy and M.STEP_BUSY or M.STEP
        if not guard(env.ready) then return end
        local here = hereId()
        if not here and not zone and not leftAt and not anyBodies() then busy = false; acc = M.STEP_AWAY; return end
        pollRows()
        -- Strays: a body of ours nobody lives in (moved out, a record reset) goes.
        for _, b in ipairs(rowCache) do
            local r = b.profileKey and rec[b.profileKey] or nil
            if not r then
                guard(env.bodies.delete, b.serial)
            elseif r.serial == b.serial then
                -- known
            elseif r.state == 'spawning' and b.appointmentId == 'hm:' .. r.key then
                -- stepResident picks it up
            elseif (r.state == 'party' or (r.state == 'virtual' and not r.serial)) and b.state == 'visiting' then
                -- She was released into the flat (or the body was made while we were not looking): the body is a resident again.
                r.serial, r.entity, r.state, r.spot, r.handle = b.serial, b.entityID, 'planning', nil, nil
                r.tries, r.sleep = 0, false
            elseif b.state ~= 'spawning' then
                guard(env.bodies.delete, b.serial)
            end
        end
        -- A party member who left the party any other way is a resident again.
        for key, r in pairs(rec) do
            if r.state == 'party' and not guard(env.companions.partyMember, key) then r.state = 'virtual'; r.retryAt = clock + 5 end
        end
        if here and (rec and next(homes)) then
            -- In a flat of V's.
            leftAt = nil
            if zone ~= here then
                zone, zoneSince = here, clock
                factsShown = nil
                local living = 0
                for _, r in pairs(rec) do if r.apt == here then living = living + 1 end end
                stage('flat-entered', {apt = here, residents = living})
                local h = hours()
                local last = lastHome[here]
                welcome = h and last and (h - last) >= M.WELCOME_AWAY and (h - last) < 2000 and {apt = here, away = h - last} or nil
                if welcome and lastWelcomeAt and clock - lastWelcomeAt < M.WELCOME_GAP then welcome = nil end
            end
            local h = hours()
            if h then lastHome[here] = h end
            if combatUntil and clock < combatUntil then return end
            local reason = guard(env.held)
            local facts = loadData() and reservedFacts(here) or {}
            local signature = table.concat(facts, ',')
            if signature ~= factsShown then
                factsShown = signature
                stage('hold-facts', {apt = here, facts = signature ~= '' and signature or '-'})
            end
            if facts[1] then reason = reason or ('quest:' .. facts[1]) end
            if reason then applyHeld(reason, here) return end
            clearHeld()
            if heldSince then return end
            if not loadData() then
                if not noData then noData = true; stage('failed:no-data', {apt = here}) end
                return
            end
            planResidents(here)
            busy = false
            for key, r in pairs(rec) do
                if r.apt == here and r.state ~= 'virtual' and r.state ~= 'party' then
                    local twin = env.twin and guard(env.twin, r)
                    if twin then dropBody(r, 'twin'); r.retryAt = clock + 20
                    else
                        stepResident(r, here)
                        if r.state ~= 'at' then busy = true end
                    end
                elseif r.apt ~= here and r.serial then
                    -- A body of another flat's resident (a stale one): gone.
                    dropBody(r, 'elsewhere')
                end
            end
            -- Pair chat and greeting, only with everybody settled in this flat.
            local people = settledPeople()
            -- A chat under way is stepped even when a speaker is engaged for a moment (V spoke to her): it ends itself ('dropped') at the next line.
            if chat and (#people >= 2 or (chat.active and chat.active())) then chat.update(busy and M.STEP_BUSY or M.STEP) end
            if welcome and #people >= 1 then
                local v = guard(env.vpos)
                local best, bestD
                for _, p in ipairs(people) do
                    local d = v and flat(p, v) or 99
                    if d <= M.WELCOME_NEAR and (not bestD or d < bestD) then best, bestD = p, d end
                end
                if best and env.greet and not (chat and chat.active and chat.active()) then
                    local others = {}
                    for _, p in ipairs(people) do if p.key ~= best.key then others[#others + 1] = p.name end end
                    local ok = guard(env.greet, {key = best.key, name = best.name, serial = best.serial, entity = best.entity,
                        place = M.NAMES[here], awayHours = welcome.away, others = others})
                    if ok ~= false then lastWelcomeAt = clock end
                    welcome = nil
                end
            end
        else
            -- Not in a flat of V's (or nobody lives anywhere).
            if zone then stage('flat-left', {apt = zone}); zone = nil; leftAt = clock; heldSince, clearSince = nil, nil end
            if chat and chat.interrupt and chat.active and chat.active() then chat.interrupt('left', true) end
            if leftAt and clock - leftAt >= M.LEAVE_GRACE then unload(); leftAt = nil end
            if not leftAt and anyBodies() then leftAt = clock end
            busy = false
        end
    end

    function C.setChat(module)
        if chat and chat ~= module and chat.interrupt then chat.interrupt('off', true) end
        chat = module
    end
    -- Is a pair chat in progress (between lines too)? The speak-up arbiter reads it (init.lua convaiUnpromptedBusy).
    function C.chatActive() return chat ~= nil and chat.active ~= nil and chat.active() == true end
    -- Development (mod/housemate-survey.lua): the next chat and the welcome line now.
    function C.forceChat() return chat ~= nil and chat.force ~= nil and chat.force() == true end
    function C.forceGreeting()
        if not zone then return false end
        welcome, lastWelcomeAt = {apt = zone, away = 12}, nil
        return true
    end
    -- The name of the flat V is in now (the chat prompt says where they are).
    function C.placeName() return zone and M.NAMES[zone] or '' end
    -- The housemates that can chat or be greeted by now: settled, awake, not in a talk with V.
    function C.people() return settledPeople() end
    -- A district event (V crossed a boundary): look at once.
    function C.wake() acc = 0 end

    -- ---- party transitions ------------------------------------------------------------------------------------------------------------
    local function residentByEntity(entity)
        for _, r in pairs(rec) do if r.entity and r.entity == entity and r.serial then return r end end
        return nil
    end

    -- Tag along: the housemate leaves her place and joins the party on the same body.
    function C.recallOne(r)
        if not r or not r.serial or r.state == 'joining' or r.state == 'party' then return false end
        if r.state == 'planning' or r.state == 'spawning' or r.state == 'virtual' then return false end
        if r.handle and env.seats then guard(env.seats.release, r.handle, false) end
        r.state, r.joinStart, r.nextSpot = 'joining', clock, nil
        acc = 0
        busy = true
        return true
    end

    -- Back at home: a party member of V's is released into the routine of the flat V stands in (it is hers).
    function C.restHere(serial, key)
        local apt = hereId()
        local r = rec[key]
        if not r or r.apt ~= apt then return false, 'not-here' end
        local ok, err = env.companions.releaseToHome(serial, apt)
        if not ok then return false, err end
        r.serial, r.state, r.spot, r.handle, r.sleep, r.tries = nil, 'party', nil, nil, false, 0
        if env.outfits then guard(env.outfits.setHome, key, true) end
        acc = 0
        return true
    end

    -- ---- moving in and out --------------------------------------------------------------------------------------------------------
    function C.stay(key, apt)
        if not key or not M.NAMES[apt] then stage('failed:unknown-apartment', {key = key, apt = apt}); return false, 'unknown' end
        if not guard(env.eligible, key) then stage('failed:not-eligible', {key = key}); return false, 'not-eligible' end
        if not C.owned()[apt] then stage('failed:not-owned', {key = key, apt = apt}); return false, 'not-owned' end
        -- A scene is running in the flat V stands in: nothing changes (she stays in the party, the offer did not list this flat either).
        if apt == hereId() and reservedReason(apt) then stage('failed:quest-reserved', {key = key, apt = apt}); return false, 'quest-reserved' end
        local ok, why = registry.write(env.store, key, apt)
        if not ok then stage('failed:store', {key = key, why = tostring(why):sub(1, 80)}); return false, why end
        local previous = homes[key]
        homes[key] = apt
        local r = rec[key] or newRecord(key, apt)
        r.apt = apt
        r.moved, r.movedAt = 'now', clock
        restAsk[key] = nil
        if previous and previous ~= apt and r.serial then dropBody(r, 'moved') end
        if env.outfits then guard(env.outfits.setHome, key, true) end
        local member = guard(env.companions.partyMember, key)
        if member then
            r.state = 'party'
            if hereId() == apt then
                C.restHere(member.serial, key)
            else
                guard(env.companions.leave, member.serial)
            end
        end
        say(ui.t('{name} moves into {apartment}.', {name = r.name, apartment = aptName(apt)}))
        stage('registered', {key = key, apt = apt, party = member ~= nil, here = hereId() or '-'})
        acc = 0
        return true
    end

    function C.moveOut(key, quiet)
        if not homes[key] then return false, 'not-housemate' end
        local ok, why = registry.write(env.store, key, nil)
        if not ok then return false, why end
        local r = rec[key]
        homes[key] = nil
        if r then
            local name = r.name
            if r.serial and r.state ~= 'party' then dropBody(r, 'moved-out') end
            rec[key] = nil
            if not quiet then say(ui.t('{name} has moved out.', {name = name})) end
        end
        restAsk[key] = nil
        return true
    end

    -- Settings > Housemates > Evict all housemates: every housemate moves out, each by the one path of a single move-out (registry written, body and seat
    -- let go, her place free for the others). Party members who are not housemates are not touched; a housemate who is with V stays in the party.
    function C.evictAll()
        local keys = {}
        for key in pairs(homes) do keys[#keys + 1] = key end
        table.sort(keys)
        local count = 0
        for _, key in ipairs(keys) do if C.moveOut(key, true) then count = count + 1 end end
        if chat and chat.interrupt and chat.active and chat.active() then chat.interrupt('evicted', true) end
        acc = 0
        stage('evicted-all', {count = count, of = #keys})
        return count
    end

    function C.learnV(anchor, forward, kind)
        local apt = hereId()
        if not apt or not anchor then return end
        for _, l in ipairs(learned) do if l.apt == apt and flat(l, anchor) < 0.3 then return end end
        learned[#learned + 1] = {x = anchor.x, y = anchor.y, z = anchor.z, apt = apt, kind = kind}
        log('Housemates: V sat at ' .. string.format('%.2f %.2f %.2f', anchor.x, anchor.y, anchor.z) .. ' in ' .. apt)
        -- A housemate on that seat gets up.
        for _, r in pairs(rec) do
            if r.spot and r.spot.x and flat(r.spot, anchor) < 0.45 and r.serial and r.state == 'at' then chooseNext(r, false) end
        end
        if env.learnedStore then guard(env.learnedStore, learned) end
    end
    function C.setLearned(list) learned = {} for _, l in ipairs(list or {}) do learned[#learned + 1] = l end end
    function C.learnedList() return learned end

    function C.talkStarted(entity)
        local r = residentByEntity(entity)
        if chat and chat.interrupt and chat.active and chat.active() then chat.interrupt('talk', false) end
        if not r then return end
        r.engagedUntil = clock + 20
        if r.sleep and r.state == 'at' then
            r.wakeUntil = clock + M.WAKE_STAY
            chooseNext(r, false)
        end
    end

    function C.lost(serial, reason)
        for _, r in pairs(rec) do
            if r.serial == serial then
                r.serial, r.entity, r.handle, r.spot = nil, nil, nil, nil
                if r.state ~= 'party' then r.state = 'virtual' end
                if reason == 'dismissed' then r.retryAt = clock + 30 end
            end
        end
    end

    -- ---- offers ---------------------------------------------------------------------------------------------------------------------------
    local function members(vp)
        local list = {}
        for key, r in pairs(rec) do
            if r.serial and (r.state == 'at' or r.state == 'placing' or r.state == 'moving' or r.state == 'replanning') then
                local row = rowsBySerial[r.serial]
                local p = row and row.position
                local d = (vp and p) and flat(p, vp) or 0
                if d <= M.EARSHOT then
                    list[#list + 1] = {serial = r.serial, id = r.entity, key = key, name = r.name, d = d}
                end
            end
        end
        table.sort(list, function(a, b) if a.d == b.d then return a.key < b.key end return a.d < b.d end)
        local out = {}
        for i = 1, math.min(#list, M.MEMBERS) do out[i] = {serial = list[i].serial, id = list[i].id, key = list[i].key, name = list[i].name} end
        return out
    end

    local function askedFor(key)
        local a = restAsk[key]
        if a and clock - a.at <= M.REST_ASK_TTL then return a end
        restAsk[key] = nil
        return nil
    end

    -- The apartment V chose in Settings > Housemates for "move in" without naming one (env.moveIn: 'ask' or an apartment id): only one that V owns and
    -- the offer lists. Anything else is nil and she asks which one, as before.
    local function moveInDefault(apartments)
        local id = guard(env.moveIn)
        if type(id) ~= 'string' or id == 'ask' then return nil end
        for _, a in ipairs(apartments) do if a.id == id then return id end end
        return nil
    end

    -- The `home` offer of a conversation turn (in person, private or the first speaker of a group). nil: nothing to offer.
    function C.homeOffer(entity, context)
        if type(entity) ~= 'string' or type(context) ~= 'table' or type(context.profileKey) ~= 'string' then return nil end
        if guard(env.held) == 'combat' then return nil end
        -- Only our own copies (a party member, a visitor, a housemate) are ever offered anything: a game character, or an ordinary person
        -- on the street, gets nothing, however many housemates stand near.
        if env.ours and not guard(env.ours, entity) then return nil end
        local key = context.profileKey
        local eligible = guard(env.eligible, key) == true
        local vp = guard(env.vpos)
        local offer = {available = true, actor = {id = entity, key = key}}
        local apartments = eligible and ownedList() or {}
        local present = hereId()
        if present and eligible and reservedReason(present) then
            local rest = {}
            for _, a in ipairs(apartments) do if a.id ~= present then rest[#rest + 1] = a end end
            apartments = rest
            offer.unavailable = 'quest-reserved'
        end
        offer.apartments = apartments
        if present and eligible then offer.here = present end
        offer.fallback = eligible and moveInDefault(apartments) or nil
        if eligible and homes[key] then
            offer.lives = {id = homes[key], name = M.NAMES[homes[key]]}
            offer.moveOut = true
        end
        local asked = askedFor(key)
        if asked and eligible then offer.asked = {from = asked.from, here = asked.here} end
        offer.members = zone and members(vp) or {}
        if #apartments == 0 and #offer.members == 0 and not offer.moveOut then return nil end
        local ids = {}
        for _, a in ipairs(apartments) do ids[#ids + 1] = a.id end
        local shown = {key = key, apartments = #ids > 0 and table.concat(ids, ',') or '-', here = offer.here or '-', lives = homes[key] or '-',
            members = #offer.members}
        local signature = shown.apartments .. '|' .. shown.here .. '|' .. shown.lives .. '|' .. shown.members .. '|' .. tostring(offer.fallback)
        if offer.fallback then shown.default = offer.fallback end
        if offerShown[key] ~= signature then offerShown[key] = signature; stage('offer-shown', shown) end
        return offer
    end

    -- Group: the same offer for the first speaker of a round (the audience is whoever is in earshot).
    function C.groupOffer(entity, context)
        local offer = C.homeOffer(entity, context)
        if not offer then return nil end
        offer.apartments = {}
        offer.here, offer.asked, offer.fallback = nil, nil, nil
        if #offer.members == 0 and not offer.moveOut then return nil end
        return offer
    end

    -- Decorates the party members of a leave offer who live in a flat of V's other than the one V is in: "ask first, then leave".
    function C.decorateLeave(offer)
        if type(offer) ~= 'table' or type(offer.members) ~= 'table' then return offer end
        local present = hereId()
        for _, member in ipairs(offer.members) do
            local home = homes[member.key]
            if home and present and home ~= present then
                member.away, member.homeName, member.hereName = true, M.NAMES[home], M.NAMES[present]
                local asked = askedFor(member.key)
                if asked and asked.here == present then member.confirmed = true
                else restAsk[member.key] = {from = home, here = present, at = clock} end
            end
        end
        return offer
    end

    -- A leave packet (target: a member id or 'all') split by what it means for each member now: {rest = {...}, depart = {...}, refused = {...}}.
    function C.splitLeave(target, offer)
        local out = {rest = {}, depart = {}, refused = {}}
        local present = hereId()
        for _, member in ipairs(offer.members or {}) do
            if target == 'all' or member.id == target then
                local home = homes[member.key]
                if home and present and home == present then out.rest[#out.rest + 1] = member
                elseif member.away and not member.confirmed then out.refused[#out.refused + 1] = member
                else out.depart[#out.depart + 1] = member end
            end
        end
        return out
    end

    -- A `companion-home` packet: home = {op = 'stay', apartment} | {op = 'move-out'} | {op = 'join', target}. offer is the leased one.
    function C.queueHome(home, offer, entity, requestId)
        if type(home) ~= 'table' or type(offer) ~= 'table' then return false, ui.t('That action is not available.') end
        local key = offer.actor and offer.actor.key
        stage('action-received', {key = key, op = home.op, apt = home.apartment or '-'})
        if home.op == 'stay' then
            local allowed = false
            for _, a in ipairs(offer.apartments or {}) do if a.id == home.apartment then allowed = true end end
            if not allowed then stage('failed:not-offered', {key = key, apt = home.apartment}); return false, ui.t('That action is not available.') end
            local ok, why = C.stay(key, home.apartment)
            if not ok then return false, why == 'not-owned' and ui.t('You do not have that apartment.') or ui.t('That action is not available.') end
            return true, nil
        elseif home.op == 'move-out' then
            if not offer.moveOut then return false, ui.t('That action is not available.') end
            local ok = C.moveOut(key)
            if not ok then return false, ui.t('That action is not available.') end
            return true, nil
        elseif home.op == 'join' then
            local joined, names = 0, {}
            for _, member in ipairs(offer.members or {}) do
                if home.target == 'all' or member.id == home.target then
                    local r = rec[member.key]
                    if r and r.entity == member.id and C.recallOne(r) then joined = joined + 1; names[#names + 1] = r.name end
                end
            end
            if joined == 0 then return false, ui.t('That companion is not available.') end
            return true, nil
        end
        return false, ui.t('That action is not available.')
    end

    -- Phone: the offer carries a one-use token.
    function C.phoneOffer(profileKey)
        if type(profileKey) ~= 'string' or guard(env.eligible, profileKey) ~= true then return nil end
        local apartments = ownedList()
        local offer = {version = 1, apartments = apartments, fallback = moveInDefault(apartments)}
        local present = hereId()
        if present then offer.here = present end
        if homes[profileKey] then
            offer.lives = {id = homes[profileKey], name = M.NAMES[homes[profileKey]]}
            offer.moveOut = true
        end
        counter = counter + 1
        offer.token = 'home-' .. registry.hex(registry.hash(profileKey .. ':' .. counter)) .. registry.hex(math.floor(random() * 4294967295))
        phoneTokens[profileKey] = offer.token
        if #apartments == 0 and not offer.moveOut then return nil end
        return offer
    end
    function C.phoneAction(profileKey, action)
        if type(action) ~= 'table' or phoneTokens[profileKey] ~= action.token then
            stage('failed:phone-token', {key = profileKey, op = type(action) == 'table' and action.action or '-'})
            return false
        end
        phoneTokens[profileKey] = nil
        stage('action-received', {key = profileKey, op = action.action, apt = action.apartment or '-', route = 'phone'})
        if action.action == 'stay' then return C.stay(profileKey, action.apartment) end
        if action.action == 'move-out' then return C.moveOut(profileKey) end
        return false
    end

    -- ---- reading ------------------------------------------------------------------------------------------------------------------
    -- The note a turn with this character carries (bridge/turn-context.mjs `housemate`).
    function C.note(profileKey)
        local apt = homes[profileKey]
        if not apt then return nil end
        local r = rec[profileKey]
        local others = {}
        for key, other in pairs(rec) do
            if key ~= profileKey and other.apt == apt and #others < 8 then others[#others + 1] = other.name end
        end
        table.sort(others)
        local note = {apartment = aptName(apt), atHome = r ~= nil and r.state ~= 'party', others = others}
        if r and r.moved == 'now' and clock - (r.movedAt or 0) < 600 then note.moved = 'now' end
        if askedFor(profileKey) then note.asked = true end
        return note
    end
    function C.noted(profileKey)
        local r = rec[profileKey]
        if r and r.moved == 'now' then r.movedTurns = (r.movedTurns or 0) + 1; if r.movedTurns >= 3 then r.moved = nil end end
    end

    -- Rows for the manager page: {key, name, apartment, state = 'home' | 'party' | 'out'}.
    function C.rows()
        local rows = {}
        for key, apt in pairs(homes) do
            local r = rec[key]
            rows[#rows + 1] = {key = key, name = r and r.name or key, apartment = apt, apartmentName = M.NAMES[apt],
                state = r and r.state == 'party' and 'party' or (r and r.serial and 'home' or 'out')}
        end
        table.sort(rows, function(a, b) return a.name < b.name end)
        return rows
    end

    function C.snapshot()
        local out = {zone = zone, clock = clock, residents = {}}
        for key, r in pairs(rec) do
            out.residents[key] = {state = r.state, serial = r.serial, spot = r.spot and r.spot.id, sleep = r.sleep, apt = r.apt}
        end
        return out
    end

    -- Settings > Housemates went Off: every body of ours is removed quietly (a housemate in the party stays a party member), the seats are let go and the
    -- controller forgets everything. The saved flats are not touched (the glue reads them again when the setting is On).
    function C.shutdown()
        pollRows()
        for _, b in ipairs(rowCache) do guard(env.bodies.delete, b.serial) end
        unload()
        C.reset('off', false)
    end

    -- A world ended (preserve = false: a load, death or the main menu) or V fast travelled (preserve = true: the bodies were deleted by
    -- companions.beginFastTravel, the registry stays). Nothing is called into the game.
    function C.reset(reason, preserve)
        for _, r in pairs(rec) do
            r.serial, r.entity, r.handle, r.spot, r.nextSpot, r.sleep = nil, nil, nil, nil, nil, false
            r.state = 'virtual'
            r.retryAt = nil
        end
        zone, leftAt, heldSince, clearSince, combatUntil = nil, nil, nil, nil, nil
        rowCache, rowsBySerial = {}, {}
        welcome, noData = nil, nil
        restAsk = {}
        if chat and chat.reset then chat.reset() end
        if preserve ~= true then homes, rec = {}, {}; rejected = {}; lastHome = {}; offerShown = {} end
        data = nil
    end

    return C
end

return M
