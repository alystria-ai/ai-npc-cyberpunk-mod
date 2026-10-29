local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end
-- Development tools for the housemates (docs/HOUSEMATES.md, "Phase 0"): measuring V's flats, qualifying the saved facts, and driving the feature
-- without a conversation. Reached through the gesture probe (mod/gesture-probe.lua command `housemate`; scripts/Send-GestureProbe.ps1 "housemate ...").
-- Never loaded by the mod itself and never run for a player. The measuring commands write plain text lines to runtime/housemate-survey.txt
-- that can be pasted into mod/housemate-spots-data.lua (give the entry conf = 'M'). The commands that change the game (teleport, own, qualify)
-- are for a THROWAWAY COPY of a save, never a save that matters.
--
--   housemate help
--   housemate where                         V's district, position, yaw, the flat id, the fact values that matter there
--   housemate status                        the registry, the learned seats of V, the controller's residents
--   housemate record <kind> <id> [note]     V stands (or sits, or lies) on the spot: its pose is written as a spot line
--   housemate bed <id>                      V lies in the bed: the width of the bed both sides of V is measured, the slots are suggested
--   housemate window <id>                   V stands facing the window: the point V looks at is the glass
--   housemate door <apartment>              V stands at the door: the position is written
--   housemate scan [radius]                 raycasts the surfaces around V at seat height and lists the clusters (couches, chairs, stools, beds)
--   housemate teleport <apartment>          V is moved to the flat's entrance (best-effort coordinates, see TELEPORT)
--   housemate own <apartment> [0|1]         sets the apartment's purchase fact (a throwaway save only)
--   housemate qualify write|read            the saved-fact check of the registry (docs/HOUSEMATES.md, live check 1)
--   housemate stay <profileKey> <apartment> / out <profileKey>       move somebody in or out without a conversation
--   housemate chat / greet                  start a pair chat now (cooldown cleared) / ask for the welcome line
--   housemate reserved                      every reserved fact of the flat V is in, with its value
local registry = dofile('housemate-registry.lua')
local M = {}

local OUT = 'runtime/housemate-survey.txt'
local KINDS = {couch = true, chair = true, bar = true, stool = true, lean = true, stand = true, window = true, sink = true, bed = true}
-- Where the flats' entrances are (world coordinates, yaw). Corpo Plaza and H10 are interior points; the others are the entrances the map lists
-- and may be a lobby or a street level, from which the way up is a lift (record the real door with `housemate door`).
local TELEPORT = {
    h10 = {-1391.87, 1271.69, 123.08, -99.25}, corpo = {-1606.33, 362.66, 49.21, 174.2},
    north = {-1503.80, 2224.92, 22.20, 45.95}, japan = {-785.34, 992.63, 12.03, 178.5}, glen = {-1523.97, -992.57, 9.11, 4.78},
}
local PURCHASE = {corpo = 'dlc6_apart_cct_dtn_purchased', glen = 'dlc6_apart_hey_gle_purchased', japan = 'dlc6_apart_wbr_jpn_purchased',
    north = 'dlc6_apart_wat_nid_purchased'}
local DISTRICT = {LittleChina_VApartment = 'h10', CorpoPlaza_Apartment = 'corpo', Glen_Apartment = 'glen', JapanTown_Apartment = 'japan',
    Northside_Apartment = 'north'}

local function round(value, places) local m = 10 ^ (places or 2) return math.floor(value * m + 0.5) / m end
local function player() return convaiPlayer() end
local function pose()
    local p = player()
    local at, e = p:GetWorldPosition(), p:GetWorldOrientation():ToEulerAngles()
    return {x = round(at.x), y = round(at.y), z = round(at.z), yaw = round(e.yaw, 1)}
end
local function append(line)
    local file = io.open(OUT, 'ab')
    if file then file:write(line, '\n'); file:close() end
    return line
end
local function nativeLayer()
    return convaiSeating and convaiSeating.native or dofile('companion-seating.lua').native
end
local function forward(yaw) local r = math.rad(yaw) return {x = -math.sin(r), y = math.cos(r)} end
local function currentFlat()
    local ok, id = pcall(function()
        local system = Game.GetScriptableSystemsContainer():Get('PreventionSystem')
        local district = system and system:GetCurrentDistrict()
        local record = district and TweakDBInterface.GetDistrictRecord(district:GetDistrictID())
        return record and tostring(record:EnumName()) or nil
    end)
    local name = ok and id or nil
    if name then name = name:match('%-%-%[%[%s*(.-)%s*%-%-%]%]') or name end
    return name and DISTRICT[name] or nil, name
