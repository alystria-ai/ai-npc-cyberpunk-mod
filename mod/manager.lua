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
local VOXTRAL_KEY_MISSING = 'Requires a Mistral key (add it in Settings > Conversation provider)'
local INWORLD_KEY_MISSING = 'Requires an Inworld key (add it in Settings > Development)'
-- V's voice engine (Settings > Voices): which voice speaks V's typed line, whatever the companions use. Pocket is the default.
local V_VOICE_ENGINES = {'pocket', 'voxtral'}
local V_ENGINE_MATURE = 'Voxtral sends your line to Mistral. Turn off Mature content to choose it.'
local voiceFallbackSeen, voiceFallbackNotice = {}, nil
-- Natural speech and Expressive emotions need a local voice (the Convai cloud voice would read their tags aloud). The
-- pending notice, once, after an Apply that switched the voice or turned the two settings off.
local naturalSpeechNotice = nil
local eyeContactHeights = {-0.10, -0.05, 0, 0.05, 0.10}
-- Lip sync delay (Bluetooth), in ms; 'auto' lets the bridge detect a Bluetooth
-- output device (bridge/audio-delay.mjs). The bridge reads it from settings.json.
local audioDelays = {'auto', 0, 50, 100, 150, 200, 250}
local headFollowStrengths = {0, 0.5, 1, 1.5}
-- Voice volume, in percent (Settings > Voices): a slider. 100 is the unchanged level; the bridge turns it into gain behind a
-- peak limiter for every voice, V's included (bridge/dialogue-level.mjs). Stored as a whole number of percent, in steps of 5.
local voiceVolume = {min = 50, max = 200, step = 5, default = 100}
local function cleanVoiceVolume(value)
    if type(value) ~= 'number' or value ~= value or value < voiceVolume.min or value > voiceVolume.max then return nil end
    return math.floor(value / voiceVolume.step + 0.5) * voiceVolume.step
end
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
    -- Windows PowerShell and older Notepad save UTF-8 with a byte-order mark (EF BB BF), which the codec reads as garbage.
    if raw:sub(1, 3) == '\239\187\191' then raw = raw:sub(4) end
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
        local file = io.open('runtime/memory-command.json', 'rb')
        if file then
            local raw = file:read('*a'); file:close()
            -- The shipped empty placeholder, or a write cut short, is no request. Only a file that reads as a request
            -- but is not a valid one blocks the page.
            local ok, previous = pcall(json.decode, raw)
            if ok and type(previous) == 'table' then
                if validMemoryCommand(previous) then
                    memorySequence = tonumber(previous.id:match(':(%d+)$')) or 0
                    memoryCommand = {id = previous.id, scope = previous.scope, profileKey = previous.profileKey,
                        issuedAt = previous.issuedAt, state = 'pending'}
                else memoryRecoveryBlocked = true end
            end
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

-- The command files are shipped as empty placeholders and written in place: under Mod Organizer 2 a new file (a temporary one,
-- or the target re-created after a remove) lands in its Overwrite folder and the service never sees it. They are a few
-- hundred bytes, so a write that dies half-way leaves a file the service reads as no command, like the empty placeholder.
local function writeCommandFile(target, value)
    local encoded, payload = pcall(json.encode, value)
    if not encoded then return false end
    local file = io.open(target, 'wb')
    if not file then return false end
    local written = file:write(payload)
    local closed = file:close()
    return written and closed and true or false
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

-- Set further down, once the settings can be saved: replaces a saved Local AI model that left its pack (see goneLocalModelReplacement).
local repairGoneLocalModel

local function updateMistral(force)
    local clock = os.clock()
    if not force and mistralReadAt and clock - mistralReadAt < 1.5 then return end
    mistralReadAt = clock
    local value = readJSON('runtime/mistral-state.json')
    mistralState = type(value) == 'table' and value or {}
    if repairGoneLocalModel then repairGoneLocalModel() end
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

-- The Inworld cloud voice's key (docs/CLOUD_VOICE_INWORLD.md): the same shape again, on its own command file and ids. Its status
-- (saved, last four characters, the latest paste or remove) rides in the same status file, under `inworld`.
local inworldCommand, inworldSequence = nil, 0

local function sendInworldCommand(action)
    memorySession = memorySession or memorySessionUUID()
    inworldSequence = inworldSequence + 1
    local command = {version = 1, id = memorySession .. ':ikey:' .. inworldSequence, action = action,
        issuedAt = os.time() * 1000.0}
    if not writeCommandFile('runtime/inworld-key-command.json', command) then
        return false, 'The request could not be sent. Try again.'
    end
    inworldCommand = command.id
    mistralReadAt = nil
    return true
end

function M.pasteInworldKey()
    local ok, reason = sendInworldCommand('paste')
    if not ok then return false, reason end
    return true, 'Checking…'
end

function M.removeInworldKey()
    local ok, reason = sendInworldCommand('clear')
    if not ok then return false, reason end
    return true, 'Your key was removed.'
end

local mistralResults = {saved = true, cleared = true, invalid = true, unreadable = true, failed = true}
local mistralLimits = {rate = true, daily = true, invalid = true, model = true}
local localAiStates = {ready = true, warming = true, ['not-installed'] = true, ['no-memory'] = true, failed = true}
local function providerName(value)
    return (value == 'mistral' or value == 'local') and value or 'convai'
end

