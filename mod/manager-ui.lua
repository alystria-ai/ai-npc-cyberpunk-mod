-- Companion Manager pages, actions and settings, with no knowledge of the screen that shows them. mod/nsui.lua is the host: it puts
-- the pages built here into Native Settings UI and turns a widget change or a button press back into the calls below. Everything a
-- page shows is a row of one of four kinds (the same shapes the pages always had, so a row added for a provider is one more
-- `setting(...)`, `action(...)` or `readonly(...)` call and needs nothing from the host):
--   setting  type bool | select | int   a change is applied through M.apply (one validated transaction, manager.applySettings)
--   action   type action                a button: its text is `value`; M.invoke runs it
--   readonly type string                a line of text: `label` and `value`
-- Nothing here runs per frame: M.update does a few comparisons, and the page is built when it opens or when something it shows changes.
local M = {}
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
local LABEL = 'Companion Manager'
-- Rows per page of a long list (the characters to invite, the model browser, the memory picker and a large party). The pages are
-- read with one slider; a list never puts more than this many widgets on the screen.
local PAGE_SIZE = 12
local manager, queue
-- view: the page shown. listPage / listGroup: the page of its long list and the letter group of the model browser.
local view, listPage, listGroup = 'home', 1, 1
local actions, disabledActions, refreshQueued = {}, {}, false
local owner, lastSignature, pollAt, snapshotAt = nil, '', 0, 0
-- What the page that is on screen was built from (pageSignature) and what the last once-a-second look found. The page is drawn again
-- when they differ, or when something forces it (refreshQueued: a language change, an action, a new save ...).
local renderedSignature = ''
local lastError = ''
local actionFeedback, memoryActionCommand
local preparationTarget, preparationStatus, preparationActionFeedback
local preparationAt = 0
-- Everything that does not need a frame runs on this tick (see M.update). A queue change, a session reset and the return to
-- gameplay run it on the next frame.
local SLOW_PERIOD = 0.25
local slowAt, flushDue, lastWorldReady = 0, false, nil
local localeRevision = -1
-- The Companion voices list (menu order): Pocket TTS, the Mistral cloud voice (Voxtral), OmniVoice 16/32 steps with a short or long reference, the other cloud voices.
local voicePreviewModule = dofile('voice-preview.lua')
local VOICE_CHOICES = voicePreviewModule.CHOICES
-- The Companion voices list of the page on screen: how many entries it has and their texts.
local voiceMenuSize, voiceLabelsShown = 0, {}
-- The entries of that list that cannot be chosen now (OmniVoice while its pack is missing), by position: M.apply refuses them. A host
-- that can grey an entry out reads them from the row (`disabledElements`).
local voiceDisabledShown = {}
-- Help page: log locations and the shareable support report. Optional: the manager works without it, and a load failure only hides
-- the Help entry.
local support, supportSignature
local supportLoaded, supportFactory = pcall(dofile, 'support-report.lua')
-- Setup check (mod/setup-check.lua): the first section of the Help page and the first-load notice. Optional too; read through its
-- global convaiSetupCheck, so no function here gains an upvalue (LuaJIT limits them).
pcall(dofile, 'setup-check.lua')
-- Edit characters: opens the character editor page in the player's browser. Optional like Help: without it the row is not shown.
local editor
local editorLoaded, editorFactory = pcall(dofile, 'character-editor.lua')
-- Convai paid tier (docs/CONVAI_PAID_TIER.md): its own page under Settings > Conversation provider. Optional like Help: without the file
-- the entry is not shown. paidNotice: the notice of a confirmed (or unconfirmed) purchase, held until gameplay.
local paidTier, paidNotice
-- The status text of the paid tier page. `paidStatus` is the text of the latest paid tier action, kept up to date while that action's
-- answer is awaited (`paidStatusUntil`: the os.clock() time it stops looking, at most seven minutes), then left.
local paidStatus, paidStatusUntil
local paidTierLoaded, paidTierFactory = pcall(dofile, 'convai-paid-tier.lua')
-- Custom (OpenAI-compatible) provider (mod/custom-provider.lua): everything about it except drawing its rows. Optional like Help:
-- without the file its rows and notes are not shown. `factory` is what the file returned (or the error text), `instance` is made in
-- M.configure.
local customProvider = {factory = select(2, pcall(dofile, 'custom-provider.lua'))}
local log = function(message)
    local file = io.open('runtime/mcm.log', 'a')
    if file then file:write(os.date('!%Y-%m-%dT%H:%M:%SZ'), ' ', message, '\n'); file:close() end
    print('[CyberpunkConvai] ' .. message)
end

-- The slow components whose loading is announced (convaiNotices.loading, mod/notices.lua), in the order their lines show, and the
-- line of each state. A state other than 'loading' and 'ready' is a failure: the line says what to do.
-- The prep keys are the companions still being prepared (invitation board, manager-party.lua waiting()): one line each, in the
-- same notice, with the text of what each waits for ("Preparing Evelyn: waiting for the voice model to load…"). They are
-- loading until the companion has spawned or failed (a failure is its own notice) and have no ready line: "joined" is that.
local PREP_KEYS = {'prep1', 'prep2', 'prep3'}
local LOAD_KEYS = {'omni', 'pocket', 'local-ai', 'prep1', 'prep2', 'prep3'}
local prepText, prepRevisions, loadBoard = {}, {}, nil
local function loadingText(key, state)
    if prepText[key] then return prepText[key] end
    if key == 'omni' then
        if state == 'loading' then return ui.t('Loading the OmniVoice voice…') end
        if state == 'ready' then return ui.t('OmniVoice voice is ready.') end
        return ui.t('OmniVoice could not load. See Help in Settings.')
    elseif key == 'pocket' then
        if state == 'loading' then return ui.t('Loading the Pocket voice…') end
        if state == 'ready' then return ui.t('Pocket voice is ready.') end
        return ui.t('Pocket could not load. See Help in Settings.')
    end
    if state == 'loading' then return ui.t('Local AI is warming up…') end
    if state == 'ready' then return ui.t('Local AI is ready.') end
    if state == 'no-memory' then return ui.t('Not enough free graphics memory to start Local AI. Try a smaller model in Settings.') end
    return ui.t('Local AI could not start. Check Local AI in Settings > Conversation provider.')
end

