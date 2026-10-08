-- Developer-mode Lua frame-cost probe. init.lua installs it once at load; it
-- adds no upvalue to the onUpdate closure. It wraps fields of the mod's global
-- module tables (and json/io/os file calls) with os.clock deltas, aggregates
-- them per 2 s window and writes runtime/perf-probe.json. With Developer mode
-- off, only the per-frame tick runs: one cached flag check, no allocation.
-- os.clock has 1 ms resolution in CET; means over many calls stay unbiased.
local M = convaiPerfProbe or {}
convaiPerfProbe = M
local WINDOW, HISTORY, FLAG_PERIOD = 2, 150, 1
local clock = os.clock

local stats, opens, history = {}, {}, {}
local frames, frameSum, frameMax, over25, over40 = 0, 0, 0, 0, 0
local lastFrame, windowAt, flagAt, enabled, wrapped = nil, nil, nil, false, false
local wrappers = {}

local function record(label, dt)
    if not enabled then return end
    local s = stats[label]
    if not s then s = {0, 0, 0}; stats[label] = s end
    s[1], s[2] = s[1] + 1, s[2] + dt
    if dt > s[3] then s[3] = dt end
end
local function finish(label, t0, ...)
    if enabled then record(label, clock() - t0) end
    return ...
end
local function wrap(tbl, field, label)
    if type(tbl) ~= 'table' then return end
    local original = tbl[field]
    if type(original) ~= 'function' then return end
    wrappers[#wrappers + 1] = {tbl, field, original}
    tbl[field] = function(...)
        if not enabled then return original(...) end
        return finish(label, clock(), original(...))
    end
end

local function sizeLabel(value)
    local size = type(value) == 'string' and #value or 0
    return size >= 32768 and 'json.decode>=32KB' or (size >= 4096 and 'json.decode4-32KB' or 'json.decode<4KB')
end

-- Globals that exist only after onInit are wrapped on the first enabled frame.
local function wrapAll()
    wrapped = true
    if type(json) == 'table' and type(json.decode) == 'function' then
        local decode, encode = json.decode, json.encode
        wrappers[#wrappers + 1] = {json, 'decode', decode}
        json.decode = function(value)
            if not enabled then return decode(value) end
            return finish(sizeLabel(value), clock(), decode(value))
        end
        if type(encode) == 'function' then
            wrappers[#wrappers + 1] = {json, 'encode', encode}
            json.encode = function(value)
                if not enabled then return encode(value) end
                return finish('json.encode', clock(), encode(value))
            end
        end
    end
    local open, rename, remove = io.open, os.rename, os.remove
    wrappers[#wrappers + 1] = {io, 'open', open}
    io.open = function(path, mode, ...)
        if not enabled then return open(path, mode, ...) end
        local key = tostring(path):gsub('^runtime/', ''):sub(1, 48) .. ':' .. tostring(mode or 'r')
        opens[key] = (opens[key] or 0) + 1
        return finish('io.open', clock(), open(path, mode, ...))
    end
    wrappers[#wrappers + 1] = {os, 'rename', rename}
    os.rename = function(...)
        if not enabled then return rename(...) end
        return finish('os.rename', clock(), rename(...))
    end
    wrappers[#wrappers + 1] = {os, 'remove', remove}
    os.remove = function(...)
        if not enabled then return remove(...) end
        return finish('os.remove', clock(), remove(...))
    end
    wrap(convaiSpeech, 'update', 'speech.update')
    wrap(convaiFacialPlayback, 'updateContinuous', 'face.updateContinuous')
    wrap(convaiFacialPlayback, 'sync', 'face.sync')
    wrap(convaiFacialPlayback, 'beginExpressionFrame', 'face.beginExpressionFrame')
    wrap(convaiFacialPlayback, 'updateExpressions', 'face.updateExpressions')
    wrap(convaiSubtitles, 'update', 'subtitles.update')
    wrap(convaiCompanions, 'update', 'companions.update')
    wrap(convaiCompanions, 'conversationCandidates', 'companions.conversationCandidates')
    wrap(convaiManager, 'update', 'mcm.update')
    wrap(convaiPhoneChat, 'update', 'phoneChat.update')
    wrap(convaiGameplayActions, 'update', 'gameplayActions.update')
    wrap(convaiCompanionAdoption, 'update', 'adoption.update')
    wrap(convaiInvitations, 'update', 'invitations.update')
    wrap(convaiVanillaReactions, 'stimulus', 'vanilla.stimulus')
    wrap(convaiVanillaReactions, 'reaction', 'vanilla.reaction')
    wrap(convaiVanillaReactions, 'bump', 'vanilla.bump')
end

local function publish(now)
    local span = math.max(now - windowAt, 1e-6)
    local speech = convaiSpeech
    local row = {at = os.time(), span = span, fps = frames / span,
        frameMeanMs = frames > 0 and 1000 * frameSum / frames or 0, frameMaxMs = 1000 * frameMax,
        over25ms = over25, over40ms = over40,
        speaking = type(speech) == 'table' and speech.requestId ~= nil,
        continuous = type(speech) == 'table' and speech.continuous == true,
        sections = {}, opens = opens}
    for label, s in pairs(stats) do
        row.sections[label] = {calls = s[1], msPerSecond = 1000 * s[2] / span, maxMs = 1000 * s[3]}
    end
    history[#history + 1] = row
    if #history > HISTORY then table.remove(history, 1) end
    stats, opens = {}, {}
    frames, frameSum, frameMax, over25, over40 = 0, 0, 0, 0, 0
    windowAt = now
    local was = enabled
    enabled = false -- the probe's own write is not attributed to the mod
    local ok, raw = pcall(json.encode, {version = 1, windowSeconds = WINDOW, history = history})
    if ok and type(raw) == 'string' then
        local file = io.open('runtime/perf-probe.json', 'wb')
        if file then file:write(raw); file:close() end
    end
    enabled = was
end

-- Called first in each onUpdate (through companions.beginSpatialFrame).
local function tick(developer)
    local now = clock()
    if not flagAt or now - flagAt >= FLAG_PERIOD or now < flagAt then
        flagAt = now
        local ok, value = pcall(developer)
        local on = ok and value == true
        if on and not enabled then
            stats, opens, lastFrame, windowAt = {}, {}, nil, now
            frames, frameSum, frameMax, over25, over40 = 0, 0, 0, 0, 0
        end
        enabled = on
        if enabled and not wrapped then wrapAll() end
    end
    if not enabled then lastFrame = nil; return end
    if lastFrame then
        local dt = now - lastFrame
        frames, frameSum = frames + 1, frameSum + dt
        if dt > frameMax then frameMax = dt end
        if dt > .025 then over25 = over25 + 1 end
        if dt > .040 then over40 = over40 + 1 end
    end
    lastFrame = now
    if now - windowAt >= WINDOW then pcall(publish, now) end
end

-- Called first in init.lua, before any hook or event is registered: every
-- Override/Observe handler and the onUpdate callback are wrapped so Developer
-- mode reports how often each fires and its Lua time ('hook:Class.Method',
-- 'event:onUpdate'). An Override's time includes the native method it wraps.
-- Disabled, each wrapper adds one Lua call and a flag check.
local function timedHandler(label, handler)
    return function(...)
        if not enabled then return handler(...) end
        return finish(label, clock(), handler(...))
    end
end
function M.hookRegistrations()
    if M.registrationsWrapped then return false end
    M.registrationsWrapped = true
    local function wrapRegister(register)
        if type(register) ~= 'function' then return register end
        return function(class, method, handler, ...)
            if type(handler) == 'function' then
                handler = timedHandler('hook:' .. tostring(class) .. '.' .. tostring(method), handler)
            end
            return register(class, method, handler, ...)
        end
    end
    -- Plain globals: the CET sandbox shares them across this mod's files.
    Override, ObserveAfter = wrapRegister(Override), wrapRegister(ObserveAfter)
    ObserveBefore, Observe = wrapRegister(ObserveBefore), wrapRegister(Observe)
    local registerEvent = registerForEvent
    if type(registerEvent) == 'function' then
        registerForEvent = function(event, handler, ...)
            if event == 'onUpdate' and type(handler) == 'function' then handler = timedHandler('event:onUpdate', handler) end
            return registerEvent(event, handler, ...)
        end
    end
    return true
end

-- developer(): returns true while the manager's Developer mode is on.
function M.install(companions, developer)
    if M.installed or type(companions) ~= 'table' or type(companions.beginSpatialFrame) ~= 'function'
        or type(developer) ~= 'function' then return false end
    local original = companions.beginSpatialFrame
    wrappers[#wrappers + 1] = {companions, 'beginSpatialFrame', original}
    companions.beginSpatialFrame = function(...)
        tick(developer)
        return original(...)
    end
    M.installed = true
    return true
end

-- Restores every wrapped field (tests; a CET reload discards them anyway).
function M.uninstall()
    for index = #wrappers, 1, -1 do
        local row = wrappers[index]
        row[1][row[2]] = row[3]
    end
    wrappers, wrapped, enabled, M.installed = {}, false, false, false
end

function M.enabled() return enabled end

return M