-- What the settings page shows. `result` is the outcome of the player's latest Paste or Remove, and only that one.
-- Anything missing or unexpected reads as "Convai, no key": the safe default.
-- A model id the bridge publishes or the settings file holds: 'standard', 'lite', 'mature:<file>' or 'custom:<name>' (letters, digits and . _ : -),
-- or 'auto' (nothing chosen yet, or a value an older version saved: the settings page shows the default model instead).
local function validModelId(value)
    return type(value) == 'string' and #value >= 1 and #value <= 80 and value:match('^[%w%.:_%-]+$') ~= nil
end

-- What turning Mature content on changed, kept in the settings so that turning it off puts the player's own choices back:
--   {conversationProvider = {before = 'convai' | 'convai-key' | 'mistral', set = 'local'}, localModel = {before = <model id>, set = <the uncensored model id>},
--    voice = {before = <voice>, set = <voice>}} where a voice is {provider = 'pocket'|'omni'|'convai'|'voxtral'|'inworld',
--   steps = 16|32, reference = 'short'|'long'} (steps and reference for omni only). Each part is optional; anything malformed is
-- dropped, and nil is returned when nothing is left. Returns a new table.
local function cleanMatureVoice(value)
    if type(value) ~= 'table' then return nil end
    local provider = value.provider
    if provider ~= 'pocket' and provider ~= 'omni' and provider ~= 'convai' and provider ~= 'voxtral' and provider ~= 'inworld' then return nil end
    if provider ~= 'omni' then return {provider = provider} end
    if (value.steps ~= 16 and value.steps ~= 32) or (value.reference ~= 'short' and value.reference ~= 'long') then return nil end
    return {provider = provider, steps = value.steps, reference = value.reference}
end

-- A provider as the restore record names it: the three stored values, or 'convai-key' (Convai with the player's own key, which the
-- selector lists as its own entry; stored as 'convai' plus useOwnConvaiKey).
local function restoreProviderName(value)
    return value == 'convai-key' and value or providerName(value)
end

local function cleanMatureRestore(value)
    if type(value) ~= 'table' then return nil end
    local result, any = {}, false
    local part = value.conversationProvider
    if type(part) == 'table' and restoreProviderName(part.before) == part.before and restoreProviderName(part.set) == part.set then
        result.conversationProvider, any = {before = part.before, set = part.set}, true
    end
    part = value.localModel
    if type(part) == 'table' and validModelId(part.before) and validModelId(part.set) then
        result.localModel, any = {before = part.before, set = part.set}, true
    end
    part = value.voice
    if type(part) == 'table' then
        local before, set = cleanMatureVoice(part.before), cleanMatureVoice(part.set)
        if before and set then result.voice, any = {before = before, set = set}, true end
    end
    return any and result or nil
end

-- The installed Local AI chat models the bridge reports ([{id, name, sizeMiB, custom?, needMiB?, tooLarge?}], runtime/mistral-state.json), sorted
-- by file size, smallest first (an equal size by name); anything malformed is dropped. `custom` marks a model the player added by hand (bridge/custom-models.mjs); `needMiB` is the graphics memory it needs.
local function localModelList(value)
    local list = {}
    if type(value) ~= 'table' then return list end
    for _, entry in ipairs(value) do
        if #list >= 24 then break end
        if type(entry) == 'table' and validModelId(entry.id) and entry.id ~= 'auto'
            and type(entry.name) == 'string' and entry.name ~= '' and #entry.name <= 80 and not entry.name:find('[%c]') then
            local size = type(entry.sizeMiB) == 'number' and entry.sizeMiB >= 0 and entry.sizeMiB < 1000000 and entry.sizeMiB or 0
            local need = type(entry.needMiB) == 'number' and entry.needMiB >= 0 and entry.needMiB < 1000000 and entry.needMiB or 0
            list[#list + 1] = {id = entry.id, name = entry.name, sizeMiB = math.floor(size), custom = entry.custom == true,
                needMiB = math.floor(need), tooLarge = entry.custom == true and entry.tooLarge == true}
        end
    end
    table.sort(list, function(a, b)
        if a.sizeMiB ~= b.sizeMiB then return a.sizeMiB < b.sizeMiB end
        local x, y = a.name:lower(), b.name:lower()
        if x ~= y then return x < y end
        return a.id < b.id
    end)
    return list
end

-- An id the bridge names as a model to select (localModelDefault, localModelMatureDefault) when that model is in the published list; else nil.
local function listedModelId(value, list)
    if not validModelId(value) then return nil end
    for _, model in ipairs(list) do if model.id == value then return value end end
    return nil
end

-- The custom models that cannot be used ([{name, reason}], reason one of the codes below); anything else is dropped.
local customProblemReasons = {missing = true, ['bad-gguf'] = true, embedding = true, unreadable = true}
local function localModelProblemList(value)
    local list = {}
    if type(value) ~= 'table' then return list end
    for _, entry in ipairs(value) do
        if #list >= 8 then break end
        if type(entry) == 'table' and customProblemReasons[entry.reason] and type(entry.name) == 'string' and entry.name ~= ''
            and #entry.name <= 80 and not entry.name:find('[%c]') then
            list[#list + 1] = {name = entry.name, reason = entry.reason}
        end
    end
    return list
end

-- The model a saved Local AI choice stands for when that model left its pack (a Mature model of an older pack, a removed standard model): the
-- bridge's own mapping (bridge/local-model-choice.mjs), `localModelMatureDefault` for a `mature:` id (the Mature pack's good model if it fits,
-- else its lite one), `localModelDefault` for any other. nil for `auto`, a model the player added (`custom:`, announced by the bridge), a model
-- that is listed, no list yet, or no listed replacement. Reads the raw bridge state: never errors on a malformed one.
local function goneLocalModelReplacement(id, state)
    if type(id) ~= 'string' or id == 'auto' or id:find('^custom:') or not validModelId(id) then return nil end
    local list = type(state) == 'table' and state.localModels or nil
    if type(list) ~= 'table' or #list == 0 then return nil end
    local function listed(value)
        if not validModelId(value) then return false end
        for _, entry in ipairs(list) do if type(entry) == 'table' and entry.id == value then return true end end
        return false
    end
    if listed(id) then return nil end
    local target
    if id:find('^mature:') then target = state.localModelMatureDefault else target = state.localModelDefault end
    if listed(target) then return target end
    return nil
