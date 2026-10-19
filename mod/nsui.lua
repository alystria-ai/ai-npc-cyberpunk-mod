-- The Companion Manager inside Native Settings UI (nativeSettings, Nexus Mods 3518, tested with 1.96). This is the host: it registers
-- one tab, "AI NPC Cyberpunk Mod", on the Mods screen (Esc > Mods) and keeps it equal to the page that mod/manager-ui.lua builds. The
-- pages, the actions and the rules for applying a setting are in manager-ui.lua; nothing here knows what a setting means.
--
--  * One tab. The first section is the way back (or, on the first page, the four destinations); the other sections are the page.
--    A page change removes the sections after the first one (last section first) and adds the new ones; a change inside a page
--    replaces only the rows that differ, so the widget the player is using is not rebuilt under them.
--  * A long list (characters, models, party, memory) is one page of at most PAGE_SIZE rows, read with a page slider, so a page
--    never puts more than a screenful of widgets on the screen.
--  * A change is applied for real. Switches, selectors and sliders collect for a moment (DEBOUNCE) and are then applied together as
--    one validated, saved transaction (manager-ui.lua M.apply); what the rules corrected or refused is put back on the rows in place
--    and said on the line under the way back. Restore defaults goes through the same path.
--  * Nothing runs while the screen is closed except a few comparisons in M.update. The tab is built when the Mods screen opens, and
--    drawn again only when something it shows changes, never inside a Native Settings UI callback (callbacks only record what
--    happened; M.update does the work on the next frame).
local M = {}
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
local core = dofile('manager-ui.lua')
local entryModule = dofile('nsui-entry.lua')
local fontLibrary = dofile('ui-fonts.lua')

local TAB, TAB_LABEL = 'aiNpcCyberpunkMod', 'AI NPC Cyberpunk Mod'
local TAB_PATH = '/' .. TAB
local NEEDS_HOST = 'The Companion Manager needs Mod Configuration Menu 0.10.5 or newer, or Native Settings UI'
local MCM_OLD = 'Update Mod Configuration Menu to 0.10.5 or newer to use the Companion Manager'

-- What the widgets of Native Settings UI can show. Their geometry is the game's (the row template of the Settings screen), not ours,
-- so these are estimates in the units of manager-ui.lua's optionUnits (an average lowercase letter is 1): a label that is longer is
-- cut with an ellipsis (the full text is in the description), a button's text is kept short.
local LAYOUT = {
    labelUnits = 36,         -- the longest label of a row that has no button text
    buttonLabelUnits = 29,   -- ... of a row that ends in a button text
    stripUnits = 70,         -- the longest section name
    buttonUnits = 18,        -- the longest button text
    shortText = 9,           -- a button text up to this long is drawn at textSize, a longer one at longTextSize
    textSize = 45,           -- NSUI's own examples use 45
    longTextSize = 34,
    descriptionChars = 420,  -- the longest description (characters); what is more is cut at a paragraph or a sentence
}
M.LAYOUT = LAYOUT
-- Seconds a change waits for the next one before it is applied (each new change restarts the wait; at most MAX_WAIT in all).
local DEBOUNCE = {switch = 0.3, select = 0.4, range = 0.6, page = 0.25}
local MAX_WAIT = 2.0
local PRESS_REPEAT = 0.3

local ns, entry
-- The tab as this module built it: a list of sections {id, name, rows = {{sig, opt, id, kind}}}, mirroring what Native Settings UI
-- holds for the tab.
local rendered = {}
local pending, flushAt, flushFirst = {}, nil, nil
local savedValue = {}              -- row id -> the value the page was built with (what is saved)
local rebuildAt                    -- when to draw the page again (clock), or nil
local presses, lastPress = {}, {}
local suppress = 0                 -- above 0 while this module sets a row itself: the row's callback must not be taken for the player
local wasLive, closedFlag = false, false
local connectAt = 0
local renderFailures = 0
local hooksInstalled = false
local fontScope, fontWork, fontsDue = nil, nil, false
local framesDue = false             -- the frames of the read-only rows are hidden again on the next frame the tab is shown
local lastError = ''
-- The other hosts of the page (mod/mcm-host.lua, attached by init.lua): each draws core's page in its own settings screen and shares
-- this module's core, so every host reads and writes the same saved settings. hostError: the last problem each one raised (logged once).
local hosts, hostError = {}, {}

