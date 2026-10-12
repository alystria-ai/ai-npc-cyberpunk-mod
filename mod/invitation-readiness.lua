-- Reservations prepare in the bridge while menus are open. A fresh, exact
-- receipt is the permission to create an actor; this module never creates one.
local M = {}
local RECEIPT_AGE, SERVICE_TIMEOUT = 2500, 15000
-- A receipt row is a few hundred bytes. The allowance for a receipt file grows with the reservations
-- in flight, so a larger party is never rejected for its size.
local RECEIPT_BYTES_BASE, RECEIPT_BYTES_PER_ROW = 64 * 1024, 1024
local MAX_INTEGER = 9007199254740991

local function integer(value, minimum)
    return type(value) == 'number' and value == value and value >= minimum
        and value <= MAX_INTEGER and value % 1 == 0
end

local function token(value, maximum)
    return type(value) == 'string' and #value > 0 and #value <= maximum
        and value:match('^[A-Za-z0-9][A-Za-z0-9_.:@%-]*$') ~= nil
end

local function profile(value)
    return type(value) == 'string' and #value > 0 and #value <= 80 and not value:find('[^a-z0-9%-]')
end

local function sameWorld(first, second)
    return first and second and first.worldToken == second.worldToken and first.generation == second.generation
end

local function readFile(path)
    local file = io.open(path, 'rb'); if not file then return nil end
    local ok, raw = pcall(file.read, file, '*a')
    pcall(file.close, file)
    return ok and raw or nil
end

-- In place: one open instead of open+remove+rename (about 12 ms of the game
-- thread per write, every 2 s, perf probe 2026-10-11). The bridge treats a
-- partial read as a missing frame and keeps its current lease until the
-- heartbeat expires (CompanionInvitations.ingest).
local function writeFile(path, raw)
    local file = io.open(path, 'wb')
    if not file then return false, 'Cannot write the invitation request.' end
    local called, written = pcall(file.write, file, raw)
    local closed, result = pcall(file.close, file)
    if not called or not written or not closed or not result then
        return false, 'Cannot finish writing the invitation request.'
    end
    return true
end

