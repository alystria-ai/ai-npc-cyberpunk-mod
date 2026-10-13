-- Delamain Cab add-on for Cyberpunk Convai (docs/ADDON_API.md, addons/delamain/EVENTS.md).
-- Since patch 2.3 V can call a Delamain cab. This add-on gives the cab's AI a voice V can talk to and that comments on the ride,
-- and lets a companion from the main mod join the conversation. It is only a voice: it never writes a quest fact, sends the
-- cab or its AI a command, or touches the route. The game's own cab dialogue always wins (the main mod's scene gate).
--
-- Everything is event driven. The cab is a script state machine (fact delamain_taxi_state, 0 to 8); this file follows it from
-- ObserveAfter hooks on the cab's own callbacks and from the main mod's events. There is no onUpdate, no timer and no polling:
-- every handler is a few table writes, and the game reads (the quest fact, the district, the destination, the weather) happen
-- once per ride event, never per frame.
--
-- The game's own cab voice (greeting, "your wish is my command", the arrival announcement and farewell) is a quest scene. A remark
-- never starts over it: each remark asks the main mod to be patient (see WAIT below), so it waits for the scene or the game's subtitle
-- line to end, plus a short gap, and is spoken then if the ride is still in the state it was about. A line that has started plays on
-- through such a scene (the speaker's playThrough); a call, Johnny or a cinematic still stops it.
--
-- Installed as its own CET mod (CyberpunkConvaiDelamainCab). Without Cyberpunk Convai, or with one that is too old, it prints one
-- line and does nothing. Its text comes from Mistral or the local AI only (convai-addon.json "providers").
local Delamain = {handle = nil, speaker = nil, enabled = true, rides = 0, ride = nil, tracked = {},
    cab = {state = 0, entityId = nil, mounted = false}, hooks = {}}

local SPEAKER = 'delamain'
local STATE = {SPAWNED = 1, PARKED = 2, READY = 3, STARTED = 4, ARRIVED = 5, CANCELLED = 6, FINISHED = 7, FREEROAM = 8}
-- The cab entity's own record (quest data, delamain_taxi.questphase) and the garage entry. Either one identifies the cab; the
-- entity id captured from the cab's component is checked first, so a wrong record name here only loses the second check.
local CAB_RECORDS = {'Vehicle.v_standard2_villefort_cortes_delamain_player', 'Vehicle.v_delamain_taxi'}
local DISTRICT_AFTER = 25      -- seconds into the ride before a district may be remarked
local PASSED_MAX = 4

-- ---- Small helpers (pure) ------------------------------------------------------------------------------------------------------

local function nameText(value)
    if type(value) == 'string' then return value end
    if value == nil then return nil end
    local ok, text = pcall(NameToString, value)
    if ok and type(text) == 'string' and text ~= '' and text ~= 'None' then return text end
    return nil
end

--- 'LittleChina' / 'little_china' -> 'Little China'; nil for anything that is not a plain name.
local function pretty(raw)
    if type(raw) ~= 'string' or raw == '' or #raw > 48 then return nil end
    local text = raw:gsub('_', ' '):gsub('(%l)(%u)', '%1 %2'):match('^%s*(.-)%s*$')
    text = text:gsub('(%a)([%w\']*)', function(first, rest) return first:upper() .. rest end)
    if text == '' or not text:match('^[%a][%a%d \'%-%.]*$') then return nil end
    return text
end

--- 'judy-alvarez' -> 'Judy Alvarez'
local function personName(profileKey)
    if type(profileKey) ~= 'string' then return nil end
    return pretty((profileKey:gsub('%-', ' ')))
end

local function timeBand(hour)
    if hour < 5 then return 'dead of night' end
    if hour < 7 then return 'dawn' end
    if hour < 11 then return 'morning' end
    if hour < 14 then return 'midday' end
    if hour < 17 then return 'afternoon' end
    if hour < 20 then return 'evening' end
    if hour < 22 then return 'late evening' end
    return 'night'
end

local COMPASS = {'north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'}
--- Direction from (x1, y1) to (x2, y2) on the map (north is +y).
local function compass(x1, y1, x2, y2)
    local dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0 then return nil end
    local degrees = math.deg(math.atan2 and math.atan2(dx, dy) or math.atan(dx, dy))
    return COMPASS[math.floor(((degrees % 360) + 22.5) / 45) % 8 + 1]
end

local function xyz(value)
    if value == nil then return nil end
    local ok, x, y, z = pcall(function()
        local px, py, pz = value.x, value.y, value.z
        if type(px) ~= 'number' then px, py, pz = value.X, value.Y, value.Z end
        return px, py, pz
    end)
    if ok and type(x) == 'number' and type(y) == 'number' and x == x and y == y then return x, y, z end
    return nil
end

-- ---- Reads from the game (each guarded; called only at ride events) ---------------------------------------------------------

local function readState()
    local ok, value = pcall(function() return Game.GetQuestsSystem():GetFactStr('delamain_taxi_state') end)
    value = ok and tonumber(value) or nil
    if value and value >= 0 and value <= 8 and value == math.floor(value) then return value end
    return nil
end

local function readHour()
    local ok, hour = pcall(function() return GameTime.Hours(Game.GetTimeSystem():GetGameTime()) end)
    hour = ok and tonumber(hour) or nil
    if hour and hour >= 0 and hour <= 23 then return math.floor(hour) end
    return nil
end

local function readDistrict()
    local ok, top, specific = pcall(function()
        local system = Game.GetScriptableSystemsContainer():Get('PreventionSystem')
        local district = system and system:GetCurrentDistrict()
        local record = district and TweakDBInterface.GetDistrictRecord(district:GetDistrictID())
        if not record then return nil end
        local area = nameText(record:EnumName())
        local root, guard = record, 0
        while root and root:ParentDistrict() and guard < 6 do root, guard = root:ParentDistrict(), guard + 1 end
        return nameText(root:EnumName()), area
    end)
    if not ok then return nil end
    top, specific = pretty(top), pretty(specific)
    if not top then return nil end
    return top, specific ~= top and specific or nil
end

local function readWeather()
    local ok, text = pcall(function() return tostring(Game.GetWeatherSystem():GetRainIntensityType()):lower() end)
    if not ok or type(text) ~= 'string' then return nil end
    if text:find('heavy', 1, true) then return 'heavy rain' end
    if text:find('light', 1, true) then return 'light rain' end
    return nil
end

local function readHeat()
    local ok, value = pcall(function() return EnumInt(Game.GetScriptableSystemsContainer():Get('PreventionSystem'):GetHeatStage()) end)
    value = ok and tonumber(value) or nil
    if value and value >= 1 and value <= 5 then return math.floor(value) end
    return nil
end

--- The chosen destination: distance in metres and compass direction from V, the game's ETA and a name when the pin has a real one.
local function readDestination()
    local result = {}
    pcall(function()
        local auto = Game.GetScriptableSystemsContainer():Get(CName.new('AutoDriveSystem'))
        local x, y = xyz(auto:GetAutodriveDestination())
        local px, py = xyz(Game.GetPlayer():GetWorldPosition())
        if x and px then
            result.meters = math.floor(math.sqrt((x - px) ^ 2 + (y - py) ^ 2) + 0.5)
            result.direction = compass(px, py, x, y)
        end
        local eta = tonumber(auto:GetEstimatedTimeToArrival())
        if eta and eta >= 5 and eta < 7200 then result.eta = math.floor(eta + 0.5) end
        local pin = Game.GetMappinSystem():GetMappin(auto:GetAutodriveDestinationMappinID())
        local label = pin and pin:GetDisplayName()
        if type(label) == 'string' and label ~= '' and not label:match('^LocKey') and not label:lower():find('destination', 1, true)
            and not label:lower():find('delamain', 1, true) and #label <= 60 then result.name = label end
    end)
    if result.meters and (result.meters < 0 or result.meters > 200000) then result.meters, result.direction = nil, nil end
    return result
end

local function readFare()
    local ok, value = pcall(function() return Game.GetScriptableSystemsContainer():Get('DelamainTaxiSystem'):GetTravelCost() end)
    value = ok and tonumber(value) or nil
    if value and value > 0 and value < 1e7 then return math.floor(value) end
    return nil
end

-- ---- The ride ------------------------------------------------------------------------------------------------------------------

local function companions()
    local handle = Delamain.handle
    local list = {}
    if handle and type(handle.party) == 'function' then list = handle:party()
    else for key in pairs(Delamain.tracked) do list[#list + 1] = key end; table.sort(list) end
    return list
end

--- Facts every remark carries (EVENTS.md "Common facts"). Anything the game cannot say is left out.
local function commonFacts()
    local ride = Delamain.ride
    local facts = {rideNumber = ride and ride.number or nil}
    local hour = readHour()
    if hour then facts.hour, facts.timeOfDay = hour, timeBand(hour) end
    facts.district, facts.area = readDistrict()
    facts.weather = readWeather()
    local party = companions()
    if #party > 0 then facts.companion, facts.companionCount = personName(party[1]), #party end
    facts.wanted = readHeat()
    return facts
end

local function rideLive()
    local cab = Delamain.cab
    return cab.mounted and cab.state >= STATE.READY and cab.state <= STATE.FINISHED
end

local function phaseName()
    local state = Delamain.cab.state
    if state == STATE.READY then return 'waiting' end
    if state == STATE.STARTED then return 'riding' end
    if state == STATE.ARRIVED or state == STATE.FINISHED then return 'arrived' end
    if state == STATE.CANCELLED then return 'interrupted' end
    return nil
end

--- The add-on state the bridge module reads for talk turns (plain data, updated at ride events only).
local function publish()
    local handle, ride = Delamain.handle, Delamain.ride
    if not handle then return end
    if not ride or not rideLive() then handle:setState(nil); return end
    local facts = ride.last or {}
    handle:setState({phase = phaseName(), rideNumber = ride.number, boardedAt = ride.boardedAt and ride.boardedAt * 1000 or nil,
        startedAt = ride.startedAt and ride.startedAt * 1000 or nil, startDistrict = ride.startDistrict, startArea = ride.startArea,
        district = facts.district, area = facts.area, timeOfDay = facts.timeOfDay, hour = facts.hour, weather = facts.weather,
        companion = facts.companion, companionCount = facts.companionCount, wanted = facts.wanted, fare = ride.fare,
        meters = ride.meters, direction = ride.direction, destinationName = ride.destinationName, passed = ride.passed})
end

local function companionNote()
    local ride = Delamain.ride
    local text = 'You are riding in a Delamain cab with V. Delamain is the cab\'s AI: it drives, it can hear you and it may speak to you; '
        .. 'you can talk to it too.'
    if ride and Delamain.cab.state == STATE.STARTED then
        text = text .. ' The ride is under way'
        if ride.meters then text = text .. ' to a point about ' .. ride.meters .. ' metres ' .. (ride.direction and ('to the ' .. ride.direction) or 'away') end
        text = text .. '.'
    end
    return text
end

local function syncCompanionContext()
    local handle = Delamain.handle
    if not handle then return end
    if rideLive() then handle:setCompanionContext('ride', companionNote()) else handle:setCompanionContext('ride', nil) end
end

local REENTER_WINDOW = 20   -- seconds after V steps out of the cab in which stepping back in continues the same ride

local function endRide(why)
    local handle = Delamain.handle
    Delamain.ride = nil
    if handle then
        handle:setState(nil)
        handle:setCompanionContext('ride', nil)
    end
end

-- How each remark meets the game's own cab voice. `patience` (seconds) is how long it waits for a scene or a game line to end (the main
-- mod's handle:remark option); `states` are the cab states in which it is still worth saying when its turn comes. The arrival stays
-- relevant while V sits in the stopped cab (Arrived, then Finished after the game's farewell), so it comes right after that farewell.
local WAIT = {
    boarded = {patience = 30, states = {[STATE.READY] = true}},
    ['ride-start'] = {patience = 20, states = {[STATE.STARTED] = true}},
    ['district-passed'] = {patience = 12, states = {[STATE.STARTED] = true}},
    arrival = {patience = 25, states = {[STATE.ARRIVED] = true, [STATE.FINISHED] = true}},
    ['ride-interrupted'] = {patience = 20, states = {[STATE.CANCELLED] = true}},
}

--- Asks for one remark. facts = commonFacts() plus the event's own. The remark waits for the game's own cab voice (WAIT) and is only
--- spoken if the ride is still in a state it fits, on the same ride.
local function say(event, text, extra, priority, ttl, maxWords)
    local handle = Delamain.handle
    if not handle or not Delamain.enabled or not rideLive() then return false, 'not riding' end
    local facts = commonFacts()
    for key, value in pairs(extra or {}) do facts[key] = value end
    if Delamain.ride then Delamain.ride.last = facts end
    publish()
    local rule, ride = WAIT[event] or {patience = 0, states = {}}, Delamain.ride
    local function relevant()
        return rideLive() and Delamain.ride == ride and rule.states[Delamain.cab.state] == true
    end
    local ok, reason = handle:remark(SPEAKER, {event = event, text = text, facts = facts, priority = priority, ttl = ttl, maxWords = maxWords,
        patience = rule.patience, relevant = rule.patience > 0 and relevant or nil})
    if not ok then handle:log('remark ' .. event .. ' not made: ' .. tostring(reason)) end
    return ok, reason
end

local function ensureRide()
    if not Delamain.ride then
        Delamain.rides = Delamain.rides + 1
        Delamain.ride = {number = Delamain.rides, passed = {}, boardedSpoken = false, districtDone = false}
    end
    return Delamain.ride
end

local function requestBoarded()
    local ride = ensureRide()
    if ride.boardedAsked or Delamain.cab.state ~= STATE.READY then return end
    ride.boardedAsked = true
    ride.boardedAt = ride.boardedAt or os.time()
    ride.startDistrict, ride.startArea = readDistrict()
    Delamain.handle:prepare(SPEAKER)
    say('boarded', 'V has just sat down in the Delamain cab and has not chosen a destination yet. The cab\'s own greeting has already played.',
        {destinationChosen = false, firstRideThisSession = ride.number == 1}, 4, 15, 22)
end

local function requestRideStart()
    local handle, ride = Delamain.handle, ensureRide()
    local spoke = ride.boardedSpoken
    -- A greeting that has not started (waiting for the game's own greeting to end, or being written) is dropped: the ride line greets
    -- instead. One that is already playing is left alone (remarkStarted marks it).
    if not spoke then handle:cancel(SPEAKER) end
    ride.startedAt = ride.startedAt or os.time()
    if not ride.startDistrict then ride.startDistrict, ride.startArea = readDistrict() end
    local destination = readDestination()
    ride.meters, ride.direction, ride.destinationName = destination.meters, destination.direction, destination.name
    ride.fare = Delamain.pendingFare or readFare()
    Delamain.pendingFare = nil
    ride.eta = destination.eta
    handle:prepare(SPEAKER)
    say('ride-start', 'V chose a destination and the Delamain cab has started driving there.' .. (spoke
        and ' You have already greeted V this ride.' or ' You have not spoken to V yet this ride.'),
        {greeting = not spoke, destinationDistanceMeters = ride.meters, destinationDirection = ride.direction, fare = ride.fare,
            etaSeconds = ride.eta, destinationName = ride.destinationName}, 4, 12, 24)
end

local function requestArrival()
    local ride = ensureRide()
    if ride.arrivalAsked then return end
    ride.arrivalAsked = true
    local seconds = ride.startedAt and math.max(0, os.time() - ride.startedAt) or nil
    local passed = nil
    if #ride.passed > 0 then
        passed = {}
        for index, name in ipairs(ride.passed) do passed[index] = name end
    end
    say('arrival', 'The Delamain cab has stopped at the destination. The cab\'s own arrival announcement has already played.',
        {rideSeconds = seconds, rideMinutes = seconds and math.max(1, math.floor(seconds / 60 + 0.5)) or nil, fare = ride.fare,
            startDistrict = ride.startDistrict, districtsPassed = passed}, 5, 12, 26)
end

local function requestInterrupted()
    local ride = ensureRide()
    local seconds = ride.startedAt and math.max(0, os.time() - ride.startedAt) or nil
    say('ride-interrupted', 'The cab\'s autopilot stopped before reaching the destination, and V is still inside.',
        {rideSeconds = seconds, cause = 'the autopilot stopped before the destination'}, 4, 10, 22)
end

--- A cab state change (previous -> value). `silent` for a state found when a save loads: no remark, context only.
local function transition(previous, value, silent)
    if value == STATE.READY then
        -- A new ride starts when the cab becomes ready from a waiting state; never reuse an old record.
        if previous < STATE.READY then Delamain.ride, Delamain.pendingFare = nil, nil end
        ensureRide()
        if Delamain.cab.mounted and not silent then requestBoarded() end
    elseif value == STATE.STARTED then
        if Delamain.cab.mounted and not silent then requestRideStart() else
            ensureRide().startedAt = ensureRide().startedAt or os.time()
        end
    elseif value == STATE.ARRIVED then
        if Delamain.cab.mounted and not silent then requestArrival() end
    elseif value == STATE.FINISHED then
        -- The game's farewell is over; the arrival remark (waiting for it in the main mod) is released by the scene ending.
    elseif value == STATE.CANCELLED then
        if Delamain.cab.mounted and not silent and previous == STATE.STARTED then requestInterrupted() end
    elseif value == STATE.FREEROAM or value == STATE.PARKED or value == STATE.SPAWNED or value == 0 then
        if previous >= STATE.READY then endRide('finished') end
        if value == 0 then Delamain.cab.entityId = nil end
    end
    publish()
    syncCompanionContext()
end

--- Reads the fact and runs the transition when it changed. Every cab hook calls this; repeats cost one fact read.
local function sync(entityHash, silent)
    if entityHash then Delamain.cab.entityId = entityHash end
    local value = readState()
    if value == nil or value == Delamain.cab.state then return end
    local previous = Delamain.cab.state
    Delamain.cab.state = value
    transition(previous, value, silent)
end

local function entityHash(component)
    local ok, hash = pcall(function() return tostring(component:GetEntity():GetEntityID().hash) end)
    if ok and type(hash) == 'string' and hash:match('^%d+ULL$') then return hash end
    return nil
end

local function isCab(vehicle, id)
    if vehicle == nil then return false end
    if Delamain.cab.entityId and id == Delamain.cab.entityId then return true end
    local ok, match = pcall(function()
        local record = vehicle:GetRecordID()
        for _, name in ipairs(CAB_RECORDS) do if record == TweakDBID.new(name) then return true end end
        return false
    end)
    if ok and match then return true end
    -- States 3 to 7 exist only while V sits in the cab, so a vehicle entered then is the cab.
    return Delamain.cab.entityId == nil and Delamain.cab.state >= STATE.READY and Delamain.cab.state <= STATE.FINISHED
end

-- ---- Game hooks ----------------------------------------------------------------------------------------------------------------

local function hook(kind, class, method, fn)
    local observe = kind == 'before' and ObserveBefore or ObserveAfter
    local ok, err = pcall(observe, class, method, function(self, ...)
        -- Not while the main mod has released its session (a load, a detach, a death): the cab, its component and the quest
        -- system are then being destroyed, and a native read from this callback can crash the game (pcall cannot catch that).
        -- A cab found at the start of a session is picked up by 'sessionStarted'.
        if not Delamain.handle or not Delamain.handle:live() then
            -- Counted by name and logged at the next session start: it shows which cab callbacks the engine sends while it tears a world down.
            local skipped = Delamain.skipped
            if not skipped then skipped = {}; Delamain.skipped = skipped end
            local key = class .. '.' .. method
            skipped[key] = (skipped[key] or 0) + 1
            return
        end
        local good, problem = pcall(fn, self, ...)
        if not good then Delamain.hooks[class .. '.' .. method .. '!'] = tostring(problem) end
    end)
    Delamain.hooks[class .. '.' .. method] = ok and 'hooked' or tostring(err)
    return ok
end

local function installHooks()
    -- The one callback that carries every state change (the cab writes the fact; the scene writes some states too).
    local factHooked = hook('after', 'DelamainTaxiComponent', 'OnFactChanged', function(self) sync(entityHash(self)) end)
    -- Specific callbacks: each also syncs, so a state change is seen even when OnFactChanged cannot be hooked.
    hook('after', 'DelamainTaxiComponent', 'OnGameAttach', function(self) sync(entityHash(self), true) end)
    hook('after', 'DelamainTaxiComponent', 'StartAutoDrive', function(self) sync(entityHash(self)) end)
    hook('after', 'DelamainTaxiComponent', 'OnDelamainTaxiArrivedEvent', function(self) sync(entityHash(self)) end)
    hook('after', 'DelamainTaxiComponent', 'CancelRide', function(self) sync(entityHash(self)) end)
    if not factHooked then hook('after', 'DelamainTaxiComponent', 'SetState', function(self) sync(entityHash(self)) end) end
    -- The fare, read before the ride starts (the request carries it; the system's travel cost is the fallback).
    hook('before', 'DelamainTaxiSystem', 'OnStartDelamainTaxiRequest', function(_, request)
        local ok, price = pcall(function() return tonumber(request.m_price) end)
        if ok and price and price > 0 and price < 1e7 then Delamain.pendingFare = math.floor(price) end
    end)
    -- A district boundary crossed during the ride: at most one remark per ride (set up as a rare, cheap callback).
    hook('after', 'PreventionSystem', 'OnDistrictAreaEntered', function()
        local ride = Delamain.ride
        if not ride or Delamain.cab.state ~= STATE.STARTED or not ride.startedAt then return end
        if ride.districtDone and #ride.passed >= PASSED_MAX then return end
        local district = readDistrict()
        if not district then return end
        if district ~= ride.lastDistrict then
            ride.lastDistrict = district
            if district ~= ride.startDistrict then
                local seen = false
                for _, name in ipairs(ride.passed) do if name == district then seen = true end end
                if not seen and #ride.passed < PASSED_MAX then ride.passed[#ride.passed + 1] = district end
            end
        end
        if ride.districtDone or district == ride.startDistrict or os.time() - ride.startedAt < DISTRICT_AFTER then return end
        local ok = say('district-passed', 'During the ride the cab crossed from ' .. tostring(ride.startDistrict or 'where it started')
            .. ' into ' .. district .. '.', {previousDistrict = ride.startDistrict, rideSeconds = os.time() - ride.startedAt}, 3, 8, 18)
        if ok then ride.districtDone = true end
    end)
end

-- ---- Registration ---------------------------------------------------------------------------------------------------------

registerForEvent('onInit', function()
    local main = GetMod('CyberpunkConvai')
    local api = type(main) == 'table' and main.addons or nil
    if not api then
        print('[Delamain Cab] Cyberpunk Convai is not installed (or is older than the add-on API); the cab stays quiet.')
        return
    end
    local handle, reason = api.register({id = 'delamain-cab', name = 'Delamain Cab', version = '1.0.0', requires = '1.0'})
    if not handle then
        print('[Delamain Cab] Not registered: ' .. tostring(reason))
        return
    end
    Delamain.handle = handle

    -- The voice is the cab V sits in. Cheap on purpose: it reads two cached values (the main mod calls it on its tick).
    Delamain.speaker = handle:speaker({id = SPEAKER, name = 'Delamain', anchor = 'vehicle', group = true, minGap = 6, talkPriority = 10, playThrough = true,
        available = function() return Delamain.enabled and rideLive() end})

    handle:settings({title = 'Delamain Cab', description = 'The voice of the Delamain cab: it talks with you on a ride, and with your companion.',
        items = {{id = 'enabled', label = 'Delamain speaks on rides', kind = 'bool', default = true,
            description = 'Delamain comments on the ride and answers the talk key while you sit in his cab. Off keeps the cab silent.'}}})
    Delamain.enabled = handle:setting('enabled') ~= false
    handle:on('settingChanged', function(change)
        if change.id == 'enabled' then Delamain.enabled = change.value ~= false; handle:setEnabled(Delamain.enabled) end
    end)
    handle:setEnabled(Delamain.enabled)

    installHooks()
    local failed = {}
    for name, status in pairs(Delamain.hooks) do if status ~= 'hooked' and not name:match('!$') then failed[#failed + 1] = name end end
    table.sort(failed)
    if #failed > 0 then handle:log('hooks that could not be installed: ' .. table.concat(failed, ', ')) end

    -- The game state V sits in, from the main mod's events (it samples its own state on a tick; nothing here polls).
    handle:on('vehicleEntered', function(payload)
        Delamain.cab.mounted = isCab(payload.vehicle, payload.vehicleId)
        if not Delamain.cab.mounted then return end
        -- V is back after a short gap (the mount flickers during a seat change): the same ride. After a long one it is a new ride.
        local ride = Delamain.ride
        if ride and ride.exitedAt then
            if os.time() - ride.exitedAt > REENTER_WINDOW then Delamain.ride = nil else ride.exitedAt = nil end
        end
        sync(nil)
        if rideLive() then
            publish(); syncCompanionContext()
            if Delamain.cab.state == STATE.READY then requestBoarded() end
        end
    end)
    handle:on('vehicleExited', function()
        if not Delamain.cab.mounted then return end
        Delamain.cab.mounted = false
        -- Nothing is cancelled: a remark that is playing finishes (the main mod ends one only for a scene), and one still
        -- waiting is given up by the main mod when the cab stays unavailable. The ride is kept for a short while in case V is back.
        if Delamain.ride then Delamain.ride.exitedAt = os.time() end
        handle:setState(nil)
        handle:setCompanionContext('ride', nil)
    end)
    handle:on('sessionStarted', function()
        local skipped = Delamain.skipped
        if skipped then
            Delamain.skipped = nil
            local parts = {}
            for key, count in pairs(skipped) do parts[#parts + 1] = key .. ' x' .. count end
            table.sort(parts)
            handle:log('cab callbacks ignored while the previous session was released: ' .. table.concat(parts, ', '))
        end
        -- A cab found when the game loads: pick the state up silently (and assume V is in it when it is a ride state).
        Delamain.cab.state = 0
        local value = readState()
        if value then
            Delamain.cab.state = value
            Delamain.cab.mounted = value >= STATE.READY and value <= STATE.FINISHED and handle:state().vehicle == true
            if Delamain.cab.mounted then transition(0, value, true) end
        end
    end)
    handle:on('sessionEnded', function()
        Delamain.cab = {state = 0, entityId = nil, mounted = false}
        Delamain.ride, Delamain.rides, Delamain.pendingFare, Delamain.tracked = nil, 0, nil, {}
    end)
    handle:on('companionJoined', function(payload) Delamain.tracked[payload.profileKey] = true end)
    handle:on('companionLeft', function(payload) Delamain.tracked[payload.profileKey] = nil end)
    handle:on('remarkStarted', function(payload)
        local event = type(payload.event) == 'string' and payload.event or nil
        if event == 'boarded' and Delamain.ride then Delamain.ride.boardedSpoken = true end
    end)
    handle:on('remarkFinished', function(payload)
        if payload.event == 'boarded' and payload.spoken and Delamain.ride then Delamain.ride.boardedSpoken = true end
    end)
end)

return Delamain