end

function M.mistral()
    updateMistral()
    local state = mistralState
    local result = type(state.result) == 'table' and state.result.id == mistralCommand and state.result.state or nil
    local tail = type(state.tail) == 'string' and #state.tail <= 8 and state.tail or nil
    local model = type(state.model) == 'string' and #state.model <= 80 and state.model:match('^[%w%.%-_:/]+$') and state.model or nil
    local inworld = type(state.inworld) == 'table' and state.inworld or {}
    local inworldResult = type(inworld.result) == 'table' and inworld.result.id == inworldCommand and inworld.result.state or nil
    local inworldTail = type(inworld.tail) == 'string' and #inworld.tail <= 8 and inworld.tail or nil
    local localModels = localModelList(state.localModels)
    return {provider = providerName(state.provider),
        inworld = {saved = inworld.saved == true, tail = inworldTail, result = mistralResults[inworldResult] and inworldResult or nil},
        effective = providerName(state.effective),
        localAi = localAiStates[state.localAi] and state.localAi or nil,
        -- Why a failed Local AI could not start, when the settings page can say what to do: 'mature-off' (only Mature models, Mature content off).
        localReason = state.localReason == 'mature-off' and 'mature-off' or nil,
        maturePack = state.maturePack == true,
        localModels = localModels,
        -- The model shown as selected when none was chosen (the largest that fits), and the one turning Mature content on selects.
        localModelDefault = listedModelId(state.localModelDefault, localModels),
        localModelMatureDefault = listedModelId(state.localModelMatureDefault, localModels),
        localModelProblems = localModelProblemList(state.localModelProblems),
        saved = state.saved == true, tail = tail, pending = state.pending == true,
        result = mistralResults[result] and result or nil,
        limit = mistralLimits[state.limit] and state.limit or nil, model = model, stt = state.stt == true}
end

