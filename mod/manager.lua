-- Native manager data and actions. Widgets live in redscript; only eight rows
-- cross that boundary at once. Every spawn goes through owned companions.
local M = {}
local PAGE_SIZE, SCAN_BATCH = 8, 48
local legacyKeys = {'viktor-vektor', 'misty-olszewski', 'judy-alvarez',
    'panam-palmer', 'resident-male', 'resident-female'}
local companions, profiles, byKey, byRecord = nil, {}, {}, {}
local settings, settingsLoaded, settingsNeedSave = nil, false, false
local playerIdentity, initialized = nil, false
local tab, query, page, selected = 'characters', '', 1, nil
local assigning, returnQuery, returnPage = nil, '', 1
local models, modelRows, modelSeen, modelIndex = {}, nil, {}, 1
local scanStarted, scanFinished, scanError = false, false, nil
local dirty, feedback, partyClock = true, '', 0
local party, partySignature, previousStates = {}, '', {}
local visible, selectedItem = {}, nil
local localVoiceState, localVoiceSignature = {}, ''
local localVoices = {['johnny-silverhand'] = true, ['judy-alvarez'] = true, ['panam-palmer'] = true}
local render

local function readJSON(path)
    local file = io.open(path, 'rb')
    if not file then return nil end
    local raw = file:read('*a'); file:close()
    local ok, value = pcall(json.decode, raw)
    return ok and type(value) == 'table' and value or nil
end

local function clean(value, limit)
    return tostring(value or ''):gsub('[%z\1-\8\11\12\14-\31]', ''):sub(1, limit or 800)
end

local function say(message)
    feedback, dirty = clean(message, 400), true
end

local function sortNames(a, b)
    local left, right = a.name:lower(), b.name:lower()
    return left == right and a.key < b.key or left < right
end

local function loadSettings()
    if settingsLoaded then return end
    settingsLoaded = true
    settings = readJSON('runtime/settings.json') or readJSON('runtime/settings.json.previous') or {}
    settingsNeedSave = settings.version ~= 2 or type(settings.enabledByKey) ~= 'table'
    settings.version = 2
    if type(settings.voice) ~= 'boolean' then settings.voice = true end
    if type(settings.subtitles) ~= 'boolean' then settings.subtitles = true end
    if settings.omniSteps ~= 16 and settings.omniSteps ~= 32 then
        settings.omniSteps, settingsNeedSave = 32, true
    end
    if type(settings.enabledByKey) ~= 'table' then settings.enabledByKey = {} end
    for index, key in ipairs(legacyKeys) do
        if type(settings.enabledByKey[key]) ~= 'boolean' and type(settings.enabled) == 'table'
            and type(settings.enabled[index]) == 'boolean' then
            settings.enabledByKey[key] = settings.enabled[index]
        end
    end
    for key in pairs(byKey) do
        if type(settings.enabledByKey[key]) ~= 'boolean' then
            settings.enabledByKey[key], settingsNeedSave = true, true
        end
    end
end

local function saveSettings()
    -- Preserve unknown settings and the old six-key projection for reloads.
    settings.enabled = {}
    for index, key in ipairs(legacyKeys) do settings.enabled[index] = settings.enabledByKey[key] ~= false end
    local encoded, payload = pcall(json.encode, settings)
    if not encoded then return false end
    local file = io.open('runtime/settings.json.tmp', 'wb')
    if not file then return false end
    local written = file:write(payload)
    local closed = file:close()
    if not written or not closed then return false end
    local target, backup = 'runtime/settings.json', 'runtime/settings.json.previous'
    local existing = io.open(target, 'rb')
    if existing then
        existing:close()
        os.remove(backup)
        if not os.rename(target, backup) then return false end
    end
    if not os.rename('runtime/settings.json.tmp', target) then
        if existing then os.rename(backup, target) end
        return false
    end
    if existing then os.remove(backup) end
    return true
end

function M.profileEnabled(key)
    loadSettings()
    return key ~= nil and byKey[key] ~= nil and settings.enabledByKey[key] ~= false
end

local function savedFeedback(message)
    if saveSettings() then say(message)
    else say(message .. ' The change is active, but could not be saved for next time.') end
end

local function definitionFor(profile)
    local known = companions.definition(profile.key)
    if known then return known end
    local record = type(profile.records) == 'table' and profile.records[1] or nil
    return record and {id = record, name = profile.name} or nil
