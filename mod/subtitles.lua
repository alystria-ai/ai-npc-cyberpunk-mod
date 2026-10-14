-- Native subtitles, owned by one reply and one exact world speaker at a time.
-- Overhead projection/layout stays in the game. We only advance owned lines.
-- Native line IDs (CRUID(0x436F6E760000 + serial)) must never repeat in one
-- game session. When the HUD removes a line by data, its ID stays in the HUD's
-- pending-hide list after our own hide, and the next line spawned with that ID
-- is removed the moment it appears. Starting every CET reload at 1 reused those
-- IDs, so each reload's first replies never showed. The clock-based start
-- (100 IDs per second of wall time) is past every earlier load's IDs.
local M = convaiSubtitles or {serial = math.floor(os.time() % 1000000000) * 100}
local EMOTION_TAGS = {'joy', 'warm', 'interest', 'surprise', 'sadness', 'fear', 'anger', 'disgust', 'calm'}
-- A timed utterance (audio-aligned pages) is advanced, held and ended by the code that plays the audio (mod/speech.lua), which calls
-- beginTimed/reviseTimed/syncTimed several times a second while it lives. If that stops (the speech was abandoned, its state file went
-- stale, an update error) nothing else would ever remove the page, so it is cleared after this many seconds without a call. Menus report
-- a zero delta and a menu is asked about only when the limit is reached; slow replies keep calling syncTimed while they wait, so they are not cut.
local TIMED_STALL = 8
local UTF8 = '[%z\1-\127\194-\244][\128-\191]*'

-- Caption fonts (mod/ui-fonts.lua). The game draws a caption in the font of its own language, which has no glyphs for a reply in
-- Japanese, Korean, Chinese or Russian when the game is set to another language. The script of a reply is decided once, when the
-- reply (or a revision of it) arrives: M.fontCode. Only a caption of such a reply is touched: its owned widgets get the family of
-- their own text when the game has drawn them, and are put back when the reply ends. A Latin reply costs one nil check.
local function fontScope()
    if M.fontScope == nil then
        local library = type(convaiUiFonts) == 'table' and convaiUiFonts.version == 2 and convaiUiFonts
        if not library then
            local ok, loaded = pcall(dofile, 'ui-fonts.lua')
            library = ok and type(loaded) == 'table' and type(loaded.replyCode) == 'function' and loaded
        end
        M.fontLibrary = library or false
        M.fontScope = library and library.new() or false
    end
    return M.fontScope or nil
end
local function replyFont(text)
    return fontScope() and M.fontLibrary.replyCode(text) or nil
end
local function styleFont(controller)
    if not controller then return end
    local scope = fontScope()
    if not scope or (not M.fontCode and scope.count() == 0) then return end
    local ok = pcall(function()
        scope.begin()
        scope.walk(controller:GetRootWidget(), 'reply', {left = 64})
    end)
    if ok then M.fontController = controller end
end
local function restoreFont()
    local scope, controller = M.fontScope, M.fontController
    M.fontController = nil
    if not scope then return end
    if controller and scope.count() > 0 then
        pcall(function()
            scope.begin()
            scope.walk(controller:GetRootWidget(), false, {left = 64})
        end)
    end
    scope.clear()
end

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
local function inVehicle(actor)
    if not actor then return false end
    local ok, mounted = pcall(function()
        local info = Game.GetMountingFacility():GetMountingInfoSingleWithObjects(actor)
        if not info or not info.parentId or info.parentId.hash == nil then return false end
        -- Native MountingInfo exists on foot too, with a zero parent ID.
        if tostring(info.parentId.hash):match('^0+[uUlL]*$') then return false end
        local parent = Game.FindEntityByID(info.parentId)
        return parent and parent:IsAttached() and parent:IsVehicle()
    end)
    return ok and mounted == true
end
local function vehicleConversation(player)
    return inVehicle(player) or (M.actor and inVehicle(M.actor))
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
local function postHide(id)
    pcall(function()
        board():SetVariant(Game.GetAllBlackboardDefs().UIGameData.HideDialogLine,
            ToVariant({id}, 'array:CRUID'), true)
    end)
