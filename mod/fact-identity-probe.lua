-- Read-only qualification of the actual game-restored callback. No identity
-- claim, native write, fabricated restore callback, or save-file edit occurs.
local M = {}

function M.new(options)
    assert(type(options) == 'table' and type(options.names) == 'table')
    local now = options.now or os.time
    local state = {version = 1, mode = 'read-only', request = options.request,
        startedAt = now(), expiresAt = now() + 1800, active = true,
        restoreCount = 0, callback = 'PlayerSystem.OnGameRestored', samples = {}}
    local function copy(value)
        if type(value) ~= 'table' then return value end
        local result = {}; for key, item in pairs(value) do result[key] = copy(item) end; return result
    end
    local function publish()
        options.publish(copy(state))
    end
    local function capture(kind)
        local sample = {kind = kind, at = now(), values = {}, writes = 0}
        local ok, problem = pcall(function()
            local facts = assert(options.getFacts(), 'quest facts unavailable')
            sample.headBefore = facts:GetFactStr(options.names[1])
            for _, name in ipairs(options.names) do
                local value = facts:GetFactStr(name)
                assert(type(value) == 'number' and value % 1 == 0, 'noninteger fact read')
                sample.values[name] = value
            end
            sample.headAfter = facts:GetFactStr(options.names[1])
            sample.stableHead = sample.headBefore == sample.headAfter
            sample.world = options.world()
        end)
        sample.ok = ok
        if not ok then sample.error = tostring(problem):sub(1, 500) end
        state.samples[#state.samples + 1] = sample
        if #state.samples > 12 then table.remove(state.samples, 1) end
        publish()
    end
    local self = {}
    function self.arm()
        if state.observerAttempted then return self.read() end
        state.observerAttempted = true
        local ok, problem = pcall(options.observe, 'PlayerSystem', 'OnGameRestored', function()
            if not state.active or now() > state.expiresAt then return end
            -- This function is only called by the registered engine observer.
            -- A successful registration or a current read is not restore proof.
            state.restoreCount = state.restoreCount + 1
            capture('observed-game-restored')
        end)
        state.observerRegistered = ok
        if not ok then state.observerError = tostring(problem):sub(1, 500) end
        capture('armed-current-read')
        return copy(state)
    end
    function self.read() capture('requested-current-read'); return copy(state) end
    function self.stop() state.active = false; publish(); return copy(state) end
    function self.status() return copy(state) end
    return self
end

return M
