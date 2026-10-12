-- What is going on around V right now, for mod conversations (docs/DYNAMIC_CONTEXT_AUDIT.md, bridge/turn-context.mjs):
-- the game clock, the district, who is with V and whether V is in a vehicle, and V's gender and lifepath.
-- Read-only and on demand, in the style of player-gear.lua: the snapshot is read when a conversation turn is built and reused
-- for MAX_AGE seconds, never per frame, with no timer, hook, observer or file. Every native call is guarded; a failure drops
-- that one field (or the whole snapshot), never the turn. It hands plain values to the bridge, which words them.
-- Each companion row also says what that companion is physically doing right now (following V on foot, sitting, riding or driving,
-- fighting), and V says whether V is driving and how V is moving, so the model never invents an activity or a place for her.
-- Weather, health and heat are deliberately absent: their CET calls are not confirmed (see TODO.md, "Live checks").
local M = {}
M.MAX_AGE, M.MAX_PARTY, M.PARTY_RADIUS, M.MAX_NAME = 5, 4, 15, 60

local function clean(value, limit)
    if type(value) ~= 'string' then return nil end
    local text = value:gsub('<[^>]*>', ''):gsub('%c', ' '):gsub('%s+', ' '):match('^%s*(.-)%s*$')
    if text == '' or text:match('^LocKey#') then return nil end
    if #text > limit then
        -- Cut on a UTF-8 boundary, never inside a character.
        local cut = limit - 3
        while cut > 0 and text:byte(cut + 1) and text:byte(cut + 1) >= 0x80 and text:byte(cut + 1) < 0xC0 do cut = cut - 1 end
        text = text:sub(1, cut) .. '...'
    end
    return text
end

-- What one companion is doing, as one short word, from the raw inputs companions.activityInputs keeps (all values the companion
-- modules already hold; nothing is read from the game here):
--   input = {transport = {owned, phase, seat, mountedSeat}, tactic = {kind, phase}, seating = <phase>, behavior = <phase>}
-- following | standing | combat | to-seat | seated | getting-up | passenger | driving | boarding | leaving-car | attacking
local DRIVER_SEAT = 'seat_front_left'
local LEAVING = {leaving = true, unmounting = true, ['waiting-for-native-exit'] = true, ['waiting-for-native-dismount'] = true,
    ['exit-failed'] = true, ['recovery-failed'] = true}
local BOARDING = {releasing = true, ['waiting-to-board'] = true, boarding = true, ['waiting-for-seat'] = true,
    ['boarding-retry'] = true, ['leaving-wrong-seat'] = true, ['waiting-for-driver-seat'] = true}
local TO_SEAT = {approach = true, placing = true, blending = true, settling = true}
local SEATED = {entering = true, seated = true}
local GETTING_UP = {leaving = true, standing = true, exiting = true}
local STANDING = {settled = true, waiting = true, attend = true, attend_step = true, attend_settle = true, attend_turn = true}

function M.classify(input)
    input = type(input) == 'table' and input or {}
    local transport = input.transport
    if type(transport) == 'table' and transport.owned == true then
        local phase = transport.phase
        if phase == 'riding' then
            return (transport.mountedSeat or transport.seat) == DRIVER_SEAT and 'driving' or 'passenger'
        end
        if LEAVING[phase] then return 'leaving-car' end
        if BOARDING[phase] then return 'boarding' end
    end
    local tactic = input.tactic
    if type(tactic) == 'table' and tactic.kind == 'fight' then return 'attacking' end
    local seating = input.seating
    if SEATED[seating] then return 'seated' end
    if GETTING_UP[seating] then return 'getting-up' end
    if TO_SEAT[seating] then return 'to-seat' end
    local behavior = input.behavior
    if behavior == 'combat' then return 'combat' end
    if STANDING[behavior] then return 'standing' end
    return 'following'
end

local MOTIONS = {still = true, walking = true, running = true}

local function integer(value, low, high)
    value = tonumber(value)
    if not value or value ~= value or value < low or value > high or value ~= math.floor(value) then return nil end
    return value
end

-- A CName (or a string) as plain text. tostring() of a CName prints its text in a comment.
local function nameText(value)
    if type(value) == 'string' then return value end
    if value == nil then return nil end
    local ok, text = pcall(function() return Game.NameToString(value) end)
    if ok and type(text) == 'string' and text ~= '' and text ~= 'None' then return text end
    ok, text = pcall(tostring, value)
    if ok and type(text) == 'string' then return text:match('%-%-%[%[%s*(.-)%s*%-%-%]%]') or text end
    return nil
