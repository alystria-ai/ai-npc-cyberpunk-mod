local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end
local M = convaiComposerInput or {patched = 0}
local locale = convaiUiLocale
if type(locale) ~= 'table' then
    local ok, loaded = pcall(dofile, 'ui-locale.lua')
    locale = ok and type(loaded) == 'table' and loaded or nil
end
local fontLibrary = convaiUiFonts
if type(fontLibrary) ~= 'table' then
    local ok, loaded = pcall(dofile, 'ui-fonts.lua')
    fontLibrary = ok and type(loaded) == 'table' and loaded or nil
end
local fonts = M.fontScope
if not fonts and fontLibrary and type(fontLibrary.new) == 'function' then
    fonts = fontLibrary.new()
    M.fontScope, M.fontDirty = fonts, true
end
local function revision()
    return locale and type(locale.revision) == 'function' and locale.revision() or 0
end

local function find(root, name, depth, budget)
    if not root or depth < 0 or budget.left <= 0 then return end
    budget.left = budget.left - 1
    if root:GetName() == CName.new(name) then return root end
    if depth == 0 then return end
    local ok, count = pcall(function() return root:GetNumChildren() end)
    if ok then
        for i = 0, count - 1 do
            if budget.left <= 0 then break end
            local found = find(root:GetWidgetByIndex(i), name, depth - 1, budget)
            if found then return found end
        end
    end
end

-- Which of the mod's two boxes a notification is: 'talk' (Composer.reds ConvaiOpenComposer) or 'search' (ConvaiOpenSearchBox, the Companion
-- Manager's Search characters box), by the English title and message the scripts gave it; nil for any other notification.
local function boxKind(data)
    if not data or type(data.title) ~= 'string' then return nil end
    if data.title:sub(1, 8) == 'TALK TO ' and data.message == 'Type your message to the character.' then return 'talk' end
    if data.title == 'Search characters' and data.message == 'Type part of a name.' then return 'search' end
end
local function ownedData(controller)
    local data = controller:GetRootWidget():GetUserData('GenericMessageNotificationData')
    if boxKind(data) then return data end
end

-- Shared by the owned phone composer. Called only from a top-level scan after
-- creation. Codeware caches glyph widths without a font key or reset API; a
-- prepared or deferred input must keep its family until the input is recreated.
function M.fontInput(input, scope, code)
    if not input or not scope then return false end
    local root = input:GetRootWidget()
    local visible = find(root, 'text', 4, {left = 40})
    local shadow = find(root, 'shadow', 1, {left = 20})
    if not visible or not shadow then return false end
    local marker = find(root, 'convaiInputFontLifetime', 1, {left = 20})
    if marker then
        if scope.touch then scope.touch(visible); scope.touch(shadow) end
        return marker:GetState() == CName.new('fontPrepared')
    end
    local measurer = shadow:GetController()
    if not measurer then return false end
    local ok, fresh = pcall(function()
        return input:GetText() == '' and not measurer:IsMeasuring()
            and measurer:GetTargetText() == '' and measurer:GetTargetLength() == 0
    end)
    marker = inkCanvas.new()
    marker:SetName(CName.new('convaiInputFontLifetime'))
    marker:SetSize(Vector2.new({X = 0, Y = 0}))
    marker:SetVisible(false)
    marker:SetAffectsLayoutWhenHidden(false)
    marker:SetState(CName.new('fontDeferred'))
    marker:Reparent(root, -1)
    if not ok or not fresh then return false end
    -- Both widgets use the same resolved interface family. The empty text
    -- override disables autonym inference on a future typed value/placeholder.
    local allowed, canApply = pcall(function()
        return scope.canApply(visible, code, '') and scope.canApply(shadow, code, '')
    end)
    if not allowed or not canApply then return false end
    local shadowOk = pcall(scope.apply, shadow, code, '')
    if not shadowOk then
        pcall(scope.restore, shadow)
        return false
    end
    local visibleOk = pcall(scope.apply, visible, code, '')
    if not visibleOk then
        pcall(scope.restore, visible); pcall(scope.restore, shadow)
        return false
    end
    marker:SetState(CName.new('fontPrepared'))
    return true