-- What is loading right now, for the loading notices (convaiNotices.loading in notices.lua). A table key -> state:
--   omni, pocket   the local voice engine the player chose: 'loading' while its model loads (the bridge's state 'loading'; its
--                  'warming' and 'speaking' are per-character work after the load), 'ready' once it is up, 'error' on a failure
--                  that has no fallback (a fallback has its own notice, so it ends the loading line quietly)
--   local-ai       'loading' while the model server warms up, 'ready', or 'failed' / 'no-memory'; only read while Local is the
--                  chosen conversation provider
-- Nothing is read from disk here for the voices (updateLocalVoice has decoded the bridge's file already); runtime/mistral-state.json
-- is read through updateMistral (at most every 1.5 s) and only while Local is chosen. The table is reused; callers read it at once.
local loadSignals = {}
function M.loadStatus()
    local signals = loadSignals
    signals.omni, signals.pocket, signals['local-ai'] = nil, nil, nil
    local voice = localVoiceState
    local engine = voice.workerBackend
    if (engine == 'omni' or engine == 'pocket') and voice.requestedProvider == engine then
        local phase = voice.state
        if phase == 'loading' then signals[engine] = 'loading'
        elseif phase == 'ready' or phase == 'warming' or phase == 'speaking' then signals[engine] = 'ready'
        elseif phase == 'error' and type(voice.fallback) ~= 'table' then signals[engine] = 'error' end
    end
    if settings and settings.conversationProvider == 'local' then
        updateMistral()
        local localAi = mistralState.localAi
        if localAi == 'warming' then signals['local-ai'] = 'loading'
        elseif localAi == 'ready' then signals['local-ai'] = 'ready'
        elseif localAi == 'failed' or localAi == 'no-memory' then signals['local-ai'] = localAi end
    end
    return signals
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
-- Convai 'convai', the Mistral cloud voice (Voxtral) 'voxtral', the Inworld cloud voice 'inworld'. Any Pocket variant name resolves to the one Pocket TTS entry.
-- A save from before the short/long choice has no omniReference and migrates to
-- 'long': whoever chose OmniVoice chose quality, and long is the better match.
local function normalizeVoiceProvider(value)
    if type(value) ~= 'string' then return DEFAULT_VOICE_PROVIDER end
    local name = value:lower()
    if name == 'convai' or name == 'voxtral' or name == 'inworld' then return name end
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
    do
        local volume = cleanVoiceVolume(settings.voiceVolume)
        if volume == nil or volume ~= settings.voiceVolume then
            settingsNeedSave = settingsNeedSave or settings.voiceVolume ~= nil
            settings.voiceVolume = volume or voiceVolume.default
        end
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
    -- Off by default: conversations use Convai free tier until the player chooses "Convai API key" in the Conversation provider
    -- selector, which is this value (bridge/convai-key.mjs). There is no switch of its own any more.
    if type(settings.useOwnConvaiKey) ~= 'boolean' then settings.useOwnConvaiKey, settingsNeedSave = false, true end
    -- The old "Use my own Convai API key" switch became that selector entry. A saved switch that is on with no key saved becomes
    -- "Convai free tier" (once: a key status the bridge has not published yet decides nothing; with a key the choice stands as it is).
    -- Mistral and Local stay as they were: the switch only matters again when the player goes back to Convai.
    if settings.convaiProviderChoice ~= true then
        local keyState = readJSON('runtime/own-key-state.json')
        if type(keyState) == 'table' then
            if settings.useOwnConvaiKey == true and keyState.saved ~= true then settings.useOwnConvaiKey = false end
            settings.convaiProviderChoice, settingsNeedSave = true, true
        end
    end
    -- Who writes the replies: 'convai' (default), 'mistral' (the player's own Mistral key) or 'local' (the optional Local AI pack, on this
    -- computer). Any other saved value is Convai, a saved 'groq' (an option that was removed) included, as in the bridge. The bridge reads
    -- this from settings.json and applies it when no conversation is running.
    if settings.conversationProvider ~= 'convai' and settings.conversationProvider ~= 'mistral'
        and settings.conversationProvider ~= 'local' then
        settings.conversationProvider, settingsNeedSave = 'convai', true
    end
    if type(settings.battleReactions) ~= 'boolean' then settings.battleReactions, settingsNeedSave = false, true end
    if type(settings.lootReactions) ~= 'boolean' then settings.lootReactions, settingsNeedSave = false, true end
    -- On by default (a missing key); an explicitly saved choice is kept.
    if type(settings.bodyGestures) ~= 'boolean' then settings.bodyGestures, settingsNeedSave = true, true end
    -- On by default (a missing key); an explicitly saved choice is kept.
    if type(settings.autoConnectNearby) ~= 'boolean' then settings.autoConnectNearby, settingsNeedSave = true, true end
    -- Experimental, on by default (a missing key): the live picture in a holocall (mod/holocall.lua). The first version
    -- saved false as its default, so a saved false counts only once the player has set it (an Apply that carried it,
    -- holocallLiveImageChosen); an unchosen false becomes the default, true.
    if type(settings.holocallLiveImageChosen) ~= 'boolean' then settings.holocallLiveImageChosen = false end
    if type(settings.holocallLiveImage) ~= 'boolean' or (not settings.holocallLiveImage and not settings.holocallLiveImageChosen) then
        settings.holocallLiveImage, settingsNeedSave = true, true
    end
    -- On by default: recent subtitled game dialogue is attached to the next manual turn (mod/game-dialogue.lua).
    if type(settings.gameDialogueContext) ~= 'boolean' then settings.gameDialogueContext, settingsNeedSave = true, true end
    -- Off by default: the decision ledger (docs/QUEST_DECISIONS.md section 4.4) records V's picked dialogue options. Not proven in game; no menu entry.
    if type(settings.decisionLedger) ~= 'boolean' then settings.decisionLedger, settingsNeedSave = false, true end
    -- Off by default: witness receipts (section 4.3) let a companion who stood beside V hear `witnessed` rules. No menu entry.
    if type(settings.witnessReceipts) ~= 'boolean' then settings.witnessReceipts, settingsNeedSave = false, true end
    if not isChoice(settings.eyeContactHeight, eyeContactHeights) then
        settings.eyeContactHeight, settingsNeedSave = 0, true
    end
    if not isChoice(settings.headFollowStrength, headFollowStrengths) then
        settings.headFollowStrength, settingsNeedSave = 1, true
    end
    local provider = normalizeVoiceProvider(settings.voiceProvider)
    -- The Inworld cloud voice is listed only in developer mode (Settings > Development); without it a saved Inworld voice is Pocket TTS.
    if provider == 'inworld' and settings.developerMode ~= true then provider = 'pocket' end
    if provider ~= settings.voiceProvider then settings.voiceProvider, settingsNeedSave = provider, true end
    if settings.omniSteps ~= 16 and settings.omniSteps ~= 32 then
        settings.omniSteps, settingsNeedSave = DEFAULT_OMNI_STEPS, true
    end
    if settings.omniReference ~= 'short' and settings.omniReference ~= 'long' then
        settings.omniReference, settingsNeedSave = DEFAULT_OMNI_REFERENCE, true
    end
    -- Prepared voices are always kept (there is no switch for it any more): a saved false from an older settings file is ignored.
    if settings.keepPreparedVoices ~= true then settings.keepPreparedVoices, settingsNeedSave = true, true end
    -- On by default: unnamed gang members, police, vendors and residents can be talked to (docs/NPC_ARCHETYPES.md).
    if type(settings.archetypeConversations) ~= 'boolean' then settings.archetypeConversations, settingsNeedSave = true, true end
    -- Off by default: the game's own named characters can be talked to where they stand once the player turns it on (docs/WORLD_CHARACTERS.md).
    if type(settings.storyConversations) ~= 'boolean' then settings.storyConversations, settingsNeedSave = false, true end
    -- Off by default: Johnny answers the talk keys as the voice in V's head while the story has him there (docs/JOHNNY_IN_YOUR_HEAD.md).
    if type(settings.johnnyInHead) ~= 'boolean' then settings.johnnyInHead, settingsNeedSave = false, true end
    -- Off by default: how often Johnny speaks up unprompted (docs/JOHNNY_IN_YOUR_HEAD.md, phase 2): off, rare or normal.
    if settings.johnnyRemarks ~= 'off' and settings.johnnyRemarks ~= 'rare' and settings.johnnyRemarks ~= 'normal' then
        settings.johnnyRemarks, settingsNeedSave = 'off', true
    end
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
    -- The retired Companions can see setting (docs/COMPANION_VISION.md): vision is always on with Convai now. An old saved key is
    -- dropped; the bridge ignores it either way.
    if settings.companionVision ~= nil then settings.companionVision, settingsNeedSave = nil, true end
    -- Mature content (off by default): lets the Local AI provider write adult language and themes. Read by the bridge on change only.
    if type(settings.matureContent) ~= 'boolean' then settings.matureContent, settingsNeedSave = false, true end
    -- Mature content and a cloud provider (Convai free tier, Convai API key, Mistral) exclude each other: a saved pairing (an older
    -- save, which showed "no effect yet" for it) comes back with Mature content off.
    if settings.matureContent == true and settings.conversationProvider ~= 'local' then settings.matureContent, settingsNeedSave = false, true end
    -- Which installed Local AI model loads: one model's id. 'auto' means none chosen yet (or a value an older version saved): the bridge then
    -- loads the largest model that fits the free graphics memory, the settings page shows that model as selected, and the next Apply saves its
    -- id. The bridge falls back to the same model, with one notice, when the chosen one is missing, does not fit or does not start.
    if not validModelId(settings.localModel) then settings.localModel, settingsNeedSave = 'auto', true end
    -- What turning Mature content on changed (provider, model, voice), so turning it off can put them back (see cleanMatureRestore).
    -- Only meaningful while Mature content is on.
    do
        local restore = cleanMatureRestore(settings.matureRestore)
        if settings.matureContent ~= true then restore = nil end
        if restore == nil and settings.matureRestore ~= nil then settingsNeedSave = true end
        settings.matureRestore = restore
    end
    -- Multilingual conversations (off by default): conversations go to each character's multilingual twin. Pocket TTS
    -- speaks only English, so a saved pairing with it cannot stand (Apply never makes one): the voice moves to the cloud
    -- voice, which every installation can run. With the cloud voice, Multilingual wins over the two tag settings.
    if type(settings.multilingualConversations) ~= 'boolean' then settings.multilingualConversations, settingsNeedSave = false, true end
    if settings.multilingualConversations and (settings.voiceProvider == 'pocket' or settings.voiceProvider == 'voxtral' or settings.voiceProvider == 'inworld') then
        settings.voiceProvider, settingsNeedSave = 'convai', true
    end
    -- A saved cloud voice with a tag setting on (an older save): the voice is kept and the tag settings are turned off,
    -- with Multilingual conversations on or off alike. Apply never writes this pairing.
    if (settings.naturalSpeech or settings.expressiveEmotions) and settings.voiceProvider == 'convai' then
        settings.naturalSpeech, settings.expressiveEmotions, settingsNeedSave = false, false, true
    end
    -- V's voice for typed lines (on by default, key vVoice): the bridge speaks what the player types in V's cloned voice. Only an
    -- explicit false (the player turned it off) is kept off. Which engine speaks it is its own setting (vVoiceEngine: 'pocket', the default,
    -- or 'voxtral'), whatever voice the companions use, so the Convai cloud voice no longer makes the setting inactive.
    -- The first version saved false as its default, so a saved false counts only once the player has set it themselves (an Apply that
    -- carried it, vVoiceChosen); an unchosen false becomes the default, true (the pattern of holocallLiveImage above).
    if type(settings.vVoiceChosen) ~= 'boolean' then settings.vVoiceChosen = false end
    if type(settings.vVoice) ~= 'boolean' or (not settings.vVoice and not settings.vVoiceChosen) then settings.vVoice, settingsNeedSave = true, true end
    if settings.vVoiceEngine ~= 'pocket' and settings.vVoiceEngine ~= 'voxtral' then settings.vVoiceEngine, settingsNeedSave = 'pocket', true end
    -- Mature content keeps the player's words off the cloud: a saved Voxtral engine beside it (hand-edited) is Pocket.
    if settings.matureContent == true and settings.vVoiceEngine == 'voxtral' then settings.vVoiceEngine, settingsNeedSave = 'pocket', true end
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
        -- loadSettings falls back to the backup when settings.json is unreadable, so then the backup is the only good copy and must not be
        -- removed to make room: it takes the file's place first, and the steps below find an ordinary good file (a failure or a crash at
        -- any step leaves settings.json or the backup with the settings in it).
        if not readJSON(target) and readJSON(backup) then
            if not os.remove(target) or not os.rename(backup, target) then return false end
        end
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

