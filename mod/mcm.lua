-- MCM API v2 provider. Every control is rendered by the installed native
-- settings framework. No ImGui panel or copied MCM implementation.
local M = {}
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
local PROVIDER, MOD, LABEL = 'cyberpunk-convai', 'manager', 'Companion Manager'
local MOD_KEY, MODEL_PAGE_SIZE = PROVIDER .. ':' .. MOD, 18
local manager, queue, entry, api, provider
local view, modelQuery, modelPage = 'home', '', 1
local actions, hooksInstalled, refreshQueued = {}, false, false
local owner, lastSignature, pollAt, searchFrames, snapshotAt = nil, '', 0, 0, 0
local lastError = ''
local actionFeedback, memoryActionCommand
local preparationTarget, preparationStatus, preparationActionFeedback
local preparationAt = 0
local presentation = {active = false, rows = {}}
local voiceSelectors = {}
local localeRevision = -1
-- Every setting on this provider waits for an explicit Apply, like the game's own
-- Settings pages. MCM's Auto Apply preference (a global player choice we must not
-- change) would commit each edit at once: it sets the draft and calls apply in the
-- same call. That call is recognised by the draft event that precedes it by a few
-- microseconds, and refused, so MCM keeps its own pending drafts: the native
-- changed-row markers, the Revert and Apply buttons, Defaults, the unsaved-changes
-- prompt when leaving, and the close guard. A person's Apply comes much later.
local AUTO_APPLY_WINDOW = 0.25
local lastDraftEventAt = -1000
local lastBackAt = -1000
-- The Companion voices list (menu order) lives with the draft preview: Pocket TTS, OmniVoice 16/32 steps with a
-- short or long reference, Convai cloud voice.
local voicePreviewModule = dofile('voice-preview.lua')
local VOICE_CHOICES = voicePreviewModule.CHOICES
-- No voice model is prepared from a draft: nothing reaches the conversation
-- service until Apply.
local voicePreview = voicePreviewModule.new()
-- Back is a native button in MCM's bottom action row, laid out with Revert, Apply,
-- Defaults and Modified. MCM has no provider API for that row, so after each render
-- the button is added and the others are shifted to make room. If it cannot be
-- added, Back becomes the last row of the page instead.
local BACK_ID = 'convai-bottom-back'
local BAR_GAP = 20
local backMode, currentBack = 'bottom', nil
local statusOriginal
-- The refusal MCM shows when a change would be applied automatically. It goes to
-- MCM's status line, which is moved to the top of the content column.
local function hintPending() return ui.t('Change pending. Choose Apply to use it, or Revert to discard it.') end
local CONTENT_FONT_SIZE = 22
-- Help page: log locations and the shareable support report. Optional: the
-- manager works without it, and a load failure only hides the Help entry.
local support, supportSignature
local supportLoaded, supportFactory = pcall(dofile, 'support-report.lua')
local log = function(message)
    local file = io.open('runtime/mcm.log', 'a')
    if file then file:write(os.date('!%Y-%m-%dT%H:%M:%SZ'), ' ', message, '\n'); file:close() end
    print('[CyberpunkConvai] ' .. message)
end

local function player()
    local ok, value = pcall(function() return Game.GetPlayer() end)
    return ok and value or nil
end

local function identity(value)
    if not value then return nil end
    local ok, hash = pcall(function() return tostring(value:GetEntityID().hash) end)
    return ok and hash or nil
end

local function active()
    if not api then return false end
    local ok, data = pcall(api.getDiagnostics)
    return ok and data and data.activeModKey == MOD_KEY
end

local fontPresentation = dofile('mcm-fonts.lua').new({ui = ui, active = active,
    label = function() return ui.t(LABEL) end})

local function controllerKey(controller)
    if not controller then return nil end
    -- Each native callback receives a new CET WeakReference wrapper. Match
    -- the engine identity, as MCM does, rather than comparing those wrappers.
    local ok, value = pcall(CalcSeed, controller)
    if ok and value ~= nil then return tostring(value) end
end

local function ownsPresentation(controller)
    return presentation.controllerKey ~= nil and presentation.controllerKey == controllerKey(controller)
end

local function findWidget(root, name, depth, budget)
    budget = budget or {left = 4096}
    if not root or budget.left <= 0 then return nil end
    budget.left = budget.left - 1
    if root:GetName() == CName.new(name) then return root end
    if depth <= 0 then return nil end
    local compound, count = pcall(function() return root:GetNumChildren() end)
    if compound then
        for index = 0, math.min(count, 1200) - 1 do
            if budget.left <= 0 then return nil end
            local found = findWidget(root:GetWidgetByIndex(index), name, depth - 1, budget)
            if found then return found end
        end
    end
end

local function contentWidgets(controller)
    -- Native ink wrappers do not reliably expose private redscript fields.
    -- The content canvas and row names are emitted by MCM's native renderer.
    local root = controller:GetRootWidget()
    local render = findWidget(root, 'MCMRenderRoot', 18)
    return findWidget(root, 'mcm_content_scroll_content', 18), render and findWidget(render, 'status', 18), render
end

local function alignLabel(widget, left)
    if not widget then return end
    local margin = widget:GetMargin()
    local extra = margin.left - left
    if extra == 0 then return end
    margin.left = left
    widget:SetMargin(margin)
    widget:SetWidth(widget:GetWidth() + extra)
end

local function redLabel(widget)
    -- The requested resting colour is MCM's default red label token, even if
    -- another row or a customized framework theme currently has a cyan tint.
    if widget then widget:BindProperty(CName.new('tintColor'), CName.new('MainColors.Red')) end
end

local function styleCategory(widget, parentLeft, parentScale, depth)
    if depth <= 0 then return end
    local margin = widget:GetMargin()
    local left = parentLeft + margin.left * parentScale
    if widget:GetName() == CName.new('label') then
        -- The native category template is scaled (about 0.52 in the live
        -- default layout). Align in content coordinates, not template units.
        alignLabel(widget, margin.left + (20 - left) / parentScale)
        -- Section titles use the native white heading above its cyan rule.
        -- Only ordinary option labels use red; leave the template rule alone.
        widget:BindProperty(CName.new('tintColor'), CName.new('MainColors.White'))
        return
    end
    local scale = widget:GetScale()
    local factor = parentScale * scale.X
    if factor <= 0 then return end
    local compound, count = pcall(function() return widget:GetNumChildren() end)
    if compound then
        for index = 0, math.min(count, 100) - 1 do
            styleCategory(widget:GetWidgetByIndex(index), left, factor, depth - 1)
        end
    end
end