end
local function fact(name)
    local quests = Game.GetQuestsSystem()
    return quests and tonumber(quests:GetFactStr(name)) or 0
end
local function controller() return convaiHousemates and convaiHousemates.controller or nil end

local function spotLine(id, kind, p, extra)
    local parts = {string.format("id = '%s'", id), string.format("kind = '%s'", kind), string.format('x = %.2f', p.x), string.format('y = %.2f', p.y),
        string.format('z = %.2f', p.z), string.format('yaw = %.1f', p.yaw), "conf = 'M'"}
    for _, item in ipairs(extra or {}) do parts[#parts + 1] = item end
    return '{' .. table.concat(parts, ', ') .. '},'
end

-- ---- commands ---------------------------------------------------------------------------------------------------------------------------
local C = {}

C.help = function()
    return true, {commands = {'where', 'status', 'record <kind> <id> [note]', 'bed <id>', 'window <id>', 'door <apartment>', 'scan [radius]',
        'teleport <apartment>', 'own <apartment> [0|1]', 'qualify write|read', 'stay <key> <apartment>', 'out <key>', 'chat', 'greet', 'reserved'},
        output = OUT, note = 'teleport, own and qualify are for a throwaway copy of a save'}
end

C.where = function()
    local id, name = currentFlat()
    local d = DISTRICT
    local facts = {}
    for apt, fname in pairs(PURCHASE) do facts[fname] = fact(fname) end
    return true, {pose = pose(), district = name, flat = id, purchased = facts}
end

C.status = function()
    local list = {}
    local keys = {}
    if convaiHousemates and convaiHousemates.controller then
        for key, apt in pairs(convaiHousemates.controller.homes()) do list[#list + 1] = key .. '=' .. apt; keys[#keys + 1] = key end
    end
    return true, {homes = list, snapshot = convaiHousemates and convaiHousemates.snapshot() or 'no service',
        learned = controller() and controller().learnedList() or {}}
end

C.record = function(words)
    local kind, id = words[3], words[4]
    if not KINDS[kind] or not id then return false, 'usage: record <couch|chair|bar|stool|lean|stand|window|sink> <id> [note]' end
    local p = pose()
    local extra = {}
    local info
    if kind == 'couch' or kind == 'chair' or kind == 'bar' or kind == 'stool' then
        local nat = nativeLayer()
        local ok, seat = pcall(nat.playerSeat, player(), true)
        if ok and seat and seat.inside then
            info = {inside = true, path = seat.path, anim = seat.anim, psm = seat.psmWorkspot}
            extra[#extra + 1] = 'vslot = true'
        else info = {inside = false} end
    end
    local note = table.concat(words, ' ', 5)
    if note ~= '' then extra[#extra + 1] = string.format('note = %q', note) end
    local line = append(spotLine(id, kind, p, extra))
    return true, {line = line, seat = info, hint = info and info.inside and 'V is sitting here: this is V\'s own seat (vslot). Record the other seats from a spot V stands on, or place the line by hand.' or nil}
end

-- The width of the bed at V's lying root, measured across the bed: the surface under V must keep its height for the offsets that count.
C.bed = function(words)
    local id = words[3]
    if not id then return false, 'usage: bed <id> (V lies in the bed)' end
    local p = pose()
    local nat = nativeLayer()
    local f = forward(p.yaw)
    local lateral = {x = -f.y, y = f.x}
    local base = nat.surface(p.x, p.y, p.z + 1.3, p.z - 1.2)
    if not base then return false, 'no surface under V' end
    local function extent(sign)
        local reach = 0
        for step = 1, 30 do
            local o = step * 0.1 * sign
            local h = nat.surface(p.x + lateral.x * o, p.y + lateral.y * o, base + 0.6, base - 0.5)
            if h and math.abs(h - base) <= 0.15 then reach = step * 0.1 else break end
        end
        return reach
    end
    local left, right = extent(-1), extent(1)
    local sides = {}
    if left >= 0.95 then sides[#sides + 1] = -0.65 end
    if right >= 0.95 then sides[#sides + 1] = 0.65 end
    local across = round(p.yaw + 90, 1)
    local line = append(string.format("{id = '%s', kind = 'bed', x = %.2f, y = %.2f, z = %.2f, conf = 'M', anchor = {x = %.2f, y = %.2f, z = %.2f}, across = %.1f, yaw = %.1f, sides = {%s}, fitsTwo = %s},",
        id, p.x, p.y, p.z, p.x, p.y, base, across, p.yaw, table.concat((function() local t = {} for _, s in ipairs(sides) do t[#t + 1] = tostring(s) end return t end)(), ', '),
        #sides > 0 and 'true' or 'false'))
    return true, {line = line, left = left, right = right, width = round(left + right, 2), surfaceHeight = round(base - p.z), fitsTwo = #sides > 0,
        note = 'yaw is where V\'s head points; if the slot clips V or lies backwards, correct yaw/sides by hand and say so here'}
end

C.window = function(words)
    local id = words[3]
    if not id then return false, 'usage: window <id> (V stands facing the window)' end
    local p = pose()
    local f = forward(p.yaw)
    local spatial = Game.GetSpatialQueriesSystem()
    local hitAt
    for _, group in ipairs({'Static', 'Dynamic', 'Collider'}) do
        for distance = 1, 40 do
            local d = distance * 0.1
            local hit = spatial:SyncRaycastByCollisionGroup(Vector4.new(p.x, p.y, p.z + 1.6, 1), Vector4.new(p.x + f.x * d, p.y + f.y * d, p.z + 1.6, 1),
                CName.new(group), false, false)
            if hit == true then hitAt = d; break end
        end
        if hitAt then break end
    end
    local face = hitAt and {x = round(p.x + f.x * hitAt), y = round(p.y + f.y * hitAt)} or {x = round(p.x + f.x * 3), y = round(p.y + f.y * 3)}
    local line = append(string.format("{id = '%s', kind = 'window', x = %.2f, y = %.2f, z = %.2f, yaw = %.1f, conf = 'M', face = {x = %.2f, y = %.2f}},",
        id, p.x, p.y, p.z, p.yaw, face.x, face.y))
    return true, {line = line, glassAt = hitAt, hint = hitAt and nil or 'nothing within 4 m ahead: the face point is a guess'}
end

C.door = function(words)
    local apt = words[3]
    if not apt then return false, 'usage: door <apartment id>' end
    local p = pose()
    return true, {line = append(string.format("-- door of %s: x = %.2f, y = %.2f, z = %.2f, yaw = %.1f", apt, p.x, p.y, p.z, p.yaw))}
end

-- Surfaces around V at seat height, grouped: a flood fill over the cells whose top is between 0.3 and 1.0 m above V's feet.
C.scan = function(words)
    local radius = math.min(tonumber(words[3]) or 8, 12)
    local step = 0.25
    local nat = nativeLayer()
    local p = pose()
    local n = math.floor(radius / step)
    local cells = {}
    local rays = 0
    for ix = -n, n do
        for iy = -n, n do
            local x, y = p.x + ix * step, p.y + iy * step
            local h = nat.surface(x, y, p.z + 1.4, p.z - 0.3)
            rays = rays + 1
            if h and h - p.z >= 0.3 and h - p.z <= 1.0 then cells[ix .. ':' .. iy] = {x = x, y = y, h = h, ix = ix, iy = iy} end
        end
    end
    local seen, clusters = {}, {}
    for key, cell in pairs(cells) do
        if not seen[key] then
            local stack, members = {key}, {}
            seen[key] = true
            while #stack > 0 do
                local k = table.remove(stack)
                local c = cells[k]
                members[#members + 1] = c
                for dx = -1, 1 do
                    for dy = -1, 1 do
                        local nk = (c.ix + dx) .. ':' .. (c.iy + dy)
                        if cells[nk] and not seen[nk] and math.abs(cells[nk].h - c.h) <= 0.1 then seen[nk] = true; stack[#stack + 1] = nk end
                    end
                end
            end
            if #members >= 4 then
                local sx, sy, sh, minx, maxx, miny, maxy = 0, 0, 0, 1e9, -1e9, 1e9, -1e9
                for _, c in ipairs(members) do
                    sx, sy, sh = sx + c.x, sy + c.y, sh + c.h
                    minx, maxx, miny, maxy = math.min(minx, c.x), math.max(maxx, c.x), math.min(miny, c.y), math.max(maxy, c.y)
                end
                local width, depth = maxx - minx + step, maxy - miny + step
                local area = #members * step * step
                local high = sh / #members - p.z
                local guess = 'surface'
                if area >= 2.5 and high <= 0.75 then guess = 'bed'
                elseif high >= 0.55 and math.max(width, depth) <= 0.8 then guess = 'stool'
                elseif high <= 0.55 and math.max(width, depth) <= 0.8 then guess = 'chair'
                elseif high <= 0.55 and math.max(width, depth) > 0.8 then guess = 'couch' end
                clusters[#clusters + 1] = {guess = guess, x = round(sx / #members), y = round(sy / #members), z = round(sh / #members), above = round(high),
                    width = round(width), depth = round(depth), cells = #members}
            end
        end
    end
    table.sort(clusters, function(a, b) if a.guess == b.guess then return a.cells > b.cells end return a.guess < b.guess end)
    local ok, encoded = pcall(json.encode, {pose = p, radius = radius, clusters = clusters})
    if ok then
        local file = io.open('runtime/housemate-scan.json', 'wb')
        if file then file:write(encoded); file:close() end
    end
    return true, {rays = rays, clusters = clusters, file = 'runtime/housemate-scan.json'}
end

C.teleport = function(words)
    local t = TELEPORT[words[3]]
    if not t then return false, 'usage: teleport <h10|corpo|glen|japan|north>' end
    local ok, err = pcall(function()
        Game.GetTeleportationFacility():Teleport(player(), Vector4.new(t[1], t[2], t[3], 1), EulerAngles.new(0, 0, t[4]))
    end)
    return ok, ok and {to = t} or tostring(err)
end

C.own = function(words)
    local apt = words[3]
    local name = PURCHASE[apt]
    if not name then return false, 'usage: own <corpo|glen|japan|north> [0|1] (h10 is always yours)' end
    local value = tonumber(words[4]) or 1
    local ok, err = pcall(function() Game.GetQuestsSystem():SetFactStr(name, value) end)
    return ok, ok and {fact = name, value = fact(name)} or tostring(err)
end

C.qualify = function(words)
    local mode = words[3]
    local probeName = 'cyberpunkconvai_hm_probe'
    if mode == 'write' then
        local value = 1000 + math.floor(os.clock() * 1000) % 8000
        local ok, err = pcall(function() Game.GetQuestsSystem():SetFactStr(probeName, value) end)
        if not ok then return false, tostring(err) end
        local file = io.open('runtime/housemate-qualify.txt', 'wb')
        if file then file:write(tostring(value)); file:close() end
        return true, {wrote = value, readBack = fact(probeName), next = 'save the game now, then load that save (or restart the game) and run: housemate qualify read'}
    elseif mode == 'read' then
        local file = io.open('runtime/housemate-qualify.txt', 'rb')
        local expected = file and tonumber(file:read('*a')) or nil
        if file then file:close() end
        local value = fact(probeName)
        return true, {fact = value, expected = expected, survived = expected ~= nil and value == expected,
            note = 'after loading an OLDER save the fact must be 0 (or the older value): that is the rollback proof'}
    end
    return false, 'usage: qualify write|read'
end

C.stay = function(words)
    local key, apt = words[3], words[4]
    if not key or not registry.number(apt) then return false, 'usage: stay <profileKey> <h10|corpo|glen|japan|north>' end
    local glue = convaiHousemates
    if not glue then return false, 'the housemates service is not loaded yet (wait for a world)' end
    local c = glue.controller or (glue.ensure and glue.ensure())
    if not c then return false, 'the controller could not be built' end
    local ok, why = c.stay(key, apt)
    return ok == true, ok and {key = key, apartment = apt} or tostring(why)
end

C.out = function(words)
    local c = controller()
    if not c or not words[3] then return false, 'usage: out <profileKey>' end
    local ok, why = c.moveOut(words[3])
    return ok == true, ok and {key = words[3]} or tostring(why)
end

C.chat = function()
    local c = controller()
    if not c or not c.forceChat then return false, 'no controller' end
    return true, {started = c.forceChat() == true}
end

C.greet = function()
    local c = controller()
    if not c or not c.forceGreeting then return false, 'no controller' end
    return true, {asked = c.forceGreeting() == true}
end

C.reserved = function()
    local id = currentFlat()
    local data = dofile('housemate-spots-data.lua')
    local out = {}
    if not id then return false, 'V is not in one of the flats' end
    for _, group in ipairs({'any', id}) do
        for _, name in ipairs(data.reservedFacts[group] or {}) do out[#out + 1] = name .. '=' .. fact(name) end
    end
    return true, {flat = id, facts = out}
end

function M.command(words)
    local sub = words[2] or 'help'
    local run = C[sub]
    if not run then return false, 'unknown housemate command; try: housemate help' end
    local ok, a, b = pcall(run, words)
    if not ok then return false, tostring(a) end
    return a, b
end

return M
