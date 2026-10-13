-- Read-only observations of the current world. This module never interprets
-- quest outcomes, changes facts, retains native handles, or writes memory.
-- Call reset on every world transition; generation is a LOAD generation, not
-- the per-conversation request counter. See CAPTURE_CONTRACT.md.
local M = {}
local Collector = {}; Collector.__index = Collector
local MAX_SAFE = 9007199254740991
-- Per-inventory observation bound (facts and journal separately). The bridge
-- validator and pack builder enforce the same value so a large reviewed pack
-- cannot silently disable collection at load.
M.CAPTURE_LIMIT = 1024
local STATES = {Active = 'active', Succeeded = 'succeeded', Failed = 'failed'}
local CLASSES = {gameJournalQuest = true, gameJournalQuestPhase = true,
    gameJournalQuestObjective = true, gameJournalQuestSubObjective = true,
    gameJournalPhoneChoiceEntry = true, gameJournalPhoneMessage = true}

local function plain(value) return type(value) == 'table' and getmetatable(value) == nil end
local function integer(value, low, high)
    return type(value) == 'number' and value == value and value >= low and value <= high and value % 1 == 0
end
local function identifier(value)
    return type(value) == 'string' and #value > 0 and #value <= 160
        and value:match('^[A-Za-z0-9_:%-][A-Za-z0-9_.:/@+#%-]*$') ~= nil
        and value ~= '__proto__' and value ~= 'constructor' and value ~= 'prototype'
