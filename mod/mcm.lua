-- MCM API v2 provider. Every control is rendered by the installed native
-- settings framework. No ImGui panel, HUD popup or copied MCM implementation.
local M = {}
local PROVIDER, MOD, LABEL = 'cyberpunk-convai', 'manager', 'Companion Manager'
local MOD_KEY, MODEL_PAGE_SIZE = PROVIDER .. ':' .. MOD, 18
local manager, queue, entry, api, provider
local view, modelQuery, modelPage, assigning = 'characters', '', 1, nil
local actions, hooksInstalled, refreshQueued = {}, false, false
local owner, lastSignature, pollAt, searchFrames, snapshotAt = nil, '', 0, 0, 0
local lastError = ''
local actionFeedback
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

local function readonly(id, label, value, description)
    return {id = id, label = label, value = value or '', description = description or '', type = 'string',
        capabilities = {read = true, write = false, draft = false, reset = false}}
end

local function setting(id, label, kind, value, default, description, elements)
    return {id = id, label = label, type = kind, value = value, defaultValue = default,
        description = description, elements = elements,
        capabilities = {read = true, write = true, draft = true, reset = true}}
end

local function action(id, label, value, description, callback, enabled)
    actions[id] = callback
    return {id = id, label = label, value = value, description = description,
        type = 'action', disabled = enabled == false,
        capabilities = {read = true, action = enabled ~= false, write = false, draft = false, reset = false}}
end

local function category(id, name, settings, description)
    return {id = id, name = name, description = description or '', settings = settings}
end

local function clearSearch(context)
    modelQuery, modelPage, searchFrames = '', 1, 0
    local controller = context and context.interaction and context.interaction.controller
    if controller then pcall(function() controller:McmUiEmitSearch('content', '') end) end
end

local function navigate(nextView, context)
    view, assigning = nextView, nil
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
    local voice = profile.voiceName or 'Convai voice'
    if snapshot.settings.voiceProvider ~= 'convai' and (profile.key == 'judy-alvarez'
        or profile.key == 'panam-palmer' or profile.key == 'johnny-silverhand') then
        voice = 'OmniVoice ' .. snapshot.settings.omniSteps .. ' steps'
    end
    return (profile.summary or profile.name) .. '\n\nVoice: ' .. voice
        .. '\nConversation: ' .. (snapshot.settings.enabledByKey[profile.key] ~= false and 'On' or 'Off')
        .. '\nInvitations create separate companion copies, including characters outside your phone contacts.'
end

