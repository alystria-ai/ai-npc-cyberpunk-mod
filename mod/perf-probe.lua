-- Developer-mode Lua frame-cost probe. init.lua installs it once at load; it
-- adds no upvalue to the onUpdate closure. It wraps fields of the mod's global
-- module tables (and json/io/os file calls) with os.clock deltas, aggregates
-- them per 2 s window and writes runtime/perf-probe.json. With Developer mode
-- off, only the per-frame tick runs: one cached flag check, no allocation.
-- os.clock has 1 ms resolution in CET; means over many calls stay unbiased.
-- init.lua runs this file twice (hookRegistrations at the very top, install
-- after the modules load). A second chunk would get its own 'enabled' flag,
-- so the hook and onUpdate wrappers made by the first one never recorded
-- (no 'hook:' or 'event:onUpdate' rows in the 2026-10-11 live capture).
if type(convaiPerfProbe) == 'table' and convaiPerfProbe.chunkLoaded then return convaiPerfProbe end
local M = convaiPerfProbe or {}
convaiPerfProbe = M
M.chunkLoaded = true
-- WRITE_PERIOD: the file is rewritten at most this often (a full 150-window history is ~650 KB: encoding
-- and writing all of it every window cost ~40 ms on the game thread, ~20 ms/s of the probe's own overhead,
-- the 2026-10-13 capture). Each window is encoded once, when it closes, and the file is the concatenation.
local WINDOW, HISTORY, FLAG_PERIOD, WRITE_PERIOD = 2, 150, 1, 10
local clock = os.clock

local stats, opens, history = {}, {}, {} -- history: one encoded row (JSON text) per closed window
local writtenAt, dirty = nil, false
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
    wrap(convaiManager, 'update', 'manager.update')
    wrap(convaiPhoneChat, 'update', 'phoneChat.update')
    wrap(convaiGameplayActions, 'update', 'gameplayActions.update')
    wrap(convaiCompanionAdoption, 'update', 'adoption.update')
    wrap(convaiInvitations, 'update', 'invitations.update')
    wrap(convaiVanillaReactions, 'stimulus', 'vanilla.stimulus')
    wrap(convaiVanillaReactions, 'reaction', 'vanilla.reaction')
    wrap(convaiVanillaReactions, 'bump', 'vanilla.bump')
    -- The rest of the per-frame top half of onUpdate, so 'event:onUpdate'
    -- minus the wrapped sections leaves only init.lua's own local work.
    wrap(convaiUiLocale, 'update', 'ui.update')
    wrap(convaiComposerInput, 'update', 'composer.update')
    wrap(convaiPhoneLayout, 'refresh', 'phoneLayout.refresh')
    wrap(convaiPhoneChatStyle, 'refresh', 'phoneChatStyle.refresh')
    wrap(convaiAutoConnect, 'heartbeat', 'autoConnect.heartbeat')
    wrap(convaiAutoConnect, 'update', 'autoConnect.update')
    for _, row in ipairs(M.watched or {}) do wrap(row[1], row[2], row[3]) end
end

-- Writes runtime/perf-probe.json ({version, windowSeconds, history[]}, the shape readers know) from the encoded rows.
local function writeFile()
    local was = enabled
    enabled = false -- the probe's own write is not attributed to the mod
    local file = io.open('runtime/perf-probe.json', 'wb')
    if file then
        file:write('{"version":1,"windowSeconds":', tostring(WINDOW), ',"history":[', table.concat(history, ','), ']}')
        file:close()
    end
    enabled = was
    dirty, writtenAt = false, clock()
end
-- Writes now if any window closed since the last write (tests, a clean stop, Developer mode turning off).
function M.flush() if dirty then pcall(writeFile) end end

