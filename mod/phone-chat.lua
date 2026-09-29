-- Own phone history/drafts independently of the quest journal and nearby NPCs.
local M = {serial = 0, tick = 0, history = {}, drafts = {}, catalog = {}}
local function read(path)
    local f = io.open(path, 'rb'); if not f then return nil end
    local ok, value = pcall(json.decode, f:read('*a')); f:close()
    return ok and type(value) == 'table' and value or nil
end
local function write(path, value)
    local f = io.open(path .. '.tmp', 'wb'); if not f then return false end
    f:write(json.encode(value)); f:close()
    os.remove(path); return os.rename(path .. '.tmp', path) ~= nil
end
local function save()
    write('runtime/phone-history.json', {version = 1, history = M.history, drafts = M.drafts})
end
local function append(contact, text, sent)
    local rows = M.history[contact] or {}; M.history[contact] = rows
    rows[#rows + 1] = {text = text, sent = sent}
    while #rows > 40 do table.remove(rows, 1) end
    M.dirty = true; save()
end
local function publish(active)
    return write('runtime/phone-chat-input.json', {version = 1, world = M.world, active = active,
        updated = os.time() * 1000, request = M.pending})
end
function M.configure(profiles, manager)
    local supported = {}; for _, p in ipairs(profiles) do supported[p.key] = true end
    for _, c in ipairs(read('phone-contacts.json') or {}) do
        if c.key and supported[c.key] then M.catalog[c.contact] = c.key end
    end
    M.manager = manager
    local stored = read('runtime/phone-history.json') or {}
    for contact in pairs(M.catalog) do
        local rows = stored.history and stored.history[contact]
        if type(rows) == 'table' then
            M.history[contact] = {}
            for i = math.max(1, #rows - 39), #rows do
                local row = rows[i]
                if type(row) == 'table' and type(row.text) == 'string' and #row.text <= 6000 then
                    table.insert(M.history[contact], {text = row.text, sent = row.sent == true})
                end
            end
        end
        local draft = stored.drafts and stored.drafts[contact]
        if type(draft) == 'string' and #draft <= 4800 then M.drafts[contact] = draft end
    end
end
function M.abandon()
    if M.world then publish(false) end
    if M.pending then
        if (M.drafts[M.pending.contact] or '') == '' then M.drafts[M.pending.contact] = M.pending.text end
        M.errors = {[M.pending.contact] = 'Conversation interrupted. Your message is in the draft.'}
    end
    save()
    M.world, M.pending, M.contact, M.lastPaint, M.lastHeartbeat, M.registered = nil, nil, nil, nil, nil, nil
end
function M.update(player, delta)
    if not M.world then
        M.world = tostring(os.time()) .. '-' .. tostring(math.random(100000000, 999999999))
        M.dirty = true
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
    local draft = player:ConvaiPhoneChatDraft()
    -- Native stores the last draft before its controller is destroyed or recycled.
    if draft and M.catalog[draft.contact] and M.drafts[draft.contact] ~= draft.text then
        M.drafts[draft.contact] = draft.text; M.saveDraft = true
    end
    if contact ~= M.contact then M.contact = contact; M.dirty = true end
    local submission = player:ConvaiPhoneChatTakeSubmission()
    if submission then
        local key = M.catalog[submission.contact]
        local text = tostring(submission.text or ''):match('^%s*(.-)%s*$')
        M.errors = M.errors or {}
        if text == '' then
            M.errors[submission.contact] = 'Type a message first.'
        elseif not key or not M.manager.profileEnabled(key) then
            M.errors[submission.contact] = 'Conversations are disabled for this contact.'
        elseif M.pending then
            M.errors[submission.contact] = 'Wait for your previous reply before sending another message.'
        else
            M.serial = M.serial + 1
            M.pending = {id = M.world .. '-' .. M.serial, contact = submission.contact, text = text}
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
        if reply and reply.world == M.world and reply.id == M.pending.id and reply.contact == M.pending.contact then
            if reply.state == 'reply' and type(reply.text) == 'string' and #reply.text <= 6000 then
                append(reply.contact, reply.text, false); M.pending = nil; M.dirty = true
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
        local enabled = key ~= nil and M.manager.profileEnabled(key)
        local lines = {}
        for _, row in ipairs(M.history[contact] or {}) do
            local line = NewObject('CyberpunkConvai.ConvaiPhoneChatLine')
            line.text, line.sent = row.text, row.sent; lines[#lines + 1] = line
        end
        local waiting = M.pending and (M.pending.contact == contact and 'Message sent. Waiting for reply.' or 'Waiting for your previous message to finish.') or ''
        local status = (M.errors or {})[contact] or waiting
        if not enabled then status = key and 'Conversations are disabled in Companion Manager.' or 'Conversation is unavailable for this contact.' end
        local reset = M.lastPaint ~= contact or M.clearDraft == contact
        player:ConvaiPhoneChatPresent(contact, lines, status, M.drafts[contact] or '', enabled, M.pending ~= nil, reset)
        M.lastPaint, M.dirty, M.clearDraft = contact, false, nil
    end
end
return M
