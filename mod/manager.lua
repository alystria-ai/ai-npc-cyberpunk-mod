-- Native manager data and actions. Widgets live in redscript; only eight rows
-- cross that boundary at once. Every spawn goes through owned companions.
local M = {}
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
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
local localVoices = {}
local eyeContactHeights = {-0.10, -0.05, 0, 0.05, 0.10}
local headFollowStrengths = {0, 0.5, 1, 1.5}
local relationshipProfiles = {
    {key = 'judy-alvarez', name = 'Judy Alvarez'},
    {key = 'panam-palmer', name = 'Panam Palmer'},
    {key = 'river-ward', name = 'River Ward'},
    {key = 'kerry-eurodyne', name = 'Kerry Eurodyne'},
    {key = 'meredith-stout', name = 'Meredith Stout'},
}
local relationshipKeys = {}
for _, profile in ipairs(relationshipProfiles) do relationshipKeys[profile.key] = true end
local memoryLoaded, memorySession, memorySequence, memoryConfirmSequence = false, nil, 0, 0
local memorySelected, memoryConfirmation, memoryCommand, memoryNotice = nil, nil, nil, ''
local memoryState, memoryRecoveryBlocked = {state = 'unavailable'}, false
local render

local function readJSON(path)
    local file = io.open(path, 'rb')
    if not file then return nil end
    local raw = file:read('*a'); file:close()
    local ok, value = pcall(json.decode, raw)
    return ok and type(value) == 'table' and value or nil
end

