local M = convaiComposerInput or {patched = 0}
local locale = convaiUiLocale
if type(locale) ~= 'table' then
    local ok, loaded = pcall(dofile, 'ui-locale.lua')
    locale = ok and type(loaded) == 'table' and loaded or nil
end
local function text(source, args)
    if locale and type(locale.t) == 'function' then return locale.t(source, args) end
    -- Preserve the existing English UI during a staged install without locale.
    return (source:gsub('{([%w_]+)}', function(key)
        return args and args[key] ~= nil and tostring(args[key]) or '{' .. key .. '}'
    end))
end

local function localizePresentation(controller, data)
    -- Codeware's own input wrapper uses this exact native title path. Change
    -- rendered text only: the English notification data remains our ownership
    -- marker on later callbacks and is never written back from a translation.
    if controller.GetChildWidgetByPath then
        local title = controller:GetChildWidgetByPath(CName.new('notification/main/inkVerticalPanelWidget18/title'))
        if title then title:SetText(text('TALK TO {character}', {character = data.title:sub(9)})) end
    end
    if inkTextRef and controller.m_message then
        inkTextRef.SetText(controller.m_message, text('Type your message to the character.'))
    end
end

function M.apply(controller)
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

-- Called once after the interface language changes, not every frame. Keep no
-- native controller/widget handles after the bounded current-layer scan.
function M.refresh()
    local ok, err = pcall(function()
        local system = Game.GetInkSystem()
        if not system then return end
        local remaining = 128
        for layerIndex, layer in ipairs(system:GetLayers()) do
            if layerIndex > 24 then break end
            for _, controller in ipairs(layer:GetGameControllers()) do
                if remaining == 0 then return end
                remaining = remaining - 1
                if controller:IsA('GenericMessageNotification') then M.apply(controller) end
            end
        end
    end)
    if not ok then M.lastError = tostring(err) end
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
