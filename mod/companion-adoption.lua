-- World characters who join V, and party members who leave (docs/WORLD_COMPANIONS.md).
--
-- DISABLED 2026-10-11: a world character can no longer join the party (offer() reports "unavailable" and
-- queueFollow() refuses unless options.allowWorldFollow is set, which only tests do). The leave half (party members
-- walking away) is live. The adoption code below is kept for now.
--
-- A world character asked to follow is never given a follower role. It joins
-- through the ordinary party queue as a managed copy (same record, current
-- appearance, placed where it stood); the moment that copy is attached, the
-- original is hidden (runtime visibility only, nothing persists). When the copy
-- leaves the party, the original is shown again once V is far away or looking
-- elsewhere, and carries on with its own routine. Quest, scene, police, vendor,
-- hostile, mounted or already-directed characters are refused.
--
-- Both actions run after the reply that requested them has been heard: the
-- copy appears once the character has answered, and a companion leaves after
-- its goodbye, walking away (toward its original's home when it has one, else
-- away from V) and despawning only out of V's view (A.owns/A.decide are the
-- movement owner companions.lua consults; menu Dismiss stays instant). The model decides that V meant it (gameplay-actions.lua); this
-- module only re-checks the game state and performs it.
--
-- The walk goes only to a point the navigation mesh proves reachable (a snapped
-- walkable point, a route that is not a detour, one floor), found a few
-- candidates per update and only while no goal is held. A goal the movement
-- actuator still refuses is dropped for the next candidate. A companion who
-- still makes no headway is removed as soon as V cannot see her, or after a
-- bounded wait: she never stands there for good.
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
local M = {}

M.CONFIG = {
    replyWait = 30,       -- seconds an action waits for its reply to finish playing
    nearby = 15,          -- metres: the original must still be this close when the copy is placed
    crowdRelease = 50,    -- metres: a hidden crowd original (pooled by the game) is shown again past this
    restoreDistance = 60, -- metres: a former member's original is shown again past this ...
    restoreAngle = 70,    -- ... or once it is this many degrees away from where V is looking ...
    restoreWait = 20,     -- ... or after this many seconds
    walkDistances = {50, 40, 58, 28, 18}, -- metres: how far a leaving companion heads, tried in this order (long first)
    walkBearings = {0, 40, -40, 80, -80, 120, -120}, -- degrees off straight away from V; never back toward V
    walkProbes = 2,       -- candidate goals checked per update while none is held
    walkRetry = 0.4,      -- seconds before the next candidate while she is walking
    walkRetryStuck = 2,   -- ... and while she has made no headway: tries stay slow, they never stop
    walkShort = {11, 7},  -- metres: closer goals added from the second round on (a short hop past a blocker)
    walkShortGap = 5,     -- ... which only have to end this far from V
    walkSnap = 3,         -- metres: how far from a candidate the nearest walkable ground may be
    walkRouteSlack = 4,   -- metres: a route longer than the straight line by more than this is a detour
    walkMinGap = 12,      -- metres: a goal must end at least this far from V
    walkFarther = 6,      -- metres: a chained goal must end this much farther from V than she stands (2 from the second round)
    walkGoalWait = 4,     -- seconds a goal may go without headway before the next one is tried
    walkStuck = 6,        -- seconds without 1.5 m of headway: she is stuck; she stands and keeps trying, and goes ...
    walkStuckHidden = 1,  -- ... only once V has not seen her for this long ...
    walkFar = 50,         -- ... or she is this far from V (metres), seen or not
    walkHomeMin = 8,      -- metres: an original's home closer or ...
    walkHomeMax = 60,     -- ... farther than this is not walked to; away from V instead
    walkHidden = 1,       -- ... or out of view this many seconds while at least ...
    walkHiddenGap = 8,    -- ... this far away
    walkTimeout = 180,    -- seconds: after this she goes as soon as V cannot see her ...
    walkTimeoutHard = 300, -- ... and never later than this, seen or not
    walkUnowned = 3,      -- seconds without a walking decision (seated, in transit): removed
}
local HEADWAY = 1.5       -- metres that count as walking

-- Reasons a character record cannot become a companion copy. A failed join for
-- one of these marks that record as uncopyable for the session.
local RECORD_FAILURES = {'crowd', 'controllable', 'AI controller', 'authored AI role', 'cannot be copied',
    'not available in your installation', 'not a character model'}