end
local function list(value, maximum, predicate, minimum)
    if not plain(value) or #value < (minimum or 0) or #value > maximum then return false end
    local count, seen = 0, {}
    for key, item in pairs(value) do
        if not integer(key, 1, #value) or not predicate(item) or seen[item] then return false end
        count, seen[item] = count + 1, true
    end
    return count == #value
end
local function clone(value)
    if type(value) ~= 'table' then return value end
    local out = {}; for key, item in pairs(value) do out[key] = clone(item) end; return out
end
local function unknown(reason) return {status = 'unknown', reason = reason} end
local function unavailable(reason) return {version = 1, status = 'unavailable', reason = reason} end
local function unsignedHash(value)
    local number = type(value) == 'number' and value or (type(value) == 'string' and value:match('^%-?%d+$') and tonumber(value))
    if not integer(number, -2147483648, 4294967295) then return nil end
    return number < 0 and number + 4294967296 or number
end
local function normalizeIdentity(value)
    if not plain(value) then return {status = 'unknown'} end
    if value.status == 'session-only' then return {status = 'session-only'} end
    if value.status ~= 'verified' then return {status = 'unknown'} end
    local result = {status = 'verified'}
    for _, key in ipairs({'userId', 'playthroughId', 'branchId', 'checkpointId'}) do
        if not identifier(value[key]) then return {status = 'unknown'} end
        result[key] = value[key]
    end
    if identifier(value.saveId) then result.saveId = value.saveId end
    return result
end
local function audience(value)
    if not plain(value) or (value.channel ~= 'private' and value.channel ~= 'group' and value.channel ~= 'phone')
        or not list(value.profileKeys, 8, identifier, 1)
        or (value.channel ~= 'group' and #value.profileKeys ~= 1) then return nil end
    return {channel = value.channel, profileKeys = clone(value.profileKeys)}
end
local function bounded(value, fallback, low, high)
    return type(value) == 'number' and value == value and value >= low and value <= high and value or fallback
end

-- Exact compact JSON byte bound for the plain fields emitted here, including
-- optional slash escaping. Empty Lua maps/lists both occupy two bytes.
local function jsonBytes(value)
    if type(value) == 'string' then
        local _, escapes = value:gsub('["\\/]', '')
        local _, controls = value:gsub('[%c]', '')
        return 2 + #value + escapes + controls * 5
    end
    if type(value) == 'boolean' then return value and 4 or 5 end
    if type(value) == 'number' then return #string.format('%.17g', value) end
    local size, count, array = 2, 0, #value > 0
    if array then for key in pairs(value) do if not integer(key, 1, #value) then array = false; break end end end
    for key, item in pairs(value) do
        size, count = size + jsonBytes(item), count + 1
        if not array then size = size + jsonBytes(key) + 1 end
    end
    return size + math.max(0, count - 1)
end

-- Same observations, ignoring which capture produced them: two 'capture:...'
-- evidence refs count as equal (they name the cycle, not the observation).
local function sameObservations(a, b)
    if type(a) ~= type(b) then return false end
    if type(a) == 'string' then return a == b or (a:sub(1, 8) == 'capture:' and b:sub(1, 8) == 'capture:') end
    if type(a) ~= 'table' then return a == b end
    for key, value in pairs(a) do if not sameObservations(value, b[key]) then return false end end
    for key in pairs(b) do if a[key] == nil then return false end end
    return true
end

-- These functions reacquire game systems on each call. No player, journal,
-- entry, system, enum, or record handle escapes the call that acquired it.
local function nativeReady()
    local player = Game.GetPlayer()
    if not player or not player:IsAttached() or player:IsDeadNoStatPool()
        or Game.GetSystemRequestsHandler():IsPreGame() then return false end
    local journal = Game.GetJournalManager()
    return journal ~= nil and not journal:HasAnyDelayedStateChanges()
end
-- One update batch reads up to ~32 facts and journal entries. The quests system and journal manager are acquired once
-- per batch (beginBatch/endBatch around the loop, never kept past it) instead of once per read.
local batchQuests, batchJournal
local function nativeBegin()
    batchQuests, batchJournal = Game.GetQuestsSystem(), Game.GetJournalManager()
end
local function nativeEnd() batchQuests, batchJournal = nil, nil end
local function nativeFact(name)
    return (batchQuests or Game.GetQuestsSystem()):GetFactStr(name)
end
-- GameTime is a struct holding whole game seconds since the playthrough began.
-- Read it two ways when both work and refuse a disagreement, so an API mismatch
-- yields no time rather than a wrong order. Callers keep this off the hot path.
local MAX_GAME_SECONDS = 4294967295
local function gameSeconds(stamp)
    if stamp == nil then return nil end
    local function valid(value)
        value = tonumber(value)
        return integer(value, 0, MAX_GAME_SECONDS) and value or nil
    end
    local okField, field = pcall(function() return valid(stamp.seconds) end)
    local okTotal, total = pcall(function() return valid(GameTime.GetSeconds(stamp)) end)
    field, total = okField and field or nil, okTotal and total or nil
    if field and total and field ~= total then return nil end
    return field or total
end
M.gameSeconds = gameSeconds
local function nativeGameTime()
    local system = Game.GetTimeSystem()
    if not system then return nil end
    local seconds = gameSeconds(system:GetGameTime())
    if seconds then return seconds end
    local stamp = tonumber(system:GetGameTimeStamp())
    return stamp and stamp == stamp and stamp >= 0 and stamp <= MAX_GAME_SECONDS and math.floor(stamp) or nil
end
M.nativeGameTime = nativeGameTime -- the game clock in seconds, or nil (the decision ledger stamps picks with it)
-- gameJournalEntryState by integer value, built once: one EnumInt per read instead of up to three Enum.new.
local stateByInt
local function journalState(journal, entry)
    local state = journal:GetEntryState(entry)
    if stateByInt == nil then
        stateByInt = {}
        for native, normalized in pairs(STATES) do
            local ok, value = pcall(function() return tonumber(EnumInt(Enum.new('gameJournalEntryState', native))) end)
            if ok and value then stateByInt[value] = normalized end
        end
        if next(stateByInt) == nil then stateByInt = false end
    end
    if stateByInt then
        local ok, value = pcall(function() return tonumber(EnumInt(state)) end)
        if ok and value then return stateByInt[value] end
    end
    for native, normalized in pairs(STATES) do
        if state == Enum.new('gameJournalEntryState', native) then return normalized end
    end
    return nil
end
local function entrySeconds(journal, entry) return gameSeconds(journal:GetEntryTimestamp(entry)) end
local function timed(journal, entry, value, knownValue, row)
    if value ~= knownValue then
        local ok, seconds = pcall(entrySeconds, journal, entry)
        row.timeRead, row.gameTimeSeconds = true, ok and seconds or nil
    end
    return row
end
-- knownValue is the state this collector last timed for the key. The entry's
-- game timestamp (time of its last state change) is read only when the state
-- differs, so a steady journal costs no extra native call per cycle.
local function nativeJournal(key, selector, depthLimit, knownValue)
    local journal = batchJournal or Game.GetJournalManager()
    local entry
    if selector.nativePath then
        entry = journal:GetEntryByString(selector.nativePath, selector.nativeClass)
    else
        entry = journal:GetEntry(unsignedHash(key))
    end
    if not entry then return nil, 'journal-missing' end
    local actualHash = unsignedHash(journal:GetEntryHash(entry))
    local expectedHash = selector.expectedHash and unsignedHash(selector.expectedHash) or unsignedHash(key)
    if not actualHash or (expectedHash and actualHash ~= expectedHash) then return nil, 'journal-hash-mismatch' end
    if selector.nativeClass and not entry:IsA(selector.nativeClass) then return nil, 'journal-class-mismatch' end
    local value = journalState(journal, entry)
    if not value then return nil, 'journal-not-revealed' end
    local phoneChoice = entry:IsA('gameJournalPhoneChoiceEntry')
    local phoneMessage = entry:IsA('gameJournalPhoneMessage')
    if phoneChoice or phoneMessage then
        if phoneChoice and (value ~= 'succeeded' or not journal:IsEntryVisited(entry)) then return nil, 'phone-choice-not-sent' end
        if phoneMessage and value ~= 'active' and value ~= 'succeeded' then return nil, 'phone-message-not-received' end
        local cursor, seen = entry, {}
        for _ = 1, depthLimit do
            local id = unsignedHash(journal:GetEntryHash(cursor))
            local current = journalState(journal, cursor)
            local retiredGroup = phoneChoice and selector.allowRetiredChoiceGroup == true
                and cursor:IsA('gameJournalPhoneChoiceGroup')
                and journal:GetEntryState(cursor) == Enum.new('gameJournalEntryState', 'Inactive')
            if not id or seen[id] or (current ~= 'active' and current ~= 'succeeded' and not retiredGroup) then return nil, 'phone-parent-unrevealed' end
            seen[id] = true
            if cursor:IsA('gameJournalContact') then
                if not cursor:IsKnown(journal) then return nil, 'phone-contact-unknown' end
                return timed(journal, entry, value, knownValue, {value = value, revealed = true, isQuest = false, nativeHash = string.format('%.0f', actualHash)})
            end
            if cursor ~= entry and not cursor:IsA('gameJournalPhoneConversation') and not cursor:IsA('gameJournalPhoneChoiceGroup') then
                return nil, 'phone-parent-invalid'
            end
            cursor = journal:GetParentEntry(cursor)
            if not cursor then return nil, 'phone-parent-missing' end
        end
        return nil, 'phone-depth-limit'
    end
    local isQuest = entry:IsA('gameJournalQuest')
    if not isQuest and not entry:IsA('gameJournalQuestPhase')
        and not entry:IsA('gameJournalQuestObjectiveBase') then return nil, 'journal-not-quest' end
    local seen, cursor = {}, entry
    for _ = 1, depthLimit do
        local hash = unsignedHash(journal:GetEntryHash(cursor))
        if not hash or seen[hash] then return nil, 'journal-parent-cycle' end
        seen[hash] = true
        if not journalState(journal, cursor) then return nil, 'journal-parent-unrevealed' end
        if cursor:IsA('gameJournalQuest') then
            if selector.questHash and hash ~= unsignedHash(selector.questHash) then return nil, 'journal-quest-mismatch' end
            return timed(journal, entry, value, knownValue, {value = value, revealed = true, isQuest = isQuest, nativeHash = string.format('%.0f', actualHash)})
        end
        cursor = journal:GetParentEntry(cursor)
        if not cursor then return nil, 'journal-parent-missing' end
    end
    return nil, 'journal-depth-limit'
end
local function nativeLifepath()
    local player = Game.GetPlayer()
    local system = Game.GetScriptableSystemsContainer():Get('PlayerDevelopmentSystem')
    if not player or not system then return nil end
    local path = system:GetLifePath(player)
    for native, normalized in pairs({Nomad = 'nomad', StreetKid = 'streetkid', Corporate = 'corpo'}) do
        if path == Enum.new('gamedataLifePath', native) then return normalized end
    end
    return nil
end

local function selectedInventory(pack, name, selected)
    local inventory = pack[name]
    if not plain(inventory) then return nil, 'invalid-' .. name end
    local count = 0
    for key, row in pairs(inventory) do
        count = count + 1
        if count > 4096 or not identifier(key) or not plain(row)
            or not list(row.evidenceRefs, 32, identifier, 1) then return nil, 'invalid-' .. name end
    end
    if selected and not list(selected, M.CAPTURE_LIMIT, identifier) then return nil, 'invalid-selection' end
    local keys = selected and clone(selected) or {}
    if not selected then
        if count > M.CAPTURE_LIMIT then return nil, 'selection-required' end
        for key in pairs(inventory) do keys[#keys + 1] = key end
    end
    table.sort(keys)
    local out = {}
    for _, key in ipairs(keys) do
        local row = inventory[key]
        if not row then return nil, 'selection-not-allowlisted' end
        local item = {key = key}
        if name == 'journalAllowlist' then
            if not identifier(row.questKey) then return nil, 'invalid-journal-selector' end
            item.questKey = row.questKey
            if row.nativePath ~= nil or row.nativeClass ~= nil then
                if type(row.nativePath) ~= 'string' or #row.nativePath < 1 or #row.nativePath > 512
                    or row.nativePath:find('[%c]') or not CLASSES[row.nativeClass] then return nil, 'invalid-journal-selector' end
                item.nativePath, item.nativeClass = row.nativePath, row.nativeClass
            end
            if row.allowRetiredChoiceGroup ~= nil then
                if row.allowRetiredChoiceGroup ~= true or row.nativeClass ~= 'gameJournalPhoneChoiceEntry'
                    or not list(row.retiredGroupEvidenceRefs, 16, identifier, 1) then return nil, 'invalid-retired-group-evidence' end
                local refs = {}; for _, ref in ipairs(row.evidenceRefs) do refs[ref] = true end
                for _, ref in ipairs(row.retiredGroupEvidenceRefs) do if not refs[ref] then return nil, 'invalid-retired-group-evidence' end end
                item.allowRetiredChoiceGroup = true
            end
            if not unsignedHash(key) and not item.nativePath then return nil, 'invalid-journal-selector' end
            if row.expectedHash ~= nil then
                if not unsignedHash(row.expectedHash) or (unsignedHash(key) and unsignedHash(key) ~= unsignedHash(row.expectedHash)) then
                    return nil, 'invalid-journal-selector'
                end
                item.expectedHash = row.expectedHash
            end
            if row.questHash ~= nil then
                if not unsignedHash(row.questHash) then return nil, 'invalid-journal-selector' end
                item.questHash = row.questHash
            end
        end
        out[#out + 1] = item
    end
    return out
end

function M.new(options)
    options = options or {}
    local adapter = options.adapter or {}
    return setmetatable({adapter = {
        isReady = adapter.isReady or nativeReady,
        readFact = adapter.readFact or nativeFact,
        readJournal = adapter.readJournal or nativeJournal,
        readLifepath = adapter.readLifepath or nativeLifepath,
        readGameTime = adapter.readGameTime or nativeGameTime,
        -- Optional: hold the native systems for the length of one batch (the defaults do; test adapters need not).
        beginBatch = adapter.beginBatch or (options.adapter == nil and nativeBegin or nil),
        endBatch = adapter.endBatch or (options.adapter == nil and nativeEnd or nil)},
        currentGeneration = options.currentGeneration, currentWorldToken = options.currentWorldToken,
        now = options.now or os.time, cpuNow = options.cpuNow or os.clock,
        utcNow = options.utcNow or function() return os.date('!%Y-%m-%dT%H:%M:%SZ') end,
        batchSize = math.floor(bounded(options.batchSize, 32, 1, 128)),
        budgetSeconds = bounded(options.budgetSeconds, 0.002, 0.0001, 0.01),
        -- The lease is measured from the start of the sampling cycle, so the
        -- oldest observation in a published snapshot is at most this old. A
        -- cycle reads ~1,000 facts and journal entries (each ~58 us through
        -- CET); it rests refreshSeconds between cycles and runs at once on
        -- demand (a journal change, the composer, phone chat or talk key; see
        -- init.lua), so a turn V types or speaks gets a cycle that finished
        -- moments before it. maxAge covers refresh + two cycles + whole-second
        -- os.time rounding. The bridge's limit is WORLD_SNAPSHOT_MAX_AGE_MS.
        maxAgeSeconds = bounded(options.maxAgeSeconds, 45, 0.25, 60),
        refreshSeconds = bounded(options.refreshSeconds, 30, 0, 40),
        -- With journal-change events wired (eventDriven, set by init.lua once the hook is registered) a resting cache
        -- that saw no change event is re-stamped instead of rescanned, and fully rescanned only every verifySeconds.
        -- Demands (a turn is coming) always rescan. Without events nothing changes: a cycle every refreshSeconds.
        verifySeconds = bounded(options.verifySeconds, 120, 5, 3600), changeSeq = 0, eventDriven = false,
        newEncoder = options.newEncoder,
        journalDepth = math.floor(bounded(options.journalDepth, 12, 1, 16)),
        serial = 0, revision = 0, stamps = {}, reason = 'not-configured'}, Collector)
end

function Collector:reset(generation, reason, worldToken)
    self.generation = integer(generation, 0, MAX_SAFE) and generation or nil
    self.worldToken = identifier(worldToken) and worldToken or nil
    self.cache, self.job, self.lastNow, self.nextRefresh = nil, nil, nil, nil
    self.forced, self.encoding = nil, nil
    -- Journal timestamps belong to this world only; key -> {value, seconds}.
    self.stamps = {}
    self.reason = reason or 'world-reset'
end

function Collector:configure(pack, options)
    options = options or {}
    self:reset(nil, 'invalid-pack'); self.config = nil
    if not plain(pack) or pack.version ~= 1 or not identifier(options.gameVersion) or #options.gameVersion > 32
        or not list(pack.gameVersions, 32, identifier, 1) then return false, self.reason end
    local compatible = false
    for _, version in ipairs(pack.gameVersions) do if version == options.gameVersion then compatible = true end end
    if not compatible then self.reason = 'unsupported-game-version'; return false, self.reason end
    local facts, factError = selectedInventory(pack, 'factAllowlist', options.factKeys)
    local journal, journalError = selectedInventory(pack, 'journalAllowlist', options.journalKeys)
    if not facts or not journal then self.reason = factError or journalError; return false, self.reason end
    self.config = {gameVersion = options.gameVersion, facts = facts, journal = journal}
    self.reason = 'capture-pending'
    return true
end

function Collector:checkWorld(generation, worldToken)
    if not integer(generation, 0, MAX_SAFE) then return false, 'invalid-generation' end
    if self.currentGeneration then
        local ok, current = pcall(self.currentGeneration)
        if not ok or current ~= generation then return false, 'world-generation-changed' end
    end
    if worldToken ~= nil and not identifier(worldToken) then return false, 'invalid-world-token' end
    if self.currentWorldToken then
        local ok, current = pcall(self.currentWorldToken)
        if not ok or not identifier(current) or current ~= worldToken then return false, 'world-token-changed' end
    end
    local ok, ready = pcall(self.adapter.isReady)
    if not ok or ready ~= true then return false, 'native-unavailable' end
    return true
end

function Collector:clock()
    local ok, value = pcall(self.now)
    if not ok or type(value) ~= 'number' or value ~= value or value < 0 or value > 1e12 then return nil end
    if self.lastNow and value < self.lastNow then
        self:reset(self.generation, 'clock-regressed', self.worldToken); self.lastNow = value; return nil
    end
    self.lastNow = value; return value
end

local function evidence(job, kind, index)
    return {'capture:' .. tostring(job.generation) .. ':' .. tostring(job.serial) .. ':' .. kind .. ':' .. tostring(index)}
end
local function factObservation(value, proof, key, job, index)
    if not integer(value, -2147483648, 2147483647) then return unknown('fact-invalid-value') end
    local refs = evidence(job, 'fact', index)
    if value == 0 then
        -- Native GetFactStr returns zero for missing facts too. A future native
        -- presence API must provide an independent, generation-bound receipt.
        if not plain(proof) or proof.status ~= 'verified' or proof.generation ~= job.generation
            or proof.worldToken ~= job.worldToken
            or proof.fact ~= key or proof.value ~= 0 or not identifier(proof.sourceId)
            or not list(proof.evidenceRefs, 8, identifier, 1) then return unknown('fact-zero-presence-unknown') end
        for _, ref in ipairs(proof.evidenceRefs) do refs[#refs + 1] = ref end
    end
    return {status = 'known', value = value, present = true, sourceId = 'native-quests-system', evidenceRefs = refs}
end

function Collector:progress()
    local job = self.job
    return {status = job and 'collecting' or (self.cache and 'ready' or 'unavailable'), reason = self.reason,
        observed = job and job.cursor - 1 or 0,
        remaining = job and #self.config.facts + #self.config.journal + 2 - job.cursor or 0}
end

function Collector:update(context)
    local generation = type(context) == 'table' and context.generation or context
    local worldToken = type(context) == 'table' and context.worldToken or nil
    if not self.config then return self:progress() end
    if generation ~= self.generation or worldToken ~= self.worldToken then self:reset(generation, 'capture-pending', worldToken) end
    -- Resting between cycles: no native call at all. capture() re-checks the
    -- world itself, so a world that stopped being ready is never served.
    if not self.job and self.cache and self.nextRefresh then
        local ok, now = pcall(self.now)
        if ok and type(now) == 'number' and (not self.lastNow or now >= self.lastNow) then
            if now < self.nextRefresh or self:revalidate(now) then self:pump(); return self:progress() end
        end
    end
    local ready, why = self:checkWorld(generation, worldToken)
    if not ready then self:reset(nil, why); return self:progress() end
    local now = self:clock()
    if not now then self.cache, self.job = nil, nil; return self:progress() end
    if self.job and now - self.job.started > self.maxAgeSeconds then
        self.job = nil; self.reason = 'capture-window-expired'
    end
    if not self.job then
        if self.nextRefresh and now < self.nextRefresh then return self:progress() end
        self.serial = self.serial + 1
        self.job = {generation = generation, worldToken = worldToken, serial = self.serial, cursor = 1, started = now,
            seq = self.changeSeq, facts = {}, journal = {}, active = {}, lifepath = unknown('lifepath-unavailable')}
        self.forced, self.encoding = nil, nil
    end
    local job, total = self.job, #self.config.facts + #self.config.journal + 1
    local cpuOk, started = pcall(self.cpuNow)
    local processed = 0
    if self.adapter.beginBatch then pcall(self.adapter.beginBatch) end
    local loopOk, loopError = pcall(function()
    while job.cursor <= total and processed < self.batchSize do
        if processed > 0 and cpuOk then
            local ok, current = pcall(self.cpuNow)
            if not ok or type(current) ~= 'number' or type(started) ~= 'number'
                or current - started >= self.budgetSeconds then break end
        end
        local index = job.cursor
        if index <= #self.config.facts then
            local key = self.config.facts[index].key
            local ok, value, proof = pcall(self.adapter.readFact, key, generation)
            job.facts[key] = ok and factObservation(value, proof, key, job, index) or unknown('fact-read-failed')
        elseif index <= #self.config.facts + #self.config.journal then
            local row = self.config.journal[index - #self.config.facts]
            local stamp = self.stamps[row.key]
            local ok, observation = pcall(self.adapter.readJournal, row.key, clone(row), self.journalDepth, stamp and stamp.value)
            if ok and plain(observation) and observation.revealed == true
                and (observation.value == 'active' or observation.value == 'succeeded' or observation.value == 'failed') then
                local refs = evidence(job, 'journal', index - #self.config.facts)
                if unsignedHash(observation.nativeHash) then refs[#refs + 1] = 'journal-hash:' .. string.format('%.0f', unsignedHash(observation.nativeHash)) end
                if observation.timeRead == true then
                    -- A failed read is remembered too: it is retried only after a state change.
                    stamp = {value = observation.value,
                        seconds = integer(observation.gameTimeSeconds, 0, MAX_GAME_SECONDS) and observation.gameTimeSeconds or nil}
                    self.stamps[row.key] = stamp
                end
                job.journal[row.key] = {status = 'known', value = observation.value, revealed = true, questKey = row.questKey,
                    sourceId = 'native-journal-manager', evidenceRefs = refs,
                    gameTimeSeconds = stamp and stamp.value == observation.value and stamp.seconds or nil}
                if observation.isQuest == true and observation.value == 'active' then job.active[row.questKey] = true end
            else
                job.journal[row.key] = unknown(ok and 'journal-not-revealed' or 'journal-read-failed')
            end
        else
            local ok, value = pcall(self.adapter.readLifepath)
            if ok and (value == 'nomad' or value == 'streetkid' or value == 'corpo') then
                job.lifepath = {status = 'known', value = value, sourceId = 'native-player-lifepath', evidenceRefs = evidence(job, 'lifepath', 1)}
            end
        end
        job.cursor, processed = job.cursor + 1, processed + 1
    end
    end)
    if self.adapter.endBatch then pcall(self.adapter.endBatch) end
    if not loopOk then error(loopError, 0) end
    -- Recheck after the native calls as well: a load callback can invalidate the
    -- generation during a read. Never publish a partial old-world result.
    ready, why = self:checkWorld(generation, worldToken)
    if not ready or self.job ~= job then self:reset(nil, why or 'world-reset'); return self:progress() end
    now = self:clock()
    if not now or now - job.started > self.maxAgeSeconds then
        self.cache, self.job, self.reason = nil, nil, 'capture-window-expired'; return self:progress()
    end
    if job.cursor > total then
        local ok, stamp = pcall(self.utcNow)
        if not ok or type(stamp) ~= 'string' or #stamp > 40
            or not stamp:match('^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d%.?%d*Z$') then
            self.cache, self.job, self.reason = nil, nil, 'invalid-timestamp'; return self:progress()
        end
        local active = {}; for key in pairs(job.active) do active[#active + 1] = key end; table.sort(active)
        while #active > 32 do table.remove(active) end
        -- The observations get a revision (docs/PERFORMANCE_NATIVE_PLAN.md item 1b): a turn sends only the
        -- revision while it is unchanged, and the bridge keeps the observations from knowledge-world.json. A cycle
        -- that saw exactly what the last one saw keeps the same revision and tables; only its times move on.
        local previous = self.cache
        local data = {facts = job.facts, journal = job.journal, lifepath = job.lifepath}
        if #active > 0 then data.activeQuestKeys = active end
        if previous and previous.generation == generation and sameObservations(previous.data, data) then
            data = previous.data
        else
            self.revision = self.revision + 1
        end
        local reused = previous and previous.data == data
        self.cache = {generation = generation, started = job.started, capturedAt = stamp, data = data,
            revision = self.revision, dataBytes = reused and previous.dataBytes or jsonBytes(data),
            facts = data.facts, journal = data.journal, activeQuestKeys = data.activeQuestKeys or {}, lifepath = data.lifepath,
            -- seq: the journal-change count this scan began under; scanned: when the observations were last read for real.
            seq = job.seq, scanned = job.started, encoded = reused and previous.encoded or nil}
        self.job, self.nextRefresh, self.reason, self.forced = nil, now + self.refreshSeconds, nil, nil
        if not self.cache.encoded and self.newEncoder then
            local ok, facts = pcall(self.newEncoder, data.facts)
            local ok2, journal = pcall(self.newEncoder, data.journal)
            if ok and ok2 and facts and journal then self.encoding = {cache = self.cache, facts = facts, journal = journal} end
        end
    end
    return self:progress()
end

-- The journal changed (JournalNotificationQueue.OnJournalUpdate): a resting cache can no longer be re-stamped as current.
function Collector:markChanged() self.changeSeq = self.changeSeq + 1 end

-- Event-driven: no journal change event since this cache's scan began and its last real read is younger than
-- verifySeconds, so its observations are re-stamped as current without a native call. A demand always rescans.
function Collector:revalidate(now)
    local cache = self.cache
    if not self.eventDriven or self.forced or not cache or cache.seq ~= self.changeSeq
        or now - (cache.scanned or cache.started) >= self.verifySeconds then return false end
    local ok, stamp = pcall(self.utcNow)
    if not ok or type(stamp) ~= 'string' or #stamp > 40
        or not stamp:match('^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d%.?%d*Z$') then return false end
    cache.started, cache.capturedAt = now, stamp
    self.nextRefresh = now + self.refreshSeconds
    return true
end

-- Encodes the new observations a few entries per frame after a scan (the encoder is mod/knowledge-parts.lua's), so the
-- first turn after it publishes a ready string instead of encoding ~150 KB on the frame it is sent.
function Collector:pump()
    local job = self.encoding
    if not job then return end
    if job.cache ~= self.cache then self.encoding = nil; return end
    local current = job.facts.done and job.journal or job.facts
    local ok = pcall(current.step, current, 24)
    if not ok or current.failed then self.encoding = nil; return end
    if job.facts.done and job.journal.done then
        local data = job.cache.data
        local okLife, life = pcall(job.facts.encodeValue, data.lifepath)
        local okActive, active = true, nil
        if data.activeQuestKeys then okActive, active = pcall(job.facts.encodeValue, data.activeQuestKeys) end
        if okLife and okActive and type(life) == 'string' and (active == nil or type(active) == 'string') then
            job.cache.encoded = '{"facts":' .. job.facts.text .. ',"journal":' .. job.journal.text .. ',"lifepath":' .. life
                .. (active and (',"activeQuestKeys":' .. active) or '') .. '}'
        end
        self.encoding = nil
    end
end

-- A turn is coming (or the journal just changed): start a cycle on the next
-- update unless one is running or the cache began less than minAge seconds ago.
function Collector:demand(minAge)
    if self.job or not self.cache then self.nextRefresh, self.forced = nil, true; return true end
    local ok, now = pcall(self.now)
    if not ok or type(now) ~= 'number' or now - self.cache.started >= (minAge or 2) then self.nextRefresh, self.forced = nil, true; return true end
    return false
end

function Collector:capture(context)
    if not plain(context) then return unavailable('invalid-context') end
    local ready, why = self:checkWorld(context.generation, context.worldToken)
    if not ready or context.generation ~= self.generation or context.worldToken ~= self.worldToken then
        self:reset(nil, why or 'world-generation-changed'); return unavailable(self.reason)
    end
    local now = self:clock()
    if not self.config or not self.cache or not now then return unavailable(self.reason or 'capture-pending') end
    if now - self.cache.started > self.maxAgeSeconds then return unavailable('capture-expired') end
    local recipients = audience(context.audience)
    if not recipients then return unavailable('invalid-audience') end
    local result = {version = 1, status = 'ready', gameVersion = self.config.gameVersion,
        generation = context.generation, capturedAt = self.cache.capturedAt,
        identity = normalizeIdentity(context.identity), audience = recipients,
        facts = clone(self.cache.facts), journal = clone(self.cache.journal), lifepath = clone(self.cache.lifepath)}
    -- Preserve the exact capture binding for the bridge. It must check this
    -- before attaching a now-verified identity to a formerly anonymous capture.
    if self.worldToken then result.worldToken = self.worldToken end
    -- Current game time, read once per capture (on demand), dates the journal
    -- timestamps above. Absent when the native clock cannot be read.
    local timeOk, seconds = pcall(self.adapter.readGameTime)
    if timeOk and integer(seconds, 0, MAX_GAME_SECONDS) then result.gameTimeSeconds = seconds end
    -- Omit an empty list: CET's JSON codec can serialize an empty Lua table as
    -- {}, whereas the bridge correctly requires arrays when the field exists.
    if #self.cache.activeQuestKeys > 0 then result.activeQuestKeys = clone(self.cache.activeQuestKeys) end
    if jsonBytes(result) > 256 * 1024 - 512 then return unavailable('snapshot-byte-limit') end
    return result
end

-- The same checks and header as capture(), without copying the observations: the result carries
-- ref = {part = 'world', revision} and part = {name, revision, data}. data is the collector's own table: the caller
-- only encodes it (mod/knowledge-parts.lua) and never changes it.
function Collector:capturePart(context)
    if not plain(context) then return unavailable('invalid-context') end
    local ready, why = self:checkWorld(context.generation, context.worldToken)
    if not ready or context.generation ~= self.generation or context.worldToken ~= self.worldToken then
        self:reset(nil, why or 'world-generation-changed'); return unavailable(self.reason)
    end
    local now = self:clock()
    if not self.config or not self.cache or not now then return unavailable(self.reason or 'capture-pending') end
    if now - self.cache.started > self.maxAgeSeconds then return unavailable('capture-expired') end
    local recipients = audience(context.audience)
    if not recipients then return unavailable('invalid-audience') end
    local cache = self.cache
    local result = {version = 1, status = 'ready', gameVersion = self.config.gameVersion,
        generation = context.generation, capturedAt = cache.capturedAt,
        identity = normalizeIdentity(context.identity), audience = recipients,
        ref = {part = 'world', revision = cache.revision}}
    if self.worldToken then result.worldToken = self.worldToken end
    local timeOk, seconds = pcall(self.adapter.readGameTime)
    if timeOk and integer(seconds, 0, MAX_GAME_SECONDS) then result.gameTimeSeconds = seconds end
    if jsonBytes(result) + cache.dataBytes > 256 * 1024 - 512 then return unavailable('snapshot-byte-limit') end
    return result, {name = 'world', revision = cache.revision, generation = context.generation,
        worldToken = self.worldToken, data = cache.data, encoded = cache.encoded}
end

function Collector:begin(pack, context)
    local ok, why = self:configure(pack, context)
    if not ok then return unavailable(why) end
    return self:update(context)
end

-- The reviewed pack (world-knowledge.json) is ~9 MB because it carries the sources, evidence and rules the bridge uses;
-- this collector reads only the two allowlists' selectors. Decoding it took ~220 ms of the game thread, on the first frame
-- of every session. compactPack keeps exactly what configure() reads (same validation, so the same config), and loadPack
-- keeps that in a small cache file keyed by a fingerprint of the source (its size and 64 sampled windows): later sessions
-- decode ~100 KB. A missing or stale cache falls back to the full file and rewrites the cache.
local JOURNAL_FIELDS = {'questKey', 'nativePath', 'nativeClass', 'allowRetiredChoiceGroup', 'retiredGroupEvidenceRefs',
    'expectedHash', 'questHash'}
function M.compactPack(pack)
    if not plain(pack) or not plain(pack.factAllowlist) or not plain(pack.journalAllowlist) then return nil end
    local out = {version = pack.version, gameVersions = clone(pack.gameVersions), factAllowlist = {}, journalAllowlist = {}}
    -- One evidence ref is enough when the row is valid; an invalid row is copied whole so configure() rejects it as before.
    local function refs(row, all)
        if all or not list(row.evidenceRefs, 32, identifier, 1) then return clone(row.evidenceRefs) end
        return {row.evidenceRefs[1]}
    end
    for key, row in pairs(pack.factAllowlist) do
        out.factAllowlist[key] = plain(row) and {evidenceRefs = refs(row)} or row
    end
    for key, row in pairs(pack.journalAllowlist) do
        if plain(row) then
            local item = {evidenceRefs = refs(row, row.allowRetiredChoiceGroup ~= nil)}
            for _, field in ipairs(JOURNAL_FIELDS) do item[field] = clone(row[field]) end
            out.journalAllowlist[key] = item
        else out.journalAllowlist[key] = row end
    end
    return out
end

local FINGERPRINT_WINDOW, FINGERPRINT_SAMPLES = 128, 64
local function fingerprint(file)
    local size = file:seek('end')
    if type(size) ~= 'number' or size < FINGERPRINT_WINDOW then return nil end
    local h1, h2 = 5381, 52711
    for i = 0, FINGERPRINT_SAMPLES - 1 do
        file:seek('set', math.floor((size - FINGERPRINT_WINDOW) * i / (FINGERPRINT_SAMPLES - 1)))
        local chunk = file:read(FINGERPRINT_WINDOW)
        if type(chunk) ~= 'string' then return nil end
        for j = 1, #chunk do
            local byte = chunk:byte(j)
            h1, h2 = (h1 * 33 + byte) % 16777213, (h2 * 131 + byte) % 8388593
        end
    end
    file:seek('set', 0)
    return string.format('%d:%06x:%06x', size, h1, h2)
end

-- env = {open, decode, encode, source, cache}. Returns the pack for configure(), or nil.
function M.loadPack(env)
    local source = env.open(env.source, 'rb')
    if not source then return nil end
    local okPrint, print = pcall(fingerprint, source)
    if okPrint and print then
        local cached = env.open(env.cache, 'rb')
        if cached then
            local raw = cached:read(16 * 1024 * 1024 + 1); cached:close()
            if type(raw) == 'string' and #raw <= 16 * 1024 * 1024 then
                local ok, value = pcall(env.decode, raw)
                if ok and plain(value) and value.source == print and plain(value.pack) then source:close(); return value.pack end
            end
        end
    else print = nil end
    local raw = source:read(16 * 1024 * 1024 + 1); source:close()
    if type(raw) ~= 'string' or #raw > 16 * 1024 * 1024 then return nil end
    local ok, pack = pcall(env.decode, raw)
    if not ok or type(pack) ~= 'table' then return nil end
    if print and env.encode then
        local compact = M.compactPack(pack)
        local okEncode, text = pcall(env.encode, {version = 1, source = print, pack = compact})
        if compact and okEncode and type(text) == 'string' then
            local out = env.open(env.cache, 'wb')
            if out then pcall(function() out:write(text) end); pcall(function() out:close() end) end
        end
    end
    return pack
end

-- Reachable from a collector instance as worldKnowledge.loadPack(env) (init.lua keeps only the instance).
M.fingerprint = fingerprint
Collector.loadPack, Collector.compactPack = M.loadPack, M.compactPack

M.nativeAdapter = {isReady = nativeReady, readFact = nativeFact, readJournal = nativeJournal, readLifepath = nativeLifepath,
    readGameTime = nativeGameTime}
return M
