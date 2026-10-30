-- The game side of the quest SOUNDS (mod/quest-audio.lua: a stage's `music` and `sfx`, docs/QUEST_PRIMITIVES.md section 10.10). The native calls only, each one guarded by its caller.
-- None of them runs per frame: a camera read happens when a positioned sound starts and, for a looping sound at a place, up to four times a second while it plays within 60 m,
-- the radio calls happen when a stage switches V's car radio and when it gives it back, a game sound is one audio system call to start and one to stop.
--
-- Sounds that are files of the pack are played by the bridge (runtime/media-command.json): nothing here plays them, it only tells the module where the camera and a copy are.
-- Entity handles are never kept: a copy is looked up when a sound starts, its entity ID is the only thing kept (to stop the sound again).
--
-- UNVERIFIED in the game (offline-tested on a fake game only, the first live run must look at each):
--   cameraPose       the camera origin and forward vector from the targeting system's crosshair data, the read mod/continuous-speech.lua makes for the speech pan (same sign: positive is V's right).
--   gamePlay/gameStop   Game.GetAudioSystem():Play(CName) flat, Play(CName, entityID) on the copy, Stop(CName[, entityID]) (mod/game-dialogue.lua already uses Stop with an entity ID).
--                    A wrong event name plays nothing and says nothing, so the module logs what it started.
--   radioSwitch/radioRestore   the mounted vehicle's ToggleRadioReceiver(bool), SetRadioReceiverStation(index), IsRadioReceiverActive(), GetCurrentRadioIndex() and the station found by name
--                    through GetRadioStationLocalizedName(index) (mod/media-context.lua reads names the same way). RequestSongOnRadioStation is not used. The pocket radio is not touched.
local M = {STATION_LIMIT = 48, STATION_GAP = 6}

local function finite(value) return type(value) == 'number' and value == value and math.abs(value) < 1e7 end

local function global(key)
    local ok, value = pcall(function() return _G[key] end)
    if ok and value ~= nil then return value end
    ok, value = pcall(rawget, _G, key)
    return ok and value or nil
end

-- A name compared without case, spaces and marks.
local function plain(text)
    if type(text) ~= 'string' then return nil end
    local out = text:lower():gsub('[^%w]', '')
    return out ~= '' and out or nil
end

-- deps: companions (conversationCandidates, to find a copy), log(line).
function M.new(deps)
    deps = deps or {}
    local W = {}
    local function log(line) if type(deps.log) == 'function' then pcall(deps.log, 'Quest audio world: ' .. line) end end
    local function player() return Game.GetPlayer() end

    -- The camera: where it is and which way it looks on the ground, {x, y, z, fx, fy}.
    function W.cameraPose()
        local p = player()
        if not p then return nil end
        local targeting = Game.GetTargetingSystem()
        local origin, forward
        local special = global('ConvaiCrosshairData')
        if type(special) == 'function' then origin, forward = special(targeting, p) else origin, forward = targeting:GetCrosshairData(p) end
        if origin == nil or forward == nil or not finite(origin.x) or not finite(origin.y) or not finite(origin.z) or not finite(forward.x) or not finite(forward.y) then return nil end
        return {x = origin.x, y = origin.y, z = origin.z, fx = forward.x, fy = forward.y}
    end

    -- The entity ID of the copy that speaks as `profileKey` (the mod's own copy), or nil. Looked up now, used only when attached.
    local function copyId(profileKey)
        local companions = deps.companions
        local p = player()
        if not p or type(companions) ~= 'table' or type(companions.conversationCandidates) ~= 'function' then return nil end
        for _, row in ipairs(companions.conversationCandidates(p, 100000)) do
            if row.profileKey == profileKey and row.npc ~= nil and row.npc:IsAttached() then return row.npc:GetEntityID() end
        end
        return nil
    end

    -- Starts a game sound event: flat, or on the entity of the copy of `profileKey` (then it needs the copy to be there). Returns a handle {event, id}, or nil and why.
    function W.gamePlay(event, profileKey)
        if type(event) ~= 'string' or not event:match('^[%w_]+$') then return nil, 'bad event' end
        local system = Game.GetAudioSystem()
        if system == nil then return nil, 'no audio system' end
        if profileKey ~= nil then
            local id = copyId(profileKey)
            if id == nil then return nil, 'the copy is not here' end
            system:Play(CName.new(event), id)
            return {event = event, id = id}
        end
        system:Play(CName.new(event))
        return {event = event}
    end

    -- The matching stop for a handle gamePlay returned.
    function W.gameStop(handle)
        if type(handle) ~= 'table' or type(handle.event) ~= 'string' then return false end
        local system = Game.GetAudioSystem()
        if system == nil then return false end
        if handle.id ~= nil then system:Stop(CName.new(handle.event), handle.id) else system:Stop(CName.new(handle.event)) end
        return true
    end

    -- ---- the car radio --------------------------------------------------------------------------------------------------------------------------
    local function vehicle()
        local p = player()
        return p and p:GetMountedVehicle() or nil
    end
    local function idText(v)
        local ok, text = pcall(function() return tostring(v:GetEntityID().hash) end)
        return ok and text or nil
    end
    local function stationName(index)
        local viaGame = Game ~= nil and Game.GetRadioStationLocalizedName
        local value
        if type(viaGame) == 'function' then value = Game.GetRadioStationLocalizedName(index)
        else value = global('GetRadioStationLocalizedName')(index) end
        return value
    end
    -- The index of the station with that name (case and spaces do not matter), or nil. One call per index, stopped after STATION_GAP empty ones in a row.
    local function stationIndex(wanted)
        local target = plain(wanted)
        if not target then return nil end
        local partial, gap = nil, 0
        for index = 0, M.STATION_LIMIT do
            local ok, name = pcall(stationName, index)
            local text = ok and type(name) == 'string' and plain(name) or nil
            if text then
                gap = 0
                if text == target then return index end
                if partial == nil and #target >= 4 and (text:find(target, 1, true) or target:find(text, 1, true)) then partial = index end
            else
                gap = gap + 1
                if gap >= M.STATION_GAP then break end
            end
        end
        return partial
    end

    -- Tunes V's car radio to the station (on if it was off). `keep` is the token of an earlier switch: the state to give back stays the one before the first switch.
    -- Returns a token {vehicle, wasOn, index}, or nil and why (V on foot, no such station).
    function W.radioSwitch(station, keep)
        local car = vehicle()
        if car == nil then return nil, 'V is on foot' end
        local index = stationIndex(station)
        if index == nil then return nil, 'no station named ' .. tostring(station) end
        local id = idText(car)
        local token = keep
        if token ~= nil and token.vehicle ~= id then return nil, 'another vehicle' end
        if token == nil then
            token = {vehicle = id, wasOn = car:IsRadioReceiverActive() == true, index = tonumber(car:GetCurrentRadioIndex())}
        end
        if car:IsRadioReceiverActive() ~= true then car:ToggleRadioReceiver(true) end
        car:SetRadioReceiverStation(index)
        return token
    end

    -- Gives the radio back as it was: the station it was on, or off. Only in the same vehicle V is in now.
    function W.radioRestore(token)
        if type(token) ~= 'table' then return false, 'no token' end
        local car = vehicle()
        if car == nil or idText(car) ~= token.vehicle then return false, 'V left the vehicle' end
        if token.wasOn then
            if finite(token.index) then car:SetRadioReceiverStation(token.index) end
        else
            car:ToggleRadioReceiver(false)
        end
        return true
    end

    return W
end

return M
