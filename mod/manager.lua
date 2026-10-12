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
-- The Companion voices list: Pocket TTS (default), OmniVoice at 16 or 32 steps with a short or a long
-- reference, Convai. The fallback order inside the bridge stays OmniVoice, Pocket TTS, Convai.
local DEFAULT_VOICE_PROVIDER, DEFAULT_OMNI_STEPS, DEFAULT_OMNI_REFERENCE = 'pocket', 16, 'long'
-- The menu text of each OmniVoice choice, named by quality from fastest to best (Balanced and Quality are 16 steps
-- with a short and a long reference, High Quality and Ultra Quality 32 steps). These are also the names used in
-- status lines and fallback notices. The saved values (omniSteps, omniReference) never change.
local OMNI_LABELS = {
    ['16:short'] = 'OmniVoice · Balanced',
    ['16:long'] = 'OmniVoice · Quality',
    ['32:short'] = 'OmniVoice · High Quality',
    ['32:long'] = 'OmniVoice · Ultra Quality',
}
local OMNI_PACK_MISSING = 'Requires the optional OmniVoice pack (GPU)'
local VOXTRAL_KEY_MISSING = 'Requires a Mistral key (add it in Settings > Development)'
local voiceFallbackSeen, voiceFallbackNotice = {}, nil
-- Natural speech and Expressive emotions need a local voice (the Convai cloud voice would read their tags aloud). The
-- pending notice, once, after an Apply that switched the voice or turned the two settings off.
local naturalSpeechNotice = nil
local eyeContactHeights = {-0.10, -0.05, 0, 0.05, 0.10}
-- Lip sync delay (Bluetooth), in ms; 'auto' lets the bridge detect a Bluetooth
-- output device (bridge/audio-delay.mjs). The bridge reads it from settings.json.
local audioDelays = {'auto', 0, 50, 100, 150, 200, 250}
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
    memoryNotice = '' -- A cancelled or closed-picker note does not belong beside a new confirmation.
    memoryConfirmation = {token = tostring(memoryConfirmSequence), scope = scope,
        profileKey = scope == 'character' and memorySelected or nil, count = memoryState.talkedToCount}
    return true, 'Review the memory clear below, then choose Confirm or Cancel.'
end

function M.cancelMemoryClear(token)
    if not memoryConfirmation or memoryConfirmation.token ~= token then return false, 'That confirmation is no longer active.' end
    memoryConfirmation, memoryNotice = nil, 'Memory clear cancelled. Nothing was deleted.'
    return true, memoryNotice
end

-- Leaving the character picker only navigates; it can never clear anything.
-- Say so on the page the player returns to. An earlier clear's own status stays
-- on the page (a pending or failed result must remain visible), so then the
-- reassurance is the transient action banner only.
function M.closeMemoryPicker()
    local message = 'Character picker closed. Your selection is unchanged. Closing it deleted nothing.'
    if not memoryCommand then memoryNotice = message end
    return true, message
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

local function writeCommandFile(target, value)
    local encoded, payload = pcall(json.encode, value)
    if not encoded then return false end
    local temporary, backup = target .. '.tmp', target .. '.previous'
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

local function writeMemoryCommand(value) return writeCommandFile('runtime/memory-command.json', value) end

-- The player's own Convai API key (docs/OWN_CONVAI_KEY.md). The bridge reads the key from the clipboard on request and
-- keeps it in its own folder; this file only sends two commands and reads the status the bridge publishes. Nothing here
-- ever holds the key. The status file is read on demand (the settings page asks about once a second while it is open).
local ownKeyState, ownKeyReadAt, ownKeyCommand, ownKeySequence = {}, nil, nil, 0

local function updateOwnKey(force)
    local clock = os.clock()
    if not force and ownKeyReadAt and clock - ownKeyReadAt < 1.5 then return end
    ownKeyReadAt = clock
    local value = readJSON('runtime/own-key-state.json')
    ownKeyState = type(value) == 'table' and value or {}
end

local function sendOwnKeyCommand(action)
    memorySession = memorySession or memorySessionUUID()
    ownKeySequence = ownKeySequence + 1
    local command = {version = 1, id = memorySession .. ':key:' .. ownKeySequence, action = action,
        issuedAt = os.time() * 1000.0}
    if not writeCommandFile('runtime/own-key-command.json', command) then
        return false, 'The request could not be sent. Try again.'
    end
    ownKeyCommand = command.id
    ownKeyReadAt = nil
    return true
end

function M.pasteOwnKey()
    local ok, reason = sendOwnKeyCommand('paste')
    if not ok then return false, reason end
    return true, 'Checking…'
end

function M.removeOwnKey()
    local ok, reason = sendOwnKeyCommand('clear')
    if not ok then return false, reason end
    return true, 'Your key was removed.'