-- At most 120 bytes, never cutting a UTF-8 character (the bridge compares the
-- offer it receives byte for byte with the lease).
local function clip(value)
    value = tostring(value)
    if #value <= 120 then return value end
    local cut = 120
    while cut > 0 and value:byte(cut + 1) and value:byte(cut + 1) >= 128 and value:byte(cut + 1) < 192 do cut = cut - 1 end
    return value:sub(1, cut)
end

local function dist(a, b)
    if not a or not b then return math.huge end
    return math.sqrt((a.x - b.x)^2 + (a.y - b.y)^2 + (a.z - b.z)^2)
end

-- Native reads and the one native write (visibility). Every call is guarded by
-- the caller; tests replace this table.
function M.nativeAdapter()
    local N = {}
    function N.entity(npc) return tostring(npc:GetEntityID().hash) end
    function N.alive(npc) return npc:IsAttached() and not npc:IsDeadNoStatPool() end
    function N.position(npc) local p = npc:GetWorldPosition(); return {x = p.x, y = p.y, z = p.z} end
    function N.orientation(npc) return npc:GetWorldOrientation() end
    function N.appearance(npc)
        local name = NameToString(npc:GetCurrentAppearanceName())
        return name ~= '' and name ~= 'None' and name or nil
    end
    function N.record(npc) return npc:GetRecordID() end
    function N.crowd(npc) return npc:IsCrowd() == true end
    function N.playerPosition(player) local p = player:GetWorldPosition(); return {x = p.x, y = p.y, z = p.z} end
    function N.cameraForward(player)
        local _, forward = Game.GetTargetingSystem():GetCrosshairData(player)
        return forward and {x = forward.x, y = forward.y, z = forward.z} or nil
    end
    -- The nearest walkable ground to a point (within radius), as plain
    -- numbers, or nil when the mesh has none there. character: the actor whose
    -- navigation agent asks. Called only while a leaving companion picks a goal.
    local function finite(value)
        return type(value) == 'number' and value == value and value ~= math.huge and value ~= -math.huge
    end
    function N.walkable(character, desired, radius)
        local found = Game.GetAINavigationSystem():FindPointInSphereForCharacter(
            Vector4.new(desired.x, desired.y, desired.z, 1), radius, character)
        if not found or found.status ~= Enum.new('worldNavigationRequestStatus', 'OK') then return nil end
        local p = found.point
        if not p or not finite(p.x) or not finite(p.y) or not finite(p.z) then return nil end
        return {x = p.x, y = p.y, z = p.z}
    end
    -- The native walking route between two walkable points: its length and its
    -- points as plain numbers, or nil when there is none.
    function N.route(character, from, to)
        local route = Game.GetAINavigationSystem():CalculatePathForCharacter(
            Vector4.new(from.x, from.y, from.z, 1), Vector4.new(to.x, to.y, to.z, 1), 0.3, character)
        local points = route and route.path
        if not points or #points == 0 or #points > 128 then return nil end
        local list = {}
        for index, p in ipairs(points) do
            if not finite(p.x) or not finite(p.y) or not finite(p.z) then return nil end
            list[index] = {x = p.x, y = p.y, z = p.z}
        end
        local length = route:CalculateLength()
        if not finite(length) or length < 0 then return nil end
        return {length = length, points = list}
    end
    function N.setVisible(npc, visible)
        -- The same event the phantom controller uses to hide or show a whole
        -- entity (companion-appearance.lua). It is runtime state only.
        local event = NewObject('enteventsSetVisibility')
        event.visible = visible == true
        event.source = Enum.new('entVisibilityParamSource', 'PhantomEntitySystem')
        npc:QueueEvent(event)
    end
    -- Why this character must not leave with V, or nil when it may. An
    -- unreadable signal counts as a refusal: adoption needs positive evidence.
    function N.refusal(npc, player)
        local function read(fn)
            local ok, value = pcall(fn)
            if not ok then return nil end
            return value
        end
        if read(function() return npc:IsA('NPCPuppet') end) ~= true then return 'busy' end
        if read(function() return NPCPuppet.IsInCombat(npc) or player:IsInCombat() end) ~= false then return 'combat' end
        if read(function() return npc:IsPrevention() or npc:IsCharacterPolice() end) ~= false then return 'police' end
        -- A quest-marked actor, or one whose AI a quest or scene drives.
        if read(function() return npc:IsQuest() or not npc:IsOnAutonomousAI() end) ~= false then return 'quest' end
        if read(function()
            local scenes = Game.GetSceneSystem():GetScriptInterface()
            local id = npc:GetEntityID()
            return scenes:IsEntityInScene(id) or scenes:IsEntityInDialogue(id)
        end) ~= false then return 'scene' end
        if read(function() return npc:IsVendor() end) ~= false then return 'working' end
        if read(function() return npc:IsHostile() end) ~= false then return 'hostile' end
        if read(function() return npc:IsCharacterChildren() end) ~= false then return 'busy' end
        -- Already a vanilla companion, or given any AI role by its owner.
        if read(function()
            if npc:IsPlayerCompanion() then return true end
            local ai = npc:GetAIControllerComponent()
            if not ai then return true end
            local role = ai:GetAIRole()
            return role ~= nil and not role:IsA('AINoRole')
        end) ~= false then return 'busy' end
        if read(function()
            local info = Game.GetMountingFacility():GetMountingInfoSingleWithObjects(npc)
            local parent = info and info.parentId
            return parent ~= nil and parent.hash ~= nil and tostring(parent.hash):match('^0+[uUlL]*$') == nil
        end) ~= false then return 'vehicle' end
        return nil
    end
    return N