local function log(message)
    local file = io.open('runtime/mcm.log', 'a')
    if file then file:write(os.date('!%Y-%m-%dT%H:%M:%SZ'), ' ', message, '\n'); file:close() end
    print('[CyberpunkConvai] ' .. message)
end

-- ---- Text that fits ---------------------------------------------------------------------------------------------------------------

local function fit(text, budget)
    text = tostring(text or '')
    if core.optionUnits(text) <= budget then return text end
    return core.cutToUnits(text, budget)
end

local function characters(text)
    local _, count = text:gsub('[^\128-\191]', '')
    return count
end

-- The first `count` characters of a UTF-8 text.
local function head(text, count)
    local seen, index, size = 0, 1, #text
    while index <= size do
        local byte = text:byte(index)
        if byte < 128 or byte >= 192 then
            seen = seen + 1
            if seen > count then return text:sub(1, index - 1) end
        end
        index = index + 1
    end
    return text
end

-- The byte at which the last sentence of a text ends: a full stop, question or exclamation mark before a space or at the end, or one of
-- the full-width marks of Chinese and Japanese (three bytes each, so they are looked for as whole strings, never as a set of bytes).
local function lastSentenceEnd(text)
    local best
    for _, mark in ipairs({'。', '！', '？'}) do
        local from = 1
        while true do
            local at = text:find(mark, from, true)
            if not at then break end
            best = math.max(best or 0, at + #mark - 1)
            from = at + 1
        end
    end
    for at in text:gmatch('()[%.%?!]%s') do best = math.max(best or 0, at) end
    if text:match('[%.%?!]$') then best = math.max(best or 0, #text) end
    return best
end

-- A description that fits the description area: whole paragraphs while they fit, otherwise the first paragraph cut at the last full
-- sentence (or word) before the limit, ending in an ellipsis.
local function fitDescription(text)
    text = tostring(text or '')
    local limit = LAYOUT.descriptionChars
    if characters(text) <= limit then return text end
    local kept = {}
    local used = 0
    for paragraph in (text .. '\n\n'):gmatch('(.-)\n\n') do
        local size = characters(paragraph)
        local add = size + (#kept > 0 and 2 or 0)
        if used + add > limit then
            if #kept == 0 then
                local cut = head(paragraph, limit - 1)
                local ends = lastSentenceEnd(cut)
                local sentence = ends and cut:sub(1, ends)
                if sentence and characters(sentence) >= limit * 0.4 then cut = sentence
                else
                    local word = cut:match('^(.*)%s%S*$')
                    if word and characters(word) >= limit * 0.4 then cut = word end
                end
                kept[1] = cut .. '…'
            end
            break
        end
        kept[#kept + 1], used = paragraph, used + add
    end
    return table.concat(kept, '\n\n')
end
M.fitDescription, M.fit = fitDescription, fit

-- ---- A row of the page as a widget ------------------------------------------------------------------------------------------------

local function textSize(text)
    return core.optionUnits(text) <= LAYOUT.shortText and LAYOUT.textSize or LAYOUT.longTextSize
end

local function clampIndex(value, count)
    value = math.floor(tonumber(value) or 1)
    if value < 1 then return 1 end
    if value > count then return count end
    return value
end

-- {kind, id, label, desc, ...} for one row of manager-ui.lua's page.
local function describe(row)
    local spec = {id = row.id, ui = row.id:sub(1, 3) == 'ui:' or nil}
    local kind = row.type
    -- What is cut from the row's own text is not lost: the whole text leads the description (which has room for it).
    local whole
    if kind == 'bool' then
        spec.kind, spec.label = 'switch', fit(row.label, LAYOUT.labelUnits)
        if spec.label ~= row.label then whole = row.label end
        spec.value, spec.default = row.value == true, row.defaultValue == true
    elseif kind == 'select' then
        spec.kind, spec.label = 'select', fit(row.label, LAYOUT.labelUnits)
        if spec.label ~= row.label then whole = row.label end
        spec.elements = row.elements and #row.elements > 0 and row.elements or {''}
        spec.value = clampIndex(row.value, #spec.elements)
        spec.default = clampIndex(row.defaultValue or 1, #spec.elements)
    elseif kind == 'int' then
        spec.kind, spec.label = 'range', fit(row.label, LAYOUT.labelUnits)
        if spec.label ~= row.label then whole = row.label end
        spec.min, spec.max, spec.step = row.min or 0, row.max or 100, row.step or 1
        spec.value = math.max(spec.min, math.min(spec.max, math.floor(tonumber(row.value) or spec.min)))
        spec.default = math.max(spec.min, math.min(spec.max, math.floor(tonumber(row.defaultValue) or spec.min)))
    elseif kind == 'action' then
        spec.kind, spec.text = 'button', fit(row.value, LAYOUT.buttonUnits)
        spec.label = fit(row.label, spec.text ~= '' and LAYOUT.buttonLabelUnits or LAYOUT.labelUnits)
        if spec.text ~= tostring(row.value or '') then whole = row.label .. ': ' .. tostring(row.value)
        elseif spec.label ~= row.label then whole = row.label end
    else
        -- A line of text, nothing to press. A short value is the text where the button's would be (its frame is hidden, see
        -- hideFrames); a line with a long value, or none, is the label alone: "label: value", cut if it is too long.
        spec.kind, spec.text, spec.readonly = 'button', '', true
        local value = tostring(row.value or '')
        if value ~= '' and core.optionUnits(value) <= LAYOUT.buttonUnits and core.optionUnits(row.label) <= LAYOUT.buttonLabelUnits then
            spec.text, spec.label = value, row.label
        else
            local line = value ~= '' and (row.label .. ': ' .. value) or row.label
            spec.label = fit(line, LAYOUT.labelUnits)
            if spec.label ~= line then whole = line end
        end
    end
    local description = tostring(row.description or '')
    spec.desc = fitDescription(whole and (description ~= '' and (whole .. '\n\n' .. description) or whole) or description)
    -- What identifies the widget: everything about it except the value it holds.
    local parts = {spec.kind, spec.id, spec.label, spec.desc, spec.text or '', tostring(spec.min), tostring(spec.max), tostring(spec.step),
        table.concat(spec.elements or {}, '\1')}
    spec.sig = table.concat(parts, '\2')
    return spec
end

local function sectionPath(id) return TAB_PATH .. '/' .. id end

-- ---- What the widgets report ------------------------------------------------------------------------------------------------------

local function schedule(delay)
    local clock = os.clock()
    flushFirst = flushFirst or clock
    flushAt = clock + delay
    if clock - flushFirst > MAX_WAIT then flushAt = clock end
end

local function onChange(id, value, kind)
    if suppress > 0 then return end
    if id:sub(1, 3) == 'ui:' then
        if core.setUi(id, value) then rebuildAt = os.clock() + DEBOUNCE.page end
        return
    end
    if kind == 'range' then value = math.floor((tonumber(value) or 0) + 0.5) end
    pending[id] = value
    schedule(DEBOUNCE[kind] or DEBOUNCE.switch)
end

local function onPress(id)
    local clock = os.clock()
    -- One press can reach a callback twice (the click and the accept action): the same button counts once in a short while.
    if lastPress[id] and clock >= lastPress[id] and clock - lastPress[id] < PRESS_REPEAT then return end
    lastPress[id] = clock
    presses[#presses + 1] = id
end

local function addRow(path, spec, index)
    local id = spec.id
    if spec.kind == 'switch' then
        return ns.addSwitch(path, spec.label, spec.desc, spec.value, spec.default, function(state) onChange(id, state, 'switch') end, index)
    elseif spec.kind == 'select' then
        return ns.addSelectorString(path, spec.label, spec.desc, spec.elements, spec.value, spec.default,
            function(position) onChange(id, position, 'select') end, index)
    elseif spec.kind == 'range' then
        return ns.addRangeInt(path, spec.label, spec.desc, spec.min, spec.max, spec.step, spec.value, spec.default,
            function(value) onChange(id, value, spec.ui and 'page' or 'range') end, index)
    end
    local callback = spec.readonly and function() end or function() onPress(id) end
    return ns.addButton(path, spec.label, spec.desc, spec.text, textSize(spec.text), callback, index)
end

-- ---- Keeping the tab equal to the page ----------------------------------------------------------------------------------------------

-- Brings an unchanged widget's value up to date with what is saved (Native Settings UI's own setter: the row shows it at once, and its
-- callback, which would take this for the player's own change, is switched off for the call).
local function syncValue(current, spec)
    local opt = current.opt
    if not opt or spec.value == nil or spec.kind == 'button' then return end
    if pending[spec.id] ~= nil then return end
    local live
    if spec.kind == 'switch' then live = opt.state
    elseif spec.kind == 'select' then live = opt.selectedElementIndex
    else live = opt.currentValue end
    if live == spec.value then return end
    suppress = suppress + 1
    local ok, problem = pcall(ns.setOption, opt, spec.value)
    suppress = suppress - 1
    if not ok then lastError = 'Row update: ' .. tostring(problem); log('Manager: a row could not be updated: ' .. tostring(problem)) end
end

local function reconcileRows(section, rows)
    local path = sectionPath(section.id)
    for index, spec in ipairs(rows) do
        local current = section.rows[index]
        if current and current.sig == spec.sig then
            syncValue(current, spec)
        else
            if current and current.opt then ns.removeOption(current.opt) end
            section.rows[index] = {sig = spec.sig, id = spec.id, kind = spec.kind, readonly = spec.readonly, opt = addRow(path, spec, index)}
        end
    end
    for index = #section.rows, #rows + 1, -1 do
        local current = section.rows[index]
        if current.opt then ns.removeOption(current.opt) end
        section.rows[index] = nil
    end
end

-- The tab as the page wants it: sections {id, name, rows (described)}.
local function sectionsOf(model)
    local sections = {}
    for _, category in ipairs(model.categories) do
        local rows = {}
        for index, row in ipairs(category.settings) do
            rows[index] = describe(row)
            if row.type == 'bool' or row.type == 'select' or row.type == 'int' then savedValue[row.id] = rows[index].value end
        end
        sections[#sections + 1] = {id = category.id, name = fit(category.name, LAYOUT.stripUnits), rows = rows}
    end
    return sections
end

local function reconcile(sections)
    -- The sections the tab and the page have in common, from the first. The first section is always common (the way back), so
    -- sections are only ever removed from the end: Native Settings UI leaves a hole in its list when it removes one from the
    -- middle.
    local common = 0
    while common < #rendered and common < #sections and rendered[common + 1].id == sections[common + 1].id
        and rendered[common + 1].name == sections[common + 1].name do
        common = common + 1
    end
    for index = #rendered, common + 1, -1 do
        ns.removeSubcategory(sectionPath(rendered[index].id))
        rendered[index] = nil
    end
    for index = 1, common do reconcileRows(rendered[index], sections[index].rows) end
    for index = common + 1, #sections do
        local section = sections[index]
        ns.addSubcategory(sectionPath(section.id), section.name)
        rendered[index] = {id = section.id, name = section.name, rows = {}}
        reconcileRows(rendered[index], section.rows)
    end
end

-- Takes the tab down to nothing, ignoring errors, so the next draw starts from a known place.
local function clearTab()
    for index = #rendered, 1, -1 do
        pcall(ns.removeSubcategory, sectionPath(rendered[index].id))
        rendered[index] = nil
    end
    savedValue = {}
end

local function render()
    if not ns then return end
    local model = core.model()
    savedValue = {}
    reconcile(sectionsOf(model))
    fontsDue, framesDue = true, true
end

local function renderSafe()
    local ok, problem = pcall(render)
    if ok then renderFailures = 0; return true end
    lastError = 'Draw: ' .. tostring(problem)
    log('Manager: the page could not be drawn: ' .. tostring(problem))
    renderFailures = renderFailures + 1
    -- A draw that failed half-way leaves the tab out of step with what was recorded: start again from nothing, a few times at most.
    pcall(clearTab)
    if renderFailures < 3 then rebuildAt = os.clock() + 0.25 end
    return false
end

-- ---- Applying -----------------------------------------------------------------------------------------------------------------------

local function applyChanges(changes)
    local result = core.apply(changes)
    if not result.ok and #changes > 1 then
        -- One change the rules refuse must not take the others with it: each is tried by itself and the first refusal is told.
        local firstError
        for _, change in ipairs(changes) do
            local single = core.apply({change})
            if not single.ok and not firstError then firstError = single.error end
        end
        if firstError then core.setFeedback(firstError) end
    end
end

local function flushNow()
    flushAt, flushFirst = nil, nil
    local changes = {}
    for id, value in pairs(pending) do
        if savedValue[id] ~= value then changes[#changes + 1] = {id = id, value = value} end
    end
    pending = {}
    table.sort(changes, function(a, b) return a.id < b.id end)
    if #changes > 0 then
        local ok, problem = pcall(applyChanges, changes)
        if not ok then
            lastError = 'Apply: ' .. tostring(problem)
            log('Manager: a setting could not be applied: ' .. tostring(problem))
            core.setFeedback(ui.t('The action could not finish: {reason}', {reason = tostring(problem):sub(1, 160)}))
        end
    end
    -- What the rules corrected, refused or added shows on the rows now.
    rebuildAt = os.clock()
end

local function runPresses()
    local queued = presses
    presses = {}
    -- A button pressed right after a change sees that change: apply what is waiting first.
    if flushAt then flushNow() end
    for _, id in ipairs(queued) do
        local ok, problem = pcall(core.invoke, id)
        if not ok then lastError = 'Action: ' .. tostring(problem); log('Manager: an action failed: ' .. tostring(problem)) end
    end
    rebuildAt = os.clock()
end

local function onRestoreDefaults()
    -- Everything waiting is dropped: the defaults replace it.
    pending, flushAt, flushFirst = {}, nil, nil
    if core.view() ~= 'settings' and core.view() ~= 'relationships' then
        core.setFeedback(ui.t('Open Settings to restore its defaults.'))
        rebuildAt = os.clock()
        return
    end
    local changes = core.defaults()
    if #changes > 0 then
        local ok, problem = pcall(applyChanges, changes)
        if not ok then lastError = 'Defaults: ' .. tostring(problem); log('Manager: defaults could not be applied: ' .. tostring(problem)) end
    end
    core.setFeedback(ui.t('Defaults restored.'))
    rebuildAt = os.clock()
end

-- ---- Read-only rows -------------------------------------------------------------------------------------------------------------
-- Native Settings UI has no line of text, so a read-only row is its button without the button: the art of the switch the button is
-- made from is hidden and the text stays. The text is not part of that art: Native Settings UI puts it in a canvas under
-- layout/container itself, beside the switch's two states, layout/container/offState and layout/container/onState. Each state holds
-- a body (and the body the button, buttonBorder and txtValue). Hiding the parts one by one left a thin outline (the body's own
-- border), and Native Settings UI hides the onState parts only (its "off" path points at the onState body as well), so a row of ours
-- hides both state widgets whole (and the two frame images, below). If a path is missing, the body, then its parts, are hidden instead; the controller's
-- offStateBody and onStateBody fields are inkWidgetRef values (a method call on them does nothing, the static
-- inkWidgetRef.SetVisible reaches the widget) and are tried last. The controller exists while the tab is on screen and is made again
-- each time the tab opens, so this runs after every draw and when the tab is shown, a few calls for a page, never per frame. A row
-- whose widgets do not answer stays as a button with its text, which is harmless. A real button is never touched.
local FRAME_PARTS = {'button', 'buttonBorder', 'txtValue'}

local function widgetAt(parent, ...)
    local path = {...}
    local ok, widget = pcall(function() return parent:GetWidgetByPath(BuildWidgetPath(path)) end)
    if ok then return widget end
    return nil
end

local function hideWidget(widget)
    if widget then pcall(function() widget:SetVisible(false) end) end
end

-- The frame of a button is two images under layout/container itself, bk_fill and bk_border, besides the two states (seen live: they
-- stayed visible after the states were hidden, as a thin outline). A read-only row hides them; the row's text is in the canvas
-- Native Settings UI adds, which none of this touches. A real button needs its fill and border and is never given to this.
local FRAME_IMAGES = {'bk_fill', 'bk_border'}
local framesProblem = false  -- a failure to hide is logged once per session

local function hideFrame(controller)
    local problems = {}
    local okRoot, container = pcall(function()
        return controller:GetRootWidget():GetWidgetByPath(BuildWidgetPath({'layout', 'container'}))
    end)
    if not (okRoot and container) then problems[#problems + 1] = 'layout/container not found' end
    if okRoot and container then
        for _, name in ipairs(FRAME_IMAGES) do
            local image = widgetAt(container, name)
            if image then hideWidget(image) else problems[#problems + 1] = name .. ' not found' end
        end
        for _, state in ipairs({'offState', 'onState'}) do
            hideWidget(widgetAt(container, state))
            local body = widgetAt(container, state, 'body')
            hideWidget(body)
            if body then
                for _, name in ipairs(FRAME_PARTS) do hideWidget(widgetAt(body, name)) end
            end
        end
    end
    for _, field in ipairs({'offStateBody', 'onStateBody'}) do
        pcall(function() inkWidgetRef.SetVisible(controller[field], false) end)
    end
    if #problems > 0 and not framesProblem then
        framesProblem = true
        pcall(log, 'Read-only row frame not fully hidden: ' .. table.concat(problems, '; '))
    end
end

local function hideFrames()
    for _, section in ipairs(rendered) do
        for _, row in ipairs(section.rows) do
            local controller = row.readonly and row.opt and row.opt.controller
            if controller then hideFrame(controller) end
        end
    end
end

-- ---- Fonts --------------------------------------------------------------------------------------------------------------------------
-- The rows are the game's own widgets and take the font of the game's language. A language of this mod that has a family of its own
-- (Russian, Ukrainian, Chinese, Japanese, Korean) needs that family when the game runs in another language. Nothing is done for a
-- Latin language. The pass runs from update, a bounded batch a frame, after a draw and when the tab opens; never inside a callback.
local FONT_BATCH = 160

local function fontCode()
    local code = ui.current()
    if fontLibrary.family(code) then return code end
    return false
end

local function fontPass()
    local code = fontCode()
    if not fontScope then fontScope = fontLibrary.new() end
    if not code and fontScope.count() == 0 then fontWork, fontsDue = nil, false; return end
    local controller = ns.settingsMainController
    local list = ns.settingsOptionsList and ns.settingsOptionsList.widget
    if not controller or not list then fontWork, fontsDue = nil, false; return end
    if not fontWork then fontWork = {index = 0}; fontScope.begin() end
    local budget = {left = FONT_BATCH}
    if fontWork.index == 0 then
        local description = controller.descriptionText
        if description then fontScope.apply(description, code) end
    end
    local count = math.min(list:GetNumChildren(), 400)
    while fontWork.index < count and budget.left > 0 do
        fontScope.walk(list:GetWidgetByIndex(fontWork.index), code, budget)
        -- A row cut short by the batch is walked again with a fresh one next frame (applying a font twice changes nothing).
        if budget.left <= 0 then break end
        fontWork.index = fontWork.index + 1
    end
    if fontWork.index >= count then
        fontScope.finish()
        fontWork, fontsDue = nil, false
    end
end

-- The tab is left: the font the description area was given goes back (the rows go away with the tab).
local function fontRelease()
    if fontScope and fontScope.count() > 0 then
        pcall(function()
            local controller = ns and ns.settingsMainController
            if controller and controller.descriptionText then fontScope.restore(controller.descriptionText) end
        end)
        fontScope.clear()
    end
    fontWork, fontsDue = nil, false
end

-- ---- Native Settings UI ---------------------------------------------------------------------------------------------------------------

local function nativeSettings()
    if type(GetMod) ~= 'function' then return nil end
    local ok, found = pcall(function() return GetMod('nativeSettings') or GetMod('NativeSettings') end)
    if not ok or type(found) ~= 'table' then return nil end
    -- Everything this module calls: an older version without them cannot host the page.
    for _, name in ipairs({'addTab', 'addSubcategory', 'removeSubcategory', 'removeOption', 'addSwitch', 'addRangeInt',
        'addSelectorString', 'addButton', 'setOption', 'registerRestoreDefaultsCallback'}) do
        if type(found[name]) ~= 'function' or type(found.data) ~= 'table' then return nil end
    end
    return found
end

-- The position of this tab in Native Settings UI's own order (0-based): what it keeps as the tab to open on.
local function tabIndex()
    local index = 0
    for path in pairs(ns.data) do
        if path == TAB then return index end
        index = index + 1
    end
    return nil
end

local function live() return ns ~= nil and ns.currentTab == TAB end

-- The screen opens on the first page, with a page built from what is true now.
local function prepare()
    pending, flushAt, flushFirst = {}, nil, nil
    core.setView('home')
    renderSafe()
end

local function selectTab()
    local controller = ns and ns.settingsMainController
    local index = ns and tabIndex()
    if controller and index and controller.selectorCtrl then controller.selectorCtrl:SetToggledIndex(index) end
end

-- The walk stopped on the list of mods of Mod Configuration Menu, which hides Native Settings UI's own Mods screen when it is
-- installed: its public API cannot choose a mod in that screen, so the player is told where the manager is (mod/nsui-entry.lua).
local function notify(kind)
    if kind ~= 'mcm-list' then return end
    pcall(function()
        local player = Game.GetPlayer()
        if player and type(convaiNotices) == 'table' then
            convaiNotices.sendLines(player, {{id = 'manager-in-mcm-list', text = ui.t('Open AI NPC Cyberpunk Mod in the Mods list.')}})
        end
    end)
end

-- The walk of the shortcut: it asks for the first page, a page built from what is true now, and tells Native Settings UI to start on
-- this tab.
local function newEntry()
    return entryModule.new({ns = function() return ns end, log = log,
        beforeOpen = function()
            prepare()
            local index = tabIndex()
            if index then ns.lastNativeSettingsCategoryIndex = index end
        end,
        select = selectTab, notify = notify, live = live})
end

local function installHooks()
    if hooksInstalled then return end
    hooksInstalled = true
    entry.install()
    -- A Mods screen is opening (Native Settings UI marks it with fromMods before it builds anything): the tab is made ready, on its
    -- first page. This runs once per opening of a Settings screen, and does nothing for the game's own Settings.
    local ok, problem = pcall(Observe, 'SettingsMainGameController', 'OnInitialize', function()
        if ns and ns.fromMods == true and not live() then
            local prepared, why = pcall(prepare)
            if not prepared then lastError = 'Open: ' .. tostring(why) end
        end
    end)
    if not ok then log('Manager: could not watch the Settings screen: ' .. tostring(problem)) end
end

-- Whether another host has the page (Mod Configuration Menu 0.10.5 or newer registered it). The tab of this host is then not registered:
-- Mod Configuration Menu would list it a second time through its Native Settings UI bridge, and Native Settings UI cannot remove a
-- tab once it is added. Hosts are installed (and so detected) before this runs at CET's onInit, where every mod is already loaded.
local function otherHostReady()
    for _, host in ipairs(hosts) do
        local ok, ready = pcall(host.ready)
        if ok and ready then return true end
    end
    return false
end

-- `force`: register the tab although another host has the page (the shortcut could not open that host and falls back to this one).
local function connect(force)
    if ns then return true end
    if not force and otherHostReady() then return false end
    local found = nativeSettings()
    if not found then return false end
    entry = entry or newEntry()
    ns = found
    local added, problem = pcall(function()
        ns.addTab(TAB_PATH, TAB_LABEL, function() closedFlag = true; if flushAt then flushAt = os.clock() end end)
        ns.registerRestoreDefaultsCallback(TAB_PATH, true, onRestoreDefaults)
    end)
    if not added then
        ns = nil
        log('Manager: Native Settings UI would not take the tab: ' .. tostring(problem))
        return false
    end
    installHooks()
    renderSafe()
    log('Companion Manager registered with Native Settings UI ' .. tostring(found.version))
    return true
end

-- ---- What init.lua calls ------------------------------------------------------------------------------------------------------------

function M.configure(domain, companions, queueFactory, readiness)
    core.configure(domain, companions, queueFactory, readiness)
    entry = newEntry()
end

-- Another host of the page (mod/mcm-host.lua). It gets the page logic this module draws (the same instance), and is installed,
-- updated, reset and shut down with it. A host that raises an error is told apart from the others and logged once per problem.
function M.attach(host)
    hosts[#hosts + 1] = host
    host.configure(core, {log = log})
end

local function eachHost(name, ...)
    for index, host in ipairs(hosts) do
        local ok, problem = pcall(host[name], ...)
        if not ok and hostError[index] ~= tostring(problem) then
            hostError[index] = tostring(problem)
            log('Manager: a settings host failed in ' .. name .. ': ' .. tostring(problem))
        end
    end
end

-- At CET's onInit. Native Settings UI is read with GetMod there, as it documents; a copy that loads after this mod is found by the
-- once-a-second look in update.
function M.install()
    connectAt = os.time() + 1
    eachHost('install')
    return connect()
end

-- The shortcut found neither host: the notice says what to install (or, when the only Mod Configuration Menu is older than 0.10.5,
-- to update it).
local function postNeedsHost(old)
    pcall(function()
        local player = Game.GetPlayer()
        if player and type(convaiNotices) == 'table' then
            local text = old and ui.t('Update Mod Configuration Menu to 0.10.5 or newer to use the Companion Manager')
                or ui.t('The Companion Manager needs Mod Configuration Menu 0.10.5 or newer, or Native Settings UI')
            convaiNotices.sendLines(player, {{id = 'manager-needs-nsui', text = text}})
        end
    end)
end

-- The manager shortcut. Returns true, or false and the reason. Mod Configuration Menu 0.10.5 or newer, when it hosts the page, is
-- opened straight on it with its public open call. Otherwise Native Settings UI's walk (mod/nsui-entry.lua), which beside an older
-- Mod Configuration Menu stops at its list with one notice.
function M.open()
    for _, host in ipairs(hosts) do
        if host.ready() then
            local ok, opened, reason, gameState = pcall(host.open)
            if ok and opened then return true end
            if not ok then reason = tostring(opened) end
            -- A refusal by the game (no save loaded, a scene) is the answer; any other failure leaves Native Settings UI's walk.
            if ok and gameState then return false, reason end
            if not ns then connect(true) end
            if not ns then return false, reason end
            break
        end
    end
    if not ns then connect(true) end
    if not ns then
        local old = false
        for _, host in ipairs(hosts) do if host.availability() == 'old' then old = true end end
        postNeedsHost(old)
        return false, old and MCM_OLD or NEEDS_HOST
    end
    return entry.open()
end

function M.update(player, worldReady)
    core.update(player, worldReady)
    if hosts[1] then eachHost('update', player, worldReady) end
    if not ns then
        if os.time() >= connectAt then connectAt = os.time() + 1; connect() end
        return
    end
    entry.update()
    if presses[1] then runPresses() end
    local clock = os.clock()
    if flushAt and clock >= flushAt then flushNow() end
    if rebuildAt and clock >= rebuildAt then rebuildAt = nil; renderSafe() end
    local shown = live()
    if shown ~= wasLive then
        wasLive = shown
        entry.shown(shown and ns.settingsMainController or nil)
        if shown then fontsDue, framesDue = true, true
        else
            -- Leaving the tab (another tab, or the screen closing): the next visit starts on the first page.
            fontRelease()
            if flushAt then flushNow() end
            core.setView('home')
            renderSafe()
            closedFlag = false
        end
    end
    if shown then
        core.tick(player)
        if not flushAt and not rebuildAt and core.stale() then renderSafe() end
        if framesDue then
            framesDue = false
            local hidden, problem = pcall(hideFrames)
            if not hidden then lastError = 'Frames: ' .. tostring(problem) end
        end
        if fontsDue or fontWork then
            local ok, problem = pcall(fontPass)
            if not ok then fontWork, fontsDue = nil, false; lastError = 'Fonts: ' .. tostring(problem) end
        end
    end
end

function M.party() return core.party() end
function M.resetSession()
    core.resetSession()
    pending, flushAt, flushFirst, rebuildAt, presses = {}, nil, nil, nil, {}
    if entry then entry.reset() end
    eachHost('resetSession')
    if ns and not live() then renderSafe() end
end
function M.shutdown(worldReady)
    core.shutdown()
    if entry then entry.reset() end
    eachHost('shutdown', worldReady)
end

function M.inspect()
    local sections = {}
    for _, section in ipairs(rendered) do sections[#sections + 1] = {id = section.id, name = section.name, rows = #section.rows} end
    local inspected = core.inspect()
    inspected.available, inspected.live, inspected.sections = ns ~= nil, live(), sections
    inspected.hosts = {}
    for index, host in ipairs(hosts) do
        local ok, state = pcall(host.inspect)
        inspected.hosts[index] = ok and state or {error = tostring(state)}
    end
    inspected.pending, inspected.entry, inspected.error = pending, entry and entry.inspect() or nil, lastError ~= '' and lastError or inspected.error
    return inspected
end

-- Tests only.
M._test = {connect = function() return connect(true) end, core = core, describe = describe, tabIndex = tabIndex, flush = function() flushNow() end, render = render, notify = notify}

return M