-- A saved Local AI model that left its pack is replaced by the one the bridge maps it to (the Mature pack's good model, else its lite one, for a
-- Mature model; the default model otherwise) and saved at once, silently, so the page and the file agree. Runs only when the bridge's state file was
-- read again (at most every 1.5 s, never per frame) and does nothing but compare two strings while the choice is valid; a failed save is not retried.
local goneModelSaveFailed = false
repairGoneLocalModel = function()
    if goneModelSaveFailed or not settings or not settingsLoaded then return end
    local replacement = goneLocalModelReplacement(settings.localModel, mistralState)
    if not replacement then return end
    local previous = settings.localModel
    settings.localModel = replacement
    if not saveSettings() then settings.localModel, goneModelSaveFailed = previous, true end
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

-- Talk to story characters: the game's own named characters answer the talk keys where they stand, with their face and voice
-- only (mod/world-talk.lua). Read on a key press and by the face service at start-up, never per frame.
function M.storyConversations()
    loadSettings()
    return settings.storyConversations == true
end

-- Johnny in your head: the talk keys with nobody in front of V address Johnny Silverhand (mod/johnny-head.lua). Read on a talk key
-- press that found nobody and when the settings page is drawn, never per frame.
function M.johnnyInHead()
    loadSettings()
    return settings.johnnyInHead == true
