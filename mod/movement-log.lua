-- Bounded, passive Developer-mode movement trace. The caller supplies an
-- already cached snapshot; this module never asks the game for native state.
local M = {}
local ACTIVE = 'runtime/movement-trace.ndjson'
local PREVIOUS = 'runtime/movement-trace.previous.ndjson'
local FILE_LIMIT = 2 * 1024 * 1024
local LINE_LIMIT = 64 * 1024
local SAMPLE_SECONDS = 0.5
-- Samples are buffered and appended every FLUSH_SECONDS (or FLUSH_BYTES), and
-- when tracing stops: each CET file operation costs 1-2 ms of the game thread,
-- and the old per-sample size checks and append cost four of them twice a second.
local FLUSH_SECONDS, FLUSH_BYTES = 5, 256 * 1024
local since, pending, pendingBytes, flushWait, sizes = nil, {}, 0, 0, nil

local function size(path)
    local file = io.open(path, 'rb')
    if not file then return nil end
    local length = file:seek('end')
    file:close()
    return length
end

-- Empties a file in place. Rotation only ever modifies the two trace files that
-- exist and never deletes or renames one: under Mod Organizer 2 a deleted or
-- renamed file comes back as a new file in the Overwrite folder, so the next
-- launch would not see it. A failed open leaves the file as it was.
local function truncate(path)
    local file = io.open(path, 'wb')
    if not file then return false end
    return file:close() ~= nil
end

-- The file's size, or nil when absent. An externally enlarged or older
-- unbounded trace cannot enter this two-file budget and is emptied (false when
-- that fails). Normal CET reloads preserve both valid files.
local function boundedSize(path)
    local length = size(path)
    if not length or length <= FILE_LIMIT then return length end
    return truncate(path) and 0 or false
end

-- Moves the active file's content into the previous file and empties the active
-- one, both in place. A failure before the active file is emptied leaves it
-- intact for the next update/reload (the previous file may then hold a partial
-- copy, which the next rotation overwrites).
local function rotate()
    local source = io.open(ACTIVE, 'rb')
    if not source then return false end
    local content = source:read('*a')
    source:close()
    if type(content) ~= 'string' then return false end
    local target = io.open(PREVIOUS, 'wb')
    if not target then return false end
    local wrote = target:write(content)
    local closed = target:close()
    if wrote == nil or closed == nil then return false end
    return truncate(ACTIVE)
end

local function append(chunk)
    -- File sizes are read once, then tracked; this module is the only writer.
    if not sizes then
        local active, previous = boundedSize(ACTIVE), boundedSize(PREVIOUS)
        if active == false or previous == false then return false end
        sizes = {active = active or 0}
    end
    if sizes.active + #chunk > FILE_LIMIT then
        -- Retire the oldest content first: the previous file is overwritten by
        -- the active file's.
        if sizes.active > 0 and not rotate() then return false end
        sizes.active = 0
    end
    local file = io.open(ACTIVE, 'ab')
    if not file then return false end
    local wrote = file:write(chunk)
    local closed = file:close()
    if wrote ~= nil and closed ~= nil then sizes.active = sizes.active + #chunk; return true end
    return false
end

-- Appends the buffered samples. Also called on shutdown. A failed write drops
-- them (the trace is best effort) and re-reads the file sizes next time.
function M.flush()
    flushWait = 0
    if #pending == 0 then return true end
    local chunk = table.concat(pending)
    pending, pendingBytes = {}, 0
    local ok, written = pcall(append, chunk)
    if not ok or not written then sizes = nil; return false end
    return true
end

function M.update(enabled, dt, snapshotProvider)
    if enabled ~= true then
        if #pending > 0 then M.flush() end
        since = nil; return false
    end
    local step = type(dt) == 'number' and dt == dt and dt > 0 and dt or 0
    flushWait = flushWait + step
    if flushWait >= FLUSH_SECONDS and #pending > 0 then M.flush() end
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
        pending[#pending + 1], pendingBytes = line, pendingBytes + #line
        if pendingBytes >= FLUSH_BYTES then return M.flush() end
        return true
    end)
    return ok and result == true
end

return M