end
local function text(source, args)
    if locale and type(locale.t) == 'function' then return locale.t(source, args) end
    -- Preserve the existing English UI during a staged install without locale.
    return (source:gsub('{([%w_]+)}', function(key)
        return args and args[key] ~= nil and tostring(args[key]) or '{' .. key .. '}'
    end))
end

local function messageWidget(controller)
    local widget = controller.m_message and inkWidgetRef and inkWidgetRef.Get(controller.m_message)
    if widget and widget:IsA('inkTextWidget') then return widget end
    if controller.GetChildWidgetByPath then
        -- Like the phone breadcrumb, the real compiled message ref is not
        -- exposed to CET. This is the inspected native notification path.
        widget = controller:GetChildWidgetByPath(CName.new('notification/main/inkVerticalPanelWidget18/message'))
    end
    -- This getter returns the root canvas for an unresolved child path in CET.
    -- Validate the resolved type before using it as the message label.
    if widget and widget:IsA('inkTextWidget') then return widget end
    return find(controller:GetRootWidget(), 'message', 8, {left=96})
end

-- Padding, in the dialog's own 3840x2160 ink units: the title-to-box gap the hidden message line used to leave, and
-- room between the box's left border and the typed text.
local TITLE_GAP = 44
local TEXT_PAD_LEFT = 20

-- Raises one side of a widget's margin to at least `value`, leaving the other sides alone. A larger native margin is
-- never lowered, so applying it again (language change, the next OnInitialize) changes nothing.
function M.raiseMargin(widget, side, value)
    local margin = widget:GetMargin()
    if not margin or (tonumber(margin[side]) or 0) >= value then return false end
    margin[side] = value
    widget:SetMargin(margin)
    return true
end

-- The visible text of the Codeware input sits flush against the box's left edge. Its direct parent is the clipping
-- viewport that holds the text, so padding that parent moves the typed text; the box itself stays put.
function M.padInputText(input)
    local root = input and input:GetRootWidget()
    local visible = root and find(root, 'text', 4, {left = 40})
    local holder = visible and visible.GetParentWidget and visible:GetParentWidget()
    if not holder or holder == root or not holder.GetMargin then return false end
    return M.raiseMargin(holder, 'left', TEXT_PAD_LEFT)
end

local function localizePresentation(controller, data)
    -- Codeware's own input wrapper uses this exact native title path. Change
    -- rendered text only: the English notification data remains our ownership
    -- marker on later callbacks and is never written back from a translation.
    if controller.GetChildWidgetByPath then
        local title = controller:GetChildWidgetByPath(CName.new('notification/main/inkVerticalPanelWidget18/title'))
        if title then
            title:SetText(boxKind(data) == 'search' and text('Search characters') or text('TALK TO {character}', {character = data.title:sub(9)}))
        end
    end
    -- The dialog's message line ("Type your message to the character.") is not shown: it is emptied and hidden, and
    -- stops taking room in the dialog's vertical layout. The English notification data keeps the sentence as the
    -- ownership marker. The gap that line left under the title is given back as a bottom margin on the title (a direct
    -- child of the same vertical panel), so the box never sits on the title.
    local message = messageWidget(controller)
    if message then
        message:SetText('')
        pcall(function() message:SetAffectsLayoutWhenHidden(false) end)
        message:SetVisible(false)
    end
    if controller.GetChildWidgetByPath then
        local title = controller:GetChildWidgetByPath(CName.new('notification/main/inkVerticalPanelWidget18/title'))
        if title and title.GetMargin then M.raiseMargin(title, 'bottom', TITLE_GAP) end
    end
end

-- The stock notification library draws three full-screen siblings of the dialog
-- (a dark soft shadow, a red edge-gradient and a 0.7-opacity dark fader), and
-- the controller may also request the modal background blur. The composer should
-- show only its text box over the live game. The intro animation only drives
-- opacity/translation, so visibility stays off once set.
local BACKDROP = {'Shadow', 'bg1', 'fader'}
-- Frames after the composer opens at which the backdrop is released once more,
-- in case the native show sequence re-enabled it. Two bounded scans in total;
-- idle frames never traverse native controllers.
local BACKDROP_RECHECK = {20, 60}