local function styleCompletedPage()
    if not presentation.pending then return end
    presentation.pending = false
    if not presentation.active or not active() or not presentation.controller then return end
    -- Called only by top-level onUpdate, never inside an observed native call.
    -- CET shares a finite scratch arena across nested reflected calls. Walking
    -- the UI from a native hook can exhaust it even if every getter is valid.
    local content, status, render = contentWidgets(presentation.controller)
    presentation.statusWidget, presentation.renderRoot = status, render
    if not content then return end
    local rows, widgets = {}, {}
    for index = 0, math.min(content:GetNumChildren(), 1200) - 1 do
        local widget = content:GetWidgetByIndex(index)
        local name = NameToString(widget:GetName())
        rows[#rows + 1] = {widget = widget, name = name}
        widgets[name] = widget
    end
    presentation.voiceStatus = widgets[MOD_KEY .. ':voice-status_value']
    for _, row in ipairs(rows) do
        local widget, name = row.widget, row.name
        local managed = name:match('^(.*)_managed_label$')
        local marker = name:match('^(.*)_managed_marker$')
        local label = name:match('^(.*)_label$')
        local surface = name:match('^mcm_action_(.*)$')
        if managed then
            presentation.rows[managed] = 'managed'
            alignLabel(widget, 20)
            if not presentation.hovered[managed] then redLabel(widget) end
            local draft = widgets[managed .. '_managed_marker']
            if draft then alignLabel(draft, 0); draft:SetWidth(12) end
        elseif marker then
            -- The paired managed label handles this marker. Keep its colour.
        elseif label then
            presentation.rows[label] = 'action'
            if not presentation.hovered[label] then redLabel(widget) end
        elseif surface and widget:GetMargin().left <= 60 then
            presentation.rows[surface] = 'readonly'
            local text = findWidget(widget, 'label', 2, {left = 30})
            alignLabel(text, 0)
            -- MCM draws read-only labels larger (26) than its setting labels (22).
            if text then pcall(function() text:SetFontSize(CONTENT_FONT_SIZE) end) end
            if not presentation.hovered[surface] then redLabel(text) end
        else
            local owner = widget:GetController()
            if owner and owner:IsA('SettingsCategoryController') then styleCategory(widget, 0, 1, 6) end
        end
    end
end

local function readonly(id, label, value, description, raw)
    raw = raw or {}
    return {id = id, label = raw.label and label or ui.t(label), value = raw.value and value or ui.t(value or ''),
        description = raw.description and description or ui.t(description or ''), type = 'string',
        capabilities = {read = true, write = false, draft = false, reset = false}}
end

local function setting(id, label, kind, value, default, description, elements, raw)
    raw = raw or {}
    if id:match('^enabled:') then raw.label = true end
    local localized
    if elements then localized = {};for i,item in ipairs(elements) do localized[i]=raw.elements and item or ui.t(item) end end
    return {id = id, label = raw.label and label or ui.t(label), type = kind, value = value, defaultValue = default,
        description = ui.t(description), elements = localized,
        capabilities = {read = true, write = true, draft = true, reset = true}}
end

local function action(id, label, value, description, callback, enabled, raw)
    actions[id] = callback
    raw = raw or {}
    if id:match('^invite:') or id:match('^dismiss:') or id:match('^memory:select:') then raw.label = true end
    if id == 'memory:choose' and value ~= 'Choose a character' then raw.value = true end
    if id == 'models:previous' or id == 'models:next' or id == 'memory:previous' or id == 'memory:next' then raw.description = true end
    local descriptionText = raw.description and description or ui.t(description)
    if id:match(':back$') or id == 'memory:settings' then
        currentBack = {id = id, label = raw.label and label or ui.t(label), callback = callback}
    end
    if (id:match(':back$') or id == 'memory:settings') and modelQuery ~= '' then
        -- MCM searches action descriptions too. Keep the sole parent link
        -- visible even for an empty result set, without changing its label.
        descriptionText = descriptionText .. '\n' .. modelQuery
    end
    return {id = id, label = raw.label and label or ui.t(label), value = raw.value and value or ui.t(value),
        description = descriptionText,
        type = 'action', disabled = enabled == false,
        capabilities = {read = true, action = enabled ~= false, write = false, draft = false, reset = false}}
end

local function category(id, name, settings, description)
    return {id = id, name = ui.t(name), description = ui.t(description or ''), settings = settings}
end

local function clearSearch(context)
    modelQuery, modelPage, searchFrames = '', 1, 0
    local controller = context and context.interaction and context.interaction.controller
    if controller then pcall(function() controller:McmUiEmitSearch('content', '') end) end
end

local function navigate(nextView, context)
    view = nextView
    clearSearch(context)
    return true
end

local function countKey(party, key)
    local count = 0
    for _, member in ipairs(party) do
        if member.key == key and member.state ~= 'leaving' then count = count + 1 end
    end
    return count
end

-- The saved settings that apply to every character, as the short lines the Characters sidebar shows under the
-- description. Built once per page build (the page rebuilds only when it opens or something changes), from the values
-- the snapshot already holds: no file is read and nothing runs per frame. Only what is switched on is named.
local function sharedCharacterLines(snapshot)
    local settings, speech, behavior = snapshot.settings, {}, {}
    if settings.naturalSpeech then speech[#speech + 1] = ui.t('Natural speech') end
    if settings.expressiveEmotions then speech[#speech + 1] = ui.t('Expressive emotions') end
    if settings.followUpInterest then speech[#speech + 1] = ui.t('Follow-up questions') end
    local talk = {}
    if #speech > 0 then talk[#talk + 1] = ui.t('Speech: {list}', {list = table.concat(speech, ' · ')}) end
    if settings.multilingualConversations then talk[#talk + 1] = ui.t('Multilingual: replies in your language') end
    if settings.bodyGestures then behavior[#behavior + 1] = ui.t('Body gestures (experimental)') end
    if settings.battleReactions then behavior[#behavior + 1] = ui.t('React to battles') end
    if settings.lootReactions then behavior[#behavior + 1] = ui.t('React to collected loot') end
    return {talk = talk,
        behavior = #behavior > 0 and ui.t('Behavior: {list}', {list = table.concat(behavior, ' · ')}) or nil,
        pack = manager.omniPack()}
end

-- The Characters sidebar text of one character: its description, then the settings in effect for it. `count` is the
-- number of copies in the party and `shared` comes from sharedCharacterLines.
local function profileDescription(profile, snapshot, shared, count)
    local settings = snapshot.settings
    local voice = profile.voiceName or ui.t('Convai voice')
    -- The label names the voice actually in use, which differs from the choice
    -- while a fallback is active.
    local active, routed = snapshot.localVoice.provider, false
    if active == 'pocket' or active == 'omni' then
        for _, key in ipairs(snapshot.localVoice.routedProfiles or {}) do
            if key == profile.key then
                voice = manager.voiceLabel(active, snapshot.localVoice.omniSteps, snapshot.localVoice.omniReference)
                routed = true
                break
            end
        end
    end
    -- An OmniVoice choice cannot run without its pack: say so instead of naming a voice that will not be heard.
    if not routed and settings.voiceProvider == 'omni' and shared.pack.known and not shared.pack.installed then
        voice = ui.t('{voice} · needs Omni pack',
            {voice = manager.voiceLabel('omni', settings.omniSteps, settings.omniReference)})
    end
    local conversing = settings.enabledByKey[profile.key] ~= false
    local lines = {(profile.summary or profile.name) .. '\n', ui.t('Voice: {voice}',{voice=voice}),
        ui.t('Conversation: {state}',{state=ui.t(conversing and 'On' or 'Off')})}
    if conversing then
        local mode = settings.relationshipModes and settings.relationshipModes[profile.key]
        if mode then
            lines[#lines + 1] = ui.t('Relationship: {mode}', {mode = mode == 'on'
                and ui.t(profile.key == 'meredith-stout' and 'Casual' or 'Romantic')
                or ui.t(mode == 'off' and 'Ordinary' or 'Auto')})
        end
        for _, line in ipairs(shared.talk) do lines[#lines + 1] = line end
        local remembered = snapshot.memory and snapshot.memory.characters
        if remembered and remembered[profile.key] then lines[#lines + 1] = ui.t('Memory: remembers your conversations') end
    end
    if count > 0 then
        lines[#lines + 1] = ui.t('In your party: {count}', {count = count})
        if shared.behavior then lines[#lines + 1] = shared.behavior end
    end
    return table.concat(lines, '\n')
end

local function voiceServiceLabel(state)
    local labels = {ready = 'Ready', loading = 'Loading', warming = 'Preparing voices', speaking = 'Preparing a reply',
        error = 'Unavailable', waiting = 'Waiting for voice service', disabled = 'Not configured', stopped = 'Stopped',
        releasing = 'Releasing local voice memory', remote = 'Convai voices · Local model unloaded'}
    if state.pending then
        if state.preparationOnly then
            return ui.t('{status} · After current reply', {status=ui.t(labels[state.state] or 'Waiting for voice service')})
        end
        return ui.t('Changing after the current reply')
    end
    local fallback = state.fallback
    if type(fallback) == 'table' and (fallback.from == 'omni' or fallback.from == 'pocket')
        and (fallback.to == 'pocket' or fallback.to == 'convai') then
        return ui.t('{status} · Using {voice}, {requested} unavailable', {
            status = ui.t(labels[state.state] or 'Waiting for voice service'),
            voice = manager.voiceLabel(fallback.to, state.omniSteps, state.omniReference),
            requested = manager.voiceLabel(fallback.from, state.requestedOmniSteps, state.requestedOmniReference)})
    end
    if state.preparationOnly and state.previewActive
        and (state.previewProvider == 'pocket' or state.previewProvider == 'omni') and state.state == 'ready' then
        return ui.t('Ready · Unsaved selection')
    end
    local preview = voicePreview.inspect()
    if preview.active and (preview.provider == 'pocket' or preview.provider == 'omni') and state.state == 'remote' then
        return ui.t('Preparing voices')
    end
    return ui.t(labels[state.state] or 'Waiting for voice service')
end

-- The status line. While a different voice is pending in MCM's drafts it names
-- that voice instead (short, so the row is not truncated).
local function savedVoiceIndex(settings)
    return voicePreviewModule.indexOf(settings)
end

-- The select's labels, in menu order (fastest to best). An OmniVoice entry says what it needs while the optional pack is missing; it
-- cannot be applied then (applyBatch refuses it) and the bridge would fall back to Pocket TTS anyway.
local function voiceMenuLabels(pack)
    local elements = {}
    for index, choice in ipairs(VOICE_CHOICES) do
        local label = manager.voiceLabel(choice.provider, choice.steps, choice.reference)
        -- Short, so the entry does not truncate; the voice description says what the pack is.
        if choice.provider == 'omni' and not pack.installed then
            label = ui.t('{voice} · needs Omni pack', {voice = label})
        end
        elements[index] = label
    end
    return elements
end

local function voiceStatusText(snapshot, allowPending)
    if allowPending and api and type(api.getValue) == 'function' then
        -- Read from top-level update only, never while MCM is building a schema.
        local ok, value, err = pcall(api.getValue, MOD_KEY .. ':voiceProvider')
        local choice = ok and not err and VOICE_CHOICES[value]
        if choice and value ~= savedVoiceIndex(snapshot.settings) then
            return ui.t('Pending: {voice}', {voice = manager.voiceLabel(choice.provider, choice.steps, choice.reference)})
        end
    end
    return voiceServiceLabel(snapshot.localVoice)
end

local function updateVoiceStatus(snapshot)
    if view ~= 'settings' or not presentation.active or not presentation.voiceStatus then return end
    local text = voiceStatusText(snapshot, true)
    if text ~= presentation.voiceStatusText then
        -- Updating this read-only value preserves MCM's draft selectors. As
        -- with styling, ink access stays in top-level update, never its hooks.
        presentation.voiceStatus:SetText(text)
        presentation.voiceStatusText = text
    end
end

local function samplePreparationFeedback()
    if not preparationTarget then preparationStatus = nil; return end
    local current = queue.preparationFeedback()
    if current and (preparationTarget == true or preparationTarget == current.id) then
        preparationTarget, preparationStatus = current.id, current
        if preparationActionFeedback then actionFeedback = current.message end
    else
        preparationTarget, preparationStatus = nil, nil
        if preparationActionFeedback then actionFeedback = nil end
        preparationActionFeedback = false
    end
end

local function updatePreparationBanner()
    if not presentation.active or not presentation.statusAllowed or not presentation.statusWidget then return end
    local current = preparationStatus
    local text, signature
    if current then text, signature = current.message, current.signature
    elseif presentation.preparationApplied then text, signature = actionFeedback or presentation.statusRestore or '', ''
    else return end
    if text ~= presentation.statusText or signature ~= presentation.preparationSignature then
        -- The installed renderer creates this inkText as "status". There is
        -- no MCM status setter: update only this owned widget from onUpdate.
        presentation.statusWidget:SetText(text)
        presentation.statusText, presentation.preparationSignature = text, signature
    end
    presentation.preparationApplied = current ~= nil
end

-- Add Back to the bottom action row from top-level update, after a render (a
-- new render clears the bar). The other buttons are found by their geometry (the
-- bar's 46-unit-high actions on the bottom line) and shifted left, so Back takes
-- the rightmost place and the row stays together. Every native call is guarded:
-- if Back cannot be added, the page gets a Back row instead.
local function placeBackButton()
    if backMode ~= 'bottom' or not currentBack or not presentation.active
        or presentation.backPlaced or not presentation.controller or presentation.pending then return end
    presentation.backPlaced = true
    local controller = presentation.controller
    local ok, err = pcall(function()
        local y, rightX = controller:McmUiGetLayoutMetric(27), controller:McmUiGetLayoutMetric(28)
        local contentX, contentInner = controller:McmUiGetLayoutMetric(20), controller:McmUiGetLayoutMetric(23)
        if type(y) ~= 'number' or y < 0 then error('layout metrics are unavailable') end
        if type(rightX) ~= 'number' or rightX <= 0 then rightX = (contentX or 0) + (contentInner or 0) end
        local render = presentation.renderRoot
        if not render then error('the render root is unavailable') end
        local bar, widest = {}, 0
        for index = 0, math.min(render:GetNumChildren(), 600) - 1 do
            local widget = render:GetWidgetByIndex(index)
            local margin = widget:GetMargin()
            if math.abs(margin.top - y) <= 2 and math.abs(widget:GetHeight() - 46) <= 2 then
                bar[#bar + 1] = widget
                widest = math.max(widest, widget:GetWidth())
            end
        end
        local width = widest > 0 and widest or math.max(120, (contentInner or 600) * 0.2)
        local shift = #bar > 0 and (width + BAR_GAP) or 0
        for _, widget in ipairs(bar) do
            local margin = widget:GetMargin()
            margin.left = margin.left - shift
            widget:SetMargin(margin)
        end
        controller:McmUiAddBottomActionAt(BACK_ID, ui.t('Back'), rightX - width, y, width, false)
        if not findWidget(render, 'mcm_action_' .. BACK_ID, 2) then error('the button was not created') end
        presentation.backBar = #bar
        log('Probe: Back placed x=' .. tostring(rightX - width) .. ' y=' .. tostring(y) .. ' width=' .. tostring(width)
            .. ' beside ' .. #bar .. ' button(s)')
    end)
    if not ok then
        backMode, refreshQueued = 'list', true
        log('Back could not be placed in the action row; using a row instead: ' .. tostring(err))
    end
end

-- Move MCM's status line from the bottom left to the top left, under the header
-- subtitle, while this page is open. A new render recreates the widget, so only a
-- widget that survives (a switch to another mod page) needs its place restored.
local function restoreStatusLine()
    if statusOriginal and not presentation.active then
        local original = statusOriginal
        statusOriginal = nil
        pcall(function()
            local margin = original.widget:GetMargin()
            margin.left, margin.top = original.left, original.top
            original.widget:SetMargin(margin)
            if original.parent then pcall(function() original.widget:Reparent(original.parent, -1) end) end
            if original.width then original.widget:SetWidth(original.width) end
            if original.height then original.widget:SetHeight(original.height) end
        end)
    end
end

local function placeStatusLine()
    if not presentation.active or not presentation.statusWidget or presentation.statusMoved
        or not presentation.controller or presentation.pending then return end
    presentation.statusMoved = true
    local ok, err = pcall(function()
        local render = presentation.renderRoot
        local list = render and findWidget(render, 'mcm_sidebar_scroll_content', 8)
        if not list then error('the mod list is unavailable') end
        local count = math.min(list:GetNumChildren(), 600)
        if count < 1 then error('the mod list is empty') end
        -- Below the last entry of the mod list, in the list's own column. The list
        -- keeps its place inside a clipped scroll area, so add the offsets of its
        -- containers up to the render root.
        local left, top, bottom, entryLeft = 0, 0, 0, nil
        for index = 0, count - 1 do
            local entry = list:GetWidgetByIndex(index)
            local margin = entry:GetMargin()
            entryLeft = entryLeft or margin.left
            bottom = math.max(bottom, margin.top + entry:GetHeight())
        end
        local status = presentation.statusWidget
        local width = list:GetWidth() - (entryLeft or 0)
        local inner = presentation.controller:McmUiGetLayoutMetric(13)
        if type(inner) == 'number' and inner > 0 then width = math.min(width, inner) end
        local margin = status:GetMargin()
        -- Keep the first recorded place: a widget that survives a render is already moved.
        statusOriginal = statusOriginal or {widget = status, left = margin.left, top = margin.top,
            width = status:GetWidth(), height = status:GetHeight(), parent = status:GetParentWidget()}
        -- Placing it inside the list itself needs no container offsets: its place is
        -- the list's own coordinates, just below the last entry.
        local mode = 'list'
        local moved = pcall(function() status:Reparent(list, -1) end)
        if moved then
            margin.left, margin.top = entryLeft or 0, bottom + 14
        else
            -- Fall back to render coordinates: add the offsets of the list's containers.
            mode = 'render'
            local left, top, node, depth = 0, 0, list, 0
            while node and node ~= render and depth < 10 do
                local nodeMargin = node:GetMargin()
                left, top = left + nodeMargin.left, top + nodeMargin.top
                local parent = node:GetParentWidget()
                if not parent then break end
                node, depth = parent, depth + 1
            end
            margin.left, margin.top = left + (entryLeft or 0), top + bottom + 14
        end
        status:SetMargin(margin)
        status:SetWidth(math.max(120, width))
        -- The label is centred vertically in its box, so a tall box pushes the text
        -- far below the entry. Anchor the text to the top and size the box to the
        -- wrapped text (line height scales with the live font size, not pixels).
        local okAlign = pcall(function() status:SetVerticalAlignment(textVerticalAlignment.Top) end)
        local sized, current = pcall(function() return status:GetFontSize() end)
        local fontSize = sized and tonumber(current) or 23
        local chars = #tostring(presentation.statusText or '')
        local lines = math.max(1, math.ceil(chars * fontSize * 0.55 / math.max(120, width)))
        status:SetHeight(math.ceil(lines * fontSize * 1.4) + 4)
        if not okAlign then log('Probe: status line could not be top-aligned') end
        -- Wrap inside the column and let the text grow downward.
        local wrapped = pcall(function() status:SetWrapping(true, math.max(120, width), textWrappingPolicy.Default) end)
        if not wrapped then pcall(function() status.wrapping, status.wrappingAtPosition = true, math.max(120, width) end) end
        log('Probe: status line moved (' .. mode .. ') to x=' .. tostring(margin.left) .. ' y=' .. tostring(margin.top)
            .. ' width=' .. tostring(width) .. ' (list bottom ' .. tostring(bottom) .. ', ' .. count .. ' entries)')
    end)
    if not ok then log('Status line could not be moved: ' .. tostring(err)) end
end

local function developerMode()
    if not manager or type(manager.developerMode) ~= 'function' then return false end
    local ok, enabled = pcall(manager.developerMode)
    return ok and enabled == true
end

-- Invitation progress and outcomes from the manager and the phone are merged
-- into one compact notice by the queue's notice board (mod/manager-party.lua).
local function invitationBoard()
    return queue and type(queue.board) == 'function' and queue.board() or nil
end

local function memorySettings(snapshot)
    local memory = snapshot.memory
    local pending = memory.command and memory.command.state == 'pending'
    local rows = {
        readonly('memory-identity', 'Player memory', 'Shared across your saves',
            'Invited characters are prepared immediately. Natural memories are created when you actually talk to them. One player identity is shared across all saves and stays the same after forgetting. Current game context describes the world you have loaded.'),
        readonly('memory-service', 'Memory service', memory.state == 'ready' and 'Ready' or 'Unavailable',
            memory.state == 'ready' and 'Memories can be managed here.'
                or 'Reopen this page after the memory service reconnects. A pending clear keeps waiting for its own result.'),
        readonly('memory-count', 'Characters you have talked to',
            memory.talkedToCount and (memory.state == 'ready' and tostring(memory.talkedToCount)
                or ui.t('{count} · Last reported',{count=memory.talkedToCount})) or 'Unavailable',
            'Forget all memories applies to these characters. Visiting the catalogue or inviting a companion does not add anyone to this count.'),
        action('memory:choose', 'Selected character', memory.selectedName or 'Choose a character',
            'Choose any character from the catalogue. They do not need to be in your current party.',
            function(context) return navigate('memory-characters', context) end, not pending and not memory.confirmation),
    }
    if memory.feedback ~= '' then rows[#rows + 1] = readonly('memory-feedback', 'Memory result', memory.feedback, memory.feedback) end
    local confirmation = memory.confirmation
    if confirmation then
        local description = confirmation.scope == 'all'
            and ui.t('Clear memories about you for all {count} characters you have talked to?',{count=confirmation.count})
            or ui.t('Clear {name}’s memories about conversations with you?',{name=confirmation.target})
        description = description .. ' ' .. ui.t('Your player identity stays the same. Matching Phone Chat messages and drafts are also cleared.')
        rows[#rows + 1] = readonly('memory-confirmation', 'Confirm memory clear', description, description)
        rows[#rows + 1] = action('memory:confirm:' .. confirmation.token, 'Confirm', 'Forget memories', description,
            function() return manager.confirmMemoryClear(confirmation.token) end,
            confirmation.scope == 'all' and memory.canClearAll or confirmation.scope == 'character' and memory.canClearCharacter)
        rows[#rows + 1] = action('memory:cancel:' .. confirmation.token, 'Cancel', 'Keep memories',
            'Cancel this request before anything is sent.', function() return manager.cancelMemoryClear(confirmation.token) end)
    else
        rows[#rows + 1] = action('memory:forget-character', 'Forget selected character', 'Forget',
            memory.selectedName and ui.t('Clear {name}’s memories about conversations with you. Review an inline confirmation first.',{name=memory.selectedName})
                or 'Choose a character before clearing their memories about you.',
            function() return manager.beginMemoryClear('character') end, memory.canClearCharacter)
        rows[#rows + 1] = action('memory:forget-all', 'Forget all memories',
            memory.talkedToCount and ui.t('Forget ({count} characters)',{count=memory.talkedToCount}) or 'Forget',
            'Clear memories about you for every character you have talked to. Your player identity is retained. Review an inline confirmation first.',
            function() return manager.beginMemoryClear('all') end, memory.canClearAll)
    end
    rows[#rows + 1] = readonly('memory-chat-history', 'Phone Chat messages', 'Kept until forgotten',
        'Chat history stays available across game launches. Forgetting a character also clears their saved Chat messages and drafts. Forgetting all memories clears all saved chats.')
    return rows
end

local function schema()
    local currentPlayer = player()
    owner = identity(currentPlayer)
    queue.bind(owner)
    local snapshot, party = manager.snapshot(currentPlayer), queue.list()
    actions = {}
    currentBack = nil
    local categories = {}
    local rows = {}
    -- The party has a fixed number of formation places. It is not shown: a full
    -- party answers an invitation with a message from the queue.
    local canInvite = owner ~= nil
    if view == 'home' then
        for _, tab in ipairs({{'characters', 'Characters'}, {'party', 'Current party'},
            {'models', 'Model browser'}, {'settings', 'Settings'}}) do
            -- The Model browser lists every character model in the game, so it says that and what joining means.
            local description = tab[1] == 'models'
                and ui.t('Browse every character model in the game and invite any of them, including characters without conversation support. They join as followers and do not talk.')
                or ui.t('Browse {section}. {query}',{section=ui.t(tab[2]):lower(),query=modelQuery})
            rows[#rows + 1] = action('tab:' .. tab[1], tab[2], 'Open', description,
                function(context) return navigate(tab[1], context) end)
        end
        -- The page title already says Companion Manager: the section header is blank (a
        -- single space; an empty name would fall back to the category id).
        categories[#categories + 1] = category('navigation', ' ', rows)
    elseif view == 'characters' then
        local shared = sharedCharacterLines(snapshot)
        for _, profile in ipairs(snapshot.profiles) do
            local key = profile.key
            local count = countKey(party, key)
            local available = manager.definition(key) ~= nil
            rows[#rows + 1] = action('invite:' .. key, profile.name,
                available and (count > 0 and ui.t('Add copy ({count})',{count=count}) or 'Invite') or 'Profile only',
                profileDescription(profile, snapshot, shared, count), function() return queue.invite(key) end, canInvite and available)
        end
        categories[#categories + 1] = category('characters', 'Characters', rows,
            'Search a character by name. Each invitation reserves a place and starts preparation immediately.')
    elseif view == 'party' then
        local trip = queue.chauffeur()
        local status = {}
        if trip.active then
            local tripStates = {releasing = 'Preparing to drive', ['boarding-driver'] = 'Driver boarding',
                ['waiting-for-player'] = 'Waiting for you to board', ['waiting-for-party'] = 'Waiting for party to board',
                starting = 'Starting trip', driving = 'Driving',
                stopping = 'Stopping', ['waiting-for-player-exit'] = 'Waiting for you to step out',
                ['exiting-driver'] = 'Driver leaving the car'}
            status[#status + 1] = readonly('chauffeur-state', 'Companion driver',
                trip.stopPending and 'Stop requested' or tripStates[trip.phase] or trip.phase,
                'Ask a companion to drive to your selected map waypoint, then get into the passenger seat when they are ready.')
            status[#status + 1] = action('chauffeur:stop', 'Companion driver', 'Stop trip',
                'Stop the trip after returning to gameplay. Wait for the car to stop, then step out before dismissing the driver.',
                function() return queue.stopTrip() end, not trip.stopPending)
        end
        if #status > 0 then categories[#categories + 1] = category('party-status', 'Your group', status) end
        -- One row per copy: its name and number, with Dismiss on the right. A copy
        -- dismissed while the world is paused is dropped from the list at once;
        -- the queue deletes it after gameplay resumes and lists it again with the
        -- reason if the game refuses.
        local shown = 0
        for _, member in ipairs(party) do
            if member.state ~= 'leaving' then
                shown = shown + 1
                local id = member.id
                local display = member.serial and ((member.baseName or member.name) .. ' #' .. member.serial)
                    or ui.t('{name} · invited copy', {name = member.name})
                local problem = member.dismissError or (member.state == 'failed' and member.error) or nil
                rows[#rows + 1] = action('dismiss:' .. id, display,
                    member.serial and 'Dismiss' or 'Cancel invitation',
                    ui.t('Remove only this copy from your group.') .. (problem and ('\n' .. ui.t(problem)) or ''),
                    function() return queue.dismiss(id) end, nil, {description = true})
                -- Developer mode: the character's own game voice as a loudness
                -- reference for the companion voice (docs/DIALOGUE_LEVEL.md).
                if member.serial and member.state == 'ready' and developerMode() then
                    rows[#rows + 1] = action('gamevoice:' .. id, ui.t('{name} · game voice', {name = display}), 'Play',
                        'Plays one of this character’s own lines from the game, through the game’s normal dialogue audio, so you can compare their companion voice with it. You hear it when you return to gameplay; each press tries another line, and a character may have no line for some of them.',
                        function() return queue.gameVoice(id) end, nil, {label = true})
                end
                if problem then
                    local text = (member.baseName or member.name) .. ': ' .. ui.t(problem)
                    rows[#rows + 1] = readonly('error:' .. id, text, '', text, {label = true, description = true})
                end
            end
        end
        if shown == 0 then rows[#rows + 1] = readonly('empty-party', 'Your party is empty', '', 'Invite someone from Characters or Model browser.') end
        categories[#categories + 1] = category('party', 'Current party', rows)
    elseif view == 'models' then
        local matches = {}
        local query = modelQuery:lower()
        for _, model in ipairs(snapshot.models) do
            if query == '' or model.search:find(query, 1, true) then matches[#matches + 1] = model end
        end
        local pages = math.max(1, math.ceil(#matches / MODEL_PAGE_SIZE))
        modelPage = math.max(1, math.min(modelPage, pages))
        local scan = snapshot.scan
        local talking = 0
        for _, model in ipairs(matches) do if model.profileName then talking = talking + 1 end end
        rows[#rows + 1] = readonly('model-status', scan.finished and ui.t('{count} matching models',{count=#matches}) or 'Reading installed models…',
            ui.t('Page {page} / {pages}',{page=modelPage,pages=pages}),
            ui.t('Search by character name or model record using Search settings. {query}',{query=modelQuery})
                .. '\n' .. ui.t('{count} of them can talk.', {count = talking})
                .. '\n' .. (ui.t(scan.error) or ''))
        if modelPage > 1 then
            rows[#rows + 1] = action('models:previous', 'Previous models', 'Previous', modelQuery,
                function() modelPage = math.max(1, modelPage - 1); return true end)
        end
        if modelPage < pages then
            rows[#rows + 1] = action('models:next', 'More models', 'Next', modelQuery,
                function() modelPage = modelPage + 1; return true end)
        end
        for index = (modelPage - 1) * MODEL_PAGE_SIZE + 1, math.min(modelPage * MODEL_PAGE_SIZE, #matches) do
            local model = matches[index]
            local key = model.key
            local modelName = model.unnamedIndex and ui.t('Unnamed model {index}',{index=model.unnamedIndex}) or model.name
            local conversation = model.archetype and ui.t('Conversation: {name} (archetype)', {name = model.profileName})
                or model.profileName and ui.t('Conversation: {state}',{state=model.profileName})
                or ui.t('No conversation profile. This model joins as a follower without AI conversations.')
            rows[#rows + 1] = action('invite:' .. key, modelName, 'Invite',
                model.record .. '\n\n' .. conversation
                    .. '\n' .. ui.t('Some game models have special rigs or roles and may not behave as ordinary companions.'),
                function() return queue.invite(key) end, canInvite)
        end
        categories[#categories + 1] = category('models', 'Installed character models', rows,
            'Every character model found in the game, including characters without conversation support. Those join as followers and do not talk.')
    elseif view == 'memory' then
        rows = memorySettings(snapshot)
        table.insert(rows, 1, action('memory:settings', 'Back to settings', 'Back',
            'Return to conversation settings.', function(context) return navigate('settings', context) end))
        categories[#categories + 1] = category('memory', 'Memory', rows,
            'Characters build memories through your conversations and keep them across saves.')
    elseif view == 'memory-characters' then
        local matches = {}
        local query = modelQuery:lower()
        for _, profile in ipairs(snapshot.profiles) do
            if query == '' or (profile.name .. ' ' .. profile.key .. ' ' .. table.concat(profile.aliases or {}, ' ')):lower():find(query, 1, true) then
                matches[#matches + 1] = profile
            end
        end
        local pages = math.max(1, math.ceil(#matches / MODEL_PAGE_SIZE))
        modelPage = math.max(1, math.min(modelPage, pages))
        rows[#rows + 1] = action('memory:back', 'Back to memory', 'Back',
            'Return to the memory controls.', function(context)
                navigate('memory', context)
                return manager.closeMemoryPicker()
            end)
        rows[#rows + 1] = readonly('memory-character-page', 'Choose a character', ui.t('Page {page} / {pages}',{page=modelPage,pages=pages}),
            ui.t('Search by character name using Search settings. {query}\nThe character can be outside your current party.',{query=modelQuery}))
        if modelPage > 1 then
            rows[#rows + 1] = action('memory:previous', 'Previous characters', 'Previous', modelQuery,
                function() modelPage = modelPage - 1; return true end)
        end
        if modelPage < pages then
            rows[#rows + 1] = action('memory:next', 'More characters', 'Next', modelQuery,
                function() modelPage = modelPage + 1; return true end)
        end
        for index = (modelPage - 1) * MODEL_PAGE_SIZE + 1, math.min(modelPage * MODEL_PAGE_SIZE, #matches) do
            local profile = matches[index]
            local key = profile.key
            rows[#rows + 1] = action('memory:select:' .. key, profile.name,
                snapshot.memory.selectedKey == key and 'Selected' or 'Choose',
                ui.t('Select {name} for memory controls. This does not invite them or change their conversation settings.',{name=profile.name}),
                function(context)
                    local ok, reason = manager.selectMemoryCharacter(key)
                    if ok then navigate('memory', context) end
                    return ok, reason
                end)
        end
        categories[#categories + 1] = category('memory-characters', 'Character memories', rows)
    elseif view == 'relationships' then
        rows[#rows + 1] = action('relationships:back', 'Back to settings', 'Back',
            'Return to conversation settings.', function(context) return navigate('settings', context) end)
        for _, profile in ipairs(manager.relationshipChoices()) do
            local mode = snapshot.settings.relationshipModes[profile.key]
            -- The saved values stay auto / on / off; only the labels read Romantic (Casual for Meredith) / Ordinary.
            local casual = profile.key == 'meredith-stout'
            local description = casual
                and 'Auto follows the completed encounter in this save. Casual uses the casual profile; Ordinary uses the ordinary profile. This does not imply an ongoing relationship.'
                or 'Auto follows the relationship in this save. Romantic uses the romantic profile; Ordinary uses the ordinary profile. This changes conversations without changing game choices.'
            rows[#rows + 1] = setting('relationship:' .. profile.key, profile.name, 'select',
                mode == 'on' and 2 or mode == 'off' and 3 or 1, 1, description,
                {'Auto', casual and 'Casual' or 'Romantic', 'Ordinary'})
        end
        categories[#categories + 1] = category('relationships', 'Relationships', rows,
            'Choose ordinary or romantic conversations for supported characters.')
    elseif view == 'permissions' then
        rows[#rows + 1] = action('permissions:back', 'Back to settings', 'Back',
            'Return to conversation settings.', function(context) return navigate('settings', context) end)
        for _, profile in ipairs(snapshot.profiles) do
            rows[#rows + 1] = setting('enabled:' .. profile.key, profile.name, 'bool',
                snapshot.settings.enabledByKey[profile.key] ~= false, true,
                ui.t('Allow {name} in private and group conversations. Existing copies can still follow you when this is off.',{name=profile.name}))
        end
        categories[#categories + 1] = category('permissions', 'Who can talk', rows)
    elseif view == 'help' and support then
        local where, report = support.locations(), support.status()
        local files = {mod = 'probe.log, mcm.log', bridge = 'bridge.stderr.log', launcher = 'launcher.log',
            cet = 'cyber_engine_tweaks.log', redscript = 'redscript_rCURRENT.log', red4ext = 'red4ext-*.log',
            reports = 'convai-report-*.zip'}
        local rawRow = {value = true, description = true}
        local copyDescription = report.path
            and ui.t('Copy the report path to the clipboard so you can paste it into a message.')
            or ui.t('Create a report first, then copy its path.')
        local lastValue, lastDescription = ui.t('None yet'), ui.t('Choose Generate report. The file name and its folder appear here and in the banner above.')
        if report.path then
            lastValue = report.fileName
            lastDescription = ui.t('Saved at {path}', {path = support.displayPath(report.path)})
            if report.mode == 'lua' then
                lastDescription = lastDescription .. '\n' .. ui.t('This is a short report: the conversation service was not available to build the full one.')
            end
        end
        rows[#rows + 1] = action('help:back', 'Back to settings', 'Back', 'Return to conversation settings.',
            function(context) return navigate('settings', context) end)
        rows[#rows + 1] = readonly('help-steps', 'What to do', 'Create a report',
            'If a character stops answering, voices stop or an error appears: open this page, choose Generate report, then send the file it names to the developer with a short note about what you were doing. The logs listed below show what went wrong.')
        rows[#rows + 1] = readonly('help-service', 'Conversation service', support.serviceLabel(),
            'The conversation service runs beside the game. If it is not running, restart the game. Its logs are listed below.', {value = true})
        categories[#categories + 1] = category('help-trouble', 'If something goes wrong', rows)
        categories[#categories + 1] = category('help-report', 'Report for the developer', {
            action('help:generate', 'Generate report', 'Create',
                'Save a report file you can send to the developer. API keys, tokens, IDs, microphone audio and conversation text are left out. If the conversation service is not running, a shorter report is made from the files the game can read.',
                function() return support.request() end, report.phase ~= 'working'),
            readonly('help-last', 'Last report', lastValue, lastDescription, {value = report.path ~= nil, description = true}),
            action('help:copy', 'Copy report path', 'Copy',
                copyDescription,
                function() return support.copyPath() end),
        }, 'One file with versions, settings and the latest log lines. It never contains your API key, tokens, voice recordings or conversation text.')
        categories[#categories + 1] = category('help-logs', 'Where the logs are', {
            readonly('help-log-mod', 'Mod logs', files.mod,
                ui.t('Mod logs such as probe.log and mcm.log are in {path}', {path = where.mod}), rawRow),
            readonly('help-log-bridge', 'Conversation service logs', files.bridge,
                ui.t('The conversation service writes bridge.stderr.log, bridge.stdout.log and bridge-service.log in {path}', {path = where.bridge}), rawRow),
            readonly('help-log-launcher', 'Launcher log', files.launcher,
                ui.t('The service launcher writes launcher.log at {path}', {path = where.launcher}), rawRow),
            readonly('help-log-cet', 'Cyber Engine Tweaks logs', files.cet,
                ui.t('Cyber Engine Tweaks writes cyber_engine_tweaks.log and scripting.log in {path}', {path = where.cet}), rawRow),
            readonly('help-log-redscript', 'Redscript log', files.redscript,
                ui.t('The redscript compiler writes redscript_rCURRENT.log at {path}', {path = where.redscript}), rawRow),
            readonly('help-log-red4ext', 'RED4ext logs', files.red4ext,
                ui.t('RED4ext writes its logs in {path}', {path = where.red4ext}), rawRow),
            readonly('help-log-reports', 'Saved reports', files.reports,
                ui.t('Generated reports are saved in {path}. The five newest are kept.', {path = where.reports}), rawRow),
        }, 'Send the generated report rather than raw log files. Open these locations only if the developer asks for a specific file.')
    elseif view == 'settings' then
        local choices, languageElements, languageIndex = ui.choices(), {}, 1
        for index, choice in ipairs(choices) do
            languageElements[index] = choice.label
            if choice.value == snapshot.settings.uiLanguage then languageIndex = index end
        end
        categories[#categories + 1] = category('interface', 'Interface', {
            setting('uiLanguage', 'Interface language', 'select', languageIndex, 1,
                'Choose the mod interface language independently of character voices and conversation language.',
                languageElements, {elements=true}),
        })
        categories[#categories + 1] = category('conversation-controls', 'Conversations', {
            action('permissions', 'Who can talk', 'Manage',
                'Enable or disable each character’s participation in AI conversations.',
                function(context) return navigate('permissions', context) end),
            action('memory', 'Memory', 'Manage',
                'Choose a character, review memory status and manage memories from your conversations.',
                function(context) return navigate('memory', context) end),
            action('relationships', 'Relationships', 'Manage',
                'Choose ordinary or romantic conversations for supported characters.',
                function(context) return navigate('relationships', context) end),
            setting('archetypeConversations', 'Talk to ordinary NPCs', 'bool', snapshot.settings.archetypeConversations ~= false, true,
                'Lets you talk to unnamed people the game does not give a story role: gang members, NCPD officers, corporate guards, ripperdocs, shopkeepers, bartenders and passers-by. Each answers as their kind of person, does not know your story and does not remember you after you load a save, except shopkeepers you come back to. Named characters are not affected. On by default.'),
            setting('multilingualConversations', 'Multilingual conversations', 'bool', snapshot.settings.multilingualConversations, false,
                'Talk to companions in any language: each character answers in the language you use. It uses a multilingual copy of each character, so what they remember from these conversations is kept apart from your English ones; forgetting a character clears both. Pocket TTS speaks only English, so turning this on switches Companion voices to OmniVoice · Balanced when the optional OmniVoice pack is installed, or to Convai · Cloud voice otherwise; without the pack, Natural speech and Expressive emotions are turned off, because the cloud voice would read their tags aloud. Off by default.'),
            setting('autoConnectNearby', 'Auto-connect nearby characters', 'bool', snapshot.settings.autoConnectNearby, true,
                'Prepares the conversation with a character you look at, walk up to or have just talked to, so they answer without a wait; it pauses during combat and scenes. At most two characters are kept ready at any moment, at most one new connection starts every 3 seconds and a character is released after 40 seconds unused, so a crowd never adds up.'),
            setting('gameDialogueContext', 'Continue from game dialogue', 'bool', snapshot.settings.gameDialogueContext, true,
                'When you talk to a character right after the game’s own dialogue with them, they know the last few lines that were just said, including your chosen replies and phone calls with them, so their answer follows on naturally. Only lines from the last few minutes that involved that character are used, and they are not added to the character’s memory. On by default.'),
        })
        local heights,strengths=manager.gazeChoices()
        local heightIndex,strengthIndex=3,3
        for index,value in ipairs(heights) do if snapshot.settings.eyeContactHeight==value then heightIndex=index end end
        for index,value in ipairs(strengths) do if snapshot.settings.headFollowStrength==value then strengthIndex=index end end
        categories[#categories + 1] = category('companion-behavior', 'Companion behavior', {
            setting('eyeContactHeight', 'Eye contact height', 'select', heightIndex, 3,
                'Raise or lower where companions look when they make eye contact with you.',
                {'10 cm lower', '5 cm lower', 'Default', '5 cm higher', '10 cm higher'}),
            setting('headFollowStrength', 'Head tracking strength', 'select', strengthIndex, 3,
                'Choose how much companions turn their heads during eye contact. Eyes only relies on eye movement.',
                {'Eyes only', 'Subtle', 'Gentle (default)', 'Strong'}),
            setting('bodyGestures', 'Body gestures (experimental)', 'bool', snapshot.settings.bodyGestures, false,
                'Companions gesture with their body while they speak longer replies and nod while you talk to them, using the game’s own animations in their usual stance. They stop at once when anyone moves or a fight starts.'),
        })
        local voiceStatus = voiceStatusText(snapshot)
        -- The list: Pocket Performance (the default), OmniVoice Balanced / Quality (16 steps, short / long reference),
        -- High Quality / Ultra Quality (32 steps, short / long reference), Convai Cloud voice.
        local voiceIndex = savedVoiceIndex(snapshot.settings)
        -- Lip sync delay (Bluetooth): Auto, Off, then milliseconds (bridge/audio-delay.mjs).
        local delays, delayLabels, delayIndex = manager.audioDelayChoices(), {}, 1
        for index, value in ipairs(delays) do
            delayLabels[index] = value == 'auto' and ui.t('Auto') or value == 0 and ui.t('Off') or (tostring(value) .. ' ms')
            if snapshot.settings.audioDelay == value then delayIndex = index end
        end
        local pack = manager.omniPack()
        categories[#categories + 1] = category('voices', 'Voices', {
            setting('voice', 'Voice playback', 'bool', snapshot.settings.voice, true, 'Play voiced replies from your companions.'),
            setting('voiceProvider', 'Companion voices', 'select', voiceIndex, 1,
                'Pocket is light and fast on your CPU and starts speaking in about 0.2 s. OmniVoice sounds better, especially on harder voices, but needs a capable GPU and the optional OmniVoice pack (without it those entries are marked and cannot be applied), and the higher tiers take longer to start speaking, about 1 to 2.5 s. Convai uses the cloud; if a choice cannot run, a simpler voice takes over and you are told once.',
                voiceMenuLabels(pack), {elements = true}),
            setting('audioDelay', 'Lip sync delay (Bluetooth)', 'select', delayIndex, 1,
                'Bluetooth earbuds and headphones play sound a little later than the picture, so lips and subtitles can run slightly ahead of the voice. This holds them back to match, for every voice. Auto uses 150 ms while Windows plays through a Bluetooth device and none otherwise; choose a value if your headset is faster or slower. The game’s own dialogue has the same Bluetooth delay and does not correct it.',
                delayLabels, {elements = true}),
            setting('keepPreparedVoices', 'Keep prepared voices', 'bool', snapshot.settings.keepPreparedVoices, true,
                'Remember each companion’s prepared voice so summoning them again is quicker. Pocket TTS saves one small file per character (about 5 to 15 MB) in the mod’s runtime folder; OmniVoice does a short hidden warm-up at your chosen quality while a companion joins. Turn this off to save nothing on disk. The change applies without a restart.'),
            setting('naturalSpeech', 'Natural speech', 'bool', snapshot.settings.naturalSpeech, false,
                'Let companions speak the way a real person with their personality would: now and then a pause, a hesitation, a laugh or a sigh. Each character decides when it fits, and it stays rare; a fluent, confident speaker will hardly use it. OmniVoice can voice laughs and sighs; Pocket TTS uses only pauses in the sentence. It needs a local voice, so applying it while Convai cloud voice is chosen switches Companion voices to Pocket TTS. Off by default.'),
            setting('expressiveEmotions', 'Expressive emotions', 'bool', snapshot.settings.expressiveEmotions, false,
                'Let each character mark its own feelings as it speaks, so the face changes when that part is spoken instead of being guessed from the words. Subtle by default, chosen by personality, and only where the feeling really shifts. It needs a local voice, so applying it while Convai cloud voice is chosen switches Companion voices to Pocket TTS. A reply without marks uses the usual text-based expression. Off by default.'),
            setting('followUpInterest', 'Follow-up questions', 'bool', snapshot.settings.followUpInterest, false,
                'Characters sometimes show interest in you and keep the conversation going: they ask about something you just said, pick up something from earlier or share a thought that invites an answer. It happens now and then, never on every reply, and never while you are leaving, giving an order or fighting. Works with any voice. Off by default.'),
            readonly('voice-pack', 'OmniVoice pack', pack.known and (pack.installed and 'Installed' or 'Not installed') or 'Waiting for voice service',
                'OmniVoice is an optional add-on for computers with a capable GPU. Pocket TTS needs nothing extra.'),
            readonly('voice-status', 'Voice status', voiceStatus,
                'Changes wait until you choose Apply; Revert discards them. No game restart is needed.'),
        }, 'Changes wait until you choose Apply.')
        categories[#categories + 1] = category('subtitles', 'Subtitles', {
            setting('subtitles', 'Subtitles', 'bool', snapshot.settings.subtitles, true, 'Show companion replies using the selected subtitle display.'),
            setting('subtitleStyle', 'Subtitle display', 'select', snapshot.settings.subtitleStyle == 'overhead' and 2 or 1, 1,
                'Cinematic subtitles use the game’s regular dialogue display; Above the speaker places them over the speaking companion. The Subtitles switch controls both.',
                {'Cinematic subtitles', 'Above the speaker'}),
        })
        categories[#categories + 1] = category('reactions', 'Automatic reactions', {
            setting('battleReactions', 'React to battles', 'bool', snapshot.settings.battleReactions, true,
                'A nearby companion can make one short comment as combat starts and another afterward. Ten-minute cooldown after a fight; conversations and story scenes take priority. Loading a save resets the cooldown.'),
            setting('lootReactions', 'React to collected loot', 'bool', snapshot.settings.lootReactions, true,
                'Companions can comment after you finish collecting world loot. Storage transfers stay silent. A ten-minute cooldown spaces ordinary comments; newly acquired Legendary equipment has a separate two-minute cooldown. After a fight, pickups collected by then are folded into one end-of-fight comment; later pickups get their own comment.'),
        })
        categories[#categories + 1] = category('development', 'Development', {
            setting('developerMode', 'Developer mode', 'bool', snapshot.settings.developerMode, false,
                'For testing and bug reports; leave it off for normal play. It shows routine companion popups (the joining step, dismissal confirmations, driving instructions such as boarding and exit, results of companion actions, and a notice when a support report is ready), writes a movement trace file in the mod’s runtime folder, logs body gesture decisions, and adds this setting to support reports. Preparation progress, joined notices, failures and replies to Stop trip remain visible when off.'),
        })
        if support then
            categories[#categories + 1] = category('help', 'Help', {
                action('help', 'Help and support', 'Open',
                    'Find the log files and create a report to send to the developer if something goes wrong.',
                    function(context) return navigate('help', context) end),
            })
        end
    end
    if view == 'characters' or view == 'party' or view == 'models' or view == 'settings' then
        table.insert(categories[1].settings, 1, action(view .. ':back', 'Back to Companion Manager', 'Back',
            'Return to Companion Manager.', function(context) return navigate('home', context) end))
    end
    -- Back leaves the list: it is the bottom-bar button (its callback stays
    -- registered). In row mode it is the last row of the page, never the first.
    if currentBack then
        local moved
        for index = #categories, 1, -1 do
            local list = categories[index].settings
            for position = #list, 1, -1 do
                if list[position].id == currentBack.id then moved = table.remove(list, position) end
            end
        end
        for index = #categories, 1, -1 do
            if #categories[index].settings == 0 then table.remove(categories, index) end
        end
        if moved and backMode ~= 'bottom' then
            if #categories == 0 then categories[1] = category('navigation-back', 'Companion Manager', {}) end
            table.insert(categories[#categories].settings, moved)
        end
    end
    return {name = ui.t(LABEL), description = ui.t('Your companions, character models and conversation settings.'), categories = categories}
end

function M.configure(domain, companions, queueFactory, entryFactory, readiness)
    manager, queue = domain, queueFactory.new(companions, readiness, {developerMode = domain.developerMode})
    entry = entryFactory.new(function() return ui.t(LABEL) end, function() return api ~= nil end, log, active)
    if supportLoaded and type(supportFactory) == 'table' and type(supportFactory.new) == 'function' then
        local created, instance = pcall(supportFactory.new, {ui = ui, party = function() return queue.list() end,
            developerMode = function() return developerMode() end})
        if created and type(instance) == 'table' then support = instance end
    end
    provider = {
        id = PROVIDER, registrationKey = 'cyberpunk-convai.manager.v1', apiVersion = 2,
        name = 'Cyberpunk Convai', shortName = 'CONVAI',
        capabilities = {index = true, lazy = true, draft = true, action = true, atomicApply = true, dynamicSchema = true},
        listMods = function()
            return {complete = true, revision = tostring(ui.revision()), mods = {{id = MOD, name = ui.t(LABEL),
                description = ui.t('Invite characters, manage your group, browse game models and configure conversations.')}}}
        end,
        closeMod = function(id)
            if id == MOD then
                local ok, pending = pcall(function() return api and api.hasDrafts(MOD_KEY) end)
                if ok and pending == true then log('Probe: closeMod with unapplied changes (MCM discards them)') end
            end
            return true
        end,
        loadMod = function(id)
            if id ~= MOD then return nil, ui.t('Unknown mod.') end
            entry.selected()
            return schema()
        end,
        invokeAction = function(id, actionId, context)
            if id ~= MOD or not actions[actionId] then return {ok = false, error = ui.t('Reopen the manager; that action is no longer available.')} end
            local ok, reason, invitationId = actions[actionId](context)
            actionFeedback = ok == true and ui.t(reason) or nil
            preparationActionFeedback = false
            if actionId:match('^invite:') and type(invitationId) == 'string' then
                local board = invitationBoard()
                if board then board.track(invitationId, 'manager') end
            end
            if ok == true and actionId:match('^invite:') then
                preparationTarget = true
                preparationStatus, preparationAt, preparationActionFeedback = nil, 0, true
            elseif ok ~= true or reason ~= nil then
                -- Navigation has no result message and leaves progress visible.
                -- A memory, dismissal or trip action owns its own result banner.
                preparationTarget, preparationStatus = nil, nil
            end
            memoryActionCommand = nil
            if ok == true and actionId:match('^memory:confirm:') then
                local command = manager.snapshot(player()).memory.command
                memoryActionCommand = command and command.id or nil
            end
            return {ok = ok == true, error = ok ~= true and ui.t(reason) or nil, schemaChanged = ok == true}
        end,
        applyBatch = function(id, changes)
            if id ~= MOD then return {ok = false, error = ui.t('Unknown mod.')} end
            -- Auto Apply sets a draft and applies in the same instant. Refuse that
            -- call so the draft stays pending; nothing is saved or sent anywhere.
            if os.clock() - lastDraftEventAt < AUTO_APPLY_WINDOW then
                return {ok = false, error = hintPending()}
            end
            local values, applied = {enabledByKey = {}, relationshipModes = {}}, {}
            for _, change in ipairs(changes) do
                local key = change.id
                if key == 'voice' or key == 'subtitles' or key == 'developerMode'
                    or key == 'battleReactions' or key == 'lootReactions' or key == 'bodyGestures'
                    or key == 'autoConnectNearby' or key == 'keepPreparedVoices' or key == 'naturalSpeech'
                    or key == 'gameDialogueContext'
                    or key == 'expressiveEmotions' or key == 'followUpInterest' or key == 'multilingualConversations' then values[key] = change.value
                elseif key == 'audioDelay' then
                    local delays = manager.audioDelayChoices()
                    if type(change.value) ~= 'number' or change.value ~= math.floor(change.value) or not delays[change.value] then
                        return {ok = false, error = ui.t('Choose one of the listed lip sync delays.')}
                    end
                    values.audioDelay = delays[change.value]
                elseif key == 'subtitleStyle' then
                    if change.value ~= 1 and change.value ~= 2 then return {ok = false, error = ui.t('Choose one of the listed subtitle displays.')} end
                    -- Order: 1 Cinematic subtitles (stored 'dialogue'), 2 Above the speaker (stored 'overhead').
                    values.subtitleStyle = change.value == 1 and 'dialogue' or 'overhead'
                elseif key == 'uiLanguage' then
                    local choices = ui.choices()
                    if type(change.value) ~= 'number' or change.value ~= math.floor(change.value) or not choices[change.value] then
                        return {ok=false,error=ui.t('Choose an interface language.')}
                    end
                    values.uiLanguage = choices[change.value].value
                elseif key == 'voiceProvider' then
                    local choice = type(change.value) == 'number' and VOICE_CHOICES[change.value] or nil
                    if not choice then
                        return {ok = false, error = ui.t('Choose one of the listed companion voices.')}
                    end
                    -- Without the optional pack an OmniVoice entry cannot be applied: nothing changes and the
                    -- player is told what it needs.
                    if choice.provider == 'omni' and not manager.omniPack().installed then
                        return {ok = false, error = ui.t('Requires the optional OmniVoice pack (GPU)')}
                    end
                    values.voiceProvider = choice.provider
                    if choice.provider == 'omni' then values.omniSteps, values.omniReference = choice.steps, choice.reference end
                elseif key == 'eyeContactHeight' or key == 'headFollowStrength' then
                    local heights,strengths=manager.gazeChoices()
                    local choices=key=='eyeContactHeight' and heights or strengths
                    if type(change.value)~='number' or change.value~=change.value or change.value<1 or change.value>#choices
                        or change.value~=math.floor(change.value) then
                        return {ok = false, error = ui.t('Choose an eye contact option.')}
                    end
                    values[key]=choices[change.value]
                elseif key:sub(1, 13) == 'relationship:' then
                    if change.value ~= 1 and change.value ~= 2 and change.value ~= 3 then
                        return {ok = false, error = ui.t('Choose one of the listed relationship options.')}
                    end
                    values.relationshipModes[key:sub(14)] = ({'auto', 'on', 'off'})[change.value]
                elseif key:sub(1, 8) == 'enabled:' then values.enabledByKey[key:sub(9)] = change.value
                elseif key == 'archetypeConversations' then values.archetypeConversations = change.value
                else return {ok = false, error = ui.t('That setting is read-only.')} end
                applied[#applied + 1] = key
            end
            local ok, err, notice = manager.applySettings(player(), values)
            -- A voice switched for Natural speech is told to the player here (the status line) and, once back in
            -- gameplay, as a notice; the page reloads so the voice list shows the voice that was actually saved.
            if ok and notice then actionFeedback, refreshQueued = notice, true end
            return {ok = ok, error = ui.t(err), atomic = true, partial = false, appliedIds = ok and applied or {},
                schemaChanged = ok and notice ~= nil}
        end,
    }
end

local function connect()
    local ok, found = pcall(GetMod, 'ModConfigurationMenuAPI')
    if not ok or not found or found.apiVersion ~= 2 or not found.providers then return false end
    if api == found then return true end
    local registered, err = found.providers.registerProvider(provider)
    if not registered then lastError = tostring(err); return false end
    api = found
    voicePreview.bind(api)
    if type(api.subscribe) == 'function' then
        -- Record the moment of a draft change. This callback can run inside a
        -- native UI action, so it only stores a number.
        pcall(api.subscribe, 'drafts.changed', function(event)
            if type(event) == 'table' and event.modKey == MOD_KEY and (tonumber(event.count) or 0) > 0 then
                lastDraftEventAt = os.clock()
            end
        end)
    end
    api.refreshProvider(PROVIDER)
    log('Companion Manager registered with MCM API v2')
    return true
end

function M.install()
    if not connect() then return false end
    if hooksInstalled then return end
    hooksInstalled = true
    entry.install()
    fontPresentation.install()
    -- MCM's stock action banner says "Completed" when a request is accepted.
    -- Preparation may run while paused; actor creation waits for gameplay.
    -- Render the actual queue message
    -- only on our page and only for the action that supplied that message.
    Override('SettingsMainGameController', 'McmUiBegin', function(controller,
        title, subtitle, sidebarTitle, contentTitle, status, statusKind, transientOwner,
        showSidebarSearch, showContentSearch, listSelectionMode, wrapped)
        local own = active() and (transientOwner == MOD_KEY or contentTitle == ui.t(LABEL))
        -- "Opened Companion Manager." on every visit is noise.
        if own and tostring(status) == 'Opened ' .. ui.t(LABEL) .. '.' then status, statusKind = '', 0 end
        if own and tostring(status) == 'Opened Companion Manager.' then status, statusKind = '', 0 end
        local completed = tostring(status):sub(1, 10) == 'Completed:'
        local allowed = own and statusKind ~= 2 and (completed or status == '')
        presentation = {active = false, rows = {}, beginKey = controllerKey(controller),
            statusAllowed = allowed, statusRestore = allowed and completed and '' or status}
        voiceSelectors = {}
        if own and actionFeedback and completed and statusKind ~= 2 then
            status, statusKind = actionFeedback, 0
            presentation.preparationApplied = preparationActionFeedback == true
        end
        if own and completed and not actionFeedback and not preparationStatus then
            -- "Completed: <page>" after a navigation is noise. Real results (an
            -- action's own message, errors) still show.
            status, statusKind = '', 0
        end
        if allowed and preparationStatus then
            status, statusKind = preparationStatus.message, preparationStatus.failed and 2 or 0
            presentation.preparationApplied = true
            presentation.preparationSignature = preparationStatus.signature
        end
        presentation.statusText = status
        return wrapped(title, subtitle, sidebarTitle, contentTitle, status, statusKind,
            transientOwner, showSidebarSearch, showContentSearch, listSelectionMode)
    end)
    ObserveAfter('SettingsMainGameController', 'McmUiSetContentTitle', function(controller, title)
        local owned = title == ui.t(LABEL) and active()
        local key = owned and controllerKey(controller) or nil
        owned = owned and key ~= nil
        local previous = owned and presentation.beginKey == key and presentation or {}
        -- Queue only Lua data here. No ink traversal, getters or setters.
        presentation = {active = owned, pending = owned, rows = {}, hovered = {}, title = title,
            controller = owned and controller or nil, controllerKey = key,
            statusAllowed = previous.statusAllowed, statusRestore = previous.statusRestore,
            statusText = previous.statusText, preparationApplied = previous.preparationApplied,
            preparationSignature = previous.preparationSignature}
    end)
    Observe('SettingsMainGameController', 'OnUninitialize', function(controller)
        if ownsPresentation(controller) then
            presentation = {active = false, rows = {}}
            voiceSelectors = {}
        end
    end)
    ObserveAfter('SettingsSelectorController', 'McmUiConfigureBase', function(controller, host, id)
        local key = controllerKey(controller)
        if key then
            voiceSelectors[key] = id == MOD_KEY .. ':voiceProvider' and controllerKey(host) or nil
        end
    end)
    Override('SettingsSelectorController', 'McmUiEmitStep', function(controller, forward, wrapped)
        local key = controllerKey(controller)
        if key and presentation.active and active()
            and voiceSelectors[key] == presentation.controllerKey and type(api.getValue) == 'function' then
            local ok, value, err = pcall(api.getValue, MOD_KEY .. ':voiceProvider')
            if ok and not err and ((forward == false and value == 1) or (forward == true and value == #VOICE_CHOICES)) then
                -- Stop at the end of this voice list. Intercept the child
                -- before it emits the host event observed by MCM, whose normal
                -- cyclic navigation would move the marker the opposite way.
                return
            end
        end
        return wrapped(forward)
    end)
    ObserveAfter('SettingsMainGameController', 'McmUiSetManagedLabelState', function(controller, id, hovered)
        -- Native hover remains visible. After leaving a changed row, only its
        -- draft marker carries the modified state; label text stays uniform.
        if presentation.active and ownsPresentation(controller) then
            presentation.hovered[id] = hovered == true
            if not hovered then presentation.pending = true end
        end
    end)
    ObserveAfter('SettingsMainGameController', 'McmUiEmitHover', function(controller, id, _, hovered)
        if presentation.active and ownsPresentation(controller) then
            presentation.hovered[id] = hovered == true
            if not hovered then presentation.pending = true end
        end
    end)
    Observe('SettingsMainGameController', 'McmUiEmitAction', function(controller, id)
        if id ~= BACK_ID or not currentBack or not api or not active() then return end
        local ok, pending = pcall(api.hasDrafts, MOD_KEY)
        if ok and pending == true then
            -- MCM refuses navigation while changes are pending, and so does this.
            log('Back ignored: apply or revert the pending changes first')
            return
        end
        currentBack.callback({interaction = {controller = controller}})
        refreshQueued = true
    end)
    Observe('SettingsMainGameController', 'McmUiEmitSearch', function(_, context, value)
        if context == 'content' and active() then
            modelQuery, modelPage, searchFrames = tostring(value or ''):sub(1, 100), 1, 6
        end
    end)
    -- Leaving Settings with unapplied changes must ask first. MCM asks only from its
    -- own "cancel" key handler, and by the time RequestClose runs MCM's own observer
    -- has already closed the mod and discarded the drafts (the live Esc left with no
    -- prompt). So the question is raised earlier, from the key event itself, and
    -- RequestClose stays as a second guard. Both hand over to MCM's closing handler
    -- (McmUiEmitClosing), which shows its "Unsaved changes" dialog and resumes the
    -- close itself after Apply or Discard. With nothing pending nothing is held.
    local probeBudget = 60
    local function probe(text)
        if probeBudget > 0 then probeBudget = probeBudget - 1; log('Probe: ' .. text) end
    end
    local function pendingDrafts()
        if not api then return false end
        local ok, value = pcall(api.hasDrafts, MOD_KEY)
        return ok and value == true
    end
    local CLOSE_ACTIONS = {'back', 'cancel', 'OpenPauseMenu', 'close', 'pause_menu', 'UI_Cancel', 'UI_Back'}
    local function closeActions(event)
        local names = {}
        for _, name in ipairs(CLOSE_ACTIONS) do
            local ok, hit = pcall(function() return event:IsAction(CName.new(name)) end)
            if ok and hit then names[#names + 1] = name end
        end
        return names
    end
    local ask = {at = -1000, suppressUntil = -1000, count = 0}
    local function askBeforeLeaving(controller, why)
        local now = os.clock()
        if now - ask.at > 10 then ask.count = 0 end
        ask.at, ask.count = now, ask.count + 1
        ask.suppressUntil = now + 1.5
        log('Unapplied changes: asking before leaving (' .. why .. ', ' .. ask.count .. ')')
        local asked, err = pcall(function() controller:McmUiEmitClosing() end)
        if not asked then log('Could not ask before leaving: ' .. tostring(err)) end
        return asked
    end
    local function modalOpen(controller)
        local ok, open = pcall(function() return IsDefined(controller.m_mcmUiModal) end)
        if ok then return open == true end
        return os.clock() - ask.at < 20
    end
    local function hookInput(method)
        local hooked, hookError = pcall(Override, 'SettingsMainGameController', method, function(controller, event, wrapped)
            if presentation.active and ownsPresentation(controller) then
                local names = closeActions(event)
                if #names > 0 then
                    local pending = pendingDrafts()
                    probe(method .. ' [' .. table.concat(names, ',') .. '] drafts=' .. tostring(pending))
                    local isClose = false
                    for _, name in ipairs(names) do if name == 'back' or name == 'cancel' then isClose = true end end
                    if pending and isClose and ask.count < 5 then
                        local now = os.clock()
                        if method == 'OnButtonRelease' and now < ask.suppressUntil then return true end
                        if not modalOpen(controller) and askBeforeLeaving(controller, method) then return true end
                    end
                end
            end
            return wrapped(event)
        end)
        if not hooked then probe('could not hook ' .. method .. ': ' .. tostring(hookError)) end
    end
    hookInput('OnButtonRelease')
    hookInput('OnButtonPress')
    -- Cheap probes naming the real close path, for the live test.
    for _, candidate in ipairs({
        {'SettingsMainGameController', 'OnBack'}, {'SettingsMainGameController', 'OnBackClick'},
        {'SettingsMainGameController', 'OnCloseSettingsScreen'}, {'SettingsMainGameController', 'forceCloseSettings'},
        {'SettingsMainGameController', 'GoBack'}, {'SettingsMainGameController', 'CloseSettings'},
        {'SettingsMainGameController', 'OnHandleGlobalRelease'}, {'PauseMenuGameController', 'OnBack'},
        {'PauseMenuGameController', 'OnCloseMenu'}, {'PauseMenuGameController', 'OnHandleGlobalRelease'},
    }) do
        local ok = pcall(Observe, candidate[1], candidate[2], function()
            if presentation.active then probe(candidate[1] .. '.' .. candidate[2] .. ' drafts=' .. tostring(pendingDrafts())) end
        end)
        if not ok then probeBudget = probeBudget end
    end
    -- The same key also runs the game's own OnBack on this controller, which ends in
    -- closeMod (MCM discards the drafts). Hold it while changes are pending or the
    -- question is on screen; the dialog's Apply or Discard resumes the close.
    local backHooked, backHookError = pcall(Override, 'SettingsMainGameController', 'OnBack', function(controller, ...)
        local args = table.pack(...)
        local original = args[args.n]
        if presentation.active and ownsPresentation(controller) and pendingDrafts() and ask.count < 5 then
            local now = os.clock()
            probe('OnBack held (drafts pending)')
            if now - ask.at > 2 and not modalOpen(controller) then askBeforeLeaving(controller, 'OnBack') end
            return true
        end
        -- On a sub-page, Esc goes back to its parent; on Home it closes Settings. A
        -- repeated event for the same key, right after going back, is swallowed so it
        -- cannot go on to close Settings from Home.
        if presentation.active and ownsPresentation(controller) and not modalOpen(controller) then
            local now = os.clock()
            if now - lastBackAt <= 0.4 then return true end
            if view ~= 'home' and currentBack then
                lastBackAt = now
                probe('OnBack: back to the parent page from ' .. tostring(view))
                currentBack.callback({interaction = {controller = controller}})
                refreshQueued = true
                return true
            end
        end
        return original(table.unpack(args, 1, args.n - 1))
    end)
    if not backHooked then probe('could not hook OnBack: ' .. tostring(backHookError)) end
    Override('SettingsMainGameController', 'RequestClose', function(controller, wrapped)
        local pending = (presentation.active or active()) and pendingDrafts()
        probe('RequestClose drafts=' .. tostring(pending))
        if not pending then return wrapped() end
        -- Never trap the player: if MCM cannot show its dialog, or the request is
        -- repeated many times, let the close through.
        if ask.count >= 5 then log('Close allowed after repeated requests'); return wrapped() end
        if not askBeforeLeaving(controller, 'RequestClose') then return wrapped() end
    end)
end

function M.open()
    connect()
    return entry.open()
end

function M.update(currentPlayer, worldReady)
    local currentOwner = identity(currentPlayer)
    local messages = {}
    if currentOwner ~= owner then
        owner = currentOwner; queue.bind(owner); lastSignature = ''; refreshQueued = true
        if preparationActionFeedback then actionFeedback = nil end
        preparationTarget, preparationStatus, preparationActionFeedback = nil, nil, false
    end
    local board = invitationBoard()
    if worldReady then
        queue.flush()
        for _, notice in ipairs(queue.takeNotices()) do
            log(notice.message)
            -- An invitation outcome joins the merged notice; anything else is its own line.
            if board and notice.info then board.event(notice)
            else messages[#messages + 1] = {id = notice.id, text = notice.message} end
        end
    end
    entry.update()
    if ui.revision() ~= localeRevision then
        localeRevision, refreshQueued = ui.revision(), true
        if api and not api.hasDrafts(MOD_KEY) then api.refreshProvider(PROVIDER) end
    end
    local now = os.time()
    if now >= preparationAt then
        preparationAt = now + 1
        samplePreparationFeedback()
    end
    if support then
        -- A finished report is announced once, in gameplay (a paused menu hides popups).
        local reportOk, reportNotice = pcall(support.update, worldReady == true)
        if reportOk and reportNotice then messages[#messages + 1] = {id = 'support-report-saved', text = reportNotice} end
    end
    if worldReady then
        -- A voice that could not run is announced once, in gameplay.
        local voiceNotice = manager.takeVoiceFallbackNotice()
        if voiceNotice then log(voiceNotice); messages[#messages + 1] = {id = 'voice-fallback', text = voiceNotice} end
        local speechNotice = manager.takeNaturalSpeechNotice()
        if speechNotice then log(speechNotice); messages[#messages + 1] = {id = 'voice-switched', text = speechNotice} end
    end
    local progress = board and board.take(worldReady == true)
    if progress then messages[#messages + 1] = {id = 'invite-board', text = progress.message} end
    if #messages > 0 and currentPlayer then
        -- The same native neutral warning channel used by phone invitations, through the one
        -- notice gate (notices.lua): each line is shown or dropped by its class.
        -- Calls happen only here in top-level update, never inside MCM hooks.
        local sent = convaiNotices.sendLines(currentPlayer, messages) > 0
        if sent and progress then progress.commit() end
    end
    if now >= pollAt then pollAt = now + 1; M.install() end
    -- Read MCM's supported effective draft values from top-level update. The
    -- drafts.changed listener only marks this work pending in its callback.
    -- A staged voice never prepares a model, so no preview lease is ever offered.
    voicePreview.update(false, presentation.controllerKey, function() return manager.snapshot(currentPlayer).settings end)
    -- This also restores a shared description on foreign hover and keeps only
    -- our translated sidebar item readable when another mod is selected.
    fontPresentation.update()
    pcall(restoreStatusLine)
    if not active() then return end
    local styleOk, styleError = pcall(styleCompletedPage)
    if not styleOk then lastError = 'Settings presentation: ' .. tostring(styleError) end
    local placed, placeError = pcall(placeBackButton)
    if not placed then lastError = 'Back button: ' .. tostring(placeError) end
    local movedOk, movedError = pcall(placeStatusLine)
    if not movedOk then lastError = 'Status line: ' .. tostring(movedError) end
    local bannerOk, bannerError = pcall(updatePreparationBanner)
    if not bannerOk then lastError = 'Preparation presentation: ' .. tostring(bannerError) end
    if searchFrames > 0 then
        searchFrames = searchFrames - 1
        if searchFrames == 0 then refreshQueued = true end
    end
    if view == 'models' then
        local finished = manager.scanModels()
        if finished ~= M.scanComplete or (not finished and now >= (M.nextScanRefresh or 0)) then
            M.scanComplete, M.nextScanRefresh, refreshQueued = finished, now + 1, true
        end
    end
    if now >= snapshotAt then
        snapshotAt = now + 1
        local snapshot = manager.snapshot(currentPlayer)
        local statusOk, statusError = pcall(updateVoiceStatus, snapshot)
        if not statusOk then lastError = 'Voice service presentation: ' .. tostring(statusError) end
        local signature = {queue.message(), tostring(queue.count()), snapshot.localVoice.state or '',
            snapshot.localVoice.provider or '', tostring(snapshot.localVoice.pending),
            tostring(snapshot.localVoice.previewActive), tostring(snapshot.localVoice.preparationOnly)}
        local trip = queue.chauffeur()
        signature[#signature + 1] = table.concat({trip.phase or '', tostring(trip.stopPending),
            trip.reason or '', trip.error or ''}, '|')
        local memory = snapshot.memory
        if memory.command and memory.command.id == memoryActionCommand then actionFeedback = memory.feedback end
        signature[#signature + 1] = table.concat({memory.state, tostring(memory.talkedToCount), memory.feedback,
            memory.selectedKey or '', memory.confirmation and memory.confirmation.token or '',
            memory.command and memory.command.id or '', memory.command and memory.command.scope or '',
            memory.command and memory.command.profileKey or '', memory.command and memory.command.state or ''}, '|')
        for _, member in ipairs(queue.list()) do
            signature[#signature + 1] = table.concat({member.id, member.state or '', member.profileKey or '', member.error or '', member.dismissError or ''}, '|')
        end
        if support and view == 'help' then
            -- Refresh the Help page when the report state or service state changes.
            local reportSignature = support.signature()
            if reportSignature ~= supportSignature then
                supportSignature = reportSignature
                actionFeedback = support.banner() or actionFeedback
            end
            signature[#signature + 1] = 'help:' .. reportSignature .. '|' .. support.serviceState()
        end
        signature = table.concat(signature, '\n')
        if signature ~= lastSignature then lastSignature, refreshQueued = signature, true end
    end
    if refreshQueued and searchFrames == 0 and not api.hasDrafts(MOD_KEY) then
        refreshQueued = false
        local _, err = api.reloadMod(MOD_KEY)
        if err then lastError = tostring(err) end
    end
end

function M.inspect()
    local rowCount = 0
    for _ in pairs(presentation.rows) do rowCount = rowCount + 1 end
    return {available = api ~= nil, active = active(), view = view, entry = entry.state(),
        presentation = {active = presentation.active, pending = presentation.pending, title = presentation.title, rows = rowCount},
        entryDetails = entry.inspect and entry.inspect() or nil,
        back = currentBack and {id = currentBack.id, label = currentBack.label} or nil, backMode = backMode,
        party = queue.list(), feedback = queue.message(), error = lastError,
        voicePreview = voicePreview.inspect(),
        fonts = fontPresentation.inspect(),
        memory = manager.snapshot(player()).memory}
end

function M.party()
    return queue
end

function M.resetSession()
    -- The logical player ID can be reused by a loaded save. Explicitly reset
    -- pending work instead of relying on that ID to detect a new world.
    queue.bind(nil)
    manager.cancelMemoryConfirmation()
    actionFeedback = nil
    memoryActionCommand = nil
    preparationTarget, preparationStatus, preparationActionFeedback, preparationAt = nil, nil, false, 0
    owner, lastSignature, refreshQueued = nil, '', true
    presentation = {active = false, rows = {}}
    fontPresentation.reset()
    voicePreview.reset()
    entry.reset()
end

function M.shutdown(worldReady)
    -- onShutdown is a top-level CET lifecycle event, not a native ink callback.
    if worldReady ~= false then fontPresentation.restoreNow() end
    queue.bind(nil)
    if preparationActionFeedback then actionFeedback = nil end
    preparationTarget, preparationStatus, preparationActionFeedback, preparationAt = nil, nil, false, 0
    entry.reset()
    voicePreview.shutdown()
    if api then pcall(api.providers.unregisterProvider, PROVIDER, provider.registrationKey) end
    api = nil
    presentation = {active = false, rows = {}}
    voiceSelectors = {}
end

return M
