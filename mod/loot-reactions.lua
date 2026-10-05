-- Pure policy for confirmed world acquisitions. The adapter proves provenance,
-- deduplicates native callbacks into acquisitionId, and owns native playback.
-- Times passed in are seconds; reaction.expiresAt is milliseconds on the wire.
local M = {}
local LIMIT = {
    quiet = 6, ordinary = 600, exceptional = 120, pending = 90,
    admission = 30, playback = 30, distance = 20,
    receipts = 128, descriptions = 12, witnesses = 16, tokens = 8,
    seen = 1024, seenSeconds = 180, quantity = 1000000, descriptionChars = 320,
}
local QUALITIES = {Common = true, CommonPlus = true, Uncommon = true, UncommonPlus = true,
    Rare = true, RarePlus = true, Epic = true, EpicPlus = true, Iconic = true,
    Legendary = true, LegendaryPlus = true, LegendaryPlusPlus = true}
local LEGENDARY = {Legendary = true, LegendaryPlus = true, LegendaryPlusPlus = true}
local EQUIPMENT = {Weapon = true, Clothing = true, Cyberware = true}

local function copy(value)
    if type(value) ~= 'table' then return value end
    local result = {}; for key, item in pairs(value) do result[key] = copy(item) end
    return result
end

local function finite(value)
    return type(value) == 'number' and value == value and value > -math.huge and value < math.huge
end

local function text(value, maximum)
    if type(value) ~= 'string' or #value > maximum or not value:find('%S') or value:find('%c') then return nil end
    return value
end

local function identifier(value, maximum)
    return text(value, maximum) and value:match('^[%w_%.:%-]+$') and value or nil
end

local function witnessKey(entity, profileKey)
    -- Both identifiers exclude this separator.
    return entity .. '|' .. profileKey
end

local function peopleSnapshot(people)
    local result, seen = {}, {}
    -- Never retain NPC/native references, and never traverse an unbounded input.
    for index, person in ipairs(type(people) == 'table' and people or {}) do
        if index > 64 then break end
        if type(person) == 'table' then
            local entity, profile = identifier(person.entity, 128), identifier(person.profileKey, 128)
            if entity and profile and finite(person.distance) and person.distance >= 0 and person.distance <= LIMIT.distance then
                local key = witnessKey(entity, profile)
                if not seen[key] then
                    seen[key] = true
                    result[#result + 1] = {entity = entity, profileKey = profile, distance = person.distance,
                        available = person.available ~= false, voiceBusy = person.voiceBusy == true,
                        availableReason = text(person.availableReason, 96), name = text(person.name, 240),
                        bodyType = text(person.bodyType, 96)}
                end
            end
        end
    end
    table.sort(result, function(a, b)
        if a.distance ~= b.distance then return a.distance < b.distance end
        return witnessKey(a.entity, a.profileKey) < witnessKey(b.entity, b.profileKey)
    end)
    while #result > LIMIT.witnesses do table.remove(result) end
    return result
end

local function normalize(item)
    if type(item) ~= 'table' or item.source ~= 'world' or item.confirmed ~= true then return nil, 'unconfirmed-source' end
    local acquisition = identifier(item.acquisitionId, 200)
    local identity, record, name = text(item.identity, 240), text(item.record, 240), text(item.name, 240)
    if not acquisition or not identity or not record or not name then return nil, 'invalid-identity' end
    if not finite(item.quantity) or item.quantity < 1 or item.quantity % 1 ~= 0 or item.quantity > LIMIT.quantity then
        return nil, 'invalid-quantity'
    end
    if not QUALITIES[item.quality] or not identifier(item.category, 64) or type(item.newlyAcquired) ~= 'boolean' then
        return nil, 'unverified-classification'
    end
    -- Optional descriptive type; an invalid one is dropped, not a rejection.
    local itemType = item.itemType ~= nil and identifier(item.itemType, 48) or nil
    -- Optional tooltip text, bounded for the prompt. Anything else is dropped.
    local description = item.description ~= nil and text(item.description, LIMIT.descriptionChars) or nil
    return {acquisitionId = acquisition, identity = identity, record = record, name = name,
        quantity = item.quantity, quality = item.quality, category = item.category,
        itemType = itemType, description = description, newlyAcquired = item.newlyAcquired,
        exceptional = item.newlyAcquired and LEGENDARY[item.quality] == true
            and EQUIPMENT[item.category] == true}