-- The stock layout puts the dialog 600/2160 from the top (about dead centre).
-- Dock it as a chat bar instead: horizontally centred, its bottom edge a fixed
-- fraction of the live root height above the bottom, so the box sits roughly
-- 70-80% of the way down and clear of the bottom HUD and corner icons. Anchoring
-- to the bottom makes this independent of the dialog's own height; every figure
-- derives from the root's current size, never from fixed pixels.
local BOTTOM_GAP = 0.14
local REFERENCE_HEIGHT = 2160

function M.placeDialog(controller)
    local root = controller:GetRootWidget()
    local dialog = find(root, 'notification', 1, {left = 48})
    if not dialog or dialog == root then return false end
    local height = REFERENCE_HEIGHT
    local ok, y = pcall(function() return tonumber(root:GetSize().Y) end)
    if ok and y and y >= 360 and y <= 8640 then height = y end
    local gap = math.floor(height * BOTTOM_GAP + 0.5)
    dialog:SetAnchor(inkEAnchor.BottomCenter)
    dialog:SetAnchorPoint(Vector2.new({X = 0.5, Y = 1.0}))
    dialog:SetMargin(inkMargin.new({left = 0, top = 0, right = 0, bottom = gap}))
    M.lastPlacement = {height = height, gap = gap}
    return true
end

function M.clearBackdrop(controller)
    local root = controller:GetRootWidget()
    local hidden = 0
    for _, name in ipairs(BACKDROP) do
        -- Direct children of the notification root only; never the dialog itself.
        local widget = find(root, name, 1, {left = 48})
        if widget and widget ~= root then
            if widget:IsVisible() then hidden = hidden + 1 end
            widget:SetVisible(false)
        end
    end
    -- Modal popups ask the engine to blur the world behind them. Releasing it is
    -- harmless when this controller never requested it.
    local ok, err = pcall(function() PopupStateUtils.SetBackgroundBlur(controller, false) end)
    M.lastBlurRelease = ok and 'ok' or tostring(err)
    M.backdropHidden = (M.backdropHidden or 0) + hidden
    return hidden
end

function M.apply(controller)
    M.fontDirty = true
    M.seen = (M.seen or 0) + 1
    local data = controller:GetRootWidget():GetUserData('GenericMessageNotificationData')
    M.lastTitle = data and data.title or 'no data'
    local kind = boxKind(data)
    if not kind then return end
    -- A Search characters box that really came up: mod/manager-ui.lua asks (M.searchShownAt) before it believes the box is on screen.
    if kind == 'search' then M.searchShownAt = os.clock() end
    local backdropOk, backdropErr = pcall(M.clearBackdrop, controller)
    if not backdropOk then M.lastBackdropError = tostring(backdropErr) end
    local placeOk, placeErr = pcall(M.placeDialog, controller)
    if not placeOk then M.lastPlacementError = tostring(placeErr) end
    -- The native layer can finish its own show sequence after OnInitialize; keep
    -- re-asserting twice from update() (see below).
    M.backdropAge = 0
    -- Codeware's generic input forces UpperCase, including the submitted text.
    -- Change only our composer; retain the native title/button typography.
    local input = controller.m_textInput
    if not input then
        local function find(widget, depth)
            if not widget or depth > 12 then return nil end
            if widget:GetName() == CName.new('TextInput') then return widget:GetController() end
            local ok, count = pcall(function() return widget:GetNumChildren() end)
            if ok then
                for i = 0, count - 1 do
                    local found = find(widget:GetWidgetByIndex(i), depth + 1)
                    if found then return found end
                end
            end
        end
        input = find(controller:GetRootWidget(), 0)
    end
    if input then
        input:SetLetterCase(textLetterCase.OriginalCase)
        -- F6/F8 are immediately ready for typing. The box has no placeholder text and the dialog's message line above
        -- it is hidden (localizePresentation). SetDefaultText changes only the hint, never an existing typed draft.
        input:SetDefaultText(kind == 'search' and text('Type part of a name') or '')
        pcall(M.padInputText, input)
        -- The talk key opened this box with words left unsent last time: they are put back (init.lua beginTextNow sets the flag).
        if kind == 'talk' and M.restoreDraft then
            M.restoreDraft = nil
            pcall(M.putDraft, input)
        end
        M.patched = M.patched + 1
        M.lastCase = tostring(input:GetLetterCase())
        M.lastPlaceholder = input:GetDefaultText()
        M.lastError = nil
    else
        M.lastError = 'TextInput controller not found'
    end
    local ok, err = pcall(localizePresentation, controller, data)
    if not ok then M.lastError = tostring(err) end
