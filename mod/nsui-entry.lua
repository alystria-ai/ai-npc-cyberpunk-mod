-- Open the Companion Manager through the game's own menus: the pause menu, Native Settings UI's "Mods" entry, and this mod's tab. The
-- walk is the same one the player makes: it activates the real pause-menu item (the one NSUI adds beside Settings) and lets NSUI
-- build its screen. This adapter neither simulates keys nor edits another mod's files, preferences, menu or input handlers.
-- It also hands the player back to the game when the manager is closed: closing the Mods screen while this mod's tab is the one shown
-- activates the real Resume item once the Settings screen has detached.
--
-- Mod Configuration Menu (MCM) installed beside NSUI: by default MCM hides NSUI's pause-menu item (it stays in the list, with its
-- widget hidden) and adds its own item, whose data is labelled "Mods" too but carries the event OnSwitchToMCM; activating NSUI's item
-- would be redirected to MCM's screen. The walk therefore looks at the whole list, and when NSUI's item is hidden it activates MCM's
-- item instead, the way the player would. MCM's public API cannot select a mod in its screen (openMod changes only the API's own
-- active mod, the screen keeps its own selection), and the entry never touches MCM's internals, so the walk ends when MCM's
-- Settings screen has opened and asks the host to tell the player to choose the manager in the list. Closing that screen returns to
-- the game, as the Mods screen does. When MCM's redirect setting is off NSUI's item stays visible and the walk is the plain one.
local M = {}

local EVENT_SETTINGS, EVENT_MCM, EVENT_RESUME = 'OnSwitchToSettings', 'OnSwitchToMCM', 'OnClosePauseMenu'
-- The other frameworks' pause-menu items, which MCM hides and redirects too: never taken for MCM's own item.
local OTHER_FRAMEWORK_EVENTS = {'OnSwitchToModSettings', 'OnSwitchToRCFSettings'}
local MODS_LABEL = 'Mods'
local WALK_SECONDS, EXIT_SECONDS = 8, 3

