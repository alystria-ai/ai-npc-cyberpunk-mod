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

local function ownedData(controller)
    local data = controller:GetRootWidget():GetUserData('GenericMessageNotificationData')
    if data and type(data.title) == 'string' and data.title:sub(1, 8) == 'TALK TO '
        and data.message == 'Type your message to the character.' then return data end
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

local function localizePresentation(controller, data)
    -- Codeware's own input wrapper uses this exact native title path. Change
    -- rendered text only: the English notification data remains our ownership
    -- marker on later callbacks and is never written back from a translation.
    if controller.GetChildWidgetByPath then
        local title = controller:GetChildWidgetByPath(CName.new('notification/main/inkVerticalPanelWidget18/title'))
        if title then title:SetText(text('TALK TO {character}', {character = data.title:sub(9)})) end
    end
    local message = messageWidget(controller)
    if message then message:SetText(text('Type your message to the character.')) end
end

function M.apply(controller)
    M.fontDirty = true
    M.seen = (M.seen or 0) + 1
    local data = controller:GetRootWidget():GetUserData('GenericMessageNotificationData')
    M.lastTitle = data and data.title or 'no data'
    if not data or type(data.title) ~= 'string' or data.title:sub(1, 8) ~= 'TALK TO '
        or data.message ~= 'Type your message to the character.' then return end
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
        -- F6/F8 are immediately ready for typing; retain their original prompt.
        -- SetDefaultText changes only the hint, never an existing typed draft.
        input:SetDefaultText(text('Type your message to the character.'))
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

-- Called once after the interface language changes, not every frame. Keep no
-- native controller/widget handles after the bounded current-layer scan.
function M.refresh()
    if fonts and fonts.begin then fonts.begin() end
    local ok, err = pcall(function()
        local system = Game.GetInkSystem()
        if not system then return end
        -- Native notification controllers can follow more than 128 stock HUD
        -- controllers; use the same bounded allowance as the phone adapter.
        local remaining = 512
        for layerIndex, layer in ipairs(system:GetLayers()) do
            if layerIndex > 24 or remaining == 0 then break end
            for _, controller in ipairs(layer:GetGameControllers()) do
                if remaining == 0 then break end
                remaining = remaining - 1
                if controller:IsA('GenericMessageNotification') then
                    M.apply(controller)
                    M.applyFonts(controller)
                end
            end
        end
    end)
    if fonts and fonts.finish then fonts.finish() end
    M.fontDirty, M.fontRevision = false, revision()
    if not ok then M.lastError = tostring(err) end
end

-- The native callbacks merely flag work. init.lua calls update() once from the
-- top-level onUpdate, where font traversal has its own bounded native budget.
function M.update()
    if M.fontDirty or M.fontRevision ~= revision() then M.refresh() end
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
