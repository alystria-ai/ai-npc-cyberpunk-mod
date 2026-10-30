local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end
-- Companion Manager pages, actions and settings, with no knowledge of the screen that shows them. mod/nsui.lua is the host: it puts
-- the pages built here into Native Settings UI and turns a widget change or a button press back into the calls below. Everything a
-- page shows is a row of one of four kinds (the same shapes the pages always had, so a row added for a provider is one more
-- `setting(...)`, `action(...)` or `readonly(...)` call and needs nothing from the host):
--   setting  type bool | select | int   a change is applied through M.apply (one validated transaction, manager.applySettings)
--   action   type action                a button: its text is `value`; M.invoke runs it
--   readonly type string                a line of text: `label` and `value`
-- Nothing here runs per frame: M.update does a few comparisons, and the page is built when it opens or when something it shows changes.
local M = {}
-- The category pages of Settings (built further down, where their rows are): declared here because the page signature below asks which views are Settings pages.
local settingsPages = {byView = {}}
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
local LABEL = 'Companion Manager'
-- Rows per page of a long list (the characters to invite, the model browser, the memory picker and a large party). The pages are
-- read with one slider; a list never puts more than this many widgets on the screen.
local PAGE_SIZE = 12
local manager, queue
-- view: the page shown. listPage / listGroup: the page of its long list and the letter group of the model browser.
local view, listPage, listGroup = 'home', 1, 1
-- The Model browser's search: the text a host handed over (M.setSearch) and its words, whether the host offers a search box at all
-- (M.offerSearch), and the list worked out for that text (see searchedModels).
local modelFind = {text = '', words = {}, offered = false, typed = ''}
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
-- The entries of that list that cannot be chosen now (OmniVoice while its pack is missing, Voxtral beside Mature content), by position: M.apply refuses
-- them. A host that can grey an entry out reads them from the row (`disabledElements`); a value that is a string is that entry's own reason.
local voiceDisabledShown = {}
-- Help page: log locations and the shareable support report. Optional: the manager works without it, and a load failure only hides
-- the Help entry.
local support, supportSignature
local supportLoaded, supportFactory = pcall(dofile, 'support-report.lua')
-- Setup check (mod/setup-check.lua): the first section of the Help page and the first-load notice. Optional too; read through its
-- global convaiSetupCheck, so no function here gains an upvalue (LuaJIT limits them).
pcall(dofile, 'setup-check.lua')
-- Favorites (mod/favorites.lua): the characters and models the player starred, kept in runtime/favorites.json (player state). Optional too:
-- without it the pages have no Add to favorites rows. Read through its global convaiFavorites, so no function here gains an upvalue.
pcall(dofile, 'favorites.lua')
-- Saved parties (mod/saved-parties.lua): the parties the player saved from the current one, in runtime/saved-parties.json (player state). Optional
-- too: without it the Parties page has no Save row. Read through its global convaiSavedParties, so no function here gains an upvalue.
pcall(dofile, 'saved-parties.lua')
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
-- The Google Gemini page's own instance of the same module (kind 'gemini': its command and state files, two rows).
local geminiProvider = {}
-- Remote OmniVoice (mod/remote-omni.lua, docs/REMOTE_OMNIVOICE.md): the server address and the connection test, on the Custom voices page. Optional like the Custom provider.
local remoteOmni = {factory = select(2, pcall(dofile, 'remote-omni.lua'))}
-- OmniVoice for AMD (mod/omni-amd.lua, docs/OMNIVOICE_AMD.md): the one-button setup of OmniVoice on an AMD Radeon card and the MIOpen choice. Optional like Remote OmniVoice.
local omniAmd = {factory = select(2, pcall(dofile, 'omni-amd.lua'))}
-- Key bindings (docs/KEY_BINDINGS.md): the mod's own keys for its five actions, set from a page of their own. The module that listens for them
-- (mod/key-bindings.lua) is loaded by init.lua (convaiKeyBindsModule) when this page opens or a binding is saved, so a player who never opens the page
-- and sets nothing loads nothing.
local function keyBinds()
    if type(convaiKeyBindsModule) ~= 'function' then return nil end
    local ok, module = pcall(convaiKeyBindsModule)
    return ok and type(module) == 'table' and module or nil
end
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
    local ok, value = pcall(function() return convaiPlayer() end)
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
-- The longest name of a row that ends in a button, in optionUnits (Native Settings UI draws a button row's name narrower than a switch's; the
-- host mod/nsui.lua cuts to the same figure, LAYOUT.buttonLabelUnits).
local BUTTON_LABEL_UNITS = 29
-- The English names of the Voice language choices (each goes through ui.t, so every locale shows its own word for the language).
local REPLY_LANGUAGE_NAMES = {en = 'English', auto = 'Automatic', de = 'German', fr = 'French', es = 'Spanish', it = 'Italian', pt = 'Portuguese',
    pl = 'Polish', ru = 'Russian', uk = 'Ukrainian', tr = 'Turkish', cs = 'Czech', hu = 'Hungarian', ja = 'Japanese', ko = 'Korean', zh = 'Chinese'}
M.BUTTON_LABEL_UNITS = BUTTON_LABEL_UNITS
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
    -- A Set that is waiting belongs to its page (mod/key-bindings.lua, loaded only once the page was opened).
    if view == 'key-bindings' and convaiKeyBinds then pcall(convaiKeyBinds.abandonCapture) end
    view, listPage, listGroup = nextView, 1, 1
    -- Characters to invite lists the player's own characters: one look at the file they are kept in (rate-limited by the service, and only while some exist or the editor was opened), so a character made a moment ago is there.
    if nextView == 'characters' and convaiCustomCharacters then pcall(convaiCustomCharacters.refresh) end
    modelFind.text, modelFind.words, modelFind.typed = '', {}, ''
    -- A Delete that asked for a second press asks again after any page change.
    if convaiSavedParties then convaiSavedParties.disarm() end
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

-- What a page of a long list holds, as the description of the page controls: "Page 2 of 5: characters 13 to 24." `kind` is the list's noun
-- (characters, models; entries for any other list) and `count` the length of the whole list.
local function pageLine(target, page, pages, kind, count)
    local from = (page - 1) * PAGE_SIZE + 1
    local noun = kind == 'characters' and ui.t('characters') or kind == 'models' and ui.t('models') or ui.t('entries')
    local data = {page = page, pages = pages, kind = noun, first = from, last = math.min(page * PAGE_SIZE, count or from)}
    if target then return ui.t('Press to go to page {page} of {pages}: {kind} {first} to {last}.', data) end
    return ui.t('Page {page} of {pages}: {kind} {first} to {last}.', data)
end