end

function M.configure(companionApi, profileList)
    companions, profiles, byKey, byRecord = companionApi, {}, {}, {}
    for _, value in ipairs(profileList or {}) do
        if type(value.key) == 'string' and type(value.name) == 'string' and not byKey[value.key] then
            profiles[#profiles + 1], byKey[value.key] = value, value
            for _, id in ipairs(value.records or {}) do byRecord[id] = value end
            local definition = definitionFor(value)
            if definition then
                definition.profileKey, definition.profileName = value.key, value.name
                companions.registerDefinition(value.key, definition)
            end
        end
    end
    for _, value in ipairs(readJSON('manager-characters.json') or {}) do
        if type(value.key) == 'string' then
            local profile = byKey[value.profileKey or value.key]
            local id = value.record or value.id
            if type(id) == 'string' then
                companions.registerDefinition(value.key, {id = id, name = value.name or (profile and profile.name) or value.key,
                    profileKey = profile and profile.key or nil, profileName = profile and profile.name or nil})
                if profile then byRecord[id] = profile end
            end
        end
    end
    table.sort(profiles, sortNames)
    M.reset()
end

function M.reset()
    playerIdentity, initialized, settingsLoaded, settings, settingsNeedSave = nil, false, false, nil, false
    tab, query, page, selected = 'characters', '', 1, nil
    assigning, returnQuery, returnPage = nil, '', 1
    models, modelRows, modelSeen, modelIndex = {}, nil, {}, 1
    scanStarted, scanFinished, scanError = false, false, nil
    dirty, feedback, partyClock = true, '', 0
    party, partySignature, previousStates, visible, selectedItem = {}, '', {}, {}, nil
    localVoiceState, localVoiceSignature = {}, ''
end

local function updateLocalVoice()
    local state = readJSON('runtime/local-voice-state.json') or {}
    local fresh = type(state.updated) == 'number' and math.abs(os.time() - state.updated / 1000) < 15
    if not fresh then state.state = 'waiting' end
    local signature = tostring(state.provider) .. ':' .. tostring(state.state) .. ':' .. tostring(state.steps)
    localVoiceState = state
    if signature ~= localVoiceSignature then localVoiceSignature, dirty = signature, true end
end

local function identity(player)
    local ok, value = pcall(function() return tostring(player:GetEntityID().hash) end)
    return ok and value or tostring(player)
end

local function initialize(player)
    if not player or not companions then return false end
    local current = identity(player)
    if playerIdentity and playerIdentity ~= current then M.reset() end
    playerIdentity = current
    loadSettings()
    if not initialized then
        player:ConvaiManagerSetVoice(settings.voice)
        player:ConvaiManagerSetSubtitles(settings.subtitles)
        -- Keep the legacy native flags consistent while callers move to keys.
        for index, key in ipairs(legacyKeys) do
            pcall(function() player:ConvaiManagerSetEnabled(index - 1, settings.enabledByKey[key] ~= false) end)
        end
        initialized, dirty = true, true
        if settingsNeedSave then
            settingsNeedSave = false
            if not saveSettings() then say('Settings are active, but could not be saved for next time.') end
        end
    end
    return true
end

local function updateParty()
    local ok, result = pcall(companions.list)
    if not ok then say('The party list could not be read. Close and reopen the manager.'); return end
    party = result or {}
    local signature, states = {}, {}
    for _, member in ipairs(party) do
        signature[#signature + 1] = table.concat({member.serial, member.key or '', member.profileKey or '',
            member.state or '', member.error or ''}, '|')
        states[member.serial] = member.state
        local before = previousStates[member.serial]
        if before and before ~= member.state then
            if member.state == 'ready' then say(member.name .. ' joined your party.') end
            if member.state == 'failed' then say(member.name .. ': ' .. (member.error or 'This copy could not join.')) end
            if member.state == 'missing' then say(member.name .. ' is no longer attached to the world. Dismiss this copy to free its place.') end
        end
    end
    previousStates = states
    local nextSignature = table.concat(signature, '\n')
    if nextSignature ~= partySignature then partySignature, dirty = nextSignature, true end
end

local function beginModels()
    if scanStarted then return end
    scanStarted = true
    local ok, records = pcall(function() return TweakDB:GetRecords('gamedataCharacter_Record') end)
    if not ok or type(records) ~= 'table' then
        scanError, scanFinished = 'The installed character models could not be read.', true
        say(scanError)
        return
    end
    modelRows = records