end

-- options: companions, party() -> the party queue, player(), busy(requestId,
-- groupId) -> true while that reply is still being delivered, named(key) ->
-- true for one specific character (duplicates refused), groupEntities(context)
-- -> entity ids in that group round, promote(key), log(line), native.
function M.new(options)
    options = options or {}
    local cfg = {}
    for key, value in pairs(M.CONFIG) do cfg[key] = options[key] or value end
    local companions = options.companions
    local native = options.native or M.nativeAdapter()
    local A = {}
    local clock, sequence = 0, 0
    local records, departures, offered = {}, {}, {}
    local walkers, uncopyable = {}, {}
    -- Off in the release: a world character is never adopted, only mod-spawned companions are party members. The flag
    -- exists so the adoption code (kept, and covered by tests) can be exercised; no production caller sets it.
    local allowWorldFollow = options.allowWorldFollow == true

    local function log(line) if type(options.log) == 'function' then pcall(options.log, line) end end
    local function queue() return type(options.party) == 'function' and options.party() or nil end
    local function player() return type(options.player) == 'function' and options.player() or nil end
    local function guard(fn, ...)
        local ok, value = pcall(fn, ...)
        if ok then return value end
        return nil
    end
    local function alive(npc) return npc ~= nil and guard(native.alive, npc) == true end
    local function busy(requestId, groupId)
        if type(options.busy) ~= 'function' then return false end
        local ok, value = pcall(options.busy, requestId, groupId)
        return ok and value == true
    end
    local function named(key)
        if type(options.named) ~= 'function' then return true end
        local ok, value = pcall(options.named, key)
        return not ok or value ~= false
    end
    local function partyRows()
        local ok, rows = pcall(companions.list)
        return ok and type(rows) == 'table' and rows or {}
    end
    local function active(record) return record.state == 'preparing' or record.state == 'joined' end

    -- The reason a follow is refused, or nil. own: the adoption being re-checked.
    local function refusal(entity, npc, profileKey, own)
        local current = player()
        if not current or not alive(npc) or guard(native.entity, npc) ~= entity then return 'busy' end
        for id, record in pairs(records) do
            if record ~= own and active(record) and (id == entity or (named(profileKey) and record.profileKey == profileKey)) then
                return 'already-here'
            end
        end
        if not own then
            if named(profileKey) then
                for _, key in ipairs(guard(companions.connectionProfiles) or {}) do
                    if key == profileKey then return 'already-here' end
                end
            end
        end
        local ok, reason = pcall(native.refusal, npc, current)
        if not ok then return 'busy' end
        if reason then return reason end
        -- Some records cannot be copied at all (or failed before this session):
        -- the game never offers a follow it cannot perform.
        local recordID = guard(native.record, npc)
        if not recordID or uncopyable[tostring(recordID)] then return 'unavailable' end
        if type(companions.copyable) == 'function' and guard(companions.copyable, recordID) == false then
            uncopyable[tostring(recordID)] = true
            return 'unavailable'
        end
        return nil
    end

    local function refusalMessage(reason, name)
        if reason == 'already-here' then return ui.t('{name} is already with you.', {name = name}) end
        if reason == 'gone' then return ui.t('{name} is no longer nearby.', {name = name}) end
        return ui.t('{name} can\'t come along right now.', {name = name})
    end

    -- Follow offer for a conversation with a world character (not a party
    -- member). Available, or unavailable with one reason code, or nil.
    function A.offer(entity, npc, profileKey, name)
        if type(entity) ~= 'string' or type(profileKey) ~= 'string' or not npc then return nil end
        if guard(companions.owns, npc) or guard(companions.partyMember, entity) then return nil end
        -- World characters cannot join the party (2026-10-11): the character declines in character, nothing is armed.
        if not allowWorldFollow then return {available = false, reason = 'unavailable'} end
        local reason = refusal(entity, npc, profileKey)
        if reason then return {available = false, reason = reason} end
        local label = type(name) == 'string' and name ~= '' and clip(name) or profileKey
        -- One conversation leases one offer at a time; only the latest is kept.
        offered = {[entity] = {npc = npc, profileKey = profileKey, name = label}}
        return {available = true, actor = {id = entity, key = profileKey}, name = label}
    end

    -- Leave offer: the addressed party member, or in a group round's first
    -- turn every party member of that round. Members already leaving or
    -- driving V are left out.
    function A.leaveOffer(entity, context)
        if type(entity) ~= 'string' or type(context) ~= 'table' or type(context.profileKey) ~= 'string' then return nil end
        local leaving = {}
        for _, departure in ipairs(departures) do
            for _, serial in ipairs(departure.serials) do leaving[serial] = true end
        end
        for serial in pairs(walkers) do leaving[serial] = true end
        local entities = {entity}
        if context.group then
            local ok, list = pcall(options.groupEntities, context)
            entities = ok and type(list) == 'table' and list or {}
        end
        local members, seen = {}, {}
        for _, id in ipairs(entities) do
            local member = type(id) == 'string' and not seen[id] and guard(companions.partyMember, id) or nil
            seen[id] = true
            if member and not member.driving and not leaving[member.serial] and #members < 3 then
                members[#members + 1] = {serial = member.serial, id = member.id, key = member.key,
                    name = clip(member.name or member.key)}
            end
        end
        if #members == 0 then return nil end
        return {available = true, actor = {id = entity, key = context.profileKey}, members = members}
    end

    local function recordFor(key)
        for _, record in pairs(records) do if record.key == key then return record end end
    end

    -- The model chose to follow V. Re-check everything and reserve a party
    -- place; the copy is placed after the reply (the job's gate).
    function A.queueFollow(offer, entity, requestId)
        if not allowWorldFollow then return false, refusalMessage('unavailable', type(offer) == 'table' and offer.name or '') end
        local seen = offered[entity]
        local name = seen and seen.name or (type(offer) == 'table' and offer.name) or ''
        if type(offer) ~= 'table' or type(offer.actor) ~= 'table' or offer.actor.id ~= entity or not seen
            or seen.profileKey ~= offer.actor.key then
            return false, refusalMessage('gone', name)
        end
        local npc = seen.npc
        local reason = refusal(entity, npc, seen.profileKey)
        if reason then return false, refusalMessage(reason, name) end
        local party = queue()
        if not party then return false, refusalMessage('busy', name) end
        local recordID = guard(native.record, npc)
        if not recordID then return false, refusalMessage('busy', name) end
        sequence = sequence + 1
        local key = 'world-' .. entity:gsub('[^%w]', '') .. '-' .. sequence
        local registered, why = companions.registerDefinition(key, {recordID = recordID, name = name,
            profileKey = seen.profileKey, profileName = name})
        if not registered then return false, tostring(why) end
        -- Generic people (residents, archetypes) have no per-character memory to
        -- prepare and no connection without a body: they join as a model and
        -- get their conversation profile when the copy is attached.
        local modelOnly = not named(seen.profileKey)
        local record = {entity = entity, npc = npc, key = key, profileKey = seen.profileKey, name = name,
            requestId = requestId, state = 'preparing', since = clock, modelOnly = modelOnly,
            crowd = guard(native.crowd, npc) == true, home = guard(native.position, npc),
            recordKey = tostring(recordID)}
        local adoption = {entity = entity}
        record.adoption = adoption
        local gate = function()
            if record.state ~= 'preparing' then return nil, refusalMessage('gone', name) end
            if busy(requestId) and clock - record.since < cfg.replyWait then return false end
            local current = player()
            local at = alive(npc) and guard(native.position, npc)
            if not current or not at or dist(at, guard(native.playerPosition, current)) > cfg.nearby then
                record.state = 'ended'
                return nil, refusalMessage('gone', name)
            end
            local refused = refusal(entity, npc, record.profileKey, record)
            if refused then record.state = 'ended'; return nil, refusalMessage(refused, name) end
            adoption.position = at
            adoption.orientation = guard(native.orientation, npc)
            adoption.appearance = guard(native.appearance, npc)
            record.home = at
            return true
        end
        records[entity] = record
        local ok, accepted, message, id = pcall(party.invite, key, {adoption = adoption, gate = gate, modelOnly = modelOnly})
        if not ok or not accepted then
            records[entity] = nil
            return false, tostring(ok and message or accepted)
        end
        record.jobId = id
        offered[entity] = nil
        log('Adoption queued: ' .. seen.profileKey .. ' actor=' .. entity)
        return true, ui.t('{name} is coming with you.', {name = name})
    end

    -- The model chose to send a companion (or everyone offered) away. The
    -- dismissal itself is the Current party Dismiss, after the goodbye.
    function A.queueLeave(target, offer, entity, requestId, groupId)
        if type(offer) ~= 'table' or type(offer.members) ~= 'table' then return false, ui.t('That action is not available.') end
        local serials, names = {}, {}
        for _, member in ipairs(offer.members) do
            if target == 'all' or member.id == target then
                local current = guard(companions.partyMember, member.id)
                if current and current.serial == member.serial and current.key == member.key and not current.driving then
                    serials[#serials + 1] = member.serial
                    names[#names + 1] = member.name
                end
            end
        end
        if #serials == 0 then return false, ui.t('That companion is no longer in your party.') end
        departures[#departures + 1] = {serials = serials, requestId = requestId, groupId = groupId, at = clock}
        log('Departure queued: ' .. table.concat(names, ', '))
        return true, ui.t('{name} is leaving your party.', {name = table.concat(names, ', ')})
    end

    function A.hidden(value)
        if value == nil or next(records) == nil then return false end
        local entity = type(value) == 'string' and value or guard(native.entity, value)
        local record = entity and records[entity]
        return record ~= nil and record.hidden == true
    end

    local function show(record)
        if record.hidden and alive(record.npc) then
            local ok = pcall(native.setVisible, record.npc, true)
            log('Adoption original ' .. (ok and 'shown again: ' or 'could not be shown again: ') .. record.entity)
        end
        record.hidden = false
    end

    -- True while a point is within range and roughly where V is looking.
    local function visibleAt(at, current, range)
        local from = guard(native.playerPosition, current)
        if not at or not from then return false end
        if dist(at, from) > range then return false end
        local forward = guard(native.cameraForward, current)
        if not forward then return true end
        local dx, dy = at.x - from.x, at.y - from.y
        local length, fl = math.sqrt(dx * dx + dy * dy), math.sqrt(forward.x^2 + forward.y^2)
        if length < 0.5 or fl < 0.01 then return true end
        local cosine = math.max(-1, math.min(1, (dx * forward.x + dy * forward.y) / (length * fl)))
        return math.deg(math.acos(cosine)) <= cfg.restoreAngle
    end
    local function inView(record, current)
        return visibleAt(guard(native.position, record.npc), current, cfg.restoreDistance)
    end

    -- Movement owner for a companion walking away (companions.lua M.departure).
    function A.owns(serial) return walkers[serial] ~= nil end
    local function ground(a, b) return math.sqrt((a.x - b.x)^2 + (a.y - b.y)^2) end
    local function keyOf(p) return string.format('%.1f:%.1f', p.x, p.y) end

    -- Desired goals in the order they are tried: the original's home when it
    -- is a real walk away, then each distance in cfg.walkDistances fanned out
    -- around straight away from V (never back toward V).
    local function candidateList(walker, at, from)
        local list, home = {}, walker.home
        local toHome = home and dist(home, at)
        if toHome and toHome > cfg.walkHomeMin and toHome < cfg.walkHomeMax then
            list[#list + 1] = {x = home.x, y = home.y, z = home.z}
        end
        local dx, dy = at.x - (from and from.x or at.x), at.y - (from and from.y or at.y)
        local length = math.sqrt(dx * dx + dy * dy)
        if length < 0.1 then dx, dy, length = 0, 1, 1 end
        local ux, uy = dx / length, dy / length
        local distances = cfg.walkDistances
        if (walker.pass or 1) > 1 then
            distances = {}
            for _, distance in ipairs(cfg.walkDistances) do distances[#distances + 1] = distance end
            for _, distance in ipairs(cfg.walkShort) do distances[#distances + 1] = distance end
        end
        for _, distance in ipairs(distances) do
            for _, degrees in ipairs(cfg.walkBearings) do
                local turn = math.rad(degrees)
                local rx, ry = ux * math.cos(turn) - uy * math.sin(turn), ux * math.sin(turn) + uy * math.cos(turn)
                list[#list + 1] = {x = at.x + rx * distance, y = at.y + ry * distance, z = at.z}
            end
        end
        return list
    end

    -- A reachable ground point for one desired goal, or nil: walkable ground
    -- near it on this floor, ending far enough from V, by a route that is not a
    -- detour, stays on one floor and is short enough for the actuator's
    -- clearance proof (about two metres per verified box, at most 64).
    local function reachable(desired, at, from, who, minGap)
        local point = guard(native.walkable, who, desired, cfg.walkSnap)
        if not point or math.abs(point.z - at.z) > 1.2 then return nil end
        local direct = ground(at, point)
        if direct < minGap or (from and ground(point, from) < minGap) then return nil end
        local route = guard(native.route, who, at, point)
        if not route or route.length < direct - 0.5 or route.length > direct + cfg.walkRouteSlack then return nil end
        if dist(route.points[#route.points], point) >= 0.65 then return nil end
        local boxes, previous = 1, at
        for _, p in ipairs(route.points) do
            if math.abs(p.z - at.z) > 1.3 then return nil end
            boxes = boxes + math.max(1, math.ceil(ground(previous, p) / 2))
            previous = p
        end
        if boxes > 60 then return nil end
        return point
    end

    -- Examine at most cfg.walkProbes candidates; returns a goal, or nil to keep
    -- looking next update. When the list is spent the next round starts after a
    -- pause (refusals are forgotten: V, cars and crowds have moved) and also
    -- offers short hops. She keeps trying for as long as she is here.
    local function chooseGoal(walker, context, from)
        local at = context.position
        walker.candidates = walker.candidates or candidateList(walker, at, from)
        walker.cursor = walker.cursor or 1
        local who = context.npc or context.player
        for _ = 1, cfg.walkProbes do
            local desired = walker.candidates[walker.cursor]
            if not desired then
                walker.pass, walker.cursor, walker.candidates = walker.pass + 1, nil, nil
                walker.refused, walker.nextTryAt = {}, clock + 2 * cfg.walkRetryStuck
                return nil
            end
            walker.cursor = walker.cursor + 1
            if not walker.refused[keyOf(desired)] then
                local second = walker.pass > 1
                local gap = second and cfg.walkShortGap or cfg.walkMinGap
                -- Chained goals lead farther from V than she stands now.
                if walker.fartherThan then
                    gap = math.max(gap, walker.fartherThan + (second and 2 or cfg.walkFarther))
                end
                local point = reachable(desired, at, from, who, gap)
                if point then return point end
            end
        end
        return nil
    end

    function A.decide(serial, context)
        local walker = walkers[serial]
        if not walker or type(context) ~= 'table' or not context.position then return nil end
        walker.position, walker.gap, walker.decidedAt = context.position, context.playerGap, clock
        -- Headway: 1.5 m from the last checkpoint resets the stuck clock.
        if not walker.checkpoint or dist(walker.checkpoint, context.position) >= HEADWAY then
            walker.checkpoint = {x = context.position.x, y = context.position.y, z = context.position.z}
            walker.progressAt = clock
        end
        local motion = context.motion or {}
        local operation = walker.operation
        if operation and operation.kind == 'move' and motion.ticket == operation.ticket then
            if motion.failed or (not motion.complete and clock - walker.goalAt >= cfg.walkGoalWait
                and walker.progressAt <= walker.goalAt) then
                -- The actuator refused this goal (route, clearance), or it has not
                -- got her moving (a long detour search): the next one.
                walker.refused[keyOf(operation.goal)] = true
                walker.attempt, walker.operation = walker.attempt + 1, nil
                local stuck = clock - walker.progressAt >= cfg.walkStuck
                walker.nextTryAt = clock + (stuck and cfg.walkRetryStuck or cfg.walkRetry)
            elseif motion.complete then
                -- Arrived. V may still see her: the next goal leads farther from V,
                -- and so on until V cannot see her or she is far away.
                walker.operation, walker.candidates, walker.cursor, walker.pass = nil, nil, nil, 1
                walker.refused, walker.nextTryAt = {}, 0
                walker.fartherThan = context.playerGap or 0
                walker.attempt = walker.attempt + 1
            end
        end
        if not walker.operation and clock >= (walker.nextTryAt or 0) then
            local from = context.player and guard(native.playerPosition, context.player)
            local goal = chooseGoal(walker, context, from)
            if goal then
                walker.operation = {ticket = 'depart-' .. serial .. '-' .. walker.attempt, kind = 'move',
                    goal = goal, gait = 'Walk', finish = true, face = false}
                walker.goalAt = clock
            end
        end
        -- Searching, or waiting to try again: she stands where she is.
        local held = walker.operation or {ticket = 'depart-' .. serial .. '-look-' .. walker.attempt, kind = 'hold'}
        return {phase = 'departing', reason = 'leaving-party', operation = held, look = 'none'}
    end

    function A.update(dt)
        clock = clock + (tonumber(dt) or 0)
        if next(records) == nil and #departures == 0 and next(walkers) == nil then return end
        -- After the goodbye the companion walks away; it is removed out of view.
        for index = #departures, 1, -1 do
            local departure = departures[index]
            if not busy(departure.requestId, departure.groupId) or clock - departure.at >= cfg.replyWait then
                table.remove(departures, index)
                for _, serial in ipairs(departure.serials) do
                    local home
                    for _, record in pairs(records) do
                        if record.serial == serial and record.state == 'joined' then home = record.home end
                    end
                    walkers[serial] = {serial = serial, since = clock, attempt = 0, home = home, refused = {}, pass = 1}
                    log('Departure walking away: copy ' .. serial)
                end
            end
        end
        local current = player()
        local rows = (next(records) ~= nil or next(walkers) ~= nil) and partyRows() or {}
        local party = queue()
        local pendingJobs, preparing = {}, false
        for _, record in pairs(records) do if record.state == 'preparing' then preparing = true end end
        if party and preparing then
            for _, item in ipairs(guard(party.list) or {}) do
                if not item.serial then pendingJobs[item.key] = item end
            end
        end
        for entity, record in pairs(records) do
            local row
            for _, item in ipairs(rows) do if item.key == record.key then row = item end end
            if record.npc and not alive(record.npc) then record.npc, record.hidden = nil, false end
            if record.state == 'preparing' then
                if row and row.state == 'ready' then
                    record.state, record.serial = 'joined', row.serial
                    if record.modelOnly then pcall(companions.setProfile, row.serial, record.profileKey, record.name) end
                    if record.npc and pcall(native.setVisible, record.npc, false) then record.hidden = true end
                    if type(options.promote) == 'function' then pcall(options.promote, record.profileKey) end
                    log('Adoption joined: ' .. record.profileKey .. ' actor=' .. entity .. ' copy=' .. tostring(row.serial))
                elseif row and (row.state == 'failed' or row.state == 'dead' or row.state == 'missing') then
                    record.state, record.endedAt = 'ended', clock
                    record.failure = row.error
                elseif not row and not pendingJobs[record.key] then
                    record.state, record.endedAt = 'ended', clock
                elseif not row and pendingJobs[record.key].state == 'failed' then
                    -- The copy could not be created (no clear spot, preparation
                    -- error). The failure was reported; free its party place.
                    record.state, record.endedAt = 'ended', clock
                    record.failure = pendingJobs[record.key].error
                    pcall(party.dismiss, pendingJobs[record.key].id)
                end
                -- A record that cannot be a companion is not offered again.
                for _, text in ipairs(RECORD_FAILURES) do
                    if record.state == 'ended' and record.recordKey and tostring(record.failure or ''):find(text, 1, true) then
                        uncopyable[record.recordKey] = true
                        log('Adoption: record marked uncopyable (' .. text .. '): ' .. record.recordKey)
                        break
                    end
                end
            elseif record.state == 'joined' then
                if not row or row.state == 'failed' or row.state == 'dead' or row.state == 'missing' then
                    record.state, record.endedAt = 'ended', clock
                    log('Adoption ended: ' .. record.profileKey .. ' actor=' .. entity)
                end
            end
            -- The game pools crowd people; never leave one hidden once V has moved on.
            if record.hidden and record.crowd and current and record.npc
                and dist(guard(native.position, record.npc), guard(native.playerPosition, current)) > cfg.crowdRelease then
                show(record)
            end
            if record.state == 'ended' then
                record.endedAt = record.endedAt or clock
                if not record.hidden or not record.npc then records[entity] = nil
                elseif not current or not inView(record, current) or clock - record.endedAt >= cfg.restoreWait then
                    show(record); records[entity] = nil
                end
            end
        end
        for serial, walker in pairs(walkers) do
            local row
            for _, item in ipairs(rows) do if item.serial == serial then row = item end end
            if not row then
                walkers[serial] = nil -- dismissed (here or from the menu), or gone
            elseif not walker.dismissed then
                local hidden = current ~= nil and walker.position ~= nil
                    and not visibleAt(walker.position, current, math.huge)
                if hidden then walker.hiddenSince = walker.hiddenSince or clock else walker.hiddenSince = nil end
                local gap = walker.gap or 0
                local reason
                -- She is never removed while V is looking at her and close by. No
                -- headway for a while (no route, refused, boxed in): she stands
                -- and keeps trying other goals, and goes the moment V has not
                -- seen her for a second, or V is far away.
                local stuckFor = walker.decidedAt and clock - (walker.progressAt or walker.since) or 0
                if clock - walker.since >= cfg.walkTimeoutHard then reason = 'timeout'
                elseif not walker.decidedAt and clock - walker.since >= cfg.walkUnowned then reason = 'not walking'
                elseif gap >= cfg.walkFar then reason = 'far away'
                elseif hidden and clock - walker.since >= cfg.walkTimeout then reason = 'timeout, out of view'
                elseif hidden and stuckFor >= cfg.walkStuck and clock - walker.hiddenSince >= cfg.walkStuckHidden then
                    reason = 'stuck, out of view'
                elseif hidden and gap >= cfg.walkHiddenGap and clock - walker.hiddenSince >= cfg.walkHidden then
                    reason = 'out of view'
                end
                if reason then
                    local ok, accepted, message = false, false, nil
                    if party then ok, accepted, message = pcall(party.dismiss, 'live:' .. serial) end
                    -- A refused dismissal (a driver mid-trip) stops owning the walk.
                    if ok and accepted then walker.dismissed = true else walkers[serial] = nil end
                    log('Departure ' .. ((ok and accepted) and 'sent' or 'refused') .. ' for copy ' .. serial .. ' (' .. reason .. ')'
                        .. ((ok and accepted) and '' or (': ' .. tostring(message or accepted))))
                end
            end
        end
    end

    -- World teardown: copies are nonpersistent and visibility is runtime state,
    -- so a load needs no native call. Fast travel keeps the party and records.
    function A.abandon(preserveTransit)
        if preserveTransit then return end
        records, departures, offered, walkers = {}, {}, {}, {}
    end

    function A.inspect()
        local rows = {}
        for entity, record in pairs(records) do
            rows[#rows + 1] = {entity = entity, key = record.key, profileKey = record.profileKey, state = record.state,
                hidden = record.hidden == true, crowd = record.crowd, serial = record.serial}
        end
        local walking = 0
        for _ in pairs(walkers) do walking = walking + 1 end
        return {adoptions = rows, departures = #departures, walking = walking, clock = clock}
    end

    return A
end

return M