-- The states the loading notice reads: the slow components (manager.loadStatus) and the companions still being prepared.
-- Read by the notice at most once a second while nothing loads, a few times a second while something does.
local function readLoads()
    local states = manager.loadStatus()
    if type(states) ~= 'table' then states = {} end
    local waiting = loadBoard and type(loadBoard.waiting) == 'function' and loadBoard.waiting() or {}
    for index, key in ipairs(PREP_KEYS) do
        local line = waiting[index]
        states[key] = line and 'loading' or nil
        prepText[key], prepRevisions[key] = line and line.text or nil, line and line.text or nil
    end
    states.revisions = prepRevisions
    return states
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
-- Select options. The value of a select row sits between the game's two arrows in a fixed-width box, and a text that is too wide
-- runs over the arrows. The width is not ours to change (the game's settings widget), so every option is kept within OPTION_BUDGET.
-- optionUnits() is an estimate in "average lowercase letters": narrow letters (i l j t f r . , : ' space) count less, wide ones
-- (m w M W, capitals, digits) more, and a Chinese, Japanese or Korean character counts two.
-- The box holds about 32 of these units (OPTION_BOX_UNITS: the longest entry that is known to fit unfocused, OmniVoice · Ultra
-- Quality · needs Omni pack, is about 36, and the entries seen running over the arrows are about 33 to 41). On a focused row the game
-- also draws a key box over each arrow, an "A" at the left one and a "D" at the right one, and they cover the first and the last
-- letters of the text ("Gemma-4-E4B-MiniFo... (uncensored)" lost both ends). The selector is native, and neither Native Settings UI nor the
-- game scripts that ship with the mod carry its geometry, so the two boxes could not be measured: each is taken as 3 units
-- (KEY_HINT_UNITS). OPTION_BUDGET is what is left for the text between them, so a label fits focused as well as unfocused.
-- Static options are checked in bridge/select-labels.test.mjs; fitOption() is the last resort for a label built at run time (a
-- custom model's own name): it cuts the name, keeps a trailing " (...)" or " · ..." part and ends the name with an ellipsis.
-- Page build only, never per frame.
local OPTION_BOX_UNITS, KEY_HINT_UNITS = 32, 3
local OPTION_BUDGET = OPTION_BOX_UNITS - 2 * KEY_HINT_UNITS
local NARROW, MEDIUM = {}, {}
for letter in ("il.,:;'|!"):gmatch('.') do NARROW[letter] = true end
for letter in ('tfrI()-/[]'):gmatch('.') do MEDIUM[letter] = true end
local function optionUnits(text)
    local units, index, size = 0, 1, #text
    while index <= size do
        local byte = text:byte(index)
        local length = byte < 128 and 1 or byte >= 240 and 4 or byte >= 224 and 3 or byte >= 192 and 2 or 1
        local piece = text:sub(index, index + length - 1)
        if length == 1 then
            if piece == ' ' then units = units + 0.5
            elseif NARROW[piece] then units = units + 0.45
            elseif MEDIUM[piece] then units = units + 0.65
            elseif piece == 'm' or piece == 'w' then units = units + 1.45
            elseif piece == 'M' or piece == 'W' then units = units + 1.6
            elseif piece:find('[A-Z0-9]') then units = units + 1.15
            else units = units + 1 end
        elseif length == 2 then
            units = units + (piece == '·' and 0.65 or 1.05)
        elseif length == 3 then
            local code = (byte - 224) * 4096 + (piece:byte(2) - 128) * 64 + (piece:byte(3) - 128)
            if code >= 0x2E80 then units = units + 2
            elseif piece == '’' then units = units + 0.45
            else units = units + 1 end
        else
            units = units + 2
        end
        index = index + length
    end
    return math.floor(units * 10 + 0.5) / 10
end
-- Whole characters of `text` from the start while the part plus an ellipsis stays within `limit` units.
local function cutToUnits(text, limit)
    local cut, units, index, size = 0, optionUnits('…'), 1, #text
    while index <= size do
        local byte = text:byte(index)
        local length = byte < 128 and 1 or byte >= 240 and 4 or byte >= 224 and 3 or byte >= 192 and 2 or 1
        local after = units + optionUnits(text:sub(index, index + length - 1))
        if after > limit then break end
        units, cut, index = after, index + length - 1, index + length
    end
    return text:sub(1, cut) .. '…'
end
local function fitOption(text)
    text = tostring(text or '')
    if optionUnits(text) <= OPTION_BUDGET then return text end
    local at = text:find(' (', 1, true) or text:find(' ·', 1, true)
    if at and at > 1 then
        local head, tail = text:sub(1, at - 1), text:sub(at)
        local room = OPTION_BUDGET - optionUnits(tail)
        if room >= 8 then return cutToUnits(head, room) .. tail end
    end
    return cutToUnits(text, OPTION_BUDGET)
end
M.OPTION_BUDGET, M.OPTION_BOX_UNITS, M.KEY_HINT_UNITS, M.optionUnits, M.fitOption = OPTION_BUDGET, OPTION_BOX_UNITS, KEY_HINT_UNITS, optionUnits, fitOption
M.cutToUnits = cutToUnits
local function readonly(id, label, value, description, raw)
    raw = raw or {}
    return {id = id, label = raw.label and label or ui.t(label), value = raw.value and value or ui.t(value or ''),
        description = raw.description and description or ui.t(description or ''), type = 'string'}
end

local function setting(id, label, kind, value, default, description, elements, raw)
    raw = raw or {}
    local localized
    if elements then
        localized = {}
        for i, item in ipairs(elements) do localized[i] = fitOption(raw.elements and item or ui.t(item)) end
    end
    return {id = id, label = raw.label and label or ui.t(label), type = kind, value = value, defaultValue = default,
        description = raw.description and description or ui.t(description), elements = localized,
        -- A slider ('int'): raw.min, raw.max and raw.step; the value shows as a number.
        min = raw.min, max = raw.max, step = raw.step}
end

local function action(id, label, value, description, callback, enabled, raw)
    actions[id] = callback
    disabledActions[id] = enabled == false or nil
    raw = raw or {}
    if id:match('^invite:') or id:match('^dismiss:') or id:match('^memory:select:') then raw.label = true end
    local descriptionText = raw.description and description or ui.t(description)
    return {id = id, label = raw.label and label or ui.t(label), value = raw.value and value or ui.t(value),
        description = descriptionText, type = 'action', disabled = enabled == false}
end

local function category(id, name, settings, description)
    return {id = id, name = ui.t(name), description = ui.t(description or ''), settings = settings}
end

-- Moves to another page of the manager. Its long list starts at the first page, and the line of the last action is dropped.
local function navigate(nextView)
    view, listPage, listGroup = nextView, 1, 1
    actionFeedback, preparationActionFeedback = nil, false
    refreshQueued = true
    return true
end

-- The page of a long list that is on screen: first and last item of the page (1-based, inclusive) and the number of pages.
local function pageRange(count)
    local pages = math.max(1, math.ceil(count / PAGE_SIZE))
    listPage = math.max(1, math.min(listPage, pages))
    return (listPage - 1) * PAGE_SIZE + 1, math.min(listPage * PAGE_SIZE, count), pages
end

local function shortName(name)
    name = tostring(name or '')
    if optionUnits(name) <= 14 then return name end
    return cutToUnits(name, 14)
end

-- The rows that read a long list: the page slider (only with more than one page) and the names the page starts and ends with.
-- `nameAt(index)` is the display name of the index-th item of the list.
local function pageRows(first, last, pages, nameAt)
    local rows = {}
    if pages > 1 then
        rows[#rows + 1] = setting('ui:page', 'Page', 'int', listPage, 1,
            'Drag the slider, or press left and right, to turn the page.', nil, {min = 1, max = pages, step = 1})
    end
    if last >= first then
        local range = shortName(nameAt(first)) .. ' – ' .. shortName(nameAt(last))
        rows[#rows + 1] = readonly('list-range', ui.t('Page {page} / {pages}', {page = listPage, pages = pages}), range,
            range, {label = true, value = true, description = true})
    end
    return rows
end

-- The first character of a name as a group for the model browser: a plain letter upper-cased, digits and symbols together as #,
-- a letter of another script as itself.
local function groupOf(name)
    local first = tostring(name or ''):match('^[\1-\127\194-\244][\128-\191]*') or ''
    if first:match('^%a$') then return first:upper() end
    if first == '' or first:match('^[%d%p%s]$') then return '#' end
    return first
end

-- Game records the browser does not list: the ones the game's own data marks as retired, "!OBSOLETE - ..." (a leading "!" is the
-- developers' sort-to-top mark for it), and any name that says OBSOLETE as a word.
local function retiredModel(model)
    local name = tostring(model.name or '')
    return name:find('^%s*!') ~= nil or name:upper():find('%f[%a]OBSOLETE%f[%A]') ~= nil
end
-- A record that has no name of its own (an unnamed model, or the record id shown instead of a name) or a name that is only an internal code
-- (no lowercase letter, a digit or a dash in it: "1H-DNC-LAÖ"). They are listed after the real names.
local function placeholderModel(model)
    local name = tostring(model.name or '')
    if model.unnamedIndex or (model.record ~= nil and name == model.record) then return true end
    -- Capital letters with an accent (Latin-1, A-grave to Thorn) are letters of a code like any other; any other non-ASCII letter
    -- belongs to a real name.
    local plain = name:gsub('\195[\128-\158]', '')
    return not plain:find('[%l\128-\255]') and plain:find('[%d%-_]') ~= nil
end
M.retiredModel, M.placeholderModel = retiredModel, placeholderModel

-- The models by letter group, built once for a finished scan (the list never changes after it): the models the browser lists (retired
-- records left out, placeholders after the real names, each in the order the scan sorted them), the groups in order, and the models of
-- each. A page build then reads twelve rows, not the whole catalogue.
local modelGroupsCache = {}
local function modelGroups(models)
    if modelGroupsCache.models ~= models or modelGroupsCache.count ~= #models then
        local real, later = {}, {}
        for _, model in ipairs(models) do
            if not retiredModel(model) then
                local list = placeholderModel(model) and later or real
                list[#list + 1] = model
            end
        end
        for _, model in ipairs(later) do real[#real + 1] = model end
        local lists, order = {}, {}
        for _, model in ipairs(real) do
            local group = groupOf(model.name)
            local list = lists[group]
            if not list then list = {}; lists[group] = list; order[#order + 1] = group end
            list[#list + 1] = model
        end
        table.sort(order)
        modelGroupsCache = {models = models, count = #models, order = order, lists = lists, all = real}
    end
    return modelGroupsCache
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
    if settings.vVoice then speech[#speech + 1] = ui.t('V’s voice for typed lines') end
    local talk = {}
    if #speech > 0 then talk[#talk + 1] = ui.t('Speech: {list}', {list = table.concat(speech, ' · ')}) end
    if settings.multilingualConversations then talk[#talk + 1] = ui.t('Multilingual: replies in your language') end
    if settings.bodyGestures then behavior[#behavior + 1] = ui.t('Body gestures') end
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
                voice = snapshot.localVoice.cloudVoice == 'voxtral' and manager.voiceLabel(snapshot.localVoice.cloudVoice)
                    or manager.voiceLabel(active, snapshot.localVoice.omniSteps, snapshot.localVoice.omniReference)
                routed = true
                break
            end
        end
    end
    -- The Mistral cloud voice needs a Mistral key: say so instead of naming a voice that will not be heard.
    if not routed and settings.voiceProvider == 'voxtral' and not (snapshot.mistral or {}).saved then
        voice = ui.t('{voice} · needs Mistral key', {voice = manager.voiceLabel('voxtral')})
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
        releasing = 'Releasing local voice memory', remote = 'Convai voices · Local model unloaded',
        remoteVoxtral = 'Voxtral cloud voice · Local model unloaded'}
    -- The bridge reports 'remote' for every voice that loads no local model; cloudVoice says which one is speaking.
    local function labelKey()
        if state.state == 'remote' and state.cloudVoice == 'voxtral' then return 'remoteVoxtral' end
        return state.state
    end
    if state.pending then
        if state.preparationOnly then
            return ui.t('{status} · After current reply', {status=ui.t(labels[labelKey()] or 'Waiting for voice service')})
        end
        return ui.t('Changing after the current reply')
    end
    local fallback = state.fallback
    if type(fallback) == 'table' and (fallback.from == 'omni' or fallback.from == 'pocket' or fallback.from == 'voxtral')
        and (fallback.to == 'pocket' or fallback.to == 'convai') then
        local values = {
            -- A cloud voice that fell back is not the one speaking: the plain state names the Convai voice.
            status = ui.t(labels[state.state] or 'Waiting for voice service'),
            voice = manager.voiceLabel(fallback.to, state.omniSteps, state.omniReference),
            requested = manager.voiceLabel(fallback.from, state.requestedOmniSteps, state.requestedOmniReference)}
        -- A temporary fallback is an Omni being loaded again in the background: it is coming back, not unavailable.
        if fallback.temporary == true then return ui.t('{status} · Using {voice}, {requested} not ready yet', values) end
        return ui.t('{status} · Using {voice}, {requested} unavailable', values)
    end
    return ui.t(labels[labelKey()] or 'Waiting for voice service')
end

-- Johnny's standing in this save's story (docs/JOHNNY_IN_YOUR_HEAD.md): a read-only row under his setting while it is on, or nil.
-- convaiJohnnyStanding (init.lua) loads mod/johnny-head.lua only then and reads a few quest facts once per draw of the page.
local function johnnyStandingRow(snapshot)
    if snapshot.settings.johnnyInHead ~= true or type(convaiJohnnyStanding) ~= 'function' then return nil end
    local ok, stage = pcall(convaiJohnnyStanding)
    stage = ok and stage or 'unknown'
    local value
    if stage == 'before' then value = ui.t('Not in your head yet')
    elseif stage == 'wary' then value = ui.t('Wary')
    elseif stage == 'grudging' then value = ui.t('Grudging respect')
    elseif stage == 'friends' then value = ui.t('Friends')
    elseif stage == 'close' then value = ui.t('Close friends')
    elseif stage == 'after' then value = ui.t('Gone after the ending')
    else value = ui.t('Unknown') end
    return readonly('johnnyStanding', 'Johnny’s standing', value,
        'Where you and Johnny stand in this save’s story. It follows what you have been through together, such as Alt, the oil fields, Rogue and the reunion concert.\n\nRead from your save; nothing is stored.',
        {value = true})
end
local function savedVoiceIndex(settings)
    return voicePreviewModule.indexOf(settings)
end

-- The select's labels, in menu order.
-- An OmniVoice entry stays in the list while the optional pack is missing (the row's name says "no Omni pack"), and M.apply refuses
-- it (the bridge would fall back to Pocket TTS anyway): the row goes back to the voice that is saved, with the reason on the page.
local function voiceMenuLabels(pack, mistral)
    local elements, disabled = {}, {}
    for index, choice in ipairs(VOICE_CHOICES) do
        -- Short (OPTION_BUDGET), so the entry does not run over the arrows or the key boxes of a focused row; the voice description says
        -- what the pack and the keys are. The Mistral cloud voice has a menu name of its own: the full one ("Mistral cloud voice
        -- (Voxtral)") stays for sentences.
        local label
        if choice.provider == 'voxtral' then
            label = (mistral or {}).saved and ui.t('Voxtral (recommended)') or ui.t('Voxtral · needs Mistral key')
        else
            label = manager.voiceLabel(choice.provider, choice.steps, choice.reference)
            if choice.provider == 'omni' and not (pack or {}).installed then disabled[#elements + 1] = true end
        end
        elements[#elements + 1] = label
    end
    voiceMenuSize, voiceLabelsShown, voiceDisabledShown = #elements, elements, disabled
    return elements
end
local function voiceStatusText(snapshot)
    -- The service never started because no browser can run its conversation page: say that, not "Waiting for voice service".
    if support and support.serviceFault() == 'browser' then return ui.t('Needs a browser') end
    return voiceServiceLabel(snapshot.localVoice)
end
-- Mature content works with the Local AI, Mistral and Custom providers and never stands beside Convai (free tier or API key). With Local AI its
-- replies must not go to a cloud voice. So turning it ON beside Convai selects, in the same saved transaction, the Local AI provider, the
-- uncensored model and, when the companion voice is a cloud voice, Pocket TTS (a local voice is left as it is); without the Local AI pack it
-- cannot be on beside Convai and the switch goes back to off. Beside Local AI it selects the uncensored model and Pocket TTS the same way; beside
-- Mistral or Custom it changes nothing else (the lines go to that service anyway, and the model and voice are the player's). Picking Convai
-- while it is on turns it OFF.
-- Turning it OFF puts back what turning it on changed, unless the player changed it since. What was changed is kept in the saved
-- settings (manager: matureRestore). stageMature computes all of it from the saved settings and the batch of changes; it runs when a
-- change is applied and costs nothing otherwise.
-- The provider list in menu order; PROVIDER_IDS names them for the restore record ('convai-key' is Convai with the player's own key).
local PROVIDER_IDS = {'convai', 'convai-key', 'mistral', 'local', 'custom'}
local LOCAL_PROVIDER = 4
-- Positions of the providers that take Mature content as they are (Mistral, Custom); Local AI is LOCAL_PROVIDER. Convai (1, 2) never does.
local MATURE_CLOUD_PROVIDERS = {[3] = true, [5] = true}
-- Why a model the player added cannot be used (bridge/custom-models.mjs reason codes), as a short phrase for the Local AI model row's help.
local function customProblemText(reason)
    if reason == 'missing' then return ui.t('file not found') end
    if reason == 'bad-gguf' then return ui.t('not a valid GGUF file') end
    if reason == 'embedding' then return ui.t('an embedding model, not a chat model') end
    return ui.t('could not be read')
end

local LOCAL_AI_PRESENT = {ready = true, warming = true, ['no-memory'] = true, failed = true}
local CLOUD_VOICES = {voxtral = true, convai = true}

local function voiceRecord(index)
    local choice = VOICE_CHOICES[index]
    if not choice then return nil end
    return {provider = choice.provider, steps = choice.steps, reference = choice.reference}
end

local function voiceIndexOf(record)
    if type(record) ~= 'table' then return nil end
    return voicePreviewModule.indexOf({voiceProvider = record.provider, omniSteps = record.steps, omniReference = record.reference})
end

-- The position of a model in the row. 'auto' (an older version's Mature record) is the model shown as the default.
local function modelIndexOf(id)
    if id == 'auto' then id = manager.localModelDefaultId() end
    for index, choice in ipairs(manager.localModelChoices()) do if choice.id == id then return index end end
end

-- The Conversation provider selector's index of the saved settings: 1 Convai free tier, 2 Convai API key, 3 Mistral, 4 Local, 5 Custom.
local function providerIndexOf(settings)
    if settings.conversationProvider == 'custom' then return 5 end
    if settings.conversationProvider == 'local' then return 4 end
    if settings.conversationProvider == 'mistral' then return 3 end
    return settings.useOwnConvaiKey == true and 2 or 1
end

-- `changes` is the batch, a list of {id, value} with the values as a page holds them (booleans, list positions, numbers). Returns the
-- batch with what Mature content needs added or put back, the record of what turning it on changed (the caller saves it with the
-- settings), the names of what was changed besides the player's own choice, and a refusal text when the switch cannot be turned on.
local function stageMature(changes, snapshot)
    local saved = snapshot.settings
    local batch, by = {}, {}
    for _, change in ipairs(changes) do
        local copy = {id = change.id, value = change.value}
        batch[#batch + 1], by[change.id] = copy, copy
    end
    local function stage(id, value)
        if by[id] then by[id].value = value
        else
            local change = {id = id, value = value}
            batch[#batch + 1], by[id] = change, change
        end
    end
    local function now(id, savedValue)
        if by[id] then return by[id].value end
        return savedValue
    end
    local record, names, refusal = nil, {}, nil
    local savedMature = saved.matureContent == true
    local providerNow = now('conversationProvider', providerIndexOf(saved))
    local mature = by.matureContent
    -- Mature content off never loads a Mature pack model (the bridge skips it), so a row still on one moves to the standard (else the lite) model in the same
    -- change, whether or not the way back above put an earlier model there. Nothing happens when neither is listed (a Mature-only install).
    local function leaveUncensoredModel()
        local current = manager.localModelChoices()[now('localModel', modelIndexOf(saved.localModel)) or 0]
        if not current or not current.id:find('^mature:') then return end
        for _, id in ipairs({'standard', 'lite'}) do
            local target = modelIndexOf(id)
            if target then
                stage('localModel', target); names[#names + 1] = ui.t('Local AI model')
                return
            end
        end
    end
    local function turnedOff()
        local restore = saved.matureRestore
        if type(restore) ~= 'table' then leaveUncensoredModel(); return end
        local part = restore.conversationProvider
        if part then
            local was, back
            for index, id in ipairs(PROVIDER_IDS) do
                if id == part.set then was = index end
                if id == part.before then back = index end
            end
            if now('conversationProvider', providerIndexOf(saved)) == was and back then
                stage('conversationProvider', back); names[#names + 1] = ui.t('Conversation provider')
            end
        end
        part = restore.localModel
        if part then
            local current, back = now('localModel', modelIndexOf(saved.localModel)), modelIndexOf(part.before)
            if current == modelIndexOf(part.set) and back then
                stage('localModel', back); names[#names + 1] = ui.t('Local AI model')
            end
        end
        part = restore.voice
        if part then
            local current, back = now('voiceProvider', savedVoiceIndex(saved)), voiceIndexOf(part.before)
            if current == voiceIndexOf(part.set) and back then
                stage('voiceProvider', back); names[#names + 1] = ui.t('Companion voices')
            end
        end
        leaveUncensoredModel()
    end
    if mature and mature.value == true and not savedMature then
        local installed = LOCAL_AI_PRESENT[(snapshot.mistral or {}).localAi] == true
        local usingLocal = providerNow == LOCAL_PROVIDER
        local cloudText = MATURE_CLOUD_PROVIDERS[providerNow] == true
        if not usingLocal and not cloudText and (not installed or by.conversationProvider) then
            -- Without the Local AI pack Mature content cannot be on beside Convai: the switch goes back to off. The same
            -- when the same change picks Convai: the provider the player chose stays.
            mature.value, refusal = false, ui.t('Needs Local AI, Mistral or Custom.')
        else
            record = {}
            if not usingLocal and not cloudText and PROVIDER_IDS[providerNow] then
                stage('conversationProvider', LOCAL_PROVIDER)
                record.conversationProvider = {before = PROVIDER_IDS[providerNow], set = 'local'}
                names[#names + 1] = ui.t('Local AI')
                usingLocal = true
            end
            if usingLocal then
                -- The largest uncensored model that fits, when one is installed; otherwise the model is left alone.
                local choices = manager.localModelChoices()
                local modelNow = now('localModel', modelIndexOf(saved.localModel))
                local uncensoredId = manager.localModelMatureId()
                local target = uncensoredId and modelIndexOf(uncensoredId) or nil
                if target and type(modelNow) == 'number' and modelNow ~= target and choices[modelNow] then
                    stage('localModel', target)
                    record.localModel = {before = choices[modelNow].id, set = uncensoredId}
                    names[#names + 1] = ui.t('Uncensored model')
                end
                local voiceNow = now('voiceProvider', savedVoiceIndex(saved))
                local choice = VOICE_CHOICES[voiceNow]
                if choice and CLOUD_VOICES[choice.provider] then
                    -- A local voice (Pocket, OmniVoice) is left exactly as it is; only a cloud voice moves, and it moves to Pocket TTS.
                    -- Multilingual conversations refuses Pocket TTS: then OmniVoice is the local voice to move to, and without its pack there is none.
                    local multilingual = now('multilingualConversations', saved.multilingualConversations == true) == true
                    local omni = manager.omniPack().installed == true
                    if omni or not multilingual then
                        local target = multilingual and 2 or 1
                        stage('voiceProvider', target)
                        record.voice = {before = voiceRecord(voiceNow), set = voiceRecord(target)}
                        local chosen = VOICE_CHOICES[target]
                        names[#names + 1] = manager.voiceLabel(chosen.provider, chosen.steps, chosen.reference)
                    end
                end
            end
            record = next(record) and record or nil
        end
    elseif mature and mature.value == false and savedMature then
        turnedOff()
    elseif savedMature and not mature and by.conversationProvider and providerNow ~= LOCAL_PROVIDER
        and not MATURE_CLOUD_PROVIDERS[providerNow] and providerNow ~= providerIndexOf(saved) then
        -- Convai picked while Mature content is on turns it off, with the same way back.
        stage('matureContent', false)
        turnedOff()
    end
    return batch, record, names, refusal
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

-- Called by the 1 s look in M.update. While a paid tier action awaits its answer (the payment page, a plan check, a sign-in), takes the
-- sentence for the latest result as the status text, which updatePreparationBanner puts on the line in place. Nothing is read once the
-- answer is final, when the page is left, or after seven minutes.
local function followPaidStatus()
    if not paidStatusUntil then return end
    if view ~= 'paid-tier' or not paidTier or os.clock() > paidStatusUntil then paidStatus, paidStatusUntil = nil, nil; return end
    local state = paidTier.state()
    local message = paidTier.message(state)
    if message and message ~= paidStatus then paidStatus, actionFeedback = message, message end
    if paidTier.settled(state) then paidStatusUntil = nil end
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
            'Invited characters are prepared immediately. Their memories start when you actually talk to them.\n\nOne player identity is shared across all saves and stays the same after forgetting.\n\nCurrent game context describes the world you have loaded.'),
        readonly('memory-service', 'Memory service', memory.state == 'ready' and 'Ready' or 'Unavailable',
            memory.state == 'ready' and 'Memories can be managed here.'
                or 'Reopen this page after the memory service reconnects. A pending clear keeps waiting for its own result.'),
        readonly('memory-count', 'Characters you have talked to',
            memory.talkedToCount and (memory.state == 'ready' and tostring(memory.talkedToCount)
                or ui.t('{count} · Last reported',{count=memory.talkedToCount})) or 'Unavailable',
            'Forget all memories applies to these characters.\n\nBrowsing the catalogue or inviting a companion does not add anyone to this count.'),
        readonly('memory-selected', 'Selected character', memory.selectedName or 'Choose a character',
            'Choose any character from the list below. They do not need to be in your current party.',
            {value = memory.selectedName ~= nil}),
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
            'Clear memories about you for every character you have talked to.\n\nYour player identity stays. A confirmation comes first.',
            function() return manager.beginMemoryClear('all') end, memory.canClearAll)
    end
    rows[#rows + 1] = readonly('memory-chat-history', 'Phone Chat messages', 'Kept until forgotten',
        'Chat history stays available across game launches.\n\nForgetting a character also clears their saved Chat messages and drafts. Forgetting all memories clears all saved chats.')
    return rows
end

-- One API key as one row. Its action reads Paste while no key is saved and Remove once one is, and what a separate status row used to say
-- is in brackets after the name: the last four characters of a saved key (Added when the bridge sent none), or Checking… while it is
-- being checked. A paste that failed puts its message first in the row's help, and the row then says Not added. The names and the two
-- helps are source strings (the catalogue reads them from the call); `key` is {saved, tail, checking, message}. Only the last four
-- characters of a key are ever shown (docs/OWN_CONVAI_KEY.md): the key itself never reaches this file.
local function keyRow(name, pasteHelp, removeHelp, id, key, paste, remove, lastParagraph)
    local info
    if key.checking then info = ui.t('Checking…')
    elseif key.saved then info = key.tail and ('…' .. key.tail) or ui.t('Added')
    elseif key.message then info = ui.t('Not added') end
    local help
    if key.saved then
        help = ui.t(removeHelp) .. '\n\n' .. ui.t('Saved on this computer only. Only the last four characters are ever shown.')
    else
        help = ui.t(pasteHelp)
    end
    if key.message then help = key.message .. '\n\n' .. help end
    if lastParagraph then help = help .. '\n\n' .. lastParagraph end
    return action(id, ui.t(name) .. (info and (' (' .. info .. ')') or ''), key.saved and ui.t('Remove') or ui.t('Paste'), help,
        key.saved and remove or paste, nil, {label = true, value = true, description = true})
end

-- Settings > Conversation provider: the provider, Mature content, the Local AI model and the key rows of Convai and Mistral
-- (docs/OWN_CONVAI_KEY.md for the Convai key). The text shown here about a key is its status, never the key: only its last four
-- characters, which the bridge publishes, are ever displayed.
local function ownKeyRows(snapshot)
    local own, mistral = snapshot.ownKey, snapshot.mistral or {}
    -- The message of a paste that did not work, for each key (the Convai key has two more reasons than the others).
    local ownMessage, result = nil, own.result
    if result == 'empty' then ownMessage = ui.t('The clipboard is empty. Copy your key first.')
    elseif result == 'not-a-key' then ownMessage = ui.t('The clipboard does not hold a Convai API key.')
    elseif result == 'invalid' then ownMessage = ui.t('Convai did not accept that key.')
    elseif result == 'clipboard' then ownMessage = ui.t('The clipboard could not be read.')
    elseif result == 'failed' then ownMessage = ui.t('The key could not be saved.') end
    local mistralMessage, mistralResult = nil, mistral.result
    if mistralResult == 'invalid' then mistralMessage = ui.t('Mistral did not accept that key.')
    elseif mistralResult == 'unreadable' then mistralMessage = ui.t('The clipboard could not be read.')
    elseif mistralResult == 'failed' then mistralMessage = ui.t('The key could not be saved.') end
    -- Who answers right now, as the last paragraph of the provider row's help: only what the player has to act on or could not guess
    -- (a limit, a rejected key, a wait, a fallback, the free tier's allowance). The selected provider is the row's own value, and a
    -- key is never counted against the daily allowance (bridge/shared-key-guard.mjs).
    local note, limitHelp
    if mistral.pending then note = ui.t('Waiting for the conversation to end')
    elseif mistral.effective == 'mistral' then
        if mistral.limit == 'rate' or mistral.limit == 'daily' then note = ui.t('Mistral: free limit reached for now')
        elseif mistral.limit == 'invalid' then note = ui.t('Mistral: key not accepted')
        elseif mistral.limit == 'model' then note = ui.t('Mistral: model unavailable') end
    elseif mistral.effective == 'custom' then
        note = customProvider.instance and customProvider.instance.noteFor(mistral.limit) or nil
    elseif mistral.effective == 'local' then note = nil
    elseif snapshot.settings.conversationProvider == 'local' then note = ui.t('Convai: Local AI is not ready')
    elseif snapshot.settings.conversationProvider == 'mistral' then note = ui.t('Convai: Mistral has no key yet')
    elseif snapshot.settings.conversationProvider == 'custom' then
        note = customProvider.instance and customProvider.instance.notSetUpNote() or nil
    elseif own.limit == 'used-up' and own.limitOwn then note = ui.t('Your key: plan limit reached')
    elseif own.limit == 'used-up' then note = ui.t('Convai free tier: limit used up')
    elseif own.limit == 'rejected' then note = ui.t('Your key: not accepted')
    elseif own.limit == 'memory-needed' then note = ui.t('Your key: no room for memory')
    elseif own.active == 'player' and own.memoryOff then note = ui.t('Your own key, without memory')
    elseif own.active == 'player' then note = nil
    elseif own.daily and own.daily.blocked then
        -- The limit is reached: the status is the provider help's last paragraph (that help is already close to the panel's height in
        -- several languages) and what to do goes into the Mistral key row's help (the real limit comes from the sign-in backend,
        -- bridge/shared-key-guard.mjs).
        note = ui.t('Convai free tier: daily limit reached')
        limitHelp = ui.t('You have used today’s {limit} turns, which come back tomorrow. To keep talking now, choose Mistral (with your free key, about 5,000 turns a day) or Local AI (unlimited).', {limit = own.daily.limit})
    elseif own.daily then note = ui.t('Convai free tier: {left} of {limit} left today', {left = own.daily.left, limit = own.daily.limit}) end
    -- The voice key needs speech recognition on this computer, which only the bridge can say it has.
    local providerHelp = mistral.stt
        and ui.t('Who writes your companions’ replies. A change waits until no conversation is running.\n\nConvai free tier needs no setup and gives better replies. Convai API key uses your own key, and Mistral uses its free plan with your own free key; memory stays on this computer.\n\nWith Mistral or Local AI, Convai’s cloud voice is replaced by a local voice. Speech is recognized on this computer, so the voice key works.')
        or ui.t('Who writes your companions’ replies. A change waits until no conversation is running.\n\nConvai free tier needs no setup and gives better replies. Convai API key uses your own key, and Mistral uses its free plan with your own free key; memory stays on this computer.\n\nWith Mistral or Local AI, Convai’s cloud voice is replaced by a local voice. Speech recognition for the voice key is not available yet with them, so type your messages.')
    -- The note comes first: the description area holds only so much, and who answers right now is what the player acts on.
    if note then providerHelp = note .. '\n\n' .. providerHelp end
    -- Mature content is part of the main mod (off by default). It works with Local AI, Mistral and Custom: turning it on beside Convai selects
    -- Local AI, and choosing Convai turns it off. The help says whether the optional Mature pack (uncensored models, Local AI) is installed
    -- (the bridge reports its marker).
    local matureRow
    do
        local matureHelp = ui.t('Strong language, graphic violence, drugs and, between consenting adults, flirting and sex. Adults only (18+). Works with Local AI, Mistral and Custom.')
        -- The rules come before the pack: the description area holds only so much, and those are what has to be read.
        matureHelp = matureHelp .. '\n\n' .. ui.t('Never allowed: sex with minors or without consent, sex about real people, hate, real-world weapon or drug instructions. A safety check enforces the minors rule.')
        matureHelp = matureHelp .. '\n\n' .. (mistral.maturePack == true
            and ui.t('The Mature pack’s uncensored models (for Local AI) give the full effect; standard models mostly refuse sex. Pack: installed.')
            or ui.t('The Mature pack’s uncensored models (for Local AI) give the full effect; standard models mostly refuse sex. Pack: not installed (optional, on this mod’s Hugging Face page).'))
        matureHelp = matureHelp .. '\n\n' .. ui.t('From Convai, turning it on selects Local AI. With Local AI it also selects the largest uncensored model that fits and a local voice instead of a cloud one. Turning it off restores your choices.')
            .. ' ' .. ui.t('Choosing Convai turns it off.')
        matureRow = setting('matureContent', 'Mature content', 'bool', snapshot.settings.matureContent, false, matureHelp, nil, {description = true})
    end
    -- Which installed Local AI model loads: each installed model by its manifest name, smallest file first (the bridge reports the list); the sizes
    -- are in the help. No Auto entry: while nothing was chosen the model the bridge would load is shown as selected. The state of the Local AI
    -- pack is not a row of its own: while it warms up, or cannot start or run, the row's name says so in brackets and the help starts with the
    -- sentence the loading notices use; ready and not installed need no words (the model list says No model installed).
    local modelRow
    do
        local choices, labels, selected, sizes, anyCustom = manager.localModelChoices(), {}, 1, {}, false
        local found = false
        for index, choice in ipairs(choices) do
            labels[index] = choice.name
            -- A saved Mature pack model with Mature content off is not the model that loads (the bridge skips it): the default is shown instead.
            if choice.id == snapshot.settings.localModel and not (choice.id:find('^mature:') and snapshot.settings.matureContent ~= true) then selected, found = index, true end
            do
                local gb = string.format('%.1f', choice.sizeMiB / 1024)
                if choice.custom then
                    -- A model the player added by hand: marked "(custom)", with the graphics memory it needs or that the card is too small for it.
                    anyCustom = true
                    if choice.tooLarge then
                        labels[index] = ui.t('{name} (custom · too large)', {name = choice.name})
                        sizes[#sizes + 1] = ui.t('{name} (custom, {size} GB, too large for this card)', {name = choice.name, size = gb})
                    else
                        labels[index] = ui.t('{name} (custom)', {name = choice.name})
                        sizes[#sizes + 1] = choice.sizeMiB > 0
                            and ui.t('{name} (custom, {size} GB, needs {need} GB)', {name = choice.name, size = gb, need = string.format('%.1f', choice.needMiB / 1024)})
                            or ui.t('{name} (custom)', {name = choice.name})
                    end
                else
                    sizes[#sizes + 1] = choice.sizeMiB > 0 and string.format('%s (%.1f GB)', choice.name, choice.sizeMiB / 1024) or choice.name
                end
            end
        end
        -- Nothing chosen yet (a saved 'auto'), or a saved model that is gone: the model the bridge loads instead is the one shown as selected.
        if not found then
            local default = manager.localModelDefaultId()
            for index, choice in ipairs(choices) do if choice.id == default then selected = index end end
        end
        -- Nothing listed because the conversation service is not running (it is what reports the installed models): say so, with the
        -- service's own sentence, rather than "No model installed". With no evidence about the service at all, nothing changes.
        local serviceNote
        if #choices == 0 then
            local serviceState = support and support.serviceState() or 'unknown'
            if serviceState == 'stopped' then labels[1], serviceNote = ui.t('Service not running'), support.serviceMessage()
            elseif serviceState == 'starting' then labels[1], serviceNote = ui.t('Service starting'), support.serviceMessage()
            else labels[1] = ui.t('No model installed') end
        end
        local modelHelp = ui.t('Until you choose one, Local AI loads the largest model that fits your free graphics memory.\n\nOne model at a time; a change applies when it next loads. A model that is missing, too large or failing is replaced by the largest that fits, with one notice.')
        if #sizes > 0 then modelHelp = modelHelp .. '\n\n' .. table.concat(sizes, '\n') end
        if anyCustom then
            modelHelp = modelHelp .. '\n\n' .. ui.t('Custom models are ones you added; they join the default choice by size.')
        end
        local problems = {}
        for _, problem in ipairs(manager.localModelProblems()) do
            problems[#problems + 1] = ui.t('{name}: {reason}', {name = problem.name, reason = customProblemText(problem.reason)})
        end
        if #problems > 0 then modelHelp = modelHelp .. '\n\n' .. ui.t('Not usable: {models}. See the Local AI notes, "Add your own model".', {models = table.concat(problems, '; ')}) end
        local state, status = mistral.localAi, nil
        local label = ui.t('Local AI model')
        if state == 'warming' then label, status = label .. ' (' .. ui.t('Warming up') .. ')', loadingText('local-ai', 'loading')
        elseif state == 'no-memory' then label, status = label .. ' (' .. ui.t('Not enough memory') .. ')', loadingText('local-ai', 'no-memory')
        elseif state == 'failed' then
            -- Only Mature models (the Mature pack's, or a server of the player's marked uncensored) and Mature content off: say what to do.
            label = label .. ' (' .. ui.t('Unavailable') .. ')'
            status = mistral.localReason == 'mature-off' and ui.t('Only Mature models found. Turn on Mature content to use them.') or loadingText('local-ai', 'failed')
        end
        status = status or serviceNote
        if status then modelHelp = status .. '\n\n' .. modelHelp end
        modelRow = setting('localModel', label, 'select', selected, modelIndexOf('auto') or 1, modelHelp, labels, {elements = true, description = true, label = true})
    end
    local rows = {
        setting('conversationProvider', 'Conversation provider', 'select', providerIndexOf(snapshot.settings), 1, providerHelp,
            {'Convai free tier', 'Convai API key', 'Mistral (free plan)', 'Local AI', 'Custom (OpenAI-compatible)'}, {elements = true, description = true}),
        matureRow,
        modelRow,
        keyRow('Mistral free API key',
            'Copy your free key from Mistral first (signing up there needs phone verification). It is read from the clipboard once, checked with Mistral and saved on this computer.\n\nYou can also save it in player-mistral-key.txt in the conversation service folder. Mistral allows about one message a second and about 5,000 turns a day. It sets its own monthly cap, estimated at about 150,000 turns.',
            'Deletes the saved key. Conversations go back to Convai free tier.',
            'mistral-key', {saved = mistral.saved == true, tail = mistral.tail, message = mistralMessage},
            function() return manager.pasteMistralKey() end, function() return manager.removeMistralKey() end, limitHelp),
        keyRow('Convai API key',
            'Copy your key first. It is read from the clipboard once, checked with Convai and saved on this computer.',
            'Deletes the saved key. Conversations go back to Convai free tier.',
            'own-key', {saved = own.saved, tail = own.tail, checking = result == 'checking', message = ownMessage},
            function() return manager.pasteOwnKey() end, function() return manager.removeOwnKey() end),
    }
    -- Custom (OpenAI-compatible): its endpoint URL, API key and model ID rows and the connection test, right under the Mistral key row.
    -- Everything they say comes from mod/custom-provider.lua; this only draws them (a row is one action row). A fault there never
    -- costs the page.
    if customProvider.instance then
        local made, items = pcall(customProvider.instance.rows)
        if made and type(items) == 'table' then
            local at = #rows + 1
            for index, item in ipairs(rows) do if item.id == 'mistral-key' then at = index + 1 end end
            for offset, item in ipairs(items) do
                table.insert(rows, at + offset - 1, action(item.id, item.label, item.value, item.help,
                    function() return customProvider.instance.request(item.action) end, item.enabled,
                    {label = true, value = true, description = true}))
            end
        end
    end
    -- Convai paid tier: right under the Convai API key row, whose key a plan is bought for.
    if paidTier then
        local at = #rows + 1
        for index, item in ipairs(rows) do if item.id == 'own-key' then at = index + 1 end end
        table.insert(rows, at, action('paid-tier', 'Convai paid tier', 'Open',
            'Convai’s plans for this mod: more Convai conversations on your own Convai API key. Opens a page with the plans and their prices.',
            function()
                paidTier.request('refresh')
                return navigate('paid-tier')
            end))
    end
    if editor then
        rows[#rows + 1] = action('character-editor:open', 'Edit characters', 'Open',
            'Edit a character’s bio, speaking style, speaking rules and memories, or make a character of your own, in your browser.\n\nWorks with Mistral and Local AI, not Convai. Changes apply from the next reply.',
            function() return editor.request() end)
    end
    return rows
end

-- Settings > Conversation provider > Convai paid tier (docs/CONVAI_PAID_TIER.md): the player's plan, the Convai API key row (a plan is
-- bought for that key), one row per plan, a check and the Convai billing page. Prices and plans come from the conversation service
-- (bridge/convai-paid-tier.mjs), which also does every request; this page only sends commands through mod/convai-paid-tier.lua.
local function paidTierRows(snapshot)
    local state, own = paidTier.state(), snapshot.ownKey
    local keySaved = own.saved == true
    local rows = {}
    if not state.available then
        rows[#rows + 1] = readonly('paid-unavailable', 'Convai paid tier', 'Unavailable',
            'The conversation service is not running, so plans cannot be shown. Restart the game.')
        return {category('paid-tier', 'Convai paid tier', rows)}
    end
    local planValue, planHelp
    if not keySaved then planValue, planHelp = ui.t('No key added'), ui.t('Add your Convai API key below to see and buy a plan.')
    elseif state.plan and (state.plan.name or not state.plan.paid) then
        planValue = paidTier.planLabel(state.plan)
        planHelp = state.plan.paid and ui.t('Conversations with Convai API key chosen as the provider use this plan.')
            or ui.t('This key has no paid plan. Choose a plan below.')
    else planValue, planHelp = ui.t('Not checked yet'), ui.t('Choose Check my plan to ask Convai.') end
    local message = paidTier.message(state)
    if message then planHelp = message .. '\n\n' .. planHelp end
    rows[#rows + 1] = readonly('paid-plan', 'Your Convai plan', planValue, planHelp, {value = true, description = true})
    if not keySaved then
        -- Sign in with Convai (bridge/convai-signin.mjs): Convai's login page hands the key back to the conversation service.
        rows[#rows + 1] = action('paid:sign-in', 'Sign in with Convai', 'Sign in',
            'Opens Convai’s sign-in page in your browser.\n\nSign in or make a free account, and your Convai API key is saved on this computer, the same as Paste. You have five minutes.',
            function() return paidTier.request('sign-in') end)
        rows[#rows + 1] = action('paid:key-page', 'Get your Convai API key', 'Open',
            'Opens convai.com in your browser. Sign in or make a free account, copy your API key, then come back and choose Paste below.',
            function() return paidTier.request('key-page') end)
    end
    local ownMessage = own.result == 'empty' and ui.t('The clipboard is empty. Copy your key first.')
        or own.result == 'not-a-key' and ui.t('The clipboard does not hold a Convai API key.')
        or own.result == 'invalid' and ui.t('Convai did not accept that key.')
        or own.result == 'clipboard' and ui.t('The clipboard could not be read.')
        or own.result == 'failed' and ui.t('The key could not be saved.') or nil
    rows[#rows + 1] = keyRow('Convai API key',
        'Copy your key first. It is read from the clipboard once, checked with Convai and saved on this computer.',
        'Deletes the saved key. Conversations go back to Convai free tier.',
        'paid-own-key', {saved = keySaved, tail = own.tail, checking = own.result == 'checking', message = ownMessage},
        function() return manager.pasteOwnKey() end, function() return manager.removeOwnKey() end)
    local plans = {}
    for _, plan in ipairs(state.plans) do
        local label = plan.period == 'yearly' and ui.t('{plan}, {price} a year', {plan = plan.name, price = plan.price})
            or ui.t('{plan}, {price} a month', {plan = plan.name, price = plan.price})
        -- What the plan gives that this mod uses: its monthly interactions. (Its concurrent connections are not named: on a player's own key
        -- the mod keeps one conversation connection at a time, docs/OWN_CONVAI_KEY.md.)
        local quota = paidTier.quota(plan)
        local gives = quota and (ui.t('{count} Convai interactions a month.', {count = quota}) .. ' ') or ''
        local billed = plan.period == 'yearly' and ui.t('Billed once a year.') or ui.t('Billed every month.')
        local help = gives .. billed .. '\n\n'
            .. ui.t('Opens Convai’s payment page (Stripe) in your browser. You pay Convai directly; the mod never sees your card. Your plan is active about 15 seconds after you pay, and conversations then use your Convai API key.')
        if not keySaved then help = ui.t('Add your Convai API key first.') .. '\n\n' .. help end
        local id = plan.id
        if paidTier.isCurrent(state, plan) then
            -- The plan the key has now: nothing to buy. The other plans stay buyable (an upgrade or a change).
            help = gives .. billed .. '\n\n'
                .. ui.t('This is your current plan. To change or cancel it, choose Manage or cancel plan below.')
            plans[#plans + 1] = action('paid:current:' .. id, label, 'Current plan', help, function() return true end, false,
                {label = true, description = true})
        else
            plans[#plans + 1] = action('paid:buy:' .. id, label, 'Buy', help, function()
                if not keySaved then return false, 'Add your Convai API key first.' end
                return paidTier.request('buy', id)
            end, keySaved, {label = true, description = true})
        end
    end
    plans[#plans + 1] = action('paid:check', 'Check my plan', 'Check',
        'Asks Convai which plan your key has now. After paying, it can take about 15 seconds.',
        function()
            if not keySaved then return false, 'Add your Convai API key first.' end
            return paidTier.request('check')
        end, keySaved)
    plans[#plans + 1] = action('paid:manage', 'Manage or cancel plan', 'Open',
        'Opens your Convai billing page in your browser. Sign in with the same Convai account to change or cancel your plan.',
        function() return paidTier.request('manage') end)
    return {category('paid-tier', 'Convai paid tier', rows,
            'Plans Convai made for this mod. They give your own Convai API key more conversations; the free tier stays as it is.'),
        category('paid-plans', 'Plans', plans, 'Prices in US dollars. You can cancel at any time on Convai’s billing page.')}
end

-- The saved settings that are plain values, as one string (sorted by name): a setting that changed, whoever changed it, changes it.
local function settingsDigest(settings)
    local names = {}
    for name, value in pairs(settings) do
        local kind = type(value)
        if kind == 'string' or kind == 'number' or kind == 'boolean' then names[#names + 1] = name end
    end
    table.sort(names)
    local parts = {}
    for _, name in ipairs(names) do parts[#parts + 1] = name .. '=' .. tostring(settings[name]) end
    local modes = {}
    for key, mode in pairs(settings.relationshipModes or {}) do modes[#modes + 1] = key .. '=' .. tostring(mode) end
    table.sort(modes)
    return table.concat(parts, ',') .. ';' .. table.concat(modes, ',')
end

-- What the current page shows that can change without the player touching it, as one string: the page is drawn again only
-- when this changes, so a state the page does not show (a voice going from loading to ready while the Characters list is
-- open) never redraws it. Every field below is read by that page's rows.
local function pageSignature(snapshot)
    local parts = {view, tostring(listPage), tostring(listGroup), tostring(M.feedback())}
    local function add(text) parts[#parts + 1] = text end
    local function memorySignature()
        local memory = snapshot.memory
        add(table.concat({memory.state, tostring(memory.talkedToCount), memory.feedback,
            memory.selectedKey or '', memory.confirmation and memory.confirmation.token or '',
            memory.command and memory.command.id or '', memory.command and memory.command.scope or '',
            memory.command and memory.command.profileKey or '', memory.command and memory.command.state or ''}, '|'))
    end
    if view == 'characters' or view == 'party' then
        add(tostring(queue.message()))
        add(tostring(queue.count()))
        for _, member in ipairs(queue.list()) do
            add(table.concat({member.id, member.state or '', member.profileKey or '', member.error or '', member.dismissError or ''}, '|'))
        end
    end
    if view == 'party' then
        local trip = queue.chauffeur()
        add(table.concat({trip.phase or '', tostring(trip.stopPending), trip.reason or '', trip.error or ''}, '|'))
    end
    if view == 'characters' or view == 'memory' then memorySignature() end
    if view == 'characters' then
        local voice, pack = snapshot.localVoice, manager.omniPack()
        add(table.concat({voice.provider or '', tostring(voice.cloudVoice), tostring(voice.omniSteps), tostring(voice.omniReference),
            table.concat(voice.routedProfiles or {}, ','), tostring(pack.known), tostring(pack.installed),
            tostring((snapshot.mistral or {}).saved)}, '|'))
    end
    if view == 'models' then
        -- The list is built once the scan has finished (the models are sorted then); until then only the status line shows.
        add(tostring(snapshot.scan.finished))
        if snapshot.scan.finished then add(tostring(#snapshot.models)) end
    end
    if support and view == 'help' then
        add('help:' .. support.signature() .. '|' .. support.serviceState())
        if convaiSetupCheck then add('setup:' .. convaiSetupCheck.signature()) end
    end
    if paidTier and view == 'paid-tier' then
        local own = snapshot.ownKey
        add(table.concat({'paid', tostring(own.saved), own.tail or '', own.result or '', paidTier.signature()}, '|'))
    end
    if view == 'relationships' then add(settingsDigest(snapshot.settings)) end
    if view == 'settings' then
        -- The key rows change when the bridge answers a Paste or Remove, or reports a used-up plan; the provider rows when its
        -- state changes (Local AI warming up and ready); the voice list when the OmniVoice pack appears; the voice status line
        -- when the voice service changes state; every row when its saved value changes.
        add(settingsDigest(snapshot.settings))
        add('voice:' .. voiceStatusText(snapshot))
        local own, pack, mistral = snapshot.ownKey, manager.omniPack(), snapshot.mistral or {}
        add(table.concat({'key', tostring(own.saved), own.tail or '', own.active, tostring(own.pending),
            own.result or '', own.limit or '', tostring(own.limitOwn), tostring(own.memoryOff),
            own.daily and (tostring(own.daily.left) .. '/' .. tostring(own.daily.blocked)) or ''}, '|'))
        add(table.concat({'provider', tostring(mistral.saved), mistral.tail or '', mistral.provider or '', mistral.effective or '',
            mistral.localAi or '', tostring(mistral.maturePack), tostring(mistral.pending), mistral.result or '', mistral.limit or '', tostring(mistral.stt),
            tostring(pack.known), tostring(pack.installed), tostring(snapshot.settings.developerMode)}, '|'))
        -- The Local AI model row lists what is installed.
        local modelKey = {'models'}
        modelKey[#modelKey + 1] = 'd:' .. tostring(mistral.localModelDefault) .. ':' .. tostring(mistral.localModelMatureDefault)
        for _, model in ipairs(mistral.localModels or {}) do
            modelKey[#modelKey + 1] = model.id .. ':' .. model.name .. ':' .. tostring(model.sizeMiB) .. ':' .. tostring(model.custom) .. ':' .. tostring(model.tooLarge) .. ':' .. tostring(model.needMiB)
        end
        for _, problem in ipairs(mistral.localModelProblems or {}) do modelKey[#modelKey + 1] = 'x:' .. problem.name .. ':' .. problem.reason end
        -- With no model listed the row names the service state (not running, starting, or its fault), which changes without the player.
        if support and #(mistral.localModels or {}) == 0 then modelKey[#modelKey + 1] = 's:' .. support.serviceState() .. ':' .. tostring(support.serviceFault()) end
        add(table.concat(modelKey, '|'))
        -- The Custom provider's rows (state file read at most every 1.5 s, like the Mistral state above).
        if customProvider.instance then
            local read, signature = pcall(customProvider.instance.signature)
            add('custom:' .. (read and signature or ''))
        end
        -- Installed add-ons' own settings (docs/ADDON_API.md); nothing without one.
        if convaiAddons and convaiAddons.live then add('addons:' .. convaiAddons.signature()) end
    end
    return table.concat(parts, '\n')
end
-- Set by M.update when the game has no world (the main menu, a loading screen): Game.GetPlayer() can still hand back an object there,
-- and the pages must not offer invitations without a loaded save.
local noWorld = false
-- Relationships: who speaks as a partner. The saved values stay auto / on / off; only the labels read Romantic (Casual for Meredith) /
-- Ordinary. A page of its own, opened from the Conversations section of Settings (both hosts draw it from here).
local function relationshipRows(snapshot)
    local rows = {}
    for _, profile in ipairs(manager.relationshipChoices()) do
        local mode = snapshot.settings.relationshipModes[profile.key]
        local casual = profile.key == 'meredith-stout'
        local description = casual
            and 'Auto: follows the completed encounter in this save.\n\nCasual: speaks with that familiarity.\n\nOrdinary: keeps her usual manner.\n\nIt does not imply an ongoing relationship.'
            or 'Auto: follows the relationship in this save.\n\nRomantic: speaks to V as a partner.\n\nOrdinary: keeps their usual manner.\n\nOnly changes how they talk, never your game choices.'
        rows[#rows + 1] = setting('relationship:' .. profile.key, profile.name, 'select',
            mode == 'on' and 2 or mode == 'off' and 3 or 1, 1, description,
            {'Auto', casual and 'Casual' or 'Romantic', 'Ordinary'})
    end
    return rows
end

local function schema()
    local currentPlayer = not noWorld and player() or nil
    owner = identity(currentPlayer)
    queue.bind(owner)
    local snapshot, party = manager.snapshot(currentPlayer), queue.list()
    renderedSignature = pageSignature(snapshot)
    lastSignature = renderedSignature
    actions, disabledActions = {}, {}
    local categories = {}
    local rows = {}
    -- The party has no size limit and nothing here shows or enforces one: an invitation that cannot be made is answered with a
    -- message from the queue.
    local canInvite = owner ~= nil
    -- The first section of every page: the way back (or, on the home page, the four destinations) and the line of the last action.
    local nav = {}
    local BACK = {characters = 'home', party = 'home', models = 'home', settings = 'home', memory = 'settings', help = 'settings',
        ['paid-tier'] = 'settings', relationships = 'settings'}
    if view == 'home' then
        for _, tab in ipairs({{'characters', 'Characters to invite'}, {'party', 'Current party'},
            {'models', 'Model browser'}, {'settings', 'Settings'}}) do
            -- The Model browser lists every character model in the game, so it says that and what joining means.
            local description = tab[1] == 'models'
                and ui.t('Browse every character model in the game and invite any of them, including characters without conversation support. They join as followers and do not talk.')
                or ui.t('Browse {section}. {query}', {section = ui.t(tab[2]):lower(), query = ''})
            nav[#nav + 1] = action('tab:' .. tab[1], tab[2], 'Open', description, function() return navigate(tab[1]) end)
        end
    elseif BACK[view] then
        local parent = BACK[view]
        local id = view == 'memory' and 'memory:settings' or (view .. ':back')
        nav[#nav + 1] = parent == 'home'
            and action(id, 'Back to Companion Manager', 'Back', 'Return to Companion Manager.', function() return navigate('home') end)
            or action(id, 'Back to settings', 'Back', 'Return to conversation settings.', function() return navigate('settings') end)
    end
    if view == 'home' then
        -- Nothing more: the destinations are the page.
    elseif view == 'characters' then
        local shared = sharedCharacterLines(snapshot)
        local profiles = snapshot.profiles
        local first, last, pages = pageRange(#profiles)
        -- Without a loaded save the page can be read but nobody can be invited: say so, in a row, not only in greyed buttons.
        if not canInvite then rows[#rows + 1] = readonly('needs-save', 'Characters and party', 'Load a save first',
                'Inviting characters and managing your party need a loaded game.') end
        for _, row in ipairs(pageRows(first, last, pages, function(index) return profiles[index].name end)) do rows[#rows + 1] = row end
        for index = first, last do
            local profile = profiles[index]
            local key = profile.key
            local count = countKey(party, key)
            local available = manager.definition(key) ~= nil
            rows[#rows + 1] = action('invite:' .. key, profile.name,
                available and (count > 0 and ui.t('Add copy ({count})',{count=count}) or 'Invite') or 'Profile only',
                profileDescription(profile, snapshot, shared, count), function() return queue.invite(key) end, canInvite and available)
        end
        categories[#categories + 1] = category('characters', 'Characters to invite', rows)
    elseif view == 'party' then
        local trip = queue.chauffeur()
        local status = {}
        if trip.active then
            local tripStates = {releasing = 'Preparing to drive', ['exiting-passenger'] = 'Preparing to drive',
                ['waiting-for-driver-seat'] = 'Waiting for you to step out', ['boarding-driver'] = 'Driver boarding',
                ['waiting-for-player'] = 'Waiting for you to board', ['waiting-for-party'] = 'Waiting for party to board',
                starting = 'Starting trip', driving = 'Driving',
                stopping = 'Stopping', ['waiting-for-player-exit'] = 'Waiting for you to step out',
                ['exiting-driver'] = 'Driver leaving the car'}
            status[#status + 1] = readonly('chauffeur-state', 'Companion driver',
                trip.stopPending and 'Stop requested' or tripStates[trip.phase] or trip.phase,
                'Ask a companion to drive to your selected map waypoint.\n\nGet into the passenger seat when they are ready.')
            status[#status + 1] = action('chauffeur:stop', 'Companion driver', 'Stop trip',
                'Stop the trip after returning to gameplay. Wait for the car to stop, then step out before dismissing the driver.',
                function() return queue.stopTrip() end, not trip.stopPending)
        end
        if #status > 0 then categories[#categories + 1] = category('party-status', 'Your group', status) end
        -- One row per copy: its name and number, with Dismiss on the right. A copy
        -- dismissed while the world is paused is dropped from the list at once;
        -- the queue deletes it after gameplay resumes and lists it again with the
        -- reason if the game refuses.
        local copies = {}
        for _, member in ipairs(party) do if member.state ~= 'leaving' then copies[#copies + 1] = member end end
        local shown = #copies
        local first, last, pages = pageRange(shown)
        if pages > 1 then
            for _, row in ipairs(pageRows(first, last, pages, function(index)
                local member = copies[index]
                return member.serial and ((member.baseName or member.name) .. ' #' .. member.serial) or member.name
            end)) do rows[#rows + 1] = row end
        end
        for index = first, last do
            local member = copies[index]
            do
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
        if not canInvite then rows[#rows + 1] = readonly('needs-save', 'Characters and party', 'Load a save first',
                'Inviting characters and managing your party need a loaded game.')
        elseif shown == 0 then rows[#rows + 1] = readonly('empty-party', 'Your party is empty', '', 'Invite someone from Characters or Model browser.') end
        categories[#categories + 1] = category('party', 'Current party', rows)
    elseif view == 'models' then
        local scan, models = snapshot.scan, snapshot.models
        if not canInvite then rows[#rows + 1] = readonly('needs-save', 'Characters and party', 'Load a save first',
                'Inviting characters and managing your party need a loaded game.') end
        -- The list is sorted when the scan has finished; until then only the progress shows, and the page is built once.
        if not scan.finished then
            rows[#rows + 1] = readonly('model-status', 'Reading installed models…', '',
                ui.t(scan.error or '') ~= '' and ui.t(scan.error) or 'Reading installed models…')
        else
            -- A letter group, when there are few enough letters to cycle through: 1 is every model.
            local cache = modelGroups(models)
            local groups = #cache.order <= 40 and cache.order or {}
            local groupElements = {ui.t('All')}
            for _, group in ipairs(groups) do groupElements[#groupElements + 1] = group end
            listGroup = math.max(1, math.min(listGroup, #groupElements))
            local matches = listGroup == 1 and cache.all or cache.lists[groupElements[listGroup]] or {}
            local talking = 0
            for _, model in ipairs(matches) do if model.profileName then talking = talking + 1 end end
            rows[#rows + 1] = readonly('model-status', ui.t('{count} matching models', {count = #matches}), '',
                ui.t('{count} of them can talk.', {count = talking}) .. '\n' .. (ui.t(scan.error) or ''),
                {label = true, description = true})
            if #groups > 0 then
                rows[#rows + 1] = setting('ui:group', 'Starts with', 'select', listGroup, 1,
                    'Show only the models whose name starts with this letter.', groupElements, {elements = true})
            end
            local first, last, pages = pageRange(#matches)
            for _, row in ipairs(pageRows(first, last, pages, function(index) return matches[index].name end)) do rows[#rows + 1] = row end
            for index = first, last do
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
        end
        categories[#categories + 1] = category('models', 'Installed character models', rows)
    elseif view == 'memory' then
        -- The memory controls, then the list the character is chosen from, on the same page.
        categories[#categories + 1] = category('memory', 'Memory', memorySettings(snapshot))
        local profiles = snapshot.profiles
        local first, last, pages = pageRange(#profiles)
        for _, row in ipairs(pageRows(first, last, pages, function(index) return profiles[index].name end)) do rows[#rows + 1] = row end
        for index = first, last do
            local profile = profiles[index]
            local key = profile.key
            rows[#rows + 1] = action('memory:select:' .. key, profile.name,
                snapshot.memory.selectedKey == key and 'Selected' or 'Choose',
                ui.t('Select {name} for memory controls. This does not invite them or change their conversation settings.',{name=profile.name}),
                function() return manager.selectMemoryCharacter(key) end)
        end
        categories[#categories + 1] = category('memory-characters', 'Whose memories', rows)
    elseif view == 'help' and support then
        local where, report = support.locations(), support.status()
        local files = {mod = 'probe.log, mcm.log', bridge = 'bridge.stderr.log', launcher = 'launcher.log',
            cet = 'cyber_engine_tweaks.log', redscript = 'redscript_rCURRENT.log', red4ext = 'red4ext-*.log',
            reports = 'convai-report-*.zip'}
        local rawRow = {value = true, description = true}
        -- Without a running service the path cannot be copied: the row shows the whole path instead, to find the file by hand.
        local copyDescription = report.path
            and (support.copyUnavailableText() or ui.t('Copy the report path to the clipboard so you can paste it into a message.'))
            or ui.t('Create a report first, then copy its path.')
        local lastValue, lastDescription = ui.t('None yet'), ui.t('Choose Generate report. The file name and its folder appear here and in the banner above.')
        if report.path then
            lastValue = report.fileName
            lastDescription = ui.t('Saved at {path}', {path = support.displayPath(report.path)})
            if report.mode == 'lua' then
                lastDescription = lastDescription .. '\n' .. ui.t('This is a short report: the conversation service was not available to build the full one.')
            end
        end
        -- Setup check first (mod/setup-check.lua): the Conversation service row, then one line per check (OK, Problem, Note) whose
        -- help is the one-line fix. Without the module only the service row is shown, as before.
        local setup, setupRows = convaiSetupCheck, {}
        -- No Edge or Chrome for the hidden conversation page: the row says so, and its help says what to install. A service that never
        -- started, or failed for a reason the setup check knows, gets the setup check's fix instead.
        local serviceValue = support.serviceLabel()
        local serviceHelp = support.serviceFault() == 'browser'
            and ui.t('The conversation service needs a Chromium browser such as Microsoft Edge, Google Chrome, Brave or Opera. Install one, or put the path of yours in a browser.txt file next to launcher.ini, then restart the game.')
            or ui.t('The conversation service runs beside the game. If it is not running, restart the game. Its logs are listed below.')
        local setupLines, summary = {}, ''
        if setup then
            local linesOk, lines = pcall(setup.lines)
            if linesOk and type(lines) == 'table' then setupLines = lines end
            local serviceOk, service = pcall(setup.serviceLine)
            if serviceOk and type(service) == 'table' then serviceValue, serviceHelp = service.value, service.description end
            local countOk, problems = pcall(setup.problemCount)
            if countOk and type(problems) == 'number' then
                summary = problems == 0 and ui.t('No problem found. Select a line to see what was checked.')
                    or ui.t('Problems found: {count}. Select a line marked Problem to read what to do.', {count = problems})
            end
        end
        setupRows[#setupRows + 1] = readonly('help-service', 'Conversation service', serviceValue, serviceHelp, {value = true, description = true})
        for _, item in ipairs(setupLines) do
            setupRows[#setupRows + 1] = readonly('setup:' .. item.id, item.label, item.value, item.description, {label = true, value = true, description = true})
        end
        local setupCategory = category('help-setup', 'Setup check', setupRows)
        setupCategory.description = summary   -- already translated
        categories[#categories + 1] = setupCategory
        rows[#rows + 1] = readonly('help-steps', 'What to do', 'Create a report',
            'If a character stops answering, voices stop or an error appears: choose Generate report and send the file it names to the developer, with a short note about what you were doing.\n\nThe logs listed below show what went wrong.')
        categories[#categories + 1] = category('help-trouble', 'If something goes wrong', rows)
        categories[#categories + 1] = category('help-report', 'Report for the developer', {
            action('help:generate', 'Generate report', 'Create',
                'Saves a report file you can send to the developer.\n\nAPI keys, tokens, IDs, microphone audio and conversation text are left out. Without the conversation service, a shorter report is made from the files the game can read.',
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
    elseif view == 'paid-tier' and paidTier then
        for _, section in ipairs(paidTierRows(snapshot)) do categories[#categories + 1] = section end
    elseif view == 'relationships' then
        local rows = relationshipRows(snapshot)
        if #rows > 0 then categories[#categories + 1] = category('relationships', 'Relationships', rows) end
    elseif view == 'settings' then
        local developer = snapshot.settings.developerMode == true
        local choices, languageElements, languageIndex = ui.choices(), {}, 1
        for index, choice in ipairs(choices) do
            languageElements[index] = choice.label
            if choice.value == snapshot.settings.uiLanguage then languageIndex = index end
        end
        categories[#categories + 1] = category('interface', 'Interface', {
            setting('uiLanguage', 'Interface language', 'select', languageIndex, 1,
                'Changes this mod’s menus and notices only.\n\nCharacter voices and the language you talk in are separate.',
                languageElements, {elements=true}),
        })
        local conversations = category('conversation-controls', 'Conversations', {
            action('memory', 'Memory', 'Manage',
                'See what each character remembers and make one or all of them forget.\n\nMemories are kept across saves.',
                function() return navigate('memory') end),
            setting('archetypeConversations', 'Talk to ordinary NPCs', 'bool', snapshot.settings.archetypeConversations ~= false, true,
                'Gang members, NCPD officers, guards, ripperdocs, shopkeepers, bartenders and passers-by answer as their kind of person.\n\nThey do not know your story and forget you after a save load, except shopkeepers you come back to.\n\nNamed characters are not affected.'),
            setting('storyConversations', 'Talk to story characters', 'bool', snapshot.settings.storyConversations == true, false,
                'The game’s own named characters, such as Judy, Jackie, Panam and Rogue, answer when you talk to them where they stand. They use their own voice and memory, and their face follows what they say.\n\nNothing else about them changes: they do not turn, move, gesture or follow. They do not answer during scenes, quest conversations, fights or rides.\n\nTakes effect after you reload your save.'),
            setting('johnnyInHead', 'Johnny in your head', 'bool', snapshot.settings.johnnyInHead == true, false,
                'Johnny Silverhand answers when you use the talk keys with nobody in front of you, as the voice in V’s head. He knows your jobs and your story so far, and what he thinks of you follows it.\n\nOnly while the story has him in V’s head. He stays quiet during scenes, calls, dialogue choices and fights, and when the game gives him a line.'),
            setting('johnnyRemarks', 'Johnny speaks up', 'select',
                snapshot.settings.johnnyRemarks == 'normal' and 3 or snapshot.settings.johnnyRemarks == 'rare' and 2 or 1, 1,
                'Johnny says something on his own after you meet someone he knows of, finish a job, a romance moves on, you arrive somewhere he knows, the Relic acts up, or a big fight ends. Needs Johnny in your head.\n\nRare: at most twice an hour. Normal: at most six times an hour, never closer than five minutes.\n\nOn the Convai free tier each remark uses one of the day’s turns; remarks never take more than a tenth of them.',
                {'Off', 'Rare', 'Normal'}),
            setting('johnnyHologram', 'Johnny’s hologram', 'bool', snapshot.settings.johnnyHologram == true, false,
                'Now and then, when you sit down, Johnny shows himself a few steps away for a few seconds as a glitching hologram, the way the story shows him. Needs Johnny in your head.\n\nNever in scenes, calls, dialogue choices or fights, and at most once every ten minutes.'),
            setting('vTalks', 'V talks on their own', 'select',
                snapshot.settings.vTalks == 'normal' and 3 or snapshot.settings.vTalks == 'rare' and 2 or 1, 1,
                'Now and then V starts a short chat with a companion in your party, and the companion answers. Mostly after a fight or a finished job, sometimes on a quiet walk or ride.\n\nNeeds V’s voice for typed lines; with that off, V stays quiet. Never during scenes, calls, fights or while you talk.\n\nRare: at most twice an hour. Normal: at most six times an hour, never closer than five minutes.\n\nOn the Convai free tier each answer uses one of the day’s turns, counted with Johnny’s remarks, which never take more than a tenth of them.',
                {'Off', 'Rare', 'Normal'}),
            setting('multilingualConversations', 'Multilingual conversations', 'bool', snapshot.settings.multilingualConversations, false,
                'Talk in any language; each character answers in yours.\n\nA separate multilingual copy of each character is used, so what they remember from these talks stays apart from your English ones. Forgetting a character clears both.\n\nPocket and Voxtral speak English only, so this switches the voice to OmniVoice · Balanced, or to Convai · Cloud voice without the OmniVoice pack. Without the pack, Natural speech and Expressive emotions turn off.'),
            setting('autoConnectNearby', 'Auto-connect nearby characters', 'bool', snapshot.settings.autoConnectNearby, true,
                'Gets a conversation ready when you look at, approach or have just talked to a character, so they answer without a wait. Paused in combat and scenes.\n\nLimits: two characters ready at once, a new one every 3 s, released after 40 s unused. A crowd never adds up.'),
            setting('gameDialogueContext', 'Continue from game dialogue', 'bool', snapshot.settings.gameDialogueContext, true,
                'Right after the game’s own dialogue with a character, they know its last few lines, including your chosen replies and your phone calls with them.\n\nOnly the last few minutes count, and none of it is saved to memory.'),
            -- Holocalls start from the mod's Chat tab (docs/HOLOCALL.md); this is their only setting.
            setting('holocallLiveImage', 'Live holocall picture', 'bool', snapshot.settings.holocallLiveImage == true, true,
                'Shows the character live in a holocall instead of their portrait.\n\nIf she cannot be shown, the call goes on with the portrait.'),
        })
        -- Who speaks as a partner: a page of its own (one row per character who can), a button beside Memory, so Conversations stays short.
        if #relationshipRows(snapshot) > 0 then
            table.insert(conversations.settings, 2, action('relationships', 'Relationships', 'Open',
                'Choose, character by character, who speaks to V as a partner.\n\nAuto follows the relationship in this save. It only changes how they talk, never your game choices.',
                function() return navigate('relationships') end))
        end
        -- Johnny's standing in this save's story, right under his setting while it is on (read from the save as the page is drawn).
        local standing = johnnyStandingRow(snapshot)
        if standing then
            for index, row in ipairs(conversations.settings) do
                if row.id == 'johnnyInHead' then table.insert(conversations.settings, index + 1, standing); break end
            end
        end
        -- Not released yet (the user, 2026-10-20: the next update ships without them): Johnny's hologram and V talks on their own are
        -- shown only in developer mode. Both are Off by default, so a player never meets them.
        if not developer then
            for index = #conversations.settings, 1, -1 do
                local id = conversations.settings[index].id
                if id == 'johnnyHologram' or id == 'vTalks' then table.remove(conversations.settings, index) end
            end
        end
        categories[#categories + 1] = conversations
        -- Settings > Conversation provider: who writes the replies, Mature content, Local AI and the provider keys.
        local providerRows = ownKeyRows(snapshot)
        categories[#categories + 1] = category('conversation-provider', 'Conversation provider', providerRows)

        local heights,strengths=manager.gazeChoices()
        local heightIndex,strengthIndex=3,3
        for index,value in ipairs(heights) do if snapshot.settings.eyeContactHeight==value then heightIndex=index end end
        for index,value in ipairs(strengths) do if snapshot.settings.headFollowStrength==value then strengthIndex=index end end
        categories[#categories + 1] = category('companion-behavior', 'Companion behavior', {
            setting('eyeContactHeight', 'Eye contact height', 'select', heightIndex, 3,
                'Use it if companions seem to look above or below your eyes.',
                {'10 cm lower', '5 cm lower', 'Default', '5 cm higher', '10 cm higher'}),
            setting('headFollowStrength', 'Head tracking strength', 'select', strengthIndex, 3,
                'Eyes only: the head stays still and just the eyes move.\n\nSubtle to Strong: the head turns toward you more and more.',
                {'Eyes only', 'Subtle', 'Gentle (default)', 'Strong'}),
            setting('bodyGestures', 'Body gestures', 'bool', snapshot.settings.bodyGestures, true,
                'Companions gesture while they speak longer replies and nod while you talk, with the game’s own animations in their usual stance.\n\nThey stop at once when anyone moves or a fight starts.'),
        })
        local voiceStatus = voiceStatusText(snapshot)
        local voiceStatusHelp = support and support.serviceFault() == 'browser'
            and ui.t('The conversation service needs a Chromium browser such as Microsoft Edge, Google Chrome, Brave or Opera. Install one, or put the path of yours in a browser.txt file next to launcher.ini, then restart the game.')
            or ui.t('A change takes effect after the current reply. No game restart is needed.')
        -- The list: Pocket Performance (the default), the Mistral cloud voice (Voxtral, recommended), OmniVoice Balanced / Quality (16 steps,
        -- short / long reference), High Quality / Ultra Quality (32 steps, short / long reference), Convai Cloud voice.
        local voiceIndex = savedVoiceIndex(snapshot.settings)
        -- Lip sync delay (Bluetooth): Auto, Off, then milliseconds (bridge/audio-delay.mjs).
        local delays, delayLabels, delayIndex = manager.audioDelayChoices(), {}, 1
        for index, value in ipairs(delays) do
            delayLabels[index] = value == 'auto' and ui.t('Auto') or value == 0 and ui.t('Off') or (tostring(value) .. ' ms')
            if snapshot.settings.audioDelay == value then delayIndex = index end
        end
        local voiceRange = manager.voiceVolumeRange()
        local pack = manager.omniPack()
        -- While the OmniVoice pack is missing its entries are greyed out; the row's name says why, in brackets.
        local voiceName = ui.t('Companion voices')
        if pack.known and not pack.installed then voiceName = voiceName .. ' (' .. ui.t('no Omni pack') .. ')' end
        local voicesCategory = category('voices', 'Voices', {
            setting('voice', 'Voice playback', 'bool', snapshot.settings.voice, true, 'Off: replies are text only and no voice is generated.\n\nWith Subtitles off as well, automatic reactions stay silent.'),
            setting('voiceProvider', voiceName, 'select', voiceIndex, 1,
                'Pocket: the lightest, runs on your CPU, starts speaking in about 0.2 s.\n\nOmniVoice: richer, especially on harder voices. Needs a capable GPU and the OmniVoice pack (greyed out until it is installed); the higher tiers start in 1 to 2.5 s.\n\nVoxtral: each companion’s own voice from the cloud, with your own Mistral key, English only. It loads no local voice model.\n\nConvai: its own cloud voice. A voice that cannot run is replaced by a simpler one, with one notice.',
                voiceMenuLabels(pack, snapshot.mistral), {elements = true, label = true}),
            readonly('voice-status', 'Voice status', voiceStatus, voiceStatusHelp, {description = true}),
            setting('audioDelay', 'Lip sync delay (Bluetooth)', 'select', delayIndex, 1,
                'Bluetooth audio arrives a little late, so lips and subtitles can run ahead of the voice. This holds them back to match, for every voice.\n\nAuto: 150 ms while Windows plays through Bluetooth, none otherwise. Pick a value if your headset is faster or slower.\n\nThe game’s own dialogue has the same delay and does not correct it.',
                delayLabels, {elements = true}),
            -- A slider, 50 to 200 in steps of 5; the page shows its number, so the unit is in the name. The bridge applies it to every voice
            -- (companions, NPCs, add-ons and V's typed lines) as gain behind a peak limiter; it takes effect on the next reply.
            setting('voiceVolume', 'Voice volume (%)', 'int', snapshot.settings.voiceVolume, voiceRange.default,
                'How loud the mod’s voices are, for companions, characters and V’s typed lines. 100 is the normal level.\n\nAbove 100 the voices get louder, with a limiter so they do not crackle. The game’s own dialogue and sounds do not change.\n\nThe next reply uses it.',
                nil, {min = voiceRange.min, max = voiceRange.max, step = voiceRange.step}),
            setting('naturalSpeech', 'Natural speech', 'bool', snapshot.settings.naturalSpeech, false,
                'Companions now and then pause, hesitate, laugh or sigh, as their personality would. Each character decides when; it stays rare.\n\nOmniVoice can voice laughs and sighs; the other voices only add pauses.\n\nNot available with Convai’s cloud voice: choosing it turns this off, and turning this on switches the voice to Pocket.'),
            setting('expressiveEmotions', 'Expressive emotions', 'bool', snapshot.settings.expressiveEmotions, true,
                'Each character marks its own feelings as it speaks, so the face changes at that word instead of being guessed from the text. Subtle, set by personality, only where a feeling really shifts.\n\nNot available with Convai’s cloud voice: choosing it turns this off, and turning this on switches the voice to Pocket.'),
            setting('followUpInterest', 'Follow-up questions', 'bool', snapshot.settings.followUpInterest, true,
                'Characters sometimes ask about something you said, pick up something from earlier or share a thought that invites an answer.\n\nNow and then, never on every reply, and never while you are leaving, giving an order or fighting.'),
            setting('vVoice', 'V’s voice for typed lines', 'bool', snapshot.settings.vVoice, true,
                'When you type a line, V says it out loud too, in the male or female V voice that matches yours. Push-to-talk is never replayed.\n\nV speaks first, then the companion answers. A slow V line is skipped, so the reply is never delayed. The line always shows as a subtitle.\n\nThe voice that speaks it is chosen in the next row.'),
            setting('vVoiceEngine', 'V’s voice engine', 'select', snapshot.settings.vVoiceEngine == 'voxtral' and 2 or 1, 1,
                'Pocket: runs on your processor and starts in about 0.2 s. If the companions use another voice, it loads its own small voice model just for V.\n\nVoxtral: made in the cloud with your Mistral key, so nothing loads on your PC. Starts in about a second. English only, and not with Mature content on.\n\nWhichever you pick, a line that is not ready in time is skipped.',
                {ui.t('Pocket · On your PC'), (snapshot.mistral or {}).saved and ui.t('Voxtral · Mistral cloud') or ui.t('Voxtral · needs Mistral key')},
                {elements = true}),
        })
        for _, voiceRow in ipairs(voicesCategory.settings) do
            if voiceRow.id == 'voiceProvider' and next(voiceDisabledShown) then voiceRow.disabledElements = voiceDisabledShown end
        end
        categories[#categories + 1] = voicesCategory
        categories[#categories + 1] = category('subtitles', 'Subtitles', {
            setting('subtitles', 'Subtitles', 'bool', snapshot.settings.subtitles, true, 'Shows companion replies as text.\n\nWith Voice playback off as well, automatic reactions stay silent.'),
            setting('subtitleStyle', 'Subtitle display', 'select', snapshot.settings.subtitleStyle == 'overhead' and 2 or 1, 1,
                'Cinematic: the game’s regular dialogue subtitles.\n\nAbove the speaker: over the companion who is talking.\n\nThe Subtitles switch turns both off.',
                {'Cinematic subtitles', 'Above the speaker'}),
        })
        categories[#categories + 1] = category('reactions', 'Automatic reactions', {
            setting('battleReactions', 'React to battles', 'bool', snapshot.settings.battleReactions, false,
                'A nearby companion makes one short comment as combat starts and another afterward.\n\nTen-minute cooldown after a fight. Conversations and story scenes come first. Loading a save resets the cooldown.'),
            setting('lootReactions', 'React to collected loot', 'bool', snapshot.settings.lootReactions, false,
                'Companions comment after you finish collecting loot from the world. Storage transfers stay silent.\n\nOrdinary comments are ten minutes apart; newly acquired Legendary gear has its own two-minute cooldown.\n\nPickups made during a fight are folded into one comment at its end.'),
        })
        -- One section per installed add-on that has settings (docs/ADDON_API.md). The add-on wrote its own labels.
        if convaiAddons and convaiAddons.live then
            local own = {label = true, description = true, elements = true}
            for _, section in ipairs(convaiAddons.settingsSections()) do
                local list = {}
                for _, item in ipairs(section.items) do
                    list[#list + 1] = setting(item.rowId, item.label, item.kind, item.value, item.default, item.description,
                        item.elements, own)
                end
                categories[#categories + 1] = {id = section.id, name = section.title, description = section.description, settings = list}
            end
        end
        -- Automatic error reports (docs/ERROR_REPORTS.md, mod/error-reports.lua): on by default; the help says what is sent and what never is.
        categories[#categories + 1] = category('privacy', 'Privacy', {
            setting('errorReports', 'Send error reports automatically', 'bool', snapshot.settings.errorReports ~= false, true,
                'When something in the mod goes wrong, a short report goes to the developer so it can be fixed without asking you for logs. At most five a day.\n\nIt holds the error, the mod and requirement versions, your provider and voice choices, whether Mature content is on, your graphics card, the setup check and the log lines around the error. If replies stay slow, it also holds how long a few recent replies took, stage by stage.\n\nIt never holds keys, what you or the characters say, memories, audio or your Windows user name.'),
        })
        local development = {
            setting('developerMode', 'Developer mode', 'bool', snapshot.settings.developerMode, false,
                'For testing and bug reports; leave it off for normal play.\n\nShows routine popups (joining steps, dismissals, driving instructions, results of companion actions), writes a movement trace in the mod’s runtime folder, logs gesture decisions and adds itself to support reports.\n\nPreparation progress, joined notices, failures and replies to Stop trip stay visible when it is off.'),
        }
        categories[#categories + 1] = category('development', 'Development', development)
        if support then
            categories[#categories + 1] = category('help', 'Help', {
                action('help', 'Help and support', 'Open',
                    'Find the log files and create a report to send to the developer if something goes wrong.',
                    function()
                        -- The setup check runs again from the next slow update (never inside this menu callback).
                        if convaiSetupCheck then pcall(convaiSetupCheck.refresh) end
                        return navigate('help')
                    end),
            })
        end
    end
    -- The line of the last action (or of an invitation being prepared) sits under the way back.
    local feedback = M.feedback()
    if feedback then
        nav[#nav + 1] = readonly('feedback', feedback, '', feedback, {label = true, description = true})
    end
    table.insert(categories, 1, category('navigation', LABEL, nav))
    return {name = ui.t(LABEL), description = ui.t('Your companions, character models and conversation settings.'), categories = categories}
end
function M.configure(domain, companions, queueFactory, readiness)
    manager, queue = domain, queueFactory.new(companions, readiness, {developerMode = domain.developerMode})
    -- Any change to the queue is flushed by the next frame, not by the next slow tick.
    for _, method in ipairs({'invite', 'dismiss', 'dismissCharacter', 'undoDismiss', 'assign', 'gameVoice', 'stopTrip'}) do
        local original = queue[method]
        if type(original) == 'function' then
            queue[method] = function(...) flushDue = true; return original(...) end
        end
    end
    -- Developer-mode probe rows (runtime/perf-probe.json): where the manager spends its time.
    pcall(function()
        local probe = convaiPerfProbe
        if type(probe) ~= 'table' or type(probe.watch) ~= 'function' then return end
        probe.watch(queue, 'flush', 'manager.queue.flush')
        probe.watch(M, 'slowUpdate', 'manager.slow')
        probe.watch(M, 'tick', 'manager.tick')
    end)
    if supportLoaded and type(supportFactory) == 'table' and type(supportFactory.new) == 'function' then
        local created, instance = pcall(supportFactory.new, {ui = ui, party = function() return queue.list() end,
            developerMode = function() return developerMode() end})
        if created and type(instance) == 'table' then support = instance end
    end
    if editorLoaded and type(editorFactory) == 'table' and type(editorFactory.new) == 'function' then
        local created, instance = pcall(editorFactory.new, {ui = ui,
            serviceState = function() return support and support.serviceState() or 'unknown' end,
            -- The character V faces and the list of the player's own characters live in init.lua (globals): asked once, when Open is chosen.
            facing = function() return type(convaiFacingCharacter) == 'function' and convaiFacingCharacter() or nil end,
            watch = function() if convaiCustomCharacters then convaiCustomCharacters.watch() end end})
        if created and type(instance) == 'table' then editor = instance end
    end
    if paidTierLoaded and type(paidTierFactory) == 'table' and type(paidTierFactory.new) == 'function' then
        local created, instance = pcall(paidTierFactory.new, {ui = ui})
        if created and type(instance) == 'table' then paidTier = instance end
    end
    local customFactory = customProvider.factory
    if type(customFactory) == 'table' and type(customFactory.new) == 'function' then
        local created, instance = pcall(customFactory.new, {ui = ui, writeCommand = manager.writeCommand, session = manager.commandSession})
        customProvider.instance = created and type(instance) == 'table' and instance or nil
    end
end

M.LABEL, M.PAGE_SIZE = LABEL, PAGE_SIZE

-- ---- What the host (mod/nsui.lua) calls -------------------------------------------------------------------------------------------

local PAGES = {home = true, characters = true, party = true, models = true, settings = true, memory = true, help = true, ['paid-tier'] = true,
    relationships = true}

function M.view() return view end

-- The page on screen as one short text (the view, the page of its long list and the letter group): a host that scrolls to the top on a
-- new page compares it.
function M.pageId() return view .. '|' .. tostring(listPage) .. '|' .. tostring(listGroup) end

-- The page to show. The manager opens on Home (the host calls this when the screen opens). Returns whether anything changed.
function M.setView(name)
    if not PAGES[name] or (name == 'help' and not support) or (name == 'paid-tier' and not paidTier) then name = 'home' end
    local changed = name ~= view or listPage ~= 1 or listGroup ~= 1
    view, listPage, listGroup = name, 1, 1
    if changed then actionFeedback, preparationActionFeedback = nil, false; refreshQueued = true end
    return changed
end

-- The line under the way back: an invitation being prepared, the paid tier's progress, or the result of the last action.
function M.feedback()
    local text
    if preparationStatus then text = preparationStatus.message
    elseif paidStatus and view == 'paid-tier' then text = paidStatus
    else text = actionFeedback end
    if type(text) ~= 'string' or text == '' then return nil end
    return text
end

function M.setFeedback(text)
    if text ~= actionFeedback then actionFeedback = text; refreshQueued = true end
end

-- The page as sections of rows (see the top of this file): {name, description, categories = {{id, name, settings = rows}}}.
function M.model() return schema() end

-- Whether the page on screen is out of date: something forced a redraw, or what it shows has changed. True once per change.
function M.stale()
    if refreshQueued or lastSignature ~= renderedSignature then
        refreshQueued = false
        return true
    end
    return false
end

function M.refresh() refreshQueued = true end

-- A button was pressed. Returns {ok, error}; the result is the page's feedback line.
function M.invoke(id)
    local callback = actions[id]
    if not callback then
        actionFeedback = ui.t('Reopen the manager; that action is no longer available.')
        refreshQueued = true
        return {ok = false, error = actionFeedback}
    end
    if disabledActions[id] then
        actionFeedback = ui.t('Not available right now.')
        refreshQueued = true
        return {ok = false, error = actionFeedback}
    end
    local called, ok, reason, invitationId = pcall(callback)
    if not called then
        ok, reason = false, ui.t('The action could not finish: {reason}', {reason = tostring(ok):sub(1, 160)})
        lastError = tostring(reason)
    end
    actionFeedback = reason ~= nil and ui.t(reason) or nil
    preparationActionFeedback = false
    -- A paid tier action's text stays on the status line and follows the answer (followPaidStatus), not the redraw of the page.
    if id:match('^paid:') and ok == true and actionFeedback then
        paidStatus, paidStatusUntil = actionFeedback, os.clock() + 420
    else
        paidStatus, paidStatusUntil = nil, nil
    end
    if id:match('^invite:') and type(invitationId) == 'string' then
        local board = invitationBoard()
        if board then board.track(invitationId, 'manager') end
    end
    if ok == true and id:match('^invite:') then
        preparationTarget = true
        preparationStatus, preparationAt, preparationActionFeedback = nil, 0, true
    elseif ok ~= true or reason ~= nil then
        -- Navigation has no result message and leaves progress visible.
        -- A memory, dismissal or trip action owns its own result banner.
        preparationTarget, preparationStatus = nil, nil
    end
    memoryActionCommand = nil
    if ok == true and id:match('^memory:confirm:') then
        local command = manager.snapshot(player()).memory.command
        memoryActionCommand = command and command.id or nil
    end
    refreshQueued = true
    return {ok = ok == true, error = ok ~= true and ui.t(reason) or nil}
end

-- A page control (the page slider of a long list, the letter group of the model browser) moved. Returns whether the page changed.
function M.setUi(id, value)
    local number = math.floor(tonumber(value) or 1)
    if id == 'ui:page' then
        if number == listPage then return false end
        listPage = math.max(1, number)
    elseif id == 'ui:group' then
        if number == listGroup then return false end
        listGroup, listPage = math.max(1, number), 1
    else return false end
    refreshQueued = true
    return true
end

-- The saved value of every Settings row the player can change that is not at its default, as a batch for M.apply: Restore defaults.
-- The Local AI model has no default of its own (nothing chosen: the largest that fits), so it goes to the model shown as the default.
function M.defaults()
    local previous = view
    local changes = {}
    -- Settings, and the Relationships page that opens from it.
    for _, name in ipairs({'settings', 'relationships'}) do
        view = name
        local ok, model = pcall(schema)
        if not ok then lastError = tostring(model); break end
        for _, section in ipairs(model.categories) do
            for _, row in ipairs(section.settings) do
                local kind = row.type
                if (kind == 'bool' or kind == 'select' or kind == 'int') and row.defaultValue ~= nil and not row.id:match('^ui:') then
                    local target = row.defaultValue
                    if row.id == 'localModel' then target = modelIndexOf('auto') or row.value end
                    if row.value ~= target then changes[#changes + 1] = {id = row.id, value = target} end
                end
            end
        end
    end
    -- Drawing the other pages replaced the page's actions and signature: the page on screen is built again.
    view = previous
    pcall(schema)
    return changes
end

-- Applies a batch of changes as ONE validated, saved transaction (manager.applySettings), with what Mature content needs added or put
-- back. `changes` is a list of {id, value}: a switch's boolean, a list's position, a slider's number. Returns
-- {ok, error, notice, reload, names, ids}: `notice` is the sentence for a voice that was switched; `names` what was changed besides
-- the player's own choices; `error` the reason when nothing was saved (a refusal leaves every setting as it was).
function M.apply(changes)
    local currentPlayer = player()
    local snapshot = manager.snapshot(currentPlayer)
    local batch, record, names, refusal = stageMature(changes, snapshot)
    local values, applied = {relationshipModes = {}}, {}
    -- Add-on settings (docs/ADDON_API.md) are held until the main settings save succeeds.
    local addonChanges = 0
    if convaiAddons and convaiAddons.live then convaiAddons.discardSettings() end
    local function refused(text)
        if addonChanges > 0 then convaiAddons.discardSettings() end
        actionFeedback = ui.t(text)
        refreshQueued = true
        return {ok = false, error = actionFeedback}
    end
    for _, change in ipairs(batch) do
        local key = change.id
        if key == 'voice' or key == 'subtitles' or key == 'developerMode'
            or key == 'battleReactions' or key == 'lootReactions' or key == 'bodyGestures'
            or key == 'autoConnectNearby' or key == 'holocallLiveImage' or key == 'naturalSpeech'
            or key == 'gameDialogueContext'
            or key == 'expressiveEmotions' or key == 'followUpInterest' or key == 'vVoice' or key == 'multilingualConversations'
            or key == 'matureContent' or key == 'errorReports' then values[key] = change.value
        elseif key == 'voiceVolume' then
            if type(change.value) ~= 'number' then return refused('Choose a voice volume from 50 to 200 percent.') end
            values.voiceVolume = change.value
        elseif key == 'audioDelay' then
            local delays = manager.audioDelayChoices()
            if type(change.value) ~= 'number' or change.value ~= math.floor(change.value) or not delays[change.value] then
                return refused('Choose one of the listed lip sync delays.')
            end
            values.audioDelay = delays[change.value]
        elseif key == 'conversationProvider' then
            -- Order: 1 Convai free tier (stored 'convai', own key off), 2 Convai API key (stored 'convai', own key on), 3 Mistral
            -- (stored 'mistral'), 4 Local (stored 'local'), 5 Custom (stored 'custom'). The own-key choice only changes with a Convai
            -- entry, so it comes back when the player returns to Convai from Mistral, Local or Custom.
            local providers = {'convai', 'convai', 'mistral', 'local', 'custom'}
            local provider = type(change.value) == 'number' and providers[change.value] or nil
            if not provider then return refused('Choose one of the listed conversation providers.') end
            values.conversationProvider = provider
            if change.value == 1 or change.value == 2 then values.useOwnConvaiKey = change.value == 2 end
        elseif key == 'localModel' then
            -- Order: each installed model in the bridge's list, smallest file first (stored by its id).
            local choices = manager.localModelChoices()
            local choice = type(change.value) == 'number' and choices[change.value] or nil
            if not choice then return refused('Choose one of the listed Local AI models.') end
            values.localModel = choice.id
        elseif key == 'subtitleStyle' then
            if change.value ~= 1 and change.value ~= 2 then return refused('Choose one of the listed subtitle displays.') end
            -- Order: 1 Cinematic subtitles (stored 'dialogue'), 2 Above the speaker (stored 'overhead').
            values.subtitleStyle = change.value == 1 and 'dialogue' or 'overhead'
        elseif key == 'uiLanguage' then
            local choices = ui.choices()
            if type(change.value) ~= 'number' or change.value ~= math.floor(change.value) or not choices[change.value] then
                return refused('Choose an interface language.')
            end
            values.uiLanguage = choices[change.value].value
        elseif key == 'vVoiceEngine' then
            -- Order: 1 Pocket (stored 'pocket'), 2 Voxtral (stored 'voxtral', needs the Mistral key).
            if change.value ~= 1 and change.value ~= 2 then return refused('Choose one of the listed voices for V.') end
            if change.value == 2 and not manager.mistral().saved then
                return refused('Requires a Mistral key (add it in Settings > Conversation provider)')
            end
            values.vVoiceEngine = change.value == 2 and 'voxtral' or 'pocket'
        elseif key == 'voiceProvider' then
            local choice = type(change.value) == 'number' and VOICE_CHOICES[change.value] or nil
            if not choice then return refused('Choose one of the listed companion voices.') end
            -- Without the optional pack an OmniVoice entry cannot be applied: nothing changes and the
            -- player is told what it needs.
            if choice.provider == 'omni' and not manager.omniPack().installed then
                return refused('Requires the optional OmniVoice pack (GPU)')
            end
            -- Likewise the Mistral cloud voice needs a Mistral key (it works with any conversation provider).
            if choice.provider == 'voxtral' and not manager.mistral().saved then
                return refused('Requires a Mistral key (add it in Settings > Conversation provider)')
            end
            values.voiceProvider = choice.provider
            if choice.provider == 'omni' then values.omniSteps, values.omniReference = choice.steps, choice.reference end
        elseif key == 'eyeContactHeight' or key == 'headFollowStrength' then
            local heights, strengths = manager.gazeChoices()
            local choices = key == 'eyeContactHeight' and heights or strengths
            if type(change.value) ~= 'number' or change.value ~= change.value or change.value < 1 or change.value > #choices
                or change.value ~= math.floor(change.value) then
                return refused('Choose an eye contact option.')
            end
            values[key] = choices[change.value]
        elseif key:sub(1, 13) == 'relationship:' then
            if change.value ~= 1 and change.value ~= 2 and change.value ~= 3 then
                return refused('Choose one of the listed relationship options.')
            end
            values.relationshipModes[key:sub(14)] = ({'auto', 'on', 'off'})[change.value]
        elseif key == 'archetypeConversations' then values.archetypeConversations = change.value
        elseif key == 'storyConversations' then values.storyConversations = change.value
        elseif key == 'johnnyInHead' then values.johnnyInHead = change.value
        elseif key == 'johnnyRemarks' then
            if change.value ~= 1 and change.value ~= 2 and change.value ~= 3 then return refused('Choose how often Johnny speaks up.') end
            -- Order: 1 Off, 2 Rare, 3 Normal.
            values.johnnyRemarks = ({'off', 'rare', 'normal'})[change.value]
        elseif key == 'johnnyHologram' then values.johnnyHologram = change.value
        elseif key == 'vTalks' then
            if change.value ~= 1 and change.value ~= 2 and change.value ~= 3 then return refused('Choose how often V talks on their own.') end
            -- Order: 1 Off, 2 Rare, 3 Normal.
            values.vTalks = ({'off', 'rare', 'normal'})[change.value]
        elseif key:sub(1, 6) == 'addon:' and convaiAddons and convaiAddons.live then
            local staged, problem = convaiAddons.stageSetting(key, change.value)
            if not staged then convaiAddons.discardSettings(); return refused(problem) end
            addonChanges = addonChanges + 1
        else return refused('That setting is read-only.') end
        applied[#applied + 1] = key
    end
    -- Turning Mature content on in this batch: what that staged is kept in the settings, so turning it off can undo it.
    if values.matureContent == true and record then values.matureRestore = record end
    local ok, err, notice, reload
    if addonChanges > 0 and addonChanges == #applied then ok = true
    else ok, err, notice, reload = manager.applySettings(currentPlayer, values) end
    if addonChanges > 0 then
        if ok then convaiAddons.commitSettings() else convaiAddons.discardSettings() end
    end
    -- What the player is told (the page's feedback line): the refusal, the voice that was switched, or what Mature content changed.
    local text
    if not ok then text = ui.t(err)
    elseif refusal then text = refusal
    elseif notice then text = notice
    elseif #names > 0 then text = ui.t('Also changed: {names}.', {names = table.concat(names, ', ')}) end
    actionFeedback = text
    refreshQueued = true
    return {ok = ok == true, error = not ok and ui.t(err) or nil, notice = notice, reload = reload == true, names = names,
        refusal = refusal, ids = ok and applied or {}}
end

local function paidTierOutcome(event, currentPlayer)
    if event == 'timeout' then
        return {id = 'paid-tier-pending', text = ui.t('Convai has not confirmed your plan yet. Check it in Settings > Convai paid tier.')}
    end
    local settings = manager.snapshot(currentPlayer).settings
    if settings.conversationProvider == 'convai' and settings.useOwnConvaiKey == true then
        return {id = 'paid-tier-active', text = ui.t('Your Convai plan is active.')}
    end
    local ok, saved = pcall(manager.applySettings, currentPlayer, {conversationProvider = 'convai', useOwnConvaiKey = true})
    if ok and saved then
        refreshQueued = true
        return {id = 'paid-tier-active', text = ui.t('Your Convai plan is active. Conversations now use your Convai API key.')}
    end
    return {id = 'paid-tier-active', text = ui.t('Your Convai plan is active. Choose Convai API key in Settings > Conversation provider.')}
end

function M.slowUpdate(currentPlayer, worldReady)
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
    if support then
        -- A finished report is announced once, in gameplay (a paused menu hides popups).
        local reportOk, reportNotice = pcall(support.update, worldReady == true)
        if reportOk and reportNotice then messages[#messages + 1] = {id = 'support-report-saved', text = reportNotice} end
    end
    -- Convai paid tier: once Convai confirms a plan bought (or checked) on the page, conversations move to the player's own key through the
    -- Conversation provider's "Convai API key" entry, and one notice says so in gameplay. Costs nothing while no purchase is followed.
    if paidTier and paidTier.following() then
        local followed, event = pcall(paidTier.update)
        if followed and event then paidNotice = paidTierOutcome(event, currentPlayer) end
    end
    if worldReady and paidNotice then
        log(paidNotice.text)
        messages[#messages + 1] = paidNotice
        paidNotice = nil
    end
    -- Setup check (mod/setup-check.lua): one notice at the first load when something critical is wrong (with or without Native
    -- Settings UI), and the Help page's re-check. A few comparisons until something is due.
    if convaiSetupCheck then
        local checked, setupNotice = pcall(convaiSetupCheck.tick, worldReady == true, currentPlayer ~= nil)
        if checked and setupNotice then log(setupNotice); messages[#messages + 1] = {id = 'setup-problem', text = setupNotice} end
    end
    -- Automatic error reports (mod/error-reports.lua): the one notice that says they are sent, once, in gameplay. One test once decided.
    if convaiErrorReports then
        local ticked, reportsNotice = pcall(convaiErrorReports.tick, worldReady == true)
        if ticked and reportsNotice then log(reportsNotice); messages[#messages + 1] = {id = 'error-reports-on', text = reportsNotice} end
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
    -- A slow component loading (the OmniVoice voice after a switch or at start, Local AI warming up): one notice that stays up
    -- until the "ready" or failure line replaces it (convaiNotices.loading holds it on the game's warning line and refreshes it
    -- rarely). The board reads the state at most once a second while nothing loads.
    local releaseLoading = false
    if type(convaiNotices) == 'table' and type(convaiNotices.loading) == 'function' and type(manager.loadStatus) == 'function' then
        loadBoard = board
        local lines, release = convaiNotices.loading(worldReady == true, LOAD_KEYS, readLoads, loadingText)
        releaseLoading = release == true
        if lines then
            for _, line in ipairs(lines) do
                if line.phase == 'loading' then messages[#messages + 1] = {id = 'load-progress', text = line.text, instant = line.instant, mask = line.mask, sig = line.sig}
                elseif line.phase == 'ready' then messages[#messages + 1] = {id = 'load-ready', text = line.text}
                else messages[#messages + 1] = {id = 'load-failed', text = line.text} end
            end
        end
    end
    if #messages > 0 and currentPlayer then
        -- The same native neutral warning channel used by phone invitations, through the one
        -- notice gate (notices.lua): each line is shown or dropped by its class.
        -- Calls happen only here in top-level update, never inside a Native Settings UI callback.
        local sent = convaiNotices.sendLines(currentPlayer, messages) > 0
        if sent and progress then progress.commit() end
    end
    -- The loads ended without an outcome line (cancelled, or an outcome too old): take the held notice down, unless a newer
    -- notice has already replaced it.
    if releaseLoading and type(convaiNotices.release) == 'function' then convaiNotices.release(currentPlayer) end
end

-- Called by the host every frame while the manager's page is on screen, and never otherwise. M.stale() says whether the page has to be
-- drawn again.
function M.tick(currentPlayer)
    -- The model scan runs a bounded batch a frame while the Model browser is shown; the page follows when it has finished.
    if view == 'models' then manager.scanModels() end
    local now = os.time()
    if now >= snapshotAt then
        snapshotAt = now + 1
        local snapshot = manager.snapshot(currentPlayer)
        local memory = snapshot.memory
        if memory.command and memory.command.id == memoryActionCommand then actionFeedback = memory.feedback end
        if support and view == 'help' then
            -- The Help page's line follows the report state.
            local reportSignature = support.signature()
            if reportSignature ~= supportSignature then
                supportSignature = reportSignature
                actionFeedback = support.banner() or actionFeedback
            end
        end
        local followed, followError = pcall(followPaidStatus)
        if not followed then lastError = 'Paid tier status: ' .. tostring(followError); paidStatus, paidStatusUntil = nil, nil end
        lastSignature = pageSignature(snapshot)
    end
end

-- The per-frame call of init.lua's update, with the screen closed or open: the slow tick (a quarter of a second) and a few
-- comparisons.
function M.update(currentPlayer, worldReady)
    local withoutWorld = currentPlayer == nil and worldReady == false
    if withoutWorld ~= noWorld then noWorld, refreshQueued = withoutWorld, true end
    local clock = os.clock()
    if worldReady ~= lastWorldReady then lastWorldReady, slowAt = worldReady, 0 end
    if flushDue or clock >= slowAt or slowAt - clock > SLOW_PERIOD * 2 then
        flushDue, slowAt = false, clock + SLOW_PERIOD
        M.slowUpdate(currentPlayer, worldReady)
    end
    if ui.revision() ~= localeRevision then localeRevision, refreshQueued = ui.revision(), true end
    local now = os.time()
    if now >= preparationAt then
        preparationAt = now + 1
        samplePreparationFeedback()
    end
end

function M.inspect()
    return {view = view, listPage = listPage, listGroup = listGroup, party = queue.list(), feedback = queue.message(),
        shown = M.feedback(), error = lastError, paidStatus = paidStatus, paidStatusPending = paidStatusUntil ~= nil,
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
    paidStatus, paidStatusUntil = nil, nil
    memoryActionCommand = nil
    preparationTarget, preparationStatus, preparationActionFeedback, preparationAt = nil, nil, false, 0
    owner, lastSignature, renderedSignature, refreshQueued = nil, '', '', true
    slowAt, lastWorldReady = 0, nil
    if type(convaiNotices) == 'table' and type(convaiNotices.resetLoading) == 'function' then convaiNotices.resetLoading() end
    view, listPage, listGroup = 'home', 1, 1
end

function M.shutdown()
    queue.bind(nil)
    if preparationActionFeedback then actionFeedback = nil end
    preparationTarget, preparationStatus, preparationActionFeedback, preparationAt = nil, nil, false, 0
end

return M