-- The rows that read a long list: the page slider (only with more than one page) and the names the page starts and ends with.
-- `nameAt(index)` is the display name of the index-th item of the list. The slider row also carries what the Previous and Next page buttons of a
-- host that has buttons say when the player is on them (previousHelp, nextHelp).
local function pageRows(first, last, pages, nameAt, kind, count)
    local rows = {}
    if pages > 1 then
        local here = pageLine(false, listPage, pages, kind, count)
        -- The slider's own text never changes with the page (a row whose text changes is drawn again, and the player may be holding it).
        local row = setting('ui:page', 'Page', 'int', listPage, 1,
            'Drag the slider, or press left and right, to turn the page.', nil, {min = 1, max = pages, step = 1})
        row.previousHelp = here .. '\n' .. (listPage > 1 and pageLine(true, listPage - 1, pages, kind, count)
            or ui.t('This is the first page.'))
        row.nextHelp = here .. '\n' .. (listPage < pages and pageLine(true, listPage + 1, pages, kind, count)
            or ui.t('This is the last page.'))
        rows[#rows + 1] = row
    end
    if last >= first then
        local range = shortName(nameAt(first)) .. ' – ' .. shortName(nameAt(last))
        -- The line under the slider (drawn again with every page): what the page holds, in the description panel.
        local help = pages > 1 and (pageLine(false, listPage, pages, kind, count) .. '\n' .. range) or range
        rows[#rows + 1] = readonly('list-range', ui.t('Page {page} / {pages}', {page = listPage, pages = pages}), range,
            help, {label = true, value = true, description = true})
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
-- A record that has no name of its own (an unnamed model, a name the scan made from the record id, or the record id itself) or a name that
-- is only an internal code (no lowercase letter, a digit or a dash in it: "1H-DNC-LAÖ"). They are listed after the real names.
local function placeholderModel(model)
    local name = tostring(model.name or '')
    if model.unnamedIndex or model.derived or (model.record ~= nil and name == model.record) then return true end
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

-- The words of a search text: lower case, split at any run of spaces, at most 100 characters. Returns the text as those words joined by
-- one space (so "Rita  Wheeler " and "rita wheeler" are the same search) and the words.
local function searchWords(text)
    local words = {}
    for word in tostring(text or ''):sub(1, 100):lower():gmatch('%S+') do words[#words + 1] = word end
    return table.concat(words, ' '), words
end
-- Whether a model answers a search: every word is somewhere in its name, its record or its conversation profile (model.search, made by the
-- scan), so "rita" and "wheeler rita" find Rita Wheeler and "wheeler" alone does too.
local function modelMatches(model, words)
    local haystack = model.search or (tostring(model.name or '') .. ' ' .. tostring(model.record or '') .. ' ' .. tostring(model.profileName or '')):lower()
    for _, word in ipairs(words) do
        if not haystack:find(word, 1, true) then return false end
    end
    return true
end
M.searchWords, M.modelMatches = searchWords, modelMatches

-- Whether a character of Characters to invite answers a search: every word is in its name or its key.
local function profileMatches(profile, words)
    local haystack = (tostring(profile.name or '') .. ' ' .. tostring(profile.key or '')):lower()
    for _, word in ipairs(words) do
        if not haystack:find(word, 1, true) then return false end
    end
    return true
end

-- The models of `list` (the browser's whole list; with `matcher`, any list of items) that answer the search text, in the same order.
-- Worked out when the text changes or the list does, never per keystroke of a page build: a page build only reads the held result.
local function searchedModels(list, matcher)
    if modelFind.source ~= list or modelFind.found ~= modelFind.text then
        local matches = {}
        matcher = matcher or modelMatches
        for _, model in ipairs(list) do
            if matcher(model, modelFind.words) then matches[#matches + 1] = model end
        end
        modelFind.source, modelFind.found, modelFind.list = list, modelFind.text, matches
    end
    return modelFind.list
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
    if settings.vVoice or settings.vVoiceMic then speech[#speech + 1] = ui.t('V’s voice') end
    local talk = {}
    if #speech > 0 then talk[#talk + 1] = ui.t('Speech: {list}', {list = table.concat(speech, ' · ')}) end
    if settings.battleReactions or settings.lootReactions then behavior[#behavior + 1] = ui.t('Companions react') end
    return {talk = talk,
        behavior = #behavior > 0 and ui.t('Behavior: {list}', {list = table.concat(behavior, ' · ')}) or nil,
        pack = manager.omniPack()}
end

-- How V stands with one character (docs/RELATIONSHIPS_AND_QUESTS.md section 4): "Bond: level 5, Good friend" and, when the character is in a story, "Story: ...".
-- Nothing while Character bonds is off or no level is known yet. mod/bonds.lua reads runtime/bonds-status.json at most every 5 s, only when a page is built;
-- the level title is in the menu language, the story title is the pack's own English one.
local function bondLines(settings, key)
    if not settings.characterBonds or type(convaiBondsView) ~= 'function' then return nil end
    local ok, view = pcall(convaiBondsView, key)
    if not ok or type(view) ~= 'table' or not view.level or not view.title then return nil end
    local lines = {ui.t('Bond: level {level}, {title}', {level = view.level, title = view.title})}
    if view.story then lines[#lines + 1] = ui.t('Story: {title}', {title = view.story}) end
    return lines
end

-- The Relationships page (Companion Manager home, docs/RELATIONSHIPS_AND_QUESTS.md): the characters V has talked to, each as one row whose description holds
-- the details, and one line under it for each story pack. The list is mod/bonds.lua's `characters` (one cached read of the status file, when the page is built).
-- Every figure may be missing: a line is written only from what is there. A description is cut by the host at 420 characters (the whole paragraphs that fit),
-- so the details stay short and the stories have rows of their own. Never per frame.
local DAY_MS = 86400000
-- A figure that is really a number (the page shows what is valid and leaves out the rest), as a whole number.
local function figure(value)
    if type(value) ~= 'number' or value ~= value or value == math.huge or value == -math.huge then return nil end
    return math.floor(value)
end
local function wording(value) return type(value) == 'string' and value ~= '' and value or nil end
local function bondDetails(item, storyOn)
    local lines = {}
    local level, title = figure(item.level), wording(item.title)
    if level and level >= 1 and title then
        lines[#lines + 1] = ui.t('Bond: level {level}, {title}', {level = level, title = title})
        local points, needed = figure(item.points), figure(item.next)
        if level >= 10 then lines[#lines + 1] = ui.t('Highest level')
        elseif points and needed then
            lines[#lines + 1] = ui.t('{points} of {needed} points to level {to}', {points = points, needed = needed, to = level + 1})
        end
    end
    local warm = figure(item.warm)
    if warm then lines[#lines + 1] = ui.t('Warmth: {points}', {points = warm}) end
    local hurt, hurtDays = figure(item.hurt), figure(item.hurtDays)
    if hurt and hurt > 0 then
        if hurtDays and hurtDays > 1 then
            lines[#lines + 1] = ui.t('Hurt: {points}, gone in about {days} game days', {points = hurt, days = hurtDays})
        elseif hurtDays then
            lines[#lines + 1] = ui.t('Hurt: {points}, gone in about a game day', {points = hurt})
        else
            lines[#lines + 1] = ui.t('Hurt: {points}', {points = hurt})
        end
    end
    local story, talk = figure(item.story), figure(item.talk)
    if story and talk then
        lines[#lines + 1] = ui.t('From their story: {story}, from talking: {talk}', {story = story, talk = talk})
    end
    local done, total = figure(item.arcDone), figure(item.arcTotal)
    if total and total > 0 and done then
        lines[#lines + 1] = ui.t('Their quests: {done} of {total} finished', {done = math.max(0, math.min(done, total)), total = total})
    end
    local lastAt = figure(item.lastAt)
    if lastAt and lastAt > 0 then
        -- A float on purpose: the clock in milliseconds is more than a 32-bit integer holds.
        local days = math.floor((os.time() * 1000.0 - lastAt) / DAY_MS)
        if days >= 2 then lines[#lines + 1] = ui.t('Last talked: {days} days ago', {days = days})
        elseif days == 1 then lines[#lines + 1] = ui.t('Last talked: yesterday')
        else lines[#lines + 1] = ui.t('Last talked: today') end
    end
    if storyOn and (type(item.packs) ~= 'table' or #item.packs == 0) then lines[#lines + 1] = ui.t('No story yet') end
    return table.concat(lines, '\n')
end

-- The rows of one listed character: the character, then her stories (an active one with what it is about, a finished one marked).
local function bondRows(rows, index, item, storyOn)
    local id = 'bond:' .. index
    local level = figure(item.level)
    rows[#rows + 1] = readonly(id, wording(item.name) or '?', level and level >= 1 and ui.t('Level {level}', {level = level}) or '', bondDetails(item, storyOn),
        {label = true, value = true, description = true})
    if storyOn and type(item.packs) == 'table' then
        for number, pack in ipairs(item.packs) do
            local title, label = type(pack) == 'table' and wording(pack.title) or nil, type(pack) == 'table' and wording(pack.label) or nil
            if title then
                local text
                if pack.state == 'done' then text = ui.t('{title} (finished)', {title = title})
                elseif label then text = ui.t('{title}: {label}', {title = title, label = label})
                else text = title end
                rows[#rows + 1] = readonly(id .. ':pack:' .. number, text, '', text, {label = true, value = true, description = true})
            end
        end
    end
end

-- The Characters sidebar text of one character: its description, then the settings in effect for it. `count` is the
-- number of copies in the party and `shared` comes from sharedCharacterLines.
local function profileDescription(profile, snapshot, shared, count)
    local settings = snapshot.settings
    -- A character the player made (mod/custom-characters.lua, docs/CHARACTER_EDITOR.md): no roster voice, memory or relationship lines, just what it is and how it talks.
    if profile.custom then
        local lines = {ui.t('Your own character, made in the character editor.') .. '\n',
            ui.t('They join as a copy of the model they were made from. They talk with Google Gemini, Local AI or Custom; with Convai they talk as an ordinary person.')}
        if count > 0 then lines[#lines + 1] = ui.t('In your party: {count}', {count = count}) end
        return table.concat(lines, '\n')
    end
    -- The voice that really speaks this character's replies, or text when none does (manager.characterVoiceLabel). It names the Convai
    -- voice only when that voice speaks, not when a local voice or the Mistral voice could not run.
    local voice = manager.characterVoiceLabel(profile,
        {settings = settings, localVoice = snapshot.localVoice, mistralSaved = (snapshot.mistral or {}).saved == true,
            inworldSaved = ((snapshot.mistral or {}).inworld or {}).saved == true}, shared.pack)
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
    for _, line in ipairs(bondLines(settings, profile.key) or {}) do lines[#lines + 1] = line end
    if count > 0 then
        lines[#lines + 1] = ui.t('In your party: {count}', {count = count})
        if shared.behavior then lines[#lines + 1] = shared.behavior end
    end
    return table.concat(lines, '\n')
end

local function savedVoiceIndex(settings)
    return voicePreviewModule.indexOf(settings)
end

-- The select's labels, in menu order.
-- An OmniVoice entry stays in the list while the optional pack is missing (the row's name says "no Omni pack"), and M.apply refuses
-- it (the bridge would fall back to Pocket TTS anyway): the row goes back to the voice that is saved, with the reason on the page.
local function voiceMenuLabels(pack, mistral, matureOn, savedProvider)
    -- Entry 1 is Off (the old Voice playback switch), so each voice sits one place after its position in VOICE_CHOICES; `disabled` is keyed by the entry's place.
    local elements, disabled = {ui.t('Off')}, {}
    for index, choice in ipairs(VOICE_CHOICES) do
        -- Short (OPTION_BUDGET), so the entry does not run over the arrows or the key boxes of a focused row; the voice description says
        -- what the pack and the keys are. The Mistral cloud voice has a menu name of its own: the full one ("Mistral cloud voice
        -- (Voxtral)") stays for sentences.
        local label
        if choice.provider == 'inworld' then
            -- The Inworld cloud voice is listed last, and only once its key is saved (or while it is the saved choice, so the row never shows another voice than the saved one).
            if ((mistral or {}).inworld or {}).saved then
                if matureOn then
                    label = ui.t('Inworld · not with Mature')
                    disabled[#elements + 1] = ui.t('Inworld is not used with Mature content.')
                else label = ui.t('Inworld · Cloud voice') end
            elseif savedProvider == 'inworld' then label = ui.t('Inworld · needs key') end
        elseif choice.provider == 'voxtral' then
            -- Not beside Mature content (the entry is greyed out and M.apply refuses it, whatever the key): the label says so, for hosts that cannot grey it.
            if matureOn then
                label = ui.t('Voxtral · not with Mature')
                disabled[#elements + 1] = ui.t('Voxtral is not used with Mature content.')
            else
                label = (mistral or {}).saved and ui.t('Voxtral (recommended)') or ui.t('Voxtral · needs Mistral key')
            end
        else
            label = manager.voiceLabel(choice.provider, choice.steps, choice.reference)
            if choice.provider == 'omni' and not (pack or {}).installed then disabled[#elements + 1] = true end
        end
        if label then elements[#elements + 1] = label end
    end
    voiceMenuSize, voiceLabelsShown, voiceDisabledShown = #elements, elements, disabled
    return elements
end
-- Mature content works with the Local AI and Custom providers only (owner decision 2026-10-20, after Mistral's Voxtral voice refused Mature lines in a
-- live test: "let's not risk their API key"); Convai (free tier or API key) and Mistral never take it. Turning it ON beside Convai or Mistral selects,
-- in the same saved transaction, the Local AI provider (and its uncensored model) when the Local AI pack is installed; without the pack it selects Custom
-- when a custom endpoint is set up, else it cannot be on there and the switch goes back to off (never Mistral). Beside Local AI it selects the uncensored
-- model the same way; beside Custom it changes nothing else (the model is the player's). Picking Convai or Mistral while it is on turns it OFF.
-- No Voxtral voice beside it either (MATURE_VOXTRAL in mod/manager.lua): turning it ON moves a Voxtral companion voice and V's Voxtral engine to Pocket
-- (any provider), named in the "Also changed" line, and the choice is greyed out and refused while it is on.
-- Turning it OFF puts back what turning it on changed, unless the player changed it since (a Voxtral voice only when the Mistral key is still saved).
-- What was changed is kept in the saved settings (manager: matureRestore). stageMature computes all of it from the saved settings and the batch of
-- changes; it runs when a change is applied and costs nothing otherwise.
-- The provider list in menu order; PROVIDER_IDS names them for the restore record ('convai-key' is Convai with the player's own key).
-- The third entry is Google Gemini; a player who chose Mistral before it left the list (2026-10-30) sees it there, as "Mistral (your key)", while it is the saved choice
-- (providerIndexOf keeps PROVIDER_IDS[3] in step with the saved settings).
local PROVIDER_IDS = {'convai', 'convai-key', 'gemini', 'local', 'custom'}
local LOCAL_PROVIDER = 4
local CUSTOM_PROVIDER = 5
-- Positions of the providers that take Mature content as they are (Custom); Local AI is LOCAL_PROVIDER. Convai (1, 2) and Google Gemini or Mistral (3) never do.
local MATURE_CLOUD_PROVIDERS = {[5] = true}
-- Why a model the player added cannot be used (bridge/custom-models.mjs reason codes), as a short phrase for the Local AI model row's help.
local function customProblemText(reason)
    if reason == 'missing' then return ui.t('file not found') end
    if reason == 'bad-gguf' then return ui.t('not a valid GGUF file') end
    if reason == 'embedding' then return ui.t('an embedding model, not a chat model') end
    return ui.t('could not be read')
end

local LOCAL_AI_PRESENT = {ready = true, warming = true, ['no-memory'] = true, failed = true}

-- A companion voice as the restore record keeps it ({provider, steps, reference}) and its position in the Companion voices list.
local function voiceRecord(index)
    local choice = VOICE_CHOICES[index]
    if not choice then return nil end
    return {provider = choice.provider, steps = choice.steps, reference = choice.reference}
end

local function voiceIndexOf(record)
    if type(record) ~= 'table' then return nil end
    return voicePreviewModule.indexOf({voiceProvider = record.provider, omniSteps = record.steps, omniReference = record.reference})
end

-- V's voice engine row as it is held (1 Pocket, 2 Voxtral, 3 OmniVoice) for the saved settings. The row shows what is saved, whatever the Mistral key (V's voice follows its own setting, without a key
-- the entry reads "Voxtral · needs Mistral key" and V's line is skipped, no Pocket worker loads for it, 2026-10-22). With Mature content on a Voxtral engine reads as Pocket (it is not used),
-- so does a saved OmniVoice engine that cannot be used now (`omniOk` false: the companions are not on OmniVoice, or its pack is missing).
local function savedVIndex(settings, omniOk)
    if settings.vVoiceEngine == 'omni' and omniOk then return 3 end
    return settings.vVoiceEngine == 'voxtral' and settings.matureContent ~= true and 2 or 1
end

-- Is the custom endpoint set up (an address and a model ID, mod/custom-provider.lua state `ready`)? Read from the file the bridge writes, at most
-- every few seconds; a fault or a missing module reads as no.
local function customEndpointReady()
    local instance = customProvider.instance
    if not instance then return false end
    local ok, state = pcall(instance.state)
    return ok and type(state) == 'table' and state.ready == true
end

-- The position of a model in the row. 'auto' (an older version's Mature record) is the model shown as the default.
local function modelIndexOf(id)
    if id == 'auto' then id = manager.localModelDefaultId() end
    for index, choice in ipairs(manager.localModelChoices()) do if choice.id == id then return index end end
end

-- The Conversation provider selector's index of the saved settings: 1 Convai free tier, 2 Convai API key, 3 Google Gemini (Mistral, while that is the saved choice), 4 Local, 5 Custom.
local function providerIndexOf(settings)
    PROVIDER_IDS[3] = settings.conversationProvider == 'mistral' and 'mistral' or 'gemini'
    if settings.conversationProvider == 'custom' then return 5 end
    if settings.conversationProvider == 'local' then return 4 end
    if settings.conversationProvider == 'mistral' or settings.conversationProvider == 'gemini' then return 3 end
    return settings.useOwnConvaiKey == true and 2 or 1
end

-- `changes` is the batch, a list of {id, value} with the values as a page holds them (booleans, list positions, numbers). Returns the
-- batch with what Mature content needs added or put back, the record of what turning it on changed (the caller saves it with the
-- settings), the names of what was changed besides the player's own choice, a refusal text when the switch cannot be turned on, and a note (a
-- sentence) when the batch turned Mature content off because the player chose a model that is not a Mature model.
local restoreMistral = false   -- set by stageMature when turning Mature content off puts a player back on Mistral (entry 3 then stands for Mistral in the same Apply)
local function stageMature(changes, snapshot)
    restoreMistral = false
    local saved = snapshot.settings
    -- `explicit`: the rows the batch itself sets (the player's own choice in it, or Restore defaults). Turning Mature content off never puts one
    -- of those back: what the batch asks for wins.
    local batch, by, explicit = {}, {}, {}
    for _, change in ipairs(changes) do
        local copy = {id = change.id, value = change.value}
        batch[#batch + 1], by[change.id], explicit[change.id] = copy, copy, true
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
    local record, names, refusal, note = nil, {}, nil, nil
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
    local keySaved = (snapshot.mistral or {}).saved == true
    -- V's voice engine row as the batch leaves it: 1 Pocket, 2 Voxtral, 3 OmniVoice (the engine is one setting for V's typed and spoken lines).
    local vEngineNow = now('vVoiceEngine', savedVIndex(saved, not manager.vOmniBlock(saved)))
    -- `keepProvider`: Mature content goes off because of a model the player chose on Local AI, so the provider stays on Local AI (it is not put back).
    local function turnedOff(keepProvider)
        local restore = saved.matureRestore
        if type(restore) ~= 'table' then if not keepProvider then leaveUncensoredModel() end; return end
        local part = restore.conversationProvider
        if part and not explicit.conversationProvider and not keepProvider then
            local was, back
            for index, id in ipairs(PROVIDER_IDS) do
                if id == part.set then was = index end
                if id == part.before then back = index end
            end
            -- A player who chose Mistral before it left the list goes back to it: the third entry stands for Mistral again for this change (providerIndexOf puts Google Gemini back once Mistral is not the saved choice).
            if part.before == 'mistral' then back = 3; restoreMistral = true end
            if now('conversationProvider', providerIndexOf(saved)) == was and back then
                stage('conversationProvider', back); names[#names + 1] = ui.t('Conversation provider')
            end
        end
        part = restore.localModel
        if part and not explicit.localModel then
            local current, back = now('localModel', modelIndexOf(saved.localModel)), modelIndexOf(part.before)
            if current == modelIndexOf(part.set) and back then
                stage('localModel', back); names[#names + 1] = ui.t('Local AI model')
            end
        end
        part = restore.voice
        if part and not explicit.voiceProvider then
            local current, back = now('voiceProvider', savedVoiceIndex(saved)), voiceIndexOf(part.before)
            -- Only a voice that can be chosen now: Voxtral needs the Mistral key, OmniVoice its pack (M.apply refuses either without, and the
            -- refusal would keep Mature content on). Otherwise the voice stays where it is.
            local choice = back and VOICE_CHOICES[back]
            local usable = choice and (choice.provider ~= 'voxtral' or keySaved) and (choice.provider ~= 'inworld' or ((snapshot.mistral or {}).inworld or {}).saved == true)
                and (choice.provider ~= 'omni' or manager.omniPack().installed == true)
            if current == voiceIndexOf(part.set) and usable then
                stage('voiceProvider', back); names[#names + 1] = ui.t('Companion voices')
            end
        end
        part = restore.vVoiceEngine
        -- V's engine goes back to Voxtral only if it still is Pocket (not changed by the player in this batch) and the key is saved.
        if part and part.before == 'voxtral' and not explicit.vVoiceEngine and vEngineNow == 1 and keySaved then
            stage('vVoiceEngine', 2); vEngineNow = 2
            names[#names + 1] = ui.t('V’s voice engine')
        end
        if not keepProvider then leaveUncensoredModel() end
    end
    if mature and mature.value == true and not savedMature then
        local installed = LOCAL_AI_PRESENT[(snapshot.mistral or {}).localAi] == true
        local usingLocal = providerNow == LOCAL_PROVIDER
        local cloudText = MATURE_CLOUD_PROVIDERS[providerNow] == true
        -- Beside Convai or Mistral (which cannot take it): the Local AI pack when installed, else a ready custom endpoint, never Mistral. When the
        -- same change picks Convai or Mistral, the provider the player chose stays and the switch goes back to off.
        local target
        if not usingLocal and not cloudText and not by.conversationProvider then
            if installed then target = LOCAL_PROVIDER
            elseif customEndpointReady() then target = CUSTOM_PROVIDER end
        end
        if not usingLocal and not cloudText and not target then
            mature.value, refusal = false, ui.t('Needs Local AI or Custom.')
        else
            record = {}
            if target and PROVIDER_IDS[providerNow] then
                stage('conversationProvider', target)
                record.conversationProvider = {before = PROVIDER_IDS[providerNow], set = PROVIDER_IDS[target]}
                names[#names + 1] = target == LOCAL_PROVIDER and ui.t('Local AI') or ui.t('Custom (OpenAI-compatible)')
                usingLocal = target == LOCAL_PROVIDER
            end
            if usingLocal then
                -- The largest uncensored model that fits, when one is installed; otherwise the model is left alone.
                local choices = manager.localModelChoices()
                local modelNow = now('localModel', modelIndexOf(saved.localModel))
                local uncensoredId = manager.localModelMatureId()
                local modelTarget = uncensoredId and modelIndexOf(uncensoredId) or nil
                if modelTarget and type(modelNow) == 'number' and modelNow ~= modelTarget and choices[modelNow] then
                    stage('localModel', modelTarget)
                    record.localModel = {before = choices[modelNow].id, set = uncensoredId}
                    names[#names + 1] = ui.t('Uncensored model')
                end
            end
            -- No Voxtral voice beside it (any provider): the companions and V move to Pocket, named below, and come back when it is turned off.
            local voiceNow = now('voiceProvider', savedVoiceIndex(saved))
            local voiceChoice = VOICE_CHOICES[voiceNow]
            if voiceChoice and (voiceChoice.provider == 'voxtral' or voiceChoice.provider == 'inworld') then
                stage('voiceProvider', 1)
                record.voice = {before = voiceRecord(voiceNow), set = voiceRecord(1)}
                local chosen = VOICE_CHOICES[1]
                names[#names + 1] = manager.voiceLabel(chosen.provider, chosen.steps, chosen.reference)
            end
            if vEngineNow == 2 then
                stage('vVoiceEngine', 1); vEngineNow = 1
                record.vVoiceEngine = {before = 'voxtral', set = 'pocket'}
                names[#names + 1] = ui.t('V’s voice engine')
            end
            record = next(record) and record or nil
        end
    elseif mature and mature.value == false and savedMature then
        turnedOff()
    elseif savedMature and not mature and by.conversationProvider and providerNow ~= LOCAL_PROVIDER
        and not MATURE_CLOUD_PROVIDERS[providerNow] and providerNow ~= providerIndexOf(saved) then
        -- Convai or Mistral picked while Mature content is on turns it off, with the same way back.
        stage('matureContent', false)
        turnedOff()
    elseif savedMature and not (mature and mature.value == false) and explicit.localModel and providerNow == LOCAL_PROVIDER and manager.localModelMatureId() then
        -- The Local AI model list always shows every installed model, Mature ones included. Choosing one of the Local AI packs' own (censored) models
        -- while Mature content is on, with a Mature model installed to choose instead, means the player does not want the uncensored one: Mature content
        -- turns off with the same way back, and the chosen model stays. A model the player added is not judged (nothing says it is censored), and without
        -- a Mature model installed Mature content works with any model, so the choice leaves it on.
        local picked = manager.localModelChoices()[by.localModel.value]
        if picked and not picked.custom and (picked.id == 'standard' or picked.id == 'lite') and by.localModel.value ~= modelIndexOf(saved.localModel) then
            stage('matureContent', false)
            turnedOff(true)
            note = ui.t('Mature content is turned off because you chose a model that is not a Mature model.')
        end
    end
    return batch, record, names, refusal, note
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

-- A content pack that keeps a memory of its own (add-on API 1.1, `content.memory: "separate"`): `installed` is true when one is installed, `name` is its name while it is on.
-- The bridge keeps the memory in use for the characters and Forget acts on that one only (bridge/memory-scope.mjs), so the memory page says which it is.
local function memoryInUse()
    if not (convaiAddons and convaiAddons.contentMemory) then return false, nil end
    local ok, installed, name = pcall(convaiAddons.contentMemory)
    if not ok or installed ~= true then return false, nil end
    return true, type(name) == 'string' and name or nil
end

local function memorySettings(snapshot)
    local memory = snapshot.memory
    local pending = memory.command and memory.command.state == 'pending'
    local separate, packName = memoryInUse()
    local inUse = separate and (packName or ui.t('Normal memory')) or nil
    local note = inUse and ui.t('This clears the memory in use: {memory}.', {memory = inUse}) or nil
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
    -- With a content pack that has a memory of its own installed, the page names the memory Forget acts on (the pack's by name while it is on, else the normal one).
    if separate then
        table.insert(rows, 4, readonly('memory-in-use', 'Memory in use', inUse,
            'Forget memories clears only the memory shown here. The other memory stays as it is.', {value = true}))
    end
    if memory.feedback ~= '' then rows[#rows + 1] = readonly('memory-feedback', 'Memory result', memory.feedback, memory.feedback) end
    local confirmation = memory.confirmation
    if confirmation then
        local description = confirmation.scope == 'all'
            and ui.t('Clear memories about you for all {count} characters you have talked to?',{count=confirmation.count})
            or ui.t('Clear {name}’s memories about conversations with you?',{name=confirmation.target})
        description = description .. ' ' .. ui.t('Your player identity stays the same. Matching Phone Chat messages and drafts are also cleared.')
        if note then description = description .. ' ' .. note end
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
        if note then rows[#rows].description = rows[#rows].description .. '\n\n' .. note end
        -- The button says what it does, the count goes in the name: "Forget all memories (6 characters)" in the button's name budget
        -- (BUTTON_LABEL_UNITS). A count that is too wide for it (two digits, or a longer translation) is only the number, "Forget all memories (12)",
        -- and when even that does not fit the name stands alone: the row above ("Characters you have talked to") shows the count anyway.
        local forgetName = ui.t('Forget all memories')
        if memory.talkedToCount then
            local counted = ui.t('Forget all memories ({count} characters)', {count = memory.talkedToCount})
            local short = forgetName .. ' (' .. tostring(memory.talkedToCount) .. ')'
            if optionUnits(counted) <= BUTTON_LABEL_UNITS then forgetName = counted
            elseif optionUnits(short) <= BUTTON_LABEL_UNITS then forgetName = short end
        end
        rows[#rows + 1] = action('memory:forget-all', forgetName, 'Forget',
            'Clear memories about you for every character you have talked to.\n\nYour player identity stays. A confirmation comes first.',
            function() return manager.beginMemoryClear('all') end, memory.canClearAll)
        if note then rows[#rows].description = rows[#rows].description .. '\n\n' .. note end
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
        -- `key.removeMore` (already translated) says what else the removal changes, after the one fixed sentence (the Mistral key's row).
        help = ui.t(removeHelp) .. (key.removeMore and (' ' .. key.removeMore) or '') .. '\n\n' .. ui.t('Saved on this computer only. Only the last four characters are ever shown.')
    else
        help = ui.t(pasteHelp)
    end
    if key.message then help = key.message .. '\n\n' .. help end
    if lastParagraph then help = help .. '\n\n' .. lastParagraph end
    return action(id, ui.t(name) .. (info and (' (' .. info .. ')') or ''), key.saved and ui.t('Remove') or (key.add and ui.t('Add') or ui.t('Paste')), help,
        key.saved and remove or paste, nil, {label = true, value = true, description = true})
end

-- Settings > Conversation provider > Custom endpoint: the endpoint URL, API key and model ID rows and the connection test of the Custom
-- provider. Everything they say comes from mod/custom-provider.lua; this only draws them (a row is one action row). A fault there never costs
-- the page: the page is then empty.
local function customEndpointRows()
    local rows = {}
    if not customProvider.instance then return rows end
    local made, items = pcall(customProvider.instance.rows)
    if made and type(items) == 'table' then
        for _, item in ipairs(items) do
            rows[#rows + 1] = action(item.id, item.label, item.value, item.help,
                function() return customProvider.instance.request(item.action) end, item.enabled,
                {label = true, value = true, description = true})
        end
    end
    return rows
end

-- Settings > Voices > Custom voices, last section: the Inworld cloud voice (docs/INWORLD.md). Its API key (added from the clipboard, saved only on this
-- computer, only its last four characters shown), a connection test and one line saying whether the voice can be chosen. The voice itself is chosen in
-- Settings > Voices > Companion voices, where Inworld is the last entry once a key is saved. Nothing here asks Inworld for anything until a button is pressed.
local function inworldRows(snapshot)
    local inworld = (snapshot.mistral or {}).inworld or {}
    local result, saved = inworld.result, inworld.saved == true
    local message
    if result == 'invalid' then message = ui.t('Inworld did not accept that key.')
    elseif result == 'unreadable' then message = ui.t('The clipboard could not be read.')
    elseif result == 'failed' then message = ui.t('The key could not be saved.') end
    local rows = {}
    rows[#rows + 1] = keyRow('Inworld API key',
        'Needs your own Inworld key, from inworld.ai. Inworld’s free plan is a one-time trial of about 70 minutes of speech, then you pay as you go.\n\nCopy your key first, then press Add. It is read from the clipboard once, checked with Inworld and saved on this computer.',
        'Deletes the saved key. If Inworld is your Companion voice, replies show as text until you add a key again.',
        'inworld-key', {saved = saved, tail = inworld.tail, checking = result == 'checking', message = message, add = true},
        function() return manager.pasteInworldKey() end, function() return manager.removeInworldKey() end)
    local testValue = ui.t('Test')
    if result == 'checking' then testValue = ui.t('Checking…')
    elseif result == 'connected' then testValue = ui.t('Connected')
    elseif result == 'refused' then testValue = ui.t('Key refused')
    elseif result == 'unreachable' then testValue = ui.t('Not reachable')
    elseif result == 'no-key' then testValue = ui.t('Add a key first') end
    rows[#rows + 1] = action('inworld-test', 'Test connection', testValue,
        'Asks Inworld whether your saved key is accepted. It costs nothing and no speech is made.',
        function() return manager.testInworldConnection() end, saved, {value = true})
    local status
    if snapshot.settings.matureContent == true then status = ui.t('Not used with Mature content')
    elseif snapshot.settings.voiceProvider == 'inworld' then status = ui.t('Chosen as the Companion voice')
    elseif saved then status = ui.t('Ready to choose in Companion voices')
    else status = ui.t('Add a key to choose it') end
    rows[#rows + 1] = readonly('inworld-voice', 'Inworld voice', status,
        'Speaks each companion in their own voice, on your own Inworld key. Works in English and the other languages Inworld supports. Choose it under Companion voices, where it is listed last once a key is added.',
        {value = true})
    return rows
end

-- Settings > Voices > Custom voices: the Remote OmniVoice switch (a saved setting like any other), what it is doing now, the server address and the connection test,
-- then the Inworld cloud voice's key (inworldRows).
-- The address and test rows and their texts come from mod/remote-omni.lua; the page is empty without that file.
local function customVoicesRows(snapshot)
    local rows = {}
    if not remoteOmni.instance then return rows end
    local remote = manager.remoteOmniVoice()
    local on = snapshot.settings.remoteOmni == true
    rows[#rows + 1] = setting('remoteOmni', 'Remote OmniVoice', 'bool', on, false,
        'Render the voices on another PC or graphics card that runs the OmniVoice server, so this PC keeps its frames.\n\nTurn it on, press Apply and add the server address below. The server then speaks for every Pocket or OmniVoice choice under Companion voices; a cloud voice stays as chosen. If it cannot be reached, replies show as text and the mod retries every few seconds.')
    -- What it is doing now, from the saved setting and the voice service's own report.
    local status
    -- The voice the server speaks with: the saved OmniVoice quality (Pocket counts as it too; Quality by default).
    local voiceName = manager.voiceLabel('omni', snapshot.settings.omniSteps, snapshot.settings.omniReference)
    local chosen = snapshot.settings.voiceProvider
    if not on then status = ui.t('Off. OmniVoice runs on this PC.')
    elseif not remote.set and not (remoteOmni.instance.state().address) then
        if chosen == 'omni' then status = ui.t('On, but no server address is saved. OmniVoice cannot speak yet.')
        elseif chosen == 'pocket' then status = ui.t('On, but no server address is saved. Pocket is used until you add one.')
        else status = ui.t('On, but no server address is saved. The server is not used yet.') end
    elseif chosen ~= 'pocket' and chosen ~= 'omni' then status = ui.t('On, but a cloud voice is chosen under Companion voices, so the server is not used.')
    elseif not remote.fresh then status = ui.t('On. Waiting for the conversation service.')
    elseif remote.connected then status = ui.t('Connected. The server speaks with {voice}.', {voice = voiceName})
    else status = ui.t('Not connected. Replies show as text until the server answers.') end
    rows[#rows + 1] = readonly('remote-status', 'Status', status, 'Whether the server is in use right now. It is checked when a voice is needed and again every few seconds after a failure, never while you play.', {value = true})
    local made, items = pcall(remoteOmni.instance.rows)
    if made and type(items) == 'table' then
        for _, item in ipairs(items) do
            rows[#rows + 1] = action(item.id, item.label, item.value, item.help,
                function() return remoteOmni.instance.request(item.action) end, item.enabled,
                {label = true, value = true, description = true})
        end
    end
    for _, row in ipairs(inworldRows(snapshot)) do rows[#rows + 1] = row end
    return rows
end

-- Settings > Voices > Microphone: 1 Windows default (stored as no choice), then each input the conversation service listed, by its name. A saved input that is not
-- listed (unplugged, or the list has not arrived yet) follows as "name (not connected)" so the row never shows a choice that is not the saved one. An input whose name
-- looks like a loopback or virtual device (the service decides, bridge/mic-match.mjs) carries " (!)" and the description explains it; it is only marked, never left out
-- and never chosen by the mod.
-- Returns the labels, the stored value of each position ('' for the default), the position of the saved choice, whether any listed input is marked and whether the
-- saved choice is.
local MIC_MARK = ' (!)'
local function withMarker(name, marker)
    if optionUnits(name) + optionUnits(marker) <= OPTION_BUDGET then return name .. marker end
    return cutToUnits(name, OPTION_BUDGET - optionUnits(marker)) .. marker
end
local function microphoneChoices(settings)
    local labels, values, saved, seen = {ui.t('Windows default')}, {''}, settings.micDevice, {}
    local listed = manager.microphoneInputs()
    local anyMarked, savedMarked = false, false
    for _, name in ipairs(listed.inputs) do
        seen[name] = true
        local marked = listed.loopback and listed.loopback[name] == true
        if marked then anyMarked = true; if name == saved then savedMarked = true end end
        labels[#labels + 1], values[#values + 1] = marked and withMarker(name, MIC_MARK) or name, name
    end
    if saved and not seen[saved] then
        -- The name is cut, not the marker: a long device name would otherwise push "(not connected)" out of the row. Said only once the service has
        -- listed the inputs (before that, or without a service, the saved name stands alone).
        local marker = listed.state == 'ok' and ' (' .. ui.t('not connected') .. ')' or ''
        local name = optionUnits(saved) + optionUnits(marker) <= OPTION_BUDGET and saved or cutToUnits(saved, OPTION_BUDGET - optionUnits(marker))
        labels[#labels + 1], values[#values + 1] = name .. marker, saved
    end
    local index = 1
    for position, value in ipairs(values) do if value == (saved or '') then index = position end end
    return labels, values, index, anyMarked, savedMarked
end

-- Settings > Voices > OmniVoice for AMD: the setup and remove rows (their texts come from mod/omni-amd.lua) and the MIOpen choice, a saved setting like any other.
-- The page is empty without that file.
local function omniAmdRows(snapshot)
    local rows = {}
    if not omniAmd.instance then return rows end
    local made, items = pcall(omniAmd.instance.rows)
    if made and type(items) == 'table' then
        for _, item in ipairs(items) do
            rows[#rows + 1] = action(item.id, item.label, item.value, item.help,
                function() return omniAmd.instance.request(item.action) end, item.enabled,
                {label = true, value = true, description = true})
        end
    end
    rows[#rows + 1] = setting('amdMiopen', 'MIOpen convolutions (AMD)', 'bool', snapshot.settings.amdMiopen ~= false, true,
        'On: AMD’s MIOpen runs the convolutions, with MIOPEN_FIND_MODE=2 and MIOPEN_FIND_ENFORCE=1. Off: PyTorch’s own convolutions. Which is faster depends on your card and driver: if voices are slow or stop part-way, try the other one. AMD cards only. OmniVoice restarts with the new choice when it is idle.')
    return rows
end

-- The Google Gemini key as one row of the provider page (the Add reads the key from the clipboard, fills in the fixed endpoint and model and has the service try the key once with a tiny
-- request, which the row itself tells; Remove deletes the key). There is no Test connection row.
-- Everything it says comes from mod/custom-provider.lua (the second instance, kind 'gemini'); empty without it.
local function geminiRows(lastParagraph)
    local rows = {}
    local instance = geminiProvider.instance
    if not instance then return rows end
    local read, state = pcall(instance.state)
    state = read and type(state) == 'table' and state or {}
    local saved = state.keySaved == true and state.preset == 'gemini'
    local message
    if state.result and state.result.state == 'unreadable' then message = ui.t('The clipboard could not be read.')
    elseif state.result and state.result.state == 'failed' then message = ui.t('The key could not be saved.')
    elseif state.result and state.result.state == 'invalid' then message = state.result.reason == 'empty' and ui.t('The clipboard is empty. Copy your key first.') or ui.t('The clipboard does not hold an API key.')
    elseif saved and state.check then
        -- The one-time check of the key just added: accepted, refused (with what to do) or not possible now.
        local sentenced, sentence = pcall(instance.keyCheckSentence, state.check)
        message = sentenced and sentence or nil
    end
    rows[#rows + 1] = keyRow('Google Gemini API key',
        'Copy your key from Google AI Studio first (aistudio.google.com/apikey, a Google account is enough, no card). It is read from the clipboard once and saved on this computer.\n\nThe free plan has a daily limit of about 500 replies, is not offered in every country, and Google may use free-plan chats to improve its products.',
        'Deletes the saved key.',
        'gemini-key', {saved = saved, tail = state.tail, message = message, add = true, checking = saved and state.check ~= nil and state.check.state == 'checking'},
        function() return instance.request('preset-gemini') end, function() return instance.request('clear-preset-gemini') end, lastParagraph)
    return rows
end

-- Settings > Conversation provider: the provider, Mature content, the Local AI model and the key rows of Convai and Google Gemini
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
    -- Who answers right now, as the last paragraph of the provider row's help: only what the player has to act on or could not guess
    -- (a limit, a rejected key, a wait, a fallback, the free tier's allowance). The selected provider is the row's own value, and a
    -- key is never counted against the daily allowance (bridge/shared-key-guard.mjs).
    local note, limitHelp
    if mistral.pending then note = ui.t('Waiting for the conversation to end')
    elseif mistral.effective == 'mistral' then
        if mistral.limit == 'rate' or mistral.limit == 'daily' then note = ui.t('Mistral: limit reached for now')
        elseif mistral.limit == 'invalid' then note = ui.t('Mistral: key not accepted')
        elseif mistral.limit == 'model' then note = ui.t('Mistral: model unavailable') end
    elseif mistral.effective == 'gemini' then
        note = geminiProvider.instance and geminiProvider.instance.geminiNoteFor(mistral.limit) or nil
    elseif mistral.effective == 'custom' then
        note = customProvider.instance and customProvider.instance.noteFor(mistral.limit) or nil
    elseif mistral.effective == 'local' then note = nil
    elseif snapshot.settings.conversationProvider == 'local' then note = ui.t('Convai: Local AI is not ready')
    elseif snapshot.settings.conversationProvider == 'mistral' then note = ui.t('Convai: Mistral has no key yet')
    elseif snapshot.settings.conversationProvider == 'gemini' then note = ui.t('Convai: Google Gemini has no key yet')
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
        -- When they come back: the next 00:00 UTC on this computer's clock (ui.dailyResetClock), else "tomorrow".
        local at = type(ui.dailyResetClock) == 'function' and ui.dailyResetClock() or nil
        if at then
            limitHelp = ui.t('You have used today’s {limit} turns, which come back at {time}. To keep talking now, choose Local AI (unlimited) or Google Gemini (with your own key).', {limit = own.daily.limit, time = at})
        else
            limitHelp = ui.t('You have used today’s {limit} turns, which come back tomorrow. To keep talking now, choose Local AI (unlimited) or Google Gemini (with your own key).', {limit = own.daily.limit})
        end
    elseif own.daily then note = ui.t('Convai free tier: {left} of {limit} left today', {left = own.daily.left, limit = own.daily.limit}) end
    -- The voice key needs speech recognition on this computer, which only the bridge can say it has.
    local providerHelp = mistral.stt
        and ui.t('Who writes your companions’ replies. A change waits until no conversation is running.\n\nConvai free tier needs no setup and gives better replies. Convai API key uses your own key. Google Gemini uses your own free key, and its memory stays on this computer.\n\nWith Google Gemini, Local AI or Custom, Convai’s cloud voice is replaced by a local voice. Speech is recognized on this computer, so the voice key works.')
        or ui.t('Who writes your companions’ replies. A change waits until no conversation is running.\n\nConvai free tier needs no setup and gives better replies. Convai API key uses your own key. Google Gemini uses your own free key, and its memory stays on this computer.\n\nWith Google Gemini, Local AI or Custom, Convai’s cloud voice is replaced by a local voice. Speech recognition for the voice key is not available yet with them, so type your messages.')
    -- The note comes first: the description area holds only so much, and who answers right now is what the player acts on.
    if note then providerHelp = note .. '\n\n' .. providerHelp end
    -- Mature content is part of the main mod (off by default). It works with Local AI and Custom only: turning it on beside Convai or Mistral selects
    -- Local AI (else Custom), and choosing Convai or Mistral turns it off. Voxtral voices are not used with it. The help says whether the optional Mature pack (uncensored models, Local AI) is installed
    -- (the bridge reports its marker).
    local matureRow
    do
        local matureHelp = ui.t('Strong language, graphic violence, drugs and, between consenting adults, flirting and sex. Adults only (18+). Needs Local AI or Custom.')
        -- The rules come before the pack: the description area holds only so much, and those are what has to be read.
        matureHelp = matureHelp .. '\n\n' .. ui.t('Never allowed: sex with minors or without consent, sex about real people, hate, real-world weapon or drug instructions. A safety check enforces the minors rule.')
        matureHelp = matureHelp .. '\n\n' .. (mistral.maturePack == true
            and ui.t('The Mature pack’s uncensored models (for Local AI) give the full effect; standard models mostly refuse sex. Pack: installed.')
            or ui.t('The Mature pack’s uncensored models (for Local AI) give the full effect; standard models mostly refuse sex. Pack: not installed (optional, on this mod’s Hugging Face page).'))
        matureHelp = matureHelp .. '\n\n' .. ui.t('From Convai or Google Gemini, turning it on selects Local AI, or Custom when Local AI is not installed. With Local AI it also selects the largest uncensored model that fits. Turning it off restores your choices.')
            .. ' ' .. ui.t('Choosing Convai or Google Gemini turns it off. Voxtral is not used with it: a voice on Voxtral moves to Pocket and comes back when it is turned off.')
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
            if serviceState == 'stopped' then
                labels[1], serviceNote = ui.t('Service not running'), support.serviceMessage()
                -- The reason in plain words (mod/setup-check.lua serviceWhy): a Runtime that did not load, an incomplete one, a start Windows refused,
                -- a missing browser. Without it the row could only say "Service not running" (2026-10-27: two players had nothing else to go on).
                local whyOk, why = false, nil
                if convaiSetupCheck and convaiSetupCheck.serviceWhy then whyOk, why = pcall(convaiSetupCheck.serviceWhy) end
                if whyOk and type(why) == 'table' and why.label then labels[1], serviceNote = why.label, why.description or serviceNote end
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
        -- The model that really loaded can differ from the chosen one (one that does not fit beside the game is replaced, with a notice): the row names it, and the choice stays as it was.
        do
            local inUse, chosen = manager.localModelInUseId(), choices[selected]
            if inUse and chosen and chosen.id ~= inUse then
                for _, choice in ipairs(choices) do
                    if choice.id == inUse then
                        label = label .. ' (' .. ui.t('Using {model}', {model = choice.name}) .. ')'
                        modelHelp = ui.t('{model} is in use because the model you chose did not fit beside the game. Your choice is unchanged.', {model = choice.name}) .. '\n\n' .. modelHelp
                    end
                end
            end
        end
        if state == 'warming' then label, status = label .. ' (' .. ui.t('Warming up') .. ')', loadingText('local-ai', 'loading')
        elseif state == 'no-memory' then label, status = label .. ' (' .. ui.t('Not enough memory') .. ')', loadingText('local-ai', 'no-memory')
        elseif state == 'failed' then
            -- Only Mature models (the Mature pack's, or a server of the player's marked uncensored) and Mature content off: say what to do.
            label = label .. ' (' .. ui.t('Unavailable') .. ')'
            status = mistral.localReason == 'mature-off' and ui.t('Only Mature models found. Turn on Mature content to use them.') or loadingText('local-ai', 'failed')
            -- Why, in the bridge's own plain words (the model server you added does not answer, ...): the sentence alone cannot tell a missing server from a failed start.
            -- The one sentence that has a translation (the PC itself refuses the connection to the server: a firewall or security program, bridge/local-llm-server.mjs SERVER_BLOCKED_TEXT) is shown in the menu language.
            if mistral.localReason ~= 'mature-off' and mistral.localDetail then
                local detail = mistral.localDetail
                if detail == 'Something on this PC (a firewall or security software) is blocking the connection to the model server you added.' then
                    detail = ui.t('Something on this PC (a firewall or security software) is blocking the connection to the model server you added.')
                end
                status = status .. '\n\n' .. detail
            end
        end
        status = status or serviceNote
        if status then modelHelp = status .. '\n\n' .. modelHelp end
        modelRow = setting('localModel', label, 'select', selected, modelIndexOf('auto') or 1, modelHelp, labels, {elements = true, description = true, label = true})
    end
    local rows = {
        -- Mistral left the list on 2026-10-30: a player who chose it before keeps it as the third entry while it is the saved choice, everyone else sees Google Gemini there.
        snapshot.settings.conversationProvider == 'mistral'
            and setting('conversationProvider', 'Conversation provider', 'select', providerIndexOf(snapshot.settings), 1, providerHelp,
                {'Convai free tier', 'Convai API key', 'Mistral (your key)', 'Local AI', 'Custom (OpenAI-compatible)'}, {elements = true, description = true})
            or setting('conversationProvider', 'Conversation provider', 'select', providerIndexOf(snapshot.settings), 1, providerHelp,
                {'Convai free tier', 'Convai API key', 'Google Gemini (free plan)', 'Local AI', 'Custom (OpenAI-compatible)'}, {elements = true, description = true}),
        matureRow,
        modelRow,
        -- Allow Local AI to use RAM (off by default): the chosen model stays when it does not fit the graphics memory, with part of it in system memory.
        setting('localOffload', 'Allow Local AI to use RAM', 'bool', snapshot.settings.localOffload == true, false,
            'Off: when the Local AI model you chose does not fit the free graphics memory beside the game, a smaller model that fits is loaded instead, with one notice.\n\nOn: your chosen model is kept and part of it runs from system memory (RAM) on the processor. Replies are slower, and you are told once. It needs enough free RAM, and the game may have less processor time.'),
        keyRow('Convai API key',
            'Copy your key first. It is read from the clipboard once, checked with Convai and saved on this computer.',
            'Deletes the saved key. Conversations go back to Convai free tier.',
            'own-key', {saved = own.saved, tail = own.tail, checking = result == 'checking', message = ownMessage},
            function() return manager.pasteOwnKey() end, function() return manager.removeOwnKey() end),
    }
    -- Custom (OpenAI-compatible): its endpoint URL, API key, model ID and the connection test are a page of their own (customEndpointRows,
    -- opened from this one button), right under the Google Gemini rows, like the Convai paid tier below. Shown whenever the module is there.
    do
        -- Google Gemini: its key (Add / Remove), right under the localOffload row (where the Mistral key row was).
        local at = #rows + 1
        for index, item in ipairs(rows) do if item.id == 'localOffload' then at = index + 1 end end
        for offset, row in ipairs(geminiRows(limitHelp)) do table.insert(rows, at + offset - 1, row) end
    end
    if customProvider.instance then
        local at = #rows + 1
        for _, anchor in ipairs({'localOffload', 'gemini-key'}) do
            for index, item in ipairs(rows) do if item.id == anchor then at = index + 1 end end
        end
        table.insert(rows, at, action('custom-endpoint', 'Custom endpoint', 'Open', 'The address, API key and model ID of your OpenAI-compatible provider, and a connection test. Used when Custom is the Conversation provider.',
            function()
                -- The page reads the bridge's answer again at once, not at the next poll.
                pcall(customProvider.instance.state, true)
                return navigate('custom-endpoint')
            end))
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
            'Edit a character’s bio, speaking style, speaking rules and memories, and the prompting for each AI option, or make a character of your own, in your browser.\n\nWorks with Google Gemini, Local AI and Custom, not Convai. Changes apply from the next reply.',
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
    local info = {}
    for key, on in pairs(settings.dynamicInfo or {}) do info[#info + 1] = key .. '=' .. tostring(on) end
    table.sort(info)
    local immersive = {}
    for key, value in pairs(settings.immersive or {}) do immersive[#immersive + 1] = key .. '=' .. tostring(value) end
    table.sort(immersive)
    local housemates = {}
    for key, value in pairs(settings.housemates or {}) do housemates[#housemates + 1] = key .. '=' .. tostring(value) end
    table.sort(housemates)
    return table.concat(parts, ',') .. ';' .. table.concat(modes, ',') .. ';' .. table.concat(info, ',') .. ';' .. table.concat(immersive, ',')
        .. ';' .. table.concat(housemates, ',')
end

-- What the current page shows that can change without the player touching it, as one string: the page is drawn again only
-- when this changes, so a state the page does not show (a voice going from loading to ready while the Characters list is
-- open) never redraws it. Every field below is read by that page's rows.
-- Do the add-on settings take part in a save: an add-on has registered, or the settings page listed a content pack (mod/addons.lua hasContent).
local function addonSettingsInUse()
    if not convaiAddons then return false end
    return convaiAddons.live == true or (type(convaiAddons.hasContent) == 'function' and convaiAddons.hasContent() == true)
end
local function pageSignature(snapshot)
    local parts = {view, tostring(listPage), tostring(listGroup), tostring(M.feedback())}
    local function add(text) parts[#parts + 1] = text end
    local function memorySignature()
        local memory = snapshot.memory
        add(table.concat({memory.state, tostring(memory.talkedToCount), memory.feedback,
            memory.selectedKey or '', memory.confirmation and memory.confirmation.token or '',
            memory.command and memory.command.id or '', memory.command and memory.command.scope or '',
            memory.command and memory.command.profileKey or '', memory.command and memory.command.state or ''}, '|'))
        -- The page names the memory in use while a content pack with a memory of its own is installed: it redraws when that pack is switched.
        local separate, packName = memoryInUse()
        if separate then add('memory-in-use:' .. tostring(packName)) end
    end
    if view == 'characters' or view == 'side' or view == 'party' then
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
    if view == 'characters' or view == 'side' or view == 'memory' then memorySignature() end
    if view == 'characters' or view == 'side' then
        -- The main list changes when the player makes, renames or deletes a character of their own.
        add('custom:' .. tostring(snapshot.customSignature))
        local voice, pack = snapshot.localVoice, manager.omniPack()
        add(table.concat({voice.provider or '', tostring(voice.cloudVoice), tostring(voice.omniSteps), tostring(voice.omniReference),
            table.concat(voice.routedProfiles or {}, ','), tostring(pack.known), tostring(pack.installed), tostring(pack.noNvidia), tostring(pack.amdRoute), tostring(pack.smallCard),
            tostring((snapshot.mistral or {}).saved)}, '|'))
        add(modelFind.text)
    end
    if (view == 'characters' or view == 'models') and convaiFavorites then add('favorites:' .. tostring(convaiFavorites.revision())) end
    if view == 'party' and convaiSavedParties then add('parties:' .. tostring(convaiSavedParties.revision()) .. '|' .. tostring(convaiSavedParties.armed())) end
    if view == 'models' then
        -- The list is built once the scan has finished (the models are sorted then); until then only the status line shows.
        add(tostring(snapshot.scan.finished))
        if snapshot.scan.finished then add(tostring(#snapshot.models)) end
        add(modelFind.text)
    end
    if support and view == 'help' then
        add('help:' .. support.signature() .. '|' .. support.serviceState())
        if convaiSetupCheck then add('setup:' .. convaiSetupCheck.signature()) end
    end
    if paidTier and view == 'paid-tier' then
        local own = snapshot.ownKey
        add(table.concat({'paid', tostring(own.saved), own.tail or '', own.result or '', paidTier.signature()}, '|'))
    end
    if view == 'custom-endpoint' and customProvider.instance then
        local read, signature = pcall(customProvider.instance.signature)
        add('custom-page:' .. (read and signature or ''))
    end
    if view == 'custom-voices' and remoteOmni.instance then
        local read, signature = pcall(remoteOmni.instance.signature)
        local remote = manager.remoteOmniVoice()
        add('remote-page:' .. (read and signature or '') .. '|' .. tostring(remote.set) .. tostring(remote.connected) .. tostring(remote.requested) .. tostring(remote.fresh))
        local inworldState = (snapshot.mistral or {}).inworld or {}
        add('inworld:' .. tostring(inworldState.saved) .. '|' .. (inworldState.tail or '') .. '|' .. (inworldState.result or ''))
        add(settingsDigest(snapshot.settings))
    end
    if view == 'omni-amd' and omniAmd.instance then
        local read, signature = pcall(omniAmd.instance.signature)
        add('amd-page:' .. (read and signature or ''))
        add(settingsDigest(snapshot.settings))
    end
    if view == 'relationships' or view == 'dynamic-info' or view == 'immersive-invitations' or view == 'housemates' then add(settingsDigest(snapshot.settings)) end
    -- The bonds page is built when it opens (the status file is read once, cached 5 s); only the two settings it depends on redraw it.
    if view == 'bonds' then add('bonds:' .. tostring(snapshot.settings.characterBonds) .. tostring(snapshot.settings.storyPacks)) end
    if view == 'key-bindings' then
        add(settingsDigest(snapshot.settings))
        -- A capture waiting or ended, and the saved keys (the page shows no Cyber Engine Tweaks key, so CET is not asked).
        local module = keyBinds()
        if module then add('keys:' .. tostring(module.capturing()) .. '|' .. module.list(snapshot.settings.keyBindings)) end
    end
    if settingsPages.isSettingsView(view) then
        -- The key rows change when the bridge answers a Paste or Remove, or reports a used-up plan; the provider rows when its
        -- state changes (Local AI warming up and ready); the voice list when the OmniVoice pack appears; the voice status line
        -- when the voice service changes state; every row when its saved value changes.
        add(settingsDigest(snapshot.settings))
        -- The OmniVoice for AMD row appears when the service says this PC can use it.
        if omniAmd.instance then
            local asked, visible = pcall(omniAmd.instance.visible)
            add('amd-row:' .. tostring(asked and visible == true))
        end
        local own, pack, mistral = snapshot.ownKey, manager.omniPack(), snapshot.mistral or {}
        add(table.concat({'key', tostring(own.saved), own.tail or '', own.active, tostring(own.pending),
            own.result or '', own.limit or '', tostring(own.limitOwn), tostring(own.memoryOff),
            own.daily and (tostring(own.daily.left) .. '/' .. tostring(own.daily.blocked)) or ''}, '|'))
        add(table.concat({'provider', tostring(mistral.saved), mistral.tail or '', mistral.provider or '', mistral.effective or '',
            mistral.localAi or '', tostring(mistral.maturePack), tostring(mistral.pending), mistral.result or '', mistral.limit or '', tostring(mistral.stt),
            tostring(pack.known), tostring(pack.installed), tostring(pack.noNvidia), tostring(pack.amdRoute), tostring(pack.smallCard), tostring(snapshot.settings.developerMode)}, '|'))
        -- The Companion voices list shows the Inworld entry once its key is saved.
        add('inworld-key:' .. tostring(((mistral.inworld) or {}).saved))
        -- The Microphone row lists the inputs the service reported (the answer arrives a moment after the page opens).
        add('mics:' .. table.concat(manager.microphoneInputs().inputs, '\n'))
        -- The Local AI model row lists what is installed.
        local modelKey = {'models'}
        modelKey[#modelKey + 1] = 'd:' .. tostring(mistral.localModelDefault) .. ':' .. tostring(mistral.localModelMatureDefault)
        for _, model in ipairs(mistral.localModels or {}) do
            modelKey[#modelKey + 1] = model.id .. ':' .. model.name .. ':' .. tostring(model.sizeMiB) .. ':' .. tostring(model.custom) .. ':' .. tostring(model.tooLarge) .. ':' .. tostring(model.needMiB)
        end
        for _, problem in ipairs(mistral.localModelProblems or {}) do modelKey[#modelKey + 1] = 'x:' .. problem.name .. ':' .. problem.reason end
        -- With no model listed the row names the service state (not running, starting, or its fault), which changes without the player.
        if support and #(mistral.localModels or {}) == 0 then
            modelKey[#modelKey + 1] = 's:' .. support.serviceState() .. ':' .. tostring(support.serviceFault())
            local whyOk, why = false, nil
            if convaiSetupCheck and convaiSetupCheck.serviceWhy then whyOk, why = pcall(convaiSetupCheck.serviceWhy) end
            if whyOk and type(why) == 'table' then modelKey[#modelKey + 1] = 'w:' .. tostring(why.key) end
        end
        add(table.concat(modelKey, '|'))
        -- The Custom provider's rows (state file read at most every 1.5 s, like the Mistral state above).
        if customProvider.instance then
            local read, signature = pcall(customProvider.instance.signature)
            add('custom:' .. (read and signature or ''))
        end
        if geminiProvider.instance then
            local read, signature = pcall(geminiProvider.instance.signature)
            add('gemini:' .. (read and signature or ''))
        end
        -- Installed add-ons' own settings (docs/ADDON_API.md); nothing without one.
        if convaiAddons and convaiAddons.live then add('addons:' .. convaiAddons.signature()) end
        -- Content packs (add-on API 1.1): the rows appear, vanish or flip with the packs the bridge listed and the player's switches.
        if convaiAddons and convaiAddons.contentSignature then add('content:' .. convaiAddons.contentSignature()) end
    end
    return table.concat(parts, '\n')
end
-- Set by M.update when the game has no world (the main menu, a loading screen): Game.GetPlayer() can still hand back an object there,
-- and the pages must not offer invitations without a loaded save.
local noWorld = false

local function keyActionName(id)
    if id == 'voice' then return ui.t('Talk by voice')
    elseif id == 'text' then return ui.t('Talk by text')
    elseif id == 'group_voice' then return ui.t('Group voice chat')
    elseif id == 'group_text' then return ui.t('Group text chat')
    elseif id == 'johnny_voice' then return ui.t('Talk to Johnny by voice')
    elseif id == 'johnny_text' then return ui.t('Talk to Johnny by text') end
    return ui.t('Companion Manager')
end
-- A key as the page says it: the key's name, 'Controller LB' for a controller button, or 'Not set'. The keys that have a word of their own (Space, Page up,
-- D-pad up ...) are literals in mod/key-bindings.lua, which the catalogue reads (scripts/Extract-UiCatalog.mjs, page.key-bindings); the other keys are a
-- letter, a digit or a symbol, the same in every language.
local function keyText(module, name)
    return module.label(name, ui.t) or ui.t('Not set')
end
-- One section of the page: an action with the key set for it here (its button sets it) and Clear.
local function bindingSection(snapshot, module, id, name, how)
    local mine = (snapshot.settings.keyBindings or {})[id]
    local waiting = module.capturing() == id
    -- Every row is a button row, so the page has one look (the hosts draw a read-only text row bigger and indented, the owner's check
    -- of 2026-10-25): the key's own button shows the key and starts the capture. The Cyber Engine Tweaks key is not shown (the owner: no row for it).
    local rows = {
        action('kb:set:' .. id, 'Key or button', waiting and ui.t('Cancel') or keyText(module, mine),
            ui.t(how) .. '\n\n' .. ui.t('Press it, then the key or controller button you want. Esc or B cancels. It works at once.'),
            function()
                -- At the main menu Game.GetPlayer() can still hand back an object, but V is not there to hear a key (noWorld).
                local currentPlayer = not noWorld and player() or nil
                if waiting then module.abandonCapture(currentPlayer); return true end
                local ok, reason = module.beginCapture(currentPlayer, id)
                if ok then return true, ui.t('Press the key or controller button for {action}. Esc or B cancels.', {action = keyActionName(id)}) end
                if reason == 'world' then return false, ui.t('Load a save first. A key can be set only while a game is loaded.') end
                if reason == 'codeware' then return false, ui.t('Key bindings need Codeware, and this game does not have it. Open Help for what is missing.') end
                return false, ui.t('The mod’s scripts did not load, so no key can be set. Open Help for what is wrong.')
            end, nil, {value = true, description = true}),
    }
    if mine then
        rows[#rows + 1] = action('kb:clear:' .. id, 'Clear', 'Clear', 'Remove the key or button you set here.', function()
            module.abandonCapture(player())
            local ok, reason = manager.setKeyBinding(player(), id, nil)
            if not ok then return false, reason end
            return true, ui.t('{action} cleared.', {action = keyActionName(id)})
        end)
    end
    return category('kb:' .. id, name, rows, how)
end
local function keyBindingSections(snapshot)
    local module = keyBinds()
    if not module then
        return {category('key-bindings', 'Key bindings', {readonly('kb:missing', 'Key bindings', 'Not available',
            'The mod’s key bindings could not be loaded. Open Help for what is wrong.')})}
    end
    local sections = {
        bindingSection(snapshot, module, 'voice', 'Talk by voice', 'Hold the key or button while you speak and let go to send, like the Cyber Engine Tweaks talk key. Facing nobody, you talk to the first member of your party.'),
        bindingSection(snapshot, module, 'text', 'Talk by text', 'Press it to type to the character you face. Facing nobody, you type to the first member of your party.'),
        bindingSection(snapshot, module, 'group_voice', 'Group voice chat', 'Hold it to talk to the characters around you at once, and let go to send. Facing nobody, you talk to the first member of your party and two others from it.'),
        bindingSection(snapshot, module, 'group_text', 'Group text chat', 'Press it to type to the characters around you at once. Facing nobody, you type to the first member of your party and two others from it.'),
        bindingSection(snapshot, module, 'johnny_voice', 'Talk to Johnny by voice', 'Hold it to talk to Johnny, the voice in your head, wherever you face, and let go to send. It needs Johnny in your head turned on in Settings.'),
        bindingSection(snapshot, module, 'johnny_text', 'Talk to Johnny by text', 'Press it to type to Johnny, the voice in your head, wherever you face. It needs Johnny in your head turned on in Settings.'),
        bindingSection(snapshot, module, 'manager', 'Companion Manager', 'Press it to open the Companion Manager while you play.'),
    }
    return sections
end

-- A Set ended (mod/key-bindings.lua, from the game's key event): the line under the way back says what came of it, and the page is drawn again.
function M.keyBindResult(result)
    if type(result) ~= 'table' then return end
    local named = {action = keyActionName(result.action)}
    local module = keyBinds()
    if result.kind == 'bound' and module then
        named.key = keyText(module, result.name)
        actionFeedback = ui.t('{action} is set to {key}.', named)
    elseif result.kind == 'duplicate' and module then
        named.key, named.other = keyText(module, result.name), keyActionName(result.other)
        actionFeedback = ui.t('{key} is already used for {other}. Choose another.', named)
    elseif result.kind == 'timeout' then
        -- Not one key event reached the mod (the game keeps them from it in this menu): say so and name the way that always works.
        if result.heard == 0 then actionFeedback = ui.t('No key press reached the mod, so nothing changed. If keys do not arrive from this menu, set the key in Cyber Engine Tweaks’ Bindings: it works the same.')
        else actionFeedback = ui.t('No key was pressed, so nothing changed.') end
    elseif result.kind == 'failed' then
        actionFeedback = ui.t(result.reason or 'The settings could not be saved. Nothing was changed.')
    else
        actionFeedback = ui.t('Cancelled.')
    end
    refreshQueued = true
end
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
    -- Romances that grew from talk (Settings > Companions > Character bonds, bridge/romance-bond.mjs): one read-only row each, below the five. They end when V tells the character.
    local native = {}
    for _, profile in ipairs(manager.relationshipChoices()) do native[profile.key] = true end
    local ok, list = false, nil
    if type(convaiBondsRomances) == 'function' then ok, list = pcall(convaiBondsRomances) end
    for _, item in ipairs(ok and type(list) == 'table' and list or {}) do
        if type(item) == 'table' and type(item.profileKey) == 'string' and not native[item.profileKey] and type(item.name) == 'string' then
            rows[#rows + 1] = readonly('romance:' .. item.profileKey, item.name, 'Together',
                ui.t('You and {name} are together. This grew from talking and is kept in this save. To end it, tell them.', {name = item.name}),
                {label = true, description = true})
        end
    end
    return rows
end

-- Dynamic info: one switch per kind of live game info a turn can carry (the kinds and their order are manager.dynamicInfoKinds). A page of its
-- own, opened from the Conversations section of Settings (both hosts draw it from here). Each row is a literal call so the catalogue reads the text.
local function dynamicInfoRows(snapshot)
    local on = snapshot.settings.dynamicInfo or {}
    local function row(kind, label, description)
        -- All on by default except Other mods' state.
        local default = kind ~= 'mods'
        local value = on[kind]
        if type(value) ~= 'boolean' then value = default end
        return setting('dynamic:' .. kind, label, 'bool', value, default, description)
    end
    return {
        row('location', 'Location',
            'Where V is: the district, and V’s apartment or the named place when the game says so.\n\nOff: characters are not told where you are, and the mod stops reading it from the game. The vision Convai has of what V sees, and an add-on’s own text, are not affected.'),
        row('time', 'Time and weather',
            'The hour of the day and the weather in Night City.\n\nOff: nobody is told the time or the weather, and the mod stops reading them from the game.'),
        row('company', 'Company and vehicle',
            'Who else is with V, whether V is on foot or in a vehicle, and what a companion is doing beside V.\n\nOff: none of this is sent, and the mod stops reading it from the game.'),
        row('condition', 'Health, heat and fights',
            'V’s health, the police heat on V, and the last fight V was in.\n\nOff: none of this is sent, and the mod stops reading it from the game.'),
        row('money', 'V’s money',
            'A rough idea of how many eddies V has: nearly broke, short, comfortable or rich.\n\nOff: it is not sent, and the mod stops reading it from the game.'),
        row('gear', 'V’s gear and clothes',
            'What V wears and carries: clothes, weapons and cyberware that can be seen.\n\nOff: it is not sent, and the mod stops reading it from the game.'),
        row('about', 'V’s gender and lifepath',
            'Whether V is a woman or a man, and V’s lifepath: Nomad, Street Kid or Corpo.\n\nOff: it is not sent with a turn, and the mod stops reading it for that. Your story’s own facts may still reflect your lifepath.'),
        row('quest', 'Quest and journal',
            'V’s tracked quest and its objectives, the jobs V has open and the journal history.\n\nWhat each character knows about your story stays on.\n\nOff: none of this is sent. The mod stops scanning the journal for it, unless Johnny’s remarks are on.'),
        row('lastTalk', 'Time since last talk',
            'How long it has been since V last talked to this character, in the game and in real days: since last night, or days ago. Said only when the gap is long enough to matter, and not again in the same conversation.\n\nOff: it is not sent, and the mod stops reading the game clock for it.'),
        row('media', 'Music and TV',
            'The song playing on the car radio while V rides with the character, or on V’s pocket radio, and what is on a TV near V.\n\nOff: it is not sent, and the mod stops reading it from the game.'),
        row('mods', 'Other mods’ state',
            'How V is doing according to other mods, when they are installed: Dark Future’s tiredness, hunger, thirst, nerve and addictions, for example. Also what V visibly wears while an Equipment-EX outfit is on, so characters describe the outfit and not the clothes it hides.\n\nOff by default. Off: it is not sent, and nothing is read from those mods.'),
        row('dialogue', 'Recent game dialogue',
            'The last lines spoken in scenes and V’s chosen replies, so a character can pick up from what was just said.\n\nOff: they are not sent.'),
    }
end

-- ---- Favorites (Characters to invite, Model browser) ------------------------------------------------------------------------------
-- Per-row buttons only: the settings screens cannot tell which row the player is on, so there is no page-wide button. On both pages:
--   * a character (model) that is not invited has one row, Invite;
--   * once she is in the party the row's button is Add to favorites, and a row of the same name right under it is Add copy (the old button);
--   * a favorite has no Add to favorites row: she is in the Favorites block at the top of page 1, each with her Invite / Add copy row and,
--     under it, Remove from favorites; her place in the list below keeps its one Invite / Add copy row.
-- The favorites are the data of mod/favorites.lua; the phone's Chat tab lists them first (mod/phone-chat.lua).
local FAVORITES_SHOWN = 30

-- Turns the favorite of one entry on or off and says what happened (the page's feedback line).
local function setFavorite(scope, key, name, on)
    local now, kept, why = convaiFavorites.set(scope, key, on)
    if now == nil then return false, ui.t('That entry cannot be a favorite.') end
    refreshQueued = true
    if why == 'full' then return false, ui.t('You have too many favorites. Remove one first.') end
    local text = now and ui.t('{name} is now a favorite. Favorites are at the top of page 1.', {name = name})
        or ui.t('{name} is no longer a favorite.', {name = name})
    if kept == false then text = text .. ' ' .. ui.t('Your favorites could not be saved, so they last only until the game closes.') end
    return true, text
end

-- The rows of one entry of the main list: Add to favorites above the Invite / Add copy row, for an entry that is in the party and not yet a
-- favorite. `inviteOf(item, id)` builds the Invite / Add copy row of the page.
local function entryRows(rows, scope, item, name, copies, inviteOf)
    if convaiFavorites and copies > 0 and not convaiFavorites.isFavorite(scope, item.key) then
        local key = item.key
        rows[#rows + 1] = action('favorite:add:' .. key, name, 'Add to favorites',
            ui.t('Adds {name} to your favorites. They are listed at the top of page 1, and first in the phone’s Chat tab. Updates never touch them.', {name = name}),
            function() return setFavorite(scope, key, name, true) end, nil, {label = true, description = true})
    end
    rows[#rows + 1] = inviteOf(item, 'invite:' .. item.key)
end

-- The Favorites block: the favorites of `list` (the page's list, search and letter group applied) on page 1, each with her Invite / Add copy row
-- and a Remove from favorites row under it. Empty on any other page.
local function favoriteRows(scope, list, nameOf, inviteOf)
    local rows = {}
    if not convaiFavorites or listPage ~= 1 or convaiFavorites.count(scope) == 0 then return rows end
    local shown, more = 0, 0
    for _, item in ipairs(list) do
        local key = item.key
        if convaiFavorites.isFavorite(scope, key) then
            if shown < FAVORITES_SHOWN then
                shown = shown + 1
                local name = nameOf(item)
                rows[#rows + 1] = inviteOf(item, 'invite:favorite:' .. key)
                rows[#rows + 1] = action('favorite:remove:' .. key, 'Remove from favorites', 'Remove',
                    ui.t('Takes {name} out of your favorites. Her place in the list below stays.', {name = name}),
                    function() return setFavorite(scope, key, name, false) end, nil, {description = true})
            else more = more + 1 end
        end
    end
    if more > 0 then
        rows[#rows + 1] = readonly('favorites-more', ui.t('{count} more favorites', {count = more}), '',
            ui.t('Only the first {count} favorites are listed here. The others are in the list below.', {count = FAVORITES_SHOWN}), {label = true, description = true})
    end
    return rows
end

-- Invite (Characters, Model browser): with Settings > Immersive invitations On it is an appointment she travels to; Off, or when it
-- takes no part (the character is already in the party), the old instant invitation (docs/IMMERSIVE_INVITATIONS.md).
local function inviteKey(key)
    local service = convaiImmersiveGet and convaiImmersiveGet() or nil
    if service then
        local accepted, message = service.requestInvite(key)
        if accepted ~= nil then return accepted, message end
    end
    return queue.invite(key)
end

-- Immersive invitations: its own page, opened from Gameplay. The list values are positions in the lists of manager.immersiveChoices.
local function immersiveRows(snapshot)
    local value = snapshot.settings.immersive or {}
    local arrivals, delays, waits = manager.immersiveChoices()
    local function index(list, wanted, fallback)
        for position, item in ipairs(list) do if item == wanted then return position end end
        return fallback
    end
    return {
        setting('immersive:enabled', 'Immersive invitations', 'bool', value.enabled == true, false,
            'Off: Invite brings a companion to your side at once.\n\nOn: a companion you invite, by the Invite button, the Contacts tab or a text, travels to you and arrives after the time you choose here. She texts you when she is there, waits, and leaves angry (and remembers it) if you never come.'),
        setting('immersive:arrival', 'How she arrives', 'select', index(arrivals, value.arrival, 1), 1,
            'Walk: she appears out of your sight and walks to you.\n\nCar: when a road is near she drives in, stops on the road, gets out and walks the rest. Without a road she walks. The car stays near for a ride, and is removed when she leaves your group or you both go far from it.',
            {'Walk', 'Car'}),
        setting('immersive:delay', 'When she arrives', 'select', index(delays, value.delay, 1), 1,
            'Right now: she is on her way as soon as she is ready.\n\nIn 2, 5 or 10 minutes: real minutes of play, so she arrives at that time. She then waits as long as that delay.',
            {'Right now', 'In 2 minutes', 'In 5 minutes', 'In 10 minutes'}),
        setting('immersive:wait', 'How long she waits', 'select', index(waits, value.wait, 2), 2,
            'How long she waits for you after arriving right now. After a timed arrival she waits as long as the delay you chose. The wait stops while you are in a fight, a scene or a menu.',
            {'2 minutes', '5 minutes', '10 minutes'}),
        setting('immersive:waypoint', 'Meet at my waypoint when I ask', 'bool', value.waypoint ~= false, true,
            'When you ask her to come to your waypoint and a map pin is set, she goes there and says so. Off: she always comes to where you are.'),
        setting('immersive:texts', 'She texts you', 'bool', value.texts ~= false, true,
            'She texts you when she arrives, when you cancel and when she gives up. Off: no texts (she still remembers being stood up).'),
    }
end

-- Housemates: its own page, opened from Gameplay (docs/HOUSEMATES.md). Off by default: nothing of the feature is loaded while it is Off.
-- The Move-in apartment list: "Ask me", then the apartments V owns now (the owned ones are known while Housemates is On). {ids, names (translated)}.
local function moveInChoices()
    local ids, names = {'ask'}, {ui.t('Ask me')}
    for _, flat in ipairs(convaiHousemateOwned and convaiHousemateOwned() or {}) do
        ids[#ids + 1], names[#names + 1] = flat.id, ui.t(flat.name)
    end
    return ids, names
end
local function housemateSettingRows(snapshot)
    local value = snapshot.settings.housemates or {}
    local cooldowns, sizes = manager.housemateChoices()
    local function index(list, wanted, fallback)
        for position, item in ipairs(list) do if item == wanted then return position end end
        return fallback
    end
    local moveIds, moveNames = moveInChoices()
    local housemates = convaiHousemateRows and convaiHousemateRows() or {}
    return {
        setting('housemates:enabled', 'Housemates', 'bool', value.enabled == true, false,
            'On: characters you tell they can stay at your place move into your apartments and live there, and you can call them along.\n\nOff: nothing of this runs. Turning it off removes them from your apartments but remembers who lived there, so turning it on brings them back.'),
        setting('housemates:moveIn', 'Move-in apartment', 'select', index(moveIds, value.moveIn, 1), 1,
            'Where a character moves in when you say she can stay but name no apartment and you are not standing in one of yours.\n\nAsk me: she asks which one. Otherwise she takes the apartment you pick here. Only the apartments you own are listed.',
            moveNames, {elements = true}),
        setting('housemates:chat', 'Housemates talk to each other', 'bool', value.chat ~= false, true,
            'When two or more housemates are home with you, they talk to each other now and then.'),
        setting('housemates:chatCooldown', 'Pause between chats', 'select', index(cooldowns, value.chatCooldown, 2), 2,
            'How long the housemates stay quiet after a chat before they may start another. The Companions speak up setting still limits how many chats come in an hour.',
            {'1 minute', '2 minutes', '5 minutes', '10 minutes'}),
        setting('housemates:chatSize', 'Housemates in one chat', 'select', index(sizes, value.chatSize, 1), 1,
            'How many housemates join one chat when that many are home near each other. They speak one at a time. With fewer at home, the chat is as big as it can be.',
            {'2 people', '3 people', '4 people'}),
        action('housemates:evict', 'Evict all housemates', 'Evict',
            'Every character who lives at your place moves out at once, from every apartment. Party members who do not live there are not touched. A housemate who is with you stays in your party.',
            function()
                local count = convaiHousemateEvictAll and convaiHousemateEvictAll() or 0
                if count == 0 then return false, ui.t('Nobody lives at your place.') end
                return true, ui.t('Housemates moved out: {count}', {count = count})
            end, #housemates > 0),
    }
end

-- ---- Parties: the saved parties (mod/saved-parties.lua, docs/MANAGER_UI.md "Parties") -------------------------------------------------
-- Everything here runs when the page is built or a button is pressed, never per frame. The one entry point is a function of M, not a local,
-- so schema() gains no upvalue.

-- The members of the party now, in the order they joined, as a saved party keeps them: an invitation still being prepared counts, a copy
-- that is leaving and a failed invitation do not.
local function currentPartyMembers(list)
    local members = {}
    for _, member in ipairs(list) do
        if member.state ~= 'leaving' and member.state ~= 'failed' and type(member.key) == 'string' then
            members[#members + 1] = {key = member.key, name = member.baseName or member.name}
        end
    end
    return members
end

-- "Judy, Panam (2)": the names of a saved party's members, a character who is in it more than once with the number of copies. The name is the
-- character's own now (a custom character may have been renamed), the saved one when the character is gone.
local function memberSummary(party)
    local order, names, counts = {}, {}, {}
    for _, member in ipairs(party.members) do
        if not counts[member.key] then
            local definition = manager.definition(member.key)
            order[#order + 1] = member.key
            names[member.key] = definition and definition.name or member.name
            counts[member.key] = 0
        end
        counts[member.key] = counts[member.key] + 1
    end
    local parts = {}
    for _, key in ipairs(order) do
        parts[#parts + 1] = counts[key] > 1 and ui.t('{name} ({count})', {name = names[key], count = counts[key]}) or names[key]
    end
    return table.concat(parts, ', ')
end

local function savedParty(id)
    local saved = convaiSavedParties
    local party = saved and saved.get(id) or nil
    if not party then refreshQueued = true end
    return party
end

local function savedNotWritten(text, kept)
    if kept == false then text = text .. ' ' .. ui.t('Your saved parties could not be written to disk, so they last only until the game closes.') end
    return text
end

local function saveCurrentParty()
    local saved = convaiSavedParties
    local members = currentPartyMembers(queue.list())
    if #members == 0 then return false, ui.t('Your party is empty. Invite someone first.') end
    local created, kept = saved.create(members, nil, ui.t('Party'))
    if not created then
        if kept == 'full' then return false, ui.t('You can keep {count} saved parties. Delete one first.', {count = saved.MAX_PARTIES}) end
        return false, ui.t('The party could not be saved.')
    end
    local text = ui.t('Saved as {name}. Press Spawn party under it to invite them again.', {name = created.name})
    if #members > saved.MAX_MEMBERS then text = text .. ' ' .. ui.t('A saved party holds {count} characters, so the rest were left out.', {count = saved.MAX_MEMBERS}) end
    return true, savedNotWritten(text, kept)
end

local function updateSavedParty(id)
    local party = savedParty(id)
    if not party then return false, ui.t('That party no longer exists.') end
    local members = currentPartyMembers(queue.list())
    if #members == 0 then return false, ui.t('Your party is empty. Invite someone first.') end
    local _, kept = convaiSavedParties.update(id, members)
    local text = ui.t('{name} now has the characters of your party.', {name = party.name})
    if #members > convaiSavedParties.MAX_MEMBERS then text = text .. ' ' .. ui.t('A saved party holds {count} characters, so the rest were left out.', {count = convaiSavedParties.MAX_MEMBERS}) end
    return true, savedNotWritten(text, kept)
end

-- The new name comes from MCM's Search box (the only text box the manager can use; Native Settings UI has none).
local function renameSavedParty(id)
    local party = savedParty(id)
    if not party then return false, ui.t('That party no longer exists.') end
    if not modelFind.offered then
        return false, ui.t('This menu has no text box, so the party keeps its name. Mod Configuration Menu has one: type the name in its Search box.')
    end
    local name = convaiSavedParties.cleanName(modelFind.typed)
    if not name then return false, ui.t('Type the new name in the Search box first, then press Rename.') end
    local renamed, kept = convaiSavedParties.rename(id, name)
    if not renamed then return false, ui.t('Another saved party already has that name.') end
    return true, savedNotWritten(ui.t('Renamed to {name}.', {name = renamed.name}), kept)
end

-- Delete asks twice: the first press arms the row, the second one deletes (any other button, or another page, disarms it).
local function deleteSavedParty(id)
    local party = savedParty(id)
    if not party then return false, ui.t('That party no longer exists.') end
    if convaiSavedParties.armed() ~= id then
        convaiSavedParties.arm(id)
        return true, ui.t('Press Delete again to delete {name}.', {name = party.name})
    end
    local _, kept = convaiSavedParties.remove(id)
    return true, savedNotWritten(ui.t('{name} deleted.', {name = party.name}), kept)
end

-- Spawn party: the members who are not with V yet are invited, the way the Invite buttons invite them one at a time (the same queue, the same
-- preparation, the same notices; with Immersive invitations On a first invitation of a character is an appointment). It ADDS to the party:
-- nobody is dismissed, and a character already in the party (joined, being prepared or on her way) counts toward the saved members, so pressing
-- it twice does not double the party, while a saved party that names a character twice gets her second copy. A member that cannot come is
-- left out and named with the reason. The bodies appear one per flush (the queue's `stagger`), not all in one frame.
local function spawnSavedParty(id)
    local party = savedParty(id)
    if not party then return false, ui.t('That party no longer exists.') end
    if not owner then return false, ui.t('Load a save before inviting a companion.') end
    local have = {}
    for _, member in ipairs(queue.list()) do
        if member.state ~= 'leaving' and member.state ~= 'failed' and type(member.key) == 'string' then have[member.key] = (have[member.key] or 0) + 1 end
    end
    local service = convaiImmersiveGet and convaiImmersiveGet() or nil
    if service then
        for _, row in ipairs(service.rows()) do
            if not row.serial and row.key then have[row.key] = (have[row.key] or 0) + 1 end
        end
    end
    local board = invitationBoard()
    local invited, present, left, asked = {}, {}, {}, {}
    for _, member in ipairs(party.members) do
        local key = member.key
        local definition = manager.definition(key)
        local name = definition and definition.name or member.name
        if (have[key] or 0) > 0 then
            have[key] = have[key] - 1
            present[#present + 1] = name
        elseif not definition then
            left[#left + 1] = ui.t('{name} ({reason})', {name = name, reason = ui.t('that character model is unavailable')})
        else
            local accepted, message, invitationId
            -- The first invitation of a character may be an appointment; a copy beyond it is a plain invitation.
            if service and not asked[key] then accepted, message, invitationId = service.requestInvite(key) end
            asked[key] = true
            if accepted == nil then accepted, message, invitationId = queue.invite(key, {stagger = true}) end
            if accepted == true then
                invited[#invited + 1] = name
                if type(invitationId) == 'string' and board then board.track(invitationId, 'manager') end
            else
                local reason = (message ~= nil and message ~= '') and message or ui.t('the invitation was refused')
                left[#left + 1] = ui.t('{name} ({reason})', {name = name, reason = reason})
            end
        end
    end
    local parts = {}
    if #invited > 0 then parts[#parts + 1] = ui.t('{party}: inviting {names}.', {party = party.name, names = table.concat(invited, ', ')}) end
    if #present > 0 then parts[#parts + 1] = ui.t('Already with you: {names}.', {names = table.concat(present, ', ')}) end
    if #left > 0 then parts[#parts + 1] = ui.t('Could not invite: {names}.', {names = table.concat(left, '; ')}) end
    if #parts == 0 then return false, ui.t('{name} has nobody to invite.', {name = party.name}) end
    return #invited > 0 or #present > 0, table.concat(parts, ' ')
end

-- The last row of Current party (Save current party), added to `rows`, and one section per saved party under it, added to `categories`.
-- `list` is the queue's party list.
function M.partyRows(rows, categories, list, canInvite)
    local saved = convaiSavedParties
    if not saved then return end
    local hasMembers = #currentPartyMembers(list) > 0
    -- Nobody to save (an empty party, or no save loaded): no Save row, so that page stays as it was.
    if hasMembers then
        rows[#rows + 1] = action('party:save', 'Save current party', 'Save',
            ui.t('Saves the characters in your party now, copies and your own characters included, as a party you can invite again with one press. It is named Party 1, Party 2 and so on, and appears below.\n\nYou keep up to {count} saved parties.', {count = saved.MAX_PARTIES}),
            saveCurrentParty, nil, {description = true})
    end
    for _, party in ipairs(saved.list()) do
        local id = party.id
        local armed = saved.armed() == id
        local summary = memberSummary(party)
        local section = {}
        section[#section + 1] = readonly('party:members:' .. id, summary, '', ui.t('The characters of this party: {names}.', {names = summary}), {label = true, description = true})
        section[#section + 1] = action('party:spawn:' .. id, 'Spawn party', 'Spawn',
            ui.t('Invites the characters of this party to your side: {names}.\n\nIt adds to your party and dismisses nobody. A character who is already with you is not invited twice. Anyone who cannot come is named, with the reason.', {names = summary}),
            function() return spawnSavedParty(id) end, canInvite, {description = true})
        section[#section + 1] = action('party:update:' .. id, 'Update with current party', 'Update',
            'Replaces the characters of this saved party with the ones in your party now.', function() return updateSavedParty(id) end, hasMembers)
        section[#section + 1] = action('party:rename:' .. id, 'Rename party', 'Rename',
            'Type the new name in the Search box at the top (Mod Configuration Menu), then press Rename. Native Settings UI has no text box, so a party keeps its name there.',
            function() return renameSavedParty(id) end)
        local delete = function() return deleteSavedParty(id) end
        if armed then
            section[#section + 1] = action('party:delete:' .. id, 'Delete', 'Press again', 'Press again to delete this saved party. Anything else cancels.', delete)
        else
            section[#section + 1] = action('party:delete:' .. id, 'Delete', 'Delete', 'Deletes this saved party. The characters in your party now are not touched.', delete)
        end
        categories[#categories + 1] = category('saved-party:' .. id, ui.t('Saved party: {name}', {name = party.name}), section)
    end
end

-- Settings (2026-10-30): a short list of category pages, each one built only when it is opened (never per frame). `list` is the order of the rows on Settings and
-- `byView` finds a page by its view name. Every row keeps its stored key; the pages Memory, Dynamic info, Relationships, Immersive invitations, Housemates, Custom voices,
-- OmniVoice for AMD, Convai paid tier, Custom endpoint and Help open from a row of a category page and go back to it (BACK in schema).
settingsPages.list = {
    {view = 'settings-provider', id = 'provider', name = 'AI provider', description = 'Who writes the replies.'},
    {view = 'settings-voice', id = 'voice', name = 'Voice and microphone', description = 'How everyone sounds, and how you talk.'},
    {view = 'settings-conversations', id = 'conversations', name = 'Conversations', description = 'Who you can talk to and what they know.'},
    {view = 'settings-companions', id = 'companions', name = 'Companions', description = 'Life with your party.'},
    {view = 'settings-night-city', id = 'night-city', name = 'Night City', description = 'How the world reacts to V.'},
    {view = 'settings-interface', id = 'interface', name = 'Interface', description = 'The language of the menus and how subtitles look.'},
    {view = 'settings-content-packs', id = 'content-packs', name = 'Content packs', description = 'Add-ons that change how the characters talk.'},
    {view = 'settings-privacy', id = 'privacy', name = 'Privacy and help', description = 'Error reports, developer mode and help.'},
}
for _, page in ipairs(settingsPages.list) do settingsPages.byView[page.view] = page end

-- The Content packs page exists only while an add-on has settings of its own or the bridge listed a content pack (as the sections did on the one long page).
function settingsPages.packsShown()
    if not convaiAddons then return false end
    if convaiAddons.live and #convaiAddons.settingsSections() > 0 then return true end
    return type(convaiAddons.contentPacks) == 'function' and #convaiAddons.contentPacks() > 0
end

-- Is this view Settings or one of its category pages (the pages Restore defaults covers, with the sub-pages that have rows of their own)?
function settingsPages.isSettingsView(name)
    return name == 'settings' or settingsPages.byView[name] ~= nil
end

-- The rows of the Settings page itself: one Open row for each category.
function settingsPages.listRows()
    local rows = {}
    for _, page in ipairs(settingsPages.list) do
        if page.view ~= 'settings-content-packs' or settingsPages.packsShown() then
            local target = page.view
            rows[#rows + 1] = action('settings:' .. page.id, page.name, 'Open', page.description, function() return navigate(target) end)
        end
    end
    return rows
end

-- AI provider: who writes the replies, Mature content, Local AI and the provider keys (ownKeyRows, with the Convai paid tier and Custom endpoint pages).
settingsPages['settings-provider'] = function(snapshot)
    return {category('conversation-provider', 'AI provider', ownKeyRows(snapshot))}
end

-- Voice and microphone. The list: Pocket Performance (the default), the Mistral cloud voice (Voxtral), OmniVoice Balanced / Quality (16 steps, short / long reference),
-- High Quality / Ultra Quality (32 steps, short / long reference), Convai Cloud voice.
settingsPages['settings-voice'] = function(snapshot)
    local voiceIndex = savedVoiceIndex(snapshot.settings)
    -- Lip sync delay (Bluetooth): Auto, Off, then milliseconds (bridge/audio-delay.mjs).
    local delays, delayLabels, delayIndex = manager.audioDelayChoices(), {}, 1
    for index, value in ipairs(delays) do
        delayLabels[index] = value == 'auto' and ui.t('Auto') or value == 0 and ui.t('Off') or (tostring(value) .. ' ms')
        if snapshot.settings.audioDelay == value then delayIndex = index end
    end
    local voiceRange = manager.voiceVolumeRange()
    -- The microphone list is asked for when this page is built (at most once in 15 s, the answer redraws the page): never per frame, never per turn.
    pcall(manager.requestMicrophoneInputs)
    local micLabels, _, micIndex, micAnyMarked, micSavedMarked = microphoneChoices(snapshot.settings)
    -- Voice language: English (the default), Automatic, then the mod's other languages, in the bridge's order (manager.replyLanguageChoices).
    local replyCodes, replyLabels, replyIndex = manager.replyLanguageChoices(), {}, 1
    for index, code in ipairs(replyCodes) do
        replyLabels[index] = ui.t(REPLY_LANGUAGE_NAMES[code] or code)
        if snapshot.settings.replyLanguage == code then replyIndex = index end
    end
    local pack = manager.omniPack()
    -- While the OmniVoice pack is missing its entries are greyed out; the row's name says why, in brackets.
    local voiceName = ui.t('Companion voices')
    if pack.known and not pack.installed then voiceName = voiceName .. ' (' .. ui.t('no Omni pack') .. ')'
    -- The bridge knows this PC has no NVIDIA graphics card: the OmniVoice entries stay choosable (they fall back), the row says what they need.
    elseif pack.amdRoute then voiceName = voiceName .. ' (' .. ui.t('OmniVoice on AMD: set up first') .. ')'
    elseif pack.noNvidia then voiceName = voiceName .. ' (' .. ui.t('OmniVoice needs NVIDIA') .. ')'
    -- The NVIDIA card has under 12 GB (the bridge's card list): the entries stay choosable, the row says what OmniVoice needs.
    elseif pack.smallCard then voiceName = voiceName .. ' (' .. ui.t('OmniVoice needs 12 GB') .. ')' end
    -- Why OmniVoice cannot speak for V now ('pack' before 'voice'), from the saved settings; nil when it can.
    local vOmniBlock = manager.vOmniBlock(snapshot.settings)
    -- V's voice is one list over the two stored settings vVoice (typed lines) and vVoiceMic (spoken lines): 1 Off, 2 Typed lines, 3 Typed and spoken lines.
    -- The engine is its own row (stored vVoiceEngine, shared by both kinds of line): 1 Pocket, 2 Voxtral (greyed out until a Mistral key is saved, and with Mature content on),
    -- 3 OmniVoice (greyed out until the OmniVoice pack is installed and the saved companion voice is OmniVoice; the pack comes first). A saved Voxtral shows as Voxtral
    -- without a key too (its entry says it needs one, V's line is skipped meanwhile and no Pocket worker loads for it). A saved OmniVoice that cannot be used reads as
    -- Pocket (the bridge speaks it with Pocket then, bridge/convai-bridge.mjs).
    local vModeIndex = snapshot.settings.vVoiceMic == true and 3 or snapshot.settings.vVoice == true and 2 or 1
    local vEngineIndex = (snapshot.settings.vVoiceEngine == 'voxtral' and snapshot.settings.matureContent ~= true) and 2
        or (snapshot.settings.vVoiceEngine == 'omni' and not vOmniBlock) and 3 or 1
    local vEngineElements = {ui.t('Pocket · On your PC'), snapshot.settings.matureContent == true and ui.t('Voxtral · not with Mature')
        or (snapshot.mistral or {}).saved and ui.t('Voxtral · Mistral cloud') or ui.t('Voxtral · needs Mistral key'),
        vOmniBlock == 'pack' and ui.t('OmniVoice · needs Omni pack') or vOmniBlock == 'voice' and ui.t('OmniVoice · needs Omni voice')
        or ui.t('OmniVoice')}
    local rows = {
        -- One list for both stored settings (voice, voiceProvider): 1 Off (replies are text only and no voice is generated), then the companion voices in
        -- voicePreviewModule.CHOICES order, so a voice is the list position plus one. Off keeps the voice that was saved, so turning it back on restores it.
        setting('voiceProvider', voiceName, 'select', snapshot.settings.voice == false and 1 or voiceIndex + 1, 2,
            ui.t('Off: replies are text only and no voice is generated.\n\nWith Subtitles off as well, automatic reactions stay silent.') .. '\n\n'
                .. ui.t('Pocket: the lightest, on your CPU, about 0.2 s to the first word.\n\nOmniVoice: richer, needs a capable GPU and its pack, 1 to 2.5 s.\n\nVoxtral: cloud voices with your Mistral key. The companions’ voice loads no local model; V’s typed lines follow V’s own voice setting.\n\nConvai: its own cloud voice. A voice that cannot run shows replies as text.'),
            voiceMenuLabels(pack, snapshot.mistral, snapshot.settings.matureContent == true, snapshot.settings.voiceProvider), {elements = true, label = true, description = true}),
        -- Shown with Companion voices Off too, greyed by its own words: the description says it only counts while voices are on.
        setting('replyLanguage', 'Voice language', 'select', replyIndex, 1,
            'The language the characters speak. Counts only while Companion voices is not Off; with it Off, replies follow what you write.\n\nAutomatic: follows what you write or say, and never changes on a short line.\n\nA voice that cannot speak the language shows the reply as text.',
            replyLabels, {elements = true}),
        -- Two sliders, 50 to 300 in steps of 5, the page shows the number so the unit is in the name. The bridge applies the companions' volume to every voice but
        -- V's (companions, NPCs, add-ons) and V's voice volume to V's spoken lines alone, each as gain behind a peak limiter, it takes effect on the next reply.
        setting('voiceVolume', 'Companion voice volume (%)', 'int', snapshot.settings.voiceVolume, voiceRange.default,
            'How loud the companions’ and characters’ voices are. 100 is the normal level, 150 the default.\n\nAbove 100 the voices get louder, with a limiter so they do not crackle. V’s voice has its own setting below, and the game’s own dialogue and sounds do not change.\n\nThe next reply uses it.',
            nil, {min = voiceRange.min, max = voiceRange.max, step = voiceRange.step}),
        setting('vVoice', 'V’s voice', 'select', vModeIndex, 2,
            'Off: V is silent.\n\nTyped lines: the lines you type are spoken out loud too, in the V voice that matches yours, then the companion answers.\n\nTyped and spoken lines: what you say by microphone (hold to talk or Voice activation) is also spoken by V, and the reply follows V’s line.\n\nV’s line is always waited for, up to about 30 s without audio. The next row picks the voice engine.',
            {'Off', 'Typed lines', 'Typed and spoken lines'}),
        setting('vVoiceEngine', 'V’s voice engine', 'select', vEngineIndex, 1,
            'The voice V speaks with, whatever the companions use. It counts only while V’s voice is not Off.\n\nPocket: on your processor, about 0.2 s (its own small model if the companions use another voice). Voxtral: cloud, with your Mistral key. OmniVoice: the companions’ GPU voice, a second more wait.',
            vEngineElements, {elements = true}),
        setting('vVoiceVolume', 'V’s voice volume (%)', 'int', snapshot.settings.vVoiceVolume, voiceRange.default,
            'How loud V’s own voice is, for V’s typed and microphone lines. 100 is the normal level, 150 the default.\n\nAbove 100 the voice gets louder, with a limiter so it does not crackle. The companions’ voices and the game’s own dialogue and sounds do not change.\n\nThe next line uses it.',
            nil, {min = voiceRange.min, max = voiceRange.max, step = voiceRange.step}),
        setting('naturalSpeech', 'Natural speech', 'bool', snapshot.settings.naturalSpeech, false,
            'Companions now and then pause, hesitate, laugh or sigh, as their personality would. It stays rare.\n\nOmniVoice can voice laughs and sighs; the other voices only add pauses.\n\nNot available with Convai’s cloud voice: choosing it turns this off, and turning this on switches the voice to Pocket.'),
        -- The input device for every way of talking (key, Voice activation). The list comes from the voice browser's capture page. Inputs that look like a loopback
        -- or virtual device are marked and explained below the usual text (only when one is listed or chosen), and the chosen one gets a plain warning.
        setting('micDevice', 'Microphone', 'select', micIndex, 1,
            ui.t('The input the mod listens to for the talk keys and Voice activation.\n\nWindows default follows the input Windows picks. Choose another if the default never hears you, for example when a mixer app routes your microphone elsewhere.\n\nA change counts the next time the microphone opens. A missing input falls back to the default.')
                .. (micAnyMarked and '\n\n' .. ui.t('An input marked (!) looks like a loopback or virtual input, such as Stereo Mix, CABLE Output or a mixer’s Out. It can carry other apps’ sound, for example the far side of a call, so the mod never picks one by itself.') or '')
                .. (micSavedMarked and '\n\n' .. ui.t('The input you chose looks like it carries PC sound, not only your voice. If characters hear your calls, choose your real microphone.') or ''),
            micLabels, {elements = true, description = true}),
        -- Off by default: talk with no key (docs/VOICE_INPUT.md). The microphone is closed while it is off.
        setting('voiceActivation', 'Voice activation', 'bool', snapshot.settings.voiceActivation == true, false,
            'Talk without a key. While you face a character or a companion is near, the mod listens and answers when you pause for about a second.\n\nNever during the game’s own scenes or choices, or while a character speaks. Nothing leaves your PC unless speech is heard. Headphones work best, but a Bluetooth headset’s microphone drops it to call quality while this listens.'),
        -- Off by default: say one of the game's dialogue choices to pick it (docs/VOICE_CHOICES.md). It sits with the microphone rows (2026-10-30); the stored key is unchanged.
        setting('voiceChoices', 'Speak dialogue choices', 'bool', snapshot.settings.voiceChoices == true, false,
            'Say a dialogue choice to pick it: its words, a part of them, or its number ("two", "the last one"). If nothing fits clearly, nothing is picked. No character answers.\n\nPresses the arrow keys and Enter, so the game must be in front. Needs speech recognition on this PC. Headphones work best.'),
        setting('audioDelay', 'Lip sync delay (Bluetooth)', 'select', delayIndex, 1,
            'Bluetooth audio arrives a little late, so lips and subtitles can run ahead of the voice. This holds them back to match, for every voice.\n\nAuto: 150 ms while Windows plays through Bluetooth, none otherwise. Pick a value if your headset is faster or slower.\n\nThe game’s own dialogue has the same delay and does not correct it.',
            delayLabels, {elements = true}),
    }
    -- Custom voices (Remote OmniVoice and the server address) and OmniVoice for AMD are pages of their own, opened from here, last on the page.
    if remoteOmni.instance then
        rows[#rows + 1] = action('custom-voices', 'Custom voices', 'Open', 'Render Pocket and OmniVoice voices on another PC or graphics card: the on/off switch, the server address and a connection test. It works whichever of those voices is chosen above.',
            function()
                -- The page reads the bridge's answer again at once, not at the next poll.
                pcall(remoteOmni.instance.state, true)
                return navigate('custom-voices')
            end)
    end
    -- OmniVoice for AMD: shown only when the service says this PC offers it (or has it).
    if omniAmd.instance then
        local asked, visible = pcall(omniAmd.instance.visible)
        if asked and visible == true then
            rows[#rows + 1] = action('omni-amd', 'OmniVoice for AMD', 'Open', 'Set up OmniVoice on your AMD Radeon card with one download, and choose how it runs.',
                function()
                    -- The page reads the bridge's answer again at once, not at the next poll.
                    pcall(omniAmd.instance.state, true)
                    return navigate('omni-amd')
                end)
        end
    end
    for _, voiceRow in ipairs(rows) do
        if voiceRow.id == 'voiceProvider' and next(voiceDisabledShown) then
            voiceRow.disabledElements, voiceRow.disabledReason = voiceDisabledShown, ui.t('Requires the optional OmniVoice pack (GPU)')
        end
        -- First paragraph, so a long description that is cut keeps it.
        if voiceRow.id == 'voiceProvider' and pack.amdRoute then
            voiceRow.description = ui.t('Your AMD Radeon card can run OmniVoice. Set it up in Settings > Voice and microphone > OmniVoice for AMD: one download, then it starts by itself. Until then Pocket speaks.')
                .. '\n\n' .. voiceRow.description
        elseif voiceRow.id == 'voiceProvider' and pack.noNvidia then
            voiceRow.description = ui.t('This PC has no NVIDIA graphics card, which OmniVoice needs. OmniVoice will not start here. Choose Pocket to hear voices.')
                .. '\n\n' .. voiceRow.description
        elseif voiceRow.id == 'voiceProvider' and pack.smallCard then
            voiceRow.description = ui.t('The graphics card in this PC has less than the 12 GB OmniVoice needs next to the game. If it cannot start, Pocket is used. Choose Pocket to skip the wait.')
                .. '\n\n' .. voiceRow.description
        end
        if voiceRow.id == 'vVoiceEngine' then
            local greyed, reason = {}, nil
            if snapshot.settings.matureContent == true then
                -- Beside Mature content Voxtral is not used, whatever the key (this reason comes before the key's).
                greyed[2], reason = true, ui.t('Voxtral is not used with Mature content.')
            elseif not (snapshot.mistral or {}).saved then
                greyed[2], reason = true, ui.t('Requires a Mistral key (add it with the Mistral preset on the Custom endpoint page)')
            end
            -- OmniVoice carries its own reason (a string), so it never takes Voxtral's, the pack's comes first.
            if vOmniBlock then
                greyed[3] = vOmniBlock == 'pack' and ui.t('Requires the optional OmniVoice pack (GPU)') or ui.t('Requires the Companion voices to be an OmniVoice choice')
                reason = reason or greyed[3]
            end
            if next(greyed) then voiceRow.disabledElements, voiceRow.disabledReason = greyed, reason end
        end
    end
    return {category('voices', 'Voice and microphone', rows)}
end

-- Conversations: who can be talked to and what they know.
settingsPages['settings-conversations'] = function(snapshot)
    local rows = {
        setting('storyConversations', 'Talk to story characters', 'bool', snapshot.settings.storyConversations == true, false,
            'The game’s own named characters, such as Judy, Jackie, Panam and Rogue, answer when you talk to them where they stand, with their own voice and memory.\n\nNothing else about them changes: they do not turn, move, gesture or follow, and stay quiet during scenes, quest conversations, fights and rides.\n\nTakes effect after you reload your save.'),
        -- One list for both stored settings (johnnyInHead, johnnyRemarks): 1 Off, 2 On (he answers the talk keys), 3 Speaks up rarely, 4 Speaks up normally, 5 Speaks up often.
        setting('johnnyInHead', 'Johnny in your head', 'select',
            snapshot.settings.johnnyInHead ~= true and 1 or snapshot.settings.johnnyRemarks == 'normal' and 5
                or snapshot.settings.johnnyRemarks == 'medium' and 4 or snapshot.settings.johnnyRemarks == 'rare' and 3 or 2, 1,
            'Johnny Silverhand answers the Talk to Johnny keys, as the voice in V’s head, once the story has him there. Give Talk to Johnny a key on the Key bindings page: none is set by default.\n\nOn: he answers when you talk to him. Rarely: he also speaks up on his own, about 2 an hour. Normally: about 4. Often: about 6.\n\nWith companions speaking up too, the rates add up and they take turns.',
            {'Off', 'On', 'Speaks up rarely', 'Speaks up normally', 'Speaks up often'}),
        -- Party companions start a conversation on their own (stored companionSpeakUp): 1 Off, 2 Speaks up rarely, 3 Speaks up normally, 4 Speaks up often.
        setting('companionSpeakUp', 'Companions speak up', 'select',
            snapshot.settings.companionSpeakUp == 'normal' and 4 or snapshot.settings.companionSpeakUp == 'medium' and 3
                or snapshot.settings.companionSpeakUp == 'rare' and 2 or 1, 4,
            'Companions in your party sometimes start talking on their own, at a calm moment or after a scene. With two or more near you, it is often a short chat between up to three of them, and you can join in by talking. Never during fights, scenes, calls or menus.\n\nRarely: about 2 an hour. Normally: about 4. Often (the default): about 6.\n\nWith Johnny speaking up too, the rates add up and they take turns.',
            {'Off', 'Speaks up rarely', 'Speaks up normally', 'Speaks up often'}),
        -- Companion vision (docs/COMPANION_VISION.md): off by default, every conversation provider. The bridge does all the work out of process.
        setting('companionVision', 'Companion vision', 'bool', snapshot.settings.companionVision == true, false,
            'Each line also comes with vision: a recent view of your surroundings, taken from the game window just before you talk. Works with every conversation provider. Local AI needs a model with vision. A model without it just gets your words.\n\nOnly the game window, only while someone is near, kept briefly in memory. Off means nothing is captured.'),
        -- Which live game info the characters are told: a page of its own (one switch per kind).
        action('dynamic-info', 'Dynamic info', 'Open',
            'Choose which live game info the characters are told, such as location, time, weather, company, health, money, gear, quests, music and TV, and other mods’ state.\n\nAll on by default except other mods’ state, which is off. An off kind is not sent to any conversation provider.',
            function() return navigate('dynamic-info') end),
    }
    -- Who speaks as a partner: a page of its own (one row per character who can).
    if #relationshipRows(snapshot) > 0 then
        rows[#rows + 1] = action('relationships', 'Romantic relationships', 'Open',
            'Choose, character by character, who speaks to V as a partner.\n\nAuto follows the relationship in this save. It only changes how they talk, never your game choices.',
            function() return navigate('relationships') end)
    end
    rows[#rows + 1] = action('memory', 'Memory', 'Manage',
        'See what each character remembers and make one or all of them forget.\n\nMemories are kept across saves.',
        function() return navigate('memory') end)
    return {category('conversation-controls', 'Conversations', rows)}
end

-- Companions: life with the party. Eye contact height and Head tracking strength have no row any more (they use their defaults), and the one switch Companions react
-- writes both stored settings battleReactions and lootReactions.
settingsPages['settings-companions'] = function(snapshot)
    return {category('companions', 'Companions', {
        action('immersive-invitations', 'Immersive invitations', 'Open',
            'Companions travel to you when you invite them: they walk or drive in, text you, wait, and remember if you never come.\n\nOff by default.',
            function() return navigate('immersive-invitations') end),
        action('housemates', 'Housemates', 'Open',
            'Characters you tell they can stay at your place move into your apartments and live there.\n\nOff by default.',
            function() return navigate('housemates') end),
        -- Off by default (the owner's call, 2026-10-25): party copies change into other looks of their own (docs/COMPANION_OUTFITS.md), only out of sight. Off: nothing is loaded or run.
        setting('companionOutfits', 'Companions change outfits', 'bool', snapshot.settings.companionOutfits == true, false,
            'Your party’s companions change outfits now and then: another look by day and by night, and casual clothes at home, where the character has them.\n\nOnly out of your sight, never in front of you, and only for your party’s own copies, never the game’s own characters. Turning this off keeps what they wear now.'),
        -- Off by default (docs/EDDIES.md): borrow, lend and pay back eddies with your own characters, the eddies move when the character agrees. Off: nothing is read or sent.
        setting('characterEddies', 'Eddies with characters', 'bool', snapshot.settings.characterEddies == true, false,
            'Borrow eddies from your characters, lend them eddies and pay each other back, by talking. Each character has money of their own, as their story has it, and decides by how they feel about you. Now and then they ask you for a loan.\n\nEddies change hands as soon as a character agrees, and only with your own characters (party, invited visitors, housemates). The game’s own characters only talk about it. Off by default.'),
        -- Off by default (docs/RELATIONSHIPS_AND_QUESTS.md): a bond with every named character, level 1 to 10, from their quests with V and their talks; one notice per change.
        setting('characterBonds', 'Character bonds', 'bool', snapshot.settings.characterBonds == true, false,
            'Every named character has a bond with you, level 1 to 10. Quests finished together, a romance, eddies paid back and talking raise it; threats and insults lower it. Closer characters trust you more.\n\nA notice shows each level change. Forget clears the talk part. Off by default.'),
        -- Off by default (docs/RELATIONSHIPS_AND_QUESTS.md section 7): a close character can start a short story arc of their own once their own quests are done.
        setting('storyPacks', 'Story packs', 'bool', snapshot.settings.storyPacks == true, false,
            'When you are close and a character’s own quests are done, they can start a short story of their own. It plays out in talks, texts and calls, and some use Eddies with characters and Immersive invitations.\n\nNeeds Character bonds. Own characters and channels only, never the game’s own scenes or quests. Off by default.'),
        -- Off by default (docs/QUEST_PRIMITIVES.md section 10.7): close characters text or call first at calm moments, and Johnny speaks up in your head. Only with Story packs.
        setting('reachOuts', 'Characters text first', 'bool', snapshot.settings.reachOuts == true, false,
            'Characters you are close to can text or call you first now and then, and Johnny can speak up in your head. It only happens at calm moments, never in a fight, a scene or a call, and only a few times a day.\n\nNeeds Story packs. Own characters and channels only. Off by default.'),
        -- On by default (2026-10-30): one switch for the two kinds of comment, stored as battleReactions and lootReactions. On when either was on.
        setting('companionReactions', 'Companions react', 'bool', snapshot.settings.battleReactions == true or snapshot.settings.lootReactions == true, true,
            'A nearby companion comments as combat starts and ends, and after you collect loot from the world. Storage transfers stay silent.\n\nCooldowns: ten minutes after a fight and between ordinary loot comments, two minutes for new Legendary gear. Pickups during a fight become one comment at its end. Conversations and story scenes come first. Loading a save resets the cooldowns.'),
    })}
end

-- Night City: how the world reacts to V. Street reputation and NPCs react to threats and commands are on for new players (2026-10-30), a saved choice is kept.
settingsPages['settings-night-city'] = function(snapshot)
    return {category('night-city', 'Night City', {
        setting('reputation', 'Street reputation', 'bool', snapshot.settings.reputation == true, true,
            'Gangs, the NCPD, corporations and the locals of each district remember what V did: Street Cred, choices in jobs, fights, crimes the police saw and how you treat people. It shapes their greeting, trust and help.\n\nOnly ordinary people, never named or story characters. It changes their words, nothing in the game.'),
        setting('npcThreats', 'NPCs react to threats and commands', 'bool', snapshot.settings.npcThreats == true, true,
            'Ordinary people you threaten run, cower or fight back, as their kind would: gang members and guards use their fists for an insult and their weapons for a death threat.\n\nThey may also do what you tell them, if they would: get down, stop, or get out of the vehicle.\n\nOnly ordinary people, never named or story characters, and never during scenes, quests or fights.'),
        -- Off by default: a gang V keeps killing may send a small squad after V, now and then, with a threat of its own to shout (mod/revenge-ambush.lua).
        setting('revengeAmbushes', 'Revenge ambushes', 'bool', snapshot.settings.revengeAmbushes == true, false,
            'A gang you keep killing may rarely send a small squad after you, with a short threat to shout. A long wait follows each one.\n\nNever in a fight, scene, call, vehicle, indoors, safe zone or while wanted.'),
    })}
end

-- Interface: the language of the mod's menus, and Subtitles (moved here from Voices).
settingsPages['settings-interface'] = function(snapshot)
    local choices, languageElements, languageIndex = ui.choices(), {}, 1
    for index, choice in ipairs(choices) do
        languageElements[index] = choice.label
        if choice.value == snapshot.settings.uiLanguage then languageIndex = index end
    end
    return {category('interface', 'Interface', {
        setting('uiLanguage', 'Interface language', 'select', languageIndex, 1,
            'Changes this mod’s menus and notices only.\n\nCharacter voices and the language you talk in are separate. The microphone uses this language as a hint for non-English speech.',
            languageElements, {elements = true}),
        -- One list for both stored settings (subtitles, subtitleStyle): 1 Off (the old switch), 2 Cinematic subtitles (stored 'dialogue'), 3 Above the speaker (stored 'overhead').
        -- Off keeps the style that was saved, so turning it back on restores it.
        setting('subtitleStyle', 'Subtitles', 'select', snapshot.settings.subtitles == false and 1 or snapshot.settings.subtitleStyle == 'overhead' and 3 or 2, 2,
            'Off: no subtitles.\n\nCinematic subtitles: the game’s regular dialogue subtitles.\n\nAbove the speaker: over the companion who is talking.\n\nWith Companion voices Off as well, automatic reactions stay silent.',
            {'Off', 'Cinematic subtitles', 'Above the speaker'}),
    })}
end

-- Content packs: one section per installed add-on that has settings (docs/ADDON_API.md, the add-on wrote its own labels), then one On/Off row for each content pack
-- (add-on API 1.1, docs/ADDON_API.md): on by default, the bridge applies it from the next reply. Their names are the add-on's own and are shown as written.
settingsPages['settings-content-packs'] = function(snapshot)
    local categories = {}
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
    if convaiAddons and convaiAddons.contentPacks then
        local list = {}
        for _, pack in ipairs(convaiAddons.contentPacks()) do
            list[#list + 1] = setting('addon:' .. pack.id .. ':contentEnabled', pack.name, 'bool', pack.enabled, true,
                ui.t('Turns the content pack {name} on or off. A pack changes how the characters talk. Its prompt changes work with Google Gemini, Local AI and Custom. On Convai its world rules and its own Convai characters apply. A switch counts from the next reply, new names after a restart.', {name = pack.name}),
                nil, {label = true, description = true})
        end
        if #list > 0 then categories[#categories + 1] = category('addon-content', 'Content packs', list, 'Add-ons that change how the characters talk.') end
    end
    return categories
end

-- Privacy and help: Help and support, the automatic error reports (docs/ERROR_REPORTS.md, mod/error-reports.lua, on by default, the help says what is sent and what never
-- is) and Developer mode.
settingsPages['settings-privacy'] = function(snapshot)
    local rows = {}
    if support then
        rows[#rows + 1] = action('help', 'Help and support', 'Open',
            'Find the log files and create a report to send to the developer if something goes wrong.',
            function()
                -- The setup check runs again from the next slow update (never inside this menu callback).
                if convaiSetupCheck then pcall(convaiSetupCheck.refresh) end
                return navigate('help')
            end)
    end
    rows[#rows + 1] = setting('errorReports', 'Send error reports automatically', 'bool', snapshot.settings.errorReports ~= false, true,
        'When something in the mod goes wrong, a short report goes to the developer.\n\nIt never holds keys, what you or the characters say, memories, audio or your Windows user name.\n\nIt holds the error, versions, settings, PC details (graphics card, processor, Windows, security software, drive, screen), mod names, setup check, reply timings and nearby log lines (for setup and script errors also the Cyber Engine Tweaks log).')
    rows[#rows + 1] = setting('developerMode', 'Developer mode', 'bool', snapshot.settings.developerMode, false,
        'For testing and bug reports; leave it off for normal play.\n\nShows routine popups, writes a movement trace in the mod’s runtime folder, logs gesture decisions and adds itself to support reports.\n\nFailures, preparation progress and joined notices stay visible when it is off.')
    return {category('privacy', 'Privacy and help', rows)}
end

-- ---- Side characters to invite (docs/SIDE_CHARACTERS.md) ---------------------------------------------------------------------------
-- The minor characters of the roster (snapshot.side, built once by the manager): a search, the first letter of the name as a group (the Model
-- browser's Starts with), and twelve rows a page like the other long lists. The letter groups are worked out the first time the page is built for a
-- list and held; a page build then reads twelve rows, never all of them. No Favorites block: favorites are the main list's and the Model browser's.
-- A function of M, not a local, so schema() gains no upvalue.
local sideGroupsCache = {}
local function sideGroups(list)
    if sideGroupsCache.list ~= list or sideGroupsCache.count ~= #list then
        local lists, order = {}, {}
        for _, profile in ipairs(list) do
            local group = groupOf(profile.name)
            local bucket = lists[group]
            if not bucket then bucket = {}; lists[group] = bucket; order[#order + 1] = group end
            bucket[#bucket + 1] = profile
        end
        table.sort(order)
        sideGroupsCache = {list = list, count = #list, order = order, lists = lists}
    end
    return sideGroupsCache
end

function M.sideRows(snapshot, party, canInvite, rows, categories)
    local shared = sharedCharacterLines(snapshot)
    local all = snapshot.side or {}
    local cache = sideGroups(all)
    -- With a search text the whole list is searched, so the letter group is out of the way (All, and no row for it).
    local searching = #modelFind.words > 0
    local groups = not searching and #cache.order <= 40 and cache.order or {}
    local groupElements = {ui.t('All')}
    for _, group in ipairs(groups) do groupElements[#groupElements + 1] = group end
    listGroup = math.max(1, math.min(listGroup, #groupElements))
    local profiles = searching and searchedModels(all, profileMatches)
        or listGroup == 1 and all or cache.lists[groupElements[listGroup]] or {}
    local first, last, pages = pageRange(#profiles)
    if not canInvite then rows[#rows + 1] = readonly('needs-save', 'Characters and party', 'Load a save first',
            'Inviting characters and managing your party need a loaded game.') end
    rows[#rows + 1] = readonly('character-status', ui.t('{count} matching characters', {count = #profiles}), '',
        ui.t('{count} matching characters', {count = #profiles}), {label = true, description = true})
    if #groups > 0 then
        rows[#rows + 1] = setting('ui:group', 'Starts with', 'select', listGroup, 1,
            'Show only the characters whose name starts with this letter.', groupElements, {elements = true})
    end
    for _, row in ipairs(pageRows(first, last, pages, function(index) return profiles[index].name end, 'characters', #profiles)) do rows[#rows + 1] = row end
    for index = first, last do
        local profile = profiles[index]
        local key = profile.key
        local count = countKey(party, key)
        local available = manager.definition(key) ~= nil
        rows[#rows + 1] = action('invite:' .. key, profile.name,
            available and (count > 0 and ui.t('Add copy ({count})', {count = count}) or 'Invite') or 'Profile only',
            profileDescription(profile, snapshot, shared, count), function() return inviteKey(key) end, canInvite and available)
    end
    categories[#categories + 1] = category('side', 'Side characters to invite', rows,
        'Everyday people of Night City, from shopkeepers to fixers. Each joins as your own copy with their own personality.')
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
    -- The first section of every page: the way back (or, on the home page, the destinations) and the line of the last action.
    local nav = {}
    -- Each category page goes back to Settings. A page that opens from a row of a category page goes back to that page, not to Settings.
    local BACK = {characters = 'home', side = 'home', party = 'home', models = 'home', bonds = 'home', settings = 'home', ['key-bindings'] = 'home',
        ['settings-provider'] = 'settings', ['settings-voice'] = 'settings', ['settings-conversations'] = 'settings', ['settings-companions'] = 'settings',
        ['settings-night-city'] = 'settings', ['settings-interface'] = 'settings', ['settings-content-packs'] = 'settings', ['settings-privacy'] = 'settings',
        memory = 'settings-conversations', relationships = 'settings-conversations', ['dynamic-info'] = 'settings-conversations',
        ['immersive-invitations'] = 'settings-companions', housemates = 'settings-companions',
        ['custom-voices'] = 'settings-voice', ['omni-amd'] = 'settings-voice',
        ['paid-tier'] = 'settings-provider', ['custom-endpoint'] = 'settings-provider', help = 'settings-privacy'}
    if view == 'home' then
        -- The character editor has no page in the game: Open is the same request as Settings > Edit characters (one small command file, the
        -- page opens in the browser), so this row is an action that answers with the request's result, not a navigation. Shown only when
        -- the editor module loaded, and above Settings (the owner's order). Built with the page, never per frame.
        for _, tab in ipairs({{'characters', 'Main characters to invite'}, {'side', 'Side characters to invite'}, {'party', 'Parties'},
            {'models', 'Model browser'}, {'bonds', 'Relationships'}, {'editor'}, {'key-bindings', 'Key bindings'}, {'settings', 'Settings'}}) do
            if tab[1] == 'editor' then
                if editor then
                    nav[#nav + 1] = action('character-editor:home', 'Character editor', 'Open',
                        'Edit characters’ bios, rules and memories, and the prompting for each AI option, in your browser.\n\nWorks with Google Gemini, Local AI and Custom, not Convai. Changes apply from the next reply.',
                        function() return editor.request() end)
                end
            else
                -- The Model browser lists every character model in the game, so it says that and what joining means.
                local description = tab[1] == 'models'
                    and ui.t('Browse every character model in the game and invite any of them, including characters without conversation support. They join as followers and do not talk.')
                    or tab[1] == 'bonds'
                    and ui.t('See the characters you have talked to and how close each one is to you: the bond level, what raised or hurt it, their quests and the stories they are in.')
                    or tab[1] == 'key-bindings'
                    and ui.t('Choose the keys and controller buttons for talking by voice or text, the group chats and the Companion Manager. They work at once.')
                    or ui.t('Browse {section}. {query}', {section = ui.t(tab[2]):lower(), query = ''})
                nav[#nav + 1] = action('tab:' .. tab[1], tab[2], 'Open', description, function() return navigate(tab[1]) end)
            end
        end
    elseif BACK[view] then
        local parent = BACK[view]
        local id = view == 'memory' and 'memory:settings' or (view .. ':back')
        local page = settingsPages.byView[parent]
        nav[#nav + 1] = parent == 'home'
            and action(id, 'Back to Companion Manager', 'Back', 'Return to Companion Manager.', function() return navigate('home') end)
            -- A category page goes back to the Settings list. A page opened from one goes back to that category page, and the description says which.
            or action(id, 'Back to settings', 'Back', page and ui.t('Return to {page}.', {page = ui.t(page.name)}) or 'Return to the settings categories.',
                function() return navigate(parent) end, nil, page and {description = true} or nil)
    end
    if view == 'home' then
        -- Nothing more: the destinations are the page.
    elseif view == 'characters' then
        local shared = sharedCharacterLines(snapshot)
        local profiles = snapshot.invitable or snapshot.profiles
        -- The Search of a host that has a box.
        local searching = #modelFind.words > 0
        if searching then profiles = searchedModels(profiles, profileMatches) end
        local first, last, pages = pageRange(#profiles)
        -- Without a loaded save the page can be read but nobody can be invited: say so, in a row, not only in greyed buttons.
        if not canInvite then rows[#rows + 1] = readonly('needs-save', 'Characters and party', 'Load a save first',
                'Inviting characters and managing your party need a loaded game.') end
        if searching then
            rows[#rows + 1] = readonly('character-status', ui.t('{count} matching characters', {count = #profiles}), '', ui.t('{count} matching characters', {count = #profiles}),
                {label = true, description = true})
        end
        for _, row in ipairs(pageRows(first, last, pages, function(index) return profiles[index].name end, 'characters', #profiles)) do rows[#rows + 1] = row end
        local function inviteOf(profile, id)
            local key = profile.key
            local count = countKey(party, key)
            local available = manager.definition(key) ~= nil
            return action(id, profile.name, available and (count > 0 and ui.t('Add copy ({count})',{count=count}) or 'Invite') or 'Profile only',
                profileDescription(profile, snapshot, shared, count), function() return inviteKey(key) end, canInvite and available)
        end
        -- The Favorites block above the list, on page 1.
        local favorites = favoriteRows('characters', profiles, function(profile) return profile.name end, inviteOf)
        if #favorites > 0 then categories[#categories + 1] = category('favorites', 'Favorites', favorites) end
        for index = first, last do
            local profile = profiles[index]
            entryRows(rows, 'characters', profile, profile.name, countKey(party, profile.key), inviteOf)
        end
        categories[#categories + 1] = category('characters', 'Main characters to invite', rows)
    elseif view == 'side' then
        M.sideRows(snapshot, party, canInvite, rows, categories)
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
        -- Meetings still on their way (Settings > Immersive invitations) that have no body yet: one row each, Cancel.
        local meetings = {}
        local service = convaiImmersiveGet and convaiImmersiveGet() or nil
        if service then
            for _, row in ipairs(service.rows()) do if not row.serial then meetings[#meetings + 1] = row end end
        end
        for _, row in ipairs(meetings) do
            local meetingId = row.id
            local state = row.phase == 'waiting' and ui.t('waiting at {place}', {place = tostring(row.place or '')}) or ui.t('on her way')
            rows[#rows + 1] = action('meeting:' .. meetingId, ui.t('{name} · {state}', {name = row.name, state = state}), 'Cancel',
                ui.t('Cancel this meeting. She is not told.'),
                function()
                    local live = convaiImmersiveGet and convaiImmersiveGet() or nil
                    return live ~= nil and live.cancelById(meetingId)
                end, nil, {description = true})
        end
        local first, last, pages = pageRange(shown)
        if pages > 1 then
            for _, row in ipairs(pageRows(first, last, pages, function(index)
                local member = copies[index]
                return member.serial and ((member.baseName or member.name) .. ' #' .. member.serial) or member.name
            end, nil, shown)) do rows[#rows + 1] = row end
        end
        for index = first, last do
            local member = copies[index]
            do
                local id = member.id
                local display = member.serial and ((member.baseName or member.name) .. ' #' .. member.serial)
                    or ui.t('{name} · invited copy', {name = member.name})
                local problem = member.dismissError or (member.state == 'failed' and member.error) or nil
                -- One action per state: joined (it has a serial) Dismiss, still preparing Cancel invitation, failed Remove.
                rows[#rows + 1] = action('dismiss:' .. id, display,
                    member.serial and 'Dismiss' or member.state == 'failed' and 'Remove' or 'Cancel invitation',
                    ui.t('Remove only this copy from your group.') .. (problem and ('\n' .. ui.t(problem)) or ''),
                    function() return queue.dismiss(id) end, nil, {description = true})
                if problem then
                    local text = (member.baseName or member.name) .. ': ' .. ui.t(problem)
                    rows[#rows + 1] = readonly('error:' .. id, text, '', text, {label = true, description = true})
                end
            end
        end
        -- Housemates (mod/housemates.lua, docs/HOUSEMATES.md): the characters who live at V's place, and a Move out for each.
        local housemates = convaiHousemateRows and convaiHousemateRows() or {}
        for index, housemate in ipairs(housemates) do
            if index > 30 then
                rows[#rows + 1] = readonly('housemates-more', ui.t('{count} more housemates', {count = #housemates - 30}), '', ui.t('{count} more housemates', {count = #housemates - 30}))
                break
            end
            local where = housemate.state == 'party' and ui.t('with you') or housemate.state == 'home' and ui.t('at home') or ui.t('out')
            local key = housemate.key
            rows[#rows + 1] = action('housemate:' .. key, ui.t('{name} · lives in {apartment} · {state}',
                    {name = housemate.name, apartment = ui.t(housemate.apartmentName), state = where}), 'Move out',
                ui.t('{name} stops living at your place. She stays as she is otherwise.', {name = housemate.name}),
                function() return convaiHousemateMoveOut ~= nil and convaiHousemateMoveOut(key) end, canInvite, {label = true, description = true})
        end
        if not canInvite then rows[#rows + 1] = readonly('needs-save', 'Characters and party', 'Load a save first',
                'Inviting characters and managing your party need a loaded game.')
        elseif shown == 0 and #meetings == 0 and #housemates == 0 then rows[#rows + 1] = readonly('empty-party', 'Your party is empty', '', 'Invite someone from Characters or Model browser.') end
        categories[#categories + 1] = category('party', 'Current party', rows)
        -- Save current party is the last row of that section (rows is the table the section holds); the saved parties follow as sections.
        M.partyRows(rows, categories, queue.list(), canInvite)
    elseif view == 'models' then
        local scan, models = snapshot.scan, snapshot.models
        local favorites = {}
        if not canInvite then rows[#rows + 1] = readonly('needs-save', 'Characters and party', 'Load a save first',
                'Inviting characters and managing your party need a loaded game.') end
        -- The list is sorted when the scan has finished; until then only the progress shows, and the page is built once.
        if not scan.finished then
            rows[#rows + 1] = readonly('model-status', 'Reading installed models…', '',
                ui.t(scan.error or '') ~= '' and ui.t(scan.error) or 'Reading installed models…')
        else
            -- A letter group, when there are few enough letters to cycle through: 1 is every model.
            local cache = modelGroups(models)
            -- With a search text the whole list is searched, so the letter group is out of the way (All, and no row for it).
            local searching = #modelFind.words > 0
            local groups = not searching and #cache.order <= 40 and cache.order or {}
            local groupElements = {ui.t('All')}
            for _, group in ipairs(groups) do groupElements[#groupElements + 1] = group end
            listGroup = math.max(1, math.min(listGroup, #groupElements))
            local matches = searching and searchedModels(cache.all)
                or listGroup == 1 and cache.all or cache.lists[groupElements[listGroup]] or {}
            local talking = 0
            for _, model in ipairs(matches) do if model.profileName then talking = talking + 1 end end
            rows[#rows + 1] = readonly('model-status', ui.t('{count} matching models', {count = #matches}), '',
                ui.t('{count} of them can talk.', {count = talking}) .. '\n' .. (ui.t(scan.error) or '')
                    .. (modelFind.offered and ('\n' .. ui.t('Type in the search box to find a model by name or record, for example “rita wheeler”. A part of a word is enough.')) or ''),
                {label = true, description = true})
            if #groups > 0 then
                rows[#rows + 1] = setting('ui:group', 'Starts with', 'select', listGroup, 1,
                    'Show only the models whose name starts with this letter.', groupElements, {elements = true})
            end
            local first, last, pages = pageRange(#matches)
            for _, row in ipairs(pageRows(first, last, pages, function(index) return matches[index].name end, 'models', #matches)) do rows[#rows + 1] = row end
            local function nameOf(model)
                return model.unnamedIndex and ui.t('Unnamed model {index}',{index=model.unnamedIndex}) or model.name
            end
            local function inviteOf(model, id)
                local key = model.key
                local count = countKey(party, key)
                local conversation = model.archetype and ui.t('Conversation: {name} (archetype)', {name = model.profileName})
                    or model.profileName and ui.t('Conversation: {state}',{state=model.profileName})
                    or ui.t('No conversation profile. This model joins as a follower without AI conversations.')
                return action(id, nameOf(model), count > 0 and ui.t('Add copy ({count})',{count=count}) or 'Invite',
                    model.record .. '\n\n' .. conversation
                        .. '\n' .. ui.t('Some game models have special rigs or roles and may not behave as ordinary companions.'),
                    function() return inviteKey(key) end, canInvite)
            end
            favorites = favoriteRows('models', matches, nameOf, inviteOf)
            for index = first, last do
                local model = matches[index]
                entryRows(rows, 'models', model, nameOf(model), countKey(party, model.key), inviteOf)
            end
        end
        if #favorites > 0 then categories[#categories + 1] = category('favorites', 'Favorites', favorites) end
        categories[#categories + 1] = category('models', 'Installed character models', rows)
    elseif view == 'bonds' then
        -- Only the characters V has talked to (the bridge lists no one else), most recent first, as it wrote them. Built once, when the page opens or turns.
        local on = snapshot.settings.characterBonds == true
        local list = on and type(convaiBondsList) == 'function' and select(2, pcall(convaiBondsList)) or nil
        if type(list) ~= 'table' then list = {} end
        -- Whatever the module handed over: only the entries that are tables are rows.
        local listed = {}
        for _, item in ipairs(list) do if type(item) == 'table' then listed[#listed + 1] = item end end
        list = listed
        if not on then
            rows[#rows + 1] = readonly('bonds-off', 'Character bonds are off', '',
                'Bonds are not kept while Character bonds is off, so nobody is listed here. Turn it on in Settings, under Companions.')
        elseif #list == 0 then
            rows[#rows + 1] = readonly('bonds-empty', 'Nobody yet', '', 'Talk to a character and your bond with them shows here.')
        else
            local storyOn = snapshot.settings.storyPacks == true
            local first, last, pages = pageRange(#list)
            for _, row in ipairs(pageRows(first, last, pages, function(index) return list[index].name end, 'characters', #list)) do rows[#rows + 1] = row end
            for index = first, last do bondRows(rows, index, list[index], storyOn) end
        end
        categories[#categories + 1] = category('bonds', 'Relationships', rows,
            'The characters you have talked to and how close each one is to you. The most recent come first.')
    elseif view == 'memory' then
        -- The memory controls, then the list the character is chosen from, on the same page.
        categories[#categories + 1] = category('memory', 'Memory', memorySettings(snapshot))
        local profiles = snapshot.profiles
        local first, last, pages = pageRange(#profiles)
        for _, row in ipairs(pageRows(first, last, pages, function(index) return profiles[index].name end, 'characters', #profiles)) do rows[#rows + 1] = row end
        for index = first, last do
            local profile = profiles[index]
            local key = profile.key
            -- Forget resets the talk part of the bond, so the row says where the bond stands (nothing while the setting is off).
            local bond = bondLines(snapshot.settings, key)
            rows[#rows + 1] = action('memory:select:' .. key, profile.name,
                snapshot.memory.selectedKey == key and 'Unselect' or 'Choose',
                ui.t('Select {name} for memory controls. This does not invite them or change their conversation settings.',{name=profile.name})
                    .. (bond and ('\n\n' .. table.concat(bond, '\n')) or ''),
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
        -- While a report is being made the button reads Creating... and a further click is ignored (M.invoke), so one click makes one report.
        local generateRow = action('help:generate', 'Generate report', 'Create',
            'Saves a report file you can send to the developer.\n\nAPI keys, tokens, IDs, microphone audio and conversation text are left out. Without the conversation service, a shorter report is made from the files the game can read.',
            function() return support.request() end, report.phase ~= 'working')
        if report.phase == 'working' then generateRow.value = ui.t('Creating…') end
        categories[#categories + 1] = category('help-report', 'Report for the developer', {
            generateRow,
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
    elseif view == 'custom-endpoint' and customProvider.instance then
        categories[#categories + 1] = category('custom-endpoint', 'Custom endpoint', customEndpointRows(), 'The address, API key and model ID of your OpenAI-compatible provider, and a connection test. Used when Custom is the Conversation provider.')
    elseif view == 'custom-voices' and remoteOmni.instance then
        categories[#categories + 1] = category('custom-voices', 'Custom voices', customVoicesRows(snapshot),
            'Render the OmniVoice voices on another PC or graphics card that runs the OmniVoice server.')
    elseif view == 'omni-amd' and omniAmd.instance then
        categories[#categories + 1] = category('omni-amd', 'OmniVoice for AMD', omniAmdRows(snapshot),
            'Run OmniVoice on your AMD Radeon card with AMD’s ROCm: one download, set up from here.')
    elseif view == 'relationships' then
        local rows = relationshipRows(snapshot)
        if #rows > 0 then categories[#categories + 1] = category('relationships', 'Romantic relationships', rows) end
    elseif view == 'immersive-invitations' then
        categories[#categories + 1] = category('immersive-invitations', 'Immersive invitations', immersiveRows(snapshot),
            'Invite a companion and she really travels to you: she appears out of sight, walks or drives in, texts you when she is there and waits for you.')
    elseif view == 'housemates' then
        categories[#categories + 1] = category('housemates', 'Housemates', housemateSettingRows(snapshot),
            'Characters you tell they can stay at your place move into your apartments and live there.')
    elseif view == 'dynamic-info' then
        categories[#categories + 1] = category('dynamic-info', 'Dynamic info', dynamicInfoRows(snapshot),
            'What the game tells each character about this moment. A character mentions it only when it fits the talk.\n\nAn off kind is left out of every conversation provider (Convai, Google Gemini, Local AI and Custom).')
    elseif view == 'key-bindings' then
        for _, section in ipairs(keyBindingSections(snapshot)) do categories[#categories + 1] = section end
    elseif view == 'settings' then
        categories[#categories + 1] = category('settings-categories', 'Settings', settingsPages.listRows())
    elseif settingsPages.byView[view] then
        for _, section in ipairs(settingsPages[view](snapshot)) do categories[#categories + 1] = section end
    end
    -- The line of the last action (or of an invitation being prepared) sits under the way back.
    local feedback = M.feedback()
    if feedback then
        nav[#nav + 1] = readonly('feedback', feedback, '', feedback, {label = true, description = true})
    end
    table.insert(categories, 1, category('navigation', LABEL, nav))
    return {name = ui.t(LABEL), categories = categories,
        description = view == 'key-bindings'
            and (ui.t('Choose the keys and controller buttons for the mod’s actions. Press Set, then the key or button you want. Esc or B cancels. A change works at once, and the keys you set in Cyber Engine Tweaks keep working. Pick keys the game does not already use.')
                .. '\n\n' .. ui.t('Set from the start: F7 talk by voice, F6 talk by text, F10 group voice chat, F8 group text chat and F4 the Companion Manager. Clear one and it stays clear. Restore defaults brings them back.')
                .. '\n\n' .. ui.t('Hold Shift, Ctrl or Alt while you press a key to set a combination such as Shift+F5. A combination runs only with exactly those keys held, and a plain key does not run while one is held. In the game Shift sprints, Ctrl dodges and Alt opens the weapon wheel, so V does that too.'))
            or ui.t('Your companions, character models and conversation settings.')}
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
            watch = function()
                if convaiCustomCharacters then convaiCustomCharacters.watch() end
                if convaiCharacterOptions then convaiCharacterOptions.watch() end
            end})
        if created and type(instance) == 'table' then editor = instance end
    end
    if paidTierLoaded and type(paidTierFactory) == 'table' and type(paidTierFactory.new) == 'function' then
        local created, instance = pcall(paidTierFactory.new, {ui = ui})
        if created and type(instance) == 'table' then paidTier = instance end
    end
    local remoteFactory = remoteOmni.factory
    if type(remoteFactory) == 'table' and type(remoteFactory.new) == 'function' then
        local created, instance = pcall(remoteFactory.new, {ui = ui, writeCommand = manager.writeCommand, session = manager.commandSession})
        remoteOmni.instance = created and type(instance) == 'table' and instance or nil
    end
    local amdFactory = omniAmd.factory
    if type(amdFactory) == 'table' and type(amdFactory.new) == 'function' then
        local created, instance = pcall(amdFactory.new, {ui = ui, writeCommand = manager.writeCommand, session = manager.commandSession})
        omniAmd.instance = created and type(instance) == 'table' and instance or nil
    end
    local customFactory = customProvider.factory
    if type(customFactory) == 'table' and type(customFactory.new) == 'function' then
        local created, instance = pcall(customFactory.new, {ui = ui, writeCommand = manager.writeCommand, session = manager.commandSession})
        customProvider.instance = created and type(instance) == 'table' and instance or nil
        local madeGemini, gemini = pcall(customFactory.new, {ui = ui, writeCommand = manager.writeCommand, session = manager.commandSession, kind = 'gemini'})
        geminiProvider.instance = madeGemini and type(gemini) == 'table' and gemini or nil
    end
end

M.LABEL, M.PAGE_SIZE = LABEL, PAGE_SIZE

-- ---- What the host (mod/nsui.lua) calls -------------------------------------------------------------------------------------------

local PAGES = {home = true, characters = true, side = true, party = true, models = true, bonds = true, settings = true, memory = true, help = true, ['paid-tier'] = true,
    relationships = true, ['dynamic-info'] = true, ['custom-endpoint'] = true, ['custom-voices'] = true, ['omni-amd'] = true, ['key-bindings'] = true, ['immersive-invitations'] = true, housemates = true}
for name in pairs(settingsPages.byView) do PAGES[name] = true end

function M.view() return view end

-- Does Restore defaults cover the page on screen (Settings and its category pages, Relationships, Dynamic info, Key bindings, Immersive invitations, Housemates)?
local DEFAULTS_PAGES = {relationships = true, ['dynamic-info'] = true, ['key-bindings'] = true, ['immersive-invitations'] = true, housemates = true}
function M.hasDefaults(name)
    name = name or view
    return settingsPages.isSettingsView(name) or DEFAULTS_PAGES[name] == true
end

-- The page on screen as one short text (the view, the page of its long list, the letter group and the search text): a host that scrolls to
-- the top on a new page compares it.
function M.pageId()
    return view .. '|' .. tostring(listPage) .. '|' .. tostring(listGroup) .. (modelFind.text ~= '' and ('|' .. modelFind.text) or '')
end

-- The Model browser's search. A host that has a search box hands over its text here (a change is drawn on the next page build, never per
-- keystroke) and says it has one with offerSearch, which only adds the hint to the page. The text is the words of what was typed, so it is
-- also the page's identity (M.pageId). Returns whether the search changed.
function M.offerSearch(offered)
    modelFind.offered = offered == true
end
function M.setSearch(text)
    -- Parties does not search: the box holds the name the Rename button takes (case kept), and nothing is drawn again for it.
    if view == 'party' then
        modelFind.typed = tostring(text or ''):sub(1, 100)
        return false
    end
    local clean, words = searchWords(text)
    if (view ~= 'models' and view ~= 'characters' and view ~= 'side') or clean == modelFind.text then return false end
    modelFind.text, modelFind.words = clean, words
    listPage = 1
    refreshQueued = true
    return true
end
function M.search() return modelFind.text end

-- The page to show. The manager opens on Home (the host calls this when the screen opens). Returns whether anything changed.
function M.setView(name)
    if not PAGES[name] or (name == 'help' and not support) or (name == 'paid-tier' and not paidTier)
        or (name == 'custom-endpoint' and not customProvider.instance) or (name == 'custom-voices' and not remoteOmni.instance) or (name == 'omni-amd' and not omniAmd.instance) then name = 'home' end
    -- A Content packs page that has nothing to show is not there: Settings is shown instead.
    if name == 'settings-content-packs' and not settingsPages.packsShown() then name = 'settings' end
    if view == 'key-bindings' and name ~= view and convaiKeyBinds then pcall(convaiKeyBinds.abandonCapture) end
    local changed = name ~= view or listPage ~= 1 or listGroup ~= 1 or modelFind.text ~= ''
    view, listPage, listGroup = name, 1, 1
    modelFind.text, modelFind.words = '', {}
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
    -- Generate report while a report is being made: ignored without a word (the button already reads Creating... and the line under Back says so).
    if disabledActions[id] and id == 'help:generate' then return {ok = true} end
    if disabledActions[id] then
        actionFeedback = ui.t('Not available right now.')
        refreshQueued = true
        return {ok = false, error = actionFeedback}
    end
    if convaiSavedParties and not id:match('^party:delete:') then convaiSavedParties.disarm() end
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
    local changes, atDefault, turningMatureOff, listed = {}, {}, false, {}
    -- Settings, and the Relationships and Dynamic info pages that open from it, and Key bindings.
    local pageNames = {}
    for _, page in ipairs(settingsPages.list) do pageNames[#pageNames + 1] = page.view end
    for _, name in ipairs({'relationships', 'dynamic-info', 'key-bindings', 'immersive-invitations', 'housemates'}) do pageNames[#pageNames + 1] = name end
    for _, name in ipairs(pageNames) do
        view = name
        local ok, model = pcall(schema)
        if not ok then lastError = tostring(model); break end
        for _, section in ipairs(model.categories) do
            for _, row in ipairs(section.settings) do
                local kind = row.type
                if (kind == 'bool' or kind == 'select' or kind == 'int') and row.defaultValue ~= nil and not row.id:match('^ui:') and not listed[row.id] then
                    listed[row.id] = true
                    local target = row.defaultValue
                    if row.id == 'localModel' then target = modelIndexOf('auto') or row.value end
                    -- A saved Move-in flat that V no longer owns shows as Ask me but is still saved: it is put back too.
                    local shown = row.value
                    if row.id == 'housemates:moveIn' and manager.housemates().moveIn ~= 'ask' then shown = 0 end
                    if shown ~= target then
                        changes[#changes + 1] = {id = row.id, value = target}
                        if row.id == 'matureContent' then turningMatureOff = true end
                    else atDefault[row.id] = target end
                end
            end
        end
    end
    -- Turning Mature content off puts back what turning it on changed (stageMature). Here the defaults are wanted instead: the rows it would put
    -- back are named in the batch at their default, so they stay there.
    if turningMatureOff then
        for _, id in ipairs({'conversationProvider', 'localModel', 'voiceProvider', 'vVoiceEngine'}) do
            if atDefault[id] ~= nil then changes[#changes + 1] = {id = id, value = atDefault[id]} end
        end
    end
    -- The own key bindings go back to the default keys (F4, F6, F7, F8, F10; none for the Johnny actions): one change for all seven.
    local savedKeys = manager.keyBindings()
    for action, name in pairs(manager.defaultKeyBindings()) do
        if (name or nil) ~= savedKeys[action] then changes[#changes + 1] = {value = true, id = 'keyBindings:reset'}; break end
    end
    -- Drawing the other pages replaced the page's actions and signature: the page on screen is built again.
    view = previous
    pcall(schema)
    return changes
end

-- Two rows of Settings > Voices each hold a switch that used to be a row of its own: Companion voices (1 Off = the stored `voice` false, then the voices one place
-- after their position in the voice list) and Subtitles (1 Off = the stored `subtitles` false, 2 Cinematic, 3 Above the speaker). The rest of this file, and the
-- Mature content staging, keep working in the stored settings' own terms, so a batch is turned into them here: Off becomes the switch's change, and choosing a
-- voice or a style also turns the switch back on (unless the batch sets the switch itself). The saved voice and style are never touched by Off, so they come back.
local function splitMergedRows(changes)
    local present = {}
    for _, change in ipairs(changes) do present[change.id] = true end
    local split = {}
    for _, change in ipairs(changes) do
        local id, value = change.id, change.value
        if id == 'voiceProvider' or id == 'subtitleStyle' then
            local switch = id == 'voiceProvider' and 'voice' or 'subtitles'
            if value == 1 then
                if not present[switch] then split[#split + 1] = {id = switch, value = false} end
            else
                split[#split + 1] = {id = id, value = type(value) == 'number' and value - 1 or value}
                if not present[switch] then split[#split + 1] = {id = switch, value = true} end
            end
        else
            split[#split + 1] = change
        end
    end
    return split
end

-- Applies a batch of changes as ONE validated, saved transaction (manager.applySettings), with what Mature content needs added or put
-- back. `changes` is a list of {id, value}: a switch's boolean, a list's position, a slider's number. Returns
-- {ok, error, notice, reload, names, ids}: `notice` is the sentence for a voice that was switched; `names` what was changed besides
-- the player's own choices; `error` the reason when nothing was saved (a refusal leaves every setting as it was).
function M.apply(changes)
    changes = splitMergedRows(changes)
    local currentPlayer = player()
    local snapshot = manager.snapshot(currentPlayer)
    local batch, record, names, refusal, matureNote = stageMature(changes, snapshot)
    local values, applied = {relationshipModes = {}, dynamicInfo = {}, immersive = {}, housemates = {}}, {}
    -- Add-on settings (docs/ADDON_API.md) are held until the main settings save succeeds.
    local addonChanges = 0
    if addonSettingsInUse() then convaiAddons.discardSettings() end
    local function refused(text)
        if addonChanges > 0 then convaiAddons.discardSettings() end
        actionFeedback = ui.t(text)
        refreshQueued = true
        return {ok = false, error = actionFeedback}
    end
    -- Remote OmniVoice, as this batch leaves it: with it on, an OmniVoice entry needs no pack on this PC (the voice is rendered on a server).
    local remoteAfter = snapshot.settings.remoteOmni == true
    for _, change in ipairs(batch) do if change.id == 'remoteOmni' and type(change.value) == 'boolean' then remoteAfter = change.value end end
    for _, change in ipairs(batch) do
        local key = change.id
        if key == 'voice' or key == 'subtitles' or key == 'developerMode'
            or key == 'battleReactions' or key == 'lootReactions' or key == 'naturalSpeech'
            or key == 'matureContent' or key == 'errorReports' or key == 'companionVision' or key == 'localOffload' then values[key] = change.value
        elseif key == 'voiceVolume' then
            if type(change.value) ~= 'number' then return refused('Choose a voice volume from 50 to 300 percent.') end
            values.voiceVolume = change.value
        elseif key == 'vVoiceVolume' then
            if type(change.value) ~= 'number' then return refused('Choose V’s voice volume from 50 to 300 percent.') end
            values.vVoiceVolume = change.value
        elseif key == 'audioDelay' then
            local delays = manager.audioDelayChoices()
            if type(change.value) ~= 'number' or change.value ~= math.floor(change.value) or not delays[change.value] then
                return refused('Choose one of the listed lip sync delays.')
            end
            values.audioDelay = delays[change.value]
        elseif key == 'micDevice' then
            -- Order: 1 Windows default (stored as no choice), then the listed inputs (stored by their name).
            local _, stored = microphoneChoices(snapshot.settings)
            if type(change.value) ~= 'number' or change.value ~= math.floor(change.value) or stored[change.value] == nil then
                return refused('Choose one of the listed microphones.')
            end
            values.micDevice = stored[change.value]
        elseif key == 'conversationProvider' then
            -- Order: 1 Convai free tier (stored 'convai', own key off), 2 Convai API key (stored 'convai', own key on), 3 Google Gemini
            -- (stored 'gemini'; 'mistral' while that is the saved choice), 4 Local (stored 'local'), 5 Custom (stored 'custom'). The own-key choice only changes with a Convai
            -- entry, so it comes back when the player returns to Convai from Mistral, Local or Custom.
            local providers = {'convai', 'convai', restoreMistral and 'mistral' or PROVIDER_IDS[3], 'local', 'custom'}
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
        elseif key == 'replyLanguage' then
            local choices = manager.replyLanguageChoices()
            if type(change.value) ~= 'number' or change.value ~= math.floor(change.value) or not choices[change.value] then
                return refused('Choose one of the listed reply languages.')
            end
            values.replyLanguage = choices[change.value]
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
        elseif key == 'vVoice' then
            -- Order: 1 Off, 2 Typed lines, 3 Typed and spoken lines. One row writes both stored settings the bridge reads (vVoice typed lines, vVoiceMic spoken lines).
            if change.value ~= 1 and change.value ~= 2 and change.value ~= 3 then return refused('Choose how V’s voice is used.') end
            values.vVoice, values.vVoiceMic = change.value ~= 1, change.value == 3
        elseif key == 'vVoiceEngine' then
            -- Order: 1 Pocket (stored 'pocket'), 2 Voxtral (stored 'voxtral', needs the Mistral key), 3 OmniVoice (stored 'omni', judged after the loop against the companion voice
            -- the batch leaves). One engine speaks every line of V's, typed or spoken.
            local engine = ({'pocket', 'voxtral', 'omni'})[change.value]
            if not engine or change.value ~= math.floor(change.value) then return refused('Choose one of the listed voices for V.') end
            if engine == 'voxtral' and not manager.mistral().saved then
                return refused('Requires a Mistral key (add it with the Mistral preset on the Custom endpoint page)')
            end
            values.vVoiceEngine = engine
        elseif key == 'voiceProvider' then
            local choice = type(change.value) == 'number' and VOICE_CHOICES[change.value] or nil
            if not choice then return refused('Choose one of the listed companion voices.') end
            -- Without the optional pack an OmniVoice entry cannot be applied: nothing changes and the
            -- player is told what it needs.
            if choice.provider == 'omni' and not manager.omniPack().installed and not remoteAfter then
                return refused('Requires the optional OmniVoice pack (GPU)')
            end
            -- Likewise the Mistral cloud voice needs a Mistral key (it works with any conversation provider).
            if choice.provider == 'voxtral' and not manager.mistral().saved then
                return refused('Requires a Mistral key (add it with the Mistral preset on the Custom endpoint page)')
            end
            -- And the Inworld cloud voice needs the player's own Inworld key.
            if choice.provider == 'inworld' and not manager.mistral().inworld.saved then
                return refused('Requires an Inworld key (add it in Settings > Voices > Custom voices)')
            end
            values.voiceProvider = choice.provider
            if choice.provider == 'omni' then values.omniSteps, values.omniReference = choice.steps, choice.reference end
        elseif key:sub(1, 13) == 'relationship:' then
            if change.value ~= 1 and change.value ~= 2 and change.value ~= 3 then
                return refused('Choose one of the listed relationship options.')
            end
            values.relationshipModes[key:sub(14)] = ({'auto', 'on', 'off'})[change.value]
        elseif key:sub(1, 10) == 'immersive:' then
            local field = key:sub(11)
            local arrivals, delays, waits = manager.immersiveChoices()
            local lists = {arrival = arrivals, delay = delays, wait = waits}
            if field == 'enabled' or field == 'waypoint' or field == 'texts' then
                if type(change.value) ~= 'boolean' then return refused('This setting must be on or off.') end
                values.immersive[field] = change.value
            elseif lists[field] then
                local picked = type(change.value) == 'number' and change.value == math.floor(change.value) and lists[field][change.value] or nil
                if picked == nil then return refused('Choose one of the listed options.') end
                values.immersive[field] = picked
            else return refused('That setting is read-only.') end
        elseif key == 'housemates:enabled' or key == 'housemates:chat' then
            if type(change.value) ~= 'boolean' then return refused('This setting must be on or off.') end
            values.housemates[key:sub(12)] = change.value
        elseif key == 'housemates:chatCooldown' or key == 'housemates:chatSize' then
            local cooldowns, sizes = manager.housemateChoices()
            local list = key == 'housemates:chatSize' and sizes or cooldowns
            local picked = type(change.value) == 'number' and change.value == math.floor(change.value) and list[change.value] or nil
            if picked == nil then return refused('Choose one of the listed options.') end
            values.housemates[key:sub(12)] = picked
        elseif key == 'housemates:moveIn' then
            local ids = moveInChoices()
            local picked = type(change.value) == 'number' and change.value == math.floor(change.value) and ids[change.value] or nil
            if picked == nil then return refused('Choose one of the listed options.') end
            values.housemates.moveIn = picked
        elseif key:sub(1, 8) == 'dynamic:' then
            if type(change.value) ~= 'boolean' then return refused('This setting must be on or off.') end
            values.dynamicInfo[key:sub(9)] = change.value
        elseif key == 'archetypeConversations' then values.archetypeConversations = change.value
        elseif key == 'storyConversations' then values.storyConversations = change.value
        elseif key == 'companionReactions' then
            -- One switch for the two stored settings battleReactions and lootReactions.
            if type(change.value) ~= 'boolean' then return refused('This setting must be on or off.') end
            values.battleReactions, values.lootReactions = change.value, change.value
        elseif key == 'voiceActivation' then values.voiceActivation = change.value
        elseif key == 'voiceChoices' then values.voiceChoices = change.value
        elseif key == 'remoteOmni' then values.remoteOmni = change.value
        elseif key == 'amdMiopen' then values.amdMiopen = change.value
        elseif key == 'keyBindings:reset' then values.keyBindings = manager.defaultKeyBindings()
        elseif key == 'companionOutfits' then values.companionOutfits = change.value
        elseif key == 'characterEddies' then values.characterEddies = change.value
        elseif key == 'characterBonds' then values.characterBonds = change.value
        elseif key == 'storyPacks' then values.storyPacks = change.value
        elseif key == 'reachOuts' then values.reachOuts = change.value
        elseif key == 'reputation' then values.reputation = change.value
        elseif key == 'npcThreats' then values.npcThreats = change.value
        elseif key == 'revengeAmbushes' then values.revengeAmbushes = change.value
        elseif key == 'johnnyInHead' then
            -- Order: 1 Off, 2 On, 3 Speaks up rarely, 4 Speaks up normally, 5 Speaks up often. One row writes both stored settings: Off is not in his head (no remarks).
            local pick = ({'off', 'off', 'rare', 'medium', 'normal'})[change.value]
            if not pick or change.value ~= math.floor(change.value) then return refused('Choose how often Johnny speaks up.') end
            values.johnnyInHead = change.value ~= 1
            values.johnnyRemarks = pick
        elseif key == 'companionSpeakUp' then
            -- Order: 1 Off, 2 Speaks up rarely, 3 Speaks up normally, 4 Speaks up often.
            local pick = ({'off', 'rare', 'medium', 'normal'})[change.value]
            if not pick or change.value ~= math.floor(change.value) then return refused('Choose how often companions speak up.') end
            values.companionSpeakUp = pick
        elseif key:sub(1, 6) == 'addon:' and addonSettingsInUse() then
            local staged, problem = convaiAddons.stageSetting(key, change.value)
            if not staged then convaiAddons.discardSettings(); return refused(problem) end
            addonChanges = addonChanges + 1
        else return refused('That setting is read-only.') end
        applied[#applied + 1] = key
    end
    -- V on OmniVoice needs the pack (named first) and the companion voice as this batch leaves it to be OmniVoice: otherwise it is refused, nothing is saved.
    if values.vVoiceEngine == 'omni' then
        local block = manager.vOmniBlock({voiceProvider = values.voiceProvider or snapshot.settings.voiceProvider, remoteOmni = (values.remoteOmni ~= nil) and values.remoteOmni or snapshot.settings.remoteOmni})
        if block == 'pack' then return refused('Requires the optional OmniVoice pack (GPU)') end
        if block == 'voice' then return refused('Requires the Companion voices to be an OmniVoice choice') end
    end
    -- A batch that moves the companions off OmniVoice while V speaks with it: manager.applySettings sets V to Pocket in the same save, and this says so.
    local vSpeaks = snapshot.settings.vVoice == true or snapshot.settings.vVoiceMic == true
    if values.vVoice ~= nil then vSpeaks = values.vVoice == true or values.vVoiceMic == true end
    local omniLeft = values.vVoiceEngine == nil and vSpeaks and values.voiceProvider ~= nil and values.voiceProvider ~= 'omni'
        and snapshot.settings.vVoiceEngine == 'omni' and not manager.vOmniBlock(snapshot.settings)
    -- No Voxtral voice beside Mature content: choosing one while the setting is on (or stays on) is refused and nothing is saved. A batch that turns
    -- the setting on never gets here with one: stageMature moved it to Pocket.
    local matureFinal = values.matureContent
    if matureFinal == nil then matureFinal = snapshot.settings.matureContent == true end
    if matureFinal == true and (values.voiceProvider == 'voxtral' or values.vVoiceEngine == 'voxtral') then
        return refused('Voxtral is not used with Mature content.')
    end
    if matureFinal == true and values.voiceProvider == 'inworld' then
        return refused('Inworld is not used with Mature content.')
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
    if ok and matureNote then text = matureNote .. (text and ' ' .. text or '') end
    if ok and omniLeft then text = (text and text .. ' ' or '') .. ui.t('V’s voice switches from OmniVoice to Pocket.') end
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
    -- A key being set (Key bindings page): read here, because the page is a menu and the game's 10 Hz tick (paced by the frame delta, zero in a menu) does
    -- not run while it is open. One global and one table read when no Set waits (docs/KEY_BINDINGS.md).
    local keys = convaiKeyBinds
    if keys and keys.capturing() then pcall(keys.captureTick, currentPlayer) end
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
        -- Street reputation was just turned on in the menu: its hooks register here, in the game's update (one nil check otherwise).
        if convaiReputationPending and worldReady and type(convaiReputationWanted) == 'function' then
            convaiReputationPending = nil
            pcall(convaiReputationWanted)
        end
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
    modelFind.text, modelFind.words = '', {}
    if convaiKeyBinds then pcall(convaiKeyBinds.abandonCapture) end
end

function M.shutdown()
    queue.bind(nil)
    if preparationActionFeedback then actionFeedback = nil end
    preparationTarget, preparationStatus, preparationActionFeedback, preparationAt = nil, nil, false, 0
end

return M