end

local function gender(value)
    local text = nameText(value)
    text = type(text) == 'string' and text:lower() or ''
    if text:find('female', 1, true) or text:find('woman', 1, true) then return 'female' end
    if text:find('male', 1, true) or text:find('man', 1, true) then return 'male' end
    return nil
end

-- Default native adapter. Every call is guarded by the caller; tests replace it.
local function nativeAdapter()
    local N = {}
    function N.player() return Game.GetPlayer() end
    function N.ready(player)
        return player ~= nil and player:IsAttached() and not player:IsDeadNoStatPool() and not player:IsReplacer()
    end
    -- The game clock: hour and minute of the day. GameTime is a struct of whole game seconds, so the hour is the same
    -- whichever way it is read; the native accessors come first, the seconds count is the fallback.
    function N.clock()
        local system = Game.GetTimeSystem()
        local stamp = system and system:GetGameTime()
        if stamp == nil then return nil end
        local okHour, hour = pcall(function() return GameTime.Hours(stamp) end)
        local okMinute, minute = pcall(function() return GameTime.Minutes(stamp) end)
        if okHour and okMinute and integer(hour, 0, 23) and integer(minute, 0, 59) then return hour, minute, 'native' end
        local okSeconds, seconds = pcall(function() return stamp.seconds end)
        seconds = okSeconds and tonumber(seconds) or nil
        if not seconds then
            local okTotal, total = pcall(function() return GameTime.GetSeconds(stamp) end)
            seconds = okTotal and tonumber(total) or nil
        end
        if not seconds or seconds ~= seconds or seconds < 0 then return nil end
        seconds = math.floor(seconds) % 86400
        return math.floor(seconds / 3600), math.floor(seconds % 3600 / 60), 'seconds'
    end
    function N.gender(player) return player:GetResolvedGenderName() end
    function N.lifepath(player)
        local system = Game.GetScriptableSystemsContainer():Get('PlayerDevelopmentSystem')
        local path = system and system:GetLifePath(player)
        if path == nil then return nil end
        for native, normalized in pairs({Nomad = 'nomad', StreetKid = 'streetkid', Corporate = 'corpo'}) do
            if path == Enum.new('gamedataLifePath', native) then return normalized end
        end
        return nil
    end
    function N.vehicle(player) return player:GetMountedVehicle() ~= nil end
    -- The driver's seat is seat_front_left (the same read companion-vehicle-native.lua makes of V's own mount).
    function N.driving(player)
        local info = Game.GetMountingFacility():GetMountingInfoSingleWithObjects(player)
        local seat = info and info.slotId and NameToString(info.slotId.id)
        if type(seat) ~= 'string' then return nil end
        return seat == DRIVER_SEAT
    end
    return N
end

local Instance = {}
Instance.__index = Instance

