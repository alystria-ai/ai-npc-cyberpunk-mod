-- Native phone presentation, also installable into an already-open phone.
-- Keep state on the owned widgets, never in retained native widget handles.
local M = convaiPhoneChatStyle or {}
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
-- The fonts of the chat messages are a scope of their own (see linesPresented): the refresh below prunes the records of every widget it
-- did not touch, which would forget a message font it had applied.
local messageFonts = M.messageScope
if not messageFonts and fontLibrary and type(fontLibrary.new) == 'function' then
    messageFonts = fontLibrary.new()
    M.messageScope = messageFonts
end
local function text(source, args)
    if locale and type(locale.t) == 'function' then return locale.t(source, args) end
    return (source:gsub('{([%w_]+)}', function(key)
        return args and args[key] ~= nil and tostring(args[key]) or '{' .. key .. '}'
    end))
end
local function revision()
    return locale and type(locale.revision) == 'function' and locale.revision() or 0
end
-- Only status messages authored by our phone adapter are localizable. Provider
-- error details, conversation lines and user drafts must never be translated.
local statusSources = {
    ['Saved Chat cleanup could not be verified. Please wait for the memory service.'] = true,
    ['Memory clearing is in progress. Your draft has been kept.'] = true,
    ['Conversation interrupted. Your message is in the draft.'] = true,
    ['Waiting for the conversation service.'] = true,
    ['Type a message first.'] = true,
    ['Conversations are disabled for this contact.'] = true,
    ['Wait for your previous reply before sending another message.'] = true,
    ['Unable to send the message. Your draft has been kept.'] = true,
    ['No reply received. Your message is in the draft; press Enter to retry.'] = true,
    ['Message sent. Waiting for reply.'] = true,
    ['Waiting for your previous message to finish.'] = true,
    ['Conversations are disabled in Companion Manager.'] = true,
    ['Conversation is unavailable for this contact.'] = true,
    ['Opening chat. Waiting for the conversation service.'] = true,
    ['You’ve reached today’s free conversation limit. Convai (better quality responses) is back tomorrow. To keep talking now, add a free Mistral key and set Conversation provider to Mistral in Settings > Conversation provider. A fully local option is coming.'] = true,
    ['Mistral did not accept your key. Check it in Settings > Conversation provider.'] = true,
    ['Mistral’s free limit is reached for now. Try again in a moment.'] = true,
    ['The Mistral model is unavailable right now. Try again in a minute.'] = true,
    ['Groq did not accept your key. Check it in Settings > Development.'] = true,
    ['Groq’s free limit is reached for now. Try again in a moment.'] = true,
    ['The Groq model is unavailable right now. Try again in a minute.'] = true,
    ['Local AI could not start, so a cloud provider is used. Check Local AI in Settings > Development.'] = true,
    ['Local AI could not answer that. Try again in a moment.'] = true,
}
local feedbackSources = {
    ['INVITE QUEUED - CLOSE PHONE'] = true,
    ['DISMISS QUEUED - CLOSE PHONE'] = true,
    ['CLOSE PHONE TO CONTINUE'] = true,
    ['COMPANION UNAVAILABLE'] = true,
    ['This contact has no companion mapping yet.'] = true,
    ['Close the phone to finish the pending companion requests.'] = true,
}
local namedFeedback = {
    {suffix = ': invite queued.', source = '{name}: invite queued.'},
    {suffix = ': dismiss queued.', source = '{name}: dismiss queued.'},
}

