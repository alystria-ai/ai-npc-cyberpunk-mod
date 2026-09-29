-- Save identity candidate using a fixed, collision-audited quest-fact namespace.
-- Pure injected driver: loading/construction performs no game or file calls.
-- All write and restore qualification gates default OFF. See the design document.
local M = {}
local PREFIX, MAX, MAX_COMMIT = 'cyberpunkconvai_mem_v1_', 2147483647, 1073741823
local FIELDS = {'schema'}
for i = 1, 8 do FIELDS[#FIELDS + 1] = 'campaign_' .. i end
for i = 1, 8 do FIELDS[#FIELDS + 1] = 'branch_' .. i end
for _, name in ipairs({'epoch', 'sequence', 'generation', 'seal'}) do FIELDS[#FIELDS + 1] = name end
local NAMES = {PREFIX .. 'head'}
for bank = 0, 1 do for _, name in ipairs(FIELDS) do NAMES[#NAMES + 1] = PREFIX .. bank .. '_' .. name end end
local RECORD_FIELDS = {'schema', 'bank', 'campaignId', 'branchId', 'branchEpoch', 'ledgerSequence', 'commitGeneration'}

local function copy(v)
    if type(v) ~= 'table' then return v end
    local out = {}; for k, item in pairs(v) do out[k] = copy(item) end; return out
end
local function integer(v, maximum) return type(v) == 'number' and v >= 0 and v <= (maximum or MAX) and v % 1 == 0 end
local function token(v) return type(v) == 'string' and #v == 32 and v:match('^[a-f0-9]+$') and v ~= string.rep('0', 32) end
local function unavailable(reason) return {version = 1, status = 'unavailable', authoritative = false, confidence = 'unavailable', reason = reason} end
local function same(a, b)
    if type(a) ~= 'table' or type(b) ~= 'table' then return false end
    for _, key in ipairs(RECORD_FIELDS) do if a[key] ~= b[key] then return false end end
    return true
end
local function validRecord(r)
    return type(r) == 'table' and r.schema == 1 and (r.bank == 0 or r.bank == 1)
        and token(r.campaignId) and token(r.branchId) and integer(r.branchEpoch) and r.branchEpoch > 0
        and integer(r.ledgerSequence) and integer(r.commitGeneration, MAX_COMMIT) and r.commitGeneration > 0
end
local function compact(r)
    local out = {}; for _, name in ipairs(RECORD_FIELDS) do out[name] = r[name] end; return out
end
local function encode(r)
    local out = {schema = r.schema, epoch = r.branchEpoch, sequence = r.ledgerSequence,
        generation = r.commitGeneration, seal = r.commitGeneration}
    for i = 1, 8 do
        out['campaign_' .. i] = tonumber(r.campaignId:sub(i * 4 - 3, i * 4), 16)
        out['branch_' .. i] = tonumber(r.branchId:sub(i * 4 - 3, i * 4), 16)
    end
    return out
end
local function zero(raw)
    for _, name in ipairs(FIELDS) do if raw[name] ~= 0 then return false end end
    return true
end
local function rawEqual(a, b)
    for _, name in ipairs(FIELDS) do if a[name] ~= b[name] then return false end end; return true
end
local function decode(raw, bank, sealBefore)
    if zero(raw) then return {bank = bank, empty = true, raw = raw} end
    local out = {bank = bank, empty = false, raw = raw, valid = false}
    local c, b = {}, {}
    for i = 1, 8 do
        if not integer(raw['campaign_' .. i], 65535) or not integer(raw['branch_' .. i], 65535) then return out end
        c[i], b[i] = string.format('%04x', raw['campaign_' .. i]), string.format('%04x', raw['branch_' .. i])
    end
    local record = {bank = bank, schema = raw.schema, campaignId = table.concat(c), branchId = table.concat(b),
        branchEpoch = raw.epoch, ledgerSequence = raw.sequence, commitGeneration = raw.generation}
    if validRecord(record) and raw.seal == raw.generation and sealBefore == raw.seal then
        out.valid, out.record = true, record
    end
    return out
end
local function checkedRecords(values)
    if type(values) ~= 'table' or #values > 8 then return nil end
    for key in pairs(values) do if not integer(key, #values) or key < 1 then return nil end end
    local out, generations = {}, {}
    for _, r in ipairs(values) do
        if not validRecord(r) then return nil end
        if generations[r.commitGeneration] and not same(generations[r.commitGeneration], r) then return nil end
        local item = compact(r); generations[item.commitGeneration] = item; out[#out + 1] = item
    end
    return out
end
local function contains(records, record)
    for _, known in ipairs(records or {}) do if same(known, record) then return true end end; return false
end
local function audited(audit)
    if type(audit) ~= 'table' or audit.version ~= 1 or audit.storage ~= 'quest-facts-v1'
        or audit.collisionCount ~= 0 or audit.completeWithinScope ~= true or not integer(audit.knownFactCount)
        or audit.knownFactCount < 1 or type(audit.factNames) ~= 'table' or #audit.factNames ~= #NAMES then return false end
    for i, name in ipairs(NAMES) do if audit.factNames[i] ~= name then return false end end
    return type(audit.corpusDigest) == 'string' and #audit.corpusDigest == 64 and audit.corpusDigest:match('^[a-f0-9]+$') ~= nil
end

M.storage, M.factNames = 'quest-facts-v1', copy(NAMES)

function M.new(options)
    options = options or {}
    assert(token(options.runtimeId), 'fresh transient runtimeId required')
    assert(type(options.getFacts) == 'function' and type(options.isWorldAvailable) == 'function', 'injected fact access required')
    local state = {generation = 0, revision = 0, active = false, activationId = '', resolved = false,
        saving = false, origin = 'live-origin-unverified', requiresFork = true, confirmed = {}}
    local runtime = {}
    local function available()
        local ok, value = pcall(options.isWorldAvailable); return ok and value == true
    end
    local function readNative()
        local facts = options.getFacts()
        if not facts then error('facts unavailable') end
        local function get(name)
            local value = facts:GetFactStr(name)
            if not integer(value) then error('invalid native fact value') end
            return value
        end
        local first = get(NAMES[1])
        local banks = {}
        for bank = 0, 1 do
            local raw, prefix = {}, PREFIX .. bank .. '_'
            local sealBefore = get(prefix .. 'seal')
            for _, name in ipairs(FIELDS) do raw[name] = get(prefix .. name) end
            local sealAfter = get(prefix .. 'seal')
            banks[bank + 1] = decode(raw, bank, sealBefore == sealAfter and sealBefore or -1)
        end
        local last = get(NAMES[1])
        if first ~= last then error('facts changed during read') end
        if first == 0 then return {factHead = 0, banks = banks, schema = 0, occupied = not banks[1].empty or not banks[2].empty} end
        local bank, generation = first % 2, math.floor(first / 2)
        local selected = banks[bank + 1]
        if generation < 1 or not selected.valid or selected.record.commitGeneration ~= generation then error('selected fact bank invalid') end
        local result = compact(selected.record)
        result.factHead, result.banks = first, banks
        return result
    end
    local function stableNative()
        local ok, value = pcall(readNative)
        return ok and value or nil
    end
    local function guard(value)
        return {runtimeId = options.runtimeId, generation = state.generation, revision = state.revision,
            activationId = state.activationId, factHead = value.factHead}
    end
    local function guardMatches(a, b)
        if type(a) ~= 'table' then return false end
        for _, name in ipairs({'runtimeId', 'generation', 'revision', 'activationId', 'factHead'}) do
            if a[name] ~= b[name] then return false end
        end
        return true
    end
    local function proof()
        local r = state.restoredRecord
        if not r or options.restoreQualified ~= true or not contains(state.confirmed, r) then return nil end
        return {version = 1, kind = 'native-facts-restored', source = 'PlayerSystem.OnGameRestored',
            campaignId = r.campaignId, branchId = r.branchId, branchEpoch = r.branchEpoch,
            ledgerSequence = r.ledgerSequence, commitGeneration = r.commitGeneration,
            bank = r.bank, factHead = 2 * r.commitGeneration + r.bank,
            checkpointId = r.branchId .. ':' .. r.commitGeneration .. ':' .. r.ledgerSequence,
            loadGeneration = state.restoredGeneration, runtimeId = options.runtimeId, factSchema = 1}
    end
    local function inspect()
        if not state.active or not available() then return unavailable('world-unavailable') end
        local generation, revision, activationId = state.generation, state.revision, state.activationId
        local value = stableNative()
        if not value or not state.active or not available() or generation ~= state.generation
            or revision ~= state.revision or activationId ~= state.activationId then return unavailable('fact-read-unavailable') end
        value.version, value.status, value.authoritative = 1, 'inspected', false
        value.storage, value.runtimeId, value.origin = M.storage, options.runtimeId, state.origin
        value.generation, value.revision, value.activationId = state.generation, state.revision, state.activationId
        value.ready, value.faulted, value.saving = true, state.faulted == true, state.saving
        value.restored, value.resolved, value.requiresFork = state.restoredEvent == true, state.resolved, state.requiresFork
        value.restoreQualified = options.restoreQualified == true
        value.expected = guard(value)
        value.restoredProof = proof()
        if state.restoredRecord then value.restoredCandidate = compact(state.restoredRecord) end
        if state.pendingCommit then value.pendingCommit = copy(state.pendingCommit) end
        return value
    end
    local function begin(origin)
        if state.generation >= MAX then state.faulted = true; state.active = false; return false end
        state.generation, state.revision = state.generation + 1, 0
        state.active, state.activationId, state.resolved, state.saving = true, '', false, false
        state.origin, state.requiresFork, state.confirmed = origin, true, {}
        state.restoredEvent, state.restoredRecord, state.restoredGeneration = false, nil, nil
        state.pendingCommit = nil
        return true
    end
    function runtime.attachCurrentWorld()
        if state.active then return true end
        if not available() then return false end
        return begin('live-origin-unverified')
    end
    runtime.onAttached = runtime.attachCurrentWorld
    function runtime.onRestored()
        -- Wire only to the real ObserveAfter(PlayerSystem, OnGameRestored).
        -- A later onUpdate read is never substituted for this boundary read.
        if not begin('native-restored') then return false end
        state.restoredEvent, state.restoredGeneration = true, state.generation
        local generation, revision = state.generation, state.revision
        local value = stableNative()
        if not value or state.generation ~= generation or state.revision ~= revision or not state.active then
            state.active, state.restoredRecord, state.restoredEvent = false, nil, false; return false
        end
        if value.schema == 1 then state.restoredRecord = compact(value) end
        return true
    end
    function runtime.invalidate()
        state.active, state.resolved, state.saving, state.activationId = false, false, false, ''
        state.restoredRecord, state.restoredEvent, state.confirmed = nil, false, {}
        state.pendingCommit = nil
    end
    function runtime.onBeforeSave()
        if state.saving or state.revision >= MAX then state.faulted = true; return false end
        state.saving, state.revision = true, state.revision + 1; return true
    end
    function runtime.onAfterSave()
        if state.saving then
            state.saving = false
            if state.revision >= MAX then state.faulted = true else state.revision = state.revision + 1 end
        end
        -- Serialization completion deliberately creates no restored proof.
    end

    function runtime.identityFactory(injected)
        local activation = type(injected) == 'table' and injected.activationId or nil
        local driver = {}
        driver.inspect = inspect
        function driver.capture()
            local value = inspect()
            if value.status ~= 'inspected' then return value end
            if value.faulted or value.saving or not value.resolved or value.schema ~= 1 or not token(activation)
                or activation ~= state.activationId or not contains(state.confirmed, value) then
                return unavailable('identity-unresolved')
            end
            local result = compact(value)
            result.version, result.status, result.authoritative = 1, 'available', true
            result.storage, result.runtimeId = M.storage, options.runtimeId
            result.generation, result.revision, result.activationId = value.generation, value.revision, value.activationId
            result.factHead, result.checkpointId = value.factHead, value.branchId .. ':' .. value.commitGeneration .. ':' .. value.ledgerSequence
            result.confidence = state.restoredRecord and same(state.restoredRecord, value) and proof() and 'native-restored' or 'native-live'
            result.restoredProof = proof()
            return result
        end
        function driver.apply(command)
            local function fail(reason) return {ok = false, reason = reason} end
            if type(command) ~= 'table' or not token(activation) then return fail('invalid-command') end
            local before = inspect()
            if before.status ~= 'inspected' or before.faulted or before.saving or state.revision >= MAX then return fail('native-unavailable') end
            if not guardMatches(command.expected, before.expected) then return fail('stale-guard') end
            local records = checkedRecords(command.confirmedRecords or {})
            if not records then return fail('invalid-confirmed-records') end
            if command.kind == 'claim' then
                if activation == state.activationId then return fail('lease-not-new') end
                state.activationId, state.resolved = activation, false
                state.pendingCommit = nil
                state.confirmed = records; state.revision = state.revision + 1
                return {ok = true, inspected = inspect(), snapshot = driver.capture()}
            end
            if activation ~= state.activationId then return fail('lease-mismatch') end
            if command.kind == 'resume' then
                if before.schema ~= 1 or not contains(records, before) then return fail('record-unconfirmed') end
                -- The sole bootstrap-resume exception is an acknowledged durable
                -- intent whose head write was attempted in THIS runtime/load/lease.
                -- No restore or CET reload can reconstruct this transient receipt.
                if state.requiresFork then
                    local pending = state.pendingCommit
                    if not pending or pending.runtimeId ~= options.runtimeId or pending.generation ~= state.generation
                        or pending.activationId ~= activation or not validRecord(command.preparedRecord)
                        or not same(pending.record, command.preparedRecord) or not same(pending.record, before) then
                        return fail('fresh-branch-required')
                    end
                end
                state.confirmed, state.resolved, state.revision, state.requiresFork = records, true, state.revision + 1, false
                state.pendingCommit = nil
                return {ok = true, inspected = inspect(), snapshot = driver.capture()}
            end
            if command.kind ~= 'seed' and command.kind ~= 'advance' and command.kind ~= 'fork' then return fail('unknown-operation') end
            if options.writeQualified ~= true or not audited(options.collisionAudit) then return fail('fact-writes-unqualified') end
            local nextRecord = command.preparedRecord
            if not validRecord(nextRecord) or not contains(records, nextRecord) then return fail('prepared-record-unconfirmed') end
            nextRecord = compact(nextRecord)
            local nextBank = before.schema == 0 and 0 or 1 - before.bank
            if nextRecord.bank ~= nextBank or nextRecord.commitGeneration <= (before.commitGeneration or 0) then return fail('invalid-next-commit') end
            if command.kind == 'seed' then
                if before.schema ~= 0 or nextRecord.branchEpoch ~= 1 or nextRecord.ledgerSequence ~= 0 then return fail('not-empty-identity') end
                if command.campaignId ~= nextRecord.campaignId or command.branchId ~= nextRecord.branchId then return fail('command-record-mismatch') end
            else
                if before.schema ~= 1 or not contains(records, before) or nextRecord.campaignId ~= before.campaignId then return fail('owner-unconfirmed') end
                if command.kind == 'advance' then
                    if not state.resolved or nextRecord.branchId ~= before.branchId or nextRecord.branchEpoch ~= before.branchEpoch
                        or before.ledgerSequence >= MAX or nextRecord.ledgerSequence ~= before.ledgerSequence + 1
                        or command.ledgerSequence ~= nextRecord.ledgerSequence then return fail('invalid-advance') end
                elseif nextRecord.branchId == before.branchId or nextRecord.branchEpoch <= before.branchEpoch
                    or nextRecord.ledgerSequence ~= 0 or command.branchId ~= nextRecord.branchId
                    or command.branchEpoch ~= nextRecord.branchEpoch then return fail('invalid-fork') end
            end
            local destination = before.banks[nextBank + 1]
            local knownOld = destination.empty or destination.valid and contains(records, destination.record)
                and destination.record.campaignId == nextRecord.campaignId
            -- Partial recovery finishes the SAME durable prepared record. Every
            -- field must match an exact prefix of its prior->new write sequence.
            if not knownOld then
                local prior = command.previousBank
                local priorRaw
                if type(prior) == 'table' and prior.empty == true and prior.bank == nextBank then
                    priorRaw = {}; for _, name in ipairs(FIELDS) do priorRaw[name] = 0 end
                elseif validRecord(prior) and prior.bank == nextBank and contains(records, prior)
                    and prior.campaignId == nextRecord.campaignId then priorRaw = encode(prior) end
                if priorRaw then
                    local candidate, target = copy(priorRaw), encode(nextRecord)
                    local order = {'seal', 'generation'}
                    for _, name in ipairs(FIELDS) do if name ~= 'seal' and name ~= 'generation' then order[#order + 1] = name end end
                    for _, name in ipairs(order) do
                        candidate[name] = name == 'seal' and 0 or target[name]
                        if rawEqual(candidate, destination.raw) then knownOld = true; break end
                    end
                end
            end
            if not knownOld then return fail('unknown-nonzero-bank') end
            if before.schema == 0 and not before.banks[2].empty then return fail('occupied-uninitialized-bank') end
            local expected, target = copy(before.expected), encode(nextRecord)
            local newHead = nextRecord.commitGeneration * 2 + nextBank
            local attemptedHead = false
            local function checkWorld()
                if not available() or not state.active or state.saving or state.faulted
                    or state.generation ~= expected.generation or state.revision ~= expected.revision
                    or state.activationId ~= activation then error('world or lease changed') end
            end
            local function stillCurrent(head)
                checkWorld()
                local facts = options.getFacts()
                if not facts or facts:GetFactStr(NAMES[1]) ~= head then error('fact head changed') end
                -- The accessors are injected/native calls and may trigger a load
                -- callback. Validate once more before the next scalar mutation.
                checkWorld()
                return facts
            end
            local function put(name, value)
                local facts = stillCurrent(expected.factHead)
                facts:SetFactStr(PREFIX .. nextBank .. '_' .. name, value)
            end
            local ok = pcall(function()
                put('seal', 0)
                put('generation', nextRecord.commitGeneration)
                for _, name in ipairs(FIELDS) do if name ~= 'generation' and name ~= 'seal' then put(name, target[name]) end end
                local facts = stillCurrent(expected.factHead)
                for _, name in ipairs(FIELDS) do
                    if name ~= 'seal' and facts:GetFactStr(PREFIX .. nextBank .. '_' .. name) ~= target[name] then error('payload readback mismatch') end
                end
                put('seal', nextRecord.commitGeneration)
                local ready = stableNative()
                if not ready or not ready.banks[nextBank + 1].valid or not same(ready.banks[nextBank + 1].record, nextRecord)
                    or ready.factHead ~= expected.factHead then error('sealed readback mismatch') end
                facts = stillCurrent(expected.factHead)
                state.pendingCommit = {record = compact(nextRecord), runtimeId = options.runtimeId,
                    generation = state.generation, activationId = activation}
                attemptedHead = true
                facts:SetFactStr(NAMES[1], newHead)
                stillCurrent(newHead)
                local after = stableNative()
                if not after or after.factHead ~= newHead or not same(after, nextRecord) then error('commit readback mismatch') end
                stillCurrent(newHead)
            end)
            if not ok then state.resolved = false; return fail(attemptedHead and 'fact-command-uncertain' or 'fact-write-interrupted') end
            state.confirmed, state.resolved, state.requiresFork = records, true, false
            state.pendingCommit = nil
            state.revision = state.revision + 1
            return {ok = true, inspected = inspect(), snapshot = driver.capture()}
        end
        return driver
    end
    return runtime
end

return M
