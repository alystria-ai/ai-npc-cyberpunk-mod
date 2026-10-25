-- The game side of the housemates (docs/HOUSEMATES.md): finding the real seat behind a data seed, walking a body to it, playing the vanilla NPC
-- workspot on it, getting her out again, and the plain questions the controller asks of the world. Everything here is guarded and bounded;
-- nothing runs unless the controller (mod/housemates.lua) asks, and nothing runs per frame.
--
-- Reuses the seating code's native adapter (mod/companion-seating.lua `M.native`: surface and blocking rays, the device entity, the workspot
-- play and the fast exit) and its seat kinds; the components for beds, a chair to doze in, a counter and a sink are the new ones in
-- convai_gestures.archive (assets/gestures/gestures.json seatWorkspots).
local registry = dofile('housemate-registry.lua')
local M = {}

M.RAYS_PER_WINDOW = 36      -- rays one 0.1 s window may spend on finding seats (the seating search uses the same size)
M.SEARCH = 0.5              -- metres around a seed that are searched for the cushion
M.STEP = 0.125              -- metres between two samples of that search
M.WALK_TIMEOUT = 30
M.DEVICE_TIMEOUT = 4
M.ENTER_TIMEOUT = 7
M.EXIT_MIN = 1.4            -- seconds after the exit request before she may step off (the stand-up clip)
M.EXIT_MAX = 5

-- Which archive component plays which kind.
M.COMPONENT = {couch = 'couch', chair = 'chair', bar = 'bar', stool = 'stool', lean = 'lean', sink = 'sink', bed = 'bed'}
-- Where the root of the sit workspot is relative to the cushion's middle, along the facing (metres; the seating kinds' `back`).
M.BACK = {couch = 0.3, chair = 0.25, bar = 0.05, stool = 0.05}
M.BAND = {couch = {0.22, 0.7}, chair = {0.3, 0.75}, bar = {0.5, 1.0}, stool = {0.5, 1.0}}
M.APPROACH = {couch = 1, chair = 1, bar = -1, stool = -1}   -- which side she walks up from: in front (1) or behind (-1)
M.REACH = {1.05, 0.75, 1.35}

local function flat(a, b) return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2) end
local function rad(deg) return deg * math.pi / 180 end
local function forwardOf(yaw) return {x = -math.sin(rad(yaw)), y = math.cos(rad(yaw))} end
local atan2 = math.atan2 or math.atan
local function yawOf(f) return math.deg(atan2(-f.x, f.y)) end

