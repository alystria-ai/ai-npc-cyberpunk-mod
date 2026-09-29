local M = convaiComposerInput or {patched = 0}

function M.apply(controller)
    M.seen = (M.seen or 0) + 1
    local data = controller:GetRootWidget():GetUserData('GenericMessageNotificationData')
    M.lastTitle = data and data.title or 'no data'
    if not data or data.title:sub(1, 8) ~= 'TALK TO '
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
        input:SetDefaultText(data.message)
        M.patched = M.patched + 1
        M.lastCase = tostring(input:GetLetterCase())
        M.lastPlaceholder = input:GetDefaultText()
        M.lastError = nil
    else
        M.lastError = 'TextInput controller not found'
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
