-- A local transcript belongs to a user/campaign/branch. Unknown identity is
-- session-only; a contact name cannot identify a save or authorize old memory.
local M = {serial = 0, tick = 0, history = {}, drafts = {}, catalog = {}}
local function copy(value)
    if type(value) ~= 'table' then return value end
    local result = {}; for key, item in pairs(value) do result[key] = copy(item) end
    return result
end
local function integer(value, minimum)
    return type(value) == 'number' and value == math.floor(value) and value >= (minimum or 0) and value <= 2147483647
end
local function nativeID(value)
    return type(value) == 'string' and #value == 32 and value:match('^[a-f0-9]+$') ~= nil
end
local function userID(value)
    return type(value) == 'string' and #value > 0 and #value <= 128 and value:match('^[A-Za-z0-9][A-Za-z0-9_%-]*$') ~= nil
end
local function binding(value)
    value = type(value) == 'table' and value or {}
    local unknown = {version=1,status='unavailable',authoritative=false}
    if integer(value.generation, 1) then unknown.generation = value.generation end
    if value.version ~= 1 or value.status ~= 'available' or value.authoritative ~= true
        or (value.confidence ~= 'native-live' and value.confidence ~= 'native-restored') or not userID(value.localUserId)
        or not nativeID(value.campaignId) or not nativeID(value.branchId) or not nativeID(value.activationId)
        or not integer(value.branchEpoch, 1) or not integer(value.ledgerSequence) or not integer(value.generation, 1) then return unknown end
    return {version=1,status='available',authoritative=true,confidence=value.confidence,
        localUserId=value.localUserId,campaignId=value.campaignId,branchId=value.branchId,
        branchEpoch=value.branchEpoch,ledgerSequence=value.ledgerSequence,generation=value.generation,activationId=value.activationId}
end
local function scope(value)
    if value.status == 'available' then return 'phone-v1:'..value.localUserId..':'..value.campaignId..':'..value.branchId end
end
local function bindingKey(value)
    local key = scope(value)
    return key and key..':'..value.branchEpoch..':'..value.generation..':'..value.activationId or 'session:'..tostring(value.generation or 0)
end
local function capture(callback, ...)
    if type(callback) ~= 'function' then return nil end
    local ok, value = pcall(callback, ...)
    if not ok or type(value) ~= 'table' then return nil end
    local encoded, text = pcall(json.encode, value)
    if not encoded or #text > 262144 then return nil end
    local decoded, plain = pcall(json.decode, text)
    return decoded and type(plain) == 'table' and plain or nil
end
local function read(path)
    local f = io.open(path, 'rb'); if not f then return nil end
    local raw = f:read('*a'); f:close()
    local ok, value = pcall(json.decode, raw)
    return ok and type(value) == 'table' and value or nil, raw
end
local function write(path, value)
    local encoded, text = pcall(json.encode, value); if not encoded then return false end
    local f = io.open(path .. '.tmp', 'wb'); if not f then return false end
    local ok = pcall(function() f:write(text); f:close() end); if not ok then pcall(function() f:close() end); return false end
    if os.rename(path .. '.tmp', path) then return true end
    -- Windows cannot always replace an existing file with rename. Keep the old
    -- complete document until its replacement has actually been moved in.
    local previous = path .. '.previous'
    os.remove(previous)
    if not os.rename(path, previous) then return false end
    if os.rename(path .. '.tmp', path) then os.remove(previous); return true end
    os.rename(previous, path); return false
end
local function save()
    if not M.store then return end
    if M.bucket then M.bucket.history, M.bucket.drafts, M.bucket.launch = M.history, M.drafts, M.launch end
    return write('runtime/phone-history.json', M.store)