function M.new(o)
    local W = {}
    local seating = o.seating or dofile('companion-seating.lua')
    local nat = seating.native
    local catalog = o.catalog or {}
    local companions = o.companions
    local prep = {}            -- spot id .. key -> search state
    local handles = {}
    local windowAt, spent = 0, 0
    local twinAt = {}
    local clock = o.clock or os.clock

    local function log(kind, fields) if o.log then pcall(o.log, kind, fields) end end
    local function player() return Game.GetPlayer() end

    local function spend(n)
        local now = clock()
        if now - windowAt >= 0.1 then windowAt, spent = now, 0 end
        if spent + n > M.RAYS_PER_WINDOW then return false end
        spent = spent + n
        return true
    end

    local function surface(x, y, floor) return nat.surface(x, y, floor + 1.3, floor - 0.25) end
    local function floorOk(p, z)
        local h = nat.surface(p.x, p.y, z + 0.6, z - 0.7, true)
        return h ~= nil and math.abs(h - z) <= 0.3
    end

    -- ---- preparing a spot --------------------------------------------------------------------------------------------------------------
    local function approachFor(kind, root, fwd, floor, r)
        local side = M.APPROACH[kind] or 1
        for _, reach in ipairs(M.REACH) do
            local p = {x = root.x + fwd.x * reach * side, y = root.y + fwd.y * reach * side, z = floor}
            if floorOk(p, floor) then
                local nav = nat.navPoint(p, player())
                if nav and math.abs(nav.z - floor) < 0.6 then return nav end
            end
        end
        return nil
    end

    local function seatSpot(spot, r)
        local kind = spot.kind
        local band, back = M.BAND[kind], M.BACK[kind]
        local floor = spot.z
        -- A measured spot (the recorder named V's root and the facing): only its cushion is checked.
        if spot.conf == 'M' and spot.yaw then
            if not spend(2) then return nil, nil, 'wait' end
            local fwd = forwardOf(spot.yaw)
            local h = surface(spot.x - fwd.x * back, spot.y - fwd.y * back, floor)
            if not h or h - floor < band[1] - 0.1 or h - floor > band[2] + 0.1 then return nil, 'no seat surface at the measured root' end
            local approach = approachFor(kind, spot, fwd, floor, r)
            if not approach then return nil, 'no way up to the seat' end
            return {kind = kind, x = spot.x, y = spot.y, z = floor, yaw = spot.yaw, approach = approach}
        end
        local key = tostring(spot.id) .. '|' .. tostring(r.key)
        local st = prep[key]
        if not st then
            st = {i = 0, cells = {}, n = 0}
            st.count = math.floor(M.SEARCH / M.STEP) * 2 + 1
            prep[key] = st
        end
        -- 1. The cushion: samples around the seed, a few per update.
        while st.i < st.count * st.count do
            if not spend(4) then return nil, nil, 'wait' end
            for _ = 1, 4 do
                if st.i >= st.count * st.count then break end
                local ix, iy = st.i % st.count, math.floor(st.i / st.count)
                st.i = st.i + 1
                local x = spot.x + (ix - (st.count - 1) / 2) * M.STEP
                local y = spot.y + (iy - (st.count - 1) / 2) * M.STEP
                local h = surface(x, y, floor)
                if h and h - floor >= band[1] and h - floor <= band[2] then
                    st.cells[#st.cells + 1] = {x = x, y = y, h = h}
                end
            end
        end
        local sx, sy, sh, n = 0, 0, 0, 0
        for _, cell in ipairs(st.cells) do
            if flat(cell, spot) <= 0.34 then sx, sy, sh, n = sx + cell.x, sy + cell.y, sh + cell.h, n + 1 end
        end
        if n < 4 then prep[key] = nil; return nil, 'no seat surface near the seed (' .. n .. ' cells)' end
        local c = {x = sx / n, y = sy / n}
        local seatH = sh / n
        -- 2. The facing: away from the backrest (a higher surface close behind the cushion). Eight rays.
        if not st.facing then
            if not spend(8) then return nil, nil, 'wait' end
            local best, bestScore = nil, 0
            for step = 0, 7 do
                local a = step * math.pi / 4
                local h = nat.surface(c.x + math.cos(a) * 0.45, c.y + math.sin(a) * 0.45, floor + 1.4, seatH + 0.12)
                local score = h and (h - seatH) or 0
                if score > bestScore then best, bestScore = a, score end
            end
            if best and bestScore > 0.15 then
                st.facing = yawOf({x = -math.cos(best), y = -math.sin(best)})
            elseif spot.yaw then st.facing = spot.yaw
            elseif spot.face then st.facing = yawOf({x = spot.face.x - c.x, y = spot.face.y - c.y})
            else
                local v = o.vpos and o.vpos() or nil
                st.facing = v and yawOf({x = v.x - c.x, y = v.y - c.y}) or 0
            end
        end
        local fwd = forwardOf(st.facing)
        local root = {x = c.x + fwd.x * back, y = c.y + fwd.y * back, z = floor}
        if not spend(6) then return nil, nil, 'wait' end
        local approach = approachFor(kind, root, fwd, floor, r)
        prep[key] = nil
        if not approach then return nil, 'no way up to the seat' end
        -- A stranger already there.
        local people = nat.people(player(), 6, {})
        for _, person in ipairs(people or {}) do
            if flat(person, root) < 0.5 then return nil, 'occupied' end
        end
        log('housemate-seat', {id = spot.id, kind = kind, seed = {spot.x, spot.y}, root = {root.x, root.y}, yaw = st.facing, cells = n})
        return {kind = kind, x = root.x, y = root.y, z = floor, yaw = st.facing, approach = approach}
    end

    local function bedSpot(spot, r)
        if not spend(6) then return nil, nil, 'wait' end
        local floor = spot.z
        local top = nat.surface(spot.x, spot.y, floor + 1.2, floor - 0.2)
        if not top or top - floor < 0.1 or top - floor > 1.0 then return nil, 'no bed under the slot' end
        -- The slot lies on the bed top: its neighbours across and along must be at the same height.
        local yaw = spot.yaw or 0
        local f = forwardOf(yaw)
        local lateral = {x = -f.y, y = f.x}
        for _, probe in ipairs({{lateral, 0.35}, {lateral, -0.35}, {f, 0.7}, {f, -0.7}}) do
            local h = nat.surface(spot.x + probe[1].x * probe[2], spot.y + probe[1].y * probe[2], floor + 1.2, floor - 0.2)
            if not h or math.abs(h - top) > 0.15 then return nil, 'the bed is too narrow at the slot' end
        end
        return {kind = 'bed', x = spot.x, y = spot.y, z = top, yaw = yaw, approach = nil, bed = true}
    end

    local function standSpot(spot, r)
        if not spend(3) then return nil, nil, 'wait' end
        local p = {x = spot.x, y = spot.y, z = spot.z}
        local nav = nat.navPoint(p, player())
        if not nav or math.abs(nav.z - spot.z) > 0.7 then return nil, 'no walkable ground' end
        local yaw = spot.yaw
        if not yaw and spot.face then yaw = yawOf({x = spot.face.x - nav.x, y = spot.face.y - nav.y}) end
        if not yaw then
            local v = o.vpos and o.vpos() or nil
            yaw = v and yawOf({x = v.x - nav.x, y = v.y - nav.y}) or 0
        end
        return {kind = spot.kind, x = nav.x, y = nav.y, z = nav.z, yaw = yaw}
    end

    -- A seed or a table spot -> a spot she can be placed on: snapped to the cushion with a facing and a way up, or nil, reason; nil, nil,
    -- 'wait' when the rays of this window are spent.
    function W.prepare(spot, r)
        local kind = spot.kind
        local ok, a, b, c
        if kind == 'bed' then ok, a, b, c = pcall(bedSpot, spot, r)
        elseif M.BAND[kind] then ok, a, b, c = pcall(seatSpot, spot, r)
        else ok, a, b, c = pcall(standSpot, spot, r) end
        if not ok then log('housemate-prepare-error', {id = spot.id, error = tostring(a):sub(1, 160)}); return nil, 'error' end
        if a then
            a.id, a.procedural = spot.id, spot.procedural
            a.component = (kind == 'chair' and r.sleep and 'chairsleep') or M.COMPONENT[kind]
        end
        return a, b, c
    end

    -- ---- procedural standing places ------------------------------------------------------------------------------------------------------
    local procState = {}
    function W.proc(apartment, r, used)
        local v = o.vpos and o.vpos() or nil
        if not v then return nil, 'wait' end
        local st = procState[r.key]
        if not st then
            st = {index = 0, base = registry.hash(r.key) % 12}
            procState[r.key] = st
        end
        local radii = {2.6, 4.0, 5.4, 6.8}
        for _ = 1, 3 do
            if not spend(4) then return nil, 'wait' end
            st.index = st.index + 1
            if st.index > #radii * 12 then procState[r.key] = nil; return nil, 'none' end
            local ring = math.floor((st.index - 1) / 12) + 1
            local bearing = (((st.index - 1) % 12) + st.base) % 12
            local a = bearing * math.pi / 6
            local p = {x = v.x + math.cos(a) * radii[ring], y = v.y + math.sin(a) * radii[ring], z = v.z}
            local nav = nat.navPoint(p, player())
            if nav and math.abs(nav.z - v.z) < 0.8 and flat(nav, v) >= 1.5 then
                local clear = true
                for _, other in ipairs(used or {}) do if flat(other, nav) < 1.2 then clear = false end end
                if clear and floorOk(nav, nav.z) then
                    procState[r.key] = nil
                    return {x = nav.x, y = nav.y, z = nav.z, id = 'proc:' .. r.key}
                end
            end
        end
        return nil, 'wait'
    end

    -- ---- bodies --------------------------------------------------------------------------------------------------------------------------
    W.bodies = {}
    function W.bodies.spawn(r, spot)
        local queue = o.queue and o.queue() or nil
        if not queue then return false, 'no party queue' end
        local at = spot.approach or spot
        local f = forwardOf(spot.yaw or 0)
        local ok, accepted, message = pcall(queue.invite, r.key, {quiet = true, resident = true,
            appointment = {id = 'hm:' .. r.key, position = {x = at.x, y = at.y, z = at.z}, facing = {x = f.x, y = f.y},
                owner = 'housemates', home = r.apt}})
        if not ok then return false, tostring(accepted) end
        if not accepted then return false, tostring(message) end
        return true
    end
    function W.bodies.rows() return companions.visitors() end
    function W.bodies.delete(serial)
        pcall(companions.dismissVisitor, serial, 'module')
    end
    function W.bodies.hide(serial, hidden)
        pcall(companions.residentVisible, serial, not hidden)
    end

    -- ---- seats: walk, play, leave -------------------------------------------------------------------------------------------------------
    local function orientationOf(yaw)
        local f = forwardOf(yaw)
        local ok, q = pcall(function() return Quaternion.BuildFromDirectionVector(Vector4.new(f.x, f.y, 0, 0)) end)
        return ok and q or nil
    end

    local function deleteDevice(h)
        if h.deviceId then pcall(nat.deleteDevice, h.deviceId); h.deviceId = nil end
    end

    local function npcOf(h) return companions.residentNpc(h.serial) end
    local function npcPos(npc)
        local ok, p = pcall(function() local q = npc:GetWorldPosition() return {x = q.x, y = q.y, z = q.z} end)
        return ok and p or nil
    end

    local function fail(h, why)
        h.phase, h.why = 'failed', why
        deleteDevice(h)
        log('housemate-occupy-failed', {serial = h.serial, spot = h.spot.id, why = why})
    end

    W.seats = {prepare = W.prepare}
    function W.seats.occupy(serial, spot, opts)
        local h = {serial = serial, spot = spot, sleep = opts and opts.sleep, phase = 'start', t0 = clock(), walks = 0}
        h.component = spot.component or M.COMPONENT[spot.kind]
        if h.sleep and spot.kind == 'chair' then h.component = 'chairsleep' end
        h.workspot = h.component ~= nil
        handles[h] = true
        return h
    end

    local function arrive(h, npc, target, within)
        local p = npcPos(npc)
        return p and flat(p, target) <= within, p
    end

    function W.seats.status(h)
        if h.phase == 'ready' or h.phase == 'released' or h.phase == 'failed' then
            return h.phase == 'failed' and 'failed' or h.phase
        end
        local now = clock()
        local npc = npcOf(h)
        if not npc then return h.phase == 'leaving' and 'released' or 'failed' end
        local spot = h.spot
        if h.phase == 'start' then
            local target = h.workspot and spot.approach or spot
            if not target then return 'failed' end
            h.target = {x = target.x, y = target.y, z = target.z}
            local near = arrive(h, npc, h.target, h.workspot and 0.7 or 0.6)
            h.phase = near and 'arrived' or 'walk'
            h.walkAt = now
        end
        if h.phase == 'walk' then
            local fb = companions.visitorSense(h.serial, 0.25)
            local near = arrive(h, npc, h.target, h.workspot and 0.7 or 0.6)
            if near then h.phase = 'arrived'
            elseif now - h.t0 > M.WALK_TIMEOUT then fail(h, 'walk timeout'); return 'failed'
            else
                -- (Re)issue the walk: at the start, and when the command ended short of the goal.
                if not h.sent or (fb and not fb.active and not fb.stalled and now - (h.walkAt or 0) > 1.5) then
                    h.walks = h.walks + 1
                    if h.walks > 4 then fail(h, 'the walk keeps ending short'); return 'failed' end
                    h.sent = companions.visitorWalk(h.serial, h.target, 'Walk') == true
                    h.walkAt = now
                end
                return 'busy'
            end
        end
        if h.phase == 'arrived' then
            if not h.workspot then
                -- Standing: turn her and hold.
                companions.visitorFace(h.serial, h.target, spot.yaw or 0)
                companions.visitorHold(h.serial)
                h.phase = 'ready'
                return 'ready'
            end
            local template = catalog.device
            local components = catalog.seatComponents or {}
            if not template or not components[h.component] then fail(h, 'component missing from the installed archive'); return 'failed' end
            local orientation = orientationOf(spot.yaw or 0)
            if not orientation then fail(h, 'orientation'); return 'failed' end
            local z = spot.z
            local ok, id = nat.spawnDevice({x = spot.x, y = spot.y, z = z}, orientation, template)
            if not ok then fail(h, 'device: ' .. tostring(id)); return 'failed' end
            h.deviceId, h.phase, h.deviceAt = id, 'device', now
        end
        if h.phase == 'device' then
            local device = nat.deviceEntity(h.deviceId)
            if device == false then fail(h, 'device lost'); return 'failed' end
            if device == nil or device == true then
                if now - h.deviceAt > M.DEVICE_TIMEOUT then fail(h, 'device timeout'); return 'failed' end
                return 'busy'
            end
            if not nat.hasComponent(device, catalog.seatComponents[h.component]) then fail(h, 'the archive has no ' .. h.component); return 'failed' end
            local p = npcPos(npc)
            local d = p and flat(p, spot) or 0
            local slide = math.min(1.4, 0.5 + math.max(0, d - 0.75) * 0.35)
            if h.sleep and spot.bed then slide = 1.2 end
            local ok, err = nat.play(device, npc, catalog.seatComponents[h.component], slide)
            if not ok then fail(h, 'play: ' .. tostring(err)); return 'failed' end
            h.phase, h.enterAt = 'enter', now
            return 'busy'
        end
        if h.phase == 'enter' then
            local inside = nat.inWorkspot(npc) == true
            if inside then
                h.inSince = h.inSince or now
                if now - h.inSince >= 0.5 then h.phase = 'ready'; return 'ready' end
            else h.inSince = nil end
            if now - h.enterAt > M.ENTER_TIMEOUT then fail(h, 'she did not enter the workspot'); return 'failed' end
            return 'busy'
        end
        if h.phase == 'leaving' then
            local p = npcPos(npc)
            local busy = nat.workspotBusy(npc)
            if busy then h.freeSince = nil elseif not h.freeSince then h.freeSince = now end
            local waited = now - h.leaveAt
            if (h.freeSince and now - h.freeSince >= 0.2 and waited >= M.EXIT_MIN) or waited >= M.EXIT_MAX then
                local approach = spot.approach
                if approach and not h.stepped then
                    h.stepped = companions.visitorStep(h.serial, approach) == true
                    h.stepAt = now
                end
                if not approach or (p and flat(p, approach) < 0.5) or now - (h.stepAt or now) > 2.5 then
                    deleteDevice(h)
                    h.phase = 'released'
                    return 'released'
                end
            end
            return 'busy'
        end
        return h.phase == 'released' and 'released' or 'busy'
    end

    function W.seats.release(h, instant)
        if not h then return end
        if h.phase == 'released' or h.phase == 'failed' then deleteDevice(h); return end
        local npc = npcOf(h)
        if h.workspot and npc and (h.phase == 'ready' or h.phase == 'enter') then
            pcall(nat.exit, npc, instant == true)
            h.phase, h.leaveAt = 'leaving', clock()
            if instant then deleteDevice(h); h.phase = 'released' end
            return
        end
        deleteDevice(h)
        h.phase = 'released'
        handles[h] = nil
    end

    -- ---- the world --------------------------------------------------------------------------------------------------------------------
    -- A game-placed copy of this character within 25 m of V (the real Judy standing in the scene): asked at most every 10 s.
    function W.twin(r)
        local now = clock()
        if twinAt[r.key] and now - twinAt[r.key].at < 10 then return twinAt[r.key].value end
        local value = false
        local ok, err = pcall(function()
            local def = companions.definition(r.key)
            local record = def and def.id
            if not record then return end
            local query = TargetSearchQuery.new()
            query.searchFilter = Game['TSF_NPC;']()
            query.maxDistance = 25
            query.includeSecondaryTargets = false
            query.filterObjectByDistance = true
            query.ignoreInstigator = true
            local _, parts = Game.GetTargetingSystem():GetTargetParts(player(), query)
            local system = Game.GetDynamicEntitySystem()
            for _, part in ipairs(parts or {}) do
                local component = TS_TargetPartInfo.GetComponent(part)
                local entity = component and component:GetEntity()
                if entity and tostring(entity:GetRecordID()) == tostring(TweakDBID.new(record)) and not system:IsManaged(entity:GetEntityID()) then
                    value = true; break
                end
            end
        end)
        if not ok then log('housemate-twin-error', {error = tostring(err):sub(1, 120)}) end
        twinAt[r.key] = {at = now, value = value}
        return value
    end

    -- Her body type from the gesture catalogue (curated characters only): 'woman_base', 'man_big', ... or nil.
    function W.rig(r)
        local def = companions.definition(r.key)
        local entry = def and catalog.characters and catalog.characters[def.id]
        if not (entry and entry.rig) then return nil end
        return (tostring(entry.rig):lower():gsub('[^a-z0-9]', ''))
    end

    function W.abandon()
        for h in pairs(handles) do deleteDevice(h) end
        handles, prep, procState, twinAt = {}, {}, {}, {}
    end

    return W
end

return M
