-- Native subtitles, owned by one reply and one exact world speaker at a time.
-- Overhead projection/layout stays in the game. We only advance owned lines.
local M = convaiSubtitles or {serial = 0}
local UTF8 = '[%z\1-\127\194-\244][\128-\191]*'

local function finite(value)
    return type(value) == 'number' and value == value and math.abs(value) < math.huge
end
local function identity(object)
    local ok, id = pcall(function() return tostring(object:GetEntityID().hash) end)
    return ok and id or nil
end
local function validActor(actor, expected)
    if not actor or type(expected) ~= 'string' then return false end
    local ok, valid = pcall(function()
        return actor:IsAttached() == true and actor:IsDeadNoStatPool() == false and identity(actor) == expected
    end)
    return ok and valid == true
end
local function board()
    return Game.GetBlackboardSystem():Get(Game.GetAllBlackboardDefs().UIGameData)
end
local function restorePlacement()
    local placement = M.placement
    M.placement = nil
    if placement then
        pcall(function()
            local offset = placement.offset
            placement.projection:SetFixedWorldOffset(Vector4.new(offset.x, offset.y, offset.z, offset.w))
        end)
    end
end
local function hideLine()
    local line = M.line
    restorePlacement()
    M.line, M.controller, M.widgetToken = nil, nil, nil
    if line then
        pcall(function()
            board():SetVariant(Game.GetAllBlackboardDefs().UIGameData.HideDialogLine,
                ToVariant({line.id}, 'array:CRUID'), true)
        end)
    end
end

function M.configure(options)
    M.styleProvider = options and options.style
end
function M.style()
    local ok, value = pcall(function() return M.styleProvider and M.styleProvider() end)
    return ok and value == 'overhead' and 'overhead' or 'dialogue'
end
function M.enabled()
    local player = Game.GetPlayer()
    if not player then return false end
    local ok, enabled = pcall(function() return player:ConvaiManagerSubtitles() end)
    return not ok or enabled
end
function M.abandon()
    -- Death/detach destroys the HUD. Release references without native calls.
    M.line, M.controller, M.widgetToken, M.actor, M.entity, M.playerID = nil, nil, nil, nil, nil, nil
    M.pages, M.timed, M.speaker, M.page, M.remaining, M.mode = nil, nil, nil, nil, nil, nil
    M.placement = nil
end
function M.clear()
    hideLine()
    M.abandon()
end
function M.clearEntity(entity)
    if entity ~= nil and entity == M.entity then M.clear(); return true end
    return false
end

