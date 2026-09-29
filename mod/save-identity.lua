-- Save-owned identity protocol. This module has no game/file/network/timer side
-- effects until a caller injects getSystem and explicitly applies a command.
-- Native fields are the authority; a bridge seed alone is never an identity.
local M = {}
local MAX_INT = 2147483647

local function integer(value, minimum)
    return type(value) == 'number' and value == value and value % 1 == 0
        and value >= (minimum or 0) and value <= MAX_INT
end

local function token(value)
    return type(value) == 'string' and #value == 32 and value:match('^[0-9a-f]+$') ~= nil
        and value ~= string.rep('0', 32)
end

local function words(value)
    if not token(value) then return nil end
    local result = {}
    for i = 1, 32, 4 do result[#result + 1] = tonumber(value:sub(i, i + 3), 16) end
    return result
end

local function fromWords(value, allowEmpty)
    assert(type(value) == 'table', 'native token array unavailable')
    if allowEmpty and #value == 0 then return nil end
    assert(#value == 8, 'native token length invalid')
    local result = {}
    for i = 1, 8 do
        assert(integer(value[i]) and value[i] <= 65535, 'native token limb invalid')
        result[i] = string.format('%04x', value[i])
    end
    result = table.concat(result)
    assert(token(result), 'native token is empty')
    return result
end

local function unavailable(reason)
    return {version = 1, status = 'unavailable', confidence = 'unavailable', authoritative = false, reason = reason}
end

local function checkpoint(branch, epoch, sequence, ledgerSequence, proof)
    return {id = branch .. ':' .. tostring(sequence) .. ':' .. tostring(ledgerSequence),
        branchId = branch, branchEpoch = epoch, sequence = sequence,
        ledgerSequence = ledgerSequence, proof = proof}
end

local function read(system)
    local native = system:GetSnapshot()
    assert(native and native.version == 1, 'unsupported native identity snapshot')
    local result = {version = 1, status = 'inspected'}
    for _, key in ipairs({'ready', 'restored', 'resolved', 'saving', 'faulted', 'restoredCheckpointValid'}) do
        assert(type(native[key]) == 'boolean', 'native lifecycle flag unavailable')
        result[key] = native[key]
    end
    for _, key in ipairs({'generation', 'revision', 'schema', 'branchEpoch', 'ledgerSequence',
        'checkpointSequence', 'checkpointBranchEpoch', 'checkpointLedgerSequence',
        'restoredBranchEpoch', 'restoredLedgerSequence', 'restoredCheckpointSequence', 'serializationCompleted'}) do
        assert(integer(native[key]), 'native counter invalid')
        result[key] = native[key]
    end
    assert(native.activationId == '' or token(native.activationId), 'native lease invalid')
    result.activationId = native.activationId
    if result.schema == 0 then
        assert(#native.campaign == 0 and #native.branch == 0 and result.branchEpoch == 0
            and result.ledgerSequence == 0 and result.checkpointSequence == 0, 'partial native identity')
    else
        assert(result.schema == 1, 'unknown persisted identity schema')
        result.campaignId = fromWords(native.campaign)
        result.branchId = fromWords(native.branch)
        assert(result.branchEpoch > 0, 'native branch epoch invalid')
    end
    if result.checkpointSequence > 0 then
        local branch = fromWords(native.checkpointBranch)
        assert(result.checkpointBranchEpoch > 0, 'native checkpoint epoch invalid')
        result.checkpoint = checkpoint(branch, result.checkpointBranchEpoch,
            result.checkpointSequence, result.checkpointLedgerSequence, 'serialization-candidate')
        if result.serializationCompleted == result.checkpointSequence then
            result.checkpoint.proof = 'serialization-finished'
        end
    end
    if result.restored and result.schema == 1 then
        local branch = fromWords(native.restoredBranch, true)
        if branch then
            assert(result.restoredBranchEpoch > 0, 'restored branch epoch invalid')
            result.restoredCursor = {branchId = branch, branchEpoch = result.restoredBranchEpoch,
                ledgerSequence = result.restoredLedgerSequence, proof = 'native-restore'}
        end
        if result.restoredCheckpointValid then
            assert(branch and result.restoredCheckpointSequence > 0, 'native restore receipt invalid')
            result.restoredCheckpoint = checkpoint(branch, result.restoredBranchEpoch,
                result.restoredCheckpointSequence, result.restoredLedgerSequence, 'native-restore')
            result.restoredProof = {kind = 'native-on-restored', branchId = branch,
                ledgerSequence = result.restoredLedgerSequence, checkpointId = result.restoredCheckpoint.id}
        end
    end
    -- This is the complete compare-and-swap guard, not a serialized native object.
    result.expected = {generation = result.generation, revision = result.revision, activationId = result.activationId}
    return result
end

local function validExpected(value)
    return type(value) == 'table' and integer(value.generation, 1) and integer(value.revision)
        and (value.activationId == '' or token(value.activationId))
end

function M.new(options)
    options = options or {}
    local getSystem, activationId = options.getSystem, options.activationId
    local self = {}

    -- Read-only inspection is allowed before claim/resolve so the bridge can
    -- choose a branch. It does not authorize memory routing or promotion.
    function self.inspect()
        if type(getSystem) ~= 'function' then return unavailable('native-system-unavailable') end
        local ok, value = pcall(function()
            local system = getSystem()
            assert(system, 'native-system-unavailable')
            return read(system)
        end)
        if not ok then return unavailable('native-read-failed') end
        return value
    end

    function self.capture()
        local value = self.inspect()
        if value.status == 'unavailable' then return value end
        if value.faulted then return unavailable('native-lifecycle-fault') end
        if not value.ready or value.generation < 1 then return unavailable('native-session-not-ready') end
        if value.saving then return unavailable('save-in-progress') end
        if not token(activationId) or value.activationId ~= activationId then return unavailable('session-unclaimed') end
        if value.schema ~= 1 then return unavailable('identity-uninitialized') end
        if not value.resolved then return unavailable('ledger-not-resolved') end
        value.status, value.authoritative = 'available', true
        value.confidence = 'native-live'
        if value.restoredCursor and value.restoredCursor.branchId == value.branchId
            and value.restoredCursor.branchEpoch == value.branchEpoch
            and value.restoredCursor.ledgerSequence == value.ledgerSequence then
            value.confidence = 'native-restored'
        end
        -- Only this separate receipt may checkpoint durable episodes. Live
        -- readback and AfterSave are explicitly insufficient for promotion.
        value.promotionCheckpoint = value.restoredCheckpoint
        return value
    end

    function self.apply(command)
        if type(command) ~= 'table' or not token(activationId) or not validExpected(command.expected) then
            return {ok = false, reason = 'invalid-command'}
        end
        local kind, expected = command.kind, command.expected
        if kind ~= 'claim' and kind ~= 'seed' and kind ~= 'resume' and kind ~= 'advance' and kind ~= 'fork' then
            return {ok = false, reason = 'invalid-command'}
        end
        if kind == 'seed' and (not token(command.campaignId) or not token(command.branchId)) then
            return {ok = false, reason = 'invalid-command'}
        end
        if kind == 'fork' and (not token(command.branchId) or not integer(command.branchEpoch, 1)) then
            return {ok = false, reason = 'invalid-command'}
        end
        if kind == 'advance' and not integer(command.ledgerSequence, 1) then
            return {ok = false, reason = 'invalid-command'}
        end
        if type(getSystem) ~= 'function' then return {ok = false, reason = 'native-system-unavailable'} end
        local before, after
        local ok, accepted = pcall(function()
            -- Acquire and release the handle within this call only. No native
            -- handle can survive a frame, save load, CET reload, or detach.
            local system = getSystem()
            assert(system, 'native-system-unavailable')
            before = read(system)
            if not before.ready or before.saving or before.faulted then return false end
            if before.generation ~= expected.generation or before.revision ~= expected.revision
                or before.activationId ~= expected.activationId then return false end
            if kind ~= 'claim' and before.activationId ~= activationId then return false end
            local changed
            if kind == 'claim' then
                changed = system:ClaimSession(expected.generation, expected.revision, expected.activationId, activationId)
            elseif kind == 'seed' then
                changed = system:Seed(expected.generation, expected.revision, activationId,
                    words(command.campaignId), words(command.branchId))
            elseif kind == 'resume' then
                changed = system:Resume(expected.generation, expected.revision, activationId)
            elseif kind == 'advance' then
                changed = system:Advance(expected.generation, expected.revision, activationId, command.ledgerSequence)
            else
                changed = system:Fork(expected.generation, expected.revision, activationId,
                    words(command.branchId), command.branchEpoch)
            end
            if changed ~= true then return false end
            -- A Bool return is not proof of a mutation. Read the actual current
            -- system again, covering a replaced instance or failed writeback.
            after = read(assert(getSystem(), 'native-system-unavailable'))
            return true
        end)
        if not ok then return {ok = false, reason = 'native-command-uncertain'} end
        if not accepted then return {ok = false, reason = 'native-command-rejected'} end
        local matches = after.ready and not after.faulted and not after.saving
            and after.generation == expected.generation and after.revision == expected.revision + 1
            and after.activationId == activationId
        if kind == 'claim' then
            matches = matches and not after.resolved and after.campaignId == before.campaignId
                and after.branchId == before.branchId and after.ledgerSequence == before.ledgerSequence
        elseif kind == 'seed' then
            matches = matches and after.resolved and after.campaignId == command.campaignId
                and after.branchId == command.branchId and after.branchEpoch == 1 and after.ledgerSequence == 0
        elseif kind == 'fork' then
            matches = matches and after.resolved and after.campaignId == before.campaignId
                and after.branchId == command.branchId and after.branchEpoch == command.branchEpoch
                and after.ledgerSequence == 0
        else
            matches = matches and after.resolved and after.campaignId == before.campaignId
                and after.branchId == before.branchId and after.branchEpoch == before.branchEpoch
                and after.ledgerSequence == (kind == 'advance' and command.ledgerSequence or before.ledgerSequence)
        end
        if not matches then return {ok = false, reason = 'native-readback-mismatch'} end
        return {ok = true, inspected = after, snapshot = self.capture()}
    end

    return self
end

return M