end
local function append(contact, text, sent)
    local rows = M.history[contact] or {}; M.history[contact] = rows
    rows[#rows + 1] = {text = text, sent = sent}
    M.dirty = true; save()
end
local function publish(active)
    return write('runtime/phone-chat-input.json', {version = 2, world = M.world, active = active,
        saveIdentity = M.saveIdentity, updated = os.time() * 1000, request = M.pending})
end
function M.configure(profiles, manager, options)
    local supported = {}; for _, p in ipairs(profiles) do supported[p.key] = true end
    for _, c in ipairs(read('phone-contacts.json') or {}) do
        if c.key and supported[c.key] then M.catalog[c.contact] = c.key end
    end
    M.manager = manager
    options = options or {}
    M.captureBinding = options.captureBinding or M.captureBinding
    M.captureWorldKnowledge = options.captureWorldKnowledge or M.captureWorldKnowledge
    M.captureJournalHistory = options.captureJournalHistory or M.captureJournalHistory
    M.onDelivered = options.onDelivered or M.onDelivered
    local stored, raw = read('runtime/phone-history.json')
    local legacy = stored or (raw and {unparsed=raw}) or {}
    stored = stored or {}
    if stored.version == 3 and type(stored.buckets) == 'table' then M.store = stored
    else M.store = {version=3,buckets={},legacy={copy(legacy)},launchPolicies={}} end
    M.store.launchPolicies = M.store.launchPolicies or {}
    M.store.legacy = M.store.legacy or {}
    M.disappearOnLaunch = manager.disappearingMessages and manager.disappearingMessages() or false
    M.captureDrafts = false
end

local function selectBucket(value)
    local key = scope(value) or 'session:'..M.world
    local stored = M.store.buckets[key]
    if type(stored) ~= 'table' or not scope(value) or scope(binding(stored.identity)) ~= scope(value) then
        if stored then M.store.legacy[#M.store.legacy+1] = {reason='scope-conflict',scope=key,data=copy(stored)} end
        stored = {identity=copy(value),history={},drafts={},sessionOnly=scope(value) == nil}
        M.store.buckets[key] = stored
    end
    M.scope, M.bucket, M.history, M.drafts, M.launch = key, stored, {}, {}, stored.launch
    for contact, rows in pairs(type(stored.history) == 'table' and stored.history or {}) do
        if type(rows) == 'table' then
            M.history[contact] = {}
            -- The transcript is user history. Retention is controlled by the
            -- explicit disappearing-messages policy, never a silent row cap.
            for i = 1, #rows do
                local row = rows[i]
                if type(row) == 'table' and type(row.text) == 'string' and #row.text <= 6000 then
                    table.insert(M.history[contact], {text = row.text, sent = row.sent == true})
                end
            end
        end
    end
    for contact, draft in pairs(type(stored.drafts) == 'table' and stored.drafts or {}) do
        if type(draft) == 'string' and #draft <= 4800 then M.drafts[contact] = draft end
    end
end

local function identifyLaunch()
    if M.launchResolved then return true end
    local identity = read('runtime/phone-game-launch.json')
    if not identity or identity.world ~= M.world or type(identity.launch) ~= 'string'
        or not identity.launch:match('^%d+%-%d+$') then return not M.disappearOnLaunch end
    local policy = M.store.launchPolicies[identity.launch]
    if type(policy) ~= 'boolean' then policy = M.disappearOnLaunch; M.store.launchPolicies[identity.launch] = policy end
    if policy and identity.launch ~= M.launch then
        M.history, M.drafts, M.errors = {}, {}, {}
    end
    M.launch, M.launchResolved, M.dirty, M.lastPaint = identity.launch, true, true, nil
    save()
    return true
end
function M.abandon()
    if M.world then publish(false) end
    if M.pending then
        if (M.drafts[M.pending.contact] or '') == '' then M.drafts[M.pending.contact] = M.pending.text end
        M.errors = {[M.pending.contact] = 'Conversation interrupted. Your message is in the draft.'}
    end
    save()
    M.world, M.pending, M.contact, M.lastPaint, M.lastHeartbeat, M.registered = nil, nil, nil, nil, nil, nil
    M.saveIdentity, M.bindingKey, M.bucket, M.scope, M.launchResolved, M.captureDrafts = nil, nil, nil, nil, nil, false
    M.history, M.drafts, M.errors = {}, {}, {}
end
function M.update(player, delta)
    local currentBinding = binding(capture(M.captureBinding, player))
    local currentKey = bindingKey(currentBinding)
    local changed = not M.world or currentKey ~= M.bindingKey
    if changed then
        if M.world then M.abandon() end
        M.world = tostring(os.time()) .. '-' .. tostring(math.random(100000000, 999999999))
        M.saveIdentity, M.bindingKey = currentBinding, currentKey
        selectBucket(currentBinding)
        M.dirty, M.lastPaint, M.captureDrafts, M.justBound = true, nil, false, true
        save(); publish(true)
    else
        M.saveIdentity = currentBinding
    end
    -- Menus can stop game time; frames still arrive. Do not wait for a nonzero delta.
    M.tick = M.tick + math.max(tonumber(delta) or 0, 1 / 60)
    if M.tick < 0.10 then return end
    M.tick = 0
    local supported, contact = pcall(function() return player:ConvaiPhoneChatContact() end)
    if not supported then return end -- staged Lua remains safe before native install
    player:ConvaiPhoneChatTick()
    if not M.registered then
        player:ConvaiPhoneChatClearContacts()
        for id in pairs(M.catalog) do player:ConvaiPhoneChatRegisterContact(id) end
        M.registered = true
    end
    contact = tostring(contact or '')
    local historyReady = identifyLaunch()
    local draft = player:ConvaiPhoneChatDraft()
    -- Native stores the last draft before its controller is destroyed or recycled.
    if M.captureDrafts and draft and M.catalog[draft.contact] and M.drafts[draft.contact] ~= draft.text then
        M.drafts[draft.contact] = draft.text; M.saveDraft = true
    end
    if contact ~= M.contact then M.contact = contact; M.dirty = true end
    local submission = player:ConvaiPhoneChatTakeSubmission()
    if submission and not M.justBound then
        local key = M.catalog[submission.contact]
        local text = tostring(submission.text or ''):match('^%s*(.-)%s*$')
        M.errors = M.errors or {}
        if not historyReady then
            M.errors[submission.contact] = 'Waiting for the conversation service.'
        elseif text == '' then
            M.errors[submission.contact] = 'Type a message first.'
        elseif not key or not M.manager.profileEnabled(key) then
            M.errors[submission.contact] = 'Conversations are disabled for this contact.'
        elseif M.pending then
            M.errors[submission.contact] = 'Wait for your previous reply before sending another message.'
        else
            M.serial = M.serial + 1
            local before = M.bindingKey
            local worldKnowledge = capture(M.captureWorldKnowledge, player, key, copy(M.saveIdentity))
            local journalHistory = capture(M.captureJournalHistory, player, key, copy(M.saveIdentity))
            local journal, battle = capture(M.captureJournal), capture(M.captureBattle)
            local confirmed = binding(capture(M.captureBinding, player))
            if bindingKey(confirmed) ~= before then
                M.abandon(); return
            end
            M.saveIdentity = confirmed
            M.pending = {id = M.world .. '-' .. M.serial, contact = submission.contact, profileKey = key, text = text,
                saveIdentity = copy(confirmed), worldKnowledge = worldKnowledge or {version=1,status='unavailable'},
                journalHistory = journalHistory, journal = journal, battle = battle}
            M.sentAt = os.time()
            M.errors[submission.contact] = nil
            if publish(true) then
                append(submission.contact, text, true)
                M.drafts[submission.contact] = ''; M.clearDraft = submission.contact
                save()
            else
                M.pending = nil
                M.errors[submission.contact] = 'Unable to send the message. Your draft has been kept.'
            end
        end
        M.dirty = true
    end
    if M.pending and M.sentAt and os.time() - M.sentAt > 45 then
        M.errors = M.errors or {}
        M.errors[M.pending.contact] = 'No reply received. Your message is in the draft; press Enter to retry.'
        if (M.drafts[M.pending.contact] or '') == '' then
            M.drafts[M.pending.contact] = M.pending.text; M.clearDraft = M.pending.contact
        end
        M.pending = nil; M.dirty = true; save(); publish(true)
    end
    if M.pending then
        local reply = read('runtime/phone-chat-output.json')
        if reply and reply.world == M.world and reply.binding == M.bindingKey
            and reply.id == M.pending.id and reply.contact == M.pending.contact then
            if reply.state == 'reply' and type(reply.text) == 'string' and #reply.text <= 6000 and reply.text:find('%S') then
                local accepted = M.pending
                append(reply.contact, reply.text, false); M.pending = nil; M.dirty = true
                -- Acceptance is owned by this exact transcript scope, even if
                -- another contact is selected. Publication alone is no receipt.
                M.deliverySequence = (M.deliverySequence or 0) + 1
                if type(M.onDelivered) == 'function' then
                    local snapshot = type(accepted.worldKnowledge) == 'table' and accepted.worldKnowledge or {}
                    local worldGeneration = integer(snapshot.generation) and snapshot.generation or accepted.saveIdentity.generation
                    local worldToken = type(snapshot.worldToken) == 'string' and #snapshot.worldToken <= 160 and snapshot.worldToken or nil
                    pcall(M.onDelivered, {version = 1, id = 'phone-' .. accepted.id,
                        sequence = M.deliverySequence, completedAt = os.time() * 1000.0,
                        source = 'phone-ui', state = 'accepted', partial = false, cancelled = false,
                        requestId = accepted.id, world = M.world, binding = M.bindingKey,
                        generation = worldGeneration, worldToken = worldToken,
                        contact = accepted.contact, profileKey = accepted.profileKey,
                        saveIdentity = copy(accepted.saveIdentity)})
                end
            elseif reply.state == 'error' then
                M.errors = M.errors or {}; M.errors[reply.contact] = tostring(reply.error)
                if (M.drafts[reply.contact] or '') == '' then
                    M.drafts[reply.contact] = M.pending.text; M.clearDraft = reply.contact
                end
                M.pending = nil; M.dirty = true; save()
            end
        end
    end
    if os.time() ~= M.lastHeartbeat then
        M.lastHeartbeat = os.time(); publish(true)
        if M.saveDraft then save(); M.saveDraft = false end
    end
    if contact ~= '' and M.dirty then
        local key = M.catalog[contact]
        local enabled = historyReady and key ~= nil and M.manager.profileEnabled(key)
        local lines = {}
        for _, row in ipairs(historyReady and M.history[contact] or {}) do
            local line = NewObject('CyberpunkConvai.ConvaiPhoneChatLine')
            line.text, line.sent = row.text, row.sent; lines[#lines + 1] = line
        end
        local waiting = M.pending and (M.pending.contact == contact and 'Message sent. Waiting for reply.' or 'Waiting for your previous message to finish.') or ''
        local status = (M.errors or {})[contact] or waiting
        if not enabled then status = key and 'Conversations are disabled in Companion Manager.' or 'Conversation is unavailable for this contact.' end
        if not historyReady then status = 'Opening chat. Waiting for the conversation service.' end
        local reset = M.lastPaint ~= contact or M.clearDraft == contact
        player:ConvaiPhoneChatPresent(contact, lines, status, historyReady and (M.drafts[contact] or '') or '', enabled, M.pending ~= nil, reset)
        if historyReady then M.captureDrafts = true end
        M.lastPaint, M.dirty, M.clearDraft = contact, false, nil
    end
    M.justBound = false
end
return M
