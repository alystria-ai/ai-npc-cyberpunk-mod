-- Bounded, passive Developer-mode movement trace. The caller supplies an
-- already cached snapshot; this module never asks the game for native state.
local M = {}
local ACTIVE = 'runtime/movement-trace.ndjson'
local PREVIOUS = 'runtime/movement-trace.previous.ndjson'
local FILE_LIMIT = 2 * 1024 * 1024
local LINE_LIMIT = 64 * 1024
local SAMPLE_SECONDS = 0.5
local since

local function size(path)
    local file = io.open(path, 'rb')
    if not file then return nil end
    local length = file:seek('end')
    file:close()
    return length
end

local function discardOversize(path)
    local length = size(path)
    if not length then return true end
    if length <= FILE_LIMIT then return true end
    -- An externally enlarged or older unbounded trace cannot enter this
    -- two-file budget. Normal CET reloads preserve both valid files.
    return os.remove(path) and true or false
end

local function append(line)
    if not discardOversize(ACTIVE) or not discardOversize(PREVIOUS) then return false end
    local current = size(ACTIVE) or 0
    if current + #line > FILE_LIMIT then
        -- Retire the oldest file first. Rename of the closed active file is
        -- atomic; a failed rename leaves it intact for the next update/reload.
        if size(PREVIOUS) ~= nil and not os.remove(PREVIOUS) then return false end
        if current > 0 and not os.rename(ACTIVE, PREVIOUS) then return false end
    end
    local file = io.open(ACTIVE, 'ab')
    if not file then return false end
    local wrote = file:write(line)
    local closed = file:close()
    return wrote ~= nil and closed ~= nil
end

function M.update(enabled, dt, snapshotProvider)
    if enabled ~= true then since = nil; return false end
    local step = type(dt) == 'number' and dt == dt and dt > 0 and dt or 0
    if since ~= nil then
        since = since + step
        if since < SAMPLE_SECONDS then return false end
        -- A slow frame produces one sample, never a catch-up burst next frame.
        since = 0
    else since = 0 end
    if type(snapshotProvider) ~= 'function' then return false end
    local ok, result = pcall(function()
        local snapshot = snapshotProvider()
        if type(snapshot) ~= 'table' then return false end
        local line = json.encode({version = 1, at = os.time() * 1000, movement = snapshot}) .. '\n'
        if #line > LINE_LIMIT or #line > FILE_LIMIT then return false end
        return append(line)
    end)
    return ok and result == true
end

return M
