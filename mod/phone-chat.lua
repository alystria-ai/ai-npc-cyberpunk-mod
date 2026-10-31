-- Display history and provider delivery have separate ownership. The current
-- single-player policy retains local transcripts across saves; world/generation
-- guards still prevent a delayed reply from crossing a load or memory reset.
local M = {serial = 0, tick = 0, history = {}, drafts = {}, catalog = {}, names = {}, groups = {}}
-- Favorites (mod/favorites.lua) are read through its global, so no function here gains an upvalue.
pcall(dofile, 'favorites.lua')
local LOCAL_HISTORY = 'phone-local-player:v1'
-- The status line when the bridge says the shared plan's daily allowance is used up (same wording as the game notice). It says when the turns come
-- back: the sign-in backend's reset (00:00 UTC) on this computer's clock (ui-locale dailyResetClock, "5:30 AM" in English); a clock that cannot be read gets
-- the UTC time itself. The status row shows the template filled in, and phone-chat-style.lua translates it from the template.
local DAILY_LIMIT_STATUS_AT = 'You’ve reached today’s Convai free tier limit. It resets at {time}. To keep talking now, choose another provider in Settings > Conversation provider. Local AI is unlimited and runs on your PC. Google Gemini works with your own key.'
-- The status row's text for a daily-limit reply, worked out when the reply arrives (never per frame).
local function dailyLimitStatus()
    local locale = convaiUiLocale
    -- The backend's reset instant is held by the UI locale whenever the manager reads the bridge's status file: read it once now so the time is current.
    if M.manager and type(M.manager.ownKey) == 'function' then pcall(M.manager.ownKey) end
    local at = type(locale) == 'table' and type(locale.dailyResetClock) == 'function' and locale.dailyResetClock() or nil
    if not at then at = (type(locale) == 'table' and type(locale.clockText) == 'function' and locale.clockText('00:00') or '00:00') .. ' UTC' end
    return (DAILY_LIMIT_STATUS_AT:gsub('{time}', function() return at end))
end
-- The same for the Mistral failures the bridge names; other failures keep the provider's text.
local MISTRAL_STATUS = {
    ['mistral-key'] = 'Mistral did not accept your key. Check it in Settings > Conversation provider.',
    ['mistral-limit'] = 'Mistral’s limit is reached for now. Try again in a moment.',
    ['mistral-model'] = 'The Mistral model is unavailable right now. Try again in a minute.',
    ['custom-key'] = 'The custom provider did not accept your key. Check it in Settings > Conversation provider.',
    ['custom-credits'] = 'The custom provider says your account is out of credits. Add credits there, then try again.',
    ['custom-model'] = 'The custom provider does not know that model ID. Check it in Settings.',
    ['custom-limit'] = 'The custom provider is rate limiting you. Try again in a moment.',
    ['custom-daily'] = 'The free daily limit for this model was reached. Try again after it resets.',
    ['custom-reasoning'] = 'This model spends its reply on thinking. Choose a non-reasoning model in Settings.',
    ['custom-unreachable'] = 'The custom provider did not answer. Check its address in Settings, or try again.',
    ['gemini-key'] = 'Google did not accept your Gemini key. Check it in Google AI Studio and add it again.',
    ['gemini-daily'] = 'Your free Gemini allowance for today is used up. It resets tomorrow. Use Convai or Local AI.',
    ['gemini-limit'] = 'Google Gemini is rate limiting you. Wait a minute, then try again.',
    ['gemini-region'] = 'Google Gemini is not available in your region. Use Convai or Local AI.',
    ['gemini-server'] = 'Google Gemini is busy right now. Try again in a moment.',
    ['gemini-unreachable'] = 'Google Gemini could not be reached. Check your internet connection, then try again.',
    ['gemini-model'] = 'The Gemini model is not available right now. Try again later or use Local AI.',
    ['local-fallback'] = 'Local AI could not start. Check Local AI in Settings > Conversation provider.',
    -- Convai's own limits, in the words of the game's notices (init.lua keyNoticeText).
    ['quota-shared'] = 'The conversation limit has been reached. Try again later, or choose Local AI or Google Gemini in Settings > Conversation provider.',
    ['quota-own'] = 'Your Convai API key has reached its plan limit. Try again later or add a different key in Settings > Conversation provider.',
    ['key-rejected'] = 'Convai did not accept your API key. Check it in Settings > Conversation provider.',
    ['key-memory-needed'] = 'Your Convai plan cannot hold the memory these conversations need. Free a memory user in your Convai account or use another key.',
    ['local-failed'] = 'Local AI could not answer that. Try again in a moment.',
    ['local-thinking'] = "Your model only thought and didn't answer. Turn thinking off for it in your model server, or pick a non-thinking model.",
    ['local-context'] = "Your model server's context is too small for this character. Raise the context length in your server (8192 or more).",
    ['local-unavailable'] = 'Local AI could not start. Check Local AI in Settings > Conversation provider.',
    ['browser-failed'] = 'The browser for the conversation page would not start. Try again, or use another Chromium browser.',
    ['local-no-memory'] = 'Not enough free graphics memory to start Local AI. Try a smaller model in Settings.',
}
-- How long a sent message waits for its reply before the draft is given back. The bridge ends a turn with its own explanation inside the
-- provider's budget (Local AI 80 s, a custom endpoint up to 120 s), so the wait is never shorter than that budget plus a margin; Convai and Mistral
-- answer or fail well inside 45 s. M.replyWait (init.lua) names the wait for the provider in use; it is asked once, when a message is sent.
local DEFAULT_REPLY_WAIT = 45
local function replyWait()
    if type(M.replyWait) ~= 'function' then return DEFAULT_REPLY_WAIT end
    local ok, seconds = pcall(M.replyWait)
    if not ok or type(seconds) ~= 'number' or seconds ~= seconds then return DEFAULT_REPLY_WAIT end
    return math.min(math.max(seconds, DEFAULT_REPLY_WAIT), 150)
end
local function copy(value)
    if type(value) ~= 'table' then return value end
    local result = {}; for key, item in pairs(value) do result[key] = copy(item) end
    return result
end
local function integer(value, minimum)
    return type(value) == 'number' and value == math.floor(value) and value >= (minimum or 0) and value <= 2147483647
end
-- The most characters one reset journal may name: the bound the bridge writes it under (bridge/chat-memory-resets.mjs, 4096). The shipped ids are
-- about 1800 with the side characters and their twins, so a lower limit here made every healthy journal unreadable and Phone Chat unable to send.
local RESET_MAX_PROFILES = 4096
local function resetInteger(value)
    return type(value) == 'number' and value == math.floor(value) and value >= 0 and value <= 9007199254740991
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
    -- Explicit local UI policy, never proof of native identity or cloud routing.
    if value.historyScope == 'local-player-v1' then unknown.historyScope = value.historyScope end
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
local function displayScope(value)
    if value.historyScope == 'local-player-v1' then return LOCAL_HISTORY end
    return scope(value)
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
-- inPlace is for an exchange file (phone-chat-input.json): the bridge ships it as an empty placeholder and
-- tolerates a partial read, so it is rewritten where it lies. Under Mod Organizer 2 a file that is deleted and
-- renamed back is a new file and lands in Overwrite. phone-history.json is player data and keeps the
-- temp + rename protection below.
local function write(path, value, inPlace)
    local encoded, text = pcall(json.encode, value); if not encoded then return false end
    if inPlace then
        local f = io.open(path, 'wb'); if not f then return false end
        local written, closed
        local ok = pcall(function() written = f:write(text); closed = f:close() end)
        return ok and written and closed and true or false
    end
    local f = io.open(path .. '.tmp', 'wb'); if not f then return false end
    local written, closed
    local ok = pcall(function() written = f:write(text); closed = f:close() end)
    if not ok or not written or not closed then
        pcall(function() f:close() end); os.remove(path .. '.tmp'); return false
    end
    -- Windows rename cannot replace an existing file, so once this session has
    -- written the file, skip the plain rename that is known to fail.
    M.replaced = M.replaced or {}
    if not M.replaced[path] and os.rename(path .. '.tmp', path) then M.replaced[path] = true; return true end
    -- Keep the old complete document until its replacement has actually been moved in.
    local previous = path .. '.previous'
    os.remove(previous)
    if not os.rename(path, previous) then
        -- The file was absent after all (for example removed by a reset).
        if os.rename(path .. '.tmp', path) then return true end
        return false
    end
    if os.rename(path .. '.tmp', path) then M.replaced[path] = true; os.remove(previous); return true end
    os.rename(previous, path); return false