-- True for the native queue's acknowledgement of a request ("{name}: invite queued.").
function M.queuedAcknowledgement(message)
    if type(message) ~= 'string' then return false end
    for _, entry in ipairs(namedFeedback) do
        if message:sub(-#entry.suffix) == entry.suffix then
            local notices = convaiNotices
            return not (notices and notices.visible('phone-queued', true))
        end
    end
    return false
end

-- The native phone emits these before the Lua invitation adapter runs. This
-- translation path is pure Lua and cached: a nested native callback must not
-- traverse widgets, resolve the player or query settings to localize feedback.
function M.feedback(message)
    if type(message) ~= 'string' then return message end
    if feedbackSources[message] then return text(message) end
    for _, entry in ipairs(namedFeedback) do
        if message:sub(-#entry.suffix) == entry.suffix then
            local name = message:sub(1, #message - #entry.suffix)
            if name ~= '' and #name <= 160 and not name:find('%c') then
                return text(entry.source, {name = name})
            end
        end
    end
    return message
end
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
    M.fontDirty = true
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
    label:SetText(text('CHAT'))
    icon:SetVAlign(inkEVerticalAlign.Top)
    icon:SetMargin(margin(20, 19.5, 0, 0))
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

-- Typography changes need a top-level update. In particular, setting Regular
-- during a native highlight callback would invalidate Russian/Traditional
-- Chinese labels, whose verified families use Semi-Bold instead.
function M.headerFonts(controller)
    local label = find(controller:GetRootWidget(), 'convaiChatTabLabel', 8)
    if not label then return end
    if not fonts or not fonts.contains(label) then label:SetFontStyle(CName.new('Regular')) end
    label:SetFontSize(50)
    if fonts then fonts.apply(label, nil, '') end
end

local function actionLabel(controller)
    local reference = controller.m_acceptButtonLabel
    local label = reference and inkWidgetRef and inkWidgetRef.Get(reference)
    if label then return label end
    -- Actual phone fields are private to compiled redscript. Resolve only the
    -- inspected right-side accept hint; the left hint and list icons are separate.
    local hints = find(controller:GetRootWidget(), 'inputHintsPanel', 4)
    local right = find(hints, 'rightInputHints', 1)
    return find(find(right, 'inputAccept', 1), 'text', 1)
end

function M.action(controller, contact, presentation)
    M.fontDirty = true
    if not presentation or not contact or contact.convaiChat ~= true then return end
    local label = actionLabel(controller)
    if label then label:SetText(text('Chat')) end
end

local function messagePath(controller)
    local reference = controller.m_messagesPath
    local path = reference and inkWidgetRef and inkWidgetRef.Get(reference)
    -- The compiled phone owns this private field, but CET does not expose it
    -- on the actual popup. Its named native subtree is stable and was inspected
    -- in the running 2.31 phone; keep the fallback within this controller.
    return path or find(controller:GetRootWidget(), 'messagesPath', 8)
end

function M.path(controller, chat, presentation)
    M.fontDirty = true
    if not presentation or chat ~= true then return end
    local path = messagePath(controller)
    local label = find(path, 'txtValue', 3)
    if label then label:SetText(text('CHAT')) end
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

function M.clearChatLists(controller)
    if not M.isChat(controller) then return end
    -- These two controller-owned lists are replaced by the native Chat paint.
    -- Clear(false) defers the data replacement as well as the visual refresh;
    -- checking Size() cannot distinguish that pending clear from real history.
    local root = controller:GetRootWidget()
    for _, name in ipairs({'MessagesList', 'ChoicesList'}) do
        local widget = find(root, name, 8)
        local list = widget and widget:GetController()
        if list then list:Clear(true) end
    end
end

local function phoneComposer(widget)
    local owner = widget
    for _ = 1, 7 do
        if not owner then return end
        if owner:GetName() == CName.new('convaiPhoneComposer') then return owner end
        owner = owner:GetParentWidget()
    end
end

function M.inputText(flow)
    local text = flow:GetRootWidget()
    local owner = phoneComposer(text)
    if not owner then return end
    local focus = find(owner, 'focus', 4)
    if focus then text:SetTintColor(focus:GetTintColor()) end
    -- Codeware dims empty placeholders to 15%, too faint in the phone.
    text:SetOpacity(flow:IsEmpty() and 0.75 or 1.0)
end

function M.input(input)
    -- CET can observe an inherited Codeware callback on other input classes.
    -- Check the actual owning tree before changing any placeholder or style.
    local root = input:GetRootWidget()
    if not phoneComposer(root) then return end
    M.fontDirty = true
    input:SetDefaultText(text(input:IsFocused()
        and 'Write a message...  /  Enter to send  /  Esc to stop typing'
        or 'Press Enter to write  /  Esc to stop typing'))
    local text = find(root, 'text', 4)
    if text and text:GetController() then M.inputText(text:GetController()) end
end

function M.composer(controller, status)
    M.fontDirty = true
    local contact = controller:ConvaiChatContact()
    if contact == '' then return end
    local root = controller:GetRootWidget()
    local panel = find(root, 'convaiPhoneComposer', 8)
    if not panel then return end
    local input = find(panel, 'input', 2)
    local hint = find(panel, 'convaiPhoneComposerHint', 1)
    if input then
        M.input(input:GetController())
    end
    if hint then
        local source = status or hint:GetText()
        -- Keep only a static source string for the current contact, never a
        -- native handle or conversation content. This permits language changes
        -- while an error/status is visible without translating translated text.
        if status == nil and M.statusContact == contact and source == M.statusRendered then
            source = M.statusSource
        end
        local statusVisible = source ~= '' and not source:match('^ENTER')
        if statusSources[source] then
            local rendered = text(source)
            hint:SetText(rendered)
            M.statusContact, M.statusSource, M.statusRendered = contact, source, rendered
        else
            M.statusContact, M.statusSource, M.statusRendered = nil, nil, nil
        end
        hint:SetAffectsLayoutWhenHidden(false)
        hint:SetVisible(statusVisible)
    end
    M.path(controller, true)
    local dialog = find(root, 'wrapper', 2)
    if dialog then
        local logic = dialog:GetController()
        if logic and NameToString(logic:GetClassName()) == 'MessengerDialogViewController' then M.mode(logic, true) end
    end
    M.composerPatched = true
end

-- A new list of messages was presented (mod/phone-chat.lua). The game draws each message in the font of its own language, which has no
-- glyphs for a reply in Japanese, Korean, Chinese or Russian when the game is set to another language. Whether any message is in such a
-- script is decided here, once per presented list (a memoized lookup per message, never per frame). If one is, or an earlier list
-- changed a font, the message list is walked at three set moments after the present (the game lays its rows out over several frames),
-- each text getting the family of its own script and a recycled row that now holds Latin text getting its font back.
function M.linesPresented(rows)
    if not messageFonts then return end
    local library, found = fontLibrary, false
    if library and type(library.replyCode) == 'function' then
        for _, row in ipairs(rows or {}) do
            if library.replyCode(row.text) then found = true; break end
        end
    end
    if not found and messageFonts.count() == 0 then M.replyFontAt = nil; return end
    local now = os.clock()
    M.replyFontAt = {now + 0.15, now + 0.6, now + 1.5}
end

-- Only called by the bounded top-level refresh. Native paint/focus callbacks
-- above queue the flag; they never traverse or mutate native font resources.
function M.composerFonts(controller)
    local chat = controller:ConvaiChatContact() ~= ''
    M.path(controller, chat, true)
    if not fonts then return end
    local path = messagePath(controller)
    local label = find(path, 'txtValue', 3)
    if label then
        if chat then fonts.apply(label, nil, '') else fonts.restore(label) end
    end
    if not chat then return end
    if M.replyPass and path and messageFonts then
        local area = find(path, 'MessagesScrollArea', 8) or path
        messageFonts.walk(area, 'reply', {left = 600})
    end
    local panel = find(controller:GetRootWidget(), 'convaiPhoneComposer', 8)
    if not panel then return end
    local hint = find(panel, 'convaiPhoneComposerHint', 1)
    if hint then fonts.apply(hint, nil, '') end
    local root = find(panel, 'input', 2)
    if root and convaiComposerInput and type(convaiComposerInput.fontInput) == 'function' then
        convaiComposerInput.fontInput(root:GetController(), fonts)
    end
end

-- Class and widget names compared as CNames: one native call per controller instead of two plus a string
-- (the scan walks up to 512 controllers and 512 widgets, a 20-40 ms frame while the phone opens or its
-- selection moves). Built on first use; CName.new needs the game.
local scanNames
local function scanName()
    if not scanNames then
        scanNames = {popup = CName.new('PhoneMessagePopupGameController'), hud = CName.new('NewHudPhoneGameController'),
            selection = CName.new('PhoneDialerSelectionController'), dialer = CName.new('PhoneDialerLogicController'),
            feedback = CName.new('convaiActionFeedback')}
    end
    return scanNames
end
local function childCount(widget) return widget:GetNumChildren() end

-- force: rescan now. player/open: the caller's per-frame answers (init.lua onUpdate asks the game once for all the
-- phone work); with no player (a wrapped manager update) it asks for itself.
function M.refresh(force, player, open)
    if player == nil then
        player = Game.GetPlayer()
        open = player and player:ConvaiPhoneIsOpen()
    end
    if not player or not open then
        M.wasOpen, M.replyFontAt = false, nil
        -- The rows die with the popup; plain Lua, no native call. Clearing an empty scope still builds a new table, and this
        -- branch runs every frame with the phone closed, so only a scope that holds records is cleared.
        if messageFonts and messageFonts.count() > 0 then messageFonts.clear() end
        return
    end
    local localeRevision = revision()
    -- A message font pass is due (linesPresented): one scan, then the next waits for its own moment.
    local due = M.replyFontAt and M.replyFontAt[1] and os.clock() >= M.replyFontAt[1]
    if due then table.remove(M.replyFontAt, 1); M.replyPass = true end
    if M.wasOpen and not force and not M.fontDirty and not due and M.localeRevision == localeRevision then return end
    M.wasOpen, M.localeRevision = true, localeRevision
    if fonts and fonts.begin then fonts.begin() end
    local names = scanName()
    -- The stock live HUD placed PhoneMessagePopupGameController at index 132.
    -- Leave space for those controllers while retaining an overall scan bound.
    local remaining = 512
    for layerIndex, layer in ipairs(Game.GetInkSystem():GetLayers()) do
        if layerIndex > 24 or remaining == 0 then break end
        for _, controller in ipairs(layer:GetGameControllers()) do
            if remaining == 0 then break end
            remaining = remaining - 1
            local class = controller:GetClassName()
            if class == names.popup then
                safely(M.composer, controller)
                safely(M.composerFonts, controller)
                if force and convaiPhoneChat then
                    safely(function()
                        local contact = controller:ConvaiChatContact()
                        local history = convaiPhoneChat.history[contact]
                        if contact ~= '' and (not history or #history == 0) then
                            local dialog = find(controller:GetRootWidget(), 'wrapper', 2)
                            if dialog and dialog:GetController() then M.clearChatLists(dialog:GetController()) end
                        end
                    end)
                end
            end
            if class == names.hud then
                local widgetsLeft = 512
                local function visit(widget, depth)
                    if not widget or depth > 13 or widgetsLeft == 0 then return end
                    widgetsLeft = widgetsLeft - 1
                    local logic = widget:GetController()
                    if fonts and widget:GetName() == names.feedback then
                        safely(fonts.apply, widget, nil, '')
                    end
                    local logicClass = logic and logic:GetClassName()
                    if logicClass == names.selection then
                        safely(M.header, logic)
                        safely(M.headerFonts, logic)
                        return
                    end
                    if logicClass == names.dialer then
                        safely(function()
                            local contact = logic:GetSelectedContactData()
                            M.action(logic, contact, true)
                            if fonts then
                                local label = actionLabel(logic)
                                if label then
                                    if contact and contact.convaiChat == true then fonts.apply(label, nil, '')
                                    else fonts.restore(label) end
                                end
                            end
                        end)
                    end
                    local compound, count = pcall(childCount, widget)
                    if compound then for i = 0, count - 1 do visit(widget:GetWidgetByIndex(i), depth + 1) end end
                end
                visit(controller:GetRootWidget(), 0)
            end
        end
    end
    if fonts and fonts.finish then fonts.finish() end
    M.fontDirty, M.replyPass = false, false
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
    if not M.journalHooksInstalled then
        -- Unregistering journal listeners cannot retract already queued events.
        -- Keep their typing/sound/read-receipt effects out of AI Chat as well.
        Override('MessengerDialogViewController', 'OnJournalUpdate', function(c, hash, class, notify, change, wrapped)
            if not M.isChat(c) then return wrapped(hash, class, notify, change) end
            return false
        end)
        Override('MessengerDialogViewController', 'OnJournalUpdateDelayed', function(c, hash, class, notify, change, delay, wrapped)
            if not M.isChat(c) then return wrapped(hash, class, notify, change, delay) end
            return false
        end)
        Override('MessengerDialogViewController', 'OnDelayedJournalUpdate', function(c, event, wrapped)
            if not M.isChat(c) then return wrapped(event) end
            return false
        end)
        Override('PhoneMessagePopupGameController', 'OnDelayedDotsAnimation', function(c, event, wrapped)
            local dialog = find(c:GetRootWidget(), 'wrapper', 2)
            local logic = dialog and dialog:GetController()
            if logic and M.isChat(logic) then return false end
            return wrapped(event)
        end)
        M.journalHooksInstalled = true
    end
    if not M.listHooksInstalled then
        ObserveBefore('MessengerDialogViewController', 'UpdateData', function(c) safely(M.clearChatLists, c) end)
        ObserveAfter('MessengerDialogViewController', 'ConvaiChatMode', function(c, chat)
            safely(M.mode, c, chat)
            if chat then safely(M.clearChatLists, c) end
        end)
        M.listHooksInstalled = true
    end
    if not M.presentHookInstalled then
        -- This method has one signature; the native UpdateData method is
        -- overloaded and a CET method-name observer need not cover both forms.
        ObserveBefore('PhoneMessagePopupGameController', 'ConvaiChatPresent', function(c)
            safely(function()
                local dialog = find(c:GetRootWidget(), 'wrapper', 2)
                if dialog and dialog:GetController() then M.clearChatLists(dialog:GetController()) end
            end)
        end)
        M.presentHookInstalled = true
    end
    if not M.inputHooksInstalled then
        for _, method in ipairs({'OnFocusReceived', 'OnFocusLost'}) do
            ObserveAfter('CyberpunkConvai.ConvaiPhoneChatInput', method, function(input) safely(M.input, input) end)
        end
        ObserveAfter('Codeware.UI.TextInput.TextFlow', 'UpdatePlaceholder', function(flow) safely(M.inputText, flow) end)
        M.inputHooksInstalled = true
    end
    if not M.localeHooksInstalled then
        ObserveAfter('PhoneDialerLogicController', 'RefreshInputHints', function(c, contact) safely(M.action, c, contact) end)
        ObserveAfter('PhoneMessagePopupGameController', 'ConvaiChatPath', function(c, chat) safely(M.path, c, chat) end)
        M.localeHooksInstalled = true
    end
    if not M.feedbackLocaleHooksInstalled then
        -- These are separate owned methods: HUD queue status does not pass
        -- through the row's compact action-feedback renderer (or vice versa).
        -- Scope the shared HUD sink to its native queue caller. A provider
        -- error may contain the same suffix and must remain literal.
        Override('PlayerPuppet', 'ConvaiPhoneQueue', function(_, key, join, wrapped)
            M.feedbackQueueDepth = (M.feedbackQueueDepth or 0) + 1
            local ok, result = pcall(wrapped, key, join)
            M.feedbackQueueDepth = M.feedbackQueueDepth - 1
            if not ok then error(result, 0) end
            return result
        end)
        Override('PlayerPuppet', 'ConvaiPhoneFeedback', function(_, message, wrapped)
            if (M.feedbackQueueDepth or 0) > 0 then
                -- "{name}: invite queued." / "dismiss queued." from the native queue repeat the row's own
                -- "INVITE QUEUED - CLOSE PHONE" and surface after the phone closes: never shown
                -- (notices.lua, class removed). Refusals from the same call still show.
                if M.queuedAcknowledgement(message) then return end
                -- Refusals ("no companion mapping", "close the phone to finish...") show, once per window.
                local notices = convaiNotices
                if not (notices and notices.permit('phone-queue-refused', message)) then return end
                return wrapped(M.feedback(message))
            end
            return wrapped(message)
        end)
        Override('PhoneContactItemVirtualController', 'ConvaiShowActionFeedback', function(_, message, wrapped)
            M.fontDirty = true
            return wrapped(M.feedback(message))
        end)
        M.feedbackLocaleHooksInstalled = true
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
