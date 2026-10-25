-- Immersive invitations (docs/IMMERSIVE_INVITATIONS.md): a companion is asked to meet V, travels there, texts V that she is there, waits,
-- and joins the party when V reaches her, or leaves angry (and remembers it) when V never comes.
--
-- This file is the appointment table and its state machine. It touches the game only through the seams in `env`
-- (mod/immersive-world.lua is the game adapter, mod/init.lua wires everything), so the whole machine runs in the tests with fakes.
-- It is loaded only while the setting is On, does nothing between steps but add the frame delta, and a step (every STEP seconds of
-- play time) with no appointment, offer or queued text is a handful of comparisons.
--
-- Time: `clock` is play time. update(dt) is called with the frame delta, which is zero while the game is paused (menus, loading), so
-- every wait, delay and countdown freezes with the game. Offers are the exception: they use the wall clock (env.wall) because the
-- phone that carries the answer pauses the game.
--
--   scheduled  nothing exists; waits for its preparation time (V near the spot) or for its arrival time (virtual arrival)
--   preparing  the party queue prepares her (memory, voice, connection) and a hidden spot is found; the gate holds the spawn
--   en-route   her body walks (or drives) to the spot
--   waiting    she is at the spot, body = 'visitor' (a copy stands there) or 'virtual' (no body: V is far away)
--   leaving    stood up: she walks off and is removed once V cannot see her
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
local M = {}

M.STEP = 0.5                 -- seconds of play time between steps
M.SIM_RADIUS = 250           -- V closer than this to the spot: her body is simulated
M.FAR_RADIUS = 350           -- V farther than this: a simulated body is removed (hysteresis)
M.MATERIALIZE_RADIUS = 120   -- a virtual waiting companion gets a body when V comes this close
M.MEET_RADIUS = 5            -- V this close to her (and still for MEET_DWELL) is a meeting
M.MEET_DWELL = 1.5
M.ARRIVE_DISTANCE = 2.5
M.PREP_LEAD = 45             -- preparation starts this long before she has to spawn
M.OFFER_TTL = 180            -- wall seconds an offer can be answered
M.STUCK_WINDOW = 10          -- seconds without 1 m of progress
M.TRIP_CAP_MIN = 90
M.MAX_RESPAWNS = 2
M.MAX_CARS = 3
M.WALK_SPEED, M.RUN_SPEED, M.CAR_SPEED = 1.5, 4, 10
M.ETA = {walk = 50, car = 45}        -- default trip estimates before a spot is known
M.LEDGER_TTL = 12 * 3600             -- play seconds a stood-up or cancelled note is kept
M.LEDGER_DELIVERIES = {['stood-up'] = 2, cancelled = 1}
M.SAVE_PERIOD = 30
M.LEAVE_CAP = 90
M.SPOT_TRIES = 6
M.TEXT_PATIENCE = 120

local function ground(a, b) return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2) end
local function copyPoint(p) return p and {x = p.x, y = p.y, z = p.z or 0} or nil end
local function finitePoint(p)
    return type(p) == 'table' and type(p.x) == 'number' and type(p.y) == 'number' and p.x == p.x and p.y == p.y
        and math.abs(p.x) < 1e7 and math.abs(p.y) < 1e7
end
local function clip(text, limit)
    if type(text) ~= 'string' then return nil end
    text = text:gsub('[%c<>]', ' '):gsub('%s+', ' '):match('^%s*(.-)%s*$')
    if text == '' then return nil end
    if #text > limit then
        local cut = limit
        while cut > 0 and text:byte(cut + 1) and text:byte(cut + 1) >= 0x80 and text:byte(cut + 1) < 0xC0 do cut = cut - 1 end
        text = text:sub(1, cut)
    end
    return text
end