function M.new(options)
    options = options or {}
    local R = {}
    local owner, boundary, changed = nil, nil, false
    local rows, order, receipt, nextId = {}, {}, nil, 0
    local lastPublished, lastNow, publicationError = nil, nil, nil
    local directory = (options.runtimeDir or 'runtime'):gsub('[/\\]+$', '')
    local requestPath = directory .. '/companion-invitations.json'
    local receiptPath = directory .. '/companion-invitations-state.json'
    local read, write = options.read or readFile, options.write or writeFile
    local encode = options.encode or function(value) return json.encode(value) end
    local decode = options.decode or function(value) return json.decode(value) end
    local now = options.now or function() return os.time() * 1000.0 end
    -- update() runs every frame; each CET io.open costs about 1-2 ms of the
    -- game's main thread. The receipt (valid for RECEIPT_AGE) is read at most
    -- every readInterval seconds of wall clock. Injected readers default to every call.
    local tick = options.tick or os.clock
    local readInterval = options.readInterval or (options.read and 0 or .25)
    local readAt

    local function clock()
        local ok, value = pcall(now)
        if not ok or not integer(value, 0) then return nil end
        if lastNow and value < lastNow then
            receipt, lastPublished = nil, nil
            publicationError = 'The preparation clock changed. Wait for a fresh preparation receipt.'
            lastNow = value
            return nil
        end
        lastNow = value
        return value
    end

    local function currentWorld()
        if type(options.world) ~= 'function' then return nil end
        local ok, value = pcall(options.world)
        if not ok or type(value) ~= 'table' or not token(value.worldToken, 160)
            or not integer(value.generation, 1) then return nil end
        return {worldToken = value.worldToken, generation = value.generation}
    end

    local function publish(target, stamp)
        if not target or not stamp then return false, 'Load a save before preparing a companion.' end
        local invitations = {}
        for _, id in ipairs(order) do
            local row = rows[id]
            if row and not row.error then invitations[#invitations + 1] = {id = row.id, revision = row.revision,
                modelKey = row.modelKey, profileKey = row.profileKey, phase = row.phase} end
        end
        local value = {version = 1, worldToken = target.worldToken, generation = target.generation,
            updated = stamp, invitations = invitations}
        local encoded, raw = pcall(encode, value)
        if not encoded or type(raw) ~= 'string' then
            publicationError = 'Cannot encode the invitation request.'
            return false, publicationError
        end
        -- CET can encode an empty table as an object. The IPC field is always
        -- an array, including the empty publication that cancels reservations.
        if #invitations == 0 then raw = raw:gsub('("invitations"%s*:%s*){}', '%1[]') end
        local called, ok, reason = pcall(write, requestPath, raw)
        if not called or ok ~= true then
            publicationError = type(reason) == 'string' and reason:sub(1, 300)
                or 'Cannot publish companion preparation. Check the bridge and try again.'
            return false, publicationError
        end
        publicationError, lastPublished = nil, stamp
        return true
    end

    -- update/status may notice a new world first. Preserve that notification
    -- until bind acknowledges it, so the queue also drops its old-world jobs.
    local function synchronize(identity)
        local world = identity ~= nil and currentWorld() or nil
        local same = (boundary == nil and world == nil) or sameWorld(boundary, world)
        if identity ~= owner or not same then
            local previous = boundary
            owner, boundary = identity, world
            rows, order, receipt = {}, {}, nil
            changed, lastPublished, publicationError = true, nil, nil
            publish(boundary or previous, clock())
        end
    end

    local function known(key)
        if key == nil then return true end
        if not profile(key) or type(options.isKnown) ~= 'function' then return false end
        local ok, value = pcall(options.isKnown, key)
        return ok and value == true
    end

    local function jobFields(job)
        if type(job) ~= 'table' or not token(job.id, 240) or not integer(job.revision, 1)
            or not token(job.key or job.modelKey, 160) or (job.profileKey ~= nil and not profile(job.profileKey)) then
            return nil
        end
        return job.key or job.modelKey
    end

    local function matching(job)
        local modelKey = jobFields(job)
        local row = modelKey and rows[job.id]
        if row and row.revision == job.revision and row.modelKey == modelKey and row.profileKey == job.profileKey
            and sameWorld(row, boundary) then return row end
    end

    function R.bind(identity)
        synchronize(identity)
        local result = changed
        changed = false
        return result
    end

    function R.newId(sequence)
        synchronize(owner)
        if owner == nil or not boundary then return nil, 'Load a save before inviting a companion.' end
        nextId = math.max(nextId + 1, integer(sequence, 1) and sequence or 1)
        -- The world token includes a fresh CET launch nonce. The adapter owns
        -- this counter, so rebuilding a queue in the same world cannot reuse it.
        return 'invite:' .. boundary.worldToken .. ':' .. tostring(nextId)
    end

    function R.prepare(job)
        synchronize(owner)
        local stamp, modelKey = clock(), jobFields(job)
        if owner == nil or not boundary then return false, 'Load a save before preparing a companion.' end
        if not stamp or not modelKey then return false, 'That invitation has an invalid preparation identity.' end
        local previous = rows[job.id]
        if previous and job.revision <= previous.revision then
            return false, 'That invitation revision has already been prepared.'
        end
        if not previous then order[#order + 1] = job.id end
        local row = {id = job.id, revision = job.revision, modelKey = modelKey, profileKey = job.profileKey,
            worldToken = boundary.worldToken, generation = boundary.generation, phase = 'preparing', started = stamp}
        if not known(row.profileKey) then row.error = 'That conversation profile is unavailable.' end
        rows[job.id], receipt = row, nil
        local ok, reason = publish(boundary, stamp)
        if not ok then return false, reason end
        if row.error then return false, row.error end
        return true
    end

    function R.status(job)
        synchronize(owner)
        local stamp, row = clock(), matching(job)
        if not row then return {state = 'error', error = 'That invitation no longer belongs to the current world.'} end
        if row.error or not known(row.profileKey) then
            return {state = 'error', error = row.error or 'That conversation profile is unavailable.'}
        end
        local function failed(reason)
            -- A failure belongs to this exact attempt. A missing/expired IPC
            -- receipt must not turn it back into progress or permit a late
            -- ready result to spawn it. A new revision is an explicit retry.
            row.error = reason
            if stamp then publish(boundary, stamp) end
            return {state = 'error', error = reason}
        end
        if not stamp or publicationError then return failed(publicationError or 'Preparation clock unavailable.') end
        if row.profileKey == nil then return {state = 'model-only'} end
        if receipt and receipt.version == 1 and sameWorld(receipt, boundary) and integer(receipt.bridgePid, 1)
            -- The production Lua clock has whole seconds; Date.now receipts
            -- can be ahead by the remainder of that same wall-clock second.
            and integer(receipt.updated, 0) and receipt.updated <= stamp + 1000 and stamp - receipt.updated <= RECEIPT_AGE
            and type(receipt.invitations) == 'table' then
            local found, count, valid, seen = nil, 0, true, {}
            for key, candidate in pairs(receipt.invitations) do
                count = count + 1
                if not integer(key, 1) or type(candidate) ~= 'table'
                    or not token(candidate.id, 240) or not integer(candidate.revision, 1)
                    or not token(candidate.modelKey, 160) or (candidate.profileKey ~= nil and not profile(candidate.profileKey))
                    or not ({memory = true, connecting = true, ready = true, error = true})[candidate.state] then valid = false; break end
                if seen[candidate.id] then valid = false; break end
                seen[candidate.id] = true
                if candidate.id == row.id then
                    if candidate.revision == row.revision and candidate.modelKey == row.modelKey
                        and candidate.profileKey == row.profileKey then found = candidate end
                end
            end
            for index = 1, count do if receipt.invitations[index] == nil then valid = false; break end end
            if valid and found then
                if found.state == 'error' then
                    return failed(type(found.error) == 'string' and found.error:sub(1, 300) or 'Companion preparation failed.')
                end
                return {state = found.state}
            end
        end
        if stamp - row.started >= SERVICE_TIMEOUT then
            return failed('Companion preparation is not responding. Check the bridge or choose the profile again.')
        end
        return {state = 'memory'}
    end

    local function release(job)
        synchronize(owner)
        if not matching(job) then return false end
        rows[job.id] = nil
        for index, id in ipairs(order) do if id == job.id then table.remove(order, index); break end end
        publish(boundary, clock())
        return true
    end

    function R.cancel(job) return release(job) end
    function R.finish(job) return release(job) end

    function R.spawned(job, serial)
        synchronize(owner)
        local row = matching(job)
        if not row then return false end
        row.phase, row.serial = 'spawned', serial
        return publish(boundary, clock())
    end

    function R.update()
        synchronize(owner)
        local stamp = clock()
        if owner == nil or not boundary or not stamp then receipt, readAt = nil, nil; return end
        local wall = tick()
        -- With no reservation in flight there is nothing for a receipt to admit.
        if #order == 0 then
            receipt, readAt = nil, nil
        elseif readInterval <= 0 or not readAt or wall - readAt >= readInterval or wall < readAt then
            readAt = wall
            local called, raw = pcall(read, receiptPath)
            receipt = nil
            if called and type(raw) == 'string' and #raw <= RECEIPT_BYTES_BASE + #order * RECEIPT_BYTES_PER_ROW then
                local decoded, value = pcall(decode, raw)
                if decoded and type(value) == 'table' then receipt = value end
            end
        end
        -- Lease heartbeat: the bridge keeps a publication 6.5 s; refresh it every 2 s, in a frame no other
        -- heartbeat writes in (init.lua convaiHeartbeatSlot).
        local slot = convaiHeartbeatSlot
        if lastPublished == nil or stamp < lastPublished
            or (stamp - lastPublished >= 2000 and (type(slot) ~= 'function' or slot())) then publish(boundary, stamp) end
    end

    return R
end

return M
