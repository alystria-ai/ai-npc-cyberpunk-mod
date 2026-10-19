-- The Companion Manager inside Mod Configuration Menu (MCM, Nexus Mods 31640), version 0.10.5 or later. This is the second host of
-- the page that mod/manager-ui.lua builds (the first is Native Settings UI, mod/nsui.lua): it registers one provider, "AI NPC
-- Cyberpunk Mod", with MCM and gives MCM the page as a schema of categories and rows. The pages, the actions and the rules for
-- applying a setting are in manager-ui.lua; nothing here knows what a setting means.
--
-- Only MCM's public API is used: GetMod('ModConfigurationMenuAPI'), providers.registerProvider and the provider callbacks
-- (listMods, loadMod, invokeAction, applyBatch, closeMod), hasDrafts, reloadMod, revert, refreshProvider and the public UI extension (api.ui, v1, MCM 0.10.5): setApplyPolicy, setPresentation, setNavigation,
-- setFooterActions, setChoiceStates, setStatus, getContext, open and clear. No MCM function is overridden or hooked, and no widget
-- of MCM is touched. Antrix, MCM's author, exposed these calls and wrote the reference port this module follows.
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
--    So: no row is given a default (nothing is purple; MCM's own Defaults button and Modified counter go with it), and this host
--    offers its own Restore defaults button in the footer instead (the rows' defaults are manager-ui.lua's M.defaults; MCM's public API
--    has no confirmation, so the button asks to be pressed twice). The read-only lines of the Settings page (Voice status, Johnny's
--    standing) are drawn as status buttons (an action: size 22 like every other row, the value as the button's text, pressing it
--    does nothing), so no line of that page is another size. The previous and next page buttons and the letter group of a long list
--    (which have no draft in MCM) are footer buttons, beside the way back, so they never move with the list; the page number is in
--    the heading.
--  * The line under the way back (the result of the last action) is MCM's status line (api.ui.setStatus).
--  * Nothing runs per frame while the screen is closed: M.update is a clock comparison. It does its work every quarter of a second
--    (the slow tick), and every frame only while the model browser is open and still reading the game's models.
local M = {}
local ui = (convaiUiLocale or dofile('ui-locale.lua'))

-- V sits in an ordinary seat (init.lua convaiPlainSitting): V's chairs and couches are scene sits at scene tier 3, which is no cutscene and
-- must not stop the manager (live 2026-10-19: the shortcut answered "Finish the scene first." on a couch). False where that is not defined.
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
local CAPABILITIES = {
    -- reset = false and no defaultValue: MCM marks a row purple only when it has a default and differs from it (see the top).
    setting = {read = true, write = true, draft = true, reset = false},
    action = {read = true, action = true, write = false, draft = false, reset = false},
    text = {read = true, write = false, draft = false, reset = false},
}

-- The footer button that puts the settings back to their defaults (manager-ui.lua M.defaults), and the ids of status buttons.
local DEFAULTS_ID, STATUS_PREFIX = 'defaults:restore', 'status:'
local core, options
local restoreArmed, restorePage = false, nil
local api, provider, version
local connectAt, connectTries, lastReason = 0, 0, nil
local slowAt, localeRevision = 0, -1
local wasActive, opened = false, false
local reloadWanted, reloadAfter, revertWanted = false, 0, false
local statusSent, lastError = nil, ''
local currentBack, pageSeen
-- The page controls of the page last loaded: the page of its long list and how many there are, the letter group and how many.
local controls = {page = 1, pages = 1, group = 1, groups = 1, range = nil}
local configured = false

local function log(message)
    if options and options.log then options.log(message) end
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

-- The rows of manager-ui.lua's page as rows of MCM's schema. A row with no counterpart is dropped (nil); a page control becomes
-- footer buttons (the second value is 'footer': they go in the footer, beside the way back, and not in the list).
local function convert(row)
    local kind, id = row.type, row.id
    if id == 'feedback' then return nil end
    if id == 'ui:page' then
        local page, pages = clamp(row.value, 1, math.max(1, row.max or 1)), math.max(1, row.max or 1)
        controls.page, controls.pages = page, pages
        local where = ui.t('Page {page} / {pages}', {page = page, pages = pages})
        -- Both buttons are always there; at the first or last page one of them does nothing (MCM cannot draw a button disabled).
        return {action('ui:page:previous', ui.t('Previous page'), ui.t('Previous page'), where),
            action('ui:page:next', ui.t('Next page'), ui.t('Next page'), where)}, 'footer'
    elseif id == 'ui:group' then
        local elements = row.elements or {}
        local group = clamp(row.value, 1, math.max(1, #elements))
        controls.group, controls.groups = group, math.max(1, #elements)
        local current = ui.t('Starts with: {letter}', {letter = elements[group] or ''})
        return {action('ui:group:next', current, current, row.description)}, 'footer'
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
    -- A line of text of the Settings page: a status button (the value is its text; pressing it does nothing). MCM draws a read-only
    -- line at size 26, the other rows at 22.
    local value = tostring(row.value or '')
    if core.view() == 'settings' and value ~= '' then
        -- The button is narrow: it shows the first part of a long value ("Voxtral cloud voice" of "Voxtral cloud voice · Local
        -- backup"), and the whole value heads its description.
        local short = value:match('^(.-) · ') or value
        local description = short ~= value and (value .. '\n\n' .. (row.description or '')) or row.description
        return {action(STATUS_PREFIX .. id, row.label, short, description)}
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
    local categories, disabledChoices, footer = {}, {}, {}
    currentBack = nil
    -- The confirmation of Restore defaults is for the page it was asked on.
    if restoreArmed and core.pageId() ~= restorePage then restoreArmed = false end
    controls.page, controls.pages, controls.group, controls.groups, controls.range = 1, 1, 1, 1, nil
    for _, category in ipairs(model.categories) do
        local settings = {}
        controls.range = nil
        for _, row in ipairs(category.settings) do
            local converted, placed = convert(row)
            for _, item in ipairs(converted or {}) do
                if placed == 'footer' then footer[#footer + 1] = item
                else settings[#settings + 1] = item end
                if item.type == 'action' and isBack(item.id) then currentBack = item end
            end
            if row.disabledElements then disabledChoices[row.id] = row.disabledElements end
        end
        local name, description = category.name, category.description or ''
        -- A paged list says its page in its heading, which MCM draws like every other heading (a line of the list would be drawn in
        -- another size and place than the buttons of the list).
        if controls.range and controls.pages > 1 then
            name = name .. ' · ' .. controls.range.label
            description = controls.range.names
        end
        if #settings > 0 then
            categories[#categories + 1] = {id = category.id, name = name, description = description, settings = settings}
        end
    end
    -- Restore defaults, on Settings and on the pages that open from it with settings of their own (Relationships).
    local view = core.view()
    if view == 'settings' or view == 'relationships' then
        -- Two short words, not "Restore defaults" / "Press again to restore": with pending changes the footer holds five buttons (Revert,
        -- Apply, MCM's Add to favorites, this one, Back) and MCM gives each one the same share of the row, cutting the text that is
        -- longer. The footer is only read again when the page is loaded again, which MCM refuses while changes are pending, so the button
        -- cannot be hidden then; the description (hover) carries the full sentence.
        footer[#footer + 1] = action(DEFAULTS_ID, ui.t('Defaults'),
            restoreArmed and ui.t('Confirm') or ui.t('Defaults'),
            ui.t('Puts every setting on Settings and Relationships back to its default. Press the button twice to confirm.'))
    end
    -- The buttons of the page that are not in the list: the letter group, the previous and next page, and the way back (rightmost).
    local footerIds, byId = {}, {}
    for _, item in ipairs(footer) do byId[item.id] = item end
    for _, id in ipairs({'ui:group:next', 'ui:page:previous', 'ui:page:next', DEFAULTS_ID}) do
        if byId[id] then footerIds[#footerIds + 1] = id end
    end
    -- The home page has no way back of its own: MCM's public API cannot close its screen (api.closeMod only closes the provider's
    -- mod, the screen stays), but with no backActionId its own Escape closes the screen, so Escape is Home's Back.
    if currentBack then footerIds[#footerIds + 1] = currentBack.id end
    if #footer > 0 then
        categories[#categories + 1] = {id = 'ui-footer', name = model.name, description = '', settings = footer}
    end
    if api then
        pageSeen = core.pageId()
        pcall(api.ui.setNavigation, MOD_KEY, {pageId = pageSeen, backActionId = currentBack and currentBack.id, escapeBack = true})
        pcall(api.ui.setFooterActions, MOD_KEY, footerIds)
        for id, disabled in pairs(disabledChoices) do
            local states, size = {}, 0
            for index in pairs(disabled) do size = math.max(size, index) end
            for _, category in ipairs(model.categories) do
                for _, row in ipairs(category.settings) do
                    if row.id == id then size = math.max(size, #(row.elements or {})) end
                end
            end
            for index = 1, size do
                states[index] = {enabled = not disabled[index], reason = ui.t('Requires the optional OmniVoice pack (GPU)')}
            end
            pcall(api.ui.setChoiceStates, MOD_KEY, id, states, {wrap = false})
        end
    end
    return {name = model.name, description = model.description, categories = categories}
end

-- ---- What MCM asks of the provider --------------------------------------------------------------------------------------------------

local function hasDrafts()
    local ok, pending = pcall(api.hasDrafts, MOD_KEY)
    return ok and pending == true
end

local function active()
    if not api then return false end
    local ok, context = pcall(api.ui.getContext)
    return ok and type(context) == 'table' and context.open == true and context.modKey == MOD_KEY
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
-- Relationships back to its default in ONE saved transaction, as MCM's own Defaults button did (that button is gone with the defaults).
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
            -- Any other button drops a first press of Restore defaults (the button is drawn again); a status button shows its text
            -- (MCM's description panel) and does nothing.
            local wasArmed = restoreArmed
            restoreArmed = false
            if actionId:sub(1, #STATUS_PREFIX) == STATUS_PREFIX then return {ok = true, schemaChanged = wasArmed} end
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
-- No rowFontSize: MCM applies it by walking the finished list (MCMPanelPresentation.Walk), which left the setting labels smaller than
-- the action labels beside them; without it every row keeps MCM's own size.
local function applyPresentation()
    local called, policy = pcall(api.ui.setApplyPolicy, MOD_KEY, 'explicit')
    local shown, presentation = pcall(api.ui.setPresentation, MOD_KEY, {locale = ui.current(), descriptionFontSize = 22,
        labelWidthFraction = 0.5, statusPlacement = 'header', quietActions = true})
    configured = called and policy == true and shown and presentation == true
    return configured
end

local function connect()
    if api then return true end
    local found = present()
    if not found then return false end
    local why = M.unsupported(found)
    if why then
        logOnce('Companion Manager: Mod Configuration Menu cannot host the page (' .. why .. '); Native Settings UI is used when it is installed.')
        return false
    end
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

local function refusal()
    local player = Game.GetPlayer()
    if not player or not player:IsAttached() or Game.GetSystemRequestsHandler():IsPreGame() then return 'Load a save first.' end
    local boxOk, boxOpen = pcall(function() return player:ConvaiComposerOpen() end)
    if boxOk and boxOpen then return 'Close the text box first.' end
    local defs, boards = Game.GetAllBlackboardDefs(), Game.GetBlackboardSystem()
    local scene = boards:GetLocalInstanced(player:GetEntityID(), defs.PlayerStateMachine)
    if scene:GetInt(defs.PlayerStateMachine.SceneTier) >= 3 and not sittingPlainly() then return 'Finish the scene first.' end
    return nil
end

-- The shortcut. Opens MCM on the manager's page with MCM's own public open call. Returns true, or false and the reason; the third
-- value is true when the reason is the state of the game (nothing else would open the manager either).
function M.open()
    if not api then connect() end
    if not api then return false, 'Mod Configuration Menu 0.10.5 or later is not available.' end
    local checked, why = pcall(refusal)
    if checked and why then return false, why, true end
    if active() then return true end
    core.setView('home')
    local called, request, problem = pcall(api.ui.open, MOD_KEY)
    if not called then request, problem = nil, request end
    if request == nil then
        lastError = 'Open: ' .. tostring(problem)
        log('Companion Manager: Mod Configuration Menu would not open the page: ' .. tostring(problem))
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
            wasActive, reloadWanted, revertWanted, statusSent, keepScroll = false, false, false, nil, nil
            core.setView('home')
        end
        return
    end
    wasActive = true
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
            log('Companion Manager: Mod Configuration Menu would not load the page again: ' .. lastError)
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
    api, opened, wasActive = nil, false, false
end

function M.inspect()
    return {available = api ~= nil, version = version, active = opened, error = lastError ~= '' and lastError or nil,
        reason = lastReason, page = pageSeen, back = currentBack and currentBack.id or nil}
end

-- Tests only.
M._test = {convert = convert, schema = schema, provider = function() return provider end}

return M