end

local function modelRecord(record, index)
    local recordID = record:GetID()
    local debugId = tostring(recordID)
    local id = debugId:match('%-%-%[%[ (.-) %-%-%]%]')
    if not id and debugId:match('^[%w_]+%.[%w_%.%-]+$') then id = debugId end
    local unique = id or debugId
    if modelSeen[unique] then return end
    modelSeen[unique] = true
    local profile = id and byRecord[id] or nil
    local label
    if id then
        local ok, localized = pcall(function()
            local raw = tostring(TweakDB:GetFlat(id .. '.displayName') or '')
            local number = raw:match('LocKey%((%d+)')
            return GetLocalizedText(number and ('LocKey#' .. number) or raw)
        end)
        if ok and type(localized) == 'string' and localized ~= '' and not localized:find('LocKey', 1, true) then label = localized end
    end
    label = clean(label or (profile and profile.name) or id or ('Unnamed model ' .. index), 160)
    local key = 'model:' .. tostring(index)
    local definition = {id = id, recordID = recordID, name = label,
        profileKey = profile and profile.key or nil, profileName = profile and profile.name or nil}
    local registered = companions.registerDefinition(key, definition)
    if registered then
        models[#models + 1] = {key = key, name = label, record = id or debugId,
            profileKey = definition.profileKey, profileName = definition.profileName,
            search = (label .. ' ' .. (id or debugId) .. ' ' .. (definition.profileName or '')):lower()}
    end
end