local function clean(value, limit)
    local text = tostring(value or ''):gsub('[%z\1-\8\11\12\14-\31]', '')
    local last = math.min(#text, limit or 800)
    -- Native feedback bounds are byte limits. Stop before a UTF-8 sequence
    -- rather than handing ink a partial Cyrillic/CJK character.
    while last > 0 do
        local nextByte = text:byte(last+1)
        if not nextByte or nextByte < 128 or nextByte >= 192 then break end
        last = last-1
    end
    return text:sub(1,last)
end

local function say(message)
    feedback, dirty = clean(ui.t(message), 400), true
end

local function wholeNumber(value)
    return type(value) == 'number' and value == value and value >= 0 and value < math.huge and value == math.floor(value)
end

local function validMemoryCommand(value)
    return type(value) == 'table' and value.version == 1 and value.action == 'clear'
        and type(value.id) == 'string' and #value.id > 0 and #value.id <= 160
        and wholeNumber(value.issuedAt)
        and ((value.scope == 'character' and type(value.profileKey) == 'string' and #value.profileKey > 0)
            or (value.scope == 'all' and value.profileKey == nil))
end

local function memoryTarget(value)
    if value.scope == 'all' then return ui.t('all characters you have talked to') end
    local profile = byKey[value.profileKey]
    return profile and profile.name or ui.t('the selected character')
end

local function updateMemory()
    -- This request is durable. Save changes reset world/menu work, but do not
    -- erase or retry a cloud clear whose outcome is still unknown.
    if not memoryLoaded then
        memoryLoaded = true
        local target = 'runtime/memory-command.json'
        local file = io.open(target, 'rb')
        if not file then target = target .. '.previous'; file = io.open(target, 'rb') end
        if file then
            local raw = file:read('*a'); file:close()
            local ok, previous = pcall(json.decode, raw)
            if ok and validMemoryCommand(previous) then
                memorySequence = tonumber(previous.id:match(':(%d+)$')) or 0
                memoryCommand = {id = previous.id, scope = previous.scope, profileKey = previous.profileKey,
                    issuedAt = previous.issuedAt, state = 'pending'}
            else memoryRecoveryBlocked = true end
        end
    end
    local state = readJSON('runtime/memory-status.json')
    local valid = state and state.version == 1 and wholeNumber(state.updated) and wholeNumber(state.talkedToCount)
        and (state.state == 'ready' or state.state == 'unavailable')
    local now = os.time() * 1000.0
    local fresh = valid and state.updated >= now - 15000 and state.updated <= now + 5000
    memoryState.state = fresh and state.state == 'ready' and not memoryRecoveryBlocked and 'ready' or 'unavailable'
    if valid then
        memoryState.talkedToCount = state.talkedToCount
        memoryState.characters = type(state.characters) == 'table' and {} or nil
        if memoryState.characters then
            for _, character in ipairs(state.characters) do
                if type(character) == 'table' and type(character.profileKey) == 'string' then
                    memoryState.characters[character.profileKey] = true
                end
            end
        end
        local result = state.command
        if memoryCommand and memoryCommand.state == 'pending' and type(result) == 'table' and result.id == memoryCommand.id
            and result.scope == memoryCommand.scope and result.profileKey == memoryCommand.profileKey
            and state.updated >= memoryCommand.issuedAt
            and (result.state == 'succeeded' or result.state == 'failed') then
            -- Provider messages can contain IDs or raw errors. The page uses
            -- its own player-facing text and never displays those messages.
            memoryCommand.state = result.state
        end
    end
end

local function memoryCanClear(scope, key)
    if memoryCommand and memoryCommand.state == 'pending' then
        return false, 'A memory clear is awaiting its result. It will not be sent again.'
    end
    if memoryState.state ~= 'ready' then return false, 'The memory service is unavailable. Reopen this page after it reconnects.' end
    if scope == 'all' then
        if not wholeNumber(memoryState.talkedToCount) then return false, 'The memory service is unavailable. Reopen this page after it reconnects.' end
    elseif scope == 'character' then
        if not byKey[key] then return false, 'Choose a character from the catalogue first.' end
    else return false, 'Choose a memory clear action from Settings.' end
    return true
end

local function memorySnapshot()
    local selectedProfile = byKey[memorySelected]
    local canCharacter = memoryCanClear('character', memorySelected)
    local canAll = memoryCanClear('all')
    local result = {state = memoryState.state, talkedToCount = memoryState.talkedToCount,
        selectedKey = memorySelected, selectedName = selectedProfile and selectedProfile.name or nil,
        canClearCharacter = canCharacter, canClearAll = canAll, characters = memoryState.characters,
        feedback = ui.t(memoryNotice)}
    if memoryRecoveryBlocked then
        result.feedback = ui.t('A previous memory request could not be read. The memory service must reconcile it before another clear.')
    end
    if memoryCommand then
        local target = memoryTarget(memoryCommand)
        result.command = {id = memoryCommand.id, scope = memoryCommand.scope, profileKey = memoryCommand.profileKey,
            state = memoryCommand.state}
        if memoryCommand.state == 'pending' then
            result.feedback = memoryState.state == 'ready' and ui.t('Clearing memories for {target}…',{target=target})
                or ui.t('Waiting for the result of clearing memories for {target}. Reopen this page after the memory service reconnects.',{target=target})
        elseif memoryNotice == '' then
            if memoryCommand.state == 'succeeded' then result.feedback = ui.t('Memory clear confirmed for {target}.',{target=target})
            else result.feedback = ui.t('The memory service could not confirm the clear for {target}. Review the service before choosing Forget again.',{target=target}) end
        end
    end
    if memoryConfirmation then
        result.confirmation = {token = memoryConfirmation.token, scope = memoryConfirmation.scope,
            profileKey = memoryConfirmation.profileKey, count = memoryConfirmation.count,
            target = memoryTarget(memoryConfirmation)}
    end
    return result
end

function M.selectMemoryCharacter(key)
    if not byKey[key] then return false, 'Choose a character from the catalogue.' end
    memorySelected, memoryConfirmation, memoryNotice = key, nil, ''
    return true, ui.t('{name} selected for memory controls.', {name=byKey[key].name})
end

function M.beginMemoryClear(scope)
    updateMemory()
    local ok, reason = memoryCanClear(scope, memorySelected)
    if not ok then return false, reason end
    if memoryConfirmation then return false, 'Use Confirm or Cancel for the current memory request.' end
    memoryConfirmSequence = memoryConfirmSequence + 1
    memoryConfirmation = {token = tostring(memoryConfirmSequence), scope = scope,
        profileKey = scope == 'character' and memorySelected or nil, count = memoryState.talkedToCount}
    return true, 'Review the memory clear below, then choose Confirm or Cancel.'
end

function M.cancelMemoryClear(token)
    if not memoryConfirmation or memoryConfirmation.token ~= token then return false, 'That confirmation is no longer active.' end
    memoryConfirmation, memoryNotice = nil, 'Memory clear cancelled.'
    return true, memoryNotice
end

function M.cancelMemoryConfirmation()
    memoryConfirmation = nil
end

local function memorySessionUUID()
    local uuid = ('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'):gsub('[xy]', function(kind)
        local value = math.random(0, 15)
        return string.format('%x', kind == 'y' and (value % 4 + 8) or value)
    end)
    -- Also keep command IDs distinct if a fresh Lua VM repeats its RNG seed.
    if memoryCommand and memoryCommand.id:sub(1, #uuid) == uuid then
        local suffix = tonumber(uuid:sub(-1), 16) or 0
        uuid = uuid:sub(1, -2) .. string.format('%x', (suffix + 1) % 16)
    end
    return uuid
end

local function writeMemoryCommand(value)
    local encoded, payload = pcall(json.encode, value)
    if not encoded then return false end
    local target, temporary, backup = 'runtime/memory-command.json', 'runtime/memory-command.json.tmp',
        'runtime/memory-command.json.previous'
    local file = io.open(temporary, 'wb')
    if not file then return false end
    local written = file:write(payload)
    local closed = file:close()
    if not written or not closed then os.remove(temporary); return false end
    local existing = io.open(target, 'rb')
    if existing then
        existing:close(); os.remove(backup)
        if not os.rename(target, backup) then os.remove(temporary); return false end
    end
    if not os.rename(temporary, target) then
        if existing then os.rename(backup, target) end
        os.remove(temporary)
        return false
    end
    os.remove(backup)
    return true
end

function M.confirmMemoryClear(token)
    updateMemory()
    local confirmation = memoryConfirmation
    if not confirmation or confirmation.token ~= token then return false, 'That confirmation is no longer active.' end
    local ok, reason = memoryCanClear(confirmation.scope, confirmation.profileKey)
    if not ok then return false, reason end
    if confirmation.scope == 'all' and confirmation.count ~= memoryState.talkedToCount then
        memoryConfirmation = nil
        return false, 'The character count changed. Review Forget all memories again.'
    end
    memorySession = memorySession or memorySessionUUID()
    memorySequence = memorySequence + 1
    local command = {version = 1, id = memorySession .. ':' .. memorySequence, action = 'clear',
        scope = confirmation.scope, profileKey = confirmation.profileKey, issuedAt = os.time() * 1000.0}
    memoryConfirmation = nil
    if not writeMemoryCommand(command) then
        memoryNotice = 'The memory clear request could not be sent. Check the memory service before trying again.'
        return false, memoryNotice
    end
    memoryCommand = {id = command.id, scope = command.scope, profileKey = command.profileKey,
        issuedAt = command.issuedAt, state = 'pending'}
    memoryNotice = ''
    return true, 'Memory clear requested. Waiting for the memory service to confirm it.'
end

local function sortNames(a, b)
    local left, right = a.name:lower(), b.name:lower()
    return left == right and a.key < b.key or left < right
end

local function isChoice(value, choices)
    for _, choice in ipairs(choices) do if value == choice then return true end end
    return false
end

local function loadSettings()
    if settingsLoaded then return end
    settingsLoaded = true
    settings = readJSON('runtime/settings.json') or readJSON('runtime/settings.json.previous') or {}
    settingsNeedSave = settings.version ~= 2 or type(settings.enabledByKey) ~= 'table'
    settings.version = 2
    if settings.uiLanguage ~= 'auto' and not isChoice(settings.uiLanguage, ui.supported()) then
        settings.uiLanguage, settingsNeedSave = 'auto', true
    end
    ui.configure(settings.uiLanguage)
    if type(settings.voice) ~= 'boolean' then settings.voice = true end
    if type(settings.subtitles) ~= 'boolean' then settings.subtitles = true end
    if settings.subtitleStyle ~= 'overhead' and settings.subtitleStyle ~= 'dialogue' then
        settings.subtitleStyle, settingsNeedSave = 'dialogue', true
    end
    if settings.disappearingMessages ~= nil then
        settings.disappearingMessages, settingsNeedSave = nil, true
    end
    if type(settings.relationshipModes) ~= 'table' then settings.relationshipModes, settingsNeedSave = {}, true end
    for key in pairs(settings.relationshipModes) do
        if not relationshipKeys[key] then settings.relationshipModes[key], settingsNeedSave = nil, true end
    end
    for key in pairs(relationshipKeys) do
        if not isChoice(settings.relationshipModes[key], {'auto', 'on', 'off'}) then
            settings.relationshipModes[key], settingsNeedSave = 'auto', true
        end
    end
    if type(settings.followUpQuestions) ~= 'boolean' then settings.followUpQuestions, settingsNeedSave = false, true end
    if type(settings.developerMode) ~= 'boolean' then settings.developerMode, settingsNeedSave = false, true end
    if type(settings.battleReactions) ~= 'boolean' then settings.battleReactions, settingsNeedSave = true, true end
    if type(settings.lootReactions) ~= 'boolean' then settings.lootReactions, settingsNeedSave = true, true end
    if not isChoice(settings.eyeContactHeight, eyeContactHeights) then
        settings.eyeContactHeight, settingsNeedSave = 0, true
    end
    if not isChoice(settings.headFollowStrength, headFollowStrengths) then
        settings.headFollowStrength, settingsNeedSave = 1, true
    end
    if settings.voiceProvider ~= 'hybrid' and settings.voiceProvider ~= 'convai' then
        settings.voiceProvider, settingsNeedSave = 'hybrid', true
    end
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

function M.followUpQuestions()
    loadSettings()
    return settings.followUpQuestions == true
end

-- The feedback paths read the already loaded saved choice. Never load files,
-- query native settings or retain native handles from a menu callback.
function M.developerMode()
    return settings ~= nil and settings.developerMode == true
end

function M.relationshipChoices()
    loadSettings()
    local result = {}
    for _, profile in ipairs(relationshipProfiles) do
        result[#result + 1] = {key = profile.key, name = profile.name, mode = settings.relationshipModes[profile.key]}
    end
    return result
end

function M.subtitleStyle()
    loadSettings()
    return settings.subtitleStyle
end

function M.battleReactions()
    loadSettings()
    return settings.battleReactions == true
end

function M.lootReactions()
    loadSettings()
    return settings.lootReactions == true
end

-- Read by the ordinary companion update, never by a native menu callback.
-- Applying settings only persists this policy; the actuator replaces its exact
-- owned look request after gameplay resumes, without changing a movement ticket.
function M.gazeSettings()
    loadSettings()
    return {eyeContactHeight = settings.eyeContactHeight, headFollowStrength = settings.headFollowStrength}
end

function M.gazeChoices()
    local heights, strengths = {}, {}
    for index, value in ipairs(eyeContactHeights) do heights[index] = value end
    for index, value in ipairs(headFollowStrengths) do strengths[index] = value end
    return heights, strengths
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
    companions.gazeSettings = M.gazeSettings
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
    memoryConfirmation = nil
end

local function updateLocalVoice()
    local state = readJSON('runtime/local-voice-state.json') or {}
    local fresh = type(state.updated) == 'number' and math.abs(os.time() - state.updated / 1000) < 15
    localVoices = {}
    if not fresh then state.state, state.routedProfiles = 'waiting', {} end
    for _, key in ipairs(state.routedProfiles or {}) do
        if type(key) == 'string' and byKey[key] then localVoices[key] = true end
    end
    local signature = tostring(state.provider) .. ':' .. tostring(state.state) .. ':' .. tostring(state.steps)
        .. ':' .. tostring(state.routeRevision)
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
    local unnamedIndex = not label and not profile and not id and index or nil
    label = clean(label or (profile and profile.name) or id or ('Unnamed model ' .. index), 160)
    local key = 'model:' .. tostring(index)
    local definition = {id = id, recordID = recordID, name = label,
        profileKey = profile and profile.key or nil, profileName = profile and profile.name or nil}
    local registered = companions.registerDefinition(key, definition)
    if registered then
        models[#models + 1] = {key = key, name = label, unnamedIndex = unnamedIndex, record = id or debugId,
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
        if localVoices[profile.key] and settings.voiceProvider == 'hybrid' and localVoiceState.provider == 'hybrid' then
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
    updateMemory()
    local enabled = {}
    for key, value in pairs(settings.enabledByKey) do enabled[key] = value end
    local relationshipModes = {}
    for key in pairs(relationshipKeys) do relationshipModes[key] = settings.relationshipModes[key] end
    return {
        profiles = profiles, models = models, party = party, feedback = feedback,
        settings = {voice = settings.voice, subtitles = settings.subtitles, subtitleStyle = settings.subtitleStyle,
            followUpQuestions = settings.followUpQuestions,
            developerMode = settings.developerMode,
            relationshipModes = relationshipModes,
            battleReactions = settings.battleReactions,
            lootReactions = settings.lootReactions,
            eyeContactHeight = settings.eyeContactHeight,
            headFollowStrength = settings.headFollowStrength,
            voiceProvider = settings.voiceProvider,
            uiLanguage = settings.uiLanguage,
            omniSteps = settings.omniSteps, enabledByKey = enabled},
        localVoice = localVoiceState,
        memory = memorySnapshot(),
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

function M.interfaceLanguage()
    loadSettings()
    return settings.uiLanguage
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
    nextSettings.relationshipModes = {}
    for key, value in pairs(settings.relationshipModes) do nextSettings.relationshipModes[key] = value end
    for key, value in pairs(values) do
        if key == 'voice' or key == 'subtitles' or key == 'followUpQuestions' or key == 'developerMode'
            or key == 'battleReactions' or key == 'lootReactions' then
            if type(value) ~= 'boolean' then return false, 'This setting must be on or off.' end
            nextSettings[key] = value
        elseif key == 'relationshipModes' then
            if type(value) ~= 'table' then return false, 'Choose Auto, On or Off for each relationship.' end
            for profileKey, mode in pairs(value) do
                if not relationshipKeys[profileKey] or not isChoice(mode, {'auto', 'on', 'off'}) then
                    return false, 'Choose Auto, On or Off for each relationship.'
                end
                nextSettings.relationshipModes[profileKey] = mode
            end
        elseif key == 'subtitleStyle' then
            if value ~= 'overhead' and value ~= 'dialogue' then return false, 'Choose Above speaker or Dialogue HUD.' end
            nextSettings.subtitleStyle = value
        elseif key == 'omniSteps' then
            if value ~= 16 and value ~= 32 then return false, 'Choose 16 or 32 voice steps.' end
            nextSettings.omniSteps = value
        elseif key == 'uiLanguage' then
            if value ~= 'auto' and not isChoice(value, ui.supported()) then return false, ui.t('Choose an interface language.') end
            nextSettings.uiLanguage = value
        elseif key == 'voiceProvider' then
            if value ~= 'hybrid' and value ~= 'convai' then return false, 'Choose OmniVoice or Convai voices.' end
            nextSettings.voiceProvider = value
        elseif key == 'eyeContactHeight' then
            if not isChoice(value, eyeContactHeights) then return false, 'Choose an eye-contact height from the available settings.' end
            nextSettings.eyeContactHeight = value
        elseif key == 'headFollowStrength' then
            if not isChoice(value, headFollowStrengths) then return false, 'Choose a head-follow strength from the available settings.' end
            nextSettings.headFollowStrength = value
        elseif key == 'enabledByKey' then
            if type(value) ~= 'table' then return false, 'Invalid conversation settings.' end
            for profile, enabled in pairs(value) do
                if not byKey[profile] or type(enabled) ~= 'boolean' then
                    return false, 'That conversation profile is unavailable.'
                end
                nextSettings.enabledByKey[profile] = enabled
            end
        else return false, ui.t('Unknown setting: {setting}',{setting=tostring(key)}) end
    end
    local previous = settings
    settings = nextSettings
    if not saveSettings() then
        settings = previous
        return false, 'The settings could not be saved. Your changes are still pending.'
    end
    ui.configure(settings.uiLanguage)
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
