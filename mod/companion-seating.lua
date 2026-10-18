-- Companions sit with V (docs/COMPANION_SEATING.md). When V sits down on a
-- couch, bench, chair or bar stool, each nearby companion walks to a free seat
-- beside V on the same furniture (or the next stool/chair along it), sits with
-- the vanilla NPC sit workspot of that seat type, and stands up with the native
-- fast exit when V gets up, moves away, or a fight starts.
--
-- Cost: V's workspot state is read at most four times a second (one native
-- call while V stands). Seats are searched once per sit, with a bounded number
-- of raycasts spread over two updates. Nothing here runs per frame or touches
-- files. Vehicles are excluded (companion-vehicles.lua owns them).
local workspot = dofile('gesture-workspot.lua')
local M = {}
M.TAG = 'CyberpunkConvaiSeatDevice'

M.policy = {
    checkEvery = .25,      -- V's workspot state, at most 4 Hz
    settleAfter = .9,      -- V seated this long (entry animation done) before a search
    searchRadius = 8,      -- companions farther from V stay standing (live run 21:14Z: Judy stuck 7.1 m away)
    leaveDistance = 1.0,   -- V's root this far from the seat anchor: V left the seat
    minOffset = .45,       -- seat samples along the furniture, beside V
    ownOffset = .15,       -- the first sample: still on V's own seat, so the run through it IS V's seat (findSeats)
    sampleStep = .1,
    approachTimeout = 12,
    arriveDistance = .55,
    settlePsm = .5,        -- V's PSM IsInWorkspot = 1 this long: seated (it is 0 while V sits down and gets up)
    notOursAfter = 1.5,    -- the actuator never took the seat walk this long: treat it as refused
    deviceTimeout = 5,
    enterTimeout = 4,
    exitPatience = 3,
    exitGiveUp = 6,
    occupiedRadius = .45,
    slideTime = .5,
    wallHeight = .9,       -- the line from V's seat to a neighbour seat at this height must be clear
    floorBand = {-.3, .25},-- the walk-up point must be floor (not a table or a drop)
    approachReach = {.75, 1.05, 1.35}, -- walk-up distances from the seat root
    approachAngles = {0, 30, -30, 55, -55}, -- degrees off straight in front (or behind) of the seat
    keepOut = .95,         -- the actuator refuses goals within 0.9 m of V
    approachTries = 5,     -- walk-up points tried before sliding in
    settleTimeout = 1.2,   -- the walk's move command retires to a hold before the workspot plays
    routeGrace = .6,       -- a walk refused this long: try the next walk-up point
    slideNear = 1.2,       -- slides longer than this wait for V to look away
    refusedSlide = 2.5,    -- a refused walk this close to the seat: the short slide, no more walks
    precheckPerUpdate = 3, -- walk-up points checked per update before she starts walking
    precheckUpdates = 6,
    fallbackBelow = 3,     -- fewer good points than this: walk-up points that only failed the room check join as fallbacks
    closeTimeout = 12,     -- (kept for the half-way slide reach below)
    -- Live run 2026-10-08 21:02Z: in the movement dead zone by the couch every
    -- walk and every follow route was refused, and she gave up. Placement out
    -- of view (the lift's pattern): when closing in stalls, she is put on the
    -- best walk-up point the moment V's camera is off her and the spot.
    closeStall = 3,        -- closing in without closeProgress for this long: place her
    closeProgress = .3,
    -- Live run 21:10Z: 8.7 m out, every walk-up point refused at the path stage
    -- and she never moved: five tries and a 3 s stall took 19 s. A refusal
    -- that leaves her where she stood is repeated by every other point: close
    -- in for stuckStall instead, then place her out of view.
    stuckMove = .5,        -- moved less than this since the walk began: the refusal left her where she was
    closeStallStuck = 1.5, -- the closing-in stall after such a refusal (closeStall otherwise)
    reseatAfter = 20,      -- she left the workspot on her own after at least this long seated: sit again
    lookEvery = .5,        -- the "is V looking" check, only while placement waits
    viewCone = 50,         -- degrees off the camera: she is out of view
    -- Live run 21:09Z: the walk-up spot beside V is almost always inside V's
    -- seated view, so "her and the spot out of view" never cleared. She is
    -- placed only while she herself is out of view; a walk-up spot that is out
    -- of view too is preferred, and after placeBothFor seconds the nearest
    -- spot is used even if V can see it.
    placeBothFor = 3,
    placeCandidates = 4,
    placeLongWait = 10,    -- V looking this long: the short slide when within slideReach
    lineHeights = {.5, 1.2}, -- a straight line from her to the walk-up point at these heights
    slideReach = 3.0,      -- out of walk-up points this close to the seat: slide in
    blendWait = 3,         -- a long slide waits this long for V to look away
    lookCone = 40,         -- degrees: V looking at her
    slideMax = 1.4,
    -- Standing up (live run 2026-10-08 20:24Z): the fast exit leaves the root
    -- at the seat root, against the furniture, where every follow route is
    -- refused. She steps out to floor in front before following resumes.
    standReach = 1.6,      -- her own arrival spot is reused when this close to the seat
    standDeadline = 2.5,   -- the straight step out; then a teleport to the same spot
    standSettle = .8,      -- after a teleport, before the floor check
    standArrive = .3,
    -- Live run 2026-10-08 20:54Z: IsActorInWorkspot turns false as the fast
    -- exit starts, and the step out walked her during the stand-up clip; her
    -- shins twisted at the next turn and every follow route from the spot she
    -- reached was refused. Now the step waits for the workspot to be fully
    -- released and picks the most open stand spot.
    exitSettle = 1.4,      -- at least this long after the exit request
    exitQuiet = .2,        -- and no workspot activity for this long
    exitWait = 5,          -- then step out anyway
    standEvalPerUpdate = 2,-- stand spots judged per update while she stands up
    standEvalMax = 5,
    openReach = 1.2,       -- openness: clear lines this long at the line heights
    failureCooldown = 30,
}

-- Seat types. band: seat surface height above V's feet; tolerance: allowed
-- difference from V's own seat surface; pitch: centre spacing; width: half
-- width that must be seat surface (continuous) or the run limits (discrete);
-- approach: walk-up side (1 = in front of the seat, -1 = behind it).
M.kinds = {
    couch = {component = 'couch', band = {.22, .7}, tolerance = .07, pitch = .66, width = .18, continuous = true,
        approach = 1, back = .3, span = 2.1},
    bench = {component = 'chair', band = {.25, .7}, tolerance = .07, pitch = .66, width = .15, continuous = true,
        approach = 1, back = .25, span = 2.1},
    chair = {component = 'chair', band = {.3, .75}, tolerance = .1, pitch = .7, width = .08, continuous = false,
        approach = 1, back = .25, span = 1.8},
    table = {component = 'chair', band = {.3, .75}, tolerance = .1, pitch = .7, width = .08, continuous = false,
        approach = -1, back = .25, span = 1.8},
    bar = {component = 'bar', band = {.5, 1.0}, tolerance = .12, pitch = .65, width = .06, continuous = false,
        approach = -1, back = .05, span = 2.0},
    stool = {component = 'stool', band = {.5, 1.0}, tolerance = .12, pitch = .65, width = .06, continuous = false,
        approach = -1, back = .05, span = 1.6},
}

local HOLDING = {entering = true, seated = true, exiting = true, leaving = true, standing = true, placing = true}

local function flat(a, b) return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2) end
local function copy(p) return p and {x = p.x, y = p.y, z = p.z} end

-- What V sits on, from its workspot resource path and animation names. Nil
-- for anything that is not an ordinary seat (vehicles, the ground, beds,
-- lying down) and for workspots that are not sitting at all.
function M.classify(path, anim)
    local text = (tostring(path or '') .. ' ' .. tostring(anim or '')):lower()
    if not text:find('sit', 1, true) then return nil end
    for _, word in ipairs({'\\car\\', '_car_', '_car__', 'sit_car', 'vehicle', 'sit_av', '_av_', 'bike', 'motorcycle',
        'sit_ground', 'curb', 'cliff', 'sit_rail', 'sit_bed', 'wheelchair', 'stairs', 'sit_table', 'lie_', 'netrunner',
        'tattoo', 'panzer', 'beach', 'hood'}) do
        if text:find(word, 1, true) then return nil end
    end
    if text:find('couch', 1, true) or text:find('sofa', 1, true) then return 'couch' end
    if text:find('barstool_bar', 1, true) or text:find('sit_bar_', 1, true) or text:find('sit_bar__', 1, true) then return 'bar' end
    if text:find('barstool', 1, true) or text:find('stool', 1, true) then return 'stool' end
    if text:find('bench', 1, true) then return 'bench' end
    if text:find('chair_table', 1, true) then return 'table' end
    if text:find('chair', 1, true) then return 'chair' end
    return nil