end
local function save()
    if not M.store or M.storePending then return end
    if M.bucket then M.bucket.history, M.bucket.drafts, M.bucket.launch = M.history, M.drafts, M.launch end
    return write('runtime/phone-history.json', M.store)
end
-- The optional picture of a row (docs/PHONE_IMAGES.md): the .inkatlas of one picture in the optional picture archive (only the mod's own folder
-- is accepted), the name of its part, and the size in pixels. Anything else is dropped, so a hand-edited phone-history.json cannot point a row
-- at another resource. Returns a clean copy or nil.
M.IMAGE_FOLDER = 'cyberpunk_convai\\phone_images\\'
function M.cleanImage(value)
    if type(value) ~= 'table' or type(value.atlas) ~= 'string' or type(value.part) ~= 'string' then return nil end
    local key = value.atlas:match('^' .. M.IMAGE_FOLDER:gsub('%p', '%%%0') .. '([%l%d_]+)%.inkatlas$')
    if not key or #key > 48 or not value.part:match('^[%l%d_]+$') or #value.part > 48 then return nil end
    local width, height = math.floor(tonumber(value.width) or 0), math.floor(tonumber(value.height) or 0)
    if width < 1 or width > 4096 or height < 1 or height > 4096 then return nil end
    return {atlas = value.atlas, part = value.part, width = width, height = height}