end

-- What the settings page shows. `result` is the outcome of the player's latest Paste or Remove, and only that one.
function M.ownKey()
    updateOwnKey()
    local state = ownKeyState
    local result = type(state.result) == 'table' and state.result.id == ownKeyCommand and state.result.state or nil
    local limit = type(state.limit) == 'table' and state.limit or nil
    -- The shared plan's daily allowance (bridge/shared-key-guard.mjs); absent on a player's own key and in development.
    local daily = type(state.daily) == 'table' and state.daily or nil
    local function count(value) return type(value) == 'number' and value == math.floor(value) and value >= 0 and value <= 1000000 end
    if daily and not (count(daily.left) and count(daily.limit) and daily.limit > 0) then daily = nil end
    return {saved = state.saved == true, tail = type(state.tail) == 'string' and state.tail or nil,
        active = state.active == 'player' and 'player' or 'shared', pending = state.pending == true,
        result = type(result) == 'string' and result or nil, memoryOff = state.memory == 'off',
        limit = limit and limit.state or nil, limitOwn = limit and limit.own == true or false,
        daily = daily and {left = daily.left, limit = daily.limit, blocked = daily.blocked == true} or nil}
end

-- The Mistral text provider: the same shape as the Convai key above. The bridge reads the key from
-- the clipboard on request and keeps it in its own folder; this file sends two commands and reads the status the bridge
-- publishes (runtime/mistral-state.json, never the key). Read on demand, at most once every 1.5 s.
local mistralState, mistralReadAt, mistralCommand, mistralSequence = {}, nil, nil, 0

local function updateMistral(force)
    local clock = os.clock()
    if not force and mistralReadAt and clock - mistralReadAt < 1.5 then return end
    mistralReadAt = clock
    local value = readJSON('runtime/mistral-state.json')
    mistralState = type(value) == 'table' and value or {}
end

local function sendMistralCommand(action)
    memorySession = memorySession or memorySessionUUID()
    mistralSequence = mistralSequence + 1
    local command = {version = 1, id = memorySession .. ':mkey:' .. mistralSequence, action = action,
        issuedAt = os.time() * 1000.0}
    if not writeCommandFile('runtime/mistral-key-command.json', command) then
        return false, 'The request could not be sent. Try again.'
    end
    mistralCommand = command.id
    mistralReadAt = nil
    return true
end

function M.pasteMistralKey()
    local ok, reason = sendMistralCommand('paste')
    if not ok then return false, reason end
    return true, 'Checking…'
end

function M.removeMistralKey()
    local ok, reason = sendMistralCommand('clear')
    if not ok then return false, reason end
    return true, 'Your key was removed.'
end

local mistralResults = {saved = true, cleared = true, invalid = true, unreadable = true, failed = true}
local mistralLimits = {rate = true, daily = true, invalid = true, model = true}

-- What the settings page shows. `result` is the outcome of the player's latest Paste or Remove, and only that one.
-- Anything missing or unexpected reads as "Convai, no key": the safe default.
function M.mistral()
    updateMistral()
    local state = mistralState
    local result = type(state.result) == 'table' and state.result.id == mistralCommand and state.result.state or nil
    local tail = type(state.tail) == 'string' and #state.tail <= 8 and state.tail or nil
    local model = type(state.model) == 'string' and #state.model <= 80 and state.model:match('^[%w%.%-_:/]+$') and state.model or nil
    return {provider = state.provider == 'mistral' and 'mistral' or 'convai',
        effective = state.effective == 'mistral' and 'mistral' or 'convai',
        saved = state.saved == true, tail = tail, pending = state.pending == true,
        result = mistralResults[result] and result or nil,
        limit = mistralLimits[state.limit] and state.limit or nil, model = model, stt = state.stt == true}
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