end

-- Johnny speaks up: 'off', 'rare' or 'normal' (mod/johnny-remarks.lua). Read when a collector hands over an event and on the 0.1 s tick
-- while a remark waits, never per frame.
function M.johnnyRemarks()
    loadSettings()
    return settings.johnnyRemarks == 'rare' and 'rare' or settings.johnnyRemarks == 'normal' and 'normal' or 'off'
end

-- Is Mistral or the Local AI answering conversations right now (the bridge's applied provider)? Asked when a character the player made is
-- looked at or talked to, never per frame: the bridge status is re-read at most once every 1.5 s and nothing else is built.
function M.textProviderActive()
    updateMistral()
    return providerName(mistralState.effective) ~= 'convai'
end

-- Characters the player made (mod/custom-characters.lua) are not in the profile list: they are enabled whenever they exist.
local customKeyOf = function() return false end
function M.configureCustom(isCustom)
    customKeyOf = type(isCustom) == 'function' and isCustom or function() return false end
end

function M.profileEnabled(key)
    loadSettings()
    if key ~= nil and customKeyOf(key) == true then return true end
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
    if provider == 'inworld' then return ui.t('Inworld cloud voice') end
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

-- True when speaking to a companion cannot work right now: the player chose Mistral or Local AI, the bridge says that
-- provider is in use, and this computer cannot recognise speech locally. Asked only when a voice key is pressed (never per
-- frame); the bridge status is re-read at most once every 1.5 s.
function M.voiceNeedsConvai()
    loadSettings()
    local chosen = settings.conversationProvider
    if chosen ~= 'mistral' and chosen ~= 'local' then return false end
    local state = M.mistral()
    return state.effective == chosen and state.stt ~= true
end

-- True when this computer can recognise speech locally (the bridge's recogniser, bridge/local-stt.mjs), whatever the conversation
-- provider is. An add-on speaker (docs/ADDON_API.md) hears V through it, since Convai's own recognition lives in a Convai session.
-- Asked only when a voice key is pressed.
function M.speechRecognitionReady()
    return M.mistral().stt == true
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

-- On by default. On, what the player types is also spoken aloud in V's own voice (male or female V), cloned by V's own voice engine
-- (vVoiceEngine: Pocket by default, or Voxtral), whatever voice the companions use. Typed lines only; push-to-talk never replays V.
function M.vVoice()
    loadSettings()
    return settings.vVoice == true
end

-- V's voice engine: 'pocket' (default) or 'voxtral'.
function M.vVoiceEngine()
    loadSettings()
    return settings.vVoiceEngine == 'voxtral' and 'voxtral' or 'pocket'
end

-- The setting is on, so a real V line can follow a typed turn. Used to skip work that only a real V line needs (the game-side read of the
-- dialogue volume). It no longer depends on the companions' voice: V's engine is its own choice.
function M.vVoiceActive()
    loadSettings()
    return settings.vVoice == true
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
    if values.voiceProvider ~= nil and after.voiceProvider == 'inworld' then
        result.error = ui.t('The Inworld cloud voice speaks only English here. Turn off Multilingual conversations to choose it.')
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

-- Experimental, on by default: a holocall shows a live picture of the character instead of the portrait
-- (mod/holocall.lua, docs/HOLOCALL.md). Read once per call, when it starts.
function M.holocallLiveImage()
    loadSettings()
    return settings.holocallLiveImage == true
end

-- On by default: a character addressed right after the game's own dialogue with them knows the last lines that
-- were said (docs/GAME_DIALOGUE_CONTEXT.md). Off, no game dialogue is recorded or sent.
function M.gameDialogueContext()
    loadSettings()
    return settings.gameDialogueContext == true
end

-- Off by default (settings.json `decisionLedger`): V's picked dialogue options are kept and written to runtime/decision-ledger.json.
function M.decisionLedger()
    loadSettings()
    return settings.decisionLedger == true
end

-- Off by default (settings.json `witnessReceipts`): the quest edges a world scan sees are stamped with who stood beside V and written to
-- runtime/witness-receipts.json (mod/witness-receipts.lua).
function M.witnessReceipts()
    loadSettings()
    return settings.witnessReceipts == true
end

-- Read by the ordinary companion update, never by a native menu callback.
-- Applying settings only persists this policy; the actuator replaces its exact
-- owned look request after gameplay resumes, without changing a movement ticket.
function M.gazeSettings()
    loadSettings()
    return {eyeContactHeight = settings.eyeContactHeight, headFollowStrength = settings.headFollowStrength}
end

function M.audioDelayChoices() return audioDelays end
function M.voiceVolumeRange() return voiceVolume end

-- The Local AI model row's choices: every installed model the bridge reported (by its manifest name), smallest file first. No Auto entry. Each is
-- {id, name, sizeMiB, custom, needMiB, tooLarge}; empty while no model is installed.
function M.localModelChoices()
    local choices = {}
    for _, model in ipairs(M.mistral().localModels) do choices[#choices + 1] = model end
    return choices
end

-- The id of the model the row shows as selected while none was chosen (the largest that fits the free graphics memory), or nil.
function M.localModelDefaultId() return M.mistral().localModelDefault end

-- The id of the model turning Mature content on selects (the largest uncensored one that fits), or nil when there is none.
function M.localModelMatureId() return M.mistral().localModelMatureDefault end

-- The custom models the bridge could not use: [{name, reason}] (docs/LOCAL_AI.md, "Add your own model"); shown in the Local AI model row's help.
function M.localModelProblems() return M.mistral().localModelProblems end

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
    -- invite = false: another mod owns this character's body (Night City Allies' Lucy and Rita, docs/NCA_FOLLOWERS_PLAN.md).
    -- Her records only let the talk path recognise that mod's copy; we never spawn one of our own from the menus.
    if profile.invite == false then return nil end
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

-- The bridge rewrites local-voice-state.json (4-32 KB of voice metrics) every 5 s and on a change; this reads it
-- every 2 s. Identical text is the same state, so it is decoded once, not on every read (a decode of that size is
-- a 1-40 ms frame and a burst of garbage). A copy that has gone stale keeps the stale mark below: only a changed
-- file can make it fresh again.
local voiceStateRaw, voiceStateValue
local function readLocalVoiceState()
    local file = io.open('runtime/local-voice-state.json', 'rb')
    if not file then voiceStateRaw, voiceStateValue = nil, nil; return nil end
    local raw = file:read('*a'); file:close()
    if raw ~= nil and raw == voiceStateRaw and voiceStateValue ~= nil then return voiceStateValue end
    local ok, value = pcall(json.decode, raw)
    value = ok and type(value) == 'table' and value or nil
    voiceStateRaw, voiceStateValue = raw, value
    return value
end

local function updateLocalVoice()
    local state = readLocalVoiceState() or {}
    local fresh = type(state.updated) == 'number' and math.abs(os.time() - state.updated / 1000) < 15
    localVoices = {}
    if not fresh then state.state, state.routedProfiles = 'waiting', {} end
    for _, key in ipairs(state.routedProfiles or {}) do
        if type(key) == 'string' and byKey[key] then localVoices[key] = true end
    end
    -- cloudVoice is in it: Voxtral and Inworld both report 'remote' on the Pocket route, and the status row names which one speaks.
    local signature = tostring(state.provider) .. ':' .. tostring(state.state) .. ':' .. tostring(state.steps)
        .. ':' .. tostring(state.routeRevision) .. ':' .. tostring(state.cloudVoice)
    -- The bridge reports a fallback only after it committed the lower voice.
    -- Tell the player once per fallback; the mark clears when the fallback ends.
    local fallback = state.fallback
    if fresh and type(fallback) == 'table' and (fallback.from == 'omni' or fallback.from == 'pocket' or fallback.from == 'voxtral' or fallback.from == 'inworld')
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
        if localVoices[profile.key] and (localVoiceState.cloudVoice == 'voxtral' or localVoiceState.cloudVoice == 'inworld') then
            body = body .. '\nVoice: ' .. M.voiceLabel(localVoiceState.cloudVoice)
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
            holocallLiveImage = settings.holocallLiveImage,
            gameDialogueContext = settings.gameDialogueContext,
            decisionLedger = settings.decisionLedger,
            witnessReceipts = settings.witnessReceipts,
            eyeContactHeight = settings.eyeContactHeight,
            headFollowStrength = settings.headFollowStrength,
            audioDelay = settings.audioDelay,
            voiceVolume = settings.voiceVolume,
            voiceProvider = settings.voiceProvider,
            omniSteps = settings.omniSteps,
            omniReference = settings.omniReference,
            keepPreparedVoices = settings.keepPreparedVoices,
            naturalSpeech = settings.naturalSpeech,
            expressiveEmotions = settings.expressiveEmotions,
            followUpInterest = settings.followUpInterest,
            vVoice = settings.vVoice == true,
            vVoiceEngine = settings.vVoiceEngine == 'voxtral' and 'voxtral' or 'pocket',
            -- Part of the main mod: off by default, Local AI only. The optional Mature pack (uncensored models) only changes the help text.
            matureContent = settings.matureContent == true,
            matureRestore = cleanMatureRestore(settings.matureRestore),
            localModel = validModelId(settings.localModel) and settings.localModel or 'auto',
            multilingualConversations = settings.multilingualConversations,
            archetypeConversations = settings.archetypeConversations,
            storyConversations = settings.storyConversations == true,
            johnnyInHead = settings.johnnyInHead == true,
            johnnyRemarks = M.johnnyRemarks(),
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
        if key == 'holocallLiveImage' then nextSettings.holocallLiveImageChosen = true end
        if key == 'vVoice' then nextSettings.vVoiceChosen = true end
        if key == 'voice' or key == 'subtitles' or key == 'developerMode' or key == 'useOwnConvaiKey'
            or key == 'battleReactions' or key == 'lootReactions' or key == 'bodyGestures' or key == 'autoConnectNearby'
            or key == 'holocallLiveImage'
            or key == 'gameDialogueContext' or key == 'decisionLedger' or key == 'witnessReceipts'
            or key == 'naturalSpeech' or key == 'expressiveEmotions'
            or key == 'followUpInterest' or key == 'vVoice' or key == 'multilingualConversations' then
            if type(value) ~= 'boolean' then return false, 'This setting must be on or off.' end
            nextSettings[key] = value
        elseif key == 'matureContent' then
            if type(value) ~= 'boolean' then return false, 'This setting must be on or off.' end
            nextSettings.matureContent = value
        elseif key == 'matureRestore' then
            -- What turning Mature content on changed (mod/mcm.lua), kept so turning it off can put it back; false clears it.
            if value ~= false and cleanMatureRestore(value) == nil then return false, 'Invalid Mature content settings.' end
            nextSettings.matureRestore = value and cleanMatureRestore(value) or nil
        elseif key == 'localModel' then
            if not validModelId(value) then return false, 'Choose one of the listed Local AI models.' end
            nextSettings.localModel = value
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
        elseif key == 'storyConversations' then
            if type(value) ~= 'boolean' then return false, 'This setting must be on or off.' end
            nextSettings.storyConversations = value
        elseif key == 'johnnyInHead' then
            if type(value) ~= 'boolean' then return false, 'This setting must be on or off.' end
            nextSettings.johnnyInHead = value
        elseif key == 'johnnyRemarks' then
            if value ~= 'off' and value ~= 'rare' and value ~= 'normal' then return false, 'Choose how often Johnny speaks up.' end
            nextSettings.johnnyRemarks = value
        elseif key == 'conversationProvider' then
            if value ~= 'convai' and value ~= 'mistral' and value ~= 'local' then return false, 'Choose one of the listed conversation providers.' end
            nextSettings.conversationProvider = value
        elseif key == 'audioDelay' then
            if not isChoice(value, audioDelays) then return false, 'Choose one of the listed lip sync delays.' end
            nextSettings.audioDelay = value
        elseif key == 'voiceVolume' then
            local volume = cleanVoiceVolume(value)
            if not volume then return false, 'Choose a voice volume from 50 to 200 percent.' end
            nextSettings.voiceVolume = volume
        elseif key == 'subtitleStyle' then
            if value ~= 'overhead' and value ~= 'dialogue' then return false, 'Choose one of the listed subtitle displays.' end
            nextSettings.subtitleStyle = value
        elseif key == 'uiLanguage' then
            if value ~= 'auto' and not isChoice(value, ui.supported()) then return false, ui.t('Choose an interface language.') end
            nextSettings.uiLanguage = value
        elseif key == 'voiceProvider' then
            if value == 'hybrid' then value = 'omni' end
            if value ~= 'pocket' and value ~= 'omni' and value ~= 'convai' and value ~= 'voxtral' and value ~= 'inworld' then
                return false, 'Choose one of the listed companion voices.'
            end
            -- The Mistral cloud voice speaks with the player's Mistral key (the same one the text replies use).
            if value == 'voxtral' and not M.mistral().saved then return false, VOXTRAL_KEY_MISSING end
            -- The Inworld cloud voice speaks with the player's own Inworld key (its own key, pasted in Settings > Development).
            if value == 'inworld' and not (M.mistral().inworld or {}).saved then return false, INWORLD_KEY_MISSING end
            -- An OmniVoice choice cannot be saved while the optional pack is missing; the choice never takes effect.
            if value == 'omni' and not M.omniPack().installed then return false, OMNI_PACK_MISSING end
            nextSettings.voiceProvider = value
        elseif key == 'vVoiceEngine' then
            if not isChoice(value, V_VOICE_ENGINES) then return false, 'Choose one of the listed voices for V.' end
            -- The Mistral cloud voice speaks with the player's Mistral key (the same one the text replies and the companions' Voxtral use).
            if value == 'voxtral' and not M.mistral().saved then return false, VOXTRAL_KEY_MISSING end
            nextSettings.vVoiceEngine = value
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
    -- Mature content needs Local AI: with a cloud provider in the saved result it is off (the page already stages that; this keeps
    -- any other caller to the same rule). The Inworld voice goes with developer mode: turning that off leaves Pocket TTS.
    -- Both change what an open page shows, so the caller is asked to reload it quietly.
    local rulesReload = false
    if nextSettings.matureContent == true and nextSettings.conversationProvider ~= 'local' then
        nextSettings.matureContent, rulesReload = false, true
    end
    if nextSettings.voiceProvider == 'inworld' and nextSettings.developerMode ~= true then
        nextSettings.voiceProvider, rulesReload = 'pocket', true
    end
    -- Mature content keeps the player's words off the cloud: V's line is never spoken by Voxtral beside it. Choosing Voxtral while it is
    -- on is refused; turning it on moves V to Pocket (the page reloads to show it).
    if nextSettings.matureContent == true and nextSettings.vVoiceEngine == 'voxtral' then
        if values.vVoiceEngine == 'voxtral' and values.matureContent ~= true then return false, V_ENGINE_MATURE end
        nextSettings.vVoiceEngine, rulesReload = 'pocket', true
    end
    if nextSettings.developerMode ~= settings.developerMode then rulesReload = true end
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
    -- No model chosen yet (or the value an older version saved, 'auto'): the row showed the default model as selected, so Apply saves its id.
    -- Silent. Without a default (no model installed) the value stays 'auto' and the bridge keeps loading the largest model that fits.
    if nextSettings.localModel == 'auto' then
        local default = M.localModelDefaultId()
        if default then nextSettings.localModel = default end
    else
        -- A model that left its pack (not one the player added): Apply saves the model the bridge maps it to, silently (see repairGoneLocalModel).
        local replacement = goneLocalModelReplacement(nextSettings.localModel, mistralState)
        if replacement then nextSettings.localModel = replacement end
    end
    -- The record of what Mature content changed belongs to the time it is on: turning it off drops it, and turning it on
    -- without one (nothing was changed for it) leaves none.
    if nextSettings.matureContent ~= true or (settings.matureContent ~= true and values.matureRestore == nil) then
        nextSettings.matureRestore = nil
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
    return true, nil, nil, cloudQuiet == true or rulesReload
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