-- options: activity() -> {rows = {[profileKey] = inputs for M.classify}, motion = 'still'|'walking'|'running'}, now() (seconds), log(line) (one line per real read, never per frame), native (adapter override),
-- place() -> {district =, area =} (init.lua's currentDistrict), party(player, radius) -> {{profileKey =, name =}}.
function M.new(options)
    options = options or {}
    return setmetatable({options = options, native = options.native or nativeAdapter(), snapshot = nil, at = nil,
        lifepath = nil}, Instance)
end

local function call(fn, ...)
    if type(fn) ~= 'function' then return nil end
    local ok, a, b, c = pcall(fn, ...)
    if ok then return a, b, c end
    return nil
end

function Instance:now()
    local value = self.options.now and self.options.now() or os.time()
    return type(value) == 'number' and value or os.time()
end

-- A new save, a death or a reload: drop the cache and the lifepath (a different save may be a different V).
function Instance:reset(reason)
    self.snapshot, self.at, self.lifepath, self.resetReason = nil, nil, nil, reason
end

local function placeName(value)
    return type(value) == 'string' and value:match('^[A-Za-z0-9][A-Za-z0-9 _.\'-]*$') and #value <= 64 and value or nil
end

function Instance:read()
    local N = self.native
    local player = call(N.player)
    if not player or not call(N.ready, player) then return nil, 'V is not ready (loading, dead or in a flashback)' end
    local snapshot, count = {version = 1, status = 'ready'}, 0
    local clockSource
    local hour, minute, source = call(N.clock)
    if integer(hour, 0, 23) and integer(minute, 0, 59) then
        snapshot.hour, snapshot.minute, clockSource = hour, minute, source
        count = count + 1
    end
    local place = call(self.options.place)
    if type(place) == 'table' then
        local district, area = placeName(place.district), placeName(place.area)
        if district then
            snapshot.district, snapshot.area = district, area ~= district and area or nil
            count = count + 1
        end
    end
    local sex = gender(call(N.gender, player))
    if sex then snapshot.gender = sex; count = count + 1 end
    -- The lifepath is fixed for a save: read once, and again only while it is unknown.
    if not self.lifepath then self.lifepath = call(N.lifepath, player) end
    if type(self.lifepath) == 'string' and self.lifepath:match('^[a-z]+$') then
        snapshot.lifepath = self.lifepath
        count = count + 1
    end
    local mounted = call(N.vehicle, player)
    if type(mounted) == 'boolean' then snapshot.vehicle = mounted; count = count + 1 end
    if mounted == true then
        local driving = call(N.driving, player)
        if type(driving) == 'boolean' then snapshot.driving = driving end
    end
    local rows = call(self.options.party, player, M.PARTY_RADIUS)
    if type(rows) == 'table' then
        local party, seen = {}, {}
        for _, row in ipairs(rows) do
            local key, name = type(row) == 'table' and row.profileKey or nil, type(row) == 'table' and clean(row.name, M.MAX_NAME) or nil
            if type(key) == 'string' and key:match('^[a-z0-9%-]+$') and #key <= 80 and name and not seen[key] and #party < M.MAX_PARTY then
                seen[key] = true
                party[#party + 1] = {key = key, name = name}
            end
        end
        if #party > 0 then
            -- What each companion is doing, and how V moves (the companion modules' own state; one read per turn window).
            local info = call(self.options.activity)
            if type(info) == 'table' then
                for _, row in ipairs(party) do
                    local inputs = type(info.rows) == 'table' and info.rows[row.key] or nil
                    if type(inputs) == 'table' then row.activity = M.classify(inputs) end
                end
                if MOTIONS[info.motion] and not snapshot.vehicle then snapshot.motion = info.motion end
            end
            snapshot.party = party; count = count + 1
        end
    end
    if count == 0 then return nil, 'nothing could be read' end
    return snapshot, count, clockSource
end

-- The snapshot for this turn, or nil. Reused for MAX_AGE seconds so a burst of turns (a group round, a voice start and
-- finish) reads the game once. A failed or empty read is not cached: the next turn tries again.
function Instance:capture()
    local now = self:now()
    if self.snapshot and self.at and now >= self.at and now - self.at < M.MAX_AGE then return self.snapshot end
    local ok, snapshot, detail, clockSource = pcall(self.read, self)
    -- One diagnostic line per real read (at most once per window): what the adapter built, so a live pass can compare the
    -- clock with the HUD and the place with the map.
    if type(self.options.log) == 'function' then
        local line
        if ok and snapshot then
            local party = snapshot.party and #snapshot.party or 0
            line = string.format('Turn context: %s %s %s %s vehicle=%s party=%d',
                snapshot.hour and string.format('%02d:%02d(%s)', snapshot.hour, snapshot.minute, tostring(clockSource)) or 'no-clock',
                snapshot.district and (snapshot.district .. (snapshot.area and ('/' .. snapshot.area) or '')) or 'no-place',
                snapshot.gender or 'no-gender', snapshot.lifepath or 'no-lifepath',
                snapshot.vehicle == nil and 'unknown' or tostring(snapshot.vehicle), party)
            -- What each companion was found doing, and V's motion (only when there was something to say).
            local doing = {}
            for _, row in ipairs(snapshot.party or {}) do
                if row.activity then doing[#doing + 1] = row.key .. '=' .. row.activity end
            end
            if #doing > 0 then line = line .. ' activity=' .. table.concat(doing, ',') end
            if snapshot.driving ~= nil then line = line .. ' driving=' .. tostring(snapshot.driving) end
            if snapshot.motion then line = line .. ' v=' .. snapshot.motion end
        else
            line = 'Turn context: none (' .. tostring(ok and detail or snapshot):sub(1, 160) .. ')'
        end
        pcall(self.options.log, line)
    end
    if not ok or not snapshot then self.snapshot, self.at = nil, nil; return nil end
    self.snapshot, self.at = snapshot, now
    return snapshot
end

return M
