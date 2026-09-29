-- Native phone presentation, also installable into an already-open phone.
-- Keep state on the owned widgets, never in retained native widget handles.
local M = convaiPhoneChatStyle or {}
local function margin(left, top, right, bottom)
    return inkMargin.new({left = left, top = top, right = right, bottom = bottom})
end
local function size(width, height) return Vector2.new({X = width, Y = height}) end

local function find(root, name, depth)
    if not root then return end
    -- Lua-created CNames may have no reverse lookup string in the game's pool.
    if root:GetName() == CName.new(name) then return root end
    if depth <= 0 then return end
    local compound, count = pcall(function() return root:GetNumChildren() end)
    if compound then
        for i = 0, count - 1 do
            local result = find(root:GetWidgetByIndex(i), name, depth - 1)
            if result then return result end
        end
    end
end

local function safely(action, ...)
    local ok, err = pcall(action, ...)
    if not ok then M.lastError = tostring(err) end
end

function M.header(controller, index)
    local root = controller:GetRootWidget()
    local tab = find(root, 'convaiChatTab', 8)
    if not tab then return end
    local parent = tab:GetParentWidget()
    local calls = find(parent, 'callsTab', 1)
    local linePanel = find(root, 'linePanel', 8)
    local activeLine = linePanel and find(linePanel, 'line', 1)
    local baseLine = calls and find(calls, 'line', 3)
    if not activeLine or not baseLine then return end
    if index == nil then
        -- A newly created selector has no selected label yet. Styling must not
        -- navigate it to Chat, or replace the native Messages breadcrumb index.
        for _, i in ipairs({0, 1, 3}) do
            local child = parent:GetWidgetByIndex(i)
            if child and child:GetState() == CName.new('Selected') then index = i; break end
        end
        if index == nil then
            local label = find(tab, 'convaiChatTabLabel', 2) or tab:GetWidgetByIndex(1)
            local tint = label and label:GetTintColor()
            index = tab:IsVisible() and tint and tint.Green > tint.Red and tint.Blue > tint.Red and 4 or 0
        end
    end

    local canvas = find(tab, 'convaiChatTabLayout', 1)
    local created = canvas == nil
    if created then
        -- These are our own two children, not widgets from a game template.
        local icon, label = tab:GetWidgetByIndex(0), tab:GetWidgetByIndex(1)
        if not icon or not label then return end
        canvas = inkCanvas.new()
        canvas:SetName(CName.new('convaiChatTabLayout'))
        canvas:Reparent(tab, -1)
        icon:SetName(CName.new('convaiChatTabGlyph'))
        label:SetName(CName.new('convaiChatTabLabel'))
        icon:Reparent(canvas, -1)
        label:Reparent(canvas, -1)
        local line = inkRectangle.new()
        line:SetName(CName.new('convaiChatTabUnderline'))
        line:SetInteractive(false)
        line:Reparent(canvas, -1)
    end
    -- The native tabs are 94 units tall: 87 for content, 7 for the underline.
    -- Match their 20-unit side insets and 50-point Regular Raj typography.
    tab:SetFitToContent(false)
    tab:SetSize(size(200, 94))
    tab:SetHAlign(inkEHorizontalAlign.Left)
    tab:SetVAlign(inkEVerticalAlign.Top)
    tab:SetMargin(margin(0, 0, 0, 0))
    canvas:SetSize(size(200, 94))
    local icon = find(canvas, 'convaiChatTabGlyph', 1)
    local label = find(canvas, 'convaiChatTabLabel', 1)
    local line = find(canvas, 'convaiChatTabUnderline', 1)
    icon:SetVAlign(inkEVerticalAlign.Top)
    icon:SetMargin(margin(20, 19.5, 0, 0))
    label:SetFontStyle(CName.new('Regular'))
    label:SetFontSize(50)
    label:SetVAlign(inkEVerticalAlign.Top)
    label:SetMargin(margin(72, 12, 0, 0))
    line:SetHAlign(inkEHorizontalAlign.Left)
    line:SetVAlign(inkEVerticalAlign.Top)
    line:SetSize(size(200, 7))
    line:SetMargin(margin(0, 87, 0, 0))
    local tint = index == 4 and activeLine:GetTintColor() or baseLine:GetTintColor()
    label:SetTintColor(tint)
    for i = 0, icon:GetNumChildren() - 1 do icon:GetWidgetByIndex(i):SetTintColor(tint) end
    line:SetTintColor(baseLine:GetTintColor())
    if index == 4 and (created or not M.headerPatched) then controller:ScrollTo(4, true) end
    M.headerIndex = index
    M.headerPatched = true
end

function M.mode(controller, chat)
    local root = controller:GetRootWidget()
    local options = find(root, 'ReplyOptions', 5)
    if not options then return end
    local marker = find(root, 'convaiPhoneChatStyleMode', 1)
    if chat then
        if not marker then
            marker = inkCanvas.new()
            marker:SetName(CName.new('convaiPhoneChatStyleMode'))
            marker:SetSize(size(0, 0))
            marker:SetAffectsLayoutWhenHidden(false)
            marker:SetVisible(false)
            marker:Reparent(root, -1)
        end
        if not marker:IsVisible() then
            marker:SetState(CName.new(options:IsVisible() and 'replyWasVisible' or 'replyWasHidden'))
        end
        marker:SetVisible(true)
        options:SetAffectsLayoutWhenHidden(false)
        options:SetVisible(false)
    elseif marker and marker:IsVisible() then
        options:SetVisible(marker:GetState() == CName.new('replyWasVisible'))
        marker:SetVisible(false)
    end
    M.choicesHidden = chat and not options:IsVisible()
