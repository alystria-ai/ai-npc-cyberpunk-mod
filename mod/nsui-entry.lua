-- Open the Companion Manager through the game's own menus: the pause menu, Native Settings UI's "Mods" entry, and this mod's tab. The
-- walk is the same one the player makes: it activates the real pause-menu item (the one NSUI adds beside Settings) and lets NSUI
-- build its screen. This adapter neither simulates keys nor edits another mod's files, preferences, menu or input handlers.
-- It also hands the player back to the game when the manager is closed: closing the Mods screen while this mod's tab is the one shown
-- activates the real Resume item once the Settings screen has detached.
local M = {}

-- options:
--   ns()          the nativeSettings module, or nil while it is not loaded
--   beforeOpen()  called once the walk is allowed to start (the host puts the tab on its first page and makes NSUI start on it)
--   select()      one attempt to select the tab when NSUI opened on another one
--   log(message)
function M.new(options)
    local E = {}
    local stage, deadline, startedAt = 'idle', 0, 0
    local pauseController, settingsController
    local lastProblem, menuItems = '', {}
    local hooksInstalled = false
    local settingsKey, ownSettingsKey, returnToGame
    local selected = false
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
        stage, deadline, pauseController = 'idle', 0, nil
        if reason then lastProblem = reason; log('Manager entry: ' .. reason) end
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
            ownSettingsKey, returnToGame = nil, nil
            settingsController, settingsKey = this, controllerKey(this)
            exitEvents.initialized = exitEvents.initialized + 1
        end)
        Observe('SettingsMainGameController', 'RequestClose', function(this)
            exitEvents.closeRequests = exitEvents.closeRequests + 1
            local key = controllerKey(this)
            if not key or ownSettingsKey ~= key then return end
            -- The tab was the one shown on this very Settings instance. Gameplay validation happens in update, outside this
            -- native callback.
            exitEvents.matchedCloses = exitEvents.matchedCloses + 1
            returnToGame = {controllerKey = key, detached = false, deadline = os.time() + 3}
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
        end)
    end

    -- The host says, every frame the tab is on screen, which Settings instance shows it (nil when it is not shown).
    function E.shown(controller)
        ownSettingsKey = controller and controllerKey(controller) or nil
        if controller and stage == 'settings' then
            -- The tab is up: the walk is done.
            abort()
        end
    end

    -- The shortcut. Returns true when the walk started (or is under way), false and a reason when it cannot start now.
    function E.open()
        if not options.ns() then return false, 'The Companion Manager needs Native Settings UI (Nexus Mods)' end
        if returnToGame then return true end
        if stage ~= 'idle' then return true end
        if settingsController and ownSettingsKey then
            -- The manager is open: the shortcut closes it, the way Esc does.
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
                    pauseController, stage, deadline, startedAt, lastProblem, menuItems = attached, 'pause', os.time() + 8, os.time(), '', {}
                    selected = false
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
            stage, deadline, startedAt, lastProblem, menuItems = 'pause', os.time() + 8, os.time(), '', {}
            selected = false
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
                menuItems = {}
                for index = 0, list:Size() - 1 do
                    local widget = list:GetItemAt(index)
                    local target = widget and widget:GetController()
                    local data = target and target:GetData()
                    menuItems[#menuItems + 1] = {index = index, label = data and tostring(data.label) or '',
                        event = data and name(data.eventName) or ''}
                    -- NSUI's entry is the item labelled "Mods" that opens Settings (the game's own Settings item has the
                    -- localized word). Runtime-created CNames need not have a reverse string entry: compare the native
                    -- name/hash, never its debug text.
                    local settingsEvent = data and (data.eventName == CName.new('OnSwitchToSettings')
                        or data.eventName == 'OnSwitchToSettings')
                    if settingsEvent and tostring(data.label) == 'Mods' then
                        stage, deadline = 'settings', os.time() + 8
                        -- Activate the real entry so NSUI marks the screen as its own (its OnMenuItemActivated observer) and
                        -- builds its tabs in the correct order.
                        pauseController:OnMenuItemActivated(index, target)
                        pauseController = nil
                        return true
                    end
                end
                return false
            end)
            if not ok then abort('Could not activate the Mods entry: ' .. tostring(found)) end
        elseif stage == 'settings' and not selected and os.time() - startedAt >= 2 then
            -- NSUI opened on a tab of its own memory and the manager's is not the one shown: one attempt to select it.
            selected = true
            if options.select then pcall(options.select) end
        end
    end

    function E.state() return stage end
    function E.inspect()
        local counters = {}
        for key, value in pairs(exitEvents) do counters[key] = value end
        return {stage = stage, problem = lastProblem, items = menuItems, capturedPause = pauseController ~= nil,
            shown = ownSettingsKey ~= nil, capturedSettings = settingsController ~= nil, exitEvents = counters,
            returnToGame = returnToGame ~= nil, settingsDetached = returnToGame and returnToGame.detached or false}
    end
    function E.reset()
        settingsController, settingsKey, ownSettingsKey, returnToGame = nil, nil, nil, nil
        abort()
    end
    return E
end

return M