end
-- A dialogue page being replaced stays up until its successor has rendered,
-- so a page change swaps lines without an empty frame.
local function retire()
    local old = M.retiring
    M.retiring = nil
    if old then postHide(old.id) end
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
    if line then postHide(line.id) end
end

function M.configure(options)
    M.styleProvider = options and options.style
    if options and options.mark ~= nil then M.markProvider = options.mark end
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
    M.timedIdle = nil
    M.paginationStyle = nil
    M.pageRanges, M.vehicleReadThrough = nil, nil
    M.placement = nil
    M.anchor, M.projectionReady, M.pendingProjection, M.rootVisibility = nil, nil, nil, nil
    M.revealAfterFrame = nil
    M.lingering, M.lineLost, M.restores, M.retiring = nil, nil, nil, nil
    M.live, M.liveOwner = nil, nil
    -- Pure Lua: no native call (the font records hold plain values, never a widget).
    M.fontCode, M.fontController = nil, nil
    if M.fontScope then M.fontScope.clear() end
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
    retire()
    hideLine()
    restoreFont()
    M.abandon()
end
function M.clearEntity(entity)
    if entity ~= nil and entity == M.entity then M.clear(); return true end
    return false
end
function M.ownsUtterance()
    -- A retired widget can be waiting for an unread page or streamed text.
    -- Ownership ends on clear/abandon, not when its current root is hidden.
    -- A reading hold after the audio has finished owns nothing: the next
    -- speaker, turn or reaction replaces it at once.
    if M.lingering then return false end
    -- V's own live words are not a reply: they own no utterance.
    if M.live then return false end
    return M.pages ~= nil or M.timed ~= nil or M.line ~= nil
end

-- Keep normal sentences together. Only wrap when a line actually exceeds the
-- native layout budget; short sentences and commas do not force a new page.
-- Preserve UTF-8 even in CJK text without spaces or unusually long words.
local function clean(text)
    -- Natural speech: a voice tag such as [laughter] is for the voice engine, never for the reader. The bridge
    -- already removes them; this keeps one that slipped through off the screen.
    text = text:gsub('%s*%[%a[%a%-]*%]', '')
    -- Expressive emotions: {joy}, {anger:strong} and the other feeling tags are for the face, never for the reader.
    for _, name in ipairs(EMOTION_TAGS) do
        text = text:gsub('%s*{' .. name .. '}', ''):gsub('%s*{' .. name .. ':%a+}', '')
    end
    return (text:gsub('%s+', ' '):match('^%s*(.-)%s*$'))
end
local function length(text)
    local count = 0
    for _ in text:gmatch(UTF8) do count = count + 1 end
    return count