end

function M.isChat(controller)
    local marker = find(controller:GetRootWidget(), 'convaiPhoneChatStyleMode', 1)
    return marker and marker:IsVisible() or false
end

function M.inputText(flow)
    local text = flow:GetRootWidget()
    local owner = text
    for _ = 1, 7 do
        if not owner then return end
        if owner:GetName() == CName.new('convaiPhoneComposer') then
            local focus = find(owner, 'focus', 4)
            if focus then text:SetTintColor(focus:GetTintColor()) end
            -- Codeware dims empty placeholders to 15%, too faint in the phone.
            text:SetOpacity(flow:IsEmpty() and 0.75 or 1.0)
            return
        end
        owner = owner:GetParentWidget()
    end
end

function M.input(input)
    input:SetDefaultText(input:IsFocused()
        and 'Write a message...  /  Enter to send  /  Esc to stop typing'
        or 'Press Enter to write  /  Esc to stop typing')
    local text = find(input:GetRootWidget(), 'text', 4)
    if text and text:GetController() then M.inputText(text:GetController()) end
end

function M.composer(controller, status)
    if controller:ConvaiChatContact() == '' then return end
    local root = controller:GetRootWidget()
    local panel = find(root, 'convaiPhoneComposer', 8)
    if not panel then return end
    local input = find(panel, 'input', 2)
    local hint = find(panel, 'convaiPhoneComposerHint', 1)
    if input then
        M.input(input:GetController())
    end
    if hint then
        local text = status or hint:GetText()
        local statusVisible = text ~= '' and not text:match('^ENTER')
        hint:SetAffectsLayoutWhenHidden(false)
        hint:SetVisible(statusVisible)
    end
    local dialog = find(root, 'wrapper', 2)
    if dialog then
        local logic = dialog:GetController()
        if logic and NameToString(logic:GetClassName()) == 'MessengerDialogViewController' then M.mode(logic, true) end
    end
    M.composerPatched = true
end

function M.refresh(force)
    local player = Game.GetPlayer()
    if not player or not player:ConvaiPhoneIsOpen() then M.wasOpen = false; return end
    if M.wasOpen and not force then return end
    M.wasOpen = true
    for _, layer in ipairs(Game.GetInkSystem():GetLayers()) do
        for _, controller in ipairs(layer:GetGameControllers()) do
            local class = NameToString(controller:GetClassName())
            if class == 'PhoneMessagePopupGameController' then safely(M.composer, controller) end
            if class == 'NewHudPhoneGameController' then
                local function visit(widget, depth)
                    if not widget or depth > 13 then return end
                    local logic = widget:GetController()
                    if logic and NameToString(logic:GetClassName()) == 'PhoneDialerSelectionController' then
                        safely(M.header, logic); return
                    end
                    local compound, count = pcall(function() return widget:GetNumChildren() end)
                    if compound then for i = 0, count - 1 do visit(widget:GetWidgetByIndex(i), depth + 1) end end
                end
                visit(controller:GetRootWidget(), 0)
            end
        end
    end
end

function M.install(live)
    if not M.installed then
        ObserveAfter('PhoneDialerSelectionController', 'SetupWidgets', function(c) safely(M.header, c) end)
        ObserveAfter('PhoneDialerSelectionController', 'UpdateHightlight', function(c, index) safely(M.header, c, index) end)
        ObserveAfter('PhoneMessagePopupGameController', 'ConvaiChatPresent', function(c, _, status) safely(M.composer, c, status) end)
        ObserveAfter('PhoneMessagePopupGameController', 'SetFocus', function(c, focused) if focused then safely(M.composer, c) end end)
        ObserveAfter('MessengerDialogViewController', 'ConvaiChatMode', function(c, chat) safely(M.mode, c, chat) end)
        ObserveAfter('MessengerDialogViewController', 'UpdateData', function(c)
            safely(function() if M.isChat(c) then M.mode(c, true) end end)
        end)
        -- Reused quest widgets must never activate a real journal reply in AI Chat,
        -- even if an old queued renderer event arrives after the mode transition.
        Override('MessengerDialogViewController', 'ActivateReply', function(c, target, wrapped)
            if not M.isChat(c) then return wrapped(target) end
        end)
        M.installed = true
    end
    if not M.inputHooksInstalled then
        for _, method in ipairs({'OnFocusReceived', 'OnFocusLost'}) do
            ObserveAfter('CyberpunkConvai.ConvaiPhoneChatInput', method, function(input) safely(M.input, input) end)
        end
        ObserveAfter('Codeware.UI.TextInput.TextFlow', 'UpdatePlaceholder', function(flow) safely(M.inputText, flow) end)
        M.inputHooksInstalled = true
    end
    if live and M.updateOwner ~= convaiManager then
        local owner, original = convaiManager, convaiManager.update
        owner.update = function(...)
            local result = original(...)
            safely(M.refresh)
            return result
        end
        M.updateOwner = owner
    end
end

convaiPhoneChatStyle = M
return M