end

function M.applyFonts(controller)
    if not fonts or not ownedData(controller) then return end
    if controller.GetChildWidgetByPath then
        local title = controller:GetChildWidgetByPath(CName.new('notification/main/inkVerticalPanelWidget18/title'))
        if title then fonts.apply(title, nil, '') end
    end
    local hint = messageWidget(controller)
    if hint then fonts.apply(hint, nil, '') end
    local input = controller.m_textInput
    if not input then
        local root = find(controller:GetRootWidget(), 'TextInput', 12, {left = 128})
        input = root and root:GetController()
    end
    M.fontInput(input, fonts)
end

-- Bounded walk over the current ink layers. Native notification controllers can
-- follow more than 128 stock HUD controllers; use the same allowance as the
-- phone adapter. Keeps no native handle after the walk.
local function eachNotification(visit)
    local system = Game.GetInkSystem()
    if not system then return end
    local remaining = 512
    for layerIndex, layer in ipairs(system:GetLayers()) do
        if layerIndex > 24 or remaining == 0 then break end
        for _, controller in ipairs(layer:GetGameControllers()) do
            if remaining == 0 then break end
            remaining = remaining - 1
            if controller:IsA('GenericMessageNotification') then visit(controller) end
        end
    end
end

-- Called once after the interface language changes, not every frame.
function M.refresh()
    if fonts and fonts.begin then fonts.begin() end
    local ok, err = pcall(eachNotification, function(controller)
        M.apply(controller)
        M.applyFonts(controller)
    end)
    if fonts and fonts.finish then fonts.finish() end
    M.fontDirty, M.fontRevision = false, revision()
    if not ok then M.lastError = tostring(err) end
end

-- The native callbacks merely flag work. init.lua calls update() once from the
-- top-level onUpdate, where font traversal has its own bounded native budget.
function M.update()
    if M.fontDirty or M.fontRevision ~= revision() then M.refresh() end
    local age = M.backdropAge
    if age then
        age = age + 1
        M.backdropAge = age
        for _, frame in ipairs(BACKDROP_RECHECK) do
            if age == frame then
                local ok, err = pcall(eachNotification, function(controller)
                    if ownedData(controller) then
                        M.clearBackdrop(controller); pcall(M.placeDialog, controller)
                    end
                end)
                if not ok then M.lastBackdropError = tostring(err) end
            end
        end
        if age >= BACKDROP_RECHECK[#BACKDROP_RECHECK] then M.backdropAge = nil end
    end
end

-- The words left unsent by the last box (Composer.reds m_convaiDraft), shown in the box that just opened. Once per draft.
function M.putDraft(input)
    local player = convaiPlayer()
    local text = player and type(player.ConvaiTakeDraft) == 'function' and player:ConvaiTakeDraft()
    if type(text) == 'string' and text ~= '' then
        input:SetText(text)
        M.restored = #text
    end
end

function M.install()
    if M.installed then return end
    ObserveAfter('GenericMessageNotification', 'OnInitialize', function(controller)
        local ok, err = pcall(M.apply, controller)
        if not ok then M.lastError = tostring(err) end
    end)
    M.installed = true
end

convaiComposerInput = M
return M