function M.new(env)
    local C = {}
    local clock, acc, nextId = 0, 0, 0
    local appts, offers, ledger, texts = {}, {}, {}, {}
    local saveKey, saveSeq, lastSave, dirty = nil, nil, 0, false

    local function settings()
        local value = env.settings and env.settings() or {}
        return value
    end
    local function wall() return env.wall and env.wall() or os.clock() end
    local function log(line) if env.log then pcall(env.log, 'Immersive invitations: ' .. line) end end

    function C.enabled() return settings().enabled == true end

    local function byProfile(profileKey)
        for _, a in ipairs(appts) do if a.profileKey == profileKey then return a end end
        return nil
    end
    local function visitorRow(a)
        if not a.serial then return nil end
        for _, row in ipairs(env.companions.visitors()) do
            if row.serial == a.serial then return row end
        end
        return nil
    end
    local function carsInUse()
        local n = 0
        for _, a in ipairs(appts) do if a.method == 'car' then n = n + 1 end end
        return n
    end
    local function minutes(seconds) return math.max(0, math.floor((seconds or 0) / 60 + 0.5)) end

    -- ---- the ledger: what a character remembers of the last appointment -----------------------------------------------------
    local function remember(profileKey, kind, place, waited)
        ledger[profileKey] = {kind = kind, place = clip(place, 120) or '', minutes = minutes(waited), at = clock, delivered = 0}
        dirty = true
    end
    -- The note a turn with this character carries (bridge/turn-context.mjs `appointment`), or nil.
    function C.note(profileKey)
        local a = byProfile(profileKey)
        if a and a.phase ~= 'leaving' then
            return {kind = a.phase == 'waiting' and 'waiting' or 'on-the-way', place = clip(a.place, 120) or '', minutes = 0}
        end
        local entry = ledger[profileKey]
        if entry then
            if clock - entry.at > M.LEDGER_TTL or entry.delivered >= (M.LEDGER_DELIVERIES[entry.kind] or 1) then
                ledger[profileKey] = nil
                return nil
            end
            return {kind = entry.kind, place = entry.place, minutes = math.min(entry.minutes, 240)}
        end
        return nil
    end
    -- A turn carrying the note was sent: a stood-up memory is brought up at most twice, a cancelled one once.
    function C.noted(profileKey)
        local entry = ledger[profileKey]
        local a = byProfile(profileKey)
        if entry and (not a or a.phase == 'leaving') then entry.delivered = entry.delivered + 1; dirty = true end
    end

    -- ---- texts ---------------------------------------------------------------------------------------------------------------
    local function fallbackText(kind, a, waited)
        local place = clip(a.place, 120) or ui.t('the meeting spot')
        if kind == 'arrived' then return ui.t("I'm here at {place}. Where are you?", {place = place}) end
        if kind == 'stood-up' then
            return ui.t('I waited {minutes} minutes at {place} and you never showed. Forget it.', {minutes = math.max(1, minutes(waited)), place = place})
        end
        if kind == 'cancelled' then return ui.t("Fine. Call me when you know what you want.") end
        return ui.t("Something came up and I can't make it. Sorry.")
    end
    local function queueText(a, kind, waited)
        if kind ~= 'failed' and settings().texts == false then return end
        texts[#texts + 1] = {profileKey = a.profileKey, name = a.name, kind = kind, place = clip(a.place, 120) or '',
            minutes = minutes(waited), car = a.method == 'car' and a.arrivedByCar == true, at = clock,
            fallback = fallbackText(kind, a, waited)}
    end
    local function flushTexts(held)
        if held or not texts[1] then return end
        local keep = {}
        for _, item in ipairs(texts) do
            local sent = false
            local ok, result = pcall(env.text.send, item)
            sent = ok and result == true
            if not sent and clock - item.at < M.TEXT_PATIENCE then keep[#keep + 1] = item end
        end
        texts = keep
    end

    -- ---- removal -------------------------------------------------------------------------------------------------------------
    local function removeBody(a, reason)
        if a.serial then
            local serial = a.serial
            a.serial = nil
            pcall(env.companions.dismissVisitor, serial, reason or 'module')
        end
    end
    local function drop(a)
        for index, other in ipairs(appts) do
            if other == a then table.remove(appts, index); break end
        end
        a.dead = true
        dirty = true
    end
    local function endJob(a)
        if a.job then
            pcall(env.queue.dismiss, a.job, true)
            a.job = nil
        end
    end
    -- Ends an appointment without any text or memory (a feature switch, a replaced request, V dismissing her).
    local function quiet(a, why)
        endJob(a)
        removeBody(a, 'module')
        if env.world.release then pcall(env.world.release, a) end
        drop(a)
        log(tostring(a.name) .. ' ended quietly: ' .. tostring(why))
    end

    -- ---- creating an appointment ---------------------------------------------------------------------------------------------
    local function create(spec)
        local existing = byProfile(spec.profileKey)
        if existing then quiet(existing, 'replaced') end
        local options = settings()
        nextId = nextId + 1
        local method = options.arrival == 'car' and carsInUse() < M.MAX_CARS and 'car' or 'walk'
        local delay = (tonumber(options.delay) or 0) * 60
        local a = {id = nextId, key = spec.key, profileKey = spec.profileKey, name = spec.name, kind = spec.kind,
            dest = copyPoint(spec.dest), place = spec.place, road = spec.road, method = method, phase = 'scheduled',
            createdAt = clock, createdSeq = saveSeq, respawns = 0, stuck = 0, spotTries = 0}
        a.spawnInfo = {id = a.id}
        a.waitSec = (delay > 0 and delay or (tonumber(options.wait) or 5) * 60)
        local eta = M.ETA[method]
        local st = env.world.state()
        local far = st.position and ground(st.position, a.dest) > M.SIM_RADIUS
        if delay > 0 then
            a.tArrive = clock + delay
        elseif far then
            -- A trip to a distant spot with nobody to see it: the time it would take, bounded.
            local speed = method == 'car' and M.CAR_SPEED or M.RUN_SPEED
            a.tArrive = clock + math.min(300, math.max(eta, ground(st.position, a.dest) / speed))
        end
        a.tPrep = a.tArrive and math.max(clock, a.tArrive - eta - M.PREP_LEAD) or clock
        appts[#appts + 1] = a
        dirty = true
        log(tostring(a.name) .. ' will meet V (' .. a.kind .. ', ' .. method .. ', ' .. tostring(delay / 60) .. ' min, waits '
            .. tostring(a.waitSec / 60) .. ' min)')
        return a
    end

    -- The manager's Invite button and the Contacts J key (with the setting On). Returns nil when the old instant path applies.
    function C.requestInvite(key)
        if not C.enabled() then return nil end
        local definition = env.companions.definition(key)
        if not definition then return false, ui.t('That character model is unavailable.') end
        local profileKey = definition.profileKey or key
        for _, member in ipairs(env.companions.list()) do
            if member.state ~= 'leaving' and (member.profileKey or member.key) == profileKey then return nil end
        end
        local existing = byProfile(profileKey)
        if existing then return false, ui.t('{name} is already on the way.', {name = existing.name}) end
        local here, why = env.world.describe('here')
        if not here then return false, why or ui.t('Your position cannot be read yet.') end
        local a = create({key = key, profileKey = profileKey, name = definition.name, kind = 'here', dest = here.position,
            place = here.place, road = here.road})
        local when = settings().delay
        env.notify('on-the-way', (when and when > 0)
            and ui.t('{name} is on her way. About {minutes} minutes.', {name = a.name, minutes = when})
            or ui.t('{name} is on her way.', {name = a.name}))
        return true, '', 'meeting:' .. a.id
    end

    -- ---- offers and answers (phone Chat) -------------------------------------------------------------------------------------
    local function token()
        local out = {}
        for i = 1, 16 do out[i] = string.format('%x', math.floor((env.random and env.random() or math.random()) * 16) % 16) end
        return 'meet-' .. table.concat(out)
    end
    local function expireOffers()
        local now = wall()
        for key, offer in pairs(offers) do
            if now - offer.at > M.OFFER_TTL then offers[key] = nil end
        end
    end

    -- The offer for a phone message to this contact (bridge/meet-requests.mjs parseMeetOffer), or nil for none. The places are
    -- frozen here: an answer many seconds later still means the place V was at when the message was sent.
    function C.offer(profileKey, key)
        if not C.enabled() then return nil end
        local definition = env.companions.definition(key)
        if not definition then return nil end
        for _, member in ipairs(env.companions.list()) do
            if member.state ~= 'leaving' and (member.profileKey or member.key) == profileKey then
                return {version = 1, unavailable = 'already-here'}
            end
        end
        local existing = byProfile(profileKey)
        if existing then
            local cancelToken = token()
            offers[profileKey] = {token = cancelToken, at = wall(), cancelOnly = true}
            return {version = 1, unavailable = 'pending', place = clip(existing.place, 160), cancel = true, token = cancelToken}
        end
        local st = env.world.state()
        if st.held == 'combat' then return {version = 1, unavailable = 'combat'} end
        local here = env.world.describe('here')
        if not here then return {version = 1, unavailable = 'busy'} end
        local value = settings()
        local waypoint
        if value.waypoint ~= false and env.world.hasWaypoint() then waypoint = env.world.describe('waypoint') end
        local offerToken = token()
        local wait = (tonumber(value.delay) or 0) > 0 and tonumber(value.delay) or tonumber(value.wait) or 5
        offers[profileKey] = {token = offerToken, at = wall(), key = key, name = definition.name, here = here, waypoint = waypoint}
        local result = {version = 1, token = offerToken, kinds = {'here'}, here = {place = clip(here.place, 160) or ''},
            etaMinutes = tonumber(value.delay) or 0, waitMinutes = wait, cancel = false}
        if waypoint then
            result.kinds = {'here', 'waypoint'}
            result.waypoint = {place = clip(waypoint.place, 160) or ''}
        end
        return result
    end

    -- The bridge's answer: action = {kind = 'meet-here' | 'meet-waypoint' | 'cancel-meet', token}. True when it did something.
    function C.accept(profileKey, action)
        if not C.enabled() or type(action) ~= 'table' then return false, 'off' end
        expireOffers()
        local offer = offers[profileKey]
        if not offer or offer.token ~= action.token then return false, 'stale' end
        offers[profileKey] = nil
        if action.kind == 'cancel-meet' then return C.cancel(profileKey, 'never-mind') end
        if offer.cancelOnly then return false, 'not-offered' end
        local use = action.kind == 'meet-waypoint' and offer.waypoint or offer.here
        local kind = action.kind == 'meet-waypoint' and offer.waypoint and 'waypoint' or 'here'
        if not use then return false, 'no-place' end
        create({key = offer.key, profileKey = profileKey, name = offer.name, kind = kind, dest = use.position,
            place = use.place, road = use.road})
        return true
    end

    -- "Never mind" (a short in-character text and a light memory) or a quiet end.
    function C.cancel(profileKey, reason)
        local a = byProfile(profileKey)
        if not a then return false, 'none' end
        if reason == 'never-mind' then
            queueText(a, 'cancelled', 0)
            remember(profileKey, 'cancelled', a.place, 0)
            if a.serial then
                a.phase, a.leaveAt, a.silent = 'leaving', clock, true
                endJob(a)
                a.exitGoal = nil
                return true
            end
        end
        quiet(a, reason or 'cancelled')
        return true
    end

    function C.cancelAll(why)
        for index = #appts, 1, -1 do quiet(appts[index], why or 'off') end
        offers, texts = {}, {}
    end

    -- The feature was switched Off: nothing stays.
    function C.disable()
        C.cancelAll('off')
        ledger = {}
        acc, dirty = 0, false
    end

    -- ---- the steps -----------------------------------------------------------------------------------------------------------
    local function nearSpot(a, st)
        return st.position ~= nil and ground(st.position, a.dest) <= M.SIM_RADIUS
    end

    local function arriveVirtual(a)
        a.phase, a.body = 'waiting', 'virtual'
        a.waitLeft = a.waitSec
        a.arrivedAt = clock
        queueText(a, 'arrived', 0)
        dirty = true
        log(tostring(a.name) .. ' arrived (virtual)')
    end

    local function arrive(a)
        a.phase, a.body = 'waiting', 'visitor'
        a.waitLeft = a.waitLeft or a.waitSec
        a.arrivedAt = clock
        a.arrivedByCar = a.leg == 'driven'
        if env.companions.visitorHold then pcall(env.companions.visitorHold, a.serial) end
        queueText(a, 'arrived', 0)
        dirty = true
        log(tostring(a.name) .. ' arrived')
    end

    -- A body is created standing at the spot for a virtual companion whose V came back, or for the first time.
    local function startPreparing(a, standing)
        a.phase = 'preparing'
        a.standing = standing == true
        a.spot, a.go, a.job, a.spotTries, a.preparedAt, a.goneAt = nil, false, nil, 0, clock, nil
        a.serial, a.commandSent, a.meetFor = nil, false, 0
        a.spawnInfo = {id = a.id}
        dirty = true
    end

    local function fail(a, why)
        log(tostring(a.name) .. ' failed: ' .. tostring(why))
        if not a.silent then queueText(a, 'failed', 0) end
        endJob(a)
        removeBody(a, 'module')
        if env.world.release then pcall(env.world.release, a) end
        drop(a)
    end

    local function virtualize(a, reason)
        removeBody(a, reason or 'module')
        endJob(a)
        if a.phase == 'waiting' then
            a.body = 'virtual'
        else
            local speed = a.method == 'car' and M.CAR_SPEED or M.WALK_SPEED
            local st = env.world.state()
            local remain = a.tArrive and math.max(5, a.tArrive - clock)
                or math.min(120, a.spot and (a.spot.distance or 60) / speed or M.ETA[a.method])
            a.phase, a.tArrive = 'scheduled', clock + remain
            a.tPrep = a.tArrive
            a.spot, a.job, a.go = nil, nil, false
        end
        dirty = true
    end

    local function stoodUp(a)
        log(tostring(a.name) .. ' leaves: stood up')
        queueText(a, 'stood-up', a.waitSec)
        remember(a.profileKey, 'stood-up', a.place, a.waitSec)
        if a.serial then
            a.phase, a.leaveAt = 'leaving', clock
            a.exitGoal = nil
        else
            if env.world.release then pcall(env.world.release, a) end
            drop(a)
        end
    end

    local function meet(a, st)
        local ok, why = env.companions.joinVisitor(a.serial)
        if not ok then
            log(tostring(a.name) .. ' could not join: ' .. tostring(why))
            return
        end
        local serial = a.serial
        a.serial = nil
        log(tostring(a.name) .. ' met V and joined')
        local waited = clock - (a.arrivedAt or clock)
        if env.world.claim then pcall(env.world.claim, a, serial) end
        if env.greet then pcall(env.greet, {serial = serial, key = a.key, profileKey = a.profileKey, name = a.name, place = clip(a.place, 160) or '',
            waitedMinutes = minutes(waited)}) end
        ledger[a.profileKey] = nil
        drop(a)
    end

    -- The hidden spot and the readiness gate of a preparing appointment, then the spawn is watched for.
    local function stepPreparing(a, st)
        if not a.serial and st.position and ground(st.position, a.dest) > M.FAR_RADIUS then
            -- V went away (a fast travel) before her body existed: nothing is simulated for a spot nobody is near.
            endJob(a)
            a.spot, a.go, a.job = nil, false, nil
            a.phase = a.standing and 'waiting' or 'scheduled'
            if a.standing then a.body = 'virtual' end
            return
        end
        if not a.standing and not nearSpot(a, st) and a.spot == nil and a.job == nil then
            a.phase = 'scheduled'
            return
        end
        if not a.job then
            local accepted, message, id = env.queue.invite(a.key, {
                quiet = true,
                gate = function()
                    if a.dead then return nil, 'cancelled' end
                    return a.go == true
                end,
                appointment = a.spawnInfo})
            if not accepted then
                a.spotTries = a.spotTries + 1
                if a.spotTries >= 3 then fail(a, 'invitation refused: ' .. tostring(message)) end
                return
            end
            a.job = id
        end
        if not a.spot then
            if a.spotTries >= M.SPOT_TRIES then
                if a.method == 'car' then
                    a.method, a.spotTries = 'walk', 0
                    log(tostring(a.name) .. ': no road spot, walking')
                    return
                end
                return fail(a, 'no spot')
            end
            local mode = a.standing and 'standing' or a.close and 'close' or a.method
            local spot, reason, deferred = env.world.findSpot(a, mode)
            if deferred then return end
            if not spot then
                a.spotTries = a.spotTries + 1
                if a.method == 'car' and a.spotTries >= 2 then a.method, a.spotTries = 'walk', 0 end
                return
            end
            a.spot = spot
            a.leg = spot.leg or (a.method == 'car' and 'drive' or 'walk')
            a.goal = copyPoint(spot.goal or a.dest)
            -- The spawn happens when she has just enough time left to arrive on time.
            local travel = spot.eta or M.ETA[a.method]
            a.tGo = (a.tArrive and not a.standing) and (a.tArrive - travel) or clock
            a.spawnInfo.position = copyPoint(spot.position)
            a.spawnInfo.facing = spot.facing
        end
        a.go = clock >= (a.tGo or clock)
        for _, row in ipairs(env.companions.visitors()) do
            if row.appointmentId == a.id and (row.state == 'visiting' or row.state == 'spawning') then
                a.serial = row.serial
            end
        end
        if a.serial then
            local row = visitorRow(a)
            if row and row.state == 'visiting' then
                a.tripStart, a.bestD, a.bestAt = clock, nil, clock
                a.commandSent = false
                a.phase = 'en-route'
                if a.standing then
                    a.body, a.waitLeft = 'visitor', a.waitLeft
                    a.phase = 'waiting'
                    a.arrivedAt = a.arrivedAt or clock
                end
                dirty = true
            end
            return
        end
        if a.go and a.job and not a.goneAt then a.goneAt = clock end
        if a.goneAt and clock - a.goneAt > 30 then
            local listed = false
            for _, item in ipairs(env.queue.list()) do if item.id == a.job then listed = true end end
            if not listed then fail(a, 'her copy was not created') end
        end
    end

    local function stepEnRoute(a, st)
        local row = visitorRow(a)
        if not row or row.lost or row.state == 'failed' then
            if row and row.state == 'failed' then removeBody(a, 'module') end
            a.serial = nil
            if (a.respawns or 0) < M.MAX_RESPAWNS then
                a.respawns = (a.respawns or 0) + 1
                a.close = true
                startPreparing(a, false)
                return
            end
            return fail(a, 'her copy was lost')
        end
        if st.position and ground(st.position, a.dest) > M.FAR_RADIUS then return virtualize(a, 'module') end
        local feedback = env.companions.visitorSense(a.serial, M.STEP)
        local pos = feedback and feedback.position or row.position
        if not pos then return end
        local d = ground(pos, a.goal)
        if d <= M.ARRIVE_DISTANCE or (feedback and feedback.complete and d <= 8) then return arrive(a) end
        if env.world.carStep and a.leg == 'drive' then
            local handled = env.world.carStep(a, pos, feedback, M.STEP)
            if handled == 'arrived' then a.leg = 'walk'; a.commandSent = false; a.arrivedByCar = true
            elseif handled == 'failed' then a.leg = 'walk'; a.method = 'walk'; a.commandSent = false
            elseif handled then return end
        end
        if not a.bestD or d < a.bestD - 1 then a.bestD, a.bestAt = d, clock end
        local remaining = a.tArrive and (a.tArrive - clock) or nil
        local gait = (remaining and d / M.WALK_SPEED > remaining + 5) and 'Run' or 'Walk'
        local needCommand = not a.commandSent or (feedback and (feedback.failed or (not feedback.active and not feedback.complete)))
        if needCommand then
            if env.companions.visitorWalk(a.serial, a.goal, gait) then a.commandSent = true end
        end
        local cap = math.max(M.TRIP_CAP_MIN, 2 * (a.spot and a.spot.eta or M.ETA[a.method]))
        local stalled = clock - (a.bestAt or clock) > M.STUCK_WINDOW
        if stalled then
            a.stuck, a.bestAt, a.commandSent = (a.stuck or 0) + 1, clock, false
        end
        if (a.stuck or 0) >= 3 or clock - (a.tripStart or clock) > cap then
            if d <= 25 then return arrive(a) end
            removeBody(a, 'module')
            if (a.respawns or 0) < M.MAX_RESPAWNS then
                a.respawns = (a.respawns or 0) + 1
                a.stuck, a.close = 0, true
                log(tostring(a.name) .. ' was stuck; trying again close by')
                startPreparing(a, false)
            else
                -- No route works from anywhere: she shows up nearby and walks the last metres.
                a.close, a.nearOnly = true, true
                if a.respawns > M.MAX_RESPAWNS + 1 then return fail(a, 'no route') end
                a.respawns = a.respawns + 1
                startPreparing(a, false)
            end
        end
    end

    local function stepWaiting(a, st)
        local row = a.body == 'visitor' and visitorRow(a) or nil
        if a.body == 'visitor' and (not row or row.lost) then
            -- Her body is gone (streamed out, removed by the game): she keeps waiting without one.
            a.serial = nil
            a.body = 'virtual'
        end
        if a.body == 'visitor' then
            if st.position and ground(st.position, a.dest) > M.FAR_RADIUS then
                removeBody(a, 'module'); a.body = 'virtual'
            else
                local feedback = env.companions.visitorSense(a.serial, M.STEP)
                local pos = feedback and feedback.position or row.position
                if pos and st.position and ground(pos, st.position) <= M.MEET_RADIUS and math.abs((pos.z or 0) - (st.position.z or 0)) <= 3
                    and not st.held then
                    a.meetFor = (a.meetFor or 0) + M.STEP
                    if a.meetFor >= M.MEET_DWELL then return meet(a, st) end
                else a.meetFor = 0 end
            end
        elseif st.position and ground(st.position, a.dest) <= M.MATERIALIZE_RADIUS and not st.held then
            return startPreparing(a, true)
        end
        if not st.held then
            a.waitLeft = a.waitLeft - M.STEP
            if a.waitLeft <= 0 then return stoodUp(a) end
        end
    end

    local function stepLeaving(a, st)
        local row = visitorRow(a)
        if not row or row.lost then
            if env.world.release then pcall(env.world.release, a) end
            return drop(a)
        end
        local pos = row.position
        local far = st.position and pos and ground(pos, st.position) >= 50
        local out = pos and st.position and ground(pos, st.position) >= 8 and env.world.hidden(pos) == true
        if far or out or clock - (a.leaveAt or clock) > M.LEAVE_CAP then
            removeBody(a, 'module')
            if env.world.release then pcall(env.world.release, a) end
            return drop(a)
        end
        if not a.exitGoal then
            local spot = env.world.findSpot(a, 'exit')
            if spot then a.exitGoal = copyPoint(spot.goal or spot.position) end
        end
        if a.exitGoal and not a.exitSent then
            if env.companions.visitorWalk(a.serial, a.exitGoal, 'Walk') then a.exitSent = true end
        end
    end

    function C.step(st)
        for index = #appts, 1, -1 do
            local a = appts[index]
            if not a.dead then
                if a.phase == 'scheduled' then
                    if a.tArrive and clock >= a.tArrive then arriveVirtual(a)
                    elseif clock >= (a.tPrep or clock) and nearSpot(a, st) then startPreparing(a, false) end
                elseif a.phase == 'preparing' then stepPreparing(a, st)
                elseif a.phase == 'en-route' then stepEnRoute(a, st)
                elseif a.phase == 'waiting' then stepWaiting(a, st)
                elseif a.phase == 'leaving' then stepLeaving(a, st) end
            end
        end
    end

    -- A visitor's copy left without this module asking: V dismissed her, the game fast travelled, or she was lost.
    function C.visitorLost(serial, reason)
        for _, a in ipairs(appts) do
            if a.serial == serial then
                if reason == 'module' then return end
                a.serial = nil
                if reason == 'fast-travel' then
                    if a.phase == 'preparing' then a.phase = 'scheduled' end
                    if a.phase == 'en-route' then virtualize(a, 'module') else a.body = 'virtual'; endJob(a) end
                    return
                end
                -- Dismissed from the party list: V called it off.
                endJob(a)
                if env.world.release then pcall(env.world.release, a) end
                drop(a)
                return
            end
        end
    end

    function C.update(dt)
        acc = acc + (dt or 0)
        if acc < M.STEP then return end
        local step = acc
        acc = 0
        if not appts[1] and next(offers) == nil and not texts[1] and next(ledger) == nil then return end
        clock = clock + step
        if not appts[1] and next(offers) == nil and not texts[1] then return end
        expireOffers()
        local st = env.world.state()
        if not st.running then return end
        if appts[1] then C.step(st) end
        flushTexts(st.held)
        if dirty and clock - lastSave >= M.SAVE_PERIOD then C.save() end
    end

    -- ---- persistence ---------------------------------------------------------------------------------------------------------
    function C.snapshot()
        local list = {}
        for _, a in ipairs(appts) do
          if a.phase ~= 'leaving' then
            local remaining
            if a.tArrive then remaining = math.max(0, a.tArrive - clock) end
            local phase = a.phase == 'waiting' and 'waiting' or 'scheduled'
            if a.phase ~= 'waiting' and not remaining then remaining = math.min(M.ETA[a.method], 30) end
            if a.phase == 'en-route' or a.phase == 'preparing' then remaining = math.min(remaining or 30, 30) end
            list[#list + 1] = {key = a.key, profileKey = a.profileKey, name = a.name, kind = a.kind, dest = copyPoint(a.dest),
                place = a.place, method = a.method, phase = phase, remaining = remaining, waitSec = a.waitSec,
                waitLeft = a.phase == 'waiting' and a.waitLeft or nil, createdSeq = a.createdSeq}
          end
        end
        local notes = {}
        for profileKey, entry in pairs(ledger) do
            notes[#notes + 1] = {profileKey = profileKey, kind = entry.kind, place = entry.place, minutes = entry.minutes,
                age = clock - entry.at, delivered = entry.delivered}
        end
        return {version = 1, appointments = list, ledger = notes}
    end

    function C.restore(data)
        appts, offers, texts, ledger = {}, {}, {}, {}
        if type(data) ~= 'table' or data.version ~= 1 then return end
        for _, row in ipairs(type(data.appointments) == 'table' and data.appointments or {}) do
            -- A record from a later point of the same line than the loaded save never happened in this timeline.
            local future = saveSeq ~= nil and type(row.createdSeq) == 'number' and row.createdSeq > saveSeq
            if not future and type(row.key) == 'string' and type(row.profileKey) == 'string' and finitePoint(row.dest)
                and env.companions.definition(row.key) then
                nextId = nextId + 1
                local a = {id = nextId, key = row.key, profileKey = row.profileKey, name = tostring(row.name or row.key),
                    kind = row.kind == 'waypoint' and 'waypoint' or 'here', dest = copyPoint(row.dest), place = clip(row.place, 160) or '',
                    method = row.method == 'car' and 'car' or 'walk', createdAt = clock, createdSeq = row.createdSeq,
                    waitSec = tonumber(row.waitSec) or 300, respawns = 0, stuck = 0, spotTries = 0}
                a.spawnInfo = {id = a.id}
                if row.phase == 'waiting' then
                    a.phase, a.body = 'waiting', 'virtual'
                    a.waitLeft = tonumber(row.waitLeft) or a.waitSec
                    a.arrivedAt = clock
                else
                    a.phase = 'scheduled'
                    a.tArrive = clock + (tonumber(row.remaining) or 30)
                    a.tPrep = math.max(clock, a.tArrive - M.ETA[a.method] - M.PREP_LEAD)
                end
                appts[#appts + 1] = a
            end
        end
        for _, row in ipairs(type(data.ledger) == 'table' and data.ledger or {}) do
            if type(row.profileKey) == 'string' and (row.kind == 'stood-up' or row.kind == 'cancelled') then
                ledger[row.profileKey] = {kind = row.kind, place = clip(row.place, 120) or '', minutes = tonumber(row.minutes) or 0,
                    at = clock - (tonumber(row.age) or 0), delivered = tonumber(row.delivered) or 0}
            end
        end
    end

    -- The save line the appointments belong to (nil: no identity, nothing is kept across a load).
    function C.bind(key, sequence)
        if key == saveKey then saveSeq = sequence or saveSeq; return end
        if saveKey and dirty then C.save() end
        local old = appts
        for _, a in ipairs(old) do
            removeBody(a, 'module')
            a.dead = true
        end
        appts, offers, texts, ledger = {}, {}, {}, {}
        saveKey, saveSeq = key, sequence
        if key and env.persist then
            local ok, file = pcall(env.persist.load)
            local data = ok and type(file) == 'table' and type(file.saves) == 'table' and file.saves[key] or nil
            C.restore(data)
        end
        dirty = false
    end

    function C.save()
        lastSave, dirty = clock, false
        if not saveKey or not env.persist then return false end
        local ok, file = pcall(env.persist.load)
        if not ok or type(file) ~= 'table' then file = {} end
        file.version = 1
        file.saves = type(file.saves) == 'table' and file.saves or {}
        local snapshot = C.snapshot()
        if #snapshot.appointments == 0 and #snapshot.ledger == 0 then file.saves[saveKey] = nil else file.saves[saveKey] = snapshot end
        local written = pcall(env.persist.store, file)
        return written
    end

    -- ---- what the manager shows ----------------------------------------------------------------------------------------------
    function C.rows()
        local rows = {}
        for _, a in ipairs(appts) do
            rows[#rows + 1] = {id = 'meeting:' .. a.id, key = a.key, profileKey = a.profileKey, name = a.name,
                phase = a.phase, body = a.body, place = a.place, serial = a.serial}
        end
        return rows
    end
    function C.active() return appts[1] ~= nil end
    function C.cancelById(id)
        for _, a in ipairs(appts) do
            if 'meeting:' .. a.id == id then quiet(a, 'cancelled in the manager'); return true, '' end
        end
        return false
    end
    function C.appointment(profileKey) return byProfile(profileKey) end

    return C
end

return M
