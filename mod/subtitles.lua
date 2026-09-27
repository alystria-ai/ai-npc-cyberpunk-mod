-- Use the same dialogue blackboard and native line widgets as quest subtitles.
-- Only IDs allocated here are ever removed; native dialogue is left intact.
local M = convaiSubtitles or {serial = 0}

local function board()
    return Game.GetBlackboardSystem():Get(Game.GetAllBlackboardDefs().UIGameData)
end

function M.clear()
    if M.line then
        local id = M.line.id
        M.line = nil
        pcall(function()
            board():SetVariant(Game.GetAllBlackboardDefs().UIGameData.HideDialogLine,
                ToVariant({id}, 'array:CRUID'), true)
        end)
    end
    M.pages = nil
    M.timed = nil
end

-- Keep captions readable, including text without spaces, without cutting a
-- UTF-8 code point. Timing is reading time until voiced playback supplies it.
function M.split(text)
    local pages, current, count = {}, '', 0
    for token in text:gmatch('%S+') do
        local chars = {}
        for char in token:gmatch('[%z\1-\127\194-\244][\128-\191]*') do chars[#chars + 1] = char end
        if count > 0 and count + #chars + 1 > 160 then
            pages[#pages + 1], current, count = current, '', 0
        end
        if count > 0 then current, count = current .. ' ', count + 1 end
        for _, char in ipairs(chars) do
            if count >= 160 then pages[#pages + 1], current, count = current, '', 0 end
            current, count = current .. char, count + 1
        end
    end
    if current ~= '' then pages[#pages + 1] = current end
    return pages
end

local function showPage()
    local text = M.pages[M.page]
    M.serial = M.serial + 1
    local line = scnDialogLineData.new()
    line.id = CRUID(0x436F6E760000 + M.serial)
    line.type = scnDialogLineType.OwnerlessRegular
    line.speakerName = M.speaker
    line.text = text
    line.isPersistent = false
    local words = 0
    for _ in text:gmatch('%S+') do words = words + 1 end
    line.duration = M.timed and M.timed.duration + 1 or math.max(3.5, math.min(12, math.max(words / 2.8, #text / 36) + 1.2))
    M.line, M.remaining = line, line.duration
    board():SetVariant(Game.GetAllBlackboardDefs().UIGameData.ShowDialogLine,
        ToVariant({line}, 'array:scnDialogLineData'), true)
end

function M.show(speaker, text)
    M.clear()
    M.pages = M.split(text)
    if #M.pages == 0 then M.pages = nil; return end
    M.speaker, M.page = speaker, 1
    showPage()
end

function M.beginTimed(speaker, text, duration)
    M.clear()
    M.pages = M.split(text)
    if #M.pages == 0 then M.pages = nil; return end
    local weights, total = {}, 0
    for i, page in ipairs(M.pages) do
        local count = 0
        for _ in page:gmatch('[%z\1-\127\194-\244][\128-\191]*') do count = count + 1 end
        total = total + count
        weights[i] = total
    end
    -- Approximate phrase boundaries by text length, but advance exclusively
    -- from actual audio position. No phoneme alignment is claimed here.
    M.timed = {duration = duration, weights = weights, total = total}
    M.speaker, M.page = speaker, 1
    showPage()
end

function M.syncTimed(position)
    if not M.timed then return end
    local target = 1
    while target < #M.pages and position >= M.timed.duration * M.timed.weights[target] / M.timed.total do target = target + 1 end
    if target == M.page then return end
    local pages, timed = M.pages, M.timed
    M.clear()
    M.pages, M.timed, M.page = pages, timed, target
    showPage()
end

function M.update(delta)
    if not M.line then return end
    if not Game.GetPlayer() then M.clear(); return end
    if M.timed then return end
    local defs = Game.GetAllBlackboardDefs()
    if Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) then return end
    M.remaining = M.remaining - delta
    if M.remaining > 0 then return end
    local pages, nextPage = M.pages, M.page + 1
    M.clear()
    if nextPage <= #pages then
        M.pages, M.page = pages, nextPage
        showPage()
    end
end

-- Existing sessions can use this adapter without restarting or dismissing the
-- party. A normal CET reload uses init.lua's direct calls instead.
function M.installLive()
    if M.liveInstalled then return end
    Override('PlayerPuppet', 'ConvaiShowReply', function(_, speaker, text)
        M.show(speaker, text)
    end)
    Override('PlayerPuppet', 'ConvaiPhoneFeedback', function(_, message, wrapped)
        if message:sub(-15) == ' is thinking...' then return end
        return wrapped(message)
    end)
    local previousUpdate = convaiCompanions.update
    convaiCompanions.update = function(player, delta, focus)
        local ok, err = pcall(M.update, delta)
        if not ok then M.lastError = tostring(err); M.clear() end
        return previousUpdate(player, delta, focus)
    end
    local previousDismiss = convaiCompanions.dismissAll
    convaiCompanions.dismissAll = function(...)
        M.clear()
        return previousDismiss(...)
    end
    M.liveInstalled = true
end

convaiSubtitles = M
return M
