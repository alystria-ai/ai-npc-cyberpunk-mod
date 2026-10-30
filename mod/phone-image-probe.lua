-- Developer probe for pictures in the phone Chat (docs/PHONE_IMAGES.md): sends ONE test message from a character, with a picture of the optional
-- picture archive (convai_phone_images.archive), into V's phone Chat, so the row's size, clipping and bubble can be looked at in game.
--
-- Run from mod/johnny-probe.lua (the developer mailbox, Developer mode only) as "johnny-probe:phoneimage:<action>:<stamp>" through
-- scripts/Send-JohnnyProbe.ps1 (`phoneimage send:card_wide`); the report is runtime/johnny-probe.json. Never loaded for a player, adds no hook, timer
-- or write of its own (the row goes through phone-chat.lua's own history, which saves it as it saves any line). Actions:
--   list                         the pictures this build knows, the Chat contacts, the open chat
--   send:<picture>               the picture from the open chat's character (or the first contact when no chat is open)
--   send:<picture>:<contact>     the same from a given contact id or character key
--   text                         a text-only line from the same character, for a before/after look at the row
-- Pictures: card_wide (1024 x 576), card_tall (576 x 1024). The same list is assets/phone-images/images.json, which scripts/Build-PhoneImages.ps1
-- packs (bridge/phone-images.test.mjs keeps the two equal).
local M = {}
M.IMAGES = {
    card_wide = {width = 1024, height = 576},
    card_tall = {width = 576, height = 1024},
}
M.ACTIONS = {list = true, send = true, text = true}

local function sortedKeys(map)
    local keys = {}
    for key in pairs(map) do keys[#keys + 1] = key end
    table.sort(keys)
    return keys
end

-- The contact a send goes to: the one named (a contact id, or a character key that has a contact), else the open chat, else the first contact.
local function pickContact(chat, named)
    if named and named ~= '' then
        if chat.catalog[named] then return named end
        return chat.contactFor(named)
    end
    if chat.contact and chat.contact ~= '' and chat.catalog[chat.contact] then return chat.contact end
    return sortedKeys(chat.catalog)[1]
end

function M.run(action, env)
    local chat = convaiPhoneChat
    if not chat or type(chat.deliverImage) ~= 'function' then error('phone chat is not loaded') end
    local verb, rest = action:match('^(%a+):?(.*)$')
    if not M.ACTIONS[verb or ''] then error('unknown action ' .. tostring(action)) end
    if verb == 'list' then
        return {pictures = sortedKeys(M.IMAGES), contacts = sortedKeys(chat.catalog), openChat = chat.contact, storeReady = chat.storeReady()}
    end
    if not chat.storeReady() then return {sent = false, why = 'the saved chats are still loading'} end
    local name, named = rest, nil
    if verb == 'send' then
        name, named = rest:match('^([%l%d_]+):?(.*)$')
    else
        named = rest
    end
    local contact = pickContact(chat, named)
    if not contact then return {sent = false, why = 'no Chat contact (is Chat shown in the phone, and is a character enabled?)'} end
    local report = {contact = contact, profileKey = chat.catalog[contact], openChat = chat.contact}
    if verb == 'text' then
        local rows = chat.history[contact] or {}
        chat.history[contact] = rows
        rows[#rows + 1] = {text = 'Text-only test line, no picture.', sent = false}
        chat.dirty = true
        report.sent = true
        return report
    end
    local picture = M.IMAGES[name or '']
    if not picture then return {sent = false, why = 'unknown picture ' .. tostring(name), pictures = sortedKeys(M.IMAGES)} end
    local folder = chat.IMAGE_FOLDER
    report.picture = name
    report.sent = chat.deliverImage(contact, 'Test picture ' .. name .. ' (' .. picture.width .. ' x ' .. picture.height .. ')',
        {atlas = folder .. name .. '.inkatlas', part = name, width = picture.width, height = picture.height})
    return report
end

return M