-- Keep normal sentences together. Only wrap when a line actually exceeds the
-- native layout budget; short sentences and commas do not force a new page.
-- Preserve UTF-8 even in CJK text without spaces or unusually long words.
function M.split(text, style)
    if type(text) ~= 'string' then return {} end
    text = text:gsub('%s+', ' '):match('^%s*(.-)%s*$')
    local chars, pages = {}, {}
    for char in text:gmatch(UTF8) do chars[#chars + 1] = char end
    local overhead = style == 'overhead'
    local maximum, start = overhead and 120 or 160, 1
    while start <= #chars do
        local finish = math.min(#chars, start + maximum - 1)
        if finish < #chars then
            local boundary, punctuation
            for index = start, finish do
                local char = chars[index]
                if char == ' ' then boundary = index - 1 end
                if overhead and index >= start + math.floor(maximum * 0.65) then
                    -- ASCII punctuation must finish a word, so decimals and
                    -- abbreviations inside a token cannot become boundaries.
                    local wordEnd = not chars[index + 1] or chars[index + 1] == ' '
                    if (wordEnd and char:match('[.!?,;:]')) or char == '。' or char == '！'
                        or char == '？' or char == '；' or char == '，' or char == '、' or char == '：' then
                        punctuation = index
                    end
                end
            end
            if punctuation then finish = punctuation
            elseif chars[finish + 1] ~= ' ' and boundary and boundary >= start then finish = boundary end
        end
        local page = table.concat(chars, '', start, finish):match('^%s*(.-)%s*$')
        if page ~= '' then pages[#pages + 1] = page end
        start = finish + 1
        while chars[start] == ' ' do start = start + 1 end
    end
    return pages
end

local function showPage()
    if M.actor and not validActor(M.actor, M.entity) then M.clear(); return false end
    hideLine()
    local text = M.pages[M.page]
    M.serial = M.serial + 1
    local line = scnDialogLineData.new()
    line.id = CRUID(0x436F6E760000 + M.serial)
    line.type = M.mode == 'overhead' and scnDialogLineType.OverHead or scnDialogLineType.OwnerlessRegular
    if M.mode == 'overhead' then line.speaker = M.actor end
    line.speakerName, line.text, line.isPersistent = M.speaker, text, false
    local words, characters = 0, 0
    for _ in text:gmatch('%S+') do words = words + 1 end
    for _ in text:gmatch(UTF8) do characters = characters + 1 end
    -- Keep the accepted dialogue-HUD reading time. Overhead text without spaces
    -- needs its own character-based budget; audio always uses playback time.
    local reading = M.mode == 'overhead' and math.max(words / 2.8, characters / 10) + 0.8
        or math.max(words / 2.8, #text / 36) + 1.2
    line.duration = M.timed and M.timed.duration + 1 or math.max(M.mode == 'overhead' and 2 or 3.5, math.min(12, reading))
    M.line, M.remaining = line, line.duration
    board():SetVariant(Game.GetAllBlackboardDefs().UIGameData.ShowDialogLine,
        ToVariant({line}, 'array:scnDialogLineData'), true)
    return true
end

local function prepare(speaker, text, actor, expected)
    M.clear()
    if not M.enabled() then return false end
    M.requestedStyle, M.fallback = M.style(), nil
    M.entity = type(expected) == 'string' and expected or nil
    if validActor(actor, expected) then M.actor = actor end
    M.mode = M.requestedStyle
    if M.mode == 'overhead' then
        local ok, visible = pcall(function()
            return UserSettings.new():GetVar('/accessibility/subtitles', 'Overheads'):GetValue()
        end)
        if not M.actor then M.mode, M.fallback = 'dialogue', 'speaker-unavailable'
        elseif not ok or visible ~= true then M.mode, M.fallback = 'dialogue', 'native-overheads-disabled' end
    end
    M.pages = M.split(text, M.mode)
    if #M.pages == 0 then M.abandon(); return false end
    M.playerID, M.speaker, M.page = identity(Game.GetPlayer()), speaker, 1
    return true
end

function M.show(speaker, text, actor, expected)
    if prepare(speaker, text, actor, expected) then return showPage() end
    return false
end
function M.beginTimed(speaker, text, duration, actor, expected)
    if not finite(duration) or duration <= 0 or duration > 120 then return M.show(speaker, text, actor, expected) end
    if not prepare(speaker, text, actor, expected) then return false end
    local weights, total = {}, 0
    for index, page in ipairs(M.pages) do
        for _ in page:gmatch(UTF8) do total = total + 1 end
        weights[index] = total
    end
    -- Page boundaries are estimated within each audio chunk, not forced word
    -- alignment. Only the native playback cursor advances them, including pause.
    M.timed = {duration = duration, weights = weights, total = total, position = 0}
    return showPage()
end
function M.syncTimed(position)
    if not M.timed or not finite(position) or position < 0 then return end
    if M.actor and not validActor(M.actor, M.entity) then M.clear(); return end
    M.timed.position = math.min(position, M.timed.duration)
    local target = 1
    while target < #M.pages and position >= M.timed.duration * M.timed.weights[target] / M.timed.total do target = target + 1 end
    if target ~= M.page then M.page = target; showPage() end
end
function M.update(delta)
    if not M.line then return end
    local ok, player = pcall(function() return Game.GetPlayer() end)
    if not ok or not player or (M.playerID and identity(player) ~= M.playerID) then M.abandon(); return end
    if not M.enabled() or (M.actor and not validActor(M.actor, M.entity)) then M.clear(); return end
    if M.timed then return end
    local defs = Game.GetAllBlackboardDefs()
    if Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) then return end
    M.remaining = M.remaining - (finite(delta) and math.max(0, delta) or 0)
    if M.remaining > 0 then return end
    if M.page >= #M.pages then M.clear(); return end
    M.page = M.page + 1
    showPage()
end

function M.install()
    if M.hooksVersion == 4 then return true end
    if type(ObserveAfter) ~= 'function' then return false end
    ObserveAfter('ChatterLineLogicController', 'SetLineData', function(controller, line)
        local named, rootName = pcall(function() return NameToString(controller:GetRootWidget():GetName()) end)
        if named and (M.widgetToken == rootName or (M.placement and M.placement.token == rootName)) then
            restorePlacement(); M.widgetToken = nil
        end
        if not M.line or M.mode ~= 'overhead' or tostring(line.id) ~= tostring(M.line.id) then return end
        local ok, result = pcall(function()
            return {id = tostring(line.id), entity = tostring(controller:GetOwnerID().hash),
                renderer = 'native-overhead', text = line.text, projection = controller:GetProjection() ~= nil}
        end)
        M.rendered = ok and result or {error = tostring(result)}
        if ok and result.entity == M.entity and result.projection then
            -- CET may hand each callback a different Lua wrapper for the same
            -- native controller. A name on our newly created root is stable;
            -- userdata equality is not a safe ownership key across callbacks.
            -- Each render gets a fresh token, even when the same line is
            -- recreated on another root. A retired native root stays retired.
            M.renderSerial = (M.renderSerial or 0) + 1
            local token = 'convai_subtitle_' .. tostring(line.id):gsub('[^%w_]', '_') .. '_' .. M.renderSerial
            local marked = pcall(function() controller:GetRootWidget():SetName(CName.new(token)) end)
            if marked then M.widgetToken, M.rendered.widgetToken = token, token end
            local adjusted, offset = pcall(function()
                local projection = controller:GetProjection()
                restorePlacement()
                local original = projection:GetFixedWorldOffset()
                M.placement = {projection = projection, token = token,
                    offset = {x = original.x, y = original.y, z = original.z, w = original.w}}
                -- The native NPC chatter anchor adds 30 cm above its UI slot.
                -- Our optional captions need only 5 cm of extra headroom.
                projection:SetFixedWorldOffset(Vector4.new(0, 0, 0.05, 0))
                return projection:GetFixedWorldOffset().z
            end)
            M.rendered.worldOffsetZ = adjusted and offset or nil
            M.rendered.placementError = not adjusted and tostring(offset) or nil
        end
    end)
    -- Other crowd chatter can be closer to screen centre. Keep this exact
    -- owned line readable; every other controller retains the native behavior.
    if type(Override) == 'function' then
        Override('ChatterLineLogicController', 'IsBubble', function(controller, target, wrapped)
            if M.line and M.mode == 'overhead' and M.widgetToken then
                local ok, name = pcall(function() return NameToString(controller:GetRootWidget():GetName()) end)
                if ok and name == M.widgetToken then
                    M.bubbleOverrides = (M.bubbleOverrides or 0) + 1
                    return false
                end
            end
            return wrapped(target)
        end)
    end
    M.hooksInstalled, M.hooksVersion = true, 4
    return true
end
function M.status()
    return {active = M.line ~= nil, serial = M.serial, page = M.page, pages = M.pages and #M.pages or 0,
        mode = M.mode, requestedStyle = M.requestedStyle, fallback = M.fallback, entity = M.entity,
        timed = M.timed ~= nil, position = M.timed and M.timed.position, rendered = M.rendered,
        bubbleOverrides = M.bubbleOverrides or 0}
end

-- Legacy live entry points keep the normal HUD when no exact actor is given.
function M.installLive()
    M.install()
    if M.liveInstalled then return end
    Override('PlayerPuppet', 'ConvaiShowReply', function(_, speaker, text) M.show(speaker, text) end)
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
    convaiCompanions.dismissAll = function(...) M.clear(); return previousDismiss(...) end
    M.liveInstalled = true
end

convaiSubtitles = M
return M