end
local function append(contact, text, sent, image)
    local rows = M.history[contact] or {}; M.history[contact] = rows
    rows[#rows + 1] = {text = text, sent = sent, image = M.cleanImage(image)}
    M.dirty = true; save()
end
-- A message with a picture from a character (a scripted event, or the developer picture probe, docs/PHONE_IMAGES.md). The caption may be empty.
-- False when the contact is unknown or the picture is not one the mod's folder can hold. Nothing here runs per frame.
function M.deliverImage(contact, text, image)
    local clean = M.cleanImage(image)
    if not clean or not M.catalog[contact] or type(text) ~= 'string' or #text > 6000 then return false end
    append(contact, text, false, clean)
    return true
end
-- A fixed text a bond quest sends from a character (mod/quest-lines.lua, docs/QUEST_PRIMITIVES.md): a row of her thread, with a picture when `image` is one the
-- mod's folder can hold (anything else makes it a plain text message, never an error). False when the character has no contact, is switched off, the saved
-- chats are not loaded yet (the caller asks again) or the text is empty or too long. Nothing here runs per frame.
function M.deliverScripted(profileKey, text, image)
    if type(text) ~= 'string' or text == '' or #text > 6000 or M.bucket == nil then return false end
    local contact = M.contactFor(profileKey)
    if not contact then return false end
    if M.manager and M.manager.profileEnabled and not M.manager.profileEnabled(profileKey) then return false end
    append(contact, text, false, image)
    return true, contact
end
local function publish(active)
    -- chatContact: the contact whose Chat is open, so the bridge can open that conversation while V types
    -- (bridge/phone-warm.mjs). It never selects, sends or stores anything.
    return write('runtime/phone-chat-input.json', {version = 2, world = M.world, active = active,
        saveIdentity = M.saveIdentity, updated = os.time() * 1000, request = M.pending,
        chatContact = active and M.contact ~= nil and M.catalog[M.contact] and M.contact or nil}, true)
end
local function resetIdentity(value)
    return value.scope == 'all' and 'all' or 'character:' .. value.profileKey
end
local function resetAction(value)
    return type(value) == 'table' and type(value.id) == 'string' and #value.id > 0 and #value.id <= 256
        and value.id:match('^[A-Za-z0-9][A-Za-z0-9_.:@%-]*$') ~= nil
        and (value.scope == 'all' and value.profileKey == nil
            or value.scope == 'character' and type(value.profileKey) == 'string' and #value.profileKey > 0
                and #value.profileKey <= 80 and value.profileKey:match('^[a-z0-9][a-z0-9%-]*$') ~= nil)
end
local function actionList(values)
    if type(values) ~= 'table' or #values > 4096 then return nil end
    local result, count = {}, 0
    for key, value in pairs(values) do
        count = count + 1
        if not integer(key, 1) or key > #values or not resetAction(value) or result[value.id] then return nil end
        result[value.id] = resetIdentity(value)
    end
    return count == #values and result or nil
end
local function resetState(value)
    if type(value) ~= 'table' or value.version ~= 1 or not integer(value.revision)
        or type(value.blockAll) ~= 'boolean' or type(value.blockedProfiles) ~= 'table'
        or #value.blockedProfiles > RESET_MAX_PROFILES then return nil end
    local baseline, tracked, receipts, pending = actionList(value.baseline), actionList(value.tracked),
        actionList(value.receipts), actionList(value.pending)
    if not baseline or not tracked or not receipts or not pending then return nil end
    local known, count = {}, 0
    for id, identity in pairs(baseline) do known[id], count = identity, count + 1 end
    for id, identity in pairs(tracked) do if known[id] then return nil end; known[id], count = identity, count + 1 end
    if count > 4096 then return nil end
    for id, identity in pairs(receipts) do if tracked[id] ~= identity then return nil end end
    for id, identity in pairs(pending) do if known[id] ~= identity then return nil end end
    local blocked, rows = {}, 0
    for index, key in pairs(value.blockedProfiles) do
        rows = rows + 1
        if not integer(index, 1) or index > #value.blockedProfiles or type(key) ~= 'string'
            or #key == 0 or #key > 80 or not key:match('^[a-z0-9][a-z0-9%-]*$') or blocked[key] then return nil end
        blocked[key] = true
    end
    if rows ~= #value.blockedProfiles then return nil end
    local families = value.profileFamilies or {}
    if type(families) ~= 'table' then return nil end
    local familyCount = 0
    for key, family in pairs(families) do
        familyCount = familyCount + 1
        if familyCount > RESET_MAX_PROFILES or type(key) ~= 'string' or #key > 80 or not key:match('^[a-z0-9][a-z0-9%-]*$')
            or type(family) ~= 'string' or #family > 80 or not family:match('^[a-z0-9][a-z0-9%-]*$') then return nil end
    end
    for _, family in pairs(families) do if families[family] ~= nil and families[family] ~= family then return nil end end
    local memoryEpochs = value.memoryEpochs
    if memoryEpochs ~= nil then
        if type(memoryEpochs) ~= 'table' or memoryEpochs.version ~= 1 or not resetInteger(memoryEpochs.globalEpoch)
            or type(memoryEpochs.characterEpochs) ~= 'table' then return nil end
        local epochCount = 0
        for key, epoch in pairs(memoryEpochs.characterEpochs) do
            epochCount = epochCount + 1
            if epochCount > 2048 or type(key) ~= 'string' or #key > 80 or not key:match('^[a-z0-9][a-z0-9%-]*$')
                or not resetInteger(epoch) then return nil end
        end
    end
    local allEpoch, epochs = 0, {}
    for _, actions in ipairs({value.baseline,value.tracked}) do for _, action in ipairs(actions) do
        if action.scope == 'all' then allEpoch = allEpoch + 1
        else local family = families[action.profileKey] or action.profileKey
            epochs[family] = (epochs[family] or 0) + 1
        end
    end end
    return {revision=value.revision, receipts=value.receipts, blocked=blocked, blockAll=value.blockAll,
        families=families, globalEpoch=allEpoch, characterEpochs=epochs, memoryEpochs=memoryEpochs}
end
local function affected(contact, action)
    local previous = M.store.contactProfiles[contact]
    return action.scope == 'all' or M.catalog[contact] == action.profileKey or previous == action.profileKey
        or (previous ~= nil and M.resetState.families[previous] == action.profileKey)
end
local function erase(container, action, depth)
    if type(container) ~= 'table' or (depth or 0) > 64 then return end
    for _, field in ipairs({'history', 'drafts'}) do
        if type(container[field]) == 'table' then
            if action.scope == 'all' then container[field] = {}
            else for contact in pairs(container[field]) do if affected(contact, action) then container[field][contact] = nil end end end
        end
    end
    -- Archived structured buckets remain on disk for migration/recovery. Apply
    -- the same clear there, so recovery cannot resurrect a forgotten Chat.
    for key, value in pairs(container) do
        if key ~= 'history' and key ~= 'drafts' and type(value) == 'table' then erase(value, action, (depth or 0) + 1) end
    end
end
local function memoryResets()
    if M.resetStoreFault then return false end
    local file = io.open('runtime/memory-chat-resets.json', 'rb')
    local raw
    if file then raw = file:read('*a'); file:close() end
    if raw ~= M.resetRaw then
        local decoded, value = pcall(json.decode, raw)
        M.resetParsed = decoded and resetState(value) or nil
        M.resetRaw = raw
    end
    local state = raw ~= nil and M.resetParsed or nil
    if raw ~= nil and not state then return false end
    if state and M.resetState and state.revision < M.resetState.revision then return false end
    if state and (not M.resetState or state.revision >= M.resetState.revision) then M.resetState = state end
    if not M.resetState then return raw == nil end -- a malformed established journal fails closed
    state = M.resetState
    local blockedChanged = M.blockAll ~= state.blockAll
    for key in pairs(M.blockedProfiles or {}) do if not state.blocked[key] then blockedChanged = true end end
    for key in pairs(state.blocked) do if not (M.blockedProfiles or {})[key] then blockedChanged = true end end
    M.blockAll, M.blockedProfiles = state.blockAll, state.blocked
    local cleared = false
    local migrated, previousApplied = false, {}
    for id, applied in pairs(M.store.memoryResetsApplied) do
        local previous = applied:match('^character:([a-z0-9][a-z0-9%-]*)$')
        local family = previous and state.families[previous]
        if family and family ~= previous then
            previousApplied[id] = applied; M.store.memoryResetsApplied[id] = 'character:' .. family; migrated = true
        end
    end
    if migrated and not save() then
        for id, previous in pairs(previousApplied) do M.store.memoryResetsApplied[id] = previous end
        return false
    end
    for _, action in ipairs(state.receipts) do
        local identity, applied = resetIdentity(action), M.store.memoryResetsApplied[action.id]
        if applied and applied ~= identity then
            local previous = type(applied) == 'string' and applied:match('^character:([a-z0-9][a-z0-9%-]*)$')
            if action.scope ~= 'character' or not previous or state.families[previous] ~= action.profileKey then return false end
            -- Family migration changes the label of an old tombstone, not its
            -- action ID. Do not replay that deletion against post-clear Chat.
            M.store.memoryResetsApplied[action.id] = identity
            if not save() then M.store.memoryResetsApplied[action.id] = applied; return false end
        end
        if not applied then
            erase(M.store.buckets, action)
            if action.scope == 'all' then M.store.legacy = {} else erase(M.store.legacy, action) end
            for contact in pairs(M.history) do if affected(contact, action) then M.history[contact] = nil end end
            for contact in pairs(M.drafts) do if affected(contact, action) then M.drafts[contact] = nil end end
            for contact in pairs(M.catalog) do if affected(contact, action) then
                M.resetDrafts[contact] = true
                if M.errors then M.errors[contact] = nil end
            end end
            if M.pending and affected(M.pending.contact, action) then M.pending, M.sentAt = nil, nil; publish(true) end
            M.store.memoryResetsApplied[action.id] = identity
            if not save() then M.store.memoryResetsApplied[action.id] = nil; return false end
            cleared, M.dirty = true, true
        end
    end
    local oldReset = M.pending and M.pending.memoryReset or {version=1,globalEpoch=0,characterEpoch=0}
    local stalePending = M.pending and (oldReset.version ~= 1 or oldReset.globalEpoch ~= state.globalEpoch
        or oldReset.characterEpoch ~= (state.characterEpochs[M.pending.profileKey] or 0)
        or (oldReset.globalMemoryEpoch or 0) ~= (state.memoryEpochs and state.memoryEpochs.globalEpoch or 0)
        or (oldReset.characterMemoryEpoch or 0) ~= (state.memoryEpochs and state.memoryEpochs.characterEpochs[M.pending.profileKey] or 0))
    if M.pending and (M.blockAll or M.blockedProfiles[M.pending.profileKey] or stalePending) then
        -- Pending/uncertain resets cancel the old turn, but preserve the draft
        -- until success. A failed deletion must not erase the user's Chat.
        if (M.drafts[M.pending.contact] or '') == '' then M.drafts[M.pending.contact] = M.pending.text end
        M.resetDrafts[M.pending.contact] = true; M.clearDraft = M.pending.contact
        M.errors = M.errors or {}; M.errors[M.pending.contact] = 'Conversation interrupted. Your message is in the draft.'
        M.pending, M.sentAt, M.dirty = nil, nil, true
        save(); publish(true)
    end
    if cleared or blockedChanged then M.dirty = true end
    return true
end
-- A journal that stays unreadable is retried at the reset cadence. After resetGraceSeconds of that (default 15 s) the player may send with the
-- history the game has (nothing cleared since is known), and one log line says so. The next readable journal ends it with another line.
local RESET_GRACE_SECONDS = 15
local function refreshMemoryResets()
    local healthy = memoryResets()
    local now = os.time()
    if healthy then
        if M.resetDegraded and type(M.trace) == 'function' then pcall(M.trace, 'Saved Chat cleanup is verified again, sending is checked normally') end
        M.resetFailSince, M.resetDegraded = nil, nil
    elseif M.resetStoreFault then
        M.resetFailSince = nil -- the saved chats themselves are unsafe: waiting never opens this
    else
        if not M.resetFailSince or now < M.resetFailSince then M.resetFailSince = now end
        if now - M.resetFailSince >= (M.resetGraceSeconds or RESET_GRACE_SECONDS) then
            if not M.resetDegraded and type(M.trace) == 'function' then
                pcall(M.trace, 'Saved Chat cleanup could not be verified for ' .. tostring(now - M.resetFailSince)
                    .. ' s (reset journal unreadable or inconsistent), sending is allowed with the history the game has, still retrying')
            end
            M.resetDegraded, healthy = true, true
        end
    end
    if M.resetHealthy ~= healthy then M.dirty = true end
    M.resetHealthy = healthy
    return healthy
end
local function phoneReset(key)
    local state = M.resetState
    local result = {version=1,globalEpoch=state and state.globalEpoch or 0,
        characterEpoch=state and state.characterEpochs[key] or 0}
    if state and state.memoryEpochs then
        result.globalMemoryEpoch = state.memoryEpochs.globalEpoch
        result.characterMemoryEpoch = state.memoryEpochs.characterEpochs[key] or 0
    end
    return result
end
local function recentPhoneConversation(contact, key, reset)
    local rows, bytes, previous = {}, 0, M.history[contact] or {}
    for index = #previous, math.max(1, #previous - 5), -1 do
        local row = previous[index]
        if type(row) ~= 'table' or type(row.text) ~= 'string' or not row.text:find('%S')
            or type(row.sent) ~= 'boolean' or bytes + #row.text > 2400 then break end
        table.insert(rows, 1, {text=row.text,sent=row.sent}); bytes = bytes + #row.text
    end
    return {version=1,source='local-phone-chat',contact=contact,profileKey=key,world=M.world,
        binding=M.bindingKey,historyScope=M.scope,memoryReset=copy(reset),rows=rows}
end
-- Asked only when phone-history.json is missing or empty, never on an ordinary start. No answer (the module did not load) is "no".
local function restorePending()
    local restore = convaiStateRestore
    return restore ~= nil and restore.waiting() == true
end
-- Reads the saved chats into M.store (and what the saved reset journal and the last displayed session add to it). Run by configure and,
-- when the file was missing while the service may still have been restoring it (M.storePending, below), once more after the restore.
local function loadStore()
    local stored, raw = read('runtime/phone-history.json')
    local damaged
    if not stored then
        local recovered = read('runtime/phone-history.json.previous')
        if recovered then stored, damaged = recovered, raw end
    end
    -- Missing or empty while the service may still be restoring the copy it keeps outside the game folder (mod/state-restore.lua): the
    -- empty store below is memory only. Nothing binds to it and nothing is saved until that is over (update), then this runs again.
    M.storePending = stored == nil and (raw == nil or raw == '') and restorePending()
    local legacy = stored or (raw and {unparsed=raw}) or {}
    stored = stored or {}
    if stored.version == 3 and type(stored.buckets) == 'table' then M.store = stored
    else M.store = {version=3,buckets={},legacy={copy(legacy)}} end
    M.store.legacy = M.store.legacy or {}
    M.store.contactProfiles = M.store.contactProfiles or {}
    M.store.memoryResetsApplied = M.store.memoryResetsApplied or {}
    M.resetStoreFault = type(M.store.memoryResetsApplied) ~= 'table' or type(M.store.contactProfiles) ~= 'table'
    if not M.resetStoreFault then for contact, key in pairs(M.store.contactProfiles) do
        if type(contact) ~= 'string' or #contact == 0 or #contact > 120 or not contact:match('^[A-Za-z0-9_%-]+$')
            or type(key) ~= 'string' or #key == 0 or #key > 80 or not key:match('^[a-z0-9][a-z0-9%-]*$') then
            M.resetStoreFault = true; break
        end
    end end
    if not M.resetStoreFault then for id, value in pairs(M.store.memoryResetsApplied) do
        if type(id) ~= 'string' or #id == 0 or #id > 256 or not id:match('^[A-Za-z0-9][A-Za-z0-9_.:@%-]*$')
            or type(value) ~= 'string' or (value ~= 'all' and not value:match('^character:[a-z0-9][a-z0-9%-]*$')) then
            M.resetStoreFault = true; break
        end
    end end
    if not M.resetStoreFault then for contact, key in pairs(M.catalog) do M.store.contactProfiles[contact] = key end end
    M.resetDrafts, M.blockedProfiles, M.blockAll = {}, {}, false
    if damaged then M.store.legacy[#M.store.legacy + 1] = {reason='damaged-primary',unparsed=damaged} end
    -- Select only the exact prior displayed session for the one-time policy
    -- migration. Do not combine unrelated legacy campaign/session buckets.
    local prior = read('runtime/phone-chat-input.json')
    M.previousDisplayScope = nil
    if prior and (prior.version == 1 or prior.version == 2) and type(prior.world) == 'string'
        and #prior.world <= 100 and prior.world:match('^[A-Za-z0-9%-]+$') then
        local key = 'session:' .. prior.world
        local bucket = M.store.buckets[key]
        if type(bucket) == 'table' and bucket.sessionOnly == true
            and bindingKey(binding(bucket.identity)) == bindingKey(binding(prior.saveIdentity)) then
            M.previousDisplayScope = key
        end
    end
    M.captureDrafts = false
end
-- The saved chats were missing while the service may still have been restoring them (loadStore): nothing binds and nothing is saved until
-- that is over, then the file is read again. True when the chats can be used; asked on the 10 Hz tick only (a method of M, so update gains no upvalue).
function M.storeReady()
    if not M.storePending then return true end
    if M.tick < 0.10 then return false end
    M.tick = 0
    if restorePending() then return false end
    loadStore()
    return true
end
-- Every character with a profile is a Chat contact, not only those the game's journal knows: the shipped phone contacts keep
-- their own ids (listed from the journal), every other profile gets its key as contact id and its name (no journal row; the list
-- builds one, PhoneChatTabs.reds). A group is one source of such rows ({key, name}): the roster, the player's own characters.
-- Rebuilt on demand (load, a custom character saved), never per frame; the next 10 Hz tick registers the new list with the game.
local function rebuildContacts()
    for contact in pairs(M.names) do M.catalog[contact], M.names[contact] = nil, nil end
    M.keyNames, M.searchWordsById = {}, nil
    local mapped = {}
    for _, key in pairs(M.catalog) do mapped[key] = true end
    local ids = {}
    for group, rows in pairs(M.groups) do
        for _, row in ipairs(rows) do
            if type(row) == 'table' and type(row.key) == 'string' and #row.key <= 80 and row.key:match('^[a-z0-9][a-z0-9%-]*$') then
                ids[#ids + 1] = {key = row.key, name = type(row.name) == 'string' and row.name ~= '' and row.name or row.key}
            end
        end
    end
    table.sort(ids, function(a, b) return a.key < b.key end)
    for _, row in ipairs(ids) do
        M.keyNames[row.key] = row.name
        if not mapped[row.key] and not M.catalog[row.key] then
            mapped[row.key], M.catalog[row.key], M.names[row.key] = true, row.key, row.name
            if M.store and type(M.store.contactProfiles) == 'table' and not M.resetStoreFault then M.store.contactProfiles[row.key] = row.key end
        end
    end
    M.registered = false
end
-- A character the player made has no Convai character: its Chat answers only through Google Gemini, Local AI or Custom (docs/CHARACTER_EDITOR.md). M.contactBlocked(key) is set by
-- init.lua and asks the provider now; it is called when a Chat is painted or a message is sent, never per frame. Convai answering: the Chat is listed, closed, with this line.
local CUSTOM_NEEDS_PROVIDER = 'This character needs Google Gemini, Local AI or Custom to answer.'
local function customNeedsProvider(key)
    if type(M.contactBlocked) ~= 'function' then return false end
    local ok, blocked = pcall(M.contactBlocked, key)
    return ok and blocked == true
end
-- A Chat row the journal has no contact for, as {key, name} (its contact id is its profile key, and only such rows carry a name), or nil. Asked when
-- a holocall is started from the row (mod/holocall.lua), never per frame.
function M.callRow(contact)
    local key, name = M.catalog[contact], M.names[contact]
    if type(key) ~= 'string' or type(name) ~= 'string' or name == '' then return nil end
    return {key = key, name = name}
end
function M.setContacts(group, rows)
    M.groups[group] = type(rows) == 'table' and rows or nil
    rebuildContacts()
end
function M.configure(profiles, manager, options)
    local supported = {}; for _, p in ipairs(profiles) do supported[p.key] = true end
    for _, c in ipairs(read('phone-contacts.json') or {}) do
        if c.key and supported[c.key] then M.catalog[c.contact] = c.key end
    end
    -- Named people only: the two ambient residents are crowd stand-ins, not someone to text.
    local roster = {}
    for _, p in ipairs(profiles) do if p.kind == nil or p.kind == 'named' then roster[#roster + 1] = p end end
    M.setContacts('roster', roster)
    M.manager = manager
    options = options or {}
    M.captureBinding = options.captureBinding or M.captureBinding
    M.captureWorldKnowledge = options.captureWorldKnowledge or M.captureWorldKnowledge
    M.captureJournalHistory = options.captureJournalHistory or M.captureJournalHistory
    M.onDelivered = options.onDelivered or M.onDelivered
    loadStore()
end

local function selectBucket(value)
    local stable = displayScope(value)
    local key = stable or 'session:'..M.world
    local stored = M.store.buckets[key]
    if type(stored) ~= 'table' and key == LOCAL_HISTORY and M.previousDisplayScope then
        local previous = M.store.buckets[M.previousDisplayScope]
        stored = {identity=copy(value),history=copy(previous.history or {}),drafts=copy(previous.drafts or {}),
            launch=previous.launch,sessionOnly=false,migratedFrom=M.previousDisplayScope}
        M.store.buckets[key] = stored
    end
    if type(stored) ~= 'table' or not stable or displayScope(binding(stored.identity)) ~= stable then
        if stored then M.store.legacy[#M.store.legacy+1] = {reason='scope-conflict',scope=key,data=copy(stored)} end
        stored = {identity=copy(value),history={},drafts={},sessionOnly=stable == nil}
        M.store.buckets[key] = stored
    end
    M.scope, M.bucket, M.history, M.drafts, M.launch = key, stored, {}, {}, stored.launch
    for contact, rows in pairs(type(stored.history) == 'table' and stored.history or {}) do
        if type(rows) == 'table' then
            M.history[contact] = {}
            -- Full transcripts persist across launches. Only an explicit,
            -- confirmed character/all memory clear removes their Chat data.
            for i = 1, #rows do
                local row = rows[i]
                if type(row) == 'table' and type(row.text) == 'string' and #row.text <= 6000 then
                    table.insert(M.history[contact], {text = row.text, sent = row.sent == true, image = M.cleanImage(row.image)})
                end
            end
        end
    end
    for contact, draft in pairs(type(stored.drafts) == 'table' and stored.drafts or {}) do
        if type(draft) == 'string' and #draft <= 4800 then M.drafts[contact] = draft end
    end
end

function M.abandon()
    if M.world then publish(false) end
    if M.pending and not M.pending.event then
        if (M.drafts[M.pending.contact] or '') == '' then M.drafts[M.pending.contact] = M.pending.text end
        M.errors = {[M.pending.contact] = 'Conversation interrupted. Your message is in the draft.'}
    end
    M.events, M.eventItem = nil, nil
    save()
    M.world, M.pending, M.contact, M.lastPaint, M.lastHeartbeat, M.registered = nil, nil, nil, nil, nil, nil
    M.saveIdentity, M.bindingKey, M.bucket, M.scope, M.captureDrafts = nil, nil, nil, nil, false
    M.history, M.drafts, M.errors = {}, {}, {}
end
-- The per-frame binding check reads a small plain table; binding() copies only its scalar fields, so it needs
-- no JSON round trip (capture() is for snapshots that leave the game). Every frame, so no encode/decode here.
local function currentBindingValue(player)
    if type(M.captureBinding) ~= 'function' then return nil end
    local ok, value = pcall(M.captureBinding, player)
    return ok and type(value) == 'table' and value or nil
end
-- The Chat tab's text box is Codeware's text input (PhoneChat.reds; its stand-in has no box). True when this mod's scripts were
-- compiled without it, which the setup check reads once from the scripts and keeps; false while that is not known (older scripts).
local function textInputMissing(player)
    local check = convaiSetupCheck
    if type(check) ~= 'table' or type(check.requirement) ~= 'function' then return false end
    local ok, present = pcall(check.requirement, 'codeware-textinput', player)
    return ok and present == false
end

-- ---- Texts a character sends on her own (docs/IMMERSIVE_INVITATIONS.md) ------------------------------------------------------------
-- She arrived, she was stood up, the meeting was called off. The phone turn has no typed line: it carries an `event` and the bridge
-- writes the text in her voice (bridge/appointment-events.mjs). Anything that stops it shows the plain line the caller prepared.
function M.contactFor(profileKey)
    for contact, key in pairs(M.catalog) do if key == profileKey then return contact end end
    return nil
end
function M.sendEvent(item)
    local contact = M.contactFor(item.profileKey)
    if not contact or type(item.fallback) ~= 'string' then return false end
    if M.manager and not M.manager.profileEnabled(item.profileKey) then return false end
    M.events = M.events or {}
    if #M.events >= 8 then return false end
    M.events[#M.events + 1] = {contact = contact, item = item}
    return true
end
function M.deliverEvent(contact, item, text)
    append(contact, text, false)
    M.dirty = true
    if type(M.onEventDelivered) == 'function' then pcall(M.onEventDelivered, item, text) end
end
function M.startEvent(player, entry)
    local contact, item = entry.contact, entry.item
    local key = M.catalog[contact]
    if not key then return false end
    M.serial = M.serial + 1
    local before = M.bindingKey
    local worldKnowledge = capture(M.captureWorldKnowledge, player, key, copy(M.saveIdentity))
    local journalHistory = capture(M.captureJournalHistory, player, key, copy(M.saveIdentity))
    local journal, battle = capture(M.captureJournal), capture(M.captureBattle)
    local gameDialogue = capture(M.captureGameDialogue)
    local turnContext = capture(M.captureTurnContext, key)
    local confirmed = binding(capture(M.captureBinding, player))
    if bindingKey(confirmed) ~= before then return false end
    M.saveIdentity = confirmed
    local reset = phoneReset(key)
    M.pending = {id = M.world .. '-' .. M.serial, contact = contact, profileKey = key, text = '',
        event = {version = 1, kind = item.kind, place = item.place or '', minutes = math.max(0, math.min(120, tonumber(item.minutes) or 0)),
            car = item.car == true},
        memoryReset = reset, recentConversation = recentPhoneConversation(contact, key, reset),
        saveIdentity = copy(confirmed), worldKnowledge = worldKnowledge or {version = 1, status = 'unavailable'},
        journalHistory = journalHistory, journal = journal, battle = battle, gameDialogue = gameDialogue}
    M.pending.turnContext = turnContext
    M.eventItem = item
    M.sentAt = os.time()
    M.replyWaitSeconds = replyWait()
    if publish(true) then return true end
    M.pending, M.eventItem = nil, nil
    return false
end

-- Tells the game which Chat contacts are favorites (the characters starred in Characters to invite), when the favorites changed since the last
-- time. The contact id maps to its profile key through the catalog. Older scripts without the methods are skipped (asked once).
function M.pushFavorites(player)
    local favorites = convaiFavorites
    if type(favorites) ~= 'table' or M.favoritesMissing then return end
    local revision = favorites.revision()
    if M.favoritesSeen == revision then return end
    local ok = pcall(function()
        player:ConvaiPhoneChatClearFavorites()
        if favorites.count('characters') > 0 then
            for id, key in pairs(M.catalog) do
                if favorites.isFavorite('characters', key) then player:ConvaiPhoneChatAddFavorite(id) end
            end
        end
    end)
    if ok then M.favoritesSeen = revision else M.favoritesMissing = true end
end

-- F on a Chat row turns a favorite on or off: the list already shows it (the game keeps its own copy until the next push), and the request waits
-- in the game for this tick ("1" or "0", then the contact id). It is kept in favorites.lua, the same data the Companion Manager's stars use, and the
-- next push (pushFavorites) sends the whole list back, which also settles a request that could not be kept (a full list). Older scripts without the
-- method are asked once.
function M.takeFavoriteRequests(player)
    if M.favoriteRequestsMissing then return end
    for _ = 1, 8 do
        local asked, line = pcall(function() return player:ConvaiPhoneChatTakeFavoriteRequest() end)
        if not asked then M.favoriteRequestsMissing = true; return end
        if type(line) ~= 'string' or line == '' then return end
        local key = M.catalog[line:sub(2)]
        local favorites = convaiFavorites
        if key and type(favorites) == 'table' and type(favorites.set) == 'function' then
            pcall(favorites.set, 'characters', key, line:sub(1, 1) == '1')
        end
        M.favoritesSeen = nil
    end
end

-- Tells the game which Chat contacts are in the party, so a row offers Invite (J) or Dismiss (L), not both. M.partyKeys() (init.lua) returns the profile keys of
-- the copies present and the invitations being prepared. Read only while the phone is open (the argument of update), at most twice a second, and sent only
-- when the set changed. Older scripts without the methods are asked once.
local PARTY_PERIOD = 0.5
function M.pushParty(player, phoneOpen, elapsed)
    if M.partyMissing or type(M.partyKeys) ~= 'function' then return end
    if phoneOpen ~= true then M.partyWait, M.partySeen = PARTY_PERIOD, nil; return end
    M.partyWait = (M.partyWait or PARTY_PERIOD) + (tonumber(elapsed) or 0)
    if M.partyWait < PARTY_PERIOD and M.partySeen ~= nil then return end
    M.partyWait = 0
    local ok, keys = pcall(M.partyKeys)
    if not ok or type(keys) ~= 'table' then return end
    local ids = {}
    for id, key in pairs(M.catalog) do if keys[key] then ids[#ids + 1] = id end end
    table.sort(ids)
    local signature = table.concat(ids, ',')
    if M.partySeen == signature then return end
    local sent = pcall(function()
        player:ConvaiPhoneChatClearParty()
        for _, id in ipairs(ids) do player:ConvaiPhoneChatAddParty(id) end
    end)
    if sent then M.partySeen = signature else M.partyMissing = true end
end

-- Search on the Chat list (r6/scripts/CyberpunkConvai/PhoneChatSearch.reds, docs/PHONE_CHAT.md "Search on the Chat list"). The list asks when the player's text changes;
-- this answers on the 10 Hz tick, and only while the phone is open, with the contact ids whose name has a word that starts with each word of the text. Case and accents are
-- ignored on both sides (an accented letter counts as its plain letter). The words of every name are worked out once per registration of the contacts, not per question.
function M.buildFoldMap()
    local groups = {
        a = 'àáâãäåāăąÀÁÂÃÄÅĀĂĄ', c = 'çćĉċčÇĆĈĊČ', d = 'ďđĎĐ', e = 'èéêëēĕėęěÈÉÊËĒĔĖĘĚ', g = 'ĝğġģĜĞĠĢ', h = 'ĥħĤĦ',
        i = 'ìíîïĩīĭįıÌÍÎÏĨĪĬĮİ', j = 'ĵĴ', k = 'ķĶ', l = 'ĺļľŀłĹĻĽĿŁ', n = 'ñńņňÑŃŅŇ', o = 'òóôõöøōŏőÒÓÔÕÖØŌŎŐ',
        r = 'ŕŗřŔŖŘ', s = 'śŝşšŚŜŞŠ', t = 'ţťŧŢŤŦ', u = 'ùúûüũūŭůűųÙÚÛÜŨŪŬŮŰŲ', w = 'ŵŴ', y = 'ýÿŷÝŸŶ', z = 'źżžŹŻŽ',
    }
    local map = {['ß'] = 'ss', ['æ'] = 'ae', ['Æ'] = 'ae', ['œ'] = 'oe', ['Œ'] = 'oe', ['ð'] = 'd', ['Ð'] = 'd', ['þ'] = 'th', ['Þ'] = 'th'}
    for base, chars in pairs(groups) do
        for ch in chars:gmatch('[\1-\127\194-\244][\128-\191]*') do map[ch] = base end
    end
    M.foldMap = map
    return map
end
-- The text in lower case with accented Latin letters as their plain letters. Other scripts are kept as they are.
function M.foldText(text)
    if type(text) ~= 'string' then return '' end
    if not text:find('[\128-\255]') then return text:lower() end
    local map = M.foldMap or M.buildFoldMap()
    local out = {}
    for ch in text:gmatch('[\1-\127\194-\244][\128-\191]*') do
        out[#out + 1] = #ch == 1 and ch:lower() or map[ch] or ch
    end
    return table.concat(out)
end
-- The words of a text (a run of anything but spaces and punctuation), folded.
function M.searchWords(text)
    local words = {}
    for word in M.foldText(text):gmatch('[^%s%p]+') do words[#words + 1] = word end
    return words
end
-- id -> the words of its name (the profile's name, else the key), made once after the contacts are registered.
function M.searchIndex()
    local index = M.searchWordsById
    if index then return index end
    index = {}
    local names = M.keyNames or {}
    for id, key in pairs(M.catalog) do index[id] = M.searchWords(M.names[id] or names[key] or key) end
    M.searchWordsById = index
    return index
end
-- The names the journal gives its contacts ("id", a tab, "name", a line each) as id -> words: a journal name can differ from the profile's (Coach Fred).
function M.searchJournal(text)
    if type(text) ~= 'string' or text == '' then return {} end
    if M.searchJournalText == text then return M.searchJournalWords end
    local out = {}
    for id, name in text:sub(1, 60000):gmatch('([^\t\n]+)\t([^\n]*)') do out[id] = M.searchWords(name) end
    M.searchJournalText, M.searchJournalWords = text, out
    return out
end
-- The ids (sorted) whose name has, for every word of the query, a word that starts with it. A query with no words matches every contact.
function M.searchIds(query, journal)
    local wanted = M.searchWords(tostring(query or ''):sub(1, 200))
    local index, extra, ids = M.searchIndex(), M.searchJournal(journal), {}
    for id, words in pairs(index) do
        local all = true
        for _, want in ipairs(wanted) do
            local found = false
            for _, word in ipairs(words) do
                if word:sub(1, #want) == want then found = true; break end
            end
            if not found and extra[id] then
                for _, word in ipairs(extra[id]) do
                    if word:sub(1, #want) == want then found = true; break end
                end
            end
            if not found then all = false; break end
        end
        if all then ids[#ids + 1] = id end
    end
    table.sort(ids)
    return ids
end
-- The list asked a new question (a number that only grows): answered once, with the number back. Older scripts without the methods are asked once.
function M.takeSearch(player)
    if M.searchMissing then return end
    local ok, seq = pcall(function() return player:ConvaiPhoneChatSearchSeq() end)
    if not ok then M.searchMissing = true; return end
    if type(seq) ~= 'number' or seq <= 0 or seq == M.searchSeen then return end
    M.searchSeen = seq
    local okQuery, query = pcall(function() return player:ConvaiPhoneChatSearchQuery() end)
    local okJournal, journal = pcall(function() return player:ConvaiPhoneChatSearchJournal() end)
    if not okQuery then M.searchMissing = true; return end
    local ids = M.searchIds(query, okJournal and journal or '')
    local sent = pcall(function() player:ConvaiPhoneChatSearchResult(seq, table.concat(ids, '\n')) end)
    if not sent then M.searchMissing = true end
end

function M.update(player, delta, phoneOpen)
    -- Scripts that compiled in part and lack the chat methods (setup-check.lua probeScripts): every call below would raise on every tick. One global read.
    local gone = convaiScriptsMissing
    if gone and gone.chat then return end
    -- Menus can stop game time; frames still arrive. Do not wait for a nonzero delta.
    M.tick = M.tick + math.max(tonumber(delta) or 0, 1 / 60)
    -- A reply due: the native plugin's revision of phone-chat-output.json is checked every 30 ms (one number, no disk access)
    -- and a new reply is shown on this frame's tick instead of up to 0.1 s later. Without the plugin nothing changes.
    if M.pending and M.tick < 0.10 and type(convaiNative) == 'table' and convaiNative.revision then
        M.replyProbe = (M.replyProbe or 0) + math.max(tonumber(delta) or 0, 1 / 60)
        if M.replyProbe >= 0.03 then
            M.replyProbe = 0
            local revision = convaiNative.revision('phone-chat-output.json')
            if revision and revision ~= M.replyRevision then M.replyRevision = revision; M.tick = 0.10 end
        end
    end
    -- The world binding is re-read on the 10 Hz tick, not every frame (each read builds the knowledge frame and
    -- checks it). Everything below that depends on it already waited for the tick; a load calls abandon(), which
    -- clears M.world, and the next call rebinds at once.
    if M.tick < 0.10 and M.world then return end
    if M.storePending and not M.storeReady() then return end
    local currentBinding = binding(currentBindingValue(player))
    local currentKey = bindingKey(currentBinding)
    local changed = not M.world or currentKey ~= M.bindingKey
        or displayScope(currentBinding) ~= displayScope(M.saveIdentity or {})
    local historyReady = M.resetHealthy ~= false
    if changed then
        -- A load must observe clear receipts before abandon could restore an
        -- interrupted draft. Otherwise poll on the existing phone cadence.
        historyReady = refreshMemoryResets()
        if M.world then M.abandon() end
        M.world = tostring(os.time()) .. '-' .. tostring(math.random(100000000, 999999999))
        M.saveIdentity, M.bindingKey = currentBinding, currentKey
        selectBucket(currentBinding)
        M.dirty, M.lastPaint, M.captureDrafts, M.justBound = true, nil, false, true
        save(); publish(true)
    else
        M.saveIdentity = currentBinding
    end
    if M.tick < 0.10 then return end
    local elapsed = M.tick
    M.tick = 0
    -- The reset journal changes only on Forget. Each CET io.open costs 1-2 ms of
    -- the game's main thread, so it is read every resetPeriod (and at once
    -- before a submission is judged), not on every 10 Hz phone tick. With no chat
    -- open and no reply pending nothing shows or sends, so it waits resetIdlePeriod.
    local resetRead = changed
    M.resetWait = (M.resetWait or 0) + elapsed
    local resetPeriod = ((M.contact or '') ~= '' or M.pending) and (M.resetPeriod or 0.5) or (M.resetIdlePeriod or 5)
    if not changed and (M.resetWait >= resetPeriod or M.resetHealthy == nil) then
        M.resetWait, resetRead = 0, true
        historyReady = refreshMemoryResets()
    end
    local supported, contact = pcall(function() return player:ConvaiPhoneChatContact() end)
    if not supported then return end -- staged Lua remains safe before native install
    player:ConvaiPhoneChatTick()
    -- The redscript's account of opening a chat (a few lines per opening, none otherwise): handed to the probe log by init.lua. A missing method
    -- (older scripts) is asked about once.
    if type(M.trace) == 'function' and M.traceMissing ~= true then
        for _ = 1, 8 do
            local asked, line = pcall(function() return player:ConvaiPhoneChatTakeTrace() end)
            if not asked then M.traceMissing = true; break end
            if type(line) ~= 'string' or line == '' then break end
            pcall(M.trace, line)
        end
    end
    if not M.registered then
        player:ConvaiPhoneChatClearContacts()
        -- Without the text input no chat is offered (the tab lists nothing) instead of one that opens and cannot be typed in.
        if not textInputMissing(player) then
            for id in pairs(M.catalog) do player:ConvaiPhoneChatRegisterContact(id, M.names[id] or '') end
        end
        M.registered = true
        M.favoritesSeen = nil
    end
    -- Favorites first on the Chat list (mod/favorites.lua): the game gets the favorite contact ids when they change (one number compared on this
    -- tick), and the list puts them first when it is built (PhoneChatTabs.reds), so there is no work while the list is open.
    M.takeFavoriteRequests(player)
    M.pushFavorites(player)
    M.pushParty(player, phoneOpen, elapsed)
    if phoneOpen == true then M.takeSearch(player) end
    contact = tostring(contact or '')
    -- One evidence hook per typing session, on its rising edge. The native read is
    -- made only while a phone chat is open, on this 10 Hz tick.
    local typing = false
    if contact ~= '' then
        local readable, value = pcall(function() return player:ConvaiPhoneChatTyping() end)
        typing = readable and value == true
    end
    if typing and not M.typingSeen and type(M.typingOpened) == 'function' then pcall(M.typingOpened, player, contact) end
    M.typingSeen = typing
    local draft = player:ConvaiPhoneChatDraft()
    -- Native stores the last draft before its controller is destroyed or recycled.
    if historyReady and M.captureDrafts and draft and M.catalog[draft.contact] and not M.resetDrafts[draft.contact]
        and (M.drafts[draft.contact] or '') ~= draft.text then
        M.drafts[draft.contact] = draft.text; M.saveDraft = true
    end
    if contact ~= M.contact then M.contact = contact; M.dirty = true; M.contactPublish = true end
    local submission = player:ConvaiPhoneChatTakeSubmission()
    if submission and not M.justBound and not resetRead then
        M.resetWait = 0
        historyReady = refreshMemoryResets()
    end
    if submission and not M.justBound then
        local key = M.catalog[submission.contact]
        local text = tostring(submission.text or ''):match('^%s*(.-)%s*$')
        M.errors = M.errors or {}
        if not historyReady then
            M.errors[submission.contact] = 'Saved Chat cleanup could not be verified. Please wait for the memory service.'
        elseif M.resetDrafts[submission.contact] then
            -- A native submission queued before Forget belongs to the cleared
            -- editor. Paint its empty draft before allowing a fresh send.
            M.errors[submission.contact] = nil
        elseif M.blockAll or M.blockedProfiles[key] then
            M.errors[submission.contact] = 'Memory clearing is in progress. Your draft has been kept.'
        elseif text == '' then
            M.errors[submission.contact] = 'Type a message first.'
        elseif not key or not M.manager.profileEnabled(key) then
            M.errors[submission.contact] = 'Conversations are disabled for this contact.'
        elseif customNeedsProvider(key) then
            M.errors[submission.contact] = CUSTOM_NEEDS_PROVIDER
        elseif M.pending then
            M.errors[submission.contact] = 'Wait for your previous reply before sending another message.'
        elseif type(M.serviceBlocked) == 'function' and M.serviceBlocked() then
            -- Already localized by init.lua; the draft stays in the editor.
            M.errors[submission.contact] = M.serviceBlocked()
        else
            M.serial = M.serial + 1
            local before = M.bindingKey
            local worldKnowledge = capture(M.captureWorldKnowledge, player, key, copy(M.saveIdentity))
            local journalHistory = capture(M.captureJournalHistory, player, key, copy(M.saveIdentity))
            local journal, battle = capture(M.captureJournal), capture(M.captureBattle)
            local gameDialogue = capture(M.captureGameDialogue)
            -- The clock, V's district and what V is doing: read once, when the message is sent (never per frame).
            local turnContext = capture(M.captureTurnContext, key)
            local confirmed = binding(capture(M.captureBinding, player))
            if bindingKey(confirmed) ~= before then
                M.abandon(); return
            end
            M.saveIdentity = confirmed
            local reset = phoneReset(key)
            M.pending = {id = M.world .. '-' .. M.serial, contact = submission.contact, profileKey = key, text = text,
                memoryReset=reset,recentConversation=recentPhoneConversation(submission.contact,key,reset),
                saveIdentity = copy(confirmed), worldKnowledge = worldKnowledge or {version=1,status='unavailable'},
                journalHistory = journalHistory, journal = journal, battle = battle, gameDialogue = gameDialogue}
            M.pending.turnContext = turnContext
            -- Immersive invitations (mod/immersive-invitations.lua): the meeting V could ask for, nil while the setting is Off.
            M.pending.meetOffer = capture(M.captureMeetOffer, submission.contact, key)
            -- Housemates (mod/housemates.lua): moving in at V's place or moving out, for a contact who may be invited.
            M.pending.homeOffer = capture(M.captureHomeOffer, submission.contact, key)
            -- Character bonds (mod/bonds.lua): the block a typed message carries, nil while the setting is Off. Read once, when the message is sent.
            M.pending.bonds = capture(M.captureBonds, key)
            M.sentAt = os.time()
            M.replyWaitSeconds = replyWait()
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
    if M.pending and M.pending.event and M.sentAt and os.time() - M.sentAt > (M.replyWaitSeconds or DEFAULT_REPLY_WAIT) then
        local item, contact = M.eventItem, M.pending.contact
        M.pending, M.eventItem = nil, nil
        publish(true)
        if item then M.deliverEvent(contact, item, item.fallback) end
    end
    if M.pending and M.sentAt and os.time() - M.sentAt > (M.replyWaitSeconds or DEFAULT_REPLY_WAIT) then
        M.errors = M.errors or {}
        M.errors[M.pending.contact] = 'No reply received. Your message is in the draft; press Enter to retry.'
        if (M.drafts[M.pending.contact] or '') == '' then
            M.drafts[M.pending.contact] = M.pending.text; M.clearDraft = M.pending.contact
        end
        M.pending = nil; M.dirty = true; save(); publish(true)
    end
    if historyReady and M.pending then
        local reply = read('runtime/phone-chat-output.json')
        if reply and reply.world == M.world and reply.binding == M.bindingKey
            and reply.id == M.pending.id and reply.contact == M.pending.contact then
            if reply.state == 'reply' and type(reply.text) == 'string' and #reply.text <= 6000 and reply.text:find('%S') then
                local accepted = M.pending
                append(reply.contact, reply.text, false); M.pending = nil; M.dirty = true
                if accepted.event then
                    local item = M.eventItem
                    M.eventItem = nil
                    if item and type(M.onEventDelivered) == 'function' then pcall(M.onEventDelivered, item, reply.text) end
                elseif accepted.homeOffer and type(reply.action) == 'table' and type(reply.action.token) == 'string'
                    and reply.action.token:sub(1, 5) == 'home-' and type(M.onHomeAction) == 'function' then
                    -- The bridge's answer to the housing offer (bridge/home-requests.mjs); the game checks it against the offer it sent.
                    pcall(M.onHomeAction, accepted.profileKey, reply.action, accepted.contact)
                elseif accepted.meetOffer and type(reply.action) == 'table' and type(M.onMeetAction) == 'function' then
                    -- The bridge's answer to the offer (bridge/meet-requests.mjs); the game checks it against the offer it sent.
                    pcall(M.onMeetAction, accepted.profileKey, reply.action, accepted.contact)
                end
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
            elseif reply.state == 'error' and M.pending.event then
                local item, contact = M.eventItem, M.pending.contact
                M.pending, M.eventItem = nil, nil
                if item then M.deliverEvent(contact, item, item.fallback) end
            elseif reply.state == 'error' then
                M.errors = M.errors or {}
                M.errors[reply.contact] = reply.errorCode == 'daily-limit' and dailyLimitStatus()
                    or MISTRAL_STATUS[reply.errorCode] or tostring(reply.error)
                if (M.drafts[reply.contact] or '') == '' then
                    M.drafts[reply.contact] = M.pending.text; M.clearDraft = reply.contact
                end
                M.pending = nil; M.dirty = true; save()
            end
        end
    end
    -- A text a character sends on her own (mod/immersive-invitations.lua): started when no message of V's is waiting for its reply.
    if historyReady and not M.pending and M.events and M.events[1] and M.world then
        local entry = table.remove(M.events, 1)
        local key = M.catalog[entry.contact]
        -- A plain text (item.plain: she could not come) is her fallback line at once: nothing for the bridge to write.
        if entry.item.plain or M.blockAll or M.blockedProfiles[key] or not M.startEvent(player, entry) then
            M.deliverEvent(entry.contact, entry.item, entry.item.fallback)
        end
    end
    -- Lease heartbeat: the bridge keeps phone-chat-input.json 15 s; refresh it every 3 s.
    -- A changed open Chat is published at once (one small file write, only when V opens or switches a Chat).
    if not M.lastHeartbeat or os.time() - M.lastHeartbeat >= 3 or os.time() < M.lastHeartbeat or M.contactPublish then
        M.lastHeartbeat = os.time(); M.contactPublish = nil; publish(true)
        if M.saveDraft then save(); M.saveDraft = false end
    end
    if contact ~= '' and M.dirty then
        local key = M.catalog[contact]
        local blocked = M.blockAll or M.blockedProfiles[key]
        local needsProvider = key ~= nil and customNeedsProvider(key)
        local enabled = historyReady and key ~= nil and not blocked and M.manager.profileEnabled(key) and not needsProvider
        local lines = {}
        for _, row in ipairs(historyReady and M.history[contact] or {}) do
            local line = NewObject('CyberpunkConvai.ConvaiPhoneChatLine')
            line.text, line.sent = row.text, row.sent
            if row.image then line.imageAtlas, line.imagePart, line.imageWidth, line.imageHeight = row.image.atlas, row.image.part, row.image.width, row.image.height end
            lines[#lines + 1] = line
        end
        local waiting = M.pending and (M.pending.contact == contact and 'Message sent. Waiting for reply.' or 'Waiting for your previous message to finish.') or ''
        local status = (M.errors or {})[contact] or waiting
        if not enabled then status = key and (needsProvider and CUSTOM_NEEDS_PROVIDER or 'Conversations are disabled in Companion Manager.') or 'Conversation is unavailable for this contact.' end
        if blocked then status = 'Memory clearing is in progress. Your draft has been kept.' end
        if not historyReady then status = 'Saved Chat cleanup could not be verified. Please wait for the memory service.' end
        local reset = M.lastPaint ~= contact or M.clearDraft == contact or M.resetDrafts[contact] == true
        player:ConvaiPhoneChatPresent(contact, lines, status, historyReady and (M.drafts[contact] or '') or '', enabled, M.pending ~= nil, reset)
        -- Messages in a script the game's font lacks (CJK, Cyrillic) are given their own font by the phone style, decided once per list.
        local style = convaiPhoneChatStyle
        if style and type(style.linesPresented) == 'function' then pcall(style.linesPresented, historyReady and M.history[contact] or {}) end
        if historyReady then M.captureDrafts = true end
        if historyReady then M.resetDrafts[contact] = nil end
        M.lastPaint, M.dirty, M.clearDraft = contact, false, nil
    end
    M.justBound = false
end
return M
