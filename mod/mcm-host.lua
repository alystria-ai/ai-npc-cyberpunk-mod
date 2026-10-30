local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end
-- The Companion Manager inside Mod Configuration Menu (MCM, Nexus Mods 31640), version 0.10.5 or later. This is the second host of
-- the page that mod/manager-ui.lua builds (the first is Native Settings UI, mod/nsui.lua): it registers one provider, "AI NPC
-- Cyberpunk Mod", with MCM and gives MCM the page as a schema of categories and rows. The pages, the actions and the rules for
-- applying a setting are in manager-ui.lua; nothing here knows what a setting means.
--
-- Only MCM's public API is used: GetMod('ModConfigurationMenuAPI'), providers.registerProvider and the provider callbacks
-- (listMods, loadMod, invokeAction, applyBatch, closeMod), hasDrafts, reloadMod, revert, refreshProvider and the public UI extension (api.ui, v1, MCM 0.10.5): setApplyPolicy, setPresentation, setNavigation,
-- setFooterActions, setChoiceStates, setStatus, getContext, open and clear. MCM 0.10.6 adds to that interface (the version number of api.ui
-- stays 1, so each addition is found by its own function, or by the MCM version for the new presentation options, never by api.ui.apiVersion):
-- close, setActionVisibility and the presentation options labelIndent, highlightModifiedValues and (now for every row) rowFontSize. They are
-- used only when present (M.newUi); with MCM 0.10.5 none of them is called and nothing below changes. No MCM function is overridden or
-- hooked, and no widget of MCM is touched. Antrix, MCM's author, exposed these calls and wrote the reference port this module follows.
--
--  * Apply policy: explicit. A change is a draft that MCM keeps (changed-row markers, Revert, Apply, Defaults) until the player
--    presses Apply; MCM then hands the whole batch to applyBatch, which runs manager-ui.lua's M.apply (ONE validated, saved
--    transaction), and loads the page again. Both hosts read and write the same saved settings through that one function, so the
--    two cannot disagree: whichever is opened next builds its page from what is saved.
--  * An action (a button) is manager-ui.lua's M.invoke. MCM refuses an action while changes are pending ("Apply or revert pending
--    changes first"). A button that cannot be used right now is still drawn as a button (MCM draws a disabled action as a plain
--    line of another size and shape, so the page would change layout); pressing it answers "Not available right now.".
--  * How MCM draws a row decides how the page looks, and the host can only choose the kind of row (docs in mcm-fake.mjs, layout()):
--    a setting (switch, list, slider) has its label in MCM's marker column (x 48, MCMLayout.reds contentLabelX; no option or row
--    property moves it), red, and purple when its value differs from the DEFAULT the provider gave (MCM's "changed" mark,
--    mcm_model.lua settingDisplay: no default, no mark); an action is a flush-left label (x 20) with a button; a read-only line is a
--    flush-left label at size 26 (MCM's list-row text) with a value.
--    (MCM 0.10.6 lifts three of these: labelIndent puts a setting's label at x 20 like the buttons, highlightModifiedValues = false turns
--    the purple off while defaults still count, and rowFontSize sizes setting, action and read-only rows alike; see applyPresentation.)
--    So: no row is given a default (nothing is purple; MCM's own Defaults button and Modified counter go with it), and this host
--    offers its own Restore defaults button in the footer instead (the rows' defaults are manager-ui.lua's M.defaults; MCM's public API
--    has no confirmation, so the button asks to be pressed twice). The Settings page has no read-only line (Voice status and Johnny's
--    standing were removed 2026-10-20, and with them the status buttons that drew such lines at the size of the other rows); the read-only
--    lines of the other pages are MCM's own lines. The previous and next page buttons and the letter group of a long list
--    (which have no draft in MCM) are footer buttons, beside the way back, so they never move with the list; the page number is in
--    the heading.
--  * The line under the way back (the result of the last action) is MCM's status line (api.ui.setStatus).
--  * Nothing runs per frame while the screen is closed: M.update is a clock comparison. It does its work every quarter of a second
--    (the slow tick), and every frame only while the model browser is open and still reading the game's models.
local M = {}
local ui = (convaiUiLocale or dofile('ui-locale.lua'))

-- V sits in an ordinary seat (init.lua convaiPlainSitting): V's chairs and couches are scene sits at scene tier 3, which is no cutscene.
-- It tells a seat from a cutscene for the words of the refusal below; it does not open the page (see refusal). False where that is not
-- defined.
local function sittingPlainly()
    if type(convaiPlainSitting) ~= 'function' then return false end
    local ok, value = pcall(convaiPlainSitting)
    return ok and value == true
end

local PROVIDER, MOD = 'cyberpunk-convai', 'manager'
local MOD_KEY = PROVIDER .. ':' .. MOD
local MIN_VERSION = {0, 10, 5}
local SLOW_PERIOD = 0.25
local CONNECT_PERIOD, CONNECT_SLOW, CONNECT_FAST_TRIES = 1, 5, 30
-- A page that could not be loaded again is tried again after this many seconds, not every tick.
local RELOAD_BACKOFF = 5
-- The calls of api.ui this module makes: an MCM that lacks one cannot host the page.
local UI_CALLS = {'setApplyPolicy', 'setPresentation', 'setNavigation', 'setFooterActions', 'setChoiceStates', 'setStatus',
    'getContext', 'open', 'clear'}
-- The scroll calls are used when present (MCM 0.10.5 has them): the list keeps its place after Apply.
local SCROLL_CHECK, SCROLL_TRIES = 0.3, 3
local API_CALLS = {'hasDrafts', 'reloadMod', 'revert', 'refreshProvider'}
-- MCM 0.10.6 (UI extension, version number still 1): found by the call, and by the version for the presentation options.
local NEW_VERSION = {0, 10, 6}
-- The Back button of the home page closes MCM's screen (api.ui.close); its id is not one of the page's rows.
local HOME_BACK_ID = 'home:close'
local CAPABILITIES = {
    -- reset = false and no defaultValue: MCM marks a row purple only when it has a default and differs from it (see the top).
    setting = {read = true, write = true, draft = true, reset = false},
    action = {read = true, action = true, write = false, draft = false, reset = false},
    text = {read = true, write = false, draft = false, reset = false},
}

-- The footer button that puts the settings back to their defaults (manager-ui.lua M.defaults).
local DEFAULTS_ID = 'defaults:restore'
-- The ids of the rows whose choice states (greyed-out entries) MCM holds from the last build of the schema.
local choiceStatesHeld = {}
local core, options
local restoreArmed, restorePage = false, nil
local api, provider, version
-- What this MCM offers beyond 0.10.5 (M.newUi): {close, actionVisibility, presentation}; all false for 0.10.5.
local newUi = {}
local connectAt, connectTries, lastReason = 0, 0, nil
local slowAt, localeRevision = 0, -1
local wasActive, opened = false, false
local reloadWanted, reloadAfter, revertWanted = false, 0, false
local statusSent, lastError = nil, ''
local currentBack, pageSeen
-- The Model browser's search (followSearch): the text of MCM's Search settings box as MCM last published it, the page the box was last
-- followed on, and whether this MCM takes the provider search mode (false once it refused it).
local contextSearch, searchView, searchProvider = '', nil, true
-- The page controls of the page last loaded: the page of its long list and how many there are, the letter group and how many.
-- `status` holds the status lines of the category being converted ({text, help}), which the heading says (see STATUS_ROWS).
local controls = {page = 1, pages = 1, group = 1, groups = 1, range = nil, status = {}}
local configured = false

local function log(message)
    if options and options.log then options.log(message) end
end

-- A problem that can come round on every press or retry: nsui.lua's once-per-message line (it counts the repeats in runtime/mcm.log).
local function logRepeat(message)
    if options and options.logRepeat then options.logRepeat(message) else log(message) end
end

-- One line per distinct reason, so a copy of MCM that cannot host the page is said once, not every second.
local function logOnce(message)
    if message ~= lastReason then lastReason = message; log(message) end
end

-- ---- Is this MCM one that can host the page ----------------------------------------------------------------------------------------

local function parseVersion(text)
    local major, minor, patch = tostring(text or ''):match('^%s*v?(%d+)%.(%d+)%.?(%d*)')
    if not major then return nil end
    return {tonumber(major), tonumber(minor), tonumber(patch) or 0}
end

local function atLeast(found, wanted)
    for index = 1, 3 do
        if found[index] ~= wanted[index] then return found[index] > wanted[index] end
    end
    return true
end

-- nil when `found` (what GetMod('ModConfigurationMenuAPI') returned) can host the page, otherwise the reason in one line.
function M.unsupported(found)
    if type(found) ~= 'table' then return 'it did not answer' end
    local parsed = parseVersion(found.version)
    if parsed and not atLeast(parsed, MIN_VERSION) then
        return 'MCM ' .. tostring(found.version) .. ' is older than 0.10.5, which added the public interface the manager needs'
    end
    if found.apiVersion ~= 2 or type(found.providers) ~= 'table' or type(found.providers.registerProvider) ~= 'function' then
        return 'its provider interface (API version 2) is not there'
    end
    if type(found.ui) ~= 'table' or found.ui.apiVersion ~= 1 then
        return 'it has no public UI extension (API version 1, MCM 0.10.5 or later)'
    end
    for _, name in ipairs(UI_CALLS) do
        if type(found.ui[name]) ~= 'function' then return 'its UI extension lacks ' .. name end
    end
    for _, name in ipairs(API_CALLS) do
        if type(found[name]) ~= 'function' then return 'it lacks ' .. name end
    end
    return nil
end

-- The additions of MCM 0.10.6 that `found` offers: close (api.ui.close), actionVisibility (api.ui.setActionVisibility) and presentation (the
-- options labelIndent and highlightModifiedValues of setPresentation, which an older MCM refuses as a whole, so they are only sent when
-- both calls are there and the version is 0.10.6 or newer, or cannot be read). MCM 0.10.5 answers false for all three.
function M.newUi(found)
    local result = {close = false, actionVisibility = false, presentation = false}
    local extension = type(found) == 'table' and found.ui or nil
    if type(extension) ~= 'table' then return result end
    result.close = type(extension.close) == 'function'
    result.actionVisibility = type(extension.setActionVisibility) == 'function'
    local parsed = parseVersion(found.version)
    result.presentation = result.close and result.actionVisibility and (parsed == nil or atLeast(parsed, NEW_VERSION))
    return result
end

-- ---- The page as MCM wants it -----------------------------------------------------------------------------------------------------

local function clamp(value, low, high)
    value = math.floor(tonumber(value) or low)
    if value < low then return low end
    if value > high then return high end
    return value
end

-- Always an enabled button: a disabled action is drawn by MCM as a read-only line (another font size, no button), which would make the
-- page change shape with the state. The model refuses a button that cannot be used (manager-ui.lua M.invoke).
local function action(id, label, value, description)
    return {id = id, type = 'action', label = label, value = value, description = description or '', disabled = false,
        capabilities = CAPABILITIES.action}
end

-- The status lines of manager-ui.lua's pages: what the row above a list says. MCM draws a read-only line (McmUiAddReadonly) as a surface at
-- x 20 with its text inset by 16 (MCMLayout.ListRowTextLeftInset; 4 when the list selection is text-only), while the label of an action
-- row starts at x 20 and labelIndent does not reach a read-only line. So a status line above a list of buttons sat 16 px to the right of
-- the names under it and read as a stray heading. The heading of the category says it instead ("Characters to invite · Load a save first ·
-- Page 1 / 11"), like the page number, and the help of the line is the page's description (the schema's, which MCM's description panel
-- shows while no row is hovered: MCM's own heading has no hover text). Native Settings UI draws the rows as they are.
-- Each entry names the part of the row the heading says: its value, its label, or both (the label, then the value).
-- The members line of a saved party (Parties, "Saved party: Party 1") is one of them: it sat indented and red above the party's buttons. Its row id
-- ends in the party's id, so it is matched by its start (statusPart).
local STATUS_ROWS = {['needs-save'] = 'value', ['empty-party'] = 'label', ['model-status'] = 'label', ['character-status'] = 'label', ['chauffeur-state'] = 'both'}
local function statusPart(id) return STATUS_ROWS[id] or (id:sub(1, 14) == 'party:members:' and 'label' or nil) end

-- The rows of manager-ui.lua's page as rows of MCM's schema. A row with no counterpart is dropped (nil); a page control becomes
-- footer buttons (the second value is 'footer': they go in the footer, beside the way back, and not in the list).
local function convert(row)
    local kind, id = row.type, row.id
    if id == 'feedback' then return nil end
    if id == 'ui:page' then
        local page, pages = clamp(row.value, 1, math.max(1, row.max or 1)), math.max(1, row.max or 1)
        controls.page, controls.pages = page, pages
        local where = ui.t('Page {page} / {pages}', {page = page, pages = pages})
        -- Both buttons are always there; at the first or last page one of them does nothing (MCM cannot draw a button disabled). Each says in
        -- the description panel which page it goes to and what that page holds (the page's own text, manager-ui.lua pageRows).
        return {action('ui:page:previous', ui.t('Previous page'), ui.t('Previous page'), row.previousHelp or where),
            action('ui:page:next', ui.t('Next page'), ui.t('Next page'), row.nextHelp or where)}, 'footer'
    elseif id == 'ui:group' then
        local elements = row.elements or {}
        local group = clamp(row.value, 1, math.max(1, #elements))
        controls.group, controls.groups = group, math.max(1, #elements)
        local current = ui.t('Starts with: {letter}', {letter = elements[group] or ''})
        return {action('ui:group:next', current, current, row.description)}, 'footer'
    elseif statusPart(id) then
        local part = statusPart(id)
        local text = part == 'value' and tostring(row.value or '') or tostring(row.label or '')
        if part == 'both' and tostring(row.value or '') ~= '' then text = text .. ' · ' .. tostring(row.value) end
        -- `row` is the line as a line: it stays one when nothing is listed under it (see schema).
        controls.status[#controls.status + 1] = {text = text, help = tostring(row.description or ''), row = {{id = id, type = 'string',
            label = row.label, description = row.description or '', value = tostring(row.value or ''), capabilities = CAPABILITIES.text}}}
        return nil
    elseif id == 'list-range' then
        -- The page number and the names the page runs between: the heading of the list says them (see schema).
        controls.range = {label = row.label, names = tostring(row.value or '')}
        return nil
    end
    if kind == 'bool' then
        return {{id = id, type = 'bool', label = row.label, description = row.description or '', value = row.value == true,
            capabilities = CAPABILITIES.setting}}
    elseif kind == 'select' then
        local elements = row.elements and #row.elements > 0 and row.elements or {''}
        return {{id = id, type = 'select', label = row.label, description = row.description or '', elements = elements,
            value = clamp(row.value, 1, #elements), capabilities = CAPABILITIES.setting}}
    elseif kind == 'int' then
        local low, high = row.min or 0, row.max or 100
        return {{id = id, type = 'int', label = row.label, description = row.description or '', min = low, max = high,
            step = row.step or 1, value = clamp(row.value, low, high), capabilities = CAPABILITIES.setting}}
    elseif kind == 'action' then
        return {action(id, row.label, row.value, row.description)}
    end
    -- A line of text: the label and its value, nothing to change.
    return {{id = id, type = 'string', label = row.label, description = row.description or '', value = tostring(row.value or ''),
        capabilities = CAPABILITIES.text}}
end

local function isBack(id) return id:match(':back$') ~= nil or id == 'memory:settings' end

-- The model of manager-ui.lua as MCM's schema, plus what the page tells the UI extension (the way back, the voice entries that
-- cannot be chosen). Runs in loadMod: MCM asks for it when the screen opens, after an Apply and on reloadMod.
local function schema()
    local model = core.model()
    local categories, disabledChoices, disabledReasons, footer = {}, {}, {}, {}
    local pageHelp = {}
    currentBack = nil
    -- The confirmation of Restore defaults is for the page it was asked on.
    if restoreArmed and core.pageId() ~= restorePage then restoreArmed = false end
    controls.page, controls.pages, controls.group, controls.groups, controls.range = 1, 1, 1, 1, nil
    for _, category in ipairs(model.categories) do
        local settings = {}
        controls.range, controls.status = nil, {}
        for _, row in ipairs(category.settings) do
            local converted, placed = convert(row)
            for _, item in ipairs(converted or {}) do
                if placed == 'footer' then footer[#footer + 1] = item
                else settings[#settings + 1] = item end
                if item.type == 'action' and isBack(item.id) then currentBack = item end
            end
            if row.disabledElements then disabledChoices[row.id], disabledReasons[row.id] = row.disabledElements, row.disabledReason end
        end
        -- Nothing is listed under a status line (no save and no party, the models still being read): MCM draws no heading for a
        -- category without rows, so the line stays a line, with nothing under it to be out of line with.
        if #settings == 0 then
            for _, status in ipairs(controls.status) do
                for _, item in ipairs(status.row) do settings[#settings + 1] = item end
            end
            controls.status = {}
        end
        local name, description = category.name, category.description or ''
        -- A status line (a save is needed, the party is empty, how many models match) is said by the heading, then the page of a paged
        -- list; the help of each line is the page's description. A heading is drawn like every other heading, where a line of the list
        -- would be drawn in another size and place than the buttons of the list.
        for _, status in ipairs(controls.status) do
            if status.text ~= '' then name = name .. ' · ' .. status.text end
            local help = status.help:gsub('%s+$', '')
            if help ~= '' then pageHelp[#pageHelp + 1] = help end
        end
        if controls.range and controls.pages > 1 then
            name = name .. ' · ' .. controls.range.label
            description = controls.range.names
        end
        if #settings > 0 then
            categories[#categories + 1] = {id = category.id, name = name, description = description, settings = settings}
        end
    end
    -- Restore defaults, on Settings and on the pages that open from it with settings of their own (Relationships, Dynamic info), and on Key bindings.
    local view = core.view()
    if core.hasDefaults(view) then
        -- Two short words, not "Restore defaults" / "Press again to restore": with pending changes the footer holds five buttons (Revert,
        -- Apply, MCM's Add to favorites, this one, Back) and MCM gives each one the same share of the row, cutting the text that is
        -- longer. The footer is only read again when the page is loaded again, which MCM refuses while changes are pending, so the button
        -- cannot be hidden then; the description (hover) carries the full sentence.
        -- MCM 0.10.6 wraps a label that does not fit (and Add to favorites is hidden there), so the whole name fits.
        local label = newUi.presentation and ui.t('Restore defaults') or ui.t('Defaults')
        footer[#footer + 1] = action(DEFAULTS_ID, label, restoreArmed and ui.t('Confirm') or label,
            ui.t('Puts every setting on Settings, Relationships, Dynamic info and Key bindings back to its default. Press the button twice to confirm.'))
    end
    -- Home's Back (MCM 0.10.6): the footer button that closes MCM's screen, like the Back of the pages under it. It is not the page's
    -- back action (no backActionId), so Escape stays MCM's own close.
    if view == 'home' and newUi.close then
        footer[#footer + 1] = action(HOME_BACK_ID, ui.t('Back'), ui.t('Back'), ui.t('Close this menu.'))
    end
    -- The buttons of the page that are not in the list: the letter group, the previous and next page, and the way back (rightmost).
    local footerIds, byId = {}, {}
    for _, item in ipairs(footer) do byId[item.id] = item end
    for _, id in ipairs({'ui:group:next', 'ui:page:previous', 'ui:page:next', DEFAULTS_ID, HOME_BACK_ID}) do
        if byId[id] then footerIds[#footerIds + 1] = id end
    end
    -- The home page has no back action of its own (no backActionId): MCM's own Escape closes the screen, so Escape is Home's Back. With
    -- MCM 0.10.6 a footer Back (HOME_BACK_ID, above) asks api.ui.close for the same; 0.10.5 has no public call that closes its screen
    -- (api.closeMod only closes the provider's mod, the screen stays), so there Escape is all there is.
    if currentBack then footerIds[#footerIds + 1] = currentBack.id end
    if #footer > 0 then
        categories[#categories + 1] = {id = 'ui-footer', name = model.name, description = '', settings = footer}
    end
    if api then
        pageSeen = core.pageId()
        -- The Model browser searches itself (followSearch): with the provider search mode MCM does not filter the rows by the box, which
        -- would hide the models the page lists on a page of twelve. Parties takes the same mode because the box holds the name the Rename
        -- button takes, not a filter. Every other page keeps MCM's own filter.
        local navigation = {pageId = pageSeen, backActionId = currentBack and currentBack.id, escapeBack = true,
            searchMode = searchProvider and (core.view() == 'models' or core.view() == 'characters' or core.view() == 'party') and 'provider' or nil}
        local called, accepted = pcall(api.ui.setNavigation, MOD_KEY, navigation)
        if navigation.searchMode and not (called and accepted == true) then
            -- An MCM that refuses the option refuses the whole call: the page is given without it, and keeps MCM's filter and no hint.
            navigation.searchMode = nil
            local again, retried = pcall(api.ui.setNavigation, MOD_KEY, navigation)
            if again and retried == true then
                searchProvider = false
                core.offerSearch(false)
                logRepeat('Companion Manager: Mod Configuration Menu would not take the provider search mode, so the Model browser keeps its letters.')
            end
        end
        pcall(api.ui.setFooterActions, MOD_KEY, footerIds)
        local function entriesOf(id, disabled)
            local size = 0
            for index in pairs(disabled) do size = math.max(size, index) end
            for _, category in ipairs(model.categories) do
                for _, row in ipairs(category.settings) do
                    if row.id == id then size = math.max(size, #(row.elements or {})) end
                end
            end
            return size
        end
        local held = {}
        for id, disabled in pairs(disabledChoices) do
            local states = {}
            for index = 1, entriesOf(id, disabled) do
                -- The row says why an entry is greyed out (the OmniVoice pack, the Mistral key); the pack is the reason of the voice list.
                -- An entry whose value is a string carries its own reason (Voxtral beside Mature content); the others share the row's.
                local own = type(disabled[index]) == 'string' and disabled[index] or nil
                states[index] = {enabled = not disabled[index], reason = own or disabledReasons[id] or ui.t('Requires the optional OmniVoice pack (GPU)')}
            end
            pcall(api.ui.setChoiceStates, MOD_KEY, id, states, {wrap = false})
            held[id] = true
        end
        -- A row that had greyed-out entries and has none now (a Mistral key was saved, the OmniVoice pack was installed): MCM keeps the states it
        -- was given, so every entry is sent as enabled again.
        for id in pairs(choiceStatesHeld) do
            if not held[id] then
                local states = {}
                for index = 1, entriesOf(id, {}) do states[index] = {enabled = true} end
                pcall(api.ui.setChoiceStates, MOD_KEY, id, states, {wrap = false})
            end
        end
        choiceStatesHeld = held
    end
    return {name = model.name, description = #pageHelp > 0 and table.concat(pageHelp, '\n\n') or model.description, categories = categories}
end

-- ---- What MCM asks of the provider --------------------------------------------------------------------------------------------------

local function hasDrafts()
    local ok, pending = pcall(api.hasDrafts, MOD_KEY)
    return ok and pending == true
end

local function active()
    if not api then return false end
    local ok, context = pcall(api.ui.getContext)
    if not (ok and type(context) == 'table') then return false end
    contextSearch = type(context.search) == 'string' and context.search or ''
    return context.open == true and context.modKey == MOD_KEY
end

-- The Model browser is searched with MCM's own Search settings box: on that page MCM hands the filtering to the provider (the provider
-- search mode, set with the page's navigation) and publishes the box's text in its context, which active() read just now. MCM settles
-- the text for a few frames after a key, so this sees a finished word, not every letter; the page is drawn again only when the words
-- changed (core.setSearch says so, and the redraw is queued by it). The box keeps its text from page to page and filters the others by
-- it, so it is emptied on the way into and out of the browser.
local function followSearch()
    local view = core.view()
    if view ~= searchView then
        local involved = view == 'models' or searchView == 'models' or view == 'characters' or searchView == 'characters' or view == 'party' or searchView == 'party'
        searchView = view
        if involved and contextSearch ~= '' then
            pcall(api.ui.setSearch, MOD_KEY, '')
            contextSearch = ''
        end
    end
    if (view == 'models' or view == 'characters' or view == 'party') and searchProvider then core.setSearch(contextSearch) end
end

-- A button of a long list's page control: the list moves to another page, or to the next letter group.
local function pageControl(actionId)
    if actionId == 'ui:page:previous' then return core.setUi('ui:page', math.max(1, controls.page - 1))
    elseif actionId == 'ui:page:next' then return core.setUi('ui:page', math.min(controls.pages, controls.page + 1))
    elseif actionId == 'ui:group:next' then
        -- The last letter goes round to All.
        return core.setUi('ui:group', controls.group >= controls.groups and 1 or controls.group + 1)
    end
    return false
end

-- ---- Keeping the place in the list -----------------------------------------------------------------------------------------------

-- MCM keeps the list's scroll position itself (a fraction of the list's height, taken before every redraw), but the live check
-- showed the list jumping far down after Apply. The public scroll calls give the position back: it is read before MCM applies or
-- the host reloads the page, and set again after the page is loaded (and checked once more a moment later).
local keepScroll

local function contentScroll()
    if not api or type(api.ui.getScrollPosition) ~= 'function' then return nil end
    local ok, value = pcall(api.ui.getScrollPosition, MOD_KEY, 'content')
    if ok and type(value) == 'number' and value == value and value >= 0 and value <= 1 then return value end
    return nil
end

local function putScroll(value)
    if api and type(api.ui.setScrollPosition) == 'function' then
        pcall(api.ui.setScrollPosition, MOD_KEY, 'content', value)
    end
end

-- Called with what contentScroll() returned before the page was loaded again.
local function restoreScroll(before)
    if before == nil then return end
    keepScroll = {value = before, page = core.pageId(), at = os.clock() + SCROLL_CHECK, tries = SCROLL_TRIES}
    putScroll(before)
end

-- Restore defaults: the first press asks for a second one (the button says so), the second puts every row on Settings and
-- Relationships and Dynamic info back to its default, and puts the default key bindings back, in ONE saved transaction, as MCM's own Defaults button did (that button is gone with the defaults).
local function restoreDefaults()
    if not restoreArmed then
        restoreArmed, restorePage = true, core.pageId()
        core.setFeedback(ui.t('Press Confirm to put every setting back to its default.'))
        return {ok = true, schemaChanged = true}
    end
    restoreArmed = false
    local changes = core.defaults()
    if #changes > 0 then
        local before = contentScroll()
        local result = core.apply(changes)
        if not result.ok then return {ok = false, error = result.error, schemaChanged = true} end
        restoreScroll(before)
    end
    core.setFeedback(ui.t('Defaults restored.'))
    return {ok = true, schemaChanged = true}
end

local function buildProvider()
    return {
        id = PROVIDER, registrationKey = 'cyberpunk-convai.manager.v1', apiVersion = 2,
        name = 'AI NPC Cyberpunk Mod', shortName = 'CONVAI',
        capabilities = {index = true, lazy = true, draft = true, action = true, atomicApply = true, dynamicSchema = true},
        listMods = function()
            return {complete = true, revision = tostring(ui.revision()), mods = {{id = MOD, name = ui.t(core.LABEL),
                description = ui.t('Your companions, character models and conversation settings.')}}}
        end,
        closeMod = function(id)
            -- The next visit starts on the first page, as the Native Settings UI tab does.
            if id == MOD then core.setView('home'); reloadWanted, revertWanted, statusSent, restoreArmed = false, false, nil, false end
            return true
        end,
        loadMod = function(id)
            if id ~= MOD then return nil, 'Unknown mod.' end
            return schema()
        end,
        invokeAction = function(id, actionId)
            if id ~= MOD then return {ok = false, error = 'Unknown mod.'} end
            if actionId == DEFAULTS_ID then return restoreDefaults() end
            if actionId == HOME_BACK_ID then
                restoreArmed = false
                if not newUi.close then return {ok = false, error = 'Not available right now.'} end
                -- MCM closes the screen on its next update, with its usual question when changes are pending (Home has none).
                local called, request, problem = pcall(api.ui.close, MOD_KEY)
                if not called then request, problem = nil, request end
                if request == nil then
                    lastError = 'Close: ' .. tostring(problem)
                    logRepeat('Companion Manager: Mod Configuration Menu would not close the page: ' .. tostring(problem))
                    return {ok = false, error = tostring(problem or 'Mod Configuration Menu would not close the page.')}
                end
                return {ok = true, schemaChanged = false}
            end
            -- Any other button drops a first press of Restore defaults (the button is drawn again);.
            local wasArmed = restoreArmed
            restoreArmed = false
            if actionId:sub(1, 3) == 'ui:' then
                -- At the first or last page the button does nothing: the page is not drawn again.
                return {ok = true, schemaChanged = pageControl(actionId) == true or wasArmed}
            end
            local result = core.invoke(actionId)
            return {ok = result.ok == true, error = result.error, schemaChanged = true}
        end,
        applyBatch = function(id, changes)
            if id ~= MOD then return {ok = false, error = 'Unknown mod.'} end
            local batch, requested = {}, {}
            for _, change in ipairs(changes) do
                batch[#batch + 1] = {id = change.id, value = change.value}
                requested[#requested + 1] = change.id
            end
            local before = contentScroll()
            local result = core.apply(batch)
            if not result.ok then
                return {ok = false, error = result.error, atomic = true, partial = false, appliedIds = {}}
            end
            -- A requested value the rules did not keep (Mature content without Local AI goes back to off) leaves a draft that
            -- MCM would show as unapplied: it is reverted from the next tick, and the reason is on the status line.
            if result.refusal then revertWanted = true end
            restoreScroll(before)
            -- appliedIds are the ids MCM asked for (the rules may have saved more, such as the Local AI provider with Mature content).
            return {ok = true, atomic = true, partial = false, appliedIds = requested, schemaChanged = true}
        end,
    }
end

-- ---- Connecting ---------------------------------------------------------------------------------------------------------------------

local function present()
    local ok, found = pcall(GetMod, 'ModConfigurationMenuAPI')
    if ok and type(found) == 'table' then return found end
    return nil
end

-- MCM answers these only for a mod it has indexed, so they are repeated (once a second) until it accepts them. Returns whether it did.
-- MCM 0.10.5: no rowFontSize (MCM applied it by walking the finished list, which left the setting labels smaller than the action labels
-- beside them), so every row keeps MCM's own size, and nothing beyond the base options is sent (0.10.5 refuses an option it does not
-- know, the whole call). MCM 0.10.6: rowFontSize sizes setting, action and read-only rows alike, labelIndent puts a setting's label at the
-- buttons' x, highlightModifiedValues = false turns the purple of a changed value off (defaults, reset and the Modified counter are
-- untouched), and Add to favorites is hidden (setActionVisibility replaces the previous map; Apply and Revert stay MCM's).
-- rowFontSize is worked out from the screen (rowFontFor), not fixed.
-- The size of every row's text (rowFontSize). MCM does not take it as canvas units: its walk over the finished list (MCMPanelPresentation.Walk)
-- sets each text to size / (the widget's accumulated scale), so the number is a size on the screen, while the label boxes keep the canvas units
-- of MCMLayout.reds (980 wide, labels 444) and the whole canvas is shrunk by uniformScale = min(width / 1920, height / 1080) (mcm_host.lua
-- density) times the profile. A fixed 22 therefore grows relative to the box as the screen gets smaller (windowed 1366x768, live 2026-10-21:
-- every setting label cut to "(...)", buttons untouched), and at 1080p and above it is the size that was checked to fit. So the size follows
-- the same density, never above 22: the text then takes the same share of its box as it does at 1080p, in every profile. Below a density of
-- 12 / 22 (about 1046x589) MCM refuses a size under 12, and the option is left out: MCM's own size, which always fits. When the resolution
-- cannot be read the option is left out as well (a plain size beats a cut label).
local ROW_FONT, ROW_FONT_MIN, CANVAS_W, CANVAS_H = 22, 12, 1920, 1080

local function rowFontFor(width, height)
    if type(width) ~= 'number' or type(height) ~= 'number' or not (width > 0 and height > 0) then return nil end
    local density = math.min(width / CANVAS_W, height / CANVAS_H)
    if density >= 1 then return ROW_FONT end
    local size = math.floor(ROW_FONT * density + 1e-6)
    if size < ROW_FONT_MIN then return nil end
    return size
end
M.rowFontFor = rowFontFor

-- CET's GetDisplayResolution(): the game's resolution as two numbers (a vector with x and y is taken too). Read when the page is opened or
-- the presentation is given, never per frame.
local function displayRowFont()
    local ok, width, height = pcall(function()
        if type(GetDisplayResolution) ~= 'function' then return nil end
        local a, b = GetDisplayResolution()
        if type(a) == 'number' then return a, b end
        if type(a) == 'table' or type(a) == 'userdata' then return a.x or a.X, a.y or a.Y end
        return nil
    end)
    if not ok then return nil end
    return rowFontFor(tonumber(width), tonumber(height))
end

local sentFont = false  -- what the presentation last carried (a number, or nil for "left out"); false until it was sent

local function applyPresentation()
    local called, policy = pcall(api.ui.setApplyPolicy, MOD_KEY, 'explicit')
    local base = {locale = ui.current(), descriptionFontSize = 22, labelWidthFraction = 0.5, statusPlacement = 'header', quietActions = true}
    local shown, presentation
    if newUi.presentation then
        local extended = {}
        for key, value in pairs(base) do extended[key] = value end
        extended.rowFontSize, extended.labelIndent, extended.highlightModifiedValues = displayRowFont(), 20, false
        shown, presentation = pcall(api.ui.setPresentation, MOD_KEY, extended)
        if shown and presentation == true then sentFont = extended.rowFontSize end
        if not (shown and presentation == true) then
            -- The mod is not indexed yet (the base call fails too: tried again in a second), or this MCM refuses an option: base only.
            shown, presentation = pcall(api.ui.setPresentation, MOD_KEY, base)
            if shown and presentation == true then
                newUi.presentation = false
                logRepeat('Companion Manager: Mod Configuration Menu refused the 0.10.6 presentation options, so the 0.10.5 ones are used.')
            end
        end
    else
        shown, presentation = pcall(api.ui.setPresentation, MOD_KEY, base)
    end
    local ready = called and policy == true and shown and presentation == true
    if ready and newUi.actionVisibility then
        local hidden, result = pcall(api.ui.setActionVisibility, MOD_KEY, {favorite = 'hide'})
        if not (hidden and result == true) then
            newUi.actionVisibility = false
            logRepeat('Companion Manager: Mod Configuration Menu would not hide Add to favorites: ' .. tostring(hidden and 'refused' or result))
        end
    end
    configured = ready
    return configured
end

-- When the page is opened (the shortcut, or the player picking the page in MCM): the size is worked out again, so a resolution changed since
-- the last opening is picked up. Nothing is sent when it is the same size (and MCM ignores an unchanged presentation).
local function refreshRowFont()
    if api and configured and newUi.presentation and displayRowFont() ~= sentFont then applyPresentation() end
end

local function connect()
    if api then return true end
    local found = present()
    if not found then return false end
    local why = M.unsupported(found)
    if why then
        -- One console line, in plain words: what is wrong and what to do (the way out depends on whether Native Settings UI is there).
        local nsui = false
        if options and type(options.nativeSettings) == 'function' then
            local ok, found = pcall(options.nativeSettings)
            nsui = ok and found == true
        end
        logOnce('Companion Manager: Mod Configuration Menu cannot host the page (' .. why .. '). '
            .. (nsui and 'Native Settings UI is installed, so its tab is used. To use Mod Configuration Menu instead, update it to 0.10.5 or newer.'
                or 'Update it to 0.10.5 or newer, or install Native Settings UI.'))
        return false
    end
    newUi = M.newUi(found)
    local called, registered, problem = pcall(found.providers.registerProvider, provider)
    if not called or not registered then
        lastError = 'Register: ' .. tostring(called and problem or registered)
        logOnce('Companion Manager: Mod Configuration Menu would not take the provider: ' .. lastError)
        return false
    end
    api, version = found, tostring(found.version or 'unknown')
    localeRevision = ui.revision()
    pcall(api.refreshProvider, PROVIDER)
    applyPresentation()
    core.offerSearch(searchProvider)
    log('Companion Manager registered with Mod Configuration Menu ' .. version)
    return true
end

-- ---- What nsui.lua calls --------------------------------------------------------------------------------------------------------------

-- core: manager-ui.lua's module, the SAME instance the Native Settings UI host draws (the host passes it); options.log(message).
function M.configure(coreModule, hostOptions)
    core, options = coreModule, hostOptions or {}
    provider = buildProvider()
end

-- At CET's onInit. A copy of MCM that loads after this mod is found by the look in update.
function M.install()
    connectAt = os.clock() + CONNECT_PERIOD
    return connect()
end

-- Whether the page is registered with MCM (an MCM 0.10.5 or later answered).
function M.ready() return api ~= nil end

-- 'ready' (registered), 'old' (an MCM older than 0.10.5 is installed, which has no public interface for the page) or 'missing'.
function M.availability()
    if api then return 'ready' end
    local found = present()
    if not found then return 'missing' end
    local parsed = parseVersion(found.version)
    if parsed and not atLeast(parsed, MIN_VERSION) then return 'old' end
    return 'missing'
end

-- Whether a copy of MCM answers GetMod at all (whatever its version), and whether it may still become able to host the page: it is
-- there, is not registered yet and is not a version older than 0.10.5 (an older one never will be). nsui.lua waits a little for such
-- an MCM before it registers its own tab, so the two never list the page side by side.
function M.present() return api ~= nil or present() ~= nil end

function M.pending()
    if api then return false end
    local found = present()
    if not found then return false end
    local parsed = parseVersion(found.version)
    if parsed and not atLeast(parsed, MIN_VERSION) then return false end
    return true
end

-- Mod Configuration Menu's own gameplay entry (ModConfigurationMenu/mcm_ui/mcm_settings_entry.lua, SettingsEntry.canOpen, read 2026-10-20)
-- declines every open request, the public api.ui.open included, while V's scene tier is 3 or above: its reason is "scene", logged only as
-- "open request declined before transition". A couch or a chair is a scene sit at tier 3 (live 2026-10-19), so MCM would never show the
-- page there, and nothing the public API offers overrides it. The 2026-10-19 change let a plain sit through to MCM, which declined with
-- no word to the player (2026-10-20: F4 on a couch did nothing). So the seat is refused here, with its own words and kind, and init.lua
-- tells the player. The second value is the kind of the refusal: 'seated' for a plain sit, nil otherwise.
M.STAND_UP = 'Stand up to open the Companion Manager'
local function refusal()
    local player = convaiPlayer()
    if not player or not player:IsAttached() or Game.GetSystemRequestsHandler():IsPreGame() then return 'Load a save first.' end
    local boxOk, boxOpen = pcall(function() return player:ConvaiComposerOpen() end)
    if boxOk and boxOpen then return 'Close the text box first.' end
    local defs, boards = Game.GetAllBlackboardDefs(), Game.GetBlackboardSystem()
    local scene = boards:GetLocalInstanced(player:GetEntityID(), defs.PlayerStateMachine)
    if scene:GetInt(defs.PlayerStateMachine.SceneTier) >= 3 then
        if sittingPlainly() then return M.STAND_UP, 'seated' end
        return 'Finish the scene first.'
    end
    return nil
end

-- The shortcut. Opens MCM on the manager's page with MCM's own public open call. Returns true, or false and the reason; the third
-- value is true when the reason is the state of the game (nothing else would open the manager either), the fourth the kind of that
-- refusal ('seated': V sits, so the player is told to stand up).
function M.open()
    if not api then connect() end
    if not api then return false, 'Mod Configuration Menu 0.10.5 or later is not available.' end
    local checked, why, kind = pcall(refusal)
    if checked and why then return false, why, true, kind end
    if active() then return true end
    refreshRowFont()
    core.setView('home')
    local called, request, problem = pcall(api.ui.open, MOD_KEY)
    if not called then request, problem = nil, request end
    if request == nil then
        lastError = 'Open: ' .. tostring(problem)
        logRepeat('Companion Manager: Mod Configuration Menu would not open the page: ' .. tostring(problem))
        return false, tostring(problem or 'Mod Configuration Menu would not open the page.')
    end
    return true
end

local function pushStatus()
    local text = core.feedback() or ''
    if text == statusSent then return end
    statusSent = text
    pcall(api.ui.setStatus, MOD_KEY, {text = text, kind = 'info'})
end

-- Called every frame by nsui.lua, which calls core.update before it (the slow tick of the manager). With the screen closed this is a
-- clock comparison; the work below runs every SLOW_PERIOD seconds.
function M.update(player, worldReady)
    local clock = os.clock()
    if not api then
        if clock >= connectAt then
            connectTries = connectTries + 1
            connectAt = clock + (connectTries > CONNECT_FAST_TRIES and CONNECT_SLOW or CONNECT_PERIOD)
            connect()
        end
        return
    end
    if not configured and clock >= connectAt then
        connectAt = clock + CONNECT_PERIOD
        applyPresentation()
    end
    -- The model browser reads the game's models a bounded batch a frame while it is open: it keeps its frame rate.
    local scanning = opened and core.view() == 'models'
    if clock < slowAt and not scanning then return end
    slowAt = clock + SLOW_PERIOD

    if ui.revision() ~= localeRevision then
        -- The interface language changed: the mod's name and the presentation (its locale) are given again, and the page is drawn
        -- again (manager-ui.lua queues that itself).
        localeRevision = ui.revision()
        configured = false
        if not hasDrafts() then pcall(api.refreshProvider, PROVIDER) end
    end

    opened = active()
    if not opened then
        if wasActive then
            wasActive, reloadWanted, revertWanted, statusSent, keepScroll, searchView = false, false, false, nil, nil, nil
            core.setView('home')
        end
        return
    end
    if not wasActive then refreshRowFont() end
    wasActive = true
    followSearch()
    core.tick(player)
    if core.stale() then reloadWanted = true end
    if revertWanted then
        revertWanted = false
        if hasDrafts() then pcall(api.revert, MOD_KEY) end
    end
    -- The page is drawn again when something it shows changed, unless changes are pending: the redraw waits for Apply or Revert (MCM
    -- refuses to reload with drafts, and a redraw would hide what the player is editing).
    if reloadWanted and clock >= reloadAfter and not hasDrafts() then
        reloadWanted = false
        local before, pageBefore = contentScroll(), pageSeen
        local called, loaded, problem = pcall(api.reloadMod, MOD_KEY)
        if called and loaded ~= nil and core.pageId() == pageBefore then restoreScroll(before) end
        if not called or loaded == nil then
            lastError = 'Reload: ' .. tostring(called and problem or loaded)
            reloadAfter = clock + RELOAD_BACKOFF
            logRepeat('Companion Manager: Mod Configuration Menu would not load the page again: ' .. lastError)
        end
    end
    if keepScroll and clock >= keepScroll.at then
        local wanted = keepScroll
        keepScroll = nil
        -- Only while the page is the one the position belongs to; a page turned meanwhile starts at its top.
        local now = contentScroll()
        if now ~= nil and core.pageId() == wanted.page and math.abs(now - wanted.value) > 0.01 and wanted.tries > 1 then
            putScroll(wanted.value)
            wanted.tries, wanted.at, keepScroll = wanted.tries - 1, clock + SCROLL_CHECK, wanted
        end
    end
    pushStatus()
end

function M.resetSession()
    reloadWanted, revertWanted, statusSent, keepScroll = active() and true or false, false, nil, nil
end

function M.shutdown()
    if not api then return end
    pcall(api.ui.clear, MOD_KEY)
    if type(api.providers) == 'table' and type(api.providers.unregisterProvider) == 'function' then
        pcall(api.providers.unregisterProvider, PROVIDER, provider.registrationKey)
    end
    core.offerSearch(false)
    api, opened, wasActive, newUi, sentFont = nil, false, false, {}, false
end

function M.inspect()
    return {available = api ~= nil, version = version, active = opened, error = lastError ~= '' and lastError or nil,
        reason = lastReason, page = pageSeen, back = currentBack and currentBack.id or nil,
        newUi = {close = newUi.close == true, actionVisibility = newUi.actionVisibility == true, presentation = newUi.presentation == true}}
end

-- Tests only.
M._test = {convert = convert, schema = schema, provider = function() return provider end}

return M
