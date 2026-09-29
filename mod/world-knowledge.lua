-- Read-only observations of the current world. This module never interprets
-- quest outcomes, changes facts, retains native handles, or writes memory.
-- Call reset on every world transition; generation is a LOAD generation, not
-- the per-conversation request counter. See CAPTURE_CONTRACT.md.
local M = {}
local Collector = {}; Collector.__index = Collector
local MAX_SAFE = 9007199254740991
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

-- These functions reacquire game systems on each call. No player, journal,
-- entry, system, enum, or record handle escapes the call that acquired it.
local function nativeReady()
    local player = Game.GetPlayer()
    if not player or not player:IsAttached() or player:IsDeadNoStatPool()
        or Game.GetSystemRequestsHandler():IsPreGame() then return false end
    local journal = Game.GetJournalManager()
    return journal ~= nil and not journal:HasAnyDelayedStateChanges()
end
local function nativeFact(name)
    return Game.GetQuestsSystem():GetFactStr(name)
end
local function journalState(journal, entry)
    local state = journal:GetEntryState(entry)
    for native, normalized in pairs(STATES) do
        if state == Enum.new('gameJournalEntryState', native) then return normalized end
    end
    return nil
end
local function nativeJournal(key, selector, depthLimit)
    local journal = Game.GetJournalManager()
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
                return {value = value, revealed = true, isQuest = false, nativeHash = string.format('%.0f', actualHash)}
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
            return {value = value, revealed = true, isQuest = isQuest, nativeHash = string.format('%.0f', actualHash)}
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
    if selected and not list(selected, 512, identifier) then return nil, 'invalid-selection' end
    local keys = selected and clone(selected) or {}
    if not selected then
        if count > 512 then return nil, 'selection-required' end
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
        readLifepath = adapter.readLifepath or nativeLifepath},
        currentGeneration = options.currentGeneration, currentWorldToken = options.currentWorldToken,
        now = options.now or os.time, cpuNow = options.cpuNow or os.clock,
        utcNow = options.utcNow or function() return os.date('!%Y-%m-%dT%H:%M:%SZ') end,
        batchSize = math.floor(bounded(options.batchSize, 32, 1, 128)),
        budgetSeconds = bounded(options.budgetSeconds, 0.002, 0.0001, 0.01),
        maxAgeSeconds = bounded(options.maxAgeSeconds, 3, 0.25, 5),
        refreshSeconds = bounded(options.refreshSeconds, 0.25, 0, 2),
        journalDepth = math.floor(bounded(options.journalDepth, 12, 1, 16)),
        serial = 0, reason = 'not-configured'}, Collector)
end

function Collector:reset(generation, reason, worldToken)
    self.generation = integer(generation, 0, MAX_SAFE) and generation or nil
    self.worldToken = identifier(worldToken) and worldToken or nil
    self.cache, self.job, self.lastNow, self.nextRefresh = nil, nil, nil, nil
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
            facts = {}, journal = {}, active = {}, lifepath = unknown('lifepath-unavailable')}
    end
    local job, total = self.job, #self.config.facts + #self.config.journal + 1
    local cpuOk, started = pcall(self.cpuNow)
    local processed = 0
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
            local ok, observation = pcall(self.adapter.readJournal, row.key, clone(row), self.journalDepth)
            if ok and plain(observation) and observation.revealed == true
                and (observation.value == 'active' or observation.value == 'succeeded' or observation.value == 'failed') then
                local refs = evidence(job, 'journal', index - #self.config.facts)
                if unsignedHash(observation.nativeHash) then refs[#refs + 1] = 'journal-hash:' .. string.format('%.0f', unsignedHash(observation.nativeHash)) end
                job.journal[row.key] = {status = 'known', value = observation.value, revealed = true, questKey = row.questKey,
                    sourceId = 'native-journal-manager', evidenceRefs = refs}
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
        self.cache = {generation = generation, started = job.started, capturedAt = stamp,
            facts = job.facts, journal = job.journal, activeQuestKeys = active, lifepath = job.lifepath}
        self.job, self.nextRefresh, self.reason = nil, now + self.refreshSeconds, nil
    end
    return self:progress()
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
    -- Omit an empty list: CET's JSON codec can serialize an empty Lua table as
    -- {}, whereas the bridge correctly requires arrays when the field exists.
    if #self.cache.activeQuestKeys > 0 then result.activeQuestKeys = clone(self.cache.activeQuestKeys) end
    if jsonBytes(result) > 256 * 1024 - 512 then return unavailable('snapshot-byte-limit') end
    return result
end

function Collector:begin(pack, context)
    local ok, why = self:configure(pack, context)
    if not ok then return unavailable(why) end
    return self:update(context)
end

M.nativeAdapter = {isReady = nativeReady, readFact = nativeFact, readJournal = nativeJournal, readLifepath = nativeLifepath}
return M
