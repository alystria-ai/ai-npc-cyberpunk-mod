local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end
-- The only file/native boundary for save identity. Loading this module does
-- nothing; the owner explicitly constructs it and calls update/invalidate.
-- All published values are plain readbacks. No game handle survives a call.
local M = {}
local MAX_BYTES, MAX_COMMAND_AGE, HEARTBEAT = 32768, 30000, 500

local function copy(value)
    if type(value) ~= 'table' then return value end
    local result = {}; for key, item in pairs(value) do result[key] = copy(item) end; return result
end
local function finite(value)
    return type(value) == 'number' and value == value and math.abs(value) < math.huge
end
local function token(value)
    return type(value) == 'string' and #value == 32 and value:match('^[0-9a-f]+$') ~= nil
        and value ~= string.rep('0', 32)
end
local function readFile(path)
    local file = io.open(path, 'rb'); if not file then return nil end
    local raw = file:read(MAX_BYTES + 1); file:close(); return raw
end
-- In place: the file is shipped as an empty placeholder and only ever rewritten, never deleted
-- or renamed over (a new file would land in Mod Organizer 2's Overwrite folder). A reader that
-- catches the file mid-write fails closed (a partial or empty file decodes to nothing).
local function writeFile(path, raw)
    local file = io.open(path, 'wb'); if not file then return false end
    local written = file:write(raw); local closed = file:close()
    if not written or not closed then return false end
    return true
end
local function unavailable(reason)
    return {version = 1, status = 'unavailable', authoritative = false, reason = reason}
end
local function sameNative(a, b)
    for _, key in ipairs({'generation', 'revision', 'activationId', 'campaignId', 'branchId', 'branchEpoch', 'ledgerSequence',
        'storage', 'runtimeId', 'factHead'}) do
        if a[key] ~= b[key] then return false end
    end
    return true
end
local function worldToken(value)
    local prefix = tostring(value.generation)
    if value.storage == 'quest-facts-v1' then
        if not token(value.runtimeId) then return nil end
        prefix = prefix .. ':' .. value.runtimeId
    end
    if token(value.activationId) and token(value.branchId) then
        return prefix .. ':' .. value.activationId .. ':' .. value.branchId
    end
    return prefix .. ':unclaimed'
end
local function nativeSystem()
    local player = convaiPlayer()
    if not player or not player:IsAttached() or player:IsDeadNoStatPool()
        or Game.GetSystemRequestsHandler():IsPreGame() then return nil end
    return Game.GetScriptableSystemsContainer():Get('CyberpunkConvai.ConvaiKnowledgeState')
end

function M.new(options)
    options = options or {}
    local factory = options.identityFactory or dofile('save-identity.lua').new
    local getSystem = options.getSystem or nativeSystem
    local read, write = options.read or readFile, options.write or writeFile
    local encode, decode = options.encode or json.encode, options.decode or json.decode
    local now = options.now or function() return os.time() * 1000 end
    local directory = options.runtimeDir or 'runtime'
    local commandPath, statePath = directory .. '/knowledge-command.json', directory .. '/knowledge-state.json'
    local bindingPath = directory .. '/knowledge-binding.json'
    local self = {sequence = 0, seen = {}, order = {}}
    local function driver(activation)
        return factory({getSystem = getSystem, activationId = activation})
    end
    local function clock()
        local value = now(); assert(finite(value) and value >= 0, 'clock unavailable'); return value
    end
    local function generation()
        if not options.currentGeneration then return nil end
        local value = options.currentGeneration()
        assert(finite(value) and value >= 0 and value % 1 == 0, 'world generation unavailable'); return value
    end
    local function capture()
        local inspected = driver().inspect()
        if inspected.status == 'unavailable' then return inspected, unavailable(inspected.reason) end
        -- Adopting a lease for a read is not a claim or resume. The bridge still
        -- reconciles its durable activation record before exposing any route.
        return inspected, driver(inspected.activationId).capture()
    end
    local function publish(time, worldGeneration, inspected, identity, reason)
        self.sequence = self.sequence + 1
        local value = {version = 1, sequence = self.sequence, publishedAt = time,
            worldGeneration = worldGeneration, status = reason and 'unavailable' or 'ready',
            reason = reason, inspection = inspected, identity = identity, ack = copy(self.ack)}
        self.last = value
        local ok, raw = pcall(encode, value)
        if not ok or type(raw) ~= 'string' or #raw > MAX_BYTES then
            self.last = unavailable('state-encoding-failed'); return false
        end
        local written, result = pcall(write, statePath, raw)
        if not written or result ~= true then
            self.last = unavailable('state-publication-failed'); return false
        end
        self.publishedAt = time
        return true
    end
    local function remember(id, raw, ack)
        self.seen[id] = {raw = raw, ack = copy(ack)}
        self.order[#self.order + 1] = id
        if #self.order > 128 then self.seen[table.remove(self.order, 1)] = nil end
        self.ack = ack
    end
    local function apply(raw, time, worldGeneration)
        -- An empty file is the shipped placeholder, the same as no command.
        if type(raw) ~= 'string' or #raw > MAX_BYTES or raw:match('^%s*$') then return end
        local ok, command = pcall(decode, raw)
        if not ok or type(command) ~= 'table' or not token(command.id) then return end
        local cached = self.seen[command.id]
        if cached then
            self.ack = cached.raw == raw and copy(cached.ack)
                or {id = command.id, ok = false, reason = 'command-id-reused'}
            return
        end
        local reason
        if command.version ~= 1 or not token(command.activationId) or not finite(command.issuedAt)
            or not finite(command.expiresAt) or command.expiresAt <= command.issuedAt
            or command.expiresAt - command.issuedAt > MAX_COMMAND_AGE then reason = 'invalid-envelope'
        elseif command.issuedAt > time + 1000 or command.expiresAt <= time then reason = 'expired-command'
        elseif worldGeneration ~= nil and command.worldGeneration ~= worldGeneration then reason = 'world-changed' end
        local result
        if not reason then
            local applied, value = pcall(function()
                local selected = driver(command.activationId)
                local inspected = selected.inspect()
                if inspected.storage ~= command.storage then return {ok = false, reason = 'identity-backend-mismatch'} end
                return selected.apply(command)
            end)
            if applied and type(value) == 'table' then result = value
            else reason = 'native-command-uncertain' end
        end
        remember(command.id, raw, {id = command.id, activationId = command.activationId,
            ok = not reason and result.ok == true or false,
            reason = reason or result.reason, appliedAt = time})
    end

    function self.update()
        local ok, time = pcall(clock)
        if not ok then self.last = unavailable('clock-unavailable'); return false end
        if self.lastClock and time < self.lastClock then
            self.lastClock = time
            return publish(time, nil, unavailable('clock-regressed'), unavailable('clock-regressed'), 'clock-regressed')
        end
        self.lastClock = time
        local good, worldGeneration = pcall(generation)
        if not good then
            return publish(time, nil, unavailable('world-unavailable'), unavailable('world-unavailable'), 'world-unavailable')
        end
        local readOk, raw = pcall(read, commandPath, MAX_BYTES)
        if readOk then apply(raw, time, worldGeneration) end
        local captured, inspected, identity = pcall(capture)
        if not captured then inspected, identity = unavailable('native-read-failed'), unavailable('native-read-failed') end
        -- Publish immediately after any identity/ack change, and otherwise a
        -- heartbeat. Errors replace identities; no last-good identity fallback.
        local encoded, signature = pcall(encode, {inspection = inspected, identity = identity, ack = self.ack, worldGeneration = worldGeneration})
        if not encoded then
            self.last = unavailable('state-encoding-failed'); return false
        end
        if signature ~= self.signature or not self.publishedAt or time - self.publishedAt >= HEARTBEAT then
            self.signature = signature
            return publish(time, worldGeneration, inspected, identity,
                inspected.status == 'unavailable' and inspected.reason or nil)
        end
        return true
    end
    function self.invalidate(reason)
        self.signature = nil
        local ok, time = pcall(clock)
        if not ok then self.last = unavailable('clock-unavailable'); return false end
        local value = unavailable(type(reason) == 'string' and reason:sub(1, 100) or 'world-unavailable')
        return publish(time, nil, value, copy(value), value.reason)
    end
    function self.status() return copy(self.last or unavailable('not-started')) end
    function self.inspect()
        local ok, value = pcall(function() return driver().inspect() end)
        return ok and value or unavailable('native-read-failed')
    end
    function self.capture()
        local ok, value = pcall(function()
            local time = clock()
            local _, native = capture()
            if native.status ~= 'available' or native.authoritative ~= true then return unavailable(native.reason) end
            local raw = read(bindingPath, MAX_BYTES)
            if type(raw) ~= 'string' or #raw > MAX_BYTES or raw:match('^%s*$') then return unavailable('bridge-binding-unavailable') end
            local binding = decode(raw)
            if type(binding) ~= 'table' or binding.version ~= 1 or binding.status ~= 'ready'
                or not finite(binding.publishedAt) or time - binding.publishedAt < -1000
                or time - binding.publishedAt > 5000 then return unavailable('bridge-binding-expired') end
            local identity = binding.identity
            if type(identity) ~= 'table' or identity.status ~= 'verified' or identity.authoritative ~= true
                or type(identity.userId) ~= 'string' or #identity.userId ~= 36
                or not identity.userId:match('^[a-f0-9%-]+$') then return unavailable('bridge-binding-invalid') end
            for _, key in ipairs({'generation', 'activationId', 'campaignId', 'branchId', 'branchEpoch', 'ledgerSequence',
                'storage', 'runtimeId', 'factHead'}) do
                if identity[key] ~= native[key] then return unavailable('bridge-binding-mismatch') end
            end
            local final = driver(native.activationId).capture()
            if final.status ~= 'available' or not sameNative(native, final) then return unavailable('binding-world-changed') end
            final.localUserId, final.userId = identity.userId, identity.userId
            final.playthroughId, final.checkpointId = final.campaignId, identity.checkpointId
            final.worldToken = worldToken(final)
            return final
        end)
        return ok and value or unavailable('binding-read-failed')
    end
    function self.snapshot()
        local before = self.inspect()
        if before.status == 'inspected' and before.ready and before.saving and not before.faulted then
            local after = self.inspect()
            if after.status == 'inspected' and after.ready and after.saving and not after.faulted and sameNative(before, after) then
                return {version = 1, status = 'paused', reason = 'save-in-progress', generation = after.generation,
                    worldToken = worldToken(after), inspection = after, identity = unavailable('save-in-progress')}
            end
            return unavailable('snapshot-world-changed')
        end
        if before.status ~= 'inspected' or not before.ready or before.faulted then
            return unavailable('native-world-unavailable')
        end
        local identity = self.capture()
        local after = self.inspect()
        if after.status ~= 'inspected' or not after.ready or after.saving or after.faulted or not sameNative(before, after) then
            return unavailable('snapshot-world-changed')
        end
        if identity.status == 'available' and not sameNative(identity, after) then return unavailable('snapshot-world-changed') end
        return {version = 1, status = 'ready', generation = after.generation, worldToken = worldToken(after),
            inspection = after, identity = identity}
    end
    return self
end

return M