end
function M.split(text, style)
    if type(text) ~= 'string' then return {}, {} end
    text = clean(text)
    local chars, pages, ranges = {}, {}, {}
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
        if page ~= '' then
            pages[#pages + 1] = page
            ranges[#pages] = {start = start, finish = finish}
        end
        start = finish + 1
        while chars[start] == ' ' do start = start + 1 end
    end
    return pages, ranges
end

-- Audio-aligned cues (bridge/caption-cues.mjs): one sentence each, with the
-- audio second its speech begins (nil until the bridge knows) and, when known,
-- ends. Whole sentences share a page within the style's layout budget, so a
-- page changes only where speech pauses between sentences. A sentence longer
-- than a page is split by M.split; its parts are timed by character share of
-- that sentence's own audio span (an unknown end assumes 15 characters/s).
local CUE_CHARS_PER_SECOND = 15
function M.cues(captions)
    if type(captions) ~= 'table' or captions.version ~= 1 or type(captions.cues) ~= 'table' then return nil end
    local list, previous, unknown = {}, 0, false
    for index, cue in ipairs(captions.cues) do
        if index > 64 or type(cue) ~= 'table' or type(cue.text) ~= 'string' or #cue.text > 12000 then return nil end
        local start = finite(cue.start) and cue.start or nil
        if index == 1 then start = 0 end
        if start and (start < previous or start > 120) then return nil end
        -- Boundaries are ordered: one that is not yet known hides every later one.
        if unknown or not start then start, unknown = nil, true end
        local finish = finite(cue.finish) and start and cue.finish >= start and cue.finish <= 120 and cue.finish or nil
        list[index] = {text = cue.text, start = start, finish = finish}
        previous = start or previous
    end
    return #list > 0 and list or nil
end
local function cuePages(cues, style)
    local budget = style == 'overhead' and 120 or 160
    local pages, ranges, starts, open, offset = {}, {}, {}, nil, 0
    local function add(text, from, to, start)
        local index = #pages + 1
        pages[index], ranges[index], starts[index] = text, {start = from, finish = to}, start
    end
    local function flush()
        if open then add(open.text, open.from, open.to, open.start); open = nil end
    end
    for index, cue in ipairs(cues) do
        local text = clean(cue.text)
        local chars = length(text)
        if chars > 0 then
            -- Ranges index the cue texts joined by single spaces.
            local from = offset + 1
            if open and open.chars + 1 + chars <= budget then
                open.text, open.chars, open.to = open.text .. ' ' .. text, open.chars + 1 + chars, from + chars - 1
            elseif chars <= budget then
                flush()
                open = {text = text, chars = chars, from = from, to = from + chars - 1, start = cue.start}
            else
                flush()
                local parts, partRanges = M.split(text, style)
                local finish = cue.finish or (cues[index + 1] and cues[index + 1].start)
                for part, value in ipairs(parts) do
                    local range, at = partRanges[part], nil
                    if cue.start then
                        local before = range.start - 1
                        if part == 1 then at = cue.start
                        elseif finish and finish > cue.start then at = cue.start + (finish - cue.start) * before / chars
                        else at = cue.start + before / CUE_CHARS_PER_SECOND end
                    end
                    add(value, from + range.start - 1, from + range.finish - 1, at)
                end
            end
            offset = offset + chars + 1
        end
    end
    flush()
    return pages, ranges, starts
end
-- Page boundaries for one timed utterance: from cues when the bridge sends
-- them, else by character share of the playback duration (Omni phrases and
-- older producers).
local function layout(text, duration, cues, style)
    if cues then
        local pages, ranges, starts = cuePages(cues, style)
        if #pages > 0 then return pages, ranges, {duration = duration, starts = starts, position = 0} end
    end
    local pages, ranges = M.split(text, style)
    local weights, total = {}, 0
    for index, page in ipairs(pages) do
        total = total + length(page)
        weights[index] = total
    end
    return pages, ranges, {duration = duration, weights = weights, total = total, position = 0}
end
-- The page whose audio has started at this heard position. Cue pages wait at
-- an unknown boundary rather than guess ahead of the voice.
local function targetPage(timed, position, count)
    local target = 1
    if timed.starts then
        while target < count do
            local at = timed.starts[target + 1]
            if not at or position < at then break end
            target = target + 1
        end
        return target
    end
    while target < count and position >= timed.duration * timed.weights[target] / timed.total do target = target + 1 end
    return target
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
    styleFont(controller)
    if M.rendered then M.rendered.text = text end
    M.textUpdates = (M.textUpdates or 0) + 1
    return true
end

local function showPage()
    if M.actor and not validActor(M.actor, M.entity) then M.clear(); return false end
    local text = M.pages[M.page]
    if M.vehicleReadThrough then
        -- Boarding retires text already presented overhead, not the utterance.
        -- A growing transcript can move that text across page boundaries, so
        -- retain its character frontier rather than suppressing a page number.
        local range = M.pageRanges[M.page]
        local skip = M.vehicleReadThrough - range.start + 1
        if skip > 0 then
            local chars = {}
            for char in text:gmatch(UTF8) do chars[#chars + 1] = char end
            text = table.concat(chars, '', math.min(skip + 1, #chars + 1)):match('^%s*(.-)%s*$')
        end
        if text == '' then
            hideLine()
            M.remaining = pageDuration(M.pages[M.page])
            return true
        end
    end
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
    -- Dialogue HUD: the replaced page is hidden once the new one renders.
    retire()
    local replaced = M.mode ~= 'overhead' and M.line and M.line.id or nil
    if replaced then M.line = nil end
    hideLine()
    M.serial = M.serial + 1
    local line = scnDialogLineData.new()
    line.id = CRUID(0x436F6E760000 + M.serial)
    line.type = M.mode == 'overhead' and scnDialogLineType.OverHead or scnDialogLineType.OwnerlessRegular
    -- A holocall reply uses the game's call line (scnDialogLineType.Holocall: the main subtitle line with the caller's
    -- name, which the game shows only for a line with a speaker).
    if M.holocall == true and M.mode ~= 'overhead' and (M.actor or M.liveOwner) and scnDialogLineType.Holocall then
        line.type = scnDialogLineType.Holocall
    end
    -- The exact speaker owns the HUD line too. The native HUD's removal by
    -- data drops every line without an owner whenever any other line ends;
    -- with an owner it drops ours only for this speaker's own native line.
    -- V's live words have no speaking actor: the player owns the line, and a nil is never assigned to the native field.
    local owner = M.actor or M.liveOwner
    if owner then line.speaker = owner end
    line.speakerName, line.text, line.isPersistent = M.speaker, text, false
    line.duration = duration
    M.line, M.remaining = line, line.duration
    board():SetVariant(Game.GetAllBlackboardDefs().UIGameData.ShowDialogLine,
        ToVariant({line}, 'array:scnDialogLineData'), true)
    if replaced then M.retiring = {id = replaced, wait = .25} end
    return true
end

local function prepare(speaker, text, actor, expected)
    M.clear()
    if not M.enabled() then return false end
    M.requestedStyle, M.fallback = M.style(), nil
    M.entity = type(expected) == 'string' and expected or nil
    if validActor(actor, expected) then M.actor = actor end
    M.mode = M.requestedStyle
    -- A speaker without a body (an add-on's voice, set by speech.lua for each reply) uses the cinematic dialogue line: there
    -- is no head for an overhead caption. When its anchor is not a character, V owns the line, as with V's live words.
    if M.voiceOnly == true then
        M.mode, M.fallback = 'dialogue', 'voice-only'
        if not M.actor then M.liveOwner = Game.GetPlayer() end
    end
    -- A holocall (mod/holocall.lua): the speaker is on the phone, never overhead. V owns the line when the speaker has
    -- no body here (a voice call) or the live picture's copy is far away.
    if M.holocall == true then
        M.mode, M.fallback = 'dialogue', 'holocall'
        if not M.actor then M.liveOwner = Game.GetPlayer() end
    end
    if M.mode == 'overhead' and vehicleConversation(Game.GetPlayer()) then
        M.mode, M.fallback = 'dialogue', 'vehicle-interior'
    end
    if M.mode == 'overhead' then
        local ok, visible = pcall(function()
            return UserSettings.new():GetVar('/accessibility/subtitles', 'Overheads'):GetValue()
        end)
        if not M.actor then M.mode, M.fallback = 'dialogue', 'speaker-unavailable'
        elseif not ok or visible ~= true then M.mode, M.fallback = 'dialogue', 'native-overheads-disabled' end
    end
    if M.mode == 'overhead' then
        M.anchor = headAnchor(M.actor)
        -- The projection guards (install) go in before the first owned overhead line is drawn.
        if M.ensureProjectionGuards then
            local guarded, guardError = pcall(M.ensureProjectionGuards)
            if not guarded then M.projectionGuardError = tostring(guardError) end
        end
    end
    M.paginationStyle = M.mode
    M.pages, M.pageRanges = M.split(text, M.paginationStyle)
    if #M.pages == 0 then M.abandon(); return false end
    M.fontCode = replyFont(text)
    -- An add-on speaker's own line (voiceOnly, set by speech.lua for each reply) may carry a small tag after its name.
    if M.voiceOnly == true and M.voiceProfile and M.markProvider then
        local ok, marked = pcall(M.markProvider, M.voiceProfile, speaker)
        if ok and type(marked) == 'string' then speaker = marked end
    end
    M.playerID, M.speaker, M.page = identity(Game.GetPlayer()), speaker, 1
    return true
end

function M.show(speaker, text, actor, expected)
    if prepare(speaker, text, actor, expected) then return showPage() end
    return false
end
-- V's own words while V speaks by voice, shown as one dialogue-HUD line that is replaced as the recognised words grow.
-- Each update is the same page swap a paginated reply uses (the old line is hidden once the new one has rendered, so
-- there is no empty frame); it runs only when new words arrive, never per frame. The next reply's caption (show or
-- beginTimed) clears it, and with no update it expires on its own like any caption. Returns false when subtitles are
-- off or the text is empty, so the caller can fall back to a notice.
function M.showLive(speaker, text)
    if type(text) ~= 'string' then return false end
    text = clean(text)
    if text == '' or not M.enabled() then return false end
    if M.live and M.playerID and identity(Game.GetPlayer()) ~= M.playerID then M.clear() end
    if not M.live then
        -- V's own words never carry an add-on speaker's tag, and are never a voice-only or holocall line: speech.lua sets these for each
        -- reply and clears its own copy at the end of one, so the last reply's flags are still here when V next speaks.
        M.voiceProfile, M.voiceOnly, M.holocall = nil, false, false
        if not prepare(speaker, text, nil, nil) then return false end
        -- Always the cinematic dialogue HUD, whatever style replies use: V has no head to hang an overhead caption on.
        M.mode, M.fallback, M.anchor, M.paginationStyle = 'dialogue', nil, nil, 'dialogue'
        M.pages, M.pageRanges = M.split(text, 'dialogue')
        if #M.pages == 0 then M.abandon(); return false end
        local player = Game.GetPlayer()
        M.live, M.liveOwner = true, player
    else
        local pages, ranges = M.split(text, M.paginationStyle or 'dialogue')
        if #pages == 0 then return false end
        M.pages, M.pageRanges = pages, ranges
        M.fontCode = replyFont(text)
    end
    M.page = #M.pages
    local shown = showPage()
    if shown and M.remaining then M.remaining = math.max(M.remaining, 6) end
    return shown
end
-- V's typed line, shown as V's own line in the cinematic subtitles while V's voice speaks it (docs/V_VOICE.md, "V's subtitle"). Like
-- the live words it is one dialogue-HUD line that V owns, which owns no utterance and is replaced at once by the next caption
-- (a reply's show or beginTimed clears it first), so the companion's subtitle never starts beneath it. Unlike the live words it is
-- complete: it starts on its first page and the pages advance by the ordinary reading time (about 2.8 words a second, the pace of the
-- spoken line, 3.5 seconds at least); a short line is gone on its own after that. It runs once, when the line is sent, and costs
-- nothing per frame beyond what a caption already does. Returns false when subtitles are off or the text is empty.
function M.showTyped(text)
    if type(text) ~= 'string' then return false end
    text = clean(text)
    if text == '' or not M.enabled() then return false end
    -- Never a reply's flags: speech.lua leaves the last reply's voice-only and holocall marks here.
    M.voiceProfile, M.voiceOnly, M.holocall = nil, false, false
    if not prepare('V', text, nil, nil) then return false end
    M.mode, M.fallback, M.anchor, M.paginationStyle = 'dialogue', nil, nil, 'dialogue'
    M.pages, M.pageRanges = M.split(text, 'dialogue')
    if #M.pages == 0 then M.abandon(); return false end
    M.live, M.liveOwner = true, Game.GetPlayer()
    M.page = 1
    return showPage()
end
function M.beginTimed(speaker, text, duration, actor, expected, captions)
    if not finite(duration) or duration <= 0 or duration > 120 then return M.show(speaker, text, actor, expected) end
    if not prepare(speaker, text, actor, expected) then return false end
    -- Only the heard playback cursor advances pages, so a pause or a stalled
    -- stream holds the current page. Cue pages change where the audio does;
    -- otherwise boundaries are estimated within this audio's duration.
    M.pages, M.pageRanges, M.timed = layout(text, duration, M.cues(captions), M.paginationStyle)
    M.timedIdle = 0
    return showPage()
end
function M.reviseTimed(text, duration, position, captions)
    -- A growing realtime transcript belongs to the same utterance. Updating
    -- its text or final duration must not briefly render the first page again.
    if not M.timed or not finite(duration) or duration <= 0 or duration > 120
        or not finite(position) or position < 0 then return false end
    if M.playerID and identity(Game.GetPlayer()) ~= M.playerID then M.abandon(); return false end
    if not M.enabled() or (M.actor and not validActor(M.actor, M.entity)) then M.clear(); return false end
    -- Switching an ongoing utterance from overhead to the cabin HUD must not
    -- change page boundaries on the next streamed transcript revision.
    local pages, ranges, timed = layout(text, duration, M.cues(captions), M.paginationStyle or M.mode)
    if #pages == 0 then return false end
    M.fontCode = replyFont(text)
    local oldText, oldPage = M.pages[M.page], M.page
    local target = targetPage(timed, position, #pages)
    -- A duration estimate becoming more accurate is not a reason to replay a
    -- page which the player has already read.
    M.page = math.max(math.min(oldPage, #pages), target)
    timed.position, timed.pageFloor = math.min(position, duration), M.page
    M.pages, M.pageRanges, M.timed = pages, ranges, timed
    M.timedIdle = 0
    if not M.line or pages[M.page] ~= oldText or M.page ~= oldPage then return showPage() end
    -- A PCM duration estimate is not a new caption. Its local timing changes,
    -- but its text/widget/anchor remain untouched while the voice continues.
    M.line.duration = duration + 1
    return true
end
function M.syncTimed(position)
    if not M.timed or not finite(position) or position < 0 then return end
    if M.actor and not validActor(M.actor, M.entity) then M.clear(); return end
    M.timedIdle = 0
    M.timed.position = math.min(position, M.timed.duration)
    local target = targetPage(M.timed, position, #M.pages)
    if M.timed.pageFloor then target = math.max(target, M.timed.pageFloor); M.timed.pageFloor = target end
    if target ~= M.page then M.page = target; showPage() end
end
-- The audio has finished (or one Omni phrase has, while the next renders).
-- Keep the heard page up for a short reading hold instead of removing it at
-- the last sample. It owns nothing: any new caption replaces it immediately.
function M.linger(seconds)
    if not M.line or not M.pages or not finite(seconds) or seconds <= 0 then M.clear(); return false end
    M.timed, M.lingering, M.remaining = nil, true, math.min(seconds, 5)
    return true
end
function M.update(delta)
    M.frameSerial = (M.frameSerial or 0) + 1
    if M.retiring then
        M.retiring.wait = M.retiring.wait - (finite(delta) and math.max(0, delta) or 0)
        if M.retiring.wait <= 0 then retire() end
    end
    if not M.pages then return end
    local ok, player = pcall(function() return Game.GetPlayer() end)
    if not ok or not player or (M.playerID and identity(player) ~= M.playerID) then M.abandon(); return end
    if not M.enabled() or (M.actor and not validActor(M.actor, M.entity)) then M.clear(); return end
    if M.mode == 'overhead' and vehicleConversation(player) then
        -- The player has already seen this page on foot. Retire its root and
        -- preserve progress; only unread continuation text may enter the HUD.
        local remaining = M.remaining
        M.vehicleReadThrough = M.pageRanges[M.page].finish
        hideLine()
        M.mode, M.fallback, M.anchor = 'dialogue', 'vehicle-interior', nil
        M.remaining = remaining
        -- Keep this utterance's renderer if V exits midway. The next reply
        -- reevaluates the saved style without rewriting that preference.
    end
    if ownedController(M.controller) then
        M.projectionFrames = (M.projectionFrames or 0) + 1
        settleProjection(M.controller, projectionVisible(M.controller))
    end
    if M.lineLost then
        -- The native HUD's HideDialogLineByData removes every ownerless line,
        -- including ours, whenever the game ends some other line by data. The
        -- reply is still being heard: present the same page again.
        M.lineLost = nil
        if M.line and M.mode ~= 'overhead' and (M.restores or 0) < 20 then
            local remaining = M.remaining
            M.restores = (M.restores or 0) + 1
            showPage()
            M.remaining = remaining
        end
    end
    if M.timed then
        -- The driver's page changes and end are event-driven (syncTimed, linger, clear); this is only the safety net for a driver that
        -- went away. One addition per frame, no native read.
        -- One frame counts at most a quarter second, so a single long hitch (a load, an autosave) is never mistaken for a dead driver.
        M.timedIdle = (M.timedIdle or 0) + (finite(delta) and math.min(.25, math.max(0, delta)) or 0)
        if M.timedIdle >= TIMED_STALL then
            -- A menu pauses the driver too (it syncs nothing while paused): ask the game only now, never per frame.
            local defs = Game.GetAllBlackboardDefs()
            if Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) then M.timedIdle = 0
            else M.stalledClears = (M.stalledClears or 0) + 1; M.clear() end
        end
        return
    end
    local defs = Game.GetAllBlackboardDefs()
    if Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) then return end
    M.remaining = M.remaining - (finite(delta) and math.max(0, delta) or 0)
    if M.lingering then
        if M.remaining <= 0 then M.clear() end
        return
    end
    if M.remaining > 0 then return end
    if M.page >= #M.pages then M.clear(); return end
    M.page = M.page + 1
    showPage()
end

function M.install()
    if M.hooksVersion == 11 then return true end
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
                styleFont(controller)
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
            styleFont(controller)
        end
    end)
    -- Native removal by data clears every ownerless HUD line, and a stale
    -- pending hide removes a line as it spawns. Our own hide clears M.line
    -- before the delayed callback runs, so a removal of the exact current
    -- dialogue line is never ours: update() presents the same page again.
    local function removal(kind)
        return function(_, entry)
            local ok, id = pcall(function() return tostring(entry.id) end)
            if ok and M.line and M.mode ~= 'overhead' and id == tostring(M.line.id) then
                M.nativeRemovals, M.lineLost = (M.nativeRemovals or 0) + 1, true
                M[kind] = (M[kind] or 0) + 1
            end
        end
    end
    pcall(ObserveAfter, 'SubtitlesGameController', 'OnHideLineByData', removal('removedByData'))
    pcall(ObserveAfter, 'SubtitlesGameController', 'OnHideLine', removal('removedOnHide'))
    -- The new dialogue page has its text: now hide the page it replaces.
    pcall(ObserveAfter, 'SubtitleLineLogicController', 'SetLineData', function(controller, line)
        -- A reply in a script the game's font lacks: the dialogue line the game just drew gets the family of its text.
        if M.fontCode and M.line and M.mode ~= 'overhead' then
            local same, id = pcall(function() return tostring(line.id) end)
            if same and id == tostring(M.line.id) then styleFont(controller) end
        end
        if not M.retiring or not M.line then return end
        local ok, id = pcall(function() return tostring(line.id) end)
        if ok and id == tostring(M.line.id) then retire() end
    end)
    -- Other crowd chatter can be closer to screen centre. Keep this exact
    -- owned line readable; every other controller retains the native behavior.
    -- These two Overrides run for every visible chatter line of every NPC, every frame, and CET pays its trampoline even
    -- when the handler passes straight through. Only an owned overhead line needs them, so they are registered when the
    -- first overhead caption is prepared (prepare(), before its line reaches the native HUD), never at load: a session
    -- that shows no overhead caption does not pay for them. Registered once; CET cannot withdraw a hook.
    M.projectionGuardsInstalled = false
    M.ensureProjectionGuards = nil
    if guardsProjection then
        M.ensureProjectionGuards = function()
            if M.projectionGuardsInstalled then return true end
            M.projectionGuardsInstalled = true
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
            return true
        end
    end
    M.hooksInstalled, M.hooksVersion = true, 11
    return true
end
function M.status()
    return {active = M.line ~= nil, serial = M.serial, page = M.page, pages = M.pages and #M.pages or 0,
        mode = M.mode, requestedStyle = M.requestedStyle, fallback = M.fallback, entity = M.entity,
        timed = M.timed ~= nil, position = M.timed and M.timed.position, rendered = M.rendered,
        cueTimed = M.timed ~= nil and M.timed.starts ~= nil, lingering = M.lingering == true,
        nativeRemovals = M.nativeRemovals or 0, restores = M.restores or 0,
        removedByData = M.removedByData or 0, removedOnHide = M.removedOnHide or 0, retiring = M.retiring ~= nil,
        bubbleOverrides = M.bubbleOverrides or 0, projectionReady = M.projectionReady == true,
        projectionCallbacks = M.projectionCallbacks or 0, projectionFrames = M.projectionFrames or 0,
        textUpdates = M.textUpdates or 0, renderUpdateError = M.renderUpdateError,
        projectionError = M.projectionError, renderVisibilityError = M.renderVisibilityError,
        projectionGuards = M.projectionGuardsInstalled == true, projectionGuardError = M.projectionGuardError}
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
