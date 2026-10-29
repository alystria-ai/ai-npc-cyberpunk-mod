local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end
-- Explicit read-only save identity qualification. Dispatch from diagnostics:
-- save-identity:inspect:<unique nonce>. This file never claims, seeds, advances,
-- forks, resumes, saves, or loads. Real mutations belong to the coordinator.
local report = {version = 1, readOnly = true, capturedAt = os.date('!%Y-%m-%dT%H:%M:%SZ')}
local MAX_REQUEST, MAX_REPORT = 160, 32768
local function errorText(value)
    return tostring(value):gsub('%c', ' '):sub(1, 240)
end
local function requestText()
    local file = io.open('runtime/diagnostic-request.txt', 'rb')
    if not file then return '' end
    local value = file:read(MAX_REQUEST + 1); file:close()
    return type(value) == 'string' and #value <= MAX_REQUEST and value or ''
end
local function scalar(native, key)
    local ok, value = pcall(function() return native[key] end)
    if not ok then return {ok = false, error = errorText(value)} end
    local kind, result = type(value), {ok = true, type = type(value)}
    if kind == 'boolean' then result.value = value
    elseif kind == 'number' and value == value and math.abs(value) < math.huge then result.value = value
    elseif kind == 'string' then result.length = #value end
    return result
end
local function tokenShape(native, key)
    local ok, value = pcall(function()
        local token = native[key]
        local result = {type = type(token)}
        if type(token) ~= 'table' then return result end
        result.count = #token
        result.validLimbs = 0
        for i = 1, math.min(#token, 8) do
            local limb = token[i]
            if type(limb) == 'number' and limb == limb and limb % 1 == 0 and limb >= 0 and limb <= 65535 then
                result.validLimbs = result.validLimbs + 1
            end
        end
        return result
    end)
    return ok and value or {ok = false, error = errorText(value)}
end

local ok, problem = pcall(function()
    local request = requestText()
    local action, nonce = request:match('^save%-identity:([a-z]+):([a-zA-Z0-9_%-]+)$')
    assert(action == 'inspect' and nonce and #nonce >= 8 and #nonce <= 64,
        'Only save-identity:inspect:<8-64 character nonce> is permitted; mutations require the coordinator')
    report.action, report.nonce = action, nonce
    local player = convaiPlayer()
    assert(player and player:IsAttached() and not player:IsDeadNoStatPool(), 'Attached living player unavailable')
    assert(not Game.GetSystemRequestsHandler():IsPreGame(), 'Game is in pregame')
    local function getSystem()
        return Game.GetScriptableSystemsContainer():Get('CyberpunkConvai.ConvaiKnowledgeState')
    end
    local identity = dofile('save-identity.lua')
    report.before = identity.new({getSystem = getSystem}).inspect()
    local system = getSystem()
    assert(system, 'ConvaiKnowledgeState unavailable; native scripts may not be loaded')
    report.methods = {}
    for _, name in ipairs({'GetSnapshot', 'ClaimSession', 'Seed', 'Resume', 'Advance', 'Fork'}) do
        local found, method = pcall(function() return system[name] end)
        -- Never tostring a native object or dump its reflected members.
        report.methods[name] = found and {type = type(method)} or {error = errorText(method)}
    end
    local rawOk, raw = pcall(function() return system:GetSnapshot() end)
    report.nativeSnapshot = {ok = rawOk and raw ~= nil, type = type(raw)}
    if rawOk and raw then
        report.nativeSnapshot.fields = {}
        for _, key in ipairs({'version', 'ready', 'restored', 'resolved', 'generation', 'revision',
            'activationId', 'faulted', 'saving', 'schema', 'branchEpoch', 'ledgerSequence',
            'checkpointSequence', 'checkpointBranchEpoch', 'checkpointLedgerSequence',
            'restoredBranchEpoch', 'restoredLedgerSequence', 'restoredCheckpointSequence',
            'restoredCheckpointValid', 'serializationCompleted'}) do
            report.nativeSnapshot.fields[key] = scalar(raw, key)
        end
        report.nativeSnapshot.tokens = {}
        for _, key in ipairs({'campaign', 'branch', 'checkpointBranch', 'restoredBranch'}) do
            report.nativeSnapshot.tokens[key] = tokenShape(raw, key)
        end
    elseif not rawOk then report.nativeSnapshot.error = errorText(raw) end
    report.readback = identity.new({getSystem = getSystem}).inspect()
    report.restoredProof = report.readback.restoredProof
    report.sameReadback = report.before.status == 'inspected' and report.readback.status == 'inspected'
        and report.before.generation == report.readback.generation
        and report.before.revision == report.readback.revision
        and report.before.activationId == report.readback.activationId
    -- Read-only lease adoption does not claim or resolve the native system.
    report.identity = identity.new({getSystem = getSystem, activationId = report.readback.activationId}).capture()
end)
report.ok, report.error = ok, not ok and errorText(problem) or nil
local encoded, raw = pcall(json.encode, report)
if encoded and type(raw) == 'string' and #raw <= MAX_REPORT then
    local file = io.open('runtime/save-identity-probe.json', 'wb')
    if file then
        local wrote = file:write(raw)
        local closed = file:close()
        report.reportWritten = wrote ~= nil and closed ~= nil
    end
end
return report