local function publish(now)
    local span = math.max(now - windowAt, 1e-6)
    local speech = convaiSpeech
    local heapOk, heap = pcall(collectgarbage, 'count')
    local row = {at = os.time(), span = span, fps = frames / span,
        frameMeanMs = frames > 0 and 1000 * frameSum / frames or 0, frameMaxMs = 1000 * frameMax,
        over25ms = over25, over40ms = over40,
        speaking = type(speech) == 'table' and speech.requestId ~= nil,
        continuous = type(speech) == 'table' and speech.continuous == true,
        sections = {}, opens = opens,
        -- Lua heap after the window: shared 50-90 ms frames may be GC steps.
        luaKB = heapOk and type(heap) == 'number' and heap or nil,
        -- The ordinary-NPC face mode in effect (runtime/crowd-face-mode.txt: off, ungated, gated; "default" is gated
        -- with no file), so every window of an FPS comparison says which build it measured.
        crowdFace = type(convaiFacialPlayback) == 'table' and convaiFacialPlayback.crowdMode or 'default',
        -- The hook behind the MoveTo observer ('filtered': ConvaiOwnedMoveUpdate, only our marked commands; 'engine': every
        -- walking NPC's UpdateCommand; nil: not installed), so a window says which one its hook rows measured.
        locomotionHook = type(convaiLocomotion) == 'table' and convaiLocomotion.mode or nil,
        -- Hook handlers wrapped so far (0 with hooks registered: the wrap missed them).
        hooksWrapped = M.hooksWrapped}
    for label, s in pairs(stats) do
        row.sections[label] = {calls = s[1], msPerSecond = 1000 * s[2] / span, maxMs = 1000 * s[3]}
    end
    stats, opens = {}, {}
    frames, frameSum, frameMax, over25, over40 = 0, 0, 0, 0, 0
    windowAt = now
    local was = enabled
    enabled = false -- the probe's own encode is not attributed to the mod
    local ok, raw = pcall(json.encode, row)
    enabled = was
    if ok and type(raw) == 'string' then
        history[#history + 1] = raw
        if #history > HISTORY then table.remove(history, 1) end
        dirty = true
        -- The first window is written at once (the file exists early), then every WRITE_PERIOD.
        if not writtenAt or now - writtenAt >= WRITE_PERIOD or now < writtenAt then pcall(writeFile) end
    end
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
        if enabled and not on then M.flush() end
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

-- Segments of init.lua's own onUpdate work: mark(label) charges the time since
-- the previous mark to the previous label, and the onUpdate wrapper closes the
-- last one, so an early return ends its segment there. An 'init:' segment
-- includes any wrapped section it calls (subtract those rows). Disabled, a
-- mark is one call and a flag check.
local markLabel, markAt
function M.mark(label)
    if not enabled then return end
    local now = clock()
    if markLabel then record(markLabel, now - markAt) end
    markLabel, markAt = label, now
end
local function finishUpdate(t0, ...)
    if enabled then
        local now = clock()
        if markLabel then record(markLabel, now - markAt); markLabel = nil end
        record('event:onUpdate', now - t0)
    end
    return ...
end
local function timedUpdate(handler)
    return function(...)
        if not enabled then return handler(...) end
        markLabel = nil
        return finishUpdate(clock(), handler(...))
    end
end
function M.hookRegistrations()
    if M.registrationsWrapped then return false end
    M.registrationsWrapped = true
    M.hooksWrapped = 0
    local ours = setmetatable({}, {__mode = 'k'})
    local function wrapRegister(register)
        if type(register) ~= 'function' or ours[register] then return register end
        local wrapper = function(class, method, handler, ...)
            if type(handler) == 'function' then
                M.hooksWrapped = M.hooksWrapped + 1
                handler = timedHandler('hook:' .. tostring(class) .. '.' .. tostring(method), handler)
            end
            return register(class, method, handler, ...)
        end
        ours[wrapper] = true
        return wrapper
    end
    -- Plain globals: the CET sandbox shares them across this mod's files. CET may
    -- bind its own Observe/Override again when onInit runs (the 2026-10-12 capture
    -- had event:onUpdate rows but no hook: rows, and every hook registers in
    -- onInit), so each onInit handler re-wraps them first. Idempotent.
    local function wrapGlobals()
        Override, ObserveAfter = wrapRegister(Override), wrapRegister(ObserveAfter)
        ObserveBefore, Observe = wrapRegister(ObserveBefore), wrapRegister(Observe)
    end
    wrapGlobals()
    local registerEvent = registerForEvent
    if type(registerEvent) == 'function' then
        registerForEvent = function(event, handler, ...)
            if event == 'onUpdate' and type(handler) == 'function' then handler = timedUpdate(handler)
            elseif event == 'onInit' and type(handler) == 'function' then
                local init = handler
                handler = function(...) wrapGlobals(); return init(...) end
            end
            return registerEvent(event, handler, ...)
        end
    end
    return true
end

-- Module tables init.lua keeps only as locals (manager, tactics, ...): their
-- fields are wrapped on the first enabled frame like the globals above.
function M.watch(tbl, field, label)
    if type(tbl) ~= 'table' or type(field) ~= 'string' then return false end
    M.watched = M.watched or {}
    M.watched[#M.watched + 1] = {tbl, field, label or field}
    if wrapped then wrap(tbl, field, label or field) end
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
    M.flush()
    for index = #wrappers, 1, -1 do
        local row = wrappers[index]
        row[1][row[2]] = row[3]
    end
    wrappers, wrapped, enabled, M.installed = {}, false, false, false
end

function M.enabled() return enabled end

return M