end

function M.new()
    local self = {}
    local epoch, serial, sequence, clock, wall, combatSerial = 0, 0, 0, 0, 0, 0
    local pending, seen, seenOrder, tokens, people = {}, {}, {}, {}, {}
    local sample, enabled, active, lastActivity, lastSpeaker
    local ordinaryUntil, exceptionalUntil, rejected, expired = 0, 0, 0, 0

    local function time(now)
        if finite(now) then wall = math.max(wall, now) end
        return wall
    end

    local function gate()
        if not enabled then return 'setting-disabled' end
        if not sample or not sample.available then return 'observation-unavailable' end
        if sample.blocked then return 'scene-blocked' end
        return nil
    end

    local function discard()
        pending, tokens, active, lastActivity = {}, {}, nil, nil
    end

    local function prune(now)
        while seenOrder[1] and now - seenOrder[1].at > LIMIT.seenSeconds do
            local entry = table.remove(seenOrder, 1)
            seen[entry.id] = nil
        end
        if lastActivity and now - lastActivity.wall > LIMIT.pending then
            expired = expired + #pending
            pending, tokens, lastActivity = {}, {}, nil
        end
        for batch, token in pairs(tokens) do
            if now * 1000 > token.expiresAt then tokens[batch] = nil end
        end
        -- A timely admitted line can finish after admission closes, but its
        -- local owner cannot survive forever when a caller forgets release().
        if active and now * 1000 > active.expiresAt + LIMIT.playback * 1000 then active = nil end
    end

    local function quiet()
        return lastActivity and math.max(0, clock - lastActivity.clock) or 0
    end

    local function currentPerson(entity, profile)
        for _, person in ipairs(people) do
            if person.entity == entity and person.profileKey == profile then return person end
        end
        return nil
    end

    local function describe(key)
        local items, indices, exceptional = {}, {}, false
        for _, receipt in ipairs(pending) do
            if not key or receipt.witnesses[key] then
                -- Stable game identities are kept locally. Aggregate equal
                -- descriptions, retaining rare equipment ahead of truncation.
                local item = receipt.item
                local group = table.concat({item.record, item.quality, item.category,
                    item.name, tostring(item.newlyAcquired)}, '\0')
                local row = indices[group]
                if row then row.quantity = math.min(LIMIT.quantity, row.quantity + item.quantity)
                else
                    row = {record = item.record, name = item.name, quantity = item.quantity,
                        quality = item.quality, category = item.category, itemType = item.itemType,
                        description = item.description, newlyAcquired = item.newlyAcquired,
                        exceptional = item.exceptional, sequence = receipt.sequence}
                    indices[group] = row; items[#items + 1] = row
                end
                exceptional = exceptional or item.exceptional
            end
        end
        table.sort(items, function(a, b)
            if a.exceptional ~= b.exceptional then return a.exceptional end
            return a.sequence < b.sequence
        end)
        while #items > LIMIT.descriptions do table.remove(items) end
        for _, item in ipairs(items) do item.exceptional, item.sequence = nil, nil end
        return items, exceptional
    end

    local function tokenCount()
        local count = 0; for _ in pairs(tokens) do count = count + 1 end
        return count
    end

    local function snapshotFor(person, purpose, now)
        if #pending == 0 then return nil, 'empty' end
        local key = witnessKey(person.entity, person.profileKey)
        local items, exceptional = describe(key)
        if #items == 0 then return nil, 'not-witnessed' end
        local first, cutoff = pending[1].sequence, pending[#pending].sequence
        for _, token in pairs(tokens) do
            if token.first == first and token.cutoff == cutoff and token.key == key and token.purpose == purpose then
                return copy(token.snapshot), token
            end
        end
        if tokenCount() >= LIMIT.tokens then return nil, 'snapshot-capacity' end
        serial = serial + 1
        local batch = 'loot-' .. epoch .. '-' .. serial
        local snapshot = {version = 1, status = 'pending', batch = batch,
            ageSeconds = math.max(0, math.floor(now - pending[1].wall)), quietSeconds = quiet(),
            exceptional = exceptional, items = items,
            witness = {entity = person.entity, profileKey = person.profileKey}}
        local token = {snapshot = snapshot, key = key, first = first, cutoff = cutoff,
            epoch = epoch, combat = combatSerial, purpose = purpose,
            expiresAt = math.floor(math.min(now + LIMIT.admission, lastActivity.wall + LIMIT.pending) * 1000)}
        tokens[batch] = token
        return copy(snapshot), token
    end

    local function validateToken(snapshot, purpose, now)
        if type(snapshot) ~= 'table' then return nil, 'snapshot-missing' end
        local token = tokens[snapshot.batch]
        if not token or token.epoch ~= epoch or token.purpose ~= purpose then return nil, 'snapshot-not-owned' end
        if now * 1000 > token.expiresAt then return nil, 'snapshot-expired' end
        if token.combat ~= combatSerial then return nil, 'combat-resumed' end
        if not pending[1] or pending[1].sequence ~= token.first then return nil, 'prefix-consumed' end
        local person = currentPerson(token.snapshot.witness.entity, token.snapshot.witness.profileKey)
        if not person then return nil, 'witness-missing' end
        if not person.available then return nil, 'witness-unavailable' end
        return token
    end

    local function retire(token)
        local remaining = {}
        for _, receipt in ipairs(pending) do
            if receipt.sequence > token.cutoff then remaining[#remaining + 1] = receipt end
        end
        pending = remaining
        -- All snapshots sharing this prefix are now stale. New receipts have
        -- larger sequences even if they describe the exact same game item.
        for batch, other in pairs(tokens) do
            if other.first <= token.cutoff then tokens[batch] = nil end
        end
        if #pending == 0 then lastActivity = nil end
    end

    local function cooldownAllows(exceptional, now)
        if now >= ordinaryUntil then return true end
        return exceptional and now >= exceptionalUntil
    end

    function self.reset()
        epoch, serial, sequence, clock, wall, combatSerial = epoch + 1, 0, 0, 0, 0, 0
        pending, seen, seenOrder, tokens, people = {}, {}, {}, {}, {}
        sample, enabled, active, lastActivity, lastSpeaker = nil, false, nil, nil, nil
        ordinaryUntil, exceptionalUntil, rejected, expired = 0, 0, 0, 0
    end

    -- An unavailable/blocked/disabled update discards, rather than defers,
    -- automatic work. Pausing only freezes the six-second gameplay window.
    function self.update(observation, delta, now, allow, nearby)
        now = time(now)
        local wasCombat = sample and sample.combat
        sample = type(observation) == 'table' and {available = observation.available == true,
            blocked = observation.blocked == true, paused = observation.paused == true,
            combat = observation.combat == true,
            reason = text(observation.reason, 96)} or nil
        enabled, people = allow == true, peopleSnapshot(nearby)
        if sample and sample.combat and not wasCombat then
            combatSerial = combatSerial + 1
            -- A new fight interrupts old pending automatic pickup work. The
            -- fight's new acquisitions remain a separate pickup turn later.
            discard()
        end
        if gate() then discard()
        elseif not sample.paused then
            clock = clock + math.max(0, math.min(5, finite(delta) and delta or 0))
        end
        prune(now)
    end

    function self.acquire(item, nearby, now)
        now = time(now); prune(now)
        local normalized, reason = normalize(item)
        if not normalized then rejected = rejected + 1; return false, reason end
        if seen[normalized.acquisitionId] then return false, 'duplicate' end
        if #seenOrder >= LIMIT.seen then rejected = rejected + 1; return false, 'receipt-cache-full' end
        seen[normalized.acquisitionId] = true
        seenOrder[#seenOrder + 1] = {id = normalized.acquisitionId, at = now}
        -- Remember suppressed receipts too: enabling the setting or leaving
        -- a scene must not turn a retried callback into retrospective loot.
        reason = gate()
        if reason then rejected = rejected + 1; return false, reason end
        if #pending >= LIMIT.receipts then rejected = rejected + 1; return false, 'batch-full' end
        local witnesses, count = {}, 0
        for _, person in ipairs(peopleSnapshot(nearby)) do
            witnesses[witnessKey(person.entity, person.profileKey)] = true
            count = count + 1
        end
        if count == 0 then rejected = rejected + 1; return false, 'no-witness' end
        sequence = sequence + 1
        pending[#pending + 1] = {item = normalized, witnesses = witnesses, sequence = sequence, wall = now}
        lastActivity = {clock = clock, wall = now}
        return true
    end

    -- Without options this is a detached diagnostic view. A named reaction
    -- snapshot belongs only to the pickup's exact witness and standalone turn.
    function self.capture(options, now)
        now = time(now); prune(now)
        local reason = gate()
        if type(options) == 'table' and options.forBattle then return nil, 'separate-reactions' end
        if type(options) ~= 'table' or not options.forReaction then
            local items, exceptional = describe()
            return {version = 1, status = reason and 'suppressed' or (#pending > 0 and 'pending' or 'none'),
                reason = reason, items = items, exceptional = exceptional, quietSeconds = quiet(),
                ageSeconds = pending[1] and math.max(0, math.floor(now - pending[1].wall)) or 0}
        end
        if reason then return nil, reason end
        if sample.paused then return nil, 'paused' end
        if active then return nil, 'reaction-active' end
        local person = currentPerson(options.entity, options.profileKey)
        if not person then return nil, 'witness-missing' end
        if not person.available then return nil, 'witness-unavailable' end
        local snapshot, token = snapshotFor(person, 'standalone', now)
        if snapshot then return snapshot end
        return nil, token
    end

    function self.offer(busy, nearby, now)
        now = time(now); prune(now)
        people = peopleSnapshot(nearby)
        if busy or active or gate() or sample.paused or sample.combat
            or #pending == 0 or quiet() < LIMIT.quiet then return nil end
        local chosen, profiles = nil, {}
        for _, person in ipairs(people) do
            if person.available and not profiles[person.profileKey] then
                local items, exceptional = describe(witnessKey(person.entity, person.profileKey))
                if #items > 0 and cooldownAllows(exceptional, now) then
                    profiles[person.profileKey] = true
                    chosen = chosen or person
                    if person.profileKey ~= lastSpeaker then chosen = person; break end
                end
            end
        end
        if not chosen then return nil end
        local snapshot, token = snapshotFor(chosen, 'standalone', now)
        if not snapshot then return nil end
        return {reaction = {kind = 'loot', batch = snapshot.batch, expiresAt = token.expiresAt},
            loot = snapshot, person = copy(chosen)}
    end

    function self.claim(event, now)
        now = time(now); prune(now)
        local reason = gate()
        if reason then return false, reason end
        if sample.paused or sample.combat then return false, 'world-busy' end
        if active then return false, 'reaction-active' end
        if type(event) ~= 'table' or type(event.reaction) ~= 'table' or event.reaction.kind ~= 'loot'
            or type(event.loot) ~= 'table' or event.reaction.batch ~= event.loot.batch then return false, 'event-invalid' end
        local token; token, reason = validateToken(event.loot, 'standalone', now)
        if not token then return false, reason end
        if event.reaction.expiresAt ~= token.expiresAt then return false, 'deadline-changed' end
        if type(event.person) ~= 'table' or event.person.entity ~= token.snapshot.witness.entity
            or event.person.profileKey ~= token.snapshot.witness.profileKey then return false, 'speaker-changed' end
        if not cooldownAllows(token.snapshot.exceptional, now) then return false, 'cooldown' end
        -- A pickup arriving after prepare returns the batch to collecting;
        -- prepared manual/automatic races must not bypass the quiet window.
        if quiet() < LIMIT.quiet then return false, 'collecting' end
        retire(token)
        active = token
        active.claimedAt = now
        ordinaryUntil = now + LIMIT.ordinary
        if token.snapshot.exceptional then exceptionalUntil = now + LIMIT.exceptional end
        lastSpeaker = token.snapshot.witness.profileKey
        return true, copy(token.snapshot)
    end

    -- A battle closing that is about to be requested may carry this witness's
    -- pending pickups in the same reply. These three calls are the whole
    -- contract: mergeable() is side-effect free and says whether the exact
    -- witness copy has pickups that may speak under the cooldowns (and whether
    -- collection is still going on); attach() freezes them in a snapshot; and
    -- claimMerged() consumes them and starts the cooldowns, exactly as a
    -- standalone pickup turn would. The closing's own policy owns validity,
    -- cancellation and playback, so no loot reaction becomes active.
    local function mergePerson(person, now)
        if type(person) ~= 'table' or gate() or sample.paused or sample.combat or active
            or #pending == 0 then return nil, 'unavailable' end
        local entity, profile = identifier(person.entity, 128), identifier(person.profileKey, 128)
        if not entity or not profile then return nil, 'invalid-person' end
        local current = currentPerson(entity, profile)
        if not current then return nil, 'witness-missing' end
        if not current.available then return nil, 'witness-unavailable' end
        return current
    end

    function self.mergeable(person, now)
        now = time(now); prune(now)
        local current = mergePerson(person, now)
        if not current then return nil end
        local items, exceptional = describe(witnessKey(current.entity, current.profileKey))
        if #items == 0 or not cooldownAllows(exceptional, now) then return nil end
        return {items = #items, exceptional = exceptional, quietSeconds = quiet(),
            collecting = quiet() < LIMIT.quiet}
    end

    function self.attach(person, now)
        now = time(now); prune(now)
        local current, reason = mergePerson(person, now)
        if not current then return nil, reason end
        local snapshot, token = snapshotFor(current, 'merge', now)
        if not snapshot then return nil, token end
        if not cooldownAllows(snapshot.exceptional, now) then return nil, 'cooldown' end
        return snapshot
    end

    function self.claimMerged(event, now)
        now = time(now); prune(now)
        local reason = gate()
        if reason then return false, reason end
        if sample.paused or sample.combat then return false, 'world-busy' end
        if active then return false, 'reaction-active' end
        if type(event) ~= 'table' or type(event.loot) ~= 'table' then return false, 'event-invalid' end
        local token; token, reason = validateToken(event.loot, 'merge', now)
        if not token then return false, reason end
        if type(event.person) ~= 'table' or event.person.entity ~= token.snapshot.witness.entity
            or event.person.profileKey ~= token.snapshot.witness.profileKey then return false, 'speaker-changed' end
        if not cooldownAllows(token.snapshot.exceptional, now) then return false, 'cooldown' end
        retire(token)
        ordinaryUntil = now + LIMIT.ordinary
        if token.snapshot.exceptional then exceptionalUntil = now + LIMIT.exceptional end
        lastSpeaker = token.snapshot.witness.profileKey
        return true, copy(token.snapshot)
    end

    function self.valid(reaction, now, playbackAt)
        now = time(now); prune(now)
        local reason = gate()
        if reason then return false, reason end
        if type(reaction) ~= 'table' or reaction.kind ~= 'loot' or not active
            or reaction.batch ~= active.snapshot.batch then return false, 'reaction-not-owned' end
        if sample.paused then return false, 'paused' end
        if sample.combat or active.combat ~= combatSerial then return false, 'combat-resumed' end
        local playing = finite(playbackAt) and playbackAt * 1000 <= active.expiresAt
            and playbackAt >= active.claimedAt and now >= playbackAt and now - playbackAt <= LIMIT.playback
        if not playing and now * 1000 > active.expiresAt then
            return false, finite(playbackAt) and now - playbackAt > LIMIT.playback
                and 'playback-window-expired' or 'admission-expired'
        end
        local person = currentPerson(active.snapshot.witness.entity, active.snapshot.witness.profileKey)
        if not person then return false, 'witness-missing' end
        if not person.available then
            if person.voiceBusy and not playing then return true, 'speaker-waiting' end
            return false, 'witness-unavailable'
        end
        return true, 'valid'
    end

    function self.release(reaction)
        if type(reaction) ~= 'table' or reaction.kind ~= 'loot' or not active
            or reaction.batch ~= active.snapshot.batch then return false end
        active = nil; return true
    end

    function self.status()
        return {clock = clock, enabled = enabled, suppressed = gate(),
            pending = #pending, descriptions = #describe(), quietSeconds = quiet(),
            collecting = #pending > 0 and quiet() < LIMIT.quiet,
            lastActivityAge = lastActivity and math.max(0, wall - lastActivity.wall),
            pendingUntil = lastActivity and lastActivity.wall + LIMIT.pending,
            combat = sample and sample.combat or false, paused = sample and sample.paused or false,
            cooldownUntil = ordinaryUntil, exceptionalCooldownUntil = exceptionalUntil,
            snapshots = tokenCount(), rememberedReceipts = #seenOrder,
            active = active and active.snapshot.batch, rejected = rejected, expired = expired,
            limits = copy(LIMIT)}
    end

    self.reset()
    return self
end
return M
