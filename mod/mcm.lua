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
local preparationPopup
local presentation = {active = false, rows = {}}
local voiceSelectors = {}
local localeRevision = -1
-- The voice choice is staged here, in Lua, and committed only by this page's own
-- "Apply voice change" row. It cannot rely on MCM's Apply bar: the player's MCM
-- may be set to Auto Apply, which commits every edit at once. Nothing reaches the
-- conversation service (no model is prepared) until that row is chosen.
local stagedVoice
local VOICE_CHOICES = {{'omni', 16}, {'omni', 32}, {'pocket'}, {'convai'}}
local voicePreview = dofile('voice-preview.lua').new()
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
    return findWidget(root, 'mcm_content_scroll_content', 18), render and findWidget(render, 'status', 18)
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
    local content, status = contentWidgets(presentation.controller)
    presentation.statusWidget = status
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
    if nextView == 'home' then stagedVoice = nil end
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

local function profileDescription(profile, snapshot)
    local voice = profile.voiceName or ui.t('Convai voice')
    -- The label names the voice actually in use, which differs from the choice
    -- while a fallback is active.
    local active = snapshot.localVoice.provider
    if active == 'pocket' or active == 'omni' then
        for _, key in ipairs(snapshot.localVoice.routedProfiles or {}) do
            if key == profile.key then
                voice = manager.voiceLabel(active, snapshot.localVoice.omniSteps)
                break
            end
        end
    end
    return (profile.summary or profile.name) .. '\n\n' .. ui.t('Voice: {voice}',{voice=voice})
        .. '\n' .. ui.t('Conversation: {state}',{state=ui.t(snapshot.settings.enabledByKey[profile.key] ~= false and 'On' or 'Off')})
        .. '\n' .. ui.t('Invitations create separate companion copies, including characters outside your phone contacts. Memory and connection preparation starts immediately; the copy joins when ready after you return to gameplay.')
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
            voice = manager.voiceLabel(fallback.to, state.omniSteps),
            requested = manager.voiceLabel(fallback.from, state.requestedOmniSteps)})
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

-- The status line, plus the staged choice that Apply has not committed yet.
local function voiceStatusText(snapshot)
    local text = voiceServiceLabel(snapshot.localVoice)
    local choice = stagedVoice and VOICE_CHOICES[stagedVoice]
    if choice then
        text = ui.t('{status} · Pending: {voice}. Apply to use it.',
            {status = text, voice = manager.voiceLabel(choice[1], choice[2])})
    end
    return text
end

local function updateVoiceStatus(snapshot)
    if view ~= 'settings' or not presentation.active or not presentation.voiceStatus then return end
    local text = voiceStatusText(snapshot)
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

local function developerMode()
    if not manager or type(manager.developerMode) ~= 'function' then return false end
    local ok, enabled = pcall(manager.developerMode)
    return ok and enabled == true
end

