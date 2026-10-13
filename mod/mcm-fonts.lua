-- Font ownership for this provider's native MCM presentation. Observers only
-- enqueue their arguments. All native identity/tree/font work runs from update
-- or restoreNow, the latter reserved for top-level CET shutdown.
local M = {}
-- WALK_BUDGET: widgets visited per update (about 4-6 native calls each, so a batch stays near a frame of work).
local MAX_EVENTS, FIND_BUDGET, WALK_BUDGET, MAX_ROWS = 2048, 2048, 160, 2048
local RENDER = 'MCMRenderRoot'

function M.new(options)
    options = options or {}
    local ui = options.ui or (convaiUiLocale or dofile('ui-locale.lua'))
    local library = options.fonts or dofile('ui-fonts.lua')
    local scope = library.new()
    local events, installed, generation, lastError = {}, false, 0, ''
    local state
    local function label() return options.label and options.label() or ui.t('Companion Manager') end
    local function active() return not options.active or options.active() == true end
    local function key(controller)
        if not controller then return nil end
        local ok, value = pcall(CalcSeed, controller)
        return ok and value ~= nil and tostring(value) or nil
    end
    local function find(root, wanted, depth, budget)
        if not root or depth < 0 or budget.left <= 0 then return nil end
        budget.left = budget.left - 1
        if type(wanted) == 'string' then wanted = CName.new(wanted) end
        if root:GetName() == wanted then return root end
        local ok, count = pcall(function() return root:GetNumChildren() end)
        if ok then
            for index = 0, math.min(count, MAX_ROWS) - 1 do
                if budget.left <= 0 then break end
                local found = find(root:GetWidgetByIndex(index), wanted, depth - 1, budget)
                if found then return found end
            end
        end
    end
    local function enqueue(kind, controller, id, value)
        if #events >= MAX_EVENTS then
            -- Fail closed until another complete render begins. Never apply a
            -- half-recorded ownership map to an arbitrary Settings page.
            events = {{kind = 'overflow'}}
            lastError = 'Font event queue exceeded its bound.'
            if kind ~= 'begin' then return end
        end
        events[#events + 1] = {kind = kind, controller = controller, id = id, value = value}
    end
    local function clear()
        scope.clear()
        state = nil
    end
    local function findRender(controller)
        return find(controller:GetRootWidget(), RENDER, 18, {left = FIND_BUDGET})
    end
    -- One pass over the render chrome. The scan stops at each wanted widget, so
    -- the rows and sidebar entries are never walked here.
    local function scanChrome(render)
        local result = {render = render}
        local wanted = {}
        for widgetName, resultName in pairs({content_title = 'title', status = 'status',
            mcm_content_scroll_content = 'content', mcm_sidebar_scroll_content = 'sidebar',
            description_text = 'description'}) do
            wanted[#wanted + 1] = {CName.new(widgetName), resultName}
        end
        local budget = {left = FIND_BUDGET}
        local function scan(widget, depth)
            if not widget or depth < 0 or budget.left <= 0 then return end
            budget.left = budget.left - 1
            -- CET can return an empty NameToString for an unresolved name.
            -- The installed renderer publishes these exact CName identities.
            local identity, target = widget:GetName()
            for _, pair in ipairs(wanted) do
                if identity == pair[1] then target = pair[2]; break end
            end
            if target then
                result[target] = widget
                -- Rows and sidebar entries are handled separately; do not let
                -- a large catalogue hide the later shared description panel.
                return
            end
            local ok, count = pcall(function() return widget:GetNumChildren() end)
            if ok then
                for index = 0, math.min(count, MAX_ROWS) - 1 do
                    if budget.left <= 0 then break end
                    scan(widget:GetWidgetByIndex(index), depth - 1)
                end
            end
        end
        scan(render, 14)
        return result
    end
    local function roots(controller)
        local render = findRender(controller)
        if not render then return nil end
        return scanChrome(render)
    end
    -- A widget the renderer replaced is detached from its parent. Where the
    -- parent cannot be read, treat the widget as stale.
    local function attached(widget)
        if not widget then return false end
        local ok, parent = pcall(function() return widget:GetParentWidget() end)
        return ok and parent ~= nil
    end
    local function ownDescription()
        if not state then return false end
        if state.hover ~= nil then
            return state.sidebarIds[state.hover] == true
                or (state.owned and active() and state.rowIds[state.hover] == true)
        end
        return state.owned and active()
    end
    local function shared(found, code, restoring, budget)
        local owned = not restoring and state.owned and active()
        scope.apply(found.title, owned and code or false)
        scope.apply(found.status, owned and code or false)
        scope.apply(found.description, not restoring and ownDescription() and code or false)
        if found.sidebar then
            for index = 0, math.min(found.sidebar:GetNumChildren(), MAX_ROWS) - 1 do
                local row = found.sidebar:GetWidgetByIndex(index)
                local own = false
                local identity = row:GetName()
                for id in pairs(state.sidebarIds) do
                    if identity == CName.new('mcm_action_' .. id) then own = true; break end
                end
                if own then
                    -- Includes the hidden static, animated and late loop text.
                    -- Its translated label stays ours on another mod's page.
                    scope.walk(row, restoring and false or code, budget)
                end
                if budget.left <= 0 then break end
            end
        end
    end
    local function restoreCurrent()
        if not state or not state.controller then scope.clear(); return true end
        local ok, problem = pcall(function()
            if key(state.controller) ~= state.key then return end
            local found = roots(state.controller)
            if not found then return end
            -- A new render reuses names but not widgets. Restore only the same
            -- render that acquired fonts, never a newly attached foreign tree.
            if state.renderKey and key(found.render) ~= state.renderKey then return end
            scope.begin()
            local budget = {left = 32768}
            shared(found, false, true, budget)
            if found.content then
                -- Apply visits rows in batches rather than asking the generic
                -- walker to exceed its compound-child cap. Restore the same
                -- row range so a large model page does not leave later rows.
                for index = 0, math.min(found.content:GetNumChildren(), MAX_ROWS) - 1 do
                    if budget.left <= 0 then break end
                    scope.walk(found.content:GetWidgetByIndex(index), false, budget)
                end
            end
            scope.finish()
            if budget.left <= 0 then error('Font restoration exceeded its tree bound.') end
        end)
        scope.clear()
        if not ok then lastError = tostring(problem) end
        return ok
    end
    local function begin(controller, identity)
        if state and state.key ~= identity then restoreCurrent() end
        -- McmUiBeginBase detached the previous MCMRenderRoot before this work
        -- reaches top-level update. No old native widget handles are retained.
        scope.clear()
        generation = generation + 1
        state = {controller = controller, key = identity, generation = generation,
            owned = false, sidebarIds = {}, rowIds = {}, hover = nil,
            pending = false, full = false, rescan = true, checkDescription = false,
            code = ui.current(), revision = ui.revision()}
    end
    local function consume()
        local queued = events
        events = {}
        for _, event in ipairs(queued) do
            if event.kind == 'overflow' then restoreCurrent(); clear()
            elseif event.kind == 'refresh' then
                if state then state.pending, state.full = true, true end
            else
                local identity = key(event.controller)
                if identity and event.kind == 'begin' then begin(event.controller, identity)
                elseif state and identity == state.key then
                    -- Use the newest still-resolvable CET weak wrapper.
                    state.controller = event.controller
                    -- A render, a sidebar change, a finished select or a measure
                    -- tick can change any text: those repaint everything. A hover or
                    -- a description update changes only the shared description, so it
                    -- repaints only that (a full pass per hover cost 20-100 ms).
                    if event.kind == 'title' then
                        state.owned = event.id == label() and active()
                        state.pending, state.full, state.rescan = true, true, true
                    elseif event.kind == 'sidebar' then
                        state.sidebarIds[event.id] = true
                        state.pending, state.full, state.rescan = true, true, true
                    elseif event.kind == 'row' then state.rowIds[event.id] = true
                    elseif event.kind == 'hover' then
                        -- MCM restores its base description on every hover-out,
                        -- not only when the previously remembered ID matches.
                        state.hover = event.value and event.id or nil
                        state.pending = true
                    elseif event.kind == 'description' then
                        -- Replacing the rich-text widget does not change the
                        -- hover owner. Begin/hover-out already clear it.
                        state.pending, state.rescan = true, true
                    elseif event.kind == 'describe' then
                        state.pending, state.checkDescription = true, true
                    elseif event.kind == 'dirty' then state.pending, state.full = true, true
                    elseif event.kind == 'detach' then clear() end
                end
            end
        end
    end
    -- Whether the content rows can need a font at all: a language with its own
    -- family, a font already applied (to restore) or, when the caller says so,
    -- a page that shows native language names (an autonym in a Latin locale).
    local function contentNeedsFonts(code)
        if type(options.contentMayNeedFonts) ~= 'function' then return true end
        if library.family(code) or scope.count() > 0 then return true end
        local ok, needed = pcall(options.contentMayNeedFonts)
        return not ok or needed ~= false
    end
    local function paint()
        if not state then return end
        local code, revision = ui.current(), ui.revision()
        if state.code ~= code or state.revision ~= revision then
            state.code, state.revision, state.pending, state.work = code, revision, true, nil
            state.full = true
        end
        if not state.pending and not state.work then return end
        if key(state.controller) ~= state.key then clear(); return end
        -- The render root is searched on every paint: it is the identity check
        -- that stops old ownership from reaching a new screen (near the top of
        -- the tree, so the search is short).
        local render = findRender(state.controller)
        if not render then return end
        local renderKey = key(render)
        if not renderKey then return end
        if state.renderKey and state.renderKey ~= renderKey then
            -- Missing a begin event must not transfer old ownership to a new
            -- screen. A complete observed render will reestablish ownership.
            clear(); return
        end
        state.renderKey = renderKey
        if not state.found or state.rescan
            or (state.checkDescription and state.found.description and not attached(state.found.description)) then
            state.found, state.rescan = scanChrome(render), false
        end
        state.checkDescription = false
        local found = state.found
        if not state.full and not state.work then
            -- Description only: no generation change, so the font records of the rows stay.
            scope.apply(found.description, ownDescription() and code or false)
            state.pending = false
            return
        end
        if not state.work then
            state.work = {index = 0}
            scope.begin()
        end
        local budget = {left = WALK_BUDGET}
        shared(found, code, false, budget)
        local content = found.content
        local count = content and math.min(content:GetNumChildren(), MAX_ROWS) or 0
        if not contentNeedsFonts(code) then count = 0 end
        local contentCode = state.owned and active() and code or false
        while state.work.index < count and budget.left > 0 do
            local child = content:GetWidgetByIndex(state.work.index)
            scope.walk(child, contentCode, budget)
            -- Repeat a partially walked row with a fresh budget next update.
            -- All native MCM controls are smaller than a single batch.
            if budget.left <= 0 then break end
            state.work.index = state.work.index + 1
        end
        if state.work.index >= count then
            scope.finish()
            state.work, state.pending, state.full = nil, false, false
        end
    end

    local S = {}
    function S.install()
        if installed then return end
        installed = true
        Observe('SettingsMainGameController', 'McmUiBegin', function(controller) enqueue('begin', controller) end)
        ObserveAfter('SettingsMainGameController', 'McmUiSetContentTitle', function(controller, title)
            enqueue('title', controller, title)
        end)
        ObserveAfter('SettingsMainGameController', 'McmUiAddSidebarItem', function(controller, id, provider, title)
            if provider == 'CONVAI' and title == label() then enqueue('sidebar', controller, id) end
        end)
        for _, method in ipairs({'McmUiAddBool', 'McmUiBeginSelect', 'McmUiAddActionSetting', 'McmUiAddReadonly'}) do
            ObserveAfter('SettingsMainGameController', method, function(controller, id) enqueue('row', controller, id) end)
        end
        ObserveAfter('SettingsMainGameController', 'McmUiEmitHover', function(controller, id, _, hovered)
            enqueue('hover', controller, id, hovered == true)
        end)
        ObserveAfter('SettingsMainGameController', 'McmUiSetDescription', function(controller) enqueue('description', controller) end)
        ObserveAfter('SettingsMainGameController', 'McmUiUpdateDescription', function(controller) enqueue('describe', controller) end)
        for _, method in ipairs({'McmUiEndSelect', 'McmUiOnSidebarTextMeasureTick'}) do
            ObserveAfter('SettingsMainGameController', method, function(controller) enqueue('dirty', controller) end)
        end
        -- Cycling a draft updates the string-list value in place; it does not
        -- rebuild MCMRenderRoot. The candidate's autonym needs its own font
        -- while the committed interface language is still unchanged.
        ObserveAfter('SettingsSelectorControllerListString', 'McmUiFinishSelect', function() enqueue('refresh') end)
        Observe('SettingsMainGameController', 'OnUninitialize', function(controller) enqueue('detach', controller) end)
    end
    function S.update()
        -- Nothing queued and nothing to repaint: no closure, no native call.
        if #events == 0 and (not state or (not state.pending and not state.work
            and state.code == ui.current() and state.revision == ui.revision())) then return true end
        local ok, problem = pcall(function() consume(); paint() end)
        if not ok then lastError = tostring(problem) end
        return ok
    end
    -- Whether a repaint that can change what the rows look like is queued or under way: the page's veil (mcm.lua) waits for
    -- it, so rows never show the default font and then switch. False when no font is applied or could be (an English page).
    function S.busy()
        if not contentNeedsFonts(ui.current()) then return false end
        return #events > 0 or (state ~= nil and (state.pending or state.work ~= nil))
    end
    -- Whether the page's own language needs a font of its own, or a font is applied that has to be restored: a freshly drawn page
    -- can then not be shown before the font pass has run. False for the Latin languages with nothing applied (no walk, no call).
    function S.applied() return library.family(ui.current()) ~= nil or scope.count() > 0 end
    function S.invalidate() enqueue('refresh') end
    function S.reset()
        -- Called for world teardown: discard ownership without touching a
        -- player/UI object that the engine may already have detached.
        events = {}
        clear()
    end
    function S.restoreNow()
        -- Top-level CET lifecycle only; never call from a native observer.
        local ok = restoreCurrent()
        events = {}
        clear()
        return ok
    end
    function S.inspect()
        return {installed = installed, generation = generation, queued = #events,
            active = state and state.owned or false, pending = state and (state.pending or state.work ~= nil) or false,
            error = lastError}
    end
    return S
end

return M