end

-- Seat centres beside V from a lateral surface profile. samples[side] is an
-- ascending list of {offset, h} (h = highest hit above V's feet or nil);
-- side is 1 (V's right) or -1 (V's left). h0 is V's own seat surface.
-- Returns {{offset = signed metres along V's right axis, height = h}} nearest first.
function M.findSeats(samples, kind, h0, policy)
    policy = policy or M.policy
    local seats = {}
    local function valid(h)
        if not h or h < kind.band[1] or h > kind.band[2] then return false end
        return not h0 or math.abs(h - h0) <= kind.tolerance
    end
    for _, side in ipairs({1, -1}) do
        local list, runs, run = samples[side] or {}, {}, nil
        for _, sample in ipairs(list) do
            if valid(sample.h) then
                if run and sample.offset - run.b <= policy.sampleStep * 1.5 then
                    run.b, run.n, run.sum = sample.offset, run.n + 1, run.sum + sample.h
                else
                    run = {a = sample.offset, b = sample.offset, n = 1, sum = sample.h}
                    runs[#runs + 1] = run
                end
            else run = nil end
        end
        local placed = {}
        local function add(offset, height)
            for _, other in ipairs(placed) do if math.abs(other - offset) < kind.pitch * .85 then return end end
            if offset < kind.pitch * .85 then return end
            placed[#placed + 1] = offset
            seats[#seats + 1] = {offset = offset * side, height = height}
        end
        -- V's own seat. A sample under V's own seat (ownOffset, nearer than minOffset) that is seat surface makes the run
        -- through it V's seat itself: its far edge is never a seat, whatever its length, and a neighbour that starts after
        -- a gap, even one only 0.4 m from V, is a separate seat. Without near samples (or with none on V's seat) a run
        -- starting within minOffset is judged by its length (a touching run counts from 0.3 m).
        local first = list[1]
        local ownKnown = first and first.offset < policy.minOffset - 1e-6 and valid(first.h)
        for _, r in ipairs(runs) do
            local own = ownKnown and r.a <= first.offset + 1e-6
            local touching = own or (not ownKnown and r.a <= policy.minOffset + policy.sampleStep * .5)
            local height = r.sum / r.n
            if kind.continuous or (touching and r.b - r.a >= kind.pitch) then
                -- One surface (couch, bench, a long seat at the bar): seats at
                -- the pitch, each with its half width on the surface.
                local c = touching and kind.pitch or math.max(r.a + kind.width, kind.pitch)
                while c <= r.b - kind.width + 1e-6 do
                    add(c, height)
                    c = c + kind.pitch
                end
            elseif own then
                -- V's own seat (or its armrest) and nothing beyond it: no seat here.
            elseif r.b - r.a >= (touching and .3 or kind.width * 2) - 1e-6 and r.b - r.a <= .9 then
                -- A separate stool or chair. A run that starts within minOffset of V used to be dropped here (it was taken for
                -- V's own seat or one long surface), so a neighbour whose near edge is under 0.5 m from V (centres up to about
                -- 0.7 m apart) was never found; now V's own seat is identified from the sample under it, and without that a
                -- touching run counts as a seat once it is a seat's width long (0.3 m), which V's own seat edge or an armrest
                -- never is.
                add((r.a + r.b) / 2, height)
            end
        end
    end
    table.sort(seats, function(a, b) return math.abs(a.offset) < math.abs(b.offset) end)
    return seats
end

-- World points for a seat: its root (where the workspot plays, on V's floor
-- level, facing V's way) and the walk-up point in front of or behind it.
function M.seatPoints(anchor, forward, seat, kind, reach)
    local rx, ry = forward.y, -forward.x
    local root = {x = anchor.x + rx * seat.offset, y = anchor.y + ry * seat.offset, z = anchor.z}
    reach = (reach or M.policy.approachReach[1]) * kind.approach
    local approach = {x = root.x + forward.x * reach, y = root.y + forward.y * reach, z = anchor.z}
    return root, approach
end

-- What V sits on, from the furniture around V's settled root, when the
-- workspot has no readable instance (V's apartment couch is a scene, October 8:
-- GetWorkspotInstance nil, scene tier 3-4). surface(back, lateral) returns the
-- highest hit above V's feet at a point behind (+) or in front (-) of V and to
-- V's right (+). Returns the kind (or nil) and the measured values.
function M.classifyGeometry(surface)
    local found = {}
    for _, back in ipairs({.3, .15, .05}) do
        local h = surface(back, 0)
        if h and h >= .25 and h <= 1.0 then found.h0, found.back = h, back; break end
    end
    local h0 = found.h0
    if not h0 then return nil, found end
    if h0 > .62 then
        local front = surface(-.4, 0)
        found.front = front
        return (front and front >= .9 and front <= 1.3) and 'bar' or 'stool', found
    end
    local sides = 0
    for _, lateral in ipairs({.5, -.5}) do
        local h = surface(found.back, lateral)
        if h and math.abs(h - h0) <= .07 then sides = sides + 1 end
    end
    local backrest, front = surface(found.back + .45, 0), surface(-.45, 0)
    found.sides, found.backrest, found.front = sides, backrest, front
    -- A backrest 0.12 m or more above the cushion makes it a couch (V's
    -- apartment couch: 0.63 over 0.44, October 8); level or floor behind: a bench.
    if sides > 0 then return (backrest and backrest >= h0 + .12) and 'couch' or 'bench', found end
    if front and front >= h0 + .15 and front <= 1.0 then return 'table', found end
    return 'chair', found
end

-- Walk-up points for a seat: around its approach side at several distances
-- and angles, outside V's keep-out, nearest to the companion first.
function M.approachPoints(root, forward, kind, anchor, from, policy)
    policy = policy or M.policy
    local list = {}
    for _, reach in ipairs(policy.approachReach) do
        for _, degrees in ipairs(policy.approachAngles) do
            local a = math.rad(degrees)
            local fx, fy = forward.x * kind.approach, forward.y * kind.approach
            local dx, dy = fx * math.cos(a) - fy * math.sin(a), fx * math.sin(a) + fy * math.cos(a)
            local point = {x = root.x + dx * reach, y = root.y + dy * reach, z = anchor.z}
            if flat(point, anchor) >= policy.keepOut then
                point.score = (from and flat(point, from) or 0) + reach + .004 * math.abs(degrees)
                list[#list + 1] = point
            end
        end
    end
    table.sort(list, function(a, b) return a.score < b.score end)
    return list
end

-- Native layer ---------------------------------------------------------------
local native = {}
M.native = native
local function none() return CName.new('None') end
local function vector(p) return Vector4.new(p.x, p.y, p.z, 1) end

function native.playerSeat(player, detail)
    local ws = Game.GetWorkspotSystem()
    local inside = ws:IsActorInWorkspot(player) == true
    local out = {inside = inside}
    pcall(function() out.combat = player:IsInCombat() == true end)
    if not inside then return out end
    local p, f = player:GetWorldPosition(), player:GetWorldForward()
    out.position, out.forward = {x = p.x, y = p.y, z = p.z}, {x = f.x, y = f.y}
    pcall(function()
        local info = ws:GetExtendedInfo(player)
        out.entering, out.exiting = info.entering == true, info.exiting == true
    end)
    pcall(function()
        local defs = Game.GetAllBlackboardDefs().PlayerStateMachine
        out.psmWorkspot = player:GetPlayerStateMachineBlackboard():GetInt(defs.IsInWorkspot)
    end)
    if detail then
        out.orientation = player:GetWorldOrientation()
        pcall(function() out.mounted = Game.GetMountingFacility():IsMountedToAnything(player:GetEntityID()) == true end)
        pcall(function()
            local instance = ws:GetWorkspotInstance(player:GetEntityID())
            if not instance then return end
            pcall(function() out.anim = NameToString(instance.idleAnim) .. ' ' .. NameToString(instance.animName) end)
            pcall(function() out.path = ResRef.ToString(instance.resource.path) end)
            if not out.path or out.path == '' then pcall(function() out.path = tostring(instance.resource.path) end) end
        end)
    end
    return out
end

-- Furniture is Static or Dynamic collision; some interior floors are Dynamic
-- (October 8 probe) and outdoor floors are Terrain.
local surfaceGroups = {'Static', 'Dynamic'}
local floorGroups = {'Static', 'Dynamic', 'Terrain'}
function native.surface(x, y, top, bottom, floor)
    local spatial, best = Game.GetSpatialQueriesSystem(), nil
    for _, group in ipairs(floor and floorGroups or surfaceGroups) do
        local hit, trace = spatial:SyncRaycastByCollisionGroup(Vector4.new(x, y, top, 1), Vector4.new(x, y, bottom, 1),
            CName.new(group), false, false)
        if hit == true and trace and trace.position and (not best or trace.position.z > best) then best = trace.position.z end
    end
    return best
end

function native.blocked(from, to)
    local spatial = Game.GetSpatialQueriesSystem()
    for _, group in ipairs(surfaceGroups) do
        local hit = spatial:SyncRaycastByCollisionGroup(vector(from), vector(to), CName.new(group), false, false)
        if hit ~= false then return true end -- nil is not proof of a clear line
    end
    return false
end

-- Other people near V (never our own companions).
function native.people(player, radius, exclude)
    local query = TargetSearchQuery.new()
    query.searchFilter = Game['TSF_NPC;']()
    query.maxDistance = radius
    query.includeSecondaryTargets = false
    query.filterObjectByDistance = true
    query.ignoreInstigator = true
    local _, parts = Game.GetTargetingSystem():GetTargetParts(player, query)
    local seen, list = {}, {}
    for _, part in ipairs(parts or {}) do
        local component = TS_TargetPartInfo.GetComponent(part)
        local entity = component and component:GetEntity()
        if entity then
            local id = tostring(entity:GetEntityID().hash)
            if not seen[id] and not exclude[id] then
                seen[id] = true
                local p = entity:GetWorldPosition()
                list[#list + 1] = {x = p.x, y = p.y, z = p.z}
            end
        end
    end
    return list
end

function native.spawnDevice(position, orientation, template)
    return pcall(function()
        local spec = NewObject('DynamicEntitySpec')
        if not pcall(function() spec.templatePath = template end) then spec.templatePath = ResRef.FromString(template) end
        spec.position = Vector4.new(position.x, position.y, position.z, 1)
        spec.orientation = orientation
        spec.persistState, spec.persistSpawn = false, false
        spec.alwaysSpawned, spec.spawnInView, spec.active = true, true, true
        spec.tags = {CName.new(M.TAG)}
        local id = Game.GetDynamicEntitySystem():CreateEntity(spec)
        if not id or tostring(id.hash):match('^0+[uUlL]*$') then error('Seat device entity was not created') end
        return id
    end)
end
native.deviceEntity = workspot.deviceEntity
-- An archive from before seating has the device without sit components: never
-- play a component the device does not carry. Unknown (no lookup) counts as present.
function native.hasComponent(device, component)
    local ok, found = pcall(function() return device:FindComponentByName(CName.new(component)) end)
    if not ok then return true end
    return found ~= nil
end
function native.deleteDevice(id)
    return pcall(function()
        local system = Game.GetDynamicEntitySystem()
        if system:IsManaged(id) and system:IsTagged(id, CName.new(M.TAG)) then system:DeleteEntity(id) end
    end)
end
function native.sweep()
    return pcall(function()
        local system = Game.GetDynamicEntitySystem()
        for _, id in ipairs(system:GetTaggedIDs(CName.new(M.TAG)) or {}) do system:DeleteEntity(id) end
    end)
end
-- The NPC slides to the start of the entry animation the workspot picks for
-- its approach (gameWorkspotSlidingBehaviour.PlayAtResourcePosition).
function native.play(device, npc, component, slideTime)
    local sliding
    pcall(function() sliding = Enum.new('gameWorkspotSlidingBehaviour', 'PlayAtResourcePosition') end)
    return pcall(function()
        return Game.GetWorkspotSystem():PlayInDevice(device, npc, none(), CName.new(component), none(), none(),
            slideTime, sliding or 1, nil)
    end)
end
native.inWorkspot = workspot.inWorkspot
native.exit = workspot.exit -- native fast exit only; never StopNpcInWorkspot
native.stopInDevice = workspot.stopInDevice
function native.lookingAt(player, point, cone)
    local ok, looking = pcall(function()
        local okView, _, view = pcall(function() return Game.GetTargetingSystem():GetCrosshairData(player) end)
        local f = okView and view or player:GetWorldForward()
        local at = player:GetWorldPosition()
        local bx, by = point.x - at.x, point.y - at.y
        local fl, bl = math.sqrt(f.x * f.x + f.y * f.y), math.sqrt(bx * bx + by * by)
        if fl < 1e-3 or bl < 1e-3 then return true end
        local cos = (f.x * bx + f.y * by) / (fl * bl)
        return cos >= math.cos(math.rad(cone))
    end)
    return not ok or looking == true -- unknown counts as looking
end
-- Leaving a seat: a short straight walk (the actuator's boarding leg, no
-- navigation) or an AI teleport, both owned by the companion's motor so the
-- next follow decision retires them.
function native.stepOut(entry, spot)
    actuator = actuator or dofile('companion-actuator.lua')
    if not entry.motor then return false end
    return actuator.board(entry.motor, spot, {gait = 'Walk'})
end
function native.teleport(entry, spot, yaw, reason)
    actuator = actuator or dofile('companion-actuator.lua')
    if not entry.motor then return false end
    return actuator.teleport(entry.motor, spot, yaw, reason)
end
local clearanceModule
function native.bodyClear(spot, shape)
    clearanceModule = clearanceModule or dofile('companion-clearance.lua')
    local clear = clearanceModule.body(spot, shape)
    return clear == true
end
-- The actuator projects every move goal onto the navmesh this way and refuses
-- one that moves more than 0.8 m or 1.2 m in height (companion-actuator.lua).
function native.navPoint(point, npc)
    local ok, found = pcall(function()
        return Game.GetAINavigationSystem():FindPointInSphereForCharacter(Vector4.new(point.x, point.y, point.z, 1), .55, npc)
    end)
    if not ok or not found or found.status ~= Enum.new('worldNavigationRequestStatus', 'OK') then return nil end
    local p = found.point
    if math.sqrt((p.x - point.x) ^ 2 + (p.y - point.y) ^ 2) >= .8 or math.abs(p.z - point.z) >= 1.2 then return nil end
    return {x = p.x, y = p.y, z = p.z}
end
function native.lineClear(from, to, heights)
    for _, h in ipairs(heights) do
        if native.blocked({x = from.x, y = from.y, z = from.z + h}, {x = to.x, y = to.y, z = to.z + h}) then return false end
    end
    return true
end
-- Any workspot activity left on the NPC: the workspot itself, its extended
-- state (entering, exiting, in motion) or the puppet's workspot/slot animation.
function native.workspotBusy(npc)
    local busy = false
    pcall(function() busy = Game.GetWorkspotSystem():IsActorInWorkspot(npc) == true end)
    if busy then return true end
    pcall(function()
        local info = Game.GetWorkspotSystem():GetExtendedInfo(npc)
        busy = info.isActive == true or info.exiting == true or info.entering == true or info.inMotion == true
    end)
    if busy then return true end
    pcall(function()
        local defs, board = Game.GetAllBlackboardDefs().PuppetState, npc:GetPuppetStateBlackboard()
        busy = board:GetBool(defs.WorkspotAnimationInProgress) == true or board:GetBool(defs.SlotAnimationInProgress) == true
    end)
    return busy
end
-- How open a stand spot is: clear straight lines toward V and to three sides.
function native.openness(spot, toward, forward, reach, heights)
    local dirs = {}
    local tx, ty = toward.x - spot.x, toward.y - spot.y
    local tl = math.sqrt(tx * tx + ty * ty)
    if tl > .05 then dirs[#dirs + 1] = {tx / tl, ty / tl} end
    dirs[#dirs + 1] = {forward.x, forward.y}
    dirs[#dirs + 1] = {forward.y, -forward.x}
    dirs[#dirs + 1] = {-forward.y, forward.x}
    local open = 0
    for _, d in ipairs(dirs) do
        local to = {x = spot.x + d[1] * reach, y = spot.y + d[2] * reach, z = spot.z}
        if native.lineClear(spot, to, heights) then open = open + 1 end
    end
    return open
end
function native.hiddenFrom(player, point, cone)
    local ok, hidden = pcall(function()
        local okView, _, view = pcall(function() return Game.GetTargetingSystem():GetCrosshairData(player) end)
        local f = okView and view or player:GetWorldForward()
        local at = player:GetWorldPosition()
        local bx, by = point.x - at.x, point.y - at.y
        local fl, bl = math.sqrt(f.x * f.x + f.y * f.y), math.sqrt(bx * bx + by * by)
        if fl > 1e-3 and bl > 1e-3 and (f.x * bx + f.y * by) / (fl * bl) < math.cos(math.rad(cone)) then return true end
        -- In the cone: hidden only behind geometry (V's eyes to her chest).
        return native.blocked({x = at.x, y = at.y, z = at.z + 1.6}, {x = point.x, y = point.y, z = point.z + 1.2})
    end)
    return ok and hidden == true -- unknown is not hidden
end
function native.inCombat(npc)
    local ok, value = pcall(function() return NPCPuppet.IsInCombat(npc) end)
    return ok and value == true
end
local actuator
function native.look(entry, style, player, settings)
    actuator = actuator or dofile('companion-actuator.lua')
    if not entry.motor then return false end
    return actuator.applyLook(entry.motor, style, player, settings, true)
end

-- Controller -----------------------------------------------------------------
function M.new(options)
    options = options or {}
    local catalog = options.catalog or dofile('gesture-catalog.lua')
    local self = {states = {}, clock = 0, tickCount = 0, errors = {}, sessions = 0,
        native = options.native or native, log = options.log or function() end,
        gazeSettings = options.gazeSettings or function() return nil end}
    local nat, policy = self.native, M.policy
    local components = catalog.seatComponents or {}
    local template = catalog.device
    local check, session = 0, nil
    self.disabledReason = (not next(components) or not template) and 'seat workspots missing from the installed archive' or nil

    local function note(kind, fields)
        fields = fields or {}
        self.log(kind, fields)
    end
    local function failNote(reason)
        self.errors[#self.errors + 1] = reason
        if #self.errors > 8 then table.remove(self.errors, 1) end
    end
    local function stateFor(entry)
        local s = self.states[entry.serial]
        if not s then
            s = {serial = entry.serial, phase = 'off', tickets = 0}
            self.states[entry.serial] = s
        end
        s.entry = entry
        return s
    end
    local function dropDevice(s)
        if s.deviceID then nat.deleteDevice(s.deviceID) end
        s.deviceID, s.device = nil, nil
    end
    local function release(s, reason)
        if s.seat then s.seat.taken = nil end
        dropDevice(s)
        note('seat-' .. (HOLDING[s.phase] and 'finished' or 'abandoned'), {serial = s.serial, reason = reason})
        s.phase, s.seat, s.exitAt, s.lookStyle = 'off', nil, nil, nil
        if s.reseat then
            -- She stood up on her own while V is still seated: take a seat again.
            s.reseat = nil
            if session and session.id == s.session and reason == 'left the seat on its own' then
                s.session, s.cooldownUntil = nil, self.clock + 1
                note('seat-reseat', {serial = s.serial, reason = reason})
            end
        end
    end
    local function requestExit(s, reason, instant)
        if s.phase == 'approach' or s.phase == 'settling' or s.phase == 'blending' or s.phase == 'choosing'
            or s.phase == 'closing' or s.phase == 'placing' then release(s, reason); return end
        if s.phase == 'entering' and not s.playedAt then release(s, reason); return end
        if (s.phase == 'standing' or s.phase == 'leaving') and (reason == 'transport' or reason == 'unobserved') then
            release(s, reason); return
        end
        if s.phase ~= 'entering' and s.phase ~= 'seated' then return end
        s.phase, s.exitAt, s.exitReason, s.escalated, s.exitInstant = 'exiting', self.clock, reason, nil, instant == true
        nat.exit(s.entry.npc, instant)
        note('seat-exit', {serial = s.serial, reason = reason, instant = instant == true})
    end
    local function endSession(reason, instant)
        if not session then return end
        note('player-stood', {session = session.id, reason = reason})
        session = nil
        for _, s in pairs(self.states) do requestExit(s, reason, instant) end
    end

    -- V's seat, sampled at most every policy.checkEvery seconds.
    local function sense(player)
        local ok, seat = pcall(nat.playerSeat, player, not session or not session.anchor)
        if not ok then failNote('player seat: ' .. tostring(seat)); return end
        if seat.combat then endSession('combat', true); return end
        if not seat.inside or seat.exiting then endSession(seat.inside and 'V is getting up' or 'V stood up'); return end
        if session then
            -- PSM IsInWorkspot is 1 only while V is seated: 0 again while still
            -- in the workspot means V is getting up.
            if seat.psmWorkspot == 1 then session.psmSeen = true
            elseif seat.psmWorkspot ~= nil and session.psmSeen then endSession('V is getting up'); return end
            if session.anchor and flat(seat.position, session.anchor) > policy.leaveDistance then
                endSession('V left the seat')
            elseif not session.anchor then
                local known = seat.psmWorkspot ~= nil
                local settled = known and seat.psmWorkspot == 1 or (not known and not seat.entering)
                session.stableFor = settled and session.stableFor + policy.checkEvery or 0
                if session.stableFor >= (known and policy.settlePsm or policy.settleAfter) then
                    -- The anchor is V's settled seat root: where its workspot plays.
                    local len = math.sqrt(seat.forward.x ^ 2 + seat.forward.y ^ 2)
                    if len < .1 then return end
                    session.anchor = copy(seat.position)
                    session.forward = {x = seat.forward.x / len, y = seat.forward.y / len}
                    session.orientation = seat.orientation or session.orientation
                    session.search = {side = 1, samples = {}}
                end
            end
            return
        end
        if seat.mounted then
            -- V is in a workspot but mounted to something (a car, a device): never
            -- a seat. Logged once per sit so a missing session is explainable.
            if self.lastMounted ~= true then self.lastMounted = true; note('player-workspot-skipped', {reason = 'mounted'}) end
            return
        end
        self.lastMounted = nil
        local named = (seat.path and seat.path ~= '') or (seat.anim and seat.anim ~= '')
        local kind = M.classify(seat.path, seat.anim)
        local key = tostring(seat.path) .. '|' .. tostring(seat.anim)
        if self.lastWorkspot ~= key then
            self.lastWorkspot = key
            note('player-workspot', {path = seat.path, anim = seat.anim,
                kind = kind or (named and 'unsupported' or 'unnamed: classify by the furniture')})
        end
        -- A named workspot that is not a seat (a car, a device, the ground) never
        -- seats anyone. An unnamed one (a scene sit) is judged by the furniture.
        if not kind and named then return end
        self.sessions = self.sessions + 1
        session = {id = self.sessions, kind = kind, profile = kind and M.kinds[kind], basis = kind and 'workspot' or 'furniture',
            stableFor = 0, since = self.clock, orientation = seat.orientation, path = seat.path, anim = seat.anim}
        note('player-sat', {session = session.id, kind = kind or 'pending', basis = session.basis, path = seat.path, anim = seat.anim})
    end

    -- One side of the furniture per update: at most ~40 raycasts per update,
    -- only in the first two updates after V settles.
    local function searchStep(player, rows)
        local search = session and session.search
        if not search or session.seats then return end
        if not session.profile then
            -- One update: what V sits on, from about a dozen rays.
            local anchor, f = session.anchor, session.forward
            local kind, found = M.classifyGeometry(function(back, lateral)
                local x = anchor.x - f.x * back + f.y * lateral
                local y = anchor.y - f.y * back - f.x * lateral
                local z = nat.surface(x, y, anchor.z + 1.4, anchor.z - .4)
                return z and z - anchor.z or nil
            end)
            found.kind = kind or 'unsupported'
            found.session = session.id
            note('seat-classified', found)
            if not kind then session.seats, session.search = {}, nil; return end
            session.kind, session.profile = kind, M.kinds[kind]
            return
        end
        local kind, anchor, f = session.profile, session.anchor, session.forward
        local rx, ry = f.y, -f.x
        local bx, by = anchor.x - f.x * kind.back, anchor.y - f.y * kind.back
        local top, bottom = anchor.z + 1.4, anchor.z - .4
        if search.h0 == nil then
            local z = nat.surface(bx, by, top, bottom)
            search.h0 = z and z - anchor.z or false
        end
        local side, list = search.side, {}
        local offset = policy.ownOffset or policy.minOffset
        while offset <= kind.span + 1e-6 do
            local z = nat.surface(bx + rx * offset * side, by + ry * offset * side, top, bottom)
            list[#list + 1] = {offset = math.floor(offset * 100 + .5) / 100, h = z and z - anchor.z or nil}
            offset = offset + policy.sampleStep
        end
        search.samples[side] = list
        if side == 1 then search.side = -1; return end
        local h0 = search.h0
        if h0 and (h0 < kind.band[1] or h0 > kind.band[2]) then h0 = nil end -- V's own seat not measurable
        session.seats = M.findSeats(search.samples, kind, h0 or nil, policy)
        local exclude = {}
        for _, row in ipairs(rows or {}) do exclude[tostring(row.entry.entityID and row.entry.entityID.hash or row.entry.serial)] = true end
        local ok, people = pcall(nat.people, player, kind.span + 2, exclude)
        session.people = ok and people or {}
        local profile = {}
        for _, s in ipairs({1, -1}) do
            for _, sample in ipairs(search.samples[s]) do
                profile[#profile + 1] = string.format('%+.2f:%s', sample.offset * s, sample.h and string.format('%.2f', sample.h) or '-')
            end
        end
        note('seats-found', {session = session.id, kind = session.kind, h0 = search.h0 or nil, count = #session.seats,
            people = #session.people, profile = table.concat(profile, ' ')})
        session.search = nil
    end

    -- Wall, floor and occupancy checks for one candidate (a few raycasts).
    local function usable(seat)
        if seat.checked ~= nil then return seat.checked end
        local kind, anchor = session.profile, session.anchor
        local root = M.seatPoints(anchor, session.forward, seat, kind)
        seat.root = root
        local reason
        for _, person in ipairs(session.people or {}) do
            if flat(person, root) < policy.occupiedRadius and math.abs(person.z - anchor.z) < 1.2 then reason = 'occupied' end
        end
        local up = policy.wallHeight
        if not reason and nat.blocked({x = anchor.x, y = anchor.y, z = anchor.z + up}, {x = root.x, y = root.y, z = root.z + up}) then
            reason = 'wall between'
        end
        seat.checked, seat.reason = reason == nil, reason
        if reason then note('seat-rejected', {session = session.id, offset = seat.offset, reason = reason}) end
        return seat.checked
    end

    local slideOrWait, startWalk, beginPlacing
    local function nextTicket(s)
        s.tickets = s.tickets + 1
        return 'seat:' .. tostring(s.serial) .. ':' .. tostring(s.tickets)
    end
    local function holdDecision(s, reason)
        s.holdOp = s.holdOp or {ticket = nextTicket(s), kind = 'hold'}
        return {phase = 'seated', reason = reason, operation = s.holdOp, look = 'none'}
    end

    local function precheck(s, point, from, entry)
        local anchor = s.anchorCopy
        local z = nat.surface(point.x, point.y, anchor.z + 1.2, anchor.z - .6, true)
        local h = z and z - anchor.z
        if not h or h < policy.floorBand[1] or h > policy.floorBand[2] then return nil, 'no floor' end
        local nav = nat.navPoint({x = point.x, y = point.y, z = z}, entry.npc)
        if not nav then return nil, 'off the navmesh' end
        if flat(nav, anchor) < policy.keepOut then return nil, 'too close to V' end
        for _, other in pairs(self.states) do
            if other ~= s and other.seat and other.seat.approach and flat(other.seat.approach, nav) < .8 then return nil, 'another companion' end
        end
        if not nat.bodyClear(nav, entry.clearance) then
            nav.score, nav.fallback = point.score + 5, true
            s.fallback[#s.fallback + 1] = nav
            return nil, 'no room'
        end
        nav.straight = from and nat.lineClear(from, nav, policy.lineHeights) or false
        nav.score = point.score - (nav.straight and 10 or 0)
        return nav
    end
    -- Judge a few walk-up points this update; true once the choice is made.
    local function choose(s, entry)
        local checked = 0
        while s.points and #s.points > 0 and checked < policy.precheckPerUpdate do
            local point = table.remove(s.points, 1)
            checked = checked + 1
            local good, why = precheck(s, point, entry.position, entry)
            if good then
                s.good[#s.good + 1] = good
                if good.straight then s.stopChecking = true; break end -- the best kind: walk now
            else s.rejectedPoints = (s.rejectedPoints or 0) + 1; s.lastReject = why end
        end
        s.chooseUpdates = s.chooseUpdates + 1
        if not s.stopChecking and #s.points > 0 and s.chooseUpdates < policy.precheckUpdates then return false end
        table.sort(s.good, function(a, b) return a.score < b.score end)
        if #s.good < policy.fallbackBelow then
            table.sort(s.fallback, function(a, b) return a.score < b.score end)
            for _, point in ipairs(s.fallback) do s.good[#s.good + 1] = point end
            s.fallback = {}
        end
        note('seat-walk-checked', {serial = s.serial, good = #s.good, rejected = s.rejectedPoints or 0,
            fallbacks = (function() local n = 0; for _, p in ipairs(s.good) do if p.fallback then n = n + 1 end end; return n end)(),
            straight = s.good[1] and s.good[1].straight or false, last = s.lastReject})
        return true
    end
    -- The next pre-checked walk-up point; the move replaces the current one
    -- directly (no hold in between).
    local function nextApproach(s, entry)
        -- Points not judged yet (the pre-check stopped at a straight one) are
        -- judged now, a few at most, so a retry still starts on a checked point.
        local extra = 0
        while #s.good == 0 and s.points and #s.points > 0 and extra < policy.precheckPerUpdate and entry do
            local good = precheck(s, table.remove(s.points, 1), entry.position, entry)
            if good then s.good[1] = good end
            extra = extra + 1
        end
        if #s.good == 0 and #(s.fallback or {}) > 0 then
            table.sort(s.fallback, function(a, b) return a.score < b.score end)
            s.good, s.fallback = s.fallback, {}
        end
        local point = table.remove(s.good, 1)
        if not point or s.tries >= policy.approachTries then return false end
        s.tries, s.since, s.failingSince = s.tries + 1, self.clock, nil
        s.walkFrom = entry and entry.position and copy(entry.position) or nil
        s.seat.approach = {x = point.x, y = point.y, z = point.z}
        s.op = {ticket = nextTicket(s), kind = 'move', goal = copy(s.seat.approach), gait = 'Walk', finish = true, face = false}
        note('seat-walk', {serial = s.serial, try = s.tries, goal = s.seat.approach, straight = point.straight == true,
            fallback = point.fallback == true})
        return true
    end
    local function arrive(s, toSeat, refused, entry)
        s.phase, s.since, s.slide = 'settling', self.clock, toSeat
        s.arrivedAt = entry and entry.position and copy(entry.position) or nil
        note('seat-arrived', {serial = s.serial, toSeat = toSeat, refused = refused == true})
        return holdDecision(s, 'Stop at the seat')
    end
    -- Out of walk-up points: slide in from up to slideReach, after V looks away
    -- (or blendWait) when the slide is long enough to read as a glide.
    function slideOrWait(s, entry)
        local toSeat = entry.position and flat(entry.position, s.seat.root) or math.huge
        -- Half way through closing in, a slide from up to slideReach is allowed.
        local reach = s.closingSince and self.clock - s.closingSince > policy.closeTimeout / 2
            and policy.slideReach or policy.refusedSlide
        if toSeat > reach and s.phase ~= 'blending' then
            -- Her normal following brings her near V; no decision of ours.
            if s.phase ~= 'closing' then
                s.phase, s.closingSince = 'closing', s.closingSince or self.clock
                s.closeBest, s.closeBestAt = toSeat, self.clock
                note('seat-closing', {serial = s.serial, toSeat = toSeat, tries = s.tries})
            end
            if toSeat < s.closeBest - policy.closeProgress then s.closeBest, s.closeBestAt = toSeat, self.clock end
            if self.clock - s.closeBestAt >= (s.stuck and policy.closeStallStuck or policy.closeStall) then
                return beginPlacing(s, entry)
            end
            return nil
        end
        s.phase = 'blending'
        s.blendSince = s.blendSince or self.clock
        local long = toSeat > policy.slideNear
        if long and self.clock - s.blendSince < policy.blendWait
            and nat.lookingAt(self.player, entry.position, policy.lookCone) then
            return holdDecision(s, 'Wait for V to look away')
        end
        return arrive(s, toSeat, true, entry)
    end

    -- Where to place her: a pre-checked walk-up point (navmesh and room), else
    -- one that failed only the room check, else fresh points with floor;
    -- nearest to the seat first.
    local function placeSpot(s, entry)
        local list = {}
        for _, p in ipairs(s.good or {}) do list[#list + 1] = p end
        for _, p in ipairs(s.fallback or {}) do list[#list + 1] = p end
        if #list == 0 then
            for _, p in ipairs(M.approachPoints(s.seat.root, s.forwardCopy, s.profileCopy, s.anchorCopy, s.seat.root, policy)) do
                local z = nat.surface(p.x, p.y, s.anchorCopy.z + 1.2, s.anchorCopy.z - .6, true)
                local h = z and z - s.anchorCopy.z
                if h and h >= policy.floorBand[1] and h <= policy.floorBand[2] then list[#list + 1] = {x = p.x, y = p.y, z = z} end
                if #list >= 4 then break end
            end
        end
        table.sort(list, function(a, b) return flat(a, s.seat.root) < flat(b, s.seat.root) end)
        while #list > policy.placeCandidates do table.remove(list) end
        return list
    end
    function beginPlacing(s, entry)
        s.phase, s.placingSince, s.lookCheckAt, s.placedAt = 'placing', self.clock, 0, nil
        s.placeSpots = placeSpot(s, entry)
        note('seat-placing', {serial = s.serial, spots = #s.placeSpots,
            toSeat = entry.position and flat(entry.position, s.seat.root)})
        return holdDecision(s, 'Wait for V to look away')
    end
    local function yawToward(from, to) return math.deg((math.atan2 or math.atan)(-(to.x - from.x), to.y - from.y)) end
    local function placing(s, entry)
        local toSeat = entry.position and flat(entry.position, s.seat.root) or math.huge
        if s.placedAt then
            if self.clock - s.placedAt >= policy.standSettle then return arrive(s, toSeat, false, entry) end
            return holdDecision(s, 'Placed at the seat')
        end
        local waited = self.clock - s.placingSince
        if waited >= policy.placeLongWait and toSeat <= policy.slideReach then
            note('seat-placing-slide', {serial = s.serial, toSeat = toSeat})
            return arrive(s, toSeat, true, entry)
        end
        if self.clock < s.lookCheckAt then return holdDecision(s, 'Wait for V to look away') end
        s.lookCheckAt = self.clock + policy.lookEvery
        -- Only while she herself is out of view. A spot V cannot see either is
        -- preferred; after placeBothFor the nearest spot will do.
        local spot, unseen
        if entry.position and #s.placeSpots > 0 and nat.hiddenFrom(self.player, entry.position, policy.viewCone) then
            for _, candidate in ipairs(s.placeSpots) do
                if nat.hiddenFrom(self.player, candidate, policy.viewCone) then spot, unseen = candidate, true; break end
            end
            if not spot and waited >= policy.placeBothFor then spot = s.placeSpots[1] end
        end
        if spot then
            local sent = nat.teleport(entry, spot, yawToward(spot, s.seat.root), 'seat-place')
            s.placedAt, s.seat.approach = self.clock, {x = spot.x, y = spot.y, z = spot.z}
            note('seat-placed', {serial = s.serial, spot = spot, sent = sent == true, waited = waited, spotUnseen = unseen == true})
        end
        return holdDecision(s, 'Wait for V to look away')
    end

    -- After (or during) the pre-check: walk to the best point, or slide in when
    -- no point is usable and she is close.
    function startWalk(s, entry)
        if not choose(s, entry) then return nil end
        s.phase = 'approach'
        if not nextApproach(s, entry) then return slideOrWait(s, entry) end
        return {phase = 'seat-approach', reason = 'Walk to a seat beside V', operation = s.op, look = 'none'}
    end

    local function begin(s, entry)
        s.session = session.id
        if self.disabledReason then return nil end
        local best, bestGap
        for _, seat in ipairs(session.seats or {}) do
            if not seat.taken and seat.checked ~= false then
                local root = M.seatPoints(session.anchor, session.forward, seat, session.profile)
                -- Next to V first; the companion's own distance breaks ties
                -- (the seat on its side of V).
                local gap = math.abs(seat.offset) + .25 * (entry.position and flat(entry.position, root) or 0)
                if not bestGap or gap < bestGap then best, bestGap = seat, gap end
            end
        end
        if not best then note('seat-none', {serial = s.serial, session = session.id}); return nil end
        if not usable(best) then s.session = nil; return nil end -- try the next seat on the next update
        local component = components[session.profile.component]
        if not component then note('seat-none', {serial = s.serial, reason = 'no workspot for ' .. session.kind}); return nil end
        best.taken = s.serial
        s.seat, s.component, s.phase, s.since = best, component, 'choosing', self.clock
        s.anchorCopy, s.forwardCopy, s.profileCopy = copy(session.anchor), {x = session.forward.x, y = session.forward.y}, session.profile
        s.holdOp, s.playedAt, s.device, s.deviceID, s.failingSince, s.slide = nil, nil, nil, nil, nil, nil
        s.points, s.tries, s.blendSince = M.approachPoints(best.root, session.forward, session.profile, session.anchor,
            entry.position, policy), 0, nil
        s.good, s.chooseUpdates, s.rejectedPoints, s.lastReject, s.stopChecking = {}, 0, 0, nil, nil
        s.fallback, s.closingSince = {}, nil
        s.stuck, s.walkFrom = nil, nil
        local ok, id = nat.spawnDevice(best.root, session.orientation, template)
        if ok then s.deviceID = id else failNote('seat device: ' .. tostring(id)) end
        note('seat-assigned', {serial = s.serial, session = session.id, kind = session.kind, offset = best.offset,
            height = best.height, component = component, toSeat = entry.position and flat(entry.position, best.root)})
        return startWalk(s, entry)
    end

    -- Floor in front of the seat with room for her body: her own arrival spot
    -- when close, the walk-up point she reached, then fresh walk-up points.
    local function standCandidates(s)
        local list, anchor, seen = {}, s.anchorCopy, {}
        local function add(point, why)
            if point then list[#list + 1] = {x = point.x, y = point.y, z = anchor.z, why = why} end
        end
        if s.arrivedAt and flat(s.arrivedAt, s.seat.root) <= policy.standReach then add(s.arrivedAt, 'arrival') end
        if s.seat.approach and flat(s.seat.approach, s.seat.root) <= policy.standReach then add(s.seat.approach, 'walk-up') end
        for _, point in ipairs(M.approachPoints(s.seat.root, s.forwardCopy, s.profileCopy, anchor, s.seat.root, policy)) do
            add(point, 'front')
        end
        return list
    end
    local function usableStand(s, point)
        local anchor = s.anchorCopy
        local z = nat.surface(point.x, point.y, anchor.z + 1.2, anchor.z - .6, true)
        local h = z and z - anchor.z
        if not h or h < policy.floorBand[1] or h > policy.floorBand[2] then return false, 'no floor' end
        point.z = z
        if not nat.bodyClear(point, s.entry.clearance) then return false, 'no room' end
        return true
    end
    local function yawOf(f) return math.deg((math.atan2 or math.atan)(-f.x, f.y)) end
    local function evaluateStands(s, count)
        local judged = 0
        while s.stands and s.standEval < #s.stands and judged < count and #s.standGood < policy.standEvalMax do
            s.standEval, judged = s.standEval + 1, judged + 1
            local point = s.stands[s.standEval]
            local ok, why = usableStand(s, point)
            if ok then
                point.open = nat.openness and nat.openness(point, s.towardV or s.anchorCopy, s.forwardCopy,
                    policy.openReach, policy.lineHeights) or 0
                point.rank = #s.standGood
                s.standGood[#s.standGood + 1] = point
            else
                note('seat-stand-rejected', {serial = s.serial, from = point.why, reason = why})
            end
        end
    end
    local function nextStand(s)
        -- Judged spots first, most open first (ties keep the arrival order).
        if #s.standGood > 0 then
            table.sort(s.standGood, function(a, b)
                if a.open ~= b.open then return a.open > b.open end
                return a.rank < b.rank
            end)
            local point = table.remove(s.standGood, 1)
            s.standTries = s.standTries + 1
            if s.standTries <= 6 then
                s.standSpot, s.standAt, s.teleported = point, self.clock, false
                local sent = nat.stepOut(s.entry, point)
                note('seat-step-out', {serial = s.serial, spot = point, from = point.why, open = point.open, sent = sent == true})
                return true
            end
            return false
        end
        while s.stands and s.standEval < #s.stands and s.standTries < 6 do
            s.standEval = s.standEval + 1
            local point = s.stands[s.standEval]
            local ok, why = usableStand(s, point)
            if ok then
                s.standTries = s.standTries + 1
                s.standSpot, s.standAt, s.teleported = point, self.clock, false
                local sent = nat.stepOut(s.entry, point)
                note('seat-step-out', {serial = s.serial, spot = point, from = point.why, sent = sent == true})
                return true
            end
            note('seat-stand-rejected', {serial = s.serial, from = point.why, reason = why})
        end
        return false
    end
    -- The exit request starts the stand-up clip; IsActorInWorkspot is already
    -- false then. Wait until no workspot activity is left (and at least
    -- exitSettle), judging stand spots meanwhile, then step out.
    local function beginLeaving(s)
        s.phase, s.stands, s.standEval, s.standGood, s.standTries = 'leaving', standCandidates(s), 0, {}, 0
        s.quietSince = nil
        local ok, at = pcall(function() local p = self.player:GetWorldPosition(); return {x = p.x, y = p.y, z = p.z} end)
        s.towardV = ok and at or nil
    end
    local function beginStanding(s)
        s.phase = 'standing'
        if not nextStand(s) then
            failNote('no floor to stand on beside the seat'); release(s, s.exitReason or 'stood up')
        end
    end
    local function leaving(s, entry)
        evaluateStands(s, policy.standEvalPerUpdate)
        if nat.workspotBusy and nat.workspotBusy(entry.npc) then s.quietSince = nil
        else s.quietSince = s.quietSince or self.clock end
        local waited = self.clock - s.exitAt
        local quiet = s.quietSince and self.clock - s.quietSince >= policy.exitQuiet
        -- A fight: out of the seat at once (the instant exit has no stand-up clip).
        local settle = s.exitInstant and .3 or policy.exitSettle
        if (quiet and waited >= settle) or waited >= policy.exitWait then
            note('seat-left', {serial = s.serial, after = waited, quiet = quiet == true, judged = s.standEval})
            beginStanding(s)
        end
    end
    local function standing(s, entry)
        local at = entry.position
        local spot = s.standSpot
        if at and flat(at, spot) <= policy.standArrive and (not s.teleported or self.clock - s.standAt >= policy.standSettle) then
            local z = nat.surface(at.x, at.y, s.anchorCopy.z + 1.2, s.anchorCopy.z - .6, true)
            local onFloor = z and math.abs(at.z - z) < .25 and z - s.anchorCopy.z <= policy.floorBand[2]
            if onFloor and nat.bodyClear({x = at.x, y = at.y, z = z}, entry.clearance) then
                note('seat-stood', {serial = s.serial, spot = spot, from = spot.why, teleported = s.teleported})
                release(s, s.exitReason or 'stood up')
                return
            end
            note('seat-stand-rejected', {serial = s.serial, from = spot.why, reason = 'not on clear floor after the step'})
            if not nextStand(s) then failNote('no clear floor after standing'); release(s, s.exitReason or 'stood up') end
            return
        end
        if not s.teleported and self.clock - s.standAt >= policy.standDeadline then
            -- The straight step did not get her out: put her on the checked spot.
            s.teleported, s.standAt = true, self.clock
            local sent = nat.teleport(entry, spot, yawOf(s.forwardCopy), 'seat-stand')
            note('seat-stand-teleport', {serial = s.serial, spot = spot, sent = sent == true})
        elseif s.teleported and self.clock - s.standAt >= policy.standDeadline then
            if not nextStand(s) then failNote('could not leave the seat'); release(s, 'stand gave up') end
        end
    end

    local function deviceReady(s)
        if s.device then return s.device end
        if not s.deviceID then return nil end
        local entity = nat.deviceEntity(s.deviceID)
        if entity == false then s.deviceID = nil; return nil end
        s.device = entity or nil
        return s.device
    end
    local function play(s)
        local device = deviceReady(s)
        if not device then
            if self.clock - s.since > policy.deviceTimeout or not s.deviceID then
                failNote('seat device never spawned'); release(s, 'device unavailable')
            end
            return
        end
        if nat.hasComponent and not nat.hasComponent(device, s.component) then
            self.disabledReason = 'seat workspots missing from the installed archive (restart the game after installing convai_gestures.archive)'
            failNote(self.disabledReason); note('seat-disabled', {reason = self.disabledReason})
            release(s, 'old archive'); return
        end
        local slide = math.min(policy.slideMax, policy.slideTime + (s.slide and math.max(0, s.slide - .75) * .35 or 0))
        local ok, result = nat.play(device, s.entry.npc, s.component, slide)
        if not ok then
            failNote('seat play: ' .. tostring(result))
            s.cooldownUntil = self.clock + policy.failureCooldown
            release(s, 'play failed'); return
        end
        s.playedAt = self.clock
        note('seat-play', {serial = s.serial, component = s.component, slide = slide})
    end

    -- Decision override for the companions loop (before behavior.decide):
    -- a walk to the assigned seat, then a hold while the workspot owns the body.
    function self.steer(entry, context)
        local s = stateFor(entry)
        if s.phase == 'off' then
            if not session or not session.seats or s.session == session.id then return nil end
            if context.combat or self.clock < (s.cooldownUntil or 0) then return nil end
            if (tonumber(entry.playerGap) or math.huge) > policy.searchRadius then
                if s.farSession ~= session.id then
                    s.farSession = session.id
                    note('seat-too-far', {serial = s.serial, session = session.id, gap = entry.playerGap})
                end
                return nil
            end
            if nat.inWorkspot(entry.npc) ~= false then return nil end -- a gesture stance is still leaving
            return begin(s, entry)
        end
        if s.phase == 'choosing' then
            if not session or session.id ~= s.session then release(s, 'V stood up'); return nil end
            if context.combat then release(s, 'combat'); return nil end
            return startWalk(s, entry)
        end
        if s.phase == 'approach' then
            if not session or session.id ~= s.session then release(s, 'V stood up'); return nil end
            if context.combat then release(s, 'combat'); return nil end
            local motion = context.motion or {}
            local ours = motion.ticket == s.op.ticket
            local gap = entry.position and flat(entry.position, s.seat.approach) or math.huge
            local toSeat = entry.position and flat(entry.position, s.seat.root) or math.huge
            if (ours and (motion.failed or motion.stalled))
                or (not ours and self.clock - s.since >= policy.notOursAfter) then s.failingSince = s.failingSince or self.clock
            else s.failingSince = nil end
            local failing = s.failingSince and self.clock - s.failingSince or 0
            -- Arrived: retire the walk to a hold first, then the workspot takes the body.
            if (ours and motion.complete) or gap <= policy.arriveDistance then return arrive(s, toSeat, false, entry) end
            if failing >= policy.routeGrace or self.clock - s.since > policy.approachTimeout then
                -- The actuator's own rejection (stage: navigation, stance, player,
                -- destination, path, connector, motion) says why the route was refused.
                local why = type(motion.rejection) == 'table' and motion.rejection or {}
                note('seat-walk-refused', {serial = s.serial, try = s.tries, toSeat = toSeat,
                    reason = motion.error or (ours and 'refused' or 'not taken'),
                    stage = why.stage, group = why.group, boxes = why.boxes, unavailable = why.unavailable,
                    toGoal = gap < math.huge and gap or nil, playerGap = entry.playerGap,
                    at = entry.position and {x = entry.position.x, y = entry.position.y, z = entry.position.z} or nil})
                if toSeat <= policy.refusedSlide then return slideOrWait(s, entry) end
                -- A refusal at the route stage that left her where she stood is the
                -- same for every walk-up point (the route from where she stands).
                local moved = entry.position and s.walkFrom and flat(entry.position, s.walkFrom) or math.huge
                if why.stage == 'path' and moved < policy.stuckMove then
                    s.stuck = true
                    note('seat-walk-stuck', {serial = s.serial, try = s.tries, stage = why.stage, toSeat = toSeat})
                    return slideOrWait(s, entry)
                end
                if nextApproach(s, entry) then
                    return {phase = 'seat-approach', reason = 'Walk to a seat beside V', operation = s.op, look = 'none'}
                end
                return slideOrWait(s, entry)
            end
            return {phase = 'seat-approach', reason = 'Walk to a seat beside V', operation = s.op, look = 'none'}
        end
        if s.phase == 'placing' then
            if not session or session.id ~= s.session then release(s, 'V stood up'); return nil end
            if context.combat then release(s, 'combat'); return nil end
            return placing(s, entry)
        end
        if s.phase == 'closing' then
            if not session or session.id ~= s.session then release(s, 'V stood up'); return nil end
            if context.combat then release(s, 'combat'); return nil end
            return slideOrWait(s, entry)
        end
        if s.phase == 'blending' then
            if not session or session.id ~= s.session then release(s, 'V stood up'); return nil end
            if context.combat then release(s, 'combat'); return nil end
            return slideOrWait(s, entry)
        end
        if s.phase == 'settling' then
            if not session or session.id ~= s.session then release(s, 'V stood up'); return nil end
            if context.combat then release(s, 'combat'); return nil end
            local motor = entry.motor or {}
            local stopped = motor.ticket == s.holdOp.ticket and motor.kind == 'hold' and (tonumber(entry.speed) or 0) < .3
            if stopped or self.clock - s.since > policy.settleTimeout then
                s.phase, s.since = 'entering', self.clock
                play(s)
            end
            if s.phase == 'off' then return nil end
            return holdDecision(s, 'Sit down')
        end
        if HOLDING[s.phase] then return holdDecision(s, 'Seated with V') end
        return nil
    end

    -- Body ownership (same contract as the gesture controller): true while the
    -- sit workspot owns the body, so movement waits.
    function self.observe(entry, context)
        local s = stateFor(entry)
        s.observedTick = self.tickCount
        if not HOLDING[s.phase] then return false end
        local ok, err = pcall(function()
            local npc = entry.npc
            if s.phase == 'entering' then
                if not s.playedAt then play(s); return end
                if (context.combat) then requestExit(s, 'combat', true); return end
                if nat.inWorkspot(npc) == true then
                    s.phase, s.seatedAt = 'seated', self.clock
                    note('seat-seated', {serial = s.serial, after = self.clock - s.playedAt})
                elseif self.clock - s.playedAt > policy.enterTimeout then
                    s.cooldownUntil = self.clock + policy.failureCooldown
                    failNote('never entered the seat workspot'); release(s, 'never sat')
                end
                return
            end
            if s.phase == 'seated' then
                if context.combat then requestExit(s, 'combat', true); return end
                if not session or session.id ~= s.session then requestExit(s, 'V stood up', false); return end
                if nat.inWorkspot(npc) == false then
                    -- Live runs 20:53Z and 21:12Z: both seats ended by themselves
                    -- 95-105 s after she sat, V still seated (the vanilla sit
                    -- workspot runs out). Stand up cleanly, then sit again.
                    local held = self.clock - (s.seatedAt or self.clock)
                    note('seat-left-on-own', {serial = s.serial, after = held, vSeated = session ~= nil and session.id == s.session})
                    if session and session.id == s.session and held >= policy.reseatAfter then
                        s.phase, s.exitAt, s.exitReason, s.escalated, s.exitInstant, s.reseat =
                            'exiting', self.clock, 'left the seat on its own', nil, false, true
                    else
                        release(s, 'left the seat on its own')
                    end
                    return
                end
                local style = context.selected and 'full' or 'side'
                -- Development only (face-test `gaze`): the strong held look replaces this one.
                local devGaze = convaiCompanions and convaiCompanions.devGazeKey
                if devGaze then
                    local okKey, key = pcall(function() return tostring(npc:GetEntityID().hash) end)
                    if okKey and key == devGaze then style = 'none' end
                end
                if s.lookStyle ~= style then
                    s.lookStyle = style
                    pcall(nat.look, entry, style, self.player, self.gazeSettings())
                end
                return
            end
            if s.phase == 'leaving' then leaving(s, entry); return end
            if s.phase == 'standing' then standing(s, entry); return end
            if s.phase == 'exiting' then
                if nat.inWorkspot(npc) == false then
                    if s.exitInstant and s.exitReason == 'transport' then release(s, s.exitReason); return end
                    beginLeaving(s); leaving(s, entry); return
                end
                local waited = self.clock - s.exitAt
                if waited > policy.exitPatience and not s.escalated then
                    s.escalated = true; nat.stopInDevice(npc); note('seat-escalated', {serial = s.serial})
                end
                if waited > policy.exitGiveUp then
                    failNote('still seated after exit'); s.cooldownUntil = self.clock + policy.failureCooldown
                    release(s, 'exit gave up')
                end
            end
        end)
        if not ok then failNote(tostring(err)); pcall(requestExit, s, 'error', true) end
        return HOLDING[s.phase] == true
    end

    function self.tick(player, step, rows)
        local dt = tonumber(step) or 0
        self.clock, self.tickCount, self.player = self.clock + dt, self.tickCount + 1, player
        if not self.swept then self.swept = true; nat.sweep() end
        local present = {}
        for _, row in ipairs(rows or {}) do present[row.entry.serial] = row end
        for serial, s in pairs(self.states) do
            local row = present[serial]
            if not row then
                if HOLDING[s.phase] and s.entry and s.entry.npc then pcall(nat.exit, s.entry.npc, true) end
                if s.seat then s.seat.taken = nil end
                dropDevice(s)
                self.states[serial] = nil
            else
                s.entry = row.entry
                if s.phase ~= 'off' and (row.transport or (s.observedTick or 0) < self.tickCount - 1) then
                    -- Transport, recovery travel, a tactic or a departure took the copy.
                    pcall(requestExit, s, row.transport and 'transport' or 'unobserved', true)
                end
            end
        end
        if not next(present) then session = nil; return end
        check = check - dt
        if check <= 0 then
            check = policy.checkEvery
            sense(player)
        end
        local ok, err = pcall(searchStep, player, rows)
        if not ok then failNote('seat search: ' .. tostring(err)); if session then session.seats = {} end end
    end

    function self.release(entry, reason)
        local s = self.states[entry.serial]
        if not s then return end
        if HOLDING[s.phase] and entry.npc then pcall(nat.exit, entry.npc, true) end
        if s.seat then s.seat.taken = nil end
        dropDevice(s)
        self.states[entry.serial] = nil
        note('seat-released', {serial = entry.serial, reason = reason})
    end

    function self.abandon()
        -- World teardown: devices are not persistent; no native calls here.
        self.states, session, self.swept = {}, nil, false
        self.player = nil -- the tick stores V's handle; do not pin the old player across the unload
    end

    -- While seating owns her (walking to the seat, placing, seated, standing
    -- up), recovery must not relocate her. Closing in is ordinary following.
    function self.owns(entry)
        local s = self.states[entry.serial]
        return s ~= nil and s.phase ~= 'off' and s.phase ~= 'closing'
    end

    function self.holds(entry)
        local s = self.states[entry.serial]
        return s ~= nil and HOLDING[s.phase] == true
    end

    function self.snapshot()
        local rows = {}
        for serial, s in pairs(self.states) do
            rows[#rows + 1] = {serial = serial, phase = s.phase, offset = s.seat and s.seat.offset,
                component = s.component, session = s.session}
        end
        return {disabled = self.disabledReason,
            session = session and {id = session.id, kind = session.kind, settled = session.anchor ~= nil,
                seats = session.seats and #session.seats or nil, path = session.path, anim = session.anim} or nil,
            companions = rows, errors = self.errors}
    end

    return self
end

return M