-- Maps any saved engine name to the nearest current choice. Unknown values
-- take the default (Pocket TTS). Provider names stay stable so older saves keep
-- working: Pocket TTS was and remains 'pocket', OmniVoice 'omni' (old 'hybrid'),
-- Convai 'convai', the Mistral cloud voice (Voxtral) 'voxtral'. Any Pocket variant name resolves to the one Pocket TTS entry.
-- A save from before the short/long choice has no omniReference and migrates to
-- 'long': whoever chose OmniVoice chose quality, and long is the better match.
local function normalizeVoiceProvider(value)
    if type(value) ~= 'string' then return DEFAULT_VOICE_PROVIDER end
    local name = value:lower()
    if name == 'convai' or name == 'voxtral' then return name end
    if name:find('pocket', 1, true) then return 'pocket' end
    if name:find('omni', 1, true) or name == 'hybrid' then return 'omni' end
    return DEFAULT_VOICE_PROVIDER
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
    if not isChoice(settings.audioDelay, audioDelays) then
        settings.audioDelay, settingsNeedSave = 'auto', settingsNeedSave or settings.audioDelay ~= nil
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
    -- The retired Follow-up questions setting: an old saved key is dropped (nothing reads it).
    if settings.followUpQuestions ~= nil then settings.followUpQuestions, settingsNeedSave = nil, true end
    if type(settings.developerMode) ~= 'boolean' then settings.developerMode, settingsNeedSave = false, true end
    -- Off by default: conversations use the shared plan until the player turns their own Convai key on (bridge/convai-key.mjs).
    if type(settings.useOwnConvaiKey) ~= 'boolean' then settings.useOwnConvaiKey, settingsNeedSave = false, true end
    -- Who writes the replies: 'convai' (default) or 'mistral' (the player's own Mistral key). Any other
    -- saved value is Convai. The bridge reads this from settings.json and applies it when no conversation is running.
    if settings.conversationProvider ~= 'convai' and settings.conversationProvider ~= 'mistral' then
        settings.conversationProvider, settingsNeedSave = 'convai', true
    end
    if type(settings.battleReactions) ~= 'boolean' then settings.battleReactions, settingsNeedSave = false, true end
    if type(settings.lootReactions) ~= 'boolean' then settings.lootReactions, settingsNeedSave = false, true end
    -- On by default (a missing key); an explicitly saved choice is kept.
    if type(settings.bodyGestures) ~= 'boolean' then settings.bodyGestures, settingsNeedSave = true, true end
    -- On by default (a missing key); an explicitly saved choice is kept.
    if type(settings.autoConnectNearby) ~= 'boolean' then settings.autoConnectNearby, settingsNeedSave = true, true end
    -- On by default: recent subtitled game dialogue is attached to the next manual turn (mod/game-dialogue.lua).
    if type(settings.gameDialogueContext) ~= 'boolean' then settings.gameDialogueContext, settingsNeedSave = true, true end
    if not isChoice(settings.eyeContactHeight, eyeContactHeights) then
        settings.eyeContactHeight, settingsNeedSave = 0, true
    end
    if not isChoice(settings.headFollowStrength, headFollowStrengths) then
        settings.headFollowStrength, settingsNeedSave = 1, true
    end
    local provider = normalizeVoiceProvider(settings.voiceProvider)
    if provider ~= settings.voiceProvider then settings.voiceProvider, settingsNeedSave = provider, true end
    if settings.omniSteps ~= 16 and settings.omniSteps ~= 32 then
        settings.omniSteps, settingsNeedSave = DEFAULT_OMNI_STEPS, true
    end
    if settings.omniReference ~= 'short' and settings.omniReference ~= 'long' then
        settings.omniReference, settingsNeedSave = DEFAULT_OMNI_REFERENCE, true
    end
    if type(settings.keepPreparedVoices) ~= 'boolean' then settings.keepPreparedVoices, settingsNeedSave = true, true end
    -- On by default: unnamed gang members, police, vendors and residents can be talked to (docs/NPC_ARCHETYPES.md).
    if type(settings.archetypeConversations) ~= 'boolean' then settings.archetypeConversations, settingsNeedSave = true, true end
    -- Off by default. A saved pairing with the Convai cloud voice cannot stand: the cloud voice is kept (it is the
    -- player's voice) and the setting is turned off below.
    if type(settings.naturalSpeech) ~= 'boolean' then settings.naturalSpeech, settingsNeedSave = false, true end
    -- Expressive emotions (the character marks its own feelings; on by default) needs a local voice for the same reason.
    -- A missing key defaults to on, except beside a saved Convai cloud voice, which can never use it (the new-install
    -- default voice is Pocket, so a new install gets it on).
    if type(settings.expressiveEmotions) ~= 'boolean' then
        settings.expressiveEmotions, settingsNeedSave = settings.voiceProvider ~= 'convai', true
    end
    -- Whether the player ever set Expressive emotions themselves (an Apply that carried it). Only that makes turning it
    -- off, for the cloud voice, worth a notice; the default being switched off is silent.
    if type(settings.expressiveEmotionsChosen) ~= 'boolean' then settings.expressiveEmotionsChosen = false end
    -- Follow-up questions (on by default, key followUpInterest: the retired followUpQuestions key above is a different, dropped
    -- setting): characters sometimes show interest in the player. Works with any voice.
    if type(settings.followUpInterest) ~= 'boolean' then settings.followUpInterest, settingsNeedSave = true, true end
    -- Multilingual conversations (off by default): conversations go to each character's multilingual twin. Pocket TTS
    -- speaks only English, so a saved pairing with it cannot stand (Apply never makes one): the voice moves to the cloud
    -- voice, which every installation can run. With the cloud voice, Multilingual wins over the two tag settings.
    if type(settings.multilingualConversations) ~= 'boolean' then settings.multilingualConversations, settingsNeedSave = false, true end
    if settings.multilingualConversations and (settings.voiceProvider == 'pocket' or settings.voiceProvider == 'voxtral') then
        settings.voiceProvider, settingsNeedSave = 'convai', true
    end
    -- A saved cloud voice with a tag setting on (an older save): the voice is kept and the tag settings are turned off,
    -- with Multilingual conversations on or off alike. Apply never writes this pairing.
    if (settings.naturalSpeech or settings.expressiveEmotions) and settings.voiceProvider == 'convai' then
        settings.naturalSpeech, settings.expressiveEmotions, settingsNeedSave = false, false, true
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

-- Generic NPC archetypes (npc-* keys) are talk-only profiles: not listed on the
-- Characters page or in Who can talk, never invited, governed by one setting.
local archetypeKeys = {}
-- classifyRecord(facts) -> profile key or nil, label(key) -> display name: the
-- Model browser maps character records to archetypes (docs/NPC_ARCHETYPES.md).
local classifyRecord, archetypeLabel
function M.configureArchetypes(keys, classify, label)
    archetypeKeys = {}
    for key in pairs(keys or {}) do archetypeKeys[key] = true end
    classifyRecord = type(classify) == 'function' and classify or nil
    archetypeLabel = type(label) == 'function' and label or nil
end

function M.archetypeConversations()
    loadSettings()
    return settings.archetypeConversations ~= false
end

function M.profileEnabled(key)
    loadSettings()
    if key ~= nil and archetypeKeys[key] and byKey[key] == nil then return settings.archetypeConversations ~= false end
    return key ~= nil and byKey[key] ~= nil and settings.enabledByKey[key] ~= false
end

-- The feedback paths read the already loaded saved choice. Never load files,
-- query native settings or retain native handles from a menu callback.
-- One of the voice choices, as the player reads it in Settings.
function M.voiceLabel(provider, steps, reference)
    if provider == 'pocket' then return ui.t('Pocket · Performance') end
    if provider == 'convai' then return ui.t('Convai · Cloud voice') end
    if provider == 'voxtral' then return ui.t('Mistral cloud voice (Voxtral)') end
    return ui.t(OMNI_LABELS[(steps == 32 and '32' or '16') .. ':' .. (reference == 'short' and 'short' or 'long')])
end

-- The optional OmniVoice pack, as the bridge reports it (worker Python, model weights, adapter). Unknown (no fresh
-- report) counts as installed: Settings never locks a choice because the service has not answered yet.
function M.omniPack()
    local pack = type(localVoiceState) == 'table' and localVoiceState.omniPack or nil
    local fresh = type(localVoiceState.updated) == 'number' and math.abs(os.time() - localVoiceState.updated / 1000) < 15
    if fresh and type(pack) == 'table' and pack.installed == false then
        return {installed = false, known = true, missing = pack.missing or {}}
    end
    return {installed = true, known = fresh and type(pack) == 'table'}
end

-- The pending "chosen voice could not run" notice, once. The caller asks only
-- in gameplay so a paused menu cannot swallow it. A temporary fallback (OmniVoice is being loaded again in the
-- background and returns by itself, with no notice) says so instead of calling the voice unavailable.
function M.takeVoiceFallbackNotice()
    local pending = voiceFallbackNotice
    voiceFallbackNotice = nil
    if not pending then return nil end
    if pending.temporary then
        return ui.t('{requested} is not ready yet. Companions are using {voice} for now.', {
            requested = M.voiceLabel(pending.from, pending.steps, pending.reference), voice = M.voiceLabel(pending.to)})
    end
    return ui.t('{requested} is unavailable. Companions are using {voice} instead.', {
        requested = M.voiceLabel(pending.from, pending.steps, pending.reference), voice = M.voiceLabel(pending.to)})
end

-- Once, after an Apply that switched the voice (a tag setting was turned on beside the cloud voice) or that turned a tag
-- setting off (the cloud voice was chosen).
function M.takeNaturalSpeechNotice()
    local pending = naturalSpeechNotice
    naturalSpeechNotice = nil
    return pending
end

function M.developerMode()
    return settings ~= nil and settings.developerMode == true
end

-- True when speaking to a companion cannot work right now: the player chose Mistral, the bridge says Mistral is the
-- provider in use, and this computer cannot recognise speech locally. Asked only when a voice key is pressed (never per
-- frame); the bridge status is re-read at most once every 1.5 s.
function M.voiceNeedsConvai()
    loadSettings()
    if settings.conversationProvider ~= 'mistral' then return false end
    local state = M.mistral()
    return state.effective == 'mistral' and state.stt ~= true
end

-- Off by default: companions speak as before. On, the conversation service tells each character which pauses and
-- sounds its voice engine can render and lets it decide, from its personality, when one fits.
function M.naturalSpeech()
    loadSettings()
    return settings.naturalSpeech == true
end

-- On by default. On, the character marks where its feeling changes and the face follows those marks, timed to the voice;
-- off, a local voice's face follows our text-based reading of the reply. Needs a local voice, like Natural speech.
function M.expressiveEmotions()
    loadSettings()
    return settings.expressiveEmotions == true
end

-- On by default. On, the conversation service sometimes asks each character to show interest in you inside the reply it
-- is already giving (a question about what you said, a follow-up, a thought that invites an answer). Any voice works.
function M.followUpInterest()
    loadSettings()
    return settings.followUpInterest == true
end

-- Off by default. On, conversations go to each character's multilingual twin, which answers in the player's language.
function M.multilingualConversations()
    loadSettings()
    return settings.multilingualConversations == true
end

-- Multilingual conversations needs a voice that speaks every language. Pocket TTS speaks only English; OmniVoice (the
-- optional pack) and the Convai cloud voice speak them all, but the cloud voice would read Natural speech and Expressive
-- emotions tags aloud. Judged on the settings as they will be after this Apply (`after` is changed in place):
--   - turning it on moves the voice to OmniVoice · Balanced (16 steps, short reference: the lightest Omni) when the pack
--     is installed, or to the cloud voice otherwise; an OmniVoice tier is kept, and so is a cloud voice chosen in the
--     same Apply (honourCloudVoice has already turned the tag settings off by then);
--   - without the pack, Multilingual wins: the two tag settings are turned off, and turning one on later is refused;
--   - while it is on, choosing Pocket TTS is refused (turning Multilingual off is the player's own choice to make);
--   - with the pack, a tag setting turned on beside a saved cloud voice moves the voice to OmniVoice · Balanced, never to
--     Pocket. (Choosing the cloud voice keeps it and turns the tag settings off, as without Multilingual.)
-- Turning it off leaves the voice as it is. Returns an error to refuse the Apply, and the notices to show.
local function resolveMultilingualVoice(before, after, values, packInstalled)
    local result = {notices = {}}
    if after.multilingualConversations ~= true then return result end
    local turningOn = before.multilingualConversations ~= true
    if values.voiceProvider ~= nil and after.voiceProvider == 'pocket' then
        result.error = ui.t('Pocket TTS speaks only English. Turn off Multilingual conversations to choose it.')
        return result
    end
    if values.voiceProvider ~= nil and after.voiceProvider == 'voxtral' then
        result.error = ui.t('The Mistral cloud voice speaks only English here. Turn off Multilingual conversations to choose it.')
        return result
    end
    local effects = after.naturalSpeech == true or after.expressiveEmotions == true
    local function switched(voice)
        local named = {setting = ui.t('Companion voices'), voice = voice}
        if turningOn then
            return ui.t('Multilingual conversations needs a voice that speaks every language, so {setting} was switched to {voice}.', named)
        end
        return after.naturalSpeech == true
            and ui.t('Natural speech needs a local voice, so {setting} was switched to {voice}.', named)
            or ui.t('Expressive emotions need a local voice, so {setting} was switched to {voice}.', named)
    end
    if not packInstalled then
        local newlyOn = (values.naturalSpeech == true and after.naturalSpeech == true and before.naturalSpeech ~= true)
            or (values.expressiveEmotions == true and after.expressiveEmotions == true and before.expressiveEmotions ~= true)
        if newlyOn and not turningOn then
            result.error = ui.t('Natural speech and Expressive emotions need the OmniVoice pack while Multilingual conversations is on: the Convai cloud voice would read their tags aloud.')
            return result
        end
        if after.voiceProvider ~= 'convai' then
            after.voiceProvider = 'convai'
            result.notices[#result.notices + 1] = switched(M.voiceLabel('convai'))
        end
        if effects then
            after.naturalSpeech, after.expressiveEmotions = false, false
            result.notices[#result.notices + 1] = ui.t('Natural speech and Expressive emotions were turned off: the Convai cloud voice would read their tags aloud. With the OmniVoice pack, all three work together.')
        end
        return result
    end
    local keepCloud = after.voiceProvider == 'convai' and not effects and (not turningOn or values.voiceProvider == 'convai')
    if after.voiceProvider ~= 'omni' and not keepCloud then
        after.voiceProvider, after.omniSteps, after.omniReference = 'omni', 16, 'short'
        result.notices[#result.notices + 1] = switched(M.voiceLabel('omni', 16, 'short'))
    end
    return result
end
M.resolveMultilingualVoice = resolveMultilingualVoice

-- Choosing the Convai cloud voice honours the voice: Natural speech and Expressive emotions would make it read their tags
-- aloud, so they are turned off instead of the voice being refused or moved (`after` is changed in place). Applies only
-- when this Apply changes the voice to the cloud voice. That includes the same Apply turning a tag setting on: the voice
-- choice wins. If the cloud voice is already saved, the voice is not being chosen, and a tag setting turned on beside it
-- wins instead (the voice moves to a local one, as before). Returns the one notice to show, or nil: only when a setting
-- the player had set themselves was turned off (Natural speech is off by default, so on means chosen; Expressive emotions
-- is on by default, so only when an earlier or this Apply carried it). Turning only the default off is silent, and then
-- the second result is true so the caller can still ask the open page to reload.
local function honourCloudVoice(before, after, values)
    if values.voiceProvider ~= 'convai' or before.voiceProvider == 'convai' or after.voiceProvider ~= 'convai' then return nil end
    local speech, emotions = after.naturalSpeech == true, after.expressiveEmotions == true
    if not speech and not emotions then return nil end
    after.naturalSpeech, after.expressiveEmotions = false, false
    if speech or after.expressiveEmotionsChosen == true then
        return ui.t('The Convai cloud voice cannot use Natural speech or Expressive emotions, so they were turned off.')
    end
    return nil, true
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

function M.bodyGestures()
    loadSettings()
    return settings.bodyGestures == true
end

-- On by default, silently: the connection and local voice of a character the player looks at or walks up to
-- are prepared ahead (mod/auto-connect.lua). Off, a connection is made when the player starts talking.
function M.autoConnectNearby()
    loadSettings()
    return settings.autoConnectNearby == true
end

-- On by default: a character addressed right after the game's own dialogue with them knows the last lines that
-- were said (docs/GAME_DIALOGUE_CONTEXT.md). Off, no game dialogue is recorded or sent.
function M.gameDialogueContext()
    loadSettings()
    return settings.gameDialogueContext == true
end

-- Read by the ordinary companion update, never by a native menu callback.
-- Applying settings only persists this policy; the actuator replaces its exact
-- owned look request after gameplay resumes, without changing a movement ticket.
function M.gazeSettings()
    loadSettings()
    return {eyeContactHeight = settings.eyeContactHeight, headFollowStrength = settings.headFollowStrength}
end

function M.audioDelayChoices() return audioDelays end

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
    -- The bridge reports a fallback only after it committed the lower voice.
    -- Tell the player once per fallback; the mark clears when the fallback ends.
    local fallback = state.fallback
    if fresh and type(fallback) == 'table' and (fallback.from == 'omni' or fallback.from == 'pocket' or fallback.from == 'voxtral')
        and (fallback.to == 'pocket' or fallback.to == 'convai') then
        -- A temporary fallback and the permanent one it can turn into are announced separately, once each.
        local temporary = fallback.temporary == true
        local id = fallback.from .. '>' .. fallback.to .. (temporary and ':temporary' or '')
        if not voiceFallbackSeen[id] then
            voiceFallbackSeen[id] = true
            voiceFallbackNotice = {from = fallback.from, to = fallback.to, temporary = temporary,
                steps = state.requestedOmniSteps, reference = state.requestedOmniReference}
        end
        signature = signature .. ':' .. id
    elseif fresh then
        voiceFallbackSeen = {}
    end
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

-- TweakDB-only facts of a character record for the archetype mapping. Each read
-- is guarded; enum names are CNames (read as text).
local function nameText(value)
    if type(value) == 'string' then return value end
    if value == nil then return nil end
    local ok, text = pcall(function() return value.value end)
    if ok and type(text) == 'string' and text ~= '' then return text end
    ok, text = pcall(function() return Game.NameToString(value) end)
    if ok and type(text) == 'string' and text ~= '' and text ~= 'None' then return text end
    return nil
end
local function recordFacts(record, id)
    local facts = {recordName = id}
    local function read(name, fn)
        local ok, value = pcall(fn)
        if ok and value ~= nil then facts[name] = value end
    end
    read('affiliation', function() local value = record:Affiliation(); return value and nameText(value:EnumName()) end)
    read('crowd', function() return record:IsCrowd() == true end)
    read('children', function() return record:IsChild() == true end)
    read('human', function() local value = record:CharacterType(); return value and nameText(value:EnumName()) == 'Human' end)
    read('quest', function() local value = record:Quest(); return value and nameText(value:EnumName()) end)
    read('vendorType', function()
        local vendor = record:VendorID(); local kind = vendor and vendor:VendorType()
        return kind and nameText(kind:EnumName())
    end)
    facts.vendor = facts.vendorType ~= nil
    return facts
end
-- {key, name} of the generic profile a copy of this record would use, or nil.
local function archetypeFor(record, id)
    if not classifyRecord or not id then return nil end
    local ok, key = pcall(classifyRecord, recordFacts(record, id))
    if not ok or type(key) ~= 'string' then return nil end
    local name = (archetypeLabel and archetypeLabel(key)) or (byKey[key] and 'Night City resident')
    if not name then return nil end
    return {key = key, name = name}
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
    local archetype = not profile and archetypeFor(record, id) or nil
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
        profileKey = profile and profile.key or (archetype and archetype.key) or nil,
        profileName = profile and profile.name or (archetype and archetype.name) or nil}
    local registered = companions.registerDefinition(key, definition)
    if registered then
        models[#models + 1] = {key = key, name = label, unnamedIndex = unnamedIndex, record = id or debugId,
            profileKey = definition.profileKey, profileName = definition.profileName, archetype = archetype ~= nil,
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
        if localVoices[profile.key] and localVoiceState.cloudVoice == 'voxtral' then
            body = body .. '\nVoice: ' .. M.voiceLabel('voxtral')
        elseif localVoices[profile.key] and (localVoiceState.provider == 'pocket' or localVoiceState.provider == 'omni') then
            body = body .. '\nVoice: ' .. M.voiceLabel(localVoiceState.provider, localVoiceState.omniSteps, localVoiceState.omniReference)
        elseif profile.voiceName then body = body .. '\nVoice: ' .. clean(profile.voiceName, 140) end
        if not item.definition then body = body .. '\nChoose a model in Models, then assign this profile in Party.' end
        primary, primaryLabel, primaryEnabled = 'spawn:' .. profile.key, 'Add a copy', item.definition ~= nil
        secondary, secondaryLabel, secondaryEnabled = 'toggle-profile:' .. profile.key,
            M.profileEnabled(profile.key) and 'Turn chat off' or 'Turn chat on', true
    elseif item.kind == 'model' then
        local model = item.model
        title, body = model.name, model.record
        body = body .. '\n\n' .. (model.profileKey and ('Conversation: ' .. model.profileName) or 'Conversation profile not assigned.')
            .. '\nAdd a copy, then use Party to choose its conversation profile.'
        primary, primaryLabel, primaryEnabled = 'spawn:' .. model.key, 'Add a copy', true
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
    end
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
    pcall(function() player:ConvaiManagerSetPartyStatus('Party: ' .. #party) end)
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
            developerMode = settings.developerMode,
            useOwnConvaiKey = settings.useOwnConvaiKey,
            conversationProvider = settings.conversationProvider,
            relationshipModes = relationshipModes,
            battleReactions = settings.battleReactions,
            lootReactions = settings.lootReactions,
            bodyGestures = settings.bodyGestures,
            autoConnectNearby = settings.autoConnectNearby,
            gameDialogueContext = settings.gameDialogueContext,
            eyeContactHeight = settings.eyeContactHeight,
            headFollowStrength = settings.headFollowStrength,
            audioDelay = settings.audioDelay,
            voiceProvider = settings.voiceProvider,
            omniSteps = settings.omniSteps,
            omniReference = settings.omniReference,
            keepPreparedVoices = settings.keepPreparedVoices,
            naturalSpeech = settings.naturalSpeech,
            expressiveEmotions = settings.expressiveEmotions,
            followUpInterest = settings.followUpInterest,
            multilingualConversations = settings.multilingualConversations,
            archetypeConversations = settings.archetypeConversations,
            uiLanguage = settings.uiLanguage,
            enabledByKey = enabled},
        ownKey = M.ownKey(),
        mistral = M.mistral(),
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
        if key == 'expressiveEmotions' then nextSettings.expressiveEmotionsChosen = true end
        if key == 'voice' or key == 'subtitles' or key == 'developerMode' or key == 'useOwnConvaiKey'
            or key == 'battleReactions' or key == 'lootReactions' or key == 'bodyGestures' or key == 'autoConnectNearby'
            or key == 'gameDialogueContext'
            or key == 'keepPreparedVoices' or key == 'naturalSpeech' or key == 'expressiveEmotions'
            or key == 'followUpInterest' or key == 'multilingualConversations' then
            if type(value) ~= 'boolean' then return false, 'This setting must be on or off.' end
            nextSettings[key] = value
        elseif key == 'relationshipModes' then
            if type(value) ~= 'table' then return false, 'Choose one of the listed relationship options.' end
            for profileKey, mode in pairs(value) do
                if not relationshipKeys[profileKey] or not isChoice(mode, {'auto', 'on', 'off'}) then
                    return false, 'Choose one of the listed relationship options.'
                end
                nextSettings.relationshipModes[profileKey] = mode
            end
        elseif key == 'archetypeConversations' then
            if type(value) ~= 'boolean' then return false, 'This setting must be on or off.' end
            nextSettings.archetypeConversations = value
        elseif key == 'conversationProvider' then
            if value ~= 'convai' and value ~= 'mistral' then return false, 'Choose one of the listed conversation providers.' end
            nextSettings.conversationProvider = value
        elseif key == 'audioDelay' then
            if not isChoice(value, audioDelays) then return false, 'Choose one of the listed lip sync delays.' end
            nextSettings.audioDelay = value
        elseif key == 'subtitleStyle' then
            if value ~= 'overhead' and value ~= 'dialogue' then return false, 'Choose one of the listed subtitle displays.' end
            nextSettings.subtitleStyle = value
        elseif key == 'uiLanguage' then
            if value ~= 'auto' and not isChoice(value, ui.supported()) then return false, ui.t('Choose an interface language.') end
            nextSettings.uiLanguage = value
        elseif key == 'voiceProvider' then
            if value == 'hybrid' then value = 'omni' end
            if value ~= 'pocket' and value ~= 'omni' and value ~= 'convai' and value ~= 'voxtral' then
                return false, 'Choose one of the listed companion voices.'
            end
            -- The Mistral cloud voice speaks with the player's Mistral key (the same one the text replies use).
            if value == 'voxtral' and not M.mistral().saved then return false, VOXTRAL_KEY_MISSING end
            -- An OmniVoice choice cannot be saved while the optional pack is missing; the choice never takes effect.
            if value == 'omni' and not M.omniPack().installed then return false, OMNI_PACK_MISSING end
            nextSettings.voiceProvider = value
        elseif key == 'omniSteps' then
            if value ~= 16 and value ~= 32 then return false, 'Choose 16 or 32 voice steps.' end
            nextSettings.omniSteps = value
        elseif key == 'omniReference' then
            if value ~= 'short' and value ~= 'long' then return false, 'Choose a short or a long voice reference.' end
            nextSettings.omniReference = value
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
    -- Natural speech and Expressive emotions need a local voice. They are judged as they will be after this Apply:
    -- choosing the cloud voice keeps it and turns both off (honourCloudVoice: one notice, only if the player had set one),
    -- while turning one on beside a saved cloud voice moves the voice to Pocket TTS with a notice. A tag setting turned on
    -- in the same Apply that changes the voice to the cloud voice loses to the voice.
    -- With Multilingual conversations on, the voice is resolved by its own rules below instead (never Pocket TTS).
    local cloudNotice, cloudQuiet = honourCloudVoice(settings, nextSettings, values)
    local multilingual = resolveMultilingualVoice(settings, nextSettings, values, M.omniPack().installed)
    if multilingual.error then return false, multilingual.error end
    local switchedVoice = nextSettings.multilingualConversations ~= true
        and (nextSettings.naturalSpeech == true or nextSettings.expressiveEmotions == true)
        and nextSettings.voiceProvider == 'convai'
    if switchedVoice then nextSettings.voiceProvider = 'pocket' end
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
    if switchedVoice or cloudNotice or #multilingual.notices > 0 then
        local notices = {}
        if cloudNotice then notices[#notices + 1] = cloudNotice end
        if switchedVoice then
            local named = {setting = ui.t('Companion voices'), voice = M.voiceLabel('pocket')}
            notices[#notices + 1] = nextSettings.naturalSpeech == true
                and ui.t('Natural speech needs a local voice, so {setting} was switched to {voice}.', named)
                or ui.t('Expressive emotions need a local voice, so {setting} was switched to {voice}.', named)
        end
        for _, notice in ipairs(multilingual.notices) do notices[#notices + 1] = notice end
        naturalSpeechNotice = table.concat(notices, ' ')
        feedback, dirty = clean(naturalSpeechNotice, 800), true
        return true, nil, naturalSpeechNotice
    end
    say('Settings saved.')
    -- A quiet turn-off still changes settings the open page shows: ask for a reload without a notice.
    return true, nil, nil, cloudQuiet == true
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
    if partyClock >= 0.5 then
        partyClock = 0; updateParty()
        -- The bridge refreshes local-voice-state.json every 5 s; read it every 2 s, not every 0.5 s.
        M.voiceClock = (M.voiceClock or 2) + 0.5
        if M.voiceClock >= 2 then M.voiceClock = 0; updateLocalVoice() end
    end
    if open then
        if tab == 'models' then beginModels(); scanModels() end
        if dirty then
            local ok, problem = pcall(render, player)
            if not ok then say('The manager could not refresh: ' .. clean(problem, 160)) end
        end
    end
end

return M
