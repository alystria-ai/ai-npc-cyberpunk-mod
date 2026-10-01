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
local function sameToken(name, token)
    if type(token) ~= 'string' then return false end
    -- CName.new hashes a string but does not intern it in the game's name
    -- pool. NameToString can therefore be empty for our perfectly valid name.
    -- Native CName equality compares the complete hash, across CET wrappers.
    return name == CName.new(token)
end
local function ownedController(controller)
    if not M.line or M.mode ~= 'overhead' or not M.widgetToken or not controller then return false end
    local ok, owned = pcall(function()
        return sameToken(controller:GetRootWidget():GetName(), M.widgetToken)
            and tostring(controller:GetOwnerID().hash) == M.entity
    end)
    return ok and owned
end
local function concealOwnedRoot()
    if ownedController(M.controller) then
        pcall(function() M.controller:GetRootWidget():SetVisible(false) end)
    end
end
local function projectionVisible(controller)
    local ok, visible = pcall(function()
        controller:SetNameplateVisibility(false)
        local projection = controller:GetProjection()
        local point = projection.currentPosition
        -- CET native vector wrappers and redscript Vector2 expose different
        -- coordinate spellings. Neither text lookup nor coercion is needed.
        local read, x, y = pcall(function() return point.x, point.y end)
        if not read or not finite(x) or not finite(y) then x, y = point.X, point.Y end
        return projection:IsInScreen() and finite(x) and finite(y)
            and controller:IsVisible(controller:GetOwnerID()) == true
    end)
    if not ok then M.projectionError = tostring(visible); return false end
    return visible
end
local function settleProjection(controller, visible)
    if not ownedController(controller) then return end
    if M.pendingProjection and (M.frameSerial or 0) < (M.revealAfterFrame or 0) then
        concealOwnedRoot()
        return
    end
    -- Readiness cannot be the condition for releasing a hidden root: opaque
    -- native projection code may itself stop ticking while that root is hidden.
    -- Restore its original visibility after the bounded initialization guard.
    local shown = pcall(function()
        local root, wanted = controller:GetRootWidget(), M.rootVisibility ~= false
        if root:IsVisible() ~= wanted then root:SetVisible(wanted) end
    end)
    if not shown then return end
    -- A missing internal hook must never keep an admitted root hidden. The
    -- normal Lua frame path calls this too, and can expand just our own refs.
    local ok, problem = pcall(function()
        local text, bubble = controller.m_TextContainer, controller.m_speachBubble
        if inkWidgetRef.IsValid(text) and inkWidgetRef.IsValid(bubble) then
            inkWidgetRef.SetVisible(text, visible)
            inkWidgetRef.SetVisible(bubble, false)
        end
    end)
    if not ok then M.renderVisibilityError = tostring(problem) end
    M.pendingProjection, M.projectionReady = nil, visible == true
end
local function restorePlacement()
    local placement = M.placement
    M.placement = nil
    if placement then
        pcall(function()
            local offset = placement.offset
            if placement.slots then
                placement.projection:SetSlotComponentName(CName.new(placement.slots.component))
                placement.projection:SetSlotName(CName.new(placement.slots.slot))
                placement.projection:SetSlotFallbackName(CName.new(placement.slots.fallback))
            end
            placement.projection:SetFixedWorldOffset(Vector4.new(offset.x, offset.y, offset.z, offset.w))
        end)
    end
end
local function hideLine()
    local line = M.line
    -- HideDialogLine is a delayed blackboard callback. Restoring the native
    -- offset while its old root is still visible makes the caption jump up
    -- just before removal, so conceal our exact root first.
    concealOwnedRoot()
    restorePlacement()
    M.line, M.controller, M.widgetToken = nil, nil, nil
    M.projectionReady, M.pendingProjection = nil, nil
    M.revealAfterFrame = nil
    M.rootVisibility = nil
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
    M.anchor, M.projectionReady, M.pendingProjection, M.rootVisibility = nil, nil, nil, nil
    M.revealAfterFrame = nil