-- options:
--   ns()          the nativeSettings module, or nil while it is not loaded
--   beforeOpen()  called once the walk is allowed to start (the host puts the tab on its first page and makes NSUI start on it)
--   select()      one attempt to select the tab when NSUI opened on another one
--   notify(kind)  the walk stopped on a screen where the player has to pick the manager by hand: 'mcm-list' (MCM's list of mods)
--   log(message)
function M.new(options)
    local E = {}
    -- idle; pause (waiting for the pause menu); settings (NSUI's item was activated, waiting for the tab); mcm (MCM's item was
    -- activated, waiting for MCM's Settings screen)
    local stage, deadline, startedAt = 'idle', 0, 0
    local pauseController, settingsController
    local lastProblem, menuItems = '', {}
    local hooksInstalled = false
    local settingsKey, ownSettingsKey, returnToGame
    local selected = false
    -- The route of the walk (nsui or mcm), the Settings instance that MCM's screen opened on (the one whose close hands the player
    -- back to the game) and whether it has opened yet, and the last kind of notice asked for.
    local route, mcmKey, mcmOpened, lastNotice
    local exitEvents = {initialized = 0, closeRequests = 0, matchedCloses = 0, uninitialized = 0, matchedDetachments = 0,
        resumes = 0, identityFailures = 0}
    local function log(message) if options.log then options.log(message) end end

    local function controllerKey(controller)
        if not controller then return nil end
        -- CET supplies a fresh WeakReference Lua wrapper to each callback and does not define native-object equality for those
        -- wrappers. CalcSeed is the engine identity. Never fall back to tostring(controller), which identifies a wrapper.
        local ok, value = pcall(CalcSeed, controller)
        if ok and value ~= nil then return tostring(value) end
        exitEvents.identityFailures = exitEvents.identityFailures + 1
        return nil
    end

    local function name(value)
        if type(value) == 'string' then return value end
        local ok, result = pcall(NameToString, value)
        return ok and result and result ~= '' and result or tostring(value)
    end

    local function abort(reason)
        stage, deadline, pauseController, mcmOpened = 'idle', 0, nil, false
        if reason then lastProblem = reason; log('Manager entry: ' .. reason) end
    end

    -- Runtime-created CNames need not have a reverse string entry: compare the native name/hash, never its debug text.
    local function hasEvent(data, event)
        return data ~= nil and (data.eventName == CName.new(event) or data.eventName == event)
    end

    local function hasAnyEvent(data, events)
        for _, event in ipairs(events) do if hasEvent(data, event) then return true end end
        return false
    end

    -- Whether the item's widget is on screen. nil when the game does not say (the item is then neither assumed hidden nor visible).
    local function visibleOf(widget)
        if not widget then return nil end
        local ok, visible = pcall(function() if widget.IsVisible then return widget:IsVisible() end end)
        if ok and type(visible) == 'boolean' then return visible end
        return nil
    end

    -- One pass over the pause menu's list: what the walk can activate. NSUI's item is labelled "Mods" and opens Settings (the game's
    -- own Settings item has the localized word). MCM's item has the event OnSwitchToMCM; if a later MCM renames it, the one visible
    -- item that is still labelled "Mods" and is not NSUI's, Resume or another framework's is taken for it.
    local function scan(list)
        local found = {items = {}}
        for index = 0, list:Size() - 1 do
            local widget = list:GetItemAt(index)
            local target = widget and widget:GetController()
            local data = target and target:GetData()
            local label = data and tostring(data.label) or ''
            local visible = visibleOf(widget)
            found.items[#found.items + 1] = {index = index, label = label, event = data and name(data.eventName) or '', visible = visible}
            if data then
                local candidate = {index = index, target = target, visible = visible}
                if hasEvent(data, EVENT_SETTINGS) then
                    if label == MODS_LABEL and not found.nsui then found.nsui = candidate end
                elseif hasEvent(data, EVENT_MCM) then
                    if not found.mcm then found.mcm = candidate end
                elseif label == MODS_LABEL and visible ~= false and not found.byLabel and not hasEvent(data, EVENT_RESUME)
                    and not hasAnyEvent(data, OTHER_FRAMEWORK_EVENTS) then
                    found.byLabel = candidate
                end
            end
        end
        found.mcm = found.mcm or found.byLabel
        return found
    end

    -- NSUI's item unless MCM is there and has hidden it (or the game does not say): then MCM's own item.
    local function choose(found)
        if found.nsui and (not found.mcm or found.nsui.visible == true) then return 'nsui', found.nsui end
        if found.mcm then return 'mcm', found.mcm end
    end

    local function livePauseController()
        -- A controller observed during OnInitialize can still have no list. Read the attached instance from Ink after the native
        -- host publishes it, rather than assuming a lifecycle callback makes its widgets ready.
        for _, layer in ipairs(Game.GetInkSystem():GetLayers()) do
            for _, controller in ipairs(layer:GetGameControllers()) do
                if controller:IsA('PauseMenuGameController') and controller.menuListController then
                    return controller
                end
            end
        end
    end

    local function inGameMenu()
        local player = Game.GetPlayer()
        if not player or not player:IsAttached() or Game.GetSystemRequestsHandler():IsPreGame() then return nil end
        local defs = Game.GetAllBlackboardDefs()
        return Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu)
    end

    local function updateReturnToGame()
        if not returnToGame then return end
        local ok, err = pcall(function()
            -- A real RequestClose is emitted for the Settings screen; wait for that instance to detach, so the close that is
            -- under way finishes and the pause host is the one left on screen.
            local inMenu = inGameMenu()
            if inMenu ~= true then returnToGame = nil; return end
            if os.time() > returnToGame.deadline then
                returnToGame = nil
                lastProblem = 'Could not find the native Resume action after closing the manager.'
                log('Manager exit: ' .. lastProblem)
                return
            end
            if not returnToGame.detached then return end
            local controller = livePauseController()
            local list = controller and controller.menuListController
            if not list then return end
            for index = 0, list:Size() - 1 do
                local widget = list:GetItemAt(index)
                local target = widget and widget:GetController()
                local data = target and target:GetData()
                if data and (data.eventName == CName.new('OnClosePauseMenu') or data.eventName == 'OnClosePauseMenu') then
                    -- Use the actual Resume item so the native scenario owns unpausing, input contexts and disposal. Consume
                    -- first to prevent reentrant callbacks or later frames resuming twice.
                    returnToGame = nil
                    exitEvents.resumes = exitEvents.resumes + 1
                    controller:OnMenuItemActivated(index, target)
                    return
                end
            end
        end)
        if not ok then
            returnToGame = nil
            lastProblem = 'Could not resume after closing the manager: ' .. tostring(err)
            log('Manager exit: ' .. lastProblem)
        end
    end

    function E.install()
        if hooksInstalled then return end
        hooksInstalled = true
        ObserveAfter('PauseMenuGameController', 'PopulateMenuItemList', function(this)
            if stage == 'pause' then pauseController = this end
        end)
        ObserveAfter('PauseMenuGameController', 'OnInitialize', function(this)
            if stage == 'pause' then pauseController = this end
        end)
        ObserveAfter('SettingsMainGameController', 'OnInitialize', function(this)
            -- A newly opened Settings screen supersedes any old exit. Never carry an auto-resume request into another menu or a
            -- new save.
            ownSettingsKey, returnToGame, mcmKey = nil, nil, nil
            settingsController, settingsKey = this, controllerKey(this)
            exitEvents.initialized = exitEvents.initialized + 1
            if stage == 'mcm' then
                -- The screen that MCM's item opened. Its identity is what a later close is matched against (nil when the game does
                -- not give one: the walk still ends, nothing is resumed).
                mcmKey, mcmOpened = settingsKey, true
            end
        end)
        Observe('SettingsMainGameController', 'RequestClose', function(this)
            exitEvents.closeRequests = exitEvents.closeRequests + 1
            local key = controllerKey(this)
            if not key or (ownSettingsKey ~= key and mcmKey ~= key) then return end
            -- The tab was the one shown on this very Settings instance, or this is the screen that MCM's item opened for the
            -- shortcut. Gameplay validation happens in update, outside this native callback.
            exitEvents.matchedCloses = exitEvents.matchedCloses + 1
            returnToGame = {controllerKey = key, detached = false, deadline = os.time() + EXIT_SECONDS}
        end)
        Observe('SettingsMainGameController', 'OnUninitialize', function(this)
            exitEvents.uninitialized = exitEvents.uninitialized + 1
            local key = controllerKey(this)
            if key and returnToGame and returnToGame.controllerKey == key then
                returnToGame.controllerKey, returnToGame.detached = nil, true
                exitEvents.matchedDetachments = exitEvents.matchedDetachments + 1
            end
            if (key and settingsKey == key) or this == nil then
                settingsController, settingsKey = nil, nil
                abort()
            end
            if (key and ownSettingsKey == key) or this == nil then ownSettingsKey = nil end
            if (key and mcmKey == key) or this == nil then mcmKey = nil end
        end)
    end

    -- The host says, every frame the tab is on screen, which Settings instance shows it (nil when it is not shown).
    function E.shown(controller)
        ownSettingsKey = controller and controllerKey(controller) or nil
        if controller and (stage == 'settings' or stage == 'mcm') then
            -- The tab is up: the walk is done.
            abort()
        end
    end

    -- The shortcut. Returns true when the walk started (or is under way), false and a reason when it cannot start now.
    function E.open()
        if not options.ns() then return false, 'The Companion Manager needs Native Settings UI (Nexus Mods)' end
        if returnToGame then return true end
        if stage ~= 'idle' then return true end
        if settingsController and (ownSettingsKey or mcmKey) then
            -- The manager is open (or MCM's screen that the shortcut opened): the shortcut closes it, the way Esc does.
            local ok = pcall(function() settingsController:RequestClose() end)
            if ok then return true end
        end
        local ok, reason = pcall(function()
            local player = Game.GetPlayer()
            if not player or not player:IsAttached() then return 'Load a save first.' end
            if Game.GetSystemRequestsHandler():IsPreGame() then return 'Load a save first.' end
            local defs, boards = Game.GetAllBlackboardDefs(), Game.GetBlackboardSystem()
            if boards:Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) then
                local attached = livePauseController()
                if attached then
                    if options.beforeOpen then options.beforeOpen() end
                    pauseController, stage, deadline, startedAt, lastProblem, menuItems = attached, 'pause', os.time() + WALK_SECONDS, os.time(), '', {}
                    route, lastNotice, selected = nil, nil, false
                    return nil
                end
                return 'Close the current menu first, or choose Mods from the pause menu.'
            end
            -- A player without the method (this mod's scripts did not compile) has no text box open.
            local boxOk, boxOpen = pcall(function() return player:ConvaiComposerOpen() end)
            if boxOk and boxOpen then return 'Close the text box first.' end
            local scene = boards:GetLocalInstanced(player:GetEntityID(), defs.PlayerStateMachine)
            if scene:GetInt(defs.PlayerStateMachine.SceneTier) >= 3 then return 'Finish the scene first.' end
            if options.beforeOpen then options.beforeOpen() end
            stage, deadline, startedAt, lastProblem, menuItems = 'pause', os.time() + WALK_SECONDS, os.time(), '', {}
            route, lastNotice, selected = nil, nil, false
            boards:Get(defs.MenuEventBlackboard):SetName(defs.MenuEventBlackboard.MenuEventToTrigger, 'OnOpenPauseMenu', true)
            return nil
        end)
        if not ok or reason then abort(); return false, tostring(reason) end
        return true
    end

    -- Called from the per-frame update; with nothing to do it is a comparison.
    function E.update()
        updateReturnToGame()
        if stage == 'idle' then return end
        if os.time() > deadline then
            abort('The shortcut timed out. Choose AI NPC Cyberpunk Mod from the pause menu under Mods.')
            return
        end
        if stage == 'pause' then
            local ok, found = pcall(function()
                if not pauseController or not pauseController.menuListController then
                    pauseController = livePauseController()
                end
                local list = pauseController and pauseController.menuListController
                if not list then return false end
                local seen = scan(list)
                menuItems = seen.items
                local chosen, item = choose(seen)
                if not chosen then return false end
                route, deadline = chosen, os.time() + WALK_SECONDS
                -- Activate the real entry, as the player would: NSUI marks the screen as its own (its OnMenuItemActivated observer)
                -- and builds its tabs in the correct order; MCM prepares its providers and opens its own Settings screen.
                stage = chosen == 'nsui' and 'settings' or 'mcm'
                pauseController:OnMenuItemActivated(item.index, item.target)
                pauseController = nil
                return true
            end)
            if not ok then abort('Could not activate the Mods entry: ' .. tostring(found)) end
        elseif stage == 'settings' and not selected and os.time() - startedAt >= 2 then
            -- NSUI opened on a tab of its own memory and the manager's is not the one shown: one attempt to select it.
            selected = true
            if options.select then pcall(options.select) end
        elseif stage == 'mcm' and mcmOpened then
            -- MCM's Settings screen is up and the entry cannot choose a mod in it (see the header): the walk stops at its list. The
            -- screen stays the one whose close hands the player back to the game (mcmKey).
            abort()
            lastNotice = 'mcm-list'
            log('Manager entry: Mod Configuration Menu is the Mods screen; the manager is chosen in its list.')
            if options.notify then pcall(options.notify, lastNotice) end
        end
    end

    function E.state() return stage end
    function E.inspect()
        local counters = {}
        for key, value in pairs(exitEvents) do counters[key] = value end
        return {stage = stage, route = route, notice = lastNotice, problem = lastProblem, items = menuItems,
            capturedPause = pauseController ~= nil, shown = ownSettingsKey ~= nil, capturedSettings = settingsController ~= nil,
            mcmScreen = mcmKey ~= nil, exitEvents = counters, returnToGame = returnToGame ~= nil,
            settingsDetached = returnToGame and returnToGame.detached or false}
    end
    function E.reset()
        settingsController, settingsKey, ownSettingsKey, returnToGame, mcmKey = nil, nil, nil, nil, nil
        route = nil
        abort()
    end
    return E
end

return M
