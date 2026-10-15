-- Holocalls with the mod's characters (docs/HOLOCALL.md).
--
-- V calls one of the mod's characters from the mod's own Chat tab: the Call key (V on a keyboard, Triangle on a pad) on a
-- Chat list row or inside an open conversation, or a click on the Call hint there. The game's own phone, its Contacts
-- list and its Call action are never changed. The game's call window opens at the top left with that character's portrait and name (Holocall.reds drives it; the game's own
-- call path, its quest facts and its call blackboard are never used). While the call is connected, the talk keys (typed
-- and voice) address that character wherever V is, through the same request path as a face to face talk; the reply is
-- spoken in the mod voice at full volume (no distance) with call subtitles, and the turn says V is on a call
-- (bridge/turn-context.mjs).
--
-- Live picture, as the game does it. The game's video holocall is a render-to-texture camera
-- (base\cinematics\cameras\holocall_camera.ent, component RenderToTextureCamera) filming the caller's real body, posed
-- at a workspot in a lit room, into holocall_camera_render_texture.dtex, which the call window's holocall image shows.
-- The game stages that body only for the characters it has a holocall setup for (base\quest\holocalls\<name>\ and
-- ep1\quest\holocalls\<name>\, STAGED below); every other call is a voice call with the portrait. This file does the
-- same without the quest path: for a STAGED character (and the setting on) it finds a floor out of V's sight above V,
-- places a copy of the character there (the character's own record) held in a talk pose and kept animating, and points
-- the game's own holocall camera at it with the game's own framing, lit by three of the game's own lamps as the game lights
-- its studio actor with lights of its own (M.LIGHTS). Anything that does not work out (no floor, the copy
-- or camera not ready in time, the copy moving) falls back to the portrait voice call.
--
-- Cost: idle, update() is one nil check and drain() runs only on the phone's own request drain. A call ticks every
-- 0.25 s and reads one native event queue per tick; the floor search runs once per live call, one candidate per tick.
-- The camera renders only while its call is live. One probe line per call state change: "[Holocall] ...".
local M = convaiHolocall or {}
local ui = (convaiUiLocale or dofile('ui-locale.lua'))

M.TAG = 'CyberpunkConvaiHolocall'
M.COMPANION_TAG = 'CyberpunkConvaiCompanion'
M.CAMERA = 'base\\cinematics\\cameras\\holocall_camera.ent'
M.CAMERA_COMPONENT = 'RenderToTextureCamera'
M.TICK = 0.25
-- The call rings at least RING_MIN seconds (the character's connection warms meanwhile), and waits for the live
-- picture at most RING_MAX seconds (the game's own call failsafe is 8 s; the floor search, tried floor by floor near V,
-- can take about 7 s where nothing near is hidden, and the call may ring longer anyway, see READY_MAX).
M.RING_MIN, M.RING_MAX = 1.5, 10
-- It also rings until the character's conversation is ready (env.ready: the bridge reports her private connection
-- open, the same signal the "Preparing connection" notice reads), so the first reply does not wait on it; after
-- READY_MAX seconds of ringing it connects anyway (live, 2026-10-16: the first reply on a call said "Preparing").
M.READY_MAX = 18
-- No turn and no speech for this long hangs up; no call is longer than MAX_LENGTH (seconds of play, pauses excluded).
M.IDLE_LIMIT, M.MAX_LENGTH = 180, 1800
-- The shot. The game's own rig (the holocall studio's camera node against its actor spot): 0.675 m in front, the lens
-- 1.65 m above the feet, 20.4 degrees round from the actor's facing, level, fov 35 (the camera's own). The frame here is
-- a little taller (0.5 m, which solves to 0.79 m at fov 35) so a shorter or taller character still has the face in it.
M.SHOT = {frameH = 0.5, aimZ = 1.6, orbit = 20.4, fov = 35}
-- The copy's body faces the camera squarely (live, 2026-10-16: at the game's 20.4 degree three-quarter turn every
-- body read as turned to one side while the eyes found the lens). The camera and the lamps keep their places round the
-- spot's facing; only the body turns, once, at spawn.
function M.bodyYaw(spot) return spot.yaw + M.SHOT.orbit end
-- The backdrop. The game films its callers in a black room; here the call camera itself draws nothing farther than
-- BACKDROP metres behind the copy (its own depthCutDistance), so the world behind her is gone from the picture and
-- nothing has to be spawned. The cut part is transparent (the camera's backgroundColor is not drawn: live, 2026-10-16),
-- so the call window puts a black rectangle behind its holocall image (Holocall.reds ConvaiHolocallBacking); the cut is
-- made only where that backing exists. Set once, before the camera is switched on.
M.BACKDROP = 0.9
-- The studio: a floor 10 to 90 m above V, straight up or within 30 m, out of V's sight.
M.STUDIO_MIN, M.STUDIO_TOP, M.STUDIO_RADIUS = 10, 90, 30
-- When nothing stands above V (a high apartment, open ground, the Badlands: the first live test found no floor in any
-- of the nine columns above), the search goes level with and below V: floors from 10 m above to 80 m below V's feet,
-- on rings round V, still out of V's sight. A candidate costs about 22 raycasts, so the search takes a few per tick.
M.LOW_TOP, M.LOW_BOTTOM, M.LOW_RADII = 10, -80, {12, 24, 40}
-- Near first. The game animates a face only near V's own camera: a copy filmed 8 or 11 m from V moves its mouth, blinks
-- and turns its eyes; at 16 m and beyond its face is frozen (live, 2026-10-15; the body still moves). So the search first
-- tries a floor within FACE_RANGE metres of V (straight above or below V, then rings NEAR_RADII round V, floors from
-- NEAR_TOP above to NEAR_BOTTOM below V's feet, still out of V's sight), and only then the farther columns, where the
-- picture still works with a still face.
M.FACE_RANGE, M.NEAR_RADII, M.NEAR_TOP, M.NEAR_BOTTOM = 11, {5, 8}, 10, -10
-- A near column is tried floor by floor: when the first floor down a column will not do (V's own floor, in plain view),
-- the next one under it is tried, up to NEAR_LAYERS floors (live, 2026-10-16: on a terrace every near column's first
-- floor was V's own, in view, while the storey under it, 2 to 5 m below V and hidden by V's floor, was never looked at;
-- the studio landed 20.7 m away, where her face cannot move).
M.NEAR_LAYERS = 4
-- Floor candidates (one floor of one column) searched per tick.
M.SEARCH_PER_TICK = 3
-- The copy may drift this far from its place before the picture is given up.
M.HOLO_DRIFT = 1.5
-- The camera is switched off at once and deleted this many seconds later: the render thread may still hold its
-- target for some frames after the switch, and freeing it in the same frame crashes.
M.LENS_DELAY = 1.5
-- The look at the lens is asked for again this often (the game drops a stale look request). The light rig is checked
-- on the same beat.
M.LOOK_REFRESH = 5
-- The look's extra parts (see holoLook): head and chest weights.
M.LOOK_HEAD, M.LOOK_CHEST = 0.3, 2
-- The light rig. The game lights a holocall caller with lights of its own: the studio prefab #holocalls_studio_lighting
-- holds small spot and area lights (radius 1-5 m, 5-150 lm, no shadows, autoHideDistance 5 m) right round the actor, and
-- each call's scene switches on that character's variant (e.g. judy_holocall_lights): a warm key in front and above,
-- coloured accents at the side and behind, in a black room. The copy here stands wherever the search found a floor, lit
-- only by the world, and against a bright street it reads as a silhouette. So three of the game's own lamps go with her:
-- the residential corridor light (a light device: a point gameLightComponent, a mesh and a collider), the mesh and the
-- collider switched off, the light driven by its own script API. Positions are round the copy as the camera's are
-- (bearing from her facing in degrees, ground distance and height in metres); lumens tuned in game against the call
-- window to look naturally lit (2026-10-15), not stage lit. Shadows are off, as in the game's studio, so a lamp that
-- lands inside a wall still lights her. Each lamp exists only during the call.
M.LIGHT_TEMPLATE = 'base\\gameplay\\devices\\lighting\\residential\\corridor_light\\corridor_light_a.ent'
M.LIGHT_RADIUS = 2.5
M.LIGHTS = {
    {role = 'key', bearing = 55, dist = 0.85, height = 2.0, lumen = 110, color = {255, 238, 220}},
    {role = 'fill', bearing = -50, dist = 0.9, height = 1.45, lumen = 28, color = {220, 232, 255}},
    {role = 'rim', bearing = 170, dist = 0.75, height = 2.05, lumen = 75, color = {110, 200, 255}},
}
-- Never on a holocall, whatever a catalogue says.
M.NEVER = {johnny = true, ['johnny-silverhand'] = true, silverhand = true}
-- The contacts the game itself stages a video holocall for: phone contact id -> the game's holocall setup
-- (base\quest\holocalls\<name>\<name>_holocall.questphase, or ep1\... for Phantom Liberty; each runs a <name>_holocall
-- scene at the studio marker #<name>_sm_holocall). Every other contact gets the portrait voice call, as in the game.
M.STAGED = {
    coach = 'coach', wakako_okada = 'wakako', regina_jones = 'reggie', victor_vector = 'victor', stout = 'meredith',
    evelyn = 'evelyn', jackie = 'jackie', jackie_dead = 'jackie', takemura = 'takemura', judy = 'judy',
    muamar_el_capitan_reyes = 'muamar', wilson = 'wilson', mama_welles = 'mama_welles', dino_dinovic = 'dino',
    sebastian_padre_perez = 'padre', mr_hands = 'mr_hands', panam = 'panam', rogue = 'rogue', dakota_smith = 'dakota',
    saul = 'saul', marianne = 'claire', cassidy = 'cassidy', mitch = 'mitch', stud = 'mr_stud', river_ward = 'river',
    rachel = 'rachel', pepe_el_coyote = 'pepe', placide = 'placide', joss = 'joss', carol = 'carol', ozob = 'ozob',
    nix = 'nix', hanako_arasaka = 'hanako', lizzy_wizzy = 'lizzy', bob = 'bob', nancy = 'nancy',
    kerry_eurodyne = 'kerry', blue_moon = 'blue_moon', sandra_dorsett = 'sandra', misty = 'misty',
    agent_jenkins = 'jenkins', tbug = 't_bug', dex = 'dex', thompson = 'thompson', spider_murphy = 'spider_murphy',
    elizabeth_peralez = 'elizabeth', jefferson_peralez = 'jefferson', santiago = 'santiago',
    rachel_joestar_mq040 = 'cynthia', seller = 'r3no', frank = 'frank', yorinobu = 'yorinobu',
    -- Phantom Liberty (ep1\quest\holocalls).
    songbird = 'songbird', reed = 'reed', alex = 'alex', janet = 'janet', ['8ug8ear'] = '8ug8ear',
    chang_hoon_nam = 'chang_hoon_nam', mark_bana = 'mark_bana',
}
-- The collision the floor search and the sight checks look at.
M.GROUPS = {'Static', 'Terrain'}

M.env = M.env or {}
M.catalog = M.catalog or {}
M.serial = M.serial or 0

local function log(line)
    if type(M.env.log) == 'function' then pcall(M.env.log, '[Holocall] ' .. line) end
end

local function readJson(path)
    local file = io.open(path, 'rb')
    if not file then return nil end
    local raw = file:read('*a'); file:close()
    local ok, value = pcall(json.decode, raw)
    return ok and type(value) == 'table' and value or nil
end

local function excluded(row)
    local record = type(row.record) == 'string' and row.record:lower() or ''
    return M.NEVER[row.key] or M.NEVER[row.contact] or record:find('johnny', 1, true) or record:find('silverhand', 1, true)
end

-- The phone contacts of the mod's characters (characters/phone-contacts.json): contact id -> {key, name, record}.
function M.loadCatalog(list)
    local catalog = {}
    for _, row in ipairs(type(list) == 'table' and list or {}) do
        if type(row) == 'table' and type(row.contact) == 'string' and row.contact ~= '' and type(row.key) == 'string'
            and row.key:match('^[a-z0-9-]+$') and not excluded(row) then
            catalog[row.contact] = {contact = row.contact, key = row.key,
                name = type(row.name) == 'string' and row.name ~= '' and row.name or row.contact,
                record = type(row.record) == 'string' and row.record or nil}
        end
    end
    return catalog
end

-- env: log(line), supported(key), profileEnabled(key), warm(key, entity), liveImage(), busy(call),
-- onConnected(call), onEnded(call, reason), contacts() (the catalogue rows; phone-contacts.json when absent).
function M.configure(env)
    M.env = type(env) == 'table' and env or {}
    local rows = type(M.env.contacts) == 'function' and M.env.contacts() or readJson('phone-contacts.json')
    M.catalog = M.loadCatalog(rows)
    M.sweepDue, M.lenses = true, nil
end

-- Why a call cannot be on now, from the battle observer's half-second sample (mod/battle-observer.lua), or nil.
-- An unknown sample blocks nothing: the game's own call checks (Holocall.reds) still apply.
function M.blocked(sample)
    if type(sample) ~= 'table' or sample.available ~= true then return nil end
    if sample.combat == true then return 'combat' end
    if sample.replacer == true then return 'replacer' end
    if sample.call == true then return 'quest-call' end
    if (sample.tier ~= nil and sample.tier ~= 1) or sample.dialogue == true or sample.choices == true then return 'scene' end
    return nil
end

local function system()
    local ok, value = pcall(function() return Game.GetDynamicEntitySystem() end)
    return ok and value or nil
end

local function deleteTagged(id)
    local dynamic = system()
    if not dynamic or not id then return end
    pcall(function()
        if dynamic:IsManaged(id) and dynamic:IsTagged(id, CName.new(M.TAG)) then dynamic:DeleteEntity(id) end
    end)
end

-- Copies and cameras left by a reload or a crash. Run once after configure, from the first drain.
function M.sweep()
    M.sweepDue = false
    local dynamic = system()
    if not dynamic then return end
    pcall(function()
        for _, id in ipairs(dynamic:GetTaggedIDs(CName.new(M.TAG)) or {}) do dynamic:DeleteEntity(id) end
    end)
end

-- Cameras switched off by a cleanup, deleted once LENS_DELAY has passed (from update, which runs while any wait).
local function releaseLenses(elapsed)
    local waiting = {}
    for _, lens in ipairs(M.lenses or {}) do
        lens.wait = lens.wait - (tonumber(elapsed) or 0)
        if lens.wait <= 0 then deleteTagged(lens.id) else waiting[#waiting + 1] = lens end
    end
    M.lenses = #waiting > 0 and waiting or nil
end

local function workspot()
    if M.workspot == nil then
        local ok, module = pcall(dofile, 'gesture-workspot.lua')
        M.workspot = ok and type(module) == 'table' and module or false
    end
    return M.workspot or nil
end

-- The talk pose the copy is held in: the character's own talk family, its rig's, or the generic one.
local function holdComponent(record)
    -- The gesture catalogue is large: read once, on the first live picture only.
    if M.gestures == nil then
        local ok, value = pcall(dofile, 'gesture-catalog.lua')
        M.gestures = ok and type(value) == 'table' and type(value.families) == 'table' and value or false
    end
    local catalog = M.gestures
    if not catalog then return nil, nil end
    local character = type(catalog.characters) == 'table' and catalog.characters[record] or nil
    local family = character and catalog.families[character.talk]
    if not family and character and type(catalog.generic) == 'table' and type(catalog.generic.rigs) == 'table' then
        local rig = catalog.generic.rigs[character.rig]
        family = rig and catalog.families[rig.talk]
    end
    family = family or catalog.families.on_sides
    return catalog.device, family and family.component
end

-- Where the camera stands for a copy whose feet are at `feet` facing `yaw` (degrees; the game's forward at yaw t is
-- (-sin t, cos t)): in front of the copy, SHOT.orbit degrees round, at the frame's centre height, looking back at it.
function M.rig(feet, yaw)
    local shot = M.SHOT
    local dist = (shot.frameH * 0.5) / math.tan(math.rad(shot.fov * 0.5))
    local bearing = yaw + shot.orbit
    local radians = math.rad(bearing)
    return {x = feet.x - math.sin(radians) * dist, y = feet.y + math.cos(radians) * dist, z = feet.z + shot.aimZ,
        yaw = bearing + 180, dist = dist}
end

-- The nearest solid point between a and b over M.GROUPS: the point, false when the segment is clear, nil when the game
-- could not answer (nothing unanswered ever counts as clear).
local function trace(a, b)
    local ok, result = pcall(function()
        local spatial = Game.GetSpatialQueriesSystem()
        local from, to = Vector4.new(a.x, a.y, a.z, 1), Vector4.new(b.x, b.y, b.z, 1)
        local best, bestDistance = false, math.huge
        for _, group in ipairs(M.GROUPS) do
            local hit, out = spatial:SyncRaycastByCollisionGroup(from, to, CName.new(group), false, false)
            if type(hit) ~= 'boolean' then return nil end
            if hit then
                local p = out and out.position
                local point = p and {x = tonumber(p.x), y = tonumber(p.y), z = tonumber(p.z)} or nil
                if not point or not point.x or not point.y or not point.z then return nil end
                local distance = (point.x - a.x)^2 + (point.y - a.y)^2 + (point.z - a.z)^2
                if distance < bestDistance then best, bestDistance = point, distance end
            end
        end
        return best
    end)
    if not ok then return nil end
    return result
end

local function clear(a, b) return trace(a, b) == false end

-- Is the column (x, y) a studio: a level floor between `range.bottom` and `range.top` (offsets from V's z; STUDIO_MIN to
-- STUDIO_TOP above V when absent) with headroom, out of V's sight, with room for the camera on one side? `below` (an
-- absolute z, optional) looks only under it: the next floor down, under one that would not do. The spot {x, y, z, yaw},
-- or nil, why not and the z of the floor that was judged (nil when there was none).
function M.studioAt(origin, x, y, range, below)
    local top = below or origin.z + (range and range.top or M.STUDIO_TOP)
    local bottom = origin.z + (range and range.bottom or M.STUDIO_MIN)
    if top <= bottom then return nil, 'no-floor' end
    local floor = trace({x = x, y = y, z = top}, {x = x, y = y, z = bottom})
    if floor == nil then return nil, 'no-answer' end
    if not floor then return nil, 'no-floor' end
    local z = floor.z
    -- A hit where the ray starts is the inside of something, not a floor.
    if z > top - 0.5 then return nil, 'inside', z end
    if not clear({x = x, y = y, z = z + 0.2}, {x = x, y = y, z = z + 2.5}) then return nil, 'no-headroom', z end
    for _, d in ipairs({{0.35, 0}, {-0.35, 0}, {0, 0.35}, {0, -0.35}}) do
        local under = trace({x = x + d[1], y = y + d[2], z = z + 0.5}, {x = x + d[1], y = y + d[2], z = z - 0.5})
        if not under or math.abs(under.z - z) > 0.2 then return nil, 'not-level', z end
    end
    -- V must not see the copy: something solid between V's eyes and its chest.
    local eyes = {x = origin.x, y = origin.y, z = origin.z + 1.6}
    local cover = trace(eyes, {x = x, y = y, z = z + 1.2})
    if cover == nil then return nil, 'no-answer' end
    if cover == false then return nil, 'in-view', z end
    -- The first facing whose camera spot (a little beyond it, too) is open from the copy's face.
    for _, yaw in ipairs({0, 90, 180, 270}) do
        local lens = M.rig({x = x, y = y, z = z}, yaw)
        local face = {x = x, y = y, z = z + M.SHOT.aimZ}
        local scale = (lens.dist + 0.3) / lens.dist
        local beyond = {x = x + (lens.x - x) * scale, y = y + (lens.y - y) * scale, z = lens.z}
        if clear(face, beyond) then return {x = x, y = y, z = z, yaw = yaw} end
    end
    return nil, 'no-lens-room', z
end

-- The columns searched, in order: the near ones (straight above or below V and eight round V on each of NEAR_RADII, a
-- floor within NEAR_TOP/NEAR_BOTTOM, tried floor by floor, kept only within FACE_RANGE of V), straight above V, eight
-- around at STUDIO_RADIUS (both with a floor above V), then rings round V at LOW_RADII with a floor level with or below
-- V. Each: {x, y, range, near}.
local function columns(origin)
    local above = {top = M.STUDIO_TOP, bottom = M.STUDIO_MIN}
    local low = {top = M.LOW_TOP, bottom = M.LOW_BOTTOM}
    local near = {top = M.NEAR_TOP, bottom = M.NEAR_BOTTOM}
    local list = {{x = origin.x, y = origin.y, range = near, near = true}}
    for ring, radius in ipairs(M.NEAR_RADII) do
        for i = 0, 7 do
            local a = math.rad(i * 45 + (ring % 2 == 1 and 22.5 or 0))
            list[#list + 1] = {x = origin.x + math.cos(a) * radius, y = origin.y + math.sin(a) * radius,
                range = near, near = true}
        end
    end
    list[#list + 1] = {x = origin.x, y = origin.y, range = above}
    for i = 0, 7 do
        local a = math.rad(i * 45)
        list[#list + 1] = {x = origin.x + math.cos(a) * M.STUDIO_RADIUS, y = origin.y + math.sin(a) * M.STUDIO_RADIUS, range = above}
    end
    for ring, radius in ipairs(M.LOW_RADII) do
        for i = 0, 7 do
            local a = math.rad(i * 45 + (ring % 2 == 0 and 22.5 or 0))
            list[#list + 1] = {x = origin.x + math.cos(a) * radius, y = origin.y + math.sin(a) * radius, range = low}
        end
    end
    return list
end

-- "no-floor=24, in-view=6": why the columns failed, most common first.
local function reasonSummary(counts)
    local names = {}
    for name in pairs(counts) do names[#names + 1] = name end
    table.sort(names, function(x, y) if counts[x] ~= counts[y] then return counts[x] > counts[y] end return x < y end)
    for i, name in ipairs(names) do names[i] = name .. '=' .. counts[name] end
    return table.concat(names, ', ')
end

local function holoFail(call, reason)
    local holo = call.holo
    if not holo or holo.failed then return end
    holo.failed, holo.reason = true, reason
    log('holo failed contact=' .. call.contact .. ' reason=' .. tostring(reason) .. ' fallback=audio')
end

-- The character's own record, as a real character record (a name that does not resolve would spawn a body with no
-- record, which crashes a few seconds later).
local function characterRecord(name)
    local ok, valid = pcall(function()
        local record = TweakDB:GetRecord(TweakDBID.new(name))
        return record ~= nil and record:IsA('gamedataCharacter_Record')
    end)
    return ok and valid == true
end

local function holoBegin(call, player)
    local holo = {wait = 0, stage = 'search', column = 1, reasons = {}}
    call.holo = holo
    if not call.record then holoFail(call, 'no-record'); return end
    if not characterRecord(call.record) then holoFail(call, 'record-unavailable'); return end
    local ok, origin = pcall(function()
        local p = player:GetWorldPosition()
        return {x = p.x, y = p.y, z = p.z}
    end)
    if not ok or not origin then holoFail(call, 'no-position'); return end
    holo.origin, holo.columns = origin, columns(origin)
end

local function spawned(id)
    local dynamic = system()
    if not dynamic or not id then return nil end
    local ok, entity = pcall(function()
        if not dynamic:IsSpawned(id) then return nil end
        return Game.FindEntityByID(id)
    end)
    return ok and entity or nil
end

-- Where a lamp of the rig stands for a copy whose feet are at `feet` facing `yaw` (the same convention as M.rig).
function M.lightAt(feet, yaw, light)
    local radians = math.rad(yaw + light.bearing)
    return {x = feet.x - math.sin(radians) * light.dist, y = feet.y + math.cos(radians) * light.dist, z = feet.z + light.height}
end

-- The rig's lamps, tagged and transient like the copy. A lamp that cannot be created is left out: the picture goes on.
local function holoLightsSpawn(holo, spot)
    holo.lights = {}
    local dynamic = system()
    if not dynamic then return end
    for _, light in ipairs(M.LIGHTS) do
        pcall(function()
            local at = M.lightAt(spot, spot.yaw, light)
            local spec = NewObject('DynamicEntitySpec')
            if not pcall(function() spec.templatePath = M.LIGHT_TEMPLATE end) then spec.templatePath = ResRef.FromString(M.LIGHT_TEMPLATE) end
            spec.position = Vector4.new(at.x, at.y, at.z, 1)
            spec.orientation = EulerAngles.new(0, 0, spot.yaw):ToQuat()
            spec.persistState, spec.persistSpawn = false, false
            spec.alwaysSpawned, spec.spawnInView, spec.active = true, true, true
            spec.tags = {CName.new(M.TAG)}
            local id = dynamic:CreateEntity(spec)
            if id and not tostring(id.hash):match('^0+[uUlL]*$') then holo.lights[#holo.lights + 1] = {light = light, id = id} end
        end)
    end
end

-- Switch one lamp on with its role's settings: its mesh and collider off, its light on. True once the light is on.
local function lightOn(lamp, entity)
    local ok = pcall(function()
        local spec = lamp.light
        for _, component in ipairs(entity:GetComponents() or {}) do
            local class = NameToString(component:GetClassName())
            if class == 'entMeshComponent' or class == 'entColliderComponent' then
                component:Toggle(false)
            elseif class == 'gameLightComponent' then
                component:ToggleLight(true)
                component:SetIntensity(spec.lumen)
                component:SetRadius(M.LIGHT_RADIUS)
                component:SetColor(Color.new({Red = spec.color[1], Green = spec.color[2], Blue = spec.color[3], Alpha = 255}))
                lamp.component = component
            end
        end
    end)
    if not ok or not lamp.component then return false end
    local on, value = pcall(function() return lamp.component:IsOn() end)
    return not on or value ~= false
end

-- Light every lamp that has spawned and is not lit yet; with `check`, also relight a lit one the game switched off. The
-- number lit. Runs only from the call's 0.25 s step, and once all are lit only every LOOK_REFRESH seconds.
local function holoLight(holo, check)
    local lit = 0
    for _, lamp in ipairs(holo.lights or {}) do
        if lamp.lit and check then
            local ok, on = pcall(function() return lamp.component:IsOn() end)
            if ok and on == false then lamp.lit = false end
        end
        if not lamp.lit then
            local entity = spawned(lamp.id)
            if entity then lamp.lit = lightOn(lamp, entity) end
        end
        if lamp.lit then lit = lit + 1 end
    end
    holo.lit = lit
    return lit
end

-- Spawn the copy at the studio spot and the camera at its rig, both tagged and transient.
local function holoSpawn(call, holo)
    local spot = holo.spot
    local ok, err = pcall(function()
        local dynamic = system()
        assert(dynamic and dynamic:IsReady(), 'entity system not ready')
        holo.anchor = {x = spot.x, y = spot.y, z = spot.z}
        local copy = NewObject('DynamicEntitySpec')
        copy.recordID = TweakDBID.new(call.record)
        copy.position = Vector4.new(spot.x, spot.y, spot.z, 1)
        copy.orientation = EulerAngles.new(0, 0, M.bodyYaw(spot)):ToQuat()
        copy.persistState, copy.persistSpawn = false, false
        copy.alwaysSpawned, copy.spawnInView, copy.active = true, true, true
        -- The companion tag gives the copy the speech face layer (Face.reds) before it attaches.
        copy.tags = {CName.new(M.COMPANION_TAG), CName.new(M.TAG)}
        holo.copyId = dynamic:CreateEntity(copy)
        assert(holo.copyId and not tostring(holo.copyId.hash):match('^0+[uUlL]*$'), 'copy was not created')
        local lens = M.rig(spot, spot.yaw)
        holo.lens = lens
        local camera = NewObject('DynamicEntitySpec')
        if not pcall(function() camera.templatePath = M.CAMERA end) then camera.templatePath = ResRef.FromString(M.CAMERA) end
        camera.position = Vector4.new(lens.x, lens.y, lens.z, 1)
        camera.orientation = EulerAngles.new(0, 0, lens.yaw):ToQuat()
        camera.persistState, camera.persistSpawn = false, false
        camera.alwaysSpawned, camera.spawnInView, camera.active = true, true, true
        camera.tags = {CName.new(M.TAG)}
        holo.cameraId = dynamic:CreateEntity(camera)
        assert(holo.cameraId and not tostring(holo.cameraId.hash):match('^0+[uUlL]*$'), 'camera was not created')
    end)
    if not ok then holoFail(call, 'spawn: ' .. tostring(err)) return end
    holoLightsSpawn(holo, spot)
    holo.stage = 'spawn'
    local o = holo.origin
    -- The face animates only this near V (M.FACE_RANGE): only then does the copy get the companions' face (M.faceRow).
    holo.faceNear = (spot.x - o.x)^2 + (spot.y - o.y)^2 + (spot.z - o.z)^2 <= M.FACE_RANGE^2
    log(string.format('holo spawn contact=%s record=%s floor=%+.1fm away=%.1fm yaw=%d body=%.1f lens=%.2fm', call.contact,
        call.record, spot.z - o.z, math.sqrt((spot.x - o.x)^2 + (spot.y - o.y)^2 + (spot.z - o.z)^2), spot.yaw,
        M.bodyYaw(spot), holo.lens.dist))
end


local function drift(holo)
    local ok, distance = pcall(function()
        local p, a = holo.npc:GetWorldPosition(), holo.anchor
        return math.sqrt((p.x - a.x)^2 + (p.y - a.y)^2 + (p.z - a.z)^2)
    end)
    return ok and distance or math.huge
end

-- The copy looks into the lens as the game's holocall scenes aim their caller (judy_holocall.scene, scnLookAtEvent
-- preset "Eyes & Head": eyes leading, the chest turned with weight 2, transition speed 80, nothing suppressed), with the
-- head a little stronger than the game's 0.1 (M.LOOK_HEAD): this camera stands 20.4 degrees round and the game's 0.1 left
-- her face visibly short of the lens. Any earlier request of ours is retired first so only one is ever live.
local function holoLook(holo)
    if not holo.npc or not holo.camera then return false end
    local ok = pcall(function()
        if holo.look then
            LookAtRemoveEvent.QueueRemoveLookatEvent(holo.npc, holo.look)
            holo.look = nil
        end
        local event = LookAtAddEvent.new()
        event:SetEntityTarget(holo.camera, CName.new(''), Vector4.new(0, 0, 0, 0))
        event:SetStyle(Enum.new('animLookAtStyle', 'Normal'))
        event.bodyPart = CName.new('Eyes')
        event.request.transitionSpeed = 80
        event.request.limits.softLimitDegrees = 360
        event.request.limits.hardLimitDegrees = 270
        event.request.limits.backLimitDegrees = 210
        event.request.limits.hardLimitDistance = 1000000
        local head = LookAtPartRequest.new()
        head.partName, head.weight, head.suppress, head.mode = CName.new('Head'), M.LOOK_HEAD, 0, 0
        local chest = LookAtPartRequest.new()
        chest.partName, chest.weight, chest.suppress, chest.mode = CName.new('Chest'), M.LOOK_CHEST, 0, 0
        event:SetAdditionalPartsArray({head, chest})
        holo.look = event
        holo.npc:QueueEvent(event)
    end)
    holo.lookAge = 0
    return ok
end

-- One step of the live picture while the call rings: search one floor candidate, or wait for the copy and camera,
-- keep the copy animating, hold it in its talk pose, switch the camera on and turn the copy's eyes to it.
local function holoStep(call, dt)
    local holo = call.holo
    if not holo or holo.failed or holo.ready then return end
    holo.wait = holo.wait + dt
    if holo.stage == 'search' then
        for _ = 1, M.SEARCH_PER_TICK do
            local column = holo.columns[holo.column]
            if not column then holoFail(call, 'no-studio-spot (' .. reasonSummary(holo.reasons) .. ')'); return end
            local spot, reason, floor = M.studioAt(holo.origin, column.x, column.y, column.range, holo.below)
            if spot and column.near then
                local o = holo.origin
                if (spot.x - o.x)^2 + (spot.y - o.y)^2 + (spot.z - o.z)^2 > M.FACE_RANGE^2 then spot, reason = nil, 'far' end
            end
            if spot then
                holo.spot = spot
                holoSpawn(call, holo)
                return
            end
            -- A near column goes on with the floor under this one (while that is still within its range); any other
            -- column, or the last floor, is done. A column's reason is its last floor's that says more than no-floor.
            if reason ~= 'no-floor' or not holo.why then holo.why = reason end
            holo.layer = (holo.layer or 1) + 1
            local below = floor and floor - 0.3
            if column.near and below and below > holo.origin.z + column.range.bottom and holo.layer <= M.NEAR_LAYERS then
                holo.below = below
            else
                holo.reasons[holo.why] = (holo.reasons[holo.why] or 0) + 1
                holo.column, holo.below, holo.layer, holo.why = holo.column + 1, nil, 1, nil
            end
        end
        return
    end
    if holo.wait > M.RING_MAX then holoFail(call, 'placement-timeout'); return end
    holo.npc = holo.npc or spawned(holo.copyId)
    holo.camera = holo.camera or spawned(holo.cameraId)
    if holo.npc and holo.forced == nil then
        -- Off screen, the copy's animation would be culled: it would stand frozen and its face would not move.
        -- Asked once; cleanup clears it again before the copy is deleted.
        holo.forced = pcall(function() Game.GetAnimationSystem():SetForcedVisible(holo.copyId, true) end)
    end
    holoLight(holo)
    if not holo.npc or not holo.camera then return end
    if not holo.held then
        local spots = workspot()
        local template, component = holdComponent(call.record)
        if not spots or not template or not component then holoFail(call, 'no-talk-pose'); return end
        local created, device = spots.spawnDevice(holo.npc, template)
        if not created then holoFail(call, 'device: ' .. tostring(device)); return end
        holo.deviceId, holo.component, holo.held = device, component, 'waiting'
    end
    if holo.held == 'waiting' then
        local spots = workspot()
        local device = spots.deviceEntity(holo.deviceId)
        if device == false then holoFail(call, 'device-lost'); return end
        if not device then return end
        local played, err = spots.play(device, holo.npc, holo.component)
        if not played then holoFail(call, 'hold: ' .. tostring(err)); return end
        holo.held = 'yes'
    end
    local camera = holo.camera
    local switched, err = pcall(function()
        local component = camera:FindComponentByName(CName.new(M.CAMERA_COMPONENT))
        assert(component, 'no ' .. M.CAMERA_COMPONENT .. ' component')
        -- The black backdrop (M.BACKDROP); without the window's backing, or a camera without the field, she is filmed
        -- with the world behind her as before.
        holo.backdrop = call.backing == true and pcall(function() component.depthCutDistance = holo.lens.dist + M.BACKDROP end)
        component:Toggle(true)
    end)
    if not switched then holoFail(call, 'camera: ' .. tostring(err)); return end
    holo.cameraOn = true
    pcall(function() holo.npc:ConvaiFaceRequest() end)
    local identity = pcall(function() holo.entity = tostring(holo.npc:GetEntityID().hash) end)
    if not identity then holoFail(call, 'copy-identity'); return end
    local looked = holoLook(holo)
    holo.ready = true
    log('holo ready contact=' .. call.contact .. ' held=' .. tostring(holo.held) .. ' camera=on animated='
        .. tostring(holo.forced == true) .. ' look=' .. tostring(looked) .. string.format(' drift=%.2f', drift(holo))
        .. ' lights=' .. tostring(holo.lit or 0) .. '/' .. #(holo.lights or {}) .. ' backdrop=' .. tostring(holo.backdrop == true))
end

local function holoValid(call)
    local holo = call.holo
    if not holo or not holo.ready or holo.failed or not holo.npc then return false end
    local ok, attached = pcall(function() return holo.npc:IsAttached() end)
    if not ok or not attached then return false end
    return drift(holo) <= M.HOLO_DRIFT
end

-- Undo everything the live picture did, in order: the look, the forced animation, the lamps, the pose, then the camera
-- (switched off now, deleted LENS_DELAY later) and the copy.
local function holoCleanup(holo)
    if not holo or holo.cleaned then return end
    holo.cleaned = true
    if holo.look and holo.npc then
        pcall(function() LookAtRemoveEvent.QueueRemoveLookatEvent(holo.npc, holo.look) end)
        holo.look = nil
    end
    if holo.forced == true and holo.copyId then
        pcall(function() Game.GetAnimationSystem():SetForcedVisible(holo.copyId, false) end)
        holo.forced = false
    end
    -- The lamps go out now and are deleted with the copy (they hold no render target).
    for _, lamp in ipairs(holo.lights or {}) do
        if lamp.component then pcall(function() lamp.component:ToggleLight(false) end) end
        deleteTagged(lamp.id)
    end
    holo.lights = nil
    local spots = holo.held and workspot()
    if spots and holo.npc then pcall(spots.exit, holo.npc, true) end
    if spots and holo.deviceId then pcall(spots.deleteDevice, holo.deviceId) end
    if holo.cameraId then
        if holo.cameraOn and holo.camera then
            pcall(function() holo.camera:FindComponentByName(CName.new(M.CAMERA_COMPONENT)):Toggle(false) end)
            M.lenses = M.lenses or {}
            M.lenses[#M.lenses + 1] = {id = holo.cameraId, wait = M.LENS_DELAY}
        else
            deleteTagged(holo.cameraId)
        end
    end
    deleteTagged(holo.copyId)
end

local function notifyEnded(player, call, reason)
    -- V hung up, called again, or the game's own call took over (its window shows): no notice.
    if reason == 'hangup' or reason == 'replaced' or reason == 'quest-call' or not player then return end
    convaiNotices.send(player, 'holocall-ended', reason == 'combat' and ui.t('Holocall ended: combat started.')
        or ui.t('Holocall with {name} ended.', {name = call.name}))
end

function M.finish(player, reason)
    local call = M.call
    if not call then return false end
    M.call = nil
    if player then pcall(function() player:ConvaiHolocallEnd() end) end
    holoCleanup(call.holo)
    log('state=ended contact=' .. call.contact .. ' reason=' .. tostring(reason) .. ' length=' .. math.floor(call.age) .. 's')
    if type(M.env.onEnded) == 'function' then pcall(M.env.onEnded, call, reason) end
    notifyEnded(player, call, reason)
    return true
end

-- The world went away (a load, death, the game shutting down): forget the call without native calls. The HUD and its
-- window are rebuilt by the game; a copy or camera left behind is swept after the next configure.
function M.abandon(reason)
    M.request, M.lenses = nil, nil
    local call = M.call
    if not call then return end
    M.call = nil
    M.sweepDue = true
    log('state=ended contact=' .. call.contact .. ' reason=' .. tostring(reason or 'abandoned') .. ' length=' .. math.floor(call.age) .. 's')
end

local function refuse(player, contact, reason, text)
    log('refused contact=' .. tostring(contact) .. ' reason=' .. reason)
    if text then convaiNotices.send(player, 'holocall-refused', text) end
    return false
end

function M.start(player, contact, sample)
    if M.call then
        local same = M.call.contact == contact
        M.finish(player, 'replaced')
        -- Calling the same character again from the phone hangs up.
        if same then return false end
    end
    local entry = M.catalog[contact]
    if not entry then return refuse(player, contact, 'not-a-mod-character', ui.t('This contact cannot take a holocall.')) end
    if type(M.env.supported) == 'function' and not M.env.supported(entry.key) then
        return refuse(player, contact, 'no-profile', ui.t('This contact cannot take a holocall.'))
    end
    if type(M.env.profileEnabled) == 'function' and not M.env.profileEnabled(entry.key) then
        return refuse(player, contact, 'disabled', ui.t('Conversations are disabled for this contact.'))
    end
    local blocked = M.blocked(sample)
    if blocked then
        return refuse(player, contact, blocked, blocked == 'combat' and ui.t('Calls are not available during combat.')
            or blocked == 'quest-call' and ui.t('You are already on a call.') or ui.t('Calls are not available right now.'))
    end
    -- Events queue on the player whenever the phone HUD is torn down or the game takes a call, with or without a call of ours; the queue
    -- is only read while one runs. Left in place, an old "hud-lost" or "quest-call" would hang up this call on its first step.
    for _ = 1, 8 do
        local ok, event = pcall(function() return player:ConvaiHolocallTakeEvent() end)
        if not ok or type(event) ~= 'string' or event == '' then break end
    end
    local began, result = pcall(function() return player:ConvaiHolocallBegin(contact) end)
    result = began and type(result) == 'string' and result or 'no-hud'
    if result ~= 'ok' then
        return refuse(player, contact, result, result == 'quest-call' and ui.t('You are already on a call.')
            or result == 'unknown-contact' and ui.t('This contact cannot take a holocall.')
            or ui.t('Calls are not available right now.'))
    end
    local identity, entity = pcall(function() return tostring(player:GetEntityID().hash) end)
    local backed, backing = pcall(function() return player:ConvaiHolocallHasBacking() end)
    M.serial = M.serial + 1
    -- A video holocall for the characters the game stages one for; the portrait voice call for everyone else.
    local cast = M.STAGED[contact] and entry.record and 'video' or 'voice'
    local call = {serial = M.serial, contact = contact, key = entry.key, name = entry.name, record = entry.record,
        state = 'dialing', mode = 'audio', entity = identity and entity or nil, ring = 0, age = 0, idle = 0, tick = 0,
        cast = cast, backing = backed and backing == true, wantLive = cast == 'video' and type(M.env.liveImage) == 'function' and M.env.liveImage() == true}
    M.call = call
    if type(M.env.warm) == 'function' then pcall(M.env.warm, call.key, call.entity) end
    log('state=dialing contact=' .. contact .. ' profile=' .. call.key .. ' mode=' .. (call.wantLive and 'holo' or 'audio')
        .. ' cast=' .. cast .. ' hud=ok')
    if call.wantLive then holoBegin(call, player) end
    return true
end

local function connect(call, player)
    local live = call.wantLive and call.holo ~= nil and call.holo.ready == true and not call.holo.failed
    if call.wantLive and not live then
        holoFail(call, call.holo and call.holo.reason or 'not-ready')
        convaiNotices.send(player, 'holocall-live-fallback', ui.t('Live picture unavailable. The call continues with the portrait.'))
        holoCleanup(call.holo)
    end
    local ok, window = pcall(function() return player:ConvaiHolocallConnect(live) end)
    window = ok and type(window) == 'string' and window or 'ended'
    if window == 'ended' then return M.finish(player, 'hud-lost') end
    call.state, call.mode, call.window, call.idle = 'connected', live and 'holo' or 'audio', window, 0
    log('state=connected contact=' .. call.contact .. ' mode=' .. call.mode .. ' window=' .. window .. ' ready='
        .. tostring(call.ready or 'n/a') .. string.format(' ring=%.1fs', call.ring))
    convaiNotices.send(player, 'holocall-connected', ui.t('Holocall with {name}. Tap the phone button to hang up.', {name = call.name}))
    if type(M.env.onConnected) == 'function' then pcall(M.env.onConnected, call) end
end

local EVENTS = {hangup = 'hangup', ['quest-call'] = 'quest-call', ['hud-lost'] = 'hud-lost'}

local function step(call, player, dt, sample)
    for _ = 1, 4 do
        local ok, event = pcall(function() return player:ConvaiHolocallTakeEvent() end)
        if not ok or type(event) ~= 'string' or event == '' then break end
        if EVENTS[event] then return M.finish(player, EVENTS[event]) end
    end
    local blocked = M.blocked(sample)
    if blocked then return M.finish(player, blocked) end
    if type(M.env.profileEnabled) == 'function' and not M.env.profileEnabled(call.key) then return M.finish(player, 'disabled') end
    call.age = call.age + dt
    if call.state == 'dialing' then
        call.ring = call.ring + dt
        if call.wantLive then holoStep(call, dt) end
        local settled = not call.wantLive or not call.holo or call.holo.ready or call.holo.failed
        if call.ring >= M.RING_MIN and (settled or call.ring >= M.RING_MAX) then
            -- Her conversation is ready (asked at most once per tick, only once the picture has settled), or the
            -- ring has waited long enough.
            if call.ready == nil and (type(M.env.ready) ~= 'function' or M.env.ready(call.key) == true) then
                call.ready = 'yes'
            end
            if not call.ready and call.ring >= M.READY_MAX then call.ready = 'timeout' end
            if call.ready then connect(call, player) end
        end
        return
    end
    if call.mode == 'holo' and not holoValid(call) then
        -- The copy fell, streamed out or was moved: the call goes on with the portrait.
        holoFail(call, 'copy-lost')
        holoCleanup(call.holo)
        call.mode = 'audio'
        local ok, window = pcall(function() return player:ConvaiHolocallConnect(false) end)
        call.window = ok and window or 'ended'
        log('state=connected contact=' .. call.contact .. ' mode=audio window=' .. tostring(call.window))
        convaiNotices.send(player, 'holocall-live-fallback', ui.t('Live picture unavailable. The call continues with the portrait.'))
        if call.window == 'ended' then return M.finish(player, 'hud-lost') end
    end
    if call.mode == 'holo' then
        local holo = call.holo
        holo.lookAge = (holo.lookAge or 0) + dt
        local refresh = holo.lookAge >= M.LOOK_REFRESH
        if refresh then holoLook(holo) end
        -- A lamp that spawned after the picture was ready is lit on the next step; a lit rig is only checked on the
        -- look's beat (relit if the game switched a lamp off).
        local lights = #(holo.lights or {})
        if lights > 0 and ((holo.lit or 0) < lights or refresh) then
            local before = holo.lit or 0
            if holoLight(holo, refresh) == lights and before < lights then
                log('holo lit contact=' .. call.contact .. ' lights=' .. lights .. '/' .. lights)
            end
        end
    end
    if call.window == 'pending' then
        -- The window was still being created when the call connected: show it once it exists.
        local ok, window = pcall(function() return player:ConvaiHolocallConnect(call.mode == 'holo') end)
        window = ok and window or 'ended'
        if window == 'ended' then return M.finish(player, 'hud-lost') end
        if window ~= 'pending' then call.window = window; log('window=' .. window .. ' contact=' .. call.contact) end
    end
    local busy = type(M.env.busy) == 'function' and M.env.busy(call) == true
    if busy then call.idle = 0 else call.idle = call.idle + dt end
    if call.idle >= M.IDLE_LIMIT then return M.finish(player, 'idle') end
    if call.age >= M.MAX_LENGTH then return M.finish(player, 'max-length') end
end

-- The phone's request drain (init.lua phoneDrainDue): while the phone is open, briefly after, and once a second.
function M.drain(player)
    if not player then return end
    if M.sweepDue then M.sweep() end
    local ok, contact = pcall(function() return player:ConvaiHolocallTakeRequest() end)
    if not ok or type(contact) ~= 'string' or contact == '' then return end
    M.request = {contact = contact}
    log('requested contact=' .. contact)
end

-- From the 0.1 s game tick. A request starts once the world is playable (the phone has closed); a call advances only
-- while the world is playable, every TICK seconds.
function M.update(player, elapsed, worldReady, sample)
    if not M.request and not M.call and not M.lenses then return end
    if not player or not worldReady then return end
    if M.lenses then releaseLenses(elapsed) end
    if M.request then
        local request = M.request
        M.request = nil
        M.start(player, request.contact, sample)
    end
    local call = M.call
    if not call then return end
    call.tick = call.tick + (tonumber(elapsed) or 0)
    if call.tick < M.TICK then return end
    local dt = call.tick
    call.tick = 0
    step(call, player, dt, sample)
end

function M.connected()
    return M.call ~= nil and M.call.state == 'connected'
end

-- The live picture's copy as a row of the face layer (companions.expressionActors appends it, at its 0.1 s rebuild):
-- she gets the mod characters' own face, as a spawned companion does: the resting smile, the reply's emotion lingering
-- after it, the mood hold after a sad or angry turn, and blinks (mod/facial-playback.lua). Only while the picture is live
-- and the studio is within FACE_RANGE of V (a farther face does not animate). One table per call, built on first use.
function M.faceRow()
    local call = M.call
    local holo = call and call.mode == 'holo' and call.holo
    if not holo or not holo.ready or holo.failed or holo.cleaned or not holo.faceNear or not holo.npc or not holo.entity then
        return nil
    end
    local row = holo.faceRow
    if not row then
        row = {npc = holo.npc, entity = holo.entity, profileKey = call.key, name = call.name}
        holo.faceRow = row
    end
    return row
end

-- Is this actor the live picture's copy, with its face row on (the face layer's ownership check)?
function M.ownsFace(actor)
    local row = M.faceRow()
    if not row or not actor then return false end
    local ok, id = pcall(function() return tostring(actor:GetEntityID().hash) end)
    return ok and id == row.entity
end

-- A turn was sent to the call's character: the idle timer starts again.
function M.touch()
    if M.call then M.call.idle = 0 end
end

-- The conversation partner the talk keys address while a call is connected (the shape of init.lua selectConversation's
-- result), or nil. Group chat keeps its usual nearby partners.
function M.partner(player, groupMode)
    local call = M.call
    if groupMode or not call or call.state ~= 'connected' or not player then return nil end
    local holo = call.holo
    if call.mode == 'holo' and holo and holo.ready and holo.npc and holo.entity then
        return {npc = holo.npc, name = call.name, entity = holo.entity, bodyType = '', profileKey = call.key,
            holocall = {version = 1, contact = call.contact, mode = 'holo'}}
    end
    if not call.entity then return nil end
    return {npc = player, name = call.name, entity = call.entity, bodyType = '', profileKey = call.key, voiceOnly = true,
        holocall = {version = 1, contact = call.contact, mode = 'audio'}}
end

-- Is the call a recording or reply was started for still the live call (the microphone's target check)?
function M.partnerValid(context)
    local call = M.call
    if not call or call.state ~= 'connected' or type(context) ~= 'table' or type(context.holocall) ~= 'table'
        or context.holocall.contact ~= call.contact then return false end
    if context.holocall.mode == 'holo' then
        return call.mode == 'holo' and holoValid(call) and context.entity == call.holo.entity
    end
    return context.entity == call.entity
end

convaiHolocall = M
return M