local function samplePreparationPopup(now, worldReady)
    local tracking = preparationPopup
    if not tracking then return nil end
    if now < tracking.nextAt and tracking.worldReady == worldReady then return nil end
    tracking.nextAt, tracking.worldReady = now + 1, worldReady
    local current = queue.invitationFeedback(tracking.id)
    if not current then preparationPopup = nil; return nil end
    if current.failed then
        -- A failure is always visible, but only once per attempt and only in
        -- gameplay. The paused menu shows it in the banner and must not
        -- consume the claim, so it is posted when gameplay resumes.
        if not worldReady then return nil end
        if queue.claimPreparationFailure
            and not queue.claimPreparationFailure(current.id, current.revision) then return nil end
    end
    -- Native warning notifications can be hidden behind a paused menu. Keep
    -- only the current snapshot and announce it once again in gameplay, never
    -- a backlog of memory/connecting stages that may already be obsolete.
    if worldReady and (current.state == 'ready' or current.state == 'model-only') then
        current.state = 'joining'
        current.signature = table.concat({current.id, tostring(current.revision), 'joining'}, '|')
        current.message = ui.t('{name} is joining your party.', {name = current.name})
    end
    -- Progress the player waits on (preparing memory, connecting) and the
    -- "ready to join when you return" instruction are always shown, so a slow
    -- preparation is not mistaken for a failure. "Joining" asks nothing of the
    -- player and is a Developer-mode popup; the manager banner shows it anyway.
    if current.state == 'joining' and not developerMode() then return nil end
    if current.signature == tracking.shown
        and (not worldReady or current.signature == tracking.shownInGameplay) then return nil end
    return current
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
    local categories = {}
    local rows = {}
    -- The party has a fixed number of formation places. It is not shown: a full
    -- party answers an invitation with a message from the queue.
    local canInvite = owner ~= nil
    if view == 'home' then
        for _, tab in ipairs({{'characters', 'Characters'}, {'party', 'Current party'},
            {'models', 'Model browser'}, {'settings', 'Settings'}}) do
            rows[#rows + 1] = action('tab:' .. tab[1], tab[2], 'Open',
                ui.t('Browse {section}. {query}',{section=ui.t(tab[2]):lower(),query=modelQuery}),
                function(context) return navigate(tab[1], context) end)
        end
        categories[#categories + 1] = category('navigation', 'Companion Manager', rows)
    elseif view == 'characters' then
        for _, profile in ipairs(snapshot.profiles) do
            local key = profile.key
            local count = countKey(party, key)
            local available = manager.definition(key) ~= nil
            rows[#rows + 1] = action('invite:' .. key, profile.name,
                available and (count > 0 and ui.t('Add copy ({count})',{count=count}) or 'Invite') or 'Profile only',
                profileDescription(profile, snapshot), function() return queue.invite(key) end, canInvite and available)
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
        categories[#categories + 1] = category('party-status', 'Your group', status)
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
        rows[#rows + 1] = readonly('model-status', scan.finished and ui.t('{count} matching models',{count=#matches}) or 'Reading installed models…',
            ui.t('Page {page} / {pages}',{page=modelPage,pages=pages}),
            ui.t('Search by character name or model record using Search settings. {query}',{query=modelQuery})
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
            rows[#rows + 1] = action('invite:' .. key, modelName, 'Invite',
                model.record .. '\n\n' .. (model.profileName and ui.t('Conversation: {state}',{state=model.profileName})
                    or ui.t('No conversation profile. This model joins as a follower without AI conversations.'))
                    .. '\n' .. ui.t('Some game models have special rigs or roles and may not behave as ordinary companions.'),
                function() return queue.invite(key) end, canInvite)
        end
        categories[#categories + 1] = category('models', 'Installed character models', rows)
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
            local description = profile.key == 'meredith-stout'
                and 'Auto follows the completed encounter in this save. On uses the intimate profile; Off uses the ordinary profile. This does not imply an ongoing relationship.'
                or 'Auto follows the relationship in this save. On uses the romantic profile; Off uses the ordinary profile. This changes conversations without changing game choices.'
            rows[#rows + 1] = setting('relationship:' .. profile.key, profile.name, 'select',
                mode == 'on' and 2 or mode == 'off' and 3 or 1, 1, description, {'Auto', 'On', 'Off'})
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
        categories[#categories + 1] = category('permissions', 'Character conversations', rows)
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
            action('permissions', 'Character conversations', 'Manage',
                'Enable or disable each character’s participation in AI conversations.',
                function(context) return navigate('permissions', context) end),
            action('memory', 'Memory', 'Manage',
                'Choose a character, review memory status and manage memories from your conversations.',
                function(context) return navigate('memory', context) end),
            action('relationships', 'Relationships', 'Manage',
                'Choose ordinary or romantic conversations for supported characters.',
                function(context) return navigate('relationships', context) end),
        })
        local heights,strengths=manager.gazeChoices()
        local heightIndex,strengthIndex=3,3
        for index,value in ipairs(heights) do if snapshot.settings.eyeContactHeight==value then heightIndex=index end end
        for index,value in ipairs(strengths) do if snapshot.settings.headFollowStrength==value then strengthIndex=index end end
        categories[#categories + 1] = category('companion-behavior', 'Companion behavior', {
            setting('eyeContactHeight', 'Eye contact height', 'select', heightIndex, 3,
                'Raise or lower the point companions look at on V. Default uses V’s usual eye contact target.',
                {'10 cm lower', '5 cm lower', 'Default', '5 cm higher', '10 cm higher'}),
            setting('headFollowStrength', 'Head tracking strength', 'select', strengthIndex, 3,
                'Choose how much companions turn their heads during eye contact. Eyes only relies on eye movement.',
                {'Eyes only', 'Less', 'Gentle (default)', 'More'}),
            setting('bodyGestures', 'Body gestures', 'bool', snapshot.settings.bodyGestures, false,
                'Companions gesture with their body while they speak longer replies and nod while you talk to them, using the game’s own animations in their usual stance. They stop at once when anyone moves or a fight starts.'),
        })
        local voiceStatus = voiceStatusText(snapshot)
        -- The list, best first: OmniVoice 16 steps, OmniVoice 32 steps, Pocket TTS, Convai cloud voice.
        local savedVoice = snapshot.settings.voiceProvider == 'convai' and 4
            or (snapshot.settings.voiceProvider == 'pocket' and 3
                or (snapshot.settings.omniSteps == 32 and 2 or 1))
        if stagedVoice == savedVoice then stagedVoice = nil end
        local voiceIndex = stagedVoice or savedVoice
        local voiceRows = {
            setting('voice', 'Voice playback', 'bool', snapshot.settings.voice, true, 'Play voiced replies from your companions.'),
            setting('voiceProvider', 'Companion voices', 'select', voiceIndex, 1,
                'OmniVoice uses the GPU and sounds closest to the characters. 16 steps sounds the same in tests as 32 steps at half the GPU time, so it is the default. Pocket TTS runs on the CPU. Convai cloud voice streams online voices. If a choice cannot run, the next one in the list is used and you are told once. Choosing a voice only stages it: nothing changes, and no model is prepared, until you choose Apply voice change; Revert voice change discards it.',
                {'OmniVoice 16 steps', 'OmniVoice 32 steps', 'Pocket TTS', 'Convai cloud voice'}),
            readonly('voice-status', 'Voice service', voiceStatus,
                'Nothing is prepared or changed until you choose Apply voice change. Revert voice change discards the choice; no game restart is needed.'),
        }
        if stagedVoice then
            local choice = VOICE_CHOICES[stagedVoice]
            local label = manager.voiceLabel(choice[1], choice[2])
            voiceRows[#voiceRows + 1] = action('voice:apply', 'Apply voice change', 'Apply',
                ui.t('Switch companions to {voice}. It takes effect when no reply is being spoken.', {voice = label}),
                function()
                    local target = stagedVoice
                    if not target then return false, ui.t('There is no voice change to apply.') end
                    local pick = VOICE_CHOICES[target]
                    local ok, err = manager.applySettings(player(), {voiceProvider = pick[1], omniSteps = pick[2]})
                    if not ok then return false, ui.t(err) end
                    stagedVoice = nil
                    return true, ui.t('Voice set to {voice}.', {voice = label})
                end)
            voiceRows[#voiceRows + 1] = action('voice:revert', 'Revert voice change', 'Revert',
                'Keep the current voice and discard the staged choice.',
                function() stagedVoice = nil; return true, ui.t('Voice change discarded.') end)
        end
        categories[#categories + 1] = category('voices', 'Voices', voiceRows,
            'Choosing a voice stages it. Choose Apply voice change to use it.')
        categories[#categories + 1] = category('subtitles', 'Subtitles', {
            setting('subtitles', 'Subtitles', 'bool', snapshot.settings.subtitles, true, 'Show companion replies using the selected subtitle display.'),
            setting('subtitleStyle', 'Subtitle display', 'select', snapshot.settings.subtitleStyle == 'overhead' and 1 or 2, 2,
                'Use the regular dialogue HUD by default, or place subtitles above the speaking companion. The Subtitles switch controls both.',
                {'Above speaker', 'Dialogue HUD'}),
        })
        categories[#categories + 1] = category('reactions', 'Automatic reactions', {
            setting('battleReactions', 'React to battles', 'bool', snapshot.settings.battleReactions, true,
                'A nearby companion can make one short comment as combat starts and another afterward. Ten-minute cooldown after a fight; conversations and story scenes take priority. Loading a save resets the cooldown.'),
            setting('lootReactions', 'React to collected loot', 'bool', snapshot.settings.lootReactions, true,
                'Companions can comment after you finish collecting world loot. Storage transfers stay silent. A ten-minute cooldown spaces ordinary comments; newly acquired Legendary equipment has a separate two-minute cooldown. After a fight, pickups collected by then are folded into one end-of-fight comment; later pickups get their own comment.'),
        })
        categories[#categories + 1] = category('development', 'Development', {
            setting('developerMode', 'Developer mode', 'bool', snapshot.settings.developerMode, false,
                'Show routine companion popups: the joining step, dismissal confirmations, and driving instructions such as boarding and exit. Preparation progress, joined notices, failures and replies to Stop trip remain visible when off.'),
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
                preparationPopup = {id = invitationId, nextAt = 0}
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
            local values, applied = {enabledByKey = {}, relationshipModes = {}}, {}
            for _, change in ipairs(changes) do
                local key = change.id
                if key == 'voice' or key == 'subtitles' or key == 'followUpQuestions' or key == 'developerMode'
                    or key == 'battleReactions' or key == 'lootReactions' or key == 'bodyGestures' then values[key] = change.value
                elseif key == 'subtitleStyle' then
                    if change.value ~= 1 and change.value ~= 2 then return {ok = false, error = ui.t('Choose Above speaker or Dialogue HUD.')} end
                    values.subtitleStyle = change.value == 1 and 'overhead' or 'dialogue'
                elseif key == 'uiLanguage' then
                    local choices = ui.choices()
                    if type(change.value) ~= 'number' or change.value ~= math.floor(change.value) or not choices[change.value] then
                        return {ok=false,error=ui.t('Choose an interface language.')}
                    end
                    values.uiLanguage = choices[change.value].value
                elseif key == 'voiceProvider' then
                    if change.value ~= 1 and change.value ~= 2 and change.value ~= 3 and change.value ~= 4 then
                        return {ok = false, error = ui.t('Choose OmniVoice 16 steps, OmniVoice 32 steps, Pocket TTS or Convai cloud voice.')}
                    end
                    -- Staged, never committed here: MCM may be applying every edit
                    -- as it is made. The Apply voice change row commits it.
                    stagedVoice = change.value
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
                        return {ok = false, error = ui.t('Choose Auto, On or Off for each relationship.')}
                    end
                    values.relationshipModes[key:sub(14)] = ({'auto', 'on', 'off'})[change.value]
                elseif key:sub(1, 8) == 'enabled:' then values.enabledByKey[key:sub(9)] = change.value
                else return {ok = false, error = ui.t('That setting is read-only.')} end
                applied[#applied + 1] = key
            end
            local ok, err = manager.applySettings(player(), values)
            return {ok = ok, error = ui.t(err), atomic = true, partial = false, appliedIds = ok and applied or {}, schemaChanged = false}
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
        local completed = tostring(status):sub(1, 10) == 'Completed:'
        local allowed = own and statusKind ~= 2 and (completed or status == '')
        presentation = {active = false, rows = {}, beginKey = controllerKey(controller),
            statusAllowed = allowed, statusRestore = allowed and completed and '' or status}
        voiceSelectors = {}
        if own and actionFeedback and completed and statusKind ~= 2 then
            status, statusKind = actionFeedback, 0
            presentation.preparationApplied = preparationActionFeedback == true
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
            if ok and not err and ((forward == false and value == 1) or (forward == true and value == 4)) then
                -- Stop at the end of this four-choice row. Intercept the child
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
    Observe('SettingsMainGameController', 'McmUiEmitSearch', function(_, context, value)
        if context == 'content' and active() then
            modelQuery, modelPage, searchFrames = tostring(value or ''):sub(1, 100), 1, 6
        end
    end)
end

function M.open()
    connect()
    return entry.open()
end

function M.update(currentPlayer, worldReady)
    local currentOwner = identity(currentPlayer)
    local messages, notifiedInvitations = {}, {}
    if currentOwner ~= owner then
        owner = currentOwner; queue.bind(owner); lastSignature = ''; refreshQueued = true
        if preparationActionFeedback then actionFeedback = nil end
        preparationTarget, preparationStatus, preparationActionFeedback = nil, nil, false
        preparationPopup = nil
    end
    if worldReady then
        queue.flush()
        for _, notice in ipairs(queue.takeNotices()) do
            log(notice.message)
            messages[#messages + 1] = notice.message
            if notice.invitationId then notifiedInvitations[notice.invitationId] = true end
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
        if reportOk and reportNotice then messages[#messages + 1] = reportNotice end
    end
    if worldReady then
        -- A voice that could not run is announced once, in gameplay.
        local voiceNotice = manager.takeVoiceFallbackNotice()
        if voiceNotice then log(voiceNotice); messages[#messages + 1] = voiceNotice end
    end
    local progress = samplePreparationPopup(now, worldReady == true)
    if progress and not notifiedInvitations[progress.id] then messages[#messages + 1] = progress.message end
    if #messages > 0 and currentPlayer then
        -- The same native neutral warning channel used by phone invitations.
        -- Calls happen only here in top-level update, never inside MCM hooks.
        local sent = pcall(function() currentPlayer:ConvaiPhoneFeedback(table.concat(messages, '\n')) end)
        if sent and progress and preparationPopup and preparationPopup.id == progress.id then
            preparationPopup.shown = progress.signature
            if worldReady then preparationPopup.shownInGameplay = progress.signature end
        end
    end
    if now >= pollAt then pollAt = now + 1; M.install() end
    -- Read MCM's supported effective draft values from top-level update. The
    -- drafts.changed listener only marks this work pending in its callback.
    -- A staged voice never prepares a model, so no preview lease is ever offered.
    voicePreview.update(false, presentation.controllerKey, function() return manager.snapshot(currentPlayer).settings end)
    -- This also restores a shared description on foreign hover and keeps only
    -- our translated sidebar item readable when another mod is selected.
    fontPresentation.update()
    if not active() then return end
    local styleOk, styleError = pcall(styleCompletedPage)
    if not styleOk then lastError = 'Settings presentation: ' .. tostring(styleError) end
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
        local signature = {queue.message(), tostring(queue.count()), tostring(stagedVoice), snapshot.localVoice.state or '',
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
    preparationPopup = nil
    owner, lastSignature, refreshQueued = nil, '', true
    stagedVoice = nil
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
    preparationPopup = nil
    entry.reset()
    stagedVoice = nil
    voicePreview.shutdown()
    if api then pcall(api.providers.unregisterProvider, PROVIDER, provider.registrationKey) end
    api = nil
    presentation = {active = false, rows = {}}
    voiceSelectors = {}
end

return M