end

local function headAnchor(actor)
    local ok, component = pcall(function()
        local slot = actor:GetSlotComponent()
        if not slot then return nil end
        -- CET exposes the native out transform as a second return value.
        -- The Head slot follows animation, including a seated passenger.
        local found, transform = slot:GetSlotTransform(CName.new('Head'))
        if not found or not transform then return nil end
        local name = NameToString(slot:GetName())
        if type(name) ~= 'string' or name == '' then return nil end
        return name
    end)
    return ok and component and {component = component, slot = 'Head'} or nil
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

local function pageDuration(text)
    local words, characters = 0, 0
    for _ in text:gmatch('%S+') do words = words + 1 end
    for _ in text:gmatch(UTF8) do characters = characters + 1 end
    -- Keep the accepted dialogue-HUD reading time. Overhead text without spaces
    -- needs its own character-based budget; audio always uses playback time.
    local reading = M.mode == 'overhead' and math.max(words / 2.8, characters / 10) + 0.8
        or math.max(words / 2.8, #text / 36) + 1.2
    return M.timed and M.timed.duration + 1 or math.max(M.mode == 'overhead' and 2 or 3.5, math.min(12, reading))
end

local function updateOwnedText(controller, text)
    if not ownedController(controller) then return false end
    local ok, problem = pcall(function()
        -- The 2.31 chatter controller's plain-text branch writes these refs.
        -- Calling SetLineData again also resets its entity projection and
        -- switches text back to a speech bubble; update only the owned text.
        local normal, wide = controller.m_text_normal, controller.m_text_wide
        local normalContainer, wideContainer = controller.m_container_normal, controller.m_container_wide
        if not inkWidgetRef.IsValid(normal) or not inkWidgetRef.IsValid(wide)
            or not inkWidgetRef.IsValid(normalContainer) or not inkWidgetRef.IsValid(wideContainer) then
            error('Owned chatter text references are unavailable')
        end
        local characters = 0
        for _ in text:gmatch(UTF8) do characters = characters + 1 end
        local isWide = characters >= 110
        inkTextRef.SetText(normal, text)
        inkTextRef.SetText(wide, text)
        inkWidgetRef.SetVisible(normal, not isWide)
        inkWidgetRef.SetVisible(wide, isWide)
        inkWidgetRef.SetVisible(normalContainer, not isWide)
        inkWidgetRef.SetVisible(wideContainer, isWide)
    end)
    if not ok then M.renderUpdateError = tostring(problem); return false end
    if M.rendered then M.rendered.text = text end
    M.textUpdates = (M.textUpdates or 0) + 1
    return true
end

local function showPage()
    if M.actor and not validActor(M.actor, M.entity) then M.clear(); return false end
    local text = M.pages[M.page]
    local duration = pageDuration(text)
    if M.mode == 'overhead' and M.line then
        if not M.controller or updateOwnedText(M.controller, text) then
            -- One projected root/CRUID owns the complete overhead utterance.
            -- Before async spawn finishes, its first receipt reconciles this
            -- latest text rather than scheduling a second projected widget.
            M.line.text, M.line.duration, M.remaining = text, duration, duration
            return true
        end
    end
    hideLine()
    M.serial = M.serial + 1
    local line = scnDialogLineData.new()
    line.id = CRUID(0x436F6E760000 + M.serial)
    line.type = M.mode == 'overhead' and scnDialogLineType.OverHead or scnDialogLineType.OwnerlessRegular
    if M.mode == 'overhead' then line.speaker = M.actor end
    line.speakerName, line.text, line.isPersistent = M.speaker, text, false
    line.duration = duration
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
    if M.mode == 'overhead' then M.anchor = headAnchor(M.actor) end
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
function M.reviseTimed(text, duration, position)
    -- A growing realtime transcript belongs to the same utterance. Updating
    -- its text or final duration must not briefly render the first page again.
    if not M.timed or not finite(duration) or duration <= 0 or duration > 120
        or not finite(position) or position < 0 then return false end
    if M.playerID and identity(Game.GetPlayer()) ~= M.playerID then M.abandon(); return false end
    if not M.enabled() or (M.actor and not validActor(M.actor, M.entity)) then M.clear(); return false end
    local pages = M.split(text, M.mode)
    if #pages == 0 then return false end
    local oldText, oldPage = M.pages[M.page], M.page
    local weights, total = {}, 0
    for index, page in ipairs(pages) do
        for _ in page:gmatch(UTF8) do total = total + 1 end
        weights[index] = total
    end
    local target = 1
    while target < #pages and position >= duration * weights[target] / total do target = target + 1 end
    -- A duration estimate becoming more accurate is not a reason to replay a
    -- page which the player has already read.
    M.page = math.max(math.min(oldPage, #pages), target)
    M.pages, M.timed = pages, {duration = duration, weights = weights, total = total,
        position = math.min(position, duration), pageFloor = M.page}
    if not M.line or pages[M.page] ~= oldText or M.page ~= oldPage then return showPage() end
    -- A PCM duration estimate is not a new caption. Its local timing changes,
    -- but its text/widget/anchor remain untouched while the voice continues.
    M.line.duration = duration + 1
    return true
end
function M.syncTimed(position)
    if not M.timed or not finite(position) or position < 0 then return end
    if M.actor and not validActor(M.actor, M.entity) then M.clear(); return end
    M.timed.position = math.min(position, M.timed.duration)
    local target = 1
    while target < #M.pages and position >= M.timed.duration * M.timed.weights[target] / M.timed.total do target = target + 1 end
    if M.timed.pageFloor then target = math.max(target, M.timed.pageFloor); M.timed.pageFloor = target end
    if target ~= M.page then M.page = target; showPage() end
end
function M.update(delta)
    M.frameSerial = (M.frameSerial or 0) + 1
    if not M.line then return end
    local ok, player = pcall(function() return Game.GetPlayer() end)
    if not ok or not player or (M.playerID and identity(player) ~= M.playerID) then M.abandon(); return end
    if not M.enabled() or (M.actor and not validActor(M.actor, M.entity)) then M.clear(); return end
    if ownedController(M.controller) then
        M.projectionFrames = (M.projectionFrames or 0) + 1
        settleProjection(M.controller, projectionVisible(M.controller))
    end
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
    if M.hooksVersion == 7 then return true end
    if type(ObserveAfter) ~= 'function' then return false end
    local guardsProjection = type(Override) == 'function'
    ObserveAfter('ChatterLineLogicController', 'SetLineData', function(controller, line)
        local named, rootName = pcall(function() return controller:GetRootWidget():GetName() end)
        local current = M.line and M.mode == 'overhead' and tostring(line.id) == tostring(M.line.id)
        if named and (sameToken(rootName, M.widgetToken) or (M.placement and sameToken(rootName, M.placement.token))) then
            if current and ownedController(controller) then
                -- Native settings/HUD refresh can present the same line again.
                -- It does not own a new projection or need a new root token.
                M.controller = controller
                if line.text ~= M.line.text then updateOwnedText(controller, M.line.text) end
                return
            end
            restorePlacement()
            -- SetLineData can recycle an owned widget for native dialogue.
            -- Its root must regain the visibility it had before our first
            -- projection, even if we were still waiting for that projection.
            pcall(function() controller:GetRootWidget():SetVisible(M.rootVisibility ~= false) end)
            M.controller, M.widgetToken, M.projectionReady, M.pendingProjection = nil, nil, nil, nil
            M.rootVisibility = nil
            M.revealAfterFrame = nil
        end
        if not current then return end
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
            concealOwnedRoot()
            restorePlacement()
            local marked, claimed = pcall(function()
                local root = controller:GetRootWidget()
                M.rootVisibility = root:IsVisible()
                root:SetName(CName.new(token))
                if not sameToken(root:GetName(), token) then return false end
                root:SetVisible(false)
                return true
            end)
            if not marked or not claimed then
                M.rendered.ownershipError = not marked and tostring(claimed) or 'Native root did not retain its owned name'
                return
            end
            M.controller, M.widgetToken, M.rendered.widgetToken = controller, token, token
            M.projectionReady, M.pendingProjection = false, true
            -- Two regular frame ticks allow projection/layout to refresh even
            -- when a native callback and Lua update occur in the same frame.
            M.revealAfterFrame = (M.frameSerial or 0) + 2
            local adjusted, offset = pcall(function()
                local projection = controller:GetProjection()
                local original = projection:GetFixedWorldOffset()
                M.placement = {projection = projection, token = token,
                    offset = {x = original.x, y = original.y, z = original.z, w = original.w}}
                local anchored = false
                if M.anchor then
                    local read, slots = pcall(function()
                        return {component = NameToString(projection:GetSlotComponentName()),
                            slot = NameToString(projection:GetSlotName()),
                            fallback = NameToString(projection:GetSlotFallbackName())}
                    end)
                    if read then
                        M.placement.slots = slots
                        local set = pcall(function()
                            projection:SetSlotComponentName(CName.new(M.anchor.component))
                            projection:SetSlotName(CName.new(M.anchor.slot))
                            projection:SetSlotFallbackName(CName.new(M.anchor.slot))
                        end)
                        if set then anchored = true
                        else
                            -- A partially supported binding must not leave a
                            -- head slot on the wrong component. Restore all of
                            -- it before retaining the native UI-slot fallback.
                            restorePlacement()
                            M.placement = {projection = projection, token = token,
                                offset = {x = original.x, y = original.y, z = original.z, w = original.w}}
                        end
                    end
                end
                -- A verified Head slot is at the animated head centre, so its
                -- 25 cm offset clears the crown. Native UI-slot fallback keeps
                -- the previously accepted 15 cm headroom.
                projection:SetFixedWorldOffset(Vector4.new(0, 0, anchored and 0.25 or 0.15, 0))
                M.rendered.anchor = anchored and 'head' or 'native-ui-slot'
                return projection:GetFixedWorldOffset().z
            end)
            M.rendered.worldOffsetZ = adjusted and offset or nil
            M.rendered.placementError = not adjusted and tostring(offset) or nil
            if line.text ~= M.line.text then updateOwnedText(controller, M.line.text) end
        end
    end)
    -- Other crowd chatter can be closer to screen centre. Keep this exact
    -- owned line readable; every other controller retains the native behavior.
    if guardsProjection then
        Override('ChatterLineLogicController', 'IsBubble', function(controller, target, wrapped)
            if ownedController(controller) then
                M.bubbleOverrides = (M.bubbleOverrides or 0) + 1
                return false
            end
            return wrapped(target)
        end)
        Override('ChatterLineLogicController', 'UpdateProjection', function(controller, target, owner, wrapped)
            if not ownedController(controller) then return wrapped(target, owner) end
            M.projectionCallbacks = (M.projectionCallbacks or 0) + 1
            local visible = projectionVisible(controller)
            -- Native projection/viewport work must run even while initial
            -- coordinates are unavailable or the speaker is outside the view.
            local result = wrapped(target, owner)
            settleProjection(controller, visible)
            return result
        end)
    end
    M.hooksInstalled, M.hooksVersion = true, 7
    return true
end
function M.status()
    return {active = M.line ~= nil, serial = M.serial, page = M.page, pages = M.pages and #M.pages or 0,
        mode = M.mode, requestedStyle = M.requestedStyle, fallback = M.fallback, entity = M.entity,
        timed = M.timed ~= nil, position = M.timed and M.timed.position, rendered = M.rendered,
        bubbleOverrides = M.bubbleOverrides or 0, projectionReady = M.projectionReady == true,
        projectionCallbacks = M.projectionCallbacks or 0, projectionFrames = M.projectionFrames or 0,
        textUpdates = M.textUpdates or 0, renderUpdateError = M.renderUpdateError,
        projectionError = M.projectionError, renderVisibilityError = M.renderVisibilityError}
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