local function scanModels()
    if scanFinished or not modelRows then return end
    local last = math.min(#modelRows, modelIndex + SCAN_BATCH - 1)
    for index = modelIndex, last do
        local ok = pcall(modelRecord, modelRows[index], index)
        if not ok then scanError = 'Some model records could not be read.' end
    end
    modelIndex, dirty = last + 1, true
    if modelIndex > #modelRows then
        scanFinished, modelRows = true, nil
        table.sort(models, sortNames)
        if scanError then say(scanError) end
    end
end

local function matches(text)
    return query == '' or tostring(text):lower():find(query:lower(), 1, true) ~= nil
end

local function profileMatches(profile)
    return matches(profile.name .. ' ' .. profile.key .. ' ' .. table.concat(profile.aliases or {}, ' ')
        .. ' ' .. table.concat(profile.records or {}, ' '))
end

local function findParty(serial)
    for _, member in ipairs(party) do if member.serial == serial then return member end end
end

local function copyCount(key)
    local count = 0
    for _, member in ipairs(party) do if member.key == key then count = count + 1 end end
    return count
end

local function rowsForTab()
    local result = {}
    if assigning then
        if matches('No conversation profile') then
            result[#result + 1] = {key = 'profile:none', name = 'No conversation profile',
                note = 'Keep this copy without a conversation identity', kind = 'assignment-none'}
        end
        for _, profile in ipairs(profiles) do
            if profileMatches(profile) then
                result[#result + 1] = {key = 'profile:' .. profile.key, name = profile.name,
                    note = 'Use this conversation profile', profile = profile, kind = 'assignment'}
            end
        end
    elseif tab == 'characters' then
        for _, profile in ipairs(profiles) do
            if profileMatches(profile) then
                local definition = companions.definition(profile.key)
                result[#result + 1] = {key = 'profile:' .. profile.key, name = profile.name,
                    note = (M.profileEnabled(profile.key) and 'Chat on' or 'Chat off')
                        .. (definition and ('  |  Copies: ' .. copyCount(profile.key)) or '  |  Profile only'),
                    profile = profile, definition = definition, kind = 'character'}
            end
        end
    elseif tab == 'models' then
        for _, model in ipairs(models) do
            if matches(model.search) then
                result[#result + 1] = {key = model.key, name = model.name, note = model.record,
                    model = model, kind = 'model'}
            end
        end
    elseif tab == 'party' then
        for _, member in ipairs(party) do
            if matches(member.name .. ' ' .. (member.profileName or '') .. ' ' .. (member.record or '')) then
                result[#result + 1] = {key = 'party:' .. member.serial, name = member.name,
                    note = member.state == 'ready' and (member.profileKey and ('Chat: ' .. member.profileName) or 'Conversation profile not assigned')
                        or (member.state == 'spawning' and 'Joining...' or (member.error or member.state)),
                    member = member, kind = 'party'}
            end
        end
    elseif tab == 'settings' then
        for _, value in ipairs({{key = 'voice', name = 'Voice playback', value = settings.voice},
            {key = 'subtitles', name = 'Subtitles', value = settings.subtitles}}) do
            if matches(value.name) then
                result[#result + 1] = {key = 'setting:' .. value.key, name = value.name,
                    note = value.value and 'On' or 'Off', setting = value.key, kind = 'setting'}
            end
        end
        if matches('Local voice quality OmniVoice') then
            result[#result + 1] = {key = 'setting:omniSteps', name = 'Local voice quality',
                note = 'OmniVoice ' .. settings.omniSteps .. ' steps', kind = 'voice-quality'}
        end
    end
    return result
end

local function detail(player, item)
    local title, body, primary, primaryLabel, secondary, secondaryLabel = '', '', '', '', '', ''
    local primaryEnabled, secondaryEnabled = false, false
    if assigning then
        local member = findParty(assigning)
        title = 'Conversation for ' .. (member and member.name or 'this copy')
        body = 'Choose the personality this copy should use in conversations. Its model stays the same.'
        if item and item.kind == 'assignment-none' then
            body = body .. '\n\nThis copy can still follow you, but will not join conversations.'
            primary, primaryLabel, primaryEnabled = 'assign-none:' .. assigning, 'Clear profile', member ~= nil
        elseif item then
            body = body .. '\n\n' .. item.profile.name .. '\n' .. clean(item.profile.summary or '')
            primary, primaryLabel, primaryEnabled = 'assign-profile:' .. assigning .. ':' .. item.profile.key, 'Use profile', member ~= nil
        end
        secondary, secondaryLabel, secondaryEnabled = 'assign-cancel', 'Back to party', true
    elseif not item then
        title = ({characters = 'Characters', models = 'Models', party = 'Your party', settings = 'Settings'})[tab]
        if tab == 'models' and not scanFinished then body = 'Discovering installed character models. Results appear as they are read.'
        elseif tab == 'models' and scanError then body = scanError
        elseif tab == 'party' and query == '' then body = 'Your party is empty. Add a character or model to create a companion copy.'
        else body = query ~= '' and 'No matches. Try another name or clear the search.' or 'No entries are available.' end
    elseif item.kind == 'character' then
        local profile = item.profile
        title = profile.name
        body = clean(profile.summary or 'Conversation profile for ' .. profile.name, 1100)
            .. '\n\nConversation: ' .. (M.profileEnabled(profile.key) and 'on' or 'off')
            .. '\nCopies in party: ' .. copyCount(profile.key)
        if localVoices[profile.key] and localVoiceState.provider == 'hybrid' then
            body = body .. '\nVoice: OmniVoice ' .. settings.omniSteps .. ' steps'
        elseif profile.voiceName then body = body .. '\nVoice: ' .. clean(profile.voiceName, 140) end
        if not item.definition then body = body .. '\nChoose a model in Models, then assign this profile in Party.' end
        primary, primaryLabel, primaryEnabled = 'spawn:' .. profile.key, 'Add a copy', item.definition ~= nil and #party < 8
        secondary, secondaryLabel, secondaryEnabled = 'toggle-profile:' .. profile.key,
            M.profileEnabled(profile.key) and 'Turn chat off' or 'Turn chat on', true
    elseif item.kind == 'model' then
        local model = item.model
        title, body = model.name, model.record
        body = body .. '\n\n' .. (model.profileKey and ('Conversation: ' .. model.profileName) or 'Conversation profile not assigned.')
            .. '\nAdd a copy, then use Party to choose its conversation profile.'
        primary, primaryLabel, primaryEnabled = 'spawn:' .. model.key, 'Add a copy', #party < 8
    elseif item.kind == 'party' then
        local member = item.member
        title = member.name
        body = 'State: ' .. (member.state == 'ready' and 'Following' or member.state)
            .. '\n' .. (member.profileKey and ('Conversation: ' .. member.profileName
                .. (M.profileEnabled(member.profileKey) and ' (on)' or ' (off)')) or 'Conversation profile not assigned.')
        if member.error then body = body .. '\n\n' .. clean(member.error, 300) end
        primary, primaryLabel, primaryEnabled = 'dismiss:' .. member.serial, 'Dismiss copy', true
        secondary, secondaryLabel, secondaryEnabled = 'assign:' .. member.serial, 'Choose profile', member.state == 'ready' or member.state == 'spawning'
    elseif item.kind == 'setting' then
        title = item.name
        body = item.setting == 'voice' and 'Play spoken replies through the supported voice output. This does not change microphone capture.'
            or 'Show companion reply subtitles during conversations.'
        body = body .. '\n\nCurrently ' .. (settings[item.setting] and 'on.' or 'off.')
        primary, primaryLabel, primaryEnabled = 'toggle:' .. item.setting, settings[item.setting] and 'Turn off' or 'Turn on', true
    elseif item.kind == 'voice-quality' then
        title = 'Local voice quality'
        body = 'Johnny, Judy and Panam use OmniVoice. Other characters keep their Convai voices.'
            .. '\n\n32 steps: fuller quality (default).\n16 steps: faster replies.'
            .. '\n\nThe shared model stays loaded while the voice service runs. Changes apply to the next reply.'
        local labels = {ready = 'Ready', speaking = 'Preparing a reply', loading = 'Loading', warming = 'Preparing voices',
            error = 'Unavailable - restart the voice service', disabled = 'Not configured', stopping = 'Stopping',
            stopped = 'Stopped', waiting = 'Waiting for the voice service'}
        body = body .. '\n\nLocal voices: ' .. (labels[localVoiceState.state] or labels.waiting)
        primary, primaryLabel, primaryEnabled = 'omni:32', 'Use 32 steps', settings.omniSteps ~= 32
        secondary, secondaryLabel, secondaryEnabled = 'omni:16', 'Use 16 steps', settings.omniSteps ~= 16
    end
    if #party >= 8 and (tab == 'characters' or tab == 'models') then body = body .. '\n\nParty full: dismiss a copy before adding another.' end
    player:ConvaiManagerSetDetail(clean(title, 160), clean(body, 1800), primary, primaryLabel,
        primaryEnabled, secondary, secondaryLabel, secondaryEnabled)
end

render = function(player)
    local rows = rowsForTab()
    local pages = math.max(1, math.ceil(#rows / PAGE_SIZE))
    page = math.max(1, math.min(page, pages))
    local first, last = (page - 1) * PAGE_SIZE + 1, math.min(page * PAGE_SIZE, #rows)
    visible, selectedItem = {}, nil
    for index = first, last do
        local item = rows[index]
        visible[item.key] = item
        if item.key == selected then selectedItem = item end
    end
    if not selectedItem then
        selectedItem = rows[first]
        selected = selectedItem and selectedItem.key or nil
    end
    player:ConvaiManagerClearRows()
    for index = first, last do
        local item = rows[index]
        player:ConvaiManagerAddRow(item.key, clean(item.name, 160), clean(item.note, 180), item.key == selected)
    end
    detail(player, selectedItem)
    local pageText = #rows == 0 and '0 results' or ('Page ' .. page .. ' of ' .. pages .. '  |  ' .. #rows .. ' results')
    if tab == 'models' and not scanFinished then
        pageText = pageText .. '  |  Reading models ' .. math.max(0, modelIndex - 1) .. '/' .. #(modelRows or {})
    end
    player:ConvaiManagerSetPage(pageText, page > 1, page < pages)
    player:ConvaiManagerSetTab(tab)
    pcall(function() player:ConvaiManagerSetSearch(query) end)
    player:ConvaiManagerSetFeedback(feedback)
    pcall(function() player:ConvaiManagerSetPartyStatus('Party: ' .. #party .. ' / 8') end)
    player:ConvaiManagerRefresh()
    dirty = false
end

local function finishAssignment()
    assigning, query, page, selected = nil, returnQuery, returnPage, nil
    dirty = true
end

local function action(player, request)
    if request:sub(1, 4) == 'tab:' then
        local nextTab = request:sub(5)
        if nextTab ~= 'characters' and nextTab ~= 'models' and nextTab ~= 'party' and nextTab ~= 'settings' then return end
        tab, query, page, selected, assigning = nextTab, '', 1, nil, nil
        if tab == 'models' then beginModels() end
        dirty = true
    elseif request:sub(1, 7) == 'search:' then
        query, page, selected, dirty = clean(request:sub(8), 100), 1, nil, true
    elseif request:sub(1, 7) == 'select:' then
        local key = request:sub(8)
        if visible[key] then selected, dirty = key, true end
    elseif request == 'page:next' or request == 'page:previous' then
        page, selected, dirty = math.max(1, page + (request == 'page:next' and 1 or -1)), nil, true
    elseif request:sub(1, 6) == 'spawn:' then
        local key = request:sub(7)
        if not companions.definition(key) then say('That model is no longer available.'); return end
        local serial, reason = companions.spawn(key)
        if serial then
            local definition = companions.definition(key)
            say('Creating a copy of ' .. definition.name .. '. Check Party for its status.')
        else say(reason or 'This copy could not be created.') end
        updateParty()
    elseif request:sub(1, 8) == 'dismiss:' then
        local serial = tonumber(request:sub(9))
        local member = serial and findParty(serial)
        if not member then say('That copy is no longer in your party.'); return end
        local done, reason = companions.dismiss(serial)
        say(done and (member.name .. ' dismissed.') or (reason or 'The copy could not be dismissed.'))
        updateParty()
    elseif request:sub(1, 15) == 'toggle-profile:' then
        local key = request:sub(16)
        if not byKey[key] then say('That conversation profile is unavailable.'); return end
        settings.enabledByKey[key] = not M.profileEnabled(key)
        for index, oldKey in ipairs(legacyKeys) do
            if oldKey == key then pcall(function() player:ConvaiManagerSetEnabled(index - 1, settings.enabledByKey[key]) end) end
        end
        if companions.onPartyChanged then pcall(companions.onPartyChanged) end
        savedFeedback(byKey[key].name .. ': chat ' .. (M.profileEnabled(key) and 'on.' or 'off.'))
    elseif request == 'toggle:voice' or request == 'toggle:subtitles' then
        local key = request:sub(8)
        local nextValue = not settings[key]
        if key == 'voice' then player:ConvaiManagerSetVoice(nextValue)
        else player:ConvaiManagerSetSubtitles(nextValue) end
        settings[key] = nextValue
        savedFeedback((key == 'voice' and 'Voice playback' or 'Subtitles') .. (nextValue and ' on.' or ' off.'))
    elseif request == 'omni:16' or request == 'omni:32' then
        settings.omniSteps = tonumber(request:sub(6))
        savedFeedback('OmniVoice ' .. settings.omniSteps .. ' steps selected for the next reply.')
    elseif request:sub(1, 7) == 'assign:' then
        local serial = tonumber(request:sub(8))
        if not findParty(serial) then say('That copy is no longer in your party.'); return end
        assigning, returnQuery, returnPage = serial, query, page
        tab, query, page, selected, dirty = 'party', '', 1, nil, true
    elseif request:sub(1, 15) == 'assign-profile:' then
        local serial, key = request:match('^assign%-profile:(%d+):(.+)$')
        serial = tonumber(serial)
        if not serial or serial ~= assigning or not byKey[key] then say('Choose a conversation profile from the list.'); return end
        local done, reason = companions.setProfile(serial, key, byKey[key].name)
        if done then say('Conversation profile set to ' .. byKey[key].name .. '.'); finishAssignment()
        else say(reason or 'The profile could not be assigned.') end
        updateParty()
    elseif request:sub(1, 12) == 'assign-none:' then
        local serial = tonumber(request:sub(13))
        if not serial or serial ~= assigning then say('Choose a copy from your party first.'); return end
        local done, reason = companions.setProfile(serial, nil)
        if done then say('Conversation profile cleared.'); finishAssignment()
        else say(reason or 'The profile could not be cleared.') end
        updateParty()
    elseif request == 'assign-cancel' then
        finishAssignment()
    else
        say('This manager action is unavailable. Reopen the manager and try again.')
    end
end

function M.prepare(player)
    local ok, problem = pcall(function()
        if not initialize(player) then return end
        updateParty()
        updateLocalVoice()
        render(player)
    end)
    if not ok then say('The manager could not be prepared: ' .. clean(problem, 160)) end
    return ok
end

-- MCM reads the same catalogue and saved settings as the conversation runtime.
-- This interface does not create the retired HUD popup or touch world actors.
function M.snapshot(player)
    if player then initialize(player) else loadSettings() end
    updateParty()
    updateLocalVoice()
    local enabled = {}
    for key, value in pairs(settings.enabledByKey) do enabled[key] = value end
    return {
        profiles = profiles, models = models, party = party, feedback = feedback,
        settings = {voice = settings.voice, subtitles = settings.subtitles,
            omniSteps = settings.omniSteps, enabledByKey = enabled},
        localVoice = localVoiceState,
        scan = {started = scanStarted, finished = scanFinished, error = scanError,
            count = #models, read = math.max(0, modelIndex - 1), total = #(modelRows or models)},
    }
end

function M.scanModels()
    beginModels()
    scanModels()
    return scanFinished
end

function M.definition(key)
    return companions and companions.definition(key)
end

function M.applySettings(player, values)
    loadSettings()
    -- Validate and save the complete transaction before exposing any changed
    -- values to native playback. A failed save leaves the MCM draft intact.
    if type(values) ~= 'table' then return false, 'No settings were supplied.' end
    local nextSettings = {}
    for key, value in pairs(settings) do nextSettings[key] = value end
    nextSettings.enabledByKey = {}
    for key, value in pairs(settings.enabledByKey) do nextSettings.enabledByKey[key] = value end
    for key, value in pairs(values) do
        if key == 'voice' or key == 'subtitles' then
            if type(value) ~= 'boolean' then return false, 'Playback settings must be on or off.' end
            nextSettings[key] = value
        elseif key == 'omniSteps' then
            if value ~= 16 and value ~= 32 then return false, 'Choose 16 or 32 voice steps.' end
            nextSettings.omniSteps = value
        elseif key == 'enabledByKey' then
            if type(value) ~= 'table' then return false, 'Invalid conversation settings.' end
            for profile, enabled in pairs(value) do
                if not byKey[profile] or type(enabled) ~= 'boolean' then
                    return false, 'That conversation profile is unavailable.'
                end
                nextSettings.enabledByKey[profile] = enabled
            end
        else return false, 'Unknown setting: ' .. tostring(key) end
    end
    local previous = settings
    settings = nextSettings
    if not saveSettings() then
        settings = previous
        return false, 'The settings could not be saved. Your changes are still pending.'
    end
    if player then
        pcall(function() player:ConvaiManagerSetVoice(settings.voice) end)
        pcall(function() player:ConvaiManagerSetSubtitles(settings.subtitles) end)
        for index, key in ipairs(legacyKeys) do
            pcall(function() player:ConvaiManagerSetEnabled(index - 1, settings.enabledByKey[key] ~= false) end)
        end
    end
    if companions.onPartyChanged then pcall(companions.onPartyChanged) end
    say('Settings saved.')
    return true
end

function M.update(player, delta)
    if not player then if initialized then M.reset() end; return end
    local ready = initialize(player)
    if not ready then return end
    local openOk, open = pcall(function() return player:ConvaiManagerIsOpen() end)
    if not openOk then return end
    -- Drain a bounded queue even after closing so a just-clicked command is not
    -- silently discarded. Settings changes outside this view are also retained.
    for _ = 1, 16 do
        local ok, request = pcall(function() return player:ConvaiManagerTakeRequest() end)
        if not ok or type(request) ~= 'string' or request == '' then break end
        local applied, problem = pcall(action, player, request)
        if not applied then say('The action could not finish: ' .. clean(problem, 200)) end
    end
    local voiceOk, voice = pcall(function() return player:ConvaiManagerVoice() end)
    local subtitleOk, subtitle = pcall(function() return player:ConvaiManagerSubtitles() end)
    if (voiceOk and type(voice) == 'boolean' and voice ~= settings.voice)
        or (subtitleOk and type(subtitle) == 'boolean' and subtitle ~= settings.subtitles) then
        if voiceOk and type(voice) == 'boolean' then settings.voice = voice end
        if subtitleOk and type(subtitle) == 'boolean' then settings.subtitles = subtitle end
        savedFeedback('Playback settings updated.')
    end
    partyClock = partyClock + math.max(0, tonumber(delta) or 0)
    if partyClock >= 0.5 then partyClock = 0; updateParty(); updateLocalVoice() end
    if open then
        if tab == 'models' then beginModels(); scanModels() end
        if dirty then
            local ok, problem = pcall(render, player)
            if not ok then say('The manager could not refresh: ' .. clean(problem, 160)) end
        end
    end
end

return M