local function schema()
    local currentPlayer = player()
    owner = identity(currentPlayer)
    queue.bind(owner)
    local snapshot, party = manager.snapshot(currentPlayer), queue.list()
    actions = {}
    local navigation = {}
    for _, tab in ipairs({{'characters', 'Characters'}, {'party', 'Current party'},
        {'models', 'Model browser'}, {'settings', 'Settings'}}) do
        local selected = view == tab[1] or (tab[1] == 'settings' and view == 'permissions')
        navigation[#navigation + 1] = action('tab:' .. tab[1], tab[2], selected and 'Selected' or 'Open',
            'Browse ' .. tab[2]:lower() .. '. ' .. modelQuery,
            function(context) return navigate(tab[1], context) end, not selected)
    end
    local categories = {category('navigation', 'Companion Manager', navigation)}
    local message = queue.message()
    local status = {readonly('party-count', 'Companions', queue.count() .. ' / 8',
        'Manage separate copies of the same or different characters. Invitations and dismissals take effect when you leave the menu.')}
    if message ~= '' then status[#status + 1] = readonly('feedback', message, '', message) end
    categories[#categories + 1] = category('party-status', 'Your group', status)
    local rows = {}
    local canInvite = owner ~= nil and queue.count() < 8
    if view == 'characters' then
        for _, profile in ipairs(snapshot.profiles) do
            local key = profile.key
            local count = countKey(party, key)
            local available = manager.definition(key) ~= nil
            rows[#rows + 1] = action('invite:' .. key, profile.name,
                available and (count > 0 and ('Add copy (' .. count .. ')') or 'Invite') or 'Profile only',
                profileDescription(profile, snapshot), function() return queue.invite(key) end, canInvite and available)
        end
        categories[#categories + 1] = category('characters', 'Characters', rows,
            'Search a character by name. Invite another copy at any time; your party can have up to eight companions.')
    elseif view == 'party' then
        if #party == 0 then rows[#rows + 1] = readonly('empty-party', 'Your party is empty', '', 'Invite someone from Characters or Model browser.') end
        local states = {ready = 'Following', spawning = 'Joining', queued = 'Invited', leaving = 'Leaving', failed = 'Unavailable', missing = 'Missing'}
        for _, member in ipairs(party) do
            local id, display = member.id, member.name .. ' · ' .. (member.serial and ('#' .. member.serial) or 'invited copy')
            rows[#rows + 1] = readonly('state:' .. id, display, states[member.state] or member.state,
                member.error or (member.state == 'queued' and 'Will join when you return to gameplay.' or 'This is a separate, mod-owned companion.'))
            rows[#rows + 1] = action('assign:' .. id, 'Conversation', member.profileName or 'Choose a profile',
                'Choose the personality for ' .. display .. '. The character model stays the same.',
                function(context) assigning, view = id, 'assignment'; clearSearch(context); return true end,
                member.state ~= 'leaving' and member.state ~= 'missing')
            local leaving = member.state == 'leaving'
            rows[#rows + 1] = action('dismiss:' .. id, display,
                leaving and 'Keep in party' or (member.serial and 'Dismiss' or 'Cancel invitation'),
                leaving and 'Undo this pending dismissal.' or 'Remove only this copy from your group.',
                function()
                    if leaving then return queue.undoDismiss(id) end
                    return queue.dismiss(id)
                end)
        end
        categories[#categories + 1] = category('party', 'Current party', rows)
    elseif view == 'assignment' then
        local target
        for _, member in ipairs(party) do if member.id == assigning then target = member end end
        if not target then view, assigning = 'party', nil; return schema() end
        rows[#rows + 1] = action('assign:none', 'No conversation profile', 'Choose',
            'Keep ' .. target.name .. ' as a follower without AI conversations.',
            function(context)
                local ok, err = queue.assign(assigning, nil)
                if ok then navigate('party', context) end
                return ok, err
            end)
        for _, profile in ipairs(snapshot.profiles) do
            local key, name = profile.key, profile.name
            rows[#rows + 1] = action('assign-profile:' .. key, name, 'Choose', profileDescription(profile, snapshot),
                function(context)
                    local ok, err = queue.assign(assigning, key, name)
                    if ok then navigate('party', context) end
                    return ok, err
                end)
        end
        categories[#categories + 1] = category('assignment', 'Conversation for ' .. target.name, rows)
    elseif view == 'models' then
        local matches = {}
        local query = modelQuery:lower()
        for _, model in ipairs(snapshot.models) do
            if query == '' or model.search:find(query, 1, true) then matches[#matches + 1] = model end
        end
        local pages = math.max(1, math.ceil(#matches / MODEL_PAGE_SIZE))
        modelPage = math.max(1, math.min(modelPage, pages))
        local scan = snapshot.scan
        rows[#rows + 1] = readonly('model-status', scan.finished and (#matches .. ' matching models') or 'Reading installed models…',
            'Page ' .. modelPage .. ' / ' .. pages,
            'Search by character name or model record using Search settings. ' .. modelQuery
                .. '\n' .. (scan.error or 'Models without a conversation identity can be assigned one in Current party.'))
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
            rows[#rows + 1] = action('invite:' .. key, model.name, 'Invite',
                model.record .. '\n\n' .. (model.profileName and ('Conversation: ' .. model.profileName)
                    or 'No conversation profile. Assign a profile in Current party after inviting this model.')
                    .. '\nSome game models have special rigs or roles and may not behave as ordinary companions.',
                function() return queue.invite(key) end, canInvite)
        end
        categories[#categories + 1] = category('models', 'Installed character models', rows)
    elseif view == 'permissions' then
        for _, profile in ipairs(snapshot.profiles) do
            rows[#rows + 1] = setting('enabled:' .. profile.key, profile.name, 'bool',
                snapshot.settings.enabledByKey[profile.key] ~= false, true,
                'Allow ' .. profile.name .. ' in private and group conversations. Existing copies can still follow you when this is off.')
        end
        categories[#categories + 1] = category('permissions', 'Character conversations', rows)
    else
        rows = {
            setting('voice', 'Voice playback', 'bool', snapshot.settings.voice, true, 'Play voiced replies from your companions.'),
            setting('subtitles', 'Dialogue subtitles', 'bool', snapshot.settings.subtitles, true, 'Show companion replies through the game’s native dialogue subtitles.'),
            setting('disappearingMessages', 'Disappearing messages', 'bool', snapshot.settings.disappearingMessages, false,
                'Clear the phone Chat history and drafts when you next launch the game. Characters keep their Convai conversation memory. Loading a save or reloading mods does not clear messages.'),
            setting('voiceProvider', 'Companion voices', 'select', snapshot.settings.voiceProvider == 'convai' and 2 or 1, 1,
                'OmniVoice gives Johnny, Judy and Panam their prepared local voices. Convai uses each character’s configured online voice and releases the local model’s GPU memory. Other characters always use Convai. Changes wait for the current reply to finish.',
                {'OmniVoice + Convai (default)', 'Convai for all characters'}),
            setting('omniSteps', 'Local voice quality', 'select', snapshot.settings.omniSteps == 16 and 1 or 2, 2,
                'Applies while OmniVoice is selected. 32 steps gives the preferred quality; 16 steps is faster. One shared model stays loaded until you select Convai or stop the voice service.',
                {'16 steps · Faster', '32 steps · Higher quality (default)'}),
        }
        local voiceLabels = {ready = 'Ready', loading = 'Loading', warming = 'Preparing voices', speaking = 'Preparing a reply',
            error = 'Unavailable', waiting = 'Waiting for voice service', disabled = 'Not configured', stopped = 'Stopped',
            releasing = 'Releasing local voice memory', remote = 'Convai voices · Local model unloaded'}
        local voiceStatus = snapshot.localVoice.pending and 'Changing after the current reply'
            or voiceLabels[snapshot.localVoice.state] or 'Waiting for voice service'
        rows[#rows + 1] = readonly('voice-status', 'Voice service', voiceStatus,
            'OmniVoice stays warm while selected. Switching back from Convai prepares the model again; no game restart is needed.')
        rows[#rows + 1] = action('permissions', 'Character conversations', 'Manage',
            'Enable or disable each character’s participation in AI conversations.',
            function(context) return navigate('permissions', context) end)
        categories[#categories + 1] = category('playback', 'Conversation settings', rows,
            'Use Apply to save changed settings, or Revert to discard them.')
    end
    return {name = LABEL, description = 'Your companions, character models and conversation settings.', categories = categories}
end

function M.configure(domain, companions, queueFactory, entryFactory)
    manager, queue = domain, queueFactory.new(companions)
    entry = entryFactory.new(LABEL, function() return api ~= nil end, log)
    provider = {
        id = PROVIDER, registrationKey = 'cyberpunk-convai.manager.v1', apiVersion = 2,
        name = 'Cyberpunk Convai', shortName = 'CONVAI',
        capabilities = {index = true, lazy = true, draft = true, action = true, atomicApply = true, dynamicSchema = true},
        listMods = function()
            return {complete = true, revision = '1', mods = {{id = MOD, name = LABEL,
                description = 'Invite characters, manage your group, browse game models and configure conversations.'}}}
        end,
        loadMod = function(id)
            if id ~= MOD then return nil, 'Unknown mod.' end
            entry.selected()
            return schema()
        end,
        invokeAction = function(id, actionId, context)
            if id ~= MOD or not actions[actionId] then return {ok = false, error = 'Reopen the manager; that action is no longer available.'} end
            local ok, reason = actions[actionId](context)
            actionFeedback = ok == true and reason or nil
            return {ok = ok == true, error = ok ~= true and reason or nil, schemaChanged = ok == true}
        end,
        applyBatch = function(id, changes)
            if id ~= MOD then return {ok = false, error = 'Unknown mod.'} end
            local values, applied = {enabledByKey = {}}, {}
            for _, change in ipairs(changes) do
                local key = change.id
                if key == 'voice' or key == 'subtitles' or key == 'disappearingMessages' then values[key] = change.value
                elseif key == 'omniSteps' then
                    if change.value ~= 1 and change.value ~= 2 then return {ok = false, error = 'Choose a voice quality.'} end
                    values.omniSteps = change.value == 1 and 16 or 32
                elseif key == 'voiceProvider' then
                    if change.value ~= 1 and change.value ~= 2 then return {ok = false, error = 'Choose OmniVoice or Convai voices.'} end
                    values.voiceProvider = change.value == 1 and 'hybrid' or 'convai'
                elseif key:sub(1, 8) == 'enabled:' then values.enabledByKey[key:sub(9)] = change.value
                else return {ok = false, error = 'That setting is read-only.'} end
                applied[#applied + 1] = key
            end
            local ok, err = manager.applySettings(player(), values)
            return {ok = ok, error = err, atomic = true, partial = false, appliedIds = ok and applied or {}, schemaChanged = false}
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
    api.refreshProvider(PROVIDER)
    log('Companion Manager registered with MCM API v2')
    return true
end

function M.install()
    if not connect() then return false end
    if hooksInstalled then return end
    hooksInstalled = true
    entry.install()
    -- MCM's stock action banner says "Completed" when a request is accepted.
    -- Our world work is deferred until unpause; render its actual queue message
    -- only on our page and only for the action that supplied that message.
    Override('SettingsMainGameController', 'McmUiBegin', function(controller,
        title, subtitle, sidebarTitle, contentTitle, status, statusKind, transientOwner,
        showSidebarSearch, showContentSearch, listSelectionMode, wrapped)
        if contentTitle == LABEL and active() and actionFeedback
            and tostring(status):sub(1, 10) == 'Completed:' then
            status, statusKind = actionFeedback, 0
        end
        return wrapped(title, subtitle, sidebarTitle, contentTitle, status, statusKind,
            transientOwner, showSidebarSearch, showContentSearch, listSelectionMode)
    end)
    Observe('SettingsMainGameController', 'McmUiEmitSearch', function(_, context, value)
        if context == 'content' and view == 'models' and active() then
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
    if currentOwner ~= owner then
        owner = currentOwner; queue.bind(owner); lastSignature = ''; refreshQueued = true
    end
    if worldReady then
        queue.flush()
        local messages = {}
        for _, notice in ipairs(queue.takeNotices()) do
            log(notice.message)
            messages[#messages + 1] = notice.message
        end
        if #messages > 0 then
            pcall(function() currentPlayer:ConvaiPhoneFeedback(table.concat(messages, '\n')) end)
        end
    end
    entry.update()
    local now = os.time()
    if now >= pollAt then pollAt = now + 1; M.install() end
    if not active() then return end
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
        local signature = {queue.message(), tostring(queue.count()), snapshot.localVoice.state or '',
            snapshot.localVoice.provider or '', tostring(snapshot.localVoice.pending)}
        for _, member in ipairs(queue.list()) do
            signature[#signature + 1] = table.concat({member.id, member.state or '', member.profileKey or '', member.error or ''}, '|')
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
    return {available = api ~= nil, active = active(), view = view, entry = entry.state(),
        entryDetails = entry.inspect and entry.inspect() or nil,
        party = queue.list(), feedback = queue.message(), error = lastError}
end

function M.resetSession()
    -- The logical player ID can be reused by a loaded save. Explicitly reset
    -- pending work instead of relying on that ID to detect a new world.
    queue.bind(nil)
    actionFeedback = nil
    owner, lastSignature, refreshQueued = nil, '', true
    entry.reset()
end

function M.shutdown()
    queue.bind(nil)
    entry.reset()
    if api then pcall(api.providers.unregisterProvider, PROVIDER, provider.registrationKey) end
    api = nil
end

return M
